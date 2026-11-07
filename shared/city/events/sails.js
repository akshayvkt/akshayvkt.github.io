// Event 6: sailboats, out with the afternoon wind, Friday races and regattas.
//
// A pool of 100 boats. How many are out follows N(t) = base x clamp((wind - 4) / 7, 0, 1) on the Fort Point wind
// (base 8 on weekdays, 30 at weekends), +20 for Friday-evening races April-September, up to 100 on regatta days, by
// daylight only. Boat i goes out while hash(i, date) < N(t) / 100: each boat gets out-and-back times for the day,
// sails from its harbour mouth (no popping), wanders between hashed waypoints in its area, beats upwind on tacks of
// 2-6 minutes, flies a spinnaker running east before the westerly, and is back inside before sunset.
// (DYS-232 MOTION) Between two legs the boat turns, it does not snap: a tack swings the bow through the wind in 6-10 s
// (the boom crosses as the bow passes the wind, the heel goes through upright to the new side), a gybe in 4-7 s, a
// course change at about 8 deg/s; the path rounds the corner (the two legs' positions blended over the turn), and the
// legs themselves (times, places, who is out) are as before. On the water it heels with the wind by its point of sail
// (sprites.js heelFor, with the puffs of gustAt), pitches, heaves and rolls in the chop (waveMotion), rolls before the
// wind on a run, and carries the trim its sails show (beat / reach / run / bare: the atlas's sail_* pictures).
import { SAIL } from "../tables.js";
import { sfDay, sfTime, sfToT, sunrise, sunset, wind } from "../clock.js";
import { u01, SEED } from "../hash.js";
import { clamp, smooth, wrap180, wrap360, bearingOf, dirOf, pointIn, view } from "../geo.js";
import { heelFor, trimOf, seaState, seaDay, waveMotion, gustAt, MOTION, HULLS } from "../sprites.js";

const KN = 0.514444;
const DEG = Math.PI / 180;
const STEP = 300;
// one hash stream per purpose, so no two draws of a boat's day can collide
const DRAW = { thr: 1, out: 2, wpU: 3, wpV: 4, wpU2: 5, wpV2: 6, tack: 7, turn: 8 };
// a turn: the bow swings at up to rate deg/s (a tack, a gybe, a course change), x 0.85-1.15 in length by a hash; the
// sails go up or down over at least sailsUp s; the boom crosses over +-boom s round the moment the bow passes the wind
// (a tack) or dead downwind (a gybe); a tack costs speed (dip x the leg's, regained over ~12 s)
// the pictures change as crossfades of +-pic s (the sails), the heading blend eased onto the event's own cell over snap
// s round each (sprites.js hullSprite: the two cells then hold the two pictures), the heading turning at `slow` deg/s
// meanwhile (so the cells need not change under it); after a turn the boat steers back onto its leg crossing it at no
// more than `steer` x its speed
export const TURN = { rate: { tack: 18, gybe: 14, turn: 9 }, sailsUp: 6, boom: { tack: 0.5, gybe: 0.35 }, dip: 0.4,
  pic: 0.4, snap: 0.6, slow: 4, steer: 0.3 };
export const BANDS = [60, 138];
// the fleet's rigs: a share of racers (j105), the rest cruisers (c34); the odd bigger yacht; mast height / length overall
export const RIG = { racer: 0.4, big: 0.06, mastPerLen: 1.45 };
const pick = (list, u) => { for (const [w, v] of list) { if (u < w) return v; u -= w; } return list[list.length - 1][1]; };   // deg off the wind: the beat's sails to 60, the reach's to 138, then the run's (spinnaker)
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
      perf: 0.85 + 0.3 * u01(SEED.sail, i, 4), spin: Math.floor(u01(SEED.sail, i, 5) * 6),
      // (MOTION) its own rolling period before the wind and two phases; its rig (MODELS' j105 racer or c34 cruiser),
      // the odd bigger yacht (a c34 drawn at a 20-25 m mast) and its hull's paint
      rollT: MOTION.rollT * (0.9 + 0.2 * u01(SEED.sail, i, 6)), rollPh: 2 * Math.PI * u01(SEED.sail, i, 7), rollPh2: 2 * Math.PI * u01(SEED.sail, i, 8),
      rig: u01(SEED.sail, i, 9) < RIG.racer ? "j105" : "c34", big: u01(SEED.sail, i, 10) < RIG.big ? 20 + 5 * u01(SEED.sail, i, 11) : 0,
      livery: pick(HULLS, u01(SEED.sail, i, 12)) });
    if (boats[i].big) boats[i].rig = "c34";
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
    let from = wind(sfTime(t)).from;
    const go = (heading, v, dur, kind, side) => {
      legs.push({ t0: t, x: P[0], y: P[1], heading, v, kind, side, from });
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
      from = wnd.from;
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

  // ---- (MOTION) the boat between its legs
  const legPos = (g, T) => { const [dx, dy] = dirOf(g.heading); return [g.x + dx * g.v * (T - g.t0), g.y + dy * g.v * (T - g.t0)]; };
  const twaOf = (heading, from) => Math.abs(wrap180(heading - (from ?? 255)));
  const bandOf = (twa) => (twa < BANDS[0] ? "beat" : twa < BANDS[1] ? "reach" : "run");
  const legTrim = (g) => (g.kind === "motor" ? "bare" : bandOf(twaOf(g.heading, g.from)));
  // the side its sails show: a sailing leg's own; under power, the next sailing leg's (going out) or the last one's
  const legSide = (L, k) => {
    if (L[k].kind !== "motor") return L[k].side;
    for (let m = k + 1; m < L.length && !L[m].end; m++) if (L[m].kind !== "motor") return L[m].side;
    for (let m = k - 1; m >= 0; m--) if (L[m].kind !== "motor") return L[m].side;
    return 1;
  };
  // the turn into leg j (kept on the leg: a pure function of the day's plan). Built from the heading's side: the
  // picture's changes on the way round (the boom's crossing as the bow passes the wind (a tack) or dead downwind (a
  // gybe); each change of sails as the bow crosses 60 or 138 deg off the wind, bare <-> sails halfway) each get a slow
  // stretch (TURN.slow deg/s for +-(half + snap) s: the bow hangs head to wind as the sails flog, the boat bears away
  // while the sheets ease), and the bow swings between them at up to TURN.rate deg/s (tack / gybe / course change),
  // eased out of the old course and into the new. Its length follows (x 0.85-1.15 by a hash), centred on the legs'
  // corner. Returns { h (half its length, s), delta (deg, the short way round), cross, tc (the boom's crossing),
  // events [{kind, t, half, a, b, f, heading, p}], knots [[t, share of the sweep, its rate /s]] } or null.
  function turnInto(L, j, b, day) {
    const g = L[j];
    if (g.turn !== undefined) return g.turn;
    const a = L[j - 1];
    let tr = null;
    if (a && !a.end && !g.end) {
      const delta = wrap180(g.heading - a.heading), ad = Math.abs(delta), sailA = a.kind !== "motor", sailB = g.kind !== "motor";
      const from = g.from ?? a.from ?? 255;
      const sideA = legSide(L, j - 1), sideB = legSide(L, j), tA = legTrim(a), tB = legTrim(g);
      let cross = null, wc = 0.5;
      if (sailA && sailB && sideA !== sideB && ad > 0.5) {
        const up = wrap180(from - a.heading) / delta, down = wrap180(from + 180 - a.heading) / delta;
        if (up > 0 && up < 1) { cross = "tack"; wc = up; } else if (down > 0 && down < 1) { cross = "gybe"; wc = down; }
      }
      if (ad > 0.01 || tA !== tB || sideA !== sideB) {
        // the changes of picture, by the share of the sweep where they happen
        const events = [];
        if (sideA !== sideB) events.push({ kind: "side", f: wc, half: cross ? TURN.boom[cross] : TURN.pic, a: sideA, b: sideB });
        if (tA !== tB) {
          if (!sailA || !sailB) events.push({ kind: "trim", f: 0.5, half: TURN.pic, a: tA, b: tB });
          else {
            const bandAt = (f) => bandOf(twaOf(a.heading + f * delta, from));
            const N = 96;
            let prevB = bandAt(0);
            for (let k = 1; k <= N; k++) {
              const b1 = bandAt(k / N);
              if (b1 !== prevB) {
                let lo = (k - 1) / N, hi = k / N;
                while (hi - lo > 1e-6) { const m = (lo + hi) / 2; if (bandAt(m) === prevB) lo = m; else hi = m; }
                events.push({ kind: "trim", f: hi, half: TURN.pic, a: prevB, b: b1 });
              }
              prevB = b1;
            }
          }
        }
        // each slow stretch: +-(half + snap) s at TURN.slow deg/s; kept apart (a change of sails moved off the boom's
        // crossing) and inside the sweep
        const rate = TURN.slow / Math.max(ad, 1);
        for (const e of events) { e.p = e.half + TURN.snap; e.sig = Math.min(rate * e.p, 0.2); }
        // the boom crosses where the bow meets the wind (never moved); a change of sails is moved clear of it; a slow
        // stretch near either end of the sweep is narrowed (slower still) to fit
        const sideE = events.find((e) => e.kind === "side");
        for (const e of events) {
          if (e === sideE || !sideE) continue;
          const gap = (sideE.sig + e.sig) * 1.25;
          if (Math.abs(e.f - sideE.f) < gap) e.f = clamp(sideE.f + (e.f >= sideE.f ? gap : -gap), 0.02, 0.98);
        }
        events.sort((p, q) => p.f - q.f);
        for (let k = 1; k < events.length; k++) {
          const p = events[k - 1], e = events[k];
          if (e.f - e.sig < p.f + p.sig + 0.01) {
            if (e === sideE) p.f = Math.max(0.02, e.f - e.sig - p.sig - 0.01); else e.f = Math.min(0.98, p.f + p.sig + e.sig + 0.01);
          }
        }
        events.sort((p, q) => p.f - q.f);
        for (let k = 0; k < events.length; k++) {
          const e = events[k], lo = k ? events[k - 1].f + events[k - 1].sig : 0, hi = k + 1 < events.length ? events[k + 1].f - events[k + 1].sig : 1;
          e.sig = Math.max(1e-3, Math.min(e.sig, e.f - lo - 0.005, hi - e.f - 0.005));
        }
        // the knots in seconds from the start, then the fast stretches' lengths for a peak of R deg/s
        const R = cross === "tack" ? TURN.rate.tack : cross === "gybe" ? TURN.rate.gybe : TURN.rate.turn;
        const pts = [[0, 0]];
        for (const e of events) pts.push([e.f - e.sig, e.sig / e.p, e], [e.f + e.sig, e.sig / e.p, null]);
        pts.push([1, 0]);
        const seg = [];
        let slowT = 0, fastT = 0;
        for (let k = 1; k < pts.length; k++) {
          const [f0, m0, ev] = pts[k - 1], [f1, m1] = pts[k];
          const d = ev ? 2 * ev.p : Math.max(0.3, (1.5 * (f1 - f0) * ad) / (R + 0.25 * (m0 + m1) * ad));
          seg.push({ d, ev, f1, slow: !!ev });
          if (ev) slowT += d; else fastT += d;
        }
        // its length: the swings x 0.85-1.15 by a hash (the sails' going up or down at least sailsUp in all); squeezed
        // into a short leg, the swings first (faster), the slow stretches only if they alone overfill it
        fastT *= 0.85 + 0.3 * draw(DRAW.turn, b.i, day, j);
        if (sailA !== sailB && slowT + fastT < TURN.sailsUp) fastT = TURN.sailsUp - slowT;
        const next = L[j + 1];
        const room = 2 * Math.min(0.45 * (g.t0 - a.t0), next ? 0.45 * (next.t0 - g.t0) : 1e9);
        let ks = 1, kf = fastT / seg.filter((q) => !q.slow).reduce((x, q) => x + q.d, 0) || 1;
        if (slowT + fastT > room) {
          if (room - slowT > 0.2 * fastT) kf *= (room - slowT) / fastT;
          else { const k = room / (slowT + fastT); ks = k; kf *= k; }
        }
        const knots = [[0, 0, 0]];
        let t = 0;
        for (const q of seg) {
          t += q.d * (q.slow ? ks : kf);
          const m1 = pts[knots.length][1] / ks;
          knots.push([t, q.f1, m1]);
          if (q.ev) q.ev.tRel = t - q.ev.p * ks;
        }
        const h = t / 2, w0 = g.t0 - h;
        if (h > 0.05) {
          for (const kn of knots) kn[0] += w0;
          for (const e of events) {
            e.t = w0 + e.tRel; e.p *= ks; e.half = Math.min(e.half, e.p * 0.9);
            e.heading = wrap360(a.heading + e.f * delta);
            delete e.tRel; delete e.sig;
          }
          const sideE2 = events.find((e) => e.kind === "side");
          tr = { h, delta, cross, tc: sideE2 ? sideE2.t : g.t0, t0: g.t0, sideA, sideB, tA, tB, events, knots };
        }
      }
    }
    g.turn = tr;
    return tr;
  }
  // the share of a turn's sweep done at T (0 .. 1, rising smoothly: its knots, Hermite between them)
  function progress(tr, T) {
    const K = tr.knots;
    if (T <= K[0][0]) return 0;
    if (T >= K[K.length - 1][0]) return 1;
    let k = 0;
    while (k + 2 < K.length && K[k + 1][0] <= T) k++;
    const [t0, f0, m0] = K[k], [t1, f1, m1] = K[k + 1], d = t1 - t0, u = (T - t0) / d;
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * f0 + (u3 - 2 * u2 + u) * d * m0 + (-2 * u3 + 3 * u2) * f1 + (u3 - u2) * d * m1;
  }
  // where the boat goes through a turn: the turning heading integrated from the old leg (no sliding: it moves where it
  // points), a hard turn losing way (to half its speed at the middle of a U-turn); kept on the turn, at 20 steps a
  // second. It comes out of the turn off its new leg by E (m), and steers back onto it over `conv` s (eased: its
  // heading follows its way through the water), well before the next turn
  // the last leg at or before k that a turn led into (0: none), and when the next turn after leg j starts (or the outing ends)
  const lastTurn = (L, k, b, day) => { for (let m = k; m >= 1; m--) if (turnInto(L, m, b, day)) return m; return 0; };
  const nextStart = (L, j, b, day) => {
    for (let m = j + 1; m < L.length; m++) { if (L[m].end) return L[m].t0; const t = turnInto(L, m, b, day); if (t) return L[m].t0 - t.h; }
    return L[L.length - 1].t0;
  };
  // what is left of a turn's offset at T (m), and its rate (m/s): steered out over `span` s, a share r carried on
  const residual = (pt, T) => {
    const u = clamp((T - pt.t1) / pt.span, 0, 1), k = 1 - (1 - pt.r) * u * u * (3 - 2 * u), dk = -(1 - pt.r) * (6 * u * (1 - u)) / pt.span;
    return [pt.E[0] * k, pt.E[1] * k, pt.E[0] * dk, pt.E[1] * dk];
  };
  function pathOf(tr, L, j, b, day) {
    if (tr.path) return tr.path;
    const a = L[j - 1], g = L[j], w0 = g.t0 - tr.h, n = Math.max(2, Math.ceil(tr.h * 2 * 20)), dt = (2 * tr.h) / n;
    const xs = new Float64Array(n + 1), ys = new Float64Array(n + 1);
    let [x, y] = legPos(a, w0);
    // (from where it really is: the last turn's offset not yet steered out)
    const pj = lastTurn(L, j - 1, b, day);
    if (pj) { const q = residual(pathOf(turnInto(L, pj, b, day), L, pj, b, day), w0); x += q[0]; y += q[1]; }
    const big = 0.5 * Math.max(0, (Math.abs(tr.delta) - 90) / 90);
    const vel = (t) => {
      const f = progress(tr, t), h = (a.heading + f * tr.delta) * DEG, v = (a.v + (g.v - a.v) * f) * (1 - big * Math.sin(Math.PI * f));
      return [v * Math.sin(h), v * Math.cos(h)];
    };
    xs[0] = x; ys[0] = y;
    for (let i = 1; i <= n; i++) {
      const [vx, vy] = vel(w0 + (i - 0.5) * dt);
      x += vx * dt; y += vy * dt; xs[i] = x; ys[i] = y;
    }
    const t1 = g.t0 + tr.h, [ex, ey] = legPos(g, t1), E = [x - ex, y - ey];
    // steered out at no more than STEER x its speed across its course (eased), within the room before the next turn;
    // what does not fit is carried into that turn
    const conv = clamp((1.5 * Math.hypot(E[0], E[1])) / (TURN.steer * Math.max(g.v, 0.5)), 4, 90), room = Math.max(0.5, nextStart(L, j, b, day) - t1);
    tr.path = { xs, ys, n, dt, w0, t1, E, span: Math.min(conv, room), r: conv > room ? 1 - room / conv : 0, big };
    return tr.path;
  }
  // (the distance sailed since leaving, m: each leg's start kept on it, once)
  const odoOf = (L) => {
    if (L[0].odo0 === undefined) { L[0].odo0 = 0; for (let k = 1; k < L.length; k++) L[k].odo0 = L[k - 1].odo0 + (L[k - 1].v || 0) * (L[k].t0 - L[k - 1].t0); }
    return L;
  };
  const legOdo = (g, T) => g.odo0 + g.v * (T - g.t0);
  // where the boat is at T on its legs L: its place, heading, speed through the water (a tack costs some, regained
  // over ~12 s), its sails' side (sideW: -1 port .. +1 starboard, continuous through the boom's crossing), how far its
  // sails are down (motorW), the sails it shows ({A, B, m}: crossfading from A to B by m), `snap` (0..1: the picture's
  // heading blend eased onto the nearest cell round a crossfade, sprites.js hullSprite) and the leg's kind
  function placeOn(L, T, b, day) {
    odoOf(L);
    let lo = 0, hi = L.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L[m].t0 <= T) lo = m; else hi = m; }
    const near = [lo > 0 ? turnInto(L, lo, b, day) : null, lo + 1 < L.length && !L[lo + 1].end ? turnInto(L, lo + 1, b, day) : null];
    let snap = 0, snapEv = null, dip = 0;
    for (const t of near) {
      if (!t) continue;
      for (const e of t.events) {
        const S = Math.max(e.p - e.half, 1e-3);   // (the slow stretch: the crossfade, eased into and out of over S)
        const k = smooth(e.t - e.half - S, e.t - e.half, T) * (1 - smooth(e.t + e.half, e.t + e.half + S, T));
        if (k > snap) { snap = k; snapEv = e; }
      }
      if (t.cross === "tack") dip = Math.max(dip, TURN.dip * smooth(t.tc - 2.5, t.tc, T) * (1 - smooth(t.tc + 1, t.tc + 12, T)));
    }
    const tr = near[0] && T < L[lo].t0 + near[0].h ? near[0] : near[1] && T > L[lo + 1].t0 - near[1].h ? near[1] : null;
    if (!tr) {
      const g = L[lo], side = legSide(L, lo);
      let [x, y] = legPos(g, T), heading = g.heading, v = g.v;
      // steering back onto the leg after the last turn (its heading follows its way through the water)
      const pj = lastTurn(L, lo, b, day);
      if (pj) {
        const q = residual(pathOf(turnInto(L, pj, b, day), L, pj, b, day), T);
        if (q[0] || q[1]) {
          x += q[0]; y += q[1];
          const vx = v * Math.sin(g.heading * DEG) + q[2], vy = v * Math.cos(g.heading * DEG) + q[3];
          if (q[2] || q[3]) { heading = bearingOf(vx, vy); v = Math.hypot(vx, vy); }
        }
      }
      return { x, y, heading, v: v * (1 - dip), side, sideW: side, motorW: g.kind === "motor" ? 1 : 0, kind: g.kind,
        odo: legOdo(g, T), sails: { A: legTrim(g), B: null, m: 0 }, snap, snapEv };
    }
    const j = tr === near[0] ? lo : lo + 1;
    const a = L[j - 1], g = L[j];
    const w = progress(tr, T);
    const pt = pathOf(tr, L, j, b, day), fi = clamp((T - pt.w0) / pt.dt, 0, pt.n), i0 = Math.min(Math.floor(fi), pt.n - 1), fu = fi - i0;
    const vTurn = (a.v + (g.v - a.v) * w) * (1 - pt.big * Math.sin(Math.PI * w));
    let sideW = tr.sideA, sails = { A: tr.tA, B: null, m: 0 };
    for (const e of tr.events) {
      const k = smooth(e.t - e.half, e.t + e.half, T);
      if (e.kind === "side") sideW = e.a + (e.b - e.a) * k;
      else if (k >= 1) sails = { A: e.b, B: null, m: 0 };
      else if (k > 0) sails = { A: e.a, B: e.b, m: k };
    }
    return {
      x: pt.xs[i0] + (pt.xs[i0 + 1] - pt.xs[i0]) * fu, y: pt.ys[i0] + (pt.ys[i0 + 1] - pt.ys[i0]) * fu,
      heading: wrap360(a.heading + w * tr.delta), v: vTurn * (1 - dip),
      side: sideW >= 0 ? 1 : -1, sideW, motorW: (a.kind === "motor" ? 1 - w : 0) + (g.kind === "motor" ? w : 0),
      kind: w < 0.5 ? a.kind : g.kind, odo: legOdo(a, T) + (legOdo(g, T) - legOdo(a, T)) * w, sails, snap, snapEv,
    };
  }

  // a change of picture's heading as seen from the eye (0 going away, 90 moving right), at the change's own moment:
  // fixed per change (kept on it), so the cell the picture holds round it never flips as the boat crosses the view
  function snapYawOf(e, L, b, day) {
    if (e.yaw === undefined) {
      const q = placeOn(L, e.t, b, day);
      e.yaw = wrap360(e.heading - view(q.x, q.y, frame.z(q.x, q.y, 0)).bearing);
    }
    return e.yaw;
  }

  function at(T, c) {
    const out = [];
    const windKt = c.wind?.open ?? wind(sfTime(T)).open, from = c.wind?.from ?? 255;
    const sea = seaState(windKt, seaDay(wind, c));
    for (const day of [c.day]) {
      const p = plan(day);
      const raceDay = !!regatta(sfDay(day));
      p.forEach((outings, i) => {
        for (const o of outings) {
          if (T < o.tOut || T >= o.end) continue;
          const L = o.legs;
          const P = placeOn(L, T, boats[i], day);
          const { x, y } = P;
          const b = boats[i];
          const mast = raceDay ? b.race : b.big || b.mast;
          const first = L[0];
          const len = mast / RIG.mastPerLen, beam = len * 0.33;
          // (MOTION) heel to leeward by the point of sail in the wind here (puffs and all), the chop's pitch, heave
          // and roll (more on a run), and the run's own rolling
          const twa = Math.abs(wrap180(P.heading - from)), sail = 1 - P.motorW;
          const tw = trimOf(twa);
          // the sails it shows (whole pictures, crossfaded only as a turn changes them)
          const trim = { beat: 0, reach: 0, run: 0, bare: 0 };
          trim[P.sails.A] += 1 - P.sails.m;
          if (P.sails.B) trim[P.sails.B] += P.sails.m;
          const gust = gustAt(T, x, y, windKt, from);
          const wm = waveMotion(T, x, y, P.heading, len, beam, sea, from + 180, "sail");
          const run = tw.run * sail;   // (the rolling before the wind: by the true wind angle itself)
          const rolling = run * (MOTION.runRoll[0] + MOTION.runRoll[1] * windKt) * Math.sin((2 * Math.PI * T) / b.rollT + b.rollPh)
            * (0.75 + 0.25 * Math.sin((2 * Math.PI * T) / (4.7 * b.rollT) + b.rollPh2));
          const heel = heelFor(twa, windKt * gust) * sail * P.sideW + wm.roll * (1 + 0.6 * run) + rolling;
          // where it was (the wake's track): 4 points ~1.5 lengths apart, from the same legs
          const dt = clamp((1.5 * len) / Math.max(P.v, 0.5), 2, 15), trail = [];
          for (let k = 1; k <= 4; k++) {
            const t1 = Math.max(first.t0, T - k * dt), q = placeOn(L, t1, b, day);
            trail.push([q.x, q.y, T - t1]);
          }
          out.push({
            id: `y${i}`, kind: "sail", x, y, z: frame.z(x, y, 0), heading: P.heading, speed: P.v, mast, len,
            point: P.kind, spinnaker: trim.run > 0.5, spin: trim.run, spinColour: b.spin, side: P.side, sideW: P.sideW, race: raceDay,
            rig: b.rig, livery: b.livery,
            trim, snap: P.snap, snapYaw: P.snapEv ? snapYawOf(P.snapEv, L, b, day) : null,
            heel, pitch: wm.pitch, heave: wm.heave, twa, trail, odo: P.odo,
            alpha: Math.min(1, (T - first.t0) / 60, (o.end - T) / 60) * (1 - 0.15 * P.motorW),
            view: view(x, y, frame.z(x, y, 0)),
          });
        }
      });
    }
    return out;
  }

  return { at, plan, placeOn, turnInto, wanted: (day, sec) => { const t0 = sfToT(day, 0); return wanted(sfDay(day), sfToT(day, sec) - t0, sec, sunrise(day) - t0, sunset(day) - t0); } };
}
