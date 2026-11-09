// The Quotes page's behaviour, as a module that mounts on its <main> and can be unmounted: the page runs it on a
// direct load (quotes.html), and the homepage runs it when the live room glides to the print and moves this
// page's <main> in under the room (shared/router.js).
//
//   const page = mount(mainEl, { standalone: true });   // -> { room, print, anchors(), unmount() }
import { initMasthead } from "/shared/masthead.js";
import { mountRoom, bbox } from "/shared/room.js";
import { PAGES } from "/shared/pages.js";
import { mountPrint, dayIndex } from "/shared/print.js";

export function mount(root, { standalone = false } = {}) {
  if (standalone) initMasthead();
  const offs = [];
  const on = (target, type, fn, opt) => { target.addEventListener(type, fn, opt); offs.push(() => target.removeEventListener(type, fn, opt)); };

  const $ = (id) => root.querySelector(`#${id}`);
  const roomEl = $("print-room");
  const pager = $("pager");
  const items = [...root.querySelectorAll(".quote")];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let index = 0;

  // The view keeps the whole frame in sight above the masthead (shared/pages.js, which the homepage's zoom
  // also uses to land the print exactly here). The render leaves the paper blank; the quote is set on it.
  const room = mountRoom(roomEl, "quotes", PAGES.quotes.opts);
  const print = mountPrint(roomEl);

  room.on("layout", (g) => {
    const q = room.view.quads && room.view.quads.print;
    if (!q) return;
    const { P, w, h } = room.quad(q);
    print.place(P, w, h);
    placePager(g);
  });

  // The pill goes under the frame, or above it where the masthead needs the room below.
  function placePager(g) {
    const f = room.view.hotspots && room.view.hotspots.quote && room.view.hotspots.quote.length > 2 ? room.view.hotspots.quote : room.view.quads.print;
    placePagerAt(bbox(room.points(f)), g);
  }
  // (the live room places it the same way around the frame as its camera sees it)
  function placePagerAt([x0, y0, x1, y1], g) {
    const pw = pager.offsetWidth, ph = pager.offsetHeight;
    const mh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--mh")) || 96;
    const floor = g.boxH - mh - 10;
    let top = y1 + 14;
    if (top + ph > floor) top = y0 - 14 - ph >= 12 ? y0 - 14 - ph : Math.max(12, floor - ph);
    const cx = Math.min(g.boxW - pw / 2 - 12, Math.max(pw / 2 + 12, (x0 + x1) / 2));
    pager.style.transform = `translate(${Math.round(cx - pw / 2)}px, ${Math.round(top)}px)`;
    pager.classList.add("is-set");
  }

  const quoteOf = (i) => {
    const li = items[i];
    const by = li.querySelector(".by");
    return { n: i + 1, html: li.querySelector(".q").innerHTML, by: by ? by.innerHTML : "" };
  };

  function setQuote(i, { animate = true, updateHash = true } = {}) {
    index = (i + items.length) % items.length;
    const li = items[index];
    const q = quoteOf(index);
    print.set(q, { animate });
    for (const it of items) it.classList.toggle("is-on", it === li);
    // the address remembers the quote (keeping the history entry's own state, which the live room reads)
    if (updateHash) history.replaceState(history.state, "", `#${li.id}`);
  }

  $("prev-quote").addEventListener("click", () => setQuote(index - 1));
  $("next-quote").addEventListener("click", () => setQuote(index + 1));
  on(window, "keydown", (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest("input, textarea, select, [contenteditable]")) return;
    if (e.key === "ArrowLeft") { setQuote(index - 1); e.preventDefault(); }
    if (e.key === "ArrowRight") { setQuote(index + 1); e.preventDefault(); }
  });
  for (const [i, li] of items.entries()) {
    li.querySelector(".num").addEventListener("click", () => {
      setQuote(i);
      scrollTo({ top: 0, behavior: reduced.matches ? "auto" : "smooth" });
    });
  }

  // ---------- videos play in place ----------
  for (const a of root.querySelectorAll(".video[data-yt]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const f = document.createElement("iframe");
      f.src = `https://www.youtube-nocookie.com/embed/${a.dataset.yt}?autoplay=1&rel=0`;
      f.title = "YouTube video";
      f.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
      f.allowFullscreen = true;
      a.classList.add("is-playing");
      a.replaceChildren(f);
      a.removeAttribute("href");
    });
  }

  // the quote from the address (#quote-3), else the day's quote (the one on the desk's print, shared/print.js)
  const fromHash = items.findIndex((li) => `#${li.id}` === location.hash);
  setQuote(fromHash >= 0 ? fromHash : dayIndex(items.length), { animate: false, updateHash: false });
  room.ready.catch((e) => console.warn(e));

  return {
    room,
    print,
    // what follows the live camera: the paper is the print's own quad; the pill follows the print's foot
    anchors: () => [
      { el: print.el, mode: "quad", quad: "print", size: () => [parseFloat(print.el.style.width) || 0, parseFloat(print.el.style.height) || 0] },
      { el: pager, mode: "place", object: "print", place: (box, w, h) => placePagerAt(box, { boxW: w, boxH: h }) },
    ],
    unmount() {
      for (const off of offs) off();
      room.destroy();
    },
  };
}
