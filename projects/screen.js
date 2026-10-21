// The Projects page on the laptop's screen in the live room (Akshay, 2026-10-15: "the laptop is a computer you use").
//
//   import { createScreen } from "/projects/screen.js";
//   const scr = createScreen({ onRoute: (slug, { push }) => …, reduced: () => bool });
//   parent.appendChild(scr.host); await scr.ready;   // the router places scr.host on the 3D screen every frame
//   scr.setSize(w, h);                  // the layout box: the screen's size on screen when leaned in (CSS px)
//   scr.show("sf-housing") / scr.show(null)   // a project, or the list (no history: the router owns it)
//   scr.scrollBy(dy); scr.heading(); scr.state(); scr.restore(state)
//   scr.setSmall(on)                    // nav-r1 item 9: the page too small to use in place: a tap opens it (onTap)
//
// Live room 2 (Akshay, 16 Oct: "the design of it is primitive compared to what the actual page looks like"): the
// screen is the real Projects page, the one a visitor's browser shows at akshayvkt.github.io/projects/: the website
// repo's own projects/index.html and its bundle, in a same-origin frame. The room's Projects document covers that
// file at /projects/, so scripts/live/assemble.py links it again at /projects/page/ (a link, nothing copied): the
// screen and the site cannot drift. The frame's layout box is the screen's size on screen when leaned in, so there
// the page is drawn 1:1, as in a browser window of that size, and its input is native; further away it is scaled
// down with the screen. The page routes by its hash (#/project/<slug>); here its links route through the room's
// history (the frame's own history never grows: its address only ever changes by location.replace), outside links
// open in a new tab and mail opens the mail app, a pinch never zooms it, and Escape inside it leans back as anywhere
// in the room. No words of its own: every visible word is the page's. (screen-data.js, the projects' slugs and
// names from research/portfolio's src/projects.js, still answers routeOf and titleOf before the page has loaded.)
//
// A laptop's size (nav-r1, Akshay 17 Oct: "why is this stuff so huge on the screen?"): the laptop's frame is laid out
// at a real laptop browser's 1440 CSS px and scaled onto the 3D screen (shared/laptop.js). Where that makes the page's
// type too small to use in place (phones), the screen shows it all the same and a cover over it takes the tap (or
// Enter): onTap opens the page itself in the reading sheet, a second screen made here with { className } and laid
// out at the sheet's own size (the page's narrow layout there).
import { projects } from "./screen-data.js";

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

// ---------- the screen ----------
const OWN = `:host { all: initial; display: block; contain: layout style; }
.screen-page { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; background: #fff; color-scheme: light; }
.screen-tap { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; background: transparent; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.screen-tap[hidden] { display: none; }
.screen-tap:focus { outline: none; }
.screen-tap:focus-visible { outline: var(--tap-ring, 2px) solid rgba(31, 27, 22, 0.85); outline-offset: calc(-1 * var(--tap-ring, 2px)); }`;
// (the room focuses the page's heading as it lands, for screen readers: no ring is drawn for that, as on the room's
// own headings; the page's links keep their own focus style)
const INSIDE = `html { overscroll-behavior: contain; -webkit-tap-highlight-color: transparent; }
#root h1[tabindex="-1"]:focus { outline: none; }`;
const until = (test, ms, every = 50) => new Promise((res) => {
  const t0 = performance.now();
  const go = () => { const v = test(); if (v || performance.now() - t0 > ms) res(v); else setTimeout(go, every); };
  go();
});
const frames = (n = 2) => new Promise((r) => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : r()); f(); });

export function createScreen({ onRoute = () => {}, reduced = () => false, onTap = null, className = "sfw-screen" } = {}) {
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
  let small = false;
  root.append(style, frame, tap);

  let route = null;          // null: the list; a slug: that project
  let listTop = 0;
  let size = [0, 0];
  let want = null;           // a route asked for before the page was ready
  let pending = null;        // a scroll position to restore once a route has drawn
  const win = () => frame.contentWindow;
  const doc = () => { try { return frame.contentDocument; } catch { return null; } };
  const se = () => doc()?.scrollingElement || null;
  const drawn = () => { const d = doc(); return !!(d && d.querySelector("#root .page-shell")); };
  const scrollTo = (y) => { const s = se(); if (s) s.scrollTop = y; };
  let kept = 0;                // the scroll position last seen (a reload of the frame comes back to it)
  frame.addEventListener("load", () => { try { win()?.addEventListener("scroll", () => { kept = se()?.scrollTop || 0; }, { passive: true }); } catch { /* */ } });

  // the page's own route (its hash), changed without a history entry; the list comes back at its scroll position
  const go = async (slug, top = null) => {
    const d = doc(), w = win();
    if (!d || !w || !drawn()) { want = { slug, top }; route = slug; return; }
    if (route === null) listTop = se()?.scrollTop || 0;
    for (const v of d.querySelectorAll("video")) v.pause();
    route = slug;
    const hash = slug ? `#/project/${slug}` : "#/";
    if (w.location.hash !== hash && !(hash === "#/" && !w.location.hash)) w.location.replace(PAGE + hash);
    const y = top ?? (slug ? 0 : listTop);
    pending = y;
    // (the page scrolls itself to the top as it draws a route: the kept position goes back after that)
    await until(() => drawn() && (slug ? d.querySelector(".project-page") : !d.querySelector(".project-page")), 1500);
    await frames(2);
    if (pending === y) { scrollTo(y); pending = null; }
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
      if (slug === route) { scrollTo(0); return; }
      go(slug, 0).then(() => {   // (the router focuses the heading as it routes; the new page's heading is drawn now)
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
  // listeners, and the route and scroll it should show
  let first = null;
  const ready = new Promise((resolve, reject) => { first = { resolve, reject }; });
  frame.addEventListener("load", async () => {
    const d = doc(), w = win();
    if (!d || !w || !(await until(drawn, 8000))) { first?.reject(new Error("the Projects page did not draw")); first = null; return; }
    if (d.documentElement.dataset.sfwScreen) return;
    d.documentElement.dataset.sfwScreen = "1";
    const st = d.createElement("style");
    st.textContent = INSIDE;
    d.head.appendChild(st);
    d.addEventListener("click", onClick, true);
    // a pinch (ctrl+wheel) never zooms the page; Escape leans back, as anywhere in the room
    w.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
    d.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      frame.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, composed: true }));
    });
    live = { doc: d, route: null };
    const again = want || (first ? null : { slug: route, top: kept });
    want = null;
    if (again) { const r = again.slug ?? null; route = undefined; await go(r, again.top); }   // (undefined: the list's kept position stays)
    if (first) { first.resolve(); first = null; }
  });
  ready.catch(() => {});

  return {
    host,
    ready,
    frame,
    get scroller() { return se(); },
    get document() { return doc(); },
    get route() { return route; },
    get size() { return size; },
    setSize(w, hgt) {
      size = [w, hgt];
      host.style.width = `${w}px`;
      host.style.height = `${hgt}px`;
    },
    setScheme() {},          // (the page has one look, a lit white screen, at every hour)
    setColour() {},
    show(slug) { if ((slug || null) !== route || want) go(slug || null); },
    scrollBy(dy) { se()?.scrollBy({ top: dy, left: 0 }); },
    heading() { return small ? tap : doc()?.querySelector("#root h1") || null; },
    // nav-r1 item 9: too small to use in place, the page takes no input and the cover the tap (ring: its outline width
    // in the page's px, so it draws about 2 px on screen whatever the scale)
    setSmall(on, ring = 2) {
      small = !!on && !!onTap;
      tap.hidden = !small;
      frame.inert = small;
      host.style.setProperty("--tap-ring", `${ring.toFixed(1)}px`);
    },
    get small() { return small; },
    state() { const top = se()?.scrollTop || 0; return { route, top: route ? top : 0, listTop: route === null ? top : listTop }; },
    restore(s) {
      if (!s) return;
      listTop = s.listTop || 0;
      const slug = s.route && projects.some((p) => p.slug === s.route) ? s.route : null;
      if (!drawn()) { want = { slug, top: slug ? s.top || 0 : listTop }; route = slug; return; }
      route = undefined;
      go(slug, slug ? s.top || 0 : listTop);
    },
    pause(on) { for (const v of doc()?.querySelectorAll("video") || []) { if (on) v.pause(); else if (v.autoplay) v.play().catch(() => {}); } },
  };
}
