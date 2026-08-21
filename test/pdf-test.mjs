import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { extractText, extractRows, parseCMaps, joinRow, unwrapPdf } from '../scripts/lib/pdf.mjs';

// A real "Portföy Dağılım Raporu" as filed on KAP — QNB Portföy Altın Fonu,
// July 2026. Kept as a fixture because every rule in the extractor exists to
// handle something this file actually does.
const FIXTURE = new URL('./fixtures/kap-portfolio-report.pdf', import.meta.url);
const pdf = await fs.readFile(FIXTURE);

test('the report carries ToUnicode CMaps declaring two-byte codes', () => {
  const maps = parseCMaps(pdf);
  assert.ok(maps.length >= 1, 'no CMap found');
  // Two-byte codes are the whole reason the naive decode produced "P o r t f ö y".
  assert.equal(maps[0].bytes, 2);
  assert.ok(maps[0].size > 50, `CMap looks too small: ${maps[0].size} entries`);
});

test('Turkish characters survive the subset font encoding', () => {
  const text = extractText(pdf).join('\n');
  // These only resolve through the CMap; a byte-wise read gives mojibake.
  for (const word of ['Portföy', 'Altın', 'Ünvanı', 'İHRAÇCI', 'HAZİNE', 'Değeri']) {
    assert.ok(text.includes(word), `missing "${word}" — font decoding regressed`);
  }
});

test('words are reconstructed, not left as loose glyphs', () => {
  const text = extractText(pdf).join('\n');
  assert.ok(text.includes('Kurucunun Ünvanı'), 'run joining regressed');
  assert.ok(!/P o r t f/.test(text), 'glyphs were not joined back into words');
  // Column headers must stay separated rather than running together.
  assert.ok(/NOMİNAL\s/.test(text), 'adjacent columns were glued into one token');
});

test('individual holdings come through with their identifiers', () => {
  const lines = extractText(pdf);
  const bond = lines.find((l) => l.includes('TRD270127T13') && l.includes('HAZİNE'));
  assert.ok(bond, 'government bond holding row not found');
  // ISIN, issuer, maturity and the value all land on the one row.
  assert.match(bond, /TRD270127T13/);
  assert.match(bond, /27\/01\/27/);
  assert.match(bond, /1\.048\.506\.784,64/);

  // The fund's own totals are readable too, which is what lets a parse be checked
  // against the percentages TEFAS already publishes.
  const nav = lines.find((l) => l.includes('Toplam Değer/Net Varlık Değeri'));
  assert.ok(nav && nav.includes('43.137.894.067,90'), 'net asset value not found');
});

test('rows carry x positions so columns can be segmented', () => {
  const rows = extractRows(pdf);
  assert.ok(rows.length > 100, `expected a full report, got ${rows.length} rows`);
  const withCells = rows.find((r) => r.cells.length > 4);
  assert.ok(withCells, 'no multi-cell row');
  // Sorted left to right, which is what column segmentation depends on.
  const xs = withCells.cells.map((c) => c.x);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b));
  assert.ok(withCells.cells.every((c) => typeof c.size === 'number'));
});

test('joinRow spaces by geometry, not by guesswork', () => {
  // Two runs flush against each other are one word...
  assert.equal(joinRow([
    { x: 0, text: 'Port', size: 10 },
    { x: 20, text: 'föy', size: 10 },
  ]), 'Portföy');
  // ...and a run starting well past the previous one's end is a new column.
  assert.equal(joinRow([
    { x: 0, text: 'Port', size: 10 },
    { x: 200, text: 'föy', size: 10 },
  ]), 'Port föy');
  assert.equal(joinRow([]), '');
});

test('unwrapPdf strips the Java-serialised wrapper KAP returns', () => {
  // KAP's file endpoint answers with a serialised byte[], not a raw file: the
  // 0xACED stream magic comes first and %PDF starts a few bytes in.
  const wrapped = Buffer.concat([
    Buffer.from([0xac, 0xed, 0x00, 0x05, 0x75, 0x72]),
    Buffer.from('%PDF-1.5\nrest'),
  ]);
  assert.equal(unwrapPdf(wrapped).toString('latin1'), '%PDF-1.5\nrest');
  // An already-raw PDF passes through untouched.
  const raw = Buffer.from('%PDF-1.7\nx');
  assert.equal(unwrapPdf(raw), raw);
  assert.equal(unwrapPdf(Buffer.from('no pdf here')), null);
});

test('pages are kept apart and taken in reading order', () => {
  const rows = extractRows(pdf);
  // Two sheets share a coordinate space. Pooling them groups rows that merely
  // share a y, which spliced the fund-identity table into the holdings rows.
  assert.ok(rows.every((r) => typeof r.page === 'number'), 'rows carry no page');
  const pages = [...new Set(rows.map((r) => r.page))];
  assert.deepEqual(pages, [...pages].sort((a, b) => a - b), 'pages came out of order');
  assert.ok(pages.length >= 2, 'expected a multi-page report');

  // Page order follows the /Pages tree, not object numbering — they disagree in
  // longer reports, which put the last page's table under the first's heading.
  const text = extractText(pdf);
  const heading = text.findIndex((l) => /I-FONU TANITICI B/i.test(l));
  const table = text.findIndex((l) => /III-FON PORTF.Y DE.ER. TABLOSU/i.test(l));
  assert.ok(heading >= 0 && table > heading, 'sections came out in the wrong order');

  // Rows within a page run down the page.
  for (const p of pages) {
    const ys = rows.filter((r) => r.page === p).map((r) => r.y);
    assert.deepEqual(ys, [...ys].sort((a, b) => b - a), `page ${p} rows are not top-to-bottom`);
  }
});

test('streams are decoded by their filter, not by assumption', () => {
  // Several filers store their ToUnicode CMaps uncompressed. Assuming Flate
  // throws those away, and every glyph then decodes to its raw code.
  const maps = parseCMaps(pdf);
  assert.ok(maps.length >= 1);
  assert.ok(maps.every((m) => m.size > 0));
});
