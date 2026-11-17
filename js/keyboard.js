// Tastatur: Die iPhone-Tastatur tippt live auf dem PC. Dazu Sondertasten, Umschalttasten (Strg, Alt, ⇧, Win)
// und fertige Tastenkürzel.
//
// Trick: Das Eingabefeld enthält immer einen festen Grundinhalt (unsichtbare Zeichen). Nach jeder Eingabe
// vergleichen wir den neuen Inhalt damit: Was dazukam, wird getippt; was fehlt, wird als Rücktaste geschickt.
// So funktionieren auch Autokorrektur, Wortvorschläge und Diktat.

const BASE = '​'.repeat(8);   // 8 unsichtbare Zeichen, damit die Rücktaste immer etwas zu löschen hat

export const SHORTCUTS = [
  { label: 'Kopieren', k: 'c', mods: ['ctrl'] },
  { label: 'Einfügen', k: 'v', mods: ['ctrl'] },
  { label: 'Ausschneiden', k: 'x', mods: ['ctrl'] },
  { label: 'Rückgängig', k: 'z', mods: ['ctrl'] },
  { label: 'Wiederholen', k: 'y', mods: ['ctrl'] },
  { label: 'Alles markieren', k: 'a', mods: ['ctrl'] },
  { label: 'Suchen', k: 'f', mods: ['ctrl'] },
  { label: 'Speichern', k: 's', mods: ['ctrl'] },
  { label: 'Fenster wechseln', k: 'tab', mods: ['alt'] },
  { label: 'Desktop zeigen', k: 'd', mods: ['win'] },
  { label: 'Start-Menü', k: 'win', mods: [] },
  { label: 'Explorer', k: 'e', mods: ['win'] },
  { label: 'Bildschirmfoto', k: 's', mods: ['win', 'shift'] },
  { label: 'Task-Manager', k: 'esc', mods: ['ctrl', 'shift'] },
  { label: 'Neuer Tab', k: 't', mods: ['ctrl'] },
  { label: 'Tab schließen', k: 'w', mods: ['ctrl'] },
  { label: 'Neu laden', k: 'f5', mods: [] },
  { label: 'Fenster schließen', k: 'f4', mods: ['alt'] },
];

/**
 * Knopf, der beim Antippen den Fokus NICHT aus dem Eingabefeld nimmt (sonst schließt iOS die Tastatur).
 * repeat = true: gedrückt halten wiederholt die Taste (wie bei einer echten Tastatur).
 */
const MOVE_CANCEL = 10;   // so viele Pixel Wischen = Scrollen statt Tippen
const REPEAT_DELAY = 420;

/**
 * Taste, die sich wie eine iOS-Taste anfühlt:
 * - löst beim LOSLASSEN aus, damit man über die Tasten hinweg scrollen kann (Wischen bricht ab),
 * - wiederholbare Tasten (Löschen, Pfeile) wiederholen sich beim Gedrückthalten,
 * - die Bildschirmtastatur bleibt offen (touchend wird abgefangen, dadurch wandert der Fokus nicht).
 */
export function pressable(el, fn, { repeat = false } = {}) {
  let timer = null, interval = null, touched = false;
  let sx = 0, sy = 0, active = false, repeated = false;
  const stop = () => {
    clearTimeout(timer); clearInterval(interval);
    timer = interval = null;
    active = false;
    el.classList.remove('pressed');
  };
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) { stop(); return; }
    touched = true;
    active = true;
    repeated = false;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    el.classList.add('pressed');
    if (repeat) timer = setTimeout(() => {
      if (!active) return;
      repeated = true;
      fn();
      interval = setInterval(fn, 55);
    }, REPEAT_DELAY);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!active) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - sx) > MOVE_CANCEL || Math.abs(t.clientY - sy) > MOVE_CANCEL) stop(); // scrollt
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    const wasTap = active && !repeated;
    if (active) e.preventDefault(); // kein Fokuswechsel → Bildschirmtastatur bleibt offen
    stop();
    if (wasTap) fn();
  }, { passive: false });
  el.addEventListener('touchcancel', stop);
  // Maus (zum Ausprobieren im PC-Browser)
  el.addEventListener('mousedown', (e) => { e.preventDefault(); if (!touched) fn(); });
}

export function initKeyboard({ root, conn }) {
  const input = root.querySelector('#kb-input');
  const echo = root.querySelector('#kb-echo');
  const modButtons = [...root.querySelectorAll('[data-mod]')];

  // Umschalttasten: 1× tippen = nur für die nächste Taste, 2× schnell tippen = feststellen.
  const mods = { ctrl: 'off', alt: 'off', shift: 'off', win: 'off' }; // off | once | locked
  const lastTap = {};
  let echoText = '';
  let composing = false;

  function activeMods() { return Object.keys(mods).filter(m => mods[m] !== 'off'); }
  function renderMods() {
    for (const b of modButtons) {
      const st = mods[b.dataset.mod];
      b.classList.toggle('on', st !== 'off');
      b.classList.toggle('locked', st === 'locked');
    }
  }
  function consumeOnceMods() {
    let changed = false;
    for (const m of Object.keys(mods)) if (mods[m] === 'once') { mods[m] = 'off'; changed = true; }
    if (changed) renderMods();
  }
  for (const b of modButtons) {
    pressable(b, () => {
      const m = b.dataset.mod;
      const now = performance.now();
      if (mods[m] === 'off') mods[m] = 'once';
      else if (mods[m] === 'once' && now - (lastTap[m] || 0) < 350) mods[m] = 'locked';
      else mods[m] = 'off';
      lastTap[m] = now;
      renderMods();
    });
  }

  function showEcho(add, del = 0) {
    if (del) echoText = echoText.slice(0, Math.max(0, echoText.length - del));
    if (add) echoText += add;
    echoText = echoText.slice(-80);
    echo.textContent = echoText || 'Tippe hier, um zu schreiben';
    echo.classList.toggle('empty', !echoText);
  }

  /** Eine Taste schicken (mit den aktiven Umschalttasten). */
  function sendKey(k, extraMods = [], label = null) {
    const all = [...new Set([...activeMods(), ...extraMods])];
    conn.send({ t: 'key', k, mods: all });
    consumeOnceMods();
    if (k === 'backspace' && !all.length) showEcho('', 1);
    else if (k === 'enter' && !all.length) showEcho('↵');
    else if (label) showEcho(` [${label}] `);
  }

  function resetField() {
    input.value = BASE;
    try { input.setSelectionRange(BASE.length, BASE.length); } catch { }
  }

  function handleChange() {
    if (composing) return;
    const now = input.value;
    if (now === BASE) return;
    // gemeinsamen Anfang und gemeinsames Ende suchen
    let p = 0;
    while (p < BASE.length && p < now.length && BASE[p] === now[p]) p++;
    let s = 0;
    while (s < BASE.length - p && s < now.length - p && BASE[BASE.length - 1 - s] === now[now.length - 1 - s]) s++;
    const removed = BASE.length - p - s;
    const added = now.slice(p, now.length - s).replace(/​/g, '');
    resetField();

    const m = activeMods();
    if (removed > 0) {
      if (m.length) sendKey('backspace');
      else { conn.send({ t: 'key', k: 'backspace', n: removed }); showEcho('', removed); }
    }
    if (added) {
      if (m.length && [...added].length === 1) {
        // z. B. Strg aktiv + „c“ getippt → Strg+C
        sendKey(added.toLowerCase(), [], [...m.map(x => MOD_NAMES[x]), added.toUpperCase()].join('+'));
      } else {
        conn.send({ t: 'text', s: added });
        showEcho(added.replace(/\n/g, '↵'));
      }
    }
  }

  input.addEventListener('input', handleChange);
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; handleChange(); });
  // Cursor immer ans Ende (sonst würde man „mitten im Grundinhalt“ tippen)
  input.addEventListener('focus', () => { resetField(); root.classList.add('typing'); });
  input.addEventListener('blur', () => root.classList.remove('typing'));
  input.addEventListener('select', () => { if (input.selectionStart !== BASE.length) resetField(); });
  resetField();
  showEcho('');

  // Sondertasten
  for (const b of root.querySelectorAll('[data-key]')) {
    const repeat = ['backspace', 'delete', 'left', 'right', 'up', 'down', 'space'].includes(b.dataset.key);
    pressable(b, () => sendKey(b.dataset.key, [], null), { repeat });
  }

  // Tastenkürzel
  const list = root.querySelector('#kb-shortcuts');
  for (const sc of SHORTCUTS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.innerHTML = `<b>${sc.label}</b><small>${describe(sc)}</small>`;
    pressable(b, () => { conn.send({ t: 'key', k: sc.k, mods: sc.mods }); showEcho(` [${sc.label}] `); });
    list.appendChild(b);
  }

  // Tastatur ausblenden
  pressable(root.querySelector('#kb-hide'), () => input.blur());

  return { focus: () => input.focus() };
}

const MOD_NAMES = { ctrl: 'Strg', alt: 'Alt', shift: '⇧', win: 'Win' };
const KEY_NAMES = { tab: 'Tab', esc: 'Esc', win: 'Win', f4: 'F4', f5: 'F5' };
function describe(sc) {
  const parts = sc.mods.map(m => MOD_NAMES[m]);
  parts.push(KEY_NAMES[sc.k] || sc.k.toUpperCase());
  return parts.join(' + ');
}
