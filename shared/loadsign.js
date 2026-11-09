// DYS-212 (Akshay 1 Nov, the loading rework: other visits). A visit after the first opens on today's still of the room,
// as before, and the still takes no input until the live room is in (index.html @sfw-load-head, html.sfw-loading;
// router.js loadIn lets it go). Meanwhile this small sign says so: "Loading the room" with a thin line under it that
// shows the boot's real share (the steps and weights of firstvisit-a2.js), top centre on the Quiet version's row, in its
// ink (style.css --qc-ink: dark over a bright sky, light over a dark one). It comes only if the room is not ready 0.6 s
// after the still was painted (a quick return shows none) and fades out with the hand-over's crossfade. Reduced
// motion: no fades, the line set without easing. Never on a first visit (that is firstvisit-a2.js), never where no live
// room will start (the router makes it only where the head set html.sfw-loading).
//
//   const sign = install(nav);   // router.js boot(): bootStart, progress, ready, handover, settled, bootFailed, nudge, away, mark, activated

// the boot's steps, each its rough share of the wait (firstvisit-a2.js STEPS); each step's own progress is real
export const STEPS = { model: 0.45, tex: 0.3, light: 0.12, outside: 0.08, warm: 0.05 };
export const TEXT = "Loading the room";
export const SHOW_AFTER = 600;   // ms after the still's first paint: a return quicker than this shows no sign
const FADE_IN = 300;
const FADE_OUT = 500;            // with the hand-over's crossfade (router.js HANDOVER_MS)
const FADE_QUICK = 150;          // a failed boot (the still stays and takes taps again), or the visitor gone elsewhere
const EASE_MS = 90;              // the line's ease toward the boot's share (firstvisit-a2.js)

const CSS = `
.sfw-loadsign { position: absolute; z-index: 3; left: 50%; top: var(--qc-top, 1.4rem); transform: translateX(-50%);
  display: inline-flex; flex-direction: column; align-items: stretch; gap: 5px; pointer-events: none; white-space: nowrap;
  font-size: calc(var(--qc-size, 15px) - 2px); line-height: 1.65; letter-spacing: 0.01em;
  color: var(--qc-ink, var(--on-scene-soft, rgba(244, 239, 230, 0.74))); text-shadow: var(--qc-halo, 0 1px 14px rgba(0, 0, 0, 0.45));
  opacity: 0; visibility: hidden; transition: opacity ${FADE_IN}ms ease, visibility 0s linear ${FADE_IN}ms; }
.sfw-loadsign.is-on { opacity: 0.85; visibility: visible; transition: opacity ${FADE_IN}ms ease, visibility 0s; }
.sfw-loadsign.is-out { opacity: 0; transition: opacity var(--ls-out, ${FADE_OUT}ms) ease; }
.sfw-loadsign .ls-bar { position: relative; height: 2px; border-radius: 1px; overflow: hidden;
  background: rgba(244, 239, 230, 0.28); background: color-mix(in srgb, currentColor 28%, transparent); }
.sfw-loadsign .ls-bar i { position: absolute; inset: 0; background: currentColor; transform-origin: 0 50%; transform: scaleX(0); }
@media (prefers-reduced-motion: reduce) { .sfw-loadsign, .sfw-loadsign.is-on, .sfw-loadsign.is-out { transition: none; } }
`;

const reduced = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

// The boot's share and the line's eased value, apart from the page (scripts/live/load_return_test.mjs drives it): the
// share is the weighted sum of the steps' own progress, each step kept at its highest, so neither goes backwards
export function createMeter() {
  const done = {};
  let target = 0, shown = 0;
  const share = () => Object.entries(STEPS).reduce((s, [k, w]) => s + w * Math.min(1, done[k] || 0), 0);
  return {
    progress(step, f) {
      if (!(step in STEPS)) return target;
      const v = Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
      done[step] = Math.max(done[step] || 0, v);
      target = Math.max(target, Math.min(1, share()));
      return target;
    },
    all() { for (const k of Object.keys(STEPS)) done[k] = 1; target = 1; return target; },
    // one frame of the ease (dt in ms; 0 or reduced motion: at the share at once)
    frame(dt, at = false) {
      if (at || !(dt > 0)) shown = target;
      else shown = Math.min(target, Math.max(shown, shown + (target - shown) * (1 - Math.exp(-Math.min(100, dt) / EASE_MS))));
      if (target - shown < 0.002) shown = target;
      return shown;
    },
    get target() { return target; },
    get shown() { return shown; },
  };
}

let styled = false;

export function install(nav) {
  // (the router's own verdict: the room is in already, or will not come here, or the visitor has gone elsewhere)
  if (!nav?.hero || nav.loadOver || nav.live?.revealed) return null;
  const doc = nav.hero.ownerDocument || document;
  if (!styled) {
    styled = true;
    const st = doc.createElement("style");
    st.textContent = CSS;
    doc.head.appendChild(st);
  }
  const el = doc.createElement("div");
  el.className = "sfw-loadsign";
  el.setAttribute("role", "status");   // (the words go in when it shows: read once, then)
  const words = doc.createElement("span");
  const bar = doc.createElement("span");
  bar.className = "ls-bar";
  bar.setAttribute("aria-hidden", "true");
  const fill = doc.createElement("i");
  bar.appendChild(fill);
  el.appendChild(words);
  el.appendChild(bar);
  nav.hero.appendChild(el);

  const meter = createMeter();
  const marks = {};
  const T = () => Math.round(performance.now());
  let on = false, gone = false, raf = 0, last = 0, showT = 0;

  const draw = () => { fill.style.transform = `scaleX(${meter.shown.toFixed(3)})`; };
  const step = () => {
    raf = 0;
    if (gone) return;
    const now = performance.now();
    const dt = last ? now - last : 0;
    last = now;
    meter.frame(dt || 16, reduced());
    draw();
    if (meter.shown < meter.target) raf = requestAnimationFrame(step); else last = 0;
  };
  const paint = () => { if (on && !gone && !raf && meter.shown < meter.target) raf = requestAnimationFrame(step); };

  // shown 0.6 s after the still's first paint, unless the room is ready by then (it hands over at once: no flash)
  function show() {
    if (on || gone || marks.ready) return;
    on = true;
    marks.shown = T();
    words.textContent = TEXT;
    meter.frame(0, true);   // (the line starts where the boot is)
    draw();
    el.classList.add("is-on");
  }
  function drop(ms) {
    if (gone) return;
    gone = true;
    clearTimeout(showT);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    marks.gone = T();
    if (!on) { el.remove(); return; }
    const q = reduced() ? 0 : ms;
    el.style.setProperty("--ls-out", `${q}ms`);
    el.classList.add("is-out");
    setTimeout(() => el.remove(), q + 60);
  }
  const fcp = (() => { try { return performance.getEntriesByName("first-contentful-paint")[0]?.startTime || 0; } catch { return 0; } })();
  showT = setTimeout(show, Math.max(0, fcp + SHOW_AFTER - performance.now()));

  const sign = {
    mode: "return",
    bootStart() { if (!marks.boot) marks.boot = T(); },
    progress(stepName, f) { meter.progress(stepName, f); paint(); },
    nudge() {},   // (the still takes no taps meanwhile: index.html html.sfw-loading; the masthead's own moves go away())
    // the room is live (ready to hand over): the line full; not shown yet, it never comes
    ready() {
      if (marks.ready) return;
      marks.ready = T();
      clearTimeout(showT);
      meter.all();
      paint();
    },
    // the hand-over's crossfade starts (router.js reveal): out with it
    handover() { marks.handover = marks.handover || T(); drop(FADE_OUT); },
    settled() { drop(FADE_OUT); },
    bootFailed() { drop(FADE_QUICK); },
    away() { drop(FADE_QUICK); },
    mark(name) { if (!marks[name]) marks[name] = T(); },
    activated() {},
    state: () => ({ on, gone, target: meter.target, shown: meter.shown, marks: { ...marks } }),
    el,
  };
  if (nav.mode === "booting" || nav.mode === "live") sign.bootStart();
  if (nav.mode === "live") sign.ready();   // (the import came after the room was up: no sign)
  return sign;
}
