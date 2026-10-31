// Phones: the edge tabs (gestures.js EdgeTabs, "Books" and "Quotes") never sit over the window. Their CSS places them
// clear of it at the desk's rest framing (router.js .sfw-edge: on portrait screens the wall above the window, on
// landscape ones beside it); when the view turns or zooms so that the window's outline (the glass, the wall's
// opening and its frame) comes under a tab, that tab fades out (and is inert) until the window is clear of it again.
// (v3/phone-frame: at the desk's phone camera, since 20 Oct, the window's glass reaches the top of the screen, so a
// tab the rest pose itself puts over the window stays: the framing put it over the sky on purpose, and the tabs are the
// phone's only way to Books and Quotes. The router passes that rest pose only at the phone camera; everywhere else,
// tablets and landscape included, a tab over the window fades exactly as before.)
//
//   import { fitEdges, edgeRects } from "/shared/edgefit.js";
//   fitEdges(edgeTabs, room, pose, w, h, rest, rects)   // every time the camera moves, and when the tabs are shown;
//                                                       // rest: the desk's phone-camera rest pose (else null);
//                                                       // rects: edgeRects(edgeTabs) kept by the caller (else read)
import { project } from "./rig.js";

const FRAME = 0.06;   // m around the opening: the window's frame and casing
const PAD = 6;        // px kept between a tab and the window

// The window's outline on screen, as a box (CSS px of the w x h view), or null when part of it is behind the eye.
export function windowBox(room, pose, w, h) {
  const q = room?.objects?.window?.quad;
  if (!q || !pose) return null;
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  const x0 = Math.min(...xs) - FRAME, x1 = Math.max(...xs) + FRAME, y0 = Math.min(...ys) - FRAME, y1 = Math.max(...ys) + FRAME;
  const wall = room.inner?.[0]?.[2] ?? -1.2;   // the window wall's inner face; the glass lies further out
  const P = [];
  for (const z of [q[0][2], wall]) for (const x of [x0, x1]) for (const y of [y0, y1]) P.push(project(pose, [x, y, z], w, h));
  if (P.some((p) => !p)) return null;
  return [Math.min(...P.map((p) => p[0])), Math.min(...P.map((p) => p[1])), Math.max(...P.map((p) => p[0])), Math.max(...P.map((p) => p[1]))];
}

// (DYS-149 mt-diet) The tabs' boxes in their parent's CSS px, [{ a, L, T, R, B }] (a tab with no width left out), or
// null while the tabs are hidden or gone: all read before anything is written (fitEdges wrote a tab's opacity between
// two tabs' reads, so the second read forced a style recalc). The router keeps them until a resize or a ResizeObserver
// on the tabs or their parent says they changed (router.js measured()): read on every camera move, each was a forced
// layout on a phone's moving frames.
export function edgeRects(edges) {
  const el = edges?.el;
  if (!el || el.hidden || !el.isConnected) return null;
  const base = el.parentNode.getBoundingClientRect(), out = [];
  for (const a of el.children) {
    const r = a.getBoundingClientRect();
    if (!r.width) continue;
    const L = r.left - base.left, T = r.top - base.top;
    out.push({ a, L, T, R: L + r.width, B: T + r.height });
  }
  return out;
}

export function fitEdges(edges, room, pose, w, h, rest = null, rects = null) {
  const el = edges?.el;
  if (!el || el.hidden || !el.isConnected) return;
  const box = windowBox(room, pose, w, h);
  const restBox = rest ? windowBox(room, rest, w, h) : null;
  const under = (b, L, T, R, B) => !b || !(R + PAD < b[0] || L - PAD > b[2] || B + PAD < b[1] || T - PAD > b[3]);
  for (const { a, L, T, R, B } of rects || edgeRects(edges)) {
    const over = under(box, L, T, R, B) && !(restBox && under(restBox, L, T, R, B));
    if (over === (a.dataset.over === "1")) continue;
    a.dataset.over = over ? "1" : "";
    a.style.opacity = over ? "0" : "";
    a.style.pointerEvents = over ? "none" : "";
    a.inert = over;
  }
}
