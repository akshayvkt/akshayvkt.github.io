// Boats on the bay, for js/live.js: container ships in and out through the Gate, the bay-cruise ferries on
// their loop, and sailboats on breezy afternoons. Each is a sprite from web/live/sprites (rendered in Blender
// at 24 headings, lit here for the moment), sized from its distance, with a wake drawn in the water shader
// and, at night, its navigation lights.
//
// Positions live on the bay itself: X metres to the right of the camera, Z metres forward. The renderer's
// routes (live/<view>-paths.json, exterior-image points with depth) are turned into that plane; a point at
// (X, Z) is seen at u = 0.5 + f X / Z, v = horizon + aspect f eye / Z.

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const DEG = Math.PI / 180;
const hash = (n) => { let t = (n * 0x9e3779b1) >>> 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export const BOAT_FLOATS = 16;   // per sprite instance (see shaders.js BOAT_VS)
export const MAX_WAKES = 16;

const WHITE = [1.0, 0.93, 0.8], RED = [1.0, 0.1, 0.06], GREEN = [0.35, 1.0, 0.55], WARM = [1.0, 0.78, 0.5];

// The camera seen from the bay: fit horizon and eye height to the renderer's own projected water routes
// (exact projections), falling back to what the depth map gave.
export function fitCamera(data, fallback) {
  const A = data.width / data.height, f = data.focal;
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of data.paths || []) {
    if (!/^(ship|ferry|sail)$/.test(p.kind)) continue;
    for (const q of p.pts) {
      if (!q[3] || q[0] < 0 || q[0] > 1 || q[2] < 50) continue;
      const x = 1 / q[2], y = q[1];
      n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
  }
  if (n >= 6) {
    const a = (n * sxy - sx * sy) / (n * sxx - sx * sx), b = (sy - a * sx) / n;
    const eye = a / (A * f);
    if (eye > 5 && eye < 3000 && b > 0 && b < 1) return { horizon: b, eye, focal: f, aspect: A };
  }
  return fallback ? { ...fallback, focal: f, aspect: A } : null;
}

export function createBoats({ data, cam, cpu, atlas, heading }) {
  const f = cam.focal, A = cam.aspect;
  const toPlane = (q) => [(q[0] - 0.5) * q[2] / f, q[2]];
  const project = (X, Z, h = 0) => [0.5 + (f * X) / Z, cam.horizon + (A * f * (cam.eye - h)) / Z];

  // routes on the plane, by arc length
  function route(p, reverse) {
    let pts = p.pts.map(toPlane);
    if (reverse) pts = pts.slice().reverse();
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const L = cum[cum.length - 1];
    const closed = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1;
    return {
      L, closed, name: p.name || p.kind,
      at(s) {
        s = closed ? ((s % L) + L) % L : clamp(s, 0, L);
        let lo = 0, hi = cum.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
        const a = pts[lo], b = pts[Math.min(lo + 1, pts.length - 1)], seg = cum[lo + 1] - cum[lo] || 1;
        const u = clamp((s - cum[lo]) / seg, 0, 1);
        // heading: smoothed over a few hundred metres so turns are gentle
        const ah = this.dir(s);
        return { X: a[0] + (b[0] - a[0]) * u, Z: a[1] + (b[1] - a[1]) * u, hx: ah[0], hz: ah[1] };
      },
      dir(s) {
        const d = 120;
        const p0 = this.raw(s - d), p1 = this.raw(s + d);
        const dx = p1[0] - p0[0], dz = p1[1] - p0[1], n = Math.hypot(dx, dz) || 1;
        return [dx / n, dz / n];
      },
      raw(s) {
        s = closed ? ((s % L) + L) % L : clamp(s, 0, L);
        let lo = 0, hi = cum.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
        const a = pts[lo], b = pts[Math.min(lo + 1, pts.length - 1)], seg = cum[lo + 1] - cum[lo] || 1;
        const u = clamp((s - cum[lo]) / seg, 0, 1);
        return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
      },
    };
  }
  const raw = data.paths || [];
  const shipIn = raw.find((p) => p.kind === "ship"), ferryP = raw.find((p) => p.kind === "ferry");
  const routes = {
    shipIn: shipIn && route(shipIn, false), shipOut: shipIn && route(shipIn, true),
    ferry: ferryP && route(ferryP, false),
    sails: raw.filter((p) => p.kind === "sail").map((p) => route(p, false)),
  };

  // is (u, v) water, or is something nearer than Z standing in front of it? (else the boat would sit on land)
  function onWater(u, v, Z) {
    if (!cpu || u < 0 || u > 1 || v < 0 || v > 1) return u >= -0.1 && u <= 1.1 ? 1 : 0;
    const i = Math.min(cpu.w - 1, Math.floor(u * cpu.w)), j = Math.min(cpu.h - 1, Math.floor(v * cpu.h));
    const k = j * cpu.w + i;
    if (cpu.water[k] > 128) return 1;
    const D = 10 * Math.pow(6000, cpu.depth[k] / 255);
    return D < Z * 0.9 ? 1 : 0;
  }

  // ---------- who is out there ----------
  // The schedule runs on a clock in seconds of the San Francisco day (tau), so a reload or another page at the
  // same minute finds the same boats in the same places.
  const SHIP_EVERY = 3600, SHIP_OFF = 1500, SHIP_V = 6.2;
  const FERRY_V = 5.6;
  const ferryDeps = [];
  for (let m = 7 * 60; m <= 21 * 60; m += 30) {
    const h = m / 60;
    if (h >= 9.5 && h <= 18.5) ferryDeps.push(m * 60);          // every half hour through the day
    else if (m % 60 === 0) ferryDeps.push(m * 60);              // hourly early and late
  }
  const SAILS = 26;
  const sailors = [];
  for (let i = 0; i < SAILS; i++) {
    sailors.push({
      route: i % Math.max(1, routes.sails.length), phase: hash(i * 7 + 1), lateral: (hash(i * 7 + 2) - 0.5) * 840,
      v: 2.4 + 1.6 * hash(i * 7 + 3), size: 0.8 + 0.6 * hash(i * 7 + 4), order: hash(i * 7 + 5),
    });
  }
  sailors.sort((a, b) => a.order - b.order);   // the first few come out first

  const state = new Map();                      // id -> { vis } smoothed visibility
  let list = [];
  // env: { tau, minutes, night, wind, windTo: [x, z], alt, weekend, dt }
  function update(env) {
    const out = [];
    const add = (id, kind, r, s, len, beam, wakeLen, foam, extra = {}) => {
      const q = r.at(s);
      const [u, v] = project(q.X, q.Z);
      out.push({ id, kind, X: q.X, Z: q.Z, hx: q.hx, hz: q.hz, u, v, len, beam, wakeLen, foam, ...extra });
    };
    const tau = env.tau;
    // container ships, one an hour, alternately coming in and going out
    if (routes.shipIn) {
      const k0 = Math.floor((tau - SHIP_OFF) / SHIP_EVERY);
      for (let k = k0 - 1; k <= k0; k++) {
        const r = k % 2 === 0 ? routes.shipIn : routes.shipOut;
        const len = 190 + 110 * hash(k * 13 + 5);
        const s = (tau - (k * SHIP_EVERY + SHIP_OFF)) * SHIP_V;
        if (s < 0 || s > r.L) continue;
        add(`ship${k}`, "ship", r, s, len, len * 0.14, 1600, 0.55, { spd: SHIP_V });
      }
    }
    // the bay-cruise ferries
    if (routes.ferry) {
      const r = routes.ferry;
      for (const d of ferryDeps) {
        const s = (tau - d) * FERRY_V;
        if (s < 0 || s > r.L) continue;
        add(`ferry${d}`, "ferry", r, s, 38 + 8 * hash(d), 11, 520, 1.0, { spd: FERRY_V });
      }
    }
    // sailboats: a few in the morning, a crowd on a breezy afternoon (more at the weekend), none at night
    const h = env.minutes / 60;
    const daylight = smooth(-1, 4, env.alt) * (1 - env.night);
    const hours = smooth(8.5, 12, h) * (1 - smooth(19.2, 20.4, h));
    const breeze = clamp((env.wind - 0.2) / 0.6, 0, 1);
    // (about half the fleet is behind the walls or out of the window at any time)
    const want = daylight * hours * (3 + 16 * breeze) * (env.weekend ? 1.2 : 1);
    if (routes.sails.length) {
      sailors.forEach((b, i) => {
        const target = clamp(want - i, 0, 1);
        const r = routes.sails[b.route];
        const s = b.phase * r.L + b.v * tau;
        const q = r.at(s);
        // sail a little to one side of the loop, so the fleet spreads over the water
        const X = q.X + q.hz * b.lateral, Z = Math.max(400, q.Z - q.hx * b.lateral);
        const [u, v] = project(X, Z);
        out.push({ id: `sail${i}`, kind: "sail", X, Z, hx: q.hx, hz: q.hz, u, v, len: 10 * b.size, beam: 3.2 * b.size,
          wakeLen: 70, foam: 0.35, spd: b.v, target });
      });
    }

    // visibility, smoothed: fade in and out over a couple of seconds (or the count's slow change for sails)
    const dt = Math.min(0.25, env.dt || 0.033);
    for (const b of out) {
      const ok = onWater(b.u, b.v, b.Z) * (b.target ?? 1) * (b.Z > 300 ? 1 : 0);
      let st = state.get(b.id);
      if (!st) { st = { vis: ok, seen: 0 }; state.set(b.id, st); }
      const rate = b.kind === "sail" ? 0.08 : 0.8;
      st.vis += clamp(ok - st.vis, -rate * dt, rate * dt);
      st.seen = env.frame;
      b.alpha = smooth(0, 1, st.vis);
    }
    for (const [id, st] of state) if (st.seen !== env.frame) state.delete(id);
    list = out.filter((b) => b.alpha > 0.002);
    return list;
  }

  // ---------- sprites ----------
  const T = atlas.types, yaws = atlas.yaws, step = 360 / yaws.length;
  function sprites(buf, env) {
    let n = 0;
    const put = (b, refl) => {
      const t = T[b.kind];
      const model = atlas.models[b.kind];
      // heading against the line of sight, as the sprite was rendered (0 away, 90 moving right)
      let yaw = (Math.atan2(b.hx, b.hz) - Math.atan2(b.X, b.Z)) / DEG;
      let mir = false;
      if (b.kind === "sail") {
        // sails out on the side away from the wind (the sprite has them to starboard)
        const fromX = -env.windTo[0], fromZ = -env.windTo[1];
        if (fromX * b.hz - fromZ * b.hx > 0) { mir = true; yaw = -yaw; }
      }
      yaw = ((yaw % 360) + 360) % 360;
      const i0 = Math.floor(yaw / step) % yaws.length, i1 = (i0 + 1) % yaws.length, w = yaw / step - Math.floor(yaw / step);
      const scale = ((f * env.canvasW) / b.Z) * (b.len / model) / t.px_per_m;
      const o = n * BOAT_FLOATS;
      const c0 = t.cells[i0], c1 = t.cells[i1];
      buf.set([b.u, b.v, scale, b.Z, c0[0], c0[1], t.cell[0], t.cell[1], c1[0], c1[1], t.cell[0], t.cell[1],
        w, t.anchor, b.alpha, (refl ? 1 : 0) + (mir ? 2 : 0)], o);
      n++;
    };
    for (const b of list) { put(b, true); }
    for (const b of list) { put(b, false); }
    return n;
  }

  // ---------- wakes: the nearest and biggest first, up to the shader's limit ----------
  function wakes(P, Q) {
    const ws = list.filter((b) => b.spd > 0.5).sort((a, b) => b.foam * b.len / b.Z - a.foam * a.len / a.Z).slice(0, MAX_WAKES);
    ws.forEach((b, i) => {
      P.set([b.X, b.Z, b.hx, b.hz], i * 4);
      Q.set([b.len, b.beam, b.wakeLen, b.foam * b.alpha], i * 4);
    });
    return ws.length;
  }

  // ---------- navigation lights at night (white masthead, red or green side light, cabin windows) ----------
  function lights(light, streak, env) {
    if (env.night < 0.05) return;
    for (const b of list) {
      if (b.kind === "sail") continue;
      const toward = b.hz < -0.5;
      const side = toward ? null : b.hx > 0 ? GREEN : RED;   // moving right shows starboard (green)
      const L = b.kind === "ship"
        ? [[0.22, 30, WHITE, 1], [-0.32, 42, WHITE, 1], [-0.36, 26, side, 0.8], [-0.4, 14, WARM, 0.35], [-0.38, 20, WARM, 0.3], [-0.34, 9, WARM, 0.25], [0.05, 6, WARM, 0.18], [0.35, 7, WARM, 0.15]]
        : [[0.1, 12, WHITE, 1], [-0.05, 7, side, 0.8], [-0.3, 4.5, WARM, 0.45], [-0.15, 4.5, WARM, 0.45], [0, 4.5, WARM, 0.45], [0.15, 4.5, WARM, 0.45], [0.3, 4.5, WARM, 0.4]];
      if (toward) L.push([-0.05, 7, GREEN, 0.7, -2], [-0.05, 7, RED, 0.7, 2]);
      for (const [fr, hgt, c, a, dx = 0] of L) {
        if (!c) continue;
        const X = b.X + b.hx * fr * b.len, Z = b.Z + b.hz * fr * b.len;
        const [u, v] = project(X, Z, hgt);
        const [, v0] = project(X, Z, 0);
        if (!onWater(u, v0, Z)) continue;
        const near = clamp(1500 / Z, 0, 1);
        const sig = (0.45 + 0.3 * near) * env.px, k = a * env.night * clamp(3000 / Z, 0.5, 1.2) * b.alpha;
        light(u + (dx * 0.3) / env.canvasW, v, c, k, sig);
        const hp = (hgt * f * env.canvasW) / Z;
        streak(u, v0 + (v0 - v) * 0.85, c, k * 0.22, sig, Math.max(3 * env.px, hp * 0.8));
      }
    }
  }

  return { update, sprites, wakes, lights, get list() { return list; }, routes };
}
