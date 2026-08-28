// Service worker: makes the site open instantly on a return visit, and work
// with no connection at all.
//
// The case for it here is not really offline. It is that every visitor
// downloads data/funds.json on boot — 475KB gzipped and growing with the
// universe — plus five source files, before anything can be drawn. All of it is
// static, all of it changes once a night, and a browser that already has
// yesterday's copy should not be waiting on the network to draw a page.
//
// Three rules, and the differences between them are the whole design:
//
//   the document      network first. A deploy has to be able to reach people.
//                     The cached copy is the fallback, not the default.
//   everything else   stale while revalidate: answer from cache immediately,
//   same-origin       fetch in the background, keep the new copy for next time.
//   cross-origin      never touched. The live tape and the quote scan are the
//                     only two, both are 15-minute market data, and a cached
//                     price is a WRONG price rather than an old page.
//
// Serving yesterday's data without saying so would be a real problem for a site
// whose whole premise is a daily refresh — except that every figure here is
// already stamped with the date it closed on, in the tape and on every panel. A
// stale render says which day it is showing, which is what makes answering from
// cache honest rather than merely fast.

// Bump to retire every previous cache. There is no build step and no hashed
// filenames, so this constant is the only thing that can force one.
const VERSION = 'fh-v1';

/**
 * What is worth having before it is asked for.
 *
 * The shell and the two files every single page needs. Deliberately NOT
 * funds.json: it is the biggest thing here, and precaching it would make the
 * first visit slower to serve a second visit that may never come.
 */
const SHELL = [
  './',
  './index.html',
  './core.js',
  './ui.js',
  './analytics.js',
  './quotes.js',
  './live.js',
  './styles.css',
  './icon.svg',
  './site.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Individually, and tolerantly: `addAll` rejects the whole install if any
    // single file 404s, which would leave the worker permanently uninstalled
    // over one renamed asset.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/** Put a response in the cache, if it is one worth keeping. */
async function keep(request, response) {
  // `basic` excludes opaque cross-origin responses, which have no status worth
  // trusting and would poison the cache with something unreadable.
  if (!response || !response.ok || response.type !== 'basic') return response;
  const cache = await caches.open(VERSION);
  cache.put(request, response.clone()).catch(() => {});
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // The live tape and the quote scan. Never cached, never intercepted: a stale
  // quote is a wrong number, and this worker has no business between the page
  // and a market feed.
  if (url.origin !== self.location.origin) return;

  // The document: network first, so a deploy is not held back by a cache. The
  // cached copy answers only when the network cannot.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await keep(request, await fetch(request));
      } catch {
        return (await caches.match(request))
          ?? (await caches.match('./index.html'))
          ?? Response.error();
      }
    })());
    return;
  }

  // Everything else same-origin: answer from cache at once and refresh behind
  // it. The page renders off yesterday's copy and has today's before the next
  // visit — which for a file rewritten once a night is exactly the right trade.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request)
      .then((response) => keep(request, response))
      .catch(() => null);
    if (cached) {
      // Not awaited: the whole point is that the page does not wait for it.
      event.waitUntil(network);
      return cached;
    }
    return (await network) ?? Response.error();
  })());
});
