import test from 'node:test';
import assert from 'node:assert/strict';

import { collapseReason, COLLAPSE_FLOOR } from '../scripts/lib/collapse.mjs';

// The guard that stands between a throttled fetch and the history directory.
// It was written after a backfill wrote an empty universe and pruned all 2,068
// history files behind it, so these are the cases that actually happened.

test('an empty result is refused, always', () => {
  // The case that fired: TEFAS throttled the chunk covering the newest trading
  // day, no fund had a price on it, and everything downstream obeyed.
  assert.ok(collapseReason(0, 2068));
  // Refused even with the escape hatch, and even with nothing on disk to lose.
  assert.ok(collapseReason(0, 2068, { allowShrink: true }));
  assert.ok(collapseReason(0, 0));
  // There is no circumstance in which writing an empty universe is right.
});

test('a collapse is refused and ordinary movement is not', () => {
  assert.ok(collapseReason(12, 2068));
  assert.ok(collapseReason(1800, 2068));
  // Funds close, but not in droves overnight.
  assert.equal(collapseReason(2000, 2068), null);
  assert.equal(collapseReason(2068, 2068), null);
  assert.equal(collapseReason(2100, 2068), null);
  // Exactly at the floor is not below it.
  assert.equal(collapseReason(Math.ceil(2068 * COLLAPSE_FLOOR), 2068), null);
});

test('a first run has nothing to lose and is let through', () => {
  assert.equal(collapseReason(500, 0), null);
  assert.equal(collapseReason(500, null), null);
  assert.equal(collapseReason(500, undefined), null);
});

test('a real shrink stays publishable, deliberately', () => {
  // The guard must not become a wall: if the drop is real, it can be overridden.
  assert.ok(collapseReason(12, 2068));
  assert.equal(collapseReason(12, 2068, { allowShrink: true }), null);
});

test('the floor is an argument, and nonsense is refused', () => {
  assert.equal(collapseReason(1800, 2068, { floor: 0.5 }), null);
  assert.ok(collapseReason(1800, 2068, { floor: 0.95 }));
  assert.ok(collapseReason(NaN, 2068));
  assert.ok(collapseReason(-1, 2068));
});

test('the reason says what to do about it', () => {
  // This message is the only thing standing between a cron failure and somebody
  // re-running the same broken fetch, so it names the fix.
  assert.match(collapseReason(0, 2068), /throttl/);
  assert.match(collapseReason(12, 2068), /allow-shrink/);
  assert.match(collapseReason(12, 2068), /2068/);
});
