// DYS-227 (G's helper gullreal, 3 Nov): the window's gulls drawn as the 3D western gull of shared/city/gull-model.js,
// in place of the point sprite's flapping V (outside.glsl.js POINTS_FS shape 3, which a 4x view showed as a faint
// blurred tan chevron). outside.js fetches this module after the room is shown (never on the boot's path) and draws
// each gull the city places (outside-events.js gulls3d) after the points:
//   1. its model, posed for this frame's wing beat (five joints, shared/city/gull-model.js gullBones), into an
//      offscreen layer over just its box on the screen, at 2-3 layer px per window px (GULL_SS), depth-tested;
//      per pixel: its plumage (GULL_FS plumage), lit by the moment's sun, sky and ground in the panorama's own colours
//      (as the 3D street cars, outside.js drawCarGroup), its flight feathers lit through when the sun is behind it,
//      hidden where the panorama has something nearer along that pixel's ray (trafficVis), hazed toward the picture
//      behind by the air (its look's hazeMix) and faded by the fog layer, as every sprite is;
//   2. that layer back onto the window through a small Gaussian: the photograph's own blur at its density there, as
//      the 3D cars' (outside.js gullSoft), 0.55-0.9 window px (in front of everything, never softer; never a stair).
// One model (3,036 vertices, 5,784 triangles: 170 KB of vertex data and 35 KB of indices on the GPU), no pictures; the
// layer (RGBA8 + depth) made at the first gull and let go GULL_IDLE_MS after the last one.
import { PANO_GLSL } from "./outside.glsl.js";
import { buildGullMesh, gullPose, gullBones, placeMatrix, mul4, wingtip, extentPoints, GULL_SPAN, SEMI, WRIST, EYE } from "../city/gull-model.js";

export const GULL_SOFT = 0.7;         // window px: the layer's blur onto the window without a density (ctx.soft)
export const GULL_IDLE_MS = 20000;    // the layer let go this long after the last gull drawn
const f5 = (x) => x.toFixed(5);

export const GULL_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;     // model m (gull-model.js)
layout(location = 1) in vec3 aNrm;
layout(location = 2) in vec4 aUV;      // wing: span 0..1, chord 0..1, side (+1 upper, -1 lower), chord (m); lofts: ring x, z
layout(location = 3) in vec4 aInfo;    // bone a, bone b, b's weight, part (0 body, 1 wing, 2 tail, 3 foot)
uniform mat4 uBone[5];                 // the joints for this frame's pose (model frame)
uniform mat4 uModel;                   // model -> world (engine m)
uniform mat4 uVP;                      // world -> the layer's clip
uniform vec3 uOrigin;                  // the panorama's eye (world)
uniform vec2 uZ;                       // its own depth range: the view depth at its middle (m), 1 / half the range (m)
out vec3 vN, vPe, vRest, vW;
out vec4 vUV;
out float vPart;
invariant gl_Position;                 // (the beat's blur draws each pose twice, depth then colour at EQUAL: the same depth)
void main() {
  int a = int(aInfo.x + 0.5), b = int(aInfo.y + 0.5);
  mat4 M = uBone[a] * (1.0 - aInfo.z) + uBone[b] * aInfo.z;
  vec4 w = uModel * (M * vec4(aPos, 1.0));
  vN = mat3(uModel) * (mat3(M) * aNrm);
  vW = w.xyz;
  vPe = w.xyz - uOrigin;
  vRest = aPos; vUV = aUV; vPart = aInfo.w;
  gl_Position = uVP * w;
  // (depth from its own middle, +-1.2 m: the camera's range left ~1 mm at 40 m, and a wing's thin trailing half is
  // that thin, so its two surfaces fought where it bends; alone in its layer, the gull needs no other)
  gl_Position.z = clamp((gl_Position.w - uZ.x) * uZ.y, -1.0, 1.0) * gl_Position.w;
}`;

// the plumage (sRGB albedo) of an adult western gull, from the coordinates each vertex carries; tr: how much of the sun
// behind it comes through (the flight feathers' vanes; little through the black)
const PLUMAGE = `
const vec3 C_WHITE = vec3(0.925, 0.925, 0.905);
const vec3 C_GREY = vec3(0.215, 0.23, 0.26);        // the dark slate grey back and upper wings (round 3: as dark as the
                                                    // photographs' ~0.06 of the white's light)
const vec3 C_BLACK = vec3(0.065, 0.065, 0.075);
const vec3 C_UNDER = vec3(0.47, 0.49, 0.52);        // the flight feathers from below (dusky: the dark upper wing behind them)
const vec3 C_BILL = vec3(0.94, 0.77, 0.22), C_BILLTIP = vec3(0.93, 0.86, 0.55), C_SPOT = vec3(0.80, 0.19, 0.13);
const vec3 C_IRIS = vec3(0.88, 0.80, 0.46), C_RING = vec3(0.86, 0.43, 0.2), C_FOOT = vec3(0.80, 0.52, 0.50);
const float RW = ${f5(WRIST / SEMI)};
const vec3 EYE = vec3(${f5(EYE[0])}, ${f5(EYE[1])}, ${f5(EYE[2])});
float sm(float a, float b, float x) { return smoothstep(a, b, x); }
// a feather's grain: value noise (the plumage is never one flat colour)
float ghash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ghash(i), ghash(i + vec2(1, 0)), u.x), mix(ghash(i + vec2(0, 1)), ghash(i + vec2(1, 1)), u.x), u.y);
}
// a wing: rn the span (0 shoulder .. 1 tip), f the chord (0 leading .. 1 trailing edge), side, ch the chord (m)
vec3 wingAlb(float rn, float f, float side, float ch, out float tr) {
  float up = step(0.0, side);
  float e = 0.007 / max(ch, 0.01);                   // ~7 mm of chord: the patterns' soft edges (a feather's own)
  float kW = sm(RW - 0.04, RW + 0.04, rn);           // arm (0) to hand (1), smoothly across the wrist
  // the black of the outer primaries (P5-P10): from ~0.69 of the span at the leading edge, ~0.74 at the trailing,
  // with the grey inner webs as tongues into it near the trailing edge
  float bb = 0.735 - 0.05 * (1.0 - f) + 0.03 * sm(0.5, 0.95, f) * (0.5 + 0.5 * cos(6.2832 * (rn - 0.72) / 0.055));
  float black = sm(bb - 0.006, bb + 0.006, rn);
  // white: the trailing edge (the secondaries' and inner primaries' broad white tips; the tertial crescent by the
  // body), a thin white leading edge on the arm, the black primaries' white tips, P10's white mirror (and a small one
  // on P9)
  float teW = mix(0.72, 0.80, sm(0.09, 0.15, rn)) + 0.17 * sm(RW, 0.66, rn);
  float white = sm(teW - e, teW + e, f) * (1.0 - black);
  white = max(white, (1.0 - sm(0.035 - e, 0.035 + e, f)) * (1.0 - sm(RW - 0.02, RW + 0.02, rn)));
  float tipPos = (1.0 - f) * ch;                     // m from the trailing edge
  float apical = 0.0;
  for (int k = 0; k < 5; k++) {
    float rk = 0.745 + 0.05 * float(k);
    apical = max(apical, (1.0 - sm(0.010, 0.014, tipPos)) * (1.0 - sm(0.010, 0.016, abs(rn - rk) * ${f5(SEMI)})));
  }
  float tip = (1.0 - sm(0.006, 0.010, (1.0 - rn) * ${f5(SEMI)} + 0.6 * tipPos));   // P10's own pale tip
  float mir = 1.0 - sm(0.8, 1.15, length(vec2((rn - 0.928) / 0.024, (f - 0.30) / 0.17)));
  mir = max(mir, 0.6 * (1.0 - sm(0.8, 1.2, length(vec2((rn - 0.885) / 0.012, (f - 0.58) / 0.12)))));
  white = max(white, max(max(apical, tip * 0.8), mir) * black);
  vec3 c;
  if (up > 0.5) {
    // (round 2, tell 2) a feathered gradient, not one flat grey: the leading edge's small coverts a little darker, the
    // flight feathers toward the trailing edge a little paler
    float grad = mix(0.86, 1.07, sm(0.0, 0.9, f));
    c = mix(mix(C_GREY * grad, C_BLACK, black), C_WHITE, white);
  } else {
    // below: white coverts in front, grey flight feathers behind (a feather's shaft a faint line), the black tips
    float ff = sm(mix(0.50, 0.40, kW), mix(0.60, 0.50, kW), f);
    float shaft = mix(abs(fract(rn / 0.021) * 2.0 - 1.0), abs(fract((rn - 0.3 * f) / 0.05) * 2.0 - 1.0), kW);
    vec3 fl = C_UNDER * (0.93 + 0.07 * sm(0.6, 1.0, shaft)) * mix(1.0, 0.86, sm(RW, 0.7, rn));
    c = mix(mix(C_WHITE, fl, ff), C_BLACK * 1.5, black);
    c = mix(c, C_WHITE, white);
    c *= mix(0.84, 1.0, sm(0.0, 0.12, rn));          // (the inner underwing in the body's shade)
  }
  tr = mix(0.42, 0.06, black) * sm(0.25, 0.6, f);
  // the grain: along the feathers (across the span on the arm, fanned on the hand)
  return c * (0.94 + 0.1 * gnoise(vec2(rn * 95.0 + 7.0 * up, f * 9.0)));
}
// the head, body and bill (rest position p, model m; ring coordinates q: x and z around the loft)
vec3 bodyAlb(vec3 p, vec2 q) {
  float y = p.y;
  // the mantle: the back between the wings, grey from the base of the neck to the rump
  float mantle = sm(0.12, 0.42, q.y) * sm(-0.115, -0.07, y) * (1.0 - sm(0.07, 0.115, y));
  vec3 c = mix(C_WHITE, C_GREY, mantle);
  // (round 2, tell 2) the flank under the wing's root in its shade: a soft dark, no edge
  c *= 1.0 - 0.22 * sm(0.45, 0.85, abs(q.x)) * sm(0.25, -0.25, q.y) * sm(-0.17, -0.1, y) * (1.0 - sm(0.03, 0.09, y));
  if (y > 0.240) {
    float t = sm(0.240, 0.246, y);
    vec3 bill = mix(C_BILL, C_BILLTIP, sm(0.290, 0.302, y));
    bill = mix(bill, C_SPOT, (1.0 - sm(-0.30, -0.16, q.y)) * sm(0.266, 0.272, y) * (1.0 - sm(0.288, 0.294, y)));
    bill *= mix(1.0, 0.55, (1.0 - sm(0.05, 0.11, abs(q.y))) * (1.0 - sm(0.290, 0.296, y)));   // the gape
    c = mix(c, bill, t);
  }
  float d = length(p - vec3(sign(p.x) * EYE.x, EYE.yz));
  vec3 eye = d < 0.0024 ? vec3(0.03) : d < 0.0047 ? C_IRIS : C_RING;
  c = mix(c, eye, 1.0 - sm(0.0058, 0.0066, d));
  return c * (0.965 + 0.05 * gnoise(vec2(p.y * 170.0, (p.z + abs(p.x)) * 170.0)));
}
`;

export const GULL_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 vN, vPe, vRest, vW;
in vec4 vUV;
in float vPart;
out vec4 o;
const float DEG = 0.017453292519943295;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
${PANO_GLSL}
uniform vec4 uLayer;        // screen device px of a layer px: x0, y0, 1 / scale
uniform vec3 uSunDir;       // toward the sun (room frame)
uniform vec3 uSunLin, uSkyLin, uGndLin;   // the sun's, the sky's and the ground's light (linear)
uniform vec3 uCamEye;       // the camera's eye (world)
uniform vec4 uGull;         // its distance (m), opacity (its fades x the events' weight), haze mix, the fog's strength
uniform vec3 uGullDir;      // the eye's direction to it (room frame)
uniform float uWeight;      // this pose's share of the frame (the beat's motion blur: 1 / its samples)
${PLUMAGE}
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  // what the panorama has nearer along this pixel's ray hides it (its roofs, walls, leaves at their real edges)
  vec2 sc = uLayer.xy + gl_FragCoord.xy * uLayer.z;
  vec2 ndc = (sc - uViewport.xy) / uViewport.zw * 2.0 - 1.0;
  vec4 rp = uRayM * vec4(ndc, 1.0, 1.0);
  vec3 ray = normalize(rp.xyz / rp.w);
  float vis = trafficVis(ray, ray, length(vPe), 0.7, 0.97);
  if (vis <= 0.0) discard;
  int part = int(vPart + 0.5);
  // a wing's trailing edge is feathers, not a ruler: up to 3 mm of it notched away, irregularly
  if (part == 1 && (1.0 - vUV.y) * vUV.w < 0.003 * gnoise(vec2(vUV.x * 260.0, 3.0))) discard;
  float tr = 0.0;
  vec3 alb;
  if (part == 1) alb = wingAlb(vUV.x, vUV.y, vUV.z, vUV.w, tr);
  else if (part == 3) alb = C_FOOT;
  else if (part == 2) alb = C_WHITE;
  else alb = bodyAlb(vRest, vUV.xy);
  vec3 a = toLin(alb);
  vec3 n = normalize(vN), V = normalize(uCamEye - vW), L = normalize(uSunDir);
  if (dot(n, V) < -0.2) n = -n;                      // (a wing's thin trailing edge seen from its far side)
  float ndl = dot(n, L);
  // feathers scatter: a soft terminator; the sky above, the ground's bounce below
  vec3 light = uSunLin * max(0.0, (ndl + 0.2) / 1.2) + uSkyLin * (0.55 + 0.45 * n.y) + uGndLin * (0.5 - 0.5 * n.y);
  vec3 c = a * light;
  c += a * uSunLin * tr * max(0.0, -ndl) * 0.6;      // the sun through the flight feathers from behind
  float rim = pow(1.0 - abs(dot(n, V)), 4.0) * smoothstep(0.1, 0.8, dot(L, -V));
  c += uSunLin * rim * 0.3 * (0.25 + 0.75 * luma(a));   // the edges the sun behind it grazes
  vec2 ye = yawEl(normalize(uGullDir));
  c = mix(c, toLin(blurred(ye.x, ye.y)), clamp(uGull.z, 0.0, 1.0));
  float fog = clamp(maskAt(ye.x, ye.y).b * uGull.w, 0.0, 1.0);
  float al = vis * clamp(uGull.y, 0.0, 1.0) * (1.0 - fog);
  o = vec4(toSrgb(c) * al, al) * uWeight;
}`;

// the layer back onto the window (as outside.glsl.js CARLAYER_VS / _FS)
export const GULL_COMP_VS = `#version 300 es
precision highp float;
uniform vec4 uRect;         // the layer's box on the window: x0, y0, w, h (device px)
uniform vec2 uSize;         // the drawing buffer (device px)
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  gl_Position = vec4((uRect.xy + c * uRect.zw) / uSize * 2.0 - 1.0, 0.0, 1.0);
}`;
export const GULL_COMP_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec4 uRect;
uniform vec4 uMap;          // layer px per window px, the layer texture's size (w, h), the blur's sigma (window px)
out vec4 o;
void main() {
  vec2 p = (gl_FragCoord.xy - uRect.xy) * uMap.x;
  vec2 t = 1.0 / uMap.yz;
  float sg = uMap.w * uMap.x;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    float w = exp(-0.28125 * float(i * i + j * j));
    acc += w * texture(uSrc, (p + vec2(float(i), float(j)) * 0.75 * sg) * t);
    ws += w;
  }
  o = acc / ws;
}`;

// a gull's record in outside-events.js gulls3d
export const GULL3D_FLOATS = 21;
// 0-2 its place (world m), 3-4 its heading in the room frame (right, forward), 5 scale (span / 1.3), 6 distance (m),
// 7 opacity, 8 the beat's phase, 9 its amplitude, 10 its own time (s), 11 its own number 0..1, 12-15 its look (sun on
// the face, silhouette, rim, haze mix), 16-18 the eye's direction to it (room frame), 19 flapping (0 / 1), 20 its beats
// a second
export const GULL_SHUTTER = 1 / 250;   // s: the beat's motion blur, a slight smear as a camera's (round 2, tell 4; at 1/150 s
                                       // a near gull's wingtips travelled ~25 px at 4x, more than the samples hide)
export const GULL_BLUR_PX = 1.6;       // device px of wingtip travel per pose sample (at most GULL_SAMPLES: a smear, no steps)
export const GULL_SAMPLES = { laptop: 8, phone: 4 };

const lin1 = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/**
 * The moment's light on a gull, from the panorama's own colours (e: outside.js environment(): its white walls in sun,
 * its high sky, its air and water, sRGB; the sun's alt / az, night, fog; M the city's moment light: sunRGB). Linear.
 * A white face square to the sun gets what the photograph's white walls in sun have (their albedo taken as 0.82),
 * shared as the sun and the open sky share it on a sunlit face (the sky a third of the sun, in its own colour half
 * neutral); without the sun the sky carries it all. From below, the bay's water (and a little of the air).
 */
export function gullLight(e, M, axisDeg) {
  const D = Math.PI / 180;
  const sunOn = smooth(-0.8, 0.6, e.alt) * (1 - e.night) * (1 - 0.7 * e.fog);
  const yawS = (e.az - axisDeg) * D, ca = Math.cos(e.alt * D);
  const sun = [Math.sin(yawS) * ca, Math.sin(e.alt * D), -Math.cos(yawS) * ca];
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const Wl = e.white.map(lin1), Hl = e.high.map(lin1), Al = e.air.map(lin1), Wa = (e.water || [0.2, 0.3, 0.4]).map(lin1);
  const s0 = M ? M.sunRGB : [1, 1, 1], sY = Math.max(lum(s0), 1e-6), hY = Math.max(lum(Hl), 1e-6);
  const E = lum(Wl) / 0.82, nk = 1 - 0.9 * e.night;
  const sunK = E * 0.75 * sunOn, skyK = E * (0.3 + 0.55 * (1 - sunOn)) * nk;
  // (the shade a quarter in the sky's colour, the water's half grey: in their own colours the white went blue, where
  // the photograph's own shaded whites are near neutral; the cars found the same, drawCarGroup)
  const g = Wa.map((x, i) => 0.8 * x + 0.2 * Al[i]), gY = lum(g);
  return {
    sun, sunOn,
    sunLin: s0.map((x) => (x / sY) * sunK),
    skyLin: Hl.map((x) => (0.25 * x / hY + 0.75) * skyK),
    gndLin: g.map((x) => (0.5 * x + 0.5 * gY) * 0.45 * nk),
  };
}

/**
 * The renderer. h: outside.js's own helpers: program(vs, fs) (its makeProgram, with the outside's texture units),
 * target(w, h, depth), freeTarget(t), panoUniforms(prog), unitSrc (the composite's texture unit), phone (bool).
 * draw() needs both programs linked (ready()); until then outside-events.js draws the old point (env.gull3d false).
 */
export function createGullRenderer(gl, h) {
  const prog = h.program(GULL_VS, GULL_FS), comp = h.program(GULL_COMP_VS, GULL_COMP_FS);
  const SS = h.phone ? 2 : 3, LAYER_PX = h.phone ? 4e5 : 1.2e6;   // (layer px per window px at most; the layer's px at most)
  const SAMPLES = h.phone ? GULL_SAMPLES.phone : GULL_SAMPLES.laptop;
  let vao = null, nIdx = 0, layer = null, lastAt = -Infinity, warm = false, stats = { drawn: 0, layer: null, scale: 0 };
  const bones = new Float32Array(80), m32 = new Float32Array(16), vp32 = new Float32Array(16);
  function upload() {
    const m = buildGullMesh(), n = m.count, F = 14, data = new Float32Array(n * F);
    for (let i = 0; i < n; i++) {
      data.set(m.pos.subarray(i * 3, i * 3 + 3), i * F); data.set(m.nrm.subarray(i * 3, i * 3 + 3), i * F + 3);
      data.set(m.uv.subarray(i * 4, i * 4 + 4), i * F + 6); data.set(m.info.subarray(i * 4, i * 4 + 4), i * F + 10);
    }
    const wasVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING), wasBuf = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    [[0, 3, 0], [1, 3, 12], [2, 4, 24], [3, 4, 40]].forEach(([i, k, off]) => { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, k, gl.FLOAT, false, F * 4, off); });
    const eb = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eb);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.index, gl.STATIC_DRAW);
    nIdx = m.index.length;
    gl.bindVertexArray(wasVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, wasBuf);
  }
  upload();   // (the mesh built and sent now, between frames: never in the frame a gull first shows)
  const ready = () => prog.check() && comp.check();
  const idU = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0) / 4294967296; };

  // one gull into the layer, then onto the window. R: the records, i its index; ctx: the frame's (draw). warm: the
  // programs' first draw, at no opacity over a corner (their pipelines built before a gull is seen)
  function one(R, i, ctx, warm = false) {
    const o = i * GULL3D_FLOATS, W = ctx.W, H = ctx.H, vp = ctx.vp;
    const pos = [R[o], R[o + 1], R[o + 2]], sc = R[o + 5];
    // the beat's motion blur (round 2, tell 4): its poses over a camera's shutter at the frame's time, the body held (as a
    // camera panning with it sees a bird: the wingtips smear, the body stays sharp); as many as its wingtips' travel on
    // the screen asks for (a glide, or a far gull: one)
    const ph = R[o + 8], amp = R[o + 9], wt = R[o + 10], seed = R[o + 11], hz = R[o + 20] || 2.7, sh = GULL_SHUTTER;
    let N = 1;
    if (!warm && amp > 0.02 && ctx.ppr) {
      const a = wingtip(gullPose(ph - hz * sh / 2, amp, wt - sh / 2, seed)), b = wingtip(gullPose(ph + hz * sh / 2, amp, wt + sh / 2, seed));
      const px = (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * sc * ctx.ppr) / Math.max(1, R[o + 6]);
      N = Math.max(1, Math.min(SAMPLES, Math.ceil(px / GULL_BLUR_PX)));
    }
    const fwd = [R[o + 3], 0, -R[o + 4]];
    // its box on the screen: tight round the posed bird, its outline points at the shutter's two ends (round 2: a box
    // ~3x the bird left its layer at 1.8 px a window px at 4x, an edge softer than the photograph's own)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const dt of N > 1 ? [-sh / 2, sh / 2] : [0]) {
      const pose = gullPose(ph + hz * dt, amp, wt + dt, seed), Mw = placeMatrix(pos, fwd, sc, pose);
      for (const p of extentPoints(pose)) {
        const wx = Mw[0] * p[0] + Mw[4] * p[1] + Mw[8] * p[2] + Mw[12], wy = Mw[1] * p[0] + Mw[5] * p[1] + Mw[9] * p[2] + Mw[13], wz = Mw[2] * p[0] + Mw[6] * p[1] + Mw[10] * p[2] + Mw[14];
        const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
        if (cw <= 1e-6) return false;
        const sx = ((vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12]) / cw * 0.5 + 0.5) * W, sy = ((vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13]) / cw * 0.5 + 0.5) * H;
        x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
      }
    }
    const soft = ctx.soft ? ctx.soft(R[o + 16], R[o + 17], R[o + 18]) : GULL_SOFT;
    const rect = ctx.rect, pad = Math.ceil(4 + 3 * soft);
    x0 = Math.max(Math.floor(x0) - pad, rect[0], 0); y0 = Math.max(Math.floor(y0) - pad, rect[1], 0);
    x1 = Math.min(Math.ceil(x1) + pad, rect[0] + rect[2], W); y1 = Math.min(Math.ceil(y1) + pad, rect[1] + rect[3], H);
    if (warm) { x0 = rect[0]; y0 = rect[1]; x1 = x0 + 4; y1 = y0 + 4; }
    if (x1 <= x0 || y1 <= y0) return false;
    const bw = x1 - x0, bh = y1 - y0, s = Math.max(1, Math.min(SS, Math.sqrt(LAYER_PX / (bw * bh))));
    const lw = Math.max(1, Math.ceil(bw * s)), lh = Math.max(1, Math.ceil(bh * s));
    if (!layer || layer.w < lw || layer.h < lh) {
      // (grown, not shrunk, as the cars' layer; past 1.3x its budget, made at the size it needs now)
      let nw = Math.max(layer?.w || 0, Math.ceil(lw / 128) * 128), nh = Math.max(layer?.h || 0, Math.ceil(lh / 128) * 128);
      if (nw * nh > 1.3 * LAYER_PX) { nw = Math.ceil(lw / 128) * 128; nh = Math.ceil(lh / 128) * 128; }
      h.freeTarget(layer);
      layer = h.target(nw, nh, true);
    }
    const ax = (W * s) / lw, ay = (H * s) / lh;
    const Lm = [ax, 0, 0, 0, 0, ay, 0, 0, 0, 0, 1, 0, ax - (2 * x0 * s) / lw - 1, ay - (2 * y0 * s) / lh - 1, 0, 1];
    vp32.set(mul4(Lm, vp));
    // into the layer
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.fb);
    gl.viewport(0, 0, lw, lh);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    // (several poses: each its depth alone, then its colour only where that depth is (EQUAL), added at 1 / N: the layer
    // holds their average, each pose's own nearer surfaces over its farther ones; added in one pass, every surface the
    // depth test let through in drawing order added too: round 2's first take showed a wing's underside through it)
    if (N > 1) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); } else gl.disable(gl.BLEND);
    const u = prog.u;
    gl.useProgram(prog.p);
    h.panoUniforms(prog);
    gl.uniformMatrix4fv(u.uVP, false, vp32);
    gl.uniform1f(u.uWeight, 1 / N);
    gl.uniform3f(u.uOrigin, ctx.origin[0], ctx.origin[1], ctx.origin[2]);
    gl.uniform2f(u.uZ, vp[3] * pos[0] + vp[7] * pos[1] + vp[11] * pos[2] + vp[15], 1 / (1.2 * sc));
    gl.uniform4f(u.uLayer, x0, y0, 1 / s, 0);
    const Lt = ctx.light;
    gl.uniform3f(u.uSunDir, ...Lt.sun); gl.uniform3f(u.uSunLin, ...Lt.sunLin); gl.uniform3f(u.uSkyLin, ...Lt.skyLin); gl.uniform3f(u.uGndLin, ...Lt.gndLin);
    gl.uniform3f(u.uCamEye, ctx.eye[0], ctx.eye[1], ctx.eye[2]);
    gl.uniform4f(u.uGull, R[o + 6], warm ? 0 : R[o + 7] * ctx.fx, R[o + 15], ctx.fog);
    gl.uniform3f(u.uGullDir, R[o + 16], R[o + 17], R[o + 18]);
    gl.bindVertexArray(vao);
    for (let k = 0; k < N; k++) {
      const dt = N > 1 ? ((k + 0.5) / N - 0.5) * sh : 0;
      const pose = gullPose(ph + hz * dt, amp, wt + dt, seed);
      gullBones(pose, bones);
      m32.set(placeMatrix(pos, fwd, sc, pose));
      gl.uniformMatrix4fv(u.uBone, false, bones);
      gl.uniformMatrix4fv(u.uModel, false, m32);
      if (N > 1) {
        if (k) { gl.depthMask(true); gl.clear(gl.DEPTH_BUFFER_BIT); }
        gl.colorMask(false, false, false, false); gl.depthMask(true); gl.depthFunc(gl.LESS);
        gl.drawElements(gl.TRIANGLES, nIdx, gl.UNSIGNED_SHORT, 0);
        gl.colorMask(true, true, true, true); gl.depthMask(false); gl.depthFunc(gl.EQUAL);
      }
      gl.drawElements(gl.TRIANGLES, nIdx, gl.UNSIGNED_SHORT, 0);
    }
    gl.colorMask(true, true, true, true); gl.depthMask(true); gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.DEPTH_TEST);
    // onto the window
    gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.fb);
    gl.viewport(0, 0, W, H);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(rect[0], rect[1], rect[2], rect[3]);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const v = comp.u;
    gl.useProgram(comp.p);
    gl.activeTexture(gl.TEXTURE0 + h.unitSrc);
    gl.bindTexture(gl.TEXTURE_2D, layer.tex);
    if (v.uSrc) gl.uniform1i(v.uSrc, h.unitSrc);
    gl.uniform4f(v.uRect, x0, y0, bw, bh);
    gl.uniform2f(v.uSize, W, H);
    gl.uniform4f(v.uMap, s, layer.w, layer.h, soft);
    gl.bindVertexArray(ctx.vaoEmpty);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!warm) stats = { drawn: stats.drawn + 1, layer: [layer.w, layer.h], scale: +s.toFixed(2), soft: +soft.toFixed(2), samples: N,
      ppd: ctx.ppr ? +((ctx.ppr * Math.PI) / 180).toFixed(1) : null, box: [x0, y0, bw, bh], light: ctx.light };
    return true;
  }

  return {
    ready,
    get stats() { return stats; },
    /**
     * Draw n gulls (R: outside-events.js gulls3d) over the window, after the points. ctx: { W, H (the drawing buffer),
     * vp (world -> clip, the outside's camera), eye (the camera's eye, world), origin (the panorama's eye, world), rect
     * (the window's rectangle, device px, GL y), light (gullLight), fog, fx (the events' weight), vaoEmpty, now (ms) }
     */
    draw(R, n, ctx) {
      if (!ready()) return 0;
      if (!vao) upload();
      if (!n && warm) {
        if (layer && ctx.now - lastAt > GULL_IDLE_MS) { h.freeTarget(layer); layer = null; }
        return 0;
      }
      ctx.fb = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
      const scis = gl.isEnabled(gl.SCISSOR_TEST), box = scis ? gl.getParameter(gl.SCISSOR_BOX) : null;
      let k = 0;
      if (!warm) {
        // (the first frame the programs are in: one draw of each, at no opacity over a 4 px corner, a gull straight
        // ahead 50 m out, so a phone builds their pipelines now and not in the frame a gull is first seen)
        const f = ctx.vp, len = Math.hypot(f[2], f[6], f[10]) || 1, d = 50;
        const fake = new Float32Array(GULL3D_FLOATS);
        fake.set([ctx.eye[0] + (f[2] / len) * d, ctx.eye[1] + (f[6] / len) * d, ctx.eye[2] + (f[10] / len) * d, 1, 0, 1, d, 0, 0.28, 0, 0, 0.5]);   // (vp's third row: the camera's forward)
        fake[16] = 0; fake[17] = 0; fake[18] = -1;
        one(fake, 0, ctx, true);
      }
      stats = { drawn: 0, layer: stats.layer, scale: stats.scale };
      for (let i = 0; i < n; i++) if (one(R, i, ctx)) k++;
      gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.fb);
      gl.viewport(0, 0, ctx.W, ctx.H);
      if (scis) { gl.enable(gl.SCISSOR_TEST); gl.scissor(box[0], box[1], box[2], box[3]); } else gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.DEPTH_TEST);
      if (k) lastAt = ctx.now;
      warm = true;
      return k;
    },
    get warm() { return warm; },
    /** draw() wants calling with no gull out: its programs not yet warmed, or its layer still held */
    get busy() { return !warm || !!layer; },
    /** the GL objects let go (a lost context: outside.js makes a new renderer) */
    free() { if (layer) h.freeTarget(layer); layer = null; vao = null; },
    seedOf: idU,
  };
}
