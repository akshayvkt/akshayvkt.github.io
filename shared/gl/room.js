// The room model on the GPU: one room material per (glTF material, atlas), the light-map atlases and their layers,
// the region and object IDs (docs/v3/engine-api.md section 8), and the three ways the room is drawn: live,
// depth pre-pass, and added into the refining sum.
import * as THREE from "three";
import { alphaCut, atlasUniforms, DEFAULT_TEXTURES, idMaterial, roomMaterial } from "./material.js";
import { dataTexture, fetchBitmap, within } from "./loader.js";

export const REGIONS = ["none", "desk_top", "desk_body", "desk_objects", "books", "shelves", "window", "walls", "floor", "ceiling", "lamp", "furniture"];
export const OBJECTS = { none: 0, desk: 1, lamp: 2, laptop: 3, screen: 4, notebook: 5, shelf: 6, window: 7, print: 8, cup: 9, plant: 10, vase: 11, pen: 12, room: 13,
  chair: 14, floor_lamp: 15, side_table: 16, credenza: 17, painting: 18, floor_plant: 19, rug: 20 };

/** Region and object names from room3d.json (R1's export), when the asset set has one; the built-in lists otherwise. */
export function useIdTables(room3d) {
  if (!room3d) return;
  if (room3d.regions) for (const [name, id] of Object.entries(room3d.regions)) REGIONS[id] = name;
  if (room3d.ids) for (const [name, id] of Object.entries(room3d.ids)) OBJECTS[name] = id;
}

/**
 * The laptop screen as a lit rectangle (world space), for the reflections of glossy things right next to it that the
 * probes can't see (the aluminium deck, plan 2.4's "screen glow"): centre, unit axes with half-extents, front normal,
 * and the emitted radiance (the material's emission x the page's mean colour in screen_base.jpg, 0.97).
 */
function screenRect({ mesh, emissive }, towards = null) {
  const pos = mesh.geometry.attributes.position, nrm = mesh.geometry.attributes.normal;
  if (!pos || !nrm) return null;
  mesh.updateWorldMatrix(true, false);
  const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const c = new THREE.Vector3(), n = new THREE.Vector3(), v = new THREE.Vector3(), pts = [];
  for (let i = 0; i < pos.count; i++) {
    pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).clone());
    c.add(pts[i]);
    n.add(v.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize());
  }
  c.divideScalar(pos.count);
  n.normalize();
  if (towards && n.dot(v.subVectors(towards, c)) < 0) n.negate();
  const u = new THREE.Vector3(0, 1, 0).cross(n).normalize();
  const w = new THREE.Vector3().crossVectors(n, u).normalize();
  let hu = 0, hw = 0;
  for (const p of pts) { v.subVectors(p, c); hu = Math.max(hu, Math.abs(v.dot(u))); hw = Math.max(hw, Math.abs(v.dot(w))); }
  return { centre: c.toArray(), u: [...u.toArray(), hu], v: [...w.toArray(), hw], normal: n.toArray(),
    radiance: [emissive.r * 0.97, emissive.g * 0.97, emissive.b * 0.97] };
}

/**
 * The laptop's lid around the screen (e1-v1.11), in the screen rectangle's own frame: [x0, x1, y0, y1] along its u and v
 * axes from its centre, from the laptop's vertices whose normal faces the way the screen does and that lie on the screen's
 * plane (within 15 mm): the bezel, the chin down to the hinge. A glossy surface's ray that meets the lid's front there
 * hits the lid, not what the probes see behind it (the window): the deck and the keys at a grazing view. Null without
 * enough of them (an older model, no laptop).
 */
function lidRect(sr, verts) {
  if (!sr || !verts || !verts.length) return null;
  const c = new THREE.Vector3().fromArray(sr.centre), n = new THREE.Vector3().fromArray(sr.normal);
  const u = new THREE.Vector3().fromArray(sr.u), w = new THREE.Vector3().fromArray(sr.v), d = new THREE.Vector3();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, k = 0;
  for (const [p, q] of verts) {
    if (q.dot(n) < 0.9) continue;
    d.subVectors(p, c);
    if (Math.abs(d.dot(n)) > 0.015) continue;
    const x = d.dot(u), y = d.dot(w);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); k++;
  }
  // the lid holds the screen: anything smaller is not the lid
  if (k < 20 || x0 > -sr.u[3] || x1 < sr.u[3] || y0 > -sr.v[3] || y1 < sr.v[3]) return null;
  return [x0, x1, y0, y1].map((t) => +t.toFixed(5));
}

export function objectId(name) {
  if (!name) return 0;
  const m = /^book:(\d+)$/.exec(name);
  if (m) return 256 + Math.min(255, +m[1]);
  return OBJECTS[name] ?? 0;
}
export function objectName(id) {
  if (id >= 256) return `book:${id - 256}`;
  return Object.keys(OBJECTS).find((k) => OBJECTS[k] === id) || null;
}

// name patterns for models without extras.sfw (the spike); the same table as scripts/engine/placeholder_uv.py
const TAGS = [
  [/^DeskTop/, "desk_top", "desk"], [/^Desk(Apron|Leg)/, "desk_body", "desk"],
  [/^ScreenPanel/, "desk_objects", "screen"],
  [/^(LaptopBase|Lid|Hinge|Keycaps|KeyWell|Trackpad|BezelPlate)/, "desk_objects", "laptop"],
  [/^Notebook/, "desk_objects", "notebook"], [/^Pen/, "desk_objects", "pen"],
  [/^tea_set/, "desk_objects", "cup"], [/^potted_plant/, "desk_objects", "plant"], [/^ceramic_vase/, "desk_objects", "vase"],
  [/^(FrameBot|FrameL\.001|FrameR\.001|FrameTop|Mat|Print)$/, "desk_objects", "print"],
  [/^geo_/, "lamp", "lamp"], [/^Book(\d+)$/, "books", "book:$1"], [/^ShelfBoard/, "shelves", "shelf"],
  [/^(Frame[BLRT]|Mullion|Transom|SillBoard|WallSill|WallHead|WallL|WallR)/, "window", "window"],
  [/^(Back|SideL|SideR|Baseboard)/, "walls", "room"], [/^Floor/, "floor", "room"], [/^Ceiling/, "ceiling", "room"],
];

function tagOf(obj) {
  for (let o = obj; o; o = o.parent) {
    if (o.userData && o.userData.sfw) {
      // R1's joined meshes: ids ride per vertex in COLOR_0 (object = R + 256 G, region = B, 8-bit exact)
      const vertexIds = !!obj.geometry?.attributes?.color;
      return { region: "walls", object: "room", atlas: "room", ...o.userData.sfw, vertexIds };
    }
  }
  for (let o = obj; o; o = o.parent) {
    const name = o.name || "";
    for (const [re, region, object] of TAGS) {
      const m = re.exec(name);
      if (m) return { region, object: object.replace("$1", m[1] || ""), atlas: "room" };
    }
  }
  return { region: "walls", object: "room", atlas: "room" };
}

const DEFAULT_WINDOW = [[-1.1, 0.82, -1.2], [1.1, 0.82, -1.2], [1.1, 2.55, -1.2], [-1.1, 2.55, -1.2]];

export class Room {
  constructor(renderer, shared) {
    this.renderer = renderer;
    this.shared = shared;
    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;
    this.materials = [];
    this.meshes = [];
    this.atlases = new Map();          // name -> uniforms
    this.layerCache = new Map();       // url -> Promise<texture>
    this.window = { corners: DEFAULT_WINDOW.map((p) => new THREE.Vector3(...p)) };
    this.mode = null;
    this.idScene = null;
    this.boundsById = new Map();       // object id -> Box3 (room-local), from per-vertex ids
    this.laptopVerts = [];             // the laptop's [position, normal] (world), for its lid (lidRect)
    this.regionOf = new Map();         // object id -> region id
  }

  /** Per-object bounds and regions from a joined mesh's COLOR_0 ids. */
  _indexVertexIds(mesh) {
    const g = mesh.geometry, col = g.attributes.color, pos = g.attributes.position, nrm = g.attributes.normal;
    mesh.updateWorldMatrix(true, false);
    const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const v = new THREE.Vector3();
    for (let i = 0; i < col.count; i++) {
      const obj = Math.round(col.getX(i) * 255) + 256 * Math.round(col.getY(i) * 255);
      const reg = Math.round(col.getZ(i) * 255);
      let b = this.boundsById.get(obj);
      if (!b) { b = new THREE.Box3(); this.boundsById.set(obj, b); this.regionOf.set(obj, reg); }
      b.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
      if (obj === OBJECTS.laptop && nrm) this.laptopVerts.push([v.clone(), new THREE.Vector3().fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize()]);
    }
  }

  atlas(name) {
    if (!this.atlases.has(name)) this.atlases.set(name, atlasUniforms());
    return this.atlases.get(name);
  }

  /** Build the room from a parsed glTF. `bake` is bake.json; `cubeUV` the probe defines. */
  build(gltf, bake, cubeUV) {
    const root = gltf.scene;
    if (bake.model_space === "spike-world" && bake.model_root) {
      // the spike was exported in world space: undo the room root's transform
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(new THREE.Matrix4().fromArray(bake.model_root).invert());
      holder.add(root);
      this.scene.add(holder);
    } else this.scene.add(root);
    if (bake.window) this.window.corners = bake.window.map((p) => new THREE.Vector3(...p));
    this.info = bake.info || null;      // { heading_deg, eye: [lat, lon, alt_m] } from room3d.json, for X1
    this.scene.updateMatrixWorld(true);

    const cache = new Map();
    const ids = new Map();
    root.traverse((o) => {
      if (!o.isMesh) return;
      const tag = tagOf(o);
      const regionId = Math.max(0, REGIONS.indexOf(tag.region));
      const objId = objectId(tag.object);
      const lightmapped = !!o.geometry.attributes.uv1;
      const cls = o.material?.userData?.sfw?.class;
      const screen = tag.object === "screen" || cls === "screen";
      const src = o.material;
      const key = `${src.uuid}|${tag.atlas}|${lightmapped}|${screen}`;
      let m = cache.get(key);
      if (!m) {
        m = roomMaterial(src, this.shared, this.atlas(tag.atlas), { lightmapped, screen, cubeUV });
        cache.set(key, m);
        this.materials.push(m);
      }
      const cut = alphaCut(src) > 0;
      const idKey = (tag.vertexIds ? "v|" : `${regionId}|${objId}|`) + (cut ? src.uuid : "");
      let im = ids.get(idKey);
      if (!im) { im = idMaterial(regionId, objId, cut ? src : null, { vertexIds: tag.vertexIds }); ids.set(idKey, im); }
      if (tag.vertexIds) this._indexVertexIds(o);
      o.material = m;
      o.userData.roomMaterial = m;
      o.userData.idMaterial = im;
      o.userData.tag = { ...tag, regionId, objectId: objId };
      o.castShadow = o.receiveShadow = false;
      if (screen && src.emissive && !this.screenMesh) this.screenMesh = { mesh: o, emissive: src.emissive.clone().multiplyScalar(src.emissiveIntensity ?? 1) };
      this.meshes.push(o);
      if (src.dispose) src.dispose();
    });
    this.idMaterials = [...ids.values()];
    // the front faces the laptop's keyboard (the mesh's own normals may face the lid)
    const deck = this.boundsById.get(OBJECTS.laptop);
    this.screenRect = this.screenMesh ? screenRect(this.screenMesh, deck ? deck.getCenter(new THREE.Vector3()) : null) : null;
    if (this.screenRect) this.screenRect.lid = lidRect(this.screenRect, this.laptopVerts);
    this.laptopVerts = [];
    this.setMode("live");
    return this;
  }

  /** Load and bind one light layer for every atlas it covers: { atlasName: { file, scale } }. */
  async bindLayer(bakeUrl, which, spec) {
    const key = { ambient: ["uAmbient", "uAmbientScale"], sun: ["uSun", "uSunScale"], lamp: ["uLamp", "uLampScale"], screen: ["uScreen", "uScreenScale"] }[which];
    const jobs = [];
    for (const [name, u] of this.atlases) {
      const e = spec ? spec[name] : null;
      if (!e) {
        u[key[0]].value = DEFAULT_TEXTURES.black;
        u[key[1]].value.set(0, 0, 0);
        continue;
      }
      jobs.push(this.layerTexture(within(bakeUrl, e.file)).then((t) => {
        u[key[0]].value = t;
        u[key[1]].value.fromArray(e.scale);
      }));
    }
    await Promise.all(jobs);
  }

  layerTexture(url) {
    if (!this.layerCache.has(url)) {
      this.layerCache.set(url, fetchBitmap(url).then((b) => dataTexture(b, { name: url.split("/").slice(-2).join("/") })));
    }
    return this.layerCache.get(url);
  }

  /** live | prepass | add — the render state every room material is drawn with. */
  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    for (const m of this.materials) {
      if (mode === "live") {
        m.colorWrite = true; m.depthWrite = true; m.depthTest = true; m.depthFunc = THREE.LessEqualDepth;
        m.blending = THREE.NoBlending;
      } else if (mode === "prepass") {
        m.colorWrite = false; m.depthWrite = true; m.depthTest = true; m.depthFunc = THREE.LessEqualDepth;
        m.blending = THREE.NoBlending;
      } else {
        m.colorWrite = true; m.depthWrite = false; m.depthTest = true; m.depthFunc = THREE.EqualDepth;
        m.blending = THREE.CustomBlending;
        m.blendEquation = m.blendEquationAlpha = THREE.AddEquation;
        m.blendSrc = m.blendDst = m.blendSrcAlpha = m.blendDstAlpha = THREE.OneFactor;
      }
    }
  }

  /** Draw the room into `target` (bound by the caller) with `camera`, in the current mode. */
  draw(camera) {
    this.renderer.render(this.scene, camera);
  }

  /** Draw region and object IDs (RGBA8: R region, G object low byte, B object high byte, A 1 on room surfaces). */
  drawIds(camera) {
    for (const o of this.meshes) o.material = o.userData.idMaterial;
    this.renderer.render(this.scene, camera);
    for (const o of this.meshes) o.material = o.userData.roomMaterial;
  }

  objectBounds(name) {
    const box = new THREE.Box3();
    if (this.boundsById.size) {
      const id = objectId(name);
      for (const [oid, b] of this.boundsById) {
        if (oid === id || (name === "books" && oid >= 256) || (name === "laptop" && oid === OBJECTS.screen)) box.union(b);
      }
    }
    for (const o of this.meshes) if (!o.userData.tag.vertexIds && (o.userData.tag.object === name || (name === "books" && o.userData.tag.region === "books"))) box.expandByObject(o);
    if (box.isEmpty()) return null;
    return { min: box.min.toArray(), max: box.max.toArray(), center: box.getCenter(new THREE.Vector3()).toArray() };
  }

  /** The window opening's bounding box on screen, in device pixels with a GL (bottom-left) origin. */
  windowRect(camera, width, height) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const v = new THREE.Vector3();
    const pts = [];
    for (const c of this.window.corners) { pts.push(c); pts.push(new THREE.Vector3(c.x, c.y, -1.45)); }
    for (const p of pts) {
      v.copy(p).applyMatrix4(camera.matrixWorldInverse);
      if (v.z > -camera.near) return [0, 0, width, height];    // a corner behind the eye: just use the whole frame
      v.applyMatrix4(camera.projectionMatrix);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    const px = (t) => Math.floor((t * 0.5 + 0.5) * width), py = (t) => Math.floor((t * 0.5 + 0.5) * height);
    const ax = Math.max(0, px(x0) - 2), ay = Math.max(0, py(y0) - 2);
    const bx = Math.min(width, px(x1) + 3), by = Math.min(height, py(y1) + 3);
    return bx <= ax || by <= ay ? [0, 0, 0, 0] : [ax, ay, bx - ax, by - ay];
  }

  stats() {
    let tris = 0, draws = 0;
    for (const o of this.meshes) {
      draws++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
    return { meshes: this.meshes.length, materials: this.materials.length, triangles: tris, drawCalls: draws };
  }

  dispose() {
    for (const m of this.materials) m.dispose();
    for (const m of this.idMaterials || []) m.dispose();
    for (const o of this.meshes) o.geometry.dispose();
    for (const p of this.layerCache.values()) p.then((t) => t.dispose());
  }
}
