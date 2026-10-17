// The Books page's behaviour, as a module that mounts on its <main> and can be unmounted: the page itself runs it
// on a direct load (books/index.html), and the homepage runs it when the live room glides to the shelf and moves
// this page's <main> in under the room (shared/router.js). Same behaviour either way; only the arrival and the
// masthead are the standalone page's own.
//
//   const page = mount(mainEl, { standalone: true });   // -> { room, card, items, anchors(), onBook(fn), unmount() }
//   page.onBook(({ index, level }) => {})   // the live room's 3D book (shared/router.js -> interact.pullBook):
//                                           // level 1 a spine with keyboard focus, 2 the book the visitor picked
//                                           // (a click, Enter, the card's arrows), 0 none (focus left the shelf and
//                                           // its card); index is the spine's place on the shelf (0-53)
import { initMasthead } from "/shared/masthead.js";
import { mountRoom, bbox } from "/shared/room.js";
import { PAGES, cardColumn } from "/shared/pages.js";

export function mount(root, { standalone = false } = {}) {
  if (standalone) initMasthead();
  const offs = [];
  const on = (target, type, fn, opt) => { target.addEventListener(type, fn, opt); offs.push(() => target.removeEventListener(type, fn, opt)); };
  let dead = false;

  const $ = (id) => root.querySelector(`#${id}`);
  const roomEl = $("shelf-room");
  const shelf = $("shelf");
  const tip = $("tip");
  const held = $("held");
  const card = $("card");
  const label = $("label");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const stacked = matchMedia("(max-width: 760px), (max-aspect-ratio: 11/10)");
  const spines = [...shelf.querySelectorAll(".spine")];
  const info = (b) => ({ id: b.dataset.id, title: b.querySelector(".t").textContent, author: b.querySelector(".a").textContent });

  for (const b of spines) {
    b.insertAdjacentHTML("beforeend", '<span class="slot" aria-hidden="true"></span><span class="img" aria-hidden="true"></span><span class="hit" aria-hidden="true"></span>');
    b.tabIndex = -1;
  }

  // The view: every book on the shelf in sight, clear of the masthead and of the book card (shared/pages.js,
  // which the homepage's zoom also uses to land the shelf exactly here).
  let polys = null;
  const room = mountRoom(roomEl, "books", PAGES.books.opts);

  room.on("layout", (g) => {
    document.documentElement.style.setProperty("--card-col", `${Math.round(cardColumn({ w: g.boxW, h: g.boxH }))}px`);
    polys = polys || room.view.hotspots || {};
    const lift = Math.max(2, Math.round(g.h * 0.004));
    for (const b of spines) {
      const poly = polys[`book:${b.dataset.id}`];
      if (!poly || poly.length < 3) { b.classList.add("off-shelf"); continue; }
      const P = room.points(poly);
      const [x0, y0, x1, y1] = bbox(P);
      const pad = lift + 2;
      Object.assign(b.style, { left: `${x0}px`, top: `${y0 - pad}px`, width: `${x1 - x0}px`, height: `${y1 - y0 + pad}px` });
      b.style.setProperty("--clip", `polygon(${P.map(([x, y]) => `${(x - x0).toFixed(1)}px ${(y - y0 + pad).toFixed(1)}px`).join(", ")})`);
      // the lifted spine is the photograph itself (the whole frame, or the phone strip of it)
      b.style.setProperty("--bgs", `${g.iw}px ${g.h}px`);
      b.style.setProperty("--bgp", `${(g.ix - x0).toFixed(1)}px ${(g.top - y0 + pad).toFixed(1)}px`);
      b.style.setProperty("--lift", `${lift}px`);
      const n = bbox(poly);
      b._c = [(n[0] + n[2]) / 2, (n[1] + n[3]) / 2, n[3] - n[1]];
      b._box = [x0, y0, x1, y1];
    }
    roomEl.classList.add("is-ready");
    if (!tip.hidden && tip._for) placeTip(tip._for);
  });
  room.on("image", ({ src, frame }) => {
    shelf.style.setProperty("--hero", `url("${src}")`);
    const lq = frame && frame.lqip && frame.lqip.books;
    if (lq) $("reader").style.setProperty("--wall-blur", `url("${lq}")`);
  });

  // ---------- tooltip ----------
  function placeTip(b) {
    if (!b._box) return;
    const [x0, y0, x1] = b._box;
    tip.querySelector(".tt-t").textContent = info(b).title;
    tip.querySelector(".tt-a").textContent = info(b).author;
    tip.hidden = false;
    tip._for = b;
    const w = tip.offsetWidth, h = tip.offsetHeight, W = roomEl.clientWidth;
    const cx = Math.min(W - w / 2 - 8, Math.max(w / 2 + 8, (x0 + x1) / 2));
    const below = y0 - h - 14 < 0;
    tip.classList.toggle("below", below);
    tip.style.left = `${cx}px`;
    tip.style.top = `${below ? b._box[3] : y0}px`;
    // the live room moves the tip with the camera from this point: tell it the point moved (shared/router.js)
    tip.dispatchEvent(new Event("sfw:placed"));
  }
  function hideTip(b) { if (!b || tip._for === b) { tip.hidden = true; tip._for = null; } }
  // ---------- the live room's 3D book follows the keyboard and the card ----------
  const bookHooks = new Set();
  let picked = null;   // the book the visitor picked (not the one shown on arrival)
  const pull = (b, level) => { const index = b ? spines.indexOf(b) : -1; for (const fn of bookHooks) { try { fn({ index, level: b ? level : 0 }); } catch (e) { console.error(e); } } };
  const reader = $("reader");
  const inShelf = (n) => !!n && (shelf.contains(n) || reader.contains(n));
  on(root, "focusout", (e) => { if (inShelf(e.target) && !inShelf(e.relatedTarget)) pull(null, 0); });

  for (const b of spines) {
    b.addEventListener("focus", () => { if (b.matches(":focus-visible")) pull(b, b === picked ? 2 : 1); });
    // no words at the pointer (spec v2: the book itself answers, tipping out, router.js and gl/interact.js); keyboard
    // focus still shows the title and author above the spine
    b.addEventListener("focus", () => { if (b.matches(":focus-visible")) placeTip(b); });
    b.addEventListener("blur", () => hideTip(b));
    b.addEventListener("pointerenter", () => preload(b), { once: true });
    b.addEventListener("click", () => select(b, { reveal: true }));
  }

  // ---------- the book in your hands ----------
  let current = null;
  const covers = new Map();
  // resolves true once the cover is decoded and ready to show, false if it can't be had
  function preload(b) {
    const src = `/covers/${b.dataset.id}.jpg`;
    if (!covers.has(src)) {
      const im = new Image();
      im.src = src;
      covers.set(src, im.decode().then(() => true, () => false));
    }
    return covers.get(src);
  }

  // The spine stays out until the cover has arrived, then the book turns to show it.
  function turn(b) {
    preload(b).then((ok) => {
      if (dead || current !== b || !ok || card.classList.contains("is-open")) return;
      $("card-img").src = `/covers/${b.dataset.id}.jpg`;
      if (reduced.matches) { card.classList.add("no-anim", "is-open"); return; }
      card.classList.remove("no-anim");
      requestAnimationFrame(() => { if (current === b) card.classList.add("is-open"); });
    });
  }

  function select(b, { reveal = false, defer = false } = {}) {
    if (!b) return;
    const { id, title, author } = info(b);
    if (current) { current.classList.remove("is-current"); current.removeAttribute("aria-current"); current.tabIndex = -1; }
    current = b;
    b.classList.add("is-current");
    b.setAttribute("aria-current", "true");
    b.tabIndex = 0;

    card.style.setProperty("--card-bg", b.dataset.bg || "#444");
    card.style.setProperty("--card-fg", b.dataset.fg || "#f5f1e6");
    $("card-spine-t").textContent = title;
    $("card-spine-a").textContent = author;
    $("card-img").alt = `${title} by ${author}, cover`;

    const same = $("card-title").textContent === title;
    if (!same) label.classList.add("is-changing");
    $("card-title").textContent = title;
    $("card-author").textContent = author;
    $("card-status").hidden = !b.hasAttribute("data-reading");
    requestAnimationFrame(() => label.classList.remove("is-changing"));

    // take it off the shelf spine-first; it turns to its cover once the cover is here
    card.classList.add("no-anim");
    card.classList.remove("is-open");
    void card.offsetWidth;
    if (!defer) turn(b);
    if (reveal && stacked.matches) {
      const r = held.getBoundingClientRect();
      if (r.bottom > innerHeight || r.top < 0) held.scrollIntoView({ block: "nearest", behavior: reduced.matches ? "auto" : "smooth" });
    }
    // the address remembers the book (keeping the history entry's own state, which the live room reads)
    if (!defer) history.replaceState(history.state, "", `#${id}`);
    // the visitor picked it (a click, Enter, the card's arrows): the live room's book comes out
    if (!defer) { picked = b; pull(b, 2); }
  }

  const step = (d) => select(spines[(spines.indexOf(current) + d + spines.length) % spines.length]);
  $("prev-book").addEventListener("click", () => step(-1));
  $("next-book").addEventListener("click", () => step(1));

  // ---------- keyboard: arrows walk the shelves ----------
  function rows() {
    const onShelf = spines.filter((b) => b._c);
    const sorted = onShelf.slice().sort((a, b) => a._c[1] - b._c[1]);
    const out = [];
    for (const b of sorted) {
      const row = out.find((r) => Math.abs(r.y - b._c[1]) < b._c[2] * 0.5);
      if (row) row.items.push(b); else out.push({ y: b._c[1], items: [b] });
    }
    for (const r of out) r.items.sort((a, b) => a._c[0] - b._c[0]);
    return out;
  }
  shelf.addEventListener("keydown", (e) => {
    const b = e.target.closest(".spine");
    if (!b || !b._c) return;
    const R = rows();
    const flat = R.flatMap((r) => r.items);
    const ri = R.findIndex((r) => r.items.includes(b));
    let next = null;
    if (e.key === "ArrowRight") next = flat[Math.min(flat.length - 1, flat.indexOf(b) + 1)];
    else if (e.key === "ArrowLeft") next = flat[Math.max(0, flat.indexOf(b) - 1)];
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const r = R[ri + (e.key === "ArrowUp" ? -1 : 1)];
      if (r) next = r.items.reduce((p, q) => (Math.abs(q._c[0] - b._c[0]) < Math.abs(p._c[0] - b._c[0]) ? q : p));
    } else if (e.key === "Home") next = flat[0];
    else if (e.key === "End") next = flat[flat.length - 1];
    else return;
    e.preventDefault();
    if (next && next !== b) { b.tabIndex = -1; next.tabIndex = 0; next.focus(); placeTip(next); }
  });
  shelf.addEventListener("focusout", (e) => {
    if (!shelf.contains(e.relatedTarget) && current) { for (const s of spines) s.tabIndex = s === current ? 0 : -1; }
  });

  // first book: from the address (#06-flow), else the one standing face-out on the shelf.
  // It waits spine-out; on wide screens it turns once the room is up, and on phones (where it sits
  // below the shelf) once it comes near the screen, so its cover isn't fetched until it's wanted.
  const fromHash = spines.find((b) => `#${b.dataset.id}` === decodeURIComponent(location.hash));
  select(fromHash || spines[0], { defer: true });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let io = null;
  function whenNear(el, fn) {
    if (!stacked.matches || !("IntersectionObserver" in window)) { fn(); return; }
    io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { io.disconnect(); fn(); }
    }, { rootMargin: "160px 0px" });
    io.observe(el);
  }
  Promise.race([room.ready, wait(1500)]).catch(() => {}).then(() => { if (!dead) whenNear(held, () => { if (current) turn(current); }); });
  void on;

  return {
    room,
    card: stacked.matches ? null : $("reader"),
    items: spines,
    // what follows the live camera: the spines lie on the shelf's front plane
    onBook(fn) { bookHooks.add(fn); return () => bookHooks.delete(fn); },
    anchors: () => [{ el: shelf, plane: "shelf_front" }, { el: tip, plane: "shelf_front", mode: "point", at: () => [parseFloat(tip.style.left) || 0, parseFloat(tip.style.top) || 0] }],
    unmount() {
      dead = true;
      bookHooks.clear();
      io?.disconnect();
      for (const off of offs) off();
      room.destroy();
    },
  };
}
