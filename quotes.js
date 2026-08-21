// Last-trade prices for the individual securities a fund holds.
//
// `live.js` covers the four instruments on the tape. This covers every share on
// Borsa İstanbul plus the US names Turkish funds hold, which is a different
// source with a different failure mode, so it stays a separate module: the tape
// must keep working when this is blocked, and this must keep working when the
// tape's source is down.
//
// Borsa İstanbul's real-time feed is licensed. What is free — and what this uses
// — is the 15-minute delayed one. The delay is never hidden: the source states
// it per row (`update_mode: "delayed_streaming_900"`), and the UI prints the
// number it finds there rather than a hard-coded claim.
//
// DOM-free so the arithmetic can be tested without a browser.

export const QUOTE_SOURCE = {
  name: 'TradingView',
  home: 'https://www.tradingview.com/markets/stocks-turkey/',
};

/** How often quotes are re-polled while a holdings table is on screen. */
export const QUOTE_REFRESH_MS = 60_000;

/** Give up rather than leave the table waiting on a slow third party. */
export const QUOTE_TIMEOUT_MS = 8_000;

/**
 * The markets a holding can be priced on.
 *
 * `session` is the exchange's continuous trading window in its own local time,
 * which is what decides whether a move gets called "today's". `fx` names the
 * tape quote whose daily move converts the price into lira: a Turkish fund
 * holding NVDA earns the share's move *and* the dollar's, and reporting only the
 * first would understate a devaluation day.
 *
 * Only these two are priced. The filings also carry London, Frankfurt, Paris,
 * Zurich, Tokyo, Hong Kong, Copenhagen, Stockholm, Oslo, Toronto and Warsaw
 * listings — together 0.5% of all holdings weight, against 7.3% for the US — and
 * each would need its own scanner, session and currency leg. They stay unpriced
 * and are counted as such.
 */
export const MARKETS = {
  bist: {
    scan: 'https://scanner.tradingview.com/turkey/scan',
    zone: 'Europe/Istanbul',
    session: { open: 10 * 60, close: 18 * 60 + 10 },
    symbol: '₺',
    fx: null,
    // 646 symbols for 16KB gzipped, so the whole market is fetched once and
    // shared by every fund page. Asking per fund would be smaller per request
    // and many more requests.
    whole: true,
  },
  us: {
    scan: 'https://scanner.tradingview.com/america/scan',
    zone: 'America/New_York',
    session: { open: 9 * 60 + 30, close: 16 * 60 },
    symbol: '$',
    fx: 'usdtry',
    // The US market is thousands of symbols, so only the tickers the open fund
    // actually holds are requested — 18 names come back in under 2KB.
    whole: false,
  },
};

/**
 * How far back the feed will state a change, in minutes.
 *
 * The scanner has no history endpoint, but it will tell you what a share has
 * done over each of these intervals — and a price now plus a change over the
 * last N minutes IS the price N minutes ago. Chained, they are a real intraday
 * path from a quotes-only feed. Four hours is as far as it goes: 300, 360, 480
 * and 720 all come back null.
 */
export const INTRADAY_STEPS = [240, 120, 60, 30, 15, 5, 1];

const COLUMNS = [
  'name', 'close', 'change', 'update_mode', 'last_bar_update_time', 'open',
  ...INTRADAY_STEPS.map((m) => `change|${m}`),
];

/**
 * The fetch options for one scan.
 *
 * `text/plain` is not sloppiness — it keeps this a CORS "simple request". The
 * endpoint's preflight reply allows only `Referer` and `Accept`, so sending
 * `application/json` would fail the preflight and return nothing at all.
 *
 * @param {string[]|null} tickers names to ask for, or null for the whole market
 */
export function scanRequest(tickers = null, timeoutMs = QUOTE_TIMEOUT_MS) {
  const body = {
    symbols: { query: { types: [] }, tickers: [] },
    columns: COLUMNS,
    range: [0, tickers ? Math.max(tickers.length * 2, 50) : 3000],
  };
  // A name filter, not a `tickers` list: the filings never say which exchange a
  // US name is on, and "NASDAQ:NVDA" would have to be guessed.
  if (tickers) body.filter = [{ left: 'name', operation: 'in_range', right: tickers }];

  return {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  };
}

// `Number(null)` and `Number('')` are both 0, which would turn a holding with no
// weight into a real weight of zero and a missing quote into a flat one.
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Uppercase for matching.
 *
 * Turkish case folding is the trap: `/i` does not fold the dotted İ in "HİSSE"
 * onto an `i`, but `toUpperCase` leaves İ alone and lifts a plain `i` to `I`, so
 * one pattern then covers both spellings.
 */
const up = (v) => String(v ?? '').toUpperCase();

/**
 * Whether a holding is exposure to a listed security, rather than a line that
 * merely names one.
 *
 * A ticker-shaped code is not enough on its own, and assuming it was produced
 * two wrong prices on real funds:
 *
 *   - a money-market fund lists its repo counterparty in the code column
 *     ("DSTKF" under T.REPO). It is a repo, not a shareholding, and a share's
 *     daily move says nothing about it.
 *   - a gold fund's bars are coded "ALTIN LBMA 995", and ALTIN is a listed
 *     company. That fund was showing 88% of its portfolio priced at ₺73 a gram.
 *
 * So the group has to agree that the row is a share or an exchange-traded fund.
 * This is an allow-list rather than a deny-list: a group nobody has seen yet
 * should go unpriced, not be priced on a guess.
 */
export function isPriceable(holding) {
  // aggregateHoldings() replaces `group` with the display bucket it sorted the
  // row into and keeps the filing's own wording in `filedGroup`. Reading only
  // `group` meant this matched on the subgroup alone once a position had been
  // aggregated, and 1,689 rows across 97 funds carry a group with no subgroup —
  // among them funds that are 90% shares.
  const group = up(holding?.filedGroup ?? holding?.group);
  const subgroup = up(holding?.subgroup);
  // Shares, including ones lent out, borrowed or sold short: the filing carries
  // the sign, and all of them are exposure to the price. Matched anywhere in the
  // label rather than at the start of it, because foreign shares are filed under
  // "YABANCI HİSSE". Eight distinct labels in the whole dataset contain the word
  // and every one of them is equity, so there is nothing to anchor against.
  if (/H[İI]SSE/.test(group) || /H[İI]SSE/.test(subgroup)) return true;
  // Exchange-traded funds, Turkish or foreign, are quoted like shares. Filed as
  // both "Borsa Y.Fonu Türk" and "BORSA YATIRIM FONU /".
  if (/BORSA\s*Y/.test(group) || /BORSA\s*Y/.test(subgroup)) return true;
  return false;
}

/**
 * Whether a holding is a foreign listing rather than a Borsa İstanbul one.
 *
 * The filings say so twice over, and either is enough: the subgroup spells it
 * ("Hisse Yabancı", "Borsa Y.Fonu Yabancı") and the currency is not lira.
 */
function isForeign(holding) {
  if (/YABANCI/.test(up(holding?.subgroup))) return true;
  const currency = up(holding?.currency);
  return !!currency && !['TL', 'TRY', 'TRL', '₺'].includes(currency);
}

/**
 * Bloomberg-style listing: a ticker, a two-letter country code, sometimes the
 * word EQUITY. `US` is the United States, `LN` London, `GY` Germany, and so on.
 *
 * This is how every filer writes a foreign holding — "MSFT US", "NVDA US
 * EQUITY", "700 HK", "BA/ LN" — and it is the only thing in the row that says
 * which exchange the name is listed on.
 */
const BLOOMBERG = /^([A-Z0-9][A-Z0-9./]{0,5})\s+([A-Z]{2})(?:\s+EQUITY)?$/;

/** Bloomberg country code -> our market id, for the markets that are priced. */
const EXCHANGE = { US: 'us' };

/** A Borsa İstanbul ticker is four or five characters. */
const BIST_TICKER = /^[A-Z][A-Z0-9]{3,4}$/;

/**
 * The exchange ticker for a holding, or null when the line is not a listed share.
 *
 * The shape of a code says nothing about whether the row is a shareholding, so
 * this is only half the test: `quoteFor` is what a caller should reach for.
 */
export function tickerOf(code) {
  if (typeof code !== 'string' && typeof code !== 'number') return null;
  const first = up(code).trim().split(/[\s/,;]+/)[0];
  return BIST_TICKER.test(first) ? first : null;
}

/**
 * Which market a holding is listed on and what to look it up under.
 *
 * Several candidate tickers come back rather than one, because the code column
 * is not reliably just a ticker. Filers put the ISIN beside it ("TUPRS
 * TRATUPRS91E8"), mark a pledged position in front of it ("Tem.Ver. SASA") and
 * write foreign names Bloomberg-style ("MSFT US"). The caller tries the
 * candidates against the quotes it actually has, so a wrong guess finds nothing
 * rather than mispricing a row.
 *
 * @returns {{market: string, tickers: string[]}|null}
 */
export function listingOf(holding) {
  if (!isPriceable(holding)) return null;
  const code = up(holding.code).trim();

  if (!isForeign(holding)) {
    // Every ticker-shaped token, so "Tem.Ver. SASA" finds SASA. Membership of
    // the exchange's own list is what confirms it, which is why more than one
    // candidate is safe to offer.
    const tickers = code.split(/[\s/,;.]+/).filter((t) => BIST_TICKER.test(t));
    return tickers.length ? { market: 'bist', tickers } : null;
  }

  // A foreign row carries its exchange in the code, or — when the code column
  // holds the ISIN instead — in the name.
  const listing = BLOOMBERG.exec(code) ?? BLOOMBERG.exec(up(holding.name).trim());
  if (listing) {
    const market = EXCHANGE[listing[2]];
    return market ? { market, tickers: [listing[1]] } : null;
  }
  // No exchange stated. A dollar price can only be the US listing; anything
  // else is a market this does not price.
  if (['USD', 'US$', '$'].includes(up(holding.currency)) && /^[A-Z0-9.]{1,6}$/.test(code)) {
    return { market: 'us', tickers: [code] };
  }
  return null;
}

/**
 * Normalise a scan response into `{quotes, delaySeconds, asOf}`, or null when
 * nothing usable came back.
 *
 * @param {unknown} payload parsed JSON from a market's scan endpoint
 * @returns {{quotes: Record<string, {price:number, change:number|null}>,
 *            delaySeconds: number, asOf: number|null}|null}
 */
export function parseQuotes(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : null;
  if (!rows?.length) return null;

  const quotes = {};
  let newest = 0;
  let delay = 0;

  for (const row of rows) {
    const d = Array.isArray(row?.d) ? row.d : [];
    const [name, close, change, mode, at, open] = d;
    if (typeof name !== 'string' || !name) continue;
    const price = num(close);
    // A zero is a share that has not traded or has been suspended, not a price.
    if (price == null || price <= 0) continue;

    // The interval changes come back in the order they were asked for, after the
    // six named columns.
    const back = {};
    INTRADAY_STEPS.forEach((minutes, i) => {
      const pct = num(d[6 + i]);
      if (pct != null) back[minutes] = pct;
    });

    quotes[name.toUpperCase()] = { price, change: num(change), open: num(open), back };

    const stamp = num(at);
    if (stamp && stamp > newest) newest = stamp;
    // "delayed_streaming_900" — the trailing number is the delay in seconds.
    const declared = /_(\d+)$/.exec(String(mode ?? ''));
    if (declared) delay = Math.max(delay, Number(declared[1]));
  }
  if (!Object.keys(quotes).length) return null;

  // The bar arrives `delay` seconds after the trades it summarises, so the
  // market moment on screen is the arrival stamp minus the declared delay.
  return { quotes, delaySeconds: delay, asOf: newest ? (newest - delay) * 1000 : null };
}

/**
 * Today's shape for one share, from a quotes-only feed.
 *
 * The scanner has no history endpoint. What it has is the change over each of
 * `INTRADAY_STEPS`, and a price now with a change over the last N minutes is the
 * price N minutes ago:  p(t-N) = price / (1 + change_N/100).
 *
 * Two anchors sit in front of those: the previous close, which the day's change
 * gives the same way, and the session's opening price, which the feed states
 * outright. So the line starts where the share closed yesterday, steps to where
 * it opened, and then walks the last four hours in seven points.
 *
 * Four hours is the feed's limit, so on a long session the middle of the morning
 * is a straight line between the open and the earliest step. That is a real gap
 * in the data and the chart does not pretend otherwise — it is drawn as the
 * straight line it is, and the caller labels the ends with their own times.
 *
 * @param {{price:number, change:number|null, open:number|null, back:object}} quote
 * @param {number} asOfMs when the quote was taken, in epoch milliseconds
 * @param {{sessionOpenMs?: number|null}} [opts] drop points before the open
 * @returns {[string, number][]} ascending [ISO timestamp, price]
 */
export function intradaySeries(quote, asOfMs, { sessionOpenMs = null } = {}) {
  const price = num(quote?.price);
  if (price == null || !Number.isFinite(asOfMs)) return [];

  const points = new Map();
  const at = (ms, value) => {
    if (value == null || !Number.isFinite(value) || value <= 0) return;
    // Keyed by the minute, so two steps that resolve to the same moment — which
    // happens the instant a share stops moving — do not draw two points.
    points.set(Math.round(ms / 60000) * 60000, value);
  };

  for (const minutes of INTRADAY_STEPS) {
    const pct = num(quote.back?.[minutes]);
    if (pct == null) continue;
    const then = price / (1 + pct / 100);
    const ms = asOfMs - minutes * 60000;
    if (sessionOpenMs != null && ms < sessionOpenMs) continue;
    at(ms, then);
  }
  at(asOfMs, price);

  // The two anchors, only when there is something to anchor to the left of.
  const earliest = Math.min(...points.keys());
  if (sessionOpenMs != null && Number.isFinite(earliest)) {
    if (sessionOpenMs < earliest) at(sessionOpenMs, num(quote.open));
    const dayChange = num(quote.change);
    if (dayChange != null) {
      const prevClose = price / (1 + dayChange / 100);
      // A previous close is not part of today, so it is placed one minute before
      // the open rather than pretending to a time it does not have.
      at(sessionOpenMs - 60000, prevClose);
    }
  }

  return [...points.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, value]) => [new Date(ms).toISOString(), Math.round(value * 10000) / 10000]);
}

/**
 * The live quote for one holding, or null when the row is not a listed position
 * or the market it trades on has not answered.
 *
 * The single place every test is applied, so the table and the fund's estimate
 * cannot disagree about which rows carry a price.
 *
 * @param {object} holding a row from data/holdings/<CODE>.json
 * @param {Record<string, {quotes: object}>} markets quotes keyed by market id
 * @returns {{price:number, change:number|null, market:string}|null}
 */
export function quoteFor(holding, markets) {
  const listing = listingOf(holding);
  if (!listing) return null;
  const quotes = markets?.[listing.market]?.quotes;
  if (!quotes) return null;
  for (const ticker of listing.tickers) {
    const quote = quotes[ticker];
    if (quote) return { ...quote, market: listing.market };
  }
  return null;
}

/** Every US ticker a fund's holdings need, for a targeted scan. */
export function foreignTickers(holdings) {
  const wanted = new Set();
  for (const holding of holdings ?? []) {
    const listing = listingOf(holding);
    if (listing && MARKETS[listing.market] && !MARKETS[listing.market].whole) {
      for (const ticker of listing.tickers) wanted.add(ticker);
    }
  }
  return [...wanted].sort();
}

/**
 * Whether a market is trading right now.
 *
 * This decides what the figure on screen is called, and getting it wrong is not
 * cosmetic. The feed keeps stamping rows long after the close — at midnight it
 * still reports a fresh timestamp on yesterday's last trade — so a page that
 * trusted that stamp would announce a "market time" of 22:10 and call a closed
 * session's move "today's".
 *
 * Public holidays are not in here. On one, an open-hours reading will call the
 * previous session's move today's; the delay and the source are still stated,
 * and no figure changes, only its label.
 */
export function sessionOpen(market, at = new Date()) {
  const spec = MARKETS[market];
  if (!spec) return false;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: spec.zone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type) => parts.find((p) => p.type === type)?.value;

  const day = part('weekday');
  if (day === 'Sat' || day === 'Sun') return false;
  const minutes = Number(part('hour')) * 60 + Number(part('minute'));
  return minutes >= spec.session.open && minutes < spec.session.close;
}

/**
 * When today's session opened, in epoch milliseconds, or null when there is no
 * session to speak of.
 *
 * `sessionOpen` answers whether the market is trading; this answers when it
 * started, which is what an intraday chart needs to know where its left edge is.
 * Derived from the same instant rather than from a calendar date, so it needs no
 * opinion about daylight saving: the market's own wall clock says how long it
 * has been open, and that many minutes back from now is the open.
 *
 * Null on a weekend and before the bell — a share has no "today" at 9am, and
 * drawing one would put the previous close on a line labelled with this morning.
 */
export function sessionOpenAt(market, at = new Date()) {
  const spec = MARKETS[market];
  if (!spec) return null;

  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: spec.zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map((p) => [p.type, p.value]));

  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return null;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (minutes < spec.session.open) return null;
  // Floored to the minute the bell went, so the point a caller places just
  // before it lands on its own minute rather than rounding onto the open.
  return Math.floor((at.getTime() - (minutes - spec.session.open) * 60000) / 60000) * 60000;
}

/**
 * Below this share of the portfolio a day estimate is not worth stating.
 *
 * A money-market fund with 2% in shares would produce a real number — its priced
 * slice really did move — but a reader would take it for the fund's own move.
 */
export const MIN_COVERAGE = 10;

/** Weights this far from 100% mean the filing did not parse into a portfolio. */
export const WEIGHT_BAND = [90, 110];

/**
 * What the day's market has done to this fund, from the positions it can price.
 *
 * Each priced position contributes its portfolio weight times its move, so the
 * result is stated at the level of the whole fund: a fund with 30% in shares
 * that rose 2% gets +0.6%, not +2%. Everything unpriced — bonds, deposits, fund
 * units, the non-US foreign listings — is left out of the sum and counted in
 * `priced` instead, so the caller can say how much of the portfolio the number
 * actually covers.
 *
 * A foreign position moves twice over for a lira investor: the share's own move
 * and the currency's. Both are compounded, not added, and a currency whose quote
 * is missing is treated as flat — the share move is the larger part of the
 * signal, and dropping the position entirely over an absent FX tick would cost
 * more than it saves.
 *
 * `reliable` reports whether the filing's own weights add up to a portfolio at
 * all. A handful of reports parse into weights that sum to millions; their row
 * prices are still real, but no total derived from their weights is.
 *
 * @param {object[]} holdings rows from data/holdings/<CODE>.json
 * @param {Record<string, {quotes: object}>} markets quotes keyed by market id
 * @param {Record<string, {change: number|null}>} fx tape quotes, for the currency leg
 * @returns {{move:number, priced:number, count:number, total:number,
 *            reliable:boolean, markets:string[]}|null}
 */
export function estimateMove(holdings, markets, fx = null) {
  if (!Array.isArray(holdings) || !markets) return null;

  let move = 0;
  let priced = 0;
  let count = 0;
  let total = 0;
  const used = new Set();

  for (const holding of holdings) {
    const weight = num(holding?.weight);
    if (weight == null) continue;
    total += weight;

    const quote = quoteFor(holding, markets);
    if (!quote || quote.change == null) continue;

    const leg = MARKETS[quote.market]?.fx;
    const currency = leg ? num(fx?.[leg]?.change) ?? 0 : 0;
    // Compounded, not added: a 2% share in a currency up 1% is 3.02%, and on a
    // devaluation day the difference is the part that matters.
    const local = ((1 + quote.change / 100) * (1 + currency / 100) - 1) * 100;

    // weight is a percentage and so is the move, so one of them divides out.
    move += (weight / 100) * local;
    priced += weight;
    count += 1;
    used.add(quote.market);
  }
  if (!count) return null;

  const [lo, hi] = WEIGHT_BAND;
  return {
    move,
    priced,
    count,
    total,
    reliable: total >= lo && total <= hi,
    markets: [...used],
  };
}
