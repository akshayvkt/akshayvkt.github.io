// The music of the room: a generative piece for felt piano, a warm pad and, rarely, a bowed glass, composed for this
// site by its rules below. It never repeats: every phrase is drawn fresh from the rules, and only a few short motifs
// come back, varied. It follows the real moment in San Francisco (the sun's altitude, rising or setting, and the fog),
// and it listens to the city: a phrase never starts over a foghorn's blast.
//
// THE RULES
//
// 1. One home, many lights. Everything is on D, the whole day, so the music never lurches; the time of day changes
//    the mode on that D, the register, the density and the touch:
//      night    (sun below -10 deg)            D aeolian / dorian: low (D3-A4), sparse (a phrase every 9-22 s, 1-3
//                                              notes), slow (1.2 s beats), soft; open fifths, few thirds.
//      dawn     (rising, -10 to +8 deg)        D lydian / ionian: open and light (the raised fourth, G#, floats): high
//                                              (D4-D6), rising activity, arpeggios, the glass appears.
//      day      (sun above +8 deg)             D ionian / mixolydian / lydian: clear, middle register, the most notes
//                                              (a phrase every 4-11 s, 3-6 notes, 0.62 s beats).
//      golden   (setting, -1 to +14 deg)       D ionian with major sevenths and ninths: warm, low-middle (G3-E5), the pad
//                                              fuller.
//      dusk     (setting, -10 to 0 deg)        D dorian (the major IV, G, against the minor tonic: tender), falling lines.
//    Each band has a weight that grows and fades with the sun (bandWeights), so the music passes from one to the next
//    over half an hour or so, as the light does; a phrase's choices are drawn from the blend.
// 2. Harmony moves slowly. A chord lasts 18-60 s (longer at night). The next chord is drawn from the mode's graph
//    (PROGRESSIONS: the strong, gentle moves of each mode, I-IV, I-vi, ii-V, the lydian I-II, the dorian i-IV, the
//    aeolian i-VI-VII); a change of mode happens only by way of its tonic chord (they all share D). Chords are voiced
//    open: a low root, then fifths and ninths before thirds (a felt piano's warmth needs room).
// 3. Phrases breathe. A phrase is a short line (stepwise mostly, a leap now and then, an arch: up then home), a slow
//    broken chord, a dyad, or one low note; then silence, longer than the phrase. Rhythm is a few beat values (1, 1.5,
//    2, 3 beats) with a little rubato and a lengthened last note; the touch rises and falls within the phrase. A third
//    of the phrases answer an earlier one: its contour again, moved to the present chord, its rhythm varied.
// 4. The pad holds the chord under it all, swelling in over several seconds and out again; its filter is darker at
//    night and in fog, more open at dawn and midday.
// 5. Weather: in fog the music is softer and wider (more of the hall, the notes spread across the stereo field,
//    longer silences), and it shares its key with the bridge's horns (D and A, tuned so in city.js).
// 6. Reading: when the visitor reads (the notebook, a sheet, the laptop leaned in) the phrases thin out and soften.
import { piano, padNote, glass } from "./instruments.js";
import { db, clamp, lerp, smooth } from "./dsp.js";

const TONIC = 50;    // D3
export const MODES = {
  ionian: [0, 2, 4, 5, 7, 9, 11], lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 10],
};
// degree (0 = I) -> [[next degree, weight], ...]; diminished chords are left out
export const PROGRESSIONS = {
  ionian: { 0: [[3, 3], [5, 2], [1, 2], [4, 1.2], [2, 1]], 1: [[4, 3], [3, 1.5], [0, 1]], 2: [[5, 2], [3, 2]],
    3: [[0, 3], [1, 1.5], [4, 1.5], [5, 1]], 4: [[0, 3], [5, 2], [3, 1]], 5: [[3, 3], [1, 2], [0, 1]] },
  lydian: { 0: [[1, 4], [4, 2], [5, 1.5], [2, 1]], 1: [[0, 4], [4, 1], [5, 1]], 2: [[5, 2], [1, 1]], 4: [[0, 3], [1, 1]], 5: [[1, 2], [0, 2], [4, 1]] },
  mixolydian: { 0: [[6, 3], [3, 3], [4, 1], [1, 1]], 1: [[6, 2], [3, 1]], 3: [[0, 3], [6, 1]], 4: [[0, 2], [3, 1]], 6: [[3, 2], [0, 3]] },
  dorian: { 0: [[3, 4], [6, 2], [2, 1.5], [4, 1]], 2: [[6, 2], [3, 2]], 3: [[0, 4], [6, 1.5]], 4: [[0, 3]], 6: [[3, 2], [0, 2], [2, 1]] },
  aeolian: { 0: [[5, 3], [3, 3], [6, 2], [2, 1]], 2: [[5, 2], [3, 1]], 3: [[0, 3], [5, 1], [6, 1]], 5: [[3, 2], [6, 2], [0, 2], [2, 1]], 6: [[0, 2], [2, 2], [5, 1]] },
};

// The bands (rule 1). Numbers: register [lo, hi] (MIDI) for the melody, beat (s), gap between phrases [lo, hi] (s),
// notes per phrase [lo, hi], touch (velocity) [lo, hi], chord length [lo, hi] (s), the pad's filter (Hz) and level (dB),
// glass per minute, the hall's send, the bus level (dB), the voicing (which chord tones, in order of preference), the
// phrase kinds' weights [line, arpeggio, dyad, single].
export const BANDS = {
  night: { modes: [["aeolian", 0.65], ["dorian", 0.35]], reg: [50, 69], beat: 1.2, gap: [9, 22], notes: [1, 3], vel: [0.2, 0.34],
    chord: [34, 60], padCut: 420, padDb: -3, glass: 0, hall: 0.55, busDb: -3, voicing: [0, 4, 8, 2], kinds: [0.35, 0.2, 0.2, 0.25] },
  dawn: { modes: [["lydian", 0.6], ["ionian", 0.4]], reg: [62, 86], beat: 0.75, gap: [5, 13], notes: [2, 5], vel: [0.22, 0.4],
    chord: [22, 40], padCut: 1100, padDb: -4, glass: 0.5, hall: 0.5, busDb: -1.5, voicing: [0, 4, 8, 2, 6], kinds: [0.45, 0.35, 0.15, 0.05] },
  day: { modes: [["ionian", 0.6], ["mixolydian", 0.25], ["lydian", 0.15]], reg: [60, 81], beat: 0.62, gap: [4, 11], notes: [3, 6],
    vel: [0.28, 0.48], chord: [18, 34], padCut: 1300, padDb: -6, glass: 0.25, hall: 0.4, busDb: -1, voicing: [0, 2, 4, 8], kinds: [0.55, 0.3, 0.15, 0] },
  golden: { modes: [["ionian", 0.8], ["lydian", 0.2]], reg: [55, 76], beat: 0.8, gap: [5, 12], notes: [3, 6], vel: [0.26, 0.45],
    chord: [20, 36], padCut: 900, padDb: -3, glass: 0.1, hall: 0.48, busDb: 0, voicing: [0, 2, 6, 8, 4], kinds: [0.5, 0.3, 0.2, 0] },
  dusk: { modes: [["dorian", 0.6], ["aeolian", 0.25], ["mixolydian", 0.15]], reg: [57, 76], beat: 0.95, gap: [6, 15], notes: [2, 5],
    vel: [0.22, 0.4], chord: [26, 44], padCut: 700, padDb: -4, glass: 0, hall: 0.52, busDb: -1, voicing: [0, 4, 6, 8, 2], kinds: [0.55, 0.2, 0.15, 0.1] },
};

// Weights of the bands at a sun altitude (deg), rising or setting: overlapping, so the music crosses from one to the
// next over ~5 degrees of sun (20-30 minutes).
export function bandWeights(alt, rising) {
  const w = {
    night: 1 - smooth(-12, -8, alt),
    dawn: rising ? smooth(-12, -8, alt) * (1 - smooth(6, 12, alt)) : 0,
    day: smooth(6, 12, alt) * (rising ? 1 : smooth(10, 16, alt)),
    golden: rising ? 0 : smooth(-2, 1, alt) * (1 - smooth(10, 16, alt)),
    dusk: rising ? 0 : smooth(-12, -8, alt) * (1 - smooth(-2, 1, alt)),
  };
  const s = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  for (const k in w) w[k] /= s;
  return w;
}
// a number from the blend (band key -> value)
const blend = (w, f) => Object.entries(w).reduce((a, [k, x]) => a + x * f(BANDS[k]), 0);

export function createComposer(eng, out) {
  const r = eng.rnd;
  let mode = "ionian", degree = 0, chordEnd = 0, chordMidi = [], nextPhrase = 0, lastNote = 64;
  let padVoices = [], lfo = null, glassUntil = 0;
  const motifs = [];            // [{ steps: [scale steps], rhythm: [beats] }]
  const log = eng.log;

  function pick(w, key) {         // a discrete choice (a band's list) by the blend's weights
    const pairs = [];
    for (const [b, x] of Object.entries(w)) for (const [v, y] of BANDS[b][key]) pairs.push([v, x * y]);
    return r.weighted(pairs);
  }
  const scale = () => MODES[mode];
  // MIDI note of scale degree d (any integer; 7 = an octave up) on the tonic
  const deg = (d, base = TONIC) => { const s = scale(), o = Math.floor(d / 7), i = ((d % 7) + 7) % 7; return base + 12 * o + s[i]; };
  // the scale's notes within [lo, hi]
  const notesIn = (lo, hi) => { const out = []; for (let d = -14; d < 35; d++) { const m = deg(d); if (m >= lo && m <= hi) out.push(m); } return out; };

  function newChord(m, t) {
    const w = m.w;
    const want = pick(w, "modes");
    if (!chordMidi.length || want !== mode) { mode = want; degree = 0; }   // it begins on the tonic; a change of mode goes by way of it
    else {
      const g = PROGRESSIONS[mode][degree] || PROGRESSIONS[mode][0];
      degree = r.weighted(g);
    }
    const voicing = BANDS[Object.entries(w).sort((a, b) => b[1] - a[1])[0][0]].voicing;
    // the chord: root low (D2-C3), then the voicing's tones stacked upward and kept between A2 and C5, open spacing
    const root = deg(degree, TONIC - 12);
    const tones = [root];
    for (const v of voicing.slice(1)) {
      // each tone the nearest of its pitch class above the last: at least a fifth away below E3 (low thirds are mud),
      // a minor third above it (open voicings, never a cluster)
      const last = tones[tones.length - 1], pc = deg(degree + v, TONIC) % 12, gap = last < 52 ? 7 : 3;
      let mm = last + ((pc - last) % 12 + 12) % 12;
      while (mm < last + gap) mm += 12;
      if (mm <= 76) tones.push(mm);
    }
    chordMidi = tones;
    const len = r.range(blend(w, (b) => b.chord[0]), blend(w, (b) => b.chord[1]));
    chordEnd = t + len;
    log?.("chord", t, { mode, degree, notes: tones, len: +len.toFixed(1) });
    // the bass: the new chord's root, low and soft, most of the time (the felt piano's left hand)
    if (r.chance(0.75)) {
      const bt = m.hold ? m.hold(t + r.range(0.2, 0.8), 3) : t + 0.5;
      piano(eng, { t: bt, midi: root, vel: r.range(0.16, 0.26) * (m.reading ? 0.9 : 1), dur: r.range(4, 7), pan: -0.18 * m.width, level: db(m.pianoDb), out, sends: m.sends });
    }
    // the pad: fades the old chord out as the new one swells in
    const cut = blend(w, (b) => b.padCut) * (m.fog ? lerp(1, 0.78, m.fog) : 1);
    const lvl = db(m.padDb + blend(w, (b) => b.padDb) + (m.fog ? 1.5 * m.fog : 0));
    for (const pv of padVoices) { try { pv.out.gain.cancelScheduledValues(t); pv.out.gain.setTargetAtTime(0, t, 2.2); } catch { /* ended */ } }
    padVoices = [];
    if (!lfo || lfo.done) {
      lfo = { done: false };
      const { ctx } = eng;
      const o = ctx.createOscillator(); o.frequency.value = 0.19;
      const g = ctx.createGain(); g.gain.value = 3.5;
      o.connect(g); o.start(t);
      lfo.node = g; lfo.osc = o;
      eng.onStop(() => { try { o.stop(); o.disconnect(); g.disconnect(); } catch { /* */ } lfo.done = true; });
    }
    const padTones = tones.filter((x) => x >= 45 && x <= 69).slice(0, 4);
    if (padTones.length < 2) padTones.push(tones[0] + 12);
    padTones.forEach((mm, i) => {
      padVoices.push(padNote(eng, {
        t: t + i * 0.6, midi: mm, attack: r.range(5, 8), hold: Math.max(4, len - 6), release: r.range(7, 10), level: lvl / Math.sqrt(padTones.length),
        cutoff: cut, pan: (i / Math.max(1, padTones.length - 1) - 0.5) * 0.8 * m.width, lfo: lfo.node, out, sends: m.sends,
      }));
    });
  }

  // one phrase: a list of notes [{ at (s from start), midi, vel, dur }]
  function compose(m) {
    const w = m.w;
    const reg = [Math.round(blend(w, (b) => b.reg[0])), Math.round(blend(w, (b) => b.reg[1]))];
    const beat = blend(w, (b) => b.beat) * (m.reading ? 1.15 : 1);
    const nLo = blend(w, (b) => b.notes[0]), nHi = blend(w, (b) => b.notes[1]);
    let n = Math.max(1, Math.round(r.range(nLo, nHi + 0.99) - 0.49));
    const vel = [blend(w, (b) => b.vel[0]), blend(w, (b) => b.vel[1])].map((x) => x * (m.fog ? lerp(1, 0.86, m.fog) : 1) * (m.reading ? 0.9 : 1));
    const kinds = [0, 1, 2, 3].map((i) => blend(w, (b) => b.kinds[i]));
    let kind = r.weighted([["line", kinds[0]], ["arp", kinds[1]], ["dyad", kinds[2]], ["single", kinds[3]]]);
    const pool = notesIn(reg[0], reg[1]);
    const chordPcs = new Set(chordMidi.map((x) => x % 12));
    const isChord = (x) => chordPcs.has(x % 12);
    // start near the last note (voice leading), on a chord tone
    const near = pool.filter(isChord).sort((a, b) => Math.abs(a - lastNote) - Math.abs(b - lastNote));
    let i0 = pool.indexOf(near[Math.min(near.length - 1, r.int(0, 2))] ?? pool[Math.floor(pool.length / 2)]);
    const notes = [];
    const rhythmSets = [[1, 1, 2], [1.5, 0.5, 2], [2, 1, 1, 3], [1, 1, 1, 3], [1, 2, 1, 2], [2, 2, 3], [1.5, 1.5, 1, 3]];
    let answer = null;
    if (kind === "line" && motifs.length && r.chance(0.32)) { answer = r.pick(motifs); n = answer.steps.length + 1; }
    const rhythm = answer ? answer.rhythm.map((x) => x * r.pick([1, 1, 1.5, 0.75])) : r.pick(rhythmSets);
    const dur = (k) => rhythm[k % rhythm.length] * beat * (1 + r.gauss() * 0.06) * (k === n - 1 ? 1.25 : 1);
    if (kind === "single") {
      const low = notesIn(reg[0] - 12, reg[0] + 5).filter(isChord);
      const mm = low.length ? r.pick(low) : pool[0];
      notes.push({ at: 0, midi: mm, vel: r.range(vel[0], vel[1]) * 0.9, dur: beat * r.range(3, 5) });
    } else if (kind === "dyad") {
      const a = pool[clamp(i0, 0, pool.length - 1)];
      const up = pool.filter((x) => x > a + 2 && x <= a + 9 && isChord(x));
      const b = up.length ? r.pick(up) : a + 7;
      const v = r.range(vel[0], vel[1]);
      const roll = r.range(0.02, 0.09);                     // a slightly rolled dyad, lower note first
      notes.push({ at: 0, midi: a, vel: v * 0.92, dur: beat * 3.5 }, { at: roll, midi: b, vel: v * 0.8, dur: beat * 3.4 });
      if (r.chance(0.5)) notes.push({ at: beat * 2.5, midi: pool[clamp(pool.indexOf(b) + r.pick([-1, 1]), 0, pool.length - 1)], vel: v * 0.7, dur: beat * 3 });
    } else if (kind === "arp") {
      const tones = pool.filter(isChord);
      let j = tones.indexOf(pool[i0]);
      if (j < 0) j = Math.floor(tones.length / 2);
      const dir = r.chance(0.7) ? 1 : -1;
      if (dir > 0) j = Math.max(0, Math.min(j, tones.length - n));
      let at = 0;
      for (let k = 0; k < n && tones[j + k * dir] !== undefined; k++) {
        const v = r.range(vel[0], vel[1]) * (0.85 + 0.25 * Math.sin((Math.PI * k) / Math.max(1, n - 1)));
        notes.push({ at, midi: tones[j + k * dir], vel: v, dur: beat * (2.5 + (n - k)) });   // held: a pedalled arpeggio
        at += dur(k) * 0.8;
      }
    } else {
      // a line: steps on the scale, mostly by step, an arch, home on a chord tone; or an answer's steps
      const steps = [];
      let at = 0, i = i0;
      const half = (n - 1) / 2;
      for (let k = 0; k < n; k++) {
        const mm = pool[clamp(i, 0, pool.length - 1)];
        const v = r.range(vel[0], vel[1]) * (0.85 + 0.25 * Math.sin((Math.PI * k) / Math.max(1, n - 1))) * (k === n - 1 ? 0.88 : 1);
        notes.push({ at, midi: mm, vel: v, dur: dur(k) * 1.6 });
        at += dur(k);
        if (k === n - 1) break;
        let s;
        if (answer) s = answer.steps[k];
        else {
          const upward = k < half ? 0.62 : 0.36;             // the arch
          const dusk = (w.dusk || 0) * 0.12;                  // dusk's lines lean downward
          const size = r.weighted([[1, 0.62], [2, 0.24], [3, 0.09], [4, 0.05]]);
          s = (r.chance(upward - dusk) ? 1 : -1) * size;
          if (k === n - 2) {                                  // the penultimate step goes to the nearest chord tone
            const cands = [-2, -1, 1, 2].filter((d) => pool[i + d] !== undefined && isChord(pool[i + d]));
            if (cands.length) s = cands.sort((a, b) => Math.abs(a) - Math.abs(b))[0];
          }
        }
        // at the register's edge the line turns back (never the same note three times)
        if (i + s < 0 || i + s > pool.length - 1) s = -s;
        if (k >= 1 && s === 0) s = r.chance(0.5) ? 1 : -1;
        steps.push(s);
        i = clamp(i + s, 0, pool.length - 1);
      }
      if (!answer && steps.length >= 2) { motifs.push({ steps, rhythm: rhythm.slice() }); if (motifs.length > 6) motifs.shift(); }
      // a left-hand note under the first note, sometimes
      if (r.chance(0.4)) {
        const lh = notesIn(Math.max(38, notes[0].midi - 19), notes[0].midi - 7).filter(isChord);
        if (lh.length) notes.push({ at: 0.01, midi: r.pick(lh), vel: notes[0].vel * 0.7, dur: beat * 4 });
      }
    }
    const last = notes.reduce((a, x) => (x.at >= a.at ? x : a), notes[0]);
    lastNote = last.midi;
    const length = notes.reduce((a, x) => Math.max(a, x.at + x.dur), 0);
    return { kind: answer ? "answer" : kind, notes, length };
  }

  return {
    get chord() { return { mode, degree, notes: chordMidi }; },
    // Schedule what starts before `until` (context time). m: the mood (engine.js moodAt): { w, fog, reading, width,
    // sends, padDb, hold(t, len) -> the time a phrase of len seconds may start at or after t (the city's horns) }.
    schedule(now, until, m) {
      if (now >= chordEnd - 0.5 || !chordMidi.length) newChord(m, Math.max(now, chordEnd));
      if (!nextPhrase) nextPhrase = now + r.range(1.5, 3.5);
      while (nextPhrase < until) {
        let t = nextPhrase;
        const ph = compose(m);
        t = m.hold ? m.hold(t, ph.length) : t;
        if (t >= until + 4) { nextPhrase = t; break; }
        for (const x of ph.notes) {
          const midi = x.midi;
          const pan = clamp(((midi - 64) / 24) * m.width + r.range(-0.1, 0.1), -0.85, 0.85);
          piano(eng, { t: t + x.at, midi, vel: clamp(x.vel, 0.05, 0.9), dur: x.dur, pan, level: db(m.pianoDb), out, sends: m.sends });
        }
        log?.("phrase", t, { kind: ph.kind, notes: ph.notes.length, midi: ph.notes.map((x) => x.midi), len: +ph.length.toFixed(2) });
        const gap = r.range(blend(m.w, (b) => b.gap[0]), blend(m.w, (b) => b.gap[1])) * (m.fog ? lerp(1, 1.25, m.fog) : 1) * (m.reading ? 1.3 : 1);
        nextPhrase = t + ph.length + gap;
        if (t > chordEnd) newChord(m, t);
      }
      // the glass, now and then (a Poisson chance over the stretch of time newly covered since the last call)
      const gpm = blend(m.w, (b) => b.glass) * (m.reading ? 0.5 : 1);
      const span = Math.max(0, until - Math.max(now, glassUntil));
      glassUntil = Math.max(glassUntil, until);
      if (gpm > 0 && r.chance((gpm / 60) * span)) {
        const hi = notesIn(81, 93).filter((x) => chordMidi.some((c) => c % 12 === x % 12));
        if (hi.length) {
          const t = now + r.range(0.5, 2);
          glass(eng, { t, midi: r.pick(hi), dur: r.range(2, 4), level: db(m.glassDb), pan: r.range(-0.6, 0.6) * m.width, out, sends: m.sends });
          log?.("glass", t, {});
        }
      }
    },
    // the chord changes at once (a jump in time): the pad crossfades to the new moment's harmony
    reset(now) { chordEnd = now; },
    stopPad(t) { for (const pv of padVoices) { try { pv.out.gain.cancelScheduledValues(t); pv.out.gain.setTargetAtTime(0, t, 1); } catch { /* */ } } padVoices = []; },
  };
}
