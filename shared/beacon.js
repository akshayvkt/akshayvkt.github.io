// The real-visitor beacon (DYS-149; Akshay said yes, 29 Oct 18:1x): one Google Analytics 4 event per visit, "sfw_perf",
// sent through the site's own tag (window.gtag, which scripts/deploy/build_dist.py --ga puts in every page's head) when
// the visit ends. No new endpoint and no personal data: no user agent, no address beyond the page's kind, no id of ours
// (GA's own fields ride along as they do on its page_view). What it carries (PARAMS below; every value a number or a
// short word):
//   load     fcp_ms (the first contentful paint), pic_ms (the desk's photograph on screen: app.js's "sky:reveal"; a visit
//            landing on the homepage only: elsewhere the page's own picture covers it),
//            resp_ms (the live room answers to input: router.js's "sfw:room-responds"), live_ms (the 3D on screen:
//            router.js's "sfw:room-shown"); each from the navigation's start, left out when it never happened
//   input    ix_n, ix_p50_ms, ix_max_ms: interactions (a click, a tap, a key) from input to the next paint, by the Event
//            Timing API (none in some Safari versions: then left out, never guessed). The browser reports only those of
//            16 ms or more, and from before this file loaded only those of 104 ms or more and the first input: ix_n and
//            the median are over the ones after it loaded, the worst over all of them
//   frames   the frames the 3D engine draws while the camera moves (the room's, or the outside's when zoomed), from the
//            engine's own "frame" events (no animation-frame loop of ours), each the time since the frame before it when
//            that one was drawn on the animation frame just before: fr_n, fr_p50_ms, fr_p95_ms, fr_low1_fps (the fps of
//            the slowest 1 %: their mean frame time), fr_max_ms (the longest freeze), fr_over50 (frames over 50 ms),
//            fr_late (over 1.5 intervals at 60 Hz), fr_sd_ms (the standard deviation); scripts/live/perf/perf_lib.mjs's
//            definitions, from a fixed histogram of 1 ms bins up to 250 ms (FrameHist)
//   device   scr (phone / tablet / desktop from the screen's size), dpr (1, 1.5, 2 or 3), tier (router.js bootTier: T0 or
//            auto), etier (the engine's: T1, T2, or none without the 3D)
// Sent once, at pagehide or the page going hidden, whichever comes first, with transport_type "beacon". Loaded by
// shared/router.js once the room is up (or has given up, or 10 s after the router started), never before the first
// picture, and only where window.gtag exists or the address has ?debug. Without gtag (a stage, a dev page) it sends
// nothing; with ?debug it measures all the same and keeps the payload in window.__sfwBeacon (tests: scripts/live/
// smoke.mjs "beacon", scripts/live/beacon_test.mjs).
import { isPhone } from "./device.js";

export const NAME = "sfw_perf";
export const VERSION = 1;
export const BINS = 250;                  // 1 ms bins for 0-249 ms; one more for 250 ms and over
export const LATE = 16.7 * 1.5;           // a frame later than 1.5 intervals at 60 Hz (perf_lib.mjs LATE_60)
const PAUSE = 5000;                       // a gap this long is the page put away, not a freeze: not counted
// every parameter the event can carry (GA4 takes 25 at most; transport_type is the 23rd)
export const PARAMS = ["v", "kind", "nav_type", "scr", "dpr", "tier", "etier", "fcp_ms", "pic_ms", "resp_ms", "live_ms",
  "ix_n", "ix_p50_ms", "ix_max_ms", "fr_n", "fr_p50_ms", "fr_p95_ms", "fr_low1_fps", "fr_max_ms", "fr_over50", "fr_late",
  "fr_sd_ms", "transport_type"];

const r1 = (x) => Math.round(x * 10) / 10;

/** Frame times in a fixed histogram (1 ms bins to 250 ms, each bin's own sum kept so its mean is exact). */
export class FrameHist {
  constructor() {
    this.c = new Uint32Array(BINS + 1);
    this.s = new Float64Array(BINS + 1);
    this.n = 0; this.sum = 0; this.sq = 0; this.max = 0; this.over50 = 0; this.late = 0;
  }
  add(ms) {
    if (!(ms >= 0) || ms === Infinity) return;
    const i = ms >= BINS ? BINS : Math.floor(ms);
    this.c[i]++; this.s[i] += ms;
    this.n++; this.sum += ms; this.sq += ms * ms;
    if (ms > this.max) this.max = ms;
    if (ms > 50) this.over50++;
    if (ms > LATE) this.late++;
  }
  /** The frame time at rank p (0-1) of the sorted list (perf_lib's q(): index round(p * (n - 1))), as its bin's mean. */
  pct(p) {
    if (!this.n) return null;
    const r = Math.min(this.n - 1, Math.round(p * (this.n - 1)));
    for (let i = 0, cum = 0; i <= BINS; i++) {
      cum += this.c[i];
      if (cum > r) return this.s[i] / this.c[i];
    }
    return this.max;
  }
  /** The fps of the slowest `share` of frames: 1000 over their mean frame time (at least one frame). */
  low(share) {
    if (!this.n) return null;
    const k = Math.max(1, Math.ceil(this.n * share));
    let got = 0, total = 0;
    for (let i = BINS; i >= 0 && got < k; i--) {
      if (!this.c[i]) continue;
      const take = Math.min(this.c[i], k - got);
      // (the top frame is known exactly: the slowest one alone is the longest)
      total += take === 1 && got === 0 ? this.max : (take * this.s[i]) / this.c[i];
      got += take;
    }
    return 1000 / (total / k);
  }
  sd() {
    if (!this.n) return null;
    const m = this.sum / this.n;
    return Math.sqrt(Math.max(0, this.sq / this.n - m * m));
  }
  /** The event's frame parameters (fr_n alone when nothing moved). */
  summary() {
    if (!this.n) return { fr_n: 0 };
    return { fr_n: this.n, fr_p50_ms: r1(this.pct(0.5)), fr_p95_ms: r1(this.pct(0.95)), fr_low1_fps: r1(this.low(0.01)),
      fr_max_ms: Math.round(this.max), fr_over50: this.over50, fr_late: this.late, fr_sd_ms: r1(this.sd()) };
  }
}

/** The median and the worst of a list of durations (ms), rounded. */
export function ixStats(after, all) {
  const out = { ix_n: after.length };
  if (after.length) { const s = after.slice().sort((a, b) => a - b); out.ix_p50_ms = Math.round(s[Math.round(0.5 * (s.length - 1))]); }
  if (all.length) out.ix_max_ms = Math.round(Math.max(...all));
  return out;
}

/** The kind of page a visit landed on, from its first address (the address itself is never sent). */
export function kindOf(href, doc = "home") {
  if (doc === "books" || doc === "quotes" || doc === "projects") return doc;
  let u;
  try { u = new URL(href); } catch { return "home"; }
  const pg = u.searchParams.get("page");
  if (pg === "books" || pg === "quotes" || pg === "projects") return pg;
  if (u.searchParams.has("writing") || /^\/writing(\/|$)/.test(u.pathname)) return "essay";
  if (/^\/books(\/|$)/.test(u.pathname)) return "books";
  if (/^\/quotes(\.html|\/|$)/.test(u.pathname)) return "quotes";
  if (/^\/projects(\/|$)/.test(u.pathname)) return "projects";
  return "home";
}

/** The device's class: the screen's size (CSS px) and the pointer, and the pixel ratio, in buckets. */
export function deviceClass(sw, sh, coarse, ratio) {
  const short = Math.min(sw, sh);
  // (DYS-171: a phone is shared/device.js's, as the router and the engine say it: a coarse pointer too, so a small
  // screen without one (e.g. a 1440 x 900 screen at 175 % browser zoom) is a desktop here now)
  const scr = isPhone(sw, sh, coarse) ? "phone" : coarse && short < 1100 ? "tablet" : "desktop";
  const r = ratio || 1;
  return { scr, dpr: r < 1.25 ? 1 : r < 1.75 ? 1.5 : r < 2.5 ? 2 : 3 };
}

let installed = null;

/**
 * Start measuring this visit (once per document). nav: the router (doc, engine, ready); tier: bootTier()'s verdict;
 * debug: ?debug (window.__sfwBeacon). A silent no-op without window.gtag unless debug.
 */
export function install(nav, { tier = "auto", debug = false } = {}) {
  if (installed) return installed;
  if (typeof window.gtag !== "function" && !debug) return null;
  const t0 = performance.now();
  const navEntry = performance.getEntriesByType?.("navigation")?.[0] || null;
  const kind = kindOf(navEntry?.name || location.href, nav?.doc);
  const dc = deviceClass(screen.width, screen.height, matchMedia("(pointer: coarse)").matches, devicePixelRatio);
  const hist = new FrameHist();
  let engine = null, state = null;

  // ---- frames while the camera moves (the engine's own "frame" events)
  const prevO = new Float64Array(10);
  let hadO = false, lastMoving = false;
  const outsideMoved = (o) => {
    if (!o) { hadO = false; return false; }
    const p = o.position, q = o.quaternion, s = o.shift;
    const v0 = p[0], v1 = p[1], v2 = p[2], v3 = q[0], v4 = q[1], v5 = q[2], v6 = q[3], v7 = o.fovY, v8 = s ? s[0] : 0, v9 = s ? s[1] : 0;
    const moved = hadO && (v0 !== prevO[0] || v1 !== prevO[1] || v2 !== prevO[2] || v3 !== prevO[3] || v4 !== prevO[4] || v5 !== prevO[5] ||
      v6 !== prevO[6] || v7 !== prevO[7] || v8 !== prevO[8] || v9 !== prevO[9]);
    prevO[0] = v0; prevO[1] = v1; prevO[2] = v2; prevO[3] = v3; prevO[4] = v4; prevO[5] = v5; prevO[6] = v6; prevO[7] = v7; prevO[8] = v8; prevO[9] = v9;
    hadO = true;
    return moved;
  };
  const onFrame = (f) => {
    const mv = engine.mv;   // (the engine's tick: lastTick, the animation frame's time; delta, the gap since the one before)
    // (only the animation-frame loop's draws: not a hidden warm-up frame or a test's renderSteps)
    if (mv && mv.lastTick !== f.time) return;
    const moving = f.state === "moving" || outsideMoved(f.outside);
    // the frame before this one was drawn on the animation frame just before (the engine's tick gap is its draw gap):
    // f.dt is then a presented frame's time; else (a pause in a slow drag) it is not, and is left out
    const consecutive = mv ? Math.abs(f.dt - mv.delta) < 0.5 : lastMoving;
    if (moving && consecutive && f.dt < PAUSE) hist.add(f.dt);
    lastMoving = moving;
  };
  const hook = (e) => {
    if (engine || !e || typeof e.on !== "function") return;
    engine = e;
    e.on("frame", onFrame);
    if (state) state.hooked = true;
  };

  // ---- interactions (Event Timing): the longest entry of each interaction
  const types = (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes) || [];
  const ixOn = types.includes("event");
  const ix = new Map();
  const onEntries = (list) => {
    for (const e of list.getEntries()) {
      // (a first input without its interaction's id, a pointerdown, counts toward the worst only: its interaction's
      // other events come under their own id)
      const id = e.interactionId || (e.entryType === "first-input" ? `f${e.startTime}` : 0);
      if (!id || (ix.size >= 2000 && !ix.has(id))) continue;
      const o = ix.get(id);
      if (!o) ix.set(id, { d: e.duration, early: e.startTime < t0 || typeof id === "string" });
      else if (e.duration > o.d) o.d = e.duration;
    }
  };
  const observers = [];
  if (ixOn) {
    for (const opts of [{ type: "event", buffered: true, durationThreshold: 16 }, ...(types.includes("first-input") ? [{ type: "first-input", buffered: true }] : [])]) {
      try { const po = new PerformanceObserver(onEntries); po.observe(opts); observers.push(po); } catch { /* not here */ }
    }
  }

  // ---- the payload
  const markAt = (name) => { const e = performance.getEntriesByName(name, "mark")[0]; return e ? Math.round(e.startTime) : undefined; };
  const build = () => {
    const p = { v: VERSION, kind, nav_type: navEntry?.type, scr: dc.scr, dpr: dc.dpr, tier: tier === "T0" ? "T0" : "auto",
      etier: engine?.settings?.tier || "none" };
    const fcp = performance.getEntriesByName?.("first-contentful-paint", "paint")?.[0];
    if (fcp) p.fcp_ms = Math.round(fcp.startTime);
    if (kind === "home") p.pic_ms = markAt("sky:reveal");
    p.resp_ms = markAt("sfw:room-responds");
    p.live_ms = markAt("sfw:room-shown");
    if (ixOn) {
      for (const po of observers) { try { onEntries({ getEntries: () => po.takeRecords() }); } catch { /* */ } }
      const all = [...ix.values()];
      Object.assign(p, ixStats(all.filter((x) => !x.early).map((x) => x.d), all.map((x) => x.d)));
    }
    if (engine) Object.assign(p, hist.summary());
    for (const k of Object.keys(p)) if (p[k] === undefined || p[k] === null) delete p[k];
    p.transport_type = "beacon";
    return p;
  };

  // ---- sent once, at the visit's end
  const end = () => {
    if (state.fired) return;
    state.fired = true;
    removeEventListener("pagehide", end, true);
    document.removeEventListener("visibilitychange", onVis, true);
    let p;
    try { p = build(); } catch { return; }
    state.payload = p;
    if (typeof window.gtag !== "function") return;   // (a stage or a dev page with ?debug: measured, never sent)
    try { window.gtag("event", NAME, p); state.sent = true; } catch { /* the tag's own problem */ }
  };
  const onVis = () => { if (document.visibilityState === "hidden") end(); };
  state = { name: NAME, v: VERSION, installedAt: Math.round(t0), hooked: false, eventTiming: ixOn, fired: false, sent: false, payload: null };
  addEventListener("pagehide", end, true);
  document.addEventListener("visibilitychange", onVis, true);
  if (nav?.engine) hook(nav.engine);
  else nav?.ready?.then?.((live) => { if (live) hook(nav.engine); }).catch?.(() => {});
  if (debug) window.__sfwBeacon = Object.assign(state, { peek: () => build() });
  installed = state;
  return state;
}
