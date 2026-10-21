// What each event looks like to a renderer: its renderer (points, sky dots, hull sprites, gulls), its size on screen,
// and, for hulls, which cells of the Blender-lit atlas (web/live/sprites: the ferry and the sailboat at 24 headings,
// each big ship's own model at 13, 0..180, drawn mirrored on the other side) to blend.
import { view, wrap360 } from "./geo.js";

const DEG = Math.PI / 180;

export const DESK_PX_PER_RAD = 1335;     // CSS px per radian in the 1440x900 desktop window (23.3 px/deg)
export const PHONE_SCALE = 0.5;          // phones show the view at about half that
export const PHONE_MIN_PX = 1.5;         // events under 1.5 desktop px are dropped on phones (plan 2.3)

// renderer and atlas type per event kind. len: the dimension that sets the on-screen size.
export const CLASSES = {
  car: { renderer: "points" }, heavy: { renderer: "points" },
  beacon: { renderer: "points" }, lighthouse: { renderer: "points" }, aid: { renderer: "points" },
  bridge_light: { renderer: "points" }, cable_light: { renderer: "points" }, lamp: { renderer: "points" },
  airliner: { renderer: "sky" }, light: { renderer: "sky" }, high: { renderer: "sky" },
  // the big ships: each type its own model (ships-r1); "ship" is the old atlas's one container ship, if that is what
  // was fetched
  container: { renderer: "hull", atlas: "container", old: "ship" }, tanker: { renderer: "hull", atlas: "tanker", old: "ship" },
  carcarrier: { renderer: "hull", atlas: "carcarrier", old: "ship" }, bulk: { renderer: "hull", atlas: "bulk", old: "ship" },
  tugbarge: { renderer: "hull", atlas: "tugbarge", old: "ship" }, cruise: { renderer: "hull", atlas: "cruise", old: "ship" },
  tour: { renderer: "hull", atlas: "ferry" }, ferry: { renderer: "hull", atlas: "ferry" }, sail: { renderer: "hull", atlas: "sail" },
  gull: { renderer: "gull" },
};
export const SPINNAKERS = [[0.86, 0.16, 0.14], [0.12, 0.3, 0.72], [0.95, 0.75, 0.15], [0.1, 0.55, 0.35], [0.95, 0.95, 0.95], [0.55, 0.15, 0.55]];
export const TRIMS = { red: [0.78, 0.12, 0.1], blue: [0.1, 0.22, 0.55] };

// size on a desktop screen in CSS px (the larger of length and height)
export function deskPx(it) {
  const d = it.view ? it.view.dist : view(it.x, it.y, it.z).dist;
  const m = Math.max(it.len || 0, it.span || 0, it.mast || 0, it.height || 0);
  return (DESK_PX_PER_RAD * m) / d;
}
export const keepOnPhone = (it) => deskPx(it) >= PHONE_MIN_PX;

// The atlas cells for a hull (boats.json: yaws in degrees, 0 = sailing away, 90 = moving right), the blend between
// the two nearest headings, and the scale from the atlas model to this vessel at this distance for a canvas
// `canvasPx` px per radian.
//   mirror  a ship type's cells cover 0..180 (its starboard side and the views fore and aft); 180..360 is the same
//           picture mirrored (the port side): the shader flips it and its normals
//   warp    each of the two cells stretched across the line of sight to this heading's silhouette (a ship L x B seen
//           at yaw a spans |L sin a| + |B cos a|), so the deckhouse, the funnel and the bow line up and the crossfade
//           between two headings 15 degrees apart does not show them twice
export function hullSprite(it, atlas, canvasPx) {
  const cls = CLASSES[it.kind];
  if (!cls || cls.renderer !== "hull" || !atlas) return null;
  const key = atlas.types[cls.atlas] ? cls.atlas : cls.old;
  const t = key && atlas.types[key];
  if (!t) return null;
  const yaws = t.yaws || atlas.yaws, n = yaws.length;
  const v = it.view || view(it.x, it.y, it.z);
  let yaw = wrap360(it.heading - v.bearing);
  let mirror = false;
  if (key === "sail" && it.side < 0) { mirror = true; yaw = wrap360(-yaw); }   // the sail sits to leeward
  if (t.mirror && yaw > 180) { mirror = true; yaw = 360 - yaw; }
  const step = t.mirror ? 180 / (n - 1) : 360 / n;
  const f = yaw / step;
  let i0 = Math.floor(f), w = f - i0;
  let i1;
  if (t.mirror) { i0 = Math.min(i0, n - 1); i1 = Math.min(i0 + 1, n - 1); if (i0 === n - 1) w = 0; }
  else { i0 %= n; i1 = (i0 + 1) % n; }
  let k0 = 1, k1 = 1;
  if (t.length && t.beam) {
    const span = (a) => Math.abs(Math.sin(a * DEG)) * t.length + Math.abs(Math.cos(a * DEG)) * t.beam;
    const s = span(yaw);
    k0 = s / span(yaws[i0]); k1 = s / span(yaws[i1]);
  }
  const model = atlas.models[key];
  const lenM = key === "sail" ? it.mast : it.len;
  const scale = ((canvasPx / v.dist) * (lenM / model)) / t.px_per_m;   // screen px per atlas px (as boats.js)
  return { type: key, t, cell0: t.cells[i0], cell1: t.cells[i1], size: t.cell, blend: w, anchor: t.anchor, scale, mirror,
    warp: [k0, k1], model, lenScale: lenM / model };
}
