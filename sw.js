// Guarda la app en el teléfono para que abra sin señal.
// Al cambiar archivos de la app, sube el número de versión para forzar la actualización.
const CACHE = 'levantamientos-v1.0.0';
const ARCHIVOS = ['./', './index.html', './styles.css', './app.js', './db.js', './config.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Primero la copia guardada (rápido y sin señal); en segundo plano se actualiza si hay red.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const guardada = await c.match(e.request, { ignoreSearch: true });
      const red = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => guardada);
      return guardada || red;
    })
  );
});
