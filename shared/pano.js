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
  lights: { perCol: true },
  // the two-layer panorama's far layer (RGBA: what lies behind the near layer, and the near layer's coverage)
  F1: { band: "far", level: "L1", perCol: true },
  F2: { band: "far", level: "L2", perCol: false },
};
// slots per kind (and how many moments the shader can blend: the pair a/b plus a pair fading out)
// T1 (phones, plan 8.2): L1 city for the shown moment only, the sky from L2, the blend partner from L2 alone; the
// far layer at L2 only
export const SLOTS = {
  T1: { L0c: 0, L1c: 6, L1s: 0, L2c: 3, L2s: 3, clouds: 2, lights: 6, F1: 0, F2: 3 },
  T2: { L0c: 5, L1c: 12, L1s: 10, L2c: 4, L2s: 4, clouds: 4, lights: 12, F1: 12, F2: 4 },
  T3: { L0c: 6, L1c: 14, L1s: 12, L2c: 4, L2s: 4, clouds: 4, lights: 14, F1: 14, F2: 4 },
};
export const MAX_MOMENTS = 4;
const MAX_FETCHES = 4;
// perf #1: the most bytes of pixels handed to the GPU in one frame. A bigger tile goes in as row strips over a few
// frames (an L0 city tile is 1028 x 1796 RGBA, 7.4 MB); it is drawn only once all its rows are in.
export const UPLOAD_BYTES = { T1: 1e6, T2: 2e6, T3: 2e6 };
// while the camera is still (boot, the handover, rest) a long frame moves nothing on screen: the old budget, so the
// window fills as fast as before; the cap above is for the frames that move (the outside passes it per frame)
export const REST_UPLOAD_BYTES = 9e6;

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
  const band = (b) => bands[b].el[1] - bands[b].el[0];
  const size = {};
  for (const [k, spec] of Object.entries(KINDS)) {
    if (spec.band === "far" && !far) continue;
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

/** The file of one tile, relative to the panorama's base. */
export function tileUrl(meta, moment, kind, col) {
  const m = meta.moments[moment];
  const dir = meta.base + (m.dir || `${moment}/`);
  const spec = KINDS[kind];
  if (kind === "clouds") return dir + m.clouds;
  if (kind === "lights") return dir + m.lights.tiles.replace("{col}", col);
  if (kind === "F1") return `${dir}far-L1-${col}.avif`;
  if (kind === "F2") return `${dir}far-L2.avif`;
  if (spec.level === "L2") return `${dir}${spec.band}-L2.avif`;
  return `${dir}${spec.band}-${spec.level}-${col}.avif`;
}

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
  constructor(gl, meta, { tier = "T2", onLoaded = null } = {}) {
    this.gl = gl;
    this.meta = meta;
    this.slotsOf = SLOTS[tier] || SLOTS.T2;
    this.budget = UPLOAD_BYTES[tier] || UPLOAD_BYTES.T2;   // bytes uploaded per frame (pump)
    this.up = null;            // the upload under way, a few rows a frame: { key, kind, A, slot, parts, at, job }
    this.arrays = {};          // kind -> { tex, w, h, n, owner: [key | null], seen: [ms] }
    this.where = new Map();    // key -> { kind, slot }
    this.pending = new Map();  // key -> "fetch" | bitmap ready
    this.ready = [];           // decoded bitmaps waiting for an upload: { key, kind, bmp }
    this.fetching = 0;
    this.wantNow = new Map();  // key -> priority (lower first), rebuilt every frame
    this.failed = new Set();
    this.onLoaded = onLoaded;
    this.aux = null;           // { mask, depth } WebGL textures
    this.auxState = "none";
    this.bytes = 0;            // bytes fetched (for the report)
    this.uploads = 0;
    this.dead = false;
  }

  key(moment, kind, col = 0) { return `${moment}|${kind}|${col}`; }
  has(moment, kind, col = 0) { return this.where.has(this.key(moment, kind, col)); }
  slot(moment, kind, col = 0) { const w = this.where.get(this.key(moment, kind, col)); return w ? w.slot : -1; }

  /** Declare what is wanted this frame, in priority order: [[moment, kind, col], ...]. Starts fetches. */
  want(list, now = performance.now()) {
    this.wantNow.clear();
    list.forEach(([m, k, c], i) => {
      if (!this.slotsOf[k] && k !== "aux") return;
      if (k === "lights" && !this.meta.moments[m]?.lights) return;
      if (k === "clouds" && !this.meta.moments[m]?.clouds) return;
      if ((k === "F1" || k === "F2") && !this.meta.geo.size[k]) return;   // a one-layer panorama
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
        const [m, k, c] = key.split("|");
        if (!this._slotFor(k, now, true)) continue;      // no slot could take it now: don't fetch yet
        this._fetch(key, m, k, +c);
      }
    }
  }

  /** Are these tiles all on the GPU? */
  allResident(list) {
    return list.every(([m, k, c]) => this.where.has(this.key(m, k, c)) || (k === "lights" && !this.meta.moments[m]?.lights) ||
      (k === "clouds" && !this.meta.moments[m]?.clouds) || !this.slotsOf[k] || !this.meta.geo.size[k]);
  }
  get busy() { return this.fetching > 0 || this.ready.length > 0 || !!this.up || this.auxState === "loading"; }

  async _fetch(key, moment, kind, col) {
    this.pending.set(key, "fetch");
    this.fetching++;
    try {
      const res = await fetch(tileUrl(this.meta, moment, kind, col));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      this.bytes += blob.size;
      // panorama pixels are display values already: no colour conversion, straight alpha (the cloud layer)
      const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      if (this.dead) { bmp.close(); return; }
      this.ready.push({ key, kind, bmp });
    } catch (e) {
      console.warn("[outside] tile", key, e.message);
      this.failed.add(key);
      this.pending.delete(key);
    } finally {
      this.fetching--;
    }
  }

  async loadAux() {
    if (this.auxState !== "none") return;
    this.auxState = "loading";
    const a = this.meta.aux;
    const get = async (p) => {
      const r = await fetch(this.meta.base + p);
      if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
      const b = await r.blob();
      this.bytes += b.size;
      return createImageBitmap(b, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    };
    try {
      const [mask, depth] = await Promise.all([get(a.mask), get(a.depth)]);
      this.ready.push({ key: "aux", kind: "aux", bmp: { mask, depth } });
    } catch (e) {
      console.warn("[outside] aux", e.message);
      this.auxState = "failed";
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
   * another needs one, _slotFor.) */
  pump(now = performance.now(), budgetBytes = this.budget) {
    const gl = this.gl;
    if (!this.up && !this.ready.length) return false;
    let spent = 0, did = false;
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
      const n = Math.min(p.rows - p.y, Math.max(spent > 0 ? 0 : 1, Math.floor((budgetBytes - spent) / row)));
      if (n <= 0) break;
      this._rows(p, n);
      spent += n * row;
      if (p.y < p.rows) continue;
      if (++u.at < u.parts.length) continue;
      this._finish(u, now);
      this.up = null;
      did = true;
    }
    return did;
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
      this.pending.delete(key);
      if (!this.wantNow.has(key) && !this.where.has(key)) {
        // left the view while loading: keep it if a slot is free anyway, else drop it
        const A = this.arrays[kind];
        if (A && A.owner.indexOf(null) < 0) { bmp.close(); continue; }
      }
      const slot = this._slotFor(kind, now);
      if (slot === null || slot === undefined) { bmp.close(); continue; }
      const A = this._array(kind);
      // a moment from another set (the live preview's merged panorama: the stand-in's moments in R2's frame) may
      // carry a far layer over fewer elevations (its own far_el): it goes in at its rows, the rest is cleared
      // (coverage 0: the panorama itself shows there)
      const yOff = (kind === "F1" || kind === "F2") ? this._farRowOffset(key.split("|")[0], kind) : 0;
      if (bmp.width !== A.w || bmp.height + yOff > A.h || (!yOff && bmp.height !== A.h)) {
        console.warn(`[outside] ${key}: ${bmp.width}x${bmp.height}, expected ${A.w}x${A.h}`);
        bmp.close();
        this.failed.add(key);
        continue;
      }
      let cleared = 0;
      if (yOff || bmp.height !== A.h) {
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, A.tex);
        const clear = (y0, rows) => { if (rows > 0) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, y0, slot, A.w, rows, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(A.w * rows * 4)); };
        clear(0, yOff);
        clear(yOff + bmp.height, A.h - yOff - bmp.height);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
        cleared = A.w * (A.h - bmp.height) * 4;
      }
      // reserved: no other tile takes the slot while the rows go in, and no second fetch of this tile starts
      A.owner[slot] = key;
      A.seen[slot] = now;
      this.pending.set(key, "upload");
      return { key, kind, job, A, slot, cleared, parts: [{ tex: A.tex, layer: slot, bmp, w: bmp.width, rows: bmp.height, y: 0, y0: yOff }], at: 0 };
    }
  }

  /** n more rows of a picture into its texture (a sub-rectangle of the picture: WebGL2's UNPACK_SKIP_ROWS). */
  _rows(p, n) {
    const gl = this.gl;
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
  }

  /** All rows in: the tile is resident (the shader finds it from now), or the aux maps are ready. */
  _finish(u, now) {
    if (u.kind === "aux") {
      const [mask, depth] = u.parts;
      this.aux = { mask: mask.tex, depth: depth.tex, size: [depth.w, depth.rows] };
      mask.bmp.close(); depth.bmp.close();
      this.auxState = "ready";
      return;
    }
    const { key, kind, A, slot } = u;
    this.pending.delete(key);
    A.seen[slot] = now;
    this.where.set(key, { kind, slot });
    this.uploads++;
    u.parts[0].bmp.close();
    this.onLoaded?.(key);
  }

  /** An upload given up halfway (its slot was handed back, the context was lost or the store disposed). */
  _drop(u) {
    for (const p of u.parts) p.bmp.close();
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
    return { slots: out, resident: this.where.size, fetching: this.fetching, queued: this.ready.length + (this.up ? 1 : 0), uploads: this.uploads, mb: +(this.memory() / 1e6).toFixed(1), fetchedKB: Math.round(this.bytes / 1024) };
  }

  /** The context was lost and restored: the GPU side is gone (nothing to delete); start again from nothing. */
  lost() {
    for (const j of this.ready) { if (j.bmp.close) j.bmp.close(); else { j.bmp.mask?.close(); j.bmp.depth?.close(); } }
    this.ready = [];
    if (this.up) { this._drop(this.up); this.up = null; }
    this.arrays = {};
    this.where.clear();
    this.pending.clear();
    this.failed.clear();
    this.aux = null;
    this.auxState = "none";
  }

  dispose() {
    this.dead = true;
    const gl = this.gl;
    for (const A of Object.values(this.arrays)) gl.deleteTexture(A.tex);
    if (this.aux) { gl.deleteTexture(this.aux.mask); gl.deleteTexture(this.aux.depth); }
    for (const j of this.ready) { if (j.bmp.close) j.bmp.close(); else { j.bmp.mask?.close(); j.bmp.depth?.close(); } }
    if (this.up) { for (const p of this.up.parts) { p.bmp.close(); if (p.layer < 0) gl.deleteTexture(p.tex); } this.up = null; }
    this.arrays = {};
    this.where.clear();
    this.ready = [];
  }
}
