// Events 10 and 11: windows lighting up and going dark, street lamps and the bridge's lights switching with the sun.
//
// Windows. A cell of the window light layer (1/28 deg on the 64 px/deg panorama) is lit when hash(cell, night) is
// below S = 0.40 x H(hour) x M(month) x darkness, with the RESNET/NREL hourly curve (an hour later on Friday and
// Saturday nights) and darkness 1 below sun -4 deg, 0 above +6 deg. The evening and the early morning use two
// different hashes (blended through 01:00-04:00, when few are lit), so the night owls are not the early risers. As S
// falls a cell goes dark the moment S passes its hash, fading over 0.35 s: about one window every 6 s at 21-23 h.
// 5% of lit cells flicker TV-blue 19-23 h. Each night (noon to noon) draws new hashes; at noon nothing is lit.
//
// Lamps. Lamp j switches on when the sun sinks below -4.5 deg, shifted by a hashed +-5 min (about 15-25 min after
// sunset), 10 min earlier in fog, and off the same way before sunrise. The bridge floodlights switch with the middle
// of the spread.
import { WINDOWS, WINDOW_HOURLY, WINDOW_MONTHLY, LAMPS } from "../tables.js";
import { sfTime, sfDay, sfToT, sunCross, utcOffset } from "../clock.js";
import { u01, u24, SEED, GLSL_HASH } from "../hash.js";
import { clamp, smooth } from "../geo.js";

const MID = [15, 45, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];   // mid-month day of year

export function monthly(doy) {
  let i = 11;
  for (let k = 0; k < 12; k++) if (MID[k] <= doy) i = k;
  const j = (i + 1) % 12, d0 = MID[i], d1 = j === 0 ? MID[0] + 365 : MID[j];
  const dd = doy < MID[0] ? doy + 365 : doy;
  const u = clamp((dd - d0) / (d1 - d0), 0, 1);
  return WINDOW_MONTHLY[i] + (WINDOW_MONTHLY[j] - WINDOW_MONTHLY[i]) * u;
}
function hourly(h) {
  const x = h - 0.5, h0 = Math.floor(x), u = x - h0;
  return WINDOW_HOURLY[((h0 % 24) + 24) % 24] * (1 - u) + WINDOW_HOURLY[(((h0 + 1) % 24) + 24) % 24] * u;
}

export function createWindows(routes, frame, bridge) {
  // the night a moment belongs to: noon of day n to noon of day n + 1
  const nightOf = (t) => (t.hour >= 12 ? t.day : t.day - 1);

  function share(T, sunAlt) {
    const t = sfTime(T);
    const n = nightOf(t), night = sfDay(n);
    // hours since the night's noon: by the wall clock, 0..24 (the TV slot), and by elapsed time (ha). The household
    // clock hb is the wall clock, except that on the two DST nights it eases the hour's jump over 01:00-04:00, when
    // few windows are lit, so the field never flips at once when the clocks change.
    const hn = t.hour >= 12 ? t.hour - 12 : t.hour + 12;
    const noon = sfToT(n, 12 * 3600);
    const ha = (T - noon) / 3600;
    const shift = (utcOffset(sfToT(n + 1, 12 * 3600)) - utcOffset(noon)) / 3600;   // +1 spring, -1 autumn, else 0
    const hb = 12 + ha + shift * smooth(13, 16, ha);
    // a Friday or Saturday night runs an hour later
    const late = night.wd === 5 || night.wd === 6 ? WINDOWS.weekendShift * smooth(4, 6, ha) * (1 - smooth(15, 17, ha)) : 0;
    const H = hourly(hb - late);
    const S = WINDOWS.peak * H * monthly(t.doy + t.hour / 24) * (1 - smooth(WINDOWS.dark[0], WINDOWS.dark[1], sunAlt));
    const w = 1 - smooth(13, 16, ha);       // evening weight: 1 until 01:00, 0 after 04:00
    const E = S * w, M = E < 1 ? Math.max(0, (S - E) / (1 - E)) : 0;
    return { S, E, M, night: n, hn };
  }

  // everything a shader needs this frame (and what the CPU path below uses)
  function state(T, c) {
    const a = share(T, c.sun.alt);
    const b = share(T + 1, c.sun.alt), b0 = share(T - 1, c.sun.alt);   // sun moves ~0.004 deg/s: ignored here
    const fade = (x1, x0) => Math.max(1e-9, (Math.abs(x1 - x0) / 2) * WINDOWS.fade);
    const tvOn = smooth(19 - 12, 19.25 - 12, a.hn) * (1 - smooth(23 - 12, 23.25 - 12, a.hn));
    return { S: a.S, E: a.E, M: a.M, fadeE: fade(b.E, b0.E), fadeM: fade(b.M, b0.M), night: a.night,
      darkPerSec: Math.max(0, (b0.S - b.S) / 2), tv: WINDOWS.tv.share, tvOn, hn: a.hn, cells: WINDOWS.cells };
  }

  // one cell's level 0..1 (and TV flicker) from state(); cell is an integer id (e.g. row * 65536 + column)
  function cell(id, st, T) {
    const hE = u24(SEED.window, st.night, id, 1), hM = u24(SEED.window, st.night, id, 2);
    const lv = Math.max(clamp((st.E - hE) / st.fadeE + 0.5, 0, 1), clamp((st.M - hM) / st.fadeM + 0.5, 0, 1));
    let tv = 0;
    if (lv > 0 && st.tvOn > 0 && u24(SEED.window, st.night, id, 3) < st.tv) {
      const from = 7 + u24(SEED.window, st.night, id, 4), to = 10 + 1.5 * u24(SEED.window, st.night, id, 5);
      if (st.hn >= from && st.hn < to) tv = 0.55 + 0.45 * u24(SEED.window, id, Math.floor(T * 5) % 16777216, 6);
    }
    return { level: lv, tv };
  }

  // ---------------- lamps
  function lampTimes(T, c) {
    const t = sfTime(T);
    const n = nightOf(t);
    const fog = c.fog > LAMPS.fog ? LAMPS.fogEarly : 0;
    return { on: sunCross(n, LAMPS.alt, true), off: sunCross(n + 1, LAMPS.alt, false), fog, spread: LAMPS.spread };
  }
  function lamp(j, lt, T) {
    const u = (u01(SEED.lamp, j, 1) * 2 - 1) * lt.spread;
    const a = lt.on + u - lt.fog, b = lt.off + u + lt.fog;
    return Math.min(smooth(a, a + LAMPS.fade, T), 1 - smooth(b, b + LAMPS.fade, T));
  }

  // the bridge's deck lamps as points (the scene's 50 m posts, both sides)
  const B = routes.bridge;
  const deck = [];
  for (let s = B.s_south_end + 20, j = 0; s < B.s_north_end - 20; s += B.lamp_every) {
    for (const side of [-1, 1]) {
      const [x, y, z] = bridge.point(s, side * B.lamp_w, bridge.deckBottom(s) + B.truss + B.road + B.lamp_h);
      deck.push({ id: `lamp${j}`, j: 50000 + j++, x, y, z });
    }
  }

  function at(T, c) {
    const st = state(T, c);
    const lt = lampTimes(T, c);
    const lamps = deck.map((p) => ({ id: p.id, kind: "lamp", x: p.x, y: p.y, z: p.z, colour: "amber", level: lamp(p.j, lt, T) }))
      .filter((p) => p.level > 0.001);
    // share of street lamps on (for the light layer's overall gain) from 200 sample lamps
    let on = 0;
    for (let j = 0; j < 200; j++) on += lamp(j, lt, T);
    const flood = Math.min(smooth(lt.on - lt.fog, lt.on - lt.fog + 30, T), 1 - smooth(lt.off + lt.fog, lt.off + lt.fog + 30, T));
    return { windows: st, lamps: { ...lt, share: on / 200, flood, deck: lamps } };
  }

  return { at, state, cell, lamp, lampTimes, share };
}

// The same per-cell rules in GLSL: pass the fields of state() as uniforms, uTvTick = floor(T * 5) % 16777216.
// cell = row * 65536 + column of the light layer.
export const GLSL_WINDOWS = `${GLSL_HASH}
uniform float uWinE, uWinM, uWinFadeE, uWinFadeM, uWinTvOn, uWinHn, uTvTick;
uniform uint uWinNight;
float cityWindow(uint cell, out float tv) {
  float hE = cityU01(${SEED.window}u, uWinNight, cell, 1u), hM = cityU01(${SEED.window}u, uWinNight, cell, 2u);
  float lv = max(clamp((uWinE - hE) / uWinFadeE + 0.5, 0.0, 1.0), clamp((uWinM - hM) / uWinFadeM + 0.5, 0.0, 1.0));
  tv = 0.0;
  if (lv > 0.0 && uWinTvOn > 0.0 && cityU01(${SEED.window}u, uWinNight, cell, 3u) < ${WINDOWS.tv.share}) {
    float from = 7.0 + cityU01(${SEED.window}u, uWinNight, cell, 4u), to = 10.0 + 1.5 * cityU01(${SEED.window}u, uWinNight, cell, 5u);
    if (uWinHn >= from && uWinHn < to) tv = 0.55 + 0.45 * cityU01(${SEED.window}u, cell, uint(uTvTick), 6u);
  }
  return lv;
}`;
