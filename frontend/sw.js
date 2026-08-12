/**
 * Marginalia Service Worker
 * Versioned app-shell cache plus a stable EPUB cache.
 */
const APP_CACHE_NAME = 'marginalia-app-v34';
const EPUB_CACHE_NAME = 'marginalia-epub-v1';
const LEGACY_CACHE_PREFIX = 'marginalia-v';

const APP_SHELL = [
  '.',
  'index.html',
  'app.js?v=33',
  'style.css?v=31',
  'manifest.json',
  'jszip.min.js',
  'epub.min.js',
];

function isEpubRequest(request) {
  const url = new URL(request.url);
  return request.method === 'GET' &&
    url.pathname.startsWith('/api/books/') &&
    (url.pathname.endsWith('/file') || url.pathname.toLowerCase().endsWith('.epub'));
}

function withCacheSource(response, source) {
  const headers = new Headers(response.headers);
  headers.set('X-Marginalia-Cache', source);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Install: cache only the replaceable application shell.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

async function migrateLegacyEpubEntries(cacheNames) {
  const epubCache = await caches.open(EPUB_CACHE_NAME);
  for (const cacheName of cacheNames.filter(name => name.startsWith(LEGACY_CACHE_PREFIX))) {
    const legacyCache = await caches.open(cacheName);
    const requests = await legacyCache.keys();
    for (const request of requests.filter(isEpubRequest)) {
      if (await epubCache.match(request)) continue;
      const response = await legacyCache.match(request);
      if (response) await epubCache.put(request, response);
    }
  }
}

// Activate: migrate old EPUB responses, then clean only replaceable app caches.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      await migrateLegacyEpubEntries(keys);
      await Promise.all(
        keys
          .filter(key => (
            (key.startsWith('marginalia-app-') && key !== APP_CACHE_NAME) ||
            key.startsWith(LEGACY_CACHE_PREFIX)
          ))
          .map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

function cacheFirst(request, cacheName = APP_CACHE_NAME, annotate = false) {
  return caches.open(cacheName).then(async (cache) => {
    const cached = await cache.match(request);
    if (cached) return annotate ? withCacheSource(cached, 'hit') : cached;

    const response = await fetch(request);
    if (request.method === 'GET' && response.status === 200) {
      await cache.put(request, response.clone());
    }
    return annotate ? withCacheSource(response, 'network') : response;
  });
}

function networkFirst(request) {
  return fetch(request).then((response) => {
    if (request.method === 'GET' && response.status === 200) {
      const clone = response.clone();
      caches.open(APP_CACHE_NAME).then((cache) => cache.put(request, clone));
    }
    return response;
  }).catch(() => caches.match(request));
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // EPUB files survive application-shell upgrades and expose cache provenance.
  if (isEpubRequest(event.request)) {
    event.respondWith(cacheFirst(event.request, EPUB_CACHE_NAME, true));
    return;
  }

  // Other API calls are always network-first and are not cached.
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

  // Prefer fresh application code online.
  if (
    event.request.mode === 'navigate' ||
    url.pathname.endsWith('/index.html') ||
    url.pathname.endsWith('/app.js') ||
    url.pathname.endsWith('/style.css')
  ) {
    event.respondWith(
      networkFirst(event.request).then((response) => (
        response || caches.match('index.html')
      ))
    );
    return;
  }

  // Vendored libraries and other static assets remain cache-first.
  event.respondWith(
    cacheFirst(event.request).catch(() => {
      if (event.request.mode === 'navigate') {
        return caches.match('index.html');
      }
      return new Response('Offline', { status: 503 });
    })
  );
});
