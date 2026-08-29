#!/usr/bin/env node
//
// The mark beside a code: a company's logo for a share, its manager's for a fund.
//
//   node scripts/fetch-logos.mjs [--only stock|manager] [--refresh] [--limit N]
//
// Two sources, because the two halves of this site are listed in different
// places and only one of them is anybody's product:
//
//   shares    TradingView's `logoid`, which fetch-stocks.mjs already collects in
//             the scanner request it was making anyway. 629 of 647 listings
//             carry one, and each is a ~700-byte SVG on their asset host.
//   managers  scripts/lib/managers.mjs, in two tiers. TEFAS names a fund's
//             manager and stops there, and TradingView does not carry open-end
//             funds at all, so the join is a curated table either way. Where the
//             manager's group is listed, it wears that share's logo — İş Portföy
//             and İş Yatırım are one mark, not two crops of one. Where it is
//             not, the mark is the icon the firm publishes for its own site.
//
// Downloaded here and committed, rather than linked at runtime. Three reasons,
// in the order they matter: a list page would otherwise open several hundred
// connections to a third party to decorate itself; the service worker can cache
// a same-origin file and cannot cache theirs, so the marks would be the one
// thing on a cached page that still needed a network; and a host that decides
// tomorrow to refuse hotlinks would blank the site rather than one build.
//
// Output:
//   data/logos/stock/<logoid>.svg    one per distinct mark, so share classes of
//                                    the same company share a file
//   data/logos/manager/<brand>.<ext> one per manager brand
//   data/logos/index.json            what actually landed, keyed by the strings
//                                    the browser holds: a share code, and the
//                                    founder string exactly as TEFAS prints it
//
// A manifest value is a path under data/logos, not a bare filename, because the
// two halves are not disjoint: a manager whose group is listed wears the
// share's mark rather than its own website's icon, so its entry points into
// stock/. See MANAGER_TICKERS.
//
// The index is the manifest and the UI reads only that. A logoid in stocks.json
// is upstream data and says what TradingView claims to have; a file on disk is
// what we have. Where they disagree — a download that 404s, an icon that came
// back as HTML — the manifest is right and the code falls back to its monogram.
//
// Re-running is cheap: a mark already on disk is left alone unless --refresh.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANAGER_SITES, MANAGER_TICKERS, brandOf } from './lib/managers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'logos');
const STOCK_DIR = path.join(OUT, 'stock');
const MANAGER_DIR = path.join(OUT, 'manager');
const INDEX = path.join(OUT, 'index.json');

const SYMBOL_HOST = 'https://s3-symbol-logo.tradingview.com';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? null;

const ONLY = value('only');
const REFRESH = flag('refresh');
const LIMIT = Number(value('limit')) || Infinity;

/**
 * A mark has to be small. These are 24-pixel roundels beside a table cell, and
 * anything above the cap is a hero image somebody put in `og:image` — the wrong
 * picture as well as the wrong size.
 */
const MAX_BYTES = 120 * 1024;

/**
 * What an icon actually is, read from its first bytes.
 *
 * The declared content type is a hint and not much more: these are sixty
 * unrelated small hosts, and between them they serve a PNG as
 * `application/octet-stream`, a favicon as `text/plain`, and an HTML login page
 * as `image/x-icon`. The bytes are not confused about any of it.
 */
function sniff(buf) {
  const b = buf.subarray(0, 16);
  if (b.length < 4) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return '.gif';
  // An icon directory: two zero bytes, then type 1 (ICO) or 2 (CUR).
  if (b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00) return '.ico';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  // SVG is text and may open with a declaration, a comment or a doctype, so it
  // is the tag that has to be found rather than the first character.
  const head = buf.subarray(0, 1000).toString('utf8').toLowerCase();
  if (head.includes('<svg')) return '.svg';
  return null;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** A fetch that always comes back, so one dead host cannot hang the build. */
async function get(url, { ms = 12000, accept = '*/*' } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept },
    });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download one image, if it really is one and really is small.
 *
 * Neither the URL nor the declared type is taken at its word: plenty of these
 * are served from a CMS as `/download?id=91`, and plenty of `.png` paths answer
 * with an HTML login page. Both mistakes end with an unreadable file on disk and
 * a broken image on the page, and sniff() catches both.
 */
async function grab(url) {
  const res = await get(url, { accept: 'image/*,*/*' });
  if (!res) return null;

  const body = Buffer.from(await res.arrayBuffer());
  if (!body.length || body.length > MAX_BYTES) return null;

  const ext = sniff(body);
  return ext ? { body, ext } : null;
}

/** Every icon a page declares, best first. */
function iconsOf(html, base) {
  // Unquoted attribute values are read as well as quoted ones. Three of the
  // sixty managers write `href=/favicon.ico` with no quotes at all — valid HTML,
  // and it was silently skipping them.
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
  };

  const links = [];
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attr(tag[0], 'rel').toLowerCase();
    if (!rel.includes('icon')) continue;
    const href = attr(tag[0], 'href');
    if (!href) continue;
    const sizes = Number(attr(tag[0], 'sizes').match(/\d+/)?.[0] ?? 0);
    const type = attr(tag[0], 'type').toLowerCase();
    const isIco = type.includes('icon') || /\.ico(\?|$)/i.test(href);
    links.push({
      href,
      // An apple-touch-icon is the one icon a site is obliged to publish as a
      // clean opaque square, which is exactly the shape wanted here. After that,
      // vector, then whichever raster it declares largest — a 16px favicon
      // upscaled into a 24px roundel looks like a mistake.
      //
      // `.ico` ranks below the other formats: it is a container holding every
      // size at once, so it is reliably the heaviest file on offer and never the
      // best-looking one. Taken when it is all a site publishes, which for a
      // third of them it is.
      rank: (rel.includes('apple-touch') ? 400 : 0)
        + (type.includes('svg') || /\.svg(\?|$)/i.test(href) ? 200 : 0)
        + (isIco ? -120 : 0)
        + Math.min(sizes, 180),
    });
  }
  links.sort((a, b) => b.rank - a.rank);

  const out = [];
  const push = (href) => {
    try { out.push(new URL(href, base).href); } catch { /* a malformed href */ }
  };
  for (const l of links) push(l.href);
  // Last resorts, for a site that declares nothing — several here are rendered
  // by script and their markup carries no `<link rel=icon>` at all. The
  // conventional path is tried before the social image, and the touch icon
  // before the favicon, for the same reason the ranking above prefers them.
  push('/apple-touch-icon.png');
  const og = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i)?.[1];
  if (og) push(og);
  push('/favicon.ico');
  return [...new Set(out)];
}

/** `AK` -> `ak`, `MARMARA CAPITAL` -> `marmara-capital`. */
const slug = (brand) => brand.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function existing(dir) {
  try {
    return new Set(await fs.readdir(dir));
  } catch {
    return new Set();
  }
}

/**
 * One mark per distinct logoid, keyed in the manifest by every code that uses it.
 *
 * Share classes are separate listings with separate codes and one company
 * behind them, so ISCTR and ISATR are two rows pointing at one file.
 */
async function stocks(manifest) {
  const file = path.join(DATA, 'stocks.json');
  let rows;
  try {
    rows = JSON.parse(await fs.readFile(file, 'utf8')).stocks ?? [];
  } catch {
    console.warn('logos: no data/stocks.json yet — run fetch-stocks.mjs first');
    return { got: 0, kept: 0, missed: 0 };
  }

  await fs.mkdir(STOCK_DIR, { recursive: true });
  const have = await existing(STOCK_DIR);
  const wanted = new Map();
  for (const r of rows) {
    if (!r.lg) continue;
    if (!wanted.has(r.lg)) wanted.set(r.lg, []);
    wanted.get(r.lg).push(r.c);
  }

  let got = 0;
  let kept = 0;
  let missed = 0;
  const ids = [...wanted.keys()].slice(0, LIMIT);

  // Eight at a time. Their asset host is a CDN and these are 700-byte files,
  // but a build script is a guest on it and 600 parallel requests is not how a
  // guest behaves.
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(ids.slice(i, i + 8).map(async (id) => {
      const name = `${id}.svg`;
      if (!REFRESH && have.has(name)) {
        kept++;
      } else {
        const hit = await grab(`${SYMBOL_HOST}/${encodeURIComponent(id)}.svg`);
        if (!hit) { missed++; return; }
        await fs.writeFile(path.join(STOCK_DIR, name), hit.body);
        got++;
      }
      for (const code of wanted.get(id)) manifest.stock[code] = `stock/${name}`;
    }));
  }
  return { got, kept, missed };
}

/**
 * One mark per manager brand, keyed in the manifest by every founder string.
 *
 * TEFAS reaches the same firm under several names — six of them for Azimut —
 * and the browser only ever holds the founder string, so all six point at the
 * one file rather than the UI having to know they are one company.
 */
async function managers(manifest, founders) {
  await fs.mkdir(MANAGER_DIR, { recursive: true });
  const have = await existing(MANAGER_DIR);
  const byBrand = new Map();
  for (const f of founders) {
    const brand = brandOf(f);
    if (!MANAGER_SITES[brand] && !MANAGER_TICKERS[brand]) continue;
    if (!byBrand.has(brand)) byBrand.set(brand, []);
    byBrand.get(brand).push(f);
  }

  // A manager whose group is listed takes the share's mark, and its website is
  // not visited at all — the file is already on disk from the pass above, and
  // the point of the mapping is that the two should not be separate artwork.
  let borrowed = 0;
  for (const [brand, names] of [...byBrand]) {
    const file = manifest.stock[MANAGER_TICKERS[brand]];
    if (!file) continue;
    for (const f of names) manifest.manager[f] = file;
    byBrand.delete(brand);
    borrowed++;
  }

  let got = 0;
  let kept = 0;
  let missed = 0;
  const brands = [...byBrand.keys()].slice(0, LIMIT);

  // Four at a time, and these are sixty different small hosts rather than one
  // CDN — several are slow enough that the timeout is doing real work.
  for (let i = 0; i < brands.length; i += 4) {
    await Promise.all(brands.slice(i, i + 4).map(async (brand) => {
      const stem = slug(brand);
      const already = [...have].find((f) => f.startsWith(`${stem}.`));
      let name = already;

      if (REFRESH || !already) {
        const site = MANAGER_SITES[brand];
        const page = await get(site, { accept: 'text/html,*/*' });
        if (!page) { missed++; console.warn(`  ${brand}: site unreachable`); return; }
        const html = (await page.text()).slice(0, 200000);

        let hit = null;
        for (const url of iconsOf(html, page.url)) {
          hit = await grab(url);
          if (hit) break;
        }
        if (!hit) { missed++; console.warn(`  ${brand}: no usable icon`); return; }

        name = `${stem}${hit.ext}`;
        // A refresh can change the extension; the stale one would otherwise sit
        // there being served to nobody.
        for (const old of have) {
          if (old.startsWith(`${stem}.`) && old !== name) {
            await fs.rm(path.join(MANAGER_DIR, old), { force: true });
          }
        }
        await fs.writeFile(path.join(MANAGER_DIR, name), hit.body);
        got++;
      } else {
        kept++;
      }

      for (const f of byBrand.get(brand)) manifest.manager[f] = `manager/${name}`;
    }));
  }
  return { got, kept, missed, borrowed };
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  // Merged rather than rebuilt: a run limited to one half must not drop the
  // other half's keys out of the manifest.
  let manifest = { stock: {}, manager: {} };
  try {
    const prev = JSON.parse(await fs.readFile(INDEX, 'utf8'));
    manifest = { stock: prev.stock ?? {}, manager: prev.manager ?? {} };
  } catch { /* first run */ }

  if (ONLY !== 'manager') {
    const s = await stocks(manifest);
    console.log(`shares:   ${s.got} fetched, ${s.kept} already held, ${s.missed} without a mark`);
  }
  if (ONLY !== 'stock') {
    const meta = JSON.parse(await fs.readFile(path.join(DATA, 'meta.json'), 'utf8'));
    const m = await managers(manifest, meta.founders ?? []);
    console.log(`managers: ${m.got} fetched, ${m.kept} already held, `
      + `${m.borrowed} wearing their listed group's mark, ${m.missed} without one`);
  }

  // Files nothing points at any more: a manager that has since been mapped to
  // its listed group keeps no second copy of a mark it no longer wears, and a
  // fund house that has left TEFAS keeps nothing at all. Only on a full run,
  // because half a manifest cannot say what the other half still needs.
  if (!ONLY) {
    const referenced = new Set([
      ...Object.values(manifest.stock),
      ...Object.values(manifest.manager),
    ]);
    for (const [dir, prefix] of [[STOCK_DIR, 'stock'], [MANAGER_DIR, 'manager']]) {
      for (const name of await existing(dir)) {
        if (referenced.has(`${prefix}/${name}`)) continue;
        await fs.rm(path.join(dir, name), { force: true });
        console.log(`  dropped ${prefix}/${name}, nothing points at it`);
      }
    }
  }

  // Sorted, so a rebuild that changes nothing is a no-op in git rather than a
  // reshuffled 20KB file in every data commit.
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(INDEX, `${JSON.stringify({
    builtAt: new Date().toISOString(),
    stock: sorted(manifest.stock),
    manager: sorted(manifest.manager),
  }, null, 0)}\n`);

  console.log(`index:    ${Object.keys(manifest.stock).length} shares, `
    + `${Object.keys(manifest.manager).length} funds' managers`);
}

await main();
