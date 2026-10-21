// Minimal offline cache so the installed app opens without network.
const CACHE = "heater-v3";
const FILES = ["./", "index.html", "protocol.js", "victron.js", "victron-ui.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))));
self.addEventListener("activate", (e) =>
  e.waitUntil(caches.keys().then((ks) =>
    // Other apps may share this origin (e.g. GitHub Pages); only touch our own caches.
    Promise.all(ks.filter((k) => k.startsWith("heater-") && k !== CACHE).map((k) => caches.delete(k))))));
self.addEventListener("fetch", (e) => {
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
