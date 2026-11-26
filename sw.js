// Propertyopoly service worker: keeps the game playable offline.
// Pages load from the network when it's available, so updates arrive right away,
// and fall back to the saved copy when it isn't. The game itself checks version.json
// for new releases (see checkForUpdate in index.html), so that file is never cached here.
// Bump VERSION when the cached file list changes.
const VERSION = 'propertyopoly-v3';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/version.json')) return;
  if (req.mode === 'navigate') {
    // cache: 'no-store' skips the browser's own cache (GitHub Pages allows ten minutes of it),
    // so a reload after an update always brings the new version.
    e.respondWith(fetch(req, { cache: 'no-store' }).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put('index.html', copy));
      return res;
    }).catch(() => caches.match('index.html', { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  })));
});
