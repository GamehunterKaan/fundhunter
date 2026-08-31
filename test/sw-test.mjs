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
// runtime stubbed, and the four rules it exists to enforce are asserted here.

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
      // A network that never answers, which is the case the timeout exists for
      // and the one a thrown error does not reach.
      if (state.hang) await new Promise(() => {});
      if (state.missing) return new FakeResponse(null, { ok: false, tag: 'network' });
      return new FakeResponse(String(req.url ?? req), { tag: 'network' });
    },
    URL,
    Response: { error: () => new FakeResponse(null, { ok: false, tag: 'error' }) },
    Promise,
    // Real timers, except that a test asking for a hang gets the worker's
    // budget collapsed to nothing — otherwise proving the fallback works would
    // cost three seconds of suite time to watch a clock the worker owns.
    setTimeout: (fn, ms) => setTimeout(fn, state.hang ? 0 : ms),
    clearTimeout: (id) => clearTimeout(id),
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

test('source files answer from cache at once and refresh behind', async () => {
  const sw = boot();
  sw.seed(`${ORIGIN}/ui.js`);
  const answer = await sw.fetchOf(`${ORIGIN}/ui.js`);
  assert.equal(answer.tag, 'cache');
  // The refresh still happens; it is just not what the page waited for.
  assert.deepEqual(sw.hits, [`${ORIGIN}/ui.js`]);
});

test('a file not in the cache yet comes from the network', async () => {
  const sw = boot();
  assert.equal((await sw.fetchOf(`${ORIGIN}/data/meta.json`)).tag, 'network');
});

// The rule this file exists for. data/ is rewritten nightly and read daily, so
// under the rule above a daily visitor was served the previous visit's copy
// every single visit — the site showed yesterday's price as today's.
test('the data prefers the network even when a copy is cached', async () => {
  const sw = boot();
  sw.seed(`${ORIGIN}/data/funds.json`);
  assert.equal((await sw.fetchOf(`${ORIGIN}/data/funds.json`)).tag, 'network');
});

test('a history or holdings file is data too, not just the big two', async () => {
  const sw = boot();
  sw.seed(`${ORIGIN}/data/history/THF.jsonl`);
  sw.seed(`${ORIGIN}/data/holdings/THF.json`);
  assert.equal((await sw.fetchOf(`${ORIGIN}/data/history/THF.jsonl`)).tag, 'network');
  assert.equal((await sw.fetchOf(`${ORIGIN}/data/holdings/THF.json`)).tag, 'network');
});

// 632 files, a screenful at a time. A night-old logo is a monogram nobody
// notices; asking for each one would be a round trip per row.
test('logos stay on the cache, though they live under data/', async () => {
  const sw = boot();
  sw.seed(`${ORIGIN}/data/logos/stock/a1-capital-yatirim.svg`);
  sw.seed(`${ORIGIN}/data/logos/index.json`);
  assert.equal((await sw.fetchOf(`${ORIGIN}/data/logos/stock/a1-capital-yatirim.svg`)).tag, 'cache');
  assert.equal((await sw.fetchOf(`${ORIGIN}/data/logos/index.json`)).tag, 'cache');
});

test('a network that hangs does not hold the page up past the budget', async () => {
  const sw = boot();
  sw.seed(`${ORIGIN}/data/funds.json`);
  sw.state.hang = true;
  // Preferring the network must not mean waiting on one that never answers.
  assert.equal((await sw.fetchOf(`${ORIGIN}/data/funds.json`)).tag, 'cache');
});

test('a 404 on the data falls back rather than breaking the page', async () => {
  const sw = boot();
  sw.seed(`${ORIGIN}/data/funds.json`);
  sw.state.missing = true;
  assert.equal((await sw.fetchOf(`${ORIGIN}/data/funds.json`)).tag, 'cache');
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
