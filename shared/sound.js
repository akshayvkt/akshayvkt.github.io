// Sound: the site's soundscape, off until the visitor turns it on (docs/v3/briefs/sound-r1.md; the approved label
// "Sound", spec v2). This module is only the control and the API: a small speaker beside the clock's caption, no words
// (aria-label "Sound", aria-pressed), and nothing else runs until it is pressed. Pressed, it creates the AudioContext
// inside the click (browsers allow sound only after a gesture), loads the engine (shared/sound/engine.js and its
// modules, ~40 KB) and fades in over 3 s; pressed again, it fades out over 1.2 s and closes the context. The choice is
// remembered (localStorage "sfw-sound"); a returning visitor who left it on hears it again from their first click or
// key on the page (the icon shows it waiting). A hidden tab fades out and pauses; back, it fades in. The first visit
// ever gets one gentle cue: the speaker's waves breathe in and out once, a few seconds after the room is up (never
// with reduced motion).
//
//   import { mountSound, cue, pageTurn, soundOut, soundRoom } from "/shared/sound.js";
//   mountSound(mastheadEl)           // masthead.js, on every page
//   soundRoom(nav)                   // router.js: the live room (camera, city, objects) the sound follows
//   cue("lamp", { on: true })        // a touch in the room (engine.js CUES); does nothing while Sound is off
//   pageTurn({ dir: 1, dur: 0.72 })  // the notebook's page turn (router.js: pages.onTurn's lift; its land/fall noted)
//   soundOut()                       // { ctx, dest } while Sound plays (toys.js's buzzer shares the context), else null
//
// The class "sfw-sound" on <html> is set while Sound is on: toys.js's contract for the breadboard's chirp.
const KEY = "sfw-sound";
const SEEN = "sfw-sound-seen";
const root = document.documentElement;
const reducedQ = matchMedia("(prefers-reduced-motion: reduce)");
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

let btn = null, state = "off";          // off | waiting (on, before a gesture) | starting | on | stopping
let ctx = null, engine = null, world = null, room = null, startedAt = 0, gen = 0;
let lastPageTurn = -1e9;
const debug = new URLSearchParams(location.search).has("debug");

const ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="spk" d="M2.6 6.2h2.2l3-2.7v9l-3-2.7H2.6z"/>' +
  '<path class="w1" d="M10.3 6a2.9 2.9 0 0 1 0 4"/><path class="w2" d="M12.2 4.2a5.4 5.4 0 0 1 0 7.6"/></svg>';
const CSS = `
.sfw-now-row { display: inline-flex; align-items: center; max-width: 100%; }
/* the speaker sits after the caption without moving it: its width is taken back by the negative margin */
.sfw-speaker { position: relative; display: inline-grid; place-items: center end; width: 24px; height: 22px; margin: 0 -24px 0 0; padding: 0;
  border: 0; background: none; color: var(--on-scene-soft, rgba(244, 239, 230, 0.74)); cursor: pointer; font: inherit;
  -webkit-tap-highlight-color: transparent; transition: color 0.2s ease; }
.sfw-speaker::before { content: ""; position: absolute; inset: -11px -9px -11px 4px; }
.sfw-speaker svg { display: block; width: 15px; height: 15px; overflow: visible; fill: none; stroke: currentColor; stroke-width: 1.4;
  stroke-linecap: round; stroke-linejoin: round; filter: drop-shadow(0 1px 6px rgba(0, 0, 0, 0.4)); }
.sfw-speaker .w1, .sfw-speaker .w2 { opacity: 0; transition: opacity 0.5s ease; }
.sfw-speaker:hover, .sfw-speaker[aria-pressed="true"] { color: var(--on-scene, #f4efe6); }
.sfw-speaker[aria-pressed="true"] .w1, .sfw-speaker[aria-pressed="true"] .w2 { opacity: 1; }
.sfw-speaker.is-waiting .w1 { opacity: 0.5; } .sfw-speaker.is-waiting .w2 { opacity: 0; }
.sfw-speaker:focus-visible { outline: 2px solid var(--on-scene, #f4efe6); outline-offset: 1px; border-radius: 4px; }
.sfw-speaker.is-hint { color: var(--on-scene, #f4efe6); }
.sfw-speaker.is-hint .w1 { animation: sfw-sound-hint 2.6s ease-in-out 1 both; }
.sfw-speaker.is-hint .w2 { animation: sfw-sound-hint 2.6s ease-in-out 0.25s 1 both; }
@keyframes sfw-sound-hint { 0%, 100% { opacity: 0; } 40%, 60% { opacity: 0.9; } }
/* the window spot's docked clock: the speaker inside its box */
html.sfw-at-window .sfw-speaker { margin-right: 0; }
@media (prefers-reduced-motion: reduce) { .sfw-speaker, .sfw-speaker .w1, .sfw-speaker .w2 { transition: none; } .sfw-speaker.is-hint .w1, .sfw-speaker.is-hint .w2 { animation: none; } }
`;

function paint() {
  if (!btn) return;
  const on = state === "on" || state === "starting" || state === "waiting";
  btn.setAttribute("aria-pressed", String(on));
  btn.classList.toggle("is-waiting", state === "waiting");
  root.classList.toggle("sfw-sound", state === "on" || state === "starting");
}

export function mountSound(masthead) {
  const clock = masthead?.querySelector(".clock"), now = clock?.querySelector(".now");
  if (!now || btn) return;
  if (!document.querySelector("style[data-sfw-sound]")) {
    const s = document.createElement("style");
    s.setAttribute("data-sfw-sound", "");
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  const row = document.createElement("span");
  row.className = "sfw-now-row";
  now.replaceWith(row);
  btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sfw-speaker";   // (not "sfw-sound": that is <html>'s class while Sound plays)
  btn.setAttribute("aria-label", "Sound");          // the approved label; aria-pressed says on or off
  btn.innerHTML = ICON;
  row.append(now, btn);
  btn.addEventListener("click", onPress);
  if (store.get(KEY) === "1") { state = "waiting"; armGesture(); }
  paint();
  document.addEventListener("visibilitychange", onVisibility);
  // the first visit's cue: once, after the room has settled (and the desk's glint has passed)
  if (store.get(SEEN) !== "1" && state === "off") {
    const hint = () => {
      if (reducedQ.matches || state !== "off" || !btn) { store.set(SEEN, "1"); return; }
      btn.classList.add("is-hint");
      store.set(SEEN, "1");
      setTimeout(() => btn && btn.classList.remove("is-hint"), 3200);
    };
    const later = () => setTimeout(hint, 5500);
    if (document.readyState === "complete") later(); else addEventListener("load", later, { once: true });
  }
  if (debug) window.__sfwSound = { get state() { return state; }, get engine() { return engine; }, get ctx() { return ctx; }, get world() { return world; }, cue, pageTurn };
}

function onPress(e) {
  e.stopPropagation();
  if (state === "off" || state === "stopping") { store.set(KEY, "1"); start(); }
  else if (state === "waiting") start();
  else if (state === "starting" && performance.now() - startedAt < 400) { /* the gesture that just started it */ }
  else stop();
}

// a returning visitor who left Sound on: their first gesture on the page starts it
let gestureOff = null;
function armGesture() {
  const go = (e) => {
    if (e.type === "keydown" && (e.key === "Escape" || e.metaKey || e.ctrlKey || e.altKey)) return;
    disarm();
    if (state === "waiting") start();
  };
  const types = ["pointerup", "keydown", "touchend", "click"];
  for (const t of types) document.addEventListener(t, go, { capture: true });
  gestureOff = () => { for (const t of types) document.removeEventListener(t, go, { capture: true }); };
}
function disarm() { gestureOff?.(); gestureOff = null; }

function start() {
  disarm();
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { state = "off"; paint(); return; }
  const my = ++gen;
  state = "starting"; startedAt = performance.now();
  paint();
  try {
    try { ctx = new AC({ latencyHint: "playback" }); } catch { ctx = new AC(); }   // (a larger buffer: steadier on a busy page)
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  } catch (err) { console.warn("sound:", err && err.message); state = "off"; ctx = null; paint(); return; }
  Promise.all([import("./sound/engine.js"), import("./sound/world.js")]).then(async ([E, Wm]) => {
    if (my !== gen || state !== "starting") return;
    world = Wm.createWorld({ room: () => room, cue: (n, o) => cue(n, o), lastPageTurn: () => lastPageTurn });
    // phones and small machines: the piano with fewer partials and one string a note, the bells without their doublets
    const lite = matchMedia("(pointer: coarse)").matches || (navigator.hardwareConcurrency || 8) <= 4;
    engine = await E.createEngine(ctx, { world, lite });
    if (my !== gen || state !== "starting") { engine.stop(); return; }
    engine.start({ timer: true, fade: 3 });
    state = "on";
    paint();
  }).catch((err) => { console.warn("sound:", err && err.message); if (my === gen) shutdown(); });
}

function stop() {
  const my = ++gen;
  state = "stopping";
  store.set(KEY, null);
  paint();
  const e = engine, c = ctx;
  engine = null; world?.dispose?.(); world = null;
  const done = () => { try { e?.stop(); } catch { /* */ } c?.close?.().catch(() => {}); if (my === gen) { ctx = null; state = "off"; paint(); } };
  if (e && c && c.state === "running") e.fadeOut(1.2).then(done); else done();
}

function shutdown() { engine?.stop(); engine = null; world?.dispose?.(); world = null; ctx?.close?.().catch(() => {}); ctx = null; state = "off"; paint(); }

// a hidden tab fades out and pauses (the context suspended: no work at all); back, it fades in again
let hideTimer = null;
function onVisibility() {
  if (!engine || !ctx || state !== "on") return;
  clearTimeout(hideTimer);
  if (document.visibilityState === "hidden") {
    engine.fadeTo(0, 0.6);
    hideTimer = setTimeout(() => { if (document.visibilityState === "hidden" && ctx) { engine?.pause(); ctx.suspend().catch(() => {}); } }, 650);
  } else {
    ctx.resume().catch(() => {}).then(() => { engine?.resume(); engine?.fadeTo(1, 1.5); });
  }
}

// ---------------------------------------------------------------- the API
export function cue(name, opts = {}) {
  if (state !== "on" || !engine) return false;
  return engine.cue(name, opts, opts.delay ? ctx.currentTime + opts.delay : null);
}
// The page turn (shared/pageturn.js's pages.onTurn; router.js wires it): call it as the leaf starts to lift, dir 1
// forward, -1 back, dur the turn's length (s): the lift, the leaf's sweep and crinkle, its settling at dur. A turn's
// landing or falling back ({ type: "land" | "fall" }) sounds nothing: it only tells the index's leaf watch
// (sound/world.js) that the leaf's change is the turn already heard (a drag held longer than a second would otherwise
// sound the page again as it lands).
export function pageTurn({ type = "lift", dir = 1, dur = 0.65 } = {}) {
  lastPageTurn = performance.now();
  return type === "lift" ? cue("page", { dir, dur }) : false;
}
export function soundOut() { return state === "on" && engine && ctx ? { ctx, dest: engine.touchOut } : null; }
export function soundRoom(nav) { room = nav; }
export const soundState = () => state;
