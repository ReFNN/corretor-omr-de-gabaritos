/**
 * sw.js — Service Worker (PWA).
 * Faz cache do shell do app e dos assets estáticos.
 * O WASM do OpenCV (~8 MB) também é cacheado após o primeiro carregamento.
 */

const CACHE  = 'omr-v2';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/layout.js',
  './js/layout-compact.js',
  './js/db.js',
  './js/generator.js',
  './js/omr.js',
  './manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  // Estratégia: cache-first para assets; network-first para navegação
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('./index.html')),
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // Cachear OpenCV WASM quando baixado
        if (res.ok && e.request.url.includes('opencv')) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    }),
  );
});
