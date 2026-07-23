/**
 * Marginalia Service Worker
 * Cache-first for app shell, network-first for API calls
 */
const CACHE_NAME = 'marginalia-v5';

const APP_SHELL = [
  '.',
  'index.html',
  'app.js',
  'style.css',
  'manifest.json',
  'jszip.min.js',
  'epub.min.js',
];

// Install: cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

function cacheFirst(request) {
  return caches.match(request).then((cached) => {
    if (cached) return cached;

    return fetch(request).then((response) => {
      if (request.method === 'GET' && response.status === 200) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(request, clone);
        });
      }
      return response;
    });
  });
}

// Fetch: cache-first for app shell/books, network-first for API data
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Server-side EPUB files are static and expensive over remote links.
  if (event.request.method === 'GET' && url.pathname.startsWith('/api/books/')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // API calls: network-first (don't cache)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      })
    );
    return;
  }

  // Everything else: cache-first, fallback to network
  event.respondWith(
    cacheFirst(event.request).catch(() => {
        // Offline fallback for navigation
        if (event.request.mode === 'navigate') {
          return caches.match('index.html');
        }
        return new Response('Offline', { status: 503 });
    })
  );
});
