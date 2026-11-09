// The big ships' sharp pictures for the zoom (DYS-232). The 1x atlas draws a ship at 1.4 px a metre: at a visitor's
// 4x it is magnified ~3x and soft. The sharp set (S1's scripts/ships: ~4 px a metre, the same headings, the same
// framing) is one file per ship type per heading:
//   web/live/sprites/boats-ships-hi.json       each type with boats.json's fields (cell, anchor, px_per_m, yaws,
//                                              mirror, length, beam, height, nav, floods, flood_scale, win_gain), its
//                                              "keys" (each heading's file key) and the folders in "sets"
//   ships-hi/<type>-<key>-{albedo,normal,night}.webp   (albedo and night full size, normal half: as the atlas's)
//   ships-hi-half/...                          the half set, for phones (normal a quarter)
// Nothing of it is fetched until a visitor first magnifies past DETAIL_ZOOM; then the json, and only the cells the ships
// on screen show (one most of the time: the narrowed cross-fade, sprites.js SHIP_BLEND; two mid-step) and the next
// one each is turning toward, into a small pool on the GPU (POOL_SLOTS cells; the least recently used let go). A ship
// moves to its sharp pictures where the 1x set would be magnified on this screen (detailWeight: from 0.8 to 1.25
// device px a texel), over DETAIL_FADE s, and only once every cell it needs is in: the same picture, sharper, never a
// change of heading, place or light.
// No GL here: outside.js makes the pool's textures and copies each cell in (fetchCell); outside-events.js asks for
// cells (cell) and draws the sharp instances; this keeps the books.
export const DETAIL_JSON = "boats-ships-hi.json";
export const DETAIL_ZOOM = 2.0;                 // the first magnification past this asks for the json
export const DETAIL_TEXEL = [0.8, 1.25];        // device px per texel of the 1x set: from the first to the second, sharp
export const DETAIL_FADE = 0.35;                // s: a ship's move to (or from) its sharp pictures
export const POOL_SLOTS = { desk: 8, phone: 8 };      // (a ship shows 1 cell, 2 mid-dissolve, +1 asked ahead)
export const SLOT_ALIGN = 32;                   // full-set px: the half set's quarter-size normal stays on whole texels,
                                                // and a slot's mipmaps to level 4 never take in a neighbour's
export const MAX_INFLIGHT = 2;                  // cells fetched at once
export const KEEP_FRAMES = 30;                  // a cell drawn within this many frames is never let go for another
const MAX_TEX = 4096;                           // (every WebGL 2 device takes 4096; most phones no more)

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** how far a ship should be on its sharp pictures, by the device px a texel of its 1x picture covers on this screen */
export const detailWeight = (texelPx) => smooth(DETAIL_TEXEL[0], DETAIL_TEXEL[1], texelPx);

/**
 * A cell's three files (paths under web/live/sprites/): type, heading number i, the half set (phones). The json's own
 * "sets" name the folders: { full: "ships-hi", half: "ships-hi-half" } (a folder, with or without its slash), or each a
 * { dir } or a { albedo, normal, night } of templates with {type}, {key} (and {pass}) in them; none: the folders above.
 * A type's keys[i] is its heading's file key ("0075"; one that already starts with the type's name is used whole); none:
 * the heading in tenths of a degree, 4 digits.
 */
export function cellUrls(meta, type, i, half) {
  const t = meta.types[type], yaw = (t.yaws || meta.yaws)[i];
  const k = (t.keys || meta.keys)?.[i] ?? String(Math.round(yaw * 10)).padStart(4, "0");
  const key = String(k).startsWith(`${type}-`) ? String(k) : `${type}-${k}`;
  const set = meta.sets?.[half ? "half" : "full"] ?? (half ? "ships-hi-half" : "ships-hi");
  const fill = (s, pass) => s.replace(/\{type\}/g, type).replace(/\{key\}/g, key.slice(type.length + 1)).replace(/\{name\}/g, key).replace(/\{pass\}/g, pass);
  const out = {};
  for (const pass of ["albedo", "normal", "night"]) {
    if (typeof set === "object" && set[pass]) out[pass] = fill(set[pass], pass);
    else {
      const dir = String(typeof set === "object" ? set.dir ?? (half ? "ships-hi-half" : "ships-hi") : set).replace(/\/+$/, "");
      out[pass] = `${dir}/${key}-${pass}.webp`;
    }
  }
  return out;
}

/**
 * The pool's layout: every slot the size of the biggest cell (full-set px, whole SLOT_ALIGN blocks with a gutter
 * round it), in as few rows as fit under MAX_TEX: { slot: [w, h], cols, rows, size: [W, H] (full-set px: the shader's
 * uAtlas; phones' textures are half that), at: [[x, y], ...] }
 */
export function poolLayout(meta, slots, maxTex = MAX_TEX) {
  let w = 0, h = 0;
  for (const t of Object.values(meta.types)) { w = Math.max(w, t.cell[0]); h = Math.max(h, t.cell[1]); }
  const up = (x) => Math.ceil((x + SLOT_ALIGN / 2) / SLOT_ALIGN) * SLOT_ALIGN;
  const sw = up(w), sh = up(h);
  const cols = Math.max(1, Math.min(slots, Math.floor(maxTex / sw)));
  const rows = Math.ceil(slots / cols);
  const at = [];
  for (let s = 0; s < slots; s++) at.push([(s % cols) * sw, Math.floor(s / cols) * sh]);
  return { slot: [sw, sh], cols, rows, size: [cols * sw, rows * sh], at };
}

/**
 * The sharp set's books. opts:
 *   phone       the half set (phones: T1)
 *   slots       the pool's size (POOL_SLOTS by default)
 *   fetchJson() -> Promise of the json (outside.js: web/live/sprites/DETAIL_JSON)
 *   fetchCell(urls, slot, layout) -> Promise, settled once the cell's three pictures are in the pool's slot `slot`
 *               (outside.js: fetched, decoded, copied in at layout.at[slot]; the half set at half those px)
 *   onReady()   a cell came in (outside.js: another frame)
 *   now()       ms (outside.js: performance.now; the tests their own)
 * update(zoom) once a frame (the engine's magnification: zoom.js mag()); cell(type, i) for a cell drawn this frame (its
 * slot when in, else null, and asked for), cell(type, i, true) for one wanted soon (not counted as drawn)
 */
export function createShipDetail({ phone = false, slots, fetchJson, fetchCell, onReady = () => {}, now }) {
  const n = slots ?? (phone ? POOL_SLOTS.phone : POOL_SLOTS.desk);
  let asked = false, meta = null, failed = false, layout = null, frame = 0, inflight = 0, gen = 0, fetched = 0;
  const typeNo = new Map();     // type -> its number (a cell's key: number x 4096 + heading: no strings a frame)
  // the pool's books in typed arrays (read and written every frame: never a boxed number), and a fixed object per slot
  // to hand back ({ x, y } its place in full-set px, type, i)
  const sKey = new Int32Array(n).fill(-1);   // the cell held (-1 none)
  const sState = new Uint8Array(n);          // 0 free, 1 coming, 2 in
  const sUsed = new Int32Array(n);           // the frame it was last asked for
  const sAhead = new Uint8Array(n);          // only ever asked for ahead (soon), not yet drawn
  const pool = [];
  const byKey = new Map();      // key -> slot
  const bad = new Set();        // keys whose files failed: not asked again
  function start(m) {
    meta = m;
    let k = 0;
    for (const ty of Object.keys(m.types)) typeNo.set(ty, k++);
    layout = poolLayout(m, n);
    for (let s = 0; s < n; s++) pool.push({ slot: s, x: layout.at[s][0], y: layout.at[s][1], type: null, i: -1 });
  }
  function update(zoom) {
    frame++;
    if (asked || !(zoom > DETAIL_ZOOM)) return;
    asked = true;
    Promise.resolve().then(fetchJson).then((m) => { if (m && m.types) { start(m); onReady(); } else failed = true; })
      .catch(() => { failed = true; });
  }
  // a slot for a new cell: a free one, else the one drawn longest ago (not within KEEP_FRAMES); a cell to draw now may
  // also take one only ever asked for ahead (soon) and not asked for this frame; one asked for ahead, only a free or
  // stale one
  function freeSlot(soon) {
    let best = -1;
    for (let s = 0; s < n; s++) {
      if (sState[s] === 0) return s;
      const stale = frame - sUsed[s] > KEEP_FRAMES || (!soon && sAhead[s] === 1 && sUsed[s] < frame);
      if (sState[s] === 2 && stale && (best < 0 || sUsed[s] < sUsed[best])) best = s;
    }
    return best;
  }
  function free(s) { if (sKey[s] >= 0) byKey.delete(sKey[s]); sKey[s] = -1; sState[s] = 0; sAhead[s] = 0; pool[s].type = null; pool[s].i = -1; }
  function cell(type, i, soon = false) {
    if (!meta) return null;
    const tn = typeNo.get(type);
    if (tn === undefined || i < 0) return null;
    const key = tn * 4096 + i;
    const s = byKey.get(key);
    if (s !== undefined) {
      if (!soon) { sUsed[s] = frame; sAhead[s] = 0; } else if (sAhead[s] === 1) sUsed[s] = frame;
      return sState[s] === 2 ? pool[s] : null;
    }
    if (inflight >= MAX_INFLIGHT || bad.has(key)) return null;
    const f = freeSlot(soon);
    if (f >= 0) request(type, i, key, f, soon);
    return null;
  }
  // (apart from cell: its callbacks' closure would make every call of cell a context of its own)
  function request(type, i, key, f, soon) {
    free(f);
    sKey[f] = key; sState[f] = 1; sUsed[f] = frame; sAhead[f] = soon ? 1 : 0; pool[f].type = type; pool[f].i = i;
    byKey.set(key, f);
    inflight++;
    const g = gen;
    Promise.resolve().then(() => fetchCell(cellUrls(meta, type, i, phone), f, layout)).then(() => {
      if (g !== gen) return;
      inflight--;
      if (sKey[f] === key) { sState[f] = 2; fetched++; onReady(); }
    }, () => {
      if (g !== gen) return;
      inflight--;
      bad.add(key);
      if (sKey[f] === key) free(f);
    });
  }
  return {
    update, cell,
    get meta() { return meta; },
    get layout() { return layout; },
    get asked() { return asked; },
    get failed() { return failed; },
    get frame() { return frame; },
    phone,
    now: now || (() => 0),
    /** the GL context was lost: every cell gone (asked again as needed; the files come from the browser's cache) */
    reset() { gen++; inflight = 0; bad.clear(); for (let s = 0; s < pool.length; s++) free(s); sUsed.fill(0); },
    /** QA: what is in the pool */
    info() { return { asked, json: !!meta, failed, slots: n, in: pool.filter((p) => sState[p.slot] === 2).map((p) => `${p.type}:${p.i}`), coming: inflight, fetched, size: layout?.size || null }; },
  };
}
