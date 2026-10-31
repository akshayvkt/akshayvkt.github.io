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
// v3/zoom-sharp: magnified, the coarser levels are read through a cubic B-spline where one of their texels spans more
// than about two screen px (tapLv). uSmooth 0 (1x, and every program but the backdrop): the plain bilinear read, the
// outside exactly as before. gDegPerPx: this pixel's degrees per device px (the backdrop's main() sets it); gSmoothK 0
// leaves one call bilinear (the already blurred reads for water and fog)
uniform float uSmooth;
float gDegPerPx = 0.0, gSmoothK = 1.0;

int slotL0(int c) { ivec4 v = uSlotL0[c >> 2]; int k = c & 3; return k == 0 ? v.x : k == 1 ? v.y : k == 2 ? v.z : v.w; }
int pick(ivec4 v, int m) { return m == 0 ? v.x : m == 1 ? v.y : m == 2 ? v.z : v.w; }
// one layer of a tile array at texel position px (gutters included) of a size-px tile whose level has ppd px/deg. A
// bilinear read magnified this far draws a pyramid around every light, which reads as blocks; the B-spline (four
// bilinear taps, GPU Gems 2 ch. 20) is a soft round blur instead. Faded in between 0.65 and 0.45 texels per screen px,
// so no magnification switches the look at once; the 2 px gutters hold the spline's reach.
vec4 tapLv(sampler2DArray s, vec2 px, vec2 size, float layer, float ppd) {
  float k = uSmooth * gSmoothK * (1.0 - smoothstep(0.45, 0.65, ppd * gDegPerPx));
  if (k <= 0.0) return textureLod(s, vec3(px / size, layer), 0.0);
  vec2 st = px - 0.5, i = floor(st), f = st - i, f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0, w3 = f3 / 6.0;
  vec2 s0 = w0 + w1, s1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / s0) / size, h1 = (i + 1.5 + w3 / s1) / size;
  vec4 c = s0.y * (s0.x * textureLod(s, vec3(h0, layer), 0.0) + s1.x * textureLod(s, vec3(h1.x, h0.y, layer), 0.0))
         + s1.y * (s0.x * textureLod(s, vec3(h0.x, h1.y, layer), 0.0) + s1.x * textureLod(s, vec3(h1, layer), 0.0));
  return k >= 1.0 ? c : mix(textureLod(s, vec3(px / size, layer), 0.0), c, k);
}

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
      if (s >= 0) return tapLv(uL0c, vec2(g + (yaw - colYaw) * uPpd.x, g + (top - el) * uPpd.x), uSizeL0.xy, float(s), uPpd.x).rgb;
    }
    if (lv <= 1) {
      int s = pick(uSlotL1c[col], m);
      if (s >= 0) return tapLv(uL1c, vec2(g + (yaw - colYaw) * uPpd.y, g + (top - el) * uPpd.y), uSizeL1.xy, float(s), uPpd.y).rgb;
    }
    int s2 = pick(uSlotL2c, m);
    return tapLv(uL2c, vec2(g + (yaw - uPano.x) * uPpd.z, g + (top - el) * uPpd.z), uSizeL2.xy, float(max(s2, 0)), uPpd.z).rgb;
  }
  float top = uBand.z;
  if (lv <= 1) {
    int s = pick(uSlotL1s[col], m);
    if (s >= 0) return tapLv(uL1s, vec2(g + (yaw - colYaw) * uPpd.y, g + (top - el) * uPpd.y), uSizeL1.zw, float(s), uPpd.y).rgb;
  }
  int s2 = pick(uSlotL2s, m);
  return tapLv(uL2s, vec2(g + (yaw - uPano.x) * uPpd.z, g + (top - el) * uPpd.z), uSizeL2.zw, float(max(s2, 0)), uPpd.z).rgb;
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
  gSmoothK = 0.0;            // (v3/zoom-sharp: four plain reads of L2 are this blur; no spline in them)
  for (int m = 0; m < 4; m++) {
    float w = m == 0 ? uW.x : m == 1 ? uW.y : m == 2 ? uW.z : uW.w;
    if (w <= 0.0) continue;
    vec3 a = levelColour(m, 2, 0, yaw - 0.6, el - 0.3) + levelColour(m, 2, 0, yaw + 0.6, el - 0.3)
           + levelColour(m, 2, 0, yaw - 0.3, el + 0.3) + levelColour(m, 2, 0, yaw + 0.3, el + 0.3);
    s += w * 0.25 * a;
  }
  gSmoothK = 1.0;
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
    if (s >= 0) return tapLv(uF1, vec2(g + (yaw - colYaw) * uFarPpd.x, g + (top - el) * uFarPpd.x), uSizeF.xy, float(s), uFarPpd.x);
  }
  int s2 = pick(uSlotF2, m);
  if (s2 < 0) return vec4(0.0, 0.0, 0.0, -1.0);
  return tapLv(uF2, vec2(g + (yaw - uPano.x) * uFarPpd.y, g + (top - el) * uFarPpd.y), uSizeF.zw, float(s2), uFarPpd.y);
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
    if (s >= 0) return tapLv(uN0, vec2(g + (yaw - colYaw) * uNearPpd.x, g + (top - el) * uNearPpd.x), uSizeN.xy, float(s), uNearPpd.x);
  }
  int s1 = pick(back ? uSlotNK[col] : uSlotNF[col], m);
  if (s1 < 0) return vec4(-1.0);
  return tapLv(uNB, vec2(g + (yaw - colYaw) * uNearPpd.y, g + (top - el) * uNearPpd.y), uSizeN.zw, float(s1), uNearPpd.y);
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
// The street traffic's occluders (scripts/city_clock/occl_depth.py): the city's 16-bit log depth from the panorama eye
// over the lanes' corridors, with the trees apart (their depth and their leaves' coverage), at L0 (one texture: the
// band's two yaw halves side by side, solid then trees, each block uOccH.x rows) and at L3 (an atlas of 1-degree
// squares, slot = 2 rows of (tile + 2 gutter) px, the item's 2 x 2 squares in uOcc3S). Code 0: no data there.
uniform sampler2D uOcc0, uOcc3;
uniform vec4 uOccG;            // L0: yaw0, el top, ppd, block width (texels)
uniform vec4 uOccH;            // L0 block height, on (0 / 1), ground tolerance (m), near limit (m: the near layer's)
uniform vec4 uOcc3G;           // L3: yaw0, el top, tile px, slots per row
uniform ivec4 uOcc3S;          // L3 slots of tiles (i0, j0), (i0 + 1, j0), (i0, j0 + 1), (i0 + 1, j0 + 1); -1 none
uniform ivec2 uOcc3T;          // i0, j0
// one texel's verdict for a point at dist along a ray dipping sinA, zf m over its own road: 1 shows, 0 hidden, -1 no data.
// A surface in front hides it unless it lies within the ground tolerance of its road (the rendered ground vs the
// lanes' heights); the leaves in front hide their coverage of it; the near layer (< uOccH.w) is the near test's.
// (DYS-161 memory: the two-channel textures, RG8: sol R, G the depth; tre R the gap, G the leaves' coverage, which was
// sol's B in the RGB files)
float occTexel(vec2 sol, vec2 tre, float dist, float sinA, float zf) {
  float qs = floor(sol.r * 255.0 + 0.5) * 256.0 + floor(sol.g * 255.0 + 0.5);
  if (qs < 0.5) return -1.0;
  float Ds = 10.0 * pow(6000.0, qs / 65535.0);
  // (the trees: R the root of their gap in front of the solid, in depth codes; 0 none)
  float gq = floor(tre.r * 255.0 + 0.5);
  float Dt = gq < 0.5 ? -1.0 : 10.0 * pow(6000.0, max(qs - gq * gq, 0.0) / 65535.0);
  float gap = max(uOccH.z - zf, 0.0) / sinA;          // how far in front of it the ground may still be its own road
  float v = (Ds >= uOccH.w && Ds < dist * 0.9997 - gap) ? 0.0 : 1.0;
  if (Dt > 0.0 && Dt >= uOccH.w && Dt < dist * 0.9997 - gap) v *= 1.0 - tre.g;
  return v;
}
float occAtL0(ivec2 t, float dist, float sinA, float zf) {
  int bw = int(uOccG.w), bh = int(uOccH.x);
  if (t.y < 0 || t.y >= bh || t.x < 0 || t.x >= 2 * bw) return -1.0;
  int h = t.x >= bw ? 1 : 0;
  ivec2 ps = ivec2(t.x - h * bw, t.y + h * bh), pt = ivec2(ps.x, ps.y + 2 * bh);
  return occTexel(texelFetch(uOcc0, ps, 0).rg, texelFetch(uOcc0, pt, 0).rg, dist, sinA, zf);
}
float occAtL3(vec2 ye, ivec2 o, float dist, float sinA, float zf) {
  // the texel's square, then its slot among the item's four
  float tp = uOcc3G.z, td = 1.0;
  vec2 g = vec2((ye.x - uOcc3G.x) / td, (uOcc3G.y - ye.y) / td);
  ivec2 ij = ivec2(floor(g));
  ivec2 k = ij - uOcc3T;
  if (k.x < 0 || k.x > 1 || k.y < 0 || k.y > 1) return -1.0;
  int sl = k.y == 0 ? (k.x == 0 ? uOcc3S.x : uOcc3S.y) : (k.x == 0 ? uOcc3S.z : uOcc3S.w);
  if (sl < 0) return -1.0;
  int spr = int(uOcc3G.w), sw = int(tp) + 4;
  ivec2 base = ivec2((sl % spr) * sw, (sl / spr) * 2 * sw) + 2;
  ivec2 px = clamp(ivec2(floor((g - vec2(ij)) * tp)) + o, ivec2(-2), ivec2(int(tp) + 1));
  return occTexel(texelFetch(uOcc3, base + px, 0).rg, texelFetch(uOcc3, base + px + ivec2(0, sw), 0).rg, dist, sinA, zf);
}
// how much of a point at dist along direction v from the panorama eye shows (bilinear over the four nearest texels:
// an edge cut at the texel's own precision), zf m over its road; -1 where the occluders hold no data
float occlVis(vec3 v, float dist, float zf) {
  if (uOccH.y < 0.5) return -1.0;
  vec2 ye = yawEl(v);
  float sinA = max(-v.y, 0.004);
  float ppd = uOccG.z;
  bool l3 = uOcc3S.x >= 0 || uOcc3S.y >= 0 || uOcc3S.z >= 0 || uOcc3S.w >= 0;
  if (l3) {
    vec2 f = fract(vec2((ye.x - uOcc3G.x), (uOcc3G.y - ye.y)) * uOcc3G.z - 0.5);
    ivec2 d0 = ivec2(floor(f + 0.5)) - 1;   // (the texel centres around the point: offsets -1 / 0 then 0 / +1)
    float s = 0.0, w = 0.0;
    for (int q = 0; q < 4; q++) {
      ivec2 o = ivec2(q & 1, q >> 1);
      float wq = (o.x == 0 ? 1.0 - f.x : f.x) * (o.y == 0 ? 1.0 - f.y : f.y);
      float r = occAtL3(ye, d0 + o, dist, sinA, zf);
      if (r >= 0.0) { s += r * wq; w += wq; }
    }
    if (w > 0.5) return s / w;
  }
  vec2 p = vec2(ye.x - uOccG.x, uOccG.y - ye.y) * ppd - 0.5;
  ivec2 i0 = ivec2(floor(p));
  vec2 f = p - vec2(i0);
  float s = 0.0, w = 0.0;
  for (int q = 0; q < 4; q++) {
    ivec2 o = ivec2(q & 1, q >> 1);
    float wq = (o.x == 0 ? 1.0 - f.x : f.x) * (o.y == 0 ? 1.0 - f.y : f.y);
    float r = occAtL0(i0 + o, dist, sinA, zf);
    if (r >= 0.0) { s += r * wq; w += wq; }
  }
  return w > 0.5 ? s / w : -1.0;
}
// the street traffic's visibility: the 16-bit occluders where they hold data (and the near layer, parallaxed, in front
// of them), else the backdrop's sharp depth as before (kRel: that test's margin)
float trafficVis(vec3 ray, vec3 v, float dist, float zf, float kRel) {
  float od = occluderDist(ray);
  float o16 = occlVis(v, dist, zf);
  if (o16 < 0.0) return od < dist * kRel ? 0.0 : 1.0;
  return od < min(dist, uOccH.w) ? 0.0 : o16;
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
  vec2 lp = vec2(g + (yaw - colYaw) * ppd, g + (uBand.y - el) * ppd);
  vec3 L = tapLv(uLights, lp, uSizeX.xy, float(s), ppd).rgb;
  float X = 0.0;
  if (uXOn > 0.5) {
    int sx = pick(uSlotLx[col], m);
    if (sx >= 0) X = tapLv(uLights, lp, uSizeX.xy, float(sx), ppd).r * xDial(m);
  }
  if (L.r + L.g + L.b < 0.002 && X <= 0.0) return vec3(0.0);
  float tv, w, lamp;
  // (v3/zoom-sharp) magnified until a clock cell (1/28 deg) spans 2-3 screen px, its windows and lamps are read between
  // the four nearest cells' centres (bilinear), so a cell switched off is no hard square; the TV tint is the pixel's
  // own cell's. At 1x (uSmooth 0) one cell, as before.
  float kc = uSmooth * (1.0 - smoothstep(0.35, 0.5, 28.0 * gDegPerPx));
  if (kc > 0.0) {
    vec2 q = vec2((uBand.y - el) * 28.0, (yaw - uPano.x) * 28.0) - 0.5, q0 = max(floor(q), vec2(0.0)), fq = clamp(q - q0, 0.0, 1.0);
    float ws[4], ls[4];
    for (int k = 0; k < 4; k++) {
      uint ck = uint(q0.x + float(k >> 1)) * 65536u + uint(q0.y + float(k & 1));
      float tk;
      ws[k] = cityWindow(ck, tk);
      ls[k] = lampLevel(ck);
    }
    uint cell = uint(floor((uBand.y - el) * 28.0)) * 65536u + uint(floor((yaw - uPano.x) * 28.0));
    float w1 = cityWindow(cell, tv), l1 = lampLevel(cell);
    w = mix(w1, mix(mix(ws[0], ws[1], fq.y), mix(ws[2], ws[3], fq.y), fq.x), kc);
    lamp = mix(l1, mix(mix(ls[0], ls[1], fq.y), mix(ls[2], ls[3], fq.y), fq.x), kc);
  } else {
    uint cell = uint(floor((uBand.y - el) * 28.0)) * 65536u + uint(floor((yaw - uPano.x) * 28.0));
    w = cityWindow(cell, tv);
    lamp = lampLevel(cell);
  }
  float gw = mix(1.0, w, uLtOn.w), gl = mix(1.0, lamp, uLtOn.w), gf = mix(1.0, uLtOn.z, uLtOn.w);
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
  gDegPerPx = degPerPx;
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
  vec3 ray = pixelRay();
  float fog = maskAt(ye.x, ye.y).b * uFog;
  float vis = trafficVis(ray, ray, vDist, 0.7, 0.97) * (1.0 - clamp(fog, 0.0, 1.0));
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
// (DYS-149: the two cells' rectangles a smooth varying in atlas px, rounded in HULL_FS, not a flat one in uv. ANGLE's
// Metal backend (WebKit: every iPhone) rewrites the indices of every draw of a program with a flat varying (the GL's
// provoking vertex is a triangle's last, Metal's its first): the ships' and the street vehicles' draws, every frame.
// Every attribute here is per instance (outside.js vaoHull, vaoCar: divisor 1), so all four corners of a sprite carry
// the same rectangle, and its cells are whole atlas px (boats.json, cars.json: the full set's px on every tier, uAtlas
// the full set's size): floor(x + 0.5) gives back the very numbers, divided by uAtlas as before. outside.js
// ?flatvary=1: flat again, to compare)
out vec4 vR0, vR1;                    // the two cells' rectangles (atlas px): nothing is read outside its own cell
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
  vR0 = vec4(aCell0.xy, aCell0.xy + aCell0.zw);
  vR1 = vec4(aCell1.xy, aCell1.xy + aCell1.zw);
  vInfo = vec4(aMore.x, aMore.z, aPos.w, refl + 2.0 * mir);
  vLook = aLook; vSun = aSun; vDir = aDir; vWarp = aWarp; vLivery = aLivery;
}`;

export const HULL_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vT0, vT1;
in vec4 vR0, vR1;              // (atlas px, the same at every corner: rounded below)
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
  vec4 r0 = floor(vR0 + 0.5) / uAtlas.xyxy, r1 = floor(vR1 + 0.5) / uAtlas.xyxy;   // (DYS-149: uv, as the flat ones were)
  vec4 a0 = texture(uAlb, t0) * (inRect(t0, r0) * (1.0 - blend));
  vec4 a1 = texture(uAlb, t1) * (inRect(t1, r1) * blend);
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
  vec3 ray = pixelRay();
  float vis = trafficVis(ray, ray, vInfo.z, 0.5, 0.95);
  float fog = maskAt(ye.x, ye.y).b * uFog;
  float a = al.a * vInfo.y * vis * (1.0 - clamp(fog, 0.0, 1.0)) * uFx;
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
// (DYS-149 mv-lite) source texels a tap step: 1 (the source h4, as always), 2 (h2 on a phone's moving frame: each tap
// between 2 x 2 texels, 4 x 4 in all; outside.js haloPrep). Both factors exact (x1, x2): at 1 the same numbers as before
uniform float uSpan;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel * (2.0 * uSpan);   // this target is half the source's size (a quarter at uSpan 2)
  vec3 c = vec3(0.0);
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) c += texture(uSrc, uv + (vec2(i, j) - 0.5) * uTexel * uSpan).rgb;
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

// ---------------------------------------------------------------------------------------------- street vehicles, 3D
// v3/street-traffic rebuild (grounding): the street vehicles as low-poly meshes (scripts/street_car_lod.py,
// web/live/meshes/cars-lod.bin) drawn in the live camera, one draw per vehicle, far to near, each face list already far
// to near for the view it is seen from (no depth buffer); drawn into an offscreen layer at up to 2x (outside.js
// drawCars3d) and averaged down onto the window, so their edges are smoothed as the photograph's are.
// Each vehicle sits on the road (the path's height, corrected to the panorama's own road: street_routes.py), along its
// lane and pitched to its slope; lit by the moment's sun and sky (the panorama's own colours: its white walls, its
// high sky, the air), with a clearcoat and glass that take the sky; hazed toward the panorama behind it, faded by the
// fog, and hidden wherever the panorama shows something nearer (the ships' per-pixel test). Its soft contact shadow and,
// in sun, its cast shadow are quads on the road under it (uShadow), drawn just before it.
export const CAR3D_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aPos;    // model mm: x right, y forward, z up (wheels on z = 0); the shadow quad: corners +-1000
layout(location = 1) in vec4 aNrm;    // model normal (int8, normalized)
layout(location = 2) in vec4 aCol;    // sRGB; A: the class / 255 (street_car_lod.py)
#ifndef INST
uniform mat4 uMVP;                    // model metres -> the layer's clip space
uniform mat3 uRot;                    // model -> room frame
uniform float uShadow;                // 1: the contact shadow's quad, 2: the cast shadow's (vQ: its road point, model m)
uniform vec4 uQuadA, uQuadB;          // its centre (x, y) and axis a (z, w); axis b (x, y)
uniform vec4 uCar;                    // distance (m), ... (CAR3D_FS)
uniform vec3 uDir;                    // the panorama eye's direction to the vehicle (room frame)
#else
// (DYS-149 smooth: the program instanced (outside.js, INST defined): one draw for many vehicles' shadow quads or
// bodies. What the per-vehicle uniforms above carried comes from the draw's instance record instead, a row of uInst
// (RGBA32F, texelFetch: the very floats uniform4f would have set), row uInstBase + gl_InstanceID, into globals of the
// same names, so main() is the same code. A record's texels (outside.js INST_TEXELS): 0-3 uMVP's columns; 4-6 uRot's
// columns (w: uShadow, uErase, 0); 7 uDir; 8 uCar; 9 uCar2; 10 uLook; 11 uPaint; 12 uGlintCar; 13 uShA; 14 uShB;
// 15 uShC; 16 uQuadA; 17 uQuadB; 18 uOcc3S; 19 uOcc3T. The fragment shader reads its own from the row the vertex
// shader passes on as a smooth varying (every corner the same: rounded there, as the class is; no flat varying, VG1))
uniform highp sampler2D uInst;
uniform int uInstBase;
out float vInstF;
mat4 uMVP;
mat3 uRot;
float uShadow;
vec4 uQuadA, uQuadB;
vec4 uCar;
vec3 uDir;
#endif
out vec3 vN;
out vec3 vCol;
out vec2 vQ;
out vec4 vPe;                         // the point from the panorama eye (room frame), its height over the road (m)
out float vAo;                        // its ambient occlusion (v2: the normal's spare byte, 0 dark .. 1 open)
// (DYS-161 memory, VG1: the class a smooth varying, rounded here, not a flat one. ANGLE's Metal backend (WebKit: every
// iPhone) rewrites the indices of every draw of a program with a flat varying (the GL's provoking vertex is a
// triangle's last, Metal's its first): ~500 draws a frame at full zoom, and the GPU process kept ~330 MB more. Every
// triangle of cars-lod-v2 has its three corners in one class, so the smooth one is that class all over it, as the flat
// one was; the shadow quads (no aCol: 0, 0, 0, 1) 255 at every corner. outside.js ?carflat=1: flat again, to compare)
out float vClsF;
uniform float uAo;                    // 1: the meshes carry their AO (cars-lod-v2)
void main() {
#ifdef INST
  int ii = uInstBase + gl_InstanceID;
  uMVP = mat4(texelFetch(uInst, ivec2(0, ii), 0), texelFetch(uInst, ivec2(1, ii), 0), texelFetch(uInst, ivec2(2, ii), 0), texelFetch(uInst, ivec2(3, ii), 0));
  vec4 r0 = texelFetch(uInst, ivec2(4, ii), 0), r1 = texelFetch(uInst, ivec2(5, ii), 0), r2 = texelFetch(uInst, ivec2(6, ii), 0);
  uRot = mat3(r0.xyz, r1.xyz, r2.xyz);
  uShadow = r0.w;
  uDir = texelFetch(uInst, ivec2(7, ii), 0).xyz;
  uCar = texelFetch(uInst, ivec2(8, ii), 0);
  uQuadA = texelFetch(uInst, ivec2(16, ii), 0);
  uQuadB = texelFetch(uInst, ivec2(17, ii), 0);
  vInstF = float(ii);
#endif
  vec3 p = aPos.xyz * 0.001;
  vQ = aPos.xy * 0.001;
  if (uShadow > 0.5) { p = vec3(uQuadA.xy + vQ.x * uQuadA.zw + vQ.y * uQuadB.xy, 0.02); vQ = p.xy; }
  gl_Position = uMVP * vec4(p, 1.0);
  vPe = vec4(uDir * uCar.x + uRot * p, p.z);
  // (the room's camera clips at a far plane metres away: the vehicles, 0.5-5 km out, get their own depth instead, the
  // log of their distance along the view (clip w) over 1 m - 100 km, for the layer's depth buffer)
  gl_Position.z = (log2(max(gl_Position.w, 1.0)) / 16.61 * 2.0 - 1.0) * gl_Position.w;
  vN = uRot * aNrm.xyz;
  // (a uint8 read as a normalized int8: 128..255 come in negative)
  float ao8 = aNrm.w * 127.0;
  vAo = mix(1.0, (ao8 < -0.5 ? ao8 + 256.0 : ao8) / 255.0, uAo);
  vCol = aCol.rgb;
  vClsF = floor(aCol.a * 255.0 + 0.5);
}`;

export const CAR3D_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 vN;
in vec3 vCol;
in vec2 vQ;
in vec4 vPe;
in float vAo;
in float vClsF;              // the class (CAR3D_VS: smooth, the same at every corner of a triangle)
out vec4 o;
${COMMON}
${PANO_GLSL}
uniform vec4 uLayer;        // screen device px of a layer px: x0, y0, 1 / scale
uniform vec3 uSunDir;       // toward the sun (room frame)
uniform vec3 uSunLin, uSkyLin, uGndLin;   // radiance from the sun, the sky above and the ground below (linear)
uniform vec3 uSkyRef, uHorRef;            // what a mirror shows looking up and toward the horizon (linear)
uniform float uCarDebug;
uniform vec3 uWall;         // the panorama's white walls in sun (linear)
uniform float uCastLow;      // DYS-109: 1 = the cast shadow fades at a low sun (the streets in the buildings' shadow), 0 = as before
uniform vec4 uCarGrade;     // DYS-104: the moment's tint (linear, luma 1) and exposure (w), after the haze
uniform float uRoofGlint;   // DYS-157: how much the clearcoat (and the glass, gloss black) mirrors the panorama's own sky at grazing angles (0 = as before)
// (DYS-149 smooth: the per-vehicle ones, together; instanced (INST), globals the instance record fills, CAR3D_VS)
#ifndef INST
uniform vec4 uCar;          // distance (m), opacity, haze mix, lamps on (0..1)
uniform vec4 uCar2;         // brake lamps (0 / 1), the fog's strength, the shadow's opacity, uFx
uniform vec3 uDir;          // the eye's direction to the vehicle (room frame)
uniform vec3 uPaint;        // the body paint (linear)
uniform float uShadow;
uniform vec4 uShA;          // the footprint's half width and half length; the cabin's (m)
uniform vec4 uShB;          // the roof's shadow offset on the road (model m: x, y), the body tier's share of the height, the cabin's centre (y)
uniform vec4 uShC;          // the open sky's share of the road's light; the tyres' half track and half wheelbase (m)
uniform float uErase;
uniform vec4 uLook;         // the picture's pixel there (m at the vehicle), the grain's strength, the sun gate (1 on)
uniform vec3 uGlintCar;     // DYS-157 round 2: this car's own clearcoat (x: 0.1 matte or dirty .. 1.15 glossy), how far its roof eases toward level (y), its height (z, m)
#else
uniform highp sampler2D uInst;
in float vInstF;
vec4 uCar, uCar2, uShA, uShB, uShC, uLook;
vec3 uDir, uPaint, uGlintCar;
float uShadow, uErase;
#endif
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
// (DYS-157 round 3, the roof glint: a face takes it only when near level, from n.y NY0 (fully from NY1), and on the
// roof proper, above ROOF0 of the car's height (fully from ROOF1); k; the cast toward the photograph's colour around the
// car; the hard cap on what it adds, x the mirrored sky's luma, eased only past KNEE of the room under it)
const float GLINT_NY0 = 0.92, GLINT_NY1 = 0.98, GLINT_ROOF0 = 0.76, GLINT_ROOF1 = 0.82;
const float GLINT_K = 4.0, GLINT_CAST = 0.1, GLINT_CAP = 0.9, GLINT_KNEE = 0.8;
// the photographed road just under the vehicle (L1, a few metres around it, sRGB): the light it stands in
vec3 roadAt(vec2 ye) {
  // (L1 comes in columns: the one the vehicle is in, as momentColour picks it)
  int col = clamp(int(floor((ye.x - uPano.x) / uPano.y)), 0, int(uPano.z) - 1);
  vec3 s = vec3(0.0);
  for (int m = 0; m < 4; m++) {
    float w = m == 0 ? uW.x : m == 1 ? uW.y : m == 2 ? uW.z : uW.w;
    if (w <= 0.0) continue;
    s += w * 0.25 * (levelColour(m, 1, col, ye.x - 0.12, ye.y - 0.05) + levelColour(m, 1, col, ye.x + 0.12, ye.y - 0.05)
                   + levelColour(m, 1, col, ye.x - 0.05, ye.y - 0.1) + levelColour(m, 1, col, ye.x + 0.05, ye.y - 0.1));
  }
  return s;
}
float boxIn(vec2 g, vec2 h, float w) { vec2 d = abs(g) - h; return 1.0 - smoothstep(-w, w, max(d.x, d.y)); }
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
#ifdef INST
  // (DYS-149 smooth: this fragment's instance record, CAR3D_VS; uOcc3S / uOcc3T, PANO_GLSL's, globals here too: the
  // instanced program's source has their uniform declarations cut, outside.js instSrc)
  int ii = int(vInstF + 0.5);
  vec4 r0 = texelFetch(uInst, ivec2(4, ii), 0), r1 = texelFetch(uInst, ivec2(5, ii), 0);
  uShadow = r0.w;
  uErase = r1.w;
  uDir = texelFetch(uInst, ivec2(7, ii), 0).xyz;
  uCar = texelFetch(uInst, ivec2(8, ii), 0);
  uCar2 = texelFetch(uInst, ivec2(9, ii), 0);
  uLook = texelFetch(uInst, ivec2(10, ii), 0);
  uPaint = texelFetch(uInst, ivec2(11, ii), 0).xyz;
  uGlintCar = texelFetch(uInst, ivec2(12, ii), 0).xyz;
  uShA = texelFetch(uInst, ivec2(13, ii), 0);
  uShB = texelFetch(uInst, ivec2(14, ii), 0);
  uShC = texelFetch(uInst, ivec2(15, ii), 0);
  uOcc3S = ivec4(texelFetch(uInst, ivec2(18, ii), 0));
  uOcc3T = ivec2(texelFetch(uInst, ivec2(19, ii), 0).xy);
#endif
  int vCls = int(vClsF + 0.5);
  vec2 sc = uLayer.xy + gl_FragCoord.xy * uLayer.z;
  vec2 ndc = (sc - uViewport.xy) / uViewport.zw * 2.0 - 1.0;
  vec4 rp = uRayM * vec4(ndc, 1.0, 1.0);
  vec3 ray = normalize(rp.xyz / rp.w);
  // what hides this point: the roofs, walls and leaves in front of it at their real edges (QA ?cardebug=2: nothing)
  float pd = length(vPe.xyz);
  float vis = uCarDebug < 1.5 || uCarDebug > 2.5 ? trafficVis(ray, vPe.xyz / pd, pd, max(vPe.w, 0.0), 0.97) : 1.0;
  // (a parked car the panorama has baked, as an eraser: what was drawn behind it goes, outside.js drawCarGroup)
  if (uErase > 0.5) { if (vis < 0.5) discard; o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  if (vis <= 0.0) discard;
  vec2 ye = yawEl(normalize(uDir));
  float fog = clamp(maskAt(ye.x, ye.y).b * uCar2.y, 0.0, 1.0);
  // in sun or in shade, as the photographed road under it is: a road in sun is ~0.21 of the white walls in sun (its
  // parked cars' road, measure_parked.py); much darker, it is in a building's shadow (most streets at golden hour) and
  // the vehicle has only the sky's light, in the colour that road shows
  vec3 rl = toLin(roadAt(ye));
  float ry = dot(rl, LUMA);
  // (a sunlit road gets the sun at its altitude, the white walls nearly face-on: at golden hour a road in sun is far
  // dimmer against them than at noon, ~0.21 there at the sun's ~42 degrees; round 1, Greenwich 17:45: every car read as
  // in shade and lost the low sun's glint on its roof, the parked cars' bright top edges)
  float litK = 0.21 * clamp(uLook.w / 0.67, 0.05, 1.0);
  float sv = uLook.z > 0.5 ? smoothstep(0.3, 0.75, ry / max(litK * dot(uWall, LUMA), 1e-4)) : 1.0;
  if (uShadow > 0.5) {
    // (edges a layer px soft, as the photograph's own shadow edges at this range)
    vec2 g = vQ, fw = fwidth(g);
    float w = max(max(fw.x, fw.y) * 0.75, 0.03), a;
    if (uShadow < 1.5) {
      // the contact shadow: dark under the body, darkest under the tyres, and a ring fading within ~0.4 m outside it
      // that only the open sky's share of the road's light feels (in sun the road beside a car is still lit)
      vec2 d = abs(g) - uShA.xy;
      float sd = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
      a = max(smoothstep(w, -w, sd) * mix(0.6, 0.8, smoothstep(0.0, -0.5, sd)), exp(-max(sd, 0.0) / 0.16) * 0.55 * uShC.x);
      a = max(a, 0.9 * (1.0 - smoothstep(0.55, 1.0, length((abs(g) - uShC.yz) / vec2(0.16, 0.32)))));
    } else {
      // the cast shadow: the body (above its ground clearance) and the cabin swept along the sun to their heights
      a = 0.0;
      for (int k = 0; k < 10; k++) {
        float f = (float(k) + 0.5) / 10.0;
        a = max(a, boxIn(g - mix(0.08, uShB.z, f) * uShB.xy, uShA.xy, w));
        a = max(a, boxIn(g - mix(uShB.z, 1.0, f) * uShB.xy - vec2(0.0, uShB.w), uShA.zw, w));
      }
    }
    // (no cast shadow from a vehicle standing in a building's shadow)
    if (uShadow > 1.5) a *= sv;
    // (DYS-109, B 29 Oct: and none at a low sun: at golden the photograph's roads are in the buildings' shadow nearly
    // everywhere, but the gate above reads them as lit (litK eased at a low sun for the glint), so with the real sizes
    // every car drew a long streak across a shaded street (CD1 17:45). As the grade's lowSun: gone below ~10 degrees,
    // ~80 % at lateafternoon, whole from the afternoon up; the contact shadow stays)
    if (uShadow > 1.5) a *= 1.0 - uCastLow * (1.0 - smoothstep(0.17, 0.5, uLook.w)) * smoothstep(0.0, 0.05, uLook.w);
    // thinned by the air as the vehicle is
    a *= uCar2.z * uCar.y * (1.0 - uCar.z) * (1.0 - fog) * uCar2.w * vis;
    o = vec4(0.0, 0.0, 0.0, a);
    return;
  }
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 v = -ray;                                      // toward the eye
  vec3 alb = vCls == 1 ? uPaint : toLin(vCol);
  // (the meshes' own part colours (box-truck bodies, liveries, trim) 45 % toward their grey, as the paints are)
  if (vCls != 1 && vCls != 3 && vCls != 4 && vCls != 2) alb = mix(alb, vec3(dot(alb, LUMA)), 0.45);
  float ndl = max(dot(n, uSunDir), 0.0);
  // (its AO darkens the sky's and the ground's light and half the sun's: the contact shade under the sills, in the
  // wheel arches and the grille; not a cast shadow, scripts/fleet/fleet_render.py)
  float ao = clamp(vAo, 0.0, 1.0);
  vec3 amb = mix(vec3(1.0), clamp(rl / max(ry, 1e-4), 0.0, 3.0), 0.6 * (1.0 - sv));
  // (in shade, the sky's light as the photographed road there has it: a grey road, albedo ~0.15, under our sky light
  // should be as bright as the road beside the car; B2, Greenwich at golden: cars p50 106 on a shaded road of 46)
  // (at night as far as the road says: under the street lamps it is many times brighter than our faint night sky
  // light; capped at 4x the bodies stayed black silhouettes on a lit road, look7b; real bodies 1.46 of the road, B2)
  amb *= mix(clamp(ry / max(0.15 * dot(uSkyLin, LUMA), 1e-5), 0.25, mix(1.25, 40.0, uCar.w)), 1.0, sv);
  vec3 c = alb * (uSunLin * ndl * (0.5 + 0.5 * ao) * sv + (uSkyLin * (0.55 + 0.45 * n.y) + uGndLin * (0.5 - 0.5 * n.y)) * ao * amb);
  // (the street lamps: at night a body takes a warm light of its own, so a mid-grey car sits about at the lit road's
  // level, ~0.14-0.17 sRGB at 4x (real cars 1.46x their road, B2). The road sampled under a car is the base layer, which
  // has no lamp pools in it (they're the lights layer), so this is set, not sampled: look8 / look9 had black bodies)
  c += alb * vec3(1.0, 0.86, 0.68) * 0.09 * uCar.w * (1.0 - sv) * ao * (0.6 + 0.4 * max(n.y, 0.0));
  // reflections: the sky above, the hazy horizon below it; Schlick's Fresnel on the clearcoat and the glass
  vec3 r = reflect(-v, n);
  vec3 env = mix(uHorRef, uSkyRef, smoothstep(-0.05, 0.35, r.y)) * (0.35 + 0.65 * smoothstep(-0.3, 0.0, r.y)) * mix(1.0, ao, 0.7);
  float fr = pow(1.0 - max(dot(n, v), 0.0), 5.0);
  float glint = pow(max(dot(r, uSunDir), 0.0), 400.0) * 6.0 * sv;
  // (DYS-157, B 29 Oct: the photographed parked cars' bright tops at golden are the sky mirrored in their clearcoat at
  // grazing angles, ~0.7 of the sky at the mirror direction whatever the road's shade (DYS-155); ours took the uniform
  // horizon colour there and read flat. wG: how much of a paint face takes the panorama's own sky at its mirror ray
  // instead (added after the grade, below): its upward faces, where the mirror ray clears the street's skyline. The
  // panorama is seen from the desk eye, well above the streets: at a low mirror elevation it shows sky where a car down
  // in the street sees the Presidio's ridge and trees, so the fade on the elevation is needed (Greenwich: the parked
  // tops fade between ~3.5 and 5 degrees); below it the uniform env as before. Off at a high sun as the grade's lowSun
  // (the sun term dominates there, and midday's look was matched without it), but not toward the horizon: the tops keep
  // ~0.7 of the sky at sunset)
  // (RG1, 30 Oct: on paint alone the roofs stayed dark: the cars' roofs are mostly glass and gloss black in the meshes
  // (the Prius's L1 roof: 21 paint vertices, 26 glass), and the photographed parked cars are clearcoat boxes. Glass and
  // gloss black are the same F0 0.04 mirror: theirs too, on their roofs and sloped screens only (n.y 0.3 -> 0.6), so
  // the side glass never draws the "ghostly" rim)
  // (RG3, 30 Oct: RG2's moving roofs still reached only a third of the parked tops. Not the sky's sample (blurred() at
  // the mirror ray reads what L1 does there, ~0.48 linear at 7 degrees up), the AO (0.96-0.99 on the roofs) or the fade
  // (Greenwich's cars sit 6-9 degrees down): the meshes' roofs curve fore and aft, and at a grazing view a face tilted t
  // toward the eye mirrors the sky 2t higher (dimmer, bluer, a lower Fresnel), tilted away it mirrors the ridge under the
  // fade, so only a sliver of each roof, its normals within ~2 degrees, took the bright low sky. The photographed parked
  // cars are level flat-topped boxes (city.py), the whole top one mirror. So the glint's mirror ray and Fresnel come off
  // the normal eased 85 % toward level (the room's up: the baked boxes sit level, ours pitch with the street); which
  // faces take it (upK) still reads the true normal)
  // (round 2, the coordinator's look 30 Oct 13:20Z: every moving roof the same near-white blob, brighter than the sunlit
  // walls. The ease is the roof's only: a face already near level (the roof's gentle curve, the bonnet's and the boot's
  // lids) eases by this car's own share (uGlintCar.y, 0.5-0.9), a steeper one keeps its own normal. Eased in full, the
  // screens tilted toward the eye mirrored the low sky too and, ~5x the roof's area on the screen at a grazing view, made
  // the whole car top pale and cooler; truly they mirror the high sky at a low Fresnel, dim, and the photographed parked
  // boxes glint only on their level tops, a band. wG here is the face's share; the car's clearcoat scales the glint)
  // (round 3, the coordinator 30 Oct after RG4b: seen from above, roof + bonnet + boot is nearly the whole silhouette, so
  // rounds 2 and 2b turned the whole car tan; the photographed parked boxes are dark bodies with one crisp bright roof
  // band. So the glint is the roof proper's only: faces near level (n.y 0.92 -> 0.98, tighter than round 2's 0.9 -> 0.97)
  // and above 0.76 -> 0.82 of the car's height (the meshes' level faces: bonnet and boot lids at 0.5-0.75 of it, the roof
  // at 0.8-1.0, every model); each eased by the car's own share; the rest keep the plain env as before)
  float wG = 0.0, frG = 0.0;
  vec2 yr = vec2(0.0);
  float topK = smoothstep(GLINT_NY0, GLINT_NY1, n.y) * smoothstep(GLINT_ROOF0, GLINT_ROOF1, vPe.w / max(uGlintCar.z, 0.5));
  if ((vCls == 1 || vCls == 2 || vCls == 8) && uRoofGlint > 0.0 && topK > 0.0) {
    vec3 nG = normalize(mix(n, vec3(0.0, 1.0, 0.0), uGlintCar.y));
    vec3 rG = reflect(-v, nG);
    if (rG.y > 0.0) {
      yr = yawEl(rG);
      frG = pow(1.0 - max(dot(nG, v), 0.0), 5.0);
      wG = uRoofGlint * topK * smoothstep(3.5, 5.0, yr.y) * (1.0 - smoothstep(0.17, 0.5, uLook.w))
         * step(uPano.x, yr.x) * step(yr.x, uPano.x + uPano.y * uPano.z);
    }
  }
  vec3 envK = env;
  if (wG > 0.0) envK *= 1.0 - wG * min(uGlintCar.x, 1.0);
  // (the clearcoat's and the glass's rim at the silhouette held to ~70 %: in full it drew a pale outline round a dark
  // car, a "ghostly" shell in round 1)
  if (vCls == 1) c += (0.04 + 0.66 * fr) * envK + (0.04 + 0.96 * fr) * uSunLin * glint;      // paint: its clearcoat
  else if (vCls == 2) c = alb * 0.2 * (uSkyLin + uGndLin) * ao + (0.04 + 0.4 * fr) * envK + (0.06 + 0.94 * fr) * uSunLin * glint;   // glass: the dark cabin, the sky on it (B2: our cars lacked a dark end, p10 80-86 vs real 36)
  else if (vCls == 5) c = c * 0.2 + alb * (env * 0.9 + uSunLin * glint * 0.5);                                // bright metal: mostly what it mirrors
  else if (vCls == 8) c += (0.045 + 0.955 * fr) * (envK + uSunLin * glint * 0.6);                          // gloss black: the sky on it
  else if (vCls == 7) c *= 0.85;                                                                              // rubber: matte, no sheen
  // the lamps at night (the points drawn over them carry the glow); brake lamps brighter
  // (soft: the lamp points drawn over them are the light; a lens bright too stacks a second lamp on each, C's re-judge)
  // (look15, 21:2x: the near tails still hard saturated pairs: the lenses a little lower and less pure too)
  if (vCls == 3) c += vec3(1.0, 0.9, 0.74) * 0.9 * uCar.w;
  if (vCls == 4) c += vec3(1.0, 0.12, 0.08) * (0.45 * uCar.w + 1.0 * uCar2.x * max(uCar.w, 0.3));
  vec3 col = toSrgb(c);
  // the picture's own fine texture on the vehicle: a grain the size of its pixel there, fixed to the body as it moves
  // (the panorama's is ~0.03 x sqrt(luma) in sRGB around its parked cars, renders/stage-qa-d/look/measure_parked.py)
  vec3 cq = floor((vPe.xyz - uDir * uCar.x) / uLook.x);
  float gn = (hash(cq.xy + cq.z * 17.17) + hash(cq.yz * 1.37 + 5.1) - 1.0) * 2.449;
  // (half the measured ~0.03: at 4x a grain cell is a 3-4 px block and read as the road's texture showing through)
  col += gn * uLook.y * 0.015 * sqrt(max(dot(col, vec3(0.2126, 0.7152, 0.0722)), 0.0));
  // (the air: 0.4 of the sprites' haze mix; in full it pulled a car a third of the way to the light road behind it, its
  // darks to 0.30 against the parked cars' 0.18 at the same distance, and read washed-out, "ghostly")
  // (the photograph's own grade on the car, as its parked cars have it: Akshay, 18:2x, the golden Lombard clip: "the
  // golden yellow falls on the city but the cars ... don't belong there". In linear light: the car's colour cast toward
  // the scene's around it (its brightness kept), more at a low sun; with the sun low its brightness pulled toward the
  // scene's, as the air does to the parked cars; and the haze full at a low sun, 0.4 of it at noon, where in full it
  // washed the cars out)
  float sUp = uLook.w, lowSun = (1.0 - smoothstep(0.17, 0.5, sUp)) * smoothstep(0.0, 0.05, sUp);
  vec3 sceneL = toLin(blurred(ye.x, ye.y));
  float sY = max(dot(sceneL, LUMA), 1e-4);
  vec3 cl = toLin(col);
  float cy = max(dot(cl, LUMA), 1e-5);
  // (the cast 0.4 at a low sun, was 0.9: B's meter put 314a21d's golden cars at ~2.4x the photographed parked cars'
  // chroma, 19:0x; their hue kept)
  // (27 Oct 19:1x, B's meter on the freeze's 0.4 against the 19 photographed parked cars at golden: ~0.05-0.08 too
  // neutral; cast 0.8 puts the tint on theirs, with the chroma taken to 0.7x so it stays ~1.0 of theirs, not ~1.4)
  cl *= mix(vec3(1.0), clamp(sceneL / sY, 0.0, 3.0), mix(0.5, 0.8, lowSun));
  cl *= cy / max(dot(cl, LUMA), 1e-5);
  cl = mix(vec3(dot(cl, LUMA)), cl, mix(1.0, 0.7, lowSun));
  cl *= mix(1.0, sqrt(sY / cy), 0.35 * lowSun);
  // (the photograph's highlights roll off: its white parked cars never reach clean white, ours did; round 3's noon look
  // judge, 4/4 at Greenwich: the white cars too bright and crisp against the parked rows. A soft shoulder above mid-light,
  // hue kept: linear 1.0 > ~0.71, below 0.5 untouched)
  float hY = max(dot(cl, LUMA), 1e-5), hK = 0.5, hW = 0.35;
  if (hY > hK) cl *= (hK + (hY - hK) / (1.0 + (hY - hK) / hW)) / hY;
  col = toSrgb(cl);
  col = mix(col, blurred(ye.x, ye.y), uCar.z * mix(0.4, 1.0, lowSun));
  // (DYS-104, B 29 Oct: the moment's grade on the car as seen, where it was measured against the photographed parked
  // cars; the lamps' lenses keep their own colour)
  if (vCls != 3 && vCls != 4) col = toSrgb(toLin(col) * uCarGrade.rgb * uCarGrade.w);
  // (DYS-157: the mirrored sky, after the grade: the panorama is already in the photograph's own light, the grade maps
  // our lit body onto it. Schlick (F0 0.04, off the eased normal) x k x the panorama at the mirror ray. Not thinned by
  // our haze (RG1 had 1 - uCar.z): DYS-155's ratio is the photograph's tops to its sky as seen, its air already in both.
  // k 1.4, DYS-155's upper estimate (RG2 had 1.1: our roofs' own light under it is ~0.01-0.03, not worth holding back
  // for); nor before the grade or the haze: at golden those take it down (the grade's gain 0.55-0.78), not up. Round 2
  // below: thinned by the haze after all, k 2.2 under a soft cap)
  // (round 2, the coordinator's look 30 Oct 13:20Z: "identical bright white blobs, brighter than the sunlit facades".
  // Measured on RG3's stills (Greenwich 4x, each car's pixels over 0.08 linear, their brightest quarter): the parked tops
  // 17:45 median 0.29 (p10 0.12, p90 0.36), sRGB g/r 0.88, b/r 0.66, ~56 px a car; round 1's moving tops 0.30-0.35 with
  // little spread, 0.92 / 0.74, 150-270 px. Now: this car's clearcoat (uGlintCar.x: a share matte, most mid, a few
  // glossy); thinned by the air as the body is (the haze took the body that far toward the picture behind it); cast
  // GLINT_CAST toward the photograph's own colour around the car, as the body is (more); k 2.2 and what it adds held
  // softly under GLINT_CAP x the sky it mirrors over the body (the photograph's tops reach ~0.7-0.85 of theirs, DYS-155):
  // the glossiest roofs level off there, the rest by their clearcoat; on a white car it adds little, on a dark one
  // nearly all, as a clearcoat shows over each. Simulated on the meshes (sim5.py, 80 cars, 17:45 / 18:05): the tops'
  // brightest quarter p10 / median / p90 ~0.12 / 0.20 / 0.28, sRGB g/r 0.87 / 0.81, b/r 0.67 / 0.65, ~40 % of round
  // 1's bright area. Round 3 (the roof proper only, k 4, the cap at the sky itself eased past 0.8 of its room, no wall
  // guard; sim6.py, 80 cars, 17:45 / 18:05): 0.15 / 0.21 / 0.36-0.37 as the sim reads it (it read rounds 2 / 2b ~1.25x
  // the stills), the glint on 15-16 % of a car's silhouette (2b: ~40 %), the same colour)
  if (wG > 0.0) {
    vec3 skG = toLin(blurred(yr.x, yr.y)), cb = toLin(col);
    // (its colour: the low sky a level top mirrors, as the photographed parked boxes' tops do, at the brightness of this
    // face's own mirror: a roof that curves mirrors a higher, paler and bluer sky over part of it, which read white)
    vec2 yl = yawEl(reflect(-v, vec3(0.0, 1.0, 0.0)));
    vec3 skL = toLin(blurred(yl.x, max(yl.y, 5.0)));
    skG = skL * (dot(skG, LUMA) / max(dot(skL, LUMA), 1e-5));
    vec3 g = wG * uGlintCar.x * mix(1.0, ao, 0.7) * (0.04 + 0.96 * frG) * GLINT_K * skG;
    g *= 1.0 - uCar.z * mix(0.4, 1.0, lowSun);
    float gy = dot(g, LUMA);
    g *= mix(vec3(1.0), clamp(sceneL / sY, 0.0, 3.0), GLINT_CAST);
    g *= gy / max(dot(g, LUMA), 1e-6);
    // (round 3: no guard on the white walls in sun (rounds 2 / 2b had 0.8x / 1.2x: that statistic is low at golden, 0.27
    // / 0.18 at 0.8x, and held every roof to about half the parked tops, which are brighter than it); the hard cap is the
    // mirrored sky's alone, at 0.9x it (RG5's 1.0x: white cars' roofs went cream, 5 of ~30 over the parked p90), and the
    // glint passes as it is up to GLINT_KNEE of the room under it (round 2's tanh eased it from the start), only above
    // that eased into the cap. k 4 (round 2: 2.2): a roof band is short, ~1.5-2 m against the baked boxes' 4 m flat tops,
    // and the 4x still's blur takes it down, so most clearcoats run up to the cap and the matte ones stay dim)
    float room = max(GLINT_CAP * dot(skG, LUMA) - dot(cb, LUMA), 1e-3), kn = GLINT_KNEE * room;
    float gy2 = gy <= kn ? gy : kn + (room - kn) * tanh(min((gy - kn) / max(room - kn, 1e-4), 10.0));
    g *= gy2 / max(gy, 1e-6);
    col = toSrgb(cb + g);
  }
  // solid, never see-through: its fades (the fog, its arrival) go toward the picture's own colour behind it; only the
  // occluders' edges are alpha (and a fade's last 15%, so nothing is left where it was)
  // (the street's own soft fade, now a short step: the 16-bit occluders hide a car at the real edge, so a car half faded
  // on seen road only read as see-through)
  float fade = smoothstep(0.3, 0.7, uCar.y) * (1.0 - fog) * uCar2.w;
  col = mix(blurred(ye.x, ye.y), col, fade);
  if (uCarDebug > 2.5) col = mix(vec3(0.1, 0.3, 1.0), vec3(1.0, 0.2, 0.1), sv);   // (QA ?cardebug=3: in sun red, in shade blue)
  else if (uCarDebug > 0.5) col = vec3(1.0, 0.0, 1.0);   // (QA ?cardebug=1: where the 3D vehicles are)
  float a = vis * smoothstep(0.0, 0.15, fade);
  o = vec4(col * a, a);
}`;

// the vehicles' layer back onto the window through a Gaussian as wide as the photograph's own blur there (uMap.w, window
// px: outside.js drawCars3d), so their edges are as soft as the picture's at every magnification
export const CARLAYER_VS = `#version 300 es
precision highp float;
uniform vec4 uRect;         // the layer's box on the window: x0, y0, w, h (device px)
uniform vec2 uSize;         // the drawing buffer (device px)
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  gl_Position = vec4((uRect.xy + c * uRect.zw) / uSize * 2.0 - 1.0, 0.0, 1.0);
}`;
export const CARLAYER_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec4 uRect;
uniform vec4 uMap;          // layer texels per window px (scale), the layer texture's size (w, h), the blur's sigma (window px)
out vec4 o;
void main() {
  vec2 p = (gl_FragCoord.xy - uRect.xy) * uMap.x;
  vec2 t = 1.0 / uMap.yz;
  float sg = uMap.w * uMap.x;   // (in layer px)
  // 5 x 5 taps 0.75 sigma apart (bilinear between texels): smooth enough not to double an edge at any width
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    float w = exp(-0.28125 * float(i * i + j * j));
    acc += w * texture(uSrc, (p + vec2(float(i), float(j)) * 0.75 * sg) * t);
    ws += w;
  }
  o = acc / ws;
}`;
