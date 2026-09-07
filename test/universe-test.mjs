import test from 'node:test';
import assert from 'node:assert/strict';
import {
  staleCutoff, partitionUniverse, lastDate, isRealPrice, PRUNE_GRACE_DAYS,
} from '../scripts/lib/universe.mjs';

// A fund that publishes an hour late and a fund that has wound up look the same
// on the day. The build used to treat both as gone, which deleted the late
// one's history and rebuilt it from the fetch window — losing anything older
// than that. These are the cases that separate them.

const fund = (...dates) => [dates.at(-1) ?? 'x', { prices: new Map(dates.map((d) => [d, 1])) }];
const days = ['2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03'];

test('the cutoff is counted in trading days, not calendar days', () => {
  // Five days of grace off a list ending 09-03 reaches back to 08-28 — across a
  // weekend that costs nothing, which is the point.
  assert.equal(staleCutoff(days, 5), '2026-08-28');
});

test('duplicate and unsorted input does not move the cutoff', () => {
  const shuffled = [...days].reverse().concat(days);
  assert.equal(staleCutoff(shuffled, 5), staleCutoff(days, 5));
});

test('a short history cannot push the cutoff off the end', () => {
  assert.equal(staleCutoff(['2026-09-02', '2026-09-03'], 5), '2026-09-02');
});

test('no dates at all has no cutoff to give', () => {
  assert.equal(staleCutoff([], 5), null);
});

test('a fund that printed today is priced and kept', () => {
  const f = fund('2026-09-02', '2026-09-03');
  const { priced, keep, dropped } = partitionUniverse([f], '2026-09-03', '2026-08-28');
  assert.equal(priced.length, 1);
  assert.equal(keep.length, 1);
  assert.equal(dropped.length, 0);
});

// The case this file exists for.
test('a fund silent today but inside the grace window is kept, not deleted', () => {
  const f = fund('2026-09-01', '2026-09-02');
  const { priced, keep, dropped } = partitionUniverse([f], '2026-09-03', '2026-08-28');
  assert.equal(priced.length, 0, 'it did not print today');
  assert.equal(keep.length, 1, 'and must still be published, at its own date');
  assert.equal(dropped.length, 0, 'and must not lose its history');
});

test('a fund silent past the grace window is dropped', () => {
  const f = fund('2026-08-25', '2026-08-26');
  const { keep, dropped } = partitionUniverse([f], '2026-09-03', '2026-08-28');
  assert.equal(keep.length, 0);
  assert.equal(dropped.length, 1);
});

test('priced stays strict, so the collapse guard still sees a failed fetch', () => {
  // Every fund inside its grace window, none priced today. That is a broken
  // fetch, and grace must not let it read as a quiet market.
  const entries = [fund('2026-09-02'), fund('2026-09-01'), fund('2026-09-02')];
  const { priced, keep } = partitionUniverse(entries, '2026-09-03', '2026-08-28');
  assert.equal(priced.length, 0, 'the guard must still get a zero');
  assert.equal(keep.length, 3);
});

test('the grace default is the documented one', () => {
  assert.equal(PRUNE_GRACE_DAYS, 5);
  assert.equal(staleCutoff(days), staleCutoff(days, PRUNE_GRACE_DAYS));
});

test('lastDate reads the newest key without needing a sorted map', () => {
  assert.equal(lastDate(new Map([['2026-09-02', 1], ['2026-08-11', 1], ['2026-09-01', 1]])), '2026-09-02');
  assert.equal(lastDate(new Map()), null);
});

// 2026-09-07: the run landed at 05:47 UTC, while TEFAS was still publishing. It
// had stamped rows with the day's date carrying investor counts and an empty
// price, and 832 of 2073 funds went to the site at a price of zero and a change
// of -100%. Every check downstream agreed they had priced, because a row for the
// date existed.
test('a zero is not a price, whatever shape it arrives in', () => {
  assert.equal(isRealPrice(0), false, 'the 09-07 case');
  assert.equal(isRealPrice(-1), false);
  assert.equal(isRealPrice(null), false);
  assert.equal(isRealPrice(undefined), false);
  assert.equal(isRealPrice(NaN), false);
  assert.equal(isRealPrice('2.5'), false, 'a string is a parse that did not happen');
  assert.equal(isRealPrice(Infinity), false);
});

test('a real price of any plausible size is kept', () => {
  assert.equal(isRealPrice(2.268487), true);
  assert.equal(isRealPrice(9140.087628), true);
  assert.equal(isRealPrice(0.000001), true, 'small is not the same as absent');
});

test('a fund whose price has not landed is late, not wiped out', () => {
  // With the zero row refused at ingest the fund simply has no print today, so
  // the grace window carries it at yesterday's real figure — which is the whole
  // reason the two fixes belong together.
  const f = ['PHE', { prices: new Map([['2026-09-04', 1]]) }];
  const { priced, keep, dropped } = partitionUniverse([f], '2026-09-07', '2026-08-31');
  assert.equal(priced.length, 0, 'it has not priced today');
  assert.equal(keep.length, 1, 'and must keep yesterday, not show zero');
  assert.equal(dropped.length, 0);
});
