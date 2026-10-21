// The city's events, drawn outside the window (stream X1): X2's city clock (web/shared/city) gives every event as a
// pure function of time, in metres around the desk eye; this file projects them through whatever camera is live and
// fills the three renderers' buffers (plan v1 2.3):
//   points     traffic, beacons and lighthouses, bridge lamps, aircraft and vessel lights, cabin windows
//   sky dots   aircraft by day, gulls (a flapping V)
//   hulls      ships, tour boats, sailboats and ferries from the motion track's lit 24-heading atlas, with wakes
// Sprites take the rendered moment's light (state.moment, each item's look.moment), fade toward the panorama behind
// them by their haze, and are hidden by the panorama's sharp depth and by the room (outside.glsl.js).
import { CLASSES, hullSprite, deskPx, PHONE_MIN_PX, SPINNAKERS, TRIMS } from "./city/sprites.js";

const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const POINT_FLOATS = 15;     // pos4 colour4 shape4 dir3
export const HULL_FLOATS = 35;      // pos4 cell0 4 cell1 4 more4 look4 sun4 dir3 warp4 livery4
export const MAX_WAKES = 16;

const RGB = { white: [1.0, 0.93, 0.82], red: [1.0, 0.12, 0.07], green: [0.35, 1.0, 0.55], amber: [1.0, 0.68, 0.32], warm: [1.0, 0.78, 0.5] };
const FLOOD = { sodium: [1.0, 0.62, 0.28], led: [0.93, 0.96, 1.0] };
// navigation lights on a ship's sprite model (boats.json nav, metres: x starboard, y forward, z up): which rig point
// each of the clock's lights (ships.js lights()) sits on, and how bright it reads (the masthead a little brighter:
// the brightest light a ship shows, seen first)
const NAV = { mast1: ["mast_fwd", 1, 1.3], mast2: ["mast_aft", 1, 1.3], green: ["side", 1, 1.0], red: ["side", -1, 1.0], stern: ["stern", 1, 0.9] };

/**
 * roomFrame(axisDeg, eye, shift): the room frame of the panorama. ENU metres around the city's eye -> engine world
 * coordinates. shift: the city's eye minus the panorama's eye (east, north metres; routes.json's eye_scene against
 * pano.json's eye.world_m), so the events are seen from the eye the panorama was rendered from.
 */
export function roomFrame(axisDeg, eye, shift = [0, 0]) {
  const s = Math.sin(axisDeg * DEG), c = Math.cos(axisDeg * DEG);
  const [sx, sy] = shift;
  return {
    // east, north, up (m from the city's eye) -> room frame (x right, y up, z back), around the panorama's eye
    rel(x, y, z) { x += sx; y += sy; return [x * c - y * s, z, -(x * s + y * c)]; },
    world(x, y, z) { const r = this.rel(x, y, z); return [eye[0] + r[0], eye[1] + r[1], eye[2] + r[2]]; },
    // compass heading -> (right, forward) unit vector in the room frame
    heading(h) { return [Math.sin((h - axisDeg) * DEG), Math.cos((h - axisDeg) * DEG)]; },
  };
}

// eyeH: the panorama's eye above the water (pano.json eye.asl_m), for the lights' reflections
export function createEvents({ axisDeg, eye, atlas, eyeH = 113.81, shift = [0, 0] }) {
  const F = roomFrame(axisDeg, eye, shift);
  let pts = new Float32Array(POINT_FLOATS * 1024);
  let hulls = new Float32Array(HULL_FLOATS * 128);
  const wakeP = new Float32Array(MAX_WAKES * 4), wakeQ = new Float32Array(MAX_WAKES * 4), wakeR = new Float32Array(MAX_WAKES * 4);
  let np = 0, nh = 0, nw = 0;

  // camera: { vp: Float64Array(16) column-major view-projection (no jitter, sway included), width, height, pxPerRad,
  //           css: device px per CSS px, phone: bool }
  let cam = null;
  function project(x, y, z) {
    const w = F.world(x, y, z), m = cam.vp;
    const cx = m[0] * w[0] + m[4] * w[1] + m[8] * w[2] + m[12];
    const cy = m[1] * w[0] + m[5] * w[1] + m[9] * w[2] + m[13];
    const cw = m[3] * w[0] + m[7] * w[1] + m[11] * w[2] + m[15];
    if (cw <= 1e-6) return null;
    const px = (cx / cw * 0.5 + 0.5) * cam.width, py = (cy / cw * 0.5 + 0.5) * cam.height;
    if (px < -200 || px > cam.width + 200 || py < -200 || py > cam.height + 200) return null;
    return [px, py];
  }
  const distOf = (x, y, z) => Math.hypot(x, y, z);

  function grow() {
    if ((np + 1) * POINT_FLOATS > pts.length) { const n = new Float32Array(pts.length * 2); n.set(pts); pts = n; }
  }
  // one point. shape 0 light (added), 1 water streak (added; lenCss its length), 2 speck / sky dot (over),
  // 3 gull (over; lenCss its wingspan, wing the wing angle -1..1). aShape = (sigma px | wing, shape, length px, size px)
  function point(x, y, z, rgb, a, sigCss, shape, lenCss = 0, wing = 0) {
    const p = project(x, y, z);
    if (!p || a <= 0.002) return;
    grow();
    const d = distOf(x, y, z), r = F.rel(x, y, z);
    const sig = sigCss * cam.css, len = lenCss * cam.css;
    const size = shape === 3 ? Math.ceil(len * 1.2 + 4) : shape === 1 ? Math.ceil(Math.max(sig * 6, len * 2) + 2) : Math.max(3, Math.ceil(sig * 7));
    pts.set([p[0], p[1], size, d, rgb[0], rgb[1], rgb[2], a, shape === 3 ? wing : sig, shape, len, size,
      r[0] / d, r[1] / d, r[2] / d], np * POINT_FLOATS);
    np++;
  }

  function fill(s, env) {
    cam = env.cam;
    np = 0; nh = 0; nw = 0;
    const M = s.moment, L = s.lighting;
    const night = L.night, lightsOn = L.lights;
    // the ships' floodlights: switched on with the navigation lights, and seen more as the scene darkens
    const floodK = lightsOn * (0.35 + 0.65 * (M ? M.mode.lights : night));
    const css = cam.css;
    const keep = (it) => !cam.phone || deskPx(it) >= PHONE_MIN_PX;
    // v3/zoom: magnified at the window (cam.zoom > 1), things with a size (cars, aircraft) are drawn that much larger
    const zm = cam.zoom > 1 ? cam.zoom : 1;
    const air = env.stats?.high || [0.6, 0.7, 0.8];

    // ---- bridge traffic: specks by day, dark dots against a low sun, head and tail lights at night
    const V = M ? M.vehicles : { speck: 0.35 * L.day, dark: 0, lights: 1 - L.day };
    for (const v of s.vehicles) {
      const a = v.alpha ?? 1;
      if (a <= 0.01) continue;
      const heavy = v.kind !== "car";
      if (V.lights > 0.01) {
        const c = v.light === "tail" ? RGB.red : RGB.white;
        point(v.x, v.y, v.z, c, a * V.lights * (v.light === "tail" ? 0.55 : 0.8) * (0.7 + 0.3 * (v.tint ?? 1)), heavy ? 0.6 : 0.42, 0);
      }
      const day = V.speck + V.dark;
      if (day > 0.01) {
        // a car 5-6 km out is about one CSS px: a faint speck, never a solid dot (a dark one against a low sun)
        const px = (1335 * zm * (v.len || 4.5)) / Math.hypot(v.x, v.y, v.z);
        const cover = clamp(px / 2, 0.25, 1);
        const g = 0.3 + 0.45 * (v.tint ?? 0.5);
        const dark = V.dark / Math.max(day, 1e-3);
        const col = [g * (1 - dark) + 0.07 * dark, g * (1 - dark) + 0.06 * dark, g * 0.98 * (1 - dark) + 0.06 * dark];
        // the air between: a car 5-6 km out shows only as much as the haze lets through (city.js v.haze); backlit, no
        // plainer than the deck it drives on (the panorama's own deck: env.stats.deck, its silhouette's darkness against
        // what lies just above it; about 0.9 with no air in front)
        const hz = 1 - (v.haze ?? 0);
        const dk = env.stats?.deck != null ? Math.min(hz, clamp(env.stats.deck / 0.9, 0, 1)) : hz;
        const k = (V.speck * hz + V.dark * dk) / Math.max(day, 1e-3);
        point(v.x, v.y, v.z, col, a * Math.min(1, day) * cover * (heavy ? 0.8 : 0.5) * k, (heavy ? 0.5 : 0.36) * (zm > 1 ? zm ** 0.75 : 1), 2);
      }
    }
    // ---- beacons, lighthouses, harbour lights, cable and deck lights
    for (const l of s.lights) {
      const a = (l.level ?? 1) * (l.intensity ?? 1);
      if (a <= 0.01) continue;
      const big = l.kind === "lighthouse" || l.kind === "beacon";
      point(l.x, l.y, l.z, l.rgb || RGB[l.colour] || RGB.white, a, big ? 0.7 : 0.45, 0);
      if (night > 0.3 && big) point(l.x, l.y, l.z - 2 * (l.z + eyeH), l.rgb || RGB.white, a * 0.18 * night, 0.5, 1, 6);
    }
    for (const l of s.lamps.deck || []) point(l.x, l.y, l.z, RGB.amber, (l.level ?? 1) * 0.45, 0.4, 0);

    // ---- aircraft: a grey dot with a glint by day; navigation lights, strobe and landing lights at night
    for (const p of s.planes) {
      if (!keep(p) && !lightsOn) continue;
      const a = p.alpha ?? 1;
      const hz = p.look?.moment?.hazeMix ?? 0;
      const sizeCss = Math.max(0.6, (1335 * zm * Math.max(p.span || 30, p.len || 30)) / (p.view?.dist || distOf(p.x, p.y, p.z)) * 0.35);
      if (L.day > 0.05) {
        const g = p.glint ? 0.85 : 0.32;
        const c = [g * (1 - hz) + air[0] * hz, g * (1 - hz) + air[1] * hz, g * (1 - hz) + air[2] * hz];
        point(p.x, p.y, p.z, c, a * L.day * (0.85 - 0.5 * hz), Math.max(0.45, sizeCss * 0.5), 2);
      }
      if (lightsOn > 0.02 && p.lights) {
        const hv = F.heading(p.heading || 0);
        const half = (p.span || 30) / 2;
        // wingtips: across the heading, in east / north
        const hx = Math.sin((p.heading || 0) * DEG), hy = Math.cos((p.heading || 0) * DEG);
        const R = [hy * half, -hx * half];
        const k = a * lightsOn;
        if (p.lights.red) point(p.x - R[0], p.y - R[1], p.z, RGB.red, k * 0.8, 0.45, 0);
        if (p.lights.green) point(p.x + R[0], p.y + R[1], p.z, RGB.green, k * 0.8, 0.45, 0);
        if (p.lights.tail) point(p.x, p.y, p.z, RGB.white, k * 0.6, 0.4, 0);
        if (p.lights.beacon) point(p.x, p.y, p.z - 3, RGB.red, k * p.lights.beacon * 0.9, 0.5, 0);
        if (p.lights.strobe) point(p.x, p.y, p.z, RGB.white, k * p.lights.strobe * 1.4, 0.6, 0);
        if (p.lights.landing) point(p.x + hx * (p.len || 30) * 0.4, p.y + hy * (p.len || 30) * 0.4, p.z, [1, 0.97, 0.9], k * p.lights.landing * 2.2, 0.9, 0);
        void hv;
      }
    }

    // ---- gulls: a flapping V, lit by the moment's sun or dark against it
    for (const g of s.gulls) {
      const a = g.alpha ?? 1;
      const d = g.view?.dist || distOf(g.x, g.y, g.z);
      const span = ((g.span || 1.3) * cam.pxPerRad) / d;            // device px
      if (span < 0.8) continue;
      const lm = g.look?.moment || {};
      const lit = 0.75 * (1 - (lm.silhouette ?? 0)) + 0.08;
      const wing = Math.sin((g.wing ?? 0) * 2 * Math.PI);
      point(g.x, g.y, g.z, [lit, lit, lit * 0.97], a * L.day, 0, 3, span / css, wing);
    }

    // ---- vessels: hull sprites, their wakes, and their lights at night
    const vessels = [...s.ships, ...s.tours, ...s.sails, ...s.ferries];
    const wl = [];
    for (const b of vessels) {
      const a = b.alpha ?? 1;
      if (a <= 0.01 || !keep(b)) continue;
      const v = b.view;
      const p0 = project(b.x, b.y, b.z);
      if (!p0) continue;
      let sp = null;
      if (atlas) {
        sp = hullSprite(b, atlas, cam.pxPerRad);
        if (sp) {
          const lm = b.look?.moment || { sunOnFace: L.day, silhouette: 0, rim: 0, hazeMix: 0 };
          const sunAz = M ? M.sunAz : L.sunAz, sunAlt = M ? M.sunAlt : L.sunAlt;
          const db = (sunAz - v.bearing) * DEG, ca = Math.cos(Math.max(-5, sunAlt) * DEG);
          const sun = [Math.sin(db) * ca, Math.sin(Math.max(-5, sunAlt) * DEG), -Math.cos(db) * ca, M ? M.mode.lights : 1 - L.day];
          const r = F.rel(b.x, b.y, b.z), d = v.dist;
          // the ship's paint (its livery faces) and its floodlights' colour temperature (0 sodium .. 1 LED)
          const lv = b.livery || [0.7, 0.7, 0.7];
          for (const refl of [true, false]) {
            if ((nh + 1) * HULL_FLOATS > hulls.length) { const n = new Float32Array(hulls.length * 2); n.set(hulls); hulls = n; }
            hulls.set([p0[0], p0[1], sp.scale, d,
              sp.cell0[0], sp.cell0[1], sp.size[0], sp.size[1], sp.cell1[0], sp.cell1[1], sp.size[0], sp.size[1],
              sp.blend, sp.anchor, a, (refl ? 1 : 0) + (sp.mirror ? 2 : 0),
              lm.sunOnFace ?? 0, lm.silhouette ?? 0, lm.rim ?? 0, lm.hazeMix ?? 0,
              sun[0], sun[1], sun[2], sun[3], r[0] / d, r[1] / d, r[2] / d,
              sp.warp[0], sp.warp[1], sp.t.mirror ? 1 : 0, sp.t.win_gain ?? 1, lv[0], lv[1], lv[2], b.led ?? 0.5], nh * HULL_FLOATS);
            nh++;
          }
        }
      }
      // wakes (in the backdrop's water shader): right / forward of the desk eye. A big ship's scale with its speed and
      // size: the white bow wave (stronger as the square of the speed), the churned track and the Kelvin arms behind it
      // (as long as the water it has crossed in about four and a half minutes), and a soft darkening of the water
      // along its sides (the hull's shade and the calm in its lee)
      if ((b.speed ?? 0) > 0.5 && !b.docked) {
        const r = F.rel(b.x, b.y, b.z), h = F.heading(b.heading);
        const cls = CLASSES[b.kind]?.atlas;
        const big = b.cls === "ship";
        const sv = clamp((b.speed ?? 0) / 6.2, 0, 1.6), size = clamp((b.len || 200) / 250, 0.4, 1.6);
        const wake = big ? clamp(b.speed * 270, 300, 2200) : cls === "sail" ? 70 : 520;
        const foam = big ? 0.6 * Math.pow(sv, 1.3) * Math.pow(size, 0.3) : cls === "sail" ? 0.35 : 1.0;
        const bow = big ? 1.0 * sv * sv * Math.pow(size, 0.2) : foam * 0.5;
        const len = cls === "sail" ? (b.len || 10) : b.len;
        const dim = a * (1 - 0.85 * night);
        wl.push({ P: [r[0], -r[2], h[0], h[1]], Q: [len, b.beam || len * 0.15, wake, foam * dim], R: [bow * dim, big ? 0.22 * a : 0.1 * a, 0, 0], k: foam * len / v.dist });
      }
      // lights: masthead, sides, stern (already filtered by their arcs) and cabin windows
      if (lightsOn > 0.02) {
        const rig = sp?.t?.nav, sc = sp ? sp.lenScale : 1;
        const near = clamp(3000 / v.dist, 0.5, 1.2);
        for (const l of b.lights || []) {
          const c = RGB[l.colour] || RGB.white;
          let { x, y, z } = l, lev = l.level ?? 1;
          const nv = rig && NAV[l.kind];
          if (nv && rig[nv[0]]) {
            // on the model's own rig: [x starboard, y forward, z up] metres at its length, scaled to this ship
            const q = rig[nv[0]], hx = Math.sin(b.heading * DEG), hy = Math.cos(b.heading * DEG);
            const along = q[1] * sc, right = q[0] * nv[1] * sc;
            x = b.x + along * hx + right * hy; y = b.y + along * hy - right * hx; z = b.z + q[2] * sc;
            lev *= nv[2];
          }
          const k = lev * lightsOn * a * near;
          point(x, y, z, c, k, 0.5, 0);
          // a small glow round it (the air and the lens), and its column of light broken on the swell below
          if (rig) point(x, y, z, c, k * 0.16, 1.9, 0);
          const hpx = cam.pxPerRad * Math.max(2, z - b.z) / v.dist;
          point(x, y, b.z - (z - b.z) * 0.85, c, k * (rig ? 0.42 : 0.22), 0.5, 1, Math.max(3, (hpx * (rig ? 1.1 : 0.8)) / css));
        }
        // the floodlights' lamps themselves: brightest seen from in front of their beams
        if (rig && sp.t.floods) {
          const fc = (b.led ?? 0.5) > 0.5 ? FLOOD.led : FLOOD.sodium;
          const hx = Math.sin(b.heading * DEG), hy = Math.cos(b.heading * DEG);
          const ex = -b.x, ey = -b.y, en = Math.hypot(ex, ey) || 1;
          const mx = sp.mirror ? -1 : 1;     // (a mirrored sprite shows the port side: its lamps where the picture has them)
          for (const f of sp.t.floods) {
            const along = f[1] * sc, right = f[0] * sc * mx;
            const x = b.x + along * hx + right * hy, y = b.y + along * hy - right * hx, z = b.z + f[2] * sc;
            // the beam's direction in east / north / up, against the direction to the eye
            const dx = f[4] * hx + f[3] * mx * hy, dy = f[4] * hy - f[3] * mx * hx, dz = f[5], dn = Math.hypot(dx, dy, dz) || 1;
            const facing = (dx * ex + dy * ey) / (dn * en);
            const k = floodK * a * near * (0.28 + 0.5 * smooth(-0.2, 0.6, facing));
            point(x, y, z, fc, k, 0.45, 0);
          }
        }
        const cab = rig ? null : b.cabin;     // (a ship model's own lit windows carry its cabins)
        if (cab && (cab.level ?? 1) > 0) {
          const hx = Math.sin(b.heading * DEG), hy = Math.cos(b.heading * DEG);
          const n = Math.max(3, Math.min(9, Math.round(((b.len * cam.pxPerRad) / v.dist) / 3)));
          for (let row = 0; row < (cab.rows || 1); row++) {
            const hgt = (b.height || 10) * (cab.h0 + (cab.h1 - cab.h0) * (row + 0.5) / (cab.rows || 1));
            for (let i = 0; i < n; i++) {
              const f = cab.from + (cab.to - cab.from) * (i + 0.5) / n;
              const flick = 0.75 + 0.25 * (((cab.seed || 1) * 7919 + i * 104729 + row * 31) % 97) / 97;
              point(b.x + hx * f * b.len, b.y + hy * f * b.len, b.z + hgt, RGB.warm, 0.35 * (cab.level ?? 1) * lightsOn * a * flick, 0.42, 0);
            }
          }
        }
      }
    }
    wl.sort((p, q) => q.k - p.k).slice(0, MAX_WAKES).forEach((w, i) => { wakeP.set(w.P, i * 4); wakeQ.set(w.Q, i * 4); wakeR.set(w.R, i * 4); nw = i + 1; });
    return { points: np, hulls: nh, wakes: nw };
  }

  return {
    fill,
    get points() { return pts.subarray(0, np * POINT_FLOATS); },
    get hulls() { return hulls.subarray(0, nh * HULL_FLOATS); },
    get counts() { return { points: np, hulls: nh, wakes: nw }; },
    wakeP, wakeQ, wakeR,
    frame: F,
    spinnakers: SPINNAKERS, trims: TRIMS,
  };
}
