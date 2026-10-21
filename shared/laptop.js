// The laptop in the live room is a computer you use (Akshay, 2026-10-15): the Projects page is on its screen at every
// distance, and leaning in (the laptop spot) frames the screen so you can use it there.
//
//   import { leanPose, LaptopScreen } from "/shared/laptop.js";
//   leanPose(room, w, h, { top, bottom })   // the laptop spot's rest pose for this screen: the screen square on,
//                                           // about 80 % of the width (phones: nearly all of it), clear of the
//                                           // masthead and "Back to the desk"; focus on the screen
//   const ls = new LaptopScreen(room, { parent, onRoute, reduced });
//   await ls.ready;                         // the page is built (web/projects/screen.js)
//   ls.layout(leanPose(…), w, h)            // the page's layout box: a laptop browser's 1440 px, and its scale leaned in
//   ls.place(pose, w, h, { still })         // every frame: the page mapped onto the 3D screen (CSS matrix3d)
//   ls.small                                // the page too small to use in place: a tap opens it in the reading sheet
//
// The page is real DOM over the canvas, mapped onto the screen's quad (room3d.json objects.screen) with the same
// projection as the 3D (shared/rig.js project), so it sits on the screen exactly, frame for frame, at the desk, during
// the glide and leaned in. Its layout box is a real laptop browser's (nav-r1, Akshay 17 Oct: "why is this stuff so
// huge on the screen? why is not normal sized?"): 1440 CSS px wide, a MacBook's default, and as tall as the 3D
// screen's shape makes it (about 900), so the page takes its desktop layout and type, as on his laptop, and the
// whole box is scaled onto the screen. Leaned in and at rest the map is a whole-pixel translation and one scale
// (just the translation where the scale is 1), so the browser draws the text at its size on screen; native input
// works through the scale. Where the scaled page's 16 px body would be under 9 px on screen (phones, small
// windows: SMALL) the screen still shows the scaled desktop page, and a tap on it (or Enter) opens the Projects page
// itself in the lifted reading sheet (its own narrow layout there), closing back to the lean-in; the laptop's screen
// and address then follow what the sheet showed. Further away the same page is scaled down, as a screen seen from
// further away. It glows by its own light (it is not lit by the room) and the bezel, drawn by
// the 3D, frames it. Nothing in the room stands between the eye and the screen from the desk or the laptop; seen from
// another spot, any furniture box in front of it cuts it out (clip-path), so it is never drawn over what hides it.
import { project, sub, add, mul, dot, cross, normalize, len, yawPitchOf } from "./rig.js";
import { lensPose } from "./framing.js";
import { quadToQuad, cssMatrix } from "./overlays.js";

const FILL = 0.8;          // of the screen's width, leaned in (desktop)
const FILL_PHONE = 0.94;   // phones and other portrait screens
const PHONE_TAN_H = 0.3;   // portrait screens: the horizontal field leaned in (tan of half), 33 degrees
export const PAGE_W = 1440;  // CSS px: the frame's layout width, a laptop browser's (MacBook default 1440 x 900)
const BODY_PX = 16, SMALL_PX = 9;   // the page's body type, and the least it may be on screen to be used in place

export function screenQuad(room) {
  return room.objects?.screen?.quad || null;
}

// The laptop spot's rest pose for a w x h screen. The eye is on the screen's normal through its centre (square on:
// the screen is a rectangle on screen), at the distance where it fills FILL of the width, or the free height
// between `top` and `bottom` (px kept clear: "Back to the desk", the masthead) if that is less; a lens shift puts
// it in the middle of that free band. The lens is the spot's own (its vertical field), wider on portrait screens.
export function leanPose(room, w, h, { top = 56, bottom = 104 } = {}) {
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
  let px = (aspect < 1 ? FILL_PHONE : FILL) * w;
  if ((px * sh) / sw > free * 0.96) px = (free * 0.96 * sw) / sh;
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
// desk under it): the first box it enters before the screen, or null.
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
  constructor(room, { parent, after = null, onRoute = () => {}, reduced = () => false, sheet = null } = {}) {
    this.room = room;
    this.quad = screenQuad(room);
    this.occluders = (room.obstacles || []).filter((o) => o.box && !["laptop", "desk"].includes(o.name));
    this.box = [0, 0];       // the page's layout box (CSS px): PAGE_W wide
    this.lean = [0, 0];      // the screen's size on screen leaned in (CSS px)
    this.k = 1;              // the page's scale on screen leaned in
    this.small = false;
    this.shown = false;
    this.active = false;
    this.onRoute = onRoute;
    this.reduced = reduced;
    this.sheet = sheet;
    this.ready = import("/projects/screen.js").then(async (m) => {
      this.mod = m;
      this.scr = await m.createScreen({ onRoute, reduced, onTap: () => this.openSheet() });
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
  layout(lean, w, h) {
    const P = screenCorners(this.room, lean, w, h);
    if (!P || !this.scr) return;
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const lw = (d(P[0], P[1]) + d(P[3], P[2])) / 2, lh = (d(P[0], P[3]) + d(P[1], P[2])) / 2;
    if (!(lw > 0 && lh > 0)) return;
    const bw = PAGE_W, bh = Math.round((PAGE_W * lh) / lw);
    const k = lw / PAGE_W, small = k * BODY_PX < SMALL_PX;
    this.lean = [lw, lh];
    this.k = k;
    this.small = small;
    this.scr.setSmall?.(small, 2 / k);
    if (bw === this.box[0] && bh === this.box[1]) return;
    this.box = [bw, bh];
    this.scr.setSize(bw, bh);
  }

  // Every frame: the page onto the screen's quad as this pose sees it. At rest and square on (leaned in) the map is
  // a whole-pixel translation, so the text is drawn sharp.
  place(pose, w, h, { still = false } = {}) {
    if (!this.host || !this.box[0]) return;
    const P = screenCorners(this.room, pose, w, h);
    if (!P) { this.host.style.visibility = "hidden"; return; }
    this.host.style.visibility = this.shown ? "visible" : "hidden";
    // The page is the screen only while the whole screen is in front of the camera. Cut by the frame's edge (from
    // another spot: the window spot's tall framing on phones put a corner of it under the dial) it fades out, and the
    // 3D screen's own picture of the page shows there, softened with the room around it.
    const inView = P.every((p) => p[0] >= -0.5 && p[0] <= w + 0.5 && p[1] >= -0.5 && p[1] <= h + 0.5);
    if (inView !== this.inView) { this.inView = inView; this.host.style.opacity = inView ? "" : "0"; }
    const S = P.map((p) => [p[0], p[1]]);
    const [bw, bh] = this.box;
    const axis = Math.abs(S[0][1] - S[1][1]) < 0.35 && Math.abs(S[3][1] - S[2][1]) < 0.35 && Math.abs(S[0][0] - S[3][0]) < 0.35 && Math.abs(S[1][0] - S[2][0]) < 0.35;
    // square on and still: a whole-pixel translation and one scale (none at 1), so the text is drawn at its size on
    // screen; the scale is the on-screen width over the box's, the height must agree (a square-on view of the screen)
    const k = (S[1][0] - S[0][0]) / bw;
    if (still && axis && k > 0 && Math.abs(S[3][1] - S[0][1] - k * bh) < 0.75 + 0.5 * k) {   // (bh is whole px: k / 2 of rounding)
      const t = `translate(${Math.round(S[0][0])}px, ${Math.round(S[0][1])}px)`;
      this.host.style.transform = Math.abs(k - 1) * bw < 0.5 ? t : `${t} scale(${+k.toFixed(6)})`;
    } else {
      const H = quadToQuad([[0, 0], [bw, 0], [bw, bh], [0, bh]], S);
      if (H) this.host.style.transform = cssMatrix(H);
    }
    this.clip(pose, w, h, H_inv(S, bw, bh));
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
    for (const o of blockers) {
      const [a, b] = o.box;
      const corners = [];
      for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) corners.push([x, y, z]);
      const S = corners.map((c) => project(pose, c, w, h)).filter(Boolean).map((p) => toLocal(p[0], p[1])).filter(Boolean);
      const hl = hull(S);
      if (hl.length > 2) path += `M${hl.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L")}Z`;
    }
    this.host.style.clipPath = `path(evenodd, "${path}")`;
    this.clipped = true;
  }

  setShown(on) {
    this.shown = on;
    if (this.host) this.host.style.visibility = on ? "visible" : "hidden";
  }

  // Leaned in: the page takes the pointer and the keyboard (too small to use in place: the tap that opens it);
  // elsewhere it is part of the room (inert).
  setActive(on) {
    this.active = on;
    if (!this.host) return;
    this.host.inert = !on;
    this.host.classList.toggle("is-on", on);
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

