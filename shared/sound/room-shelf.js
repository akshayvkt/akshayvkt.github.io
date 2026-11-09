// DYS-231 (H2): the lamp's switch and the shelf's books in other voices, for Akshay to choose between (engine.js plays
// one with ?roomsnd=lamp:a,book:b,book-home:a; the shape and the (t, p, o, k) signature: room-voices.js). Notes, with
// the references each voice is built from: docs/v3/briefs/dys231-shelf-notes.md.
//
// How they are made (all synthesis, nothing recorded): each touch is a short buffer computed when it plays (a few
// thousand samples, well under a millisecond), from the physics of the thing: an impact is a short pulse (its width
// sets how bright it is: a hard plastic snap 0.05-0.15 ms, a book's corner on wood 2-4 ms) ringing a few damped
// resonances (the "modes" of the switch's housing, its metal spring, the shelf's board: van den Doel, Kry & Pai's modal
// synthesis); a slide is friction: a stream of tiny stick-slip catches whose rate and brightness follow the speed of the
// slide (filtered noise whose centre tracks the speed), ringing the shelf's wood faintly underneath. Every touch varies a
// little (the engine's seeded random), so two clicks are never identical. The buffer plays through the same path as
// today's voices: a gain, the object's pan, the room bus and the room's reverb send.
import { Voice, db, clamp, gain, panner } from "./dsp.js";

const TAU = 2 * Math.PI;

// ---------------------------------------------------------------- sample-domain tools (exported for the node checks)
// one impact: a raised-cosine pulse of `width` s at `at` s (unit area: a mode below 1/width rings at about its `a`),
// ringing `modes` [[f Hz, tau s (the ring's e-folding time), a], ...]; `noise` adds the snap's broadband crack
// { f, q, tau, a } (white noise in a band, an exponential fall); `jit` (0..1) varies the modes' pitch and level
function hit(y, sr, r, { at, width = 0.0001, amp = 1, modes = [], noise = null, jit = 1 }) {
  const i0 = Math.round(at * sr), w = Math.max(2, Math.round(width * sr));
  if (i0 >= y.length) return;
  const x = new Float64Array(Math.min(y.length - i0, w + 2));
  let area = 0;
  for (let k = 0; k < x.length && k < w; k++) { x[k] = 0.5 - 0.5 * Math.cos((TAU * (k + 0.5)) / w); area += x[k]; }
  for (let k = 0; k < x.length; k++) x[k] *= amp / area;
  for (const [f0, tau, a] of modes) {
    const f = f0 * (1 + 0.035 * jit * (r() * 2 - 1)), aa = a * (1 + 0.15 * jit * (r() * 2 - 1));
    if (f >= sr * 0.45) continue;
    const wf = (TAU * f) / sr, rr = Math.exp(-1 / (tau * sr)), c1 = 2 * rr * Math.cos(wf), c2 = -rr * rr, g = aa * Math.sin(wf);
    const n = Math.min(y.length - i0, Math.ceil(tau * 9 * sr) + w);
    let y1 = 0, y2 = 0;
    for (let k = 0; k < n; k++) { const v = c1 * y1 + c2 * y2 + (k < x.length ? x[k] : 0); y2 = y1; y1 = v; y[i0 + k] += g * v; }
  }
  if (noise) {
    const n = Math.min(y.length - i0, Math.ceil(noise.tau * 9 * sr) + w);
    const b = new Float64Array(n), att = Math.max(1, Math.round(0.00015 * sr));
    for (let k = 0; k < n; k++) b[k] = (r() * 2 - 1) * (k < att ? k / att : Math.exp(-(k - att) / (noise.tau * sr)));
    svf(b, sr, () => noise.f, noise.q, "bp");
    for (let k = 0; k < n; k++) y[i0 + k] += noise.a * amp * 3 * b[k];
  }
}
// a state-variable filter (the topology-preserving form: stable while its frequency moves every sample), in place;
// fc(i) the frequency at sample i; "bp" has 0 dB at its centre
export function svf(x, sr, fc, q, type = "bp") {
  const k = 1 / q;
  let ic1 = 0, ic2 = 0, g = 0, a1 = 0, a2 = 0, a3 = 0;
  for (let i = 0; i < x.length; i++) {
    if ((i & 15) === 0) { g = Math.tan((Math.PI * clamp(fc(i), 20, sr * 0.45)) / sr); a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2; }
    const v3 = x[i] - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    x[i] = type === "bp" ? k * v1 : type === "lp" ? v2 : x[i] - k * v1 - v2;
  }
  return x;
}
// the end of every buffer: a high-pass (no rumble a small switch cannot make), the peak (or RMS) set, the last few ms faded
function finish(y, sr, { hp = 0, peak = 0, rms = 0, fade = 0.004 } = {}) {
  if (hp) { svf(y, sr, () => hp, 0.7, "hp"); svf(y, sr, () => hp, 0.7, "hp"); }
  let pk = 0, e = 0;
  for (let i = 0; i < y.length; i++) { pk = Math.max(pk, Math.abs(y[i])); e += y[i] * y[i]; }
  const s = peak ? peak / (pk || 1) : rms ? rms / Math.sqrt(e / y.length || 1) : 1;
  const nf = Math.round(fade * sr);
  const out = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) out[i] = y[i] * s * (i >= y.length - nf ? 0.5 + 0.5 * Math.cos((Math.PI * (i - (y.length - nf))) / nf) : 1);
  return out;
}
const scaleModes = (m, k, kt = 1) => m.map(([f, tau, a]) => [f * k, tau * kt, a]);

// ---------------------------------------------------------------- the lamp's switch: three switches, on and off
// A: a push-button (the base's push-through switch): a soft cam tick, the latch's snap 10 ms later, the plunger's
// return 30 ms after that, with its little spring ring; off: the latch lets go first (lower), the return after.
const PLASTIC_A = [[3150, 0.0016, 1], [4380, 0.0011, 0.7], [5900, 0.0009, 0.55], [8100, 0.0006, 0.35]];
export function lampA(sr, r, on) {
  const y = new Float64Array(Math.round(0.075 * sr)), j = () => (r() * 2 - 1) * 0.0012;
  if (on) {
    hit(y, sr, r, { at: 0.001, width: 0.00025, amp: 0.22, modes: [[2400, 0.0009, 1], [3700, 0.0006, 0.5]], noise: { f: 3500, q: 0.9, tau: 0.0006, a: 0.3 } });
    hit(y, sr, r, { at: 0.011 + j(), width: 0.00008, amp: 1, modes: [...PLASTIC_A, [6900, 0.008, 0.08], [7240, 0.007, 0.06]], noise: { f: 6000, q: 0.7, tau: 0.0005, a: 0.9 } });
    hit(y, sr, r, { at: 0.043 + j(), width: 0.00012, amp: 0.5, modes: [...scaleModes(PLASTIC_A, 0.9, 0.9), [5300, 0.01, 0.09]], noise: { f: 5200, q: 0.8, tau: 0.0005, a: 0.5 } });
  } else {
    hit(y, sr, r, { at: 0.001, width: 0.0001, amp: 1, modes: [...scaleModes(PLASTIC_A, 0.88), [6300, 0.008, 0.08]], noise: { f: 5400, q: 0.7, tau: 0.0005, a: 0.8 } });
    hit(y, sr, r, { at: 0.035 + j(), width: 0.00014, amp: 0.42, modes: [...scaleModes(PLASTIC_A, 0.95, 0.9), [5000, 0.01, 0.1]], noise: { f: 5000, q: 0.8, tau: 0.0005, a: 0.45 } });
  }
  return finish(y, sr, { hp: 600, peak: on ? 1 : 0.85 });
}
// B: a pull-chain socket (a brass shell's rotary cam): the chain's beads slide through the bushing (two faint ticks),
// the cam clacks over (lower and heavier than a push-button), then the ball chain swings back and taps a few times
// (tiny bright metallic ticks, irregular, dying away: Cook's PhISEM, particles as random filtered impacts); off: the
// clack a touch lower, the ticks after it, fewer beads.
const BRASS_B = [[1850, 0.0022, 1], [2700, 0.0017, 0.8], [3900, 0.0012, 0.6], [5300, 0.0008, 0.4]];
function beads(y, sr, r, t0, n, a0) {
  let t = t0;
  for (let i = 0; i < n; i++) {
    hit(y, sr, r, { at: t, width: 0.00004, amp: a0 * Math.pow(0.72, i) * r.range(0.7, 1.15),
      modes: [[r.range(6500, 9500), 0.0012, 1], [r.range(10500, 13000), 0.0008, 0.6]], noise: { f: 9000, q: 1.2, tau: 0.0003, a: 0.5 } });
    t += r.range(0.0045, 0.0105) * (1 + i * 0.15);
  }
}
export function lampB(sr, r, on) {
  const y = new Float64Array(Math.round(0.085 * sr));
  if (on) {
    for (const at of [0.001, 0.0055]) hit(y, sr, r, { at, width: 0.00006, amp: 0.13, modes: [[4200, 0.0005, 1], [6100, 0.0004, 0.6]], noise: { f: 5000, q: 1, tau: 0.0003, a: 0.4 } });
    hit(y, sr, r, { at: 0.011, width: 0.00015, amp: 1, modes: BRASS_B, noise: { f: 4000, q: 0.6, tau: 0.0007, a: 0.8 } });
    beads(y, sr, r, 0.021, 5, 0.3);
  } else {
    hit(y, sr, r, { at: 0.001, width: 0.00016, amp: 1, modes: scaleModes(BRASS_B, 0.93), noise: { f: 3700, q: 0.6, tau: 0.0007, a: 0.75 } });
    for (const at of [0.0075, 0.0115]) hit(y, sr, r, { at, width: 0.00006, amp: 0.12, modes: [[4000, 0.0005, 1], [5800, 0.0004, 0.6]], noise: { f: 4800, q: 1, tau: 0.0003, a: 0.4 } });
    beads(y, sr, r, 0.018, 4, 0.24);
  }
  return finish(y, sr, { hp: 500, peak: on ? 1 : 0.85 });
}
// C: a rocker (a cord's or a base's toggle): one crisp snap as the over-centre spring throws the contact, its contact
// bouncing twice or three times within 5 ms, the leaf spring's faint metallic ring (an inharmonic pair, so it never
// reads as a pitch), and the paddle landing on its stop; off: the other way over (lower, a shorter bounce).
const PLASTIC_C = [[3600, 0.0013, 1], [5100, 0.0009, 0.7], [6900, 0.0007, 0.5], [9200, 0.0005, 0.3]];
export function lampC(sr, r, on) {
  const y = new Float64Array(Math.round(0.06 * sr)), k = on ? 1 : 0.92;
  const snap = scaleModes(PLASTIC_C, k);
  hit(y, sr, r, { at: 0.001, width: 0.00006, amp: 1, modes: [...snap, [3020 * k, 0.016, 0.16], [3190 * k, 0.015, 0.13], [6350 * k, 0.009, 0.08]], noise: { f: 7000 * k, q: 0.6, tau: 0.0004, a: 1 } });
  for (const [dt, a] of on ? [[0.0016, 0.35], [0.0035, 0.18], [0.0052, 0.08]] : [[0.0012, 0.3], [0.0029, 0.12]])
    hit(y, sr, r, { at: 0.001 + dt, width: 0.00005, amp: a, modes: scaleModes(snap, 1.02, 0.7), noise: { f: 7500, q: 0.7, tau: 0.0003, a: 0.8 } });
  hit(y, sr, r, { at: on ? 0.026 : 0.022, width: 0.0003, amp: 0.28, modes: [[2200 * k, 0.0015, 1], [3300 * k, 0.001, 0.6]], noise: { f: 3000, q: 0.8, tau: 0.0006, a: 0.3 } });
  return finish(y, sr, { hp: 600, peak: on ? 1 : 0.85 });
}

// ---------------------------------------------------------------- the book pulled out (out 1.5 cm on a hover, 5 cm on a click)
// Friction (the cover's cloth and the page edges on the shelf's wood and the neighbours' covers): a stream of tiny
// stick-slip catches, denser and brighter as the book moves faster (the speed: a hand's pull, up quickly and easing
// off), through a band whose centre follows the speed, ringing the shelf's board underneath (its low modes, faint).
// d the slide's length (today's: 0.42 s for 5 cm, 0.2 s for 1.5 cm); the shape of the voice in `o`.
const SHELF = [[185, 0.03, 1], [320, 0.024, 0.8], [540, 0.018, 0.6], [870, 0.011, 0.45], [1350, 0.007, 0.3]];
function slide(sr, r, d, { lo, hi, q, grains, cont, wood, bright = 0, catchHz = 0, grainAmp = 0.9, lp = 0, speed }) {
  const n = Math.round(d * sr), x = new Float64Array(n), v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = speed(i / n);
  // the catches: a Poisson stream (rate grains * speed), each a random-sized impulse; under them a continuous rub
  for (let i = 0; i < n; i++) {
    const s = v[i];
    let a = cont * s * (r() * 2 - 1);
    if (r() < (grains * s) / sr) a += (r() < 0.5 ? -1 : 1) * Math.min(4, -Math.log(Math.max(1e-6, r()))) * grainAmp;
    if (catchHz) a *= 0.6 + 0.4 * Math.max(0, Math.sin((TAU * catchHz * i) / sr + 3 * Math.sin((TAU * 3.1 * i) / sr)));
    x[i] = a;
  }
  const body = Float64Array.from(x);
  const y = svf(x, sr, (i) => lo + (hi - lo) * v[Math.min(n - 1, i)], q, "bp");
  if (bright) { const b = svf(Float64Array.from(body), sr, (i) => 3600 + 1800 * v[Math.min(n - 1, i)], 1.3, "bp"); for (let i = 0; i < n; i++) y[i] += bright * v[i] * b[i]; }
  if (wood) {   // the board, rung by the low part of the rubbing
    const lp = svf(Float64Array.from(body), sr, () => 900, 0.7, "lp"), w = new Float64Array(n);
    for (const [f, tau, a] of SHELF) {
      const wf = (TAU * f) / sr, rr = Math.exp(-1 / (tau * sr)), c1 = 2 * rr * Math.cos(wf), c2 = -rr * rr, g = a * Math.sin(wf) * 0.06;
      let y1 = 0, y2 = 0;
      for (let i = 0; i < n; i++) { const u = c1 * y1 + c2 * y2 + lp[i]; y2 = y1; y1 = u; w[i] += g * u; }
    }
    for (let i = 0; i < n; i++) y[i] += wood * w[i];
  }
  if (lp) svf(y, sr, () => lp, 0.6, "lp");   // (cloth and wood: no fizz above it)
  return y;
}
const pull = (u) => Math.pow(Math.sin(Math.PI * Math.pow(clamp(u, 0, 1), 0.72)), 1.3);   // up fast, easing off
// A: a cloth hardback on a wooden shelf: a dry, grainy rub in the low mids (500 Hz-2.2 kHz), the board's wood under it,
// and the small "unstick" as the spine frees from its neighbours at the start
export function bookA(sr, r, d) {
  const y = slide(sr, r, d, { lo: 520, hi: 2200, q: 0.9, grains: 1400, cont: 0.45, wood: 0.3, bright: 0.25, grainAmp: 0.5, lp: 6500, speed: pull });
  const z = new Float64Array(y.length + Math.round(0.03 * sr));
  z.set(y, Math.round(0.01 * sr));
  const t = Float64Array.from(z); t.fill(0);
  hit(t, sr, r, { at: 0.012, width: 0.0015, amp: 1, modes: scaleModes(SHELF, 1.4, 0.6), noise: { f: 1800, q: 0.8, tau: 0.001, a: 0.4 } });
  let pk = 0, pz = 0;
  for (let i = 0; i < z.length; i++) { pk = Math.max(pk, Math.abs(t[i])); pz = Math.max(pz, Math.abs(z[i])); }
  for (let i = 0; i < z.length; i++) z[i] += (t[i] / (pk || 1)) * pz * 0.35;
  return finish(z, sr, { hp: 120, rms: 1, fade: 0.01 });
}
// B: the boards' paper and the page edges against the neighbouring books: brighter and finer (1.3-3.4 kHz), with a
// faint stick-slip chatter in the rub (20-40 catches a second, wavering), little wood
export function bookB(sr, r, d) {
  const y = slide(sr, r, d, { lo: 1300, hi: 3400, q: 0.75, grains: 2600, cont: 0.6, wood: 0.35, bright: 0.15, catchHz: 28, grainAmp: 0.45, speed: (u) => pull(u) * (0.85 + 0.15 * Math.sin(TAU * 2.3 * u)) });
  const z = new Float64Array(y.length + Math.round(0.02 * sr));
  z.set(y, Math.round(0.005 * sr));
  return finish(z, sr, { hp: 300, rms: 1, fade: 0.01 });
}
// C: a heavy hardback dragged on the board itself: slower to start (static friction), darker (350 Hz-1.5 kHz), more
// wood, a few coarse catches you can count
export function bookC(sr, r, d) {
  const y = slide(sr, r, d, { lo: 350, hi: 1500, q: 1.1, grains: 520, cont: 0.18, wood: 1, bright: 0.12, lp: 4000,
    speed: (u) => pull(clamp((u - 0.06) / 0.94, 0, 1)) });
  const z = new Float64Array(y.length + Math.round(0.035 * sr));
  z.set(y, Math.round(0.006 * sr));
  return finish(z, sr, { hp: 90, rms: 1, fade: 0.01 });
}

// ---------------------------------------------------------------- the book pushed home (today's: a 0.3 s slide, the stop at 0.29 s)
// The slide gets faster as it is pushed and stops dead; the spine's back edge meets the back of the shelf: a knock of
// the board (a soft 2.5 ms contact, so little above 2 kHz) with the hardback's board slap on top.
const BACK = [[180, 0.032, 0.8], [290, 0.026, 0.8], [460, 0.019, 0.7], [720, 0.013, 0.55], [1150, 0.008, 0.4], [1850, 0.005, 0.2]];
function home(sr, r, { slideLo, slideHi, slideMix, hits, hp }) {
  const stop = 0.285, n = Math.round(0.46 * sr), y = new Float64Array(n);
  const s = slide(sr, r, stop, { lo: slideLo, hi: slideHi, q: 0.9, grains: 1100, cont: 0.4, wood: 0.6, grainAmp: 0.5, lp: 4500, speed: (u) => Math.pow(u, 1.4) * (u > 0.97 ? (1 - u) / 0.03 : 1) });
  let e = 0;
  for (let i = 0; i < s.length; i++) e += s[i] * s[i];
  const sr0 = Math.sqrt(e / s.length) || 1;
  const k = new Float64Array(n);
  for (const h of hits) hit(k, sr, r, h);
  let pk = 0;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(k[i]));
  for (let i = 0; i < n; i++) y[i] = k[i] / (pk || 1) + (i < s.length ? (s[i] / sr0) * slideMix : 0);
  return finish(y, sr, { hp, peak: 1, fade: 0.02 });
}
// A: a hardback pushed home: the board's knock (150 Hz-1.6 kHz modes, 5-35 ms) and the cover's slap
export function homeA(sr, r) {
  return home(sr, r, { slideLo: 450, slideHi: 1700, slideMix: 0.08, hp: 70,
    hits: [{ at: 0.29, width: 0.0025, amp: 1, modes: BACK, noise: { f: 1300, q: 0.7, tau: 0.002, a: 0.25 } }] });
}
// B: a cloth spine settling: muffled (the modes damped 40 % faster, a 3 ms contact), a double tap (the back edge, then the foot
// dropping flush 22 ms later), a softer slide
export function homeB(sr, r) {
  const damp = scaleModes(BACK, 1, 0.6);
  return home(sr, r, { slideLo: 380, slideHi: 1300, slideMix: 0.06, hp: 70,
    hits: [{ at: 0.29, width: 0.003, amp: 1, modes: damp, noise: { f: 900, q: 0.7, tau: 0.003, a: 0.18 } },
      { at: 0.312, width: 0.0035, amp: 0.45, modes: scaleModes(damp, 1.15), noise: { f: 800, q: 0.7, tau: 0.003, a: 0.12 } }] });
}

// ---------------------------------------------------------------- playing a buffer through the room
function play(k, t, p, data, level, send) {
  const { eng } = k, ctx = eng.ctx, dur = data.length / ctx.sampleRate;
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.getChannelData(0).set(data);
  const v = new Voice(eng, "touch", t, t + dur + 0.02);
  const src = v.add(ctx.createBufferSource());
  src.buffer = buf;
  const g = v.add(gain(ctx, level)), pn = v.add(panner(ctx, p));
  src.connect(g).connect(pn).connect(k.out);
  if (send) pn.connect(v.add(gain(ctx, send))).connect(k.send);
  v.out = g;
  v.src(src, t, t + dur + 0.01);
}
const SR = (k) => k.eng.ctx.sampleRate;
const lamp = (fn) => (t, p, o, k) => play(k, t, p, fn(SR(k), k.eng.rnd, o.on !== false), db(k.MIX.touch - 3), 0.3);
// the book: the same lengths and levels as today's (5 cm: 0.42 s, louder; 1.5 cm on a hover: 0.2 s)
const book = (fn, dbBig, dbSmall) => (t, p, o, k) => {
  const big = (o.out || 0) > 0.03;
  play(k, t, p, fn(SR(k), k.eng.rnd, big ? 0.42 : 0.2), db(k.MIX.touch + (big ? dbBig : dbSmall)), 0.35);
};
const bookHome = (fn) => (t, p, o, k) => play(k, t, p, fn(SR(k), k.eng.rnd), db(k.MIX.touch - 9), 0.5);

export const SHELF_VOICES = {
  lamp: { a: lamp(lampA), b: lamp(lampB), c: lamp(lampC) },
  book: { a: book(bookA, -29, -33), b: book(bookB, -31, -35), c: book(bookC, -28, -32) },
  "book-home": { a: bookHome(homeA), b: bookHome(homeB) },
};
