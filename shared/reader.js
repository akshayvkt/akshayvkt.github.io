// The reading sheet: one of Akshay's essays, lifted out of the notebook on the desk (docs/v3/EXPERIENCE-SPEC.md,
// "Browse on the object; read in a lifted sheet"). No dependencies; pair with shared/reader.css.
//
//   import { Reader } from "/shared/reader.js";
//   const reader = new Reader();                       // options below
//   reader.prefetch(slug);                             // warm an essay and the fonts (e.g. when the camera leans in)
//   reader.open(postOrSlug, fromRect);                 // lift the sheet out of fromRect; resolves when it has landed
//   reader.close();                                    // return it into the (current) fromRect; resolves when settled
//   reader.setOrigin(fromRect);                        // where the page now sits (after a deep link, or a camera move)
//   reader.route();                                    // a deep link (/writing/<slug>): opens with a short rise
//   reader.open({ slug: "about", page }, fromRect, opt) // a page of the site's own in the same sheet (nav-r1), below
//
// fromRect is a DOMRect-like {left, top, width, height}, or a function returning one (asked again on close, so the
// sheet goes back to where the page is *then*), or null (no origin: a short rise from below, and back down).
// Options: { index: "/data/writing.json", posts: "/data/writing/", route: "/writing/" (null: leave the URL alone),
//            home: "/" (the URL after a deep-linked sheet closes), onOpen(slug), onClose(slug) }.
// Events on document: reader:open, reader:change, reader:close (motion starts), reader:closed (settled); detail {slug}.
// While open: <html class="rd-lock">, the rest of <body> is inert, Esc/Tab are taken in the capture phase, and wheel,
// touch and pointer events don't reach the page behind.
//
// A page of the site's own (nav-r1, 17 Oct): the same sheet, with the same motion, scrim, Escape, focus trap, swipe
// and history entry, can hold given content instead of an essay: About (his bio), Social without the 3D (his five
// links) and, on phones, the Projects page. `page` is { label, kind, build, url, home, focus, scroller }:
//   label     the dialog's accessible name (the masthead's word: "About", "Social", "Projects")
//   kind      "page": as tall as its words, centred (phones: a short bottom sheet); "small": a little card of icons;
//             "frame": the full sheet, its content a frame that scrolls itself
//   build()   the content (a Node, or a promise of one), made on each open
//   url       the address while it is open (default: this one; a history entry either way), home: after a fresh one
//   focus()   what takes focus once it has landed (default: the sheet); scroller(): what the wheel over the scrim scrolls

const EASE = "cubic-bezier(0.22, 0.8, 0.24, 1)";        // the site's --ease-out: soft, no overshoot
const LIFT_EASE = "cubic-bezier(0.3, 0.72, 0.2, 1)";    // the lift: an ease-out with a gentler start, no overshoot
const SHEET_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";    // phones: the native bottom-sheet curve
const LIFT = 620, SLIDE = 520, SLIDE_OUT = 380, RISE = 520, FADE = 220;

const ALLOWED = {
  P: [], H2: [], H3: [], H4: [], BLOCKQUOTE: [], UL: [], OL: [], LI: ["id"], EM: [], STRONG: [], S: [], SUP: [],
  SUB: [], A: ["href", "id"], IMG: ["src", "srcset", "sizes", "alt", "width", "height"], FIGURE: [], FIGCAPTION: [], HR: [],
  PRE: [], CODE: [], BR: [], VIDEO: ["src", "poster", "width", "height"],
};
const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "FRAME", "OBJECT", "EMBED", "FORM", "INPUT", "BUTTON", "TEXTAREA",
  "SELECT", "SVG", "MATH", "TEMPLATE", "NOSCRIPT", "LINK", "META", "BASE", "AUDIO", "CANVAS", "DIALOG", "SOURCE", "TRACK"]);
// the essays' own media, copied into the site at build time (fetch_substack.py): a video plays only those
const LOCAL = /^\/data\/writing\/media\/[a-z0-9-]+\/[a-z0-9-]+\.(webp|mp4)$/;
const SUBSTACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z"/></svg>';
const CROSS = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12"/></svg>';
const DATE = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

const el = (tag, cls, attrs = {}) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The essay's HTML, checked again against the list (the data is sanitized when fetched; this is the second lock). */
function clean(html) {
  const t = document.createElement("template");
  t.innerHTML = html || "";                       // inert: nothing runs or loads until it is in the page
  (function walk(parent) {
    for (const n of [...parent.childNodes]) {
      if (n.nodeType === 3) continue;
      if (n.nodeType !== 1) { n.remove(); continue; }
      const tag = n.tagName.toUpperCase();
      if (DROP.has(tag)) { n.remove(); continue; }
      walk(n);
      const ok = ALLOWED[tag];
      if (!ok) { n.replaceWith(...n.childNodes); continue; }
      for (const a of [...n.attributes]) if (!ok.includes(a.name)) n.removeAttribute(a.name);
      if (n.id && !/^fn(ref)?-\d+$/.test(n.id)) n.removeAttribute("id");
      if (tag === "A" && !/^(https?:|mailto:|#)/i.test(n.getAttribute("href") || "")) { n.replaceWith(...n.childNodes); continue; }
      if (tag === "IMG") {
        const src = n.getAttribute("src") || "";
        if (!/^https?:/i.test(src) && !LOCAL.test(src)) { n.remove(); continue; }
        const set = n.getAttribute("srcset");
        if (set && !set.split(",").every((x) => LOCAL.test(x.trim().split(/\s+/)[0]))) { n.removeAttribute("srcset"); n.removeAttribute("sizes"); }
        n.loading = "lazy"; n.decoding = "async";
        if (!n.hasAttribute("alt")) n.alt = "";
      }
      if (tag === "VIDEO") {
        if (!LOCAL.test(n.getAttribute("src") || "") || !LOCAL.test(n.getAttribute("poster") || "")) { n.remove(); continue; }
        n.controls = true; n.playsInline = true; n.preload = "metadata";
        n.setAttribute("controlslist", "nodownload noremoteplayback");
        n.disablePictureInPicture = true;
      }
    }
  })(t.content);
  return t.content;
}

// (DYS-151 memory) Media taken out of the page let go of what they hold now: a <video> its player and buffers, an <img>
// its decoded picture. Out of the page they keep them until a full garbage collection, which with the JIT (any https
// page) can be many essays away (essay-lift.js's unload, the same: MH1/DM, WebKit as an iPhone 13 over https).
function unload(media) {
  for (const m of media) {
    if (m.localName === "video") { m.pause(); m.removeAttribute("src"); m.load(); }
    else { m.removeAttribute("srcset"); m.removeAttribute("src"); }
  }
}

function rectOf(r) {
  try {
    const v = typeof r === "function" ? r() : r;
    if (!v) return null;
    const b = v.getBoundingClientRect ? v.getBoundingClientRect() : v;
    const left = b.left ?? b.x, top = b.top ?? b.y;
    if (![left, top, b.width, b.height].every(Number.isFinite) || b.width < 4 || b.height < 4) return null;
    if (left > innerWidth || top > innerHeight || left + b.width < 0 || top + b.height < 0) return null;
    return { left, top, width: b.width, height: b.height };
  } catch { return null; }
}

export class Reader {
  constructor(opts = {}) {
    this.o = { index: "/data/writing.json", posts: "/data/writing/", route: "/writing/", home: "/", ...opts };
    this.state = "closed";
    this.slug = null;
    this.origin = null;
    this.cache = new Map();
    this.pages = new Map();       // slug -> a page of the site's own (open({ slug, page }))
    this.phoneQ = matchMedia("(max-width: 640px)");
    this.reducedQ = matchMedia("(prefers-reduced-motion: reduce)");
    this.onKey = this.onKey.bind(this);
    addEventListener("popstate", (e) => this.onPop(e));
  }

  get isOpen() { return this.state === "opening" || this.state === "open"; }

  // ------------------------------------------------------------ data
  index() {
    this._index ||= fetch(this.o.index).then((r) => (r.ok ? r.json() : { posts: [] }))
      .then((d) => d.posts || []).catch(() => []);
    return this._index;
  }
  essay(slug) {
    if (!this.cache.has(slug)) {
      const p = fetch(this.o.posts + encodeURIComponent(slug) + ".json")
        .then((r) => { if (!r.ok) throw new Error(`essay ${slug}: ${r.status}`); return r.json(); });
      p.catch(() => this.cache.delete(slug));
      this.cache.set(slug, p);
    }
    return this.cache.get(slug);
  }
  fonts() {
    if (!this._fonts) {
      const faces = ['500 21px "Cormorant Garamond"', 'italic 400 21px "Cormorant Garamond"',
        'italic 500 21px "Cormorant Garamond"', '600 21px "Cormorant Garamond"', "500 12px Geist"];
      this._fonts = document.fonts ? Promise.all(faces.map((f) => document.fonts.load(f).catch(() => null))) : Promise.resolve();
    }
    return this._fonts;
  }
  prefetch(slug) {
    this.build();
    this.fonts();
    this.index();
    if (slug) this.essay(slug).catch(() => {});
  }
  setOrigin(fromRect) { this.origin = fromRect ?? null; }

  // ------------------------------------------------------------ the sheet's DOM, made once
  build() {
    if (this.root) return;
    const root = (this.root = el("div", "rd", { "data-state": "closed" }));
    root.hidden = true;
    this.scrim = el("div", "rd-scrim");
    this.sheet = el("div", "rd-sheet", { role: "dialog", "aria-modal": "true", "aria-labelledby": "rd-title" });
    this.rest = el("div", "rd-shadow rest");
    this.lift = el("div", "rd-shadow lift");
    this.paper = el("div", "rd-paper");
    this.inner = el("div", "rd-inner");
    this.scroller = el("div", "rd-scroll", { tabindex: "-1" });
    const progress = el("div", "rd-progress", { "aria-hidden": "true" });
    this.bar = el("i");
    progress.append(this.bar);
    this.closeBtn = el("button", "rd-close", { type: "button", "aria-label": "Close" });
    this.closeBtn.innerHTML = CROSS;
    this.grip = el("div", "rd-grip", { "aria-hidden": "true" });
    this.inner.append(this.scroller, progress, this.grip, this.closeBtn);
    this.paper.append(this.inner);
    this.sheet.append(this.rest, this.lift, this.paper);
    root.append(this.scrim, this.sheet);
    document.body.append(root);

    this.closeBtn.addEventListener("click", () => this.close());
    this.scrim.addEventListener("click", () => this.close());
    this.scroller.addEventListener("scroll", () => {
      if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.progress(); });
    }, { passive: true });
    this.sheet.addEventListener("click", (e) => this.onLink(e));
    // wheel anywhere scrolls the essay, never the page or the room behind
    root.addEventListener("wheel", (e) => {
      e.stopPropagation();
      if (!this.scroller.contains(e.target)) { e.preventDefault(); (this.pages.get(this.slug)?.scroller?.() || this.scroller).scrollBy(0, e.deltaY); }
    }, { passive: false });
    this.scrim.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
    for (const t of ["pointerdown", "pointermove", "pointerup", "mousedown", "mousemove", "mouseup", "click",
      "dblclick", "contextmenu", "touchstart", "touchmove", "touchend", "touchcancel", "keydown", "keyup"]) {
      root.addEventListener(t, (e) => e.stopPropagation());
    }
    // phones: swipe down to close
    this.sheet.addEventListener("touchstart", (e) => this.onTouchStart(e), { passive: true });
    this.sheet.addEventListener("touchmove", (e) => this.onTouchMove(e), { passive: false });
    this.sheet.addEventListener("touchend", (e) => this.onTouchEnd(e));
    this.sheet.addEventListener("touchcancel", (e) => this.onTouchEnd(e));
  }

  // ------------------------------------------------------------ an essay, laid out
  async render(slug) {
    const pg = this.pages.get(slug);
    if (pg) {
      const art = el("article", "rd-article rd-own");
      art.append(await pg.build());
      return { art, post: { slug, title: null }, page: pg };
    }
    const posts = await this.index();
    const i = posts.findIndex((p) => p.slug === slug);
    let post;
    try { post = await this.essay(slug); } catch { post = posts[i] || null; }   // offline: the header and the link
    await Promise.race([this.fonts(), wait(900)]);
    if (!post) throw new Error(`no essay ${slug}`);

    const art = el("article", "rd-article");
    const head = el("header", "rd-head");
    const h1 = el("h1", "rd-title", { id: "rd-title" });
    h1.textContent = post.title;
    head.append(h1);
    if (post.subtitle) { const s = el("p", "rd-sub"); s.textContent = post.subtitle; head.append(s); }
    if (post.date) {
      const t = el("time", "rd-date", { datetime: post.date });
      t.textContent = DATE.format(new Date(post.date + "T12:00:00Z"));
      head.append(t);
    }
    const body = el("div", "rd-body");
    if (post.html) body.append(clean(post.html));
    this.decorate(body, posts);

    // the end: the neighbouring essays (newer on the left, older on the right: the notebook's page order) and the original
    const end = el("footer", "rd-end");
    const nav = el("nav", "rd-next");
    const newer = posts[i - 1], older = posts[i + 1];
    if (i >= 0 && newer) nav.append(this.neighbour(newer, "newer"));
    if (i >= 0 && older) nav.append(this.neighbour(older, "older"));
    if (nav.childElementCount) end.append(nav);
    const orig = el("div", "rd-orig");
    const a = el("a", "", { href: post.url, target: "_blank", rel: "noopener", "aria-label": "Substack" });
    a.innerHTML = SUBSTACK;
    orig.append(a);
    end.append(orig);

    art.append(head, body, end);
    return { art, post };
  }

  neighbour(p, cls) {
    const a = el("a", cls, { href: this.o.route ? this.o.route + p.slug : p.url, rel: cls === "newer" ? "prev" : "next", "data-slug": p.slug });
    const arrow = el("span", "arrow", { "aria-hidden": "true" });
    arrow.textContent = cls === "newer" ? "←" : "→";
    const t = el("span");
    t.textContent = p.title;
    if (cls === "newer") a.append(arrow, t); else a.append(t, arrow);
    return a;
  }

  decorate(body, posts) {
    const known = new Map(posts.map((p) => [p.slug, p]));
    for (const f of body.querySelectorAll("figure")) {
      // (photos in a quoted post's card are half the measure wide; photos in a row each take their share of it, at one
      // height: the copy the browser picks follows that width)
      const part = (im, k) => { if (im.hasAttribute("srcset")) im.sizes = `(max-width: 640px) ${Math.ceil(k * 100)}vw, ${Math.ceil(k * 684)}px`; };
      if (f.querySelector(":scope > blockquote")) { f.classList.add("rd-card"); f.querySelectorAll(":scope > img").forEach((im) => part(im, 0.5)); continue; }
      const imgs = [...f.querySelectorAll(":scope > img")];
      if (imgs.length > 1) {
        f.classList.add("rd-row");
        const r = imgs.map((im) => { const w = +im.getAttribute("width"), h = +im.getAttribute("height"); return w > 0 && h > 0 ? w / h : 1; });
        const sum = r.reduce((a, b) => a + b, 0);
        imgs.forEach((im, i) => { im.style.flexGrow = String(r[i]); part(im, r[i] / sum); });
      }
    }
    // a finger on the picture of a paused video plays it (phones' controls only show themselves on a tap; the control
    // bar along its foot and every mouse click stay the player's own)
    // (the player takes a finger's tap for itself, so no click comes: a short, still touch is the tap)
    for (const v of body.querySelectorAll("video")) {
      let down = null;
      v.addEventListener("pointerdown", (e) => { down = e.pointerType === "touch" ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null; });
      v.addEventListener("pointerup", (e) => {
        const d = down; down = null;
        if (!d || !v.paused || e.timeStamp - d.t > 500 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
        const r = v.getBoundingClientRect();
        if (e.clientY - r.top < r.height - 56) v.play().catch(() => {});
      });
      v.addEventListener("pointercancel", () => { down = null; });
    }
    for (const ol of body.querySelectorAll("ol")) if (ol.querySelector(':scope > li[id^="fn-"]')) ol.classList.add("rd-notes");
    for (const a of body.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (href.startsWith("#")) continue;
      const m = href.match(/^https?:\/\/akshaychintalapati\.substack\.com\/p\/([a-z0-9-]+)\/?(?:[?#].*)?$/);
      if (m && known.has(m[1])) a.dataset.slug = m[1];
      a.target = "_blank";
      a.rel = "noopener";
    }
  }

  pauseMedia() { for (const v of this.scroller?.querySelectorAll("video") || []) v.pause(); }

  mount({ art, post }) {
    this.pauseMedia();
    const was = this.scroller.firstElementChild;
    this.scroller.replaceChildren(art);
    // (DYS-151 memory: the last essay's media, as essay-lift's mount; a page of the site's own, .rd-own, is left as it is:
    // its content can be the page's own, shown again, the Projects page's frame)
    if (was && was !== art && !was.classList.contains("rd-own")) unload(was.querySelectorAll("img, video"));
    this.scroller.scrollTop = 0;
    this.post = post;
    this.progress();
    if (!post.title) return;   // (a page of the site's own: the document keeps its title)
    if (this.baseTitle == null) this.baseTitle = document.title;
    document.title = this.baseTitle ? `${post.title} · ${this.baseTitle}` : post.title;
  }

  progress() {
    const s = this.scroller;
    const max = s.scrollHeight - s.clientHeight;
    this.bar.style.transform = `scaleX(${max > 0 ? Math.min(1, Math.max(0, s.scrollTop / max)) : 0})`;
  }

  // The dialog's accessible name (an essay: its title; a page: the masthead's word) and the sheet's kind.
  dress(pg) {
    if (pg) { this.sheet.removeAttribute("aria-labelledby"); this.sheet.setAttribute("aria-label", pg.label || ""); this.root.dataset.kind = pg.kind || "page"; }
    else { this.sheet.removeAttribute("aria-label"); this.sheet.setAttribute("aria-labelledby", "rd-title"); delete this.root.dataset.kind; }
  }

  // ------------------------------------------------------------ open and close
  mode(origin) {
    // (DYS-27: a phone's essay refreshed: the homepage's head painted this sheet's paper and the room's dimming where they
    // land, html.sfw-pre-sheet; the sheet takes their place as it is, only its words coming in)
    if (document.documentElement.classList.contains("sfw-pre-sheet")) return "place";
    if (this.reducedQ.matches) return "fade";
    if (this.phoneQ.matches) return "slide";
    return origin ? "lift" : "rise";
  }

  async open(post, fromRect = null, opt = {}) {
    const slug = typeof post === "string" ? post : post && post.slug;
    if (!slug) return;
    if (post && post.page) this.pages.set(slug, post.page);
    this.build();
    if (this.isOpen) { if (slug !== this.slug) await this.show(slug, opt); return; }
    if (this.state === "closing") this.finishClose();
    this.origin = fromRect ?? null;
    this.slug = slug;
    this.state = "opening";
    this.returnFocus = document.activeElement;
    const pg = this.pages.get(slug) || null;
    this.dress(pg);
    if ((this.o.route || pg) && opt.history !== false) {
      history.pushState({ ...(history.state || {}), reader: slug }, "", pg ? pg.url ?? location.href : this.o.route + slug);
      this.pushed = true;
    } else if ((this.o.route || pg) && opt.deep) {
      history.replaceState({ ...(history.state || {}), reader: slug }, "", location.href);
    }
    document.dispatchEvent(new CustomEvent("reader:open", { detail: { slug } }));
    this.o.onOpen?.(slug);

    const content = this.render(slug).then((r) => { if (this.slug === slug && this.isOpen) this.mount(r); return r; });
    content.catch(() => {});
    const origin = rectOf(this.origin);
    const mode = this.mode(origin);
    if (mode !== "lift") await Promise.race([content.catch(() => null), wait(160)]);   // a warm cache lands full
    if (this.state !== "opening" || this.slug !== slug) return;

    this.lock();
    this.root.hidden = false;
    this.root.dataset.state = "opening";
    this.scroller.focus({ preventScroll: true });
    const F = this.sheet.getBoundingClientRect();
    const a = [];
    const fade = { lift: [0.42 * LIFT, 0.5 * LIFT], rise: [0.24 * RISE, 0.56 * RISE], slide: [0, 1], fade: [0, FADE], place: [0, FADE] }[mode];
    if (mode === "place") {
      // (the head's paper goes in the frame this sheet shows: no doubled dimming, no step)
      document.documentElement.classList.remove("sfw-pre-sheet");
      a.push(this.sheet.animate([{ opacity: 1 }, { opacity: 1 }], { duration: FADE }));
    }
    if (mode === "lift") {
      const from = `translate(${origin.left - F.left}px, ${origin.top - F.top}px) scale(${origin.width / F.width}, ${origin.height / F.height})`;
      a.push(this.sheet.animate([{ transform: from }, { transform: "none" }], { duration: LIFT, easing: LIFT_EASE }));
      a.push(this.sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 0.1 * LIFT, easing: "ease-out" }));
      a.push(this.rest.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 0.7 * LIFT, easing: EASE }));
      a.push(this.lift.animate([{ opacity: 0 }, { opacity: 1 }], { duration: LIFT, easing: EASE }));
      a.push(this.scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: LIFT, easing: EASE }));
    } else if (mode === "rise") {
      a.push(this.sheet.animate([{ transform: "translateY(44px)" }, { transform: "none" }], { duration: RISE, easing: EASE }));
      a.push(this.sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 0.3 * RISE, easing: "ease-out" }));   // paper first, then the words
      a.push(this.scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: RISE, easing: EASE }));
    } else if (mode === "slide") {
      const H = innerHeight - F.top + 24;
      a.push(this.sheet.animate([{ transform: `translateY(${H}px)` }, { transform: "none" }], { duration: SLIDE, easing: SHEET_EASE }));
      a.push(this.scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SLIDE, easing: EASE }));
    } else if (mode === "fade") {
      a.push(this.sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE, easing: "ease-out" }));
      a.push(this.scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE, easing: "ease-out" }));
    }
    // the words arrive as the page comes to rest (or as soon as they're here, if they come later)
    const words = this.inner.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fade[1], delay: fade[0], easing: EASE, fill: "both" });
    words.pause();
    const lead = a[0];
    content.then(() => {
      if (words.playState === "idle") return;
      const t = Math.min(Number(lead.currentTime ?? Infinity), fade[0]);
      words.currentTime = Number.isFinite(t) ? t : fade[0];
      words.play();
    }, () => { if (this.slug === slug && this.isOpen) this.close(); });   // no such essay at all: don't hold an empty sheet
    this.anims = [...a, words];

    try { await lead.finished; } catch { return; }    // cancelled: a close took over
    if (this.state !== "opening") return;
    this.state = "open";
    this.root.dataset.state = "open";
    for (const x of a) x.cancel();
    if (pg?.focus) content.then(() => { if (this.isOpen && this.slug === slug) pg.focus()?.focus?.({ preventScroll: true }); }, () => {});
    words.finished.then(() => { if (this.isOpen) words.cancel(); }, () => {});
    this.anims = [words];
  }

  /** Another essay in the open sheet (next/previous, a link between essays, the back and forward buttons). */
  async show(slug, opt = {}) {
    if (!this.isOpen || slug === this.slug) return;
    if (this.pages.has(slug) || this.pages.has(this.slug)) { if (opt.history === false) { this.close({ fromHistory: true }); } return; }   // (a page of the site's own is not one of a series)
    this.slug = slug;
    if (this.o.route && opt.history !== false) history.replaceState({ ...(history.state || {}), reader: slug }, "", this.o.route + slug);
    document.dispatchEvent(new CustomEvent("reader:change", { detail: { slug } }));
    const next = this.render(slug);
    next.catch(() => {});
    const quick = this.reducedQ.matches;
    await this.inner.animate([{ opacity: 1 }, { opacity: 0 }], { duration: quick ? 120 : 170, easing: "ease-in", fill: "forwards" }).finished.catch(() => {});
    let r;
    try { r = await next; } catch { r = null; }
    if (this.slug !== slug || !this.isOpen) return;
    if (r) this.mount(r);
    this.scroller.focus({ preventScroll: true });
    const back = this.inner.animate(
      quick ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
      { duration: quick ? 160 : 320, easing: EASE });
    for (const x of this.inner.getAnimations()) if (x !== back) x.cancel();
    await back.finished.catch(() => {});
  }

  close(opt = {}) {
    if (this.state === "closed") return Promise.resolve();
    if (this.state === "closing") return this.closing;
    const slug = this.slug;
    // the room's URL comes back: the entry this sheet pushed, or (after a deep link) the room's own address
    const pg = this.pages.get(slug);
    if ((this.o.route || pg) && !opt.fromHistory) {
      if (this.pushed) { this.expectPop = true; history.back(); }
      else history.replaceState({ ...(history.state || {}), reader: null }, "", pg ? (typeof pg.home === "function" ? pg.home() : pg.home) ?? location.href : this.o.home);
    }
    this.pushed = false;
    this.pauseMedia();
    document.dispatchEvent(new CustomEvent("reader:close", { detail: { slug } }));
    this.o.onClose?.(slug);
    this.closing = this.motionOut(opt).then(() => this.finishClose());
    return this.closing;
  }

  async motionOut(opt) {
    const was = this.state;
    // start from wherever things are right now (a close can interrupt the opening, or a swipe), read before anything changes
    const cs = (n) => getComputedStyle(n);
    const now = {
      transform: cs(this.sheet).transform, opacity: +cs(this.sheet).opacity, inner: +cs(this.inner).opacity,
      scrim: +cs(this.scrim).opacity, rest: +cs(this.rest).opacity, lift: +cs(this.lift).opacity,
    };
    this.state = "closing";
    this.root.dataset.state = "closing";
    for (const x of this.anims || []) x.cancel();
    for (const n of [this.sheet, this.inner, this.scrim]) for (const x of n.getAnimations()) x.cancel();
    this.sheet.style.transform = "";
    this.scrim.style.opacity = "";
    const tf = now.transform === "none" ? "none" : now.transform;
    const origin = rectOf(this.origin);
    const mode = was === "closed" ? "fade" : this.mode(origin);
    const F = this.sheet.getBoundingClientRect();   // the untransformed sheet
    const o = { fill: "forwards" };
    const a = [];
    if (mode === "lift") {
      const to = `translate(${origin.left - F.left}px, ${origin.top - F.top}px) scale(${origin.width / F.width}, ${origin.height / F.height})`;
      a.push(this.sheet.animate([{ transform: tf }, { transform: to }], { ...o, duration: LIFT, easing: LIFT_EASE }));
      a.push(this.sheet.animate([{ opacity: now.opacity }, { opacity: now.opacity, offset: 0.72 }, { opacity: 0 }], { ...o, duration: LIFT }));
      // (v3/qa-nav, 23 Oct: the words stay on the sheet as it settles, and go with it as it dissolves into its place:
      // they used to fade in the lift's first 30 %, which left blank paper over the laptop's screen or the notebook's
      // page for about a quarter of a second before what is there showed through)
      a.push(this.rest.animate([{ opacity: now.rest }, { opacity: 1 }], { ...o, duration: LIFT, easing: EASE }));
      a.push(this.lift.animate([{ opacity: now.lift }, { opacity: 0 }], { ...o, duration: LIFT, easing: EASE }));
      a.push(this.scrim.animate([{ opacity: now.scrim }, { opacity: 0 }], { ...o, duration: LIFT, easing: EASE }));
    } else if (mode === "slide") {
      const H = innerHeight - F.top + 24;
      const m = tf.match(/matrix\(([^)]+)\)/);
      const y = m ? +m[1].split(",")[5] : 0;
      const v = opt.velocity || 0;   // px/ms from a swipe: keep the finger's speed
      const dur = v > 0.3 ? Math.min(SLIDE_OUT, Math.max(170, (H - y) / v)) : SLIDE_OUT;
      a.push(this.sheet.animate([{ transform: tf }, { transform: `translateY(${H}px)` }], { ...o, duration: dur, easing: v > 0.3 ? "cubic-bezier(0.25, 0.6, 0.4, 1)" : SHEET_EASE }));
      a.push(this.scrim.animate([{ opacity: now.scrim }, { opacity: 0 }], { ...o, duration: dur, easing: EASE }));
    } else if (mode === "rise") {
      a.push(this.sheet.animate([{ transform: tf, opacity: now.opacity }, { transform: "translateY(32px)", opacity: 0 }], { ...o, duration: 0.8 * RISE, easing: "cubic-bezier(0.4, 0, 0.6, 1)" }));
      a.push(this.scrim.animate([{ opacity: now.scrim }, { opacity: 0 }], { ...o, duration: 0.8 * RISE, easing: EASE }));
    } else {
      a.push(this.sheet.animate([{ opacity: now.opacity }, { opacity: 0 }], { ...o, duration: FADE, easing: "ease-in" }));
      a.push(this.scrim.animate([{ opacity: now.scrim }, { opacity: 0 }], { ...o, duration: FADE, easing: "ease-in" }));
    }
    this.anims = a;
    await Promise.all(a.map((x) => x.finished.catch(() => {})));
  }

  finishClose() {
    for (const n of [this.sheet, this.inner, this.scrim, this.rest, this.lift]) for (const x of n.getAnimations()) x.cancel();
    this.anims = [];
    this.sheet.style.transform = "";
    this.scrim.style.opacity = "";
    this.root.hidden = true;
    this.root.dataset.state = "closed";
    delete this.root.dataset.kind;
    const slug = this.slug;
    this.state = "closed";
    this.closing = null;
    this.unlock();
    if (this.baseTitle != null) { document.title = this.baseTitle; this.baseTitle = null; }
    const f = this.returnFocus;
    this.returnFocus = null;
    if (f && f.isConnected && typeof f.focus === "function") f.focus({ preventScroll: true });
    document.dispatchEvent(new CustomEvent("reader:closed", { detail: { slug } }));
  }

  // ------------------------------------------------------------ deep links and history
  async route() {
    if (!this.o.route) return false;
    const pre = this.o.route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = location.pathname.match(new RegExp("^" + pre + "([a-z0-9-]+)/?$"));
    if (!m) return false;
    this.prefetch(m[1]);
    const posts = await this.index();
    if (!posts.some((p) => p.slug === m[1])) return false;
    this.open(m[1], this.origin, { history: false, deep: true });
    return true;
  }

  onPop(e) {
    if (this.expectPop) { this.expectPop = false; return; }
    const s = e.state && e.state.reader;
    if (this.isOpen && !s) this.close({ fromHistory: true });
    else if (this.isOpen && s && s !== this.slug) this.show(s, { history: false });
    else if (!this.isOpen && s) { this.open(s, this.origin, { history: false }); this.pushed = true; }
  }

  // ------------------------------------------------------------ the page behind
  lock() {
    const de = document.documentElement;
    const bar = innerWidth - de.clientWidth;          // a classic scrollbar: keep the page from shifting
    de.classList.add("rd-lock");
    this.padWas = de.style.paddingRight;
    if (bar > 0) de.style.paddingRight = bar + "px";
    this.inerted = [...document.body.children].filter((n) => n !== this.root && !n.inert);
    for (const n of this.inerted) n.inert = true;
    addEventListener("keydown", this.onKey, true);
  }
  unlock() {
    const de = document.documentElement;
    de.classList.remove("rd-lock");
    de.style.paddingRight = this.padWas || "";
    for (const n of this.inerted || []) n.inert = false;
    this.inerted = [];
    removeEventListener("keydown", this.onKey, true);
  }

  onKey(e) {
    if (this.state === "closed") return;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation();
      this.close();
    } else if (e.key === "Tab") {
      const f = [...this.sheet.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((n) => n.offsetParent !== null || n === this.closeBtn);
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1], at = document.activeElement;
      const inside = this.sheet.contains(at) && at !== this.scroller;
      if (e.shiftKey && (!inside || at === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || at === last)) { e.preventDefault(); first.focus(); }
      e.stopImmediatePropagation();
    }
  }

  onLink(e) {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || !this.sheet.contains(a) || e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const href = a.getAttribute("href");
    if (href.startsWith("#")) {
      e.preventDefault();
      const t = this.scroller.querySelector(`[id="${CSS.escape(href.slice(1))}"]`);
      if (!t) return;
      const s = this.scroller;
      const top = t.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - s.clientHeight * 0.3;
      s.scrollTo({ top: Math.max(0, top), behavior: this.reducedQ.matches ? "auto" : "smooth" });
      const flashed = t.tagName === "A" ? t.parentElement : t;
      flashed.classList.remove("rd-flash"); void flashed.offsetWidth; flashed.classList.add("rd-flash");
      (t.tagName === "A" ? t : t.querySelector("a") || this.scroller).focus({ preventScroll: true });
      return;
    }
    if (a.dataset.slug) { e.preventDefault(); this.show(a.dataset.slug); }
  }

  // ------------------------------------------------------------ phones: swipe down to close
  onTouchStart(e) {
    if (this.state !== "open" || !this.phoneQ.matches || e.touches.length !== 1) { this.drag = null; return; }
    const t = e.touches[0];
    this.drag = { x0: t.clientX, y0: t.clientY, grip: this.grip.contains(e.target), top: this.scroller.scrollTop <= 0, on: false, base: 0, pts: [[e.timeStamp, t.clientY]] };
  }
  onTouchMove(e) {
    const d = this.drag;
    if (!d || e.touches.length !== 1) return;
    const t = e.touches[0], dy = t.clientY - d.y0, dx = t.clientX - d.x0;
    if (!d.on) {
      const pulling = (d.grip || (d.top && this.scroller.scrollTop <= 0)) && dy > 0;
      if (!pulling) { if (Math.abs(dy) > 6 || Math.abs(dx) > 6) this.drag = null; return; }   // a scroll: native
      if (e.cancelable) e.preventDefault();
      if (dy < 4 || Math.abs(dx) > dy * 1.2) return;
      d.on = true; d.base = dy;
    }
    if (e.cancelable) e.preventDefault();
    const y = Math.max(0, dy - d.base);
    this.sheet.style.transform = `translateY(${y}px)`;
    this.scrim.style.opacity = String(1 - 0.85 * Math.min(1, y / this.sheet.offsetHeight));
    d.y = y;
    d.pts.push([e.timeStamp, t.clientY]);
    if (d.pts.length > 6) d.pts.shift();
  }
  onTouchEnd() {
    const d = this.drag;
    this.drag = null;
    if (!d || !d.on) return;
    const y = d.y || 0;
    const [t0, y0] = d.pts[0], [t1, y1] = d.pts[d.pts.length - 1];
    const v = t1 > t0 ? (y1 - y0) / (t1 - t0) : 0;
    if (y > this.sheet.offsetHeight * 0.22 || (v > 0.45 && y > 24)) { this.close({ velocity: Math.max(0, v) }); return; }
    const back = this.sheet.animate([{ transform: `translateY(${y}px)` }, { transform: "none" }], { duration: 300, easing: EASE });
    const op = +this.scrim.style.opacity || 1;
    this.scrim.animate([{ opacity: op }, { opacity: 1 }], { duration: 300, easing: EASE });
    this.sheet.style.transform = "";
    this.scrim.style.opacity = "";
    back.finished.catch(() => {});
  }
}
