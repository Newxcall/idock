// Bildschirm live im Touchpad (folgt dem Mauszeiger), Bildschirm wechseln, Zoom.
// Im WLAN holt das iPhone Bild für Bild ab, über das Internet schickt der PC die Bilder von selbst (Strom).

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
  const diag = $('#screen-diag');

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

  // Technikzeile (nur über das Internet): Messwerte der letzten 3 Sekunden + Werte vom PC.
  let samples = [];   // { at, gap, kb, pcMs }
  let net = null;
  let stalls = 0;     // Pausen > 1 s zwischen zwei Bildern (seit Einschalten)
  let lastFrameAt = 0;
  let quality = null;   // vom PC gewählte Stufe (Größe, JPEG-Qualität, Ø Bestätigungszeit)
  conn.on('netstat', (m) => { net = m; });
  function updateDiag() {
    const on = active() && conn.tunneled;
    diag.hidden = !on;
    if (!on) return;
    const now = performance.now();
    samples = samples.filter(x => now - x.at < 3000);
    const n = samples.length;
    const avg = (f) => n ? samples.reduce((a, x) => a + f(x), 0) / n : 0;
    const max = (f) => n ? Math.max(...samples.map(f)) : 0;
    let line = `Bild ${(n / 3).toFixed(1)}/s · ${avg(x => x.kb).toFixed(1)} KB · Abstand max ${max(x => x.gap).toFixed(0)} ms · PC ${avg(x => x.pcMs).toFixed(0)} ms · Hänger ${stalls}`;
    if (quality) line += `
Stufe ${quality.level} · ${quality.w}×${quality.h} q${quality.q} · Bestätigung Ø${quality.ack} ms`;
    if (net && net.s) line += `\nLeitung ${net.s.rtt} ms · RTO ${net.s.rto} · Fenster ${net.s.cwnd} KB · offen ${net.s.outKb} KB · Wdh ${net.s.timeouts}+${net.s.fast} · ${net.path || ''}`;
    diag.textContent = line.replace(/(\d)\.(\d)/g, '$1,$2');
  }
  setInterval(() => {
    updateDiag();
    if (active() && conn.tunneled) conn.send({ t: 'netstat' });
  }, 1000);

  // Bild anzeigen: immer nur das neueste; während eins dekodiert wird, wartet höchstens eins.
  let pending = null;   // { blob, idx, count }
  let drawing = false;
  async function show(item) {
    pending = item;
    if (drawing) return;
    drawing = true;
    try {
      while (pending) {
        const { blob, idx, count } = pending;
        pending = null;
        const url = URL.createObjectURL(blob);
        await new Promise((resolve) => { img.onload = img.onerror = resolve; img.src = url; });
        if (prevUrl) URL.revokeObjectURL(prevUrl);
        prevUrl = url;
        if (!shown) { shown = true; view.classList.add('ready'); }
        setMsg('');
        if (count !== screens.length) conn.send({ t: 'screen.list' });
        if (idx !== current) { current = idx; render(); }
      }
    } finally { drawing = false; }
  }

  // --- Über das Internet: der PC schickt die Bilder von selbst (Strom), das iPhone bestätigt jedes. ---
  let streamKey = '';   // zuletzt gesendete Einstellungen ('' = Strom aus)
  function streamParams() {
    // Größe in Gerätepixeln (volle Schärfe). Wie viel davon tatsächlich kommt, passt der PC der Leitung an.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(Math.min(1920, Math.max(160, view.clientWidth * dpr)));
    const h = Math.round(Math.min(1920, Math.max(120, view.clientHeight * dpr)));
    return { w, h, z: prefs.zoom };
  }
  function syncStream() {
    const want = active() && conn.tunneled;
    if (want) {
      const p = streamParams();
      const key = JSON.stringify(p);
      if (key !== streamKey) { conn.send({ t: 'screen.stream', on: true, ...p }); streamKey = key; lastFrameAt = 0; }
    } else if (streamKey) {
      if (conn.state === 'online') conn.send({ t: 'screen.stream', on: false });
      streamKey = '';
    }
  }
  conn.on('screen.frame', ({ buf }) => {
    if (!streamKey) return;
    const dv = new DataView(buf);
    const n = dv.getUint32(4);
    conn.send({ t: 'screen.ack', n });
    const now = performance.now();
    const gap = lastFrameAt ? now - lastFrameAt : 0;
    if (gap > 1000) stalls++;
    lastFrameAt = now;
    const head = buf.byteLength >= 20 ? 20 : 12;
    const blob = new Blob([new Uint8Array(buf, head)], { type: 'image/jpeg' });
    samples.push({ at: now, gap, kb: blob.size / 1024, pcMs: dv.getUint16(10) });
    if (head === 20) quality = { w: dv.getUint16(12), h: dv.getUint16(14), q: dv.getUint8(16), level: dv.getUint8(17), ack: dv.getUint16(18) };
    show({ blob, idx: dv.getUint8(8), count: dv.getUint8(9) });
  });
  conn.on('screen.err', () => setMsg('Der Bildschirm ist gerade gesperrt oder geschützt (z. B. Sperrbildschirm oder Windows-Sicherheitsabfrage).'));

  // --- Im WLAN: Bild für Bild abholen (dort schnell genug und einfach). ---
  async function loop() {
    if (running) return;
    running = true;
    try {
      while (active() && !conn.tunneled) {
        const t0 = performance.now();
        try {
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const w = Math.round(Math.min(2560, Math.max(160, view.clientWidth * dpr)));
          const h = Math.round(Math.min(2560, Math.max(120, view.clientHeight * dpr)));
          const res = await conn.apiFetch(`api/screen/frame?t=${token()}&w=${w}&h=${h}&z=${prefs.zoom}&q=60`, { cache: 'no-store' });
          if (res.status === 401) { setMsg('Nicht angemeldet.'); break; }
          if (!res.ok) {
            setMsg('Der Bildschirm ist gerade gesperrt oder geschützt (z. B. Sperrbildschirm oder Windows-Sicherheitsabfrage).');
            await sleep(1000);
            continue;
          }
          const idx = +(res.headers.get('X-Screen-Index') ?? 0);
          const count = +(res.headers.get('X-Screen-Count') ?? 1);
          await show({ blob: await res.blob(), idx, count });
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

  const kick = () => {
    render();
    syncStream();
    if (active() && !conn.tunneled) loop();
  };
  window.addEventListener('resize', () => setTimeout(kick, 300));

  toggle.addEventListener('click', () => {
    prefs.on = !prefs.on;
    save();
    if (prefs.on) conn.send({ t: 'screen.list' });
    kick();
  });
  zoomBtn.addEventListener('click', () => {
    prefs.zoom = prefs.zoom >= 4 ? 1 : prefs.zoom + 1;
    save();
    kick();
  });

  // Starten/stoppen, wenn der Reiter gewechselt wird, die App in den Hintergrund geht oder die Verbindung kommt.
  new MutationObserver(kick).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', kick);
  conn.addEventListener('state', (e) => {
    if (e.detail.state !== 'online') streamKey = ''; // neue Verbindung = neuer Strom
    if (e.detail.state === 'online' && prefs.on) conn.send({ t: 'screen.list' });
    kick();
  });

  setMsg('');
  render();
}
