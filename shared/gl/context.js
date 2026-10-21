// The one WebGL2 context (docs/v3/engine-api.md section 1): a three.js 0.169.0 renderer on the page's canvas,
// capability checks, the pixel-ratio rule, and the engine-managed render targets that follow the canvas size.
import * as THREE from "three";

const params = new URLSearchParams(location.search);

/** `?nonce=N` (S2 measurements only): a define that makes every shader new to the browser's shader caches. */
export const SHADER_NONCE = params.has("nonce") ? `#define SFW_NONCE ${params.get("nonce").replace(/\W/g, "") || "1"}\n` : "";

export const nextTask = () => new Promise((r) => setTimeout(r, 0));

/** Resolves once the GPU has finished everything submitted so far, without blocking the main thread. */
export function gpuIdle(gl) {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  return new Promise((res) => {
    const poll = () => {
      const s = gl.clientWaitSync(sync, 0, 0);
      if (s === gl.TIMEOUT_EXPIRED) { setTimeout(poll, 2); return; }
      gl.deleteSync(sync);
      res();
    };
    poll();
  });
}

/**
 * Can this browser run the room at all? Synchronous; call it before downloading anything. With probeGL false it
 * checks only the switches (?3d=0, Save-Data) and leaves the WebGL checks to createEngine, which makes the context
 * once (a throwaway test context costs tens of milliseconds of main thread).
 */
export function engineSupport({ probeGL = true } = {}) {
  if (params.get("3d") === "0") return { ok: false, reason: "forced" };
  const conn = navigator.connection;
  if (conn && conn.saveData && params.get("qa") !== "1") return { ok: false, reason: "save-data" };
  if (!probeGL) return { ok: true, reason: null };
  let gl = null;
  try {
    gl = document.createElement("canvas").getContext("webgl2", { failIfMajorPerformanceCaveat: true });
  } catch (e) { /* fall through */ }
  if (!gl) return { ok: false, reason: "no-webgl2" };
  const ok = !!gl.getExtension("EXT_color_buffer_float");
  const lose = gl.getExtension("WEBGL_lose_context");
  if (lose) lose.loseContext();
  return ok ? { ok: true, reason: null } : { ok: false, reason: "no-float-buffer" };
}

export class EngineFallback extends Error {
  constructor(reason, detail) {
    super(`room engine unavailable: ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "EngineFallback";
    this.reason = reason;
  }
}

/** Device pixels per CSS pixel: min(2, sqrt(4.2 MP / CSS area)), floored at 1 on phones and 0.75 on desktop. */
export function pixelRatioFor(cssW, cssH, { tier = "T2", cap = 2, override = null } = {}) {
  if (override) return override;
  const dpr = window.devicePixelRatio || 1;
  const budget = Math.sqrt(4.2e6 / Math.max(1, cssW * cssH));
  const floor = tier === "T1" ? 1 : 0.75;
  return Math.max(Math.min(floor, dpr), Math.min(dpr, cap, budget));
}

export function createContext(canvas, { qa = null } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,         // refining at rest does the anti-aliasing; E2 adds FXAA or MSAA while moving
      alpha: false,
      depth: false,             // the canvas only receives the finished picture
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
  } catch (e) {
    throw new EngineFallback("no-webgl2", e.message);
  }
  const gl = renderer.getContext();
  if (!(gl instanceof WebGL2RenderingContext)) throw new EngineFallback("no-webgl2");
  if (!renderer.extensions.has("EXT_color_buffer_float")) throw new EngineFallback("no-float-buffer");
  renderer.autoClear = false;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // the composite writes display values itself
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.debug.checkShaderErrors = !!qa || params.has("debug");
  const caps = {
    floatBlend: !!gl.getExtension("EXT_float_blend"),
    parallelCompile: !!gl.getExtension("KHR_parallel_shader_compile"),
    timerQuery: !!gl.getExtension("EXT_disjoint_timer_query_webgl2"),
    floatLinear: !!gl.getExtension("OES_texture_float_linear"),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    renderer: (() => {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    })(),
  };
  return { renderer, gl, caps, THREE };
}

/**
 * Engine-managed render targets that follow the drawing buffer. `get(name, spec)` returns the same target for the
 * same name; spec = { scale = 1, type = UnsignedByteType, depth = false, filter = Linear, format = RGBA }.
 */
export class Targets {
  constructor() {
    this.map = new Map();
    this.width = 1;
    this.height = 1;
  }

  get(name, spec = {}) {
    let e = this.map.get(name);
    if (!e) {
      const s = { scale: 1, type: THREE.UnsignedByteType, depth: false, filter: THREE.LinearFilter, ...spec };
      const w = Math.max(1, Math.round(this.width * s.scale)), h = Math.max(1, Math.round(this.height * s.scale));
      const rt = new THREE.WebGLRenderTarget(w, h, {
        type: s.type, format: THREE.RGBAFormat, depthBuffer: !!s.depth, stencilBuffer: false,
        minFilter: s.filter, magFilter: s.filter, generateMipmaps: false, colorSpace: THREE.NoColorSpace,
      });
      rt.texture.name = name;
      e = { rt, spec: s };
      this.map.set(name, e);
    }
    return e.rt;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    for (const { rt, spec } of this.map.values()) {
      const w = Math.max(1, Math.round(width * spec.scale)), h = Math.max(1, Math.round(height * spec.scale));
      if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
    }
  }

  dispose() {
    for (const { rt } of this.map.values()) rt.dispose();
    this.map.clear();
  }
}

/** One full-screen triangle drawn with any material (RawShaderMaterial with `in vec2 position` in clip space). */
export class Fullscreen {
  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 3, -1, -1, 3], 2));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);   // 2D positions: never let three compute one
    this.mesh = new THREE.Mesh(g, null);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  draw(renderer, material) {
    this.mesh.material = material;
    renderer.render(this.scene, this.camera);
  }
}

/** The vertex shader every full-screen pass shares. */
export const FULLSCREEN_VS = /* glsl */ `
in vec2 position;
out vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

export function fullscreenMaterial(fragmentShader, uniforms, extra = {}) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: SHADER_NONCE + "precision highp float;\n" + FULLSCREEN_VS,
    fragmentShader: SHADER_NONCE + fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    ...extra,
  });
}
