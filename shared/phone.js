// The phone on the desk: how to reach Akshay (docs/v3/EXPERIENCE-SPEC.md v2; interactions B; phone round 2).
//
//   import { phoneQuad, phonePose, PhoneScreen } from "/shared/phone.js";
//   const quad = phoneQuad(engine);                       // the 3D screen's corners (room m): TL, TR, BR, BL as you read it
//   phonePose(quad, w, h, { top, bottom })                // the phone spot's rest pose: square on, the screen large
//   const ph = new PhoneScreen({ parent, quad, reader, timeOf, onEssay, occluders });
//   ph.layout(pose, w, h); ph.place(pose, w, h, { still });   // every frame, from every spot
//   ph.wake(); ph.unlock(); ph.lock(); ph.sleep(); ph.setActive(on); ph.setShown(on)
//
// A real iPhone 17 Pro's screen (phone round 2, Akshay 17 Oct: "show a locked view at the start (always on display)
// ... then we do the swipe up animation that iphone usually has and then the user is shown the apps"), real DOM on
// the screen's quad (shared/surface.js, the laptop's way), every size in the phone's own points (its screen is
// 402 x 874 pt; Apple's iOS 26 lock screen measured for the island, the status bar, the date, the clock, the buttons
// and the home bar):
//   - always on: from every spot where the screen is in view, the lock screen dimmed as an iPhone's always-on display
//     is (the wallpaper darkened and desaturated, the clock and the date dimmer, the corner buttons off), cut where the
//     room's furniture stands in front of it;
//   - the lock screen (iOS 26): his photograph as the wallpaper (web/shared/phone/, scripts/content/phone_wallpaper.py:
//     no metadata), the status bar ("AT&T"; signal, Wi-Fi, battery), the date line over the clock in the system font,
//     the tower's tip in front of the clock's lower part (the depth effect: the wallpaper again, cut to the tower's
//     outline), the flashlight (the desk lamp's own switch) and the camera, the home bar; his newest essay under 30
//     days old as a notification;
//   - the swipe up: woken by the lean-in, unlocked once it lands (or by a click or an upward drag on it): the lock screen
//     slides up with the home bar, the home screen's icons zoom in (0.45 s; reduced motion: a fade); leaving the spot
//     locks it and dims it to always-on again; a tap or a pull down on the home screen's status bar brings the lock
//     screen back down over it (iOS's cover sheet: the flashlight is there);
//   - the home screen: his five apps on the iOS grid with their names, in their own colours, the marks from Simple Icons
//     13.21.0 (CC0; the same paths as the site's own marks), each his link in a new tab (mail in the mail app); his
//     newest essay under 30 days old as a widget under them, which opens it in the reading sheet.
// New visible words: only the five names, "AT&T" and the date line (the brief's). The screen's corners come from the
// live model's part_phone_screen (TEXCOORD_0 across the screen; glTF's v runs down the phone).
import { fitPose, Surface } from "./surface.js";
import { project } from "./rig.js";

const FRESH_DAYS = 30;
const PT = 402;            // the screen's width in points (iPhone 17 Pro: 402 x 874 pt)
const CARRIER = "AT&T";    // Akshay: "always show the network name too - lets use AT&T there"

// Simple Icons 13.21.0 (CC0 1.0): x, substack, linkedin (its "in" only: the app's mark), github, gmail
const SI = {
  x: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
  substack: "M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z",
  linkedin: "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452z",
  github: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  gmail: "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z",
};
const svg = (d, fill = "currentColor") => `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="${fill}" d="${d}"/></svg>`;
// Gmail's M in its own colours (the 2020 mark): the left leg blue under a dark red corner, the V red, the right leg
// green under a yellow corner; the Simple Icons outline cut into those parts
const GMAIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><clipPath id="sfw-ph-gm"><path d="' + SI.gmail + '"/></clipPath></defs>'
  + '<g clip-path="url(#sfw-ph-gm)"><rect width="5.455" height="11.73" fill="#C5221F"/><rect y="11.73" width="5.455" height="12.27" fill="#4285F4"/>'
  + '<rect x="5.455" width="13.09" height="24" fill="#EA4335"/><rect x="18.545" width="5.455" height="11.73" fill="#FBBC04"/><rect x="18.545" y="11.73" width="5.455" height="12.27" fill="#34A853"/></g></svg>';
// his five apps, in Akshay's order (phone round 2; the coordinator's 12:45 answers: no YouTube): name (the label under
// the icon, and its accessible name), link, icon colours, mark
const APPS = [
  { name: "X", href: "https://x.com/akshayvkt", cls: "x", mark: svg(SI.x) },
  { name: "Substack", href: "https://akshaychintalapati.substack.com/", cls: "substack", mark: svg(SI.substack) },
  { name: "LinkedIn", href: "https://www.linkedin.com/in/akshaych98/", cls: "linkedin", mark: svg(SI.linkedin) },
  { name: "GitHub", href: "https://github.com/akshayvkt", cls: "github", mark: svg(SI.github) },
  { name: "Gmail", href: "mailto:venkatakshay98@gmail.com", cls: "gmail", mark: GMAIL },
];
// the site's own markup for the same addresses (the homepage's Social block, nav#social): where it has one, it wins
const SITE_LABEL = { X: "X", Substack: "Substack", LinkedIn: "LinkedIn", GitHub: "GitHub", Gmail: "Email" };
const MARKS = {
  // live room 2 (Akshay, 16 Oct): drawn here (not Apple's artwork): the status bar's signal bars, Wi-Fi and battery,
  // the flashlight's torch; phone round 2: the camera
  status: '<svg viewBox="0 0 66 12" aria-hidden="true">'
    + '<rect x="0" y="8" width="3" height="4" rx="0.8"/><rect x="4.6" y="5.6" width="3" height="6.4" rx="0.8"/><rect x="9.2" y="3.2" width="3" height="8.8" rx="0.8"/><rect x="13.8" y="0.6" width="3" height="11.4" rx="0.8"/>'
    + '<path d="M29 11.6 26.6 9.1a3.4 3.4 0 0 1 4.8 0z"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M24.4 6.9a6.5 6.5 0 0 1 9.2 0M22.2 4.6a9.6 9.6 0 0 1 13.6 0"/>'
    + '<rect x="40.6" y="0.9" width="21.6" height="10.2" rx="3.2" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1"/><rect x="42.4" y="2.7" width="14.8" height="6.6" rx="1.8"/>'
    + '<path d="M63.6 4.2c1 .3 1.6 1 1.6 1.8s-.6 1.5-1.6 1.8z" fill-opacity="0.5"/></svg>',
  torch: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.6 2.6h8.8c.6 0 1 .4 1 1v1.3c0 .5-.2 1-.5 1.4L14.6 9v11.1c0 .9-.7 1.6-1.6 1.6h-2c-.9 0-1.6-.7-1.6-1.6V9L7.1 6.3c-.3-.4-.5-.9-.5-1.4V3.6c0-.6.4-1 1-1z"/><rect x="11.1" y="11.2" width="1.8" height="3.6" rx="0.9" class="ph-sw"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M9.2 4.6h5.6c.5 0 .9.3 1.1.7l.7 1.5h2.6c1.3 0 2.3 1 2.3 2.3v8.6c0 1.3-1 2.3-2.3 2.3H4.8c-1.3 0-2.3-1-2.3-2.3V9.1c0-1.3 1-2.3 2.3-2.3h2.6l.7-1.5c.2-.4.6-.7 1.1-.7zM12 9.4a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z"/></svg>',
};
// The tower's outline in the wallpaper (its 540 x 1170 px, traced from the photograph's pixels: the tip's flat top
// at y 245-250, the left face's edge to x 0 at y 541, the right's to x 540 at y 489): drawn again over the clock
const WALL = [540, 1170];
const TOWER = [[0, 541], [194, 270], [211, 249], [319, 245], [336, 270], [540, 489], [540, 1170], [0, 1170]];

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

// Every size in the phone's points: --p is one point in CSS px (the screen's width / 402), set by layout().
const P = (n) => `calc(${n} * var(--p, 0.65px))`;
const WALLPAPER = `url("/shared/phone/wallpaper.webp")`;
const WALLSET = `image-set(url("/shared/phone/wallpaper.avif") type("image/avif"), url("/shared/phone/wallpaper.webp") type("image/webp"))`;
// iOS keeps the clock legible on a bright sky with a soft darkening at the top; the foot a little for the buttons
const LOCK_SHADE = "linear-gradient(180deg, rgba(5, 8, 13, 0.52) 0%, rgba(5, 8, 13, 0.44) 18%, rgba(5, 8, 13, 0.26) 30%, rgba(5, 8, 13, 0.08) 44%, rgba(5, 8, 13, 0.06) 64%, rgba(5, 8, 13, 0.26) 84%, rgba(5, 8, 13, 0.5) 100%)";
const HOME_SHADE = "linear-gradient(180deg, rgba(5, 8, 13, 0.42) 0%, rgba(5, 8, 13, 0.3) 14%, rgba(5, 8, 13, 0.2) 40%, rgba(5, 8, 13, 0.24) 100%)";
const EASE = "cubic-bezier(0.22, 0.86, 0.26, 1)";   // iOS's unlock: fast out, a long soft landing
const SYS = `-apple-system, "SF Pro Display", system-ui, "Helvetica Neue", sans-serif`;
const SYS_TEXT = `-apple-system, "SF Pro Text", system-ui, "Helvetica Neue", sans-serif`;

const CSS = `
.sfw-phone { position: absolute; left: 0; top: 0; z-index: 1; transform-origin: 0 0; visibility: hidden; pointer-events: none;
  overflow: hidden; border-radius: 12.7% / 5.95%; color: #fff; font-family: ${SYS}; font-size: ${P(17)};
  -webkit-font-smoothing: antialiased; contain: layout style; background-color: #0b0e13;
  /* the home screen's wallpaper: his photograph (One World Trade Center, looking up) */
  background-image: ${HOME_SHADE}, ${WALLPAPER};
  background-image: ${HOME_SHADE}, ${WALLSET};
  background-size: cover; background-position: center; background-repeat: no-repeat; }
.sfw-phone [hidden] { display: none !important; }
.sfw-phone.is-on a, .sfw-phone.is-on button { pointer-events: auto; cursor: pointer; }
.sfw-phone .ph-lock, .sfw-phone .ph-home, .sfw-phone .ph-wall, .sfw-phone .ph-depth { position: absolute; inset: 0; }
.sfw-phone .ph-lock { z-index: 2; overflow: hidden; background: #0b0e13; will-change: transform; }
.sfw-phone .ph-home { z-index: 1; }
.sfw-phone .ph-wall, .sfw-phone .ph-depth { background-image: ${LOCK_SHADE}, ${WALLPAPER}; background-image: ${LOCK_SHADE}, ${WALLSET};
  background-size: cover; background-position: center; background-repeat: no-repeat; transition: filter 0.65s cubic-bezier(0.45, 0, 0.25, 1); }
.sfw-phone .ph-depth { pointer-events: none; }
/* the status bar (both screens): the left item centred in the left ear, the icons in the right one, level with the island */
.sfw-phone .ph-sb { position: absolute; left: 0; right: 0; top: 0; height: ${P(54)}; }
.sfw-phone .ph-left { position: absolute; left: ${P(72)}; top: ${P(29.7)}; transform: translate(-50%, -50%); font: 600 ${P(17)}/1 ${SYS_TEXT}; letter-spacing: -0.01em; white-space: nowrap; }
.sfw-phone .ph-status { position: absolute; right: ${P(40)}; top: ${P(23.7)}; width: ${P(66)}; height: ${P(12)}; color: #fff; }
.sfw-phone .ph-status svg { display: block; width: 100%; height: 100%; fill: currentColor; overflow: visible; }
.sfw-phone .ph-cc { position: absolute; left: ${P(306)}; top: ${P(44)}; width: ${P(38)}; height: ${P(2.6)}; border-radius: ${P(2)}; background: rgba(255, 255, 255, 0.72); }
.sfw-phone .ph-island { position: absolute; z-index: 3; top: ${P(11)}; left: 50%; width: ${P(126)}; height: ${P(37.33)}; margin-left: ${P(-63)}; border-radius: ${P(18.67)};
  background: #000; box-shadow: 0 0 0 ${P(0.5)} rgba(255, 255, 255, 0.04); }
/* the lock screen: the date line, then the clock (iOS 26's tall clock), the glass white of the system's clock */
.sfw-phone .ph-date, .sfw-phone .ph-time { position: absolute; left: 0; right: 0; text-align: center; color: rgba(240, 245, 252, 0.9); white-space: nowrap;
  transition: opacity 0.65s cubic-bezier(0.45, 0, 0.25, 1), color 0.65s ease; }
.sfw-phone .ph-date { top: ${P(79)}; font: 600 ${P(22)}/1 ${SYS_TEXT}; letter-spacing: 0; text-shadow: 0 ${P(0.5)} ${P(6)} rgba(0, 0, 0, 0.18); }
.sfw-phone .ph-time { top: ${P(90)}; font: 500 ${P(108)}/1 ${SYS}; letter-spacing: -0.02em; font-variant-numeric: proportional-nums lining-nums;
  transform: scaleY(1.5); transform-origin: 50% 0; color: rgba(236, 243, 251, 0.86); text-shadow: none;
  /* iOS 26's glass: brighter at the top of the numerals, the wallpaper's pale blue toward their foot */
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.97) 20%, rgba(232, 240, 250, 0.88) 55%, rgba(212, 225, 242, 0.8) 85%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  filter: drop-shadow(0 ${P(1)} ${P(6)} rgba(0, 0, 0, 0.16)); }
/* the bottom corners: the flashlight (the desk lamp's switch) and the camera, iOS 26's glass discs */
.sfw-phone .ph-torch, .sfw-phone .ph-cam { position: absolute; bottom: ${P(57)}; width: ${P(50)}; height: ${P(50)}; padding: 0; border: 0; border-radius: 50%;
  display: grid; place-items: center; color: #fff; background: rgba(24, 28, 36, 0.42); box-shadow: inset 0 0 0 ${P(0.6)} rgba(255, 255, 255, 0.2), inset 0 ${P(1)} ${P(1)} rgba(255, 255, 255, 0.1);
  outline: none; -webkit-tap-highlight-color: transparent; transition: background-color 0.28s ease, color 0.28s ease, transform 0.18s ease, opacity 0.4s ease; }
.sfw-phone .ph-torch { left: ${P(47)}; }
.sfw-phone .ph-cam { right: ${P(47)}; }
.sfw-phone .ph-torch svg, .sfw-phone .ph-cam svg { width: 44%; height: 44%; fill: currentColor; }
.sfw-phone .ph-torch .ph-sw { fill: rgba(20, 24, 30, 0.8); transition: fill 0.28s ease; }
.sfw-phone .ph-torch[aria-pressed="true"] { background: rgba(255, 255, 255, 0.94); color: #15181d; }
.sfw-phone .ph-torch[aria-pressed="true"] .ph-sw { fill: #ffffff; }
.sfw-phone .ph-torch:hover, .sfw-phone .ph-torch:focus-visible { transform: scale(1.06); }
.sfw-phone .ph-torch:active { transform: scale(0.94); }
.sfw-phone .ph-bar { position: absolute; left: 50%; bottom: ${P(8)}; width: ${P(140)}; height: ${P(5)}; margin-left: ${P(-70)}; border-radius: ${P(3)}; background: rgba(255, 255, 255, 0.92);
  transition: opacity 0.4s ease; }
/* a fresh essay: a notification on the lock screen, a widget on the home screen */
.sfw-phone .ph-lnote { position: absolute; left: ${P(12)}; right: ${P(12)}; bottom: ${P(124)}; display: flex; align-items: center; gap: ${P(11)}; box-sizing: border-box;
  padding: ${P(13)} ${P(14)}; border-radius: ${P(24)}; background: rgba(28, 31, 38, 0.56); box-shadow: inset 0 0 0 ${P(0.6)} rgba(255, 255, 255, 0.14);
  font: 600 ${P(15)}/1.28 ${SYS_TEXT}; text-align: left; transition: opacity 0.65s ease; }
.sfw-phone .ph-mark { flex: 0 0 ${P(38)}; width: ${P(38)}; height: ${P(38)}; border-radius: ${P(9)}; background: #ff6719; display: grid; place-items: center; }
.sfw-phone .ph-mark svg { width: 48%; height: 48%; fill: #fff; }
.sfw-phone .ph-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sfw-phone .ph-note { position: absolute; left: ${P(26)}; right: ${P(26)}; top: ${P(296)}; height: ${P(169)}; box-sizing: border-box; padding: ${P(16)} ${P(17)};
  display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; border: 0; border-radius: ${P(26)}; text-align: left; color: #fff;
  background: rgba(28, 31, 38, 0.5); box-shadow: inset 0 0 0 ${P(0.6)} rgba(255, 255, 255, 0.16); font: 600 ${P(17)}/1.26 ${SYS_TEXT};
  outline: none; -webkit-tap-highlight-color: transparent; transition: background-color 0.2s ease; }
.sfw-phone .ph-note .ph-title { -webkit-line-clamp: 3; }
.sfw-phone .ph-note:hover, .sfw-phone .ph-note:focus-visible { background: rgba(52, 57, 66, 0.6); }
/* the home screen (iOS 26, measured on Apple's own press image): four to a row, 64 pt icons (its rounded square, a
   glass rim) 26 pt from the edges, the first row's top 86 pt down, a row every 105 pt, the name under each */
.sfw-phone .ph-grid { position: absolute; left: ${P(26)}; right: ${P(26)}; top: ${P(86)}; display: grid; grid-template-columns: repeat(4, ${P(64)});
  justify-content: space-between; row-gap: ${P(20)}; transform-origin: 50% 40%; }
.sfw-phone .ph-cell { position: relative; width: ${P(64)}; height: ${P(85)}; }
.sfw-phone .ph-app { position: absolute; left: 0; top: 0; width: ${P(64)}; height: ${P(64)}; border-radius: 23%; display: grid; place-items: center; overflow: hidden;
  box-shadow: inset 0 0 0 ${P(0.7)} rgba(255, 255, 255, 0.16), 0 ${P(1)} ${P(4)} rgba(0, 0, 0, 0.16); outline: none; -webkit-tap-highlight-color: transparent;
  transition: filter 0.15s ease, transform 0.15s ease; }
.sfw-phone .ph-app::after { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.16) 0%, rgba(255, 255, 255, 0) 38%); }
.sfw-phone .ph-app svg { position: relative; display: block; }
/* the real icons (17 Oct, Akshay: "grab and use actual app icons ... normal light mode icons"): the artwork fills the
   tile, iOS's corner rounding clips it; no drawn sheen over it */
.sfw-phone .ph-app .ph-icon { position: absolute; inset: 0; width: 100%; height: 100%; display: block; object-fit: cover; }
.sfw-phone .ph-app:has(.ph-icon) { background: none; }
.sfw-phone .ph-app:has(.ph-icon)::after { display: none; }
.sfw-phone .ph-app:hover, .sfw-phone .ph-app:focus-visible { filter: brightness(1.08); }
.sfw-phone .ph-app:active { transform: scale(0.94); filter: brightness(0.8); }
.sfw-phone .ph-app:focus-visible { box-shadow: 0 0 0 ${P(2.5)} rgba(255, 255, 255, 0.9); }
.sfw-phone .ph-app.x { background: #000; color: #fff; } .sfw-phone .ph-app.x svg { width: 48%; height: 48%; }
.sfw-phone .ph-app.substack { background: #ff6719; color: #fff; } .sfw-phone .ph-app.substack svg { width: 46%; height: 46%; }
.sfw-phone .ph-app.linkedin { background: #0a66c2; color: #fff; } .sfw-phone .ph-app.linkedin svg { width: 56%; height: 56%; transform: translate(2%, 1%); }
.sfw-phone .ph-app.github { background: #000; color: #fff; } .sfw-phone .ph-app.github svg { width: 62%; height: 62%; }
.sfw-phone .ph-app.gmail { background: #fff; box-shadow: inset 0 0 0 ${P(0.7)} rgba(0, 0, 0, 0.06), 0 ${P(1)} ${P(4)} rgba(0, 0, 0, 0.16); } .sfw-phone .ph-app.gmail svg { width: 62%; height: 62%; }
.sfw-phone .ph-name { position: absolute; left: ${P(-12)}; right: ${P(-12)}; top: ${P(69)}; text-align: center; font: 400 ${P(12)}/1.2 ${SYS_TEXT}; letter-spacing: 0.01em;
  color: #fff; white-space: nowrap; pointer-events: none; text-shadow: 0 ${P(0.5)} ${P(2)} rgba(0, 0, 0, 0.3); }
/* at the phone spot: the lock screen takes a click or an upward drag (the unlock), the home screen's status bar a tap
   or a pull down (the lock screen back over it) */
.sfw-phone.is-on.is-locked .ph-lock, .sfw-phone.is-on:not(.is-locked) .ph-home .ph-sb { pointer-events: auto; touch-action: none; }
/* always on: the wallpaper dark and greyed, the clock and the date dimmer, the buttons and the home bar off */
.sfw-phone.is-aod .ph-wall, .sfw-phone.is-aod .ph-depth { filter: brightness(0.3) saturate(0.45); }
.sfw-phone.is-aod .ph-date, .sfw-phone.is-aod .ph-time { opacity: 0.62; color: rgba(225, 232, 242, 0.9); }
.sfw-phone.is-aod .ph-lock .ph-sb { opacity: 0.5; transition: opacity 0.65s ease; }
.sfw-phone .ph-lock .ph-sb { transition: opacity 0.4s ease; }
.sfw-phone.is-aod .ph-torch, .sfw-phone.is-aod .ph-cam, .sfw-phone.is-aod .ph-bar, .sfw-phone.is-aod .ph-cc { opacity: 0; }
.sfw-phone.is-aod .ph-lnote { opacity: 0.55; }
`;

const TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", hour12: true });
const DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric" });
const make = (tag, cls, attrs = {}) => { const e = document.createElement(tag); if (cls) e.className = cls; for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

export class PhoneScreen {
  constructor({ parent, quad, reader, timeOf = () => new Date(), onEssay = null, reduced = () => false, label = "", torch = null, occluders = [] }) {
    this.reader = reader;
    this.torchOf = torch;   // { on(): bool, toggle() }: the room's lamp (router.js), or null (no button)
    this.timeOf = timeOf;
    this.onEssay = onEssay;
    this.reduced = reduced;
    if (!document.querySelector("style[data-sfw-phone]")) {
      const s = make("style", "", { "data-sfw-phone": "" });
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    const el = (this.el = make("div", "sfw-phone is-aod is-locked", { role: "group" }));
    if (label) el.setAttribute("aria-label", label);
    el.inert = true;

    // ---- the home screen (under the lock screen): status bar, the five apps, a fresh essay's widget
    const home = (this.home = make("div", "ph-home"));
    home.hidden = true;
    const hsb = make("div", "ph-sb");
    this.homeTime = make("span", "ph-left", { "aria-hidden": "true" });
    hsb.append(this.homeTime, this.statusIcons());
    this.grid = make("div", "ph-grid");
    for (const app of this.apps()) {
      const cell = make("div", "ph-cell");
      const a = make("a", `ph-app ${app.cls}`, { "aria-label": app.name, href: app.href });
      if (!app.href.startsWith("mailto:")) { a.target = "_blank"; a.rel = "noopener"; }
      // the app's own icon from the App Store (1024 px artwork, 256 px here), clipped to iOS's rounded square by the tile
      const img = make("img", "ph-icon", { src: `/shared/phone/apps/${app.cls}.webp`, alt: "", draggable: "false", decoding: "async" });
      a.appendChild(img);
      const name = make("span", "ph-name", { "aria-hidden": "true" });
      name.textContent = app.name;
      cell.append(a, name);
      this.grid.appendChild(cell);
    }
    this.note = make("button", "ph-note", { type: "button" });
    this.note.hidden = true;
    this.note.innerHTML = `<span class="ph-mark">${svg(SI.substack)}</span><span class="ph-title"></span>`;
    this.note.addEventListener("click", (e) => { e.stopPropagation(); if (this.slug) this.onEssay?.(this.slug, this.note); });
    home.append(hsb, this.grid, this.note);

    // ---- the lock screen
    const lock = (this.lockEl = make("div", "ph-lock"));
    const wall = make("div", "ph-wall", { "aria-hidden": "true" });
    this.date = make("div", "ph-date", { "aria-hidden": "true" });
    this.time = make("div", "ph-time", { "aria-hidden": "true" });   // (numerals only, no words: a clock face, not a sentence)
    this.depth = make("div", "ph-depth", { "aria-hidden": "true" });
    const lsb = make("div", "ph-sb", { "aria-hidden": "true" });
    const carrier = make("span", "ph-left ph-carrier");
    carrier.textContent = CARRIER;
    lsb.append(carrier, this.statusIcons(), make("div", "ph-cc"));
    this.lnote = make("div", "ph-lnote", { "aria-hidden": "true" });
    this.lnote.hidden = true;
    this.lnote.innerHTML = `<span class="ph-mark">${svg(SI.substack)}</span><span class="ph-title"></span>`;
    // the flashlight switches the room's lamp (the same switch as a click on the lamp: its light layer and soft fade;
    // the visitor's choice then holds for the visit); its glyph shows whether the lamp is on
    this.torch = make("button", "ph-torch", { type: "button", "aria-label": "Flashlight" });
    this.torch.innerHTML = MARKS.torch;
    this.torch.hidden = !torch;
    this.torch.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this.torchOf) return;
      this.setTorch(!this.torchOf.on());
      this.torchOf.toggle();
    });
    const cam = make("div", "ph-cam", { "aria-hidden": "true" });
    cam.innerHTML = MARKS.camera;
    const bar = make("div", "ph-bar", { "aria-hidden": "true" });
    lock.append(wall, this.date, this.time, this.depth, lsb, this.lnote, this.torch, cam, bar);

    const island = make("div", "ph-island", { "aria-hidden": "true" });
    el.append(home, lock, island);
    parent.appendChild(el);
    this.surface = new Surface(el, quad, { oversample: 1, occluders });
    this.awake = false;     // woken (the lean-in) or always-on (dimmed)
    this.locked = true;
    this.active = false;
    this.shown = false;
    this.setTorch(!!torch?.on());
    this.gestures();
    this.tick();
    this.timer = setInterval(() => this.tick(), 15000);
    reader?.index().then((posts) => this.fresh(posts)).catch(() => {});
  }

  statusIcons() {
    const s = make("div", "ph-status", { "aria-hidden": "true" });
    s.innerHTML = MARKS.status;
    return s;
  }

  // The five apps. The site's own markup (the homepage's Social block, nav#social) gives their addresses; the list
  // above holds the same ones (the brief's) for a page without it.
  apps() {
    const m = document.getElementById("social");
    return APPS.map((app) => {
      const a = m?.querySelector(`a[aria-label="${SITE_LABEL[app.name]}"]`);
      const href = a?.getAttribute("href");
      return href ? { ...app, href } : app;
    });
  }
  // (the links as [name, href]: the smoke test and the walks read them)
  links() { return [...this.grid.querySelectorAll(".ph-app")].map((a) => [a.getAttribute("aria-label"), a.getAttribute("href")]); }

  // the newest essay, when it is under 30 days old (window.__sfwNow: a test's date)
  fresh(posts) {
    const p = posts?.[0];
    const now = typeof window.__sfwNow === "number" ? window.__sfwNow : Date.now();
    const age = p ? (now - Date.parse(p.date + "T12:00:00Z")) / 86400000 : Infinity;
    this.slug = p && age >= 0 && age < FRESH_DAYS ? p.slug : null;
    for (const n of [this.note, this.lnote]) {
      n.hidden = !this.slug;
      n.querySelector(".ph-title").textContent = this.slug ? p.title : "";
    }
  }

  // the time in San Francisco, the hour and the minutes only; the date line over the lock screen's clock
  tick() {
    const at = this.timeOf() || new Date();
    const parts = TIME.formatToParts(at);
    const t = `${parts.find((x) => x.type === "hour")?.value}:${parts.find((x) => x.type === "minute")?.value}`;
    if (this.time.textContent !== t) this.time.textContent = t;
    if (this.homeTime.textContent !== t) this.homeTime.textContent = t;
    const d = DATE.format(at);
    if (this.date.textContent !== d) this.date.textContent = d;
  }

  // The layout box (the screen's size at the phone spot), its point, and the tower's outline in it (the wallpaper is
  // drawn to cover the box, centred: the outline follows the same scale and crop).
  layout(pose, w, h) {
    const [bw, bh] = this.surface.layout(pose, w, h);
    if (!bw || !bh) return;
    this.el.style.setProperty("--p", `${(bw / PT).toFixed(4)}px`);
    const k = Math.max(bw / WALL[0], bh / WALL[1]), ox = (bw - WALL[0] * k) / 2, oy = (bh - WALL[1] * k) / 2;
    this.depth.style.clipPath = `polygon(${TOWER.map(([x, y]) => `${(ox + x * k).toFixed(1)}px ${(oy + y * k).toFixed(1)}px`).join(", ")})`;
  }

  // Every frame, from every spot: on the screen's quad, cut where furniture stands in front of it. Away from the phone
  // spot it is drawn only while the whole screen is in the frame (cut by the frame's edge, the 3D's glass shows there).
  place(pose, w, h, opts) {
    if (!this.shown) return;
    const ok = this.surface.place(pose, w, h, opts);
    let vis = ok;
    if (ok && !this.active) {
      const S = this.surface.corners(pose, w, h);
      vis = !!S && S.every((p) => p[0] >= -0.5 && p[0] <= w + 0.5 && p[1] >= -0.5 && p[1] <= h + 0.5);
    }
    const v = vis ? "visible" : "hidden";
    if (this.el.style.visibility !== v) this.el.style.visibility = v;
  }
  // shown with the live room (the router: once there is a pose to place it with), never over a lost 3D
  setShown(on) {
    this.shown = on;
    if (!on) this.el.style.visibility = "hidden";
  }

  // Woken (the lean-in): the always-on dimming lifts. Asleep: locked, and dimmed to always-on.
  wake() {
    if (this.awake) return;
    this.awake = true;
    this.tick();
    if (this.torchOf) this.setTorch(!!this.torchOf.on());
    this.reader?.index().then((posts) => this.fresh(posts)).catch(() => {});
    this.el.classList.remove("is-aod");
  }
  sleep() {
    if (!this.awake) return;
    this.awake = false;
    this.lock();
    this.el.classList.add("is-aod");
  }
  setActive(on) {
    this.active = on;
    this.el.inert = !on;
    this.el.classList.toggle("is-on", on);
  }
  setTorch(on) { this.torch.setAttribute("aria-pressed", on ? "true" : "false"); }
  first() { return this.locked ? this.torch : this.el.querySelector(".ph-app, .ph-note:not([hidden])"); }

  // ---------- the unlock and the lock ----------
  // The swipe up: the lock screen slides up from where it is (a drag's share of the height, `from`) with the home bar,
  // and the home screen's icons zoom in from a little larger; reduced motion: the lock screen fades out over it.
  unlock({ from = 0, instant = false } = {}) {
    if (!this.locked) return;
    this.locked = false;
    this.el.classList.remove("is-locked");
    this.home.hidden = false;
    const done = () => { if (!this.locked) { this.lockEl.hidden = true; this.lockEl.style.transform = ""; this.lockEl.style.opacity = ""; } };
    if (instant) { this.stop(); this.grid.style.transform = ""; this.home.style.opacity = ""; done(); return; }
    const ms = this.reduced() ? 200 : 450;
    if (this.reduced()) {
      this.play(this.lockEl, [{ opacity: 1 }, { opacity: 0 }], ms, "ease", done);
      this.play(this.home, [{ opacity: 0 }, { opacity: 1 }], ms, "ease");
      return;
    }
    const y0 = `${(-from * 100).toFixed(2)}%`;
    this.play(this.lockEl, [{ transform: `translateY(${y0})` }, { transform: "translateY(-100%)" }], ms * (1 - from * 0.5), EASE, done);
    this.play(this.grid, [{ transform: "scale(1.16)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], ms, EASE);
    this.play(this.home, [{ opacity: 0.4 }, { opacity: 1 }], ms * 0.6, "ease-out");
  }
  // Locked again: at once under the dimming (leaving the spot), or the lock screen pulled down over the home screen
  // (the status bar's tap or pull, iOS's cover sheet).
  lock({ pull = false, from = 0 } = {}) {
    if (this.locked) return;
    this.locked = true;
    this.el.classList.add("is-locked");
    this.lockEl.hidden = false;
    const done = () => { if (this.locked) this.home.hidden = true; };
    if (!pull) { this.stop(); this.lockEl.style.transform = ""; this.lockEl.style.opacity = ""; done(); return; }
    const ms = this.reduced() ? 200 : 420;
    if (this.reduced()) { this.play(this.lockEl, [{ opacity: 0 }, { opacity: 1 }], ms, "ease", done); return; }
    this.play(this.lockEl, [{ transform: `translateY(${(-100 + from * 100).toFixed(2)}%)` }, { transform: "translateY(0)" }], ms, EASE, done);
  }

  // one animation per element: the last keyframe stays as its style once it ends
  play(el, frames, ms, easing, then) {
    el.getAnimations().forEach((a) => a.cancel());
    const a = el.animate(frames, { duration: Math.max(1, ms), easing, fill: "forwards" });
    a.finished.then(() => {
      const last = frames[frames.length - 1];
      for (const [k, v] of Object.entries(last)) el.style[k] = v;
      a.cancel();
      then?.();
    }).catch(() => {});
  }
  stop() { for (const e of [this.lockEl, this.grid, this.home]) e.getAnimations().forEach((a) => a.cancel()); }

  // A click or an upward drag on the lock screen at the phone spot unlocks it (the drag carries it with the pointer
  // and lets go past a fifth of the height, or quickly); a tap or a pull down on the home screen's status bar brings
  // the lock screen down over it. Their pointers are the phone's, not the room's (no orbit under them).
  gestures() {
    const track = (host, dir, end) => {
      let p = null;
      host.addEventListener("pointerdown", (e) => {
        if (!this.active || (e.pointerType === "mouse" && e.button !== 0) || e.target.closest("a, button")) return;
        if (dir < 0 ? !this.locked : this.locked) return;
        e.stopPropagation();
        p = { id: e.pointerId, y0: e.clientY, t0: performance.now(), f: 0, h: this.el.getBoundingClientRect().height || 1 };
        try { host.setPointerCapture(e.pointerId); } catch { /* fine */ }
      });
      host.addEventListener("pointermove", (e) => {
        if (!p || e.pointerId !== p.id) return;
        e.stopPropagation();
        p.f = Math.max(0, Math.min(1, (dir * (e.clientY - p.y0)) / p.h));
        if (p.f > 0.01 && !this.reduced()) {
          this.stop();
          if (dir < 0) { this.home.hidden = false; this.lockEl.style.transform = `translateY(${(-p.f * 100).toFixed(2)}%)`; }
          else { this.lockEl.hidden = false; this.lockEl.style.transform = `translateY(${(-100 + p.f * 100).toFixed(2)}%)`; }
        }
      });
      const up = (e) => {
        if (!p || e.pointerId !== p.id) return;
        e.stopPropagation();
        const q = p, dt = Math.max(1, performance.now() - q.t0), tap = q.f * q.h < 6;
        p = null;
        end(tap || q.f > 0.2 || (q.f * q.h) / dt > 0.5, q.f);
      };
      host.addEventListener("pointerup", up);
      host.addEventListener("pointercancel", (e) => { if (p && e.pointerId === p.id) { const f = p.f; p = null; end(false, f); } });
    };
    track(this.lockEl, -1, (go, f) => {
      if (go) { this.unlock({ from: f }); return; }
      if (f > 0.01) this.play(this.lockEl, [{ transform: `translateY(${(-f * 100).toFixed(2)}%)` }, { transform: "translateY(0)" }], 260, EASE, () => { if (this.locked) this.home.hidden = true; });
    });
    track(this.home.querySelector(".ph-sb"), 1, (go, f) => {
      if (go) { this.lock({ pull: true, from: f }); return; }
      if (f > 0.01) this.play(this.lockEl, [{ transform: `translateY(${(-100 + f * 100).toFixed(2)}%)` }, { transform: "translateY(-100%)" }], 260, EASE, () => { if (!this.locked) this.lockEl.hidden = true; });
    });
  }
}
