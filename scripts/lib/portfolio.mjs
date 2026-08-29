// Reads a KAP "Portföy Dağılım Raporu" into the securities a fund holds.
//
// TEFAS publishes only asset-class percentages — "37% precious metals" — so this
// report is the only public route to the individual positions.
//
// The regulator fixes the contents but not the typesetting, and filers use two
// different templates for it:
//
//   Form A  the wide landscape table, "III-FON PORTFÖY DEĞERİ TABLOSU", one row
//           per position with maturity, ISIN, nominal, value and three
//           percentage columns. Roughly four fifths of the market.
//   Form B  a narrow portrait table, "3- FON PORTFÖY DEĞERİ TABLOSU", with
//           lettered asset-class sections and only issuer / nominal / value / %.
//
// Numbers arrive in Turkish (1.234,56) or English (1,234.56) format depending on
// the filer, so the convention is detected per document rather than assumed.
//
// The parser never guesses. Every fund is reconciled against the subtotals the
// report prints for itself, and one that does not add up is rejected rather than
// published. See `check`.

import { extractRows, joinRow } from './pdf.mjs';

// "TABLOSU" is deliberately not required: several filers wrap the heading, so
// the word lands on the line below and the section is missed entirely. The
// section number carries enough to identify it on its own — and note the
// patterns stop before the final dotted İ, which JavaScript's `i` flag will not
// fold onto an i.
const FORM_A_START = /III\s*-\s*FON PORTF.Y DE.ER/i;
const FORM_A_END = /IV\s*-\s*FON TOPLAM DE.ER/i;
const FORM_B_START = /^\s*\d+\s*[-.]\s*FON PORTF.Y DE.ER/i;
const FORM_B_END = /^\s*\d+\s*[-.]\s*FON TOPLAM DE.ER/i;

const GROUP_TOTAL = /^\s*GRUP TOPLAMI/i;
const PORTFOLIO_TOTAL = /^\s*FON PORTF.Y DE.ER.\s/i;

/** Anything that could be a formatted number, in either convention. */
const NUMERIC = /^-?\d[\d.,]*%?$/;

/** ISINs are the one identifier in these reports that is globally unique. */
const ISIN = /\b([A-Z]{2}[A-Z0-9]{9}\d)\b/;

/** A TEFAS fund code, as it appears where a fund-of-funds would carry an ISIN. */
const FUND_CODE = /^[A-Z0-9]{2,6}$/;

/**
 * Work out whether a document writes 1.234,56 or 1,234.56.
 *
 * Both appear, and reading one as the other is silent and catastrophic — the
 * same digits become a number a thousand times too large. Only unambiguous
 * tokens vote: a value with both separators is decided by whichever comes last,
 * and a value with one separator is decided when it repeats (thousands) or when
 * it is not followed by exactly three digits (a decimal). "1.234" alone could be
 * either, so it abstains.
 */
export function numberStyle(texts) {
  let tr = 0;
  let us = 0;
  for (const raw of texts) {
    const s = String(raw ?? '').trim().replace(/%$/, '');
    if (!NUMERIC.test(s)) continue;
    const comma = s.lastIndexOf(',');
    const dot = s.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) { comma > dot ? tr++ : us++; continue; }
    const sep = comma >= 0 ? ',' : dot >= 0 ? '.' : null;
    if (!sep) continue;
    const parts = s.split(sep);
    if (parts.length > 2) { sep === '.' ? tr++ : us++; continue; }
    if (parts[1].length !== 3) { sep === ',' ? tr++ : us++; }
  }
  return us > tr ? 'us' : 'tr';
}

/**
 * A formatted number -> Number, or null if the text is not one.
 *
 * @param {string} text
 * @param {'tr'|'us'} [style] the document's convention, from `numberStyle`
 */
export function parseNumber(text, style = 'tr') {
  const s = String(text ?? '').trim().replace(/%$/, '');
  if (!NUMERIC.test(s)) return null;
  const bare = style === 'tr'
    ? s.replace(/\./g, '').replace(',', '.')
    : s.replace(/,/g, '');
  const n = Number(bare);
  return Number.isFinite(n) ? n : null;
}

/**
 * Put every weight on the same scale, whichever way the filer wrote them.
 *
 * Form B's percentage column is not consistent even inside one document: the
 * securities sections print "1.75%" while the repo and deposit sections print
 * the bare fraction "0.069767681" for the same quantity. Read literally, a
 * money-market fund reports a third of itself missing.
 *
 * Deciding per cell would be wrong — a genuine 0.42% written without a sign
 * would be inflated to 42%. So the decision is made once, over the whole
 * document, and checked against the answer it has to produce: weights that
 * already sum to about 100 are per cent, and ones that sum to about 1 are
 * fractions. Only cells with no per-cent sign of their own are ever rescaled,
 * and if neither total is close enough to be convincing the figures are left
 * exactly as printed for the reconciliation to judge.
 */
function normaliseWeights(holdings) {
  const loose = holdings.filter((h) => h.weight != null && !h.signed);
  if (loose.length) {
    const total = holdings.reduce((t, h) => t + (h.weight ?? 0), 0);
    const scaled = holdings.reduce(
      (t, h) => t + (h.weight == null ? 0 : h.signed ? h.weight : h.weight * 100), 0);
    if (Math.abs(scaled - 100) < Math.abs(total - 100)) {
      for (const h of loose) h.weight *= 100;
    }
  }
  for (const h of holdings) delete h.signed;
  return holdings;
}

/**
 * Rebuild a name that a report wrapped across lines.
 *
 * The issuer column wraps on character count, not on words, so "MEDİCAL PARK
 * SAĞLIK HİZMETLERİ A.Ş" arrives as five fragments with the spaces eaten and
 * "HİZMETLERİ" split down the middle. A fragment shorter than the column's wrap
 * width ended because a space ended it; one that fills the width ran on into the
 * next line. That recovers most names exactly.
 *
 * It cannot recover all of them: a word that happens to fill the column exactly
 * is indistinguishable from a mid-word break, so the odd space goes missing.
 * The name is a convenience here — `code` and `isin` are the identifiers that
 * matter, and both are exact.
 */
export function joinWrapped(parts) {
  const clean = parts.map((p) => p.trim()).filter(Boolean);
  if (clean.length < 2) return clean[0] ?? '';
  const width = Math.max(...clean.map((p) => p.length));
  let out = clean[0];
  for (let i = 1; i < clean.length; i++) {
    out += clean[i - 1].length < width ? ' ' : '';
    out += clean[i];
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * The TEFAS code of a held fund, when a holding is one.
 *
 * A fund-of-funds puts the held fund's code where an ISIN would go — "PRH"
 * against a holding named "PRH-AURA PORTFÖY PARA PİYASASI (TL) FONU" — which is
 * what links a fund to the funds it owns. A currency row looks the same at a
 * glance ("USD" in both columns), so a reference only counts when the code
 * column carries more than the bare token.
 */
function fundRef(cells, code) {
  const name = String(code ?? '').trim();
  const hit = cells.find((c) => {
    const t = c.text.trim();
    return FUND_CODE.test(t) && name.length > t.length && name.startsWith(t);
  });
  return hit ? hit.text.trim() : null;
}

/**
 * The most common font size among data rows.
 *
 * Form A sets group headings larger than the rows beneath them, which is the
 * only reliable way to tell "BORÇLANMA SENETLERİ" (a heading) from a holding
 * whose name happens to be in capitals.
 */
function bodySize(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (row.cells.length < 5) continue;
    const size = Math.round((row.cells[0].size ?? 0) * 10) / 10;
    counts.set(size, (counts.get(size) ?? 0) + 1);
  }
  let best = 7;
  let most = 0;
  for (const [size, n] of counts) if (n > most) { most = n; best = size; }
  return best;
}

/** Form A's column anchors, read from the table's own repeated header. */
const FORM_A_COLUMNS = [
  ['code', /^MENKUL KIYMET/i],
  ['currency', /^D.Vİ/i],
  ['issuer', /^İHRA.CI/i],
  ['maturity', /^VADE\b/i],
  ['days', /^VADEYE/i],
  ['isin', /ISIN KODU/i],
  ['nominal', /NOM.NAL DE.ER/i],
  ['value', /TOPLAM DE.ER/i],
];

/**
 * Locate Form A's columns from its header.
 *
 * The three trailing percentage columns matter most. "GRUP (%)" is a holding's
 * share of its group, "TOPLAM (FPD GÖRE)" its share of the fund's *portfolio*
 * value and "TOPLAM (FTD GÖRE)" its share of the fund's *total* value. Only FPD
 * is a portfolio weight, and the difference is not cosmetic: a futures position
 * or an FX balance carries a market value but an FPD of zero, so adding values
 * up over-counts a fund by as much as it holds in derivatives.
 *
 * Header words are matched loosely because some filers break them across cells —
 * "(FPD" arrives as "M (FPD" where the column heading wrapped.
 */
export function columnGuide(rows) {
  const anchors = {};
  const pct = {};
  for (const row of rows) {
    for (const cell of row.cells) {
      for (const [key, re] of FORM_A_COLUMNS) {
        if (anchors[key] == null && re.test(cell.text.trim())) anchors[key] = cell.x;
      }
      if (cell.x > 0.7 * lastX(rows)) {
        if (/\(FPD/i.test(cell.text)) pct.fpd ??= cell.x;
        else if (/\(FTD/i.test(cell.text)) pct.ftd ??= cell.x;
        else if (/^GRUP\b/i.test(cell.text) || /^\(%\)$/.test(cell.text.trim())) {
          pct.group = Math.min(pct.group ?? Infinity, cell.x);
        }
      }
    }
  }
  if (anchors.code == null || anchors.value == null || pct.fpd == null) return null;

  const INSET = 16;
  const sorted = Object.entries(anchors).sort((a, b) => a[1] - b[1]);
  const band = (name) => {
    const at = sorted.findIndex(([k]) => k === name);
    if (at < 0) return [Infinity, -Infinity];
    const next = sorted[at + 1]?.[1] ?? pct.group ?? pct.fpd;
    return [sorted[at][1] - INSET, next - INSET];
  };
  return { anchors, pct, band };
}

/** The rightmost x anywhere in the table — the page's usable width. */
function lastX(rows) {
  let max = 0;
  for (const r of rows) for (const c of r.cells) if (c.x > max) max = c.x;
  return max || 1;
}

/**
 * Parse a portfolio distribution report.
 *
 * @param {Buffer} pdf the report, already unwrapped from KAP's envelope
 * @returns {{
 *   ok: boolean, problems: string[], form: 'A'|'B'|null, period: string|null,
 *   fund: {name: string|null, founder: string|null, netAssetValue: number|null},
 *   portfolioValue: number|null,
 *   holdings: {code:string|null, isin:string|null, ref:string|null, name:string|null,
 *              currency:string|null, group:string|null, subgroup:string|null,
 *              nominal:number|null, value:number|null, weight:number|null}[],
 *   groups: {group:string|null, subgroup:string|null, value:number|null,
 *            weight:number|null, members:number}[],
 * }}
 */
export function parseReport(pdf) {
  let rows;
  try {
    rows = extractRows(pdf);
  } catch (err) {
    return fail(`PDF could not be read: ${err.message}`);
  }
  if (!rows.length) {
    // Some filers submit a scan or a raster with no text layer at all.
    return fail('No text in the PDF (likely a scanned or image-only report)');
  }

  const lines = rows.map((r) => ({ ...r, text: joinRow(r.cells) }));
  const fund = readFundInfo(lines);
  const period = readPeriod(lines);

  const startAt = lines.findIndex((l) => FORM_A_START.test(l.text) || FORM_B_START.test(l.text));
  if (startAt < 0) return fail('No holdings table found (unrecognised report template)', fund, period);
  const endRel = lines.slice(startAt + 1)
    .findIndex((l) => FORM_A_END.test(l.text) || FORM_B_END.test(l.text));
  const table = lines.slice(startAt + 1, endRel < 0 ? undefined : startAt + 1 + endRel);

  // Which template this is comes from the table's own header, not from how the
  // section was numbered. One filer numbers its sections in Roman like Form A
  // and then lays the table out like Form B, so the heading is no guide at all.
  const col = columnGuide(table);
  if (col) return readFormA(table, col, fund, period);
  return readFormB(lines, table, fund, period);
}

/**
 * A whisker of tolerance for a figure wider than its column, which can start a
 * point or two left of the heading it belongs to.
 */
const PCT_SLACK = 6;

/**
 * Which percentage column a figure at `x` belongs to.
 *
 * The three columns are right-aligned under left-aligned headings, so a figure
 * sits to the RIGHT of its own heading — sometimes far enough right to be nearer
 * the next heading than its own. Splitting each gap midway therefore reads the
 * wrong column whenever the headings are closer together than the figures are
 * offset. İş Portföy's template puts "GRUP (%)" at x=1275 with its figure at
 * 1315, and "TOPLAM (FPD GÖRE)" at 1332: the midpoint falls at 1303, so the
 * group percentage was taken as the portfolio weight. Every fund on that
 * template came out with each of its groups summing to 100% and the fund itself
 * to 400%.
 *
 * The rule the columns are actually built on is simpler: a figure belongs to the
 * last heading that starts left of it.
 *
 * @param {{group?: number, fpd?: number, ftd?: number}} pct heading positions
 * @param {number} x the figure's left edge
 * @returns {'group'|'fpd'|'ftd'|null}
 */
export function pctColumnAt(pct, x) {
  const columns = [['group', pct?.group], ['fpd', pct?.fpd], ['ftd', pct?.ftd]]
    .filter(([, at]) => at != null)
    .sort((a, b) => a[1] - b[1]);
  let id = null;
  for (const [name, at] of columns) if (x >= at - PCT_SLACK) id = name;
  return id;
}

/** The wide landscape table most filers use. */
function readFormA(table, col, fund, period) {

  const style = numberStyle(table.flatMap((r) => r.cells.map((c) => c.text)));
  const num = (t) => parseNumber(t, style);
  const size = bodySize(table);
  const pctFrom = Math.min(col.pct.group ?? Infinity, col.pct.fpd) - 12;
  const [issuerLo, issuerHi] = col.band('issuer');
  const [isinLo, isinHi] = col.band('isin');
  const [currencyLo, currencyHi] = col.band('currency');
  const [nominalLo, nominalHi] = col.band('nominal');

  const fpdOf = (cells) => {
    const hit = cells.find((c) => pctColumnAt(col.pct, c.x) === 'fpd' && num(c.text) != null);
    return hit ? num(hit.text) : null;
  };

  const holdings = [];
  const groups = [];
  let portfolioValue = null;
  let group = null;
  let subgroup = null;
  let current = null;
  let pending = 0;

  const flush = () => {
    if (!current) return;
    current.name = joinWrapped(current._name) || null;
    delete current._name;
    holdings.push(current);
    pending++;
    current = null;
  };

  for (const row of table) {
    const { cells, text } = row;
    if (!cells.length) continue;
    const first = cells[0];
    const rowSize = Math.round((first.size ?? 0) * 10) / 10;
    const numeric = cells.filter((c) => num(c.text) != null);

    if (PORTFOLIO_TOTAL.test(text)) {
      flush();
      const v = numeric.find((c) => c.x < pctFrom);
      if (v) portfolioValue = num(v.text);
      continue;
    }

    if (GROUP_TOTAL.test(text)) {
      flush();
      // Two totals are printed per group — one for the subgroup, one for the
      // whole group — distinguished only by type size. Keep the subgroup's, and
      // pair it with the rows that preceded it rather than matching on name:
      // "Özel Sektör" appears under both bonds and lease certificates.
      if (rowSize <= size + 1) {
        const v = numeric.filter((c) => c.x < pctFrom).at(-1);
        groups.push({ group, subgroup, value: v ? num(v.text) : null, weight: fpdOf(cells), members: pending });
        pending = 0;
      }
      continue;
    }

    // A heading: one or two cells at the left margin, no figures, set larger
    // than the rows it introduces.
    if (!numeric.length && first.x < col.anchors.code + 20 && rowSize > size + 0.5 && cells.length <= 2) {
      flush();
      if (rowSize >= size + 2.5) { group = text; subgroup = null; } else { subgroup = text; }
      continue;
    }

    // Column headers repeat on every page of the table.
    if (!numeric.length && /MENKUL KIYMET|ISIN KODU|VADEYE|G.NL.K BR/i.test(text)) continue;

    const value = numeric.filter((c) => c.x < pctFrom).at(-1);

    // A holding starts in the leftmost column and carries a value.
    if (first.x < col.anchors.code + 20 && value && rowSize <= size + 0.5) {
      flush();
      const inIsin = cells.filter((c) => c.x >= isinLo && c.x < isinHi);
      const isinCell = inIsin.find((c) => ISIN.test(c.text));
      const nominalCell = numeric.find((c) => c.x >= nominalLo && c.x < nominalHi);
      current = {
        code: first.text.trim(),
        isin: isinCell ? ISIN.exec(isinCell.text)[1] : null,
        ref: isinCell ? null : fundRef(inIsin, first.text),
        currency: cells.find((c) => c.x >= currencyLo && c.x < currencyHi)?.text.trim() ?? null,
        group,
        subgroup,
        nominal: nominalCell ? num(nominalCell.text) : null,
        value: num(value.text),
        weight: fpdOf(cells),
        _name: cells.filter((c) => c.x >= issuerLo && c.x < issuerHi).map((c) => c.text),
      };
      continue;
    }

    // Whatever is left is a continuation line, and what it carries belongs to
    // the holding above. Headings, subtotals, column headers and holdings have
    // all been taken already, so this needs no position test — which matters,
    // because a held fund's name wraps in the leftmost column just like a new
    // holding would start there.
    if (current && rowSize <= size + 0.5) {
      const inIsin = cells.filter((c) => c.x >= isinLo && c.x < isinHi);
      const isinCell = inIsin.find((c) => ISIN.test(c.text));
      if (isinCell && !current.isin) current.isin = ISIN.exec(isinCell.text)[1];
      if (!current.isin && !current.ref) current.ref = fundRef(inIsin, current.code);
      for (const c of cells) {
        if (c.x >= issuerLo && c.x < issuerHi) current._name.push(c.text);
      }
    }
  }
  flush();

  return finish({ form: 'A', period, fund, portfolioValue, holdings, groups });
}

/**
 * The narrow portrait table, with lettered asset-class sections.
 *
 * Every asset class is printed whether or not the fund holds any of it, so most
 * of this table is headings with nothing under them. A class that does hold
 * something is followed by its rows and a `TOPLAM:` line.
 */
function readFormB(lines, table, fund, period) {
  const header = table.find((r) => r.cells.some((c) => /Rayi. De.er/i.test(c.text)));
  if (!header) return fail('Holdings table header not recognised', fund, period, 'B');
  const anchor = (re) => header.cells.find((c) => re.test(c.text))?.x ?? null;
  const issuerX = anchor(/İhra..ı/i);
  const nominalX = anchor(/Nominal De.er/i);
  const valueX = anchor(/Rayi. De.er/i);
  const pctX = anchor(/^%$/);
  // Some filers add an ISIN column that the plain form does not have.
  const isinX = anchor(/Isin Kodu|ISIN/i);
  if (valueX == null) return fail('Value column not found', fund, period, 'B');

  const style = numberStyle(table.flatMap((r) => r.cells.map((c) => c.text)));
  const num = (t) => parseNumber(t, style);
  const near = (c, x) => x != null && Math.abs(c.x - x) < 45;

  const holdings = [];
  const groups = [];
  let group = null;
  let pending = 0;
  let current = null;

  const flush = () => {
    if (!current) return;
    current.name = joinWrapped(current._name) || null;
    delete current._name;
    holdings.push(current);
    pending++;
    current = null;
  };

  for (const row of table) {
    const { cells, text } = row;
    if (!cells.length) continue;
    const numeric = cells.filter((c) => num(c.text) != null);

    if (/^\s*TOPLAM\b/i.test(text)) {
      flush();
      const v = numeric.find((c) => near(c, valueX)) ?? numeric.at(-1);
      groups.push({ group, subgroup: null, value: v ? num(v.text) : null, weight: null, members: pending });
      pending = 0;
      continue;
    }

    // "A) HİSSE SENETLERİ" and the like. Most have nothing beneath them, and
    // the letters run past Z into two-character labels on longer forms.
    if (!numeric.length && /^[A-ZÇĞİÖŞÜ]{1,2}\)\s*\S/.test(text)) {
      flush();
      group = text.replace(/^[A-ZÇĞİÖŞÜ]{1,2}\)\s*/, '').replace(/\s*:\s*$/, '').trim();
      continue;
    }
    if (/^İhra..ı/i.test(text)) continue;

    const value = numeric.find((c) => near(c, valueX));
    if (value) {
      flush();
      const leadEnd = Math.min(issuerX ?? Infinity, isinX ?? Infinity);
      const lead = cells.filter((c) => !Number.isFinite(leadEnd) || c.x < leadEnd - 16);
      const code = lead.map((c) => c.text.trim()).join(' ').trim() || null;
      const isinCell = isinX != null ? cells.find((c) => near(c, isinX) && ISIN.test(c.text)) : null;
      const pctCell = pctX != null ? numeric.find((c) => near(c, pctX)) : null;
      const nominalCell = numeric.find((c) => near(c, nominalX));
      const isin = code && ISIN.test(code) ? ISIN.exec(code)[1] : null;
      current = {
        code,
        isin: isin ?? (isinCell ? ISIN.exec(isinCell.text)[1] : null),
        // Where there is no ISIN column, a held fund shows up as a bare TEFAS
        // code sitting under the "katılma belgeleri" heading.
        ref: !isin && code && FUND_CODE.test(code) && /KATILMA BELGE/i.test(group ?? '')
          ? code
          : null,
        currency: null,
        group,
        subgroup: null,
        nominal: nominalCell ? num(nominalCell.text) : null,
        value: num(value.text),
        weight: pctCell ? num(pctCell.text) : null,
        // Whether this row printed its own per-cent sign, which is what tells
        // a percentage from a fraction once the whole table is in.
        signed: pctCell ? /%\s*$/.test(pctCell.text) : false,
        _name: cells.filter((c) => near(c, issuerX)).map((c) => c.text),
      };
      continue;
    }

    if (current) {
      for (const c of cells) if (near(c, issuerX)) current._name.push(c.text);
    }
  }
  flush();

  // Form B prints the portfolio total in the next section rather than in the
  // table, so it is read from there — skipping the section heading of the same
  // name, which carries no figure.
  let portfolioValue = null;
  for (const l of lines) {
    if (!/FON PORTF.Y DE.ER./i.test(l.text) || /TABLOSU/i.test(l.text)) continue;
    const n = l.cells.map((c) => parseNumber(c.text, style)).find((v) => v != null);
    if (n != null) { portfolioValue = n; break; }
  }

  return finish({ form: 'B', period, fund, portfolioValue, holdings: normaliseWeights(holdings), groups });
}

function finish({ form, period, fund, portfolioValue, holdings, groups }) {
  const problems = [];
  const invested = holdings.reduce((t, h) => t + Math.abs(h.value ?? 0), 0);

  // A fund that has been launched but not funded files the form with zeroes
  // throughout. There is nothing to publish and nothing wrong with the parse, so
  // it is reported as empty rather than as a failure.
  const empty = portfolioValue === 0 && invested === 0;
  if (empty) {
    return { ok: false, empty: true, problems: ['Fund holds nothing (portfolio value is zero)'],
      form, period, fund, portfolioValue, holdings: [], groups: [] };
  }

  if (!holdings.length) problems.push('No holdings rows found');
  if (portfolioValue == null) problems.push('Portfolio total (FON PORTFÖY DEĞERİ) not found');
  else if (portfolioValue === 0) problems.push('Report states a zero portfolio value but lists holdings');
  const unweighted = holdings.filter((h) => h.weight == null).length;
  if (unweighted) problems.push(`${unweighted} holdings have no portfolio weight`);
  return { ok: problems.length === 0, empty: false, problems, form, period, fund, portfolioValue, holdings, groups };
}

function fail(reason, f = null, p = null, form = null) {
  return {
    ok: false,
    problems: [reason],
    form,
    period: p,
    fund: f ?? { name: null, founder: null, netAssetValue: null },
    portfolioValue: null,
    holdings: [],
    groups: [],
  };
}

const MONTHS = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
];

/**
 * The month a report covers, normalised to "Temmuz-2026", or null.
 *
 * Form A prints it on its own line; Form B folds it into a title such as "AAS
 * FON TEMMUZ 2026 PORTFÖY DAĞILIM RAPORU". Matching the month name anywhere
 * covers both, and normalising means the site does not have to care which
 * template a fund's holdings came from.
 *
 * A month preceded by a day number is a DATE, not a reporting period, and is
 * skipped. İş Portföy's template abbreviates its own period to "T-2026", so the
 * only full month name anywhere in the document is the fund's founding date —
 * "25 Mayıs 2021" — and a July 2026 report was being filed under May 2021. When
 * nothing is left the answer is null, and the caller supplies the month it asked
 * KAP for rather than a date lifted from the wrong line.
 */
export function readPeriod(lines) {
  const re = new RegExp(`(?<!\\d\\s?)\\b(${MONTHS.join('|')})\\b[-.\\s]*(\\d{4})`, 'i');
  for (const l of lines) {
    const m = re.exec(l.text);
    if (!m) continue;
    const month = MONTHS.find((x) => x.toLocaleLowerCase('tr') === m[1].toLocaleLowerCase('tr'));
    return `${month ?? m[1]}-${m[2]}`;
  }
  return null;
}

/** "Temmuz-2026" -> "2026-07". The inverse, for lining a filing up with prices. */
export function periodMonth(name) {
  const m = /^(.+)-(\d{4})$/.exec(String(name ?? ''));
  if (!m) return null;
  const i = MONTHS.indexOf(m[1]);
  return i < 0 ? null : `${m[2]}-${String(i + 1).padStart(2, '0')}`;
}

/** "2026-07" -> "Temmuz-2026", so a fallback reads like a parsed period. */
export function periodName(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month ?? ''));
  return m ? `${MONTHS[Number(m[2]) - 1]}-${m[1]}` : null;
}

/** Section I: the fund's own identifying figures, as `A-)Label : value` lines. */
function readFundInfo(lines) {
  const field = (re) => {
    const hit = lines.find((l) => re.test(l.text));
    if (!hit) return null;
    const m = /:\s*(.+)$/.exec(hit.text);
    return m ? m[1].trim() : null;
  };
  // Note the trailing wildcard. JavaScript's `i` flag does not fold Turkish
  // dotted İ onto i, so a pattern ending in a literal "i" matches the mixed-case
  // reports and silently misses every upper-case one.
  const nav = field(/Toplam De.er\s*\/\s*Net Varl.k De.er./i);
  return {
    name: field(/^\s*A[-.]\)?\s*FONUN ADI|^\s*A-\)\s*Fonun Ad./i),
    founder: field(/Kurucunun .nvan|KURUCUNUN .NVANI/i),
    netAssetValue: nav ? parseNumber(nav, numberStyle([nav])) : null,
  };
}

/**
 * Reconcile a parse against the report's own arithmetic.
 *
 * This is the whole safety net, and it separates two very different failures.
 *
 * A **problem** means the parse is wrong: the rows beneath a subtotal do not
 * reproduce it, so a column was misread or a row was dropped or counted twice.
 * Those funds are skipped rather than published.
 *
 * A **warning** means the parse is faithful but the report is not. Filers do
 * make arithmetic mistakes — one sampled fund states a weight computed against a
 * position's dollar nominal rather than its lira value, so its own percentages
 * sum to 94.94%. Every subtotal in that report reconciles, which is exactly what
 * says the reading is right and the source is wrong. Discarding those funds
 * would throw away good holdings over someone else's typo, so they are published
 * with the discrepancy recorded.
 *
 * Weights are compared with a tolerance that grows with the number of rows,
 * because each is printed to two decimals and those roundings accumulate.
 *
 * @param {ReturnType<typeof parseReport>} report
 * @param {object} [opts]
 * @param {number} [opts.valueTolerance] allowed relative error on money sums
 */
export function check(report, { valueTolerance = 0.005 } = {}) {
  const problems = [...report.problems];
  const warnings = [];
  const rel = (a, b) => (b ? Math.abs(a - b) / Math.abs(b) : a === b ? 0 : 1);
  const sum = (list, f) => list.reduce((t, x) => t + (f(x) ?? 0), 0);

  let at = 0;
  for (const g of report.groups) {
    const mine = report.holdings.slice(at, at + g.members);
    at += g.members;
    const label = g.subgroup ?? g.group ?? '(unnamed)';
    if (g.value != null) {
      const mineValue = sum(mine, (h) => h.value);
      const off = rel(mineValue, g.value);
      if (off > valueTolerance) {
        problems.push(
          `Group "${label}" sums to ${mineValue.toFixed(2)} against a printed subtotal of ` +
          `${g.value.toFixed(2)} (${(off * 100).toFixed(2)}% off)`);
      }
    }
    if (g.weight != null) {
      const mineWeight = sum(mine, (h) => h.weight);
      if (Math.abs(mineWeight - g.weight) > 0.02 + 0.005 * mine.length) {
        problems.push(
          `Group "${label}" weights sum to ${mineWeight.toFixed(2)}% against a printed ` +
          `${g.weight.toFixed(2)}%`);
      }
    }
  }
  if (at !== report.holdings.length) {
    problems.push(`${report.holdings.length - at} holdings fall outside any group subtotal`);
  }

  // Every portfolio weight together should be the whole portfolio. Once each
  // group has reconciled above, a shortfall here is the report's, not ours.
  const weightTotal = sum(report.holdings, (h) => h.weight);
  if (report.holdings.length && Math.abs(weightTotal - 100) > 0.05 + 0.005 * report.holdings.length) {
    (problems.length ? problems : warnings).push(
      `Portfolio weights sum to ${weightTotal.toFixed(2)}%, not 100%`);
  }

  return { ok: problems.length === 0, problems, warnings, weightTotal };
}
