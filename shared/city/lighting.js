// Sprite lighting for each rendered moment (plan v1 2.3 "Lighting each moment, for sprites", kept by plan v2 6).
//
// The view behind a sprite is a Cycles render of one of the 14 moments, so hulls, sails, gulls and aircraft take
// that moment's light: its sun in scene.json, not the real sun of this second. Between two moments the hints blend by
// pickFrames' t, as the panorama does. routes.json "moments" (scripts/city_clock/city_routes.py) holds, per moment,
// the sun's direction, its colour after the air mass (est.), the sky's colour (the room photo's palette, standing in
// for the panorama's L2 until the outside renderer samples it), the haze build.py put in the scene, the fog over the
// deck, and the v1 mode:
//   day (sunrise .. lateafternoon)  lit from the moment's sun, plus sky ambient;
//   backlit (golden, lowsun, sunset) silhouettes with a rim;
//   lights (dusk .. predawn)         lights only, with streaked reflections on the water.
// Haze: a sprite fades toward the panorama behind it by the scene's own haze along the line of sight (until
// build_web.py fits a haze length from the panorama). Fog: by the fog layer's alpha at the sprite (the renderer's).
// Bridge traffic (plan 2.3 #1): specks at 35% by day, dark dots in the backlit moments, head and tail lights at night.
import { pickFrames } from "../sky.js";
import { clamp, lerp, wrap180 } from "./geo.js";

const DEG = Math.PI / 180;
export const MODES = ["day", "backlit", "lights"];
const unit = (alt, az) => [Math.cos(alt * DEG) * Math.sin(az * DEG), Math.cos(alt * DEG) * Math.cos(az * DEG), Math.sin(alt * DEG)];

export function createLighting(moments, frame) {
  const eyeAsl = frame.eye;
  const list = moments.map((m) => ({ ...m, dir: unit(m.alt, m.az) }));
  const byId = new Map(list.map((m) => [m.id, m]));

  // the blended hints for the moments shown when the sun is at `sun` ({alt, az}, the real sun picks the moments)
  function at(sun) {
    const { a, b, t } = pickFrames(list, sun);
    const mix = (k) => lerp(a[k], b[k], t);
    const mix3 = (k) => [0, 1, 2].map((i) => lerp(a[k][i], b[k][i], t));
    const mode = {};
    for (const m of MODES) mode[m] = (a.mode === m ? 1 - t : 0) + (b.mode === m ? t : 0);
    let d = mix3("dir");
    const n = Math.hypot(d[0], d[1], d[2]) || 1;
    d = d.map((x) => x / n);
    return {
      a: a.id, b: b.id, t, nearest: t < 0.5 ? a.id : b.id, mode,
      hull: MODES.reduce((best, m) => (mode[m] > mode[best] ? m : best), "day"),
      sunDir: d, sunAlt: Math.asin(clamp(d[2], -1, 1)) / DEG, sunAz: ((Math.atan2(d[0], d[1]) / DEG) + 360) % 360,
      sunRGB: mix3("sun_rgb"), sunI: mix("sun_i"), ambientRGB: mix3("ambient_rgb"),
      hazeSigma0: mix("haze_sigma0"), hazeScale: mix("haze_scale"), fog: mix("fog"),
      silhouette: mode.backlit, rim: mode.backlit, reflections: mode.lights,
      vehicles: { speck: 0.35 * mode.day, dark: mode.backlit, lights: mode.lights },
    };
  }

  // haze transmittance from the eye to a point h metres above the sea, dist metres away, in build.py's atmosphere
  // (extinction sigma0 x exp(-h / scale), integrated along the straight line of sight)
  function haze(M, dist, h) {
    const H = M.hazeScale, h0 = eyeAsl, dh = h - h0;
    const mean = Math.abs(dh) < 1 ? Math.exp(-h0 / H) : (H * (Math.exp(-h0 / H) - Math.exp(-h / H))) / dh;
    return Math.exp(-M.hazeSigma0 * dist * mean);
  }

  // one sprite's hints: how backlit it is, the sun on the face we see, which screen side the light comes from, haze
  function item(it, M) {
    const v = it.view;
    const db = wrap180(M.sunAz - v.bearing);   // the sun's azimuth relative to the line of sight to the sprite
    const toward = Math.cos(db * DEG);          // 1: the sun is straight behind the sprite (we look into it)
    const cosAlt = Math.max(0, Math.cos(M.sunAlt * DEG));
    // the sprite's middle, in metres above the sea (aircraft carry their altitude)
    const h = it.h !== undefined ? it.h : frame.h(it.x, it.y, it.z) + (it.height || it.mast || 0) / 2;
    const tr = haze(M, v.dist, h);
    return {
      silhouette: M.mode.backlit * (0.6 + 0.4 * Math.max(0, toward)),
      rim: M.mode.backlit * Math.max(0, toward) ** 2,
      sunOnFace: M.mode.day * Math.max(0, -toward) * cosAlt,   // times M.sunI and M.sunRGB for the light itself
      sunFromRight: Math.sin(db * DEG) * cosAlt,
      hazeMix: 1 - tr,
    };
  }

  return { at, item, haze, moments: list, byId };
}
