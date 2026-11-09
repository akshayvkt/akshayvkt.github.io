// The shared clock of the apartment: every page shows the same San Francisco moment.
// Used by the homepage (app.js) and by the Books, Projects and Quotes pages.

export const SF = { lat: 37.8011, lon: -122.4195, tz: "America/Los_Angeles" };
const RAD = Math.PI / 180;
const KEY = "sky-time";   // a time picked on the dial follows you from page to page (this tab only)

// ---------------------------------------------------------------- San Francisco's clock without Intl (DYS-216 D)
// The first date formatted in a time zone sets ICU up: 30-61 ms of a phone's boot at 6x CPU, in caption() before the
// still showed (each later call ~0.1 ms). With ?jslean=1 San Francisco's offset comes from the US rule (laOffset) and
// the page's few clock and date texts are put together here (LEAN_TEXT), the same as Intl's, so this file,
// city/clock.js, print.js, phone.js and notebook.js call no Intl before the room is shown (reader.js makes its
// formatter at its first use). Once it is (router.js's "sfw:room-shown" mark found by a call; or LEAN_LATE ms on, for a
// page whose room never comes) an idle moment compares them with Intl (leanCheck): the same, the rule stays; any
// difference, Intl for good, with a warning. Without ?jslean=1: Intl, the same calls in the same order as before.
export const JSLEAN = typeof location !== "undefined" && new URLSearchParams(location.search || "").get("jslean") === "1";
const LEAN_LATE = 30000;
let leanState = JSLEAN ? 1 : 0, leanAsked = false;   // 1: the rule, not yet checked; 2: checked; 0: Intl
const leanOff = [];
export const onLeanOff = (fn) => { leanOff.push(fn); };   // (city/clock.js: its cached offsets go with the rule)
function sfLean() {
  if (leanState === 1 && !leanAsked && typeof performance !== "undefined" &&
    (performance.getEntriesByName?.("sfw:room-shown")?.length || performance.now() > LEAN_LATE)) {
    leanAsked = true;   // (Safari, no requestIdleCallback: 2 s on, after the hand-over's crossfade and framing ease)
    (globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 2000)))(() => leanCheck(), { timeout: 3000 });
  }
  return leanState > 0;
}
// US daylight time, the rule since 2007: from the second Sunday of March, 10:00 UTC (2:00 PST), to the first Sunday of
// November, 09:00 UTC (2:00 PDT). San Francisco's offset from UTC at ms, in minutes: -420 inside, -480 outside.
export function laOffset(ms) {
  const y = new Date(ms).getUTCFullYear();
  const sun1 = (m) => 1 + (7 - new Date(Date.UTC(y, m, 1)).getUTCDay()) % 7;   // the month's first Sunday
  return ms >= Date.UTC(y, 2, sun1(2) + 7, 10) && ms < Date.UTC(y, 10, sun1(10), 9) ? -420 : -480;
}
// With ?jslean=1 (until a check finds the rule wrong): San Francisco's offset at ms (minutes, laOffset); else null (Intl)
export const sfOffset = (ms) => (sfLean() && Number.isFinite(+ms) ? laOffset(+ms) : null);
const wall = (t, rule) => new Date(t + rule(t) * 60000);   // San Francisco's wall clock, read with getUTC*
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const clockOf = (w) => `${w.getUTCHours() % 12 || 12}:${String(w.getUTCMinutes()).padStart(2, "0")}`;
const LEAN_TEXT = {
  offset: (t, rule) => String(rule(t)),
  caption: (t, rule) => { const w = wall(t, rule); return `${clockOf(w)} ${w.getUTCHours() < 12 ? "AM" : "PM"}`; },   // caption()'s "6:42 PM"
  clock: (t, rule) => clockOf(wall(t, rule)),   // phone.js TIME's hour and minute: "6:42"
  day: (t, rule) => { const w = wall(t, rule); return `${DAYS[w.getUTCDay()]}, ${MONTHS[w.getUTCMonth()]} ${w.getUTCDate()}`; },   // phone.js DATE
  date: (t) => { const d = new Date(t); return `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; },   // notebook.js DATE (UTC)
};
// With ?jslean=1: the text of `kind` (LEAN_TEXT) for date; else null (the caller's Intl)
export const leanText = (kind, date) => (sfLean() && Number.isFinite(+date) ? LEAN_TEXT[kind](+date, laOffset) : null);
const intlTime = (date) => date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: SF.tz });
// The check: LEAN_TEXT by `rule` against Intl, every kind a day either side of now, the names in every month too.
export function leanCheck(now = Date.now(), rule = laOffset) {
  if (!leanState) return false;
  const f = (o) => new Intl.DateTimeFormat("en-US", o);
  const full = f({ timeZone: SF.tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const clock = f({ timeZone: SF.tz, hour: "numeric", minute: "2-digit", hour12: true });
  const day = f({ timeZone: SF.tz, weekday: "long", month: "long", day: "numeric" });
  const date = f({ month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const parts = (fmt, t) => Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]));
  const intl = {
    offset: (t) => { const p = parts(full, t); return String((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - t) / 60000); },
    caption: (t) => intlTime(new Date(t)),
    clock: (t) => { const p = parts(clock, t); return `${p.hour}:${p.minute}`; },
    day: (t) => day.format(t),
    date: (t) => date.format(t),
  };
  const m = Math.floor(now / 60000) * 60000, y = new Date(m).getUTCFullYear();
  const at = [[m - 86400000, m, m + 86400000], Object.keys(LEAN_TEXT)];
  const months = [Array.from({ length: 12 }, (_, i) => Date.UTC(y, i, 15, 19)), ["day", "date"]];
  for (const [ts, kinds] of [at, months]) {
    for (const t of ts) {
      for (const k of kinds) {
        const a = LEAN_TEXT[k](t, rule), b = intl[k](t);
        if (a === b) continue;
        leanState = 0;
        console.warn(`[jslean] ${k} at ${new Date(t).toISOString()}: "${a}" by hand, "${b}" by Intl: Intl from now on`);
        for (const fn of leanOff) fn();
        return false;
      }
    }
  }
  leanState = 2;
  return true;
}

// Sun altitude and azimuth (degrees, azimuth clockwise from north), NOAA approximation.
export function sunPosition(date) {
  const n = date / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const ha = (gmst * 15 + SF.lon) * RAD - ra;
  const la = SF.lat * RAD;
  const alt = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { alt: alt / RAD, az: ((az / RAD) + 360) % 360 };
}

// Minutes since midnight in San Francisco right now.
export function minutesNowSF() {
  const now = Date.now(), off = sfOffset(now);
  if (off !== null) { const w = new Date(now + off * 60000); return w.getUTCHours() * 60 + w.getUTCMinutes(); }
  const hm = new Intl.DateTimeFormat("en-US", { timeZone: SF.tz, hour: "numeric", minute: "numeric", hour12: false })
    .format(new Date()).split(":");
  return (+hm[0] % 24) * 60 + +hm[1];
}

// The time the page should show: ?time=HH:MM, else a time picked earlier in this tab, else now.
export function getOverride() {
  const q = new URLSearchParams(location.search).get("time");
  if (q) {
    const [h, m] = q.split(":").map(Number);
    if (!Number.isNaN(h)) return h * 60 + (m || 0);
  }
  try {
    const v = sessionStorage.getItem(KEY);
    return v === null ? null : +v;
  } catch { return null; }
}
export function setOverride(minutes) {
  try {
    if (minutes === null) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, String(minutes));
  } catch { /* storage blocked: the choice just won't follow you */ }
}

// A Date for today in San Francisco at the given minute (or now when minutes is null).
export function sfDate(minutes) {
  const now = new Date();
  if (minutes === null || minutes === undefined) return now;
  const off = sfOffset(now.getTime());
  let get;
  if (off !== null) {   // (?jslean=1: the fields Intl gives, from the rule)
    const w = new Date(now.getTime() + off * 60000);
    const f = { year: w.getUTCFullYear(), month: w.getUTCMonth() + 1, day: w.getUTCDate(), hour: w.getUTCHours(), minute: w.getUTCMinutes() };
    get = (t) => f[t];
  } else {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: SF.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
    get = (t) => +parts.find((p) => p.type === t).value;
  }
  const offsetMin = (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute")) - now.getTime()) / 60000;
  const midnightUtc = Date.UTC(get("year"), get("month") - 1, get("day")) - offsetMin * 60000;
  return new Date(midnightUtc + minutes * 60000);
}

// "The sky over San Francisco at 6:42 PM"
export function caption(date) {
  const t = leanText("caption", date) ?? intlTime(date);
  return `The sky over San Francisco at ${t}`;
}

// Around solar noon the altitude the pick uses is lifted toward `top` (midday's render, the highest rendered sun): all
// the way at noon, easing to nothing NOON_MIN minutes either side, so the morning and the afternoon sequences meet at
// midday and the blend changes smoothly through noon. From about October to February the sun never climbs to
// midday's render, and the pick used to jump at noon from mostly latemorning to mostly afternoon (qa-night B-F4).
// Days whose sun reaches `top` are not lifted. The day's highest sun and the time from noon come from the sun's own
// position (its declination and hour angle at SF's latitude), so every caller of pickFrames agrees.
const NOON_MIN = 30;
function noonLift(sun, top) {
  const la = SF.lat * RAD, al = sun.alt * RAD, az = sun.az * RAD;
  const sd = Math.max(-1, Math.min(1, Math.sin(la) * Math.sin(al) + Math.cos(la) * Math.cos(al) * Math.cos(az)));   // sin(declination)
  const noon = 90 - SF.lat + Math.asin(sd) / RAD;   // the day's highest sun (SF is north of the tropics)
  if (!(top > noon)) return 0;
  const ha = Math.atan2(-Math.sin(az) * Math.cos(al), (Math.sin(al) - Math.sin(la) * sd) / Math.cos(la)) / RAD;   // hour angle
  const x = Math.abs(ha) * 4 / NOON_MIN;   // 15 degrees an hour: minutes from noon, over NOON_MIN
  return x >= 1 ? 0 : (top - noon) * (1 - x * x * (3 - 2 * x));
}

// The two rendered moments that bracket the sun, and how far between them we are (t in 0..1).
// Mornings and evenings are separate sequences because the light comes from opposite sides; they meet at midday
// (noonLift).
export function pickFrames(frames, sun) {
  const morning = sun.az < 180;
  const seq = frames.filter((f) => f.side === (morning ? "am" : "pm") || f.side === "both")
    .sort((x, y) => (morning ? x.alt - y.alt : y.alt - x.alt));
  const alt = sun.alt + noonLift(sun, morning ? seq[seq.length - 1].alt : seq[0].alt);
  if (morning) {
    if (alt <= seq[0].alt) return { a: seq[0], b: seq[0], t: 0 };
    for (let i = 0; i < seq.length - 1; i++) {
      if (alt <= seq[i + 1].alt) return { a: seq[i], b: seq[i + 1], t: (alt - seq[i].alt) / (seq[i + 1].alt - seq[i].alt) };
    }
  } else {
    if (alt >= seq[0].alt) return { a: seq[0], b: seq[0], t: 0 };
    for (let i = 0; i < seq.length - 1; i++) {
      if (alt >= seq[i + 1].alt) return { a: seq[i], b: seq[i + 1], t: (seq[i].alt - alt) / (seq[i].alt - seq[i + 1].alt) };
    }
  }
  const last = seq[seq.length - 1];
  return { a: last, b: last, t: 0 };
}

// The single moment to show when only one can be (the room layer snaps; see README).
export const nearest = (sel) => (sel.t < 0.5 ? sel.a : sel.b);

// AVIF when the browser decodes it, else WebP. Cached for the tab.
let fmtPromise = null;
export function imageFormat() {
  if (fmtPromise) return fmtPromise;
  try {
    const c = sessionStorage.getItem("sky-fmt");
    if (c) return (fmtPromise = Promise.resolve(c));
  } catch { /* ignore */ }
  fmtPromise = new Promise((res) => {
    const img = new Image();
    const done = (ok) => { const f = ok ? "avif" : "webp"; try { sessionStorage.setItem("sky-fmt", f); } catch { /* ignore */ } res(f); };
    img.onload = () => done(img.width > 0);
    img.onerror = () => done(false);
    img.src = "data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAAFAAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAAAQAAAAEAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAAHG1kYXQSAAoFGAAGBCAyCRgACiiihAAFSA==";
  });
  return fmtPromise;
}

// Choose the smallest rendered width that covers `pixels`, else the largest. sizes: {"3840": path, ...}
export function pickSize(sizes, pixels) {
  const ws = Object.keys(sizes).map(Number).sort((a, b) => a - b);
  const w = ws.find((x) => x >= pixels) ?? ws[ws.length - 1];
  return sizes[String(w)];
}

export function url(path, fmt) { return `/${path}.${fmt}`; }

// Which homepage photograph a screen shows (v3/phone-frame, 20 Oct): app.js lays it out and transition.js finds it;
// index.html's first-paint script repeats these numbers (it runs before any module). Here rather than in a module of
// its own so the page asks for no new file (smoke zoom.net: a fresh visit requests exactly what v3/live's does).
//   - phones (portrait, under 0.8, at most PHONE_MAX_W CSS px wide): home_m, the photograph taken from the 3D's phone
//     camera (spots.json desk.phone), when the set has it;
//   - every other portrait screen (tablets), and phones while a set has no home_m: home_p, as before; else home_l.
export const HOME_PORTRAIT_BELOW = 0.8;   // viewport aspect (w/h) under which a portrait photograph is used
export const PHONE_MAX_W = 500;           // CSS px; framing.js's phone camera uses spots.json desk.phone.maxWidth (500) too
export function homeViewFor(w, h, views = {}) {
  const portrait = w / h < HOME_PORTRAIT_BELOW;
  if (portrait && w <= PHONE_MAX_W && views.home_m) return "home_m";
  if (portrait && views.home_p) return "home_p";
  return "home_l";
}

// (DYS-212, Akshay 1 Nov: 'so the laptop is level') a phone's first visit opens close on the laptop turned so that its
// screen is level (app.js layout(), fvLevel). The turn: minus the mean of the screen's top and bottom edges' angles,
// in the photograph's own pixels (the layout is a uniform scale, so it is the angle as laid out); degrees, clockwise
// positive (CSS rotate). The scale: just enough that the hero, turned about its centre, still covers its corners.
// Phones only: home_m, or a portrait screen at most PHONE_MAX_W wide on a set without it (home_p); tablets (home_p)
// and laptops (home_l: ~0.3 deg, no visible change) are not turned.
export const FV_LEVEL_MIN = 0.5;   // deg: a smaller tilt is left as it is
export function screenTilt(quad, W, H) {
  const P = quad.map(([x, y]) => [x * W, y * H]).sort((a, b) => a[1] - b[1]);
  const [tl, tr] = P.slice(0, 2).sort((a, b) => a[0] - b[0]), [bl, br] = P.slice(2).sort((a, b) => a[0] - b[0]);
  const deg = (p, q) => (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI;
  const top = deg(tl, tr), bottom = deg(bl, br);
  return { top, bottom, mean: (top + bottom) / 2 };
}
export function coverScale(deg, w, h) {
  const t = (Math.abs(deg) * Math.PI) / 180;
  return Math.cos(t) + Math.sin(t) * Math.max(w / h, h / w);
}
// (span: the turned screen's width over the tilted one's, ~0.97: app.js keeps the level screen FV_FILL_P wide)
export function fvLevelFor(key, view, w, h) {
  const q = view?.quads?.screen;
  const phone = key === "home_m" || (key === "home_p" && w / h < HOME_PORTRAIT_BELOW && w <= PHONE_MAX_W);
  if (!q || !phone || !view.width || !view.height) return null;
  const deg = -screenTilt(q, view.width, view.height).mean;
  if (Math.abs(deg) < FV_LEVEL_MIN) return null;
  const t = (deg * Math.PI) / 180, P = q.map(([x, y]) => [x * view.width, y * view.height]);
  const ext = (xs) => Math.max(...xs) - Math.min(...xs);
  const span = ext(P.map(([x, y]) => x * Math.cos(t) - y * Math.sin(t))) / ext(P.map(([x]) => x));
  return { deg, s: coverScale(deg, w, h), span };
}
// The CSS translate that, with rotate(deg) and scale(s) about an element's own transform origin o, turns it about the
// point c instead (o and c in the same px): c' - R S c', c' = c - o (the element's own transform is kept, after it)
export function turnAbout(o, c, deg, s) {
  const x = c[0] - o[0], y = c[1] - o[1], t = (deg * Math.PI) / 180, co = Math.cos(t) * s, si = Math.sin(t) * s;
  return [x - (co * x - si * y), y - (si * x + co * y)];
}

// Colours sampled from the room at this moment, as CSS variables on <html>.
export function applyPalette(frame, root = document.documentElement) {
  const p = frame && frame.palette;
  if (!p) return;
  for (const k of ["wall", "desk", "sky", "paper", "ink", "muted", "accent"]) root.style.setProperty(`--${k}`, p[k]);
  root.dataset.scheme = p.scheme;
}

let scenePromise = null;
export function loadScene() {
  return (scenePromise ??= fetch("/scene.json").then((r) => r.json()));
}
