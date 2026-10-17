// Tea steam in the 3D room (stream I; plan_v2 section 5): the 2D wisps of web/js/roomfx.js ported to strands in
// room space above the cup, drawn as soft camera-facing ribbons in the engine's overlay stage, and hidden behind
// whatever is in front of them by the room's own depth (rendered for the steam's corner of the frame whenever the
// camera changes). Off for reduced motion, and idle while the cup is out of view.
//
//   const steam = createSteam(engine);       // interact.js does this; steam.enabled = false hides it; steam.dispose()

const WISPS = 4;
const SEG = 40;
const UNIT = 0.00135;      // roomfx.js drew in pixels of a 720 px tall desk frame: 1.35 mm at the cup from the desk eye
const RISE = 0.16;         // how high the strands reach above the tea (m)
const NIGHTISH = new Set(["night", "predawn", "dawn", "dusk", "blue", "sunset"]);

const VS = /* glsl */ `
precision highp float;
in vec3 position;            // x: u (0 at the tea, 1 at the top), y: side (-1, +1), z: strand
uniform mat4 uView;
uniform mat4 uProj;
uniform vec3 uBase;          // the tea's surface, centre (room metres)
uniform vec3 uRight;         // horizontal, across the view
uniform vec3 uToward;        // horizontal, toward the camera
uniform float uTime;
uniform vec4 uWisp[${WISPS}];     // phase, dx, length, period (as roomfx.js)
out vec2 vQ;                 // across (-1..1), u
out float vEnv;
out float vViewZ;
float smooth01(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
void main() {
  int k = int(position.z + 0.5);
  vec4 w = uWisp[k];
  float u = position.x, t = uTime;
  // each strand swells and fades on its own slow cycle, like steam from a cup that is cooling
  vEnv = smooth01(0.1, 0.9, 0.5 + 0.5 * sin(t / w.w * 6.2832 + w.x)) * (1.0 - 0.15 * float(k));
  float top = ${RISE.toFixed(3)} * w.z;
  // curls that travel up the strand and grow as the air takes it
  float amp = 13.0 * ${UNIT} * pow(0.12 + u, 1.25);
  float curl = sin(u * 7.0 - t * 1.7 + w.x) + 0.55 * sin(u * 13.0 - t * 2.9 + w.x * 1.9);
  float drift = 10.0 * ${UNIT} * u * u * sin(t * 0.11 + w.x);
  float depth = 0.6 * amp * sin(u * 5.0 - t * 1.3 + w.x * 2.7);    // a little depth, so an orbit sees a volume
  float hw = (0.45 + 2.6 * u) * ${UNIT} * 1.8;                       // wider than roomfx.js, with a soft profile
  vec3 p = uBase + uRight * (w.y * 3.0 * ${UNIT} + amp * curl + drift + position.y * hw) + uToward * depth
         + vec3(0.0, u * top, 0.0);
  vQ = vec2(position.y, u);
  vec4 vp = uView * vec4(p, 1.0);
  vViewZ = -vp.z;
  gl_Position = uProj * vp;
}`;

const FS = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec2 vQ;
in float vEnv;
in float vViewZ;
uniform vec3 uColor;
uniform float uPeak;
uniform sampler2D uDepth;    // the room's depth from this camera (unjittered)
uniform vec2 uInvSize;       // 1 / the display target's size in pixels
uniform vec2 uNearFar;
out vec4 outColor;
void main() {
  float u = vQ.y;
  // roomfx.js's gradient along the strand: 0, 0.7 at 8%, 1 at 30%, 0.45 at 65%, 0 at the top
  float g = u < 0.08 ? 0.7 * u / 0.08 : u < 0.3 ? mix(0.7, 1.0, (u - 0.08) / 0.22) : u < 0.65 ? mix(1.0, 0.45, (u - 0.3) / 0.35) : mix(0.45, 0.0, (u - 0.65) / 0.35);
  float across = exp(-2.6 * vQ.x * vQ.x);
  float d = texture(uDepth, gl_FragCoord.xy * uInvSize).r;
  float n = uNearFar.x, f = uNearFar.y;
  float sceneZ = (n * f) / (f - (f - n) * d);
  float soft = clamp((sceneZ - vViewZ) / 0.012, 0.0, 1.0);   // fades into the tea and behind anything in front
  float a = uPeak * vEnv * g * across * soft;
  if (a < 0.002) discard;
  outColor = vec4(uColor * a, a);
}`;

export function createSteam(engine) {
  const { THREE, renderer } = engine;
  const cup = engine.objectBounds("cup");
  if (!cup) return null;
  // the tea's surface: a little under the rim, at the cup's centre (R1's cup box includes the saucer)
  const base = new THREE.Vector3(cup.center[0], cup.max[1] - 0.012, cup.center[2]);

  // ---- the strands: a static ribbon per wisp, shaped in the vertex shader
  const verts = [], index = [];
  for (let k = 0; k < WISPS; k++) {
    const first = verts.length / 3;
    for (let i = 0; i <= SEG; i++) for (const side of [-1, 1]) verts.push(i / SEG, side, k);
    for (let i = 0; i < SEG; i++) {
      const a = first + 2 * i;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(index);
  geo.boundingSphere = new THREE.Sphere(base.clone(), 1);
  const wisps = [0, 1, 2, 3].map((i) => new THREE.Vector4(i * 2.3 + 0.7, (i % 2 ? 1 : -1) * (0.3 + 0.4 * i), 0.7 + 0.12 * i, 7 + 3.5 * i));
  const uniforms = {
    uView: { value: new THREE.Matrix4() }, uProj: { value: new THREE.Matrix4() },
    uBase: { value: base }, uRight: { value: new THREE.Vector3(1, 0, 0) }, uToward: { value: new THREE.Vector3(0, 0, 1) },
    uTime: { value: 0 }, uWisp: { value: wisps },
    uColor: { value: new THREE.Vector3(1, 1, 0.99) }, uPeak: { value: 0.13 },
    uDepth: { value: null }, uInvSize: { value: new THREE.Vector2(1, 1) }, uNearFar: { value: new THREE.Vector2(0.03, 200) },
  };
  const mat = new THREE.RawShaderMaterial({
    name: "steam", glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: FS, uniforms,
    transparent: true, premultipliedAlpha: true, blending: THREE.NormalBlending,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);

  // one camera for the depth and the strands: the frame's camera without the refining jitter or the lens offset
  const cam = new THREE.PerspectiveCamera();
  cam.matrixAutoUpdate = false;
  cam.matrixWorldAutoUpdate = false;
  let depthRT = null, camKey = "", visible = false, rect = null, enabled = true, boost = 1;

  const ensureTarget = (w, h) => {
    if (depthRT && depthRT.width === w && depthRT.height === h) return;
    depthRT?.dispose();
    depthRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, type: THREE.UnsignedByteType });
    depthRT.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    depthRT.depthTexture.minFilter = depthRT.depthTexture.magFilter = THREE.NearestFilter;
    uniforms.uDepth.value = depthRT.depthTexture;
    camKey = "";
  };

  /** The camera from the frame (unjittered); where the steam's column lands on screen (device px), or null. */
  const place = (frame) => {
    const c = frame.camera;
    cam.position.fromArray(c.position);
    cam.quaternion.fromArray(c.quaternion);
    cam.matrixWorld.compose(cam.position, cam.quaternion, new THREE.Vector3(1, 1, 1));
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    cam.projectionMatrix.copy(c.projectionNoJitter);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    uniforms.uView.value.copy(cam.matrixWorldInverse);
    uniforms.uProj.value.copy(cam.projectionMatrix);
    uniforms.uNearFar.value.set(c.near, c.far);
    const toward = new THREE.Vector3().subVectors(cam.position, base).setY(0);
    if (toward.lengthSq() < 1e-8) toward.set(0, 0, 1);
    toward.normalize();
    uniforms.uToward.value.copy(toward);
    uniforms.uRight.value.set(toward.z, 0, -toward.x);
    // the column: 5 cm around the tea, from its surface to the top of the strands
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const v = new THREE.Vector3();
    for (const dx of [-0.05, 0.05]) for (const dz of [-0.05, 0.05]) for (const dy of [0, RISE * 1.1]) {
      v.set(base.x + dx, base.y + dy, base.z + dz).applyMatrix4(cam.matrixWorldInverse);
      if (v.z > -c.near) return null;
      v.applyMatrix4(cam.projectionMatrix);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    if (x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1) return null;
    const W = frame.width, H = frame.height;
    const ax = Math.max(0, Math.floor((x0 * 0.5 + 0.5) * W) - 2), ay = Math.max(0, Math.floor((y0 * 0.5 + 0.5) * H) - 2);
    const bx = Math.min(W, Math.ceil((x1 * 0.5 + 0.5) * W) + 2), by = Math.min(H, Math.ceil((y1 * 0.5 + 0.5) * H) + 2);
    return bx > ax && by > ay ? [ax, ay, bx - ax, by - ay] : null;
  };

  const look = (frame) => {
    const L = frame.light;
    const night = !L.sun || NIGHTISH.has(L.moment);
    // roomfx.js's peaks (0.13 by day, 0.2 by lamplight) with its solid strands; these soft ones spread the same
    // ink wider, so they peak higher
    const lamp = Math.min(1, L.lamp);
    if (night) {
      // lit by the lamp (warm), or barely there by the screen's glow
      uniforms.uColor.value.set(1 - 0.12 * (1 - lamp), 0.94 - 0.02 * (1 - lamp), 0.86 + 0.14 * (1 - lamp));
      uniforms.uPeak.value = 0.035 + 0.235 * lamp;
    } else {
      // brightest when backlit by the window: looking toward the glass through the steam
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const back = Math.max(0, -fwd.z);
      uniforms.uColor.value.set(1, 1 - 0.04 * lamp, 0.99 - 0.1 * lamp);
      uniforms.uPeak.value = 0.19 * (0.7 + 0.3 * back);
    }
  };

  const active = (frame) => enabled && !frame.reducedMotion && visible;

  const pass = engine.addPass({
    name: "steam", stage: "overlay", order: 0,
    update(frame) {
      // N's rig sets the camera in its own update(); the frame's camera is final by the prepare stage
    },
    animating(frame) { return active(frame); },
    needsRender(frame) {
      if (!enabled || frame.reducedMotion) return false;
      rect = place(frame);
      visible = !!rect;
      return visible;
    },
    render(ctx, frame) {
      // the room's depth behind the steam's column, redrawn when the camera changes
      ensureTarget(frame.width, frame.height);
      const key = frame.camera.position.join(",") + frame.camera.quaternion.join(",") + frame.camera.projectionNoJitter.elements.join(",");
      const prevTarget = renderer.getRenderTarget();
      if (key !== camKey) {
        camKey = key;
        renderer.setRenderTarget(depthRT);
        depthRT.scissor.set(rect[0], rect[1], rect[2], rect[3]);
        depthRT.scissorTest = true;
        renderer.setRenderTarget(depthRT);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, false);
        engine.room.drawIds(cam);
        depthRT.scissorTest = false;
        renderer.setRenderTarget(prevTarget);
      }
      uniforms.uInvSize.value.set(1 / frame.width, 1 / frame.height);
      uniforms.uTime.value = (frame.time / 1000) % 100000;
      look(frame);
      uniforms.uPeak.value *= boost;
      renderer.render(scene, cam);
    },
  });
  // the outside and N may not keep the loop busy: while the steam shows, it does (at most 30 fps once settled)
  engine.requestFrame();

  return {
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; engine.requestFrame(); },
    get visible() { return visible; },
    /** QA only: multiplies the strands' opacity (to check what hides them). */
    set boost(v) { boost = +v || 1; },
    compile() { return renderer.compileAsync(scene, cam); },
    get rect() { return rect; },
    base: base.toArray(),
    dispose() { pass.remove(); geo.dispose(); mat.dispose(); depthRT?.dispose(); },
  };
}
