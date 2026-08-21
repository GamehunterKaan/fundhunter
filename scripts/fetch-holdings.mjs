// Pull each fund's individual positions from its monthly KAP portfolio report.
//
//   node scripts/fetch-holdings.mjs              # every fund in the universe
//   node scripts/fetch-holdings.mjs --codes TLY,HVZ
//   node scripts/fetch-holdings.mjs --month 2026-07
//   node scripts/fetch-holdings.mjs --no-previous  # skip the comparison month
//   node scripts/fetch-holdings.mjs --report     # coverage only, writes nothing
//
// The latest month is what gets published — this answers "what does it hold now",
// not "what did it hold". The month before is fetched too, but only its WEIGHTS
// are kept, so the page can say which positions grew, shrank or are new. That is
// one number per holding, not a second portfolio.
//
// Holdings are written one file per fund so a re-run rewrites only the funds that
// actually changed.
//
// Downloads are cached on disk, so the expensive first pass happens once and
// later runs re-fetch only reports that are new.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { KapClient } from './lib/kap.mjs';
import { parseReport, check, periodName } from './lib/portfolio.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'holdings');
const CACHE = path.join(ROOT, '.cache', 'kap');

function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--')
    ? process.argv[at + 1]
    : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

/**
 * The days a month's reports were filed on.
 *
 * The deadline is the tenth of the following month and filings start a week or
 * so before it, so the window is walked day by day. That is not laziness: the
 * disclosure query caps at 2000 rows and its `page` field does nothing, so
 * narrowing by date is the only way to see everything.
 */
function filingDays(month) {
  const [y, m] = month.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 1));
  const days = [];
  for (let d = 1; d <= 20; d++) {
    const at = new Date(next.getTime() + (d - 1) * 86400000);
    days.push(at.toISOString().slice(0, 10));
  }
  return days;
}

/** The month before `month`, as YYYY-MM. */
function monthBefore(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

/**
 * One position's identity across two filings.
 *
 * The ISIN is the real identifier and is used wherever the filer supplied one.
 * The code alone would merge two different bonds from the same issuer, and it
 * changes shape between months for the same holding ("TUPRS" one month,
 * "TUPRS TRATUPRS91E8" the next).
 */
const positionKey = (holding) =>
  String(holding.isin || holding.code || '').trim().toUpperCase() || null;

/**
 * A reader for one earlier month's weights, fetched a fund at a time.
 *
 * Deliberately not a bulk pre-pass. Downloading all 1,174 earlier filings before
 * writing anything meant a five-hour run that produced no output until the very
 * end, and an interrupted one produced none at all. Fetching each fund's earlier
 * report next to its current one means every fund is written complete the moment
 * both months are read, and stopping halfway leaves a consistent half.
 *
 * Weights are all that is kept. Holding two months of positions for 1,300 funds
 * to show one extra column would double the data directory for a comparison.
 */
async function previousReader(kap, month, universe) {
  console.log(`Indexing ${month} filings to compare against…`);
  const reports = await kap.latestReports(filingDays(month));
  console.log(`  ${reports.size} funds filed one\n`);

  const cache = new Map();
  return {
    period: month,
    /**
     * That fund's earlier weights, or null when it did not file, the filing
     * could not be read, or it is a fund we do not cover. The page then shows no
     * comparison for it rather than treating every position as new.
     *
     * @returns {Promise<Map<string, number>|null>} position key -> weight
     */
    async weightsFor(code, row) {
      if (cache.has(code)) return cache.get(code);
      // KAP files exchange-traded funds under their ticker, so the earlier month
      // is looked up under whichever code this month's filing came in under.
      const earlier = reports.get(row.fundCode) ?? reports.get(code);
      let weights = null;
      try {
        if (earlier?.attachmentCount) {
          const pdf = await kap.reportPdf(earlier.disclosureIndex);
          const parsed = pdf ? parseReport(pdf) : null;
          if (parsed && !parsed.empty && check(parsed).ok
            && resolveCode(earlier, parsed, universe) === code) {
            // Summed, not assigned: a filing splits one holding over several
            // rows and the fund's weight in it is the total.
            const found = new Map();
            for (const holding of parsed.holdings) {
              const key = positionKey(holding);
              if (!key || holding.weight == null) continue;
              found.set(key, (found.get(key) ?? 0) + holding.weight);
            }
            if (found.size) weights = found;
          }
        }
      } catch {
        // A month we cannot read is a missing comparison, never a failed run.
      }
      cache.set(code, weights);
      return weights;
    },
  };
}

/** The month before today, which is the one that has been filed. */
function lastMonth() {
  const now = new Date();
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return at.toISOString().slice(0, 7);
}

async function main() {
  const month = arg('month', lastMonth());
  const only = arg('codes')?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) ?? null;
  const reportOnly = has('report');
  const limit = Number(arg('limit', '0')) || 0;
  // On by default: the fund page shows how each position moved since the last
  // filing, and after the first run the earlier month is already cached.
  const compare = has('no-previous') ? null : arg('previous', monthBefore(month));

  // The universe we actually publish. KAP also carries pension and venture
  // funds, which this project does not cover.
  let universe = null;
  try {
    const funds = JSON.parse(await fs.readFile(path.join(DATA, 'funds.json'), 'utf8'));
    universe = new Map(funds.map((f) => [f.c, f]));
  } catch {
    console.warn('! data/funds.json not found — taking every fund KAP lists');
  }

  const kap = new KapClient({ cacheDir: CACHE });
  kap.onCoolOff = (ms) => console.log(`  … KAP is refusing connections; waiting ${Math.round(ms / 1000)}s`);

  const previous = compare ? await previousReader(kap, compare, universe) : null;

  console.log(`Looking for ${month} portfolio reports…`);
  const reports = await kap.latestReports(filingDays(month));
  console.log(`  ${reports.size} funds filed one`);

  // KAP does not always use TEFAS's code. Exchange-traded funds are listed under
  // their ticker — "APX30" for the fund TEFAS calls "BOE" — so filtering on the
  // code alone silently drops every ETF. The filing's own name field carries the
  // TEFAS code as a prefix ("BOE-AK PY BIST 30 ENDEKSI…"), so anything KAP lists
  // that we do not recognise is still fetched and identified from the report.
  let targets = [...reports.values()];
  const unknown = universe ? targets.filter((r) => !universe.has(r.fundCode)).length : 0;
  if (unknown) console.log(`  ${unknown} filed under a code we do not know; identifying those from the report itself`);
  if (only) targets = targets.filter((r) => only.includes(r.fundCode));
  // Largest funds first: the run takes hours against KAP's throttle, and this
  // way the pages most people open have their comparison within the first few
  // minutes rather than the last.
  const sizeOf = (row) => universe?.get(row.fundCode)?.sz ?? 0;
  targets.sort((a, b) => sizeOf(b) - sizeOf(a) || a.fundCode.localeCompare(b.fundCode));
  if (limit) targets = targets.slice(0, limit);
  console.log(`  ${targets.length} of them are funds we cover\n`);

  const stats = { ok: 0, flagged: 0, empty: 0, failed: 0, skipped: 0, holdings: 0, written: 0, compared: 0 };
  const reasons = new Map();
  const failures = [];
  let done = 0;

  for (const r of targets) {
    let outcome;
    try {
      if (!r.attachmentCount) {
        outcome = ['failed', 'Disclosure has no attachment'];
      } else {
        const pdf = await kap.reportPdf(r.disclosureIndex);
        outcome = pdf ? await handle(r, pdf) : ['failed', 'Attachment could not be downloaded'];
      }
    } catch (err) {
      outcome = ['failed', `Fetch or parse failed: ${err.message}`];
    }
    const [kind, reason] = outcome;
    stats[kind]++;
    if (kind !== 'ok') {
      const key = reason.replace(/[\d.,]+/g, 'N').slice(0, 80);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
      if (kind === 'failed') failures.push(`${r.fundCode}: ${reason}`);
    }
    if (++done % 50 === 0) console.log(`  …${done}/${targets.length}`);
  }

  if (!reportOnly) await writeIndex(month, stats);

  console.log(`\n=== ${month} ===`);
  console.log(`funds covered      : ${targets.length}`);
  console.log(`holdings published : ${stats.ok} funds (${stats.holdings} positions)`);
  console.log(`  flagged          : ${stats.flagged} — parsed cleanly, report's own totals disagree`);
  if (compare) console.log(`  compared to ${compare}: ${stats.compared} funds`);
  console.log(`not held           : ${stats.empty} funds hold nothing`);
  console.log(`could not read     : ${stats.failed}`);
  if (stats.skipped) console.log(`outside our universe: ${stats.skipped}`);
  for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${reason}`);
  }
  console.log(`\nrequests ${kap.stats.requests}, cache hits ${kap.stats.cacheHits}, ` +
    `retries ${kap.stats.retries}, ${(kap.stats.bytes / 1e6).toFixed(0)}MB`);
  if (failures.length && has('verbose')) {
    console.log('\n--- funds skipped ---');
    for (const f of failures) console.log('  ' + f);
  }

  async function handle(row, pdf) {
    const parsed = parseReport(pdf);
    const verdict = check(parsed);
    if (parsed.empty) return ['empty', parsed.problems[0]];
    if (!verdict.ok) return ['failed', verdict.problems[0]];

    const code = resolveCode(row, parsed, universe);
    if (!code) return ['skipped', 'Not a fund we cover'];

    stats.holdings += parsed.holdings.length;
    if (verdict.warnings.length) stats.flagged++;
    const before = previous ? await previous.weightsFor(code, row) : null;
    if (before) stats.compared++;
    if (!reportOnly) {
      await write(code, row, parsed, verdict, month, { period: compare, weights: before });
      stats.written++;
    }
    return ['ok', null];
  }
}

/**
 * The TEFAS code for a filing, which is not always the code KAP files it under.
 *
 * Exchange-traded funds are listed on KAP by their ticker — "APX30" for the fund
 * TEFAS calls "BOE" — so going by `fundCode` alone drops every ETF on the floor.
 * Each filing names itself "BOE-AK PY BIST 30 ENDEKSI…", so the code can be read
 * off the front of that when the listed one is not one we know.
 *
 * @returns {string|null} null when the filing is for a fund outside our universe
 */
function resolveCode(row, parsed, universe) {
  if (!universe) return row.fundCode;
  if (universe.has(row.fundCode)) return row.fundCode;
  const prefix = /^\s*([A-Z0-9]{2,6})\s*-/.exec(parsed.fund.name ?? '')?.[1];
  return prefix && universe.has(prefix) ? prefix : null;
}

/**
 * One file per fund.
 *
 * Rewriting a file whose content has not changed would show up as a change in
 * every daily commit, so the file is only written when it differs.
 */
async function write(code, row, parsed, verdict, month, prior = null) {
  // Summed the same way as the comparison month, so a holding split over several
  // rows is matched against the same total it was built from.
  const current = new Map();
  if (prior?.weights) {
    for (const holding of parsed.holdings) {
      const key = positionKey(holding);
      if (key && holding.weight != null) current.set(key, (current.get(key) ?? 0) + holding.weight);
    }
  }

  const record = {
    code,
    kapCode: code === row.fundCode ? null : row.fundCode,
    name: parsed.fund.name ?? row.kapTitle ?? null,
    // The month the run asked KAP for, when the filing does not spell its own
    // period out. One template abbreviates it to "T-2026", and reading a month
    // name from elsewhere on the page found the fund's founding date instead.
    period: parsed.period ?? periodName(month),
    // The month this fund's weights are compared against, or null when its
    // earlier filing could not be read. The page shows no comparison then
    // rather than treating every position as new.
    prevPeriod: prior?.weights ? prior.period : null,
    publishedAt: row.publishDate ?? null,
    disclosure: row.disclosureIndex,
    form: parsed.form,
    portfolioValue: parsed.portfolioValue,
    netAssetValue: parsed.fund.netAssetValue,
    // Recorded rather than hidden: the parse reconciles against every subtotal,
    // so a total that misses 100% is the filer's arithmetic, not ours.
    warnings: verdict.warnings,
    holdings: parsed.holdings.map((h) => {
      const key = positionKey(h);
      // The position's total weight last month: a number when it was held, null
      // when it is new this month or there is nothing to compare against. Split
      // rows all carry the position's total, which is what the comparison is of.
      const before = prior?.weights && key && prior.weights.has(key)
        ? Math.round(prior.weights.get(key) * 1e4) / 1e4
        : null;
      return {
        code: h.code,
        isin: h.isin,
        ref: h.ref,
        name: h.name,
        currency: h.currency,
        group: h.group,
        subgroup: h.subgroup,
        nominal: h.nominal,
        value: h.value,
        weight: h.weight == null ? null : Math.round(h.weight * 1e4) / 1e4,
        prevWeight: before,
      };
    }),
  };
  // Named for the TEFAS code, which is what the site looks a fund up by.
  const file = path.join(OUT, `${code}.json`);
  const text = JSON.stringify(record, null, 1);
  try {
    if (await fs.readFile(file, 'utf8') === text) return;
  } catch {
    // Not written yet.
  }
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(file, text);
}

/**
 * A manifest of which funds have holdings, and what the run achieved.
 *
 * Nothing reads it yet — the fund page simply asks for its own file and copes
 * with a miss. It is written so coverage is visible in the repository rather
 * than only in a terminal that has since scrolled away.
 */
async function writeIndex(month, stats) {
  let files = [];
  try {
    files = (await fs.readdir(OUT)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  } catch {
    await fs.mkdir(OUT, { recursive: true });
  }
  const codes = files.map((f) => f.replace(/\.json$/, '')).sort();
  await fs.writeFile(
    path.join(OUT, 'index.json'),
    JSON.stringify({ month, updated: new Date().toISOString().slice(0, 10), count: codes.length, stats, codes }, null, 1));
}

await main();
