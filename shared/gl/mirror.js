// The desk mirror (plan 2.4): the room reflected in the walnut desk top, drawn live at the room's own brightness,
// so the window, the laptop screen and the lamp reflect where Cycles shows them, and the laptop, the sill and the
// pot hide the window where they stand in its way (a reflection probe can do neither).
//
// A virtual camera below the desk plane (the main camera reflected, its image flipped in x, as three.js's
// Reflector does it) draws the room into a half-resolution HDR target, its near plane bent onto the desk plane
// (oblique clipping) so nothing under the desk shows. The window opening, which the room leaves empty, is filled
// from the desk probe in each pixel's direction: the outside at its true HDR brightness (city lights at night).
// Alpha holds the distance from the virtual eye, so a glossy lookup can size its blur by how far the reflected
// thing is from the desk. The target is mip-mapped; the room shader picks a level from the roughness.
//
// It is redrawn when the camera or the light changes (the "live" frame) and reused while refining.
import * as THREE from "three";
import { DEFAULT_TEXTURES } from "./material.js";

const FILL_FS = /* glsl */ `
precision highp float;
#define texture2D texture
#define ENVMAP_TYPE_CUBE_UV
uniform sampler2D envMap;
uniform mat4 uInvViewProj;     // the virtual camera without the oblique clip
uniform vec3 uEye;
uniform vec2 uSize;
uniform float uFar;
in vec2 vUv;
out vec4 outColor;
${THREE.ShaderChunk.cube_uv_reflection_fragment}
void main() {
  vec2 ndc = gl_FragCoord.xy / uSize * 2.0 - 1.0;
  vec4 w = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 dir = normalize(w.xyz / w.w - uEye);
  outColor = vec4(textureCubeUV(envMap, dir, 0.0).rgb, uFar);
}`;

const FILL_VS = /* glsl */ `
precision highp float;
in vec2 position;
out vec2 vUv;
void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 1.0, 1.0); }`;

export class DeskMirror {
  /**
   * plane: { y, min: [x, z], max: [x, z] } — the desk top (room-local, horizontal). scale: target size relative to the
   * drawing buffer. guard: how much wider than the main view the mirror looks (blur needs context at the edges).
   */
  constructor(renderer, shared, cubeUV, { plane, scale = 0.5, guard = 1.15 } = {}) {
    this.renderer = renderer;
    this.shared = shared;
    this.plane = plane;
    this.scale = scale;
    this.guard = guard;
    this.camera = new THREE.PerspectiveCamera();
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
    this.target = null;
    this.textureMatrix = new THREE.Matrix4();
    this.fillUniforms = {
      envMap: { value: null }, uInvViewProj: { value: new THREE.Matrix4() }, uEye: { value: new THREE.Vector3() },
      uSize: { value: new THREE.Vector2(1, 1) }, uFar: { value: 1000 },
    };
    this.fill = new THREE.RawShaderMaterial({
      name: "mirror:fill", glslVersion: THREE.GLSL3,
      vertexShader: FILL_VS, fragmentShader: FILL_FS, uniforms: this.fillUniforms,
      defines: { CUBEUV_TEXEL_WIDTH: cubeUV.texelWidth, CUBEUV_TEXEL_HEIGHT: cubeUV.texelHeight, CUBEUV_MAX_MIP: cubeUV.maxMip.toFixed(1) },
      depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth, blending: THREE.NoBlending,
    });
    this.fsMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.fill);
    this.fsMesh.geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 3, -1, -1, 3], 2));
    this.fsMesh.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.fsMesh.frustumCulled = false;
    this.fsScene = new THREE.Scene();
    this.fsScene.add(this.fsMesh);
    this.drawn = false;
    this.ms = 0;
  }

  resize(width, height) {
    const w = Math.max(16, Math.round(width * this.scale * this.guard)), h = Math.max(16, Math.round(height * this.scale * this.guard));
    if (this.target && this.target.width === w && this.target.height === h) return;
    this.target?.dispose();
    this.target = this._make(w, h, "desk-mirror");
    this.targetMv?.dispose();
    this.targetMv = null;
    this.shared.uMirror.value = this.target.texture;
    this.shared.uMirrorInfo.value.set(w, h, 0, this.plane.y);
  }

  _make(w, h, name) {
    const t = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false, generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.NoColorSpace,
    });
    t.texture.name = name;
    return t;
  }

  /** The target for a frame drawn at `k` of the full scale (perf-r2: moving frames get a smaller one, kept). */
  _targetFor(k) {
    if (!(k < 1)) return this.target;
    const w = Math.max(16, Math.round(this.target.width * k)), h = Math.max(16, Math.round(this.target.height * k));
    if (!this.targetMv || this.targetMv.width !== w || this.targetMv.height !== h) {
      this.targetMv?.dispose();
      this.targetMv = this._make(w, h, "desk-mirror-moving");
    }
    return this.targetMv;
  }

  /** Is the desk top in front of the camera and seen from above? */
  visible(camera) {
    if (camera.position.y <= this.plane.y + 0.005) return false;
    const { min, max, y } = this.plane;
    const v = new THREE.Vector3();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, front = 0;
    for (const [x, z] of [[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]]) {
      v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
      if (v.z < 0) front++;
      v.applyMatrix4(camera.projectionMatrix);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    if (!front) return false;
    if (front < 4) return true;      // a corner behind the eye: assume it may show
    return !(x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1);
  }

  /**
   * Draw the mirror for `camera` (the main camera, unjittered projection `projNoJitter`). `room` is the Room;
   * `probe` the desk probe's PMREM texture; `k` the frame's scale (perf-r2: below 1 for moving frames).
   */
  render(room, camera, projNoJitter, probe, k = 1) {
    const t0 = performance.now();
    const r = this.renderer, s = this.shared;
    if (!this.visible(camera)) { s.uMirrorInfo.value.z = 0; this.drawn = false; return false; }
    const T = this._targetFor(k);
    const Y = this.plane.y;
    // reflect the eye, the look and the up across y = Y; the image comes out flipped in x (det stays +1)
    const pos = camera.position.clone(); pos.y = 2 * Y - pos.y;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion); fwd.y = -fwd.y;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion); up.y = -up.y;
    const m = new THREE.Matrix4().lookAt(pos, pos.clone().add(fwd), up);
    m.setPosition(pos);
    const vc = this.camera;
    vc.matrixWorld.copy(m);
    vc.matrixWorldInverse.copy(m).invert();
    vc.position.copy(pos);
    // the main projection, x shift mirrored, widened by the guard band
    const P = vc.projectionMatrix.copy(projNoJitter), e = P.elements;
    e[8] = -e[8];
    e[0] /= this.guard; e[5] /= this.guard; e[8] /= this.guard; e[9] /= this.guard;
    const plain = P.clone();
    // oblique near plane on the desk (Lengyel), a hair above it so things standing on it keep their feet
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(Y + 0.0005)).applyMatrix4(vc.matrixWorldInverse);
    const c = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const q = new THREE.Vector4((Math.sign(c.x) + e[8]) / e[0], (Math.sign(c.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    c.multiplyScalar(2 / c.dot(q));
    e[2] = c.x; e[6] = c.y; e[10] = c.z + 1; e[14] = c.w;
    vc.projectionMatrixInverse.copy(P).invert();
    // texture matrix: room point -> mirror uv (clip -> [0, 1])
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(plain).multiply(vc.matrixWorldInverse);
    s.uMirrorMatrix.value.copy(this.textureMatrix);
    s.uMirrorFpx.value = (T.height * 0.5) * plain.elements[5];   // pixels per unit tangent, vertically

    // the room, shaded for the virtual eye, alpha = distance from it
    s.uMirrorPass.value = 1;
    s.uMirror.value = DEFAULT_TEXTURES.black;          // never sample the target being drawn (a feedback loop)
    r.setRenderTarget(T);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    room.setMode("live");
    room.draw(vc);
    s.uMirrorPass.value = 0;
    // the window opening: the desk probe in each pixel's direction (the outside at its HDR brightness)
    const f = this.fillUniforms;
    f.envMap.value = probe;
    f.uInvViewProj.value.multiplyMatrices(plain, vc.matrixWorldInverse).invert();
    f.uEye.value.copy(pos);
    f.uSize.value.set(T.width, T.height);
    r.render(this.fsScene, vc);
    r.setRenderTarget(null);
    s.uMirror.value = T.texture;
    s.uMirrorInfo.value.set(T.width, T.height, 1, this.plane.y);
    this.drawn = true;
    this.ms = performance.now() - t0;
    return true;
  }

  off() { this.shared.uMirrorInfo.value.z = 0; this.drawn = false; }

  dispose() {
    this.target?.dispose();
    this.targetMv?.dispose();
    this.fill.dispose();
    this.fsMesh.geometry.dispose();
  }
}
