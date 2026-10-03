/* BURZH beats service worker.
 *
 * The app opens from the copy saved on the device, so a launch never waits for the network
 * (GitHub Pages can need seconds for a cold request; a saved copy needs milliseconds).
 *
 * - Shell (HTML, JS, fonts, icons, artwork): cache first. Every release carries its own BUILD id,
 *   so the browser sees a changed sw.js, installs the new copy in the background (all files or
 *   none), and the page switches over when that costs nothing (see applyUpdate in app.js).
 * - stations.json: network first with a short timeout, then the saved copy. New mixes show up
 *   quickly, and a slow connection never blocks the start.
 * - Audio and range requests: never touched. Safari streams them natively (seeking, background
 *   audio, the lock screen).
 */
const BUILD = 'dev';                       // replaced with the commit id by the deploy workflow
const CACHE = 'burzh-radio-' + BUILD;
const DATA_WAIT_MS = 2500;
const SHELL = [
  './',
  './index.html',
  './app.js',
  './theme.js',
  './planet.js',
  './smart.js',
  './sound.js',
  './sound-ui.js',
  './stations.json',
  './manifest.webmanifest',
  './fonts/inter-latin.woff2',
  './fonts/inter-cyrillic.woff2',
  './fonts/archivo-wdth.woff2',
  './planet/surface.jpg',
  './planet/fallback.png',
  './planet/tile-future-garage.jpg',
  './planet/tile-ambient.jpg',
  './planet/tile-deep-house.jpg',
  './planet/tile-trance.jpg',
  './apple-touch-icon.png',
  './icon-192.png',
  './favicon-32.png',
  './art/future-garage.png',
  './art/ambient.png',
  './art/deep-house.png',
  './art/trance.png'
];

// Install is all or nothing: a half-filled cache would mix old and new files.
// `reload` skips the browser's HTTP cache, so the copy is exactly what the server has now.
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      await Promise.all(SHELL.map(async path => {
        const response = await fetch(new Request(path, { cache: 'reload' }));
        if (!response.ok) throw new Error(path + ' ' + response.status);
        await cache.put(path, response);
      }));
    } catch (e) {
      await caches.delete(CACHE);      // nothing half-saved; the installed release keeps running
      throw e;
    }
    self.skipWaiting();              // not awaited: in some engines it only settles after install has finished
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

function cacheable(response) {
  return response && response.ok && response.type === 'basic';
}

async function fromCache(request, cache) {
  return (await cache.match(request, { ignoreSearch: true }))
    || (request.mode === 'navigate' ? await cache.match('./index.html') : null);
}

// Saved copy first. Anything not saved yet (should not happen) comes from the network and is kept.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await fromCache(request, cache);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (cacheable(response)) cache.put(request, response.clone());
    return response;
  } catch (e) {
    return Response.error();
  }
}

// Station list: fresh when the network answers in time, the saved copy otherwise.
async function dataFirst(request, event) {
  const cache = await caches.open(CACHE);
  const network = fetch(request, { cache: 'no-cache' }).then(response => {
    if (cacheable(response)) cache.put(request, response.clone());
    return response;
  });
  const cached = await cache.match(request, { ignoreSearch: true });
  if (!cached) return network.catch(() => Response.error());
  event.waitUntil(network.catch(() => null));      // finish saving even after the timeout
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), DATA_WAIT_MS));
  try {
    return (await Promise.race([network, timeout])) || cached;
  } catch (e) {
    return cached;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;            // weather API etc.
  if (url.pathname.includes('/media/') || request.headers.has('range')) return;

  if (url.pathname.endsWith('/stations.json')) {
    event.respondWith(dataFirst(request, event));
    return;
  }
  event.respondWith(cacheFirst(request));
});
