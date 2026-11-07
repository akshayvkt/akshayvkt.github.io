// (DYS-149) The close-up tier's pixels as bytes, a band of rows at a time, off the main thread. hitex.js fetches the file
// on the page (so its request is the page's own, as before) and posts the Blob; this decodes it with the page's own call
// (createImageBitmap, premultiplyAlpha "none") and reads it back band by band through a 2D OffscreenCanvas (smoothing
// off, a 1:1 copy: the same texels as the bitmap's own upload, checked in WebKit and Chrome on 30 Oct, diff 0). Why:
// WebKit converts the WHOLE bitmap on every sub-rectangle upload from it (the 6144 walnut: ~44 ms a strip of 81 rows,
// ~40 ms even for 16, ~190 ms the first), which made every frame of the notebook glide ~44 ms; from bytes a 2 MB strip
// is ~0.5-1 ms. Bands go out `ahead` at a time and one more for each { more } (the page uploads one a frame), so at most
// a few bands wait on the page and the decoded picture stays here. A classic worker: no imports. Any failure is
// answered { id, error } and the page decodes and uploads the picture itself, as before.
// in:  { id, blob, rows, ahead } | { id, more: true } | { id, cancel: true }
// out: { id, size: [w, h] } then { id, y, n, buf } (transferred, w * n * 4 bytes, RGBA) | { id, error }
const jobs = new Map();     // id -> { bmp, g, rows, y, credit }
const cancelled = new Set();   // cancelled while still decoding

// (DYS-149 review: anti-fingerprinting browsers (Firefox's resistFingerprinting, Brave, Tor, Safari's advanced
// protection) alter what getImageData reads back, which would put a noisy walnut on the desk. Once, before the first
// picture, a 2 x 2 known pattern goes the same way as a band (an ImageBitmap drawn 1:1, read back) and must come back
// exactly; if not, every picture is answered { id, error } and the page decodes and uploads it itself, as before.)
const PATTERN = [1, 2, 3, 255, 254, 253, 252, 255, 85, 170, 51, 255, 204, 102, 17, 255];   // opaque: no premultiplying
let readback = null;          // a promise of the check's answer, made once
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

function pump(id) {
  const j = jobs.get(id);
  if (!j) return;
  const W = j.bmp.width, H = j.bmp.height;
  try {
    while (j.credit > 0 && j.y < H) {
      const y = j.y, n = Math.min(j.rows, H - y);
      j.g.clearRect(0, 0, W, j.rows);
      j.g.drawImage(j.bmp, 0, y, W, n, 0, 0, W, n);
      const buf = j.g.getImageData(0, 0, W, n).data.buffer;
      j.y += n;
      j.credit--;
      self.postMessage({ id, y, n, buf }, [buf]);
    }
  } catch (e) {
    drop(id);
    self.postMessage({ id, error: String((e && e.message) || e) });
    return;
  }
  if (j.y >= H) drop(id);     // the last band is out: the picture is not needed here any more
}

function drop(id) {
  const j = jobs.get(id);
  if (!j) return;
  jobs.delete(id);
  j.bmp.close?.();
}

self.onmessage = async ({ data }) => {
  const { id } = data;
  if (data.cancel) { if (jobs.has(id)) drop(id); else cancelled.add(id); return; }
  if (data.more) { const j = jobs.get(id); if (j) { j.credit++; pump(id); } return; }
  try {
    if (typeof createImageBitmap === "undefined") throw new Error("no createImageBitmap in workers");
    if (typeof OffscreenCanvas === "undefined") throw new Error("no OffscreenCanvas in workers");
    if (!readback) readback = readbackExact().catch(() => false);
    if (!(await readback)) throw new Error("2D readback altered (anti-fingerprinting?)");
    const bmp = await createImageBitmap(data.blob, { premultiplyAlpha: "none" });
    if (cancelled.delete(id)) { bmp.close(); return; }
    const rows = Math.max(1, Math.min(data.rows | 0, bmp.height));
    const g = new OffscreenCanvas(bmp.width, rows).getContext("2d", { willReadFrequently: true });
    if (!g) { bmp.close(); throw new Error("no 2D context in workers"); }
    g.imageSmoothingEnabled = false;
    jobs.set(id, { bmp, g, rows, y: 0, credit: Math.max(1, data.ahead | 0) });
    self.postMessage({ id, size: [bmp.width, bmp.height] });
    pump(id);
  } catch (e) {
    drop(id);
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
