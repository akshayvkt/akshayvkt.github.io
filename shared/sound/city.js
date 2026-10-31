// The city outside the window, heard: what shared/city/ says is happening at T, made into sound. Everything here is
// placed in time by the city's own clock (the same pure functions of T the view uses: two visitors hear the same
// foghorn at the same second) and in space by its bearing from the room (the stereo field turns with the camera).
// All of it reaches the room through the window glass (engine.js: a low-pass and a few dB that open up at the window
// spot), except what comes from behind the building (the wharf's boats), which comes through the walls.
//
//   beds (always running, levels follow the moment):
//     traffic    the city below: pink noise under 650 Hz and a brown rumble under 140 Hz, its level following the day's
//                traffic (Golden Gate Bridge counts by hour and day type, tables.js BRIDGE_HOURLY, as the shape of a
//                San Francisco day: thin at 3 am, two commute peaks), slow swells of a couple of dB, and single cars
//                passing below now and then (a Poisson process at 0.3-6 a minute by the same curve)
//     wind       the sea breeze at the glass: Fort Point's hourly mean wind (clock.wind, x1.5 over open water), brown
//                noise band-passed near 300 Hz, in gusts (a new strength every 1.5-5 s), and a faint whistle at the
//                frame above 12 kt
//     cable      the Hyde Street cable's hum in its slot while the cars run (sound.js cable().hum)
//     far air    airliners' distant roar, by their distance
//   events:
//     foghorns   the bridge's south-pier pair, its mid-span diaphone, Point Diablo and Point Bonita (USCG Light List
//                patterns, phased to UTC, heard late by distance / 343 m/s), when the moment's fog is over 0.35 (Point
//                Diablo sounds always, faint in clear air); tuned D-A, A>D, E and B: a slow, open chord with the music
//     ships      in fog, one prolonged blast every two minutes (COLREGS rule 35) from each ship in the channel
//     ferries    the Sausalito ferry's blast as it leaves its dock (Inland Rules 34(g)), at its timetabled departures
//     tour boats a blast as each leaves the wharf on its timetable, heard through the building, behind the room
//     gulls      a call or a few from gulls passing the window (the view's own gulls, 30-150 m out), and far ones by day
//     birds      the dawn chorus (white-crowned sparrows, house finches, a mourning dove) as the sun comes up, a little by day
//     cable car  each Powell-Hyde car passing below for ~40 s on SFMTA's timetable: its rumble and slot clatter, and
//                the gripman's bell, rung where the city's hash says (a few short patterns a pass)
//     planes     light planes passing close: a propeller's drone with its Doppler shift
import { horn, gull, bell, noise, sparrow, finch, dove } from "./instruments.js";
import { db, clamp, lerp, smooth, wrap180, gain, filter, panner, loop, startAt } from "./dsp.js";
import { CABLE_CAR, BRIDGE_HOURLY, BRIDGE_SCALE } from "../city/tables.js";
import { sfTime, sfToT } from "../city/clock.js";
import { u01, SEED } from "../city/hash.js";
import { view } from "../city/geo.js";

const LOOK = 1.6;                 // s scheduled ahead of the context's clock
const SPEED = 343;

// The horns' voices: tones (Hz) and kind. Real horns' pitches are not published; these are chosen to sound like them
// (deep, buzzing, the old diaphone's grunt) and to sit in the music's key.
const HORN_VOICE = {
  ggb_south: { tones: [146.83, 220.0], kind: "horn", db: 0 },      // D3 + A3, two horns together
  ggb_mid: { tones: [220.0], kind: "diaphone", db: -1.5 },         // A3 falling toward D3: "bee-oh"
  diablo: { tones: [164.81], kind: "horn", db: -5.4 },             // E3
  bonita: { tones: [123.47], kind: "horn", db: -4 },               // B2
};
const SHIP_TONES = { container: [73.42], tanker: [82.41], carcarrier: [92.5], bulk: [110], tugbarge: [220], cruise: [73.42, 110] };

// The levels (dB) at the source's reference distance; the engine's buses set the mix. Distances in metres.
export const CITY_DB = {
  traffic: -17, rumble: -23, carPass: -7.5, wind: -18, whistle: -44, cableHum: -32, farAir: -36,
  horn: -19, hornRef: 3500, ship: -19.5, shipRef: 3500, ferry: -24.5, ferryRef: 6500, tour: -30,
  gull: -12, gullRef: 50, gullFar: -19, bird: -25.5, cableRumble: -12, cableBell: -19, plane: -24, planeRef: 600,
};

// one cycle of a Light List pattern [on, off, on, off...] s: the onsets (s into the cycle) and lengths of its blasts
function blasts(p) {
  const out = [];
  let x = 0;
  for (let i = 0; i < p.length; i++) { if (i % 2 === 0) out.push([x, p[i]]); x += p[i]; }
  return { cycle: x, list: out };
}

export function createCityScene(eng, { out, wall, sends, farSends }) {
  const { ctx } = eng;
  const r = eng.rnd;
  const log = eng.log;
  const beds = {};
  // ---------------------------------------------------------------- beds
  function bed(name, buf, chain, lvl, pan = 0) {
    const src = loop(ctx, buf, r);
    let node = src;
    for (const [type, f, q] of chain) { const b = filter(ctx, type, f, q); node.connect(b); node = b; }
    const g = gain(ctx, 0);
    const p = panner(ctx, pan);
    node.connect(g).connect(p).connect(out);
    startAt(src, ctx.currentTime);
    beds[name] = { src, g, p, lvl, chain: node };
    eng.onStop(() => { try { src.stop(); src.disconnect(); g.disconnect(); p.disconnect(); } catch { /* */ } });
    return beds[name];
  }
  bed("traffic", eng.noise.pink2, [["lowpass", 650, 0.6], ["highpass", 40, 0.7]], CITY_DB.traffic);
  bed("rumble", eng.noise.brown2, [["lowpass", 140, 0.7]], CITY_DB.rumble);
  bed("wind", eng.noise.brown2, [["bandpass", 300, 0.5]], CITY_DB.wind);
  bed("whistle", eng.noise.white, [["bandpass", 1150, 22]], CITY_DB.whistle, 0.35);
  bed("cable", eng.noise.brown, [["bandpass", 95, 1.2], ["lowpass", 400, 0.7]], CITY_DB.cableHum, -0.3);
  bed("farAir", eng.noise.brown, [["lowpass", 260, 0.7]], CITY_DB.farAir, 0.2);
  const windBand = beds.wind.chain;

  // ---------------------------------------------------------------- state
  let untilT = null;             // world time up to which events are scheduled
  let snap = null, snapT = -1e9;
  const seen = new Set();        // ids already given their sounds (gulls, cable cars, departures)
  const planes = new Map();      // id -> drone voice
  const rungs = new Map();       // cable car pass -> { n: bells rung, last: T of the last }
  const holds = [];              // [start, end] context times of horn blasts (the music waits)
  let nextGust = 0, nextSwell = 0, nextCar = null, nextFarGull = null;
  const birds = { sparrow: null, finch: null, dove: null };
  const people = { sparrowPans: [r.range(-0.6, -0.2), r.range(0.15, 0.55)], finchPan: r.range(-0.4, 0.4), dovePan: r.range(-0.7, 0.7) };
  let horns = null;              // the city's horns with their bearings, from sound.js
  const levels = { traffic: 0, wind: 0, fog: 0, sun: 0, rising: true, day: 0, birds: 0 };

  const panFor = (L, bearing) => 0.78 * Math.tanh(wrap180(bearing - L.bearing) / 30) * L.width;
  const distDb = (d, ref) => -20 * Math.log10(Math.max(1, d) / ref);
  const at = (now, T, Tev) => now + (Tev - T);       // a world time -> the context's time

  // traffic index 0..1 from the bridge's hourly counts (both ways), interpolated in the hour
  function trafficIndex(t) {
    const tab = BRIDGE_HOURLY[t.dayType] || BRIDGE_HOURLY.weekday;
    const h = t.hour, h0 = Math.floor(h) % 24, h1 = (h0 + 1) % 24, u = h - Math.floor(h);
    const v = (k) => (tab[k][0] + tab[k][1]) * BRIDGE_SCALE.total;
    return clamp(lerp(v(h0), v(h1), u) / 7500, 0.02, 1);
  }

  // ---------------------------------------------------------------- event voices
  function playHorn(t, dur, voice, d, L, bearing, extraDb, why) {
    const lvl = db(CITY_DB.horn + voice.db + distDb(d, CITY_DB.hornRef) + extraDb);
    horn(eng, { t, dur, tones: voice.tones, kind: voice.kind, level: lvl, pan: panFor(L, bearing), dist: d, out, sends: farSends });
    if (d < 4500) holds.push([t - 0.4, t + dur + (voice.kind === "diaphone" ? 0.4 : 0) + 1.4]);   // the music waits for the bridge's
    log?.("horn", t, { id: why, dur, dist: Math.round(d), level: +(20 * Math.log10(lvl)).toFixed(1), pan: +panFor(L, bearing).toFixed(2) });
  }
  function cablePass(tp, dir, now, L) {
    // the car's rumble and its grip in the slot: brown noise below 260 Hz and a band of clatter, swelling as it passes
    const t1 = tp - 20, t2 = tp + 20;
    const s = Math.max(t1, now), e = t2;
    if (e - s < 2) return;
    const env = [];
    for (let x = s; x <= e + 0.01; x += 1) { const k = Math.exp(-((x - tp) ** 2) / (2 * 7 ** 2)); env.push([x - s, k]); }
    env[0][1] = 0; env[env.length - 1][1] = 0;
    const p0 = dir === "out" ? -0.65 : 0.65;
    const panPath = [[0, p0 * (1 - (s - t1) / 40) + -p0 * ((s - t1) / 40)], [e - s, -p0]];
    noise(eng, { t: s, color: "brown", chain: [["lowpass", 260, 0.8]], env: env.map(([x, k]) => [x, k * db(CITY_DB.cableRumble)]), panPath, out, kind: "cable" });
    noise(eng, { t: s, color: "white", chain: [["bandpass", 1500, 2.5], ["lowpass", 3000, 0.7]], env: env.map(([x, k]) => [x, k * k * db(CITY_DB.cableRumble - 9)]), panPath, out, kind: "cable" });
    log?.("cablecar", s, { dir, pass: +(tp - s).toFixed(1) });
  }
  function bellPattern(t, lvl, pan) {
    const pat = r.weighted([[[0, 0.22], 4], [[0, 0.5, 0.7], 3], [[0, 0.16, 0.32, 0.48, 0.64], 1], [[0], 2]]);
    for (const dt of pat) bell(eng, { t: t + dt + r.range(-0.01, 0.01), f0: 659.25, level: lvl * r.range(0.8, 1), damp: r.range(0.55, 0.8), pan, out, sends });
    log?.("bell", t, { strikes: pat.length });
  }

  // ---------------------------------------------------------------- the update (every engine tick)
  return {
    beds,
    get levels() { return levels; },
    // the music asks: may a phrase of `len` s start at t, or must it wait for a blast to pass?
    hold(t, len) {
      for (let k = 0; k < 6; k++) {
        const h = holds.find(([a, b]) => t < b && t + Math.min(len, 3) > a);
        if (!h) return t;
        t = h[1];
      }
      return t;
    },
    jump(now, T) {   // the clock jumped (the dial): forget what was planned, plan again from T
      untilT = T;
      holds.length = 0;
      for (const v of eng.voices) if (v.t0 > now + 0.05 && ["horn", "gull", "bell", "bird", "noise", "cable"].includes(v.kind)) v.stop(0.02);
      nextCar = nextFarGull = null;
    },
    update(now, T, L, city, quiet) {
      // the city's state, once a second (it is what the view draws)
      if (!snap || Math.abs(T - snapT) >= 1) { snap = city.state(T); snapT = T; }
      if (!horns) horns = city.sound.horns;
      const c = snap.clock, t = sfTime(T);
      const fog = c.fog || 0, alt = c.sun.alt, rising = c.sun.az < 180;
      const hornsOn = fog > 0.35;
      levels.fog = fog; levels.sun = alt; levels.rising = rising;
      while (holds.length && holds[0][1] < now - 5) holds.shift();
      if (untilT === null || T - untilT > 30 || untilT - T > LOOK + 5) untilT = T;
      const T1 = T + LOOK;
      const ok = !quiet;                                  // a scrub of the dial: beds only, no events

      // ---- beds
      const ti = trafficIndex(t);
      levels.traffic = ti;
      const tau = 1.5;
      beds.traffic.g.gain.setTargetAtTime(db(CITY_DB.traffic + 14 * Math.log10(0.1 + ti)), now, tau);
      beds.rumble.g.gain.setTargetAtTime(db(CITY_DB.rumble + 10 * Math.log10(0.1 + ti)), now, tau);
      const kt = c.wind.open;
      levels.wind = kt;
      const windBase = CITY_DB.wind + 20 * smooth(2, 20, kt) - 10;
      if (now >= nextGust) {
        const gust = r.range(0.5, 1.35);
        const dt = r.range(1.5, 5);
        beds.wind.g.gain.setTargetAtTime(db(windBase) * gust, now, dt / 3);
        windBand.frequency.setTargetAtTime(lerp(220, 480, clamp((gust - 0.5) / 0.85, 0, 1)), now, dt / 3);
        beds.whistle.g.gain.setTargetAtTime(db(CITY_DB.whistle) * smooth(11, 20, kt) * Math.max(0, gust - 0.85) ** 2 * 4, now, dt / 4);
        nextGust = now + dt;
      }
      const cab = snap.sound.cable;
      beds.cable.g.gain.setTargetAtTime(cab.hum ? db(CITY_DB.cableHum) : 0, now, 3);
      let air = 0;
      for (const p of snap.planes) if (p.kind !== "light" && p.view) air += (3000 / Math.max(800, p.view.dist)) ** 2;
      beds.farAir.g.gain.setTargetAtTime(db(CITY_DB.farAir) * Math.sqrt(Math.min(4, air)), now, 3);
      // the beds' noise loops never repeat audibly: each one's speed drifts slowly (a few percent, every 4-9 s)
      for (const b of Object.values(beds)) {
        if (now < (b.drift || 0)) continue;
        b.src.playbackRate.setTargetAtTime(r.range(0.93, 1.07), now, r.range(1.5, 3));
        b.drift = now + r.range(4, 9);
      }
      if (now >= nextSwell) {   // the traffic's slow swells: a couple of dB either way
        const k = db(r.range(-2.5, 2));
        beds.traffic.p.pan.setTargetAtTime(r.range(-0.25, 0.25), now, 3);
        beds.traffic.g.gain.setTargetAtTime(db(CITY_DB.traffic + 14 * Math.log10(0.1 + ti)) * k, now + 0.05, 2);
        nextSwell = now + r.range(2, 6);
      }
      if (!ok) { untilT = T1; return; }

      // ---- single cars passing below (Poisson, by the traffic)
      const carsPerMin = lerp(0.3, 6, ti);
      if (nextCar === null) nextCar = now + r.poisson(carsPerMin);
      while (nextCar < now + LOOK) {
        const d = r.range(4, 7.5), lv = db(CITY_DB.carPass + r.range(-6, 1)), ltr = r.chance(0.5) ? 1 : -1;
        noise(eng, { t: nextCar, color: "pink", chain: [["bandpass", 380, 0.8, 0, [[0, 300], [d * 0.45, 650], [d, 280]]], ["lowpass", 1400, 0.7]],
          env: [[0, 0], [d * 0.45, lv], [d, 0]], panPath: [[0, -0.7 * ltr], [d, 0.7 * ltr]], out, kind: "noise" });
        log?.("car", nextCar, { dur: +d.toFixed(1) });
        nextCar += r.poisson(carsPerMin);
      }

      // ---- foghorns (heard times, from the Light List patterns)
      for (const h of horns || []) {
        // (Point Diablo's horn runs day and night, but from inside, 5.5 km off in clear air, it is under the city's
        // murmur: like the others it is heard in fog)
        if (!hornsOn) continue;
        const voice = HORN_VOICE[h.id];
        if (!voice) continue;
        const { cycle, list } = blasts(h.pattern);
        const base = h.phase + h.delay;
        for (let k = Math.floor((untilT - base) / cycle) - 1; k <= Math.floor((T1 - base) / cycle) + 1; k++) {
          for (const [o, len] of list) {
            const Ton = k * cycle + o + base;
            if (Ton < untilT || Ton >= T1) continue;
            playHorn(at(now, T, Ton), len, voice, h.dist, L, h.bearing, 3 * (fog - 0.35), h.id);
          }
        }
      }
      // ---- ships' fog signals (COLREGS rule 35)
      if (hornsOn) {
        for (const s of snap.ships) {
          if (s.horn === undefined || !s.view) continue;
          const m = /^s(-?\d+)$/.exec(s.id), c2 = /^c(\d+)([io])$/.exec(s.id);
          const key = m ? +m[1] : c2 ? 100000 + +c2[1] * 2 + (c2[2] === "i" ? 0 : 1) : null;
          if (key === null) continue;
          const ph = u01(SEED.horn, key, 1) * 120, len = 4 + 2 * u01(SEED.horn, key, 2);
          const delay = s.view.dist / SPEED;
          for (let n = Math.floor((untilT - delay + ph) / 120); n <= Math.floor((T1 - delay + ph) / 120) + 1; n++) {
            const Ton = n * 120 - ph + delay;
            if (Ton < untilT || Ton >= T1) continue;
            const tones = SHIP_TONES[s.kind] || SHIP_TONES.container;
            const lvl = db(CITY_DB.ship + distDb(s.view.dist, CITY_DB.shipRef));
            const ta = at(now, T, Ton);
            horn(eng, { t: ta, dur: len, tones, kind: "horn", level: lvl, pan: panFor(L, s.view.bearing), dist: s.view.dist, attack: 0.35, out, sends: farSends });
            if (s.view.dist < 4500) holds.push([ta - 0.4, ta + len + 1.4]);
            log?.("ship", ta, { id: s.id, type: s.kind, dur: +len.toFixed(1), dist: Math.round(s.view.dist) });
          }
        }
      }
      // ---- the Sausalito ferry leaving its dock, and the tour boats leaving the wharf
      if (city.ferries?.trips) {
        const line = city.ferries.line;
        for (const day of [t.day - 1, t.day]) for (const trip of city.ferries.trips(day)) {
          if (trip.from !== "sau" || trip.empty) continue;
          const id = `f${trip.key}`;
          if (seen.has(id)) continue;
          const p = line.at(trip.from === "sau" ? 0 : line.L);
          const v = view(p.x, p.y, city.frame.z(p.x, p.y, 0));
          const Ton = trip.dep + v.dist / SPEED;
          if (Ton < untilT || Ton >= T1) continue;
          seen.add(id);
          const ta = at(now, T, Ton);
          horn(eng, { t: ta, dur: 3.5, tones: [220, 277.18], kind: "horn", level: db(CITY_DB.ferry + distDb(v.dist, CITY_DB.ferryRef)), pan: panFor(L, v.bearing), dist: v.dist, attack: 0.25, out, sends: farSends });
          log?.("ferry", ta, { dist: Math.round(v.dist) });
        }
      }
      if (city.tours?.departures) {
        for (const [fleet, , route, sec] of city.tours.departures(t.day)) {
          const id = `w${t.day}-${fleet}-${sec}`;
          if (seen.has(id)) continue;
          const Ton = sfToT(t.day, sec) + 15;              // (the piers are ~1.5 km off: ~5 s; casting off takes a little)
          if (Ton < untilT || Ton >= T1) continue;
          seen.add(id);
          if (u01(SEED.tour, Math.round(sec), t.day % 1000) > 0.7) continue;
          const ta = at(now, T, Ton);
          horn(eng, { t: ta, dur: 2.6, tones: fleet === "rw" ? [196] : [246.94], kind: "horn", level: db(CITY_DB.tour), pan: 0, dist: 1600, attack: 0.2, out: wall, sends: farSends });
          log?.("tour", ta, { fleet, route });
        }
      }

      // ---- gulls passing the window (the view's own), and far ones by day
      const dayW = smooth(-2, 4, alt);
      levels.day = dayW;
      for (const g of snap.gulls) {
        if (seen.has(g.id) || !g.view) continue;
        seen.add(g.id);
        if (!r.chance(g.welcome ? 0.8 : 0.55)) continue;
        const n = r.weighted([[1, 0.35], [2, 0.35], [3, 0.2], [5, 0.1]]);
        const ta = now + r.range(0.3, 2.5);
        gull(eng, { t: ta, n, f: r.range(880, 1060), level: db(CITY_DB.gull + distDb(g.view.dist, CITY_DB.gullRef)), pan: panFor(L, g.view.bearing), out, sends });
        log?.("gull", ta, { n, dist: Math.round(g.view.dist) });
      }
      const farGulls = dayW * (rising ? 0.9 : 0.5);
      if (nextFarGull === null) nextFarGull = now + r.poisson(farGulls);
      while (nextFarGull < now + LOOK) {
        gull(eng, { t: nextFarGull, n: r.weighted([[1, 0.4], [2, 0.4], [3, 0.2]]), f: r.range(850, 1050), level: db(CITY_DB.gullFar + r.range(-6, 0)), pan: r.range(-0.6, 0.6) * L.width, out, sends: farSends });
        log?.("gull", nextFarGull, { far: true });
        nextFarGull += r.poisson(farGulls);
      }

      // ---- birds: the dawn chorus, a little by day and at dusk
      const chorus = rising ? smooth(-12, -5, alt) * (1 - smooth(5, 18, alt)) : smooth(-6, 1, alt) * (1 - smooth(8, 20, alt)) * 0.18;
      const birdsW = Math.max(chorus, 0.1 * smooth(10, 20, alt)) * (1 - 0.3 * fog);
      levels.birds = birdsW;
      const sing = (key, perMin, fn, pan, lv) => {
        if (birds[key] === null) birds[key] = now + r.poisson(perMin * birdsW);
        while (birds[key] < now + LOOK) {
          if (birdsW > 0.02) { fn(eng, { t: birds[key], level: db(lv + r.range(-4, 0)), pan: pan(), out, sends }); log?.(key, birds[key], {}); }
          birds[key] += Math.min(600, r.poisson(perMin * Math.max(0.02, birdsW)));
        }
      };
      sing("sparrow", 3.2, sparrow, () => r.pick(people.sparrowPans) * L.width, CITY_DB.bird);
      sing("finch", 1.4, finch, () => people.finchPan * L.width, CITY_DB.bird + 1.5);
      sing("dove", 0.6, dove, () => people.dovePan * L.width, CITY_DB.bird - 7);

      // ---- the cable car passing below, and its bell
      for (const day of [t.day]) {
        for (const [list, lead, dir] of [[CABLE_CAR.outboundAtBeach, CABLE_CAR.outboundLead, "out"], [CABLE_CAR.inboundFromBeach, CABLE_CAR.inboundLag, "in"]]) {
          for (const mm of list) {
            const key = day * 2000 + mm * 2 + (dir === "out" ? 0 : 1);
            const tp = sfToT(day, (mm + lead) * 60) + u01(SEED.cable, key % 2147483647, 1) * CABLE_CAR.jitter;
            if (tp < T - 22 || tp > T1 + 22) continue;
            const id = `cc${key}`;
            if (!seen.has(id)) { seen.add(id); cablePass(at(now, T, tp), dir, now, L); }
            // the bell: at a hashed slot's rising edge near the pass, a short pattern; at most three a pass, 5 s apart
            let rung = rungs.get(id);
            if (!rung) rungs.set(id, (rung = { n: 0, last: -1e9 }));
            for (let s = Math.ceil((untilT - tp + 30) * 2); s < (T1 - tp + 30) * 2; s++) {
              const dt = s / 2 - 30;
              if (Math.abs(dt) > 14 || rung.n >= 3) continue;
              const on = u01(SEED.cable, key % 2147483647, s) < 0.35, before = u01(SEED.cable, key % 2147483647, s - 1) < 0.35;
              const Tev = tp + dt;
              if (on && !before && Tev - rung.last > 5) {
                rung.n++; rung.last = Tev;
                const k = Math.exp(-(dt ** 2) / (2 * 8 ** 2));
                const p0 = dir === "out" ? -0.65 : 0.65;
                bellPattern(at(now, T, Tev), db(CITY_DB.cableBell) * (0.35 + 0.65 * k), p0 * -Math.tanh(dt / 10) * L.width);
              }
            }
          }
        }
      }

      // ---- light planes passing close: a drone each, retuned every tick (Doppler, distance, bearing)
      const here = new Set();
      for (const p of snap.sound.planes) {
        here.add(p.id);
        let d = planes.get(p.id);
        if (!d) {
          d = makeDrone(eng, out, r);
          planes.set(p.id, d);
          log?.("plane", now, { dist: Math.round(p.dist) });
        }
        const vr = d.lastDist !== undefined ? (p.dist - d.lastDist) / Math.max(0.2, T - d.lastT) : 0;
        d.lastDist = p.dist; d.lastT = T;
        const f = 82 * SPEED / (SPEED + clamp(vr, -60, 60));
        d.set(now, f, db(CITY_DB.plane + distDb(p.dist, CITY_DB.planeRef)), panFor(L, p.bearing), clamp(4000 * (600 / p.dist), 300, 3000));
      }
      for (const [id, d] of planes) if (!here.has(id)) { d.end(now); planes.delete(id); }
      untilT = T1;
      if (seen.size > 4000) seen.clear();
      if (rungs.size > 200) rungs.clear();
    },
  };
}

// A light plane's engine: the propeller's blade-pass tone (~80 Hz for a two-blade prop at 2,400 rpm) and its
// harmonics (a sawtooth), the engine's firing an octave up, the exhaust's noise; set() retunes it (Doppler), moves
// it (pan) and fades it with distance (level, and a low-pass for the air).
function makeDrone(eng, out, r) {
  const { ctx } = eng;
  const a = ctx.createOscillator(); a.type = "sawtooth"; a.frequency.value = 82;
  const b = ctx.createOscillator(); b.type = "sawtooth"; b.frequency.value = 164; b.detune.value = 7;
  const n = loop(ctx, eng.noise.pink, r);
  const nb = filter(ctx, "bandpass", 300, 0.7);
  const ga = gain(ctx, 0.5), gb = gain(ctx, 0.18), gn = gain(ctx, 0.8);
  const lp = filter(ctx, "lowpass", 1200, 0.7);
  const g = gain(ctx, 0);
  const p = panner(ctx, 0);
  a.connect(ga).connect(lp); b.connect(gb).connect(lp); n.connect(nb).connect(gn).connect(lp);
  lp.connect(g).connect(p).connect(out);
  const t0 = ctx.currentTime;
  a.start(t0); b.start(t0); startAt(n, t0);
  const nodes = [a, b, n, nb, ga, gb, gn, lp, g, p];
  let gone = false;
  const kill = () => { if (gone) return; gone = true; for (const x of nodes) { try { x.stop?.(); } catch { /* */ } try { x.disconnect(); } catch { /* */ } } };
  eng.onStop(kill);
  return {
    set(now, f, lvl, pan, cut) {
      a.frequency.setTargetAtTime(f, now, 0.3); b.frequency.setTargetAtTime(f * 2, now, 0.3);
      g.gain.setTargetAtTime(lvl, now, 0.6); p.pan.setTargetAtTime(clamp(pan, -1, 1), now, 0.5); lp.frequency.setTargetAtTime(cut, now, 0.5);
    },
    end(now) { g.gain.setTargetAtTime(0, now, 0.8); setTimeoutish(eng, now + 4, kill); },
  };
}
// (a cleanup at a context time: live, a timer; offline, at the engine's next tick past it)
function setTimeoutish(eng, t, fn) { eng.later(t, fn); }
