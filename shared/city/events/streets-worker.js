// The street traffic's catch-up off the main thread (DYS-149 SL): streets.js sends the streets once (routes.json's
// streets), then asks, one at a time, for a simulation from empty stepped to a clock; this steps it with the same code
// (streets.js farReply) and sends it back whole. Nothing here draws.
import { createStreets } from "./streets.js";

let S = null;
self.onmessage = ({ data }) => {
  if (data.routes) { S = createStreets(data.routes, null, { far: null }); return; }
  try {
    self.postMessage(S._farReply(data));
  } catch (e) {
    self.postMessage({ id: data.id, error: String((e && e.message) || e) });
  }
};
