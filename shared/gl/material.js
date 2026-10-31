// The room's surface shader (plan 2.2-2.4): light from additive baked layers, glossy reflection from two
// box-projected probes with specular occlusion, a clear coat, multiple-scattering energy compensation, and live
// sun and lamp highlights whose shadowing is read from the baked layers. One program serves every room material
// (material differences are uniforms), so the room costs one or two programs whatever the model holds.
import * as THREE from "three";
import { SHADER_NONCE } from "./context.js";

// ---------------------------------------------------------------- the split-sum lookup table (made at load)
/**
 * DFG table for GGX with height-correlated Smith visibility: scale and bias of F0 in the split-sum
 * approximation, 32 x 32 over (N.V, perceptual roughness), 64 importance samples per entry. About 5 ms.
 */
export function makeDFG(size = 32, samples = 64) {
  const data = new Float32Array(size * size * 4);
  const radInv = (i) => {
    let b = i;
    b = ((b << 16) | (b >>> 16)) >>> 0;
    b = (((b & 0x55555555) << 1) | ((b & 0xaaaaaaaa) >>> 1)) >>> 0;
    b = (((b & 0x33333333) << 2) | ((b & 0xcccccccc) >>> 2)) >>> 0;
    b = (((b & 0x0f0f0f0f) << 4) | ((b & 0xf0f0f0f0) >>> 4)) >>> 0;
    b = (((b & 0x00ff00ff) << 8) | ((b & 0xff00ff00) >>> 8)) >>> 0;
    return b / 4294967296;
  };
  for (let j = 0; j < size; j++) {
    const rough = Math.max((j + 0.5) / size, 0.02);
    const a = rough * rough, a2 = a * a;
    for (let i = 0; i < size; i++) {
      const NoV = Math.max((i + 0.5) / size, 1e-3);
      const V = [Math.sqrt(1 - NoV * NoV), 0, NoV];
      let A = 0, B = 0;
      for (let s = 0; s < samples; s++) {
        const u1 = (s + 0.5) / samples, u2 = radInv(s);
        const phi = 2 * Math.PI * u2;
        const cosT = Math.sqrt((1 - u1) / (1 + (a2 - 1) * u1));
        const sinT = Math.sqrt(1 - cosT * cosT);
        const H = [sinT * Math.cos(phi), sinT * Math.sin(phi), cosT];
        const VoH = V[0] * H[0] + V[1] * H[1] + V[2] * H[2];
        const L2 = 2 * VoH * H[2] - V[2];
        const NoL = Math.max(L2, 0), NoH = Math.max(H[2], 0);
        if (NoL > 0) {
          const gv = NoL * Math.sqrt(NoV * NoV * (1 - a2) + a2);
          const gl = NoV * Math.sqrt(NoL * NoL * (1 - a2) + a2);
          const Vis = 0.5 / (gv + gl);
          const Gv = (4 * Vis * NoL * VoH) / NoH;
          const Fc = Math.pow(1 - VoH, 5);
          A += (1 - Fc) * Gv;
          B += Fc * Gv;
        }
      }
      const k = (j * size + i) * 4;
      data[k] = A / samples;
      data[k + 1] = B / samples;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- shared uniforms (one object, every material)
const white = (() => {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
})();
const black = (() => {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
})();
const flatNormal = (() => {
  const t = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
})();
export const DEFAULT_TEXTURES = { white, black, flatNormal };

/** Uniforms every room material shares: the light state, the probes, the layer switches. */
export function sharedUniforms() {
  return {
    uLayerW: { value: new THREE.Vector4(1, 0, 0, 1) },        // ambient, sun, lamp, screen weights
    // v3/laptop-phone: the laptop screen's own surface (its page and the light on it; not its glow on the room), scaled
    // per moment by engine.setScreenGain so it shows the photographs' screen white (the gains measured, room3d.json
    // laptop_screen.texture)
    uScreenEmit: { value: new THREE.Vector3(1, 1, 1) },
    // DYS-11: the inverse of the night white balance (colour.js uCat) on that surface only, so the page keeps the
    // photographs' screen white through the composite (the matched photographs leave the screen out of the balance,
    // scripts/walls/walls_photos.py; its glow on the room takes it, there as here). Identity when the balance is off
    uScreenCat: { value: new THREE.Matrix3() },
    uSwitch: { value: new THREE.Vector4(1, 1, 1, 1) },        // probes(spec), coat, specular occlusion, energy compensation
    uSwitch2: { value: new THREE.Vector4(1, 1, 0, 1) },       // detail, highlights, B-spline light maps, mirror far (v1.7)
    // v3/shimmer: the material maps' LOD bias, set by the engine on moving frames only (0 at rest): a moving view's
    // grain and text sparkle less, a still frame is as sharp as ever
    uMoveBias: { value: 0 },
    uDetail: { value: white },
    uDetailUV2: { value: 0 },
    uDFG: { value: null },
    uProbeA: { value: black }, uProbeB: { value: black },     // PMREM(probe + lamp level x lamp twin), probes.js
    uProbePosA: { value: new THREE.Vector3(0, 1, -0.7) },
    uProbePosB: { value: new THREE.Vector3(-1.5, 1.6, -0.6) },
    // the lamp's own probe (probes.js buildLamp): the engine renders it from the light-mapped room at the lamp
    uProbeC: { value: black },
    uProbePosC: { value: new THREE.Vector3(1, 1.15, -0.95) },
    uLampProbe: { value: new THREE.Vector4(0, 2, 0, 0) },      // on, the lamp's object id, hide the lamp (its probe is drawn)
    uBoxMin: { value: new THREE.Vector3(-2, 0, -1.45) },
    uBoxMax: { value: new THREE.Vector3(2, 2.9, 4) },
    uWindowRect: { value: new THREE.Vector4(-1.1, 1.1, 0.82, 2.55) },   // the window opening on the box's -z face: x0, x1, y0, y1
    uWallZ: { value: -1.2 },                                  // the window wall's inner face (room3d.json room.inner)
    // the laptop screen as a lit rectangle (room.js screenRect): centre, axis u + half-extent, axis v + half-extent,
    // front normal, radiance (0: none); scaled by the screen layer's weight
    uScrC: { value: new THREE.Vector3() },
    uScrU: { value: new THREE.Vector4(1, 0, 0, 0) },
    uScrV: { value: new THREE.Vector4(0, 1, 0, 0) },
    uScrN: { value: new THREE.Vector3(0, 0, 1) },
    uScrL: { value: new THREE.Vector3() },
    // (e1-v1.11) the laptop's lid around the screen, in the screen's frame: x0, x1 along uScrU, y0, y1 along uScrV
    // (room.js lidRect; x1 <= x0: none), and its front's radiance as a share of what a surface facing the room receives
    // (the black bezel's reflection of the room in front of it)
    uLid: { value: new THREE.Vector4(0, 0, 0, 0) },
    uLidK: { value: 0.06 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Vector3(0, 0, 0) },       // radiance-equivalent irradiance (E / pi), linear
    uLampPos: { value: new THREE.Vector3(1, 1.3, -0.86) },
    uLampDir: { value: new THREE.Vector3(0, -1, 0) },
    uLampColor: { value: new THREE.Vector3(0.3, 0.22, 0.14) },  // intensity: E/pi at 1 m on axis
    uLampCone: { value: new THREE.Vector2(Math.cos((62 * Math.PI) / 180), Math.cos((30 * Math.PI) / 180)) },
    // the desk mirror (mirror.js)
    uMirror: { value: black },
    uMirrorMatrix: { value: new THREE.Matrix4() },
    uMirrorInfo: { value: new THREE.Vector4(1, 1, 0, 0.75) },   // target width, height, on, plane height
    uMirrorFpx: { value: 1 },
    uMirrorPass: { value: 0 },                                   // 1 while the mirror itself is drawn (alpha = distance)
    // lobe width per roughness^2 (coat, base) and gain (coat, base; a base gain of 0 leaves the base lobe on the probes).
    // The base width is narrower than the GGX lobe: the mip pyramid is a box blur in screen space, which over-weights the
    // bright reflected window far from the point (fitted on the desk at golden, midday and night, 2026-10-15)
    uMirrorK: { value: new THREE.Vector4(1.3, 0.3, 1, 1) },
    uSpecTune: { value: new THREE.Vector4(1, 1, 1.3, 1) },      // calibration: walnut base specular, walnut coat, the screen's lit-rectangle footprint
    // DYS-151: the sunbeams' air (beams.js) is added in the room's own fragment, not by a second pass drawn with depth
    // EQUAL over the room: on iPhones (Apple's GPUs, WebKit) that test failed in whole 32 x 32 px screen tiles on the
    // moving frames, so the floor and walls showed blocks and patches with and without the air's light, gone at rest.
    // uBeamOn is 1 only around the engine's main room draws in a moment with room air (never for probes or mirrors);
    // the rest is the beams' state, set by beams.js
    uBeamOn: { value: 0 },
    uBeamShadow: { value: black },                            // metres along the sun's travel to the first surface
    uBeamShadowView: { value: new THREE.Matrix4() },
    uBeamShadowProj: { value: new THREE.Matrix4() },
    uBeam: { value: new THREE.Vector4(0, 0.55, 16, 0) },      // density (1/m), anisotropy g, steps, sample index
    uBeamK: { value: new THREE.Vector4(1, 1, 0, 0) },         // gains: sun, ambient (calibration; 1 = physical)
    uAirMin: { value: new THREE.Vector3(-1.98, 0.01, -1.18) },
    uAirMax: { value: new THREE.Vector3(1.98, 2.89, 3.98) },
  };
}

/** Uniforms one atlas shares (its layers). */
export function atlasUniforms() {
  return {
    uAmbient: { value: black }, uAmbientScale: { value: new THREE.Vector3(0, 0, 0) },
    uSun: { value: black }, uSunScale: { value: new THREE.Vector3(0, 0, 0) },
    uLamp: { value: black }, uLampScale: { value: new THREE.Vector3(0, 0, 0) },
    uScreen: { value: black }, uScreenScale: { value: new THREE.Vector3(0, 0, 0) },
    uAtlasTexel: { value: new THREE.Vector2(1 / 1024, 1024) },   // (DYS-156) its own maps' texel, size (engine.js)
  };
}

// ---------------------------------------------------------------- shaders
// (DYS-149: the room's object id (vObj) and the ID pass's ids (vId) compiled as smooth varyings, not flat ones. ANGLE's
// Metal backend (WebKit: every iPhone) rewrites the indices of every draw of a program with a flat varying (the GL's
// provoking vertex is a triangle's last, Metal's its first): every draw of the room, every frame it is drawn, and the
// ID pass's whenever picking, the steam or the sheen redraw it (outside.js's vehicles: ~330 MB of the GPU process, VG1).
// Both come from COLOR_0, one id per object, and every triangle of the room's model has its three corners in one object
// and one region (r1's room.glb: 66798 of 66798 triangles, FV's flatcheck.mjs), so the smooth value is that id all over
// the triangle, as the flat one was; where the fragment shader reads it, it is rounded (floor(x + 0.5): ids < 2^16,
// exact in a float). The shader text keeps "flat" and smoothIds takes it out as each program compiles (three.js's
// onBeforeCompile), because pageturn.js's sheet compiles this fragment shader with a vertex shader of its own (flat out
// float vObj) and GLSL ES 3.00 links only matching qualifiers: the sheet takes the room material's hook too (DYS-149
// mt-diet2: its material's onBeforeCompile is this one), so both its sides are smooth. ?flatvary=1: no hook, every
// program flat as before, to compare)
const FLAT_VARY = typeof location !== "undefined" && new URLSearchParams(location.search).get("flatvary") === "1";
function smoothIds(sh) {
  sh.vertexShader = sh.vertexShader.replace("flat out float vObj;", "out float vObj;").replace("flat out vec3 vId;", "out vec3 vId;");
  sh.fragmentShader = sh.fragmentShader.replace("flat in float vObj;", "in float vObj;").replace("flat in vec3 vId;", "in vec3 vId;");
}

const VS = /* glsl */ `
precision highp float;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 uUvXform;           // glTF KHR_texture_transform of the material's maps (tiling, offset, rotation)
uniform vec4 uLampProbe;
in vec3 position;
in vec3 normal;
in vec2 uv;
in vec2 uv1;
in vec2 uv2;
in vec4 color;                   // R1's COLOR_0 ids: object = R + 256 G (meshes without it read white: 65535)
out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
out vec2 vUv1;
out vec2 vUv2;
flat out float vObj;             // (compiled smooth: smoothIds above; the same at every corner of a triangle)
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = (uUvXform * vec3(uv, 1.0)).xy;
  vUv1 = uv1;
  vUv2 = uv2;
  vObj = floor(color.r * 255.0 + 0.5) + 256.0 * floor(color.g * 255.0 + 0.5);
  gl_Position = projectionMatrix * viewMatrix * wp;
  // while the lamp's probe is drawn from inside the lamp, the lamp leaves itself out (past the far plane: clipped)
  if (uLampProbe.z > 0.5 && abs(vObj - uLampProbe.y) < 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;

const FS = /* glsl */ `
precision highp float;
precision highp sampler2D;
#define texture2D texture
#define PI 3.141592653589793
uniform vec3 cameraPosition;
// material
uniform vec3 uAlbedo;
uniform sampler2D uAlbedoMap;
uniform sampler2D uRoughMap;     // glTF: G roughness, B metalness
uniform sampler2D uNormalMap;
uniform float uNormalScale;
uniform float uRoughness;
uniform float uMetalness;
uniform vec3 uSpecColor;         // F0 for dielectrics (0.04 x specular), before metalness
uniform float uCoat;
uniform float uCoatRough;
uniform sampler2D uCoatRoughMap;  // glTF clearcoatRoughnessTexture (G), times uCoatRough
uniform float uCoatRoughUV1;     // 1: the map is read with the light-map UVs (R1's walnut: texCoord 1)
uniform vec3 uEmissive;
uniform sampler2D uEmissiveMap;
uniform float uEmissiveScreen;   // 1: the emission follows the screen level
uniform float uLightmapped;      // 1: this mesh reads its atlas with uv1
// DYS-11: the walls' bounce light for their new paint (room.js WALL_BOUNCE; 0 on every other material): the gain - 1
// on the bake's bounced light, and per channel the bounced light's level against the window's own (r)
uniform vec3 uBounce;
uniform vec3 uBounceR;
uniform float uClean;            // DYS-11: ?wallclean (room.js): the walls' plaster scan eased to its mean, 0..1
// atlas
uniform sampler2D uAmbient; uniform vec3 uAmbientScale;
uniform sampler2D uSun;     uniform vec3 uSunScale;
uniform sampler2D uLamp;    uniform vec3 uLampScale;
uniform sampler2D uScreen;  uniform vec3 uScreenScale;
uniform vec2 uAtlasTexel;
// shared
uniform vec4 uLayerW;
uniform float uMoveBias;
uniform vec3 uScreenEmit;
uniform mat3 uScreenCat;
uniform vec4 uSwitch;
uniform vec4 uSwitch2;
uniform sampler2D uDetail;
uniform float uDetailUV2;
uniform sampler2D uDFG;
uniform sampler2D uProbeA;
uniform sampler2D uProbeB;
uniform vec3 uProbePosA;
uniform vec3 uProbePosB;
uniform sampler2D uProbeC;
uniform vec3 uProbePosC;
uniform vec4 uLampProbe;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec4 uWindowRect;
uniform float uWallZ;
uniform vec3 uScrC;
uniform vec4 uScrU;
uniform vec4 uScrV;
uniform vec3 uScrN;
uniform vec3 uScrL;
uniform vec4 uLid;
uniform float uLidK;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uLampPos;
uniform vec3 uLampDir;
uniform vec3 uLampColor;
uniform vec2 uLampCone;
uniform sampler2D uMirror;
uniform mat4 uMirrorMatrix;
uniform vec4 uMirrorInfo;
uniform float uMirrorFpx;
uniform float uMirrorPass;
uniform vec4 uMirrorK;
uniform vec4 uSpecTune;
uniform float uUseMirror;        // 1: this material's up-facing faces on the desk plane read the desk mirror
in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
in vec2 vUv1;
in vec2 vUv2;
flat in float vObj;              // (compiled smooth: smoothIds; rounded where it is read)
out vec4 outColor;

${THREE.ShaderChunk.cube_uv_reflection_fragment}

// the lamp's parts read the lamp's own probe: the desk probe, 1 m away, showed them the room 2-3x too bright (round 4)
bool lampPixel() { return uLampProbe.x > 0.5 && abs(floor(vObj + 0.5) - uLampProbe.y) < 0.5; }

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// a cube-root light map texel back to light
vec3 decode(vec3 t, vec3 s) { return t * t * t * s; }

// smooth 4-tap cubic B-spline sampling (plan 2.2: window-bar shadows don't stair-step close up)
vec3 sampleBS(sampler2D t, vec2 uv) {
  vec2 st = uv * uAtlasTexel.y - 0.5;
  vec2 i = floor(st), f = st - i;
  vec2 w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f * f - 3.0 * f * f * f) / 6.0;
  vec2 w3 = f * f * f / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (w1 / g0 - 1.0 + i + 0.5) * uAtlasTexel.x;
  vec2 h1 = (w3 / g1 + 1.0 + i + 0.5) * uAtlasTexel.x;
  vec3 a = texture(t, vec2(h0.x, h0.y)).rgb, b = texture(t, vec2(h1.x, h0.y)).rgb;
  vec3 c = texture(t, vec2(h0.x, h1.y)).rgb, d = texture(t, vec2(h1.x, h1.y)).rgb;
  return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}
vec3 layer(sampler2D t, vec2 uv, vec3 s) {
  vec3 c = uSwitch2.z > 0.5 ? sampleBS(t, uv) : texture(t, uv).rgb;
  return decode(c, s);
}

// DYS-11: the window opening's form factor from a point (Lambert's formula for a polygon): the share of the point's
// view that is the opening, so of its light that comes straight from outside. The opening is the window wall's inner
// face for points on it or in the room, the outer face for points in the reveals. Every wall face sees all of it or
// none (the window wall's own faces lie in its plane: 0), so no clipping at the horizon
float ffEdge(vec3 a, vec3 b, vec3 n) {
  vec3 c = cross(a, b);
  float l = length(c);
  return l > 1e-6 ? atan(l, dot(a, b)) * dot(c, n) / l : 0.0;
}
float windowFF(vec3 P, vec3 n) {
  vec4 W = uWindowRect;
  float z = P.z > uWallZ - 0.005 ? uWallZ : uBoxMin.z;
  vec3 a = normalize(vec3(W.x, W.z, z) - P), b = normalize(vec3(W.y, W.z, z) - P);
  vec3 c = normalize(vec3(W.y, W.w, z) - P), d = normalize(vec3(W.x, W.w, z) - P);
  return abs(ffEdge(a, b, n) + ffEdge(b, c, n) + ffEdge(c, d, n) + ffEdge(d, a, n)) / (2.0 * PI);
}
// the lamp's light straight onto a point, unshadowed, as the bake's spot has it (scripts/room.py: the cone's half
// angle, blend 0.8, no spill)
vec3 lampDirect(vec3 P, vec3 Ng) {
  vec3 toL = uLampPos - P;
  float d2 = max(dot(toL, toL), 0.01);
  vec3 L = toL * inversesqrt(d2);
  float cosHalf = sqrt(0.5 + 0.5 * uLampCone.x);
  float spot = smoothstep(0.0, 1.0, (dot(-L, uLampDir) - cosHalf) / (0.8 * (1.0 - cosHalf)));
  return uLampColor * spot * max(dot(Ng, L), 0.0) / d2;
}

vec3 boxDir(vec3 R, vec3 P, vec3 probe) {
  // the window wall: its inner face (uWallZ) for points in the room, with the opening a tunnel through to the outer
  // face (uBoxMin.z); points in the tunnel itself (frame, reveal, sill) use the outer face
  vec4 W = uWindowRect;
  bool inRoom = P.z > uWallZ + 0.002;
  if (R.z < 0.0 && inRoom) {
    float t0 = (uWallZ - P.z) / R.z;
    vec3 a = P + R * t0;
    if (a.x > W.x && a.x < W.y && a.y > W.z && a.y < W.w) {
      vec3 b = P + R * ((uBoxMin.z - P.z) / R.z);
      // straight through the opening: the outside is at infinity, no parallax
      if (b.x > W.x && b.x < W.y && b.y > W.z && b.y < W.w) return R;
      // into the reveal: where the ray meets the tunnel's side, sill or head
      float tx = R.x > 0.0 ? (W.y - P.x) / R.x : (R.x < 0.0 ? (W.x - P.x) / R.x : 1e9);
      float ty = R.y > 0.0 ? (W.w - P.y) / R.y : (R.y < 0.0 ? (W.z - P.y) / R.y : 1e9);
      return P + R * min(tx, ty) - probe;
    }
  }
  vec3 bmin = vec3(uBoxMin.xy, inRoom ? uWallZ : uBoxMin.z);
  vec3 tMax = (uBoxMax - P) / R, tMin = (bmin - P) / R;
  vec3 tf = max(tMax, tMin);
  float t = min(min(tf.x, tf.y), tf.z);
  vec3 hit = P + R * t;
  // from inside the tunnel, through the opening: the outside (the window frame's own steel sits on the outer face)
  if (!inRoom && R.z < 0.0 && tf.z <= min(tf.x, tf.y) && hit.x > W.x && hit.x < W.y && hit.y > W.z && hit.y < W.w) return R;
  return hit - probe;
}

float probeWeightB(vec3 P) {
  float da = distance(P, uProbePosA), db = distance(P, uProbePosB);
  return clamp(0.5 + (da - db) * 0.6, 0.0, 1.0);
}

// reflected light from the two probes (each already holds the lamp's share), box projected, at a roughness.
// The box correction applies in full at every roughness: fading it for wide lobes (E1 v1) looked up the window from
// the probe's own height for the desk's grazing reflections, where the desk sees the sill and the wall under it
// (desk mean dE 6.0 -> 5.6 and shelf 2.6 -> 2.5 at golden without dust, measured 2026-10-15).
vec3 probeRadiance(vec3 R, vec3 P, float rough, float wB) {
  if (lampPixel()) return textureCubeUV(uProbeC, normalize(boxDir(R, P, uProbePosC)), rough).rgb;
  vec3 dA = normalize(boxDir(R, P, uProbePosA));
  vec3 dB = normalize(boxDir(R, P, uProbePosB));
  return mix(textureCubeUV(uProbeA, dA, rough).rgb, textureCubeUV(uProbeB, dB, rough).rgb, wB);
}

// how much of a glossy lobe (width a = roughness^2, around R) lands on the screen's front, as the overlap of the lobe's
// footprint on the screen plane with the rectangle: the screen is closer than anything the probes project there
float screenCover(vec3 P, vec3 R, float a) {
  float dn = dot(R, uScrN);
  if (dn > -1e-3 || uScrU.w <= 0.0) return 0.0;
  float t = dot(uScrC - P, uScrN) / dn;
  if (t <= 0.0) return 0.0;
  vec3 h = P + R * t - uScrC;
  float r = max(t * a * uSpecTune.z, 1e-4);
  float x = dot(h, uScrU.xyz), y = dot(h, uScrV.xyz);
  float cx = clamp((min(x + r, uScrU.w) - max(x - r, -uScrU.w)) / (2.0 * r), 0.0, 1.0);
  float cy = clamp((min(y + r, uScrV.w) - max(y - r, -uScrV.w)) / (2.0 * r), 0.0, 1.0);
  return cx * cy;
}

// (e1-v1.11) the same for the laptop's whole lid (the screen and its bezel down to the hinge): a ray that meets the lid's
// front there sees the lid, not what the probes show behind it (the bright window, for the deck and the keys at a
// grazing view); the screen's glow is laid over it as before
float lidCover(vec3 P, vec3 R, float a) {
  float dn = dot(R, uScrN);
  if (dn > -1e-3 || uLid.y <= uLid.x) return 0.0;
  float t = dot(uScrC - P, uScrN) / dn;
  if (t <= 0.0) return 0.0;
  vec3 h = P + R * t - uScrC;
  float r = max(t * a * uSpecTune.z, 1e-4);
  float x = dot(h, uScrU.xyz), y = dot(h, uScrV.xyz);
  float cx = clamp((min(x + r, uLid.y) - max(x - r, uLid.x)) / (2.0 * r), 0.0, 1.0);
  float cy = clamp((min(y + r, uLid.w) - max(y - r, uLid.z)) / (2.0 * r), 0.0, 1.0);
  return cx * cy;
}

// what the probes predict a matte surface facing N would receive (E / pi), for specular occlusion and probe-lit meshes
vec3 probeIrradiance(vec3 N, float wB) {
  if (lampPixel()) return textureCubeUV(uProbeC, N, 1.0).rgb;
  return mix(textureCubeUV(uProbeA, N, 1.0).rgb, textureCubeUV(uProbeB, N, 1.0).rgb, wB);
}

// the desk mirror at a point of the desk plane, blurred for a lobe of width a (= roughness^2): the blur radius grows
// with how far the reflected thing is from the desk (alpha of the mirror = its distance from the virtual eye)
vec4 mirrorRadiance(vec3 P, vec3 N, float a, float k) {
  vec4 c = uMirrorMatrix * vec4(P, 1.0);
  vec2 uv = c.xy / c.w;
  uv += vec2(-N.x, N.z) * 0.02;               // the normal map's ripple, a little
  float dTot = textureLod(uMirror, uv, 0.0).a;
  float dEye = distance(cameraPosition, P);
  float dR = max(dTot - dEye, 0.0);
  float rpx = uMirrorFpx * k * a * dR / max(dTot, 1e-3);
  float lod = log2(max(2.0 * rpx, 1.0));
  vec2 edge = min(uv, 1.0 - uv);
  float w = clamp(min(edge.x, edge.y) * 20.0, 0.0, 1.0);   // fades to the probes at the guard band's edge
  // the window opening (mirror.js fills it at 1000 m): a reflection of something at infinity is the probes' job (blurred
  // in angle); the mirror's mips blur in screen space, so its widest levels averaged the whole reflected room into the
  // opening (at night the lit screen: a sharp-edged bright sheet on the desk beside the laptop)
  if (uSwitch2.w > 0.5) w *= clamp((300.0 - dTot) / 200.0, 0.0, 1.0);
  return vec4(textureLod(uMirror, uv, lod).rgb, w);
}

float D_GGX(float a, float NoH) {
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
float V_SmithCorrelated(float a, float NoV, float NoL) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}
vec3 F_Schlick(vec3 f0, float VoH) {
  float f = pow(1.0 - VoH, 5.0);
  return f0 + (1.0 - f0) * f;
}
// specular reflectance of a punctual light, times N.L
vec3 specLight(vec3 N, vec3 V, vec3 L, float a, vec3 f0) {
  vec3 H = normalize(V + L);
  float NoL = max(dot(N, L), 0.0), NoV = max(dot(N, V), 1e-4), NoH = max(dot(N, H), 0.0), VoH = max(dot(V, H), 0.0);
  return F_Schlick(f0, VoH) * (D_GGX(a, NoH) * V_SmithCorrelated(a, NoV, NoL) * NoL);
}

vec3 perturb(vec3 N, vec3 P, vec2 uv) {
  vec3 m = texture(uNormalMap, uv, uMoveBias).xyz * 2.0 - 1.0;
  if (abs(m.x) + abs(m.y) < 1e-3) return N;
  m.xy *= uNormalScale;
  vec3 q0 = dFdx(P), q1 = dFdy(P);
  vec2 s0 = dFdx(uv), s1 = dFdy(uv);
  vec3 q1p = cross(q1, N), q0p = cross(N, q0);
  vec3 T = q1p * s0.x + q0p * s1.x;
  vec3 B = q1p * s0.y + q0p * s1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = det == 0.0 ? 0.0 : inversesqrt(det);
  return normalize(T * (m.x * sc) + B * (m.y * sc) + N * m.z);
}

#ifdef ALPHA_CUT
uniform float uAlphaCut;         // cut-out leaves and the like (glTF alphaMode MASK); refining smooths the edges
#endif

// ---- DYS-151: the sunbeams' air toward the eye in front of this surface (beams.js has the physics; this is its
// BEAM_FS, moved into the room's own draw so no second pass has to find this surface again by depth EQUAL). Its shadow
// map is the room's 16th sampler, WebGL2's guaranteed minimum: a program made from this one with samplers of its own
// (the notebook's page turn, pageturn.js) defines SFW_NO_BEAM_AIR and goes without the air (R12: "texture image units
// count exceeds MAX_TEXTURE_IMAGE_UNITS", room:pageturn, Chrome and WebKit)
#ifndef SFW_NO_BEAM_AIR
uniform float uBeamOn;
uniform sampler2D uBeamShadow;
uniform mat4 uBeamShadowView;
uniform mat4 uBeamShadowProj;
uniform vec4 uBeam;
uniform vec4 uBeamK;
uniform vec3 uAirMin;
uniform vec3 uAirMax;
float beamIgn(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float beamSunlit(vec3 X) {
  vec4 v = uBeamShadowView * vec4(X, 1.0);
  vec4 c = uBeamShadowProj * v;
  vec2 uv = c.xy / c.w * 0.5 + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  return -v.z <= texture(uBeamShadow, uv).r + 0.015 ? 1.0 : 0.0;
}
vec3 beamAir(vec3 P) {
  vec3 C = cameraPosition;
  vec3 D = P - C;
  float tEnd = length(D);
  vec3 r = D / max(tEnd, 1e-6);
  vec3 inv = 1.0 / r;
  vec3 t0 = (uAirMin - C) * inv, t1 = (uAirMax - C) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float a = max(max(max(tn.x, tn.y), tn.z), 0.0);
  float b = min(min(min(tf.x, tf.y), tf.z), tEnd);
  if (b <= a) return vec3(0.0);
  float len = b - a;
  float n = uBeam.z;
  float o = fract(beamIgn(gl_FragCoord.xy) + uBeam.w * 0.6180339887);
  float dt = len / n;
  float lit = 0.0;
  for (int i = 0; i < 64; i++) {
    if (float(i) >= n) break;
    lit += beamSunlit(C + r * (a + (float(i) + o) * dt));
  }
  lit *= dt;
  float g = uBeam.y, cosT = dot(uSunDir, r);
  float hg = (1.0 - g * g) / (4.0 * PI * pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-4), 1.5));
  vec3 sun = hg * PI * uSunColor * lit;
  vec3 M = C + r * (a + 0.5 * len);
  float wB = clamp(0.5 + (distance(M, uProbePosA) - distance(M, uProbePosB)) * 0.6, 0.0, 1.0);
  vec3 amb = mix(textureCubeUV(uProbeA, r, 1.0).rgb, textureCubeUV(uProbeB, r, 1.0).rgb, wB) * len;
  return uBeam.x * (uBeamK.x * sun + uBeamK.y * amb);
}
#endif

void main() {
  vec4 albedoT = texture(uAlbedoMap, vUv, uMoveBias);
  // DYS-11: the plaster scan's streaks, mottling and dark specks (plaster_base, +-2 % grain, specks to -16 %) read as a
  // dirty wall: eased toward the map's own mean (its last mip level), so the paint's colour stays; the normal map's
  // relief and the light stay as they are
  if (uClean > 0.0) albedoT.rgb = mix(albedoT.rgb, textureLod(uAlbedoMap, vec2(0.5), 16.0).rgb, uClean);
#ifdef ALPHA_CUT
  if (albedoT.a < uAlphaCut) discard;
#endif
  vec3 Ng = normalize(vNormal);
  if (!gl_FrontFacing) Ng = -Ng;
  vec3 P = vWorldPos;
  vec3 V = normalize(cameraPosition - P);
  vec3 N = perturb(Ng, P, vUv);

  vec3 albedo = uAlbedo * albedoT.rgb;
  vec4 rm = texture(uRoughMap, vUv, uMoveBias);
  float rough = clamp(uRoughness * rm.g, 0.02, 1.0);
  float metal = clamp(uMetalness * rm.b, 0.0, 1.0);
  // roughness raised where the normal varies inside one pixel (stops the clear coat and brass from sparkling)
  vec3 dn = fwidth(N);
  float kernel = min(0.5 * dot(dn, dn), 0.18);
  float a = sqrt(clamp(rough * rough * rough * rough + kernel, 0.0, 1.0));
  rough = sqrt(a);

  float wB = probeWeightB(P);
  bool onMirror = uMirrorInfo.z > 0.5 && uUseMirror > 0.5 && uMirrorPass < 0.5 && Ng.y > 0.98 && abs(P.y - uMirrorInfo.w) < 0.004;

  // ---- baked light: the layers add up
  vec3 probeE = probeIrradiance(Ng, wB);
  vec3 Lb;
  float detail = 1.0;
  vec3 sunL = vec3(0.0), lampL = vec3(0.0);
  if (uLightmapped > 0.5) {
    vec3 amb = layer(uAmbient, vUv1, uAmbientScale);
    sunL = layer(uSun, vUv1, uSunScale);
    lampL = layer(uLamp, vUv1, uLampScale);
    vec3 scr = layer(uScreen, vUv1, uScreenScale);
    Lb = uLayerW.x * amb + uLayerW.y * sunL + uLayerW.z * lampL + uLayerW.w * scr;
    // DYS-11: the walls' extra bounce. What reaches a wall straight from the window (its form factor against r), the
    // sun (its layer is direct light only) and the lamp (twice its unshadowed direct light, to be safe) stays as baked
    if (dot(uBounce, uBounce) > 0.0) {
      vec3 g = uBounce / (1.0 + windowFF(P, Ng) / uBounceR);
      Lb += g * (uLayerW.x * amb + uLayerW.z * max(lampL - 2.0 * lampDirect(P, Ng), 0.0));
    }
    if (uSwitch2.x > 0.5) detail = texture(uDetail, uDetailUV2 > 0.5 ? vUv2 : vUv1, uMoveBias).r;
    Lb *= detail;
  } else {
    Lb = probeE * (uLayerW.x > 0.0 ? 1.0 : 0.0);
  }

  // ---- specular: split sum with multiple-scattering energy compensation (Fdez-Aguera)
  float NoV = clamp(dot(N, V), 1e-4, 1.0);
  vec3 f0 = mix(uSpecColor, albedo, metal);
  vec2 dfg = texture(uDFG, vec2(NoV, rough)).rg;
  vec3 FssEss = f0 * dfg.x + dfg.y;
  float Ess = dfg.x + dfg.y;
  float Ems = 1.0 - Ess;
  vec3 Favg = f0 + (1.0 - f0) * 0.047619;
  vec3 Fms = FssEss * Favg / (1.0 - Ems * Favg);
  vec3 multi = uSwitch.w > 0.5 ? Fms * Ems : vec3(0.0);
  float specK = uUseMirror > 0.5 ? uSpecTune.x : 1.0;   // Blender's "Specular IOR Level" / 0.5, for calibration
  FssEss *= specK; multi *= specK;
  vec3 total = FssEss + multi;

  // specular occlusion: the bake says how much light really arrives here, the probe what it would predict
  float so = 1.0;
  if (uSwitch.z > 0.5) {
    so = clamp(lum(Lb) / max(lum(probeE), 1e-5), 0.0, 1.0);
    so = so * detail;
  }

  vec3 diffuse = albedo * (1.0 - metal) * (1.0 - max(max(total.r, total.g), total.b)) * Lb;
  vec3 spec = vec3(0.0);
  if (uSwitch.x > 0.5) {
    vec3 R = reflect(-V, N);
    vec3 env = probeRadiance(R, P, rough, wB) * so;
    if (uEmissiveScreen < 0.5 && !onMirror) {
      env = mix(env, probeIrradiance(uScrN, wB) * uLidK, lidCover(P, R, rough * rough));
      env = mix(env, uScrL * uLayerW.w, screenCover(P, R, rough * rough));
    }
    if (onMirror && uMirrorK.w > 0.0) {
      vec4 mr = mirrorRadiance(P, N, rough * rough, uMirrorK.y);
      env = mix(env, mr.rgb * uMirrorK.w * detail, mr.w);
    }
    spec = env * FssEss + multi * Lb;
  }

  // ---- live highlights: the sun and the lamp, shadowed by what the bake says reaches the point
  if (uSwitch2.y > 0.5) {
    float NoLs = dot(N, uSunDir);
    if (NoLs > 0.0 && lum(uSunColor) > 0.0) {
      float vis = uLightmapped > 0.5 ? clamp(lum(sunL) / max(lum(uSunColor) * max(dot(Ng, uSunDir), 1e-3), 1e-6), 0.0, 1.0) : 1.0;
      float as = max(a, 0.03);
      spec += uLayerW.y * vis * PI * uSunColor * specLight(N, V, uSunDir, as, f0);
    }
    if (uLayerW.z > 0.0) {
      vec3 toL = uLampPos - P;
      float d2 = max(dot(toL, toL), 0.01);
      vec3 L = toL * inversesqrt(d2);
      float cone = 0.06 + 0.94 * pow(clamp((dot(-L, uLampDir) - uLampCone.x) / (uLampCone.y - uLampCone.x), 0.0, 1.0), 1.5);
      float NoLl = max(dot(Ng, L), 1e-3);
      vec3 direct = uLampColor * cone * NoLl / d2;
      float vis = uLightmapped > 0.5 ? clamp(lum(lampL) / max(lum(direct), 1e-6), 0.0, 1.0) : 1.0;
      spec += uLayerW.z * vis * PI * uLampColor * cone / d2 * specLight(N, V, L, max(a, 0.05), f0);
    }
  }

  vec3 color = diffuse + spec;

  // ---- clear coat (walnut 0.3): its own lobe on the geometric normal, dimming what lies under it
  float coatW = uCoat * (uUseMirror > 0.5 ? uSpecTune.y : 1.0);
  if (coatW > 0.0 && uSwitch.y > 0.5) {
    float NoVc = clamp(dot(Ng, V), 1e-4, 1.0);
    float cr = clamp(uCoatRough * texture(uCoatRoughMap, uCoatRoughUV1 > 0.5 ? vUv1 : vUv, uMoveBias).g, 0.02, 1.0);
    vec2 dfgc = texture(uDFG, vec2(NoVc, cr)).rg;
    float Fc = 0.04 + 0.96 * pow(1.0 - NoVc, 5.0);
    vec3 coatSpec = vec3(0.0);
    if (uSwitch.x > 0.5) {
      vec3 env = probeRadiance(reflect(-V, Ng), P, cr, wB) * so;
      if (uEmissiveScreen < 0.5 && !onMirror) {
        env = mix(env, probeIrradiance(uScrN, wB) * uLidK, lidCover(P, reflect(-V, Ng), cr * cr));
        env = mix(env, uScrL * uLayerW.w, screenCover(P, reflect(-V, Ng), cr * cr));
      }
      if (onMirror) {
        vec4 mr = mirrorRadiance(P, Ng, cr * cr, uMirrorK.x);
        env = mix(env, mr.rgb * uMirrorK.z * detail, mr.w);
      }
      coatSpec = env * (0.04 * dfgc.x + dfgc.y);
    }
    if (uSwitch2.y > 0.5 && dot(Ng, uSunDir) > 0.0 && lum(uSunColor) > 0.0) {
      float vis = uLightmapped > 0.5 ? clamp(lum(sunL) / max(lum(uSunColor) * max(dot(Ng, uSunDir), 1e-3), 1e-6), 0.0, 1.0) : 1.0;
      coatSpec += uLayerW.y * vis * PI * uSunColor * specLight(Ng, V, uSunDir, max(cr * cr, 0.03), vec3(0.04));
    }
    color = color * (1.0 - coatW * Fc) + coatW * coatSpec;
  }

  vec3 em = uEmissive * texture(uEmissiveMap, vUv, uMoveBias).rgb;
  if (uEmissiveScreen > 0.5) { em *= uLayerW.w; color = uScreenCat * ((color + em) * uScreenEmit); }
  else color += em;
  color = max(color, 0.0);
  // the room's air in front of this surface (DYS-151; once per room sample, as the beams' own pass was)
#ifndef SFW_NO_BEAM_AIR
  if (uBeamOn > 0.5 && uMirrorPass < 0.5) color += beamAir(P);
#endif
  outColor = vec4(color, uMirrorPass > 0.5 ? distance(cameraPosition, P) : 1.0);
}`;

/**
 * A room material from a glTF material (MeshStandardMaterial / MeshPhysicalMaterial made by GLTFLoader).
 * `shared` and `atlas` are uniform objects shared by reference, so changing the light changes every material.
 */
export function roomMaterial(src, shared, atlas, { lightmapped, screen = false, cubeUV }) {
  const u = {
    uAlbedo: { value: new THREE.Vector3(1, 1, 1) },
    uAlbedoMap: { value: src.map || white },
    uRoughMap: { value: src.roughnessMap || src.metalnessMap || white },
    uNormalMap: { value: src.normalMap || flatNormal },
    uNormalScale: { value: src.normalScale ? src.normalScale.x : 1 },
    uRoughness: { value: src.roughness ?? 0.5 },
    uMetalness: { value: src.metalness ?? 0 },
    uSpecColor: { value: new THREE.Vector3(0.04, 0.04, 0.04) },
    uCoat: { value: src.clearcoat || 0 },
    uCoatRough: { value: src.clearcoatRoughness ?? 0.03 },
    uCoatRoughMap: { value: src.clearcoatRoughnessMap || white },
    uCoatRoughUV1: { value: src.clearcoatRoughnessMap?.channel === 1 ? 1 : 0 },
    uEmissive: { value: new THREE.Vector3(0, 0, 0) },
    uEmissiveMap: { value: src.emissiveMap || white },
    uEmissiveScreen: { value: screen ? 1 : 0 },
    uLightmapped: { value: lightmapped ? 1 : 0 },
    uUvXform: { value: uvTransform(src) },
    uAlphaCut: { value: alphaCut(src) },
    uUseMirror: { value: src.userData?.sfw?.class === "walnut" ? 1 : 0 },
    uBounce: { value: new THREE.Vector3(0, 0, 0) },        // DYS-11: set on the walls by room.js (wallBounce)
    uBounceR: { value: new THREE.Vector3(1, 1, 1) },
    uClean: { value: 0 },
  };
  if (src.color) u.uAlbedo.value.set(src.color.r, src.color.g, src.color.b);   // linear already (three converts sRGB hex)
  if (src.specularIntensity !== undefined) {
    const ior = src.ior ?? 1.5;
    const f = ((ior - 1) / (ior + 1)) ** 2 * src.specularIntensity;
    const c = src.specularColor || { r: 1, g: 1, b: 1 };
    u.uSpecColor.value.set(Math.min(1, f * c.r), Math.min(1, f * c.g), Math.min(1, f * c.b));
  }
  if (src.emissive) {
    const k = src.emissiveIntensity ?? 1;
    u.uEmissive.value.set(src.emissive.r * k, src.emissive.g * k, src.emissive.b * k);
  }
  const m = new THREE.RawShaderMaterial({
    name: `room:${src.name || ""}`,
    glslVersion: THREE.GLSL3,
    vertexShader: SHADER_NONCE + VS,
    fragmentShader: SHADER_NONCE + FS,
    uniforms: { ...u, ...shared, ...atlas },
    defines: {
      ENVMAP_TYPE_CUBE_UV: "",
      CUBEUV_TEXEL_WIDTH: cubeUV.texelWidth,
      CUBEUV_TEXEL_HEIGHT: cubeUV.texelHeight,
      CUBEUV_MAX_MIP: cubeUV.maxMip.toFixed(1),
      // the vertex shader declares COLOR_0 (`in vec4 color`, the lamp's id); stream I's patch (interact.js) adds its
      // own declaration only #ifndef VERTEX_IDS, as for the ID pass
      VERTEX_IDS: "",
      ...(alphaCut(src) > 0 ? { ALPHA_CUT: "" } : {}),   // a second program only for cut-out materials
    },
    side: THREE.DoubleSide,
    transparent: false,
  });
  if (!FLAT_VARY) m.onBeforeCompile = smoothIds;   // (DYS-149: vObj smooth, not flat; ?flatvary=1 flat)
  return m;
}

/** The glTF texture transform of a material's maps (three.js keeps it on each texture; the room uses the first). */
export function uvTransform(src) {
  const t = src.map || src.normalMap || src.roughnessMap || src.metalnessMap || src.emissiveMap;
  if (!t) return new THREE.Matrix3();
  t.updateMatrix();
  return t.matrix.clone();
}

/** Cut-out threshold: glTF MASK materials (alphaTest), and BLEND ones treated as cut-outs at 0.5 (no sorting). */
export function alphaCut(src) {
  if (!src.map) return 0;
  if (src.alphaTest > 0) return src.alphaTest;
  return src.transparent ? 0.5 : 0;
}

/** CUBEUV_* defines for a PMREM render target of this height (as three.js computes them). */
export function cubeUVDefines(imageHeight) {
  const maxMip = Math.log2(imageHeight) - 2;
  return { texelHeight: 1 / imageHeight, texelWidth: 1 / (3 * Math.max(2 ** maxMip, 7 * 16)), maxMip };
}

// ---------------------------------------------------------------- the ID pass (picking and QA regions)
const ID_FS = /* glsl */ `
precision highp float;
uniform vec3 uId;           // region, object low byte, object high byte (0..255 each)
#ifdef VERTEX_IDS
flat in vec3 vId;           // (compiled smooth: smoothIds; rounded where it is read)
#endif
#ifdef ALPHA_CUT
uniform sampler2D uAlbedoMap;
uniform float uAlphaCut;
in vec2 vUv;
#endif
out vec4 outColor;
void main() {
#ifdef ALPHA_CUT
  if (texture(uAlbedoMap, vUv).a < uAlphaCut) discard;
#endif
#ifdef VERTEX_IDS
  outColor = vec4(floor(vId + 0.5) / 255.0, 1.0);
#else
  outColor = vec4(uId / 255.0, 1.0);
#endif
}`;
const ID_VS = /* glsl */ `
precision highp float;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
#ifdef VERTEX_IDS
in vec4 color;              // R1's COLOR_0: object = R + 256 G, region = B (8-bit exact)
flat out vec3 vId;          // (compiled smooth: smoothIds; the same at every corner of a triangle)
#endif
#ifdef ALPHA_CUT
uniform mat3 uUvXform;
in vec2 uv;
out vec2 vUv;
#endif
void main() {
#ifdef VERTEX_IDS
  vec3 c = floor(color.rgb * 255.0 + 0.5);
  vId = vec3(c.b, c.r, c.g);  // ID buffer: R region, G object low byte, B object high byte
#endif
#ifdef ALPHA_CUT
  vUv = (uUvXform * vec3(uv, 1.0)).xy;
#endif
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}`;

/** The ID material for one (region, object); cut-out materials pass their map so leaves pick and mask correctly. */
export function idMaterial(region, object, src = null, { vertexIds = false } = {}) {
  const cut = src ? alphaCut(src) : 0;
  const m = new THREE.RawShaderMaterial({
    name: "room:id",
    glslVersion: THREE.GLSL3,
    vertexShader: SHADER_NONCE + ID_VS,
    fragmentShader: SHADER_NONCE + ID_FS,
    uniforms: {
      uId: { value: new THREE.Vector3(region, object & 255, object >> 8) },
      ...(cut > 0 ? { uAlbedoMap: { value: src.map }, uAlphaCut: { value: cut }, uUvXform: { value: uvTransform(src) } } : {}),
    },
    defines: { ...(cut > 0 ? { ALPHA_CUT: "" } : {}), ...(vertexIds ? { VERTEX_IDS: "" } : {}) },
    side: THREE.DoubleSide,
  });
  if (vertexIds && !FLAT_VARY) m.onBeforeCompile = smoothIds;   // (DYS-149: vId smooth, not flat; ?flatvary=1 flat)
  return m;
}
