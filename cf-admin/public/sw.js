/* Service worker for the web scanner.
 *
 * Its only job is making /scan open when there is no network. The captured cards
 * themselves live in IndexedDB, which the worker never touches — so a failed cache is
 * never a lost lead.
 *
 * Deliberately conservative: anything under /api/ goes straight to the network and is
 * never cached, because serving a stale event list or a cached upload response would be
 * worse than failing.
 */

const VERSION = 'cf-scan-v2';   // v2: scoped to /scan, pinned shell cache key
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

const SHELL_URLS = ['/scan', '/manifest.webmanifest', '/apple-touch-icon.png', '/favicon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      // addAll is all-or-nothing; a single 404 would leave the worker uninstalled, so
      // each URL is cached independently.
      .then((cache) => Promise.all(SHELL_URLS.map((u) => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

const SCAN_PATH = '/scan';

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;      // always live

  // The worker is registered from /scan but its scope is the whole origin, so without
  // this guard it would also intercept the admin console — caching admin pages and
  // serving them when offline. The scanner is the only thing that needs to work offline.
  const isScan = url.pathname === SCAN_PATH || url.pathname.startsWith(`${SCAN_PATH}/`);
  if (request.mode === 'navigate' && !isScan) return;

  // Next's build output is content-hashed and immutable — cache first, forever.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(ASSETS).then((c) => c.put(request, copy));
        }
        return res;
      })),
    );
    return;
  }

  // Scanner page loads: try the network so a deploy is picked up, fall back to the cached
  // shell so it still opens in a dead zone.
  //
  // The cache key is pinned to SCAN_PATH rather than taken from the request, so a visit to
  // /scan/anything can never overwrite the shell with the wrong document.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok && url.pathname === SCAN_PATH) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(SCAN_PATH, copy));
          }
          return res;
        })
        .catch(() => caches.match(SCAN_PATH).then((hit) => hit || Response.error())),
    );
  }
});

// Lets the page force an update without the user hunting through browser settings.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
