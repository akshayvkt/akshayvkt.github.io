// The close-up texture tier (docs/v3/briefs/closeup.md, Akshay's "Option A"): bigger textures for what a visitor
// leans in to, fetched only when they go there. scripts/room_hi.py writes them (tex/hi/, beside the base tier) and
// lists them in room3d.json "hi": per texture the file, the base file it replaces (same UVs: the props atlas at 2x with
// its layout scaled, the tiled maps at their source size), sizes, means; per spot the names it needs (landscape and
// portrait screens), and the desk's list once the wheel has zoomed in past a share of its range.
//
//   engine.hiTier.forSpot("phone", { portrait })    // the router, when a glide to a spot starts (or a cut lands)
//   engine.hiTier.forZoom("desk", { portrait })     // the router, the desk zoomed in
//   engine.hiTier.state()                            // QA: each texture's state, bytes and timings
//   engine.hiTier.hold = true                        // QA: upload, but keep the base until released (before/after)
//
// The path to the GPU: the file is fetched and decoded off the main thread (createImageBitmap, as three's glTF loader
// decodes the base: no premultiplying); three.js allocates the texture (a DataTexture with no data: texStorage2D with
// every mip level, the base's colour space, wrap and filtering, anisotropic); then, inside the engine's own frame (one
// step a frame, before the room is drawn), the pixels go up a strip of rows at a time (WebGL 2 sub-rectangle uploads:
// at most BUDGET bytes a frame), then one mipmap build. A finished texture replaces its base in every room material
// that uses it, only at rest (never mid-move) and with the engine's own cross-fade from a snapshot (setLight's,
// 400 ms; 150 ms with reduced motion), then refining restarts. Kept for the visit; the base stays in memory, so a
// lost context falls back to it and the tier is fetched again (from the HTTP cache) once the context is back.
// (DYS-149: a JPEG's pixels go up from bytes, not from the bitmap: the page fetches the file and hands the Blob to
// hitex-worker.js, which decodes it with the same call and reads it back a band of rows at a time (the same texels);
// each band is uploaded in a frame as before. WebKit converted the whole 6144 walnut on every strip uploaded from its
// bitmap, ~44 ms a frame through the whole notebook glide (EO1, desk1440 J8, longest 171-182 ms); from bytes a 2 MB
// strip is ~0.5-1 ms. No worker, a non-JPEG, or a worker failure: the bitmap on the page, as before.)
import * as THREE from "three";

// bytes of pixels uploaded in one frame, at most: the same caps as the panorama's tiles (perf-r1's pano.js
// UPLOAD_BYTES). `spent` says what this frame took, so the two can share one budget once both are in v3/live.
const BUDGET = { T1: 1e6, T2: 2e6 };
// the largest texture a tier takes: phones (T1) never the 4096 atlas (85 MB with its mips); desktops up to 8192 (round 2:
// the walnut's T2 row is 6144), within the GPU's own MAX_TEXTURE_SIZE
const MAX_SIZE = { T1: 2048, T2: 8192 };
const MEAN_TOL = 2;                             // levels: room_hi.py's own gate, checked again before a swap
const FADE_MS = 400;
const AHEAD = 2;                                // (DYS-149: bands the worker keeps ready for the page's frames)
const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();

/** The anisotropic filtering the room's textures get (8x, phones 4x; ?aniso=<n> to compare, 1 = off). */
export function anisotropyFor(engine) {
  const max = engine.renderer.capabilities.getMaxAnisotropy() || 1;
  const want = params.has("aniso") ? Math.max(1, +params.get("aniso") || 1) : engine.settings.tier === "T1" ? 4 : 8;
  return Math.max(1, Math.min(max, want));
}

/**
 * Before the room's first draw: anisotropic filtering on its mipmapped material maps (three.js sets it when it first
 * uploads them, so this costs no upload), so the tiers swap with the same filtering on both sides.
 */
export function applyAnisotropy(engine) {
  const a = anisotropyFor(engine);
  engine.anisotropy = a;
  if (a <= 1) return a;
  const seen = new Set();
  for (const m of engine.room.materials) {
    for (const k of ["uAlbedoMap", "uRoughMap", "uNormalMap", "uCoatRoughMap", "uEmissiveMap"]) {
      const t = m.uniforms[k]?.value;
      if (!t || !t.isTexture || t.isDataTexture || seen.has(t)) continue;
      seen.add(t);
      if (t.generateMipmaps && t.minFilter !== THREE.LinearFilter && t.minFilter !== THREE.NearestFilter) t.anisotropy = a;
    }
  }
  return a;
}

export class HiTier {
  constructor(engine) {
    this.e = engine;
    this.manifest = null;
    this.baseUrl = null;
    this.items = new Map();     // name -> { name, row, state, tex, bmp, y, ... }
    this.queue = [];            // names with pixels for the GPU, oldest first
    this._hold = false;
    this.wanted = new Set();
    this.lostContext = false;
    this.spent = 0;             // bytes this frame's step uploaded
    // (DYS-149: the decode-and-read-back worker, started with the first JPEG wanted; off for the visit once it fails)
    this.worker = null;
    this.workerOff = typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" ? "no Worker or OffscreenCanvas" : null;
    this.jobs = new Map();      // worker job id -> item
    this.seq = 0;
  }

  /** QA: while on, finished textures wait (uploaded and mipmapped) instead of replacing their base. */
  get hold() { return this._hold; }
  set hold(v) { this._hold = !!v; if (!v) this.e.requestFrame(); }

  /** room3d.json "hi" and the model's URL (the files are relative to its folder). */
  setManifest(hi, modelUrl) {
    this.manifest = hi && hi.version === 1 && hi.textures ? hi : null;
    this.baseUrl = modelUrl;
  }

  /** Frames are needed: pixels waiting for the GPU, or a finished texture waiting to be swapped in. */
  get busy() {
    if (this.lostContext) return false;
    return this.queue.some((n) => { const it = this.items.get(n); return it.state === "ready" ? !this.hold : this._canStep(it); });
  }
  /** (DYS-149) An upload step this texture can take now: a band from the worker in hand (its arrival asks for a frame). */
  _canStep(it) {
    if (it.state === "decoded" || it.state === "mips") return true;
    if (it.state === "uploading") return it.via === "worker" ? it.bands.length > 0 : !!it.bmp;
    return false;
  }

  /** The names a spot (or its zoom) needs on this screen shape, within this device's limits. */
  names(spot, { portrait = false, zoom = false } = {}) {
    const M = this.manifest;
    if (!M || !spot) return [];
    const e = zoom ? M.zoom?.[spot] : M.spots?.[spot];
    const list = (e && (portrait ? e.portrait : e.landscape)) || [];
    return list.filter((n) => !!this.pick(n));
  }
  /**
   * A texture's row for this engine's tier: its `tiers[<tier>]` (round 2: the walnut at 6144 for desktops) when there is
   * one that fits, else the row itself when it fits, else null. Within MAX_SIZE and the GPU's MAX_TEXTURE_SIZE.
   */
  pick(name) {
    const row = this.manifest?.textures?.[name];
    if (!row) return null;
    const tier = this.e.settings.tier;
    const cap = Math.min(MAX_SIZE[tier] || 4096, this.e.renderer.capabilities.maxTextureSize || 4096);
    const fits = (r) => Math.max(...r.size) <= cap;
    const t = row.tiers?.[tier];
    if (t && t.ok !== false && fits(t)) return { ...row, ...t, tier, tiers: undefined };
    return fits(row) ? row : null;
  }
  forSpot(spot, opts) { return this.want(this.names(spot, opts)); }
  forZoom(spot, opts) { return this.want(this.names(spot, { ...opts, zoom: true })); }
  /** The desk's zoom rule: { from } (a share of the wheel's range in), or null. */
  zoomRule(spot) { return this.manifest?.zoom?.[spot] || null; }

  want(names) {
    for (const name of names) {
      this.wanted.add(name);
      if (this.items.has(name) || this.lostContext) continue;
      const row = this.pick(name);
      if (!row) continue;
      const it = { name, row, state: "fetching", t0: performance.now(), bytes: 0 };
      this.items.set(name, it);
      this._fetch(it);
    }
    return names;
  }

  async _fetch(it) {
    try {
      // the export's own record first: a tier that would change the colour is never fetched
      const d = it.row.mean && it.row.base_mean ? Math.max(...it.row.mean.map((v, i) => Math.abs(v - it.row.base_mean[i]))) : 0;
      if (d > MEAN_TOL) throw new Error(`mean colour ${d.toFixed(2)} levels from its base`);
      const url = new URL(it.row.file, this.baseUrl).href;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      it.bytes = blob.size;
      it.tFetched = performance.now();
      if (it.state !== "fetching") return;                          // the context went meanwhile
      // (DYS-149: a JPEG (opaque: its bytes read back exactly) to the worker; its size, then its bands, come to _fromWorker)
      const w = /\.jpe?g$/i.test(it.row.file) ? this._worker() : null;
      if (w) {
        it.via = "worker";
        it.blob = blob;          // (kept until its last band is up: the page decodes it itself if the worker fails)
        it.bands = [];
        it.job = ++this.seq;
        this.jobs.set(it.job, it);
        w.postMessage({ id: it.job, blob, rows: this._rows(it.row.size[0]), ahead: AHEAD });
        return;
      }
      await this._decodeHere(it, blob);
    } catch (err) {
      this._failed(it, err);
    }
  }

  /** The strip's rows: at most this tier's BUDGET bytes, at least 16 rows. */
  _rows(w) { return Math.max(16, Math.floor((BUDGET[this.e.settings.tier] || BUDGET.T2) / (w * 4))); }

  /** The bitmap on the page (as before DYS-149): the upload steps take strips of it from it.y on. */
  async _decodeHere(it, blob) {
    it.via = "page";
    it.bands = null;
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none" });
    if (it.state === "lost" || this.items.get(it.name) !== it) { bmp.close(); return; }   // the context went meanwhile
    if (bmp.width !== it.row.size[0] || bmp.height !== it.row.size[1]) { bmp.close(); throw new Error(`size ${bmp.width}x${bmp.height}`); }
    it.bmp = bmp;
    it.blob = null;
    if (it.state === "fetching") {
      it.tDecoded = performance.now();
      it.state = "decoded";
      this.queue.push(it.name);
    }
    this.e.requestFrame();
  }

  _failed(it, err) {
    it.state = "failed";
    it.why = String(err && err.message || err);
    it.bmp?.close?.();
    it.bmp = null;
    it.blob = null;
    it.bands = null;
    if (it.tex) { it.tex.dispose(); it.tex = null; }
    const i = this.queue.indexOf(it.name);
    if (i >= 0 && this.items.get(it.name) === it) this.queue.splice(i, 1);
    console.warn(`[engine] close-up texture ${it.name}: ${it.why}`);
  }

  /** (DYS-149) The worker, started once; null when there is none (then every texture is decoded on the page). */
  _worker() {
    if (this.worker || this.workerOff) return this.worker;
    try {
      const w = new Worker(new URL("./hitex-worker.js", import.meta.url));
      w.onmessage = ({ data }) => this._fromWorker(data);
      w.onerror = (e) => { e.preventDefault?.(); this._workerDown(`the worker failed${e.message ? ": " + e.message : ""}`); };
      w.onmessageerror = () => this._workerDown("a reply could not be read");
      this.worker = w;
    } catch (e) {
      this._workerDown(String((e && e.message) || e));
    }
    return this.worker;
  }

  /** (DYS-149) The worker is off for the visit: what it still had is decoded on the page and carries on from its row. */
  _workerDown(why) {
    if (!this.workerOff && params.has("debug")) console.info(`[engine] close-up textures decoded on the page (DYS-149): ${why}`);
    this.workerOff = why;
    this.worker?.terminate();
    this.worker = null;
    const left = [...this.jobs.values()];
    this.jobs.clear();
    for (const it of left) {
      const blob = it.blob;
      it.page = why;
      if (blob) this._decodeHere(it, blob).catch((err) => this._failed(it, err));
      else this._failed(it, new Error(why));
    }
  }

  /** (DYS-149) The worker's replies: a texture's size once decoded (it joins the queue), then its bands in order. */
  _fromWorker(data) {
    const it = this.jobs.get(data.id);
    if (!it || it.state === "lost" || this.items.get(it.name) !== it) {
      this.jobs.delete(data.id);
      if (!data.error) this.worker?.postMessage({ id: data.id, cancel: true });
      return;
    }
    if (data.error) { this._workerDown(data.error); return; }
    if (data.size) {
      if (data.size[0] !== it.row.size[0] || data.size[1] !== it.row.size[1]) {
        this.jobs.delete(data.id);
        this.worker?.postMessage({ id: data.id, cancel: true });
        this._failed(it, new Error(`size ${data.size[0]}x${data.size[1]}`));
        return;
      }
      it.tDecoded = performance.now();
      it.state = "decoded";
      this.queue.push(it.name);
    } else it.bands.push(data);
    this.e.requestFrame();
  }

  /** One step a frame, from the engine's frame (before the room is drawn): a finished texture's swap when the room
   * allows it, else the oldest texture's next upload step. */
  step() {
    this.spent = 0;
    if (this.lostContext || !this.queue.length) return;
    const e = this.e, gl = e.gl, r = e.renderer;
    const list = this.queue.map((n) => this.items.get(n));
    const done = list.find((x) => x.state === "ready");
    // only at rest (a snapshot of a moving view would ghost) and not inside another fade (a moment change), and only
    // once the room is drawn at full scale again (qa-landing): a glide's last frames are still drawn at perf-r2's moving
    // scale (mv.active) while the state already says "refining", and the full-size room buffer the snapshot reads still
    // holds the view from before the glide: the desk's whole view faded over the landing at the print, shelf or phone
    if (done && !this.hold && e.state !== "moving" && !e.fade && !e.mv?.active) {
      this._swap(done);
      this.queue.splice(this.queue.indexOf(done.name), 1);
      if (this.queue.length) e.requestFrame();
      return;
    }
    const it = list.find((x) => x.state !== "ready" && this._canStep(x));   // (DYS-149: one waiting on its next band waits)
    if (!it) return;
    if (it.state === "decoded") {
      // three.js allocates the texture (every mip level) with the base's sampling; no pixels yet
      const [w, h] = it.row.size;
      const t = new THREE.DataTexture(null, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.source.dataReady = false;
      t.name = it.row.file;
      t.colorSpace = it.row.colour === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.flipY = false;
      t.unpackAlignment = 4;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = it.row.wrap === "repeat" ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      t.anisotropy = e.anisotropy || 1;
      t.needsUpdate = true;
      r.initTexture(t);
      it.tex = t;
      it.y = 0;
      it.state = "uploading";
    } else if (it.state === "uploading" && it.via === "worker") {
      // (DYS-149) the worker's next band of rows, as bytes, into the same rows of level 0; then one more asked for
      const [w, h] = it.row.size;
      const b = it.bands.shift();
      gl.bindTexture(gl.TEXTURE_2D, r.properties.get(it.tex).__webglTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, b.y, w, b.n, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(b.buf));
      r.resetState();
      it.y = b.y + b.n;
      it.strips = (it.strips || 0) + 1;
      this.spent = b.n * w * 4;
      if (it.y >= h) {
        this.jobs.delete(it.job);
        it.blob = null;
        it.state = "mips";
      } else this.worker?.postMessage({ id: it.job, more: true });
    } else if (it.state === "uploading") {
      const [w, h] = it.row.size;
      const n = Math.min(this._rows(w), h - it.y);
      gl.bindTexture(gl.TEXTURE_2D, r.properties.get(it.tex).__webglTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      try {
        // rows y .. y + n of the decoded image into the same rows of level 0 (the first strip is checked once: a
        // browser without sub-rectangle uploads from an image gets the whole image instead)
        // (DYS-149 review: the page's own strips, counted apart from the worker's: a texture the worker began and the
        // page carries on after the worker failed (it.strips already counts the worker's) is still checked, at its first)
        const first = !it.pageStrips;
        if (first) gl.getError();
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, it.y);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, it.y, w, n, gl.RGBA, gl.UNSIGNED_BYTE, it.bmp);
        if (first) { const g = gl.getError(); if (g !== gl.NO_ERROR) throw new Error(`texSubImage2D sub-rectangle: GL error ${g}`); }
        it.y += n;
        it.strips = (it.strips || 0) + 1;
        it.pageStrips = (it.pageStrips || 0) + 1;
        this.spent = n * w * 4;
      } catch (err) {
        // no sub-rectangle uploads from an image here: the whole image at once (one frame)
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, it.bmp);
        it.y = h;
        it.whole = String(err && err.message || err);
        this.spent = w * h * 4;
      }
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      r.resetState();
      if (it.y >= h) it.state = "mips";
    } else if (it.state === "mips") {
      gl.bindTexture(gl.TEXTURE_2D, r.properties.get(it.tex).__webglTexture);
      gl.generateMipmap(gl.TEXTURE_2D);
      r.resetState();
      it.bmp?.close();
      it.bmp = null;
      it.tUploaded = performance.now();
      it.state = "ready";
    }
  }

  _swap(it) {
    const e = this.e;
    const mats = e.room.materials.filter((m) => m.uniforms.uAlbedoMap?.value?.name === it.row.replaces);
    if (!mats.length) { it.state = "unused"; it.tex.dispose(); it.tex = null; return; }
    if (e.count > 0) {
      e._snapshot();
      e.fade = { start: performance.now(), ms: e.settings.reducedMotion ? Math.min(FADE_MS, 150) : FADE_MS };
    }
    it.prev = mats.map((m) => [m, m.uniforms.uAlbedoMap.value]);
    for (const m of mats) m.uniforms.uAlbedoMap.value = it.tex;
    it.materials = mats.length;
    it.tSwapped = performance.now();
    it.state = "on";
    e.invalidate("close-up texture");
    e.events.emit("hitexture", { name: it.name, file: it.row.file, replaces: it.row.replaces, materials: mats.length });
  }

  /** The context is gone: the base everywhere again, the tier forgotten (the browser keeps the files). */
  lost() {
    this.lostContext = true;
    for (const it of this.items.values()) {
      if (it.prev) for (const [m, base] of it.prev) m.uniforms.uAlbedoMap.value = base;
      it.bmp?.close?.();
      it.tex?.dispose?.();
      if (it.job && this.jobs.has(it.job)) this.worker?.postMessage({ id: it.job, cancel: true });   // (DYS-149)
      it.blob = null;
      it.bands = null;
      it.state = "lost";
    }
    this.items.clear();
    this.jobs.clear();
    this.queue = [];
  }

  /** The context is back: what was wanted is fetched again. */
  restored() {
    this.lostContext = false;
    this.want([...this.wanted].filter((n) => this.manifest?.textures[n]));
  }

  state() {
    const out = {};
    for (const it of this.items.values()) {
      out[it.name] = { state: it.state, file: it.row.file, bytes: it.bytes, size: it.row.size, strips: it.strips || 0, materials: it.materials || 0,
        ...(it.via ? { via: it.via } : {}), ...(it.page ? { page: it.page } : {}),
        ...(it.whole ? { whole: it.whole } : {}), ...(it.why ? { why: it.why } : {}),
        ms: { fetch: it.tFetched ? Math.round(it.tFetched - it.t0) : null, decode: it.tDecoded ? Math.round(it.tDecoded - it.t0) : null,
          upload: it.tUploaded ? Math.round(it.tUploaded - it.t0) : null, swap: it.tSwapped ? Math.round(it.tSwapped - it.t0) : null } };
    }
    return { manifest: !!this.manifest, anisotropy: this.e.anisotropy || 1, hold: this.hold, queue: [...this.queue], wanted: [...this.wanted], textures: out };
  }

  dispose() {
    for (const it of this.items.values()) { it.bmp?.close?.(); it.tex?.dispose?.(); }
    this.items.clear();
    this.queue = [];
    this.jobs.clear();
    this.worker?.terminate();     // (DYS-149)
    this.worker = null;
  }
}
