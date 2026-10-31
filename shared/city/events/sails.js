// Event 6: sailboats, out with the afternoon wind, Friday races and regattas.
//
// A pool of 100 boats. How many are out follows N(t) = base x clamp((wind - 4) / 7, 0, 1) on the Fort Point wind
// (base 8 on weekdays, 30 at weekends), +20 for Friday-evening races April-September, up to 100 on regatta days, by
// daylight only. Boat i goes out while hash(i, date) < N(t) / 100: each boat gets out-and-back times for the day,
// sails from its harbour mouth (no popping), wanders between hashed waypoints in its area, beats upwind on tacks of
// 2-6 minutes, flies a spinnaker running east before the westerly, and is back inside before sunset.
import { SAIL } from "../tables.js";
import { sfDay, sfTime, sfToT, sunrise, sunset, wind } from "../clock.js";
import { u01, SEED } from "../hash.js";
import { clamp, smooth, wrap180, bearingOf, dirOf, pointIn, view } from "../geo.js";

const KN = 0.514444;
const STEP = 300;
// one hash stream per purpose, so no two draws of a boat's day can collide
const DRAW = { thr: 1, out: 2, wpU: 3, wpV: 4, wpU2: 5, wpV2: 6, tack: 7 };
const draw = (purpose, i, day, k = 0) => u01(SEED.sail * 16 + purpose, i, day, k);

export function createSails(routes, frame) {
  const areas = routes.sail.areas, harbours = routes.sail.harbours;
  const hNames = Object.keys(harbours);
  const boats = [];
  for (let i = 0; i < SAIL.pool; i++) {
    let u = u01(SEED.sail, i, 1), harbour = hNames[hNames.length - 1];
    for (const h of hNames) { if (u < harbours[h].share) { harbour = h; break; } u -= harbours[h].share; }
    const ua = u01(SEED.sail, i, 2);
    const area = harbour === "sausalito" ? (ua < 0.6 ? "slot" : "cityfront") : ua < 0.75 ? "cityfront" : ua < 0.9 ? "gate" : "slot";
    boats.push({ i, harbour, area, mast: SAIL.mast[0] + (SAIL.mast[1] - SAIL.mast[0]) * u01(SEED.sail, i, 3),
      race: SAIL.raceMast[0] + (SAIL.raceMast[1] - SAIL.raceMast[0]) * u01(SEED.sail, i, 3),
      perf: 0.85 + 0.3 * u01(SEED.sail, i, 4), spin: Math.floor(u01(SEED.sail, i, 5) * 6) });
  }

  // (DYS-149 CF: a day's regatta, kept by its date: plan() asked 290 times a day (each STEP's wanted()), a new date
  // string each, 3 ms of the warm-up's first state on the slow laptop (bt1-1521 traces); a pure function of the date)
  const regattas = new Map();
  const regatta = (d) => {
    let r = regattas.get(d.key);
    if (r !== undefined) return r;
    const iso = `${d.y}-${String(d.mo).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
    r = SAIL.regattas.find(([a, b]) => iso >= a && iso <= b) || null;
    if (regattas.size > 64) regattas.clear();
    regattas.set(d.key, r);
    return r;
  };

  // boats wanted out on day d at `off` seconds after its local midnight, whose wall clock reads `sec` (they differ
  // after 02:00 on the two DST days); rise and set are offsets like `off`
  function wanted(d, off, sec, rise, set) {
    const hour = sec / 3600;
    const w = wind({ doy: d.doy, hour }).fortPoint;
    const g = clamp((w - SAIL.windLo) / SAIL.windSpan, 0, 1);
    let n = (d.weekend ? SAIL.weekend : SAIL.weekday) * g;
    const f = SAIL.friday;
    if (d.wd === 5 && !d.holiday && d.mo >= f.months[0] && d.mo <= f.months[1]) {
      n += f.add * Math.max(g, 0.6) * smooth(f.from - 0.75, f.from - 0.25, hour) * (1 - smooth(f.to - 0.25, f.to + 0.25, hour));
    }
    const r = regatta(d);
    if (r) n = Math.max(n, r[2] * Math.max(0.5, g) * smooth(r[3] - 1.5, r[3] - 0.5, hour) * (1 - smooth(r[4], r[4] + 1, hour)));
    const light = smooth(rise + 2700, rise + 5400, off) * (1 - smooth(set - 3600, set - 1200, off));
    return n * light;
  }

  function legsFor(b, day, tOut, tIn, raceDay) {
    const H = harbours[b.harbour], A = areas[b.area];
    const legs = [];
    let P = [H.inside[0], H.inside[1]], t = tOut, phase = "out", wk = 0, k = 0;
    const wp = () => pointIn(A, draw(DRAW.wpU, b.i, day, wk), draw(DRAW.wpV, b.i, day, wk),
      (j) => [draw(DRAW.wpU2, b.i, day, wk * 64 + j), draw(DRAW.wpV2, b.i, day, wk * 64 + j)]);
    const go = (heading, v, dur, kind, side) => {
      legs.push({ t0: t, x: P[0], y: P[1], heading, v, kind, side });
      const [dx, dy] = dirOf(heading);
      P = [P[0] + dx * v * dur, P[1] + dy * v * dur];
      t += dur;
    };
    // out through the mouth under power
    go(bearingOf(H.mouth[0] - P[0], H.mouth[1] - P[1]), 1.6, Math.hypot(H.mouth[0] - P[0], H.mouth[1] - P[1]) / 1.6, "motor", 1);
    let W = wp();
    while (k++ < 600) {
      if (phase !== "home" && t >= tIn) { phase = "home"; W = H.mouth; }
      const dx = W[0] - P[0], dy = W[1] - P[1], dist = Math.hypot(dx, dy);
      if (dist < 90) {
        if (phase === "home") {
          go(bearingOf(H.inside[0] - P[0], H.inside[1] - P[1]), 1.6, Math.hypot(H.inside[0] - P[0], H.inside[1] - P[1]) / 1.6, "motor", 1);
          break;
        }
        phase = "wander"; wk++; W = wp(); continue;
      }
      const wnd = wind(sfTime(t));
      const wf = clamp(0.55 + 0.045 * wnd.open, 0.7, 1.3) * b.perf * (raceDay ? 1.15 : 1);
      const from = wnd.from;
      const brg = bearingOf(dx, dy);
      const off = wrap180(brg - from);
      let heading, kind, v, dur;
      if (Math.abs(off) < 42) {
        const tack = off >= 0 ? 1 : -1;
        heading = (from + tack * 45 + 360) % 360; kind = "beat"; v = SAIL.knots.beat * KN * wf;
        const across = Math.abs(dist * Math.sin((off * Math.PI) / 180));
        dur = Math.min(120 + 240 * draw(DRAW.tack, b.i, day, k), Math.max(60, (2 * across) / (v * 0.7071)));
      } else {
        heading = brg; kind = Math.abs(wrap180(off - 180)) < 35 ? "run" : "reach";
        v = (kind === "run" ? SAIL.knots.run : SAIL.knots.reach) * KN * wf;
        dur = Math.min(dist / v, 600);
      }
      if (phase !== "home") dur = Math.min(dur, Math.max(30, tIn - t));
      const side = wrap180(from - heading) > 0 ? -1 : 1;   // the sail sits on the side away from the wind
      go(heading, v, dur, kind, side);
    }
    legs.push({ t0: t, end: true });
    return legs;
  }

  // the day's plan: for every boat, its outings [{tOut, tIn, legs}]
  const plans = new Map();
  function plan(day) {
    let p = plans.get(day);
    if (p) return p;
    const d = sfDay(day), t0 = sfToT(day, 0);
    const rise = sunrise(day) - t0, set = sunset(day) - t0;
    const N = [];
    for (let s = 0; s <= 86400; s += STEP) N.push(wanted(d, s, s < 86400 ? sfTime(t0 + s).sec : 86400, rise, set));
    const raceDay = !!regatta(d);
    p = boats.map((b) => {
      const thr = draw(DRAW.thr, b.i, day) * SAIL.pool;
      const iv = [];
      let open = null;
      N.forEach((n, j) => {
        if (n > thr && open === null) open = j;
        if ((n <= thr || j === N.length - 1) && open !== null) { iv.push([open, j]); open = null; }
      });
      const merged = [];
      for (const v of iv) {
        if (merged.length && (v[0] - merged[merged.length - 1][1]) * STEP < 1800) merged[merged.length - 1][1] = v[1];
        else merged.push(v);
      }
      return merged.filter(([a, c]) => (c - a) * STEP >= 1800).map(([a, c], n) => {
        const tOut = t0 + a * STEP + draw(DRAW.out, b.i, day, n) * STEP;
        const tIn = Math.min(t0 + c * STEP, t0 + set - 1800);
        // the out-and-back hours are local; the legs use the wind at their own time
        const legs = legsFor(b, day, tOut, Math.max(tOut + 600, tIn), raceDay);
        return { tOut, tIn, legs, end: legs[legs.length - 1].t0 };
      });
    });
    if (plans.size > 8) plans.clear();
    plans.set(day, p);
    return p;
  }

  function at(T, c) {
    const out = [];
    for (const day of [c.day]) {
      const p = plan(day);
      const raceDay = !!regatta(sfDay(day));
      p.forEach((outings, i) => {
        for (const o of outings) {
          if (T < o.tOut || T >= o.end) continue;
          const L = o.legs;
          let lo = 0, hi = L.length - 1;
          while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L[m].t0 <= T) lo = m; else hi = m; }
          const g = L[lo];
          const [dx, dy] = dirOf(g.heading);
          const x = g.x + dx * g.v * (T - g.t0), y = g.y + dy * g.v * (T - g.t0);
          const b = boats[i];
          const mast = raceDay ? b.race : b.mast;
          const first = L[0];
          out.push({
            id: `y${i}`, kind: "sail", x, y, z: frame.z(x, y, 0), heading: g.heading, speed: g.v, mast, len: mast * 0.8,
            point: g.kind, spinnaker: g.kind === "run", spinColour: b.spin, side: g.side, race: raceDay,
            alpha: Math.min(1, (T - first.t0) / 60, (o.end - T) / 60) * (g.kind === "motor" ? 0.85 : 1),
            view: view(x, y, frame.z(x, y, 0)),
          });
        }
      });
    }
    return out;
  }

  return { at, plan, wanted: (day, sec) => { const t0 = sfToT(day, 0); return wanted(sfDay(day), sfToT(day, sec) - t0, sec, sunrise(day) - t0, sunset(day) - t0); } };
}
