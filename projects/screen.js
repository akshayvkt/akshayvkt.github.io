// The Projects page on the laptop's screen in the live room (Akshay, 2026-10-15: "the laptop is a computer you use").
//
//   import { createScreen } from "/projects/screen.js";
//   const scr = createScreen({ onRoute: (slug, { push }) => …, reduced: () => bool });
//   parent.appendChild(scr.host); await scr.ready;   // the router places scr.host on the 3D screen every frame
//   scr.setSize(w, h, { keep, phone })  // the layout box (CSS px); keep: the words at the top stay at the top;
//                                       // phone: the laptop's phone box (DYS-181: less space above his About)
//   scr.show("sf-housing") / scr.show(null)   // a project, or the list (no history: the router owns it)
//   scr.section("about" | "projects", { smooth })   // the list, at that part of it (v3/laptop-phone)
//   scr.scrollBy(dy); scr.heading(); scr.state(); scr.restore(state)
//   scr.changes                         // how many times it was sent somewhere (show, section, restore): a count
//   scr.refresh()                       // its page laid out once more at its size (nothing on screen changes)
//   scr.setSmall(on)                    // nav-r1 item 9: the page too small to use in place: a tap opens it (onTap)
//   scr.dip(on)                         // a short fade to the page's white and back (a change of layout); a promise
//   scr.setLight([r, g, b], ms)         // the screen's brightness and tint (multiplied over the page); null: as it is
//   scr.setShade({ rgb, a0, f, a1 })    // the page veil's share over the screen (a gradient from top to foot); null: none
//
// Live room 2 (Akshay, 16 Oct: "the design of it is primitive compared to what the actual page looks like"): the
// screen is the real Projects page, the one a visitor's browser shows at akshaychintalapati.com/projects/: the website
// repo's own projects/index.html and its bundle, in a same-origin frame. The room's Projects document covers that
// file at /projects/, so scripts/live/assemble.py links it again at /projects/page/ (a link, nothing copied): the
// screen and the site cannot drift. (projects-polish, 28 Oct: that bundle was the website's of 13 Oct, so later changes
// to his projects never reached the screen; web/projects/page/ is now that page with today's projects,
// scripts/live/projects_page.mjs, and assemble.py serves it there instead.) The frame's layout box is the screen's
// size on screen when leaned in, so there the page is drawn 1:1, as in a browser window of that size, and its input is native; further away it is scaled
// down with the screen. The page routes by its hash (#/project/<slug>); here its links route through the room's
// history (the frame's own history never grows: its address only ever changes by location.replace), outside links
// open in a new tab and mail opens the mail app, a pinch never zooms it, and Escape inside it leans back as anywhere
// in the room. No words of its own: every visible word is the page's. (screen-data.js, the projects' slugs and
// names from research/portfolio's src/projects.js, still answers routeOf and titleOf before the page has loaded.)
//
// A laptop's size (nav-r1, Akshay 17 Oct: "why is this stuff so huge on the screen?"): the laptop's frame is laid out
// at a real laptop browser's 1440 CSS px and scaled onto the 3D screen (shared/laptop.js). Phones (v3/laptop-phone)
// lay it out again leaned in, at the screen's own size, and use it there; where even that is too small, the screen
// shows it all the same and a cover over it takes the tap (or Enter): onTap opens the page itself in the reading
// sheet, a second screen made here with { className } and laid out at the sheet's own size (the page's narrow layout).
//
// About and Projects as one page (v3/laptop-phone, Akshay 20 Oct: "lets combine About and Projects into one - show
// both on the laptop ... so user can know both exist without having to click to laptop and click around"): on the
// list, under the page's own header, his About: the homepage's #about word for word and his five links (#social's,
// their own icons and names), then the Projects page as it is. Two small labels name the parts, "About" and
// "Projects", in the page's own small-heading style; the page's "Projects" heading above the list gives its place to
// the second (it still names the list for a screen reader). A project's page is his page as it is. The page's own
// app redraws its whole page on each route, so the block goes back in each time the list is drawn.
//
// The desk view (Akshay, 21 Oct, option A: "why not keep this even in the original view when the laptop isnt
// selected?"): the screen shows the real page, its top, at a laptop's scale, from everywhere; the photographs carry a
// shot of it (scripts/live/laptop_page_shot.mjs, laptop_idle_photos.py). Its brightness is a real screen's at each
// moment (setLight: by day the photograph's own screen white, in a dark room a soft glow; never paper-white there),
// and on the homepage it takes the page veil's share where it lies (setShade), as the photograph under that veil does.
// Two of his page's lines read differently here (Akshay, 21 Oct): no 'Email' at its top right (his five links carry
// it), and the Projects question is a quiet pull quote (regular weight, body size + 1, his text colour, line height
// 1.5, at most 34em wide, a 2 px soft grey rule on its left).
//
// Readability (Akshay, 23 Oct: "reduce the whitespace above 2026 and below 'that question' by 50%. also can we make
// all the content on this page like 10% bigger"): the whole page on the screen is drawn 10 % bigger (ZOOM, CSS zoom on
// his page's root, as a browser at 110 %: laid out and drawn at that size, so the type stays sharp and the lines keep
// their words; his page's own breakpoints still go by the frame's width), at the desk, leaned in, in the reading sheet
// and on a project's page alike; and the space between his intro's last line and the first year is half of today's in
// the frame's own px (122 to 61, 92 to 46 in the narrow layout).
import { projects } from "./screen-data.js";

export const ZOOM = 1.1;

export const PAGE = "/projects/page/";
export const projectURL = (slug) => (slug ? `/projects/#/project/${slug}` : "/projects/");
export const routeOf = (href) => {
  const m = String(href || "").match(/#\/project\/([^/?#]+)/);
  return m && projects.some((p) => p.slug === m[1]) ? m[1] : null;
};
let live = null;   // the screen's frame document, once its page is drawn: its own title wins
export const titleOf = (slug) => {
  const t = live?.route === (slug || null) && live.doc?.title;
  if (t) return t;
  const p = slug && projects.find((x) => x.slug === slug);
  return p ? `${p.name} - Akshay Chintalapati` : "Akshay Chintalapati - Projects";
};

// the homepage's #about and #social: this document's own (the homepage), or the homepage's HTML read once
let home = null;
const homeBlocks = () => (home ??= (document.getElementById("about")
  ? Promise.resolve(document)
  : fetch("/").then((r) => (r.ok ? r.text() : "")).then((t) => new DOMParser().parseFromString(t, "text/html")).catch(() => null))
  .then((d) => ({ about: d?.getElementById("about") || null, social: d?.getElementById("social") || null })));

// ---------- the screen ----------
const OWN = `:host { all: initial; display: block; contain: layout style; }
.screen-page { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; background: #fff; color-scheme: light; }
.screen-tap { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; background: transparent; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.screen-tap[hidden] { display: none; }
.screen-tap:focus { outline: none; }
.screen-tap:focus-visible { outline: var(--tap-ring, 2px) solid rgba(31, 27, 22, 0.85); outline-offset: calc(-1 * var(--tap-ring, 2px)); }
.screen-light { position: absolute; inset: 0; pointer-events: none; mix-blend-mode: multiply; background: var(--screen-light, transparent);
  transition: background-color var(--light-fade, 0ms) linear; }
.screen-shade { position: absolute; inset: 0; pointer-events: none; background: var(--screen-shade, none); }
.screen-dip { position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none; }
.screen-dip[hidden], .screen-light[hidden], .screen-shade[hidden] { display: none; }`;
// (the room focuses the page's heading as it lands, for screen readers: no ring is drawn for that, as on the room's
// own headings; the page's links keep their own focus style)
// The About block in the page's own type and greys: the labels as his project pages' small headings (13 px, 590, the
// muted grey), the bio as his intro's paragraphs (16 px, 15 px in the narrow layout) in his darker grey, his five
// icons in his back link's grey with a 40 px target each.
// (DYS-82: no entrance for the page on the laptop's screen: the room's lean-in is its entrance. The website's own
// .page-enter, a 5 px rise and fade over 0.42 s, kept an animated layer the page's full height (848 x 3418, D's layer
// tree mid-glide) and put DYS-38's phone landing 5 px off. The website's page itself keeps it.)
const INSIDE = `html { overscroll-behavior: contain; -webkit-tap-highlight-color: transparent; }
.page-enter { animation: none; }
#root { zoom: ${ZOOM}; }
#root .home-main .projects { margin-top: calc(122px / 2 / ${ZOOM}); }
@media (max-width: 720px) { #root .home-main .projects { margin-top: calc(92px / 2 / ${ZOOM}); } }
#root h1[tabindex="-1"]:focus { outline: none; }
.sfw-one .sfw-label { margin: 0 0 14px; color: #8b8b87; font-size: 13px; font-weight: 590; line-height: 1.25; letter-spacing: .01em; }
.sfw-one .sfw-label:focus { outline: none; }
.sfw-one .sfw-about p { max-width: 640px; margin: 0; color: #545450; font-size: 16px; line-height: 1.55; }
.sfw-one .sfw-about p + p { margin-top: .7em; }
.sfw-one .sfw-links { display: flex; flex-wrap: wrap; gap: 2px; margin: 14px 0 0 -11px; }
.sfw-one .sfw-links a { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 10px; color: #8a8a86; transition: color .16s ease; }
.sfw-one .sfw-links a:hover, .sfw-one .sfw-links a:focus-visible { color: var(--text, #171717); }
.sfw-one .sfw-links a:focus-visible { outline: none; box-shadow: 0 0 0 3px #d9e4ff; }
.sfw-one .sfw-links svg { display: block; width: 18px; height: 18px; fill: currentColor; }
.sfw-one .sfw-projects { margin-top: 72px; }
.home-main .projects > h2 { display: none; }
.site-header nav a[href^="mailto:"] { display: none !important; }
#root .intro h1 { max-width: 34em; margin: 0; padding: 0 0 0 15px; border-left: 2px solid #8b8b87; color: var(--text, #171717);
  font-size: 17px; font-weight: 400; line-height: 1.5; letter-spacing: 0; }
@media (max-width: 720px) { #root .intro h1 { font-size: 16px; } }
@media (max-width: 720px) { .sfw-one .sfw-about p { font-size: 15px; } .sfw-one .sfw-projects { margin-top: 56px; } }
@media (pointer: coarse), (max-width: 720px) {
  .site-header a { padding: 14px 0; margin: -14px 0; }
  .back-link { padding: 13px 0; margin-top: -13px; margin-bottom: 37px; }
  .project-pagination a { padding: 10px 0; margin: -10px 0; }
}
@media (max-width: 720px) { .back-link { margin-bottom: 23px; } }
html[data-sfw-box="phone"] #root .site-header { padding: 10px 0 13px; }
html[data-sfw-box="phone"] .sfw-one .sfw-label { margin-bottom: 5px; }`;
// (a finger's targets: his header's links, the back link and the next project, each at least 40 px tall, their look and
// place unchanged: the padding is given back by a negative margin; below the back link his 50 px, 36 px in the narrow
// layout, are 37 + 13 and 23 + 13)
// (DYS-181, from DYS-179's review: in the laptop's phone box (shared/laptop.js PHONE_K, a window about 407 x 254 page
// px on a 390 x 844 phone) his page's own top spacing, the header's 24 + 66 px around his name and the label's 14 px
// under "About" (x 1.1, ZOOM), took 147 of its 254 px, so about 4 lines of his About showed at rest. There, as a laptop
// browser's short window would, the header keeps 10 px above his name and 13 px below it, and the labels 5 px above
// their text: the About starts at 63 px instead of 147 and about 7 lines show (8 would leave no space at all between
// the name, the label and the text). Only in that box (setSize's phone: the html element's data-sfw-box): the
// desktop's laptop page, portrait tablets' narrow box and the website's own /projects/ page keep their spacing, and no
// text changes size. At the page's very top his name's finger target (14 px over and under it) runs 4 px past the
// window's top edge: 37 of its 41 px on the screen.)
const until = (test, ms, every = 50) => new Promise((res) => {
  const t0 = performance.now();
  const go = () => { const v = test(); if (v || performance.now() - t0 > ms) res(v); else setTimeout(go, every); };
  go();
});
const frames = (n = 2) => new Promise((r) => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : r()); f(); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// what a scroll position is kept by across a change of layout: the first of these at the top of the screen, and how
// far into it (the page's words, pictures and rows are the same elements in both layouts)
const ANCHOR = "h1, h2, h3, p, li, a.project-row, figure, img, video, dt, dd, blockquote, .back-link";
const DIP_IN = 120, DIP_OUT = 220;
// DYS-159: never Safari's own page zoom from the laptop's page on a touch screen. iOS ignores the viewport's
// user-scalable and starts its zoom from WebKit's pinch events (gesturestart / gesturechange) whatever became of the
// touches; cancelled, the room's pinch is the only one there. On the frame's document, and on the screen's shadow root
// should WebKit send them to the frame's element. Touch screens only: a Mac's trackpad pinch in Safari stays as it is
const noPageZoom = (el) => {
  if (!el || !((navigator.maxTouchPoints || 0) > 0)) return;
  const hold = (e) => { if (e.cancelable) e.preventDefault(); };
  el.addEventListener("gesturestart", hold, { passive: false });
  el.addEventListener("gesturechange", hold, { passive: false });
};

export function createScreen({ onRoute = () => {}, reduced = () => false, onTap = null, onPinch = null, className = "sfw-screen" } = {}) {
  const host = document.createElement("div");
  host.className = className;
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = OWN;
  const frame = document.createElement("iframe");
  frame.className = "screen-page";
  frame.title = "Projects";  // (its accessible name: the masthead's word for the page; a frame's title is never painted)
  frame.src = PAGE;
  // the page too small to use in place (setSmall): a cover takes the tap and Enter; its name is the page's word
  const tap = document.createElement("button");
  tap.type = "button";
  tap.className = "screen-tap";
  tap.setAttribute("aria-label", "Projects");
  tap.setAttribute("tabindex", "0");   // (the room's landing focus keeps it in the tab order)
  tap.hidden = true;
  tap.addEventListener("click", (e) => { e.stopPropagation(); onTap?.(); });
  // (the wheel over the cover still scrolls the page under it, as the wheel over the room around the screen does)
  tap.addEventListener("wheel", (e) => { if (e.ctrlKey) return; e.preventDefault(); se()?.scrollBy({ top: e.deltaY, left: 0 }); }, { passive: false });
  // over the page: the dip of a change of layout (the page's white), then its brightness (multiplied) and the page
  // veil's share over both, so a dip in a dark room is never brighter than the page it covers
  const light = document.createElement("div");
  light.className = "screen-light";
  light.hidden = true;
  const shade = document.createElement("div");
  shade.className = "screen-shade";
  shade.hidden = true;
  const dipEl = document.createElement("div");
  dipEl.className = "screen-dip";
  dipEl.hidden = true;
  let small = false;
  let changes = 0;           // show, section and restore calls (shared/laptop.js: a kept state still the latest word)
  root.append(style, frame, dipEl, light, shade, tap);
  if (onPinch) noPageZoom(root);   // (the laptop's screen: its pinch is the room's, pinchOut below)

  let route = null;          // null: the list; a slug: that project
  let listTop = 0;
  let listAt = null;         // the list's place as an anchor, and the layout width it was taken at
  let size = [0, 0];
  let phoneBox = false;      // DYS-181: the laptop's phone box (setSize's phone): the html element's data-sfw-box="phone"
  const markBox = () => { const e = doc()?.documentElement; if (e) { if (phoneBox) e.dataset.sfwBox = "phone"; else delete e.dataset.sfwBox; } };
  let want = null;           // a route asked for before the page was ready
  let pending = null;        // a scroll position to restore once a route has drawn
  let goal = null;           // ... and where that route lands ({ top, at, w }; null: a part of the list), for state()
  let focusAbout = false;    // the last section asked for was About: its label is the heading to focus
  let atSection = null;      // { name, top }: the list was put at that part and has not been scrolled since
  const win = () => frame.contentWindow;
  const doc = () => { try { return frame.contentDocument; } catch { return null; } };
  const se = () => doc()?.scrollingElement || null;
  const drawn = () => { const d = doc(); return !!(d && d.querySelector("#root .page-shell")); };
  const scrollTo = (y) => { const s = se(); if (s) s.scrollTop = y; };
  let kept = 0;                // the scroll position last seen (a reload of the frame comes back to it)
  frame.addEventListener("load", () => { try { win()?.addEventListener("scroll", () => { kept = se()?.scrollTop || 0; }, { passive: true }); } catch { /* */ } });

  // the scroll position as an anchor: the first element at the top of the screen and how far into it (null: none)
  const anchorNow = () => {
    const d = doc(), s = se(), r = d?.getElementById("root");
    if (!r || !s) return null;
    if (s.scrollTop <= 1) return { top: true };
    const els = r.querySelectorAll(ANCHOR);
    for (let i = 0; i < els.length; i++) {
      const b = els[i].getBoundingClientRect();
      if (b.height > 0 && b.bottom > 0) return { i, n: els.length, f: Math.max(0, -b.top) / b.height, y: Math.max(0, b.top) };
    }
    return null;
  };
  const toAnchor = (a) => {
    const d = doc(), s = se(), r = d?.getElementById("root");
    if (!a || !r || !s) return false;
    if (a.top) { s.scrollTop = 0; return true; }
    const els = r.querySelectorAll(ANCHOR);
    if (els.length !== a.n || !els[a.i]) return false;
    const b = els[a.i].getBoundingClientRect();
    s.scrollTop += b.top + a.f * b.height - a.y;
    return true;
  };

  // the About block on the list (built once per frame document; back in place each time the list is drawn)
  let one = null;
  const placeOne = () => {
    const d = doc();
    if (!one || !d || one.ownerDocument !== d) return;
    const main = d.querySelector("#root .home-main");
    if (main) { if (one.parentNode !== main.parentNode || one.nextSibling !== main) main.before(one); }
    else if (one.isConnected) one.remove();
  };
  const buildOne = async (d) => {
    const { about, social } = await Promise.race([homeBlocks(), wait(4000).then(() => ({}))]);
    const paras = about ? [...about.querySelectorAll(".col > p")] : [];
    if (!paras.length || doc() !== d) return;
    const wrap = d.createElement("div");
    wrap.className = "sfw-one";
    const sec = d.createElement("section");
    sec.className = "sfw-about";
    sec.setAttribute("aria-labelledby", "sfw-about");
    const label = (id, text, cls = "") => { const h = d.createElement("h2"); h.id = id; h.className = ("sfw-label " + cls).trim(); h.tabIndex = -1; h.textContent = text; return h; };
    sec.append(label("sfw-about", "About"));
    for (const p of paras) sec.append(d.importNode(p, true));
    const icons = social ? [...social.querySelectorAll("a.icon")] : [];
    if (icons.length) {
      const row = d.createElement("div");
      row.className = "sfw-links";
      for (const a of icons) { const c = d.importNode(a, true); c.removeAttribute("class"); row.append(c); }
      sec.append(row);
    }
    wrap.append(sec, label("sfw-projects", "Projects", "sfw-projects"));
    one = wrap;
    placeOne();
    new MutationObserver(placeOne).observe(d.getElementById("root"), { childList: true, subtree: true });
  };
  // the list's parts: About from the page's top, Projects with its label where the page's header starts the page
  const sectionTop = (name) => {
    const d = doc(), s = se();
    if (!d || !s || name !== "projects") return 0;
    const l = d.getElementById("sfw-projects"), hd = d.querySelector("#root .site-header");
    if (!l || !l.isConnected) return 0;
    // (the header's padding as drawn: its style is in the page's own px, under ZOOM on screen)
    const pad = (hd ? parseFloat(win().getComputedStyle(hd).paddingTop) || 24 : 24) * ((hd && hd.currentCSSZoom) || ZOOM);
    // (where the label rests, not where an animation has it now: the page's entrance (.page-enter, translateY(5px) to 0
    // over 0.42 s) was still in its box when a phone's reload placed the list, 715 for a part that rests at 710. DYS-24 /
    // DYS-38, B 28 Oct; a transform changes no size, so the hold below never saw it. Nothing moving: no change)
    let moving = 0;
    for (let e = l.parentElement; e && e !== d.body; e = e.parentElement) {
      const t = win().getComputedStyle(e).transform;
      if (t && t !== "none") moving += new (win().DOMMatrixReadOnly)(t).m42 * (e.currentCSSZoom || ZOOM);
    }
    return Math.max(0, Math.round(l.getBoundingClientRect().top - moving + s.scrollTop - pad));
  };
  // (a part of the list it was put at, not scrolled since, stays at that part while the page's layout settles under it:
  // a font, an icon or a picture above the label arriving after the list was placed. DYS-24: a phone's reload at the
  // laptop landed 5 px past the Projects label. Checked before each frame is drawn, whenever the page's size changes)
  const holdSection = () => {
    const s = se();
    if (!atSection || route !== null || pending || !s || Math.abs(s.scrollTop - atSection.top) > 1) return;
    const y = Math.min(sectionTop(atSection.name), Math.max(0, s.scrollHeight - s.clientHeight));
    if (Math.abs(y - s.scrollTop) > 0.5) { scrollTo(y); atSection = { name: atSection.name, top: s.scrollTop }; }
  };
  frame.addEventListener("load", () => {
    try { const r = doc()?.getElementById("root"), RO = win()?.ResizeObserver; if (r && RO) new RO(holdSection).observe(r); } catch { /* */ }
    pinchOut(doc());
  });
  // DYS-33 (a): two fingers on the page are the room's (onPinch: zoom in toward the screen, and pan along it walked in),
  // never the page's own pinch or a scroll: their touches are passed out in the frame's client px ("start" / "move" /
  // "end"); one finger scrolls the page as always
  function pinchOut(d) {
    if (!onPinch || !d) return;
    let on = false;
    const two = (e) => [...e.touches].slice(0, 2).map((t) => [t.clientX, t.clientY]);
    d.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 2) return;
      on = true;
      if (e.cancelable) e.preventDefault();
      const [a, b] = two(e);
      onPinch("start", a, b);
    }, { passive: false });
    d.addEventListener("touchmove", (e) => {
      if (!on) return;
      if (e.cancelable) e.preventDefault();
      if (e.touches.length >= 2) { const [a, b] = two(e); onPinch("move", a, b); }
    }, { passive: false });
    const end = (e) => { if (on && e.touches.length < 2) { on = false; onPinch("end"); } };
    d.addEventListener("touchend", end);
    d.addEventListener("touchcancel", end);
    noPageZoom(d);
  }

  // the page's own route (its hash), changed without a history entry; the list comes back at its scroll position
  // (at: { a, w }, the same place as an anchor taken at layout width w: used instead when the width is another now;
  // section: a part of the list)
  const go = async (slug, top = null, { at = null, section = null } = {}) => {
    const d = doc(), w = win();
    if (!d || !w || !drawn()) { want = { slug, top, at, section }; route = slug; return; }
    // (the list's place as it is left; not while the list is still on its way back to a kept place: that place stands)
    if (route === null && !pending) { listTop = se()?.scrollTop || 0; listAt = { a: anchorNow(), w: size[0] }; }
    for (const v of d.querySelectorAll("video")) v.pause();
    route = slug;
    const hash = slug ? `#/project/${slug}` : "#/";
    if (w.location.hash !== hash && !(hash === "#/" && !w.location.hash)) w.location.replace(PAGE + hash);
    const use = at || (!slug && top == null && !section ? listAt : null);
    const y = top ?? (slug ? 0 : listTop);
    const mark = {};
    pending = mark;
    goal = section ? null : { top: y, at: use?.a || null, w: use?.w || size[0] };
    // (the page scrolls itself to the top as it draws a route: the kept position goes back after that)
    await until(() => drawn() && (slug ? d.querySelector(".project-page") : !d.querySelector(".project-page")), 1500);
    await frames(2);
    if (pending === mark) {
      placeOne();
      if (section) { scrollTo(sectionTop(section)); atSection = { name: section, top: se()?.scrollTop || 0 }; }
      else { atSection = null; if (!(use?.a && use.w && use.w !== size[0] && toAnchor(use.a))) scrollTo(y); }
      pending = null;
    }
    live = { doc: d, route };
  };

  // the page's links: its routes on the screen (the room's history), outside links in a tab, mail in the mail app
  const onClick = (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.("a[href]");
    if (!a) return;
    const href = a.getAttribute("href") || "";
    e.preventDefault();
    if (href.startsWith("#")) {
      const slug = routeOf(href);
      focusAbout = false;
      if (slug === route) { scrollTo(0); return; }
      // (projects-polish, Akshay 28 Oct: "when i look at a project and go back to projects list, cant the laptop remember
      // where i was before i clicked into the project": a project's links back to the list, "← Projects", "All
      // projects" and his name, bring the list back where it was left, as Back does; a project opens at its top)
      go(slug, slug ? 0 : null).then(() => {   // (the router focuses the heading as it routes; the new page's heading is drawn now)
        const h = doc()?.querySelector("#root h1");
        if (h && host.classList.contains("is-on")) { if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
      });
      onRoute(slug, { push: true });
      return;
    }
    const u = new URL(a.href, location.href);
    if (u.protocol === "mailto:") { location.href = u.href; return; }
    if (u.protocol === "http:" || u.protocol === "https:") window.open(u.href, "_blank", "noopener");
  };

  // every load of the frame (the first, and any after the host is moved in the document, which reloads a frame): its
  // listeners, the About block, and the route and scroll it should show
  let first = null;
  const ready = new Promise((resolve, reject) => { first = { resolve, reject }; });
  frame.addEventListener("load", async () => {
    const d = doc(), w = win();
    if (!d || !w || !(await until(drawn, 8000))) { first?.reject(new Error("the Projects page did not draw")); first = null; return; }
    if (d.documentElement.dataset.sfwScreen) return;
    d.documentElement.dataset.sfwScreen = "1";
    const st = d.createElement("style");
    st.id = "sfw-screen-style";   // (the smoke's laptop.scale gives its reference frame the same)
    st.textContent = INSIDE;
    d.head.appendChild(st);
    markBox();   // (a reload of the frame: the box it is in now)
    d.addEventListener("click", onClick, true);
    // a pinch (ctrl+wheel) never zooms the page; Escape leans back, as anywhere in the room
    w.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
    d.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      frame.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, composed: true }));
    });
    await buildOne(d);
    live = { doc: d, route: null };
    // (a reload while the list sat at a part it was put at, not scrolled since: that part again, measured in this
    // document, not the old one's pixel offset. DYS-24 / DYS-38: the router moves the screen into the tab order once it
    // is ready, which reloads the frame, just as a phone's reload put the list at its Projects part: 715 kept, 710 here)
    const held = !first && !want && route === null && atSection && Math.abs(kept - atSection.top) <= 1 ? atSection.name : null;
    const again = want || (first ? null : held ? { slug: null, section: held } : { slug: route, top: kept });
    want = null;
    if (again) { const r = again.slug ?? null; route = undefined; await go(r, again.top, { at: again.at, section: again.section }); }   // (undefined: the list's kept position stays)
    if (first) { first.resolve(); first = null; }
  });
  ready.catch(() => {});

  let dipAnim = null, dipOn = false;
  return {
    host,
    ready,
    frame,
    get scroller() { return se(); },
    get document() { return doc(); },
    get route() { return route; },
    get size() { return size; },
    setSize(w, hgt, { keep = false, phone = false } = {}) {
      // (a part of the list it was put at, not scrolled since, is that part again in the new layout; else the words at
      // the top stay at the top)
      const sec = keep && drawn() && route === null && atSection && Math.abs((se()?.scrollTop || 0) - atSection.top) <= 1 ? atSection.name : null;
      const a = keep && drawn() && !sec ? anchorNow() : null;
      size = [w, hgt];
      phoneBox = !!phone;
      markBox();   // (DYS-181: with the new box, in the same task: under the same dip)
      host.style.width = `${w}px`;
      host.style.height = `${hgt}px`;
      if (sec) { scrollTo(sectionTop(sec)); atSection = { name: sec, top: se()?.scrollTop || 0 }; }
      else if (a) toAnchor(a);   // (reading the frame's layout lays out this document first: the new width is in)
    },
    // The page laid out once more at its size, a pixel narrower and back in one task (nothing is drawn in between, and
    // the scroll is kept): the browser takes the page's hit areas afresh. (v3/laptop-phone, take A: a frame given its
    // phone layout while the room had it inert, as the glide in starts, could keep a finger's scroll from reaching it
    // once leaned in; laid out again after that, as the card era's layout at landing was, it takes the finger.)
    refresh() {
      const d = doc(), s = se();
      if (!d || !(size[0] > 1)) return;
      const top = s ? s.scrollTop : 0;
      host.style.width = `${size[0] - 1}px`;
      void d.documentElement.offsetWidth;
      host.style.width = `${size[0]}px`;
      void d.documentElement.offsetWidth;
      if (s && Math.abs(s.scrollTop - top) > 0.5) s.scrollTop = top;
    },
    // the page fades to its white (on) or back from it; resolves when that is done
    dip(on) {
      if (on === dipOn) return dipAnim ? dipAnim.finished.then(() => {}, () => {}) : Promise.resolve();
      dipOn = on;
      const from = dipEl.hidden ? 0 : +getComputedStyle(dipEl).opacity;
      dipAnim?.cancel();
      dipEl.hidden = false;
      dipEl.style.opacity = String(from);
      const a = (dipAnim = dipEl.animate([{ opacity: from }, { opacity: on ? 1 : 0 }],
        { duration: (on ? DIP_IN : DIP_OUT) * Math.abs((on ? 1 : 0) - from), easing: on ? "ease-in" : "ease-out", fill: "forwards" }));
      return a.finished.then(() => {
        if (dipAnim !== a) return;
        dipEl.style.opacity = on ? "1" : "0";
        a.cancel();
        dipAnim = null;
        if (!on) dipEl.hidden = true;
      }, () => {});
    },
    // the screen's brightness and tint: the page multiplied by this colour (a real screen's white at the room's
    // moment); faded over ms (a change of moment), else at once (the lean-in's own easing)
    setLight(rgb, ms = 0) {
      const on = Array.isArray(rgb) && rgb.length === 3 && rgb.some((v) => v < 254.5);
      host.style.setProperty("--light-fade", `${Math.max(0, ms | 0)}ms`);
      if (on) host.style.setProperty("--screen-light", `rgb(${rgb.map((v) => Math.round(v)).join(", ")})`);
      else host.style.setProperty("--screen-light", "rgb(255, 255, 255)");
      light.hidden = !on && !ms;
    },
    // the page veil's share over the screen: its colour, its alpha at the top (a0) down to f (0-1 of the height), then
    // to a1 at the foot; null: none
    setShade(v) {
      const on = !!v && (v.a0 > 0.001 || v.a1 > 0.001);
      host.style.setProperty("--screen-shade", on
        ? `linear-gradient(180deg, rgba(${v.rgb}, ${v.a0.toFixed(4)}) 0%, rgba(${v.rgb}, ${v.a0.toFixed(4)}) ${(v.f * 100).toFixed(2)}%, rgba(${v.rgb}, ${v.a1.toFixed(4)}) 100%)` : "none");
      shade.hidden = !on;
    },
    setScheme() {},          // (the page has one look, a lit white screen, at every hour)
    setColour() {},
    show(slug) { changes++; focusAbout = false; if ((slug || null) !== route || want) { atSection = null; go(slug || null); } },
    // v3/laptop-phone: the list at one of its parts (About: the page's top; Projects: its label at the top)
    section(name, { smooth = false } = {}) {
      changes++;
      focusAbout = name === "about";
      if (route !== null || want || !drawn()) return go(null, null, { section: name });
      const s = se(), top = sectionTop(name);
      if (s) s.scrollTo({ top, left: 0, behavior: smooth && !reduced() ? "smooth" : "auto" });
      atSection = s ? { name, top: Math.min(top, Math.max(0, s.scrollHeight - s.clientHeight)) } : null;
      return Promise.resolve();
    },
    sectionTop,
    scrollBy(dy) { se()?.scrollBy({ top: dy, left: 0 }); },
    heading() {
      if (small) return tap;
      const d = doc();
      return (focusAbout && route === null && d?.getElementById("sfw-about")) || d?.querySelector("#root h1") || null;
    },
    // nav-r1 item 9: too small to use in place, the page takes no input and the cover the tap (ring: its outline width
    // in the page's px, so it draws about 2 px on screen whatever the scale)
    setSmall(on, ring = 2) {
      small = !!on && !!onTap;
      tap.hidden = !small;
      frame.inert = small;
      host.style.setProperty("--tap-ring", `${ring.toFixed(1)}px`);
    },
    get small() { return small; },
    get changes() { return changes; },
    // (with the layout's width and anchors, so a state kept from one layout comes back right in another)
    // (projects-polish: while a route is still drawing, where it lands, not the page it leaves: the router saves the
    // state as a link is followed, before the new page is up)
    state() {
      const g = pending ? goal : null;
      const top = g ? g.top : se()?.scrollTop || 0, a = g ? g.at : drawn() ? anchorNow() : null, w = g ? g.w : size[0];
      return { route, top: route ? top : 0, listTop: route === null ? top : listTop, w,
        at: route ? a : null, listAt: route === null ? a : listAt?.a || null, listW: route === null ? w : listAt?.w || 0 };
    },
    // (a promise: done once the route has drawn at its place)
    restore(s) {
      if (!s) return Promise.resolve();
      changes++;
      listTop = s.listTop || 0;
      listAt = s.listAt ? { a: s.listAt, w: s.listW || s.w || 0 } : null;
      const slug = s.route && projects.some((p) => p.slug === s.route) ? s.route : null;
      const top = slug ? s.top || 0 : listTop;
      const at = slug ? (s.at ? { a: s.at, w: s.w || 0 } : null) : listAt;
      if (!drawn()) { want = { slug, top, at }; route = slug; return Promise.resolve(); }
      route = undefined;
      return go(slug, top, { at });
    },
    pause(on) { for (const v of doc()?.querySelectorAll("video") || []) { if (on) v.pause(); else if (v.autoplay) v.play().catch(() => {}); } },
  };
}
