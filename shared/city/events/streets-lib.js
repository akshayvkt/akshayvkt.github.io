// Event 1b's helpers (events/streets.js imports them, so they load at boot with it): the streets built from routes.json,
// their flows by hour, the signals, the buses' timetable, a vehicle and its driver, the car-following law, and how much
// of a vehicle shows. Pure functions of their arguments (and tables.js), so the simulation stays a function of T alone.
import {
  STREET_FLOW, STREET_DEFAULT, STREET_PROFILE, STREET_TRAFFIC as ST, STREET_SIGNALS as SG, STREET_IDM as IDM, STREET_LANES_HOURLY,
  STREET_FLEET as FL, STREET_LC as LC, STREET_TURN as TU, CAR_PAINT, BIKE_FLOW, BIKE_DEFAULT, BIKE, BRIDGE_HOURLY, BRIDGE_SCALE,
} from "../tables.js";
import { sfTime, sfDay } from "../clock.js";
import { u01, SEED } from "../hash.js";
import { polyline, smooth } from "../geo.js";

const { min, max } = Math;
export const END_FADE = 40, VIS_FADE = 8, VIS_FADE_S = 3;
const norm = (p) => { const s = p.reduce((a, b) => a + b, 0); return p.map((x) => x / s); };
const PROFILE = {};
for (const k in STREET_PROFILE) PROFILE[k] = norm(STREET_PROFILE[k]);
const SPEED = { motorway: 17.9 };   // m/s (else 11.2)
export const pick = (L, r) => { let k = 0; for (; k < L.length - 1 && r >= L[k][0]; k++) r -= L[k][0]; return k; };
export const rg = ([lo, hi], u) => lo + (hi - lo) * u, sk = (u) => u * u * Math.sqrt(u);
export const mod = (a, n) => ((a % n) + n) % n, hs = (a, b, c) => u01(SEED.street, a, b, c);
// (DYS-149 fix 2: SF local time at T for the streets, the last two kept. A step asked clock.js for it ~150 times at
// its t (each street's flow and lanes, every link, the buses at t and t + dt), each a new object of 17 fields: 16 % of
// the page's catch-up and much of its GC. Read only here, so one object serves them all; the same values)
let sfT0 = NaN, sfD0 = null, sfT1 = NaN, sfD1 = null;
export function sfAt(T) {
  if (T === sfT0) return sfD0;
  if (T === sfT1) return sfD1;
  sfT1 = sfT0; sfD1 = sfD0; sfT0 = T; sfD0 = sfTime(T);
  return sfD0;
}

// ---- the streets
export function buildStreets(R, offset) {
  const streets = [];
  for (const r of R.streets) {
    const line = polyline(r.pts), fl = STREET_FLOW[r.id] || STREET_DEFAULT[r.road] || STREET_DEFAULT.tertiary, hourly = STREET_LANES_HOURLY[r.id];
    let nMax = max(1, min(ST.maxLanes, hourly ? hourly.peak : fl.lanes || r.lanes_dir || 1));
    // (lane centres, inner first)
    const lat = r.lane_lat && !hourly && !fl.lanes ? r.lane_lat.slice() : [];
    if (lat.length) nMax = lat.length;
    else for (let i = 0; i < nMax; i++) lat.push(r.oneway ? (i - (nMax - 1) / 2) * ST.laneW : ST.laneW / 2 + i * ST.laneW - offset);
    const v = SPEED[r.road] || 11.2, key = (parseInt(r.id, 10) % 1000003) * 2 + (String(r.id).endsWith("r") ? 1 : 0);
    // (M5: the kerb's spaces, and where a car pulled in there stands: right of its lane; none: a lane width, Lombard)
    const pk = r.park ? r.park[1] : null, py = r.park && r.park[0] != null ? r.park[0] - lat[lat.length - 1] : null;
    streets.push({ r, line, L: line.L, nMax, hourly, lat, v, pk, py, pc: 0, vm: v * (FL.speedBy[r.road] ?? 1), key, flow: fl, sig: [], vis: r.road_vis || null, bike: false, X: [], E: [] });
  }
  // turns off X [s, lane (-1 kerb), chance, next street, most], on E [s, lane, chance]; bus runs U [.., its E or -1]
  for (const S of streets) {
    for (const [s, m, k] of S.r.junc || []) {
      const p = (TU.out[S.r.road] ?? 0) * (k ? TU.big : 1), no = (m & 1) + ((m >> 1) & 1), ni = ((m >> 2) & 1) + (m >> 3);
      if (no && ni) for (const b of [0, 1]) { if (m & (1 << b)) S.X.push([s, -b, p / no]); if (m & (4 << b)) S.E.push([s, -b, p / ni]); }
    }
    S.U = (S.r.bus || []).map((b) => [...b, b[1] < 1 ? -1 : S.E.push([b[1], -1, 0]) - 1]);
    for (const [s, id, ln] of S.r.link || []) {
      const j = streets.findIndex((B) => B.r.id === id);
      if (j >= 0) { S.X.push([s, ln, 0, j, s > S.L - 9 ? 1 : TU.branch]); streets[j].fed = 1; }
    }
    S.X.sort((a, b) => a[0] - b[0]);
  }
  // (C 21:5x: a street a link feeds makes the rest of its own flow, on at F, 20 m into its first hidden stretch of
  // 60 m or more; none hidden: its start, as an unfed street)
  for (const S of streets) if (S.fed) {
    let a = 0;
    S.F = 0;
    for (const [x, y] of S.vis || []) { if (x - a >= 60) break; a = max(a, y); }
    if (S.vis && S.L - a >= 60) S.F = a + 20;
  }
  // signals [stop line s, green from, length]; a stop sign [its line, 0, 0] (routes.json streets[].stops)
  // (one phase a node, both directions' greens at once: the progressed direction's wave sets it, with each node's own
  // small error)
  const wave = new Map();
  for (const S of streets) {
    const vw = IDM.greenWave[S.r.id];
    if (vw) for (const [sj, node] of S.r.signals || []) wave.has(node) || wave.set(node, mod(sj / vw + (2 * hs(node % 2147483647, 0, 11) - 1) * IDM.waveErr, SG.cycle));
  }
  for (const S of streets) {
    const share = SG.mainBy[S.r.id] ?? SG.main;
    S.sig = (S.r.road === "motorway" ? [] : S.r.signals || []).map(([sj, node, main]) => {
      const phi = wave.has(node) ? wave.get(node) : hs(node % 2147483647, 0, 9) * SG.cycle;
      return [sj, main ? phi : phi + share * SG.cycle, (main ? share : 1 - share) * SG.cycle];
    }).concat((S.r.stops || []).map((s) => [s, 0, 0])).sort((a, b) => a[0] - b[0]);
  }
  for (const S of streets.slice()) if (S.r.bike) {
    const pr = S.r.park_m?.[1], bl = S.lat[S.lat.length - 1] + ST.laneW / 2 + BIKE.outside;
    streets.push({ ...S, nMax: 1, hourly: null, lat: [pr != null ? min(bl, pr - BIKE.parkClear) : bl], v: BIKE.speed, vm: BIKE.speed,
      key: S.key + 2000006, sig: [], bike: true, X: [], E: [], U: [], fed: 0, flow: { bikes: BIKE_FLOW[S.r.id] || BIKE_DEFAULT } });
  }
  return streets;
}

// ---- vehicles an hour (smoothed so each hour's mean is its table value), the lanes open
function hourly(S, d, h) {
  const f = S.flow;
  if (f.bikes) return (d.dayType === "weekday" ? f.bikes.weekday : f.bikes.weekend) * PROFILE.weekend[h];
  if (f.bridge != null) return f.bridge * BRIDGE_HOURLY[d.dayType][h][f.dir] * BRIDGE_SCALE.total;
  const we = d.dayType !== "weekday";
  return (we ? (f.weekend ?? f.weekday * ST.weekendShare) : f.weekday) * (we ? PROFILE.weekend : PROFILE[f.peak])[h];
}
// (DYS-149 CF: the knots were solved street by street, 40 passes of a new array and a closure a value each: on the
// first visit's hidden warm-up frame every street's at once, 12-14 ms of the city's first state on the slow laptop
// (bt1-1521 traces). A street's knots depend only on its flow table (hourly() reads S.flow alone) and the three days'
// day types, so streets sharing a table (the road classes' defaults, a bike lane's) share one solve; and the passes
// run in two arrays, not 40 new ones. The same operations in the same order: the same numbers)
const knotShared = new Map(), flowKey = new Map();
function solveKnots(q) {
  let x = q.slice(), y = q.slice();
  const n = q.length;
  for (let it = 0; it < 40; it++) {
    for (let j = 1; j < n - 1; j++) y[j] = max(0, (q[j] - 0.125 * (x[j - 1] + x[j + 1])) / 0.75);
    const t = x; x = y; y = t;
  }
  return x.slice(23, 49);
}
export function flows(streets) {
  const knotCache = streets.map(() => new Map());
  function knotsFor(i, day) {
    let k = knotCache[i].get(day);
    if (k) return k;
    const f = streets[i].flow, fk = f.bikes || f, d0 = sfDay(day - 1), d1 = sfDay(day), d2 = sfDay(day + 1);
    let id = flowKey.get(fk);
    if (id === undefined) flowKey.set(fk, (id = flowKey.size));
    const key = `${id}:${d0.dayType}:${d1.dayType}:${d2.dayType}`;
    k = knotShared.get(key);
    if (!k) {
      const q = [];
      for (const info of [d0, d1, d2]) for (let h = 0; h < 24; h++) q.push(hourly(streets[i], info, h));
      k = solveKnots(q);
      if (knotShared.size > 4096) knotShared.clear();
      knotShared.set(key, k);
    }
    if (knotCache[i].size > 16) knotCache[i].clear();
    return knotCache[i].set(day, k), k;
  }
  return (i, T) => {
    const t = sfAt(T), x = min(t.hour, 23.999) - 0.5, h0 = Math.floor(x), k = knotsFor(i, t.day);
    return k[h0 + 1] + (k[h0 + 2] - k[h0 + 1]) * (x - h0);
  };
}
export function lanesOpen(S, T) {
  const H = S.hourly, t = sfAt(T);
  return !H ? S.nMax : t.dayType === "weekday" && H.hours.some(([a, b]) => t.hour >= a && t.hour < b) ? H.peak : H.off;
}
// a signal at t: 0 green, 1 amber, 2 red
export const light = (G, t, p = mod(t - G[1], SG.cycle)) => (p < G[2] - IDM.amber ? 0 : p < G[2] ? 1 : 2);

// ---- the buses: trips in an hour (routes.json bus_hours, base 36 by hour), those due in [t0, t1)
const DAY_COL = { saturday: 1, sunday: 2 };   // (DYS-149 fix 2: once, not a new object each call)
export function buses(R) {
  const BH = R.bus_hours || {}, trips = (b, d, h) => { const x = BH[b[0]]; return parseInt((x[DAY_COL[sfDay(d).dayType] | 0] ?? x[1])[h] || 0, 36); };
  function busDue(S, t0, t1) {
    const out = [];
    for (const u of [t0, t1]) {
      const d = sfAt(u), h = d.hour | 0, H = u - (d.sec % 3600), m = (H / 60) | 0;
      if (u > t0 && H <= t0) break;
      S.U.forEach((b, j) => {
        const n = trips(b, d.day, h) + (h < 6 ? trips(b, d.day - 1, h + 24) : 0), o = hs(S.key, m, 50 + j);
        for (let k = 0; k < n; k++) { const T = H + ((k + o) * 3600) / n; if (T >= t0 && T < t1) out.push({ slot: m * 64 + j * 16 + k, b }); }
      });
    }
    return out;
  }
  return { trips, busDue };
}

// ---- a vehicle and driver
export function makeVehicle(S, li, slot, bus, tk) {
  const id = S.key * 4 + li, h = (f) => hs(id, slot | 0, f), r = h(13), m = FL.motorbike;
  const ty = S.bike ? "bike" : bus ? "bus" : r < tk ? "boxtruck" : r < tk + m ? "motorbike" : FL.mix[pick(FL.mix, (r - tk - m) / (1 - tk - m))][1];
  const P = FL.types[ty], model = bus ? "muni" : P.models[pick(P.models, h(5))][1], paint = S.bike || bus ? 0 : pick(CAR_PAINT, h(6));
  // (DYS-149 fix 2: go, its moment to move off, there from the start (null, as step() sets it): added on its first
  // step, every vehicle changed shape there, and the page's step() was thrown back to slower code again and again)
  return { id: `${S.bike ? "b" : bus ? "u" : "c"}${id}:${slot}`, model, type: ty, paint, kind: P.kind, len: P.len || FL.lenOf[model], s: 0, v: 0, sPrev: 0, a: 0,
    v0: 0, v0b: S.vm * P.v0 * max(FL.speedMin, 1 + FL.speedCv * 2 * (h(10) + h(11) + h(12) - 1.5)), tau: rg(IDM.drift.slice(1), h(8)), phi: h(9),
    aMax: rg(P.a, h(2)), b: rg(P.b, h(3)), T: rg(P.T, h(4) ** (P.Tk || 1.5)), s0: rg(P.s0, sk(h(7))),
    n: h(20) * 4294967296, p: rg(LC.p, h(14)), lcd: rg(LC.dur, h(15)), lc: null, x: null, r: bus && bus[0], st: 0, w: 0, y: 0, h1: 0, hl: 0, ss: -1, sw: 0, f: 0, g: 0, go: null };
}
// the desired speed's slow wander (-1..1)
export const drift = (u) => { const x = u - Math.floor(u), y = x * (1 - x); return 32 * y * y - 1; };
// IDM+ (Schakel et al. 2010)
export function idm(c, s, dv) {
  const r = c.v / c.v0, r2 = r * r, q = (c.s0 + max(0, c.v * c.T + (c.v * dv) / (2 * Math.sqrt(c.aMax * c.b)))) / max(s, 0.1);
  return min((r > 1 ? c.b : c.aMax) * (1 - r2 * r2), c.aMax * (1 - q * q));
}
export const acc = (c, L) => (L ? idm(c, L.s - L.len - c.s, c.v - L.v) : idm(c, 1e4, 0));
// the next ahead (d 1: behind), pulled in or not
export const ld = (cars, j, d = -1, y = !!cars[j].y) => { let k = j + d; while (cars[k] && !!cars[k].y !== y) k += d; return cars[k]; };

// ---- how much shows (on a far "hard" run and the path's ends: its body's share)
export function shows(S, s, c) {
  const n = FL.lenOf[c.model], cov = (a, b) => max(0, min(s, b) - max(s - n, a)) / n;
  const k = cov(c.f ? -n : 0, S.L);
  if (k <= 0 || !S.vis) return k;
  let fade = max(VIS_FADE, VIS_FADE_S * S.v), best = 0;
  for (const [a, b, hard] of S.vis) {
    if (hard) best = max(best, cov(a, b));
    else if (s >= a && s <= b) return k;
    else best = max(best, 1 - smooth(0, fade, s < a ? a - s : s - b));
  }
  return k * best;
}
