const CACHE_NAME = "cocina-qb-v166";

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
  "./js/vendor/jsqr.js",
  "./data/config.json",
  "./data/supervisors.json",
  "./data/trabajadores.json",
  "./assets/logo-qberries.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function wantsNetwork(req) {
  return req.cache === "reload" || req.cache === "no-store";
}

function netFetch(req, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(req, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function copyOldCaches(dest) {
  const keys = await caches.keys();
  for (const key of keys) {
    if (key === CACHE_NAME) continue;
    const src = await caches.open(key);
    const reqs = await src.keys();
    await Promise.all(reqs.map(async (r) => {
      const res = await src.match(r);
      if (res) await dest.put(r, res.clone());
    }));
  }
}

async function putFresh(cache, path) {
  try {
    const res = await fetch(path, { cache: "reload" });
    if (res.ok) await cache.put(path, res);
  } catch {
    /* sin red: se queda lo copiado */
  }
}

async function hasShell(cache) {
  const html = (await cache.match("./index.html")) || (await cache.match("./"));
  const js = await cache.match("./js/app.js");
  return !!(html && js);
}

async function refreshPrecache() {
  const cache = await caches.open(CACHE_NAME);
  await copyOldCaches(cache);
  await Promise.all(PRECACHE.map((path) => putFresh(cache, path)));
  return cache;
}

async function fromCache(req) {
  const hit = await caches.match(req, { ignoreSearch: true, ignoreVary: true });
  if (hit) return hit;
  if (req.mode === "navigate") {
    return (await caches.match("./index.html")) || (await caches.match("./"));
  }
  return undefined;
}

function putInCache(req, res) {
  if (!res || !res.ok) return;
  const copy = res.clone();
  caches.open(CACHE_NAME).then((c) => c.put(req, copy));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    refreshPrecache().then((cache) => hasShell(cache)).then((ok) => {
      if (ok) return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (await hasShell(cache)) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!sameOrigin(url)) return;

  if (wantsNetwork(req)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          putInCache(req, res);
          return res;
        })
        .catch(() => fromCache(req))
    );
    return;
  }

  event.respondWith(
    fromCache(req).then((hit) => {
      if (hit) return hit;
      return netFetch(req).then((res) => {
        putInCache(req, res);
        return res;
      });
    })
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
