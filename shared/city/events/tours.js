// Event 5: Red & White and Blue & Gold tour boats on their timetables.
//
// Red & White's Golden Gate Bay Cruise leaves Pier 43 1/2 at the listed times for the weekday (holidays use the
// weekend list), each shifted by a hashed +-3 min (Blue & Gold: 0-3 min late); its Sunset Cruise is timed to pass under the bridge at sunset
// (late March to early November) and the winter Twilight Cruise leaves just after sunset. Blue & Gold runs its
// published June 2026 - February 2027 timetable (Bay Cruise, Escape from the Rock, Sunset Cruise) from Pier 39/41.
// (DYS-232 MOTION) On the water: flat and steady, a slight squat by the stern at speed (MOTION.squat), a heel out of
// its turns, and the chop's pitch, heave and roll (sprites.js waveMotion); `trail`, where it was, for the wake.
import { RED_WHITE, BLUE_GOLD } from "../tables.js";
import { sfDay, sfToT, sunset, wind } from "../clock.js";
import { u01, SEED } from "../hash.js";
import { polyline, navLights, local, view, clamp, wrap180 } from "../geo.js";
import { seaState, seaDay, waveMotion, MOTION } from "../sprites.js";

const DEG = Math.PI / 180;
const TURN_HEEL = 1.5;    // deg of heel out of a turn per deg of its lateral acceleration (as ferries.js)

const mins = (s) => +s.slice(0, 2) * 60 + +s.slice(3, 5);
const inRange = (mmdd, from, to) => (from <= to ? mmdd >= from && mmdd <= to : mmdd >= from || mmdd <= to);

export function createTours(routes, frame) {
  const R = {};
  for (const [k, r] of Object.entries(routes.tours)) R[k] = { ...r, line: polyline(r.pts) };

  // the day's departures: [fleet, product, route, local seconds of departure, duration s]
  const cache = new Map();
  function departures(day) {
    let list = cache.get(day);
    if (list) return list;
    const d = sfDay(day);
    list = [];
    const mmdd = d.mmdd, wd = d.wd, wkend = d.weekend;
    // Red & White
    const sum = inRange(mmdd, +RED_WHITE.summerDates[0], +RED_WHITE.summerDates[1]);
    const rw = sum ? RED_WHITE.summer : wkend ? RED_WHITE.satSun : wd >= 1 && wd <= 3 ? RED_WHITE.monWed : RED_WHITE.thuFri;
    for (const t of rw) list.push(["rw", "bay", "rw_bay", mins(t) * 60, R.rw_bay.minutes * 60]);
    const ss = sunset(day) - sfToT(day, 0);
    if (inRange(mmdd, +RED_WHITE.sunset.from, +RED_WHITE.sunset.to)) {
      const toBridge = R.sunset.bridge_s / (R.sunset.length / (120 * 60));
      list.push(["rw", "sunset", "sunset", Math.round(ss - toBridge), 120 * 60]);
    } else {
      list.push(["rw", "twilight", "sunset", Math.round(ss + RED_WHITE.twilight.after * 60), 120 * 60]);
    }
    // Blue & Gold
    let per = BLUE_GOLD.periods.find((p) => inRange(mmdd, +p.from, +p.to));
    if (!per) per = BLUE_GOLD.periods[BLUE_GOLD.periods.length - 1];
    const g = per.days;
    const dl = g.all || (g.monThu ? (wkend || wd === 5 ? g.friSun : g.monThu) : (wkend ? g.satSun : g.monFri));
    const ex = BLUE_GOLD.exceptions[String(mmdd).padStart(4, "0")] || {};
    for (const t of dl) {
      const kind = t.endsWith("R") ? "rock" : t.endsWith("S") ? "sunset" : "bay";
      if (kind === "sunset" && ex.noSunset) continue;
      const at = kind === "sunset" && ex.sunsetAt ? ex.sunsetAt : t.slice(0, 5);
      const route = kind === "rock" ? "bg_rock" : kind === "sunset" ? "sunset" : "bg_bay";
      list.push(["bg", kind, route, mins(at) * 60, (kind === "bay" ? R.bg_bay.minutes : 90) * 60]);
    }
    if (cache.size > 16) cache.clear();
    cache.set(day, list);
    return list;
  }

  // a departure's key, and the moment it leaves its pier: Red & White, the plan's hashed +-3 min (its times come from
  // resellers); Blue & Gold keeps its published times and leaves 0-3 min late (est.)
  const depKey = (day, fleet, sec) => (day % 100000) * 10000 + Math.round(sec / 60) * 4 + (fleet === "rw" ? 1 : 2);
  function leaves(day, fleet, sec) {
    const u = u01(SEED.tour, depKey(day, fleet, sec), 1);
    const jit = fleet === "rw" ? (u * 2 - 1) * RED_WHITE.jitter : u * BLUE_GOLD.jitter;
    return sfToT(day, sec) + jit;
  }
  // the day's departures as they leave the wharf (for the sound's departure blasts, sound/city.js): when (t0, the
  // moment the drawn boat starts to move) and where (its route's first point: the pier, Red & White's Pier 43 1/2 or
  // Blue & Gold's Pier 39/41; the sunset route starts at Pier 43 1/2 for both fleets)
  const leftCache = new Map();
  function leaving(day) {
    let list = leftCache.get(day);
    if (list) return list;
    list = departures(day).map(([fleet, product, route, sec]) => {
      const p = R[route].line.at(0), z = frame.z(p.x, p.y, 0);
      return { key: depKey(day, fleet, sec), fleet, product, route, sec, t0: leaves(day, fleet, sec), x: p.x, y: p.y, z, view: view(p.x, p.y, z) };
    });
    if (leftCache.size > 16) leftCache.clear();
    leftCache.set(day, list);
    return list;
  }

  function at(T, c) {
    const out = [];
    const windKt = c.wind?.open ?? 8, from = c.wind?.from ?? 255, sea = seaState(windKt, c.doy !== undefined ? seaDay(wind, c) : windKt);
    for (const day of [c.day - 1, c.day]) {
      for (const [fleet, product, route, sec, dur] of departures(day)) {
        const key = depKey(day, fleet, sec);
        const t0 = leaves(day, fleet, sec);
        const r = R[route];
        const v = r.line.L / dur;
        const s = (T - t0) * v;
        if (s < 0 || s > r.line.L) continue;
        const p = r.line.at(s, 120);
        const spec = fleet === "rw" ? RED_WHITE : BLUE_GOLD;
        const it = {
          id: `t${key}`, kind: "tour", fleet, product, x: p.x, y: p.y, z: frame.z(p.x, p.y, 0), heading: p.heading, speed: v,
          len: spec.len, beam: spec.beam ?? 10, height: spec.height, tDep: t0, alpha: Math.min(1, s / 300, (r.line.L - s) / 300),
          trim: fleet === "rw" ? "red" : "blue",
          cabin: { rows: 2, from: -0.38, to: 0.32, h0: 0.3, h1: 0.62, seed: key },
        };
        // (MOTION) the chop, the squat at speed, the heel out of a turn; where it was 1-4 x ~1.5 lengths and 25 s back
        const wm = waveMotion(T, it.x, it.y, it.heading, it.len, it.beam, sea, from + 180, "tour");
        const turn = wrap180(r.line.at(s + 15, 120).heading - r.line.at(s - 15, 120).heading) / 30;   // deg / m
        const lat = v * v * turn * DEG;
        it.heel = wm.roll - TURN_HEEL * (Math.atan(lat / 9.81) / DEG);
        it.pitch = wm.pitch + MOTION.squat.tour * Math.min(1.2, (v / 6) ** 2);
        it.heave = wm.heave; it.odo = s;
        const dt = clamp((1.5 * it.len) / Math.max(v, 0.5), 2, 15);
        it.trail = [dt, 2 * dt, 3 * dt, 4 * dt, 25].map((back) => {
          const s1 = Math.max(0, s - v * back), q = r.line.at(s1);
          return [q.x, q.y, (s - s1) / v];
        });
        const nav = navLights(it.x, it.y, it.heading);
        it.lights = [];
        for (const [a, rr, u, k, lv] of [[0.25, 0, 1.0, "white", nav.masthead], [0, 0.5, 0.7, "green", nav.green],
          [0, -0.5, 0.7, "red", nav.red], [-0.5, 0, 0.5, "white", nav.stern]]) {
          if (!lv) continue;
          const [x, y, z] = local(it.x, it.y, it.z, it.heading, a * it.len, rr * it.beam, u * it.height);
          it.lights.push({ x, y, z, colour: k, level: 1 });
        }
        it.view = view(it.x, it.y, it.z);
        out.push(it);
      }
    }
    return out;
  }

  return { at, departures, leaving };
}
