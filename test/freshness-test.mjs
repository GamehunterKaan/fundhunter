import test from 'node:test';
import assert from 'node:assert/strict';
import { freshnessVerdict } from '../scripts/lib/freshness.mjs';

// The watchdog's whole job is to be right about two things: silent when the
// site is current, including on every weekend and public holiday, and loud when
// it is not. A false alarm every Sunday is how a watchdog gets turned off.

const at = (iso) => new Date(iso);

test('agreeing with TEFAS is the only definition of current', () => {
  const v = freshnessVerdict({ siteDate: '2026-09-01', tefasDate: '2026-09-01', now: at('2026-09-01T20:00:00Z') });
  assert.equal(v.ok, true);
  assert.equal(v.level, 'none');
});

test('a weekend is quiet, because TEFAS is behind the calendar too', () => {
  // Sunday. TEFAS's newest date is Friday's, and so is the site's: nothing is
  // wrong, and a check written against the calendar would cry every weekend.
  const v = freshnessVerdict({ siteDate: '2026-08-28', tefasDate: '2026-08-28', now: at('2026-08-30T18:00:00Z') });
  assert.equal(v.ok, true);
});

test('the morning is grace, not a fault', () => {
  // TEFAS publishes the day's price before the job that collects it has run.
  const v = freshnessVerdict({ siteDate: '2026-08-31', tefasDate: '2026-09-01', now: at('2026-09-01T07:00:00Z') });
  assert.equal(v.ok, false);
  assert.equal(v.level, 'grace');
});

test('still behind by mid-morning means something broke, so heal', () => {
  const v = freshnessVerdict({ siteDate: '2026-08-31', tefasDate: '2026-09-01', now: at('2026-09-01T10:00:00Z') });
  assert.equal(v.level, 'heal');
  assert.equal(v.behindDays, 1);
});

test('still behind by the afternoon is worth waking someone', () => {
  const v = freshnessVerdict({ siteDate: '2026-08-31', tefasDate: '2026-09-01', now: at('2026-09-01T16:00:00Z') });
  assert.equal(v.level, 'alert');
});

test('more than a weekend behind is wrong at any hour', () => {
  // 06:00 would be grace for a one-day gap. A gap this wide has a whole weekend
  // inside it, so it is a missed trading day however the calendar fell.
  const v = freshnessVerdict({ siteDate: '2026-08-26', tefasDate: '2026-09-01', now: at('2026-09-01T06:00:00Z') });
  assert.equal(v.level, 'alert');
  assert.equal(v.behindDays, 6);
});

test('a site that will not say its own date is the loudest failure', () => {
  const v = freshnessVerdict({ siteDate: null, tefasDate: '2026-09-01', now: at('2026-09-01T06:00:00Z') });
  assert.equal(v.ok, false);
  assert.equal(v.level, 'alert');
  assert.match(v.reason, /did not return a latestDate/);
});

test('and so is a TEFAS that will not answer', () => {
  const v = freshnessVerdict({ siteDate: '2026-09-01', tefasDate: null, now: at('2026-09-01T06:00:00Z') });
  assert.equal(v.level, 'alert');
});

test('a site somehow ahead of TEFAS is not stale', () => {
  const v = freshnessVerdict({ siteDate: '2026-09-02', tefasDate: '2026-09-01', now: at('2026-09-02T20:00:00Z') });
  assert.equal(v.ok, true);
});
