// Fund quality analytics: peer grouping, risk bands, tax, factor models and
// ranking.
//
// DOM-free like core.js, and imported by the same three consumers (browser,
// build script, tests). Everything expensive is run once in the build; the
// browser only re-runs the cheap, preference-dependent parts (tax, scoring)
// because those change whenever the user moves a control.

// ---------------------------------------------------------------- tax
//
// Turkish withholding (stopaj) on fund gains differs by fund type and has been
// amended repeatedly. These are DEFAULTS, exposed as editable preferences and
// labelled in the UI as assumptions — never presented as tax advice. Verify
// current rates before relying on them.

export const TAX_DEFAULTS = {
  /** Equity-intensive funds (>=80% domestic equity) have historically been exempt. */
  equityIntensive: 0,
  /** Money-market and short-term debt funds have carried a reduced rate. */
  moneyMarket: 0.075,
  /** Everything else. */
  standard: 0.1,
};

/** Which default bucket a fund falls into. */
export function taxBucket(fund) {
  if ((fund.g?.equity ?? 0) >= 80) return 'equityIntensive';
  if ((fund.g?.cash ?? 0) >= 75) return 'moneyMarket';
  return 'standard';
}

/**
 * Turn a UI preset into a full rate table.
 * `default` keeps the per-type defaults; any other value is a flat override the
 * user has chosen because they know their own situation better than we do.
 */
export function taxRatesFor(preset) {
  if (preset == null || preset === 'default') return TAX_DEFAULTS;
  const rate = Number(preset);
  if (!Number.isFinite(rate)) return TAX_DEFAULTS;
  return {
    equityIntensive: rate,
    moneyMarket: rate,
    standard: rate,
  };
}

/** Effective withholding rate for a fund, honouring user overrides. */
export function taxRateFor(fund, rates = TAX_DEFAULTS) {
  const bucket = taxBucket(fund);
  return rates[bucket] ?? TAX_DEFAULTS[bucket] ?? 0;
}

/** Apply withholding to a gross percentage return. Losses are not taxed. */
export function afterTax(grossPct, rate) {
  if (grossPct == null) return null;
  if (grossPct <= 0) return grossPct;
  return round2(grossPct * (1 - rate));
}

// ---------------------------------------------------------------- peer groups
//
// TEFAS's umbrella category is too coarse to rank against: a gold fund and a
// leveraged equity fund are both "Serbest Şemsiye Fonu". Peers are derived from
// what a fund actually holds, which is the whole premise of this app.

export const PEER_GROUPS = [
  { id: 'equity', tr: 'Hisse Ağırlıklı', en: 'Equity-heavy' },
  { id: 'metals', tr: 'Kıymetli Maden Ağırlıklı', en: 'Precious-metals-heavy' },
  { id: 'foreign', tr: 'Yabancı Varlık Ağırlıklı', en: 'Foreign-asset-heavy' },
  { id: 'bonds', tr: 'Borçlanma Ağırlıklı', en: 'Fixed-income-heavy' },
  { id: 'cash', tr: 'Nakit / Para Piyasası', en: 'Cash / money market' },
  { id: 'fundOfFunds', tr: 'Fon Sepeti', en: 'Fund of funds' },
  { id: 'balanced', tr: 'Dengeli', en: 'Balanced' },
  { id: 'conservative', tr: 'Temkinli Karma', en: 'Conservative mixed' },
];

export function peerGroupOf(fund) {
  const g = fund.g ?? {};
  const equity = g.equity ?? 0;
  const metals = g.metals ?? 0;
  const cash = g.cash ?? 0;
  const foreign = g.foreign ?? 0;
  const other = g.other ?? 0;
  const bonds = (g.govDebt ?? 0) + (g.corpDebt ?? 0) + (g.lease ?? 0);

  if (metals >= 60) return 'metals';
  if (equity >= 60) return 'equity';
  if (foreign >= 50) return 'foreign';
  if (other >= 60) return 'fundOfFunds';
  if (cash >= 75) return 'cash';
  if (bonds >= 60) return 'bonds';
  if (equity + metals + foreign >= 25) return 'balanced';
  return 'conservative';
}

// ---------------------------------------------------------------- risk & stance

/**
 * TEFAS's risk value tops out at 7, and a 7 additionally means the fund may only
 * be sold to qualified investors ("nitelikli yatırımcı") — a legal restriction,
 * not just a risk description.
 */
export const QUALIFIED_INVESTOR_RISK = 7;

/** Whether buying this fund requires qualified-investor status. */
export const requiresQualifiedInvestor = (fund) => fund?.risk === QUALIFIED_INVESTOR_RISK;

/**
 * Volatility-based risk band, 1–7, using the standard UCITS SRRI boundaries.
 *
 * This is a FALLBACK and a secondary signal. TEFAS publishes an official risk
 * value (`riskDegeri`) which is what `fund.risk` holds; this computed band is
 * stored as `volBand` and only fills in when the official figure is missing.
 * They are not interchangeable — measured on TLY, TEFAS says 7 while realised
 * volatility puts it at 6.
 */
const SRRI_BOUNDS = [0.5, 2, 5, 10, 15, 25];

export function riskBand(vol) {
  if (vol == null || !Number.isFinite(vol)) return null;
  let band = 1;
  for (const bound of SRRI_BOUNDS) if (vol >= bound) band++;
  return band;
}

/**
 * Gross exposure as a multiple of net assets, or null when unknown.
 *
 * A fund's asset-class weights are published against its net asset value and sum
 * to 100, so a fund that borrows reports the borrowing as a NEGATIVE class —
 * almost always cash, where repo sits — and its positive classes then add up to
 * more than 100. Summing the positive side gives the gross exposure: 1.0 is
 * unlevered, 1.5 is 150% invested against 50% borrowed. 101 of 2,062 funds are
 * above 1.0 and 14 are past 2.0, the largest at 10.6.
 *
 * TEFAS's own composition is the source rather than the KAP filings, for two
 * reasons. It covers the whole universe, not the 874 funds whose filing could be
 * read. And a filing lists gross buys and sells rather than a netted position, so
 * summing its positive weights counts a share bought and sold twice — one fund
 * reads as 389% gross that way against 106% here.
 *
 * Derivative leverage is NOT in this figure. A futures position's weight is
 * stated against the portfolio's value rather than its notional, so a fund can
 * run large index exposure through VİOP and still report 1.0. The filings show
 * the cash posted as margin, which is a signal but not a multiple, and inferring
 * one from a margin rate would be guessing.
 */
export function leverageOf(fund) {
  const groups = fund?.g;
  if (!groups || typeof groups !== 'object') return null;
  let gross = 0;
  let any = false;
  for (const weight of Object.values(groups)) {
    if (!Number.isFinite(weight)) continue;
    any = true;
    if (weight > 0) gross += weight;
  }
  return any && gross > 0 ? gross / 100 : null;
}

/** Coarse posture, for the "aggressive vs defensive" filter. */
export function stanceOf(fund) {
  const g = fund.g ?? {};
  const risky = (g.equity ?? 0) + (g.metals ?? 0) + (g.foreign ?? 0);
  const vol = fund.vol ?? 0;
  if (risky >= 60 || vol >= 15) return 'aggressive';
  if (risky <= 15 && vol < 5) return 'defensive';
  return 'balanced';
}

// ---------------------------------------------------------------- crash protection
//
// "What happened to my money the last few times the market fell."
//
// Turkish funds are sold on their return, and a return over a rising year says
// nothing about how a fund behaves on the way down. This measures that directly:
// find the falls in BIST 100, then read what each fund did over exactly those
// dates.

/** A fall this deep, peak to trough, counts as an episode. Percent. */
export const CRASH_FALL = 10;
/**
 * A rise this far off the low ends the fall and starts a new peak. Percent.
 *
 * Without it a single long slide is reported as one episode running from the
 * high to the eventual bottom, hiding the distinct events inside it — BIST's
 * July 2024 high was not reclaimed until August 2025, which swallows the March
 * 2025 crash whole. Five per cent is the smallest rebound that separates the
 * events people actually remember without splitting them into noise.
 */
export const CRASH_REBOUND = 5;
/**
 * How far back episodes are collected, in years.
 *
 * Coverage is what limits this, not data: 1,184 of 2,063 funds have three years
 * of history and only 620 have five, so a longer window would score most funds
 * on the recent episodes anyway while making the figures of the few old funds
 * incomparable with everyone else's.
 */
export const CRASH_YEARS = 3;
/** Fewer episodes than this is an anecdote, not a record. */
export const MIN_CRASH_EPISODES = 2;

/**
 * The market's falls, as an investor experiences them: from a local high to the
 * low that follows it.
 *
 * This is deliberately not the textbook drawdown, which runs from a peak until
 * that peak is regained and so merges separate crashes into one long underwater
 * stretch. Here a fall ends when the index rebounds `rebound` per cent off its
 * low, and the next peak is measured from there.
 *
 * @param {[string, number][]} series ascending [date, level]
 * @returns {{from:string,to:string,fall:number}[]} falls of at least `fall` per
 *   cent, oldest first; `fall` is negative
 */
export function crashEpisodes(series, { fall = CRASH_FALL, rebound = CRASH_REBOUND } = {}) {
  const rows = (series ?? []).filter(([, v]) => Number.isFinite(v) && v > 0);
  if (rows.length < 2) return [];

  const episodes = [];
  let peak = rows[0];
  let trough = null;
  let falling = false;

  const close = () => {
    episodes.push({
      from: peak[0],
      to: trough[0],
      fall: round2((trough[1] / peak[1] - 1) * 100),
    });
  };

  for (const row of rows) {
    const [, v] = row;
    if (!trough || v < trough[1]) trough = row;
    if (falling) {
      // The low is in once the index has bounced far enough off it.
      if ((v / trough[1] - 1) * 100 >= rebound) {
        close();
        falling = false;
        peak = row;
        trough = null;
      }
      continue;
    }
    if (v >= peak[1]) {
      peak = row;
      trough = null;
    } else if ((1 - v / peak[1]) * 100 >= fall) {
      falling = true;
    }
  }
  // A fall still in progress counts: it is the one the reader is living through.
  if (falling) close();
  return episodes;
}

/**
 * The share of one fall a fund's holders were spared, in per cent.
 *
 * 100 means they came through no worse off than if the money had sat in a
 * money-market fund; 0 means they took the index's hit in full; above 100 means
 * the fund made money the market did not; below 0 means it fell further than the
 * index did.
 *
 * BOTH SIDES ARE MEASURED AGAINST CASH, and in Turkey that is not a refinement.
 * These windows run up to two months and deposit rates alone add several per cent
 * over one, so on raw returns a fund holding nothing but repo looks like it
 * defended the portfolio brilliantly, and a fund earning 500% a year looks better
 * still. Taking the money-market return off both sides leaves what the fund did
 * about the fall, which is the question being asked. An episode with no rate
 * recorded falls back to raw returns rather than dropping out.
 *
 * The denominator is safe: an episode is a fall of at least CRASH_FALL per cent
 * and cash is never negative, so it can never approach zero.
 */
export function crashSpared(episode, ret) {
  if (ret == null || !Number.isFinite(ret)) return null;
  const fall = episode?.fall;
  if (!Number.isFinite(fall) || fall >= 0) return null;
  const cash = Number.isFinite(episode?.cash) ? episode.cash : 0;
  return Math.round((1 - (ret - cash) / (fall - cash)) * 100);
}

/**
 * How much of the market's falls a fund's holders were spared, across all of
 * them.
 *
 * `spared` is the MEDIAN of the per-episode figures, not a cumulative one, and
 * the difference matters. Compounding ten windows lets a single extraordinary
 * one carry the score: one fund returned 4,994% across the ten falls together,
 * which divided into the index's loss reads as 6,773 — a number that describes
 * a rally, not a defence. The median says what the fund usually does when the
 * market falls, which is what a reader is asking, and it is unmoved by one
 * spectacular or one disastrous episode.
 *
 * Only the episodes a fund lived through are counted, so a fund launched last
 * year is measured on the falls it was there for and not penalised for the ones
 * it missed. `n` says how many that was, and the UI shows it.
 *
 * Two cautions the UI must carry rather than bury. This rewards not being in the
 * market almost as much as it rewards defending well — a money-market fund
 * scores 100 every time, because it does. And a median says nothing about the
 * worst case: a fund can sit above 100 and still have halved in a single fall,
 * which is why `worst` comes back beside it and is shown with it.
 *
 * @param {{fall:number, cash?:number|null}[]} episodes as returned by crashEpisodes
 * @param {(number|null)[]} returns the fund's return per episode, same order
 */
export function crashProtection(episodes, returns) {
  if (!episodes?.length || !returns?.length) return null;

  const spared = [];
  let worst = null;

  for (let i = 0; i < episodes.length; i++) {
    const s = crashSpared(episodes[i], returns[i]);
    if (s == null) continue;
    spared.push(s);
    if (worst == null || returns[i] < worst) worst = returns[i];
  }
  if (spared.length < MIN_CRASH_EPISODES) return null;

  return {
    n: spared.length,
    of: episodes.length,
    spared: Math.round(median(spared)),
    worst: round2(worst),
  };
}


// ---------------------------------------------------------------- flows

/**
 * Net money in or out, separating flows from performance.
 *
 * Portfolio size grows for two reasons: the assets went up, or people put money
 * in. Subtracting the part explained by the price move leaves the actual flow,
 * which is what "which funds are people buying" really means.
 *
 * @param {{d:string,p:number,sz:number,iv:number}[]} records ascending history
 * @param {number} days lookback window
 */
export function netFlow(records, days) {
  const rows = records.filter((r) => r.p != null && r.sz != null);
  if (rows.length < 2) return null;
  const cutoff = Date.parse(rows[rows.length - 1].d) - days * 86400000;
  const window = rows.filter((r) => Date.parse(r.d) >= cutoff);
  if (window.length < 2) return null;

  let flow = 0;
  for (let i = 1; i < window.length; i++) {
    const a = window[i - 1];
    const b = window[i];
    if (!a.sz || !a.p || !b.p) continue;
    // Size the fund would have had on performance alone:
    flow += b.sz - a.sz * (b.p / a.p);
  }
  return Math.round(flow);
}

/** Change in investor count over the window. */
export function investorChange(records, days) {
  const rows = records.filter((r) => r.iv != null);
  if (rows.length < 2) return null;
  const cutoff = Date.parse(rows[rows.length - 1].d) - days * 86400000;
  const window = rows.filter((r) => Date.parse(r.d) >= cutoff);
  if (window.length < 2) return null;
  return window[window.length - 1].iv - window[0].iv;
}

/**
 * How much of the portfolio is reshuffled between allocation snapshots, as a
 * percentage per snapshot. A proxy for trading activity — TEFAS does not publish
 * turnover, but it does publish the weights, and moving weights means trading.
 */
export function allocationTurnover(allocSnapshots) {
  if (!allocSnapshots || allocSnapshots.length < 3) return null;
  let total = 0;
  let n = 0;
  for (let i = 1; i < allocSnapshots.length; i++) {
    const prev = allocSnapshots[i - 1];
    const cur = allocSnapshots[i];
    const keys = new Set([...Object.keys(prev), ...Object.keys(cur)]);
    let diff = 0;
    for (const k of keys) diff += Math.abs((cur[k] ?? 0) - (prev[k] ?? 0));
    total += diff / 2; // buys and sells are the same trade counted twice
    n++;
  }
  return n ? round2(total / n) : null;
}

// ---------------------------------------------------------------- factor model

/**
 * Ridge-regularised least squares with an intercept.
 *
 * Ridge rather than plain OLS because the factors are correlated by
 * construction — gram gold in lira is partly a dollar bet — and a plain
 * inversion produces wild, unstable coefficients when they move together.
 *
 * `lambda` is RELATIVE to the scale of the predictors, not absolute. Daily
 * returns are ~1e-2, so their cross-products are ~1e-4; an absolute penalty of
 * comparable size would swamp the data and shrink every coefficient to zero.
 *
 * @param {number[]} y response
 * @param {number[][]} X rows of predictors (no intercept column)
 * @param {number} lambda ridge penalty as a fraction of mean predictor energy
 * @returns {{coef:number[], intercept:number, r2:number, se:number, n:number}|null}
 */
export function ridgeFit(y, X, lambda = 1e-3) {
  const n = y.length;
  if (!n || !X.length || X.length !== n) return null;
  const k = X[0].length + 1;
  if (n < k + 10) return null; // not enough observations to say anything

  const A = X.map((row) => [1, ...row]);
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);

  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += A[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += A[i][a] * A[i][b];
    }
  }
  // Penalise slopes only; shrinking the intercept would bias the mean. The
  // penalty is scaled by the mean diagonal of the slope block so it stays
  // proportional to the predictors regardless of their units.
  let diagMean = 0;
  for (let a = 1; a < k; a++) diagMean += XtX[a][a];
  diagMean /= k - 1;
  if (diagMean > 0) for (let a = 1; a < k; a++) XtX[a][a] += lambda * diagMean;

  const beta = solveLinear(XtX, Xty);
  if (!beta) return null;

  const meanY = y.reduce((s, v) => s + v, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    let fit = 0;
    for (let a = 0; a < k; a++) fit += A[i][a] * beta[a];
    ssRes += (y[i] - fit) ** 2;
    ssTot += (y[i] - meanY) ** 2;
  }
  return {
    intercept: beta[0],
    coef: beta.slice(1),
    r2: ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0,
    se: Math.sqrt(ssRes / Math.max(1, n - k)),
    n,
  };
}

/** Gaussian elimination with partial pivoting. Returns null if singular. */
function solveLinear(M, v) {
  const k = v.length;
  const a = M.map((row, i) => [...row, v[i]]);
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= k; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row, i) => row[k] / a[i][i]);
}

/** Factor order used everywhere: keep the build and the UI in step. */
export const FACTORS = ['bist100', 'goldgram', 'usdtry', 'mmf'];

/**
 * Market factors must be read one business day BEFORE the TEFAS date.
 *
 * TEFAS publishes a fund's NAV dated one business day after the market it
 * actually reflects. Measured on a gold fund: its daily return correlates 0.668
 * with gram gold at lag −1 and −0.139 at lag 0. Aligning naively on the date
 * string produces near-zero betas and a model that predicts nothing.
 *
 * `mmf` is exempt: it is derived from TEFAS fund prices, so it already carries
 * TEFAS's own dating and matches at lag 0 (correlation 0.998 on a money-market
 * fund).
 */
export const LAGGED_FACTORS = new Set(['bist100', 'goldgram', 'usdtry']);

/**
 * Build a lookup for a factor's daily returns.
 *
 * @param {Map<string, number>} returns date -> return
 * @param {boolean} lag read the most recent value strictly BEFORE the requested
 *   date (skipping weekends and holidays) rather than the value on it
 * @returns {(date: string) => number|null}
 */
export function factorReader(returns, lag = false) {
  if (!lag) return (date) => returns.get(date) ?? null;

  const entries = [...returns.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const dates = entries.map((e) => e[0]);
  return (date) => {
    let lo = 0;
    let hi = dates.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] < date) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found >= 0 ? entries[found][1] : null;
  };
}

/**
 * Compound the factor moves a fund has not yet priced in.
 *
 * The fund's newest NAV is dated `fundLastDate`, which reflects the market up to
 * the previous market date. Everything after that is already known publicly but
 * not yet in the fund's published price — and that gap is exactly what the
 * prediction estimates. No live market data is required.
 *
 * @param {object[]} benchRows benchmarks.jsonl parsed, ascending by date
 * @param {string} fundLastDate the fund's latest published date
 * @returns {{returns: Record<string, number>, from: string, to: string}|null}
 */
export function pendingFactorReturns(benchRows, fundLastDate) {
  const out = {};
  let from = null;
  let to = null;

  for (const factor of FACTORS) {
    const series = benchRows.filter((b) => b[factor] != null).map((b) => [b.d, b[factor]]);
    if (series.length < 2) return null;

    // Find the last observation the fund's newest NAV already reflects: the
    // previous market day for lagged factors, the same day for the cash index.
    const isLagged = LAGGED_FACTORS.has(factor);
    let baseIndex = -1;
    for (let i = 0; i < series.length; i++) {
      const date = series[i][0];
      const alreadyReflected = isLagged ? date < fundLastDate : date <= fundLastDate;
      if (!alreadyReflected) break;
      baseIndex = i;
    }
    if (baseIndex < 0 || baseIndex >= series.length - 1) {
      out[factor] = 0;
      continue;
    }
    const base = series[baseIndex][1];
    const latest = series[series.length - 1][1];
    if (!base || base <= 0) return null;

    out[factor] = latest / base - 1;
    if (LAGGED_FACTORS.has(factor)) {
      from = from ?? series[baseIndex][0];
      to = series[series.length - 1][0];
    }
  }
  if (!to || from === to) return null;
  return { returns: out, from, to };
}

/**
 * Estimate a fund's return from benchmark moves it has not yet reported against.
 *
 * TEFAS publishes NAV a day late, so the benchmarks for the missing day are
 * already known. That gap is the prediction — no live market data required.
 *
 * @param {{intercept:number,coef:number[],r2:number,se:number}} model
 * @param {Record<string, number>} factorReturns decimal returns per factor
 * @returns {{estimate:number, low:number, high:number, r2:number}|null} percentages
 */
export function predictReturn(model, factorReturns) {
  if (!model?.coef) return null;
  let sum = model.intercept;
  for (let i = 0; i < FACTORS.length; i++) {
    const r = factorReturns[FACTORS[i]];
    if (r == null || !Number.isFinite(r)) return null;
    sum += model.coef[i] * r;
  }
  const estimate = sum * 100;
  const band = model.se * 100;
  return {
    estimate: round2(estimate),
    low: round2(estimate - band),
    high: round2(estimate + band),
    r2: model.r2,
  };
}

/** Daily simple returns from an ascending [date, value] series, keyed by date. */
export function dailyReturns(series) {
  const out = new Map();
  for (let i = 1; i < series.length; i++) {
    const [, prev] = series[i - 1];
    const [date, cur] = series[i];
    if (!prev || !cur || prev <= 0) continue;
    out.set(date, cur / prev - 1);
  }
  return out;
}

// ---------------------------------------------------------------- themes & dividends
//
// Both answers come out of one pass over a fund's individual positions: the lines
// of business it is in, and what those holdings pay in dividends. Neither is
// derivable from TEFAS, which publishes asset-CLASS weights and no distribution
// field at all, so both exist only for the funds whose KAP filing could be read.

/** A theme below this share of the fund is a rounding artefact, not an exposure. */
export const MIN_THEME_WEIGHT = 0.5;

/**
 * What a fund is actually invested in, by line of business, and what it collects
 * in dividends.
 *
 * `resolve` is passed in rather than imported so this stays arithmetic — the
 * build wires it to the listing data, the tests wire it to a literal. It answers
 * for one position with one of three things, and the difference between the last
 * two is what makes `covered` mean anything:
 *
 *   undefined      not a listed security — a bond, repo, a deposit
 *   null           a listed security nothing is known about
 *   [theme, yield] a listed security, either of which may still be null
 *
 * Weights are shares of the FUND, not of its equity sleeve, so they read against
 * the composition bar and against each other. A levered fund's themes can add up
 * past 100, which is correct: it holds more equity than it owns.
 *
 * `dividend` is the income side of the same positions — each holding's trailing
 * yield times what the fund has in it. It is what the portfolio earned in
 * dividends over the last year as a share of the fund, and it is NOT money paid
 * out to the holder: Turkish funds accumulate, so it lands in the unit price.
 * Pooled holdings carry a yield but no theme, which is why the two are counted
 * separately rather than one implying the other.
 *
 * @param {object[]} positions aggregated holdings, one row per security
 * @param {(p:object)=>[string|null, number|null]|null|undefined} resolve
 */
export function themeExposure(positions, resolve) {
  const themes = {};
  let equity = 0;
  let covered = 0;
  let dividend = 0;

  for (const position of positions ?? []) {
    const weight = position?.weight;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const hit = resolve(position);
    if (hit === undefined) continue;
    equity += weight;
    if (hit === null) continue;

    covered += weight;
    const [theme, yieldPct] = hit;
    if (theme) themes[theme] = (themes[theme] ?? 0) + weight;
    if (Number.isFinite(yieldPct) && yieldPct > 0) dividend += (weight / 100) * yieldPct;
  }
  if (!equity) return null;

  const kept = {};
  for (const [id, weight] of Object.entries(themes)) {
    if (weight >= MIN_THEME_WEIGHT) kept[id] = round2(weight);
  }
  return {
    themes: kept,
    dividend: round2(dividend),
    equity: round2(equity),
    covered: round2(covered),
  };
}


// ---------------------------------------------------------------- who owns a share
//
// The other direction through the filings. Every other page here asks "what does
// this fund hold"; this asks "who holds this share, and are they buying it".
//
// It is the one question about a Turkish share that this project can answer and
// a share page cannot: it needs all 882 filings at once, which nobody assembles
// for a single company.

/** How many holders a share page lists before the tail stops being informative. */
export const TOP_HOLDERS = 12;

/**
 * The largest move one position can make. A weight is a share of a portfolio, so
 * it cannot travel more than the whole portfolio; anything past that is a filing
 * error, not a trade. One fund really did file last month's ASELS weight as
 * 2,070,000%, and unguarded it moved the whole exchange's estimated flow by
 * ₺1.3 trillion.
 */
export const MAX_WEIGHT_MOVE = 100;

/**
 * A holding of one share by one fund, as the ownership pass sees it.
 *
 * @typedef {object} Holder
 * @property {string} fund      fund code
 * @property {number} value     lira held, from the filing
 * @property {number} [shares]  share count held, from the filing's nominal
 * @property {number} [weight]  share of the fund, per cent
 * @property {number|null} [prev] the same weight in the previous filing, or null
 *   when the filing does not carry a comparable one — which is NOT the same as
 *   zero, and is why `compared` exists
 */

/**
 * Who owns a share, how much of it, and which way they moved last month.
 *
 * Two measures of "how much of the company", because the two inputs come from
 * different places and either can be wrong on its own: `pctShares` divides share
 * counts from the KAP filings by the count on the exchange's own listing, and
 * `pctCap` divides lira by market value. They agree within a few per cent on the
 * large names, so the page shows the share-count one with the other beside it
 * rather than picking a winner silently.
 *
 * The movement half is measured over `compared` holders only — the ones whose
 * filing carried a usable previous weight, about three quarters of them. A blank
 * previous weight is a filer leaving a column empty, not a position opened this
 * month, and counting it as the latter would have every share on the exchange
 * being bought by everybody.
 *
 * The movement is reported as a COUNT and never as a sum of lira. Pricing each
 * weight change at the fund's current size is arithmetic anyone can do and it
 * produced nonsense: one fund's previous ASELS weight of 22.69% against today's
 * 0.14% valued the sale at ₺63bn, more than the company. A weight from a filing
 * a month old cannot be multiplied by a portfolio value from today. How many
 * funds went each way is robust to exactly the errors that break the product,
 * and the per-fund moves in `top` put the size where it can be checked.
 *
 * @param {Holder[]} holders
 * @param {{shares?: number|null, cap?: number|null}} listing exchange figures
 */
export function ownership(holders, { shares = null, cap = null } = {}) {
  const rows = (holders ?? []).filter((h) => Number.isFinite(h?.value));
  if (!rows.length) return null;

  const moveOf = (h) => {
    if (!Number.isFinite(h.weight) || !Number.isFinite(h.prev)) return null;
    const move = h.weight - h.prev;
    return Math.abs(move) > MAX_WEIGHT_MOVE ? null : move;
  };

  let value = 0;
  let held = 0;
  let compared = 0;
  let adding = 0;
  let trimming = 0;

  for (const h of rows) {
    value += h.value;
    if (Number.isFinite(h.shares)) held += h.shares;
    const move = moveOf(h);
    if (move == null) continue;
    compared++;
    if (move > 0) adding++;
    else if (move < 0) trimming++;
  }

  const top = rows
    .filter((h) => h.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, TOP_HOLDERS)
    .map((h) => ({
      c: h.fund,
      v: Math.round(h.value),
      w: Number.isFinite(h.weight) ? round2(h.weight) : null,
      m: moveOf(h) == null ? null : round2(moveOf(h)),
    }));

  return {
    funds: rows.length,
    value: Math.round(value),
    shares: held || null,
    pctShares: shares > 0 && held ? round2((held / shares) * 100) : null,
    pctCap: cap > 0 ? round2((value / cap) * 100) : null,
    compared,
    adding,
    trimming,
    top,
  };
}

/**
 * Where a price sits in its own 52-week range, 0 at the low and 100 at the high.
 *
 * Null when the range is degenerate rather than 50: a share that has traded at
 * one price all year is not "in the middle" of anything.
 */
export function rangePosition(price, low, high) {
  if (![price, low, high].every(Number.isFinite)) return null;
  if (!(high > low)) return null;
  return round2(Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100)));
}

// ---------------------------------------------------------------- scoring

/**
 * @typedef {object} Prefs
 * @property {number} [maxRisk]      highest acceptable risk band, 1–7
 * @property {number} [minSize]      minimum portfolio size in TRY
 * @property {boolean} [requireHistory] drop funds without a full year
 * @property {object} [taxRates]     overrides for TAX_DEFAULTS
 * @property {string} [horizon]      one of core.js HORIZONS keys
 * @property {Record<string, number>} [cashReturns] money-market return per horizon
 * @property {number} [cashReturn]   the 1-year figure, kept for the hurdle note
 */

/**
 * The money-market return over the SAME window as the fund's return.
 *
 * Mixing windows is the easy mistake here: subtracting a one-year cash return
 * from a three-month fund return makes every fund look catastrophic. Rather than
 * silently fall back to the wrong window, this returns null and callers withhold
 * the comparison.
 */
export function cashReturnFor(ctx, horizon = 'y1') {
  const perHorizon = ctx?.cashReturns?.[horizon];
  if (perHorizon != null && Number.isFinite(perHorizon)) return perHorizon;
  // `cashReturn` is the one-year figure by definition, so it may only answer for
  // the one-year horizon.
  if (horizon === 'y1' && Number.isFinite(ctx?.cashReturn)) return ctx.cashReturn;
  return null;
}

/**
 * Rank funds on after-tax excess return per unit of risk.
 *
 * Deliberately NOT a blended score with invented weights — that would look
 * authoritative and mean nothing. This is one defensible number (how much
 * better than cash, per unit of volatility, after tax) plus explicit flags the
 * user can read and disagree with.
 *
 * `excess` is in percentage POINTS, not per cent — it is the gap between two
 * returns. The UI labels it accordingly.
 */
export function scoreFund(fund, ctx) {
  const { taxRates = TAX_DEFAULTS, horizon = 'y1' } = ctx ?? {};
  const gross = fund.r?.[horizon];
  if (gross == null || fund.vol == null) return null;

  const cashGross = cashReturnFor(ctx, horizon);
  if (cashGross == null) return null;

  const rate = taxRateFor(fund, taxRates);
  const net = afterTax(gross, rate);
  // The hurdle is taxed too: compare net to net, or cash looks worse than it is.
  const cashNet = afterTax(cashGross, taxRates.moneyMarket ?? TAX_DEFAULTS.moneyMarket);
  const excess = net - cashNet;
  // Volatility floor: a fund with 0.1% volatility would otherwise show an
  // enormous ratio from a rounding-level excess.
  const risk = Math.max(fund.vol, 0.5);
  return {
    net,
    cashNet: round2(cashNet),
    excess: round2(excess),
    ratio: round2(excess / risk),
    taxRate: rate,
    horizon,
  };
}

/**
 * Readable, checkable signals rather than one opaque number.
 * `good: false` marks a caution, not a failure.
 */
export function qualityFlags(fund, ctx) {
  const { cashReturn = 0, peerMedian = null, taxRates = TAX_DEFAULTS, horizon = 'y1' } = ctx ?? {};
  const flags = [];
  const scored = scoreFund(fund, ctx);

  if (scored) {
    flags.push({
      id: 'beatsCash',
      good: scored.excess > 0,
      value: scored.excess,
    });
  }
  if (peerMedian != null && fund.r?.[horizon] != null) {
    flags.push({
      id: 'beatsPeers',
      good: fund.r[horizon] > peerMedian,
      value: round2(fund.r[horizon] - peerMedian),
    });
  }
  if (fund.mdd != null) {
    flags.push({ id: 'drawdown', good: fund.mdd > -20, value: fund.mdd });
  }
  if (fund.r?.y1 == null) {
    flags.push({ id: 'shortHistory', good: false, value: null });
  }
  if ((fund.sz ?? 0) < 100_000_000) {
    flags.push({ id: 'smallFund', good: false, value: fund.sz });
  }
  return flags;
}

/** Median of a numeric array, ignoring nullish entries. */
export function median(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const round2 = (n) => (n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100);

// ---------------------------------------------------------------- statements
//
// Everything below reads a company's own numbers rather than a fund's. The
// scanner hands back eight years of quarters and twenty years of years as bare
// arrays, newest-first, with no dates on them at all — so the first job is
// putting a date on each one, and the second is refusing to state anything the
// arrays cannot actually support.

/**
 * The end date of each period in a newest-first quarterly array.
 *
 * The anchor is the end date of the LAST REPORTED quarter, walked back three
 * months at a time. It has to be that rather than today's calendar quarter for
 * two reasons: a company reports months after its books close, and a good few
 * Borsa İstanbul companies do not close them in March, June, September and
 * December at all — Beşiktaş ends its year in May.
 *
 * Month-end is preserved rather than the day number: three months back from
 * 31 May is 28 February, and a naive subtraction lands on 3 March.
 */
export function periodEnds(anchorIso, count) {
  if (!anchorIso || !Number.isFinite(count) || count < 1) return [];
  const [y, m, d] = String(anchorIso).slice(0, 10).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return [];
  // Whether the anchor sits on its own month's last day; if it does, every
  // earlier period should too, however many days that month happens to have.
  const anchorLast = new Date(Date.UTC(y, m, 0)).getUTCDate() === d;
  const out = [];
  for (let k = 0; k < count; k++) {
    const months = y * 12 + (m - 1) - k * 3;
    const yy = Math.floor(months / 12);
    const mm = months - yy * 12;
    const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
    const day = anchorLast ? last : Math.min(d, last);
    out.push(`${String(yy).padStart(4, '0')}-${pad2(mm + 1)}-${pad2(day)}`);
  }
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** "2026-Q2" for a period-end date, the label the estimate feed uses. */
export const quarterLabel = (iso) =>
  `${String(iso).slice(0, 4)}-Q${Math.ceil(Number(String(iso).slice(5, 7)) / 3)}`;

/**
 * A rolling twelve months from four quarters, oldest-first.
 *
 * Quarterly figures for a seasonal business swing so hard that the shape of the
 * bars says more about the calendar than about the company — a car maker's
 * fourth quarter is always its biggest. Summing four of them removes the season
 * and leaves the trend. The first three entries have no four quarters behind
 * them and are null, not partial sums.
 */
export function trailingTwelve(values) {
  const v = values ?? [];
  return v.map((_, i) => {
    if (i < 3) return null;
    const window = v.slice(i - 3, i + 1);
    return window.some((x) => x == null || !Number.isFinite(x))
      ? null
      : window.reduce((a, b) => a + b, 0);
  });
}

/**
 * Change against the same period a year earlier, in percent.
 *
 * A year back is four quarters or one year depending on the series, which is
 * what `step` says. Year-on-year rather than against the previous period for
 * the same seasonality reason, and undefined where the base is zero or negative
 * — "profit grew 400%" out of a loss is not a growth rate, it is a sign change.
 */
export function yearOnYear(values, step = 4) {
  const v = values ?? [];
  return v.map((cur, i) => {
    const prev = v[i - step];
    if (i < step || cur == null || prev == null) return null;
    if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null;
    return round2((cur / prev - 1) * 100);
  });
}

/** One series as a percentage of another, period by period — a margin. */
export function ratioSeries(top, bottom) {
  const a = top ?? [];
  const b = bottom ?? [];
  return a.map((n, i) => {
    const d = b[i];
    if (n == null || d == null || !Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
    return round2((n / d) * 100);
  });
}

/**
 * How many years of borrowings the company's own cash flow could repay.
 *
 * The most-quoted solvency number on a Turkish company, and one that has to
 * keep its sign: negative net debt means net cash, and the ratio then says
 * something good rather than something negative. Meaningless without positive
 * EBITDA, so a loss-maker gets null rather than a large number.
 */
export function netDebtToEbitda(netDebt, ebitda) {
  if (netDebt == null || ebitda == null) return null;
  if (!Number.isFinite(netDebt) || !Number.isFinite(ebitda) || ebitda <= 0) return null;
  return round2(netDebt / ebitda);
}

/** Altman Z bands for a manufacturer: distress, grey, safe. */
export function altmanBand(z) {
  if (z == null || !Number.isFinite(z)) return null;
  return z >= 2.99 ? 'safe' : z >= 1.81 ? 'grey' : 'distress';
}

/** Piotroski F bands out of nine: weak, middling, strong. */
export function piotroskiBand(f) {
  if (f == null || !Number.isFinite(f)) return null;
  return f >= 7 ? 'safe' : f >= 4 ? 'grey' : 'distress';
}

/**
 * What the analysts covering the share think, or null when nobody does.
 *
 * The count comes first because it is what qualifies the rest: a "target" that
 * is one broker's opinion and a target that is the middle of eleven are not the
 * same object, and only the second is worth drawing a range bar for.
 */
export function consensus(stock, price = null) {
  const n = stock?.recN ?? 0;
  if (!n) return null;
  const at = price ?? stock.p ?? null;
  const upside = at != null && stock.tgt != null && at > 0
    ? round2((stock.tgt / at - 1) * 100)
    : null;
  return {
    n,
    buy: stock.recBuy ?? 0,
    hold: stock.recHold ?? 0,
    sell: stock.recSell ?? 0,
    target: stock.tgt ?? null,
    high: stock.tgtHi ?? null,
    low: stock.tgtLo ?? null,
    upside,
  };
}

/** A part of a total, in percent, for the buy/hold/sell bar. */
export const shareOfTotal = (part, total) =>
  total > 0 ? round2((part / total) * 100) : 0;

/**
 * How often the company came in ahead of what analysts expected.
 *
 * Only reported quarters carrying BOTH an actual and an estimate count: a
 * quarter nobody forecast is not a beat, and counting it as one would flatter
 * every company too small for anyone to cover.
 */
export function beatRecord(rows, key = 'eps') {
  const usable = (rows ?? []).filter((r) =>
    r?.done && r[key] != null && r[`${key}E`] != null && Number.isFinite(r[`${key}E`]));
  if (!usable.length) return null;
  const beats = usable.filter((r) => r[key] > r[`${key}E`]).length;
  return { of: usable.length, beats, pct: round2((beats / usable.length) * 100) };
}

/** A surprise as a percentage of the estimate, sign preserved. */
export function surpriseOf(actual, estimate) {
  if (actual == null || estimate == null) return null;
  if (!Number.isFinite(actual) || !Number.isFinite(estimate) || estimate === 0) return null;
  return round2(((actual - estimate) / Math.abs(estimate)) * 100);
}

/** How many peers to put in the comparison table. */
export const PEER_COUNT = 8;

/**
 * The companies a share is actually comparable to, largest first.
 *
 * Same industry rather than same sector: "Finance" holds both a bank and a
 * property trust, and their multiples have nothing to say to each other. Only
 * companies — an exchange-traded fund tracking a sector is not a peer of the
 * shares inside it — and only ones the exchange still sizes.
 */
export function peersOf(stock, all, limit = PEER_COUNT) {
  if (!stock?.ind) return [];
  return (all ?? [])
    .filter((s) => s.kind === 'stock' && s.ind === stock.ind && s.c !== stock.c && s.cap != null)
    .sort((a, b) => (b.cap ?? 0) - (a.cap ?? 0))
    .slice(0, limit);
}

/** The middle of a group of peers on each metric, for the "vs industry" row. */
export function peerMedians(peers, keys) {
  const out = {};
  for (const key of keys) out[key] = median((peers ?? []).map((s) => s[key]));
  return out;
}

// ---------------------------------------------------------------- the dashboard
//
// Four questions a home page can answer that a fund page structurally cannot,
// because each of them needs more than one fund at a time.

/**
 * How much two portfolios are the same portfolio, in percentage points.
 *
 * The overlap of two weightings is the sum of the SMALLER weight wherever both
 * hold the same thing. Two funds each 40% in ASELS overlap 40 points there; one
 * at 40% and one at 5% overlap 5. That is the amount of the pair that is not a
 * second position at all, and it runs 0 to 100 the way a reader expects.
 *
 * Not correlation, which two funds holding entirely different banks would score
 * high on and which says nothing about whether you own the same shares twice.
 */
export function overlapOf(a, b) {
  if (!a || !b) return null;
  let shared = 0;
  for (const [code, weight] of Object.entries(a)) {
    const other = b[code];
    if (other == null) continue;
    shared += Math.min(weight, other);
  }
  return round2(shared);
}

/**
 * A filing as a weight per position, summed across split lines.
 *
 * The same holding is filed under an ISIN on one line and a ticker on the next,
 * so weights are added rather than replaced — the same rule the ownership pass
 * follows. Rows with no code cannot be matched against another fund's and are
 * left out, which makes the overlap a floor rather than an estimate.
 */
export function weightsOf(holdings) {
  const out = {};
  for (const h of holdings ?? []) {
    const code = h?.code;
    const weight = h?.weight;
    if (!code || weight == null || !Number.isFinite(weight) || weight <= 0) continue;
    out[code] = (out[code] ?? 0) + weight;
  }
  return out;
}

/** Below this an overlap is a coincidence of two big funds owning big companies. */
export const OVERLAP_FLOOR = 25;

/**
 * Every pair among the given filings that shares more than the floor, worst first.
 *
 * Most pairs share nothing at all — across the equity funds that file, the
 * median pair overlaps 0% — so this is silent unless there is something to say,
 * which is the only way a warning belongs on a page you open every morning.
 */
export function overlappingPairs(filings, floor = OVERLAP_FLOOR) {
  const codes = Object.keys(filings ?? {}).filter((c) => filings[c]);
  const pairs = [];
  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) {
      const shared = overlapOf(filings[codes[i]], filings[codes[j]]);
      if (shared != null && shared >= floor) pairs.push({ a: codes[i], b: codes[j], shared });
    }
  }
  return pairs.sort((x, y) => y.shared - x.shared);
}

/**
 * The positions two funds hold in common, largest first.
 *
 * The pair figure says how much is duplicated; this says what. Reported at the
 * smaller of the two weights, for the same reason the total is.
 */
export function sharedPositions(a, b, limit = 6) {
  const rows = [];
  for (const [code, weight] of Object.entries(a ?? {})) {
    const other = b?.[code];
    if (other == null) continue;
    rows.push({ code, weight: round2(Math.min(weight, other)), a: weight, b: other });
  }
  return rows.sort((x, y) => y.weight - x.weight).slice(0, limit);
}

/**
 * What a group of tickers did today, weighted.
 *
 * Weighted rather than averaged: a theme is what the money in it did, and an
 * equal-weighted "banks" figure lets the smallest listed bank move the number as
 * far as the largest. Weights are renormalised over the members that actually
 * have a quote, so a theme is not dragged toward zero by a suspended share.
 */
export function weightedMove(members, quotes) {
  if (!members?.length || !quotes) return null;
  let move = 0;
  let covered = 0;
  let priced = 0;
  for (const [code, weight] of members) {
    const change = quotes[code]?.change;
    if (change == null || !Number.isFinite(change)) continue;
    move += change * weight;
    covered += weight;
    priced++;
  }
  if (!priced || covered <= 0) return null;
  return { move: round2(move / covered), priced, of: members.length, covered: round2(covered * 100) };
}

/** Below this share of a theme priced, the figure is not the theme's move. */
export const MIN_THEME_COVERAGE = 50;

/**
 * Today's move for every theme, biggest absolute move first.
 *
 * Sorted by size of move rather than by name, because the question is "what kind
 * of day was it" and the answer is at the two ends of that list.
 */
export function themeMoves(themeWeights, quotes, minCoverage = MIN_THEME_COVERAGE) {
  const out = [];
  for (const [id, members] of Object.entries(themeWeights ?? {})) {
    const result = weightedMove(members, quotes);
    if (!result || result.covered < minCoverage) continue;
    out.push({ id, ...result });
  }
  return out.sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
}

/**
 * The best and worst of a named universe today.
 *
 * The universe is the argument and it is the whole point: the biggest movers on
 * the whole exchange are always its smallest listings, hitting their price limit
 * on a handful of trades. The index members are companies with a float.
 */
export function moversIn(codes, quotes, count = 5) {
  const rows = (codes ?? [])
    .map((code) => ({ code, change: quotes?.[code]?.change, price: quotes?.[code]?.price }))
    .filter((r) => r.change != null && Number.isFinite(r.change));
  if (!rows.length) return null;
  const byMove = [...rows].sort((a, b) => b.change - a.change);
  return {
    up: byMove.slice(0, count).filter((r) => r.change > 0),
    down: byMove.slice(-count).reverse().filter((r) => r.change < 0),
    of: rows.length,
  };
}

/**
 * What a set of funds returned over one horizon, against holding cash instead.
 *
 * The median, not the mean: one fund up 600% would otherwise report a portfolio
 * that beat the money market when five of its six holdings did not. The gap is
 * in POINTS, because it is the difference between two percentages.
 */
export function versusCash(funds, horizon, cashReturns) {
  const values = (funds ?? [])
    .map((f) => f?.r?.[horizon])
    .filter((v) => v != null && Number.isFinite(v));
  if (!values.length) return null;
  const cash = cashReturns?.[horizon];
  const mid = median(values);
  return {
    median: round2(mid),
    cash: cash ?? null,
    gap: cash == null ? null : round2(mid - cash),
    beating: cash == null ? null : values.filter((v) => v > cash).length,
    of: values.length,
  };
}
