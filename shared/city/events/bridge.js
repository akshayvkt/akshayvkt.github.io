// Event 1: Golden Gate Bridge traffic.
//
// Each direction's traffic moves as one frame along its lanes: X(T), the distance a car has travelled since 1970, is
// a closed-form integral of a speed that sags a little at the peaks (piecewise linear between UTC quarter hours,
// each UTC day normalised to the same total, so X is continuous for ever). Lanes are cut into 30 m cells that ride
// that frame. A cell holds a vehicle when hash(lane, cell) < q * 30 m / v, with q (vehicles an hour per lane) and v
// taken at the moment the cell rolls onto the bridge: decided once, it never changes while the car is on the deck.
import { BRIDGE_HOURLY, BRIDGE_SCALE, BRIDGE_LANES, BRIDGE_TRAFFIC as BT } from "../tables.js";
import { sfTime, sfDay } from "../clock.js";
import { u01, SEED } from "../hash.js";
import { smooth } from "../geo.js";

const DEG = Math.PI / 180;
const DAY = 86400;
// Cars are drawn on the deck only: they fade in over the last END_FADE metres at each end, where the road leaves the
// view (into the Presidio's trees toward the toll plaza; off the north viaduct toward Vista Point and the Waldo grade).
// Measured on the cloud panorama (2026-10-16): the deck shows to s -1330 m in the south and to the viaduct's end in
// the north; the cells still ride the whole frame S0..S1, so the timing and the week simulation are unchanged.
const END_FADE = 40;

// build.py deck_w(s): the deck centreline's offset east of the axis (routes.json bridge.deck_curve), clamped at both
// ends as numpy's interp is; 0 between the anchorages
export function deckOffset(curve, s) {
  if (!curve || !curve.length) return 0;
  if (s <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (s <= curve[i][0]) {
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
  // how much of a car at s is drawn: 1 on the deck, 0 past its ends
  const onDeck = (s) => smooth(B.s_south_end, B.s_south_end + END_FADE, s) * (1 - smooth(B.s_north_end - END_FADE, B.s_north_end, s));

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
  function density(t, dir) {
    const tq = Math.floor(t / 15) * 15;
    return Math.min(0.9, (perLane(tq, dir) / 3600) * BT.cell / speed(tq, dir));
  }

  // lanes: [w, direction, swing?]
  const lanes = [];
  for (const w of B.lanes) {
    if (w === B.reversible) { lanes.push([w, 0, true], [w, 1, true]); continue; }
    lanes.push([w, w > 0 ? 1 : 0, false]);
  }
  const laneId = (w, dir) => Math.round(w * 10) * 2 + dir + 1000;

  function present(li, k) {
    const [w, dir, isSwing] = lanes[li];
    const t = Xinv(k * BT.cell, dir);
    if (isSwing && swing(t) !== dir) return 0;
    const id = laneId(w, dir);
    return u01(SEED.bridge, id, k, 1) < density(t, dir) ? 1 : 0;
  }

  // ---------------- the vehicles on the bridge at T
  function at(T) {
    const out = [];
    const Xd = [X(T, 0), X(T, 1)];
    for (let li = 0; li < lanes.length; li++) {
      const [w, dir] = lanes[li];
      const x = Xd[dir];
      const k0 = Math.ceil((x - L) / BT.cell), k1 = Math.floor(x / BT.cell);
      for (let k = k0; k <= k1; k++) {
        if (!present(li, k)) continue;
        const u = x - k * BT.cell;                       // metres since the car rolled on
        const s = dir === 1 ? S0 + u : S1 - u;
        const deck = onDeck(s);
        if (deck <= 0) continue;                         // off the deck: the road is out of view there
        const id = laneId(w, dir);
        const heavy = u01(SEED.bridge, id, k, 2) < BT.heavy;
        const [px, py, pz] = point(s, w, deckBottom(s) + B.truss + B.car_light);
        out.push({
          id: `v${id}:${k}`, kind: heavy ? "heavy" : "car", dir: dir ? "nb" : "sb", lane: w, s,
          x: px, y: py, z: pz, heading: dir ? B.bearing : (B.bearing + 180) % 360,
          len: heavy ? 12 + 6 * u01(SEED.bridge, id, k, 3) : 4.5, light: dir ? "tail" : "head",
          tint: u01(SEED.bridge, id, k, 4), alpha: Math.min(1, u / 40, (L - u) / 40) * deck,
        });
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
