// The performance box (DYS-149 / DYS-151 / DYS-183): a small box of numbers over the page, for a screen recording on a
// phone, where the Mac can't measure (WebKit there has no GPU timer and its frames sit at 17 ms) and Web Inspector isn't
// to hand.
//
// How to use it (Akshay, on the iPhone):
//   1. Open https://akshaychintalapati.com/?hud=1 (or add &hud=1 to any other link, e.g. DYS-183's). A small dark box
//      shows at the top left; it stays for the visit, on every page, until the tab is closed (?hud=0 turns it off).
//   2. Start the screen recording, then do the moves one at a time with a second's pause between them (a glide desk ->
//      window -> shelves, a pinch at the window, a page turn). The box names each move ("#3 glide desk>window") with
//      its numbers, and keeps them on screen until the next move starts.
//   3. Stop the recording and send it. Or tap "copy" on the box and paste into a note: the last minute, frame by frame.
//
// What it shows (updated 4 times a second):
//   60 fps · 58 drawn · T1       the page's frames in the last second (the browser's animation frames), how many of
//                                them the 3D drew, and the engine's tier
//   worst 2s 34 ms · 804x1748    the longest gap between two frames in the last 2 s; the size the room is drawn at
//   moving                       the engine's state (moving / refining n of N samples / settled)
//   scale .80 pin · used         the moving scale (engine.movingScale): its value, pinned by ?mvscale or learned, "used"
//                                when the last drawn frame was drawn at it; "out .80" the outside's (DYS-183) when on
//   cpu 6.2 avg · 11 max ms      the engine's draw on the main thread, last second (its whole _frame: script and the GL
//                                calls' submission; WebKit rounds the clock to 1 ms, so the average is the honest one)
//   gpu n/a · heap n/a           the GPU's time per frame (EXT_disjoint_timer_query_webgl2: none on iPhone Safari), the
//                                script heap (Chrome only)
//   window · zoom 2.31x          where the camera is (the router's spot) and the magnification (the rig's)
//   ▶ #7 glide desk>window       the move under way (▶) or the last one (·): glide a>b, pinch, pan, drag, zoom, page
//                                turn, ease, move (the room moving otherwise), boot
//   n54 · worst 41 ms            that move's frames and its longest frame gap
//   >16.7 4% · >33 0%            its share of frames that missed a 60 Hz frame (a gap over 1.5 x 16.7 ms: one refresh or
//                                more missed) and of those that missed two or more (a gap over 2.5 x 16.7 ms); the same
//                                "late" as the beacon's (shared/beacon.js LATE) and the moving scale's
//
// Turned on by ?hud=1 (router.js HUD: kept in sessionStorage for the visit, so the page documents keep it; ?hud=0 ends
// it); only then is this file asked for (import() in router.js boot), so a visit without it fetches and runs none of it.
// Its cost when on: one animation-frame callback of its own (a time and a gap into a fixed array), at each drawn frame a
// few numbers into fixed arrays (two clock reads, the rig's fields read, no allocation, no layout read), and one text
// change of its box every 250 ms (a fixed box on its own layer, contain: content). The engine's _frame is wrapped while it
// is on, to time it (the "beforeframe" event comes after the close-up tier's upload step); nothing changes when it's off.
//
// "copy" puts the last 60 s on the clipboard as JSON: { cols, frames: [[t, dt, cpu, end, gpu, state, scale, seg,
// counted], ...], segs: [{ id, label, t0, t1, n, p50, max, over16, over33, cpuAvg, cpuMax }], stalls: [[t, gap]] }.
// t: the frame's time (ms from the page's start); dt: the gap since the animation frame before it (the engine's own
// mv.delta, the gap the moving scale counts as late); cpu: its draw on the main thread; end: from the frame's start to
// its draw done (other callbacks before the engine's included); gpu: null without the timer; state: m / r / s; seg: the
// move it is in (0: none); counted: in that move's numbers. stalls: every gap of the page's own frames over 25 ms, drawn
// or not (a stall with the room still, e.g. a page being put in). Without a clipboard the box lists the last moves'
// numbers in short instead, for the recording.
//
// (DYS-216) The boot, for where a first visit's seconds go on a real phone (the Mac's WebKit is ~3x faster there):
//   boot still 2.5 · shown 11.4 · live 11.9 s   the desk's photograph (app.js "sky:reveal"), the 3D on screen (router.js
//                                "sfw:room-shown") and the hand-off done ("sfw:ht-handoff"), s from the navigation's start
//   js 1.2 glb 2.1 lt .8 cp 3.0 up .4 wm .6   the engine's own steps (engine.timings), s each: js its modules in (module,
//                                from the start), glb the model and its pictures (modelAndLut), lt the light maps
//                                (staticLayers), cp the programs (compileAll), up the maps sent after them (warmMaps less
//                                compileAll), wm the first frames and the moment's light (warmFrames + warmLight)
//   files 231 · 9.8 MB · last 10.2 s   the files in by the 3D on screen (Resource Timing), their bytes, the last one's end
//   stalls 14 · 3.1 s · worst 820 ms   the page's frame gaps over 50 ms from the box's start to the hand-off (the main
//                                thread busy: script, a picture decoded or sent, a program built), their sum, the longest
// copy's JSON gains, as its LAST key (a paste cut at its start keeps it), boot: { marks, timings, steps: [[ms, step]]
// (the engine's and the router's boot steps as each started: engine.bootSteps, read from the router's bootEngine
// before this.engine is set), seen: { step: ms first seen here (polled every 50 ms) }, states: [[t, the
// engine's state]], gaps: [[t, gap]] (every gap over 50 ms to the hand-off + 1 s), files: [[path, start, responseStart,
// end, transfer bytes, body bytes, initiator]] }, kept whole however late "copy" is tapped.

export const LATE16 = 16.7 * 1.5;   // a gap that missed a 60 Hz frame (one refresh or more): beacon.js LATE, perf_lib LATE_60
export const LATE33 = 16.7 * 2.5;   // a gap that missed two or more (over 33 ms with half a refresh's margin)
export const SEG_GAP = 300;         // ms: a move's frames with less than this between them are one move (a slow drag's pauses)
export const KEEP_MS = 60000;       // ms: what "copy" gives
const PAUSE = 5000;                 // ms: a gap this long is the page put away, not a frame (beacon.js PAUSE)
const CAP = 8192;                   // drawn frames kept (over 60 s at 120 Hz)
const RCAP = 1024;                  // the page's own animation frames kept (the last 2 s is all that's read)
const SEGS = 300;                   // moves kept
const STATES = { settled: 0, refining: 1, moving: 2 };
const STATE_CH = "srm?";
// labels that carry on the move already under way rather than start one: a pinch's or a wheel's zoom easing on after the
// fingers leave, a spring back after a drag, the room's camera moving on after a glide lands
const CONT = new Set(["zoom", "ease", "move"]);

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

/**
 * The move under way, from the rig's and the engine's fields (no layout read): "" when nothing moves.
 * rig: the router's Rig (shared/rig.js); turning: the notebook's page turn animating (pageturn.js "pageturn" pass);
 * fingers: touches down now; pinched: two fingers have been down since the first touch of this gesture.
 */
export function gestureOf({ state = "", outsideMoving = false, rig = null, turning = false, fingers = 0, pinched = false, mode = "live" } = {}) {
  if (mode === "booting") return state === "moving" ? "boot" : "";
  if (rig?.glide) return `glide ${rig.from || "?"}>${rig.glide.to}`;
  // (zoomed, a glide first eases back to 1x: rig.glideTo's zoomEase, its `to` the glide's spot; alone, a reset to 1x)
  if (rig?.zoomEase) return rig.zoomEase.to ? `glide >${rig.zoomEase.to}` : "zoom out";
  if (turning) return "page turn";
  if (pinched || fingers >= 2) return "pinch";
  if (rig?.dragging) return rig.look ? "pan" : "drag";
  if (rig?.zooming) return "zoom";
  if (rig?.ease) return "ease";
  if (state === "moving" || outsideMoving) return "move";
  return "";
}

/** The numbers: the drawn frames, the page's own animation frames and the moves, in fixed arrays. No DOM. */
export class Meter {
  constructor() {
    this.T = new Float64Array(CAP);     // the frame's time (its animation frame's)
    this.DT = new Float32Array(CAP);    // the gap since the animation frame before
    this.CPU = new Float32Array(CAP);   // the draw on the main thread
    this.END = new Float32Array(CAP);   // from the frame's start to its draw done
    this.GPU = new Float32Array(CAP).fill(NaN);
    this.ST = new Uint8Array(CAP);
    this.SC = new Float32Array(CAP);    // the scale it was drawn at (1: whole)
    this.SEG = new Int32Array(CAP);
    this.OK = new Uint8Array(CAP);      // counted in its move's numbers
    this.n = 0;
    this.RT = new Float64Array(RCAP);
    this.RG = new Float32Array(RCAP);   // NaN: not a frame's gap (the first, or after a pause)
    this.rn = 0;
    this.lastRaf = 0;
    this.stalls = [];
    this.segs = [];
    this.open = null;
    this.ids = 0;
  }

  /** One of the page's animation frames (the HUD's own loop). */
  raf(t) {
    const gap = this.lastRaf && t - this.lastRaf < PAUSE ? t - this.lastRaf : NaN;
    this.lastRaf = t;
    const i = this.rn++ % RCAP;
    this.RT[i] = t;
    this.RG[i] = gap;
    if (gap > LATE16) { this.stalls.push([r1(t), r1(gap)]); if (this.stalls.length > 4000) this.stalls.splice(0, 1000); }
  }

  /** The page was hidden: the next animation frame's gap is not a frame's. */
  pause() { this.lastRaf = 0; }

  /**
   * One drawn frame. tick: drawn by the engine's animation-frame loop (not a warm-up or a synchronous draw), so dt is
   * a presented frame's gap. label: gestureOf()'s.
   */
  frame(t, dt, cpu, end, st, scale, label, tick) {
    let s = this.open;
    if (s && t - s.last > SEG_GAP) { this.close(); s = null; }
    if (label) {
      if (!s || !(label === s.label || CONT.has(label))) { this.close(); s = this.start(label, t); }
      s.last = t;
    }
    const ok = !!label && tick && dt > 0 && dt < PAUSE;
    if (ok) {
      s.n++; s.sum += dt;
      if (dt > s.max) s.max = dt;
      if (dt > LATE16) s.o16++;
      if (dt > LATE33) s.o33++;
      if (cpu >= 0) { s.cpuSum += cpu; s.cpuN++; if (cpu > s.cpuMax) s.cpuMax = cpu; }
    }
    const i = this.n++ % CAP;
    this.T[i] = t; this.DT[i] = dt; this.CPU[i] = cpu; this.END[i] = end; this.GPU[i] = NaN;
    this.ST[i] = st; this.SC[i] = scale; this.SEG[i] = label && s ? s.id : 0; this.OK[i] = ok ? 1 : 0;
  }

  /** A frame's GPU time, a few frames late (the engine's "gputime" event: its frame's time). */
  gpu(t, ms) {
    for (let k = this.n - 1; k >= 0 && k >= this.n - 32; k--) {
      const i = k % CAP;
      if (this.T[i] === t) { this.GPU[i] = ms; return; }
    }
  }

  start(label, t) {
    const s = { id: ++this.ids, label, t0: t, last: t, n: 0, sum: 0, max: 0, o16: 0, o33: 0, cpuSum: 0, cpuN: 0, cpuMax: 0, done: false };
    this.segs.push(s);
    if (this.segs.length > SEGS) this.segs.shift();
    this.open = s;
    return s;
  }

  close() { if (this.open) { this.open.done = true; this.open = null; } }

  /** A move with no frame for SEG_GAP has ended (the engine draws nothing at rest, so no frame says so). */
  idle(now) { if (this.open && now - this.open.last > SEG_GAP) this.close(); }

  /** The box's numbers at `now`. */
  stats(now) {
    let fps = 0, worst = 0;
    for (let k = this.rn - 1; k >= 0 && k > this.rn - RCAP; k--) {
      const i = k % RCAP, t = this.RT[i];
      if (now - t > 2000) break;
      if (now - t <= 1000) fps++;
      if (this.RG[i] > worst) worst = this.RG[i];
    }
    let drawn = 0, cs = 0, cn = 0, cm = 0, gs = 0, gn = 0, gm = 0;
    for (let k = this.n - 1; k >= 0 && k > this.n - CAP; k--) {
      const i = k % CAP;
      if (now - this.T[i] > 1000) break;
      drawn++;
      const c = this.CPU[i], g = this.GPU[i];
      if (c >= 0) { cs += c; cn++; if (c > cm) cm = c; }
      if (g >= 0) { gs += g; gn++; if (g > gm) gm = g; }
    }
    const last = this.n ? (this.n - 1) % CAP : -1;
    return { fps, worst, drawn, cpuAvg: cn ? cs / cn : NaN, cpuMax: cn ? cm : NaN, gpuAvg: gn ? gs / gn : NaN, gpuMax: gn ? gm : NaN,
      scale: last >= 0 ? this.SC[last] : 1, seg: this.open || this.segs[this.segs.length - 1] || null };
  }

  /** A move's numbers, short (the box's list when there is no clipboard; the JSON's segs). */
  static short(s) {
    const pct = (k) => (s.n ? Math.round((100 * k) / s.n) : 0);
    return `#${s.id} ${s.label} n${s.n} max ${Math.round(s.max)} >16 ${pct(s.o16)}% >33 ${pct(s.o33)}%`;
  }

  /** The last KEEP_MS as JSON-ready data. info: what the page says about itself (device, tier, the moving scale). */
  dump(now, info = {}) {
    const frames = [], byId = new Map();
    for (let k = Math.max(0, this.n - CAP); k < this.n; k++) {
      const i = k % CAP, t = this.T[i];
      if (now - t > KEEP_MS) continue;
      const g = this.GPU[i], sc = this.SC[i];
      frames.push([r1(t), r1(this.DT[i]), r1(this.CPU[i]), r1(this.END[i]), g >= 0 ? r2(g) : null, STATE_CH[this.ST[i]] || "?",
        sc >= 1 || !(sc > 0) ? 1 : r2(sc), this.SEG[i], this.OK[i]]);
      if (this.OK[i]) { const id = this.SEG[i]; (byId.get(id) || byId.set(id, []).get(id)).push(this.DT[i]); }
    }
    const segs = this.segs.filter((s) => now - s.last <= KEEP_MS).map((s) => {
      const d = (byId.get(s.id) || []).slice().sort((a, b) => a - b);
      return { id: s.id, label: s.label, t0: r1(s.t0), t1: r1(s.last), done: s.done, n: s.n, p50: d.length ? r1(d[Math.round(0.5 * (d.length - 1))]) : null,
        max: r1(s.max), over16: s.o16, over33: s.o33, cpuAvg: s.cpuN ? r1(s.cpuSum / s.cpuN) : null, cpuMax: r1(s.cpuMax) };
    });
    return { v: 1, what: "sf-window ?hud=1 (DYS-149): the last minute's frames", ...info,
      thresholds: { over16: r1(LATE16), over33: r1(LATE33), segGap: SEG_GAP },
      cols: ["t", "dt", "cpu", "end", "gpu", "state", "scale", "seg", "counted"], frames, segs,
      stalls: this.stalls.filter((s) => now - s[0] <= KEEP_MS) };
  }
}

/**
 * Listen to an engine (shared/gl/engine.js): its "frame" events (each drawn frame), "gputime" (where the timer is), its
 * mv.delta (the gap since the animation frame before, the engine's own) and its _frame timed from outside.
 * label(): the move under way (gestureOf). Returns the frame's start setter for tests.
 */
export function attach(eng, meter, label) {
  let start = 0;
  // (DYS-149: the engine's _frame timed from outside while the box is on: its whole draw, the close-up tier's upload step
  // included, which the "beforeframe" event comes after; the engine's _tick and essay-lift.js's direct draw both call
  // this._frame / engine._frame, so both come through here)
  const own = typeof eng._frame === "function" ? eng._frame : null;
  if (own) eng._frame = function hudFrame(...a) { start = performance.now(); return own.apply(this, a); };
  else eng.on("beforeframe", () => { start = performance.now(); });
  eng.on("frame", (f) => {
    const now = performance.now(), m = eng.mv;
    const tick = m ? m.lastTick === f.time : true;
    const dt = m && tick ? m.delta : f.dt;
    // the scale this frame was drawn at: the room's moving scale, or (DYS-183 mv-outside, where it is) the outside's
    const sc = m?.active ? m.scale : m?.out && typeof eng._mvOutScale === "function" ? eng._mvOutScale() : 1;
    meter.frame(f.time, dt, start ? now - start : NaN, now - f.time, STATES[eng.state] ?? 3, sc, label(), tick);
    start = 0;
  });
  if (eng.gpuTiming) eng.on("gputime", (g) => meter.gpu(g.time, g.ms));
}

// ---- (DYS-216) the boot: the marks, the engine's steps, the files, the page's stalls until the hand-off
export const BOOT_MARKS = { still: "sky:reveal", responds: "sfw:room-responds", shown: "sfw:room-shown", live: "sfw:ht-handoff" };
export const BOOT_GAP = 50;       // ms: a frame gap counted as a stall in the boot
export const BOOT_POLL = 50;      // ms between looks at the engine's steps, until the hand-off + BOOT_TAIL
export const BOOT_TAIL = 1000;    // ms after the hand-off the boot's record goes on (the pull back's first frames)
export const BOOT_MAX = 90000;    // ms: a boot that never hands off stops being recorded here

/** The boot's marks, ms from the navigation's start (left out: not yet). */
export function bootMarks(perf = performance) {
  const o = {};
  for (const [k, n] of Object.entries(BOOT_MARKS)) {
    const e = perf.getEntriesByName?.(n, "mark")?.[0];
    if (e) o[k] = Math.round(e.startTime);
  }
  return o;
}

/** The files so far: [path (another origin's with its host), start, responseStart, end, transfer bytes, body bytes,
 *  initiator], ms from the navigation's start. */
export function bootFiles(perf = performance, origin = globalThis.location?.origin) {
  return (perf.getEntriesByType?.("resource") || []).map((r) => {
    let p = r.name;
    try { const u = new URL(r.name); p = u.origin === origin ? u.pathname : u.host + u.pathname; } catch { /* as named */ }
    return [p, Math.round(r.startTime), Math.round(r.responseStart), Math.round(r.responseEnd), r.transferSize || 0, r.encodedBodySize || 0, r.initiatorType || ""];
  });
}

/** (DYS-216, F: whether the browser compiles shaders in parallel, which decides where a cold compile's wait lands) the
 *  context's KHR_parallel_shader_compile and its renderer string where the browser gives it; null without a context. */
export function bootGL(gl) {
  if (!gl || typeof gl.getSupportedExtensions !== "function") return null;
  try {
    const ext = gl.getSupportedExtensions() || [], dbg = ext.includes("WEBGL_debug_renderer_info") ? gl.getExtension("WEBGL_debug_renderer_info") : null;
    return { parallelCompile: ext.includes("KHR_parallel_shader_compile"), renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null, ext: ext.length };
  } catch { return null; }
}

/** The box's boot lines from the marks, the engine's timings (or null), the files and the stalls ([[t, gap]]). */
export function bootLines(m, t, files, gaps) {
  const s = (x) => (x >= 0 ? (x / 1000).toFixed(1).replace(/^0\./, ".") : "-");
  const L = [`boot still ${s(m.still)} · shown ${s(m.shown)} · live ${s(m.live)} s`];
  if (t) {
    const up = t.warmMaps >= 0 && t.compileAll >= 0 ? t.warmMaps - t.compileAll : NaN;
    const warm = t.warmFrames >= 0 ? t.warmFrames + (t.warmLight || 0) : NaN;
    L.push(`js ${s(t.module)} glb ${s(t.modelAndLut)} lt ${s(t.staticLayers)} cp ${s(t.compileAll)} up ${s(up)} wm ${s(warm)}`);   // (<= 42 characters: a phone's box)
  }
  const by = m.shown ?? Infinity, inBy = files.filter((f) => f[3] > 0 && f[3] <= by);
  const mb = inBy.reduce((a, f) => a + (f[4] || f[5]), 0) / 1e6;
  L.push(`files ${inBy.length} · ${mb.toFixed(1)} MB · last ${s(inBy.length ? Math.max(...inBy.map((f) => f[3])) : NaN)} s`);
  const g = gaps.filter((x) => m.live == null || x[0] <= m.live);
  L.push(`stalls ${g.length} · ${s(g.reduce((a, x) => a + x[1], 0))} s · worst ${Math.round(Math.max(0, ...g.map((x) => x[1])))} ms`);
  return L;
}

/** The boot's record while the box is on: look() every BOOT_POLL ms (the engine's steps as they come, its state), raf(t)
 *  at each of the page's animation frames (the stalls); done once the hand-off is BOOT_TAIL ms past, or at BOOT_MAX. */
export class BootLog {
  constructor() { this.seen = {}; this.states = []; this.gaps = []; this.last = 0; this.done = false; }
  raf(t) {
    if (this.done) return;
    if (this.last && t - this.last > BOOT_GAP) this.gaps.push([Math.round(this.last), Math.round(t - this.last)]);
    this.last = t;
  }
  look(now, eng, marks) {
    if (this.done) return;
    if (eng && this.seen.engine == null) this.seen.engine = Math.round(now);
    for (const k of Object.keys(eng?.timings || {})) if (this.seen[k] == null) this.seen[k] = Math.round(now);
    const st = eng?.state;
    if (st && st !== this.states[this.states.length - 1]?.[1]) this.states.push([Math.round(now), st]);
    if ((marks.live != null && now > marks.live + BOOT_TAIL) || now > BOOT_MAX) this.done = true;
  }
  dump(eng, perf = performance) {
    return { marks: bootMarks(perf), timings: eng?.timings || null, steps: eng?.bootSteps || null, gl: bootGL(eng?.gl), seen: this.seen, states: this.states, gaps: this.gaps, files: bootFiles(perf) };
  }
}

const BOX_CSS = "position: fixed; z-index: 2147483000; top: max(8px, env(safe-area-inset-top)); left: calc(env(safe-area-inset-left, 0px) + 36px);" +
  "pointer-events: none; contain: content; transform: translateZ(0); background: rgba(0, 0, 0, 0.64); color: #fff;" +
  "border-radius: 6px; padding: 5px 8px 6px; font: 500 11px/1.32 ui-monospace, SFMono-Regular, Menlo, monospace;" +
  "-webkit-text-size-adjust: none; text-size-adjust: none; text-shadow: none; max-width: calc(100vw - 52px); overflow: hidden;";
const BTN_CSS = "pointer-events: auto; display: block; margin-top: 5px; padding: 5px 14px; font: inherit; color: #fff;" +
  "background: rgba(255, 255, 255, 0.16); border: 1px solid rgba(255, 255, 255, 0.4); border-radius: 4px;" +
  "touch-action: manipulation; -webkit-tap-highlight-color: transparent; cursor: pointer;";

let installed = null;

/** Show the box (once per document). nav: the router (engine, rig, spot, mode); without it, the page's frames alone. */
export function install(nav = null) {
  if (installed) return installed;
  const meter = new Meter();
  const boot = new BootLog();
  // (DYS-216: every file of the boot in Resource Timing: a first visit is ~270, the browser keeps 250 by default)
  try { performance.setResourceTimingBufferSize(2000); } catch { /* an old browser: the first 250 */ }
  const box = document.createElement("div");
  box.className = "sfw-hud";
  box.setAttribute("aria-hidden", "true");
  box.style.cssText = BOX_CSS;
  const pre = document.createElement("pre");
  pre.style.cssText = "margin: 0; font: inherit; white-space: pre;";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "copy";
  btn.tabIndex = -1;
  btn.style.cssText = BTN_CSS;
  box.append(pre, btn);
  document.body.appendChild(box);

  // ---- the touches (a pinch is two fingers since this gesture's first touch, until the last one leaves)
  let fingers = 0, pinched = false;
  const onTouch = (e) => { fingers = e.touches.length; if (fingers >= 2) pinched = true; else if (!fingers) pinched = false; };
  for (const ev of ["touchstart", "touchend", "touchcancel"]) addEventListener(ev, onTouch, { passive: true, capture: true });

  // ---- the engine, once the router has one
  let eng = null, turn = null;
  const label = () => gestureOf({ state: eng.state, outsideMoving: !!eng.outsideMoving, rig: nav?.rig, mode: nav?.mode,
    turning: !!turn?.pass?.animating?.(), fingers, pinched });
  const hook = () => {
    if (eng || !nav?.engine || typeof nav.engine.on !== "function") return;
    eng = nav.engine;
    attach(eng, meter, label);
  };

  // ---- the page's own animation frames
  const loop = (t) => { meter.raf(t); boot.raf(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  document.addEventListener("visibilitychange", () => { if (document.hidden) meter.pause(); });

  // ---- the box, 4 times a second
  let note = "", noteUntil = 0, text = "";
  const ms0 = (x) => (x >= 0 ? `${Math.round(x)}` : "-");
  const ms1 = (x) => (x >= 0 ? x.toFixed(1) : "-");
  const sc2 = (x) => (x >= 1 ? "1" : x.toFixed(2).replace(/^0/, ""));
  const paint = () => {
    const now = performance.now();
    hook();
    if (eng && !turn) turn = eng.passes?.list?.find?.((p) => p.name === "pageturn") || null;
    meter.idle(now);
    const s = meter.stats(now), L = [];
    const tier = eng?.settings?.tier || "-";
    L.push(`${s.fps} fps · ${s.drawn} drawn · ${tier}`);
    L.push(`worst 2s ${ms0(s.worst)} ms${eng ? ` · ${eng.width}x${eng.height}` : ""}`);
    if (eng) {
      L.push(eng.state === "refining" ? `refining ${eng.count}/${eng.settings?.samples ?? "?"}` : `${eng.state}${eng.outsideMoving ? " · outside moving" : ""}`);
      const mv = eng.movingScale;
      const room = mv ? (mv.on ? `scale ${sc2(mv.scale)}${mv.pinned ? " pin" : ""}` : "scale off") : "scale -";
      const out = mv?.outside ? ` · out ${sc2(mv.outside.scale)}` : "";
      L.push(`${room}${out}${s.scale < 1 ? " · used" : ""}`);
      L.push(`cpu ${ms1(s.cpuAvg)} avg · ${ms0(s.cpuMax)} max ms`);
      L.push(`gpu ${eng.gpuTiming ? `${ms1(s.gpuAvg)} avg · ${ms0(s.gpuMax)} max` : "n/a"} · heap ${performance.memory ? `${Math.round(performance.memory.usedJSHeapSize / 1e6)} MB` : "n/a"}`);
    } else L.push(nav?.mode && nav.mode !== "booting" ? `no 3D (${nav.mode})` : "3D not up yet");
    L.push(...bootLines(bootMarks(), (eng || nav?.bootEngine)?.timings || null, bootFiles(), boot.gaps));   // (DYS-216: the boot)
    const rig = nav?.rig;
    L.push(`${nav?.spot || "-"}${rig ? ` · zoom ${(rig.mag || 1).toFixed(2)}x` : ""}`);
    const g = s.seg;
    if (g) {
      const pct = (k) => (g.n ? Math.round((100 * k) / g.n) : 0);
      L.push(`${g.done ? "·" : "▶"} #${g.id} ${g.label}`);
      L.push(`n${g.n} · worst ${ms0(g.max)} ms`);
      L.push(`>16.7 ${pct(g.o16)}% · >33 ${pct(g.o33)}%`);
    } else L.push("· no move yet");
    if (note && now < noteUntil) L.push(note);
    else note = "";
    const t = L.join("\n");
    if (t !== text) { text = t; pre.textContent = t; }
  };
  setInterval(paint, 250);
  paint();
  // (DYS-216) the engine's steps as they come, every BOOT_POLL ms until the boot's record is done
  const bootLook = setInterval(() => {
    hook();
    boot.look(performance.now(), eng || nav?.bootEngine || null, bootMarks());
    if (boot.done) clearInterval(bootLook);
  }, BOOT_POLL);

  // ---- copy: the last minute as JSON (or, without a clipboard, the last moves in short on the box)
  const info = () => ({
    at: new Date().toISOString(), page: location.pathname + location.search, ua: navigator.userAgent,
    screen: [screen.width, screen.height], dpr: devicePixelRatio, tier: eng?.settings?.tier || null,
    render: eng ? [eng.width, eng.height, eng.dpr] : null, gpuTimer: !!eng?.gpuTiming, movingScale: eng?.movingScale || null,
    mode: nav?.mode || null,
  });
  // (DYS-216: the boot record LAST, after the frames and the stalls: a long paste cut at its start (Akshay's of 1 Nov
  // 16:51 kept only its end) still holds it)
  const dumpAll = () => { const d = meter.dump(performance.now(), info()); d.boot = boot.dump(eng || nav?.bootEngine || null); return d; };
  const fallback = (s) => {
    try {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position: fixed; top: 0; left: 0; opacity: 0; pointer-events: none;";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, s.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  };
  const done = (ok, d, json) => {
    if (ok) { note = `copied ${d.frames.length} frames (${Math.round(json.length / 1000)} KB)`; noteUntil = performance.now() + 4000; }
    else { note = ["no clipboard: the last moves", ...meter.segs.slice(-6).map(Meter.short)].join("\n"); noteUntil = performance.now() + 15000; }
    paint();
  };
  const stop = (e) => e.stopPropagation();
  for (const ev of ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup"]) btn.addEventListener(ev, stop, { passive: true });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const d = dumpAll(), json = JSON.stringify(d);
    try {
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(json).then(() => done(true, d, json), () => done(fallback(json), d, json));
      else done(fallback(json), d, json);
    } catch { done(fallback(json), d, json); }
  });

  installed = { meter, box, boot, dump: dumpAll };
  window.__sfwHud = installed;
  return installed;
}
