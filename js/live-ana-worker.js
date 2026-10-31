// The living window's reads of its pictures off the main thread (DYS-149): live.js posts the mask's and depth's files
// (analyse) or an exterior's address (a moment's light); this decodes them as live.js did, draws them into a CPU canvas
// of its own, reads them back and answers with the numbers (live-ana.js: the same functions the main thread runs where
// a worker can't). Anything that fails answers { error } and live.js does that read itself.
import { analyse, smallOf, statsOf } from "./live-ana.js";

const canvasFor = (w, h) => new OffscreenCanvas(w, h);
self.onmessage = async ({ data }) => {
  const { id, op } = data;
  try {
    if (op === "analyse") {
      // (as live.js: the two small pictures from their files, then analyse; its arrays handed back, not copied)
      const [mask, depth] = await Promise.all([smallOf(data.mask, data.maskH), smallOf(data.depth, data.depthH)]);
      let r;
      try { r = analyse(mask, depth, data.data, canvasFor); } finally { mask.close(); depth.close(); }
      self.postMessage({ id, r }, [r.cpu.water.buffer, r.cpu.depth.buffer, r.cpu.sky.buffer]);
    } else if (op === "stats") {
      // (as live.js's decodeOff: the exterior's bytes from the cache, decoded; its fall-back, the <img> itself, is the
      // main thread's: an error here sends it there)
      const res = await fetch(data.url, { cache: "force-cache" });
      if (!res.ok) throw new Error(`${data.url}: ${res.status}`);
      const full = await createImageBitmap(await res.blob());
      self.postMessage({ id, r: await statsOf(full, data.w, data.h, data.cpu, data.horizon, canvasFor) });
    } else throw new Error(`unknown read ${op}`);
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
