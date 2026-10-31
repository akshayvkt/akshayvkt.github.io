// The first visit (v3/loading, the coordinator 15:5x / 16:0x / 23:47 / 23:48 25 Oct; Akshay: "make it clear to the user
// that the site is loading while the 3d gets ready", "how would a user who's visiting our page know all this is
// possible", "it has to be front and center", "once the loader is done the page should be available right after"): the
// room says it is getting ready, in the middle of the screen, until it has fully settled; it names its objects as the
// line leaves; after that nothing moves or fades on its own. Never arrows, rings or a tutorial.
// Two designs behind ?firstvisit=a|b (off without it: today's site, unchanged); the router loads this module only then.
//
//   The line (both): "Getting the room ready" (Akshay's words) on a soft frosted pill in the middle of the screen, over
//     the room (the still behind it not dimmed), once the boot takes more than 0.4 s. a: a ~200 px line under the words
//     fills with the boot's real progress; b: the share after the words ("· 42 %"). A move tried before the room is up
//     says "Still bringing the room in" in the same place. The line's last stretch is the hand-over itself (the 3D
//     shown, the window's live view in, the framing ease done), so 100 % is a room at rest.
//   As it leaves: the words become the hint ("Hover over anything in the room"; phones "Tap anything on the desk").
//     a: under it, once per visitor, each object lights in turn (its hover sheen) with its name beside it (~3.4 s); then
//     the pill and the last name fade together. b: the hint for 1.6 s, then the fade. Any input ends it at once.
//   After it: nothing on its own (no glint: it would come after the line; no wake-up, no ease). On input only: desktop
//     hover names every object beside it; phones (a) the first tap shows the object's name as the camera glides.
// Reduced motion: no sequence; the names show together with the hint and leave with the pill.
//
//   const fv = install(nav, "a");
//   fv.bootStart(); fv.progress("model", 0.4); fv.nudge(); fv.ready(); fv.mark("revealed" | "window" | "eased");
//   fv.settled(); fv.activated("laptop"); fv.bootFailed();
// (ready: the room can take over, mode "live"; revealed: it is shown; settled: the hand-over is over and the room at
// rest, or no hand-over will come by itself (a visitor at the window while it started: LOAD1b))

// the objects' names (the menu's words where it has them; new words for Akshay: "Look outside", "Say hi", and the hints)
export const WORDS = { shelf: "Books", laptop: "Projects", notebook: "Writing", print: "Quotes", window: "Look outside", phone: "Say hi", desk_book: "Bookshelf" };
const LINE = { loading: "Getting the room ready", nudge: "Still bringing the room in", hint: "Hover over anything in the room", hintTouch: "Tap anything on the desk" };
// the boot's steps, each its rough share of the wait (the model and its textures the most; the hand-over's own steps
// last); each step's own progress is real (bytes, items, or done)
const STEPS = { model: 0.38, tex: 0.26, light: 0.1, outside: 0.07, warm: 0.04, revealed: 0.05, window: 0.05, eased: 0.05 };
const SHOW_AFTER = 400;   // ms: a quick (cached) boot never shows the line
const INTRO_KEY = "sfw-intro";   // localStorage: the room has introduced itself to this browser
const STEP_MS = 560;      // one object's turn in the introduction
const HINT_MS = 1600;     // b (and a without an introduction): the hint's time before the pill goes
const FADE_MS = 260;      // the pill's (and the last name's) fade: the last thing that moves on its own
const INTRO = ["shelf", "laptop", "notebook", "print", "phone", "window"];

const CSS = `
.fv-load { position: fixed; z-index: 6; left: 50%; top: 50%; transform: translate(-50%, -50%); pointer-events: none;
  display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 16px 28px 15px; border-radius: 999px;
  background: rgba(255, 252, 246, 0.62); border: 1px solid rgba(255, 255, 255, 0.35);
  backdrop-filter: blur(14px) saturate(1.15); -webkit-backdrop-filter: blur(14px) saturate(1.15);
  box-shadow: 0 6px 28px rgba(0, 0, 0, 0.14);
  font-size: 22px; line-height: 1.2; letter-spacing: -0.005em; color: #241e18; white-space: nowrap;
  opacity: 0; transition: opacity ${FADE_MS}ms ease; }
.fv-load.is-on { opacity: 1; }
.fv-load .fv-line { position: relative; width: 200px; height: 2px; border-radius: 1px; background: rgba(36, 30, 24, 0.16); overflow: hidden; }
.fv-load .fv-line i { position: absolute; inset: 0; background: #241e18; transform-origin: 0 50%; transform: scaleX(0); transition: transform 0.4s ease; }
.fv-load[data-mode="b"] .fv-line, .fv-load.is-hint .fv-line { display: none; }
@media (max-width: 640px) { .fv-load { font-size: 18px; padding: 13px 22px 12px; gap: 10px; } .fv-load .fv-line { width: 170px; } }
.fv-labels { position: absolute; inset: 0; z-index: 4; pointer-events: none; }
.fv-label { position: absolute; transform: translate(-50%, -100%); padding-bottom: 6px; white-space: nowrap;
  font-size: 13px; letter-spacing: 0.01em; color: var(--on-scene); text-shadow: 0 1px 10px rgba(0, 0, 0, 0.6);
  opacity: 0; transition: opacity 0.18s ease; }
.fv-label.is-on { opacity: 1; }
.tip.at-object { transform: translate(-50%, -100%) translateY(-6px); }
@media (prefers-reduced-motion: reduce) { .fv-load, .fv-load .fv-line i, .fv-label { transition: none; } }
`;

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarse = () => matchMedia("(hover: none), (pointer: coarse)").matches;
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return v === undefined ? "blocked" : null; } return null; };

export function install(nav, mode) {
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.appendChild(st);
  // ?intro=again: this browser's first visit once more (for trying the designs; nothing else changes)
  if (new URLSearchParams(location.search).get("intro") === "again") { try { localStorage.removeItem(INTRO_KEY); } catch { /* blocked */ } }
  // a first visit (decided now: the introduction stores its key as it starts)
  const first = store(INTRO_KEY) !== "1";
  // no glint under the first visit: it would light the room after the line has gone (Akshay, 23:48)
  store("sfw-glint", "1");
  const done = {}, marks = {};
  let shown = false, booting = false, over = false, revealed = false, gone = false, timer = 0, sayT = 0, tapped = false;
  const T = () => Math.round(performance.now());
  // the line: one pill in the middle of the screen, over the room
  const box = document.createElement("div");
  box.className = "fv-load";
  box.dataset.mode = mode;
  box.setAttribute("role", "status");
  box.setAttribute("aria-live", "polite");
  const say = document.createElement("span");
  say.className = "fv-say";
  const pct = document.createElement("span");
  pct.setAttribute("aria-hidden", "true");
  const line = document.createElement("span");
  line.className = "fv-line";
  const bar = document.createElement("i");
  line.appendChild(bar);
  box.append(say, line);
  document.body.appendChild(box);
  const layer = document.createElement("div");
  layer.className = "fv-labels";
  nav.hero?.appendChild(layer);

  const share = () => Object.entries(STEPS).reduce((s, [k, w]) => s + w * Math.min(1, done[k] || 0), 0);
  const words = (t) => { say.textContent = t; if (mode === "b" && t === LINE.loading) { pct.textContent = ` · ${Math.round(share() * 100)} %`; say.appendChild(pct); } };
  const paint = () => { bar.style.transform = `scaleX(${share().toFixed(3)})`; if (mode === "b" && say.firstChild?.nodeValue === LINE.loading) words(LINE.loading); };
  const show = (on) => { shown = on; box.classList.toggle("is-on", on); };

  // a move tried on the room before it is up (it would otherwise do nothing): the line says so for a moment
  const early = (e) => {
    if (!booting || over) return;
    if (e.target?.closest?.("a, button, input, .masthead, .rd, .reader")) return;
    fv.nudge();
  };
  for (const k of ["pointerdown", "wheel"]) nav.hero?.addEventListener(k, early, { passive: true, capture: true });

  const fv = {
    mode,
    words: WORDS,
    bootStart() {
      booting = true;
      marks.boot = T();
      words(LINE.loading);
      timer = setTimeout(() => { if (!over) show(true); }, SHOW_AFTER);
    },
    progress(step, f) {
      if (!(step in STEPS)) return;
      done[step] = Math.max(done[step] || 0, Math.min(1, f || 0));   // (never backwards)
      paint();
    },
    nudge() {
      if (over || !booting) return;
      show(true);
      clearTimeout(sayT);
      words(LINE.nudge);
      sayT = setTimeout(() => { if (!over) words(LINE.loading); }, 2600);
    },
    // the room can take over (mode "live"): the boot's steps are done; the hand-over's are still to come
    ready() {
      if (marks.ready) return;
      marks.ready = T();
      booting = false;
      clearTimeout(sayT);
      words(LINE.loading);
      for (const step of ["model", "tex", "light", "outside", "warm"]) done[step] = 1;
      paint();
    },
    // the hand-over's steps (the router): revealed (the 3D shown), window (its live view in), eased (the framing ease over)
    mark(name) {
      if (marks[name]) return;
      marks[name] = T();
      if (name === "revealed") revealed = true;
      fv.progress(name, 1);
    },
    // the reveal (the router's): the hand-over's first step, whatever brought it (the boot's own, or a visitor's move)
    handover() { fv.mark("revealed"); },
    // the hand-over is over and the room at rest (or none will come by itself): the line ends, naming the room as it goes
    settled() {
      if (over) return;
      over = true;
      booting = false;
      marks.settled = T();
      clearTimeout(timer); clearTimeout(sayT);
      for (const step of Object.keys(STEPS)) done[step] = 1;
      paint();
      const intro = first && revealed && nav.spot === "desk" && nav.mode === "live";
      if (first && store(INTRO_KEY) !== "blocked") store(INTRO_KEY, "1");
      // never shown (a quick boot): it leaves as it came, nothing at all
      if (!shown) { finish(false); return; }
      box.classList.add("is-hint");
      words(coarse() ? LINE.hintTouch : LINE.hint);
      if (intro && mode === "a" && !reduced()) introduce();
      else if (intro && reduced()) { const els = names(); setTimeout(() => finish(true, els), HINT_MS + 800); skipOn(() => finish(true, els)); }
      else { setTimeout(() => finish(true), HINT_MS); skipOn(() => finish(true)); }
    },
    bootFailed() {
      over = true; booting = false;
      clearTimeout(timer); clearTimeout(sayT);
      show(false);
    },
    // a tap on an object in the live room (the router's link layer): the first one on a phone shows its name (a)
    activated(name) {
      if (tapped || !coarse() || mode !== "a" || !WORDS[name] || !gone) return;
      tapped = true;
      const at = place(name);
      if (at) { const el = label(name, at); setTimeout(() => { el.classList.remove("is-on"); setTimeout(() => el.remove(), 250); }, 1400); }
    },
    state: () => ({ shown, booting, over, revealed, gone, share: share(), done: { ...done }, marks: { ...marks }, intro: introState }),
  };

  // the pill (and the names with it) goes; after this nothing moves on its own
  let skipFn = null;
  function skipOn(fn) {
    skipFn = () => fn();
    for (const k of ["pointerdown", "wheel", "keydown", "touchstart"]) addEventListener(k, skipFn, { capture: true, passive: true });
  }
  function finish(fade, els = []) {
    if (gone) return;
    gone = true;
    if (skipFn) for (const k of ["pointerdown", "wheel", "keydown", "touchstart"]) removeEventListener(k, skipFn, true);
    if (introState === "running") { introState = "done"; clearTimeout(introT); nav.sheen?.hover(null); nav.light?.(); }
    show(false);
    for (const el of els.concat([...layer.querySelectorAll(".fv-label")])) el.classList.remove("is-on");
    marks.gone = T() + (fade && !reduced() ? FADE_MS : 0);   // (the fade's end: from here on, nothing on its own)
    setTimeout(() => { for (const el of [...layer.querySelectorAll(".fv-label")]) el.remove(); }, FADE_MS + 20);
  }

  // where an object's name goes: just above the top of its outline as the camera sees it (the link layer's), in the
  // hero's own box
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
  const order = () => INTRO.map((n) => [n, place(n)]).filter(([, at]) => at).sort((a, b) => a[1][0] - b[1][0]);
  // reduced motion: the names together, no sequence
  function names() { return order().map(([n, at]) => label(n, at)); }

  // ---------- the introduction (a): under the hint, as the line leaves ----------
  let introState = null, introT = 0;
  function introduce() {
    const list = order();
    if (!list.length) { setTimeout(() => finish(true), HINT_MS); skipOn(() => finish(true)); return; }
    introState = "running";
    skipOn(() => finish(true));
    let i = 0, cur = null;
    const next = () => {
      if (introState !== "running") return;
      if (i >= list.length) { introState = "done"; nav.sheen?.hover(null); nav.light?.(); finish(true, cur ? [cur] : []); return; }
      if (cur) { cur.classList.remove("is-on"); const c = cur; setTimeout(() => c.remove(), 250); }
      const [name] = list[i];
      const [lit, k] = nav.lightFor(name);
      nav.sheen?.hover(lit, k);
      cur = label(name, place(name) || list[i][1]);
      i++;
      introT = setTimeout(next, STEP_MS);
    };
    next();
  }

  return fv;
}
