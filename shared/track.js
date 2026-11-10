// Behaviour analytics (D, 10 Nov; Akshay: "use mixpanel", coordinator's brief renders/coordinator/briefs/
// D-analytics-events-10nov.md): what visitors do on the site, as plain events, to Mixpanel (the main tool: project
// "akshaychintalapati.com", 4082519) and to Google Analytics through the page's own tag (window.gtag, kept: Akshay's
// standing rule). No personal data and no id of ours: every value is a number or a short word (Mixpanel's and GA's own
// fields ride along as they do on their page views).
// Every event carries page (the page's kind: home, books, quotes, projects, essay, how, simple) and scr (phone /
// tablet / desktop), as shared/beacon.js defines them:
//   zoom_level         level 2 | 4: the magnifier reached it (once each per page), moment: the time of day shown
//   moment_change      moment (the time of day now shown), how: control (the dial, or back to now) | auto (the clock
//                      moved on to the next moment); a dial drag sends the moment it rests on, once
//   object_open        object: the router's spot (shelf, notebook, laptop, phone, window), headphones, breadboard, book
//                      (with id: the book's), essay (with id: its slug)
//   sound_play         sound: ambient (the Sound control) | headphones (the video)
//   him_click          a link to How it's made clicked (from: the page's kind)
//   him_view           How it's made opened
//   him_section        section reached on How it's made: view, layers, scale, up_close, data, room, sound, build, credits
//                      (once each)
//   outbound_click     kind: social | writing | projects | video | other, host: the link's host
//   first_interaction  ms: the first click, tap or key, from the page's start
// Mixpanel's own page view on load ($mp_web_page_view: the address and the referrer, track_pageview).
// Where it comes from: every page the GA tag is on loads this file (scripts/deploy/build_dist.py --track), a module
// (deferred: never blocking the page). Mixpanel's library (self-hosted: web/vendor/mixpanel-browser-2.84.0, through the
// official snippet) after the page's load event, at idle (LOAD_LATEST at the latest), only on the site's own host and
// never in a test browser (navigator.webdriver): a stage, a smoke test or a dev page sends Mixpanel nothing. GA gets
// each event wherever the page has its tag. Hooks elsewhere are one line each and work before this file has loaded:
//   (globalThis.__sfwT ||= []).push([name, params])
// in shared/router.js (go, egg, blinkBoard), shared/rig.js (the zoom) and shared/sound.js (Sound on); the rest is heard
// here (sky:moment, sfw:book, reader:open, clicks). Nothing runs in the render loop; every call is in try/catch.
// ?debug: every event kept in window.__sfwTrack.events (tests: scripts/live/track_test.mjs).
import { deviceClass, kindOf } from "./beacon.js";

export const MP_TOKEN = "180ee2d7577d74e8fbaa48abce62ceac";   // the project's public token (client-side by design)
export const MP_LIB = "/vendor/mixpanel-browser-2.84.0/mixpanel.min.js";
export const MP_HOSTS = ["akshaychintalapati.com", "www.akshaychintalapati.com"];
export const EVENTS = ["zoom_level", "moment_change", "object_open", "sound_play", "him_click", "him_view", "him_section",
  "outbound_click", "first_interaction"];
export const SETTLE = 1500;          // ms: a dial drag's last moment, sent this long after the drag stops
export const LOAD_LATEST = 6000;     // ms: Mixpanel's library is asked for by then even if the page's load event is late
const MAX = 200;                     // events per page at most (a runaway hook can't flood either tool)
const AGAIN = 1000;                  // ms: the same object asked twice by one tap (a link and its click) counts once
const SECTIONS = { layers: "layers", scale: "scale", "zoom-sec": "up_close", data: "data", room: "room", sound: "sound",
  build: "build", credits: "credits" };

/** The page's kind from its address (the address itself is never an event's parameter). */
export function pageOf(href) {
  let u;
  try { u = new URL(href); } catch { return "home"; }
  if (/^\/how-its-made(\/|$)/.test(u.pathname)) return "how";
  if (/^\/simple(\/|$)/.test(u.pathname)) return "simple";
  return kindOf(href);
}

/** An outbound link's kind, from its host. */
export function outboundKind(host) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  const is = (...d) => d.some((x) => h === x || h.endsWith("." + x));
  if (is("x.com", "twitter.com", "linkedin.com", "instagram.com", "threads.net", "bsky.app", "facebook.com")) return "social";
  if (is("substack.com", "medium.com")) return "writing";
  if (is("youtube.com", "youtu.be", "youtube-nocookie.com", "vimeo.com")) return "video";
  if (is("github.com", "github.io", "apps.apple.com", "huggingface.co", "vercel.app")) return "projects";
  return "other";
}

/** An event's parameters as numbers and short words only (anything else left out). */
export function clean(p) {
  const out = {};
  for (const [k, v] of Object.entries(p || {})) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
    else if (typeof v === "string" && v) out[k] = v.slice(0, 80);
  }
  return out;
}

// the official snippet (mixpanel-browser 2.84.0's dist/mixpanel-jslib-snippet.min.js, unchanged): the stub that queues
// calls until the library (MIXPANEL_CUSTOM_LIB_URL: our copy) has loaded
function snippet() {
  (function(e,c){if(!c.__SV){var l,h;window.mixpanel=c;c._i=[];c.init=function(q,r,f){function t(d,a){var g=a.split(".");2==g.length&&(d=d[g[0]],a=g[1]);d[a]=function(){d.push([a].concat(Array.prototype.slice.call(arguments,0)))}}var b=c;"undefined"!==typeof f?b=c[f]=[]:f="mixpanel";b.people=b.people||[];b.toString=function(d){var a="mixpanel";"mixpanel"!==f&&(a+="."+f);d||(a+=" (stub)");return a};b.people.toString=function(){return b.toString(1)+".people (stub)"};l="disable time_event track track_pageview track_links track_forms track_with_groups add_group set_group remove_group register register_once alias unregister identify name_tag set_config reset opt_in_tracking opt_out_tracking has_opted_in_tracking has_opted_out_tracking clear_opt_in_out_tracking start_batch_senders start_session_recording stop_session_recording people.set people.set_once people.unset people.increment people.append people.union people.track_charge people.clear_charges people.delete_user people.remove".split(" ");
  for(h=0;h<l.length;h++)t(b,l[h]);var n="set set_once union unset remove delete".split(" ");b.get_group=function(){function d(p){a[p]=function(){b.push([g,[p].concat(Array.prototype.slice.call(arguments,0))])}}for(var a={},g=["get_group"].concat(Array.prototype.slice.call(arguments,0)),m=0;m<n.length;m++)d(n[m]);return a};c._i.push([q,r,f])};c.__SV=1.2;var k=e.createElement("script");k.type="text/javascript";k.async=!0;k.src="undefined"!==typeof MIXPANEL_CUSTOM_LIB_URL?MIXPANEL_CUSTOM_LIB_URL:"file:"===
  e.location.protocol&&"//cdn.mxpnl.com/libs/mixpanel-2-latest.min.js".match(/^\/\//)?"https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js":"//cdn.mxpnl.com/libs/mixpanel-2-latest.min.js";e=e.getElementsByTagName("script")[0];e.parentNode.insertBefore(k,e)}})(document,window.mixpanel||[]);
}

let st = null;

/** Start (once per document). A silent no-op where there is neither GA's tag nor the site's host, unless ?debug. */
export function install({ debug = /[?&]debug(=|&|$)/.test(location.search) } = {}) {
  if (st) return st;
  const gaOn = () => typeof window.gtag === "function";
  const mpOn = MP_HOSTS.includes(location.hostname) && !navigator.webdriver;
  if (!gaOn() && !mpOn && !debug) return null;
  const root = document.documentElement;
  const page = pageOf(location.href);
  let scr = "desktop";
  try { scr = deviceClass(screen.width, screen.height, matchMedia("(pointer: coarse)").matches, devicePixelRatio).scr; } catch { /* */ }
  st = { events: [], mp: mpOn ? "waiting" : "off", page, scr };
  if (debug) window.__sfwTrack = st;
  const pend = [];          // Mixpanel's events until its snippet is in
  const once = new Set();
  const lastAt = new Map();

  const send = (name, params, key) => {
    try {
      if (!EVENTS.includes(name) || st.events.length >= MAX) return;
      if (key) { if (once.has(key)) return; once.add(key); }
      const p = { page, scr, ...clean(params) };
      st.events.push({ name, ...p });
      if (gaOn()) window.gtag("event", name, p);
      if (!mpOn) return;
      if (window.mixpanel?.track && st.mp !== "waiting") window.mixpanel.track(name, p);
      else pend.push([name, p]);
    } catch { /* never the page's problem */ }
  };

  // ---- the hooks' queue (globalThis.__sfwT): what was pushed before now, then each push as it comes
  const hooked = ([name, params] = []) => {
    try {
      const p = { ...(params || {}) };
      if (name === "zoom_level") { p.moment = root.dataset.moment; return send(name, p, `zoom${p.level}`); }
      if (name === "object_open") {
        const k = `${p.object}:${p.id || ""}`, t = performance.now();
        if (t - (lastAt.get(k) ?? -Infinity) < AGAIN) return;
        lastAt.set(k, t);
      }
      send(name, p);
    } catch { /* */ }
  };
  const early = Array.isArray(globalThis.__sfwT) ? globalThis.__sfwT : [];
  globalThis.__sfwT = { push: (...xs) => { for (const x of xs) hooked(x); } };
  for (const x of early) hooked(x);

  // ---- the time of day (masthead.js's sky:moment: reason dial / reset / tick / scene)
  let shown = root.dataset.moment || null, settle = 0;
  document.addEventListener("sky:moment", (e) => {
    try {
      const d = e.detail || {}, id = d.frame?.id || root.dataset.moment;
      if (!id) return;
      if (d.reason === "scene" || !d.reason) { if (!settle) shown = id; return; }
      if (d.reason === "dial") {
        clearTimeout(settle);
        settle = setTimeout(() => { settle = 0; if (id !== shown) { shown = id; send("moment_change", { moment: id, how: "control" }); } }, SETTLE);
        return;
      }
      clearTimeout(settle); settle = 0;
      if (id === shown && d.reason === "tick") return;
      shown = id;
      send("moment_change", { moment: id, how: d.reason === "tick" ? "auto" : "control" });
    } catch { /* */ }
  });

  // ---- books and essays (the router's sfw:book, reader.js's reader:open)
  document.addEventListener("sfw:book", (e) => hooked(["object_open", { object: "book", id: e.detail?.id || undefined }]));
  document.addEventListener("reader:open", (e) => hooked(["object_open", { object: "essay", id: e.detail?.slug || undefined }]));

  // ---- links: How it's made, and other sites
  document.addEventListener("click", (e) => {
    try {
      const a = e.target?.closest?.("a[href]");
      if (!a) return;
      const u = new URL(a.getAttribute("href"), location.href);
      if (u.origin === location.origin) {
        if (/^\/how-its-made(\/|$)/.test(u.pathname) && page !== "how") send("him_click", { from: page });
      } else if (/^https?:$/.test(u.protocol)) send("outbound_click", { kind: outboundKind(u.hostname), host: u.hostname.replace(/^www\./, "") });
    } catch { /* */ }
  }, { capture: true, passive: true });

  // ---- the first interaction
  const first = (e) => {
    for (const t of ["pointerdown", "keydown"]) removeEventListener(t, first, { capture: true });
    send("first_interaction", { ms: Math.round(e?.timeStamp || performance.now()) }, "first");
  };
  for (const t of ["pointerdown", "keydown"]) addEventListener(t, first, { capture: true, passive: true });

  // ---- How it's made: the page, and its sections as they reach the screen's upper half
  if (page === "how") {
    send("him_view", {});
    try {
      const steps = [...document.querySelectorAll("#peel-steps .step")];
      const marks = [];
      if (steps[0]) marks.push([steps[0], "view"]);
      for (const s of document.querySelectorAll("section[id]")) {
        const name = SECTIONS[s.id];
        if (!name) continue;
        // (the hero is the layers section from the page's top: its first step, "00 · The view", is the view; the
        // layers are reached at its next step)
        if (s.id === "layers" && steps[1]) marks.push([steps[1], name]);
        else if (s.id !== "layers" || !steps.length) marks.push([s, name]);
      }
      if (marks.length && "IntersectionObserver" in window) {
        const of = new Map(marks);
        const io = new IntersectionObserver((list) => {
          for (const x of list) {
            if (!x.isIntersecting) continue;
            send("him_section", { section: of.get(x.target) }, `sec:${of.get(x.target)}`);
            io.unobserve(x.target);
          }
        }, { rootMargin: "0px 0px -50% 0px" });
        for (const [el] of marks) io.observe(el);
      }
    } catch { /* */ }
  }

  // ---- Mixpanel: its library after the page's load, at idle; its page view on init; then what was waiting
  if (mpOn) {
    let asked = false;
    const start = () => {
      if (asked) return;
      asked = true;
      (window.requestIdleCallback || ((fn) => setTimeout(fn, 300)))(() => {
        try {
          window.MIXPANEL_CUSTOM_LIB_URL = MP_LIB;
          snippet();
          window.mixpanel.init(MP_TOKEN, { track_pageview: true });
          st.mp = "on";
          for (const [n, p] of pend.splice(0)) window.mixpanel.track(n, p);
        } catch (err) { st.mp = "error"; st.error = String(err?.message || err); }
      }, { timeout: 2000 });
    };
    if (document.readyState === "complete") start();
    else addEventListener("load", start, { once: true });
    setTimeout(start, LOAD_LATEST);
  }
  return st;
}

/** (tests) forget this document's install. */
export function _reset() { st = null; }

if (typeof window !== "undefined" && typeof document !== "undefined" && !globalThis.__sfwTrackManual) install();
