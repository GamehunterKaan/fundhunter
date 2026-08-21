#!/usr/bin/env node
//
// Collects the benchmarks a fund gets compared against, into data/benchmarks.jsonl.
//
//   node scripts/fetch-benchmarks.mjs [--range=5y]
//
// Series produced (one record per date):
//   bist100   BIST 100 index                       (Yahoo XU100.IS)
//   bist30    BIST 30 index                        (Yahoo XU030.IS)
//   usdtry    US dollar / Turkish lira             (Yahoo USDTRY=X)
//   eurtry    Euro / Turkish lira                  (Yahoo EURTRY=X)
//   goldusd   Gold, USD per troy ounce             (Yahoo GC=F)
//   goldgram  Gram gold in TRY, derived            (goldusd / 31.1035 * usdtry)
//   mmf       Money-market fund index, 100 = start (derived from TEFAS data)
//
// `mmf` stands in for a deposit-rate benchmark. TCMB publishes weighted-average
// deposit rates only through EVDS, which requires an API key, so instead we chain
// the size-weighted daily return of every TRY money-market fund on TEFAS. Those
// funds hold deposits and repo, so the series tracks realised deposit yield net
// of fund fees — and unlike a headline rate it is something you can actually buy.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeJsonl, readJsonl } from './lib/jsonl.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'benchmarks.jsonl');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);
// Five years rather than the two the charts need: the crash-protection measure
// segments BIST into its falls, and it can only find the fall of March 2025 if it
// can also see the peaks on either side of it. See crashEpisodes in analytics.js.
const RANGE = args.range ?? '5y';

const TROY_OUNCE_GRAMS = 31.1034768;
/** Money-market funds are the deposit proxy; this is their TEFAS category. */
const MONEY_MARKET_CATEGORY = 'Para Piyasası Şemsiye Fonu';

const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);
const round = (n, p = 4) => (n == null ? null : Math.round(n * 10 ** p) / 10 ** p);

const SYMBOLS = [
  { symbol: 'XU100.IS', field: 'bist100' },
  { symbol: 'XU030.IS', field: 'bist30' },
  { symbol: 'USDTRY=X', field: 'usdtry' },
  { symbol: 'EURTRY=X', field: 'eurtry' },
  { symbol: 'GC=F', field: 'goldusd' },
];

/**
 * Daily closes from Yahoo's public chart endpoint.
 * @returns {Promise<Map<string, number>>} ISO date -> close
 */
async function yahooDaily(symbol, range) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=1d`;

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error(json?.chart?.error?.description ?? 'no result');

      const stamps = result.timestamp ?? [];
      const closes = result.indicators?.quote?.[0]?.close ?? [];
      const series = new Map();
      for (let i = 0; i < stamps.length; i++) {
        const close = closes[i];
        if (close == null) continue; // market holiday
        series.set(new Date(stamps[i] * 1000).toISOString().slice(0, 10), close);
      }
      return series;
    } catch (e) {
      lastErr = e;
    }
  }
  // A benchmark that fails today simply contributes no new line; yesterday's
  // committed data stays valid.
  log(`  WARN ${symbol}: ${lastErr?.message} — skipping`);
  return new Map();
}

/**
 * Chain the size-weighted daily return of TRY money-market funds into an index.
 * Weighting uses the previous day's portfolio size, so a fund's own inflows do
 * not distort that day's return.
 */
async function moneyMarketIndex() {
  let funds;
  try {
    funds = JSON.parse(await fs.readFile(path.join(DATA, 'funds.json'), 'utf8'));
  } catch {
    log('  WARN data/funds.json not found — run fetch-tefas.mjs first; skipping mmf');
    return new Map();
  }

  const codes = funds
    .filter((f) => f.cat === MONEY_MARKET_CATEGORY && f.k === 'YAT')
    .map((f) => f.c);
  if (!codes.length) {
    log('  WARN no money-market funds found; skipping mmf');
    return new Map();
  }

  // date -> [{ price, size }]
  const byDate = new Map();
  for (const code of codes) {
    const recs = await readJsonl(path.join(DATA, 'history', `${code}.jsonl`));
    const rows = [...recs.values()]
      .filter((r) => r.p != null)
      .sort((a, b) => (a.d < b.d ? -1 : 1));
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      if (!prev.p || !cur.p) continue;
      const weight = prev.sz ?? 0;
      if (weight <= 0) continue;
      if (!byDate.has(cur.d)) byDate.set(cur.d, []);
      byDate.get(cur.d).push({ ret: cur.p / prev.p - 1, weight });
    }
  }

  const dates = [...byDate.keys()].sort();
  const series = new Map();
  let level = 100;
  for (const d of dates) {
    const parts = byDate.get(d);
    const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
    if (!totalWeight) continue;
    const ret = parts.reduce((s, p) => s + p.ret * p.weight, 0) / totalWeight;
    // Guard against a bad print in one fund dragging the whole index.
    if (!Number.isFinite(ret) || Math.abs(ret) > 0.2) continue;
    level *= 1 + ret;
    series.set(d, level);
  }
  log(`  mmf: ${codes.length} money-market funds -> ${series.size} days`);
  return series;
}

async function main() {
  log(`Benchmarks — range ${RANGE}`);

  const series = {};
  for (const { symbol, field } of SYMBOLS) {
    series[field] = await yahooDaily(symbol, RANGE);
    log(`  ${field.padEnd(8)} ${String(series[field].size).padStart(4)} days (${symbol})`);
  }

  series.mmf = await moneyMarketIndex();

  // Union of every date any series reported.
  const dates = new Set();
  for (const s of Object.values(series)) for (const d of s.keys()) dates.add(d);

  const records = [];
  // Yahoo's FX and commodity calendars do not line up, so the two legs of gram
  // gold are often reported on different days. Carry the last known rate forward
  // for the derivation only — the usdtry field itself stays as reported.
  let lastUsdTry = null;
  for (const d of [...dates].sort()) {
    const rec = { d };
    for (const [field, s] of Object.entries(series)) {
      const v = s.get(d);
      if (v != null) rec[field] = round(v, 4);
    }
    if (rec.usdtry != null) lastUsdTry = rec.usdtry;
    const fx = rec.usdtry ?? lastUsdTry;
    if (rec.goldusd != null && fx != null) {
      rec.goldgram = round((rec.goldusd / TROY_OUNCE_GRAMS) * fx, 2);
    }
    if (Object.keys(rec).length > 1) records.push(rec);
  }

  const { added, total } = await mergeJsonl(OUT, records, 'd');
  log(`Wrote data/benchmarks.jsonl — ${total} days (${added} new)`);
}

main().catch((e) => {
  console.error('\nBENCHMARK FETCH FAILED:', e.message);
  process.exit(1);
});
