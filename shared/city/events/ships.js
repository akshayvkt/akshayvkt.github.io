// Events 4 and 4b: container ships, tankers and the rest on 20-minute cycles, and the real 2026 cruise calendar.
//
// Cycle c (UTC-aligned, 20 min) carries a ship when hash(c) < 0.21 (15.1 bar crossings a day). Its direction, type,
// length and the minute it passes under midspan are hashed once for the cycle, so a ship in the channel never
// vanishes at a boundary. 12 knots along the channel: in from the pilot station 25 km out (bow-on on the horizon for
// about an hour), under midspan, east along the city front and out of view past 315 deg; outbound the reverse.
// Cruise ships pass under the bridge 45-60 min before their scheduled arrival and 40 min after departure.
import { SHIPS, CRUISE_2026, CRUISE_YEAR, CRUISE_LENGTH, CRUISE, CRUISE_HULL, CRUISE_WHITE } from "../tables.js";
import { sfToT, dayFromDate } from "../clock.js";
import { u01, SEED } from "../hash.js";
import { polyline, navLights, local, view } from "../geo.js";
// a cruise ship's deck lights: warm-white LED (the shaders' flood colour mixes sodium 0 .. cool LED 1; its lamp points
// count as LED above 0.5): with cool LED on its white superstructure the ship read grey at night
const CRUISE_LED = 0.65;

const KN = 0.514444;
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
      it.lights = lights(it);
      it.horn = 0;
      it.view = view(it.x, it.y, it.z);
      return it;
    });
  }

  return { cargo, cruise, placed, calls, routes: R };
}
