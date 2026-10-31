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
import { PAGES, cardColumn, shelfMock, heroBox, mastheadHeight } from "/shared/pages.js";

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

  // DYS-29 mock (?shelfmock=a|b|c, shared/pages.js shelfMock): prototypes for Akshay to pick from; null without the
  // switch, and then nothing marked "DYS-29 mock" below runs. The shelf fills the view and no card shows until a book
  // is picked; then a: a compact panel beside the shelf at the book's height (phones: above or below the book);
  // b: the same details in a band under the shelf (the live camera makes room for it, shared/router.js reserveFor);
  // c: as a, and the book flies out of its place on the shelf into the panel, then turns to its cover (hovering a
  // spine shows its cover with the title). Hovering a spine shows its title in all three.
  const MOCK = shelfMock();
  let mockOpenNow = false;
  let mockFurn = null;   // the shelf's own box on screen [x0, y0, x1, y1], from the live room (anchors() below)
  if (MOCK) {
    root.classList.add("shelfmock", `shelfmock-${MOCK}`);
    root.append(held);   // out of the card column: it sits over the room, placed by mockPlace()
    held.insertAdjacentHTML("afterbegin", '<span class="mock-caret" aria-hidden="true"></span>');
    held.insertAdjacentHTML("beforeend", '<button type="button" class="mock-x" aria-label="Put the book back">&times;</button>');
    held.querySelector(".mock-x").addEventListener("click", () => mockClose());
    // Escape puts the book back first (a second Escape is the room's: back to the desk)
    on(document, "keydown", (e) => { if (mockOpenNow && e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); mockClose(); } });
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
    if (MOCK) mockPlace();   // DYS-29 mock
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
  // (DYS-29 mock: the panel lives outside the reader; while it is open the book stays out until it is put back)
  const inShelf = (n) => !!n && (shelf.contains(n) || reader.contains(n) || (!!MOCK && held.contains(n)));
  on(root, "focusout", (e) => { if (MOCK && mockOpenNow) return; if (inShelf(e.target) && !inShelf(e.relatedTarget)) pull(null, 0); });

  for (const b of spines) {
    b.addEventListener("focus", () => { if (b.matches(":focus-visible")) pull(b, b === picked ? 2 : 1); });
    // no words at the pointer (spec v2: the book itself answers, tipping out, router.js and gl/interact.js); keyboard
    // focus still shows the title and author above the spine
    b.addEventListener("focus", () => { if (b.matches(":focus-visible")) placeTip(b); });
    b.addEventListener("blur", () => hideTip(b));
    b.addEventListener("pointerenter", () => preload(b), { once: true });
    b.addEventListener("click", () => select(b, { reveal: true }));
    // DYS-29 mock: the pointer on a spine shows its title (and in c its cover) above it, as keyboard focus does
    if (MOCK) {
      b.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") placeTip(b); });
      b.addEventListener("pointerleave", () => hideTip(b));
    }
  }

  // ---------- the book in your hands ----------
  let current = null;
  const covers = new Map();
  const coverImgs = [];   // (DYS-151 memory: the preloads, let go of at unmount)
  // resolves true once the cover is decoded and ready to show, false if it can't be had
  function preload(b) {
    const src = `/covers/${b.dataset.id}.jpg`;
    if (!covers.has(src)) {
      const im = new Image();
      im.src = src;
      coverImgs.push(im);
      covers.set(src, im.decode().then(() => true, () => false));
    }
    return covers.get(src);
  }

  // (DYS-151 book cards, Akshay's 31 Oct recording: the spine's words ran off the phone's 76 x 114 card, an empty block)
  // The words run along the face's long side, wrapping there (index.html .spine-text); a block still too long or too
  // thick for the face is drawn smaller to fit. Read after the card's own forced layout (select): no extra layout.
  const spineText = card.querySelector(".spine-text");
  const SPINE_PAD = [8, 12];   // px kept clear at the face's ends (as .spine-text's max-width) and at its sides
  function fitSpine() {
    const face = spineText.parentElement;
    if (!face.clientWidth) return;
    const len = Math.max(spineText.offsetWidth, ...[...spineText.children].map((c) => c.offsetWidth));
    const k = Math.min(1, (face.clientHeight - 2 * SPINE_PAD[0]) / len, (face.clientWidth - 2 * SPINE_PAD[1]) / spineText.offsetHeight);
    spineText.style.setProperty("--spine-k", k < 1 ? k.toFixed(3) : "");
  }
  on(stacked, "change", fitSpine);   // (the phone's card is smaller)
  document.fonts?.ready.then(() => { if (!dead) fitSpine(); });

  // (DYS-151 book cards) the label in a step: the old book's words stay where they were, over the new ones, and fade as
  // those come in (index.html .label-ghost), so it is never empty
  const ghost = document.createElement("div");
  ghost.className = "label-ghost";
  ghost.setAttribute("aria-hidden", "true");
  label.append(ghost);

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
    const same = $("card-title").textContent === title;
    // the label's words as they stand, into the ghost (not as the DYS-29 panel comes up: none were showing)
    const words = same || (MOCK && !mockOpenNow) ? [] : [$("card-status"), $("card-title"), $("card-author")];
    const wasTop = words.length ? label.offsetTop : 0;
    ghost.replaceChildren(...words.map((el) => { const c = el.cloneNode(true); c.removeAttribute("id"); return c; }));
    if (words.length) label.style.setProperty("--ghost-o", getComputedStyle(words[1]).opacity);
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

    if (!same) label.classList.add("is-changing");
    $("card-title").textContent = title;
    $("card-author").textContent = author;
    $("card-status").hidden = !b.hasAttribute("data-reading");
    requestAnimationFrame(() => label.classList.remove("is-changing"));

    // take it off the shelf spine-first; it turns to its cover once the cover is here
    card.classList.add("no-anim");
    card.classList.remove("is-open");
    void card.offsetWidth;
    fitSpine();
    if (MOCK && !defer) mockOpen(b);   // DYS-29: the panel comes up beside the shelf
    if (words.length) {
      // (the label's place may move with its height; old words that would now lie over the arrows fade at once)
      const dy = wasTop - label.offsetTop, stop = label.querySelector(".browse").offsetTop - 4;
      const over = [...ghost.children].filter((c) => dy + c.offsetTop + c.offsetHeight > stop);
      ghost.style.top = `${dy}px`;
      for (const c of over) c.classList.add("is-over");
    }
    if (!defer) turn(b);
    // (DYS-151 book cards: an arrow step turned only once its cover had come over the network, an empty block meanwhile)
    // once this cover is in, the next and the previous book's in the arrows' order are fetched and decoded too
    if (!defer) preload(b).then(() => { if (!dead && current === b) for (const d of [1, -1]) preload(along(b, d)); });
    if (reveal && stacked.matches && !MOCK) {
      const r = held.getBoundingClientRect();
      if (r.bottom > innerHeight || r.top < 0) held.scrollIntoView({ block: "nearest", behavior: reduced.matches ? "auto" : "smooth" });
    }
    // the address remembers the book (keeping the history entry's own state, which the live room reads)
    if (!defer) history.replaceState(history.state, "", `#${id}`);
    // the visitor picked it (a click, Enter, the card's arrows): the live room's book comes out
    if (!defer) { picked = b; pull(b, 2); }
  }

  // (DYS-29 mock: the arrows step along the shelf as it stands, left to right and row by row, mockStep)
  const along = (b, d) => (MOCK ? mockStep(d, b) : spines[(spines.indexOf(b) + d + spines.length) % spines.length]);
  const step = (d) => select(along(current, d));
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

  // ---------- DYS-29 mock (?shelfmock): the panel for the picked book, over the room ----------
  function mockOpen(b) {
    mockOpenNow = true;
    root.classList.add("mock-open");
    mockPlace();
  }
  function mockClose() {
    if (!mockOpenNow) return;
    mockOpenNow = false;
    root.classList.remove("mock-open");
    picked = null;
    pull(null, 0);   // the 3D book slides home
  }
  // Where the panel goes, from what is on screen now (the spines follow the live camera, so the live room calls this
  // on every camera move: anchors() below). a, c: beside the shelf at the picked book's height, its caret toward the
  // book; with no room beside the shelf (phones), above or below the book, over the shelf. b: a band above the masthead.
  function mockPlace() {
    const o = root.getBoundingClientRect();
    // the shelf's left and right edges: the furniture's in the live room; without it, the books' (the photograph's spines)
    let S = mockFurn && { l: mockFurn[0], r: mockFurn[2] };
    if (!S) {
      const rs = spines.filter((s) => s._box).map((s) => s.getBoundingClientRect());
      if (!rs.length) return;
      S = { l: Math.min(...rs.map((r) => r.left)) - o.left, r: Math.max(...rs.map((r) => r.right)) - o.left };
    }
    const sl = `${Math.round(S.l)}px`;   // the caption stays left of the shelf (CSS); set only when it moves
    if (root.style.getPropertyValue("--mock-shelf-l") !== sl) root.style.setProperty("--mock-shelf-l", sl);
    if (!mockOpenNow || !current) return;
    const W = root.clientWidth, H = heroBox().h, mh = mastheadHeight(), m = 12, gap = 26;
    const F = { l: m, t: m, r: W - m, b: H - mh - m };
    const within = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    const caret = held.querySelector(".mock-caret");
    let x, y, w, h, side = null;
    {
      const k = current.getBoundingClientRect();
      const B = { l: k.left - o.left, r: k.right - o.left, t: k.top - o.top, b: k.bottom - o.top };
      const cx = (B.l + B.r) / 2, cy = (B.t + B.b) / 2;
      // beside the shelf when 280 px or more are free there (the panel takes up to 360, in 20 px steps so the
      // camera's sway does not re-wrap its words); else over the shelf at the CSS width
      const roomR = F.r - (S.r + gap), roomL = S.l - gap - F.l;
      const fit = (room) => `${Math.min(360, Math.floor(room / 20) * 20)}px`;
      if (roomR >= 280) { held.style.width = fit(roomR); side = "left"; }          // (side: the panel's edge the caret is on)
      else if (roomL >= 280) { held.style.width = fit(roomL); side = "right"; }
      else held.style.width = "";
      w = held.offsetWidth; h = held.offsetHeight;
      if (side === "left") x = S.r + gap;
      else if (side === "right") x = S.l - gap - w;
      if (side) y = within(cy - h / 2, F.t, F.b - h);
      else {
        x = within(cx - w / 2, F.l, F.r - w);
        const up = B.t - F.t >= F.b - B.b;
        y = up ? Math.max(F.t, B.t - 14 - h) : Math.min(F.b - h, B.b + 14);
        side = up ? "bottom" : "top";
      }
      caret.dataset.side = side;
      const across = side === "left" || side === "right";
      caret.style.top = across ? `${within(cy - y, 16, h - 16)}px` : "";
      caret.style.left = across ? "" : `${within(cx - x, 16, w - 16)}px`;
    }
    held.style.left = `${Math.round(x)}px`;
    held.style.top = `${Math.round(y)}px`;
  }
  // the arrows: the next book along the shelf as it stands (left to right, then the row below), round at the ends
  function mockStep(d, from = current) {
    const flat = rows().flatMap((r) => r.items);
    const i = flat.indexOf(from);
    if (i < 0) return spines[(spines.indexOf(from) + d + spines.length) % spines.length];
    return flat[(i + d + flat.length) % flat.length];
  }

  // first book: from the address (#06-flow), else the one standing face-out on the shelf (The Bhagavad Gita
  // since v3/book-gita; the list keeps Akshay's order, so it is found by id, falling back to the first).
  // It waits spine-out; on wide screens it turns once the room is up, and on phones (where it sits
  // below the shelf) once it comes near the screen, so its cover isn't fetched until it's wanted.
  const FACE_OUT = "30-bhagavad-gita";
  const fromHash = spines.find((b) => `#${b.dataset.id}` === decodeURIComponent(location.hash));
  select(fromHash || spines.find((b) => b.dataset.id === FACE_OUT) || spines[0], { defer: true });

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
    // (DYS-29 mock: no card column over the shelf)
    card: MOCK || stacked.matches ? null : $("reader"),
    items: spines,
    // what follows the live camera: the spines lie on the shelf's front plane
    onBook(fn) { bookHooks.add(fn); return () => bookHooks.delete(fn); },
    anchors: () => [{ el: shelf, plane: "shelf_front" }, { el: tip, plane: "shelf_front", mode: "point", at: () => [parseFloat(tip.style.left) || 0, parseFloat(tip.style.top) || 0] },
      // DYS-29 mock: the panel is re-placed at every camera move, by the shelf's box on screen (canvas px: the canvas
      // and this page's first screen share their top left corner)
      ...(MOCK ? [{ el: held, mode: "place", object: "shelf", place: (box) => { mockFurn = box; mockPlace(); } }] : [])],
    unmount() {
      dead = true;

      bookHooks.clear();
      io?.disconnect();
      for (const off of offs) off();
      room.destroy();
      // (DYS-151 memory: the card's cover and the preloaded ones let go of their decoded pictures now, not at the next
      // full garbage collection, which with the JIT (any https page) can be many visits away; DM: they stayed alive)
      for (const im of [$("card-img"), ...coverImgs]) im?.removeAttribute("src");
      coverImgs.length = 0;
    },
  };
}
