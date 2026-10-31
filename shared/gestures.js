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
//   - touch on the Books page's spines (buttons on the 3D shelf; a hosted page's lie over the room, outside its hero):
//     a drag, flick or pinch that starts on one is the room's, a tap stays the spine's (qa-night B-F6); the mouse
//     there is the spine's, as before;
//   - leaned in to the laptop (wheelTo gives its screen's scroller) the wheel anywhere over the room scrolls the screen,
//     and nothing zooms there (noZoom) but two fingers (DYS-33 (a): a pinch walks toward the screen to read it, from on
//     the page too: the laptop passes its fingers to pinchFrom; DYS-159: fingers drawn a little together as they lift
//     do not step back out); on the screen one finger, the wheel and a pointer are the page's own;
//   - v3/zoom: every zoom says where it points (toCanvas: the pointer, or the pinch's middle, in the canvas's CSS px)
//     and how many of its metres make an e-fold of magnification, so the window's magnifier keeps that point still
//     and a pinch tracks the fingers; a second tap or click within 350 ms on the same place is onDouble (the router
//     resets the magnifier with it at the window, and treats it as a tap everywhere else).

const NO_DRAG = "input, select, textarea, button, .masthead, .quiet-corner, .reader, .pager, .sfw-close, .sfw-edge, .sfw-about, .about, .tip, .sfw-screen.is-on, [contenteditable]";
const CARD = ".sfw-about, .about, .reader, .pager, .sfw-screen.is-on";   // reading surfaces: the wheel scrolls them, never the room
const ROOM_ELSEWHERE = ".sfw-page .hero";               // a hosted page's first screen lies over the room (its spines)
const ROOM_BUTTON = ".shelf .spine";                    // buttons on the room itself: a touch gesture there is the room's
const ELSEWHERE_EVENTS = ["pointerdown", "pointermove", "pointerup", "pointercancel", "click"];
const LATCH_MS = 300;            // a wheel gesture that went to the page stays the page's until it pauses this long
const FLICK_PX = 48, FLICK_MS = 350, SLOP = 4, TOUCH_SLOP = 8;
const WHEEL_M_PER_PX = 0.0016;   // a mouse notch (100 px) moves the eye 16 cm
const PINCH_M_PER_UNIT = 0.012;  // ctrl+wheel units (Chrome/Safari: about 100 x ln(scale) per event)
const TOUCH_PINCH_M = 0.9;       // m per e-fold of finger spread (fingers twice as far apart: 0.62 m closer)
// the magnifier's e-fold in each input's metres: a pinch magnifies exactly as the fingers spread (trackpad: ctrl+wheel
// units are about 100 x ln(scale)), a wheel notch about x1.25
const PER_LN = { wheel: 0.72, pinch: 100 * PINCH_M_PER_UNIT, touch: TOUCH_PINCH_M };
const DOUBLE_MS = 350, DOUBLE_PX = { mouse: 12, touch: 40, pen: 24 };
// DYS-159 (Akshay's iPhone, 29 Oct 23:52): a pinch on the laptop's page walked in, held still, then went back to the
// lean-in in one step as the fingers left the glass (the rig's 90 ms zoom ease from a standstill, t 5.08 s and 9.63 s;
// no resize's 600 ms ease, no browser zoom). Fingers drawn a little together as they lift are no pinch out: a step that
// brings them closer by less than a third waits RELEASE_MS, and a lift within that drops it
const RELEASE_MS = 120, RELEASE_IN = 2 / 3;
// (DYS-149 mt-diet2: a pinch keeps the canvas's box (toCanvas(0, 0): its place and size) from its start, read as the
// second finger lands (or the laptop's page passes its start), before the pinch's own writes; its steps do not read it
// again. A pinch does not move the canvas, and each step's read came after that frame's writes (the zoom's, or the other
// finger's step): a forced style + layout at every pointermove of a pinch, when the phone's GPU and main thread are
// busiest (MD1b). A scroll or a resize drops it (read again at the next step). The point under the fingers is the
// same number: x + (0 - left) is x - left exactly. ?mtdiet=0: every step reads, as before)
const MT_DIET = typeof location === "undefined" || new URLSearchParams(location.search).get("mtdiet") !== "0";

export class Gestures {
  constructor(el, { rig, onTap = () => {}, onFlick = () => {}, onSway = () => {}, onDown = () => {}, onDragStart = () => {}, onZoom = () => {}, onDouble = null, toCanvas = null, enabled = () => true, pageScrolls = () => true, wheelTo = () => null, noZoom = () => false } = {}) {
    this.el = el;
    this.rig = rig;
    this.cb = { onTap, onFlick, onSway, onDown, onDragStart, onZoom, onDouble };
    this.toCanvas = toCanvas;         // client px -> { x, y, w, h } in the canvas (the zoom's still point), or null
    this.lastTap = null;              // { t, x, y, type }: a second tap close by is a double tap
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
    // touch on a hosted page's spines (outside el): passed on here; a drag takes the pointer (setPointerCapture in
    // move), so the rest of it comes to el itself. A click that ends a drag there is swallowed as it is on el.
    this.elsewhere = (e) => {
      if (e.pointerType === "mouse" || el.contains(e.target)) return;
      if (e.type === "click") {
        if (this.swallow && e.target.closest?.(ROOM_ELSEWHERE)) { e.preventDefault(); e.stopPropagation(); this.swallow = false; }
        return;
      }
      if (e.type === "pointerdown") { if (e.target.closest?.(ROOM_ELSEWHERE) && e.target.closest(ROOM_BUTTON)) this.down(e); return; }
      if (this.touches.has(e.pointerId) || this.p?.id === e.pointerId) this.handlers[e.type](e);
    };
    for (const k of ELSEWHERE_EVENTS) addEventListener(k, this.elsewhere, k === "click" ? { capture: true } : { passive: true });
    this.sway = (e) => {
      // (v3/zoom-r3: zoomed, the sway follows the pointer through a drag too: held through one, it caught up at the next
      // move after it, a jump of the outside)
      if (e.pointerType !== "mouse" || (this.p && !this.rig?.zoomed)) return;
      this.cb.onSway((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
    };
    addEventListener("pointermove", this.sway, { passive: true });
    // (DYS-149 mt-diet2: a scroll anywhere or a resize drops the pinch's kept canvas box)
    this.dropBox = () => { if (this.pinch) this.pinch.box = null; if (this.framePinch) this.framePinch.box = null; };
    if (MT_DIET) { addEventListener("scroll", this.dropBox, { capture: true, passive: true }); addEventListener("resize", this.dropBox); }
  }

  // client px -> the canvas's CSS px (toCanvas), from the pinch P's kept canvas box where there is one (DYS-149 mt-diet2)
  canvasAt(x, y, P = null) {
    if (!MT_DIET || !P) return this.toCanvas(x, y);
    const b = (P.box ??= this.toCanvas(0, 0));
    return { x: x + b.x, y: y + b.y, w: b.w, h: b.h };
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
      if (dy) this.zoom(-dy * PINCH_M_PER_UNIT, e.clientX, e.clientY, PER_LN.pinch);
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
    this.zoom(-dy * WHEEL_M_PER_PX, e.clientX, e.clientY, PER_LN.wheel);
  }

  // One step of a two-finger pinch (a, b: the fingers in client px): the spread zooms toward their middle; at the laptop,
  // walked in, the middle's own move slides the view along the screen (DYS-33, shared/rig.js panWalk)
  // (zoom false: the slide alone, the spread kept for a later step: pinchFrom's held step back)
  pinchStep(P, a, b, { zoom = true } = {}) {
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (zoom) this.zoom(Math.log(d / P.d) * TOUCH_PINCH_M, c[0], c[1], PER_LN.touch, true, P);
    if (P.c && !this.noZoom("touch") && this.rig?.panWalk?.(c[0] - P.c[0], c[1] - P.c[1])) this.cb.onZoom(1e-6, null);
    if (zoom) P.d = d;
    P.c = c;
  }

  // DYS-33 (a): a pinch inside the laptop's page (its frame has the touches, the room never sees them): the laptop
  // passes the two fingers here in client px ("start" / "move" / "end"), and the room zooms and pans as for its own
  // (DYS-159: a step closer by less than a third, while the pinch is not already going out, slides now and steps back
  // RELEASE_MS later with the fingers as they are then; a lift before that drops it, so the page keeps its size. Closer
  // by a third or more, or held longer, it is a pinch out: from then on each step goes out at once, until they spread)
  pinchFrom(phase, a, b) {
    const P = this.framePinch;
    if (phase === "end" || !a || !b) { if (P) clearTimeout(P.hold); this.framePinch = null; return; }
    if (phase === "start" || !P) {
      if (P) clearTimeout(P.hold);
      const box = MT_DIET && this.toCanvas ? this.toCanvas(0, 0) : null;   // (DYS-149 mt-diet2: kept through the pinch)
      this.framePinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], hold: 0, next: null, out: false, box };
      this.cb.onDragStart();
      return;
    }
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
    if (d < P.d && !P.out && d > P.d * RELEASE_IN) {
      this.pinchStep(P, a, b, { zoom: false });
      P.next = [a, b];
      P.hold ||= setTimeout(() => {
        P.hold = 0;
        if (this.framePinch !== P || !P.next) return;
        P.out = true;
        this.pinchStep(P, ...P.next);
        P.next = null;
      }, RELEASE_MS);
      return;
    }
    clearTimeout(P.hold); P.hold = 0; P.next = null;
    if (d !== P.d) P.out = d < P.d;
    this.pinchStep(P, a, b);
  }

  // (v3/zoom-r3: touch says the point is a pinch's middle, which carries the direction under it with the fingers)
  // (DYS-149 mt-diet2: P, the pinch this step is of, with its kept canvas box)
  zoom(metres, cx, cy, perLn, touch = false, P = null) {
    if (this.noZoom(touch ? "touch" : "wheel")) return;
    const at = this.toCanvas && cx !== undefined ? this.canvasAt(cx, cy, P) : null;
    const moved = this.rig.zoomBy(metres, at ? { at, perLn, touch } : perLn ? { perLn } : undefined);
    if (moved) this.cb.onZoom(moved, at);
  }

  down(e) {
    if (!this.enabled() || (e.pointerType === "mouse" && e.button !== 0)) return;
    if (e.target.closest?.(NO_DRAG) && !(e.pointerType !== "mouse" && e.target.closest(ROOM_BUTTON))) return;
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.touches.size === 2) {
        // a second finger: the one-finger drag (or tap) ends, the pinch begins
        const box = MT_DIET && this.toCanvas ? this.toCanvas(0, 0) : null;   // (DYS-149 mt-diet2: kept through the pinch)
        if (this.p?.mode === "drag") this.rig?.release();
        if (this.p) this.p.mode = "pinch";
        const [a, b] = [...this.touches.values()];
        this.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], box };
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
      this.pinchStep(this.pinch, a, b);
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
      // (v3/zoom-r3: zoomed, the drag starts from here: the few px it took to tell a drag are not caught up in one frame)
      if (this.rig?.zoomed) { p.x = e.clientX; p.y = e.clientY; }
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
    if (p.mode === "pending") {
      // a second tap (or click) soon after the first, close to it: a double tap, when someone listens for one
      const L = this.lastTap, now = performance.now(), near = DOUBLE_PX[p.type] || 24;
      if (this.cb.onDouble && L && L.type === p.type && now - L.t < DOUBLE_MS && Math.hypot(e.clientX - L.x, e.clientY - L.y) < near) {
        this.lastTap = null;
        this.cb.onDouble(e.clientX, e.clientY, e);
        return;
      }
      this.lastTap = { t: now, x: e.clientX, y: e.clientY, type: p.type };
      this.cb.onTap(e.clientX, e.clientY, e);
    }
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
    for (const k of ELSEWHERE_EVENTS) removeEventListener(k, this.elsewhere, k === "click" ? { capture: true } : undefined);
    removeEventListener("scroll", this.dropBox, { capture: true }); removeEventListener("resize", this.dropBox);
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
