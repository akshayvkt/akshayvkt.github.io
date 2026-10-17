// Event 5: Red & White and Blue & Gold tour boats on their timetables.
//
// Red & White's Golden Gate Bay Cruise leaves Pier 43 1/2 at the listed times for the weekday (holidays use the
// weekend list), each shifted by a hashed +-3 min (Blue & Gold: 0-3 min late); its Sunset Cruise is timed to pass under the bridge at sunset
// (late March to early November) and the winter Twilight Cruise leaves just after sunset. Blue & Gold runs its
// published June 2026 - February 2027 timetable (Bay Cruise, Escape from the Rock, Sunset Cruise) from Pier 39/41.
import { RED_WHITE, BLUE_GOLD } from "../tables.js";
import { sfDay, sfToT, sunset } from "../clock.js";
import { u01, SEED } from "../hash.js";
import { polyline, navLights, local, view } from "../geo.js";

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

  function at(T, c) {
    const out = [];
    for (const day of [c.day - 1, c.day]) {
      for (const [fleet, product, route, sec, dur] of departures(day)) {
        const key = (day % 100000) * 10000 + Math.round(sec / 60) * 4 + (fleet === "rw" ? 1 : 2);
        // Red & White: the plan's hashed +-3 min (its times come from resellers); Blue & Gold keeps its published
        // times and leaves 0-3 min late (est.)
        const u = u01(SEED.tour, key, 1);
        const jit = fleet === "rw" ? (u * 2 - 1) * RED_WHITE.jitter : u * BLUE_GOLD.jitter;
        const t0 = sfToT(day, sec) + jit;
        const r = R[route];
        const v = r.line.L / dur;
        const s = (T - t0) * v;
        if (s < 0 || s > r.line.L) continue;
        const p = r.line.at(s, 120);
        const spec = fleet === "rw" ? RED_WHITE : BLUE_GOLD;
        const it = {
          id: `t${key}`, kind: "tour", fleet, product, x: p.x, y: p.y, z: frame.z(p.x, p.y, 0), heading: p.heading, speed: v,
          len: spec.len, beam: 10, height: spec.height, tDep: t0, alpha: Math.min(1, s / 300, (r.line.L - s) / 300),
          trim: fleet === "rw" ? "red" : "blue",
          cabin: { rows: 2, from: -0.38, to: 0.32, h0: 0.3, h1: 0.62, seed: key },
        };
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

  return { at, departures };
}
