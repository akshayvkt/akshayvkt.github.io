// The colour path (plan 2.5), run once per displayed frame on the averaged linear light, the way Cycles orders it:
//   linear x 2^exposure -> AgX table (Blender's own, scripts/bake/tone_lut.py) -> grade() as scripts/build_web.py
//   -> the moment's 3x4 colour matrix -> +-0.5/255 dither
// and laid over the outside with the room's coverage. The same shader also writes the frozen copy of the room
// layer that light changes fade from (mode 1).
import * as THREE from "three";
import { fullscreenMaterial } from "./context.js";
import { loadLut } from "./loader.js";

const GRADE_URL = new URL("../grade.json", import.meta.url).href;
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
uniform float uMode;           // 0: room layer over the outside; 1: write the room layer for the frozen copy
uniform vec4 uHaze;            // the air in front of the window: opacity per unit of light, most opacity, the veil's level, on
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
  vec3 c = toDisplay(lin * uExposure);
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
  outColor = room;
}`;

const COPY_FS = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }`;

// perf-r2: the canvas from a moving frame's smaller picture (uPrev, scaled up with linear filtering), or at a landing
// the full picture (uSrc, read 1:1) crossfaded in from it (uPrevW: the moving picture's weight, 1 to 0)
const PRESENT_FS = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uPrev;
uniform float uPrevW;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 p = texture(uPrev, vUv);
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
      uMode: { value: 0 },
      // fitted to R1's golden stills (desk, shelf): their veil over the opening is near even, opacity 0.017 mean in a
      // straight colour of about (0.91, 0.86, 0.79); 0.2 x the light gives 0.014-0.026 there
      uHaze: { value: new THREE.Vector4(0.2, 0.05, 1.6, 0) },
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
    this.presentUniforms = { uSrc: { value: null }, uPrev: { value: null }, uPrevW: { value: 1 } };
    this.present = fullscreenMaterial(PRESENT_FS, this.presentUniforms, { blending: THREE.NoBlending });
    this.present.name = "present";
    this.matrices = new Map();
    this.meta = null;
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

  setMatrix(m) {
    if (m.length !== 12) throw new Error("colour matrix: 12 numbers, three rows of (r, g, b, offset)");
    this.uniforms.uMatrix.value.set(m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]);
    this.uniforms.uOffset.value.set(m[3], m[7], m[11]);
  }
}
