// The Study — interactions
// Wires up: bookshelf, corkboard quote modal, postcards, TV video swap,
// typewriter substack link, lamp dark mode, live clock, time-of-day sky.

(function () {
  const QUOTES = window.QUOTES || [];
  const VIDEOS = window.VIDEOS || [];

  // ─── Bookshelf → /books/ ───
  const bookshelf = document.querySelector('.bookshelf');
  if (bookshelf) {
    bookshelf.addEventListener('click', () => {
      window.location.href = '/books/';
    });
  }

  // ─── Typewriter → substack ───
  const typewriter = document.getElementById('typewriter');
  if (typewriter) {
    typewriter.addEventListener('click', () => {
      window.open('https://akshaychintalapati.substack.com/', '_blank', 'noopener');
    });
  }

  // ─── Corkboard cards → modal ───
  const modal = document.getElementById('quote-modal');
  const modalText = document.getElementById('quote-modal-text');
  const modalSource = document.getElementById('quote-modal-source');
  const modalClose = document.getElementById('quote-modal-close');
  let modalLockUntil = 0;

  function openQuote(idx) {
    const q = QUOTES[idx];
    if (!q) return;
    modalText.textContent = '"' + q.q + '"';
    modalSource.textContent = q.src ? '— ' + q.src : '';
    modal.classList.add('visible');
    document.body.style.overflow = 'hidden';
    void modal.offsetHeight;
    requestAnimationFrame(() => modal.classList.add('open'));
    modalLockUntil = Date.now() + 600;
  }

  function closeQuote() {
    if (!modal.classList.contains('open')) return;
    modal.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => modal.classList.remove('visible'), 350);
  }

  document.querySelectorAll('.index-card').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx, 10);
      openQuote(idx);
    });
  });
  modal.addEventListener('click', e => {
    if (Date.now() < modalLockUntil) return;
    if (e.target === modal) closeQuote();
  });
  modalClose.addEventListener('click', e => { e.stopPropagation(); closeQuote(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('open')) closeQuote();
  });

  // Rotate corkboard cards every ~16 seconds
  const corkboardCards = document.getElementById('corkboard-cards');
  if (corkboardCards && QUOTES.length > 6) {
    let cycleOffset = 0;
    setInterval(() => {
      cycleOffset = (cycleOffset + 6) % QUOTES.length;
      const cards = corkboardCards.querySelectorAll('.index-card');
      cards.forEach((card, i) => {
        const newIdx = (cycleOffset + i) % QUOTES.length;
        const q = QUOTES[newIdx];
        if (!q) return;
        card.style.transition = 'opacity 0.3s ease';
        card.style.opacity = 0;
        setTimeout(() => {
          card.dataset.idx = newIdx;
          card.querySelector('.q').textContent = q.q;
          const src = card.querySelector('.src');
          if (q.src) {
            if (src) src.textContent = '— ' + q.src;
            else {
              const s = document.createElement('div');
              s.className = 'src';
              s.textContent = '— ' + q.src;
              card.appendChild(s);
            }
          } else if (src) src.remove();
          card.style.opacity = 1;
        }, 300 + i * 60);
      });
    }, 16000);
  }

  // ─── TV video swap ───
  const tv = document.getElementById('tv');
  const tvScreen = document.getElementById('tv-screen');
  const tvDial = document.getElementById('tv-dial');
  const tvInfo = document.getElementById('tv-info');
  let currentVideo = 0;

  function setVideo(idx) {
    currentVideo = (idx + VIDEOS.length) % VIDEOS.length;
    if (tvInfo) tvInfo.textContent = VIDEOS[currentVideo].title;
    if (tv.classList.contains('playing')) {
      // already playing — swap iframe to next video
      const v = VIDEOS[currentVideo];
      tvScreen.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.className = 'tv-iframe';
      iframe.src = `https://www.youtube-nocookie.com/embed/${v.id}?autoplay=1&rel=0`;
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      tvScreen.appendChild(iframe);
    }
  }

  if (tv) {
    tv.addEventListener('click', e => {
      // If the dial was clicked, change channel instead of playing
      if (e.target === tvDial) {
        e.stopPropagation();
        setVideo(currentVideo + 1);
        return;
      }
      if (tv.classList.contains('playing')) return;
      const v = VIDEOS[currentVideo];
      tv.classList.add('playing');
      tvScreen.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.className = 'tv-iframe';
      iframe.src = `https://www.youtube-nocookie.com/embed/${v.id}?autoplay=1&rel=0`;
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      tvScreen.appendChild(iframe);
    });

    tvDial.addEventListener('click', e => {
      e.stopPropagation();
      setVideo(currentVideo + 1);
    });
  }

  // ─── Lamp → toggle night mode ───
  const lamp = document.getElementById('lamp');
  const STORAGE_KEY = 'study-night';

  function applyNight(on) {
    document.body.classList.toggle('night', on);
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch (e) {}
  }

  // Initial: respect stored preference, else use time-of-day
  const stored = (() => { try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }})();
  if (stored === '1') applyNight(true);
  else if (stored === null) {
    const hr = new Date().getHours();
    if (hr >= 20 || hr < 6) applyNight(true);
  }

  if (lamp) {
    lamp.addEventListener('click', () => {
      applyNight(!document.body.classList.contains('night'));
    });
  }

  // ─── Live clock ───
  const handHour = document.getElementById('hand-hour');
  const handMinute = document.getElementById('hand-minute');
  const handSecond = document.getElementById('hand-second');

  function tickClock() {
    const now = new Date();
    const s = now.getSeconds() + now.getMilliseconds() / 1000;
    const m = now.getMinutes() + s / 60;
    const h = (now.getHours() % 12) + m / 60;
    if (handSecond) handSecond.style.transform = `translateX(-50%) rotate(${s * 6}deg)`;
    if (handMinute) handMinute.style.transform = `translateX(-50%) rotate(${m * 6}deg)`;
    if (handHour)   handHour.style.transform   = `translateX(-50%) rotate(${h * 30}deg)`;
  }
  tickClock();
  setInterval(tickClock, 1000);

  // ─── Time-of-day sky ───
  // Smoothly interpolate sky colors across the day.
  const SKY_STOPS = [
    { h: 0,  top: '#0c1024', bot: '#1a1d3a' }, // midnight
    { h: 5,  top: '#1f2548', bot: '#634971' }, // pre-dawn
    { h: 7,  top: '#deb78e', bot: '#f5d8a8' }, // sunrise
    { h: 10, top: '#aac8e8', bot: '#dceaf6' }, // morning
    { h: 13, top: '#9ec3e8', bot: '#dde9f5' }, // midday
    { h: 16, top: '#cab28a', bot: '#f1d8a8' }, // afternoon
    { h: 18, top: '#c97a52', bot: '#f4b88a' }, // sunset
    { h: 20, top: '#3a3556', bot: '#5d4f7a' }, // dusk
    { h: 22, top: '#1a1d3a', bot: '#2a2147' }, // night
    { h: 24, top: '#0c1024', bot: '#1a1d3a' }, // midnight
  ];

  function lerp(a, b, t) { return a + (b - a) * t; }
  function hexToRgb(hex) {
    const v = hex.replace('#', '');
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
  }
  function rgbToHex([r, g, b]) {
    return '#' + [r, g, b].map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
  }
  function lerpColor(a, b, t) {
    const [ar, ag, ab] = hexToRgb(a);
    const [br, bg, bb] = hexToRgb(b);
    return rgbToHex([lerp(ar, br, t), lerp(ag, bg, t), lerp(ab, bb, t)]);
  }

  function updateSky() {
    const now = new Date();
    const h = now.getHours() + now.getMinutes() / 60;
    let prev = SKY_STOPS[0], next = SKY_STOPS[SKY_STOPS.length - 1];
    for (let i = 0; i < SKY_STOPS.length - 1; i++) {
      if (h >= SKY_STOPS[i].h && h < SKY_STOPS[i + 1].h) {
        prev = SKY_STOPS[i]; next = SKY_STOPS[i + 1]; break;
      }
    }
    const t = (h - prev.h) / (next.h - prev.h);
    const top = lerpColor(prev.top, next.top, t);
    const bot = lerpColor(prev.bot, next.bot, t);
    document.documentElement.style.setProperty('--sky-top', top);
    document.documentElement.style.setProperty('--sky-bot', bot);
  }
  updateSky();
  setInterval(updateSky, 60000); // refresh every minute
})();
