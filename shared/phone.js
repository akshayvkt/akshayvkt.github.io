// The phone on the desk: how to reach Akshay (docs/v3/EXPERIENCE-SPEC.md v2; interactions B).
//
//   import { phoneQuad, phonePose, PhoneScreen } from "/shared/phone.js";
//   const quad = phoneQuad(engine);                       // the 3D screen's corners (room m): TL, TR, BR, BL as you read it
//   phonePose(quad, w, h, { top, bottom })                // the phone spot's rest pose: square on, the screen large
//   const ph = new PhoneScreen({ parent, quad, reader, timeOf, onEssay });
//   ph.layout(pose, w, h); ph.place(pose, w, h, { still }); ph.wake(); ph.sleep(); ph.setActive(on)
//
// Lying face up, its screen dark (the 3D's black glass). A click leans in and wakes it: the lock screen is real DOM on
// the screen's quad (shared/surface.js, the laptop's way), a real phone's lock screen (live room 2: the Dynamic Island,
// the status bar's icons, a flashlight that switches the desk lamp), his photograph as the wallpaper (web/shared/phone/, made by
// scripts/content/phone_wallpaper.py: no metadata), softly darkened under the clock and the icons, the time in San Francisco (numerals
// only) and a row of icons: X, LinkedIn, GitHub, Email, Substack. Each opens his link, taken from the site's own markup
// (the masthead's icons and Email, the bio's Substack link), with the site's own marks (Substack's is the reading
// sheet's; Email has no mark on the site, so a plain envelope). Icons only, with accessible names. When his newest essay
// is under 30 days old, a notification shows its title (his words) and opens it in the reading sheet. Leaving the spot
// dims the screen off. The screen's corners come from the live model's part_phone_screen (TEXCOORD_0 across the
// screen; glTF's v runs down the phone).
import { fitPose, Surface } from "./surface.js";
import { project } from "./rig.js";

const FRESH_DAYS = 30;
const MARKS = {
  substack: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z"/></svg>',
  email: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M3 5.5h18v13H3z"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M3.6 6.2 12 12.6l8.4-6.4"/></svg>',
  // live room 2 (Akshay, 16 Oct): a real phone's lock screen. Drawn here (not Apple's artwork): the status bar's signal
  // bars, Wi-Fi and battery, and the flashlight's torch
  status: '<svg viewBox="0 0 66 12" aria-hidden="true">'
    + '<rect x="0" y="8" width="3" height="4" rx="0.8"/><rect x="4.6" y="5.6" width="3" height="6.4" rx="0.8"/><rect x="9.2" y="3.2" width="3" height="8.8" rx="0.8"/><rect x="13.8" y="0.6" width="3" height="11.4" rx="0.8"/>'
    + '<path d="M29 11.6 26.6 9.1a3.4 3.4 0 0 1 4.8 0z"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M24.4 6.9a6.5 6.5 0 0 1 9.2 0M22.2 4.6a9.6 9.6 0 0 1 13.6 0"/>'
    + '<rect x="40.6" y="0.9" width="21.6" height="10.2" rx="3.2" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1"/><rect x="42.4" y="2.7" width="14.8" height="6.6" rx="1.8"/>'
    + '<path d="M63.6 4.2c1 .3 1.6 1 1.6 1.8s-.6 1.5-1.6 1.8z" fill-opacity="0.5"/></svg>',
  torch: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.6 2.6h8.8c.6 0 1 .4 1 1v1.3c0 .5-.2 1-.5 1.4L14.6 9v11.1c0 .9-.7 1.6-1.6 1.6h-2c-.9 0-1.6-.7-1.6-1.6V9L7.1 6.3c-.3-.4-.5-.9-.5-1.4V3.6c0-.6.4-1 1-1z"/><rect x="11.1" y="11.2" width="1.8" height="3.6" rx="0.9" class="ph-sw"/></svg>',
};
// what the site says today (index.html), used only if the page has no masthead to read them from
const FALLBACK = {
  X: "https://x.com/akshayvkt", LinkedIn: "https://www.linkedin.com/in/akshaych98/", GitHub: "https://github.com/akshayvkt",
  Email: "mailto:venkatakshay98@gmail.com", Substack: "https://akshaychintalapati.substack.com/",
};

// The screen's corners from the mesh: P(u, v) fitted over its vertices (it is flat), then the corners as you read it.
export function phoneQuad(engine) {
  const T = engine.THREE, o = engine.room?.scene.getObjectByName("part_phone_screen");
  if (!o) return null;
  let mesh = null; o.traverse((m) => { if (m.isMesh && !mesh) mesh = m; });
  const g = mesh?.geometry, pos = g?.attributes.position, uv = g?.attributes.uv;
  if (!pos || !uv) return null;
  mesh.updateWorldMatrix(true, false);
  const v = new T.Vector3(), M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const r = [1, uv.getX(i), uv.getY(i)], p = [v.x, v.y, v.z];
    for (let a = 0; a < 3; a++) { for (let c = 0; c < 3; c++) M[a][c] += r[a] * r[c]; for (let k = 0; k < 3; k++) B[k][a] += r[a] * p[k]; }
  }
  const inv = new T.Matrix3().set(...M.flat()).invert();
  const C = [0, 1, 2].map((k) => new T.Vector3(...B[k]).applyMatrix3(inv).toArray());   // per axis: [o, du, dv]
  // the screen is a rectangle: square the fitted axes (the model's quantized positions leave them 0.06 deg apart)
  const A = [C[0][1], C[1][1], C[2][1]], Bv = [C[0][2], C[1][2], C[2][2]];
  const k = (A[0] * Bv[0] + A[1] * Bv[1] + A[2] * Bv[2]) / (A[0] * A[0] + A[1] * A[1] + A[2] * A[2]);
  const Bo = Bv.map((x, i) => x - k * A[i]), O = [0, 1, 2].map((i) => C[i][0] + C[i][1] * 0.5 + C[i][2] * 0.5);
  const at = (u, w) => [0, 1, 2].map((i) => O[i] + A[i] * (u - 0.5) + Bo[i] * (w - 0.5));
  // glTF's v runs down the phone (Blender's v was up it): the top edge is v = 0
  let q = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
  // as seen from the screen's front (above), top-left must lie left of top-right: if not, it is mirrored
  const right = q[1].map((x, i) => x - q[0][i]), down = q[3].map((x, i) => x - q[0][i]);
  const out = [down[1] * right[2] - down[2] * right[1], down[2] * right[0] - down[0] * right[2], down[0] * right[1] - down[1] * right[0]];
  if (out[1] < 0) q = [q[1], q[0], q[3], q[2]];
  return q;
}

export function screenNormal(q) {
  const right = q[1].map((x, i) => x - q[0][i]), down = q[3].map((x, i) => x - q[0][i]);
  const n = [down[1] * right[2] - down[2] * right[1], down[2] * right[0] - down[0] * right[2], down[0] * right[1] - down[1] * right[0]];
  const l = Math.hypot(...n) || 1;
  return n.map((x) => x / l);
}

// The phone spot's rest pose: the eye on the screen's normal (square on, so the lock screen is drawn 1:1, sharp), the
// screen about three quarters of the free height on wide screens and nearly all the width on phones.
export function phonePose(quad, w, h, { top = 56, bottom = 104 } = {}) {
  if (!quad) return null;
  const n = screenNormal(quad), a = w / h;
  let tanV = 18 / 35 / (16 / 9);
  if (a < 1) tanV = Math.max(tanV, 0.3 / a);
  const portrait = a < 1;
  const pose = fitPose({ points: quad, forward: n.map((x) => -x), tanV, w, h, top, bottom, fill: portrait ? 0.84 : 0.9, fillH: portrait ? 0.9 : 0.78 });
  // looking almost straight down, the yaw turns the picture: level the screen's top edge exactly (a lock screen drawn
  // at whole pixels is sharp), keeping the eye where it is
  for (let i = 0; i < 3; i++) {
    const a = project(pose, quad[0], w, h), b = project(pose, quad[1], w, h);
    if (!a || !b) break;
    pose.yaw += (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  }
  return pose;
}

const CSS = `
.sfw-phone { position: absolute; left: 0; top: 0; z-index: 1; transform-origin: 0 0; visibility: hidden; opacity: 0; pointer-events: none;
  overflow: hidden; border-radius: 12.7% / 5.95%; color: #fff; font-family: "Geist", -apple-system, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; contain: layout style; background-color: #0b0e13;
  /* his photograph (One World Trade Center, looking up), softly darkened where the clock and the icons sit */
  background-image: linear-gradient(180deg, rgba(5, 8, 13, 0.56) 0%, rgba(5, 8, 13, 0.34) 24%, rgba(5, 8, 13, 0.12) 46%, rgba(5, 8, 13, 0.14) 60%, rgba(5, 8, 13, 0.44) 74%, rgba(5, 8, 13, 0.62) 100%),
    url("/shared/phone/wallpaper.webp");
  background-image: linear-gradient(180deg, rgba(5, 8, 13, 0.56) 0%, rgba(5, 8, 13, 0.34) 24%, rgba(5, 8, 13, 0.12) 46%, rgba(5, 8, 13, 0.14) 60%, rgba(5, 8, 13, 0.44) 74%, rgba(5, 8, 13, 0.62) 100%),
    image-set(url("/shared/phone/wallpaper.avif") type("image/avif"), url("/shared/phone/wallpaper.webp") type("image/webp"));
  background-size: cover; background-position: center; background-repeat: no-repeat; }
.sfw-phone.is-on a, .sfw-phone.is-on button { pointer-events: auto; cursor: pointer; }
.sfw-phone .ph-time { position: absolute; top: 12.5%; left: 0; right: 0; text-align: center; font-size: 4.5em; font-weight: 400; line-height: 1;
  letter-spacing: -0.035em; color: rgba(255, 255, 255, 0.95); font-variant-numeric: tabular-nums lining-nums; text-shadow: 0 0.02em 0.25em rgba(0, 0, 0, 0.28); }
.sfw-phone .ph-note { position: absolute; top: 31%; left: 5.5%; right: 5.5%; display: flex; align-items: center; gap: 0.6em; box-sizing: border-box;
  padding: 0.7em 0.75em; border: 0; border-radius: 1.05em; background: rgba(22, 26, 33, 0.58); box-shadow: inset 0 0 0 0.04em rgba(255, 255, 255, 0.14); color: rgba(255, 255, 255, 0.96);
  font: 500 0.78em/1.28 "Geist", -apple-system, system-ui, sans-serif; text-align: left; -webkit-tap-highlight-color: transparent; outline: none; }
.sfw-phone .ph-note[hidden] { display: none; }
.sfw-phone .ph-note .ph-mark { flex: 0 0 2.3em; height: 2.3em; border-radius: 0.6em; background: #ff6719; display: grid; place-items: center; }
.sfw-phone .ph-note .ph-mark svg { width: 48%; height: 48%; fill: #fff; }
.sfw-phone .ph-note .ph-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sfw-phone .ph-apps { position: absolute; left: 6.5%; right: 6.5%; bottom: 17.5%; display: flex; justify-content: space-between; }
/* the top: the Dynamic Island, and the status bar's icons on the right (an iPhone's proportions, in the screen's em) */
.sfw-phone .ph-island { position: absolute; top: 0.46em; left: 50%; width: 5.1em; height: 1.5em; margin-left: -2.55em; border-radius: 1em; background: #000;
  box-shadow: 0 0 0 0.03em rgba(255, 255, 255, 0.05); }
.sfw-phone .ph-status { position: absolute; top: 0.95em; right: 1.05em; width: 2.75em; height: 0.5em; color: rgba(255, 255, 255, 0.96); }
.sfw-phone .ph-status svg { display: block; width: 100%; height: 100%; fill: currentColor; overflow: visible; }
/* the bottom left: the flashlight, a frosted round button; on, a white disc with a dark torch (as a phone shows it) */
.sfw-phone .ph-torch { position: absolute; left: 9.5%; bottom: 4.6%; width: 2.1em; height: 2.1em; padding: 0; border: 0; border-radius: 50%;
  display: grid; place-items: center; color: #fff; background: rgba(20, 24, 30, 0.46); box-shadow: inset 0 0 0 0.04em rgba(255, 255, 255, 0.16);
  outline: none; -webkit-tap-highlight-color: transparent; transition: background-color 0.28s ease, color 0.28s ease, transform 0.18s ease; }
.sfw-phone .ph-torch svg { width: 46%; height: 46%; fill: currentColor; }
.sfw-phone .ph-torch .ph-sw { fill: rgba(20, 24, 30, 0.8); transition: fill 0.28s ease; }
.sfw-phone .ph-torch[aria-pressed="true"] { background: rgba(255, 255, 255, 0.94); color: #15181d; }
.sfw-phone .ph-torch[aria-pressed="true"] .ph-sw { fill: #ffffff; }
.sfw-phone .ph-torch:hover, .sfw-phone .ph-torch:focus-visible { transform: scale(1.06); }
.sfw-phone .ph-torch:active { transform: scale(0.94); }
.sfw-phone .ph-torch[hidden] { display: none; }
.sfw-phone .ph-app { width: 2.45em; height: 2.45em; border-radius: 0.7em; background: rgba(20, 24, 30, 0.42); box-shadow: inset 0 0 0 0.04em rgba(255, 255, 255, 0.16); display: grid; place-items: center;
  color: #fff; outline: none; -webkit-tap-highlight-color: transparent; transition: background-color 0.2s ease; }
.sfw-phone .ph-app:hover, .sfw-phone .ph-app:focus-visible { background: rgba(60, 66, 76, 0.55); }
.sfw-phone .ph-note:focus-visible { background: rgba(48, 54, 64, 0.66); }
.sfw-phone .ph-app svg { width: 46%; height: 46%; fill: currentColor; }
.sfw-phone .ph-bar { position: absolute; left: 34%; right: 34%; bottom: 1.9%; height: 0.17em; border-radius: 1em; background: rgba(255, 255, 255, 0.55); }
`;

const TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", hour12: true });

export class PhoneScreen {
  constructor({ parent, quad, reader, timeOf = () => new Date(), onEssay = null, reduced = () => false, label = "", torch = null }) {
    this.reader = reader;
    this.torchOf = torch;   // { on(): bool, toggle() }: the room's lamp (router.js), or null (no button)
    this.timeOf = timeOf;
    this.onEssay = onEssay;
    this.reduced = reduced;
    if (!document.querySelector("style[data-sfw-phone]")) {
      const s = document.createElement("style");
      s.setAttribute("data-sfw-phone", "");
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    const el = (this.el = document.createElement("div"));
    el.className = "sfw-phone";
    el.setAttribute("role", "group");
    if (label) el.setAttribute("aria-label", label);
    el.inert = true;
    this.time = document.createElement("div");
    this.time.className = "ph-time";
    this.time.setAttribute("aria-hidden", "true");   // (numerals only, no words: a clock face, not a sentence)
    this.note = document.createElement("button");
    this.note.type = "button";
    this.note.className = "ph-note";
    this.note.hidden = true;
    this.note.innerHTML = `<span class="ph-mark">${MARKS.substack}</span><span class="ph-title"></span>`;
    this.note.addEventListener("click", (e) => { e.stopPropagation(); if (this.slug) this.onEssay?.(this.slug, this.note); });
    const apps = document.createElement("div");
    apps.className = "ph-apps";
    for (const [name, href, mark] of this.links()) {
      const a = document.createElement("a");
      a.className = "ph-app";
      a.href = href;
      a.setAttribute("aria-label", name);
      if (!href.startsWith("mailto:")) { a.target = "_blank"; a.rel = "noopener"; }
      a.innerHTML = mark;
      apps.appendChild(a);
    }
    const bar = document.createElement("div");
    bar.className = "ph-bar";
    bar.setAttribute("aria-hidden", "true");
    const island = document.createElement("div");
    island.className = "ph-island";
    island.setAttribute("aria-hidden", "true");
    const status = document.createElement("div");
    status.className = "ph-status";
    status.setAttribute("aria-hidden", "true");
    status.innerHTML = MARKS.status;
    // the flashlight switches the room's lamp (the same switch as a click on the lamp: its light layer and soft fade;
    // the visitor's choice then holds for the visit); its glyph shows whether the lamp is on
    this.torch = document.createElement("button");
    this.torch.type = "button";
    this.torch.className = "ph-torch";
    this.torch.setAttribute("aria-label", "Flashlight");
    this.torch.innerHTML = MARKS.torch;
    this.torch.hidden = !torch;
    this.torch.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this.torchOf) return;
      this.setTorch(!this.torchOf.on());
      this.torchOf.toggle();
    });
    el.append(island, status, this.time, this.note, apps, this.torch, bar);
    parent.appendChild(el);
    this.surface = new Surface(el, quad, { oversample: 1 });
    this.awake = false;
    this.setTorch(!!torch?.on());
    this.tick();
    this.timer = setInterval(() => this.tick(), 15000);
    reader?.index().then((posts) => this.fresh(posts)).catch(() => {});
  }

  // X, LinkedIn, GitHub, Email, Substack: the hrefs and marks the site's markup has (the homepage's Social links,
  // nav#social, since nav-r1 took them out of the masthead's menu; before it, the masthead and the bio)
  links() {
    const m = document.getElementById("social") || document.querySelector(".masthead nav");
    const icon = (label) => m?.querySelector(`a.icon[aria-label="${label}"]`);
    const svg = (a) => (a?.querySelector("svg") ? a.querySelector("svg").outerHTML : "");
    const mail = m?.querySelector('a[href^="mailto:"]')?.getAttribute("href");
    const sub = (m?.querySelector('a[href*="substack.com"]') || document.querySelector('#about a[href*="substack.com"]'))?.getAttribute("href");
    return [
      ["X", icon("X")?.getAttribute("href") || FALLBACK.X, svg(icon("X")) || ""],
      ["LinkedIn", icon("LinkedIn")?.getAttribute("href") || FALLBACK.LinkedIn, svg(icon("LinkedIn")) || ""],
      ["GitHub", icon("GitHub")?.getAttribute("href") || FALLBACK.GitHub, svg(icon("GitHub")) || ""],
      ["Email", mail || FALLBACK.Email, MARKS.email],
      ["Substack", sub || FALLBACK.Substack, MARKS.substack],
    ].filter(([, , mark]) => mark);
  }

  // the newest essay, when it is under 30 days old (window.__sfwNow: a test's date)
  fresh(posts) {
    const p = posts?.[0];
    const now = typeof window.__sfwNow === "number" ? window.__sfwNow : Date.now();
    const age = p ? (now - Date.parse(p.date + "T12:00:00Z")) / 86400000 : Infinity;
    this.slug = p && age >= 0 && age < FRESH_DAYS ? p.slug : null;
    this.note.hidden = !this.slug;
    this.note.querySelector(".ph-title").textContent = this.slug ? p.title : "";
  }

  // the time in San Francisco, the hour and the minutes only
  tick() {
    const parts = TIME.formatToParts(this.timeOf() || new Date());
    const t = `${parts.find((x) => x.type === "hour")?.value}:${parts.find((x) => x.type === "minute")?.value}`;
    if (this.time.textContent !== t) this.time.textContent = t;
  }

  layout(pose, w, h) {
    const [bw] = this.surface.layout(pose, w, h);
    if (bw) this.el.style.fontSize = `${(bw / 16).toFixed(2)}px`;
  }
  place(pose, w, h, opts) { if (this.awake || this.fading) this.surface.place(pose, w, h, opts); }

  // The screen fades up (wakes) and dims off; the DOM is not drawn at all while it is dark.
  wake() {
    if (this.awake) return;
    this.awake = true;
    this.tick();
    if (this.torchOf) this.setTorch(!!this.torchOf.on());
    this.reader?.index().then((posts) => this.fresh(posts)).catch(() => {});
    clearTimeout(this.offT);
    const el = this.el;
    el.style.visibility = "visible";
    el.style.transition = this.reduced() ? "opacity 150ms ease" : "opacity 520ms cubic-bezier(0.22, 0.8, 0.24, 1)";
    void el.offsetWidth;
    el.style.opacity = "1";
  }
  sleep() {
    if (!this.awake) return;
    this.awake = false;
    this.fading = true;
    const el = this.el;
    const ms = this.reduced() ? 150 : 650;
    el.style.transition = `opacity ${ms}ms cubic-bezier(0.45, 0, 0.25, 1)`;
    el.style.opacity = "0";
    clearTimeout(this.offT);
    this.offT = setTimeout(() => { this.fading = false; if (!this.awake) el.style.visibility = "hidden"; }, ms + 40);
  }
  setActive(on) { this.el.inert = !on; this.el.classList.toggle("is-on", on); }
  setTorch(on) { this.torch.setAttribute("aria-pressed", on ? "true" : "false"); }
  first() { return this.el.querySelector(".ph-note:not([hidden]), .ph-app"); }
}
