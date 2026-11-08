// Guarda la app, la librería y el modelo de manos para que abra rápido y funcione sin conexión
// (el dictado por voz igual puede necesitar internet según el celular).
const CACHE = "puente-lsa-v2";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  const own = url.origin === location.origin;
  if (own) {
    // red primero para la app propia (así llegan las actualizaciones), caché si no hay conexión
    e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html"))));
  } else if (/cdn\.jsdelivr\.net|storage\.googleapis\.com/.test(url.host)) {
    // caché primero para librería y modelo (versión fija)
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return r; })));
  }
});
