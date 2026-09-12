// Dates shared by the stock fetch and its external freshness check.
//
// There are deliberately no "business day" calculations here. Borsa Istanbul
// holidays move (and a listed share may not trade on an otherwise open day), so
// the last_bar_update_time supplied by the exchange feed is the session
// calendar. That makes Friday remain the target on a weekend and the last real
// session remain the target on an exchange holiday.

export const STOCK_ZONE = 'Europe/Istanbul';
export const BIST_CLOSE_MINUTE = 18 * 60 + 10;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const isStockDate = (value) => typeof value === 'string' && YMD.test(value);

/** A stable YYYY-MM-DD independent of the host machine's locale and zone. */
export function dateInZone(value, timeZone = STOCK_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** A weekend feed update still belongs to the preceding Friday session. */
export function normalizeWeekendSession(date) {
  if (!isStockDate(date)) return null;
  const utc = new Date(`${date}T00:00:00Z`);
  const day = utc.getUTCDay();
  const subtract = day === 6 ? 1 : day === 0 ? 2 : 0;
  if (subtract) utc.setUTCDate(utc.getUTCDate() - subtract);
  return utc.toISOString().slice(0, 10);
}

/** TradingView supplies last_bar_update_time as Unix seconds. */
export function quoteDateOf(unixSeconds) {
  const n = Number(unixSeconds);
  return Number.isFinite(n) && n > 0
    ? normalizeWeekendSession(dateInZone(n * 1000))
    : null;
}

/** The local date and wall-clock minute at Borsa Istanbul. */
export function istanbulClock(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: STOCK_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * The cache generation appropriate to a Yahoo request.
 *
 * A quote stamped with today's session can use a pre-close response while the
 * market is open. Once the close passes, that response is neither reusable nor
 * cacheable unless it contains the stamped session. On a weekend or holiday,
 * the quote stamp remains the last real session and becomes the target; no
 * Saturday/Sunday/holiday date is invented.
 */
export function yahooCacheContext(now = new Date(), quoteDate = null) {
  const local = istanbulClock(now);
  let phase = 'preclose';
  let requiresSession = false;

  if (isStockDate(quoteDate) && quoteDate < local.date) {
    phase = 'postclose';
    requiresSession = true;
  } else if (quoteDate === local.date && local.minute >= BIST_CLOSE_MINUTE) {
    phase = 'postclose';
    requiresSession = true;
  }

  return {
    phase,
    sessionDate: isStockDate(quoteDate) ? quoteDate : local.date,
    requiresSession,
  };
}

export function yahooCacheKey(code, range, now = new Date(), quoteDate = null) {
  const context = yahooCacheContext(now, quoteDate);
  return `${code}-${range}-${context.sessionDate}-${context.phase}`;
}

export function latestHistoryDate(rows) {
  if (!Array.isArray(rows)) return null;
  let latest = null;
  for (const row of rows) {
    if (isStockDate(row?.d) && (latest == null || row.d > latest)) latest = row.d;
  }
  return latest;
}

/** Whether a cached/network response proves the required session is present. */
export function historyResponseIsCurrent(rows, context) {
  if (!rows) return false;
  return !context.requiresSession || latestHistoryDate(rows) >= context.sessionDate;
}
