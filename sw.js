const CACHE_NAME = "cocina-qb-v138";

const PRECACHE = [
  "./",
  "./index.html",
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
  "./data/config.json",
  "./data/supervisors.json",
  "./data/lotes_catalogo.json",
  "./assets/logo-qberries.png",
];

async function putFresh(cache, path) {
  try {
    const res = await fetch(path, { cache: "reload" });
    if (res.ok) await cache.put(path, res);
  } catch {
    /* offline */
  }
}

async function refreshPrecache() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(PRECACHE.map((path) => putFresh(cache, path)));
}

function isAppFile(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  return (
    p.endsWith("/") ||
    p.endsWith(".html") ||
    p.endsWith(".js") ||
    p.endsWith(".css") ||
    p.endsWith(".webmanifest") ||
    p.includes("/data/")
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    refreshPrecache().then(() => self.skipWaiting())
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
  if (url.origin !== self.location.origin) return;

  if (isAppFile(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
  if (event.data === "CLEAR_APP_CACHE") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    );
  }
  if (event.data === "PULL_LATEST") {
    event.waitUntil(refreshPrecache());
  }
});
