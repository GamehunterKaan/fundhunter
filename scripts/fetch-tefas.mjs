#!/usr/bin/env node
//
// Builds the static dataset the site reads, from the public TEFAS API.
//
//   node scripts/fetch-tefas.mjs [--months=12] [--alloc-months=12]
//                                [--concurrency=3] [--quick] [--no-cache]
//                                [--allow-shrink]
//
// Output (under public/data):
//   meta.json          taxonomy, kinds, categories, founders, coverage stats
//   index.json         one compact row per fund (drives the list/search view)
//   funds/<CODE>.json  per-fund price history + allocation history
//
// Responses are cached gzipped under .cache/, so re-runs are cheap and the job is
// resumable if it is interrupted partway through.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TefasClient, requestBody, mapPool, ymd, addDays, splitRange, weeklyAnchors,
} from './lib/tefas.mjs';
import { staleCutoff, partitionUniverse, lastDate, PRUNE_GRACE_DAYS } from './lib/universe.mjs';
import { ASSETS, ASSET_CODES, GROUPS, KINDS, CATEGORY_EN } from './lib/taxonomy.mjs';
import { collapseReason } from './lib/collapse.mjs';
// Shared with the browser so a "1-year return" means the same thing in both.
import { returnOver, volatility, maxDrawdown } from '../core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const INFO_METHOD = 'fonGnlBlgSiraliGetir';
const DIST_METHOD = 'dagilimSiraliGetirT';
const TUR_METHOD = 'fonTurGetir';

/**
 * The fund-comparison export. Unlike the `/api/funds/*` methods it answers with a
 * bare array, and it is the only public source for TEFAS's official risk value
 * (`riskDegeri`, 1–7) and for fee data — management fee and total expense ratio.
 */
const EXPORT_URL = 'https://www.tefas.gov.tr/api/fund-returns/export';

/** TEFAS caps a single request at roughly one month of data. */
const MAX_DAYS_PER_REQUEST = 28;
/** Chunks re-read on a wide run, and how often one is due. */
const WIDE_CHUNKS = 3;
const WIDE_EVERY_MS = 7 * 24 * 3600 * 1000;
/** Allocation is sampled weekly; this window absorbs public holidays. */
const ALLOC_WINDOW_DAYS = 3;

/**
 * The window volatility and drawdown are measured over, in trading days.
 *
 * A year. Pinned rather than "the whole series", so the figures keep their
 * meaning as the history deepens — see where they are computed for why.
 */
const RISK_WINDOW_DAYS = 252;

/** The last `n` points of an ascending series, or all of it when it is shorter. */
const windowOf = (series, n) => (series.length > n ? series.slice(-n) : series);

// ---------------------------------------------------------------- args

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

/**
 * TEFAS refuses a start date more than five years old:
 *
 *   Geçersiz veri: Baslangıc Tarihi 5 yıldan eski olamaz
 *
 * Exactly sixty months trips it, so the deepest usable pull is a little under.
 * Asking for more fails the whole run rather than returning a short answer.
 */
const MAX_MONTHS = 59;

const MONTHS = Math.min(Number(args.months ?? (args.quick ? 1 : 12)), MAX_MONTHS);
/**
 * How far back the WEEKLY ALLOCATION goes, when that should differ from prices.
 *
 * The two have very different costs. Prices come 28 days per request, so a
 * five-year pull is 66 chunks per kind; the allocation is one request per weekly
 * anchor, so the same five years is 261 per kind — four times the requests for
 * the half of the data that changes slowest and is only ever read as "what does
 * this fund hold now" plus a month-over-month diff.
 *
 * So a deep backfill can take the prices without dragging five years of weekly
 * composition behind it: `--months=60 --alloc-months=12`. Defaults to MONTHS, so
 * an ordinary run is unchanged.
 */
const ALLOC_MONTHS = Number(args['alloc-months'] ?? MONTHS);
// TEFAS rate-limits hard; 2 in flight is the sweet spot between speed and 429s.
const CONCURRENCY = Number(args.concurrency ?? 2);
const OUT_DIR = path.join(ROOT, args.out ?? 'data');
const USE_CACHE = !args['no-cache'];
const QUICK = Boolean(args.quick);

// ---------------------------------------------------------------- helpers

const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);
const pct = (n) => (n == null ? 0 : Math.round(n * 100) / 100);
const num = (n) => (n == null || Number.isNaN(n) ? null : n);

function tidyName(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * TEFAS has no founder field, but Turkish fund names are regulated and always
 * lead with the management company: "<X> PORTFÖY ..." for mutual funds and
 * "<X> EMEKLİLİK VE HAYAT A.Ş. ..." for insurer-run funds.
 *
 * Everything after "PORTFÖY" ("YÖNETİMİ", "A.Ş.") is dropped so that the three
 * spellings of one company collapse to a single founder.
 */
function deriveFounder(name) {
  const n = tidyName(name);
  const portfoy = n.match(/^(.*?\bPORTFÖY)\b/iu);
  if (portfoy) return tidyName(portfoy[1]);
  const as = n.match(/^(.*?\bA\.?\s?Ş\.?)(?=\s|$)/iu);
  if (as && as[1].length <= 70) return tidyName(as[1]);
  return tidyName(n.split(' ').slice(0, 3).join(' '));
}

/**
 * Fold a founder name to a comparison key. TEFAS is inconsistent about Turkish
 * diacritics — "ALLIANZ" and "ALLİANZ" are the same company — so dotted/undotted
 * I and the rest of the Turkish set are flattened before grouping.
 */
function founderKey(s) {
  return s
    .toLocaleUpperCase('tr')
    .replace(/[İIı]/g, 'I')
    .replace(/Ş/g, 'S')
    .replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U')
    .replace(/Ö/g, 'O')
    .replace(/Ç/g, 'C')
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Delete history for funds no longer in the universe.
 *
 * History is otherwise append-only and nothing on disk is ever dropped, which is
 * right while a fund exists — but a delisted fund, or a whole fund type taken out
 * of scope, would leave files the site never reads and every clone still carries.
 *
 * @param {Set<string>} keep fund codes in the current index
 * @returns {Promise<number>} how many files were removed
 */
/**
 * Stop before writing if this run's result is not plausible.
 *
 * The decision lives in scripts/lib/collapse.mjs, pure and tested — it is the
 * one check in this pipeline whose failure is unrecoverable without git, and it
 * was added after a throttled backfill wrote an empty universe and pruned every
 * history file behind it.
 */
async function assertNotCollapsed(found) {
  let before = 0;
  try {
    before = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'funds.json'), 'utf8')).length;
  } catch {
    before = 0;
  }
  const reason = collapseReason(found, before, { allowShrink: Boolean(args['allow-shrink']) });
  if (reason) throw new Error(`${reason}. Refusing to write.`);
  if (args['allow-shrink'] && before && found < before) {
    log(`  WARN --allow-shrink: writing ${found} funds over the last run's ${before}`);
  }
}

async function pruneHistory(keep) {
  const dir = path.join(OUT_DIR, 'history');
  let removed = 0;
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return 0;
  }
  // Second line of the same defence. `assertNotCollapsed` should already have
  // stopped the run, so reaching here with an empty keep-set means something
  // else went wrong — and deleting the entire history directory is not a
  // recovery from anything.
  const owned = files.filter((n) => n.endsWith('.jsonl'));
  if (!keep.size && owned.length) {
    throw new Error(`refusing to prune all ${owned.length} history files over an empty universe`);
  }
  for (const name of owned) {
    if (keep.has(name.slice(0, -6))) continue;
    await fs.unlink(path.join(dir, name));
    removed++;
  }
  return removed;
}

/**
 * Merge this run's records into data/history/<CODE>.jsonl (one JSON object per
 * line, ascending by date).
 *
 * History is cumulative: the fetch window slides forward but nothing already on
 * disk is dropped, so a daily cron only appends lines and the git delta stays
 * proportional to what actually changed rather than to the file size.
 *
 * @returns {Promise<number>} count of dates that were not previously on disk
 */
async function writeHistory(code, prices, allocByDate) {
  const file = path.join(OUT_DIR, 'history', `${code}.jsonl`);
  const records = new Map();

  try {
    const txt = await fs.readFile(file, 'utf8');
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      records.set(rec.d, rec);
    }
  } catch {
    // First run for this fund.
  }

  const before = records.size;

  for (const [d, p, , iv, sz] of prices) {
    const rec = records.get(d) ?? { d };
    rec.p = p;
    rec.iv = iv;
    rec.sz = sz;
    // Shares outstanding is exactly sz / p. Storing it would add ~15% to every
    // history file — and to every daily commit — for no extra information.
    delete rec.sh;
    records.set(d, rec);
  }
  for (const [d, a] of allocByDate) {
    const rec = records.get(d) ?? { d };
    rec.a = a;
    records.set(d, rec);
  }

  const lines = [...records.values()]
    .sort((x, y) => (x.d < y.d ? -1 : 1))
    .map((r) => JSON.stringify(r));
  await fs.writeFile(file, lines.join('\n') + '\n');
  return records.size - before;
}

// ---------------------------------------------------------------- fetch steps

const client = new TefasClient({
  cacheDir: USE_CACHE ? path.join(ROOT, '.cache') : null,
});

/**
 * Cache discriminator for snapshot endpoints that take no date parameter, so a
 * new trading day fetches fresh data instead of serving yesterday's cache.
 */
let latestTag = '';

const reduceInfo = (rows) =>
  rows.map((r) => [
    r.fonKodu,
    r.tarih,
    num(r.fiyat),
    num(r.tedPaySayisi),
    num(r.kisiSayisi),
    num(r.portfoyBuyukluk),
    tidyName(r.fonUnvan),
  ]);

const reduceDist = (rows) =>
  rows.map((r) => {
    const a = {};
    for (const code of ASSET_CODES) {
      const v = r[code];
      if (v != null && v !== 0) a[code] = pct(v);
    }
    return [r.fonKodu, r.tarih, a];
  });

/** Most recent date TEFAS has data for, probed over a trailing window. */
async function findLatestDate() {
  const today = new Date();
  const rows = await client.post(
    INFO_METHOD,
    requestBody({ fonTipi: 'YAT', basTarih: ymd(addDays(today, -10)), bitTarih: ymd(today) }),
    { reduce: (r) => r.map((x) => [x.tarih]) }
  );
  if (!rows.length) throw new Error('TEFAS returned no data for the last 10 days');
  return rows.map((r) => r[0]).sort().at(-1);
}

/** fund code -> Turkish umbrella-category, built by querying each category in turn. */
async function fetchCategories(latestDate) {
  const map = new Map();
  const categories = new Set();
  const day = latestDate.replace(/-/g, '');

  for (const kind of KINDS.map((k) => k.id)) {
    const turler = await client.post(TUR_METHOD, requestBody({ fonTipi: kind }), {
      cacheKey: USE_CACHE ? `tur-${kind}` : null,
    });

    await mapPool(turler, CONCURRENCY, async (t) => {
      const rows = await client.post(
        INFO_METHOD,
        requestBody({
          fonTipi: kind,
          sfonTurKod: t.sfonTuru,
          basTarih: day,
          bitTarih: day,
        }),
        {
          cacheKey: USE_CACHE ? `cat-${kind}-${t.sfonTuru}-${day}` : null,
          reduce: (r) => r.map((x) => [x.fonKodu]),
        }
      );
      const label = tidyName(t.sfonTurAciklama);
      if (rows.length) categories.add(label);
      for (const [code] of rows) map.set(code, label);
    });
    log(`  categories: ${kind} -> ${turler.length} umbrella types`);
  }
  return { map, categories: [...categories].sort() };
}

/** Turkish decimals arrive as strings with a comma: "2,04" -> 2.04. */
function trNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Per-period flags the return listing needs. Without these — and without
 * `getiriOrani` — every `getiri*` column comes back null.
 */
const RETURN_PERIODS = {
  donemGetiri1a: '1',
  donemGetiri3a: '1',
  donemGetiri6a: '1',
  donemGetiriyb: '1',
  donemGetiri1y: '1',
  donemGetiri3y: '1',
  donemGetiri5y: '1',
};

/** Build an export request body. `islem` is the platform-traded filter. */
function exportBody(listingType, fundType, islem = null) {
  return {
    format: 'json',
    listingType,
    fundType,
    locale: 'tr',
    filters: {
      kurucuKodu: null,
      fonTurKod: null,
      fonGrubu: null,
      fonTurAciklama: null,
      sfonTurKod: null,
      islem,
      calismaTipi: 2,
      ...(listingType === 'return' ? { ...RETURN_PERIODS, getiriOrani: '1' } : {}),
    },
  };
}

/**
 * TEFAS's own risk value, platform status, returns and fees, from the
 * fund-comparison export.
 *
 * Three things here are only available from this endpoint:
 *
 * - `riskDegeri` — the OFFICIAL risk value (1–7). A 7 additionally means the fund
 *   is restricted to qualified investors.
 * - platform status — whether the fund is actually buyable on TEFAS. The
 *   response never contains the `tefasDurum` field, so it is
 *   derived by querying `filters.islem = 1` and taking membership of that set.
 *   Verified against known funds: TLY traded, PKZ and ABG not.
 * - official returns for 1m/3m/6m/YTD/1y/3y/5y. These are preferred over the ones
 *   we compute from the price series because they are what TEFAS itself displays,
 *   and they differ — TEFAS reports 684.94% for TLY over one year where our series
 *   gives 779.65%.
 *
 * @returns {Promise<Map<string, object>>} fund code -> profile
 */
async function fetchFundProfiles() {
  const profiles = new Map();
  const upsert = (code, patch) => {
    if (!code) return;
    profiles.set(code, { ...(profiles.get(code) ?? {}), ...patch });
  };

  for (const kind of KINDS.map((k) => k.id)) {
    const returns = await client.postUrl(
      EXPORT_URL,
      exportBody('return', kind),
      { cacheKey: USE_CACHE ? `export-return-v2-${kind}-${latestTag}` : null }
    );
    for (const row of returns) {
      const risk = trNumber(row.riskDegeri);
      upsert(row.fonKodu, {
        risk: risk != null ? Math.round(risk) : null,
        umbrella: tidyName(row.fonTurAciklama) || null,
        returns: {
          m1: row.getiri1a ?? null,
          m3: row.getiri3a ?? null,
          m6: row.getiri6a ?? null,
          ytd: row.getiriyb ?? null,
          y1: row.getiri1y ?? null,
          y3: row.getiri3y ?? null,
          y5: row.getiri5y ?? null,
        },
      });
    }

    // Membership of the islem=1 set is the platform-traded flag.
    const tradedRows = await client.postUrl(
      EXPORT_URL,
      exportBody('return', kind, 1),
      {
        cacheKey: USE_CACHE ? `export-traded-v2-${kind}-${latestTag}` : null,
        reduce: (rows) => rows.map((r) => [r.fonKodu]),
      }
    );
    const traded = new Set(tradedRows.map(([code]) => code));
    for (const row of returns) {
      upsert(row.fonKodu, { tefas: traded.has(row.fonKodu) });
    }

    const fees = await client.postUrl(
      EXPORT_URL,
      exportBody('management', kind),
      { cacheKey: USE_CACHE ? `export-mgmt-v2-${kind}-${latestTag}` : null }
    );
    // TEFAS writes an unpublished fee as "0" rather than leaving the field
    // empty, and a zero here is the absence of a number, not a fund that
    // charges nothing. TLY reports no management fee against a 2% prospectus
    // cap and a 2% realised expense ratio — it charges 2%, and the site said
    // it was free. 438 of the 443 funds reporting a zero expense ratio also
    // report a management fee, which is the same story at scale: left as zero
    // they sort to the top of "cheapest" and pass a "fees under 1%" filter.
    const published = (v) => trNumber(v) || null;
    for (const row of fees) {
      upsert(row.fonKodu, {
        mgmtFee: published(row.uygulananYu1Y),
        maxMgmtFee: published(row.fonIcTuzukYu1G),
        expenseRatio: published(row.fonTopGiderKesoran),
      });
    }

    log(
      `  profiles: ${kind} -> ${returns.length} funds, ${traded.size} tradeable, ${fees.length} fee rows`
    );
  }
  return profiles;
}

/** Daily price/size/investor history for every kind. */
async function fetchInfoHistory(start, end, liveChunks = 1) {
  const grid = splitRange(start, end, MAX_DAYS_PER_REQUEST);
  // The grid runs the newest chunk past the latest trading date, so that one is
  // still filling up while its key stays put — and a cache keyed by the range
  // alone would serve whichever day it was first written for until the block
  // ends, weeks later. Tagging it with the trading date is what weeklyAnchors()
  // does for the allocation snapshots. Same-day re-runs still hit.
  //
  // `liveChunks` widens that to the newest few. TEFAS restates a NAV
  // occasionally, and a restatement inside a chunk that is already closed is
  // never re-read at any run frequency — the request is simply never made
  // again. Once a week the window is opened wide enough to see them.
  const liveFrom = Math.max(0, grid.length - liveChunks);
  const jobs = [];
  for (const kind of KINDS.map((k) => k.id)) {
    grid.forEach(([s, e], i) => {
      jobs.push({ kind, s: ymd(s), e: ymd(e), open: i >= liveFrom });
    });
  }
  log(`  info history: ${jobs.length} requests (${liveChunks} live chunk(s) per kind)`);
  let done = 0;
  const chunks = await mapPool(jobs, CONCURRENCY, async (j) => {
    const rows = await client.post(
      INFO_METHOD,
      requestBody({ fonTipi: j.kind, basTarih: j.s, bitTarih: j.e }),
      {
        cacheKey: USE_CACHE ? `info-${j.kind}-${j.s}-${j.e}${j.open ? `-${latestTag}` : ''}` : null,
        reduce: reduceInfo,
      }
    );
    if (++done % 10 === 0 || done === jobs.length) log(`    info ${done}/${jobs.length}`);
    return { kind: j.kind, rows };
  });
  return chunks;
}

/** Weekly allocation snapshots for every kind. */
async function fetchAllocHistory(start, end) {
  const anchors = weeklyAnchors(start, end);

  const jobs = [];
  for (const kind of KINDS.map((k) => k.id)) {
    for (const a of anchors) {
      jobs.push({ kind, s: ymd(addDays(a, -(ALLOC_WINDOW_DAYS - 1))), e: ymd(a) });
    }
  }
  log(`  allocation history: ${jobs.length} requests (${anchors.length} weekly snapshots)`);
  let done = 0;
  const chunks = await mapPool(jobs, CONCURRENCY, async (j) => {
    const rows = await client.post(
      DIST_METHOD,
      requestBody({ fonTipi: j.kind, basTarih: j.s, bitTarih: j.e }),
      { cacheKey: USE_CACHE ? `dist-${j.kind}-${j.s}-${j.e}` : null, reduce: reduceDist }
    );
    if (++done % 10 === 0 || done === jobs.length) log(`    alloc ${done}/${jobs.length}`);
    return { kind: j.kind, rows };
  });
  return chunks;
}

// ---------------------------------------------------------------- build

async function main() {
  const t0 = Date.now();
  log(`TEFAS fetch — ${MONTHS} month(s)${QUICK ? ' [quick]' : ''}, concurrency ${CONCURRENCY}`);

  const latestDate = await findLatestDate();
  const end = new Date(latestDate);
  const start = addDays(end, -Math.round(MONTHS * 30.44));
  const allocStart = addDays(end, -Math.round(ALLOC_MONTHS * 30.44));
  log(`Latest trading date: ${latestDate}; range ${start.toISOString().slice(0, 10)} .. ${latestDate}`);
  if (ALLOC_MONTHS !== MONTHS) {
    log(`  allocation only from ${allocStart.toISOString().slice(0, 10)} (${ALLOC_MONTHS} months)`);
  }

  latestTag = latestDate.replace(/-/g, '');

  log('Step 1/5 — fund categories');
  const { map: categoryOf, categories } = await fetchCategories(latestDate);
  log(`  mapped ${categoryOf.size} funds into ${categories.length} categories`);

  log('Step 2/5 — official risk values and fees');
  const profiles = await fetchFundProfiles();
  log(`  ${profiles.size} fund profiles`);

  log('Step 3/5 — price history');
  // Whether this run re-reads the closed chunks as well. Driven by what the
  // last run wrote rather than by the weekday: a Saturday that GitHub never
  // fires would otherwise skip the wide read for the whole week and nothing
  // would say so.
  let lastWideRead = null;
  try {
    lastWideRead = JSON.parse(
      await fs.readFile(path.join(OUT_DIR, 'meta.json'), 'utf8')
    ).lastWideRead ?? null;
  } catch {
    lastWideRead = null;
  }
  const wide =
    Boolean(args.wide) ||
    !lastWideRead ||
    Date.now() - Date.parse(lastWideRead) >= WIDE_EVERY_MS;
  if (wide) log(`  wide read: re-reading the newest ${WIDE_CHUNKS} chunks for restatements`);

  const infoChunks = await fetchInfoHistory(start, end, wide ? WIDE_CHUNKS : 1);

  log('Step 4/5 — allocation history');
  const allocChunks = await fetchAllocHistory(allocStart, end);

  log('Step 5/5 — building output');

  // --- assemble per-fund records ---
  /** @type {Map<string, {kind:string,name:string,prices:Map<string,any[]>,alloc:Map<string,object>}>} */
  const funds = new Map();

  for (const { kind, rows } of infoChunks) {
    for (const [code, date, price, shares, investors, size, name] of rows) {
      if (!code) continue;
      let f = funds.get(code);
      if (!f) funds.set(code, (f = { kind, name, prices: new Map(), alloc: new Map() }));
      if (name) f.name = name;
      f.prices.set(date, [date, price, shares, investors, size]);
    }
  }

  // Each allocation request covers a 3-day window (wide enough to survive a public
  // holiday). Keep only each fund's most recent print inside a window, so the
  // series is one point per week rather than a cluster of three adjacent days.
  for (const { rows } of allocChunks) {
    const latestInWindow = new Map();
    for (const [code, date, a] of rows) {
      const prev = latestInWindow.get(code);
      if (!prev || date > prev[0]) latestInWindow.set(code, [date, a]);
    }
    for (const [code, [date, a]] of latestInWindow) {
      const f = funds.get(code);
      if (!f) continue; // present in the allocation feed but not the info feed
      f.alloc.set(date, a);
    }
  }

  // A fund that did not print today has not necessarily gone. Everything below
  // is built from `active`, including the prune that deletes history files, so
  // reading "silent today" as "delisted" is how a fund publishing an hour late
  // loses its past. Grace is counted in trading days actually seen, so a
  // weekend or a holiday spends none of it.
  //
  // `priced` stays strict and is what the collapse guard reads: the question it
  // answers is whether this fetch worked at all, and grace must not soften that.
  const tradingDays = new Set();
  for (const [, f] of funds) for (const d of f.prices.keys()) tradingDays.add(d);
  const cutoff = staleCutoff(tradingDays);
  const { priced, keep: active, dropped } = partitionUniverse(
    funds.entries(), latestDate, cutoff
  );
  log(
    `  ${funds.size} funds seen, ${priced.length} priced on ${latestDate}, ` +
    `${active.length} kept (silent since ${cutoff} is dropped)`
  );
  if (active.length > priced.length) {
    const late = active.filter(([, f]) => !f.prices.has(latestDate));
    log(
      `  ${late.length} kept without a print today: ` +
      late.slice(0, 8).map(([c, f]) => `${c}@${lastDate(f.prices)}`).join(' ') +
      (late.length > 8 ? ' …' : '')
    );
  }
  if (dropped.length) {
    log(`  ${dropped.length} dropped after ${PRUNE_GRACE_DAYS} silent trading days`);
  }
  await assertNotCollapsed(priced.length);

  const groupOf = Object.fromEntries(Object.entries(ASSETS).map(([k, v]) => [k, v.group]));

  // --- founders: fold spelling variants onto the most common display form ---
  const founderVotes = new Map(); // key -> Map<display, count>
  for (const [, f] of active) {
    const display = deriveFounder(f.name);
    const key = founderKey(display);
    if (!founderVotes.has(key)) founderVotes.set(key, new Map());
    const votes = founderVotes.get(key);
    votes.set(display, (votes.get(display) ?? 0) + 1);
  }
  const canonicalFounder = new Map(); // key -> display
  let rawSpellings = 0;
  for (const [key, votes] of founderVotes) {
    rawSpellings += votes.size;
    // Prefer the most frequent spelling; break ties toward the shorter one.
    const best = [...votes.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].length - b[0].length
    )[0][0];
    canonicalFounder.set(key, best);
  }
  log(`  ${canonicalFounder.size} founders (folded from ${rawSpellings} spellings)`);

  const founders = new Set();
  const index = [];

  await fs.mkdir(path.join(OUT_DIR, 'history'), { recursive: true });

  let allocMissing = 0;
  let sumWarnings = 0;
  let appended = 0;

  await mapPool(active, 12, async ([code, f]) => {
    const prices = [...f.prices.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const allocDates = [...f.alloc.keys()].sort();
    const latestAlloc = allocDates.length ? f.alloc.get(allocDates.at(-1)) : {};
    if (!allocDates.length) allocMissing++;

    const founder = canonicalFounder.get(founderKey(deriveFounder(f.name)));
    founders.add(founder);

    // Sanity check: leaf percentages should total ~100 for a healthy row.
    const total = Object.values(latestAlloc).reduce((s, v) => s + v, 0);
    if (allocDates.length && Math.abs(total - 100) > 2) sumWarnings++;

    // Group-level mix, used for the list view's exposure bars and filters.
    // Repo can be reported negative (the fund is borrowing), so groups may net
    // below zero; that is real and preserved rather than clamped.
    const groupMix = {};
    for (const [k, v] of Object.entries(latestAlloc)) {
      const g = groupOf[k];
      if (g) groupMix[g] = pct((groupMix[g] ?? 0) + v);
    }

    const last = prices.at(-1);
    const priceSeries = prices.map(([d, p]) => [d, p]);

    const profile = profiles.get(code) ?? {};

    index.push({
      c: code,
      n: f.name,
      k: f.kind,
      cat: categoryOf.get(code) ?? profile.umbrella ?? null,
      f: founder,
      d: last[0],
      // TEFAS's official risk value (1–7). Risk 7 is restricted to qualified
      // investors, which is why it is stored rather than re-derived.
      risk: profile.risk ?? null,
      // Whether the fund can actually be bought on TEFAS, from membership of the
      // `islem: 1` set. null when TEFAS lists no status for it at all.
      tefas: profile.tefas ?? null,
      mgmtFee: profile.mgmtFee ?? null,
      maxMgmtFee: profile.maxMgmtFee ?? null,
      expenseRatio: profile.expenseRatio ?? null,
      p: last[1],
      sh: last[2],
      iv: last[3],
      sz: last[4],
      g: groupMix,
      // largest asset classes, for at-a-glance composition in the table
      t: Object.entries(latestAlloc)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4),
      // TEFAS's published returns are authoritative — they are what the site
      // itself shows, so they are what a user will cross-check against. Our own
      // series still drives volatility, drawdown, the factor model and the
      // charts; `w1` has no official equivalent so it stays computed.
      r: {
        w1: returnOver(priceSeries, 7),
        m1: profile.returns?.m1 ?? returnOver(priceSeries, 30),
        m3: profile.returns?.m3 ?? returnOver(priceSeries, 91),
        m6: profile.returns?.m6 ?? returnOver(priceSeries, 182),
        ytd: profile.returns?.ytd ?? null,
        y1: profile.returns?.y1 ?? returnOver(priceSeries, 365),
        y3: profile.returns?.y3 ?? null,
        y5: profile.returns?.y5 ?? null,
      },
      // Risk stats are computed here, not in the browser, so the list view can
      // sort and filter on them without loading 2,400 history files.
      //
      // Over a STATED window rather than over whatever history happens to be on
      // disk. They used to run over the whole series, which meant one year while
      // the fetch window was one year — and deepening it to five would have
      // silently turned every volatility on the site into a five-year figure,
      // moved the risk bands under it and changed the ranking, without a line of
      // UI admitting anything had changed. A risk number has to mean the same
      // thing on Tuesday that it meant on Monday.
      vol: volatility(windowOf(priceSeries, RISK_WINDOW_DAYS)),
      mdd: maxDrawdown(windowOf(priceSeries, RISK_WINDOW_DAYS)),
      // The deepest fall in everything we hold, which is the one risk figure
      // the longer history genuinely unlocks: `mdd` says what a bad year looked
      // like, this says what the worst of them did. Null when the series is not
      // meaningfully longer than the window, so it never restates `mdd`.
      mddAll: priceSeries.length > RISK_WINDOW_DAYS * 1.5
        ? maxDrawdown(priceSeries)
        : null,
    });

    appended += await writeHistory(code, prices, f.alloc);
  });

  index.sort((a, b) => (b.sz ?? 0) - (a.sz ?? 0));

  const pruned = await pruneHistory(new Set(index.map((r) => r.c)));
  if (pruned) log(`  pruned ${pruned} history files no longer in the universe`);

  const meta = {
    lastUpdated: new Date().toISOString(),
    latestDate,
    // Carried forward untouched on a narrow run, so the weekly clock is the
    // last wide read and not the last run of any kind.
    lastWideRead: wide ? new Date().toISOString() : lastWideRead,
    rangeStart: start.toISOString().slice(0, 10),
    months: MONTHS,
    source: 'https://www.tefas.gov.tr',
    counts: {
      funds: index.length,
      // How many of those are published at a date older than latestDate —
      // funds inside their grace window that have not printed yet. Written here
      // rather than counted by the watchdog so the check stays three small
      // requests: meta.json already crosses the wire, funds.json does not.
      priced: priced.length,
      lagging: index.length - priced.length,
      byKind: Object.fromEntries(
        KINDS.map((k) => [k.id, index.filter((r) => r.k === k.id).length])
      ),
    },
    kinds: KINDS,
    groups: GROUPS,
    assets: ASSETS,
    categories: categories.map((tr) => ({ tr, en: CATEGORY_EN[tr] ?? tr })),
    founders: [...founders].sort((a, b) => a.localeCompare(b, 'tr')),
  };

  await fs.writeFile(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  // One fund per line: still valid JSON, but a daily refresh only rewrites the
  // lines that actually changed, which keeps git deltas small.
  await fs.writeFile(
    path.join(OUT_DIR, 'funds.json'),
    '[\n' + index.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n'
  );

  const idxBytes = (await fs.stat(path.join(OUT_DIR, 'funds.json'))).size;
  log(`Wrote funds.json (${(idxBytes / 1e6).toFixed(2)} MB) + ${index.length} history files`);
  log(`  ${appended} new history records appended`);
  if (allocMissing) log(`  note: ${allocMissing} funds have no allocation data`);
  if (sumWarnings) log(`  note: ${sumWarnings} funds' allocation does not total ~100%`);
  log(
    `Done in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min — ` +
      `${client.stats.requests} requests, ${client.stats.cacheHits} cache hits, ` +
      `${client.stats.retries} retries (${client.stats.throttled} throttled), ` +
      `${(client.stats.bytes / 1e6).toFixed(0)} MB downloaded`
  );
}

main().catch((e) => {
  console.error('\nFETCH FAILED:', e.message);
  process.exit(1);
});
