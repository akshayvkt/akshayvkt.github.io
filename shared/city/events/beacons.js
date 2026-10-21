// Event 2: the bridge's beacons and lights, the lighthouses and the charted harbour lights.
//
// Characteristics are the real ones (USCG Light List vol. VI 2025, routes.json "lights"); each light keeps its own
// fixed phase (a hash of its number) against UTC seconds, so every visitor sees the same flash. The tower beacons
// flash together, 30 a minute (the FAA L-864 standard; the bridge district does not publish its rate). Lights come on
// below sun -3 deg and fade out by -0.6 deg (about 10-13 minutes), and the lighthouses and harbour lights also show
// in the fog moments.
import { u01, SEED } from "../hash.js";
import { smooth } from "../geo.js";

export const RGB = { white: [1.0, 0.95, 0.86], red: [1.0, 0.13, 0.07], green: [0.35, 1.0, 0.55], yellow: [1.0, 0.82, 0.35],
  amber: [1.0, 0.72, 0.42] };
const BEACON = { period: 2.0, on: [[0, 0.67]] };   // 30 flashes a minute (est. for this bridge)
const EDGE = 0.06;                                   // s, a soft edge so flashes don't alias at 20-30 fps

// brightness 0..1 of a light with on-intervals within its period, at local phase p (s)
export function flash(p, period, on) {
  p = ((p % period) + period) % period;
  let v = 0;
  for (const [a, b] of on) {
    for (const q of [p, p - period, p + period]) {   // edges that wrap round the cycle
      v = Math.max(v, Math.min(smooth(a - EDGE, a + EDGE, q), 1 - smooth(b - EDGE, b + EDGE, q)));
    }
  }
  return v;
}

export function nightLevel(sunAlt) { return 1 - smooth(-3.0, -0.6, sunAlt); }

export function createBeacons(routes, frame, bridge) {
  const B = routes.bridge;
  const cableZ = (s) => {
    const a = Math.abs(s), st = B.s_tower;
    if (a <= st) return B.cable.low + B.deck_lift * (1 - (a / st) ** 2) + (B.cable.saddle - B.cable.low) * (a / st) ** 2;
    const t = (a - st) / (B.s_anchor - st), za = bridge.deckBottom(B.s_anchor) + 9;
    return B.cable.saddle + (za - B.cable.saddle) * t - 22 * 4 * t * (1 - t);
  };
  const pts = [];
  const add = (id, kind, s, w, h, colour, intensity, pattern, phase) => {
    const [x, y, z] = bridge.point(s, w, h);
    pts.push({ id, kind, x, y, z, colour, rgb: RGB[colour], intensity, pattern, phase });
  };
  for (const st of [-B.s_tower, B.s_tower]) {
    const tw = st < 0 ? "s" : "n";
    for (const side of [-1, 1]) {
      add(`beacon_${tw}${side > 0 ? "e" : "w"}`, "beacon", st, side * B.tower_leg_w, B.tower_top + 0.8, "red", 0.9, BEACON, 0);
      add(`tower_mid_${tw}${side > 0 ? "e" : "w"}`, "bridge_light", st, side * B.mid_light.w, B.mid_light.h, "red", 0.5, null, 0);
    }
  }
  add("midspan_green", "bridge_light", 0, -1.5, bridge.deckBottom(0) - 0.6, "green", 0.45, null, 0);
  add("midspan_white", "bridge_light", 0, 1.5, bridge.deckBottom(0) - 0.6, "white", 0.45, null, 0);
  for (const side of [-1, 1]) {
    for (let s = -B.s_anchor + 38; s < B.s_anchor - 30; s += 76) {
      if (Math.abs(Math.abs(s) - B.s_tower) < 20) continue;
      add(`cable_${side > 0 ? "e" : "w"}${Math.round(s)}`, "cable_light", s, side * B.cable_w, cableZ(s) + 1, "red", 0.22, null, 0);
    }
  }
  for (const L of routes.lights) {
    const z = frame.z(L.x, L.y, L.h);
    pts.push({ id: L.id, kind: L.major ? "lighthouse" : "aid", name: L.name, x: L.x, y: L.y, z, colour: L.colour,
      rgb: RGB[L.colour], intensity: L.major ? 1.0 : Math.min(0.6, 0.12 + 0.06 * L.range_nm),
      pattern: { period: L.period, on: L.on }, phase: u01(SEED.beacon, Math.round(L.llnr * 10)) * L.period });
  }

  function at(T, c) {
    const night = nightLevel(c.sun.alt);
    const fogOn = smooth(0.3, 0.4, c.fog);
    const out = [];
    for (const p of pts) {
      const on = p.kind === "lighthouse" || p.kind === "aid" ? Math.max(night, 0.7 * fogOn)
        : p.kind === "beacon" ? Math.max(night, 0.5 * fogOn) : night;
      if (on <= 0.001) continue;
      const f = p.pattern ? flash(T + p.phase, p.pattern.period, p.pattern.on) : 1;
      out.push({ id: p.id, kind: p.kind, x: p.x, y: p.y, z: p.z, colour: p.colour, rgb: p.rgb,
        level: on * f, on, intensity: p.intensity });
    }
    return out;
  }
  return { at, points: pts };
}
