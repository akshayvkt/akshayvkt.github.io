// Content overlays in the live room: HTML at rest, out of the way during glides, following the camera when it orbits.
//
//   import { Overlays, quadToQuad } from "/shared/overlays.js";
//   const ov = new Overlays({ announce: liveRegionEl });
//   ov.add({ el, plane: [p0, p1, p2, p3], photo })   // a layer the page laid out on its photograph: it follows the
//                                                    //   camera exactly for things on that plane (spines, print)
//   ov.add({ el, quad: "print", size: () => [w, h] }) // an element mapped onto a room quad (box -> quad)
//   ov.add({ el, quad, size, occluders: [box, …] })   //   … cut where a furniture box stands in front of it
//   ov.add({ el, follow: [x, y, z], photo })          // a flat UI piece (a pill) that only translates with a point
//   ov.update(pose, vw, vh)                           // every frame the camera moves
//   ov.hide() / ov.show()                             // 150 ms out when a glide starts, 250 ms in after landing
//   ov.inertUnder(cardEl, items)                      // items more than half under the card can't take focus
//   ov.landed(heading)                                // focus the heading, announce the landing
//
// The page's own code keeps laying its overlays out on its photograph (shared/room.js layoutView), so nothing
// of the page changes. A layer placed on the photograph is correct for the camera that took it; for the live
// camera it is off by a homography, exact for every point on one plane (a shelf front, the print, the screen).
// The router gives each layer the photograph's camera (spots.json cameras, matched by the render's size).
import { project } from "./rig.js";
import { occlusionClip } from "./occlude.js";

const SENSOR = 36;

// Where a room point lands on a photograph laid out as geo (CSS px), through the photograph's camera.
export function photoPoint(cam, size, geo, p) {
  const [W, H] = size;
  const fit = cam.fit === "AUTO" ? (W >= H ? "HORIZONTAL" : "VERTICAL") : String(cam.fit).toUpperCase();
  const half = SENSOR / 2 / cam.lens;
  const tanH = fit === "HORIZONTAL" ? half : half * (W / H), tanV = tanH / (W / H);
  const f = cam.forward, u = cam.up, r = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
  const d = [p[0] - cam.eye[0], p[1] - cam.eye[1], p[2] - cam.eye[2]];
  const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
  if (z < 1e-4) return null;
  const tx = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / z, ty = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / z;
  const st = cam.shiftTan || [0, 0];
  const nx = 0.5 + (tx - st[0]) / (2 * tanH), ny = 0.5 - (ty - st[1]) / (2 * tanV);
  return [geo.left + nx * geo.w, geo.top + ny * geo.h];
}

// The 3x3 homography taking four points to four points (row-major h00..h22, h22 = 1), or null.
export function quadToQuad(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
  }
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
// CSS matrix3d for a homography acting on an element with transform-origin 0 0.
export function cssMatrix(h) {
  const n = (v) => +v.toFixed(10);
  return `matrix3d(${n(h[0])},${n(h[3])},0,${n(h[6])},${n(h[1])},${n(h[4])},0,${n(h[7])},0,0,1,0,${n(h[2])},${n(h[5])},0,${n(h[8])})`;
}
const sortCorners = (P) => {
  // screen order top-left, top-right, bottom-right, bottom-left (whichever way the quad was listed)
  const c = P.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]);
  const a = P.map((p) => [Math.atan2(p[1] - c[1], p[0] - c[0]), p]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  const i = a.reduce((best, p, k) => (p[0] + p[1] < a[best][0] + a[best][1] ? k : best), 0);
  return [0, 1, 2, 3].map((k) => a[(i + k) % 4]);
};

// What stands between the eye and a quad item is cut out of it (shared/occlude.js), in the element's own coordinates.
function clipBehind(it, pose, vw, vh, q, S, w, h) {
  const boxes = typeof it.occluders === "function" ? it.occluders() : it.occluders;
  const G = quadToQuad(S, [[0, 0], [w, 0], [w, h], [0, h]]);
  const toLocal = G && ((x, y) => {
    const k = G[6] * x + G[7] * y + G[8];
    return Math.abs(k) < 1e-9 ? null : [(G[0] * x + G[1] * y + G[2]) / k, (G[3] * x + G[4] * y + G[5]) / k];
  });
  const clip = occlusionClip(pose, q, boxes, vw, vh, toLocal, [w, h]);
  if (clip !== (it.clipNow || "")) { it.el.style.clipPath = clip; it.clipNow = clip; }
}

export class Overlays {
  constructor({ announce = null } = {}) {
    this.items = [];
    this.announceEl = announce;
    this.hidden = false;
  }

  add(item) {
    item.el.style.transformOrigin = "0 0";
    item.base = item.el.style.transform || "";
    this.items.push(item);
    return () => this.remove(item);
  }
  remove(item) {
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
    if (item.plane) item.el.style.transform = item.base;
    if (item.follow || item.planePoint) item.el.style.translate = "";
  }
  clear() { for (const it of this.items.slice()) this.remove(it); }

  // Every frame the camera moves: put each layer where the live camera sees its plane.
  update(pose, vw, vh) {
    if (!pose) return;
    for (const it of this.items) {
      if (it.el.isConnected === false) continue;
      try {
        if (it.quad) {
          const q = typeof it.quad === "function" ? it.quad() : it.quad;
          const [w, h] = it.size();
          if (!q || !w || !h) continue;
          const P = q.map((p) => project(pose, p, vw, vh));
          if (P.some((p) => !p)) { it.el.style.visibility = "hidden"; continue; }
          it.el.style.visibility = "";
          const S = sortCorners(P.map((p) => [p[0], p[1]]));
          const H = quadToQuad([[0, 0], [w, 0], [w, h], [0, h]], S);
          if (H) it.el.style.transform = cssMatrix(H);
          if (it.occluders) clipBehind(it, pose, vw, vh, q, S, w, h);
        } else if (it.plane && it.photo) {
          const ph = it.photo();
          if (!ph) continue;
          const src = it.plane.map((p) => photoPoint(ph.camera, ph.size, ph.geo, p));
          const dst = it.plane.map((p) => project(pose, p, vw, vh));
          if (src.some((p) => !p) || dst.some((p) => !p)) continue;
          // the layer's own origin may not be the hero's: work in its parent's coordinates
          const o = it.origin ? it.origin() : [0, 0];
          const H = quadToQuad(src.map((p) => [p[0] - o[0], p[1] - o[1]]), dst.map((p) => [p[0] - o[0], p[1] - o[1]]));
          if (H) it.el.style.transform = cssMatrix(H);
        } else if (it.place && it.points) {
          // a piece the page places around an object by its own rule, given the object's box on screen
          const P = it.points().map((p) => project(pose, p, vw, vh));
          if (P.some((p) => !p)) continue;
          const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
          it.place([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], vw, vh);
        } else if (it.planePoint && it.photo) {
          // a flat piece placed at a point of a plane (a tooltip): it moves with that point, without perspective
          const ph = it.photo();
          if (!ph) continue;
          const src = it.planePoint.map((p) => photoPoint(ph.camera, ph.size, ph.geo, p));
          const dst = it.planePoint.map((p) => project(pose, p, vw, vh));
          if (src.some((p) => !p) || dst.some((p) => !p)) continue;
          const H = quadToQuad(src, dst.map((p) => [p[0], p[1]]));
          const [x, y] = it.at();
          const w = H[6] * x + H[7] * y + H[8];
          if (!H || Math.abs(w) < 1e-9) continue;
          const X = (H[0] * x + H[1] * y + H[2]) / w, Y = (H[3] * x + H[4] * y + H[5]) / w;
          it.el.style.translate = `${(X - x).toFixed(1)}px ${(Y - y).toFixed(1)}px`;
        } else if (it.follow && it.photo) {
          const ph = it.photo();
          if (!ph) continue;
          const a = photoPoint(ph.camera, ph.size, ph.geo, it.follow), b = project(pose, it.follow, vw, vh);
          if (!a || !b) continue;
          it.el.style.translate = `${(b[0] - a[0]).toFixed(1)}px ${(b[1] - a[1]).toFixed(1)}px`;
        }
      } catch (e) { /* a layer mid-teardown */ }
    }
  }

  // Out over 150 ms when a glide starts; in over 250 ms after landing (plan 7). Reduced motion: no fades.
  hide(els, reduced) {
    this.hidden = true;
    for (const el of els) {
      el.style.transition = reduced ? "none" : "opacity 150ms ease";
      el.style.opacity = "0";
      el.style.pointerEvents = "none";
    }
  }
  show(els, reduced) {
    this.hidden = false;
    for (const el of els) {
      el.style.transition = reduced ? "none" : "opacity 250ms ease";
      el.style.opacity = "";
      el.style.pointerEvents = "";
    }
  }

  // Things more than half under a card can't take focus or a click while hidden (plan 7). The one item that is
  // its group's tab stop (a roving tabindex, like the shelf's spines) stays reachable, or the keyboard could not
  // get to the group at all; focusing it while hidden brings the camera back (router onFocusIn).
  inertUnder(card, items) {
    const r = card && card.getBoundingClientRect();
    for (const el of items) {
      if (!r || !r.width || el.tabIndex === 0) { el.inert = false; continue; }
      el.inert = this.fractionUnder(r, el) > 0.5;
    }
  }

  // How much of an element lies under a card (0-1); `card` is an element or its rectangle.
  fractionUnder(card, el) {
    const r = card.getBoundingClientRect ? card.getBoundingClientRect() : card;
    const b = el.getBoundingClientRect();
    if (!(b.width * b.height > 0)) return 0;
    const ix = Math.max(0, Math.min(b.right, r.right) - Math.max(b.left, r.left));
    const iy = Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top));
    return (ix * iy) / (b.width * b.height);
  }

  // On landing: focus moves to the card's heading (tabindex -1) and the landing is announced with words the
  // page already has (its heading), so screen readers hear where they are.
  landed(heading, text) {
    if (heading) {
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
    const say = text ?? heading?.textContent?.trim();
    if (this.announceEl && say) {
      this.announceEl.textContent = "";
      setTimeout(() => { this.announceEl.textContent = say; }, 60);
    }
  }
}
