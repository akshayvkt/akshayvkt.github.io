// The outside's pixel statistics off the main thread (perf #2): outside.js posts a copy of a tile's picture and what
// to read; this draws it into a CPU canvas, reads the pixels back and answers with the numbers (outside-stats.js,
// the same functions the main thread runs where a worker can't).
import { reader, runRead } from "./outside-stats.js";

const read = reader();
self.onmessage = ({ data }) => {
  const { id, q, bmp } = data;
  try {
    const r = runRead(read, bmp, q);
    if (q.op === "mask") self.postMessage({ id, r }, [r.buffer]);
    else self.postMessage({ id, r });
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  } finally {
    bmp?.close?.();
  }
};
