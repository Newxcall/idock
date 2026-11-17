// Bildschirm live im Touchpad: holt Bild für Bild vom PC (folgt dem Mauszeiger), Bildschirm wechseln, Zoom.

const PREF_KEY = 'idock.screen';
const MAX_FPS = 20;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadPrefs() {
  try { return { on: false, zoom: 2, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; }
  catch { return { on: false, zoom: 2 }; }
}

export function initScreen({ panel, conn }) {
  const $ = (s) => panel.querySelector(s);
  const toggle = $('#screen-toggle');
  const chips = $('#screen-chips');
  const zoomBtn = $('#screen-zoom');
  const view = $('#screen-view');
  const img = $('#screen-img');
  const msg = $('.screen-msg');

  const prefs = loadPrefs();
  let screens = [];
  let current = -1;
  let running = false;
  let prevUrl = null;
  let shown = false;   // schon ein Bild da?

  const save = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { } };
  const token = () => encodeURIComponent(conn.token || '');
  const active = () => prefs.on && !panel.hidden && conn.state === 'online' && document.visibilityState === 'visible';

  function setMsg(text) { msg.textContent = text || ''; msg.hidden = !text; }

  function render() {
    panel.classList.toggle('screen-on', prefs.on);
    toggle.classList.toggle('on', prefs.on);
    toggle.setAttribute('aria-pressed', String(prefs.on));
    view.hidden = !prefs.on;
    zoomBtn.hidden = !prefs.on;
    zoomBtn.textContent = `${prefs.zoom}×`;
    chips.hidden = !prefs.on || screens.length < 2;
    chips.querySelectorAll('button').forEach(b => b.classList.toggle('active', +b.dataset.i === current));
    const s = screens[current];
    if (s) view.style.setProperty('--ratio', `${s.w} / ${s.h}`);
  }

  function renderChips() {
    chips.innerHTML = '';
    for (const s of screens) {
      const b = document.createElement('button');
      b.dataset.i = s.i;
      b.textContent = String(s.i + 1);
      b.title = s.name + (s.primary ? ' (Hauptbildschirm)' : '');
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => {
        current = s.i;
        render();
        conn.send({ t: 'screen.select', i: s.i });
      });
      chips.appendChild(b);
    }
    render();
  }

  conn.on('screens', (m) => {
    screens = m.items || [];
    current = m.current ?? 0;
    renderChips();
  });

  async function loop() {
    if (running) return;
    running = true;
    try {
      while (active()) {
        const t0 = performance.now();
        try {
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const w = Math.round(Math.min(2560, Math.max(160, view.clientWidth * dpr)));
          const h = Math.round(Math.min(2560, Math.max(120, view.clientHeight * dpr)));
          // Unterwegs (Fernzugriff) etwas kleinere, stärker komprimierte Bilder – die Leitung ist meist langsamer.
          const q = conn.remote ? 50 : 60;
          const res = await conn.apiFetch(`api/screen/frame?t=${token()}&w=${w}&h=${h}&z=${prefs.zoom}&q=${q}`, { cache: 'no-store' });
          if (res.status === 401) { setMsg('Nicht angemeldet.'); break; }
          if (!res.ok) {
            setMsg('Der Bildschirm ist gerade gesperrt oder geschützt (z. B. Sperrbildschirm oder Windows-Sicherheitsabfrage).');
            await sleep(1000);
            continue;
          }
          const idx = +(res.headers.get('X-Screen-Index') ?? 0);
          const count = +(res.headers.get('X-Screen-Count') ?? 1);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          await new Promise((resolve) => { img.onload = img.onerror = resolve; img.src = url; });
          if (prevUrl) URL.revokeObjectURL(prevUrl);
          prevUrl = url;
          if (!shown) { shown = true; view.classList.add('ready'); }
          setMsg('');
          if (count !== screens.length) conn.send({ t: 'screen.list' });
          if (idx !== current) { current = idx; render(); }
        } catch {
          await sleep(800); // Verbindung kurz weg → gleich wieder versuchen
        }
        const wait = 1000 / MAX_FPS - (performance.now() - t0);
        if (wait > 0) await sleep(wait);
      }
    } finally {
      running = false;
    }
  }

  const kick = () => { render(); if (active()) loop(); };

  toggle.addEventListener('click', () => {
    prefs.on = !prefs.on;
    save();
    if (prefs.on) conn.send({ t: 'screen.list' });
    kick();
  });
  zoomBtn.addEventListener('click', () => {
    prefs.zoom = prefs.zoom >= 4 ? 1 : prefs.zoom + 1;
    save();
    render();
  });

  // Starten/stoppen, wenn der Reiter gewechselt wird, die App in den Hintergrund geht oder die Verbindung kommt.
  new MutationObserver(kick).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', kick);
  conn.addEventListener('state', (e) => {
    if (e.detail.state === 'online' && prefs.on) conn.send({ t: 'screen.list' });
    kick();
  });

  setMsg('');
  render();
}
