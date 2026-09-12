import { isStockDate, yahooCacheContext } from './stock-dates.mjs';

const newest = (dates) => dates.filter(isStockDate).sort().at(-1) ?? null;
const oldest = (dates) => dates.filter(isStockDate).sort().at(0) ?? null;

/** Per-row coverage written beside stocks.json; maxima are descriptive only. */
export function stockDateSummary(stocks, now = new Date()) {
  const rows = Array.isArray(stocks) ? stocks : [];
  const quoteDates = rows.map((row) => row.qd);
  const historyDates = rows.map((row) => row.hd);
  const quoteMissingCodes = rows.filter((row) => !isStockDate(row.qd)).map((row) => row.c);
  const historyMissingCodes = rows.filter((row) => !isStockDate(row.hd)).map((row) => row.c);
  const historyBehindQuoteCodes = rows.filter((row) => {
    if (!isStockDate(row.qd) || !isStockDate(row.hd)) return false;
    return yahooCacheContext(now, row.qd).requiresSession && row.hd < row.qd;
  }).map((row) => row.c);

  return {
    latestQuoteDate: newest(quoteDates),
    oldestQuoteDate: oldest(quoteDates),
    latestHistoryDate: newest(historyDates),
    oldestHistoryDate: oldest(historyDates),
    quoteDatesMissing: quoteMissingCodes.length,
    historyDatesMissing: historyMissingCodes.length,
    historyBehindQuote: historyBehindQuoteCodes.length,
    quoteMissingCodes,
    historyMissingCodes,
    historyBehindQuoteCodes,
  };
}

const referenceMap = (value) => value instanceof Map
  ? value
  : new Map(Object.entries(value ?? {}));

const ageHours = (iso, now) => {
  const then = Date.parse(iso);
  return Number.isFinite(then) ? (now.getTime() - then) / 3600000 : null;
};

/**
 * Compare every stored stock row with TradingView's current session stamp.
 * No maximum can hide one lagging symbol: stale counts and examples are made
 * from the individual code/date pairs.
 */
export function stockFreshnessVerdict({
  stockData,
  referenceQuoteDates,
  now,
  alertAfterHoursStuck = 6,
}) {
  const rows = stockData?.stocks;
  if (!Array.isArray(rows) || !rows.length) {
    return {
      ok: false, level: 'alert',
      reason: 'the live site did not return any stock rows',
      count: 0, staleQuotes: 0, staleHistory: 0,
      missingQuoteDates: 0, missingHistoryDates: 0,
    };
  }

  const refs = referenceMap(referenceQuoteDates);
  if (!refs.size) {
    return {
      ok: false, level: 'alert',
      reason: 'TradingView did not return any stock session dates',
      count: rows.length, staleQuotes: 0, staleHistory: 0,
      missingQuoteDates: 0, missingHistoryDates: 0,
    };
  }

  const summary = stockDateSummary(rows, now);
  const staleQuoteCodes = [];
  const staleHistoryCodes = [];
  let referenceMissing = 0;

  for (const row of rows) {
    const currentQuoteDate = refs.get(row.c);
    if (!isStockDate(currentQuoteDate)) {
      referenceMissing++;
      continue;
    }
    if (!isStockDate(row.qd) || row.qd < currentQuoteDate) staleQuoteCodes.push(row.c);

    // During the live session Yahoo is expected to be one close behind. After
    // close, and throughout weekends/holidays, it must contain the exchange
    // session named by TradingView. Missing Yahoo coverage is reported but is
    // not called stale: a few instruments are not carried by Yahoo at all.
    const context = yahooCacheContext(now, currentQuoteDate);
    if (context.requiresSession && isStockDate(row.hd) && row.hd < currentQuoteDate) {
      staleHistoryCodes.push(row.c);
    }
  }

  const builtAgeHours = ageHours(stockData.builtAt, now);
  const invalidBuiltAt = builtAgeHours == null;
  const staleQuotes = staleQuoteCodes.length;
  const staleHistory = staleHistoryCodes.length;
  const bad = invalidBuiltAt || staleQuotes > 0 || staleHistory > 0;
  const metrics = {
    count: rows.length,
    builtAt: stockData.builtAt ?? null,
    builtAgeHours,
    latestQuoteDate: summary.latestQuoteDate,
    latestHistoryDate: summary.latestHistoryDate,
    referenceQuoteDate: newest([...refs.values()]),
    staleQuotes,
    staleHistory,
    missingQuoteDates: summary.quoteDatesMissing,
    missingHistoryDates: summary.historyDatesMissing,
    referenceMissing,
    staleQuoteCodes,
    staleHistoryCodes,
  };

  if (!bad) {
    const missing = summary.historyDatesMissing
      ? `; ${summary.historyDatesMissing} have no Yahoo history`
      : '';
    return {
      ...metrics,
      ok: true,
      level: 'none',
      reason:
        `stocks current across ${rows.length} rows ` +
        `(quote session ${metrics.referenceQuoteDate}, Yahoo through ` +
        `${metrics.latestHistoryDate}${missing})`,
    };
  }

  const level = invalidBuiltAt || builtAgeHours >= alertAfterHoursStuck ? 'alert' : 'heal';
  const examples = [...new Set([...staleQuoteCodes, ...staleHistoryCodes])].slice(0, 8);
  return {
    ...metrics,
    ok: false,
    level,
    reason:
      `stocks have ${staleQuotes} stale TradingView quote row${staleQuotes === 1 ? '' : 's'}, ` +
      `${staleHistory} stale Yahoo history row${staleHistory === 1 ? '' : 's'}, ` +
      `${summary.quoteDatesMissing} missing quote date${summary.quoteDatesMissing === 1 ? '' : 's'}, ` +
      `${summary.historyDatesMissing} missing history date${summary.historyDatesMissing === 1 ? '' : 's'}` +
      (invalidBuiltAt ? ', and stocks.json has no valid builtAt' : '') +
      (examples.length ? ` (for example ${examples.join(', ')})` : ''),
  };
}

const rank = { none: 0, heal: 1, alert: 2 };

export function combineFreshnessVerdicts(funds, stocks) {
  const level = rank[funds.level] >= rank[stocks.level] ? funds.level : stocks.level;
  return {
    ...funds,
    ...Object.fromEntries(Object.entries(stocks).map(([key, value]) => [`stock_${key}`, value])),
    ok: funds.ok && stocks.ok,
    level,
    reason: `${funds.reason}; ${stocks.reason}`,
  };
}
