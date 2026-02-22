// ── Bocy Service Worker ──
// Network-first strategy: always try the network, fall back to cache.
// On new deploys the SW file itself changes (BUILD_ID below is replaced
// at build time), which triggers the browser's byte-diff check and
// starts the update flow.

const CACHE_NAME = 'bocy-v1';

// Assets that should be cached for offline fallback.
// Everything else uses network-first and is only cached opportunistically.
const PRECACHE = [
  '/',
  '/manifest.json',
];

// ── Install: precache shell ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  // Activate immediately — don't wait for old tabs to close.
  self.skipWaiting();
});

// ── Activate: clean old caches ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  // Claim all open tabs so the new SW controls them immediately.
  self.clients.claim();

  // Notify all clients that a new version is active.
  self.clients.matchAll({ type: 'window' }).then((clients) => {
    for (const client of clients) {
      client.postMessage({ type: 'SW_UPDATED' });
    }
  });
});

// ── Fetch: network-first with cache fallback ──
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET and API/auth requests — let them go straight to network.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache a clone of successful responses for offline fallback.
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => {
        // Network failed — try cache.
        return caches.match(request).then((cached) => {
          return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
        });
      })
  );
});
