// Which cache key a date window gets, and when a cached answer has to be thrown
// away rather than trusted.
//
// Two incidents came out of this one decision and both were expensive.
//
// The first (2026-08-31): the newest chunk of the price grid extends PAST the
// latest trading date, so it is still filling up while its key stays put. Every
// run for a fortnight replayed a snapshot taken on 17 August. The fix was to tag
// the open chunk with the trading date.
//
// The second (2026-09-07): a chunk that CLOSES reverts to its plain key — and
// the plain key still held the entry cached before that fix existed, written
// while the chunk was incomplete. It sat unused for a week and was picked up the
// moment the grid rolled into a new 28-day block, three weeks stale, for 822
// funds. The fix was a manual `info-v2-` bump.
//
// Both are the same mistake: the openness of a window was decided by where it
// sat in an array rather than by the dates in it, so the two facts could drift
// apart. Here it is derived from the dates alone and there is nowhere for it to
// drift to:
//
//   end >= latest   the window can still gain rows -> key carries the trading
//                   date, so every run of a new day fetches its own copy
//   end <  latest   the window is complete and final -> one canonical key,
//                   stable forever, which is what makes a warm run cheap
//
// The third thing this fixes was never written down as an incident because
// nobody noticed it. `WIDE_CHUNKS` re-reads the newest few chunks once a week to
// catch a NAV that TEFAS restated after its chunk closed — but it re-read them
// under the OPEN key form, tagged with that day's trading date, while every
// later narrow run went on reading the plain key. So the restatement landed on
// disk for exactly one run and the next day's run wrote the pre-restatement
// price back over it, every week, forever. A wide read has to refresh the key
// that will actually be read next, which is what `refresh` is for: skip the
// cached copy, fetch, and write the answer back to the canonical key.

/**
 * Can this window still gain rows?
 *
 * `>=` and not `>`: a window ending exactly on the latest trading date is the
 * one TEFAS is publishing into right now. That is the incident-10 window, where
 * a row exists with the date stamped and the price not yet filled in, and
 * caching it under a stable key is how that gets frozen in.
 *
 * @param {string} end    window end, YYYYMMDD
 * @param {string} latest latest trading date, YYYYMMDD
 */
export const isOpenWindow = (end, latest) => !latest || String(end) >= String(latest);

/**
 * The cache key for one window.
 *
 * A closed window's key never mentions the trading date, so it is the same key
 * tomorrow and the run after that — that is the whole value of the disk cache.
 * An open window's key always does, so it cannot outlive the day it was fetched.
 */
export function windowKey({ prefix, kind, start, end, latest }) {
  const tag = isOpenWindow(end, latest) ? `-${latest}` : '';
  return `${prefix}-${kind}-${start}-${end}${tag}`;
}

/**
 * Turn a set of date windows into the requests to make for them.
 *
 * @param {object} o
 * @param {string} o.prefix          cache-key prefix, e.g. 'info-v2'
 * @param {string[]} o.kinds         fund kinds to request each window for
 * @param {Array<[string,string]>} o.windows  [startYmd, endYmd], any order
 * @param {string} o.latest          latest trading date, YYYYMMDD
 * @param {number} [o.refreshClosed] how many of the newest CLOSED windows to
 *   re-read past the cache. Zero on an ordinary run; the wide read's whole job.
 * @returns {Array<{kind:string,start:string,end:string,open:boolean,refresh:boolean,key:string}>}
 */
export function planWindows({ prefix, kinds, windows, latest, refreshClosed = 0 }) {
  // By end date rather than by position: `weeklyAnchors` hands these back newest
  // first and `splitRange` oldest first, and a policy that reads differently
  // depending on which caller it is talking to is the bug this module exists to
  // remove.
  const closedEnds = windows
    .map(([, end]) => String(end))
    .filter((end) => !isOpenWindow(end, latest))
    .sort();
  const refreshFrom = refreshClosed > 0 && closedEnds.length
    ? closedEnds[Math.max(0, closedEnds.length - refreshClosed)]
    : null;

  const jobs = [];
  for (const kind of kinds) {
    for (const [start, end] of windows) {
      const open = isOpenWindow(end, latest);
      jobs.push({
        kind,
        start: String(start),
        end: String(end),
        open,
        // An OPEN window is never served from cache, only written to it.
        //
        // Tagging its key with the trading date makes it fresh across days and
        // does nothing at all within one, which is the half that mattered: the
        // first run of the morning caches TEFAS mid-publication and every later
        // run that day reads that snapshot back. On 2026-09-09 the 06:04 run
        // wrote `1908 of 2068 priced` and the 08:05 re-run wrote the identical
        // 1908, while TEFAS itself had 2,045 — so the re-run that exists to
        // finish the day could not see the day had finished.
        //
        // That is incident 1 one level down, and it would have made the `heal`
        // job in prices.yml a loop that retries three times and improves
        // nothing. The saving it bought was two requests of about eighty.
        refresh: open || (refreshFrom != null && String(end) >= refreshFrom),
        key: windowKey({ prefix, kind, start, end, latest }),
      });
    }
  }
  return jobs;
}
