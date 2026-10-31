// Reflection probes (plan 2.4): two room panoramas per moment (by the desk and by the shelf), each with a lamp-only
// twin. Light adds linearly, so each probe slot holds PMREM(moment probe + lamp level x lamp twin): the sum is made
// before the pre-blur, which equals blurring both and adding them, and the room shader then needs half the
// reflection-map lookups (it compiles and runs faster). A lamp change rebuilds the two slots (a few ms of GPU),
// under the frozen-frame fade like every other change of light.
//
// Decoding runs on the GPU (cube root x scale, the file's orientation to three.js's equirect mapping), so no
// main-thread loop touches the pixels.
import * as THREE from "three";
import { fullscreenMaterial, nextTask, SHADER_NONCE } from "./context.js";
import { dataTexture, fetchBitmap, within } from "./loader.js";
import { cubeUVDefines } from "./material.js";

// The file: top row looks up, u = 0.5 at the window (-z), u grows toward +x.
// three.js's equirect: u = atan2(z, x) / 2pi + 0.5 (window at u = 0.25), v = 1 straight up.
const DECODE_FS = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform vec3 uScale;
in vec2 vUv;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  // the upload put the file's top row at texel row 0, so three's row y (0 = straight down) is file row H - 1 - y
  vec3 t = texelFetch(uSrc, ivec2((p.x + size.x / 4) % size.x, size.y - 1 - p.y), 0).rgb;
  outColor = vec4(t * t * t * uScale, 1.0);
}`;

const SUM_FS = /* glsl */ `
precision highp float;
uniform sampler2D uMain;
uniform sampler2D uLampTwin;
uniform float uLamp;
// the laptop screen (room.js screenRect): centre, unit axes with half-extents, front normal; uScrU.w = 0: none.
// The screen is a lit rectangle of its own in the room shader (screenCover, scaled by the screen level); in the probe
// it is a bright patch 0.3 m from the desk probe, which the box projection paints on the wall under the window (a
// white band across the back of the desk wherever the desk mirror doesn't cover it: phones, the shelf view). So the
// probe gives the screen's directions the light just beyond the screen's nearest edge.
uniform vec3 uPos;
uniform vec3 uScrC;
uniform vec4 uScrU;
uniform vec4 uScrV;
uniform vec3 uScrN;
in vec2 vUv;
out vec4 outColor;
#define PI 3.141592653589793
vec3 dirOf(vec2 uv) {             // three's equirect: u = atan(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5
  float phi = (uv.x - 0.5) * 2.0 * PI, th = (uv.y - 0.5) * PI;
  return vec3(cos(th) * cos(phi), sin(th), cos(th) * sin(phi));
}
vec2 uvOf(vec3 d) { return vec2(atan(d.z, d.x) / (2.0 * PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5); }
vec3 at(vec2 uv) { return texture(uMain, uv).rgb + uLamp * texture(uLampTwin, uv).rgb; }
void main() {
  // bilinear at the slot's texel centres: exact at the same size, a 2x2 average when a phone tier halves it
  vec2 uv = vUv;
  if (uScrU.w > 0.0) {
    vec3 d = dirOf(vUv);
    float dn = dot(d, uScrN), s = dot(uScrC - uPos, uScrN);
    if (dn < -1e-4 && s < 0.0) {                       // the probe is in front of the screen and the ray meets its plane
      vec3 h = uPos + d * (s / dn) - uScrC;
      vec2 q = vec2(dot(h, uScrU.xyz), dot(h, uScrV.xyz));
      vec2 ext = vec2(uScrU.w, uScrV.w) + 0.012;       // the screen and its anti-aliased edge (the bezel is dark)
      if (abs(q.x) < ext.x && abs(q.y) < ext.y) {
        vec2 gap = ext - abs(q);
        vec2 e = gap.x < gap.y ? vec2(sign(q.x) * (ext.x + 0.02), q.y) : vec2(q.x, sign(q.y) * (ext.y + 0.02));
        uv = uvOf(normalize(uScrC + e.x * uScrU.xyz + e.y * uScrV.xyz - uPos));
      }
    }
  }
  outColor = vec4(at(uv), 1.0);
}`;

// The lamp's probe (round 5): the brass arms reflected the room from the desk probe 1 m away, 2-3x too bright. The
// engine renders a probe at the lamp from the light-mapped room once the light is bound: a cube camera inside the lamp,
// the lamp's own triangles left out (uLampProbe.z), the desk mirror off, and behind everything a sphere carrying slot
// 0's panorama, which fills the window opening (the outside is another pass, not in the room scene); then PMREM.
const SKY_VS = /* glsl */ `
precision highp float;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
out vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}`;
const SKY_FS = /* glsl */ `
precision highp float;
uniform sampler2D uPano;
in vec3 vDir;
out vec4 outColor;
#define PI 3.141592653589793
void main() {
  vec3 d = normalize(vDir);
  vec2 uv = vec2(atan(d.z, d.x) / (2.0 * PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
  outColor = vec4(textureLod(uPano, uv, 0.0).rgb, 1.0);
}`;

const hdrTarget = (w, h) => new THREE.WebGLRenderTarget(w, h, {
  type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  generateMipmaps: false, colorSpace: THREE.NoColorSpace,
});

export class Probes {
  constructor(renderer, fs, width = 512) {
    this.renderer = renderer;
    this.fs = fs;
    this.width = width;               // slot size: 512 x 256 (desktop), 256 x 128 (T1); fixes the room's CUBEUV defines
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.cache = new Map();          // url -> Promise<equirect render target (three's mapping, linear HDR)>
    this.slots = [null, null];       // { sum: equirect target, cube: PMREM target }
    this.dUniforms = { uSrc: { value: null }, uScale: { value: new THREE.Vector3(1, 1, 1) } };
    this.decode = fullscreenMaterial(DECODE_FS, this.dUniforms, { blending: THREE.NoBlending });
    this.decode.name = "probe:decode";
    this.sUniforms = { uMain: { value: null }, uLampTwin: { value: null }, uLamp: { value: 0 }, uPos: { value: new THREE.Vector3() },
      uScrC: { value: new THREE.Vector3() }, uScrU: { value: new THREE.Vector4(1, 0, 0, 0) }, uScrV: { value: new THREE.Vector4(0, 1, 0, 0) },
      uScrN: { value: new THREE.Vector3(0, 0, 1) } };
    this.sum = fullscreenMaterial(SUM_FS, this.sUniforms, { blending: THREE.NoBlending });
    this.sum.name = "probe:sum";
    this.black = null;
    this.skyUniforms = { uPano: { value: null } };
    this.skyMat = new THREE.RawShaderMaterial({ name: "probe:sky", glslVersion: THREE.GLSL3, vertexShader: SHADER_NONCE + SKY_VS, fragmentShader: SHADER_NONCE + SKY_FS,
      uniforms: this.skyUniforms, side: THREE.BackSide, depthWrite: false });
    this.lamp = null;                // { target: cube render target, camera, sky, cube: PMREM target }
  }

  /** The CUBEUV_* defines every room material is compiled with (probe size by tier: 512x256, phones 256x128). */
  static defines(probeWidth = 512) {
    // PMREMGenerator (three 0.169): cube size = 2^floor(log2(width / 4)); its target is 4 x cube size tall
    const size = 2 ** Math.floor(Math.log2(probeWidth / 4));
    return cubeUVDefines(4 * size);
  }

  /** Fetch and decode one probe file to an HDR equirect (cached by URL). */
  load(bakeUrl, entry) {
    const url = within(bakeUrl, entry.file);
    if (!this.cache.has(url)) {
      this.cache.set(url, (async () => {
        const bmp = await fetchBitmap(url);
        await nextTask();
        const src = dataTexture(bmp, { filter: THREE.NearestFilter, name: url });
        const eq = hdrTarget(bmp.width, bmp.height);
        this.dUniforms.uSrc.value = src;
        this.dUniforms.uScale.value.fromArray(entry.scale);
        this.renderer.setRenderTarget(eq);
        this.fs.draw(this.renderer, this.decode);
        this.renderer.setRenderTarget(null);
        src.dispose();
        bmp.close?.();
        return eq;
      })());
    }
    return this.cache.get(url);
  }

  /** Load a moment's probes and their lamp twins (no visible change). */
  async prepare(bakeUrl, moment) {
    const ps = (moment.probes || []).slice(0, 2);
    return Promise.all(ps.map(async (p) => ({ p, main: await this.load(bakeUrl, p), lamp: p.lamp ? await this.load(bakeUrl, p.lamp) : null })));
  }

  /**
   * Rebuild the two slots for prepared probes at a lamp level and bind them: uProbeA/B and their positions.
   * Each slot is one short task (sum, then PMREM).
   */
  async build(prepared, lampLevel, shared) {
    if (!prepared.length) return;
    for (let i = 0; i < 2; i++) {
      const src = prepared[Math.min(i, prepared.length - 1)];
      const w = this.width, h = this.width / 2;
      let slot = this.slots[i];
      if (!slot || slot.sum.width !== w) {
        if (slot) { slot.sum.dispose(); slot.cube.dispose(); }
        slot = this.slots[i] = { sum: hdrTarget(w, h), cube: null };
      }
      this.sUniforms.uMain.value = src.main.texture;
      this.sUniforms.uLampTwin.value = src.lamp ? src.lamp.texture : src.main.texture;
      this.sUniforms.uLamp.value = src.lamp ? lampLevel : 0;
      this.sUniforms.uPos.value.fromArray(src.p.position);
      for (const k of ["uScrC", "uScrU", "uScrV", "uScrN"]) this.sUniforms[k].value.copy(shared[k].value);
      if (this.keepScreen) this.sUniforms.uScrU.value.w = 0;
      this.renderer.setRenderTarget(slot.sum);
      this.fs.draw(this.renderer, this.sum);
      slot.sum.texture.mapping = THREE.EquirectangularReflectionMapping;
      slot.cube = this.pmrem.fromEquirectangular(slot.sum.texture, slot.cube);
      this.renderer.setRenderTarget(null);
      const key = i === 0 ? "A" : "B";
      shared[`uProbe${key}`].value = slot.cube.texture;
      shared[`uProbePos${key}`].value.fromArray(src.p.position);
      if (i === 0) await nextTask();
    }
    this.lampLevel = lampLevel;
  }

  /**
   * Render the lamp's probe at `position` from the room as it is now lit and bind it as uProbeC (call after the
   * light layers and slots are bound). The cube is a quarter of the slot width, so its PMREM matches the CUBEUV
   * defines. Returns false when there is nothing to fill the window from yet.
   */
  buildLamp(room, shared, position) {
    if (!this.slots[0]) return false;
    const r = this.renderer, size = this.width / 4;
    let L = this.lamp;
    if (!L || L.target.width !== size) {
      if (L) { L.target.dispose(); L.cube?.dispose(); L.sky.geometry.dispose(); }
      const target = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.NoColorSpace });
      const sky = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), this.skyMat);
      sky.frustumCulled = false;
      sky.renderOrder = -1;
      L = this.lamp = { target, camera: new THREE.CubeCamera(0.02, 100, target), sky, cube: null };
    }
    L.camera.position.copy(position);
    L.camera.updateMatrixWorld(true);
    L.sky.position.copy(position);
    this.skyUniforms.uPano.value = this.slots[0].sum.texture;
    const autoClear = r.autoClear, clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    const mirrorOn = shared.uMirrorInfo.value.z;
    r.autoClear = true;
    r.setClearColor(0x000000, 1);
    shared.uMirrorInfo.value.z = 0;
    shared.uLampProbe.value.z = 1;
    room.setMode("live");
    room.scene.add(L.sky);
    L.camera.update(r, room.scene);
    room.scene.remove(L.sky);
    shared.uLampProbe.value.z = 0;
    shared.uMirrorInfo.value.z = mirrorOn;
    r.autoClear = autoClear;
    r.setClearColor(clear, alpha);
    L.cube = this.pmrem.fromCubemap(L.target.texture, L.cube);
    r.setRenderTarget(null);
    shared.uProbeC.value = L.cube.texture;
    shared.uProbePosC.value.copy(position);
    return true;
  }

  evict(keepUrls) {
    for (const [url, p] of this.cache) {
      if (!keepUrls.has(url)) { p.then((rt) => rt.dispose()); this.cache.delete(url); }
    }
  }

  dispose() {
    for (const p of this.cache.values()) p.then((rt) => rt.dispose());
    this.cache.clear();
    for (const s of this.slots) if (s) { s.sum.dispose(); s.cube?.dispose(); }
    this.slots = [null, null];
    if (this.lamp) { this.lamp.target.dispose(); this.lamp.cube?.dispose(); this.lamp.sky.geometry.dispose(); this.lamp = null; }
    this.pmrem.dispose();
    this.decode.dispose();
    this.sum.dispose();
    this.skyMat.dispose();
  }
}
