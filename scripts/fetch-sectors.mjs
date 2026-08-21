#!/usr/bin/env node
//
// What line of business each share a fund holds is in, and what it yields.
//
//   node scripts/fetch-sectors.mjs [--no-cache]
//
// Two questions from your inbox need the same fact — which industry a listing is
// in, and what dividend it paid — so they share one fetch:
//
//   themes      "show me funds in defence / semiconductors / finance"
//   dividends   "show me funds holding companies that pay dividends"
//
// Source is TradingView's scanner, the same feed quotes.js prices these shares
// from at runtime. One request covers the whole Turkish market; the foreign
// names are asked for by ticker, read out of the KAP holdings.
//
// Output (data/sectors.json):
//   listings   { bist: { TICKER: [theme|null, yield|null] }, us: { ... } }
//   themes     the theme ids that actually appear, with what they cover
//   market     the exchange's own cap-weighted dividend yield, as the reference
//
// Must run AFTER fetch-holdings.mjs — the foreign ticker list comes from the
// filings. build-analytics.mjs turns this into each fund's `th` and `dy`.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEME_OF_INDUSTRY, THEME_OVERRIDES, POOLED_INDUSTRY } from './lib/taxonomy.mjs';
import { foreignTickers } from '../quotes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'sectors.json');

/**
 * `Content-Type: text/plain` keeps this a CORS simple request in the browser.
 * Node does not care, but the header is kept identical to quotes.js so the two
 * callers are provably asking the same endpoint the same way.
 */
const HEADERS = { 'Content-Type': 'text/plain' };
const COLUMNS = ['name', 'description', 'sector', 'industry',
  'dividends_yield_current', 'market_cap_basic'];

const MARKETS = {
  bist: { scan: 'https://scanner.tradingview.com/turkey/scan', whole: true },
  us: { scan: 'https://scanner.tradingview.com/america/scan', whole: false },
};

/** How many of the largest listings the reference market yield is taken over. */
const MARKET_INDEX_SIZE = 100;

const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);
const round2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

async function scan(market, tickers = null) {
  const body = { columns: COLUMNS, range: [0, 12000] };
  if (tickers) body.filter = [{ left: 'name', operation: 'in_range', right: tickers }];

  const res = await fetch(MARKETS[market].scan, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${market}: HTTP ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).map((row) => {
    const [name, description, sector, industry, yieldPct, cap] = row.d;
    return { name, description, sector, industry, yieldPct, cap };
  });
}

/** Every foreign ticker any filing lists, so the US scan asks for exactly those. */
async function foreignUniverse() {
  const dir = path.join(DATA, 'holdings');
  let files;
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  } catch {
    log('  WARN data/holdings not found — run fetch-holdings.mjs; skipping foreign listings');
    return [];
  }
  const all = new Set();
  for (const file of files) {
    const holdings = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
    for (const ticker of foreignTickers(holdings.holdings)) all.add(ticker);
  }
  return [...all].sort();
}

/**
 * The exchange's own dividend yield, weighted by market value over its largest
 * listings. It is the reference the fund figures are read against: a fund
 * yielding under it is not picking dividend payers, whatever it is called.
 */
function marketYield(rows) {
  const ranked = rows.filter((r) => r.cap > 0).sort((a, b) => b.cap - a.cap).slice(0, MARKET_INDEX_SIZE);
  let cap = 0;
  let income = 0;
  for (const r of ranked) {
    cap += r.cap;
    income += r.cap * (r.yieldPct ?? 0);
  }
  return cap > 0 ? round2(income / cap) : null;
}

async function main() {
  const t0 = Date.now();
  const listings = {};
  const counts = {};
  let pooled = 0;
  let unmapped = new Map();
  let market = null;

  for (const id of Object.keys(MARKETS)) {
    const tickers = MARKETS[id].whole ? null : await foreignUniverse();
    if (!MARKETS[id].whole && !tickers.length) { listings[id] = {}; continue; }
    const rows = await scan(id, tickers);
    log(`  ${id}: ${rows.length} listings${tickers ? ` of ${tickers.length} asked for` : ''}`);

    const out = {};
    for (const r of rows) {
      if (r.industry === POOLED_INDUSTRY) {
        // An ETF is not a company. It still carries a yield worth counting.
        pooled++;
        out[r.name] = [null, round2(r.yieldPct)];
        continue;
      }
      const theme = THEME_OVERRIDES[r.name] ?? THEME_OF_INDUSTRY.get(r.industry) ?? null;
      if (!theme && r.industry) unmapped.set(r.industry, (unmapped.get(r.industry) ?? 0) + 1);
      if (theme) counts[theme] = (counts[theme] ?? 0) + 1;
      out[r.name] = [theme, round2(r.yieldPct)];
    }
    listings[id] = out;
    if (id === 'bist') market = marketYield(rows);
  }

  const themed = Object.values(counts).reduce((s, n) => s + n, 0);
  const total = Object.values(listings).reduce((s, m) => s + Object.keys(m).length, 0);
  log(`  ${themed} of ${total} listings carry a theme (${pooled} pooled vehicles have none)`);
  if (unmapped.size) {
    log(`  ${unmapped.size} industries map to no theme: ` +
      [...unmapped].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} (${n})`).join(', '));
  }
  log(`  BIST ${MARKET_INDEX_SIZE} weighted dividend yield: ${market}%`);

  await fs.writeFile(OUT, JSON.stringify({
    builtAt: new Date().toISOString(),
    source: 'tradingview',
    marketYield: market,
    marketIndexSize: MARKET_INDEX_SIZE,
    counts,
    listings,
  }, null, 1) + '\n');

  log(`Wrote data/sectors.json — ${total} listings`);
  for (const [id, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    log(`  ${id.padEnd(13)} ${String(n).padStart(4)} listings`);
  }
  log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('\nSECTOR FETCH FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
