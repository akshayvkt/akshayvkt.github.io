// Loading: the room model (glTF with meshopt compression, optional KTX2 textures), the light-map layers and probes
// listed in bake.json, and data textures decoded with no colour conversion (docs/v3/engine-api.md section 10).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "meshoptimizer/meshopt_decoder.module.js";

const VENDOR_THREE = new URL("../../vendor/three-0.169.0/", import.meta.url);

// (DYS-151) Phones (T1): memory. WebKit keeps an ImageBitmap's pixels in its GPU process beside the texture uploaded
// from it, so the phone tier held every room texture twice: 1.7-2.3 GB in WebKit's GPU process (measured as an iPhone
// in WebKit, 29 Oct), over iOS's per-process limit, and Safari killed the tab (Akshay's Quotes reload). engine.js turns
// these on for T1: maxSize halves the larger light maps and material maps as they are decoded (the probes are left
// whole: their texels are data), and release lets each decoded picture go once the GPU has it (three calls onUpdate
// after the upload). A released texture cannot be uploaded again: on a restored context engine.js falls back to the
// photographs. held: textures whose pixels the CPU still reads once (room.js settleInlays), released after that.
// (DYS-161 memory, RD3) keepFiles: the model's maps keep their files (Blobs, ~3.2 MB) beside their source records, so a
// phone's restore of the room's maps after a zoom (engine.js restoreRoom) decodes them without fetching: in RD3 the fetch
// from the cache was half of each picture's time. engine.js sets it with ?roomdrop=1, before the model loads.
export const phoneMemory = { maxSize: 0, release: false, held: new Set(), released: 0, releasedMB: 0, halved: 0, keepFiles: false };

/** The texture's source picture let go once it is on the GPU (phoneMemory.release), unless held. Returns the texture. */
export function releaseAfterUpload(t) {
  if (!t || !t.isTexture || t.userData.releaseHooked) return t;
  t.userData.releaseHooked = true;
  const before = t.onUpdate;
  t.onUpdate = (tex) => {
    if (before) before(tex);
    if (!phoneMemory.release) return;
    if (phoneMemory.held.has(t)) { t.userData.releasePending = true; return; }
    closeSource(t);
  };
  return t;
}

// (DYS-161 memory) where each fitted picture came from (its file's URL and its decode options), so a phone can let a
// room texture go from the GPU while the window is zoomed with the room wholly out and make it again from the HTTP cache
// (engine.js dropRoom / restoreRoom): the light maps (room.js layerTexture) and the model's maps (fitWhileLoading,
// fitModelTextures) record it on t.userData.src; a picture with none (a blob: URL, a data texture) is never let go.
// (RD3: the model's maps are marked src.map: with ?roomdrop=1 only those go, the light maps stay: engine.js dropRoom)
const srcOf = new WeakMap();   // the model's decoded bitmap -> { url, opts, blob? }, until fitModelTextures puts it on its texture

/** Record where a texture's picture can be fetched and decoded again: { url, opts, direct } (direct: no fit, as given;
 *  RD3: map, one of the model's maps; blob, its file kept: phoneMemory.keepFiles). */
export function noteSource(t, src) {
  if (t && src && src.url && !/^blob:/.test(src.url)) t.userData.src = src;
  return t;
}

/**
 * (DYS-161 memory) A texture's picture made again from its file (t.userData.src), as it was made the first time.
 * (RD3) pool: the decode workers it may use (engine.js restoreRoom's; the boot's POOL_MAX otherwise); cost, when given,
 * gets its times (ms): fetch (the file from the cache), decode (asked to answered, a wait in the worker's queue
 * included), work (the worker's own, from its reply), and the file's KB and the picture's size.
 */
export async function refetchSource(src, { pool = POOL_MAX, cost = null } = {}) {
  const a = performance.now();
  let blob = src.blob;   // (RD3: the file kept since the load, phoneMemory.keepFiles: nothing fetched)
  if (!blob) {
    const r = await fetch(src.url, { cache: "force-cache" });   // (C's merges review 2: the copy loaded at boot, no revalidation)
    if (!r.ok) throw new Error(`${src.url}: HTTP ${r.status}`);
    blob = await r.blob();
  }
  const b = performance.now();
  // (DYS-149, BW: in a worker, as decodeFit / decodeBitmap would; RD3: over up to pool of them)
  const bmp = await (src.direct ? createImageBitmap(blob, src.opts)
    : phoneMemory.maxSize ? decodeIn(blob, src.opts, phoneMemory.maxSize, pool)
      : BMP_PAGE ? createImageBitmap(blob, src.opts) : decodeIn(blob, src.opts, 0, pool));
  if (cost) Object.assign(cost, { fetch: b - a, decode: performance.now() - b, work: bmp.workMs ?? null, kb: blob.size / 1024, size: [bmp.width, bmp.height] });
  return bmp;
}

/** Close a texture's ImageBitmap (after its upload). */
export function closeSource(t) {
  const im = t.image;
  if (typeof ImageBitmap === "undefined" || !(im instanceof ImageBitmap) || !im.width) return;
  phoneMemory.released++;
  phoneMemory.releasedMB += (im.width * im.height * 4) / 1048576;
  im.close();
  t.userData.released = true;
}

/** A decoded bitmap halved until its longer side fits phoneMemory.maxSize (the original closed); as it is otherwise. */
export async function fitBitmap(bmp) {
  const max = phoneMemory.maxSize;
  if (!max || !bmp || Math.max(bmp.width, bmp.height) <= max) return bmp;
  let w = bmp.width, h = bmp.height;
  while (Math.max(w, h) > max) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
  const out = await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: "high", premultiplyAlpha: "none", colorSpaceConversion: "none" });
  out.fullWidth = bmp.width;   // (room.js settleInlays samples the same area of a halved light map as of the full one)
  bmp.close?.();
  phoneMemory.halved++;
  return out;
}

// (DYS-149: on phones the pictures fitBitmap fits (the light maps, and the model's maps where GLTFLoader decodes them
// as ImageBitmaps) are decoded and halved in a worker (fit-worker.js). It makes fitBitmap's two calls with their options
// and hands the bitmap back, so the pixels are the same in Chrome and WebKit; in Chrome the resize ran on the main
// thread: 63-70 ms per 2048 map, ~950 ms of the phone's boot with the CPU 4x slower (30 Oct). fullWidth and
// phoneMemory.halved are set here as fitBitmap sets them. Where no worker starts, a worker has no createImageBitmap, or
// anything in it fails, the pictures are decoded here as before, from then on (?debug says why, once))
// (DYS-149: every tier, BW: the same workers decode the room's other pictures too (decodeBitmap: the light maps, the
// probes and the model's maps on a desktop, the probes on a phone), with maxSize 0: fit-worker.js's one createImageBitmap
// call on the same Blob with the same options, nothing fitted. In Chrome the decode itself runs on a decoder thread but
// its reply, the ImageBitmap made from the decoded picture, is a task on the thread that asked: ~123 per boot, 4-37 ms
// each, ~0.92 s of the main thread behind the still photo on the slow laptop (BT1 traces, 30 Oct). Asked from a worker,
// those land on the worker's thread and only the transferred bitmap comes back. Up to 2 workers, the second started
// only while the first is busy; each picture to the one with fewer waiting. ?bmpworker=0 decodes these on the page as
// before (a phone's fitted pictures still go to the worker, as on main); so does a browser with no OffscreenCanvas
// (what hitex.js asks of a worker too: older WebKit))
const BMP_PAGE = (() => { try { return new URLSearchParams(location.search).get("bmpworker") === "0" || typeof OffscreenCanvas === "undefined"; } catch { return true; } })();
const POOL_MAX = 2;
let pool = [], poolOff = false, poolSeq = 0;
const poolAsks = new Map();   // id -> { blob, opts, max, w, resolve, reject }
const busyOf = (w) => { let n = 0; for (const a of poolAsks.values()) if (a.w === w) n++; return n; };
const decodeHere = (blob, opts, max) => createImageBitmap(blob, opts).then((b) => (max ? fitBitmap(b) : b));
function poolDown(why) {
  if (!poolOff && new URLSearchParams(location.search).has("debug")) console.info(`[loader] pictures decoded on the page (DYS-149): ${why}`);
  poolOff = true;
  for (const w of pool) w.terminate();
  pool = [];
  for (const [id, a] of [...poolAsks]) { poolAsks.delete(id); decodeHere(a.blob, a.opts, a.max).then(a.resolve, a.reject); }
}
function poolWorker(max = POOL_MAX) {
  let w = pool.length ? pool.reduce((x, y) => (busyOf(y) < busyOf(x) ? y : x)) : null;
  if (w && (busyOf(w) === 0 || pool.length >= max)) return w;
  try {
    if (typeof Worker === "undefined") throw new Error("no Worker");
    const nw = new Worker(new URL("./fit-worker.js", import.meta.url));
    nw.onmessage = ({ data }) => {
      const a = poolAsks.get(data.id);
      if (!a) return;
      if (data.error || !data.bitmap) { poolDown(data.error || "no bitmap"); return; }   // (this one too: decoded here)
      poolAsks.delete(data.id);
      const bmp = data.bitmap;
      if (data.halved) { bmp.fullWidth = data.fullWidth; phoneMemory.halved++; }   // (as fitBitmap's: room.js settleInlays)
      if (data.ms != null) bmp.workMs = data.ms;   // (DYS-161 RD3: the worker's own time for it, for restoreRoom's costs)
      a.resolve(bmp);
    };
    nw.onerror = (e) => { e.preventDefault?.(); poolDown(`the worker failed${e.message ? ": " + e.message : ""}`); };
    nw.onmessageerror = () => poolDown("a reply could not be read");
    pool.push(nw);
    return nw;
  } catch (e) {
    if (w) return w;   // (a second that would not start: the first carries on)
    poolDown(String((e && e.message) || e));
    return null;
  }
}
function decodeIn(blob, opts, max, poolMax = POOL_MAX) {
  const w = poolOff ? null : poolWorker(poolMax);
  if (!w) return decodeHere(blob, opts, max);
  return new Promise((resolve, reject) => {
    const id = ++poolSeq;
    poolAsks.set(id, { blob, opts, max, w, resolve, reject });
    try { w.postMessage({ id, blob, opts, maxSize: max }); } catch (e) { poolDown(String((e && e.message) || e)); }
  });
}

/** (DYS-161 memory, RD3) The decode workers over keep (the ones restoreRoom started) let go, each once it is idle. */
export function trimPool(keep = POOL_MAX) {
  for (let i = pool.length - 1; i >= 0 && pool.length > keep; i--) {
    if (busyOf(pool[i])) continue;
    pool[i].terminate();
    pool.splice(i, 1);
  }
}

/** A picture file decoded with opts and fitted to phoneMemory.maxSize as fitBitmap fits it, in a worker when it can be. */
export function decodeFit(blob, opts) {
  return decodeIn(blob, opts, phoneMemory.maxSize);
}

/** (DYS-149, BW) A picture file decoded with opts, as createImageBitmap(blob, opts) here, in a worker when it can be. */
export function decodeBitmap(blob, opts) {
  return BMP_PAGE ? createImageBitmap(blob, opts) : decodeIn(blob, opts, 0);
}

/**
 * (DYS-149) GLTFLoader's ImageBitmapLoader (Chrome, Firefox, Safari 17 on) as it loads the model's pictures on phones
 * (BW: and on every tier, nothing fitted where phoneMemory.maxSize is 0),
 * each one decoded and fitted by decodeFit (in the worker) with the loader's own options; fitModelTextures then finds
 * them fitted and hooks their release. three 0.169's load otherwise: the same request, the loading manager told the
 * same. (The model's pictures that come as HTMLImageElements, iOS's other browsers, are still turned and fitted on the
 * page by fitModelTextures: whether one is a colour picture is known only once it is on a material.)
 */
function fitWhileLoading(tl) {
  if (!tl || tl.isImageBitmapLoader !== true || THREE.Cache.enabled) return;
  tl.load = function (url, onLoad, onProgress, onError) {
    url = this.manager.resolveURL((this.path ?? "") + (url ?? ""));
    const manager = this.manager, opts = Object.assign(this.options, { colorSpaceConversion: "none" });
    fetch(url, { credentials: this.crossOrigin === "anonymous" ? "same-origin" : "include", headers: this.requestHeader })
      .then((r) => r.blob())
      .then((blob) => decodeFit(blob, { ...opts }).then((bmp) => {
        // (DYS-161: its source; RD3: and its file, with phoneMemory.keepFiles)
        srcOf.set(bmp, { url, opts: { ...opts }, ...(phoneMemory.keepFiles ? { blob } : {}) });
        if (onLoad) onLoad(bmp);
        manager.itemEnd(url);
      }))
      .catch((e) => { if (onError) onError(e); manager.itemError(url); manager.itemEnd(url); });
    manager.itemStart(url);
  };
}

/** The model's own textures (material maps): fitted and released as above, before their first upload. */
async function fitModelTextures(gltf) {
  const seen = new Set();
  gltf.scene.traverse((o) => {
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
      for (const v of Object.values(m)) if (v && v.isTexture) seen.add(v);
    }
  });
  for (const t of seen) {
    // (DYS-161 memory: fitWhileLoading's record of this picture's file; RD3: marked as one of the model's maps)
    const src = srcOf.get(t.image);
    noteSource(t, src && { ...src, map: true });
    // (DYS-151 review, finding 2) Chrome, Firefox and the Google app on iPhone ("Safari" without "Version/") get the
    // model's pictures from GLTFLoader as HTMLImageElements, so the phone tier halved and released none of them: on that
    // tier they become ImageBitmaps here, with the unpack settings three would use for the element (no premultiplying;
    // the browser's colour conversion only for a colour picture, none for data maps), halved to fit as the others are
    if (phoneMemory.release && typeof createImageBitmap !== "undefined" && typeof HTMLImageElement !== "undefined" &&
        t.image instanceof HTMLImageElement && t.image.naturalWidth) {
      const img = t.image, max = phoneMemory.maxSize;
      const k = max ? Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)) : 1;
      try {
        const opts = {
          premultiplyAlpha: "none", colorSpaceConversion: t.colorSpace === THREE.NoColorSpace ? "none" : "default",
          ...(k < 1 ? { resizeWidth: Math.round(img.naturalWidth * k), resizeHeight: Math.round(img.naturalHeight * k), resizeQuality: "high" } : {}),
        };
        t.image = await createImageBitmap(img, opts);
        noteSource(t, { url: img.currentSrc || img.src, opts, direct: true, map: true });   // (DYS-161 memory: decoded the same way again)
        t.needsUpdate = true;
        if (k < 1) phoneMemory.halved++;
        img.src = "";   // (the element's own decoded copy let go)
      } catch { continue; }
    }
    if (typeof ImageBitmap === "undefined" || !(t.image instanceof ImageBitmap)) continue;
    if (phoneMemory.maxSize) { const img = await fitBitmap(t.image); if (img !== t.image) { t.image = img; t.needsUpdate = true; } }
    releaseAfterUpload(t);
  }
}

export async function loadModel(url, renderer, { onProgress, onItems, tex = null } = {}) {
  // tex (lightTextures below): the model's texture files fetched from their lighter copies, same pictures; the
  // model names the originals, so its textures keep their names (hitex.js matches the close-up tier by them)
  // (onItems(n, of): the model's texture files as they arrive, v3/loading's progress line)
  let manager;
  if (tex || onItems) manager = new THREE.LoadingManager();
  if (tex) manager.setURLModifier((u) => tex.get(u) || u);
  if (onItems) manager.onProgress = (u, n, of) => onItems(n, of);
  const loader = new GLTFLoader(manager);
  loader.setMeshoptDecoder(MeshoptDecoder);
  // (DYS-149: phones: the model's pictures decoded and fitted in the worker as they load; BW: every tier, decoded in
  // the workers with nothing fitted where phoneMemory.maxSize is 0, unless ?bmpworker=0)
  if (phoneMemory.maxSize || !BMP_PAGE) loader.register((parser) => { fitWhileLoading(parser.textureLoader); return { name: "sfw_fit_while_loading" }; });
  const buf = await fetchBytes(url, onProgress);
  if (needsKTX2(buf)) {
    // the Basis transcoder is 204 KB brotli: only fetched when the model really has KTX2 textures
    const { KTX2Loader } = await import("three/addons/loaders/KTX2Loader.js");
    const ktx2 = new KTX2Loader().setTranscoderPath(new URL("addons/libs/basis/", VENDOR_THREE).href).detectSupport(renderer);
    loader.setKTX2Loader(ktx2);
  }
  const base = new URL(".", new URL(url, location.href)).href;
  const gltf = await new Promise((res, rej) => loader.parse(buf.buffer, base, res, rej));
  if (phoneMemory.maxSize || phoneMemory.release) await fitModelTextures(gltf);
  return gltf;
}

/**
 * The set's lighter texture copies (scripts/live/light_tex.py: AVIF 4:4:4 of each PNG/JPG, light-tex.json), as a map
 * from each original's URL (resolved against the model's) to its copy's, or null: no manifest, another model's
 * manifest, or a browser that does not decode AVIF (the originals then, as before).
 */
export async function lightTextures(url, modelUrl, modelHash) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const man = await r.json();
    if (!man || man.model_hash !== modelHash || !man.textures || !(await decodesAvif())) return null;
    const base = new URL(".", new URL(modelUrl, location.href)).href, at = new URL(url, location.href);
    const map = new Map();
    for (const [uri, t] of Object.entries(man.textures)) map.set(new URL(uri, base).href, new URL(t.file, at).href);
    return map.size ? map : null;
  } catch {
    return null;
  }
}

// a 1x1 AVIF through the same path textures take (createImageBitmap), once
let avifP = null;
function decodesAvif() {
  if (!avifP) {
    const b64 = "AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAAFAAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAAAQAAAAEAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAAHG1kYXQSAAoFGAAGBCAyCRgACiiihAAFSA==";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    avifP = typeof createImageBitmap === "undefined" ? Promise.resolve(false)
      : createImageBitmap(new Blob([bytes], { type: "image/avif" })).then((b) => { const ok = b.width > 0; b.close?.(); return ok; }, () => false);
  }
  return avifP;
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

/** An image file as an ImageBitmap with its stored values untouched: no colour management, no premultiplying.
 *  fit: no larger than phoneMemory.maxSize (light maps on phones; never the probes, whose texels are data). */
export async function fetchBitmap(url, { fit = false } = {}) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const opts = { colorSpaceConversion: "none", premultiplyAlpha: "none", imageOrientation: "none" };
  if (fit && phoneMemory.maxSize) return decodeFit(await r.blob(), opts);   // (DYS-149: decoded and fitted in the worker)
  // (DYS-149, BW: the rest decoded in a worker too, nothing fitted: fitBitmap left a bitmap as it was with no maxSize)
  return decodeBitmap(await r.blob(), opts);
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
