// iDock Service Worker – erzeugt von PagesExporter, nicht von Hand ändern.
// Speichert die Seite für den Start ohne Netz. Neue Version = neuer Fingerabdruck = neuer Zwischenspeicher.
const CACHE = 'idock-14f8e06c8a';
const FILES = [
  './',
  'css/app.css?v=14f8e06c8a',
  'js/app.js?v=14f8e06c8a',
  'js/clipboard.js',
  'js/connection.js',
  'js/dock.js',
  'js/keyboard.js',
  'js/media.js',
  'js/remote.js',
  'js/screen.js',
  'js/sha256.js',
  'js/touchpad.js',
  'manifest.json',
  'index.html',
  'icon-32.png',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png'
];

self.addEventListener('install', (e) => {
  // cache: 'reload' = am Browser-Zwischenspeicher vorbei, sonst könnten nach einem Update alte Dateien hängen bleiben.
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('idock-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // Seite selbst: wenn möglich frisch aus dem Netz (dann kommen Updates sofort), sonst aus dem Speicher.
    e.respondWith(fetch(req).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});