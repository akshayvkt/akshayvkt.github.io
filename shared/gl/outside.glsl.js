// GLSL for the outside renderer (stream X1, web/shared/outside.js). WebGL2, GLSL ES 3.00, raw passes of the engine.
//
// The backdrop shader works per window pixel:
//   1. the pixel's view ray from the live camera (sway included), as a direction in the room frame;
//   2. three fixed-point steps against the panorama's soft depth turn it into the desk eye's direction to the same
//      surface (below the horizon the water plane gives the distance exactly);
//   3. the panorama at that direction: tiles at the level the screen density asks for, falling back to coarser
//      levels until a tile arrives; in stage 1 the first-paint exterior images instead (the same pixels);
//   4. the motion track's effects, ported from image space to panorama directions: clouds drifting with a slight rise,
//      fog billowing out from the Gate, water light at its true distance, glitter, broken light dashes at night,
//      distant lights shimmering; and the light layers gated by the city clock.
// Frames: room frame = engine axes (x right, y up, -z out of the window = panorama yaw 0). yaw = atan(x, -z),
// el = asin(y), in degrees. Panorama rows run down from the band's top elevation; row 0 of a texture is its top.
import { GLSL_WINDOWS } from "../city/events/windows.js";
import { SEED } from "../city/hash.js";

export const FULL_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
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
const float DEG = 0.017453292519943295;
`;

// ---------------------------------------------------------------------------------------------- the panorama
// Everything about reading the panorama (tiles, aux, clouds), shared by the backdrop and the sprite shaders.
export const PANO_GLSL = `
precision highp sampler2DArray;
uniform vec4 uPano;            // yaw0, column deg, columns, gutter
uniform vec4 uBand;            // city el0, city top (= sky el0), sky top, aux ppd
uniform vec3 uPpd;             // L0, L1, L2 px/deg
uniform vec4 uSizeL0, uSizeL1, uSizeL2, uSizeX;   // (w, h) pairs: L0c / -, L1c / L1s, L2c / L2s, lights / clouds
uniform sampler2DArray uL0c, uL1c, uL1s, uL2c, uL2s, uLights, uClouds;
uniform sampler2D uMask, uDepth;
uniform vec2 uAuxSize;
uniform float uAuxOn;          // 0 until the aux maps are in: everything is far away
uniform ivec4 uSlotL0[2];      // moment 0's L0 city tile per column (0..6), -1 = not resident
uniform ivec4 uSlotL1c[7];     // [column][moment]
uniform ivec4 uSlotL1s[7];
uniform ivec4 uSlotLt[7];      // light layers
uniform ivec4 uSlotL2c, uSlotL2s, uSlotCl;   // per moment
uniform vec4 uW;               // the moments' weights (sum 1)
uniform float uEyeH;           // the desk eye above the water (m)
uniform vec4 uViewport;        // drawing buffer: 0, 0, w, h (device px)
uniform mat4 uRayM;            // clip (x, y, 1, 1) -> room-frame direction (rotation only; sway included)
uniform vec3 uEye;             // the outside eye minus the panorama (desk) eye, metres
// the two-layer panorama (plan v2 6, S5): a far layer (what lies behind the near roofs; alpha = their coverage in the
// panorama) and the near layer's own depth (aux depth B, grown out past its outline); the near layer's colour is the
// panorama's own pixels. Off (uTwo 0) for a one-layer panorama.
uniform float uTwo;
uniform vec2 uFarEl;           // the far band: el bottom, top
uniform vec2 uFarPpd;          // its L1 and L2 px/deg
uniform vec4 uSizeF;           // F1 (w, h), F2 (w, h)
uniform sampler2DArray uF1, uF2;
uniform ivec4 uSlotF1[7];      // [column][moment]
uniform ivec4 uSlotF2;         // per moment

int slotL0(int c) { ivec4 v = uSlotL0[c >> 2]; int k = c & 3; return k == 0 ? v.x : k == 1 ? v.y : k == 2 ? v.z : v.w; }
int pick(ivec4 v, int m) { return m == 0 ? v.x : m == 1 ? v.y : m == 2 ? v.z : v.w; }

vec2 auxUv(float yaw, float el) {
  float g = uPano.w;
  return vec2(g + (yaw - uPano.x) * uBand.w, g + (uBand.y - el) * uBand.w) / uAuxSize;
}
// R sky, G water, B fog opacity; above the city band it is all sky
vec3 maskAt(float yaw, float el) {
  if (el > uBand.y || uAuxOn < 0.5) return vec3(1.0, 0.0, 0.0);
  vec3 m = textureLod(uMask, auxUv(yaw, el), 0.0).rgb;
  return vec3(smoothstep(0.25, 0.75, m.r), smoothstep(0.25, 0.75, m.g), m.b);
}
float decodeDepth(float q) { return 10.0 * pow(6000.0, q); }
// the distance to use for parallax: the water plane where there is water, else the soft (grown) depth
float parallaxDist(vec3 d, float yaw, float el) {
  if (el > uBand.y || uAuxOn < 0.5) return 60000.0;
  vec2 uv = auxUv(yaw, el);
  float D = decodeDepth(textureLod(uDepth, uv, 0.0).r);
  float w = smoothstep(0.5, 0.9, textureLod(uMask, uv, 0.0).g);
  if (w > 0.0 && d.y < -1e-4) D = mix(D, min(uEyeH / -d.y, 60000.0), w);
  return D;
}
float sharpDist(float yaw, float el) {
  if (el > uBand.y || uAuxOn < 0.5) return 60000.0;
  return decodeDepth(textureLod(uDepth, auxUv(yaw, el), 0.0).g);
}
vec2 yawEl(vec3 d) { return vec2(atan(d.x, -d.z), asin(clamp(d.y, -1.0, 1.0))) / DEG; }

// The desk eye's direction to the surface this ray from eye offset o meets: three fixed-point steps.
vec3 parallax(vec3 o, vec3 v, out float D) {
  vec3 d = v;
  vec2 ye = yawEl(d);
  D = parallaxDist(d, ye.x, ye.y);
  float ov = dot(o, v), oo = dot(o, o);
  for (int k = 0; k < 3; k++) {
    float t = -ov + sqrt(max(ov * ov - oo + D * D, 0.0));
    d = normalize(o + t * v);
    ye = yawEl(d);
    D = parallaxDist(d, ye.x, ye.y);
  }
  return d;
}

// one level of one moment; lv 0 = L0, 1 = L1, 2 = L2 (the sky has no L0); falls back to coarser levels
vec3 levelColour(int m, int lv, int col, float yaw, float el) {
  float g = uPano.w;
  float colYaw = uPano.x + float(col) * uPano.y;
  if (el < uBand.y) {
    float top = uBand.y;
    if (lv <= 0 && m == 0) {
      int s = slotL0(col);
      if (s >= 0) return textureLod(uL0c, vec3(vec2(g + (yaw - colYaw) * uPpd.x, g + (top - el) * uPpd.x) / uSizeL0.xy, float(s)), 0.0).rgb;
    }
    if (lv <= 1) {
      int s = pick(uSlotL1c[col], m);
      if (s >= 0) return textureLod(uL1c, vec3(vec2(g + (yaw - colYaw) * uPpd.y, g + (top - el) * uPpd.y) / uSizeL1.xy, float(s)), 0.0).rgb;
    }
    int s2 = pick(uSlotL2c, m);
    return textureLod(uL2c, vec3(vec2(g + (yaw - uPano.x) * uPpd.z, g + (top - el) * uPpd.z) / uSizeL2.xy, float(max(s2, 0))), 0.0).rgb;
  }
  float top = uBand.z;
  if (lv <= 1) {
    int s = pick(uSlotL1s[col], m);
    if (s >= 0) return textureLod(uL1s, vec3(vec2(g + (yaw - colYaw) * uPpd.y, g + (top - el) * uPpd.y) / uSizeL1.zw, float(s)), 0.0).rgb;
  }
  int s2 = pick(uSlotL2s, m);
  return textureLod(uL2s, vec3(vec2(g + (yaw - uPano.x) * uPpd.z, g + (top - el) * uPpd.z) / uSizeL2.zw, float(max(s2, 0))), 0.0).rgb;
}
vec3 momentColour(int m, float yaw, float el, float lf) {
  int col = clamp(int(floor((yaw - uPano.x) / uPano.y)), 0, int(uPano.z) - 1);
  float lo = floor(lf), fr = lf - lo;
  vec3 c = levelColour(m, int(lo), col, yaw, el);
  if (fr > 0.002 && lo < 2.0) c = mix(c, levelColour(m, int(lo) + 1, col, yaw, el), fr);
  return c;
}
// the panorama blurred to about 4 px/deg (what the motion track read at mip 4 of the exterior)
vec3 blurred(float yaw, float el) {
  vec3 s = vec3(0.0);
  for (int m = 0; m < 4; m++) {
    float w = m == 0 ? uW.x : m == 1 ? uW.y : m == 2 ? uW.z : uW.w;
    if (w <= 0.0) continue;
    vec3 a = levelColour(m, 2, 0, yaw - 0.6, el - 0.3) + levelColour(m, 2, 0, yaw + 0.6, el - 0.3)
           + levelColour(m, 2, 0, yaw - 0.3, el + 0.3) + levelColour(m, 2, 0, yaw + 0.3, el + 0.3);
    s += w * 0.25 * a;
  }
  return s;
}

// ---- the two-layer panorama
// the near layer's depth, -1 where no near layer is within reach
float nearDist(float yaw, float el) {
  if (uTwo < 0.5 || uAuxOn < 0.5 || el > uFarEl.y || el < uBand.x) return -1.0;
  float q = textureLod(uDepth, auxUv(yaw, el), 0.0).b;
  return q > 0.996 ? -1.0 : decodeDepth(q);
}
// the desk eye's direction to the near layer along a ray from eye offset o (three fixed-point steps on its own depth);
// D < 0: no near layer within reach of this ray
vec3 parallaxNear(vec3 o, vec3 v, out float D) {
  vec3 d = v;
  vec2 ye = yawEl(d);
  D = nearDist(ye.x, ye.y);
  if (D < 0.0) return v;
  float ov = dot(o, v), oo = dot(o, o);
  for (int k = 0; k < 3; k++) {
    float t = -ov + sqrt(max(ov * ov - oo + D * D, 0.0));
    d = normalize(o + t * v);
    ye = yawEl(d);
    float Dk = nearDist(ye.x, ye.y);
    if (Dk < 0.0) break;
    D = Dk;
  }
  return d;
}
// the far tiles at a direction (rgb behind the near layer, a its coverage); a = -1 outside the far band
vec4 farTile(int m, float yaw, float el, float lf) {
  if (uTwo < 0.5 || el > uFarEl.y || el < uFarEl.x) return vec4(0.0, 0.0, 0.0, -1.0);
  int col = clamp(int(floor((yaw - uPano.x) / uPano.y)), 0, int(uPano.z) - 1);
  float g = uPano.w, top = uFarEl.y;
  float colYaw = uPano.x + float(col) * uPano.y;
  if (lf < 1.5) {
    int s = pick(uSlotF1[col], m);
    if (s >= 0) return textureLod(uF1, vec3(vec2(g + (yaw - colYaw) * uFarPpd.x, g + (top - el) * uFarPpd.x) / uSizeF.xy, float(s)), 0.0);
  }
  int s2 = pick(uSlotF2, m);
  if (s2 < 0) return vec4(0.0, 0.0, 0.0, -1.0);
  return textureLod(uF2, vec3(vec2(g + (yaw - uPano.x) * uFarPpd.y, g + (top - el) * uFarPpd.y) / uSizeF.zw, float(s2)), 0.0);
}
// the far layer's colour: the far tiles behind the near layer's outline, elsewhere the panorama itself at full
// sharpness (the same pixels there); a = the near layer's coverage at this direction
vec4 farLayer(int m, float yaw, float el, float lf) {
  vec4 F = farTile(m, yaw, el, lf);
  if (F.a < 0.0) return vec4(momentColour(m, yaw, el, lf), 0.0);
  if (F.a >= 0.05) return F;
  return vec4(mix(momentColour(m, yaw, el, lf), F.rgb, F.a / 0.05), F.a);
}
// the near layer's coverage at a direction (geometry: the same in every moment; the dominant moment's tiles)
float nearAlpha(float yaw, float el) {
  vec4 F = farTile(0, yaw, el, 2.0);
  return max(F.a, 0.0);
}
// ---- the rendered near layer (park round 2, layers.near2): the deck, courts and park below the band's top as their
// own render from the panorama eye: a front (uN0 at L0 for the dominant moment; uNB's columns 0-6 at L1, RGBA
// premultiplied, alpha = coverage), a back layer with the trees and shrubs left out (uNB 7-13: what a moved eye sees
// behind them) and both depths (uNB 14-20, RGB8: R,G the front's 16 bits, B the back's 8; q = ln(d/d0) / ln(d1/d0)).
uniform float uNear2;          // 0: no near layer (none in the set, or ?near=0)
uniform vec2 uNearEl;          // the band: el bottom, top
uniform vec2 uNearPpd;         // L0, L1 px/deg
uniform vec4 uSizeN;           // N0 (w, h), NB (w, h)
uniform vec2 uNearDepth;       // d0, d1 (m)
uniform sampler2DArray uN0, uNB;
uniform ivec4 uSlotN0[2];      // the dominant moment's front L0 tile per column
uniform ivec4 uSlotNF[7];      // the front's L1 [column][moment]
uniform ivec4 uSlotNK[7];      // the back layer [column][moment]
uniform ivec4 uSlotND[2];      // the depth tile per column (every moment)
int slotN0(int c) { ivec4 v = uSlotN0[c >> 2]; int k = c & 3; return k == 0 ? v.x : k == 1 ? v.y : k == 2 ? v.z : v.w; }
int slotND(int c) { ivec4 v = uSlotND[c >> 2]; int k = c & 3; return k == 0 ? v.x : k == 1 ? v.y : k == 2 ? v.z : v.w; }
// the near layer's depth (m) at a direction (back: the back layer's); -1 where nothing near is there, outside the
// band, or its tile is not in yet. Packed bits can't be filtered: four texels decoded, then weighed in log depth.
float nearDepth2(float yaw, float el, bool back) {
  if (uNear2 < 0.5 || el > uNearEl.y || el < uNearEl.x) return -1.0;
  int col = clamp(int(floor((yaw - uPano.x) / uPano.y)), 0, int(uPano.z) - 1);
  int s = slotND(col);
  if (s < 0) return -1.0;
  float g = uPano.w, colYaw = uPano.x + float(col) * uPano.y;
  vec2 p = vec2(g + (yaw - colYaw) * uNearPpd.y, g + (uNearEl.y - el) * uNearPpd.y) - 0.5;
  ivec2 i0 = ivec2(floor(p)), hi = ivec2(uSizeN.zw) - 1;
  vec2 f = p - vec2(i0);
  float qs = 0.0, ws = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    vec3 t = texelFetch(uNB, ivec3(clamp(i0 + o, ivec2(0), hi), s), 0).rgb * 255.0;
    float q, none;
    if (back) { float b8 = floor(t.b + 0.5); none = step(254.5, b8); q = (b8 * 256.0 + 128.0) / 65535.0; }
    else { float q16 = floor(t.r + 0.5) * 256.0 + floor(t.g + 0.5); none = step(65534.5, q16); q = q16 / 65535.0; }
    float w = (o.x == 0 ? 1.0 - f.x : f.x) * (o.y == 0 ? 1.0 - f.y : f.y) * (1.0 - none);
    qs += q * w; ws += w;
  }
  if (ws < 0.5) return -1.0;
  return uNearDepth.x * pow(uNearDepth.y / uNearDepth.x, qs / ws);
}
// the panorama eye's direction to the near layer along the ray from eye offset o (fixed-point steps on its depth).
// ok: the steps settled. A ray that grazes a tree from a moved eye flips between the tree's depth and the ground's
// behind it and does not settle: that is the gap the back layer fills (where one layer alone stretches a streak).
vec3 parallaxNear2(vec3 o, vec3 v, bool back, out float D, out bool ok) {
  vec3 d = v;
  vec2 ye = yawEl(d);
  D = nearDepth2(ye.x, ye.y, back);
  ok = D > 0.0;
  if (D < 0.0) return v;
  float ov = dot(o, v), oo = dot(o, o);
  float Dp = D;
  for (int k = 0; k < 4; k++) {
    float t = -ov + sqrt(max(ov * ov - oo + D * D, 0.0));
    d = normalize(o + t * v);
    ye = yawEl(d);
    float Dk = nearDepth2(ye.x, ye.y, back);
    if (Dk < 0.0) { ok = false; break; }    // off the near layer's edge: unsettled
    Dp = D; D = Dk;
  }
  ok = ok && abs(D - Dp) < 0.03 * D;
  return d;
}
// a near-layer tile's colour (premultiplied; alpha = coverage), or a = -1 when the moment's tile is not in
vec4 nearTile(int m, float yaw, float el, float lfN, bool back) {
  int col = clamp(int(floor((yaw - uPano.x) / uPano.y)), 0, int(uPano.z) - 1);
  float g = uPano.w, colYaw = uPano.x + float(col) * uPano.y, top = uNearEl.y;
  if (!back && m == 0 && lfN < 1.0) {
    int s = slotN0(col);
    if (s >= 0) return textureLod(uN0, vec3(vec2(g + (yaw - colYaw) * uNearPpd.x, g + (top - el) * uNearPpd.x) / uSizeN.xy, float(s)), 0.0);
  }
  int s1 = pick(back ? uSlotNK[col] : uSlotNF[col], m);
  if (s1 < 0) return vec4(-1.0);
  return textureLod(uNB, vec3(vec2(g + (yaw - colYaw) * uNearPpd.y, g + (top - el) * uNearPpd.y) / uSizeN.zw, float(s1)), 0.0);
}
bool waterAt(float yaw, float el) { return el < uBand.y && uAuxOn > 0.5 && textureLod(uMask, auxUv(yaw, el), 0.0).g > 0.5; }
// the distance of what the backdrop shows along this pixel's live ray, for hiding the city's sprites behind it
// (water never hides them: a boat sits on it). Large when nothing solid is nearer.
float occluderDist(vec3 v) {
  float Df;
  vec3 dF = parallax(uEye, v, Df);
  vec2 ye = yawEl(dF);
  float d = waterAt(ye.x, ye.y) ? 1e9 : sharpDist(ye.x, ye.y);
  if (uTwo > 0.5) {
    if (nearAlpha(ye.x, ye.y) > 0.5) d = Df;                 // a gap opened behind a near roof: the far scene
    float Dn;
    vec3 dN = parallaxNear(uEye, v, Dn);
    if (Dn > 0.0) { vec2 yn = yawEl(dN); if (nearAlpha(yn.x, yn.y) > 0.5) d = min(d, Dn); }
  }
  return d;
}
vec3 pixelRay() {
  vec2 ndc = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw * 2.0 - 1.0;
  vec4 rp = uRayM * vec4(ndc, 1.0, 1.0);
  return normalize(rp.xyz / rp.w);
}
`;

// ---------------------------------------------------------------------------------------------- backdrop
export const BACKDROP_FS = `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;
${COMMON}
${PANO_GLSL}
uniform sampler2D uRoom;       // the room buffer (alpha = coverage x samples)
uniform float uRoomCount;
uniform float uLevelBias;
uniform float uTime;           // seconds (frozen under reduced motion)
uniform float uCss;            // device px per CSS px
// stage 1: the first-paint exterior images
uniform sampler2D uExtA, uExtB;
uniform float uTileW;          // 0 = first-paint images, 1 = tiles
uniform vec2 uExtMix;          // weights of ext A and ext B (moments 0 and 1)
uniform vec4 uExtCam;          // yaw, pitch (deg), focal (image widths), aspect (w / h)
// clouds: two copies of the layer drifting in turns
uniform vec4 uCloud;           // yaw0, yaw1, el0, el1 of the layer
uniform vec4 uCloudFmt;        // ppd, gutter, wrap (1 mirrored), -
uniform vec4 uCloudOff;        // yaw offset copy 0, copy 1, weight 0, weight 1
uniform vec2 uCloudRise;       // el offset of each copy
// the moment
uniform vec4 uMoment;          // night, fog amount, wind 0..1, sun on the water 0..1
uniform vec4 uSun;             // toward the sun (right, forward, up); w: glitter strength
uniform vec3 uSunCol;
uniform vec4 uWind;            // where the wind blows to (right, forward), speed (m/s), slope variance
uniform vec4 uFogFlow;         // billow speed (deg/s), flow-map period (s), warp (deg), billow strength
uniform vec2 uGate;            // yaw, el of the Gate
uniform int uBoats;
uniform vec4 uBoatP[16];       // X, Z (m, right and forward of the desk eye), heading (right, forward)
uniform vec4 uBoatQ[16];       // length, beam, wake length (m), foam strength
uniform vec4 uBoatR[16];       // bow wave strength, the hull's contact darkening, -, -
uniform vec3 uFoam;
// light layers (dark moments)
uniform vec4 uLtOn;            // windows share scale, lamps on, flood level, gate mix (0 = as baked, 1 = by the clock)
uniform vec4 uLamp;            // lamps: on (s from now), off (s from now), spread (s), fade (s)
uniform vec3 uTintW, uTintL, uTintF;
// windows_extra (v3/city-detail 0130ec5): the night's second window group, extra lit flats, added over the base x a
// dial per moment (by shader slot); its tiles share the light layers' array (uSlotLx) and the near layer's (uSlotNX,
// RGB over black, added over the front). uXOn 0: none of it (every dial at 0), the shader as it was without it.
uniform float uXOn;
uniform vec4 uXDial;
uniform ivec4 uSlotLx[7];
uniform ivec4 uSlotNX[7];
uniform vec3 uTintX;           // the extra's colour per unit of R (pano.json lights.extra.tint)
uniform float uFx;             // the living effects' weight: 0 on the canvas's first frame (identical pixels), easing to 1
uniform int uDebug;
${GLSL_WINDOWS}

const float TAU = 6.2831853;

// ---------- stage 1: the first-paint exterior (rectilinear from the desk eye) ----------
vec3 extColour(sampler2D s, vec3 d, float degPerPx) {
  float ye = uExtCam.x * DEG, pe = uExtCam.y * DEG;
  vec3 fwd = vec3(cos(pe) * sin(ye), sin(pe), -cos(pe) * cos(ye));
  vec3 rgt = vec3(cos(ye), 0.0, sin(ye));
  vec3 up = vec3(-sin(pe) * sin(ye), cos(pe), sin(pe) * cos(ye));
  float df = max(dot(d, fwd), 1e-3);
  vec2 uv = vec2(0.5 + uExtCam.z * dot(d, rgt) / df, 0.5 - uExtCam.z * uExtCam.w * dot(d, up) / df);
  // the level from the screen's density (computed before any early return, so it is defined at the room's edges)
  float lod = log2(max(degPerPx * DEG * uExtCam.z * float(textureSize(s, 0).x), 1e-3)) - 0.35;
  return textureLod(s, uv, max(lod, 0.0)).rgb;
}

// ---------- clouds ----------
vec4 cloudCopy(int slot, float yaw, float el) {
  float t = (yaw - uCloud.x) / (uCloud.y - uCloud.x);
  if (uCloudFmt.z > 0.5) t = 1.0 - abs(mod(t, 2.0) - 1.0);
  else if (t < 0.0 || t > 1.0) return vec4(0.0);
  float fade = smoothstep(uCloud.z, uCloud.z + 1.0, el) * (1.0 - smoothstep(uCloud.w - 3.0, uCloud.w, el));
  vec2 px = vec2(uCloudFmt.y + t * (uCloud.y - uCloud.x) * uCloudFmt.x, uCloudFmt.y + (uCloud.w - el) * uCloudFmt.x);
  vec4 c = textureLod(uClouds, vec3(px / uSizeX.zw, float(slot)), 0.0);
  c.a *= fade;
  return vec4(c.rgb * c.a, c.a);
}

// ---------- fog ----------
float billows(vec2 p) { return 0.5 * noise(p) + 0.3 * noise(p * 2.1 + 5.3) + 0.2 * noise(p * 4.3 + 1.7); }

// ---------- water (shaders.js, in metres on the bay) ----------
float octave(vec2 footN) { return 1.0 - smoothstep(0.25, 0.5, max(footN.x, footN.y)); }
vec3 water(vec3 base, float lavg, vec2 P, vec2 foot, float eyeH, float yaw, float el) {
  float night = uMoment.x, wind = uMoment.z, sunOn = uMoment.w;
  vec2 to = uWind.xy, side = vec2(to.y, -to.x);
  float U = uWind.z;
  vec3 add = vec3(0.0);
  float L = luma(base);
  // cat's paws: rougher patches darken and drift downwind, gusting up and dying away
  vec2 g = vec2(dot(P, side), dot(P, to)) - vec2(0.0, U * 0.9 * uTime);
  float pw = 0.0, wsum = 0.0;
  for (int i = 0; i < 3; i++) {
    float sc = 260.0 * pow(0.5, float(i));
    vec2 fn = abs(vec2(foot.x * abs(side.x) + foot.y * abs(side.y), foot.x * abs(to.x) + foot.y * abs(to.y))) / sc;
    float k = octave(fn) * pow(0.62, float(i));
    pw += k * (noise(g / sc + float(i) * 7.3 + vec2(uTime * 0.021, uTime * 0.034)) - 0.5);
    wsum += k;
  }
  float gust = pw / max(wsum, 0.6) * (0.6 + 0.8 * wind);
  float toward = clamp(uSun.y, 0.0, 1.0) * smoothstep(0.5, 0.05, uSun.z) * sunOn;
  add += base * gust * -(0.3 + 0.35 * toward);
  // wind streaks
  vec2 st = vec2(dot(P, side) / 22.0, dot(P, to) / 700.0 - uTime * U * 0.02 / 700.0);
  add += base * (noise(st) - 0.5) * 0.07 * octave(vec2(foot.x / 22.0, foot.y / 700.0)) * wind;
  // sun glitter (Cox-Munk) and single glints
  if (uSun.w > 0.001) {
    vec3 v = normalize(vec3(-P.x, -P.y, eyeH));
    vec3 h = normalize(uSun.xyz + v);
    float t2 = (h.x * h.x + h.y * h.y) / max(h.z * h.z, 1e-4);
    float G = exp(-t2 / uWind.w) * uSun.w;
    vec2 wv = vec2(dot(P, side) / 9.0, dot(P, to) / 30.0) + vec2(0.0, -uTime * 0.9);
    float sh = mix(0.5, noise(wv) * 0.6 + noise(wv * 2.3 + 4.0) * 0.4, octave(vec2(foot.x / 9.0, foot.y / 30.0)));
    add += uSunCol * G * (0.18 + 0.5 * (sh - 0.5)) * sunOn;
    vec2 cell = floor(gl_FragCoord.xy / uCss);
    float h1 = hash(cell), h2 = hash(cell + 17.0), h3 = hash(cell + 41.0);
    float on = step(h1, clamp(G * 0.55, 0.0, 0.6));
    float pulse = pow(max(0.0, cos(TAU * (uTime / (1.4 + 2.6 * h2) + h3))), 10.0);
    add += uSunCol * on * pulse * (0.35 + 0.65 * G) * sunOn;
  }
  // glints where the water is already brighter than around it
  float inner = min(min(maskAt(yaw + 0.2, el).g, maskAt(yaw - 0.2, el).g), min(maskAt(yaw, el + 0.15).g, maskAt(yaw, el - 0.15).g));
  float rel = smoothstep(0.015, 0.07, L - lavg) * (1.0 - night) * smoothstep(0.8, 0.98, inner);
  if (rel > 0.0) {
    vec2 cell = floor(gl_FragCoord.xy / uCss);
    float h1 = hash(cell + 3.0), h3 = hash(cell + 9.0);
    float pulse = pow(max(0.0, cos(TAU * (uTime / (1.8 + 2.0 * h1) + h3))), 10.0);
    add += vec3(1.0, 0.97, 0.92) * step(h1, 0.35) * pulse * rel * 0.3 * max(L, 0.25);
  }
  // night: reflections of lights break into dashes dancing on the swell
  float refl = smoothstep(0.03, 0.16, L - lavg) * night;
  if (refl > 0.0) {
    float dash = noise(vec2(yaw * 6.3, el * 26.0 + uTime * 1.3)) - 0.5;
    add += base * refl * dash * 1.1;
  }
  // wakes: the white track, the Kelvin arms, the bow wave; and round a hull, the water a little darker (its shade and
  // the calm water pushed along its sides)
  float foam = 0.0, shade = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uBoats) break;
    vec4 bp = uBoatP[i], bq = uBoatQ[i], br = uBoatR[i];
    vec2 r = P - bp.xy;
    float behind = -dot(r, bp.zw), across = dot(r, vec2(bp.w, -bp.z));
    if (behind < -bq.x * 0.62 || behind > bq.z) continue;
    float bb = max(behind, 0.0);
    float mx = sqrt(pow(foot.x * bp.w, 2.0) + pow(foot.y * bp.z, 2.0));
    float wt = bq.y * 0.55 + 0.035 * bb;
    float we = sqrt(wt * wt + mx * mx * 0.5);
    float track = exp(-pow(across / we, 2.0)) * (wt / we) * exp(-bb / (bq.z * 0.3)) * step(-bq.x * 0.5, behind);
    float wa = 2.0 + 0.012 * bb;
    float wae = sqrt(wa * wa + mx * mx * 0.5);
    float arm = exp(-pow((abs(across) - 0.354 * bb) / wae, 2.0)) * (wa / wae) * exp(-bb / (bq.z * 0.45)) * smoothstep(0.0, bq.x * 0.4, bb);
    // the bow wave: a white crest at the stem, curling out along both sides of the bow
    float bw = max(bq.x * 0.05, mx);
    float crest = exp(-pow((behind + bq.x * 0.47) / bw, 2.0)) * exp(-pow(across / (bq.y * 0.7 + mx), 2.0));
    float alongBow = smoothstep(-bq.x * 0.52, -bq.x * 0.46, behind) * (1.0 - smoothstep(-bq.x * 0.4, -bq.x * 0.25, behind));
    float bowSide = exp(-pow((abs(across) - bq.y * 0.55) / (bq.y * 0.18 + mx), 2.0)) * alongBow;
    float bow = crest + 0.6 * bowSide;
    foam += bq.w * (track * 0.75 + arm * 0.45) + br.x * bow;
    // the contact darkening: distance outside the hull's waterline rectangle
    vec2 dOut = max(vec2(abs(behind) - bq.x * 0.5, abs(across) - bq.y * 0.5), 0.0);
    shade = max(shade, br.y * exp(-pow(length(dOut) / (bq.y * 0.45 + mx), 2.0)));
  }
  foam = clamp(foam, 0.0, 1.0) * (1.0 - 0.85 * night);
  add += (uFoam - base) * foam * 0.8;
  add -= base * shade * (1.0 - 0.7 * night);
  return add;
}

// ---------- light layers, gated by the city clock ----------
float lampLevel(uint j) {
  float u = (cityU01(${SEED.lamp}u, j, 1u, 0u) * 2.0 - 1.0) * uLamp.z;
  float a = uLamp.x + u, b = uLamp.y + u;
  return min(smoothstep(a, a + uLamp.w, 0.0), 1.0 - smoothstep(b, b + uLamp.w, 0.0));
}
float xDial(int m) { return m == 0 ? uXDial.x : m == 1 ? uXDial.y : m == 2 ? uXDial.z : uXDial.w; }
// xAdd: windows_extra's part of what is returned (0 while uXOn is 0): its brightness x the dial, gated by the city
// clock's window cells as the base windows are (gw) and eased in with the gate (uLtOn.w: the first-paint photograph has
// none of it), coloured by its own tint with the same TV blue
vec3 lightsAdd(int m, float yaw, float el, out vec3 asBaked, out vec3 xAdd) {
  asBaked = vec3(0.0);
  xAdd = vec3(0.0);
  if (el > uBand.y) return vec3(0.0);
  int col = clamp(int(floor((yaw - uPano.x) / uPano.y)), 0, int(uPano.z) - 1);
  int s = pick(uSlotLt[col], m);
  if (s < 0) return vec3(0.0);
  float g = uPano.w, ppd = (uSizeX.x - 2.0 * g) / uPano.y;
  float colYaw = uPano.x + float(col) * uPano.y;
  vec3 L = textureLod(uLights, vec3(vec2(g + (yaw - colYaw) * ppd, g + (uBand.y - el) * ppd) / uSizeX.xy, float(s)), 0.0).rgb;
  float X = 0.0;
  if (uXOn > 0.5) {
    int sx = pick(uSlotLx[col], m);
    if (sx >= 0) X = textureLod(uLights, vec3(vec2(g + (yaw - colYaw) * ppd, g + (uBand.y - el) * ppd) / uSizeX.xy, float(sx)), 0.0).r * xDial(m);
  }
  if (L.r + L.g + L.b < 0.002 && X <= 0.0) return vec3(0.0);
  uint cell = uint(floor((uBand.y - el) * 28.0)) * 65536u + uint(floor((yaw - uPano.x) * 28.0));
  float tv;
  float w = cityWindow(cell, tv);
  float gw = mix(1.0, w, uLtOn.w), gl = mix(1.0, lampLevel(cell), uLtOn.w), gf = mix(1.0, uLtOn.z, uLtOn.w);
  vec3 tintW = mix(uTintW, vec3(0.55, 0.72, 1.0) * 1.1, tv * uLtOn.w);
  asBaked = L.r * uTintW + L.g * uTintL + L.b * uTintF;
  vec3 r = L.r * gw * tintW + L.g * gl * uTintL + L.b * gf * uTintF;
  if (X > 0.0) {
    xAdd = X * uLtOn.w * gw * mix(uTintX, vec3(0.55, 0.72, 1.0) * 1.1, tv * uLtOn.w);
    r += xAdd;
  }
  return r;
}
// windows_extra over the near layer's front: its RGB (over black, display units) at a direction; 0 where its tile is
// not in
vec3 nearX(int m, float yaw, float el) {
  int col = clamp(int(floor((yaw - uPano.x) / uPano.y)), 0, int(uPano.z) - 1);
  int s = pick(uSlotNX[col], m);
  if (s < 0) return vec3(0.0);
  float g = uPano.w, colYaw = uPano.x + float(col) * uPano.y;
  return textureLod(uNB, vec3(vec2(g + (yaw - colYaw) * uNearPpd.y, g + (uNearEl.y - el) * uNearPpd.y) / uSizeN.zw, float(s)), 0.0).rgb;
}

void main() {
  vec3 v = pixelRay();
  // the screen density from the plain ray (smooth), before parallax bends anything
  vec2 ye0 = yawEl(v);
  vec2 dx = dFdx(ye0), dy = dFdy(ye0);
  float degPerPx = max(length(dx), length(dy));
  float lf = clamp(log2(max(uPpd.x * degPerPx, 1e-3)) + uLevelBias, 0.0, 2.0);
  // where the live ray meets the water, and how much water one pixel spans (derivatives before any early return)
  vec3 o = uEye;
  float tw = v.y < -1e-4 ? (-uEyeH - o.y) / v.y : 1e6;
  vec3 hitW = o + tw * v;
  vec2 P = vec2(hitW.x, -hitW.z);
  vec2 foot = vec2(max(abs(dFdx(P.x)), abs(dFdy(P.x))), max(abs(dFdx(P.y)), abs(dFdy(P.y))));
  // the room covers this pixel entirely: nothing outside shows (before the parallax searches, which cost the most)
  float cover = texelFetch(uRoom, ivec2(gl_FragCoord.xy), 0).a / max(uRoomCount, 1.0);
  if (cover >= 0.999 && uDebug != 2) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  // the far scene (one-layer: everything) and, in a two-layer panorama, the near layer, each by its own depth
  float D;
  vec3 d = parallax(uEye, v, D);
  vec2 ye = yawEl(d);
  float yaw = ye.x, el = ye.y;
  float Dn = -1.0;
  vec3 dN = uTwo > 0.5 ? parallaxNear(uEye, v, Dn) : v;
  vec2 yeN = yawEl(dN);
  float nearA = Dn > 0.0 ? nearAlpha(yeN.x, yeN.y) : 0.0;     // the near layer's coverage of this pixel
  // the rendered near layer (park round 2): its front by its own depth; where those steps don't settle (the gap a
  // moved eye sees beside a tree) its back layer by the back depth
  float Dn2 = -1.0, Db2 = -1.0;
  bool okF = false, okB = false;
  vec3 dF2 = v, dB2 = v;
  if (uNear2 > 0.5 && ye0.y < uNearEl.y + 2.0) {
    dF2 = parallaxNear2(uEye, v, false, Dn2, okF);
    if (Dn2 > 0.0 && !okF) dB2 = parallaxNear2(uEye, v, true, Db2, okB);
  }
  bool useBack = Dn2 > 0.0 && !okF && Db2 > 0.0;
  vec2 yeF2 = yawEl(dF2), yeB2 = yawEl(dB2);
  float lfN = clamp(log2(max(uNearPpd.x * degPerPx, 1e-3)) + uLevelBias, 0.0, 2.0);
  if (uDebug == 2) {
    // smear / tear measure for S5: per screen axis, how many degrees of panorama one pixel spans against the plain ray
    // (1 = no stretch); a smear is a run of pixels well under 1 (one panorama pixel stretched over several), a tear
    // well over 1. Two layers: the layer that shows at this pixel.
    // (each layer's own field is differentiated, then the one that shows is picked: the outline between them is an
    // edge drawn with coverage, not a stretch of either)
    vec2 sF = vec2(length(dFdx(ye)), length(dFdy(ye))), sN = vec2(length(dFdx(yeN)), length(dFdy(yeN)));
    vec2 sF2 = vec2(length(dFdx(yeF2)), length(dFdy(yeF2))), sB2 = vec2(length(dFdx(yeB2)), length(dFdy(yeB2)));
    vec2 sd = Dn2 > 0.0 ? (useBack ? sB2 : sF2) : nearA > 0.5 ? sN : sF;
    float rx = sd.x / max(length(dx), 1e-7), ry = sd.y / max(length(dy), 1e-7);
    outColor = vec4(clamp(rx * 0.25, 0.0, 1.0), clamp(ry * 0.25, 0.0, 1.0), cover, 1.0);
    return;
  }
  vec3 mk = maskAt(yaw, el);
  float night = uMoment.x, fogAmt = uMoment.y;

  // ---- the panorama: each moment with its clouds; two layers: the near layer over the far one ----
  vec3 tiles = vec3(0.0);
  float near2A = 0.0;            // the rendered near layer's coverage (its lights are in its render)
  vec3 xNear = vec3(0.0);        // windows_extra over the near layer (debug 7)
  if (uTileW > 0.0) {
    for (int m = 0; m < 4; m++) {
      float w = m == 0 ? uW.x : m == 1 ? uW.y : m == 2 ? uW.z : uW.w;
      if (w <= 0.0) continue;
      vec4 fF = farLayer(m, yaw, el, lf);
      vec3 cf = fF.rgb;
      int cs = pick(uSlotCl, m);
      if (cs >= 0 && mk.r > 0.0) {
        vec4 cl = cloudCopy(cs, yaw - uCloudOff.x, el - uCloudRise.x) * uCloudOff.z + cloudCopy(cs, yaw - uCloudOff.y, el - uCloudRise.y) * uCloudOff.w;
        cf = mix(cf, cl.rgb + cf * (1.0 - cl.a), mk.r);
      }
      vec3 c = cf;
      if (Dn > 0.0) {
        vec4 fN = farLayer(m, yeN.x, yeN.y, lf);
        // the near layer is the panorama's own pixels less what lies behind them: main + (1 - a) (far there - far here).
        // At rest the two directions are one, so this is the panorama exactly.
        if (fN.a > 0.002) c = momentColour(m, yeN.x, yeN.y, lf) + (1.0 - fN.a) * (cf - fN.rgb);
      }
      if (Dn2 > 0.0) {
        // the rendered near layer over all of it (premultiplied); a moment whose tile is not in keeps the panorama's
        vec4 n2 = useBack ? nearTile(m, yeB2.x, yeB2.y, lfN, true) : nearTile(m, yeF2.x, yeF2.y, lfN, false);
        if (n2.a >= 0.0) { c = n2.rgb + (1.0 - n2.a) * c; near2A += w * n2.a; }
        // windows_extra: added over the front (none over the back layer: the front's windows), x its dial, eased in
        // with the light layers' gate
        if (uXOn > 0.5 && !useBack && n2.a >= 0.0) {
          float xd = xDial(m);
          if (xd > 0.0) { vec3 nx = nearX(m, yeF2.x, yeF2.y) * (xd * uLtOn.w); c += nx; xNear += w * nx; }
        }
      }
      tiles += w * c;
    }
  }
  vec3 ext = vec3(0.0);
  if (uTileW < 1.0) {
    ext = extColour(uExtA, d, degPerPx) * uExtMix.x;
    if (uExtMix.y > 0.0) ext += extColour(uExtB, d, degPerPx) * uExtMix.y;
  }
  // light layers: the tiles' base is all off; the first-paint images have the layers' lights baked in
  vec3 lit = vec3(0.0), asBaked = vec3(0.0), litX = vec3(0.0);
  if (night > 0.02) {
    // the light passes carry render noise over open sky (the lamps' light scattered in the haze, at 64 samples:
    // fireflies and faint blotches that read as bright specks over the window); lights are on land and water, so
    // nothing of them is added where the panorama is all sky. Its skyline's lamps (part sky at 20 ppd) stay.
    float skyRaw = (el > uBand.y || uAuxOn < 0.5) ? 1.0 : textureLod(uMask, auxUv(yaw, el), 0.0).r;
    float ltKeep = 1.0 - smoothstep(0.8, 0.98, skyRaw);
    for (int m = 0; m < 4; m++) {
      float w = m == 0 ? uW.x : m == 1 ? uW.y : m == 2 ? uW.z : uW.w;
      if (w <= 0.0) continue;
      vec3 ab, abN, xa, xaN;
      vec3 L = lightsAdd(m, yaw, el, ab, xa) * ltKeep;
      ab *= ltKeep;
      if (nearA > 0.0) { L = mix(L, lightsAdd(m, yeN.x, yeN.y, abN, xaN), nearA); ab = mix(ab, abN, nearA); }
      lit += w * L;
      asBaked += w * ab;
      if (uXOn > 0.5) litX += w * (nearA > 0.0 ? mix(xa * ltKeep, xaN, nearA) : xa * ltKeep);
    }
    lit *= 1.0 - near2A; asBaked *= 1.0 - near2A;
  }
  vec3 base = mix(ext + (lit - asBaked), tiles + lit, uTileW);
  float farW = (1.0 - nearA) * (1.0 - near2A);   // the effects below belong to the far scene (water, fog), not to a near roof over it

  // ---- water: the same change of light whatever the source ----
  vec3 add = vec3(0.0);
  if (mk.g > 0.0 && v.y < -1e-4 && uAuxOn > 0.5) {
    vec3 lv = blurred(yaw, el);
    float under = 1.0 - clamp(mk.b * fogAmt * 1.4, 0.0, 1.0);
    add = water(base, luma(lv), P, foot, uEyeH + o.y, yaw, el) * mk.g * under * uFx * farW;
  }

  // ---- fog: pours in through the Gate and spreads out toward us; its billows follow that flow ----
  vec3 col = base + add;
  float bk = mk.b * fogAmt * farW;
  if (bk > 0.01) {
    vec2 sq = vec2(yaw - uGate.x, el - uGate.y);
    vec2 dir = normalize(sq + vec2(0.0, 1.5) + 1e-4);
    vec2 fp = vec2(yaw * 0.243, el * 0.64);
    vec2 vel = dir * uFogFlow.x * vec2(0.243, 0.64);
    float T = uFogFlow.y;
    float ph = fract(uTime / T), ph2 = fract(uTime / T + 0.5);
    float w1 = 1.0 - abs(1.0 - 2.0 * ph), w2 = 1.0 - w1;
    vec2 warp = noise2(fp * 0.35 + uTime * 0.05) * uFogFlow.z;
    float creep = noise(vec2(yaw * 0.03, el * 0.12) + uTime * 0.015) - 0.5;
    vec2 q = fp + warp * vec2(0.243, 0.64) - dir * creep * uFogFlow.z * 3.0 * vec2(0.243, 0.64);
    float b1 = billows(q - vel * ph * T) * 0.65 + billows(q * 0.47 - vel * 0.47 * ph * T + 13.0) * 0.35;
    float b2 = billows(q - vel * ph2 * T + 5.7) * 0.65 + billows(q * 0.47 - vel * 0.47 * ph2 * T + 31.0) * 0.35;
    float b = 0.5 + ((b1 - 0.5) * w1 + (b2 - 0.5) * w2) / sqrt(w1 * w1 + w2 * w2);
    vec3 fogCol = blurred(yaw, el);
    float edge = 4.0 * bk * (1.0 - bk);
    float k = (b - 0.5) * uFogFlow.w * (1.2 + 2.0 * edge) * uFx;
    col = mix(col, fogCol * (1.0 + 0.35 * (b - 0.5)), clamp(k, -0.6, 0.6) * min(1.0, bk * 2.0));
  }

  // ---- distant lights at night shimmer a little through the air ----
  if (night > 0.25 && uFx > 0.0) {
    float far = smoothstep(1500.0, 9000.0, sharpDist(yaw, el)) * (1.0 - mk.r) * (1.0 - mk.g) * farW;
    float lt = smoothstep(0.32, 0.8, luma(col));
    if (far * lt > 0.001) {
      vec2 cell = floor(vec2(yaw, el) * 64.0);
      float tt = uTime * 2.4 + hash(cell) * 9.0;
      float n = mix(hash(cell + floor(tt)), hash(cell + floor(tt) + 1.0), smoothstep(0.0, 1.0, fract(tt)));
      col *= 1.0 + (n - 0.5) * 0.32 * far * lt * night * uFx;
    }
  }
  if (uDebug == 1) col = mix(col, lf < 0.5 ? vec3(1, 0, 0) : lf < 1.5 ? vec3(0, 1, 0) : vec3(0, 0, 1), 0.35);
  if (uDebug == 3) col = vec3(log((Dn2 > 0.0 && near2A > 0.5 ? (useBack ? Db2 : Dn2) : nearA > 0.5 ? Dn : D) / 10.0) / log(6000.0));
  if (uDebug == 6) col = mix(col, useBack ? vec3(1.0, 0.2, 0.8) : vec3(0.2, 1.0, 0.4), near2A * 0.5);   // the near layer: front green, back magenta
  if (uDebug == 5) col = mix(col, vec3(1.0, 0.2, 0.6), nearA * 0.5);
  if (uDebug == 4) col = mix(col, vec3(uTileW, 0.0, 1.0 - uTileW), 0.3);
  if (uDebug == 7) col = litX * (1.0 - near2A) * uTileW + xNear * uTileW;   // windows_extra alone (black where it adds nothing)
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ---------------------------------------------------------------------------------------------- sprites
// Points (traffic, beacons, windows, lamps, aircraft lights), sky dots (aircraft, distant birds) and gulls, as point
// sprites placed on the CPU through the live camera. Hidden behind nearer things by the sharp depth channel; faded by
// the fog layer's opacity there. Drawn premultiplied over the backdrop; the room is composited over all of it.
export const POINTS_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aPos;     // device px x, y (GL origin), size px, eye distance from the desk eye (m)
layout(location = 1) in vec4 aColor;   // rgb, intensity / alpha
layout(location = 2) in vec4 aShape;   // sigma px, shape (0 light, 1 streak, 2 speck, 3 gull), param, flap
layout(location = 3) in vec3 aDir;     // the desk eye's direction to it (room frame)
uniform vec2 uSize;
out vec4 vColor;
out vec4 vShape;
out vec3 vDir;
out float vDist;
void main() {
  gl_Position = vec4(aPos.xy / uSize * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = aPos.z;
  vColor = aColor; vShape = aShape; vDir = aDir; vDist = aPos.w;
}`;

export const POINTS_FS = `#version 300 es
precision highp float;
precision highp int;
in vec4 vColor;
in vec4 vShape;
in vec3 vDir;
in float vDist;
out vec4 o;
${COMMON}
${PANO_GLSL}
uniform float uTime;
uniform float uFog;
uniform float uFx;
void main() {
  float sig = vShape.x, shape = vShape.y, prm = vShape.z;
  vec2 p = (gl_PointCoord - 0.5) * vec2(1.0, -1.0);
  vec3 c = vColor.rgb; float a = vColor.a;
  vec2 ye = yawEl(normalize(vDir));
  // what the backdrop shows in front of it along this pixel's ray hides it; fog thins it
  float occ = occluderDist(pixelRay()) < vDist * 0.97 ? 1.0 : 0.0;
  float fog = maskAt(ye.x, ye.y).b * uFog;
  float vis = (1.0 - occ) * (1.0 - clamp(fog, 0.0, 1.0));
  if (vis <= 0.0) discard;
  vec4 outc;
  if (shape < 0.5) {                     // a light: tight core, faint glow (added)
    vec2 q = p * vShape.w;               // vShape.w: the sprite's size in px
    float r2 = dot(q, q);
    float e = exp(-r2 / (2.0 * sig * sig)) + 0.09 * exp(-sqrt(r2) / (2.2 * sig));
    outc = vec4(c * a * e, 0.0);
  } else if (shape < 1.5) {              // its reflection on the water, broken by ripples (added)
    vec2 q = p * vShape.w;
    float len = prm;
    float e = exp(-q.x * q.x / (2.0 * sig * sig)) * exp(-q.y * q.y / (2.0 * pow(len * 0.4, 2.0)));
    e *= 0.55 + 0.45 * sin(q.y * 1.9 / max(sig, 0.5) + uTime * 3.1);
    outc = vec4(c * a * max(e, 0.0), 0.0);
  } else if (shape < 2.5) {              // a speck or a sky dot (over)
    vec2 q = p * vShape.w;
    float cov = exp(-dot(q, q) / (2.0 * sig * sig)) * a;
    outc = vec4(c * cov, cov);
  } else {                               // a gull: a shallow V of wings, flapping (over)
    vec2 q = p * vShape.w / max(prm, 1.0);   // prm: wingspan in px; q in wingspans
    float wing = sig;                    // sig carries the wing angle (-1 down .. 1 up)
    float y = abs(q.x) * (0.25 + 0.55 * wing) - q.y;
    float th = max(0.07, 0.9 / max(prm, 1.0));
    float body = exp(-pow(y / th, 2.0)) * smoothstep(0.5, 0.42, abs(q.x));
    float cov = clamp(body, 0.0, 1.0) * min(a, 1.0);
    outc = vec4(c * cov, cov);
  }
  o = outc * vis * uFx;
}`;

// Hull sprites from the Blender-lit atlas (scripts/ships: each big ship's model at 13 headings, mirrored for the other
// side; the ferry and the sailboat at 24), with the moment's light (X2's per-moment hints), the ship's own paint and
// its own lights at night, haze toward the panorama behind them, hidden by the sharp depth channel and faded by fog.
// The atlas (scripts/ships/ship_atlas.py): albedo (premultiplied, alpha = coverage); normal (R, G the normal; B the
// paint each ship's colour tints, or on the sailboat the cloth lit through from behind; A window glass); night (R the
// lit windows, G the floodlights' irradiance on white). Every channel is a weight, so mipmaps mix them right.
export const HULL_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 aPos;    // anchor device px x, y (GL origin), device px per atlas px, distance (m)
layout(location = 1) in vec4 aCell0;  // atlas cell for the nearer heading: x, y, w, h (px)
layout(location = 2) in vec4 aCell1;  // and the next one
layout(location = 3) in vec4 aMore;   // blend, anchor row (px), opacity, flags (1 reflection, 2 mirrored)
layout(location = 4) in vec4 aLook;   // sun on the face, silhouette, rim, haze mix
layout(location = 5) in vec4 aSun;    // toward the sun in the sprite's own view (x right, y up, z toward us); w lights-only
layout(location = 6) in vec3 aDir;    // the desk eye's direction to it (room frame)
layout(location = 7) in vec4 aWarp;   // each cell's stretch across the line of sight (sprites.js warp); B is paint (1)
                                      // or sail cloth (0); the windows' level
layout(location = 8) in vec4 aLivery; // the hull paint (rgb); the floodlights' colour (0 sodium .. 1 LED)
uniform vec2 uSize, uAtlas;
uniform float uReflStretch;           // the reflection's length against the sprite's height (longer at night)
out vec2 vT0, vT1;
flat out vec4 vR0, vR1;               // the two cells' rectangles (uv): nothing is read outside its own cell
out vec4 vInfo, vLook, vSun, vWarp, vLivery;
out vec3 vDir;
out float vRy;                        // reflection: 0 at the waterline .. 1 at the sprite's top
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  float k0 = max(aWarp.x, 0.05), k1 = max(aWarp.y, 0.05);
  float hw = aCell0.z * 0.5 * max(k0, k1);
  vec2 sp = vec2(mix(-hw, hw, c.x), c.y * aCell0.w);   // px across from the anchor's column, px down from the cell top
  float refl = mod(aMore.w, 2.0);
  float mir = step(2.0, aMore.w);
  vRy = clamp((aMore.y - sp.y) / max(aMore.y, 1.0), 0.0, 1.0);
  vec2 off = vec2(sp.x, aMore.y - sp.y);               // GL y up
  if (refl > 0.5) off.y = -(aMore.y - sp.y) * uReflStretch - 0.5;
  vec2 P = aPos.xy + off * aPos.z;
  gl_Position = vec4(P / uSize * 2.0 - 1.0, 0.0, 1.0);
  float sx = mir > 0.5 ? -sp.x : sp.x;
  vT0 = (aCell0.xy + vec2(aCell0.z * 0.5 + sx / k0, sp.y)) / uAtlas;
  vT1 = (aCell1.xy + vec2(aCell1.z * 0.5 + sx / k1, sp.y)) / uAtlas;
  vR0 = vec4(aCell0.xy, aCell0.xy + aCell0.zw) / uAtlas.xyxy;
  vR1 = vec4(aCell1.xy, aCell1.xy + aCell1.zw) / uAtlas.xyxy;
  vInfo = vec4(aMore.x, aMore.z, aPos.w, refl + 2.0 * mir);
  vLook = aLook; vSun = aSun; vDir = aDir; vWarp = aWarp; vLivery = aLivery;
}`;

export const HULL_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vT0, vT1;
flat in vec4 vR0, vR1;
in vec4 vInfo, vLook, vSun, vWarp, vLivery;
in vec3 vDir;
in float vRy;
out vec4 o;
${COMMON}
${PANO_GLSL}
uniform sampler2D uAlb, uNrm, uNgt;
uniform vec2 uAtlas;
uniform float uTime, uFog, uNight, uFx;
uniform vec3 uSunCol, uSkyCol, uLowCol, uGlow;
uniform float uLiveryBase;      // the livery faces' grey in the atlas (boats.json livery_base)
uniform float uWinK, uFloodK;   // how much the ships' lit windows and floodlit decks show (0 by day .. 1 at night)
float inRect(vec2 t, vec4 r) { return step(r.x, t.x) * step(t.x, r.z) * step(r.y, t.y) * step(t.y, r.w); }
void main() {
  float blend = vInfo.x, refl = mod(vInfo.w, 2.0), mir = step(2.0, vInfo.w);
  vec2 t0 = vT0, t1 = vT1;
  if (refl > 0.5) {
    // the reflection: rows shifted by the swell
    float w = sin(gl_FragCoord.y * 2.1 + uTime * 3.0) * 1.0 / uAtlas.x;
    t0.x += w; t1.x += w;
  }
  vec4 a0 = texture(uAlb, t0) * (inRect(t0, vR0) * (1.0 - blend));
  vec4 a1 = texture(uAlb, t1) * (inRect(t1, vR1) * blend);
  vec4 al = a0 + a1;
  if (al.a < 0.004) discard;
  float w0 = a0.a / max(al.a, 1e-4);
  vec4 nm = mix(texture(uNrm, t1), texture(uNrm, t0), w0);
  vec2 ng = mix(texture(uNgt, t1).rg, texture(uNgt, t0).rg, w0);
  vec2 nxy = nm.rg * 2.0 - 1.0;
  vec3 n = vec3(nxy, sqrt(max(0.0, 1.0 - dot(nxy, nxy))));
  if (mir > 0.5) n.x = -n.x;
  float livery = nm.b * vWarp.z, cloth = nm.b * (1.0 - vWarp.z);
  float glass = nm.a * (1.0 - cloth);
  vec3 alb = al.rgb / al.a;
  alb = mix(alb, alb * vLivery.rgb / uLiveryBase, livery);
  vec3 L = normalize(vSun.xyz + 1e-5);
  float ndl = dot(n, L);
  float sunK = vLook.x;                            // the sun on the face we see (0 when backlit or at night)
  vec3 light = uSunCol * max(ndl, 0.0) * (0.35 + 0.65 * sunK) + uSkyCol * (0.55 + 0.45 * n.y) + uLowCol * (0.45 - 0.45 * n.y);
  light += uSunCol * cloth * max(-ndl, 0.0) * 0.55;
  vec3 c = alb * light;
  // backlit: a silhouette with a rim where the sun grazes the edge
  float sil = vLook.y;
  c = mix(c, alb * uSkyCol * 0.35, sil * 0.8);
  c += uSunCol * vLook.z * pow(1.0 - abs(n.z), 3.0) * 0.9;
  c += glass * uSkyCol * 0.25 * (1.0 - uNight);
  // lights-only moments: the hull is barely there; its own lights carry it
  c *= 1.0 - 0.85 * vSun.w;
  // the ship's own light: warm windows (far brighter than white paper: a lit cabin's window still reads as a point
  // when it is a fraction of a pixel, and a block of them as a glow), and its decks under the floodlights (sodium
  // orange or LED white)
  vec3 floodCol = mix(vec3(1.0, 0.62, 0.28), vec3(0.93, 0.96, 1.0), vLivery.a);
  vec3 em = uGlow * ng.r * 14.0 * vWarp.w * uWinK + alb * floodCol * ng.g * 4.0 * uFloodK;
  vec2 ye = yawEl(normalize(vDir));
  // haze toward the panorama's own colour behind it (the air dims the ship's lights the same)
  c = mix(c, blurred(ye.x, ye.y), vLook.w);
  em *= 1.0 - vLook.w;
  float occ = occluderDist(pixelRay()) < vInfo.z * 0.95 ? 1.0 : 0.0;
  float fog = maskAt(ye.x, ye.y).b * uFog;
  float a = al.a * vInfo.y * (1.0 - occ) * (1.0 - clamp(fog, 0.0, 1.0)) * uFx;
  if (refl > 0.5) {
    // the hull's dark, broken reflection; its lights as columns that shimmer on the swell
    float wm = maskAt(ye.x, ye.y - 0.05).g;
    // broken into short dashes along thin columns that waver, fading down the water
    float dash = smoothstep(0.35, 0.8, noise(vec2(gl_FragCoord.x * 0.3, gl_FragCoord.y * 0.9 + uTime * 2.3)))
               * (0.35 + 0.65 * noise(vec2(gl_FragCoord.x * 1.1, uTime * 0.4))) * pow(1.0 - vRy, 1.5);
    // (the hull's: darker water under it, broken by the swell and fading down from the waterline)
    float ah = a * 0.24 * wm * (0.55 + 0.45 * noise(vec2(gl_FragCoord.x * 0.2, gl_FragCoord.y * 0.7 + uTime * 1.7))) * pow(1.0 - vRy, 0.7);
    o = vec4(c * 0.5 * ah + em * a * wm * 0.4 * dash, ah);
    return;
  }
  o = vec4((c + em) * a, a);
}`;

// ---------------------------------------------------------------------------------------------- halo
// A bright pass of the outside at 1/8 size, blurred, screen-blended over the room, masked by the window's outline.
export const BRIGHT_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;       // 1 / source size
uniform float uThreshold;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel * 2.0;   // this target is half the source's size
  vec3 c = vec3(0.0);
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) c += texture(uSrc, uv + (vec2(i, j) - 0.5) * uTexel).rgb;
  c *= 0.25;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  o = vec4(c * smoothstep(uThreshold, min(uThreshold + 0.2, 1.0), l), 1.0);
}`;

export const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uStep;        // one texel along the blur axis
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(uSrc, 0));
  // 9 taps of a Gaussian (sigma about 2.5 texels) through linear filtering
  vec3 c = texture(uSrc, uv).rgb * 0.2270;
  c += (texture(uSrc, uv + uStep * 1.3846).rgb + texture(uSrc, uv - uStep * 1.3846).rgb) * 0.3162;
  c += (texture(uSrc, uv + uStep * 3.2308).rgb + texture(uSrc, uv - uStep * 3.2308).rgb) * 0.0703;
  o = vec4(c, 1.0);
}`;

export const HALO_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const HALO_FS = `#version 300 es
precision highp float;
uniform sampler2D uHalo;
uniform vec2 uSize;        // drawing buffer px
uniform vec2 uCorners[4];  // the window opening on screen (device px, GL origin), in order
uniform float uFeather;    // px
uniform float uStrength;
out vec4 o;
float edgeDist(vec2 p) {
  // signed distance to the window quad (inside > 0), for a convex quad in either winding
  float s = 0.0;
  for (int i = 0; i < 4; i++) { vec2 a = uCorners[i], b = uCorners[(i + 1) % 4]; s += (b.x - a.x) * (b.y + a.y); }
  float sgn = s > 0.0 ? -1.0 : 1.0;   // the shoelace sum is negative for a counter-clockwise quad
  float d = 1e9;
  for (int i = 0; i < 4; i++) {
    vec2 a = uCorners[i], b = uCorners[(i + 1) % 4];
    vec2 e = normalize(b - a);
    d = min(d, sgn * (e.x * (p.y - a.y) - e.y * (p.x - a.x)));
  }
  return d;
}
void main() {
  vec2 p = gl_FragCoord.xy;
  float m = smoothstep(-uFeather, uFeather, edgeDist(p));
  vec3 h = texture(uHalo, p / uSize).rgb * uStrength * m;
  // desaturated toward warm white, as the page's halo layer
  float l = dot(h, vec3(0.2126, 0.7152, 0.0722));
  h = mix(vec3(l) * vec3(1.0, 0.93, 0.82), h, 0.55);
  o = vec4(h, 1.0);          // blended as a screen: ONE, ONE_MINUS_SRC_COLOR
}`;

// debug: copy a texture to the target (the "outside only" compare view)
export const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSize;
out vec4 o;
void main() { o = vec4(texture(uSrc, gl_FragCoord.xy / uSize).rgb, 1.0); }`;
