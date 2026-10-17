// The framed print on the desk. Every render leaves its paper blank; the current quote is typeset onto it
// in perspective, multiplied into the paper so it takes the room's light. The homepage (app.js) and the
// Quotes page both use this.
//
// One quote a day (spec v2, 15 Oct): at rest the print shows the day's quote, the same for everyone that day. It is
// picked by the San Francisco date and steps through every quote on /quotes.html, 7 places a day (so two quotes
// by one author are not on consecutive days), all of them once every 19 days. Leaned in, the Quotes page's arrows
// step through the rest; leaning back returns the print to the day's quote.
//
//   const print = mountPrint(container);           // container: an element in the room's coordinate space
//   print.place(P, w, h);                          // P = the paper's corners [tl, tr, br, bl] in container px
//   print.set(await dailyQuote());                 // { n, html, by } (html: the quote's <p>s, by: its credit)
//   dayIndex(count)                                // the day's place in a list of `count` quotes (0-based)
import { homography } from "./room.js";

const KEY = "sky-print-day";
// Quote 1 on /quotes.html, when the list can't be had (offline, a failed fetch)
export const FIRST_QUOTE = {
  n: 1,
  html: "<p>Attention shapes the self, and is in turn shaped by it.</p>",
  by: "Mihaly Csikszentmihalyi, <em>Flow</em>",
};

// The San Francisco calendar date as a day number (days since 1 January 1970), whatever the visitor's own time zone.
export function sfDay(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (t) => +p.find((x) => x.type === t).value;
  return Math.floor(Date.UTC(get("year"), get("month") - 1, get("day")) / 86400000);
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
// the day's place in a list of `count`: a stride coprime with the count visits every quote once per `count` days
export function dayIndex(count, date = new Date()) {
  if (!count) return 0;
  const stride = [7, 5, 3, 2, 1].find((k) => k < count && gcd(k, count) === 1) || 1;
  return (((sfDay(date) * stride) % count) + count) % count;
}

let memo = null;   // { day, q }
const quoteOf = (li, i) => {
  const by = li.querySelector(".by");
  return { n: i + 1, html: li.querySelector(".q").innerHTML, by: by ? by.innerHTML : "" };
};
// The quotes on a Quotes page document (or the parsed /quotes.html), in their order.
export function quotesIn(root) { return [...root.querySelectorAll(".quote")].filter((li) => li.querySelector(".q")).map(quoteOf); }

// The day's quote now, if it is known without a fetch (this page already asked, or this browser did today), else null.
export function currentQuote() {
  const day = sfDay();
  if (memo && memo.day === day) return memo.q;
  try {
    const c = JSON.parse(localStorage.getItem(KEY) || "null");
    if (c && c.day === day && c.q && typeof c.q.html === "string") { memo = c; return c.q; }
  } catch { /* storage blocked or bad data */ }
  return null;
}
// The day's quote, from /quotes.html (fetched once a day; the first quote if it can't be had).
export async function dailyQuote() {
  const known = currentQuote();
  if (known) return known;
  const day = sfDay();
  try {
    const r = await fetch("/quotes.html");
    if (!r.ok) throw new Error(r.status);
    const list = quotesIn(new DOMParser().parseFromString(await r.text(), "text/html"));
    if (!list.length) throw new Error("no quotes");
    memo = { day, q: list[dayIndex(list.length)] };
    try { localStorage.setItem(KEY, JSON.stringify(memo)); } catch { /* fine */ }
    return memo.q;
  } catch {
    return FIRST_QUOTE;
  }
}

const CSS = `
@font-face { font-family: "Cormorant Garamond"; src: url("/fonts/cormorant-garamond-italic-latin.woff2") format("woff2"); font-weight: 300 600; font-style: italic; font-display: swap; }
.sky-print { position: absolute; left: 0; top: 0; transform-origin: 0 0; visibility: hidden; pointer-events: none; }
.sky-print.is-set { visibility: visible; }
.sky-print-text {
  position: absolute; inset: 0; box-sizing: border-box;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 9% 11%; color: #30281f; mix-blend-mode: multiply; text-align: center;
  font-family: "Cormorant Garamond", "Cormorant", Garamond, "Times New Roman", serif;
  transition: opacity 0.22s ease; -webkit-font-smoothing: antialiased;
}
.sky-print-text.is-out { opacity: 0; }
.sky-print-text blockquote { margin: 0; font-style: italic; font-weight: 400; line-height: 1.32; letter-spacing: 0.002em; text-wrap: pretty; }
.sky-print-text blockquote p { margin: 0; }
.sky-print-text blockquote p + p { margin-top: 0.7em; }
.sky-print-text .rule { width: 1.6em; height: 0; margin: 1.05em auto 0.85em; border-top: 0.04em solid currentColor; opacity: 0.55; }
.sky-print-text .rule[hidden], .sky-print-text cite[hidden] { display: none; }
.sky-print-text cite { font-style: normal; font-size: 0.56em; letter-spacing: 0.08em; opacity: 0.86; font-family: inherit; }
.sky-print-text cite em { font-style: italic; letter-spacing: 0.02em; }
@media (prefers-reduced-motion: reduce) { .sky-print-text { transition: none; } }
`;
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  const s = document.createElement("style");
  s.textContent = CSS;
  document.head.append(s);
}

export function mountPrint(container) {
  style();
  const el = document.createElement("div");
  el.className = "sky-print";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = '<div class="sky-print-text"><blockquote></blockquote><div class="rule"></div><cite></cite></div>';
  container.append(el);
  const text = el.firstChild, qEl = text.children[0], ruleEl = text.children[1], byEl = text.children[2];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let size = null, shown = null, timer = 0;

  // The largest type that fits the paper's middle, shrinking for long quotes.
  function fit() {
    if (!size || !qEl.textContent) return;
    const avail = size.h * 0.82, wAvail = size.w * 0.78;
    const small = size.h < 400;
    let fs = Math.min(size.h * (small ? 0.066 : 0.056), size.w * (small ? 0.09 : 0.076));
    const min = Math.max(2, size.h * 0.018);
    const content = () => qEl.offsetHeight + (byEl.hidden ? 0 : ruleEl.offsetHeight + byEl.offsetHeight + parseFloat(getComputedStyle(ruleEl).marginTop) * 2);
    text.style.fontSize = `${fs}px`;
    let guard = 40;
    while (guard-- > 0 && fs > min && (text.scrollHeight > size.h + 1 || content() > avail || qEl.scrollWidth > wAvail + 1)) {
      fs *= 0.93;
      text.style.fontSize = `${fs}px`;
    }
  }

  function apply(q) {
    qEl.innerHTML = q.html;
    byEl.innerHTML = q.by || "";
    byEl.hidden = !q.by;
    ruleEl.hidden = !q.by;
    fit();
  }

  if (document.fonts) document.fonts.ready.then(fit);

  return {
    el,
    // the paper's corners in the container's pixels, and its size along its own edges
    place(P, w, h) {
      size = { w, h };
      Object.assign(el.style, { width: `${w}px`, height: `${h}px`, transform: homography(w, h, P) });
      fit();
      el.classList.add("is-set");
    },
    set(q, { animate = true } = {}) {
      if (shown && shown.n === q.n && shown.html === q.html) return;
      const had = !!shown;
      shown = q;
      clearTimeout(timer);
      if (animate && had && !reduced.matches) {
        text.classList.add("is-out");
        timer = setTimeout(() => { apply(q); text.classList.remove("is-out"); }, 220);
      } else apply(q);
    },
    fit,
    hide(on) { el.style.visibility = on ? "hidden" : ""; },
  };
}
