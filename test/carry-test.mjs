import test from 'node:test';
import assert from 'node:assert/strict';
import {
  carryForward, carryReport, CARRIED_FIELDS, CARRY_NOTICE_SHARE,
} from '../scripts/lib/carry.mjs';

// The third time this repo has had to learn that an absent value is TEFAS not
// answering rather than a fact about the fund — after a late fund read as a
// delisted one, and a blank price read as a fund worth nothing. This one was
// caught by running the fetch and diffing its output against what was already
// committed: 466 funds would have lost their official risk value to nulls that
// arrived on one bad afternoon.

const row = (over = {}) => ({
  c: 'AAA', n: 'A FUND', p: 12.5, d: '2026-09-07', sz: 1e9, iv: 100,
  risk: null, tefas: null, cat: null, mgmtFee: null, maxMgmtFee: null, expenseRatio: null,
  ...over,
});

test('a field TEFAS declined to answer keeps its last known value', () => {
  const prev = row({ risk: 2, tefas: true, cat: 'Serbest Şemsiye Fonu', expenseRatio: 3.65 });
  const { row: out, carried } = carryForward(row(), prev);
  assert.equal(out.risk, 2);
  assert.equal(out.tefas, true);
  assert.equal(out.cat, 'Serbest Şemsiye Fonu');
  assert.equal(out.expenseRatio, 3.65);
  assert.deepEqual(carried.sort(), ['cat', 'expenseRatio', 'risk', 'tefas']);
});

test('an answer that did arrive is never overwritten by an older one', () => {
  const prev = row({ risk: 2, expenseRatio: 3.65 });
  const { row: out, carried } = carryForward(row({ risk: 5, expenseRatio: 1.2 }), prev);
  assert.equal(out.risk, 5);
  assert.equal(out.expenseRatio, 1.2);
  assert.deepEqual(carried, []);
});

test('false is an answer, not an absence', () => {
  // `tefas: false` means the fund cannot be bought on the platform. Carrying
  // yesterday's `true` over it would tell a reader they can buy something they
  // cannot, which is the one direction this must never fail in.
  const { row: out, carried } = carryForward(row({ tefas: false }), row({ tefas: true }));
  assert.equal(out.tefas, false);
  assert.deepEqual(carried, []);
});

test('a zero fee is already an absence by the time it gets here', () => {
  // TEFAS writes an unpublished fee as "0" and fetch-tefas normalises that to
  // null before this ever sees it — incident 4. So a null arriving here really
  // does mean "not published", and carrying is right.
  const { row: out } = carryForward(row({ expenseRatio: null }), row({ expenseRatio: 2 }));
  assert.equal(out.expenseRatio, 2);
});

test('nothing that is an observation of a day is ever carried', () => {
  // The price, the date, the size and the investor count are measurements. A
  // measurement that did not happen must not be invented — that is the whole
  // reason a zero price is refused rather than replaced.
  for (const field of ['p', 'd', 'sz', 'iv', 'n', 'r', 'vol', 'mdd']) {
    assert.ok(!CARRIED_FIELDS.includes(field), `${field} must never be carried`);
  }
  const { row: out } = carryForward(row({ p: null, d: null, sz: null }), row({ p: 99, d: '2026-01-01', sz: 5 }));
  assert.equal(out.p, null);
  assert.equal(out.d, null);
  assert.equal(out.sz, null);
});

test('a fund with no previous row is left exactly as it was built', () => {
  const built = row({ risk: 3 });
  const { row: out, carried } = carryForward(built, null);
  assert.equal(out, built, 'no copy is made when there is nothing to carry');
  assert.deepEqual(carried, []);
});

test('a row that needs nothing is not copied', () => {
  const built = row({ risk: 3, tefas: true, cat: 'X', mgmtFee: 1, maxMgmtFee: 2, expenseRatio: 3 });
  const { row: out } = carryForward(built, row({ risk: 9 }));
  assert.equal(out, built);
});

test('the report says which field and how many, and shouts when it is not a handful', () => {
  assert.equal(carryReport({}, 2065), null);
  assert.equal(carryReport({ risk: 0 }, 2065), null);
  assert.equal(carryReport({ risk: 5 }, 0), null);

  const quiet = carryReport({ risk: 12, expenseRatio: 3 }, 2065);
  assert.match(quiet.line, /risk 12, expenseRatio 3 \(of 2065 funds\)/);
  assert.equal(quiet.loud, false);

  // The afternoon of 2026-09-07: 466 of 2,065, which is 22.6%.
  const loud = carryReport({ risk: 466 }, 2065);
  assert.equal(loud.loud, true);
  assert.ok(466 / 2065 > CARRY_NOTICE_SHARE);
});
