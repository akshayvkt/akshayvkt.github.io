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
import { PAGES, cardColumn, shelfMock, SHELF_FIRST } from "/shared/pages.js";

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
  // is picked; then a: a compact panel (DYS-200: in one place, books/index.html: the left side, vertically centred;
  // phones a strip along the bottom; next and previous change only what is in it, and no caret points at the book: the
  // book shows itself on the shelf); b: the same details in a band under the shelf (the live camera makes room for it,
  // shared/router.js reserveFor); c: as a, and the book flies out of its place on the shelf into the panel, then turns
  // to its cover (hovering a spine shows its cover with the title). Hovering a spine shows its title in all three.
  const MOCK = shelfMock();
  let mockOpenNow = false;
  if (MOCK) {
    root.classList.add("shelfmock", `shelfmock-${MOCK}`);
    root.append(held);   // out of the card column: it sits over the room, in its one place (books/index.html)
    held.insertAdjacentHTML("beforeend", '<button type="button" class="mock-x" aria-label="Put the book back">&times;</button>');
    // (DYS-200, BK4's a11y review: out of #reader it keeps that region's name; closed it is inert as well as unseen)
    held.setAttribute("role", "region");
    held.setAttribute("aria-label", $("reader").getAttribute("aria-label") || "The book you picked");
    $("reader").removeAttribute("aria-label");
    held.dataset.open = "false";
    held.inert = true;
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
    markRows();   // (DYS-200)
  });
  room.on("image", ({ src, frame }) => {
    shelf.style.setProperty("--hero", `url("${src}")`);
    const lq = frame && frame.lqip && frame.lqip.books;
    if (lq) $("reader").style.setProperty("--wall-blur", `url("${lq}")`);
  });

  // ---------- tooltip ----------
  function placeTip(b) {
    if (!b._box) return;
    if (tipless(b)) { hideTip(b); return; }
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
  // (DYS-200, H: one rule for the tip, whatever picked the book. The book open in the card has none under the pointer:
  // the card names it in its one place, and the tip would only cover the shelf above it. Keyboard focus shows its book's
  // tip, the open one's too: there it is the focus's only mark (that book is out and lit as open already). The pointer
  // on any other book shows that book's; off the books, the tip goes back to the spine with keyboard focus, if one has)
  const tipless = (b) => !!MOCK && mockOpenNow && b === current && !b.matches(":focus-visible");
  function focusTip() { const f = document.activeElement; if (spines.includes(f) && f.matches(":focus-visible")) placeTip(f); }
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
    b.addEventListener("focus", () => { if (b.matches(":focus-visible")) toRow(b); });   // (DYS-200: the room shows its row)
    // no words at the pointer (spec v2: the book itself answers, tipping out, router.js and gl/interact.js); keyboard
    // focus still shows the title and author above the spine
    b.addEventListener("focus", () => { if (b.matches(":focus-visible")) placeTip(b); });
    b.addEventListener("blur", () => hideTip(b));
    b.addEventListener("pointerenter", () => preload(b), { once: true });
    // (DYS-200: in the live room a click or tap picks the 3D book under it instead, livePick below; Enter (detail 0) is the page's)
    b.addEventListener("click", (e) => {
      if (!(live3d && e.detail > 0)) { select(b, { reveal: true }); return; }
      clearTimeout(pickLate);   // (no 3D book under the pointer after all, a hair off the book's edge: this spine's, after a moment)
      pickLate = setTimeout(() => { if (!dead) select(b, { reveal: true }); }, PICK_WAIT);
    });
    // DYS-29 mock: the pointer on a spine shows its title (and in c its cover) above it, as keyboard focus does
    // (DYS-200: in the live room, over the 3D book the pointer is on, liveHover below)
    if (MOCK) {
      b.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse" && !live3d) placeTip(b); });
      b.addEventListener("pointerleave", () => { if (!live3d) { hideTip(b); focusTip(); } });
    }
  }

  // ---------- DYS-200: in the live room, the 3D book under the pointer is the one ----------
  // The live room finds the book under the pointer in the 3D scene itself (gl/interact.js, the GPU pick: it can't drift
  // off the book) and tells the page (shared/router.js): that book's title shows (DYS-29 mock) and a click or tap opens
  // that book. The spines here are laid out on the photograph and still take the pointer and the keyboard, but up close
  // or mid-glide they can sit off the 3D books (a book set back from the shelf's front, a leaning one), so in the live
  // room a pointer answers to the pick; on the photograph alone (no 3D, reduced motion) the spines answer as before.
  let live3d = false, pickLate = 0, hoverAt = -1;   // (hoverAt: the 3D book under the pointer, for the card's closing)
  const PICK_WAIT = 350;   // ms: the 3D pick answers in 2-4 frames (gl/interact.js onUp, then the slide's first frame)
  function liveHover(index) {
    const b = index >= 0 ? spines[index] : null;
    hoverAt = index;
    if (MOCK && b && b._box && !tipless(b)) placeTip(b);
    else { if (tip._for && !tip._for.matches(":focus-visible")) hideTip(tip._for); focusTip(); }
  }
  function livePick(index) {
    clearTimeout(pickLate);
    const b = spines[index];
    if (b && !(b === current && picked === b && (!MOCK || mockOpenNow))) select(b, { reveal: true });
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

  // (DYS-229, Akshay 2 Nov: style (a)) each book's one line, a quiet line under the author: /data/book-lines.json (made
  // from his LINES.md by scripts/books/book_lines.mjs), fetched once; a book without one, or before it is in, shows none
  let lines = {};
  function showLine(id) {
    const el = $("card-line"), text = lines[id] || "";
    el.textContent = text;
    el.hidden = !text;
  }
  fetch("/data/book-lines.json").then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (dead || !d || typeof d.lines !== "object") return;
    lines = d.lines;
    if (current) { showLine(current.dataset.id); if (MOCK) fitTitle(); }
  }).catch(() => {});

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
    const words = same || (MOCK && !mockOpenNow) ? [] : [$("card-status"), $("card-title"), $("card-author"), $("card-line")];
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
    showLine(id);
    requestAnimationFrame(() => label.classList.remove("is-changing"));

    // take it off the shelf spine-first; it turns to its cover once the cover is here
    card.classList.add("no-anim");
    card.classList.remove("is-open");
    void card.offsetWidth;
    fitSpine();
    if (MOCK) fitTitle();   // (DYS-200: the panel keeps its size)
    if (MOCK && !defer) mockOpen(b);   // DYS-29: the panel comes up beside the shelf
    if (words.length) {
      // (the label's place may move with its height; old words that would now lie over the arrows fade at once)
      const dy = wasTop - label.offsetTop, stop = browse.offsetTop - label.offsetTop - 4;
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
    // the visitor picked it (a click, Enter, the card's arrows): the live room's book comes out, and the room shows its
    // row (DYS-200)
    if (!defer) { picked = b; pull(b, 2); toRow(b); }
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
  function mockOpen() {
    mockOpenNow = true;
    root.classList.add("mock-open");
    held.dataset.open = "true";
    held.inert = false;
    if (tip._for && tipless(tip._for)) hideTip(tip._for);   // (DYS-200, H: the card names it now, tipless above)
  }
  // (DYS-200, BK4: focus in the closing card, or nowhere, goes back to the book's spine, never to <body>, or to the
  // spine given as to)
  function mockClose({ to = current } = {}) {
    if (!mockOpenNow) return;
    const a = document.activeElement, back = to && (!a || a === document.body || held.contains(a));
    mockOpenNow = false;
    root.classList.remove("mock-open");
    held.dataset.open = "false";
    picked = null;
    pull(null, 0);   // the 3D book slides home
    if (back) to.focus({ preventScroll: true });
    held.inert = true;
    // (DYS-200, H: back on the shelf, the book's tip is as any other's: under the pointer or with keyboard focus)
    if (live3d && hoverAt >= 0) liveHover(hoverAt); else focusTip();
  }
  // (DYS-200: the panel has one place, books/index.html .shelfmock .held, so nothing places it any more; a title too long
  // for it is drawn smaller, never making it taller: its arrows stay where they are from one book to the next)
  const browse = held.querySelector(".browse");
  function fitTitle() {
    const t = $("card-title");
    t.style.removeProperty("--title-k");
    for (const k of [0.88, 0.77, 0.68]) {
      if (browse.offsetTop + browse.offsetHeight <= browse.parentElement.clientHeight + 0.5) return;   // (in .label-col)
      t.style.setProperty("--title-k", String(k));
    }
  }
  // (DYS-200, CF1: fitted again when the panel's size changes, a phone turned on its side (the strip becomes the panel) or
  // a narrower strip, and once the title's own font is in (a page opened on a #book fits it in the fallback face): a fit
  // for the other shape or face pushed the arrows down, off their place, until the next book)
  if (MOCK) {
    if (typeof ResizeObserver === "function") { const ro = new ResizeObserver(() => { if (!dead) fitTitle(); }); ro.observe(browse.parentElement); offs.push(() => ro.disconnect()); }
    document.fonts?.ready.then(() => { if (!dead) fitTitle(); });
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
  const FACE_OUT = SHELF_FIRST;
  // (a stray '%' in the address names no book, not a page that never starts; B's COORD-REVIEW, LOW)
  const hashId = (() => { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ""; } })();
  const fromHash = hashId ? spines.find((b) => b.dataset.id === hashId) : null;
  select(fromHash || spines.find((b) => b.dataset.id === FACE_OUT) || spines[0], { defer: true });

  // ---------- DYS-200: one row of the shelf at a time ----------
  // The live room shows one row of books (shared/router.js rowShelfFrame) and glides up or down to another; the page
  // says which by one of its books: the book picked, a spine keyboard focus moved to, or a swipe's next row. It opens on
  // the row of the book above (the address's, else the face-out one, at eye height). A book in the address is picked
  // as the page opens (a deep link, a refresh: the address remembers the book, select()); without one nothing is picked
  // until a click, a tap or a key. On the photograph alone (no 3D, reduced motion) the whole shelf stays in view.
  // A row hook (the live room's) answers { cut, done }: cut, the move is a cut (reduced motion, or no camera to move);
  // done, when there is one, resolves once the camera has landed (a glide's, or a move still to come: the room's framing
  // ease after its handover, a glide's landing). The page marks the row in view (#shelf-room[data-row], each spine's
  // data-row) and says when a change starts and lands (document events "sfw:books-row" { from, to, cut }, "sfw:books-row-landed" { row, ms }).
  const rowHooks = new Set();
  let rowSpine = current;   // a book of the row shown
  let gliding = false, lastRowMs = null, rowSeq = 0;
  const rowIndex = (b) => (b && b._c ? rows().findIndex((r) => r.items.includes(b)) : -1);
  function markRows() {
    rows().forEach((r, i) => { for (const b of r.items) b.dataset.row = String(i); });
    const i = rowIndex(rowSpine);
    if (i >= 0) roomEl.dataset.row = String(i);
  }
  function toRow(b) {
    if (!b || !b._c || b === rowSpine) return;
    const from = rowIndex(rowSpine), to = rowIndex(b);
    if (from === to && from >= 0) return;
    rowSpine = b;
    roomEl.dataset.row = String(to);
    const index = spines.indexOf(b), t0 = performance.now(), seq = ++rowSeq, waits = [];
    let cut = true;
    for (const fn of rowHooks) {
      try { const r = fn(index); if (r && r.cut === false) cut = false; if (r?.done) waits.push(r.done); } catch (e) { console.error(e); }
    }
    gliding = !cut || waits.length > 0;   // (CF2: a cut still to come, the room not ready yet, is under way until it lands)
    document.dispatchEvent(new CustomEvent("sfw:books-row", { detail: { from, to, cut } }));
    Promise.all(waits).catch(() => {}).then(() => {
      if (dead || seq !== rowSeq) return;
      gliding = false;
      lastRowMs = Math.round(performance.now() - t0);
      document.dispatchEvent(new CustomEvent("sfw:books-row-landed", { detail: { row: to, ms: lastRowMs } }));
    });
  }
  if (MOCK && fromHash) { mockOpen(); picked = fromHash; }

  // (DYS-200, BK4's hook contract: the shelf's state for the tests, behind the live room's own debug gate: ?debug, or the
  // visit's ?3d= switch, or the router's __sfwNav already out)
  const debug = (() => { try { return !!window.__sfwNav || new URLSearchParams(location.search).has("debug") || !!sessionStorage.getItem("sfw-3d"); } catch { return !!window.__sfwNav; } })();
  const books = {
    state: () => {
      const r = held.getBoundingClientRect();
      return { layout: MOCK ? "fixed" : "column", row: rowIndex(rowSpine), rows: rows().length, index: spines.indexOf(current), id: current?.dataset.id || null,
        open: mockOpenNow, gliding, lastRowMs, card: { x: r.x, y: r.y, w: r.width, h: r.height } };
    },
  };
  if (debug) window.__sfwBooks = books;

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
    // DYS-200: the live room's 3D pick (shared/router.js): live(on) while its 3D is what shows (off: the photograph is
    // back, a lost context); hoverBook(index | -1), the 3D book under the pointer; pickBook(index), the one a click or tap
    // picked
    live(on) { live3d = !!on; if (!on && tip._for && !tip._for.matches(":focus-visible")) hideTip(tip._for); },
    hoverBook(index) { if (live3d) liveHover(index); },
    pickBook(index) { if (live3d) livePick(index); },
    // (DYS-29 mock: no card column over the shelf)
    card: MOCK || stacked.matches ? null : $("reader"),
    items: spines,
    // (the book picked before the room took this page over, a deep link's: out at once)
    onBook(fn) { bookHooks.add(fn); if (MOCK && mockOpenNow && picked) fn({ index: spines.indexOf(picked), level: 2 }); return () => bookHooks.delete(fn); },
    // DYS-200: the row the room shows (an index of one of its books), each time it changes; rowBook() where it is now;
    // swipeRow(-1 | 1), a vertical swipe over the shelf (shared/router.js shelfSwipe): the row above or below; an open
    // card stays open on that row's middle book, picked as the arrows pick across a row's end (Akshay: the card stays in
    // one place across rows; closing it moved it, its closed box sits lower)
    onRow(fn) { rowHooks.add(fn); return () => rowHooks.delete(fn); },
    rowBook: () => spines.indexOf(rowSpine),
    swipeRow(d) {
      const R = rows(), i = R.findIndex((r) => r.items.includes(rowSpine)), next = R[i + d];
      if (i < 0 || !next) return;
      const to = next.items[Math.floor(next.items.length / 2)];
      if (MOCK && mockOpenNow) select(to); else toRow(to);
    },
    // what follows the live camera: the spines lie on the shelf's front plane
    anchors: () => [{ el: shelf, plane: "shelf_front" }, { el: tip, plane: "shelf_front", mode: "point", at: () => [parseFloat(tip.style.left) || 0, parseFloat(tip.style.top) || 0] }],
    unmount() {
      dead = true;

      bookHooks.clear();
      rowHooks.clear();
      if (window.__sfwBooks === books) delete window.__sfwBooks;
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
