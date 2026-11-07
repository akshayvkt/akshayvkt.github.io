// The living window's reads of its pictures (DYS-149): analyse (the mask and depth, small: the horizon, the eye height,
// the water and depth for the boats) and a moment's light from its exterior (statsOf). Moved from live.js as they were;
// only the canvas they draw into is the caller's (canvasFor(w, h)). They run in a worker (live-ana-worker.js) so the
// main thread never draws a picture into a canvas, reads it back or loops over its pixels (on the slow laptop, after the
// room is shown: analyse 64-74 ms, nearly all of it its first drawImage; the stats 50-60 ms, the 4K picture's resize
// and the sort); where the worker can't, live.js runs them here on the main thread. The same functions with the same
// calls on the same files either way, so the same numbers.

/** A canvas of w x h on the main thread, as live.js made them. */
export const pageCanvas = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
};

// Read the mask and depth small: the horizon and eye height (on a flat bay, 1 / distance grows linearly below
// the horizon), and per-pixel water and depth for placing boats.
export function analyse(mask, depth, data, canvasFor = pageCanvas) {
  const w = 512, h = Math.max(8, Math.round((512 * mask.height) / mask.width));
  const c = canvasFor(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(mask, 0, 0, w, h);
  const M = ctx.getImageData(0, 0, w, h).data;
  ctx.drawImage(depth, 0, 0, w, h);
  const Dp = ctx.getImageData(0, 0, w, h).data;
  const HW = data.height / data.width, focal = data.focal;
  const water = new Uint8Array(w * h), dep = new Uint8Array(w * h), sky = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { water[i] = M[i * 4 + 1]; dep[i] = Dp[i * 4]; sky[i] = M[i * 4]; }

  const xs = [], ys = [];
  for (let y = 0; y < h; y += 2) {
    const vals = [];
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (water[i] > 200 && sky[i] < 40 && dep[i] < 252) vals.push(dep[i]);
    }
    if (vals.length < 4) continue;
    vals.sort((a, b) => a - b);
    xs.push(((y + 0.5) / h) * HW);
    ys.push(1 / (10 * Math.pow(6000, vals[vals.length >> 1] / 255)));
  }
  let flat = null;
  if (xs.length >= 4) {
    const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    const a = sxy / sxx, b = my - a * mx;
    const yh = -b / a, eye = 1 / (a * focal);
    if (a > 0 && eye > 5 && eye < 3000 && yh / HW > 0 && yh / HW < 1) flat = { horizon: yh / HW, eye };
  }
  return { flat, cpu: { w, h, water, depth: dep, sky } };
}

/** The size a moment's exterior is read at (160 wide), from its natural size. */
export const statsSize = (nw, nh) => [160, Math.max(8, Math.round((160 * nh) / nw))];

// A moment's own light, read from its exterior: the brightest sunlit walls (how white looks), the haze just
// above the horizon, the water. Boats and foam are lit to match. `full`: the exterior decoded (closed here); w x h:
// statsSize; cpu: analyse's.
export async function statsOf(full, w, h, cpu, horizon, canvasFor = pageCanvas) {
  const small = await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" });
  full.close();
  const c = canvasFor(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(small, 0, 0, w, h);
  small.close();
  const P = ctx.getImageData(0, 0, w, h).data;
  const land = [], air = [0, 0, 0, 0], wat = [0, 0, 0, 0], high = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const k = Math.min(cpu.h - 1, Math.floor(((y + 0.5) / h) * cpu.h)) * cpu.w + Math.min(cpu.w - 1, Math.floor(((x + 0.5) / w) * cpu.w));
      const r = P[i] / 255, g = P[i + 1] / 255, b = P[i + 2] / 255, v = (y + 0.5) / h;
      if (cpu.sky[k] > 200) {
        const acc = v > horizon - 0.06 ? air : v < horizon - 0.2 ? high : null;
        if (acc) { acc[0] += r; acc[1] += g; acc[2] += b; acc[3]++; }
      } else if (cpu.water[k] > 200) { wat[0] += r; wat[1] += g; wat[2] += b; wat[3]++; }
      else if (v > horizon) land.push([0.2126 * r + 0.7152 * g + 0.0722 * b, r, g, b]);
    }
  }
  land.sort((a, b) => b[0] - a[0]);
  const top = land.slice(0, Math.max(1, Math.round(land.length * 0.03)));
  const white = [0, 1, 2].map((j) => top.reduce((s, q) => s + q[j + 1], 0) / top.length);
  const mean = (a, d) => (a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : d);
  return { white, air: mean(air, white.map((x) => x * 0.8)), water: mean(wat, [0.2, 0.3, 0.4]), high: mean(high, [0.4, 0.55, 0.75]) };
}

/** The small mask or depth analyse reads, from its file (as live.js's pair2 made it): 512 wide, h high. */
export const smallOf = (blob, h) =>
  createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none", resizeWidth: 512, resizeHeight: h, resizeQuality: "medium" });
