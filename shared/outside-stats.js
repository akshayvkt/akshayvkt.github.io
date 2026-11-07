// The outside's pixel statistics (perf #2): each moment's look read from the panorama's L2 tiles (white walls, haze,
// water, high sky; the city band with the aux mask) and the bridge deck's darkness from the L1 city tiles that hold
// it. The reads run in a worker (outside-stats-worker.js) so the main thread never draws a tile into a canvas and
// loops over its pixels; where a worker can't start, here on the main thread. The same functions either way, so the
// same numbers (the code moved from outside.js as it was).

/** A picture drawn at w x h into a CPU 2D canvas (willReadFrequently) and its RGBA pixels read back. */
export function reader() {
  const canvas = new OffscreenCanvas(8, 8);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return (bmp, w, h) => {
    canvas.width = w; canvas.height = h;
    ctx.drawImage(bmp, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  };
}

/**
 * One L2 band's numbers, as outside.js set them: { high } from the sky band; { white, air, water } from the city
 * band when the mask is there (else none). P: the band drawn at W x H; bmpH: the tile's own height in pixels.
 * meta: { gutter, bands: { city: { el }, sky: { el } } }; maskSmall: { w, h, d } or null.
 */
export function bandStats(kind, P, W, H, bmpH, meta, maskSmall) {
  const st = {};
  const ppdY = (bmpH - 2 * meta.gutter) / ((kind === "L2c" ? meta.bands.city.el : meta.bands.sky.el).reduce((a, b) => b - a));
  const top = kind === "L2c" ? meta.bands.city.el[1] : meta.bands.sky.el[1];
  const elOf = (row) => top - (((row + 0.5) * bmpH) / H - meta.gutter) / ppdY;
  if (kind === "L2s") {
    const acc = [0, 0, 0, 0];
    for (let y = 0; y < H; y++) {
      const el = elOf(y);
      if (el < 8 || el > 24) continue;
      for (let x = Math.round(W * 0.3); x < W * 0.7; x++) { const i = (y * W + x) * 4; acc[0] += P[i]; acc[1] += P[i + 1]; acc[2] += P[i + 2]; acc[3]++; }
    }
    if (acc[3]) st.high = acc.slice(0, 3).map((v) => v / acc[3] / 255);
  } else if (maskSmall) {
    const land = [], air = [0, 0, 0, 0], wat = [0, 0, 0, 0];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const mx = Math.min(maskSmall.w - 1, Math.floor(((x + 0.5) / W) * maskSmall.w)), my = Math.min(maskSmall.h - 1, Math.floor(((y + 0.5) / H) * maskSmall.h));
        const k = (my * maskSmall.w + mx) * 4, i = (y * W + x) * 4;
        const r = P[i] / 255, g = P[i + 1] / 255, b = P[i + 2] / 255;
        if (maskSmall.d[k] > 200) { const el = elOf(y); if (el > -0.5 && el < 4) { air[0] += r; air[1] += g; air[2] += b; air[3]++; } }
        else if (maskSmall.d[k + 1] > 200) { wat[0] += r; wat[1] += g; wat[2] += b; wat[3]++; }
        else land.push([0.2126 * r + 0.7152 * g + 0.0722 * b, r, g, b]);
      }
    }
    land.sort((a, b) => b[0] - a[0]);
    const top3 = land.slice(0, Math.max(1, Math.round(land.length * 0.03)));
    st.white = [1, 2, 3].map((j) => top3.reduce((s, q) => s + q[j], 0) / top3.length);
    if (air[3]) st.air = air.slice(0, 3).map((v) => v / air[3]);
    if (wat[3]) st.water = wat.slice(0, 3).map((v) => v / wat[3]);
  }
  return st;
}

/**
 * The bridge deck's darkness at each of its points in one L1 city tile (column c), as [[s, value], ...] in the
 * points' order: how dark its silhouette is against what lies just above it. P: the tile at its own W x H.
 * meta: { gutter, yaw, column_deg, bands: { city: { el } } }; pts: the deck points in this column ({ s, yaw, elLo, elHi }).
 */
export function deckValues(P, W, H, c, meta, pts) {
  const g = meta.gutter;
  const top = meta.bands.city.el[1], ppd = (H - 2 * g) / (top - meta.bands.city.el[0]), colYaw = meta.yaw[0] + c * meta.column_deg;
  const L = (x, y) => { const i = (Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 4; return 0.2126 * P[i] + 0.7152 * P[i + 1] + 0.0722 * P[i + 2]; };
  const row = (el) => g + (top - el) * ppd;
  const out = [];
  for (const d of pts) {
    const x = Math.round(g + (d.yaw - colYaw) * ppd - 0.5);
    let dark = Infinity, bg = 0, n = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let y = Math.floor(row(d.elHi + 0.02)); y <= Math.ceil(row(d.elLo - 0.02)); y++) dark = Math.min(dark, L(x + dx, y));
      for (let y = Math.floor(row(d.elHi + 0.22)); y <= Math.ceil(row(d.elHi + 0.12)); y++) { bg += L(x + dx, y); n++; }
    }
    out.push([d.s, Math.max(0, 1 - dark / Math.max(1, bg / n))]);
  }
  return out;
}

/** One read: q = { op: "mask", w, h } (the mask's pixels at w x h) | { op: "band", kind, W, H, meta, mask } |
 * { op: "deck", c, meta, pts }. */
export function runRead(read, bmp, q) {
  if (q.op === "mask") return read(bmp, q.w, q.h);
  if (q.op === "band") return bandStats(q.kind, read(bmp, q.W, q.H), q.W, q.H, bmp.height, q.meta, q.mask);
  if (q.op === "deck") return deckValues(read(bmp, bmp.width, bmp.height), bmp.width, bmp.height, q.c, q.meta, q.pts);
  throw new Error(`unknown read ${q.op}`);
}

/**
 * The reads, in a worker when one starts (else here). ask(bmp, q, done): done(result) once the numbers are in (later,
 * from the worker; at once, here), done(null) if the read failed. The bitmap stays the caller's: the worker gets a
 * copy (createImageBitmap, the same pixels), so it must stay open until done. onReply: after a later answer.
 */
export function statsRunner(onReply = () => {}) {
  let worker = null, seq = 0, read = null, chain = Promise.resolve();
  const asks = new Map();            // id -> { bmp, q, done }
  const here = (bmp, q) => { try { read ??= reader(); return runRead(read, bmp, q); } catch (e) { console.warn("[outside] stats", e.message); return null; } };
  try {
    worker = new Worker(new URL("./outside-stats-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const a = asks.get(data.id);
      if (!a) return;
      asks.delete(data.id);
      a.done(data.error ? here(a.bmp, a.q) : data.r);
      onReply();
    };
    // the worker could not start or broke: everything still asked is read here, and so is everything after
    worker.onerror = (e) => {
      e.preventDefault?.();
      worker?.terminate();
      worker = null;
      for (const [id, a] of [...asks]) { asks.delete(id); a.done(here(a.bmp, a.q)); }
      onReply();
    };
  } catch (e) {
    worker = null;
  }
  return {
    ask(bmp, q, done) {
      if (!worker) { done(here(bmp, q)); return; }
      const id = ++seq, a = { bmp, q, done };
      asks.set(id, a);
      // (in order: one copy, then one message, as asked)
      chain = chain.then(() => createImageBitmap(bmp, { premultiplyAlpha: "none" })).then((copy) => {
        if (!worker || !asks.has(id)) { copy.close(); return; }
        worker.postMessage({ id, q, bmp: copy }, [copy]);
      }).catch(() => {
        if (asks.delete(id)) { done(here(bmp, q)); onReply(); }
      });
    },
    dispose() {
      worker?.terminate();
      worker = null;
      asks.clear();
    },
  };
}
