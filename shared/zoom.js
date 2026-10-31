// The window's magnifier, the outside's part (v3/zoom; docs/v3/live.md, "The window magnifier"). Loaded the first time someone magnifies at
// the window (router.js loadZoom), never at load: a visitor who never zooms downloads none of this.
//
//   const z = await (await import("/shared/zoom.js")).attachMagnifier(nav);   // nav: the router (engine, outside, rig)
//   z.gesture(at);     // a zoom gesture started at a point (canvas CSS px): fetch the sharp tiles under it first
//   z.info();          // what it holds and does (the smoke's window.magnify, tiles.l3 and zoom.memory read it)
//   z.density(yaw, el) // (v3/zoom-r2, kept in v3/zoom-r3) the px/deg of the sharpest picture a magnified view shows in a
//                      // direction: the router's ceiling (router.js magCeil) turns it into how far the zoom may go in there
//
// v3/zoom-r3: the desk magnifies too, and the outside alone is magnified (its own camera; the room fades out): rig.mag is
// the outside's magnification, rig.view its pose.
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
// - v3/zoom-sharp (docs/v3/bugs/2026-10-26-zoom-blur.md: the blocky, stretched view after a time change at 4x):
//   * L3 is drawn for every one of the outside's shader slots (the pair shown, a blend's partner too, and a pair fading
//     out), each moment with its own part of the map (after the extra's half), so blends and crossfades are sharp.
//   * Magnified past what L0 holds (sharp()), the outside holds a change of moments until ready(id) for each new one:
//     its share of the view's cells is in (fetched beside the shown ones', nearest first, the slots shared between
//     them), keeping the pair on screen sharp, then crossfades (outside.js update()).
//   * At rest there, the neighbouring moments' cells of the view are prefetched (compressed, within PREFETCH_BYTES)
//     before the hero tiles around it, and their panorama tiles warmed in the browser's cache (outside.warm).
//   * Where most of a shown moment's share is still to come (a first zoom), its new tiles fade in together: they wait
//     unshown until its share is in or GROUP_MS has passed, then fade over FADE_MS (a soft sharpening, not a patchwork
//     of pops); at a pan's edge one by one as before; a moment not on screen yet takes its tiles at once (the
//     crossfade is their fade). The view's cells are ordered in the screen's own shape.
//   * Magnified, the outside reads its coarser levels through a cubic B-spline (smooth(): uSmooth, outside.glsl.js
//     tapLv), so whatever shows before the sharp tiles is soft, never blocks.
import { BACKDROP_FS } from "./gl/outside.glsl.js";
import { ray } from "./rig.js";
import { RETRY_MS, retryable } from "./pano.js";

const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth01 = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const L3_UNIT = 22, MAP_UNIT = 23;      // texture units (the outside's own run 0..21: park round 2's near layer has 17 and 18, the
                                        // ships' night atlas 19, the street traffic's occluders 20 and 21; WebGL2 has 32 in all)
                                        // (DYS-168: were 20 / 21: drawn magnified, the map took unit 21 from the occluders' L3
                                        // atlas after bindAll, so the cars drawn after the backdrop read the map as occluders)
const LF3_WANT = 1.6;                   // L3 is fetched where the frame is denser than L0 x 2^(2 - 1.6) = 1.3
const LF3_DRAW = 1.9;                   // and drawn (the shader's weight is 0 from here on: the outside's own program)
// v3/zoom-sharp: sharp() from where L0 is one to one (a blend's partner or a moment fading out, drawn from L1 where
// it has no L3 since L0 is the dominant moment's alone, would be stretched past 2x from here), ending SHARP_EXIT past
// it (no flapping)
const LF_SHARP = 2.0;
const SHARP_EXIT = 0.15;
const FADE_MS = 400;                    // a shown moment's new tiles fade in (v3/zoom-sharp: was 200, tile by tile)
const GROUP_MS = 350;                   // ... together, once the view's middle is in or this long after the first came
const TILE_FADE_MS = 200;               // ... or one by one where most of the view is in already (a pan's edge: as before)
const NEIGHBOURS = { T1: 1, T2: 2, T3: 2 };              // moments each way of the shown one whose cells are prefetched
const MAX_FETCH = 6;
const BUDGET_MB = { T1: 40, T2: 80, T3: 96 };            // the L3 tiles' GPU memory (a 1 deg tile, 260 x 260 RGBA: 0.27 MB)
// (DYS-161: a phone's budget is its 4x squares' whole GPU memory, one array of that size, made at the first square; 32
// to 40 MB, 118 to 147 squares, now that a phone magnifies to the desktop's 4x view (router.js magCap, 8.37x): there
// its view is 4.25 x 7.24 deg, at most 7 x 10 squares with the 0.75 deg kept around it, 140 for the pair of moments a
// blend draws (each moment gets an even part of the array: 73). Only the view's squares (and a gesture's point) are
// asked for; one off the screen gives its place up first, the stalest first (L3Store._slot); and back at 1x for
// T1_DROP_MS the array itself goes back (want())
const T1_DROP_MS = 8000;
// (DYS-161 memory, OP1: a phone's way back to 1x was its memory's peak, above the full zoom itself (RD1, WebKit as an
// iPhone SE / 12 mini). OP1's timeline: on the way out the 4x squares around the gesture's point and the street
// traffic's occluder squares for the widening view were fetched, decoded and uploaded (14 and 22-32 files, ~40 pictures
// decoded, the web content process up 35-50 MB), the gesture's point asking for its squares even back at 1x; then the
// room's layers came back with its fade in (router.js sfw-links-wait). Now a zoom on its way out to where no square is
// drawn (wayOut) asks for none (the ones on the GPU still draw; the occluders: outside.js occl3For), and the gesture's
// point asks for none on a zoom out or at 1x. ?outpeak=drop: also the 4x array and the occluder atlas given back on the
// way to 1x once the view is below the squares, before the room fades in, not T1_DROP_MS after (-56.5 MB of WebGL,
// ~-76 MB in the GPU process, but a zoom in again within those 8 s waits for every square: OP1, 400-500 ms of the view
// short of its squares where main has 200-300); ?outpeak=0: as before)
const OUT_PEAK = (() => { const v = new URLSearchParams(location.search).get("outpeak"); return v === "0" ? 0 : v === "drop" ? 2 : 1; })();
const UPLOAD_MB = { moving: { T1: 0.8, T2: 1.6, T3: 1.6 }, rest: { T1: 1.6, T2: 4.4, T3: 4.4 } };   // L3 bytes uploaded a frame
const PHONE_L0 = (cap) => (cap >= 3 ? 3 : 2);            // phones: L0 city slots while magnified
const PHONE_N0 = (cap) => (cap >= 3 ? 2 : 0);            // and the near layer's 88 px/deg front (park round 2), 3x and up
const PREFETCH_BYTES = { T1: 3e6, T2: 8e6, T3: 8e6 };   // idle prefetch: compressed tiles kept in memory
// (DYS-151 memory: a phone keeps the compressed bytes of the 4x squares it has shown, the least recently used going
// first past this, after their array goes back (T1_DROP_MS, RELEASE_MS): a zoom in again decodes them from memory and
// asks the network for nothing. In a WebKit iPhone soak (Playwright's headless WebKit, 30 Oct) each square fetched again
// left the web content process ~25-80 KB bigger, none of it given back by a garbage collection, and the window's
// 1x-4x-1x (~125 squares a loop on main) was the loop's largest growth; 2 MB holds ~300 day squares (6 KB) or ~1300
// night ones. Desktops: none, as before.)
const KEEP_BYTES = { T1: 2e6, T2: 0, T3: 0 };
const FOCUS_MS = 1500;                                  // a gesture's point leads the order this long
const RELEASE_MS = 20000;                               // away from the window this long: the GPU memory goes back
const EYE_MAG = 1.8;                                    // the parallax is gone by this magnification
const XK = "~x";                                        // windows_extra's tiles: the moment's key with this suffix
const MAG_AT = new Set(["window", "desk"]);             // v3/zoom-r3: the spots that magnify (the router's magCap)

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
uniform vec2 uL3MapSize;       // the map's size in cells: (cols, rows), or more rows with the extra's or the other slots' parts
uniform vec3 uL3Rows;          // v3/zoom-sharp: the first row of shader slots 1, 2, 3's moments' cells in the map (-1: none)
float gLf3 = 8.0;              // log2(L3 px per screen px): 0 = L3 one to one, 2 = L0 one to one
float gL3W[4] = float[4](0.0, 0.0, 0.0, 0.0);   // the most L3 weight drawn at this pixel, per moment (its lights are in it)
vec3 l3Tap(vec2 uv, float s) { return textureLod(uL3, vec3(uv, s), 0.0).rgb; }
float l3Row(int m) { return m == 0 ? 0.0 : m == 1 ? uL3Rows.x : m == 2 ? uL3Rows.y : uL3Rows.z; }
// moment m (a shader slot)'s L3 at a direction: rgb and its weight
vec4 l3Colour(float yaw, float el, int m) {
  vec2 g = vec2(yaw - uL3Grid.x, uL3Grid.y - el) / uL3Grid.z;
  if (g.x < 0.0 || g.y < 0.0 || g.x >= uL3Dims.x || g.y >= uL3Dims.y) return vec4(0.0);
  ivec2 cell = ivec2(floor(g)), row0 = ivec2(0, int(l3Row(m)));
  vec4 e = texelFetch(uL3Map, cell + row0, 0);
  // (A's top bit: the cell may stand in for the near layer, DYS-13; the slot's high byte is the rest)
  float s = floor(e.r * 255.0 + 0.5) + 256.0 * mod(floor(e.a * 255.0 + 0.5), 128.0) - 1.0;
  if (s < 0.0) return vec4(0.0);
  // the covered area's edge: resident cells 1, the rest 0, read bilinearly between the cells' centres, so the level
  // fades out over the outer half of the last cell (0.5 deg, v3/zoom-r2) instead of stopping at a seam (the other
  // slots' parts: the same read by hand, their four cells clamped to their own rows)
  float cov;
  if (m == 0) cov = smoothstep(0.5, 1.0, textureLod(uL3Map, g / uL3MapSize, 0.0).g);
  else {
    vec2 p = g - 0.5, f = p - floor(p);
    ivec2 i0 = ivec2(floor(p)), hi = ivec2(uL3Dims) - 1;
    float c00 = texelFetch(uL3Map, clamp(i0, ivec2(0), hi) + row0, 0).g, c10 = texelFetch(uL3Map, clamp(i0 + ivec2(1, 0), ivec2(0), hi) + row0, 0).g;
    float c01 = texelFetch(uL3Map, clamp(i0 + ivec2(0, 1), ivec2(0), hi) + row0, 0).g, c11 = texelFetch(uL3Map, clamp(i0 + ivec2(1, 1), ivec2(0), hi) + row0, 0).g;
    cov = smoothstep(0.5, 1.0, mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y));
  }
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
  if (m == 0 && uL3X > 0.0) {
    // windows_extra over this cell (the map's second half: its slot, its fade in B), over black, x the dial (the shown
    // moment's only: a moment fading out keeps its baked windows)
    vec4 ex = texelFetch(uL3Map, cell + ivec2(0, int(uL3Dims.y) + 1), 0);
    float sx = floor(ex.r * 255.0 + 0.5) + 256.0 * mod(floor(ex.a * 255.0 + 0.5), 128.0) - 1.0;
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
// (DYS-13) moment m's cell at a direction may stand in for the near layer at high zoom (near-ok.json: its picture is the
// near layer's buildings, sharper): A's top bit in the map
float l3NearOk(float yaw, float el, int m) {
  vec2 g = vec2(yaw - uL3Grid.x, uL3Grid.y - el) / uL3Grid.z;
  if (l3Row(m) < 0.0 || g.x < 0.0 || g.y < 0.0 || g.x >= uL3Dims.x || g.y >= uL3Dims.y) return 0.0;
  return step(127.5, floor(texelFetch(uL3Map, ivec2(floor(g)) + ivec2(0, int(l3Row(m))), 0).a * 255.0 + 0.5));
}
vec3 momentColour(int m, float yaw, float el, float lf) {
  if (uL3On > 0.5 && gLf3 < ${LF3_DRAW.toFixed(2)} && el < uBand.y && l3Row(m) >= 0.0) {
    vec4 t = l3Colour(yaw, el, m);
    if (t.a > 0.0) {
      gL3W[m] = max(gL3W[m], t.a);
      // (v3/zoom-sharp: all of it L3, the panorama under it is not read)
      return t.a >= 0.999 ? t.rgb : mix(momentColour0(m, yaw, el, lf), t.rgb, t.a);
    }
  }
  return momentColour0(m, yaw, el, lf);
}
`;
export function variantSource(fs = BACKDROP_FS) {
  const edits = [
    ["vec3 momentColour(int m, float yaw, float el, float lf) {", "vec3 momentColour0(int m, float yaw, float el, float lf) {"],
    // (DYS-13) magnified, where the dominant moment's 4x square matches the near layer (near-ok.json), the near layer gives
    // way as the square comes in (gL3W: its weight at this pixel; the parallax is gone by 1.8x, so both are the panorama's
    // own view of the same buildings)
    ["        if (n2.a >= 0.0) { c = n2.rgb + (1.0 - n2.a) * c; near2A += w * n2.a; }",
      "        float nk = 1.0 - l3NearOk(yeF2.x, yeF2.y, m) * gL3W[m];\n        if (n2.a >= 0.0) { n2 *= nk; c = n2.rgb + (1.0 - n2.a) * c; near2A += w * n2.a; }"],
    ["          if (xd > 0.0) { vec3 nx = nearX(m, yeF2.x, yeF2.y) * (xd * uLtOn.w); c += nx; xNear += w * nx; }",
      "          if (xd > 0.0) { vec3 nx = nearX(m, yeF2.x, yeF2.y) * (xd * uLtOn.w * nk); c += nx; xNear += w * nx; }"],
    ["// the panorama blurred to about 4 px/deg", L3_GLSL + "// the panorama blurred to about 4 px/deg"],
    ["float lf = clamp(log2(max(uPpd.x * degPerPx, 1e-3)) + uLevelBias, 0.0, 2.0);",
      "float lf = clamp(log2(max(uPpd.x * degPerPx, 1e-3)) + uLevelBias, 0.0, 2.0);\n  gLf3 = log2(max(uL3Grid.w * degPerPx, 1e-6));"],
    ["    ext = extColour(uExtA, d, degPerPx) * uExtMix.x;\n    if (uExtMix.y > 0.0) ext += extColour(uExtB, d, degPerPx) * uExtMix.y;\n", "    // (v3/zoom: never in stage 1)\n"],
    // the L3 tiles are cut from the fully lit render (night's windows and lamps in them): no light layers over them,
    // moment by moment (v3/zoom-sharp: a moment drawn from the panorama beside one in L3 keeps its own lights), and
    // under all-L3 the layers are not read
    ["      vec3 L = lightsAdd(m, yaw, el, ab, xa) * ltKeep;", "      ab = vec3(0.0); xa = vec3(0.0);\n      vec3 L = gL3W[m] < 0.999 ? lightsAdd(m, yaw, el, ab, xa) * ltKeep : vec3(0.0);"],
    ["      lit += w * L;\n      asBaked += w * ab;", "      lit += w * L * (1.0 - gL3W[m]);\n      asBaked += w * ab * (1.0 - gL3W[m]);"],
    ["  if (uDebug == 4) col = mix(col, vec3(uTileW, 0.0, 1.0 - uTileW), 0.3);",
      "  if (uDebug == 4) col = mix(col, vec3(uTileW, 0.0, 1.0 - uTileW), 0.3);\n  if (uDebug == 1 && max(max(gL3W[0], gL3W[1]), max(gL3W[2], gL3W[3])) > 0.0) col = mix(col, vec3(1.0, 0.0, 1.0), 0.35 * max(max(gL3W[0], gL3W[1]), max(gL3W[2], gL3W[3])));"],
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
  constructor(gl, index, base, { slots, keep = 0, onLoaded }) {
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
    // (DYS-151 memory) the shown squares' compressed bytes, least recently used first: key -> Blob (KEEP_BYTES)
    this.kept = new Map(); this.keptBytes = 0; this.keepCap = keep; this.reused = 0;
    this.bytes = 0; this.uploads = 0; this.prefetched = 0; this.upMs = []; this.failed = new Set();
    this.retry = new Map();              // key -> { n, at }: its fetch failed n times; asked for again from `at` (pano.js RETRY_MS)
  }
  // a failed fetch, waiting before it is asked for again
  waiting(key, now = performance.now()) { const r = this.retry.get(key); return !!r && now < r.at; }
  reset() {
    this.gen = (this.gen || 0) + 1;      // (DYS-161 memory, OP1: an array's life; a square that lands after it went: _fetch)
    this.tex = null; this.mapTex = null;
    this.owner = new Array(this.n).fill(null);
    this.seen = new Float64Array(this.n);
    this.where = new Map();              // key -> { slot, t0 }
    this.pending = new Map();            // key -> "fetch"
    this.ready = [];                     // { key, bmp }
    // (C's merges review 3: fetches under way when the array goes still count down as they end (_fetch, prefetch), so
    // the count is kept, not zeroed: zeroed, it went below 0, stopping idle prefetch and lifting MAX_FETCH)
    this.fetching = this.fetching || 0;
    this.wantNow = new Map();
    this.map = new Uint8Array(this.cols * this.rows * 4);
    this.mapRows = this.rows;            // the map texture's rows: rows, + 1 + rows with windows_extra's half, + rows per other slot's moment
    this.mapX = false;
    this.mapMoment = null;               // "<slot 0's moment>|<slot 1's>|..."
    this.rowOf = [0, -1, -1, -1];        // the first row of each shader slot's moment's cells (-1: none)
    this.mapDirty = true;
    this.fading = false;
    this.waitSince = new Map();          // moment -> when its first tile still waiting to fade in came (GROUP_MS)
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
    const gen = this.gen;
    try {
      let blob = this.blobs.get(key);
      if (blob) { this.blobs.delete(key); this.blobBytes -= blob.size; }
      else if ((blob = this.kept.get(key))) this.reused++;   // (DYS-151 memory: shown before, no request)
      else {
        const r = await fetch(this.url(m, +i, +j));
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
        blob = await r.blob();
        this.bytes += blob.size;
      }
      // display values already (as the panorama's own tiles): no colour conversion; decoded off the main thread
      const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      if (this.dead) { bmp.close(); return; }
      this._keep(key, blob);
      this.retry.delete(key);
      // (DYS-161 memory, OP1: one that lands after its array went (free: gen), wanted by no view now, is let go: it
      // would make the array again; its bytes are kept, as a shown one's)
      if (gen !== this.gen && !this.wantNow.has(key)) { bmp.close(); return; }
      this.ready.push({ key, bmp });
      this.onLoaded?.();
    } catch (e) {
      this.pending.delete(key);
      this._failed(key, e, "tile");
    } finally {
      this.fetching--;
    }
  }
  // (DYS-151 memory) a decoded square's compressed bytes kept (moved to the newest end when kept already), the least
  // recently used let go past keepCap
  _keep(key, blob) {
    if (!this.keepCap || !blob) return;
    const had = this.kept.get(key);
    if (had) { this.kept.delete(key); this.keptBytes -= had.size; }
    this.kept.set(key, blob); this.keptBytes += blob.size;
    for (const [k, b] of this.kept) {
      if (this.keptBytes <= this.keepCap) break;
      this.kept.delete(k); this.keptBytes -= b.size;
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
  /** Idle prefetch: one tile's bytes into memory (not decoded), when nothing else is under way (at low priority). */
  async prefetch(key, cap) {
    if (this.blobBytes >= cap || this.fetching || this.where.has(key) || this.pending.has(key) || this.blobs.has(key) || this.kept.has(key) || this.failed.has(key) || this.waiting(key)) return false;
    const [m, i, j] = key.split("|");
    this.fetching++;
    try {
      const r = await fetch(this.url(m, +i, +j), { priority: "low" });
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
  /** Idle prefetch over budget: the held bytes of moments not in `keep` go first (a view or a time left behind), down
   * to three quarters of the cap. */
  trim(keep, cap) {
    if (this.blobBytes < cap) return;
    for (const [key, b] of this.blobs) {
      if (this.blobBytes < cap * 0.75) break;
      if (keep.has(key.split("|")[0])) continue;
      this.blobs.delete(key); this.blobBytes -= b.size;
    }
  }
  /** Inside the outside pass: at most `max` tiles a frame to the GPU, the most wanted first. A tile of a moment on
   * screen (shown) waits unshown for release(); any other's is in at once (it is not drawn until a crossfade brings it). */
  pump(now, max, fadeMs, shown = null, group = null) {
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
      const m = key.split("|")[0].replace(XK, "");
      const on = fadeMs > 0 && (!shown || shown.has(m)), wait = on && (!group || group.has(m));
      if (wait && !this.waitSince.has(m)) this.waitSince.set(m, now);
      // (fd: its fade; one by one at most TILE_FADE_MS, as before v3/zoom-sharp)
      this.where.set(key, { slot, t0: wait ? Infinity : on ? now : now - 1e6, fd: wait ? fadeMs : Math.min(fadeMs, TILE_FADE_MS) });
      this.uploads++;
      this.mapDirty = true;
      n++;
    }
    return n;
  }
  /** v3/zoom-sharp: moment m's tiles waiting to fade in start their fade together, once `complete` (the view's middle is
   * in) or GROUP_MS after the first of them came. */
  release(m, now, complete, at = now) {
    const since = this.waitSince.get(m);
    if (since === undefined || (!complete && now - since < GROUP_MS)) return;
    for (const [key, w] of this.where) if (w.t0 === Infinity && key.split("|")[0].replace(XK, "") === m) w.t0 = at;
    this.waitSince.delete(m);
    this.mapDirty = true;
  }
  /** Are all these cells of moment m in (or given up)? */
  inFor(m, cells) { return cells.every(([i, j]) => { const k = this.key(m, i, j); return this.where.has(k) || this.failed.has(k) || !this.has(m, i, j); }); }
  /** The grid map for the moments in the outside's shader slots (R slot + 1, G resident, B fade), to the GPU when it
   * changed. x: windows_extra on (slot 0's extra cells in a second part, rows + 1 on, below a copy of the last row: the
   * coverage's bilinear read at the grid's bottom edge sees what a clamp would). v3/zoom-sharp: slots 1-3's moments'
   * cells after that, `rows` each (rowOf; the shader reads their coverage by hand, within their own rows). With neither,
   * the map is exactly as it was for one moment. */
  syncMap(ms, now, fadeMs, x = false) {
    const gl = this.gl;
    const m = Array.isArray(ms) ? ms[0] : ms, more = Array.isArray(ms) ? ms.slice(1) : [];
    const others = more.map((id) => (id && id !== m ? id : null));
    const id = `${m}|${others.join("|")}`;
    if (id !== this.mapMoment) { this.mapMoment = id; this.mapDirty = true; }
    if (x !== this.mapX) { this.mapX = x; this.mapDirty = true; }
    if (!this.mapDirty && !this.fading) return;
    let rows = this.rows + (x || others.some(Boolean) ? 1 : 0) + (x ? this.rows : 0);
    this.rowOf = [0, -1, -1, -1];
    others.forEach((o, k) => { if (o) { this.rowOf[k + 1] = rows; rows += this.rows; } });
    const rowFor = new Map();
    others.forEach((o, k) => { if (o && !rowFor.has(o)) rowFor.set(o, this.rowOf[k + 1]); });
    if (this.map.length !== this.cols * rows * 4) this.map = new Uint8Array(this.cols * rows * 4);
    this.map.fill(0);
    let fading = false;
    for (const [key, w] of this.where) {
      const [mm, i, j] = key.split("|");
      const isX = x && mm === m + XK, r0 = mm === m ? 0 : isX ? this.rows + 1 : rowFor.get(mm);
      if (r0 === undefined) continue;
      const f = fadeMs > 0 ? smooth01((now - w.t0) / (w.fd || fadeMs)) : 1;
      if (f < 1) fading = true;
      const o = ((+j + r0) * this.cols + +i) * 4;
      // (DYS-13: A's top bit, the cell may stand in for the near layer; never on the extra's part)
      const ok = !isX && !!this.nearOk?.[mm.replace(XK, "")]?.has(`${i},${j}`);
      this.map[o] = (w.slot + 1) & 255; this.map[o + 1] = 255; this.map[o + 2] = Math.round(f * 255); this.map[o + 3] = ((w.slot + 1) >> 8) | (ok ? 128 : 0);
    }
    if (x || others.some(Boolean)) this.map.copyWithin(this.rows * this.cols * 4, (this.rows - 1) * this.cols * 4, this.rows * this.cols * 4);
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
      keptKB: Math.round(this.keptBytes / 1024), reused: this.reused,
      uploadMs: up.length ? { median: +up[up.length >> 1].toFixed(2), max: +up[up.length - 1].toFixed(2) } : null, mb: +(this.memory() / 1e6).toFixed(1) };
  }
  /** (DYS-161 memory, OP1) The squares decoded and not yet uploaded let go (a zoom on its way out past them: they would
   * be uploaded for a view already gone); a view that wants one again decodes it again from its kept bytes. */
  hold() {
    for (const r of this.ready) { r.bmp.close(); this.pending.delete(r.key); }
    this.ready.length = 0;
  }
  /** The GPU side is gone (a lost context) or handed back (away from the window): start again from nothing. */
  free({ deleteGL = true } = {}) {
    if (deleteGL) { if (this.tex) this.gl.deleteTexture(this.tex); if (this.mapTex) this.gl.deleteTexture(this.mapTex); }
    for (const r of this.ready) r.bmp.close();
    this.reset();
  }
  dispose() { this.dead = true; this.free(); this.blobs.clear(); this.blobBytes = 0; this.kept.clear(); this.keptBytes = 0; }
}

// ------------------------------------------------------------------------------------------------ the magnifier
export async function attachMagnifier(nav) {
  const { engine, outside, rig } = nav;
  const gl = engine.gl, meta = outside.meta, store = outside.store;
  const tier = engine.settings.tier;
  // the zoom levels beside the panorama (assemble.py writes room3d/zoom.json: { l3: "<index>" | null, near: <map> })
  let index = null, base = null, nearMap = null, nearOk = null;
  try {
    const zr = await fetch(new URL("zoom.json", meta.base));
    const z = zr.ok ? await zr.json() : null;
    if (z?.near?.cover) {
      const b = atob(z.near.cover), c = new Uint8Array(b.length);
      for (let i = 0; i < b.length; i++) c[i] = b.charCodeAt(i);
      if (c.length === z.near.cols * z.near.rows) nearMap = { ...z.near, cover: c };
    }
    if (z?.l3) {
      const iu = new URL(z.l3, new URL("zoom.json", meta.base));
      const ir = await fetch(iu);
      if (ir.ok) { index = await ir.json(); base = new URL(".", iu).href; }
      // (DYS-13) the 4x squares that may stand in for the near layer, per moment: zoom.json's near_ok (assemble.py
      // --near-ok, scripts/live/near_ok.py), else a near-ok.json beside the index; none: as before
      const okIn = z.near_ok || (index ? await fetch(new URL("near-ok.json", iu)).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null);
      if (okIn) nearOk = Object.fromEntries(Object.entries(okIn).filter(([k, v]) => !k.startsWith("_") && Array.isArray(v)).map(([k, v]) => [k, new Set(v.map(([i, j]) => `${i},${j}`))]));
    }
  } catch (e) { console.warn("[zoom] no sharper level:", e.message); }

  const reduced = () => engine.settings.reducedMotion;
  const cap = () => rig.magCap(MAG_AT.has(rig.spot) ? rig.spot : "window");
  const atMag = () => MAG_AT.has(rig.spot) || (MAG_AT.has(rig.from) && !!rig.glide);
  const tileBytes = index ? (index.tile_px + 2 * index.gutter) ** 2 * 4 : 1;
  const slots = Math.min(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS), Math.floor(((BUDGET_MB[tier] || BUDGET_MB.T2) * 1e6) / tileBytes));
  const L3 = index ? new L3Store(gl, index, base, { slots, keep: KEEP_BYTES[tier] || 0, onLoaded: () => engine.requestFrame() }) : null;
  if (L3) L3.nearOk = nearOk;   // (DYS-13)
  let variant = null, variantFailed = false;
  let lf3 = 8, l3Moment = null, useVariant = false, focus = null, awaySince = null, phoneL0 = 0, lastMove = 0, prefetchOn = false;
  let warmWanted = false, warmed = false;
  let dropAt = null, drops = 0;          // (DYS-161) a phone back at 1x since, and its arrays dropped so far
  let occlAt = null, occlDrops = 0;      // (DYS-161 memory) the same for the street traffic's L3 occluder atlas (outside.js)
  // (DYS-161 memory, OP1) a phone's zoom on its way out past the squares (wayOut) this frame; the arrays given back on
  // the way to 1x (the 4x array, the occluder atlas) and the squares held back meanwhile
  let outbound = false, outDrops = 0, outOccl = 0, outHeld = 0;
  // v3/zoom-sharp: the moments drawn with L3 (the outside's four shader slots; l3Moment is slot 0's), sharp mode,
  // the view's cells nearest first and how many of them each fetched moment gets (its share: readiness is that share
  // in), and the view they were taken from (info's account)
  let l3M = [null, null, null, null], sharpOn = false, viewCells = [], share = 0, lastVis = null;
  const shownSet = new Set(), groupSet = new Set(), shareOf = new Map();
  const dbg = { eye: null, l3: true, wx: null, honest: true, sharp: true };   // QA (smoke zoom.align): pin the parallax scale, switch L3 off; wx: windows_extra's dial; honest: false lifts the ceiling (router.js magCeil); sharp: false, the outside as before v3/zoom-sharp (blends and changes at once while magnified)
  let l3X = 0;                          // windows_extra: the dial over L3 this frame (0: none of it)
  const log = [["attach", Math.round(performance.now())]];     // (when each first thing happened: the walk's long frames)
  const once = new Set(), note = (k) => { if (!once.has(k)) { once.add(k); log.push([k, Math.round(performance.now())]); } };
  const slotsOrig = store.slotsOf;
  // the variant program compiles now (in parallel where the browser can), so it is ready when the first tiles are
  if (L3) { try { variant = outside.backdropProgram(variantSource()); } catch (e) { variantFailed = true; console.warn("[zoom]", e.message); } }

  // the outside's magnification now (v3/zoom-r3: the rig's own; the room's lens never narrows)
  function effMag() {
    if (!rig.pose || !atMag()) return 1;
    // (DYS-161: a phone's cap is past 8x: 8.37 on a portrait phone)
    return clamp(rig.mag, 1, Math.max(8, cap()));
  }
  // (DYS-161 memory, OP1) a zoom on its way out (a pinch out, a reset's ease back to 1x) to a magnification where no
  // square is drawn: the density it is going to (this frame's lf3 less the magnification still to lose) past LF3_DRAW
  function wayOut() {
    if (!rig.zoomOut && !rig.zoomEase) return false;
    const at = Math.max(1, rig.mag), to = Math.max(1, rig.magT);
    return at > to * 1.0005 && lf3 + Math.log2(at / to) >= LF3_DRAW;
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

  // v3/zoom-sharp: is moment id sharp for this view: its share of the view's cells in or given up (or none of them
  // there, or the view not magnified past L0)?
  function ready(id) {
    if (!sharpOn || !L3 || !L3.avail[id]) return true;
    return L3.inFor(id, shareOf.get(id) || viewCells.slice(0, Math.max(1, share)));
  }
  // (QA) per moment drawn with L3, the share of the view's middle (the inner half of what the window shows) it draws
  // from L3 this frame: its cells there in and faded in, times L3's own weight at this density (the shader's)
  function viewShare() {
    if (!L3 || !lastVis || lastVis.none) return [];
    const g = index.grid, td = index.tile_deg, v = lastVis, now = performance.now(), fadeMs = reduced() ? 150 : FADE_MS;
    const cy = (v.yaw[0] + v.yaw[1]) / 2, ce = (v.el[0] + v.el[1]) / 2, hy = (v.yaw[1] - v.yaw[0]) / 4, he = (v.el[1] - v.el[0]) / 4;
    const k = useVariant && variant?.ok ? 1 - smooth01((lf3 - 1.5) / (LF3_DRAW - 1.5)) : 0;
    return l3M.map((m, slot) => {
      if (!m) return null;
      let n = 0, got = 0;
      for (let i = Math.max(0, Math.floor((cy - hy - g.yaw0) / td)); i <= Math.min(g.cols - 1, Math.floor((cy + hy - g.yaw0) / td)); i++)
        for (let j = Math.max(0, Math.floor((g.el_top - ce - he) / td)); j <= Math.min(g.rows - 1, Math.floor((g.el_top - ce + he) / td)); j++) {
          if (!L3.has(m, i, j)) continue;
          n++;
          const w = L3.where.get(L3.key(m, i, j));
          if (w && now - w.t0 >= (w.fd || fadeMs)) got++;
        }
      return { slot, m, cells: n, l3: n ? +((k * got) / n).toFixed(3) : 0 };
    }).filter(Boolean);
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
    // (v3/street-traffic: the outside draws its 3D vehicles no sharper than the picture behind them)
    density: (yaw, el) => density(yaw, el),
    eyeK: () => { if (dbg.eye !== null) return dbg.eye; const m = effMag(); return m <= 1 ? 1 : 1 - smooth01(Math.log(m) / Math.log(EYE_MAG)); },
    wantL0: () => MAG_AT.has(rig.spot) && (rig.magnified || effMag() > 1.02),
    busy: () => (!!L3 && L3.busy) || (warmWanted && !warmed && !variantFailed),
    // (DYS-161 memory, OP1) a phone's zoom on its way out past the squares: the vehicles ask for no occluder square
    // (outside.js occl3For: the ones in the atlas only, else L0 as while one is on its way)
    outbound: () => outbound,
    // v3/zoom-sharp: magnified past L0 at a spot that magnifies; the outside then holds a change of moments until
    // ready(id) for each new one (outside.js update())
    sharp: () => sharpOn,
    ready: (id) => ready(id),
    // ... and reads its coarser levels through a cubic spline, eased in over the first 0.6x of magnification
    smooth: () => (atMag() ? smooth01((effMag() - 1) / 0.6) : 0),
    // slots: the outside's shader slots' moments; pair: the moments of the pair shown (any other slot's moment is
    // fading out); incoming: the moments a change waits for (their cells fetched beside the shown ones'); next: the shown
    // moment's neighbours in the day (prefetched at rest)
    want(frame, { visible, dom, weights, cam, slots: sl = null, pair = null, incoming = [], next = [] }) {
      const now = frame.time, m = effMag();
      if (rig.moving) lastMove = now;
      // away from the window and the desk for a while: the GPU memory goes back
      const here = MAG_AT.has(rig.spot) || MAG_AT.has(rig.from);
      if (here) awaySince = null; else if (awaySince === null) awaySince = now;
      if (awaySince !== null && now - awaySince > RELEASE_MS) {
        if (L3 && L3.tex) L3.free();
        if (tier === "T1" && outside.occlFree?.()) occlDrops++;   // (DYS-161 memory: a phone's occluder atlas too)
        phoneSlots(false);
        useVariant = false; sharpOn = false; l3M = [null, null, null, null]; l3Moment = null; viewCells = [];
        if (L3) L3.want([], now);
        return;
      }
      // (DYS-161: a phone's 4x squares go back once none can be on screen: back at 1x at the window for T1_DROP_MS (a
      // phone's 1x is about 22 px/deg, the squares are drawn from 135), the array is freed as it is away from the
      // window; a zoom in fetches them again, from the browser's cache)
      // (DYS-161 memory: and the street traffic's L3 occluder atlas (18.6 MB), on its own clock: at 1x no vehicle is drawn
      // with it; a magnified view's vehicles ask for their squares again (outside.js occlSlot, from the browser's cache))
      if (tier === "T1" && here && !rig.magnified && m <= 1.02 && outside.occlHeld?.()) {
        if (occlAt === null) occlAt = now;
        else if (now - occlAt > T1_DROP_MS) { outside.occlFree(); note("t1-occl-drop"); occlAt = null; occlDrops++; }
      } else occlAt = null;
      if (tier === "T1" && L3?.tex && here && !rig.magnified && m <= 1.02) {
        if (dropAt === null) dropAt = now;
        else if (now - dropAt > T1_DROP_MS) {
          L3.free(); note("t1-drop"); dropAt = null; drops++;
          useVariant = false; sharpOn = false; l3M = [null, null, null, null]; l3Moment = null; viewCells = [];
          L3.want([], now);
          return;
        }
      } else dropAt = null;
      // (once given, a phone keeps its L0 slots while at the window: zooming out and in again fetches nothing twice)
      if (here) phoneSlots(phoneL0 > 0 || rig.magnified || m > 1.02);
      // the full-size frame's density (a moving frame draws smaller: the tiles are for where it comes to rest)
      const ppdFull = cam.pxPerRad * DEG * (engine.height / Math.max(1, frame.height));
      lf3 = index ? Math.log2(index.ppd / Math.max(1e-3, ppdFull)) : 8;
      // (magnified only: at 1x the window is as it always was, on any screen)
      sharpOn = dbg.sharp !== false && MAG_AT.has(rig.spot) && m > 1.02 && lf3 < LF_SHARP + (sharpOn ? SHARP_EXIT : 0);
      // the moments drawn with L3: every shader slot's (the pair shown, a blend's partner too, and a pair fading out),
      // at any weight (v3/zoom-sharp: slot 0's alone, past half its weight, before)
      const ids = sl || [dom];
      l3M = [0, 1, 2, 3].map((s) => (L3 && ids[s] && L3.avail[ids[s]] && (weights[s] || 0) > 0 ? ids[s] : null));
      l3M = l3M.map((id, s) => (id && l3M.indexOf(id) === s ? id : null));
      l3Moment = l3M[0];
      useVariant = dbg.l3 && lf3 < LF3_DRAW && l3M.some((id) => id && L3.resident(id) > 0);
      lastVis = visible;
      if (!L3) return;
      // (DYS-161 memory, OP1) a phone's zoom on its way out to where no square is drawn: none asked for (below) or
      // uploaded from here on (the ones on the GPU still draw); with ?outpeak=drop, on its way back to 1x, once the view
      // is below the squares (none drawn: past LF3_DRAW and the sharp mode's exit), the 4x array and the occluder atlas
      // go at once, before the room fades in (a zoom in again fetches them, the squares' bytes from memory: KEEP_BYTES)
      outbound = tier === "T1" && OUT_PEAK > 0 && here && wayOut();
      if (outbound) {
        if (L3.ready.length) { outHeld += L3.ready.length; L3.hold(); }
        if (OUT_PEAK > 1 && rig.magT <= 1.0005 && lf3 >= LF3_DRAW + SHARP_EXIT) {
          if (L3.tex) { L3.free(); note("t1-out-drop"); outDrops++; useVariant = false; }
          if (outside.occlFree?.()) { note("t1-out-occl"); outOccl++; }
        }
      }
      // windows_extra: the outside's dial for the dominant moment (v3/detail-int's outside.wxDials; none before it)
      const xd = dbg.wx !== null ? dbg.wx : (outside.wxDials?.[0] ?? 0);
      l3X = l3Moment && xd > 0 && L3.avail[l3Moment + XK]?.size ? xd : 0;
      // the view's cells (every moment has the same ones), nearest the gesture's point or the view's middle first
      // (v3/zoom-sharp: nearest in the screen's own shape, so a share of them is a rectangle like the view: a phone's
      // tall middle as a desktop's wide one)
      const cells = [], cellsOf = l3Cells();
      if (here && cellsOf) {
        const g = index.grid, td = index.tile_deg;
        const f = focus && now - focus.t < FOCUS_MS ? focus : null;
        const cy = f ? f.yaw : (visible.yaw[0] + visible.yaw[1]) / 2, ce = f ? f.el : (visible.el[0] + visible.el[1]) / 2;
        const hy = Math.max(0.5, (visible.yaw[1] - visible.yaw[0]) / 2), he = Math.max(0.5, (visible.el[1] - visible.el[0]) / 2);
        const dist = (dy, de) => Math.max(Math.abs(dy) / hy, Math.abs(de) / he) + 0.01 * Math.hypot(dy / hy, de / he);
        const add = (y0, y1, e0, e1) => {
          for (let i = Math.max(0, Math.floor((y0 - g.yaw0) / td)); i <= Math.min(g.cols - 1, Math.floor((y1 - g.yaw0) / td)); i++)
            for (let j = Math.max(0, Math.floor((g.el_top - e1) / td)); j <= Math.min(g.rows - 1, Math.floor((g.el_top - e0) / td)); j++)
              if (cellsOf.has(`${i},${j}`)) cells.push([i, j, dist(g.yaw0 + (i + 0.5) * td - cy, g.el_top - (j + 0.5) * td - ce)]);
        };
        // the gesture's point (as it starts: the tiles under the pointer, before the view has narrowed onto them)
        // (DYS-161 memory, OP1: a phone's zoom out, or the view back at 1x, asks for none there: they would be shown only
        // by a zoom in, which asks for them as it starts)
        if (f && !(tier === "T1" && OUT_PEAK > 0 && (rig.zoomOut || !rig.magnified))) add(f.yaw - 3, f.yaw + 3, f.el - 2, f.el + 2);
        // and what is on screen, where the screen is dense enough for them (parallax moves near things by up to 0.5 deg)
        if (lf3 < LF3_WANT && !visible.none) add(visible.yaw[0] - 0.75, visible.yaw[1] + 0.75, visible.el[0] - 0.75, visible.el[1] + 0.75);
        cells.sort((a, b) => a[2] - b[2]);
      }
      const seen = new Set();
      viewCells = cells.filter(([i, j]) => { const k = `${i},${j}`; if (seen.has(k)) return false; seen.add(k); return true; });
      // the moments fetched: the pair shown's and the ones a change waits for, each at most an even part of the slots,
      // its nearest cells first (so on a phone they share them: each its middle); a moment fading out keeps what it
      // has of its part. On screen first, then what a change waits for (fetched in that order).
      const shownPair = pair || [l3M[0]];
      const fetchFor = [...new Set([...l3M.filter((id) => id && shownPair.includes(id)), ...incoming].filter((id) => id && L3.avail[id]))];
      const keep = l3M.filter((id) => id && !fetchFor.includes(id));
      const per = Math.max(1, Math.floor(L3.n / Math.max(1, fetchFor.length + keep.length)));
      const out = [], got = new Map();
      const take = (list) => {
        for (const [i, j, d] of viewCells) for (const [id, held] of list) {
          if ((got.get(id) || 0) >= per || !L3.has(id, i, j) || (held && !L3.where.has(L3.key(id, i, j)))) continue;
          got.set(id, (got.get(id) || 0) + 1);
          out.push([id, i, j, d]);
          // windows_extra: the cell's extra right after it (slot 0's moment, only while its dial is above 0)
          if (id === l3Moment && l3X > 0 && L3.has(id + XK, i, j)) out.push([id + XK, i, j, d]);
        }
      };
      take([...fetchFor.filter((id) => !incoming.includes(id)).map((id) => [id, false]), ...keep.map((id) => [id, true])]);
      take(fetchFor.filter((id) => incoming.includes(id)).map((id) => [id, false]));
      if (out.length > L3.n) out.length = L3.n;
      // (DYS-161 memory, OP1: on its way out past them, the squares already on the GPU only: none asked for)
      if (outbound) { let k = 0; for (const t of out) if (L3.where.has(L3.key(t[0], t[1], t[2]))) out[k++] = t; out.length = k; }
      L3.want(out, now);
      // each fetched moment's share: the cells it got in the list (ready() asks for them; another moment, for as many)
      shareOf.clear();
      for (const [id, i, j] of out) if (!id.endsWith(XK)) (shareOf.get(id) || shareOf.set(id, []).get(id)).push([i, j]);
      share = fetchFor.length ? Math.min(...fetchFor.map((id) => shareOf.get(id)?.length || 0)) : viewCells.length;
      // a shown moment's new tiles fade in together once its share is in (or GROUP_MS on) where most of its share is
      // still to come (a first zoom, a jump); else one by one, as before (a pan's edge); a moment no longer shown takes
      // its waiting ones at once
      shownSet.clear(); groupSet.clear();
      for (const id of l3M) if (id) shownSet.add(id);
      for (const id of shownSet) { const sh = shareOf.get(id) || []; if (sh.filter(([i, j]) => L3.where.has(L3.key(id, i, j))).length < sh.length / 2) groupSet.add(id); }
      for (const id of shownSet) L3.release(id, now, L3.inFor(id, shareOf.get(id) || viewCells.slice(0, Math.max(1, share))));
      for (const id of [...L3.waitSince.keys()]) if (!shownSet.has(id)) L3.release(id, now, true, now - 1e6);
      L3.syncMap(l3M, now, reduced() ? 150 : FADE_MS, l3X > 0);
      // idle prefetch: after the first magnification, settled, on a fast connection: (v3/zoom-sharp) first the
      // neighbouring moments' share of this view (a step of the dial then lands sharp), then their panorama tiles warmed
      // in the browser's cache (outside.warm), then the hero tiles nearest the view (a pan)
      const cap0 = PREFETCH_BYTES[tier] || PREFETCH_BYTES.T2;
      if (prefetchOn && l3Moment && !L3.fetching && !out.some((t) => !L3.where.has(L3.key(...t.slice(0, 3)))) && engine.state === "settled" && now - lastMove > 1500 && fast()) {
        const nb = sharpOn ? next.filter((id) => L3.avail[id]).slice(0, 2 * (NEIGHBOURS[tier] || 1)) : [];
        L3.trim(new Set([...shownSet, ...nb]), cap0);
        let started = false;
        const nbCells = viewCells.slice(0, Math.min(viewCells.length, Math.ceil(L3.n / 2)));
        if (L3.blobBytes < cap0) {
          for (const [i, j] of nbCells) {
            for (const id of nb) {
              const k = L3.key(id, i, j);
              if (!L3.has(id, i, j) || L3.where.has(k) || L3.blobs.has(k) || L3.kept.has(k) || L3.failed.has(k) || L3.waiting(k, now)) continue;
              L3.prefetch(k, cap0); started = true; break;
            }
            if (started) break;
          }
        }
        if (!started) for (const id of nb) if (outside.warm?.(id)) { started = true; break; }
        if (!started && L3.blobBytes < cap0) {
          const all = [...L3.avail[l3Moment]].map((s) => s.split(",").map(Number));
          const g = index.grid, td = index.tile_deg;
          const cy = (visible.yaw[0] + visible.yaw[1]) / 2, ce = (visible.el[0] + visible.el[1]) / 2;
          all.sort((a, b) => Math.hypot(g.yaw0 + (a[0] + 0.5) * td - cy, g.el_top - (a[1] + 0.5) * td - ce) - Math.hypot(g.yaw0 + (b[0] + 0.5) * td - cy, g.el_top - (b[1] + 0.5) * td - ce));
          for (const [i, j] of all) {
            const k = L3.key(l3Moment, i, j);
            if (L3.where.has(k) || L3.blobs.has(k) || L3.kept.has(k) || L3.failed.has(k) || L3.waiting(k, now)) continue;
            L3.prefetch(k, cap0);
            break;
          }
        }
      }
    },
    pump(now, frame) {
      if (!L3) return;
      // (DYS-149: a zoom gesture (pinch, zoomed pan) moves the outside's camera alone: moving too (frame.outsideMoving,
      // phones), so its squares go up at 0.8 MB a frame, not 1.6; at rest the resting cap fills the view as before)
      const mb = (frame.state === "moving" || frame.outsideMoving ? UPLOAD_MB.moving : UPLOAD_MB.rest)[tier] || 1.6;
      const had = !!L3.tex;
      const n = L3.pump(now, Math.max(1, Math.floor((mb * 1e6) / tileBytes)), reduced() ? 150 : FADE_MS, shownSet, groupSet);
      if (n) { note("first-upload"); if (!had) note("array-allocated"); L3.syncMap(l3M, now, reduced() ? 150 : FADE_MS, l3X > 0); }
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
      if (u.uL3On) gl.uniform1f(u.uL3On, useVariant && L3.tex && L3.mapTex && l3M.some(Boolean) ? 1 : 0);
      if (u.uL3X) gl.uniform1f(u.uL3X, l3X > 0 && L3.mapX ? l3X : 0);
      if (u.uL3MapSize) gl.uniform2f(u.uL3MapSize, g.cols, L3.mapRows);
      if (u.uL3Rows) gl.uniform3f(u.uL3Rows, ...[1, 2, 3].map((s) => (l3M[s] && L3.rowOf[s] >= 0 ? L3.rowOf[s] : -1)));
    },
    info() {
      const arr = (k) => store.arrays[k] ? store.arrays[k].w * store.arrays[k].h * 4 * store.arrays[k].n : 0;
      const phoneMB = phoneL0 ? (arr("L0c") + arr("N0")) / 1e6 : 0;
      return { cap: cap(), capWhy: nav.zoomCapWhy || null, mag: +rig.mag.toFixed(3), magT: +rig.magT.toFixed(3), effMag: +effMag().toFixed(3),
        lf3: +lf3.toFixed(3), program: useVariant && variant?.ok ? "zoom" : "outside", moment: l3Moment, phoneL0, eyeK: +hooks.eyeK().toFixed(3), warmed, drops, occlDrops,
        out: { on: OUT_PEAK, outbound, drops: outDrops, occl: outOccl, held: outHeld },   // (DYS-161 memory, OP1: QA)
        sharp: sharpOn, moments: l3M.slice(), share, cellsInView: viewCells.length, view: viewShare(),
        extra: { dial: l3X, cells: l3Moment && L3 ? (L3.avail[l3Moment + XK]?.size || 0) : 0, resident: l3Moment && L3 ? L3.resident(l3Moment + XK) : 0, mapRows: L3 ? L3.mapRows : null },
        l3: L3 ? L3.stats() : null, index: index ? { ppd: index.ppd, tiles: Object.fromEntries(Object.entries(L3.avail).map(([m, s]) => [m, s.size])), synthetic: !!index.synthetic } : null,
        memoryMB: { l3: L3 ? +(L3.memory() / 1e6).toFixed(1) : 0, phoneL0: +phoneMB.toFixed(1), total: +((L3 ? L3.memory() / 1e6 : 0) + phoneMB).toFixed(1) },
        budgetMB: +((L3 ? (slots * tileBytes) / 1e6 : 0) + (tier === "T1" ? (PHONE_L0(4) * 1028 * 1796 * 4 + (hasN0 ? PHONE_N0(4) * meta.geo.size.N0[0] * meta.geo.size.N0[1] * 4 : 0)) / 1e6 : 0)).toFixed(1), log };
    },
    lost() { if (L3) L3.free({ deleteGL: false }); variant = null; phoneL0 = 0; store.slotsOf = slotsOrig; l3M = [null, null, null, null]; l3Moment = null; viewCells = []; },
    dispose() { L3?.dispose(); if (variant) gl.deleteProgram(variant.p); },
  };
  function fast() {
    const c = navigator.connection;
    return !!c && !c.saveData && c.effectiveType === "4g" && (!c.downlink || c.downlink >= 5);
  }
  outside.setZoom(hooks);

  // ---- the ceiling's density (v3/zoom-r2's honest limits): the px/deg of what a magnified view shows in a direction (the
  // panorama's yaw right of its axis, elevation). L3's 256 where its tiles exist (for the dominant moment; every moment
  // has the same cells), faded over the outer half of the last cell as the shader fades it; the near layer's 88 where it
  // covers, since it is drawn over the city and L3 (zoom.json's map from assemble.py); L0's 64 elsewhere, the sky too.
  // Mixed on a log scale.
  const L0_PPD = meta.bands?.city?.levels?.L0 || 64;
  const l3Cells = () => (L3 ? L3.avail[l3Moment] || Object.entries(L3.avail).find(([m]) => !m.endsWith(XK))?.[1] || null : null);
  // a grid of cell values read bilinearly between the cells' centres (0 off the grid)
  const bilinear = (gx, gy, cols, rows, at) => {
    const x = gx - 0.5, y = gy - 0.5, i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const v = (a, b) => (a < 0 || b < 0 || a >= cols || b >= rows ? 0 : at(a, b));
    return (v(i, j) * (1 - fx) + v(i + 1, j) * fx) * (1 - fy) + (v(i, j + 1) * (1 - fx) + v(i + 1, j + 1) * fx) * fy;
  };
  function density(yaw, el) {
    let w3 = 0, n = 0;
    const cells = index && l3Cells();
    if (cells && el < (meta.bands?.city?.el?.[1] ?? 6)) {
      const g = index.grid, td = index.tile_deg;
      w3 = smooth01((bilinear((yaw - g.yaw0) / td, (g.el_top - el) / td, g.cols, g.rows, (i, j) => (cells.has(`${i},${j}`) ? 1 : 0)) - 0.5) / 0.5);
    }
    if (nearMap) {
      const N = nearMap;
      n = bilinear((yaw - N.yaw0) / N.deg, (N.el_top - el) / N.deg, N.cols, N.rows, (i, j) => N.cover[j * N.cols + i] / 255);
      // (DYS-13) where the moment's 4x square stands in for the near layer, the near layer's 88 px/deg doesn't hold the
      // zoom back there: the square's 256 does
      const ok = cells && nearOk?.[l3Moment];
      if (ok && n > 0) {
        const g = index.grid, td = index.tile_deg;
        const wo = smooth01((bilinear((yaw - g.yaw0) / td, (g.el_top - el) / td, g.cols, g.rows, (i, j) => (cells.has(`${i},${j}`) && ok.has(`${i},${j}`) ? 1 : 0)) - 0.5) / 0.5);
        n *= 1 - wo;
      }
    }
    const lc = (1 - w3) * Math.log(L0_PPD) + w3 * Math.log(index?.ppd || 256);
    return Math.exp((1 - n) * lc + n * Math.log(nearMap?.ppd || 88));
  }

  return {
    hooks,
    density,
    /** Whether the ceiling applies (QA can lift it: setDebug({ honest: false })). */
    honest: () => dbg.honest !== false,
    info: () => hooks.info(),
    /** Compile and draw the program once now (the view still: no stall when the zoom starts). */
    warm() { if (L3 && !warmed) { warmWanted = true; engine.requestFrame(); } },
    /** QA: { eye: a fixed parallax scale (null: by the magnification), l3: false switches L3 off, honest: false lifts the
     * ceiling (the cap alone) }. */
    setDebug(d) { Object.assign(dbg, d); engine.requestFrame(); },
    /** A zoom gesture at a point (canvas CSS px): its tiles lead the order for a moment; idle prefetch may begin. */
    gesture(at) {
      prefetchOn = true;
      if (!at || !rig.pose) return;
      const d = ray(rig.view || rig.pose, at.x, at.y, at.w, at.h).d;
      const [yaw, el] = yawEl(d);
      focus = { yaw, el, t: performance.now() };
      engine.requestFrame();
    },
  };
}
