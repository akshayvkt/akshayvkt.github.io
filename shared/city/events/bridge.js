// Event 1: Golden Gate Bridge traffic.
//
// Each direction's traffic moves as one frame along its lanes: X(T), the distance a car has travelled since 1970, is
// a closed-form integral of a speed that sags a little at the peaks (piecewise linear between UTC quarter hours,
// each UTC day normalised to the same total, so X is continuous for ever). Lanes are cut into 30 m cells that ride
// that frame. A cell holds a vehicle when hash(lane, cell) < q * 30 m / v, with q (vehicles an hour per lane) and v
// taken at the moment the cell rolls onto the bridge: decided once, it never changes while the car is on the deck.
import { BRIDGE_HOURLY, BRIDGE_SCALE, BRIDGE_LANES, BRIDGE_TRAFFIC as BT, STREET_FLEET as FL, CAR_PAINT } from "../tables.js";
import { sfDay, utcOffset } from "../clock.js";
import { u01, SEED } from "../hash.js";
import { smooth } from "../geo.js";

const DEG = Math.PI / 180;
const DAY = 86400;
// Cars are drawn on the deck only: they fade in over the last END_FADE metres at each end, where the road leaves the
// view (into the Presidio's trees toward the toll plaza; off the north viaduct toward Vista Point and the Waldo grade).
// Measured on the cloud panorama (2026-10-16): the deck shows to s -1330 m in the south and to the viaduct's end in
// the north; the cells still ride the whole frame S0..S1, so the timing and the week simulation are unchanged.
const END_FADE = 40;
// (DYS-149 gc-diet: a vehicle's place with no new array and no destructuring (at, deckOffset): ~0.1-0.3 MB of garbage
// a frame. The same numbers. ?gcdiet=0 on the page: as before)
const GC_DIET = typeof location === "undefined" || new URLSearchParams(location.search || "").get("gcdiet") !== "0";
// (DYS-240 traffic-real, E; ?trafficreal=0: as before) each vehicle a model, paint and road height from the streets'
// fleet (hashed by its lane and cell, so the same for every visitor; heavy ones half buses, half box trucks), so that
// magnified it is drawn as the streets' 3D cars, not a speck (outside-events.js); and each sits a few metres off its
// cell's centre and drifts slowly about it, so the deck is no longer a 30 m grid of cars at one speed. Which cells hold
// a vehicle is unchanged: the counts stay the hourly table's
export const TRAFFIC_REAL = typeof location === "undefined" || new URLSearchParams(location.search || "").get("trafficreal") !== "0";
// (m off the cell's centre, m of drift over a period in s: at most 7 m each way, so neighbouring cells' vehicles stay
// 16 m apart, two 12.5 m buses 3.5 m)
const JIT = { off: 5, wob: 2, period: [35, 65] };
// (DYS-240 traffic-real, G: each lane at its own speed, so the fast lane passes the slow one and no direction glides in
// lockstep: the inner lanes (|w| 1.6 m, the swing lane's too) 5 % over the direction's speed, the middle as it, the outer
// (|w| 8 m) 5 % under (est.: the real deck's lanes differ by about this at 45 mph). A lane's cells ride its own frame,
// f X(T); a cell holds a vehicle with the chance q 30 m / (f v), so a lane's vehicles an hour stay q: the counts stay
// the hourly table's)
const LANE_V = { inner: 1.05, mid: 1, outer: 0.95 };
const laneV = (w) => (!TRAFFIC_REAL ? 1 : Math.abs(w) < 3 ? LANE_V.inner : Math.abs(w) < 6 ? LANE_V.mid : LANE_V.outer);
const pickW = (L, r) => { let k = 0; for (; k < L.length - 1 && r >= L[k][0]; k++) r -= L[k][0]; return k; };

// build.py deck_w(s): the deck centreline's offset east of the axis (routes.json bridge.deck_curve), clamped at both
// ends as numpy's interp is; 0 between the anchorages
export function deckOffset(curve, s) {
  if (!curve || !curve.length) return 0;
  if (s <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (s <= curve[i][0]) {
      if (GC_DIET) { const p = curve[i - 1], q = curve[i]; return p[1] + ((s - p[0]) / (q[0] - p[0])) * (q[1] - p[1]); }
      const [s0, w0] = curve[i - 1], [s1, w1] = curve[i];
      return w0 + ((s - s0) / (s1 - s0)) * (w1 - w0);
    }
  }
  return curve[curve.length - 1][1];
}

export function createBridge(routes, frame) {
  const B = routes.bridge;
  const [mx, my] = B.mid_xy;
  const ax = Math.sin(B.bearing * DEG), ay = Math.cos(B.bearing * DEG);   // along the bridge, toward Marin
  const ex = Math.cos(B.bearing * DEG), ey = -Math.sin(B.bearing * DEG);  // across it, to the east
  const S0 = B.s_south_end - 60, S1 = B.s_north_end + 60, L = S1 - S0;
  const deckBottom = (s) => {
    const d = B.deck_bottom;
    return Math.abs(s) <= B.s_tower ? d.mid - d.sag * (s / B.s_tower) ** 2 + B.deck_lift
      : d.side - d.side_slope * (Math.abs(s) - B.s_tower) + B.deck_lift;
  };
  // a point s metres along the bridge (north of midspan), w metres east of its centreline, h above the sea: the deck's
  // ends bend as the renderer's do (deck_curve), so its lanes and lamps sit where the panorama has them
  const point = (s, w, h) => {
    w += deckOffset(B.deck_curve, s);
    const x = mx + s * ax + w * ex, y = my + s * ay + w * ey;
    return [x, y, frame.z(x, y, h)];
  };
  // (DYS-149 gc-diet: at()'s, into one array it reads at once)
  const P3 = [0, 0, 0];
  const pointTo = (s, w, h) => {
    w += deckOffset(B.deck_curve, s);
    const x = mx + s * ax + w * ex, y = my + s * ay + w * ey;
    P3[0] = x; P3[1] = y; P3[2] = frame.z(x, y, h);
    return P3;
  };
  // how much of a car at s is drawn: 1 on the deck, 0 past its ends
  const onDeck = (s) => smooth(B.s_south_end, B.s_south_end + END_FADE, s) * (1 - smooth(B.s_north_end - END_FADE, B.s_north_end, s));

  // (DYS-149 CF: SF local time for the flow and the swing lane, as clock.js sfTime() makes it (the same offset, day,
  // seconds, hour and day type) without its new object of 17 fields: a cell's check asked for it three times, and the
  // first state (the hidden warm-up frame) checks every cell on the deck and solves both days' speeds, 12-14 ms of it
  // on the slow laptop (bt1-1521 traces). One object, rewritten; read at once, before the next call)
  const lt = { day: 0, sec: 0, hour: 0, dayType: "" };
  let ltT = NaN;
  function sfTime(T) {
    if (T !== ltT) {
      const off = utcOffset(T), L = T + off, day = Math.floor(L / 86400), sec = L - day * 86400;
      ltT = T; lt.day = day; lt.sec = sec; lt.hour = sec / 3600; lt.dayType = sfDay(day).dayType;
    }
    return lt;
  }

  // ---------------- flow (vehicles an hour, one direction: 0 south, 1 north)
  function hourly(d, h, dir) {
    let f = BRIDGE_SCALE.total;
    if (d.dayType === "weekday") {
      if (dir === 0 && BRIDGE_SCALE.sbAmHours.includes(h)) f = BRIDGE_SCALE.sbAm;
      if (dir === 1 && BRIDGE_SCALE.nbPmHours.includes(h)) f = BRIDGE_SCALE.nbPm;
    }
    return BRIDGE_HOURLY[d.dayType][h][dir] * f;
  }
  // Piecewise linear between hour centres, with knot values solved so that each hour's mean equals its table value
  // (plain interpolation would add 10-17% to the hour before a steep rise). Solved over three days, cached per day.
  const knotCache = [new Map(), new Map()];
  function knotsFor(day, dir) {
    let k = knotCache[dir].get(day);
    if (k) return k;
    const q = [];
    for (let d = day - 1; d <= day + 1; d++) { const info = sfDay(d); for (let h = 0; h < 24; h++) q.push(hourly(info, h, dir)); }
    let x = q.slice();
    for (let it = 0; it < 40; it++) {
      const y = x.slice();
      for (let i = 1; i < q.length - 1; i++) y[i] = Math.max(0, (q[i] - 0.125 * (x[i - 1] + x[i + 1])) / 0.75);
      x = y;
    }
    k = x.slice(23, 49);     // day's hours -1 .. 24
    if (knotCache[dir].size > 16) knotCache[dir].clear();
    knotCache[dir].set(day, k);
    return k;
  }
  function flow(T, dir) {
    const t = sfTime(T);
    const x = Math.min(t.hour, 23.999) - 0.5, h0 = Math.floor(x), u = x - h0;
    const k = knotsFor(t.day, dir);
    return k[h0 + 1] + (k[h0 + 2] - k[h0 + 1]) * u;
  }
  // which direction the swing lane carries for a car entering at T: 0 south, 1 north, -1 closed (barrier moving)
  function swing(T) {
    const t = sfTime(T);
    if (t.dayType !== "weekday") return 1;
    const [a, b] = BRIDGE_LANES.swingSb, c = BRIDGE_LANES.closure;
    if (t.sec >= a && t.sec < b) return 0;
    if ((t.sec >= a - c && t.sec < a) || (t.sec >= b && t.sec < b + c)) return -1;
    return 1;
  }
  const lanesFor = (T, dir) => (dir === 0 ? 3 + (swing(T) === 0 ? 1 : 0) : 2 + (swing(T) === 1 ? 1 : 0));
  const perLane = (T, dir) => flow(T, dir) / lanesFor(T, dir);
  const vRaw = (T, dir) => BT.v0 * (1 - BT.slow * Math.min(1, perLane(T, dir) / BT.capacity) ** 2);

  // ---------------- closed-form motion of each direction's frame
  const K = BT.v0 * DAY, N = DAY / BT.knot;
  const dayCache = [new Map(), new Map()];
  function knots(n, dir) {
    let c = dayCache[dir].get(n);
    if (c) return c;
    const v = new Float64Array(N + 1), cum = new Float64Array(N + 1);
    for (let j = 0; j <= N; j++) v[j] = vRaw(n * DAY + j * BT.knot, dir);
    let I = 0;
    for (let j = 0; j < N; j++) I += ((v[j] + v[j + 1]) / 2) * BT.knot;
    const k = K / I;
    for (let j = 0; j <= N; j++) v[j] *= k;
    for (let j = 0; j < N; j++) cum[j + 1] = cum[j] + ((v[j] + v[j + 1]) / 2) * BT.knot;
    c = { v, cum };
    if (dayCache[dir].size > 16) dayCache[dir].clear();
    dayCache[dir].set(n, c);
    return c;
  }
  function X(T, dir) {
    const n = Math.floor(T / DAY), r = T - n * DAY, { v, cum } = knots(n, dir);
    const j = Math.min(N - 1, Math.floor(r / BT.knot)), tau = r - j * BT.knot;
    return n * K + cum[j] + v[j] * tau + ((v[j + 1] - v[j]) * tau * tau) / (2 * BT.knot);
  }
  function speed(T, dir) {
    const n = Math.floor(T / DAY), r = T - n * DAY, { v } = knots(n, dir);
    const j = Math.min(N - 1, Math.floor(r / BT.knot)), u = (r - j * BT.knot) / BT.knot;
    return v[j] + (v[j + 1] - v[j]) * u;
  }
  // the time the frame reached coordinate c (inverse of X, exact)
  function Xinv(c, dir) {
    const n = Math.floor(c / K), r = c - n * K, { v, cum } = knots(n, dir);
    let lo = 0, hi = N;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= r) lo = m; else hi = m; }
    const d = r - cum[lo], a = (v[lo + 1] - v[lo]) / (2 * BT.knot), b = v[lo];
    const tau = (2 * d) / (b + Math.sqrt(Math.max(0, b * b + 4 * a * d)));
    return n * DAY + lo * BT.knot + tau;
  }

  // the chance a cell entering at time t holds a vehicle (t quantised to 15 s, so the decision is a pure function)
  // (DYS-149 CF: kept by its 15 s and direction, as the cells are: at 20 m/s about ten cells share one)
  const dens = [new Map(), new Map()];
  function density(t, dir) {
    const tq = Math.floor(t / 15) * 15, m = dens[dir];
    let p = m.get(tq);
    if (p === undefined) {
      p = Math.min(0.9, (perLane(tq, dir) / 3600) * BT.cell / speed(tq, dir));
      if (m.size > 4096) m.clear();
      m.set(tq, p);
    }
    return p;
  }

  // lanes: [w, direction, swing?]
  const lanes = [];
  for (const w of B.lanes) {
    if (w === B.reversible) { lanes.push([w, 0, true], [w, 1, true]); continue; }
    lanes.push([w, w > 0 ? 1 : 0, false]);
  }
  const laneId = (w, dir) => Math.round(w * 10) * 2 + dir + 1000;

  // (DYS-149 CF: whether a cell holds a vehicle is decided once, a pure function of its lane and number: kept, so a
  // frame checks only the cells that rolled on since the last, not the deck's ~650 again)
  const held = lanes.map(() => new Map());
  function present(li, k) {
    const m = held[li];
    let p = m.get(k);
    if (p === undefined) {
      p = decide(li, k);
      if (m.size > 4096) m.clear();
      m.set(k, p);
    }
    return p;
  }
  function decide(li, k) {
    const [w, dir, isSwing] = lanes[li];
    const f = laneV(w), t = Xinv((k * BT.cell) / f, dir);
    if (isSwing && swing(t) !== dir) return 0;
    const id = laneId(w, dir);
    return u01(SEED.bridge, id, k, 1) < density(t, dir) / f ? 1 : 0;
  }

  // (DYS-266 zoom-gc: keep, city.js state()'s for the outside's own calls: no new record, id or draws a vehicle a frame.
  // Each lane's cells in a ring by their number, with what is fixed for a cell (whether it holds a vehicle, present()'s
  // pure answer; its id, kind, length, tint, model, paint and jitter draws); the records written into one of two kept
  // sets in turn, so the state before stays as it was while the next is made. The same numbers, the same keys in the
  // same order. Any other call (the sound's, every node tool) as before; ?gcdiet=0: as before)
  const RING = 256, ring = lanes.map(() => ({ k: new Float64Array(RING).fill(NaN), c: [] })), KEPT = [[], []], RECS = [[], []];
  let kpar = 0;
  function cellOf(li, k) {
    const R = ring[li], j = ((k % RING) + RING) % RING;
    let c = R.c[j];
    if (c && R.k[j] === k) return c;
    if (!c) c = R.c[j] = { p: 0, id: "", heavy: false, jo: 0, per: 0, jp: 0, len0: 0, tint: 0, type: "", model: "", paint: 0, len: 0 };
    R.k[j] = k;
    c.p = present(li, k);
    if (!c.p) return c;
    const w = lanes[li][0], dir = lanes[li][1], idj = TRAFFIC_REAL ? laneId(w, dir) : 0, id = laneId(w, dir);
    if (TRAFFIC_REAL) {
      c.jo = JIT.off * (2 * u01(SEED.bridge, idj, k, 6) - 1);
      c.per = JIT.period[0] + (JIT.period[1] - JIT.period[0]) * u01(SEED.bridge, idj, k, 7);
      c.jp = u01(SEED.bridge, idj, k, 8);
    }
    c.id = `v${id}:${k}`;
    c.heavy = u01(SEED.bridge, id, k, 2) < BT.heavy;
    c.len0 = c.heavy ? 12 + 6 * u01(SEED.bridge, id, k, 3) : 4.5;
    c.tint = u01(SEED.bridge, id, k, 4);
    if (TRAFFIC_REAL) {
      const r = u01(SEED.bridge, id, k, 9);
      const ty = c.heavy ? (r < 0.5 ? "bus" : "boxtruck") : FL.mix[pickW(FL.mix, r)][1], P = FL.types[ty];
      c.type = ty;
      c.model = ty === "bus" ? "muni" : P.models[pickW(P.models, u01(SEED.bridge, id, k, 10))][1];
      c.paint = ty === "bus" ? 0 : pickW(CAR_PAINT, u01(SEED.bridge, id, k, 11));
      c.len = P.len || FL.lenOf[c.model];
    }
    return c;
  }
  function atKept(T) {
    const out = KEPT[kpar], recs = RECS[kpar];
    kpar ^= 1;
    let n = 0;
    const X0 = X(T, 0), X1 = X(T, 1);
    for (let li = 0; li < lanes.length; li++) {
      const w = lanes[li][0], dir = lanes[li][1];
      const x = (dir ? X1 : X0) * laneV(w);
      const k0 = Math.ceil((x - L) / BT.cell), k1 = Math.floor(x / BT.cell);
      for (let k = k0; k <= k1; k++) {
        const c = cellOf(li, k);
        if (!c.p) continue;
        let u = x - k * BT.cell;
        if (TRAFFIC_REAL) u += c.jo + JIT.wob * Math.sin(2 * Math.PI * (T / c.per + c.jp));
        const s = dir === 1 ? S0 + u : S1 - u;
        const deck = onDeck(s);
        if (deck <= 0) continue;
        const p = pointTo(s, w, deckBottom(s) + B.truss + B.car_light), px = p[0], py = p[1], pz = p[2];
        let v = recs[n];
        if (!v) v = recs[n] = TRAFFIC_REAL
          ? { id: "", kind: "", dir: "", lane: 0, s: 0, x: 0, y: 0, z: 0, heading: 0, len: 0, light: "", tint: 0, alpha: 0, type: "", model: "", paint: 0, zRoad: 0, railW: 0 }
          : { id: "", kind: "", dir: "", lane: 0, s: 0, x: 0, y: 0, z: 0, heading: 0, len: 0, light: "", tint: 0, alpha: 0 };
        v.id = c.id; v.kind = c.heavy ? "heavy" : "car"; v.dir = dir ? "nb" : "sb"; v.lane = w; v.s = s;
        v.x = px; v.y = py; v.z = pz; v.heading = dir ? B.bearing : (B.bearing + 180) % 360;
        v.len = c.len0; v.light = dir ? "tail" : "head"; v.tint = c.tint; v.alpha = Math.min(1, u / 40, (L - u) / 40) * deck;
        if (TRAFFIC_REAL) {
          v.type = c.type; v.model = c.model; v.paint = c.paint; v.len = c.len;
          v.zRoad = frame.z(px, py, deckBottom(s) + B.truss + B.road);
          v.railW = Math.max(0, B.cable_w - w);
        }
        out[n++] = v;
      }
    }
    out.length = n;
    return out;
  }

  // ---------------- the vehicles on the bridge at T
  function at(T, keep = false) {
    if (keep && GC_DIET) return atKept(T);
    const out = [];
    const Xd = [X(T, 0), X(T, 1)];
    for (let li = 0; li < lanes.length; li++) {
      const [w, dir] = lanes[li];
      const x = Xd[dir] * laneV(w);                    // (traffic-real: the lane's own frame, LANE_V)
      const k0 = Math.ceil((x - L) / BT.cell), k1 = Math.floor(x / BT.cell);
      for (let k = k0; k <= k1; k++) {
        if (!present(li, k)) continue;
        let u = x - k * BT.cell;                         // metres since the car rolled on
        // (traffic-real: off its cell's centre, drifting; idj its lane's id, as below)
        const idj = TRAFFIC_REAL ? laneId(w, dir) : 0;
        if (TRAFFIC_REAL) u += JIT.off * (2 * u01(SEED.bridge, idj, k, 6) - 1)
          + JIT.wob * Math.sin(2 * Math.PI * (T / (JIT.period[0] + (JIT.period[1] - JIT.period[0]) * u01(SEED.bridge, idj, k, 7)) + u01(SEED.bridge, idj, k, 8)));
        const s = dir === 1 ? S0 + u : S1 - u;
        const deck = onDeck(s);
        if (deck <= 0) continue;                         // off the deck: the road is out of view there
        const id = laneId(w, dir);
        const heavy = u01(SEED.bridge, id, k, 2) < BT.heavy;
        let px, py, pz;
        if (GC_DIET) { const p = pointTo(s, w, deckBottom(s) + B.truss + B.car_light); px = p[0]; py = p[1]; pz = p[2]; }
        else [px, py, pz] = point(s, w, deckBottom(s) + B.truss + B.car_light);
        const veh = {
          id: `v${id}:${k}`, kind: heavy ? "heavy" : "car", dir: dir ? "nb" : "sb", lane: w, s,
          x: px, y: py, z: pz, heading: dir ? B.bearing : (B.bearing + 180) % 360,
          len: heavy ? 12 + 6 * u01(SEED.bridge, id, k, 3) : 4.5, light: dir ? "tail" : "head",
          tint: u01(SEED.bridge, id, k, 4), alpha: Math.min(1, u / 40, (L - u) / 40) * deck,
        };
        if (TRAFFIC_REAL) {
          // (traffic-real: its type, model and paint as streets-lib.js makeVehicle draws them; the road under it)
          const r = u01(SEED.bridge, id, k, 9);
          const ty = heavy ? (r < 0.5 ? "bus" : "boxtruck") : FL.mix[pickW(FL.mix, r)][1], P = FL.types[ty];
          veh.type = ty;
          veh.model = ty === "bus" ? "muni" : P.models[pickW(P.models, u01(SEED.bridge, id, k, 10))][1];
          veh.paint = ty === "bus" ? 0 : pickW(CAR_PAINT, u01(SEED.bridge, id, k, 11));
          veh.len = P.len || FL.lenOf[veh.model];
          veh.zRoad = frame.z(px, py, deckBottom(s) + B.truss + B.road);
          // (and how far it is inside the deck's east railing, the window's side, at the cables' line: outside-events.js hides
          // what of it the railing hides from the window)
          veh.railW = Math.max(0, B.cable_w - w);
        }
        out.push(veh);
      }
    }
    return out;
  }

  // vehicles crossing midspan in [T0, T1), by direction (for the week simulation)
  function crossings(T0, T1) {
    const n = [0, 0];
    for (let li = 0; li < lanes.length; li++) {
      const [, dir] = lanes[li];
      const um = dir === 1 ? -S0 : S1;                  // u at s = 0
      const a = X(T0, dir) - um, b = X(T1, dir) - um;
      for (let k = Math.ceil(a / BT.cell); k * BT.cell < b; k++) n[dir] += present(li, k);
    }
    return n;
  }

  return { at, crossings, flow, speed, X, Xinv, lanesFor, swing, point, deckBottom, onDeck, S0, S1 };
}
