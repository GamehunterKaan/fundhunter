#!/usr/bin/env node
//
// Third stage of the pipeline. Enriches data/funds.json with everything that
// needs the full history or the benchmarks:
//
//   flows      net money in/out, separated from performance
//   factors    per-fund regression on BIST / gold / USD / cash
//   peers      peer group derived from actual holdings, plus peer medians
//   risk       volatility band, stance, turnover, age
//   crashes    how each fund fared through BIST’s falls
//   themes     what lines of business it is in, and what its shares yield
//
//   node scripts/build-analytics.mjs
//
// Must run AFTER fetch-tefas.mjs and fetch-benchmarks.mjs. fetch-crashes.mjs is
// optional: without data/crashes.json the crash figures are simply left out, and
// so are the themes without data/sectors.json.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseJsonl, returnOver, returnForHorizon, HORIZONS, LEVERED_FROM, CRASH_PROOF_FROM,
  THEME_IDS, MIN_THEME, aggregateHoldings,
} from '../core.js';
import { isPriceable, listingOf, WEIGHT_BAND } from '../quotes.js';
import { periodMonth } from './lib/portfolio.mjs';
import {
  PEER_GROUPS, TAX_DEFAULTS, FACTORS, LAGGED_FACTORS,
  peerGroupOf, riskBand, stanceOf, leverageOf, netFlow, investorChange,
  allocationTurnover, ridgeFit, dailyReturns, factorReader, median,
  crashProtection, themeExposure, ownership,
  boardSummary, speculativeExposure, MIN_BOARD_FLAGS, SPECULATIVE_HEAVY,
  trending, TREND_SIZE,
} from '../analytics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

/** A fund first seen this long after the window opens was newly launched/listed. */
const NEW_FUND_GRACE_DAYS = 14;

/**
 * The window the factor model is fitted over, in trading days.
 *
 * A year — 252 observations for four factors. Pinned rather than "every date
 * the factors cover", so deepening the benchmark series cannot silently change
 * what a beta or an alpha on this site means.
 */
const FACTOR_WINDOW_DAYS = 252;

/** The last `n` points of an ascending series, or all of it when it is shorter. */
const windowOf = (series, n) => (series.length > n ? series.slice(-n) : series);

/** The last day of a "2026-07" month. Day 0 of the next month is the trick. */
const monthEnd = (ym) => {
  const [y, m] = String(ym).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * The two dates a filing's weight columns straddle, or null.
 *
 * `prevPeriod` is already an ISO month; `period` is a Turkish month name, which
 * is why periodMonth exists. The dates are month ends and the series lookup
 * takes the last close on or before each, so a weekend or a holiday closing the
 * exchange on the 31st costs nothing.
 */
function filingWindow(filing) {
  const to = periodMonth(filing?.period);
  const from = /^\d{4}-\d{2}$/.test(String(filing?.prevPeriod ?? '')) ? filing.prevPeriod : null;
  if (!to || !from || from >= to) return null;
  return [monthEnd(from), monthEnd(to)];
}

// Growth ratios are asked for the same window thousands of times — once per
// holder for the popular shares — so they are cached. Only the ratio is kept,
// never the series: holding 58MB of parsed history in a Map to answer two
// lookups per file would be a strange way to save a disk read.
const ratioCache = new Map();

/** How much a `{d, p}` series grew across a window, or null if it cannot say. */
async function growthOver(file, [from, to]) {
  const key = `${file}|${from}|${to}`;
  if (ratioCache.has(key)) return ratioCache.get(key);
  let out = null;
  try {
    let start = null;
    let end = null;
    for (const row of parseJsonl(await fs.readFile(file, 'utf8'))) {
      if (!(row.p > 0)) continue;
      if (row.d <= from) start = row.p;
      if (row.d <= to) end = row.p;
    }
    out = start > 0 && end > 0 ? end / start : null;
  } catch {
    out = null;
  }
  ratioCache.set(key, out);
  return out;
}

/** The month before an ISO one. "2026-01" -> "2025-12". */
const monthBefore = (ym) => {
  const [y, m] = String(ym).split('-').map(Number);
  return m > 1 ? `${y}-${String(m - 1).padStart(2, '0')}` : `${y - 1}-12`;
};

// Snapshots are loaded once per month asked for, not once per fund. Most of the
// 883 filings cover the same period, and a few are late.
const snapshotCache = new Map();

/**
 * The filings from the month before `month`, as fund -> ticker -> what it held.
 *
 * This is what turns "did the fund buy" from an inference into a measurement: a
 * share count in two consecutive snapshots cannot be moved by the price, so it
 * needs no correction and gets none. Null until archive-weights.mjs has run for
 * two months, and everything downstream falls back to the weight baseline.
 *
 * The snapshot's own per-fund period is checked, so a filing that was late and
 * still carried the older numbers is not compared against itself.
 */
async function snapshotBefore(month, listed) {
  if (!month) return null;
  const want = monthBefore(month);
  if (snapshotCache.has(want)) return snapshotCache.get(want);

  let out = null;
  try {
    const snapshot = JSON.parse(
      await fs.readFile(path.join(DATA, 'weights', `${want}.json`), 'utf8'));
    const funds = new Map();
    for (const [code, fund] of Object.entries(snapshot.funds ?? {})) {
      if (fund?.p !== want) continue;
      const held = new Map();
      for (const [ticker, isin, shares, value] of fund.h ?? []) {
        const code2 = String(ticker ?? '').trim().toUpperCase();
        const key = listed.has(code2) ? code2 : String(isin ?? '').trim().toUpperCase();
        if (!listed.has(key)) continue;
        // Positions split across an ISIN row and a ticker row are added up here
        // exactly as the current month's are, or the two sides would not compare.
        const row = held.get(key) ?? { shares: 0, value: 0 };
        row.shares += Number.isFinite(shares) ? shares : 0;
        row.value += Number.isFinite(value) ? value : 0;
        held.set(key, row);
      }
      if (held.size) funds.set(code, held);
    }
    out = funds.size ? funds : null;
  } catch {
    out = null;
  }
  snapshotCache.set(want, out);
  return out;
}

/**
 * Where a weight would have ended up had the manager not traded.
 *
 * A weight is a position's value over the portfolio's, so with no trades it
 * moves by the share's growth over the fund's. A previous weight of zero is a
 * position opened during the window, and every point of it is a decision — which
 * is exactly what `prev * 0 / nav === 0` says.
 */
const expectedWeight = (prev, share, nav) =>
  Number.isFinite(prev) && prev >= 0 && share > 0 && nav > 0 ? (prev * share) / nav : null;

/** TEFAS's umbrella for the funds the hurdle is measured over. */
const MONEY_MARKET_CATEGORY = 'Para Piyasası Şemsiye Fonu';

/** Below this many money-market funds a median is not a hurdle worth quoting. */
const MIN_CASH_FUNDS = 10;

const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);
const round = (n, p = 4) => (n == null ? null : Math.round(n * 10 ** p) / 10 ** p);

async function main() {
  const t0 = Date.now();
  const funds = JSON.parse(await fs.readFile(path.join(DATA, 'funds.json'), 'utf8'));
  const meta = JSON.parse(await fs.readFile(path.join(DATA, 'meta.json'), 'utf8'));
  const bench = parseJsonl(await fs.readFile(path.join(DATA, 'benchmarks.jsonl'), 'utf8'));
  log(`${funds.length} funds, ${bench.length} benchmark days`);

  // --- factor return series -------------------------------------------------
  // Market factors are read one business day before the TEFAS date; see
  // LAGGED_FACTORS in analytics.js for why.
  const readFactor = {};
  for (const key of FACTORS) {
    const series = bench.filter((b) => b[key] != null).map((b) => [b.d, b[key]]);
    const returns = dailyReturns(series);
    readFactor[key] = factorReader(returns, LAGGED_FACTORS.has(key));
    log(`  factor ${key.padEnd(9)} ${returns.size} daily returns` +
      `${LAGGED_FACTORS.has(key) ? ' (lagged 1 market day)' : ''}`);
  }

  // The money-market index is the hurdle rate every fund is judged against — and
  // it needs one figure PER HORIZON, because a fund's 3-month return may only be
  // compared against the benchmark's 3-month return.
  const mmfSeries = bench.filter((b) => b.mmf != null).map((b) => [b.d, b.mmf]);
  const cashReturn = returnOver(mmfSeries, 365);
  // The hurdle, per horizon.
  //
  // The size-weighted money-market index is the measure everywhere it reaches,
  // and it reaches about a year — it is chained from the fund history on disk,
  // which is a year deep. The three- and five-year windows exist because TEFAS
  // publishes those returns per fund, so the hurdle for them is the median
  // published return of the money-market funds themselves.
  //
  // That is a different measurement of the same thing, not a substitution of one
  // window's figure for another's, which is the line `cashReturnFor` holds. It
  // is only reasonable because the two agree where they overlap: across the five
  // shared windows the median runs 0.02 to 1.16 points under the index, the
  // index being weighted toward the largest and cheapest funds. `cashBasis`
  // records which was used and over how many funds, so the page can say so.
  const moneyMarket = funds.filter((f) => f.cat === MONEY_MARKET_CATEGORY);
  const cashReturns = {};
  const cashBasis = {};
  for (const hz of HORIZONS) {
    const derived = returnForHorizon(mmfSeries, hz.key);
    if (derived != null) {
      cashReturns[hz.key] = derived;
      cashBasis[hz.key] = { from: 'index' };
      continue;
    }
    const published = moneyMarket.map((f) => f.r?.[hz.key]).filter((v) => v != null);
    // Too few money-market funds reach back this far to call it a median of
    // anything, so the hurdle is absent and the column says so rather than
    // quoting a figure off three funds.
    if (published.length < MIN_CASH_FUNDS) continue;
    cashReturns[hz.key] = round(median(published), 2);
    cashBasis[hz.key] = { from: 'published', funds: published.length };
  }
  log(`  cash (money-market) returns: ` +
    HORIZONS.map((hz) => `${hz.key} ${cashReturns[hz.key] ?? '—'}%`
      + (cashBasis[hz.key]?.from === 'published' ? `(${cashBasis[hz.key].funds} funds)` : ''))
      .join(' · '));

  // This script enriches funds.json in place, and the three passes below skip a
  // fund rather than writing a null when they cannot answer for it — so last
  // run's answer would survive a change that should have withdrawn it. Cleared
  // up front, so a rebuild is authoritative rather than cumulative. (In the cron
  // it never matters: fetch-tefas rewrites the file first.)
  for (const fund of funds) {
    delete fund.cr;
    delete fund.th;
    delete fund.dy;
    delete fund.spec;
  }

  // --- leverage -------------------------------------------------------------
  // Derived from the published composition alone, so it is set in its own pass:
  // the main loop below skips any fund without a history file, and a fund's
  // borrowing is knowable without one.
  let levered = 0;
  for (const fund of funds) {
    const lev = leverageOf(fund);
    if (lev == null) continue;
    // Counted on the stored value, not the raw one: the filter reads what is
    // written to the file, so a fund rounding to exactly the threshold must not
    // be reported here as levered and then be missing from the filtered list.
    fund.lev = round(lev, 2);
    if (fund.lev > LEVERED_FROM) levered++;
  }
  log(`  leverage: ${levered} funds hold more than they own`);

  // --- crash protection -----------------------------------------------------
  // Also its own pass, and for the same reason as leverage: the episode returns
  // come from data/crashes.json, which reaches years further back than the daily
  // history the main loop needs.
  let crashes = null;
  try {
    crashes = JSON.parse(await fs.readFile(path.join(DATA, 'crashes.json'), 'utf8'));
  } catch {
    log('  WARN data/crashes.json not found — run fetch-crashes.mjs; skipping crash figures');
  }
  if (crashes) {
    let scored = 0;
    let held = 0;
    for (const fund of funds) {
      const rows = crashes.returns?.[fund.c];
      if (!rows) continue;
      const cp = crashProtection(crashes.episodes, rows);
      if (!cp) continue;
      scored++;
      if (cp.spared >= CRASH_PROOF_FROM) held++;
      // Short keys to match `bm`; `e` is the per-episode detail the fund page
      // reads, aligned to meta.crashes.
      fund.cr = { s: cp.spared, n: cp.n, of: cp.of, w: cp.worst, e: rows };
    }
    meta.crashes = crashes.episodes;
    meta.crashIndex = crashes.index;
    meta.crashYears = crashes.years;
    log(`  crashes: ${crashes.episodes.length} BIST falls, ${scored} funds measured, ` +
      `${held} came through without losing value`);
  }

  // --- themes and dividends -------------------------------------------------
  // Read off the individual positions, so only the funds whose KAP filing could
  // be read get either. Its own pass for the same reason as the two above: the
  // input is data/holdings/, not the daily history the main loop walks.
  let sectors = null;
  try {
    sectors = JSON.parse(await fs.readFile(path.join(DATA, 'sectors.json'), 'utf8'));
  } catch {
    log('  WARN data/sectors.json not found — run fetch-sectors.mjs; skipping themes');
  }
  if (sectors) {
    // undefined: not a listed security. null: listed, nothing known about it.
    // See themeExposure() for why the difference matters.
    const resolve = (position) => {
      if (!isPriceable(position)) return undefined;
      const listing = listingOf(position);
      if (!listing) return undefined;
      const table = sectors.listings?.[listing.market];
      if (!table) return null;
      for (const ticker of listing.tickers) if (table[ticker]) return table[ticker];
      return null;
    };

    let themed = 0;
    let paying = 0;
    let unreconciled = 0;
    let equityWeight = 0;
    let coveredWeight = 0;
    const perTheme = {};

    for (const fund of funds) {
      let holdings;
      try {
        holdings = JSON.parse(await fs.readFile(path.join(DATA, 'holdings', `${fund.c}.json`), 'utf8'));
      } catch {
        continue;
      }
      // The same reconciliation gate the live estimate uses, and for the same
      // reason: 49 filings parse into weights totalling millions of per cent, and
      // a theme weight taken off one of those is not a percentage of anything.
      const total = holdings.holdings.reduce((sum, h) => sum + (h.weight ?? 0), 0);
      if (total < WEIGHT_BAND[0] || total > WEIGHT_BAND[1]) { unreconciled++; continue; }

      const spread = themeExposure(aggregateHoldings(holdings.holdings), resolve);
      if (!spread) continue;

      equityWeight += spread.equity;
      coveredWeight += spread.covered;
      if (Object.keys(spread.themes).length) {
        themed++;
        fund.th = spread.themes;
        for (const [id, weight] of Object.entries(spread.themes)) {
          if (weight >= MIN_THEME) perTheme[id] = (perTheme[id] ?? 0) + 1;
        }
      }
      // Zero is an answer — the fund holds shares and none of them pay — but only
      // when something was actually identified to ask about.
      if (spread.covered > 0) {
        fund.dy = spread.dividend;
        if (fund.dy > 0) paying++;
      }
    }

    meta.themes = THEME_IDS;
    meta.marketYield = sectors.marketYield;
    meta.themeCoverage = round((coveredWeight / equityWeight) * 100, 1);
    log(`  themes: ${themed} funds classified, ${meta.themeCoverage}% of their share weight identified` +
      `, ${unreconciled} filings skipped for not reconciling`);
    log(`  dividends: ${paying} funds hold something that pays; BIST 100 itself yields ${sectors.marketYield}%`);
    log('  funds with at least ' + MIN_THEME + '% in a theme: ' +
      Object.entries(perTheme).sort((a, b) => b[1] - a[1])
        .map(([id, n]) => `${id} ${n}`).join(' · '));
  }

  // --- who owns each share --------------------------------------------------
  // The filings read the other way round. Every other pass here asks what a fund
  // holds; this asks who holds a share, which no share page can answer because
  // it takes all 882 filings at once.
  //
  // The same reconciliation gate as the themes pass, for the same reason: a
  // filing whose weights total 4,000% is not a filing whose lira can be added to
  // anyone else's.
  let stockFile = null;
  try {
    stockFile = JSON.parse(await fs.readFile(path.join(DATA, 'stocks.json'), 'utf8'));
  } catch {
    log('  WARN data/stocks.json not found — run fetch-stocks.mjs; skipping share ownership');
  }
  if (stockFile) {
    const listed = new Map(stockFile.stocks.map((s) => [s.c, s]));
    const holders = new Map();
    const perFund = new Map();
    // Funds that beat the money market over the past year, by the same figure
    // the hurdle everywhere else on the site uses. Gross of withholding: the tax
    // a holder pays depends on the fund and on how long they held it, and
    // neither belongs in a yes-or-no gate on a share list.
    const beatCash = new Set(
      Number.isFinite(cashReturns.y1)
        ? funds.filter((f) => f.r?.y1 > cashReturns.y1).map((f) => f.c)
        : []
    );

    let readFilings = 0;
    let skipped = 0;
    let unusablePrev = 0;
    let baselined = 0;
    let noBaseline = 0;
    let openedCount = 0;
    let leftCount = 0;

    for (const fund of funds) {
      let filing;
      try {
        filing = JSON.parse(await fs.readFile(path.join(DATA, 'holdings', `${fund.c}.json`), 'utf8'));
      } catch {
        continue;
      }
      const total = filing.holdings.reduce((sum, h) => sum + (h.weight ?? 0), 0);
      if (total < WEIGHT_BAND[0] || total > WEIGHT_BAND[1]) { skipped++; continue; }
      readFilings++;

      // Summed here rather than through aggregateHoldings(), which sums weight
      // but keeps the FIRST row's lira and share count — right for a holdings
      // table, wrong for adding a split position up.
      //
      // `prevWeight` is taken as the largest value on the position's rows rather
      // than the sum. The field already holds the position's total, so every row
      // of a split repeats it, and the same holding is filed under an ISIN on one
      // line and a ticker on the next — summing double-counted both.
      const perTicker = new Map();
      for (const position of filing.holdings) {
        const listing = listingOf(position);
        if (listing?.market !== 'bist') continue;
        const ticker = listing.tickers.find((t) => listed.has(t));
        if (!ticker) continue;

        let row = perTicker.get(ticker);
        if (!row) perTicker.set(ticker, row = { value: 0, shares: 0, weight: 0, prev: null });
        row.value += position.value ?? 0;
        row.shares += position.nominal ?? 0;
        row.weight += position.weight ?? 0;
        const prev = position.prevWeight;
        if (Number.isFinite(prev)) row.prev = Math.max(row.prev ?? 0, prev);
      }

      // The previous weights get the same reconciliation gate as the current
      // ones. They are not covered by the check above — that reads `weight` —
      // and a filing whose last-month column totals 2,070,000% can still have a
      // perfectly ordinary this-month column.
      const prevTotal = [...perTicker.values()].reduce((sum, r) => sum + (r.prev ?? 0), 0);
      const prevUsable = prevTotal <= WEIGHT_BAND[1];
      if (!prevUsable) unusablePrev++;

      // The fund's own growth across the same window the weight columns
      // straddle. It is the denominator of the passive baseline, and it is per
      // fund rather than per position, so it is fetched once out here.
      // Does this filing report previous weights at all? 42 of them name a
      // previous period and then leave every cell blank, which is a filer
      // omission and not a fund that rebuilt its entire book in a month. Asking
      // the rows rather than the header is what tells the two apart: where SOME
      // position carries a previous weight, the ones that do not are new.
      const reportsPrev = [...perTicker.values()].some((r) => Number.isFinite(r.prev));

      // What this fund held a month before this filing, if that month was
      // archived. Keyed off the filing's own period so a late one lines up.
      const month = periodMonth(filing.period);
      const before = (await snapshotBefore(month, listed))?.get(fund.c) ?? null;

      const window = filingWindow(filing);
      const navGrowth = window
        ? await growthOver(path.join(DATA, 'history', `${fund.c}.jsonl`), window)
        : null;

      for (const [ticker, row] of perTicker) {
        // A position held now, in a filing that reports previous weights, with
        // no previous weight of its own. Its baseline is zero rather than
        // unknown, so it also counts as bought outright — which it was.
        // Sold out during the window: the row survives at zero because the filer
        // chose to leave it there. Most do not — they simply stop listing the
        // position — so this counts the departures that were written down.
        const was = before?.get(ticker) ?? null;
        // Nothing in it now, and either witness saying there was something in it
        // before. The snapshot is the better witness — it settles the question
        // outright — but a filer who left a zero behind is telling us the same
        // thing, and dropping that because a snapshot exists would lose exits the
        // archive has not reached back far enough to cover.
        const empty = !(row.value > 0) && !(row.weight > 0);
        const left = empty && (was?.value > 0 || row.prev > 0);
        const opened = prevUsable && reportsPrev
          && !Number.isFinite(row.prev) && row.weight > 0;
        const prev = prevUsable ? (opened ? 0 : row.prev) : null;
        const shareGrowth = window
          ? await growthOver(path.join(DATA, 'stocks', `${ticker}.jsonl`), window)
          : null;
        const expected = expectedWeight(prev, shareGrowth, navGrowth);
        if (expected == null) noBaseline++;
        else baselined++;
        if (opened) openedCount++;
        if (left) leftCount++;

        if (!holders.has(ticker)) holders.set(ticker, []);
        holders.get(ticker).push({
          fund: fund.c, value: row.value, shares: row.shares, weight: row.weight,
          prev, expected, opened, left, good: beatCash.has(fund.c),
          flow: Number.isFinite(fund.fl30) ? fund.fl30 : null,
          // Only a positive count is a baseline to subtract from. A zero here
          // would read as "held none last month", which is the opened case, and
          // the snapshot cannot tell a genuine zero from an unfiled row.
          sharesBefore: was?.shares > 0 ? was.shares : null,
        });
      }
      // A share in last month's snapshot that this month's filing does not list
      // at all. This is the exit the filings themselves cannot report: four in
      // five filers simply drop the row, and until now those funds vanished from
      // the arithmetic as though they had never held it.
      if (before) {
        for (const [ticker, was] of before) {
          if (perTicker.has(ticker) || !(was.value > 0)) continue;
          if (!holders.has(ticker)) holders.set(ticker, []);
          holders.get(ticker).push({
            fund: fund.c, value: 0, shares: 0, weight: 0, prev: null,
            expected: null, opened: false, left: true, flow: null,
            good: beatCash.has(fund.c), sharesBefore: was.shares,
          });
          leftCount++;
        }
      }

      // Kept for the speculative pass below, which cannot run until every share
      // has its flags and every share needs this loop's ownership figures first.
      // Re-reading 880 filings to get back to the same numbers would be silly.
      perFund.set(fund.c, new Map([...perTicker].map(([t, r]) => [t, r.weight])));
    }

    let held = 0;
    let ownedValue = 0;
    for (const stock of stockFile.stocks) {
      const own = ownership(holders.get(stock.c) ?? [], { shares: stock.shares, cap: stock.cap });
      if (own) {
        stock.own = own;
        held++;
        ownedValue += own.value;
      } else {
        delete stock.own;
      }
    }

    // Now that ownership is on the shares, the conditions can be tested — one of
    // them is how much of a company a single fund holds, which did not exist a
    // dozen lines ago.
    const flagged = new Set();
    for (const stock of stockFile.stocks) {
      const summary = boardSummary(stock);
      if (summary) {
        stock.spec = summary;
        flagged.add(stock.c);
      } else {
        delete stock.spec;
      }
    }

    let answered = 0;
    let exposed = 0;
    let heavy = 0;
    for (const fund of funds) {
      const exposure = speculativeExposure(perFund.get(fund.c), flagged);
      if (exposure) {
        fund.spec = exposure;
        answered++;
        // Counted off the holdings, not the rounded weight: a fund holding
        // 0.004% of a flagged share rounds to w: 0 and still holds one.
        if (exposure.codes?.length) exposed++;
        if (exposure.w >= SPECULATIVE_HEAVY) heavy++;
      } else {
        delete fund.spec;
      }
    }
    log(`  speculative boards: ${flagged.size} listings meet ${MIN_BOARD_FLAGS}+ conditions ` +
      `including a run-up; of ${answered} funds whose shares could be read, ` +
      `${exposed} hold at least one and ${heavy} hold ${SPECULATIVE_HEAVY}% or more ` +
      `of themselves in them`);

    stockFile.ownershipFrom = {
      filings: readFilings, skipped, unusablePrev, baselined, noBaseline,
      builtAt: new Date().toISOString(),
    };
    // Every code the exchange actually lists, in meta.json — 5KB, loaded on boot.
    // A fund page holds tickers the scanner has never heard of (ZPX30, APLIB:
    // small ETFs and delisted names, 8 of them across 882 filings), and without
    // this list it linked them anyway and the reader landed on a page saying the
    // code does not exist. The index itself is 490KB and is not worth loading on
    // a fund page to answer one yes-or-no question per row.
    meta.listedCodes = stockFile.stocks.map((s) => s.c).sort();

    // The dashboard already asks the scanner for the whole exchange, so it holds
    // today's move for every ticker and needs no second request to say what a
    // theme or the index did. What it does NOT hold is which ticker belongs to
    // what, or how big each one is — and loading the 900KB share index on the
    // home page to find out would be absurd. These two maps are that membership,
    // and they cost about 12KB in a file every visitor loads anyway.
    const companies = stockFile.stocks.filter((s) => s.kind === 'stock' && s.cap > 0);

    // Weights, not caps: normalised per theme they round to four places and stay
    // small, and a raw market value would be stale the moment the price moved.
    meta.themeWeights = {};
    for (const id of THEME_IDS) {
      const members = companies.filter((s) => s.th === id);
      const total = members.reduce((sum, s) => sum + s.cap, 0);
      if (!members.length || !total) continue;
      meta.themeWeights[id] = members
        .map((s) => [s.c, round(s.cap / total, 4)])
        .filter(([, w]) => w > 0)
        .sort((a, b) => b[1] - a[1]);
    }

    // The index members, for the movers strip. The universe matters more than
    // the ranking: the biggest movers on the whole exchange are always the
    // smallest listings on it, hitting their price limit on a few thousand lira
    // of trade, which says nothing about the day.
    meta.bist100 = companies.filter((s) => s.bx != null).map((s) => s.c).sort();

    // What has been running over the last few days. A week is not a figure the
    // quote scan carries — it prices today — so unlike the two maps above this
    // is an answer rather than a membership, computed here once a day and read
    // straight off meta.json. It is about a kilobyte, and the alternative is the
    // 900KB share index on the home page.
    meta.trending = trending(stockFile.stocks, 'w1', TREND_SIZE);
    if (meta.trending) {
      const top = meta.trending.sectors[0];
      log(`  trending over a week: ${meta.trending.sectors.length} sectors ` +
        `(${top.id} ${top.move > 0 ? '+' : ''}${top.move}%), ` +
        `${meta.trending.shares.length} shares from the ${meta.trending.of} that trade ` +
        `at least ₺${Math.round(meta.trending.floor / 1e6)}m a day` +
        `${meta.trending.shares.some((s) => s.spec) ? ', some of them flagged' : ''}`);
    }

    await fs.writeFile(path.join(DATA, 'stocks.json'), JSON.stringify(stockFile) + '\n');
    log(`  membership: ${Object.keys(meta.themeWeights).length} themes carry ` +
      `${Object.values(meta.themeWeights).reduce((n, m) => n + m.length, 0)} companies, ` +
      `${meta.bist100.length} in a headline index`);
    log(`  passive drift: ${baselined} of ${baselined + noBaseline} holdings could be ` +
      `measured against what the market would have done on its own`);
    log(`  quality of holders: ${beatCash.size} of ${funds.length} funds beat cash over a year`);
    log(`  positions opened since the previous filing: ${openedCount}, sold out: ${leftCount}`);
    log(`  previous snapshots: ${[...snapshotCache].filter(([, v]) => v).map(([m]) => m).join(', ') || 'none yet — run archive-weights.mjs monthly'}`);
    log(`  share ownership: ${held} of ${stockFile.stocks.length} shares are held by a fund, ` +
      `₺${(ownedValue / 1e9).toFixed(1)}bn in all, from ${readFilings} filings ` +
      `(${skipped} did not reconcile, ${unusablePrev} carry no usable previous weights)`);
  }

  const windowStart = meta.rangeStart;
  const newCutoff = new Date(Date.parse(windowStart) + NEW_FUND_GRACE_DAYS * 86400000)
    .toISOString().slice(0, 10);

  let modelled = 0;
  let noModel = 0;

  for (const fund of funds) {
    let records;
    try {
      records = parseJsonl(await fs.readFile(path.join(DATA, 'history', `${fund.c}.jsonl`), 'utf8'));
    } catch {
      continue;
    }

    const prices = records.filter((r) => r.p != null).map((r) => [r.d, r.p]);
    const allocs = records.filter((r) => r.a).map((r) => r.a);

    // --- classification ---
    fund.peer = peerGroupOf(fund);
    fund.stance = stanceOf(fund);
    // Our own volatility band, kept alongside TEFAS's official risk value rather
    // than replacing it: they measure different things, and the official figure
    // is the one that carries regulatory meaning (7 = qualified investors only).
    fund.volBand = riskBand(fund.vol);
    if (fund.risk == null) fund.risk = fund.volBand;

    // --- lifecycle ---
    if (prices.length) {
      const first = prices[0][0];
      fund.age = Math.round((Date.parse(fund.d) - Date.parse(first)) / 86400000);
      if (first > newCutoff) fund.new = true;
    }

    // --- last published move ---
    // The change between the two most recent NAVs. TEFAS publishes one business
    // day late, so this is the fund's latest *published* move, not today's.
    if (prices.length >= 2) {
      const [, prev] = prices[prices.length - 2];
      const [, last] = prices[prices.length - 1];
      if (prev > 0) fund.ch = round((last / prev - 1) * 100, 2);
    }

    // --- flows ---
    // The 7-day window is what the dashboard leads with: "who took money in this
    // week" is a different question from "this month", and on a page you open
    // daily the monthly figure barely moves.
    fund.fl7 = netFlow(records, 7);
    fund.fl30 = netFlow(records, 30);
    fund.fl90 = netFlow(records, 90);
    fund.iv7 = investorChange(records, 7);
    fund.iv30 = investorChange(records, 30);
    fund.turn = allocationTurnover(allocs);

    // --- factor model ---
    // Over a stated window, for the same reason volatility is: the fit used to
    // run over every date carrying all four factors, which was about a year only
    // because the money-market factor was. Once that series deepens the fit
    // would have quietly become a five-year one, blending 2021's regime into
    // today's betas and moving `alpha` under a panel that never mentioned it.
    const fundReturns = dailyReturns(windowOf(prices, FACTOR_WINDOW_DAYS));
    const y = [];
    const X = [];
    for (const [date, r] of fundReturns) {
      const row = FACTORS.map((f) => readFactor[f](date));
      if (row.some((v) => v == null)) continue;
      // A single bad print can dominate a least-squares fit; drop absurd days.
      if (Math.abs(r) > 0.5) continue;
      y.push(r);
      X.push(row);
    }

    const fit = ridgeFit(y, X);
    if (fit) {
      modelled++;
      fund.bm = {
        i: round(fit.intercept, 6),
        c: fit.coef.map((v) => round(v, 4)),
        r2: round(fit.r2, 3),
        se: round(fit.se, 6),
        n: fit.n,
      };
      // Annualised alpha: the part of the return the factor exposures do not explain.
      fund.alpha = round(((1 + fit.intercept) ** 252 - 1) * 100, 2);
    } else {
      noModel++;
    }
  }

  // --- peer medians ---------------------------------------------------------
  const peerStats = {};
  for (const group of PEER_GROUPS) {
    const members = funds.filter((f) => f.peer === group.id);
    peerStats[group.id] = {
      count: members.length,
      medianY1: median(members.map((f) => f.r?.y1)),
      medianVol: median(members.map((f) => f.vol)),
    };
  }

  meta.peerGroups = PEER_GROUPS;
  meta.peerStats = peerStats;
  meta.cashReturn = cashReturn;
  meta.cashReturns = cashReturns;
  meta.cashBasis = cashBasis;
  meta.taxDefaults = TAX_DEFAULTS;
  meta.factors = FACTORS;
  meta.analyticsBuiltAt = new Date().toISOString();

  await fs.writeFile(path.join(DATA, 'meta.json'), JSON.stringify(meta, null, 2));
  await fs.writeFile(
    path.join(DATA, 'funds.json'),
    '[\n' + funds.map((f) => JSON.stringify(f)).join(',\n') + '\n]\n'
  );

  log(`factor models: ${modelled} fitted, ${noModel} skipped (too little history)`);
  log('peer groups:');
  for (const g of PEER_GROUPS) {
    const s = peerStats[g.id];
    log(`  ${g.id.padEnd(13)} ${String(s.count).padStart(5)} funds, median 1y ${s.medianY1 ?? '—'}%`);
  }
  log(`new funds: ${funds.filter((f) => f.new).length}`);
  log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('\nANALYTICS FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
