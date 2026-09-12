import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { COLUMNS, parseChart, shape } from '../scripts/fetch-stocks.mjs';
import {
  historyResponseIsCurrent, quoteDateOf, yahooCacheContext, yahooCacheKey,
} from '../scripts/lib/stock-dates.mjs';
import {
  combineFreshnessVerdicts, stockDateSummary, stockFreshnessVerdict,
} from '../scripts/lib/stock-freshness.mjs';

const at = (iso) => new Date(iso);
const unix = (iso) => Date.parse(iso) / 1000;

test('TradingView quote and Yahoo history retain their distinct source dates', () => {
  assert.ok(COLUMNS.includes('last_bar_update_time'));
  const stock = shape({
    name: 'TERA', description: 'Tera Yatirim', type: 'stock',
    close: 207.3, change: 5.87,
    last_bar_update_time: unix('2026-09-11T15:05:00Z'),
  });
  const history = parseChart({
    chart: { result: [{
      meta: { exchangeTimezoneName: 'Europe/Istanbul' },
      timestamp: [unix('2026-09-10T15:00:00Z')],
      indicators: {
        adjclose: [{ adjclose: [195.6] }],
        quote: [{ close: [195.6], volume: [9_314_733] }],
      },
    }] },
  });
  stock.hd = history.at(-1).d;

  assert.equal(stock.p, 207.3);
  assert.equal(stock.ch, 5.87);
  assert.equal(stock.qd, '2026-09-11');
  assert.equal(stock.hd, '2026-09-10');
});

test('one stale TERA history is not hidden by another stock global maximum', () => {
  const now = at('2026-09-12T09:00:00Z'); // Saturday in Istanbul
  const stockData = {
    builtAt: '2026-09-12T08:30:00Z',
    latestHistoryDate: '2026-09-11',
    stocks: [
      { c: 'ASELS', qd: '2026-09-11', hd: '2026-09-11' },
      { c: 'TERA', qd: '2026-09-11', hd: '2026-09-10' },
      { c: 'ALTIN', qd: '2026-09-11', hd: null },
    ],
  };
  const refs = new Map([
    ['ASELS', '2026-09-11'], ['TERA', '2026-09-11'], ['ALTIN', '2026-09-11'],
  ]);
  const summary = stockDateSummary(stockData.stocks, now);
  const verdict = stockFreshnessVerdict({ stockData, referenceQuoteDates: refs, now });

  assert.equal(summary.latestHistoryDate, '2026-09-11');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.staleHistory, 1);
  assert.equal(verdict.missingHistoryDates, 1);
  assert.deepEqual(verdict.staleHistoryCodes, ['TERA']);
});

test('an after-close request cannot reuse or preserve a pre-close Yahoo response', () => {
  const quoteDate = '2026-09-11';
  const beforeClose = at('2026-09-11T14:00:00Z'); // 17:00 Istanbul
  const afterClose = at('2026-09-11T16:00:00Z');  // 19:00 Istanbul
  const oldRows = [{ d: '2026-09-10', p: 195.6, v: 1 }];

  const pre = yahooCacheContext(beforeClose, quoteDate);
  const post = yahooCacheContext(afterClose, quoteDate);
  assert.notEqual(
    yahooCacheKey('TERA', '1y', beforeClose, quoteDate),
    yahooCacheKey('TERA', '1y', afterClose, quoteDate),
  );
  assert.equal(historyResponseIsCurrent(oldRows, pre), true);
  assert.equal(post.phase, 'postclose');
  assert.equal(post.requiresSession, true);
  assert.equal(historyResponseIsCurrent(oldRows, post), false);
});

test('a weekend targets Friday without inventing a Saturday trading date', () => {
  const saturday = at('2026-09-12T09:00:00Z');
  const context = yahooCacheContext(saturday, '2026-09-11');
  const key = yahooCacheKey('ASELS', '1y', saturday, '2026-09-11');

  assert.deepEqual(context, {
    phase: 'postclose', sessionDate: '2026-09-11', requiresSession: true,
  });
  assert.match(key, /2026-09-11-postclose$/);
  assert.doesNotMatch(key, /2026-09-12/);
  assert.equal(historyResponseIsCurrent([{ d: '2026-09-11' }], context), true);
  assert.equal(
    quoteDateOf(unix('2026-09-12T02:29:23Z')),
    '2026-09-11',
    'a weekend TradingView refresh is not a Saturday exchange session',
  );
});

test('an exchange holiday keeps the session supplied by the market feed', () => {
  // Republic Day is a Thursday in 2026. The cache does not need a holiday
  // table: TradingView still names Wednesday, so Wednesday is what Yahoo must
  // prove and Thursday never enters the key.
  const holiday = at('2026-10-29T09:00:00Z');
  const context = yahooCacheContext(holiday, '2026-10-28');
  const key = yahooCacheKey('ASELS', '1y', holiday, '2026-10-28');
  assert.equal(context.sessionDate, '2026-10-28');
  assert.equal(context.requiresSession, true);
  assert.match(key, /2026-10-28-postclose$/);
  assert.doesNotMatch(key, /2026-10-29/);
});

test('stock staleness changes the combined freshness result', () => {
  const combined = combineFreshnessVerdicts(
    { ok: true, level: 'none', behindDays: 0, reason: 'funds current' },
    {
      ok: false, level: 'heal', reason: 'TERA history stale', count: 2,
      staleQuotes: 0, staleHistory: 1, missingQuoteDates: 0, missingHistoryDates: 0,
    },
  );
  assert.equal(combined.ok, false);
  assert.equal(combined.level, 'heal');
  assert.match(combined.reason, /TERA history stale/);
});

test('a missing stocks.json builtAt is a freshness failure', () => {
  const verdict = stockFreshnessVerdict({
    stockData: { stocks: [{ c: 'ASELS', qd: '2026-09-11', hd: '2026-09-11' }] },
    referenceQuoteDates: new Map([['ASELS', '2026-09-11']]),
    now: at('2026-09-12T09:00:00Z'),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.level, 'alert');
  assert.match(verdict.reason, /builtAt/);
});

test('stock fetch failures can no longer pass the prices workflow', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/prices.yml', import.meta.url), 'utf8');
  const start = workflow.indexOf('- name: Fetch Borsa İstanbul shares and their history');
  const end = workflow.indexOf('\n      - name:', start + 1);
  const step = workflow.slice(start, end);

  assert.ok(start >= 0, 'stock fetch step is present');
  assert.doesNotMatch(step, /continue-on-error:\s*true/);
  assert.match(step, /run: node scripts\/fetch-stocks\.mjs/);
  assert.match(workflow, /cron: '30 16 \* \* 1-5'/, 'there is an Istanbul post-close run');
});
