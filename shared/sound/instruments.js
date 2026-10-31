// Every sound of the room and the city, each a small function: (eng, opts) -> Voice. Synthesized with the Web Audio
// API's own nodes (oscillators, filters, gains, noise buffers from dsp.js); nothing is recorded or downloaded.
//
// eng: { ctx, rnd, noise: { white, pink, brown }, voices } (engine.js). opts.t is the start in the context's time;
// opts.out the node to play into; opts.sends [[node, gain], ...] extra wet sends (reverbs); opts.level a gain (use
// db()); opts.pan -1..1. Levels are relative to dsp.js NOISE_RMS (-20 dBFS) for noise and to a full-scale sine for
// tones, and the callers (music.js, city.js, engine.js) set them in decibels.
import { Voice, db, clamp, lerp, mtof, gain, filter, panner, osc, burst, perc, swell } from "./dsp.js";

const connectOut = (v, node, out, sends) => {
  node.connect(out);
  for (const [s, g] of sends || []) { const w = gain(v.eng.ctx, g); v.add(w); node.connect(w).connect(s); }
};

// ================================================================ the felt piano
// A felt-muted upright, close-miked, as in Nils Frahm's or Olafur Arnalds' quiet pieces: additive synthesis of the
// string's partials with real piano inharmonicity (f_n = n f0 sqrt(1 + B n^2), B growing up the keyboard), the
// hammer's strike position (1/8.3 of the string: a_n ~ |sin(pi n x)| / n), the felt's softness (each partial
// exp(-k (n-1)) weaker, k smaller when played harder), the two-stage decay of a real piano (a prompt drop in the first
// quarter second, then the long aftersound; each partial decays faster than the one below), the two or three strings
// of a note detuned by under a cent (the slow beating that makes a piano breathe), and the mechanism: the felt
// hammer's soft thump, the key bottoming, the damper's touch on release. Velocity 0..1; dur: until the key is let go.
export function piano(eng, { t, midi, vel = 0.4, dur = 2.5, pan = 0, level = 1, out, sends }) {
  const { ctx, rnd } = eng;
  const f0 = mtof(midi);
  const hi = clamp((midi - 36) / 60, 0, 1);
  const B = 0.00025 * Math.pow(2, (midi - 60) / 24);
  const N = clamp(Math.floor(4000 / f0), 1, eng.lite ? 5 : 8);   // (phones: fewer partials, no second string)
  const xh = 1 / 8.3;
  const k = 0.42 - 0.28 * vel;                          // felt: soft playing is darker
  const tau1 = lerp(3.4, 1.1, hi);                      // aftersound of the fundamental (e-folding s)
  const att = lerp(0.009, 0.004, vel);
  const g = Math.pow(vel, 1.7) * level;
  const rel = lerp(0.14, 0.05, hi);                     // the damper (low strings take longer to stop)
  const end = t + dur + rel * 7 + 0.05;
  const v = new Voice(eng, "piano", t, end);
  const note = v.add(gain(ctx, 0));
  const pn = v.add(panner(ctx, pan));
  note.connect(pn);
  connectOut(v, pn, out, sends);
  v.out = note;
  // the note's own envelope: attack, the prompt drop to 62 %, the release
  note.gain.setValueAtTime(0, t);
  note.gain.linearRampToValueAtTime(g, t + att);
  note.gain.setTargetAtTime(g * 0.62, t + att, 0.16);
  note.gain.setTargetAtTime(0, t + dur, rel);
  note.gain.setValueAtTime(0, end);
  // the partials
  const amps = [];
  for (let n = 1; n <= N; n++) amps.push(Math.abs(Math.sin(Math.PI * n * xh)) / Math.pow(n, 0.75) * Math.exp(-k * (n - 1)) * (n === 1 ? lerp(0.7, 1, hi) : 1));
  const sum = amps.reduce((a, b) => a + b, 0);
  for (let n = 1; n <= N; n++) {
    const fn = n * f0 * Math.sqrt(1 + B * n * n);
    if (fn > 9000) break;
    const a = amps[n - 1] / sum;
    const tau = tau1 / (1 + 0.45 * (n - 1));
    const pg = v.add(gain(ctx, 0));
    pg.gain.setValueAtTime(a, t);
    pg.gain.setTargetAtTime(0, t + 0.002, tau);
    pg.connect(note);
    const o = v.add(osc(ctx, "sine", fn));
    o.connect(pg);
    v.src(o, t, end);
    if (n <= 2 && !eng.lite) {                           // the second string of the unison, a fraction of a cent off
      const o2 = v.add(osc(ctx, "sine", fn, rnd.range(0.35, 0.9) * (rnd() < 0.5 ? -1 : 1)));
      const g2 = v.add(gain(ctx, 0.75));
      o2.connect(g2).connect(pg);
      v.src(o2, t, end);
    }
  }
  // the hammer's felt and the key: a soft band of noise and a low knock, both short
  const hn = v.add(burst(ctx, eng.noise.white, rnd));
  const hb = v.add(filter(ctx, "bandpass", clamp(f0 * 3, 500, 2600), 0.9));
  const hg = v.add(gain(ctx, 0));
  hn.connect(hb).connect(hg).connect(pn);
  perc(hg.gain, t, 0.9 * g, 0.001, 0.006);
  v.src(hn, t, t + 0.08);
  const kn = v.add(osc(ctx, "sine", 105));
  const kg = v.add(gain(ctx, 0));
  kn.connect(kg).connect(pn);
  perc(kg.gain, t + 0.004, 0.09 * g, 0.002, 0.012);
  v.src(kn, t, t + 0.12);
  // the damper touching the strings when the key comes up
  const dn = v.add(burst(ctx, eng.noise.white, rnd));
  const dl = v.add(filter(ctx, "lowpass", 1100, 0.7));
  const dg = v.add(gain(ctx, 0));
  dn.connect(dl).connect(dg).connect(pn);
  perc(dg.gain, t + dur, 0.35 * g, 0.004, 0.018);
  v.src(dn, t + dur, t + dur + 0.15);
  return v;
}

// ================================================================ the pad
// One note of a warm, slow pad: a sawtooth and a triangle a few cents apart through a soft low-pass (the saw's
// harmonics above `cutoff` rolled away: a bowed, breathing tone rather than a synth), a vibrato of a few cents shared
// by the chord (lfo, an oscillator's output in cents), a swell of several seconds in and out.
export function padNote(eng, { t, midi, attack = 6, hold = 20, release = 8, level = 1, cutoff = 900, pan = 0, lfo, out, sends }) {
  const { ctx, rnd } = eng;
  const f = mtof(midi);
  const end = t + attack + hold + release * 1.6;
  const v = new Voice(eng, "pad", t, end);
  const lp = v.add(filter(ctx, "lowpass", Math.min(cutoff, f * 6), 0.55));
  const g = v.add(gain(ctx, 0));
  const pn = v.add(panner(ctx, pan));
  lp.connect(g).connect(pn);
  connectOut(v, pn, out, sends);
  v.out = g;
  const a = v.add(osc(ctx, "sawtooth", f, -6 + rnd.range(-1.5, 1.5)));
  const b = v.add(osc(ctx, "triangle", f, 5 + rnd.range(-1.5, 1.5)));
  const ga = v.add(gain(ctx, 0.42)), gb = v.add(gain(ctx, 0.9));
  a.connect(ga).connect(lp); b.connect(gb).connect(lp);
  if (lfo) { lfo.connect(a.detune); lfo.connect(b.detune); }
  // the filter opens a little as the note swells (and closes as it goes)
  lp.frequency.setValueAtTime(Math.min(cutoff, f * 6) * 0.6, t);
  lp.frequency.setTargetAtTime(Math.min(cutoff, f * 6), t, attack / 2);
  lp.frequency.setTargetAtTime(Math.min(cutoff, f * 6) * 0.6, t + attack + hold, release / 3);
  swell(g.gain, t, level, attack, hold, release);
  v.src(a, t, end); v.src(b, t, end);
  return v;
}

// ================================================================ glass
// A bowed glass (or a soft glass harmonica): three sine modes of a thin glass bowl (1 : 2.32 : 4.25), a slow swell
// in, a tremolo of a few percent, and a long fade. Used high and rarely: light at dawn and in the clear middle of the day.
export function glass(eng, { t, midi, dur = 4, level = 1, pan = 0, out, sends }) {
  const { ctx } = eng;
  const f = mtof(midi);
  const end = t + 1.4 + dur + 3.2 * 1.6;
  const v = new Voice(eng, "glass", t, end);
  const g = v.add(gain(ctx, 0));
  const am = v.add(gain(ctx, 0.92));
  const trem = v.add(osc(ctx, "sine", 4.6));
  const tg = v.add(gain(ctx, 0.08));
  trem.connect(tg).connect(am.gain);
  const pn = v.add(panner(ctx, pan));
  g.connect(am).connect(pn);
  connectOut(v, pn, out, sends);
  v.out = g;
  [[1, 1], [2.32, 0.2], [4.25, 0.06]].forEach(([r, a]) => {
    if (f * r > 12000) return;
    const o = v.add(osc(ctx, "sine", f * r));
    const og = v.add(gain(ctx, a));
    o.connect(og).connect(g);
    v.src(o, t, end);
  });
  swell(g.gain, t, level, 1.4, dur, 3.2);
  v.src(trem, t, end);
  return v;
}

// ================================================================ bells
// A small cast-bronze bell struck by its clapper (the cable car's roof bell): modal synthesis of a bell's partials
// (hum 0.5, prime 1, tierce 1.19 (the minor third that makes a bell a bell), quint 1.5, nominal 2, and the upper
// partials), each an exponentially decaying sine, the lower ones doubled 1 Hz apart (a cast bell is never perfectly
// round: its modes come in slowly beating pairs), plus the clapper's bright tick. f0 is the prime.
const BELL = [[0.5, 0.22, 1.5], [1, 0.8, 1.15], [1.19, 0.42, 0.85], [1.5, 0.36, 0.7], [2, 0.62, 0.55], [2.52, 0.3, 0.36],
  [3.01, 0.22, 0.27], [4.13, 0.13, 0.18], [5.4, 0.08, 0.12]];
export function bell(eng, { t, f0 = 659, level = 1, damp = 1, pan = 0, out, sends }) {
  const { ctx, rnd } = eng;
  const end = t + 1.5 * damp * 7 + 0.05;
  const v = new Voice(eng, "bell", t, end);
  const g = v.add(gain(ctx, level));
  const pn = v.add(panner(ctx, pan));
  g.connect(pn);
  connectOut(v, pn, out, sends);
  v.out = g;
  const sum = BELL.reduce((a, p) => a + p[1], 0);
  BELL.forEach(([r, a, tau], i) => {
    const f = f0 * r * (1 + rnd.range(-0.002, 0.002));
    if (f > 11000) return;
    for (const [df, w] of i < 4 && !eng.lite ? [[0, 0.7], [rnd.range(0.6, 1.4), 0.3]] : [[0, 1]]) {
      const o = v.add(osc(ctx, "sine", f + df));
      const og = v.add(gain(ctx, 0));
      o.connect(og).connect(g);
      perc(og.gain, t, (a / sum) * w * 1.6, 0.0015, tau * damp);
      v.src(o, t, end);
    }
  });
  const n = v.add(burst(ctx, eng.noise.white, rnd));
  const hp = v.add(filter(ctx, "highpass", 3200, 0.7));
  const ng = v.add(gain(ctx, 0));
  n.connect(hp).connect(ng).connect(g);
  perc(ng.gain, t, 0.35, 0.0005, 0.0025);
  v.src(n, t, t + 0.05);
  return v;
}

// ================================================================ horns
// A foghorn or a ship's whistle, heard from far away: each tone a sawtooth and a square together (the buzz of a reed
// or a diaphone's piston), through the horn's bell (a low-pass near 6 f0 and a resonance near 2.4 f0), then the air
// between here and there (a low-pass that falls with distance: kilometres of fog take the highs), with the pressure
// building at the start (the pitch rises a few percent into place), a slow waver, and the release. kind "diaphone":
// the Golden Gate's old "bee-oh": at the end of each blast the pitch falls by a third in a growl as the air runs out.
export function horn(eng, { t, dur = 2, tones = [146.8], kind = "horn", level = 1, pan = 0, dist = 3000, attack = 0.18, out, sends }) {
  const { ctx, rnd } = eng;
  const grunt = kind === "diaphone" ? 0.38 : 0;
  const end = t + dur + grunt + 1.2;
  const v = new Voice(eng, "horn", t, end);
  const fair = clamp(900 * Math.pow(3500 / Math.max(300, dist), 0.8), 240, 4000);
  const air = v.add(filter(ctx, "lowpass", fair, 0.6));
  const g = v.add(gain(ctx, 0));
  const pn = v.add(panner(ctx, pan));
  air.connect(g).connect(pn);
  connectOut(v, pn, out, sends);
  v.out = g;
  const waver = v.add(osc(ctx, "sine", rnd.range(2.6, 3.6)));
  const wg = v.add(gain(ctx, 4));                         // +-4 cents
  waver.connect(wg);
  v.src(waver, t, end);
  let rough = null;
  if (grunt) {                                             // the growl: amplitude roughness at ~27 Hz, rising at the end
    rough = v.add(gain(ctx, 1));
    const ro = v.add(osc(ctx, "sine", 27));
    const rg = v.add(gain(ctx, 0));
    ro.connect(rg).connect(rough.gain);
    rg.gain.setValueAtTime(0, t + dur - 0.05);
    rg.gain.linearRampToValueAtTime(0.45, t + dur + grunt * 0.7);
    v.src(ro, t, end);
    rough.connect(air);
  }
  for (const f of tones) {
    const body = v.add(filter(ctx, "lowpass", Math.min(f * 6, 2400), 0.9));
    const res = v.add(filter(ctx, "peaking", f * 2.4, 1.4, 5));
    body.connect(res).connect(rough || air);
    for (const [type, a, det] of [["sawtooth", 0.55, 0], ["square", 0.3, 3]]) {
      const o = v.add(osc(ctx, type, f * 0.965, det));
      const og = v.add(gain(ctx, a / tones.length));
      o.connect(og).connect(body);
      wg.connect(o.detune);
      o.frequency.setValueAtTime(f * 0.965, t);
      o.frequency.setTargetAtTime(f, t, 0.07);
      if (grunt) {
        o.frequency.setValueAtTime(f, t + dur - 0.06);
        o.frequency.exponentialRampToValueAtTime(f * 0.64, t + dur + grunt);
      } else {
        o.frequency.setTargetAtTime(f * 0.985, t + dur, 0.2);   // the pitch sags a little as the air stops
      }
      v.src(o, t, end);
    }
  }
  g.gain.setValueAtTime(0, t);
  g.gain.setTargetAtTime(level, t, attack / 3);
  if (grunt) g.gain.setTargetAtTime(0, t + dur + grunt * 0.45, 0.09);
  else g.gain.setTargetAtTime(0, t + dur, 0.11);
  g.gain.setValueAtTime(0, end);
  return v;
}

// ================================================================ gulls
// A western gull's call, "kyow ... kyow-kyow": a sawtooth whose pitch jumps up and falls away in each note, through
// two nasal formants (1.9 and 3.2 kHz), with the throat's hoarse roughness (amplitude modulation near 70 Hz). n notes
// in a series, each a little lower and softer, as a gull calls.
export function gull(eng, { t, n = 2, f = 950, level = 1, pan = 0, out, sends }) {
  const { ctx, rnd } = eng;
  const notes = [];
  let s = t;
  for (let i = 0; i < n; i++) {
    const d = rnd.range(0.24, 0.36);
    notes.push([s, d, f * Math.pow(0.965, i) * rnd.range(0.97, 1.03), Math.pow(0.84, i)]);
    s += d + rnd.range(0.09, 0.2);
  }
  const end = s + 0.4;
  const v = new Voice(eng, "gull", t, end);
  const g = v.add(gain(ctx, level));
  const pn = v.add(panner(ctx, pan));
  g.connect(pn);
  connectOut(v, pn, out, sends);
  v.out = g;
  const f1 = v.add(filter(ctx, "bandpass", 1900, 3.2)), f2 = v.add(filter(ctx, "bandpass", 3200, 4.5));
  const low = v.add(filter(ctx, "lowpass", 1500, 0.7));
  const m1 = v.add(gain(ctx, 1.6)), m2 = v.add(gain(ctx, 0.9)), m3 = v.add(gain(ctx, 0.35));
  const am = v.add(gain(ctx, 0.72));
  f1.connect(m1).connect(am); f2.connect(m2).connect(am); low.connect(m3).connect(am);
  am.connect(g);
  const ro = v.add(osc(ctx, "sine", rnd.range(62, 78)));
  const rg = v.add(gain(ctx, 0.28));
  ro.connect(rg).connect(am.gain);
  v.src(ro, t, end);
  for (const [t0, d, fn, a] of notes) {
    const o = v.add(osc(ctx, "sawtooth", fn * 0.78));
    const og = v.add(gain(ctx, 0));
    o.connect(og);
    og.connect(f1); og.connect(f2); og.connect(low);
    o.frequency.setValueAtTime(fn * 0.78, t0);
    o.frequency.exponentialRampToValueAtTime(fn * 1.12, t0 + 0.045);
    o.frequency.exponentialRampToValueAtTime(fn * 0.72, t0 + d);
    og.gain.setValueAtTime(0, t0);
    og.gain.linearRampToValueAtTime(a, t0 + 0.02);
    og.gain.linearRampToValueAtTime(a * 0.72, t0 + 0.09);
    og.gain.linearRampToValueAtTime(a * 0.5, t0 + d * 0.8);
    og.gain.linearRampToValueAtTime(0, t0 + d);
    v.src(o, t0, t0 + d + 0.02);
  }
  return v;
}

// ================================================================ birds (the dawn chorus)
// Three of San Francisco's own: the white-crowned sparrow (Nuttall's, the city's signature song: a clear whistle,
// then buzzier notes and a trill), the house finch (a rapid jumbled warble ending in a burry note) and the mourning
// dove (a soft, low "coo-OOO-oo-oo-oo"). Pure tones with pitch contours and trills (amplitude and frequency
// modulation), as birdsong largely is.
function chirp(v, out, t, d, f0, f1, a, { fm = 0, fmDepth = 0, am = 0, amDepth = 0 } = {}) {
  const { ctx } = v.eng;
  const o = v.add(osc(ctx, "sine", f0));
  const g = v.add(gain(ctx, 0));
  o.connect(g).connect(out);
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(50, f1), t + d);
  if (fm) {
    const m = v.add(osc(ctx, "sine", fm)), mg = v.add(gain(ctx, fmDepth));
    m.connect(mg).connect(o.frequency);
    v.src(m, t, t + d + 0.02);
  }
  let gp = g.gain;
  if (am) {
    const amg = v.add(gain(ctx, 1 - amDepth));
    g.disconnect(); g.connect(amg).connect(out);
    const m = v.add(osc(ctx, "sine", am)), mg = v.add(gain(ctx, amDepth));
    m.connect(mg).connect(amg.gain);
    v.src(m, t, t + d + 0.02);
  }
  gp.setValueAtTime(0, t);
  gp.linearRampToValueAtTime(a, t + Math.min(0.025, d * 0.25));
  gp.setValueAtTime(a, t + d * 0.7);
  gp.linearRampToValueAtTime(0, t + d);
  v.src(o, t, t + d + 0.02);
}
function birdVoice(eng, kind, t, end, level, pan, out, sends) {
  const v = new Voice(eng, kind, t, end);
  const g = v.add(gain(eng.ctx, level));
  const pn = v.add(panner(eng.ctx, pan));
  g.connect(pn);
  connectOut(v, pn, out, sends);
  v.out = g;
  return [v, g];
}
export function sparrow(eng, { t, level = 1, pan = 0, out, sends }) {
  const r = eng.rnd, k = r.range(0.94, 1.06);
  const [v, g] = birdVoice(eng, "bird", t, t + 2.8, level, pan, out, sends);
  let s = t;
  chirp(v, g, s, 0.55, 3500 * k, 3300 * k, 0.9); s += 0.62;                              // the long clear whistle
  chirp(v, g, s, 0.3, 4300 * k, 4100 * k, 0.6, { fm: 55, fmDepth: 220 }); s += 0.36;    // a buzzier, higher note
  for (let i = 0; i < 5; i++) { chirp(v, g, s, 0.06, 4800 * k, 3600 * k, 0.55); s += 0.085; }   // the trill
  chirp(v, g, s + 0.04, 0.42, 3900 * k, 3200 * k, 0.45, { fm: 85, fmDepth: 380 });         // the burry close
  return v;
}
export function finch(eng, { t, level = 1, pan = 0, out, sends }) {
  const r = eng.rnd;
  const n = r.int(12, 20);
  const [v, g] = birdVoice(eng, "bird", t, t + n * 0.11 + 0.8, level, pan, out, sends);
  let s = t;
  for (let i = 0; i < n; i++) {
    const d = r.range(0.035, 0.085), f = r.range(2300, 4600);
    chirp(v, g, s, d, f, f * r.range(0.75, 1.3), r.range(0.4, 0.8));
    s += d + r.range(0.012, 0.04);
  }
  chirp(v, g, s + 0.05, 0.32, 3900, 2600, 0.5, { fm: 70, fmDepth: 300 });
  return v;
}
export function dove(eng, { t, level = 1, pan = 0, out, sends }) {
  const r = eng.rnd, f = r.range(470, 540);
  const [v, g] = birdVoice(eng, "bird", t, t + 3.4, level, pan, out, sends);
  const lp = v.add(filter(eng.ctx, "lowpass", 1300, 0.7));
  lp.connect(g);
  const hoot = (s, d, a, b, amp) => {
    chirp(v, lp, s, d, a, b, amp);
    chirp(v, lp, s, d, a * 2, b * 2, amp * 0.12);          // a breath of the second harmonic
  };
  hoot(t, 0.32, f * 0.92, f * 1.04, 0.5);                    // coo-
  hoot(t + 0.42, 0.62, f * 1.06, f * 0.98, 0.85);             // OOO
  hoot(t + 1.5, 0.42, f * 0.98, f * 0.93, 0.6);               // oo
  hoot(t + 2.08, 0.42, f * 0.96, f * 0.92, 0.5);              // oo
  hoot(t + 2.66, 0.42, f * 0.95, f * 0.9, 0.4);               // oo
  return v;
}

// ================================================================ noise voices (traffic, wind, air, paper...)
// A burst of noise through a chain of filters, with an envelope given as points [[time from t, gain], ...] (linear
// between them; the first and last at 0), and an optional pan path [[time, pan], ...]. The workhorse of the city's
// passing cars and the room's small sounds.
export function noise(eng, { t, color = "pink", chain = [], env, pan = 0, panPath, rate = 1, out, sends, kind = "noise" }) {
  const { ctx, rnd } = eng;
  const end = t + env[env.length - 1][0] + 0.02;
  const v = new Voice(eng, kind, t, end);
  const src = v.add(burst(ctx, eng.noise[color], rnd));
  src.playbackRate.value = rate;
  let node = src;
  for (const [type, f, q, gdb, fpath] of chain) {
    const b = v.add(filter(ctx, type, f, q ?? 0.707, gdb ?? 0));
    if (fpath) { b.frequency.setValueAtTime(fpath[0][1], t); for (const [dt, fv] of fpath) b.frequency.linearRampToValueAtTime(fv, t + dt); }
    node.connect(b); node = b;
  }
  const g = v.add(gain(ctx, 0));
  const pn = v.add(panner(ctx, pan));
  node.connect(g).connect(pn);
  connectOut(v, pn, out, sends);
  v.out = g;
  g.gain.setValueAtTime(0, t);
  for (const [dt, a] of env) g.gain.linearRampToValueAtTime(a, t + dt);
  if (panPath && pn.pan) { pn.pan.setValueAtTime(panPath[0][1], t); for (const [dt, p] of panPath) pn.pan.linearRampToValueAtTime(clamp(p, -1, 1), t + dt); }
  v.src(src, t, end);
  return v;
}

// A click: a few milliseconds of a resonant body (a damped sine at f) and a tick of bright noise; the switch, the
// trackpad, the phone. body: the resonance's decay (s); bright: the tick's level.
export function click(eng, { t, f = 1800, body = 0.012, bright = 0.5, low = 0, level = 1, pan = 0, out, sends }) {
  const { ctx, rnd } = eng;
  const end = t + Math.max(body, 0.02) * 7 + 0.03;
  const v = new Voice(eng, "click", t, end);
  const g = v.add(gain(ctx, level));
  const pn = v.add(panner(ctx, pan));
  g.connect(pn);
  connectOut(v, pn, out, sends);
  v.out = g;
  const o = v.add(osc(ctx, "sine", f));
  const og = v.add(gain(ctx, 0));
  o.connect(og).connect(g);
  perc(og.gain, t, 0.6, 0.0006, body);
  v.src(o, t, end);
  if (bright) {
    const n = v.add(burst(ctx, eng.noise.white, rnd));
    const hp = v.add(filter(ctx, "bandpass", 4200, 1.1));
    const ng = v.add(gain(ctx, 0));
    n.connect(hp).connect(ng).connect(g);
    perc(ng.gain, t, bright, 0.0004, 0.0018);
    v.src(n, t, t + 0.03);
  }
  if (low) {                                                // the thump behind it (a desk's or a trackpad's mass)
    const lo = v.add(osc(ctx, "sine", 120));
    const lg = v.add(gain(ctx, 0));
    lo.connect(lg).connect(g);
    perc(lg.gain, t, low, 0.001, 0.014);
    v.src(lo, t, t + 0.15);
  }
  return v;
}
