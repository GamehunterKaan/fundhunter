import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fold, fmtMoney, fmtPct, fmtPoints, fmtInt, parseJsonl, filterFunds, sortFunds, LEVERED_FROM, CRASH_PROOF_FROM, THEME_IDS, MIN_THEME,
  compositionSegments, industryComposition, assetBreakdown,
  returnOver, returnYtd, returnForHorizon, volatility, maxDrawdown, indexSeries,
  alignAndIndex, signOf, HORIZONS, horizonOf, SORTS, STRINGS, LANGS,
  aggregateHoldings, groupHoldings, holdingGroupOf, HOLDING_GROUPS,
  queryMatcher, MATCH,
  squarify,
} from '../core.js';
import { parseLiveQuotes, liveClock } from '../live.js';
import {
  GROUPS, ASSETS, ASSET_CODES, KINDS,
  THEME_INDUSTRIES, THEME_OF_INDUSTRY, THEME_OVERRIDES,
} from '../scripts/lib/taxonomy.mjs';
import { splitRange, weeklyAnchors, ymd } from '../scripts/lib/tefas.mjs';

// ---------------------------------------------------------------- fixtures

const META = {
  groups: GROUPS,
  assets: ASSETS,
  kinds: KINDS,
  categories: [{ tr: 'Para Piyasası Şemsiye Fonu', en: 'Money Market' }],
};

const fund = (over = {}) => ({
  c: 'AAA', n: 'AK PORTFÖY PARA PİYASASI FONU', k: 'YAT',
  cat: 'Para Piyasası Şemsiye Fonu', f: 'AK PORTFÖY',
  d: '2026-08-14', p: 1, sh: 1, iv: 100, sz: 1e9,
  g: { cash: 100 }, t: [], r: {}, ...over,
});

/** Deterministic pseudo-random walk, so volatility tests are reproducible. */
function walk(n, seed = 1, drift = 0.0004, vol = 0.01) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  const out = [];
  let p = 100;
  const start = Date.UTC(2025, 7, 14);
  for (let i = 0; i < n; i++) {
    p *= 1 + drift + rand() * vol;
    out.push([new Date(start + i * 86400000).toISOString().slice(0, 10), p]);
  }
  return out;
}

// ---------------------------------------------------------------- text

test('fold makes Turkish search diacritic-insensitive both ways', () => {
  assert.equal(fold('ŞİŞE'), 'sise');
  assert.equal(fold('sise'), 'sise');
  assert.equal(fold('İŞ PORTFÖY'), 'is portfoy');
  assert.equal(fold('Iğdır'), 'igdir');
  assert.equal(fold(null), '');
});

// ---------------------------------------------------------------- formatting

test('fmtMoney abbreviates Turkish-lira magnitudes', () => {
  assert.match(fmtMoney(216_900_000_000, 'tr'), /216,9 mr/);
  assert.match(fmtMoney(12_400_000_000_000, 'en'), /12\.4 T/);
  assert.equal(fmtMoney(null, 'tr'), '—');
});

test('fmtPct keeps the sign when unsigned, and pairs an arrow when signed', () => {
  // Max drawdown is negative and rendered without `signed` — the minus must
  // survive, and in Turkish it belongs ahead of the percent sign.
  assert.equal(fmtPct(-12.5, 'tr', { digits: 1 }), '-%12,5');
  assert.equal(fmtPct(12.5, 'tr', { digits: 1 }), '%12,5');
  assert.equal(fmtPct(-12.5, 'en', { digits: 1 }), '-12.5%');
  assert.equal(fmtPct(3.25, 'tr', { signed: true, digits: 2 }), '▲ %3,25');
  assert.equal(fmtPct(-3.25, 'en', { signed: true, digits: 2 }), '▼ 3.25%');
  assert.equal(fmtPct(null, 'tr'), '—');
});

test('signOf classifies returns for the colour + glyph pairing', () => {
  assert.equal(signOf(1), 'up');
  assert.equal(signOf(-1), 'down');
  assert.equal(signOf(0), 'flat');
  assert.equal(signOf(null), 'flat');
});

test('fmtInt uses Turkish thousands separators', () => {
  assert.equal(fmtInt(1234567, 'tr'), '1.234.567');
  assert.equal(fmtInt(1234567, 'en'), '1,234,567');
});

// ---------------------------------------------------------------- parsing

test('parseJsonl skips blank and truncated lines rather than failing', () => {
  const rows = parseJsonl('{"d":"a"}\n\n{"d":"b"}\n{"d":"trunc"');
  assert.deepEqual(rows.map((r) => r.d), ['a', 'b']);
  assert.deepEqual(parseJsonl(''), []);
});

// ---------------------------------------------------------------- filtering

test('filterFunds matches code, name and manager', () => {
  const funds = [
    fund({ c: 'AAK', n: 'ATA PORTFÖY HİSSE FONU', f: 'ATA PORTFÖY' }),
    fund({ c: 'TI1', n: 'İŞ PORTFÖY PARA PİYASASI FONU', f: 'İŞ PORTFÖY' }),
  ];
  assert.equal(filterFunds(funds, { search: 'aak' }).length, 1);
  assert.equal(filterFunds(funds, { search: 'is portfoy' }).length, 1);
  assert.equal(filterFunds(funds, { search: 'hisse' })[0].c, 'AAK');
  assert.equal(filterFunds(funds, { search: 'zzz' }).length, 0);
});

test('the leverage filter keeps only funds that hold more than they own', () => {
  const funds = [
    fund({ c: 'LEV', lev: 1.8 }),
    fund({ c: 'BIG', lev: 10.64 }),
    fund({ c: 'FLAT', lev: 1 }),
    // Rounding noise is not borrowing: weights are published to two decimals.
    fund({ c: 'EDGE', lev: LEVERED_FROM }),
    // An unknown composition is not a yes, the same rule the other filters use.
    fund({ c: 'UNKNOWN' }),
  ];
  assert.deepEqual(filterFunds(funds, { levered: true }).map((f) => f.c), ['LEV', 'BIG']);
  // Off by default: the unfiltered list is every fund, levered or not.
  assert.equal(filterFunds(funds, {}).length, 5);
  assert.equal(filterFunds(funds, { levered: false }).length, 5);
});

test('the crash filter keeps only funds that held their value through the falls', () => {
  const funds = [
    fund({ c: 'GAIN', cr: { s: 163, n: 10, of: 10, w: -23.24 } }),
    // Exactly 100 is where the fund's own return crosses zero, so it is in.
    fund({ c: 'EDGE', cr: { s: CRASH_PROOF_FROM, n: 10, of: 10, w: 0 } }),
    // Spared most of the fall, but still lost money doing it.
    fund({ c: 'MOST', cr: { s: 88, n: 10, of: 10, w: -8.2 } }),
    fund({ c: 'INDEX', cr: { s: 0, n: 10, of: 10, w: -18.2 } }),
    // Too young to have been measured, which is not the same as having held up.
    fund({ c: 'YOUNG' }),
  ];
  assert.deepEqual(filterFunds(funds, { crashProof: true }).map((f) => f.c), ['GAIN', 'EDGE']);
  assert.equal(filterFunds(funds, {}).length, 5);
  assert.equal(filterFunds(funds, { crashProof: false }).length, 5);
});

test('sorting by crash protection puts unmeasured funds last', () => {
  const funds = [
    fund({ c: 'MID', cr: { s: 88 } }),
    fund({ c: 'YOUNG' }),
    fund({ c: 'BEST', cr: { s: 163 } }),
    fund({ c: 'WORST', cr: { s: -72 } }),
  ];
  assert.deepEqual(
    sortFunds(funds, 'crash', 'desc').map((f) => f.c),
    ['BEST', 'MID', 'WORST', 'YOUNG']
  );
  // Ascending is "who fell hardest", and an unmeasured fund is not an answer to
  // that either — it leads only because there is nothing to rank it on.
  assert.equal(SORTS.crash(funds[1]), -Infinity);
  assert.equal(SORTS.crash(funds[2]), 163);
});

test('the theme list the UI offers is exactly the one the build can emit', () => {
  // THEME_IDS carries the labels and the display order; THEME_INDUSTRIES is
  // build-only and is what actually classifies a share. A theme in one and not
  // the other is either an unreachable filter option or a weight with no name.
  assert.deepEqual([...THEME_IDS].sort(), Object.keys(THEME_INDUSTRIES).sort());
});

test('no industry is claimed by two themes', () => {
  // The themes are a partition, which is what lets a fund page add them up.
  const seen = new Set();
  for (const [id, industries] of Object.entries(THEME_INDUSTRIES)) {
    for (const industry of industries) {
      assert.equal(seen.has(industry), false, `${industry} is in ${id} and somewhere else`);
      seen.add(industry);
      assert.equal(THEME_OF_INDUSTRY.get(industry), id);
    }
  }
  // The overrides have to name a theme that exists, or a share vanishes.
  for (const [ticker, id] of Object.entries(THEME_OVERRIDES)) {
    assert.ok(THEME_IDS.includes(id), `${ticker} is overridden to unknown theme ${id}`);
  }
});

test('the theme filter asks for a real position, not a mention', () => {
  const funds = [
    fund({ c: 'PURE', th: { defence: 62.9, tech: 12 } }),
    fund({ c: 'INDEX', th: { defence: 10.4, banks: 22 } }),
    fund({ c: 'TRACE', th: { defence: 1.2, banks: 40 } }),
    // No filing could be read for this one, which is not the same as holding none.
    fund({ c: 'UNSEEN' }),
  ];
  assert.deepEqual(filterFunds(funds, { theme: 'defence' }).map((f) => f.c), ['PURE', 'INDEX']);
  assert.deepEqual(filterFunds(funds, { theme: 'defence', minTheme: 50 }).map((f) => f.c), ['PURE']);
  assert.deepEqual(filterFunds(funds, { theme: 'defence', minTheme: 1 }).map((f) => f.c),
    ['PURE', 'INDEX', 'TRACE']);
  assert.equal(filterFunds(funds, { theme: 'tourism' }).length, 0);
  assert.equal(filterFunds(funds, {}).length, 4, 'off by default');
});

test('the default share is a position taken on purpose, not an index weight', () => {
  // ASELS is around a tenth of the BIST 30, so every index tracker clears 10%
  // and the threshold has to be meaningful without excluding them by accident.
  assert.ok(MIN_THEME >= 5 && MIN_THEME <= 25);
  const tracker = fund({ c: 'IDX', th: { defence: 10.4 } });
  assert.equal(filterFunds([tracker], { theme: 'defence' }).length, 1);
});

test('the two languages carry exactly the same set of keys', () => {
  // Adding a string to one language and forgetting the other does not throw —
  // t() falls back — it just renders an English label in the middle of a Turkish
  // page, which nobody notices until a user does.
  const [a, b] = LANGS;
  for (const key of Object.keys(STRINGS[a])) {
    assert.notEqual(STRINGS[b][key], undefined, `${b} is missing ${key}`);
  }
  for (const key of Object.keys(STRINGS[b])) {
    assert.notEqual(STRINGS[a][key], undefined, `${a} is missing ${key}`);
  }
  // Same order too, so the two blocks can be read side by side in a diff.
  assert.deepEqual(Object.keys(STRINGS[a]), Object.keys(STRINGS[b]));
});

test('every theme the build can emit has a label in both languages', () => {
  for (const id of THEME_IDS) {
    const key = `theme${id[0].toUpperCase()}${id.slice(1)}`;
    for (const lang of LANGS) {
      assert.notEqual(STRINGS[lang][key], undefined, `${lang} is missing ${key}`);
    }
  }
});

test('the dividend filter is a floor on what the portfolio yields', () => {
  const funds = [
    fund({ c: 'PAYER', dy: 6.65 }),
    fund({ c: 'MARKET', dy: 1.49 }),
    // Shares that pay nothing is an answer; no filing is not.
    fund({ c: 'ZERO', dy: 0 }),
    fund({ c: 'UNSEEN' }),
  ];
  assert.deepEqual(filterFunds(funds, { minDividend: 2 }).map((f) => f.c), ['PAYER']);
  assert.deepEqual(filterFunds(funds, { minDividend: 1.49 }).map((f) => f.c), ['PAYER', 'MARKET']);
  assert.deepEqual(filterFunds(funds, { minDividend: 0 }).map((f) => f.c), ['PAYER', 'MARKET', 'ZERO']);
  assert.equal(filterFunds(funds, {}).length, 4);
});

test('sorting by dividend puts funds with no filing last', () => {
  const funds = [fund({ c: 'MID', dy: 2 }), fund({ c: 'UNSEEN' }), fund({ c: 'TOP', dy: 6 }),
    fund({ c: 'NONE', dy: 0 })];
  assert.deepEqual(sortFunds(funds, 'dividend', 'desc').map((f) => f.c),
    ['TOP', 'MID', 'NONE', 'UNSEEN']);
});

test('filterFunds combines kind, category and size constraints', () => {
  const funds = [
    fund({ c: 'A', k: 'YAT', sz: 5e9 }),
    fund({ c: 'B', k: 'BYF', sz: 1e6 }),
    fund({ c: 'C', k: 'YAT', sz: 1e6 }),
  ];
  assert.deepEqual(filterFunds(funds, { kinds: ['YAT'] }).map((f) => f.c), ['A', 'C']);
  assert.deepEqual(filterFunds(funds, { minSize: 1e9 }).map((f) => f.c), ['A']);
  assert.deepEqual(
    filterFunds(funds, { kinds: ['YAT'], minSize: 1e9 }).map((f) => f.c), ['A']
  );
});

test('filterFunds exposure threshold selects by what a fund actually holds', () => {
  const funds = [
    fund({ c: 'EQ', g: { equity: 92, cash: 8 } }),
    fund({ c: 'MM', g: { cash: 100 } }),
  ];
  assert.deepEqual(
    filterFunds(funds, { exposure: 'equity', minExposure: 80 }).map((f) => f.c), ['EQ']
  );
  assert.equal(filterFunds(funds, { exposure: 'equity', minExposure: 95 }).length, 0);
});

test('retailOnly drops qualified-investor-only funds', () => {
  const funds = [
    fund({ c: 'RETAIL', risk: 5 }),
    fund({ c: 'PRO', risk: 7 }),
    fund({ c: 'UNRATED', risk: null }),
  ];
  assert.deepEqual(
    filterFunds(funds, { retailOnly: true }).map((f) => f.c),
    ['RETAIL', 'UNRATED']
  );
  assert.equal(filterFunds(funds, {}).length, 3);
});

test('tradeableOnly requires an explicit yes, not merely a non-no', () => {
  // A fund you cannot buy must not top a "worth buying" list, and an unknown
  // platform status is not a yes.
  const funds = [
    fund({ c: 'OPEN', tefas: true }),
    fund({ c: 'CLOSED', tefas: false }),
    fund({ c: 'UNKNOWN', tefas: null }),
  ];
  assert.deepEqual(filterFunds(funds, { tradeableOnly: true }).map((f) => f.c), ['OPEN']);
  assert.equal(filterFunds(funds, {}).length, 3);
});

test('a risk cap excludes unrated funds rather than assuming they are safe', () => {
  const funds = [fund({ c: 'LOW', risk: 2 }), fund({ c: 'NONE', risk: null })];
  assert.deepEqual(filterFunds(funds, { maxRisk: 4 }).map((f) => f.c), ['LOW']);
});

test('cheapest-first sorting puts unknown fees last, not first', () => {
  const funds = [
    fund({ c: 'UNKNOWN', expenseRatio: null }),
    fund({ c: 'PRICEY', expenseRatio: 2.5 }),
    fund({ c: 'CHEAP', expenseRatio: 0.4 }),
  ];
  assert.deepEqual(
    sortFunds(funds, 'fee', 'asc').map((f) => f.c),
    ['CHEAP', 'PRICEY', 'UNKNOWN']
  );
});

test('sortFunds orders by the requested key and is stable on ties', () => {
  const funds = [
    fund({ c: 'B', sz: 100, r: { m1: 5 } }),
    fund({ c: 'A', sz: 100, r: { m1: 9 } }),
    fund({ c: 'C', sz: 300, r: { m1: 1 } }),
  ];
  assert.deepEqual(sortFunds(funds, 'size', 'desc').map((f) => f.c), ['C', 'A', 'B']);
  assert.deepEqual(sortFunds(funds, 'ret1m', 'desc').map((f) => f.c), ['A', 'B', 'C']);
  assert.deepEqual(sortFunds(funds, 'name', 'asc').length, 3);
  // Sorting must not mutate the caller's array.
  assert.equal(funds[0].c, 'B');
});

// ---------------------------------------------------------------- composition

test('compositionSegments normalises weights to fill the bar', () => {
  const { segments, hasNegative } = compositionSegments(
    { equity: 30, cash: 10 }, GROUPS.map((g) => g.id)
  );
  assert.equal(hasNegative, false);
  assert.equal(segments.length, 2);
  assert.equal(Math.round(segments[0].share + segments[1].share), 100);
  assert.equal(segments[0].id, 'equity'); // group order preserved
});

test('compositionSegments drops negative repo but reports it', () => {
  // TEFAS reports negative repo when a fund is borrowing; a stacked bar cannot
  // draw that, so it must be excluded and disclosed.
  const { segments, hasNegative, total } = compositionSegments(
    { equity: 80, cash: -9.4, other: 29.4 }, GROUPS.map((g) => g.id)
  );
  assert.equal(hasNegative, true);
  assert.deepEqual(segments.map((s) => s.id), ['equity', 'other']);
  assert.equal(Math.round(total), 100);
  assert.equal(Math.round(segments.reduce((s, x) => s + x.share, 0)), 100);
});

test('compositionSegments tolerates an empty allocation', () => {
  const { segments, hasNegative } = compositionSegments({}, GROUPS.map((g) => g.id));
  assert.deepEqual(segments, []);
  assert.equal(hasNegative, false);
});

test('industryComposition weights by portfolio size, not fund count', () => {
  const funds = [
    fund({ c: 'BIG', sz: 900, g: { cash: 100 } }),
    fund({ c: 'S1', sz: 50, g: { equity: 100 } }),
    fund({ c: 'S2', sz: 50, g: { equity: 100 } }),
  ];
  const { mix, aum } = industryComposition(funds, GROUPS.map((g) => g.id));
  assert.equal(aum, 1000);
  assert.equal(Math.round(mix.cash), 90);
  assert.equal(Math.round(mix.equity), 10);
});

test('assetBreakdown groups raw TEFAS codes under their asset group', () => {
  const rows = assetBreakdown({ hs: 60, tr: 30, vmtl: 10 }, META, 'tr');
  const equity = rows.find((r) => r.id === 'equity');
  const cash = rows.find((r) => r.id === 'cash');
  assert.equal(equity.total, 60);
  assert.equal(cash.total, 40); // reverse repo + TRY deposit both fold into cash
  assert.equal(rows[0].id, 'equity'); // sorted by weight
  assert.equal(cash.rows.length, 2);
});

// ---------------------------------------------------------------- metrics

test('returnOver measures against the closest earlier point', () => {
  const series = [
    ['2026-01-01', 100],
    ['2026-06-30', 110],
    ['2026-12-31', 132],
  ];
  assert.equal(returnOver(series, 365), 32);
  assert.equal(returnOver(series, 182), 20);
});

test('returnOver refuses to answer when history is too short', () => {
  // Four months of data cannot produce an honest 1-year return.
  const series = [['2026-05-01', 100], ['2026-08-14', 110]];
  assert.equal(returnOver(series, 365), null);
  assert.equal(returnOver([], 30), null);
  assert.equal(returnOver([['2026-08-14', 100]], 30), null);
});

test('volatility annualises daily moves and needs enough data', () => {
  assert.equal(volatility(walk(10)), null, 'too few points');
  const flat = walk(120, 1, 0.0002, 0);
  assert.equal(volatility(flat), 0, 'a flat series has no volatility');
  const choppy = volatility(walk(250, 7, 0.0002, 0.02));
  assert.ok(choppy > 5, `expected meaningful volatility, got ${choppy}`);
});

test('maxDrawdown finds the worst peak-to-trough decline', () => {
  const series = [
    ['2026-01-01', 100],
    ['2026-02-01', 120],
    ['2026-03-01', 60],
    ['2026-04-01', 130],
  ];
  assert.equal(maxDrawdown(series), -50);
  assert.equal(maxDrawdown([['a', 100], ['b', 110]]), 0);
});

test('indexSeries rebases to 100', () => {
  const out = indexSeries([['a', 50], ['b', 75]]);
  assert.deepEqual(out, [['a', 100], ['b', 150]]);
});

test('alignAndIndex puts different scales on one axis', () => {
  // A fund NAV near 3 and an index near 14,000 must become comparable without
  // resorting to a second y-axis.
  const { series, dates } = alignAndIndex({
    fund: [['2026-01-01', 3], ['2026-01-02', 3.3]],
    bist: [['2026-01-01', 14000], ['2026-01-02', 14700]],
  });
  assert.deepEqual(dates, ['2026-01-01', '2026-01-02']);
  assert.equal(series.fund[0][1], 100);
  assert.equal(series.bist[0][1], 100);
  assert.equal(Math.round(series.fund[1][1]), 110);
  assert.equal(Math.round(series.bist[1][1]), 105);
});

test('alignAndIndex carries the last close across a missing day', () => {
  const { series } = alignAndIndex({
    a: [['2026-01-01', 10], ['2026-01-02', 11], ['2026-01-03', 12]],
    b: [['2026-01-01', 100], ['2026-01-03', 120]], // no print on the 2nd
  });
  assert.equal(series.b.length, 3);
  assert.equal(series.b[1][1], 100, 'holiday carries the previous close');
});

test('alignAndIndex rebases every series on one shared date', () => {
  // The benchmark starts a year after the fund. If it were indexed to 100 at its
  // own first point, the two lines would not be comparable at all.
  const { dates, series } = alignAndIndex({
    fund: [['2025-01-01', 10], ['2026-01-01', 20], ['2026-06-01', 30]],
    bench: [['2026-01-01', 500], ['2026-06-01', 600]],
  }, '2025-01-01');

  assert.equal(dates[0], '2026-01-01', 'window starts where both series exist');
  assert.equal(series.fund[0][1], 100);
  assert.equal(series.bench[0][1], 100);
  // Fund doubled over the shared window; benchmark rose 20%.
  assert.equal(Math.round(series.fund.at(-1)[1]), 150);
  assert.equal(Math.round(series.bench.at(-1)[1]), 120);
});

test('alignAndIndex carries a pre-window value in when a series skips the start date', () => {
  const { dates, series } = alignAndIndex({
    fund: [['2026-03-01', 10], ['2026-03-02', 12]],
    bench: [['2026-02-28', 100], ['2026-03-02', 110]], // nothing on 03-01
  });
  assert.equal(dates[0], '2026-03-01');
  assert.equal(series.bench.length, 2, 'benchmark still covers the whole window');
  assert.equal(series.bench[0][1], 100, 'rebased on the carried 02-28 close');
});

// ---------------------------------------------------------------- taxonomy

test('asset groups stay within the validated 8-colour categorical cap', () => {
  assert.equal(GROUPS.length, 8);
  for (const g of GROUPS) {
    assert.match(g.light, /^#[0-9a-f]{6}$/i, `${g.id} needs a light colour`);
    assert.match(g.dark, /^#[0-9a-f]{6}$/i, `${g.id} needs a dark colour`);
    assert.ok(g.tr && g.en, `${g.id} needs both labels`);
  }
  assert.equal(new Set(GROUPS.map((g) => g.light)).size, 8, 'colours must be distinct');
});

test('every asset code maps to a real group and has both labels', () => {
  const ids = new Set(GROUPS.map((g) => g.id));
  for (const [code, a] of Object.entries(ASSETS)) {
    assert.ok(ids.has(a.group), `${code} points at unknown group ${a.group}`);
    assert.ok(a.tr && a.en, `${code} is missing a label`);
  }
  assert.equal(new Set(ASSET_CODES).size, ASSET_CODES.length, 'no duplicate codes');
});

test('fund kinds are limited to the retail-buyable set', () => {
  assert.deepEqual(KINDS.map((k) => k.id), ['YAT', 'BYF']);
});

// ---------------------------------------------------------------- fetch grid

test('chunk boundaries do not move when the range end moves', () => {
  // This is what makes the daily cron cheap: when the trading date rolls over,
  // yesterday's chunks must keep their cache keys so only the newest is fetched.
  const start = new Date('2025-08-14T00:00:00Z');
  const a = splitRange(start, new Date('2026-08-14T00:00:00Z'), 28);
  const b = splitRange(start, new Date('2026-08-17T00:00:00Z'), 28);

  const keys = (chunks) => chunks.map(([s, e]) => `${ymd(s)}-${ymd(e)}`);
  const ka = keys(a);
  const kb = keys(b);
  // Every chunk from the earlier call survives verbatim in the later one.
  for (const k of ka) assert.ok(kb.includes(k), `chunk ${k} shifted between runs`);
  assert.ok(kb.length >= ka.length);
});

test('splitRange covers the whole requested range', () => {
  const start = new Date('2025-08-14T00:00:00Z');
  const end = new Date('2026-08-17T00:00:00Z');
  const chunks = splitRange(start, end, 28);
  assert.ok(chunks[0][0] <= start, 'first chunk must not begin after the range');
  assert.ok(chunks.at(-1)[1] >= end, 'last chunk must not end before the range');
  // Contiguous, no gaps.
  for (let i = 1; i < chunks.length; i++) {
    const gap = (chunks[i][0] - chunks[i - 1][1]) / 86400000;
    assert.equal(Math.round(gap), 1, `gap of ${gap} days before chunk ${i}`);
  }
});

test('weekly anchors are stable and always include the latest date', () => {
  const start = new Date('2025-08-17T00:00:00Z');
  const a = weeklyAnchors(start, new Date('2026-08-14T00:00:00Z')).map(ymd);
  const b = weeklyAnchors(start, new Date('2026-08-17T00:00:00Z')).map(ymd);

  assert.equal(a[0], '20260814', 'the latest date is sampled even mid-week');
  assert.equal(b[0], '20260817');
  // The stable grid anchors are shared; only the leading partial week differs.
  const shared = a.filter((d) => b.includes(d));
  assert.ok(shared.length >= a.length - 2, `only ${shared.length}/${a.length} anchors reused`);
  assert.ok(a.length > 50, `expected ~53 weekly anchors, got ${a.length}`);
});

// ---------------------------------------------------------------- horizons

test('every horizon is wired end to end: label, sort key and sort accessor', () => {
  for (const hz of HORIZONS) {
    const sortString = `sort${hz.sortKey[0].toUpperCase()}${hz.sortKey.slice(1)}`;
    assert.ok(SORTS[hz.sortKey], `${hz.key}: no SORTS accessor named ${hz.sortKey}`);
    for (const lang of LANGS) {
      assert.ok(STRINGS[lang][hz.labelKey], `${lang}: missing string ${hz.labelKey}`);
      assert.ok(STRINGS[lang][sortString], `${lang}: missing string ${sortString}`);
    }
    // The accessor must read the same key the horizon names, or the column and
    // the sort would disagree about what "3 months" means.
    const probe = fund({ r: { [hz.key]: 42 } });
    assert.equal(SORTS[hz.sortKey](probe), 42, `${hz.sortKey} reads the wrong field`);
  }
});

test('horizonOf falls back to the longest window rather than crashing', () => {
  assert.equal(horizonOf('m3').key, 'm3');
  assert.equal(horizonOf('nonsense').key, 'y1');
});

test('year-to-date is measured from the previous year close, not the first print', () => {
  const series = [
    ['2025-12-29', 100],
    ['2025-12-31', 110], // last print of the old year — this is the base
    ['2026-01-02', 121],
    ['2026-06-30', 132],
  ];
  assert.equal(returnYtd(series), 20); // 132 / 110
  assert.equal(returnForHorizon(series, 'ytd'), 20);
});

test('year-to-date for a fund launched inside the year uses its own first print', () => {
  const series = [
    ['2026-02-02', 50],
    ['2026-06-30', 75],
  ];
  assert.equal(returnYtd(series), 50);
  // A single print cannot produce a return.
  assert.equal(returnYtd([['2026-02-02', 50]]), null);
});

// ---------------------------------------------------------------- formatting

test('percentage-point gaps are labelled as points, never as per cent', () => {
  assert.equal(fmtPoints(4.5, 'tr'), '4,5 puan');
  assert.equal(fmtPoints(4.5, 'en'), '4.5 pts');
  assert.equal(fmtPoints(-4.5, 'tr'), '-4,5 puan');
  assert.equal(fmtPoints(-4.5, 'tr', { signed: true }), '▼ 4,5 puan');
  assert.equal(fmtPoints(4.5, 'en', { signed: true }), '▲ 4.5 pts');
  assert.equal(fmtPoints(null, 'tr'), '—');
  // A gap must never render with a percent sign — that is the bug this guards.
  for (const lang of LANGS) assert.ok(!fmtPoints(4.5, lang).includes('%'));
});

// ---------------------------------------------------------------- new filters

test('a fee cap excludes funds whose fee is unknown', () => {
  const funds = [
    fund({ c: 'CHEAP', expenseRatio: 0.9 }),
    fund({ c: 'DEAR', expenseRatio: 2.4 }),
    fund({ c: 'SILENT', expenseRatio: null }),
  ];
  const kept = filterFunds(funds, { maxFee: 1 }).map((f) => f.c);
  assert.deepEqual(kept, ['CHEAP'], 'an unknown fee is not a cheap fee');
});

test('new-fund and stance filters read explicit values only', () => {
  const funds = [
    fund({ c: 'NEW', new: true, stance: 'aggressive' }),
    fund({ c: 'OLD', stance: 'defensive' }),
    fund({ c: 'MEH', new: false, stance: 'balanced' }),
  ];
  assert.deepEqual(filterFunds(funds, { onlyNew: true }).map((f) => f.c), ['NEW']);
  assert.deepEqual(filterFunds(funds, { stance: 'defensive' }).map((f) => f.c), ['OLD']);
});

test('an empty code list means nothing selected, not no restriction', () => {
  const funds = [fund({ c: 'AAA' }), fund({ c: 'BBB' })];
  assert.equal(filterFunds(funds, { codes: [] }).length, 0, 'empty favourites must show nothing');
  assert.deepEqual(filterFunds(funds, { codes: ['BBB'] }).map((f) => f.c), ['BBB']);
  assert.equal(filterFunds(funds, {}).length, 2, 'omitting codes must not filter');
});

// ---------------------------------------------------------------- live quotes

test('parseLiveQuotes maps the feed onto our benchmark keys', () => {
  const out = parseLiveQuotes({
    Update_Date: '2026-08-17 21:55:01',
    USD: { Buying: 47.892, Selling: 47.9044, Change: 0.04 },
    EUR: { Buying: 55.4699, Selling: 55.4831, Change: 0.06 },
    GRA: { Buying: 6786.15, Selling: 6787.07, Change: 0.74 },
    XU100: { Selling: 14132.06, Change: -0.28 },
    GBP: { Buying: 1, Selling: 1, Change: 0 },
  });
  assert.equal(out.updated, '2026-08-17 21:55:01');
  assert.deepEqual(Object.keys(out.quotes).sort(), ['bist100', 'eurtry', 'goldgram', 'usdtry']);
  assert.equal(out.quotes.bist100.price, 14132.06);
  assert.equal(out.quotes.bist100.change, -0.28);
  assert.equal(out.quotes.usdtry.price, 47.9044, 'the ask is the quote');
});

test('parseLiveQuotes refuses junk rather than publishing it as a price', () => {
  assert.equal(parseLiveQuotes(null), null);
  assert.equal(parseLiveQuotes('nope'), null);
  assert.equal(parseLiveQuotes({}), null, 'no recognised fields means no quotes');
  // A zero or negative quote is a broken feed, not a price.
  assert.equal(parseLiveQuotes({ USD: { Selling: 0 } }), null);
  assert.equal(parseLiveQuotes({ USD: { Selling: -3 } }), null);
  assert.equal(parseLiveQuotes({ USD: { Selling: 'abc' } }), null);
});

test('parseLiveQuotes keeps whatever parses when the feed is partial', () => {
  // A missing instrument must not discard the ones that did arrive; the tape
  // falls back to the committed close for that one alone.
  const out = parseLiveQuotes({ USD: { Selling: 47.9 }, XU100: { Selling: null } });
  assert.deepEqual(Object.keys(out.quotes), ['usdtry']);
  assert.equal(out.quotes.usdtry.change, null, 'a missing change is null, not zero');
  assert.equal(out.updated, null, 'a missing stamp is null, not invented');
});

test('liveClock reads the wall time without inventing a timezone', () => {
  assert.equal(liveClock('2026-08-17 21:55:01'), '21:55');
  assert.equal(liveClock('2026-08-17 09:05'), '09:05');
  assert.equal(liveClock('garbage'), null);
  assert.equal(liveClock(null), null);
});

// ---------------------------------------------------------------- holdings

test('a filing is folded into one row per position', () => {
  // Managers split a holding over several lines — a long and a short leg, lots
  // bought on different dates, a slice lent out. TLY files ALKLC twice, ANELE
  // twice, MANAS twice. A table that repeats them is answering a bookkeeping
  // question rather than "what does this fund own".
  const rows = aggregateHoldings([
    { code: 'ALKLC', isin: 'TREALTK00013', weight: 1.87, group: 'HİSSE SENETLERİ', name: 'ALTINKILIÇ' },
    { code: 'ALKLC', isin: 'TREALTK00013', weight: -0.02, group: 'HİSSE SENETLERİ', name: null },
    { code: 'ASELS', isin: 'TRAASELS91H2', weight: 5, group: 'HİSSE SENETLERİ', name: 'ASELSAN' },
  ]);
  assert.equal(rows.length, 2);
  // Heaviest first, and the split legs summed into the fund's real exposure.
  assert.equal(rows[0].code, 'ASELS');
  assert.equal(rows[1].code, 'ALKLC');
  assert.equal(Math.round(rows[1].weight * 100) / 100, 1.85);
  assert.equal(rows[1].rows, 2);
  // Filers fill the name in on one line and leave the others blank, so the
  // longest one wins rather than the last one.
  assert.equal(rows[1].name, 'ALTINKILIÇ');

  // The ISIN identifies a position, not the code: the same holding is written
  // "TUPRS" one month and "TUPRS TRATUPRS91E8" the next.
  const byIsin = aggregateHoldings([
    { code: 'TUPRS', isin: 'TRATUPRS91E8', weight: 2, group: 'HİSSE SENETLERİ' },
    { code: 'TUPRS TRATUPRS91E8', isin: 'TRATUPRS91E8', weight: 3, group: 'HİSSE SENETLERİ' },
  ]);
  assert.equal(byIsin.length, 1);
  assert.equal(byIsin[0].weight, 5);

  assert.deepEqual(aggregateHoldings([]), []);
  assert.deepEqual(aggregateHoldings(null), []);
});

test('prevWeight is taken once per position, never summed over its split rows', () => {
  // It is already the position's total in the data file. Adding it up per row
  // would multiply last month's weight by however many lines the filing used,
  // and the change column would then be nonsense on exactly the positions a
  // manager trades most.
  const [row] = aggregateHoldings([
    { code: 'ALKLC', isin: 'X', weight: 1, prevWeight: 0.53, group: 'HİSSE SENETLERİ' },
    { code: 'ALKLC', isin: 'X', weight: 0.85, prevWeight: 0.53, group: 'HİSSE SENETLERİ' },
  ]);
  assert.equal(row.weight, 1.85);
  assert.equal(row.prevWeight, 0.53);
});

test('the sixty group labels filers use collapse into nine buckets', () => {
  // Every one of these appears in the committed filings. "BORÇLANMA SENETLERİ",
  // "FİNANSMAN BONOLARI", "DEVLET TAHVİLİ VE" and "DÖVİZE ENDEKSLİ TAHVİLLER"
  // are all debt; a table with sixty headings is not a grouped table.
  const cases = [
    [{ group: 'HİSSE SENETLERİ', subgroup: 'Hisse Türk' }, 'equityTr'],
    [{ group: 'HİSSE SENETLERİ', subgroup: 'Ödünç Verilen' }, 'equityTr'],
    [{ group: 'AÇIĞA SATIŞ', subgroup: 'Hisse Türk' }, 'equityTr'],
    [{ group: 'HİSSE SENETLERİ', subgroup: 'Hisse Yabancı' }, 'equityFx'],
    [{ group: 'YABANCI HİSSE' }, 'equityFx'],
    [{ group: 'DİĞER', subgroup: 'Y.Fonu Türk' }, 'funds'],
    [{ group: 'DİĞER', subgroup: 'Borsa Y.Fonu Yabancı' }, 'funds'],
    [{ group: 'KATILMA BELGELERİ' }, 'funds'],
    [{ group: 'BORÇLANMA SENETLERİ', subgroup: 'Devlet Tahvili' }, 'debt'],
    [{ group: 'FİNANSMAN BONOLARI' }, 'debt'],
    [{ group: 'DÖVİZE ENDEKSLİ TAHVİLLER' }, 'debt'],
    [{ group: 'VARLIĞA DAYALI MENKUL KIYMETLER' }, 'debt'],
    [{ group: 'KİRA SERTİFİKALARI', subgroup: 'Kamu Kesimi Kira Sertifikaları' }, 'lease'],
    [{ group: 'DİĞER', subgroup: 'D.Maden' }, 'metals'],
    [{ group: 'T.REPO' }, 'cash'],
    [{ group: 'KATILMA HESAPLARI' }, 'cash'],
    [{ group: 'KATILIM HESABI', subgroup: 'KATILIM HESABI' }, 'cash'],
    [{ group: 'TPP' }, 'cash'],
    [{ group: 'DİĞER', subgroup: 'Döviz' }, 'cash'],
    // Single-stock futures: the filings label the legs "Kısa" and "Uzun".
    [{ group: 'Kısa' }, 'derivatives'],
    [{ group: 'Uzun' }, 'derivatives'],
    [{ group: 'VİOP Nakit Teminatı' }, 'derivatives'],
    [{ group: 'TÜREV', subgroup: 'Forward' }, 'derivatives'],
    [{ group: 'Call Alım' }, 'derivatives'],
  ];
  for (const [holding, want] of cases) {
    assert.equal(holdingGroupOf(holding), want, JSON.stringify(holding));
  }

  // "VADELİ" reads as "forward" but every row filed under it is a time deposit
  // ("Vadeli Mevduat YP gün 3"), so it is cash and not a derivative.
  assert.equal(holdingGroupOf({ group: 'VADELİ' }), 'cash');
  assert.equal(holdingGroupOf({ group: 'VADELİ MEVDUAT' }), 'cash');

  // Turkish case folding: `/hisse/i` does not match "HİSSE", because the dotted
  // İ does not fold onto an i.
  assert.equal(holdingGroupOf({ group: 'hisse senetleri' }), 'equityTr');
  assert.equal(holdingGroupOf({ group: 'HISSE SENETLERI' }), 'equityTr');

  // An unrecognised label lands in `other` rather than a bucket that merely
  // looks plausible — the group heading is visible, so a guess reads as fact.
  assert.equal(holdingGroupOf({ group: 'BİR ŞEY' }), 'other');
  assert.equal(holdingGroupOf({}), 'other');
  assert.equal(holdingGroupOf(null), 'other');
});

test('groups are ordered by weight and every id has a label', () => {
  const groups = groupHoldings(aggregateHoldings([
    { code: 'ASELS', isin: 'A', weight: 10, group: 'HİSSE SENETLERİ' },
    { code: 'TRT1', isin: 'B', weight: 60, group: 'BORÇLANMA SENETLERİ' },
    { code: 'REPO', isin: 'C', weight: 30, group: 'T.REPO' },
  ]));
  // Heaviest group first: "what is this fund really betting on" is the question.
  assert.deepEqual(groups.map((g) => g.id), ['debt', 'cash', 'equityTr']);
  assert.deepEqual(groups.map((g) => g.weight), [60, 30, 10]);
  // Empty buckets are dropped rather than rendered as headings with nothing under.
  assert.equal(groups.length, 3);

  for (const spec of HOLDING_GROUPS) {
    assert.ok(STRINGS.tr[`hg_${spec.id}`], `no Turkish label for ${spec.id}`);
    assert.ok(STRINGS.en[`hg_${spec.id}`], `no English label for ${spec.id}`);
    // The colour has to be one the stylesheet actually defines.
    assert.ok(GROUPS.some((g) => g.id === spec.color), `${spec.id} borrows an unknown colour`);
  }
  assert.deepEqual(groupHoldings([]), []);
});

test('a group heading counts and weighs the whole group, not the visible part', () => {
  // The table folds long groups. A heading that agreed only with the rows on
  // screen would misstate the portfolio, which is the one thing it is there for.
  const positions = aggregateHoldings(
    Array.from({ length: 20 }, (_, i) =>
      ({ code: `X${i}`, isin: `ISIN${i}`, weight: 2, group: 'HİSSE SENETLERİ' })));
  const [group] = groupHoldings(positions);
  assert.equal(group.rows.length, 20);
  assert.equal(group.weight, 40);
});

test('fmtPoints can drop the unit for a column that states it once', () => {
  assert.equal(fmtPoints(18.42, 'tr', { signed: true, digits: 2 }), '▲ 18,42 puan');
  assert.equal(fmtPoints(18.42, 'tr', { signed: true, digits: 2, unit: false }), '▲ 18,42');
  assert.equal(fmtPoints(-1.5, 'en', { digits: 1, unit: false }), '-1.5');
  assert.equal(fmtPoints(null, 'tr', { unit: false }), '—');
});

// ---------------------------------------------------------------- search

test('a typed query is folded, never upper-cased', () => {
  // The bug this exists to stop: 'ism'.toLocaleUpperCase('tr') is "İSM" — with
  // the dot — which is not a substring of "ISMEN", so the share list found
  // nothing until the reader happened to type the code in capitals.
  const match = queryMatcher('ism');
  assert.equal(match('ISMEN', 'Is Yatirim Menkul Degerler A.S.'), MATCH.codeStart);
  assert.equal(queryMatcher('ISM')('ISMEN', 'Is Yatirim'), MATCH.codeStart,
    'and capitals have to keep working too');
});

test('search folds both sides of Turkish spelling', () => {
  const m = (q) => queryMatcher(q)('SISE', 'TÜRKİYE ŞİŞE VE CAM FABRİKALARI A.Ş.');
  // Folding cuts both ways at once: the company writes its code without the
  // diacritics and its name with them, and either spelling finds it.
  assert.equal(m('şişe'), MATCH.code, 'typed with the diacritics, still the code');
  assert.equal(m('sise'), MATCH.code, 'and without them');
  assert.equal(m('ŞİŞE'), MATCH.code, 'and in capitals');
  assert.equal(m('cam'), MATCH.nameIn, 'a word only the name has');
  assert.equal(m('türkiye'), MATCH.nameStart);
  assert.equal(m('turkiye'), MATCH.nameStart);
  // ı and i fold together, which is what lets "isik" find IŞIKLAR.
  assert.equal(queryMatcher('isik')('IEYHO', 'Işıklar Enerji ve Yapı Holding'), MATCH.nameStart);
});

test('search ranks a code above a name', () => {
  const q = queryMatcher('garanti');
  assert.equal(q('GARAN', 'Turkiye Garanti Bankasi Anonim Sirketi'), MATCH.nameIn,
    'the bank only contains the word');
  assert.equal(q('GTL', 'GARANTİ PORTFÖY BİRİNCİ PARA PİYASASI (TL) FONU'), MATCH.nameStart,
    'a fund named after it starts with the word, and outranks it');
  assert.equal(queryMatcher('gtl')('GTL', 'GARANTİ PORTFÖY'), MATCH.code,
    'and its own code beats both');
  assert.ok(MATCH.code < MATCH.codeStart);
  assert.ok(MATCH.codeStart < MATCH.nameStart);
  assert.ok(MATCH.nameStart < MATCH.nameIn);
});

test('a query too short to be worth matching returns no matcher', () => {
  assert.equal(queryMatcher(''), null);
  assert.equal(queryMatcher('   '), null, 'fold trims, so spaces are nothing typed');
  // The masthead asks for two, because one letter offers a tenth of the exchange.
  assert.equal(queryMatcher('a', { min: 2 }), null);
  assert.ok(queryMatcher('as', { min: 2 }));
  // The list boxes take one: they narrow a table that is already on screen.
  assert.ok(queryMatcher('a'));
});

test('a query that matches nothing says so', () => {
  const match = queryMatcher('zzzz');
  assert.equal(match('ASELS', 'Aselsan Elektronik'), null);
});

// ---------------------------------------------------------------- treemap

const RECT = { x: 0, y: 0, w: 800, h: 400 };
const area = (r) => r.w * r.h;
const overlaps = (a, b) =>
  a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 &&
  a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;

test('a treemap fills its box exactly once', () => {
  const items = [40, 25, 15, 10, 6, 4].map((weight, i) => ({ code: `C${i}`, weight }));
  const laid = squarify(items, RECT);

  assert.equal(laid.length, items.length);
  assert.ok(Math.abs(laid.reduce((s, r) => s + area(r), 0) - area(RECT)) < 1e-6,
    'every pixel of the box is used and none of it twice');

  for (const r of laid) {
    assert.ok(r.x >= -1e-6 && r.y >= -1e-6, 'nothing starts outside the box');
    assert.ok(r.x + r.w <= RECT.w + 1e-6 && r.y + r.h <= RECT.h + 1e-6, 'and nothing runs past it');
    assert.ok(r.w > 0 && r.h > 0);
  }
  for (let i = 0; i < laid.length; i++) {
    for (let j = i + 1; j < laid.length; j++) {
      assert.ok(!overlaps(laid[i], laid[j]), `${laid[i].item.code} overlaps ${laid[j].item.code}`);
    }
  }
});

test('areas are proportional to weights', () => {
  const items = [{ weight: 3 }, { weight: 1 }];
  const [big, small] = squarify(items, RECT);
  assert.ok(Math.abs(area(big) / area(small) - 3) < 1e-6);
  assert.equal(big.item.weight, 3, 'heaviest first, so a caller can label the big one');
});

test('a treemap squares up rather than slicing', () => {
  // The reason this algorithm exists. Slice-and-dice puts twenty equal tiles
  // side by side across an 800x400 box: 40 wide, 400 tall, 10:1 each. Real
  // weights are market caps, which are wildly unequal, and that is the case the
  // market map actually draws.
  const caps = [1800, 760, 690, 550, 540, 490, 480, 440, 410, 360,
    340, 330, 310, 300, 280, 270, 250, 230, 190, 180];
  const laid = squarify(caps.map((weight) => ({ weight })), RECT);
  const worst = Math.max(...laid.map((r) => Math.max(r.w / r.h, r.h / r.w)));
  assert.ok(worst < 2.2, `worst tile is ${worst.toFixed(2)}:1`);

  // Even the pathological case — twenty identical weights, which cannot tile a
  // 2:1 box evenly — stays inside a strip left over at the end, not spread over
  // every tile the way slicing would.
  const even = squarify(Array.from({ length: 20 }, () => ({ weight: 1 })), RECT);
  const evenWorst = Math.max(...even.map((r) => Math.max(r.w / r.h, r.h / r.w)));
  assert.ok(evenWorst < 3, `worst even tile is ${evenWorst.toFixed(2)}:1`);
  const typical = even.map((r) => Math.max(r.w / r.h, r.h / r.w)).sort((a, b) => a - b)[10];
  assert.ok(typical < 1.3, `median tile is ${typical.toFixed(2)}:1`);
});

test('a treemap of one item is the box', () => {
  const [only] = squarify([{ weight: 5 }], RECT);
  assert.deepEqual(
    { x: only.x, y: only.y, w: only.w, h: only.h },
    { x: 0, y: 0, w: 800, h: 400 });
});

test('weightless items are left out, not drawn as slivers', () => {
  const laid = squarify(
    [{ code: 'A', weight: 10 }, { code: 'B', weight: 0 }, { code: 'C', weight: null },
      { code: 'D', weight: -5 }, { code: 'E', weight: 10 }], RECT);
  assert.deepEqual(laid.map((r) => r.item.code), ['A', 'E']);
});

test('a treemap with nothing to lay out is empty, not broken', () => {
  assert.deepEqual(squarify([], RECT), []);
  assert.deepEqual(squarify(null, RECT), []);
  assert.deepEqual(squarify([{ weight: 1 }], { x: 0, y: 0, w: 0, h: 100 }), [],
    'a box with no width holds nothing');
});
