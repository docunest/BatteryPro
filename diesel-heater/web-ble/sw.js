// Offline copy of the app. Always asks the server first (bypassing the browser's HTTP
// cache, which GitHub Pages sets to 10 minutes) so updates show up on the next reload.
const CACHE = "heater-v5";
const FILES = ["./", "index.html", "protocol.js", "victron.js", "victron-ui.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", (e) =>
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) =>
  e.waitUntil(caches.keys().then((ks) =>
    // Other apps may share this origin (e.g. GitHub Pages); only touch our own caches.
    Promise.all(ks.filter((k) => k.startsWith("heater-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return r;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })));
});
