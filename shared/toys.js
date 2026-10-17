// Two small delights on the desk (docs/v3/EXPERIENCE-SPEC.md v2; interactions B):
//
//   the headphones, the easter egg: the laptop's screen crossfades from the Projects page to the official "Never Gonna
//   Give You Up" video, embedded from youtube-nocookie (the visitor's click is the user gesture for its sound); leaving
//   stops it and the Projects page comes back. The player's messages say when it is ready; an embed that reports an
//   error, or is not ready within 5 s, gives way to the video's thumbnail as a link to the official video in a new tab.
//   Phones open the official video in a tab.
//     import { Egg, WATCH } from "/shared/toys.js";
//     const egg = new Egg(laptopScreen); egg.start(); egg.stop(); egg.on; egg.state; egg.blocked
//
//   the breadboard, a builder's hands: the dev board's small LED blinks three times (a point of light at its place in
//   the room), and with Sound on the buzzer chirps a short three-note phrase (a quiet square wave, WebAudio, no files).
//     import { Board, soundOn } from "/shared/toys.js";
//     const board = new Board({ parent, point }); await board.blink({ visible }); board.place(pose, w, h)
//
// Sound: off by default, behind the approved "Sound" toggle (spec v2), which is not built yet; its contract here is the
// class "sfw-sound" on <html>. No navigation for the breadboard.
import { project } from "./rig.js";

export const EMBED = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1";
export const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
export const THUMB = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg";
const YT = "https://www.youtube-nocookie.com";
// after onReady the frame waits for the player's buffering or playing state, or this long without onError: a player
// that cannot play here sends onError straight after onReady (headless Chrome did), and its refusal never shows
const GRACE = 1000;
const BLOCKED_KEY = "sfw-egg-blocked";   // sessionStorage: the embed did not play in this visit
// the embed with the player's messages on (the coordinator's 04:05 review): the frame tells this page when it is ready or
// cannot play, so a refused embed never stays on the screen
export const embedURL = (origin = location.origin) => `${EMBED}&enablejsapi=1&origin=${encodeURIComponent(origin)}`;
const PLAY = '<svg viewBox="0 0 68 48" aria-hidden="true"><path d="M66.5 7.7c-.8-2.9-3-5.2-6-6C55.3.3 34 .3 34 .3S12.7.3 7.5 1.7c-3 .8-5.2 3.1-6 6C.1 13 .1 24 .1 24s0 11 1.4 16.3c.8 2.9 3 5.2 6 6C12.7 47.7 34 47.7 34 47.7s21.3 0 26.5-1.4c3-.8 5.2-3.1 6-6C67.9 35 67.9 24 67.9 24s0-11-1.4-16.3z" fill="rgba(18,18,18,0.72)"/><path d="M27 34.3 45 24 27 13.7z" fill="#fff"/></svg>';

export const soundOn = () => document.documentElement.classList.contains("sfw-sound");

export class Egg {
  constructor(laptop, { wait = 5000, reduced = () => false } = {}) {
    this.laptop = laptop;              // shared/laptop.js LaptopScreen (its page lives in a shadow root)
    this.wait = wait;                  // ms for the player's onReady before the thumbnail takes its place
    this.reduced = reduced;
    this.wrap = null;
    this.state = "off";                // off | loading | playing | thumb
    try { this.blocked = sessionStorage.getItem(BLOCKED_KEY) === "1"; } catch { this.blocked = false; }
  }
  get on() { return !!this.wrap; }
  get loaded() { return this.state === "playing" || this.state === "thumb"; }

  start() {
    const root = this.laptop?.host?.shadowRoot;
    if (!root || this.wrap) return !!this.wrap;
    const wrap = (this.wrap = document.createElement("div"));
    const fade = this.reduced() ? 150 : 650;
    // (2 px past the screen's box: the Projects page's edge pixels, white, would show as a hairline round the video)
    wrap.style.cssText = `position:absolute;inset:-2px;z-index:50;background:#000;opacity:0;transition:opacity ${fade}ms cubic-bezier(0.45,0,0.25,1);`;
    root.appendChild(wrap);
    // a visit where the embed did not play: its thumbnail at once
    if (this.blocked) { this.thumb("blocked before"); return true; }
    const f = (this.frame = document.createElement("iframe"));
    f.src = embedURL();
    f.title = "Never Gonna Give You Up";
    f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    f.setAttribute("allowfullscreen", "");
    f.referrerPolicy = "strict-origin-when-cross-origin";
    f.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#000;";
    wrap.appendChild(f);
    this.state = "loading";
    this.events = [];
    this.readyAt = 0;
    this.frameShown = false;
    // the player's messages (the IFrame API's own protocol, without its script): "listening" until it answers, then
    // onReady and its state (the video is coming: it fades in) or onError (it cannot play here: the thumbnail)
    const send = (msg) => { try { f.contentWindow?.postMessage(JSON.stringify({ ...msg, id: 1, channel: "widget" }), YT); } catch { /* not yet */ } };
    const show = () => {
      if (this.wrap !== wrap || this.state !== "loading") return;
      this.state = "playing";
      this.frameShown = true;
      clearTimeout(this.graceT);
      requestAnimationFrame(() => { wrap.style.opacity = "1"; });
    };
    this.onMsg = (e) => {
      if (e.origin !== YT || e.source !== f.contentWindow || this.wrap !== wrap) return;
      let d;
      try { d = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch { return; }
      if (!d || !d.event) return;
      if (d.event !== "infoDelivery") this.events.push(d.event);
      if (!this.heard) { this.heard = true; for (const ev of ["onError", "onStateChange"]) send({ event: "command", func: "addEventListener", args: [ev] }); }
      if (d.event === "onReady" && this.state === "loading" && !this.readyAt) {
        this.readyAt = performance.now();
        clearTimeout(this.timer); clearInterval(this.knock);
        this.graceT = setTimeout(show, GRACE);
      }
      if (d.event === "onStateChange" && (d.info === 1 || d.info === 3) && this.readyAt) show();   // playing, buffering
      if (d.event === "onError") this.thumb(`onError ${d.info}`);
    };
    addEventListener("message", this.onMsg);
    this.heard = false;
    f.addEventListener("load", () => { send({ event: "listening" }); });
    this.knock = setInterval(() => { if (!this.heard) send({ event: "listening" }); }, 250);
    this.timer = setTimeout(() => { if (this.wrap === wrap && this.state === "loading") this.thumb("no onReady"); }, this.wait);
    return true;
  }

  // The embed cannot play here: its thumbnail (no words) as a link to the official video, in a new tab.
  thumb(why) {
    const wrap = this.wrap;
    if (!wrap) return;
    this.why = why;
    this.state = "thumb";
    this.blocked = true;
    try { sessionStorage.setItem(BLOCKED_KEY, "1"); } catch { /* storage blocked */ }
    clearTimeout(this.timer); clearTimeout(this.graceT); clearInterval(this.knock);
    if (this.onMsg) { removeEventListener("message", this.onMsg); this.onMsg = null; }
    this.frame?.remove();
    this.frame = null;
    const a = document.createElement("a");
    a.className = "egg-thumb";
    a.href = WATCH;
    a.target = "_blank";
    a.rel = "noopener";
    a.setAttribute("aria-label", "Never Gonna Give You Up");
    a.style.cssText = "position:absolute;inset:0;display:block;cursor:pointer;outline:none;-webkit-tap-highlight-color:transparent;";
    const img = document.createElement("img");
    img.alt = "";
    img.src = THUMB;
    img.referrerPolicy = "strict-origin-when-cross-origin";
    img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;";
    const play = document.createElement("span");
    play.innerHTML = PLAY;
    play.style.cssText = "position:absolute;left:50%;top:50%;width:13%;transform:translate(-50%,-50%);display:block;line-height:0;";
    play.firstChild.style.cssText = "width:100%;height:auto;display:block;";
    a.append(img, play);
    wrap.replaceChildren(a);
    const show = () => requestAnimationFrame(() => { if (this.wrap === wrap) wrap.style.opacity = "1"; });
    if (img.complete) show(); else { img.addEventListener("load", show, { once: true }); img.addEventListener("error", show, { once: true }); }
  }

  // Stops the video (the frame goes, and its sound with it) once the Projects page is back on the screen.
  stop() {
    const wrap = this.wrap;
    if (!wrap) return;
    this.wrap = null;
    this.frame = null;
    this.state = "off";
    clearTimeout(this.timer); clearTimeout(this.graceT); clearInterval(this.knock);
    if (this.onMsg) { removeEventListener("message", this.onMsg); this.onMsg = null; }
    const ms = this.reduced() ? 150 : 320;
    wrap.style.transition = `opacity ${ms}ms ease`;
    wrap.style.opacity = "0";
    setTimeout(() => wrap.remove(), ms + 20);
  }
}

// ------------------------------------------------------------------ the breadboard
const LED_CSS = `
.sfw-led { position: absolute; left: 0; top: 0; z-index: 1; width: 0; height: 0; pointer-events: none; mix-blend-mode: screen; opacity: 0; transition: opacity 45ms linear; }
.sfw-led i { position: absolute; border-radius: 50%; transform: translate(-50%, -50%); }
.sfw-led .halo { background: radial-gradient(closest-side, rgba(255, 64, 40, 0.9), rgba(255, 48, 28, 0.42) 28%, rgba(255, 40, 20, 0.12) 60%, rgba(255, 40, 20, 0) 100%); }
.sfw-led .core { background: radial-gradient(closest-side, #fffaf6, #ffd2c4 35%, #ff5a3c 70%, rgba(255, 60, 30, 0) 100%); }
`;
const NOTES = [2093, 2637, 3136];        // C7, E7, G7: a buzzer's rising three-note chirp
const NOTE_S = 0.14, GAP_S = 0.1;

export class Board {
  constructor({ parent, point }) {
    this.point = point;
    if (!document.querySelector("style[data-sfw-led]")) {
      const s = document.createElement("style");
      s.setAttribute("data-sfw-led", "");
      s.textContent = LED_CSS;
      document.head.appendChild(s);
    }
    this.el = document.createElement("div");
    this.el.className = "sfw-led";
    this.el.setAttribute("aria-hidden", "true");
    this.halo = document.createElement("i"); this.halo.className = "halo";
    this.core = document.createElement("i"); this.core.className = "core";
    this.el.append(this.halo, this.core);
    parent.appendChild(this.el);
    this.log = [];
    this.blinking = false;
  }

  // Where the LED is on screen and how big a few millimetres look from here.
  place(pose, w, h) {
    const s = project(pose, this.point, w, h);
    if (!s) { this.el.style.visibility = "hidden"; return null; }
    this.el.style.visibility = "";
    const pxPerM = (h / 2) / pose.tanV / s[2];
    // (a lit 1.6 mm SMD LED reads as a hot point with a red bloom about 2.5 cm across)
    const halo = Math.max(16, 0.04 * pxPerM), core = Math.max(4, 0.006 * pxPerM);
    this.el.style.transform = `translate(${s[0].toFixed(1)}px, ${s[1].toFixed(1)}px)`;
    this.halo.style.width = this.halo.style.height = `${halo.toFixed(1)}px`;
    this.core.style.width = this.core.style.height = `${core.toFixed(1)}px`;
    return s;
  }

  // Three blinks (with the chirp's notes when Sound is on). visible: the LED is in view from here (else no light).
  async blink({ visible = true } = {}) {
    if (this.blinking) return false;
    this.blinking = true;
    const t0 = performance.now();
    this.log = [];
    const sound = soundOn();
    if (sound) chirp();
    for (let i = 0; i < NOTES.length; i++) {
      if (visible) this.el.style.opacity = "1";
      this.log.push({ on: Math.round(performance.now() - t0) });
      await new Promise((r) => setTimeout(r, NOTE_S * 1000));
      this.el.style.opacity = "0";
      this.log[i].off = Math.round(performance.now() - t0);
      await new Promise((r) => setTimeout(r, GAP_S * 1000));
    }
    this.blinking = false;
    this.last = { blinks: this.log.length, log: this.log, visible, sound };
    return true;
  }
}

// The buzzer: three short square-wave notes, quiet, through a soft low-pass (a piezo is not harsh), no audio files.
let ctx = null;
export function chirp() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = ctx || new AC();
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime + 0.02;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 4200; lp.Q.value = 0.5;
    const out = ctx.createGain();
    out.gain.value = 0.035;
    lp.connect(out).connect(ctx.destination);
    NOTES.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), s = t + i * (NOTE_S + GAP_S);
      o.type = "square";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(1, s + 0.006);
      g.gain.setValueAtTime(1, s + NOTE_S - 0.015);
      g.gain.linearRampToValueAtTime(0, s + NOTE_S);
      o.connect(g).connect(lp);
      o.start(s);
      o.stop(s + NOTE_S + 0.02);
    });
    return true;
  } catch { return false; }
}
