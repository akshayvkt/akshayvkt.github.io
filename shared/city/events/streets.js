// Event 1b: the streets' traffic (routes.json streets; tables.js STREET_*), one simulation for every visitor, a function
// of T alone: runs start empty every STREET_IDM.period s, the next taking over; hashed draws, the stepping + - * / sqrt.
import { STREET_SIGNALS as SG, STREET_TRAFFIC as ST, STREET_IDM as IDM, STREET_FLEET as FL, STREET_LC as LC, STREET_TURN as TU, STREET_BUS as BU, STREET_PARK as PK, STREET_STOPS as SS } from "../tables.js";
import { smooth } from "../geo.js";
import { END_FADE, rg, hs, mod, sfAt, buildStreets, flows, lanesOpen, light, buses, makeVehicle, drift, idm, acc, ld, shows } from "./streets-lib.js";

const { min, max, abs } = Math, DEG = Math.PI / 180;
// (DYS-149 SL, ?streetsplit=0 off: on the page a simulation the street starts from empty -- a jump's quick street, its
// full ones, each anchor's next -- is stepped to the clock in a worker (streets-worker.js) and sent back whole; only
// the few steps since it was asked are left for the page's frames. Not in a worker or node: no worker of its own)
const SPLIT = typeof document !== "undefined" && typeof Worker !== "undefined" && new URLSearchParams(location.search || "").get("streetsplit") !== "0";

// opt.far: the check's stand-in for the worker (scripts/city_clock/streets_split_same.mjs); null: none
export function createStreets(routes, frame, opt = {}) {
  const R = routes.streets || { streets: [] };
  const offset = R.lane_offset_m ?? 2.6, lift = R.lift_m ?? 0.9;
  const streets = buildStreets(R, offset), flow = flows(streets), { trips, busDue } = buses(R);
  // (the links into each street: [the street before, its link])
  const feeds = streets.map(() => []), links = streets.map((S) => S.X.filter((e) => e[3] != null));
  streets.forEach((S, k) => links[k].forEach((e) => feeds[e[3]].push([k, e])));
  // (a fed street's bus runs from its start that come on through a link; the others start at its F)
  streets.forEach((S, i) => { if (S.fed) S.fb = new Set(feeds[i].flatMap(([k]) => streets[k].U.map((u) => u[0]))); });

  // ---- a simulation
  function newSim(t0) {
    return { t: t0, lanes: streets.map((S) => Array.from({ length: S.nMax }, () => ({ cars: [], wait: [], out: [] }))), ent: streets.map((S) => S.E.map(() => [])), tr: [], crossings: null };
  }
  // its way off past s (none: the end), a bus's stops or (M5) a short stop at the kerb on the way
  function exitOf(S, c, s) {
    c.x = null;
    if (c.r) {
      const b = S.U.find((b) => b[0] === c.r && b[1] <= s + 1);
      c.st = b ? b[3].filter((x) => x > s + 9) : [];
      if (b && b[2] < S.L - 1) c.x = [b[2], -1, 0];
      else for (const e of S.X) if (e[3] != null && streets[e[3]].U.some((u) => u[0] === c.r && u[1] < 1)) c.x = e;
    } else if (!S.bike) {
      c.st = 0;
      for (let j = 0; j < S.X.length; j++) if (S.X[j][0] > s + 10 && hs(c.n, j, 23) < S.X[j][2]) { c.x = S.X[j]; break; }
      const P = S.pk && S.pk.filter((x) => x > s + 40 && (!c.x || x < c.x[0] - 20));
      if (P?.length && hs(c.n, 1, 60) < S.pc) c.st = [P[(hs(c.n, 1, 61) * P.length) | 0]];
    }
  }
  const laneOf = (e, open) => (e[1] < 0 ? open - 1 : min(e[1], open - 1));
  // (M4b: beside a lane. One pulled in a lane width out stands in the next lane: kw, the nearest such in X ahead of s;
  // inK, the nearest ahead in X itself. One pulling out (lc.d < 0) is still partly beside it: po, the nearest ahead;
  // kw counts one pulling out of the next lane too until it is out (Lombard's kerb lane opening at 07:00 under a bus))
  const kwy = (o, t) => o.y === ST.laneW || (o.lc?.d === -ST.laneW && t < o.lc.t0 + o.lcd);
  const kw = (X, s, t) => { let o; if (X) for (let k = X.cars.length - 1; k >= 0; k--) { o = X.cars[k]; if (kwy(o, t) && o.s > s) return o; } };
  const inK = (X, s) => { if (X) for (let k = X.cars.length - 1; k >= 0; k--) if (X.cars[k].s > s) return X.cars[k]; };
  const po = (cars, j) => { for (let k = j - 1; k >= 0; k--) if (cars[k].lc?.d < 0) return cars[k]; };
  // room to pull in: none pulled in or pulling out beside it or within a following gap ahead; a lane width out, that
  // lane clear by it too
  const room = (c, cars, y, R, a = c.s - c.len - 2, b = c.s + c.s0 + c.v * c.T) => !cars.some((o) => o !== c && (o.y || o.lc?.d < 0) && o.s > a && o.s - o.len < b) &&
    !(y === ST.laneW && R && R.cars.some((o) => o.s > c.s - c.len - 10 && o.s - o.len < c.s + 25));
  // (a fed street's own arrival on at F, hidden: room ahead, behind and beside, as a car turning on)
  function onAt(S, N, li, c, t) {
    const s1 = S.F, Y = N[li], cars = Y.cars;
    let m = 0;
    while (m < cars.length && cars[m].s > s1) m++;
    const L = cars[m - 1], F = cars[m];
    c.s = c.sPrev = s1; c.v0 = c.v0b * (1 + IDM.drift[0] * drift(t / c.tau + c.phi)); c.v = L ? min(c.v0, L.v) : c.v0;
    if ((L && L.s - L.len - s1 < c.s0 + c.len + L.v * c.T * 0.6) || (F && (s1 - c.len - F.s < F.s0 + F.v * F.T * 0.6 || acc(F, c) < -TU.bIn))) return false;
    if (Y.out.some((g) => abs(g.s - s1) < LC.clear)) return false;
    const K2 = kw(N[li - 1], s1 - c.len - 2, t);
    if (K2 && K2.s - K2.len - s1 < c.s0 + c.v * c.T) return false;
    exitOf(S, c, s1); cars.splice(m, 0, c);
    return true;
  }
  // (DYS-149 fix 2: each street's flow, arrivals and lanes open, worked out once a step: before, the street's own loop,
  // every link into it, every street it feeds and every car near a feed's end asked again, at the same t)
  const fl = new Float64Array(streets.length), qv = new Float64Array(streets.length), op = new Float64Array(streets.length);
  function step(sim) {
    const t = sim.t, dt = IDM.dt, d = sfAt(t), tk = FL.truck[min(23, d.hour | 0)] * (d.dayType === "weekday" ? 1 : FL.truckWeekend);
    for (let i = 0; i < streets.length; i++) {
      fl[i] = flow(i, t); op[i] = lanesOpen(streets[i], t);
      qv[i] = max(0, fl[i] - streets[i].U.reduce((a, b) => a + trips(b, d.day, d.hour | 0), 0));
    }
    for (let i = 0; i < streets.length; i++) {
      const S = streets[i], N = sim.lanes[i], open = op[i], q = qv[i], mid = S.L / 2, kb = open > 1 && S.r.road !== "motorway", tq = tk * (FL.truckBy[S.r.road] ?? 1);
      for (const e of S.X) if (e[3] != null) e[2] = min(e[4], fl[e[3]] / max(q, 1));
      S.pc = S.pk ? PK.rate[d.hour | 0] / max(q, 30) : 0;
      // (fed: its own arrivals, its flow less what its links bring, each feeder q x its link's chance)
      const qn = S.fed ? max(0, q - feeds[i].reduce((a, [k, e]) => { const qk = qv[k]; return a + min(e[4], fl[i] / max(qk, 1)) * qk; }, 0)) : q;
      // (C 22:1x: one bound for a link and not yet in its lane weighs a change every time, not `consider` of them, and its
      // lane's pull in K grows inside the last 400 m (x 400 / the distance left): 18 % of westbound Lombard's for the
      // Presidio missed it, the Presidio's Lombard -8.8 %)
      if (open > 1 && t % LC.every === 0) {
        // lane changes (MOBIL)
        // (in a link's lane the next street's last vehicle leads, its rear maybe still here)
        // (DYS-149 fix 2: these four made only on the steps that weigh lane changes, one in four)
        const vl = (c, k, e = c.x, Z = e && e[3] != null && k === laneOf(e, open) && e[0] - c.s < 150 && sim.lanes[e[3]][0].cars, Y = Z && Z[Z.length - 1]) => Y && { s: e[0] + Y.s, len: Y.len, v: Y.v };
        const tl = (c) => { const e = c.x; return !c.r && c.st?.length && c.st[0] - c.s < TU.look ? open - 1 : e && e[0] - c.s < (e[3] != null ? 1e9 : TU.look) ? laneOf(e, open) : -1; };
        // (after-3: a driver's own wish for the next lane left / right in this 30 s, cars and motorbikes; none who has
        // a lane to be in, for a turn off or a link ahead: wandering out of it lost the Presidio's Lombard 1 % of its cars)
        const wv = (c, u = hs(c.n, (t / LC.wanderT) | 0, 68)) => (c.kind === "heavy" || u >= LC.wanderShare || tl(c) >= 0 ? 0 : u < LC.wanderShare / 2 ? -LC.wander : LC.wander);
        const K = (c, k, l = tl(c)) => (l < 0 ? kb && k === open - 1 ? (c.kind === "heavy" || c.v0b < LC.slow * S.vm ? LC.kerb[1] : -LC.kerb[0]) : 0 : -TU.gain * abs(k - l) * (c.x?.[3] != null ? max(1, 400 / max(c.x[0] - c.s, 20)) : 1));
        for (let li = 0; li < S.nMax; li++) {
          const cars = N[li].cars;
          for (let j = 0; j < cars.length; j++) {
            const c = cars[j], L = cars[j - 1], F = cars[j + 1];
            if (c.lc || c.type === "bus" || c.v < LC.vMin || c.s < END_FADE || c.s > S.L - LC.endClear || hs(c.n, t, 21) >= (c.x?.[3] != null && laneOf(c.x, open) !== li ? 1 : LC.consider) || S.sig.some((G) => c.s > G[0] - LC.noSig[0] && c.s < G[0] + LC.noSig[1])) continue;
            const dF = F ? acc(F, L) - acc(F, c) : 0, a0 = acc(c, L);
            let B = null, bg = LC.thr;
            for (const k of [li - 1, li + 1]) {
              if (k < 0 || k >= open) continue;
              const Y = N[k], X = Y.cars;
              let m = 0;
              while (m < X.length && X[m].s > c.s) m++;
              let L2 = X[m - 1] || vl(c, k), P2 = kw(N[k - 1], c.s - c.len - 2, t);
              if (P2 && (!L2 || P2.s < L2.s)) L2 = P2;
              const F2 = X[m], a1 = acc(c, L2), aN = F2 ? acc(F2, c) : 0;
              if (a1 < -LC.bSafe || aN < -LC.bSafe || Y.out.some((g) => abs(g.s - c.s) < LC.clear) || (L2 && L2.s - L2.len - c.s < c.s0 / 2) || (F2 && c.s - c.len - F2.s < F2.s0 / 2)) continue;
              const g = a1 - a0 + c.p * (dF + (F2 ? aN - acc(F2, L2) : 0)) + (k - li) * (LC.right + wv(c)) + K(c, k) - K(c, li) + (li >= open ? LC.closed : 0);
              if (g > bg) { bg = g; B = [k, m]; }
            }
            if (B) { cars.splice(j--, 1); N[B[0]].cars.splice(B[1], 0, c); N[li].out.push(c); c.lc = { f: li, t0: t, L }; }
          }
        }
      }
      // (each open lane's share of new arrivals; DYS-149 fix 2: summed once a street, not again each lane)
      const wl = (k) => (kb && k === open - 1 ? LC.kerbShare : 1) * (k === 0 && open > 1 ? LC.inner : 1);
      let wsum = 0; for (let k = 0; k < open; k++) wsum += wl(k);
      if (S.U.length) for (const w of busDue(S, t, t + dt)) w.b[4] < 0 ? (S.fed && S.fb.has(w.b[0])) || N[open - 1].wait.push(w) : sim.ent[i][w.b[4]].push(w);
      for (let li = 0; li < S.nMax; li++) {
        const lane = N[li];
        if (li < open) {
          const p = min(0.5, ((qn * wl(li)) / wsum / 3600) * IDM.slot);
          for (let k = Math.ceil(t / IDM.slot); k * IDM.slot < t + dt; k++) if (hs(S.key * 4 + li, k | 0, 1) < p && lane.wait.length < 400) lane.wait.push({ slot: k });
        }
        while (lane.wait.length) {
          const last = lane.cars[lane.cars.length - 1];
          const w = lane.wait[0], c = w.c || (w.c = makeVehicle(S, li, w.slot, w.b, tq), exitOf(S, w.c, 0), w.c);
          if (S.fed) { if (!onAt(S, N, li, c, t)) break; lane.wait.shift(); continue; }
          if ((last ? last.s - last.len : Infinity) < c.s0 + c.len + (last ? last.v * c.T * 0.6 : 0)) break;
          c.v0 = c.v0b * (1 + IDM.drift[0] * drift(t / c.tau + c.phi));
          c.v = last ? min(c.v0, last.v) : c.v0;
          lane.wait.shift(); lane.cars.push(c);
        }
        const cars = lane.cars, Q = N[li - 1], R = N[li + 1], qy = Q?.cars.some((o) => kwy(o, t));
        for (let j = 0; j < cars.length; j++) {
          const c = cars[j], e = c.x, st = c.st;
          c.v0 = c.v0b * (1 + IDM.drift[0] * drift(t / c.tau + c.phi));
          const L0 = ld(cars, j);
          let a = acc(c, L0);
          // (de-grid: a stopped driver moves off its own moment after the one ahead does: heavies slower)
          if (c.v < 0.3) { if (c.go == null && L0 && L0.v > 0.3) c.go = t + rg(c.kind === "heavy" ? SG.goH : SG.go, hs(c.n, (t * 4) | 0, 67)); if (c.go != null && t < c.go) a = min(a, 0); } else c.go = null;
          if (c.y) { const o = po(cars, j), r = c.y === ST.laneW && inK(R, c.s), m = c.lc?.d > 0 && ld(cars, j, -1, false); if (o) a = min(a, acc(c, o)); if (r) a = min(a, acc(c, r)); if (m) a = min(a, acc(c, m)); }
          else if (qy) { const o = kw(Q, c.s, t); if (o) a = min(a, acc(c, o)); }
          if (c.lc || lane.out.length) for (const g of c.lc && t < c.lc.t0 + c.lcd ? [...lane.out, c.lc.L] : lane.out) if (g && !g.g && g.s > c.s && g.s < S.L) a = min(a, acc(c, g));
          if (e && e[0] - c.s < 150) {
            const Z = e[3] != null && sim.lanes[e[3]][0].cars, Y = Z && Z[Z.length - 1];
            if (!Z) a = min(a, idm(c, e[0] + 10 - c.s, c.v - TU.v));
            else if (Y && li === laneOf(e, open)) a = min(a, acc(c, { s: e[0] + Y.s, len: Y.len, v: Y.v }));
          }
          // (in a link's lane: the next street's last vehicle while its rear is still on this road; just on from a
          // branch: the vehicle ahead on the road it came from)
          for (const f of links[i]) if (f !== e && li === laneOf(f, open) && f[0] > c.s && f[0] - c.s < 150) {
            const Z = sim.lanes[f[3]][0].cars, Y = Z[Z.length - 1];
            if (Y && Y.s < Y.len) a = min(a, acc(c, { s: f[0] + Y.s, len: Y.len, v: Y.v }));
          }
          if (c.s < 20 && feeds[i].length) for (const [k, f] of feeds[i]) {
            const B = sim.lanes[k][laneOf(f, op[k])].cars;
            for (let m = B.length - 1; m >= 0; m--) if (B[m].s > f[0] + c.s) { a = min(a, acc(c, { s: B[m].s - f[0], len: B[m].len, v: B[m].v })); break; }
          }
          for (const G of S.sig) {
            const gap = G[0] - 1 - c.s;
            if (gap < -0.5) continue;
            // (a stop sign: to a halt at its line, a moment there, then on)
            if (!G[2]) {
              if (c.ss !== G[0]) {
                // (C2: most roll over the line, slowed to their own crawl)
                const vr = hs(c.n, G[0] | 0, 64) < SS.full ? 0 : rg(SS.roll, hs(c.n, G[0] | 0, 65));
                if (vr) { if (gap < 1) c.ss = G[0]; else if (c.v > vr) a = min(a, max(-c.b * 1.5, (vr * vr - c.v * c.v) / (2 * gap))); }
                else {
                  if (!c.sw && gap < c.s0 + 1 && c.v < 0.3) c.sw = t + rg(SS.wait, hs(c.n, G[0] | 0, 63));
                  if (c.sw && t >= c.sw) { c.ss = G[0]; c.sw = 0; } else a = min(a, idm(c, max(gap, 0.1), c.v));
                }
              }
              break;
            }
            const l = light(G, t), need = (c.v * c.v) / (2 * max(gap, 0.1));
            // (the swarm: a queue's first car starts its own start-up time after the green, so each lane leaves alone)
            if (l === 0 && c.v < 0.5 && gap < c.s0 + 2 && mod(t - G[1], SG.cycle) < rg(SG.react, hs(c.n, G[0] | 0, 66))) a = min(a, idm(c, max(gap, 0.1), c.v));
            // (C2: to the line no harder than the stop needs, or the driver's own comfortable braking)
            if ((l === 2 && need < SG.hard) || (l === 1 && need < c.b)) a = min(a, max(idm(c, max(gap, 0.1), c.v), -max(need * 1.2, c.b)));
            break;
          }
          // (a bus's stop; M5: a car's stop at the kerb, given up where there is no room: not in the kerb lane, Lombard's
          // kerb lane open (its tow-away hours), the space taken)
          if (st?.length) {
            const g = st[0] - c.s, F = c.y && ld(cars, j, 1, false), L = c.y && ld(cars, j, -1, false);
            if (c.y && c.w && t >= c.w && (!F || (c.s - c.len - F.s > F.s0 + F.v && acc(F, c) > -LC.bSafe)) && (!L || L.s - L.len - c.s > c.s0)) { c.lc = { f: li, t0: t, d: -c.y }; c.y = 0; }
            if (c.w ? t >= c.w && !c.y : g < -2) { st.shift(); c.w = 0; }
            else if (!c.r && !c.y && g < PK.pull && (li !== open - 1 || (S.py == null && open === S.nMax) || cars.some((o) => o.y && abs(o.s - st[0]) < PK.clear) || !room(c, cars, S.py ?? ST.laneW, R))) st.shift();
            else {
              if (!c.y && g < (c.r ? BU.pull : PK.pull) && li === open - 1 && (open < S.nMax || (c.r ? S.r.bay : S.py != null)) && room(c, cars, c.r || S.py == null ? ST.laneW : S.py, R)) { c.y = c.r || S.py == null ? ST.laneW : S.py; c.lc = { f: li, t0: t, d: c.y }; lane.out.push(c); }
              if (!c.w && g < 2 && c.v < 0.3) c.w = t + rg(c.r ? BU.dwell : PK.dwell, hs(c.n, st.length, 52));
              a = min(a, idm(c, max(g + c.s0, 0.1), c.v));
            }
          }
          c.a = max(-9, a);
        }
        if (lane.out.length) lane.out = lane.out.filter((g) => !g.g && t + dt < g.lc.t0 + g.lcd && g.s < S.L);
        for (const c of cars) {
          if (c.lc && t + dt >= c.lc.t0 + c.lcd + LC.cool) c.lc = null;
          c.sPrev = c.s;
          const v1 = c.v + c.a * dt, e = c.x;
          if (v1 < 0) { c.s += c.v > 0 ? (c.v * c.v) / (2 * max(-c.a, 1e-6)) : 0; c.v = 0; }
          else { c.s += (c.v + v1) * 0.5 * dt; c.v = v1; }
          if (sim.crossings && c.sPrev < mid && c.s >= mid) { const k = S.bike ? `${S.r.id}:bike` : S.r.id; sim.crossings[k] = (sim.crossings[k] || 0) + 1; }
          if (e && c.s >= e[0]) if (e[3] != null && li !== laneOf(e, open)) c.x = null;
          else { c.g = 1; if (c.lc) for (const Y of N) Y.out = Y.out.filter((g) => g !== c); if (e[3] != null) sim.tr.push([c, e]); }
        }
        if (cars.some((c) => c.g)) lane.cars = cars.filter((c) => !c.g);
        const C = lane.cars;
        if (C.some((c) => c.y)) for (let j = C.length - 1; j > 0; j--) if (C[j].s > C[j - 1].s) [C[j - 1], C[j]] = [C[j], C[j - 1]];
        while (C.length && C[0].s > S.L + 5) C.shift();
      }
      // turning on
      for (let j = 0; j < S.E.length; j++) {
        const [s, , p] = S.E[j], Q = sim.ent[i][j], le = laneOf(S.E[j], open), Y = N[le], cars = Y.cars, s1 = s + TU.ahead;
        for (let k = Math.ceil(t / IDM.slot); k * IDM.slot < t + dt; k++) if (Q.length < 4 && hs(S.key * 4 + 3, k | 0, 40 + j) < (p * q * IDM.slot) / 3600) Q.push(k);
        const G = S.sig.find((G) => abs(G[0] - s) < 25);
        if (!Q.length || (G && light(G, t) < 2) || Y.out.some((g) => abs(g.s - s1) < LC.clear)) continue;
        // (DYS-149 fix 2: the one waiting to turn on made once while it waits, not again each step it finds no room: the
        // same draws (its lane and the hour's truck share the same), dropped once it is on)
        const w = Q[0], mk = Q.mk, c = mk && mk[0] === w && mk[1] === le && mk[2] === tq ? mk[3] : (Q.mk = [w, le, tq, makeVehicle(S, le, w.b ? w.slot : w * 16 + j + 1, w.b, tq)])[3];
        let m = 0;
        while (m < cars.length && cars[m].s > s1) m++;
        const L = cars[m - 1], F = cars[m];
        c.s = c.sPrev = s1; c.v = TU.v; c.v0 = c.v0b;
        if ((L && L.s - L.len - s1 < c.s0 + TU.v * c.T) || (F && (s1 - c.len - F.s < F.s0 || acc(F, c) < -TU.bIn))) continue;
        // (nor beside or just behind one pulled in from the next lane, or pulling out of it)
        const K2 = kw(N[le - 1], s1 - c.len - 2, t);
        if (K2 && K2.s - K2.len - s1 < c.s0 + TU.v * c.T) continue;
        Q.shift(); Q.mk = null; exitOf(S, c, s1); cars.splice(m, 0, c);
      }
    }
    for (const [c, e] of sim.tr) {
      c.s -= e[0]; c.sPrev -= e[0]; c.g = 0; c.lc = null; c.f = 1;
      exitOf(streets[e[3]], c, 0); sim.lanes[e[3]][0].cars.push(c);
    }
    sim.tr = [];
    sim.t = t + dt;
    // (in a hand-over: first and last out of sight)
    // (DYS-39: or the page's own hand-over from a jump's quick simulation, sim.xw = [start, length])
    // (DYS-150: a full simulation's own hand-over first, timed from its start as on a page open for long; the quick
    // one's window only outside it. Timed from the load (a visitor's first 12 min), a car hidden between the load and
    // the hand-over counted as never hidden in it: swap() held its old copy to the hand-over's end)
    const w = (sim.a0 != null ? [sim.a0 + W - B, sim.a0 + W + P - B].find((x) => sim.t >= x && sim.t <= x + B) : null) ?? (sim.xw && sim.t >= sim.xw[0] && sim.t <= sim.xw[0] + sim.xw[1] ? sim.xw[0] : null);
    if (w) {
      // (C2, B 27 Oct: a vehicle that leaves this simulation inside the window (an exit, a route's end) is gone from
      // then; at() holds the next one's copy until it has been hidden after that, as if this one were still there)
      if (sim.gw !== w) { sim.gw = w; sim.gone = new Map(); sim.seen = null; }
      const now = new Map();
      // (DYS-150: one arriving in this simulation inside the window, hidden, was never drawn in it: hidden since its
      // start. Else the next one's copy, drawn till then with none here, was taken back in view as it arrived (the
      // quick simulation's own arrivals come later: Greenwich 47108592 17:38:22, Lincoln 529868660 17:44:11))
      for (let i = 0; i < streets.length; i++) for (const l of sim.lanes[i]) for (const c of l.cars) { now.set(c.id, c); if (shows(streets[i], c.s, c) <= 0.04) { if (!(c.h1 >= w)) c.h1 = sim.seen && !sim.seen.has(c.id) ? w : sim.t; c.hl = sim.t; } }
      // (its first hiding in the window if it had one, as while it was here; else the moment it left)
      if (sim.seen) for (const [id, c] of sim.seen) if (!now.has(id)) sim.gone.set(id, c.h1 >= w ? c.h1 : sim.t);
      sim.seen = now;
    }
  }
  const P = IDM.period, W = IDM.warmup, B = IDM.blend;
  const anchorFor = (T) => Math.floor((T - W) / P) * P;
  const newSimAt = (A) => Object.assign(newSim(A), { a0: A });
  // (from empty: at an anchor, or (a0 null) a jump's quick street from t0)
  const fromEmpty = (a0, t0) => (a0 != null ? newSimAt(a0) : Object.assign(newSim(t0), { a0: null, shown: false }));
  function advance(sim, T) { while (sim.t < T - 1e-9) step(sim); }
  const usable = (sim, A, T) => sim && sim.a0 === A && T >= sim.t - IDM.dt - 1e-6;
  let cur = null, nxt = null;

  function placed(sim, T) {
    const f = min(1, max(0, (T - (sim.t - IDM.dt)) / IDM.dt)), out = new Map();
    for (let i = 0; i < streets.length; i++) for (let li = 0; li < streets[i].nMax; li++) for (const c of sim.lanes[i][li].cars) out.set(c.id, { c, i, li, s: c.sPrev + (c.s - c.sPrev) * f });
    return out;
  }

  // (QUEUE T, B 28 Oct: on the page a jump -- the first visit, the dial, a tab back after long -- catches up a slice of
  // at most opt.budgetMs a frame instead of freezing the page for seconds (the candidate's 1.6-5.4 s); no street car is
  // drawn until it has, then they fade in over JUMP_FADE_MS. Without opt (every node tool and gate) nothing changes, and
  // the simulation that catches up is step for step the one an unbudgeted jump makes)
  const JUMP_FADE_MS = 1500, clockMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  let readyAt = -1e9;
  const pends = new Map();   // (a jump's full simulations, by anchor, while they catch up)
  // (DYS-149 SL4: stepMin, the fewest ms a step of a full street has taken here, a call's steps over its time: what the
  // street costs this machine's main thread; outside.js holds the cars through the hand-off where it is slow)
  let stepMin = Infinity;
  function budgeted(sim, T, ms, t0) {
    const a = clockMs();
    let n = 0;
    while (sim.t < T - 1e-9 && clockMs() - t0 < ms) { step(sim); n++; }
    if (n) stepMin = min(stepMin, (clockMs() - a) / n);
    return sim.t >= T - 1e-9;
  }

  // (DYS-39, Akshay 28 Oct: 'it takes traffic a couple seconds after a time is loaded'. A jump on the page caught this
  // anchor's simulation up from an empty street, 1320-1920 s of it, before drawing a car: 3-6 s, then the fade. Now a
  // quick simulation, started IDM.quickWarm s before the clock (a fifth of the steps), shows the street first; once the
  // full street has caught up (this anchor's simulation and, inside a hand-over, the next one too) it takes over from
  // the quick one across IDM.quickBlend s as a hand-over does. Without opt nothing changes)
  const QUICK_FADE_MS = 600, QUICK_MAX = 3;
  let quick = null, qx = null, fadeMs = JUMP_FADE_MS;
  const newQuick = (T) => fromEmpty(null, T - IDM.quickWarm);

  // (DYS-149 SL: the worker. LB1/LB2's slow-laptop traces: the catch-up was 1-8 ms of every frame through the 5 s after
  // room-shown (the frame's slice and the 1 ms each further simulation is given), a step ~2 ms at 6x, and no car drawn
  // by then: a jump is 6,500-14,000 steps from empty, at a slice a frame minutes of frames. In the worker the same
  // steps, the same code; the page gets each simulation at the clock it asked for and steps it on from there in its
  // slices as before. A handle { far } stands where the simulation will be (t: the clock asked for) until it comes;
  // never stepped, drawn or taken over. One asked at a time, the quick street first; one no longer wanted when the
  // worker is free (a newer jump, the dial) is never sent. If the worker fails, each is made here from empty, as before)
  let far = null, busy = null, seq = 0, lastT = -Infinity, xmap = null;
  // (DYS-149 SL2: opt.hold, the outside's (city.js streetsHold): the street not yet shown. Every simulation is kept up
  // with the clock as ever (its steps in the frame's slice), nothing is placed or drawn, and a fade-in starts no
  // earlier than the last held call (heldAt))
  let heldAt = -Infinity;
  // (DYS-149 SL3: with the worker or after a hold, the frame's catch-ups share its one slice, none given a 1 ms of its
  // own (SL2's slow laptop: 12-14 ms of steps in one frame as the worker's simulations landed); the next simulation,
  // not drawn, gets its 1 ms again only from NXT_LEAD s before its blend. After a hold the street is drawn only once
  // its drawn simulations are at the clock (wasHeld: caught up in that slice, frame by frame), and then over RAMP
  // frames (a growing share of the vehicles placed, deep in their fade-in: the first placement's per-vehicle work spread)
  const NXT_LEAD = 10, RAMP = 4;
  let wasHeld = false, rampN = RAMP;
  const queue = [];
  // (review: stop() also ends it for good, dispose: city.js, from outside.js dispose())
  const stop = () => { far?.terminate?.(); far = busy = null; queue.length = 0; };
  // (review: a request no longer wanted that has run FAR_CANCEL_MS -- the dial moved on -- ends with its worker: a new
  // one is started (no more than one in FAR_CANCEL_MS while the dial moves); busyAt: when the one running was sent)
  const FAR_CANCEL_MS = 250;
  let busyAt = 0;
  const startFar = () => {
    try {
      far = opt.far || new Worker(new URL("./streets-worker.js", import.meta.url), { type: "module" });
      far.onmessage = ({ data: r }) => {
        const h = busy;
        if (!h || r.id !== h.id) return;
        busy = null;
        if (r.error) { console.warn("[streets] worker:", r.error); stop(); return; }
        // (a vehicle's way off is an entry of its street's turn-offs, shared by every simulation: sent as its place)
        for (const [c, i, j] of r.xr) c.x = streets[i].X[j];
        h.sim = r.sim;
        pump();
      };
      far.onerror = (e) => { e?.preventDefault?.(); console.warn("[streets] worker failed: the catch-up on the page"); stop(); };
      far.postMessage({ routes: { streets: R } });
    } catch (e) { far = null; }
  };
  if (opt.far !== undefined ? opt.far : SPLIT) startFar();
  // (the worker's side: from empty to T, sent whole with each way off as [vehicle, street, entry], its x left null)
  function farReply(m) {
    const sim = fromEmpty(m.a0, m.t0);
    if (m.xw) sim.xw = m.xw;
    advance(sim, m.T);
    if (!xmap) { xmap = new Map(); streets.forEach((S, i) => S.X.forEach((e, j) => xmap.set(e, [i, j]))); }
    const xr = [], seen = new Set();
    const walk = (o) => {
      if (!o || typeof o !== "object" || seen.has(o)) return;
      seen.add(o);
      if ("v0b" in o && xmap.has(o.x)) { xr.push([o, ...xmap.get(o.x)]); o.x = null; }
      for (const v of o instanceof Map ? o.values() : Object.values(o)) walk(v);
    };
    walk(sim);
    return { id: m.id, sim, xr };
  }
  // (a handle for a simulation from empty, on the page with the worker; else the simulation itself, as before. xw: a
  // jump's quick hand-over notes, set from the start as at() sets them before such a one reaches them)
  function fresh(a0, t0, T, ms, xw) {
    if (!far || !ms) return fromEmpty(a0, t0);
    const h = { far: 1, a0, t0, t: T, xw, sim: null, id: 0 };
    if (a0 == null) queue.unshift(h); else queue.push(h);
    return h;
  }
  // (its simulation once it has come; made here from empty when the worker is gone, or force: a call without a budget)
  const land = (h, force) => (!h?.far ? h : h.sim || (far && !force ? h : Object.assign(fromEmpty(h.a0, h.t0), h.xw ? { xw: h.xw } : {})));
  const ready = (s, T, ms, t0) => !s.far && budgeted(s, T, ms, t0);
  // (review: wanted: still held by at() and still of the clock the page last drew (lastT): an anchor's own or the next
  // one's, a quick street no more than IDM.quickWarm s behind; never sent at a clock far from where it started)
  const wanted = (h) => (h === quick || h === nxt || [...pends.values()].includes(h)) && !(Number.isFinite(lastT) &&
    (lastT < h.t - IDM.dt - 1e-6 || (h.a0 != null ? h.a0 !== anchorFor(lastT) && h.a0 !== anchorFor(lastT) + P : lastT - h.t > IDM.quickWarm)));
  function pump() {
    if (far && busy && !wanted(busy) && clockMs() - busyAt > FAR_CANCEL_MS) { far.terminate?.(); busy = null; startFar(); }
    while (far && !busy && queue.length) {
      const h = queue.shift();
      if (!wanted(h)) continue;
      h.t = max(h.t, lastT); h.id = ++seq; busy = h; busyAt = clockMs();
      far.postMessage({ id: h.id, a0: h.a0, t0: h.t0, T: h.t, xw: h.xw });
    }
  }

  // the swap across a hand-over, old -> new: within 4 m a vehicle slides across; any other, the old copy until it is
  // first hidden after tb, the new one once it has been hidden after that (gone: the old simulation's leavers); the
  // placed records to draw
  function swap(T, a, b, mix, tb, gone) {
    if (!b) return [...a.values()];
    const out = [], same = (p, q) => p && q && p.i === q.i && p.li === q.li && abs(p.s - q.s) <= 4, h1 = (p) => (p.c.h1 >= tb ? p.c.h1 : 1e15);
    out.old = 0;   // (the old copies still drawn, not sliding: the quick hand-over waits for them)
    // (DYS-150: and the new copies it holds back where the street shows them: the quick hand-over ended once no old
    // copy was drawn, 240 s on, and each new copy still held came in whole in view, Greenwich 47108592r 1716-1843 m)
    const held = (q) => { if (shows(streets[q.i], q.s, q.c) > 0.04) out.old++; };
    for (const [id, p] of a) {
      const q = b.get(id);
      // (C2, B 27 Oct: sliding across never brings back a vehicle the hand-over holds out of sight: the old copy shows
      // until first hidden, the new once hidden after that, as below; else, two copies passing a gap a moment apart
      // were held, then drawn whole in view as they came within 4 m)
      // (DYS-101: once swapped (the old copy hidden, the new hidden since) the new copy alone, where it is: the slide's
      // mix put it back toward the old copy, up to 4 m off, so a car hidden at a run's edge blinked back into view
      // behind it, or one drawn on its new copy went with the old one into the hidden road behind (16:16, Lombard
      // 31780013r))
      if (same(p, q)) { if (T < h1(p)) out.push({ ...(mix < 0.5 ? p : q), s: p.s + (q.s - p.s) * mix }); else if (q.c.hl >= h1(p)) out.push(q); else held(q); }
      else if (T < h1(p)) { out.push(p); out.old++; }
    }
    for (const [id, q] of b) { const p = a.get(id); if (!same(p, q)) { if (q.c.hl >= (p ? h1(p) : max(tb, gone?.get(id) ?? tb))) out.push(q); else held(q); } }
    return out;
  }

  // ---- the vehicles at T
  // (DYS-149 SL: what at0 asked of the worker goes once it returns, the worker free)
  function at(T, opt) { try { return at0(T, opt); } finally { if (far) pump(); } }
  function at0(T, opt) {
    const A = anchorFor(T), ms = opt?.budgetMs, t0 = ms ? clockMs() : 0, hold = !!(ms && opt.hold);
    const A1 = A + P, tb = A + W + P - B, out = [];
    if (hold) wasHeld = true;
    const shared = !!far || wasHeld, room = () => ms - (clockMs() - t0);
    let cap = Infinity;
    const first = (n) => { if (wasHeld) { wasHeld = false; rampN = 0; } if (rampN < RAMP) cap = Math.ceil((n * ++rampN) / RAMP); };
    const faded = () => {
      if (ms) { const f = (clockMs() - max(readyAt, heldAt)) / fadeMs; if (f < 1) { const k = f <= 0 ? 0 : f * f * (3 - 2 * f); for (const o of out) o.alpha *= k; } }
      return out;
    };
    if (hold || wasHeld) heldAt = t0;
    // (DYS-149 SL: each handle whose simulation has come takes its place)
    if (ms && opt.own) lastT = T;   // (review: the outside's calls only, not the sound's once a second)
    quick = land(quick, !ms); nxt = land(nxt, !ms);
    for (const [a0, s] of pends) pends.set(a0, land(s, !ms));
    const qxOn = () => ms && qx && (T < qx.tb + IDM.quickBlend || (qx.old > 0 && T < qx.tb + QUICK_MAX * IDM.quickBlend));
    if (!usable(cur, A, T)) {
      // (the next simulation takes over, caught up as each frame keeps it; on the page never one far behind at once)
      if (usable(nxt, A, T) && !nxt.far && (!ms || nxt.t >= T - 1)) cur = nxt;
      else if (ms) {
        // (a jump: the full street's simulations, kept by anchor as they catch up, so an anchor passing meanwhile loses
        // none of it; inside a hand-over the next one first, the one the street becomes)
        const need = T >= tb ? [A1, A] : [A];
        for (const [a0, s] of pends) if (!need.includes(a0) || T < s.t - IDM.dt - 1e-6) pends.delete(a0);
        for (const s of [cur, nxt]) if (s && need.includes(s.a0) && !pends.has(s.a0) && T >= s.t - IDM.dt - 1e-6) pends.set(s.a0, s);
        for (const a0 of need) if (!pends.has(a0)) pends.set(a0, fresh(a0, a0, T, ms));
        if (!quick || T < quick.t - IDM.dt - 1e-6 || T - quick.t > IDM.quickWarm) quick = fresh(null, T - IDM.quickWarm, T, ms);
        if (!ready(quick, T, ms, t0)) return [];
        if (!quick.shown) { quick.shown = true; readyAt = clockMs(); fadeMs = QUICK_FADE_MS; qx = null; }
        for (const a0 of need) {
          if (ready(pends.get(a0), T, Math.max(shared ? 0 : 1, room()), clockMs())) continue;
          if (!hold) { const pq = placed(quick, T); first(pq.size); for (const p of pq.values()) emit(p, p.s); }
          return faded();
        }
        cur = pends.get(A); nxt = T >= tb ? pends.get(A1) : null; pends.clear();
        qx = { sim: quick, tb: T }; quick.xw = [T, QUICK_MAX * IDM.quickBlend]; quick = null;
      } else cur = newSimAt(A);
    }
    // (review: past the jump, a placeholder still out is not wanted: a dial flick into the past and back within the
    // anchor left them, sent at the live clock, 40,000+ steps from empty)
    if (quick?.far) quick = null;
    for (const [a, s] of pends) if (s.far) pends.delete(a);
    if (nxt === cur) nxt = null;
    if (ms && T - cur.t > 60) { if (!budgeted(cur, T, ms, t0)) return []; readyAt = clockMs(); fadeMs = JUMP_FADE_MS; qx = null; }
    if (wasHeld) budgeted(cur, T, room(), clockMs()); else advance(cur, T);
    let mix = 0;
    if (T >= A1) {
      if (!usable(nxt, A1, T)) nxt = fresh(A1, A1, T, ms, qxOn() ? [qx.tb, QUICK_MAX * IDM.quickBlend] : null);
      const goal = T >= tb ? T : min(T, nxt.t + IDM.catchUp);
      if (ms) ready(nxt, goal, Math.max(!shared || (!wasHeld && T >= tb - NXT_LEAD) ? 1 : 0, room()), clockMs()); else advance(nxt, goal);
      if (T >= tb && !nxt.far && nxt.t >= T - 1e-9) mix = smooth(0, 1, (T - tb) / B);
    }
    if (wasHeld) {
      // (DYS-149 SL2: held, or not yet caught up since: the quick hand-over's notes as below and its simulation kept up
      // in the slice; none placed until every simulation drawn is at the clock)
      if (qxOn()) { for (const s of [cur, nxt]) if (s && !s.xw) s.xw = [qx.tb, QUICK_MAX * IDM.quickBlend]; budgeted(qx.sim, T, room(), clockMs()); }
      else qx = null;
      if (hold || cur.t < T - 1e-9 || (qx && qx.sim.t < T - 1e-9) || (T >= tb && nxt && (nxt.far || nxt.t < T - 1e-9))) { heldAt = clockMs(); return out; }
    }
    let rec = swap(T, placed(cur, T), mix > 0 ? placed(nxt, T) : null, mix, tb, cur.gone);
    // (DYS-39: after a jump, the quick simulation's street hands over to the full one; the full simulations note when
    // each vehicle is hidden through the window, as in a hand-over's own)
    // (past its length it goes on while a quick-only vehicle is still drawn, never hidden yet: at most QUICK_MAX times)
    if (qxOn()) {
      for (const s of [cur, nxt]) if (s && !s.xw) s.xw = [qx.tb, QUICK_MAX * IDM.quickBlend];
      advance(qx.sim, T);
      rec = swap(T, placed(qx.sim, T), new Map(rec.map((r) => [r.c.id, r])), smooth(0, 1, (T - qx.tb) / IDM.quickBlend), qx.tb, qx.sim.gone);
      qx.old = rec.old;
    } else qx = null;
    first(rec.length);
    for (const r of rec) emit(r, r.s);
    return faded();

    function emit(p, s) {
      if (out.length >= cap) return;
      const S = streets[p.i], c = p.c, alpha = shows(S, s, c);
      if (alpha <= 0.04) return;
      const q = S.line.at(s, 8), l = c.lc, u = l ? min(1, max(0, (T - l.t0) / c.lcd)) : 1;
      const dl = l ? l.d ?? S.lat[p.li] - S.lat[l.f] : 0, lw = S.lat[p.li] + (c.y || 0) - dl * (1 - u * u * (3 - 2 * u));
      const heading = q.heading + Math.atan((6 * u * (1 - u) * dl) / c.lcd / max(c.v, l?.d ? 3 : 1)) / DEG;
      const cs = Math.cos(q.heading * DEG), sn = Math.sin(q.heading * DEG), px = q.x + lw * cs, py = q.y - lw * sn;
      const pitch = Math.atan2(S.line.at(min(S.L, s + 3), 8).h - S.line.at(max(0, s - 3), 8).h, 6) / DEG;
      out.push({ id: c.id, kind: c.kind, model: c.model, paint: c.paint, street: S.r.name, si: p.i, lane: p.li, s,
        x: px, y: py, z: frame.z(px, py, q.h), zRoad: frame.z(px, py, q.h - lift), h: q.h, heading, pitch, len: FL.lenOf[c.model], type: c.type,
        light: sn * -px + cs * -py > 0 ? "head" : "tail", tint: hs(c.paint, 0, 7), alpha, speed: c.v, stopped: c.v < 0.3, brake: c.a < -0.6 || c.v < 0.3 });
    }
  }

  // mid-path crossings in [T0, T1)
  function counts(T0, T1) { const sim = newSim(anchorFor(T0)); advance(sim, T0); sim.crossings = {}; advance(sim, T1); return sim.crossings; }

  return { at, counts, flow, streets, lanesOpen, light, dispose: stop, get stepMs() { return stepMin; }, _sim: () => cur, _nxt: () => nxt, _newSim: newSimAt, _advance: advance, _farReply: farReply,
    _far: () => ({ on: !!far, busy: !!busy, queued: queue.length, qx: !!qx, nxt: nxt?.far ? "handle" : nxt ? "sim" : null }) };
}
