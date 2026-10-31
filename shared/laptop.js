// The laptop in the live room is a computer you use (Akshay, 2026-10-15): the Projects page is on its screen at every
// distance, and leaning in (the laptop spot) frames the screen so you can use it there.
//
//   import { leanPose, LaptopScreen } from "/shared/laptop.js";
//   leanPose(room, w, h, { top, bottom, near })   // the laptop spot's rest pose for this screen: the screen square
//                                           // on, about 80 % of the width (near, desktops and tablets in landscape: up
//                                           // to 90 %; phones: nearly all of it), clear of the masthead and "Back to the
//                                           // desk"; focus on the screen
//   const ls = new LaptopScreen(room, { parent, onRoute, reduced });
//   await ls.ready;                         // the page is built (web/projects/screen.js)
//   ls.layout(leanPose(…), w, h)            // the page's layout box: a laptop browser's 1440 px, and its scale leaned in
//   ls.place(pose, w, h, { still })         // every frame: the page mapped onto the 3D screen (CSS matrix3d)
//   ls.narrow                               // phones and portrait tablets: the box the page takes leaned in, or null
//                                           // (phones, DYS-179, only with ?phonebox=1: the screen's size on screen over PHONE_K)
//   ls.small                                // the 1440 page too small to read leaned in (no narrow box for it)
//   ls.grown                                // leaned in, the page's width on screen over the lean-in's (1 at rest)
//   ls.glide(toLaptop, ms)                  // a glide to or from the laptop starts (the phones' change of layout)
//   ls.setLight(desk, lean, ms)             // the screen's white at the room's moment: at the desk, and leaned in
//   ls.keep(state); ls.keptState()          // what the screen showed in the site's last document: for the next lean-in
//
// The page is real DOM over the canvas, mapped onto the screen's quad (room3d.json objects.screen) with the same
// projection as the 3D (shared/rig.js project), so it sits on the screen exactly, frame for frame, at the desk, during
// the glide and leaned in. Its layout box is a real laptop browser's (nav-r1, Akshay 17 Oct: "why is this stuff so
// huge on the screen? why is not normal sized?"): 1440 CSS px wide, a MacBook's default, and as tall as the 3D
// screen's shape makes it (about 900), so the page takes its desktop layout and type, as on his laptop, and the
// whole box is scaled onto the screen. Leaned in and at rest the map is a whole-pixel translation and one scale
// (just the translation where the scale is 1), so the browser draws the text at its size on screen; native input
// works through the scale. Where the scaled page's 16 px body would be under 9 px on screen (phones, small
// windows), the screen shows the scaled desktop page at the desk and in every glide (the room's own picture of the
// screen and the photographs are that page), and leaned in the page is laid out again at the screen's own size on
// screen, 1:1 (v3/laptop-phone, Akshay 20 Oct: "why could we not just let them scroll thru the laptop instead?"): it
// takes its narrow layout, as a phone's browser of that width shows it, a finger scrolls it in place (the frame's own
// scrolling, with its momentum, clipped by the screen's edge) and a tap opens a project, as on desktop. The change of
// layout happens while the screen is small (a glide's start in, near its end out), a short dip through the page's
// white, keeping what was at the top of the screen. Only a screen under the
// page's least width that scaled would put its smallest running text under READ_PX (phones under ~316 px wide: SMALL)
// keeps the old way: a tap on it (or Enter) opens the Projects page itself in the lifted reading sheet, closing back
// to the lean-in; the laptop's screen and address then follow what the sheet showed. Its brightness is a real
// screen's at the room's moment (setLight: by day the photograph's own screen white, in a dark room a soft glow),
// eased to the lean-in's as the screen grows, and on the homepage it takes the page veil's share where it lies (gone
// leaned in), so the photograph hands over to the room with one screen. Further away the page is scaled down, as a screen seen from
// further away. It glows by its own light (it is not lit by the room) and the bezel, drawn by
// the 3D, frames it. Nothing in the room stands between the eye and the screen from the desk or the laptop; seen from
// another spot, any furniture box in front of it cuts it out (clip-path), so it is never drawn over what hides it.
import { project, sub, add, mul, dot, cross, normalize, len, yawPitchOf } from "./rig.js";
import { lensPose } from "./framing.js";
import { quadToQuad, cssMatrix } from "./overlays.js";
import { deskOccluders, disjointHulls } from "./occlude.js";
import { phoneNow } from "./device.js";


const FILL = 0.8;          // of the screen's width, leaned in (desktop)
const FILL_NEAR = 0.9;     // desktops and tablets, landscape (`near`; Akshay 23 Oct: "zoom a bit more into the computer")
const FILL_PHONE = 0.94;   // phones and other portrait screens
const PHONE_TAN_H = 0.3;   // portrait screens: the horizontal field leaned in (tan of half), 33 degrees
export const PAGE_W = 1440;  // CSS px: the frame's layout width, a laptop browser's (MacBook default 1440 x 900)
const BODY_PX = 16, SMALL_PX = 9;   // the page's body type, and the least it may be on screen to be used in place
// leaned in on phones (v3/laptop-phone): the page's least layout width (its body's min-width), its smallest running
// text in its narrow layout (the list's one-line descriptions), and the least that text may be on screen
const NARROW_MIN = 320, NARROW_TEXT = 14, READ_PX = 13;
// DYS-33 (Akshay 28 Oct, (a): "i want the laptop to look with reasonably sized text the way our computer shows text size
// that looks reasonable on laptop when seen in desktop - i dont like reading sheets - theyre sloppy - and we shouldn't put
// reading sheets for anything even if its mobile"): where the laptop's screen is under NARROW_LEAST px on screen (phones)
// it keeps its own 1440 px page scaled to the screen, as a real laptop seen from there, and is read by zooming in (a
// pinch on the screen walks the eye up to it: shared/rig.js, the laptop's walk); no narrow box, and no reading sheet
// anywhere: the screen is never a cover that opens one. Portrait tablets keep the narrow box where it is readable.
const NARROW_LEAST = 600;
// DYS-179 (Akshay 30 Oct: on a phone the laptop's text is too small by default; no reading sheets, scale the real thing:
// "at the laptop on a phone, the view moves in so the laptop's screen fills the phone's width and body text reads at
// about 14-16 CSS px at rest, like the desktop"). The lean-in already puts the screen across 94 % of a phone's width
// (FILL_PHONE; the sliver of bezel each side keeps the page on the laptop), but DYS-33's 1440 page there is drawn at
// about 0.25 of its size: his About at 4.5 px. No camera can fix that: a screen as wide as the phone and 15 px text
// need a page about as wide as the phone. So on a phone (shared/device.js, DYS-171's one rule), leaned in, the page is
// laid out again in a box the screen's size on screen over PHONE_K (about 407 x 254 on a 390 x 844 phone; at least
// NARROW_MIN wide), and drawn at PHONE_K: his page's own layout for that width (under its 720 px breakpoint),
// the About at 15 px x 1.1 x 0.9 = 14.9 px on screen (the desktop's lean-in: 15.4 px, its 1440 page at 0.876). Not
// DYS-33's 1:1 page ("gigantic": the same layout a tenth larger and edge to edge): drawn a little smaller than a
// phone's own browser would, inside the bezel, as a laptop's screen seen close. At the desk and in the glides the
// screen keeps the laptop's 1440 page (the photographs' page); the change of layout comes while the screen is small,
// as the glide in starts and near the glide out's end, through the page's short dip to white (glide, switchBox), as on
// portrait tablets. A pinch on it still walks the eye in (DYS-33 (a), DYS-159). Desktops and tablets: as before.
const PHONE_K = 0.9;
// DYS-179 round 2 (the smoke's pinch walk, LR1): with that page a pinch's old reach, ~4.5x (to SCREEN_STOP, shared/rig.js),
// put his About at ~66 px, and a slight pinch (the fingers 1.6x apart) went all the way. On a phone the pinch grows the
// page at most PHONE_PINCH_MAX over its lean-in (About 14.9 -> ~34 px; more than 2x, so a pinch still walks in), and as
// the fingers spread (rig.js walkBy: a 1.6x spread, 1.6x the page). The router hands it to the rig (screenScaleMax).
export const PHONE_PINCH_MAX = 2.3;
// DYS-179 off by default (Akshay 31 Oct 01:0x, on Deploy 11's stills of the phone's laptop: "that looks bad, it looks
// humongous"): the phone's box above (PHONE_K, PHONE_PINCH_MAX, and DYS-181's spacing in it) only with ?phonebox=1,
// read once from the page's first address. Without it a phone leaned in keeps DYS-33 (a)'s 1440 page scaled to the
// screen and read by a pinch, as in Deploy 10: no narrow box, pinchMax 0 (the rig's walk to SCREEN_STOP, uncapped), no
// data-sfw-box. Desktops and tablets: the same either way.
const PHONE_BOX = (() => { try { return new URLSearchParams(location.search).get("phonebox") === "1"; } catch { return false; } })();

export function screenQuad(room) {
  return room.objects?.screen?.quad || null;
}

// The laptop spot's rest pose for a w x h screen. The eye is on the screen's normal through its centre (square on:
// the screen is a rectangle on screen), at the distance where it fills FILL of the width, or the free height
// between `top` and `bottom` (px kept clear: "Back to the desk", the masthead) if that is less; a lens shift puts
// it in the middle of that free band. The lens is the spot's own (its vertical field), wider on portrait screens.
// near (desktops and tablets in landscape; Akshay, 23 Oct: "zoom a bit more into the computer? so that its more
// readable"): closer, up to FILL_NEAR of the width and the whole free band's height, the band then running from under
// "Back to the desk" to just above the masthead's words (the router's top and bottom), so a sliver of the bezel stays
// in view at the sides and the screen's white is never under either; where the band is the limit (16:10 and wider
// windows) that is less than FILL_NEAR.
export function leanPose(room, w, h, { top = 56, bottom = 104, near = false } = {}) {
  const q = screenQuad(room), spot = room.spots.laptop;
  if (!q || !spot) return null;
  const [TL, TR, BR, BL] = q;
  const C = mul(add(add(TL, TR), add(BR, BL)), 0.25);
  const r = normalize(sub(add(TR, BR), add(TL, BL)));
  const u = normalize(sub(add(TL, TR), add(BL, BR)));
  let n = normalize(cross(r, u));
  const hub = room.spots[room.hub || "desk"]?.eye || [0, 1.2, 1.2];
  if (dot(n, sub(hub, C)) < 0) n = mul(n, -1);
  const sw = (len(sub(TR, TL)) + len(sub(BR, BL))) / 2, sh = (len(sub(TL, BL)) + len(sub(TR, BR))) / 2;
  const aspect = w / h;
  let { tanV } = lensPose(spot);
  if (aspect < 1) tanV = Math.max(tanV, PHONE_TAN_H / aspect);
  const tanH = tanV * aspect;
  const free = Math.max(120, h - top - bottom);
  const wide = near && aspect >= 1;
  let px = (aspect < 1 ? FILL_PHONE : wide ? FILL_NEAR : FILL) * w;
  const fitH = wide ? 1 : 0.96;
  if ((px * sh) / sw > free * fitH) px = (free * fitH * sw) / sh;
  const d = (sw * w) / (2 * tanH * px);
  const { yaw, pitch } = yawPitchOf(mul(n, -1));
  const yc = top + free / 2;
  return {
    eye: add(C, mul(n, d)), yaw, pitch, tanV,
    shiftTan: [0, ((yc - h / 2) / (h / 2)) * tanV],
    focus: d, fstop: spot.fstop || 4,
  };
}

// Where a pose puts the screen's corners (CSS px, top-left, top-right, bottom-right, bottom-left), or null.
export function screenCorners(room, pose, w, h) {
  const q = screenQuad(room);
  if (!q || !pose) return null;
  const P = q.map((p) => project(pose, p, w, h));
  return P.some((p) => !p) ? null : P;
}

// ---------- occlusion ----------
// A ray from the eye to a point of the screen against the room's furniture boxes (not the laptop's own, nor the
// desk under it but its top board, with the things on the desk): the first box it enters before the screen, or null.
function rayBox(o, d, [a, b], tMax) {
  let t0 = 0, t1 = tMax;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < a[i] || o[i] > b[i]) return false; continue; }
    let ta = (a[i] - o[i]) / d[i], tb = (b[i] - o[i]) / d[i];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return t1 > 0 && t0 < tMax;
}

export class LaptopScreen {
  constructor(room, { parent, after = null, onRoute = () => {}, reduced = () => false, sheet = null, onPinch = null } = {}) {
    this.room = room;
    this.quad = screenQuad(room);
    // (and the desk's top board, from below it the desk hides the screen, and the things standing on the desk:
    // shared/occlude.js deskOccluders)
    this.occluders = [...(room.obstacles || []).filter((o) => o.box && !["laptop", "desk"].includes(o.name)), ...deskOccluders(room)];
    this.box = [0, 0];       // the page's layout box now (CSS px): PAGE_W wide, or `narrow` while leaned in on a phone
    this.wide = null;        // the laptop's box: PAGE_W wide, the 3D screen's shape tall
    this.narrow = null;      // phones: the box leaned in, the screen's size on screen (null: the laptop's box there too)
    this.lean = [0, 0];      // the screen's size on screen leaned in (CSS px)
    this.k = 1;              // the page's scale on screen leaned in
    this.grown = 1;          // leaned in, the screen's width on screen now over the lean-in's (a pinch's walk in: more; DYS-164)
    this.small = false;
    this.boxSeq = 0;
    this.narrowOn = false;   // phones: the narrow box in (a glide in, or leaned in)
    this.narrowWant = false; // ... and asked for (a dip may be under way)
    this.lightAt = null;     // { desk, lean }: the screen's white at the room's moment
    this.last = null;        // the last place() call's arguments (a change of box re-places the page at once)
    this.shown = false;
    this.active = false;
    this.onRoute = onRoute;
    this.reduced = reduced;
    this.sheet = sheet;
    this.onPinch = onPinch;  // (DYS-33: a pinch on the page, in client px, for the room's own zoom: the router's gestures)
    this.H = null;           // the box -> canvas homography the page was last placed with
    this.ready = import("/projects/screen.js").then(async (m) => {
      this.mod = m;
      // (DYS-33: no onTap: the screen never opens a reading sheet; two fingers on the page zoom the room, as off it)
      this.scr = await m.createScreen({ onRoute, reduced, onPinch: (ph, a, b) => this.pinch(ph, a, b) });
      this.host = this.scr.host;
      this.host.inert = true;
      this.host.setAttribute("aria-label", room.spots.laptop?.label || "");
      this.host.setAttribute("role", "region");
      // where it belongs in the tab order from the start: moving a frame in the document reloads it
      const a = after?.();
      if (a && a.parentNode === parent) a.after(this.host); else parent.appendChild(this.host);
      // (the screen is the real Projects page in a frame, live room 2: it loads once it is in the document)
      if (this.scr.ready) await this.scr.ready;
      return this;
    });
  }

  // The page's layout box: a laptop browser's, PAGE_W wide and the 3D screen's shape tall (the screen's size on
  // screen leaned in sets only the scale). (fontFor: the old screen's type rule; the real page keeps its own type.)
  // Where that page is too small to use leaned in (phones), the box there is the screen's own size on screen
  // (`narrow`, 1:1: the page's narrow layout), or the page's least width scaled down while its smallest running text
  // stays READ_PX or more; under that, none (`small`: the reading sheet).
  layout(lean, w, h) {
    const P = screenCorners(this.room, lean, w, h);
    if (!P || !this.scr) return;
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const lw = (d(P[0], P[1]) + d(P[3], P[2])) / 2, lh = (d(P[0], P[3]) + d(P[1], P[2])) / 2;
    if (!(lw > 0 && lh > 0)) return;
    const k = lw / PAGE_W, tooSmall = k * BODY_PX < SMALL_PX;
    let narrow = null, pinchMax = 0;
    // (DYS-117, Akshay 29 Oct: on a desktop the laptop shows the 1440 page as its resting still does, padded, at any window
    // size, never the narrow layout's edge-to-edge text: the narrow box is for touch screens only, portrait tablets)
    const touch = (navigator.maxTouchPoints || 0) > 0 || matchMedia("(pointer: coarse)").matches;
    // (DYS-179: a phone's box, the screen's size on screen over PHONE_K, so the page is drawn at PHONE_K: its text at
    // about 15 px; no READ_PX gate, there is no other way to read it. Only with ?phonebox=1, PHONE_BOX: without it a
    // phone's screen, under NARROW_LEAST, takes neither branch, DYS-33 (a)'s 1440 page)
    if (PHONE_BOX && tooSmall && phoneNow()) {
      const nw = Math.max(NARROW_MIN, Math.round(lw / PHONE_K));
      narrow = [nw, Math.round((lh * nw) / lw)];
      pinchMax = PHONE_PINCH_MAX;
    } else if (tooSmall && lw >= NARROW_LEAST && touch) {
      const nw = Math.max(NARROW_MIN, Math.round(lw)), kn = lw / nw;
      if (kn * NARROW_TEXT >= READ_PX) narrow = [nw, Math.round(lh / kn)];
    }
    this.lean = [lw, lh];
    this.veilInfo = undefined;   // (the veil's box: read again for this size)
    this.wide = [PAGE_W, Math.round((PAGE_W * lh) / lw)];
    this.narrow = narrow;
    this.pinchMax = pinchMax;   // (DYS-179: a phone's cap on the pinch, for the rig; 0 elsewhere)
    this.small = tooSmall && !narrow;   // (DYS-33: small now only says the page is read by zooming in; no cover, no sheet)
    this.scr.setSmall?.(this.small, 2 / k);
    this.applyBox();
    if (this.box[0]) this.k = lw / this.box[0];
  }

  // The box for now: the phones' narrow one once the lean-in has asked for it (glide in, or leaned in), else the
  // laptop's; the words at the top of the screen stay at the top. (A change re-places the page at once: the camera
  // may be at rest, with no frame of its own to come.)
  applyBox({ replace = false } = {}) {
    const want = this.narrowOn && this.narrow ? this.narrow : this.wide;
    if (!want || !this.scr) return;
    if (want[0] === this.box[0] && want[1] === this.box[1]) return;
    const had = this.box[0] > 0;
    this.box = want.slice();
    this.k = this.lean[0] / want[0];
    // (DYS-181: the page told when this is a phone's box, PHONE_K: pinchMax is set only in layout()'s phone branch.
    // There it takes less space above his About: web/projects/screen.js, data-sfw-box)
    this.scr.setSize(want[0], want[1], { keep: had, phone: want === this.narrow && this.pinchMax > 0 });
    if (replace && this.last) this.place(...this.last);
  }

  // A glide to or from the laptop starts (the router). Phones change layout while the screen is small: toward the
  // laptop at once (the desk's view of it), away from it near the glide's end (the desk's view again); each a short
  // dip through the page's white while the camera moves (reduced motion, or the page not showing: at once).
  glide(toLaptop, ms = 1400) {
    clearTimeout(this.glideT);
    const seq = ++this.boxSeq;
    const restore = toLaptop ? this.keptState() : null;
    if (toLaptop) this.kept = null;
    const go = () => { if (seq === this.boxSeq) this.switchBox(toLaptop, { restore }); };
    if (toLaptop || !this.narrowWant || !(ms > 0)) go();
    else this.glideT = setTimeout(go, ms * 0.78);
  }

  // (restore: a kept state, put back under the same dip, in the new box)
  async switchBox(on, { cut = false, restore = null } = {}) {
    this.narrowWant = on;
    const box = this.narrowOn !== on && !!this.narrow && !!this.scr;
    // (nothing to change: a dip an earlier call left on goes)
    if (!box && !(restore && this.scr)) { this.narrowOn = on; this.applyBox({ replace: true }); this.scr?.dip?.(false); return; }
    const seq = this.boxSeq;
    const dip = !cut && this.shown && !this.reduced() && !!this.scr.dip;
    if (dip) {
      await this.scr.dip(true);
      if (seq !== this.boxSeq) { if (restore && !this.kept) this.keep(restore); return; }   // (turned back: kept for the next)
    }
    this.narrowOn = on;
    this.applyBox({ replace: true });
    if (restore) this.scr.restore(restore);
    if (dip) this.scr.dip(false);
  }

  // What the screen showed when the visitor left the site's last document (the router, from sessionStorage), kept for
  // the next lean-in: until then the desk shows the page's top, as the homepage's photographs do, so the hand-over
  // shows one screen. Dropped once the screen is sent somewhere first (About, Projects, a project's address).
  keep(st) { this.kept = st && this.scr && (st.route || st.listTop > 0) ? { st, at: this.scr.changes } : null; }   // (the top: nothing to keep)
  keptState() { return this.kept && this.scr && this.kept.at === this.scr.changes ? this.kept.st : null; }

  // The screen's white at the room's moment (the router, from room3d.json's laptop_screen): at the desk, and leaned in;
  // ms: fade (a change of moment)
  setLight(desk, lean, ms = 0) {
    this.lightAt = desk ? { desk, lean: lean || desk } : null;
    this.lightNow = null;
    this.lightFade = ms;
    if (!desk) this.scr?.setLight?.(null, ms);
    else if (this.last) this.place(...this.last);
  }

  // The homepage's veil (style.css .veil: clear down to a point of its height, then darkening to its foot) lies over
  // the photograph and the room but not over this page: the page takes the veil's share where the screen is (on
  // phones the laptop sits in it at the desk), so the photograph's screen and the page hand over at one brightness.
  // Its box and gradient are read once per layout (the veil's computed gradient; else style.css's own numbers).
  veilOf() {
    if (this.veilInfo !== undefined) return this.veilInfo;
    const el = this.host?.ownerDocument.querySelector(".veil");
    if (!el || !this.host.parentElement) return (this.veilInfo = null);
    const b = el.getBoundingClientRect(), o = this.host.parentElement.getBoundingClientRect();
    if (!(b.height > 0)) return (this.veilInfo = null);
    let from = 0.68, amax = 0.55, rgb = "8, 6, 4";
    const stops = [...getComputedStyle(el).backgroundImage.matchAll(/rgba?\(([^)]*)\)\s*([\d.]+)%/g)].map((m) => ({ c: m[1].split(",").map((x) => +x), at: +m[2] / 100 }));
    if (stops.length >= 2) {
      const last = stops[stops.length - 1], clear = stops.filter((x) => (x.c[3] ?? 1) === 0).pop();
      if (last.c.length >= 3) { rgb = last.c.slice(0, 3).join(", "); amax = last.c[3] ?? 1; }
      if (clear) from = clear.at;
    }
    return (this.veilInfo = { top: b.top - o.top, height: b.height, from, amax, rgb });
  }

  // The screen's look for this frame: how far the lean-in has come (the screen's width against the lean-in's: none at
  // the desk, all leaned in; leaned in, the Projects document's first frames too, all) eases its white from the
  // desk's to the lean-in's and takes the veil's share away.
  screenLook(P) {
    if (!this.scr) return;
    const w = (Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]) + Math.hypot(P[2][0] - P[3][0], P[2][1] - P[3][1])) / 2;
    const s = this.active ? 1 : this.lean[0] > 0 ? Math.min(1, Math.max(0, (w / this.lean[0] - 0.3) / 0.7)) : 0;
    const L = this.lightAt;
    if (L && this.scr.setLight) {
      const c = L.desk.map((d, i) => d + (L.lean[i] - d) * s);
      // (within a third of a level the last one stands, except at the two ends: there it is exact)
      const tol = s === 0 || s === 1 ? 0 : 0.35;
      if (!this.lightNow || c.some((x, i) => Math.abs(x - this.lightNow[i]) > tol)) { this.lightNow = c; this.scr.setLight(c, this.lightFade || 0); this.lightFade = 0; }
    }
    const v = this.veilOf();
    if (!v || !this.scr.setShade) return;
    const yt = ((P[0][1] + P[1][1]) / 2 - v.top) / v.height, yb = ((P[3][1] + P[2][1]) / 2 - v.top) / v.height;
    const a = (y) => (1 - s) * v.amax * Math.min(1, Math.max(0, (y - v.from) / (1 - v.from)));
    const f = yt < v.from && yb > yt ? Math.min(1, Math.max(0, (v.from - yt) / (yb - yt))) : 0;
    const next = { rgb: v.rgb, a0: a(yt), f, a1: a(yb) };
    const prev = this.veilNow;
    // (a change too small to see waits for the next, but never the change to none or from none: leaned in it is gone)
    const on = (v) => v.a0 > 0.001 || v.a1 > 0.001;
    if (prev && on(prev) === on(next) && Math.abs(prev.a0 - next.a0) < 0.002 && Math.abs(prev.a1 - next.a1) < 0.002 && Math.abs(prev.f - next.f) < 0.005) return;
    this.veilNow = next;
    this.scr.setShade(next);
  }

  // Every frame: the page onto the screen's quad as this pose sees it. At rest and square on (leaned in) the map is
  // a whole-pixel translation, so the text is drawn sharp.
  place(pose, w, h, { still = false } = {}) {
    if (!this.host || !this.box[0]) return;
    this.last = [pose, w, h, { still }];
    const P = screenCorners(this.room, pose, w, h);
    if (!P) { this.host.style.visibility = "hidden"; this.grown = 1; return; }
    this.screenLook(P);
    // (DYS-164: how much larger than at the lean-in's rest the page is on screen, 1 there and away from the laptop; the
    // router's masthead steps aside on a phone while it is larger)
    const sw = (Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]) + Math.hypot(P[2][0] - P[3][0], P[2][1] - P[3][1])) / 2;
    this.grown = this.active && this.lean[0] > 0 ? sw / this.lean[0] : 1;
    this.host.style.visibility = this.shown ? "visible" : "hidden";
    // The page is the screen only while the whole screen is in front of the camera. Cut by the frame's edge (from
    // another spot: the window spot's tall framing on phones put a corner of it under the dial) it fades out, and the
    // 3D screen's own picture of the page shows there, softened with the room around it. Leaned in at the laptop it stays
    // (DYS-159, Akshay's phone 29 Oct: a pinch there walks the eye up to the screen, past the frame's edges at once on a
    // phone, where the screen fills 94 % of the width, and the 3D's picture showed instead, a white sheet at night): there
    // the page is what is read, however far the walk takes it.
    const inView = this.active || P.every((p) => p[0] >= -0.5 && p[0] <= w + 0.5 && p[1] >= -0.5 && p[1] <= h + 0.5);
    if (inView !== this.inView) { this.inView = inView; this.host.style.opacity = inView ? "" : "0"; }
    const S = P.map((p) => [p[0], p[1]]);
    const [bw, bh] = this.box;
    const axis = Math.abs(S[0][1] - S[1][1]) < 0.35 && Math.abs(S[3][1] - S[2][1]) < 0.35 && Math.abs(S[0][0] - S[3][0]) < 0.35 && Math.abs(S[1][0] - S[2][0]) < 0.35;
    // square on and still: a whole-pixel translation and one scale (none at 1), so the text is drawn at its size on
    // screen; the scale is the on-screen width over the box's, the height must agree (a square-on view of the screen)
    const k = (S[1][0] - S[0][0]) / bw;
    this.H = quadToQuad([[0, 0], [bw, 0], [bw, bh], [0, bh]], S);   // (DYS-33: also how a finger on the page maps out)
    if (still && axis && k > 0 && Math.abs(S[3][1] - S[0][1] - k * bh) < 0.75 + 0.5 * k) {   // (bh is whole px: k / 2 of rounding)
      const t = `translate(${Math.round(S[0][0])}px, ${Math.round(S[0][1])}px)`;
      this.host.style.transform = Math.abs(k - 1) * bw < 0.5 ? t : `${t} scale(${+k.toFixed(6)})`;
    } else {
      const H = this.H;
      if (H) this.host.style.transform = cssMatrix(H);
    }
    this.clip(pose, w, h, H_inv(S, bw, bh));
  }

  // DYS-33 (a): two fingers on the page (the frame's client px, which are the box's) passed out as client px of this
  // document, through the screen's placement now, to the room's own pinch (the router's gestures: zoom, and pan walked in)
  pinch(phase, a, b) {
    if (!this.onPinch) return;
    if (phase === "end") { this.onPinch("end"); return; }
    const H = this.H, r = this.host?.parentElement?.getBoundingClientRect();
    if (!H || !r) return;
    const out = ([x, y]) => { const w = H[6] * x + H[7] * y + H[8]; return [r.left + (H[0] * x + H[1] * y + H[2]) / w, r.top + (H[3] * x + H[4] * y + H[5]) / w]; };
    this.onPinch(phase, out(a), out(b));
  }

  // Furniture between the eye and the screen (seen from another spot): those parts of the page are cut out, in the
  // page's own coordinates, so it never draws over what stands in front of it.
  clip(pose, w, h, toLocal) {
    let hit = false;
    const e = pose.eye, q = this.quad;
    const pts = [];
    for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) {
      const u = i / 4, v = j / 4;
      const top = add(q[0], mul(sub(q[1], q[0]), u)), bot = add(q[3], mul(sub(q[2], q[3]), u));
      pts.push(add(top, mul(sub(bot, top), v)));
    }
    const blockers = new Set();
    for (const p of pts) {
      const dv = sub(p, e), L = len(dv), dn = mul(dv, 1 / L);
      for (const o of this.occluders) if (rayBox(e, dn, o.box, L - 0.01)) { blockers.add(o); hit = true; }
    }
    if (!hit || !toLocal) { if (this.clipped) { this.host.style.clipPath = ""; this.clipped = false; } return; }
    // each blocker's box outline on screen, taken into the page's coordinates, cut out of the page (evenodd)
    const [bw, bh] = this.box;
    let path = `M0 0H${bw}V${bh}H0Z`;
    const hulls = [];
    for (const o of blockers) {
      const [a, b] = o.box;
      const corners = [];
      for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) corners.push([x, y, z]);
      const S = corners.map((c) => project(pose, c, w, h)).filter(Boolean).map((p) => toLocal(p[0], p[1])).filter(Boolean);
      hulls.push(hull(S));
    }
    // (overlapping outlines merged: an evenodd path shows again where two holes overlap, occlude.js disjointHulls)
    for (const hl of disjointHulls(hulls)) path += `M${hl.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L")}Z`;
    this.host.style.clipPath = `path(evenodd, "${path}")`;
    this.clipped = true;
  }

  setShown(on) {
    this.shown = on;
    if (this.host) this.host.style.visibility = on ? "visible" : "hidden";
  }

  // Leaned in: the page takes the pointer and the keyboard (too small to use in place: the tap that opens it);
  // elsewhere it is part of the room (inert). On phones the narrow box comes with the glide in and goes near the
  // glide's end out (glide); without a glide of its own (the Projects document from its first frame, a cut with
  // reduced motion) it comes, or goes, at once.
  setActive(on) {
    this.active = on;
    if (!this.host) return;
    this.host.inert = !on;
    this.host.classList.toggle("is-on", on);
    if (this.last) this.place(...this.last);   // (its look: leaned in or not)
    // (alive again: its page laid out once more, so a layout it took while inert takes the finger: projects/screen.js)
    if (on) requestAnimationFrame(() => { if (this.active) this.scr?.refresh?.(); });
    if (on && this.narrow && !this.narrowWant) { clearTimeout(this.glideT); ++this.boxSeq; this.switchBox(true, { cut: true }); }
    // (leaving: the router starts the glide out just after this; none by the next frame, the laptop's box at once)
    if (!on && this.narrowWant) {
      const seq = this.boxSeq;
      requestAnimationFrame(() => { if (!this.active && seq === this.boxSeq && this.narrowWant) { ++this.boxSeq; this.switchBox(false, { cut: true }); } });
    }
  }

  // nav-r1 item 9: the Projects page itself in the lifted reading sheet (shared/reader.js, kind "frame"), lifted from
  // the laptop's screen (phones: it slides up), at the sheet's own size, so the page takes its narrow layout there:
  // it scrolls, its projects and their back link work inside the sheet (the frame's own routes, no history of the
  // room's). It opens on what the screen shows; closing returns to the lean-in, and the screen, then the room's
  // address (onRoute: a history entry, as a project opened in place), follow what the sheet showed last.
  async openSheet() {
    if (!this.small || !this.active || this.sheetOpen || !this.mod) return;
    const reader = await this.readerOf().catch(() => null);
    if (!reader || reader.isOpen || this.sheetOpen) return;
    this.sheetOpen = true;
    let route = this.scr.route ?? null;
    const sc = this.mod.createScreen({ reduced: this.reduced, className: "rd-frame", onRoute: (slug) => { route = slug ?? null; } });
    sc.restore({ route, top: 0, listTop: 0 });
    const done = (e) => {
      if (e.detail?.slug !== "projects") return;
      document.removeEventListener("reader:closed", done);
      this.sheetOpen = false;
      sc.pause(true);
      sc.host.remove();   // (the frame goes with its sheet: a second copy of the page is not kept loaded)
      if (route !== (this.scr.route ?? null)) { this.scr.show(route); this.onRoute(route, { push: true }); }
      this.scr.heading()?.focus({ preventScroll: true });
    };
    document.addEventListener("reader:closed", done);
    // the page's heading takes focus once it is drawn in the sheet (as leaning in to the laptop focuses it)
    sc.ready.then(() => {
      if (!reader.isOpen || reader.slug !== "projects") return;
      const h = sc.heading();
      if (h && !h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1");
      h?.focus({ preventScroll: true });
    }).catch(() => {});
    const from = () => { const r = this.host?.getBoundingClientRect(); return r && r.width > 4 && this.active ? r : null; };
    const page = { label: "Projects", kind: "frame", build: () => sc.host, scroller: () => sc.scroller || sc.host };
    try { await reader.open({ slug: "projects", page }, from); } catch { done({ detail: { slug: "projects" } }); }
  }

  // the room's reading sheet (the essays' own, one per document): handed over by the router (`sheet`), else the
  // router's own, found through its module (the one router of this document)
  readerOf() {
    if (this.sheet) return Promise.resolve(this.sheet());
    return import("./router.js").then((m) => m.startRouter()?.startReader?.() || null);
  }
}

// The inverse of the page-to-screen map: a screen point (CSS px) in the page's own coordinates.
function H_inv(S, bw, bh) {
  const H = quadToQuad(S, [[0, 0], [bw, 0], [bw, bh], [0, bh]]);
  if (!H) return null;
  return (x, y) => {
    const k = H[6] * x + H[7] * y + H[8];
    if (Math.abs(k) < 1e-9) return null;
    return [(H[0] * x + H[1] * y + H[2]) / k, (H[3] * x + H[4] * y + H[5]) / k];
  };
}

function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

