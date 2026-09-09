import test from 'node:test';
import assert from 'node:assert/strict';
import { isOpenWindow, windowKey, planWindows } from '../scripts/lib/chunks.mjs';

// Two incidents and one silent weekly regression came out of this decision, and
// all three look the same from here: an answer cached while it was still
// incomplete, stored under a key that a later run reads and trusts. The tests
// are written against the keys themselves, because the key IS the bug.

const KINDS = ['YAT', 'BYF'];
const LATEST = '20260907';

// The real 12-month grid on 2026-09-07, newest four blocks.
const GRID = [
  ['20260615', '20260712'],
  ['20260713', '20260809'],
  ['20260810', '20260906'],
  ['20260907', '20261004'],
];

test('a window that reaches the latest trading date is still filling', () => {
  // Incident 1: the newest chunk runs PAST the latest date, so it is open.
  assert.equal(isOpenWindow('20261004', LATEST), true);
  // Incident 10: a window ending exactly on the latest date is the one TEFAS is
  // publishing into right now — rows stamped, prices not yet filled in.
  assert.equal(isOpenWindow('20260907', LATEST), true);
  // And the one that closed this morning is final.
  assert.equal(isOpenWindow('20260906', LATEST), false);
});

test('an open window can never outlive the day it was fetched', () => {
  const key = windowKey({ prefix: 'info-v2', kind: 'YAT', start: '20260907', end: '20261004', latest: LATEST });
  assert.equal(key, 'info-v2-YAT-20260907-20261004-20260907');
  // Tomorrow it is a different key, so tomorrow's run cannot read today's copy.
  const tomorrow = windowKey({ prefix: 'info-v2', kind: 'YAT', start: '20260907', end: '20261004', latest: '20260908' });
  assert.notEqual(key, tomorrow);
});

test('a closed window keeps one key forever, which is what makes a warm run cheap', () => {
  const days = ['20260907', '20260908', '20261101', '20270101'];
  const keys = new Set(days.map((latest) =>
    windowKey({ prefix: 'info-v2', kind: 'YAT', start: '20260810', end: '20260906', latest })));
  assert.deepEqual([...keys], ['info-v2-YAT-20260810-20260906']);
});

// The regression this file exists for.
//
// WIDE_CHUNKS re-reads the newest few chunks once a week to pick up a NAV that
// TEFAS restated after its chunk closed. It used to do that under the OPEN key
// form — tagged with that day's trading date — while every later ordinary run
// went on reading the plain key, which still held the pre-restatement rows. So
// the restatement was on disk for exactly one run and the next day's run wrote
// the old price back over it. Every week, silently, for as long as the wide read
// had existed.
test('a wide read writes the key the next ordinary run will read', () => {
  const wide = planWindows({
    prefix: 'info-v2', kinds: ['YAT'], windows: GRID, latest: LATEST, refreshClosed: 2,
  });
  const narrowTomorrow = planWindows({
    prefix: 'info-v2', kinds: ['YAT'], windows: GRID, latest: '20260908', refreshClosed: 0,
  });

  // Closed only: the open window is always refetched and is not what this is
  // about — see 'the open window is never answered from cache' below.
  const refreshed = wide.filter((j) => j.refresh && !j.open);
  assert.equal(refreshed.length, 2, 'the newest two CLOSED chunks');
  assert.deepEqual(refreshed.map((j) => j.end), ['20260809', '20260906']);

  for (const job of refreshed) {
    const later = narrowTomorrow.find((j) => j.end === job.end);
    assert.equal(job.key, later.key,
      `a wide re-read of ${job.end} must land on the key tomorrow reads, not beside it`);
  }
});

// The regression that made the heal job pointless on the day it shipped.
//
// The open chunk's key carries the trading date, which makes it fresh across
// days and frozen within one: the first run of the morning caches TEFAS
// mid-publication, and every later run that day reads that snapshot back. On
// 2026-09-09 the 06:04 run wrote `1908 of 2068 priced` and the 08:05 re-run
// wrote the identical 1908 while TEFAS had 2,045. A run that exists to find out
// whether the day has finished must not be answered from before it started.
test('the open window is never answered from cache', () => {
  for (const refreshClosed of [0, 3]) {
    const jobs = planWindows({
      prefix: 'info-v2', kinds: KINDS, windows: GRID, latest: LATEST, refreshClosed,
    });
    for (const job of jobs.filter((j) => j.open)) {
      assert.equal(job.refresh, true,
        `an open window must be refetched even with refreshClosed=${refreshClosed}`);
    }
  }
});

test('an ordinary run forces nothing beyond the open window', () => {
  const jobs = planWindows({ prefix: 'info-v2', kinds: KINDS, windows: GRID, latest: LATEST });
  assert.equal(jobs.length, 8);
  // Two of the eight — one open window per kind. The other six are closed and
  // final, which is what makes a warm run cheap.
  assert.equal(jobs.filter((j) => j.refresh).length, 2);
  assert.deepEqual([...new Set(jobs.filter((j) => j.refresh).map((j) => j.end))], ['20261004']);
  // One request per kind per window, and the two kinds never share a key.
  assert.equal(new Set(jobs.map((j) => j.key)).size, 8);
});

test('asking to refresh more closed windows than exist refreshes all of them', () => {
  const jobs = planWindows({
    prefix: 'info-v2', kinds: ['YAT'], windows: GRID, latest: LATEST, refreshClosed: 99,
  });
  assert.equal(jobs.filter((j) => j.refresh).length, 4, 'three closed plus the open one');
});

test('the policy does not care which order the caller lists its windows in', () => {
  // splitRange hands these back oldest first and weeklyAnchors newest first. A
  // policy that read differently for the two callers is exactly the drift this
  // module was extracted to remove.
  const forward = planWindows({ prefix: 'd', kinds: ['YAT'], windows: GRID, latest: LATEST, refreshClosed: 2 });
  const reverse = planWindows({ prefix: 'd', kinds: ['YAT'], windows: [...GRID].reverse(), latest: LATEST, refreshClosed: 2 });
  const byEnd = (jobs) => Object.fromEntries(jobs.map((j) => [j.end, `${j.key}|${j.refresh}`]));
  assert.deepEqual(byEnd(forward), byEnd(reverse));
});

test('the allocation windows adopt the policy without retiring a single key', () => {
  // Incident 11c: bumping the dist keys during a repair turned 30 cold requests
  // into 136 and TEFAS answered 429. Closed windows must keep the exact key the
  // old `dist-${kind}-${s}-${e}` template produced, so adopting this costs one
  // request per kind and not a migration.
  const windows = [['20260905', '20260907'], ['20260829', '20260831'], ['20260822', '20260824']];
  const jobs = planWindows({ prefix: 'dist', kinds: ['YAT'], windows, latest: LATEST });
  const closed = jobs.filter((j) => !j.open);
  assert.deepEqual(closed.map((j) => j.key), ['dist-YAT-20260829-20260831', 'dist-YAT-20260822-20260824']);
  // And the window TEFAS is publishing into right now is the one that changes.
  assert.equal(jobs.find((j) => j.open).key, 'dist-YAT-20260905-20260907-20260907');
});

test('with no latest date nothing is treated as final', () => {
  // A run that could not establish a trading date must not be allowed to write
  // permanent cache entries under it.
  const jobs = planWindows({ prefix: 'info-v2', kinds: ['YAT'], windows: GRID, latest: '' });
  assert.ok(jobs.every((j) => j.open));
});
