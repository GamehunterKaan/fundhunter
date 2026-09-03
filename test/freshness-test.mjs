import test from 'node:test';
import assert from 'node:assert/strict';
import { freshnessVerdict } from '../scripts/lib/freshness.mjs';

// The watchdog's whole job is to be right about two things: silent when the site
// is current, including on every weekend and public holiday, and loud the moment
// it is not. A false alarm every Sunday is how a watchdog gets turned off — and
// a grace period is how one gets ignored at exactly the hour it is needed.

const at = (iso) => new Date(iso);
const hoursBefore = (iso, h) => new Date(Date.parse(iso) - h * 3600000).toISOString();

test('agreeing with TEFAS is the only definition of current', () => {
  const v = freshnessVerdict({
    siteDate: '2026-09-01', tefasDate: '2026-09-01', now: at('2026-09-01T20:00:00Z'),
  });
  assert.equal(v.ok, true);
  assert.equal(v.level, 'none');
});

test('a weekend is quiet, because TEFAS is behind the calendar too', () => {
  // Sunday. TEFAS's newest date is Friday's, and so is the site's: nothing is
  // wrong, and a check written against the calendar would cry every weekend.
  const v = freshnessVerdict({
    siteDate: '2026-08-28', tefasDate: '2026-08-28', now: at('2026-08-30T18:00:00Z'),
  });
  assert.equal(v.ok, true);
});

// The regression this file exists for. The first version forgave a gap before
// 09:00 UTC on the theory that TEFAS had not published yet. On 2026-09-03 TEFAS
// had published, the site was a day behind at 04:37, and the watchdog said
// "grace" and did nothing. There is no hour at which a real gap is acceptable.
test('a gap before dawn is still a gap', () => {
  const now = at('2026-09-03T04:37:00Z');
  const v = freshnessVerdict({
    siteDate: '2026-09-02',
    tefasDate: '2026-09-03',
    lastUpdated: hoursBefore(now.toISOString(), 1),
    now,
  });
  assert.equal(v.ok, false);
  assert.equal(v.level, 'heal', 'must act, not wait for a business hour');
  assert.equal(v.behindDays, 1);
});

test('a fresh gap asks for a re-run rather than a person', () => {
  const now = at('2026-09-03T12:00:00Z');
  const v = freshnessVerdict({
    siteDate: '2026-09-02',
    tefasDate: '2026-09-03',
    lastUpdated: hoursBefore(now.toISOString(), 0.5),
    now,
  });
  assert.equal(v.level, 'heal');
});

test('a gap the site has not moved out of for hours wants a person', () => {
  // Re-running shows up in lastUpdated within minutes. Hours of no movement
  // means re-running has already been tried and has not worked.
  const now = at('2026-09-03T12:00:00Z');
  const v = freshnessVerdict({
    siteDate: '2026-09-02',
    tefasDate: '2026-09-03',
    lastUpdated: hoursBefore(now.toISOString(), 7),
    now,
  });
  assert.equal(v.level, 'alert');
});

test('the same gap is judged the same whether it opens at dawn or at noon', () => {
  const mk = (nowIso) => freshnessVerdict({
    siteDate: '2026-09-02',
    tefasDate: '2026-09-03',
    lastUpdated: hoursBefore(nowIso, 1),
    now: at(nowIso),
  }).level;
  assert.equal(mk('2026-09-03T04:00:00Z'), mk('2026-09-03T14:00:00Z'));
});

test('more than a weekend behind is a person either way', () => {
  const now = at('2026-09-01T06:00:00Z');
  const v = freshnessVerdict({
    siteDate: '2026-08-26',
    tefasDate: '2026-09-01',
    lastUpdated: hoursBefore(now.toISOString(), 0.2),
    now,
  });
  assert.equal(v.level, 'alert');
  assert.equal(v.behindDays, 6);
});

test('a site that will not say its own date is the loudest failure', () => {
  const v = freshnessVerdict({
    siteDate: null, tefasDate: '2026-09-01', now: at('2026-09-01T06:00:00Z'),
  });
  assert.equal(v.ok, false);
  assert.equal(v.level, 'alert');
  assert.match(v.reason, /did not return a latestDate/);
});

test('and so is a TEFAS that will not answer', () => {
  const v = freshnessVerdict({
    siteDate: '2026-09-01', tefasDate: null, now: at('2026-09-01T06:00:00Z'),
  });
  assert.equal(v.level, 'alert');
});

test('a missing lastUpdated is treated as stuck, not as fine', () => {
  const v = freshnessVerdict({
    siteDate: '2026-09-02', tefasDate: '2026-09-03', now: at('2026-09-03T06:00:00Z'),
  });
  assert.equal(v.level, 'alert');
});

test('a site somehow ahead of TEFAS is not stale', () => {
  const v = freshnessVerdict({
    siteDate: '2026-09-02', tefasDate: '2026-09-01', now: at('2026-09-02T20:00:00Z'),
  });
  assert.equal(v.ok, true);
});
