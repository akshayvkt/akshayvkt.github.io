// GLSL for the living window (js/live.js). Everything moves by brightness or by layers sliding over the render,
// never by warping the finished picture (from 120 m up, water and sky 2-10 km away only read as moving light).
//
// The view is drawn per picture (the two rendered moments around now, A and B, and while a jump fades, the two
// it is leaving, C and D):  exterior -> its cloud layer (sky only) -> the water's light -> its fog layer,
// then the pictures are mixed. Coordinates are exterior-image uv (the canvas covers the exterior layer).

export const FULL_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// the same, for drawing into a texture: row 0 of a texture is the top of the picture (as uploaded images are)
export const RT_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMMON = `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
vec2 noise2(vec2 p) { return vec2(noise(p), noise(p + vec2(31.7, 11.3))) * 2.0 - 1.0; }
// mask: lossy WebP with noise near 0 and 1, so sky and water are read on/off with a soft edge
vec4 maskOf(vec4 m) { return vec4(smoothstep(0.25, 0.75, m.rg), clamp((m.b - 0.04) / 0.92, 0.0, 1.0), m.a); }
`;

// Baked clouds (no separate cloud layer yet): split the sky into a clear sky and the clouds' detail once per
// picture, so the detail can drift. Output rgb = 0.5 + 2 * (picture - clear sky), a = sky.
export const DETAIL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uE, uMask;
uniform vec3 uSunUv;   // where the sun is (uv) and a radius; its disc and glow stay put
uniform float uAspect;
uniform vec4 uKeep;    // the bridge (towers to deck, anchorage to anchorage): its cables are not clouds
${COMMON}
void main() {
  vec2 uv = vUv;
  // sky well away from anything else (the towers and cables must not drift with the clouds)
  vec2 px = 3.0 / vec2(textureSize(uMask, 0));
  float sky = 1.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++)
    sky = min(sky, smoothstep(0.6, 0.95, texture(uMask, uv + vec2(i, j) * px).r));
  if (sky < 0.01) { o = vec4(0.5, 0.5, 0.5, 0.0); return; }
  // the clear sky here: a trimmed mean along the row (sky taps only); clouds stand out from it
  vec3 c[20]; float w[20];
  vec3 s = vec3(0.0); float ws = 0.0;
  for (int i = 0; i < 20; i++) {
    float x = uv.x + (float(i) - 9.5) / 9.5 * 0.045;
    c[i] = textureLod(uE, vec2(x, uv.y), 2.0).rgb;
    w[i] = smoothstep(0.5, 0.9, textureLod(uMask, vec2(x, uv.y), 1.0).r);
    s += c[i] * w[i]; ws += w[i];
  }
  vec3 mean = s / max(ws, 1e-3);
  float v = 0.0;
  for (int i = 0; i < 20; i++) { vec3 d = c[i] - mean; v += dot(d, d) * w[i]; }
  float sd = sqrt(v / max(ws, 1e-3)) + 0.004;
  vec3 t = vec3(0.0); float wt = 0.0;
  for (int i = 0; i < 20; i++) { float k = w[i] * step(length(c[i] - mean), sd); t += c[i] * k; wt += k; }
  vec3 clear = wt > 0.5 ? t / wt : mean;
  vec3 base = textureLod(uE, uv, 1.0).rgb;       // a touch soft, so stars stay where they are
  vec3 d = base - clear;
  float sun = smoothstep(uSunUv.z, uSunUv.z * 2.5, length((uv - uSunUv.xy) * vec2(uAspect, 1.0)));
  vec2 k = smoothstep(vec2(0.0), vec2(0.012, 0.008), min(uv - uKeep.xy, uKeep.zw - uv));
  d *= sun * smoothstep(0.3, 0.9, ws / 20.0) * (1.0 - k.x * k.y);
  o = vec4(0.5 + 2.0 * clamp(d, -0.24, 0.24), sky);
}`;

export const VIEW_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uA, uB, uC, uD, uMask, uDepth;
uniform sampler2D uCA, uCB, uCC, uCD;    // clouds of each picture
uniform sampler2D uFA, uFB, uFC, uFD;    // fog of each picture
uniform float uMix, uMixPrev, uOut, uTime;
uniform vec2 uTex;            // exterior texture size (px)
uniform vec2 uCanvas;         // canvas size (px)
uniform float uCss;           // canvas px per CSS px
uniform vec4 uMoment;         // night, fog amount, wind 0..1, sun on the water 0..1
uniform vec4 uCam;            // horizon (uv y), eye height (m), focal (image widths), aspect (w / h)
uniform vec4 uSun;            // toward the sun in the camera frame (right, forward, up); w: glitter strength
uniform vec3 uSunCol;
uniform vec4 uWind;           // where the wind blows to (right, forward), speed (m/s), slope variance
uniform vec4 uModeC;          // clouds per picture A B C D: 0 none, 1 layer, 2 baked detail
uniform vec4 uSpanC;          // cloud layer width / exterior width, per picture
uniform vec4 uModeF;          // fog per picture: 0 baked in, 1 layer
uniform vec4 uOffL;           // layer clouds: two copies' x offsets (exterior widths) and their weights
uniform vec2 uRiseL;          // and their y offsets (exterior heights)
uniform vec4 uOffD;           // baked-detail clouds: the same, over a shorter range
uniform vec4 uFogFlow;        // billow speed (exterior widths per s), flow-map period (s), displacement (uv), billow strength
uniform vec2 uGate;           // the Gate (uv): fog pours in through it and spreads out toward us
uniform vec4 uWin;            // the window in exterior uv: x0 y0 x1 y1 (with the parallax margin)
uniform int uBoats;
uniform vec4 uBoatP[16];      // X, Z (m, right and forward of the camera), heading (right, forward)
uniform vec4 uBoatQ[16];      // length, beam, wake length (m), foam strength
uniform vec3 uFoam;           // white water, as bright as white things are in this picture
uniform int uDebug;           // ?debug=clouds shows the cloud detail of picture A

const float TAU = 6.2831853;
${COMMON}

// ---------- clouds ----------
vec4 cloudCopy(sampler2D s, vec2 uv, float span, float off, float dy) {
  float x = (uv.x - 0.5 - off) / span + 0.5, y = uv.y - dy;
  if (x < 0.0 || x > 1.0 || y < 0.0) return vec4(0.0);
  vec4 t = texture(s, vec2(x, y));
  return vec4(t.rgb * t.a, t.a);
}
vec3 withClouds(vec3 e, sampler2D s, float mode, float span, vec2 uv, float sky) {
  if (mode < 0.5 || sky <= 0.0) return e;
  if (mode < 1.5) {
    vec4 c = cloudCopy(s, uv, span, uOffL.x, uRiseL.x) * uOffL.z + cloudCopy(s, uv, span, uOffL.y, uRiseL.y) * uOffL.w;
    return mix(e, c.rgb + e * (1.0 - c.a), sky);
  }
  // baked: take the clouds' detail out where it was and put it back where it has drifted to
  // (clouds drifting in from beyond the picture's edge fade in: there is nothing there to bring)
  vec4 d0 = texture(s, uv);
  float x1 = uv.x - uOffD.x, x2 = uv.x - uOffD.y;
  vec4 d1 = texture(s, vec2(x1, uv.y)), d2 = texture(s, vec2(x2, uv.y));
  float e1 = smoothstep(0.0, 0.05, x1) * smoothstep(1.0, 0.95, x1), e2 = smoothstep(0.0, 0.05, x2) * smoothstep(1.0, 0.95, x2);
  vec3 dd = ((d1.rgb - 0.5) * d1.a * e1 * uOffD.z + (d2.rgb - 0.5) * d2.a * e2 * uOffD.w - (d0.rgb - 0.5) * d0.a) * 0.5;
  return e + dd * sky;
}

// ---------- fog ----------
float billows(vec2 p) {
  return 0.5 * noise(p) + 0.3 * noise(p * 2.1 + 5.3) + 0.2 * noise(p * 4.3 + 1.7);
}
// a fog layer, its edges boiling and its billows drifting through it (premultiplied)
vec4 fogLayer(sampler2D s, vec2 uv, vec2 warp, float b) {
  vec4 f = texture(s, uv + warp);
  float edge = 4.0 * f.a * (1.0 - f.a);
  float a = clamp(f.a * (1.0 + uFogFlow.w * 2.2 * (b - 0.5) * (0.35 + edge)), 0.0, 1.0);
  return vec4(f.rgb * (1.0 + uFogFlow.w * (b - 0.5)) * a, a);
}

// ---------- water ----------
// Wind-ruffled patches (cat's paws), wind streaks, sun glitter and the boats' wakes, as a change of light.
// P: metres on the bay (right, forward), foot: metres per canvas pixel across and in depth.
float octave(vec2 q, vec2 footN) {
  // fade a noise octave out before it would alias (footN: noise units per pixel)
  return 1.0 - smoothstep(0.25, 0.5, max(footN.x, footN.y));
}
vec3 water(vec2 uv, vec3 base, float lavg, vec2 P, vec2 foot, float D) {
  float night = uMoment.x, wind = uMoment.z, sunOn = uMoment.w;
  vec2 to = uWind.xy;                          // where the wind blows (unit, right/forward)
  vec2 side = vec2(to.y, -to.x);
  float U = uWind.z;
  vec3 add = vec3(0.0);
  float glintDbg = 0.0;
  float L = luma(base);

  // cat's paws: patches of rougher water darken (they reflect more of the deep sky) and drift downwind
  vec2 g = vec2(dot(P, side), dot(P, to)) - vec2(0.0, U * 0.9 * uTime);
  float pw = 0.0, wsum = 0.0;
  for (int i = 0; i < 3; i++) {
    float sc = 260.0 * pow(0.5, float(i));
    vec2 fn = abs(vec2(foot.x * abs(side.x) + foot.y * abs(side.y), foot.x * abs(to.x) + foot.y * abs(to.y))) / sc;
    float k = octave(g / sc, fn) * pow(0.62, float(i));
    // each patch also gusts up and dies away over half a minute or so
    pw += k * (noise(g / sc + float(i) * 7.3 + vec2(uTime * 0.021, uTime * 0.034)) - 0.5);
    wsum += k;
  }
  float gust = pw / max(wsum, 0.6) * (0.6 + 0.8 * wind);   // zero on average; octaves too fine to show drop out
  // looking toward a low sun the bay mirrors the bright sky near the horizon, and roughness changes it more
  float toward = clamp(uSun.y, 0.0, 1.0) * smoothstep(0.5, 0.05, uSun.z) * sunOn;
  add += base * gust * -(0.3 + 0.35 * toward);

  // wind streaks: long faint lines along the wind, slowly drifting
  vec2 st = vec2(dot(P, side) / 22.0, dot(P, to) / 700.0 - uTime * U * 0.02 / 700.0);
  float sk = octave(st, vec2(foot.x / 22.0, foot.y / 700.0));
  add += base * (noise(st) - 0.5) * 0.07 * sk * wind;

  // sun glitter (Cox-Munk): how likely a wave facet tilts to send the sun to the eye
  if (uSun.w > 0.001) {
    vec3 v = normalize(vec3(-P.x, -P.y, uCam.y));
    vec3 h = normalize(uSun.xyz + v);
    float t2 = (h.x * h.x + h.y * h.y) / max(h.z * h.z, 1e-4);
    float G = exp(-t2 / uWind.w) * uSun.w;
    glintDbg = G;
    // many facets in a pixel: a shimmer that moves with the waves
    vec2 wv = vec2(dot(P, side) / 9.0, dot(P, to) / 30.0) + vec2(0.0, -uTime * 0.9);
    float wk = octave(wv, vec2(foot.x / 9.0, foot.y / 30.0));
    float sh = mix(0.5, noise(wv) * 0.6 + noise(wv * 2.3 + 4.0) * 0.4, wk);
    add += uSunCol * G * (0.18 + 0.5 * (sh - 0.5)) * sunOn;
    // and single glints, one CSS pixel each, that flare and fade (never a whole field at once)
    vec2 cell = floor(gl_FragCoord.xy / uCss);
    float h1 = hash(cell), h2 = hash(cell + 17.0), h3 = hash(cell + 41.0);
    float on = step(h1, clamp(G * 0.55, 0.0, 0.6));
    float per = 1.4 + 2.6 * h2;
    float pulse = pow(max(0.0, cos(TAU * (uTime / per + h3))), 10.0);
    add += uSunCol * on * pulse * (0.35 + 0.65 * G) * sunOn;
  }
  // glints where the picture is already brighter than the water around it (whitecaps, reflections)
  float inner = min(texture(uMask, uv + vec2(4.0, 0.0) / uCanvas).g, texture(uMask, uv - vec2(4.0, 0.0) / uCanvas).g);
  inner = min(inner, min(texture(uMask, uv + vec2(0.0, 3.0) / uCanvas).g, texture(uMask, uv - vec2(0.0, 3.0) / uCanvas).g));
  float rel = smoothstep(0.015, 0.07, L - lavg) * (1.0 - night) * smoothstep(0.8, 0.98, inner);
  if (rel > 0.0) {
    vec2 cell = floor(gl_FragCoord.xy / uCss);
    float h1 = hash(cell + 3.0), h3 = hash(cell + 9.0);
    float pulse = pow(max(0.0, cos(TAU * (uTime / (1.8 + 2.0 * h1) + h3))), 10.0);
    add += vec3(1.0, 0.97, 0.92) * step(h1, 0.35) * pulse * rel * 0.3 * max(L, 0.25);
  }

  // night: the reflections of lights break into dashes that dance on the swell
  float refl = smoothstep(0.03, 0.16, L - lavg) * night;
  if (refl > 0.0) {
    float dash = noise(vec2(uv.x * uTex.x / 10.0, uv.y * uTex.y / 2.4 + uTime * 1.3)) - 0.5;
    add += base * refl * dash * 1.1;
  }

  // wakes: the white V and the churned track behind each boat
  float foam = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uBoats) break;
    vec4 bp = uBoatP[i], bq = uBoatQ[i];
    vec2 r = P - bp.xy;
    float behind = -dot(r, bp.zw), across = dot(r, vec2(bp.w, -bp.z));
    if (behind < -bq.x * 0.55 || behind > bq.z) continue;
    float bb = max(behind, 0.0);
    // metres per pixel along a line's normal: across the track (n = side of the heading)
    float mx = sqrt(pow(foot.x * bp.w, 2.0) + pow(foot.y * bp.z, 2.0));
    float wt = bq.y * 0.55 + 0.035 * bb;
    float we = sqrt(wt * wt + mx * mx * 0.5);
    float track = exp(-pow(across / we, 2.0)) * (wt / we) * exp(-bb / (bq.z * 0.3)) * step(-bq.x * 0.5, behind);
    // the Kelvin arms at 19.5 degrees either side
    float wa = 2.0 + 0.012 * bb;
    float wae = sqrt(wa * wa + mx * mx * 0.5);
    float arm = exp(-pow((abs(across) - 0.354 * bb) / wae, 2.0)) * (wa / wae) * exp(-bb / (bq.z * 0.45)) * smoothstep(0.0, bq.x * 0.4, bb);
    // the bow wave
    float bow = exp(-pow((behind + bq.x * 0.45) / max(bq.x * 0.08, mx), 2.0)) * exp(-pow(across / (bq.y * 0.9 + mx), 2.0));
    foam += bq.w * (track * 0.75 + arm * 0.45 + bow * 0.5);
  }
  foam = clamp(foam, 0.0, 1.0) * (1.0 - 0.85 * night);
  add += (uFoam - base) * foam * 0.8;
  if (uDebug == 2) add = vec3(foam * 4.0, glintDbg, 0.0) - base;
  return add;
}

void main() {
  vec2 uv = vUv;
  vec4 m = maskOf(texture(uMask, uv));
  float night = uMoment.x, fogAmt = uMoment.y;
  bool inWin = uv.x > uWin.x && uv.x < uWin.z && uv.y > uWin.y && uv.y < uWin.w;

  // ---- each picture with its clouds ----
  vec3 pA = texture(uA, uv, -0.35).rgb, pB = texture(uB, uv, -0.35).rgb;
  pA = withClouds(pA, uCA, uModeC.x, uSpanC.x, uv, m.r);
  pB = withClouds(pB, uCB, uModeC.y, uSpanC.y, uv, m.r);
  vec3 pC = vec3(0.0), pD = vec3(0.0);
  if (uOut > 0.0) {
    pC = withClouds(texture(uC, uv, -0.35).rgb, uCC, uModeC.z, uSpanC.z, uv, m.r);
    pD = withClouds(texture(uD, uv, -0.35).rgb, uCD, uModeC.w, uSpanC.w, uv, m.r);
  }
  vec3 base = mix(pA, pB, uMix);
  if (uOut > 0.0) base = mix(base, mix(pC, pD, uMixPrev), uOut);

  // ---- water: the same change of light on every picture ----
  vec3 add = vec3(0.0);
  if (m.g > 0.0 && uCam.y > 0.0 && inWin) {
    float yw = (uv.y - uCam.x) / uCam.w;
    if (yw > 1e-4) {
      float Z = uCam.z * uCam.y / yw;
      vec2 P = vec2((uv.x - 0.5) * Z / uCam.z, Z);
      vec2 foot = vec2(Z / (uCam.z * uCanvas.x), Z * Z / (uCam.z * uCam.y * uCanvas.x));
      vec3 lv = textureLod(uA, uv, 4.0).rgb;
      lv = mix(lv, textureLod(uB, uv, 4.0).rgb, uMix);
      // under baked fog the water barely shows
      float under = uModeF.x > 0.5 ? 1.0 : 1.0 - clamp(m.b * fogAmt * 1.4, 0.0, 1.0);
      add = water(uv, base, luma(lv), P, foot, Z) * m.g * under;
    }
  }

  // ---- fog ----
  // Fog does not slide as a sheet: it pours in through the Gate and spreads out and toward us. Its billows
  // follow that flow (a flow map: two phases of the billow texture carried along it, taking turns every few
  // seconds, which never shows on noise), and its edges creep out and back, anchored on the Gate.
  vec2 sq = vec2((uv.x - uGate.x) * uCam.w, uv.y - uGate.y);       // screen-square units around the Gate
  vec2 dir = normalize(sq + vec2(0.0, 0.08) + 1e-4);
  vec2 fp = vec2(uv.x * uCam.w, uv.y) * vec2(9.0, 26.0);
  vec2 vel = dir * uFogFlow.x * uCam.w * vec2(9.0, 26.0);           // billow units per second
  float T = uFogFlow.y;
  float ph = fract(uTime / T), ph2 = fract(uTime / T + 0.5);
  float w1 = 1.0 - abs(1.0 - 2.0 * ph), w2 = 1.0 - w1;
  float b1 = billows(fp - vel * ph * T) * 0.65 + billows(fp * 0.47 - vel * 0.47 * ph * T + 13.0) * 0.35;
  float b2 = billows(fp - vel * ph2 * T + 5.7) * 0.65 + billows(fp * 0.47 - vel * 0.47 * ph2 * T + 31.0) * 0.35;
  float b = 0.5 + ((b1 - 0.5) * w1 + (b2 - 0.5) * w2) / sqrt(w1 * w1 + w2 * w2);
  float creep = noise(uv * vec2(2.0, 5.0) + uTime * 0.015) - 0.5;
  vec2 warp = noise2(fp * 0.35 + uTime * 0.05) * uFogFlow.z - vec2(dir.x / uCam.w, dir.y) * creep * uFogFlow.z * 3.0;
  vec3 outA = pA + add, outB = pB + add;
  if (uModeF.x > 0.5) { vec4 f = fogLayer(uFA, uv, warp, b); outA = f.rgb + outA * (1.0 - f.a); }
  if (uModeF.y > 0.5) { vec4 f = fogLayer(uFB, uv, warp, b); outB = f.rgb + outB * (1.0 - f.a); }
  vec3 col = mix(outA, outB, uMix);
  if (uOut > 0.0) {
    vec3 outC = pC + add, outD = pD + add;
    if (uModeF.z > 0.5) { vec4 f = fogLayer(uFC, uv, warp, b); outC = f.rgb + outC * (1.0 - f.a); }
    if (uModeF.w > 0.5) { vec4 f = fogLayer(uFD, uv, warp, b); outD = f.rgb + outD * (1.0 - f.a); }
    col = mix(col, mix(outC, outD, uMixPrev), uOut);
  }
  // fog baked into the picture: thicker and thinner patches drift through it, its edges come and go
  float baked = (uModeF.x > 0.5 && uModeF.y > 0.5) ? 0.0 : m.b * fogAmt;
  if (baked > 0.01 && inWin) {
    vec3 fogCol = mix(textureLod(uA, uv, 5.0).rgb, textureLod(uB, uv, 5.0).rgb, uMix);
    float edge = 4.0 * baked * (1.0 - baked);
    float k = (b - 0.5) * uFogFlow.w * (1.2 + 2.0 * edge);
    col = mix(col, fogCol * (1.0 + 0.35 * (b - 0.5)), clamp(k, -0.6, 0.6) * min(1.0, baked * 2.0));
  }

  // ---- distant lights at night shimmer a little through the air ----
  if (night > 0.25 && inWin) {
    float far = smoothstep(0.6, 0.85, texture(uDepth, uv).r) * (1.0 - m.r) * (1.0 - m.g);
    float lit = smoothstep(0.32, 0.8, luma(col));
    if (far * lit > 0.001) {
      vec2 cell = floor(uv * uTex);
      float tt = uTime * 2.4 + hash(cell) * 9.0;
      float n = mix(hash(cell + floor(tt)), hash(cell + floor(tt) + 1.0), smoothstep(0.0, 1.0, fract(tt)));
      col *= 1.0 + (n - 0.5) * 0.32 * far * lit * night;
    }
  }
  if (uDebug == 1) { vec4 d = texture(uCA, uv); col = vec3(0.5) + (d.rgb - 0.5) * 6.0 * d.a; }
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ---------- lights (cars, beacons, navigation lights) as point sprites ----------
export const PTS_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aColor;
layout(location = 2) in vec4 aShape;   // size px, sigma px, shape, param
out vec4 vColor;
out vec4 vShape;
void main() {
  gl_Position = vec4(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0, 0.0, 1.0);
  gl_PointSize = aShape.x;
  vColor = aColor;
  vShape = aShape;
}`;

export const PTS_FS = `#version 300 es
precision highp float;
in vec4 vColor;
in vec4 vShape;
out vec4 o;
uniform float uTime;
void main() {
  float size = vShape.x, sig = vShape.y, shape = vShape.z, prm = vShape.w;
  vec2 p = (gl_PointCoord - 0.5) * size;      // px from the centre, y down
  vec3 c = vColor.rgb; float a = vColor.a;
  if (shape < 0.5) {                           // a light: tight core, faint glow (added)
    float r2 = dot(p, p);
    float e = exp(-r2 / (2.0 * sig * sig)) + 0.09 * exp(-sqrt(r2) / (2.2 * sig));
    o = vec4(c * a * e, 0.0);
  } else if (shape < 1.5) {                    // its reflection on the water, broken by ripples (added)
    float len = prm;
    float e = exp(-p.x * p.x / (2.0 * sig * sig)) * exp(-p.y * p.y / (2.0 * pow(len * 0.4, 2.0)));
    e *= 0.55 + 0.45 * sin(p.y * 1.9 / max(sig, 0.5) + uTime * 3.1);
    o = vec4(c * a * max(e, 0.0), 0.0);
  } else {                                      // a speck (over)
    float cov = exp(-dot(p, p) / (2.0 * sig * sig)) * a;
    o = vec4(c * cov, cov);
  }
}`;

// ---------- boats: atlas sprites lit for the moment, hidden behind what stands in front ----------
export const BOAT_VS = `#version 300 es
layout(location = 0) in vec4 aPos;    // anchor uv (u, v), canvas px per sprite px, distance (m)
layout(location = 1) in vec4 aCell0;  // atlas cell for the nearer heading: x, y, w, h (px)
layout(location = 2) in vec4 aCell1;  // and the next one
layout(location = 3) in vec4 aMore;   // blend, anchor row (px), opacity, flags (1 reflection, 2 mirrored)
layout(location = 4) in vec4 aWarp;   // each cell's stretch across the line of sight (boats.js); B paint (1) or sail
                                      // cloth (0); the windows' level
layout(location = 5) in vec4 aLivery; // the hull paint (rgb); the floodlights' colour (0 sodium .. 1 LED)
uniform vec2 uCanvas, uAtlas;
uniform float uReflStretch;
out vec2 vT0, vT1;
flat out vec4 vR0, vR1;
out vec4 vInfo;    // blend, opacity, distance, reflection
out vec4 vWarp, vLivery;
out float vRy;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  float k0 = max(aWarp.x, 0.05), k1 = max(aWarp.y, 0.05);
  float hw = aCell0.z * 0.5 * max(k0, k1);
  vec2 sp = vec2(mix(-hw, hw, c.x), c.y * aCell0.w);   // px across from the anchor's column, px down from the cell top
  float refl = mod(aMore.w, 2.0);
  float mir = step(2.0, aMore.w);
  vRy = clamp((aMore.y - sp.y) / max(aMore.y, 1.0), 0.0, 1.0);
  vec2 off = vec2(sp.x, sp.y - aMore.y);
  if (refl > 0.5) off.y = (aMore.y - sp.y) * uReflStretch + 0.5;
  vec2 P = aPos.xy * uCanvas + off * aPos.z;
  gl_Position = vec4(P.x / uCanvas.x * 2.0 - 1.0, 1.0 - P.y / uCanvas.y * 2.0, 0.0, 1.0);
  float sx = mir > 0.5 ? -sp.x : sp.x;
  vT0 = (aCell0.xy + vec2(aCell0.z * 0.5 + sx / k0, sp.y)) / uAtlas;
  vT1 = (aCell1.xy + vec2(aCell1.z * 0.5 + sx / k1, sp.y)) / uAtlas;
  vR0 = vec4(aCell0.xy, aCell0.xy + aCell0.zw) / uAtlas.xyxy;
  vR1 = vec4(aCell1.xy, aCell1.xy + aCell1.zw) / uAtlas.xyxy;
  vInfo = vec4(aMore.x, aMore.z, aPos.w, refl + 2.0 * mir);
  vWarp = aWarp; vLivery = aLivery;
}`;

export const BOAT_FS = `#version 300 es
precision highp float;
in vec2 vT0, vT1;
flat in vec4 vR0, vR1;
in vec4 vInfo, vWarp, vLivery;
in float vRy;
out vec4 o;
uniform sampler2D uAlb, uNrm, uNgt, uMask, uDepth, uFA, uFB;
uniform vec2 uCanvas, uAtlas;
uniform float uMix, uTime;
uniform vec4 uFogMode;         // fog layer for A, B (1) or baked (0); z: fog amount
uniform vec3 uSunCam;          // toward the sun, camera space (x right, y up, z toward us)
uniform vec3 uSunCol, uSkyCol, uLowCol, uAir, uGlow;
uniform float uHaze;           // per metre
uniform float uNight;
uniform float uLiveryBase, uWinK, uFloodK;
${COMMON}
float inRect(vec2 t, vec4 r) { return step(r.x, t.x) * step(t.x, r.z) * step(r.y, t.y) * step(t.y, r.w); }
void main() {
  float blend = vInfo.x, refl = mod(vInfo.w, 2.0), mir = step(2.0, vInfo.w);
  vec2 t0 = vT0, t1 = vT1;
  if (refl > 0.5) { float w = sin(gl_FragCoord.y * 2.1 + uTime * 3.0) * 1.0 / uAtlas.x; t0.x += w; t1.x += w; }
  vec4 a0 = texture(uAlb, t0) * (inRect(t0, vR0) * (1.0 - blend));
  vec4 a1 = texture(uAlb, t1) * (inRect(t1, vR1) * blend);
  vec4 al = a0 + a1;
  if (al.a < 0.004) discard;
  float w0 = a0.a / max(al.a, 1e-4);
  vec4 nm = mix(texture(uNrm, t1), texture(uNrm, t0), w0);    // R, G normal; B paint (ships) or cloth (sails); A glass
  vec2 ng = mix(texture(uNgt, t1).rg, texture(uNgt, t0).rg, w0);   // the lit windows, the floodlights
  vec2 nxy = nm.rg * 2.0 - 1.0;
  vec3 n = vec3(nxy, sqrt(max(0.0, 1.0 - dot(nxy, nxy))));
  if (mir > 0.5) n.x = -n.x;
  float livery = nm.b * vWarp.z, cloth = nm.b * (1.0 - vWarp.z);
  float glass = nm.a * (1.0 - cloth);
  vec3 alb = al.rgb / al.a;
  alb = mix(alb, alb * vLivery.rgb / uLiveryBase, livery);
  vec3 L = normalize(uSunCam);
  float ndl = dot(n, L);
  vec3 light = uSunCol * max(ndl, 0.0) + uSkyCol * (0.55 + 0.45 * n.y) + uLowCol * (0.45 - 0.45 * n.y);
  light += uSunCol * cloth * max(-ndl, 0.0) * 0.55;               // sun through the sail
  vec3 c = alb * light;
  c += glass * uSkyCol * 0.25 * (1.0 - uNight);                   // windows catch the sky
  // the ship's own light: lit windows, and its decks under the floodlights
  vec3 floodCol = mix(vec3(1.0, 0.62, 0.28), vec3(0.93, 0.96, 1.0), vLivery.a);
  vec3 em = uGlow * ng.r * 14.0 * vWarp.w * uWinK + alb * floodCol * ng.g * 4.0 * uFloodK;
  // what stands in front of the boat hides it; fog thins it
  vec2 uv = vec2(gl_FragCoord.x / uCanvas.x, 1.0 - gl_FragCoord.y / uCanvas.y);
  vec4 m = maskOf(texture(uMask, uv));
  float D = 10.0 * pow(6000.0, texture(uDepth, uv).r);
  float occ = (1.0 - m.g) * (1.0 - m.r) * step(D, vInfo.z * 0.9);
  float fog = uFogMode.x > 0.5 ? mix(texture(uFA, uv).a, texture(uFB, uv).a, uMix) : m.b * uFogMode.z;
  float hz = 1.0 - exp(-vInfo.z * uHaze);
  c = mix(c, uAir, hz);
  em *= 1.0 - hz;
  float a = al.a * vInfo.y * (1.0 - occ) * (1.0 - clamp(fog, 0.0, 1.0));
  if (refl > 0.5) {
    // broken into short dashes along thin columns that waver, fading down the water
    float dash = smoothstep(0.35, 0.8, noise(vec2(gl_FragCoord.x * 0.3, gl_FragCoord.y * 0.9 + uTime * 2.3)))
               * (0.35 + 0.65 * noise(vec2(gl_FragCoord.x * 1.1, uTime * 0.4))) * pow(1.0 - vRy, 1.5);
    // (the hull's: darker water under it, broken by the swell and fading down from the waterline)
    float ah = a * 0.24 * m.g * (0.55 + 0.45 * noise(vec2(gl_FragCoord.x * 0.2, gl_FragCoord.y * 0.7 + uTime * 1.7))) * pow(1.0 - vRy, 0.7);
    o = vec4(c * 0.5 * ah + em * a * m.g * 0.4 * dash, ah);
    return;
  }
  o = vec4((c + em) * a, a);
}`;
