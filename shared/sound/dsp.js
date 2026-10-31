// The sound's small tools (shared/sound/*): a seeded random source, noise, generated impulse responses, envelopes and
// a voice that cleans up after itself. Nothing here is a recording: every buffer is computed on the visitor's machine
// when Sound is switched on (a few milliseconds), and every level is in decibels relative to a noise buffer's own RMS
// of -20 dBFS (NOISE_RMS), so the mix's numbers in the other files read as plain dB.

export const NOISE_RMS = 0.1;                          // every noise buffer is scaled to this RMS (-20 dBFS)
export const db = (x) => Math.pow(10, x / 20);         // decibels -> gain
export const toDb = (g) => 20 * Math.log10(Math.max(1e-9, g));
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

// ---------------------------------------------------------------- random
// mulberry32: a small seeded generator (offline renders are reproducible; live, the seed comes from Math.random)
export function rng(seed = (Math.random() * 2 ** 32) >>> 0) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * r());
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.chance = (p) => r() < p;
  r.gauss = () => { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  // [[value, weight], ...] -> value
  r.weighted = (pairs) => {
    let s = 0;
    for (const [, w] of pairs) s += Math.max(0, w);
    let x = r() * s;
    for (const [v, w] of pairs) { x -= Math.max(0, w); if (x <= 0) return v; }
    return pairs[pairs.length - 1][0];
  };
  // the time to the next event of a Poisson process of `perMinute` events a minute (Infinity when none)
  r.poisson = (perMinute) => (perMinute > 0 ? (-Math.log(Math.max(1e-9, 1 - r())) * 60) / perMinute : Infinity);
  return r;
}

// ---------------------------------------------------------------- noise
// White, pink (Paul Kellet's refined filter: -3 dB/octave within 0.05 dB from 9 Hz up) and brown (leaky integrated
// white, -6 dB/octave) noise, each channel independent, scaled to NOISE_RMS. Looped with a random start, a few seconds
// of noise under slowly moving filters never shows its seam.
export function noiseBuffer(ctx, { seconds = 6, color = "white", channels = 1, seed = 1 } = {}) {
  const sr = ctx.sampleRate, n = Math.round(seconds * sr);
  const buf = ctx.createBuffer(channels, n, sr);
  const r = rng(seed);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < n; i++) {
      const w = r() * 2 - 1;
      if (color === "pink") {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
      } else if (color === "brown") {
        last = (last + 0.02 * w) / 1.02; d[i] = last;
      } else d[i] = w;
    }
    // remove DC, scale to the common RMS, and cross-fade the loop's seam over 50 ms
    let mean = 0;
    for (let i = 0; i < n; i++) mean += d[i];
    mean /= n;
    let e = 0;
    for (let i = 0; i < n; i++) { d[i] -= mean; e += d[i] * d[i]; }
    const k = NOISE_RMS / Math.sqrt(e / n || 1);
    for (let i = 0; i < n; i++) d[i] *= k;
    const x = Math.round(0.05 * sr);
    for (let i = 0; i < x; i++) { const t = i / x; d[i] = d[i] * t + d[n - x + i] * (1 - t); }
  }
  return buf;
}

// ---------------------------------------------------------------- impulse responses
// A room's or a hall's reverberation, generated: a few early reflections (each a short smear, panned), then a diffuse
// tail of independent noise per channel whose highs die faster than its lows (two exponential decays split at
// `split` Hz by a one-pole filter: a furnished room's soft surfaces and the air absorb the highs), with a soft onset
// and a pre-delay. Normalised to unit energy per channel, so a wet send of g gives roughly g times the dry level.
export function impulse(ctx, {
  seconds = 2, rt60 = 1.6, rt60High = 0.8, split = 2500, predelay = 0.02, onset = 0.03, early = [], width = 1, seed = 7,
} = {}) {
  const sr = ctx.sampleRate, n = Math.round(seconds * sr);
  const buf = ctx.createBuffer(2, n, sr);
  const r = rng(seed);
  const a = Math.exp((-2 * Math.PI * split) / sr);          // one-pole low-pass coefficient
  const ch = [buf.getChannelData(0), buf.getChannelData(1)];
  const p0 = Math.round(predelay * sr);
  for (let c = 0; c < 2; c++) {
    const d = ch[c];
    let lp = 0, eLow = 2.2, eHigh = 1;
    const kLow = Math.exp(-6.91 / (rt60 * sr)), kHigh = Math.exp(-6.91 / (rt60High * sr)), on = onset * sr;
    for (let i = p0; i < n; i++) {
      const w = r() * 2 - 1;
      lp = (1 - a) * w + a * lp;
      const k = i - p0 < on ? (i - p0) / on : 1;
      d[i] = k * (lp * eLow + (w - lp) * eHigh);
      eLow *= kLow; eHigh *= kHigh;
    }
    // fade the last 10 % to zero (no click at the end of the tail)
    const f = Math.round(n * 0.1);
    for (let i = 0; i < f; i++) d[n - 1 - i] *= i / f;
  }
  // early reflections: [time s, gain, pan -1..1]
  for (const [t, g, pan] of early) {
    const i0 = Math.round(t * sr);
    const gl = g * Math.cos(((pan + 1) * Math.PI) / 4), gr = g * Math.sin(((pan + 1) * Math.PI) / 4);
    for (let k = 0; k < 24 && i0 + k < n; k++) {
      const s = Math.exp(-k / 5) * (r() * 0.6 + 0.7);
      ch[0][i0 + k] += gl * s; ch[1][i0 + k] += gr * s;
    }
  }
  // width < 1 pulls the two channels toward each other
  if (width < 1) {
    const m = (1 - width) / 2;
    for (let i = 0; i < n; i++) { const l = ch[0][i], rr = ch[1][i]; ch[0][i] = l * (1 - m) + rr * m; ch[1][i] = rr * (1 - m) + l * m; }
  }
  for (const d of ch) {
    let e = 0;
    for (let i = 0; i < n; i++) e += d[i] * d[i];
    const k = 1 / Math.sqrt(e || 1);
    for (let i = 0; i < n; i++) d[i] *= k;
  }
  return buf;
}

// The safety curve at the very end of the chain: unity up to -6 dBFS, then a smooth knee that never passes -1 dBFS.
// The limiter before it should keep the mix far below; this only guarantees that nothing can ever be harsh.
export function softClipCurve(n = 2048) {
  const c = new Float32Array(n), knee = 0.5, ceil = 0.89;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + (ceil - knee) * Math.tanh((ax - knee) / (ceil - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

// ---------------------------------------------------------------- voices
// A voice owns the nodes of one sound: its sources stop at `end`, and everything is disconnected once the last of them
// has ended (or at once with stop()). The engine keeps the live ones so a clock jump (the dial) can cancel what has
// not started yet, and Sound off can silence everything.
export class Voice {
  constructor(eng, kind, t0, end) {
    this.eng = eng; this.kind = kind; this.t0 = t0; this.end = end;
    this.nodes = []; this.sources = 0; this.done = false;
    eng.voices.add(this);
  }
  add(...nodes) { this.nodes.push(...nodes); return nodes[0]; }
  // a source node (oscillator or buffer source) that starts at t and stops at `stop` (default the voice's end)
  src(node, t = this.t0, stop = this.end) {
    this.nodes.push(node);
    this.sources++;
    node.onended = () => { if (--this.sources <= 0) this.free(); };
    const at = Math.max(t, this.eng.ctx.currentTime);
    if (node._offset !== undefined) node.start(at, node._offset); else node.start(at);
    node.stop(Math.max(stop, at + 0.01));
    return node;
  }
  free() {
    if (this.done) return;
    this.done = true;
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* already */ } }
    this.nodes.length = 0;
    this.eng.voices.delete(this);
  }
  // silence now (a short fade on the voice's out gain when it has one), then free
  stop(fade = 0.05) {
    const now = this.eng.ctx.currentTime;
    if (this.out) { try { this.out.gain.cancelScheduledValues(now); this.out.gain.setTargetAtTime(0, now, fade / 3); } catch { /* */ } }
    for (const n of this.nodes) if (n.stop) { try { n.stop(now + fade + 0.02); } catch { /* not started or stopped */ } }
  }
}

// gain node with a value
export function gain(ctx, v = 1) { const g = ctx.createGain(); g.gain.value = v; return g; }
export function filter(ctx, type, f, q = 0.707, gainDb = 0) {
  const b = ctx.createBiquadFilter();
  b.type = type; b.frequency.value = f; b.Q.value = q; if (gainDb) b.gain.value = gainDb;
  return b;
}
export function panner(ctx, p = 0) {
  if (ctx.createStereoPanner) { const s = ctx.createStereoPanner(); s.pan.value = clamp(p, -1, 1); return s; }
  return gain(ctx, 1);   // (very old browsers: centred)
}
export function osc(ctx, type, f, detune = 0) {
  const o = ctx.createOscillator();
  if (typeof type === "string") o.type = type; else o.setPeriodicWave(type);
  o.frequency.value = f; if (detune) o.detune.value = detune;
  return o;
}
// a looping buffer source starting at a random point of its buffer
export function loop(ctx, buf, r, rate = 1) {
  const s = ctx.createBufferSource();
  s.buffer = buf; s.loop = true; s.playbackRate.value = rate;
  s.loopStart = 0; s.loopEnd = buf.duration;
  s._offset = (r ? r() : Math.random()) * buf.duration;
  return s;
}
// a one-shot slice of a noise buffer (random offset), for bursts
export function burst(ctx, buf, r) {
  const s = ctx.createBufferSource();
  s.buffer = buf; s.loop = true;
  s._offset = (r ? r() : Math.random()) * (buf.duration - 0.5);
  return s;
}
// start a buffer source honouring its random offset
export function startAt(src, t, stop) {
  src.start(t, src._offset || 0);
  if (stop !== undefined) src.stop(stop);
}

// Percussive envelope on a gain param: 0 at t, `peak` after `attack`, then an exponential fall with time constant
// `tau` (e-folding seconds); reaches true zero by t + attack + 7 tau. Returns that end time.
export function perc(param, t, peak, attack, tau) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setTargetAtTime(0, t + attack, tau);
  const end = t + attack + 7 * tau;
  param.setValueAtTime(0, end);
  return end;
}
// Swell envelope: 0 at t, up to `peak` over `attack` (sine-ish), hold, release over `release`; returns the end time.
export function swell(param, t, peak, attack, hold, release) {
  param.setValueAtTime(0, t);
  param.setTargetAtTime(peak, t, attack / 3);
  param.setTargetAtTime(0, t + attack + hold, release / 4);
  const end = t + attack + hold + release * 1.6;
  param.setValueAtTime(0, end);
  return end;
}
