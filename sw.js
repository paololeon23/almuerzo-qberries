const CACHE_NAME = "cocina-qb-v110";

const PRECACHE = [
  "./",
  "./index.html",
  "./install.html",
  "./setup.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/app.js",
  "./js/config.js",
  "./js/device.js",
  "./js/store.js",
  "./js/voice.js",
  "./js/calc.js",
  "./js/sync.js",
  "./js/scanner.js",
  "./js/setup.js",
  "./js/vendor/qrcode.js",
  "./js/vendor/jsqr.js",
  "./data/config.json",
  "./data/trabajadores.json",
  "./data/supervisors.json",
  "./data/lotes_catalogo.json",
  "./assets/logo-qberries.png",
  "./assets/entrada.png",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => null)));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isData = url.pathname.includes("/data/");

  if (isData) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && url.origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "CLEAR_APP_CACHE") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    );
  }
});
