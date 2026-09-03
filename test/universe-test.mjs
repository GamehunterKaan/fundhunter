import test from 'node:test';
import assert from 'node:assert/strict';
import { staleCutoff, partitionUniverse, lastDate, PRUNE_GRACE_DAYS } from '../scripts/lib/universe.mjs';

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
