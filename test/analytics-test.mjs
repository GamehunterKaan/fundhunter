import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TAX_DEFAULTS, PEER_GROUPS, FACTORS, LAGGED_FACTORS,
  taxBucket, taxRateFor, afterTax, peerGroupOf, riskBand, stanceOf, leverageOf,
  netFlow, investorChange, allocationTurnover,
  ridgeFit, predictReturn, dailyReturns, factorReader, pendingFactorReturns,
  scoreFund, qualityFlags, median, cashReturnFor,
  QUALIFIED_INVESTOR_RISK, requiresQualifiedInvestor,
  crashEpisodes, crashSpared, crashProtection,
  themeExposure, MIN_THEME_WEIGHT,
  ownership, rangePosition, TOP_HOLDERS, MAX_WEIGHT_MOVE,
  periodEnds, quarterLabel, trailingTwelve, yearOnYear, ratioSeries,
  netDebtToEbitda, altmanBand, piotroskiBand, consensus, shareOfTotal,
  beatRecord, surpriseOf, peersOf, peerMedians,
  overlapOf, weightsOf, overlappingPairs, sharedPositions,
  weightedMove, themeMoves, moversIn, versusCash,
  boardFlags, boardSummary, speculativeExposure, MIN_BOARD_FLAGS, SPECULATIVE_HEAVY,
} from '../analytics.js';
import { HORIZONS } from '../core.js';

const fund = (over = {}) => ({
  c: 'AAA', n: 'TEST FONU', k: 'YAT', cat: null, f: 'TEST PORTFÖY',
  d: '2026-08-14', p: 1, sz: 5e9, iv: 1000,
  g: { cash: 100 }, r: {}, vol: 2, mdd: -1, ...over,
});

// ---------------------------------------------------------------- tax

test('tax buckets follow fund type and composition', () => {
  assert.equal(taxBucket(fund({ g: { equity: 85, cash: 15 } })), 'equityIntensive');
  assert.equal(taxBucket(fund({ g: { cash: 90, govDebt: 10 } })), 'moneyMarket');
  assert.equal(taxBucket(fund({ g: { govDebt: 60, cash: 40 } })), 'standard');
});

test('afterTax leaves losses alone', () => {
  assert.equal(afterTax(100, 0.1), 90);
  assert.equal(afterTax(-20, 0.1), -20, 'a loss is not taxed');
  assert.equal(afterTax(0, 0.1), 0);
  assert.equal(afterTax(null, 0.1), null);
});

test('taxRateFor honours user overrides', () => {
  const f = fund({ g: { govDebt: 100 } });
  assert.equal(taxRateFor(f), TAX_DEFAULTS.standard);
  assert.equal(taxRateFor(f, { ...TAX_DEFAULTS, standard: 0.25 }), 0.25);
});

// ---------------------------------------------------------------- classification

test('peer groups come from holdings, not the TEFAS label', () => {
  // Both of these are "Serbest Şemsiye Fonu" at TEFAS; they are not peers.
  assert.equal(peerGroupOf(fund({ g: { metals: 84, other: 12, equity: 2, cash: 2 } })), 'metals');
  assert.equal(peerGroupOf(fund({ g: { equity: 80, cash: 14, other: 6 } })), 'equity');
  assert.equal(peerGroupOf(fund({ g: { cash: 85, govDebt: 12, corpDebt: 3 } })), 'cash');
  assert.equal(peerGroupOf(fund({ g: { govDebt: 40, corpDebt: 25, cash: 35 } })), 'bonds');
  assert.equal(peerGroupOf(fund({ g: { other: 70, cash: 30 } })), 'fundOfFunds');
  assert.equal(peerGroupOf(fund({ g: { equity: 35, cash: 40, govDebt: 25 } })), 'balanced');
  assert.equal(peerGroupOf(fund({ g: { cash: 55, govDebt: 40, equity: 5 } })), 'conservative');
});

test('every peer group id is declared in PEER_GROUPS', () => {
  const ids = new Set(PEER_GROUPS.map((g) => g.id));
  const mixes = [
    { metals: 90 }, { equity: 90 }, { foreign: 60 }, { other: 80 },
    { cash: 90 }, { govDebt: 80 }, { equity: 30, cash: 70 }, { cash: 60, govDebt: 40 },
  ];
  for (const g of mixes) assert.ok(ids.has(peerGroupOf(fund({ g }))), JSON.stringify(g));
});

test('risk value 7 means qualified investors only', () => {
  // TEFAS's official risk value carries a legal restriction at 7, so this must
  // read the official field and never a value derived from volatility.
  assert.equal(requiresQualifiedInvestor(fund({ risk: 7 })), true);
  assert.equal(requiresQualifiedInvestor(fund({ risk: 6 })), false);
  assert.equal(requiresQualifiedInvestor(fund({ risk: null })), false);
  assert.equal(requiresQualifiedInvestor(fund({ vol: 90 })), false, 'high volatility alone is not a restriction');
  assert.equal(QUALIFIED_INVESTOR_RISK, 7);
});

test('the computed volatility band is not the official risk value', () => {
  // Measured on TLY: TEFAS publishes 7, realised volatility puts it at 6. The
  // two must stay distinguishable or the filter would be quietly wrong.
  assert.equal(riskBand(24.34), 6);
  assert.notEqual(riskBand(24.34), 7);
});

test('risk bands follow the SRRI boundaries', () => {
  assert.equal(riskBand(0.3), 1);
  assert.equal(riskBand(1.5), 2);
  assert.equal(riskBand(4), 3);
  assert.equal(riskBand(12), 5);
  assert.equal(riskBand(30), 7);
  assert.equal(riskBand(null), null);
});

test('leverage is read from the negative side of the composition', () => {
  // Weights are published against net asset value and sum to 100, so borrowing
  // shows up as a negative class and the positive ones then pass 100.
  assert.equal(leverageOf(fund({ g: { equity: 150, cash: -50 } })), 1.5);
  assert.equal(leverageOf(fund({ g: { equity: 190.78, cash: -97.11, other: 6.33 } })), 1.9711);
  // The real extremes in the universe: a fund at 10.6× and one at 1.0.
  assert.equal(leverageOf(fund({ g: { corpDebt: 1063.7, cash: -963.7 } })), 10.637);
  assert.equal(leverageOf(fund({ g: { equity: 60, govDebt: 40 } })), 1);

  // An absent or empty composition is unknown, not unlevered — the filter must
  // be able to tell those apart.
  assert.equal(leverageOf(fund({ g: {} })), null);
  assert.equal(leverageOf(fund({ g: null })), null);
  assert.equal(leverageOf({}), null);
  assert.equal(leverageOf(null), null);
  // A fund that holds only cash is unlevered, which is a 1 and not an unknown.
  assert.equal(leverageOf(fund({})), 1);
  // A stray non-number does not silently become zero and drag the total down.
  assert.equal(leverageOf(fund({ g: { equity: 120, cash: null } })), 1.2);
});

test('stance separates aggressive from defensive', () => {
  assert.equal(stanceOf(fund({ g: { equity: 80 }, vol: 25 })), 'aggressive');
  assert.equal(stanceOf(fund({ g: { cash: 100 }, vol: 1.2 })), 'defensive');
  assert.equal(stanceOf(fund({ g: { equity: 30, cash: 70 }, vol: 8 })), 'balanced');
});

// ---------------------------------------------------------------- flows

test('netFlow separates money in from performance', () => {
  // Size doubles but so does the price: that is performance, not a flow.
  const performanceOnly = [
    { d: '2026-08-01', p: 10, sz: 1000, iv: 5 },
    { d: '2026-08-02', p: 20, sz: 2000, iv: 5 },
  ];
  assert.equal(netFlow(performanceOnly, 30), 0);

  // Price flat, size up: that is real money arriving.
  const realInflow = [
    { d: '2026-08-01', p: 10, sz: 1000, iv: 5 },
    { d: '2026-08-02', p: 10, sz: 1500, iv: 9 },
  ];
  assert.equal(netFlow(realInflow, 30), 500);

  // Price doubles while size stays put: investors pulled money out.
  const hiddenOutflow = [
    { d: '2026-08-01', p: 10, sz: 1000, iv: 9 },
    { d: '2026-08-02', p: 20, sz: 1000, iv: 5 },
  ];
  assert.equal(netFlow(hiddenOutflow, 30), -1000);
  assert.equal(netFlow([], 30), null);
});

test('a weekly flow window is not just a smaller monthly one', () => {
  // The dashboard leads with seven days and the popular page with thirty, so the
  // two have to be able to disagree: money that arrived a fortnight ago is in
  // one and not the other.
  const records = [
    { d: '2026-07-20', p: 10, sz: 1000, iv: 5 },
    { d: '2026-07-25', p: 10, sz: 3000, iv: 9 },  // ₺2,000 in, three weeks back
    { d: '2026-08-14', p: 10, sz: 3000, iv: 9 },
    { d: '2026-08-17', p: 10, sz: 3500, iv: 11 }, // ₺500 in, this week
  ];
  assert.equal(netFlow(records, 7), 500, 'only the recent leg');
  assert.equal(netFlow(records, 30), 2500, 'both legs');
  assert.equal(investorChange(records, 7), 2);
  assert.equal(investorChange(records, 30), 6);

  // The window runs back from the fund's OWN last print, not from today. A fund
  // that stopped reporting three weeks ago still reports a seven-day flow, over
  // its own last seven days. Every fund the dashboard ranks prints daily and
  // ends on the same date, so they stay comparable — but the figure is not
  // "the last seven days" in the calendar sense, and nothing should assume it is.
  const stale = [
    { d: '2026-07-20', p: 10, sz: 1000, iv: 5 },
    { d: '2026-07-25', p: 10, sz: 3000, iv: 9 },
  ];
  assert.equal(netFlow(stale, 7), 2000);
  // Under two prints in the window there is no flow to compute at all.
  assert.equal(netFlow([{ d: '2026-08-17', p: 10, sz: 1000, iv: 5 }], 7), null);
});

test('investorChange measures the window, not all time', () => {
  const recs = [
    { d: '2026-01-01', iv: 100 },
    { d: '2026-08-01', iv: 500 },
    { d: '2026-08-14', iv: 650 },
  ];
  assert.equal(investorChange(recs, 30), 150);
  assert.equal(investorChange(recs, 3650), 550);
});

test('allocationTurnover counts a trade once, not twice', () => {
  // 10 points moved out of equity and into cash is a 10% reshuffle.
  const snaps = [{ hs: 50, tr: 50 }, { hs: 40, tr: 60 }, { hs: 40, tr: 60 }];
  assert.equal(allocationTurnover(snaps), 5); // mean of 10 and 0
  assert.equal(allocationTurnover([{ hs: 100 }]), null);
});

// ---------------------------------------------------------------- factor model

test('ridgeFit recovers a known linear relationship', () => {
  // This is the regression test for the ridge-scaling bug: with an ABSOLUTE
  // penalty, daily-return-sized inputs (~1e-2) were swamped and every
  // coefficient collapsed towards zero.
  const X = [];
  const y = [];
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let i = 0; i < 300; i++) {
    const a = rand() * 0.02; // BIST-sized daily move
    const b = rand() * 0.015; // gold-sized daily move
    X.push([a, b]);
    y.push(0.0002 + 0.8 * a + 0.5 * b);
  }
  const fit = ridgeFit(y, X);
  assert.ok(fit, 'fit should succeed');
  assert.ok(Math.abs(fit.coef[0] - 0.8) < 0.02, `beta1 ${fit.coef[0]} should be ~0.8`);
  assert.ok(Math.abs(fit.coef[1] - 0.5) < 0.02, `beta2 ${fit.coef[1]} should be ~0.5`);
  assert.ok(Math.abs(fit.intercept - 0.0002) < 0.0005, `intercept ${fit.intercept}`);
  assert.ok(fit.r2 > 0.99, `noiseless data should be almost fully explained, got ${fit.r2}`);
});

test('ridgeFit is scale-invariant', () => {
  // The same relationship expressed in percent rather than decimals must give
  // the same R², or the penalty is not relative to the data.
  const mk = (scale) => {
    const X = [];
    const y = [];
    let s = 7;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    for (let i = 0; i < 200; i++) {
      const a = rnd() * scale;
      X.push([a]);
      y.push(1.3 * a);
    }
    return ridgeFit(y, X);
  };
  const small = mk(0.01);
  const big = mk(1);
  assert.ok(Math.abs(small.coef[0] - big.coef[0]) < 0.01,
    `coefficients must not depend on units: ${small.coef[0]} vs ${big.coef[0]}`);
  assert.ok(small.r2 > 0.99 && big.r2 > 0.99);
});

test('ridgeFit refuses when there is not enough data', () => {
  assert.equal(ridgeFit([1, 2], [[1], [2]]), null);
  assert.equal(ridgeFit([], []), null);
});

test('predictReturn applies the model to fresh factor moves', () => {
  const model = { intercept: 0.0001, coef: [1, 0, 0, 0], r2: 0.9, se: 0.002 };
  const out = predictReturn(model, { bist100: 0.02, goldgram: 0, usdtry: 0, mmf: 0 });
  assert.ok(Math.abs(out.estimate - 2.01) < 0.02, `estimate ${out.estimate}`);
  assert.ok(out.low < out.estimate && out.high > out.estimate, 'band brackets the estimate');
  // A missing factor must yield no estimate rather than a silently wrong one.
  assert.equal(predictReturn(model, { bist100: 0.02 }), null);
  assert.equal(predictReturn(null, {}), null);
});

test('FACTORS order is fixed — coefficients are positional', () => {
  assert.deepEqual(FACTORS, ['bist100', 'goldgram', 'usdtry', 'mmf']);
});

test('market factors are lagged one market day, the cash index is not', () => {
  // TEFAS dates a NAV one business day after the market it reflects. Getting
  // this wrong drops a gold fund's R² from 0.42 to 0.03 and flips the sign of
  // its gold beta, so the distinction is asserted rather than assumed.
  assert.ok(LAGGED_FACTORS.has('bist100'));
  assert.ok(LAGGED_FACTORS.has('goldgram'));
  assert.ok(LAGGED_FACTORS.has('usdtry'));
  assert.ok(!LAGGED_FACTORS.has('mmf'), 'mmf is already on TEFAS dates');
});

test('factorReader with lag skips weekends to the previous market day', () => {
  const returns = new Map([
    ['2026-08-06', 0.01],
    ['2026-08-07', 0.02], // Friday
    ['2026-08-10', 0.03], // Monday
  ]);
  const lagged = factorReader(returns, true);
  const direct = factorReader(returns, false);

  assert.equal(direct('2026-08-10'), 0.03);
  assert.equal(lagged('2026-08-10'), 0.02, 'Monday reads back to Friday');
  assert.equal(lagged('2026-08-07'), 0.01);
  assert.equal(lagged('2026-08-06'), null, 'nothing before the first observation');
  assert.equal(direct('2026-08-08'), null, 'no print on a weekend');
  assert.equal(lagged('2026-08-09'), 0.02, 'a weekend date still reads back to Friday');
});

test('pendingFactorReturns compounds only what the fund has not yet priced', () => {
  const bench = [
    { d: '2026-08-11', bist100: 100, goldgram: 200, usdtry: 40, mmf: 1 },
    { d: '2026-08-12', bist100: 110, goldgram: 210, usdtry: 41, mmf: 1.01 },
    { d: '2026-08-13', bist100: 121, goldgram: 220, usdtry: 42, mmf: 1.02 },
  ];
  // The fund's newest NAV is dated the 12th, so it already reflects the 11th.
  const pending = pendingFactorReturns(bench, '2026-08-12');
  assert.ok(pending, 'should produce an estimate');
  assert.ok(Math.abs(pending.returns.bist100 - 0.21) < 1e-9, 'compounds 11th -> 13th');
  assert.equal(pending.from, '2026-08-11');
  assert.equal(pending.to, '2026-08-13');

  // Fully up to date: nothing left to predict.
  assert.equal(pendingFactorReturns(bench, '2026-08-14'), null);
});

test('dailyReturns keys each return by its later date', () => {
  const out = dailyReturns([['2026-01-01', 100], ['2026-01-02', 110]]);
  assert.equal(out.size, 1);
  assert.ok(Math.abs(out.get('2026-01-02') - 0.1) < 1e-9);
});

// ---------------------------------------------------------------- scoring

test('scoreFund compares net-of-tax return against net-of-tax cash', () => {
  const ctx = { cashReturn: 47.81, taxRates: TAX_DEFAULTS, horizon: 'y1' };
  // An equity-intensive fund is untaxed; cash is taxed at 7.5%.
  const winner = scoreFund(fund({ g: { equity: 90 }, r: { y1: 60 }, vol: 20 }), ctx);
  assert.equal(winner.taxRate, 0);
  assert.equal(winner.net, 60);
  assert.ok(winner.excess > 15 && winner.excess < 17, `excess ${winner.excess}`);

  // The median equity fund returned ~28% — well below cash, so negative excess.
  const loser = scoreFund(fund({ g: { equity: 90 }, r: { y1: 28 }, vol: 20 }), ctx);
  assert.ok(loser.excess < 0, 'underperforming cash must score negative');
  assert.equal(scoreFund(fund({ r: {} }), ctx), null);
});

test('scoreFund floors volatility so tiny risk cannot fake a huge ratio', () => {
  const ctx = { cashReturn: 40, taxRates: { ...TAX_DEFAULTS, moneyMarket: 0 } };
  const s = scoreFund(fund({ g: { cash: 100 }, r: { y1: 41 }, vol: 0.01 }), ctx);
  assert.ok(s.ratio <= 2.1, `ratio ${s.ratio} should be damped by the volatility floor`);
});

test('qualityFlags surfaces cautions as well as strengths', () => {
  const ctx = { cashReturn: 47.81, peerMedian: 28.48, taxRates: TAX_DEFAULTS };
  const flags = qualityFlags(fund({ g: { equity: 90 }, r: { y1: 60 }, vol: 20, mdd: -8, sz: 5e9 }), ctx);
  const by = Object.fromEntries(flags.map((f) => [f.id, f]));
  assert.equal(by.beatsCash.good, true);
  assert.equal(by.beatsPeers.good, true);
  assert.equal(by.drawdown.good, true);

  const weak = qualityFlags(fund({ g: { equity: 90 }, r: {}, vol: 20, mdd: -40, sz: 1e6 }), ctx);
  const wby = Object.fromEntries(weak.map((f) => [f.id, f]));
  assert.equal(wby.drawdown.good, false);
  assert.equal(wby.shortHistory.good, false);
  assert.equal(wby.smallFund.good, false);
});

test('the tax table has no bucket the fund universe cannot reach', () => {
  // Pension funds were the only 'pension' bucket, and they are out of scope now.
  // A stale bucket would sit in meta.taxDefaults implying a rate nothing uses.
  assert.deepEqual(
    Object.keys(TAX_DEFAULTS).sort(),
    ['equityIntensive', 'moneyMarket', 'standard']
  );
  for (const g of [{ equity: 90 }, { cash: 90 }, { govDebt: 90 }]) {
    assert.ok(Object.keys(TAX_DEFAULTS).includes(taxBucket(fund({ g }))));
  }
});

test('median ignores nullish values', () => {
  assert.equal(median([3, 1, null, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

// ---------------------------------------------------------------- cash hurdle

test('the cash hurdle is matched to the horizon, never borrowed from another', () => {
  const ctx = { cashReturns: { m1: 3.4, m3: 10.6, y1: 47.8 }, cashReturn: 47.8 };
  assert.equal(cashReturnFor(ctx, 'm1'), 3.4);
  assert.equal(cashReturnFor(ctx, 'm3'), 10.6);
  assert.equal(cashReturnFor(ctx, 'y1'), 47.8);
  // No 6-month figure was supplied, and the 1-year one is not a substitute:
  // subtracting a year of cash from six months of fund return is the bug.
  assert.equal(cashReturnFor(ctx, 'm6'), null);
  // A bare `cashReturn` is a one-year figure by definition.
  assert.equal(cashReturnFor({ cashReturn: 47.8 }, 'y1'), 47.8);
  assert.equal(cashReturnFor({ cashReturn: 47.8 }, 'm3'), null);
});

test('scoreFund compares like with like across every horizon', () => {
  // Money-market funds returned far less over three months than over a year, so
  // a fund up 12% in three months beats cash even though it trails the 1y figure.
  const ctx = {
    cashReturns: { m3: 10.6, y1: 47.8 },
    taxRates: { equityIntensive: 0, moneyMarket: 0, standard: 0 },
  };
  const f = fund({ r: { m3: 12, y1: 40 }, vol: 4 });

  const short = scoreFund(f, { ...ctx, horizon: 'm3' });
  assert.equal(short.cashNet, 10.6);
  assert.equal(short.excess, 1.4, 'three months must be judged against three months');

  const long = scoreFund(f, { ...ctx, horizon: 'y1' });
  assert.equal(long.cashNet, 47.8);
  assert.equal(long.excess, -7.8);
});

test('scoreFund withholds a score rather than inventing a hurdle', () => {
  const f = fund({ r: { m6: 20 }, vol: 4 });
  assert.equal(scoreFund(f, { horizon: 'm6', cashReturn: 47.8 }), null);
  assert.ok(scoreFund(f, { horizon: 'm6', cashReturns: { m6: 22 } }));
});

test('the build supplies a cash return for every horizon the UI offers', async () => {
  // Guards the coupling between HORIZONS and meta.cashReturns: a horizon the
  // selector offers but the build never computes silently blanks the ranking.
  const fs = await import('node:fs/promises');
  let meta;
  try {
    meta = JSON.parse(await fs.readFile(new URL('../data/meta.json', import.meta.url), 'utf8'));
  } catch {
    return; // no built data in this checkout
  }
  assert.ok(meta.cashReturns, 'meta.json has no cashReturns — re-run build-analytics');
  for (const hz of HORIZONS) {
    assert.ok(
      hz.key in meta.cashReturns,
      `no money-market return computed for horizon ${hz.key}`
    );
  }
});

// ---------------------------------------------------------------- crash protection

/** A rising then falling series, as [date, level] pairs one day apart. */
const series = (levels, from = '2026-01-01') =>
  levels.map((v, i) => [new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10), v]);

test('a fall runs from the local high to the low that follows it', () => {
  // Up to 100, down to 85, back up. One fall of 15%.
  const eps = crashEpisodes(series([90, 100, 95, 88, 85, 89, 92]));
  assert.equal(eps.length, 1);
  assert.equal(eps[0].from, '2026-01-02');
  assert.equal(eps[0].to, '2026-01-05');
  assert.equal(eps[0].fall, -15);
});

test('a fall shallower than the threshold is not an episode', () => {
  assert.deepEqual(crashEpisodes(series([100, 95, 92, 100])), []);
  // ...and the threshold is a parameter, not a law.
  assert.equal(crashEpisodes(series([100, 95, 92, 100]), { fall: 5 }).length, 1);
});

test('two falls separated by a rebound are two episodes, not one', () => {
  // This is the whole reason for the rebound rule. BIST's July 2024 high was not
  // regained until August 2025, so a peak-to-recovery definition reports one
  // 13-month episode and hides the March 2025 crash inside it.
  const eps = crashEpisodes(series([100, 88, 96, 84, 92]), { fall: 10, rebound: 5 });
  assert.equal(eps.length, 2);
  assert.deepEqual(eps.map((e) => [e.from, e.to]), [
    ['2026-01-01', '2026-01-02'],
    ['2026-01-03', '2026-01-04'],
  ]);
  // A smaller bounce is not a new peak, so the same series reads as one long fall.
  const merged = crashEpisodes(series([100, 88, 96, 84, 92]), { fall: 10, rebound: 12 });
  assert.equal(merged.length, 1);
  assert.deepEqual([merged[0].from, merged[0].to], ['2026-01-01', '2026-01-04']);
});

test('a fall still under way is reported rather than withheld', () => {
  const eps = crashEpisodes(series([100, 95, 88, 86]));
  assert.equal(eps.length, 1);
  assert.equal(eps[0].to, '2026-01-04', 'the low so far is the low');
});

test('crashEpisodes survives series too short or too broken to segment', () => {
  assert.deepEqual(crashEpisodes([]), []);
  assert.deepEqual(crashEpisodes(null), []);
  assert.deepEqual(crashEpisodes(series([100])), []);
  assert.deepEqual(crashEpisodes([['2026-01-01', 0], ['2026-01-02', null]]), []);
});

test('spared is measured against cash, not against zero', () => {
  // The index lost 12 while cash earned 4: holding cash was 16 points better
  // than holding the index.
  const fall = { fall: -12, cash: 4 };
  assert.equal(crashSpared(fall, 4), 100, 'matching cash is being spared the fall');
  assert.equal(crashSpared(fall, -12), 0, 'matching the index is being spared none of it');
  // 8 points over cash against the index's 16 under it: the whole fall avoided,
  // and half of it again in gains on top.
  assert.equal(crashSpared(fall, 12), 150);
  assert.equal(crashSpared(fall, -20), -50, 'falling further than the index goes below zero');
  // Without the cash adjustment a fund that merely held its value would read as
  // having avoided the whole fall, which over a two-month window it did not.
  assert.equal(crashSpared({ fall: -12, cash: 4 }, 0), 75);
  assert.equal(crashSpared({ fall: -12 }, 0), 100, 'no rate recorded falls back to raw');
});

test('crashSpared refuses inputs that are not a fall', () => {
  assert.equal(crashSpared({ fall: -12, cash: 4 }, null), null);
  assert.equal(crashSpared({ fall: 5 }, -1), null, 'a rise is not an episode');
  assert.equal(crashSpared(null, -1), null);
  assert.equal(crashSpared({ fall: -12 }, Number.NaN), null);
});

test('crash protection is the median episode, not the compounded one', () => {
  const eps = [{ fall: -10, cash: 0 }, { fall: -10, cash: 0 }, { fall: -10, cash: 0 }];
  // Two ordinary falls and one spectacular rally. Compounding lets the rally
  // carry the score; the median reports what the fund usually does.
  const cp = crashProtection(eps, [-5, -5, 500]);
  assert.equal(cp.spared, 50);
  assert.equal(cp.n, 3);
  assert.equal(cp.worst, -5);
});

test('a fund is measured only on the falls it lived through', () => {
  const eps = [{ fall: -20, cash: 0 }, { fall: -10, cash: 0 }, { fall: -10, cash: 0 }];
  const cp = crashProtection(eps, [null, -2, -4]);
  assert.equal(cp.n, 2, 'the fall before it existed is not counted');
  assert.equal(cp.of, 3, 'but the reader is told how many there were');
  assert.equal(cp.spared, 70, 'the average of 80 and 60');
  assert.equal(cp.worst, -4);
});

test('one fall is an anecdote, so no figure is published', () => {
  const eps = [{ fall: -10 }, { fall: -10 }];
  assert.equal(crashProtection(eps, [-1, null]), null);
  assert.equal(crashProtection(eps, [null, null]), null);
  assert.equal(crashProtection([], [-1, -1]), null);
  assert.equal(crashProtection(eps, []), null);
  assert.equal(crashProtection(null, null), null);
});

test('a fund that gained through the falls is not capped at 100', () => {
  const eps = [{ fall: -10, cash: 0 }, { fall: -10, cash: 0 }];
  const cp = crashProtection(eps, [5, 5]);
  assert.equal(cp.spared, 150, 'rising while the index fell reads above 100');
  assert.equal(cp.worst, 5, 'and the worst fall is still a gain');
});

// ---------------------------------------------------------------- themes & dividends

/** resolve() for the tests: a ticker table, and anything unlisted is not equity. */
const listings = {
  ASELS: ['defence', 0.06],
  GARAN: ['banks', 3.99],
  ISCTR: ['banks', 4.31],
  NVDA: ['semis', 0.02],
  SLV: [null, 0], // an ETF: a real holding with a yield, but no line of business
  MYSTERY: null,  // listed, nothing known about it
};
const resolve = (p) => (p.code in listings ? listings[p.code] : undefined);
const pos = (code, weight) => ({ code, weight });

test('theme weights are shares of the fund, and they add up', () => {
  const spread = themeExposure(
    [pos('GARAN', 20), pos('ISCTR', 10), pos('ASELS', 15), pos('BOND', 55)],
    resolve
  );
  assert.deepEqual(spread.themes, { banks: 30, defence: 15 });
  assert.equal(spread.equity, 45, 'the bond is not part of the equity base');
  assert.equal(spread.covered, 45);
});

test('a holding nobody can identify counts against coverage, not against a theme', () => {
  const spread = themeExposure([pos('GARAN', 20), pos('MYSTERY', 30)], resolve);
  assert.deepEqual(spread.themes, { banks: 20 });
  assert.equal(spread.equity, 50, 'it is still a share');
  assert.equal(spread.covered, 20, 'but nothing is known about it');
});

test('a pooled holding carries a yield and no theme', () => {
  // An ETF is not a company. Counting it as one would mean guessing which of the
  // 180 in the data is which; counting it as unidentified would understate what
  // the fund could be seen through.
  const spread = themeExposure([pos('SLV', 40), pos('GARAN', 10)], resolve);
  assert.deepEqual(spread.themes, { banks: 10 });
  assert.equal(spread.covered, 50, 'the ETF was identified — it simply has no theme');
});

test('a theme too small to be a position is dropped', () => {
  const spread = themeExposure([pos('GARAN', 40), pos('ASELS', 0.2)], resolve);
  assert.deepEqual(spread.themes, { banks: 40 });
  assert.ok(MIN_THEME_WEIGHT > 0.2 && MIN_THEME_WEIGHT < 1);
});

test('dividend income is the yield of each holding times what the fund has in it', () => {
  // 20% of the fund in something yielding 4% contributes 0.8 points of the
  // fund's own value, not 4.
  const spread = themeExposure([pos('ISCTR', 20), pos('BOND', 80)], resolve);
  assert.equal(spread.dividend, 0.86, '20% × 4.31%');
  // Nothing that pays is a real zero, and distinguishable from an unknown one
  // by `covered`.
  const none = themeExposure([pos('SLV', 30)], resolve);
  assert.equal(none.dividend, 0);
  assert.equal(none.covered, 30);
});

test('a levered fund can hold more equity than it owns', () => {
  const spread = themeExposure([pos('GARAN', 90), pos('ASELS', 70)], resolve);
  assert.equal(spread.equity, 160);
  assert.deepEqual(spread.themes, { banks: 90, defence: 70 });
});

test('themeExposure withholds rather than dividing by nothing', () => {
  assert.equal(themeExposure([], resolve), null);
  assert.equal(themeExposure(null, resolve), null);
  assert.equal(themeExposure([pos('BOND', 100)], resolve), null, 'a fund with no shares');
  // A short position is exposure the other way; it is not a holding to classify.
  assert.equal(themeExposure([pos('GARAN', -10)], resolve), null);
});

// ---------------------------------------------------------------- share ownership

test('ownership adds up who holds a share and how much of the company that is', () => {
  const own = ownership([
    { fund: 'AAA', value: 100e6, shares: 1e6, weight: 5, prev: 4 },
    { fund: 'BBB', value: 300e6, shares: 3e6, weight: 2, prev: 3 },
    { fund: 'CCC', value: 50e6, shares: 0.5e6, weight: 1, prev: 1 },
  ], { shares: 100e6, cap: 10e9 });

  assert.equal(own.funds, 3);
  assert.equal(own.value, 450e6);
  assert.equal(own.shares, 4.5e6);
  assert.equal(own.pctShares, 4.5, 'share counts against the exchange listing');
  assert.equal(own.pctCap, 4.5, 'and lira against market value, which should agree');
  assert.equal(own.adding, 1);
  assert.equal(own.trimming, 1);
  assert.equal(own.compared, 3, 'a position that did not move is still compared');
  assert.equal(own.top[0].c, 'BBB', 'largest holder first, by lira not by weight');
  assert.equal(own.top[0].m, -1, 'and its move in percentage points');
});

test('a blank previous weight is not a new position', () => {
  // Three quarters of filings carry a previous weight; the rest leave the column
  // empty. Reading the empty ones as "opened this month" would have every share
  // on the exchange being bought by everybody.
  const own = ownership([
    { fund: 'AAA', value: 100e6, weight: 5, prev: null },
    { fund: 'BBB', value: 100e6, weight: 5, prev: 4 },
  ], {});
  assert.equal(own.funds, 2, 'both still count as holders');
  assert.equal(own.compared, 1, 'only one can be compared');
  assert.equal(own.adding, 1);
  assert.equal(own.trimming, 0);
  assert.equal(own.top[0].m, null, 'and the uncomparable one shows no move');
});

test('an impossible weight move is a filing error, not a trade', () => {
  // A real filing gave last month's ASELS weight as 2,070,000%. A position
  // cannot move further than the whole portfolio, so the move is dropped — the
  // fund is still a holder, it just casts no vote on direction.
  const own = ownership([
    { fund: 'AED', value: 10e6, weight: 6.72, prev: 2070000 },
    { fund: 'BBB', value: 10e6, weight: 5, prev: 4 },
  ], {});
  assert.equal(own.funds, 2);
  assert.equal(own.compared, 1);
  assert.equal(own.trimming, 0, 'the nonsense does not read as the biggest sale in history');
  assert.equal(own.top.find((t) => t.c === 'AED').m, null);
});

test('a holder list is cut to the holders worth reading', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    fund: `F${i}`, value: (40 - i) * 1e6, weight: 1, prev: 1,
  }));
  const own = ownership(many, {});
  assert.equal(own.funds, 40, 'all of them are counted');
  assert.equal(own.top.length, TOP_HOLDERS, 'and the tail is left off the table');
  assert.equal(own.top[0].c, 'F0');
});

test('the move guard is the size of the whole portfolio', () => {
  const at = ownership([{ fund: 'A', value: 1e6, weight: MAX_WEIGHT_MOVE, prev: 0 }], {});
  assert.equal(at.compared, 1, 'a position that went from nothing to everything is possible');
  const past = ownership([{ fund: 'A', value: 1e6, weight: MAX_WEIGHT_MOVE + 1, prev: 0 }], {});
  assert.equal(past.compared, 0, 'anything past it is a filing error');
});

test('ownership answers nothing when nobody holds the share', () => {
  assert.equal(ownership([], { cap: 1e9 }), null);
  assert.equal(ownership(null, {}), null);
  assert.equal(ownership([{ fund: 'AAA', value: null }], {}), null,
    'a row with no lira is not a holding');
});

test('ownership percentages need the exchange figures to be there', () => {
  const own = ownership([{ fund: 'AAA', value: 100e6, shares: 1e6, weight: 5, prev: 5 }], {});
  assert.equal(own.pctShares, null);
  assert.equal(own.pctCap, null);
  assert.equal(own.value, 100e6, 'but the lira held is still known');
});

test('a price sits somewhere in its own 52-week range', () => {
  assert.equal(rangePosition(150, 100, 200), 50);
  assert.equal(rangePosition(200, 100, 200), 100, 'at the high');
  assert.equal(rangePosition(100, 100, 200), 0, 'at the low');
  // A share that broke out today prices above the 52-week high the figures were
  // taken at, which is a clamp rather than 105% of a range.
  assert.equal(rangePosition(220, 100, 200), 100);
  // Not 50: a share that has traded at one price all year is not "in the middle"
  // of anything, and drawing it mid-range would invent a range it does not have.
  assert.equal(rangePosition(100, 100, 100), null);
  assert.equal(rangePosition(null, 100, 200), null);
});

// ---------------------------------------------------------------- statements

test('a quarterly array is dated backwards from the quarter that was reported', () => {
  // TradingView hands these back newest-first with no dates at all, so the whole
  // series hangs off the one date it does give: the end of the last filed
  // quarter. Get the direction wrong and every bar on the page is misplaced.
  assert.deepEqual(periodEnds('2026-06-30', 4),
    ['2026-06-30', '2026-03-31', '2025-12-31', '2025-09-30']);
  assert.deepEqual(periodEnds('2026-06-30', 1), ['2026-06-30']);
  assert.deepEqual(periodEnds('2026-06-30', 0), []);
  assert.deepEqual(periodEnds(null, 4), []);
});

test('a company whose year does not end in December keeps its own quarters', () => {
  // Beşiktaş closes its books on 31 May. Three months back is the end of
  // February, and a naive date subtraction lands on 3 March — which would date
  // every one of its quarters to the wrong period.
  assert.deepEqual(periodEnds('2026-05-31', 4),
    ['2026-05-31', '2026-02-28', '2025-11-30', '2025-08-31']);
  // A leap year gives that February a day back.
  assert.deepEqual(periodEnds('2024-05-31', 2), ['2024-05-31', '2024-02-29']);
  // An anchor that is NOT its month's last day keeps its day number instead of
  // being dragged to the end of every month.
  assert.deepEqual(periodEnds('2026-06-15', 2), ['2026-06-15', '2026-03-15']);
});

test('quarters are labelled the way the estimate feed labels them', () => {
  assert.equal(quarterLabel('2026-06-30'), '2026-Q2');
  assert.equal(quarterLabel('2026-01-31'), '2026-Q1');
  assert.equal(quarterLabel('2025-12-31'), '2025-Q4');
});

test('a rolling twelve months needs four quarters behind it', () => {
  const q = [10, 20, 30, 40, 50];
  assert.deepEqual(trailingTwelve(q), [null, null, null, 100, 140]);
  // A gap anywhere in the window makes the sum a lie, not a smaller number.
  assert.deepEqual(trailingTwelve([10, null, 30, 40, 50]), [null, null, null, null, null]);
  assert.deepEqual(trailingTwelve([]), []);
});

test('growth is measured against the same season a year earlier', () => {
  const q = [100, 50, 80, 120, 150, 60, 96, 132];
  const yoy = yearOnYear(q, 4);
  assert.equal(yoy[0], null, 'nothing to compare the first year against');
  assert.equal(yoy[4], 50, '150 against 100');
  assert.equal(yoy[5], 20, '60 against 50 — the same quarter, not the one before');
  // Out of a loss there is no growth rate: 400% "growth" from -10 to 30 would
  // be printed as a triumph when it is a change of sign.
  assert.deepEqual(yearOnYear([-10, 0, 0, 0, 30], 4), [null, null, null, null, null]);
});

test('a margin is a ratio and refuses a zero denominator', () => {
  assert.deepEqual(ratioSeries([25, 50], [100, 200]), [25, 25]);
  assert.deepEqual(ratioSeries([25, 50], [100, 0]), [25, null]);
  assert.deepEqual(ratioSeries([25, null], [100, 200]), [25, null]);
  // A negative margin is a real number and stays one.
  assert.deepEqual(ratioSeries([-30], [100]), [-30]);
});

test('leverage is only a repayment horizon when there is profit to repay from', () => {
  assert.equal(netDebtToEbitda(100, 50), 2);
  assert.equal(netDebtToEbitda(-100, 50), -2, 'net cash keeps its sign');
  assert.equal(netDebtToEbitda(100, 0), null, 'no earnings, no horizon');
  assert.equal(netDebtToEbitda(100, -20), null, 'a loss cannot repay anything');
  assert.equal(netDebtToEbitda(null, 50), null);
});

test('the two solvency scores are read in bands, not as bare numbers', () => {
  assert.equal(altmanBand(3.21), 'safe');
  assert.equal(altmanBand(2.99), 'safe', 'the published threshold, inclusive');
  assert.equal(altmanBand(2.5), 'grey');
  assert.equal(altmanBand(1.0), 'distress');
  assert.equal(altmanBand(null), null);
  assert.equal(piotroskiBand(9), 'safe');
  assert.equal(piotroskiBand(6), 'grey');
  assert.equal(piotroskiBand(3), 'distress');
});

test('a consensus needs someone to have made it', () => {
  assert.equal(consensus({ recN: 0, tgt: 200 }), null, 'a target nobody set is not a consensus');
  assert.equal(consensus(null), null);
  const view = consensus({ recN: 9, recBuy: 8, recHold: 1, recSell: 0, tgt: 138.78, tgtHi: 208, tgtLo: 90 }, 80.25);
  assert.equal(view.n, 9);
  assert.equal(view.buy, 8);
  assert.equal(Math.round(view.upside), 73, 'the distance from today to the target');
  // Priced off the live price passed in, not the stored close.
  assert.equal(consensus({ recN: 1, tgt: 100, p: 50 }).upside, 100);
  assert.equal(consensus({ recN: 1, tgt: 100, p: 50 }, 200).upside, -50);
});

test('a beat is only a beat where both halves were on file', () => {
  const rows = [
    { p: '2025-Q1', done: true, rev: 110, revE: 100 },
    { p: '2025-Q2', done: true, rev: 90, revE: 100 },
    { p: '2025-Q3', done: true, rev: 120, revE: null },
    { p: '2025-Q4', done: false, rev: null, revE: 130 },
  ];
  const record = beatRecord(rows, 'rev');
  assert.equal(record.of, 2, 'the unforecast quarter and the unreported one are not counted');
  assert.equal(record.beats, 1);
  assert.equal(record.pct, 50);
  assert.equal(beatRecord([], 'rev'), null);
  assert.equal(beatRecord([{ p: '2025-Q1', done: false, revE: 100 }], 'rev'), null);
});

test('a surprise is measured against the size of the forecast', () => {
  assert.equal(surpriseOf(110, 100), 10);
  assert.equal(surpriseOf(90, 100), -10);
  // Against a forecast loss the sign has to survive: coming in at -50 when -100
  // was expected is a beat, and dividing by a negative would call it a miss.
  assert.equal(surpriseOf(-50, -100), 50);
  assert.equal(surpriseOf(110, 0), null);
  assert.equal(surpriseOf(null, 100), null);
});

test('peers are companies in the same industry, largest first', () => {
  const all = [
    { c: 'FROTO', kind: 'stock', ind: 'Motor Vehicles', cap: 279e9 },
    { c: 'TOASO', kind: 'stock', ind: 'Motor Vehicles', cap: 135e9 },
    { c: 'ASUZU', kind: 'stock', ind: 'Motor Vehicles', cap: 12e9 },
    { c: 'GARAN', kind: 'stock', ind: 'Major Banks', cap: 543e9 },
    { c: 'ZPLIB', kind: 'etf', ind: 'Motor Vehicles', cap: 5e9 },
    { c: 'NOCAP', kind: 'stock', ind: 'Motor Vehicles', cap: null },
  ];
  const peers = peersOf(all[0], all);
  assert.deepEqual(peers.map((s) => s.c), ['TOASO', 'ASUZU'],
    'no bank, no exchange-traded fund, nothing the exchange does not size, and not itself');
  assert.deepEqual(peersOf(all[0], all, 1).map((s) => s.c), ['TOASO']);
  assert.deepEqual(peersOf({ c: 'X', ind: null }, all), [], 'an unclassified listing has no peers');
});

test('the peer median is taken per column, over whatever each one has', () => {
  const group = [{ pe: 10, roe: 20 }, { pe: 20, roe: null }, { pe: 30, roe: 40 }];
  const mid = peerMedians(group, ['pe', 'roe', 'missing']);
  assert.equal(mid.pe, 20);
  assert.equal(mid.roe, 30, 'the company that reports no return on equity is skipped, not zeroed');
  assert.equal(mid.missing, null);
});

test('a rating bar divides the analysts it was given', () => {
  assert.equal(shareOfTotal(8, 10), 80);
  assert.equal(shareOfTotal(0, 10), 0);
  assert.equal(shareOfTotal(1, 0), 0, 'no analysts, no width');
});

// ---------------------------------------------------------------- dashboard

test('overlap is the smaller weight wherever two funds hold the same thing', () => {
  // Both 40% in ASELS: forty of those points are one position, not two.
  assert.equal(overlapOf({ ASELS: 40 }, { ASELS: 40 }), 40);
  // One at 40 and one at 5 duplicate only the 5.
  assert.equal(overlapOf({ ASELS: 40 }, { ASELS: 5 }), 5);
  assert.equal(overlapOf({ ASELS: 40 }, { THYAO: 40 }), 0, 'different shares are not an overlap');
  assert.equal(overlapOf({ ASELS: 30, THYAO: 20 }, { ASELS: 25, THYAO: 25 }), 45);
  assert.equal(overlapOf(null, { ASELS: 1 }), null);
});

test('a filing becomes weights, with split lines added rather than replaced', () => {
  // The same holding is filed under an ISIN on one line and a ticker on the
  // next; taking the last one would report half the position.
  assert.deepEqual(
    weightsOf([{ code: 'ASELS', weight: 3 }, { code: 'ASELS', weight: 2 }]),
    { ASELS: 5 }
  );
  // A row with no code cannot be matched against another fund's, so it is left
  // out — which makes every overlap a floor rather than a guess.
  assert.deepEqual(weightsOf([{ code: null, weight: 9 }, { code: 'X', weight: 1 }]), { X: 1 });
  // A closed position files at zero, and a correction can file negative.
  assert.deepEqual(weightsOf([{ code: 'A', weight: 0 }, { code: 'B', weight: -1 }]), {});
  assert.deepEqual(weightsOf(null), {});
});

test('only pairs that share more than the floor are worth warning about', () => {
  const filings = {
    PHE: { A: 50, B: 30, C: 20 },
    PBR: { A: 45, B: 35, C: 20 },
    OTH: { X: 60, Y: 40 },
    NIL: null,
  };
  const pairs = overlappingPairs(filings);
  assert.equal(pairs.length, 1, 'the unrelated fund and the missing filing raise nothing');
  assert.equal(pairs[0].a, 'PHE');
  assert.equal(pairs[0].b, 'PBR');
  assert.equal(pairs[0].shared, 95);
  // The floor is a floor, not a fixed rule.
  assert.equal(overlappingPairs(filings, 100).length, 0);
  assert.equal(overlappingPairs({}).length, 0);
});

test('the shared positions are reported at the smaller of the two weights', () => {
  const rows = sharedPositions({ A: 50, B: 10, C: 5 }, { A: 20, B: 40 });
  assert.deepEqual(rows.map((r) => r.code), ['A', 'B'], 'largest first, and C is not held by both');
  assert.equal(rows[0].weight, 20, 'the smaller of 50 and 20');
  assert.equal(rows[1].weight, 10);
  assert.equal(sharedPositions({ A: 1 }, { A: 1, B: 1 }, 1).length, 1, 'the limit is honoured');
});

test('a theme moves by what the money in it did, not by an average of its members', () => {
  const members = [['BIG', 0.9], ['SMALL', 0.1]];
  const quotes = { BIG: { change: 1 }, SMALL: { change: 11 } };
  // Equal-weighted this would be 6%. The big company is nine tenths of the
  // theme, so the theme moved 2%.
  assert.equal(weightedMove(members, quotes).move, 2);
  assert.equal(weightedMove(members, quotes).priced, 2);
});

test('a suspended share renormalises its theme rather than dragging it to zero', () => {
  const members = [['A', 0.5], ['B', 0.5]];
  // B has no quote. The theme is what A did, over the half of it that is priced
  // — not 1% because the other half was treated as flat.
  const out = weightedMove(members, { A: { change: 2 } });
  assert.equal(out.move, 2);
  assert.equal(out.covered, 50);
  assert.equal(out.priced, 1);
  assert.equal(weightedMove(members, {}), null, 'nothing priced is not a move of zero');
  assert.equal(weightedMove([], { A: { change: 1 } }), null);
});

test('a theme too thinly priced does not report a move at all', () => {
  const weights = {
    full: [['A', 0.6], ['B', 0.4]],
    thin: [['C', 0.9], ['D', 0.1]],
  };
  const quotes = { A: { change: 3 }, B: { change: 1 }, D: { change: -5 } };
  const moves = themeMoves(weights, quotes);
  assert.deepEqual(moves.map((m) => m.id), ['full'],
    'the thin theme has 10% of itself priced and says nothing');
  assert.equal(moves[0].move, 2.2);
  // With the floor dropped it reports, and reports what D did.
  assert.equal(themeMoves(weights, quotes, 5).find((m) => m.id === 'thin').move, -5);
});

test('themes are ordered by the size of the move, either direction', () => {
  const weights = { up: [['A', 1]], down: [['B', 1]], flat: [['C', 1]] };
  const quotes = { A: { change: 2 }, B: { change: -7 }, C: { change: 0.1 } };
  assert.deepEqual(themeMoves(weights, quotes).map((m) => m.id), ['down', 'up', 'flat'],
    'the biggest fall leads, because that is what a reader is looking for');
});

test('movers come from a named universe and keep their direction', () => {
  const quotes = {
    A: { change: 5 }, B: { change: 3 }, C: { change: -1 }, D: { change: -4 },
    PENNY: { change: 40 },
  };
  const out = moversIn(['A', 'B', 'C', 'D'], quotes, 2);
  assert.deepEqual(out.up.map((r) => r.code), ['A', 'B']);
  assert.deepEqual(out.down.map((r) => r.code), ['D', 'C'], 'worst first');
  assert.equal(out.of, 4);
  // The point of passing the universe: the 40% mover is not in the index and
  // does not get to be the story of the day.
  assert.ok(!out.up.some((r) => r.code === 'PENNY'));
  // A green day has no fallers, and they are not filled in with flat names.
  assert.equal(moversIn(['A', 'B'], quotes, 2).down.length, 0);
  assert.equal(moversIn(['NOPE'], quotes), null);
});

test('a set of funds is compared with cash on the median, not the mean', () => {
  const funds = [
    { r: { y1: 40 } }, { r: { y1: 45 } }, { r: { y1: 50 } }, { r: { y1: 600 } },
  ];
  const out = versusCash(funds, 'y1', { y1: 47.92 });
  // The mean is 183.75 and would report a portfolio comfortably ahead of cash
  // when three of its four holdings are behind it.
  assert.equal(out.median, 47.5);
  assert.equal(out.cash, 47.92);
  assert.equal(out.gap, -0.42, 'the gap between two percentages is in points');
  assert.equal(out.beating, 2);
  assert.equal(out.of, 4);
});

test('comparing with cash needs both halves', () => {
  assert.equal(versusCash([], 'y1', { y1: 10 }), null);
  assert.equal(versusCash([{ r: {} }], 'y1', { y1: 10 }), null, 'a fund too new to have the horizon');
  const noCash = versusCash([{ r: { y1: 30 } }], 'y1', {});
  assert.equal(noCash.median, 30);
  assert.equal(noCash.gap, null, 'no hurdle, no verdict — not a gap of thirty');
  assert.equal(noCash.beating, null);
});

// ---------------------------------------------------------------- speculative boards

const board = (over = {}) => ({
  c: 'TAHTA', kind: 'stock', cap: 10e9, float: 20, pb: 20, vola: 9,
  r: { m3: 120, y1: 900 }, pe: null, ni: -1e6,
  own: { top: [{ c: 'AAA', v: 2e9 }] },
  ...over,
});

test('the conditions are only counted when the figures to test them exist', () => {
  const full = boardFlags(board());
  assert.equal(full.tested, 6);
  assert.equal(full.hit, 6);
  assert.ok(full.speculative);
  // A listing the exchange publishes nothing about is not thereby clean.
  const bare = boardFlags({ c: 'X', kind: 'stock', r: { y1: 900 } });
  assert.equal(bare.tested, 1, 'only the run-up could be tested');
  assert.equal(bare.speculative, false, 'one condition out of one is not a verdict');
});

test('an exchange-traded fund is not put through tests written for a company', () => {
  // No float, no earnings, no book value: it would score two out of two and be
  // called speculative for being an index tracker.
  assert.equal(boardFlags({ c: 'ZPLIB', kind: 'etf', r: { y1: 900 }, vola: 9 }), null);
  assert.equal(boardFlags({ c: 'T', kind: 'trust', r: { y1: 900 } }), null);
  assert.equal(boardFlags(null), null);
});

test('the run-up is required, however many other conditions are met', () => {
  // Thin, loss-making, closely held, dear against book, volatile — and the price
  // has not moved. That is an illiquid company, not a board being worked, and
  // calling it one about a real business would be wrong.
  const still = boardFlags(board({ r: { m3: 4, y1: 11 } }));
  assert.equal(still.hit, 5);
  assert.equal(still.moved, false);
  assert.equal(still.speculative, false);
});

test('either window can carry the run-up', () => {
  assert.ok(boardFlags(board({ r: { m3: 80, y1: 10 } })).moved, 'a quarter is enough');
  assert.ok(boardFlags(board({ r: { m3: 5, y1: 250 } })).moved, 'so is a year');
  assert.equal(boardFlags(board({ r: { m3: 74, y1: 199 } })).moved, false,
    'just under both thresholds is under');
  // A share with only one of the two windows on file is still testable.
  assert.ok(boardFlags(board({ r: { y1: 400 } })).moved);
});

test('three conditions including the run-up is the bar', () => {
  const two = board({ float: 60, pb: 1, vola: 2, pe: 8, ni: 5e6, own: null, cap: 10e9 });
  assert.equal(boardFlags(two).hit, 1, 'the run-up alone');
  assert.equal(boardFlags(two).speculative, false);
  const three = board({ float: 60, pb: 1, vola: 9, pe: null, ni: -1, own: null });
  assert.equal(boardFlags(three).hit, 3);
  assert.ok(boardFlags(three).speculative);
});

test('a single fund holding a twentieth of a company is the concentration test', () => {
  const at5 = boardFlags(board({ cap: 100e9, own: { top: [{ v: 5e9 }] } }));
  assert.ok(at5.flags.some((f) => f.id === 'concentrated'));
  assert.equal(at5.flags.find((f) => f.id === 'concentrated').value, 5);
  const under = boardFlags(board({ cap: 100e9, own: { top: [{ v: 4.9e9 }] } }));
  assert.ok(!under.flags.some((f) => f.id === 'concentrated'));
  // No fund holds it at all: the test cannot run, and is not counted either way.
  const none = boardFlags(board({ own: null }));
  assert.equal(none.tested, 5);
});

test('no earnings means a loss OR a price that is a century of profit', () => {
  const loss = boardFlags(board({ pe: null, ni: -5 }));
  assert.ok(loss.flags.some((f) => f.id === 'noEarnings'));
  const dear = boardFlags(board({ pe: 140, ni: 1e6 }));
  assert.ok(dear.flags.some((f) => f.id === 'noEarnings'));
  const ordinary = boardFlags(board({ pe: 12, ni: 1e6 }));
  assert.ok(!ordinary.flags.some((f) => f.id === 'noEarnings'));
  // A profitable company with a stated P/E is judged on the P/E, not the profit.
  assert.equal(boardFlags(board({ pe: 12, ni: -5 })).flags.some((f) => f.id === 'noEarnings'), false);
});

test('the index summary carries the flags only for listings that meet the bar', () => {
  assert.deepEqual(boardSummary(board()).f,
    ['runUp', 'thinFloat', 'concentrated', 'noEarnings', 'richBook', 'violent']);
  assert.equal(boardSummary(board()).of, 6);
  assert.equal(boardSummary(board({ r: { m3: 1, y1: 1 } })), null, 'nothing to publish');
  assert.equal(boardSummary({ kind: 'etf' }), null);
});

test('a fund\'s speculative weight is measured against its equity, not its whole self', () => {
  const flagged = new Set(['TAHTA', 'OTHER']);
  const held = new Map([['TAHTA', 20], ['OTHER', 10], ['SAFE', 5]]);
  const out = speculativeExposure(held, flagged);
  assert.equal(out.w, 30, 'thirty per cent of the portfolio');
  assert.equal(out.equity, 35);
  // 30 of 35 is 86% of what the fund holds in shares — the figure a manager
  // would be asked about, and a very different sentence from "30% of the fund".
  assert.equal(out.ofEquity, 85.71);
  assert.deepEqual(out.codes, [['TAHTA', 20], ['OTHER', 10]], 'largest first');
});

test('holding shares and none of them flagged is an answer; holding no shares is not', () => {
  // Zero is a real result and has to be one, or the "holds none" filter would
  // have no way to tell a fund that avoided these companies from a fund nobody
  // could read.
  const clean = speculativeExposure(new Map([['SAFE', 90]]), new Set(['TAHTA']));
  assert.equal(clean.w, 0);
  assert.equal(clean.equity, 90);
  assert.equal(clean.ofEquity, 0);
  assert.deepEqual(clean.codes, []);

  // No equity at all cannot be cleared of anything.
  assert.equal(speculativeExposure(new Map(), new Set(['TAHTA'])), null);
  assert.equal(speculativeExposure(null, new Set(['TAHTA'])), null);
  // A closed position files at zero weight and is not a holding.
  assert.equal(speculativeExposure(new Map([['TAHTA', 0]]), new Set(['TAHTA'])), null);
});
