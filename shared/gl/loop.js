// The render loop's parts (docs/v3/engine-api.md sections 4-6): events, the pass list, the jitter sequence used
// while refining, and the scheduler that decides whether this animation frame draws (busy, idle, hidden, off-screen).

export class Emitter {
  constructor() { this.map = new Map(); }
  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name).add(fn);
    return () => this.map.get(name)?.delete(fn);
  }
  emit(name, payload) {
    const s = this.map.get(name);
    if (!s) return;
    for (const fn of s) {
      try { fn(payload); } catch (e) { console.error(`[engine] ${name} listener`, e); }
    }
  }
}

export const STAGES = ["prepare", "room", "outside", "overlay", "post"];

export class Passes {
  constructor() { this.list = []; }
  add(pass) {
    if (!STAGES.includes(pass.stage)) throw new Error(`pass ${pass.name}: unknown stage "${pass.stage}"`);
    if (this.list.some((p) => p.name === pass.name)) throw new Error(`pass ${pass.name}: name already used`);
    const entry = { order: 0, raw: false, enabled: true, ...pass, pass };
    this.list.push(entry);
    this.list.sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || a.order - b.order);
    return entry;
  }
  remove(entry) { this.list = this.list.filter((p) => p !== entry); }
  stage(name) { return this.list.filter((p) => p.stage === name && p.enabled); }
  any(fn) { return this.list.some((p) => p.enabled && fn(p)); }
}

// ------------------------------------------------------------------ jitter: Cycles' 1.5 px Blackman-Harris filter
function bhCdfInverse(n = 512, width = 1.5) {
  const w = (t) => 0.35875 - 0.48829 * Math.cos(2 * Math.PI * t) + 0.14128 * Math.cos(4 * Math.PI * t) - 0.01168 * Math.cos(6 * Math.PI * t);
  const cdf = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) cdf[i] = cdf[i - 1] + w((i - 0.5) / n);
  for (let i = 0; i <= n; i++) cdf[i] /= cdf[n];
  return (u) => {
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m; else hi = m; }
    const f = (u - cdf[lo]) / Math.max(1e-12, cdf[hi] - cdf[lo]);
    return ((lo + f) / n - 0.5) * width;
  };
}
const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const inv = bhCdfInverse();
/** A point on the unit disc for refining sample k's lens position (Halton 5, 7; concentric mapping). */
export function lensSample(k) {
  const a = 2 * halton(k, 5) - 1, b = 2 * halton(k, 7) - 1;
  if (a === 0 && b === 0) return [0, 0];
  let r, phi;
  if (Math.abs(a) > Math.abs(b)) { r = a; phi = (Math.PI / 4) * (b / a); } else { r = b; phi = Math.PI / 2 - (Math.PI / 4) * (a / b); }
  return [r * Math.cos(phi), r * Math.sin(phi)];
}

/** Sub-pixel offset (device pixels) of refining sample k; sample 0 is the unjittered live frame. */
export function jitter(k) {
  if (k <= 0) return [0, 0];
  return [inv(halton(k, 2)), inv(halton(k, 3))];
}

// ------------------------------------------------------------------ scheduling
export class Scheduler {
  constructor(canvas, tick) {
    this.tick = tick;
    this.running = false;
    this.visible = true;
    this.lastInput = performance.now();
    this.raf = 0;
    this.onFrame = (t) => {
      this.raf = 0;
      if (!this.running) return;
      this.raf = requestAnimationFrame(this.onFrame);
      if (document.hidden || !this.visible) return;
      this.tick(t);
    };
    const input = () => { this.lastInput = performance.now(); };
    for (const ev of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]) addEventListener(ev, input, { passive: true });
    this.io = "IntersectionObserver" in window ? new IntersectionObserver((es) => { this.visible = es[es.length - 1].isIntersecting; }) : null;
    if (this.io) this.io.observe(canvas);
  }
  start() { if (!this.running) { this.running = true; this.raf = requestAnimationFrame(this.onFrame); } }
  stop() { this.running = false; if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
  idleMinutes() { return (performance.now() - this.lastInput) / 60000; }
  dispose() { this.stop(); this.io?.disconnect(); }
}
