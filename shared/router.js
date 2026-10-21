// The persistent room: real addresses and history for the six spots, and the 3D camera that moves between them.
//
//   const { startRouter } = await import("/shared/router.js");   // after first paint, never blocking it
//   startRouter({ doc: "home", hero, stage, hotspots, tip, print: () => print, photo: () => ({ view, size, geo }) });
//   startRouter({ doc: "books", hero, page });                    // a page document (its page module's handle)
//
// Three ways of showing the room, chosen per visit:
//   live   the 3D room (E1's engine, or the debug stand-in with ?3d=standin): free orbit, glides between spots.
//          The homepage document stays loaded: Books and Quotes are fetched and their <main> moved in under the
//          room (shared/pages pages modules), so the room, its sound and its city keep running. A page opened
//          directly boots the 3D at its own spot; "Back to the desk" glides there and then loads the homepage.
//          The laptop is a computer you use (Akshay, 2026-10-15): the Projects page is on its screen at every
//          distance (shared/laptop.js, projects/screen.js), and the laptop spot leans in until the screen fills
//          most of the view; there the page scrolls, hovers and opens projects on the screen itself, and leaning
//          back leaves it as it was. The address follows (/projects/, a project's /projects/#/project/<slug>).
//   photo  no 3D yet, or none for this visitor (no WebGL2, Save-Data, a weak device): today's photographs and
//          dissolves (shared/transition.js), plus the window spot and the About card below.
//   still  reduced motion: the photographs with cuts (150 ms fades), and the 3D is never downloaded.
// Never waiting: a click that finds the 3D not ready within 120 ms plays today's dissolve instead.
//
// Zoom (Akshay, 2026-10-15, like felixrieseberg.com): in the live room the scroll wheel, a trackpad pinch
// (ctrl+wheel), a two-finger pinch and the + and - keys move the camera closer or further (shared/rig.js zoomBy,
// within each spot's orbit.zoom; shared/gestures.js). So the homepage's words move into a card over the room
// (placeAbout) and the homepage no longer scrolls; Books and Quotes keep their reading below the room, reached by
// scrolling on once the zoom is all the way out. Photo and still modes keep today's page, wheel and pinch.
//
// The card only when asked (Akshay, 2026-10-15 16:30: "why is this text thing in the screen at all times?"): the room
// is clean by default. The words show at the bio's spot (BIO_SPOT: the notebook, "About me", /#about), and the
// masthead's name is a button (aria-expanded, aria-controls="about") that opens and closes them as the card at the
// desk; Escape or a click outside closes it. In photo and still modes the words also stay below the window, and
// without JS the name is plain text and the words are only there.
//
// The room's manners (spec v2, 15 Oct, interactions A): no words at the pointer, the objects answer it with light
// (gl/sheen.js: a lift of the object's exposure and highlights over 150 ms, and the pointer cursor); at a leaned-in
// spot the masthead eases down to 30 % and comes back when the pointer nears it; the name's card grows from the name
// and shrinks back into it; the lamp switches itself on at dusk until the visitor switches it; a first visit gets one
// glint of light across the desk (GLINT).
//
// The window spot has no address: entering it pushes a history entry on the same URL, so Back, Escape and
// "Back to the desk" all return. /#about leans to the notebook once the 3D is ready and the page has been idle
// 0.8 s (reduced motion: the card only). Every URL still serves its full page on a direct load and without JS.
import { loadSpots, spotForURL } from "./spots.js";
import { Rig, toEngineCamera, clonePose, project } from "./rig.js";
import { frameSpot, cropPose, mustSeeReport, underReserve } from "./framing.js";
import { Overlays } from "./overlays.js";
import { LinkLayer, ACTIONS } from "./links.js";
import { Picker } from "./picking.js";
import { Gestures, bootTier, EdgeTabs } from "./gestures.js";
import { LaptopScreen, leanPose } from "./laptop.js";
import { sunPosition, loadScene } from "./sky.js";
import { fitPose } from "./surface.js";
import { normalize, add, mul, dirOf } from "./rig.js";
import { fitEdges } from "./edgefit.js";
import { soundRoom, pageTurn, soundState } from "./sound.js";

// Interactions B (spec v2, 16 Oct): the new desk's notebook, phone, headphones and breadboard.
//   - The notebook is his writing: a click (or Enter) leans in, the elastic slips aside and the cover swings open
//     (shared/notebook.js); the first page is the index of his essays, newest first (HTML on the page's quad, the
//     laptop's way); a title lifts the essay out into the reading sheet (shared/reader.js), whose address is
//     /writing/<slug>; leaving the notebook closes the cover. /writing/<slug> opened fresh is a static page (for search
//     engines and no JS, scripts/content/writing_pages.py) that sends a live-capable browser here as /?writing=<slug>:
//     the sheet rises at once, the room leans in to the notebook behind it, and closing returns the sheet into the page.
//     The bio lives on the name: /#about is the desk with the name's card, and the notebook's old About card is gone.
//   - The phone: a click leans in square on to its screen and wakes it, the lock screen with his links (shared/phone.js);
//     leaving dims it off.
//   - The headphones: the laptop plays the official video (shared/toys.js Egg); phones open it in a tab.
//   - The breadboard: its LED blinks three times, and with Sound on the buzzer chirps. No navigation.
const WRITING_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const NB_PITCH = 62;              // degrees: the notebook spot looks down at the open notebook (readable, little foreshortening)
const NEEDS_ROOM = new Set(["notebook", "phone"]);   // spots that only exist in the live room: a click while it boots waits
const ROOM_OFF_KEY = "sfw-room-off";                 // sessionStorage: the live room did not start in this visit

const reducedQ = matchMedia("(prefers-reduced-motion: reduce)");
const coarseQ = matchMedia("(pointer: coarse)");
const params = new URLSearchParams(location.search);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const idle = (fn, timeout = 1500) => (window.requestIdleCallback || ((f) => setTimeout(f, 200)))(fn, { timeout });
const norm = (p) => p.replace(/\/index\.html$/, "/").replace(/\/+$/, "") || "/";

const NEVER_WAIT = 120;           // ms: a click waits this long for the 3D, then dissolves instead
const CUT = 150;                  // ms: reduced motion's fade
const HANDOVER_MS = 500;          // ms: the photograph -> 3D crossfade at boot (handover-r1), eased
const HANDOVER_WAIT = 1200;       // ms: at most this long after the room has refined for the window's tiles
const HANDOVER_MAX = 8000;        // ms: at most this long after the 3D is live for its picture to refine
const WINDOW_FADE_MS = 2000;      // ms: after the handover, the photograph's window dissolves into the live view
const WINDOW_WAIT = 4000;         // ms: the framing ease waits at most this long for that
const ABOUT_IDLE = 800;           // ms of quiet before /#about leans to the notebook
// the pages the homepage can host (their page modules), and the scene.json view each one's photograph is
const PAGE_MODULE = { shelf: "/books/page.js", print: "/quotes/page.js" };
const PAGE_VIEW = { shelf: "books", print: "quotes", laptop: "projects" };
const FLICK_ORDER = ["shelf", "desk", "print"];
const ZOOM_KEY = 0.15;            // m per press of + or -
// v3/zoom: the window's magnifier (shared/zoom.js, loaded the first time someone magnifies): its cap on desktops;
// ?zoom=0 turns it off (the dolly alone, as before), ?zoomcap=N pins the cap (QA)
const MAG_DESKTOP = 4;
const MAG_PIN = params.get("zoom") === "0" ? 1 : +params.get("zoomcap") || 0;
// the spot whose framing showed the homepage's words beside it (the About card): none since interactions B (the bio
// lives on the name; the notebook is his writing)
const BIO_SPOT = null;
const LEAN_S = 1.4;               // s: the glide into and out of the laptop (a person leaning in)
const SCREEN_KEY = "sfw-laptop";  // sessionStorage: what the laptop's screen shows, kept across the site's documents
// what lights up when the pointer (or keyboard focus) is on a spot's object, or on the lamp (gl/sheen.js names)
// (the window: its opening, the view; R1's "window" object is the whole window wall, down to the floor)
const LIGHT = { shelf: ["shelf", "books"], laptop: ["laptop", "screen"], print: ["print"], notebook: ["notebook"], window: ["opening"], lamp: ["lamp"],
  phone: ["phone"], headphones: ["headphones"], breadboard: ["breadboard"] };
const LIGHT_K = { window: 0.45 };   // (the whole view is a large part of the screen: its lift is gentler, about +7 %)
// the first visit's glint crosses these, in their order on screen
const GLINT = ["laptop", "notebook", "phone", "print"];
const GLINT_KEY = "sfw-glint";    // localStorage: the glint was seen
const GLINT_AFTER = 2000;         // ms the live room is at rest at the desk before it
// the lamp at dusk: below this sun altitude (degrees) it is on, as a person would switch it on; a click wins for the visit
const LAMP_ALT = 2;
const LAMP_KEY = "sfw-lamp";      // sessionStorage: the visitor's own switch (0 or 1)
const LAMP_FADE = 200;            // ms: a click's soft fade (gl/interact.js)
// the leaned-in spots, where the masthead goes quiet (not the desk, nor the window, where its dial is the point)
const QUIET = new Set(["shelf", "laptop", "print", "notebook", "phone"]);
const CARD_MS = 450;              // the name's card growing from the name (shrinking back: CARD_MS - 50)
const SOFT = "cubic-bezier(0.45, 0, 0.25, 1)";

function engineModule() {
  // ?3d= (0, standin) is remembered for the visit, so a test or a debug session keeps it across page loads
  let p = params.get("3d");
  try { if (p) sessionStorage.setItem("sfw-3d", p); else p = sessionStorage.getItem("sfw-3d"); } catch { /* storage blocked */ }
  if (p === "0") return null;
  if (p === "standin") return "/dev/standin.js";
  return "/shared/gl/engine.js";   // E1's engine (docs/v3/engine-api.md); missing until it lands: photo mode
}

const CSS = `
.sfw-canvas { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 0; display: block; opacity: 0; pointer-events: none; transition: opacity 150ms ease; }
.sfw-canvas.is-on { opacity: 1; }
/* the boot's handover from the photograph (handover-r1): the refined 3D, at the photograph's own camera, fades in */
.sfw-canvas.sfw-handover, html.sfw-handing .sfw-screen { transition: opacity ${HANDOVER_MS}ms ${SOFT}; }
.sfw-live { position: absolute; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
.sfw-links { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 2; overflow: visible; pointer-events: none; }
.sfw-links .hit { fill: transparent; pointer-events: auto; cursor: pointer; }
.sfw-links.sfw-links-back { z-index: 1; }   /* (the window's link, under the objects in front of the glass) */
/* no outline or tint is drawn over the objects (Akshay, 2026-10-15): keyboard focus shows the object's name in the
   tip at its middle (links.js), the window none */
.sfw-links .sfw-link { outline: none; -webkit-tap-highlight-color: transparent; }   /* (nor the browser's tap tint) */
.sfw-gestures { touch-action: pan-y; -webkit-user-select: none; user-select: none; }
/* (two-finger pinch zooms the room; where the page has nothing below it, a one-finger drag turns the view any way) */
html.sfw-noscroll .sfw-gestures #stage, html.sfw-noscroll .sfw-gestures .sfw-links { touch-action: none; }
.sfw-gestures.sfw-no-orbit { touch-action: pan-y pinch-zoom; }
.sfw-gestures.is-live { cursor: grab; }
.sfw-gestures.is-live:active { cursor: grabbing; }
html.sfw-live-mode #hotspots { display: none; }
/* the Projects page on the laptop's screen (shared/laptop.js): mapped onto the 3D screen every frame, under the room's
   links (at the desk a click on the laptop is the laptop's link); leaned in it takes the pointer */
.sfw-screen { position: absolute; left: 0; top: 0; z-index: 1; transform-origin: 0 0; pointer-events: none; visibility: hidden; opacity: 0; transition: opacity 150ms ease; }
.sfw-screen.is-in { opacity: 1; }
.sfw-screen.is-on { pointer-events: auto; }
html.sfw-3d-off .sfw-screen, html.sfw-3d-off .sfw-nb, html.sfw-3d-off .sfw-phone, html.sfw-3d-off .sfw-led { display: none; }
/* the Projects document in the live room: the page's own screen hands over to the room's */
html.sfw-live-mode .projects-home.is-narrow .screen { display: none; }
.sfw-close {
  position: absolute; z-index: 6; top: max(16px, env(safe-area-inset-top)); right: max(16px, env(safe-area-inset-right));
  padding: 0.45rem 0.9rem; border: 1px solid rgba(244, 239, 230, 0.32); border-radius: 999px;
  background: rgba(18, 13, 9, 0.38); color: #f4efe6; font: 500 13px/1.3 "Geist", -apple-system, system-ui, sans-serif;
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); cursor: pointer;
  transition: opacity 150ms ease, background-color 0.2s ease, border-color 0.2s ease;
}
.sfw-close:hover { background: rgba(18, 13, 9, 0.55); border-color: rgba(244, 239, 230, 0.6); }
.sfw-close:focus-visible { outline: 2px solid #f4efe6; outline-offset: 3px; }
.sfw-close[hidden] { display: none; }
.sfw-edges[hidden] { display: none; }
.sfw-edge {
  position: absolute; z-index: 4; top: 42%; padding: 0.5rem 0.55rem; writing-mode: vertical-rl;
  background: rgba(18, 13, 9, 0.34); color: #f4efe6; font: 500 12px/1 "Geist", -apple-system, system-ui, sans-serif;
  letter-spacing: 0.04em; text-decoration: none; -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  transition: opacity 150ms ease;
}
/* portrait: centred on the wall above the window (its frame starts at about 17 % of the height; at 42 % they sat on
   the glass); a turn that brings the window under one fades it (shared/edgefit.js) */
@media (orientation: portrait) { .sfw-edge { top: max(12px, calc(env(safe-area-inset-top) / 2 + 8.5% - 31px)); } }
.sfw-edge.left { left: 0; border-radius: 0 10px 10px 0; transform: rotate(180deg); }
.sfw-edge.right { right: 0; border-radius: 10px 0 0 10px; }
.sfw-edge:focus-visible { outline: 2px solid #f4efe6; outline-offset: 2px; }
/* the window spot: the masthead's own dial docks at the bottom, the rest of the masthead steps aside */
/* (at once: they are taken out of the flow as they go, so a fade would show them over the dial for 150 ms) */
html.sfw-at-window .masthead .who, html.sfw-at-window .masthead nav { opacity: 0; visibility: hidden; transition: none; }
html.sfw-at-window .masthead { grid-template-columns: 1fr; justify-items: center; }
html.sfw-at-window .masthead .clock {
  grid-column: 1 / -1; grid-row: 1; align-items: center; justify-self: center; order: 0;
  padding: 0.7rem 1.1rem 0.8rem; border-radius: 18px; background: rgba(18, 13, 9, 0.34);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
}
html.sfw-at-window .masthead .who, html.sfw-at-window .masthead nav { position: absolute; }
/* the photograph leans in toward the window when there is no 3D */
.sfw-lean { transition: transform 1.4s cubic-bezier(0.45, 0, 0.25, 1); }
/* the About card, beside the notebook (desktop) or docked at the bottom (phones); the words are the page's own */
html.sfw-about-card .about.sfw-about {
  /* (below "Back to the desk", which sits at the top right) */
  position: absolute; z-index: 5; top: max(5vh, 64px); right: max(2.2vw, 16px); width: min(520px, 38vw);
  max-height: calc(var(--sfw-hero-h, 100svh) - var(--sfw-mh, 96px) - max(5vh, 64px) - 24px); overflow: auto;
  border-radius: 14px; box-shadow: 0 30px 70px -30px rgba(0, 0, 0, 0.6); overscroll-behavior: contain;
  background: color-mix(in oklab, var(--paper) 94%, transparent);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  animation: sfw-in var(--sfw-card-in, 250ms) ease both;
}
html.sfw-about-card .about.sfw-about .col { padding: 2.2rem 2rem 1.8rem; max-width: none; }
html.sfw-about-card .about.sfw-about .links { margin-top: 1.6rem; }
html.sfw-about-card .about.sfw-about .credit { margin-top: 1.6rem !important; }
@media (max-width: 760px), (max-aspect-ratio: 11/10) {
  html.sfw-about-card .about.sfw-about { top: auto; bottom: 0; left: 0; right: 0; width: auto; max-height: 56%; border-radius: 16px 16px 0 0; }
  html.sfw-about-card .about.sfw-about .col { padding: 1.6rem 1.25rem 2.2rem; }
}
/* the homepage's words while the live room runs: a card over the room at the desk, top right (phones: a top sheet),
   scrolling inside; the same section as below the window, so focus and reading order are unchanged */
html.sfw-home-card .about.sfw-about {
  position: absolute; z-index: 5; top: 24px; right: 24px; width: min(360px, 28vw);
  max-height: min(40%, calc(100% - var(--sfw-mh, 96px) - 48px), var(--sfw-card-max, 100%)); overflow: auto; overscroll-behavior: contain;
  border-radius: 14px; box-shadow: 0 30px 70px -30px rgba(0, 0, 0, 0.6);
  background: color-mix(in oklab, var(--paper) 94%, transparent);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  animation: sfw-in var(--sfw-card-in, 250ms) ease both;
}
html.sfw-home-card .about.sfw-about .col { padding: 1.5rem 1.6rem 1.3rem; max-width: none; }
html.sfw-home-card .about.sfw-about .links { margin-top: 1.4rem; }
html.sfw-home-card .about.sfw-about .credit { margin-top: 1.4rem !important; }
@media (max-width: 760px), (max-aspect-ratio: 11/10) {
  html.sfw-home-card .about.sfw-about { top: max(12px, env(safe-area-inset-top)); left: 12px; right: 12px; width: auto; max-height: 34%; }
  html.sfw-home-card .about.sfw-about .col { padding: 1.2rem 1.25rem 1.1rem; }
}
.about.sfw-about.sfw-card-out { opacity: 0; transition: opacity 150ms ease; }
/* focus moves onto the card itself (tabindex -1) when it opens: the card is the sign, no ring round it */
.about.sfw-about:focus { outline: none; }
/* the masthead's name opens the card (the same look; the usual hover and focus states) */
.masthead .who .sfw-name {
  margin: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; letter-spacing: inherit;
  text-align: inherit; text-shadow: inherit; cursor: pointer;
  text-decoration: underline 1px transparent; text-underline-offset: 4px; transition: text-decoration-color 0.2s ease;
}
.masthead .who .sfw-name:hover, .masthead .who .sfw-name[aria-expanded="true"] { text-decoration-color: var(--on-scene-faint, rgba(244, 239, 230, 0.28)); }
.masthead .who .sfw-name:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; border-radius: 2px; }
/* a quiet masthead at a leaned-in spot (spec v2): 30 %, back when the pointer nears it (sfw-near) or focus is in it;
   phones (no hover) keep it */
.masthead { transition: opacity 0.6s ${SOFT}; }
@media (hover: hover) and (pointer: fine) {
  html.sfw-quiet .masthead:not(.sfw-near):not(:focus-within) { opacity: 0.3; }
}
/* the laptop's page under the room's light (shared/gl/sheen.js): the same lift, drawn over the page (color-dodge:
   base / (1 - b) is base x (1 + gain)), clipped to the screen */
.sfw-sheen { position: absolute; inset: 0; z-index: 1; pointer-events: none; mix-blend-mode: color-dodge; }
/* no tap tint on the masthead's buttons either (the name, the clock, the dial's icon): a phone tap flashed them blue */
.masthead button { -webkit-tap-highlight-color: transparent; }
.sfw-sheen[hidden] { display: none; }
@keyframes sfw-in { from { opacity: 0; } }
@keyframes sfw-out { to { opacity: 0; } }
/* a page moved into the homepage: its first screen lies over the room, its photograph stays hidden under the 3D */
.sfw-page { position: relative; z-index: 1; margin-top: calc(-1 * max(520px, 100svh)); pointer-events: none; }
.sfw-page > * { pointer-events: auto; }
.sfw-page .hero { pointer-events: none; }
.sfw-page .hero > .room { background: none; pointer-events: none; }
.sfw-page .hero .room-stage { visibility: hidden; }
.sfw-page .hero .reader, .sfw-page .hero .pager, .sfw-page .hero .shelf .hit { pointer-events: auto; }
/* (touch on the spines is the room's as on the hero: vertical drags scroll the page, the rest turns, flicks, pinches) */
.sfw-gestures ~ .sfw-page .hero .shelf .hit { touch-action: pan-y; }
.sfw-page .spine .img { display: none; }
/* in the live room the spine's lift is the 3D book's (stream I): keyboard focus keeps today's two-tone ring */
.sfw-page .spine:focus-visible .hit { background: rgba(255, 250, 242, 0.28); }
.sfw-page .spine:focus-visible { filter: drop-shadow(0 0 0.8px #fffaf2) drop-shadow(0 0 0.8px #fffaf2) drop-shadow(0 0 2.5px rgba(12, 10, 8, 0.75)); }
html.sfw-3d-off .sfw-page .hero .room-stage { visibility: visible; }
html.sfw-3d-off .sfw-page .spine .img { display: revert; }
.sfw-page.is-out { opacity: 0; transition: opacity 150ms ease; }
.sfw-page.is-in { animation: sfw-in 250ms ease both; }
/* a page hosted in the homepage marks its masthead link as a page document does (world.css) */
.masthead nav a[aria-current="page"] { color: var(--on-scene); }
/* keep the homepage's own photograph layers as they are while a page's stylesheet is in */
.scene > .stage > .layer.room { position: absolute; overflow: visible; isolation: auto; contain: none; background: none; }
.sfw-vh { position: absolute !important; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (prefers-reduced-motion: reduce) {
  .sfw-canvas, .sfw-lean, .sfw-page.is-out, .sfw-close, .masthead { transition-duration: ${CUT}ms !important; }
  html.sfw-about-card .about.sfw-about, .sfw-page.is-in { animation-duration: ${CUT}ms; }
  html.sfw-home-card .about.sfw-about, .masthead .who .sfw-name { animation: none; transition: none; }
}
`;

// handover-r1: each moment's measured colour correction, per tier (a 3x4 matrix in display space: rows of r, g, b, offset)
// laid after the bake's own matrix for that moment (engine.setColourMatrix; setLight uses it), only for the model the
// table was measured on
function applyMatch(engine, table) {
  if (!table?.moments || !engine?.bake || !engine.setColourMatrix || table.model_hash !== engine.bake.model_hash) return;
  for (const [id, entry] of Object.entries(table.moments)) {
    const m = engine.bake.moments[id], C = entry?.tiers?.[engine.settings?.tier]?.m || entry?.m;   // (per tier: phones draw differently)
    if (!m || !Array.isArray(C) || C.length !== 12 || !C.every(Number.isFinite)) continue;
    const B = m.matrix || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], out = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 4; j++) {
        let v = j === 3 ? C[i * 4 + 3] : 0;
        for (let k = 0; k < 3; k++) v += C[i * 4 + k] * B[k * 4 + j];
        out.push(v);
      }
    }
    engine.setColourMatrix(id, out);
  }
}

class Nav {
  constructor(opts) {
    this.o = opts;
    this.doc = opts.doc || "home";
    this.hero = opts.hero;
    this.mode = reducedQ.matches ? "still" : "photo";
    this.spot = null;
    this.room = null;
    this.engine = null;
    this.rig = null;
    this.live = null;              // { canvas, layer, links, picker, gestures, overlays, edges, pass }
    this.outside = null;           // the view outside the window (shared/outside.js), in live mode
    this.interact = null;          // the lamp switch, book pulls and steam (shared/gl/interact.js), in live mode
    this.useHover = null;          // what the interactions' pointer is over ("lamp", "book:12", null)
    this.page = null;              // a page moved into the homepage: { spot, el, handle, styles, title }
    this.pageCache = new Map();
    this.ready = null;             // resolves when the 3D is ready (or null when it never will be)
    this.title0 = document.title;
    this.seq = 0;
  }

  // ---------- boot ----------
  async boot() {
    // ?debug (or a remembered ?3d= switch): a read-only handle for checking the router from the console
    if (params.has("debug") || (() => { try { return sessionStorage.getItem("sfw-3d"); } catch { return null; } })()) window.__sfwNav = this;
    style();
    soundRoom(this);   // the sound (shared/sound.js) follows this room's camera, city and interactions once it is on
    document.documentElement.classList.add("js");   // the pages' convention: scripts run (their CSS keys off it)
    this.announce = el("div", { class: "sfw-vh", "aria-live": "polite" });
    document.body.appendChild(this.announce);
    this.overlays = new Overlays({ announce: this.announce });
    this.close = el("button", { class: "sfw-close", type: "button", hidden: "" });
    this.close.textContent = "Back to the desk";   // approved label (docs/V3-GOAL.md)
    this.close.addEventListener("click", () => this.backToDesk());
    this.hero.appendChild(this.close);

    // an essay's static page sent a live-capable browser here (/?writing=<slug>, or /?writing for the list): the essay's
    // own address again at once, and the reading sheet rises while the room boots (it leans to the notebook behind it)
    const wp = this.doc === "home" ? params.get("writing") : null;
    if (wp !== null) {
      const slug = WRITING_SLUG.test(wp) ? wp : "";
      const keep = new URLSearchParams(location.search); keep.delete("writing");
      history.replaceState({ sfw: 1, spot: "notebook" }, "", `/writing/${slug}${keep.toString() ? "?" + keep : ""}`);
    }
    const deep = this.doc === "home" ? (location.pathname.match(/^\/writing\/([a-z0-9][a-z0-9-]*)\/?$/) || [])[1] || null : null;
    if (deep) this.startReader().then((r) => r.route()).catch(() => {});
    // the menu's About and Social (nav-r1): from the first click, on every document; /#about opens his bio in the
    // reading sheet at once (over the first paint while the room boots), /#social goes to the phone once the room is up
    document.addEventListener("click", (e) => this.onMenu(e), true);
    const menuLink = this.doc === "home" && norm(location.pathname) === "/" ? location.hash : "";
    if (menuLink === "#about") this.openAbout({ fresh: true }).catch(() => {});

    this.room = await loadSpots().catch(() => null);
    if (!this.room) return;   // no spot data: the pages work as they are
    if (this.doc === "home") this.nameButton();
    this.spot = this.doc === "home" ? spotForURL(this.room, location.href, history.state) || "desk" : { books: "shelf", quotes: "print", projects: "laptop" }[this.doc];
    if (this.doc === "home" && this.spot !== "desk" && !["window", "notebook"].includes(this.spot)) this.spot = "desk";
    // (/#about: his bio in the reading sheet since nav-r1, opened above; the name's card opens only from the name)

    document.addEventListener("click", (e) => this.onClick(e), true);
    addEventListener("popstate", (e) => this.onPop(e));
    addEventListener("keydown", (e) => this.onKey(e));
    addEventListener("keydown", (e) => this.onWindowEscape(e), true);   // (before the docked dial's own Escape: qa-escape)
    document.addEventListener("focusin", (e) => this.onFocusIn(e));
    addEventListener("pageshow", (e) => this.onPageShow(e));
    addEventListener("resize", () => { clearTimeout(this.rt); this.rt = setTimeout(() => this.onResize(), 120); });
    addEventListener("pointermove", (e) => this.nearMasthead(e), { passive: true });
    document.addEventListener("sky:dial", (e) => { if (!e.detail.open && this.spot === "window" && this.docked) setTimeout(() => this.openDial(), 0); });
    reducedQ.addEventListener?.("change", () => { if (reducedQ.matches && this.mode === "photo") this.mode = "still"; });

    // a reload of the window's history entry comes back to the window; /#about to the name's card
    if (this.doc === "home" && this.spot === "window") this.photoWindow(true, { instant: true });
    if (this.doc === "home" && this.spot === "notebook") scrollTo({ top: 0, behavior: "instant" });
    if (this.cardOpen && this.mode !== "live") { this.cardOpen = false; this.setCard(true); }
    this.showClose();

    if (this.doc === "projects") {
      // the page's app routes on hashchange; in the live room the screen has the projects, and Back between two of
      // them must not make the app swap the page (and the room with it) for its project page
      window.__sfwProjectClaim = true;
      addEventListener("hashchange", (e) => {
        if (this.mode !== "live" && this.mode !== "booting") return;
        e.stopImmediatePropagation();
        if (this.mode === "live" && this.laptop?.scr) { this.laptop.scr.show(this.laptop.mod.routeOf(location.hash)); this.saveScreen(); }
      }, true);
    }
    this.ready = this.mode === "still" ? Promise.resolve(false) : this.bootLive();
    const live = await this.ready;
    if (menuLink === "#social") this.arriveSocial(live).catch(() => {});
    // (the static writing pages send a browser here only while this visit's room has not failed to start)
    try { if (live) sessionStorage.removeItem(ROOM_OFF_KEY); else sessionStorage.setItem(ROOM_OFF_KEY, "1"); } catch { /* storage blocked */ }
    if (!live && this.doc === "home" && this.spot === "notebook") {
      // no live room: an essay stays in its reading sheet over the photograph (closing it leaves the homepage), the
      // list of essays is its static page
      if (deep) { this.spot = "desk"; this.showClose(); this.startReader().then((r) => { r.o.home = "/"; }); }
      else { location.replace("/writing/"); return; }
    }
    if (this.doc === "projects" && !live && window.__sfwProject) {
      // no live room: the shared project's own page, as before
      const slug = window.__sfwProject;
      window.__sfwProject = null;
      location.replace(`#/project/${slug}`);
    } else if (this.doc === "projects" && !live && /^#\/project\//.test(location.hash)) {
      dispatchEvent(new HashChangeEvent("hashchange"));   // a project clicked while the room was booting
    }
    if (live && this.doc === "home" && this.spot === "notebook") {
      // /#about: the card is open over the desk's view; once the page has been quiet 0.8 s the camera leans to the
      // notebook (plan 3.3), unless the visitor has gone elsewhere meanwhile
      await this.quiet(ABOUT_IDLE);
      if (this.spot === "notebook" && this.rig.spot === "desk" && !this.rig.glide) {
        this.reveal();
        const r = await this.rig.glideTo("notebook", { aim: this.aimFor("notebook") });
        if (r.landed && this.spot === "notebook") this.afterLanding("notebook", { quiet: true });
      }
    }
  }

  quiet(ms) {
    return new Promise((res) => {
      let t = 0;
      const again = () => { clearTimeout(t); t = setTimeout(done, ms); };
      const done = () => { for (const k of ["pointermove", "keydown", "scroll", "wheel"]) removeEventListener(k, again); res(); };
      for (const k of ["pointermove", "keydown", "scroll", "wheel"]) addEventListener(k, again, { passive: true });
      t = setTimeout(done, ms);
    });
  }

  // The 3D, in the background after first paint. Resolves true once the room can glide, false for photo mode.
  async bootLive() {
    const url = engineModule();
    const save = navigator.connection?.saveData;
    if (!url || save || bootTier() === "T0" || this.mode === "still") return false;
    // the real engine boots only once there is a room to draw (room3d.json names its asset set; ?bake= for
    // testing): until then every visitor keeps the photographs and downloads none of the 3D
    const bake = params.get("bake") || this.room.data.bake || null;
    // the view outside needs its panorama (docs/v3/outside.md): without one the window would show the desk's photograph
    const pano = params.get("pano") || this.room.data.pano || null;
    if ((!bake || !pano) && !url.includes("standin")) return false;
    this.mode = "booting";
    // (handover-r1: no idle wait here any more; the router itself starts right after first paint)
    if (params.has("slow3d")) await wait(+params.get("slow3d") || 0);   // testing the never-wait rule
    // every module the boot imports, asked for at once (they used to come one after another, a round trip each);
    // the awaits below then find them loaded
    const mods = {
      engine: import(url),
      outside: pano ? import("./outside.js") : null,
      interact: import("./gl/interact.js"), sheen: import("./gl/sheen.js"), mast: import("./masthead.js"),
      desk: this.doc === "home" ? Promise.all([import("./notebook.js"), import("./phone.js"), import("./toys.js")]) : null,
    };
    for (const p of Object.values(mods)) p?.catch(() => {});   // (a failure is met where each is awaited)
    let outsideP = null;
    try {
      const mod = await mods.engine;
      if (!mod.engineSupport().ok) throw new Error("unsupported");
      const canvas = el("canvas", { class: "sfw-canvas", "aria-hidden": "true" });
      this.placeCanvas(canvas);
      const engine = await mod.createEngine({ canvas, tier: "auto", reducedMotion: "auto" });
      const roomP = engine.loadRoom({ bake });
      // the view outside (stream X1): the panorama through the live camera, the city's events, the halo. Added before
      // the warm-up, so its shaders compile and draw in the warm-up's hidden frames. On the homepage it starts from the
      // exterior pictures on screen (the same pixels); a page's photograph has its view baked in, so tiles at once.
      // (handover-r1: made while the model loads, not after it: it needs only the GL context to start, and its
      // panorama files then come in alongside the model's)
      if (pano && engine.gl) {
        const photo = this.doc === "home" ? this.o.photo?.() : null;
        outsideP = mods.outside.then(({ createOutside }) => createOutside(engine, {
          pano, viewKey: photo?.view === "home_p" ? "home_p" : "home_l",
          scene: loadScene(),      // the scene.json the page has already fetched and parsed (one copy, read only)
          firstPaint: (this.doc === "home" && this.o.exterior?.()) || false,
          // (handover-r1: the window keeps the photograph's own pixels through the handover, released after it)
          holdFirstPaint: this.doc === "home",
        }));
        outsideP.catch(() => {});
      }
      await roomP;
      // the 3D's colour matched to the photographs, per moment (handover-r1; handover-match.json, measured by
      // scripts/live/handover_grade.py): only for the model it was measured on, and only on the homepage, whose
      // photographs it was measured against (the pages' photographs are other sets); ?match=0 leaves it out (for measuring)
      const matchP = params.get("match") === "0" || this.doc !== "home" ? null
        : fetch(new URL("./handover-match.json", import.meta.url)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      // the moment's light maps and probes, fetched now (engine caches: the first setLight below reuses them), while
      // the outside, the interactions and the warm-up get ready
      const m0 = (await mods.mast.catch(() => null))?.getMoment() || null;
      const moment0 = pickMoment(m0?.frame, Object.keys(engine.bake?.moments || {}));
      if (moment0 && engine.prefetchMoment) engine.prefetchMoment(moment0).catch(() => {});
      if (outsideP) this.outside = await outsideP;
      applyMatch(engine, await matchP);
      // the things in the room you can use (stream I): the lamp switch, book pulls, the tea steam. After loadRoom (it
      // extends the room's shaders) and before the warm-up (so those compile there). The canvas takes no pointer
      // events (the hero does: gestures, picking), so it listens there and measures from the canvas; the cursor
      // stays the router's (onHover below). Book pulls are on only at the shelf (afterLanding / leaving).
      if (engine.gl && engine.room) {
        const { createInteractions } = await mods.interact;
        // pointer events over the room (the hero) and over a hosted Books page's spines (they follow the 3D shelf
        // but sit outside the hero), never over cards, the masthead or text
        const hero = this.hero, wrapped = new Map();
        const ours = (e) => {
          const t = e.target;
          if (t?.closest?.(".spine")) return true;
          return !!t && hero.contains(t) && !t.closest?.(".sfw-about, .about, .reader, .pager, .card, .masthead, a, button, input");
        };
        const target = {
          addEventListener: (k, fn) => { const w = (e) => { if (k === "pointerleave" || ours(e)) fn(e); }; wrapped.set(fn, w); (k === "pointerleave" ? hero : document).addEventListener(k, w); },
          removeEventListener: (k, fn) => { const w = wrapped.get(fn); if (w) (k === "pointerleave" ? hero : document).removeEventListener(k, w); },
          getBoundingClientRect: () => canvas.getBoundingClientRect(),
          style: {},
        };
        this.interact = createInteractions(engine, { canvas: target, cursor: false, books: this.spot === "shelf" });
        this.interact.on("hover", ({ object }) => { this.useHover = object; this.setCursor(); });
        // the visitor's own switch wins over the dusk rule for the rest of the visit (lampFor)
        this.interact.on("lamp", ({ on }) => { this.lampChoice = on ? 1 : 0; try { sessionStorage.setItem(LAMP_KEY, String(this.lampChoice)); } catch { /* storage blocked: this document only */ } });
        // the light that answers the pointer, and the first visit's glint (gl/sheen.js); the laptop's page follows it
        const { createSheen } = await mods.sheen;
        this.sheen = createSheen(engine);
        this.sheen.compile().catch(() => {});
        this.sheen.onFrame((st) => this.screenSheen(st));
        // interactions B: the notebook's cover and elastic (their shader code compiles in the warm-up) and the phone's
        // screen (its corners, from the model)
        if (this.doc === "home") {
          const [nbm, phm, toys] = await mods.desk.catch(() => [null, null, null]);
          this.mods = { nbm, phm, toys };
          try { this.nb3d = nbm?.createNotebook(engine, this.room) || null; } catch (err) { console.warn("[notebook]", err); this.nb3d = null; }
          const pq = phm?.phoneQuad(engine);
          if (pq) this.room.objects.phone_screen = { ...(this.room.objects.phone_screen || {}), quad: pq };
        }
      }
      if (engine.warmUp) await engine.warmUp();   // v1.1: compile and draw once, hidden; "ready" fires at its end
      // the Projects document's photograph (its app lays it out as shared/pages.js says): the room starts on it
      if (this.doc === "projects" && !this.o.page?.photo) await this.projectsPhoto().catch(() => {});
      this.mast = await mods.mast.catch(() => null);
      const m = this.mast?.getMoment() || null;
      const moment = pickMoment(m?.frame, Object.keys(engine.bake?.moments || {}));
      if (moment) await engine.setLight({ moment, lamp: this.lampFor(m?.date, moment, engine), screen: 1 }, { fade: 0 }).catch(() => {});
      // one hidden frame in the moment's light (its sunbeams, the night glass, its light maps), so their first draws are
      // not in the first frames on screen (perf-r2, perf-prep #5)
      if (moment && engine.warmLight) await engine.warmLight().catch(() => {});
      engine.start();
      this.engine = engine;
      // the room's light follows the clock and the dial (a moment change waits for a still camera, plan 2.2), and so
      // does the lamp at dusk (lampFor); the clock's own minutes are checked every 30 s for the lamp
      this.mast?.onMoment((d) => {
        this.outside?.follow(d);   // the view outside and its city run on the dial's time too
        this.wantLight(d.reason);
      });
      this.lampTimer = setInterval(() => { if (this.mode === "live" && this.mast?.getMoment().minutes === null) this.wantLight("tick"); }, 30000);
      engine.on("fallback", () => this.toPhoto());
      engine.on("contextlost", () => this.contextLost(true));
      engine.on("contextrestored", () => this.contextLost(false));
      this.mode = "live";
      // (before the room measures itself: on the Projects document the class takes the page's own list out of the
      // hero, which changes the room's box on phones)
      document.documentElement.classList.add("sfw-live-mode");
      this.startLive(canvas);
      return true;
    } catch (err) {
      if (params.has("debug")) console.warn("3D unavailable:", err && err.message);
      document.documentElement.classList.remove("sfw-live-mode");
      this.mode = reducedQ.matches ? "still" : "photo";
      this.outside?.dispose();
      if (!this.outside) outsideP?.then((o) => o?.dispose()).catch(() => {});   // made while the model failed to load
      this.outside = null;
      this.interact?.dispose();
      this.interact = null;
      this.live?.canvas?.remove();
      return false;
    }
  }

  placeCanvas(canvas) {
    if (this.doc === "home") {
      this.o.stage.after(canvas);
    } else {
      // a page: over its photograph, under its overlays (spines, the print, the pager)
      const room = this.hero.querySelector(".room");
      const stage = room?.querySelector(".room-stage");
      if (stage) stage.after(canvas); else (room || this.hero).prepend(canvas);
    }
  }

  startLive(canvas) {
    const layer = el("div", { class: "sfw-live", "aria-hidden": "true" });
    canvas.after(layer);
    this.live = { canvas, layer, revealed: false };
    this.swayHold = true;   // (released by handover3d, or at once where there is no handover)
    const size = () => [canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight];
    this.size = size;
    // the rig's view of the room: leaning in to the laptop (and back out of it) the eye comes closer to the laptop
    // than its furniture box allows, so that box is not an obstacle while the rig is at the laptop or leaving it
    const base = this.room;
    const rigRoom = Object.create(base);
    Object.defineProperty(rigRoom, "obstacles", {
      get: () => (this.rig && (this.rig.spot === "laptop" || this.rig.from === "laptop") ? base.obstacles.filter((o) => o.name !== "laptop") : base.obstacles),
    });
    this.rig = new Rig(rigRoom, {
      frame: (name) => (name === "laptop" && this.leanFrame() ? this.leanFrame()
        : name === "notebook" && this.nbFrame() ? this.nbFrame()
        : name === "phone" && this.phoneFrame() ? this.phoneFrame()
        : frameSpot(this.room, name, { w: size()[0], h: size()[1], reserve: this.reserveFor(name) })),
      onPose: (pose) => this.applyPose(pose),
      onState: ({ to, spot }) => { if (to === "glide" || to === "orbit") this.reveal(); if (to === "glide" || to === "rest") this.wantHi(spot); if (to === "glide" && this.swayAt) this.sway(); },
      onWake: () => this.engine.invalidate?.("nav"),
      limit: (name, pose, rest) => this.clearOfCard(name, pose, rest),
      reducedMotion: () => reducedQ.matches,
      magCap: (name) => this.magCap(name),
    });
    this.engine.addPass({
      name: "nav-rig", stage: "prepare",
      update: (f) => {
        if (!this.rig.moving) return;
        this.rig.tick(f.time); this.wantHiZoom();
        if (this.rig.zooming && this.swayAt) this.sway();
        // (v3/zoom: the moving frames' intervals, for a phone's magnifier cap; the magnifier's code once it is used)
        (this.movingDts ||= []).push(f.dt); if (this.movingDts.length > 120) this.movingDts.shift();
        if (this.rig.magnified && !this.zoomMod) this.loadZoom();
      },
      animating: () => this.rig.moving,
      render() {}, needsRender: () => false,
    });
    // the links layer replaces the photograph's hotspots (the homepage) and follows the camera
    if (this.doc === "home") {
      this.live.links = new LinkLayer(this.hero, this.room, {
        tip: this.o.tip,
        onActivate: (name, e) => (name === "window" ? this.windowLink(e) : name === "headphones" ? this.egg() : name === "breadboard" ? this.blinkBoard() : this.go(name)),
        onFocusOff: () => this.rig.resetOrbit(reducedQ.matches ? 0 : 600),
        // an object's name shows only with the camera at rest at the spot (never carried along by a glide)
        canTip: () => !this.rig?.glide && this.rig?.state !== "glide" && this.landedAt === this.spot,
        // the pointer or keyboard focus on an object's link: it answers with light (light())
        onLight: (name, how) => { if (how === "focus") this.focusLight = name; else this.linkHover = name; this.light(); },
      });
      // the masthead comes after the room in the tab order, as it does today
      this.live.links.placeAfter(this.o.stage);
    }
    this.live.picker = new Picker({
      engine: this.engine, room: this.room,
      onHover: (hit) => { this.navHover = hit; this.setCursor(); },
      onPick: (hit) => {
        document.dispatchEvent(new CustomEvent("sfw:pick", { detail: hit }));   // the lamp switch (stream I) listens
        if (this.doc === "home" && hit.object === "headphones") { this.egg(); return; }
        if (this.doc === "home" && hit.object === "breadboard") { this.blinkBoard(); return; }
        if (hit.spot && hit.spot !== this.spot && this.doc === "home") this.go(hit.spot);
      },
    });
    this.live.gestures = new Gestures(this.hero, {
      rig: this.rig,
      enabled: () => this.mode === "live" && this.orbit !== false,
      onDragStart: () => this.reveal(),
      // the mouse turns the view outside a little: the pointer's place kept (sway() scales it, smaller as the lens narrows,
      // v3/zoom); handover-r1: held at rest until the boot's handover is done, then eased to it once (swaySettle)
      onSway: (x, y) => { this.swayAt = [x, y]; if (!this.swayHold) this.sway(); },
      onDown: (x, y, e) => { if (e.pointerType !== "mouse") this.live.picker.at(x, y).then((h) => h?.spot && this.prefetch(h.spot)); },
      onTap: (x, y, e) => this.onTap(x, y, e),
      // v3/zoom: at the window a double click or double tap takes the magnifier (and the dolly and the turn) back to
      // rest; everywhere else the second tap is a tap as before
      onDouble: (x, y, e) => {
        const r = this.rig;
        if (this.spot === "window" && this.landedAt === "window" && !r.glide && (r.magnified || r.dollyT || r.off.yaw || r.off.pitch)) {
          r.resetOrbit(reducedQ.matches ? 0 : 450);
          if (this.swayAt) this.sway();
        }
        else this.onTap(x, y, e);
      },
      toCanvas: (x, y) => { const b = this.live.canvas.getBoundingClientRect(); return { x: x - b.left, y: y - b.top, w: b.width, h: b.height }; },
      onFlick: (dir) => this.flick(dir),
      onZoom: (moved, at) => { this.reveal(); if (this.spot === "window") this.zoomStart(at); },
      // the homepage with its words in the card has nothing below the room: vertical drags turn the view
      pageScrolls: () => !(this.cardMode && !this.page),
      // leaned in to the laptop the wheel scrolls its screen, wherever it is over the room, and nothing zooms
      wheelTo: () => (this.spot === "laptop" && this.landedAt === "laptop" ? this.laptop?.scr?.scroller || null : null),
      noZoom: () => this.spot === "laptop",
    });
    this.hero.classList.add("is-live");
    this.hero.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" && !this.live.gestures.p) this.live.picker.hover(e.clientX, e.clientY); }, { passive: true });
    if (this.doc === "home" && coarseQ.matches) {
      const nav = (href) => [...document.querySelectorAll(".masthead nav a")].find((a) => norm(new URL(a.href).pathname) === norm(href));
      const b = nav("/books/"), q = nav("/quotes.html");
      this.live.edges = new EdgeTabs(this.hero, {
        left: b && { href: b.getAttribute("href"), text: b.textContent, spot: "shelf" },
        right: q && { href: q.getAttribute("href"), text: q.textContent, spot: "print" },
        onGo: (spot) => this.go(spot),
      });
    }
    // the Projects page on the laptop's screen, at every distance (shared/laptop.js)
    this.startScreen();
    // the notebook's index, the phone's lock screen, the breadboard's LED, the headphones' video (interactions B)
    this.startDesk();
    // the engine's spot registry (QA's ?qa=1&spot= and engine.goToSpot) holds this screen's framed rest poses
    this.registerSpots();
    // the first frame reproduces the first-paint photograph exactly (plan 3.4)
    this.bootPose();
    if (this.doc !== "home") {
      const handle = this.o.page?.handle;
      if (handle) this.anchor(handle, () => { const p = this.photoNow(); return p && { camera: p.camera, size: p.size, geo: p.geo }; });
      this.orbit = !!handle || this.doc === "projects";   // (Projects: the room's own screen follows the camera)
      this.hero.classList.toggle("sfw-no-orbit", !this.orbit);   // (and keeps the browser's pinch-zoom)
    }
    if (this.doc === "home") this.enterCardMode();
    this.afterLanding(this.spot, { quiet: true });
    this.scheduleGlint();
    if (this.bootCrop) {
      this.outside?.rebase?.();
      // (whatever happens, the window and the sway are not left held)
      this.handover3d().catch(() => {}).finally(() => { this.handingOver = false; if (this.outside?.held) this.outside.release(); if (this.swayHold === true) this.swaySettle(); });
    }
    else { this.outside?.release?.(); this.swaySettle(); }   // (no handover from a photograph here: as before)
  }

  // handover-r1: the photograph hands over to the 3D by itself, at the photograph's own camera (bootPose), once the
  // 3D's picture has refined (its accumulated frame, never the first rough one) and the window's tiles are in (at most
  // HANDOVER_WAIT after the room has refined): a HANDOVER_MS eased crossfade (reduced motion: the usual cut). Only then
  // the framing ease where the spot's framing differs from the photograph's (bootEase), so the handover itself has no
  // camera move. A glide, drag or zoom first shows the 3D at once, as before (reveal()), and the framing is then the
  // visitor's.
  async handover3d() {
    const e = this.engine, t0 = performance.now();
    this.handingOver = true;   // (the first visit's glint waits for the whole handover: scheduleGlint)
    let settledAt = 0;
    // the homepage's photograph eases its parallax to rest meanwhile (the 3D starts at its rest camera)
    let still = !this.o.parallax;
    if (this.o.parallax) this.o.parallax(false).then(() => { still = true; });
    for (;;) {
      if (!this.live || this.mode !== "live") return;
      if (this.live.revealed) {
        // the visitor moved first (a drag, a glide, a zoom showed the 3D): the framing ease as before, 0.8 s on, if at rest
        const go = this.bootEase;
        this.bootEase = null;
        if (go) setTimeout(go, 800);
        this.outside?.release?.();
        this.swaySettle();
        this.handingOver = false;
        return;
      }
      const now = performance.now();
      const room = e.state === "settled";
      if (room && !settledAt) settledAt = now;
      const st = this.outside?.store;
      // the window: the photograph's own pixels still (held), or the live view with its tiles in
      const view = !this.outside || (this.outside.held && this.outside.stage === "first-paint") || (this.outside.stage === "tiles" && !st?.busy);
      if ((room && still && (view || now - settledAt > HANDOVER_WAIT)) || now - t0 > HANDOVER_MAX) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
    const c = this.live.canvas;
    const root = document.documentElement;
    if (!reducedQ.matches) { c.classList.add("sfw-handover"); root.classList.add("sfw-handing"); }   // (the laptop's page with it)
    this.handoverAt = performance.now();
    this.reveal();
    await wait(reducedQ.matches ? CUT : HANDOVER_MS + 50);
    c.classList.remove("sfw-handover");
    root.classList.remove("sfw-handing");
    this.swaySettle();
    // then the live view outside dissolves in over the photograph's window (once its tiles are in), and only then the
    // framing ease (at most WINDOW_WAIT: on a slow network the ease goes first and the view switches when it can)
    if (this.outside?.release) await Promise.race([this.outside.release(reducedQ.matches ? 0 : WINDOW_FADE_MS), wait(WINDOW_WAIT)]);
    const go = this.bootEase;
    this.bootEase = null;
    this.handingOver = false;
    go?.();
  }

  // handover-r1: the mouse sway, held at rest through the handover, eases to the pointer's (about 0.6 s), then follows it
  // at once again as before
  swaySettle() {
    if (!this.swayHold || this.swayHold === "easing") return;
    if (!this.swayAt || reducedQ.matches) { this.swayHold = false; if (this.swayAt) this.sway(); return; }
    this.swayHold = "easing";
    const t0 = performance.now();
    const step = (now) => {
      if (this.mode !== "live") { this.swayHold = false; return; }
      const k = Math.min(1, (now - t0) / 600), e = 0.5 - 0.5 * Math.cos(Math.PI * k);
      this.sway(e);
      this.engine.requestFrame?.();
      if (k < 1) requestAnimationFrame(step); else this.swayHold = false;
    };
    requestAnimationFrame(step);
  }

  // ---------- the first visit's glint ----------
  // About 2 s after the live room has settled at the desk, once per browser (localStorage, GLINT_KEY): a single soft band
  // of light crosses the desk's objects (GLINT), like a reflection. Never with reduced motion; never when the browser
  // keeps no storage (it could not be once only). If the visitor is elsewhere it waits for the desk, for 45 s at most.
  scheduleGlint() {
    if (this.doc !== "home" || !this.sheen || reducedQ.matches || this.glintPlanned) return;
    try { if (localStorage.getItem(GLINT_KEY)) return; } catch { return; }
    this.glintPlanned = true;
    const t0 = performance.now();
    let settled = 0, still = 0;
    const tick = () => {
      if (this.mode !== "live" || reducedQ.matches || performance.now() - t0 > 45000) return;
      const now = performance.now();
      // (handover-r1: not while the boot's handover is still going on: the crossfade, the window's dissolve, the framing ease)
      const desk = this.spot === "desk" && this.landedAt === "desk" && !this.rig.glide && this.rig.state !== "glide" && !this.rig.moving && !this.handingOver;
      if (!settled && desk && this.engine.state === "settled" && !this.outside?.store?.busy) settled = now;
      still = settled && desk ? still || now : 0;
      if (!still || now - still < GLINT_AFTER) { setTimeout(tick, 120); return; }
      try { localStorage.setItem(GLINT_KEY, "1"); } catch { return; }
      this.reveal();
      this.sheen.glint(GLINT).then((ran) => { this.glintRan = ran; });
    };
    tick();
  }

  // ---------- light: the objects answer the pointer (spec v2: "with light, never an outline") ----------
  // What is lit: under the pointer, the lamp or a book the interactions use, else an object's link at the desk, else an
  // object that glides somewhere else (the cursor's rule, setCursor); without the pointer, the link keyboard focus is
  // on. Only with the camera at rest at a spot (a glide carries nothing along). Phones have no hover: nothing.
  light() {
    if (!this.sheen) return;
    const atRest = this.mode === "live" && !this.rig?.glide && this.rig?.state !== "glide" && this.landedAt === this.spot;
    let names = null, k = 1;
    if (atRest) {
      const u = this.useHover, hit = this.navHover;
      // (at the desk the objects' links say it; elsewhere the pick, but never the window wall's: it is not the view)
      const glides = this.spot !== "desk" && hit?.spot && hit.spot !== this.spot && hit.spot !== "window" && !!this.room?.spots[hit.spot];
      const acts = this.spot !== "desk" && this.spot !== "laptop" && (hit?.object === "headphones" || hit?.object === "breadboard");
      if (u) names = u === "lamp" ? LIGHT.lamp : [u];
      else if (this.linkHover) names = LIGHT[this.linkHover] || null;
      else if (acts) names = LIGHT[hit.object];
      else if (glides) names = LIGHT[hit.spot] || (hit.object ? [hit.object] : null);
      else if (this.focusLight) names = LIGHT[this.focusLight] || null;
      if (names === LIGHT.window) k = LIGHT_K.window;
    }
    this.sheen.hover(names, k);
  }

  // The laptop's page is HTML over the canvas: the room's lift and the glint's band are drawn on it too, clipped to the
  // screen's corners as the camera sees them.
  screenSheen(st) {
    const ls = this.laptop, S = this.sheen;
    const lit = (names) => !!names && (names.includes("screen") || names.includes("laptop"));
    let flat = 0;
    for (const h of st.hover || []) if (lit(h.names)) flat += h.amount * S.gains.hover;
    const band = st.glint && lit(st.glint.names) && st.glint.s !== undefined ? st.glint : null;
    const show = !!ls?.host && this.live?.revealed && ls.host.classList.contains("is-in") && (flat > 0.0005 || band);
    let el = this.sheenFace;
    if (!show) { if (el) el.hidden = true; return; }
    if (!el) {
      el = this.sheenFace = document.createElement("div");
      el.className = "sfw-sheen";
      el.setAttribute("aria-hidden", "true");
    }
    if (el.previousElementSibling !== ls.host) ls.host.after(el);
    const [w, h] = this.size();
    const P = this.room.objects.screen.quad.map((p) => project(this.rig.pose, p, w, h));
    if (P.some((p) => !p)) { el.hidden = true; return; }
    el.hidden = false;
    el.style.clipPath = `polygon(${P.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(", ")})`;
    const grey = (g) => { const v = Math.round((255 * g) / (1 + g)); return `rgb(${v}, ${v}, ${v})`; };   // color-dodge x (1 + g)
    if (!band) { el.style.background = grey(flat); return; }
    // the band from the display's device pixels (GL origin, y up) to this layer's CSS pixels (y down)
    const dpr = this.engine.dpr || 1, ax = band.axis[0], ay = -band.axis[1];
    const centre = (band.s - (this.engine.height || h * dpr) * band.axis[1]) / dpr, half = band.half / dpr;
    const phi = Math.atan2(ax, -ay), L = Math.abs(w * Math.sin(phi)) + Math.abs(h * Math.cos(phi));
    const start = (w / 2) * ax + (h / 2) * ay - L / 2;
    const at = (s) => `${(((s - start) / L) * 100).toFixed(2)}%`;
    const stops = [`${grey(flat)} 0%`];
    for (let k = -2.5; k <= 2.5001; k += 0.5) stops.push(`${grey(flat + S.gains.glint * Math.exp(-k * k))} ${at(centre + k * half)}`);
    stops.push(`${grey(flat)} 100%`);
    el.style.background = `linear-gradient(${((phi * 180) / Math.PI).toFixed(2)}deg, ${stops.join(", ")})`;
  }

  // Where the 3D starts: the photograph's own camera and crop when we know them, else the spot's framing; if
  // that crop cuts a must-see object by more than 5 %, ease to the framing 0.8 s later over 1.2 s.
  bootPose() {
    // /#about boots at the desk's pose (the photograph is the desk's) and leans to the notebook later
    const name = this.spot === "notebook" ? "desk" : this.spot;
    this.rig.jumpTo(name);
    const ph = this.photoNow();
    if (!ph || name === "window") return;
    const crop = cropPose(ph.camera, ph.size, ph.geo, { w: this.size()[0], h: this.size()[1] });
    this.bootCrop = name !== "laptop";   // the 3D starts on the photograph: it hands over by itself (handover3d)
    this.rig.rest = crop;
    this.rig.pose = crop;
    this.rig.emit();
    const [w, h] = this.size();
    const rep = mustSeeReport(this.room, name, crop, { w, h, reserve: this.reserveFor(name) });
    // the photograph retires during that ease (the canvas shows): the move is the handover. The spot's own framing
    // may also look elsewhere at this screen shape (the desk turns to show the lamp): that eases there too
    // the Projects document: the room takes over from the page's photograph, then leans in to the laptop
    if (name === "laptop") { this.arriveLaptop(); return; }
    const turns = Math.abs(this.rig.restPose(name).yaw - crop.yaw) > 1;
    // (handover-r1: after the handover's crossfade, handover3d(), no longer 0.8 s after boot with the reveal on it)
    if ((rep.cut > 0.05 || turns) && !reducedQ.matches && this.spot === name) this.bootEase = () => { if (this.rig.spot === name && this.rig.state === "rest" && !this.rig.moving && this.spot === name) { this.reveal(); this.rig.rest = this.rig.restPose(name); this.rig.easeTo(clonePose(this.rig.rest), 1200); this.fitHomeCard(); } };
  }

  // The photograph on screen now: its scene.json view, its render size, its layout, and the camera that took it.
  photoNow() {
    const ph = this.doc === "home" ? this.o.photo?.() : this.o.page?.photo?.() || this.projPhoto?.();
    if (!ph || !ph.geo || !ph.size) return null;
    const camera = this.room.photoCamera(ph.view, ph.size);
    return camera ? { ...ph, camera } : null;
  }

  // The Projects page's photograph of the laptop, laid out in its room element as the page's app lays it out
  // (shared/room.js layoutView with shared/pages.js PAGES.projects), so the room's first frame is that photograph.
  async projectsPhoto() {
    const roomEl = this.hero.querySelector(".laptop-room");
    if (!roomEl) return;
    const [{ loadScene }, { PAGES }, { layoutView }] = await Promise.all([import("./sky.js"), import("./pages.js"), import("./room.js")]);
    const view = (await loadScene())?.views?.projects;
    if (!view) return;
    this.projPhoto = () => {
      const box = { w: roomEl.clientWidth, h: roomEl.clientHeight };
      return box.w && box.h ? { view: "projects", size: [view.width, view.height], geo: layoutView(view, box, PAGES.projects.opts) } : null;
    };
  }

  reveal() {
    if (!this.live || this.live.revealed) return;
    this.live.revealed = true;
    this.live.canvas.classList.add("is-on");
    this.screenShown(true);
  }
  canvasOff() { if (this.live) { this.live.canvas.classList.remove("is-on"); this.live.revealed = false; this.screenShown(false); } }

  // A lost WebGL context: the photograph for the current spot (the page's own at a page spot, the desk's at the
  // desk, window and notebook), its overlays back on that photograph; the room comes back when the context does.
  contextLost(lost) {
    document.documentElement.classList.toggle("sfw-3d-off", lost);
    this.o.parallax?.(!lost);   // the photograph moves with the pointer again while it is what is shown (handover-r1)
    const own = this.doc === "projects" && this.handedOver ? this.hero.querySelector(".projects-home .screen") : null;
    if (own) { own.style.visibility = lost ? "" : "hidden"; own.style.opacity = lost ? "" : "0"; own.inert = !lost; }
    if (lost) {
      this.canvasOff();
      this.anchored = this.overlays.items.slice();
      this.overlays.clear();
      // the desk's print goes back onto the desk's photograph
      const pr = this.o.print?.();
      if (pr?.liveAnchored && pr.home) { pr.liveAnchored = false; pr.home.appendChild(pr.el); this.live.printAnchored = false; this.o.relayout?.(); }
    } else {
      for (const it of this.anchored || []) if (it.el !== this.o.print?.()?.el) this.overlays.add(it);
      this.anchored = null;
      if (this.spot === "desk") this.deskPrint(true);
      if (this.rig?.pose) this.applyPose(this.rig.pose);
    }
  }

  toPhoto() {
    // the engine gave up: back to the photographs for the current spot (plan 1.4), the words back below the window
    if (this.cardMode) {
      this.cardMode = false;
      this.cardOpen = false;
      this.placeAbout("flow");
      if (this.spot === BIO_SPOT) this.aboutCard(true);
      this.updateScrollMode();
    }
    this.contextLost(true);
    this.live?.gestures?.destroy();
    this.live?.links?.destroy();
    document.documentElement.classList.remove("sfw-live-mode", "sfw-quiet");
    clearInterval(this.lampTimer);
    this.mode = reducedQ.matches ? "still" : "photo";
  }

  // Parts of the screen the spot's must-see objects stay clear of: the masthead, and a card (cardOnly: the card).
  reserveFor(name, { cardOnly = false } = {}) {
    const [w, h] = this.size ? this.size() : [innerWidth, innerHeight];
    const m = document.querySelector(".masthead");
    const mh = m ? m.getBoundingClientRect().height : 96;
    const wide = w > 760 && w / h > 1.1;
    const r = cardOnly ? {} : { bottom: mh + 8 };
    if (name === "shelf" && wide) r.left = Math.min(560, Math.max(340, w * 0.36));   // the book card (pages.js cardColumn)
    // the About card (CSS above: min(520px, 38vw) wide, max(2.2vw, 16px) from the right; phones: the bottom 56 %)
    // (the notebook kept room for the About card beside it until interactions B: the bio lives on the name now)
    if (name === "window" && !cardOnly) r.bottom = mh + 16;
    // (the homepage's card at the desk is closed at rest, so the desk keeps no room for it: the framing stays the
    // first paint's. Opened by the name it is a top sheet on phones, over the sky; on wider screens it sits in the
    // top right corner, its height stopping above the desk's must-see objects, fitHomeCard)
    return r;
  }

  // An orbit stops where it would slide the spot's must-see objects under its card (plan 4.1: "the limits keep
  // the shelf from sliding under the book card"). Every spot with a card (the shelf, the notebook) does this
  // unless its data says orbit.clearOfCard: false.
  clearOfCard(name, pose, rest) {
    if (this.room.spots[name]?.orbit?.clearOfCard === false) return true;
    const reserve = this.reserveFor(name, { cardOnly: true });
    if (!reserve.left && !reserve.right && !reserve.bottom) return true;
    const [w, h] = this.size();
    const under = (p) => underReserve(this.room, name, p, { w, h, reserve });
    return under(pose) <= Math.max(0.02, under(rest) + 0.01);
  }

  // Keyboard focus on a page item the orbit has left more than half under its card: back to rest (as the
  // room's own links do when an orbit has pushed them off screen, plan 7).
  onFocusIn(e) {
    const h = this.page?.handle || this.o.page?.handle;
    if (!h?.card || !this.rig || this.rig.state !== "orbit" || !h.items?.includes(e.target)) return;
    if (e.target.matches(":focus-visible") && this.overlays.fractionUnder(h.card, e.target) > 0.5) this.rig.resetOrbit(reducedQ.matches ? 0 : 600);
  }

  applyPose(pose) {
    if (!this.engine) return;
    const [w, h] = this.size();
    this.engine.camera.set(toEngineCamera(pose, w / h));
    // which objects are offered is settled at rest (a move never hides a link that may have focus)
    // (judged at the spot's rest pose: an orbit never takes a link away; focusing one eases back instead)
    if (!this.rig.moving && this.landedAt === this.spot && this.rig.rest) {
      this.live.links?.setSpot(this.spot, this.rig.rest, w, h);
      const ph = this.page?.handle || this.o.page?.handle;
      if (ph?.card) requestAnimationFrame(() => this.overlays.inertUnder(ph.card, ph.items || []));
    }
    this.live.links?.update(pose, w, h);
    this.overlays.update(pose, w, h);
    this.laptop?.place(pose, w, h, { still: !this.rig.moving });
    this.placeDesk(pose, w, h);
    fitEdges(this.live.edges, this.room, pose, w, h);   // the phone's edge tabs clear of the window
  }

  // ---------- interactions B: the notebook, the phone, the headphones, the breadboard ----------
  // Every frame the camera (or the notebook's cover) moves: the index on the page, the lock screen on the phone, the LED.
  placeDesk(pose = this.rig?.pose, w, h) {
    if (!pose || !this.size) return;
    if (w === undefined) [w, h] = this.size();
    const ix = this.nbIndex;
    if (ix?.shown) {
      // the cover, while it is over the page (closed to about 150 degrees), hides that part of the page
      const st = this.nb3d?.state;
      const cut = st && Math.abs(st.angle) < 150 ? [this.nb3d.coverCorners()] : [];
      ix.place(pose, w, h, { cut });
    }
    this.phone?.place(pose, w, h, { still: !this.rig.moving });
    if (this.board?.blinking) this.board.place(pose, w, h);
  }

  // The reading sheet (shared/reader.js, with its stylesheet), made once: for a title on the notebook's page, the
  // phone's notification and the /writing/<slug> addresses.
  startReader() {
    return (this.readerP ??= (async () => {
      if (!document.querySelector('link[href="/shared/reader.css"]')) {
        const l = el("link", { rel: "stylesheet", href: "/shared/reader.css" });
        document.head.appendChild(l);
        await new Promise((r) => { l.onload = r; l.onerror = r; setTimeout(r, 1500); });
      }
      const { Reader } = await import("./reader.js");
      const r = new Reader({ home: "/writing/" });
      this.reader = r;
      document.addEventListener("reader:open", (e) => this.onReader(true, e.detail?.slug));
      document.addEventListener("reader:closed", () => this.onReader(false));
      return r;
    })());
  }

  // A sheet lifted from the page: the page's ink goes with it, and comes back when the sheet settles into the page.
  onReader(open, slug = null) {
    const r = this.reader;
    const own = !!slug && !!r?.pages.has(slug);   // About, Social, Projects: no page of the notebook's goes with them
    if (open && r && !own) r.o.home = this.spot === "notebook" ? "/writing/" : "/";
    this.nbReading = open && !own && this.spot === "notebook";
    this.inkTo();
  }

  // The page's rectangle on screen (for a sheet's lift and its return), in the page's coordinates.
  pageRect() {
    if (!this.nbIndex || !this.rig?.pose || this.spot !== "notebook" || this.rig.spot !== "notebook" || this.rig.glide) return null;
    const [w, h] = this.size(), r = this.nbIndex.rect(this.rig.pose, w, h), c = this.live.canvas.getBoundingClientRect();
    return r && { left: c.left + r.left, top: c.top + r.top, width: r.width, height: r.height };
  }

  startDesk() {
    if (this.doc !== "home" || !this.mods) return;
    const { nbm, phm, toys } = this.mods;
    const reduced = () => reducedQ.matches;
    this.startReader().then((reader) => {
      if (!this.live) return;
      if (nbm && this.nb3d && this.room.objects.notebook_page) {
        this.nbIndex = new nbm.NotebookIndex({
          parent: this.hero, room: this.room, reader, reduced, pages: this.nb3d.pages,
          onTitle: (slug) => { this.reader.open(slug, () => this.pageRect()); },
        });
        // after the room's links in the tab order (they are hidden at the notebook), before the masthead
        const after = this.laptop?.host?.parentNode === this.hero ? this.laptop.host : this.live.links?.svg;
        if (after?.parentNode === this.hero) after.after(this.nbIndex.el);
        this.nbIndex.ready.then(() => { this.layoutDesk(); if (this.landedAt === "notebook" && this.rig.spot === "notebook") this.notebookIn(true); });
        this.nb3d.onChange(() => { this.inkTo(); this.placeDesk(); });
        // the page turn's sound (shared/sound.js), only while Sound is on: as a leaf lifts (a press on a corner, a tap, a
        // key) the paper's lift, sweep and settling, over a turn by itself's 0.72 s (pageturn.js AUTO_MS); its landing
        // or falling back plays nothing, it only tells the sound the turn was heard (no second page at a slow drag's end)
        this.turnSoundOff?.();
        this.turnSoundOff = this.nb3d.pages?.onTurn((e) => { if (soundState() === "on") pageTurn({ type: e.type, dir: e.dir, dur: 0.72 }); }) || null;
        // a deep-linked sheet: it returns into the page once the room has leaned in (afterLanding sets its origin)
      }
      if (phm && this.room.objects.phone_screen?.quad) {
        this.phone = new phm.PhoneScreen({
          parent: this.hero, quad: this.room.objects.phone_screen.quad, reader, reduced, label: this.room.spots.phone?.label || "",
          timeOf: () => this.mast?.getMoment().date || new Date(),
          onEssay: (slug, from) => { this.reader.open(slug, from); },
          // live room 2: the lock screen's flashlight is the desk lamp's own switch (a click on the lamp: its fade, and
          // the visitor's choice for the visit); its glyph follows the lamp, the dusk rule's too
          torch: this.interact ? { on: () => (this.engine?.light?.lamp || 0) > 0, toggle: () => this.interact?.toggleLamp() } : null,
          // phone round 2: always on, from every spot: furniture in front of the screen cuts it (the laptop's rule)
          occluders: (this.room.obstacles || []).filter((o) => o.box && !["desk", "phone"].includes(o.name)),
        });
        this.phone.setShown(true);
        this.engine?.on?.("lightchange", (e) => this.phone?.setTorch((e?.light?.lamp || 0) > 0));
        const after = this.nbIndex?.el || this.laptop?.host;
        if (after?.parentNode === this.hero) after.after(this.phone.el);
        this.mast?.onMoment(() => this.phone?.tick());
        this.layoutDesk();
        if (this.landedAt === "phone" && this.rig.spot === "phone") this.phoneIn();
      }
      this.applyPose(this.rig.pose);
    }).catch((err) => console.warn("[desk]", err && err.message));
    if (toys) {
      const led = this.room.objects.breadboard_led?.point;
      if (led) this.board = new toys.Board({ parent: this.hero, point: led });
      this.eggObj = new toys.Egg(null, { reduced });
    }
  }

  // Landed at the phone (phone round 2): awake, its own (pointer and keys), and unlocked: the lock screen swipes up to
  // his apps, a click on the phone and Social alike.
  phoneIn() {
    if (!this.phone) return;
    this.phone.wake();
    this.phone.setActive(true);
    this.phone.unlock();
  }

  // The layout boxes: the page and the screen at their spots' rest poses for this screen.
  layoutDesk() {
    const [w, h] = this.size();
    if (this.nbIndex) { const p = this.nbFrame(); if (p) this.nbIndex.layout(p, w, h); }
    if (this.phone) { const p = this.phoneFrame(); if (p) this.phone.layout(p, w, h); }
  }

  // Leaning in to the notebook or the phone (both looked down on from close by), the look turns toward the point the rest
  // pose looks through as the camera comes, never past it (rig.js makeGlide's aim)
  aimFor(name) {
    const p = name === "notebook" ? this.nbFrame() : name === "phone" ? this.phoneFrame() : null;
    if (!p) return null;
    const q = name === "notebook" ? this.room.objects[innerWidth / innerHeight < 1 ? "notebook_page" : "notebook_spread"]?.quad : this.room.objects.phone_screen?.quad;
    return q ? q.reduce((s, x) => [s[0] + x[0] / q.length, s[1] + x[1] / q.length, s[2] + x[2] / q.length], [0, 0, 0]) : null;
  }

  // The close-up textures (engine hiTier, room3d.json "hi"): a spot's list when a glide to it starts, or when the rig
  // lands there by a cut (reduced motion); the desk's once the wheel has zoomed in past its share of the range. Never
  // at boot (the desk has no list), so a visitor who never leans in fetches nothing more.
  wantHi(spot) {
    const t = this.engine?.hiTier;
    if (!t || !spot) return;
    const [w, h] = this.size ? this.size() : [innerWidth, innerHeight];
    t.forSpot(spot, { portrait: w / h < 1 });
  }
  wantHiZoom() {
    const t = this.engine?.hiTier, r = this.rig;
    if (!t || !r?.spot || !(r.dolly > 0) || this.hiZoomAsked?.[r.spot]) return;
    const z = t.zoomRule(r.spot);
    if (!z || Math.abs(r.dolly - (this.hiZoomAt ?? -1)) < 0.03) return;
    this.hiZoomAt = r.dolly;
    const hi = r.zoomLimits()[1];
    if (hi > 0 && r.dolly >= z.from * hi) {
      (this.hiZoomAsked ||= {})[r.spot] = true;
      const [w, h] = this.size ? this.size() : [innerWidth, innerHeight];
      t.forZoom(r.spot, { portrait: w / h < 1 });
    }
  }

  // A tap or click on the room: leaned in to the laptop, a click on the room around it leans back; else what is
  // under it is picked
  onTap(x, y, e) {
    if (e.target.closest?.("a, button, .sfw-links")) return;
    if (this.spot === "laptop" && this.landedAt === "laptop" && !this.rig.glide) { this.backToDesk(); return; }
    this.live.picker.click(x, y);
  }

  // The mouse's sway of the view outside (the pointer's place on the screen, -1..1); magnified, it is as much smaller as
  // the lens is narrower (kept so while the magnification eases, so the view never jumps at the next mouse move)
  // (handover-r1: held at rest through the boot's handover, swayHold; swaySettle eases it in with e from 0 to 1)
  sway(e = null) {
    if (e === null && this.swayHold) return;
    const [x, y] = this.swayAt, k = (this.rig.mag > 1 ? 1 / this.rig.mag : 1) * (e ?? 1);
    this.engine.camera.setSway?.(x * 0.012 * k, -y * 0.006 * k);
  }

  // ---------- v3/zoom: the window's magnifier (binoculars) ----------
  // How far the window magnifies on this device (1: not at all, and never anywhere else): 4x on desktops; on phones
  // from what the device says and what it has shown (navigator.deviceMemory, the GPU's largest texture, the frame
  // intervals of the glides so far): about 2x on weak phones, 3x, and 4x on strong ones.
  magCap(name) {
    if (name !== "window" || this.mode !== "live") return 1;
    if (MAG_PIN) return MAG_PIN;
    if (this.zoomCapV) return this.zoomCapV;
    const tier = this.engine?.settings?.tier;
    if (tier !== "T1") return (this.zoomCapV = MAG_DESKTOP);
    const gl = this.engine.gl, maxTex = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 4096, dm = navigator.deviceMemory;
    const d = (this.movingDts || []).filter((x) => x > 0 && x < 250).sort((a, b) => a - b);
    const med = d.length >= 20 ? d[d.length >> 1] : null, p90 = d.length >= 20 ? d[Math.floor(d.length * 0.9)] : null;
    let cap = 3;
    if ((dm && dm < 4) || maxTex < 8192 || (med !== null && med > 24)) cap = 2;
    else if ((!dm || dm >= 6) && maxTex >= 16384 && med !== null && med <= 18 && p90 <= 26) cap = 4;
    this.zoomCapWhy = { tier, deviceMemory: dm ?? null, maxTexture: maxTex, medianMs: med, p90Ms: p90, cap };
    if (med !== null) this.zoomCapV = cap;      // (settled once the glides have been measured)
    return cap;
  }
  // The magnifier's code (tiles, the sharper level's program), the first time someone magnifies: nothing of it at load.
  loadZoom() {
    if (this.zoomMod || !this.outside || this.mode !== "live") return this.zoomMod || null;
    this.zoomMod = import("./zoom.js").then((m) => m.attachMagnifier(this)).catch((e) => { console.warn("[zoom]", e.message); return null; });
    return this.zoomMod;
  }
  // Landed at the window: half a second later (still there, the 3D live), the magnifier's code and index come and its
  // program is compiled and drawn once while the view is still, so the first zoom does not stall on it. No tile; not
  // with Save-Data or on a 2g/3g connection (then all of it waits for the first magnification).
  zoomWarm() {
    if (this.mode !== "live" || MAG_PIN === 1 || this.zoomWarmT) return;
    const c = navigator.connection;
    if (c && (c.saveData || /(^|-)(2g|3g)$/.test(c.effectiveType || ""))) return;
    this.zoomWarmT = setTimeout(() => {
      this.zoomWarmT = null;
      if (this.spot === "window" && this.landedAt === "window" && this.mode === "live") this.loadZoom()?.then((z) => z?.warm());
    }, 500);
  }
  // A zoom at the window: the tiles under the pointer (or the fingers) are fetched as the gesture starts.
  zoomStart(at) {
    if (!this.rig.magnified) return;
    this.loadZoom()?.then((z) => z?.gesture(at));
  }

  // a point the desk's rest pose looks through, 3 m out along its look
  deskAim() {
    const p = this.rig?.restPose("desk");
    return p ? add(p.eye, mul(dirOf(p.yaw, p.pitch), 3)) : null;
  }

  // The notebook spot's rest pose: looking down at the open notebook from its tail (the spine on the left), the open
  // spread (wide screens) or its first page (phones) filling the free part of the screen.
  nbFrame() {
    const [w, h] = this.size ? this.size() : [innerWidth, innerHeight];
    if (!this.nbLean || this.nbLean.w !== w || this.nbLean.h !== h) {
      const O = this.room.objects, cv = O.notebook_cover;
      let pose = null;
      if (this.nb3d && cv?.axis && O.notebook_spread && O.notebook_page) {
        const Y = normalize(cv.axis), k = (NB_PITCH * Math.PI) / 180;
        const forward = normalize(add(mul(Y, Math.cos(k)), [0, -Math.sin(k), 0]));
        const a = w / h, portrait = a < 1;
        let tanV = 18 / 35 / (16 / 9);
        if (portrait) tanV = Math.max(tanV, 0.3 / a);
        const m = document.querySelector(".masthead"), mh = m ? m.getBoundingClientRect().height : 96;
        pose = fitPose({ points: portrait ? O.notebook_page.quad : O.notebook_spread.quad, forward, tanV, w, h, top: 64, bottom: mh + 14, fill: portrait ? 0.9 : 0.86, fillH: 0.94 });
      }
      this.nbLean = { w, h, pose };
    }
    return this.nbLean.pose ? clonePose(this.nbLean.pose) : null;
  }

  phoneFrame() {
    const [w, h] = this.size ? this.size() : [innerWidth, innerHeight];
    if (!this.phLean || this.phLean.w !== w || this.phLean.h !== h) {
      const q = this.room.objects.phone_screen?.quad, m = document.querySelector(".masthead"), mh = m ? m.getBoundingClientRect().height : 96;
      this.phLean = { w, h, pose: q && this.mods?.phm ? this.mods.phm.phonePose(q, w, h, { top: 64, bottom: mh + 14 }) : null };
    }
    return this.phLean.pose ? clonePose(this.phLean.pose) : null;
  }

  // The page's ink: it comes as the cover clears the page (100-160 degrees open) and goes while a sheet is lifted out.
  inkTo() {
    const ix = this.nbIndex, st = this.nb3d?.state;
    if (!ix || !st) return;
    const open = Math.min(1, Math.max(0, (Math.abs(st.angle) - 100) / 60));
    const v = this.nbReading ? 0 : open * open * (3 - 2 * open);
    if (v > 0 || st.cover > 0) ix.setShown(true);
    else if (!st.open) ix.setShown(false);
    ix.setInk(v, this.nbReading !== this.inkReading ? (this.nbReading ? 200 : 320) : 0);
    this.inkReading = this.nbReading;
  }

  // Leaning in to the notebook (on landing): the cover opens; leaving: it closes.
  notebookIn(on) {
    if (!this.nb3d || !this.nbIndex) return;
    if (on) {
      this.nb3d.open();
      this.nbIndex.setActive(true);
      this.nbIndex.setShown(true);
      this.inkTo();
      this.reader?.setOrigin(() => this.pageRect());
      if (this.reader) this.reader.o.home = "/writing/";   // (a sheet deep-linked at boot closes to the notebook's address)
    } else {
      this.nbIndex.setActive(false);
      this.nb3d.close();
    }
  }

  // The headphones: lean to the laptop (a history entry on this address, like the window) and play the video there (or,
  // when the embed cannot play, its thumbnail as a link to it: toys.js). Phones, or no live room: the official video in
  // a new tab (a real gesture).
  egg() {
    const url = ACTIONS.headphones.url;
    const phone = coarseQ.matches || innerWidth <= 640;
    if (phone || this.mode !== "live" || !this.laptop?.scr || !this.eggObj) {
      window.open(url, "_blank", "noopener");
      return;
    }
    this.eggObj.laptop = this.laptop;
    this.eggWanted = true;
    if (this.spot === "laptop") { this.eggObj.start(); return; }
    history.pushState({ sfw: 1, spot: "laptop", egg: 1 }, "", location.href);
    this.pushedHere = true;
    this.pushedFrom = this.spot;
    this.liveGo("laptop", false);
    // the frame loads in the second half of the lean-in, so the video comes onto the screen as the camera arrives
    clearTimeout(this.eggT);
    this.eggT = setTimeout(() => { if (this.spot === "laptop" && this.eggWanted) this.eggObj.start(); }, reducedQ.matches ? 0 : LEAN_S * 550);
  }

  // The breadboard: the LED blinks three times where it is (if it is in view from here), the buzzer chirps with Sound on.
  async blinkBoard() {
    if (!this.board || this.mode !== "live" || this.board.blinking) return;
    const [w, h] = this.size(), s = this.board.place(this.rig.pose, w, h);
    let visible = false;
    if (s && s[0] >= 0 && s[1] >= 0 && s[0] <= w && s[1] <= h) {
      for (const [dx, dy] of [[0, 0], [0, -1.5], [1.5, 0], [-1.5, 0]]) {
        const hit = await this.engine.pick(s[0] + dx, s[1] + dy).catch(() => null);
        if (hit?.object === "breadboard") { visible = true; break; }
      }
    }
    this.reveal();
    this.board.blink({ visible });
  }

  registerSpots() {
    if (!this.engine?.registerSpots) return;
    const [w, h] = this.size();
    const out = {};
    for (const name of Object.keys(this.room.spots)) {
      const c = toEngineCamera(this.rig.restPose(name), w / h);
      out[name] = { position: c.position, target: c.target, fovY: c.fovY, shift: c.shift, focus: c.focus || undefined };
    }
    this.engine.registerSpots(out);
  }

  onResize() {
    if (!this.rig) return;
    this.lean = null;
    this.nbLean = null;
    this.phLean = null;
    this.layoutScreen();
    this.layoutDesk?.();
    this.registerSpots();
    this.rig.reframe();
    if (this.page?.handle?.card) this.overlays.inertUnder(this.page.handle.card, this.page.handle.items || []);
    this.fitHomeCard();
  }

  // ---------- the laptop: a computer you use ----------
  // The laptop spot's rest pose for this screen (shared/laptop.js leanPose): the screen square on, filling most of
  // the view, clear of "Back to the desk" (top) and the masthead (bottom).
  leanFrame() {
    const [w, h] = this.size ? this.size() : [innerWidth, innerHeight];
    if (!this.lean || this.lean.w !== w || this.lean.h !== h) {
      const m = document.querySelector(".masthead");
      const mh = m ? m.getBoundingClientRect().height : 96;
      this.lean = { w, h, pose: leanPose(this.room, w, h, { top: 56, bottom: mh + 12 }) };
    }
    return this.lean.pose ? clonePose(this.lean.pose) : null;
  }

  // The Projects page on the laptop's screen (projects/screen.js), placed on the 3D screen every frame. It shows
  // what it showed before during this visit (any of the site's documents), or on the Projects document, the page's
  // own state as the room takes over (arriveLaptop).
  startScreen() {
    if (!this.room.objects?.screen?.quad || !this.room.spots.laptop || this.laptop) return;
    this.laptop = new LaptopScreen(this.room, {
      parent: this.hero,
      after: () => this.live?.links?.svg || this.hero.querySelector(".laptop-room"),
      reduced: () => reducedQ.matches,
      onRoute: (slug, { push }) => this.screenRouted(slug, push),
      sheet: () => this.startReader(),   // (nav-r1 item 9: phones open the page itself in the room's reading sheet)
    });
    this.laptop.ready.then((ls) => {
      if (!this.live) return;
      // in the tab order after the room's links, before the masthead and the cards
      const after = this.live.links?.svg || this.hero.querySelector(".laptop-room");
      if (after?.parentNode === this.hero && after.nextElementSibling !== ls.host) after.after(ls.host);   // (a move reloads the page's frame)
      if (this.doc !== "projects") { try { ls.scr.restore(JSON.parse(sessionStorage.getItem(SCREEN_KEY) || "null")); } catch { /* storage blocked */ } }
      const scheme = () => ls.scr.setScheme(document.documentElement.dataset.scheme || null);
      scheme();
      new MutationObserver(scheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme"] });
      addEventListener("pagehide", () => this.saveScreen());
      this.layoutScreen();
      this.screenShown(this.live.revealed);
      if (this.landedAt === "laptop") this.screenActive(true);
      if (this.rig?.pose) this.applyPose(this.rig.pose);
    }).catch((err) => { if (params.has("debug")) console.warn("laptop screen:", err && err.message); this.laptop?.host?.remove(); this.laptop = null; });
  }

  layoutScreen() {
    if (!this.laptop?.scr || !this.size) return;
    const [w, h] = this.size();
    const lean = this.leanFrame();
    // (nav-r1: the frame is laid out at a laptop browser's 1440 px and scaled; the page keeps its own type, so the old
    // rule that sized the screen's type from the Projects document's own screen is gone)
    if (lean) this.laptop.layout(lean, w, h);
  }

  // The page shows with the room (the canvas): over the photograph it would be a second picture of the screen.
  screenShown(on) {
    const ls = this.laptop;
    if (!ls?.host) return;
    ls.setShown(on);
    ls.host.classList.toggle("is-in", on);
    if (on && this.rig?.pose) this.applyPose(this.rig.pose);
  }

  screenActive(on) {
    this.laptop?.setActive(on);
    this.saveScreen();
  }

  screenURL() {
    const slug = this.laptop?.scr?.route;
    return this.laptop?.mod ? this.laptop.mod.projectURL(slug) : this.room.spots.laptop.url;
  }

  // A link on the screen opened a project (or the list): its address, as the page's own links do (a history entry).
  screenRouted(slug, push) {
    this.saveScreen();
    if (this.spot !== "laptop") return;
    if (push) { history.pushState({ sfw: 1, spot: "laptop" }, "", this.screenURL()); this.pushedHere = true; this.pushedFrom = "laptop"; }
    document.title = this.laptop.mod.titleOf(slug);
    this.overlays.landed(this.laptop.scr.heading());
  }

  saveScreen() {
    const st = this.laptop?.scr?.state();
    if (!st) return;
    try { sessionStorage.setItem(SCREEN_KEY, JSON.stringify(st)); } catch { /* storage blocked */ }
  }

  // The Projects document opened directly (a shared /projects/ or project link): its first paint is the page's
  // photograph of the laptop with the list on its screen, and the room's first frame is that photograph. Then the
  // room leans in to the laptop with the same glide as from the desk; a shared project opens on the screen as the
  // glide starts, the way a click on the list opens it.
  async arriveLaptop() {
    const ls = this.laptop;
    if (!ls) return;
    try { await ls.ready; } catch { return; }
    // the room's first frames upload and stream (the outside's tiles): the lean-in starts once it draws steadily
    // (at most 3 s), so a stall can never show as a jump in the glide
    const t0 = performance.now();
    while (!reducedQ.matches && performance.now() - t0 < 3000 && !(this.engine?.state === "settled" && !this.outside?.store?.busy)) await wait(100);
    await wait(reducedQ.matches ? 0 : 400);
    if (!ls.scr || this.rig.spot !== "laptop" || this.rig.glide || this.rig.state !== "rest") return;
    this.layoutScreen();
    // (whether the page's photograph has its live screen on it: then the hand-over is exact and the project opens
    // as the lean-in goes; without it, phones, the one dissolve of the hand-over goes straight to the project)
    const exact = !!this.hero.querySelector(".projects-home .screen.is-set");
    this.handover();
    const slug = window.__sfwProject || null;
    window.__sfwProject = null;
    // the shared project opens on the screen halfway through the lean-in, with the page's own fade (as a click does)
    const open = () => {
      if (!slug || this.spot !== "laptop") return;
      ls.scr.show(slug);
      history.replaceState({ sfw: 1, spot: "laptop" }, "", this.screenURL());
      document.title = ls.mod.titleOf(ls.scr.route);
      this.saveScreen();
    };
    if (reducedQ.matches) { open(); this.rig.jumpTo("laptop"); this.afterLanding("laptop"); return; }
    if (slug && !exact) open();
    const glide = this.rig.glideTo("laptop", { duration: LEAN_S, keepFocus: true });
    if (slug && exact) setTimeout(open, LEAN_S * 500);
    const r = await glide;
    if (r.landed && this.spot === "laptop") this.afterLanding("laptop");
  }

  // The page's own screen (over its photograph) hands over to the room's: for the first 300 ms of the lean-in it
  // follows the live camera on the same quad and fades out while the room's fades in, with its scroll position.
  handover() {
    if (this.handedOver || this.doc !== "projects") return;
    this.handedOver = true;
    const own = this.hero.querySelector(".projects-home .screen");
    const sc = this.laptop?.scr;
    // where the page's photograph has only its rendered picture of a screen (phones: the list is below the room),
    // the live page dissolves in over the first part of the lean-in instead of the room's 150 ms
    const host = this.laptop?.host;
    if (host && !own?.classList.contains("is-set") && !reducedQ.matches) {
      host.style.transition = "opacity 450ms ease";
      setTimeout(() => { host.style.transition = ""; }, 500);
    }
    this.reveal();
    if (!own || !sc) return;
    const ss = own.querySelector(".screen-scroll");
    if (ss && ss.scrollHeight > ss.clientHeight) {
      const k = ss.scrollTop / Math.max(1, ss.scrollHeight - ss.clientHeight);
      requestAnimationFrame(() => { sc.scroller.scrollTop = k * Math.max(0, sc.scroller.scrollHeight - sc.scroller.clientHeight); });
    }
    const colour = getComputedStyle(own).getPropertyValue("--screen").trim();
    if (colour) sc.setColour(colour);
    const w = parseFloat(own.style.width), h = parseFloat(own.style.height);
    if (!own.classList.contains("is-set") || !w || !h || reducedQ.matches) { own.style.visibility = "hidden"; own.inert = true; return; }
    const off = this.overlays.add({ el: own, quad: () => this.room.objects.screen.quad, size: () => [w, h] });
    this.overlays.update(this.rig.pose, ...this.size());
    own.style.transition = "opacity 300ms ease";
    own.style.opacity = "0";
    own.inert = true;
    setTimeout(() => { off(); own.style.visibility = "hidden"; }, 320);
  }

  // ---------- the menu's About and Social (nav-r1, Akshay 17 Oct) ----------
  // About opens his bio (the homepage's #about, word for word) in the reading sheet, over the room wherever the
  // visitor is; closing returns exactly there. At the desk its address is /#about (a direct link opens it), elsewhere
  // the sheet is a history entry on the spot's own address. Social leans in to the phone and wakes it (its lock screen
  // has his five links), the same glide as a click on the phone; without the live room his five links show in a small
  // sheet. On a page document (Books, Quotes, Projects loaded directly) the words are read from the homepage, and
  // Social in the live room glides to the desk and loads /#social there, which goes on to the phone.
  onMenu(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.("a[href]");
    if (!a || a.target === "_blank" || a.closest(".rd")) return;
    const u = new URL(a.href, location.href);
    if (u.origin !== location.origin || norm(u.pathname) !== "/") return;
    if (u.hash === "#about") { e.preventDefault(); this.openAbout().catch(() => {}); }
    else if (u.hash === "#social") { e.preventDefault(); this.social(); }
  }

  // one of the homepage's blocks (#about, #social): this document's own, or the homepage's HTML read once
  homeBlock(id) {
    const here = this.doc === "home" ? document.getElementById(id) : null;
    if (here) return Promise.resolve(here);
    this.homeHTML ??= fetch("/").then((r) => (r.ok ? r.text() : "")).then((t) => new DOMParser().parseFromString(t, "text/html")).catch(() => null);
    return this.homeHTML.then((d) => d?.getElementById(id) || null);
  }

  // the address while a sheet of the menu's is open (the desk's: /#about, /#social) and after a fresh one closes
  menuURL(hash) {
    const desk = this.doc === "home" && norm(location.pathname) === "/" && (!this.spot || this.spot === "desk");
    return desk ? location.pathname + location.search + hash : location.href;
  }

  async openAbout({ fresh = false } = {}) {
    const [r, bio] = await Promise.all([this.startReader(), this.homeBlock("about")]);
    if (r.isOpen && r.slug === "about") return;
    const col = bio?.querySelector(".col") || bio;
    if (!col) { location.assign("/#about"); return; }
    if (this.cardOpen) this.setCard(false);
    const page = {
      label: "About", kind: "page",
      // his paragraphs as they are (the "here" link opens his Substack in a new tab, as the sheet's links do)
      build: () => {
        const d = el("div", { class: "rd-body rd-bio" });
        for (const p of col.querySelectorAll(":scope > p")) d.appendChild(document.importNode(p, true));
        for (const a of d.querySelectorAll("a[href]")) { a.target = "_blank"; a.rel = "noopener"; }
        return d;
      },
      url: this.menuURL("#about"),
      home: () => location.pathname + location.search,
    };
    await r.open({ slug: "about", page }, null, fresh ? { history: false, deep: true } : {});
  }

  // Social always ends on the phone (Akshay, 17 Oct: "we zoom in to the phone and show the apps ... not this!"): while
  // the room is still starting it waits for it (no time limit), and the small sheet is only for a browser where the
  // room cannot start at all (still mode, no WebGL, Save-Data: `ready` resolves false).
  social() {
    const toPhone = () => {
      // already there (the lock screen pulled down over the apps, say): unlock it again rather than glide in place
      if (this.doc === "home" && this.spot === "phone" && !this.rig?.glide) { this.phoneIn(); return; }
      if (this.doc === "home") { this.go("phone"); return; }
      this.glideThenLoad("desk", new URL("/#social", location.href).href);
    };
    if (this.mode === "live" && this.rig && this.room?.spots.phone) { toPhone(); return; }
    if (this.mode !== "still" && this.room?.spots.phone && this.ready) {
      this.ready.then((live) => (live && this.mode === "live" ? toPhone() : this.openSocial())).catch(() => this.openSocial().catch(() => {}));
      return;
    }
    this.openSocial().catch(() => {});
  }

  // /#social loaded fresh: the live room leans in to the phone once it draws steadily (at most 3 s, as a shared
  // project link waits); without it, the small sheet. The address becomes the desk's, and the phone its own entry.
  async arriveSocial(live) {
    history.replaceState(history.state, "", location.pathname + location.search);
    if (!live || !this.room?.spots.phone) { this.openSocial({ fresh: true }); return; }
    const t0 = performance.now();
    while (!reducedQ.matches && performance.now() - t0 < 3000 && !(this.engine?.state === "settled" && !this.outside?.store?.busy)) await wait(100);
    // the boot's own framing ease may still be gliding: let it land (at most 3 s more), then lean in to the phone
    // (it once stayed at the desk because the ease was still running at 3 s)
    const t1 = performance.now();
    while (this.rig?.glide && performance.now() - t1 < 3000) await wait(100);
    if (this.spot === "desk") this.go("phone");
  }

  async openSocial({ fresh = false } = {}) {
    const [r, links] = await Promise.all([this.startReader(), this.homeBlock("social")]);
    if (r.isOpen && r.slug === "social") return;
    if (!links) { location.assign("/#social"); return; }
    const page = {
      label: "Social", kind: "small",
      // the lock screen's five, in its order, its targets: a new tab, mail in the mail app
      build: () => {
        const row = el("div", { class: "rd-social" });
        for (const a of links.querySelectorAll("a.icon")) {
          const c = document.importNode(a, true);
          c.removeAttribute("class");
          if (!c.getAttribute("href").startsWith("mailto:")) { c.target = "_blank"; c.rel = "noopener"; }
          row.appendChild(c);
        }
        return row;
      },
      url: this.menuURL("#social"),
      home: () => location.pathname + location.search,
      focus: () => r.sheet.querySelector(".rd-social a"),
    };
    await r.open({ slug: "social", page }, null, fresh ? { history: false, deep: true } : {});
  }

  // ---------- going places ----------
  urlOf(name) { return name === "window" ? location.href : new URL(this.room.spots[name].url, location.href).href; }

  // Clicks on links to the room's spots: in the live homepage they glide instead of loading a page.
  onClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("download") || !this.room) return;
    // the reading sheet's and the notebook's own links (/writing/<slug>) are theirs
    if (a.closest(".rd, .sfw-nb")) return;
    const u = new URL(a.href, location.href);
    if (u.origin !== location.origin) return;
    const name = spotForURL(this.room, u.href, null);
    if (!name) return;
    if (this.doc === "home") {
      if (this.mode === "live" || this.mode === "booting") { e.preventDefault(); this.go(name); return; }
      if (name === "notebook") { e.preventDefault(); this.go(name); return; }
      if (name === "desk" && (this.spot === "window" || this.spot === "notebook")) { e.preventDefault(); this.backToDesk(); }
      return;   // photo mode: today's dissolves and page loads
    }
    // a page document: the live room glides first, then the page loads
    if (this.mode === "live" && name !== this.spot && norm(u.pathname) !== norm(location.pathname)) {
      e.preventDefault();
      this.glideThenLoad(name, u.href);
    }
  }

  async go(name, { push = true, zoom = false } = {}) {
    if (!this.room || !this.room.spots[name]) return;
    if (this.mode === "booting") {
      // never wait: 120 ms for the 3D, then today's dissolve (the notebook and the phone are only in the live room:
      // they wait for it, then their pages without it)
      const ok = await Promise.race([this.ready, wait(NEEDS_ROOM.has(name) ? 8000 : NEVER_WAIT).then(() => null)]);
      if (!ok) return this.fallback(name, push, { zoom });
    }
    if (this.mode !== "live") return this.fallback(name, push, { zoom });
    if (this.doc !== "home") return this.glideThenLoad(name, this.urlOf(name));
    return this.liveGo(name, push);
  }

  // Without the 3D (photo and still modes, or the 3D late): the window and the About card in place, the pages
  // through today's zoom-and-dissolve (photo) or a plain load (still).
  async fallback(name, push, { zoom = false } = {}) {
    if (this.doc !== "home") { location.assign(this.urlOf(name)); return; }
    if (name === "window") return this.enterWindow();
    // without the live room: the essays' own page (a clean page of the same writing); the phone has nothing to wake
    if (name === "notebook") { location.assign("/writing/"); return; }
    if (name === "phone") return this.openSocial();   // (his five links in a small sheet: Social without the 3D)
    if (name === "desk") return this.backToDesk();
    const href = this.urlOf(name);
    if (this.mode === "still") { location.assign(href); return; }
    const t = zoom ? await import("./transition.js").catch(() => null) : null;
    const poly = zoom && this.o.hotspotPolygon?.(name);
    if (t && poly) t.zoomTo(poly, href, { stage: this.o.stage });
    else location.assign(href);
  }

  async liveGo(name, push) {
    const from = this.spot;
    // already there, or on the way: nothing new (and the glide under way keeps its landing: a phone's edge tab is a
    // link the document's click handler also takes, so one tap asks twice)
    if (name === from) { if (!this.rig.glide) this.rig.resetOrbit(); return; }
    const seq = ++this.seq;
    const spot = this.room.spots[name];
    // the laptop: without its screen (it failed to load), today's way: glide, then the Projects page
    if (name === "laptop" && !this.laptop?.scr) return this.glideThenLoad(name, this.urlOf(name));
    const url = name === "window" ? location.href : name === "laptop" ? this.screenURL() : spot.url;
    if (push) { history.pushState({ sfw: 1, spot: name }, "", url); this.pushedHere = true; this.pushedFrom = from; }
    this.spot = name;
    this.leaving(from, name);
    // the room is the first screen: a glide from further down the page brings it back into view
    if (scrollY > 0) scrollTo({ top: 0, behavior: reducedQ.matches ? "instant" : "smooth" });
    // the page's HTML, stylesheets and module load while the camera glides; it is attached on landing
    const pageP = PAGE_MODULE[name] ? this.loadPage(name).then((parsed) => this.preparePage(name, parsed)).catch(() => null) : null;
    this.reveal();
    if (reducedQ.matches) {
      // a cut: the new view at once, faded in over 150 ms
      const c = this.live.canvas;
      c.style.transition = "none";
      c.style.opacity = "0";
      this.rig.jumpTo(name);
      void c.offsetWidth;
      c.style.transition = `opacity ${CUT}ms ease`;
      c.style.opacity = "";
      // the laptop's page fades with the room: the two frames cross, nothing jumps
      const sh = this.laptop?.host;
      if (sh) { sh.style.transition = "none"; sh.classList.remove("is-in"); void sh.offsetWidth; sh.style.transition = ""; sh.classList.add("is-in"); }
      await wait(CUT);
    } else {
      // (into the notebook or the phone, and back from them to the desk, the pitch follows a point the end pose looks
      // through: looking steeply down, the look would otherwise lead the eye and see the floor in front of the desk)
      const aim = this.aimFor(name) || (name === "desk" && (from === "notebook" || from === "phone") ? this.deskAim() : null);
      const lean = name === "laptop" || from === "laptop" ? { duration: LEAN_S } : aim ? { aim } : undefined;
      const r = await this.rig.glideTo(name, lean);
      if (!r.landed || seq !== this.seq) return;
    }
    if (seq !== this.seq) return;
    if (pageP) { const prep = await pageP; if (seq !== this.seq) { prep?.drop(); return; } if (prep) this.mountPage(name, prep); }
    this.afterLanding(name);
  }

  // A page document (or Projects from the homepage): glide to the spot, then load its page.
  async glideThenLoad(name, href) {
    const seq = ++this.seq;
    this.hideContent();
    if (this.spot === "laptop") { this.screenActive(false); this.saveScreen(); }
    if (!reducedQ.matches && this.rig) {
      const r = await this.rig.glideTo(name, this.rig.spot === "laptop" && name === "desk" ? { duration: LEAN_S } : undefined);
      if (!r.landed || seq !== this.seq) return;
    }
    location.assign(href);
  }

  // The pointer cursor: over an object that glides somewhere else, or one the interactions use (the lamp, a book at
  // the shelf).
  setCursor() {
    const hit = this.navHover;
    const glides = hit?.spot && hit.spot !== this.spot && !!this.room?.spots[hit.spot];
    const acts = this.doc === "home" && this.spot !== "laptop" && (hit?.object === "headphones" || hit?.object === "breadboard");
    this.hero.style.cursor = glides || acts || this.useHover ? "pointer" : "";
    this.light();
  }

  // ---------- the lamp at dusk ----------
  // Until the visitor switches the lamp, it follows the sun of the time shown (the clock, or the dial scrubbing): on with
  // the sun below LAMP_ALT, off above it, with a click's soft fade. In the morning it also stays on while the room shows
  // a moment whose photograph was rendered with the lamp on (sunrise: the bake's lamp_default, room_export.py's sun
  // below 3 degrees at its render), so the 3D agrees with the photograph it takes over from; it goes off with the change
  // to the next moment (morning), in that change's fade (qa-night A-2). A click wins for the rest of the visit.
  lampFor(date, moment, engine = this.engine) {
    if (this.lampChoice === undefined) {
      try { const v = sessionStorage.getItem(LAMP_KEY); this.lampChoice = v === "0" || v === "1" ? +v : null; } catch { this.lampChoice = null; }
    }
    if (this.lampChoice !== null) return this.lampChoice;
    const sun = sunPosition(date || new Date());
    if (sun.alt < LAMP_ALT) return 1;
    return sun.az < 180 && engine?.bake?.moments?.[moment]?.lamp_default === 1 ? 1 : 0;
  }

  // The room's light for the moment shown (the bake's moment for it, and the lamp): one change at a time, the newest
  // asked for last (a dial drag asks many times).
  wantLight(reason) {
    this.lightReason = reason;
    if (this.lightBusy) { this.lightAgain = true; return; }
    this.applyLight();
  }
  async applyLight() {
    const engine = this.engine;
    if (!engine || !this.mast) return;
    this.lightBusy = true;
    try {
      do {
        this.lightAgain = false;
        const reason = this.lightReason, d = this.mast.getMoment();
        const moment = pickMoment(d.frame, Object.keys(engine.bake?.moments || {})) || engine.light.moment;
        const lamp = this.lampFor(d.date, moment);
        if (!moment || (moment === engine.light.moment && lamp === engine.light.lamp)) continue;
        const dial = reason === "dial" || reason === "reset";
        const opts = moment !== engine.light.moment ? { fade: dial ? 400 : 2500, waitStill: dial ? 0 : 1000 } : { fade: reducedQ.matches ? 0 : LAMP_FADE };
        await engine.setLight({ moment, lamp, screen: 1 }, opts).catch(() => {});
      } while (this.lightAgain);
    } finally { this.lightBusy = false; }
  }

  // ---------- the quiet masthead ----------
  quietMasthead() {
    document.documentElement.classList.toggle("sfw-quiet", this.mode === "live" && QUIET.has(this.spot));
  }
  // the pointer near the masthead's name, clock or links (within 48 px) brings it back
  nearMasthead(e) {
    if (e.pointerType !== "mouse") return;
    const m = document.querySelector(".masthead");
    if (!m) return;
    let near = false;
    if (document.documentElement.classList.contains("sfw-quiet")) {
      for (const c of m.children) {
        const r = c.getBoundingClientRect();
        if (r.width && e.clientX > r.left - 48 && e.clientX < r.right + 48 && e.clientY > r.top - 48 && e.clientY < r.bottom + 48) { near = true; break; }
      }
    }
    m.classList.toggle("sfw-near", near);
  }

  // Leaving a spot: the window undocks, the About card closes, a page's overlays fade out (150 ms).
  leaving(from, to) {
    this.landedAt = null;
    // every book home, the one under the pointer too (releaseBook alone leaves a hovered spine out)
    if (from === "shelf" && to !== "shelf") { this.interact?.setBooksActive(false); this.interact?.releaseBook(); this.interact?.pullBook(0, 0); }
    if (from === "window" && to !== "window") this.dock(false);
    if (from === "desk" && to !== "desk") { if (this.cardMode) this.placeAbout("away"); this.cardOpen = false; this.syncName(); }
    if (from === "laptop" && to !== "laptop") { this.screenActive(false); if (!this.page) { this.ariaCurrent(null); document.title = this.title0; } }
    // interactions B: leaving the notebook closes its cover, leaving the phone dims it, leaving the laptop stops the video
    if (from === "notebook" && to !== "notebook") this.notebookIn(false);
    if (from === "phone" && to !== "phone") { this.phone?.setActive(false); this.phone?.sleep(); }
    if (from === "laptop" && to !== "laptop") { this.eggWanted = false; clearTimeout(this.eggT); this.eggObj?.stop(); }
    if (to === "notebook" && from !== "notebook") {
      // leaning in: the newest essay and the index's fonts are fetched while the camera moves
      this.startReader().then((r) => r.index().then((posts) => posts[0] && r.prefetch(posts[0].slug))).catch(() => {});
    }
    if (to === "phone" && from !== "phone") { clearTimeout(this.wakeT); this.wakeT = setTimeout(() => { if (this.spot === "phone") this.phone?.wake(); }, reducedQ.matches ? 0 : 300); }
    // the desk's print keeps its quote through every glide in the homepage (it follows the camera exactly, and is cut
    // where furniture stands in front of it: deskPrint); leaning in to the print it stays until the Quotes page, open on
    // the same quote, takes over on landing; leaving the print or the shelf (where a page stands in for it) it comes
    // back as the glide starts, with the day's quote (the paper is never blank, polish-r2)
    const home = this.doc === "home";
    this.hideContent({ keepPrint: home });
    const printEl = this.o.print?.()?.el;
    if (home && (from === "print" || from === "shelf") && printEl) {
      this.deskPrint(true);
      const pr = this.o.print(), q = pr.current?.();
      if (q) pr.set(q, { animate: false }); else pr.daily?.().then((d) => pr.set(d));
      // at once, not faded in: it lies on the same paper as the page's print fading out over it, the same quote, so a
      // fade-in under a fade-out blinked the quote out for a frame (polish-live walks)
      this.overlays.show([printEl], true);
    }
    if (this.page && this.page.spot !== to) {
      const p = this.page;
      this.page = null;
      setTimeout(() => this.unmountPage(p), reducedQ.matches ? 0 : 160);
    }
    this.live?.edges?.show(false);
    this.close.hidden = true;
    this.quietMasthead();   // leaning in: quiet; leaning back: it comes back as the glide starts
    this.light();           // nothing stays lit through a glide
  }

  hideContent({ keepPrint = false } = {}) {
    const els = [this.page?.el, keepPrint ? null : this.o.print?.()?.el].filter(Boolean);
    this.overlays.hide(els, reducedQ.matches);
    this.live?.links?.hideTip();
  }

  // Landing: the spot's content is shown (250 ms), its links offered, focus moves, and the landing is announced.
  afterLanding(name, { quiet = false } = {}) {
    this.landedAt = name;
    this.interact?.setBooksActive(name === "shelf");   // a spine pulls out under the pointer only at the shelf
    const [w, h] = this.size();
    const rest = this.rig.pose;
    this.live?.links?.setSpot(name, rest, w, h);
    this.live?.links?.update(rest, w, h);
    this.live?.edges?.show(name === "desk");
    fitEdges(this.live?.edges, this.room, rest, w, h);
    // the desk's print shows wherever the homepage's own room is (not at a page spot: the page has its own; the
    // laptop's page is on its screen, in the homepage's room)
    const deskRoom = this.doc === "home" && (name === "laptop" || !PAGE_VIEW[name]);
    const printEl = this.o.print?.()?.el;
    this.overlays.show([this.page?.el, deskRoom ? printEl : null].filter(Boolean), reducedQ.matches);
    if (deskRoom) {
      this.deskPrint(true);
      // the day's quote (shared/print.js): leaning back from the print, it returns to it
      // (a page left open past midnight: the new day's quote, fetched once)
      const pr = this.o.print?.(), q = pr?.current?.();
      if (q) pr.set(q, { animate: false });
      else pr?.daily?.().then((d) => pr.set(d));
    }
    // at the print the Quotes page's own print takes over once the page is in (250 ms): the desk's, kept through the
    // glide, goes; at the shelf (out of sight there) it goes once the Books page is up. qa-landing: the two set the
    // quote at different sizes (other line breaks), so the page's waits unseen and they swap in one frame, never both
    if ((name === "print" || name === "shelf") && this.doc === "home" && printEl && this.page?.spot === name) {
      clearTimeout(this.printOff);
      const own = name === "print" && printEl.style.opacity !== "0" ? this.page.handle.print?.el : null;
      if (own) own.style.opacity = "0";
      this.printOff = setTimeout(() => {
        if (own) own.style.opacity = "";   // (never left hidden, even when the visitor left within the 260 ms)
        if (this.spot !== name) return;
        this.overlays.hide([printEl], reducedQ.matches || !!own);
      }, reducedQ.matches ? 0 : 260);
    }
    if (name === "window") { this.dock(true); this.zoomWarm(); }
    // (only with the camera there: a page booted at its address lands "at" the notebook from the desk, then leans in)
    if (name === "notebook" && this.rig?.spot === "notebook") this.notebookIn(true);
    if (name === "phone" && this.rig?.spot === "phone") this.phoneIn();
    if (name === "desk" && this.cardMode) this.placeAbout(this.cardOpen ? "desk" : "away");
    if (name === "laptop") { this.screenActive(true); this.ariaCurrent("/projects/"); this.live?.links?.hideTip(); }
    this.showClose();
    this.quietMasthead();
    this.light();
    if (quiet) return;
    if (this.page && this.page.spot === name) {
      document.title = this.page.title;
      this.overlays.landed(this.page.el.querySelector("h1"));
      if (this.page.handle.card) this.overlays.inertUnder(this.page.handle.card, this.page.handle.items || []);
    } else if (name === "desk") {
      document.title = this.title0;
      const back = this.lastFrom && this.live?.links?.items.get(this.lastFrom);
      if (this.cardOpen) this.focusCard();   // the name asked for the card from another spot
      else if (this.nameFocus) this.nameBtn?.focus({ preventScroll: true });   // the name closed the bio's card
      else if (back && back.a.style.display !== "none") back.a.focus({ preventScroll: true });
      this.overlays.landed(null, document.querySelector(".masthead h1")?.textContent?.trim());
    } else if (name === "notebook") {
      // focus on the index's first title (its accessible name, "Writing", is announced); not over an open sheet
      if (!this.reader?.isOpen) { this.nbIndex?.first()?.focus({ preventScroll: true }); this.overlays.landed(null, this.room.spots.notebook.label); }
    } else if (name === "phone") {
      this.phone?.first()?.focus({ preventScroll: true });
      this.overlays.landed(null, this.room.spots.phone?.label);
    } else if (name === "window") {
      document.getElementById("dial-range")?.focus({ preventScroll: true });
    } else if (name === "laptop" && this.laptop?.scr) {
      // leaned in: the page's heading takes focus (its words announce it), as on the page itself
      document.title = this.laptop.mod.titleOf(this.laptop.scr.route);
      this.overlays.landed(this.laptop.scr.heading());
    }
    this.lastFrom = name === "desk" ? this.lastFrom : name;
    this.nameFocus = false;
  }

  showClose() {
    const away = this.spot && this.spot !== "desk";
    const pageDoc = this.doc !== "home";
    this.close.hidden = !(away && (this.mode === "live" || this.spot === "window" || this.spot === "notebook") || (pageDoc && this.mode === "live"));
  }

  // "Back to the desk", Escape: from the window or the About card, Back undoes their history entry.
  backToDesk() {
    if (this.doc !== "home") {
      if (this.mode === "live") this.glideThenLoad("desk", new URL("/", location.href).href);
      else location.assign("/");
      return;
    }
    // the window and the About card are history entries of their own: leaving one undoes it, as Back does, when
    // the entry before it is the desk; entered from elsewhere (the window from the About card), it goes to the desk
    // (the phone, and the laptop the headphones leaned to, are history entries of their own too: interactions B)
    const own = this.spot === "window" || this.spot === "notebook" || this.spot === "phone" || (this.spot === "laptop" && history.state?.egg);
    if (own && history.state?.spot === this.spot && this.pushedHere && this.pushedFrom === "desk") { history.back(); return; }
    if (this.mode === "live") { this.liveGo("desk", true); return; }
    // photo / still
    if (this.spot === "window") { history.pushState({ sfw: 1, spot: "desk" }, "", location.pathname); this.photoWindow(false); }
    if (this.spot === "notebook") history.pushState({ sfw: 1, spot: "desk" }, "", "/");
    this.spot = "desk";
    this.showClose();
  }

  onKey(e) {
    // + and - zoom the live room (the keyboard's way to do what the wheel and a pinch do); with ctrl or cmd they
    // stay the browser's page zoom
    if (["+", "=", "-", "_"].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.defaultPrevented) {
      if (this.mode !== "live" || !this.rig || this.orbit === false || this.spot === "laptop") return;
      if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      this.reveal();
      this.rig.zoomBy(e.key === "-" || e.key === "_" ? -ZOOM_KEY : ZOOM_KEY);
      return;
    }
    // at the notebook, the arrow keys turn its leaves (when the index has more than one)
    if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !e.defaultPrevented && this.spot === "notebook" && this.landedAt === "notebook" &&
        !e.target.closest?.("input, textarea, select, .sfw-nb, .rd") && this.nbIndex?.turn(e.key === "ArrowRight" ? 1 : -1)) { e.preventDefault(); return; }
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (e.target.closest?.("input, textarea, select")) { if (this.spot !== "window") return; }
    // (an Escape the room acts on is marked handled, as the reading sheet's is: left unhandled, the browser acts on it
    // too, and headless Chrome under the DevTools screencast then stopped drawing the page: qa-escape take 1)
    if (this.cardOpen && this.spot === "desk") { e.preventDefault(); this.setCard(false, { focus: true }); return; }
    if (this.spot && this.spot !== "desk") { e.preventDefault(); this.backToDesk(); return; }
    if (this.rig && this.rig.state === "orbit") { e.preventDefault(); this.rig.resetOrbit(reducedQ.matches ? 0 : 600); }
  }

  // Escape at the window: back to the desk, as "Back to the desk", once, whatever has focus. Taken before the masthead's
  // own Escape (the dial docked there would close, focus the clock's caption, and be docked again), and marked handled.
  onWindowEscape(e) {
    if (e.key !== "Escape" || e.defaultPrevented || this.doc !== "home" || this.spot !== "window" || this.reader?.isOpen) return;
    e.preventDefault();
    e.stopPropagation();
    this.backToDesk();
  }

  onPop(e) {
    if (!this.room) return;
    const name = spotForURL(this.room, location.href, e.state) || "desk";
    // the laptop's screen has its own history (a project opened on it): Back and Forward show it on the screen
    if (name === "laptop" && this.mode === "live" && this.laptop?.scr) {
      this.laptop.scr.show(this.laptop.mod.routeOf(location.hash));
      this.saveScreen();
      if (this.spot === "laptop") { document.title = this.laptop.mod.titleOf(this.laptop.scr.route); return; }
    }
    if (this.doc !== "home") return;
    if (name === this.spot) return;
    if (this.mode !== "live" && (e.state?.reader || this.reader?.isOpen)) return;   // (the reading sheet's own entries)
    if (this.mode === "live") { this.pushedHere = false; this.liveGo(name, false); return; }
    // photo / still: the window and the About card are in-document; a page URL popped here loads
    if (this.spot === "window" && name !== "window") this.photoWindow(false);
    if (this.spot === "notebook" && name !== "notebook") { (this.nameFocus ? this.nameBtn : null)?.focus({ preventScroll: true }); this.nameFocus = false; }
    if (name === "window") this.photoWindow(true);
    if (name === "notebook" && !e.state?.reader) { location.reload(); return; }   // (the writing: its own page without the live room)
    if (PAGE_VIEW[name]) { location.reload(); return; }
    this.spot = name;
    this.showClose();
  }

  // Back to a homepage restored from the back-forward cache (we left it for a page's own document): the room is
  // where we left it, at that page's spot; glide back to the spot of this address.
  onPageShow(e) {
    if (!e.persisted || !this.room) return;
    if (this.doc !== "home") {
      // a page restored after "Back to the desk" glided away from it: back to its own spot
      if (this.mode === "live" && this.rig && this.rig.spot !== this.spot) {
        if (reducedQ.matches) this.rig.jumpTo(this.spot);
        else this.rig.glideTo(this.spot).then((r) => r.landed && this.afterLanding(this.spot, { quiet: true }));
      }
      return;
    }
    const name = spotForURL(this.room, location.href, history.state) || (this.doc === "home" ? "desk" : this.spot);
    if (this.mode === "live" && this.rig && (this.rig.spot !== name || this.rig.glide)) {
      this.spot = this.rig.spot;
      if (reducedQ.matches) { this.rig.jumpTo(name); this.spot = name; this.afterLanding(name, { quiet: true }); }
      else this.liveGo(name, false);
    } else if (this.mode === "live") {
      this.afterLanding(this.spot, { quiet: true });
    }
  }

  flick(dir) {
    const i = FLICK_ORDER.indexOf(this.spot);
    if (i < 0) return;
    const next = FLICK_ORDER[i + dir];
    if (next) this.go(next);
  }

  // ---------- the window spot ----------
  // The window's link lies under the objects in front of the glass and its outline is the whole glass (links.js), so a
  // click or tap on it asks the room's pick first (qa-night B-F14, B-F5): an object in front of the glass is that
  // object's (the lamp switches, the print's edge glides to Quotes, the bottle does nothing), and only the window itself
  // or the view through it enters the window. The keyboard (no pointer: detail 0) enters it at once.
  async windowLink(e) {
    const picker = this.live?.picker;
    if (picker && e?.type === "click" && e.detail > 0) {
      const hit = await picker.at(e.clientX, e.clientY);
      if (hit?.object && hit.spot !== "window") {
        picker.onPick(hit);   // (as a tap on the room there)
        if (hit.object === "lamp") this.interact?.toggleLamp();   // (gl/interact.js takes no events over a link)
        return;
      }
    }
    this.enterWindow();
  }

  enterWindow() {
    if (this.spot === "window") return;
    const from = this.spot;
    history.pushState({ sfw: 1, spot: "window" }, "", location.href);
    this.pushedHere = true;
    this.pushedFrom = from;
    if (this.mode === "live") { this.liveGo("window", false); return; }
    if (this.cardOpen) this.setCard(false);
    this.spot = "window";
    this.photoWindow(true);
    this.showClose();
  }

  // Without the 3D the photograph leans in toward the window (reduced motion: no lean); the dial docks.
  photoWindow(on, { instant = false } = {}) {
    if (on) this.spot = "window";
    const stage = this.o.stage;
    const poly = this.o.windowPolygon?.();
    if (stage && poly && this.mode === "photo") {
      const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
      const cx = ((Math.min(...xs) + Math.max(...xs)) / 2) * 100, cy = ((Math.min(...ys) + Math.max(...ys)) / 2) * 100;
      stage.classList.toggle("sfw-lean", !instant);
      stage.style.transformOrigin = `${cx}% ${cy}%`;
      stage.style.transform = on ? "scale(1.22)" : "";
    }
    this.dock(on);
    if (on && !instant) document.getElementById("dial-range")?.focus({ preventScroll: true });
    if (!on && !instant) this.o.windowLink?.()?.focus({ preventScroll: true });
  }

  dock(on) {
    this.docked = on;
    document.documentElement.classList.toggle("sfw-at-window", on);
    const dial = document.getElementById("dial");
    if (on && dial?.hidden) this.openDial();
    if (!on && dial && !dial.hidden) document.getElementById("now")?.click();
  }
  openDial() { const d = document.getElementById("dial"); if (d?.hidden && this.docked) document.getElementById("now")?.click(); }

  // ---------- the About card ----------
  // The homepage's words while the live room runs (Akshay, 2026-10-15): the page no longer scrolls, the words are
  // a card over the room. Deferred while the visitor is reading below the window: they move once the page is back
  // at its top (a glide scrolls it there).
  enterCardMode() {
    if (this.doc !== "home" || this.cardMode || this.mode !== "live") return;
    if (scrollY > 2) {
      if (this.cardWait) return;
      this.cardWait = () => { if (scrollY <= 2 && this.mode === "live") { removeEventListener("scroll", this.cardWait); this.cardWait = null; this.enterCardMode(); } };
      addEventListener("scroll", this.cardWait, { passive: true });
      return;
    }
    this.cardMode = true;
    this.placeAbout(this.spot === BIO_SPOT ? "notebook" : this.spot === "desk" && !this.rig?.glide && this.cardOpen ? "desk" : "away");
    this.updateScrollMode();
  }

  updateScrollMode() {
    document.documentElement.classList.toggle("sfw-noscroll", !!(this.cardMode && !this.page));
  }

  // Where the homepage's words are: "flow" (below the window: photo and still modes, no JS), or in the live room's
  // card: "desk" (top right; phones a top sheet), "notebook" (the About card), "away" (faded out and hidden, at the
  // other spots). The section itself moves, so its words, links, focus order and reading order are the page's own.
  placeAbout(where) {
    const about = document.getElementById("about");
    if (!about) return;
    const r = document.documentElement;
    this.cardVars();
    clearTimeout(this.aboutOut);
    // (a card still shrinking into the name, asked for again: it grows from the name again)
    const flipping = this.cardFlip, shrinking = !!flipping && !flipping.open;
    if (flipping && (shrinking || where !== "desk")) { flipping.cancel(); this.cardFlip = null; about.style.transition = ""; }
    about.classList.remove("sfw-card-out");
    if (where === "flow") {
      about.classList.remove("sfw-about");
      r.classList.remove("sfw-about-card", "sfw-home-card");
      about.removeAttribute("tabindex");
      if (about.parentNode === this.hero) this.hero.after(about);
      about.hidden = true;   // (nav-r1: nothing below the room; About and the name open the bio)
      this.syncName();
      return;
    }
    const shown = about.parentNode === this.hero && !about.hidden && about.classList.contains("sfw-about") && !shrinking;
    if (about.parentNode !== this.hero) this.hero.appendChild(about);   // after the masthead: the same tab order
    about.classList.add("sfw-about");
    if (where === "away") {
      const gone = () => { about.hidden = true; about.classList.remove("sfw-card-out"); r.classList.remove("sfw-about-card", "sfw-home-card"); about.style.transition = ""; };
      if (!shown) { gone(); this.syncName(); return; }
      // the name's card shrinks back into the name (the About card at the notebook, and reduced motion: a fade)
      const desk = r.classList.contains("sfw-home-card");
      if (desk && !reducedQ.matches) about.style.transition = "none";   // (a CSS fade would override the shrink's own)
      about.classList.add("sfw-card-out");
      if (!(desk && this.flipCard(about, false, gone))) { about.style.transition = ""; this.aboutOut = setTimeout(gone, reducedQ.matches ? 0 : 150); }
      this.syncName();
      return;
    }
    r.classList.toggle("sfw-about-card", where === "notebook");
    r.classList.toggle("sfw-home-card", where === "desk");
    if (where === "desk") about.removeAttribute("tabindex");
    about.hidden = false;
    if (where === "desk") this.fitHomeCard();   // (its height first: the growth ends on the card's own box)
    // the name's card grows from the name; the About card (and reduced motion) fades in
    if (!shown && !(where === "desk" && this.flipCard(about, true))) { about.style.animation = "none"; void about.offsetWidth; about.style.animation = ""; }
    this.syncName();
  }

  // The name's card grows from the name and shrinks back into it (spec v2): a FLIP from the name's box over CARD_MS with
  // a soft ease. The card's own box moves and scales; its words come in once it has most of its size (and go first on
  // the way back), so no word is seen stretched. Reduced motion: false (the caller crossfades).
  flipCard(about, open, done = null) {
    const b = this.nameBtn;
    if (reducedQ.matches || !b || typeof about.animate !== "function") return false;
    const N = b.getBoundingClientRect(), C = about.getBoundingClientRect();
    if (!N.width || !C.width || !C.height) return false;
    const from = `translate(${(N.left - C.left).toFixed(1)}px, ${(N.top - C.top).toFixed(1)}px) scale(${(N.width / C.width).toFixed(4)}, ${(N.height / C.height).toFixed(4)})`;
    about.style.animation = "none";   // (not the card's CSS fade-in)
    const ms = open ? CARD_MS : CARD_MS - 50;
    const opts = { duration: ms, easing: SOFT, direction: open ? "normal" : "reverse", fill: open ? "none" : "forwards" };
    const box = about.animate([
      { transformOrigin: "0 0", transform: from, opacity: 0 },
      { transformOrigin: "0 0", transform: from, opacity: 1, offset: 0.08 },
      { transformOrigin: "0 0", transform: "none", opacity: 1 },
    ], opts);
    const col = about.querySelector(".col");
    const words = col?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], { ...opts, easing: "ease" });
    const flip = this.cardFlip = { open, box, cancel: () => { box.cancel(); words?.cancel(); } };
    box.finished.then(() => {
      if (this.cardFlip !== flip) return;
      this.cardFlip = null;
      if (!open) { done?.(); flip.cancel(); }
    }).catch(() => {});
    return true;
  }

  // The homepage's card at the desk stays clear of the desk's must-see objects (its framing data) at every screen
  // shape: its height stops above the highest of them under its column (squarer screens put the print there).
  // Objects that reach above the card's top (none of the desk's today) are not counted. Phones' top sheet: the
  // framing keeps the must-see objects below it (reserveFor).
  fitHomeCard() {
    const r = document.documentElement, about = document.getElementById("about");
    if (!this.cardMode || !this.rig?.rest || !about || about.hidden || !r.classList.contains("sfw-home-card")) return;
    const [w, h] = this.size();
    const c = about.getBoundingClientRect(), hb = this.hero.getBoundingClientRect();
    if (!c.width || c.width > w * 0.9) { r.style.removeProperty("--sfw-card-max"); return; }
    const x0 = c.left - hb.left - 12, x1 = c.right - hb.left + 12, top = c.top - hb.top;
    let room = Infinity;
    for (const n of this.room.mustSee("desk", false)) {
      const P = (this.room.points(n) || []).map((p) => project(this.rig.rest, p, w, h));
      if (!P.length || P.some((p) => !p)) continue;
      const xs = P.map((p) => p[0]), y0 = Math.min(...P.map((p) => p[1]));
      if (Math.max(...xs) < x0 || Math.min(...xs) > x1 || y0 <= top + 1) continue;
      room = Math.min(room, y0 - 16 - top);
    }
    if (Number.isFinite(room)) r.style.setProperty("--sfw-card-max", `${Math.max(140, Math.round(room))}px`);
    else r.style.removeProperty("--sfw-card-max");
  }

  cardVars() {
    const r = document.documentElement;
    const [, h] = this.size ? this.size() : [innerWidth, innerHeight];
    r.style.setProperty("--sfw-hero-h", `${Math.max(520, h)}px`);
    const m = document.querySelector(".masthead");
    r.style.setProperty("--sfw-mh", `${Math.round(m ? m.getBoundingClientRect().height : 96)}px`);
    r.style.setProperty("--sfw-card-in", reducedQ.matches ? `${CUT}ms` : "250ms");
  }

  aboutCard(on) {
    if (this.cardMode) return this.placeAbout(on ? "notebook" : "away");
    const about = document.getElementById("about");
    if (!about) return;
    const r = document.documentElement;
    const [w, h] = this.size ? this.size() : [innerWidth, innerHeight];
    r.style.setProperty("--sfw-hero-h", `${Math.max(520, h)}px`);
    const m = document.querySelector(".masthead");
    r.style.setProperty("--sfw-mh", `${Math.round(m ? m.getBoundingClientRect().height : 96)}px`);
    r.style.setProperty("--sfw-card-in", reducedQ.matches ? `${CUT}ms` : "250ms");
    if (on) {
      this.cardOpen = false;
      r.classList.remove("sfw-home-card");
      about.classList.add("sfw-about");
      r.classList.add("sfw-about-card");
      this.hero.appendChild(about);   // over the room, beside the notebook
      void w;
    } else if (about.classList.contains("sfw-about")) {
      about.classList.remove("sfw-about");
      r.classList.remove("sfw-about-card");
      about.removeAttribute("tabindex");
      this.hero.after(about);         // back in the flow below the window
    }
    this.syncName();
  }

  // ---------- the name: the card only when asked ----------
  // The masthead's name becomes a button (with JS only: without it the words are below the window, the name plain
  // text). At the desk it opens and closes the card; at the bio's spot (the card is open there) it goes back to the
  // desk; at any other spot it goes to the desk and opens the card there.
  nameButton() {
    const h1 = document.querySelector(".masthead .who h1");
    const about = document.getElementById("about");
    if (!h1 || !about || h1.querySelector(".sfw-name")) return;
    const b = el("button", { class: "sfw-name", type: "button", "aria-expanded": "false", "aria-controls": "about" });
    while (h1.firstChild) b.appendChild(h1.firstChild);
    h1.appendChild(b);
    this.nameBtn = b;
    b.addEventListener("click", () => this.onName());
    // a click outside the card closes it (a press that moved, an orbit drag, is not a click)
    const downs = new Map();
    document.addEventListener("pointerdown", (e) => { if (e.isPrimary) downs.clear(); downs.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.target, n: downs.size }); }, true);
    document.addEventListener("pointercancel", (e) => downs.delete(e.pointerId), true);
    document.addEventListener("pointerup", (e) => {
      const d = downs.get(e.pointerId); downs.delete(e.pointerId);
      if (!this.cardOpen || !d || d.n > 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) return;   // (one finger, not moved)
      if (about.contains(d.t) || b.contains(d.t)) return;
      const ae = document.activeElement;
      this.setCard(false, { focus: !ae || ae === document.body || about.contains(ae) });   // (a link or field clicked keeps its focus)
    }, true);
    this.syncName();
  }

  onName() {
    if (this.spot === BIO_SPOT) { this.nameFocus = true; this.backToDesk(); if (this.spot === "desk" && this.mode !== "live") { this.nameFocus = false; this.nameBtn?.focus({ preventScroll: true }); } return; }
    if (this.spot && this.spot !== "desk") {
      if (this.mode === "live" || this.mode === "booting") { this.cardOpen = true; this.go("desk"); }
      return;
    }
    this.setCard(!this.cardOpen, { focus: true });
  }

  // The name's card at the desk: in the live room the card over the room (top right, phones a top sheet); in photo
  // and still modes the same card over the photograph, back below the window when closed.
  setCard(on, { focus = false } = {}) {
    const about = document.getElementById("about");
    if (!about || this.doc !== "home") return;
    const had = about.contains(document.activeElement);
    this.cardOpen = !!on;
    if (on) {
      this.placeAbout("desk");
      if (focus) this.focusCard();
    } else {
      this.placeAbout(this.cardMode ? "away" : "flow");
      if (focus || had) this.nameBtn?.focus({ preventScroll: true });
    }
    this.syncName();
  }

  focusCard() {
    const about = document.getElementById("about");
    if (!about) return;
    about.setAttribute("tabindex", "-1");
    about.focus({ preventScroll: true });
  }

  syncName() {
    const b = this.nameBtn, about = document.getElementById("about");
    if (!b || !about) return;
    const open = !about.hidden && about.classList.contains("sfw-about") && !about.classList.contains("sfw-card-out");
    b.setAttribute("aria-expanded", open ? "true" : "false");
  }

  deskPrint(on) {
    // the desk's print follows the live camera (its paper is HTML typeset by print.js on the homepage)
    const pr = this.o.print?.();
    if (!pr || !this.live || this.live.printAnchored) return;
    this.live.printAnchored = true;
    pr.liveAnchored = true;   // app.js leaves it to the live room from now on
    pr.home = pr.el.parentNode;
    this.live.layer.appendChild(pr.el);
    this.overlays.add({
      el: pr.el,
      quad: () => this.room.objects.print.quad,
      size: () => [parseFloat(pr.el.style.width) || 0, parseFloat(pr.el.style.height) || 0],
      // kept up through glides, it is cut where furniture stands in front of it (shared/occlude.js)
      occluders: (this.room.obstacles || []).filter((o) => o.box && o.name !== "print" && o.name !== "desk").map((o) => o.box),
    });
    this.overlays.update(this.rig.pose, ...this.size());
    void on;
  }

  // ---------- pages in the homepage ----------
  prefetch(name) { if (PAGE_MODULE[name] && this.doc === "home") this.loadPage(name).catch(() => {}); }

  loadPage(name) {
    const url = this.room.spots[name].url;
    if (!this.pageCache.has(url)) {
      this.pageCache.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); }).then((html) => {
        const d = new DOMParser().parseFromString(html, "text/html");
        import(PAGE_MODULE[name]).catch(() => {});   // warm the module while the glide runs
        return {
          title: d.title,
          styles: [...d.head.querySelectorAll("style")].map((s) => s.textContent),
          sheets: [...d.head.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href")),
          main: d.querySelector("main"),
        };
      }));
      this.pageCache.get(url).catch(() => this.pageCache.delete(url));
    }
    return this.pageCache.get(url);
  }

  // During the glide: the page's stylesheets go in (they only style the page's own classes, and the homepage's
  // photograph layers are guarded in CSS above) and its module loads. Resolves to what mountPage attaches.
  async preparePage(name, parsed) {
    const added = [];
    const loads = [];
    for (const href of parsed.sheets) {
      if ([...document.styleSheets].some((s) => s.href && new URL(s.href).pathname === new URL(href, location.href).pathname)) continue;
      // shared stylesheets (world.css) stay once in: pages share them, and the next page may need them already
      const l = el("link", { rel: "stylesheet", href, "data-sfw-sheet": "" });
      document.head.appendChild(l);
      loads.push(new Promise((r) => { l.onload = r; l.onerror = r; setTimeout(r, 1500); }));
    }
    for (const css of parsed.styles) { const s = el("style", { "data-sfw-page": "" }); s.textContent = css; document.head.appendChild(s); added.push(s); }
    const [mod] = await Promise.all([import(PAGE_MODULE[name]), ...loads]);
    return { parsed, mod, added, drop: () => { if (!this.page || !this.page.added.includes(added[0])) for (const n of added) n.remove(); } };
  }

  mountPage(name, { parsed, mod, added }) {
    const box = el("div", { class: "page sfw-page", "data-page": name });
    box.classList.add(...(parsed.main.className || "").split(/\s+/).filter(Boolean));
    for (const n of [...parsed.main.childNodes]) box.appendChild(document.importNode(n, true));
    const about = document.getElementById("about");
    const scene = this.hero;
    scene.after(box);
    if (about) about.hidden = true;
    const handle = mod.mount(box, { live: true });
    this.page = { spot: name, el: box, handle, added, title: parsed.title };
    this.updateScrollMode();
    this.ariaCurrent(this.room.spots[name].url);
    scrollTo({ top: 0, behavior: "instant" });
    box.classList.add("is-in");
    // the page's overlays follow the camera: they were laid out on the page's photograph
    const view = PAGE_VIEW[name];
    const photo = () => {
      const geo = handle.room?.geo, v = handle.room?.view;
      if (!geo || !v) return null;
      const size = [v.width, v.height];
      const camera = this.room.photoCamera(view, size);
      return camera ? { camera, size, geo } : null;
    };
    this.anchor(handle, photo);
  }

  // A page's overlays follow the live camera (they were laid out on the page's photograph).
  anchor(handle, photo) {
    this.bindBooks(handle);
    for (const a of handle.anchors?.() || []) {
      // a piece the page re-places (the Books tip) is moved with the camera from its new point at once
      if (a.mode === "point") a.el.addEventListener("sfw:placed", () => { if (this.rig?.pose) this.overlays.update(this.rig.pose, ...this.size()); });
      const q = a.plane && this.room.objects[a.plane]?.quad;
      if (a.mode === "quad") this.overlays.add({ el: a.el, quad: () => this.room.objects[a.quad].quad, size: a.size });
      else if (a.mode === "follow") this.overlays.add({ el: a.el, follow: this.room.centre(a.point), photo });
      else if (a.mode === "point" && q) this.overlays.add({ el: a.el, planePoint: q, at: a.at, photo });
      else if (a.mode === "place") this.overlays.add({ el: a.el, place: a.place, points: () => this.room.points(a.object) });
      else if (q) this.overlays.add({ el: a.el, plane: q, photo });
    }
    handle.room?.on?.("layout", () => { if (this.rig?.pose) this.overlays.update(this.rig.pose, ...this.size()); });
    if (this.rig?.pose) this.overlays.update(this.rig.pose, ...this.size());
  }

  // The Books page's keyboard focus and picks reach the 3D book (stream I's interact.pullBook): a spine with
  // keyboard focus comes out 1.5 cm, the book the visitor picked (a click, Enter, the card's arrows) 5 cm, and it
  // slides home when focus leaves the shelf and its card, or the visitor leaves the shelf (leaving()).
  bindBooks(handle) {
    handle.onBook?.(({ index, level }) => {
      const I = this.interact;
      if (!I || this.mode !== "live" || this.spot !== "shelf" || this.rig?.glide) return;
      if (level > 0 && index >= 0) I.pullBook(index, level);
      else I.releaseBook();
      // the hook for the book's lift sheet (it comes with the reading sheet): a book picked by a click, Enter or the
      // card's arrows has slid out; listen for "sfw:book" on document, or set nav.onBookOpen
      if (level >= 2 && index >= 0) {
        const detail = { index, id: handle.items?.[index]?.dataset?.id || null, object: `book:${index}` };
        this.onBookOpen?.(detail);
        document.dispatchEvent(new CustomEvent("sfw:book", { detail }));
      }
    });
  }

  unmountPage(p) {
    try { p.handle?.unmount?.(); } catch (e) { console.error(e); }
    for (const it of this.overlays.items.slice()) if (p.el.contains(it.el)) this.overlays.remove(it);
    p.el.remove();
    for (const n of p.added) n.remove();
    if (!this.page) { document.title = this.title0; this.ariaCurrent(null); }
    this.updateScrollMode();
  }

  ariaCurrent(href) {
    for (const a of document.querySelectorAll(".masthead nav a")) {
      if (href && norm(new URL(a.href).pathname) === norm(new URL(href, location.href).pathname)) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
  }
}

// The room's light for this moment: the moment itself when the asset set has it, else the nearest kind of light it
// does have (a partial set, like the spike's golden, midday and night).
function pickMoment(frame, have) {
  if (!frame) return have[0] || null;
  if (!have.length || have.includes(frame.id)) return frame.id;
  const alt = frame.alt ?? 30;
  const want = alt < -4 ? ["night", "blue", "dusk"] : alt < 12 ? ["golden", "lowsun", "sunset", "sunrise"] : ["midday", "afternoon", "latemorning"];
  return want.find((x) => have.includes(x)) || have[0];
}

function el(tag, attrs = {}) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  const s = document.createElement("style");
  s.textContent = CSS;
  document.head.appendChild(s);
}

let nav = null;
export function startRouter(opts) {
  if (nav) return nav;
  nav = new Nav(opts);
  nav.booted = nav.boot();
  return nav;
}
