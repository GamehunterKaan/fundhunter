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
  const cashReturns = {};
  for (const hz of HORIZONS) cashReturns[hz.key] = returnForHorizon(mmfSeries, hz.key);
  log(`  cash (money-market) returns: ` +
    HORIZONS.map((hz) => `${hz.key} ${cashReturns[hz.key] ?? '—'}%`).join(' · '));

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
    let readFilings = 0;
    let skipped = 0;
    let unusablePrev = 0;

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

      for (const [ticker, row] of perTicker) {
        if (!holders.has(ticker)) holders.set(ticker, []);
        holders.get(ticker).push({
          fund: fund.c, value: row.value, shares: row.shares, weight: row.weight,
          prev: prevUsable ? row.prev : null,
        });
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
      filings: readFilings, skipped, unusablePrev, builtAt: new Date().toISOString(),
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
    const fundReturns = dailyReturns(prices);
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
