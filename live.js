// Live market quotes for the tape.
//
// This is the one place FundHunter talks to a third party at runtime. Everything
// else is committed JSON, so the rule here is that the page must be no worse off
// when this fails: a timeout, an outage or a blocked request falls back to the
// committed closes, and a value is never labelled "live" unless it came from a
// response in this session.
//
// Yahoo and TEFAS both refuse cross-origin requests, which is why the benchmark
// series are fetched by the cron instead. Truncgil does send
// `Access-Control-Allow-Origin: *`, and it carries the four instruments that
// matter here — BIST 100, the dollar, the euro and gram gold.
//
// DOM-free so the parser can be tested without a browser.

export const LIVE_SOURCE = {
  url: 'https://finans.truncgil.com/v4/today.json',
  name: 'Truncgil',
  home: 'https://finans.truncgil.com',
};

/** How often the tape re-polls while the tab is visible. */
export const LIVE_REFRESH_MS = 60_000;

/** Give up rather than leave the tape waiting on a slow third party. */
export const LIVE_TIMEOUT_MS = 6_000;

/**
 * Our benchmark key -> the source's field name.
 *
 * The money-market index is deliberately absent: it is derived from TEFAS fund
 * NAVs, which are published once a day with a one-day lag, so it cannot be live
 * from any source and must keep saying "close".
 */
const FIELDS = {
  bist100: 'XU100',
  usdtry: 'USD',
  eurtry: 'EUR',
  goldgram: 'GRA',
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Normalise a payload into `{updated, quotes}`, or null if nothing usable came
 * back. Partial responses are fine — whatever parses is used, the rest falls
 * back to the committed close.
 *
 * `Selling` and `Buying` are the ask and bid; the index rows carry only
 * `Selling`. `Change` is the day's percentage move.
 *
 * @param {unknown} payload parsed JSON from LIVE_SOURCE
 * @returns {{updated: string|null, quotes: Record<string, {price:number, change:number|null}>}|null}
 */
export function parseLiveQuotes(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const quotes = {};
  for (const [key, field] of Object.entries(FIELDS)) {
    const row = payload[field];
    if (!row || typeof row !== 'object') continue;
    const price = num(row.Selling) ?? num(row.Buying);
    // A zero or negative quote is a broken feed, not a price.
    if (price == null || price <= 0) continue;
    quotes[key] = { price, change: num(row.Change) };
  }
  if (!Object.keys(quotes).length) return null;

  return {
    updated: typeof payload.Update_Date === 'string' ? payload.Update_Date : null,
    quotes,
  };
}

/**
 * The clock portion of the source's stamp, e.g. "21:55".
 *
 * Deliberately not parsed into a Date: the stamp is local Turkish wall-clock
 * time with no zone on it, and converting it would invent an offset. It is
 * displayed as given.
 */
export function liveClock(updated) {
  const m = /(\d{2}:\d{2})(?::\d{2})?\s*$/.exec(String(updated ?? ''));
  return m ? m[1] : null;
}
