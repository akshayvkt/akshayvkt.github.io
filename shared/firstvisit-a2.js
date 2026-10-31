// First visit A2 (v3/firstvisit-a2; Akshay's pick 27 Oct, docs/v3/briefs/first-visit-a2.md): laptop first. The visit
// opens close on the laptop (app.js: the photograph's own crop, its screen dark with his name, a thin bar and the
// boot's share); at 100 % the room crossfades in at that same crop with the laptop's own page on its screen (the
// room's live HTML page, shared/laptop.js, sharp at any size), then pulls back to the desk (router.js bootEase, 1.4 s)
// and the masthead fades in. Then, once, each object you can click is lit in turn by its own hover light (gl/sheen.js:
// inside its own pixels, no glow) with its name just above it; the names stay until the first input or ~4 s.
// Every first visit to the bare homepage (DYS-12, Akshay 28 Oct; was behind ?firstvisit=a2): the router loads this when
// app.js opened close (app.js FV2 has the gate: not a refresh of a page read inside the homepage, nor where the room
// won't run), or for reduced motion's names on the bare homepage.
//
//   const fv = install(nav);   // the same calls as firstvisit.js: bootStart, progress, ready, mark, settled, ...

// the objects' names, left to right as they stand (Akshay 23:0x: the caption's small type, no box, no line)
export const WORDS = { shelf: "Books", laptop: "About · Projects", notebook: "Writing", phone: "Say hi", print: "Quotes", window: "Look outside" };
// the boot's steps, each its rough share of the wait; each step's own progress is real (bytes, items, or done)
const STEPS = { model: 0.45, tex: 0.3, light: 0.12, outside: 0.08, warm: 0.05 };
const INTRO_KEY = "sfw-intro";   // localStorage: this browser has had its first visit
const STEP_MS = 500;             // the light passes from one object to the next
const STAY_MS = 4000;            // the names stay this long after the last (or until the first input)
const FADE_MS = 400;
const EASE_MS = 90;
const REVEAL_HOLD_MS = 650;       // the loading screen held over the room's crossfade (router.js HANDOVER_MS 500 + a frame or two)               // the bar's (and its number's) ease toward the boot's share
const REDUCED_MS = 3000;         // reduced motion: the names together this long

const CSS = `
.fv-labels { position: absolute; inset: 0; z-index: 4; pointer-events: none; }
.fv-label { position: absolute; transform: translate(-50%, -100%); padding-bottom: 6px; white-space: nowrap;
  font-size: 13px; letter-spacing: 0.01em; color: var(--on-scene); text-shadow: 0 1px 10px rgba(0, 0, 0, 0.6);
  opacity: 0; transition: opacity ${FADE_MS}ms ease; }
.fv-label.is-on { opacity: 1; }
`;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } return null; };

export function install(nav) {
  const app = nav.o.firstVisit;
  // (reduced motion: no close opening (app.js), the room as today; on a first visit only, its names together for ~3 s.
  // Otherwise without the opening: a returning visitor, or not the bare homepage: nothing)
  const again = new URLSearchParams(location.search).get("intro") === "again";
  if (!app && !(reduced() && (again || store(INTRO_KEY) !== "1"))) return null;
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.appendChild(st);
  const root = document.documentElement;
  // no glint: the names are this visit's light
  store("sfw-glint", "1");
  const done = {}, marks = {};
  let shown = 0, over = false, revealed = false, named = false;
  const T = () => Math.round(performance.now());
  const screen = () => app?.screen() || document.querySelector(".fv-screen");
  const layer = document.createElement("div");
  layer.className = "fv-labels";
  nav.hero?.appendChild(layer);

  const share = () => Object.entries(STEPS).reduce((s, [k, w]) => s + w * Math.min(1, done[k] || 0), 0);
  // (the bar and its number show one value, eased toward the boot's real share every frame, so the number never runs
  // ahead of the bar: the coordinator's review 12:0x 28 Oct caught '67%' over a quarter-full bar, the bar's own CSS
  // transition lagging; the share itself never goes back)
  let target = 0, raf = 0, last = 0;
  const draw = () => {
    const s = screen();
    if (!s) return;
    const v = Math.round(shown * 1000) / 1000;   // (one value for both, rounded once)
    s.querySelector(".fv-bar i").style.transform = `scaleX(${v.toFixed(3)})`;
    s.querySelector(".fv-pct").textContent = `${Math.floor(v * 100 + 1e-6)}%`;
  };
  const step = () => {
    const now = performance.now();
    raf = 0;
    const dt = Math.min(100, now - (last || now)); last = now;
    shown += (target - shown) * (1 - Math.exp(-dt / EASE_MS));
    if (target - shown < 0.002) shown = target;
    draw();
    if (shown < target) raf = requestAnimationFrame(step); else last = 0;
  };
  const paint = () => {
    target = Math.max(target, share());   // (never backwards)
    if (!raf && shown < target) raf = requestAnimationFrame(step);
    draw();
  };
  const tick = setInterval(paint, 250);   // (the screen may come a moment after the first step)

  // (DYS-21, Akshay: 'the keyboard keys smear past the laptop's left edge right after the reveal'.) At the close crop the
  // room is magnified ~2.4x, and two of its cheap paths with it: the desk mirror (the glossy desk's reflection, its own
  // pass at half the buffer's size, never refined) and the moving frames' lower scale (0.7) through the pull back. While
  // close and pulling back both run at full scale; back at the desk, as before
  let sharpOn = null;
  function sharp(on) {
    const e = nav.engine;
    if (!e || (on ? sharpOn : !sharpOn)) return;
    if (on) sharpOn = { mv: e.layers?.mvscale, mirror: e.mirror?.scale };
    if (e.layers && "mvscale" in e.layers) e.layers.mvscale = on ? false : sharpOn.mv;
    if (e.mirror && e.mirror.resize) { e.mirror.scale = on ? 1 : sharpOn.mirror; e.mirror.resize(e.width, e.height); }
    if (!on) sharpOn = null;
    e.invalid = true;   // (a live frame: the mirror is redrawn only with one)
    e.requestFrame?.();
  }

  // back to today's homepage: the photograph's own crop under the room, the masthead in
  function open() {
    clearInterval(tick);
    app?.unzoom();
    root.classList.add("sfw-fv-in");
    root.classList.remove("sfw-fv-close");
    setTimeout(() => root.classList.remove("sfw-fv-in"), 700);
  }

  const fv = {
    mode: "a2",
    a2: true,
    words: null,   // (hover names as today: at the pointer)
    bootStart() { marks.boot = T(); paint(); },
    progress(step, f) {
      if (!(step in STEPS)) return;
      done[step] = Math.max(done[step] || 0, Math.min(1, f || 0));
      paint();
    },
    nudge() {},   // (input is off while close: app.js)
    // the room is live: 100 %
    ready() {
      if (marks.ready) return;
      marks.ready = T();
      sharp(true);
      for (const k of Object.keys(STEPS)) done[k] = 1;
      paint();
    },
    // the hand-over's steps: revealed (the 3D shown, the loading screen goes with the photograph), window, eased
    mark(name) {
      if (marks[name]) return;
      marks[name] = T();
      if (name === "revealed") {
        revealed = true;
        // (the loading screen stays opaque over the room's 0.5 s crossfade, then goes in 0.3 s onto the live page: no
        // half-faded mix of it and the 3D screen's About page, DYS-21)
        const s = screen();
        if (s) setTimeout(() => { s.style.opacity = "0"; }, REVEAL_HOLD_MS);
      }
    },
    handover() { fv.mark("revealed"); },
    // the pull back is over and the room at rest: the masthead in, then the names (once)
    settled() {
      if (over) return;
      over = true;
      marks.settled = T();
      sharp(false);
      open();
      if (revealed && nav.spot === "desk" && nav.mode === "live") { store(INTRO_KEY, "1"); setTimeout(introduce, 250); }
    },
    bootFailed() { if (over) return; over = true; sharp(false); open(); },
    activated() {},
    state: () => ({ share: target, shown, done: { ...done }, marks: { ...marks }, revealed, over, named }),
  };

  // where an object's name goes: just above the top of its outline as the camera sees it, in the hero's own box
  function place(name) {
    const it = nav.live?.links?.items?.get(name);
    if (!it?.poly || it.a.style.display === "none") return null;
    const xs = it.poly.map((p) => p[0]), ys = it.poly.map((p) => p[1]);
    const r = nav.live.links.svg.getBoundingClientRect(), h = nav.hero.getBoundingClientRect();
    const x = r.left - h.left + (Math.min(...xs) + Math.max(...xs)) / 2, y = r.top - h.top + Math.max(0, Math.min(...ys));
    return [Math.min(h.width - 50, Math.max(50, x)), Math.max(28, y)];
  }
  function label(name, at) {
    const el = document.createElement("span");
    el.className = "fv-label";
    el.textContent = WORDS[name];
    el.style.left = `${at[0]}px`;
    el.style.top = `${at[1]}px`;
    layer.appendChild(el);
    requestAnimationFrame(() => el.classList.add("is-on"));
    return el;
  }

  // the names, once: the light passes over each object in turn (left to right), its name staying above it
  function introduce() {
    const list = Object.keys(WORDS).map((n) => [n, place(n)]).filter(([, at]) => at).sort((a, b) => a[1][0] - b[1][0]);
    if (!list.length) return;
    named = true;
    marks.names = T();
    let i = 0, t = 0, ended = false;
    if (reduced()) {
      // (no sequence, no light: the names together for ~3 s, or until the first input)
      for (const [name, at] of list) label(name, at);
      i = list.length;
    }
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(t);
      for (const k of ["pointerdown", "wheel", "keydown", "touchstart"]) removeEventListener(k, end, true);
      nav.sheen?.hover(null); nav.light?.();
      for (const el of layer.querySelectorAll(".fv-label")) el.classList.remove("is-on");
      marks.namesGone = T() + FADE_MS;
      setTimeout(() => layer.replaceChildren(), FADE_MS + 20);
    };
    for (const k of ["pointerdown", "wheel", "keydown", "touchstart"]) addEventListener(k, end, { capture: true, passive: true });
    const next = () => {
      if (ended) return;
      if (i >= list.length) { nav.sheen?.hover(null); nav.light?.(); t = setTimeout(end, reduced() ? REDUCED_MS : STAY_MS - STEP_MS); return; }
      const [name, at] = list[i++];
      const [lit, k] = nav.lightFor(name);
      nav.sheen?.hover(lit, k);
      label(name, place(name) || at);
      t = setTimeout(next, STEP_MS);
    };
    next();
  }

  return fv;
}
