// Event 7: the Golden Gate Ferry between Sausalito and the San Francisco Ferry Building. Only the window spot sees it
// (plan v2 4.3 and 6): the Sausalito end of the line, 5.8-8.0 km out at bearings 320-332, where the ferries are
// 7-12 px; from the desk the whole line is out of view.
//
// One vessel runs the confirmed timetable (effective April 13, 2026; the weekend table on weekends and the ferry's own
// holidays; no service on Thanksgiving, Christmas Day and New Year's Day). Its trips chain through the day: it waits at the
// terminal it reached until its next departure from there, overnight too, and when a day starts at the other
// terminal it crosses empty to arrive 12 min before the first departure (est.). Each departure leaves 0-90 s late
// (hashed once per departure), speeds up over 2 min, cruises and slows over the last 3 min to the berth 28 min later
// (est.), all in closed form. So the ferry never pops in or out at the Sausalito dock, which is in view.
import { GG_FERRY_SAUSALITO as GGF } from "../tables.js";
import { sfDay, sfToT, holidayDates } from "../clock.js";
import { u01, SEED } from "../hash.js";
import { polyline, navLights, local, view } from "../geo.js";

const mins = (s) => +s.slice(0, 2) * 60 + +s.slice(3, 5);

// distance along a crossing of length L after tau seconds of D: speed up over a, slow down over b (trapezoid)
export function trapezoid(L, D, a, b, tau) {
  const v = L / (D - a / 2 - b / 2);
  if (tau <= 0) return { s: 0, v: 0 };
  if (tau >= D) return { s: L, v: 0 };
  if (tau < a) return { s: (v * tau * tau) / (2 * a), v: (v * tau) / a };
  if (tau < D - b) return { s: (v * a) / 2 + v * (tau - a), v };
  const r = D - tau;
  return { s: L - (v * r * r) / (2 * b), v: (v * r) / b };
}

export function createFerries(routes, frame) {
  const R = routes.ferries.ggf_sausalito;
  const line = polyline(R.pts);
  const L = line.L, D = GGF.underway * 60;
  // the boat's size, fixed (one vessel)
  const len = GGF.len[0] + (GGF.len[1] - GGF.len[0]) * u01(SEED.ferry, 1, 0);

  // the ferry's own holiday rules (not the traffic list in clock.js: MLK Day, for one, runs the weekday table)
  const isOne = (d, names) => { const h = holidayDates(d.y); return names.some((n) => h[n] === d.key); };
  const noService = (d) => isOne(d, GGF.noService);
  const weekendTable = (d) => d.wd === 0 || d.wd === 6 || isOne(d, GGF.weekendHolidays);

  // the day's timetabled crossings in order: {from: "sau"|"sf", dep, arr, empty}
  const sched = new Map();
  function scheduled(day) {
    let list = sched.get(day);
    if (list) return list;
    const d = sfDay(day);
    list = [];
    if (!noService(d)) {
      const tab = weekendTable(d) ? GGF.weekend : GGF.weekday;
      const legs = [...tab.fromSausalito.map((t) => ["sau", ...t]), ...tab.fromSF.map((t) => ["sf", ...t])]
        .sort((x, y) => mins(x[1]) - mins(y[1]));
      for (const [from, t, ta] of legs) {
        const key = (day % 100000) * 4000 + mins(t) * 2 + (from === "sau" ? 0 : 1);
        const late = u01(SEED.ferry, key, 2) * GGF.late;
        // under way for the standard crossing; a longer timetabled trip leaves the city end later (out of view) so
        // that it still reaches Sausalito at its listed time
        const slack = Math.max(0, (mins(ta) - mins(t)) * 60 - 120 - D);
        const dep = sfToT(day, mins(t) * 60) + late + (from === "sf" ? slack : 0);
        list.push({ from, dep, arr: dep + D, empty: false, key, listed: sfToT(day, mins(t) * 60), listedArr: sfToT(day, mins(ta) * 60) });
      }
    }
    if (sched.size > 32) sched.clear();
    sched.set(day, list);
    return list;
  }
  // where the boat ties up at the end of local day `day`: the last timetabled crossing's destination, or the day
  // before's on a day without service (a function of the timetable alone)
  function endsAt(day) {
    for (let k = 0; k < 8; k++) {
      const list = scheduled(day - k);
      if (list.length) return list[list.length - 1].from === "sau" ? "sf" : "sau";
    }
    return "sau";
  }
  // the day's crossings including the empty one when the day starts at the other terminal
  const cache = new Map();
  function trips(day) {
    let list = cache.get(day);
    if (list) return list;
    list = scheduled(day).slice();
    const startAt = endsAt(day - 1);
    if (list.length && list[0].from !== startAt) {
      const arr = list[0].listed - GGF.deadhead * 60;
      list.unshift({ from: startAt, dep: arr - D, arr, empty: true, key: (day % 100000) * 4000 + 3999 });
    }
    if (cache.size > 16) cache.clear();
    cache.set(day, list);
    return list;
  }

  function place(s, it) {
    const p = line.at(s, 120);
    it.x = p.x; it.y = p.y; it.z = frame.z(p.x, p.y, 0);
    it.heading = p.heading;
    return it;
  }

  function at(T, c) {
    // the crossing under way, else the last one finished (the boat waits at its berth) and the next one to come
    let cur = null, prev = null, next = null;
    for (let k = 7; k >= -1; k--) {
      for (const tr of trips(c.day - k)) {
        if (T >= tr.dep && T < tr.arr) cur = tr;
        else if (T >= tr.arr) prev = tr;
        else if (!next) next = tr;
      }
    }
    const it = { id: "ferry_ggf", kind: "ferry", operator: "Golden Gate Ferry", spot: "window", len, beam: GGF.beam,
      height: GGF.height, alpha: 1 };
    if (cur) {
      const m = trapezoid(L, D, GGF.accel, GGF.decel, T - cur.dep);
      place(cur.from === "sau" ? m.s : L - m.s, it);
      if (cur.from === "sf") it.heading = (it.heading + 180) % 360;
      Object.assign(it, { speed: m.v, docked: false, from: cur.from, to: cur.from === "sau" ? "sf" : "sau", empty: cur.empty,
        tDep: cur.dep, tArr: cur.arr });
    } else {
      const berth = prev ? (prev.from === "sau" ? "sf" : "sau") : next ? next.from : "sau";
      place(berth === "sau" ? 0 : L, it);
      // berthed bow-in, as it arrived
      it.heading = berth === "sau" ? (line.at(0, 120).heading + 180) % 360 : line.at(L, 120).heading;
      Object.assign(it, { speed: 0, docked: true, berth, since: prev ? prev.arr : null, nextDep: next ? next.dep : null });
    }
    const nav = navLights(it.x, it.y, it.heading);
    it.lights = [];
    if (!it.docked) {
      for (const [a, rr, u, k, lv] of [[0.3, 0, 1.0, "white", nav.masthead], [0, 0.5, 0.75, "green", nav.green],
        [0, -0.5, 0.75, "red", nav.red], [-0.5, 0, 0.55, "white", nav.stern]]) {
        if (!lv) continue;
        const [x, y, z] = local(it.x, it.y, it.z, it.heading, a * it.len, rr * it.beam, u * it.height);
        it.lights.push({ x, y, z, colour: k, level: 1 });
      }
    }
    // cabin windows: lit in service, dim at the berth when the next run is within the hour, dark for the night
    const soon = it.docked && it.nextDep !== null && it.nextDep - T < 3600;
    it.cabin = { rows: 2, from: -0.4, to: 0.36, h0: 0.32, h1: 0.66, seed: 7000,
      level: it.docked ? (soon ? 0.35 : 0) : it.empty ? 0.3 : 1 };
    it.view = view(it.x, it.y, it.z);
    return [it];
  }

  return { at, trips, scheduled, endsAt, line };
}
