// Runs in <head>, before the first paint, after frames-lite.js: sets this moment's room colours
// (--wall, --paper, --ink, --muted, --accent, --sky, --desk and data-scheme) so no page flashes the wrong palette.

// The menu (masthead-r2, Akshay 20 Oct): in the live room the objects lead to Projects, Books and Quotes (the laptop,
// Poor Charlie's Almanack on the desk, the print), so its menu is About, Writing and Social. A visit that may run the
// room says so here, before the first paint (html.sfw-room-menu: the masthead's "plain" links hide), so the menu never
// changes under the visitor; shared/router.js takes it away again when the room does not start. Without scripts, with
// reduced motion, ?3d=0, Save-Data, a 2G line, a small device or a visit whose room did not start, the full plain list
// stays (the router's own reasons: engineModule, bootTier, ROOM_OFF_KEY).
// (DYS-31, Akshay 28 Oct) without the live room the menu leads to the simple website (/simple/, scripts/simple/
// build_simple.mjs): its links point there once the page is in (a visit without scripts keeps the static pages);
// shared/router.js and app.js call it again when the room does not start after all
window.__sfwSimpleMenu = function () {
  var map = { "/#about": "/simple/", "/projects/": "/simple/", "/writing/": "/simple/writing/", "/books/": "/simple/books/",
    "/quotes.html": "/simple/quotes/", "/#social": "/simple/hi/" };
  var go = function () {
    var ns = document.querySelectorAll(".masthead nav a");
    for (var i = 0; i < ns.length; i++) {
      var h = ns[i].getAttribute("href");
      if (map[h]) { ns[i].setAttribute("data-room-href", h); ns[i].setAttribute("href", map[h]); }
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
};
// (the live room started after all, after the safety below or an earlier room-less visit had switched them: the room's
// own links again; shared/router.js startLive)
window.__sfwRoomMenu = function () {
  var ns = document.querySelectorAll(".masthead nav a[data-room-href]");
  for (var i = 0; i < ns.length; i++) { ns[i].setAttribute("href", ns[i].getAttribute("data-room-href")); ns[i].removeAttribute("data-room-href"); }
};
(function () {
  var simple = function () { try { window.__sfwSimpleMenu(); } catch (e) {} };
  try {
    var p = new URLSearchParams(location.search).get("3d"), off = false;
    try { p = p || sessionStorage.getItem("sfw-3d"); off = sessionStorage.getItem("sfw-room-off") === "1"; } catch (e) {}
    if (p === "0" || off || matchMedia("(prefers-reduced-motion: reduce)").matches) return simple();
    var c = navigator.connection;
    if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ""))) return simple();
    if (navigator.deviceMemory && navigator.deviceMemory < 4) return simple();
    var r = document.documentElement;
    r.classList.add("sfw-room-menu");
    // (the router says within seconds whether the room runs; if it never comes, the full list comes back)
    setTimeout(function () { if (!window.__sfwRouterUp) { r.classList.remove("sfw-room-menu"); simple(); } }, 15000);
  } catch (e) {}
})();

(function () {
  var F = self.SKY_FRAMES;
  if (!F || !F.length) return;
  var RAD = Math.PI / 180, LAT = 37.8011, LON = -122.4195;
  function sun(date) {
    var n = date / 86400000 + 2440587.5 - 2451545.0;
    var L = (280.46 + 0.9856474 * n) % 360, g = ((357.528 + 0.9856003 * n) % 360) * RAD;
    var lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD, eps = (23.439 - 0.0000004 * n) * RAD;
    var ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)), dec = Math.asin(Math.sin(eps) * Math.sin(lam));
    var gmst = (18.697374558 + 24.06570982441908 * n) % 24, ha = (gmst * 15 + LON) * RAD - ra, la = LAT * RAD;
    var alt = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
    var az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
    return { alt: alt / RAD, az: ((az / RAD) + 360) % 360 };
  }
  var minutes = null;
  var q = new URLSearchParams(location.search).get("time");
  if (q) { var hm = q.split(":"); minutes = (+hm[0]) * 60 + (+(hm[1] || 0)); }
  else { try { var v = sessionStorage.getItem("sky-time"); if (v !== null) minutes = +v; } catch (e) {} }
  var now = new Date();
  if (minutes !== null && !isNaN(minutes)) {
    var parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
    var get = function (t) { for (var i = 0; i < parts.length; i++) if (parts[i].type === t) return +parts[i].value; };
    var off = (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute")) - now.getTime()) / 60000;
    now = new Date(Date.UTC(get("year"), get("month") - 1, get("day")) - off * 60000 + minutes * 60000);
  }
  var s = sun(now), am = s.az < 180;
  var seq = F.filter(function (f) { return f.side === (am ? "am" : "pm") || f.side === "both"; })
    .sort(function (x, y) { return am ? x.alt - y.alt : y.alt - x.alt; });
  // around solar noon both sequences meet at midday (the highest rendered sun), as shared/sky.js noonLift does
  function lift(top) {
    var la = LAT * RAD, al = s.alt * RAD, az = s.az * RAD;
    var sd = Math.max(-1, Math.min(1, Math.sin(la) * Math.sin(al) + Math.cos(la) * Math.cos(al) * Math.cos(az)));
    var noon = 90 - LAT + Math.asin(sd) / RAD;
    if (!(top > noon)) return 0;
    var ha = Math.atan2(-Math.sin(az) * Math.cos(al), (Math.sin(al) - Math.sin(la) * sd) / Math.cos(la)) / RAD;
    var x = Math.abs(ha) * 4 / 30;
    return x >= 1 ? 0 : (top - noon) * (1 - x * x * (3 - 2 * x));
  }
  var alt = s.alt + lift(am ? seq[seq.length - 1].alt : seq[0].alt);
  var best = seq[0], d = Infinity;
  for (var i = 0; i < seq.length; i++) { var dd = Math.abs(seq[i].alt - alt); if (dd < d) { d = dd; best = seq[i]; } }
  var root = document.documentElement, p = best.palette;
  if (p) {
    ["wall", "desk", "sky", "paper", "ink", "muted", "accent"].forEach(function (k) { root.style.setProperty("--" + k, p[k]); });
    root.dataset.scheme = p.scheme;
  }
  root.dataset.ink = best.ink;
  root.dataset.moment = best.id;
})();
