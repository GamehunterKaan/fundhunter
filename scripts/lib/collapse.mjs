// Whether a fetch's result is plausible enough to write over the last one.
//
// This exists because the alternative actually happened. A deep backfill was
// throttled by TEFAS — 106 requests retried — and the chunk covering the newest
// trading day came back empty. No fund then had a price on the latest date, so
// the active set was empty, and everything downstream did exactly what it was
// told: funds.json was written as `[]`, and the history pruner deleted all 2,068
// files because none of them was in the universe any more.
//
// Nothing downstream was wrong. What was missing was anybody asking whether an
// empty answer was plausible. A fetch that comes back with no funds has failed;
// it has not discovered that Turkey has no funds.
//
// Kept here, pure and tested, because it is the one piece of this pipeline whose
// failure is unrecoverable without git.

/**
 * How far the universe may shrink in one run before the run is presumed broken.
 *
 * Funds do close, but not in droves overnight — the largest real one-day fall in
 * this project's life is a handful. A tenth is far past anything the market does
 * and far short of what a bad fetch does.
 */
export const COLLAPSE_FLOOR = 0.9;

/**
 * Why this result must not be written, or null when it may be.
 *
 * @param {number} found funds priced on the latest trading date this run
 * @param {number} before how many the last run wrote, or 0 if there is no last run
 * @param {{floor?:number, allowShrink?:boolean}} opts
 * @returns {string|null} the reason to refuse, or null to proceed
 */
export function collapseReason(found, before, { floor = COLLAPSE_FLOOR, allowShrink = false } = {}) {
  if (!Number.isFinite(found) || found < 0) return 'the fund count is not a number';
  // Zero is refused even with --allow-shrink and even on a first run. There is
  // no circumstance in which writing an empty universe is the right answer.
  if (found === 0) {
    return 'no funds priced on the latest trading date — this is a failed fetch, '
      + 'not an empty universe; check for throttling';
  }
  if (allowShrink) return null;
  // Nothing on disk to lose, so nothing to protect.
  if (!Number.isFinite(before) || before <= 0) return null;
  if (found < before * floor) {
    return `found ${found} funds where the last run had ${before} — re-run, `
      + 'or pass --allow-shrink if the drop is real';
  }
  return null;
}
