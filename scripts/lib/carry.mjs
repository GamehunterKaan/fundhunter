// What to keep when TEFAS stops answering a question it answered yesterday.
//
// The price path already knows this lesson twice over. A fund that does not
// print today is not a fund that has closed (incident 9), and a row whose price
// field is zero is not a fund worth nothing (incident 10). Both fixes say the
// same thing: an absent value is TEFAS not having published, and the right
// response is to keep what is known rather than to write down the absence.
//
// The PROFILE path never learnt it. `risk`, `tefas`, the two fee fields and the
// category all come from endpoints that answer for the whole universe at once,
// and every one of them is written straight into funds.json as whatever came
// back — including null.
//
// Measured on 2026-09-07, against the export endpoint, twice in a row to be sure
// it was not a blip: 2,142 rows returned, 1,624 carrying `riskDegeri`. The other
// 518 came back null, and 466 of those funds have a real risk value in the
// committed funds.json from that morning. A run landing in that window would
// have published `risk: null` for 466 funds — and since "unknown is not a pass",
// a reader with a risk cap set, or with qualified-investor funds hidden, would
// have silently lost a fifth of the market from their list. Nothing anywhere
// would have said so: the fetch succeeded, the count was unchanged, the collapse
// guard saw 2,065 funds, and the freshness watchdog saw today's date.
//
// So these fields are carried. A carried value can go stale — a fund that
// genuinely stops publishing a fee keeps its last published one — and that is
// the trade being made deliberately: a fee that is one day old is a far smaller
// lie than a 2% fee displayed as unknown, which is the same argument incident 4
// settled for a zero. What is NOT carried is anything that is an observation of
// a particular day: the price, the date, the size, the investor count. Those are
// measurements, and a measurement that did not happen must not be invented.

/**
 * Fields that describe what a fund IS, rather than what it did on a given day.
 *
 * Deliberately a short list. Every entry here is a value TEFAS publishes for the
 * whole universe at once and occasionally declines to publish at all, where the
 * previous answer is still the best available one.
 */
export const CARRIED_FIELDS = ['risk', 'tefas', 'cat', 'mgmtFee', 'maxMgmtFee', 'expenseRatio'];

/**
 * Share of the universe that can lose a field before it stops being a handful of
 * funds and starts being the endpoint having a bad afternoon.
 *
 * Not a refusal. Carrying is always the safe action — the previous values were
 * good — and stopping the run would hold back the prices too, which is the one
 * thing that must keep moving. This is the line above which the run says so
 * loudly enough that somebody goes and looks.
 */
export const CARRY_NOTICE_SHARE = 0.05;

/**
 * Fill this run's blanks from the last run's row.
 *
 * @param {object} next  the row this run built
 * @param {object|null} prev the row the last run wrote, or null for a new fund
 * @param {string[]} [fields]
 * @returns {{row: object, carried: string[]}}
 */
export function carryForward(next, prev, fields = CARRIED_FIELDS) {
  if (!prev || !next) return { row: next, carried: [] };
  let row = next;
  const carried = [];
  for (const field of fields) {
    // `== null` and not falsy: `tefas: false` is a real answer meaning the fund
    // cannot be bought, and `risk: 0` — were TEFAS ever to emit one — is not an
    // absence either. Only null and undefined are "did not say".
    if (next[field] == null && prev[field] != null) {
      if (row === next) row = { ...next };
      row[field] = prev[field];
      carried.push(field);
    }
  }
  return { row, carried };
}

/**
 * One line per field that had to be carried for anybody, plus whether the scale
 * of it is worth shouting about.
 *
 * @param {Record<string, number>} counts field -> how many funds needed it
 * @param {number} total funds written
 * @returns {{line: string, loud: boolean}|null}
 */
export function carryReport(counts, total, { share = CARRY_NOTICE_SHARE } = {}) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length || !total) return null;
  const worst = entries[0][1] / total;
  return {
    line:
      `carried forward from the last run: ` +
      entries.map(([f, n]) => `${f} ${n}`).join(', ') +
      ` (of ${total} funds)`,
    loud: worst > share,
  };
}
