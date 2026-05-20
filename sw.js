// Stockify Pro Ultra — Service Worker for offline support (v2)
const CACHE = "stockify-v2";
const CORE = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable.png",
  "./sabbir.jpg",
  "https://cdn.tailwindcss.com",
  "https://unpkg.com/lucide@latest",
  "https://unpkg.com/html5-qrcode",
  "https://cdn.jsdelivr.net/npm/chart.js",
  "https://www.gstatic.com/firebasejs/9.22.1/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore-compat.js",
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(CORE.map(u => c.add(u).catch(() => null)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for Firestore / Cloudinary (live data), cache-first for app shell
self.addEventListener("fetch", e => {
  const url = e.request.url;
  if (
    url.includes("firestore.googleapis.com") ||
    url.includes("cloudinary.com") ||
    url.includes("googleapis.com/identitytoolkit")
  ) return; // let the browser handle (Firestore has its own offline cache)

  e.respondWith(
    caches.match(e.request).then(cached =>
      cached ||
      fetch(e.request).then(resp => {
        const copy = resp.clone();
        if (resp.ok && e.request.method === "GET") {
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => cached)
    )
  );
});
