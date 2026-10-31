// The clock of the apartment, shared by every page: which moment we are in, the caption
// "The sky over San Francisco at …", the time dial under it, and the room palette.
//
//   import { initMasthead, getMoment, onMoment } from "/shared/masthead.js";
//   initMasthead();                        // wires .masthead (caption, dial) on this page
//   onMoment((m) => …);                    // m = { minutes, date, sel, frame, frames, reason }
//
// A "sky:moment" event with the same detail is also dispatched on document, and "sky:dial"
// ({ open }) when the dial opens or closes, so a page can preload the rest of the day.
import {
  getOverride, setOverride, sfDate, sunPosition, pickFrames, nearest,
  caption, applyPalette, loadScene, minutesNowSF,
} from "./sky.js";
import { mountSound } from "./sound.js";

const root = document.documentElement;
const listeners = new Set();
const state = {
  minutes: getOverride(),       // null = now
  frames: (self.SKY_FRAMES || []).slice(),
  full: false,                  // frames carry images (scene.json loaded)
  sel: null,
  frame: null,
  date: null,
};

// A time given in the address (?time=19:40) follows the visitor to the other pages, like a dial choice.
if (new URLSearchParams(location.search).has("time") && state.minutes !== null) setOverride(state.minutes);

function compute() {
  state.date = sfDate(state.minutes);
  if (!state.frames.length) return;
  state.sel = pickFrames(state.frames, sunPosition(state.date));
  state.frame = nearest(state.sel);
}
compute();

export function getMoment() {
  return { minutes: state.minutes, date: state.date, sel: state.sel, frame: state.frame, frames: state.frames, full: state.full };
}

export function onMoment(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(reason) {
  const detail = { ...getMoment(), reason };
  for (const fn of listeners) {
    try { fn(detail); } catch (e) { console.error(e); }
  }
  document.dispatchEvent(new CustomEvent("sky:moment", { detail }));
}

// Set the moment's colours. Dragging the dial snaps them (the photograph crossfades); when the
// clock itself moves on to the next rendered moment, or the dial goes back to now, the page dissolves.
function paint(prevId, reason) {
  const f = state.frame;
  if (!f) return;
  if (f.id === prevId && root.dataset.moment === f.id) return;
  const apply = () => {
    applyPalette(f);
    root.dataset.ink = f.ink;
    root.dataset.moment = f.id;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && f.palette) meta.content = f.palette.paper;
  };
  const slow = (reason === "tick" || reason === "reset") && prevId && document.startViewTransition &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches && document.visibilityState === "visible";
  if (!slow) { apply(); return; }
  root.classList.add("moment-change");
  let vt;
  // (PH3 29 Oct: on a photographs-only page Chrome can refuse the transition outright, "InvalidStateError: Transition
  // was aborted because of invalid state": the palette then changes at once)
  try { vt = document.startViewTransition(apply); } catch { root.classList.remove("moment-change"); apply(); return; }
  // a skipped transition rejects ready; neither may surface as an error
  vt.ready.catch(() => {});
  vt.updateCallbackDone?.catch(() => {});
  vt.finished.catch(() => {}).finally(() => root.classList.remove("moment-change"));
}

// Move to another time (minutes since midnight in San Francisco), or back to now with null.
export function setMinutes(minutes, reason = "dial") {
  const prev = state.frame && state.frame.id;
  state.minutes = minutes;
  setOverride(minutes);
  compute();
  paint(prev, reason);
  renderCaption();
  emit(reason);
}

let els = null;
function renderCaption() {
  if (els && els.now) els.now.textContent = caption(state.date);
}

// Measure the masthead so pages can size their views as "the rest of the screen".
function measure() {
  if (!els || !els.root) return;
  const h = els.root.getBoundingClientRect().height;
  if (h) root.style.setProperty("--mh", `${Math.round(h)}px`);
}

export function initMasthead(el = document.querySelector(".masthead")) {
  if (els) return getMoment();
  els = { root: el };
  paint(null);
  if (el) {
    els.now = el.querySelector(".now");
    els.dial = el.querySelector(".dial");
    els.range = el.querySelector('.dial input[type="range"]');
    els.reset = el.querySelector(".dial button");
    renderCaption();
    measure();
    if ("ResizeObserver" in window) new ResizeObserver(measure).observe(el);
    wireDial();
    mountSound(el);   // the Sound control beside the caption (shared/sound.js: nothing runs until it is pressed)
  }
  // the full scene (with images) replaces the head's lightweight frame list
  loadScene().then((scene) => {
    if (!scene || !scene.frames) return;
    state.frames = scene.frames;
    state.full = true;
    const prev = state.frame && state.frame.id;
    compute();
    paint(prev, "scene");
    emit("scene");
  }).catch((e) => console.warn("scene.json", e));

  // keep time while the page is open
  setInterval(() => {
    if (state.minutes !== null) return;
    const prev = state.frame && state.frame.id;
    compute();
    renderCaption();
    if (state.frame && state.frame.id !== prev) { paint(prev, "tick"); emit("tick"); }
  }, 20000);
  return getMoment();
}

function wireDial() {
  const { now, dial, range, reset } = els;
  if (!now || !dial) return;
  const setOpen = (open) => {
    dial.hidden = !open;
    now.setAttribute("aria-expanded", String(open));
    if (open && range) range.value = state.minutes ?? minutesNowSF();
    document.dispatchEvent(new CustomEvent("sky:dial", { detail: { open } }));
  };
  now.addEventListener("click", () => setOpen(dial.hidden));
  if (range) range.addEventListener("input", () => setMinutes(+range.value, "dial"));
  if (reset) reset.addEventListener("click", () => { setMinutes(null, "reset"); setOpen(false); now.focus(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !dial.hidden) { setOpen(false); now.focus(); }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!dial.hidden && !els.root.querySelector(".clock").contains(e.target)) setOpen(false);
  });
  if (new URLSearchParams(location.search).has("scrub")) setOpen(true);
}
