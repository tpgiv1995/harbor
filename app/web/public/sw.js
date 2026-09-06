// Harbor mobile service worker.
//
// The previous version was cache-first over everything with a hardcoded version
// string, so it precached /index.html on first install and then served that copy
// forever. The cached document referenced a content-hashed bundle that therefore
// also never changed, which meant the installed app could NEVER be updated: new
// builds, new icons and bug fixes were all invisible on the device, and deleting
// the home-screen icon did not help, because a service worker is registered per
// ORIGIN and survives that. Live-caught 2026-08-02 when two shipped fixes had no
// effect on Pat's phone and looked to him like nothing had been done.
//
// The rules that prevent a repeat:
//   1. HTML and navigations are NETWORK-FIRST. The document chooses which bundle
//      to load, so a stale document is a permanently stale app. Cache is only a
//      fallback for a genuinely offline device.
//   2. Only /assets/* is cache-first, and only because Vite content-hashes those
//      filenames: a changed file is a changed URL, so a stale hit cannot happen.
//   3. Anything live (/ws, /health, /icons, /artifact) is never intercepted.
//   4. skipWaiting plus clients.claim, so a fix lands on the next launch rather
//      than after an indeterminate number of app closes.

const VERSION = 'harbor-web-v2';
const ASSETS = `${VERSION}-assets`;
const SHELL = `${VERSION}-shell`;

self.addEventListener('install', (event) => {
  // Deliberately NO precache of '/' or '/index.html'. Precaching the document is
  // precisely what froze the previous version.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const stale = keys.filter((k) => k !== ASSETS && k !== SHELL);
    // Drops every cache that is not ours, which includes the harbor-web-v1
    // cache still holding a frozen index.html on an already-installed device.
    await Promise.all(stale.map((k) => caches.delete(k)));
    await self.clients.claim();

    // An upgrading device has ALREADY rendered the frozen document by the time
    // this runs, so without a reload the user sees the old app once more and
    // concludes nothing was fixed. Reload only when we actually evicted a stale
    // cache, so a clean install never navigates itself and no loop is possible.
    if (stale.length === 0) return;
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      try { await client.navigate(client.url); } catch { /* not navigable, next launch is fresh anyway */ }
    }
  })());
});

// Lets the page force an update without anyone reinstalling anything.
self.addEventListener('message', (event) => {
  if (event.data === 'harbor:skip-waiting') self.skipWaiting();
});

const NEVER_CACHE = ['/ws', '/health', '/icons/', '/artifact'];

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some((p) => url.pathname.startsWith(p))) return;

  // Content-hashed build output: safe to serve from cache, because a new build
  // produces a new filename rather than new bytes behind an old name.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const hit = await caches.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok) (await caches.open(ASSETS)).put(request, res.clone());
      return res;
    })());
    return;
  }

  // Everything else, and navigations above all: network first. The cache is a
  // fallback for being offline, never a source of truth.
  const isDoc = request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');
  event.respondWith((async () => {
    try {
      const res = await fetch(request, { cache: 'no-store' });
      if (res.ok && isDoc) (await caches.open(SHELL)).put('/index.html', res.clone());
      return res;
    } catch (error) {
      const hit = await caches.match(isDoc ? '/index.html' : request);
      if (hit) return hit;
      throw error;
    }
  })());
});
