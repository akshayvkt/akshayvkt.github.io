// Runs in <head>, before the first paint, after frames-lite.js: sets this moment's room colours
// (--wall, --paper, --ink, --muted, --accent, --sky, --desk and data-scheme) so no page flashes the wrong palette.
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
  var best = seq[0], d = Infinity;
  for (var i = 0; i < seq.length; i++) { var dd = Math.abs(seq[i].alt - s.alt); if (dd < d) { d = dd; best = seq[i]; } }
  var root = document.documentElement, p = best.palette;
  if (p) {
    ["wall", "desk", "sky", "paper", "ink", "muted", "accent"].forEach(function (k) { root.style.setProperty("--" + k, p[k]); });
    root.dataset.scheme = p.scheme;
  }
  root.dataset.ink = best.ink;
  root.dataset.moment = best.id;
})();
