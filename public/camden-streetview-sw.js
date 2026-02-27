const STREETVIEW_CACHE = 'camden-streetview-v1';
const MAX_CACHE_ENTRIES = 600;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_CACHE_ENTRIES) return;
  const overflow = keys.length - MAX_CACHE_ENTRIES;
  for (let i = 0; i < overflow; i += 1) {
    await cache.delete(keys[i]);
  }
}

async function cacheFirstStreetView(request) {
  const cache = await caches.open(STREETVIEW_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && (response.ok || response.type === 'opaque')) {
    await cache.put(request, response.clone());
    await trimCache(cache);
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isStreetView =
    url.hostname === 'maps.googleapis.com' &&
    url.pathname === '/maps/api/streetview';

  if (!isStreetView || event.request.method !== 'GET') return;

  event.respondWith(
    cacheFirstStreetView(event.request).catch(() => fetch(event.request))
  );
});
