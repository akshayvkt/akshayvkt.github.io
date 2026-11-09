// Loading: the room model (glTF with meshopt compression, optional KTX2 textures), the light-map layers and probes
// listed in bake.json, and data textures decoded with no colour conversion (docs/v3/engine-api.md section 10).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "meshoptimizer/meshopt_decoder.module.js";
// (DYS-203 start sooner: the boot's files the router asked for as soon as room3d.json named them, early.js; each read
// below takes its file from there when it came in whole, else fetches it as before. ?earlyroom=0: never there)
import { decodesAvif, phoneCopies, phoneTexUrls, takeEarly } from "./early.js";

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
    // (DYS-216 bytes-up: a picture held as bytes (an ImageData) is let go on every tier: its pixels are on the page's own
    // heap, not the GPU process's)
    if (!phoneMemory.release && !isBytes(t.image)) return;
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
    : phoneMemory.maxSize ? decodeIn(blob, src.opts, phoneMemory.maxSize, pool, BYTES_UP)
      : BMP_PAGE ? createImageBitmap(blob, src.opts) : decodeIn(blob, src.opts, 0, pool));
  if (cost) Object.assign(cost, { fetch: b - a, decode: performance.now() - b, work: bmp.workMs ?? null, kb: blob.size / 1024, size: [bmp.width, bmp.height] });
  return bmp;
}

/** Close a texture's ImageBitmap (after its upload). (roomdrop-tap: its size kept, t.userData.size: engine.js _standIns) */
export function closeSource(t) {
  const im = t.image;
  // (DYS-216 bytes-up: an ImageData can't be closed: the texture lets go of it (t.image null, as a closed bitmap reads to
  // engine.js: no picture, fetched again on a restore), its size kept as a closed bitmap's is)
  if (isBytes(im) && im.width) {
    t.userData.size = [im.width, im.height];
    phoneMemory.released++;
    phoneMemory.releasedMB += (im.width * im.height * 4) / 1048576;
    t.image = null;
    t.userData.released = true;
    letGo(im);   // (DYS-216 ?bytesfree: its buffer freed now, not at the next collection)
    return;
  }
  if (typeof ImageBitmap === "undefined" || !(im instanceof ImageBitmap) || !im.width) return;
  t.userData.size = [im.width, im.height];
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
// (DYS-216, E: bytes-up) ?bytesup=1: the room's maps the decode workers fit (the model's maps, the light maps; and their
// restore after a phone's zoom) come back from the worker as their bytes, read back there (fit-worker.js asBytes), and go
// up from an ImageData, not an ImageBitmap: WebKit converts a bitmap on the main thread as it uploads it (as an iPhone in
// WebKit, 1 Nov: 58 uploads from bitmaps, 378-499 ms of the main thread before the room shows), bytes it copies. A
// picture with alpha, or a browser whose readback check fails, still comes as a bitmap. Off by default.
// (?bytesup=room: the room's maps alone as bytes, the outside's pictures as bitmaps, outside.js: to tell the two apart)
// (?bytesup=auto: in WebKit alone, by pano.js's rule (its engine token: every iOS browser, Safari, the iPad's
// desktop-class Safari), not in Blink or Gecko: as a phone (CPU 6x) and a laptop Chrome uploads an ImageData about as
// slowly as a bitmap: the bytes saved 10-14 % of the upload time there and made the longest stall longer (1 Nov))
const UA_ = typeof navigator !== "undefined" ? navigator.userAgent : "";
const WEBKIT_ = /AppleWebKit\//.test(UA_) && !(/Chrome\/|Chromium\//.test(UA_) && !/iP(hone|ad|od)/.test(UA_) && !(/Macintosh/.test(UA_) && navigator.maxTouchPoints > 1));
// (DYS-216 first ship, the coordinator's yes 1 Nov 18:2x: "auto" is the default, in WebKit alone; ?bytesup=0 off, as before)
export const BYTES_UP = (() => { try { const v = new URLSearchParams(location.search).get("bytesup") ?? "auto"; return v === "1" || v === "room" || (v === "auto" && WEBKIT_); } catch { return false; } })();
/** (bytes-up) Whether a texture's picture is held as bytes (an ImageData from the decode worker). */
export const isBytes = (im) => typeof ImageData !== "undefined" && im instanceof ImageData;
// (DYS-216, E, Deploy 13d's live check: ?bytesfree, on by default, =0 off) A picture let go where the code lets go of it
// (where a bitmap is closed): one held as bytes (an ImageData from the decode workers: bytes-up's room maps, the
// outside's pictures, the window's aux maps, enginelite's probes) has its buffer freed there and then
// (ArrayBuffer.prototype.transfer(0): WebKit 17.4+), not at the next garbage collection. Until that collection every
// such picture stayed in the page's own process after its upload: as an iPhone 13 in WebKit the peak at land grew from
// 1456 MB (Deploy 13, bitmaps) to 1618 (13c, bytes) and 1676 (13d), +154 MB of it in WebContent, the process a phone's
// memory limit counts. Nothing reads a picture once it is let go (a closed bitmap can't be read either), so nothing
// drawn changes; a buffer that can't be detached, or a browser without transfer, is left to the collector as before.
const BYTES_FREE = (() => { try { return new URLSearchParams(location.search).get("bytesfree") !== "0"; } catch { return true; } })();
/** (DYS-216 ?bytesfree) A picture let go: a bitmap closed; an ImageData's buffer freed now (pano.js letGo likewise). */
export function letGo(p) {
  if (!p) return;
  if (typeof p.close === "function") { p.close(); return; }
  if (!BYTES_FREE || !isBytes(p)) return;
  try { const b = p.data && p.data.buffer; if (b && b.byteLength && typeof b.transfer === "function") b.transfer(0); } catch { /* left to the collector */ }
}
// (DYS-216 13d, ?enginelite bytes: router.js ENGINE_LITE, read here as this module reads its other switches)
// (Deploy 13d: on by default with ?enginelite, as router.js ENGINE_LITE; =0 off)
const LITE_BYTES = (() => { try { const v = new URLSearchParams(location.search).get("enginelite") ?? "1"; return v === "1" || v.split(",").includes("bytes"); } catch { return false; } })();
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
      if (data.error || !(data.bitmap || data.buf)) { poolDown(data.error || "no bitmap"); return; }   // (this one too: decoded here)
      poolAsks.delete(data.id);
      // (DYS-216 bytes-up: its bytes, as an ImageData (no copy): what three uploads, a TexImageSource, with width / height)
      const bmp = data.buf ? new ImageData(new Uint8ClampedArray(data.buf), data.size[0], data.size[1]) : data.bitmap;
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
function decodeIn(blob, opts, max, poolMax = POOL_MAX, bytes = false) {
  const w = poolOff ? null : poolWorker(poolMax);
  if (!w) return decodeHere(blob, opts, max);
  return new Promise((resolve, reject) => {
    const id = ++poolSeq;
    poolAsks.set(id, { blob, opts, max, w, resolve, reject });
    try { w.postMessage({ id, blob, opts, maxSize: max, ...(bytes ? { bytes: true } : {}) }); } catch (e) { poolDown(String((e && e.message) || e)); }
  });
}

/** (DYS-203 fewer steps) The first decode worker started now (engine.js _loadRoom, as the room starts loading), not by
 *  the first picture to decode: its script (fit-worker.js) came a round trip after that picture, often once the model and
 *  its textures were all in. The same worker the first decode would start (poolWorker); nothing when one is up, the
 *  workers are off, or none would be asked (decodes on the page, BMP_PAGE, and no phone's fitting). */
export function warmPool() {
  if (!poolOff && !pool.length && (!BMP_PAGE || phoneMemory.maxSize)) poolWorker();
}

/** (DYS-161 memory, RD3) The decode workers over keep (the ones restoreRoom started) let go, each once it is idle. */
export function trimPool(keep = POOL_MAX) {
  for (let i = pool.length - 1; i >= 0 && pool.length > keep; i--) {
    if (busyOf(pool[i])) continue;
    pool[i].terminate();
    pool.splice(i, 1);
  }
}

/** A picture file decoded with opts and fitted to phoneMemory.maxSize as fitBitmap fits it, in a worker when it can be.
 *  (DYS-216 bytes-up: bytes, with ?bytesup=1: as an ImageData when the worker can read it back) */
export function decodeFit(blob, opts, { bytes = false } = {}) {
  return decodeIn(blob, opts, phoneMemory.maxSize, POOL_MAX, bytes && BYTES_UP);
}

/** (DYS-216 bytes-up) The outside's pictures (outside.js bitmapFrom, with ?bytesup=1): decoded in the same workers at their
 *  own size (nothing fitted) and handed back as their bytes (an ImageData) when the worker can read them back, else a
 *  bitmap; on the page as before where the workers are off. */
export function decodePicture(blob, opts) {
  return BMP_PAGE ? createImageBitmap(blob, opts) : decodeIn(blob, opts, 0, POOL_MAX, BYTES_UP);
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
    // (DYS-203: the file the router asked for early, the same request's bytes, when it is there)
    // (DYS-203: an HTTP error is an error here, not a page decoded as a picture: a phone copy's 404 then falls back)
    takeEarly(url).then((early) => early || fetch(url, { credentials: this.crossOrigin === "anonymous" ? "same-origin" : "include", headers: this.requestHeader })
      .then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.blob(); }))
      .then((blob) => decodeFit(blob, { ...opts }, { bytes: true }).then((bmp) => {
        // (DYS-161: its source; RD3: and its file, with phoneMemory.keepFiles)
        srcOf.set(bmp, { url, opts: { ...opts }, ...(phoneMemory.keepFiles ? { blob } : {}) });
        if (onLoad) onLoad(bmp);
        manager.itemEnd(url);
      }))
      .catch((e) => { if (onError) onError(e); manager.itemError(url); manager.itemEnd(url); });
    manager.itemStart(url);
  };
}

/** (DYS-203) The texture loader's load (fitWhileLoading's or three's own: ImageBitmapLoader or TextureLoader) with a
 *  phone copy's failure met by one more load of the same URL with that copy marked failed (loadModel's URL modifier then
 *  gives what it stood in for). url here is the model's own name for the picture (GLTFLoader resolves it first). */
function copyOrBack(tl, phone, failed) {
  if (!tl || tl.__sfwCopyOrBack) return;
  const load = tl.load;
  tl.__sfwCopyOrBack = true;
  tl.load = function (url, onLoad, onProgress, onError) {
    const own = (this.path ?? "") + (url ?? "");
    const back = (e) => {
      if (!phone.has(own) || failed.has(own)) { if (onError) onError(e); return; }
      failed.add(own);
      phone.failed = (phone.failed || 0) + 1;
      console.warn("[loader] a phone copy failed, its map from what it stood in for:", own, e && e.message);
      load.call(this, url, onLoad, onProgress, onError);
    };
    return load.call(this, url, onLoad, onProgress, back);
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
    if (isBytes(t.image)) { releaseAfterUpload(t); continue; }   // (DYS-216 bytes-up: fitted in the worker already)
    if (typeof ImageBitmap === "undefined" || !(t.image instanceof ImageBitmap)) continue;
    if (phoneMemory.maxSize) { const img = await fitBitmap(t.image); if (img !== t.image) { t.image = img; t.needsUpdate = true; } }
    releaseAfterUpload(t);
  }
}

export async function loadModel(url, renderer, { onProgress, onItems, tex = null, phone = null } = {}) {
  // tex (lightTextures below): the model's texture files fetched from their lighter copies, same pictures; the
  // model names the originals, so its textures keep their names (hitex.js matches the close-up tier by them)
  // (onItems(n, of): the model's texture files as they arrive, v3/loading's progress line)
  // (DYS-203) phone (phoneTextures below): on a phone, the maps it would halve fetched as their copies at the size it
  // keeps; before tex, which names the full-size copy of the same map. A copy that fails (a 404 from a partial r1t1, a
  // decode error) is fetched again as what it stood in for, that map alone (tex's copy, else the original): the model
  // still loads (the review's LOW 5: it used to reject, and the engine read the whole model again without any copies)
  let manager;
  const failed = new Set();   // (the originals whose phone copy failed)
  if (tex || onItems || phone) manager = new THREE.LoadingManager();
  if (tex || phone) manager.setURLModifier((u) => (!failed.has(u) && phone?.get(u)?.url) || tex?.get(u) || u);
  if (onItems) manager.onProgress = (u, n, of) => onItems(n, of);
  const loader = new GLTFLoader(manager);
  loader.setMeshoptDecoder(MeshoptDecoder);
  // (DYS-149: phones: the model's pictures decoded and fitted in the worker as they load; BW: every tier, decoded in
  // the workers with nothing fitted where phoneMemory.maxSize is 0, unless ?bmpworker=0)
  if (phoneMemory.maxSize || !BMP_PAGE) loader.register((parser) => { fitWhileLoading(parser.textureLoader); return { name: "sfw_fit_while_loading" }; });
  if (phone) loader.register((parser) => { copyOrBack(parser.textureLoader, phone, failed); return { name: "sfw_phone_copy_fallback" }; });
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
    const early = await takeEarly(url);   // (DYS-203)
    let man;
    if (early) man = JSON.parse(await early.text());
    else {
      const r = await fetch(url);
      if (!r.ok) return null;
      man = await r.json();
    }
    if (!man || man.model_hash !== modelHash || !man.textures || !(await decodesAvif())) return null;
    const base = new URL(".", new URL(modelUrl, location.href)).href, at = new URL(url, location.href);
    const map = new Map();
    for (const [uri, t] of Object.entries(man.textures)) map.set(new URL(uri, base).href, new URL(t.file, at).href);
    return map.size ? map : null;
  } catch {
    return null;
  }
}

/**
 * (DYS-203, phone bytes) The phone's own copies of the maps it would otherwise halve as it decodes them (phoneMemory
 * .maxSize: the 2048 light maps and material maps, the laptop screen): scripts/live/phone_tex.py's t1.json, each map
 * halved once by a 2 x 2 mean and kept as AVIF, so a phone downloads the picture it keeps, not four times its pixels.
 * Returns a map from each original's URL (the set's URI resolved against bake.json's, as the model's pictures and the
 * light maps are) to { url, full } (full: the original's size, for room.js settleInlays), or null: no manifest, another
 * model's, made for another size than this phone keeps, no list of the served maps' hashes, or a browser that does not
 * decode AVIF (as before then). A copy whose source is not the map the site serves (r1t1-src.json) is left out: that map
 * from its original (early.js phoneCopies, the router's early files' rule too). Always room3d/r1t1 beside the set: no
 * URL parameter names another host's (the review's MEDIUM 3: ?phonetexurl= is gone).
 * rough: rough.json too (?phonetex=rough: the roughness maps again at a lower quality, phone_tex.py --rough; unlike
 * t1.json's copies a look change, to be measured on screen first).
 */
export async function phoneTextures(bakeUrl, modelHash, maxSize, rough = false) {
  try {
    const u = phoneTexUrls(new URL(bakeUrl, location.href).href, rough);
    // (each one the router asked for early, gl/early.js, when it came in whole; else fetched here)
    const get = async (x) => {
      const early = await takeEarly(x);
      if (early) return JSON.parse(await early.text());
      const r = await fetch(x);
      return r.ok ? r.json() : null;
    };
    const [man, src, ...extra] = await Promise.all([u.t1, u.src, ...u.more].map((x) => get(x).catch(() => null)));
    if (!(await decodesAvif())) return null;
    return phoneCopies(new URL(bakeUrl, location.href).href, u.t1, man, extra, src, modelHash, maxSize);
  } catch {
    return null;
  }
}

// (the 1x1 AVIF test, decodesAvif, is early.js's since DYS-203: the router's early textures ask it too, one answer;
// phoneTextures asks it there too)

function needsKTX2(bytes) {
  const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true);
  const json = new TextDecoder().decode(bytes.subarray(20, 20 + n));
  return json.includes("KHR_texture_basisu");
}

export async function fetchBytes(url, onProgress) {
  // (DYS-203: the model the router asked for early; its progress so far at once, then as it comes)
  const early = await takeEarly(url, onProgress || null);
  if (early) return new Uint8Array(await early.arrayBuffer());
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
 *  fit: no larger than phoneMemory.maxSize (light maps on phones; never the probes, whose texels are data).
 *  once: a picture read into a texture once and let go after (the probes): with ?enginelite bytes and bytes-up on, its
 *  bytes from the worker (an ImageData; one with alpha still a bitmap), as the room's maps come; nothing restores it from
 *  its picture later, so nothing else changes */
export async function fetchBitmap(url, { fit = false, once = false } = {}) {
  // (DYS-203: a light map or probe the router asked for early, decoded as one fetched here)
  let blob = await takeEarly(url);
  if (!blob) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    blob = await r.blob();
  }
  const opts = { colorSpaceConversion: "none", premultiplyAlpha: "none", imageOrientation: "none" };
  if (fit && phoneMemory.maxSize) return decodeFit(blob, opts, { bytes: true });   // (DYS-149: decoded and fitted in the worker; DYS-216: as bytes with ?bytesup=1)
  if (once && LITE_BYTES && BYTES_UP && !BMP_PAGE) return decodeIn(blob, opts, 0, POOL_MAX, true);   // (DYS-216 13d)
  // (DYS-149, BW: the rest decoded in a worker too, nothing fitted: fitBitmap left a bitmap as it was with no maxSize)
  return decodeBitmap(blob, opts);
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
