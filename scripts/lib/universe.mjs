// Which funds are still part of the universe, and which have actually gone.
//
// The build used to answer that with one line — a fund counts if it reported on
// the latest trading date — and everything downstream was built from the result:
// funds.json, and the prune that deletes the history file of anything not in it.
// That reads a fund publishing an hour late as a fund that no longer exists. It
// vanishes from the site for the day and its history is deleted, and when it
// comes back the file is rebuilt from the fetch window, so anything older than
// twelve months is gone for good.
//
// A closure and a late print look identical on the day. They stop looking
// identical after a few days, which is all the grace below buys: long enough
// that a slow publisher, a suspension or a holiday quirk cannot delete anything,
// short enough that a wound-up fund still leaves within the week.

/** Trading days of grace before a fund that has stopped printing is dropped. */
export const PRUNE_GRACE_DAYS = 5;

/**
 * The oldest date a fund can have last reported on and still be kept.
 *
 * Counted in trading days actually seen in the data rather than in calendar
 * days, so a weekend, a public holiday or a market closure spends none of the
 * grace — the same reason the freshness check compares against TEFAS's own
 * latest date instead of the calendar.
 *
 * @param {Iterable<string>} tradingDays every date the fetch saw, YYYY-MM-DD
 * @param {number} [graceDays]
 * @returns {string|null} cutoff date, or null when there are no dates at all
 */
export function staleCutoff(tradingDays, graceDays = PRUNE_GRACE_DAYS) {
  const days = [...new Set(tradingDays)].sort();
  if (!days.length) return null;
  if (graceDays <= 1) return days.at(-1);
  return days[Math.max(0, days.length - graceDays)];
}

/**
 * Split the funds seen into the ones to publish and the ones to forget.
 *
 * `priced` is kept separate and deliberately strict: it is what the collapse
 * guard reads, and the question it answers is "did this fetch work at all",
 * which grace must not be allowed to soften. A run where every fund is inside
 * its grace window but none priced today is a broken fetch, not a quiet market.
 *
 * @param {Iterable<[string, {prices: Map<string, unknown>}]>} entries
 * @param {string} latestDate
 * @param {string|null} cutoff from `staleCutoff`
 */
export function partitionUniverse(entries, latestDate, cutoff) {
  const priced = [];
  const keep = [];
  const dropped = [];
  for (const entry of entries) {
    const [, f] = entry;
    if (f.prices.has(latestDate)) priced.push(entry);
    const last = lastDate(f.prices);
    if (last && cutoff && last >= cutoff) keep.push(entry);
    else if (last) dropped.push(entry);
  }
  return { priced, keep, dropped };
}

/** The most recent date in a price map, without sorting the whole thing. */
export function lastDate(prices) {
  let max = null;
  for (const d of prices.keys()) if (max === null || d > max) max = d;
  return max;
}
