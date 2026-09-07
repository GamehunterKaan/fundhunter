// Is this price plausible for this fund, given what this fund does?
//
// Every guard in this pipeline catches a price that is ABSENT, ZERO or STALE.
// None of them looks at the number itself. A money-market fund that has moved
// 0.1% a day for a year printing a 40% gain would pass the collapse guard, the
// prune grace, `isRealPrice` and the freshness watchdog alike: it is a real
// number, on the right date, for a fund that still exists.
//
// What this deliberately does NOT do is reject one.
//
// Every outlier in twelve months of history was checked against TEFAS before
// this was written, and every single one matched the upstream response exactly:
//
//   NMG  2025-09-08   1.200447 -> 116.87376   and stays there   (redenomination)
//   HUS  2026-01-12   0.511264 -> 0.000229    and climbs from there
//   SMP  2026-07-01   1.087861 -> 1           first day of every quarter
//   KPS  2026-01-12   43.132117 -> 1 -> 1 -> 0             (wound up)
//   RDS  2026-01-29   27.276 -> 8.984364 -> 20.214364      (a spike, reverted)
//
// Only the last of those is wrong, and on the day it printed it was
// indistinguishable from the four above it. A guard that rejected implausible
// prices would have deleted four real redenominations to catch one bad print,
// and a fund whose price is silently held back at yesterday's is a fund whose
// every return is quietly wrong from then on. TEFAS is the source of truth even
// when the truth is strange.
//
// So this reports, and the pipeline acts on exactly one thing it can act on
// safely: a move that happens to EVERYTHING AT ONCE. Across 528,821 real moves
// in 2,048 funds, the worst single day put 5 funds of 1,903 outside their own
// band — 0.28%. Two thousand funds do not redenominate on the same morning, so a
// day where a large share of the market moves impossibly is the feed changing
// units under us, not the market. That is the collapse guard's argument applied
// to values instead of counts, and it is the only automatic refusal here.

/** How many of a fund's own robust standard deviations count as impossible. */
export const IMPLAUSIBLE_K = 12;

/**
 * The smallest move that can ever be called implausible, whatever the band says.
 *
 * A money-market fund's daily move is so tight that twelve of its sigmas is a
 * fraction of a per cent, and a fund that has been flat for a year because it
 * held cash is not lying when it finally moves. 5% is above anything a bond or
 * money-market fund does in a day and well inside what a bad print does.
 */
export const IMPLAUSIBLE_FLOOR = 0.05;

/**
 * Share of a day's printing funds that must be flagged before the run is
 * refused.
 *
 * Measured over twelve months: the median day flags 0.055% of the funds that
 * printed, the worst day in the whole window flags 0.277%. 2% is seven times
 * that worst day, so this cannot fire on a bad Tuesday — only on something that
 * has happened to the feed.
 */
export const MASS_EVENT_SHARE = 0.02;

/** Below this many moves a fund has no distribution worth measuring against. */
export const MIN_MOVES = 30;

/** Prints to look ahead before deciding a move was a level change, not a spike. */
export const CONFIRM_PRINTS = 3;

/** A gap of more days than this is capped: a long weekend is not one huge day. */
const MAX_GAP_DAYS = 4;

const median = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Gap-normalised log returns for a price series.
 *
 * Divided by the square root of the day gap so the Monday after a three-day
 * weekend is measured as what it is — two or three days of variance — rather
 * than read as one enormous move and flagged every holiday.
 *
 * @param {Array<[string, number]>} series ascending [date, price]
 */
export function logMoves(series) {
  const out = [];
  for (let i = 1; i < series.length; i++) {
    const [prevDate, prev] = series[i - 1];
    const [date, price] = series[i];
    if (!(prev > 0) || !(price > 0)) continue;
    const days = Math.max(
      1,
      Math.min(MAX_GAP_DAYS, Math.round((Date.parse(date) - Date.parse(prevDate)) / 86400000))
    );
    const r = Math.log(price / prev) / Math.sqrt(days);
    if (Number.isFinite(r)) out.push({ i, date, from: prev, to: price, r });
  }
  return out;
}

/**
 * The fund's own daily scale, from the median absolute move.
 *
 * A median rather than a standard deviation on purpose: the thing being looked
 * for is a single enormous move, and a standard deviation would let that move
 * widen the band that is supposed to catch it. One redenomination in a year
 * moves a MAD by nothing at all.
 */
export function moveScale(series) {
  const moves = logMoves(series);
  if (moves.length < MIN_MOVES) return null;
  const mad = median(moves.map((m) => Math.abs(m.r)));
  return mad != null ? mad * 1.4826 : null;
}

/**
 * The largest one-day move this fund could make and still be believed, in log
 * space. Null when there is not enough history to say.
 */
export function priceBand(series, { k = IMPLAUSIBLE_K, floor = IMPLAUSIBLE_FLOOR } = {}) {
  const sigma = moveScale(series);
  if (sigma == null) return null;
  return Math.max(k * sigma, Math.log1p(floor));
}

/**
 * Every move in the series that its own history says should not have happened.
 *
 * `shape` says what the days after it did, which is the only thing that tells a
 * redenomination from a bad print — and it is available for every date except
 * the newest few, which is exactly where it is needed and cannot be had:
 *
 *   level   the price stayed at the new level; a split, a redenomination, a
 *           quarterly reset. Real, and the great majority — 305 of 366.
 *   spike   the price came back toward where it was; a bad print. 61 of 366.
 *   edge    too near the end of the series to tell yet.
 *
 * @param {Array<[string, number]>} series ascending [date, price]
 */
export function implausibleMoves(series, opts = {}) {
  const band = priceBand(series, opts);
  if (band == null) return [];
  const confirm = opts.confirm ?? CONFIRM_PRINTS;

  const out = [];
  for (const m of logMoves(series)) {
    if (Math.abs(m.r) <= band) continue;
    const later = series[m.i + confirm];
    let shape = 'edge';
    if (later && later[1] > 0) {
      // Is the price `confirm` prints later closer to where it was before the
      // move, or to where the move took it?
      const towardBefore = Math.abs(Math.log(later[1] / m.from));
      const towardAfter = Math.abs(Math.log(later[1] / m.to));
      shape = towardBefore < towardAfter ? 'spike' : 'level';
    }
    out.push({
      date: m.date,
      from: m.from,
      to: m.to,
      // The move as it actually happened, not the gap-normalised figure the
      // band is measured against. A log line saying a fund moved +885% when
      // TEFAS shows +1306% sends whoever reads it looking for the wrong event.
      pct: (m.to / m.from - 1) * 100,
      ratio: band > 0 ? Math.abs(m.r) / band : Infinity,
      shape,
    });
  }
  return out;
}

/**
 * Why this run must not be written, or null when it may be.
 *
 * Deliberately shaped like `collapseReason`: one sentence a human can act on,
 * decided by a pure function with a number behind it rather than by a feeling
 * at the call site.
 *
 * @param {number} flagged funds whose move on the latest date is implausible
 * @param {number} printed funds that printed on the latest date at all
 */
export function massEventReason(flagged, printed, { share = MASS_EVENT_SHARE } = {}) {
  if (!Number.isFinite(flagged) || !Number.isFinite(printed) || printed <= 0) return null;
  if (flagged <= 1) return null;
  const seen = flagged / printed;
  if (seen <= share) return null;
  return (
    `${flagged} of ${printed} funds priced today moved further than their own ` +
    `history allows (${(seen * 100).toFixed(2)}%, limit ${(share * 100).toFixed(0)}%) — ` +
    'funds do not all redenominate on the same morning, so this is the feed and ' +
    'not the market; re-run, and pass --allow-implausible if it is genuinely real'
  );
}
