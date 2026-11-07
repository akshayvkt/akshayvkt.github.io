// (DYS-149) Phones (T1): a picture fitted to phoneMemory.maxSize off the main thread. loader.js posts the file (a Blob,
// or its bytes as an ArrayBuffer), its decode options and the size to fit; this decodes it and, when its longer side is
// over that size, halves it with loader.js fitBitmap's own call (the same halving, the same options), then hands the
// bitmap back (transferred). The same two createImageBitmap calls as the page made, so the same pixels in Chrome and
// WebKit; in Chrome the resize of a bitmap ran on the page's main thread (63-70 ms per 2048 map, ~950 ms of a phone's
// boot with the CPU 4x slower, 30 Oct). A classic worker: no imports. Any failure is answered { id, error } and the page
// fits the picture itself, as before.
// {id, blob | buffer, opts, maxSize} -> {id, bitmap, fullWidth, halved, ms}
// (DYS-161 RD3: ms, the time from its message to its answer here: what the phone's restore of the room's maps costs per
// picture, engine.js restoreRoom)
// (DYS-149 pano-bytes: the panorama's tiles (pano.js decodeTile) come here too. With maxSize 0 a tile is decoded and
// handed back as before; with `bands` (rows) it is read back as bytes instead, hitex-worker.js's way: drawn 1:1 into a
// 2D OffscreenCanvas (smoothing off) a band of rows at a time, each band transferred as it is read, so this holds the
// picture and one band. At alpha 255 that is the bitmap's own texels; the first band with an alpha below 255 is not
// sent, and the bitmap itself goes back for the rows from there (`from`). The 2D readback's pattern check runs once
// before the first band (anti-fingerprinting browsers alter getImageData): if it fails, or a band can't be read, the
// answer is { id, error, bands: true } and the page takes the bitmap instead, as before.)
// {id, blob | buffer, opts, bands: rows} -> {id, size: [w, h]}, then {id, y, n, buf} per band (w * n * 4 bytes, RGBA),
// then {id, done: true, ms} | {id, bitmap, from, ms} (rows from `from` on, transferred)
// (C's review, DYS-149: a file that createImageBitmap itself rejects (a bad or truncated response) is answered
// { id, error, decode: true } (with bands: true too for a tile's bands): the file's failure, not the readback's or the
// worker's, so pano.js keeps both on; loader.js reads error alone, as before)
// (DYS-216, E: bytes-up) With `bytes`, a room map (fitted as above) goes back as its bytes, read in one piece the bands'
// way (drawn 1:1 into a 2D OffscreenCanvas, smoothing off), after the same readback check: WebKit converts an ImageBitmap
// on the page's main thread as it uploads it, a typed array it copies. A picture with any alpha below 255, a check that
// fails, or a readback that throws: the bitmap answer as before (not an error).
// {id, blob | buffer, opts, maxSize, bytes: true} -> {id, buf, size: [w, h], fullWidth, halved, ms} | the bitmap answer
const PATTERN = [1, 2, 3, 255, 254, 253, 252, 255, 85, 170, 51, 255, 204, 102, 17, 255];   // opaque: no premultiplying
let readback = null;          // (pano-bytes) a promise of the check's answer, made once
async function readbackExact() {
  const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(PATTERN), 2, 2), { premultiplyAlpha: "none" });
  const g = new OffscreenCanvas(2, 2).getContext("2d", { willReadFrequently: true });
  if (!g) { bmp.close(); return false; }
  g.imageSmoothingEnabled = false;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const d = g.getImageData(0, 0, 2, 2).data;
  return PATTERN.every((v, i) => d[i] === v);
}

// (pano-bytes) a decoded tile as bands of bytes, sent as they are read; the bitmap from the first band that isn't opaque
function bands(id, bmp, rows, t0) {
  const W = bmp.width, H = bmp.height;
  rows = Math.max(1, Math.min(rows | 0, H));
  self.postMessage({ id, size: [W, H] });
  const g = new OffscreenCanvas(W, rows).getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("no 2D context in workers");
  g.imageSmoothingEnabled = false;
  for (let y = 0; y < H; y += rows) {
    const n = Math.min(rows, H - y);
    g.clearRect(0, 0, W, rows);
    g.drawImage(bmp, 0, y, W, n, 0, 0, W, n);
    const px = g.getImageData(0, 0, W, n).data;
    let opaque = true;
    for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) { opaque = false; break; }
    if (!opaque) {
      self.postMessage({ id, bitmap: bmp, from: y, ms: performance.now() - t0 }, [bmp]);
      return;
    }
    self.postMessage({ id, y, n, buf: px.buffer }, [px.buffer]);
  }
  bmp.close();
  self.postMessage({ id, done: true, ms: performance.now() - t0 });
}

// (bytes-up) a fitted picture's bytes in one piece, or null when any texel isn't opaque or it can't be read
function asBytes(bmp) {
  try {
    const W = bmp.width, H = bmp.height;
    const g = new OffscreenCanvas(W, H).getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    g.imageSmoothingEnabled = false;
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, W, H).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) return null;
    return px;
  } catch { return null; }
}

self.onmessage = async ({ data }) => {
  const { id, blob, buffer, opts, maxSize } = data, t0 = performance.now();
  let bmp = null, decoding = false;
  try {
    if (typeof createImageBitmap === "undefined") throw new Error("no createImageBitmap in workers");
    if (data.bands) {
      // (pano-bytes) the check before the decode: a browser that can't read back exactly gets its bitmap from the page
      if (typeof OffscreenCanvas === "undefined") throw new Error("no OffscreenCanvas in workers");
      if (!readback) readback = readbackExact().catch(() => false);
      if (!(await readback)) throw new Error("2D readback altered (anti-fingerprinting?)");
    }
    // (bytes-up: the same check; a browser that fails it gets bitmaps, as before)
    let bytes = !!data.bytes && typeof OffscreenCanvas !== "undefined";
    if (bytes) { if (!readback) readback = readbackExact().catch(() => false); bytes = await readback; }
    decoding = true;   // (C's review: a rejection from here on is the file's)
    bmp = await createImageBitmap(blob || new Blob([buffer]), opts);
    decoding = false;
    if (data.bands) { bands(id, bmp, data.bands, t0); return; }
    // (bytes-up) the answer: the picture's bytes when it can be read so, else the bitmap
    const answer = (pic, fullWidth, halved) => {
      const px = bytes ? asBytes(pic) : null;
      if (px) {
        const size = [pic.width, pic.height];
        pic.close();
        self.postMessage({ id, buf: px.buffer, size, fullWidth, halved, ms: performance.now() - t0 }, [px.buffer]);
      } else self.postMessage({ id, bitmap: pic, fullWidth, halved, ms: performance.now() - t0 }, [pic]);
    };
    if (!maxSize || Math.max(bmp.width, bmp.height) <= maxSize) {
      answer(bmp, bmp.width, false);
      return;
    }
    let w = bmp.width, h = bmp.height;
    while (Math.max(w, h) > maxSize) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
    const out = await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: "high", premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const fullWidth = bmp.width;
    bmp.close();
    answer(out, fullWidth, true);
  } catch (e) {
    if (data.bands) bmp?.close?.();
    self.postMessage({ id, error: String((e && e.message) || e), ...(data.bands ? { bands: true } : {}), ...(decoding ? { decode: true } : {}) });
  }
};
