// DYS-231 (H5): the notebook's touches in other voices (page, elastic, cover-open, cover-close); see room-voices.js
// for the shape. Each voice is (t, p, o, k) with k = { eng, MIX, out, send } (engine.js), timed as today's CUES
// entries: the page over o.dur (0.65 s, 0.72 from the 3D turn), the elastic at its cue (opening; o.delay 0.86 when it
// goes back on after the cover closes), the cover's landing at t + o.dur (0.8 s; the cover eases in, notebook.js).
// Live synthesis only (dsp.js, instruments.js): nothing recorded. Why each one sounds as it does, with references:
// docs/v3/briefs/dys231-notebook-notes.md.
//
// Levels: each option's trim (dB on MIX.touch) matches today's loudest 50 ms (take 1, 2 Nov 14:20; the notes).
// The pieces (what today's voices lacked):
//   pops     paper's sound is discrete pops (a facet snapping, ringing ~1 ms near 1-2.5 kHz), loudness spread as a
//            power law, clustered in time (Houle & Sethna 1996; Kramer & Lobkovsky 1996): one noise voice whose gain
//            is a train of 1-3 ms ticks, through a broad band near 2 kHz
//   flutter  sliding friction (paper on paper, cloth on board) is noise whose loudness flickers every 10-30 ms, not a
//            smooth swell
//   knock    an impact is a soft contact pulse (its length is the hardness: rubber or a padded cover longer, duller)
//            exciting a few damped inharmonic modes (the desk's wood near 110-930 Hz, the board's higher), each dying
//            in a few cycles (FoleyAutomatic's modal model) - not one sine at 140-170 Hz
import { Voice, db, clamp, gain, filter, panner, osc, burst, perc } from "./dsp.js";
import { noise } from "./instruments.js";

// ---------------------------------------------------------------- envelopes
// friction: the contour (0..1 of d -> 0..1) times a log-normal flicker every step s; [[dt, gain]] from 0 to d
function flutter(r, d, contour, { step = [0.012, 0.026], sigma = 0.45, level = 1 } = {}) {
  const env = [[0, 0]];
  for (let x = step[0]; x < d - 0.006; x += r.range(step[0], step[1])) env.push([x, level * contour(x / d) * Math.min(3, Math.exp(sigma * r.gauss()))]);
  env.push([d, 0]);
  return env;
}
// pops: ticks at a Poisson rate (per s; rate(0..1 of d), at most rmax), some in clusters of 2-3, energies a power law
// p(E) ~ E^-alpha over `span` (amplitude sqrt(E)); [[dt, gain]] from 0 to d
function pops(r, d, rate, rmax, { alpha = 1.4, span = 300, len = [0.0012, 0.003], cluster = 0.3, level = 1, from = 0 } = {}) {
  const env = [[0, 0]];
  let x = from, last = 0;
  for (let guard = 0; guard < 400; guard++) {
    x += -Math.log(1 - r() * 0.999999) / rmax;
    if (x > d - 0.006) break;
    if (r() * rmax > rate(x / d)) continue;
    const n = r.chance(cluster) ? r.int(2, 3) : 1;
    for (let i = 0; i < n; i++) {
      const at = Math.max(x, last + 0.0005);
      if (at > d - 0.006) break;
      const E = Math.min(span, Math.pow(1 - r() * 0.999999, -1 / (alpha - 1)));
      const ln = r.range(len[0], len[1]);
      env.push([at, 0], [at + 0.0004, level * Math.sqrt(E / span)], [at + ln, 0]);
      last = at + ln; x = last + r.range(0.0015, 0.005);
    }
  }
  env.push([Math.max(d, last + 0.001), 0]);
  return env;
}
const bell = (a, b) => (x) => (x <= a || x >= b ? 0 : Math.sin((Math.PI * (x - a)) / (b - a)) ** 2);   // a soft hump on [a, b]
const peaked = (a, m, b) => (x) => (x <= a || x >= b ? 0 : x < m ? Math.sin((Math.PI / 2) * (x - a) / (m - a)) ** 2 : Math.cos((Math.PI / 2) * (x - m) / (b - m)) ** 2);

// ---------------------------------------------------------------- the knock
// modes [[f, tau, amp]] (each f jittered a little per hit), a contact { chain, soft (the pulse's rise, s), tau, a,
// color } of noise; the modes' attack follows the contact's softness. One voice, its own panner and sends.
function knock(k, { t, modes = [], contact = null, level = 1, pan = 0, sends = null, jitter = 0.035 }) {
  const { eng } = k, { ctx, rnd } = eng;
  const soft = contact?.soft ?? 0.0008;
  let end = t + 0.04;
  for (const [, tau] of modes) end = Math.max(end, t + soft + 7 * tau + 0.01);
  if (contact) end = Math.max(end, t + soft + 7 * contact.tau + 0.01);
  const v = new Voice(eng, "touch", t, end);
  const g = v.add(gain(ctx, level));
  const pn = v.add(panner(ctx, pan));
  g.connect(pn);
  pn.connect(k.out);
  for (const [s, w] of sends || []) { const sg = v.add(gain(ctx, w)); pn.connect(sg).connect(s); }
  v.out = g;
  for (const [f, tau, a] of modes) {
    const o = v.add(osc(ctx, "sine", f * (1 + rnd.range(-jitter, jitter))));
    const og = v.add(gain(ctx, 0));
    o.connect(og).connect(g);
    perc(og.gain, t, a, Math.max(0.0006, soft), tau);
    v.src(o, t, t + soft + 7 * tau + 0.005);
  }
  if (contact) {
    const n = v.add(burst(ctx, eng.noise[contact.color || "white"], rnd));
    let node = n;
    for (const [type, f, q] of contact.chain || []) { const b = v.add(filter(ctx, type, f, q ?? 0.707)); node.connect(b); node = b; }
    const ng = v.add(gain(ctx, 0));
    node.connect(ng).connect(g);
    perc(ng.gain, t, contact.a ?? 1, Math.max(0.0003, soft), contact.tau);
    v.src(n, t, t + soft + 7 * contact.tau + 0.005);
  }
  return v;
}

// ================================================================ the page
// A leaf of 80-100 gsm paper turned by a finger (d: the turn): the lift (the corner peels off the next leaf: a few
// small pops and a short rasp), the swing (the bending leaf's friction and pops, densest as it buckles over the top
// near 45 % of d), the settle (it lands on the other side: a soft puff of air from under it, a few last pops, a very
// quiet tap). No pitched tick at the start, no single filter sweep.
function page(k, t, p, o, s) {
  const { eng, MIX } = k, r = eng.rnd, T = MIX.touch + (s.trim || 0);
  const back = (o.dir || 1) < 0, d = clamp(o.dur || 0.65, 0.35, 1.2);
  const pan = [[0, p + (back ? -0.12 : 0.12)], [d, p + (back ? 0.12 : -0.12)]];
  const sends = [[k.send, 0.4]];
  // the lift: the corner peels off the next leaf
  noise(eng, { t, color: "pink", chain: [["highpass", 1200, 0.7], ["bandpass", s.peelHz, 0.7]], env: flutter(r, 0.09, bell(0, 0.95), { step: [0.006, 0.012], level: db(T + s.peelDb) }), pan: pan[0][1], out: k.out, kind: "touch" });
  // the swing: the leaf's friction (paper flexing, rubbing the air and the next leaf)
  noise(eng, { t, color: "pink", chain: [["highpass", s.hp, 0.7], ["bandpass", s.fHz, 0.55, 0, [[0, s.fHz * 0.85], [d * 0.45, s.fHz * 1.2], [d, s.fHz * 0.75]]], ["lowpass", s.lp, 0.7]],
    env: flutter(r, d, peaked(s.swing[0], s.swing[1], s.swing[2]), { step: [0.012, 0.028], sigma: s.sigma, level: db(T + s.frictionDb) }), panPath: pan, out: k.out, sends, kind: "touch" });
  // the air the leaf pushes as it swings (low-mid, soft; strongest in b)
  if (s.airDb > -60) noise(eng, { t: t + d * 0.15, color: "pink", chain: [["bandpass", 650, 0.6, 0, [[0, 520], [d * 0.35, 900], [d * 0.7, 600]]]],
    env: [[0, 0], [d * 0.35, db(T + s.airDb)], [d * 0.7, 0]], panPath: [[0, pan[0][1]], [d * 0.7, pan[1][1]]], out: k.out, kind: "touch" });
  // the pops: a cluster at the lift, the most as the leaf buckles over, a few as it lands
  const rate = (x) => s.pops * (0.55 * peaked(0, 0.04, 0.16)(x) + peaked(0.18, s.swing[1], 0.8)(x) + 0.35 * peaked(0.84, 0.96, 1)(x));
  noise(eng, { t, color: "white", chain: [["highpass", 700, 0.7], ["bandpass", s.popHz, 0.9]], env: pops(r, d, rate, s.pops, { level: db(T + s.popDb), cluster: 0.35 }), pan: p, out: k.out, sends: [[k.send, 0.25]], kind: "touch" });
  if (s.popHz2) noise(eng, { t, color: "white", chain: [["bandpass", s.popHz2, 1.2]], env: pops(r, d, (x) => 0.5 * rate(x), s.pops, { level: db(T + s.popDb - 5), len: [0.0008, 0.0018] }), pan: p, out: k.out, kind: "touch" });
  // the flap: the leaf's curve flips as it passes over the top
  if (s.flapDb > -60) noise(eng, { t: t + d * s.swing[1], color: "pink", chain: [["bandpass", 1100, 0.7]], env: [[0, 0], [0.006, db(T + s.flapDb)], [0.03, 0]], pan: p, out: k.out, kind: "touch" });
  // the settle: the air from under the landing leaf, and its tap on the stack
  noise(eng, { t: t + d - 0.035, color: "pink", chain: [["bandpass", s.landHz, 0.6], ["lowpass", 3500, 0.7]], env: [[0, 0], [0.012, db(T + s.landDb)], [0.06, 0]], pan: pan[1][1], out: k.out, sends, kind: "touch" });
  knock(k, { t: t + d - 0.012, modes: [[s.tapHz, 0.004, 0.5], [s.tapHz * 2.3, 0.0025, 0.3]], contact: { chain: [["lowpass", 2500, 0.7]], soft: 0.002, tau: 0.002, a: 2.5 }, level: db(T + s.tapDb), pan: pan[1][1] });
}
const PAGE = {
  // a: paper's own sound: pops near 2 kHz over a flickering friction band (the main candidate)
  a: { trim: 1, peelHz: 3200, peelDb: -4, hp: 450, fHz: 1900, lp: 7500, swing: [0.06, 0.45, 0.88], sigma: 0.45, frictionDb: -1.5, airDb: -99,
    pops: 70, popHz: 2100, popHz2: 4800, popDb: 6, flapDb: -99, landHz: 1000, landDb: -1, tapHz: 260, tapDb: -16 },
  // b: a heavier, softer leaf: darker friction, the air of the swing, a flap as it flips, a fuller landing
  b: { trim: 1, peelHz: 2600, peelDb: -6, hp: 350, fHz: 1300, lp: 4500, swing: [0.08, 0.5, 0.9], sigma: 0.35, frictionDb: -2, airDb: -9,
    pops: 28, popHz: 1700, popHz2: 0, popDb: 3, flapDb: -2, landHz: 700, landDb: 1, tapHz: 210, tapDb: -12 },
  // c: a crisp, thin leaf: many more pops and brighter, a shorter friction, a light landing
  c: { trim: 3, peelHz: 4000, peelDb: -3, hp: 900, fHz: 2700, lp: 9000, swing: [0.1, 0.42, 0.72], sigma: 0.55, frictionDb: -5, airDb: -99,
    pops: 140, popHz: 2600, popHz2: 5200, popDb: 7, flapDb: -99, landHz: 1300, landDb: -4, tapHz: 300, tapDb: -20 },
};

// ================================================================ the elastic
// A fabric-covered elastic band, 6 mm, round the closed board cover. Opening (notebook.js: it slides 26 mm off the
// fore edge over 0.34 s and clears the edge about 0.22 s in): the cloth drags over the board's edge, then the band
// slaps the board as it lets go. Back on (o.delay 0.86, after the cover has closed): it slaps onto the cover face
// almost at once (it is back over the edge ~0.03 s in), then drags into place. A slap, not a tone: rubber's own
// damping kills any ring (a band's pitch, ~50-150 Hz, lasts a cycle or two at most).
function elastic(k, t, p, o, s) {
  const { eng, MIX } = k, r = eng.rnd, T = MIX.touch + (s.trim || 0);
  const on = (o.delay || 0) > 0.5;
  const slapAt = on ? 0.03 : s.slapAt, drag = on ? [0.05, 0.26] : [0, s.slapAt - 0.01];
  if (s.dragDb > -60 && drag[1] - drag[0] > 0.04) noise(eng, { t: t + drag[0], color: "pink", chain: [["highpass", 900, 0.7], ["bandpass", s.dragHz, 0.6]],
    env: flutter(r, drag[1] - drag[0], on ? peaked(0, 0.25, 1) : peaked(0, 0.8, 1), { step: [0.007, 0.016], sigma: 0.55, level: db(T + s.dragDb - (on ? 4 : 0)) }), pan: p, out: k.out, kind: "touch" });
  const modes = [...s.board.map(([f, tau, a]) => [f, tau, a * (on ? 1.4 : 1)])];
  if (s.twang) modes.push(s.twang);
  knock(k, { t: t + slapAt, modes, contact: { chain: [["highpass", 180, 0.7], ["lowpass", s.lp * (on ? 1.3 : 1), 0.7]], soft: s.soft, tau: s.tau, a: s.contact },
    level: db(T + s.slapDb + (on ? 1 : 0)), pan: p, sends: [[k.send, 0.35]] });
  // the twang's pitch falls as the band relaxes (b)
  if (s.fall) {
    const v = knock(k, { t: t + slapAt + 0.001, modes: [[s.fall[0], s.fall[2], 0.5], [s.fall[0] * 2.05, s.fall[2] * 0.5, 0.12]], level: db(T + s.fallDb), pan: p, jitter: 0.05 });
    for (const n of new Set(v.nodes)) if (n.frequency && n.type === "sine") { n.frequency.setValueAtTime(n.frequency.value, t + slapAt + 0.001); n.frequency.exponentialRampToValueAtTime(Math.max(30, n.frequency.value * (s.fall[1] / s.fall[0])), t + slapAt + 0.05); }
  }
}
const ELASTIC = {
  // a: the cloth's drag over the edge, then a dull slap on the board (a 3 ms contact, the board's damped modes)
  a: { trim: 6, slapAt: 0.22, dragHz: 2800, dragDb: -6, soft: 0.0015, tau: 0.003, contact: 3, lp: 2600, slapDb: -9,
    board: [[85, 0.006, 0.3], [430, 0.005, 0.2], [780, 0.004, 0.14], [1350, 0.0025, 0.08]] },
  // b: the same with the rubber in it: a short pitched thwum that falls from ~120 to ~85 Hz as the band relaxes
  b: { trim: 3.5, slapAt: 0.22, dragHz: 2800, dragDb: -7, soft: 0.0015, tau: 0.003, contact: 2.5, lp: 2400, slapDb: -10,
    board: [[430, 0.005, 0.18], [780, 0.004, 0.12], [1350, 0.0025, 0.07]], fall: [120, 85, 0.016], fallDb: -9 },
  // c: soft cloth: no drag, an early muffled slap (as today's timing, 0.04 s in), the band's weight only
  c: { trim: 3.5, slapAt: 0.04, dragHz: 2400, dragDb: -99, soft: 0.003, tau: 0.004, contact: 2.5, lp: 1300, slapDb: -8,
    board: [[95, 0.007, 0.35], [360, 0.005, 0.16], [640, 0.0035, 0.08]] },
};

// ================================================================ the cover opening
// The board cover (2-3 mm board in cloth) swings 174 degrees in d and eases onto the desk (notebook.js SOFT: it
// arrives slowly, so a soft landing). Its swing makes almost no air sound: the hinge's cloth and glue flex as it
// starts (a few faint pops, the endpaper peeling from the first leaf), the air under it is pushed out just before it
// lands, and the landing is a soft knock: the desk's wood modes under a padded contact.
function coverOpen(k, t, p, o, s) {
  const { eng, MIX } = k, r = eng.rnd, T = MIX.touch + (s.trim || 0);
  const d = o.dur || 0.8;
  // the hinge: the spine's cloth and glue flex, the endpaper peels off the first leaf
  noise(eng, { t, color: "white", chain: [["highpass", 800, 0.7], ["bandpass", s.creakHz, 0.9]], env: pops(r, s.creak, (x) => 60 * peaked(0, 0.3, 1)(x), 60, { level: db(T + s.creakDb), cluster: 0.45 }), pan: p, out: k.out, kind: "touch" });
  noise(eng, { t: t + 0.02, color: "pink", chain: [["highpass", 900, 0.7], ["bandpass", 2600, 0.6]], env: flutter(r, s.creak + 0.06, peaked(0, 0.35, 1), { step: [0.01, 0.022], level: db(T + s.creakDb - 6) }), pan: p, out: k.out, kind: "touch" });
  // the swing's air (only b: a heavier board, barely there)
  if (s.swingDb > -60) noise(eng, { t: t + d * 0.25, color: "pink", chain: [["lowpass", 700, 0.6]], env: [[0, 0], [d * 0.35, db(T + s.swingDb)], [d * 0.7, 0]], pan: p, out: k.out, kind: "touch" });
  // the air under the cover as it nears the desk
  if (s.puff) noise(eng, { t: t + d - s.puff, color: "pink", chain: [["bandpass", 520, 0.6, 0, [[0, 380], [s.puff, 800]]]], env: [[0, 0], [s.puff * 0.6, db(T + s.puffDb) * 0.45], [s.puff, db(T + s.puffDb)], [s.puff + 0.02, 0]], pan: p, out: k.out, kind: "touch" });
  // the landing
  knock(k, { t: t + d - 0.006, modes: s.modes, contact: { chain: s.contact, soft: s.soft, tau: s.tau, a: s.ca }, level: db(T + s.landDb), pan: p, sends: [[k.send, 0.5]] });
  // the leaves' edges settle after it (b)
  if (s.settleDb > -60) noise(eng, { t: t + d + 0.01, color: "pink", chain: [["highpass", 1200, 0.7], ["bandpass", 3000, 0.7]], env: flutter(r, 0.08, peaked(0, 0.2, 1), { step: [0.006, 0.014], level: db(T + s.settleDb) }), pan: p, out: k.out, kind: "touch" });
}
// the desk's modes: near a struck wooden beam's (65, 198, 370, 620, 930 Hz) and the board's own, higher and shorter
const DESK = [[112, 0.011, 0.24], [198, 0.009, 0.28], [370, 0.007, 0.2], [620, 0.005, 0.13], [930, 0.0035, 0.08]];
const COVER_OPEN = {
  // a: faint hinge pops, a small puff, a soft padded knock on the desk (a 4 ms contact)
  a: { trim: 5, creak: 0.2, creakHz: 2200, creakDb: -8, swingDb: -99, puff: 0.06, puffDb: -6, modes: [...DESK, [1250, 0.0025, 0.07]],
    contact: [["lowpass", 1800, 0.7]], soft: 0.004, tau: 0.004, ca: 3, landDb: -8, settleDb: -99 },
  // b: a heavier hardback: a breath of air in the swing, a longer 'fwump' under it, a duller, lower knock, the leaves after
  b: { trim: 3, creak: 0.26, creakHz: 1800, creakDb: -9, swingDb: -30, puff: 0.1, puffDb: -4, modes: [[92, 0.014, 0.3], [198, 0.01, 0.26], [330, 0.008, 0.16], [560, 0.005, 0.08]],
    contact: [["lowpass", 1000, 0.7]], soft: 0.007, tau: 0.006, ca: 3.5, landDb: -7, settleDb: -8 },
  // c: a light board: a short creak, no puff, a crisper tap (a hard 1.5 ms contact with a high click, higher modes)
  c: { trim: 6, creak: 0.14, creakHz: 2800, creakDb: -9, swingDb: -99, puff: 0, puffDb: -99, modes: [[240, 0.006, 0.22], [520, 0.005, 0.2], [900, 0.0035, 0.14], [1500, 0.0022, 0.09]],
    contact: [["highpass", 300, 0.7], ["lowpass", 4500, 0.7]], soft: 0.0015, tau: 0.0025, ca: 2.5, landDb: -10, settleDb: -99 },
};

// ================================================================ the cover closing
// The cover swings shut over d and eases onto the page block. The last ~0.1 s squeezes the air out from between the
// cover and the leaves (a rising 'ffff' cut off at contact), then the board meets the paper: the page block damps
// it (a dull, short thud, little ring) and the book passes a low thump to the desk; a faint papery tick on top.
function coverClose(k, t, p, o, s) {
  const { eng, MIX } = k, T = MIX.touch + (s.trim || 0);
  const d = o.dur || 0.8;
  const pf = s.puff;
  noise(eng, { t: t + d - pf, color: "pink", chain: [["lowpass", s.puffLp, 0.6], ["bandpass", 600, 0.5, 0, [[0, 420], [pf, s.puffTop]]]],
    env: [[0, 0], [pf * 0.5, db(T + s.puffDb) * 0.22], [pf * 0.85, db(T + s.puffDb) * 0.7], [pf, db(T + s.puffDb)], [pf + 0.012, 0]], pan: p, out: k.out, sends: [[k.send, 0.3]], kind: "touch" });
  knock(k, { t: t + d - 0.004, modes: s.modes, contact: { chain: s.contact, soft: s.soft, tau: s.tau, a: s.ca }, level: db(T + s.thudDb), pan: p, sends: [[k.send, 0.5]] });
  if (s.tickDb > -60) noise(eng, { t: t + d - 0.002, color: "white", chain: [["bandpass", 3600, 1]], env: [[0, 0], [0.0006, db(T + s.tickDb)], [0.004, 0]], pan: p, out: k.out, kind: "touch" });
}
// (b: +3 dB, 3.5 -> 6.5, 2 Nov 15:2x, Akshay's pick: its loudest 50 ms measured 3.4 dB under the other picks' median,
// 0.6 dB over the night bed; the coordinator allowed up to 3 dB, the level only)
const COVER_CLOSE = {
  // a: the puff, a damped thud (a 6 ms contact under 1 kHz, three short low modes), a faint tick
  a: { trim: 4, puff: 0.09, puffLp: 1600, puffTop: 1300, puffDb: -5, modes: [[128, 0.008, 0.3], [236, 0.006, 0.24], [410, 0.004, 0.14]],
    contact: [["lowpass", 1000, 0.7]], soft: 0.006, tau: 0.005, ca: 3.5, thudDb: -10, tickDb: -14 },
  // b: a firmer clap: a shorter puff, a harder contact with the board's slap in it
  b: { trim: 6.5, puff: 0.05, puffLp: 2200, puffTop: 1600, puffDb: -7, modes: [[140, 0.007, 0.28], [260, 0.005, 0.22], [800, 0.003, 0.16], [1400, 0.002, 0.08]],
    contact: [["lowpass", 2400, 0.7]], soft: 0.003, tau: 0.003, ca: 3, thudDb: -10, tickDb: -12 },
  // c: a hush: a longer, softer puff, a muffled contact, one low mode, quieter
  c: { trim: 4.5, puff: 0.15, puffLp: 1000, puffTop: 900, puffDb: -6, modes: [[118, 0.01, 0.32], [250, 0.006, 0.12]],
    contact: [["lowpass", 600, 0.7]], soft: 0.009, tau: 0.007, ca: 4, thudDb: -12, tickDb: -99 },
};

const each = (fn, table) => Object.fromEntries(Object.entries(table).map(([x, s]) => [x, (t, p, o, k) => fn(k, t, p, o || {}, s)]));
export const NOTEBOOK_VOICES = {
  page: each(page, PAGE),
  elastic: each(elastic, ELASTIC),
  "cover-open": each(coverOpen, COVER_OPEN),
  "cover-close": each(coverClose, COVER_CLOSE),
};
