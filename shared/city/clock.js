// The city clock: absolute time T (UTC seconds) -> San Francisco's local time, day type, sun, wind and fog.
// Every event in events/*.js is a pure function of T and of what this file derives from it.
import { sunPosition } from "../sky.js";
import { WIND_FORT_POINT } from "./tables.js";
import { clamp, lerp } from "./geo.js";

export const TZ = "America/Los_Angeles";

// UTC offset of SF local time (s), cached per UTC hour: DST changes at 02:00 local, which is always on a UTC hour.
const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
});
const offsets = new Map();
export function utcOffset(T) {
  const k = Math.floor(T / 3600);
  let o = offsets.get(k);
  if (o === undefined) {
    const p = {};
    for (const x of fmt.formatToParts(new Date(k * 3600000))) p[x.type] = x.value;
    o = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000 - k * 3600;
    if (offsets.size > 4096) offsets.clear();
    offsets.set(k, o);
  }
  return o;
}

// ---------------------------------------------------------------- holidays
// A small US list for traffic and timetables (holidays use the weekend tables): the federal holidays on which most
// commuters stay home, observed on the nearest weekday, plus the day after Thanksgiving. Columbus/Indigenous Peoples'
// Day, Veterans Day and Juneteenth are left out: bridge commute traffic stays near normal on them (est.).
const nth = (y, m, wd, n) => {   // n-th weekday (0 = Sun) of month m (1-12); n = -1: the last one
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return 1 + ((wd - first + 7) % 7) + 7 * (n - 1);
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = new Date(Date.UTC(y, m - 1, lastDay)).getUTCDay();
  return lastDay - ((last - wd + 7) % 7);
};
const observed = (y, m, d) => {
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const t = Date.UTC(y, m - 1, d) + (wd === 6 ? -86400000 : wd === 0 ? 86400000 : 0);
  const o = new Date(t);
  return [o.getUTCFullYear(), o.getUTCMonth() + 1, o.getUTCDate()];
};
// The named holidays of year y as yyyymmdd keys (the actual day, or the observed one where marked)
export function holidayDates(y) {
  const k = ([a, b, c]) => a * 10000 + b * 100 + c;
  const tg = nth(y, 11, 4, 4);
  return {
    newYear: k([y, 1, 1]), newYearObserved: k(observed(y, 1, 1)), mlk: k([y, 1, nth(y, 1, 1, 3)]),
    presidents: k([y, 2, nth(y, 2, 1, 3)]), memorial: k([y, 5, nth(y, 5, 1, -1)]), independence: k(observed(y, 7, 4)),
    labor: k([y, 9, nth(y, 9, 1, 1)]), thanksgiving: k([y, 11, tg]), thanksgivingFriday: k([y, 11, tg + 1]),
    christmas: k([y, 12, 25]), christmasObserved: k(observed(y, 12, 25)),
  };
}
const holidayCache = new Map();
export function holidays(y) {
  let s = holidayCache.get(y);
  if (s) return s;
  const list = [
    observed(y, 1, 1), [y, 1, nth(y, 1, 1, 3)], [y, 2, nth(y, 2, 1, 3)], [y, 5, nth(y, 5, 1, -1)], observed(y, 7, 4),
    [y, 9, nth(y, 9, 1, 1)], [y, 11, nth(y, 11, 4, 4)], [y, 11, nth(y, 11, 4, 4) + 1], observed(y, 12, 25),
  ];
  s = new Set(list.map(([a, b, c]) => a * 10000 + b * 100 + c));
  holidayCache.set(y, s);
  return s;
}

// ---------------------------------------------------------------- local time
const days = new Map();
function dayInfo(day) {
  let d = days.get(day);
  if (d) return d;
  const dt = new Date(day * 86400000);
  const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, dd = dt.getUTCDate(), wd = dt.getUTCDay();
  const key = y * 10000 + mo * 100 + dd;
  const holiday = holidays(y).has(key) || holidays(y + 1).has(key);   // New Year's observed on Dec 31
  const doy = (Date.UTC(y, mo - 1, dd) - Date.UTC(y, 0, 1)) / 86400000;
  d = { day, y, mo, d: dd, wd, key, mmdd: mo * 100 + dd, doy, holiday,
    weekend: wd === 0 || wd === 6 || holiday,
    dayType: holiday || wd === 0 ? "sunday" : wd === 6 ? "saturday" : "weekday" };
  if (days.size > 2048) days.clear();
  days.set(day, d);
  return d;
}

// SF local time at T: day number (days since 1970-01-01 in local time), seconds into the local day, calendar fields.
// (DYS-149 mt-diet: the last MEMO answers kept by T: a frame's city asked for the same T ~15 times (the windows, the
// bridge's cable, the aircraft, the gulls, the sails' wind, the sound), each a new object of 17 fields (0.2 ms a moving
// frame at 1x, and its garbage). The same object for the same T: every caller only reads it (clockAt spreads it into
// its own, which city.js writes its fog on). ?mtdiet=0 on the page: a new object at every call, as before)
const MEMO = 4;
const MT_DIET = typeof location === "undefined" || new URLSearchParams(location.search || "").get("mtdiet") !== "0";
const memoT = new Float64Array(MEMO).fill(NaN), memoV = new Array(MEMO).fill(null);
let memoAt = 0;
export function sfTime(T) {
  if (MT_DIET) for (let i = 0; i < MEMO; i++) if (memoT[i] === T) return memoV[i];
  const off = utcOffset(T);
  const L = T + off;
  const day = Math.floor(L / 86400);
  const sec = L - day * 86400;
  const t = { T, offset: off, sec, hour: sec / 3600, ...dayInfo(day) };
  if (MT_DIET) { memoT[memoAt] = T; memoV[memoAt] = t; memoAt = (memoAt + 1) % MEMO; }
  return t;
}
export const sfDay = dayInfo;

// T of local wall-clock time on local day `day` (seconds after local midnight). Exact across DST changes.
export function sfToT(day, sec) {
  let T = day * 86400 + sec - utcOffset(day * 86400 + sec + 8 * 3600);
  T = day * 86400 + sec - utcOffset(T);
  return T;
}
export function dayFromDate(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / 86400000); }

// ---------------------------------------------------------------- sun
export const sun = (T) => sunPosition(T * 1000);

// The time the sun crosses `alt` on local day `day`: rising (am) or setting (pm). Cached; bisection on sky.js.
const crossings = new Map();
export function sunCross(day, alt, setting) {
  const k = `${day}:${alt}:${setting ? 1 : 0}`;
  let v = crossings.get(k);
  if (v !== undefined) return v;
  const noon = sfToT(day, 13 * 3600);   // solar noon in SF is near 13:10 PDT / 12:10 PST
  let a = setting ? noon : noon - 13 * 3600, b = setting ? noon + 13 * 3600 : noon;
  const f = (t) => sunPosition(t * 1000).alt - alt;
  let fa = f(a);
  for (let i = 0; i < 40; i++) {
    const m = (a + b) / 2, fm = f(m);
    if ((fa < 0) === (fm < 0)) { a = m; fa = fm; } else b = m;
  }
  v = Math.round((a + b) / 2);
  if (crossings.size > 4096) crossings.clear();
  crossings.set(k, v);
  return v;
}
export const sunset = (day) => sunCross(day, -0.833, true);
export const sunrise = (day) => sunCross(day, -0.833, false);

// ---------------------------------------------------------------- wind
// Fort Point (FTPC1) hourly means, interpolated by day of year between the seasonal blocks and by hour.
export function wind(t) {
  const B = WIND_FORT_POINT.blocks;
  const doy = t.doy + t.hour / 24;
  let i = B.length - 1;
  for (let k = 0; k < B.length; k++) if (B[k][0] <= doy) i = k;
  const j = (i + 1) % B.length;
  const d0 = B[i][0], d1 = j === 0 ? B[0][0] + 365 : B[j][0];
  const w = clamp((doy - d0) / (d1 - d0), 0, 1);
  const hourly = (row) => {
    const h = t.hour - 0.5, h0 = Math.floor(h), u = h - h0;
    return lerp(row[(h0 + 24) % 24], row[(h0 + 25) % 24], u);
  };
  const fp = lerp(hourly(B[i][1]), hourly(B[j][1]), w);
  return { fortPoint: fp, open: fp * WIND_FORT_POINT.open, from: WIND_FORT_POINT.from };
}

// ---------------------------------------------------------------- fog
// Fog is not computed: it is the shown moment's fog over the deck, blended between the two moments (frames.json).
export function fogFromFrames(sel) {
  if (!sel) return 0;
  return lerp(sel.a.fog || 0, sel.b.fog || 0, sel.t);
}

// Everything the events need about one instant.
export function clockAt(T, fog = 0) {
  const t = sfTime(T);
  const s = sun(T);
  return { ...t, sun: s, wind: wind(t), fog };
}

// ---------------------------------------------------------------- the page's clock
// Real time by default. ?time=HH:MM (or a time picked on the dial, through sky.js's override) sets the clock to that
// SF time today and runs forward from it; ?date=YYYY-MM-DD (dev) picks the day. set(minutes) re-anchors (the dial).
export function createClock({ search = "", now = () => Date.now(), override = null } = {}) {
  const q = new URLSearchParams(search);
  let anchorReal = now(), anchorT = null;
  const dateQ = q.get("date");
  function today() {
    if (dateQ) {
      const [y, m, d] = dateQ.split("-").map(Number);
      if (y && m && d) return dayFromDate(y, m, d);
    }
    return sfTime(now() / 1000).day;
  }
  function set(minutes) {
    anchorReal = now();
    anchorT = minutes === null || minutes === undefined ? (dateQ ? sfToT(today(), sfTime(now() / 1000).sec) : null)
      : sfToT(today(), minutes * 60);
  }
  const tq = q.get("time");
  let start = null;
  if (tq) {
    const [h, m] = tq.split(":").map(Number);
    if (!Number.isNaN(h)) start = h * 60 + (m || 0);
  }
  if (start === null && override !== null && override !== undefined) start = override;
  set(start);
  return {
    T: () => (anchorT === null ? now() / 1000 : anchorT + (now() - anchorReal) / 1000),
    set,
    get live() { return anchorT === null; },
  };
}
