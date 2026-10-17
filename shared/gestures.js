// Pointer and touch in the live room: drags orbit, the wheel and pinches zoom (a dolly, shared/rig.js zoomBy),
// quick sideways flicks step between shelf, desk and print, taps pick, the mouse alone only sways the view
// outside; plus the phone's edge tabs and the boot tier.
//
//   import { Gestures, bootTier, EdgeTabs } from "/shared/gestures.js";
//   new Gestures(heroEl, { rig, onTap, onFlick, onSway, onDown, onDragStart, onZoom, pageScrolls });
//
// Plan 4.5 and 1.1, with Akshay's 2026-10-15 decision (zoom like felixrieseberg.com):
//   - the scroll wheel over the room zooms (deltaY < 0: closer), eased, within the spot's limits; a trackpad pinch
//     arrives as ctrl+wheel and zooms the same way, and the browser's own page zoom is held back while the room is
//     live (keyboard page zoom is untouched);
//   - where the page has more to read below the room (Books, Quotes), the wheel hands over: once the zoom is all
//     the way out, scrolling on moves the page, and the wheel zooms again once the page is back at its top;
//   - wheel and pinch inside a card that scrolls (the homepage's text) scroll the card, never the room;
//   - touch: two fingers pinch the camera closer or further; one finger orbits. Where the page has nothing below
//     (the homepage with its card) a one-finger drag turns the view any way; where it has (a page), vertical
//     drags scroll the page as before (`touch-action: pan-y`) and sideways drags turn;
//   - with the 3D off (photographs, reduced motion from the start, no WebGL) none of this is attached: the wheel
//     scrolls and the browser's pinch-zoom works as always;
//   - a drag that is mainly sideways turns the view within the spot's limits and stays there (on phones too);
//   - a flick (over 48 px, under 350 ms) steps between shelf, desk and print;
//   - a tap picks; fetching starts as soon as the finger touches down (onDown);
//   - a drag that starts on an object's outline still orbits, and then that click is swallowed;
//   - leaned in to the laptop (wheelTo gives its screen's scroller) the wheel anywhere over the room scrolls the screen,
//     and nothing zooms there (noZoom); on the screen itself pointer, wheel and touch are the page's own.

const NO_DRAG = "input, select, textarea, button, .masthead, .reader, .pager, .sfw-close, .sfw-edge, .sfw-about, .about, .tip, .sfw-screen.is-on, [contenteditable]";
const CARD = ".sfw-about, .about, .reader, .pager, .sfw-screen.is-on";   // reading surfaces: the wheel scrolls them, never the room
const ROOM_ELSEWHERE = ".sfw-page .hero";               // a hosted page's first screen lies over the room (its spines)
const LATCH_MS = 300;            // a wheel gesture that went to the page stays the page's until it pauses this long
const FLICK_PX = 48, FLICK_MS = 350, SLOP = 4, TOUCH_SLOP = 8;
const WHEEL_M_PER_PX = 0.0016;   // a mouse notch (100 px) moves the eye 16 cm
const PINCH_M_PER_UNIT = 0.012;  // ctrl+wheel units (Chrome/Safari: about 100 x ln(scale) per event)
const TOUCH_PINCH_M = 0.9;       // m per e-fold of finger spread (fingers twice as far apart: 0.62 m closer)

export class Gestures {
  constructor(el, { rig, onTap = () => {}, onFlick = () => {}, onSway = () => {}, onDown = () => {}, onDragStart = () => {}, onZoom = () => {}, enabled = () => true, pageScrolls = () => true, wheelTo = () => null, noZoom = () => false } = {}) {
    this.el = el;
    this.rig = rig;
    this.cb = { onTap, onFlick, onSway, onDown, onDragStart, onZoom };
    this.enabled = enabled;
    this.pageScrolls = pageScrolls;   // false: the page has nothing below the room (vertical drags turn the view)
    this.wheelTo = wheelTo;           // a scroller the wheel over the room scrolls instead of zooming (the laptop's screen)
    this.noZoom = noZoom;
    this.p = null;
    this.touches = new Map();         // touch pointers down on the room: id -> [x, y]
    this.pinch = null;                // { d } while two fingers pinch
    this.swallow = false;
    el.classList.add("sfw-gestures");
    this.handlers = {
      wheel: (e) => this.wheel(e),
      pointerdown: (e) => this.down(e),
      pointermove: (e) => this.move(e),
      pointerup: (e) => this.up(e),
      pointercancel: (e) => this.cancel(e),
      // (touch is captured by the touched element at first; taking it over makes that element lose it: not ours)
      lostpointercapture: (e) => { if (e.target === el) this.cancel(e); },
      dragstart: (e) => { if (this.p) e.preventDefault(); },
      // a right-click (or ctrl+click) opens the context menu, which takes the mouseup: the pointer must not stay
      // down, or the next move with no button held would turn the view (live room 2: the phone's flip)
      contextmenu: () => { if (this.p?.type === "mouse") this.cancel({ pointerId: this.p.id }); },
      click: (e) => { if (this.swallow) { e.preventDefault(); e.stopPropagation(); this.swallow = false; } },
    };
    for (const [k, fn] of Object.entries(this.handlers)) el.addEventListener(k, fn, k === "click" ? { capture: true } : k === "wheel" ? { passive: false } : undefined);
    // a trackpad pinch over anything else on the page (a hosted page's card, the masthead of a page document) must
    // not zoom the browser page either while the room is live: it zooms the room
    this.ctrlWheel = (e) => {
      if (el.contains(e.target) || !this.enabled()) return;
      if (e.ctrlKey) this.wheel(e, true);
      else if (e.target.closest?.(ROOM_ELSEWHERE) && !e.target.closest(CARD)) this.wheel(e);   // over the hosted page's spines
      else this.pageWheel = performance.now();   // the page's own wheel (the list below the room): it holds the latch
    };
    addEventListener("wheel", this.ctrlWheel, { passive: false });
    this.sway = (e) => {
      if (e.pointerType !== "mouse" || this.p) return;
      this.cb.onSway((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
    };
    addEventListener("pointermove", this.sway, { passive: true });
  }

  // The wheel: zoom the room, or let the page (or a card) scroll. A trackpad pinch is ctrl+wheel.
  wheel(e, anywhere = false) {
    if (!this.enabled() || !this.rig) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    const dy = e.deltaY * unit;
    const to = this.wheelTo();
    if (to) {
      if (e.ctrlKey) { e.preventDefault(); return; }
      if (e.target.closest?.(CARD)) return;               // over the screen: its own scroll
      e.preventDefault();
      if (dy) to.scrollBy({ top: dy, left: 0 });
      return;
    }
    if (e.ctrlKey) {
      e.preventDefault();   // never the browser's page zoom while the room is live
      if (dy) this.zoom(-dy * PINCH_M_PER_UNIT);
      return;
    }
    if (anywhere || !dy || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    const t = performance.now();
    const toPage = () => { this.pageWheel = t; };
    if (e.target.closest?.(CARD)) return toPage();        // the card scrolls (overscroll-behavior keeps it there)
    // one wheel gesture (a fling, a trackpad's momentum) that reached the page stays the page's until it pauses,
    // so scrolling back up to the top does not run on into a zoom
    if (t - (this.pageWheel || -1e9) < LATCH_MS) return toPage();
    const se = document.scrollingElement || document.documentElement;
    const canScroll = this.pageScrolls() && se.scrollHeight > innerHeight + 1;
    if (canScroll && scrollY > 1) return toPage();        // the page is scrolled: the wheel is the page's
    if (canScroll && dy > 0) {
      const [lo] = this.rig.zoomLimits();
      if (this.rig.dollyT <= lo + 1e-4) return toPage();  // all the way out: scrolling on moves the page
    }
    e.preventDefault();
    this.zoom(-dy * WHEEL_M_PER_PX);
  }

  zoom(metres) {
    if (this.noZoom()) return;
    const moved = this.rig.zoomBy(metres);
    if (moved) this.cb.onZoom(moved);
  }

  down(e) {
    if (!this.enabled() || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (e.target.closest?.(NO_DRAG)) return;
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.touches.size === 2) {
        // a second finger: the one-finger drag (or tap) ends, the pinch begins
        if (this.p?.mode === "drag") this.rig?.release();
        if (this.p) this.p.mode = "pinch";
        const [a, b] = [...this.touches.values()];
        this.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1 };
        try { this.el.setPointerCapture(e.pointerId); } catch { /* fine */ }
        this.cb.onDragStart();
        return;
      }
      if (this.touches.size > 2) return;
    }
    if (this.p) return;
    this.p = { id: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now(), mode: "pending" };
    this.swallow = false;
    this.cb.onDown(e.clientX, e.clientY, e);
  }

  move(e) {
    if (this.pinch && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, [e.clientX, e.clientY]);
      const [a, b] = [...this.touches.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      this.zoom(Math.log(d / this.pinch.d) * TOUCH_PINCH_M);
      this.pinch.d = d;
      return;
    }
    const p = this.p;
    if (!p || e.pointerId !== p.id) return;
    // a mouse that moves with no button held let go somewhere we did not hear (a menu, another window): it is up
    if (p.type === "mouse" && e.buttons === 0) { this.cancel(e); return; }
    const dx = e.clientX - p.x0, dy = e.clientY - p.y0;
    if (p.mode === "pending") {
      if (p.type === "mouse") {
        if (Math.hypot(dx, dy) < SLOP) return;
        p.mode = "drag";
      } else {
        // touch and pen: sideways turns the view; up and down is the page's (the browser scrolls, and cancels us)
        if (Math.abs(dx) < TOUCH_SLOP && Math.abs(dy) < TOUCH_SLOP) return;
        if (Math.abs(dx) > 1.6 * Math.abs(dy) || !this.pageScrolls()) p.mode = "drag";
        else { p.mode = "scroll"; return; }
      }
      try { this.el.setPointerCapture(p.id); } catch { /* fine */ }
      this.cb.onDragStart();
    }
    if (p.mode !== "drag") return;
    const mx = e.clientX - p.x, my = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    this.rig?.drag(mx, p.type === "mouse" || !this.pageScrolls() ? my : 0);
  }

  up(e) {
    if (this.touches.delete(e.pointerId) && this.pinch) {
      // the pinch ends with its first finger up; the other finger does nothing until it lifts too
      if (this.touches.size < 2) this.pinch = null;
      this.swallow = true;
      setTimeout(() => { this.swallow = false; }, 0);
      if (this.p && e.pointerId === this.p.id) this.p = null;
      return;
    }
    const p = this.p;
    if (!p || e.pointerId !== p.id) return;
    this.p = null;
    if (p.mode === "pinch") return;
    const dt = performance.now() - p.t0, dx = e.clientX - p.x0, dy = e.clientY - p.y0;
    if (p.mode === "drag") {
      this.swallow = true;
      setTimeout(() => { this.swallow = false; }, 0);
      this.rig?.release();
      if (p.type !== "mouse" && dt < FLICK_MS && Math.abs(dx) > FLICK_PX && Math.abs(dx) > 1.6 * Math.abs(dy)) this.cb.onFlick(dx > 0 ? -1 : 1);
      return;
    }
    if (p.mode === "pending") this.cb.onTap(e.clientX, e.clientY, e);
  }

  cancel(e) {
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.pinch = null;
    const p = this.p;
    if (!p || (e.pointerId != null && e.pointerId !== p.id)) return;
    this.p = null;
    if (p.mode === "drag") this.rig?.release();
  }

  destroy() {
    for (const [k, fn] of Object.entries(this.handlers)) this.el.removeEventListener(k, fn, k === "click" ? { capture: true } : undefined);
    removeEventListener("pointermove", this.sway);
    removeEventListener("wheel", this.ctrlWheel, { passive: false });
    this.el.classList.remove("sfw-gestures");
  }
}

// Whether to boot the 3D at all, before the engine's own one-frame benchmark and governor (E2): the floor is the
// living window plus dissolves (T0) for Save-Data, slow connections and devices that report little memory.
// Safari reports neither memory nor connection, so iPhones are left to the engine's benchmark.
export function bootTier() {
  const c = navigator.connection;
  if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ""))) return "T0";
  if (navigator.deviceMemory && navigator.deviceMemory < 4) return "T0";
  return "auto";
}

// Phones: tabs at the screen's edges show where a sideways flick goes, with the header's own words.
export class EdgeTabs {
  constructor(parent, { left, right, onGo }) {
    this.el = document.createElement("div");
    this.el.className = "sfw-edges";
    const tab = (side, item) => {
      if (!item) return null;
      const a = document.createElement("a");
      a.className = `sfw-edge ${side}`;
      a.href = item.href;
      a.textContent = item.text;
      a.addEventListener("click", (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onGo(item.spot);
      });
      return a;
    };
    for (const a of [tab("left", left), tab("right", right)]) if (a) this.el.appendChild(a);
    parent.appendChild(this.el);
  }
  show(on) { this.el.hidden = !on; }
  destroy() { this.el.remove(); }
}
