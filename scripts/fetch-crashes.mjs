#!/usr/bin/env node
//
// Measures what every fund did while the market was falling, into data/crashes.json.
//
//   node scripts/fetch-crashes.mjs [--years=3] [--no-cache]
//
// Reads the BIST 100 series from data/benchmarks.jsonl, cuts it into falls with
// crashEpisodes() from analytics.js, and asks TEFAS for each fund's NAV at the
// two ends of every fall. Only the two ends: a fund's return over a window needs
// two prices, so this stays a few dozen small requests rather than the years of
// daily history data/history/ would otherwise have to carry.
//
// Output (data/crashes.json):
//   episodes  [{ from, to, fall, cash, navFrom, navTo, funds }]  dates and rates
//   returns   { CODE: [number|null, ...] }                 aligned to episodes
//
// Must run AFTER fetch-benchmarks.mjs. build-analytics.mjs turns this into the
// per-fund `cr` figure.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TefasClient, requestBody, mapPool, ymd, addDays } from './lib/tefas.mjs';
import { KINDS } from './lib/taxonomy.mjs';
import { parseJsonl } from '../core.js';
import { crashEpisodes, CRASH_YEARS } from '../analytics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'crashes.json');

const INFO_METHOD = 'fonGnlBlgSiraliGetir';

/**
 * A fund's NAV is dated one business day after the market it reflects, so the
 * price that carries a given market date is the first one published AFTER it.
 * See LAGGED_FACTORS in analytics.js — and measured here on four BIST 30 index
 * trackers over five episodes: aligning on the date itself puts them 3.5 points
 * off the index on average, aligning on the next print 0.9.
 */
const NAV_WINDOW_DAYS = 7;

/** The TEFAS category the money-market rate is read from. */
const MONEY_MARKET_CATEGORY = 'Para Piyasası Şemsiye Fonu';
/** Below this many money-market funds in a window, the median is not a rate. */
const MIN_CASH_FUNDS = 5;

/**
 * Assets a fund must already hold at the start of a fall to be measured over it.
 *
 * Under about five million lira a unit price is not a market price: one
 * subscription moves it, and the unit count in the feed jumps around with it —
 * Pardus Dokuzuncu held ₺3.3m in July 2024, reported its units as 9.5m, 1.5m,
 * 3.3m and 265k on four consecutive days, and comes out of that window with a
 * "return" of +672%. Every remaining figure above +200% in three years of falls
 * was one of these; none survive the floor, and it costs 446 of 16,839
 * measurements.
 */
const MIN_ASSETS = 5e6;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

const YEARS = Number(args.years ?? CRASH_YEARS);
const CONCURRENCY = Number(args.concurrency ?? 2);
const USE_CACHE = !args['no-cache'];

const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);
const round2 = (n) => (n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100);

const client = new TefasClient({ cacheDir: path.join(ROOT, '.cache', 'tefas-crash') });

/**
 * Shrink an info response to what a return needs — plus the units outstanding,
 * which is how a restatement is told from a move. See RESTATEMENT below.
 */
const reduceNav = (rows) =>
  rows
    .filter((r) => r.fonKodu && r.fiyat != null)
    .map((r) => [r.fonKodu, r.tarih, r.fiyat, r.tedPaySayisi ?? null]);

/**
 * Every fund's first NAV published strictly after `date`.
 * @returns {Promise<Map<string, [string, number, number|null]>>} code -> [date, price, units]
 */
async function navsAfter(date) {
  const from = addDays(new Date(date), 1);
  const to = addDays(from, NAV_WINDOW_DAYS - 1);

  const jobs = KINDS.map((k) => k.id);
  const chunks = await mapPool(jobs, CONCURRENCY, (kind) =>
    client.post(
      INFO_METHOD,
      requestBody({ fonTipi: kind, basTarih: ymd(from), bitTarih: ymd(to) }),
      { cacheKey: USE_CACHE ? `nav2-${kind}-${ymd(from)}-${ymd(to)}` : null, reduce: reduceNav }
    )
  );

  const out = new Map();
  for (const rows of chunks) {
    for (const [code, d, price, units] of rows) {
      if (!(price > 0)) continue;
      const prev = out.get(code);
      if (!prev || d < prev[0]) out.set(code, [d, price, units]);
    }
  }
  return out;
}

/**
 * The money-market return over each fall, as the median of what TRY money-market
 * funds actually did between the same two prices.
 *
 * Every figure on this page is an excess over cash, and it has to be: over a
 * 40-day window Turkish deposit rates alone add several per cent, so on raw
 * returns a fund that merely holds cash looks like it defended the portfolio and
 * a fund earning 500% a year looks like it defended it brilliantly. Subtracting
 * the rate leaves what the manager actually did.
 *
 * The series is derived from the funds rather than from data/benchmarks.jsonl's
 * `mmf` column, which only spans the year of daily history the site publishes —
 * these falls reach three years back. The median rather than a size-weighted mean
 * because portfolio sizes at those dates are not fetched, and the median of ~80
 * funds tracking the same rate is not a close call.
 */
function cashReturns(episodes, returns, codes) {
  return episodes.map((e, i) => {
    const values = [];
    for (const code of codes) {
      const r = returns[code]?.[i];
      if (r != null && Number.isFinite(r)) values.push(r);
    }
    if (values.length < MIN_CASH_FUNDS) {
      log(`  WARN ${e.from}: only ${values.length} money-market funds — no cash rate`);
      return null;
    }
    values.sort((a, b) => a - b);
    const mid = values.length >> 1;
    const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    return round2(median);
  });
}

/**
 * When a price move is a restatement of the unit price rather than a return.
 *
 * A fund occasionally redenominates: it multiplies its unit price by some factor
 * and divides the number of units by the same one, leaving every holder with
 * exactly what they had. TEFAS publishes the new price without a marker, so the
 * two prices either side read as a return of +8,229% — NEO Portföy İkinci, whose
 * unit went from ₺1.20 to ₺116.87 overnight in September 2025 — or of −99%.
 *
 * The units outstanding are what give it away. A return does not move them at
 * all, and money coming in or out moves them without touching the price. Only a
 * restatement moves both, by a large factor, in opposite directions.
 *
 * Both bounds are loose on purpose, and the test is the DIRECTIONS rather than
 * the arithmetic: a fund that restates also takes in money in the same window, so
 * the two factors rarely cancel to anything near one. A fund can genuinely double
 * over two months and can genuinely triple in size; what none of them do is
 * triple in price while the unit count falls to a thousandth.
 */
const RESTATEMENT_FACTOR = 3;

function isRestatement(a, b) {
  const [, priceA, unitsA] = a;
  const [, priceB, unitsB] = b;
  if (!(unitsA > 0) || !(unitsB > 0)) return false;
  const price = priceB / priceA;
  const units = unitsB / unitsA;
  if (price >= RESTATEMENT_FACTOR) return units <= 1 / RESTATEMENT_FACTOR;
  if (price <= 1 / RESTATEMENT_FACTOR) return units >= RESTATEMENT_FACTOR;
  return false;
}


/** The trading date a boundary's NAVs were read on: the earliest any fund printed. */
function firstNavDate(found) {
  let first = null;
  for (const [d] of found?.values() ?? []) if (first == null || d < first) first = d;
  return first;
}

async function main() {
  const t0 = Date.now();
  const bench = parseJsonl(await fs.readFile(path.join(DATA, 'benchmarks.jsonl'), 'utf8'));
  const series = bench.filter((b) => b.bist100 != null).map((b) => [b.d, b.bist100]);
  if (series.length < 100) throw new Error(`only ${series.length} BIST days — run fetch-benchmarks first`);

  const all = crashEpisodes(series);
  const cutoff = new Date(Date.parse(series.at(-1)[0]) - YEARS * 365.25 * 86400000)
    .toISOString()
    .slice(0, 10);
  const episodes = all.filter((e) => e.from >= cutoff);

  log(`BIST 100 ${series[0][0]} .. ${series.at(-1)[0]} — ${all.length} falls, ${episodes.length} since ${cutoff}`);
  for (const e of episodes) log(`  ${e.from} -> ${e.to}  ${e.fall}%`);

  // --- NAVs at both ends of every episode ----------------------------------
  // Boundaries are deduplicated: one fall's low is often close to the next one's
  // high, and there is no reason to ask twice.
  const boundaries = [...new Set(episodes.flatMap((e) => [e.from, e.to]))].sort();
  log(`Fetching NAVs at ${boundaries.length} dates (${boundaries.length * KINDS.length} requests)`);

  const navs = new Map();
  for (const date of boundaries) {
    const found = await navsAfter(date);
    navs.set(date, found);
    log(`  ${date} -> ${found.size} funds`);
  }

  // --- per-fund returns over each fall --------------------------------------
  const codes = new Set();
  for (const found of navs.values()) for (const code of found.keys()) codes.add(code);

  const returns = {};
  const covered = new Array(episodes.length).fill(0);
  let restated = 0;
  let tooSmall = 0;

  for (const code of [...codes].sort()) {
    const row = episodes.map((e, i) => {
      const a = navs.get(e.from)?.get(code);
      const b = navs.get(e.to)?.get(code);
      if (!a || !b || !(a[1] > 0) || a[0] >= b[0]) return null;
      if (isRestatement(a, b)) {
        restated++;
        return null;
      }
      if (!(a[1] * a[2] >= MIN_ASSETS)) {
        tooSmall++;
        return null;
      }
      covered[i]++;
      return round2((b[1] / a[1] - 1) * 100);
    });
    if (row.some((r) => r != null)) returns[code] = row;
  }
  if (restated || tooSmall) {
    log(`Dropped ${restated} unit-price restatements, ` +
      `${tooSmall} funds too small to price at the time`);
  }

  // --- the money-market rate over each fall ---------------------------------
  let cashCodes = [];
  try {
    const known = JSON.parse(await fs.readFile(path.join(DATA, 'funds.json'), 'utf8'));
    cashCodes = known
      .filter((f) => f.cat === MONEY_MARKET_CATEGORY && f.k === 'YAT' && returns[f.c])
      .map((f) => f.c);
  } catch {
    log('  WARN data/funds.json not found — falls will be measured on raw returns');
  }
  const cash = cashReturns(episodes, returns, cashCodes);
  log(`Money-market rate from ${cashCodes.length} funds`);

  // The NAV dates are recorded alongside the market dates so the site can say
  // which prices a figure was actually measured between.
  const out = {
    builtAt: new Date().toISOString(),
    index: 'bist100',
    years: YEARS,
    episodes: episodes.map((e, i) => ({
      ...e,
      cash: cash[i],
      navFrom: firstNavDate(navs.get(e.from)),
      navTo: firstNavDate(navs.get(e.to)),
      funds: covered[i],
    })),
    returns,
  };

  await fs.writeFile(OUT, JSON.stringify(out, null, 1) + '\n');

  log(`Wrote data/crashes.json — ${Object.keys(returns).length} funds`);
  for (const e of out.episodes) {
    log(`  ${e.from}..${e.to}  BIST ${String(e.fall).padStart(6)}%  cash ${String(e.cash).padStart(5)}%` +
      `  ${String(e.funds).padStart(4)} funds  (NAV ${e.navFrom} -> ${e.navTo})`);
  }
  const s = client.stats;
  log(`TEFAS: ${s.requests} requests, ${s.cacheHits} cache hits, ${s.retries} retries`);
  log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('\nCRASH FETCH FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
