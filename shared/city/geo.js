// Geometry for the city clock: metres around the desk eye (x east, y north, z up), Earth's curvature, polylines.

const DEG = Math.PI / 180;
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const lerp = (a, b, t) => a + (b - a) * t;
export const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
export const wrap360 = (a) => ((a % 360) + 360) % 360;

// The frame from routes.json: z of a point h metres above sea level, seen from the eye, with the Earth's drop.
// k is the refraction coefficient; 0 matches the rendered scene (build.py drop(), straight Cycles rays).
export function makeFrame(meta) {
  const eye = meta.eye_asl, R = meta.R / (1 - (meta.refraction_k || 0));
  return {
    eye, R,
    z: (x, y, h) => h - eye - (x * x + y * y) / (2 * R),
    h: (x, y, z) => z + eye + (x * x + y * y) / (2 * R),   // the inverse: height above the sea of an eye-relative point
  };
}

// eye-relative x, y (m) of a latitude and longitude (the frame of routes.json)
export function fromLatLon(meta, lat, lon) {
  return [(lon - meta.origin[1]) * meta.m_per_deg[0] - meta.eye_scene[0], (lat - meta.origin[0]) * meta.m_per_deg[1] - meta.eye_scene[1]];
}

// compass bearing, elevation (deg) and distance (m) of an eye-relative point
export function view(x, y, z) {
  const d = Math.hypot(x, y);
  return { bearing: wrap360(Math.atan2(x, y) / DEG), elev: Math.atan2(z, d) / DEG, dist: Math.hypot(d, z) };
}
export const bearingOf = (x, y) => wrap360(Math.atan2(x, y) / DEG);
export const dirOf = (deg) => [Math.sin(deg * DEG), Math.cos(deg * DEG)];

// A polyline with arc length: at(s) -> {x, y, h, heading}. Points are [x, y] or [x, y, h].
export function polyline(pts) {
  const n = pts.length, cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const L = cum[n - 1];
  function seg(s) {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    return lo;
  }
  return {
    L, pts,
    // position at arc length s (clamped); heading smoothed over +-r metres so corners turn, not snap
    at(s, r = 0) {
      s = clamp(s, 0, L);
      const i = seg(s), a = pts[i], b = pts[Math.min(i + 1, n - 1)];
      const sl = cum[Math.min(i + 1, n - 1)] - cum[i];
      const u = sl > 0 ? (s - cum[i]) / sl : 0;
      let hx = b[0] - a[0], hy = b[1] - a[1];
      if (r > 0) {
        const p0 = this.raw(s - r), p1 = this.raw(s + r);
        hx = p1[0] - p0[0]; hy = p1[1] - p0[1];
      }
      return {
        x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u,
        h: a.length > 2 ? a[2] + (b[2] - a[2]) * u : 0, heading: wrap360(Math.atan2(hx, hy) / DEG),
      };
    },
    raw(s) {
      s = clamp(s, 0, L);
      const i = seg(s), a = pts[i], b = pts[Math.min(i + 1, n - 1)];
      const sl = cum[Math.min(i + 1, n - 1)] - cum[i];
      const u = sl > 0 ? (s - cum[i]) / sl : 0;
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    },
  };
}

// point in polygon (even-odd), polygon as [[x, y], ...]
export function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// a point inside a polygon from two uniforms (rejection over the bounding box, deterministic)
export function pointIn(poly, u, v, more) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  for (let k = 0; k < 24; k++) {
    const x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * v;
    if (inside(poly, x, y)) return [x, y];
    [u, v] = more(k);
  }
  const c = poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
  return c;
}

// Which side of a vessel or aircraft faces the eye: angle of the eye off the bow, clockwise (deg, -180..180).
// > 0: we see its starboard (right) side.
export function eyeOffBow(x, y, heading) {
  return wrap180(bearingOf(-x, -y) - heading);
}

// Navigation lights seen from the eye (COLREGS rule 21 arcs; aircraft wingtip lights use 110 deg):
// masthead/forward white over 225 deg ahead, green to starboard and red to port over 112.5 deg each, stern white aft.
export function navLights(x, y, heading, sideArc = 112.5) {
  const a = eyeOffBow(x, y, heading);
  return {
    off: a,
    masthead: Math.abs(a) <= 112.5 ? 1 : 0,
    green: a >= 0 && a <= sideArc ? 1 : 0,
    red: a <= 0 && a >= -sideArc ? 1 : 0,
    stern: Math.abs(a) >= 112.5 ? 1 : 0,
  };
}

// offset (along the heading, to starboard, up) -> eye-relative xyz
export function local(x, y, z, heading, along, right, up) {
  const s = Math.sin(heading * DEG), c = Math.cos(heading * DEG);
  return [x + along * s + right * c, y + along * c - right * s, z + up];
}
