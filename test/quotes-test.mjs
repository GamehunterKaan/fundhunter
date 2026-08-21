import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  parseQuotes, tickerOf, listingOf, quoteFor, isPriceable, estimateMove,
  foreignTickers, scanRequest, sessionOpen, MARKETS, MIN_COVERAGE, WEIGHT_BAND,
  intradaySeries, INTRADAY_STEPS,
} from '../quotes.js';

// A trimmed capture of a real scan response, kept in the shape the endpoint
// actually returns: values in a positional array under `d`, in the order the
// request asked for them.
const payload = {
  totalCount: 4,
  data: [
    { s: 'BIST:ASELS', d: ['ASELS', 382, -1.7994858611825193, 'delayed_streaming_900', 1787064721] },
    { s: 'BIST:THYAO', d: ['THYAO', 301.25, 0.08305647840531562, 'delayed_streaming_900', 1787064700] },
    { s: 'BIST:GLDTR', d: ['GLDTR', 571, -0.6524575902566333, 'delayed_streaming_900', 1787064690] },
    // A share that has not traded: the feed sends a zero rather than omitting it.
    { s: 'BIST:HALTED', d: ['HALTED', 0, null, 'delayed_streaming_900', 1787064690] },
  ],
};

/** A holdings row, with the fields the priceable test actually reads. */
const share = (code, weight, extra = {}) =>
  ({ code, weight, group: 'HİSSE SENETLERİ', subgroup: 'Hisse Türk', currency: 'TL', ...extra });
const foreign = (code, weight, extra = {}) =>
  ({ code, weight, group: 'HİSSE SENETLERİ', subgroup: 'Hisse Yabancı', currency: 'USD', ...extra });

/** Quotes in the per-market shape the UI holds them in. */
const onMarket = (market, quotes) => ({ [market]: { quotes } });

test('a scan response becomes quotes, a delay and a market time', () => {
  const out = parseQuotes(payload);
  assert.equal(out.quotes.ASELS.price, 382);
  assert.equal(out.quotes.THYAO.change, 0.08305647840531562);
  // Exchange-traded funds are quoted the same way and funds do hold them.
  assert.equal(out.quotes.GLDTR.price, 571);
  // A zero is a suspended share, not a price.
  assert.equal(out.quotes.HALTED, undefined);

  // The delay is read from the feed rather than hard-coded, so the page says
  // what this response was actually worth rather than what it once was.
  assert.equal(out.delaySeconds, 900);
  // The bar arrives 900s after the trades it summarises, so the market moment
  // is the newest arrival stamp minus that delay.
  assert.equal(out.asOf, (1787064721 - 900) * 1000);
});

test('an unusable response is null rather than an empty answer', () => {
  // Every one of these has been a real outcome from some feed or other, and all
  // of them mean the same thing: show the committed data, claim nothing.
  assert.equal(parseQuotes(null), null);
  assert.equal(parseQuotes({}), null);
  assert.equal(parseQuotes({ data: [] }), null);
  assert.equal(parseQuotes({ data: [{ s: 'BIST:X' }] }), null);
  assert.equal(parseQuotes({ data: [{ s: 'BIST:X', d: ['X', 0, 0] }] }), null);
  // Missing the delay column is survivable; the price still is a price.
  const partial = parseQuotes({ data: [{ s: 'BIST:X', d: ['XXXX', 10, 1] }] });
  assert.equal(partial.quotes.XXXX.price, 10);
  assert.equal(partial.delaySeconds, 0);
  assert.equal(partial.asOf, null);
});

test('the ticker is recovered from whatever the filer put in the code column', () => {
  assert.equal(tickerOf('ASELS'), 'ASELS');
  assert.equal(tickerOf(' thyao '), 'THYAO');
  // Some filers glue the ISIN onto the code.
  assert.equal(tickerOf('TUPRS TRATUPRS91E8'), 'TUPRS');
  assert.equal(tickerOf('GARAN/TREGARAN00023'), 'GARAN');

  // Bonds, lease certificates and deposits must never collide with a share.
  assert.equal(tickerOf('TRT141126T18'), null);
  assert.equal(tickerOf('TRSKLNT62815'), null);
  assert.equal(tickerOf(''), null);
  assert.equal(tickerOf(null), null);
  assert.equal(tickerOf(undefined), null);
  // Three characters is a fund code, not a Borsa İstanbul ticker.
  assert.equal(tickerOf('TLY'), null);
});

test('a ticker-shaped code is not enough to price a row', () => {
  // Both of these priced a real fund wrongly before the group was consulted.

  // A money-market fund names its repo counterparty in the code column. DSTKF
  // is a listed company, but this row is a repo, and the share's daily move has
  // nothing to do with it. This was 446 "priced positions" on one fund.
  const repo = { code: 'DSTKF', name: 'DESTEK FAKTORING', weight: 0.06, group: 'T.REPO' };
  assert.equal(isPriceable(repo), false);
  assert.equal(quoteFor(repo, onMarket('bist', { DSTKF: { price: 20, change: 3 } })), null);

  // A gold fund codes its bars "ALTIN LBMA 995", and ALTIN is a listed company.
  // This had a gold fund reporting 88% of its portfolio priced at ₺73 a gram.
  const bar = { code: 'ALTIN LBMA 995', weight: 67.5, group: 'DİĞER', subgroup: 'D.Maden' };
  assert.equal(isPriceable(bar), false);
  const gold = onMarket('bist', { ALTIN: { price: 73.85, change: -0.66 } });
  assert.equal(quoteFor(bar, gold), null);
  assert.equal(estimateMove([bar], gold), null);

  // Deposits and lease certificates never carry a share's price either.
  assert.equal(isPriceable({ code: 'AKBNK', group: 'MEVDUAT' }), false);
  assert.equal(isPriceable({ code: 'GARAN', group: 'KİRA SERTİFİKALARI' }), false);
  // Nor does a group nobody has catalogued yet: unknown means unpriced.
  assert.equal(isPriceable({ code: 'ASELS', group: 'YENİ BİR GRUP' }), false);
  assert.equal(isPriceable({ code: 'ASELS' }), false);
  assert.equal(isPriceable(null), false);
});

test('every way a filing spells a shareholding is priced', () => {
  // Taken from the groups the committed filings actually use. Shares lent out,
  // borrowed or sold short are all exposure to the price; the filing carries
  // the sign, so the row is priced and the weight decides the direction.
  for (const holding of [
    { group: 'HİSSE SENETLERİ', subgroup: 'Hisse Türk' },
    { group: 'HİSSE SENETLERİ', subgroup: null },
    { group: 'HİSSE SENETLERİ', subgroup: 'Ödünç Verilen' },
    { group: 'HİSSE', subgroup: null },
    { group: 'ÖDÜNÇ ALMA', subgroup: 'Hisse Türk' },
    { group: 'AÇIĞA SATIŞ', subgroup: 'Hisse Türk' },
    { group: null, subgroup: 'Hisse Türk' },
    // Exchange-traded funds, Turkish and foreign, are quoted like shares.
    { group: 'DİĞER', subgroup: 'Borsa Y.Fonu Türk' },
    { group: 'DİĞER', subgroup: 'Borsa Y.Fonu Yabancı' },
  ]) {
    assert.equal(isPriceable(holding), true, JSON.stringify(holding));
  }

  // Turkish case folding is the trap here: `/hisse/i` does not match "HİSSE",
  // because the dotted İ does not fold onto an i.
  assert.equal(isPriceable({ group: 'hisse senetleri' }), true);
  assert.equal(isPriceable({ group: 'HISSE SENETLERI' }), true);
});

test('an aggregated position is still recognised as a shareholding', () => {
  // aggregateHoldings() replaces `group` with the display bucket it sorted the
  // row into and keeps the filing's wording in `filedGroup`. Reading only
  // `group` meant a position was recognised on its subgroup alone once it had
  // been through there — and 1,689 rows across 97 funds carry a group with no
  // subgroup, among them funds that are 90% shares.
  const aggregated = { code: 'ASELS', group: 'equityTr', filedGroup: 'HİSSE SENETLERİ', subgroup: null };
  assert.equal(isPriceable(aggregated), true);

  // The display bucket on its own must never be what admits a row: the filing's
  // word is the evidence, ours is a label we applied.
  assert.equal(isPriceable({ code: 'DSTKF', group: 'cash', filedGroup: 'T.REPO' }), false);
  assert.equal(isPriceable({ code: 'ALTIN LBMA 995', group: 'metals', filedGroup: 'DİĞER' }), false);
  assert.equal(isPriceable({ code: 'ASELS', group: 'equityTr', filedGroup: null }), false,
    'a filing that stated no group is not one that said "shares"');
});

test('shares are recognised wherever the filing puts the word', () => {
  // Foreign shares are filed under "YABANCI HİSSE", so the word is at the end.
  // Every label in the committed filings containing it is equity, so there is
  // nothing an anchored match would protect against — and anchoring cost the
  // foreign holdings of 239 rows.
  assert.equal(isPriceable({ group: 'YABANCI HİSSE', subgroup: null }), true);
  assert.equal(isPriceable({ group: 'YABANCI HİSSE', subgroup: 'Hisse Yabancı' }), true);
  // And an exchange-traded fund is filed as a group as well as a subgroup.
  assert.equal(isPriceable({ group: 'BORSA YATIRIM FONU /', subgroup: null }), true);
  assert.equal(isPriceable({ group: 'DİĞER', subgroup: 'Borsa Y.Fonu Türk' }), true);
  // Widening the match must not have let anything else in.
  assert.equal(isPriceable({ group: 'T.REPO' }), false);
  assert.equal(isPriceable({ group: 'DEVLET TAHVİLİ' }), false);
  assert.equal(isPriceable({ group: 'VADELİ MEVDUAT' }), false);
  assert.equal(isPriceable({ group: 'KIYMETLİ MADENLER' }), false);
});

test('a listing is resolved to a market, not just a ticker', () => {
  // Turkish rows: the exchange's own list confirms the candidate, so offering
  // several is safe. "Tem.Ver." marks a pledged position and is not a ticker.
  assert.deepEqual(listingOf(share('ASELS', 1)), { market: 'bist', tickers: ['ASELS'] });
  assert.deepEqual(listingOf(share('Tem.Ver. SASA', 1)), { market: 'bist', tickers: ['SASA'] });
  assert.deepEqual(listingOf(share('MARMR.E', 1)), { market: 'bist', tickers: ['MARMR'] });

  // Foreign rows are written Bloomberg-style: ticker, country code, sometimes
  // the word EQUITY.
  assert.deepEqual(listingOf(foreign('MSFT US', 1)), { market: 'us', tickers: ['MSFT'] });
  assert.deepEqual(listingOf(foreign('NVDA US EQUITY', 1)), { market: 'us', tickers: ['NVDA'] });
  // AIR is AAR Corp on the NYSE. The suffix is the only thing that says so, and
  // without reading it this row would have been looked up on the wrong exchange.
  assert.deepEqual(listingOf(foreign('AIR US EQUITY', 1)), { market: 'us', tickers: ['AIR'] });
  // A bare ticker in dollars can only be the US listing.
  assert.deepEqual(listingOf(foreign('QQQ', 1)), { market: 'us', tickers: ['QQQ'] });

  // When the code column holds the ISIN, the name carries the listing.
  assert.deepEqual(
    listingOf(foreign('US78462F1030', 1, { name: 'SPY US EQUITY', currency: null })),
    { market: 'us', tickers: ['SPY'] });

  // Exchanges this does not price go unpriced rather than being guessed at, and
  // must never fall through to a market that happens to list the same letters.
  for (const code of ['AZN LN', 'NESN SW', 'ASML NA', '700 HK', '7974 JT', 'VWS DC', 'NPI CN']) {
    assert.equal(listingOf(foreign(code, 1, { currency: 'EUR' })), null, code);
  }
  // BA/ LN is BAE Systems in London: a slash in the ticker, still not priced.
  assert.equal(listingOf(foreign('BA/ LN', 1, { currency: 'GBP' })), null);
});

test('only the tickers a fund actually holds are asked for', () => {
  // The US scan is per fund, so the request must carry exactly its foreign names
  // — Turkish rows would be looked up on the wrong exchange, and asking for the
  // whole US market would be megabytes a minute.
  const holdings = [
    share('ASELS', 10), foreign('MSFT US', 5), foreign('NVDA US EQUITY', 5),
    foreign('MSFT US', 2), { code: 'TRT141126T18', weight: 78, group: 'DEVLET TAHVİLİ' },
  ];
  assert.deepEqual(foreignTickers(holdings), ['MSFT', 'NVDA']);
  assert.deepEqual(foreignTickers([share('ASELS', 100)]), []);
  assert.deepEqual(foreignTickers([]), []);

  const init = scanRequest(['MSFT', 'NVDA'], 1000);
  const body = JSON.parse(init.body);
  assert.deepEqual(body.filter, [{ left: 'name', operation: 'in_range', right: ['MSFT', 'NVDA'] }]);
  // Borsa İstanbul comes back whole, so it asks for no filter at all.
  assert.equal(JSON.parse(scanRequest(null, 1000).body).filter, undefined);
});

test('the day estimate is stated at the level of the fund, not the position', () => {
  // 30% of the portfolio in shares that rose 2% is +0.6% for the fund.
  const est = estimateMove([
    share('ASELS', 20), share('THYAO', 10),
    { code: 'TRT141126T18', weight: 70, group: 'DEVLET TAHVİLİ VE BONOLAR' },
  ], onMarket('bist', { ASELS: { price: 1, change: 2 }, THYAO: { price: 1, change: 2 } }));

  assert.equal(Math.round(est.move * 1e6) / 1e6, 0.6);
  assert.equal(est.priced, 30);
  assert.equal(est.count, 2);
  assert.equal(est.total, 100);
  assert.equal(est.reliable, true);
  assert.deepEqual(est.markets, ['bist']);

  // Nothing priceable at all is null, not zero: a fund of bonds has not had a
  // flat day, we simply cannot see its day.
  const quotes = onMarket('bist', parseQuotes(payload).quotes);
  assert.equal(estimateMove([{ code: 'TRT141126T18', weight: 100 }], quotes), null);
  assert.equal(estimateMove([], quotes), null);
  assert.equal(estimateMove(null, quotes), null);
  assert.equal(estimateMove([share('ASELS', 1)], null), null);
  // A market that has not answered leaves its rows unpriced rather than failing.
  assert.equal(estimateMove([foreign('MSFT US', 50)], quotes), null);
});

test('a foreign position earns the currency move as well as the share move', () => {
  const markets = {
    bist: { quotes: { ASELS: { price: 1, change: 2 } } },
    us: { quotes: { MSFT: { price: 1, change: 2 } } },
  };
  const fx = { usdtry: { price: 47.9, change: 1 } };

  // Compounded, not added: 1.02 × 1.01 − 1 = 3.02%, on half the portfolio.
  const est = estimateMove([foreign('MSFT US', 50)], markets, fx);
  assert.equal(Math.round(est.move * 1e4) / 1e4, 1.51);
  assert.deepEqual(est.markets, ['us']);

  // A Turkish share is already in lira and must not pick up the currency leg.
  const home = estimateMove([share('ASELS', 50)], markets, fx);
  assert.equal(Math.round(home.move * 1e4) / 1e4, 1);

  // No tape quote is treated as a flat currency rather than dropping the
  // position: the share move is the larger part of the signal.
  const noFx = estimateMove([foreign('MSFT US', 50)], markets, null);
  assert.equal(Math.round(noFx.move * 1e4) / 1e4, 1);

  // A fund holding both markets reports both, so the page can say which
  // sessions are behind the figure.
  const both = estimateMove([share('ASELS', 50), foreign('MSFT US', 50)], markets, fx);
  assert.deepEqual(both.markets.sort(), ['bist', 'us']);
  assert.equal(both.priced, 100);
});

test('positions repeated in a filing add up instead of overwriting', () => {
  // A filing splits one holding across several rows — long and short, or bought
  // on different dates — and the fund's exposure is the sum of them.
  const est = estimateMove([
    share('ASELS', 6),
    share('ASELS', -1, { group: 'AÇIĞA SATIŞ' }),
  ], onMarket('bist', { ASELS: { price: 1, change: 10 } }));

  assert.equal(Math.round(est.move * 1e6) / 1e6, 0.5);
  assert.equal(est.priced, 5);
  assert.equal(est.count, 2);
});

test('a filing whose weights are not a portfolio is marked unreliable', () => {
  // Around a dozen filings parse into weights summing to millions. Their row
  // prices are still real prices, so the table keeps them; no total derived
  // from those weights is, so the estimate has to say so.
  const one = onMarket('bist', { ASELS: { price: 1, change: 1 } });
  const broken = estimateMove([
    share('ASELS', 900_000), share('THYAO', 100),
  ], onMarket('bist', { ASELS: { price: 1, change: 1 }, THYAO: { price: 1, change: 1 } }));
  assert.equal(broken.reliable, false);

  const [lo, hi] = WEIGHT_BAND;
  assert.equal(estimateMove([share('ASELS', lo)], one).reliable, true);
  assert.equal(estimateMove([share('ASELS', hi)], one).reliable, true);
  assert.equal(estimateMove([share('ASELS', lo - 1)], one).reliable, false);

  // A missing weight is skipped rather than counted as zero, which would drag
  // the total below the band and discard a fund that is perfectly readable.
  const withNull = estimateMove([
    share('ASELS', 100), share('THYAO', null),
  ], onMarket('bist', { ASELS: { price: 1, change: 1 }, THYAO: { price: 1, change: 5 } }));
  assert.equal(withNull.total, 100);
  assert.equal(withNull.count, 1);
});

test('each market is read in its own session, not the reader\'s', () => {
  const ist = (iso) => new Date(`${iso}+03:00`);

  // Borsa İstanbul, Tuesday, inside the continuous session.
  assert.equal(sessionOpen('bist', ist('2026-08-18T10:00')), true);
  assert.equal(sessionOpen('bist', ist('2026-08-18T18:09')), true);

  // Before the open, after the close, and the small hours — the case that
  // caught this: at 01:10 the feed still stamps rows, and the page was calling
  // the previous session's move "today's".
  assert.equal(sessionOpen('bist', ist('2026-08-18T09:59')), false);
  assert.equal(sessionOpen('bist', ist('2026-08-18T18:10')), false);
  assert.equal(sessionOpen('bist', ist('2026-08-19T01:10')), false);

  // The weekend, when a stamp from Friday would otherwise read as live.
  assert.equal(sessionOpen('bist', ist('2026-08-22T12:00')), false); // Saturday
  assert.equal(sessionOpen('bist', ist('2026-08-23T12:00')), false); // Sunday

  // New York opens at 16:30 Istanbul in summer, so a Turkish trading morning is
  // reading a US session that has not started. Both are read in their own zone,
  // which is what keeps that true when the clocks change on different dates.
  assert.equal(sessionOpen('us', ist('2026-08-18T12:00')), false);
  assert.equal(sessionOpen('us', ist('2026-08-18T16:29')), false);
  assert.equal(sessionOpen('us', ist('2026-08-18T16:30')), true);
  assert.equal(sessionOpen('us', ist('2026-08-18T22:59')), true);
  assert.equal(sessionOpen('us', ist('2026-08-18T23:00')), false);
  // The overlap, when both figures on the page are live at once.
  assert.equal(sessionOpen('bist', ist('2026-08-18T17:00')), true);
  assert.equal(sessionOpen('us', ist('2026-08-18T17:00')), true);

  assert.equal(sessionOpen('nowhere', ist('2026-08-18T12:00')), false);
});

test('the request stays a CORS simple request', () => {
  // The endpoint's preflight allows only Referer and Accept, so an
  // application/json content type would fail preflight and return nothing.
  // This is the one detail that makes the feature work from a browser at all.
  const init = scanRequest(null, 1000);
  assert.equal(init.method, 'POST');
  assert.match(init.headers['Content-Type'], /^text\/plain/);
  const columns = JSON.parse(init.body).columns;
  assert.deepEqual(columns.slice(0, 6),
    ['name', 'close', 'change', 'update_mode', 'last_bar_update_time', 'open']);
  // The interval changes follow, in order, and the intraday path reads them
  // back positionally — so the order is the contract, not a detail.
  assert.deepEqual(columns.slice(6), INTRADAY_STEPS.map((m) => `change|${m}`));
});

test('every market states a currency symbol and a session', () => {
  // A US listing quoted with a lira sign would be a wrong number, not a
  // formatting slip, so the symbol is part of the market rather than the view.
  for (const [id, spec] of Object.entries(MARKETS)) {
    assert.ok(spec.symbol, `${id} has no currency symbol`);
    assert.ok(spec.scan.startsWith('https://'), `${id} has no scan endpoint`);
    assert.ok(spec.session.open < spec.session.close, `${id} session is inverted`);
    assert.ok(spec.zone.includes('/'), `${id} has no time zone`);
  }
  assert.equal(MARKETS.bist.symbol, '₺');
  assert.equal(MARKETS.us.symbol, '$');
  // Only a foreign market carries a currency leg.
  assert.equal(MARKETS.bist.fx, null);
  assert.equal(MARKETS.us.fx, 'usdtry');
});

test('the committed holdings match the tickers the exchange actually lists', async () => {
  // The claim the panel makes is that a share-heavy fund can be almost entirely
  // priced. That depends on two things staying true of each other: the code
  // column in the filings, and the ticker list on the exchange. This is where a
  // drift in either shows up — matched against a captured list of every symbol
  // Borsa İstanbul quotes, not against the holdings themselves.
  const listed = JSON.parse(
    await fs.readFile(new URL('./fixtures/bist-tickers.json', import.meta.url), 'utf8'));
  const quotes = onMarket('bist',
    Object.fromEntries(listed.tickers.map((t) => [t, { price: 1, change: 0 }])));

  const dir = new URL('../data/holdings/', import.meta.url);
  let names;
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  } catch {
    return; // holdings are built by a script; skip when they have not been.
  }
  if (!names.length) return;

  let priceable = 0;
  let mostlyPriced = 0;
  const mispriced = [];
  for (const name of names) {
    const fund = JSON.parse(await fs.readFile(new URL(name, dir), 'utf8'));

    // Nothing that is not a shareholding may carry a share price. This is the
    // regression that matters: both bugs this rule exists for looked entirely
    // plausible on screen, and only a wrong price gave them away.
    for (const holding of fund.holdings) {
      if (!quoteFor(holding, quotes)) continue;
      if (!/^H[İI]SSE/.test(String(holding.group ?? '').toUpperCase())
        && !/^H[İI]SSE|^BORSA/.test(String(holding.subgroup ?? '').toUpperCase())) {
        mispriced.push(`${fund.code}: ${holding.code} under ${holding.group}`);
      }
    }

    const est = estimateMove(fund.holdings, quotes);
    if (!est || !est.reliable) continue;
    if (est.priced >= MIN_COVERAGE) priceable++;
    if (est.priced >= 90) mostlyPriced++;
  }
  assert.deepEqual(mispriced.slice(0, 5), [], 'non-share rows were given a share price');
  assert.ok(priceable > 250, `only ${priceable} funds cleared the coverage floor`);
  assert.ok(mostlyPriced > 50, `only ${mostlyPriced} funds are almost fully priced`);

  // Coverage above 100% is not an error to clamp away: a handful of funds
  // borrow to hold more shares than they have net assets, and a fund with 175%
  // of itself in shares really does move 1.75 times what the market does.
  const levered = JSON.parse(await fs.readFile(new URL('IIE.json', dir), 'utf8'));
  assert.ok(estimateMove(levered.holdings, quotes).priced > 100,
    'leverage should survive as leverage');
});

test('the funds holding foreign shares are found and asked for', async () => {
  // Without the US market these funds price almost nothing, which is the whole
  // reason for the second scan. A drift in how filers write a foreign line
  // would show up as this number collapsing.
  const dir = new URL('../data/holdings/', import.meta.url);
  let names;
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  } catch {
    return;
  }
  if (!names.length) return;

  let withForeign = 0;
  let biggest = 0;
  for (const name of names) {
    const fund = JSON.parse(await fs.readFile(new URL(name, dir), 'utf8'));
    const tickers = foreignTickers(fund.holdings);
    if (tickers.length) withForeign++;
    biggest = Math.max(biggest, tickers.length);
  }
  assert.ok(withForeign > 100, `only ${withForeign} funds resolved a foreign listing`);
  // One request per fund has to be enough: the largest set must stay well
  // inside a single scan rather than needing paging.
  assert.ok(biggest < 400, `one fund needs ${biggest} tickers in a single scan`);
});

// ---------------------------------------------------------------- intraday

const NOON = Date.parse('2026-08-21T12:00:00Z');
const OPEN = Date.parse('2026-08-21T07:00:00Z');

test('an intraday path is the price now walked backwards by the feed’s own changes', () => {
  // ASELS at 405.25, up 0.75% on the day, having risen 0.68% in the last half
  // hour: half an hour ago it was 405.25 / 1.0068.
  const quote = {
    price: 405.25, change: 0.7458, open: 403,
    back: { 240: 0.7458, 120: 0.7458, 60: 0.5583, 30: 0.6832, 15: 0.0617, 5: -0.1232, 1: -0.0617 },
  };
  const series = intradaySeries(quote, NOON, { sessionOpenMs: OPEN });
  const at = (iso) => series.find(([d]) => d === iso)?.[1];

  assert.equal(series.at(-1)[1], 405.25, 'the line ends at the price');
  // 405.25 / 1.006832, which is 402.5001 and not the round number the feed's
  // rounded percentage suggests — the arithmetic is not reversed exactly.
  assert.ok(Math.abs(at('2026-08-21T11:30:00.000Z') - 402.5) < 0.001, 'half an hour ago');
  assert.ok(Math.abs(at('2026-08-21T11:55:00.000Z') - 405.75) < 0.001,
    'five minutes ago, when it was higher');
  assert.equal(at('2026-08-21T07:00:00.000Z'), 403, 'the opening price, stated by the feed');
  assert.equal(at('2026-08-21T06:59:00.000Z'), 402.25,
    'and yesterday’s close, one minute before the open because it is not today');

  const times = series.map(([d]) => Date.parse(d));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'ascending');
});

test('an intraday path drops steps from before the session opened', () => {
  // Twenty minutes into the session, the four-hour and two-hour changes reach
  // back into yesterday. Drawing them would put today's line in the middle of
  // the night.
  const justOpened = OPEN + 20 * 60000;
  const series = intradaySeries(
    { price: 100, change: 2, open: 98, back: { 240: 5, 120: 4, 60: 3, 30: 2.5, 15: 1, 5: 0.5, 1: 0.1 } },
    justOpened, { sessionOpenMs: OPEN });
  const first = Date.parse(series[0][0]);
  assert.ok(first >= OPEN - 60000, 'nothing earlier than the previous close marker');
  assert.equal(series.filter(([d]) => Date.parse(d) > OPEN && Date.parse(d) < justOpened).length, 3,
    'only the 15, 5 and 1 minute steps fall inside the session');
  assert.ok(series.length >= 5, 'plus the open, the previous close and the price now');
});

test('an intraday path needs a price and nothing else', () => {
  assert.deepEqual(intradaySeries(null, NOON), []);
  assert.deepEqual(intradaySeries({ price: 0, back: {} }, NOON), []);
  assert.deepEqual(intradaySeries({ price: 10, back: {} }, NaN), []);
  // A share that has not moved all day reports zero for every interval, which is
  // one point repeated — and one point is not a line.
  const flat = intradaySeries({ price: 10, change: 0, open: 10, back: { 60: 0, 30: 0, 5: 0 } }, NOON);
  assert.ok(flat.every(([, v]) => v === 10));
  assert.ok(flat.length >= 1);
});

test('a quote carries what the intraday path needs', () => {
  const parsed = parseQuotes({
    data: [{ d: ['ASELS', 405.25, 0.7458, 'delayed_streaming_900', 1787300026, 403,
      0.7458, 0.7458, 0.5583, 0.6832, 0.0617, -0.1232, -0.0617] }],
  });
  const quote = parsed.quotes.ASELS;
  assert.equal(quote.price, 405.25);
  assert.equal(quote.open, 403);
  assert.equal(quote.back[240], 0.7458, 'the interval columns keep their order');
  assert.equal(quote.back[1], -0.0617);
  assert.equal(Object.keys(quote.back).length, INTRADAY_STEPS.length);
});
