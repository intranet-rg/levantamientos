// Guarda la app en el teléfono para que abra sin señal.
// Al cambiar archivos de la app, sube el número de versión para forzar la actualización.
const CACHE = 'levantamientos-v1.1.3';
const ARCHIVOS = ['./', './index.html', './styles.css', './app.js', './db.js', './config.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  // cache: 'reload' evita que se guarde una copia vieja del navegador
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(ARCHIVOS.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Con señal: siempre la versión más nueva (espera máx. 4 s). Sin señal: la copia guardada.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const guardada = await c.match(e.request, { ignoreSearch: true });
    const red = fetch(e.request, { cache: 'no-cache' }).then((r) => {
      if (r.ok) c.put(e.request, r.clone());
      return r;
    });
    if (!guardada) return red;
    const tiempo = new Promise((res) => setTimeout(() => res(null), 4000));
    try {
      const r = await Promise.race([red, tiempo]);
      return r || guardada;
    } catch (err) {
      return guardada;
    }
  })());
});
