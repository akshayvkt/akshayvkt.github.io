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
const BAR_CAP = 0.95;            // (C's review, LOW 3) the bar's most until 'Enter' shows: the room is live at ready(), 'Enter' a hand-over later
const STEP_MS = 500;             // the light passes from one object to the next
const STAY_MS = 4000;            // the names stay this long after the last (or until the first input)
const FADE_MS = 400;
const EASE_MS = 90;
const FV_SAFETY_MS = 30000;      // (the review's trap 1, G's N4) a first visit whose room never comes: the opening ends then
const REVEAL_HOLD_MS = 650;       // the loading screen held over the room's crossfade (router.js HANDOVER_MS 500 + a frame or two)               // the bar's (and its number's) ease toward the boot's share
const REDUCED_MS = 3000;
const PULL_MS = 1400;
// (DYS-221 + DYS-216 #2, the coordinator 2 Nov 06:40Z: the lock screen covers the late work, 'Touch to unlock' after it) the
// fingerprint ring: the boot's real share up to RING_BOOT (the room shown), then the late work's stretch (runLate: the sheets,
// the late programs and their pre-draw, the desk), moving while it runs (LATE_TAU), never full before the prompt
const RING_BOOT = 0.9, RING_LATE_MAX = 0.99, LATE_TAU = 450, LATE_TICK_MS = 200;
const LATE_WAIT_MAX = 6000;     // (DYS-216) 'Enter' waits for router.js runLate at most this long           // (DYS-212) the menu's fade-in with the pull back: router.js bootEase's first-visit ease         // reduced motion: the names together this long

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
  let gone = false, stopNames = null;   // (DYS-200: the room has left the desk, fv.away(); the names' own end, introduce())
  const T = () => Math.round(performance.now());
  const screen = () => app?.screen() || document.querySelector(".fv-screen");
  const lock = () => app?.lock?.() || null;   // (DYS-221: the Mac's lock screen on it, app.js; null: C's bar)
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
    const L = lock();
    if (L) { L.setProgress(ring(v)); return; }   // (DYS-221: the fingerprint ring; full only with 'Touch to unlock', G's N5)
    const bar = s.querySelector(".fv-bar i"), pct = s.querySelector(".fv-pct");
    if (!bar || !pct) return;   // (DYS-212: 'Enter' has taken the bar's place)
    // (C's review of v3/loading-final, LOW 3: at fv.ready() the share is full, but 'Enter' waits for the hand-over, up to
    // ~9 s, longer with bootlate's late work: a bar at 100 % that long read as stalled, and invited a tap. Full with
    // 'Enter' only (showEnter), as D's ring)
    const w = marks.enter ? v : Math.min(v, BAR_CAP);
    bar.style.transform = `scaleX(${w.toFixed(3)})`;
    pct.textContent = `${Math.floor(w * 100 + 1e-6)}%`;
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

  // (DYS-212, Akshay 1 Nov: the pull back into the room only on the visitor's tap) once the room is live under the
  // loading screen, 'Enter' takes the bar's place and the whole screen is the tap target (Enter / Space on the focused
  // button too); the tap fades the screen onto the laptop's live page and lets the router's pull back go (fv.enter()).
  // No screen to show it on: at once, as before (nothing waits on a button that isn't there)
  // the ring at the boot's share v: the boot's part, then the late work's stretch (lateAt: when it started), 1 with the prompt
  let lateAt = 0, lateTick = 0;
  const ring = (v) => {
    if (marks.enter) return 1;
    if (!lateAt) return RING_BOOT * v;
    return RING_BOOT + (RING_LATE_MAX - RING_BOOT) * (1 - Math.exp(-(performance.now() - lateAt) / LATE_TAU));
  };
  const lateRing = () => { lateTick = 0; if (marks.enter || over) return; draw(); lateTick = setTimeout(lateRing, LATE_TICK_MS); };
  let entered = false, enterGo = null, released = false;
  // (G's B1: released, the pull back let go; until then the room takes no input under the screen, fv.held)
  const enterP = new Promise((res) => { enterGo = () => { released = true; res(); }; });
  const keep = (e) => e.stopPropagation();   // (the loading screen's presses: not the room's, showEnter)
  // (DYS-221) a tap on the lock screen unlocks: its own motion (it leaves the wallpaper, the desktop), then the box fades
  // (0.3 s) onto the laptop's live page under it, its About page, this long from the fade's start, then the pull back.
  // now: at once (no tap: settled, a failed boot)
  const ABOUT_HOLD_MS = 650, UNLOCK_MAX_MS = 1500;
  function doEnter(e, now = false) {
    e?.preventDefault?.(); e?.stopPropagation?.();
    if (entered) return;
    // (G's S4) the visitor's own tap (e) remembers the visit: the menu is tappable from here, and About tapped in the pull
    // back's 1.4 s ended the visit at the laptop, which settled() doesn't remember (it keeps its desk check for the names),
    // so every later visit was a first visit again. A screen gone without a tap (settled, bootFailed) remembers nothing
    if (e) store(INTRO_KEY, "1");
    // (G's S2) the screen is decoration again from the tap: aria-hidden back on it, its focused button let go first (no
    // focus left inside an aria-hidden subtree)
    const sc = screen();
    if (sc?.contains?.(document.activeElement)) document.activeElement.blur?.();
    sc?.setAttribute?.("aria-hidden", "true");
    entered = true;
    marks.entered = T();
    const s = screen(), L = lock();
    const go = () => {
      if (s) { s.classList.remove("is-enter"); s.style.opacity = "0"; }
      globalThis.sfwChromeIn?.(PULL_MS);   // (DYS-212, call 2: the menu and the tabs fade in with the pull back)
      enterGo();
    };
    if (!L || !s || now) { go(); return; }
    s.classList.remove("is-enter");
    s.classList.add("is-unlocking");
    let gone = false;
    const after = () => { if (gone) return; gone = true; marks.unlocked = T(); s.style.opacity = "0"; setTimeout(go, L.aboutHold ?? ABOUT_HOLD_MS); };   // (G, DYS-230 round 2c: the full lock's 0, one move)
    Promise.resolve().then(() => L.unlock()).then(after, after);
    setTimeout(after, L.unlockMax || UNLOCK_MAX_MS);   // (whatever the lock does, the pull back comes; G, DYS-230: its own cap, the shrink first)
  }
  function showEnter() {
    if (entered || over) return;
    const s = screen();
    if (!s) { doEnter(); return; }
    marks.enter = T();
    clearInterval(tick);   // (the bar is done: 100 %, and it goes)
    const L = lock();
    if (L) {
      // (DYS-221) 'Touch to unlock' on the lock screen; the whole screen is the tap target, and a button no one sees takes
      // Enter / Space (focused, as 'Enter' was)
      L.wake?.();   // (G's N2: a screen the photograph never woke; idempotent)
      clearTimeout(lateTick);
      L.setProgress(1);
      L.ready();
      s.removeAttribute("aria-hidden");   // (G's N3: the key is focused in it; the lock's own content keeps its aria-hidden)
      s.classList.add("is-enter");
      s.addEventListener("click", doEnter);
      for (const k of ["pointerdown", "pointerup", "pointermove", "pointercancel", "touchstart", "touchmove", "touchend", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) s.addEventListener(k, keep);   // (wheel: G's S2)
      const key = document.createElement("button");
      key.type = "button";
      key.className = "fv-key";
      key.textContent = "Touch to unlock";
      s.appendChild(key);
      key.focus({ preventScroll: true });
      return;
    }
    const row = s.querySelector(".fv-row");
    draw();   // (the bar full as it goes: BAR_CAP lifted with 'Enter')
    row?.classList.add("is-off");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fv-enter";
    b.textContent = "Enter";
    s.classList.add("is-enter");
    s.addEventListener("click", doEnter);
    // (LR2, 1 Nov: the tap on 'Enter' also reached the room's own gestures, attached to the hero this screen lies in: a
    // tap on the 3D laptop under it, so the room went to the laptop instead of pulling back. The screen keeps its
    // presses to itself; its click is 'Enter')
    for (const k of ["pointerdown", "pointerup", "pointermove", "pointercancel", "touchstart", "touchmove", "touchend", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) s.addEventListener(k, keep);   // (wheel: G's B1)
    setTimeout(() => {
      if (entered) return;
      if (row) row.replaceWith(b); else s.appendChild(b);
      requestAnimationFrame(() => b.classList.add("is-on"));
      // (G's S2: app.js makes the screen aria-hidden, decoration while it loads; 'Enter' in it was out of a screen
      // reader's reach, the only way in once nothing else takes input. Now the screen is in the accessibility tree with
      // its button; the name drawn on it stays decoration)
      s.querySelector(".fv-name")?.setAttribute?.("aria-hidden", "true");
      s.removeAttribute?.("aria-hidden");
      b.focus({ preventScroll: true });
    }, row ? 200 : 0);
  }

  // back to today's homepage: the photograph's own crop under the room, the masthead in
  function open() {
    clearInterval(tick);
    app?.unzoom();
    root.classList.add("sfw-fv-in");
    root.classList.remove("sfw-fv-close");
    globalThis.sfwChromeIn?.(600);   // (DYS-212: if no 'Enter' went by: a failed boot, a move first; else already in)
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
        // (the loading screen stays opaque over the room's 0.5 s crossfade: no half-faded mix of it and the 3D screen's
        // About page, DYS-21; then, DYS-212, 'Enter' on it, and it goes onto the live page only on the visitor's tap)
        // (DYS-216, ?bootlate=1: and once what the first view didn't need is made, router.js runLate's own work (lateCpuP:
        // the light, the page turn, the laptop's page and the desk's layers made, behind this screen; not the page's
        // download, which wakes when it is built, BL1); LATE_WAIT_MAX at most. Without it: at once)
        setTimeout(() => {
          nav.runLate?.();
          if (nav.lateCpuP && lock()) { shown = target = 1; lateAt = performance.now(); lateRing(); }   // (DYS-221: the ring's late stretch)
          Promise.race([Promise.resolve(nav.lateCpuP), new Promise((r) => setTimeout(r, LATE_WAIT_MAX))]).then(showEnter, showEnter);
        }, REVEAL_HOLD_MS);
      }
    },
    handover() { fv.mark("revealed"); },
    // (DYS-212) the router's pull back waits for this: the visitor's tap on 'Enter'
    enter: () => enterP,
    // (G's B1) a first visit's close opening is up and the pull back not yet let go (the visitor's tap, or the screen gone
    // at settled / bootFailed): the room under the screen takes no input meanwhile (router.js: its gestures, wheel, pinch,
    // +/-). Reduced motion's names only: never
    held: () => !!app && !over && !released,
    // the pull back is over and the room at rest: the masthead in, then the names (once)
    settled() {
      if (over) return;
      over = true;
      marks.settled = T();
      sharp(false);
      if (!entered) doEnter(null, true);   // (DYS-212: no pull back went by, or a move showed the room: the screen goes all the same, at once)
      open();
      if (revealed && nav.spot === "desk" && nav.mode === "live") { store(INTRO_KEY, "1"); setTimeout(introduce, 250); }
    },
    bootFailed() { if (over) return; over = true; sharp(false); if (!entered) doEnter(null, true); open(); },
    // (DYS-200: a quick tap on the bookshelf while the names were up, or just before they came, rode them into the shelf's
    // view and over the Books page: they lie on the hero, not on their objects.) The room leaving the desk (router.js
    // leaving(), as its glide starts) takes them away at once, and none come after it; the desk is as before.
    away() {
      // (DYS-234) the room leaving the desk before the opening's tap (only the debug handle can: every visitor's way off
      // the desk waits for the tap, fv.held) takes the loading screen away with it: it's mapped onto the desk's
      // photograph, so anywhere else it would float over the room. After the tap the pull back takes it as before
      if (!entered) { const s = screen(); if (s?.style) s.style.visibility = "hidden"; }
      if (gone) return;
      gone = true;
      stopNames?.();
      for (const el of layer.children) { el.style.transitionDuration = "120ms"; el.classList.remove("is-on"); }
      setTimeout(() => layer.replaceChildren(), 140);
    },
    activated() {},
    state: () => ({ share: target, shown, done: { ...done }, marks: { ...marks }, revealed, over, named, entered }),
    // (QA, DYS-212's recordings: the visitor's tap on 'Enter', as the button's own click)
    qaEnter: () => doEnter({ type: "qa" }),   // (the tap's own path: the visit remembered, G's S4)
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
    requestAnimationFrame(() => { if (!gone) el.classList.add("is-on"); });
    return el;
  }

  // the names, once: the light passes over each object in turn (left to right), its name staying above it
  function introduce() {
    if (gone || nav.spot !== "desk") return;   // (DYS-200: a tap in the 250 ms before them has left the desk)
    const list =Object.keys(WORDS).map((n) => [n, place(n)]).filter(([, at]) => at).sort((a, b) => a[1][0] - b[1][0]);
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
    stopNames = end;
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

  // (DYS-212, the independent review's trap 1, G's N4: a boot that stalls without failing (a model download stuck, a
  // context lost in the warm-up, a throw in boot()) never calls ready(): after FV_SAFETY_MS the close opening ends as a
  // failed boot does (bootFailed: the photograph whole, the menu in, no tap waited for)
  if (app) setTimeout(() => { if (!marks.ready && !over) fv.bootFailed(); }, FV_SAFETY_MS);

  return fv;
}
