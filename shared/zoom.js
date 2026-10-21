// The window's magnifier, the outside's part (v3/zoom; docs/v3/live.md, "The window magnifier"). Loaded the first time someone magnifies at
// the window (router.js loadZoom), never at load: a visitor who never zooms downloads none of this.
//
//   const z = await (await import("/shared/zoom.js")).attachMagnifier(nav);   // nav: the router (engine, outside, rig)
//   z.gesture(at);     // a zoom gesture started at a point (canvas CSS px): fetch the sharp tiles under it first
//   z.info();          // what it holds and does (the smoke's window.magnify, tiles.l3 and zoom.memory read it)
//
// The rig narrows the field of view (shared/rig.js zoomBy past the dolly's end); this module makes the outside keep up:
// - L3, the panorama's sharpest city level (256 px/deg, 4x L0), exists only over the hero regions (sparse 1 deg tiles,
//   scripts/pano_tiles.py --l3; the format in docs/v3/live.md, "The window magnifier"). Its tiles are wanted only where the screen is denser than
//   L0 can draw (the full-size frame's px/deg over 64 x 2^0.4), nearest the pointer's direction first, and a texture
//   array of a fixed number of slots holds them (a GPU memory budget; the stalest tile out of view gives its slot up).
//   They are decoded off the main thread (createImageBitmap on the fetched bytes), uploaded a few a frame, and fade in
//   over 200 ms; where the covered area ends the level fades out over the last cell's outer part (no seam).
// - The outside draws with a variant of its backdrop program (the same source, L3 read in momentColour) only while the
//   screen is that dense and L3 tiles are in; otherwise with its own program, so the picture at rest is untouched.
// - Phones have no L0 city tiles (pano.js SLOTS.T1): magnified they get 2 or 3 slots of them.
// - Cars and aircraft are drawn as much larger as the lens is narrower (outside-events.js, cam.zoom).
// - As the lens narrows (1x to 1.8x) the outside's parallax eases off (eyeK: the eye offset the backdrop corrects for goes
//   to 0): the panorama's near/far reconstruction is drawn from 20-32 px/deg maps, and at 4x its outlines wobbled on the
//   near blocks; magnified, the view is the panorama's own pixels, as seen from its own eye (the near field slides back
//   by up to a degree while the zoom runs: the dolly's lean-in undone).
// - Its program is compiled and drawn once (with L3 off: the same picture) 0.5 s after landing at the window (warm(): the
//   code and the index only, no tile; not on Save-Data or 2g/3g), so the first zoom does not stall on the shader.
// - After the first magnification, on a fast connection (navigator.connection) and with the room settled, the hero
//   tiles likeliest to be looked at next are fetched (kept compressed in memory, up to a few MB), one at a time.
// - Away from the window for 20 s, its GPU memory goes back (the L3 array, a phone's L0 slots).
// - windows_extra (detail-int, 18 Oct: the night's second window group, v3/city-detail 0130ec5): L3 bakes its lights in,
//   so its extra comes as tiles of its own (l3.json moments.<m>.extra: cityx-L3-<i>-<j>.avif, RGB over black), added over
//   the L3 tile x the dominant moment's dial (the outside's, city/tables.js WINDOWS_EXTRA; 0 everywhere). At 0 none is
//   fetched and the map and the program read as before; above 0 they share the L3 array (key "<moment>~x") and the map
//   grows a second half below a copy of its last row (the extra's slot per cell), faded in as their tiles arrive.
import { BACKDROP_FS } from "./gl/outside.glsl.js";
import { ray } from "./rig.js";
import { RETRY_MS, retryable } from "./pano.js";

const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth01 = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const L3_UNIT = 20, MAP_UNIT = 21;      // texture units (the outside's own run 0..19: park round 2's near layer has 17 and 18, the
                                        // ships' night atlas 19; WebGL2 has 32 in all)
const LF3_WANT = 1.6;                   // L3 is fetched where the frame is denser than L0 x 2^(2 - 1.6) = 1.3
const LF3_DRAW = 1.9;                   // and drawn (the shader's weight is 0 from here on: the outside's own program)
const FADE_MS = 200;
const MAX_FETCH = 6;
const BUDGET_MB = { T1: 32, T2: 80, T3: 96 };            // the L3 tiles' GPU memory (a 1 deg tile, 260 x 260 RGBA: 0.27 MB)
const UPLOAD_MB = { moving: { T1: 0.8, T2: 1.6, T3: 1.6 }, rest: { T1: 1.6, T2: 4.4, T3: 4.4 } };   // L3 bytes uploaded a frame
const PHONE_L0 = (cap) => (cap >= 3 ? 3 : 2);            // phones: L0 city slots while magnified
const PHONE_N0 = (cap) => (cap >= 3 ? 2 : 0);            // and the near layer's 88 px/deg front (park round 2), 3x and up
const PREFETCH_BYTES = { T1: 3e6, T2: 8e6, T3: 8e6 };   // idle prefetch: compressed tiles kept in memory
const FOCUS_MS = 1500;                                  // a gesture's point leads the order this long
const RELEASE_MS = 20000;                               // away from the window this long: the GPU memory goes back
const EYE_MAG = 1.8;                                    // the parallax is gone by this magnification
const XK = "~x";                                        // windows_extra's tiles: the moment's key with this suffix

// ------------------------------------------------------------------------------------------------ the variant program
// The outside's backdrop shader with L3 read in momentColour (the dominant moment, the city band), the first-paint
// pictures left out (the magnifier draws only once the tiles have taken over) so it samples no more texture units than
// the outside's own. Each anchor is checked: a change in outside.glsl.js that breaks one leaves the magnifier on L0.
const L3_GLSL = `
// ---- v3/zoom: the magnifier's sharpest city level (L3), sparse tiles over the hero regions
uniform sampler2DArray uL3;
uniform sampler2D uL3Map;      // per grid cell: R + 256 A slot + 1 (0: none), G resident (read bilinearly: the soft edge), B fade-in
uniform vec4 uL3Grid;          // yaw0, el top, tile deg, px/deg
uniform vec4 uL3Size;          // tile w, h (px, gutters included), gutter, -
uniform vec2 uL3Dims;          // grid columns, rows
uniform float uL3On;           // the dominant moment has L3 tiles
uniform float uL3X;            // windows_extra: the dominant moment's dial (0: none of it; the map has no extra half)
uniform vec2 uL3MapSize;       // the map's size in cells: (cols, rows), or (cols, rows x 2 + 1) with the extra's half
float gLf3 = 8.0;              // log2(L3 px per screen px): 0 = L3 one to one, 2 = L0 one to one
float gL3W = 0.0;              // (debug) the most L3 weight drawn at this pixel
vec3 l3Tap(vec2 uv, float s) { return textureLod(uL3, vec3(uv, s), 0.0).rgb; }
vec4 l3Colour(float yaw, float el) {
  vec2 g = vec2(yaw - uL3Grid.x, uL3Grid.y - el) / uL3Grid.z;
  if (g.x < 0.0 || g.y < 0.0 || g.x >= uL3Dims.x || g.y >= uL3Dims.y) return vec4(0.0);
  ivec2 cell = ivec2(floor(g));
  vec4 e = texelFetch(uL3Map, cell, 0);
  float s = floor(e.r * 255.0 + 0.5) + 256.0 * floor(e.a * 255.0 + 0.5) - 1.0;
  if (s < 0.0) return vec4(0.0);
  // the covered area's edge: resident cells 1, the rest 0, read bilinearly between the cells' centres, so the level
  // fades out over the outer part of the last cell instead of stopping at a seam
  float cov = smoothstep(0.55, 0.85, textureLod(uL3Map, g / uL3MapSize, 0.0).g);
  // its weight: L3 alone while at most 2.8x minified, into L0 by the time L0 is nearly one to one
  float w = cov * e.b * (1.0 - smoothstep(1.5, ${LF3_DRAW.toFixed(2)}, gLf3));
  if (w <= 0.0) return vec4(0.0);
  vec2 f = g - vec2(cell);
  vec2 uv = (uL3Size.z + f * (uL3Size.xy - 2.0 * uL3Size.z)) / uL3Size.xy;
  vec3 c;
  if (gLf3 < 0.25) c = l3Tap(uv, s);
  else {
    // minified (the tiles have no mipmaps): four taps over the screen pixel's footprint
    vec2 o = 0.25 * exp2(min(gLf3, 2.0)) / uL3Size.xy;
    c = 0.25 * (l3Tap(uv - o, s) + l3Tap(uv + vec2(o.x, -o.y), s) + l3Tap(uv + vec2(-o.x, o.y), s) + l3Tap(uv + o, s));
  }
  if (uL3X > 0.0) {
    // windows_extra over this cell (the map's second half: its slot, its fade in B), over black, x the dial
    vec4 ex = texelFetch(uL3Map, cell + ivec2(0, int(uL3Dims.y) + 1), 0);
    float sx = floor(ex.r * 255.0 + 0.5) + 256.0 * floor(ex.a * 255.0 + 0.5) - 1.0;
    if (sx >= 0.0) {
      vec3 xc;
      if (gLf3 < 0.25) xc = l3Tap(uv, sx);
      else {
        vec2 o = 0.25 * exp2(min(gLf3, 2.0)) / uL3Size.xy;
        xc = 0.25 * (l3Tap(uv - o, sx) + l3Tap(uv + vec2(o.x, -o.y), sx) + l3Tap(uv + vec2(-o.x, o.y), sx) + l3Tap(uv + o, sx));
      }
      c += xc * (uL3X * ex.b);
    }
  }
  return vec4(c, w);
}
vec3 momentColour(int m, float yaw, float el, float lf) {
  vec3 c = momentColour0(m, yaw, el, lf);
  if (m == 0 && uL3On > 0.5 && gLf3 < ${LF3_DRAW.toFixed(2)} && el < uBand.y) {
    vec4 t = l3Colour(yaw, el);
    if (t.a > 0.0) { c = mix(c, t.rgb, t.a); gL3W = max(gL3W, t.a); }
  }
  return c;
}
`;
export function variantSource(fs = BACKDROP_FS) {
  const edits = [
    ["vec3 momentColour(int m, float yaw, float el, float lf) {", "vec3 momentColour0(int m, float yaw, float el, float lf) {"],
    ["// the panorama blurred to about 4 px/deg", L3_GLSL + "// the panorama blurred to about 4 px/deg"],
    ["float lf = clamp(log2(max(uPpd.x * degPerPx, 1e-3)) + uLevelBias, 0.0, 2.0);",
      "float lf = clamp(log2(max(uPpd.x * degPerPx, 1e-3)) + uLevelBias, 0.0, 2.0);\n  gLf3 = log2(max(uL3Grid.w * degPerPx, 1e-6));"],
    ["    ext = extColour(uExtA, d, degPerPx) * uExtMix.x;\n    if (uExtMix.y > 0.0) ext += extColour(uExtB, d, degPerPx) * uExtMix.y;\n", "    // (v3/zoom: never in stage 1)\n"],
    // the L3 tiles are cut from the fully lit render (night's windows and lamps in them): no light layers over them
    ["  vec3 base = mix(ext + (lit - asBaked), tiles + lit, uTileW);", "  lit *= 1.0 - gL3W; asBaked *= 1.0 - gL3W;\n  vec3 base = mix(ext + (lit - asBaked), tiles + lit, uTileW);"],
    ["  if (uDebug == 4) col = mix(col, vec3(uTileW, 0.0, 1.0 - uTileW), 0.3);",
      "  if (uDebug == 4) col = mix(col, vec3(uTileW, 0.0, 1.0 - uTileW), 0.3);\n  if (uDebug == 1 && gL3W > 0.0) col = mix(col, vec3(1.0, 0.0, 1.0), 0.35 * gL3W);"],
  ];
  let s = fs;
  for (const [a, b] of edits) {
    if (s.split(a).length !== 2) throw new Error(`zoom: the outside's shader changed (no single "${a.slice(0, 48)}")`);
    s = s.replace(a, b);
  }
  return s;
}

// ------------------------------------------------------------------------------------------------ the L3 tile store
class L3Store {
  constructor(gl, index, base, { slots, onLoaded }) {
    this.gl = gl;
    this.idx = index;
    this.base = base;
    const g = index.grid;
    this.cols = g.cols; this.rows = g.rows;
    this.tw = index.tile_px + 2 * index.gutter; this.th = this.tw;
    this.n = slots;
    this.avail = {};                     // moment -> Set("i,j")
    for (const [m, e] of Object.entries(index.moments || {})) this.avail[m] = new Set((e.tiles || []).map(([i, j]) => `${i},${j}`));
    // windows_extra: its cells as a moment of their own, "<moment>~x"
    for (const [m, e] of Object.entries(index.moments || {})) if (e.extra?.tiles) this.avail[m + XK] = new Set((e.extra.cells || []).map(([i, j]) => `${i},${j}`));
    this.onLoaded = onLoaded;
    this.reset();
    this.blobs = new Map();              // prefetched compressed tiles: key -> Blob
    this.blobBytes = 0;
    this.bytes = 0; this.uploads = 0; this.prefetched = 0; this.upMs = []; this.failed = new Set();
    this.retry = new Map();              // key -> { n, at }: its fetch failed n times; asked for again from `at` (pano.js RETRY_MS)
  }
  // a failed fetch, waiting before it is asked for again
  waiting(key, now = performance.now()) { const r = this.retry.get(key); return !!r && now < r.at; }
  reset() {
    this.tex = null; this.mapTex = null;
    this.owner = new Array(this.n).fill(null);
    this.seen = new Float64Array(this.n);
    this.where = new Map();              // key -> { slot, t0 }
    this.pending = new Map();            // key -> "fetch"
    this.ready = [];                     // { key, bmp }
    this.fetching = 0;
    this.wantNow = new Map();
    this.map = new Uint8Array(this.cols * this.rows * 4);
    this.mapRows = this.rows;            // the map texture's rows: rows, or rows x 2 + 1 with windows_extra's half
    this.mapX = false;
    this.mapMoment = null;
    this.mapDirty = true;
    this.fading = false;
  }
  key(m, i, j) { return `${m}|${i}|${j}`; }
  has(m, i, j) { return this.avail[m]?.has(`${i},${j}`) || false; }
  url(m, i, j) {
    if (m.endsWith(XK)) {
      const b = m.slice(0, -XK.length), e = this.idx.moments[b];
      return this.base + (e.dir || `${b}/`) + e.extra.tiles.replace("{i}", i).replace("{j}", j);
    }
    const e = this.idx.moments[m];
    return this.base + (e.dir || `${m}/`) + (this.idx.tiles || "city-L3-{i}-{j}.avif").replace("{i}", i).replace("{j}", j);
  }
  get busy() { return this.fetching > 0 || this.ready.length > 0 || this.fading; }
  resident(m) { let k = 0; for (const key of this.where.keys()) if (key.startsWith(m + "|")) k++; return k; }

  /** What is wanted this frame, most wanted first: [[m, i, j], ...]. Starts fetches. */
  want(list, now) {
    this.wantNow.clear();
    list.forEach(([m, i, j], r) => {
      const key = this.key(m, i, j);
      if (!this.wantNow.has(key)) this.wantNow.set(key, r);
      const w = this.where.get(key);
      if (w) this.seen[w.slot] = now;
    });
    for (const [key] of this.wantNow) {
      if (this.fetching >= MAX_FETCH) break;
      if (this.where.has(key) || this.pending.has(key) || this.failed.has(key) || this.waiting(key, now)) continue;
      this._fetch(key);
    }
  }
  async _fetch(key) {
    const [m, i, j] = key.split("|");
    this.pending.set(key, "fetch");
    this.fetching++;
    try {
      let blob = this.blobs.get(key);
      if (blob) { this.blobs.delete(key); this.blobBytes -= blob.size; }
      else {
        const r = await fetch(this.url(m, +i, +j));
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
        blob = await r.blob();
        this.bytes += blob.size;
      }
      // display values already (as the panorama's own tiles): no colour conversion; decoded off the main thread
      const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      if (this.dead) { bmp.close(); return; }
      this.retry.delete(key);
      this.ready.push({ key, bmp });
      this.onLoaded?.();
    } catch (e) {
      this.pending.delete(key);
      this._failed(key, e, "tile");
    } finally {
      this.fetching--;
    }
  }
  // A fetch that failed: asked for again after RETRY_MS (the engine woken then: onLoaded asks for a frame), or given up.
  _failed(key, e, what) {
    if (this.dead) return;
    const n = (this.retry.get(key)?.n || 0) + 1;
    if (retryable(e) && n <= RETRY_MS.length) {
      const ms = RETRY_MS[n - 1];
      this.retry.set(key, { n, at: performance.now() + ms });
      console.warn(`[zoom] ${what}`, key, e.message, `(again in ${ms / 1000} s)`);
      setTimeout(() => { if (!this.dead) this.onLoaded?.(); }, ms + 20);
    } else {
      this.retry.delete(key);
      this.failed.add(key);
      console.warn(`[zoom] ${what}`, key, e.message);
    }
  }
  /** Idle prefetch: one tile's bytes into memory (not decoded), when nothing else is under way. */
  async prefetch(key, cap) {
    if (this.blobBytes >= cap || this.fetching || this.where.has(key) || this.pending.has(key) || this.blobs.has(key) || this.failed.has(key) || this.waiting(key)) return false;
    const [m, i, j] = key.split("|");
    this.fetching++;
    try {
      const r = await fetch(this.url(m, +i, +j));
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      const b = await r.blob();
      this.bytes += b.size; this.prefetched += b.size;
      this.retry.delete(key);
      if (!this.dead) { this.blobs.set(key, b); this.blobBytes += b.size; }
    } catch (e) {
      this._failed(key, e, "prefetch");
    } finally {
      this.fetching--;
    }
    return true;
  }
  _alloc() {
    const gl = this.gl;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, this.tw, this.th, this.n);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, k, v);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }
  _slot(now) {
    let free = this.owner.indexOf(null);
    if (free >= 0) return free;
    // the stalest tile that isn't wanted this frame
    let best = -1, bestSeen = Infinity;
    this.owner.forEach((k, s) => { if (!this.wantNow.has(k) && this.seen[s] < bestSeen) { bestSeen = this.seen[s]; best = s; } });
    if (best < 0) return -1;
    this.where.delete(this.owner[best]);
    this.owner[best] = null;
    this.mapDirty = true;
    return best;
  }
  /** Inside the outside pass: at most `max` tiles a frame to the GPU, the most wanted first. */
  pump(now, max, fadeMs) {
    const gl = this.gl;
    let n = 0;
    while (n < max && this.ready.length) {
      let bi = 0, bp = Infinity;
      this.ready.forEach((r, k) => { const p = this.wantNow.has(r.key) ? this.wantNow.get(r.key) : Infinity; if (p < bp) { bp = p; bi = k; } });
      const { key, bmp } = this.ready.splice(bi, 1)[0];
      this.pending.delete(key);
      if (!this.wantNow.has(key) && this.owner.indexOf(null) < 0) { bmp.close(); continue; }   // left the view, no free slot
      if (bmp.width !== this.tw || bmp.height !== this.th) { console.warn(`[zoom] ${key}: ${bmp.width}x${bmp.height}, expected ${this.tw}x${this.th}`); bmp.close(); this.failed.add(key); continue; }
      const slot = this._slot(now);
      if (slot < 0) { bmp.close(); continue; }
      if (!this.tex) this._alloc();
      const t0 = performance.now();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, slot, this.tw, this.th, 1, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      this.upMs.push(performance.now() - t0); if (this.upMs.length > 64) this.upMs.shift();
      bmp.close();
      this.owner[slot] = key;
      this.seen[slot] = now;
      this.where.set(key, { slot, t0: fadeMs > 0 ? now : now - 1e6 });
      this.uploads++;
      this.mapDirty = true;
      n++;
    }
    return n;
  }
  /** The grid map for one moment (R slot + 1, G resident, B fade), to the GPU when it changed. x: windows_extra on (its
   * slots in a second half, rows + 1 on, below a copy of the last row: the coverage's bilinear read at the grid's
   * bottom edge sees what a clamp would); off, the map is exactly as without it. */
  syncMap(m, now, fadeMs, x = false) {
    const gl = this.gl;
    if (m !== this.mapMoment) { this.mapMoment = m; this.mapDirty = true; }
    if (x !== this.mapX) { this.mapX = x; this.mapDirty = true; }
    if (!this.mapDirty && !this.fading) return;
    const rows = x ? this.rows * 2 + 1 : this.rows;
    if (this.map.length !== this.cols * rows * 4) this.map = new Uint8Array(this.cols * rows * 4);
    this.map.fill(0);
    let fading = false;
    for (const [key, w] of this.where) {
      const [mm, i, j] = key.split("|");
      const isX = x && mm === m + XK;
      if (mm !== m && !isX) continue;
      const f = fadeMs > 0 ? smooth01((now - w.t0) / fadeMs) : 1;
      if (f < 1) fading = true;
      const o = ((+j + (isX ? this.rows + 1 : 0)) * this.cols + +i) * 4;
      this.map[o] = (w.slot + 1) & 255; this.map[o + 1] = 255; this.map[o + 2] = Math.round(f * 255); this.map[o + 3] = (w.slot + 1) >> 8;
    }
    if (x) this.map.copyWithin(this.rows * this.cols * 4, (this.rows - 1) * this.cols * 4, this.rows * this.cols * 4);
    this.fading = fading;
    if (this.mapTex && this.mapRows !== rows) { gl.deleteTexture(this.mapTex); this.mapTex = null; }
    if (!this.mapTex) {
      this.mapTex = gl.createTexture();
      this.mapRows = rows;
      gl.bindTexture(gl.TEXTURE_2D, this.mapTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.cols, rows);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    } else gl.bindTexture(gl.TEXTURE_2D, this.mapTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, this.map);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.mapDirty = false;
  }
  memory() { return (this.tex ? this.tw * this.th * 4 * this.n : 0) + (this.mapTex ? this.cols * this.mapRows * 4 : 0); }
  stats() {
    const up = [...this.upMs].sort((a, b) => a - b);
    return { slots: `${this.where.size}/${this.n}`, resident: this.where.size, fetching: this.fetching, queued: this.ready.length, uploads: this.uploads,
      failed: [...this.failed], retrying: [...this.retry.keys()], fetchedKB: Math.round(this.bytes / 1024), prefetchedKB: Math.round(this.prefetched / 1024), heldKB: Math.round(this.blobBytes / 1024),
      uploadMs: up.length ? { median: +up[up.length >> 1].toFixed(2), max: +up[up.length - 1].toFixed(2) } : null, mb: +(this.memory() / 1e6).toFixed(1) };
  }
  /** The GPU side is gone (a lost context) or handed back (away from the window): start again from nothing. */
  free({ deleteGL = true } = {}) {
    if (deleteGL) { if (this.tex) this.gl.deleteTexture(this.tex); if (this.mapTex) this.gl.deleteTexture(this.mapTex); }
    for (const r of this.ready) r.bmp.close();
    this.reset();
  }
  dispose() { this.dead = true; this.free(); this.blobs.clear(); this.blobBytes = 0; }
}

// ------------------------------------------------------------------------------------------------ the magnifier
export async function attachMagnifier(nav) {
  const { engine, outside, rig } = nav;
  const gl = engine.gl, meta = outside.meta, store = outside.store;
  const tier = engine.settings.tier;
  // the zoom levels beside the panorama (assemble.py writes room3d/zoom.json: { l3: "<index>" | null })
  let index = null, base = null;
  try {
    const zr = await fetch(new URL("zoom.json", meta.base));
    const z = zr.ok ? await zr.json() : null;
    if (z?.l3) {
      const iu = new URL(z.l3, new URL("zoom.json", meta.base));
      const ir = await fetch(iu);
      if (ir.ok) { index = await ir.json(); base = new URL(".", iu).href; }
    }
  } catch (e) { console.warn("[zoom] no sharper level:", e.message); }

  const reduced = () => engine.settings.reducedMotion;
  const cap = () => rig.magCap("window");
  const tileBytes = index ? (index.tile_px + 2 * index.gutter) ** 2 * 4 : 1;
  const slots = Math.min(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS), Math.floor(((BUDGET_MB[tier] || BUDGET_MB.T2) * 1e6) / tileBytes));
  const L3 = index ? new L3Store(gl, index, base, { slots, onLoaded: () => engine.requestFrame() }) : null;
  let variant = null, variantFailed = false;
  let lf3 = 8, l3Moment = null, useVariant = false, focus = null, awaySince = null, phoneL0 = 0, lastMove = 0, prefetchOn = false;
  let warmWanted = false, warmed = false;
  const dbg = { eye: null, l3: true, wx: null };     // QA (smoke zoom.align): pin the parallax scale, switch L3 off; wx: windows_extra's dial
  let l3X = 0;                          // windows_extra: the dial over L3 this frame (0: none of it)
  const restCache = { key: "", tanV: 1 };
  const log = [["attach", Math.round(performance.now())]];     // (when each first thing happened: the walk's long frames)
  const once = new Set(), note = (k) => { if (!once.has(k)) { once.add(k); log.push([k, Math.round(performance.now())]); } };
  const slotsOrig = store.slotsOf;
  // the variant program compiles now (in parallel where the browser can), so it is ready when the first tiles are
  if (L3) { try { variant = outside.backdropProgram(variantSource()); } catch (e) { variantFailed = true; console.warn("[zoom]", e.message); } }

  // the magnification the camera has now, against the window's rest framing for this screen (it eases back with the
  // reset and through a glide away)
  function effMag() {
    if (!rig.pose || !(rig.spot === "window" || (rig.from === "window" && rig.glide))) return 1;
    const [w, h] = nav.size(), key = `${w}x${h}`;
    if (restCache.key !== key) { restCache.key = key; restCache.tanV = rig.restPose("window").tanV; }
    return clamp(restCache.tanV / rig.pose.tanV, 1, 8);
  }
  // a direction (room frame) as the panorama's yaw (right of the axis) and elevation
  const yawEl = (d) => [Math.atan2(d[0], -d[2]) / DEG, Math.asin(clamp(d[1], -1, 1)) / DEG];

  function program() {
    const warm = warmWanted && !warmed;
    if ((!useVariant && !warm) || !L3 || variantFailed) return null;
    if (!variant) {
      try { variant = outside.backdropProgram(variantSource()); } catch (e) { variantFailed = true; console.warn("[zoom]", e.message); return null; }
    }
    if (!variant.ok) {
      if (!variant.check()) { if (variant.failed) variantFailed = true; return null; }
      note("program-linked");
      gl.useProgram(variant.p);
      if (variant.u.uL3) gl.uniform1i(variant.u.uL3, L3_UNIT);
      if (variant.u.uL3Map) gl.uniform1i(variant.u.uL3Map, MAP_UNIT);
    }
    note("program-first-draw");
    if (warm && !useVariant) { warmed = true; note("warm-draw"); }
    return variant;
  }

  // phones: L0 city slots (and the near layer's front) while the window is magnified (the store makes each array when
  // its first tile comes)
  const hasN0 = !!meta.geo.size.N0;
  function phoneSlots(on) {
    if (tier !== "T1") return;
    const want = on ? PHONE_L0(cap()) : 0;
    if (want === phoneL0) return;
    if (!on) {
      for (const kind of ["L0c", "N0"]) {
        const A = store.arrays[kind];
        if (store.up?.kind === kind) { store._drop(store.up); store.up = null; }
        if (A) { gl.deleteTexture(A.tex); delete store.arrays[kind]; }
        for (const [k, w] of [...store.where]) if (w.kind === kind) store.where.delete(k);
      }
      store.slotsOf = slotsOrig;
    } else if (!phoneL0) store.slotsOf = { ...slotsOrig, L0c: want, ...(hasN0 ? { N0: PHONE_N0(cap()) } : {}) };
    phoneL0 = want;
  }

  const hooks = {
    mag: () => effMag(),
    eyeK: () => { if (dbg.eye !== null) return dbg.eye; const m = effMag(); return m <= 1 ? 1 : 1 - smooth01(Math.log(m) / Math.log(EYE_MAG)); },
    wantL0: () => rig.spot === "window" && (rig.magnified || effMag() > 1.02),
    busy: () => (!!L3 && L3.busy) || (warmWanted && !warmed && !variantFailed),
    want(frame, { visible, dom, weights, cam }) {
      const now = frame.time, m = effMag();
      if (rig.moving) lastMove = now;
      // away from the window for a while: the GPU memory goes back
      const here = rig.spot === "window" || rig.from === "window";
      if (here) awaySince = null; else if (awaySince === null) awaySince = now;
      if (awaySince !== null && now - awaySince > RELEASE_MS) {
        if (L3 && L3.tex) L3.free();
        phoneSlots(false);
        useVariant = false;
        if (L3) L3.want([], now);
        return;
      }
      // (once given, a phone keeps its L0 slots while at the window: zooming out and in again fetches nothing twice)
      if (here) phoneSlots(phoneL0 > 0 || rig.magnified || m > 1.02);
      // the full-size frame's density (a moving frame draws smaller: the tiles are for where it comes to rest)
      const ppdFull = cam.pxPerRad * DEG * (engine.height / Math.max(1, frame.height));
      lf3 = index ? Math.log2(index.ppd / Math.max(1e-3, ppdFull)) : 8;
      l3Moment = L3 && L3.avail[dom] && weights[0] > 0.5 ? dom : null;
      useVariant = dbg.l3 && !!l3Moment && lf3 < LF3_DRAW && L3.resident(l3Moment) > 0;
      if (!L3) return;
      // windows_extra: the outside's dial for the dominant moment (v3/detail-int's outside.wxDials; none before it)
      const xd = dbg.wx !== null ? dbg.wx : (outside.wxDials?.[0] ?? 0);
      l3X = l3Moment && xd > 0 && L3.avail[l3Moment + XK]?.size ? xd : 0;
      L3.syncMap(l3Moment, now, reduced() ? 150 : FADE_MS, l3X > 0);
      const list = [];
      if (l3Moment && here) {
        const g = index.grid, td = index.tile_deg;
        const f = focus && now - focus.t < FOCUS_MS ? focus : null;
        const cy = f ? f.yaw : (visible.yaw[0] + visible.yaw[1]) / 2, ce = f ? f.el : (visible.el[0] + visible.el[1]) / 2;
        const add = (y0, y1, e0, e1) => {
          for (let i = Math.max(0, Math.floor((y0 - g.yaw0) / td)); i <= Math.min(g.cols - 1, Math.floor((y1 - g.yaw0) / td)); i++)
            for (let j = Math.max(0, Math.floor((g.el_top - e1) / td)); j <= Math.min(g.rows - 1, Math.floor((g.el_top - e0) / td)); j++)
              if (L3.has(l3Moment, i, j)) list.push([l3Moment, i, j, Math.hypot(g.yaw0 + (i + 0.5) * td - cy, g.el_top - (j + 0.5) * td - ce)]);
        };
        // the gesture's point (as it starts: the tiles under the pointer, before the view has narrowed onto them)
        if (f) add(f.yaw - 3, f.yaw + 3, f.el - 2, f.el + 2);
        // and what is on screen, where the screen is dense enough for them (parallax moves near things by up to 0.5 deg)
        if (lf3 < LF3_WANT && !visible.none) add(visible.yaw[0] - 0.75, visible.yaw[1] + 0.75, visible.el[0] - 0.75, visible.el[1] + 0.75);
        list.sort((a, b) => a[3] - b[3]);
      }
      const seen = new Set(), out = [];
      for (const t of list) {
        const k = `${t[1]},${t[2]}`;
        if (!seen.has(k)) {
          seen.add(k); out.push(t);
          // windows_extra: the cell's extra right after it (only while its dial is above 0)
          if (l3X > 0 && L3.has(t[0] + XK, t[1], t[2])) out.push([t[0] + XK, t[1], t[2], t[3]]);
        }
        if (out.length >= L3.n) break;
      }
      L3.want(out, now);
      // idle prefetch: after the first magnification, settled, on a fast connection, the hero tiles nearest the view
      const cap0 = PREFETCH_BYTES[tier] || PREFETCH_BYTES.T2;
      if (prefetchOn && l3Moment && L3.blobBytes < cap0 && !L3.fetching && !out.some((t) => !L3.where.has(L3.key(...t.slice(0, 3)))) && engine.state === "settled" && now - lastMove > 1500 && fast()) {
        const all = [...L3.avail[l3Moment]].map((s) => s.split(",").map(Number));
        const g = index.grid, td = index.tile_deg;
        const cy = (visible.yaw[0] + visible.yaw[1]) / 2, ce = (visible.el[0] + visible.el[1]) / 2;
        all.sort((a, b) => Math.hypot(g.yaw0 + (a[0] + 0.5) * td - cy, g.el_top - (a[1] + 0.5) * td - ce) - Math.hypot(g.yaw0 + (b[0] + 0.5) * td - cy, g.el_top - (b[1] + 0.5) * td - ce));
        for (const [i, j] of all) {
          const k = L3.key(l3Moment, i, j);
          if (L3.where.has(k) || L3.blobs.has(k) || L3.failed.has(k) || L3.waiting(k, now)) continue;
          L3.prefetch(k, cap0);
          break;
        }
      }
    },
    pump(now, frame) {
      if (!L3) return;
      const mb = (frame.state === "moving" ? UPLOAD_MB.moving : UPLOAD_MB.rest)[tier] || 1.6;
      const had = !!L3.tex;
      const n = L3.pump(now, Math.max(1, Math.floor((mb * 1e6) / tileBytes)), reduced() ? 150 : FADE_MS);
      if (n) { note("first-upload"); if (!had) note("array-allocated"); L3.syncMap(l3Moment, now, reduced() ? 150 : FADE_MS, l3X > 0); }
    },
    program,
    uniforms(prog, frame) {
      const u = prog.u;
      gl.activeTexture(gl.TEXTURE0 + L3_UNIT);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, L3.tex);
      gl.activeTexture(gl.TEXTURE0 + MAP_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, L3.mapTex);
      const g = index.grid;
      if (u.uL3Grid) gl.uniform4f(u.uL3Grid, g.yaw0, g.el_top, index.tile_deg, index.ppd);
      if (u.uL3Size) gl.uniform4f(u.uL3Size, L3.tw, L3.th, index.gutter, 0);
      if (u.uL3Dims) gl.uniform2f(u.uL3Dims, g.cols, g.rows);
      if (u.uL3On) gl.uniform1f(u.uL3On, useVariant && L3.tex && L3.mapTex && l3Moment ? 1 : 0);
      if (u.uL3X) gl.uniform1f(u.uL3X, l3X > 0 && L3.mapX ? l3X : 0);
      if (u.uL3MapSize) gl.uniform2f(u.uL3MapSize, g.cols, L3.mapRows);
    },
    info() {
      const arr = (k) => store.arrays[k] ? store.arrays[k].w * store.arrays[k].h * 4 * store.arrays[k].n : 0;
      const phoneMB = phoneL0 ? (arr("L0c") + arr("N0")) / 1e6 : 0;
      return { cap: cap(), capWhy: nav.zoomCapWhy || null, mag: +rig.mag.toFixed(3), magT: +rig.magT.toFixed(3), effMag: +effMag().toFixed(3),
        lf3: +lf3.toFixed(3), program: useVariant && variant?.ok ? "zoom" : "outside", moment: l3Moment, phoneL0, eyeK: +hooks.eyeK().toFixed(3), warmed,
        extra: { dial: l3X, cells: l3Moment && L3 ? (L3.avail[l3Moment + XK]?.size || 0) : 0, resident: l3Moment && L3 ? L3.resident(l3Moment + XK) : 0, mapRows: L3 ? L3.mapRows : null },
        l3: L3 ? L3.stats() : null, index: index ? { ppd: index.ppd, tiles: Object.fromEntries(Object.entries(L3.avail).map(([m, s]) => [m, s.size])), synthetic: !!index.synthetic } : null,
        memoryMB: { l3: L3 ? +(L3.memory() / 1e6).toFixed(1) : 0, phoneL0: +phoneMB.toFixed(1), total: +((L3 ? L3.memory() / 1e6 : 0) + phoneMB).toFixed(1) },
        budgetMB: +((L3 ? (slots * tileBytes) / 1e6 : 0) + (tier === "T1" ? (PHONE_L0(4) * 1028 * 1796 * 4 + (hasN0 ? PHONE_N0(4) * meta.geo.size.N0[0] * meta.geo.size.N0[1] * 4 : 0)) / 1e6 : 0)).toFixed(1), log };
    },
    lost() { if (L3) L3.free({ deleteGL: false }); variant = null; phoneL0 = 0; store.slotsOf = slotsOrig; },
    dispose() { L3?.dispose(); if (variant) gl.deleteProgram(variant.p); },
  };
  function fast() {
    const c = navigator.connection;
    return !!c && !c.saveData && c.effectiveType === "4g" && (!c.downlink || c.downlink >= 5);
  }
  outside.setZoom(hooks);

  return {
    hooks,
    info: () => hooks.info(),
    /** Compile and draw the program once now (the view still: no stall when the zoom starts). */
    warm() { if (L3 && !warmed) { warmWanted = true; engine.requestFrame(); } },
    /** QA: { eye: a fixed parallax scale (null: by the magnification), l3: false switches L3 off }. */
    setDebug(d) { Object.assign(dbg, d); engine.requestFrame(); },
    /** A zoom gesture at a point (canvas CSS px): its tiles lead the order for a moment; idle prefetch may begin. */
    gesture(at) {
      prefetchOn = true;
      if (!at || !rig.pose) return;
      const d = ray(rig.pose, at.x, at.y, at.w, at.h).d;
      const [yaw, el] = yawEl(d);
      focus = { yaw, el, t: performance.now() };
      engine.requestFrame();
    },
  };
}
