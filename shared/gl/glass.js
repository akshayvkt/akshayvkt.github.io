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
//
// Its strength matches the photographs' glass layer (glass-strength, 23 Oct): build_web.py grades that layer with the
// moment's room grade() and clips it at 0, and the grade's contrast around mid-grey (1.02) takes ~0.01 off every value,
// so the faint reflection of the dimly lit walls vanishes and only the lamp's reflection is left. The overlay did the AgX
// step but not the grade: the 3D's pane showed the whole room (at night on phones ~4x the photo's mean reflection) and
// moved ~8x as much as the photo's when the walls' colour changed (walls-report.md section 10). It now grades the same.
import * as THREE from "three";
import { SHADER_NONCE } from "./context.js";
import { jitter } from "./loop.js";

// (DYS-149 glass-box: the mirror drawn, live and in each refining sample, only over the texels the overlay can read
// (_texBox), and not at all when the pane is off the screen: looking down at the notebook or the phone a phone's screen
// holds a strip of the pane or none of it, yet every page turn's, the notebook opening's and the 12 refining samples'
// frames drew the whole mirrored room (a quarter of the screen's pixels) for an overlay that read that strip or nothing
// (smooth-levers 31 Oct, lever 2; at the desk the pane is about half the mirror). The same pixels: the overlay reads
// nothing else. And the overlay's own box there (box(): _cutBox). ?glassbox=0: as before; at run time
// globalThis.__glassBox = 0 / 1 picks the path from the next live frame (a refine under way keeps its live frame's box,
// none after one drawn whole) and for the overlay's box at once)
const GLASS_BOX = typeof location === "undefined" || new URLSearchParams(location.search || "").get("glassbox") !== "0";
const glassBox = () => { const g = globalThis.__glassBox; return g === undefined || g === null ? GLASS_BOX : !!+g; };

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
uniform vec4 uGrade;             // the room's grade(): contrast, saturation, gamma, warmth (colour.js)
uniform vec3 uLuma;
out vec4 outColor;
vec3 agx(vec3 x) {
  vec3 s = clamp((log2(max(x, exp2(uShaper.x))) - uShaper.x) / (uShaper.y - uShaper.x), 0.0, 1.0);
  float n = uShaper.z;
  return texture(uLut, s * ((n - 1.0) / n) + 0.5 / n).rgb;
}
// scripts/build_web.py grade(), one for one, as colour.js has it
vec3 grade(vec3 rgb) {
  rgb = pow(clamp(rgb, 0.0, 1.0), vec3(uGrade.z));
  rgb = 0.5 + (rgb - 0.5) * uGrade.x;
  float l = dot(rgb, uLuma);
  rgb = l + (rgb - l) * uGrade.y;
  return rgb * vec3(1.0 + uGrade.w, 1.0, 1.0 - uGrade.w);
}
// Cycles' fresnel_dielectric_cos
float fresnel(float c, float eta) {
  float g = eta * eta - 1.0 + c * c;
  if (g <= 0.0) return 1.0;
  g = sqrt(g);
  float A = (g - c) / (g + c), B = (c * (g + c) - 1.0) / (c * (g - c) + 1.0);
  return 0.5 * A * A * (1.0 + B * B);
}
uniform float uRoomW;   // v3/zoom-r3: the room's weight in the picture (the glass's reflections fade with the room)
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
  // the photographs' glass layer (glass-strength): AgX, then the room's grade(), clipped at 0 as build_web.py does
  vec3 g = max(grade(agx(L * fresnel(-r.z, uIor) * uGain * uExposure)), 0.0);
  // AgX lifts black a hair: take its own black off so an empty reflection adds nothing. Only where the room leaves the
  // glass clear: at the anti-aliased edge of something in front of it (the bottle, the lamp's arms) the refined mirror's
  // blur of that thing's own reflection would otherwise show as a thin light rim (polish-r2)
  g = max(g - agx(vec3(0.0)), 0.0) * (1.0 - smoothstep(0.0, 0.25, cover));
  outColor = vec4(g * uRoomW, 0.0);
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
    this._vp = new THREE.Matrix4();   // (DYS-149 box-only) the main camera's view-projection at the last live frame
    // (DYS-149 glass-box) the texels of the last live frame's target the overlay can read ([x, y, w, h]; null: all of
    // them), and _cut's and _texBox's own numbers (kept, no allocation a frame)
    this.tbox = null;
    this._tb = { ivp: new THREE.Matrix4(), d: new Float64Array(12), n: new Float64Array(12), a: new Float64Array(48), b: new Float64Array(48), p: null, box: [0, 0, 0, 0] };
    const cu = colour.uniforms;
    this.uniforms = {
      uGlass: { value: null }, uGlassInfo: { value: new THREE.Vector4(1, 1, 0, 0) }, uTexMatrix: { value: new THREE.Matrix4() }, uInvViewProj: { value: new THREE.Matrix4() },
      uEye: { value: new THREE.Vector3() }, uSize: { value: new THREE.Vector2(1, 1) },
      uRect: { value: new THREE.Vector4(...rect) }, uZ: { value: z }, uIor: { value: 1.52 }, uGain: { value: 1 },
      uAccum: { value: null }, uCount: { value: 1 }, uRoomW: { value: 1 },
      uLut: cu.uLut, uShaper: cu.uShaper, uExposure: cu.uExposure,
    };
    shared.uGlassGain = this.uniforms.uGain;     // reachable by ?tune= (calibration only)
    Object.assign(this.uniforms, { uGrade: cu.uGrade, uLuma: cu.uLuma });   // the room's grade() (glass-strength)
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
    // (review since 89e71ad6, 4: the full-size target is compared and let go, not this.target: right after a moving frame
    // that is the half-size moving one (disposed below), and the old full target stayed on the GPU)
    if (this.full && this.full.width === w && this.full.height === h) return;
    this.full?.dispose();
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
    // (DYS-149 glass-box: no texel the overlay can read: not drawn, as for an eye behind the pane; else the clear and
    // the room scissored to those texels (the target's own scissor, which three.js sets again whenever it is bound))
    const tb = (this.tbox = glassBox() ? this._texBox(camera, projNoJitter) : null);
    if (tb === false) { this.tbox = null; this.drawn = false; return false; }
    if (tb) { this.target.scissor.set(tb[0], tb[1], tb[2], tb[3]); this.target.scissorTest = true; }
    // the room for the virtual eye (no desk mirror in it: that one belongs to the main view)
    s.uMirrorPass.value = 1;
    r.setRenderTarget(this.target);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    room.setMode("live");
    room.draw(vc);
    s.uMirrorPass.value = 0;
    if (tb) this.target.scissorTest = false;
    r.setRenderTarget(null);
    this.uniforms.uEye.value.copy(camera.position);
    // (DYS-149 box-only: the matrix the shader's uInvViewProj inverts kept as it is, for box(); the uniform the same numbers)
    this._vp.multiplyMatrices(projNoJitter, camera.matrixWorldInverse);
    this.uniforms.uInvViewProj.value.copy(this._vp).invert();
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
    // (DYS-149 glass-box: scissored to the live frame's box, in the full target's texels as the sum's: the overlay reads
    // the sum through the same uTexMatrix, and the camera is still while it refines; its first sample clears that box)
    const tb = glassBox() ? this.tbox : null;
    if (tb) { this.sum.scissor.set(tb[0], tb[1], tb[2], tb[3]); this.sum.scissorTest = true; }
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
    if (tb) this.sum.scissorTest = false;
    r.setRenderTarget(prevTarget);
    this.n++;
    return true;
  }

  /** Screen-blend the reflection over the display target (bound by the caller). */
  overlay(accum, count, width, height, roomW = 1) {
    if (!this.on || !this.drawn || roomW <= 0) return;
    const u = this.uniforms;
    u.uRoomW.value = roomW;
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

  /**
   * (DYS-149 box-only) The screen box [x, y, w, h] (px of a `width` x `height` frame, GL origin) outside which the
   * overlay discards every fragment: FS draws only where a pixel's ray (from uEye to its point on the far plane of the
   * matrix uInvViewProj inverts) meets the pane inside the opening (uRect on z = uZ), so only inside the picture of
   * that rectangle from uEye. Each corner is taken along its ray from uEye to that far plane, then to the screen: a
   * convex cone cut by a plane all of whose rays it meets in front, so the pixels it holds are inside those 4 points'
   * hull (whether or not uEye is the matrix's own eye). 2 px more each way for the GPU's float. null: the whole screen
   * (the eye not in front of the pane, or a corner not in front of it). Only what the overlay would draw (on, drawn).
   * (DYS-149 glass-box: a corner not in front: _cutBox's)
   */
  box(width, height) {
    if (!this.on || !this.drawn) return null;
    const e = this._vp.elements, E = this.uniforms.uEye.value, R = this.uniforms.uRect.value, Z = this.uniforms.uZ.value;
    if (!(E.z > Z)) return null;
    // (row r of VP times [x, y, z, w]; the elements are column-major)
    const row = (r, x, y, z, w) => e[r] * x + e[4 + r] * y + e[8 + r] * z + e[12 + r] * w;
    const ax = row(0, E.x, E.y, E.z, 1), ay = row(1, E.x, E.y, E.z, 1), az = row(2, E.x, E.y, E.z, 1), aw = row(3, E.x, E.y, E.z, 1);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 4; i++) {
      const dx = (i === 0 || i === 3 ? R.x : R.y) - E.x, dy = (i < 2 ? R.z : R.w) - E.y, dz = Z - E.z;
      const bx = row(0, dx, dy, dz, 0), by = row(1, dx, dy, dz, 0), bz = row(2, dx, dy, dz, 0), bw = row(3, dx, dy, dz, 0);
      // (where uEye + s d is on the far plane, h.z = h.w: in front only for s > 0, with h.w > 0 there)
      const s = (aw - az) / (bz - bw), hw = aw + s * bw;
      if (!(s > 0 && s < Infinity && hw > 1e-9 && hw < Infinity)) return this._cutBox(width, height);
      const x = ((ax + s * bx) / hw + 1) * 0.5 * width, y = ((ay + s * by) / hw + 1) * 0.5 * height;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (!(x1 - x0 < Infinity && y1 - y0 < Infinity)) return null;
    const bx0 = Math.max(0, Math.floor(x0) - 2), by0 = Math.max(0, Math.floor(y0) - 2);
    const bx1 = Math.min(width, Math.ceil(x1) + 2), by1 = Math.min(height, Math.ceil(y1) + 2);
    return [bx0, by0, bx1 - bx0, by1 - by0];
  }

  /**
   * (DYS-149 glass-box) box() when a corner of the opening is not in front of the eye (the notebook's view and the
   * glides to it, looking down past the top of the pane: the overlay then ran over the whole screen for a strip of the
   * pane at its top, or for none of it): the same box from the opening cut by the cone of the screen's rays from uEye
   * (_cut, on the overlay's own uniforms), all of whose corners are in front, each taken along its ray from uEye to the
   * far plane and to the screen as box() takes them: the pixels FS draws are inside their hull, as box() shows for its
   * own 4. 2 px more each way. [0, 0, 0, 0] when nothing is left of it; null (the whole screen, as before) with
   * ?glassbox=0 or a number not finite
   */
  _cutBox(width, height) {
    if (!glassBox()) return null;
    const E = this.uniforms.uEye.value, k = this._cut(E, this.uniforms.uInvViewProj.value.elements);
    if (k < 0) return null;
    if (k === 0) return [0, 0, 0, 0];
    const e = this._vp.elements, p = this._tb.p;
    const ax = e[0] * E.x + e[4] * E.y + e[8] * E.z + e[12], ay = e[1] * E.x + e[5] * E.y + e[9] * E.z + e[13];
    const az = e[2] * E.x + e[6] * E.y + e[10] * E.z + e[14], aw = e[3] * E.x + e[7] * E.y + e[11] * E.z + e[15];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < k; i++) {
      const dx = p[3 * i], dy = p[3 * i + 1], dz = p[3 * i + 2];
      const bz = e[2] * dx + e[6] * dy + e[10] * dz, bw = e[3] * dx + e[7] * dy + e[11] * dz;
      // (where uEye + s d is on the far plane, h.z = h.w: in front only for s > 0, with h.w > 0 there)
      const s = (aw - az) / (bz - bw), hw = aw + s * bw;
      if (!(s > 0 && s < Infinity && hw > 1e-9 && hw < Infinity)) return null;
      const x = ((ax + s * (e[0] * dx + e[4] * dy + e[8] * dz)) / hw + 1) * 0.5 * width, y = ((ay + s * (e[1] * dx + e[5] * dy + e[9] * dz)) / hw + 1) * 0.5 * height;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (!(x1 - x0 < Infinity && y1 - y0 < Infinity)) return null;
    const bx0 = Math.max(0, Math.floor(x0) - 2), by0 = Math.max(0, Math.floor(y0) - 2);
    const bx1 = Math.min(width, Math.ceil(x1) + 2), by1 = Math.min(height, Math.ceil(y1) + 2);
    return [bx0, by0, bx1 - bx0, by1 - by0];
  }

  /**
   * (DYS-149 glass-box) The opening (uRect on z = uZ) cut down to what of it the screen's pixels can see from the eye
   * `E`: FS takes a pixel's ray from uEye to its point on the far plane of the matrix uInvViewProj inverts (`m`, its
   * elements), at ndc (x, y, 1, 1) divided by w, and a pixel's centre is inside the screen, so the ray is inside the cone
   * from E through that far plane's 4 corners, and where it meets the pane, inside the opening cut by the cone's 4 sides
   * (a convex polygon; the cone is pointed, so nothing behind the eye is left). Its corners from E in this._tb.p; returns
   * how many (0: none left: no pixel's ray meets the opening), -1 for a number not finite
   */
  _cut(E, m) {
    const T = this._tb, R = this.uniforms.uRect.value, Z = this.uniforms.uZ.value, d = T.d, n = T.n;
    // the far plane's corners from E
    for (let i = 0; i < 4; i++) {
      const x = i === 1 || i === 2 ? 1 : -1, y = i < 2 ? -1 : 1, w = m[3] * x + m[7] * y + m[11] + m[15];
      d[3 * i] = (m[0] * x + m[4] * y + m[8] + m[12]) / w - E.x;
      d[3 * i + 1] = (m[1] * x + m[5] * y + m[9] + m[13]) / w - E.y;
      d[3 * i + 2] = (m[2] * x + m[6] * y + m[10] + m[14]) / w - E.z;
    }
    // each side's normal, into the cone (d_i x d_i+1, turned toward d_i+2)
    for (let i = 0; i < 4; i++) {
      const a = 3 * i, b = 3 * ((i + 1) % 4), c = 3 * ((i + 2) % 4);
      const nx = d[a + 1] * d[b + 2] - d[a + 2] * d[b + 1], ny = d[a + 2] * d[b] - d[a] * d[b + 2], nz = d[a] * d[b + 1] - d[a + 1] * d[b];
      const sg = nx * d[c] + ny * d[c + 1] + nz * d[c + 2] < 0 ? -1 : 1;
      n[a] = sg * nx; n[a + 1] = sg * ny; n[a + 2] = sg * nz;
    }
    for (let i = 0; i < 12; i++) if (!Number.isFinite(d[i]) || !Number.isFinite(n[i])) return -1;
    // the opening (from E), cut by each side in turn (Sutherland-Hodgman: at most one corner more a side)
    let p = T.a, q = T.b, k = 4;
    for (let i = 0; i < 4; i++) {
      p[3 * i] = (i === 1 || i === 2 ? R.y : R.x) - E.x; p[3 * i + 1] = (i < 2 ? R.z : R.w) - E.y; p[3 * i + 2] = Z - E.z;
    }
    for (let s = 0; s < 4 && k > 0; s++) {
      const nx = n[3 * s], ny = n[3 * s + 1], nz = n[3 * s + 2];
      let j = 0;
      for (let i = 0; i < k; i++) {
        const a = 3 * i, b = 3 * ((i + 1) % k);
        const da = nx * p[a] + ny * p[a + 1] + nz * p[a + 2], db = nx * p[b] + ny * p[b + 1] + nz * p[b + 2];
        if (da >= 0) { q[3 * j] = p[a]; q[3 * j + 1] = p[a + 1]; q[3 * j + 2] = p[a + 2]; j++; }
        if ((da >= 0) !== (db >= 0)) {
          const t = da / (da - db);
          q[3 * j] = p[a] + (p[b] - p[a]) * t; q[3 * j + 1] = p[a + 1] + (p[b + 1] - p[a + 1]) * t; q[3 * j + 2] = p[a + 2] + (p[b + 2] - p[a + 2]) * t;
          j++;
        }
      }
      const o = p; p = q; q = o; k = j;
    }
    T.p = p;
    return k;
  }

  /**
   * (DYS-149 glass-box) The texels of this.target the overlay can read for the main camera `camera` at its unjittered
   * projection `projNoJitter` (render() then sets uEye and uInvViewProj from the same numbers; uTexMatrix is set):
   * [x, y, w, h] (GL origin), null for all of them, false for none. FS reads the mirror only at a point P of the opening
   * cut down to what the screen's pixels can see (_cut); none of it left (the pane off the screen, or behind the eye):
   * no pixel reads the mirror. Else its corners through uTexMatrix (the overlay's own, P to mirror uv) bound every uv it
   * reads at: P is in front of the main eye, so of the mirror's (its reflection in the pane, which P is on), and a
   * projective map takes a convex polygon in front of its eye to the hull of its corners. Each read reaches 1 texel round
   * its uv (the tent's 4 taps half a texel out, each its bilinear pair), and 2 more for the GPU's float; clamped to the
   * target as its sampler clamps. null when a number is not finite or a corner is not in front
   */
  _texBox(camera, projNoJitter) {
    const T = this._tb, E = camera.position;
    const k = this._cut(E, T.ivp.multiplyMatrices(projNoJitter, camera.matrixWorldInverse).invert().elements), p = T.p;
    if (k < 0) return null;
    if (k === 0) return false;
    // its corners in the mirror's texels
    const t = this.uniforms.uTexMatrix.value.elements, W = this.target.width, H = this.target.height;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < k; i++) {
      const x = p[3 * i] + E.x, y = p[3 * i + 1] + E.y, z = p[3 * i + 2] + E.z, w = t[3] * x + t[7] * y + t[11] * z + t[15];
      if (!(w > 1e-9 && w < Infinity)) return null;
      const u = ((t[0] * x + t[4] * y + t[8] * z + t[12]) / w) * W, v = ((t[1] * x + t[5] * y + t[9] * z + t[13]) / w) * H;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    if (!(u1 - u0 < Infinity && v1 - v0 < Infinity)) return null;
    const x0 = Math.min(W - 1, Math.max(0, Math.floor(u0) - 3)), x1 = Math.min(W - 1, Math.max(0, Math.floor(u1) + 3));
    const y0 = Math.min(H - 1, Math.max(0, Math.floor(v0) - 3)), y1 = Math.min(H - 1, Math.max(0, Math.floor(v1) + 3));
    const b = T.box;
    b[0] = x0; b[1] = y0; b[2] = x1 - x0 + 1; b[3] = y1 - y0 + 1;
    return b;
  }

  dispose() { this.full?.dispose(); this.targetMv?.dispose(); this.sum?.dispose(); this.material.dispose(); }
}
