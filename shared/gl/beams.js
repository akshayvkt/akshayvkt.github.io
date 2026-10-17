// The sunbeams (plan 2.6): the light the room's air scatters toward the eye in the moments room.py fills the room
// with its RoomAir dust volume (lateafternoon, golden, lowsun; density from room3d.json `beams`).
//
// What Cycles does there: a Principled Volume over the whole room (density d per metre, white, Henyey-Greenstein
// anisotropy 0.55) that scatters every light toward the camera, the sun most of all. Single scattering is all of it
// at these densities (d x 5 m < 1%), so along each eye ray from the camera to the room surface it hits:
//
//   L = d * [ HG(cos(sun, ray)) * E_sun * (metres of sunlit air on the ray) + (the probe's light around the ray) * (metres of air) ]
//
// The sunlit metres come from a sun shadow map of the room (the window wall with its opening, frame, mullions and
// everything inside), marched with a random offset per room sample, so refining at rest turns 16 steps into 512.
// It is drawn over the room's own surfaces (depth EQUAL, added, alpha 0) right after each room sample, so it refines
// with the room and costs nothing once settled. The window opening itself (the air in front of the glass) has no room
// surface: there the same shader is drawn on a quad at the wall's outer face (behind the frame, so depth keeps the
// frame and mullions in front), as light without coverage, which the composite lays over the outside as a veil.
import * as THREE from "three";
import { SHADER_NONCE } from "./context.js";

const SHADOW_VS = /* glsl */ `
precision highp float;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
out float vDepth;
void main() {
  vec4 vp = viewMatrix * (modelMatrix * vec4(position, 1.0));
  vDepth = -vp.z;
  gl_Position = projectionMatrix * vp;
}`;
const SHADOW_FS = /* glsl */ `
precision highp float;
in float vDepth;
out vec4 outColor;
void main() { outColor = vec4(vDepth, 0.0, 0.0, 1.0); }`;

// the same vertex maths as the room's own material (material.js VS), so depth EQUAL holds
const BEAM_VS = /* glsl */ `
precision highp float;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
out vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const BEAM_FS = /* glsl */ `
precision highp float;
precision highp sampler2D;
#define texture2D texture
#define PI 3.141592653589793
uniform vec3 cameraPosition;
uniform sampler2D uShadow;       // metres along the sun's travel from the shadow camera to the first surface
uniform mat4 uShadowView;
uniform mat4 uShadowProj;
uniform vec3 uSunDir;            // toward the sun
uniform vec3 uSunColor;          // E / pi
uniform vec4 uBeam;              // density (1/m), anisotropy g, steps, sample index
uniform vec4 uBeamK;             // gains: sun, ambient (calibration; 1 = physical), unused, unused
uniform vec3 uAirMin;
uniform vec3 uAirMax;
uniform sampler2D uProbeA;
uniform sampler2D uProbeB;
uniform vec3 uProbePosA;
uniform vec3 uProbePosB;
in vec3 vWorldPos;
out vec4 outColor;

${THREE.ShaderChunk.cube_uv_reflection_fragment}

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

float sunlit(vec3 X) {
  vec4 v = uShadowView * vec4(X, 1.0);
  vec4 c = uShadowProj * v;
  vec2 uv = c.xy / c.w * 0.5 + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  return -v.z <= texture(uShadow, uv).r + 0.015 ? 1.0 : 0.0;
}

void main() {
  vec3 C = cameraPosition;
  vec3 D = vWorldPos - C;
  float tEnd = length(D);
  vec3 r = D / max(tEnd, 1e-6);
  // the ray's stretch inside the air box (room.py's RoomAir: the room, 2 cm in from every wall)
  vec3 inv = 1.0 / r;
  vec3 t0 = (uAirMin - C) * inv, t1 = (uAirMax - C) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float a = max(max(max(tn.x, tn.y), tn.z), 0.0);
  float b = min(min(min(tf.x, tf.y), tf.z), tEnd);
  if (b <= a) discard;
  float len = b - a;
  // sunlit metres, stratified with a per-pixel, per-sample offset
  float n = uBeam.z;
  float o = fract(ign(gl_FragCoord.xy) + uBeam.w * 0.6180339887);
  float dt = len / n;
  float lit = 0.0;
  for (int i = 0; i < 64; i++) {
    if (float(i) >= n) break;
    lit += sunlit(C + r * (a + (float(i) + o) * dt));
  }
  lit *= dt;
  float g = uBeam.y, cosT = dot(uSunDir, r);
  float hg = (1.0 - g * g) / (4.0 * PI * pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-4), 1.5));
  vec3 sun = hg * PI * uSunColor * lit;
  // the rest of the room's light (sky through the window, bounce, sun patches) from the probes, around the ray's
  // forward direction: the HG lobe (g 0.55) is about as wide as the probes' widest (cosine-like) blur
  vec3 M = C + r * (a + 0.5 * len);
  float wB = clamp(0.5 + (distance(M, uProbePosA) - distance(M, uProbePosB)) * 0.6, 0.0, 1.0);
  vec3 amb = mix(textureCubeUV(uProbeA, r, 1.0).rgb, textureCubeUV(uProbeB, r, 1.0).rgb, wB) * len;
  outColor = vec4(uBeam.x * (uBeamK.x * sun + uBeamK.y * amb), 0.0);
}`;

export class Beams {
  /**
   * @param renderer three.js renderer
   * @param room     the Room (its scene is drawn with override materials)
   * @param shared   the shared uniforms (sun, probes)
   * @param cubeUV   the probe defines (Probes.defines)
   * @param opts     { box: [[x,y,z],[x,y,z]] the room's inner box, steps, size }
   */
  constructor(renderer, room, shared, cubeUV, { box, steps = 16, size = 1024 } = {}) {
    this.renderer = renderer;
    this.room = room;
    this.shared = shared;
    this.opening = null;            // a scene with the opening's quad (made at the first draw: the window rect is known then)
    this.density = 0;
    this.dirty = true;
    this.steps = steps;
    this.size = size;
    const inner = box || [[-2, 0, -1.2], [2, 2.9, 4]];
    this.shadowRT = null;
    this.shadowCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
    this.shadowMat = new THREE.RawShaderMaterial({
      name: "beams:shadow", glslVersion: THREE.GLSL3,
      vertexShader: SHADER_NONCE + SHADOW_VS, fragmentShader: SHADER_NONCE + SHADOW_FS, side: THREE.DoubleSide,
    });
    this.uniforms = {
      uShadow: { value: null },
      uShadowView: { value: new THREE.Matrix4() },
      uShadowProj: { value: new THREE.Matrix4() },
      uBeam: { value: new THREE.Vector4(0, 0.55, steps, 0) },
      uBeamK: { value: new THREE.Vector4(1, 1, 0, 0) },
      // room.py's RoomAir box: 2 cm in from the side walls, floor, ceiling, window wall and the back
      uAirMin: { value: new THREE.Vector3(inner[0][0] + 0.02, inner[0][1] + 0.01, inner[0][2] + 0.02) },
      uAirMax: { value: new THREE.Vector3(inner[1][0] - 0.02, inner[1][1] - 0.01, inner[1][2] - 0.02) },
      uSunDir: shared.uSunDir, uSunColor: shared.uSunColor,
      uProbeA: shared.uProbeA, uProbeB: shared.uProbeB, uProbePosA: shared.uProbePosA, uProbePosB: shared.uProbePosB,
    };
    shared.uBeamK = this.uniforms.uBeamK;     // reachable by ?tune= (calibration only)
    this.beamMat = new THREE.RawShaderMaterial({
      name: "beams", glslVersion: THREE.GLSL3,
      vertexShader: SHADER_NONCE + BEAM_VS, fragmentShader: SHADER_NONCE + BEAM_FS,
      uniforms: this.uniforms,
      defines: { ENVMAP_TYPE_CUBE_UV: "", CUBEUV_TEXEL_WIDTH: cubeUV.texelWidth, CUBEUV_TEXEL_HEIGHT: cubeUV.texelHeight,
        CUBEUV_MAX_MIP: cubeUV.maxMip.toFixed(1) },
      side: THREE.DoubleSide,
      depthTest: true, depthWrite: false, depthFunc: THREE.EqualDepth,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendEquationAlpha: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    });
    // the same program on the opening's quad: depth LESS-EQUAL against the room's depth (not EQUAL), same uniforms
    this.openingMat = new THREE.RawShaderMaterial({
      name: "beams:opening", glslVersion: THREE.GLSL3,
      vertexShader: SHADER_NONCE + BEAM_VS, fragmentShader: SHADER_NONCE + BEAM_FS,
      uniforms: this.uniforms, defines: this.beamMat.defines,
      side: THREE.DoubleSide,
      depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendEquationAlpha: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    });
  }

  /** The window opening's quad, 5 mm beyond the wall's outer face (the window rect and box of the shared uniforms). */
  _opening() {
    const W = this.shared.uWindowRect.value, z = this.shared.uBoxMin.value.z - 0.005;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W.y - W.x, W.w - W.z), this.openingMat);
    mesh.position.set((W.x + W.y) / 2, (W.z + W.w) / 2, z);
    mesh.frustumCulled = false;
    this.opening = new THREE.Scene();
    this.opening.add(mesh);
    this.opening.updateMatrixWorld(true);
    return this.opening;
  }

  /** A moment's beams: its density (room3d.json `beams`, 0 = none). The sun's direction is read from the shared uniforms. */
  setMoment(m) {
    this.density = (m && m.sun && m.beams) || 0;
    this.uniforms.uBeam.value.x = this.density;
    this.dirty = true;
  }

  get active() { return this.density > 0; }

  /** The sun shadow map: an orthographic view along the sun's travel covering the whole room box. */
  _buildShadow() {
    const r = this.renderer;
    if (!this.shadowRT) {
      this.shadowRT = new THREE.WebGLRenderTarget(this.size, this.size, {
        type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: true, stencilBuffer: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
      });
      this.shadowRT.texture.name = "beams:shadow";
    }
    const s = this.uniforms.uSunDir.value.clone().normalize();
    const box = new THREE.Box3(new THREE.Vector3(-2, 0, -1.45), new THREE.Vector3(2, 2.9, 4));
    const centre = box.getCenter(new THREE.Vector3());
    const cam = this.shadowCam;
    cam.position.copy(centre).addScaledVector(s, 10);
    cam.up.set(0, 1, 0);
    if (Math.abs(s.y) > 0.98) cam.up.set(0, 0, -1);
    cam.lookAt(centre);
    cam.updateMatrixWorld(true);
    const inv = cam.matrixWorldInverse;
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv);
      lo.min(p); hi.max(p);
    }
    cam.left = lo.x - 0.05; cam.right = hi.x + 0.05; cam.bottom = lo.y - 0.05; cam.top = hi.y + 0.05;
    cam.near = Math.max(0.01, -hi.z - 0.5); cam.far = -lo.z + 0.5;
    cam.updateProjectionMatrix();
    const scene = this.room.scene;
    const prevOverride = scene.overrideMaterial;
    scene.overrideMaterial = this.shadowMat;
    r.setRenderTarget(this.shadowRT);
    const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setClearColor(new THREE.Color(1000, 0, 0), 1);
    r.clear(true, true, false);
    r.render(scene, cam);
    r.setClearColor(cc, ca);
    scene.overrideMaterial = prevOverride;
    this.uniforms.uShadow.value = this.shadowRT.texture;
    this.uniforms.uShadowView.value.copy(cam.matrixWorldInverse);
    this.uniforms.uShadowProj.value.copy(cam.projectionMatrix);
    this.dirty = false;
  }

  /** Add the air's light for one room sample into `target` (the room buffer, its depth from this sample). */
  draw(target, camera, sample) {
    if (!this.active) return;
    const r = this.renderer;
    if (this.dirty) this._buildShadow();
    this.uniforms.uBeam.value.w = sample;
    r.setRenderTarget(target);
    const scene = this.room.scene;
    const prev = scene.overrideMaterial;
    scene.overrideMaterial = this.beamMat;
    r.render(scene, camera);
    scene.overrideMaterial = prev;
    r.render(this.opening || this._opening(), camera);
  }

  dispose() {
    this.shadowRT?.dispose();
    this.shadowMat.dispose();
    this.beamMat.dispose();
    this.openingMat.dispose();
    this.opening?.children[0].geometry.dispose();
  }
}
