// Event 9: western gulls gliding past the window, 30-150 m out (true 3D positions, so they show strong parallax
// during glides). About 4 an hour by daylight (est.), on 60 s UTC slots; plus the welcome gull, 20-45 s after the
// living layer starts, by day, for each visitor.
import { GULLS } from "../tables.js";
import { sfTime, sunrise, sunset } from "../clock.js";
import { u01, SEED } from "../hash.js";
import { dirOf, view } from "../geo.js";

export function createGulls(routes, frame) {
  const axis = routes.cameras.home_l_v2.heading;   // the desk camera looks along this bearing

  const daylit = (t) => {
    const d = sfTime(t).day;
    return t > sunrise(d) + 600 && t < sunset(d) - 600;
  };

  // a gull's straight glide across the view: centre at distance d off the camera axis by db degrees, flying
  // across the line of sight (left to right or back) a little off square, sinking slowly
  function path(key, d, db, elev, ltr, skew, v, t0, welcome) {
    const cb = axis + db;
    const [cx, cy] = dirOf(cb);
    const C = [cx * d, cy * d, d * Math.tan((elev * Math.PI) / 180)];
    const heading = (cb + (ltr ? 90 : -90) + skew + 360) % 360;
    const H = d * 1.05 + 20;                  // starts and ends ~46 deg off centre: outside the 46-deg-wide window
    return { key, C, heading, H, v, t0, dur: (2 * H) / v, welcome };
  }

  function spawn(k) {
    const ts = k * GULLS.slot;
    if (!daylit(ts)) return null;
    if (u01(SEED.gull, k, 1) >= (GULLS.perHour / 3600) * GULLS.slot) return null;
    const u = (n) => u01(SEED.gull, k, n);
    return path(`g${k}`, GULLS.dist[0] + (GULLS.dist[1] - GULLS.dist[0]) * u(2) ** 1.4, (u(3) * 2 - 1) * 12,
      -3 + 14 * u(4), u(5) < 0.5, (u(6) * 2 - 1) * 20, GULLS.speed[0] + (GULLS.speed[1] - GULLS.speed[0]) * u(7),
      ts + u(8) * GULLS.slot, false);
  }

  function welcome(S) {
    const t0 = S + GULLS.welcome[0] + (GULLS.welcome[1] - GULLS.welcome[0]) * u01(SEED.visitor, Math.floor(S), 2);
    if (!daylit(t0)) return null;
    const u = (n) => u01(SEED.visitor, Math.floor(S), n);
    const p = path("g-welcome", 40 + 20 * u(3), (u(4) * 2 - 1) * 6, 2 + 4 * u(5), u(6) < 0.5, (u(7) * 2 - 1) * 10, 10.5, 0, true);
    p.t0 = t0 - p.dur / 2 + 0.2 * p.dur * (u(8) - 0.5);   // centred on t0: in the window 20-45 s after the start
    return p;
  }

  // DYS-227 (gullreal): the wing beat, a western gull's: bouts of slow deep beats (its own rate, 2.5-2.9 a second; 3-7
  // beats) between glides on held wings (1.6-5.2 s; the welcome gull's first glide short, so its visitor sees it beat),
  // each bout eased in and out over a third of a second (never more than a quarter of it), so the wings never jump. A
  // pure function of the gull's own time tt, from its own numbers: flap (in a bout), wing (the beat's phase, 0 the
  // wings at their highest; shared/city/gull-model.js beatPose), wingAmp (0 the glide .. 1 a full beat)
  function wingAt(p, tt) {
    const u = (n) => u01(SEED.gull, p.welcome ? 1999 : 1007, Math.round(p.t0), n);
    const f = 2.5 + 0.4 * u(0);
    let t = p.welcome ? 0.3 + 1.2 * u(1) : 0.5 + 3.0 * u(1);
    for (let i = 0; i < 24 && t <= tt; i++) {
      const d = (3 + Math.floor(5 * u(2 + 2 * i))) / f;
      if (tt < t + d) {
        const s = tt - t, r = Math.min(0.32, d / 4), e = (x) => { const q = Math.min(1, Math.max(0, x / r)); return q * q * (3 - 2 * q); };
        const ph = 0.28 + s * f;
        return { flap: true, wing: ph - Math.floor(ph), amp: e(s) * e(d - s), hz: f };
      }
      t += d + 1.6 + 3.6 * u(3 + 2 * i);
    }
    return { flap: false, wing: 0.28, amp: 0, hz: f };
  }

  function place(p, T) {
    const tt = T - p.t0;
    if (tt < 0 || tt > p.dur) return null;
    const s = -p.H + p.v * tt;
    const [hx, hy] = dirOf(p.heading);
    const x = p.C[0] + hx * s, y = p.C[1] + hy * s;
    const z = p.C[2] - 0.35 * tt + 1.2 * Math.sin((Math.PI * tt) / p.dur);
    const w = wingAt(p, tt);
    return {
      id: p.key, kind: "gull", x, y, z, heading: p.heading, speed: p.v, span: 1.3, len: 0.6, welcome: p.welcome,
      flap: w.flap, wing: w.wing, wingAmp: w.amp, wingT: tt, wingHz: w.hz, alpha: Math.min(1, tt / 0.8, (p.dur - tt) / 0.8), view: view(x, y, z),
    };
  }

  function at(T, c, env = {}) {
    const out = [];
    const k1 = Math.floor(T / GULLS.slot), k0 = k1 - Math.ceil(40 / GULLS.slot) - 1;
    for (let k = k0; k <= k1; k++) {
      const p = spawn(k);
      const g = p && place(p, T);
      if (g) out.push(g);
    }
    if (env.sessionStart !== undefined && env.sessionStart !== null) {
      const p = welcome(env.sessionStart);
      const g = p && place(p, T);
      if (g) out.push(g);
    }
    return out;
  }
  return { at, welcome };
}
