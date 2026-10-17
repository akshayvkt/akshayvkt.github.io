// The night glass (plan 2.4, source 3): the lamp-lit room reflected in the window pane in the dark moments, as the
// photographs' glass layer has it (build.py --pass glass: a pane at z = -1.40 that mixes transparent and a sharp glossy
// by Fresnel at IOR 1.52, black outside, at the room's exposure), screen-blended over what the window shows.
//
// A virtual camera behind the pane (the main camera reflected in z = -1.40, image flipped in x) draws the room into a
// half-resolution HDR target, its near plane bent onto the pane (oblique clipping). It is redrawn on live frames (the
// camera, the lamp or the moment changed). The overlay then looks each window pixel's ray up in it where the ray meets
// the pane inside the opening, weights it by the pane's Fresnel, tone maps it with the room's exposure and AgX table,
// and screen-blends it where the room leaves the opening uncovered.
//
// It refines with the room (polish-r2): one sample of the mirror is aliased, and at the print spot the lamp's thin brass
// arms broke into two rows of dots climbing out of the bridge into the night sky. While the room refines, each of its
// samples also draws the mirror once more with the same kind of sub-pixel jitter (in the mirror's own pixels) and the
// same point on the lens, mirrored (depth of field: at the print the lamp's reflection, 2.3 m away through the pane, is
// as soft as the lens makes it), added into a second target; from 4 samples on the overlay shows their average (the
// room holds its live frame until 4 samples are in too). Both are read through a 2 x 2 tent, so a moving reflection
// does not sparkle and the faint fringe points of a bright highlight's blur merge into it. Phones (T1) take the room's
// 12 samples at half the lens's aperture: 12 points on the full blur disc drew the lamp's brass head as a ring of dots.
import * as THREE from "three";
import { SHADER_NONCE } from "./context.js";
import { jitter } from "./loop.js";

const VS = /* glsl */ `
precision highp float;
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

const FS = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler2D uGlass;        // the mirrored room, linear light (one live sample, or the refined sum)
uniform vec4 uGlassInfo;         // x: scale (1 / samples in the sum, 1 live), y: 1 for the 2 x 2 tent, zw: one texel
uniform mat4 uTexMatrix;         // room point -> mirror uv
uniform mat4 uInvViewProj;       // the main camera, unjittered
uniform vec3 uEye;
uniform vec2 uSize;
uniform vec4 uRect;              // the opening on the pane: x0, x1, y0, y1
uniform float uZ;                // the pane
uniform float uIor;
uniform float uGain;
uniform sampler2D uAccum;        // the room buffer (its alpha: coverage)
uniform float uCount;
uniform sampler3D uLut;
uniform vec3 uShaper;
uniform float uExposure;
out vec4 outColor;
vec3 agx(vec3 x) {
  vec3 s = clamp((log2(max(x, exp2(uShaper.x))) - uShaper.x) / (uShaper.y - uShaper.x), 0.0, 1.0);
  float n = uShaper.z;
  return texture(uLut, s * ((n - 1.0) / n) + 0.5 / n).rgb;
}
// Cycles' fresnel_dielectric_cos
float fresnel(float c, float eta) {
  float g = eta * eta - 1.0 + c * c;
  if (g <= 0.0) return 1.0;
  g = sqrt(g);
  float A = (g - c) / (g + c), B = (c * (g + c) - 1.0) / (c * (g - c) + 1.0);
  return 0.5 * A * A * (1.0 + B * B);
}
void main() {
  float cover = clamp(texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0).a / max(uCount, 1.0), 0.0, 1.0);
  if (cover > 0.999) discard;
  vec2 ndc = gl_FragCoord.xy / uSize * 2.0 - 1.0;
  vec4 w = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 r = normalize(w.xyz / w.w - uEye);
  if (r.z >= -1e-4) discard;
  vec3 P = uEye + r * ((uZ - uEye.z) / r.z);
  if (P.x < uRect.x || P.x > uRect.y || P.y < uRect.z || P.y > uRect.w) discard;
  vec4 t = uTexMatrix * vec4(P, 1.0);
  vec2 uv = t.xy / t.w;
  vec3 L;
  if (uGlassInfo.y > 0.5) {
    vec2 d = 0.5 * uGlassInfo.zw;
    L = 0.25 * uGlassInfo.x * (texture(uGlass, uv + vec2(-d.x, -d.y)).rgb + texture(uGlass, uv + vec2(d.x, -d.y)).rgb
              + texture(uGlass, uv + vec2(-d.x, d.y)).rgb + texture(uGlass, uv + vec2(d.x, d.y)).rgb);
  } else L = texture(uGlass, uv).rgb * uGlassInfo.x;
  vec3 g = agx(L * fresnel(-r.z, uIor) * uGain * uExposure);
  // AgX lifts black a hair: take its own black off so an empty reflection adds nothing. Only where the room leaves the
  // glass clear: at the anti-aliased edge of something in front of it (the bottle, the lamp's arms) the refined mirror's
  // blur of that thing's own reflection would otherwise show as a thin light rim (polish-r2)
  g = max(g - agx(vec3(0.0)), 0.0) * (1.0 - smoothstep(0.0, 0.25, cover));
  outColor = vec4(g, 0.0);
}`;

export class GlassMirror {
  /**
   * colour: the engine's Colour (AgX table, exposure); opts: { z, rect: [x0, x1, y0, y1], scale, samples, lens, tent }
   * (samples: the most refining samples the mirror takes, 0 for as many as the room; lens: the share of the lens's
   * aperture the mirror's depth of field uses; tent: the refined sum read through the 2 x 2 tent too)
   */
  constructor(renderer, shared, colour, fs, { z = -1.40, rect = [-1.1, 1.1, 0.82, 2.55], scale = 0.5, samples = 0, lens = 1, tent = true } = {}) {
    this.renderer = renderer;
    this.shared = shared;
    this.fs = fs;
    this.z = z;
    this.scale = scale;
    this.maxSamples = samples;
    this.lensScale = lens;
    this.tentRefined = tent;
    this.on = false;
    this.drawn = false;
    this.n = 0;                  // samples in the refined sum
    this.sum = null;             // its target (made on the first refining sample)
    this.base = null;            // the main camera of the last live frame: { position, quaternion, proj }
    this.camera = new THREE.PerspectiveCamera();
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
    this.target = null;          // the target the last render drew: full, or the moving one (perf-r2)
    this.full = null;
    this.targetMv = null;
    const cu = colour.uniforms;
    this.uniforms = {
      uGlass: { value: null }, uGlassInfo: { value: new THREE.Vector4(1, 1, 0, 0) }, uTexMatrix: { value: new THREE.Matrix4() }, uInvViewProj: { value: new THREE.Matrix4() },
      uEye: { value: new THREE.Vector3() }, uSize: { value: new THREE.Vector2(1, 1) },
      uRect: { value: new THREE.Vector4(...rect) }, uZ: { value: z }, uIor: { value: 1.52 }, uGain: { value: 1 },
      uAccum: { value: null }, uCount: { value: 1 },
      uLut: cu.uLut, uShaper: cu.uShaper, uExposure: cu.uExposure,
    };
    shared.uGlassGain = this.uniforms.uGain;     // reachable by ?tune= (calibration only)
    this.material = new THREE.RawShaderMaterial({
      name: "glass", glslVersion: THREE.GLSL3, vertexShader: SHADER_NONCE + VS, fragmentShader: SHADER_NONCE + FS,
      uniforms: this.uniforms, depthTest: false, depthWrite: false,
      // screen: 1 - (1 - dst)(1 - src) = src (1 - dst) + dst; the display's alpha is kept
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendEquationAlpha: THREE.AddEquation,
      blendSrc: THREE.OneMinusDstColorFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
  }

  /** The dark moments have the glass layer (frames.json `glass`; room3d.json may carry it as `glass`). */
  setMoment(on) { this.on = !!on; this.drawn = false; this.n = 0; }

  _makeTarget(w, h, name) {
    const t = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.NoColorSpace,
    });
    t.texture.name = name;
    return t;
  }

  resize(width, height) {
    const w = Math.max(16, Math.round(width * this.scale)), h = Math.max(16, Math.round(height * this.scale));
    if (this.target && this.target.width === w && this.target.height === h) return;
    this.target?.dispose();
    this.sum?.dispose();
    this.sum = null;
    this.targetMv?.dispose();
    this.targetMv = null;
    this.target = this.full = this._makeTarget(w, h, "glass-mirror");
    this.uniforms.uGlass.value = this.target.texture;
    this.drawn = false;
    this.n = 0;
  }

  /**
   * The virtual camera for the main camera `base`, moved by `lens` ([x, y] m along the main camera's right and up: a
   * point on the aperture, with `distance` the focus distance) and jittered by `j` (the mirror's own pixels).
   * Returns the projection before the near plane is bent (with neither: the texture lookup's).
   */
  _place({ position, quaternion, proj }, j = null, lens = null, distance = 0) {
    const Z = this.z;
    const eye = position.clone();
    if (lens) {
      eye.add(new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion).multiplyScalar(lens[0]))
        .add(new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).multiplyScalar(lens[1]));
    }
    const pos = eye.clone(); pos.z = 2 * Z - pos.z;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion); fwd.z = -fwd.z;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion); up.z = -up.z;
    const m = new THREE.Matrix4().lookAt(pos, pos.clone().add(fwd), up);
    m.setPosition(pos);
    const vc = this.camera;
    vc.matrixWorld.copy(m);
    vc.matrixWorldInverse.copy(m).invert();
    vc.position.copy(pos);
    const P = vc.projectionMatrix.copy(proj), e = P.elements;
    e[8] = -e[8];
    if (j) {
      e[8] += (2 * j[0]) / this.target.width;
      e[9] += (2 * j[1]) / this.target.height;
    }
    if (lens && distance > 0) {
      // the frustum shears so the focus plane stays put, as the engine's own lens sample does; the main camera's
      // right is the virtual camera's left (the image is flipped in x)
      e[8] += (e[0] * lens[0]) / distance;
      e[9] -= (e[5] * lens[1]) / distance;
    }
    const plain = P.clone();
    // oblique near plane on the pane: only the room side (z > Z) is drawn
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(Z + 0.002)).applyMatrix4(vc.matrixWorldInverse);
    const c = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const q = new THREE.Vector4((Math.sign(c.x) + e[8]) / e[0], (Math.sign(c.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    c.multiplyScalar(2 / c.dot(q));
    e[2] = c.x; e[6] = c.y; e[10] = c.z + 1; e[14] = c.w;
    vc.projectionMatrixInverse.copy(P).invert();
    return plain;
  }

  /** The target for a frame drawn at `k` of the full scale (perf-r2: moving frames get a smaller one, kept). */
  _targetFor(k) {
    if (!(k < 1)) return this.full;
    const w = Math.max(16, Math.round(this.full.width * k)), h = Math.max(16, Math.round(this.full.height * k));
    if (!this.targetMv || this.targetMv.width !== w || this.targetMv.height !== h) {
      this.targetMv?.dispose();
      this.targetMv = this._makeTarget(w, h, "glass-mirror-moving");
    }
    return this.targetMv;
  }

  /** Redraw the mirrored room for the main camera (`camera` at its unjittered projection `projNoJitter`); `k` the
   * frame's scale (perf-r2: below 1 for moving frames, drawn into a smaller target). */
  render(room, camera, projNoJitter, k = 1) {
    this.n = 0;
    if (!this.on || !this.full) return false;
    this.target = this._targetFor(k);
    const r = this.renderer, s = this.shared, Z = this.z;
    if (camera.position.z <= Z + 0.01) { this.drawn = false; return false; }
    this.base = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), proj: projNoJitter.clone() };
    const vc = this.camera;
    const plain = this._place(this.base);
    this.uniforms.uTexMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(plain).multiply(vc.matrixWorldInverse);
    // the room for the virtual eye (no desk mirror in it: that one belongs to the main view)
    s.uMirrorPass.value = 1;
    r.setRenderTarget(this.target);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    room.setMode("live");
    room.draw(vc);
    s.uMirrorPass.value = 0;
    r.setRenderTarget(null);
    this.uniforms.uEye.value.copy(camera.position);
    this.uniforms.uInvViewProj.value.multiplyMatrices(projNoJitter, camera.matrixWorldInverse).invert();
    this.drawn = true;
    return true;
  }

  /**
   * One refining sample of the mirror, with the room's sample `k`: its jitter (taken in the mirror's pixels, so the
   * same 1.5 px filter) and its point on the lens (`lens`, [x, y] m, null without depth of field; `distance` the focus
   * distance). Added into the sum (depth pre-pass, then added at equal depth, as the room's own samples).
   */
  sample(room, k, lens = null, distance = 0) {
    if (!this.on || !this.drawn || !this.base || k < 1 || this.target !== this.full) return false;
    if (this.maxSamples && this.n >= this.maxSamples) return false;
    const r = this.renderer, s = this.shared, t = this.target;
    if (!this.sum) this.sum = this._makeTarget(t.width, t.height, "glass-mirror-sum");
    const prevTarget = r.getRenderTarget(), prevMode = room.mode;
    this._place(this.base, jitter(k), lens && this.lensScale !== 1 ? [lens[0] * this.lensScale, lens[1] * this.lensScale] : lens, distance);
    s.uMirrorPass.value = 1;
    r.setRenderTarget(this.sum);
    r.setClearColor(0x000000, 0);
    r.clear(this.n === 0, true, false);
    room.setMode("prepass");
    room.draw(this.camera);
    room.setMode("add");
    room.draw(this.camera);
    s.uMirrorPass.value = 0;
    room.setMode(prevMode || "live");
    r.setRenderTarget(prevTarget);
    this.n++;
    return true;
  }

  /** Screen-blend the reflection over the display target (bound by the caller). */
  overlay(accum, count, width, height) {
    if (!this.on || !this.drawn) return;
    const u = this.uniforms;
    // the refined sum once 4 samples are in (the room's hold), else the live frame through its tent
    const refined = this.sum && this.n >= 4;
    const src = refined ? this.sum : this.target;
    u.uGlass.value = src.texture;
    u.uGlassInfo.value.set(refined ? 1 / this.n : 1, refined && !this.tentRefined ? 0 : 1, 1 / src.width, 1 / src.height);
    u.uAccum.value = accum.texture;
    u.uCount.value = count;
    u.uSize.value.set(width, height);
    this.fs.draw(this.renderer, this.material);
  }

  dispose() { this.full?.dispose(); this.targetMv?.dispose(); this.sum?.dispose(); this.material.dispose(); }
}
