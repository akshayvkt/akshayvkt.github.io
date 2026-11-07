// Event 3: aircraft on the eight corridors fitted to the measured ADS-B sample (routes.json "aircraft").
//
// Each corridor has 60 s slots on the UTC clock. A slot launches an aircraft when hash(corridor, slot) < rate * 60 s,
// with the measured daytime rate (6.8 new aircraft per 10 min over all corridors) times the hour factor. Light planes
// fly between sunrise and sunset only, and 1.5x as often at weekends. Each aircraft's offset from the corridor's
// centre line, its altitude, speed and size are hashed once at launch.
import { AIRCRAFT, AIRCRAFT_HOUR } from "../tables.js";
import { sfTime, sunrise, sunset, sun } from "../clock.js";
import { u01, SEED } from "../hash.js";
import { polyline, navLights, view } from "../geo.js";

const DEG = Math.PI / 180;

export function createAircraft(routes, frame, inDesk) {
  const cors = routes.aircraft.map((c, i) => {
    const line = polyline(c.pts);
    // where the corridor first enters the desktop window (for the visitor's front-loaded plane)
    let enter = null;
    for (let s = 0; s <= line.L; s += 200) {
      const p = line.at(s);
      const z = frame.z(p.x, p.y, p.h);
      if (inDesk(p.x, p.y, z, 0)) { enter = s; break; }
    }
    return { ...c, i, line, enter, maxDur: line.L / (c.speed * 0.92) };
  });

  function rate(c, t) {        // launches per second at time t
    const lt = sfTime(t);
    let r = (c.per10 / 600) * AIRCRAFT_HOUR[Math.floor(lt.hour) % 24];
    if (c.kind === "light") {
      if (t < sunrise(lt.day) || t > sunset(lt.day)) return 0;
      if (lt.weekend) r *= AIRCRAFT.lightWeekend;
    }
    return r;
  }

  function launch(c, k) {
    const ts = k * AIRCRAFT.slot;
    if (u01(SEED.plane, c.i, k, 1) >= rate(c, ts) * AIRCRAFT.slot) return null;
    return {
      t0: ts + u01(SEED.plane, c.i, k, 2) * AIRCRAFT.slot,
      rev: c.both_ways && u01(SEED.plane, c.i, k, 3) < 0.5,
      lat: (u01(SEED.plane, c.i, k, 4) * 2 - 1) * c.jitter_xy,
      dh: (u01(SEED.plane, c.i, k, 5) * 2 - 1) * c.jitter_h,
      vf: 0.92 + 0.16 * u01(SEED.plane, c.i, k, 6),
      size: c.kind === "light" ? 0.8 + 0.4 * u01(SEED.plane, c.i, k, 7) : 0.6 + 0.6 * u01(SEED.plane, c.i, k, 7),
      phase: u01(SEED.plane, c.i, k, 8),
    };
  }

  function place(c, a, T, id) {
    const v = c.speed * a.vf;
    const s = (T - a.t0) * v;
    if (s < 0 || s > c.line.L) return null;
    const p = c.line.at(a.rev ? c.line.L - s : s, 400);
    const heading = a.rev ? (p.heading + 180) % 360 : p.heading;
    const x = p.x + a.lat * Math.cos(heading * DEG), y = p.y - a.lat * Math.sin(heading * DEG);
    const h = Math.max(120, p.h + a.dh);
    const z = frame.z(x, y, h);
    const nav = navLights(x, y, heading, 110);
    const T1 = T + a.phase * 10;
    const strobe = (T1 % AIRCRAFT.strobe) < 0.08 ? 1 : 0;
    const beacon = ((T1 + 0.5) % AIRCRAFT.beacon) < 0.15 ? 1 : 0;
    const landing = c.arrival && h < AIRCRAFT.landingBelowFt * 0.3048 && Math.abs(nav.off) < 70 ? 1 : 0;
    const gk = Math.floor(T1 / 9);
    const glint = u01(SEED.plane, gk, Math.round(a.t0), 9) < 0.18 && T1 - gk * 9 < 0.6 ? 1 : 0;
    return {
      id, kind: c.kind, corridor: c.id, x, y, z, h, heading, speed: v, span: c.span * a.size, len: c.span * a.size * 0.95,
      arrival: c.arrival, lights: { red: nav.red, green: nav.green, tail: nav.stern, strobe, beacon, landing }, glint,
      alpha: Math.min(1, s / 1500, (c.line.L - s) / 1500),
    };
  }

  // per-visitor: one plane that enters the window a few seconds after the living layer starts, by day, when the
  // window is otherwise empty (plan 2.3: "the only per-visitor extras are the welcome gull and one front-loaded plane")
  // (decided from the sky at S alone, so it is the same whenever the page first asks)
  const fronts = new Map();
  function front(S) {
    if (fronts.has(S)) return fronts.get(S);
    let f = null;
    const lt = sfTime(S);
    if (sun(S).alt > 2 && AIRCRAFT_HOUR[Math.floor(lt.hour)] >= 0.5) {
      const empty = !base(S).some((p) => inDesk(p.x, p.y, p.z, 0));
      if (empty) {
        const air = cors.filter((c) => c.kind === "airliner" && c.enter !== null);
        const c = air[Math.floor(u01(SEED.visitor, Math.floor(S), 1) * air.length)];
        f = { c, a: { t0: S + 3 - c.enter / c.speed, rev: false, lat: 0, dh: 0, vf: 1, size: 0.9, phase: 0.3 } };
      }
    }
    if (fronts.size > 8) fronts.clear();
    fronts.set(S, f);
    return f;
  }

  function base(T) {
    const out = [];
    for (const c of cors) {
      const k0 = Math.floor((T - c.maxDur) / AIRCRAFT.slot) - 1, k1 = Math.floor(T / AIRCRAFT.slot);
      for (let k = k0; k <= k1; k++) {
        const a = launch(c, k);
        if (!a) continue;
        const p = place(c, a, T, `p${c.i}:${k}`);
        if (p) out.push(p);
      }
    }
    return out;
  }

  function at(T, c0, env = {}) {
    const out = base(T);
    if (env.sessionStart !== undefined && env.sessionStart !== null) {
      const f = front(env.sessionStart);
      if (f) {
        const p = place(f.c, f.a, T, "p-front");
        if (p) out.push(p);
      }
    }
    for (const p of out) p.view = view(p.x, p.y, p.z);
    return out;
  }

  return { at, corridors: cors };
}
