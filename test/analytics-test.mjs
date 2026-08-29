import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TAX_DEFAULTS, PEER_GROUPS, FACTORS, LAGGED_FACTORS,
  taxBucket, taxRateFor, taxRatesFor, afterTax,
  isHsyf, HSYF_MARK, peerGroupOf, riskBand, stanceOf, leverageOf,
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
  priceOn, priceEntryOn, returnSince, positionOf, portfolioTotals,
  cashOver, cashAlternative, portfolioMix,
  portfolioSlices, portfolioDayMove, SLICE_MAX,
  trending, TREND_SIZE, MIN_TREND_MEMBERS,
  lookThrough, concentrationOf, sharedAcross,
  xirr, portfolioXirr, feeDrag, taxIfSold, lotAges, LOT_YEAR,
  hitRate, consistency, HIT_STEP, MIN_HIT_WINDOWS,
  sinceVisit, newSince, VISIT_MIN_DAYS,
  correlationOf, correlationMatrix, MIN_CORRELATION_DAYS, CORRELATION_HIGH,
} from '../analytics.js';
import { HORIZONS, SPEC_STEPS, bestIndexes, aggregateHoldings } from '../core.js';

const fund = (over = {}) => ({
  c: 'AAA', n: 'TEST FONU', k: 'YAT', cat: null, f: 'TEST PORTFÖY',
  d: '2026-08-14', p: 1, sz: 5e9, iv: 1000,
  g: { cash: 100 }, r: {}, vol: 2, mdd: -1, ...over,
});

// ---------------------------------------------------------------- tax

test('the designation is read from the official title, never inferred', () => {
  // TEFAS states it in the fund's own name, and that is the source.
  assert.equal(isHsyf({ n: 'PUSULA PORTFÖY HİSSE SENEDİ FONU (HİSSE SENEDİ YOĞUN FON)' }), true);
  assert.equal(isHsyf({ n: 'TERA PORTFÖY HİSSE SENEDİ (TL) FONU (HİSSE SENEDİ YOĞUN FON)' }), true);
  // An equity fund by name is not a designated one. AFA is 96.9% equity — all
  // of it American — and carries no designation.
  assert.equal(isHsyf({ n: 'AK PORTFÖY AMERİKA YABANCI HİSSE SENEDİ FONU' }), false);
  assert.equal(isHsyf({ n: 'TERA PORTFÖY BİRİNCİ SERBEST FON' }), false);
  assert.equal(isHsyf({}), false);
  assert.equal(isHsyf(null), false);
});

test('the marker survives the spacing and casing filings actually use', () => {
  // The Turkish dotted İ does not fold onto i under /i, so it is matched
  // explicitly — the same trap the holdings classifier documents.
  assert.ok(HSYF_MARK.test('X (HİSSE SENEDİ YOĞUN FON)'));
  assert.ok(HSYF_MARK.test('X (Hisse Senedi Yoğun Fon)'));
  assert.ok(HSYF_MARK.test('X (HISSE SENEDI YOGUN FON)'));
  assert.ok(HSYF_MARK.test('X  (HİSSE  SENEDİ  YOĞUN  FON)'));
  assert.ok(!HSYF_MARK.test('HİSSE SENEDİ ŞEMSİYE FONU'));
});

test('a designated fund is exempt with no holding period at all', () => {
  const hsyf = fund({ n: 'X (HİSSE SENEDİ YOĞUN FON)' });
  // Bought this morning, sold this afternoon: still untaxed. Requiring a year
  // here was the bug, and it billed funds that owe nothing.
  assert.equal(taxBucket(hsyf), 'exempt');
  assert.equal(taxRateFor(hsyf), 0);
  assert.equal(taxBucket(fund({ n: 'X SERBEST FON' })), 'standard');
  assert.equal(taxRateFor(fund({ n: 'X SERBEST FON' })), TAX_DEFAULTS.standard);
});

test('afterTax leaves losses alone', () => {
  assert.equal(afterTax(100, 0.1), 90);
  assert.equal(afterTax(-20, 0.1), -20, 'a loss is not taxed');
  assert.equal(afterTax(0, 0.1), 0);
  assert.equal(afterTax(null, 0.1), null);
});

test('taxRateFor honours user overrides', () => {
  const f = fund({ n: 'X SERBEST FON' });
  assert.equal(taxRateFor(f), TAX_DEFAULTS.standard);
  assert.equal(taxRateFor(f, { ...TAX_DEFAULTS, standard: 0.25 }), 0.25);
  // A flat override is flat: it applies to the exempt bucket too, because
  // somebody who typed one knows their own situation better than we do.
  assert.equal(taxRateFor(fund({ n: 'X (HİSSE SENEDİ YOĞUN FON)' }), taxRatesFor('0.1')), 0.1);
});

test('two rates exist and nothing in between', () => {
  assert.deepEqual(Object.keys(TAX_DEFAULTS).sort(), ['exempt', 'standard']);
  assert.equal(TAX_DEFAULTS.exempt, 0);
  assert.equal(TAX_DEFAULTS.standard, 0.175);
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
  // Over a year a qualifying fund is exempt; the money-market hurdle never is,
  // because it holds no Borsa Istanbul equity.
  const winner = scoreFund(fund({ n: 'X (HİSSE SENEDİ YOĞUN FON)', r: { y1: 60 }, vol: 20 }), ctx);
  assert.equal(winner.taxRate, 0);
  assert.equal(winner.net, 60);
  assert.ok(winner.excess > 20 && winner.excess < 22, `excess ${winner.excess}`);

  const loser = scoreFund(fund({ n: 'X (HİSSE SENEDİ YOĞUN FON)', r: { y1: 28 }, vol: 20 }), ctx);
  assert.ok(loser.excess < 0, 'underperforming cash must score negative');
  assert.equal(scoreFund(fund({ r: {} }), ctx), null);
});

test('scoreFund floors volatility so tiny risk cannot fake a huge ratio', () => {
  const ctx = { cashReturn: 40, taxRates: { exempt: 0, standard: 0 } };
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
  // A stale bucket would sit in meta.taxDefaults implying a rate nothing uses.
  for (const f of [{ n: 'X (HİSSE SENEDİ YOĞUN FON)' }, { n: 'X SERBEST FON' }, {}]) {
    assert.ok(Object.keys(TAX_DEFAULTS).includes(taxBucket(fund(f))));
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
    taxRates: { exempt: 0, standard: 0 },
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
    { fund: 'AAA', value: 100e6, shares: 1e6, weight: 5, prev: 4, expected: 4.4 },
    { fund: 'BBB', value: 300e6, shares: 3e6, weight: 2, prev: 3, expected: 3.3 },
    { fund: 'CCC', value: 50e6, shares: 0.5e6, weight: 1, prev: 1, expected: 1 },
  ], { shares: 100e6, cap: 10e9 });

  assert.equal(own.funds, 3);
  assert.equal(own.value, 450e6);
  assert.equal(own.shares, 4.5e6);
  assert.equal(own.pctShares, 4.5, 'share counts against the exchange listing');
  assert.equal(own.pctCap, 4.5, 'and lira against market value, which should agree');
  assert.equal(own.adding, 1, 'AAA is above where the market would have left it');
  assert.equal(own.trimming, 1, 'BBB is below it');
  assert.equal(own.compared, 3, 'a position that did not move is still compared');
  assert.equal(own.top[0].c, 'BBB', 'largest holder first, by lira not by weight');
  assert.equal(own.top[0].m, -1.3, 'and its move against the baseline, in points');
});

test('a weight the price carried up on its own is not a purchase', () => {
  // The whole reason the baseline exists. Both funds ended the month at 6% from
  // 5%, but the share outran one fund and lagged the other. Counting the raw
  // weight change would call both of them buyers, and did: it made "the funds
  // are buying" correlate 0.78 with the share's own return over the window.
  const own = ownership([
    { fund: 'RODE', value: 10e6, weight: 6, prev: 5, expected: 6.5 },
    { fund: 'BOUGHT', value: 10e6, weight: 6, prev: 5, expected: 5.2 },
  ], {});
  assert.equal(own.compared, 2);
  assert.equal(own.adding, 1, 'only the one that beat the drift');
  assert.equal(own.trimming, 1, 'the other let its exposure fall behind');
  const rode = own.top.find((t) => t.c === 'RODE');
  assert.ok(rode.m < 0, 'a rising weight can still be a retreat');
});

test('a holder with no baseline casts no vote', () => {
  // A blank previous weight is a filer leaving a column empty, and a missing
  // price series is a share we cannot follow. Neither is a position opened this
  // month, and reading them that way would have everything bought by everybody.
  const own = ownership([
    { fund: 'AAA', value: 100e6, weight: 5, prev: null, expected: null },
    { fund: 'BBB', value: 100e6, weight: 5, prev: 4, expected: 4 },
  ], {});
  assert.equal(own.funds, 2, 'both still count as holders');
  assert.equal(own.compared, 1, 'only one can be compared');
  assert.equal(own.adding, 1);
  assert.equal(own.trimming, 0);
  assert.equal(own.top[0].m, null, 'and the uncomparable one shows no move');
});

test('a position opened during the window is bought outright', () => {
  // Nothing grown by anything is still nothing, so the baseline is zero and
  // every point of the new weight is a decision.
  const own = ownership([{ fund: 'AAA', value: 10e6, weight: 3, prev: 0, expected: 0 }], {});
  assert.equal(own.compared, 1);
  assert.equal(own.adding, 1);
  assert.equal(own.top[0].m, 3);
});

test('an impossible weight move is a filing error, not a trade', () => {
  // A real filing gave last month's ASELS weight as 2,070,000%, which carries
  // straight through into the baseline. A position cannot move further than the
  // whole portfolio, so the move is dropped — the fund is still a holder, it
  // just casts no vote on direction.
  const own = ownership([
    { fund: 'AED', value: 10e6, weight: 6.72, prev: 2070000, expected: 2070000 },
    { fund: 'BBB', value: 10e6, weight: 5, prev: 4, expected: 4 },
  ], {});
  assert.equal(own.funds, 2);
  assert.equal(own.compared, 1);
  assert.equal(own.trimming, 0, 'the nonsense does not read as the biggest sale in history');
  assert.equal(own.top.find((t) => t.c === 'AED').m, null);
});

test('a fund that sold out is a departure, not a holder', () => {
  // The row survives the sale, at zero, because some filers leave it there. It
  // was being counted as a holder: ASELS read 196 when one of them had gone.
  const own = ownership([
    { fund: 'STAY', value: 100e6, shares: 1e6, weight: 5, prev: 4, expected: 4 },
    { fund: 'GONE', value: 0, shares: 0, weight: 0, prev: 6, expected: 6, left: true },
  ], { shares: 10e6, cap: 1e9 });
  assert.equal(own.funds, 1, 'one fund holds it');
  assert.equal(own.left, 1, 'and one has walked away');
  assert.equal(own.value, 100e6, 'the departure brings no lira with it');
  assert.equal(own.shares, 1e6);
  assert.equal(own.compared, 1, 'nor does it cast a vote on direction');
  assert.deepEqual(own.top.map((t) => t.c), ['STAY'], 'and it is not in the table');
});

test('a share everybody has left still answers, and says so', () => {
  const own = ownership([
    { fund: 'GONE', value: 0, weight: 0, prev: 6, expected: 6, left: true },
  ], {});
  assert.equal(own.funds, 0, 'nobody holds it');
  assert.equal(own.left, 1);
  assert.equal(own.value, 0);
});

test('positions opened during the window are counted apart', () => {
  const own = ownership([
    { fund: 'NEW', value: 10e6, weight: 3, prev: 0, expected: 0, opened: true },
    { fund: 'OLD', value: 10e6, weight: 3, prev: 2, expected: 2.5 },
  ], {});
  assert.equal(own.opened, 1);
  assert.equal(own.funds, 2, 'both hold it now');
  assert.equal(own.adding, 2, 'and both added to it');
});

test('a share count in two snapshots beats working back from weights', () => {
  // The weight baseline says this fund retreated: it ended at 6% where drift
  // alone would have carried it to 6.5%. The share count says it bought. The
  // share count is a measurement and the baseline is an inference, so the
  // measurement wins — and the reader is told how much of the count came from
  // where.
  const own = ownership([
    {
      fund: 'AAA', value: 100e6, shares: 1.4e6, sharesBefore: 1e6,
      weight: 6, prev: 5, expected: 6.5,
    },
  ], {});
  assert.equal(own.compared, 1);
  assert.equal(own.measured, 1, 'settled by counting shares');
  assert.equal(own.adding, 1, 'it bought 400,000 shares, whatever the weight did');
  assert.equal(own.trimming, 0);
  // The per-fund column stays in weight points, because that is what it is.
  assert.equal(own.top[0].m, -0.5);
});

test('without a snapshot the inference still answers', () => {
  const own = ownership([
    { fund: 'AAA', value: 100e6, shares: 1.4e6, weight: 6, prev: 5, expected: 6.5 },
  ], {});
  assert.equal(own.compared, 1);
  assert.equal(own.measured, 0, 'nothing was measured');
  assert.equal(own.trimming, 1, 'and the baseline gets the casting vote');
});

test('a share count that did not move is not a purchase', () => {
  const own = ownership([
    {
      fund: 'AAA', value: 100e6, shares: 1e6, sharesBefore: 1e6,
      weight: 9, prev: 5, expected: 5.2,
    },
  ], {});
  assert.equal(own.measured, 1);
  assert.equal(own.adding, 0, 'the weight nearly doubled and not one share moved');
  assert.equal(own.trimming, 0);
  assert.equal(own.compared, 1, 'standing still is still an answer');
});

test('a position at zero that nothing says was ever held is not a holder', () => {
  // Filings carry rows like this. It is not a holder, and it is not a departure
  // either — there is no evidence it ever held anything, so it should move no
  // number on the page.
  const own = ownership([
    { fund: 'REAL', value: 50e6, shares: 1e6, weight: 4, prev: 4, expected: 4 },
    { fund: 'PHANTOM', value: 0, shares: 0, weight: 0, prev: null, expected: null },
  ], { shares: 10e6 });
  assert.equal(own.funds, 1);
  assert.equal(own.left, 0, 'no evidence of a departure is not a departure');
  assert.equal(own.value, 50e6);
  assert.equal(own.pctShares, 10);
});

test('a share nothing is known about answers nothing', () => {
  assert.equal(ownership([{ fund: 'PHANTOM', value: 0, weight: 0 }], {}), null);
  assert.equal(ownership([], {}), null);
});

test('fund money is apportioned by how much of the fund the share is', () => {
  const own = ownership([
    // A tenth of this fund, and ₺1bn came in: ₺100m of it is downstream of here.
    { fund: 'BIG', value: 100e6, weight: 10, prev: 10, expected: 10, flow: 1e9 },
    // Half of a smaller fund that lost ₺40m.
    { fund: 'SMALL', value: 20e6, weight: 50, prev: 50, expected: 50, flow: -40e6 },
  ], {});
  assert.equal(own.flow30, 100e6 - 20e6);
  assert.equal(own.flowFrom, 2);
});

test('a flow nobody can read is null, not zero', () => {
  // Zero would say the money stood still, which is a finding. This is silence.
  const own = ownership([{ fund: 'A', value: 10e6, weight: 5, flow: null }], {});
  assert.equal(own.flow30, null);
  assert.equal(own.flowFrom, 0);
});

test('the flow says how many holders it could be read from', () => {
  // Two of forty is a figure that means very little, and the page can say so.
  const own = ownership([
    { fund: 'A', value: 10e6, weight: 5, flow: 1e9 },
    { fund: 'B', value: 10e6, weight: 5, flow: null },
    { fund: 'C', value: 10e6, weight: 5 },
  ], {});
  assert.equal(own.funds, 3);
  assert.equal(own.flowFrom, 1);
  assert.equal(own.flow30, 50e6);
});

test('a fund that has left carries none of its money with it', () => {
  const own = ownership([
    { fund: 'STAY', value: 10e6, weight: 5, flow: 1e9 },
    { fund: 'GONE', value: 0, weight: 0, prev: 5, left: true, flow: -9e9 },
  ], {});
  assert.equal(own.flow30, 50e6, 'the departure is not a holder and not a flow');
  assert.equal(own.left, 1);
});

test('a holder list is cut to the holders worth reading', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    fund: `F${i}`, value: (40 - i) * 1e6, weight: 1, prev: 1, expected: 1,
  }));
  const own = ownership(many, {});
  assert.equal(own.funds, 40, 'all of them are counted');
  assert.equal(own.top.length, TOP_HOLDERS, 'and the tail is left off the table');
  assert.equal(own.top[0].c, 'F0');
});

test('the move guard is the size of the whole portfolio', () => {
  const at = ownership([
    { fund: 'A', value: 1e6, weight: MAX_WEIGHT_MOVE, prev: 0, expected: 0 },
  ], {});
  assert.equal(at.compared, 1, 'a position that went from nothing to everything is possible');
  const past = ownership([
    { fund: 'A', value: 1e6, weight: MAX_WEIGHT_MOVE + 1, prev: 0, expected: 0 },
  ], {});
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

test('margin collateral is not a position two funds can share', () => {
  // Every fund that trades futures posts collateral, so counting it makes any
  // two of them look alike for owning a margin account.
  const seen = [
    'VIOP NAKIT TEMINATI',
    'VİOP NAKİT TEMİNAT İŞLEMLERİ',
    'VİOP NAKİT TEMİNAT',
    'VIOP USD NAKIT TEMINATI',
    'YURTDIŞI FUTURES USD NAKIT TEMINATI',
    'OPSP NAKIT TEMINATI',
    'OTC USD NAKIT TEMINATI',
  ];
  for (const group of seen) {
    assert.deepEqual(
      weightsOf([{ code: 'X', weight: 5, group }, { code: 'ASELS', weight: 3 }]),
      { ASELS: 3 },
      group
    );
  }

  // The code these are filed under is not dependable — one spelling files them
  // as "TRY", which without this rule matches every other fund doing the same
  // and reports a shared position in a currency neither of them holds.
  assert.deepEqual(
    overlapOf(
      weightsOf([{ code: 'TRY', weight: 12, group: 'VİOP NAKİT TEMİNAT İŞLEMLERİ' }]),
      weightsOf([{ code: 'TRY', weight: 9, group: 'VİOP NAKİT TEMİNAT İŞLEMLERİ' }])
    ),
    0
  );

  // A future is a real exposure and is filed under a group that does not claim
  // to be collateral; two funds long the same contract do hold the same thing.
  assert.deepEqual(
    weightsOf([{ code: 'F_XAUTRYM0826', weight: 10.39, group: 'VİOP İŞLEMLERİ' }]),
    { F_XAUTRYM0826: 10.39 }
  );

  // Rows arrive in two shapes. `aggregateHoldings` puts our own bucket id in
  // `group` and keeps the filer's wording in `filedGroup`, so reading `group`
  // alone sees "derivatives" and lets the collateral back in — while matching
  // "derivatives" would take the real futures with it.
  const aggregated = aggregateHoldings([
    { code: 'VIOP Nakit Teminatı', weight: 8.31, group: 'VIOP NAKIT TEMINATI' },
    { code: 'F_XAUTRYM0826', weight: 10.39, group: 'VİOP İŞLEMLERİ' },
  ]);
  assert.equal(aggregated.every((r) => r.group === 'derivatives'), true, 'same bucket');
  assert.deepEqual(weightsOf(aggregated), { F_XAUTRYM0826: 10.39 });
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
  // The short shape: an empty holdings list already says `ofEquity` is 0, and
  // 397 clean funds carrying the long one is 21KB on the file the site boots on.
  assert.deepEqual(clean, { w: 0, equity: 90 });

  // No equity at all cannot be cleared of anything.
  assert.equal(speculativeExposure(new Map(), new Set(['TAHTA'])), null);
  assert.equal(speculativeExposure(null, new Set(['TAHTA'])), null);
  // A closed position files at zero weight and is not a holding.
  assert.equal(speculativeExposure(new Map([['TAHTA', 0]]), new Set(['TAHTA'])), null);
});

test('a holding too small to round to a weight is still a holding', () => {
  // The one case where `w` and `codes` disagree, and the reason nothing decides
  // "holds none" off `w`: the fund page would list TAHTA while the filter called
  // the fund clean.
  const out = speculativeExposure(new Map([['TAHTA', 0.004], ['SAFE', 90]]), new Set(['TAHTA']));
  assert.equal(out.w, 0, 'two decimals cannot show it');
  assert.deepEqual(out.codes, [['TAHTA', 0]], 'and it is held all the same');
});

test('the heavy threshold is one of the filter steps', () => {
  // core.js imports nothing, so SPEC_STEPS repeats this number rather than
  // importing it. Drift would leave the filter offering a step that no longer
  // matches the panel it was meant to find, with nothing else failing.
  assert.ok(SPEC_STEPS.includes(SPECULATIVE_HEAVY),
    `SPEC_STEPS ${SPEC_STEPS} must offer SPECULATIVE_HEAVY (${SPECULATIVE_HEAVY})`);
});

// ---------------------------------------------------------------- positions

const SERIES = [
  ['2026-06-01', 10],
  ['2026-06-02', 11],
  ['2026-06-05', 12],
  ['2026-06-08', 15],
];

test('a price is read on the date, or the last one before it', () => {
  assert.deepEqual(priceEntryOn(SERIES, '2026-06-02'), ['2026-06-02', 11]);
  // Starred on a Saturday: the price that was standing is Friday's, and the
  // entry says so, because a page that prints "since Saturday" over Friday's
  // number is stating a figure against a day it was not measured from.
  assert.deepEqual(priceEntryOn(SERIES, '2026-06-04'), ['2026-06-02', 11]);
  assert.equal(priceOn(SERIES, '2026-06-04'), 11);
  // Before the series begins there is nothing to measure from, and the earliest
  // price on file would silently measure the wrong window.
  assert.equal(priceEntryOn(SERIES, '2026-05-01'), null);
  assert.equal(priceOn(SERIES, null), null);
  assert.equal(priceOn([], '2026-06-02'), null);
});

test('a gap in the series does not become a missing price', () => {
  const gappy = [['2026-06-01', 10], ['2026-06-02', null], ['2026-06-03', 12]];
  assert.deepEqual(priceEntryOn(gappy, '2026-06-02'), ['2026-06-01', 10],
    'a day the fund did not publish falls back to the one that did');
});

test('a return needs both ends and a base to divide by', () => {
  assert.equal(returnSince(15, 10), 50);
  assert.equal(returnSince(9, 10), -10);
  assert.equal(returnSince(10, 0), null, 'nothing grows out of zero');
  assert.equal(returnSince(10, null), null);
  assert.equal(returnSince(null, 10), null);
});

/** The price on a past day, the way the page hands it in. */
const on = (prices) => (iso) => prices[iso] ?? null;

test('a buy with no price is valued from the price on its own day', () => {
  const p = positionOf([{ units: 100, at: '2026-06-02' }], 15, on({ '2026-06-02': 11 }));
  assert.equal(p.value, 1500);
  assert.equal(p.basis, 1100);
  assert.equal(p.profit, 400);
  assert.equal(p.pct, 36.36);
  assert.ok(p.assumed, 'and the page has to say that is what it did');
});

test('a stated price is used in preference to the assumed one', () => {
  const p = positionOf([{ units: 100, price: 12, at: '2026-06-02' }], 15, on({ '2026-06-02': 11 }));
  assert.equal(p.basis, 1200);
  assert.equal(p.profit, 300);
  assert.equal(p.assumed, false);
});

test('two buys at two prices average out', () => {
  // The example everybody has: ten at ₺100 yesterday, twenty at ₺90 today.
  // Thirty units at ₺93.33 — not the last price paid, and not the mean of the two.
  const p = positionOf([
    { units: 10, price: 100, at: '2026-08-25' },
    { units: 20, price: 90, at: '2026-08-26' },
  ], 95);
  assert.equal(p.units, 30);
  assert.equal(p.basis, 2800);
  assert.equal(Math.round(p.avg * 100) / 100, 93.33);
  assert.equal(p.value, 2850);
  assert.equal(p.profit, 50);
  assert.equal(p.buys, 2);
  assert.equal(p.at, '2026-08-25', 'measured from the first of them');
});

test('the size of a lot can be corrected without restating what it cost', () => {
  // The reason the lot stores a unit price and not a total: doubling the size
  // doubles the basis and leaves the price paid alone.
  const ten = positionOf([{ units: 10, price: 100, at: '2026-08-25' }], 95);
  const twenty = positionOf([{ units: 20, price: 100, at: '2026-08-25' }], 95);
  assert.equal(ten.avg, 100);
  assert.equal(twenty.avg, 100);
  assert.equal(twenty.basis, 2 * ten.basis);
});

test('a sale takes units off at the average and leaves the average alone', () => {
  // Selling some of something does not change what the rest of it cost you.
  const p = positionOf([
    { units: 10, price: 100, at: '2026-08-25' },
    { units: 20, price: 90, at: '2026-08-26' },
    { units: -12, price: 100, at: '2026-08-27' },
  ], 95);
  assert.equal(p.units, 18);
  assert.equal(Math.round(p.avg * 100) / 100, 93.33, 'unchanged by the sale');
  assert.equal(p.basis, 1680, '18 units of a ₺93.33 average');
  // Sold 12 that had cost 1120 for 1200.
  assert.equal(p.realised, 80);
  assert.equal(p.value, 1710);
  assert.equal(p.profit, 30, 'and the unrealised half is only about what is left');
});

test('lots are read in date order however they were entered', () => {
  // A sale can only come out of what had been bought by the time it happened,
  // so entering yesterday's buy after today's sale must not change the answer.
  const ordered = positionOf([
    { units: 10, price: 100, at: '2026-08-25' },
    { units: -10, price: 120, at: '2026-08-26' },
  ], 95);
  const shuffled = positionOf([
    { units: -10, price: 120, at: '2026-08-26' },
    { units: 10, price: 100, at: '2026-08-25' },
  ], 95);
  assert.deepEqual(shuffled, ordered);
  assert.equal(ordered.units, 0, 'sold out');
  assert.equal(ordered.realised, 200);
});

test('selling more than is held is clamped, not a short position', () => {
  const p = positionOf([
    { units: 10, price: 100, at: '2026-08-25' },
    { units: -25, price: 100, at: '2026-08-26' },
  ], 95);
  assert.equal(p.units, 0, 'you cannot sell what you never had');
  // Only the ten that existed went through, at the price they went at.
  assert.equal(p.realised, 0);
});

test('a sale with no price recorded cannot report what it made', () => {
  const p = positionOf([
    { units: 10, price: 100, at: '2026-08-25' },
    { units: -5, at: '2026-08-26' },
  ], 95);
  assert.equal(p.units, 5);
  assert.equal(p.basis, 500, 'the units still leave at what they cost');
  assert.equal(p.realised, null, 'but what they sold for is not something to invent');
});

test('one unanswerable lot leaves the whole position without a basis', () => {
  // An average missing a third of what was paid is not an average, it is a
  // wrong number — so the position reports value and no cost at all.
  const p = positionOf([
    { units: 100, price: 10, at: '2026-06-02' },
    { units: 100, at: '2020-01-01' },
  ], 15, on({ '2026-06-02': 11 }));
  assert.equal(p.units, 200);
  assert.equal(p.value, 3000);
  assert.equal(p.basis, null);
  assert.equal(p.avg, null);
  assert.equal(p.profit, null);
  assert.equal(p.pct, null);
});

test('a position without a size is not a position', () => {
  assert.equal(positionOf([], 15), null);
  assert.equal(positionOf(null, 15), null);
  assert.equal(positionOf([{ at: '2026-06-02' }], 15), null);
  assert.equal(positionOf([{ units: 0 }], 15), null);
});

test('no price is no value, but the lots are still a holding', () => {
  const p = positionOf([{ units: 100, price: 10, at: '2026-06-02' }], null);
  assert.equal(p.units, 100);
  assert.equal(p.basis, 1000);
  assert.equal(p.value, null, 'nothing to mark it against');
  assert.equal(p.profit, null);
});

test('the totals count value over everything and profit only over what has a basis', () => {
  const totals = portfolioTotals([
    { value: 1500, basis: 1100 },
    { value: 500, basis: null },
    { value: 300, basis: 300 },
    null,
  ]);
  assert.equal(totals.value, 2300, 'the unpriced-cost holding is still money you hold');
  assert.equal(totals.basis, 1400);
  assert.equal(totals.profit, 400);
  assert.equal(totals.priced, 3);
  assert.equal(totals.costed, 2, 'so the page can say one was left out of the profit');
  assert.equal(portfolioTotals([]), null);
});

test('the cash alternative is money-weighted over each position\'s own window', () => {
  const mmf = [['2026-06-01', 100], ['2026-06-02', 101], ['2026-06-08', 110]];
  // One position opened on the 1st (cash +10%), one on the 2nd (+8.91%).
  const out = cashAlternative([
    { basis: 1000, from: '2026-06-01' },
    { basis: 1000, from: '2026-06-02' },
  ], mmf);
  assert.equal(out.counted, 2);
  // Not 10%: the second position only had cash from the 2nd, and taking the
  // earliest date for the whole portfolio would credit it with a week it never
  // had.
  assert.ok(out.pct > 9.4 && out.pct < 9.5, `got ${out.pct}`);
  // 1000 grown at 10% plus 1000 grown at 8.91% — the sum, not the average.
  assert.equal(Math.round(out.value), 2189);
  assert.equal(cashAlternative([{ basis: null, from: '2026-06-01' }], mmf), null);
  assert.equal(cashAlternative([], mmf), null);
});

test('the portfolio mix is weighted by lira, not by holding count', () => {
  const out = portfolioMix([
    { value: 9000, groups: { equity: 100 } },
    { value: 1000, groups: { cash: 100 } },
  ]);
  // Equal-weighted this would read 50/50, which is the whole reason entering
  // the sizes is worth doing.
  assert.equal(out.mix.equity, 90);
  assert.equal(out.mix.cash, 10);
  assert.equal(out.counted, 10000);
  assert.equal(portfolioMix([{ value: 0, groups: { equity: 100 } }]), null);
  assert.equal(portfolioMix([]), null);
});

// ---------------------------------------------------------------- the ring

test('the ring is drawn from what each holding is worth, largest first', () => {
  const out = portfolioSlices([
    { code: 'SMALL', value: 1000 },
    { code: 'BIG', value: 7000 },
    { code: 'MID', value: 2000 },
  ]);
  assert.deepEqual(out.slices.map((s) => s.code), ['BIG', 'MID', 'SMALL']);
  assert.deepEqual(out.slices.map((s) => s.share), [70, 20, 10]);
  assert.equal(out.total, 10000);
  assert.equal(out.of, 3);
});

test('a starred fund with no size entered is not part of what you hold', () => {
  // It belongs on the page — it answers "what has this done since I starred it"
  // — but giving it a slice would be inventing money.
  const out = portfolioSlices([
    { code: 'HELD', value: 500 },
    { code: 'WATCHED', value: null },
    { code: 'ZERO', value: 0 },
  ]);
  assert.deepEqual(out.slices.map((s) => s.code), ['HELD']);
  assert.equal(out.of, 1);
  assert.equal(portfolioSlices([{ code: 'WATCHED', value: null }]), null);
  assert.equal(portfolioSlices([]), null);
  assert.equal(portfolioSlices(null), null);
});

test('the tail past the palette becomes one slice that says how many', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ code: `F${i}`, value: 100 - i }));
  const out = portfolioSlices(many);
  assert.equal(out.slices.length, SLICE_MAX, 'never more slices than colours');
  const last = out.slices.at(-1);
  assert.equal(last.code, null);
  assert.equal(last.rest, 20 - (SLICE_MAX - 1), 'and it says how many are in it');
  // The tail is the rest of the money, not a leftover: the shares still total
  // the whole portfolio.
  const sum = out.slices.reduce((a, s) => a + s.value, 0);
  assert.equal(Math.round(sum), Math.round(out.total));
  assert.ok(Math.abs(out.slices.reduce((a, s) => a + s.share, 0) - 100) < 0.05);
});

test('exactly a ringful of holdings is not collected into "others"', () => {
  const eight = Array.from({ length: SLICE_MAX }, (_, i) => ({ code: `F${i}`, value: 10 }));
  const out = portfolioSlices(eight);
  assert.equal(out.slices.length, SLICE_MAX);
  assert.ok(out.slices.every((s) => s.code && !s.rest), 'all eight keep their names');
});

test("the day's move runs backwards, from today's value to yesterday's", () => {
  // ₺102 after a 2% day gained ₺2, not ₺2.04. Taking 2% of today's value is the
  // easy mistake and it overstates every green day.
  const out = portfolioDayMove([{ value: 102, change: 2 }]);
  assert.equal(out.gain, 2);
  assert.equal(out.pct, 2);
  assert.equal(out.covered, 102);
});

test("the day's move is weighted by money, not by position", () => {
  const out = portfolioDayMove([
    { value: 9000, change: 1 },
    { value: 1000, change: -1 },
  ]);
  // 9000/1.01 + 1000/0.99 = 8910.89 + 1010.10 = 9920.99 at the last close.
  assert.equal(out.pct, 0.8);
  assert.equal(out.gain, 79.01);
});

test('a position nobody could price is left out of the move, not counted as flat', () => {
  const out = portfolioDayMove([
    { value: 100, change: 5 },
    { value: 900, change: null },
  ]);
  assert.equal(out.pct, 5, 'the move is over what could be measured');
  assert.equal(out.covered, 100);
  assert.equal(out.of, 1000, 'and the page is told how much that leaves out');
  assert.equal(out.counted, 1);
});

test('nothing priceable is no move at all, rather than zero', () => {
  assert.equal(portfolioDayMove([{ value: 100, change: null }]), null);
  assert.equal(portfolioDayMove([]), null);
  assert.equal(portfolioDayMove(null), null);
  // A price of zero has no previous value to divide by; past it is bad data
  // rather than a very bad day.
  assert.equal(portfolioDayMove([{ value: 100, change: -100 }]), null);
  assert.equal(portfolioDayMove([{ value: 100, change: -120 }]), null);
});

test('a flat day is a real answer and says so', () => {
  const out = portfolioDayMove([{ value: 100, change: 0 }]);
  assert.equal(out.pct, 0);
  assert.equal(out.gain, 0);
  assert.equal(out.counted, 1);
});

// ---------------------------------------------------------------- trending

/** A listing that trades: cap, a week's move, and enough turnover to count. */
const listing = (over = {}) => ({
  c: 'AAAA', n: 'A COMPANY', kind: 'stock', th: 'tech',
  cap: 10e9, p: 100, avgVol: 1e6, r: { w1: 1 }, ...over,
});

test('a sector is cap-weighted, so no one listing carries it', () => {
  // A tiny company up 100% and a huge one flat is a flat sector, not a sector
  // up fifty per cent.
  const out = trending([
    listing({ c: 'BIG', cap: 99e9, r: { w1: 0 } }),
    listing({ c: 'SMALL', cap: 1e9, r: { w1: 100 } }),
    listing({ c: 'MID', cap: 1e9, r: { w1: 0 } }),
  ]);
  assert.equal(out.sectors.length, 1);
  assert.equal(out.sectors[0].id, 'tech');
  assert.equal(out.sectors[0].of, 3);
  assert.ok(out.sectors[0].move < 2, `cap-weighted, got ${out.sectors[0].move}`);
});

test('a theme too small to average is not published as a sector', () => {
  const two = Array.from({ length: MIN_TREND_MEMBERS - 1 }, (_, i) =>
    listing({ c: `T${i}`, th: 'semis' }));
  const enough = Array.from({ length: MIN_TREND_MEMBERS }, (_, i) =>
    listing({ c: `E${i}`, th: 'banks' }));
  const out = trending([...two, ...enough]);
  assert.deepEqual(out.sectors.map((s) => s.id), ['banks'],
    'one company wearing a sector name is not a sector average');
});

test('the share half runs over what actually trades', () => {
  // The biggest movers on the whole exchange are its smallest listings, walked
  // to their limit on a few thousand lira. This is that listing.
  const out = trending([
    listing({ c: 'GHOST', avgVol: 1, r: { w1: 90 } }),
    listing({ c: 'REALA', avgVol: 1e6, r: { w1: 20 } }),
    listing({ c: 'REALB', avgVol: 1e6, r: { w1: 10 } }),
    listing({ c: 'REALC', avgVol: 1e6, r: { w1: 5 } }),
  ]);
  assert.ok(!out.shares.some((s) => s.c === 'GHOST'), 'the untraded one is out');
  assert.deepEqual(out.shares.map((s) => s.c), ['REALA', 'REALB', 'REALC'],
    'and the rest are ranked on the move, not on the volume that let them in');
  assert.equal(out.of, 3, 'so the page can say how many it ranked over');
});

test('only what is actually up is trending', () => {
  // A week the whole market fell: the least bad company is not trending, and a
  // green heading over a red list would be the panel lying about its subject.
  const out = trending([
    listing({ c: 'LESSBAD', r: { w1: -1 } }),
    listing({ c: 'BAD', r: { w1: -12 } }),
    listing({ c: 'WORSE', r: { w1: -20 } }),
  ]);
  assert.deepEqual(out.shares, []);
  assert.ok(out.sectors[0].move < 0, 'the sector still reports the fall');
});

test('the speculative flag travels with the share', () => {
  // A list of what is running is exactly where a name running for the wrong
  // reasons turns up, and this site says elsewhere which those are.
  const out = trending([
    listing({ c: 'FLAGGED', r: { w1: 30 }, spec: { f: ['runUp'], of: 6 } }),
    listing({ c: 'PLAIN', r: { w1: 20 } }),
  ]);
  assert.equal(out.shares[0].c, 'FLAGGED');
  assert.equal(out.shares[0].spec, 1, 'carried through as a marker, not the whole scan');
  assert.equal(out.shares[1].spec, undefined);
});

test('trending never returns more shares than it was asked for', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    listing({ c: `S${i}`, r: { w1: 40 - i } }));
  assert.equal(trending(many).shares.length, TREND_SIZE);
  assert.equal(trending(many, 'w1', 3).shares.length, 3);
});

test('nothing to rank is null, not an empty answer', () => {
  assert.equal(trending([]), null);
  assert.equal(trending(null), null);
  // An exchange-traded fund is not a company and has no sector here.
  assert.equal(trending([listing({ kind: 'etf' })]), null);
  // A listing the index carries no weekly return for cannot be ranked on one.
  assert.equal(trending([listing({ r: {} })]), null);
});

test('the window is an argument, so the panel can name what it read', () => {
  const out = trending([
    listing({ c: 'AAAA', r: { w1: 1, m1: 50 } }),
    listing({ c: 'BBBB', r: { w1: 9, m1: 2 } }),
    listing({ c: 'CCCC', r: { w1: 5, m1: 8 } }),
  ], 'm1');
  assert.equal(out.over, 'm1');
  assert.deepEqual(out.shares.map((s) => s.c), ['AAAA', 'CCCC', 'BBBB']);
});

// ---------------------------------------------------------------- look-through

/** A filed position, aggregated as the holdings table leaves it. */
const held = (code, weight, over = {}) => ({
  code, isin: null, ref: null, name: code, weight, rows: 1, group: 'equityTr', ...over,
});

test('two funds holding the same company report it once, added up', () => {
  const out = lookThrough(
    [{ code: 'AAA', value: 1000 }, { code: 'BBB', value: 1000 }],
    {
      AAA: [held('ASELS', 50), held('THYAO', 50)],
      BBB: [held('ASELS', 20), held('MGROS', 80)],
    }
  );
  // 500 from one fund and 200 from the other. The whole point: neither
  // statement says you own ₺700 of one company.
  const aselsan = out.rows.find((r) => r.code === 'ASELS');
  assert.equal(aselsan.value, 700);
  assert.equal(aselsan.pct, 35);
  assert.deepEqual(aselsan.holders, [{ code: 'AAA', value: 500 }, { code: 'BBB', value: 200 }]);
  // Heaviest first, and nothing is double-counted.
  assert.deepEqual(out.rows.map((r) => r.code), ['MGROS', 'ASELS', 'THYAO']);
  assert.equal(out.rows.reduce((a, r) => a + r.value, 0), 2000);
});

test('a fund with no filing is counted but not looked into', () => {
  const out = lookThrough(
    [{ code: 'AAA', value: 1000 }, { code: 'ZZZ', value: 3000 }],
    { AAA: [held('ASELS', 100)] }
  );
  // ₺3,000 is money you hold, so it is in the total — but the percentages are
  // shares of what could actually be seen into, never of the total. Reporting
  // ASELS as 25% here would be describing a portfolio nobody has.
  assert.equal(out.total, 4000);
  assert.equal(out.covered, 1000);
  assert.equal(out.rows[0].pct, 100);
});

test('nothing to look into at all is null, not an empty answer', () => {
  assert.equal(lookThrough([{ code: 'ZZZ', value: 100 }], {}), null);
  assert.equal(lookThrough([], { AAA: [held('ASELS', 100)] }), null);
  assert.equal(lookThrough(null, null), null);
  // A position with no size is not a holding.
  assert.equal(lookThrough([{ code: 'AAA', value: 0 }], { AAA: [held('ASELS', 100)] }), null);
});

test('a share bought directly pools with the same company held through a fund', () => {
  const out = lookThrough(
    [{ code: 'AAA', value: 1000 }, { code: 'ASELS', value: 500, share: true }],
    { AAA: [held('ASELS', 40), held('THYAO', 60)] }
  );
  const aselsan = out.rows.find((r) => r.code === 'ASELS');
  assert.equal(aselsan.value, 900);
  assert.deepEqual(aselsan.holders.map((h) => h.code), ['ASELS', 'AAA']);
  // The share needed no filing to be seen into: it is already the thing the
  // funds are being reduced to.
  assert.equal(out.covered, 1500);
});

test('a fund inside a fund is followed, not reported as a unit', () => {
  const out = lookThrough(
    [{ code: 'AAA', value: 1000 }],
    {
      AAA: [held('BBB', 50, { group: 'funds', ref: 'BBB' }), held('THYAO', 50)],
      BBB: [held('ASELS', 100)],
    }
  );
  // "You own 50% of a fund" answers nothing; ₺500 of ASELS does.
  assert.deepEqual(out.rows.map((r) => r.code).sort(), ['ASELS', 'THYAO']);
  assert.equal(out.rows.find((r) => r.code === 'ASELS').value, 500);
  assert.equal(out.nested, 500);
});

test('a fund inside a fund that never filed stays the position it is', () => {
  const out = lookThrough(
    [{ code: 'AAA', value: 1000 }],
    { AAA: [held('ZZZ', 50, { group: 'funds', ref: 'ZZZ' }), held('THYAO', 50)] }
  );
  // Honest rather than tidy: a fund nobody filed for really is what you own.
  assert.equal(out.rows.find((r) => r.code === 'ZZZ').value, 500);
  assert.equal(out.nested, 0);
});

test('funds holding each other terminate instead of spending forever', () => {
  const out = lookThrough(
    [{ code: 'AAA', value: 1000 }],
    {
      AAA: [held('BBB', 100, { group: 'funds', ref: 'BBB' })],
      BBB: [held('AAA', 100, { group: 'funds', ref: 'AAA' })],
    }
  );
  // The cycle guard stops it, and what is left is the unit it could not follow.
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].value, 1000);
});

test('a holding with neither ISIN nor code is a residual, never matched by name', () => {
  const out = lookThrough(
    [{ code: 'AAA', value: 1000 }, { code: 'BBB', value: 1000 }],
    {
      AAA: [held(null, 40, { name: 'HAZİNE VE MALİYE BAKANLIĞI' }), held('ASELS', 60)],
      BBB: [held(null, 40, { name: 'HAZİNE VE MALİYE BAKANLIĞI' }), held('ASELS', 60)],
    }
  );
  // Pooling these two by name is exactly what the overlap panel refuses to do,
  // and for the same reason: two managers' spellings are not an identity.
  assert.equal(out.unidentified, 800);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].code, 'ASELS');
  // The residual is why the rows do not add up to the covered total.
  assert.equal(out.covered, 2000);
});

test('the same company under two spellings keeps the unsplit one', () => {
  const out = lookThrough(
    [{ code: 'AAA', value: 1000 }, { code: 'BBB', value: 1000 }],
    {
      // A position split over three lines is where the extractor mis-assigns a
      // name — this one carries a neighbouring company's, and it is longer.
      AAA: [held('ASELS', 100, { rows: 3, name: 'ATP TİCARİ BİLGİSAYAR AĞI VE ELEKTRİK' })],
      BBB: [held('ASELS', 100, { rows: 1, name: 'ASELSAN A.Ş.' })],
    }
  );
  assert.equal(out.rows[0].name, 'ASELSAN A.Ş.');
});

test('a share you hold yourself pools with the same one inside your funds', () => {
  // Funds file TERA with an ISIN; a share bought directly has only the ticker.
  // Keyed separately they produced two rows for one company — the exact
  // opposite of what this panel is for.
  const out = lookThrough(
    [{ code: 'AAA', value: 1000 }, { code: 'TERA', value: 5000, share: true }],
    { AAA: [held('TERA', 100, { isin: 'TRETERA00013' })] }
  );
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].value, 6000);
  assert.deepEqual(out.rows[0].holders.map((h) => h.code), ['TERA', 'AAA']);
});

test('a messy code and a clean one meet on the ISIN', () => {
  // Filers mark a pledged position in front of the ticker. One filing pairing
  // that code with an ISIN is enough to pull every spelling onto it.
  const out = lookThrough(
    [{ code: 'AAA', value: 1000 }, { code: 'BBB', value: 1000 }],
    {
      AAA: [held('SASA', 100, { isin: 'TRASASAW91Q1' })],
      BBB: [held('SASA', 100, { isin: 'TRASASAW91Q1' })],
    }
  );
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].value, 2000);
  // A code nothing ever paired with an ISIN still stands on its own.
  const lone = lookThrough(
    [{ code: 'AAA', value: 1000 }],
    { AAA: [held('MYSTERY', 100)] }
  );
  assert.equal(lone.rows[0].key, 'MYSTERY');
});

test('an ISIN and a ticker for the same holding are one position', () => {
  const out = lookThrough(
    [{ code: 'AAA', value: 1000 }, { code: 'BBB', value: 1000 }],
    {
      AAA: [held('ASELS', 100, { isin: 'TRAASELS91H2' })],
      BBB: [held('ASELS', 100, { isin: 'TRAASELS91H2' })],
    }
  );
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].value, 2000);
});

test('concentration is published as a count of equal positions, not an index', () => {
  // Four equal holdings are four; the Herfindahl 2,500 says the same thing and
  // says it to nobody.
  assert.equal(concentrationOf([
    { value: 25 }, { value: 25 }, { value: 25 }, { value: 25 },
  ]).effective, 4);
  assert.equal(concentrationOf([
    { value: 25 }, { value: 25 }, { value: 25 }, { value: 25 },
  ]).hhi, 2500);
  // Thirty holdings that are really one bet come back as roughly one.
  const lopsided = [{ value: 970 }, ...Array.from({ length: 29 }, () => ({ value: 1 }))];
  assert.ok(concentrationOf(lopsided).effective < 1.1);
  assert.deepEqual(concentrationOf([]), { hhi: null, effective: null });
});

test('the equity concentration is counted apart from the bonds', () => {
  const out = lookThrough(
    [{ code: 'AAA', value: 1000 }],
    {
      AAA: [
        held('ASELS', 10), held('THYAO', 10),
        held('TRT010328T12', 80, { group: 'debt' }),
      ],
    }
  );
  // Forty government bonds are not a diversified portfolio in any sense worth
  // printing, and averaging them in hides how many companies you are betting on.
  assert.equal(out.equity.count, 2);
  assert.equal(out.equity.value, 200);
  assert.equal(out.equity.effective, 2);
  // Against everything, the bond dominates.
  assert.ok(out.effective < 1.6);
  // A portfolio holding no shares at all reports no equity block rather than a
  // zero, which would read as "no concentration".
  assert.equal(lookThrough([{ code: 'AAA', value: 100 }],
    { AAA: [held('TRT010328T12', 100, { group: 'debt' })] }).equity, null);
});

// ---------------------------------------------------------------- comparing

test('positions held by more than one fund come out ordered by how many', () => {
  const out = sharedAcross({
    AAA: { ASELS: 10, THYAO: 5, MGROS: 30 },
    BBB: { ASELS: 4, THYAO: 6 },
    CCC: { ASELS: 1, SASA: 40 },
  });
  // Three funds can overlap little pair by pair and still be the same names —
  // which is what the pairwise figure cannot say and this list can.
  assert.deepEqual(out.map((r) => r.code), ['ASELS', 'THYAO']);
  assert.equal(out[0].held, 3);
  assert.equal(out[0].total, 15);
  assert.deepEqual(out[0].weights, { AAA: 10, BBB: 4, CCC: 1 });
  // MGROS is 30% of one fund and still not shared, so it is not on the list.
  assert.ok(!out.some((r) => r.code === 'MGROS'));
});

test('a position in only one fund is not shared, and min is honoured', () => {
  const weights = { AAA: { X: 5, Y: 5 }, BBB: { X: 5 }, CCC: { X: 5 } };
  assert.deepEqual(sharedAcross(weights).map((r) => r.code), ['X']);
  // "Held by all three" is a different question from "held by two of them".
  assert.deepEqual(sharedAcross(weights, { min: 3 }).map((r) => r.code), ['X']);
  assert.deepEqual(sharedAcross(weights, { min: 4 }), []);
});

test('comparing needs at least two funds to compare', () => {
  assert.deepEqual(sharedAcross({ AAA: { X: 5 } }), []);
  assert.deepEqual(sharedAcross({}), []);
  assert.deepEqual(sharedAcross(null), []);
  // A fund whose filing could not be read is not a fund for this purpose.
  assert.deepEqual(sharedAcross({ AAA: { X: 5 }, BBB: null }), []);
});

test('ties are ordered by weight, and the list has a ceiling', () => {
  const a = {};
  const b = {};
  for (let i = 0; i < 30; i++) { a[`S${i}`] = i + 1; b[`S${i}`] = i + 1; }
  const out = sharedAcross({ A: a, B: b });
  assert.equal(out.length, 12);
  // Everything is held by both, so weight breaks the tie: the heaviest first.
  assert.equal(out[0].code, 'S29');
  assert.equal(out[0].total, 60);
});

test('the best figure in a row is a set, because a tie is a real answer', () => {
  // Marking one of two equally cheap funds the winner invents a difference.
  assert.deepEqual([...bestIndexes([1.2, 0.8, 0.8], 'low')], [1, 2]);
  assert.deepEqual([...bestIndexes([10, 40, 25], 'high')], [1]);
  // A drawdown is negative, so 'high' is the shallower loss.
  assert.deepEqual([...bestIndexes([-22, -4, -13], 'high')], [1]);
});

test('a measure with no better direction marks nothing', () => {
  // A unit price, a fund's size, an investor count, a volatility: defaulting
  // these to "highest wins" would tick the biggest fund as though bigger were a
  // result. It did exactly that until the compare page was drawn and read.
  assert.deepEqual([...bestIndexes([1.27, 1.76, 1.64], null)], []);
  assert.deepEqual([...bestIndexes([14, 24.8, 26], undefined)], []);
  assert.deepEqual([...bestIndexes([1, 2, 3], 'biggest')], []);
});

test('nothing is marked best when there is nothing to compare', () => {
  // Every fund tying is not a comparison.
  assert.deepEqual([...bestIndexes([5, 5, 5])], []);
  // One usable value among nulls: highlighting it says nothing.
  assert.deepEqual([...bestIndexes([null, 3, undefined])], []);
  assert.deepEqual([...bestIndexes([])], []);
  assert.deepEqual([...bestIndexes(null)], []);
  // A missing figure never wins, and never blocks the fund that has one.
  assert.deepEqual([...bestIndexes([null, 3, 9], 'high')], [2]);
  assert.deepEqual([...bestIndexes([NaN, 1, 2], 'low')], [1]);
});


// ---------------------------------------------------------------- xirr

test('a rate of return is what it says on the tin', () => {
  assert.equal(xirr([{ at: '2025-01-01', amount: -1000 }, { at: '2026-01-01', amount: 1100 }]), 10);
  assert.equal(xirr([{ at: '2025-01-01', amount: -1000 }, { at: '2026-01-01', amount: 2000 }]), 100);
  // Doubling in six months annualises to a little over 300%, not to 200%.
  assert.equal(
    xirr([{ at: '2025-01-01', amount: -1000 }, { at: '2025-07-02', amount: 2000 }]), 301.53);
});

test('the useful range runs far past where Newton stays stable', () => {
  // This market really does print years like it, so the bisection fallback is
  // load-bearing rather than decorative.
  assert.equal(xirr([{ at: '2025-01-01', amount: -1000 }, { at: '2026-01-01', amount: 7840 }]), 684);
  // And the other end: an almost total loss is a rate, not a failure.
  assert.equal(xirr([{ at: '2025-01-01', amount: -1000 }, { at: '2026-01-01', amount: 1 }]), -99.9);
});

test('money that went in at two different times is weighted by how long it was in', () => {
  // ₺1,000 in for a year and ₺1,000 in for a month, worth ₺2,200 at the end.
  // Value over cost says 10%. That is not the rate the money earned, because
  // half of it was only there for a month.
  const rate = xirr([
    { at: '2025-01-01', amount: -1000 },
    { at: '2025-12-01', amount: -1000 },
    { at: '2026-01-01', amount: 2200 },
  ]);
  assert.ok(rate > 18 && rate < 20, `got ${rate}`);
});

test('a question with no answer gets null, not a number', () => {
  // Money in and never out: there is no return until the closing value is a flow.
  assert.equal(xirr([{ at: '2025-01-01', amount: -1000 }]), null);
  assert.equal(xirr([{ at: '2025-01-01', amount: -1000 }, { at: '2025-06-01', amount: -500 }]), null);
  // In and back out the same afternoon — no period to annualise over.
  assert.equal(xirr([{ at: '2025-01-01', amount: -1000 }, { at: '2025-01-01', amount: 1100 }]), null);
  assert.equal(xirr([]), null);
  assert.equal(xirr(null), null);
  // Unparseable dates and zero amounts are not flows.
  assert.equal(xirr([{ at: 'whenever', amount: -1000 }, { at: '2026-01-01', amount: 1100 }]), null);
  assert.equal(xirr([{ at: '2025-01-01', amount: 0 }, { at: '2026-01-01', amount: 1100 }]), null);
});

test('a sale needs no special case', () => {
  // `units` is negative on a sale and `price` is what it sold at, so one
  // expression covers both directions.
  const out = portfolioXirr([{
    code: 'AAA',
    lots: [
      { at: '2025-01-01', units: 100, price: 10 },
      { at: '2025-07-01', units: -50, price: 12 },
    ],
    value: 700,
  }], '2026-01-01');
  assert.equal(out.counted, 1);
  assert.ok(out.pct > 0, `got ${out.pct}`);
});

test('a position is counted only when every lot carries a price', () => {
  const out = portfolioXirr([
    { code: 'AAA', lots: [{ at: '2025-01-01', units: 100, price: 10 }], value: 1200 },
    // Half a position's cost is not a cost.
    { code: 'BBB', lots: [
      { at: '2025-01-01', units: 100, price: 10 },
      { at: '2025-06-01', units: 50 },
    ], value: 2000 },
    { code: 'CCC', lots: [], value: 500 },
  ], '2026-01-01');
  assert.equal(out.counted, 1);
  assert.equal(out.of, 3);
  assert.equal(out.value, 1200);
  assert.equal(out.pct, 20);
  // Nothing priceable at all is null rather than a rate over an empty set.
  assert.equal(portfolioXirr([{ code: 'X', lots: [], value: 1 }], '2026-01-01'), null);
  assert.equal(portfolioXirr([], '2026-01-01'), null);
});

// ---------------------------------------------------------------- fee drag

test('the fee is charged against the mean of what you paid and what you hold', () => {
  // ₺1,000 grown to ₺2,000 over a year at 2%: the fee ran on a value that moved,
  // so it is 2% of ₺1,500, not of either end.
  const out = feeDrag([
    { code: 'AAA', basis: 1000, value: 2000, from: '2025-01-01', rate: 2 },
  ], '2026-01-01');
  assert.equal(out.total, 30);
  assert.equal(out.rows[0].years, 1);
  // With no basis there is nothing to average, so today's value stands.
  const bare = feeDrag([
    { code: 'AAA', value: 2000, from: '2025-01-01', rate: 2 },
  ], '2026-01-01');
  assert.equal(bare.total, 40);
});

test('a fund with no published fee is skipped, never assumed cheap', () => {
  const out = feeDrag([
    { code: 'AAA', basis: 1000, value: 1000, from: '2025-01-01', rate: 1 },
    { code: 'BBB', basis: 1000, value: 1000, from: '2025-01-01', rate: null },
    { code: 'CCC', basis: 1000, value: 1000, from: '2025-01-01', rate: 0 },
  ], '2026-01-01');
  assert.equal(out.counted, 1);
  assert.equal(out.of, 3);
  assert.equal(out.total, 10);
});

test('the fee list is heaviest first, and a position bought today has paid none', () => {
  const out = feeDrag([
    { code: 'SMALL', basis: 100, value: 100, from: '2025-01-01', rate: 1 },
    { code: 'BIG', basis: 10000, value: 10000, from: '2025-01-01', rate: 1 },
    { code: 'TODAY', basis: 5000, value: 5000, from: '2026-01-01', rate: 3 },
  ], '2026-01-01');
  assert.deepEqual(out.rows.map((r) => r.code), ['BIG', 'SMALL']);
  assert.equal(out.counted, 2);
  assert.equal(feeDrag([], '2026-01-01'), null);
  assert.equal(feeDrag([{ code: 'A', value: 1, from: '2025-01-01', rate: 1 }], 'whenever'), null);
});


// ---------------------------------------------------------------- tax if sold

const taxable = (over = {}) => ({ n: 'X SERBEST FON', ...over });

test('withholding follows the designation, and nothing else', () => {
  const out = taxIfSold([
    // Designated, bought yesterday: nothing due, because there is no period.
    { code: 'NEW', fund: { n: 'A (HİSSE SENEDİ YOĞUN FON)' }, value: 12000, basis: 10000 },
    { code: 'OLD', fund: { n: 'B (HİSSE SENEDİ YOĞUN FON)' }, value: 12000, basis: 10000 },
    { code: 'ST', fund: taxable(), value: 13000, basis: 10000 },
  ]);
  assert.deepEqual(out.rows.map((r) => [r.code, r.tax]),
    [['ST', 525], ['NEW', 0], ['OLD', 0]]);
  assert.equal(out.gain, 7000);
  assert.equal(out.tax, 525);
  assert.equal(out.net, 6475);
});

test('a loss is not taxed and does not quietly cancel another position gain', () => {
  const out = taxIfSold([
    { code: 'UP', fund: taxable(), value: 13000, basis: 10000 },
    { code: 'DOWN', fund: taxable(), value: 8000, basis: 10000 },
  ]);
  // Whether a loss can be set against a gain depends on the holder's whole year,
  // which a page about four funds does not know. ₺300 is due on the position
  // that is up, and netting them to ₺100 would understate it.
  assert.equal(out.tax, 525);
  assert.equal(out.gain, 1000);
  assert.equal(out.rows.find((r) => r.code === 'DOWN').tax, 0);
});

test('a position with no basis has no known gain and is left out', () => {
  const out = taxIfSold([
    { code: 'AAA', fund: taxable(), value: 13000, basis: 10000 },
    { code: 'BBB', fund: taxable(), value: 5000, basis: null },
    // A share is not a fund and carries none of these rates. Assuming it exempt
    // would be a claim; saying nothing about it is not.
    { code: 'ASELS', fund: null, value: 4000, basis: 3000 },
  ]);
  assert.equal(out.counted, 1);
  assert.equal(out.of, 3);
  assert.equal(taxIfSold([]), null);
  assert.equal(taxIfSold(null), null);
});

test('a flat override applies to every bucket, as the control promises', () => {
  const out = taxIfSold([
    { code: 'EQ', fund: { n: 'X (HİSSE SENEDİ YOĞUN FON)' }, value: 12000, basis: 10000 },
  ], taxRatesFor('0.15'));
  assert.equal(out.tax, 300);
});

// ---------------------------------------------------------------- lot ages

test('a lot knows how long it has been held and when it turns a year', () => {
  const out = lotAges([
    { at: '2025-01-01', units: 10 },
    { at: '2026-06-01', units: 5 },
  ], '2026-08-28');
  // Oldest first: the one nearest any threshold is the one worth seeing.
  assert.deepEqual(out.map((r) => r.at), ['2025-01-01', '2026-06-01']);
  assert.equal(out[0].days, 604);
  assert.equal(out[0].past, true);
  // Null once it has turned, so a date in the past can never be printed as
  // something still to wait for.
  assert.equal(out[0].on, null);
  assert.equal(out[1].past, false);
  assert.equal(out[1].on, '2027-06-01');
});

test('a sale is not a holding and has no age', () => {
  const out = lotAges([
    { at: '2025-01-01', units: 10 },
    { at: '2026-02-01', units: -3 },
  ], '2026-08-28');
  assert.equal(out.length, 1);
  assert.equal(lotAges([], '2026-08-28').length, 0);
  assert.equal(lotAges([{ at: '2025-01-01', units: 10 }], 'whenever').length, 0);
});

test('the year the ages are measured against is an argument, not a rule', () => {
  const lots = [{ at: '2026-01-01', units: 10 }];
  assert.equal(lotAges(lots, '2026-08-28')[0].past, false);
  assert.equal(lotAges(lots, '2026-08-28', { year: 180 })[0].past, true);
  assert.equal(LOT_YEAR, 365);
});


// ---------------------------------------------------------------- consistency

/** A daily series growing at a fixed rate per day, from a fixed start. */
const ramp = (days, perDay, from = '2025-01-01') => {
  const t0 = Date.parse(from);
  const out = [];
  for (let i = 0; i < days; i++) {
    out.push([new Date(t0 + i * 86400000).toISOString().slice(0, 10), (1 + perDay) ** i]);
  }
  return out;
};

test('a fund ahead in every window reports every window', () => {
  const out = hitRate(ramp(400, 0.001), ramp(400, 0.0002), { days: 91 });
  assert.equal(out.wins, out.windows);
  assert.equal(out.rate, 100);
  assert.ok(out.windows > 20, `got ${out.windows}`);
  assert.ok(out.median > 0);
  assert.ok(out.worst > 0);
});

test('a fund behind in every window reports none of them', () => {
  const out = hitRate(ramp(400, 0.0002), ramp(400, 0.001), { days: 91 });
  assert.equal(out.wins, 0);
  assert.equal(out.rate, 0);
  assert.ok(out.best < 0);
});

test('window starts are spaced in calendar days, not in rows', () => {
  const out = hitRate(ramp(400, 0.001), ramp(400, 0.0002), { days: 91, step: HIT_STEP });
  // 400 days of history minus a 91-day window, stepped weekly.
  assert.equal(out.windows, Math.floor((400 - 91 - 1) / HIT_STEP) + 1);
  // A wider step is fewer windows over the same history.
  assert.ok(hitRate(ramp(400, 0.001), ramp(400, 0.0002), { days: 91, step: 28 }).windows
    < out.windows);
});

test('a window the benchmark cannot answer for is not a window the fund won', () => {
  // The benchmark stops after 100 days; every window starting past it has no
  // second reading, so `priceOn` carries the last value and the excess collapses
  // — but a window starting before the fund's own history has nothing at all.
  const out = hitRate(ramp(400, 0.001), [], { days: 91 });
  assert.equal(out, null);
  assert.equal(hitRate([], ramp(400, 0.001), { days: 91 }), null);
  assert.equal(hitRate(null, null), null);
});

test('a window longer than the history is no answer at all', () => {
  // Not "100% of one window", which is what a fund with one lucky quarter would
  // otherwise print on its page.
  assert.equal(hitRate(ramp(60, 0.001), ramp(60, 0.0002), { days: 182 }), null);
  assert.equal(hitRate(ramp(400, 0.001), ramp(400, 0.0002), { days: 0 }), null);
});

test('too few windows is not published as a rate', () => {
  const short = ramp(120, 0.001);
  const bench = ramp(120, 0.0002);
  // 120 days leaves a handful of six-month windows and none of them is a record.
  const out = consistency(short, bench);
  for (const window of out ?? []) assert.ok(window.windows >= MIN_HIT_WINDOWS);
  // Nothing long enough at all reports nothing rather than an empty list.
  assert.equal(consistency(ramp(20, 0.001), ramp(20, 0.0002)), null);
  assert.equal(consistency([], []), null);
});

test('the median excess is the median, so one huge fortnight cannot carry it', () => {
  // Eleven windows behind by 1 point and one ahead by 500: the mean says the
  // fund is far ahead, and the median says what actually happened most weeks.
  const out = hitRate(
    [...ramp(300, 0.0001), ['2026-01-01', 1e6]],
    ramp(301, 0.0002),
    { days: 91 });
  assert.ok(out.median < 0, `median was ${out.median}`);
  assert.ok(out.best > 0, `best was ${out.best}`);
});


// ---------------------------------------------------------- since you last looked

test('what your funds did while you were away, as a median', () => {
  const out = sinceVisit([
    { code: 'UP', series: [['2026-08-01', 100], ['2026-08-20', 110]] },
    { code: 'DOWN', series: [['2026-08-01', 100], ['2026-08-20', 95]] },
    { code: 'FLAT', series: [['2026-08-01', 100], ['2026-08-20', 100]] },
  ], '2026-08-01', '2026-08-20');
  assert.equal(out.days, 19);
  assert.equal(out.counted, 3);
  assert.equal(out.median, 0);
  assert.deepEqual(out.best, { code: 'UP', pct: 10 });
  assert.deepEqual(out.worst, { code: 'DOWN', pct: -5 });
});

test('a fund whose history does not reach back cannot answer, and is not flat', () => {
  const out = sinceVisit([
    { code: 'OLD', series: [['2026-08-01', 100], ['2026-08-20', 110]] },
    // Launched after the visit: counting it as flat would drag the median.
    { code: 'NEW', series: [['2026-08-15', 100], ['2026-08-20', 101]] },
  ], '2026-08-01', '2026-08-20');
  assert.equal(out.counted, 1);
  assert.equal(out.median, 10);
});

test('the gap is measured date against date, never against the clock', () => {
  const rows = [{ code: 'A', series: [['2026-08-01', 100], ['2026-08-21', 110]] }];
  // Visiting again on the day you last visited is no gap at all. Comparing
  // midnight on the stored date against the current time made an afternoon
  // reload round to "1 day" and print a panel of zeroes.
  assert.equal(sinceVisit(rows, '2026-08-28', '2026-08-28').days, 0);
  assert.equal(sinceVisit(rows, '2026-08-01', '2026-08-20').days, 19);
  // With no end given, the newest print anybody has is the end.
  assert.equal(sinceVisit(rows, '2026-08-01').days, 20);
});

test('nothing to say is null, not a panel of dashes', () => {
  assert.equal(sinceVisit([], '2026-08-01'), null);
  assert.equal(sinceVisit(null, '2026-08-01'), null);
  assert.equal(sinceVisit([{ code: 'A', series: [] }], '2026-08-01'), null);
  // No previous visit stored, or a corrupt one.
  assert.equal(sinceVisit([{ code: 'A', series: [['2026-08-01', 1]] }], 'whenever'), null);
});

test('a fund younger than the gap did not exist last time', () => {
  const funds = [{ c: 'OLD', age: 400 }, { c: 'NEW', age: 5 }, { c: 'UNKNOWN' }];
  assert.deepEqual(newSince(funds, 19).map((f) => f.c), ['NEW']);
  // Same day: nothing is new, and nothing is claimed to be.
  assert.deepEqual(newSince(funds, 0), []);
  assert.deepEqual(newSince(null, 10), []);
  assert.equal(VISIT_MIN_DAYS, 1);
});


// ---------------------------------------------------------- moving together

/** A daily series from a list of daily returns. */
const walk = (moves, from = '2025-01-01') => {
  const t0 = Date.parse(from);
  const out = [['2024-12-31', 100]];
  let price = 100;
  moves.forEach((m, i) => {
    price *= 1 + m;
    out.push([new Date(t0 + i * 86400000).toISOString().slice(0, 10), price]);
  });
  return out;
};

/**
 * Deterministic pseudo-random daily returns.
 *
 * Not `Math.sin(i * k)`, which was the first attempt: two sine series at
 * different phases are strongly correlated with each other, so the test for
 * INDEPENDENT funds was quietly feeding in a pair at -0.95.
 */
const wobble = (n, seed = 1) => {
  let x = seed * 48271 + 11;
  return Array.from({ length: n }, () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return (x / 2147483648 - 0.5) * 0.02;
  });
};

test('correlation is what it says, and is clamped to its range', () => {
  const a = wobble(60);
  assert.equal(correlationOf(a, a), 1);
  assert.equal(correlationOf(a, a.map((x) => -x)), -1);
  assert.equal(correlationOf(a, a.map((x) => x * 3 + 0.5)), 1);
});

test('a series that never moves has no correlation, not a zero', () => {
  // A money-market fund with a flat week has no variance: the denominator is
  // zero and "undefined" is the honest answer.
  assert.equal(correlationOf([0, 0, 0, 0], [1, 2, 3, 4]), null);
  assert.equal(correlationOf([1], [1]), null);
  assert.equal(correlationOf(null, null), null);
});

test('funds that move together are fewer bets than they are funds', () => {
  const moves = wobble(200);
  const out = correlationMatrix([
    { code: 'AAA', series: walk(moves) },
    { code: 'BBB', series: walk(moves.map((m) => m * 1.5)) },
    { code: 'CCC', series: walk(moves.map((m) => m * 0.8)) },
  ]);
  // Three funds that are the same bet report as one.
  assert.equal(out.average, 1);
  assert.equal(out.effective, 1);
  assert.equal(out.counted, 3);
  assert.equal(out.pairs.length, 3);
});

test('funds that move independently are close to as many bets as funds', () => {
  const out = correlationMatrix([
    { code: 'AAA', series: walk(wobble(200, 1)) },
    { code: 'BBB', series: walk(wobble(200, 40)) },
  ]);
  assert.ok(Math.abs(out.average) < 0.3, `average was ${out.average}`);
  assert.ok(out.effective > 1.5, `effective was ${out.effective}`);
});

test('funds that hedge each other are not MORE bets than there are funds', () => {
  const moves = wobble(200);
  const out = correlationMatrix([
    { code: 'AAA', series: walk(moves) },
    { code: 'BBB', series: walk(moves.map((m) => -m)) },
  ]);
  assert.equal(out.average, -1);
  // The raw equicorrelation formula divides by 1 + (n-1)r, which at r = -1 with
  // two funds is zero-ish and sends the answer to forty. Two funds are at most
  // two bets.
  assert.equal(out.effective, 2);
});

test('only the days both funds printed on are compared', () => {
  const moves = wobble(200);
  const full = walk(moves);
  // Every other day missing. Carrying yesterday's price into the gap would
  // invent a zero return and drag the correlation.
  const sparse = full.filter((_, i) => i % 2 === 0);
  const out = correlationMatrix([
    { code: 'FULL', series: full },
    { code: 'SPARSE', series: sparse },
  ]);
  assert.ok(out.pairs[0].days < full.length / 2 + 2, `compared ${out.pairs[0].days} days`);
});

test('too little shared history is left out rather than reported', () => {
  const short = walk(wobble(10));
  assert.equal(correlationMatrix([
    { code: 'AAA', series: short },
    { code: 'BBB', series: short },
  ]), null);
  // One fund is not a portfolio.
  assert.equal(correlationMatrix([{ code: 'AAA', series: walk(wobble(200)) }]), null);
  assert.equal(correlationMatrix([]), null);
  assert.equal(correlationMatrix(null), null);
  assert.equal(MIN_CORRELATION_DAYS, 30);
  assert.equal(CORRELATION_HIGH, 0.9);
});

test('the count of funds compared is reported against how many were asked about', () => {
  const out = correlationMatrix([
    { code: 'AAA', series: walk(wobble(200, 1)) },
    { code: 'BBB', series: walk(wobble(200, 40)) },
    // No history: cannot be correlated, and is not silently forgotten.
    { code: 'CCC', series: [] },
  ]);
  assert.equal(out.counted, 2);
  assert.equal(out.of, 3);
});
