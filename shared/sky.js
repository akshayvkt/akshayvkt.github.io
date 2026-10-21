// The shared clock of the apartment: every page shows the same San Francisco moment.
// Used by the homepage (app.js) and by the Books, Projects and Quotes pages.

export const SF = { lat: 37.8011, lon: -122.4195, tz: "America/Los_Angeles" };
const RAD = Math.PI / 180;
const KEY = "sky-time";   // a time picked on the dial follows you from page to page (this tab only)

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
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: SF.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const get = (t) => +parts.find((p) => p.type === t).value;
  const offsetMin = (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute")) - now.getTime()) / 60000;
  const midnightUtc = Date.UTC(get("year"), get("month") - 1, get("day")) - offsetMin * 60000;
  return new Date(midnightUtc + minutes * 60000);
}

// "The sky over San Francisco at 6:42 PM"
export function caption(date) {
  const t = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: SF.tz });
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
