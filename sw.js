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
//   data/             network first, for the same reason and more urgently.
//                     See below.
//   everything else   stale while revalidate: answer from cache immediately,
//   same-origin       fetch in the background, keep the new copy for next time.
//   cross-origin      never touched. The live tape and the quote scan are the
//                     only two, both are 15-minute market data, and a cached
//                     price is a WRONG price rather than an old page.
//
// Why data/ cannot be stale-while-revalidate, though it was: the files there are
// rewritten once a night and read once a day, and those two numbers are the same
// number. A visitor who opens the site daily is served the copy fetched on the
// previous visit, every visit — the fresh one is only ever the copy nobody looks
// at. That is not a cache occasionally being behind, it is a cache that is
// structurally never right, and on a page whose headline figure is a price it
// showed people yesterday's price and called it today's.
//
// It is not costly to fix, because these files carry ETags. Asking costs a 304
// and no bytes at all on the days nothing changed; the one day it did change is
// the one day the download is worth making. Every figure is still stamped with
// the date it closed on, which is what makes the offline fallback honest — but
// a date stamp is an explanation of a stale number, not a substitute for a
// fresh one.

// Bump to retire every previous cache. There is no build step and no hashed
// filenames, so this constant is the only thing that can force one.
const VERSION = 'fh-v1';

/** Paths whose freshness is the point, and the one subtree inside them that is not. */
const DATA = /\/data\//;
const LOGOS = /\/data\/logos\//;

/** How long a data request may hold the page up before the cache answers instead. */
const DATA_TIMEOUT_MS = 3000;

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

  // The data. Network first, with the cache as the fallback rather than the
  // default — see the note at the top of this file.
  //
  // Logos are the exception and stay on the rule below: 632 near-immutable
  // files, a screenful of them at a time, where being a night late costs a
  // monogram nobody notices and asking would cost a round trip per row.
  if (DATA.test(url.pathname) && !LOGOS.test(url.pathname)) {
    event.respondWith((async () => {
      const network = fetch(request).catch(() => null);
      // A connection that hangs is worse than one that fails outright: with no
      // bound, a boot on a dead network waits out the browser's own timeout
      // while a perfectly good copy sits in the cache. The budget is five times
      // what a changed funds.json takes to arrive in full. Cleared on the way
      // out, so the common case does not leave a timer behind per request.
      let timer;
      const budget = new Promise((resolve) => { timer = setTimeout(resolve, DATA_TIMEOUT_MS); });
      const fresh = await Promise.race([network, budget]);
      clearTimeout(timer);
      if (fresh?.ok) return keep(request, fresh);

      // Still in flight, or back with a 404: last night's copy beats both a
      // spinner and an error.
      const cached = await caches.match(request);
      if (cached) {
        event.waitUntil(network.then((r) => (r?.ok ? keep(request, r) : null)));
        return cached;
      }
      // Nothing cached, so there is nothing to do but wait it out. A first
      // visit has to pay for its data whatever the connection is doing.
      return (await network) ?? Response.error();
    })());
    return;
  }

  // Everything else same-origin: the source files, the stylesheet, the logos.
  // Answer from cache at once and refresh behind it. Being a visit behind is
  // the right trade here in a way it never was for the data — nothing in this
  // group is a figure anybody reads, and a deploy still reaches people through
  // the document rule above and the VERSION bump that goes with it.
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
