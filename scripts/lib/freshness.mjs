// Is what the site is serving as new as what TEFAS has?
//
// Deliberately phrased against the two ends and nothing in between. Every way
// this has actually gone wrong — a fetch that refused to write over a poisoned
// cache, a commit that died in a rebase, a service worker answering from
// yesterday's copy, a Pages deploy that did not happen, a scheduled run that
// never fired — looks identical from here: the date on the live site is behind
// the date TEFAS is publishing. Checking the outcome catches all of them at
// once, including the next one, which will have a cause nobody has thought of.
//
// Comparing against TEFAS's own latest date rather than against the calendar is
// what makes this quiet on weekends and public holidays: on a Sunday TEFAS's
// newest date is Friday's, the site's is Friday's, and there is nothing to say.
//
// There is no grace period, and the first version's was a bug rather than a
// nicety. It waited until 09:00 UTC before treating a gap as real, on the
// assumption that TEFAS publishes late enough in the morning that an earlier
// gap only meant the daily job had not had its turn. On 2026-09-03 this watched
// the site sit a day behind at 04:37, said "grace", and did nothing — TEFAS had
// published hours earlier, and the reader found it before the watchdog would
// have. The assumption was never needed either way: the comparison is against
// what TEFAS actually has, so a day TEFAS has not published yet reads as
// current, not as a gap to be forgiven. A gap here has always meant something
// is wrong, at any hour.

/**
 * @param {object} o
 * @param {string|null} o.siteDate     `meta.latestDate` from the live site, YYYY-MM-DD
 * @param {string|null} o.tefasDate    newest date TEFAS has data for, YYYY-MM-DD
 * @param {string|null} [o.lastUpdated] `meta.lastUpdated` from the live site, ISO
 * @param {Date} o.now
 * @param {number} [o.alertAfterHoursStuck] hours of being behind without the site
 *   moving at all before this stops being something a re-run will fix
 * @returns {{ok: boolean, level: 'none'|'heal'|'alert', behindDays: number, reason: string}}
 */
export function freshnessVerdict({
  siteDate,
  tefasDate,
  lastUpdated = null,
  now,
  alertAfterHoursStuck = 6,
}) {
  // Not knowing is its own failure, and a louder one than being a day behind: a
  // site that will not answer for its own date cannot be checked at all.
  if (!siteDate || !tefasDate) {
    return {
      ok: false,
      level: 'alert',
      behindDays: 0,
      reason: !siteDate
        ? 'the live site did not return a latestDate'
        : 'TEFAS did not return a trading date',
    };
  }

  if (siteDate >= tefasDate) {
    return { ok: true, level: 'none', behindDays: 0, reason: `current at ${siteDate}` };
  }

  const behindDays = Math.round((Date.parse(tefasDate) - Date.parse(siteDate)) / 86400000);

  // How long the site has gone without moving at all. A re-run that is working
  // shows up here within minutes, so a stale site whose last update is hours old
  // is a site where re-running has already been tried and has not helped —
  // which is the moment to stop retrying quietly and tell someone. Measured
  // against the site's own clock rather than the hour of the day, so it reads
  // the same for a gap that opens at 04:00 and one that opens at noon.
  const hoursStuck = lastUpdated
    ? (now.getTime() - Date.parse(lastUpdated)) / 3600000
    : Infinity;

  // A gap of four days has a whole weekend inside it, so it is more than one
  // missed trading day however the calendar fell.
  const level =
    behindDays >= 4 || hoursStuck >= alertAfterHoursStuck ? 'alert' : 'heal';

  const stuckNote = Number.isFinite(hoursStuck)
    ? `, last updated ${hoursStuck.toFixed(1)}h ago`
    : '';
  return {
    ok: false,
    level,
    behindDays,
    reason:
      `the site is serving ${siteDate}, TEFAS has ${tefasDate} ` +
      `(${behindDays} day${behindDays === 1 ? '' : 's'} behind${stuckNote})`,
  };
}
