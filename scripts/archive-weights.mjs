#!/usr/bin/env node
//
// Keeps one compact copy of every filing period, so the next one has something
// honest to be compared against.
//
//   node scripts/archive-weights.mjs [--month 2026-07] [--force]
//
// Everything about "what changed since last month" currently rests on the
// `prevWeight` column the filer chooses to fill in, and that column is not
// reliable: 42 filings name a previous period and then leave every cell blank,
// and a fund that sells out of a share usually stops listing the row rather than
// leaving a zero behind — only about a fifth of filers leave the zero. So exits
// are undercounted and no amount of care with the current month's file fixes it.
//
// Two consecutive snapshots fix it completely. A position in last month's file
// and absent from this one is an exit, with no reliance on the filer saying so,
// and a share count in both is a purchase measured rather than inferred.
//
// What is kept, per position: the code, the ISIN, the share count, the lira, the
// weight and which asset group it sits in. What is dropped: the issuer name, the
// reference column, the currency and the parser's warnings — all of them either
// re-derivable or already held elsewhere, and together most of the bytes.
//
// Must run AFTER fetch-holdings.mjs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { periodMonth } from './lib/portfolio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'weights');

const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return process.argv.includes(`--${name}`) ? true : fallback;
};

/**
 * A rounded number, or null. Six figures on a share count is a share count.
 *
 * Nominal values run to eleven digits and lira to twelve; keeping every decimal
 * of a figure that was rounded before it reached us costs bytes and says
 * nothing. Weights keep four places because a 0.0001% position is still a row.
 */
const num = (v, places) => (Number.isFinite(v) ? Number(v.toFixed(places)) : null);

async function main() {
  const monthArg = arg('month');
  const force = arg('force') === true;

  let files;
  try {
    files = (await fs.readdir(path.join(DATA, 'holdings'))).filter((f) => f.endsWith('.json'));
  } catch {
    console.error('No data/holdings — run scripts/fetch-holdings.mjs first.');
    process.exitCode = 1;
    return;
  }

  // The groups are a couple of dozen strings repeated across 36,000 rows, so
  // they are interned and the rows carry an index. It is the single biggest
  // saving in the file and costs one array lookup to undo.
  const groups = [];
  const groupIndex = new Map();
  const idOf = (name) => {
    const key = String(name ?? '');
    if (!key) return -1;
    if (!groupIndex.has(key)) {
      groupIndex.set(key, groups.length);
      groups.push(key);
    }
    return groupIndex.get(key);
  };

  const periods = new Map();
  const funds = {};
  let rows = 0;
  let skipped = 0;

  for (const file of files.sort()) {
    let filing;
    try {
      filing = JSON.parse(await fs.readFile(path.join(DATA, 'holdings', file), 'utf8'));
    } catch {
      skipped++;
      continue;
    }
    const code = filing.code ?? path.basename(file, '.json');
    const month = periodMonth(filing.period);
    if (!month) { skipped++; continue; }
    periods.set(month, (periods.get(month) ?? 0) + 1);

    funds[code] = {
      p: month,
      pv: num(filing.portfolioValue, 2),
      nav: num(filing.netAssetValue, 2),
      h: (filing.holdings ?? []).map((position) => {
        rows++;
        return [
          String(position.code ?? '').trim(),
          String(position.isin ?? '').trim(),
          num(position.nominal, 4),
          num(position.value, 2),
          num(position.weight, 4),
          idOf(position.group),
        ];
      }),
    };
  }

  // The period every file agrees on, unless told otherwise. A fetch that half
  // finished leaves two months on disk, and writing that under either name would
  // put a month's worth of positions in the wrong snapshot.
  const ranked = [...periods].sort((a, b) => b[1] - a[1]);
  const period = typeof monthArg === 'string' ? monthArg : ranked[0]?.[0];
  if (!period) {
    console.error('No filing period could be read from data/holdings.');
    process.exitCode = 1;
    return;
  }
  if (ranked.length > 1) {
    log(`  WARN data/holdings holds more than one period: ` +
      ranked.map(([m, n]) => `${m} (${n})`).join(', '));
  }

  const target = path.join(OUT, `${period}.json`);
  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(target, 'utf8'));
  } catch { /* first run for this month */ }

  // A snapshot is the record of what a month looked like. Overwriting it with a
  // smaller one is how a half-finished fetch quietly rewrites history, and the
  // whole point of the file is that it cannot be re-derived later.
  if (existing && !force) {
    const before = Object.keys(existing.funds ?? {}).length;
    const now = Object.keys(funds).length;
    if (now < before) {
      console.error(`Refusing to shrink ${period}: ${now} funds where the file has ` +
        `${before}. Re-run the fetch, or pass --force if the drop is real.`);
      process.exitCode = 1;
      return;
    }
  }

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(target, `${JSON.stringify({
    period,
    builtAt: new Date().toISOString(),
    groups,
    funds,
  })}\n`);

  const bytes = (await fs.stat(target)).size;
  log(`archived ${period}: ${Object.keys(funds).length} funds, ${rows} positions, ` +
    `${groups.length} asset groups, ${(bytes / 1048576).toFixed(1)}MB` +
    (skipped ? ` (${skipped} filings unreadable)` : ''));

  const kept = (await fs.readdir(OUT)).filter((f) => f.endsWith('.json')).sort();
  log(`  periods on disk: ${kept.map((f) => f.replace('.json', '')).join(', ')}`);
}

await main();
