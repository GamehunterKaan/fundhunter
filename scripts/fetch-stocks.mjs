#!/usr/bin/env node
//
// Borsa İstanbul shares: what each company is worth, what it earns, and what its
// price has done.
//
//   node scripts/fetch-stocks.mjs [--no-cache] [--limit N] [--only CODE,CODE]
//                                 [--figures-only]
//
// The site already knows every fund's holdings, which means it knows more about
// who owns Turkish shares than a share page normally can. This is the other half
// of that: the share itself, so a holding can be clicked on.
//
// Two sources, because no free one has both halves:
//
//   figures   TradingView's scanner — the same feed quotes.js prices holdings
//             from at runtime and fetch-sectors.mjs reads industries from. One
//             request returns the whole exchange with ninety columns, and the
//             company statements come back in the same one: eight years of
//             quarters and twenty of years, per listing, for one round trip.
//   history   Yahoo Finance's chart endpoint, one request per share. Its
//             adjusted close is what gets stored: Turkish companies issue bonus
//             shares constantly, and a raw close series reads a 1:10 bonus as a
//             90% crash.
//
// Output:
//   data/stocks.json             one row per share, figures and identity
//   data/stocks/<CODE>.jsonl     daily close and volume, a year of it
//   data/stocks/<CODE>.fin.json  the statements, for the share's own page only
//
// The split is about what each page needs. Everyone who opens the share LIST
// downloads stocks.json; nobody reading a list needs eight years of a company's
// cash flow, and folding the statements in would take that file from 0.9 MB to
// 3.4 MB. One extra 4KB file on the one page that uses them is the trade.
//
// `--figures-only` skips the Yahoo pass. The figures and the statements are one
// request; the history is 648, and it has not moved since this morning.
//
// build-analytics.mjs then adds the half only this project can answer: which
// funds hold the share, and whether they have been buying it.

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mergeJsonl } from './lib/jsonl.mjs';
import { THEME_OF_INDUSTRY, THEME_OVERRIDES, POOLED_INDUSTRY } from './lib/taxonomy.mjs';
import { periodEnds, quarterLabel } from '../analytics.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const HIST_DIR = path.join(DATA, 'stocks');
/** The statements live beside the price history, one file per share. */
const FIN_DIR = HIST_DIR;
const OUT = path.join(DATA, 'stocks.json');
const CACHE = path.join(ROOT, '.cache', 'yahoo');

const SCAN = 'https://scanner.tradingview.com/turkey/scan';
/** Kept identical to quotes.js: same endpoint, provably the same way of asking. */
const SCAN_HEADERS = { 'Content-Type': 'text/plain' };

const CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
// Yahoo answers a plain fetch, but not one that looks like a script.
const CHART_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; FundHunter/1.0)' };

/** As much history as the fund side keeps, so the two can be charted together. */
const HISTORY_RANGE = '1y';
const HISTORY_DAYS = 400;

/** Yahoo is not a licensed feed; four in flight is polite and takes ~2 minutes. */
const CONCURRENCY = 4;
const MIN_INTERVAL_MS = 90;
const MAX_RETRY = 4;
const TIMEOUT_MS = 20_000;

/**
 * Every column the scanner is asked for, in the order the row comes back.
 *
 * Named in full here and mapped to the short keys the browser reads in shape(),
 * so both halves of the contract sit on one screen.
 */
const COLUMNS = [
  'name', 'description', 'type', 'typespecs', 'sector', 'industry', 'currency',
  'close', 'change', 'volume', 'average_volume_10d_calc', 'relative_volume_10d_calc',
  'market_cap_basic', 'total_shares_outstanding_fundamental', 'float_shares_percent_current',
  'price_earnings_ttm', 'price_book_fq', 'price_sales_current', 'enterprise_value_ebitda_ttm',
  'earnings_per_share_diluted_ttm', 'earnings_per_share_diluted_yoy_growth_ttm',
  'dividends_yield_current', 'dividend_payout_ratio_ttm', 'dps_common_stock_prim_issue_fy',
  'return_on_equity', 'return_on_assets', 'return_on_invested_capital',
  'debt_to_equity', 'current_ratio',
  'gross_margin_ttm', 'operating_margin_ttm', 'net_margin_ttm',
  'total_revenue_ttm', 'net_income_ttm', 'ebitda_ttm', 'free_cash_flow_ttm',
  'total_debt', 'total_assets',
  'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'Perf.5Y',
  'Volatility.M', 'beta_1_year', 'price_52_week_high', 'price_52_week_low',
  'RSI', 'SMA50', 'SMA200', 'recommendation_mark', 'number_of_employees',
  // The balance sheet, what analysts think, and two solvency scores. Small
  // enough to sit in the index beside the price; the statements themselves are
  // far too big for it and go into a file of their own.
  'total_equity_fq', 'total_liabilities_fq', 'cash_n_short_term_invest_fq', 'net_debt',
  'book_value_per_share_fq', 'short_term_debt_fq', 'long_term_debt_fq',
  'price_target_average', 'price_target_high', 'price_target_low',
  'recommendation_total', 'recommendation_buy', 'recommendation_hold', 'recommendation_sell',
  'altman_z_score_ttm', 'piotroski_f_score_ttm', 'revenue_per_employee',
  'submarket', 'continuous_dividend_payout', 'ex_dividend_date_recent',
  'earnings_release_next_date',
];

/**
 * The statements themselves: eight years of quarters, twenty years of years.
 *
 * Asked for in the same request as everything else — the scanner charges the
 * same one round trip for ninety columns as for fifty — but written per share
 * rather than into the index. Together they are 2.8 MB of the response and
 * would quadruple the file every visitor downloads to see a LIST of shares.
 *
 * Every `_h` array comes back newest-first with no dates attached; see
 * periodEnds() for how they are dated.
 */
const DEEP_COLUMNS = [
  'fiscal_period_end_fq', 'fiscal_period_fy_h', 'indexes',
  'total_revenue_fq_h', 'gross_profit_fq_h', 'ebitda_fq_h', 'net_income_fq_h',
  'earnings_per_share_diluted_fq_h', 'free_cash_flow_fq_h',
  'capital_expenditures_unchanged_fq_h', 'total_assets_fq_h', 'total_debt_fq_h',
  'total_revenue_fy_h', 'gross_profit_fy_h', 'ebitda_fy_h', 'net_income_fy_h',
  'earnings_per_share_diluted_fy_h', 'free_cash_flow_fy_h',
  'capital_expenditures_unchanged_fy_h', 'total_assets_fy_h', 'total_debt_fy_h',
  'dps_common_stock_prim_issue_fy_h',
  // Actual against what analysts had forecast, quarter by quarter, already
  // carrying its own period labels — which is what makes it the control the
  // undated arrays are checked against.
  'revenues_fq_h', 'earnings_fq_h',
];

const args = process.argv.slice(2);
const USE_CACHE = !args.includes('--no-cache');
/** Skip the Yahoo pass: the figures come from one request, the history from 648. */
const FIGURES_ONLY = args.includes('--figures-only');
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || null;
const ONLY = args.includes('--only')
  ? args[args.indexOf('--only') + 1].split(',').map((s) => s.trim().toUpperCase())
  : null;

const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** null rather than 0 for a missing figure: a P/E of 0 is a claim, absence is not. */
const num = (v, digits = 2) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10 ** digits) / 10 ** digits;
};
const int = (v) => {
  if (v == null || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------- the figures

async function scanMarket() {
  const asked = [...COLUMNS, ...DEEP_COLUMNS];
  const res = await fetch(SCAN, {
    method: 'POST',
    headers: SCAN_HEADERS,
    body: JSON.stringify({ columns: asked, range: [0, 5000] }),
  });
  if (!res.ok) throw new Error(`scanner: HTTP ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).map((row) => Object.fromEntries(asked.map((c, i) => [c, row.d[i]])));
}

/**
 * A listing's kind: a company, an exchange-traded fund, or a closed-end trust.
 *
 * The scanner calls the last two both "fund"; `typespecs` is what separates
 * them, and the difference matters — a trust trades at a discount to its assets
 * and an ETF does not.
 */
function kindOf(r) {
  if (r.type === 'stock') return 'stock';
  const specs = Array.isArray(r.typespecs) ? r.typespecs : [];
  if (specs.includes('closedend')) return 'trust';
  if (specs.includes('etf')) return 'etf';
  return 'other';
}

/**
 * One share, in the short keys the browser reads.
 *
 * Percentages and ratios keep two decimals, money is whole: a P/E to four places
 * implies a precision quarterly accounts do not have.
 */
function shape(r) {
  const theme = r.industry === POOLED_INDUSTRY
    ? null
    : THEME_OVERRIDES[r.name] ?? THEME_OF_INDUSTRY.get(r.industry) ?? null;

  return {
    c: r.name,
    n: r.description,
    // What the listing IS, because the exchange lists three kinds of thing and
    // only one of them has earnings. The share list shows companies; the index
    // carries all of them, so that a fund holding an exchange-traded fund has
    // somewhere to link to.
    kind: kindOf(r),
    sec: r.sector ?? null,
    ind: r.industry ?? null,
    th: theme,
    p: num(r.close, 4),
    ch: num(r.change),
    vol: int(r.volume),
    avgVol: int(r.average_volume_10d_calc),
    relVol: num(r.relative_volume_10d_calc),
    cap: int(r.market_cap_basic),
    shares: int(r.total_shares_outstanding_fundamental),
    float: num(r.float_shares_percent_current),
    pe: num(r.price_earnings_ttm),
    pb: num(r.price_book_fq),
    ps: num(r.price_sales_current),
    evEbitda: num(r.enterprise_value_ebitda_ttm),
    eps: num(r.earnings_per_share_diluted_ttm),
    epsG: num(r.earnings_per_share_diluted_yoy_growth_ttm),
    dy: num(r.dividends_yield_current),
    // A payout ratio of exactly zero beside a positive yield is a contradiction,
    // and the scanner reports one for 179 Borsa İstanbul companies — Ford Otosan
    // yields 12% and is filed as paying out none of its earnings. The yield is
    // the half that can be checked against a price, so the ratio is dropped
    // rather than printed as a fact.
    payout: payoutOf(r),
    dps: num(r.dps_common_stock_prim_issue_fy, 4),
    roe: num(r.return_on_equity),
    roa: num(r.return_on_assets),
    roic: num(r.return_on_invested_capital),
    de: num(r.debt_to_equity),
    cur: num(r.current_ratio),
    gm: num(r.gross_margin_ttm),
    om: num(r.operating_margin_ttm),
    nm: num(r.net_margin_ttm),
    rev: int(r.total_revenue_ttm),
    ni: int(r.net_income_ttm),
    ebitda: int(r.ebitda_ttm),
    fcf: int(r.free_cash_flow_ttm),
    debt: int(r.total_debt),
    assets: int(r.total_assets),
    r: {
      w1: num(r['Perf.W'], 1),
      m1: num(r['Perf.1M'], 1),
      m3: num(r['Perf.3M'], 1),
      m6: num(r['Perf.6M'], 1),
      ytd: num(r['Perf.YTD'], 1),
      y1: num(r['Perf.Y'], 1),
      y5: num(r['Perf.5Y'], 1),
    },
    vola: num(r['Volatility.M']),
    beta: num(r.beta_1_year),
    hi52: num(r.price_52_week_high, 4),
    lo52: num(r.price_52_week_low, 4),
    rsi: num(r.RSI, 1),
    sma50: num(r.SMA50, 4),
    sma200: num(r.SMA200, 4),
    rec: num(r.recommendation_mark),
    staff: int(r.number_of_employees),

    // The balance sheet in five numbers. Banks report none of them the way an
    // industrial company does, so most come back null for the financials and
    // the panel that shows them simply gets shorter.
    eq: int(r.total_equity_fq),
    liab: int(r.total_liabilities_fq),
    cash: int(r.cash_n_short_term_invest_fq),
    // Signed on purpose: a company with more cash than borrowings has NEGATIVE
    // net debt, and clamping that at zero would hide the strongest balance
    // sheets on the exchange.
    ndebt: int(r.net_debt),
    stDebt: int(r.short_term_debt_fq),
    ltDebt: int(r.long_term_debt_fq),
    bvps: num(r.book_value_per_share_fq, 4),

    tgt: num(r.price_target_average, 4),
    tgtHi: num(r.price_target_high, 4),
    tgtLo: num(r.price_target_low, 4),
    recN: int(r.recommendation_total),
    recBuy: int(r.recommendation_buy),
    recHold: int(r.recommendation_hold),
    recSell: int(r.recommendation_sell),

    altman: num(r.altman_z_score_ttm),
    piotroski: int(r.piotroski_f_score_ttm),
    revPer: int(r.revenue_per_employee),

    mkt: r.submarket ?? null,
    // The smallest size index it belongs to, which is the one that says
    // something: every BIST 30 member is also in the 50 and the 100.
    bx: sizeIndex(r.indexes),
    divYears: int(r.continuous_dividend_payout),
    exDiv: dateOf(r.ex_dividend_date_recent),
    nextReport: dateOf(r.earnings_release_next_date),
  };
}

/** The payout ratio, unless it disagrees with the yield about whether it paid. */
function payoutOf(r) {
  const ratio = num(r.dividend_payout_ratio_ttm);
  const yld = num(r.dividends_yield_current);
  return ratio === 0 && yld > 0 ? null : ratio;
}

/** A unix second as a plain date, or null. The scanner dates events in UTC. */
const dateOf = (ts) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : null;
};

/**
 * 30, 50 or 100 — the narrowest headline index the share is in.
 *
 * Matched on the exact names the scanner uses, not on any "BIST 100 Capped 25"
 * or "BIST 30 Equal Weighted Return" variant it also lists: those are separate
 * products, and a share can be in a capped index without being in the plain one.
 */
function sizeIndex(indexes) {
  if (!Array.isArray(indexes)) return null;
  const names = new Set(indexes.map((x) => x?.name));
  for (const n of [30, 50, 100]) if (names.has(`BIST ${n}`)) return n;
  return null;
}

// ----------------------------------------------------------- the statements

/** Which scanner arrays become which key, for the quarterly and annual blocks. */
const STATEMENT_KEYS = [
  ['rev', 'total_revenue', 0],
  ['gp', 'gross_profit', 0],
  ['ebitda', 'ebitda', 0],
  ['ni', 'net_income', 0],
  ['eps', 'earnings_per_share_diluted', 4],
  ['fcf', 'free_cash_flow', 0],
  ['capex', 'capital_expenditures_unchanged', 0],
  ['assets', 'total_assets', 0],
  ['debt', 'total_debt', 0],
];

/**
 * A block of statement series, oldest-first and all the same length.
 *
 * The scanner's arrays are newest-first and NOT the same length as each other —
 * a company can have thirty-two quarters of revenue and twenty-four of EBITDA.
 * Since index 0 is the latest for every one of them, they are padded at the old
 * end and then reversed, which lines every series up on the same period without
 * ever shifting a number onto the wrong date.
 */
function statementBlock(row, period, periods) {
  const arrays = STATEMENT_KEYS.map(([key, field, digits]) =>
    [key, row[`${field}_${period}_h`], digits]);
  const len = Math.max(0, ...arrays.map(([, a]) => (Array.isArray(a) ? a.length : 0)));
  if (!len) return null;

  const out = { p: periods(len) };
  for (const [key, arr, digits] of arrays) {
    if (!Array.isArray(arr)) continue;
    const padded = Array.from({ length: len }, (_, i) => num(arr[i], digits));
    if (padded.every((v) => v == null)) continue;
    out[key] = padded.reverse();
  }
  // Every series has been reversed; the labels are generated newest-first too.
  out.p = out.p.reverse();
  return Object.keys(out).length > 1 ? out : null;
}

/**
 * Reported revenue against what analysts had forecast, oldest-first.
 *
 * This feed is the only one that dates itself, which is why it doubles as the
 * check on the dating of everything else. Its last row is often the quarter the
 * company has not reported yet, carrying an estimate and no actual — kept,
 * because "what the street expects next" is exactly the row a reader wants.
 *
 * Revenue only. The scanner offers the same structure for earnings per share
 * and it does not hold up: of 370 quarters where both it and the company's own
 * statements carry a figure, 148 disagree by more than 5% — FROTO's March
 * quarter comes back exactly ten times too large, İş Bankası's is out by a
 * factor of 280. Revenue agrees wherever both are present, so revenue is what
 * gets published and the earnings series is left alone.
 */
function estimateRows(row) {
  const arr = row.revenues_fq_h;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e) => e?.FiscalPeriod && (e.Actual != null || e.Estimate != null))
    .map((e) => ({
      p: e.FiscalPeriod,
      done: Boolean(e.IsReported),
      rev: int(e.Actual),
      revE: int(e.Estimate),
    }))
    .sort((a, b) => a.p.localeCompare(b.p));
}

/**
 * Everything about one company that only its own page needs.
 *
 * Returned as null when the scanner carries no statements at all for the
 * listing — which is every exchange-traded fund on the exchange, and a handful
 * of companies too newly listed to have filed.
 */
function fundamentals(row) {
  const anchor = dateOf(row.fiscal_period_end_fq);
  const years = Array.isArray(row.fiscal_period_fy_h) ? row.fiscal_period_fy_h : null;

  const q = anchor ? statementBlock(row, 'fq', (len) => periodEnds(anchor, len)) : null;
  // Annual periods are labelled by the scanner itself, so they are taken rather
  // than derived; without that array there is nothing to date them against.
  const y = years
    ? statementBlock(row, 'fy', (len) =>
        Array.from({ length: len }, (_, i) => years[i] ?? null))
    : null;
  if (y && Array.isArray(row.dps_common_stock_prim_issue_fy_h)) {
    const dps = Array.from({ length: y.p.length },
      (_, i) => num(row.dps_common_stock_prim_issue_fy_h[i], 4)).reverse();
    if (dps.some((v) => v != null)) y.dps = dps;
  }

  const est = estimateRows(row);
  const idx = Array.isArray(row.indexes)
    ? row.indexes.map((x) => x?.name).filter(Boolean)
    : [];
  if (!q && !y && !est.length) return null;

  return {
    c: row.name,
    // Stated rather than assumed. Turkish companies have reported under
    // inflation accounting since 2023 and as-reported before it, so a lira
    // figure from 2019 and one from 2026 are not in the same lira. The page
    // says so; the file says why it has to.
    basis: 'as-reported nominal TRY',
    anchor,
    q,
    y,
    est,
    idx,
  };
}

/**
 * Write one statement file per listing, and check the dating while doing it.
 *
 * The check is the point of doing it here. The quarterly arrays carry no dates,
 * so periodEnds() derives them — and the estimate feed, which labels its own
 * periods, is an independent witness to whether that derivation is right. Where
 * both carry the same quarter the revenue figures should agree; where they
 * disagree it is almost always a restatement, which Turkish inflation
 * accounting produces constantly. A collapse in the agreement rate is the
 * signal that TradingView has changed the order or the anchor of its arrays.
 */
async function writeFundamentals(rows) {
  const out = { written: new Set(), quarters: 0, annual: 0, estimates: 0, checked: 0, hits: [0, 0, 0] };

  for (const row of rows) {
    const fin = fundamentals(row);
    if (!fin) continue;
    if (fin.q) out.quarters++;
    if (fin.y) out.annual++;
    if (fin.est.length) out.estimates++;

    if (fin.q?.rev && fin.est.length) {
      const at = new Map(fin.q.p.map((iso, i) => [quarterLabel(iso), i]));
      for (const e of fin.est) {
        if (!e.done || e.rev == null) continue;
        const i = at.get(e.p);
        if (i == null) continue;
        out.checked++;
        // Not "do they agree" but "which shift agrees BEST". Turkish inflation
        // accounting restates prior periods constantly, so a mismatch at the
        // right date is normal and says nothing. A mismatch at the right date
        // that would go away one quarter to the side is the real alarm.
        for (const [slot, off] of [[0, -1], [1, 0], [2, 1]]) {
          const mine = fin.q.rev[i + off];
          if (mine == null) continue;
          if (Math.abs(mine - e.rev) / Math.max(1, Math.abs(e.rev)) < 0.02) out.hits[slot]++;
        }
      }
    }

    await fs.writeFile(path.join(FIN_DIR, `${fin.c}.fin.json`), JSON.stringify(fin) + '\n');
    out.written.add(fin.c);
  }
  return out;
}

/** Delete statement files for codes that have left the exchange. */
async function pruneFundamentals(live) {
  let pruned = 0;
  let files;
  try {
    files = await fs.readdir(FIN_DIR);
  } catch {
    return 0;
  }
  for (const file of files) {
    if (!file.endsWith('.fin.json')) continue;
    if (live.has(file.slice(0, -9))) continue;
    await fs.unlink(path.join(FIN_DIR, file));
    pruned++;
  }
  return pruned;
}

// ---------------------------------------------------------------- the history

const stats = { requests: 0, cacheHits: 0, retries: 0, missing: [], bytes: 0 };
let lastAt = 0;
let gate = Promise.resolve();

/** Serialize the request-rate floor across the workers. */
async function throttle() {
  const prev = gate;
  let release;
  gate = new Promise((r) => (release = r));
  await prev;
  const wait = MIN_INTERVAL_MS - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  release();
}

const cacheFile = (key) => path.join(CACHE, `${key}.json.gz`);

async function readCache(key) {
  if (!USE_CACHE) return null;
  try {
    return JSON.parse((await gunzip(await fs.readFile(cacheFile(key)))).toString('utf8'));
  } catch {
    return null;
  }
}

async function writeCache(key, value) {
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(cacheFile(key), await gzip(Buffer.from(JSON.stringify(value), 'utf8')));
}

/**
 * A share's daily closes, or null when Yahoo does not carry it.
 *
 * A 404 is an answer — some BIST codes are too new or too small for Yahoo to
 * have — so it is recorded and not retried. Only 429 and 5xx are worth another
 * attempt.
 */
async function chart(code) {
  const key = `${code}-${HISTORY_RANGE}-${new Date().toISOString().slice(0, 10)}`;
  const hit = await readCache(key);
  if (hit) {
    stats.cacheHits++;
    return hit;
  }

  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    if (attempt > 0) {
      stats.retries++;
      await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 400);
    }
    await throttle();
    try {
      stats.requests++;
      const url = `${CHART}/${code}.IS?range=${HISTORY_RANGE}&interval=1d&events=div%2Csplit`;
      const res = await fetch(url, { headers: CHART_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) return null;
      const text = await res.text();
      stats.bytes += text.length;
      const rows = parseChart(JSON.parse(text));
      if (rows) await writeCache(key, rows);
      return rows;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('unreachable');
}

/**
 * Yahoo's payload as dated closes.
 *
 * The adjusted close is the series, not the raw one: it is the same number on
 * the last day and the only one that survives a bonus issue. Days when the
 * exchange was open but the share did not trade come back as nulls, and are
 * dropped rather than carried forward.
 */
function parseChart(json) {
  const res = json?.chart?.result?.[0];
  if (!res?.timestamp?.length) return null;
  const zone = res.meta?.exchangeTimezoneName ?? 'Europe/Istanbul';
  const fmt = new Intl.DateTimeFormat('en-CA',
    { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const adj = res.indicators?.adjclose?.[0]?.adjclose;
  const quote = res.indicators?.quote?.[0] ?? {};
  const out = [];
  for (let i = 0; i < res.timestamp.length; i++) {
    const price = adj?.[i] ?? quote.close?.[i];
    if (price == null || !Number.isFinite(price)) continue;
    out.push({
      d: fmt.format(new Date(res.timestamp[i] * 1000)),
      p: Math.round(price * 10000) / 10000,
      v: quote.volume?.[i] == null ? null : Math.round(quote.volume[i]),
    });
  }
  return out.length ? out : null;
}

/** Run `worker` over `items` with a fixed number in flight. */
async function pool(items, worker) {
  const queue = [...items];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(workers);
}

/** History older than the window is dropped, exactly as the fund side does. */
function withinWindow(rows) {
  if (!rows.length) return rows;
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
  return rows.filter((r) => r.d >= cutoff);
}

/** Delete history for codes that have left the exchange. */
async function prune(live) {
  let pruned = 0;
  let files;
  try {
    files = await fs.readdir(HIST_DIR);
  } catch {
    return 0;
  }
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    if (live.has(file.slice(0, -6))) continue;
    await fs.unlink(path.join(HIST_DIR, file));
    pruned++;
  }
  return pruned;
}

async function main() {
  const t0 = Date.now();

  log('Step 1/3 — figures');
  const raw = await scanMarket();
  // Everything the exchange lists, not only the companies. The exchange-traded
  // funds are here because fund filings hold them and a holdings row has to lead
  // somewhere; the share LIST still shows companies alone.
  let rows = raw;
  const kinds = {};
  for (const r of raw) kinds[kindOf(r)] = (kinds[kindOf(r)] ?? 0) + 1;
  log(`  ${raw.length} listings: ` +
    Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', '));
  if (ONLY) rows = rows.filter((r) => ONLY.includes(r.name));
  if (LIMIT) rows = rows.slice(0, LIMIT);

  const stocks = rows.map(shape).sort((a, b) => (b.cap ?? 0) - (a.cap ?? 0));
  log(`  ${stocks.filter((s) => s.p != null).length} priced, ` +
    `${stocks.filter((s) => s.th).length} carry a theme, ` +
    `${stocks.filter((s) => s.pe != null).length} report earnings`);

  log('Step 2/3 — statements');
  await fs.mkdir(FIN_DIR, { recursive: true });
  const fin = await writeFundamentals(rows);
  // Marked in the index so the browser knows before asking. Every listing
  // without statements is an exchange-traded fund or a listing too new to have
  // filed, and without the flag each of their pages opens with a console 404.
  for (const stock of stocks) if (fin.written.has(stock.c)) stock.fin = true;
  log(`  ${fin.written.size} files, ${fin.quarters} with quarterly statements, ` +
    `${fin.annual} with annual, ${fin.estimates} with analyst estimates`);
  if (fin.checked) {
    const [back, on, fwd] = fin.hits;
    log(`  dating check over ${fin.checked} labelled quarters: ` +
      `${on} match on date, ${back} one quarter back, ${fwd} one forward` +
      (on > back * 2 && on > fwd * 2 ? '' : '  ** THE ARRAYS MAY HAVE SHIFTED **'));
  }

  if (FIGURES_ONLY) {
    const carried = await carryHistory(stocks);
    const pruned = await pruneFundamentals(new Set(stocks.map((s) => s.c)));
    await finish(stocks, carried, { appended: 0, files: 0, pruned }, t0);
    return;
  }

  log('Step 3/3 — price history');
  await fs.mkdir(HIST_DIR, { recursive: true });
  let appended = 0;
  let files = 0;
  const latest = new Map();

  await pool(stocks, async (stock) => {
    let bars;
    try {
      bars = await chart(stock.c);
    } catch (e) {
      stats.missing.push(`${stock.c} (${e.message})`);
      return;
    }
    if (!bars) {
      stats.missing.push(stock.c);
      return;
    }
    const window = withinWindow(bars);
    if (!window.length) {
      stats.missing.push(`${stock.c} (no recent trades)`);
      return;
    }
    const file = path.join(HIST_DIR, `${stock.c}.jsonl`);
    // Merged, not overwritten: the fetch window walks forward, and a day Yahoo
    // has stopped returning is still a day that happened.
    const { added, total } = await mergeJsonl(file, window);
    appended += added;
    files++;
    latest.set(stock.c, window.at(-1).d);
    stock.days = total;
  });

  const live = new Set(stocks.map((s) => s.c));
  const pruned = (await prune(live)) + (await pruneFundamentals(live));
  const latestDate = [...latest.values()].sort().at(-1) ?? null;
  await finish(stocks, latestDate, { appended, files, pruned }, t0);
}

/**
 * What the last run knew about price history, for a run that skips fetching it.
 *
 * `--figures-only` refreshes the statements and the figures without spending
 * 648 requests on a year of daily closes that has not moved since this morning.
 * The history files are untouched on disk, so the index must not claim they are
 * gone: the day count and the latest close are carried across.
 */
async function carryHistory(stocks) {
  let files;
  try {
    files = new Set(await fs.readdir(HIST_DIR));
  } catch {
    return null;
  }
  let latest = null;
  // Counted off the history files themselves rather than copied out of the
  // previous index: `--only` writes a truncated index, and a run that trusted
  // it would quietly report that 644 shares had lost their history.
  for (const stock of stocks) {
    if (!files.has(`${stock.c}.jsonl`)) continue;
    const rows = (await fs.readFile(path.join(HIST_DIR, `${stock.c}.jsonl`), 'utf8'))
      .split('\n').filter((l) => l.trim());
    if (!rows.length) continue;
    stock.days = rows.length;
    try {
      const last = JSON.parse(rows.at(-1)).d;
      if (last && (latest == null || last > latest)) latest = last;
    } catch {
      // A half-written trailing line is not a reason to lose the day count.
    }
  }
  return latest;
}

/** Write the index and say what the run did. */
async function finish(stocks, latestDate, { appended, files, pruned }, t0) {
  await fs.writeFile(OUT, JSON.stringify({
    builtAt: new Date().toISOString(),
    source: { figures: 'tradingview', history: 'yahoo' },
    latestDate,
    // Stated in the file rather than left for the reader to assume: the series
    // is a total-return one, and a chart that says "price" without saying so is
    // wrong for every company that has ever paid a dividend.
    priceBasis: 'adjusted',
    count: stocks.length,
    stocks,
  }) + '\n');

  const bytes = (await fs.stat(OUT)).size;
  log(`Wrote data/stocks.json (${(bytes / 1e6).toFixed(2)} MB)` +
    (files ? ` + ${files} history files` : ''));
  log(`  ${appended} new history records appended, latest close ${latestDate}` +
    (pruned ? `, ${pruned} delisted files pruned` : ''));
  if (stats.requests || stats.cacheHits) {
    log(`  Yahoo: ${stats.requests} requests, ${stats.cacheHits} cache hits, ` +
      `${stats.retries} retries, ${(stats.bytes / 1e6).toFixed(1)} MB`);
  }
  if (stats.missing.length) {
    log(`  ${stats.missing.length} shares have no history: ` +
      stats.missing.slice(0, 12).join(', ') + (stats.missing.length > 12 ? ' …' : ''));
  }
  log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('\nSTOCK FETCH FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
