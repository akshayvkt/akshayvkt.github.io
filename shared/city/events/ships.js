// Events 4 and 4b: container ships, tankers and the rest on 20-minute cycles, and the real 2026 cruise calendar.
//
// Cycle c (UTC-aligned, 20 min) carries a ship when hash(c) < 0.21 (15.1 bar crossings a day). Its direction, type,
// length and the minute it passes under midspan are hashed once for the cycle, so a ship in the channel never
// vanishes at a boundary. 12 knots along the channel: in from the pilot station 25 km out (bow-on on the horizon for
// about an hour), under midspan, east along the city front and out of view past 315 deg; outbound the reverse.
// Cruise ships pass under the bridge 45-60 min before their scheduled arrival and 40 min after departure.
import { SHIPS, CRUISE_2026, CRUISE_YEAR, CRUISE_LENGTH, CRUISE, CRUISE_HULL, CRUISE_WHITE } from "../tables.js";
import { sfToT, dayFromDate } from "../clock.js";
import { u01, hash, SEED } from "../hash.js";
import { polyline, navLights, local, view } from "../geo.js";
// a cruise ship's deck lights: warm-white LED (the shaders' flood colour mixes sodium 0 .. cool LED 1; its lamp points
// count as LED above 0.5): with cool LED on its white superstructure the ship read grey at night
const CRUISE_LED = 0.65;

const KN = 0.514444;

// ---------------- how a big ship moves on the water (DYS-232): barely, but not none
// A big ship rides the long swell that comes in through the Gate, not the Bay's wind chop (a few metres to tens of
// metres from crest to crest under a hull of 130-350 m: it averages out). So a slow heave, pitch and a little roll,
// their periods 8-14 s and their sizes by the ship's length (the longer, the slower and the less: the tug and barge
// 0.6 m, 0.3 deg; the biggest container ship 0.2 m, 0.1 deg), each the sum of two swells whose periods never line up
// (0.77 apart), under the swell's own slow sets (0.8-1.0 over ~90 s): never periodic to the eye, never past its size.
// A pure function of the city clock's T (s) and the ship's own hashed phases: every visitor sees the same ship lift at
// the same second. At 4x on a 2x screen, at the closest pass (2.6 km, ~4.4 device px a metre) the bow of a 350 m ship
// rises and falls ~2 px, the tug's ~4 px: it moves on the water rather than sliding like a cut-out.
//   heave m (+ up); pitch deg (+ bow up); roll as sprites.js's heel, deg (+ starboard down)
export const SWAY = {
  len: [134, 350],          // m: the tug and barge .. the biggest container ship (shorter or longer: held at the ends)
  period: [8, 14],          // s: heave and pitch's main swell (roll's a little longer, within the same range)
  heave: [0.6, 0.2],        // m, its amplitude
  pitch: [0.3, 0.1],        // deg
  roll: [0.35, 0.12],       // deg (the cruise ship's fin stabilisers: CRUISE_ROLL of it)
  mix: [0.65, 0.35],        // the two swells' shares (their sum's peak is at most 1)
  ratio: 0.77,              // the second swell's period against the first's
  set: [93, 0.2],           // the sets: their period (s), their depth
};
const CRUISE_ROLL = 0.6;
// ?shipsfx=0: still, as before DYS-232 (sprites.js SHIPS_FX)
const SHIPS_FX = typeof location === "undefined" || new URLSearchParams(location.search || "").get("shipsfx") !== "0";
const TAU = 2 * Math.PI;
// the sum of the two swells at T for a main period `per` and a phase (turns)
const swells = (T, per, ph) => SWAY.mix[0] * Math.sin((TAU * T) / per + TAU * ph)
  + SWAY.mix[1] * Math.sin((TAU * T) / (per * SWAY.ratio) + TAU * ph * 1.7 + 2.1);
const lerpBy = (r, f) => r[0] + (r[1] - r[0]) * f;
/**
 * A big ship's motion at clock T (s): its length (m) and its own hash (seed, key: the phases are hash(seed, key, 8)'s
 * four bytes), into `out` (out.heave m, out.pitch deg, out.heel deg: what sprites.js hullSprite draws as the
 * hull's heave, tilt and roll); `roll` scales the roll. No new object or closure; |heave|, |pitch|, |heel| never past
 * SWAY's amplitudes for its length.
 */
export function shipSway(T, len, seed, key, out, roll = 1) {
  const f = Math.min(1, Math.max(0, (len - SWAY.len[0]) / (SWAY.len[1] - SWAY.len[0])));
  const P = lerpBy(SWAY.period, f), Pr = Math.min(SWAY.period[1], P * 1.12);
  const h = hash(seed, key, 8);   // (one 32-bit hash, its four bytes the four phases: one number a call, no more)
  const u0 = (h & 255) / 256, u1 = ((h >>> 8) & 255) / 256, u2 = ((h >>> 16) & 255) / 256, u3 = (h >>> 24) / 256;
  const sets = 1 - SWAY.set[1] * 0.5 * (1 + Math.sin((TAU * T) / SWAY.set[0] + TAU * u0));
  // (the pitch a quarter-swell or so off the heave, as a hull's bow meets a crest before its middle does)
  out.heave = lerpBy(SWAY.heave, f) * sets * swells(T, P, u1);
  out.pitch = lerpBy(SWAY.pitch, f) * sets * swells(T, P, u1 + 0.25 + 0.1 * u2);
  out.heel = lerpBy(SWAY.roll, f) * roll * sets * swells(T, Pr, u3);
  return out;
}

// ---------------- a big ship's wake in the boats' model (DYS-232; ?shipwake=1 until E takes the shader's side of it:
// scratch/D/ships/ship-wakes.patch). E's WATER rebuilt the boats' wakes (gl/wakes.glsl.js boatWake: the V along the
// boat's own past path, white water near the hull, the bow's curls, a long slick lane) and left the ships as they were.
// A ship takes the same model with its own numbers (shipWake) and, as the boats' events do, where it was: it.trail
// (its centre 1.5, 2.75, 4, 8 and 12 of its lengths back along its own route, newest first, [x, y, s ago]: the wake's
// three points are the first, third and fifth) and it.odo (m along its route: the foam's grain stays put in the water)
// (with E's side in: on by default, ?shipwake=0 the ships' wakes and reflections as before)
export const SHIP_WAKE = typeof location === "undefined" || new URLSearchParams(location.search || "").get("shipwake") !== "0";
export const WAKE_BACK = [1.5, 2.75, 4, 8, 12];
const G = 9.81;
/**
 * The boats' wake model's numbers for a big ship of length len (m) at v (m/s), into out: its Froude number fn
 * (v / sqrt(g L): a ship 0.10-0.17, a fast ferry or tour boat 0.3-0.5: what sets how much white water a hull makes);
 * white, the white water's strength 0.05..1 (the shader's `str` for a boat, there from its speed: a 350 m container ship
 * at 12 kn ~0.2, the tug and barge ~0.55); bow, the white water at its stem and the bow's curls (~0.2-0.4); dMax (m),
 * how far back the slick lane and the arms reach (about 8 min of its travel, 0.6-3 km)
 */
export function shipWake(len, v, out = {}) {
  const fn = v / Math.sqrt(G * Math.max(len, 1));
  out.fn = fn;
  out.white = Math.min(1, Math.max(0.05, (fn - 0.07) / 0.18));
  out.bow = Math.min(0.8, Math.max(0.1, 0.15 + 2.5 * (fn - 0.08)));
  out.dMax = Math.min(3000, Math.max(600, v * 480));
  return out;
}
// where a ship on `line` at s was d m back (straight on back past the route's start), at speed v: [x, y, s ago]
function backAlong(line, s, d, v) {
  if (s - d >= 0) { const q = line.at(s - d); return [q.x, q.y, d / Math.max(v, 0.1)]; }
  const a = line.at(0), b = line.at(Math.min(line.L, 100)), dx = a.x - b.x, dy = a.y - b.y, n = Math.hypot(dx, dy) || 1, o = d - s;
  return [a.x + (dx / n) * o, a.y + (dy / n) * o, d / Math.max(v, 0.1)];
}
function wakeTrail(it, line, s, v) {
  it.trail = WAKE_BACK.map((k) => backAlong(line, s, k * it.len, v));
  it.odo = s;
}
const hexRGB = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
// a hull colour from the type's liveries (weights), by a uniform
function livery(type, u) {
  const L = SHIPS.livery[type];
  if (!L) return null;
  const tot = L.reduce((a, x) => a + x[1], 0);
  let r = u * tot;
  for (const [hex, w] of L) { r -= w; if (r <= 0) return hexRGB(hex); }
  return hexRGB(L[L.length - 1][0]);
}

export function createShips(routes, frame) {
  const R = {};
  for (const k of ["in", "out", "cruise_in", "cruise_out"]) R[k] = { line: polyline(routes.ships[k]), mid: routes.ships.mid_s[k] };
  const v = SHIPS.knots * KN;
  const before = Math.max(R.in.mid, R.out.mid) / v, after = Math.max(R.in.line.L - R.in.mid, R.out.line.L - R.out.mid) / v;

  function typeOf(u) {
    for (const t of SHIPS.types) if (u < t[1]) return t;
    return SHIPS.types[SHIPS.types.length - 1];
  }

  // night lights of a vessel: [along (fraction of length), right (fraction of beam), up (fraction of height), kind]
  // (the outside renderer places them on the sprite model's own rig when it has one: each light carries its kind)
  const RIG = [[0.35, 0, 0.62, "mast1"], [-0.22, 0, 1.0, "mast2"], [-0.2, 0.5, 0.66, "green"], [-0.2, -0.5, 0.66, "red"],
    [-0.5, 0, 0.3, "stern"]];
  function lights(it) {
    const nav = navLights(it.x, it.y, it.heading);
    const out = [];
    for (const [a, r, u, k] of RIG) {
      const lv = k === "green" ? nav.green : k === "red" ? nav.red : k === "stern" ? nav.stern : nav.masthead;
      if (!lv) continue;
      if (k === "mast1" && it.len < 50) continue;
      const [x, y, z] = local(it.x, it.y, it.z, it.heading, a * it.len, r * it.beam, u * it.height);
      out.push({ x, y, z, kind: k, colour: k === "green" ? "green" : k === "red" ? "red" : "white", level: 1 });
    }
    return out;
  }

  function horn(it, T, c, key) {
    if (c.fog <= 0.35) return 0;
    const ph = u01(SEED.horn, key, 1) * SHIPS.hornEvery;
    const len = SHIPS.hornLen[0] + (SHIPS.hornLen[1] - SHIPS.hornLen[0]) * u01(SEED.horn, key, 2);
    return (((T + ph) % SHIPS.hornEvery) + SHIPS.hornEvery) % SHIPS.hornEvery < len ? 1 : 0;
  }

  function cargo(T, c) {
    const out = [];
    const C = SHIPS.cycle;
    const c0 = Math.floor((T - after - SHIPS.window) / C) - 1, c1 = Math.floor((T + before) / C) + 1;
    for (let k = c0; k <= c1; k++) {
      if (u01(SEED.ship, k, 1) >= SHIPS.p) continue;
      const inbound = u01(SEED.ship, k, 2) < 0.5;
      const tm = k * C + u01(SEED.ship, k, 3) * SHIPS.window;
      const r = inbound ? R.in : R.out;
      const s = r.mid + v * (T - tm);
      if (s < 0 || s > r.line.L) continue;
      const ty = typeOf(u01(SEED.ship, k, 4));
      const len = ty[2] + (ty[3] - ty[2]) * u01(SEED.ship, k, 5);
      const p = r.line.at(s, 350);
      const it = {
        id: `s${k}`, kind: ty[0], cls: "ship", dir: inbound ? "in" : "out", x: p.x, y: p.y, z: frame.z(p.x, p.y, 0),
        heading: p.heading, speed: v, len, beam: ty[4], height: ty[5], tPass: tm,
        alpha: Math.min(1, s / 800, (r.line.L - s) / 800),
        livery: livery(ty[0], u01(SEED.ship, k, 6)), led: u01(SEED.ship, k, 7) < SHIPS.ledShare ? 1 : 0,
      };
      if (SHIPS_FX) shipSway(T, len, SEED.ship, k, it);
      if (SHIP_WAKE) wakeTrail(it, r.line, s, v);
      it.lights = lights(it);
      it.horn = horn(it, T, c, k);
      it.view = view(it.x, it.y, it.z);
      out.push(it);
    }
    return out;
  }

  // ---------------- cruise ships
  const calls = CRUISE_2026.map(([vessel, arr, dep, berth], i) => {
    const t = (s) => sfToT(dayFromDate(CRUISE_YEAR, +s.slice(0, 2), +s.slice(2, 4)), +s.slice(5, 7) * 3600 + +s.slice(8, 10) * 60);
    const ta = t(arr), td = t(dep);
    const early = CRUISE.arriveBefore[0] + (CRUISE.arriveBefore[1] - CRUISE.arriveBefore[0]) * u01(SEED.cruise, i, 1);
    return { i, vessel, berth, ta, td, inMid: ta - early * 60, outMid: td + CRUISE.departAfter * 60,
      len: CRUISE_LENGTH[vessel] || 290 };
  });
  const vOut = CRUISE.knotsOutside * KN, vIn = CRUISE.knotsInside * KN;
  // arc length along a cruise route at T for a ship at midspan at tm (12 kn outside the Gate, 10 kn inside)
  function cruiseS(r, tm, T, inbound) {
    const dt = T - tm;
    const outside = inbound ? dt < 0 : dt > 0;
    return r.mid + dt * (outside ? vOut : vIn);
  }
  function cruise(T, c) {
    const out = [];
    for (const call of calls) {
      for (const inbound of [true, false]) {
        const r = inbound ? R.cruise_in : R.cruise_out, tm = inbound ? call.inMid : call.outMid;
        if (Math.abs(T - tm) > 4 * 3600) continue;
        const s = cruiseS(r, tm, T, inbound);
        if (s < 0 || s > r.line.L) continue;
        const p = r.line.at(s, 350);
        const it = {
          id: `c${call.i}${inbound ? "i" : "o"}`, kind: "cruise", cls: "ship", name: call.vessel, dir: inbound ? "in" : "out",
          x: p.x, y: p.y, z: frame.z(p.x, p.y, 0), heading: p.heading, speed: inbound === (T < tm) ? vOut : vIn,
          len: call.len, beam: 36, height: 62, tPass: tm, alpha: Math.min(1, s / 800, (r.line.L - s) / 800),
          cabin: { rows: 9, from: -0.42, to: 0.4, h0: 0.22, h1: 0.78, seed: call.i },   // decks of warm cabin lights
          livery: hexRGB(CRUISE_HULL[call.vessel] || CRUISE_WHITE), led: CRUISE_LED,
        };
        if (SHIPS_FX) shipSway(T, call.len, SEED.cruise, call.i, it, CRUISE_ROLL);
        if (SHIP_WAKE) wakeTrail(it, r.line, s, it.speed);
        it.lights = lights(it);
        it.horn = horn(it, T, c, 100000 + call.i * 2 + (inbound ? 0 : 1));
        it.view = view(it.x, it.y, it.z);
        out.push(it);
      }
    }
    return out;
  }

  // QA (scripts/ships/sheets.mjs): ships placed by hand on the clock's own routes, built as the clock builds its own.
  // spec: { kind, route: "in" | "out" | "cruise_in" | "cruise_out", s (m along it), len, heading (deg, overrides the
  // route's), id, name }. city.state(T, { ships: [spec...] }) shows these instead of the timetable's.
  function placed(T, c, list) {
    return list.map((q, i) => {
      const r = R[q.route || "in"];
      const p = r.line.at(q.s ?? r.mid, 350);
      const ty = SHIPS.types.find((t) => t[0] === q.kind);
      const cruiseShip = q.kind === "cruise";
      const len = q.len ?? (cruiseShip ? 290 : (ty[2] + ty[3]) / 2);
      const it = {
        id: q.id || `qa${i}`, kind: q.kind, cls: "ship", name: q.name, dir: /out/.test(q.route || "") ? "out" : "in",
        x: p.x, y: p.y, z: frame.z(p.x, p.y, 0), heading: q.heading ?? p.heading, speed: q.speed ?? v, len,
        beam: cruiseShip ? 36 : ty[4], height: cruiseShip ? 62 : ty[5], tPass: T, alpha: 1,
        livery: q.livery ? hexRGB(q.livery) : cruiseShip ? hexRGB(CRUISE_HULL[q.name] || CRUISE_WHITE) : livery(q.kind, ((i * 0.37 + 0.2) % 1)),
        led: q.led ?? (cruiseShip ? CRUISE_LED : i % 2),
      };
      if (cruiseShip) it.cabin = { rows: 9, from: -0.42, to: 0.4, h0: 0.22, h1: 0.78, seed: i };
      // (its motion as the clock's ships', from its own id; q.still: none, for a sheet that wants the picture alone)
      if (SHIPS_FX && !q.still) shipSway(T, len, SEED.ship, 900000 + i, it, cruiseShip ? CRUISE_ROLL : 1);
      if (SHIP_WAKE) wakeTrail(it, r.line, q.s ?? r.mid, it.speed);
      it.lights = lights(it);
      it.horn = 0;
      it.view = view(it.x, it.y, it.z);
      return it;
    });
  }

  return { cargo, cruise, placed, calls, routes: R };
}
