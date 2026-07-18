// Family Showdown Service Worker
// Bump this version on EVERY deploy to force cache clear
const CACHE_VERSION = 'showdown-v4';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(STATIC_ASSETS))
  );
  // Take over immediately — don't wait for old SW to die
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always network-first for Firebase and CDN resources
  const alwaysNetwork = [
    'firestore.googleapis.com',
    'firebase.googleapis.com',
    'googleapis.com',
    'gstatic.com',
    'tailwindcss.com',
    'cloudflare.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'fontawesome',
    'github.dev',
    'anthropic'
  ];

  if (alwaysNetwork.some(d => url.href.includes(d))) {
    event.respondWith(fetch(event.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Network-first for HTML — always get the freshest shell
  if (event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for static assets (icons, manifest)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(event.request, clone));
        }
        return res;
      });
    })
  );
});

// Handle skip-waiting message from client
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
