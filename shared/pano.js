// The panorama outside the window (stream X1): its format, which tiles the live camera needs, and tile streaming.
//
// One equirectangular panorama per moment, rendered from the desk eye (docs/v3/outside.md, "Panorama format"):
// yaw -56..+56 deg around the room axis in 7 columns of 16 deg, a city band (-22..+6 deg) at L0 64, L1 32 and
// L2 16 px/deg and a sky band (+6..+56 deg) at L1 32 and L2 16 px/deg, every tile with a 2 px gutter; aux maps (mask
// and two-channel depth) at 20 px/deg; per moment a cloud layer and, in the dark moments, light layers.
//
// GPU side: each kind of tile lives in one TEXTURE_2D_ARRAY with a fixed number of slots (set by the tier), so memory
// is capped however far the camera turns. A tile is fetched only while its column is in view (plus a margin); it
// keeps its slot until another tile needs one (then the stalest tile out of view gives it up: perf-r2, so the window
// comes back sharp). The shader finds a tile through a slot table: -1 = not resident,
// and it then falls back to the next coarser level (L2 is always resident while its moment is shown).
// All GL work runs inside the outside pass (pump), never from an async callback, so three.js's state cache stays true.

export const KINDS = {
  L0c: { band: "city", level: "L0", perCol: true },
  L1c: { band: "city", level: "L1", perCol: true },
  L1s: { band: "sky", level: "L1", perCol: true },
  L2c: { band: "city", level: "L2", perCol: false },
  L2s: { band: "sky", level: "L2", perCol: false },
  clouds: { perCol: false },
  // the light layers: columns 0-6 the moment's lights-<col> (R windows, G lamps, B floodlights); 7-13 its second window
  // group, windows_extra (lightsx-<col>, R: extra lit flats over the base windows, v3/city-detail 0130ec5), the same
  // grid, in the same array (the backdrop has no sampler left), fetched only while its dial is above 0 (EXTRA below)
  lights: { perCol: true },
  // the two-layer panorama's far layer (RGBA: what lies behind the near layer, and the near layer's coverage)
  F1: { band: "far", level: "L1", perCol: true },
  F2: { band: "far", level: "L2", perCol: false },
  // the rendered near layer (park round 2, layers.near2): the deck, courts and park below -3 deg as their own render.
  // N0: its front at L0 (88 px/deg), the dominant moment only. NB: one array of the 44 px/deg tiles, all one size:
  // columns 0-6 the front's L1 (RGBA, premultiplied, alpha = coverage), 7-13 the back layer (the trees and shrubs left
  // out: what a moved eye sees behind them), 14-20 the depth (moment "_near", RGB8: R,G the front's 16 bits, B the
  // back's 8), 21-27 the front's windows_extra (nearx-L1-<col>, RGB over black, added over the front x its dial; only
  // while the dial is above 0). One array because the backdrop shader has two samplers left of WebGL2's 16.
  N0: { band: "near", level: "L0", perCol: true },
  NB: { band: "near", level: "L1", perCol: true },
};
export const NEAR_DEPTH = "_near";       // the near layer's depth tiles: one set for every moment
// windows_extra: the column offsets of its tiles in the lights and NB arrays, and the slots each array grows by the
// first time a dial above 0 asks for them (PanoStore.reserve: never at dial 0, so the memory is today's there)
export const EXTRA = { lightsCol: 7, nearCol: 21, slots: { T1: { lights: 6, NB: 5 }, T2: { lights: 12, NB: 10 }, T3: { lights: 14, NB: 12 } } };
// slots per kind (and how many moments the shader can blend: the pair a/b plus a pair fading out)
// T1 (phones, plan 8.2): L1 city for the shown moment only, the sky from L2, the blend partner from L2 alone; the
// far layer at L2 only
export const SLOTS = {
  T1: { L0c: 0, L1c: 6, L1s: 0, L2c: 3, L2s: 3, clouds: 2, lights: 6, F1: 0, F2: 3, N0: 0, NB: 10 },
  T2: { L0c: 5, L1c: 12, L1s: 10, L2c: 4, L2s: 4, clouds: 4, lights: 12, F1: 12, F2: 4, N0: 4, NB: 20 },
  T3: { L0c: 6, L1c: 14, L1s: 12, L2c: 4, L2s: 4, clouds: 4, lights: 14, F1: 14, F2: 4, N0: 5, NB: 26 },
};
export const MAX_MOMENTS = 4;
const MAX_FETCHES = 4;
// A tile whose fetch failed is asked for again after these waits, then given up for the visit (qa-night A-12: a
// dropped connection or a 503 at GitHub Pages left that part of the distant layer missing until a reload). Given up at
// once: a 4xx other than 408 and 429 (the file is not there), and a tile of the wrong size. (zoom.js's L3 too.)
export const RETRY_MS = [2000, 8000];
export const retryable = (e) => !(e && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429);
// perf #1: the most bytes of pixels handed to the GPU in one frame. A bigger tile goes in as row strips over a few
// frames (an L0 city tile is 1028 x 1796 RGBA, 7.4 MB); it is drawn only once all its rows are in.
export const UPLOAD_BYTES = { T1: 1e6, T2: 2e6, T3: 2e6 };
// while the camera is still (boot, the handover, rest) a long frame moves nothing on screen: the old budget, so the
// window fills as fast as before; the cap above is for the frames that move (the outside passes it per frame)
export const REST_UPLOAD_BYTES = 9e6;
// (DYS-149 pano-bands: and at most UPLOAD_MS of rows a frame, timed. The byte caps alone left the rest frames 9 MB of
// rows: 8-19 ms of texSubImage3D in one frame on the slow laptop (barely-sufficient, CPU 6x: ~1.1-1.3 ms a MB), 9-15
// on phone-mid when J9's glide came to rest (CPU 4x), the largest piece of the cold load's longest run of frames (with
// _fetch, sfTime, streets: 227 ms). Each strip is sized to what is left of the frame's UPLOAD_MS at the rate measured
// on the strips so far; the rest of the tile carries over to the next frame, as before, and the tile is drawn only once
// all its rows are in (_finish): until then the shader keeps the coarser level. A fast machine still meets the byte caps
// first (desk1440: 9 MB in ~2 ms), so it fills as before. By bands only in Blink, as outside.js spread(): WebKit converts
// the whole picture on every sub-rectangle upload, so there more strips would cost more. ?panobands=0: off, as before)
export const UPLOAD_MS = 4;
const UA = typeof navigator !== "undefined" ? navigator.userAgent : "";
const BLINK = /Chrome\/|Chromium\//.test(UA) && !/iP(hone|ad|od)/.test(UA) && !(/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
const BANDS = BLINK && !(typeof location !== "undefined" && new URLSearchParams(location.search).get("panobands") === "0");
// (DYS-149 pano-bytes: outside Blink an opaque tile's rows go up from bytes, not from its ImageBitmap. WebKit converts
// the whole picture on every sub-rectangle upload from a bitmap (hitex-worker.js: the 6144 walnut ~44 ms a strip), so an
// L0 tile (1028 x 1796) cost 8 whole-tile conversions at the phone's 1 MB a frame, each inside a pinch's frame (C's ZC1,
// WebKit as an iPhone 13: frames carrying a strip 21.5-29 ms median against 17 without, a whole tile at the rest cap
// 48-60 ms). Now gl/fit-worker.js decodes the tile with the same call and reads it back in bands of the moving cap's rows
// (a 2D OffscreenCanvas, 1:1, smoothing off: at alpha 255 the bitmap's own texels); _rows uploads from the band that
// holds the next row, with the same offsets, rows and budget, and lets each band go once it is up. Only BYTES_KINDS
// (the city and sky levels and the lights: no alpha in their files); a band with alpha below 255 and every row after it
// go up from the bitmap the worker hands back. And the tiles are decoded in that worker, not on the page (zoom.js's L3
// squares too: decodeTile). In Blink both stay as before: its strips are cheap and it decodes off the main thread
// already. ?panobytes=0: the bitmap's strips, as before; ?tiledecode=page: decoded on the page, as before (the two:
// main's path exactly); ?panobytes=1 and ?tiledecode=worker turn them on in Blink. globalThis.__panoBytes = 0 | 1 and
// __tileDecode = "page" | "worker" switch them for the tiles fetched from then on (an in-page A/B).)
// (C's review: both in WebKit only, by its engine token, not the brand: every iOS browser (Safari, CriOS, FxiOS, EdgiOS:
// AppleWebKit/, no Chrome/) and the iPad's desktop-class Safari, as before. Gecko (Firefox on a desktop or Android:
// Gecko/<n> and Firefox/, no AppleWebKit/), which the takes don't cover, keeps main's path as Blink does, and so does
// any other engine; ?panobytes=1 and ?tiledecode=worker turn them on there too)
export const WEBKIT = /AppleWebKit\//.test(UA) && !BLINK;   // (DYS-216: outside.js's ?bytesup=auto too)
const Q = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
// (DYS-216, E, Deploy 13d's live check: ?bytesfree, on by default, =0 off) A picture let go where the code lets go of it
// (where a bitmap is closed; gl/loader.js letGo likewise, for the room's maps): one held as bytes (an ImageData from the decode workers: bytes-up's room maps, the
// outside's pictures, the window's aux maps, enginelite's probes) has its buffer freed there and then
// (ArrayBuffer.prototype.transfer(0): WebKit 17.4+), not at the next garbage collection. Until that collection every
// such picture stayed in the page's own process after its upload: as an iPhone 13 in WebKit the peak at land grew from
// 1456 MB (Deploy 13, bitmaps) to 1618 (13c, bytes) and 1676 (13d), +154 MB of it in WebContent, the process a phone's
// memory limit counts. Nothing reads a picture once it is let go (a closed bitmap can't be read either), so nothing
// drawn changes; a buffer that can't be detached, or a browser without transfer, is left to the collector as before.
const BYTES_FREE = Q.get("bytesfree") !== "0";
/** (DYS-216 ?bytesfree) A picture let go: a bitmap closed; an ImageData's buffer freed now. outside.js's too. */
export function letGo(p) {
  if (!p) return;
  if (typeof p.close === "function") { p.close(); return; }
  if (!BYTES_FREE || typeof ImageData === "undefined" || !(p instanceof ImageData)) return;
  try { const b = p.data && p.data.buffer; if (b && b.byteLength && typeof b.transfer === "function") b.transfer(0); } catch { /* left to the collector */ }
}
const PANO_BYTES = Q.get("panobytes") === "1" || (WEBKIT && Q.get("panobytes") !== "0");
// (DYS-216, E: bytes-up) the window's aux maps (loadAux) as bytes from the decode workers: ?bytesup=1, or =auto in WebKit
// (DYS-216 first ship: "auto" without ?bytesup, as gl/loader.js and outside.js; ?bytesup=0 or =room: off here)
const BYTES_UP = ((v) => v === "1" || (v === "auto" && WEBKIT))(Q.get("bytesup") ?? "auto");
const TILE_DECODE = Q.get("tiledecode") === "page" || Q.get("tiledecode") === "worker" ? Q.get("tiledecode") : WEBKIT ? "worker" : "page";
// (not L1c / L2c / L2s: outside.js's store.pump reads those tiles' bitmaps for the outside's band and deck numbers before
// they go up, and a tile from bytes has none: PB1 31 Oct, 'j.bmp.height' threw in every bytes page; L0c is the big win)
export const BYTES_KINDS = new Set(["L0c", "L1s", "lights"]);
const OPTS = { colorSpaceConversion: "none", premultiplyAlpha: "none" };   // (the tiles' decode: display values, straight alpha)
const IDLE_MS = 15000;     // (pano-bytes) a decode worker with nothing to do for this long is let go (phones' memory)
const bytesOn = () => (globalThis.__panoBytes != null ? !!+globalThis.__panoBytes : PANO_BYTES);
const decodeHere = () => (globalThis.__tileDecode ? globalThis.__tileDecode === "page" : TILE_DECODE === "page");
export const panoBytes = () => ({ bytes: bytesOn(), decode: decodeHere() ? "page" : "worker" });

/** (DYS-149 pano-bytes) A decoded tile's pixels, let go: its bitmap closed, its bands dropped. */
export function freePic(p) {
  if (!p) return;
  letGo(p.bmp);   // (DYS-216 ?bytesfree: a bitmap closed, bytes freed; {mask, depth} untouched, as before)
  p.bands = null;
}
const bandBytes = (bands) => (bands || []).reduce((s, b) => s + (b ? b.buf.byteLength : 0), 0);

/** (DYS-149 pano-bytes) gl/fit-worker.js for one lane of tiles ("pano": PanoStore's, "l3": zoom.js's squares), started
 * with its first tile and let go after IDLE_MS with none. Off for the visit once it fails (then the page decodes, as
 * before); its bytes off for the visit once a readback fails (then the worker's bitmaps, as before). A file it can't
 * decode turns neither off (C's review: _undecoded). */
class TileDecoder {
  constructor(lane) {
    this.lane = lane;
    this.w = null;
    this.off = typeof Worker === "undefined" ? "no Worker" : null;
    this.bytesOff = typeof OffscreenCanvas === "undefined" ? "no OffscreenCanvas" : null;
    this.asks = new Map();     // id -> { resolve, reject, bands, size }
    this.seq = 0;
    this.idle = 0;
    this.n = { asBytes: 0, asBitmap: 0, onPage: 0, bitmapRest: 0, undecoded: 0 };   // tiles by the way they came (stats; undecoded: files the worker could not decode, C's review)
  }
  _worker() {
    if (this.w || this.off) return this.w;
    try {
      const w = new Worker(new URL("./gl/fit-worker.js", import.meta.url));
      w.onmessage = ({ data }) => this._reply(data);
      w.onerror = (e) => { e.preventDefault?.(); this._down(`the worker failed${e.message ? ": " + e.message : ""}`); };
      w.onmessageerror = () => this._down("a reply could not be read");
      this.w = w;
    } catch (e) {
      this._down(String((e && e.message) || e));
    }
    return this.w;
  }
  /** Off for the visit: what it still had is answered with an error (each caller decodes it on the page). */
  _down(why) {
    if (!this.off && Q.has("debug")) console.info(`[outside] ${this.lane} tiles decoded on the page (DYS-149): ${why}`);
    this.off = why;
    this.w?.terminate();
    this.w = null;
    clearTimeout(this.idle);
    const left = [...this.asks.values()];
    this.asks.clear();
    for (const a of left) { a.bands = null; a.reject(Object.assign(new Error(why), { worker: true })); }
  }
  _ask(msg) {
    const w = this._worker();
    if (!w) return Promise.reject(Object.assign(new Error(this.off), { worker: true }));
    clearTimeout(this.idle);
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.asks.set(id, { resolve, reject, bands: msg.bands ? [] : null, size: null });
      try { w.postMessage({ id, ...msg }); } catch (e) { this._down(String((e && e.message) || e)); }
    });
  }
  _reply(data) {
    const a = this.asks.get(data.id);
    if (!a) return;
    if (data.buf) { a.bands.push({ y: data.y, n: data.n, buf: data.buf }); return; }
    if (data.size) { a.size = data.size; return; }
    this.asks.delete(data.id);
    if (!this.asks.size) { clearTimeout(this.idle); this.idle = setTimeout(() => { if (!this.asks.size && this.w) { this.w.terminate(); this.w = null; } }, IDLE_MS); }
    if (data.error && data.decode) {
      // (C's review: the file itself was not decoded (a bad or truncated response): neither the readback's failure nor
      // the worker's, so the bytes and the worker stay on; decode() takes it from here (_undecoded). An old cached
      // fit-worker.js sends no `decode`: as before, below)
      a.bands = null;
      a.reject(Object.assign(new Error(data.error), { decode: true }));
    } else if (data.error && data.bands) {
      // (its readback: bytes off for the visit; this tile's bitmap from the same worker)
      this.bytesOff = data.error;
      a.bands = null;
      a.reject(Object.assign(new Error(data.error), { bytes: true }));
    } else if (data.error || (!data.done && !data.bitmap)) {
      a.bands = null;
      this._down(data.error || "no bitmap");
      a.reject(Object.assign(new Error(data.error || "no bitmap"), { worker: true }));
    } else if (a.bands) {
      // (the bands must cover rows [0, from) in order, each after the last: else bytes off, this tile's bitmap instead)
      const from = data.bitmap ? data.from : a.size?.[1];
      let y = 0;
      for (const b of a.bands) { if (b.y !== y || b.buf.byteLength !== b.n * a.size[0] * 4) { y = -1; break; } y += b.n; }
      if (y !== from) {
        data.bitmap?.close();
        a.bands = null;
        this.bytesOff = `the bands did not cover rows 0-${from}`;
        a.reject(Object.assign(new Error(this.bytesOff), { bytes: true }));
        return;
      }
      if (data.bitmap) this.n.bitmapRest++;
      a.resolve({ bands: a.bands, size: a.size, from, bmp: data.bitmap || null, ms: data.ms });
    } else a.resolve({ bmp: data.bitmap, ms: data.ms });
  }
  /** A tile's pixels: { bmp } (a bitmap), or { bands, size, from, bmp } (bytes for rows [0, from), the bitmap after). */
  async decode(blob, opts, rows) {
    if (rows && !this.bytesOff && !this.off) {
      try { const p = await this._ask({ blob, opts, bands: rows }); this.n.asBytes++; return p; } catch (e) { if (e.decode) return this._undecoded(blob, opts, e); if (!e.bytes && !e.worker) throw e; }
    }
    if (!this.off && !decodeHere()) {
      try { const p = await this._ask({ blob, opts, maxSize: 0 }); this.n.asBitmap++; return { bmp: p.bmp }; } catch (e) { if (e.decode) return this._undecoded(blob, opts, e); if (!e.worker) throw e; }
    }
    this.n.onPage++;
    return { bmp: await createImageBitmap(blob, opts) };
  }
  /** (C's review) A file the worker could not decode, decoded on the page (main's call): when that fails too (a bad or
   * truncated response) its error is the tile's, as main's was (PanoStore._fetch's retry, zoom.js's the same), and the
   * bytes and the worker stay on for the next tile; when the page decodes it, the worker can't decode these files: off
   * for the visit, as one that fails. */
  async _undecoded(blob, opts, e) {
    this.n.undecoded++;
    const bmp = await createImageBitmap(blob, opts);
    this._down(`a file decoded on the page but not in the worker (${e.message})`);
    this.n.onPage++;
    return { bmp };
  }
  stats() { return { lane: this.lane, worker: this.off ? `off: ${this.off}` : this.w ? "on" : "idle", bytes: this.bytesOff ? `off: ${this.bytesOff}` : "on", ...this.n }; }
}
const decoders = {};

/** (DYS-149 pano-bytes) A tile's file decoded with the tiles' options, in gl/fit-worker.js unless ?tiledecode=page (or
 * __tileDecode), and with rows > 0 and the bytes on, read back as bands of that many rows (see TileDecoder.decode).
 * Any failure of the worker: decoded on the page, as before. */
export function decodeTile(blob, { lane = "pano", rows = 0 } = {}) {
  if (decodeHere() && !(rows && bytesOn())) return createImageBitmap(blob, OPTS).then((bmp) => ({ bmp }));
  const d = decoders[lane] || (decoders[lane] = new TileDecoder(lane));
  return d.decode(blob, OPTS, bytesOn() ? rows : 0);
}
export const decodeStats = () => Object.values(decoders).map((d) => d.stats());

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** Load pano.json; returns the metadata with resolved URLs and the derived tile geometry. */
export async function loadPano(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const meta = await res.json();
  meta.base = new URL(".", new URL(url, location.href)).href;
  meta.geo = geometry(meta);
  return meta;
}

/** Tile sizes (with gutters) per kind, in pixels. */
export function geometry(meta) {
  const g = meta.gutter, cw = meta.column_deg, W = meta.yaw[1] - meta.yaw[0];
  const bands = { ...meta.bands };
  const far = meta.layers?.far;
  if (far) bands.far = { el: far.el, levels: far.levels };
  const near = meta.layers?.near2;
  if (near) bands.near = { el: near.el, levels: near.levels };
  const band = (b) => bands[b].el[1] - bands[b].el[0];
  const size = {};
  for (const [k, spec] of Object.entries(KINDS)) {
    if (spec.band === "far" && !far) continue;
    if (spec.band === "near" && !near) continue;
    if (k === "clouds") {
      const c = meta.clouds;
      if (c) size[k] = [Math.round((c.yaw[1] - c.yaw[0]) * c.ppd) + 2 * (c.gutter ?? g), Math.round((c.el[1] - c.el[0]) * c.ppd) + 2 * (c.gutter ?? g)];
      continue;
    }
    if (k === "lights") {
      const p = meta.lights?.ppd;
      if (p) size[k] = [Math.round(cw * p) + 2 * g, Math.round(band("city") * p) + 2 * g];
      continue;
    }
    const p = bands[spec.band].levels[spec.level];
    if (!p) continue;
    size[k] = spec.perCol ? [Math.round(cw * p) + 2 * g, Math.round(band(spec.band) * p) + 2 * g]
      : [Math.round(W * p) + 2 * g, Math.round(band(spec.band) * p) + 2 * g];
  }
  return { size };
}

/** A near-layer tile's file (layers.near2: its own folder, "dir", beside the panorama's). */
export function nearUrl(meta, moment, kind, col) {
  const n = meta.layers.near2, base = meta.base + (n.dir || "");
  if (kind === "NB" && col >= EXTRA.nearCol) return `${base}${moment}/${n.extra.tiles.replace("{col}", col - EXTRA.nearCol)}`;
  if (kind === "NB" && col >= 14) return base + n.depth.tiles.replace("{col}", col - 14);
  if (kind === "NB" && col >= 7) return `${base}${moment}/nearback-L1-${col - 7}.avif`;
  return `${base}${moment}/near-${kind === "N0" ? "L0" : "L1"}-${col}.avif`;
}

/** The file of one tile, relative to the panorama's base. */
export function tileUrl(meta, moment, kind, col) {
  if (kind === "N0" || kind === "NB") return nearUrl(meta, moment, kind, col);
  const m = meta.moments[moment];
  const dir = meta.base + (m.dir || `${moment}/`);
  const spec = KINDS[kind];
  if (kind === "clouds") return dir + m.clouds;
  if (kind === "lights" && col >= EXTRA.lightsCol) return dir + m.lights.extra.tiles.replace("{col}", col - EXTRA.lightsCol);
  if (kind === "lights") return dir + m.lights.tiles.replace("{col}", col);
  if (kind === "F1") return `${dir}far-L1-${col}.avif`;
  if (kind === "F2") return `${dir}far-L2.avif`;
  if (spec.level === "L2") return `${dir}${spec.band}-L2.avif`;
  return `${dir}${spec.band}-${spec.level}-${col}.avif`;
}

/** windows_extra: does this moment carry the second window group, in the panorama (lights.extra) or the near layer
 * (near2.json's extra.moments)? */
export function hasExtra(meta, moment, kind) {
  if (kind === "lights") return !!meta.moments[moment]?.lights?.extra?.tiles;
  const x = meta.layers?.near2?.extra;
  return !!(x?.tiles && (!x.moments || x.moments.includes(moment)) && meta.moments[moment]?.near2);
}
const isExtra = (k, c) => (k === "lights" && c >= EXTRA.lightsCol) || (k === "NB" && c >= EXTRA.nearCol);

const DEG = Math.PI / 180;

/**
 * The yaw and elevation range (deg, panorama frame) seen through the window from a camera, by sampling rays across
 * the window's screen rectangle. cam: { pos: [x, y, z] (engine), rayAt(ndcX, ndcY) -> [x, y, z] world direction }.
 * Parallax moves near things by up to ~2 deg at the window spot, so callers add a margin.
 */
export function viewRange(rayAt, rect, width, height, n = 7, through = null) {
  let y0 = Infinity, y1 = -Infinity, e0 = Infinity, e1 = -Infinity;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const x = ((rect[0] + (rect[2] * i) / n) / width) * 2 - 1, y = ((rect[1] + (rect[3] * j) / n) / height) * 2 - 1;
      const d = rayAt(x, y);
      if (through && !through(d)) continue;      // this ray meets the wall, not the glass
      const yaw = Math.atan2(d[0], -d[2]) / DEG, el = Math.asin(clamp(d[1], -1, 1)) / DEG;
      y0 = Math.min(y0, yaw); y1 = Math.max(y1, yaw); e0 = Math.min(e0, el); e1 = Math.max(e1, el);
    }
  }
  return y0 > y1 ? null : { yaw: [y0, y1], el: [e0, e1] };
}

/** A test for view rays from eye (engine coordinates): does the ray pass through the window opening (a planar quad,
 * corners in order), grown by `margin` metres? */
export function throughWindow(eye, corners, margin = 0.08) {
  if (!corners || corners.length < 4) return null;
  const [a, b, , d] = corners;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const lu = Math.hypot(...u), lv = Math.hypot(...v);
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const ea = [a[0] - eye[0], a[1] - eye[1], a[2] - eye[2]];
  return (dir) => {
    const dn = dot(dir, n);
    if (Math.abs(dn) < 1e-9) return false;
    const t = dot(ea, n) / dn;
    if (t <= 0) return false;
    const p = [eye[0] + dir[0] * t - a[0], eye[1] + dir[1] * t - a[1], eye[2] + dir[2] * t - a[2]];
    const s = dot(p, u) / lu, r = dot(p, v) / lv;
    return s > -margin && s < lu + margin && r > -margin && r < lv + margin;
  };
}

export function columnsFor(meta, yawRange, margin = 2.5) {
  const out = [];
  const c0 = Math.floor((yawRange[0] - margin - meta.yaw[0]) / meta.column_deg);
  const c1 = Math.floor((yawRange[1] + margin - meta.yaw[0]) / meta.column_deg);
  for (let c = Math.max(0, c0); c <= Math.min(meta.columns - 1, c1); c++) out.push(c);
  return out;
}

/** Slot-based texture arrays and the fetch / decode / upload queue. */
export class PanoStore {
  // wake: asks the engine for a frame (a retry falls due while nothing else draws)
  constructor(gl, meta, { tier = "T2", onLoaded = null, wake = null } = {}) {
    this.gl = gl;
    this.meta = meta;
    this.slotsOf = { ...(SLOTS[tier] || SLOTS.T2) };   // (a copy: reserve() grows it for windows_extra)
    this.tier = SLOTS[tier] ? tier : "T2";
    this.growTo = {};          // kind -> slots asked for by reserve(), applied inside pump
    this.budget = UPLOAD_BYTES[tier] || UPLOAD_BYTES.T2;   // bytes uploaded per frame (pump)
    this.upMs = BANDS ? UPLOAD_MS : 0;   // (DYS-149 pano-bands) ms of rows per frame (0: the byte caps alone)
    this.rate = 0;             // (pano-bands) ms per byte of the rows' uploads, measured (_timed); 0: none yet
    this.upMax = 0;            // (pano-bands) the longest frame's upload ms so far (stats)
    this.up = null;            // the upload under way, a few rows a frame: { key, kind, A, slot, parts, at, job }
    this.arrays = {};          // kind -> { tex, w, h, n, owner: [key | null], seen: [ms] }
    this.where = new Map();    // key -> { kind, slot }
    this.pending = new Map();  // key -> "fetch" | bitmap ready
    this.ready = [];           // decoded bitmaps waiting for an upload: { key, kind, bmp } (pano-bytes: or { bands, size, from, bmp })
    this.fetching = 0;
    this.wantNow = new Map();  // key -> priority (lower first), rebuilt every frame
    this.failed = new Set();   // given up: never asked for again (until a lost context)
    this.retry = new Map();    // key -> { n, at }: its fetch failed n times; asked for again from `at` (RETRY_MS)
    this.onLoaded = onLoaded;
    this.wake = wake;
    this.aux = null;           // { mask, depth } WebGL textures
    this.auxState = "none";
    this.auxTries = 0;
    this.bytes = 0;            // bytes fetched (for the report)
    this.uploads = 0;
    this.dead = false;
    this.held = 0;             // (DYS-149 pano-bytes) bytes of tile rows held on the page, waiting for the GPU (ready, up)
    this.heldMax = 0;          // (pano-bytes) the most held at once
    this.byBytes = 0;          // (pano-bytes) strips uploaded from bytes (stats)
  }

  key(moment, kind, col = 0) { return `${moment}|${kind}|${col}`; }
  has(moment, kind, col = 0) { return this.where.has(this.key(moment, kind, col)); }
  slot(moment, kind, col = 0) { const w = this.where.get(this.key(moment, kind, col)); return w ? w.slot : -1; }

  /** Declare what is wanted this frame, in priority order: [[moment, kind, col], ...]. Starts fetches. */
  want(list, now = performance.now()) {
    this.wantNow.clear();
    this.again = false;
    list.forEach(([m, k, c], i) => {
      if (!this.slotsOf[k] && k !== "aux") return;
      if (k === "lights" && !this.meta.moments[m]?.lights) return;
      if (isExtra(k, c) && !hasExtra(this.meta, m, k)) return;
      if (k === "clouds" && !this.meta.moments[m]?.clouds) return;
      if ((k === "F1" || k === "F2") && !this.meta.geo.size[k]) return;   // a one-layer panorama
      if ((k === "N0" || k === "NB") && (!this.meta.geo.size[k] || (m !== NEAR_DEPTH && !this.meta.moments[m]?.near2))) return;
      const key = this.key(m, k, c);
      if (!this.wantNow.has(key)) this.wantNow.set(key, i);
      const w = this.where.get(key);
      if (w) this.arrays[k].seen[w.slot] = now;
    });
    // fetch the most wanted first, a few at a time
    if (this.fetching < MAX_FETCHES) {
      for (const [key] of [...this.wantNow.entries()].sort((a, b) => a[1] - b[1])) {
        if (this.fetching >= MAX_FETCHES) break;
        if (this.where.has(key) || this.pending.has(key) || this.failed.has(key)) continue;
        const r = this.retry.get(key);
        if (r && now < r.at) continue;                   // (failed: asked for again from r.at)
        const [m, k, c] = key.split("|");
        if (!this._slotFor(k, now, true)) continue;      // no slot could take it now: don't fetch yet
        this._fetch(key, m, k, +c);
      }
    }
  }

  /** Are these tiles all on the GPU? */
  allResident(list) {
    return list.every(([m, k, c]) => this.where.has(this.key(m, k, c)) || (k === "lights" && !this.meta.moments[m]?.lights) ||
      (isExtra(k, c) && !hasExtra(this.meta, m, k)) ||
      ((k === "N0" || k === "NB") && (!this.meta.geo.size[k] || (m !== NEAR_DEPTH && !this.meta.moments[m]?.near2))) ||
      (k === "clouds" && !this.meta.moments[m]?.clouds) || !this.slotsOf[k] || !this.meta.geo.size[k]);
  }
  // (again: an array just grew; one more frame asks for what had no slot before)
  get busy() { return this.fetching > 0 || this.ready.length > 0 || !!this.up || this.auxState === "loading" || !!this.again; }

  async _fetch(key, moment, kind, col) {
    this.pending.set(key, "fetch");
    this.fetching++;
    try {
      const res = await fetch(tileUrl(this.meta, moment, kind, col));
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      const blob = await res.blob();
      this.bytes += blob.size;
      // panorama pixels are display values already: no colour conversion, straight alpha (the cloud layer)
      // (DYS-149 pano-bytes: decoded in the worker; an opaque kind as bands of the moving cap's rows: decodeTile)
      const pic = await decodeTile(blob, { rows: BYTES_KINDS.has(kind) ? this._bandRows(kind) : 0 });
      if (this.dead) { freePic(pic); return; }
      this.retry.delete(key);
      if (pic.bands) this._hold(bandBytes(pic.bands));
      this.ready.push({ key, kind, ...pic });
    } catch (e) {
      this.pending.delete(key);
      this._failed(key, e);
    } finally {
      this.fetching--;
    }
  }

  // A fetch that failed: asked for again after RETRY_MS (the engine woken then), or given up.
  _failed(key, e) {
    if (this.dead) return;
    const n = (this.retry.get(key)?.n || 0) + 1;
    if (retryable(e) && n <= RETRY_MS.length) {
      const ms = RETRY_MS[n - 1];
      this.retry.set(key, { n, at: performance.now() + ms });
      console.warn("[outside] tile", key, e.message, `(again in ${ms / 1000} s)`);
      setTimeout(() => { if (!this.dead) this.wake?.(); }, ms + 20);
    } else {
      this.retry.delete(key);
      this.failed.add(key);
      console.warn("[outside] tile", key, e.message);
    }
  }

  async loadAux() {
    if (this.auxState !== "none") return;
    this.auxState = "loading";
    const a = this.meta.aux;
    const get = async (p) => {
      const r = await fetch(this.meta.base + p);
      if (!r.ok) throw Object.assign(new Error(`${p}: HTTP ${r.status}`), { status: r.status });
      const b = await r.blob();
      this.bytes += b.size;
      const opts = { colorSpaceConversion: "none", premultiplyAlpha: "none" };
      // (DYS-216 bytes-up: in the decode workers, back as bytes (an ImageData) that _rows copies, not a bitmap WebKit converts)
      if (BYTES_UP) { try { return await (await import("./gl/loader.js")).decodePicture(b, opts); } catch { /* on the page, as before */ } }
      return createImageBitmap(b, opts);
    };
    try {
      const [mask, depth] = await Promise.all([get(a.mask), get(a.depth)]);
      this.ready.push({ key: "aux", kind: "aux", bmp: { mask, depth } });
    } catch (e) {
      console.warn("[outside] aux", e.message);
      this.auxState = "failed";
      // (asked for again as a tile is: without the mask and depth no tile is ever shown)
      const ms = retryable(e) ? RETRY_MS[this.auxTries++] : 0;
      if (ms) setTimeout(() => { if (!this.dead && this.auxState === "failed") { this.auxState = "none"; this.loadAux(); this.wake?.(); } }, ms);
    }
  }

  _array(kind) {
    let A = this.arrays[kind];
    if (A) return A;
    const n = this.slotsOf[kind];
    const size = this.meta.geo.size[kind];
    if (!n || !size) return null;
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, size[0], size[1], n);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    A = { tex, w: size[0], h: size[1], n, owner: new Array(n).fill(null), seen: new Array(n).fill(0) };
    this.arrays[kind] = A;
    return A;
  }

  /** windows_extra: let this kind's array hold n slots from now on (only ever more). Called while a dial above 0 asks
   * for the extra tiles; an array not made yet is made at that size, one made already grows inside the next pump. */
  reserve(kind, n) {
    if (!(n > (this.slotsOf[kind] || 0)) || n <= (this.growTo[kind] || 0)) return;
    if (!this.arrays[kind]) this.slotsOf[kind] = n;
    else this.growTo[kind] = n;
  }

  /** An array grown to n slots: a new one, every resident layer copied on the GPU (the tiles stay in their slots, the
   * shader sees no change), the old one deleted. Inside the outside pass; the read framebuffer binding is put back. */
  _grow(kind, n) {
    const A = this.arrays[kind], gl = this.gl;
    this.slotsOf[kind] = Math.max(this.slotsOf[kind] || 0, n);
    if (!A || A.n >= n) return;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, A.w, A.h, n);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    for (let i = 0; i < A.n; i++) {
      if (A.owner[i] === null) continue;            // (a tile under way counts: its rows so far come along)
      gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, A.tex, 0, i);
      gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, 0, 0, A.w, A.h);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
    gl.deleteFramebuffer(fb);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    gl.deleteTexture(A.tex);
    if (this.up && this.up.A === A) this.up.parts[0].tex = tex;
    A.tex = tex;
    for (let i = A.n; i < n; i++) { A.owner.push(null); A.seen.push(0); }
    A.n = n;
    this.grown = (this.grown || 0) + 1;
    this.again = true;
  }

  /** A free slot (or one whose tile has been out of view for a while); peek: only test. */
  _slotFor(kind, now, peek = false) {
    const n = this.slotsOf[kind];
    if (!n) return null;
    const A = this.arrays[kind];
    if (!A) return peek ? true : this._array(kind) && 0;
    let free = A.owner.indexOf(null);
    if (free < 0) {
      // the stalest tile that isn't wanted this frame (a wanted tile always beats one that just left the view)
      let best = -1, bestSeen = Infinity;
      A.owner.forEach((k, i) => {
        if (this.wantNow.has(k)) return;
        if (A.seen[i] < bestSeen) { bestSeen = A.seen[i]; best = i; }
      });
      if (best < 0) return peek ? false : null;
      if (peek) return true;
      this.where.delete(A.owner[best]);
      A.owner[best] = null;
      free = best;
    }
    return peek ? true : free;
  }

  /** Inside the outside pass: upload what is decoded: at most budgetBytes of pixels a frame, a big tile in row strips
   * over a few frames (perf #1), the most wanted first. (Slots are not handed back here: a tile keeps its slot until
   * another needs one, _slotFor.) (DYS-149 pano-bands: and at most upMs of uploads a frame, UPLOAD_MS) (DYS-203 HS1:
   * and at most maxTiles tiles finished a frame, 0: no such cap; outside.js, WebKit through the hand-off) */
  pump(now = performance.now(), budgetBytes = this.budget, maxTiles = 0) {
    const gl = this.gl;
    const t0 = this.upMs ? performance.now() : 0;   // (DYS-149 pano-bands: the frame's upload clock)
    for (const [k, n] of Object.entries(this.growTo)) { this._grow(k, n); delete this.growTo[k]; }
    if (!this.up && !this.ready.length) return false;
    let spent = 0, did = false, done = 0;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    while (spent < budgetBytes) {
      if (!this.up) {
        this.up = this._start(now);
        if (!this.up) break;
        spent += this.up.cleared;
      }
      const u = this.up;
      if (u.A && u.A.owner[u.slot] !== u.key) {
        // its slot went to another tile meanwhile (a safeguard: _slotFor only runs between uploads): drop it, fetch again later
        this._drop(u);
        this.up = null;
        continue;
      }
      const p = u.parts[u.at], row = p.w * 4;
      // whole rows within what is left of the budget; the first strip of a frame is at least one row
      // (DYS-149 pano-bands: and within what is left of the frame's upMs at the measured rate; before any measurement,
      // one strip of the tier's moving cap, timed)
      let left = budgetBytes - spent;
      if (this.upMs) left = Math.min(left, this.rate ? (this.upMs - (performance.now() - t0)) / this.rate : this.budget);
      const n = Math.min(p.rows - p.y, Math.max(spent > 0 ? 0 : 1, Math.floor(left / row)));
      if (n <= 0) break;
      const a = this.upMs ? performance.now() : 0;
      const k = this._rows(p, n);         // (pano-bytes: from bytes, at most to the end of the band; else n)
      if (this.upMs) this._timed(k * row, performance.now() - a);
      spent += k * row;
      if (p.y < p.rows) continue;
      if (++u.at < u.parts.length) continue;
      this._finish(u, now);
      this.up = null;
      did = true;
      if (maxTiles && ++done >= maxTiles) break;
    }
    if (this.upMs) this.upMax = Math.max(this.upMax, performance.now() - t0);
    return did;
  }

  /** (DYS-149 pano-bands) One strip's upload time into the rate (ms per byte): up quickly when a strip was slower
   * (one slow strip counts at most 4x the rate so far: a GC or a busy Mac mid-call), down gently. A strip under 256 KB
   * is too short to time against performance.now's coarse clock (0.1 ms). */
  _timed(bytes, ms) {
    // (C's review since 069e1e7d, 1: strips under 256 KB are added up until they reach it and then timed together:
    // a high rate sizes every strip small, and with small strips never timed one slow early strip froze the rate for
    // the visit, uploads at a fraction of the true speed)
    this.tBytes = (this.tBytes || 0) + bytes;
    this.tMs = (this.tMs || 0) + ms;
    if (this.tBytes < 1 << 18) return;
    bytes = this.tBytes; ms = this.tMs;
    this.tBytes = this.tMs = 0;
    const r = this.rate ? Math.min(ms / bytes, 4 * this.rate) : ms / bytes;
    this.rate += (!this.rate ? 1 : r > this.rate ? 0.5 : 0.3) * (r - this.rate);
  }

  /** The next upload: the aux maps first (nothing is drawn without them), then the tiles in the order the outside wants
   * them this frame, then the rest as they arrived; a job marked hold (the outside is still reading its pixels) waits.
   * The slot, the size check and a far tile's cleared rows as before; the slot is the tile's from here on, but the
   * shader sees the tile only from _finish. */
  _start(now) {
    const gl = this.gl;
    for (;;) {
      let best = -1, bestP = Infinity;
      for (let i = 0; i < this.ready.length; i++) {
        const j = this.ready[i];
        if (j.hold) continue;
        const pr = j.kind === "aux" ? -1 : this.wantNow.has(j.key) ? this.wantNow.get(j.key) : Infinity;
        if (best < 0 || pr < bestP) { best = i; bestP = pr; }
      }
      if (best < 0) return null;
      const job = this.ready.splice(best, 1)[0];
      if (job.kind === "aux") {
        const part = (b) => ({ tex: this._tex2d(b.width, b.height), layer: -1, bmp: b, w: b.width, rows: b.height, y: 0, y0: 0 });
        return { key: "aux", kind: "aux", job, A: null, slot: -1, cleared: 0, parts: [part(job.bmp.mask), part(job.bmp.depth)], at: 0 };
      }
      const { key, kind, bmp } = job;
      // (DYS-149 pano-bytes: a tile from bytes has its size beside its bands; one from a bitmap, the bitmap's)
      const [bw, bh] = job.size || [bmp.width, bmp.height];
      this.pending.delete(key);
      if (!this.wantNow.has(key) && !this.where.has(key)) {
        // left the view while loading: keep it if a slot is free anyway, else drop it
        const A = this.arrays[kind];
        if (A && A.owner.indexOf(null) < 0) { this._free(job); continue; }
      }
      const slot = this._slotFor(kind, now);
      if (slot === null || slot === undefined) { this._free(job); continue; }
      const A = this._array(kind);
      // a moment from another set (the live preview's merged panorama: the stand-in's moments in R2's frame) may
      // carry a far layer over fewer elevations (its own far_el): it goes in at its rows, the rest is cleared
      // (coverage 0: the panorama itself shows there)
      const yOff = (kind === "F1" || kind === "F2") ? this._farRowOffset(key.split("|")[0], kind) : 0;
      if (bw !== A.w || bh + yOff > A.h || (!yOff && bh !== A.h)) {
        console.warn(`[outside] ${key}: ${bw}x${bh}, expected ${A.w}x${A.h}`);
        this._free(job);
        this.failed.add(key);
        continue;
      }
      let cleared = 0;
      if (yOff || bh !== A.h) {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, A.tex);
        const clear = (y0, rows) => { if (rows > 0) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, y0, slot, A.w, rows, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(A.w * rows * 4)); };
        clear(0, yOff);
        clear(yOff + bh, A.h - yOff - bh);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
        cleared = A.w * (A.h - bh) * 4;
      }
      // reserved: no other tile takes the slot while the rows go in, and no second fetch of this tile starts
      A.owner[slot] = key;
      A.seen[slot] = now;
      this.pending.set(key, "upload");
      // (pano-bytes: bands, rows [0, from) as bytes, bi the band that holds the next row; the bitmap from `from` on)
      const part = { tex: A.tex, layer: slot, bmp, w: bw, rows: bh, y: 0, y0: yOff };
      if (job.bands) Object.assign(part, { bands: job.bands, from: job.from, bi: 0 });
      return { key, kind, job, A, slot, cleared, parts: [part], at: 0 };
    }
  }

  /** n more rows of a picture into its texture (a sub-rectangle of the picture: WebGL2's UNPACK_SKIP_ROWS). Returns the
   * rows uploaded: n, or (DYS-149 pano-bytes) from bytes at most to the end of the band that holds row p.y, which is let
   * go once its last row is up. */
  _rows(p, n) {
    const gl = this.gl;
    if (p.bands && p.y < p.from) {
      const b = p.bands[p.bi], row = p.w * 4;
      n = Math.min(n, b.y + b.n - p.y);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, p.tex);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, p.y0 + p.y, p.layer, p.w, n, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(b.buf, (p.y - b.y) * row, n * row));
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      p.y += n;
      this.byBytes++;
      if (p.y >= b.y + b.n) { p.bands[p.bi++] = null; this._hold(-b.buf.byteLength); }
      return n;
    }
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, p.y);
    if (p.layer >= 0) {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, p.tex);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, p.y0 + p.y, p.layer, p.w, n, 1, gl.RGBA, gl.UNSIGNED_BYTE, p.bmp);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, p.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, p.y, p.w, n, gl.RGBA, gl.UNSIGNED_BYTE, p.bmp);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);    // (the default again: the cleared rows and three.js's own uploads assume it)
    p.y += n;
    return n;
  }

  /** (DYS-149 pano-bytes) The rows of a band: the tier's moving cap of this kind's rows (the strips WebKit uploads a
   * moving frame, so a band is one strip; the rest cap takes several in one frame). */
  _bandRows(kind) {
    const w = this.meta.geo.size[kind]?.[0];
    return w ? Math.max(1, Math.floor(this.budget / (w * 4))) : 0;
  }
  /** (pano-bytes) Bytes of rows held on the page, counted (stats: held, heldMaxMB). */
  _hold(d) {
    this.held += d;
    if (this.held > this.heldMax) this.heldMax = this.held;
  }
  /** (pano-bytes) A tile's pixels let go before or during its upload: its bitmap closed, its bands' bytes uncounted. */
  _free(x) {
    if (x.bands) this._hold(-bandBytes(x.bands));
    freePic(x);
  }

  /** All rows in: the tile is resident (the shader finds it from now), or the aux maps are ready. */
  _finish(u, now) {
    if (u.kind === "aux") {
      const [mask, depth] = u.parts;
      this.aux = { mask: mask.tex, depth: depth.tex, size: [depth.w, depth.rows] };
      letGo(mask.bmp); letGo(depth.bmp);   // (DYS-216 ?bytesfree: an ImageData's buffer freed now)
      this.auxState = "ready";
      return;
    }
    const { key, kind, A, slot } = u;
    this.pending.delete(key);
    A.seen[slot] = now;
    this.where.set(key, { kind, slot });
    this.uploads++;
    this._free(u.parts[0]);
    this.onLoaded?.(key);
  }

  /** An upload given up halfway (its slot was handed back, the context was lost or the store disposed). */
  _drop(u) {
    for (const p of u.parts) this._free(p);
    if (u.kind === "aux") {
      if (this.auxState === "loading") this.auxState = "none";   // (lost() and dispose() set their own state)
      return;
    }
    this.pending.delete(u.key);
  }

  /** Rows between the far band's top and a moment's own far-layer top (0 when the moment has none of its own). */
  _farRowOffset(moment, kind) {
    const own = this.meta.moments[moment]?.far_el, far = this.meta.layers?.far;
    if (!own || !far) return 0;
    const ppd = far.levels[kind === "F1" ? "L1" : "L2"];
    return Math.max(0, Math.round((far.el[1] - own[1]) * ppd));
  }

  /** An aux map's texture: RGBA8, one level, linear, clamped; its rows come in through _rows (perf #1). */
  _tex2d(w, h) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }

  /** GPU memory held by the arrays and aux (bytes). */
  memory() {
    let b = 0;
    for (const A of Object.values(this.arrays)) b += A.w * A.h * 4 * A.n;
    if (this.aux) b += this.aux.size[0] * this.aux.size[1] * 8;
    return b;
  }

  stats() {
    const out = {};
    for (const [k, A] of Object.entries(this.arrays)) out[k] = `${A.owner.filter(Boolean).length}/${A.n}`;
    return { slots: out, resident: this.where.size, fetching: this.fetching, queued: this.ready.length + (this.up ? 1 : 0), uploads: this.uploads, mb: +(this.memory() / 1e6).toFixed(1), fetchedKB: Math.round(this.bytes / 1024), failed: [...this.failed], retrying: [...this.retry.keys()],
      // (DYS-149 pano-bands: the frame's upload cap, the measured rate in MB per ms, the longest frame's upload ms)
      bands: this.upMs ? { ms: this.upMs, mbPerMs: this.rate ? +(1e-6 / this.rate).toFixed(2) : null, maxMs: +this.upMax.toFixed(1) } : null,
      // (DYS-149 pano-bytes: the switches, the strips from bytes, the rows' bytes held on the page now and at most, the
      // decode workers: the tiles that came as bytes, as a worker's bitmap, decoded on the page, with a bitmap rest)
      pb: { ...panoBytes(), strips: this.byBytes, heldMB: +(this.held / 1e6).toFixed(1), heldMaxMB: +(this.heldMax / 1e6).toFixed(1), decoders: decodeStats() } };
  }

  /** The context was lost and restored: the GPU side is gone (nothing to delete); start again from nothing. */
  lost() {
    for (const j of this.ready) { if (!j.bmp || j.bmp.close) this._free(j); else { letGo(j.bmp.mask); letGo(j.bmp.depth); } }
    this.ready = [];
    if (this.up) { this._drop(this.up); this.up = null; }
    this.arrays = {};
    this.where.clear();
    this.pending.clear();
    this.failed.clear();
    this.retry.clear();
    this.aux = null;
    this.auxState = "none";
    this.auxTries = 0;
  }

  dispose() {
    this.dead = true;
    const gl = this.gl;
    for (const A of Object.values(this.arrays)) gl.deleteTexture(A.tex);
    if (this.aux) { gl.deleteTexture(this.aux.mask); gl.deleteTexture(this.aux.depth); }
    for (const j of this.ready) { if (!j.bmp || j.bmp.close) this._free(j); else { letGo(j.bmp.mask); letGo(j.bmp.depth); } }
    if (this.up) { for (const p of this.up.parts) { this._free(p); if (p.layer < 0) gl.deleteTexture(p.tex); } this.up = null; }
    this.arrays = {};
    this.where.clear();
    this.ready = [];
  }
}
