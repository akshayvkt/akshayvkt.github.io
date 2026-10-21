// The sound of the room: one engine for the live page (an AudioContext, ticking every 200 ms) and for the offline
// renders that judge it (an OfflineAudioContext, ticked by the harness at the same steps: web/dev/sound.html).
//
//   const eng = await createEngine(ctx, { world, seed, log, lite });   // lite: phones and small machines (fewer partials)
//   eng.start();                    // the beds begin and the master fades in over 3 s
//   eng.tick();                     // schedule the next 1.6 s (live: every 200 ms by itself, start({ timer: true }))
//   eng.cue("lamp", { on: true });  // a touch in the room (lamp, book, book-home, elastic, cover-open, cover-close,
//                                   // page, tap, unlock)
//   await eng.fadeOut(1.2); eng.stop();
//
// world (world.js live; the harness offline): T() the city's time (UTC s); city() the city (shared/city/city.js) or
// null while it loads; listener() { bearing (deg, where the camera looks), open (0..1: how much the glass lets
// through), width (0..1: how wide the outside spreads), speed (m/s of the camera), turn (deg/s), reading, duck (0..1:
// the headphones' video plays) }; place(name) -> the pan of a room object from the camera.
//
// THE MIX (a film's quiet scene; levels are tuned against the offline renders' measurements, see
// docs/v3/briefs/sound-r1-report.md):
//   music   the felt piano, the pad, the glass                 -> the music bus, and the hall (a generated 3.2 s IR)
//   outside the city (city.js)                                 -> the glass (a low-pass 1-7 kHz and -6..0 dB by
//                                                                 listener.open), far sends -> the hall, darker
//   wall    what comes through the building (the wharf)        -> a 280 Hz low-pass, -8 dB
//   room    the room tone, the touches, the air of a glide     -> the room bus, and the room (a generated 0.45 s IR)
//   master  the fade, a limiter (DynamicsCompressor, its automatic make-up gain taken back out), a soft clip that
//           can never pass -1 dBFS
import { createComposer, bandWeights, BANDS } from "./music.js";
import { createCityScene } from "./city.js";
import { noise, click } from "./instruments.js";
import { rng, noiseBuffer, impulse, softClipCurve, db, clamp, lerp, gain, filter, panner, loop, startAt } from "./dsp.js";

export const MIX = {
  master: 5.5,         // dB, the overall level (Sound's default: about -28 LUFS at golden, -26 in fog, -33 at night)
  music: -9, piano: -0.5, pad: -22, glass: -31,
  outside: -1, wall: -8,
  room: 0, roomTone: -39, air: -36, touch: -14,
  hall: 0, roomVerb: -10,
  glassClosed: -6, glassClosedHz: 2200, glassOpenHz: 9000,
};
const TICK = 0.2, LOOK = 1.6;
// The limiter: a DynamicsCompressor that only touches what would be loud (from about -12 dBFS; the mix stays below it).
// The spec's compressor adds its own make-up gain, (1 / gain at 0 dBFS) ^ 0.6, which would lift every quiet sound;
// the engine measures it when it starts (limiterMakeup: a -40 dBFS tone through the same settings, offline, 0.25 s)
// and takes it back out, so quiet sounds pass at unity (scripts/sound/render.mjs prints the chain's gain from -40 to
// -3 dBFS; the report has the table). LIMIT_MAKEUP_DB is the fallback (Chrome 2026, these settings).
export const LIMIT = { threshold: -9, knee: 6, ratio: 12, attack: 0.003, release: 0.25 };
export const LIMIT_MAKEUP_DB = 4.1;
export async function limiterMakeup(sampleRate = 48000) {
  try {
    const n = Math.round(sampleRate * 0.25), oc = new OfflineAudioContext(1, n, sampleRate);
    const o = oc.createOscillator(); o.frequency.value = 997;
    const g = oc.createGain(); g.gain.value = 0.01 * Math.SQRT2;    // -40 dBFS RMS
    const c = oc.createDynamicsCompressor();
    for (const [k, v] of Object.entries(LIMIT)) c[k].value = v;
    o.connect(g).connect(c).connect(oc.destination); o.start();
    const d = (await oc.startRendering()).getChannelData(0);
    let e = 0;
    for (let i = n - Math.round(sampleRate * 0.1); i < n; i++) e += d[i] * d[i];
    const gainDb = 10 * Math.log10(e / Math.round(sampleRate * 0.1)) + 40;
    return Number.isFinite(gainDb) && gainDb > -1 && gainDb < 15 ? gainDb : LIMIT_MAKEUP_DB;
  } catch { return LIMIT_MAKEUP_DB; }
}

export async function createEngine(ctx, { world, seed, log = null, lite = false } = {}) {
  const eng = {
    ctx, rnd: rng(seed), voices: new Set(), log, stops: [], laters: [], lite,
    onStop(fn) { this.stops.push(fn); },
    later(t, fn) { this.laters.push([t, fn]); },
  };
  const r = eng.rnd;
  // ---------------------------------------------------------------- buffers (a few ms of maths each, once; each its own
  // task, so turning Sound on never makes a long frame in the 3D)
  const yieldNow = () => new Promise((res) => setTimeout(res, 0));
  eng.noise = {};
  for (const [k, o] of [["white", { seconds: 3, color: "white" }], ["pink", { seconds: 4, color: "pink" }], ["brown", { seconds: 4, color: "brown" }],
    ["pink2", { seconds: 5, color: "pink", channels: 2 }], ["brown2", { seconds: 5, color: "brown", channels: 2 }]]) {
    eng.noise[k] = noiseBuffer(ctx, { ...o, seed: r.int(1, 1e9) });
    await yieldNow();
  }
  // the hall: 3.2 s, warm (the highs above 2.5 kHz gone by 2 s), wide, a 30 ms pre-delay
  const hallIR = impulse(ctx, { seconds: 3.8, rt60: 3.2, rt60High: 2.0, split: 2500, predelay: 0.03, onset: 0.06, seed: r.int(1, 1e9) });
  await yieldNow();
  // the room: a furnished study, 0.45 s, a few early reflections off the desk, the window and the shelf
  const roomIR = impulse(ctx, { seconds: 0.9, rt60: 0.45, rt60High: 0.25, split: 3000, predelay: 0.004, onset: 0.008, width: 0.8,
    early: [[0.0031, 0.5, -0.2], [0.0063, 0.42, 0.5], [0.0094, 0.35, -0.6], [0.0142, 0.3, 0.3], [0.0198, 0.22, -0.1]], seed: r.int(1, 1e9) });

  // ---------------------------------------------------------------- the chain
  const master = gain(ctx, 0);
  const limiter = ctx.createDynamicsCompressor();
  for (const [k, v] of Object.entries(LIMIT)) limiter[k].value = v;
  const makeupDb = await limiterMakeup(ctx.sampleRate);
  const makeup = gain(ctx, db(-makeupDb));
  const clip = ctx.createWaveShaper();
  clip.curve = softClipCurve(); clip.oversample = "2x";
  master.connect(limiter).connect(makeup).connect(clip).connect(ctx.destination);
  const duck = gain(ctx, 1);
  duck.connect(master);
  // one switch per layer (the offline renders' stems: music, city, room); unity in the live page
  const mutes = { music: [gain(ctx, 1), gain(ctx, 1)], city: [gain(ctx, 1), gain(ctx, 1), gain(ctx, 1)], room: [gain(ctx, 1), gain(ctx, 1)] };

  const hall = ctx.createConvolver(); hall.normalize = false; hall.buffer = hallIR;
  const hallOut = gain(ctx, db(MIX.hall));
  hall.connect(hallOut).connect(duck);
  const hallIn = filter(ctx, "highpass", 200, 0.6);             // (no lows into the hall: they only muddy it)
  hallIn.connect(hall);
  const roomVerb = ctx.createConvolver(); roomVerb.normalize = false; roomVerb.buffer = roomIR;
  const roomVerbOut = gain(ctx, db(MIX.roomVerb));
  roomVerb.connect(roomVerbOut).connect(mutes.room[1]).connect(duck);

  const musicBus = gain(ctx, db(MIX.music));
  musicBus.connect(mutes.music[0]).connect(duck);
  const musicHall = gain(ctx, db(MIX.music)); // the music's sends land here, at the bus's level (the bus moves both)
  musicHall.connect(mutes.music[1]).connect(hallIn);

  const outsideIn = gain(ctx, 1);
  const glassLP = filter(ctx, "lowpass", MIX.glassClosedHz, 0.5);
  const glassG = gain(ctx, db(MIX.glassClosed));
  const outsideBus = gain(ctx, db(MIX.outside));
  outsideIn.connect(glassLP).connect(glassG).connect(outsideBus).connect(mutes.city[0]).connect(duck);
  const farIn = gain(ctx, 1);                 // the outside's reverb: darker, and quieter while the glass is closed
  const farLP = filter(ctx, "lowpass", 1400, 0.5);
  const farG = gain(ctx, db(MIX.glassClosed));
  farIn.connect(farLP).connect(farG).connect(mutes.city[1]).connect(hallIn);
  const wallIn = gain(ctx, 1);
  const wallLP = filter(ctx, "lowpass", 280, 0.6);
  wallIn.connect(wallLP).connect(gain(ctx, db(MIX.wall))).connect(mutes.city[2]).connect(duck);

  const roomBus = gain(ctx, db(MIX.room));
  roomBus.connect(mutes.room[0]).connect(duck);
  const roomSend = gain(ctx, 1);
  roomSend.connect(roomVerb);

  // the room tone: a warm, barely-there murmur of a building at rest (brown noise under 180 Hz, a breath of pink at
  // 400 Hz), no reverb
  const tone = loop(ctx, eng.noise.brown2, r);
  const toneLP = filter(ctx, "lowpass", 180, 0.6);
  const toneG = gain(ctx, db(MIX.roomTone));
  tone.connect(toneLP).connect(toneG).connect(roomBus);
  const tone2 = loop(ctx, eng.noise.pink, r);
  const tone2BP = filter(ctx, "bandpass", 400, 0.5);
  const tone2G = gain(ctx, db(MIX.roomTone - 12));
  tone2.connect(tone2BP).connect(tone2G).connect(roomBus);
  // the air of a glide: pink noise in a band that rises with the camera's speed, panned by its turn
  const air = loop(ctx, eng.noise.pink2, r);
  const airBP = filter(ctx, "bandpass", 400, 0.8);
  const airG = gain(ctx, 0);
  const airP = panner(ctx, 0);
  air.connect(airBP).connect(airG).connect(airP).connect(roomBus);

  const composer = createComposer(eng, musicBus);
  const scene = createCityScene(eng, { out: outsideIn, wall: wallIn, sends: [[farIn, 0.35]], farSends: [[farIn, 0.8]] });

  // ---------------------------------------------------------------- state
  let started = false, stopped = false, timer = null, timed = false;
  let lastT = null, lastNow = null, quietUntil = 0, until = 0, toneDrift = 0;
  const stats = { ticks: 0, tickMs: 0, tickMaxMs: 0, jumps: 0, cues: {}, target: db(MIX.master) };
  const touchLast = new Map();

  function mood(L) {
    const lv = scene.levels;
    const w = bandWeights(lv.sun, lv.rising);
    const fog = clamp((lv.fog - 0.2) / 0.8, 0, 1);
    const hallWet = Object.entries(w).reduce((a, [k, x]) => a + x * BANDS[k].hall, 0) + 0.18 * fog;
    return {
      w, fog, reading: !!L.reading, width: lerp(1, 1.6, fog),
      sends: [[musicHall, hallWet]], pianoDb: MIX.piano, padDb: MIX.pad, glassDb: MIX.glass,
      busDb: Object.entries(w).reduce((a, [k, x]) => a + x * BANDS[k].busDb, 0) + (L.reading ? -1 : 0),
      hold: (t, len) => scene.hold(t, len),
    };
  }

  function tick() {
    if (!started || stopped) return;
    const t0 = performance.now();
    const now = ctx.currentTime;
    for (let i = eng.laters.length - 1; i >= 0; i--) if (eng.laters[i][0] <= now) { const [, fn] = eng.laters[i]; eng.laters.splice(i, 1); try { fn(); } catch { /* */ } }
    const city = world.city();
    const L = world.listener();
    // the glass: closed at the desk, opening toward the window and as the view is zoomed
    const open = clamp(L.open, 0, 1);
    glassLP.frequency.setTargetAtTime(lerp(MIX.glassClosedHz, MIX.glassOpenHz, open ** 1.5), now, 0.35);
    glassG.gain.setTargetAtTime(db(lerp(MIX.glassClosed, 0, open)), now, 0.35);
    farG.gain.setTargetAtTime(db(lerp(MIX.glassClosed, 0, open)), now, 0.35);
    // the room tone's loops drift a little in speed, so they never repeat audibly
    if (now >= toneDrift) {
      tone.playbackRate.setTargetAtTime(r.range(0.93, 1.07), now, 2.5);
      tone2.playbackRate.setTargetAtTime(r.range(0.93, 1.07), now, 2.5);
      air.playbackRate.setTargetAtTime(r.range(0.9, 1.1), now, 2);
      toneDrift = now + r.range(5, 10);
    }
    // the air of a glide
    const sp = clamp((L.speed || 0) / 1.4, 0, 1.4);
    airG.gain.setTargetAtTime(db(MIX.air) * sp, now, 0.12);
    airBP.frequency.setTargetAtTime(lerp(320, 950, Math.min(1, sp)), now, 0.15);
    airP.pan.setTargetAtTime(clamp((L.turn || 0) / 60, -0.5, 0.5), now, 0.15);
    // the headphones' video: everything steps back
    duck.gain.setTargetAtTime(db(lerp(0, -26, clamp(L.duck || 0, 0, 1))), now, 0.4);
    if (city) {
      const T = world.T();
      // a jump in the city's time (the dial): plan again, keep quiet while it moves
      if (lastT !== null && Math.abs((T - lastT) - (now - lastNow)) > 2) {
        scene.jump(now, T);
        composer.reset(now + 0.5);
        quietUntil = now + 1.5;
        stats.jumps++;
        log?.("jump", now, { by: Math.round(T - lastT - (now - lastNow)) });
      }
      lastT = T; lastNow = now;
      scene.update(now, T, L, city, now < quietUntil);
      const m = mood(L);
      musicBus.gain.setTargetAtTime(db(MIX.music + m.busDb), now, 2);
      musicHall.gain.setTargetAtTime(db(MIX.music + m.busDb), now, 2);
      composer.schedule(now, now + LOOK, m);
    }
    until = now + LOOK;
    const ms = performance.now() - t0;
    stats.ticks++; stats.tickMs += ms; stats.tickMaxMs = Math.max(stats.tickMaxMs, ms);
  }

  // a touch in the room: what it sounds like, where (the object's pan from the camera), never twice within `gap` s
  const CUES = {
    lamp: (t, p, o) => {
      click(eng, { t, f: o.on ? 2300 : 1900, body: 0.009, bright: 0.5, low: 0.3, level: db(MIX.touch - 1), pan: p, out: roomBus, sends: [[roomSend, 0.5]] });
      click(eng, { t: t + 0.052, f: o.on ? 1600 : 1400, body: 0.006, bright: 0.25, low: 0.12, level: db(MIX.touch - 7), pan: p, out: roomBus, sends: [[roomSend, 0.5]] });
    },
    book: (t, p, o) => {   // the spine's paper and cloth sliding on the shelf's wood: out 1.5 cm on a hover, 5 cm on a click
      const big = (o.out || 0) > 0.03, d = big ? 0.42 : 0.2, lv = db(MIX.touch - (big ? -2 : 1));
      noise(eng, { t, color: "pink", chain: [["highpass", 500, 0.7], ["bandpass", 1900, 0.8]], env: [[0, 0], [0.025, lv], [d * 0.5, lv * 0.55], [d, 0]], pan: p, out: roomBus, sends: [[roomSend, 0.35]], kind: "touch" });
      noise(eng, { t, color: "white", chain: [["bandpass", 3800, 1.6]], env: [[0, 0], [0.01, lv * 0.5], [0.05, lv * 0.2], [d * 0.7, 0]], pan: p, out: roomBus, kind: "touch" });
    },
    "book-home": (t, p) => {
      const lv = db(MIX.touch - 16);
      noise(eng, { t, color: "pink", chain: [["highpass", 450, 0.7], ["bandpass", 1600, 0.8]], env: [[0, 0], [0.03, lv * 0.8], [0.22, lv * 0.4], [0.3, 0]], pan: p, out: roomBus, sends: [[roomSend, 0.35]], kind: "touch" });
      click(eng, { t: t + 0.29, f: 260, body: 0.018, bright: 0.04, low: 0.35, level: db(MIX.touch - 8), pan: p, out: roomBus, sends: [[roomSend, 0.6]] });
    },
    elastic: (t, p) => {   // the notebook's elastic slipping off the cover: a soft rubbery snap
      noise(eng, { t, color: "white", chain: [["bandpass", 2100, 1.4]], env: [[0, 0], [0.004, db(MIX.touch - 12)], [0.03, 0]], pan: p, out: roomBus, kind: "touch" });
      click(eng, { t: t + 0.012, f: 170, body: 0.016, bright: 0, low: 0.25, level: db(MIX.touch - 7), pan: p, out: roomBus, sends: [[roomSend, 0.4]] });
    },
    "cover-open": (t, p, o) => {   // the cover's air as it swings, and its soft landing on the desk
      const d = o.dur || 0.8;
      noise(eng, { t, color: "pink", chain: [["bandpass", 600, 0.7, 0, [[0, 500], [d * 0.5, 1300], [d, 700]]]], env: [[0, 0], [d * 0.5, db(MIX.touch - 10)], [d, 0]], pan: p, out: roomBus, kind: "touch" });
      noise(eng, { t: t + d - 0.02, color: "pink", chain: [["lowpass", 700, 0.7]], env: [[0, 0], [0.008, db(MIX.touch - 2)], [0.08, 0]], pan: p, out: roomBus, sends: [[roomSend, 0.5]], kind: "touch" });
      click(eng, { t: t + d - 0.015, f: 140, body: 0.02, bright: 0, low: 0.25, level: db(MIX.touch - 6), pan: p, out: roomBus });
    },
    "cover-close": (t, p, o) => {
      const d = o.dur || 0.8;
      noise(eng, { t, color: "pink", chain: [["bandpass", 700, 0.7, 0, [[0, 600], [d * 0.6, 1500], [d, 900]]]], env: [[0, 0], [d * 0.6, db(MIX.touch - 21)], [d, 0]], pan: p, out: roomBus, kind: "touch" });
      noise(eng, { t: t + d - 0.02, color: "pink", chain: [["lowpass", 1500, 0.7]], env: [[0, 0], [0.006, db(MIX.touch - 10)], [0.07, 0]], pan: p, out: roomBus, sends: [[roomSend, 0.5]], kind: "touch" });
      click(eng, { t: t + d - 0.01, f: 160, body: 0.018, bright: 0.03, low: 0.3, level: db(MIX.touch - 11), pan: p, out: roomBus });
    },
    page: (t, p, o) => {   // a page turning: the lift, the leaf's sweep through the air, its crinkle, its settling
      const back = (o.dir || 1) < 0, d = clamp(o.dur || 0.65, 0.35, 1.2), lv = db(MIX.touch + 3.5);
      click(eng, { t, f: 3100, body: 0.003, bright: 0.22, level: db(MIX.touch - 5.5), pan: p, out: roomBus });
      noise(eng, { t, color: "pink", chain: [["highpass", 700, 0.7], ["bandpass", 2600, 0.9, 0, [[0, 2600], [d * 0.45, back ? 3200 : 3800], [d, 1800]]]],
        env: [[0, 0], [d * 0.12, lv * 0.55], [d * 0.45, lv], [d * 0.85, lv * 0.45], [d, 0]], panPath: [[0, p + (back ? -0.12 : 0.12)], [d, p + (back ? 0.12 : -0.12)]], out: roomBus, sends: [[roomSend, 0.4]], kind: "touch" });
      const crinkle = [[0, 0]];
      for (let x = 0.08; x < d * 0.8; x += r.range(0.03, 0.09)) crinkle.push([x, 0], [x + 0.004, db(MIX.touch - 7.5) * r.range(0.4, 1)], [x + 0.012, 0]);
      crinkle.push([d, 0]);
      noise(eng, { t, color: "white", chain: [["bandpass", 5200, 1.2]], env: crinkle, pan: p, out: roomBus, kind: "touch" });
      noise(eng, { t: t + d - 0.03, color: "pink", chain: [["lowpass", 900, 0.7]], env: [[0, 0], [0.01, db(MIX.touch - 4.5)], [0.09, 0]], pan: p, out: roomBus, sends: [[roomSend, 0.4]], kind: "touch" });
    },
    tap: (t, p) => click(eng, { t, f: 190, body: 0.006, bright: 0.1, low: 0.2, level: db(MIX.touch - 8), pan: p, out: roomBus }),
    unlock: (t, p) => {   // a haptic tick, and the faint air of the lock screen sliding up
      click(eng, { t, f: 230, body: 0.008, bright: 0.03, low: 0.35, level: db(MIX.touch - 10), pan: p, out: roomBus });
      noise(eng, { t: t + 0.02, color: "pink", chain: [["bandpass", 1400, 0.8, 0, [[0, 1100], [0.3, 2600]]]], env: [[0, 0], [0.12, db(MIX.touch - 30)], [0.32, 0]], pan: p, out: roomBus, kind: "touch" });
    },
  };
  const GAP = { book: 0.08, "book-home": 0.15, tap: 0.06, page: 0.25 };
  const OBJ = { lamp: "lamp", book: "shelf", "book-home": "shelf", elastic: "notebook", "cover-open": "notebook", "cover-close": "notebook", page: "notebook", tap: "laptop", unlock: "phone" };

  return {
    ctx, composer, scene, stats,
    get voices() { return eng.voices.size; },
    get started() { return started; },
    start({ timer: useTimer = false, fade = 3 } = {}) {
      if (started) return;
      started = true;
      const t = ctx.currentTime;
      for (const s of [tone, tone2, air]) startAt(s, t);
      master.gain.setValueAtTime(0.0001, t);
      master.gain.exponentialRampToValueAtTime(db(MIX.master), t + fade);
      log?.("start", t, {});
      tick();
      if (useTimer) timer = setInterval(tick, TICK * 1000);
      timed = useTimer;
    },
    tick,
    // the hidden tab: no ticks while the context is suspended (sound.js), and a fresh plan when it comes back
    pause() { clearInterval(timer); timer = null; },
    resume() { if (started && !stopped && timed && !timer) { timer = setInterval(tick, TICK * 1000); tick(); } },
    get touchOut() { return roomBus; },
    cue(name, o = {}, when = null) {
      if (!started || stopped || !CUES[name]) return false;
      const now = ctx.currentTime;
      const last = touchLast.get(name) ?? -1e9;
      if (now - last < (GAP[name] ?? 0.1)) return false;
      touchLast.set(name, now);
      const t = when ?? now + 0.005;
      const p = clamp(o.pan ?? world.place?.(OBJ[name]) ?? 0, -0.9, 0.9);
      CUES[name](t, p, o);
      stats.cues[name] = (stats.cues[name] || 0) + 1;
      log?.("cue", t, { name, pan: +p.toFixed(2) });
      return true;
    },
    // the master's level (the visibility fade; 0..1 of the default level)
    fadeTo(k, seconds) {
      const now = ctx.currentTime, g = master.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(Math.max(0.0001, g.value), now);
      g.exponentialRampToValueAtTime(Math.max(0.0001, db(MIX.master) * k), now + Math.max(0.05, seconds));
    },
    fadeOut(seconds = 1.2) {
      this.fadeTo(0, seconds);
      return new Promise((res) => setTimeout(res, seconds * 1000 + 60));
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const v of [...eng.voices]) v.stop(0.02);
      for (const fn of eng.stops) { try { fn(); } catch { /* */ } }
      for (const s of [tone, tone2, air]) { try { s.stop(); } catch { /* */ } }
      try { master.disconnect(); } catch { /* */ }
    },
    // the offline harness: keep one layer only (a stem), or every layer (null)
    solo(name) { for (const [k, gs] of Object.entries(mutes)) for (const g of gs) g.gain.value = !name || k === name ? 1 : 0; },
    // the measurement chain for the offline harness: the limiter's own small-signal gain check
    makeupDb,
    _nodes: { master, limiter, makeup, clip, musicBus, outsideBus, roomBus, hallOut, roomVerbOut, glassLP, glassG, duck, wallIn },
    // the harness's probes (web/dev/sound-render.js): the instruments' own context and the buses' inputs
    _internal: { eng, outsideIn, wallIn, farIn, roomBus, roomSend, musicBus, musicHall, mood: () => mood(world.listener()) },
  };
}
