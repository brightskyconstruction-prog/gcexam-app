/* ===========================================================================
   sw.js — service worker for the app shell and the question bank.

   CRITICAL (analysis.md §6.2): this worker must NOT intercept Firestore or
   gstatic traffic. Firestore manages its own long-lived streaming transport
   and a naive cache-first handler breaks it outright. Anything that is not a
   same-origin GET of a precached-style asset falls straight through to the
   network with no `respondWith` at all.
   =========================================================================== */

const VERSION = 'gcexam-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

const SHELL_ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'css/tokens.css',
  'css/base.css',
  'css/components.css',
  'js/app.js',
  'js/state.js',
  'js/modes.js',
  'js/filters.js',
  'js/render.js',
  'js/parse-source.js',
  'js/audio.js',
  'js/study-material.js',
  'js/firebase-config.js',
  'js/firebase-sync.js',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

const DATA_ASSETS = [
  'data/raw-topics.json',
  'data/mcq.json',
  'data/mixed-topic.json',
  'data/latest-important.json',
  'data/key-tables.json'
];

/* Hosts the worker must never touch. */
const BYPASS_HOSTS = [
  'firestore.googleapis.com',
  'firebase.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'www.gstatic.com',
  'gstatic.com',
  'identitytoolkit.googleapis.com',
  'www.googleapis.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // addAll is atomic; a single 404 would abort the install, so we add
    // individually and tolerate a missing optional asset.
    await Promise.all(SHELL_ASSETS.map((url) =>
      shell.add(new Request(url, { cache: 'reload' })).catch((err) => console.warn('[sw] skip', url, err))
    ));

    const data = await caches.open(DATA_CACHE);
    await Promise.all(DATA_ASSETS.map((url) =>
      data.add(new Request(url, { cache: 'reload' })).catch((err) => console.warn('[sw] skip', url, err))
    ));

    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET is ever cacheable.
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (_) { return; }

  // Firestore / Firebase SDK: network only, no interception whatsoever.
  if (BYPASS_HOSTS.includes(url.hostname)) return;

  // Anything cross-origin: leave it to the browser.
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first so a deploy is picked up, cache as fallback.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('index.html', fresh.clone());
        return fresh;
      } catch (_) {
        const cached = await caches.match('index.html', { ignoreSearch: true });
        return cached || Response.error();
      }
    })());
    return;
  }

  const isData = url.pathname.includes('/data/') && url.pathname.endsWith('.json');
  const cacheName = isData ? DATA_CACHE : SHELL_CACHE;

  // Cache-first for static assets and the question bank; both are versioned
  // by the cache name, so a bumped VERSION re-downloads everything.
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) {
      // Refresh in the background so the next load is current.
      event.waitUntil((async () => {
        try {
          const fresh = await fetch(request);
          if (fresh && fresh.ok) (await caches.open(cacheName)).put(request, fresh.clone());
        } catch (_) { /* offline — the cached copy is what we wanted anyway */ }
      })());
      return cached;
    }

    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok && fresh.type === 'basic') {
        (await caches.open(cacheName)).put(request, fresh.clone());
      }
      return fresh;
    } catch (err) {
      return new Response('Offline and not cached.', { status: 503, statusText: 'Offline' });
    }
  })());
});
