const CACHE_NAME = 'readit-cache-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  // Add more static files if needed (e.g. CSS, icons)
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // For API requests, cache first for /api/articles/, network first for others
  if (event.request.url.includes('/api/articles/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const res = await fetch(event.request);
          cache.put(event.request, res.clone());
          return res;
        } catch (e) {
          return new Response(JSON.stringify({ error: 'Offline and not cached' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        }
      })
    );
    return;
  }
  // For other API requests, network first, fallback to cache
  if (event.request.url.includes('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  // For other requests, cache first
  event.respondWith(
    caches.match(event.request).then(res => res || fetch(event.request))
  );
});
