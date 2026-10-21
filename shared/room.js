// A view of the room (books, projects, quotes) at the current moment, shown as a cover-cropped
// photograph inside an element, with helpers to place things on it (spines, the laptop screen,
// the framed print). Everything comes from scene.json: sizes, focus, polygons and quads.
//
//   const room = mountRoom(el, "quotes", { keep: (view, box) => bbox(view.quads.print) });
//   room.on("layout", (geo) => …); room.on("image", ({ img }) => …);
//   room.point([x, y]) → [px, py] inside el;  room.quad(q) → { P: [tl, tr, br, bl], w, h } inside el
//   room.visible resolves once something of the room is on screen (the blurred preview or the photograph);
//   room.ready once the photograph itself is up.
//
// Each page view is one 3:2 render. Wide boxes cover-crop the whole frame ("full" images); on phones
// (box narrower than STRIP_BELOW) the page loads only a 9:16 strip cut from the same frame ("portrait"
// images, scene.json views.<view>.portrait = [x0, x1]). Coordinates stay those of the whole frame either way.
//
// Options (values, or functions of (view, {w, h}) evaluated at every layout): focus, keep (a box
// [x0, y0, x1, y1] to keep in sight; if it cannot fit, its top wins and it is centred across), keepMargin, fitKeep, zoom,
// reserve ({ bottom, left } in px: parts of the box the keep box should stay clear of, e.g. under the masthead).
// layoutView() is the same arithmetic as a pure function, so the homepage can work out where a page will
// draw its view before going there (shared/transition.js).
import { loadScene, pickSize, imageFormat, url } from "./sky.js";
import { getMoment, onMoment } from "./masthead.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)");
export const STRIP_BELOW = 0.62;   // box aspect (w/h) under which a view's phone strip is used

// The moment whose images to show for a view: the moment itself, or the nearest one that has
// this view (same side of noon by sun altitude, else by list order).
export function frameForView(frames, frame, view) {
  if (!frame) return null;
  if (frame.images && frame.images[view]) return frame;
  const have = frames.filter((f) => f.images && f.images[view]);
  if (!have.length) return null;
  const side = have.filter((f) => f.side === frame.side || f.side === "both" || frame.side === "both");
  if (side.length) {
    return side.reduce((a, b) => (Math.abs(b.alt - frame.alt) < Math.abs(a.alt - frame.alt) ? b : a));
  }
  const i = frames.indexOf(frame);
  return have.reduce((a, b) => (Math.abs(frames.indexOf(b) - i) < Math.abs(frames.indexOf(a) - i) ? b : a));
}

// CSS matrix3d that maps a W×H box (transform-origin 0 0) onto the quad [tl, tr, br, bl].
export function homography(W, H, P) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = P;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    a = x1 - x0; b = x3 - x0; c = x0; d = y1 - y0; e = y3 - y0; f = y0; g = 0; h = 0;
  } else {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
    d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
  }
  const n = (v) => +v.toFixed(9);
  return `matrix3d(${n(a / W)},${n(d / W)},0,${n(g / W)},${n(b / H)},${n(e / H)},0,${n(h / H)},0,0,1,0,${n(c)},${n(f)},0,1)`;
}

// scene quads list corners in UV order (0,0) (1,0) (1,1) (0,1); return them as screen-space
// top-left, top-right, bottom-right, bottom-left whichever way the UVs run.
export function cssCorners(q) {
  let [p00, p10, p11, p01] = q;
  if ((p11[1] + p01[1]) < (p00[1] + p10[1])) [p00, p10, p11, p01] = [p01, p11, p10, p00];   // v runs upward
  if ((p10[0] + p11[0]) < (p00[0] + p01[0])) [p00, p10, p11, p01] = [p10, p00, p01, p11];   // u runs leftward
  return [p00, p10, p11, p01];
}

export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// The phone strip of a view, when this box would use it.
export function stripFor(view, box) {
  return view && view.portrait && box.w / box.h < STRIP_BELOW ? view.portrait : null;
}

// Where the view's frame sits in a box of box.w × box.h (CSS px): the stage size and offset, plus the
// strip of the frame that is loaded (ix, iw: the image's left edge and width in box px).
export function layoutView(view, box, opts = {}) {
  const boxW = box.w, boxH = box.h;
  const W = view.width, H = view.height;
  const opt = (k) => (typeof opts[k] === "function" ? opts[k](view, box) : opts[k]);
  const strip = stripFor(view, box);
  const [sx0, sx1] = strip || [0, 1];
  const focus = opt("focus") || view.focus || [0.5, 0.5];
  const keep = opt("keep");
  const margin = opt("keepMargin") ?? 0.08;
  const res = opt("reserve") || {};
  const rb = Math.min(boxH * 0.4, res.bottom || 0), rl = Math.min(boxW * 0.5, res.left || 0);
  let s = Math.max(boxW / ((sx1 - sx0) * W), boxH / H);
  let k = null;
  if (keep) {
    const kw = keep[2] - keep[0], kh = keep[3] - keep[1];
    k = [keep[0] - kw * margin, keep[1] - kh * margin, keep[2] + kw * margin, keep[3] + kh * margin];
    if (opt("fitKeep")) s = Math.max(s, Math.min((boxW - rl) / ((k[2] - k[0]) * W), (boxH - rb) / ((k[3] - k[1]) * H)));
  }
  s *= opt("zoom") || 1;
  const w = W * s, h = H * s;
  const f = k && opt("fitKeep") ? [(k[0] + k[2]) / 2, (k[1] + k[3]) / 2] : focus;
  let left = boxW / 2 - f[0] * w, top = boxH / 2 - f[1] * h;
  if (k) {
    let vx = -left, vy = -top;
    if ((k[2] - k[0]) * w > boxW - rl) vx = ((k[0] + k[2]) / 2) * w - (boxW + rl) / 2;   // too wide: centred
    else {
      if (vx + boxW < k[2] * w) vx = k[2] * w - boxW;
      if (vx + rl > k[0] * w) vx = k[0] * w - rl;
    }
    if (vy + boxH - rb < k[3] * h) vy = k[3] * h - (boxH - rb);
    if (vy > k[1] * h) vy = k[1] * h;                       // too tall: its top wins
    left = -vx; top = -vy;
  }
  left = Math.min(-sx0 * w, Math.max(boxW - sx1 * w, left));
  top = Math.min(0, Math.max(boxH - h, top));
  return { w, h, left, top, boxW, boxH, s, strip, ix: left + sx0 * w, iw: (sx1 - sx0) * w };
}

// The image (path without extension) a view shows for a frame laid out as geo.
export function imagePath(frame, viewName, geo) {
  const imgs = frame && frame.images && frame.images[viewName];
  if (!imgs) return null;
  const sizes = (geo.strip && imgs.portrait) || imgs.full;
  return pickSize(sizes, geo.iw * Math.min(2, window.devicePixelRatio || 1));
}

class Room {
  constructor(el, viewName, opts) {
    this.el = el;
    this.viewName = viewName;
    this.opts = opts;
    this.handlers = { layout: [], image: [] };
    this.geo = null;
    this.view = null;
    this.frames = null;
    this.shown = null;     // frame whose image is up
    this.img = null;       // the visible <img>
    this.stage = document.createElement("div");
    this.stage.className = "room-stage";
    this.stage.setAttribute("aria-hidden", "true");
    el.prepend(this.stage);
    this.visible = new Promise((res) => { this.shownSomething = res; });
    this.ready = this.init();
    this.ready.catch(() => this.shownSomething());
  }

  on(name, fn) { this.handlers[name].push(fn); if (name === "layout" && this.geo) fn(this.geo); return this; }
  emit(name, arg) { for (const fn of this.handlers[name]) { try { fn(arg); } catch (e) { console.error(e); } } }

  async init() {
    const [scene, fmt] = await Promise.all([loadScene(), imageFormat()]);
    this.fmt = fmt;
    this.view = scene.views[this.viewName];
    this.frames = scene.frames;
    if (!this.view) throw new Error(`scene.json has no view "${this.viewName}"`);
    this.el.style.setProperty("--room-aspect", String(this.view.width / this.view.height));
    this.layout();
    if (this.dead) return this;
    if ("ResizeObserver" in window) {
      let raf = 0;
      this.ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this.layout()); });
      this.ro.observe(this.el);
    } else {
      this.onResize = () => this.layout();
      addEventListener("resize", this.onResize);
    }

    const m = getMoment();
    const byId = (f) => f && this.frames.find((x) => x.id === f.id);
    const first = frameForView(this.frames, byId(m.frame) || this.frames[0], this.viewName);
    this.placeholder(first);
    await this.show(first, "init");
    if (this.dead) return this;
    this.off = onMoment((d) => {
      const f = frameForView(this.frames, byId(d.frame), this.viewName);
      if (f) this.show(f, d.reason);
    });
    this.onDial = (e) => { if (e.detail.open) this.preloadDay(); };
    document.addEventListener("sky:dial", this.onDial);
    return this;
  }

  destroy() {
    this.dead = true;
    this.pending = null;
    if (this.ro) this.ro.disconnect();
    if (this.onResize) removeEventListener("resize", this.onResize);
    if (this.off) this.off();
    if (this.onDial) document.removeEventListener("sky:dial", this.onDial);
    this.handlers = { layout: [], image: [] };
    this.stage.remove();
  }

  placeholder(frame) {
    const src = frame && frame.lqip && frame.lqip[this.viewName];
    if (!src) return;
    const img = new Image();
    img.className = "lqip";
    img.alt = "";
    img.src = src;
    this.stage.prepend(img);
    this.lqip = img;
    img.decode().catch(() => {}).then(() => this.shownSomething());
  }

  srcFor(frame) {
    const geo = this.geo || layoutView(this.view, { w: this.el.clientWidth || innerWidth, h: this.el.clientHeight || innerHeight }, this.opts);
    return url(imagePath(frame, this.viewName, geo), this.fmt);
  }

  // Place an <img> on the part of the stage its pixels cover (the whole frame, or the phone strip).
  fit(img) {
    const [x0, x1] = (img.strip) || [0, 1];
    img.style.left = `${x0 * 100}%`;
    img.style.width = `${(x1 - x0) * 100}%`;
  }

  // The room snaps to one moment; when it changes, the new photograph fades in over the old.
  show(frame, reason) {
    if (!frame) return Promise.resolve();
    const src = this.srcFor(frame);
    if (this.img && this.img.dataset.src === src) return Promise.resolve();
    if (this.pending && this.pending.dataset.src === src) return this.pendingDone;
    const arriving = reason === "init" && document.documentElement.classList.contains("zoom-in");
    const fade = reduced.matches || arriving ? 0 : reason === "init" ? 0.45 : reason === "resize" ? 0.3 : reason === "dial" || reason === "reset" ? 0.8 : 2.5;
    const img = new Image();
    img.className = "full";
    img.alt = "";
    img.decoding = "async";
    if (reason === "init") img.fetchPriority = "high";
    img.dataset.src = src;
    img.strip = this.geo && this.geo.strip;
    img.src = src;
    this.pending = img;
    return (this.pendingDone = img.decode().catch(() => new Promise((res) => { img.onload = res; img.onerror = res; })).then(() => {
      if (this.pending !== img) return;   // a newer moment was asked for meanwhile
      const old = this.img;
      this.fit(img);
      img.style.setProperty("--room-fade", `${fade}s`);
      this.stage.append(img);
      this.img = img;
      this.shown = frame;
      if (fade) requestAnimationFrame(() => requestAnimationFrame(() => img.classList.add("is-on")));
      else img.classList.add("is-on");
      this.emit("image", { img, src, frame, fade, strip: img.strip });
      this.shownSomething();
      const cleanup = () => {
        if (old && old !== this.img) old.remove();
        if (this.lqip) { this.lqip.remove(); this.lqip = null; }
      };
      setTimeout(cleanup, fade * 1000 + 120);
    }));
  }

  preloadDay() {
    if (this.preloaded) return;
    this.preloaded = true;
    for (const f of this.frames) if (f.images && f.images[this.viewName]) new Image().src = this.srcFor(f);
  }

  // Cover-crop the view into the element, centred on the focus, keeping an optional region in sight.
  layout() {
    if (!this.view) return;
    const boxW = this.el.clientWidth, boxH = this.el.clientHeight;
    if (!boxW || !boxH) return;
    const prev = this.geo;
    const g = layoutView(this.view, { w: boxW, h: boxH }, this.opts);
    Object.assign(this.stage.style, { width: `${g.w}px`, height: `${g.h}px`, transform: `translate(${g.left}px, ${g.top}px)` });
    this.geo = g;
    this.emit("layout", g);
    if (!prev || !this.shown) return;
    // the phone strip came or went (rotation), or the view grew a lot: fetch the right photograph
    if (String(prev.strip) !== String(g.strip) || g.iw > prev.iw * 1.25) this.show(this.shown, "resize");
  }

  point([x, y]) { const g = this.geo; return [g.left + x * g.w, g.top + y * g.h]; }
  points(poly) { return poly.map((p) => this.point(p)); }
  // A quad from scene.json in this element's pixels, as [tl, tr, br, bl], with its natural size.
  quad(q) {
    const P = cssCorners(q).map((p) => this.point(p));
    const w = (dist(P[0], P[1]) + dist(P[3], P[2])) / 2;
    const h = (dist(P[0], P[3]) + dist(P[1], P[2])) / 2;
    return { P, w, h };
  }
  // A point of the frame in the shown photograph's own pixels (it may be the phone strip).
  imagePoint([x, y], img = this.img) {
    const [x0, x1] = (img && img.strip) || [0, 1];
    return [((x - x0) / (x1 - x0)) * img.naturalWidth, y * img.naturalHeight];
  }
  bbox(poly) { return bbox(poly); }
}

export function mountRoom(el, viewName, opts = {}) {
  return new Room(el, viewName, opts);
}
