// Events 14 and 15, as data for the sound stream (web/shared/sound.js): foghorns, ship fog signals, the Hyde Street
// cable car, and light planes passing close. Nothing here makes a sound; it says what is sounding at T and where.
//
// Foghorns keep their real patterns (USCG Light List vol. VI 2025) phased to UTC seconds and are heard late by
// distance / 343 m/s; the bridge horns and Point Bonita sound when the shown moment's fog over the deck is above
// 0.35 (bridge workers switch them on by hand). The cable car follows SFMTA's Powell-Hyde timetable: each car is
// heard for about 40 s as it passes below the window, with bells (hashed), and the cable hums while cars run.
import { FOGHORNS, FOG_ON, SOUND_SPEED, CABLE_CAR } from "../tables.js";
import { sfTime, sfToT } from "../clock.js";
import { u01, SEED } from "../hash.js";
import { fromLatLon, view } from "../geo.js";

function pattern(p, t) {   // 1 while a blast sounds at local cycle time t
  const cyc = p.reduce((a, b) => a + b, 0);
  let x = ((t % cyc) + cyc) % cyc;
  for (let i = 0; i < p.length; i++) {
    if (x < p[i]) return i % 2 === 0 ? 1 : 0;
    x -= p[i];
  }
  return 0;
}

export function createSound(routes, frame) {
  const horns = FOGHORNS.map((h) => {
    const [x, y] = fromLatLon(routes.frame, h.lat, h.lon);
    const v = view(x, y, frame.z(x, y, 10));
    return { ...h, x, y, bearing: v.bearing, dist: v.dist, delay: v.dist / SOUND_SPEED };
  });

  function cable(T) {
    const t = sfTime(T);
    const cars = [];
    let first = Infinity, last = -Infinity;
    for (const [list, lead, dir] of [[CABLE_CAR.outboundAtBeach, CABLE_CAR.outboundLead, "out"], [CABLE_CAR.inboundFromBeach, CABLE_CAR.inboundLag, "in"]]) {
      for (const m of list) {
        const key = t.day * 2000 + m * 2 + (dir === "out" ? 0 : 1);
        const tp = sfToT(t.day, (m + lead) * 60) + u01(SEED.cable, key % 2147483647, 1) * CABLE_CAR.jitter;
        first = Math.min(first, tp); last = Math.max(last, tp);
        const dt = T - tp;
        if (Math.abs(dt) > CABLE_CAR.passSeconds / 2) continue;
        const bell = u01(SEED.cable, key % 2147483647, Math.floor((dt + 30) * 2)) < 0.35 ? 1 : 0;
        cars.push({ dir, dt, bell, level: 1 - Math.abs(dt) / (CABLE_CAR.passSeconds / 2) });
      }
    }
    const hum = T > first - 600 && T < last + 600 ? 1 : 0;
    return { hum, cars };
  }

  function at(T, c, ships, planes) {
    const fogOn = c.fog > FOG_ON;
    const out = { fog: fogOn, horns: [], ships: [], cable: cable(T), planes: [] };
    for (const h of horns) {
      if (!fogOn && h.fog) continue;
      out.horns.push({ id: h.id, name: h.name, bearing: h.bearing, dist: h.dist, delay: h.delay,
        emit: pattern(h.pattern, T - h.phase), heard: pattern(h.pattern, T - h.delay - h.phase) });
    }
    if (fogOn) {
      for (const s of ships) if (s.horn !== undefined) {
        out.ships.push({ id: s.id, bearing: s.view.bearing, dist: s.view.dist, blast: s.horn });
      }
    }
    for (const p of planes) if (p.kind === "light" && p.view.dist < 3000) out.planes.push({ id: p.id, bearing: p.view.bearing, dist: p.view.dist });
    return out;
  }
  return { at, horns, cable };
}
