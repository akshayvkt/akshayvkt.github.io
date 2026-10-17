// Small motions inside the room, drawn on two little 2D canvases in the room layer (so they move with it):
// a faint wisp of steam rising from the tea (view.points.steam, the top of the cup), and a few dust motes
// drifting through the window light in sunny afternoon moments.

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const inside = (p) => p && p[0] > 0.01 && p[0] < 0.99 && p[1] > 0.05 && p[1] < 0.995;

export function createRoomFx({ layer, view, roomImage }) {
  const dpr = () => Math.min(2, window.devicePixelRatio || 1);
  const make = (cls) => {
    const c = document.createElement("canvas");
    c.className = cls;
    c.setAttribute("aria-hidden", "true");
    c.style.zIndex = "100000";
    layer.appendChild(c);
    return c;
  };

  // ---------- steam ----------
  const cup = view.points?.steam;
  const steam = inside(cup) ? { c: make("steam") } : null;
  if (steam) {
    steam.ctx = steam.c.getContext("2d");
    steam.c.style.filter = "blur(0.9px)";
    // three wisps that come and go, like steam from a cup that is slowly cooling
    steam.wisps = [0, 1, 2, 3].map((i) => ({ ph: i * 2.3 + 0.7, dx: (i % 2 ? 1 : -1) * (0.3 + 0.4 * i), len: 0.7 + 0.12 * i, period: 7 + 3.5 * i, alpha: 1 - 0.15 * i }));
  }

  // ---------- dust ----------
  const win = view.window;
  const motes = win ? { c: make("motes"), list: [], strength: 0, target: 0 } : null;
  if (motes) {
    motes.ctx = motes.c.getContext("2d");
    const sprite = document.createElement("canvas");
    sprite.width = sprite.height = 32;
    const g = sprite.getContext("2d"), grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,244,222,1)");
    grad.addColorStop(0.25, "rgba(255,236,204,0.55)");
    grad.addColorStop(1, "rgba(255,226,190,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    motes.sprite = sprite;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 16; i++) {
      motes.list.push({ x: rnd(), y: rnd(), z: rnd(), vx: 0, vy: 0, ph: rnd() * 6.283, spin: 0.6 + 2.2 * rnd() });
    }
  }

  let box = null;   // room-layer size in CSS px
  function resize(geo) {
    box = { w: geo.w, h: geo.h };
    const d = dpr();
    if (steam) {
      // a column above the cup, a little wider than it
      const x0 = clamp(cup[0] - 0.045, 0, 1), x1 = clamp(cup[0] + 0.045, 0, 1);
      const y0 = clamp(cup[1] - 0.2, 0, 1), y1 = clamp(cup[1] + 0.01, 0, 1);
      Object.assign(steam, { x0, y0, cw: (x1 - x0) * geo.w, ch: (y1 - y0) * geo.h });
      place(steam.c, x0 * geo.w, y0 * geo.h, steam.cw, steam.ch, d);
      steam.ox = (cup[0] - x0) * geo.w * d;
      steam.oy = (cup[1] - y0) * geo.h * d;
      steam.unit = geo.h * d / 720;    // one pixel of a 720 px tall room
    }
    if (motes) {
      // the light between the window and the desk
      const xs = win.map((p) => p[0]), ys = win.map((p) => p[1]);
      const wx0 = Math.min(...xs), wx1 = Math.max(...xs), wy0 = Math.min(...ys), wy1 = Math.max(...ys);
      const deskY = view.points?.desk?.[1] ?? wy1 + 0.15;
      const x0 = clamp(wx0 + 0.04 * (wx1 - wx0), 0, 1), x1 = clamp(wx1, 0, 1);
      const y0 = clamp(wy0 + 0.35 * (wy1 - wy0), 0, 1), y1 = clamp(Math.max(deskY - 0.04, wy1), 0, 1);
      place(motes.c, x0 * geo.w, y0 * geo.h, (x1 - x0) * geo.w, (y1 - y0) * geo.h, d);
      Object.assign(motes, { x0, y0, x1, y1 });
      motes.unit = geo.h * d / 720;
    }
  }
  function place(c, x, y, w, h, d) {
    Object.assign(c.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    c.width = Math.max(1, Math.round(w * d));
    c.height = Math.max(1, Math.round(h * d));
  }

  let night = 0, seen = null, pending = false;
  function setMoment(sel, near) {
    night = sel.a.night * (1 - sel.t) + sel.b.night * sel.t;
    // dust shows in direct afternoon sun
    if (motes) {
      motes.target = near.side === "pm" && (near.night || 0) < 0.05 && near.alt > 0.5 ? 1 : 0;
      if (motes.target && seen !== near.id && !pending) {
        pending = true;
        (window.requestIdleCallback || ((f) => setTimeout(f, 50)))(() => { visibility(near).finally(() => { pending = false; }); }, { timeout: 1000 });
      }
    }
  }
  // Dust is only visible against something darker than itself: read the room render small and keep, per
  // cell, how dark the room is there (zero through the glass, where the bright view would swallow it).
  const GW = 160;
  async function visibility(frame) {
    const img = roomImage && roomImage(frame);
    if (!img || !img.naturalWidth) { motes.map = null; return; }
    seen = frame.id;
    const gh = Math.max(1, Math.round((GW * img.naturalHeight) / img.naturalWidth));
    // shrink off the main thread (drawing the 4K room small on a canvas blocks for ~100 ms)
    const small = await createImageBitmap(img, { resizeWidth: GW, resizeHeight: gh, resizeQuality: "medium", premultiplyAlpha: "none" });
    const cv = document.createElement("canvas");
    cv.width = GW; cv.height = gh;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(small, 0, 0, GW, gh);
    small.close();
    const d = cx.getImageData(0, 0, GW, gh).data, map = new Float32Array(GW * gh);
    for (let i = 0; i < map.length; i++) {
      const a = d[i * 4 + 3] / 255, l = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
      map[i] = a * Math.pow(1 - l, 1.4);
    }
    motes.map = { data: map, w: GW, h: gh };
  }
  const darkAt = (x, y) => {
    const m = motes.map;
    if (!m) return 0;
    const i = Math.min(m.w - 1, Math.max(0, Math.floor(x * m.w))), j = Math.min(m.h - 1, Math.max(0, Math.floor(y * m.h)));
    return m.data[j * m.w + i];
  };

  function drawSteam(t) {
    const { ctx, c, ox, oy, unit } = steam;
    ctx.clearRect(0, 0, c.width, c.height);
    const rise = oy * 0.95;
    const rgb = night > 0.5 ? "255,240,220" : "255,255,252";
    const peak = night > 0.5 ? 0.2 : 0.13;
    for (const w of steam.wisps) {
      // each strand swells and fades on its own slow cycle, like steam from a cup that is cooling
      const env = smooth(0.1, 0.9, 0.5 + 0.5 * Math.sin((t / w.period) * 6.283 + w.ph)) * w.alpha;
      if (env < 0.02) continue;
      const top = rise * w.len, N = 32;
      const L = [], R = [];
      for (let i = 0; i <= N; i++) {
        const u = i / N;
        // curls that travel up the strand and grow as the air takes it
        const amp = 13 * unit * Math.pow(0.12 + u, 1.25);
        const curl = Math.sin(u * 7.0 - t * 1.7 + w.ph) + 0.55 * Math.sin(u * 13.0 - t * 2.9 + w.ph * 1.9);
        const drift = 10 * unit * u * u * Math.sin(t * 0.11 + w.ph);
        const x = ox + w.dx * 3 * unit + amp * curl + drift, y = oy - u * top;
        const hw = (0.45 + 2.6 * u) * unit;
        L.push([x - hw, y]); R.push([x + hw, y]);
      }
      const g = ctx.createLinearGradient(0, oy, 0, oy - top);
      g.addColorStop(0, `rgba(${rgb},0)`);
      g.addColorStop(0.08, `rgba(${rgb},${(peak * env * 0.7).toFixed(3)})`);
      g.addColorStop(0.3, `rgba(${rgb},${(peak * env).toFixed(3)})`);
      g.addColorStop(0.65, `rgba(${rgb},${(peak * env * 0.45).toFixed(3)})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(L[0][0], L[0][1]);
      for (const p of L) ctx.lineTo(p[0], p[1]);
      for (let i = R.length - 1; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1]);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawMotes(t, dt) {
    const m = motes, { ctx, c, unit } = m;
    m.strength += (m.target - m.strength) * Math.min(1, dt / 3);
    ctx.clearRect(0, 0, c.width, c.height);
    if (m.strength < 0.01) return;
    const W = c.width, H = c.height;
    const air = Math.sin(t * 0.05) * 3 * unit;   // a slow draught along the window
    for (const p of m.list) {
      // Brownian drift, a little warm air rising
      p.vx += (Math.random() - 0.5) * 6 * unit * dt - p.vx * 0.6 * dt;
      p.vy += (Math.random() - 0.5) * 6 * unit * dt - p.vy * 0.6 * dt;
      p.x += ((p.vx + air) * dt) / W;
      p.y += ((p.vy - 1.2 * unit) * dt) / H;
      if (p.x < 0) p.x += 1; if (p.x > 1) p.x -= 1;
      if (p.y < 0) p.y += 1; if (p.y > 1) p.y -= 1;
      const edge = smooth(0, 0.12, p.x) * smooth(0, 0.12, 1 - p.x) * smooth(0, 0.15, p.y) * smooth(0, 0.15, 1 - p.y);
      const glint = Math.pow(0.5 + 0.5 * Math.sin(t * p.spin + p.ph), 6);
      const bg = darkAt(m.x0 + p.x * (m.x1 - m.x0), m.y0 + p.y * (m.y1 - m.y0));
      const a = m.strength * edge * bg * 1.6 * (0.18 + 0.82 * glint) * (0.35 + 0.65 * p.z);
      if (a < 0.01) continue;
      const r = (1.1 + 1.9 * p.z) * unit;
      ctx.globalAlpha = Math.min(1, a);
      ctx.drawImage(m.sprite, p.x * W - r, p.y * H - r, 2 * r, 2 * r);
    }
    ctx.globalAlpha = 1;
  }

  return {
    resize,
    setMoment,
    frame(t, dt) {
      if (!box) return;
      if (steam) drawSteam(t);
      if (motes) drawMotes(t, dt);
    },
    destroy() { steam?.c.remove(); motes?.c.remove(); },
  };
}
