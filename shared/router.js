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
//
// One continuous page (v3/qa-nav, Akshay 18 Oct: "every single move ... the full page refreshes ... and music pauses
// and then restarts"): a browser that can run the live room never leaves this document while it moves about the site.
//   - /books/, /quotes.html and /projects/ send such a browser here as /?page=<name> before they paint (their heads,
//     as the essays' pages do); the address becomes the page's own again at once. Books and Quotes come in over their
//     own photographs (the page "own": its photograph and overlays as on its own document) and the room starts at
//     their spot, its first frame on that photograph; Projects opens in the reading sheet over the desk, and the room
//     leans in to the laptop behind it once it is ready. (DYS-24, Akshay 28 Oct: a reload at the laptop lands back
//     there, as Quotes does: the room starts leaned in at the laptop, its screen showing what it showed (on a phone
//     in its narrow layout, as leaned in there), and comes in there over the scene's own calm colours and the
//     masthead; no sheet, no lean-in. Desktops and phones alike: leanable, leanBoot below. DYS-24 option a, on DYS-26:
//     the laptop only; an essay's address keeps DYS-26's lifted page, shown at once, liftEssay.)
//   - While the room is still starting ("booting"), a move never loads a page: Books and Quotes come in over their own
//     photographs, Projects opens in the reading sheet, Writing waits for the room and leans in to the notebook (DYS-106:
//     no reading sheets anywhere; no room, the essays' own page, openWriting), the desk takes a hosted page away again;
//     the room takes over where the visitor is once it is ready.
//   So the room, the city and the sound go on from the first page to the last. Without the live room (no WebGL2,
//   reduced motion, Save-Data, a small device, ?3d=0) every page is still its own document, as before.
import { loadSpots, spotForURL } from "./spots.js";
import { Rig, toEngineCamera, clonePose, project, ray, ease, ROOM_FADE_MS } from "./rig.js";
import { frameSpot, cropPose, mustSeeReport, underReserve, phoneVariant, freeRegion } from "./framing.js";
import { Overlays } from "./overlays.js";
import { deskOccluders } from "./occlude.js";
import { LinkLayer, ACTIONS } from "./links.js";
import { Picker } from "./picking.js";
import { Gestures, bootTier, EdgeTabs } from "./gestures.js";
import { LaptopScreen, leanPose } from "./laptop.js";
import { sunPosition, loadScene } from "./sky.js";
import { fitPose } from "./surface.js";
import { normalize, add, mul, dirOf } from "./rig.js";
import { fitEdges, edgeRects } from "./edgefit.js";
import { soundRoom, pageTurn, soundState } from "./sound.js";
import { phoneNow } from "./device.js";
import { withoutRepeatedFaces, ownURLs, RESTYLE } from "./faces.js";

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
// (v3/qa-nav: the phone waits for the room while it starts, go(); the notebook's essays open in the reading sheet instead)
const ROOM_OFF_KEY = "sfw-room-off";                 // sessionStorage: the live room did not start in this visit

const reducedQ = matchMedia("(prefers-reduced-motion: reduce)");
const coarseQ = matchMedia("(pointer: coarse)");
const params = new URLSearchParams(location.search);
// DYS-29 mock (?shelfmock=a|b|c): prototype layouts of the Books shelf for Akshay to pick from (books/page.js). Read from
// the first address and kept on <html data-shelfmock> for the page (shared/pages.js shelfMock), as the address loses its
// query when the camera glides to the shelf. Without the switch: null, and nothing below changes.
// (DYS-29: Akshay picked (a), and it is the shelf now: no switch)
const SHELF_MOCK = "a";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// (DYS-149: the next task, by a message, as gl/context.js nextMessage (not imported: the photographs' visitors load none of
// the 3D's modules): the boot's pieces as tasks of their own, not one long task; never setTimeout's 1 s in a hidden tab)
const nextMessage = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });
const idle = (fn, timeout = 1500) => (window.requestIdleCallback || ((f) => setTimeout(f, 200)))(fn, { timeout });
// (DYS-149: ?livesplit=0 keeps startLive's spot registry in its own task, as before; see startLive)
const LIVE_SPLIT = params.get("livesplit") !== "0";
// (DYS-149 mt-diet: the layout the moving frames read (the canvas's size, the masthead's height, the phones' edge tabs'
// boxes) measured together once and kept until a resize or a ResizeObserver says it changed (measured(), watchBox()),
// not read again at each of the ~10 asks a moving frame makes, after that frame's own writes: each such read forced a
// style + layout. ?mtdiet=0: read at every ask, as before)
const MT_DIET = params.get("mtdiet") !== "0";
// (DYS-149: the hand-over restyle) the style sheets this router puts in while the site runs (reader.css at the boot,
// world.css with a page spot's files) go in as their text without the @font-face rules the document already has
// (shared/faces.js: each repeat loaded its font file again and restyled and laid out the whole document as it ended),
// the prefetched one at idle with its restyle there (putSheet). ?restyle=0: a <link> each, as before (RESTYLE, read in
// faces.js for notebook.js too)
const norm = (p) => p.replace(/\/index\.html$/, "/").replace(/\/+$/, "") || "/";

const NEVER_WAIT = 120;           // ms: a click waits this long for the 3D, then dissolves instead
const CUT = 150;                  // ms: reduced motion's fade
const HANDOVER_MS = 500;          // ms: the photograph -> 3D crossfade at boot (handover-r1), eased
const HANDOVER_WAIT = 1200;       // ms: at most this long after the room has refined for the window's tiles
const HANDOVER_MAX = 8000;        // ms: at most this long after the 3D is live for its picture to refine
const WINDOW_FADE_MS = 2000;      // ms: after the handover, the photograph's window dissolves into the live view
const WINDOW_WAIT = 4000;         // ms: the framing ease waits at most this long for that
const WAKE_MS = 700;              // ms: after the handover's crossfade, the laptop's page and the phone's lock screen wake (handover-r2)
const LEAN_FOLD_GAP = 8;          // px: DYS-182/186, a room taller than the screen, leaned in at the laptop: the band's foot above the screen's (leanFrame)
// DYS-193: leanFrame's band rule on its own, pure, so scripts/live/lean_frame_test.mjs runs this very rule in node.
// w x h: the room's size; mh: the masthead's box height, words: its words' (the box less its top padding); below: px of
// the room under the first screen (roomBelowFold, 0 when near); inset: the home bar's (foldInset). leanPose's band.
export const leanNear = (w, h) => w >= h && h >= 600;
export function leanBand({ w, h, mh, words, below = 0, inset = 0 }) {
  return leanNear(w, h) ? { top: 56, bottom: Math.ceil(words) + 8, near: true } : { top: 56, bottom: Math.max(mh + 12, below + LEAN_FOLD_GAP + inset) };
}
// DYS-81: the desk's photograph leaves the compositor once the live room has covered it this long (photoLayers); the
// canvas's own fade in (150 ms, the handover's HANDOVER_MS) is over well before (DYS-107: a page document's own
// photograph too; the Projects page's own screen's fade, 320 ms, and its live page's dissolve, 450 ms, as well)
const PHOTO_OFF_MS = 1000;
// (DYS-161 memory) a phone zoomed with the room wholly out hides the room's layers on the page (roomFade, sfw-room-out)
const ROOM_OUT = params.get("roomout") !== "0";
// (DYS-161 memory, OP1) ... and its two link layers stay hidden until the fade in is over (roomFade, sfw-links-wait)
const LINKS_WAIT = params.get("outpeak") !== "0";
// (DYS-161 memory) ... and once the room has been wholly out this long, its textures go from the GPU (engine.js dropRoom;
// the engine's own switch, ?roomdrop=1, off by default); a zoom out brings them back and the fade in waits for them (roomFade)
const ROOM_DROP_MS = 8000;
const ABOUT_IDLE = 800;           // ms of quiet before /#about leans to the notebook
const BEACON_LATEST = 10000;      // ms: DYS-149's beacon is asked for by then even while the room still starts (loadBeacon)
// DYS-24: /projects/ starts the room leaned in at the laptop. DYS-43 (Akshay 28 Oct: no reading sheets anywhere, phones
// included): a slow start keeps the scene's colours and lands at the laptop whenever the room comes, as a quick one
// does; only a start still not done after this long (a safety, not a wait anyone should see) leaves for the Projects
// page itself, projectsPage. (index.html's 10 s safety leaves the colours to the router once it has them.)
const LEAN_BOOT_MAX = 30000;
// DYS-24: who starts leaned in there: wherever the room itself will start, motion allowed, on a device it starts on
// (bootTier: Save-Data, 2G or under 4 GB keep the photographs, bootLive) so a visit that will only ever have the
// photographs keeps today's first paint (the desk's photograph and the sheet), never the scene's bare colours first.
// Desktops and phones alike (phones: their way between spots is the same lean-in, at the laptop its page in its
// narrow layout; Quotes, the model, already starts at the print on both). index.html's first paint asks the same.
// (DYS-24 option a, on DYS-26: asked for /?page=projects only; an essay's address has DYS-26's own test, roomLikely.)
const leanable = () => !reducedQ.matches && bootTier() !== "T0";
// the pages the homepage can host (their page modules), and the scene.json view each one's photograph is
const PAGE_MODULE = { shelf: "/books/page.js", print: "/quotes/page.js" };
const PAGE_VIEW = { shelf: "books", print: "quotes", laptop: "projects" };
// (v3/qa-nav) the pages a 3D-capable visit reads in this document (/?page=<name>), their spots and their addresses
const PAGE_AT = { books: "shelf", quotes: "print", projects: "laptop" };
const PAGE_URL = { shelf: "/books/", print: "/quotes.html", laptop: "/projects/" };
// DYS-151 (Akshay's iPhone, 29 Oct: Quotes came in as its own document, then the whole page reloaded from scratch;
// WebKit's per-tab memory limit, most likely): three changes for phones (a coarse pointer and a screen whose short side
// is under 600 px: shared/device.js, the engine's tier and the beacon's rule too; DYS-171, review finding 8: it was at
// most 640 px here), each behind its own switch, kept for the visit as ?3d= is: =1 the old way, =0 the new way on any
// device (QA); without one, phones get the new way and every other device the old (desktops: nothing changes)
//   (a) ?pagelive: on a phone a page's own document (Books, Quotes, Projects) keeps its photograph, no second live room
//       while the homepage's may still be held for Back (bootLive)
//   (c) ?pagenav: on a phone a page this document could not read while its room starts or runs still comes as its own
//       document (the page the visitor asked for), but in place of this one (location.replace) and with this room's GPU
//       context let go first: no room kept for Back while that page loads (hostEarly)
//   (d) ?relive: (item 5) on a phone, once a document of this visit has died with its room up and on screen (it never
//       said pagehide nor went out of sight: iOS's memory kill, then the browser reloading the address), the visit keeps
//       its photographs: the reload shows the visitor where they were, with no second room there to be killed (bootLive)
//       (DYS-151 review, finding 1: for ROOM_LOST_FOR from that death, not the tab's whole life; and only a load that
//       began within ROOM_DIED_WITHIN of the room's last sign of life counts as one)
function phoneSwitch(name) {
  let v = params.get(name);
  try { if (v === "0" || v === "1") sessionStorage.setItem(`sfw-${name}`, v); else v = sessionStorage.getItem(`sfw-${name}`); } catch { /* storage blocked */ }
  if (v === "0" || v === "1") return v === "0";
  return phoneNow();
}
const PAGE_STILL = phoneSwitch("pagelive");   // (a) on: a page document stays on its photograph
const PAGE_SWAP = phoneSwitch("pagenav");     // (c) on: a page that can't be read here replaces this document, its room let go
const ROOM_GUARD = phoneSwitch("relive");     // (d) on: a room that died on screen is not started again in this visit
const ROOM_UP_KEY = "sfw-room-up";            // sessionStorage (d): when this tab's room was last seen starting or running on screen (ms)
const ROOM_LOST_KEY = "sfw-room-lost";        // sessionStorage (d): when a document of this visit died with its room on screen (ms)
// (DYS-151 review, finding 1: both marks were "1" and the lost one was never taken off: one stale up mark (Safari swiped
// away in the app switcher with the room on screen fires neither pagehide nor hidden) kept that tab on its photographs for
// good. They are times now:)
const ROOM_UP_EVERY = 5000;            // ms: the up mark is written again this often while the room starts or runs, seen (roomMark)
const ROOM_DIED_WITHIN = 20000;        // ms: a load that began this soon after the last up mark is the browser's reload of a
                                       // document that died on screen (iOS reloads at once); later, a new visit to the tab
// (DYS-151 review: how long a death on screen keeps the visit on its photographs, Akshay's open question. 15 min covers
// the rest of the visit it happened in (the reload, then reading around on the photographs: a visit is minutes) without
// following the tab into a later visit (Safari keeps a tab's sessionStorage for days); a room that dies again after it
// costs one more reload and 15 more minutes. The one number to change: Infinity for the tab's life, 0 for none)
const ROOM_LOST_FOR = 15 * 60000;
// (d) whether this visit has lost a room on screen: an up mark a document left behind when it died (roomMark: taken off by
// pagehide and by going out of sight) becomes the visit's lost mark when this load began within ROOM_DIED_WITHIN of it;
// a lost mark counts for ROOM_LOST_FOR, then goes. Read once per document (boot's roomLikely, then bootLive), before this
// document's own room writes its up mark. (the marks of the version before, "1", are old times: neither counts)
let roomLostHere = null;
function roomLost() {
  if (roomLostHere !== null) return roomLostHere;
  roomLostHere = false;
  try {
    const now = Date.now(), began = Math.round(performance.timeOrigin) || now;
    const up = +sessionStorage.getItem(ROOM_UP_KEY) || 0;
    if (up) {
      sessionStorage.removeItem(ROOM_UP_KEY);
      if (began >= up - 1000 && began - up < ROOM_DIED_WITHIN) sessionStorage.setItem(ROOM_LOST_KEY, String(now));
    }
    const lost = +sessionStorage.getItem(ROOM_LOST_KEY) || 0;
    if (lost && now >= lost && now - lost < ROOM_LOST_FOR) roomLostHere = true;
    else sessionStorage.removeItem(ROOM_LOST_KEY);
  } catch { /* storage blocked */ }
  return roomLostHere;
}
const FLICK_ORDER = ["shelf", "desk", "print"];
const ZOOM_KEY = 0.15;            // m per press of + or -
// v3/zoom: the window's magnifier (shared/zoom.js, loaded the first time someone magnifies): its cap on desktops;
// ?zoom=0 turns it off (the dolly alone, as before), ?zoomcap=N pins the cap (QA)
const MAG_DESKTOP = 4;
// (DYS-161: a phone at the window magnifies to the desktop's 4x view: as tall as a desktop's window at 4x. Every
// desktop frames the window at rest with this tanV (framing.js: 1440x900 and 1920x1080 alike, 28.41 deg tall), so its 4x
// view is 7.24 deg tall; a portrait phone's rest view is 55.79 deg tall (tanV 0.5294), so its cap is 4 x 0.5294 / 0.2531
// = 8.37x (and its 2x-desktop view 4.18x). Measured as the view's height, not its width: there the portrait phone's
// 8.37x shows 4.25 deg across against the desktop's 11.56, and at about 1.4 of the 4x squares' pixels to a screen pixel
// (183 px/deg drawn at the phone's DPR 2, the squares 256) where the desktop's 4x has 1.0 (248 px/deg): the same detail)
const DESK_TANV = 0.2531;
const MAG_PIN = params.get("zoom") === "0" ? 1 : +params.get("zoomcap") || 0;
// v3/zoom-r3 (outside only when zoomed): the desk magnifies too; zoomed, the room (its 3D and its own layers on the page)
// fades out over ROOM_FADE_MS and the outside alone fills the screen; back at 1x it fades in (reduced motion: 150 ms)
// (v3/zoom-r4, Akshay 23 Oct: "if i just opened the website ... and havent clicked anywhere - if i zoom - it should just
// zoom me in the room"; "once ive tapped on the window - then - the outside view": only the window spot magnifies; at the
// desk and every other room spot a zoom walks toward what is under the pointer, rig.js walkBy)
const MAG_SPOTS = new Set(["window"]);
// DYS-33 / DYS-31: the Quiet version's page for what the reading sheet would have shown (Reader.open's argument: an
// essay's slug, or one of the site's own pages by its slug), or, with nothing, for this address (Reader.route's)
function quietURL(what) {
  const slug = typeof what === "string" ? what : what?.slug || null;
  const project = () => (location.hash.match(/^#\/project\/([a-z0-9-]+)/) || [])[1] || null;
  if (slug === "about") return "/simple/";
  if (slug === "social") return "/simple/hi/";
  if (slug === "writing") return "/simple/writing/";
  if (slug === "projects") return project() ? `/simple/projects/${project()}/` : "/simple/";
  if (slug && /^[a-z0-9][a-z0-9-]*$/.test(slug)) return `/simple/writing/${slug}/`;
  const path = location.pathname, essay = (path.match(/^\/writing\/([a-z0-9][a-z0-9-]*)\/?$/) || [])[1];
  if (essay) return `/simple/writing/${essay}/`;
  if (/^\/writing\/?$/.test(path)) return "/simple/writing/";
  if (/^\/books\//.test(path)) return "/simple/books/";
  if (/^\/quotes/.test(path)) return "/simple/quotes/";
  if (location.hash === "#social") return "/simple/hi/";
  return project() ? `/simple/projects/${project()}/` : "/simple/";
}
// the ceiling (v3/zoom-r2's honest limits, docs/v3/briefs/zoom-r2-report.md): a layer of the outside still looks sharp
// magnified while it has at least SHARP_PX of its own pixels per CSS px (measured on a 2x screen against the 4x tiles:
// 70 % of the fine detail left, for the 64 px/deg city and the 88 px/deg near layer alike); phones are held closer, so a
// CSS px looks about SHARP_COARSE times larger there and the layer needs that many more. The view's ceiling is the
// lowest over its middle (3 x 3 points at +-10 % of the screen: zoom-r2's +-20 % kept a view centred on the bridge's
// tower at the desk under 2.7x, its top row in the sky over the 4x tiles); it only stops a zoom in. ?zoomhonest=0 lifts
// it (QA).
const SHARP_PX = 1.12, SHARP_COARSE = 1.42, CEIL_AT = [-0.1, 0, 0.1];
const ZOOM_HONEST = params.get("zoomhonest") !== "0";
// the spot whose framing showed the homepage's words beside it (the About card): none since interactions B (the bio
// lives on the name; the notebook is his writing)
const BIO_SPOT = null;
const LEAN_S = 1.4;               // s: the glide into and out of the laptop (a person leaning in)
const SCREEN_KEY = "sfw-laptop";  // sessionStorage: what the laptop's screen shows, kept across the site's documents
// what lights up when the pointer (or keyboard focus) is on a spot's object, or on the lamp (gl/sheen.js names)
// (the window: its opening, the view; R1's "window" object is the whole window wall, down to the floor)
const LIGHT = { shelf: ["shelf", "books"], laptop: ["laptop", "screen"], print: ["print"], notebook: ["notebook"], window: ["opening"], lamp: ["lamp"], desk_book: ["desk_book"],
  phone: ["phone"], headphones: ["headphones"], breadboard: ["breadboard"] };
const LIGHT_K = { window: 0.45 };   // (the whole view is a large part of the screen: its lift is gentler, about +7 %)
// the first visit's glint crosses these, in their order on screen (masthead-r2: and Poor Charlie's Almanack, the way to
// the shelf now that Books left the menu; gl/sheen.js takes a fifth object)
const GLINT = ["laptop", "notebook", "phone", "print", "desk_book"];
const GLINT_KEY = "sfw-glint";    // localStorage: the glint was seen
const GLINT_AFTER = 2000;         // ms the live room is at rest at the desk before it
// the lamp at dusk: below this sun altitude (degrees) it is on, as a person would switch it on; a click wins for the visit
const LAMP_ALT = 2;
const LAMP_KEY = "sfw-lamp";      // sessionStorage: the visitor's own switch (0 or 1)
const LAMP_FADE = 200;            // ms: a click's soft fade (gl/interact.js)
// (DYS-138) the lamp's state on <html> (data-lamp "on" / "off"), for the corner link's ink where the lamp lights its
// backdrop (style.css: the ceiling on portrait screens)
const markLamp = (on) => { document.documentElement.dataset.lamp = on ? "on" : "off"; };
// the leaned-in spots, where the masthead goes quiet (not the desk, nor the window, where its dial is the point)
const QUIET = new Set(["shelf", "laptop", "print", "notebook", "phone"]);
const CARD_MS = 450;              // the name's card growing from the name (shrinking back: CARD_MS - 50)
const SOFT = "cubic-bezier(0.45, 0, 0.25, 1)";

// masthead-r2: without the live room the menu's plain links (Projects, Books, Quotes) are back (shared/sky-head.js)
// (DYS-31: and its links lead to the simple website, shared/sky-head.js)
const plainMenu = () => { document.documentElement.classList.remove("sfw-room-menu"); window.__sfwSimpleMenu?.(); };

function engineModule() {
  // ?3d= (0, standin) is remembered for the visit, so a test or a debug session keeps it across page loads
  let p = params.get("3d");
  try { if (p) sessionStorage.setItem("sfw-3d", p); else p = sessionStorage.getItem("sfw-3d"); } catch { /* storage blocked */ }
  if (p === "0") return null;
  if (p === "standin") return "/dev/standin.js";
  return "/shared/gl/engine.js";   // E1's engine (docs/v3/engine-api.md); missing until it lands: photo mode
}

// DYS-29 mock (?shelfmock): the shelf centred in the free part of the screen and as large as fits there (today's framing
// keeps the lens's own field and the shelf right of a column for the book card). Same eye and look as the spot's framing
// (shared/framing.js); only the field and the lens shift change, as framing.js itself does for cards.
function mockShelfFrame(room, vp) {
  const pose = frameSpot(room, "shelf", vp);
  // each corner's tangents from the eye (x right, y up): project() at a unit field, no shift, on a 2 x 2 screen
  const T = (room.points("shelf") || []).map((p) => project({ ...pose, tanV: 1, shiftTan: [0, 0] }, p, 2, 2));
  if (!T.length || T.some((q) => !q)) return pose;
  const xs = T.map((q) => q[0] - 1), ys = T.map((q) => 1 - q[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const F = freeRegion(vp), a = vp.w / vp.h;
  const tanV = Math.max((x1 - x0) / (2 * a * ((F.R - F.L) / vp.w)), (y1 - y0) / (2 * ((F.B - F.T) / vp.h)));
  const fx = ((F.L + F.R) / 2 - vp.w / 2) / (vp.w / 2), fy = ((F.T + F.B) / 2 - vp.h / 2) / (vp.h / 2);
  return { ...pose, tanV, shiftTan: [(x0 + x1) / 2 - fx * tanV * a, (y0 + y1) / 2 + fy * tanV] };
}

const CSS = `
.sfw-canvas { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 0; display: block; opacity: 0; pointer-events: none; transition: opacity 150ms ease; }
.sfw-canvas.is-on { opacity: 1; }
/* v3/zoom-r3: zoomed, the room's own layers on the page (its links, the laptop's page, the notebook's index, the phone's
   screen, the LED, the sheen) fade with the room and take no pointer; the page's own (masthead, card, buttons, the
   Quiet version's corner link: DYS-31) stay */
.is-live.sfw-zoomed > :not(canvas):not(.stage):not(.masthead):not(.veil):not(.tip):not(.sfw-close):not(.sfw-about):not(.sfw-edges):not(.quiet-corner) { filter: opacity(var(--sfw-room, 1)); pointer-events: none !important; }
/* (DYS-161 memory: on a phone, once the room is wholly out (the fade done, --sfw-room 0: roomFade, sfw-room-out) the
   same layers are hidden as well: at opacity 0 they kept their compositing layers' backing stores, at the screen's own
   scale (3x on most iPhones); hidden, they have none. Back from the fade in's first step. One holding the keyboard's
   focus stays as it was) */
.is-live.sfw-room-out > :not(canvas):not(.stage):not(.masthead):not(.veil):not(.tip):not(.sfw-close):not(.sfw-about):not(.sfw-edges):not(.quiet-corner):not(:focus-within),
.is-live.sfw-room-out > :not(canvas):not(.stage):not(.masthead):not(.veil):not(.tip):not(.sfw-close):not(.sfw-about):not(.sfw-edges):not(.quiet-corner):not(:focus-within) * { visibility: hidden !important; }
/* (DYS-161 memory, OP1: on a phone the room's two link layers (links.js: outlines filled transparent, nothing of them
   drawn) are hidden while the room is not wholly in (the fade out and in, and between: sfw-links-wait), shown once it
   is. With the rest of the room's layers they were shown again at the fade in's first step and painted again at each
   step after: each a full-screen backing store at the screen's scale, three of them for about a second (WebKit as an
   iPhone SE / 12 mini, OP1: the GPU process's IOSurfaces up 28-36 / 75-80 MB at the fade in, 12 / 25 MB of it kept at
   1x). They take no pointer meanwhile anyway (sfw-zoomed); one holding the keyboard's focus stays as it was) */
.is-live.sfw-links-wait > .sfw-links:not(:focus-within) { visibility: hidden !important; }
/* the boot's handover from the photograph (handover-r1): the refined 3D, at the photograph's own camera, fades in */
.sfw-canvas.sfw-handover, html.sfw-handing .sfw-screen { transition: opacity ${HANDOVER_MS}ms ${SOFT}; }
/* handover-r2: then the laptop's page wakes over the 3D's own picture of the screen */
html.sfw-waking .sfw-screen { transition: opacity ${WAKE_MS}ms ${SOFT}; }
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
/* DYS-81: the room's steady state (photoLayers): the desk's first-paint photograph under the opaque canvas, out of the
   compositor. Its layers (~1600x900 each, with will-change and the parallax's translate3d) were composited on every
   frame under the room; hidden and with neither, nothing of it is painted or composited. Every piece in it is hidden,
   whatever its own visibility (the desk's print, .sky-print.is-set, while it is still on the photograph): without the
   layers' stacking contexts a visible piece would paint over the room. #stage itself stays visible, as do all the boxes
   (visibility, not display): it is still measured (app.js, transition.js) and still what a touch on the room lands on
   (its touch-action above) */
html.sfw-photo-off #stage * { visibility: hidden !important; }
html.sfw-photo-off #stage .layer { will-change: auto; transform: none !important; }
/* DYS-107: the same on a page document (Books, Quotes or Projects opened as its own document: body.page; the pages the
   homepage hosts are .sfw-page boxes, whose photograph the rules below already hide under the room): the page's own
   photograph (room.js's .room-stage in the page's .room, the box the canvas is placed in, placeCanvas) lies under the
   opaque canvas too. Its pictures (the photograph, its blurred preview) are hidden; the stage's box, its transform and
   the .room around it stay as they are (visibility, not display): the page lays out from its room's box and its own
   geometry (room.js layout, geo), not from the stage's pixels, and a touch on the room lands on the same element. The
   page's overlays (the Books spines with their cut of the photograph, the Quotes print and pager, the Projects page's
   own screen) are outside the stage and stay as they are */
html.sfw-photo-off body.page .room > .room-stage * { visibility: hidden !important; }
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
/* (DYS-164 follow-up) the laptop's page pinched large on a touch screen (html.sfw-mast-aside) puts its white under the
   pill: the glass turned grey there and its words read 2.2:1, so it goes near-solid (words 12.4:1 on the white, 16.9:1
   on the darkest night; 15.6:1 hovered); the focus ring dark with a light gap, seen on either. Size, place, words as
   everywhere (the pill's own colours: --ink and --paper swap at night) */
html.sfw-mast-aside .sfw-close { background: rgba(18, 13, 9, 0.88); }
html.sfw-mast-aside .sfw-close:hover { background: rgba(18, 13, 9, 0.96); }
html.sfw-mast-aside .sfw-close:focus-visible { outline-color: #120d09; box-shadow: 0 0 0 3px #f4efe6; }
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
/* DYS-164: a touch screen at the laptop, its page pinched larger than the lean-in: the page's white fills the screen and
   the masthead's light words sat on it unread, so it steps aside (the same fade, no taps) until the page is back */
html.sfw-mast-aside .masthead { opacity: 0; visibility: hidden; transition: opacity 0.6s ${SOFT}, visibility 0s linear 0.6s; }   /* (hidden after the fade: no focus, not read out) */
html.sfw-mast-aside .masthead, html.sfw-mast-aside .masthead * { pointer-events: none !important; }
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
/* (v3/qa-nav) a page brought in before the room is ready: its own photograph and overlays, as on its own document
   (it takes the pointer, so nothing reaches the desk's photograph under it); when the room hands over, the
   photograph fades out over the room's first frame, which is that photograph's own camera */
.sfw-page.sfw-own .hero, .sfw-page.sfw-own .hero > .room { pointer-events: auto; }
.sfw-page.sfw-own .hero .room-stage { visibility: visible; transition: opacity var(--sfw-own-ms, 500ms) ${SOFT}; }
.sfw-page.sfw-own .spine .img { display: revert; transition: opacity var(--sfw-own-ms, 500ms) ${SOFT}; }
.sfw-page.sfw-own.sfw-own-out .hero .room-stage, .sfw-page.sfw-own.sfw-own-out .spine .img { opacity: 0; }
/* (v3/qa-nav) the essays' list in the reading sheet while the room is still starting (the static /writing/ page's) */
.sfw-wr-list { list-style: none; margin: 0; padding: 0; }
.sfw-wr-list li { margin: 0 0 1.6em; }
.sfw-wr-list a { display: block; color: inherit; text-decoration: none; }
.sfw-wr-list .sfw-wr-t { display: block; font-size: 1.35em; font-weight: 500; line-height: 1.2; text-wrap: balance; }
.sfw-wr-list a:hover .sfw-wr-t { color: var(--rd-accent, inherit); }
.sfw-wr-list .sfw-wr-s { display: block; margin-top: 0.3em; font-style: italic; opacity: 0.72; }
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
    this.letGo = false;            // DYS-171: (c) let this document's room go for the page's own document (bootLeft)
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
      this.wpHash = location.hash;   // (DYS-80: the address below drops it; an essay sent back to its own page keeps it, essayPage)
      history.replaceState({ sfw: 1, spot: "notebook" }, "", `/writing/${slug}${keep.toString() ? "?" + keep : ""}`);
    }
    // (v3/qa-nav) a page's own head sent a browser that can run the room here (/?page=books|quotes|projects): its own
    // address again at once; Books and Quotes come in over their own photographs (hostEarly, below: their HTML is
    // asked for now), Projects opens in the reading sheet over the desk
    const pp = this.doc === "home" ? params.get("page") : null;
    if (pp && PAGE_AT[pp]) {
      const keep = new URLSearchParams(location.search); keep.delete("page");
      this.bootPage = PAGE_AT[pp];
      // DYS-24: Projects, where the room will start (leanable: desktops and phones, motion allowed; index.html's first
      // paint asks the same), starts the room leaned in at the laptop (leanBoot: "laptop", the spot it starts leaned in
      // at, until the room has come in there, or given up on it, leanOff; then false); its first paint is the scene's
      // colours and the masthead, the desk's photograph hidden (index.html). (DYS-24 option a, on DYS-26: the laptop
      // only; an essay's address is DYS-26's lifted page below.)
      this.leanBoot = this.bootPage === "laptop" && leanable() ? "laptop" : false;
      // (Projects elsewhere: the desk's entry until the room has leaned in behind the sheet, behindProjects)
      history.replaceState({ sfw: 1, spot: PAGE_MODULE[this.bootPage] || this.leanBoot ? this.bootPage : "desk" }, "", PAGE_URL[this.bootPage] + (keep.toString() ? "?" + keep : "") + location.hash);
      if (PAGE_MODULE[this.bootPage]) this.loadPage(this.bootPage).catch(() => {});
    }
    const deep = this.doc === "home" ? (location.pathname.match(/^\/writing\/([a-z0-9][a-z0-9-]*)\/?$/) || [])[1] || null : null;
    // (DYS-26, Akshay 28 Oct: a refresh on an essay opened the old flat sheet, which never went back into the notebook)
    // a browser that will start the room gets the lifted page as it stands open, the room coming on behind it at the
    // notebook; one that won't, or if the page can't be shown, the essay's own page, essayPage (DYS-80, Akshay 28 Oct:
    // no reading sheets anywhere, phones included; the static page's head sends here those under 4 GB or on 2G, which
    // it doesn't test)
    // (DYS-27: on a phone the head painted that page's paper from the first paint, html.sfw-pre-sheet: the lifted page's
    // whole-screen paper where the room will start, sfw-pre-lift, else the reading sheet's; it goes once the page is up,
    // and stays while this document leaves for the essay's own page, so nothing flashes in between)
    // (DYS-151 review, finding 7: nor after a room of this visit died on screen, roomLost, which bootLive will refuse: the
    // essay's own page straight away, not the lifted page first and the essay's page once the boot has said no)
    const roomLikely = !!engineModule() && !navigator.connection?.saveData && bootTier() !== "T0" && this.mode !== "still" && !(ROOM_GUARD && roomLost());
    const root = document.documentElement, preSheet = (ms) => setTimeout(() => root.classList.remove("sfw-pre-sheet", "sfw-pre-lift"), ms);
    if (deep && roomLikely) this.essayShown = this.liftEssay().then((L) => L.show(deep)).then(() => { preSheet(0); return true; }, () => { this.essayPage(deep); return false; });
    else if (deep) return this.essayPage(deep);
    else preSheet(0);
    // the menu's About and Social (nav-r1): from the first click, on every document; /#social goes to the phone once
    // the room is up, and /#about (v3/laptop-phone) to the laptop at About, or his bio in the reading sheet without it
    document.addEventListener("click", (e) => this.onMenu(e), true);
    const menuLink = this.doc === "home" && norm(location.pathname) === "/" ? location.hash : "";

    // v3/loading: the first visit's loading line and introduction (shared/firstvisit.js), only with ?firstvisit=a|b
    const fvm = this.doc === "home" ? params.get("firstvisit") : null;
    if (fvm === "a" || fvm === "b") this.fv = await import("./firstvisit.js").then((m) => m.install(this, fvm)).catch(() => null);
    // (v3/firstvisit-a2: laptop first, shared/firstvisit-a2.js, when app.js opened close on the laptop)
    // (without the opening, it decides: reduced motion's names on a first visit, else nothing)
    // (DYS-12: for every first visit now: when app.js opened close, or (reduced motion, names only) on the bare homepage)
    else if (fvm !== "0" && (this.o.firstVisit || (reducedQ.matches && location.pathname === "/" && !location.hash && !params.has("page") && !params.has("writing"))))
      this.fv = await import("./firstvisit-a2.js").then((m) => m.install(this)).catch(() => null);
    this.room = await loadSpots().catch(() => null);
    // (DYS-24 / DYS-43: the room was to come in at the laptop: not without spot data, the Projects page itself; DYS-118:
    // nor is there a notebook for an essay's lifted page to settle into, shown above, essayPage)
    if (!this.room) { if (deep) return this.essayPage(deep); if (this.leanBoot) return this.projectsPage(); if (menuLink === "#about") this.openAbout({ fresh: true }).catch(() => {}); return; }   // no spot data: the pages work as they are
    if (this.doc === "home") this.nameButton();
    this.spot = this.doc === "home" ? spotForURL(this.room, location.href, history.state) || "desk" : { books: "shelf", quotes: "print", projects: "laptop" }[this.doc];
    // (v3/qa-nav: or the page this document was opened for, Books or Quotes; Projects starts at the desk, its sheet open)
    // (DYS-24: or, where the room will start leaned in there, leanable, Projects at the laptop)
    if (this.doc === "home" && this.spot !== "desk" && !["window", "notebook"].includes(this.spot) && !(this.spot === this.bootPage && (PAGE_MODULE[this.spot] || this.leanBoot))) this.spot = "desk";
    window.__sfwDeskHidden = "router";   // (index.html's safety timeout leaves the class to the router from now)
    if (this.bootPage && PAGE_MODULE[this.bootPage] && this.spot === this.bootPage) this.hosting = this.hostEarly(this.bootPage, { push: false });
    // (DYS-24: the room to come in at the laptop: the desk's photograph stays hidden; DYS-43: still starting after
    // LEAN_BOOT_MAX, the Projects page itself)
    else if (this.leanBoot && this.spot === this.leanBoot) this.leanT = setTimeout(() => { if (this.mode === "booting") this.projectsPage(); }, LEAN_BOOT_MAX);
    else { this.leanBoot = false; deskHidden(false); }
    this.bootSlug = (location.hash.match(/^#\/project\/([^/?#]+)/) || [])[1] || null;
    // (DYS-43: /?page=projects where the room will not start leaned in there: the Projects page itself, not the sheet)
    if (this.bootPage === "laptop" && !this.leanBoot) return this.projectsPage();
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
    // (DYS-81: and the desk's photograph back under the room while motion is reduced, photoLayers)
    reducedQ.addEventListener?.("change", () => { if (reducedQ.matches && this.mode === "photo") this.mode = "still"; this.photoLayers(); });

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
    this.beaconT = setTimeout(() => this.loadBeacon(), BEACON_LATEST);   // (DYS-149: a room still starting by then)
    const live = await this.ready;
    this.loadBeacon();
    // (DYS-151 review, finding 5: a page's own document on a phone, (a) pageStill, is on its photograph by choice, not
    // because the room failed: the menu keeps the room's links, and the visit's room-off mark below stays as it was, so
    // the masthead and later essays still lead to the room)
    if (!live && !this.pageStill) { plainMenu(); this.fv?.bootFailed(); }
    // (DYS-24 / DYS-43: no live room after all: the Projects page itself)
    if (!live && this.leanBoot) return this.projectsPage();
    if (menuLink === "#social") this.arriveSocial(live).catch(() => {});
    // (v3/qa-nav) a shared Projects link read in its sheet: the room leans in to the laptop behind it (DYS-24: not when
    // the room started there; given up on, leanOff, the sheet is open and it does)
    if (live && this.bootPage === "laptop" && !this.leanBoot && this.spot === "desk") this.behindProjects().catch(() => {});
    if (menuLink === "#about") this.arriveAbout(live).catch(() => {});
    if (live) setTimeout(() => this.prefetchPages(), 3000);   // (DYS-60: after first paint and the room's start)
    // (the static writing pages send a browser here only while this visit's room has not failed to start; DYS-80: nor
    // once this document is leaving for an essay's own page, essayPage, whose mark a room that came meanwhile keeps)
    try { if (this.pageStill) { /* (DYS-151 review: (a), as above) */ } else if (live && !this.toEssayPage) sessionStorage.removeItem(ROOM_OFF_KEY); else sessionStorage.setItem(ROOM_OFF_KEY, "1"); } catch { /* storage blocked */ }
    if (!live && this.doc === "home" && this.spot === "notebook") {
      // no live room: an essay is its own page, essayPage (DYS-80, Akshay 28 Oct: no reading sheets anywhere; a lifted
      // page shown at the refresh has no notebook to settle into and goes with this document), the list of essays its
      // static page (as is the list a lifted page closed to before the room failed: the address says which)
      const slug = (location.pathname.match(/^\/writing\/([a-z0-9][a-z0-9-]*)\/?$/) || [])[1];
      if (slug) return this.essayPage(slug);
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
    window.__sfwRouterUp = 1;   // (masthead-r2: the room's menu stays; sky-head.js's safety brings the plain links back otherwise)
    const url = engineModule();
    const save = navigator.connection?.saveData;
    if (!url || save || bootTier() === "T0" || this.mode === "still") return false;
    // (DYS-151 (a): a page's own document on a phone keeps its photograph and its page, as the photo mode does, PAGE_STILL:
    // a second room here, with the homepage's possibly still held for Back, is the likely way past WebKit's memory limit)
    // (DYS-151 review, finding 5: pageStill, so boot leaves the menu and the room-off mark alone)
    if (this.doc !== "home" && PAGE_STILL) { this.pageStill = true; console.warn(`[DYS-151] ${location.pathname} as its own document on a phone: no live room here (?pagelive=1 for the old way)`); return false; }
    // (DYS-151 item 5 (d), ROOM_GUARD: a room of this visit died on screen, roomLost: the photographs from here, so the
    // browser's reload keeps the visitor where they were (Quotes over its own photograph) rather than a second boot being
    // killed in turn, the next reload landing at the desk: Akshay's recording, 29 Oct, 33-38 s)
    if (ROOM_GUARD && roomLost()) { console.warn("[DYS-151] the live room died on screen earlier in this visit: the photographs from now (?relive=1 for the old way)"); return false; }
    // the real engine boots only once there is a room to draw (room3d.json names its asset set; ?bake= for
    // testing): until then every visitor keeps the photographs and downloads none of the 3D
    const bake = params.get("bake") || this.room.data.bake || null;
    // the view outside needs its panorama (docs/v3/outside.md): without one the window would show the desk's photograph
    const pano = params.get("pano") || this.room.data.pano || null;
    if ((!bake || !pano) && !url.includes("standin")) return false;
    this.mode = "booting";
    this.fv?.bootStart();
    // (DYS-161: DYS-151 item 6's probe of the browser's frame interval went with the magnifier cap's frame-rate term,
    // its only reader: magCap)
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
      if (this.letGo) return this.bootLeft();   // (DYS-171: leaving, before any GPU context of its own)
      if (!mod.engineSupport().ok) throw new Error("unsupported");
      const canvas = el("canvas", { class: "sfw-canvas", "aria-hidden": "true" });
      this.placeCanvas(canvas);
      // (DYS-151 item 5 (d)) from the room's first GPU memory on, the tab's mark that it is up and on screen (roomMark)
      if (ROOM_GUARD) this.roomMark();
      const engine = await mod.createEngine({ canvas, tier: "auto", reducedMotion: "auto" });
      // tex: the room's textures from their lighter copies (light-load; room3d.json "tex", ?tex=0 for the originals)
      const tex = params.get("tex") === "0" ? null : params.get("tex") || this.room.data.tex || null;
      const fv = this.fv;
      const roomP = engine.loadRoom({ bake, tex, onProgress: fv && ((got, total) => fv.progress("model", total ? got / total : 0)),
        onItems: fv && ((n, of) => fv.progress("tex", of ? n / of : 0)) });
      // the view outside (stream X1): the panorama through the live camera, the city's events, the halo. Added before
      // the warm-up, so its shaders compile and draw in the warm-up's hidden frames. On the homepage it starts from the
      // exterior pictures on screen (the same pixels); a page's photograph has its view baked in, so tiles at once.
      // (handover-r1: made while the model loads, not after it: it needs only the GL context to start, and its
      // panorama files then come in alongside the model's)
      if (pano && engine.gl) {
        // (v3/qa-nav: the homepage document opened at Books or Quotes starts, as their own documents do, on tiles: the
        // desk's photograph is not what is on screen)
        // (DYS-24: nor at the laptop, where the room starts leaned in: tiles too)
        const deskShot = this.doc === "home" && !PAGE_MODULE[this.spot] && !(this.leanBoot && this.spot === this.leanBoot);
        const photo = deskShot ? this.o.photo?.() : null;
        outsideP = mods.outside.then(({ createOutside }) => createOutside(engine, {
          pano, viewKey: photo?.view === "home_p" || photo?.view === "home_m" ? photo.view : "home_l",
          scene: loadScene(),      // the scene.json the page has already fetched and parsed (one copy, read only)
          firstPaint: (deskShot && this.o.exterior?.()) || false,
          // (handover-r1: the window keeps the photograph's own pixels through the handover, released after it)
          holdFirstPaint: deskShot,
        }));
        outsideP.then(() => this.fv?.progress("outside", 1)).catch(() => {});
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
      if (moment0 && engine.prefetchMoment) engine.prefetchMoment(moment0).then(() => this.fv?.progress("light", 1)).catch(() => {});
      if (outsideP) this.outside = await outsideP;
      applyMatch(engine, await matchP);
      // the things in the room you can use (stream I): the lamp switch, book pulls, the tea steam. After loadRoom (it
      // extends the room's shaders) and before the warm-up (so those compile there). The canvas takes no pointer
      // events (the hero does: gestures, picking), so it listens there and measures from the canvas; the cursor
      // stays the router's (onHover below). Book pulls are on only at the shelf (afterLanding / leaving).
      if (engine.gl && engine.room) {
        const { createInteractions, indexShelfBooks } = await mods.interact;
        // (DYS-149: the shelf's books indexed first, a task of their own (35 ms of a 53 ms createInteractions on the
        // slow laptop), then a message, then the rest)
        const bookIndex = indexShelfBooks ? indexShelfBooks(engine) : null;
        await nextMessage();
        // pointer events over the room (the hero) and over a hosted Books page's spines (they follow the 3D shelf
        // but sit outside the hero), never over cards, the masthead or text
        const hero = this.hero, wrapped = new Map();
        const ours = (e) => {
          const t = e.target;
          if (t?.closest?.(".spine")) return true;
          return !!t && hero.contains(t) && !t.closest?.(".sfw-about, .about, .reader, .pager, .card, .masthead, a, button, input") && !this.roomHidden();
        };
        const target = {
          addEventListener: (k, fn) => { const w = (e) => { if (k === "pointerleave" || ours(e)) fn(e); }; wrapped.set(fn, w); (k === "pointerleave" ? hero : document).addEventListener(k, w); },
          removeEventListener: (k, fn) => { const w = wrapped.get(fn); if (w) (k === "pointerleave" ? hero : document).removeEventListener(k, w); },
          getBoundingClientRect: () => canvas.getBoundingClientRect(),
          style: {},
        };
        this.interact = createInteractions(engine, { canvas: target, cursor: false, books: this.spot === "shelf", bookIndex });
        this.interact.on("hover", ({ object }) => { this.useHover = object; this.setCursor(); });
        // the visitor's own switch wins over the dusk rule for the rest of the visit (lampFor)
        this.interact.on("lamp", ({ on }) => { this.lampChoice = on ? 1 : 0; markLamp(on); try { sessionStorage.setItem(LAMP_KEY, String(this.lampChoice)); } catch { /* storage blocked: this document only */ } });
        // (DYS-149: from the books' index to the warm-up was one task, 194-198 ms on the slow laptop's return visit (tu2
        // J4: the interactions 48-53, the sheen 15, the notebook 27-37 and its page turn 59-62): now each its own task,
        // in the same order,
        // a message apart. The module awaits here could always wait (a module still coming in), and the room is first
        // drawn in the warm-up, after all of them: the same room)
        await nextMessage();
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
          await nextMessage();   // (DYS-149)
          // (DYS-149: its page turn after it, addPages: the page's triangles, then a message, then the sheets)
          try { this.nb3d = nbm?.createNotebook(engine, this.room, { pagesLater: true }) || null; } catch (err) { console.warn("[notebook]", err); this.nb3d = null; }
          if (this.nb3d?.addPages) { await nextMessage(); await this.nb3d.addPages(nextMessage); }
          await nextMessage();   // (DYS-149)
          const pq = phm?.phoneQuad(engine);
          if (pq) this.room.objects.phone_screen = { ...(this.room.objects.phone_screen || {}), quad: pq };
        }
      }
      if (engine.warmUp) await engine.warmUp();   // v1.1: compile and draw once, hidden; "ready" fires at its end
      this.fv?.progress("model", 1); this.fv?.progress("tex", 1); this.fv?.progress("warm", 1);
      // the Projects document's photograph (its app lays it out as shared/pages.js says): the room starts on it
      if (this.doc === "projects" && !this.o.page?.photo) await this.projectsPhoto().catch(() => {});
      this.mast = await mods.mast.catch(() => null);
      const m = this.mast?.getMoment() || null;
      const moment = pickMoment(m?.frame, Object.keys(engine.bake?.moments || {}));
      if (moment) await engine.setLight({ moment, lamp: this.lampFor(m?.date, moment, engine), screen: 1 }, { fade: 0 }).catch(() => {});
      markLamp(engine.light.lamp > 0);
      this.screenLight(moment, 0);   // (v3/laptop-phone: the laptop's screen at this moment's brightness)
      engine.setScreenGain?.(this.screenGain(moment));   // (... and the 3D's own picture of it, before the warm-up: this.engine is set below)
      // one hidden frame in the moment's light (its sunbeams, the night glass, its light maps), so their first draws are
      // not in the first frames on screen (perf-r2, perf-prep #5)
      if (moment && engine.warmLight) await engine.warmLight().catch(() => {});
      // (DYS-151 review, finding 1) a context lost and not brought back during boot fired "fallback" before the listener
      // below: the photographs, through the catch, not a black room
      if (engine.failed) throw new Error("the room's GPU context was lost while it started");
      if (this.letGo) return this.bootLeft();   // (DYS-171: its context let go; no frames started on it)
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
      // (v3/qa-nav) a page still being brought in (the one this document was opened for, or a move while the room
      // started): the room starts once it is in, on its photograph (at most 4 s)
      if (this.hosting) await Promise.race([this.hosting.catch(() => null), wait(4000)]);
      // (DYS-171, review finding 6: that page could not be read here and (c) let this room's context go for its own
      // document, location.replace: the room is not set live on the lost context while that one loads)
      if (this.letGo) return this.bootLeft();
      this.mode = "live";
      this.fv?.ready();   // (v3/loading: the room can take over now, shown or not)
      // (before the room measures itself: on the Projects document the class takes the page's own list out of the
      // hero, which changes the room's box on phones)
      document.documentElement.classList.add("sfw-live-mode");
      this.startLive(canvas);
      performance.mark?.("sfw:room-responds");   // (DYS-149: the live room answers to input now; shared/beacon.js)
      return true;
    } catch (err) {
      if (this.letGo) return this.bootLeft();   // (DYS-171: a failure on the let-go context is not a failed room)
      if (params.has("debug")) console.warn("3D unavailable:", err && err.message);
      document.documentElement.classList.remove("sfw-live-mode");
      this.mode = reducedQ.matches ? "still" : "photo";
      this.roomMarked?.();   // (DYS-151 (d): no room up any more)
      this.photoLayers();   // (DYS-81: the photographs it stays on)
      this.outside?.dispose();
      if (!this.outside) outsideP?.then((o) => o?.dispose()).catch(() => {});   // made while the model failed to load
      this.outside = null;
      this.interact?.dispose();
      this.interact = null;
      this.live?.canvas?.remove();
      return false;
    }
  }

  // DYS-171 (the 30 Oct review of main, finding 6): this document is leaving. On a phone, (c) (hostEarly, PAGE_SWAP)
  // let its room's GPU context go and asked for the page's own document in its place (location.replace); the boot used
  // to go on regardless, on to mode "live" and startLive on the lost context while that one loaded. Now it stops where
  // it is: no GPU context of its own made, no frames started, the room not set live, and none of boot()'s endings (a
  // live room's moves, or a failed room's plain menu and room-off mark): its promise never settles (this document goes).
  // The mode stays "booting"; the beacon is asked for as when a boot ends. Only (c) sets letGo: elsewhere nothing changes.
  bootLeft() {
    this.loadBeacon();
    return new Promise(() => {});
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
    // masthead-r2: the live room's menu (About, Writing, Social), also when this visit's first paint did not expect the
    // room (an earlier room in the visit did not start: shared/sky-head.js left the plain list)
    document.documentElement.classList.add("sfw-room-menu");
    window.__sfwRoomMenu?.();   // (DYS-31: its links lead into the room again, not to the Quiet version)
    const layer = el("div", { class: "sfw-live", "aria-hidden": "true" });
    canvas.after(layer);
    this.live = { canvas, layer, revealed: false };
    this.swayHold = true;   // (released by handover3d, or at once where there is no handover)
    const size = MT_DIET ? () => this.measured().size : () => [canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight];
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
        : SHELF_MOCK && name === "shelf" ? mockShelfFrame(this.room, { w: size()[0], h: size()[1], reserve: this.reserveFor(name) })   // DYS-29 mock
        : frameSpot(this.room, name, { w: size()[0], h: size()[1], reserve: this.reserveFor(name) })),
      onPose: (pose) => this.applyPose(pose),
      onState: ({ to, spot }) => { if (to === "glide" || to === "orbit") this.reveal(); if (to === "glide" || to === "rest") this.wantHi(spot); if (to === "glide" && this.swayAt) this.sway(); },
      onWake: () => this.engine.invalidate?.("nav"),
      limit: (name, pose, rest) => this.clearOfCard(name, pose, rest),
      reducedMotion: () => reducedQ.matches,
      magCap: (name) => this.magCap(name),
      magCeil: (pose) => this.magCeil(pose),
      // (v3/zoom-r4) the window opening the outside is drawn through, for the walk's stop short of the glass
      opening: () => this.engine?.room?.window?.corners?.map((c) => [c.x, c.y, c.z]) || null,
      picture: () => this.picture(),
      size,
      // v3/phone-frame: at the desk's phone camera the look turns about the eye (spots.json desk.phone.orbit), so from its
      // lower, closer start it still reaches up to the window's top and the wall, down to the desk, and the sides
      orbitFor: (name) => (name === "desk" ? phoneVariant(this.room.spots.desk, { w: size()[0], h: size()[1] })?.orbit || null : null),
    });
    this.engine.addPass({
      name: "nav-rig", stage: "prepare",
      update: (f) => {
        this.roomFade(f.time);
        if (!this.rig.moving) return;
        this.rig.tick(f.time); this.wantHiZoom();
        if (this.rig.zooming && this.swayAt) this.sway();
        // (v3/zoom: the magnifier's code once it is used; DYS-161: the moving frames' intervals are no longer kept, the
        // magnifier cap no longer reads them)
        if (this.rig.magnified && !this.zoomMod) this.loadZoom();
      },
      animating: () => this.rig.moving || this.fadeAt != null,
      render() {}, needsRender: () => false,
    });
    // the links layer replaces the photograph's hotspots (the homepage) and follows the camera
    if (this.doc === "home") {
      this.live.links = new LinkLayer(this.hero, this.room, {
        tip: this.o.tip,
        // (v3/loading, ?firstvisit: every object's name on hover, beside the object)
        words: this.fv?.words || null, labelAt: this.fv?.words ? "object" : "pointer",
        onActivate: (name, e) => (this.fv?.activated(name), name === "window" ? this.windowLink(e) : name === "headphones" ? this.egg() : name === "breadboard" ? this.blinkBoard() : this.go(ACTIONS[name]?.spot || name)),
        onFocusOff: () => this.rig.resetOrbit(reducedQ.matches ? 0 : 600),
        // an object's name shows only with the camera at rest at the spot (never carried along by a glide)
        canTip: () => !this.rig?.glide && this.rig?.state !== "glide" && this.landedAt === this.spot,
        // the pointer or keyboard focus on an object's link: it answers with light (light())
        onLight: (name, how) => { if (how === "focus") this.focusLight = name; else this.linkHover = name; this.light(); if (name === "headphones") this.eggWarm(); },
      });
      // the masthead comes after the room in the tab order, as it does today
      this.live.links.placeAfter(this.o.stage);
    }
    this.live.picker = new Picker({
      engine: this.engine, room: this.room,
      onHover: (hit) => { this.navHover = hit; this.setCursor(); if (hit?.object === "headphones") this.eggWarm(); },
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
        // (v3/zoom-r3: zoomed at the desk too, back to 1x and the rest pose; the room fades in there)
        if (r.zoomed && MAG_SPOTS.has(this.spot) && this.landedAt === this.spot && !r.glide) {
          r.resetOrbit(reducedQ.matches ? 0 : 450);
          if (this.swayAt) this.sway();
        }
        else if (this.spot === "window" && this.landedAt === "window" && !r.glide && (r.magnified || r.dollyT || r.off.yaw || r.off.pitch)) {
          r.resetOrbit(reducedQ.matches ? 0 : 450);
          if (this.swayAt) this.sway();
        }
        else this.onTap(x, y, e);
      },
      toCanvas: (x, y) => { const b = this.live.canvas.getBoundingClientRect(); return { x: x - b.left, y: y - b.top, w: b.width, h: b.height }; },
      onFlick: (dir) => this.flick(dir),
      onZoom: (moved, at) => { this.reveal(); if (MAG_SPOTS.has(this.spot)) this.zoomStart(at); },
      // the homepage with its words in the card has nothing below the room: vertical drags turn the view (roomOnly)
      pageScrolls: () => !this.roomOnly(),
      // leaned in to the laptop the wheel scrolls its screen, wherever it is over the room, and nothing zooms
      wheelTo: () => (this.spot === "laptop" && this.landedAt === "laptop" ? this.laptop?.scr?.scroller || null : null),
      noZoom: (kind) => this.spot === "laptop" && kind !== "touch",   // (DYS-33 (a): at the laptop a pinch reads the screen)
    });
    this.hero.classList.add("is-live");
    this.hero.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" && !this.live.gestures.p && !this.roomHidden()) this.live.picker.hover(e.clientX, e.clientY); }, { passive: true });
    if (this.doc === "home" && coarseQ.matches) {
      // (the masthead's Books and Quotes: plain links, out of the live room's menu since masthead-r2, still the tabs' words)
      const nav = (href) => [...document.querySelectorAll(".masthead nav a")].find((a) => norm(new URL(a.href).pathname) === norm(href));
      const b = nav("/books/"), q = nav("/quotes.html");
      this.live.edges = new EdgeTabs(this.hero, {
        left: b && { href: b.getAttribute("href"), text: b.textContent, spot: "shelf" },
        right: q && { href: q.getAttribute("href"), text: q.textContent, spot: "print" },
        onGo: (spot) => this.go(spot),
      });
    }
    this.watchBox();   // (DYS-149 mt-diet: what the kept layout follows, the edge tabs made)
    // the Projects page on the laptop's screen, at every distance (shared/laptop.js)
    this.startScreen();
    // the notebook's index, the phone's lock screen, the breadboard's LED, the headphones' video (interactions B)
    this.startDesk();
    // the engine's spot registry (QA's ?qa=1&spot= and engine.goToSpot) holds this screen's framed rest poses
    // (DYS-149: only gl/qa.js reads it, and framing every spot's rest pose was ~48 ms of the 112-147 ms startLive task on
    // the barely-sufficient laptop: at idle once the room is up, the same poses (onResize registers them again as
    // before). With ?qa=1, or ?livesplit=0, here as before)
    if (LIVE_SPLIT && !params.has("qa")) idle(() => { if (this.rig && this.live) this.registerSpots(); });
    else this.registerSpots();
    // (DYS-149 mt-diet2: the homepage's scroll, for enterCardMode below, read with the first measure (startLive's one
    // forced layout, which bootPose's framing asks for first, before any write: the same values), not after bootPose's
    // writes, where it forced a second (MD1b: 0.5-1.2 ms on the barely-sufficient laptop). ?mtdiet=0: read there, as before)
    const y0 = MT_DIET && this.doc === "home" ? (this.measured(), scrollY) : undefined;
    // the first frame reproduces the first-paint photograph exactly (plan 3.4)
    this.bootPose();
    if (this.doc !== "home") {
      const handle = this.o.page?.handle;
      if (handle) this.anchor(handle, () => { const p = this.photoNow(); return p && { camera: p.camera, size: p.size, geo: p.geo }; });
      this.orbit = !!handle || this.doc === "projects";   // (Projects: the room's own screen follows the camera)
      this.hero.classList.toggle("sfw-no-orbit", !this.orbit);   // (and keeps the browser's pinch-zoom)
    }
    if (this.doc === "home") this.enterCardMode(y0);
    this.afterLanding(this.spot, { quiet: true });
    this.scheduleGlint();
    if (this.bootCrop) {
      this.outside?.rebase?.();
      // (whatever happens, the window and the sway are not left held)
      this.handover3d().catch(() => {}).finally(() => { this.fv?.settled(); this.handingOver = false; this.wakeScreens({ now: true }); if (this.outside?.held) this.outside.release(); if (this.swayHold === true) this.swaySettle(); });
    }
    else {
      this.outside?.release?.(); this.swaySettle();   // (no handover from a photograph here: as before)
      if (this.page?.own) this.reveal();   // (v3/qa-nav: a page brought in without its photograph's camera known: the room at once)
      if (this.leanBoot && this.spot === this.leanBoot) this.leanReveal().catch(() => {});   // (DYS-24: in at the laptop)
      if (this.fv) setTimeout(() => this.fv?.settled(), 400);   // (no hand-over by itself here: the first visit's line ends)
    }
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
    // handover-r2: the photographs show the laptop's screen as the 3D's own picture of it (the rendered page, greyer
    // than the live HTML page) and the phone's screen off; the live page and the always-on lock screen are held back
    // through the crossfade, so the 3D's first frame has the photograph's screens, then they wake (wakeScreens).
    // Reduced motion: no hold (the handover is one short cut, as before).
    this.screensHeld = !reducedQ.matches && !this.fv?.a2;   // (firstvisit-a2: the laptop's page comes in with the room, over the loading screen)
    // (v3/qa-nav) the room hands over at a page spot the visitor moved to while it started: the desk's window pixels
    // it held are not that photograph's
    if (this.doc === "home" && PAGE_MODULE[this.spot] && this.outside?.held) this.outside.release?.(0);
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
        if (go) setTimeout(go, this.fv ? 0 : 800);   // (v3/loading, ?firstvisit: at once, so the line can end on a room at rest)
        this.wakeScreens({ now: true });   // (the screens with the room at once, as before)
        this.outside?.release?.();
        this.swaySettle();
        this.handingOver = false;
        if (this.fv) await this.fvSettle();
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
    if (!reducedQ.matches) { c.classList.add("sfw-handover"); root.classList.add("sfw-handing"); }   // (the laptop's page with it, when not held)
    this.handoverAt = performance.now();
    this.reveal();
    await wait(reducedQ.matches ? CUT : HANDOVER_MS + 50);
    c.classList.remove("sfw-handover");
    root.classList.remove("sfw-handing");
    this.wakeScreens();   // handover-r2: the live page and the lock screen fade in over the 3D's own screens
    this.swaySettle();
    if (this.fv) {
      // (v3/loading, ?firstvisit: the window's dissolve and the framing ease together, not one after the other, and the
      // first visit's line up until both are over: Akshay, 23:47 "it takes a couple more seconds before the page zooms
      // out and stabilizes". The camera's move finishes the dissolve over 450 ms instead of at once, outside.js moveFade)
      const go = this.bootEase;
      this.bootEase = null;
      if (this.outside) this.outside.moveFade = go ? 450 : 0;
      const rel = this.outside?.release ? Promise.race([this.outside.release(reducedQ.matches ? 0 : WINDOW_FADE_MS), wait(WINDOW_WAIT)]) : Promise.resolve();
      // (firstvisit-a2: the laptop's page held a moment, close and sharp, before the pull back: "ready")
      if (this.fv.a2 && go) await wait(900);
      go?.();
      await rel;
      this.fv.mark("window");
      this.handingOver = false;
      await this.fvSettle();
      return;
    }
    // then the live view outside dissolves in over the photograph's window (once its tiles are in), and only then the
    // framing ease (at most WINDOW_WAIT: on a slow network the ease goes first and the view switches when it can)
    if (this.outside?.release) await Promise.race([this.outside.release(reducedQ.matches ? 0 : WINDOW_FADE_MS), wait(WINDOW_WAIT)]);
    const go = this.bootEase;
    this.bootEase = null;
    this.handingOver = false;
    go?.();
  }

  // v3/loading (?firstvisit): the hand-over is over when the framing ease has ended, the screens have woken, the sway
  // has settled and the window is live (at most 6 s more); the line ends then (fv.settled), so that after it nothing
  // moves or fades by itself (Akshay, 23:48: "once the loader is done the page should be available right after")
  async fvSettle() {
    const t0 = performance.now(), root = document.documentElement;
    for (;;) {
      const r = this.rig;
      const easing = !!r && (r.moving || r.state === "glide" || !!r.ease);
      if (!easing) this.fv?.mark("eased");
      if (!easing && !this.swayHold && !root.classList.contains("sfw-waking") && !this.outside?.held) break;
      if (performance.now() - t0 > 6000 || this.mode !== "live") break;
      await new Promise((res) => requestAnimationFrame(res));
    }
    this.fv?.mark("window");
    this.fv?.settled();
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

  // the objects an object's light covers and its strength (light() below; the first visit's introduction)
  lightFor(name) { return [LIGHT[name] || [name], LIGHT_K[name] || 1]; }

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
      else if (glides) names = (hit.object === "desk_book" && LIGHT.desk_book) || LIGHT[hit.spot] || (hit.object ? [hit.object] : null);   // (the Almanack lights itself, not the shelf)
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
    // (DYS-24: Projects, leanable, starts leaned in at the laptop: no photograph is on screen to start from, the room
    // comes in there by itself, leanReveal)
    if (this.leanBoot && name === this.leanBoot) return;
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
    if ((rep.cut > 0.05 || turns) && !reducedQ.matches && this.spot === name) this.bootEase = () => { if (this.rig.spot === name && this.rig.state === "rest" && !this.rig.moving && this.spot === name) { this.reveal(); this.rig.rest = this.rig.restPose(name); this.rig.easeTo(clonePose(this.rig.rest), this.fv?.a2 ? 1400 : 1200); this.fitHomeCard(); } };
  }

  // The photograph on screen now: its scene.json view, its render size, its layout, and the camera that took it.
  photoNow() {
    // (v3/qa-nav: a page brought in before the room, at its spot: its photograph; at a page spot without one, none)
    const own = this.doc === "home" && PAGE_MODULE[this.spot] ? (this.page?.own && this.page.spot === this.spot ? this.page.photo : () => null) : null;
    const ph = own ? own() : this.doc === "home" ? this.o.photo?.() : this.o.page?.photo?.() || this.projPhoto?.();
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

  // DYS-149 (Akshay said yes, 29 Oct 18:1x): the real-visitor beacon (shared/beacon.js), one GA4 event at the visit's end
  // on the site's own tag. Asked for once the room is up or has given up (or BEACON_LATEST after the router started),
  // at idle, never before the first picture; only where the page has the tag (or ?debug): a stage or a dev page fetches
  // nothing.
  loadBeacon() {
    if (this.beaconAsked) return;
    this.beaconAsked = true;
    clearTimeout(this.beaconT);
    const debug = params.has("debug");
    if (typeof window.gtag !== "function" && !debug) return;
    (window.requestIdleCallback || ((fn) => setTimeout(fn, 300)))(() => {
      import("./beacon.js").then((m) => m.install(this, { tier: bootTier(), debug })).catch(() => {});
    }, { timeout: 2000 });
  }

  reveal() {
    if (!this.live || this.live.revealed) return;
    this.live.revealed = true;
    if (!this.shownMarked) { this.shownMarked = true; performance.mark?.("sfw:room-shown"); }   // (DYS-149: the 3D takes over; shared/beacon.js)
    this.live.canvas.classList.add("is-on");
    this.fv?.handover();
    this.screenShown(true);
    // (v3/qa-nav) a page brought in before the room: its photograph fades out over the room (the boot's handover: as
    // the canvas fades in; a glide or a drag: quickly)
    this.ownOff(reducedQ.matches ? CUT : this.handingOver ? HANDOVER_MS : 150);
    this.photoLayers();   // (DYS-81: the photograph under it out of the compositor, once the handover is over)
  }
  canvasOff() { if (this.live) { this.live.canvas.classList.remove("is-on"); this.live.revealed = false; this.screenShown(false); this.photoLayers(); } }

  // DYS-81: the desk's first-paint photograph (index.html's #stage: the view, the glass, the room and its halation)
  // under the live room. A layer-tree capture mid-glide found its layers composited on every frame under the opaque
  // canvas. In the room's steady state it leaves the compositor (sfw-photo-off, the CSS above; app.js holds its parallax
  // and its 2D living layer meanwhile): the homepage, the live room shown (its canvas on, the context not lost, motion
  // not reduced), and the boot's handover from the photograph over (the crossfade, sfw-handing; the window's own pixels
  // let go, outside.held), all of it for PHOTO_OFF_MS. Any move away from that (a lost context, the engine's fallback to
  // the photographs, reduced motion) brings it back at once, in the same task that starts the canvas's fade out. Called
  // wherever one of these changes (reveal, canvasOff, contextLost, toPhoto, the boot's failure, reduced motion); while
  // the handover still goes on it looks again every PHOTO_OFF_MS. (The zoom keeps the canvas opaque, the room fading
  // inside it, roomFade: the photograph stays out. A page's own photograph, Books or Quotes brought in before the room,
  // is in the page, not in #stage.)
  // (DYS-107) The page documents too (Books, Quotes, Projects opened as their own documents): their own photograph (the
  // page's .room-stage, the CSS above) under the canvas, by the same rule. Books and Quotes hand over from it as the
  // homepage does (handover3d: handingOver, sfw-handing; their window has no photograph's pixels to hold); Projects
  // hands over in its own way (handover(): the canvas fades in while the page's own screen follows the live camera for
  // 300 ms and fades out), and counts only once that has begun (handedOver), so a drag that showed the room first
  // leaves the photograph as it is until then. The same moves bring it back at once: a lost context (contextLost, before the page's own screen
  // and overlays go back onto it), the engine's fallback, the boot failing, reduced motion.
  photoLayers(now = false) {
    const root = document.documentElement;
    const doc = this.doc === "home" || this.doc === "books" || this.doc === "quotes" || (this.doc === "projects" && !!this.handedOver);
    const covered = doc && this.mode === "live" && !!this.live?.revealed && !reducedQ.matches && !root.classList.contains("sfw-3d-off");
    if (!covered) { clearTimeout(this.photoT); this.photoT = 0; root.classList.remove("sfw-photo-off"); return; }
    if (root.classList.contains("sfw-photo-off")) return;
    const over = !this.handingOver && !this.outside?.held && !root.classList.contains("sfw-handing");
    if (now && over) { root.classList.add("sfw-photo-off"); return; }
    if (!this.photoT) this.photoT = setTimeout(() => { this.photoT = 0; this.photoLayers(true); }, PHOTO_OFF_MS);
  }

  // A lost WebGL context: the photograph for the current spot (the page's own at a page spot, the desk's at the
  // desk, window and notebook), its overlays back on that photograph; the room comes back when the context does.
  contextLost(lost) {
    // (DYS-164: the photographs back, the masthead with them: a page pinched large no longer covers it)
    if (lost && this.mastOff) { this.mastOff = false; document.documentElement.classList.remove("sfw-mast-aside"); }
    document.documentElement.classList.toggle("sfw-3d-off", lost);
    this.photoLayers();   // (DYS-81: the desk's photograph back in the compositor first; DYS-107: or the page document's own)
    // the photograph moves with the pointer again while it is what is shown, and eases back to rest under the room
    // (handover-r1; DYS-108: parallax(true) is on, as the handover's parallax(false) is to rest: this was the other way)
    this.o.parallax?.(lost);
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
    document.documentElement.classList.remove("sfw-live-mode", "sfw-quiet", "sfw-mast-aside");
    this.mastOff = false;
    delete document.documentElement.dataset.lamp;   // (DYS-138: the photographs carry their own lamp)
    plainMenu();
    clearInterval(this.lampTimer);
    this.mode = reducedQ.matches ? "still" : "photo";
    this.roomMarked?.();   // (DYS-151 (d): no room up any more)
    this.photoLayers();   // (DYS-81: shown from now on; contextLost above already brought it back)
  }

  // DYS-151 item 5 (d): this tab's mark that its room is starting or running on screen (ROOM_UP_KEY), kept true to the
  // document: off on pagehide (any leaving, the back-forward cache's too) and while out of sight (a tab iOS kills in the
  // background is not this case), back on when seen again. A document whose process dies on screen leaves it set, and
  // the next one in the tab reads it (roomLost). Phones only (ROOM_GUARD): desktops write nothing.
  // (DYS-151 review, finding 1: the mark is the time it was last written, again every ROOM_UP_EVERY while the room starts
  // or runs and is seen: a mark that stopped being renewed (a process that died, or one iOS froze and that never said
  // pagehide) tells its age, and roomLost counts only a fresh one)
  roomMark() {
    const set = () => {
      try {
        if ((this.mode === "booting" || this.mode === "live") && document.visibilityState === "visible") sessionStorage.setItem(ROOM_UP_KEY, String(Date.now()));
        else sessionStorage.removeItem(ROOM_UP_KEY);
      } catch { /* storage blocked */ }
    };
    if (!this.roomMarked) {
      this.roomMarked = set;
      addEventListener("pagehide", () => { try { sessionStorage.removeItem(ROOM_UP_KEY); } catch { /* storage blocked */ } });
      addEventListener("pageshow", (e) => { if (e.persisted) set(); });
      document.addEventListener("visibilitychange", set);
      setInterval(set, ROOM_UP_EVERY);   // (DYS-151 review: renewed; off again by itself once the room is not up or not seen)
    }
    set();
  }

  // Parts of the screen the spot's must-see objects stay clear of: the masthead, and a card (cardOnly: the card).
  reserveFor(name, { cardOnly = false } = {}) {
    const [w, h] = this.size ? this.size() : [innerWidth, innerHeight];
    const mh = this.mastH() ?? 96;   // (DYS-149 mt-diet: kept, measured(); an orbit asked for it every frame, clearOfCard)
    const wide = w > 760 && w / h > 1.1;
    const r = cardOnly ? {} : { bottom: mh + 8 };
    if (name === "shelf" && wide && !SHELF_MOCK) r.left = Math.min(560, Math.max(340, w * 0.36));   // the book card (pages.js cardColumn)
    // (DYS-29: no column for the card: the shelf has the whole view, page.js places the card beside it)
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
    this.sizedAt ||= [w, h];   // (DYS-159: the room's size the view is framed for, until onResize: there)
    this.engine.camera.set(toEngineCamera(pose, w / h));
    // (v3/zoom-r3: zoomed, the outside's own camera, magnified; the room's above stays at 1x)
    this.engine.camera.setOutside?.(this.rig?.view ? toEngineCamera(this.rig.view, w / h) : null);
    // which objects are offered is settled at rest (a move never hides a link that may have focus)
    // (judged at the spot's rest pose: an orbit never takes a link away; focusing one eases back instead)
    if (!this.rig.moving && this.landedAt === this.spot && this.rig.rest) {
      this.live.links?.setSpot(this.spot, this.rig.rest, w, h);
      const ph = this.page?.handle || this.o.page?.handle;
      if (ph?.card) requestAnimationFrame(() => this.overlays.inertUnder(ph.card, ph.items || []));
    }
    this.live.links?.update(pose, w, h);
    this.overlays.update(pose, w, h);
    // (v3/laptop-phone: a glide to or from the laptop has begun: the phones' change of the screen's layout comes
    // while the screen is small, shared/laptop.js glide)
    const gl = this.rig.glide || null;
    if (gl !== this.glideSeen) {
      this.glideSeen = gl;
      if (gl && (gl.to === "laptop" || this.rig.from === "laptop")) this.laptop?.glide(gl.to === "laptop", (gl.g?.duration || LEAN_S) * 1000);
    }
    this.laptop?.place(pose, w, h, { still: !this.rig.moving });
    this.mastAside();
    this.placeDesk(pose, w, h);
    fitEdges(this.live.edges, this.room, pose, w, h, this.phoneDeskRest(w, h), this.edgeBox());   // the phone's edge tabs clear of the window
  }

  // (DYS-149 mt-diet) The layout the moving frames read, measured together, reads only (so at most one style + layout,
  // and none when nothing was written since the frame's own layout), the first time one is asked for after a change,
  // then kept: the canvas's CSS size (the router's size(): its clientWidth / clientHeight, else the window's), the
  // masthead's height (its getBoundingClientRect, as reserveFor and cardVars read it) and the phones' edge tabs' boxes
  // in their parent (edgefit.js edgeRects; null while they are hidden, then measured when first asked for shown). On a
  // moving frame these were read ~10 times (the rig's framing and limits, applyPose, fitEdges, wantHiZoom), each after
  // that frame's writes (the links' outlines, the overlays, roomFade's classes): a forced style + layout every frame.
  // watchBox() measures again on a change. Not with ?mtdiet=0 (size() reads at every ask, as before)
  measured() {
    if (this.box && this.boxRO) return this.box;
    const c = this.live?.canvas, m = document.querySelector(".masthead");
    const size = c ? [c.clientWidth || innerWidth, c.clientHeight || innerHeight] : [innerWidth, innerHeight];
    this.box = { size, mast: m, mh: m ? m.getBoundingClientRect().height : null, edges: edgeRects(this.live?.edges) };
    return this.box;
  }
  // What it follows: the window's resize (at once; onResize waits 120 ms), and the size of the canvas, the masthead,
  // the hero (the edge tabs' parent) and each edge tab: a ResizeObserver, after the layout that changed one and before
  // that frame is painted, measures the kept values again there (reads after the layout: no forced one)
  // (DYS-149 mt-diet2: the masthead alone changed (its clock docks at the window and comes back, sfw-at-window): its
  // new height from the observer's entry, its border box, which is its getBoundingClientRect's height (the masthead is
  // only translated, translateY(-100%)); nothing else is read. masthead.js's own observer, older, is called first and
  // writes --mh on the root, so a read here forced the whole page's style + layout (MD1b: 11 moving frames at the
  // window, 2.6-7 ms each). Nothing the box keeps follows the masthead (the canvas and the edge tabs are placed in the
  // hero; --mh is only the Books page's). Any other change (the canvas, the hero, an edge tab) is measured again as
  // before; so is the masthead where the entry has no borderBoxSize)
  watchBox() {
    this.box = null;
    if (!MT_DIET || !this.live || typeof ResizeObserver !== "function") return;
    if (!this.boxRO) {
      addEventListener("resize", () => { this.box = null; });
      this.boxRO = new ResizeObserver((es) => {
        const b = this.box;
        if (!b) return;
        const bb = b.mast && es.every((e) => e.target === b.mast) && es[es.length - 1].borderBoxSize?.[0];
        if (bb) { b.mh = bb.blockSize; return; }
        this.box = null; this.measured();
      });
    }
    for (const x of [this.live.canvas, document.querySelector(".masthead"), this.hero, ...(this.live.edges?.el?.children || [])]) if (x) this.boxRO.observe(x);
  }
  // the masthead's height (CSS px; null without one): kept (measured()), measured again for a new masthead element
  mastH() {
    const m = document.querySelector(".masthead");
    if (!MT_DIET || !this.live?.canvas) return m ? m.getBoundingClientRect().height : null;
    if (this.measured().mast !== m) { this.box = null; if (m) this.boxRO?.observe(m); }
    return this.measured().mh;
  }
  // the edge tabs' boxes for fitEdges (undefined: it reads them itself, ?mtdiet=0)
  edgeBox() {
    const E = this.live?.edges;
    if (!MT_DIET || !E) return undefined;
    const b = this.measured();
    if (!b.edges && E.el && !E.el.hidden && E.el.isConnected) b.edges = edgeRects(E);
    return b.edges || undefined;
  }

  // v3/phone-frame: the desk's rest pose while the desk rests at its phone camera (framing.js phoneVariant), else
  // null: the edge tabs that camera puts over the sky stay (edgefit.js); every other screen fits them as before
  phoneDeskRest(w, h) {
    return this.rig?.spot === "desk" && this.rig.rest && phoneVariant(this.room.spots.desk, { w, h }) ? this.rig.rest : null;
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

  // The reading sheet (shared/reader.js, with its stylesheet), made once: the essays' list and words for the notebook's
  // page and its lifted page (essay-lift.js), and the sheets of Projects, About and Social. (DYS-106, Akshay 28 Oct: no
  // reading sheets anywhere: an essay never opens in it.)
  startReader() {
    return (this.readerP ??= (async () => {
      // (only a stylesheet counts: the homepage's head may hold a preload hint for this file, 150e4e7, which fetches it
      // but never applies it; counting the hint left the sheet unstyled, off the bottom of the screen)
      // (DYS-149: the hand-over restyle) its text without the faces the document has (style.css, print.js, notebook.js
      // or a page's world.css: the same three files), putSheet; with a preload hint for it (index.html: /?writing= on a
      // phone, /?page=projects) its <link> as before, which takes what the hint fetched
      if (RESTYLE && !document.querySelector('link[rel="preload"][href="/shared/reader.css"]')) {
        await Promise.race([putSheet("/shared/reader.css"), wait(1500)]);
      } else if (!document.querySelector('link[rel="stylesheet"][href="/shared/reader.css"]')) {
        const l = el("link", { rel: "stylesheet", href: "/shared/reader.css" });
        document.head.appendChild(l);
        await new Promise((r) => { l.onload = r; l.onerror = r; setTimeout(r, 1500); });
      }
      const { Reader } = await import("./reader.js");
      const r = new Reader({ home: "/writing/" });
      // DYS-33 / DYS-31 (Akshay 28 Oct: "i dont like reading sheets - theyre sloppy - and we shouldn't put reading sheets
      // for anything even if its mobile"): the sheet never opens. Every way into it (the menu's About, Social, Projects or
      // Writing while the room is not there, an essay's address without the room, the essay lift failing to load) goes
      // to the same page of the Quiet version instead; the reader stays for its data (the essays' list: the phone, the
      // notebook)
      r.open = (what) => { location.assign(quietURL(what)); return new Promise(() => {}); };
      r.route = () => { location.replace(quietURL(null)); return false; };
      this.reader = r;
      document.addEventListener("reader:open", (e) => this.onReader(true, e.detail?.slug));
      document.addEventListener("reader:close", (e) => this.onReaderClosing(e.detail?.slug));
      document.addEventListener("reader:closed", () => this.onReader(false));
      return r;
    })());
  }

  // DYS-33: an essay from the phone's notification opens in the notebook, lifted as a tap on its title there would (the
  // room glides to the notebook first); without the live room, its page of the Quiet version
  async essayFromPhone(slug) {
    if (this.mode !== "live") { location.assign(quietURL(slug)); return; }
    await this.go("notebook");
    for (let i = 0; i < 80 && !(this.landedAt === "notebook" && !this.rig?.glide); i++) await wait(50);
    (await this.liftEssay()).open(slug);
  }

  // (DYS-26) The essay lift's module, loaded once: at the first tap on a notebook title, or at a refresh on an essay.
  liftEssay() {
    return (this.essayLiftP ||= import("/shared/essay-lift.js").then((m) => (this.essayLift = m.install(this))));
  }
  // (DYS-149) Landed at the notebook: a moment later (still there, the room live), the essay lift's module comes and is
  // installed (its stylesheet, its page's DOM), the essay page's faces load and the essays listed on the open spread are
  // fetched, so a tap on a title starts the riffle at once. WebKit's baseline (30 Oct) waited 0.2-0.7 s on the tap (1.8 s
  // once on the phone profile): the module's fetch and first run came in the tap's own frame. Nothing for a visitor who
  // never comes here; not with Save-Data or on a 2g/3g connection (then it all waits for the tap, as before).
  liftWarm() {
    if (this.mode !== "live" || this.liftWarmT) return;
    const c = navigator.connection;
    if (c && (c.saveData || /(^|-)(2g|3g)$/.test(c.effectiveType || ""))) return;
    this.liftWarmT = setTimeout(() => idle(() => {
      this.liftWarmT = null;
      if (this.spot !== "notebook" || this.rig?.spot !== "notebook" || this.mode !== "live") return;
      this.liftEssay().then((L) => L.warm?.(), () => { this.essayLiftP = null; });   // (a fetch that failed: the tap tries again)
      const r = this.nbIndex?.reader;
      r?.fonts();
      for (const s of this.nbIndex?.sidesAt().filter(Boolean) || []) for (const a of s.querySelectorAll("a[data-slug]")) r?.essay(a.dataset.slug).catch(() => {});
    }, 400), 150);
  }

  // DYS-80 (Akshay 28 Oct: "we shouldn't put reading sheets for anything even if its mobile"): an essay's address with
  // no room to read it in (the room will not start: under 4 GB, 2G, Save-Data, reduced motion, ?3d=0; its start failed;
  // or the lifted page could not be shown) is the essay's own page, its static document (/writing/<slug>/, written by
  // scripts/content/writing_pages.py), never the reading sheet over the photograph. The visit is marked as one whose
  // room did not start (ROOM_OFF_KEY) before it goes, so that page's head keeps it a page and does not send it back
  // here; the query goes along but the homepage's own writing= and page=, and the hash the essay came with.
  essayPage(slug) {
    if (this.toEssayPage) return;
    this.toEssayPage = slug;
    try { sessionStorage.setItem(ROOM_OFF_KEY, "1"); } catch { /* storage blocked */ }
    const q = new URLSearchParams(location.search);
    q.delete("writing"); q.delete("page");
    const s = q.toString();
    location.replace(`/writing/${slug}/${s ? `?${s}` : ""}${location.hash || this.wpHash || ""}`);
  }

  // A sheet lifted from the page: the page's ink goes with it, and comes back when the sheet settles into the page.
  onReader(open, slug = null) {
    const r = this.reader;
    const own = !!slug && !!r?.pages.has(slug);   // About, Social, Projects: no page of the notebook's goes with them
    if (open && r && !own) r.o.home = this.spot === "notebook" ? "/writing/" : "/";
    this.nbReading = open && !own && this.spot === "notebook";
    this.inkTo();
  }

  // (v3/qa-nav, 23 Oct) An essay settling back into the notebook: the page's ink comes back as the sheet starts to go
  // (the lift into the page on desktops, the slide down on phones, reduced motion's fade), under it, so it is there as
  // the sheet uncovers the page; it came back only once the sheet had gone, which left the page blank for a moment
  // (on phones about 0.4 s as the sheet slid away).
  onReaderClosing(slug) {
    const r = this.reader;
    if (!r || (!!slug && r.pages.has(slug)) || this.spot !== "notebook" || !this.nbReading) return;
    this.nbReading = false;
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
          // (v3/essay-lift, a prototype: the page lifts out of the notebook into the flat reading page, web/shared/essay-lift.js)
          // (loaded once the room has landed at the notebook, liftWarm (DYS-149), or at the first tap on a title, not with
          // the room: a first visit fetches nothing new; if it can't load, the essay's own page, essayPage: DYS-106,
          // Akshay 28 Oct: no reading sheets anywhere; it opened the reading sheet)
          onTitle: (slug) => {
            if (this.essayLift) { this.essayLift.open(slug); return; }
            (this.essayLiftP ||= import("/shared/essay-lift.js").then((m) => (this.essayLift = m.install(this))))
              .then((L) => L.open(slug), (e) => { console.warn("[essay-lift]", e); this.essayLiftP = null; this.essayPage(slug); });
          },
        });
        this.essayLiftOn = true;   // (a title tap lifts its page: the smoke reads this before the module is loaded)
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
          onEssay: (slug) => { this.essayFromPhone(slug); },   // (DYS-33: no sheet: in the notebook, as a tap on its title there)
          // live room 2: the lock screen's flashlight is the desk lamp's own switch (a click on the lamp: its fade, and
          // the visitor's choice for the visit); its glyph follows the lamp, the dusk rule's too
          torch: this.interact ? { on: () => (this.engine?.light?.lamp || 0) > 0, toggle: () => this.interact?.toggleLamp() } : null,
          // phone round 2: always on, from every spot: furniture in front of the screen cuts it (the laptop's rule; the desk
          // only by its top board, from below it, and the things on the desk: occlude.js deskOccluders)
          occluders: [...(this.room.obstacles || []).filter((o) => o.box && !["desk", "phone"].includes(o.name)), ...deskOccluders(this.room, ["phone"])],
        });
        this.phone.setShown(!!this.live.revealed && !this.screensHeld);   // (with the room, not over the photograph: screenShown)
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
    const q = name === "notebook" ? this.room.objects[innerWidth / innerHeight < 1 && !this.nb3d?.pages ? "notebook_page" : "notebook_spread"]?.quad : this.room.objects.phone_screen?.quad;
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
    // (v3/zoom-r4: a room spot's zoom is the walk in: how far it has come, of the walk it is on; else the dolly)
    const walkedIn = r?.isWalked?.() ? Math.hypot(...r.walk) : 0;
    const d = walkedIn || r?.dolly || 0;
    if (!t || !r?.spot || !(d > 0) || this.hiZoomAsked?.[r.spot]) return;
    const z = t.zoomRule(r.spot);
    if (!z || Math.abs(d - (this.hiZoomAt ?? -1)) < 0.03) return;
    this.hiZoomAt = d;
    const S = r.walkSeg;
    const hi = walkedIn ? (S ? Math.hypot(...S.base) + S.max : walkedIn) : r.zoomLimits()[1];
    if (hi > 0 && d >= z.from * hi) {
      (this.hiZoomAsked ||= {})[r.spot] = true;
      const [w, h] = this.size ? this.size() : [innerWidth, innerHeight];
      t.forZoom(r.spot, { portrait: w / h < 1 });
    }
  }

  // A tap or click on the room: leaned in to the laptop, a click on the room around it leans back; else what is
  // under it is picked
  onTap(x, y, e) {
    if (e.target.closest?.("a, button, .sfw-links")) return;
    if (this.roomHidden()) return;     // (v3/zoom-r3: zoomed, the room is not there to pick)
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
  // (DYS-161) to the desktop's 4x view, as tall as it (DESK_TANV: 8.37x on a portrait phone, 4x in landscape), except
  // on a device that says it is weak (navigator.deviceMemory under 4 GB, or a GPU whose largest texture is under 8192
  // px: 2x, the 1x pictures only, so the 4x squares' memory is never asked of it).
  // (DYS-161, Akshay 30 Oct, his iPhone: the window never reached the desktop's 2x or 4x. The cap was 2-4 by the glides'
  // frame times, and a phone's 3x shows what a desktop's 1.44x does (its rest view is 2.09 times as tall), short of
  // where the 4x squares are fetched (zoom.js: the frame denser than 84 px/deg, a phone's 3.9x). The frame-rate term is
  // gone: a slow frame is fixed where it is slow, never hidden by less zoom. Memory is held by the 4x squares' own
  // budget on phones (zoom.js BUDGET_MB.T1, their array's whole size), whatever the cap.)
  magCap(name) {
    if (!MAG_SPOTS.has(name) || this.mode !== "live") return 1;
    if (MAG_PIN) return MAG_PIN;
    const tier = this.engine?.settings?.tier;
    if (tier !== "T1") return MAG_DESKTOP;
    if (!this.zoomDev) {
      const gl = this.engine.gl, maxTex = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 4096, dm = navigator.deviceMemory;
      this.zoomDev = { weak: !!(dm && dm < 4) || maxTex < 8192, dm: dm ?? null, maxTex };
    }
    // (the window's rest lens, once there: kept for when the rig is elsewhere, e.g. on its way in)
    const r = this.rig?.spot === name ? this.rig.rest?.tanV : null;
    if (r) this.zoomTanV = r;
    const D = this.zoomDev, t = this.zoomTanV || DESK_TANV;
    const cap = D.weak ? 2 : Math.max(MAG_DESKTOP, (MAG_DESKTOP * t) / DESK_TANV);
    if (this.zoomCapWhy?.cap !== cap) {
      this.zoomCapWhy = { tier, deviceMemory: D.dm, maxTexture: D.maxTex, weak: D.weak, restTanV: +t.toFixed(4), cap,
        viewDeg: +((2 * Math.atan(t / cap) * 180) / Math.PI).toFixed(2) };
    }
    return cap;
  }
  // v3/zoom-r3: the most the view `pose` (the outside's, magnified) may be magnified and still look sharp: the sharpest
  // picture's px/deg there (the magnifier's density: L3, the near layer, L0; before its code is in, L0's everywhere) over
  // what this screen shows of the outside per degree at 1x, SHARP_PX (SHARP_COARSE on touch screens) of its pixels to a
  // CSS px; the lowest over the view's middle. It only stops a zoom in (the rig: a pan never changes the zoom).
  magCeil(pose) {
    const z = this.zoomApi;
    if (!MAG_SPOTS.has(this.rig?.spot) || !ZOOM_HONEST || (z && !z.honest())) return Infinity;
    const [w, h] = this.size(), t0 = this.rig.rest?.tanV;
    if (!t0 || !w || !h) return Infinity;
    const cssPerDeg = (h / 2 / t0) * (Math.PI / 180);
    const l0 = this.outside?.meta?.bands?.city?.levels?.L0 || 64;
    let d = Infinity;
    for (const fy of CEIL_AT) for (const fx of CEIL_AT) {
      const r = ray(pose, w * (0.5 + fx), h * (0.5 + fy), w, h).d;
      const yaw = Math.atan2(r[0], -r[2]) * (180 / Math.PI), el = Math.asin(Math.max(-1, Math.min(1, r[1]))) * (180 / Math.PI);
      d = Math.min(d, z ? z.density(yaw, el) : l0);
    }
    return Math.max(1, d / (SHARP_PX * (coarseQ.matches ? SHARP_COARSE : 1)) / cssPerDeg);
  }
  // v3/zoom-r3: where the outside has pictures, in the rig's degrees (yaw left of the axis): the panorama's columns and
  // its bands, from the near layer's bottom to the sky's top (null before the outside's meta is in: no zoom then anyway)
  picture() {
    const m = this.outside?.meta;
    if (!m?.yaw || !m.bands) return null;
    const lo = Math.min(m.bands.city?.el?.[0] ?? 0, m.layers?.near2?.el?.[0] ?? 0, m.layers?.far?.el?.[0] ?? 0);
    const hi = Math.max(m.bands.sky?.el?.[1] ?? 0, m.bands.city?.el?.[1] ?? 0);
    return { yaw: [-m.yaw[1], -m.yaw[0]], el: [lo, hi] };
  }
  // Zoomed (or fading), the room is not there: nothing in it to point at or pick.
  roomHidden() { return !!this.rig?.zoomed || (this.engine?.roomW ?? 1) < 1; }
  // v3/zoom-r3: the room's weight in the picture, once a drawn frame: out over ROOM_FADE_MS (eased) as soon as a zoom in
  // begins, in again once the zoom is back at 1x. The engine lays the room over the outside by it; the room's own layers
  // on the page take it too (CSS: .sfw-zoomed). At 1 the page is as it always was (no class, no variable).
  roomFade(t) {
    // (QA, smoke zoom.align: qaRoomOff takes the room out at 1x too, so the outside alone can be compared across zooms)
    let want = this.rig?.zoomed || this.qaRoomOff ? 1 : 0;   // (the fade's progress: 0 the room, 1 the outside alone)
    if (this.fadeP === undefined) { this.fadeP = 0; this.fadeAt = null; }
    if (this.engine.roomDrop) want = this.roomDrop(t, want);
    // (a zoom ended without a pose: the outside back on the room's camera)
    if (!this.rig?.view && this.engine.outsideCam) this.engine.camera.setOutside?.(null);
    if (this.fadeP === want) { this.fadeAt = null; return; }
    const ms = reducedQ.matches ? 150 : ROOM_FADE_MS;
    const dt = this.fadeAt === null ? 16.7 : Math.min(50, Math.max(0, t - this.fadeAt));
    this.fadeAt = t;
    this.fadeP = want ? Math.min(1, this.fadeP + dt / ms) : Math.max(0, this.fadeP - dt / ms);
    const w = 1 - ease(this.fadeP);
    this.engine.roomW = w;
    this.engine.requestFrame();
    if (w < 1) { this.hero.classList.add("sfw-zoomed"); this.hero.style.setProperty("--sfw-room", w.toFixed(4)); }
    else { this.hero.classList.remove("sfw-zoomed"); this.hero.style.removeProperty("--sfw-room"); }
    // (DYS-161 memory: a phone's room wholly out: its layers on the page hidden, not only at opacity 0 (the CSS above);
    // shown again in the same step the fade in begins. ?roomout=0: as before)
    this.hero.classList.toggle("sfw-room-out", w <= 0 && ROOM_OUT && this.engine.settings?.tier === "T1");
    // (DYS-161 memory, OP1: and its link layers until the fade in is over: shown in the step the room is wholly in)
    this.hero.classList.toggle("sfw-links-wait", w < 1 && LINKS_WAIT && this.engine.settings?.tier === "T1");
    if (this.fadeP === want) this.fadeAt = null;
  }
  // (DYS-161 memory) A phone's room textures while zoomed (engine.js dropRoom, restoreRoom), from roomFade each frame:
  // the room wholly out (the fade done) and the view still zoomed for ROOM_DROP_MS (no zoom out under way): they go.
  // Once gone, the first step back (a zoom out under the magnification they went at, a reset's ease, a glide, the zoom
  // over) asks for them again, early, so they are back before the fade in; until they are all back the fade in waits
  // (the outside alone a moment longer, never a room without its textures). Returns the fade's want.
  roomDrop(t, want) {
    const e = this.engine, r = this.rig;
    if (e.roomOut) {
      this.dropSince = null;
      this.dropMag = Math.max(this.dropMag || 1, r?.magT || 1);
      if (!r?.zoomed || r.zoomEase || r.glide || (r.zoomOut && r.magT < this.dropMag / 1.05)) e.restoreRoom();
      return 1;
    }
    if (want === 1 && this.fadeP === 1 && r?.zoomed && !r.zoomEase && !r.glide && !(r.zoomOut && r.magT < r.mag)) {
      if (this.dropSince == null) this.dropSince = t;
      else if (t - this.dropSince > ROOM_DROP_MS) { this.dropSince = null; if (e.dropRoom()) this.dropMag = r.magT; }
    } else this.dropSince = null;
    return want;
  }
  // The magnifier's code (tiles, the sharper level's program), the first time someone magnifies: nothing of it at load.
  // (its density raises the ceiling where the 4x tiles are; the zoom is never raised by itself)
  loadZoom() {
    if (this.zoomMod || !this.outside || this.mode !== "live") return this.zoomMod || null;
    this.zoomMod = import("./zoom.js").then((m) => m.attachMagnifier(this)).then((z) => { this.zoomApi = z; return z; }).catch((e) => { console.warn("[zoom]", e.message); return null; });
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
  // spread filling the free part of the screen. page-turn2: phones too, since the notebook is a book of two pages (the
  // list runs on onto the left-hand page and the way back is its leaf); the type keeps its size (its 14.5 px floor), a
  // phone's page just holds fewer titles. Without the 3D page turn, phones frame the first page as before.
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
        const page = portrait && !this.nb3d.pages;
        pose = fitPose({ points: page ? O.notebook_page.quad : O.notebook_spread.quad, forward, tanV, w, h, top: 64, bottom: mh + 14, fill: page ? 0.9 : portrait ? 0.97 : 0.86, fillH: 0.94 });
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
      this.liftWarm();
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
    if (!this.eggHere()) {
      window.open(url, "_blank", "noopener");
      return;
    }
    this.eggObj.laptop = this.laptop;
    if (this.spot === "laptop") { this.eggObj.start(); return; }
    history.pushState({ sfw: 1, spot: "laptop", egg: 1 }, "", location.href);
    this.pushedHere = true;
    this.pushedFrom = this.spot;
    this.liveGo("laptop", false);
    // the video's poster comes onto the screen as the camera starts to lean in, and its player (loaded on the pointer's
    // way to the headphones, or from now) plays the moment it can (egg-fast, 28 Oct: the frame used to be made only
    // 0.77 s in, on a black screen, and shown once ready: 7-8 s of black on a busy Mac)
    this.eggObj.start();
  }

  // The video plays on the laptop here (a live room on a computer with a pointer; phones open it in a tab).
  eggHere() {
    return !(coarseQ.matches || innerWidth <= 640) && this.doc === "home" && this.mode === "live" && !!this.laptop?.scr && !!this.eggObj;
  }

  // Intent (the pointer over the headphones, or focus on their link): the video's player loads, hidden and paused, on
  // the laptop's screen, so the click only asks it to play (toys.js Egg.warm). Nothing for visitors who never come
  // near them: YouTube is not loaded with the page.
  eggWarm() {
    if (!this.eggHere()) return;
    this.eggObj.laptop = this.laptop;
    this.eggObj.warm();
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
    // (DYS-159, Akshay's phone 29 Oct: a pinch on the laptop's page walked the eye in, and it sprang back to the lean-in
    // as the fingers lifted: iOS Safari fires resize around a pinch with the page's size unchanged, and reframe() puts
    // the view back at rest. On touch screens a resize that leaves the room's size as it was keeps the view as it is)
    const [w, h] = this.size(), was = this.sizedAt;
    this.sizedAt = [w, h];
    if (!(coarseQ.matches && was && was[0] === w && was[1] === h)) this.rig.reframe();
    if (this.page?.handle?.card) this.overlays.inertUnder(this.page.handle.card, this.page.handle.items || []);
    this.fitHomeCard();
    this.updateScrollMode();   // (a turn to landscape can make the room taller than the screen)
  }

  // ---------- the laptop: a computer you use ----------
  // The laptop spot's rest pose for this screen (shared/laptop.js leanPose): the screen square on, filling most of
  // the view, clear of "Back to the desk" (top) and the masthead (bottom). Desktops and tablets in landscape (at least
  // 600 px tall: not a phone on its side) lean in closer (Akshay, 23 Oct: "zoom a bit more into the computer"): the
  // screen may come down to 8 px above the masthead's words (its box less its top padding), not 12 px above its box.
  // DYS-182 (B's review of DYS-179, 30 Oct): a phone on its side (shared/device.js, wider than tall) whose room runs
  // below the first screen (style.css .scene keeps 520 px at least; an 844 x 390 phone shows 390 of them) ends the band
  // LEAN_FOLD_GAP px above the screen's foot instead: the masthead is down there, out of view, and the old band put the
  // laptop's screen at y 64-429 on 390, its bottom bezel under the edge. Now the screen, with a sliver of its bezel,
  // lies between "Back to the desk" and the foot (844 x 390: about 500 x 313 at y 62-376).
  // DYS-186: any window whose room runs below the first screen (shorter than 520 px: desktop windows too), the higher of
  // the two feet: above the masthead as before, or LEAN_FOLD_GAP above the first screen's foot. The fold's wins only
  // where the masthead's box lies under the first screen (a desktop window under ~445 px; 844 x 390, 667 x 375), so the
  // screen never goes under the masthead's words where they show (1280 x 500: their line at y 473-498). A room that
  // fits (below 0) keeps the masthead's foot, as before. (The fold's foot keeps clear of an iPhone's home bar too,
  // DYS-182's foldInset; with below 0 that is at most 8 + 34 px, under any masthead's + 12: no change there either.)
  leanFrame() {
    const [w, h] = this.size ? this.size() : [innerWidth, innerHeight];
    if (!this.lean || this.lean.w !== w || this.lean.h !== h) {
      const m = document.querySelector(".masthead");
      const mh = m ? m.getBoundingClientRect().height : 96;
      const words = m ? mh - (parseFloat(getComputedStyle(m).paddingTop) || 0) : 72;
      const below = leanNear(w, h) ? 0 : this.roomBelowFold(h);
      const band = leanBand({ w, h, mh, words, below, inset: this.foldInset || 0 });
      this.lean = { w, h, below, pose: leanPose(this.room, w, h, band) };
    }
    return this.lean.pose ? clonePose(this.lean.pose) : null;
  }

  // DYS-182: how many px of the room (h px tall, at the page's top) lie below the first screen. The screen's height is
  // the small viewport's (100svh: as tall as the screen is with the browser's bars shown), so the lean-in stays the
  // same while those bars come and go (innerHeight changes with them; the room's size, and so the lean-in, does not).
  // (The coordinator's review, 30 Oct 20:1x: with viewport-fit=cover, 100svh on a Face ID iPhone on its side reaches the
  // glass's bottom edge, and the home bar keeps about 21 px there: the screen's foot sat ~13 px into it, under the bar,
  // where a finger scroll can open the app switcher. The same probe reads env(safe-area-inset-bottom) into foldInset,
  // added to LEAN_FOLD_GAP, as the masthead respects it (world.css). 0 everywhere without a home bar: as before.)
  roomBelowFold(h) {
    let vh = 0, inset = 0;
    try {
      const p = document.createElement("div");
      p.style.cssText = "position: fixed; left: 0; top: 0; width: 0; height: 100vh; height: 100svh; box-sizing: border-box; padding-bottom: env(safe-area-inset-bottom, 0px); visibility: hidden; pointer-events: none";
      document.body.appendChild(p);
      vh = p.getBoundingClientRect().height;
      inset = parseFloat(getComputedStyle(p).paddingBottom) || 0;
      p.remove();
    } catch { vh = 0; inset = 0; }
    this.foldInset = Math.max(0, Math.round(inset));
    if (!(vh > 0)) vh = innerHeight;
    return Math.max(0, Math.round(h - vh));
  }

  // The Projects page on the laptop's screen (projects/screen.js), placed on the 3D screen every frame. It shows
  // what it showed before during this visit (any of the site's documents), or on the Projects document, the page's
  // own state as the room takes over (arriveLaptop).
  startScreen() {
    if (!this.room.objects?.screen?.quad || !this.room.spots.laptop || this.laptop) return;
    const lean = this.leanBoot && this.spot === "laptop";   // (DYS-24: asked now; leanReveal may be done before the page is)
    this.laptop = new LaptopScreen(this.room, {
      parent: this.hero,
      after: () => this.live?.links?.svg || this.hero.querySelector(".laptop-room"),
      reduced: () => reducedQ.matches,
      onRoute: (slug, { push }) => this.screenRouted(slug, push),
      sheet: () => this.startReader(),   // (nav-r1 item 9: phones open the page itself in the room's reading sheet)
      // (DYS-33 (a): two fingers on the laptop's page zoom the room toward its screen, and pan along it walked in)
      onPinch: (ph, a, b) => this.live?.gestures?.pinchFrom(ph, a, b),
    });
    this.laptop.ready.then((ls) => {
      if (!this.live) return;
      // in the tab order after the room's links, before the masthead and the cards
      const after = this.live.links?.svg || this.hero.querySelector(".laptop-room");
      if (after?.parentNode === this.hero && after.nextElementSibling !== ls.host) after.after(ls.host);   // (a move reloads the page's frame)
      // (v3/laptop-phone, option A: on the homepage what the screen showed is kept for the next lean-in; the desk shows
      // the page's top until then, as the photographs do)
      // (DYS-24: the room started leaned in at the laptop: the screen as it was, at once, leanScreen; laid out first, at
      // the laptop's size, so the list's Projects part is measured in that layout, not in the frame's empty box)
      if (this.doc !== "projects") {
        let st = null;
        try { st = JSON.parse(sessionStorage.getItem(SCREEN_KEY) || "null"); } catch { /* storage blocked */ }
        // (DYS-117: not before the page has the laptop's box: laid out at 0 x 0 its Projects part measures 0, and on phones,
        // which keep the 1440 page since DYS-33, nothing moved it there afterwards: /projects/ landed at About)
        const leanIn = (n = 0) => { this.layoutScreen(); if (ls.box?.[0] > 0 || n >= 120) this.leanScreen(ls, st); else requestAnimationFrame(() => leanIn(n + 1)); };
        if (lean && this.spot === "laptop") leanIn();
        else if (this.doc === "home" && ls.keep) ls.keep(st); else ls.scr.restore(st);
      }
      const scheme = () => ls.scr.setScheme(document.documentElement.dataset.scheme || null);
      scheme();
      new MutationObserver(scheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme"] });
      addEventListener("pagehide", () => this.saveScreen());
      this.layoutScreen();
      this.screenShown(this.live.revealed);
      if (this.lightMoment) this.screenLight(this.lightMoment, 0);   // (the screen's light, asked for before the screen was there)
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
    // (DYS-179: on a phone the pinch at the laptop is capped and follows the fingers: shared/laptop.js PHONE_PINCH_MAX)
    if (this.rig) this.rig.screenScaleMax = this.laptop.pinchMax || 0;
  }

  // The page shows with the room (the canvas): over the photograph it would be a second picture of the screen. So does
  // the phone's lock screen (handover-r2: it was shown from the desk's start, over the photograph, whose phone is off).
  // While the boot's handover holds them (screensHeld), the page is laid out but not shown and the lock screen is off.
  screenShown(on, { fade = 0 } = {}) {
    const held = on && !!this.screensHeld, ls = this.laptop;
    if (ls?.host) {
      ls.setShown(on);
      ls.host.classList.toggle("is-in", on && !held);
    }
    this.phone?.setShown(on && !held, { fade });
    if (on && this.rig?.pose) this.applyPose(this.rig.pose);
  }

  // handover-r2: after the boot's crossfade (or at once: `now`, when a visitor's move showed the room first, or the
  // handover ended another way) the held screens wake: the laptop's live page fades in over the 3D's own picture of the
  // screen and the phone's always-on lock screen comes on, over WAKE_MS (reduced motion: at once).
  wakeScreens({ now = false } = {}) {
    if (!this.screensHeld) return;
    this.screensHeld = false;
    if (!this.live?.revealed) return;   // (they come with the room's reveal, as before)
    const ms = now || reducedQ.matches ? 0 : WAKE_MS, root = document.documentElement;
    if (ms) {
      root.classList.add("sfw-waking");
      clearTimeout(this.wakeEnd);
      this.wakeEnd = setTimeout(() => root.classList.remove("sfw-waking"), ms + 100);
    }
    this.screenShown(true, { fade: ms });
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
    const st = this.laptop?.keptState?.() || this.laptop?.scr?.state();
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
    // (v3/laptop-phone: /projects/ lands at the Projects part of the laptop's page, under his About. projects-polish,
    // Akshay 28 Oct: a visit that has used the laptop before, reloaded there or back on /projects/, finds the list where
    // it left it, and the project it had open where it was on that project's page; else the list is at its Projects
    // part, under a shared project too, so going back to the list from it lands there)
    let kept = null;
    try { kept = JSON.parse(sessionStorage.getItem(SCREEN_KEY) || "null"); } catch { /* storage blocked */ }
    const asked = window.__sfwProject || null;
    if (kept && (kept.listTop > 0 || (asked && kept.route === asked))) await ls.scr.restore({ ...kept, route: asked && kept.route === asked ? asked : null });
    else await ls.scr.section("projects");
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

  // DYS-24 (Akshay 28 Oct: a reload on a deep page lands back where the visitor was, "no intermediate flat page and no
  // jump"; Quotes the model): /projects/ starts the room leaned in at the laptop (leanable). There is no photograph
  // of the room leaned in (the Projects photograph, scene.json views.projects, is the laptop from further back: today's
  // lean-in starts from it), so the first paint is the scene's own colours under the masthead, the desk's photograph
  // hidden (index.html, sfw-pre-page), and the room comes in AT the laptop once it is ready: no reading sheet, no glide.
  // The screen shows what it showed (the state saveScreen kept for this tab), when that is the page this address
  // names; else this address's project, or the list at its Projects part as a Projects link means (a shared link).
  // On a phone the page is used leaned in at the screen's own size (laptop.js narrow): with no glide in, that layout
  // comes in a cut as the screen wakes leaned in (startScreen, screenActive: setActive), before the room shows, and
  // the state kept leaned in on the phone was taken in it (projects/screen.js state: its width and anchors), so it
  // comes back at the same place. (A screen too small even so, under ~316 px, shows the laptop's page and opens it in
  // the sheet at a tap, as leaned in there; a sheet open at the reload is not reopened.)
  // (DYS-24 option a, on DYS-26: the Projects document's own arrival, arriveLaptop, keeps projects-polish's rule for a
  // kept state; this is the homepage's /projects/ and keeps the state as it was, About at the top included.)
  leanScreen(ls, st) {
    const route = ls.mod.routeOf(location.hash);
    if (st && (st.route ?? null) === route) ls.scr.restore(st);
    // (a shared project with nothing kept: the list first at its Projects part, then the project over it, as
    // arriveLaptop does for the Projects document; so going back from the project lands at Projects, not at About)
    else if (route) Promise.resolve(ls.scr.section("projects")).then(() => ls.scr.show(route)).catch(() => {});
    else Promise.resolve(ls.scr.section("projects")).catch(() => {});
    document.title = ls.mod.titleOf(route);
  }

  // The room at the laptop comes in by itself: once its picture has refined, the window's tiles are in and the screen's
  // page is there (at most HANDOVER_MAX), the canvas and the screen's page fade in together over the scene's colours
  // (the boot handover's HANDOVER_MS ease), then the landing as a lean-in's (the page's heading, the title). A drag first
  // shows it at once (reveal), as anywhere, and this stops waiting.
  async leanReveal() {
    const t0 = performance.now();
    await Promise.race([this.laptop?.ready, wait(HANDOVER_MAX)]).catch(() => {});
    // (the room refined, and the window's tiles in or HANDOVER_WAIT after that, as handover3d waits: without that limit a
    // cold load's tiles still streaming held the plain colours to HANDOVER_MAX, the coordinator's 8-14 s, 28 Oct)
    let settledAt = 0;
    for (;;) {
      const now = performance.now(), room = this.engine?.state === "settled";
      if (room && !settledAt) settledAt = now;
      if (now - t0 >= HANDOVER_MAX || this.live?.revealed || (room && (!this.outside?.store?.busy || now - settledAt > HANDOVER_WAIT))) break;
      await wait(100);
    }
    // (the room fell back to the photographs meanwhile: DYS-43, the Projects page itself)
    if (!this.live || this.mode !== "live") { this.projectsPage(); return; }
    clearTimeout(this.leanT);
    this.leanBoot = false;
    if (!this.live.revealed) {
      const c = this.live.canvas, root = document.documentElement;
      c.classList.add("sfw-handover"); root.classList.add("sfw-handing");
      this.reveal();
      await wait(HANDOVER_MS + 50);
      c.classList.remove("sfw-handover"); root.classList.remove("sfw-handing");
    }
    deskHidden(false);   // (under the room now; the photograph the room falls back to, as at the other spots)
    if (this.spot === "laptop" && this.landedAt === "laptop" && !this.rig.glide) this.afterLanding("laptop");
  }

  // The visitor moved or pressed Escape before the room came in at the laptop: the desk's photograph comes back (the
  // room, when it comes, is at the desk).
  leanOff() {
    if (!this.leanBoot) return;
    this.leanBoot = false;
    clearTimeout(this.leanT);
    if (this.spot === "laptop") this.spot = "desk";
    history.replaceState({ ...(history.state || {}), sfw: 1, spot: "desk" }, "", location.href);
    deskHidden(false);
    this.showClose();
  }

  // DYS-43 (Akshay 28 Oct: "we shouldn't put reading sheets for anything even if its mobile"): no room to land at the
  // laptop in (it will not start, has fallen back to the photographs, or is still not there after LEAN_BOOT_MAX): the
  // Projects page itself, the address's own document (/projects/, with the project it names), never a reading sheet.
  // The visit is marked as one whose room did not start (ROOM_OFF_KEY), so that page stays a page, as the static
  // writing pages do, and does not send the browser back here.
  projectsPage() {
    clearTimeout(this.leanT);
    this.leanBoot = false;
    try { sessionStorage.setItem(ROOM_OFF_KEY, "1"); } catch { /* storage blocked */ }
    const q = new URLSearchParams(location.search);
    q.delete("page");
    const s = q.toString();
    location.replace(`/projects/${s ? `?${s}` : ""}${location.hash}`);
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
    // (DYS-107: the page's photograph out of the compositor once the room has covered it, PHOTO_OFF_MS on, past this
    // screen's 320 ms; asked here too, as reveal() does nothing when a drag showed the room first)
    this.photoLayers();
    if (!own || !sc) return;
    const ss = own.querySelector(".screen-scroll");
    if (ss && ss.scrollHeight > ss.clientHeight) {
      // (the page's own screen has no About above its list: its place is kept within the room's Projects part)
      const k = ss.scrollTop / Math.max(1, ss.scrollHeight - ss.clientHeight);
      if (k > 0 || !sc.sectionTop) requestAnimationFrame(() => {
        const s = sc.scroller, base = sc.sectionTop?.("projects") || 0;
        s.scrollTop = base + k * Math.max(0, s.scrollHeight - s.clientHeight - base);
      });
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
    if (u.hash === "#about") { e.preventDefault(); this.about(); }
    else if (u.hash === "#social") { e.preventDefault(); this.social(); }
  }

  // v3/laptop-phone (Akshay, 20 Oct: "lets combine About and Projects into one - show both on the laptop"): About is
  // the top of the laptop's page (projects/screen.js: his bio and links, then the Projects page). The menu's About
  // leans in to the laptop with its page at About (there already: the page goes up to it); from Books or Quotes the
  // room glides to the desk and loads /#about, which goes on to the laptop (as Social goes to the phone); while the
  // room is starting it waits for it, and only a browser where it cannot start shows his bio in the reading sheet.
  about() {
    const live = () => this.mode === "live" && !!this.rig && !!this.room?.spots.laptop;
    if (live()) { this.toAbout().catch(() => {}); return; }
    if (this.mode !== "still" && this.room?.spots.laptop && this.ready) {
      this.ready.then((ok) => (ok && live() ? this.toAbout() : this.openAbout())).catch(() => this.openAbout().catch(() => {}));
      return;
    }
    this.openAbout().catch(() => {});
  }

  async toAbout() {
    if (this.doc !== "home" && this.doc !== "projects") { this.glideThenLoad("desk", new URL("/#about", location.href).href); return; }
    if (this.laptop) await Promise.race([this.laptop.ready.catch(() => null), wait(8000)]);
    const sc = this.laptop?.scr;
    if (!sc) { if (this.doc === "home") await this.openAbout(); return; }   // (the laptop's page did not load)
    const was = sc.route ?? null, here = this.spot === "laptop", landed = here && this.landedAt === "laptop";
    const drawn = sc.section("about", { smooth: landed });
    if (!here) { this.go("laptop"); return; }
    await drawn;
    if (this.spot !== "laptop") return;
    if (was !== null) this.screenRouted(null, true);   // (a project was open: the list, a history entry, as its back link)
    else if (landed) this.overlays.landed(sc.heading());
  }

  // /#about loaded fresh: the live room leans in to the laptop at About once it draws steadily (at most 3 s, as
  // /#social goes to the phone); without it, his bio in the reading sheet. The address becomes the desk's, and the
  // laptop its own entry.
  async arriveAbout(live) {
    if (!live || !this.room?.spots.laptop) { await this.openAbout({ fresh: true }); return; }
    history.replaceState(history.state, "", location.pathname + location.search);
    const t0 = performance.now();
    while (!reducedQ.matches && performance.now() - t0 < 3000 && !(this.engine?.state === "settled" && !this.outside?.store?.busy)) await wait(100);
    const t1 = performance.now();
    while (this.rig?.glide && performance.now() - t1 < 3000) await wait(100);
    if (this.spot === "desk") await this.toAbout();
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

  // ---------- one continuous page (v3/qa-nav) ----------
  // Books or Quotes in this document before the room is ready (or without it): over its own photograph and with its
  // own overlays, as on its own document, never a page load. The room's first frame there is that photograph's own
  // camera (bootPose, photoNow), and the photograph fades out over it as the room hands over (ownOff).
  hostEarly(name, { push = true } = {}) {
    const from = this.spot;
    const seq = ++this.seq;
    if (push) history.pushState({ sfw: 1, spot: name }, "", PAGE_URL[name]);
    this.spot = name;
    if (from === "window" && name !== "window") this.photoWindow(false);
    this.close.hidden = true;
    const p = (async () => {
      let why = null;
      const prep = await this.loadPage(name).then((parsed) => this.preparePage(name, parsed)).catch((err) => { why = err; return null; });
      if (seq !== this.seq || this.spot !== name) { prep?.drop(); return false; }
      if (!prep) {
        // the page could not be read here: its own document (and this visit keeps the pages as documents)
        deskHidden(false);
        // (DYS-151 (c), PAGE_SWAP: on a phone, after a move in this document while its room starts or runs, the page's own
        // document still comes (the page the visitor asked for; with (a) it starts no room of its own), but in place of
        // this one, location.replace: location.assign would keep this document, room and all, for Back while that one
        // loads. Its GPU context is let go first, in case the browser keeps it anyway. Back then loads the desk afresh. A
        // reload or a Back to the page's address, push false, already goes by location.replace)
        const swap = PAGE_SWAP && push && (this.mode === "booting" || this.mode === "live");
        console.warn(`[DYS-151] ${PAGE_URL[name]} could not be read here (${why?.message || why}): ${swap ? "its own document in place of this one, the room let go (?pagenav=1 for the old way)" : "loading its own document"}`);
        try { sessionStorage.setItem("sfw-page-doc", "1"); } catch { /* storage blocked */ }
        if (swap) {
          this.letGo = true;   // (DYS-171: the boot stops, bootLeft)
          try { document.querySelector("canvas.sfw-canvas")?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* no context */ }
          location.replace(PAGE_URL[name]);
          return false;
        }
        if (push) location.assign(PAGE_URL[name]); else location.replace(location.href);
        return false;
      }
      if (this.page) { const old = this.page; this.page = null; this.unmountPage(old); }
      this.mountPage(name, prep, { own: this.mode !== "live" });
      // the desk's photograph under the page stays out of sight while the page is over it (else the room's crossfade
      // with the page's photograph would show it through both): hidden once the page has faded in (from the first
      // paint on, for the page this document was opened for)
      const box = this.page.el;
      if (this.page.own) setTimeout(() => { if (this.page?.el === box && this.page.own) deskHidden(true); }, reducedQ.matches ? 0 : 300);
      document.title = this.page.title;
      if (push) this.overlays.landed(this.page.el.querySelector("h1"));
      this.showClose();
      return true;
    })();
    this.hosting = p;
    return p;
  }

  // The room has come: a page brought in before it hands its photograph over (ms: the fade), its overlays follow the
  // camera from now (the camera is on that photograph's own).
  ownOff(ms = 150) {
    const p = this.page;
    if (!p?.own) return;
    p.own = false;
    p.anchorLater?.();
    const box = p.el;
    box.style.setProperty("--sfw-own-ms", `${ms}ms`);
    box.classList.add("sfw-own-out");
    setTimeout(() => { box.classList.remove("sfw-own", "sfw-own-out"); box.style.removeProperty("--sfw-own-ms"); if (!this.page?.own) deskHidden(false); }, ms + 60);
  }

  // Back to the desk without the room (still starting, or none): the page brought in goes, the desk's photograph is
  // under it.
  dropPage({ push = true } = {}) {
    ++this.seq;
    deskHidden(false);
    if (push) history.pushState({ sfw: 1, spot: "desk" }, "", "/");
    this.spot = "desk";
    const p = this.page;
    if (p) {
      this.page = null;
      p.el.classList.add("is-out");
      setTimeout(() => this.unmountPage(p), reducedQ.matches ? 0 : 160);
    }
    document.title = this.title0;
    this.ariaCurrent(null);
    this.showClose();
  }

  // A move while the room is still starting (more than NEVER_WAIT away): never a page load.
  early(name, push) {
    if (name === this.spot && (!PAGE_MODULE[name] || this.page?.spot === name)) return;   // (already there)
    // (DYS-24: the room was to come in at the laptop: the desk's photograph back first, then the move as before; the
    // desk itself goes through backToDesk)
    if (name !== "desk") this.leanOff();
    if (PAGE_MODULE[name]) return this.hostEarly(name, { push });
    if (name === "laptop") return this.openProjects();
    if (name === "notebook") return this.openWriting();
    if (name === "phone") return this.openSocial();
    if (name === "window") { if (this.page) this.dropPage(); return this.enterWindow(); }
    if (name === "desk") return this.page ? this.dropPage({ push }) : this.backToDesk();
  }

  // The Projects page in the reading sheet (shared/laptop.js openSheet's way, without the laptop's screen): a shared
  // /projects/ link (fresh: its address is already the page's), or Projects asked for while the room is still
  // starting. Closing returns to the room: the laptop showing what the sheet showed, if the room has leaned in behind
  // the sheet (behindProjects), else the desk.
  async openProjects({ fresh = false, slug = null } = {}) {
    const [r, mod] = await Promise.all([this.startReader(), import("/projects/screen.js")]);
    if (r.isOpen && r.slug === "projects") return;
    let route = slug;
    this.projRoute = () => route;
    const sc = mod.createScreen({ reduced: () => reducedQ.matches, className: "rd-frame", onRoute: (s) => { route = s ?? null; } });
    sc.restore({ route, top: 0, listTop: 0 });
    // (the list asked for, on a page with parts, v3/laptop-phone's About + Projects: at its Projects part, as a
    // Projects link means; a page without parts shows its top, which is its list, as before)
    if (route == null && typeof sc.section === "function") { Promise.resolve(sc.section("projects")).catch(() => {}); this.holdProjects(sc); }
    const done = (e) => {
      if (e.detail?.slug !== "projects") return;
      document.removeEventListener("reader:closed", done);
      this.projRoute = null;
      sc.pause(true);
      sc.host.remove();   // (the frame goes with its sheet)
      const ls = this.laptop;
      if (ls?.scr && (ls.scr.route ?? null) !== (route ?? null)) { ls.scr.show(route); this.saveScreen(); }
      if (this.spot === "laptop" && ls?.scr) { document.title = ls.mod.titleOf(ls.scr.route); ls.scr.heading()?.focus?.({ preventScroll: true }); }
    };
    document.addEventListener("reader:closed", done);
    sc.ready?.then(() => {
      if (!r.isOpen || r.slug !== "projects") return;
      const h = sc.heading();
      if (h && !h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1");
      h?.focus({ preventScroll: true });
    }).catch(() => {});
    const page = {
      label: "Projects", kind: "frame", build: () => sc.host, scroller: () => sc.scroller || sc.host,
      url: mod.projectURL(route),
      home: () => (this.spot === "laptop" ? mod.projectURL(route) : "/" + location.search),
    };
    try { await r.open({ slug: "projects", page }, null, fresh ? { history: false, deep: true } : {}); } catch { done({ detail: { slug: "projects" } }); }
  }

  // The sheet's page at its Projects part from its first drawn frame on (a page with parts, v3/laptop-phone). The page
  // enters with its own fade that also rises 5 px (the Projects page's .page-enter, 0.42 s), and its layout can still
  // settle (fonts): measured while it rises, its Projects part was 4 px off once it had risen (the stage's
  // laptop.projects.phone). So, on every frame while the hold lasts, the sheet's scroll is the page's own measure of its
  // Projects part (sectionTop, as the check measures it): the label stays on its line from the first drawn frame and the
  // page fades in in place (its 5 px rise is not seen in the sheet); and every change of the page's size, in the frame's
  // own ResizeObserver (after layout, before paint), does the same. Until the visitor scrolls or touches the sheet,
  // opens a project in it, the sheet closes, or 4 s have passed since the page was drawn.
  holdProjects(sc) {
    if (typeof sc.sectionTop !== "function") return;
    const t0 = performance.now(), offs = [];
    let ro = null, done = false, on = null, tick = 0, tA = 0, raf = 0;   // (tA: when the page was first there to hold)
    const detach = () => { ro?.disconnect(); ro = null; if (raf && on?.defaultView) on.defaultView.cancelAnimationFrame(raf); raf = 0; for (const [t, k, f] of offs.splice(0)) t.removeEventListener(k, f, true); on = null; };
    const end = () => { if (done) return; done = true; clearInterval(tick); detach(); };
    const fix = () => {
      if (done) return;
      if ((tA && performance.now() - tA > 4000) || !this.reader?.isOpen || this.reader.slug !== "projects" || (sc.route ?? null) !== null) { end(); return; }
      const s = sc.scroller, want = sc.sectionTop("projects");
      if (s && want > 0 && Math.abs(s.scrollTop - want) > 0.5) s.scrollTop = want;
    };
    // (the frame's document is there once the page is drawn in it: looked for each frame, at most 15 s; a frame that
    // loads its page again is followed to its new document)
    const attach = () => {
      if (done || (!tA && performance.now() - t0 > 15000)) { end(); return; }
      const s = sc.scroller, d = s?.ownerDocument, w = d?.defaultView;
      if (!d || !w || !d.getElementById("sfw-projects")) { requestAnimationFrame(attach); return; }
      if (on === d) return;
      detach();
      on = d;
      tA ||= performance.now();
      ro = new (w.ResizeObserver || ResizeObserver)(fix);
      for (const n of [d.documentElement, d.body, d.getElementById("root")]) if (n) ro.observe(n);
      for (const k of ["wheel", "touchstart", "keydown", "pointerdown"]) { const f = () => end(); d.addEventListener(k, f, true); offs.push([d, k, f]); }
      d.fonts?.ready?.then(fix).catch(() => {});
      // every frame (the page's entrance moves it without a change of size): before that frame's layout and paint
      const frame = () => { if (done || on !== d) return; fix(); raf = w.requestAnimationFrame(frame); };
      fix();
      raf = w.requestAnimationFrame(frame);
    };
    attach();
    tick = setInterval(() => {
      if (done) return;
      if (tA && performance.now() - tA > 4000) { end(); return; }
      const d = sc.scroller?.ownerDocument;
      if (on && d && d !== on) attach();
    }, 100);
  }

  // A shared Projects link: once the room is ready and the page has been quiet 0.8 s, it leans in to the laptop behind
  // the sheet, the screen showing what the sheet shows; closing the sheet leaves the visitor there (on a wider screen
  // it settles into the screen by itself).
  async behindProjects() {
    await this.quiet(ABOUT_IDLE);
    const ls = this.laptop;
    if (!ls) return;
    try { await ls.ready; } catch { return; }
    if (!this.reader?.isOpen || this.reader.slug !== "projects" || this.spot !== "desk" || this.rig.glide || !ls.scr) return;
    const route = this.projRoute?.() ?? null;
    if ((ls.scr.route ?? null) !== route) ls.scr.show(route);
    // (the list, on a page with parts, v3/laptop-phone's About + Projects: the laptop's screen at its Projects part too,
    // as the sheet is, before the lean-in starts; at most 1.5 s for the page to be drawn)
    if (route == null && typeof ls.scr.section === "function") await Promise.race([Promise.resolve(ls.scr.section("projects")).catch(() => {}), wait(1500)]);
    // (a wheel, a key or a touch on the sheet meanwhile: the visitor is reading it, and it stays)
    let touched = false;
    const mark = () => { touched = true; };
    const kinds = ["wheel", "keydown", "pointerdown", "touchstart"];
    for (const k of kinds) addEventListener(k, mark, { capture: true, passive: true });
    try { await this.liveGo("laptop", false); } finally { for (const k of kinds) removeEventListener(k, mark, { capture: true }); }
    if (this.spot !== "laptop" || this.landedAt !== "laptop") return;
    history.replaceState({ ...(history.state || {}), sfw: 1, spot: "laptop" }, "", location.href);
    // wider screens: the sheet settles into the laptop's screen, which shows the same page (today's end of a shared
    // link: the project open on the laptop); phones keep it (their laptop's screen is read in the sheet anyway)
    if (!touched && !ls.small && this.reader?.isOpen && this.reader.slug === "projects") {
      this.reader.setOrigin(() => { const r = ls.host?.getBoundingClientRect(); return r && r.width > 4 ? r : null; });
      this.reader.close();
    }
  }

  // Writing while the room is still starting (DYS-106, Akshay 28 Oct: no reading sheets anywhere; it opened the essays'
  // list in the reading sheet, and its essays there): it waits for the room (no time limit, as Social waits for the
  // phone) and leans in to the notebook, as Writing does in the live room. If the room does not start, the essays' own
  // page, /writing/, the visit marked as one whose room did not start (ROOM_OFF_KEY, as essayPage does) so that page's
  // head keeps it a page. Gone elsewhere meanwhile (another spot, a sheet opened): nothing.
  async openWriting() {
    const from = this.spot;
    const live = await this.ready;
    if (this.spot !== from || this.reader?.isOpen) return;
    if (live) return this.go("notebook");
    try { sessionStorage.setItem(ROOM_OFF_KEY, "1"); } catch { /* storage blocked */ }
    location.assign("/writing/");
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
      // (v3/laptop-phone: a link to /projects/ other than the laptop itself, the menu's, lands at the Projects part of
      // the laptop's page; the laptop's own link keeps its page where it was left)
      if (name === "laptop" && !a.closest(".sfw-links") && this.mode === "live") this.laptop?.scr?.section("projects", { smooth: this.landedAt === "laptop" });
      if (this.mode === "live" || this.mode === "booting") { e.preventDefault(); this.go(name); return; }
      if (name === "notebook") { e.preventDefault(); this.go(name); return; }
      if (name === "desk" && (this.spot === "window" || this.spot === "notebook" || this.page)) { e.preventDefault(); this.backToDesk(); }
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
      this.fv?.nudge();   // (v3/loading: the line says the room is still on its way)
      // never wait: 120 ms for the 3D (the phone, only in the live room, waits for it 8 s, then his links' sheet)
      // (v3/qa-nav: then the move happens in this document, early(): never a page load while the room starts)
      const ok = await Promise.race([this.ready, wait(name === "phone" ? 8000 : NEVER_WAIT).then(() => null)]);
      if (!ok && this.doc === "home" && this.mode === "booting") return this.early(name, push);
      if (!ok) return this.fallback(name, push, { zoom });
    }
    if (this.mode !== "live") return this.fallback(name, push, { zoom });
    if (this.doc !== "home") {
      return this.glideThenLoad(name, this.urlOf(name));
    }
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
    // (DYS-149 mt-diet2: the page's scroll read here, before leaving()'s writes, not after them, where it forced a style
    // + layout of its own (MD1b: a page change by Back (onPop) and into the window). Nothing in between scrolls the page
    // (leaving() hides and moves things over the room; the page it leaves goes 160 ms later). ?mtdiet=0: after, as before)
    const scrolled = MT_DIET ? scrollY > 0 : null;
    if (push) { history.pushState({ sfw: 1, spot: name }, "", url); this.pushedHere = true; this.pushedFrom = from; }
    this.spot = name;
    this.leaving(from, name);
    // the room is the first screen: a glide from further down the page brings it back into view
    if (scrolled ?? scrollY > 0) scrollTo({ top: 0, behavior: reducedQ.matches ? "instant" : "smooth" });
    // the page's HTML, stylesheets and module load while the camera glides; it is attached on landing
    // (DYS-151: one that can't be read leaves the room at the spot without it, never a page load; said in the console)
    const pageP = PAGE_MODULE[name] ? this.loadPage(name).then((parsed) => this.preparePage(name, parsed))
      .catch((err) => { console.warn(`[DYS-151] ${PAGE_URL[name]} could not be read in the live room (${err?.message || err}): staying at the spot without it`); return null; }) : null;
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
        const newMoment = moment !== engine.light.moment;
        if (newMoment) this.screenLight(moment, opts.fade);
        await engine.setLight({ moment, lamp, screen: 1 }, opts).catch(() => {});
        markLamp(engine.light.lamp > 0);
        // (v3/laptop-phone, call 4: the 3D's own picture of the screen at the new moment's white, by its measured gain,
        // once the light change has frozen the old frame to fade from)
        if (newMoment) engine.setScreenGain?.(this.screenGain(moment));
      } while (this.lightAgain);
    } finally { this.lightBusy = false; }
  }

  // The laptop's screen at this moment's brightness (room3d.json's laptop_screen, which assemble.py writes from the
  // photographs' screens; v3/laptop-phone, Akshay 21 Oct): at the desk a real screen's at a comfortable brightness
  // (by day the photographs' own screen white; in a dark room a soft glow, never paper-white), leaned in the page's
  // own white; the photograph hands over to the room with one screen, and it follows the room's light as it changes.
  // Without it, the page's own white.
  // The 3D's own picture of the screen, its gain at this moment (room3d.json laptop_screen.texture, measured on the room
  // at 1440x900; texture_phone at 390x844, for portrait screens: the phone's photograph's view; v3/laptop-phone call 4)
  screenGain(moment) {
    const L = this.room?.data?.laptop_screen;
    const T = (innerWidth < innerHeight ? L?.texture_phone : null) || L?.texture;
    return T?.[moment] || null;
  }

  screenLight(moment, ms = 0) {
    this.lightMoment = moment;
    const L = this.room?.data?.laptop_screen;
    const desk = L?.desk?.[moment] || null, lean = L?.lean?.[moment] || null;
    this.laptop?.ready?.then(() => { if (this.lightMoment === moment) this.laptop.setLight(desk, lean, reducedQ.matches ? 0 : ms); }).catch(() => {});
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
  // DYS-164 (B's WebKit check of DYS-159): on a touch screen at the laptop, the page pinched larger than its lean-in fills
  // the screen with its white, and the masthead's light words sat on it unread: it steps aside while the page is larger
  // (5 % on, back under 2 %: a pinch held near the edge does not blink it) and comes back as the page returns to its
  // lean-in, or the view leaves the laptop. Desktops, and the page at its lean-in, as before.
  mastAside() {
    const g = this.mode === "live" && this.spot === "laptop" && coarseQ.matches ? this.laptop?.grown || 1 : 1;
    const on = this.mastOff ? g > 1.02 : g > 1.05;
    if (on === !!this.mastOff) return;
    this.mastOff = on;
    document.documentElement.classList.toggle("sfw-mast-aside", on);
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
    if (from === "laptop" && to !== "laptop") this.eggObj?.stop();
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
      // (v3/qa-nav: a page brought in before the room, left by a glide: the desk's photograph comes back under the
      // room once the canvas is on)
      if (p.own) { p.own = false; setTimeout(() => { if (!this.page?.own) deskHidden(false); }, reducedQ.matches ? 0 : 400); }
      setTimeout(() => this.unmountPage(p), reducedQ.matches ? 0 : 160);
    }
    this.live?.edges?.show(false);
    this.close.hidden = true;
    this.quietMasthead();   // leaning in: quiet; leaning back: it comes back as the glide starts
    this.light();           // nothing stays lit through a glide
  }

  hideContent({ keepPrint = false } = {}) {
    const els = [this.page?.el, keepPrint ? null : this.o.print?.()?.el].filter(Boolean);
    // a page that came in by .is-in (sfw-in: no end keyframe, fill both) keeps following its inline opacity through the
    // animation, so the 150 ms fade below jumped to 0 in one frame (books-card-cut: the Books card cut at the glide's
    // start). Its arrival is over: end it where it stands (mid-arrival too), then the fade runs from there
    const pg = this.page?.el;
    if (pg?.classList.contains("is-in") && !reducedQ.matches) {
      const o = getComputedStyle(pg).opacity;
      pg.style.transition = "none";
      pg.style.opacity = o;
      pg.classList.remove("is-in");
      void pg.offsetWidth;
    }
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
    fitEdges(this.live?.edges, this.room, rest, w, h, this.phoneDeskRest(w, h), this.edgeBox());
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
    const hosted = !!this.page && this.page.spot === this.spot;   // (v3/qa-nav: a page brought in before the room)
    this.close.hidden = !(away && (this.mode === "live" || this.spot === "window" || this.spot === "notebook" || hosted) || (pageDoc && this.mode === "live"));
  }

  // "Back to the desk", Escape: from the window or the About card, Back undoes their history entry.
  backToDesk() {
    if (this.doc !== "home") {
      if (this.mode === "live") this.glideThenLoad("desk", new URL("/", location.href).href);
      else location.assign("/");
      return;
    }
    // (DYS-24: Escape while the room was still to come in at the laptop: the desk's photograph, at the desk's address)
    if (this.leanBoot && this.mode !== "live") { this.leanOff(); history.pushState({ sfw: 1, spot: "desk" }, "", "/"); document.title = this.title0; return; }
    // the window and the About card are history entries of their own: leaving one undoes it, as Back does, when
    // the entry before it is the desk; entered from elsewhere (the window from the About card), it goes to the desk
    // (the phone, and the laptop the headphones leaned to, are history entries of their own too: interactions B)
    const own = this.spot === "window" || this.spot === "notebook" || this.spot === "phone" || (this.spot === "laptop" && history.state?.egg);
    if (own && history.state?.spot === this.spot && this.pushedHere && this.pushedFrom === "desk") { history.back(); return; }
    if (this.mode === "live") { this.liveGo("desk", true); return; }
    if (this.page) { this.dropPage(); return; }   // (v3/qa-nav: a page brought in before the room, or without it)
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
    // (v3/qa-nav) while the room starts, or with a page brought in without it: Books and Quotes come back in this
    // document, and leave it again
    if (this.mode === "booting" || this.page) {
      if (PAGE_MODULE[name]) { this.hostEarly(name, { push: false }); return; }
      if (this.page && name !== this.page.spot) this.dropPage({ push: false });
    }
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
    // (review since 4376506f, 2: the masthead docks/undocks now, and the spot framed in this same task (glideTo, jumpTo)
    // must see its new height: the kept one is let go here, before the ResizeObserver would after the layout)
    this.box = null;
  }
  openDial() { const d = document.getElementById("dial"); if (d?.hidden && this.docked) document.getElementById("now")?.click(); }

  // ---------- the About card ----------
  // The homepage's words while the live room runs (Akshay, 2026-10-15): the page no longer scrolls, the words are
  // a card over the room. Deferred while the visitor is reading below the window: they move once the page is back
  // at its top (a glide scrolls it there).
  // (DYS-149 mt-diet2: y0, the page's scroll startLive read with its first measure; else read here)
  enterCardMode(y0) {
    if (this.doc !== "home" || this.cardMode || this.mode !== "live") return;
    if ((y0 ?? scrollY) > 2) {
      if (this.cardWait) return;
      this.cardWait = () => { if (scrollY <= 2 && this.mode === "live") { removeEventListener("scroll", this.cardWait); this.cardWait = null; this.enterCardMode(); } };
      addEventListener("scroll", this.cardWait, { passive: true });
      return;
    }
    this.cardMode = true;
    this.placeAbout(this.spot === BIO_SPOT ? "notebook" : this.spot === "desk" && !this.rig?.glide && this.cardOpen ? "desk" : "away");
    this.updateScrollMode(MT_DIET);
  }

  // The homepage with its words in the card has nothing below the room: one-finger drags turn the view any way. Not
  // where the room is taller than the screen (a phone on its side, a short window: the scene's min-height of 520 px):
  // there the page scrolls as below a page's room, or the masthead under the first screen is out of reach (qa-night T-F2)
  roomOnly() {
    if (!this.cardMode || this.page) return false;
    const se = document.scrollingElement || document.documentElement;
    return se.scrollHeight <= innerHeight + 1;
  }

  // (DYS-149 mt-diet) later: once the page is next laid out (a ResizeObserver's first call, after that layout and
  // before its paint), not now: in startLive (enterCardMode) the page's height was read right after the card's writes,
  // a forced style + layout of its own (1.6-2.1 ms of startLive's task on the barely-sufficient laptop). The class only
  // sets touch-action (the CSS above); gestures.js asks roomOnly() itself. ?mtdiet=0: at once, as before
  updateScrollMode(later = false) {
    if (later && typeof ResizeObserver === "function") {
      if (this.scrollModeRO) return;
      const ro = this.scrollModeRO = new ResizeObserver(() => { ro.disconnect(); this.scrollModeRO = null; this.updateScrollMode(); });
      ro.observe(document.documentElement);
      return;
    }
    document.documentElement.classList.toggle("sfw-noscroll", this.roomOnly());
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
    // (DYS-149 mt-diet: both read before the first write, and kept (measured()): the masthead was read after
    // --sfw-hero-h was set on the root, a forced style recalc of the whole page, 3.3-3.8 ms of startLive's task on the
    // barely-sufficient laptop. The same values: neither depends on these properties)
    const [, h] = this.size ? this.size() : [innerWidth, innerHeight];
    const mh = this.mastH() ?? 96;
    r.style.setProperty("--sfw-hero-h", `${Math.max(520, h)}px`);
    r.style.setProperty("--sfw-mh", `${Math.round(mh)}px`);
    r.style.setProperty("--sfw-card-in", reducedQ.matches ? `${CUT}ms` : "250ms");
  }

  aboutCard(on) {
    if (this.cardMode) return this.placeAbout(on ? "notebook" : "away");
    const about = document.getElementById("about");
    if (!about) return;
    const r = document.documentElement;
    const [w, h] = this.size ? this.size() : [innerWidth, innerHeight];
    const mh = this.mastH() ?? 96;   // (DYS-149 mt-diet: read before the writes, as cardVars)
    r.style.setProperty("--sfw-hero-h", `${Math.max(520, h)}px`);
    r.style.setProperty("--sfw-mh", `${Math.round(mh)}px`);
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
      // kept up through glides, it is cut where furniture stands in front of it (shared/occlude.js; the desk only by its
      // top board, from below it, and the things on the desk: deskOccluders)
      occluders: [...(this.room.obstacles || []).filter((o) => o.box && o.name !== "print" && o.name !== "desk"), ...deskOccluders(this.room)].map((o) => o.box),
    });
    this.overlays.update(this.rig.pose, ...this.size());
    void on;
  }

  // ---------- pages in the homepage ----------
  prefetch(name) { if (PAGE_MODULE[name] && this.doc === "home") this.loadPage(name).catch(() => {}); }

  // DYS-60: the page spots' files fetched at idle once the room is in, one spot at a time, so a glide to the shelf or
  // the print loads nothing: D's trace (29 Oct) had a glide to the shelf fetch and parse the Books page, its module,
  // world.css, three fonts, its photograph and more inside the glide's own frames (~1 s of the main thread). Each: the
  // page and its module (loadPage, as a glide starts it), its stylesheets put in now (preparePage puts them in at the
  // glide anyway; they style only the pages' own classes and stay in), the font faces they declare, and the page's
  // eager images (its photograph; the lazy ones, the covers, stay lazy)
  prefetchPages() {
    if (this.doc !== "home" || this.pagesFetched) return;
    this.pagesFetched = true;
    const names = Object.keys(PAGE_MODULE).filter((n) => n !== this.spot && this.room?.spots?.[n]);
    const one = (i) => {
      if (i >= names.length || this.mode !== "live") return;
      idle(() => this.loadPage(names[i]).then((parsed) => {
        const fonts = () => setTimeout(() => { for (const f of document.fonts) if (f.status === "unloaded") f.load().catch(() => {}); }, 500);
        // (DYS-149: the hand-over restyle) put in at an idle moment without the faces the homepage has (putSheet); the
        // font faces still unloaded then (none of world.css's: they were the homepage's own) once they are in
        if (RESTYLE) Promise.all(parsed.sheets.map((href) => putSheet(href, { later: true }))).then(fonts);
        else {
          for (const href of parsed.sheets) {
            if ([...document.styleSheets].some((x) => x.href && new URL(x.href).pathname === new URL(href, location.href).pathname)) continue;
            document.head.appendChild(el("link", { rel: "stylesheet", href, "data-sfw-sheet": "" }));
          }
          fonts();
        }
        for (const img of parsed.main?.querySelectorAll?.("img:not([loading=\"lazy\"])") || []) {
          const im = new Image();
          im.decoding = "async";
          im.fetchPriority = "low";
          if (img.getAttribute("sizes")) im.sizes = img.getAttribute("sizes");
          if (img.getAttribute("srcset")) im.srcset = img.getAttribute("srcset");
          if (img.getAttribute("src")) im.src = img.getAttribute("src");
        }
      }).catch(() => {}).finally(() => setTimeout(() => one(i + 1), 1500)), 4000);
    };
    one(0);
  }

  loadPage(name) {
    const url = this.room?.spots?.[name]?.url || PAGE_URL[name];   // (v3/qa-nav: asked for before the spots are read)
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
      // (DYS-149: the hand-over restyle) without the faces the homepage has; in its place now (before the page's own
      // <style>s below), filled when its text is in (putSheet; the prefetch's own, if it is on its way)
      if (RESTYLE) { loads.push(Promise.race([putSheet(href), wait(1500)])); continue; }
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

  mountPage(name, { parsed, mod, added }, { own = false } = {}) {
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
    // (v3/qa-nav) before the room: the page as on its own document, over its own photograph; its overlays follow the
    // camera once the room hands over (ownOff)
    if (own) {
      box.classList.add("sfw-own");
      this.page.own = true;
      this.page.photo = () => { const geo = handle.room?.geo, v = handle.room?.view; return geo && v ? { view, size: [v.width, v.height], geo } : null; };
      this.page.anchorLater = () => this.anchor(handle, photo);
      return;
    }
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

// (v3/qa-nav) the desk's photograph (index.html's #stage) out of sight while a page brought in before the room is over
// it (index.html sets it from the first paint for /?page=books|quotes)
function deskHidden(on) { document.documentElement.classList.toggle("sfw-pre-page", on); }

function el(tag, attrs = {}) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

// (DYS-149: the hand-over restyle, RESTYLE) a style sheet the router puts in, once per address (its pathname; a second
// caller gets the same promise, settled once the sheet applies). Its text, fetched, in a <style data-sfw-sheet
// data-sfw-href=<path>> without the @font-face rules the document already has (shared/faces.js). Its place in <head> is
// taken when it is asked for, as its <link> was (the end of <head>, before a page's own <style>s that preparePage adds
// next: the cascade's order as before), and filled when the text is in. `later` (the prefetch): placed and filled at an
// idle moment once the text is in, and its restyle (the whole document's, world.css's :root and @property) done there by
// a style read, not inside the next frame; a caller that wants it now (startReader, a glide's preparePage) places it at
// once. A <link> in that place, as before, where the text could not be fetched (or without constructable sheets), or
// where it has an @import or a relative URL (a <style> would read that from the page's address, not the sheet's).
const sheetsPut = new Map();
function sheetIn(path) {
  const same = (h) => { try { return !!h && new URL(h, location.href).pathname === path; } catch { return false; } };
  return [...document.styleSheets].some((s) => same(s.href))
    || [...document.querySelectorAll('link[rel="stylesheet"], style[data-sfw-href]')].some((n) => same(n.getAttribute("href") || n.getAttribute("data-sfw-href")));
}
function putSheet(href, { later = false } = {}) {
  const path = new URL(href, location.href).pathname;
  let job = sheetsPut.get(path);
  if (!job) {
    if (sheetIn(path)) return Promise.resolve();
    const parses = typeof CSSStyleSheet === "function" && typeof CSSStyleSheet.prototype.replaceSync === "function";
    job = { node: null, css: undefined };
    job.p = new Promise((r) => { job.resolve = r; });
    sheetsPut.set(path, job);
    (parses ? fetch(href).then((r) => (r.ok ? r.text() : null)).catch(() => null) : Promise.resolve(null)).then((css) => {
      job.css = css;
      if (job.node) fillSheet(job, href);
      else idle(() => { if (!job.node) { placeSheet(job, path); fillSheet(job, href, true); } }, 4000);
    });
  }
  if (!later && !job.node) { placeSheet(job, path); if (job.css !== undefined) fillSheet(job, href); }
  return job.p;
}
function placeSheet(job, path) {
  job.node = el("style", { "data-sfw-sheet": "", "data-sfw-href": path });
  document.head.appendChild(job.node);
}
function fillSheet(job, href, idleNow = false) {
  const css = job.css;
  // (an @import, a relative url() or image-set() string: faces.js ownURLs)
  if (css == null || ownURLs(css)) {
    const l = el("link", { rel: "stylesheet", href, "data-sfw-sheet": "" });
    l.onload = l.onerror = () => job.resolve();
    job.node.replaceWith(l);
    job.node = l;
    return;
  }
  job.node.textContent = withoutRepeatedFaces(css);
  if (idleNow) void getComputedStyle(document.documentElement).color;   // (its restyle now, in this idle moment)
  job.resolve();
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
