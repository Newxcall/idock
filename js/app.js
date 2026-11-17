// iDock – Startpunkt der iPhone-Oberfläche.
import { Connection } from './connection.js';
import { setRemoteMode, remoteOnly, formatCode, normalizeCode } from './remote.js';
import { initTouchpad, loadSettings, saveSettings, DEFAULTS } from './touchpad.js';
import { initKeyboard } from './keyboard.js';
import { initDock } from './dock.js';
import { initMedia } from './media.js';
import { initScreen } from './screen.js';
import { initClipboard } from './clipboard.js';

const $ = (sel) => document.querySelector(sel);
const conn = new Connection();
window.idock = conn; // zum Ausprobieren in der Konsole

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPad meldet sich wie ein Mac
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  return 'Browser';
}

/* ---------------- Bildschirme ---------------- */

function showScreen(id) {
  $('#pair').hidden = id !== 'pair';
  $('#main').hidden = id !== 'main';
  if (id === 'pair') resetPin();
}

/* ---------------- PIN-Eingabe ---------------- */

const pinInput = $('#pin-input');
const pinBoxes = $('.pin-boxes');
const pinSpans = [...pinBoxes.querySelectorAll('span')];
const pairBtn = $('#pair-btn');
const pairMsg = $('#pair-msg');
let pairing = false;

const codeInput = $('#code-input');
// Fernzugriff: zusätzlich der Kopplungscode (steht im iDock-Fenster und steckt im QR-Code als #p=…).
if (conn.remote) {
  $('#code-row').hidden = false;
  $('#pair-text').innerHTML = 'Gib den Kopplungscode und die PIN ein,<br>die am PC im iDock-Fenster stehen.';
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('p') || new URLSearchParams(location.search).get('p');
  if (fromLink) codeInput.value = formatCode(fromLink);
}
const codeOk = () => !conn.remote || normalizeCode(codeInput.value).length === 12;
codeInput.addEventListener('input', () => {
  codeInput.value = formatCode(codeInput.value);
  codeInput.classList.remove('error');
  setPairMsg('');
  renderPin();
  if (normalizeCode(codeInput.value).length === 12 && pinInput.value.length < 6) pinInput.focus();
});

function renderPin() {
  const v = pinInput.value;
  pinSpans.forEach((s, i) => {
    s.textContent = v[i] || '';
    s.classList.toggle('cur', document.activeElement === pinInput && i === Math.min(v.length, 5));
  });
  pairBtn.disabled = v.length !== 6 || !codeOk() || pairing;
}

function resetPin() {
  pinInput.value = '';
  pinBoxes.classList.remove('error');
  renderPin();
}

function setPairMsg(text, isError = false) {
  pairMsg.textContent = text;
  pairMsg.classList.toggle('error', isError);
}

pinInput.addEventListener('input', () => {
  pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 6);
  pinBoxes.classList.remove('error');
  setPairMsg('');
  renderPin();
  if (pinInput.value.length === 6 && codeOk()) doPair();
});
pinInput.addEventListener('focus', renderPin);
pinInput.addEventListener('blur', renderPin);
pairBtn.addEventListener('click', doPair);

async function doPair() {
  if (pairing || pinInput.value.length !== 6 || !codeOk()) return;
  pairing = true;
  renderPin();
  setPairMsg(conn.remote ? 'Suche deinen PC über das Internet …' : 'Verbinde …');
  $('#pair-diag').textContent = '';
  const r = await conn.pair(pinInput.value, deviceName(), codeInput.value);
  pairing = false;
  if (r.ok) {
    pinInput.blur();
    setPairMsg('');
    // Kopplungscode aus der Adresse entfernen (wird nicht mehr gebraucht).
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    return; // der Statuswechsel zeigt den Hauptbildschirm
  }
  $('#pair-diag').textContent = r.diag ? 'Technik: ' + r.diag : '';
  if (r.error === 'code' || r.error === 'notfound') codeInput.classList.add('error');
  else pinBoxes.classList.add('error');
  if (r.error === 'wrong') setPairMsg(`Falsche PIN. Noch ${r.attemptsLeft} Versuch(e).`, true);
  else if (r.error === 'locked') setPairMsg(`Zu viele Versuche. Bitte ${r.seconds} s warten.`, true);
  else if (r.error === 'network') setPairMsg('PC nicht erreichbar. Läuft iDock am PC?', true);
  else if (r.error === 'code') setPairMsg('Der Kopplungscode hat 12 Zeichen (z. B. K7Q2-9XMP-4ZRT).', true);
  else if (r.error === 'nodirect') setPairMsg('PC gefunden, aber über dieses Netz kommt keine direkte Verbindung zustande. Bitte mach ein Bildschirmfoto davon.', true);
  else if (r.error === 'notfound') setPairMsg('PC nicht gefunden. Stimmt der Kopplungscode? Läuft iDock am PC mit Häkchen „Auch unterwegs verbinden“?', true);
  else setPairMsg('Das hat nicht geklappt. Bitte noch einmal.', true);
  setTimeout(() => { pinInput.value = ''; renderPin(); }, 600);
}

// Hinweis „Zum Home-Bildschirm“
const hint = $('#install-hint');
let hintClosed = false;
try { hintClosed = localStorage.getItem('idock.hintClosed') === '1'; } catch { }
hint.hidden = !isIOS || isStandalone || hintClosed;
// Unterwegs: Die Home-Bildschirm-App hat einen eigenen Speicher – dort wird gekoppelt, Code also merken.
if (conn.remote) hint.querySelector('.hint-more').hidden = false;
hint.querySelector('.hint-close').addEventListener('click', () => {
  hint.hidden = true;
  try { localStorage.setItem('idock.hintClosed', '1'); } catch { }
});

/* ---------------- Tabs ---------------- */

const TAB_TITLES = { home: 'Start', touchpad: 'Touchpad', keyboard: 'Tastatur', dock: 'Dock', media: 'Medien', clipboard: 'Ablage' };

function selectTab(name) {
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.dataset.panel !== name; });
  $('#tab-title').textContent = TAB_TITLES[name];
  try { localStorage.setItem('idock.tab', name); } catch { }
}
document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => selectTab(b.dataset.tab)));
try { const t = localStorage.getItem('idock.tab'); if (TAB_TITLES[t]) selectTab(t); } catch { }

/* ---------------- Verbindungsstatus ---------------- */

const pill = $('#status-pill');
const banner = $('#offline-banner');
let offlineTicker = null;

conn.addEventListener('state', (e) => {
  const { state, delay } = e.detail;
  clearInterval(offlineTicker);

  if (state === 'unpaired') { showScreen('pair'); return; }
  if ($('#main').hidden) showScreen('main');

  pill.dataset.state = state;
  const label = pill.querySelector('span');
  const dot = $('#home-dot');
  dot.className = 'big-dot ' + (state === 'online' ? 'online' : state === 'offline' ? 'offline' : '');

  if (state === 'online') {
    label.textContent = conn.info.remote ? 'Fernzugriff' : 'Verbunden';
    banner.hidden = true;
    $('#home-title').textContent = `Verbunden mit ${conn.info.pc}`;
    $('#home-sub').textContent = (conn.info.remote ? 'Über das Internet (Fernzugriff). ' : '') +
      'Alles bereit. Bricht die Verbindung ab, verbindet sich iDock von selbst neu.';
  } else if (state === 'connecting') {
    label.textContent = 'Verbinde …';
    $('#home-title').textContent = 'Verbinde mit dem PC …';
    $('#home-sub').textContent = 'Einen Moment.';
  } else if (state === 'offline') {
    label.textContent = 'Getrennt';
    banner.hidden = false;
    $('#home-title').textContent = 'Keine Verbindung';
    $('#home-sub').textContent = conn.remote
      ? 'Läuft iDock am PC und ist der PC mit dem Internet verbunden?'
      : 'Läuft iDock am PC? Sind iPhone und PC im selben WLAN?';
    if (conn.lastDiag) $('#home-sub').textContent += ' (Technik: ' + conn.lastDiag + ')';
    $('#offline-diag').textContent = conn.lastDiag ? 'Technik: ' + conn.lastDiag : '';
    let left = Math.ceil(delay / 1000);
    const txt = $('#offline-text');
    const tick = () => { txt.textContent = left > 0 ? `Getrennt – neuer Versuch in ${left} s` : 'Verbinde neu …'; left--; };
    tick();
    offlineTicker = setInterval(tick, 1000);
  }
});

$('#reconnect-btn').addEventListener('click', () => conn.reconnectNow());
pill.addEventListener('click', () => conn.reconnectNow());

/* ---------------- Touchpad ---------------- */

let tpSettings = loadSettings();
initTouchpad({
  pad: $('#pad'),
  leftBtn: $('#pad-left'),
  rightBtn: $('#pad-right'),
  dragBadge: $('#drag-badge'),
  conn,
  getSettings: () => tpSettings,
});
initScreen({ panel: $('#touchpad'), conn });

/* ---------------- Hinweis-Meldung ---------------- */

const toastEl = $('#toast');
let toastTimer = null;
function toast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

/* ---------------- Dock ---------------- */

initDock({ root: $('#dock'), conn, toast });

/* ---------------- Medien ---------------- */

initMedia({ root: $('#media'), conn });

/* ---------------- Zwischenablage ---------------- */

initClipboard({ root: $('#clip'), conn, toast });

/* ---------------- Tastatur ---------------- */

initKeyboard({ root: $('#kb'), conn });

// iOS: Wenn die Bildschirmtastatur offen ist, die App auf den sichtbaren Bereich darüber verkleinern.
const mainEl = $('#main');
function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const open = document.activeElement === $('#kb-input') && vv.height < window.innerHeight - 100;
  document.body.classList.toggle('kb-open', open);
  mainEl.style.height = open ? vv.height + 'px' : '';
  mainEl.style.transform = open ? `translateY(${vv.offsetTop}px)` : '';
  if (open) window.scrollTo(0, 0);
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', syncViewport);
  visualViewport.addEventListener('scroll', syncViewport);
}
$('#kb-input').addEventListener('focus', () => { syncViewport(); setTimeout(syncViewport, 350); });
$('#kb-input').addEventListener('blur', () => setTimeout(syncViewport, 50));

const TP_FIELDS = {
  '#tp-speed': 'speed', '#tp-accel': 'accel', '#tp-scroll': 'scrollSpeed',
  '#tp-natural': 'natural', '#tp-fine': 'fineScroll', '#tp-inertia': 'inertia', '#tp-tap': 'tapToClick',
};
function fillTouchpadSettings() {
  for (const [sel, key] of Object.entries(TP_FIELDS)) {
    const el = $(sel);
    if (el.type === 'checkbox') el.checked = !!tpSettings[key];
    else el.value = tpSettings[key];
  }
}
for (const [sel, key] of Object.entries(TP_FIELDS)) {
  $(sel).addEventListener('input', (e) => {
    const el = e.target;
    tpSettings = { ...tpSettings, [key]: el.type === 'checkbox' ? el.checked : parseFloat(el.value) };
    saveSettings(tpSettings);
  });
}
$('#tp-reset').addEventListener('click', () => {
  tpSettings = { ...DEFAULTS };
  saveSettings(tpSettings);
  fillTouchpadSettings();
});

/* ---------------- Aktualisieren ---------------- */

// Welche Version der Oberfläche gerade geladen ist (setzt der PC beim Ausliefern ein).
const PAGE_BUILD = document.querySelector('meta[name="idock-build"]')?.content || '';
const RELOAD_KEY = 'idock.reloadedFor';

function reloadApp() {
  // Ein Zeitstempel in der Adresse zwingt iOS, die Seite wirklich neu vom PC zu holen.
  const url = new URL(location.href);
  url.searchParams.set('u', Date.now().toString(36));
  url.searchParams.delete('remote'); // ist schon gespeichert; sonst ließe sich der Schalter nicht ausschalten
  location.replace(url.toString());
}

// Läuft am PC eine neuere iDock-Version als die geladene Seite → automatisch neu laden.
// Schutz gegen Endlosschleifen: pro PC-Version höchstens einmal in 30 Sekunden.
conn.addEventListener('state', (e) => {
  if (e.detail.state !== 'online') return;
  const build = conn.info.build;
  if (!build || !PAGE_BUILD || PAGE_BUILD.startsWith('__') || build === PAGE_BUILD) return;
  if (remoteOnly()) return; // Seite aus dem Internet: wird dort aktualisiert, nicht vom PC
  let last = {};
  try { last = JSON.parse(localStorage.getItem(RELOAD_KEY) || '{}'); } catch { }
  if (last.build === build && Date.now() - last.at < 30000) return;
  try { localStorage.setItem(RELOAD_KEY, JSON.stringify({ build, at: Date.now() })); } catch { }
  reloadApp();
});

// Adresse nach dem Neuladen wieder aufräumen (der Zeitstempel soll nicht stehen bleiben).
if (new URL(location.href).searchParams.has('u')) {
  const clean = new URL(location.href);
  clean.searchParams.delete('u');
  history.replaceState(null, '', clean.toString());
}

/* ---------------- Einstellungen ---------------- */

const sheet = $('#sheet');
$('#settings-btn').addEventListener('click', () => {
  fillTouchpadSettings();
  $('#set-pc').textContent = conn.info.pc || '–';
  $('#set-device').textContent = conn.info.device || deviceName();
  $('#set-host').textContent = conn.tunneled ? 'Internet (Fernzugriff)' : location.host;
  // WLAN-Seite vom PC: Weg zur App für unterwegs zeigen.
  const pages = !remoteOnly() && conn.info.pages;
  $('#pages-link').hidden = $('#pages-note').hidden = !pages;
  if (pages) $('#pages-link').href = pages;
  $('#set-remote').checked = conn.remote;
  $('#set-remote').disabled = remoteOnly();
  $('#set-version').textContent = (conn.info.version || '–') + (PAGE_BUILD && !PAGE_BUILD.startsWith('__') ? ` (${PAGE_BUILD.slice(0, 6)})` : '');
  sheet.hidden = false;
});
$('#sheet-close').addEventListener('click', () => { sheet.hidden = true; });
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.hidden = true; });
$('#set-remote').addEventListener('change', (e) => {
  setRemoteMode(e.target.checked);
  reloadApp();
});
$('#update-btn').addEventListener('click', async () => {
  $('#update-btn').textContent = 'Wird aktualisiert …';
  // Seite aus dem Internet: erst den Offline-Speicher erneuern lassen.
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await Promise.race([reg.update(), new Promise((r) => setTimeout(r, 4000))]);
  } catch { }
  reloadApp();
});

// Seite aus dem Internet (GitHub Pages): für den Start ohne Netz zwischenspeichern.
if (remoteOnly() && 'serviceWorker' in navigator) {
  // Neue Version im Offline-Speicher übernommen → einmal neu laden, damit alle Dateien zusammenpassen.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    try { if (sessionStorage.getItem('idock.swReload') === PAGE_BUILD) return; sessionStorage.setItem('idock.swReload', PAGE_BUILD); } catch { }
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').catch(() => { });
}
$('#forget-btn').addEventListener('click', () => {
  if (!confirm('Von diesem PC abmelden? Danach brauchst du wieder die PIN.')) return;
  sheet.hidden = true;
  conn.forget();
});

// iOS: Doppeltipp-Zoom und Gummiband-Scrollen der ganzen Seite verhindern.
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

/* ---------------- Start ---------------- */

conn.connect();
