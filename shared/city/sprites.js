// What each event looks like to a renderer: its renderer (points, sky dots, hull sprites, gulls), its size on screen,
// and, for hulls, which cells of the Blender-lit atlas (web/live/sprites: the ferry and the sailboat at 24 headings,
// each big ship's own model at the headings its json lists (25 since DYS-232), 0..180, drawn mirrored on the other
// side) to blend.
import { view, wrap360 } from "./geo.js";

const DEG = Math.PI / 180;

export const DESK_PX_PER_RAD = 1335;     // CSS px per radian in the 1440x900 desktop window (23.3 px/deg)
export const PHONE_SCALE = 0.5;          // phones show the view at about half that
export const PHONE_MIN_PX = 1.5;         // events under 1.5 desktop px are dropped on phones (plan 2.3; a street car's
                                         // size counts the magnification: outside-events.js keepCar, DYS-110)

// renderer and atlas type per event kind. len: the dimension that sets the on-screen size.
export const CLASSES = {
  car: { renderer: "points" }, heavy: { renderer: "points" },
  beacon: { renderer: "points" }, lighthouse: { renderer: "points" }, aid: { renderer: "points" },
  bridge_light: { renderer: "points" }, cable_light: { renderer: "points" }, lamp: { renderer: "points" },
  airliner: { renderer: "sky" }, light: { renderer: "sky" }, high: { renderer: "sky" },
  // the big ships: each type its own model (ships-r1); "ship" is the old atlas's one container ship, if that is what
  // was fetched
  container: { renderer: "hull", atlas: "container", old: "ship" }, tanker: { renderer: "hull", atlas: "tanker", old: "ship" },
  carcarrier: { renderer: "hull", atlas: "carcarrier", old: "ship" }, bulk: { renderer: "hull", atlas: "bulk", old: "ship" },
  tugbarge: { renderer: "hull", atlas: "tugbarge", old: "ship" }, cruise: { renderer: "hull", atlas: "cruise", old: "ship" },
  tour: { renderer: "hull", atlas: "ferry" }, ferry: { renderer: "hull", atlas: "ferry" }, sail: { renderer: "hull", atlas: "sail" },
  gull: { renderer: "gull" },
};
export const SPINNAKERS = [[0.86, 0.16, 0.14], [0.12, 0.3, 0.72], [0.95, 0.75, 0.15], [0.1, 0.55, 0.35], [0.95, 0.95, 0.95], [0.55, 0.15, 0.55]];
// (DYS-232 MOTION) a sailboat's hull paint, by a hash of the boat: [share, rgb]; most are white (MODELS' #e4e4df)
export const HULLS = [[0.70, [0.894, 0.894, 0.875]], [0.15, [0.12, 0.165, 0.267]], [0.05, [0.118, 0.231, 0.184]],
  [0.03, [0.478, 0.122, 0.122]], [0.04, [0.102, 0.102, 0.11]], [0.03, [0.541, 0.553, 0.565]]];
export const TRIMS = { red: [0.78, 0.12, 0.1], blue: [0.1, 0.22, 0.55] };

// size on a desktop screen in CSS px (the larger of length and height)
export function deskPx(it) {
  const d = it.view ? it.view.dist : view(it.x, it.y, it.z).dist;
  const m = Math.max(it.len || 0, it.span || 0, it.mast || 0, it.height || 0);
  return (DESK_PX_PER_RAD * m) / d;
}
export const keepOnPhone = (it) => deskPx(it) >= PHONE_MIN_PX;

// ---------------------------------------------------------------- how the boats move (DYS-232, MOTION)
// Everything here is a pure function of the city clock's T (s), a place on the water and a boat's own hashed numbers,
// so every visitor sees the same boat heel, pitch and turn at the same second. The events (events/sails.js,
// ferries.js, tours.js) put heading, heel, pitch and heave on each boat; hullSprite below turns them into what the hull
// program draws (HULL_VS aMotion: each cell's roll on the screen, the tilt's foreshortening, the heave).
//   heel   deg, + = starboard side down        pitch  deg, + = bow up        heave  m, + = up
export const KT = 0.514444;                    // m/s per knot
const G = 9.81;
export const MOTION = {
  // the Bay's wind chop (JONSWAP, fetch-limited: ~10 km of open water upwind of the Marina inside the Gate): its
  // significant height Hs and peak period Tp from the wind; three trains around the downwind direction
  fetch: 10000,
  chop: [[1.0, 0, 0.24, 0.7], [0.83, 25, 0.19, 2.9], [1.21, -30, 0.15, 5.3]],   // [period x Tp, deg off downwind, amplitude x Hs, phase]
  swell: { T: 12, to: 75, a: 0.08, ph: 1.1 },   // the ocean's long swell, much spent once inside the Gate (est.)
  // a 30-40 ft sloop's heel: close-hauled, by the true wind (kt); it reefs and eases above ~20 kt, so it levels off
  heelMax: 25, heelW0: 3, heelW1: 11,
  // the wind's puffs: +-14 % on three slow periods, carried downwind at `puff` m/s (the fleet feels a puff in turn)
  gust: 0.14, gustT: [31, 53, 19], puff: 4,
  // how much each kind follows the water's slope: heave, pitch, roll (a sloop's roll is damped by its sails; on a run
  // it rolls more, in its own period); its waterline as a share of its length
  resp: { sail: [0.9, 1.0, 0.7], ferry: [0.6, 0.8, 0.4], tour: [0.7, 0.9, 0.5] },
  wl: { sail: 0.85, ferry: 0.9, tour: 0.9 },
  runRoll: [1.5, 0.12], rollT: 3.2,             // deg: a + b x wind (kt) of rolling before the wind, in about 3.2 s
  squat: { ferry: 0.8, tour: 0.5 },             // deg bow up at cruising speed (as the square of the speed)
};

// the sea for a wind of `windKt` knots: { hs (m), tp (s) } of the chop. Its period comes from `periodKt`, a wind held
// for the whole day (the events pass the day's afternoon wind, seaDay): the waves' phase is w T with T ~ 1.8e9 s, so a
// period that followed the passing wind would sweep thousands of radians a second (noise); the height follows the wind
export function seaState(windKt, periodKt = windKt) {
  const U = Math.max(0.5, windKt * KT), Up = Math.max(0.5, periodKt * KT);
  const hs = Math.max(0.05, 0.0016 * U * Math.sqrt(MOTION.fetch / G));
  const tp = Math.max(1.3, 0.286 * Math.cbrt((G * MOTION.fetch) / (Up * Up)) * Up / G);
  return { hs, tp, windKt };
}
// the day's wind for the waves' period: the open water's at 15:00 (clock.js wind's blocks; `wind` passed in)
export const seaDay = (wind, c) => wind({ doy: c.doy, hour: 15 }).open;

// the water's height (m) at (x, y) east / north metres at time T, the chop running toward `toDeg` (where the wind blows)
export function waveAt(T, x, y, sea, toDeg) {
  let eta = 0;
  for (const [tk, off, ak, ph] of MOTION.chop) {
    const per = sea.tp * tk, w = (2 * Math.PI) / per, k = (w * w) / G, d = (toDeg + off) * DEG;
    eta += ak * sea.hs * Math.cos(k * (x * Math.sin(d) + y * Math.cos(d)) - w * T + ph);
  }
  const S = MOTION.swell, w = (2 * Math.PI) / S.T, k = (w * w) / G, d = S.to * DEG;
  return eta + S.a * Math.cos(k * (x * Math.sin(d) + y * Math.cos(d)) - w * T + S.ph);
}

// a hull on that water: heave (m), pitch and roll (deg) from the water's height under its bow, stern and sides
export function waveMotion(T, x, y, heading, len, beam, sea, toDeg, kind) {
  const [kh, kp, kr] = MOTION.resp[kind] || MOTION.resp.tour;
  const L = len * (MOTION.wl[kind] || 0.9), B = Math.max(1, beam);
  const fx = Math.sin(heading * DEG), fy = Math.cos(heading * DEG);      // forward
  const rx = fy, ry = -fx;                                                // starboard
  const eb = waveAt(T, x + fx * L / 2, y + fy * L / 2, sea, toDeg), es = waveAt(T, x - fx * L / 2, y - fy * L / 2, sea, toDeg);
  const et = waveAt(T, x + rx * B / 2, y + ry * B / 2, sea, toDeg), ep = waveAt(T, x - rx * B / 2, y - ry * B / 2, sea, toDeg);
  const ec = waveAt(T, x, y, sea, toDeg);
  return {
    heave: kh * (eb + es + et + ep + 2 * ec) / 6,
    pitch: kp * Math.atan2(eb - es, L) / DEG,
    roll: kr * Math.atan2(ep - et, B) / DEG,
  };
}

// the wind's strength at (x, y) and T as a factor on its mean (the puffs move downwind across the water)
export function gustAt(T, x, y, windKt, fromDeg) {
  const to = (fromDeg + 180) * DEG;
  const along = x * Math.sin(to) + y * Math.cos(to), across = x * Math.cos(to) - y * Math.sin(to);
  const t = T - along / MOTION.puff;   // (a fixed speed: one that followed the wind would slide the puffs' phase)
  const [a, b, c] = MOTION.gustT, P = 2 * Math.PI;
  const g = 0.55 * Math.sin((P * t) / a + 1.3 + (P * across) / 900) + 0.35 * Math.sin((P * t) / b + 4.1 - (P * across) / 1400)
    + 0.25 * Math.sin((P * t) / c + 2.2 + (P * across) / 600);
  return 1 + (MOTION.gust * g) / 1.15;
}

// a sloop's steady heel (deg, to leeward) on a true wind angle `twa` (deg, 0 head to wind .. 180 dead downwind) in a
// true wind of `windKt`: most close-hauled, a little less on a beam reach, little running, none head to wind (luffing)
export function heelFor(twa, windKt) {
  const w = Math.max(0, windKt - MOTION.heelW0) / MOTION.heelW1;
  const full = MOTION.heelMax * Math.tanh(Math.pow(w, 1.5));
  const a = Math.abs(twa);
  const luff = smoothstep(20, 38, a);
  const point = a <= 50 ? 1 : 0.08 + 0.92 * (1 + Math.cos((Math.PI * (a - 50)) / 130)) / 2;
  return full * luff * point;
}
// the sails' trim by the true wind angle: { beat, reach, run } weights summing to 1 (the atlas's sail_beat / _reach /
// _run pictures, crossfaded as the boat turns)
export function trimOf(twa) {
  const a = Math.abs(twa);
  const beat = 1 - smoothstep(52, 68, a), run = smoothstep(130, 146, a);
  return { beat, reach: Math.max(0, 1 - beat - run), run };
}
function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
// the inverse of smoothstep on 0..1 (the share of a turn's time at which its heading has gone a share y of the way)
export const invSmooth = (y) => 0.5 - Math.sin(Math.asin(1 - 2 * Math.min(1, Math.max(0, y))) / 3);

// the screen's view of a heel and a pitch for a picture seen at `yaw` (deg: 0 going away, 90 moving right), less the
// heel already in the picture (`baked`, deg, + starboard): [roll on the screen (rad, + counter-clockwise), the tilt's
// vertical scale - 1]. Heel shows as a roll bow-on or stern-on and as a shorter mast broadside; pitch the other way.
export function screenTilt(yaw, heel, pitch, baked = 0) {
  const s = Math.sin(yaw * DEG), c = Math.cos(yaw * DEG), h = heel - baked;
  return [(-h * c + pitch * s) * DEG, Math.cos((h * s + pitch * c) * DEG) - 1];
}

// ---------------------------------------------------------------- which headings (DYS-232, the big ships)
// The big ships' atlas types (ships-r1) and the old atlas's one ship. Their pictures cross-fade only over the middle
// SHIP_BLEND of each step between two rendered headings (a type's own `blend_core` in the atlas json overrides it): the
// rest of the step one picture holds, stretched to the heading's silhouette (warp), so a ship is one crisp picture
// nearly always and the two deckhouses of a 50/50 blend show only briefly, mid-step. Every other type (the ferry, the
// tour boats, the sailboats) blends across the whole step, as before.
export const SHIP_TYPES = ["container", "tanker", "carcarrier", "bulk", "tugbarge", "cruise"];
const SHIP_KEYS = new Set([...SHIP_TYPES, "ship"]);
export const SHIP_BLEND = 0.3;
// ?shipsfx=0: the big ships as before DYS-232 (a cross-fade across the whole step; no motion: events/ships.js; no sharp
// set: outside.js), to compare
const SHIPS_FX = typeof location === "undefined" || new URLSearchParams(location.search || "").get("shipsfx") !== "0";
export const blendCore = (t, key) => t.blend_core ?? (SHIPS_FX && SHIP_KEYS.has(key) ? SHIP_BLEND : 1);
// a type's headings evenly spaced (0..180 mirrored: 180 / (n - 1) apart; all round: 360 / n)? that step, else 0 (then
// each pick looks the heading up in the list); worked out once per list
const evenSteps = new WeakMap();
function evenStep(yaws, mirror) {
  let s = evenSteps.get(yaws);
  if (s === undefined) {
    const n = yaws.length, st = mirror ? 180 / (n - 1) : 360 / n;
    s = yaws.every((y, i) => Math.abs(y - i * st) < 1e-6) ? st : 0;
    evenSteps.set(yaws, s);
  }
  return s;
}
const smooth01 = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/**
 * The two cells of type t (an atlas json type: yaws or the atlas's `atlasYaws`, mirror, length, beam) either side of
 * `yaw` (deg: 0 going away, 90 moving right), for any number of headings, evenly spaced or not:
 *   i0, i1   the cells (i1 = i0 at the last of a mirrored type's)
 *   w        cell1's weight, cross-fading over the middle `core` of the step (1: the whole step, linear, as before)
 *   k0, k1   each cell stretched across the line of sight to this heading's silhouette (L x B seen at yaw spans
 *            |L sin yaw| + |B cos yaw|)
 *   mirror   a mirrored type past 180: the picture at 360 - yaw, flipped
 * Into `out` (no new object: the 2D layer calls it per boat per frame).
 */
export function pickHeading(t, atlasYaws, yaw, core = 1, out = {}) {
  const yaws = t.yaws || atlasYaws, n = yaws.length;
  let mirror = false;
  yaw = wrap360(yaw);
  if (t.mirror && yaw > 180) { mirror = true; yaw = 360 - yaw; }
  const step = evenStep(yaws, !!t.mirror);
  let i0, i1, w;
  if (step) {
    // (evenly spaced: the very arithmetic of before)
    const f = yaw / step;
    i0 = Math.floor(f); w = f - i0;
    if (t.mirror) { i0 = Math.min(i0, n - 1); i1 = Math.min(i0 + 1, n - 1); if (i0 === n - 1) w = 0; }
    else { i0 %= n; i1 = (i0 + 1) % n; }
  } else {
    // (any spacing: the last heading at or before this one)
    let lo = 0, hi = n - 1;
    if (yaw < yaws[0]) lo = t.mirror ? 0 : n - 1;
    else { while (lo < hi) { const m = (lo + hi + 1) >> 1; if (yaws[m] <= yaw) lo = m; else hi = m - 1; } }
    i0 = lo;
    if (t.mirror) { i1 = Math.min(i0 + 1, n - 1); w = i1 === i0 ? 0 : clamp01((yaw - yaws[i0]) / (yaws[i1] - yaws[i0])); }
    else { i1 = (i0 + 1) % n; const gap = wrap360(yaws[i1] - yaws[i0]) || 360; w = clamp01(wrap360(yaw - yaws[i0]) / gap); }
  }
  if (core < 1 && w > 0 && w < 1) w = core > 0 ? smooth01((w - (1 - core) / 2) / core) : w < 0.5 ? 0 : 1;
  let k0 = 1, k1 = 1;
  if (t.length && t.beam) {
    const s = span(t, yaw);
    k0 = s / span(t, yaws[i0]); k1 = s / span(t, yaws[i1]);
  }
  out.i0 = i0; out.i1 = i1; out.w = w; out.k0 = k0; out.k1 = k1; out.mirror = mirror;
  return out;
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const AXIS_BAND = 1.5;
// within AXIS_BAND of end-on? [toward us (the 180 cell), the mirrored picture's weight 0..1], else null
function axisBand(yaw) {
  const y = wrap360(yaw);
  const off0 = y > 180 ? y - 360 : y, off180 = y - 180;   // (-180..180 from going away; from toward us)
  if (Math.abs(off0) < AXIS_BAND) return [false, smooth01((AXIS_BAND - off0) / (2 * AXIS_BAND))];
  if (Math.abs(off180) < AXIS_BAND) return [true, smooth01((off180 + AXIS_BAND) / (2 * AXIS_BAND))];
  return null;
}
const span = (t, a) => Math.abs(Math.sin(a * DEG)) * t.length + Math.abs(Math.cos(a * DEG)) * t.beam;
// The atlas cells for a hull (boats.json: yaws in degrees, 0 = sailing away, 90 = moving right), the blend between
// the two nearest headings, and the scale from the atlas model to this vessel at this distance for a canvas
// `canvasPx` px per radian.
//   mirror  a ship type's cells cover 0..180 (its starboard side and the views fore and aft); 180..360 is the same
//           picture mirrored (the port side): the shader flips it and its normals
//   warp    each of the two cells stretched across the line of sight to this heading's silhouette (a ship L x B seen
//           at yaw a spans |L sin a| + |B cos a|), so the deckhouse, the funnel and the bow line up; and (DYS-232) the
//           ships' crossfade narrowed to the middle of a step (pickHeading, SHIP_BLEND), so they seldom show twice
// (DYS-232 MOTION) and for the small boats that move on the water (it.heel / pitch / heave from the events; and the big
// ships' slow heave, pitch and roll, events/ships.js shipSway, not cut at the waterline):
//   motion  [cell0's roll, cell1's roll (rad on the screen, + counter-clockwise about the waterline centre), the tilt's
//           vertical scale - 1, heave (atlas px, + up)]: HULL_VS aMotion
//   swap    cell1 is the other side's picture (mirrored against cell0): a sailboat's boom crossing on a tack or a gybe,
//           crossfaded through the cells' blend (nearest heading of each) instead of a jump
//   clip    hide what the roll and the heave put below the waterline (and the reflection's above it)
//   the picture: a sailboat's by its trim (it.trim: sail_beat / sail_reach / sail_run / sail_bare when the atlas has
//   them, else "sail") and its sails' side (it.sideW -1..1, the sails to port .. starboard); a tour boat's its fleet's
//   (tour_rw / tour_bg when there, else the ferry's). Two pictures crossfade in one instance through the cells' blend,
//   each at the change's own heading's nearest cell (it.snapYaw); it.snap (0..1, events/sails.js) eases the heading
//   blend onto that cell beforehand and off it after
function cellsAt(t, atlas, yaw, key) {
  return pickHeading(t, atlas.yaws, yaw, key === undefined ? 1 : blendCore(t, key), {});
}
// a picture of type t seen at yaw with its sails to `side` (+1 starboard as rendered, -1 port: the mirror image of the
// starboard picture at -yaw; a type without sails is the same either side)
function pictureAt(t, atlas, yaw, side, key) {
  const c = cellsAt(t, atlas, side < 0 ? -yaw : yaw, key);
  if (side < 0) c.mirror = !c.mirror;
  return c;
}
const TRIMS_ORDER = ["beat", "reach", "run", "bare"];
// can two types be crossfaded in one instance (the same anchor row and the same atlas px per metre of the model)?
// (the sharp ship set's json may carry no `models`: then the type's own length, which is what the 1x atlas's models are)
const modelOf = (atlas, key, base) => atlas.models?.[key] ?? atlas.models?.[base] ?? atlas.types[key]?.length;
const fits = (atlas, a, b) => a === b || (atlas.types[a].anchor === atlas.types[b].anchor && atlas.types[a].px_per_m === atlas.types[b].px_per_m
  && modelOf(atlas, a, "sail") === modelOf(atlas, b, "sail"));
export function hullSprite(it, atlas, canvasPx) {
  const cls = CLASSES[it.kind];
  if (!cls || cls.renderer !== "hull" || !atlas) return null;
  const T = atlas.types;
  let key = T[cls.atlas] ? cls.atlas : cls.old;
  if (!key || !T[key]) return null;
  const v = it.view || view(it.x, it.y, it.z);
  const yaw = wrap360(it.heading - v.bearing);
  const sailing = key === "sail";
  if (it.kind === "tour" && it.fleet && T[`tour_${it.fleet}`]) key = `tour_${it.fleet}`;
  // the pictures: the main one (key, side) and, while a crossfade is on, a second (key2, side2) of weight m
  let side = 1, key2 = null, side2 = 1, m = 0;
  if (sailing) {
    const sw = it.sideW ?? it.side ?? 1, plus = (1 + Math.max(-1, Math.min(1, sw))) / 2;
    side = plus >= 0.5 ? 1 : -1;
    const tw = it.trim || null;
    // the boat's own rig's picture (MODELS: j105_* the racer, c34_* the cruiser), else a generic sail_*, else "sail"
    const kOf = (name) => (it.rig && T[`${it.rig}_${name}`] ? `${it.rig}_${name}` : T[`sail_${name}`] ? `sail_${name}` : "sail");
    let t1 = "beat", t2 = null;
    if (tw) {
      const order = TRIMS_ORDER.filter((n) => (tw[n] || 0) > 0).sort((a, b) => tw[b] - tw[a]);
      t1 = order[0] || "beat"; t2 = order[1] || null;
    }
    key = kOf(t1);
    const hasSails = !key.endsWith("_bare");   // (E: every sails-down type, j105_bare and c34_bare too; MODELS 21:0x)
    const mSide = Math.min(plus, 1 - plus);
    if (hasSails && mSide > 0.02) { key2 = key; side2 = -side; m = mSide; }
    else if (t2 && kOf(t2) !== key && fits(atlas, key, kOf(t2))) {
      const w2 = tw[t2] / (tw[t1] + tw[t2]);
      if (w2 > 0.02) { key2 = kOf(t2); side2 = side; m = w2; }
    }
  }
  const t = T[key], model = modelOf(atlas, key, cls.atlas);
  const c0 = pictureAt(t, atlas, yaw, side, key);
  // round a change of picture the cells hold still at the change's own heading as seen (it.snapYaw, fixed per change;
  // the boat turns slowly meanwhile, events/sails.js): the nearest cell there, eased onto by it.snap
  const snap = it.snap || 0, yawS = snap > 0 && it.snapYaw != null ? it.snapYaw : yaw;
  let cell0, cell1, k0, k1, blend, mirror = c0.mirror, swap = false, t2 = t, ix0 = c0.i0, ix1 = c0.i1;
  if (key2) {
    t2 = T[key2];
    const s0 = pictureAt(t, atlas, yawS, side), c1 = pictureAt(t2, atlas, yawS, side2);
    const n0 = s0.w < 0.5, n1 = c1.w < 0.5;
    ix0 = n0 ? s0.i0 : s0.i1; ix1 = n1 ? c1.i0 : c1.i1;
    cell0 = t.cells[ix0]; k0 = n0 ? s0.k0 : s0.k1;
    cell1 = t2.cells[ix1]; k1 = n1 ? c1.k0 : c1.k1;
    blend = m; mirror = s0.mirror; swap = c1.mirror !== s0.mirror;
  } else {
    cell0 = t.cells?.[c0.i0]; cell1 = t.cells?.[c0.i1]; k0 = c0.k0; k1 = c0.k1;
    blend = c0.w;
    if (snap > 0) {
      const s0 = pictureAt(t, atlas, yawS, side), at = s0.w < 0.5 ? s0.i0 : s0.i1;
      const target = at === c0.i1 && s0.mirror === c0.mirror ? 1 : at === c0.i0 && s0.mirror === c0.mirror ? 0 : Math.round(c0.w);
      blend += (target - blend) * snap;
    }
    // (DYS-232) a ship end-on: its end cell (0 going away, 180 toward us) and the same cell mirrored cross-faded over
    // AXIS_BAND deg either side of the line of sight, where the mirror would flip at once (a ship's two sides differ:
    // its containers' colours, a lifeboat, a crane), the mirrored picture as cell1 (swap)
    const ax = SHIPS_FX && t.mirror && SHIP_KEYS.has(key) ? axisBand(yaw) : null;
    if (ax) {
      const ys = t.yaws || atlas.yaws, e = ax[0] ? ys.length - 1 : 0, yE = ys[e];
      cell0 = cell1 = t.cells?.[e]; ix0 = ix1 = e; mirror = false; swap = true; blend = ax[1];
      k0 = k1 = t.length && t.beam ? span(t, wrap360(yaw) > 180 ? 360 - wrap360(yaw) : wrap360(yaw)) / span(t, yE) : 1;
    }
  }
  // (the old "sail" model is sized by its mast; every other, the sail rigs too, by its length overall)
  const lenM = key === "sail" ? it.mast : it.len;
  const scale = ((canvasPx / v.dist) * (lenM / model)) / t.px_per_m;   // screen px per atlas px (as boats.js)
  let motion = null;
  if (it.heel !== undefined || it.pitch !== undefined || it.heave !== undefined) {
    const heel = it.heel || 0, pitch = it.pitch || 0;
    const baked = (tt, sd) => (tt.heel_deg || 0) * sd;
    const [r0, sq] = screenTilt(yaw, heel, pitch, baked(t, side));
    const [r1] = key2 ? screenTilt(yaw, heel, pitch, baked(t2, side2)) : [r0];
    motion = [r0, r1, sq, (it.heave || 0) * t.px_per_m * model / lenM];
  }
  // a sailboat's paint: its hull's colour (it.livery), or on a picture flying a kite (t.kite: the j105's run) the
  // spinnaker's; scaled when the atlas bakes that paint at its own grey (t.paint_base) rather than livery_base
  let livery = null;
  if (sailing && (it.livery || it.spinColour !== undefined)) {
    const kite = t.kite ?? /^j105_run$/.test(key);
    const c = kite && it.spinColour !== undefined ? SPINNAKERS[it.spinColour % SPINNAKERS.length] : it.livery || null;
    const k = (atlas.livery_base || 0.702) / (t.paint_base || atlas.livery_base || 0.702);
    if (c) livery = [c[0] * k, c[1] * k, c[2] * k];
  }
  // (DYS-232: a big ship heaves, pitches and rolls a little (events/ships.js) but is not cut at the waterline: its
  // picture reaches below the centre's waterline where the nearer end's waterline is seen, bow- or stern-on)
  // ix: the two cells' numbers (the sharp ship set, ship-detail.js, fetches its pictures by them)
  return { type: key, t, cell0, cell1, size: t.cell, size1: t2.cell, blend, anchor: t.anchor, scale, mirror,
    warp: [k0, k1], model, lenScale: lenM / model, motion, swap, clip: !!motion && !SHIP_KEYS.has(key), livery, ix: [ix0, ix1] };
}

// v3/street-traffic: a street vehicle from the cars atlas (web/live/sprites/cars.json, scripts/street_car_atlas.py), in
// the hull program's terms (HULL_FS): its model by a hash of its id (heavy: the bus or the van; bikes: the Lyft bike),
// the heading cell (the ships' convention: 0 driving away, 180 toward us; 195..345 mirrored), drawn at true size
// (the atlas's px_per_m), its paint from CAR_PAINT by the hash (fixed liveries keep their own: livery = livery_base)
const CAR_MODELS = ["prius", "model3", "modely", "crv", "tacoma", "prius", "model3", "modely", "crv"];
const HEAVY_MODELS = ["muni", "transit"];
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
export function carSprite(it, atlas, canvasPx, paints) {
  if (!atlas) return null;
  const h = hash32(String(it.id));
  const pool = it.kind === "bike" ? ["lyft_classic"] : it.kind === "heavy" ? HEAVY_MODELS : CAR_MODELS;
  const key = pool[h % pool.length];
  const t = atlas.types[key];
  if (!t) return null;
  const yaws = t.yaws, n = yaws.length;
  const v = it.view || view(it.x, it.y, it.z);
  let yaw = wrap360(it.heading - v.bearing), mirror = false;
  if (yaw > 180) { mirror = true; yaw = 360 - yaw; }
  const step = 180 / (n - 1), f = yaw / step;
  let i0 = Math.min(Math.floor(f), n - 1), w = f - i0;
  const i1 = Math.min(i0 + 1, n - 1);
  if (i0 === n - 1) w = 0;
  let livery = [atlas.livery_base, atlas.livery_base, atlas.livery_base];
  if (!t.fixed && paints && paints.length) {
    let r = ((h >>> 8) % 1000) / 1000;
    for (const [share, rgb] of paints) { if (r < share) { livery = rgb; break; } r -= share; livery = rgb; }
  }
  const scale = (canvasPx / v.dist) / t.px_per_m;
  return { type: key, t, cell0: t.cells[i0], cell1: t.cells[i1], size: t.cell, blend: w, anchor: t.anchor, scale, mirror,
    warp: [1, 1], livery };
}
