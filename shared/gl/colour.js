// The colour path (plan 2.5), run once per displayed frame on the averaged linear light, the way Cycles orders it:
//   linear x 2^exposure -> AgX table (Blender's own, scripts/bake/tone_lut.py) -> grade() as scripts/build_web.py
//   -> the moment's 3x4 colour matrix -> +-0.5/255 dither
// and laid over the outside with the room's coverage. The same shader also writes the frozen copy of the room
// layer that light changes fade from (mode 1).
import * as THREE from "three";
import { fullscreenMaterial } from "./context.js";
import { loadLut } from "./loader.js";

const GRADE_URL = new URL("../grade.json", import.meta.url).href;

// DYS-11 (Akshay, 30 Oct): at night a camera keeps the lamp's warm colour, so the white walls read skin/tan; eyes adapt
// and see a warm white, and his bar is what eyes see. A von Kries adaptation in CAT16's cone space, in linear light, on
// the room's picture only (the outside is not lamp-lit and keeps its own grade): the lamp's white moves a share D of the
// way to a white of the same luminance; what is warmer than it (the lamp's pool on the walnut, the shade) stays warmer.
// The most D (at a fully lamp-lit moment) is 0.5, Akshay's pick (DYS-11, 30 Oct); ?nightwb=<0..1> overrides (0: off).
const NIGHT_WB = (() => {
  const v = typeof location !== "undefined" ? parseFloat(new URLSearchParams(location.search).get("nightwb")) : NaN;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
})();
const RGB2XYZ = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041];
const CAT16 = [0.401288, 0.650173, -0.051461, -0.250268, 1.204414, 0.045854, -0.002079, 0.048952, 0.953127];
/** The 3x3 (linear Rec.709) that adapts `white` a share D toward the neutral white of its own luminance. */
export function catMatrix(white, D) {
  const out = new THREE.Matrix3();
  if (!(D > 0)) return out;
  const A = new THREE.Matrix3().set(...CAT16).multiply(new THREE.Matrix3().set(...RGB2XYZ));   // RGB -> LMS
  const w = new THREE.Vector3(...white), Y = 0.2126729 * w.x + 0.7151522 * w.y + 0.072175 * w.z;
  const lw = w.clone().applyMatrix3(A), lr = new THREE.Vector3(Y, Y, Y).applyMatrix3(A);
  const g = new THREE.Matrix3().set(D * lr.x / lw.x + 1 - D, 0, 0, 0, D * lr.y / lw.y + 1 - D, 0, 0, 0, D * lr.z / lw.z + 1 - D);
  return out.copy(A).invert().multiply(g).multiply(A);
}
const LUT_URL = new URL("./agx-lut", import.meta.url).href;

const FS = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler2D uAccum;      // premultiplied linear light, a sum of uCount samples
uniform float uCount;
uniform sampler3D uLut;
uniform vec3 uShaper;          // lo, hi (stops), table size
uniform float uExposure;       // 2^stops
uniform vec4 uGrade;           // contrast, saturation, gamma, warmth
uniform vec3 uLuma;
uniform mat3 uMatrix;
uniform vec3 uOffset;
uniform vec4 uSwitch;          // lut, grade, matrix, dither
uniform sampler2D uFrozen;     // premultiplied display-space room layer
uniform float uFrozenW;
uniform float uRoomW;          // v3/zoom-r3: the room's weight over the outside (1 as always; it fades out while zoomed)
uniform float uMode;           // 0: room layer over the outside; 1: write the room layer for the frozen copy
uniform vec4 uHaze;            // the air in front of the window: opacity per unit of light, most opacity, the veil's level, on
uniform mat3 uCat;             // DYS-11: the eye's partial adaptation to the lamp's white (identity: none; Colour.setAdaptation)
in vec2 vUv;
out vec4 outColor;

vec3 srgbOetf(vec3 x) {
  x = clamp(x, 0.0, 1.0);
  return mix(x * 12.92, 1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, x));
}
vec3 agx(vec3 x) {
  vec3 s = clamp((log2(max(x, exp2(uShaper.x))) - uShaper.x) / (uShaper.y - uShaper.x), 0.0, 1.0);
  float n = uShaper.z;
  return texture(uLut, s * ((n - 1.0) / n) + 0.5 / n).rgb;
}
// scripts/build_web.py grade(), one for one (constants in web/shared/grade.json)
vec3 grade(vec3 rgb) {
  rgb = pow(clamp(rgb, 0.0, 1.0), vec3(uGrade.z));
  rgb = 0.5 + (rgb - 0.5) * uGrade.x;
  float l = dot(rgb, uLuma);
  rgb = l + (rgb - l) * uGrade.y;
  return rgb * vec3(1.0 + uGrade.w, 1.0, 1.0 - uGrade.w);
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

vec3 toDisplay(vec3 c) {
  c = uSwitch.x > 0.5 ? agx(c) : srgbOetf(c);
  if (uSwitch.y > 0.5) c = grade(c);
  if (uSwitch.z > 0.5) c = uMatrix * c + uOffset;
  return c;
}

void main() {
  vec4 s = texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0);
  float alpha = clamp(s.a / max(uCount, 1.0), 0.0, 1.0);
  vec3 lin = s.a > 1e-6 ? s.rgb / s.a : vec3(0.0);
  vec3 c = toDisplay(max(uCat * lin, 0.0) * uExposure);
  // the air in front of the window (beams.js: light where no room surface is) as a veil over the outside, the way
  // Cycles' transparent film gives it: the scattered light's hue at a fixed level, at an opacity that follows its amount
  if (s.a <= 1e-6 && uHaze.w > 0.5) {
    vec3 H = s.rgb / max(uCount, 1.0) * uExposure;
    float l = dot(H, uLuma);
    if (l > 0.0) {
      alpha = clamp(uHaze.x * l, 0.0, uHaze.y);
      c = toDisplay(H / l * uHaze.z);
    }
  }
  if (uSwitch.w > 0.5) {
    vec2 p = gl_FragCoord.xy;
    c += (vec3(ign(p), ign(p + 17.0), ign(p + 41.0)) - 0.5) / 255.0;
  }
  c = clamp(c, 0.0, 1.0);
  vec4 room = vec4(c * alpha, alpha);
  // the frozen frame of a light change (both modes: a change during a fade freezes what is on screen)
  if (uFrozenW > 0.0) room = mix(room, texelFetch(uFrozen, ivec2(gl_FragCoord.xy), 0), uFrozenW);
  outColor = room * uRoomW;
}`;

const COPY_FS = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }`;

// perf-r2: the canvas from a moving frame's smaller picture (uPrev, scaled up with linear filtering), or at a landing
// the full picture (uSrc, read 1:1) crossfaded in from it (uPrevW: the moving picture's weight, 1 to 0)
// v3/shimmer: the moving picture has no anti-aliasing (the still frame's accumulation does that), so long shallow edges
// (the window sill's) are staircases whose steps crawl as the view moves (the coordinator's repro, 28 Oct 11:4x). FXAA
// (Lottes' compact form) on the moving picture, at its own resolution, smooths them; still frames don't come here.
// uFxaa 0 turns it off (?fxaa=0, to compare)
const PRESENT_FS = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uPrev;
uniform float uPrevW;
uniform float uFxaa;
in vec2 vUv;
out vec4 outColor;
float lumaOf(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec4 fxaa(vec2 uv) {
  vec2 rcp = 1.0 / vec2(textureSize(uPrev, 0));
  vec4 m = texture(uPrev, uv);
  float lNW = lumaOf(texture(uPrev, uv + vec2(-1.0, -1.0) * rcp).rgb), lNE = lumaOf(texture(uPrev, uv + vec2(1.0, -1.0) * rcp).rgb);
  float lSW = lumaOf(texture(uPrev, uv + vec2(-1.0, 1.0) * rcp).rgb), lSE = lumaOf(texture(uPrev, uv + vec2(1.0, 1.0) * rcp).rgb);
  float lM = lumaOf(m.rgb);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.25 * (1.0 / 8.0), 1.0 / 128.0);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), vec2(-8.0), vec2(8.0)) * rcp;
  vec3 a = 0.5 * (texture(uPrev, uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(uPrev, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(uPrev, uv - dir * 0.5).rgb + texture(uPrev, uv + dir * 0.5).rgb);
  float lB = lumaOf(b);
  return vec4((lB < lMin || lB > lMax) ? a : b, m.a);
}
void main() {
  vec4 p = uFxaa > 0.5 ? fxaa(vUv) : texture(uPrev, vUv);
  outColor = uPrevW >= 1.0 ? p : mix(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0), p, uPrevW);
}`;

export class Colour {
  constructor() {
    this.uniforms = {
      uAccum: { value: null },
      uCount: { value: 1 },
      uLut: { value: null },
      uShaper: { value: new THREE.Vector3(-11, 7, 33) },
      uExposure: { value: 1 },
      uGrade: { value: new THREE.Vector4(1, 1, 1, 0) },
      uLuma: { value: new THREE.Vector3(0.2126, 0.7152, 0.0722) },
      uMatrix: { value: new THREE.Matrix3() },
      uOffset: { value: new THREE.Vector3() },
      uSwitch: { value: new THREE.Vector4(1, 1, 1, 1) },
      uFrozen: { value: null },
      uFrozenW: { value: 0 },
      uRoomW: { value: 1 },
      uMode: { value: 0 },
      // fitted to R1's golden stills (desk, shelf): their veil over the opening is near even, opacity 0.017 mean in a
      // straight colour of about (0.91, 0.86, 0.79); 0.2 x the light gives 0.014-0.026 there
      uHaze: { value: new THREE.Vector4(0.2, 0.05, 1.6, 0) },
      uCat: { value: new THREE.Matrix3() },
    };
    this.composite = fullscreenMaterial(FS, this.uniforms, {
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      transparent: true,
    });
    this.composite.name = "composite";
    this.snapshot = this.composite.clone();
    this.snapshot.uniforms = this.uniforms;      // same values, no blending
    this.snapshot.blending = THREE.NoBlending;
    this.snapshot.transparent = false;
    this.snapshot.name = "composite:snapshot";
    this.copyUniforms = { uSrc: { value: null } };
    this.copy = fullscreenMaterial(COPY_FS, this.copyUniforms, { blending: THREE.NoBlending });
    this.copy.name = "copy";
    const fx = typeof location !== "undefined" ? new URLSearchParams(location.search).get("fxaa") : null;
    this.presentUniforms = { uSrc: { value: null }, uPrev: { value: null }, uPrevW: { value: 1 }, uFxaa: { value: fx === "0" ? 0 : 1 } };
    this.present = fullscreenMaterial(PRESENT_FS, this.presentUniforms, { blending: THREE.NoBlending });
    this.present.name = "present";
    this.matrices = new Map();
    this.meta = null;
    this.nightWB = NIGHT_WB;
    this.adaptWhite = [1, 0.7, 0.42];
    this.lampShare = 0;
  }

  async load() {
    const [{ texture, meta }, grade] = await Promise.all([loadLut(LUT_URL), fetch(GRADE_URL).then((r) => r.json())]);
    this.uniforms.uLut.value = texture;
    this.uniforms.uShaper.value.set(meta.shaper.lo, meta.shaper.hi, meta.size);
    this.uniforms.uLuma.value.fromArray(grade.luma);
    this.meta = meta;
    return meta;
  }

  /** A moment's exposure (stops), grade() settings and 3x4 matrix (row-major: 3 rows of m0 m1 m2 offset). */
  setMoment({ exposure = 0, grade = {}, matrix = null }) {
    this.uniforms.uExposure.value = 2 ** exposure;
    this.uniforms.uGrade.value.set(grade.contrast ?? 1, grade.saturation ?? 1, grade.gamma ?? 1, grade.warmth ?? 0);
    this.setMatrix(matrix || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  }

  /**
   * DYS-11: the room's picture adapted toward the lamp's white, as eyes do in a lamp-lit room (a camera keeps the cast:
   * white walls read tan). `white`: the lamp's colour (bake.json lamp.colour, linear); `share`: how lamp-lit the moment
   * is, 0..1 (engine.js _lampShare). The degree is nightWB x share (0.5 by default; ?nightwb=0..1).
   */
  setAdaptation({ white, share } = {}) {
    if (white) this.adaptWhite = white;
    if (share !== undefined) this.lampShare = share;
    this.uniforms.uCat.value.copy(catMatrix(this.adaptWhite, this.nightWB * this.lampShare));
  }

  setMatrix(m) {
    if (m.length !== 12) throw new Error("colour matrix: 12 numbers, three rows of (r, g, b, offset)");
    this.uniforms.uMatrix.value.set(m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]);
    this.uniforms.uOffset.value.set(m[3], m[7], m[11]);
  }
}
