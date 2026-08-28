/* LUMA service worker — offline shell. Photos and LUTs live in IndexedDB, not here. */
const CACHE = 'luma-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/base.css',
  './styles/app.css',
  './src/main.js',
  './src/camera.js',
  './src/capture.js',
  './src/billing.js',
  './src/pricing.js',
  './src/video.js',
  './src/store.js',
  './src/gl/renderer.js',
  './src/gl/shaders.js',
  './src/lut/cube.js',
  './src/lut/grade.js',
  './src/lut/presets.js',
  './src/ui/ui.js',
  './src/ui/paywall.js',
  './assets/icon-180.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  // network-first so a deploy is picked up immediately, cache as the fallback
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
