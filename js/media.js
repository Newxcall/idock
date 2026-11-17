// Medien: aktueller Titel mit Cover, Wiedergabe-Tasten, Fortschritt, Lautstärke und Helligkeit.

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

/** Ruft fn höchstens alle `ms` Millisekunden auf, der letzte Wert kommt immer an. */
function throttle(fn, ms) {
  let last = 0, timer = null, pending;
  return (v) => {
    pending = v;
    const wait = last + ms - Date.now();
    if (wait <= 0) { last = Date.now(); fn(v); return; }
    clearTimeout(timer);
    timer = setTimeout(() => { last = Date.now(); fn(pending); }, wait);
  };
}

export function initMedia({ root, conn }) {
  const $ = (s) => root.querySelector(s);
  const el = {
    bg: $('.media-bg'), cover: $('.media-cover'), coverImg: $('.media-cover img'),
    title: $('.media-title'), artist: $('.media-artist'), app: $('.media-app'),
    seek: $('#media-seek'), pos: $('.media-pos'), dur: $('.media-dur'),
    prev: $('#media-prev'), play: $('#media-play'), next: $('#media-next'),
    vol: $('#media-vol'), mute: $('#media-mute'), volVal: $('.media-volval'),
    bri: $('#media-bri'), briVal: $('.media-brival'), briNote: $('.media-brinote'), briRow: $('.media-brirow'),
  };

  let state = { has: false };
  let posBase = 0, posAt = 0;        // Position laut PC und wann sie kam
  let seeking = false, volDrag = false, briDrag = false;
  let volume = { level: 0, muted: false, supported: false };
  const token = () => encodeURIComponent(conn.token || '');

  const curPos = () => {
    if (!state.has) return 0;
    let p = posBase + (state.playing ? (Date.now() - posAt) / 1000 : 0);
    return state.dur > 0 ? Math.min(p, state.dur) : p;
  };

  function renderProgress() {
    if (seeking) return;
    const p = curPos();
    el.seek.value = state.dur > 0 ? String(p / state.dur * 1000) : '0';
    el.pos.textContent = fmt(p);
    paintRange(el.seek);
  }

  function paintRange(input) {
    const pct = (input.value - input.min) / (input.max - input.min) * 100;
    input.style.setProperty('--fill', pct + '%');
  }

  function render() {
    root.classList.toggle('no-session', !state.has);
    el.title.textContent = state.has ? (state.title || 'Unbekannter Titel') : 'Gerade läuft nichts';
    el.artist.textContent = state.has ? (state.artist || '') : 'Starte Musik oder ein Video am PC.';
    el.app.textContent = state.has && state.app ? state.app : '';
    el.play.classList.toggle('playing', !!state.playing);
    el.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Abspielen');
    el.prev.disabled = state.has && !state.canPrev;
    el.next.disabled = state.has && !state.canNext;
    el.seek.disabled = !state.canSeek;
    el.dur.textContent = state.dur > 0 ? fmt(state.dur) : '–:––';

    if (state.cover) {
      const url = `api/media/cover?t=${token()}&v=${state.cover}`;
      if (el.coverImg.dataset.v !== state.cover) {
        el.coverImg.dataset.v = state.cover;
        const v = state.cover;
        conn.imageUrl(url).then((u) => {
          if (el.coverImg.dataset.v !== v) return;
          el.coverImg.src = u;
          el.bg.style.backgroundImage = `url("${u}")`;
        }).catch(() => { });
      }
      el.cover.classList.add('has-img');
    } else {
      el.coverImg.removeAttribute('src');
      el.coverImg.dataset.v = '';
      el.bg.style.backgroundImage = '';
      el.cover.classList.remove('has-img');
    }
    renderProgress();
  }

  function renderVolume() {
    if (!volDrag) el.vol.value = String(volume.level);
    el.vol.disabled = !volume.supported;
    el.volVal.textContent = volume.supported ? `${volume.muted ? 0 : volume.level}` : '–';
    el.mute.classList.toggle('muted', volume.muted || volume.level === 0);
    root.classList.toggle('vol-muted', volume.muted);
    paintRange(el.vol);
  }

  conn.on('media', (m) => {
    state = m;
    posBase = m.pos || 0;
    posAt = Date.now();
    render();
  });
  conn.on('volume', (m) => { volume = m; renderVolume(); });
  conn.on('brightness', (m) => {
    el.briRow.classList.toggle('unsupported', !m.supported);
    el.bri.disabled = !m.supported;
    el.briNote.hidden = !!m.supported;
    if (!briDrag) el.bri.value = String(m.level);
    el.briVal.textContent = m.supported ? String(m.level) : '–';
    paintRange(el.bri);
  });
  conn.addEventListener('state', (e) => { if (e.detail.state === 'online') conn.send({ t: 'media.get' }); });

  // Fortschritt weiterlaufen lassen (Intervall statt Animation, läuft auch im Hintergrund-Tab zuverlässig).
  setInterval(() => { if (!root.hidden && state.playing) renderProgress(); }, 500);

  // Tasten
  const tap = (btn, fn) => btn.addEventListener('click', () => {
    fn();
    btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump');
  });
  tap(el.play, () => {
    // Sofort umschalten, der PC bestätigt kurz danach.
    if (state.has) { posBase = curPos(); posAt = Date.now(); state.playing = !state.playing; render(); }
    conn.send({ t: 'media.cmd', a: 'toggle' });
  });
  tap(el.prev, () => conn.send({ t: 'media.cmd', a: 'prev' }));
  tap(el.next, () => conn.send({ t: 'media.cmd', a: 'next' }));

  // Spulen
  el.seek.addEventListener('input', () => {
    seeking = true;
    el.pos.textContent = fmt(el.seek.value / 1000 * state.dur);
    paintRange(el.seek);
  });
  el.seek.addEventListener('change', () => {
    const p = el.seek.value / 1000 * state.dur;
    posBase = p; posAt = Date.now();
    seeking = false;
    conn.send({ t: 'media.seek', pos: Math.round(p * 10) / 10 });
    renderProgress();
  });

  // Lautstärke
  const sendVol = throttle((v) => conn.send({ t: 'volume.set', level: v }), 80);
  el.vol.addEventListener('input', () => {
    volDrag = true;
    volume.level = +el.vol.value;
    if (volume.level > 0) volume.muted = false;
    renderVolume();
    sendVol(volume.level);
  });
  el.vol.addEventListener('change', () => { volDrag = false; sendVol(+el.vol.value); });
  el.mute.addEventListener('click', () => {
    volume.muted = !volume.muted;
    renderVolume();
    conn.send({ t: 'volume.mute', muted: volume.muted });
  });

  // Helligkeit
  const sendBri = throttle((v) => conn.send({ t: 'brightness.set', level: v }), 120);
  el.bri.addEventListener('input', () => {
    briDrag = true;
    el.briVal.textContent = el.bri.value;
    paintRange(el.bri);
    sendBri(+el.bri.value);
  });
  el.bri.addEventListener('change', () => { briDrag = false; sendBri(+el.bri.value); });

  render();
  renderVolume();
  [el.seek, el.vol, el.bri].forEach(paintRange);
}
