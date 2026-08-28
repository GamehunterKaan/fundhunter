#!/usr/bin/env node
//
// Turkish consumer price index, into data/cpi.json.
//
//   node scripts/fetch-cpi.mjs
//
// Every lira figure on a share page is nominal, and for Turkey that is not a
// footnote. A twenty-year dividend chart has fifteen invisible bars because the
// lira fell, not because the company stopped paying: a 2015 lira is 12.2 of
// today's. Without a deflator the oldest half of every statement chart is
// unreadable and quietly misleading.
//
// The source is the World Bank's `FP.CPI.TOTL` — keyless, documented, and
// authoritative. It is ANNUAL, which is the whole reason this took a while to
// land, and the shape of the file below is what makes annual data honest:
//
//   - a year is deflated at its own year's index and nothing is interpolated
//     inside it. A quarterly figure gets its YEAR's index, not a number invented
//     by sliding between two of them.
//   - the series lags. Periods after the last published year cannot be deflated
//     at all, so they are left nominal and the page marks them.
//
// The alternative — interpolating within a year to make quarters look smooth —
// would be a judgement nobody reading the chart could see had been made. Monthly
// Turkish CPI is published by TÜİK and by TCMB's EVDS; EVDS needs an API key and
// TÜİK publishes bulletins rather than a series endpoint, so neither is a
// dependency this project can take. Revisit if either ever serves plain JSON.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'cpi.json');

const SOURCE = 'https://api.worldbank.org/v2/country/TR/indicator/FP.CPI.TOTL'
  + '?format=json&per_page=200';

/** Below this many years the series is not worth publishing as a deflator. */
const MIN_YEARS = 20;

const log = (m) => console.log(m);

async function main() {
  log('Fetching Turkish CPI from the World Bank…');
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();

  // The World Bank answers with [metadata, rows]. A page of rows with every
  // value null is what a bad indicator id looks like, so both halves are checked.
  const rows = Array.isArray(body?.[1]) ? body[1] : [];
  const years = {};
  for (const row of rows) {
    const year = Number(row?.date);
    const value = Number(row?.value);
    if (!Number.isInteger(year) || !Number.isFinite(value) || value <= 0) continue;
    // Significant figures, not decimal places. Turkey's index runs from about
    // 0.0000002 in 1960 to 1784 today, and rounding that to two decimals turns
    // the whole first half of the series into zeroes — which then deflate to
    // infinity rather than failing loudly.
    const kept = Number(value.toPrecision(8));
    if (!(kept > 0)) continue;
    years[year] = kept;
  }

  const list = Object.keys(years).map(Number).sort((a, b) => a - b);
  if (list.length < MIN_YEARS) {
    throw new Error(`only ${list.length} years came back; refusing to publish a deflator`);
  }

  const latest = list.at(-1);
  const out = {
    builtAt: new Date().toISOString(),
    source: 'World Bank FP.CPI.TOTL',
    indicator: 'FP.CPI.TOTL',
    // What the index is expressed against. Not used by the arithmetic — every
    // figure is deflated to `latest` — but it says what the numbers are.
    base: '2010 = 100',
    // The year everything is restated into, and the year after which a figure
    // cannot be deflated at all.
    latest,
    from: list[0],
    years,
  };

  await fs.writeFile(OUT, `${JSON.stringify(out, null, 1)}\n`, 'utf8');
  log(`Wrote data/cpi.json — ${list.length} years, ${list[0]}–${latest}`);
  log(`  ${latest} = ${years[latest]}, ${latest - 1} = ${years[latest - 1]}`);
  log(`  a ${list[0]} lira is ${(years[latest] / years[list[0]]).toFixed(1)}× in ${latest} money`);
}

main().catch((e) => {
  console.error('\nCPI FETCH FAILED:', e.message);
  process.exit(1);
});
