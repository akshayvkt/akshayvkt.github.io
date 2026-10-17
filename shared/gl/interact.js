// Things in the room you can use (stream I; plan_v2 section 5, phase 1): the desk lamp switch, pulling a book out
// of the shelf, and the tea steam (steam.js). Pointer and touch only, no words: the lamp switch has no accessible
// name (Akshay, 2026-10-15), and a book's card is opened by the navigation stream through the "book" event.
// Reduced motion: every change is instant, and there is no steam.
//
//   const interact = createInteractions(engine, { canvas });   // after engine.loadRoom(), before engine.warmUp()
//   interact.on("book", ({ index, object }) => openBookCard(index));   // a click or tap on a spine (books active)
//   interact.on("lamp", ({ on }) => {});                       // the lamp was switched by the visitor
//   interact.on("hover", ({ object }) => {});                  // what the pointer is over ("lamp", "book:12", null)
//   interact.setBooksActive(true | false | "auto");           // N: true at the shelf spot (default "auto")
//   interact.pullBook(index, level)                            // N's keyboard focus: level 1 (1.5 cm) or 2 (5 cm)
//   interact.releaseBook()                                     // the card closed: the book slides home
//   interact.toggleLamp() / interact.lampChoice                // the visitor's choice, until the next moment change
//
// How the book moves: R1's joined meshes carry each book's id per vertex (COLOR_0), so the room's vertex shader
// offsets the chosen book (and the ID pass moves it too, so picking still finds it). Its own light map travels with
// it. Its newly visible sides, black in the bake, take the spine's own light (no direct sun), fading with depth into
// the slot, and the shelf board and the neighbouring spines get a small live contact shadow. The shader code is
// added to E1's room material by string (anchors listed at PATCH below) rather than by editing material.js.
import { createSteam } from "./steam.js";

const HOVER_M = 0.015;       // plan 5: hover or focus slides the spine out 1.5 cm
const OPEN_M = 0.05;         // a click slides it out 5 cm and opens the card
const SLIDE_MS = 130;        // under 150 ms (plan 12, row I)
const LAMP_FADE_MS = 200;    // plan 1.2: about 200 ms, through the engine's frozen-frame fade
const CLICK_PX = 6;          // a press that moves less than this is a click or tap, not an orbit drag
const BOOK_BASE = 256;

// ------------------------------------------------------------------ the shader additions (PATCH)
// Anchors in material.js (E1): "void main()" in the room and ID vertex shaders and the room fragment shader, and
// "Lb *= detail;" in the room fragment shader (after the baked layers are summed). Missing anchors leave the
// room as it is and log a warning (the book still moves if the vertex anchor is there).
const VS_BLOCK = (room) => /* glsl */ `
// ---- stream I (interact.js): a pulled book's offset, by the book id in COLOR_0
#ifndef VERTEX_IDS
in vec4 color;
#endif
uniform vec4 uSfwPull[2];     // per slot: x the book's object id (0: none), yzw its offset (room metres)
uniform vec4 uSfwSpine[2];    // per slot: xy the spine's light-map uv, z the spine plane (along the shelf normal), w the pull (m)
uniform vec3 uSfwFront;       // the shelf's outward normal (the spines face it)
${room ? "out vec3 vSfwBook;          // x: 1 on the pulled book's side faces, y: depth behind its spine (m), z: slot (-1: none)" : ""}
vec3 sfwPos() {
  vec3 c = floor(color.rgb * 255.0 + 0.5);
  float id = c.r + 256.0 * c.g;
  vec3 p = position;
  ${room ? "vSfwBook = vec3(0.0, 0.0, -1.0);" : ""}
  for (int i = 0; i < 2; i++) {
    if (uSfwPull[i].x > 0.5 && abs(id - uSfwPull[i].x) < 0.5) {
      p += inverse(mat3(modelMatrix)) * uSfwPull[i].yzw;
      ${room ? `vec3 n = normalize(mat3(modelMatrix) * normal);
      vec3 w = (modelMatrix * vec4(position, 1.0)).xyz;
      float side = abs(dot(n, uSfwFront)) < 0.35 && abs(n.y) < 0.7 ? 1.0 : 0.0;
      vSfwBook = vec3(side, uSfwSpine[i].z - dot(w, uSfwFront), float(i));` : ""}
    }
  }
  return p;
}
#define position sfwPos()
`;

const FS_BLOCK = /* glsl */ `
// ---- stream I (interact.js): a pulled book's lit sides and its contact shadows
in vec3 vSfwBook;
uniform vec4 uSfwPull[2];
uniform vec4 uSfwSpine[2];
uniform vec4 uSfwBoxMin[2];   // per slot: the part of the book that now sticks out (room metres); w unused
uniform vec4 uSfwBoxMax[2];   // ... w: the contact shadow's strength (0: none)
vec3 sfwBook(vec3 Lb, vec3 P, vec3 Ng) {
  int own = int(floor(vSfwBook.z + 0.5));
  if (own >= 0 && vSfwBook.x > 0.01) {
    // a side the bake saw in the dark of the slot: the spine's own light, without the direct sun
    vec2 st = own == 0 ? uSfwSpine[0].xy : uSfwSpine[1].xy;
    float pull = own == 0 ? uSfwSpine[0].w : uSfwSpine[1].w;
    // (one plain tap per layer: the spine's light is smooth, and the B-spline taps would triple this code)
    vec3 ls = uLayerW.x * decode(texture(uAmbient, st).rgb, uAmbientScale) + uLayerW.z * decode(texture(uLamp, st).rgb, uLampScale)
            + uLayerW.w * decode(texture(uScreen, st).rgb, uScreenScale);
    float w = vSfwBook.x * (1.0 - smoothstep(pull * 0.75, pull + 0.006, vSfwBook.y));
    Lb = max(Lb, ls * 0.6 * w);
  }
  for (int i = 0; i < 2; i++) {
    vec4 bmin = i == 0 ? uSfwBoxMin[0] : uSfwBoxMin[1];
    vec4 bmax = i == 0 ? uSfwBoxMax[0] : uSfwBoxMax[1];
    if (bmax.w <= 0.0 || own == i) continue;
    vec3 q = max(max(bmin.xyz - P, P - bmax.xyz), 0.0);
    float d = length(q);
    vec3 toBox = clamp(P, bmin.xyz, bmax.xyz) - P;
    float facing = d > 1e-4 ? 0.5 + 0.5 * dot(Ng, toBox / d) : 1.0;
    Lb *= 1.0 - bmax.w * 0.7 * facing * exp(-d / 0.007);
  }
  return Lb;
}
`;

function insertBefore(src, anchor, text) {
  const i = src.lastIndexOf(anchor);
  return i < 0 ? null : src.slice(0, i) + text + src.slice(i);
}

/** Add the book shader code to every room and ID material (before they compile). Returns what was patched. */
function patchShaders(room, U) {
  const report = { room: 0, id: 0, sides: 0, missing: [] };
  const add = (m, room) => {
    if (m.userData.sfwInteract) return;
    const vs = insertBefore(m.vertexShader, "void main()", VS_BLOCK(room));
    if (!vs) { report.missing.push(`${m.name}: vertex "void main()"`); return; }
    let fs = m.fragmentShader;
    if (room) {
      const anchor = "Lb *= detail;";
      const f1 = fs.includes(anchor) ? insertBefore(fs, "void main()", FS_BLOCK) : null;
      if (f1) { fs = f1.replace(anchor, `${anchor}\n    Lb = sfwBook(Lb, P, Ng);   // stream I`); report.sides++; }
      else {
        report.missing.push(`${m.name}: fragment "${anchor}"`);
        fs = insertBefore(fs, "void main()", "in vec3 vSfwBook;\n");   // the vertex shader's output still needs a match
      }
    }
    m.vertexShader = vs;
    m.fragmentShader = fs;
    Object.assign(m.uniforms, U);
    m.userData.sfwInteract = true;
    m.needsUpdate = true;
    report[room ? "room" : "id"]++;
  };
  for (const m of room.materials) add(m, true);
  for (const m of room.idMaterials || []) add(m, false);
  if (report.missing.length) console.warn("[interact] shader anchors missing:", report.missing);
  return report;
}

/**
 * Each book's box, spine plane and a light-map uv on its spine, from the joined meshes' per-vertex ids. The uv is
 * the centre of the book's largest front-facing triangle in its spine plane: a hardcover's front is several charts
 * (the boards' edges, the rounded spine's facets, the page block hidden behind them), so an average of its vertices
 * can land between charts, on another face's light.
 */
function indexBooks(engine, front) {
  const { THREE } = engine;
  const books = new Map();
  const v = new THREE.Vector3(), a = new THREE.Vector3(), b3 = new THREE.Vector3(), c3 = new THREE.Vector3(), nf = new THREE.Vector3();
  for (const o of engine.room.meshes) {
    const g = o.geometry, col = g.attributes.color, pos = g.attributes.position, uv1 = g.attributes.uv1;
    if (!col || !uv1) continue;
    o.updateWorldMatrix(true, false);
    const idOf = (i) => Math.round(col.getX(i) * 255) + 256 * Math.round(col.getY(i) * 255);
    for (let i = 0; i < col.count; i++) {
      const id = idOf(i);
      if (id < BOOK_BASE) continue;
      let b = books.get(id);
      if (!b) { b = { id, index: id - BOOK_BASE, box: new THREE.Box3(), spine: -Infinity, uv: [0, 0], area: 0 }; books.set(id, b); }
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      b.box.expandByPoint(v);
      b.spine = Math.max(b.spine, v.dot(front));
    }
    const idx = g.index, nTri = (idx ? idx.count : pos.count) / 3;
    for (let t = 0; t < nTri; t++) {
      const i0 = idx ? idx.getX(3 * t) : 3 * t, i1 = idx ? idx.getX(3 * t + 1) : 3 * t + 1, i2 = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
      const id = idOf(i0);
      if (id < BOOK_BASE) continue;
      const bk = books.get(id);
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
      b3.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
      c3.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
      nf.subVectors(b3, a).cross(v.subVectors(c3, a));
      const area = nf.length() / 2;
      // in the spine plane (a hardcover's page block also faces out, hidden 5-10 mm behind its rounded spine)
      const depth = bk.spine - (a.dot(front) + b3.dot(front) + c3.dot(front)) / 3;
      if (area <= bk.area || depth > 0.003 || nf.normalize().dot(front) < 0.9) continue;
      bk.area = area;
      bk.uv = [(uv1.getX(i0) + uv1.getX(i1) + uv1.getX(i2)) / 3, (uv1.getY(i0) + uv1.getY(i1) + uv1.getY(i2)) / 3];
    }
  }
  return books;
}

/** The shelf's outward normal: room3d.json's shelf_front quad, turned toward the room; +z without it. */
function shelfFront(engine) {
  const { THREE } = engine;
  const q = engine.room3d?.objects?.shelf_front?.quad;
  if (!q) return new THREE.Vector3(0, 0, 1);
  const [a, b, c] = q.map((p) => new THREE.Vector3(...p));
  const nrm = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
  const centre = new THREE.Vector3().addVectors(a, c).multiplyScalar(0.5);
  if (nrm.dot(new THREE.Vector3(0, 1.2, 1).sub(centre)) < 0) nrm.negate();
  return nrm;
}

const easeOut = (x) => 1 - (1 - x) ** 3;

export function createInteractions(engine, { canvas, books: booksMode = "auto", cursor = true, steam = true } = {}) {
  const { THREE } = engine;
  const listeners = new Map();
  const emit = (name, e) => { for (const fn of listeners.get(name) || []) { try { fn(e); } catch (err) { console.error(err); } } };
  const reduced = () => !!engine.settings.reducedMotion;

  // ---------------------------------------------------------------- the book shader state (two slots: one going out
  // while the last one slides home)
  const front = shelfFront(engine);
  const U = {
    uSfwPull: { value: [new THREE.Vector4(), new THREE.Vector4()] },
    uSfwSpine: { value: [new THREE.Vector4(), new THREE.Vector4()] },
    uSfwBoxMin: { value: [new THREE.Vector4(), new THREE.Vector4()] },
    uSfwBoxMax: { value: [new THREE.Vector4(), new THREE.Vector4()] },
    uSfwFront: { value: front.clone() },
  };
  const patched = patchShaders(engine.room, U);
  const bookInfo = indexBooks(engine, front);
  const slots = [0, 1].map(() => ({ book: null, cur: 0, from: 0, to: 0, t0: 0, ms: 0 }));

  const writeSlot = (i) => {
    const s = slots[i], b = s.book;
    const pull = U.uSfwPull.value[i], sp = U.uSfwSpine.value[i], bmin = U.uSfwBoxMin.value[i], bmax = U.uSfwBoxMax.value[i];
    if (!b || s.cur <= 1e-5) { pull.set(0, 0, 0, 0); sp.set(0, 0, 0, 0); bmax.w = 0; return; }
    pull.set(b.id, front.x * s.cur, front.y * s.cur, front.z * s.cur);
    sp.set(b.uv[0], b.uv[1], b.spine, s.cur);
    // the part that now sticks out (axis-aligned shelf: the box clipped at the old spine plane)
    const lo = b.box.min.clone().addScaledVector(front, s.cur), hi = b.box.max.clone().addScaledVector(front, s.cur);
    for (const ax of ["x", "y", "z"]) {
      if (Math.abs(front[ax]) > 0.9) {
        if (front[ax] > 0) lo[ax] = Math.max(lo[ax], b.box.max[ax]);
        else hi[ax] = Math.min(hi[ax], b.box.min[ax]);
      }
    }
    bmin.set(lo.x, lo.y, lo.z, 0);
    bmax.set(hi.x, hi.y, hi.z, Math.min(1, s.cur / 0.01));
  };

  /** Slide `book` (or none) to `dist` metres; every other book slides home. */
  const slide = (book, dist) => {
    const go = (s, to) => {
      if (Math.abs(s.to - to) < 1e-6 && (s.cur === to || s.ms)) return;
      // t0 is set by the next frame's update, a frame's worth early, so the slide shows on that very frame
      s.from = s.cur; s.to = to; s.t0 = null; s.ms = reduced() ? 0 : SLIDE_MS * Math.min(1, 0.45 + Math.abs(to - s.cur) / OPEN_M);
    };
    let mine = book ? slots.find((s) => s.book === book) : null;
    for (const s of slots) if (s !== mine && s.book) go(s, 0);
    if (book && !mine) {
      mine = slots.find((s) => !s.book || (s.cur === 0 && s.to === 0)) ||
        slots.reduce((a, s) => (s.cur < a.cur ? s : a));          // both busy: the one nearest home snaps back
      if (mine.book && mine.book !== book) { mine.cur = 0; }
      mine.book = book; mine.cur = 0; mine.from = 0; mine.to = 0; mine.ms = 0;
    }
    if (mine) go(mine, dist);
    engine.requestFrame();
  };

  let animatingNow = false;
  const pass = engine.addPass({
    name: "interact", stage: "prepare", order: -10,
    update(frame) {
      let moved = false;
      animatingNow = false;
      slots.forEach((s, i) => {
        if (!s.book) return;
        if (s.t0 === null) s.t0 = frame.time - Math.min(frame.dt, 17);
        const x = s.ms > 0 ? Math.min(1, (frame.time - s.t0) / s.ms) : 1;
        const cur = s.from + (s.to - s.from) * easeOut(Math.max(0, x));
        if (cur !== s.cur) { moved = true; s.cur = cur; }
        if (x < 1) animatingNow = true;
        else s.ms = 0;
        writeSlot(i);
        if (x >= 1 && s.to === 0) s.book = null;   // home: the slot is free
      });
      if (moved) engine.invalidate("book pulled");
    },
    animating() { return animatingNow || slots.some((s) => s.ms > 0); },
  });

  // ---------------------------------------------------------------- what is active
  let booksActive = booksMode;          // true | false | "auto"
  const shelfBox = engine.room3d?.objects?.shelf?.box;
  const booksOn = () => {
    if (booksActive !== "auto") return !!booksActive;
    if (!shelfBox) return false;
    // auto: the camera looks at the shelf (within 15 degrees of its centre): the shelf spot, not the desk view
    const cam = engine.camera.get();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().fromArray(cam.quaternion));
    const c = new THREE.Vector3().fromArray(shelfBox[0]).add(new THREE.Vector3().fromArray(shelfBox[1])).multiplyScalar(0.5);
    const to = c.sub(new THREE.Vector3().fromArray(cam.position)).normalize();
    return fwd.dot(to) > Math.cos((15 * Math.PI) / 180);
  };

  // ---------------------------------------------------------------- the lamp
  let lampChoice = null;                // the visitor's choice (0 / 1) until the next moment change
  let lampQueue = Promise.resolve();
  const setLamp = (on) => {
    lampChoice = on ? 1 : 0;
    lampQueue = lampQueue.then(() => engine.setLight({ lamp: lampChoice }, { fade: reduced() ? 0 : LAMP_FADE_MS })).catch((e) => console.error(e));
    emit("lamp", { on: !!on });
    return lampQueue;
  };
  // plan 13 default: the choice lasts until the next moment change (the engine then applies the moment's lamp_default)
  let lastMoment = engine.light.moment;
  const offLight = engine.on("lightchange", ({ light }) => {
    if (light.moment !== lastMoment) { lastMoment = light.moment; lampChoice = null; }
  });

  // ---------------------------------------------------------------- pointer and touch
  let hover = null, press = null, pending = null, picking = false, inside = false;
  const setHover = (obj) => {
    if (obj === hover) return;
    hover = obj;
    if (cursor) canvas.style.cursor = obj ? "pointer" : "";
    emit("hover", { object: obj });
  };
  const target = (hit) => {
    if (!hit) return null;
    if (hit.object === "lamp") return "lamp";
    if (hit.objectId >= BOOK_BASE && bookInfo.has(hit.objectId) && booksOn()) return hit.object;
    return null;
  };
  const bookOf = (name) => bookInfo.get(BOOK_BASE + +name.slice(5)) || null;
  const pickAt = async (x, y) => target(await engine.pick(x, y));
  const pump = async () => {
    if (picking || !pending) return;
    picking = true;
    const { x, y } = pending;
    pending = null;
    try {
      const obj = inside && !press?.drag ? await pickAt(x, y) : null;
      if (!pending || !inside) {
        setHover(obj);
        const b = obj && obj.startsWith("book:") ? bookOf(obj) : null;
        if (!openBook) slide(b, b ? HOVER_M : 0);
      }
    } finally { picking = false; }
    if (pending) pump();
  };
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  let openBook = null;                  // the book whose card is open (out at 5 cm until releaseBook())
  const onMove = (e) => {
    inside = true;
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_PX) {
      press.drag = true;
      if (!openBook) slide(null, 0);
      setHover(null);
      return;
    }
    if (e.pointerType === "touch") return;   // no hover on touch screens
    pending = local(e);
    pump();
  };
  const onDown = (e) => { if (e.button === 0 || e.pointerType !== "mouse") press = { x: e.clientX, y: e.clientY, t: performance.now(), drag: false }; };
  const onUp = async (e) => {
    const p = press;
    press = null;
    if (!p || p.drag || Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_PX) return;
    const { x, y } = local(e);
    const t0 = performance.now();
    const obj = await pickAt(x, y);
    if (obj === "lamp") {
      setLamp(!(engine.light.lamp > 0));
      lastTiming.lampPickMs = Math.round(performance.now() - t0);
    } else if (obj && obj.startsWith("book:")) {
      const b = bookOf(obj);
      openBook = b;
      slide(b, OPEN_M);
      emit("book", { index: b.index, object: obj, id: b.id });
    }
  };
  const onLeave = () => { inside = false; pending = null; if (!openBook) slide(null, 0); setHover(null); };
  const onCancel = () => { press = null; };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointercancel", onCancel);
  const lastTiming = {};

  // ---------------------------------------------------------------- the steam
  const steamApi = steam ? createSteam(engine) : null;

  // The ID programs (picking, the steam's depth) compile with the room's at warm-up instead of on the first pointer
  // move, where a synchronous compile would be a long task. compileAsync gathers the materials at once.
  const offReady = engine.on("ready", () => {
    offReady();
    const r = engine.room;
    for (const o of r.meshes) o.material = o.userData.idMaterial;
    const jobs = [engine.renderer.compileAsync(r.scene, engine.camera.three)];
    for (const o of r.meshes) o.material = o.userData.roomMaterial;
    if (steamApi) jobs.push(steamApi.compile());
    Promise.all(jobs).catch(() => {});
  });

  return {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name).delete(fn);
    },
    get books() { return [...bookInfo.values()].map((b) => ({ index: b.index, object: `book:${b.index}`, box: [b.box.min.toArray(), b.box.max.toArray()], spine: b.spine, uv: b.uv })); },
    get lampChoice() { return lampChoice; },
    /** Where each pulled book is (QA): [{ index, out (m), to (m) }]. */
    get pulled() { return slots.filter((s) => s.book).map((s) => ({ index: s.book.index, out: s.cur, to: s.to })); },
    get hover() { return hover; },
    get patched() { return { ...patched }; },
    get timing() { return { ...lastTiming }; },
    setBooksActive(v) { booksActive = v; if (!booksOn() && !openBook) slide(null, 0); },
    /** N's keyboard focus on a spine (level 1: 1.5 cm) or its card (level 2: 5 cm); level 0 slides it home. */
    pullBook(index, level = 1) {
      const b = bookInfo.get(BOOK_BASE + index);
      if (!b) return false;
      if (level >= 2) openBook = b;
      slide(level > 0 ? b : null, level >= 2 ? OPEN_M : level > 0 ? HOVER_M : 0);
      return true;
    },
    /** The card closed: the open book slides home (or back to the hover pull if the pointer is still on it). */
    releaseBook() {
      openBook = null;
      const b = hover && hover.startsWith("book:") ? bookOf(hover) : null;
      slide(b, b ? HOVER_M : 0);
    },
    toggleLamp() { return setLamp(!(engine.light.lamp > 0)); },
    steam: steamApi,
    dispose() {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointercancel", onCancel);
      offLight();
      offReady();
      pass.remove();
      steamApi?.dispose();
      for (let i = 0; i < 2; i++) { slots[i].book = null; slots[i].cur = 0; writeSlot(i); }
      engine.invalidate("interactions removed");
    },
  };
}
