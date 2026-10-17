// Loading: the room model (glTF with meshopt compression, optional KTX2 textures), the light-map layers and probes
// listed in bake.json, and data textures decoded with no colour conversion (docs/v3/engine-api.md section 10).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "meshoptimizer/meshopt_decoder.module.js";

const VENDOR_THREE = new URL("../../vendor/three-0.169.0/", import.meta.url);

export async function loadModel(url, renderer, { onProgress } = {}) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const buf = await fetchBytes(url, onProgress);
  if (needsKTX2(buf)) {
    // the Basis transcoder is 204 KB brotli: only fetched when the model really has KTX2 textures
    const { KTX2Loader } = await import("three/addons/loaders/KTX2Loader.js");
    const ktx2 = new KTX2Loader().setTranscoderPath(new URL("addons/libs/basis/", VENDOR_THREE).href).detectSupport(renderer);
    loader.setKTX2Loader(ktx2);
  }
  const base = new URL(".", new URL(url, location.href)).href;
  return new Promise((res, rej) => loader.parse(buf.buffer, base, res, rej));
}

function needsKTX2(bytes) {
  const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true);
  const json = new TextDecoder().decode(bytes.subarray(20, 20 + n));
  return json.includes("KHR_texture_basisu");
}

export async function fetchBytes(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  if (!onProgress || !r.body) return new Uint8Array(await r.arrayBuffer());
  const total = +r.headers.get("content-length") || 0;
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** An image file as an ImageBitmap with its stored values untouched: no colour management, no premultiplying. */
export async function fetchBitmap(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return createImageBitmap(await r.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none", imageOrientation: "none" });
}

/** A light map, detail map or ID map as a GPU texture: no mipmaps (they blend atlas islands), no flip, no conversion. */
export function dataTexture(bitmap, { filter = THREE.LinearFilter, name = "" } = {}) {
  const t = new THREE.Texture(bitmap);
  t.name = name;
  t.flipY = false;
  t.premultiplyAlpha = false;
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = false;
  t.minFilter = filter;
  t.magFilter = filter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  t.userData.size = [bitmap.width, bitmap.height];
  return t;
}

/**
 * The bytes of a decoded bitmap, read back through WebGL itself (upload with no conversion, then readPixels), so
 * what the CPU sees is exactly what the GPU samples. Rows come out top row first. Used for probes and for the
 * QA round-trip test.
 */
export function bitmapBytes(renderer, bitmap) {
  const gl = renderer.getContext();
  const w = bitmap.width, h = bitmap.height;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const out = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);
  renderer.resetState();
  return out;
}

/** The AgX tone table (scripts/bake/tone_lut.py) as an RGB8 (or RGB16F) 3D texture, filtered by the GPU. */
export async function loadLut(url) {
  const [bin, meta] = await Promise.all([
    fetch(url + ".bin").then((r) => { if (!r.ok) throw new Error(`${url}.bin: HTTP ${r.status}`); return r.arrayBuffer(); }),
    fetch(url + ".json").then((r) => r.json()),
  ]);
  const n = meta.size;
  const half = meta.format.startsWith("rgb-half");
  const t = new THREE.Data3DTexture(half ? new Uint16Array(bin) : new Uint8Array(bin), n, n, n);
  t.format = THREE.RGBFormat;
  t.type = half ? THREE.HalfFloatType : THREE.UnsignedByteType;
  t.internalFormat = half ? "RGB16F" : "RGB8";
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.unpackAlignment = 1;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return { texture: t, meta };
}

/** Resolve a path inside bake.json against bake.json's own URL. */
export function within(baseUrl, rel) {
  return new URL(rel, new URL(baseUrl, location.href)).href;
}
