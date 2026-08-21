import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  parseReport, check, numberStyle, parseNumber, joinWrapped, columnGuide,
  pctColumnAt, readPeriod, periodName,
} from '../scripts/lib/portfolio.mjs';
import { parseAttachments, publishDay, unwrap, PORTFOLIO_SUBJECT } from '../scripts/lib/kap.mjs';
import { extractRows } from '../scripts/lib/pdf.mjs';

// A real "Portföy Dağılım Raporu" as filed on KAP — QNB Portföy Altın Fonu,
// July 2026. Kept as a fixture because every rule in the parser exists to handle
// something this file actually does.
const FIXTURE = new URL('./fixtures/kap-portfolio-report.pdf', import.meta.url);
const pdf = await fs.readFile(FIXTURE);

test('number style is detected, not assumed', () => {
  // Filers use both conventions and reading one as the other multiplies a value
  // by a thousand without any sign that anything went wrong.
  assert.equal(numberStyle(['1.048.506.784,64', '3,96']), 'tr');
  assert.equal(numberStyle(['4,796,951.96', '68.73']), 'us');
  // Both separators present: the last one is the decimal point.
  assert.equal(numberStyle(['1.234,56']), 'tr');
  assert.equal(numberStyle(['1,234.56']), 'us');
  // A lone separator followed by three digits could be either, so it abstains
  // rather than voting badly; the default stands.
  assert.equal(numberStyle(['1.234']), 'tr');

  assert.equal(parseNumber('1.048.506.784,64', 'tr'), 1048506784.64);
  assert.equal(parseNumber('4,796,951.96', 'us'), 4796951.96);
  assert.equal(parseNumber('-547.000,00', 'tr'), -547000);
  assert.equal(parseNumber('68.73%', 'us'), 68.73);
  assert.equal(parseNumber('HAZİNE', 'tr'), null);
  assert.equal(parseNumber('', 'tr'), null);
});

test('names wrapped mid-word are put back together', () => {
  // The issuer column wraps on character count, so spaces vanish at the break.
  assert.equal(
    joinWrapped(['MEDİCAL', 'PARK', 'SAĞLIK', 'HİZMETLE', 'Rİ A.Ş']),
    'MEDİCAL PARK SAĞLIK HİZMETLERİ A.Ş');
  assert.equal(joinWrapped(['HAZİNE']), 'HAZİNE');
  assert.equal(joinWrapped([]), '');
});

test('the holdings table columns are read from its own header', () => {
  const rows = extractRows(pdf);
  const guide = columnGuide(rows);
  assert.ok(guide, 'header not located');
  // The three percentage columns must be told apart: only FPD is a portfolio
  // weight. GRUP is a share of the group and FTD a share of the fund's total.
  assert.ok(guide.pct.group < guide.pct.fpd, 'GRUP must sit left of FPD');
  assert.ok(guide.pct.fpd < guide.pct.ftd, 'FPD must sit left of FTD');
  assert.ok(guide.anchors.value < guide.pct.group, 'value column must precede the percentages');
});

test('a real report parses into individual positions', () => {
  const report = parseReport(pdf);
  assert.equal(report.form, 'A');
  assert.equal(report.ok, true, report.problems.join('; '));
  assert.equal(report.period, 'Temmuz-2026');
  assert.match(report.fund.name ?? '', /Alt.n Fonu/);
  assert.equal(report.portfolioValue, 43204504130.42);

  // The point of the whole feature: securities, not asset classes.
  const bond = report.holdings.find((h) => h.isin === 'TRT270127T15');
  assert.ok(bond, 'government bond holding not found');
  assert.equal(bond.value, 1049302504.0);
  assert.equal(bond.currency, 'AU1');
  assert.match(bond.group ?? '', /BOR.LANMA/i);

  const stock = report.holdings.find((h) => h.code === 'MPARK');
  assert.ok(stock, 'equity holding not found');
  assert.equal(stock.isin, 'TREMLPC00021');
  assert.equal(stock.name, 'MEDİCAL PARK SAĞLIK HİZMETLERİ A.Ş');
});

test('weights come from the FPD column, so derivatives do not inflate a fund', () => {
  const report = parseReport(pdf);
  // This fund holds futures with billions in notional value and no portfolio
  // weight at all. Deriving weights from value instead would have it holding
  // several times its own size.
  const futures = report.holdings.filter((h) => h.code.startsWith('F_'));
  assert.ok(futures.length, 'no futures in this fixture');
  assert.ok(futures.some((f) => f.value > 1e8), 'expected a large notional');
  for (const f of futures) assert.equal(f.weight, 0);

  const total = report.holdings.reduce((t, h) => t + h.weight, 0);
  assert.ok(Math.abs(total - 100) < 0.5, `weights sum to ${total}, not 100`);
});

test('reconciliation passes on a good parse', () => {
  const verdict = check(parseReport(pdf));
  assert.equal(verdict.ok, true, verdict.problems.join('; '));
  assert.deepEqual(verdict.warnings, []);
  assert.ok(Math.abs(verdict.weightTotal - 100) < 0.5);
});

test('reconciliation rejects a parse that stops adding up', () => {
  const report = parseReport(pdf);
  // Losing a row is the failure mode that would otherwise publish quietly wrong
  // holdings, so the subtotals have to catch it.
  const damaged = { ...report, holdings: report.holdings.slice(1) };
  const verdict = check(damaged);
  assert.equal(verdict.ok, false, 'a dropped holding went unnoticed');
  assert.ok(verdict.problems.some((p) => /sums to/.test(p)), verdict.problems.join('; '));
});

test('a report whose own totals disagree is flagged, not discarded', () => {
  const report = parseReport(pdf);
  // Every subtotal still reconciles; only the overall total is short. That means
  // the reading is right and the filer's arithmetic is not, so the fund should
  // still publish — with the discrepancy recorded.
  const shrunk = {
    ...report,
    holdings: report.holdings.map((h) => ({ ...h, weight: h.weight * 0.9 })),
    groups: report.groups.map((g) => ({ ...g, weight: g.weight == null ? null : g.weight * 0.9 })),
  };
  const verdict = check(shrunk);
  assert.equal(verdict.ok, true, verdict.problems.join('; '));
  assert.ok(verdict.warnings.some((w) => /not 100%/.test(w)), 'discrepancy was not recorded');
});

test('an unreadable report fails cleanly instead of returning nothing', () => {
  // Some filers submit a scan; there is no text layer to read at all.
  const notAPdf = Buffer.from('%PDF-1.4\nnothing here\n%%EOF');
  const report = parseReport(notAPdf);
  assert.equal(report.ok, false);
  assert.equal(report.holdings.length, 0);
  assert.ok(report.problems.length, 'no reason given for the failure');
});

test('KAP responses are decoded the way KAP actually sends them', () => {
  assert.equal(PORTFOLIO_SUBJECT, 'Portföy Dağılım Raporu');
  assert.equal(publishDay('18.08.2026 13:33:28'), '2026-08-18');
  assert.equal(publishDay(''), null);

  // The disclosure page carries its attachments inside a Next.js flight payload,
  // sometimes with the quotes escaped and sometimes not depending on which
  // streaming chunk it lands in.
  const plain = '…,"attachments":[{"objId":"4028328c9f52dc40019fed272d0a663d","fileName":"SHU_2026.07.pdf","fileExtension":"pdf"}],"lang":"tr"';
  const escaped = plain.replace(/"/g, '\\"');
  for (const html of [plain, escaped]) {
    const found = parseAttachments(html);
    assert.equal(found.length, 1);
    assert.equal(found[0].objId, '4028328c9f52dc40019fed272d0a663d');
    assert.equal(found[0].fileName, 'SHU_2026.07.pdf');
  }
  assert.deepEqual(parseAttachments('{"attachments":[]}'), []);

  // The file endpoint answers with a Java-serialised byte[], not a raw file.
  const wrapped = Buffer.concat([Buffer.from([0xac, 0xed, 0x00, 0x05]), Buffer.from('%PDF-1.5\nx')]);
  assert.equal(unwrap(wrapped).toString('latin1'), '%PDF-1.5\nx');
  assert.equal(unwrap(Buffer.from('not a pdf')), null);
});

// The other template in the wild: a narrow portrait table with lettered asset
// classes, English number formatting, and the whole page drawn through a
// vertical flip. Ata Portföy Fon Sepeti Serbest Fonu, July 2026.
const FORM_B = new URL('./fixtures/kap-report-form-b.pdf', import.meta.url);
const pdfB = await fs.readFile(FORM_B);

test('the second report template parses too', () => {
  const report = parseReport(pdfB);
  assert.equal(report.form, 'B');
  assert.equal(report.ok, true, report.problems.join('; '));
  assert.equal(check(report).ok, true);

  // Numbers here are 1,234.56 rather than 1.234,56. Reading one as the other
  // would be out by a factor of a thousand with nothing to show for it.
  assert.equal(report.portfolioValue, 17830326.03);
  assert.equal(report.fund.netAssetValue, 16608397.93);
  assert.equal(report.fund.name, 'AAS-ATA PORTFÖY FON SEPETİ SERBEST FONU');

  // The month is folded into a title line here and stands alone in Form A;
  // both normalise to the same shape so the site need not know the difference.
  assert.equal(report.period, 'Temmuz-2026');

  const spy = report.holdings.find((h) => h.isin === 'US78462F1030');
  assert.ok(spy, 'foreign ETF holding not found');
  assert.equal(spy.value, 2422411.48);
  assert.equal(spy.weight, 13.59);
});

test('a fund of funds links to the funds it holds', () => {
  const report = parseReport(pdfB);
  // "Which other funds does this one hold" is answerable because the report
  // carries their TEFAS codes.
  const held = report.holdings.filter((h) => h.ref);
  assert.ok(held.length >= 2, `expected fund references, got ${held.length}`);
  assert.deepEqual(held.map((h) => h.ref).sort(), ['AAL', 'URA']);
  // A currency line looks identical at a glance and must not be mistaken for one.
  assert.ok(!report.holdings.some((h) => h.ref === 'TRY'), 'a currency was taken for a fund');
});

test('Turkish dotted capitals are matched, not silently missed', () => {
  // JavaScript's `i` flag does not fold İ onto i, so a pattern ending in a
  // literal "i" reads the mixed-case reports and misses every upper-case one.
  // Form A prints "Net Varlık Değeri"; Form B prints "NET VARLIK DEĞERİ".
  assert.ok(parseReport(pdf).fund.netAssetValue > 0, 'Form A net asset value lost');
  assert.ok(parseReport(pdfB).fund.netAssetValue > 0, 'Form B net asset value lost');
});

test('a weight written as a fraction is read as one', () => {
  // Form B is not consistent even inside one document: securities print "1.75%"
  // while repo and deposit rows print the bare fraction "0.069767681" for the
  // same quantity. Read literally, a money-market fund loses a third of itself.
  const report = parseReport(pdfB);
  const total = report.holdings.reduce((t, h) => t + (h.weight ?? 0), 0);
  assert.ok(Math.abs(total - 100) < 1, `weights sum to ${total.toFixed(2)}, not 100`);
  // Every weight should read as a percentage, never as a leftover fraction.
  assert.ok(report.holdings.every((h) => h.weight == null || Math.abs(h.weight) <= 100.5));
});

test('a percentage belongs to the last heading left of it, not the nearest', () => {
  // Real geometry from İş Portföy's template, measured off IJC's July 2026
  // filing. The headings are 57 and 78 apart; the figures sit 40 to the right of
  // their own heading, which puts the group percentage nearer the FPD heading
  // than its own. A midpoint split read it as the portfolio weight, so every
  // fund on this template published each group summing to 100% and itself to
  // 400%, and IJC's holdings were wrong by exactly that factor.
  const pct = { group: 1275.06, fpd: 1332.4, ftd: 1409.75 };
  assert.equal(pctColumnAt(pct, 1315), 'group');
  assert.equal(pctColumnAt(pct, 1392), 'fpd');
  assert.equal(pctColumnAt(pct, 1469), 'ftd');
  // The midpoint rule this replaced put 1315 in the FPD column:
  assert.notEqual(pctColumnAt(pct, 1315), 'fpd');

  // A figure flush under its own heading still lands in it — the common case,
  // and the one the old rule got right.
  assert.equal(pctColumnAt(pct, 1276), 'group');
  assert.equal(pctColumnAt(pct, 1333), 'fpd');

  // A figure wider than its column may start a whisker left of the heading.
  assert.equal(pctColumnAt(pct, 1329), 'fpd');
  // Anything left of the first heading is not a percentage column at all.
  assert.equal(pctColumnAt(pct, 1100), null);

  // Templates that print only two of the three columns still resolve.
  assert.equal(pctColumnAt({ fpd: 1332, ftd: 1409 }, 1392), 'fpd');
  assert.equal(pctColumnAt({ fpd: 1332 }, 1500), 'fpd');
  assert.equal(pctColumnAt({}, 1500), null);
});

test('a date is not a reporting period', () => {
  const line = (text) => ({ text });

  // Form A prints the period on its own line, Form B folds it into a title.
  assert.equal(readPeriod([line('TEMMUZ-2026')]), 'Temmuz-2026');
  assert.equal(readPeriod([line('AAS FON TEMMUZ 2026 PORTFÖY DAĞILIM RAPORU')]), 'Temmuz-2026');
  assert.equal(readPeriod([line('Haziran 2026')]), 'Haziran-2026');

  // İş Portföy abbreviates its own period to "T-2026", so the only full month
  // name in the document is the fund's founding date. A July 2026 report was
  // being published as May 2021 on the strength of that one line.
  assert.equal(readPeriod([line('F-)Fonun Kuruluş Tarihi : 25 Mayıs 2021')]), null);
  assert.equal(readPeriod([line('Kuruluş: 1 Ocak 2020')]), null);
  // The date must not shadow a real period stated elsewhere.
  assert.equal(
    readPeriod([line('F-)Fonun Kuruluş Tarihi : 25 Mayıs 2021'), line('TEMMUZ-2026')]),
    'Temmuz-2026');

  assert.equal(readPeriod([line('nothing here')]), null);
  assert.equal(readPeriod([]), null);
});

test('the month asked for can stand in for a period the filing does not print', () => {
  assert.equal(periodName('2026-07'), 'Temmuz-2026');
  assert.equal(periodName('2026-01'), 'Ocak-2026');
  assert.equal(periodName('2026-12'), 'Aralık-2026');
  assert.equal(periodName('nonsense'), null);
  assert.equal(periodName(null), null);
});
