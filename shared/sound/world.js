// What the sound listens to on the live page: the city's clock and state, where the camera is and looks, and the
// room's interactions. In the live 3D room all of it comes from the router (shared/router.js registers itself with
// sound.js): the outside's own city and clock (the dial moves them), the rig's pose, the interactions' events. Without
// the 3D (photographs, reduced motion, a page document before its room is up) the sound keeps its own city (routes.json
// in the panorama's frame) on a clock that follows the masthead, and listens from the desk (or the window spot).
//
// The touches it hears (and gives to engine.cue): the lamp's switch and the books' pulls (gl/interact.js events), the
// notebook's elastic and cover (notebook.js's state as it moves), its index's leaf turning (the 3D page turn calls
// sound.js pageTurn() itself, router.js; this watch is for the turns without it: reduced motion's fade, a room without
// the 3D turn), a tap on the laptop's screen while leaned in, the phone's unlock; and the headphones'
// video ducks everything while it plays.
import { createCity } from "../city/city.js";
import { createClock } from "../city/clock.js";
import { getOverride } from "../sky.js";
import { project } from "../rig.js";

const AXIS = 291.6564, EYE = 112.64;       // the real panorama's frame (live.md), for the sound's own city
const WINDOW_Z = -1.4;                     // the window's plane (room3d.json objects.window, room metres)
const OBJ = { lamp: "lamp", shelf: "shelf", notebook: "notebook", laptop: "screen", phone: "phone" };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function createWorld({ room, cue, lastPageTurn }) {
  const nav = () => { const n = room(); return n && n.mode === "live" && n.rig?.pose ? n : null; };
  // ---- the sound's own city, when there is no live outside to share
  let own = null, ownLoading = false;
  const clock = createClock({ search: location.search, override: getOverride() });
  const onMoment = (e) => clock.set(e.detail && Number.isFinite(e.detail.minutes) ? e.detail.minutes : null);
  document.addEventListener("sky:moment", onMoment);
  function ownCity() {
    if (own || ownLoading) return own;
    ownLoading = true;
    fetch(new URL("../city/routes.json", import.meta.url)).then((r) => r.json()).then((routes) => {
      own = createCity(routes, { eyeAsl: EYE, axisDeg: AXIS });
    }).catch((e) => { ownLoading = false; console.warn("sound: routes", e && e.message); });
    return null;
  }

  // ---- the camera, between polls
  let last = null;
  const motion = { speed: 0, turn: 0 };
  // ---- the interactions' hooks (attached once each)
  const hooked = new WeakSet();
  let hover = null, pulledOut = 0, nbPrev = null, leaf = null, locked = null;
  const offs = [];

  function hook(n) {
    const it = n.interact;
    if (it && !hooked.has(it)) {
      hooked.add(it);
      offs.push(it.on("lamp", ({ on }) => cue("lamp", { on })));
      offs.push(it.on("hover", ({ object }) => {
        const was = hover;
        hover = object;
        if (object && object.startsWith("book:")) cue("book", { out: 0.015 });
        else if (was && was.startsWith("book:")) cue("book-home");
      }));
      offs.push(it.on("book", () => cue("book", { out: 0.05 })));
    }
    if (it) {   // a book that was out on its card slides home when the card closes
      const out = Math.max(0, ...it.pulled.map((p) => p.to));
      if (pulledOut >= 0.04 && out < 0.02 && !(hover && hover.startsWith("book:"))) cue("book-home");
      pulledOut = out;
    }
    const nb = n.nb3d;
    if (nb && !hooked.has(nb) && nb.onChange) {
      hooked.add(nb);
      const off = nb.onChange((s) => {
        const p = nbPrev || s;
        if (s.open && p.elastic <= 0.001 && s.elastic > 0.001) {          // opening: the elastic slips, then the cover
          cue("elastic");
          cue("cover-open", { dur: 0.8, delay: 0.34 });
        }
        if (!s.open && p.cover >= 0.999 && s.cover < 0.999) {             // closing: the cover, then the elastic back on
          cue("cover-close", { dur: 0.8 });
          cue("elastic", { delay: 0.86 });
        }
        nbPrev = s;
      });
      if (typeof off === "function") offs.push(off);
    }
    const ix = n.nbIndex;
    if (ix) {
      if (leaf !== null && ix.leaf !== leaf && performance.now() - lastPageTurn() > 1000) cue("page", { dir: ix.leaf > leaf ? 1 : -1 });
      leaf = ix.leaf;
    }
    const ph = n.phone;
    if (ph) { if (locked === true && ph.locked === false) cue("unlock"); locked = ph.locked; }
    const host = n.laptop?.host;
    if (host && !hooked.has(host)) {
      hooked.add(host);
      const tap = () => { if (room()?.spot === "laptop") cue("tap"); };
      host.addEventListener("pointerdown", tap, true);
      offs.push(() => host.removeEventListener("pointerdown", tap, true));
    }
    const fr = host?.shadowRoot?.querySelector("iframe");
    const fw = fr?.contentWindow;
    if (fw && !hooked.has(fw)) {
      hooked.add(fw);
      const tap = () => { if (room()?.spot === "laptop") cue("tap"); };
      try { fw.addEventListener("pointerdown", tap, true); offs.push(() => { try { fw.removeEventListener("pointerdown", tap, true); } catch { /* gone */ } }); } catch { /* not same-origin */ }
    }
  }

  return {
    T: () => (nav()?.outside?.clock ?? clock).T(),
    city: () => nav()?.outside?.city ?? ownCity(),
    listener() {
      const n = nav(), atWindow = document.documentElement.classList.contains("sfw-at-window") || room()?.spot === "window";
      if (!n) return { bearing: AXIS - (atWindow ? 0 : 4), open: atWindow ? 0.5 : 0.04, width: atWindow ? 1 : 0.8, speed: 0, turn: 0, reading: false, duck: 0 };
      try { hook(n); } catch (e) { if (n.debug) console.warn(e); }
      const pose = n.rig.pose, axis = n.outside?.meta?.axis_bearing_deg ?? AXIS;
      const now = performance.now();
      if (last) {
        const dt = Math.max(0.05, (now - last.t) / 1000);
        const d = Math.hypot(pose.eye[0] - last.eye[0], pose.eye[1] - last.eye[1], pose.eye[2] - last.eye[2]);
        const dy = ((pose.yaw - last.yaw + 540) % 360) - 180;
        motion.speed = motion.speed * 0.4 + 0.6 * (d / dt);
        motion.turn = motion.turn * 0.4 + 0.6 * (dy / dt);
      }
      last = { t: now, eye: pose.eye.slice(), yaw: pose.yaw };
      // the glass: almost closed at the desk; at the window spot it opens, and more as the view is zoomed toward it
      const dz = pose.eye[2] - WINDOW_Z;
      const open = atWindow ? 0.5 + 0.45 * clamp((2.2 - dz) / 1.2, 0, 1) : 0.12 * clamp((2.75 - dz) / 1.9, 0, 1);
      const spot = n.spot;
      const reading = spot === "notebook" || spot === "laptop" || spot === "print" || n.reader?.state === "open";
      const duck = n.eggObj?.state === "playing" ? 1 : 0;
      return { bearing: axis - pose.yaw, open, width: atWindow ? 1 : 0.8, speed: motion.speed, turn: motion.turn, reading, duck };
    },
    // where a room object sits in the stereo field from the camera (its box's centre on screen)
    place(name) {
      const n = nav(), o = n?.room?.objects?.[OBJ[name] || name];
      if (!n || !o?.box) return 0;
      const c = [0, 1, 2].map((i) => (o.box[0][i] + o.box[1][i]) / 2);
      const [w, h] = n.size ? n.size() : [innerWidth, innerHeight];
      const s = project(n.rig.pose, c, w, h);
      if (!s) return clamp(c[0] - n.rig.pose.eye[0], -1, 1) * 0.8;
      return clamp((s[0] / w - 0.5) * 1.6, -0.9, 0.9);
    },
    dispose() {
      document.removeEventListener("sky:moment", onMoment);
      for (const f of offs) { try { f(); } catch { /* */ } }
      offs.length = 0;
    },
  };
}
