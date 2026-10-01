/* BURZH beats service worker.
 * - HTML, JS and stations.json: network first with offline fallback, so new
 *   mixes and app updates show up on the next launch.
 * - Fonts, icons, artwork: cache first, refreshed in the background.
 * - Audio and range requests: never touched, Safari streams them natively
 *   (needed for seeking, background audio and the lock screen).
 */
const CACHE = 'burzh-radio-v25';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './planet.js',
  './sound.js',
  './sound-ui.js',
  './stations.json',
  './manifest.webmanifest',
  './fonts/doto.woff2',
  './fonts/plex-mono-latin-400.woff2',
  './fonts/plex-mono-latin-500.woff2',
  './fonts/plex-mono-cyrillic-400.woff2',
  './fonts/plex-mono-cyrillic-500.woff2',
  './apple-touch-icon.png',
  './icon-192.png',
  './favicon-32.png',
  './art/future-garage.png',
  './art/lofi.png',
  './art/deep-house.png',
  './art/trance.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function cacheable(response) {
  return response && response.ok && response.type === 'basic';
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (cacheable(response)) cache.put(request, response.clone());
    return response;
  } catch (e) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  }
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const update = fetch(request).then(response => {
    if (cacheable(response)) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  if (cached) {
    event.waitUntil(update);
    return cached;
  }
  return (await update) || Response.error();
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;            // weather API etc.
  if (url.pathname.includes('/media/') || request.headers.has('range')) return;

  // Code and data: always try the network so HTML and JS never get out of step.
  if (request.mode === 'navigate' || /\.(js|json|webmanifest)$/.test(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }
  // Fonts, icons, artwork: instant from cache, refreshed quietly.
  event.respondWith(staleWhileRevalidate(request, event));
});
