const CACHE = "nasc-sports-v6";
const ASSETS = [
  "./",
  "./index.html",
  "./achievements.html",
  "./achievements.js",
  "./sport-picker.js",
  "./staff-login.html",
  "./staff-dashboard.html",
  "./404.html",
  "./styles.css",
  "./app.js",
  "./staff-login.js",
  "./staff-dashboard.js",
  "./manifest.json",
];

self.addEventListener("install", (e) => {
  // Cache each asset individually and keep going even if one is temporarily
  // unavailable (e.g. `/` returns 503 while maintenance mode is on), so the
  // service worker still installs and activates.
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(
        ASSETS.map((a) => fetch(a).then((res) => { if (res.ok) return c.put(a, res); }).catch(() => {}))
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.pathname.indexOf("/api/") !== -1) return;

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // Cache each page under ITS OWN url, and only successful responses
          // (503 maintenance / 404 pages must never be cached as stale).
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
    )
  );
});