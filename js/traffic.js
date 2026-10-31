// Cars, the tower beacons and the boats' navigation lights, as point sprites for js/live.js (the boats
// themselves are js/boats.js).
//
// The renderer traced real paths through the view (live/<view>-paths.json): bridge lanes and streets. Each
// point is [x, y, depth_m, visible] in exterior-image coordinates; a stretch between two points shows only
// when both ends are visible (not behind a building, tree or hill). Speeds are real (metres per second along
// the path), so things far away crawl.

export const FLOATS = 10;   // per sprite: x, y, r, g, b, a, size(px), sigma(px), shape, param
// shapes: 0 light (additive), 1 reflection streak (additive), 3 speck (over)

// Vehicles an hour, one direction of the Golden Gate Bridge, by hour of day.
const HOURLY = [480, 300, 220, 200, 320, 820, 2000, 3200, 3400, 2800, 2400, 2400,
  2500, 2600, 2800, 3000, 3200, 3200, 2800, 2200, 1700, 1400, 1100, 780];
// Other roads: share of the bridge's flow, and speed (m/s).
const ROADS = { motorway: [0.55, 21], trunk: [0.4, 13], primary: [0.28, 12], secondary: [0.14, 10], tertiary: [0.08, 9], residential: [0.03, 8] };
const HEAD = [1.0, 0.93, 0.80];
const TAIL = [1.0, 0.13, 0.06];
const SIDE = [1.0, 0.70, 0.52];
const RED = [1.0, 0.10, 0.06];

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function rng(seed) {   // mulberry32
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function flowAt(minutes) {
  const h = (((minutes / 60) % 24) + 24) % 24;
  const i = Math.floor(h), u = h - i;
  return HOURLY[i] * (1 - u) + HOURLY[(i + 1) % 24] * u;
}

export function createTraffic(data, view, overscan) {
  const W = data.width, H = data.height, focal = data.focal;
  const HW = H / W;

  // 3D position of a path point (metres, camera at the origin), for true lengths along the path
  const P = (q) => {
    const x = (q[0] - 0.5) / focal, y = ((q[1] - 0.5) * HW) / focal;
    const n = Math.hypot(x, y, 1);
    return [(q[2] * x) / n, (q[2] * y) / n, q[2] / n];
  };
  function prep(p) {
    const pts = p.pts, n = pts.length, cum = new Float64Array(n);
    let prev = P(pts[0]);
    for (let i = 1; i < n; i++) {
      const cur = P(pts[i]);
      cum[i] = cum[i - 1] + Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]);
      prev = cur;
    }
    const a = pts[0], b = pts[n - 1];
    return { ...p, n, cum, L: cum[n - 1], closed: Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 1e-6 };
  }
  // sample a path at arc length s: position, depth, visibility, and direction of travel (per metre)
  const S = { x: 0, y: 0, d: 0, vis: 0, ux: 0, dd: 0 };
  function at(p, s) {
    const cum = p.cum;
    s = clamp(s, 0, p.L);
    let lo = 0, hi = p.n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    const a = p.pts[lo], b = p.pts[lo + 1] || a;
    const seg = cum[lo + 1] - cum[lo];
    const u = seg > 0 ? (s - cum[lo]) / seg : 0;
    S.x = a[0] + (b[0] - a[0]) * u;
    S.y = a[1] + (b[1] - a[1]) * u;
    S.d = a[2] + (b[2] - a[2]) * u;
    S.vis = a[3] && b[3] ? 1 : 0;
    S.ux = seg > 0 ? (b[0] - a[0]) / seg : 0;
    S.dd = seg > 0 ? (b[2] - a[2]) / seg : 0;
    return S;
  }

  const raw = data.paths || [];
  const hasBridge = raw.some((p) => p.kind === "bridge");
  // OSM traces the bridge roadway too; the bridge lanes already carry it
  const paths = raw.filter((p) => p.pts?.length > 1 && !(hasBridge && p.kind === "street" && /golden gate bridge/i.test(p.name || ""))).map(prep);

  const lanes = { 1: 0, "-1": 0 };
  for (const p of paths) if (p.kind === "bridge") lanes[p.dir > 0 ? 1 : -1]++;

  const r = rng(0x5f3759df);
  const streams = [];
  for (const p of paths) {
    if (p.L < 1) continue;
    let v, share, sign = 1, light = null;
    if (p.kind === "bridge") {
      const right = p.pts[p.n - 1][0] > p.pts[0][0];
      const north = (p.dir ?? 1) > 0;                 // northbound moves away, to the right: tail lights
      sign = north === right ? 1 : -1;
      v = 20;
      share = 1 / Math.max(1, lanes[north ? 1 : -1]);
      light = north ? TAIL : HEAD;
    } else if (p.kind === "street") {
      [share, v] = ROADS[p.road] || [0.05, 9];
    } else continue;
    const peak = (Math.max(...HOURLY) * share) / 3600 / v * p.L;
    const pool = [];
    for (let i = 0, n = Math.min(160, Math.ceil(peak) + 1); i < n; i++) pool.push({ off: r(), vf: 0.9 + 0.2 * r(), tint: r() });
    streams.push({ p, kind: p.kind, v, share, sign, light, pool });
  }

  const beacons = (view.lights?.aircraft || []).map((q) => [(q[0] - 0.5) / overscan + 0.5, (q[1] - 0.5) / overscan + 0.5]);

  // ---------- writing sprites ----------
  let buf = new Float32Array(FLOATS * 512), n = 0;
  function push(x, y, c, a, size, sigma, shape, param) {
    if (a <= 0.002 || x < -0.02 || x > 1.02 || y < -0.02 || y > 1.02) return;
    if ((n + 1) * FLOATS > buf.length) { const b = new Float32Array(buf.length * 2); b.set(buf); buf = b; }
    const o = n * FLOATS;
    buf[o] = x; buf[o + 1] = y; buf[o + 2] = c[0]; buf[o + 3] = c[1]; buf[o + 4] = c[2]; buf[o + 5] = a;
    buf[o + 6] = size; buf[o + 7] = sigma; buf[o + 8] = shape; buf[o + 9] = param;
    n++;
  }
  // a light point: core sigma in canvas px
  const light = (x, y, c, a, sigma) => push(x, y, c, a, Math.ceil(sigma * 9) + 2, sigma, 0, 0);

  // env: { night, minutes, px (canvas px per CSS px), width (canvas px), specks, boatLights }
  function fill(t, env) {
    n = 0;
    const night = env.night, day = 1 - smooth(0.05, 0.45, night);
    const flow = flowAt(env.minutes);

    // cars: head and tail lights at night, faint specks on the bridge by day
    const streets = smooth(0.2, 0.45, night);
    for (const st of streams) {
      const isBridge = st.kind === "bridge";
      const k = isBridge ? 1 : streets;
      const daySpecks = isBridge && env.specks ? day : 0;
      if (k * night < 0.01 && daySpecks < 0.01) continue;
      const N = (flow * st.share) / 3600 / st.v * st.p.L;
      const L = st.p.L;
      for (let i = 0; i < st.pool.length && i < N + 1; i++) {
        const car = st.pool[i];
        const w = clamp(N - i, 0, 1);
        let s = (car.off * L + st.v * car.vf * t) % L;
        if (st.sign < 0) s = L - s;
        const q = at(st.p, s);
        if (!q.vis) continue;
        const near = clamp(1500 / q.d, 0, 1);
        if (night > 0.01 && k > 0) {
          let c = st.light, a = 1;
          if (!c) {
            const dd = q.dd * st.sign;                       // > 0: moving away from the window
            c = dd > 0.35 ? TAIL : dd < -0.35 ? HEAD : SIDE;
            a = c === SIDE ? 0.6 : 1;
          }
          if (c === TAIL) a *= 0.8;
          light(q.x, q.y, c, a * w * k * night * clamp(2600 / q.d, 0.45, 1.25), (0.48 + 0.3 * near) * env.px);
        }
        if (daySpecks > 0.01) {
          const g = car.tint < 0.45 ? [0.93, 0.93, 0.9] : car.tint < 0.75 ? [0.6, 0.61, 0.63] : [0.14, 0.14, 0.15];
          push(q.x, q.y, g, 0.32 * w * daySpecks, Math.ceil(0.45 * env.px * 7) + 2, 0.45 * env.px, 3, 0);
        }
      }
    }

    // boats (js/boats.js) add their navigation lights here
    env.boatLights?.(light, (x, y, c, a, sig, len) => push(x, y, c, a, Math.ceil(len * 1.8) + 2, sig, 1, len));

    // beacons on the towers: red aviation lights, flashing together
    if (night > 0.02) {
      const ph = (t / 2.2) % 1;
      const on = smooth(0, 0.12, ph) * (1 - smooth(0.42, 0.62, ph));
      for (const [x, y] of beacons) light(x, y, RED, (0.08 + 1.05 * on) * night, 0.8 * env.px);
    }
    return n;
  }

  return { fill, get buffer() { return buf; } };
}
