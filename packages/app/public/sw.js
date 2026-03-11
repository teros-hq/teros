// Service Worker for Teros PWA
const CACHE_NAME = 'teros-v1';

// Install event - cache basic assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(['/', '/manifest.json', '/icon-192.png', '/icon-512.png']);
    }),
  );
  // Activate immediately
  self.skipWaiting();
});

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
      );
    }),
  );
  // Take control immediately
  self.clients.claim();
});

// Fetch event - network first, fallback to cache
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip service worker for API calls - let them go directly to network
  if (url.pathname.startsWith('/api/') || url.hostname !== self.location.hostname) {
    return; // Don't call respondWith, let browser handle normally
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Clone and cache successful responses
        if (response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Fallback to cache, or return offline response
        return caches.match(event.request).then((cached) => {
          return cached || new Response('Offline', { status: 503 });
        });
      }),
  );
});
