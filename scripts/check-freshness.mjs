#!/usr/bin/env node
// Ask the live site what date it is showing, ask TEFAS what date there is, and
// say whether those agree.
//
//   node scripts/check-freshness.mjs [--site=https://…] [--github-output]
//
// Exits 0 when the site is current and 1 when it is not, so it can be a check
// on its own. `--github-output` additionally writes the verdict to
// $GITHUB_OUTPUT for the workflow to act on, in which case the exit code is
// left at 0 — the workflow decides what a stale site is worth, and a step that
// went red would stop it deciding anything.
//
// The site is read over the network rather than off disk on purpose. A repo
// with today's funds.json in it is not the same claim as a site serving it, and
// every part of the distance between those two has failed at least once.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TefasClient, requestBody, ymd, addDays } from './lib/tefas.mjs';
import { freshnessVerdict } from './lib/freshness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INFO_METHOD = 'fonGnlBlgSiraliGetir';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

async function defaultSite() {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  return (pkg.homepage ?? '').replace(/\/$/, '');
}

/** The newest date TEFAS has any fund data for, probed over a trailing window. */
async function tefasLatestDate() {
  // No cache: this is the one question whose whole value is that the answer is
  // current, and the disk cache is the thing that made it wrong once already.
  const client = new TefasClient({ cacheDir: null, maxRetry: 4 });
  const today = new Date();
  const rows = await client.post(
    INFO_METHOD,
    requestBody({ fonTipi: 'YAT', basTarih: ymd(addDays(today, -10)), bitTarih: ymd(today) }),
    { reduce: (r) => r.map((x) => [x.tarih]) }
  );
  return rows.length ? rows.map((r) => r[0]).sort().at(-1) : null;
}

/** What the live site says it is showing. */
async function siteMeta(site) {
  // Past every cache between here and the origin: a check that can be answered
  // from a cache is a check that can agree with the bug it is looking for.
  const url = `${site}/data/meta.json?freshness=${Date.now()}`;
  const r = await fetch(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
  if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
  return r.json();
}

const site = (args.site === true ? null : args.site) ?? (await defaultSite());

let verdict;
try {
  const [meta, tefasDate] = await Promise.all([siteMeta(site), tefasLatestDate()]);
  verdict = freshnessVerdict({
    siteDate: meta.latestDate ?? null,
    tefasDate,
    lastUpdated: meta.lastUpdated ?? null,
    now: new Date(),
  });
  verdict.siteDate = meta.latestDate ?? null;
  verdict.tefasDate = tefasDate;
  verdict.lastUpdated = meta.lastUpdated ?? null;
} catch (e) {
  // Unreachable is not the same as stale, but it is not fine either, and the
  // one thing it must not do is pass quietly.
  verdict = {
    ok: false,
    level: 'alert',
    behindDays: 0,
    reason: `could not check ${site}: ${e.message}`,
  };
}

console.log(verdict.ok ? `fresh — ${verdict.reason}` : `STALE — ${verdict.reason}`);
if (verdict.lastUpdated) console.log(`  site last updated ${verdict.lastUpdated}`);
console.log(`  level: ${verdict.level}`);

if (args['github-output'] && process.env.GITHUB_OUTPUT) {
  await fs.appendFile(
    process.env.GITHUB_OUTPUT,
    [
      `ok=${verdict.ok}`,
      `level=${verdict.level}`,
      `behind_days=${verdict.behindDays}`,
      `reason=${verdict.reason}`,
      `site_date=${verdict.siteDate ?? ''}`,
      `tefas_date=${verdict.tefasDate ?? ''}`,
      '',
    ].join('\n')
  );
  process.exit(0);
}

process.exit(verdict.ok ? 0 : 1);
