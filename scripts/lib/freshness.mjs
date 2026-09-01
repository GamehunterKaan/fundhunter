// Is what the site is serving as new as what TEFAS has?
//
// Deliberately phrased against the two ends and nothing in between. Every way
// this has actually gone wrong — a fetch that refused to write, a commit that
// died in a rebase, a service worker answering from yesterday's cache, a Pages
// deploy that did not happen — looks identical from here: the date on the live
// site is behind the date TEFAS is publishing. Checking the outcome catches all
// of them at once, including the next one, which will have a cause nobody has
// thought of yet.
//
// Comparing against TEFAS's own latest date rather than against the calendar is
// what makes this quiet on weekends and public holidays: on a Sunday TEFAS's
// newest date is Friday's, the site's is Friday's, and there is nothing to say.

/**
 * @param {object} o
 * @param {string|null} o.siteDate    `meta.latestDate` from the live site, YYYY-MM-DD
 * @param {string|null} o.tefasDate   newest date TEFAS has data for, YYYY-MM-DD
 * @param {Date} o.now
 * @param {number} [o.healAfterUtcHour]  hour past which being behind means something broke
 * @param {number} [o.alertAfterUtcHour] hour past which being behind is worth waking someone
 * @returns {{ok: boolean, level: 'none'|'grace'|'heal'|'alert', behindDays: number, reason: string}}
 */
export function freshnessVerdict({
  siteDate,
  tefasDate,
  now,
  healAfterUtcHour = 9,
  alertAfterUtcHour = 15,
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
  const hour = now.getUTCHours();
  // A gap of four days has a whole weekend inside it, so it is more than one
  // missed trading day however the calendar fell — wrong at any hour of any day.
  // Below that, the morning is grace: TEFAS publishes the day's price before the
  // job that collects it has run, and a site that is briefly behind at 07:00 is
  // a site waiting for a job, not a broken one.
  const level =
    behindDays >= 4 || hour >= alertAfterUtcHour
      ? 'alert'
      : hour >= healAfterUtcHour
        ? 'heal'
        : 'grace';

  return {
    ok: false,
    level,
    behindDays,
    reason: `the site is serving ${siteDate}, TEFAS has ${tefasDate} (${behindDays} day${behindDays === 1 ? '' : 's'} behind)`,
  };
}
