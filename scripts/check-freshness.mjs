#!/usr/bin/env node
// Ask the live site what dates it is showing, ask TEFAS and TradingView what
// dates they currently have, and say whether those agree per fund/stock row.
//
//   node scripts/check-freshness.mjs [--site=https://…] [--github-output]
//
// Exits 0 when the site is current and 1 when it is not, so it can be a check
// on its own. `--github-output` additionally writes the verdict to
// $GITHUB_OUTPUT for the workflow to act on, in which case the exit code is
// left at 0 — the workflow decides what a stale site is worth, and a step that
// went red would stop it deciding anything.
//
// The site is read over the network rather than off disk on purpose. A repo
// with today's files in it is not the same claim as a site serving them, and
// every part of the distance between those two has failed at least once.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TefasClient, requestBody, ymd, addDays } from './lib/tefas.mjs';
import { freshnessVerdict } from './lib/freshness.mjs';
import { quoteDateOf } from './lib/stock-dates.mjs';
import { combineFreshnessVerdicts, stockFreshnessVerdict } from './lib/stock-freshness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INFO_METHOD = 'fonGnlBlgSiraliGetir';
const STOCK_SCAN = 'https://scanner.tradingview.com/turkey/scan';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

async function defaultSite() {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  return (pkg.homepage ?? '').replace(/\/$/, '');
}

/** The newest date TEFAS has any fund data for, probed over a trailing window. */
async function tefasLatestDate() {
  // No cache: this is the one question whose whole value is that the answer is
  // current, and the disk cache is the thing that made it wrong once already.
  const client = new TefasClient({ cacheDir: null, maxRetry: 4 });
  const today = new Date();
  const rows = await client.post(
    INFO_METHOD,
    requestBody({ fonTipi: 'YAT', basTarih: ymd(addDays(today, -10)), bitTarih: ymd(today) }),
    { reduce: (r) => r.map((x) => [x.tarih]) }
  );
  return rows.length ? rows.map((r) => r[0]).sort().at(-1) : null;
}

/** What the live site says it is showing. */
async function siteMeta(site) {
  // Past every cache between here and the origin: a check that can be answered
  // from a cache is a check that can agree with the bug it is looking for.
  const url = `${site}/data/meta.json?freshness=${Date.now()}`;
  const r = await fetch(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
  if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
  return r.json();
}

/** The stock artifact actually served to readers, past every intermediary cache. */
async function siteStocks(site) {
  const url = `${site}/data/stocks.json?freshness=${Date.now()}`;
  const r = await fetch(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
  if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
  return r.json();
}

/** Current per-symbol session dates from the same feed that supplies p/ch. */
async function tradingViewQuoteDates() {
  const r = await fetch(STOCK_SCAN, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ columns: ['name', 'last_bar_update_time'], range: [0, 5000] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`TradingView scanner: HTTP ${r.status}`);
  const json = await r.json();
  const dates = new Map();
  for (const row of json.data ?? []) {
    const code = row.d?.[0];
    const date = quoteDateOf(row.d?.[1]);
    if (code && date) dates.set(code, date);
  }
  if (!dates.size) throw new Error('TradingView scanner returned no dated stock rows');
  return dates;
}

const site = (args.site === true ? null : args.site) ?? (await defaultSite());

let verdict;
try {
  const now = new Date();
  const [meta, stocks, tefasDate, quoteDates] = await Promise.all([
    siteMeta(site), siteStocks(site), tefasLatestDate(), tradingViewQuoteDates(),
  ]);
  const fundVerdict = freshnessVerdict({
    siteDate: meta.latestDate ?? null,
    tefasDate,
    lastUpdated: meta.lastUpdated ?? null,
    lagging: meta.counts?.lagging ?? null,
    funds: meta.counts?.funds ?? null,
    now,
  });
  const stockVerdict = stockFreshnessVerdict({
    stockData: stocks,
    referenceQuoteDates: quoteDates,
    now,
  });
  verdict = combineFreshnessVerdicts(fundVerdict, stockVerdict);
  verdict.siteDate = meta.latestDate ?? null;
  verdict.tefasDate = tefasDate;
  verdict.lastUpdated = meta.lastUpdated ?? null;
  verdict.lagging = meta.counts?.lagging ?? null;
  verdict.funds = meta.counts?.funds ?? null;
} catch (e) {
  // Unreachable is not the same as stale, but it is not fine either, and the
  // one thing it must not do is pass quietly.
  verdict = {
    ok: false,
    level: 'alert',
    behindDays: 0,
    reason: `could not check ${site}: ${e.message}`,
  };
}

console.log(verdict.ok ? `fresh — ${verdict.reason}` : `STALE — ${verdict.reason}`);
if (verdict.lastUpdated) console.log(`  site last updated ${verdict.lastUpdated}`);
// Reported, not yet alerted on. A fund inside its grace window that has not
// printed today is normal and self-correcting, and the build drops it after
// five silent trading days on its own. What the right number is on an ordinary
// day is not something to guess at — so it is instrumented first and given a
// threshold once there is a baseline to set one from.
if (verdict.lagging != null) {
  console.log(`  funds published at an older date: ${verdict.lagging} of ${verdict.funds}`);
}
if (verdict.stock_count != null) {
  console.log(`  stocks built ${verdict.stock_builtAt ?? 'unknown'}; ` +
    `quote session ${verdict.stock_referenceQuoteDate ?? 'unknown'}; ` +
    `Yahoo through ${verdict.stock_latestHistoryDate ?? 'unknown'}`);
  console.log(`  stock rows: ${verdict.stock_staleQuotes ?? 0} stale quotes, ` +
    `${verdict.stock_staleHistory ?? 0} stale histories, ` +
    `${verdict.stock_missingQuoteDates ?? 0} missing quote dates, ` +
    `${verdict.stock_missingHistoryDates ?? 0} missing history dates`);
}
console.log(`  level: ${verdict.level}`);

if (args['github-output'] && process.env.GITHUB_OUTPUT) {
  await fs.appendFile(
    process.env.GITHUB_OUTPUT,
    [
      `ok=${verdict.ok}`,
      `level=${verdict.level}`,
      `behind_days=${verdict.behindDays}`,
      `reason=${verdict.reason}`,
      `site_date=${verdict.siteDate ?? ''}`,
      `lagging=${verdict.lagging ?? ''}`,
      `tefas_date=${verdict.tefasDate ?? ''}`,
      `stocks_built_at=${verdict.stock_builtAt ?? ''}`,
      `stock_quote_date=${verdict.stock_referenceQuoteDate ?? ''}`,
      `stock_history_date=${verdict.stock_latestHistoryDate ?? ''}`,
      `stale_stock_quotes=${verdict.stock_staleQuotes ?? ''}`,
      `stale_stock_history=${verdict.stock_staleHistory ?? ''}`,
      `missing_stock_quotes=${verdict.stock_missingQuoteDates ?? ''}`,
      `missing_stock_history=${verdict.stock_missingHistoryDates ?? ''}`,
      '',
    ].join('\n')
  );
  process.exit(0);
}

process.exit(verdict.ok ? 0 : 1);
