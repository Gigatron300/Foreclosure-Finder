const STREETVIEW_CACHE = 'camden-streetview-v2';
const MAX_CACHE_ENTRIES = 600;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('camden-streetview-') && k !== STREETVIEW_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_CACHE_ENTRIES) return;
  const overflow = keys.length - MAX_CACHE_ENTRIES;
  for (let i = 0; i < overflow; i += 1) {
    await cache.delete(keys[i]);
  }
}

function normalizeStreetViewUrl(rawUrl) {
  const normalized = new URL(rawUrl);
  normalized.searchParams.delete('cb');
  return normalized.toString();
}

async function cacheFirstStreetView(request) {
  const normalizedUrl = normalizeStreetViewUrl(request.url);
  const normalizedRequest = new Request(normalizedUrl, { method: 'GET', mode: 'no-cors' });
  const isBypass = new URL(request.url).searchParams.has('cb');

  const cache = await caches.open(STREETVIEW_CACHE);
  if (!isBypass) {
    const cached = await cache.match(normalizedRequest);
    if (cached) return cached;
  }

  const response = await fetch(request);
  if (response && (response.ok || response.type === 'opaque')) {
    await cache.put(normalizedRequest, response.clone());
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
