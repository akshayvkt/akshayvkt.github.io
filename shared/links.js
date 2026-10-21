// The keyboard and screen-reader layer of the live room: real links over each object's outline.
//
//   import { LinkLayer } from "/shared/links.js";
//   const links = new LinkLayer(svgParent, room, { tip, onFocusOff: (name) => rig.resetOrbit() });
//   links.update(pose, vw, vh)     // every frame the camera moves: the outlines follow it
//   links.setSpot("desk")          // which objects are offered at this spot (the ones it shows at rest)
//
// Tab order: shelf, laptop, print, notebook, phone, headphones, breadboard, then the window (plan 7). Each is an SVG
// <a href> (the window's, the phone's and the breadboard's are button-like), so middle-click and "open in new tab"
// work. Labels: Books, Projects, Quotes, Writing, Phone, Headphones, Breadboard, Try another time. Moving
// the outlines rewrites only polygon points, never layout, so focus is never dropped during a move.
// No outline is drawn over the objects, and no words at the pointer (spec v2, 15 Oct: the object answers the pointer with
// light, router.js -> gl/sheen.js; onLight reports what the pointer or keyboard focus is on). The names stay as the
// links' accessible names; keyboard focus also shows the name in the tip at the object's middle (never the window's:
// "Try another time" was never an approved visible word).
import { project } from "./rig.js";

// Interactions B: the notebook (his writing), the phone and two things that are not spots, the headphones (a link to the
// official video: the laptop plays it, phones open it) and the breadboard (a button: its LED blinks). Their names are
// accessible names only, never painted (no tip at focus either): "Writing", "Phone", "Headphones", "Breadboard".
const SVG = "http://www.w3.org/2000/svg";
const ORDER = ["shelf", "laptop", "print", "notebook", "phone", "headphones", "breadboard", "window"];
const NO_TIP = new Set(["window", "notebook", "phone", "headphones", "breadboard"]);
export const ACTIONS = {
  headphones: { label: "Headphones", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", external: true },
  breadboard: { label: "Breadboard", url: null },
};

// Convex hull (Andrew's monotone chain) of 2D points.
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

export class LinkLayer {
  constructor(parent, room, { tip = null, onFocusOff = null, onActivate = null, onLight = null, canTip = () => true } = {}) {
    this.room = room;
    this.tip = tip;
    this.canTip = canTip;   // false while the camera moves: an outline sliding under a still pointer re-fires hover
    this.onLight = onLight; // (name | null, how: "pointer" | "focus"): what the pointer or keyboard focus is on
    this.onFocusOff = onFocusOff;
    this.onActivate = onActivate;
    this.svg = document.createElementNS(SVG, "svg");
    this.svg.setAttribute("class", "sfw-links");
    this.svg.setAttribute("aria-label", "");
    this.svg.removeAttribute("aria-label");
    parent.appendChild(this.svg);
    // the window's link lies behind the others (its outline is the whole glass, and the laptop, the print and the
    // notebook stand in front of it): a second layer under the first, after it in the tab order (placeAfter)
    this.back = document.createElementNS(SVG, "svg");
    this.back.setAttribute("class", "sfw-links sfw-links-back");
    this.svg.after(this.back);
    this.items = new Map();
    this.pose = null;
    this.size = [1, 1];
    for (const name of ORDER) {
      const s = room.spots[name] || (ACTIONS[name] && room.objects[name] ? ACTIONS[name] : null);
      if (!s) continue;
      const a = document.createElementNS(SVG, "a");
      a.setAttribute("class", "sfw-link");
      if (s.url) a.setAttribute("href", s.url);
      else a.setAttribute("role", "button");   // the window, the phone: no address of their own (a history entry)
      if (s.external) { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener"); }
      a.setAttribute("aria-label", s.label);
      a.dataset.spot = name;
      const hit = document.createElementNS(SVG, "polygon");
      hit.setAttribute("class", "hit");
      a.appendChild(hit);
      (name === "window" ? this.back : this.svg).append(a);
      const item = { name, a, hit, poly: null, label: s.label, tip: !NO_TIP.has(name) };
      a.addEventListener("click", (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // new tab etc.: the browser's
        e.preventDefault();
        this.hideTip();
        this.onActivate?.(name, e);
      });
      a.addEventListener("keydown", (e) => {
        if (!s.url && (e.key === " " || e.key === "Enter")) { e.preventDefault(); this.hideTip(); this.onActivate?.(name, e); }
      });
      // the pointer: light only (no tip); a touch has no hover
      a.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") this.onLight?.(name, "pointer"); });
      a.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") this.onLight?.(null, "pointer"); });
      a.addEventListener("focus", () => this.focused(item));
      a.addEventListener("blur", () => { this.hideTip(); this.onLight?.(null, "focus"); });
      this.items.set(name, item);
    }
  }

  // Objects offered at a spot: the ones its rest pose shows (at the desk, all five; at a page spot, none of the
  // desk's: the page's own content takes the keyboard there).
  setSpot(spot, restPose, vw, vh) {
    for (const it of this.items.values()) {
      let on = spot === "desk" || spot === "window";
      if (on && restPose) on = this.fractionOnScreen(it.name, restPose, vw, vh) > 0.35;
      if (spot === "window" && it.name === "window") on = false;   // you are there
      it.a.style.display = on ? "" : "none";
      it.a.setAttribute("tabindex", on ? "0" : "-1");
    }
  }

  outline(name, pose, vw, vh) {
    // which room object outlines each spot's link (spots.json "links", else the spot's own name)
    const pts = this.room.points(this.room.data.links?.[name] || name);
    if (!pts) return null;
    const P = [];
    for (const p of pts) { const s = project(pose, p, vw, vh); if (!s) return null; P.push([s[0], s[1]]); }
    return hull(P);
  }

  fractionOnScreen(name, pose, vw, vh) {
    const poly = this.outline(name, pose, vw, vh);
    if (!poly) return 0;
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const area = Math.max(1, (x1 - x0) * (y1 - y0));
    const iw = Math.max(0, Math.min(x1, vw) - Math.max(x0, 0)), ih = Math.max(0, Math.min(y1, vh) - Math.max(y0, 0));
    return (iw * ih) / area;
  }

  update(pose, vw, vh) {
    this.pose = pose;
    this.size = [vw, vh];
    this.svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
    this.back.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
    for (const it of this.items.values()) {
      if (it.a.style.display === "none") continue;
      const poly = this.outline(it.name, pose, vw, vh);
      it.poly = poly;
      const pts = poly ? poly.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") : "";
      it.hit.setAttribute("points", pts);
    }
    if (this.tip?.classList.contains("at-focus") && this.tipFor) this.placeFocusTip(this.tipFor);
  }

  // Focus on an object pushed more than half off screen by an orbit: the camera eases back to rest (plan 7).
  focused(item) {
    if (!item.a.matches(":focus-visible")) return;
    if (this.pose && this.fractionOnScreen(item.name, this.pose, ...this.size) < 0.5) this.onFocusOff?.(item.name);
    this.tipFor = item;
    this.placeFocusTip(item);
    this.onLight?.(item.name, "focus");
  }

  placeFocusTip(item) {
    if (!this.tip || !item.poly) return;
    if (!item.tip || !this.canTip()) { this.hideTip(); return; }
    const xs = item.poly.map((p) => p[0]), ys = item.poly.map((p) => p[1]);
    const r = this.svg.getBoundingClientRect();
    const cx = r.left + (Math.min(...xs) + Math.max(...xs)) / 2, cy = r.top + (Math.min(...ys) + Math.max(...ys)) / 2;
    this.tip.textContent = item.label;
    this.tip.classList.add("at-focus");
    this.tip.style.left = `${Math.min(innerWidth - 70, Math.max(70, cx))}px`;
    this.tip.style.top = `${Math.min(innerHeight - 24, Math.max(24, cy))}px`;
    this.tip.hidden = false;
  }
  hideTip() { if (this.tip) { this.tip.hidden = true; this.tip.classList.remove("at-focus"); } this.tipFor = null; }

  focus(name) { this.items.get(name)?.a.focus({ preventScroll: true }); }
  // both layers after `el` in the document (the tab order: the objects, then the window)
  placeAfter(el) { el.after(this.svg); this.svg.after(this.back); }
  destroy() { this.svg.remove(); this.back.remove(); }
}
