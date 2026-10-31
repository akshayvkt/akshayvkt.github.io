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
self.onmessage = async ({ data }) => {
  const { id, blob, buffer, opts, maxSize } = data, t0 = performance.now();
  try {
    if (typeof createImageBitmap === "undefined") throw new Error("no createImageBitmap in workers");
    const bmp = await createImageBitmap(blob || new Blob([buffer]), opts);
    if (!maxSize || Math.max(bmp.width, bmp.height) <= maxSize) {
      self.postMessage({ id, bitmap: bmp, fullWidth: bmp.width, halved: false, ms: performance.now() - t0 }, [bmp]);
      return;
    }
    let w = bmp.width, h = bmp.height;
    while (Math.max(w, h) > maxSize) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
    const out = await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: "high", premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const fullWidth = bmp.width;
    bmp.close();
    self.postMessage({ id, bitmap: out, fullWidth, halved: true, ms: performance.now() - t0 }, [out]);
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
