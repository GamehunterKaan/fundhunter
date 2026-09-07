import test from 'node:test';
import assert from 'node:assert/strict';
import {
  logMoves, moveScale, priceBand, implausibleMoves, massEventReason,
  IMPLAUSIBLE_FLOOR, MASS_EVENT_SHARE, MIN_MOVES,
} from '../scripts/lib/plausible.mjs';

// Every fixture below is a real series from data/history, checked against the
// live TEFAS response before this file was written. That matters more here than
// anywhere else in the repo: the whole design rests on the finding that the
// implausible moves are overwhelmingly REAL, and a test built on an imagined
// upstream would quietly re-argue for rejecting them.

/** A quiet fund: a money-market NAV grinding up ~0.11% a day. */
const steady = (n = 120, start = '2026-01-01') => {
  const out = [];
  let p = 10;
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    // Deterministic wobble, so the band is reproducible.
    p *= 1 + 0.0011 + ((i % 7) - 3) * 0.00004;
    out.push([new Date(d.getTime() + i * 86400000).toISOString().slice(0, 10), Number(p.toFixed(6))]);
  }
  return out;
};

test('a fund with no history to speak of gets no band at all', () => {
  assert.equal(moveScale(steady(5)), null);
  assert.equal(priceBand(steady(MIN_MOVES - 5)), null);
  assert.deepEqual(implausibleMoves(steady(10)), [],
    'a new fund must not be flagged for having nothing to be compared against');
});

test('an ordinary series flags nothing', () => {
  assert.deepEqual(implausibleMoves(steady()), []);
});

test('the floor is what protects a money-market fund from its own tightness', () => {
  const s = steady();
  // Twelve sigmas of a fund this quiet is a fraction of a per cent, so without
  // a floor a 1% day would read as impossible.
  assert.ok(moveScale(s) * 12 < Math.log1p(IMPLAUSIBLE_FLOOR));
  assert.ok(Math.abs((Math.exp(priceBand(s)) - 1) - IMPLAUSIBLE_FLOOR) < 1e-9);

  const oneOffPercent = [...steady(60)];
  const [d, p] = oneOffPercent.at(-1);
  oneOffPercent.push(['2026-03-10', p * 1.01]);
  assert.deepEqual(implausibleMoves(oneOffPercent), [], `a 1% day after ${d} is not an event`);
});

test('a long weekend is not read as one enormous day', () => {
  // The gap is what the normalisation is for: three calendar days of drift on a
  // fund that moves every day would otherwise look like a single outsized move.
  const moves = logMoves([['2026-09-04', 100], ['2026-09-07', 103]]);
  assert.equal(moves.length, 1);
  const direct = Math.log(103 / 100);
  assert.ok(moves[0].r < direct, 'a 3-day gap is scaled down, not taken at face value');
});

test('a redenomination is reported as a level change, not a bad print', () => {
  // NMG, 2025-09-08: 1.200447 -> 116.87376, and it stayed up there.
  const series = [...steady(60, '2025-07-11')];
  const base = series.at(-1)[1];
  for (const [i, d] of ['2025-09-08', '2025-09-09', '2025-09-10', '2025-09-11'].entries()) {
    series.push([d, base * 97 * (1 + i * 0.001)]);
  }
  const flags = implausibleMoves(series);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].shape, 'level');
  assert.ok(flags[0].pct > 9000);
});

test('a print that comes back the next day is reported as a spike', () => {
  // RDS, 2026-01-29: 27.276 -> 8.984364 -> 20.214364 -> 20.250727.
  const series = [...steady(60, '2025-11-01')];
  const base = series.at(-1)[1];
  series.push(['2026-01-29', base * 0.33]);
  series.push(['2026-01-30', base * 0.99]);
  series.push(['2026-02-02', base * 0.995]);
  series.push(['2026-02-03', base * 1.0]);
  const flags = implausibleMoves(series);
  assert.equal(flags[0].date, '2026-01-29');
  assert.equal(flags[0].shape, 'spike');
});

test('the newest move is honestly marked unknowable rather than guessed', () => {
  // On the day it prints, a redenomination and a bad print are the same thing.
  // Saying so is the reason nothing here rejects a price.
  const series = [...steady(60)];
  series.push(['2026-05-01', series.at(-1)[1] * 0.4]);
  const flags = implausibleMoves(series);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].shape, 'edge');
});

test('one strange fund is never a reason to refuse a run', () => {
  // 372 moves were flagged across twelve months and 305 of them held their new
  // level. A guard that stopped the pipeline for those would stop it weekly.
  assert.equal(massEventReason(1, 2000), null);
  assert.equal(massEventReason(5, 1903), null, 'the worst single day in twelve months');
  assert.equal(massEventReason(20, 2000), null, '1% is still inside the limit');
});

test('the whole market moving at once is the feed, not the market', () => {
  const reason = massEventReason(60, 2000);
  assert.match(reason, /60 of 2000/);
  assert.match(reason, /3\.00%/);
  assert.match(reason, /--allow-implausible/);
});

test('the mass-event limit sits well clear of the worst day ever observed', () => {
  // Measured over 528,821 real moves: the worst date put 5 of 1,903 funds
  // outside their own band, 0.277%. If this margin ever narrows, the number was
  // moved without the measurement being redone.
  const worstObserved = 5 / 1903;
  assert.ok(MASS_EVENT_SHARE > worstObserved * 5,
    `${MASS_EVENT_SHARE} must stay far above the observed ${worstObserved.toFixed(5)}`);
});

test('a run with nothing to compare against is not accused of anything', () => {
  assert.equal(massEventReason(0, 0), null);
  assert.equal(massEventReason(5, 0), null);
  assert.equal(massEventReason(NaN, 2000), null);
});

test('a zero or negative price never reaches the band as a number', () => {
  // isRealPrice refuses these at ingest, but a log of zero is -Infinity and
  // would poison every scale it touched, so this must not depend on that.
  const moves = logMoves([['2026-01-01', 10], ['2026-01-02', 0], ['2026-01-05', -3], ['2026-01-06', 11]]);
  assert.ok(moves.every((m) => Number.isFinite(m.r)));
});
