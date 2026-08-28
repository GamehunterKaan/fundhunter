import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// The service worker sits between every request and the network, so its routing
// rules are the one thing in this repo that can take the whole site down without
// any page code being wrong. It cannot be imported — it is written against a
// runtime Node does not have — so it is evaluated in a `vm` context with that
// runtime stubbed, and the three rules it exists to enforce are asserted here.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const ORIGIN = 'https://fundhunter.example';

class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.ok = init.ok ?? true;
    this.type = init.type ?? 'basic';
    this.tag = init.tag ?? 'network';
  }
  clone() { return new FakeResponse(this.body, this); }
}

/** A fresh worker in a fresh stubbed runtime, so no test can leak into another. */
function boot() {
  const store = new Map();
  const deleted = [];
  const hits = [];
  const state = { offline: false };
  const handlers = {};

  const context = {
    self: {
      addEventListener: (t, fn) => { handlers[t] = fn; },
      location: { origin: ORIGIN },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => ({
        add: async (url) => { store.set(url, new FakeResponse(url, { tag: 'cache' })); },
        put: async (req, res) => { store.set(String(req.url ?? req), res); },
      }),
      keys: async () => ['fh-old', 'fh-v1'],
      delete: async (k) => { deleted.push(k); return true; },
      match: async (req) => store.get(String(req.url ?? req)) ?? undefined,
    },
    fetch: async (req) => {
      hits.push(String(req.url ?? req));
      if (state.offline) throw new Error('offline');
      return new FakeResponse(String(req.url ?? req), { tag: 'network' });
    },
    URL,
    Response: { error: () => new FakeResponse(null, { ok: false, tag: 'error' }) },
    Promise,
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);

  const lifecycle = async (name) => {
    let pending = null;
    await handlers[name]({ waitUntil: (p) => { pending = p; } });
    await pending;
  };
  const fetchOf = (url, { mode = 'no-cors', method = 'GET' } = {}) => {
    let answered = null;
    handlers.fetch({
      request: { url, mode, method },
      respondWith: (p) => { answered = p; },
      waitUntil: (p) => p,
    });
    return answered;
  };
  const seed = (url, tag = 'cache') => store.set(url, new FakeResponse(url, { tag }));

  return { store, deleted, hits, state, lifecycle, fetchOf, seed };
}

test('installing seeds the shell but not the big data file', async () => {
  const sw = boot();
  await sw.lifecycle('install');
  assert.ok(sw.store.has('./core.js'));
  assert.ok(sw.store.has('./index.html'));
  // Precaching funds.json would make the first visit slower to serve a second
  // one that may never happen. It is the largest thing here by far.
  assert.ok(!sw.store.has('./data/funds.json'));
});

test('activating retires every previous version and keeps this one', async () => {
  const sw = boot();
  await sw.lifecycle('activate');
  assert.ok(sw.deleted.includes('fh-old'));
  assert.ok(!sw.deleted.includes('fh-v1'));
});

test('a market feed is never intercepted', () => {
  const sw = boot();
  // The live tape and the quote scan are 15-minute market data. A cached price
  // is a WRONG price, not merely an old page, so the worker stays out of it.
  assert.equal(sw.fetchOf('https://finans.truncgil.com/today.json'), null);
  assert.equal(sw.fetchOf('https://scanner.tradingview.com/turkey/scan'), null);
  // And nothing that is not a plain read.
  assert.equal(sw.fetchOf(`${ORIGIN}/x`, { method: 'POST' }), null);
});

test('same-origin files answer from cache at once and refresh behind', async () => {
  const sw = boot();
  sw.seed(`${ORIGIN}/data/funds.json`);
  const answer = await sw.fetchOf(`${ORIGIN}/data/funds.json`);
  assert.equal(answer.tag, 'cache');
  // The refresh still happens; it is just not what the page waited for.
  assert.deepEqual(sw.hits, [`${ORIGIN}/data/funds.json`]);
});

test('a file not in the cache yet comes from the network', async () => {
  const sw = boot();
  assert.equal((await sw.fetchOf(`${ORIGIN}/data/meta.json`)).tag, 'network');
});

test('the document prefers the network, so a deploy can reach people', async () => {
  const sw = boot();
  sw.seed(`${ORIGIN}/`);
  assert.equal((await sw.fetchOf(`${ORIGIN}/`, { mode: 'navigate' })).tag, 'network');
});

test('with no connection the cached copies answer', async () => {
  const sw = boot();
  sw.seed(`${ORIGIN}/`);
  sw.seed(`${ORIGIN}/data/funds.json`);
  sw.state.offline = true;
  assert.equal((await sw.fetchOf(`${ORIGIN}/`, { mode: 'navigate' })).tag, 'cache');
  assert.equal((await sw.fetchOf(`${ORIGIN}/data/funds.json`)).tag, 'cache');
});

test('offline and never cached is an error rather than a hang', async () => {
  const sw = boot();
  sw.state.offline = true;
  assert.equal((await sw.fetchOf(`${ORIGIN}/data/nothing.json`)).ok, false);
});
