// A small PDF text extractor — enough to read KAP's portfolio reports, and no
// more.
//
// Bringing in a PDF library would be the obvious move, but this project has no
// dependencies by design and the reports use a narrow, well-behaved slice of the
// format: Flate-compressed content streams, Identity-H Type0 fonts, and a
// ToUnicode CMap per font. That is a few hundred lines to handle properly, and
// handling it here keeps the deployed files the source files.
//
// What it does NOT do: encryption, object streams, CCITT/JBIG2 images, Type3
// fonts, or anything to do with rendering. It returns positioned text runs and
// leaves table reconstruction to the caller.

import zlib from 'node:zlib';

/**
 * Index every top-level indirect object by number.
 *
 * Objects are located by scanning for `N 0 obj` rather than by walking the xref
 * table: the reports are small, some are linearised, and a scan is immune to the
 * broken xref offsets a few filers produce. Objects hidden inside an /ObjStm
 * would be missed, but these reports keep everything at the top level.
 *
 * @returns {Map<number, {dict: string, stream: Buffer|null}>}
 */
function indexObjects(buf) {
  const latin = buf.toString('latin1');
  const objs = new Map();
  for (const m of latin.matchAll(/(\d+)\s+0\s+obj\b/g)) {
    const num = Number(m[1]);
    const bodyAt = m.index + m[0].length;
    const endAt = latin.indexOf('endobj', bodyAt);
    const streamAt = latin.indexOf('stream', bodyAt);
    const hasStream = streamAt >= 0 && (endAt < 0 || streamAt < endAt);

    const dict = latin.slice(bodyAt, hasStream ? streamAt : endAt < 0 ? bodyAt : endAt);
    let stream = null;
    if (hasStream) {
      // Skip the EOL that must follow the `stream` keyword.
      let start = streamAt + 'stream'.length;
      if (latin[start] === '\r') start++;
      if (latin[start] === '\n') start++;
      // /Length is authoritative when it is a literal; when it is a reference
      // (or wrong, which happens) fall back to the endstream marker.
      const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      const marker = latin.indexOf('endstream', start);
      const end = len ? start + Number(len[1]) : marker;
      if (end > start) stream = buf.subarray(start, Math.min(end, buf.length));
    }
    objs.set(num, { dict, stream });
  }
  return objs;
}

/**
 * An object's stream data, decoded according to its /Filter.
 *
 * A stream with no filter is stored as-is, and that is not a curiosity: several
 * filers emit their ToUnicode CMaps uncompressed. Assuming Flate throws those
 * away, which leaves the fonts unmapped and the whole report unreadable.
 *
 * @returns {Buffer|null} null for filters we do not implement (images, mostly)
 */
function decodeStream(obj) {
  if (!obj?.stream) return null;
  const filter = /\/Filter\s*(?:\/(\w+)|\[\s*\/(\w+))/.exec(obj.dict);
  if (!filter) return obj.stream;
  const name = filter[1] ?? filter[2];
  if (name !== 'FlateDecode') return null;
  try {
    return zlib.inflateSync(obj.stream);
  } catch {
    // A truncated /Length is common enough to be worth retrying loosely: zlib
    // can still return what it decoded before running out.
    try {
      return zlib.inflateSync(obj.stream, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch {
      return null;
    }
  }
}

/** Parse the hex operands of a bfchar/bfrange entry into code points. */
const hexToInt = (h) => parseInt(h, 16);

/** UTF-16BE hex string -> JS string. Surrogate pairs come through intact. */
function hexToString(h) {
  let s = '';
  for (let i = 0; i + 3 < h.length + 1; i += 4) {
    const unit = parseInt(h.slice(i, i + 4), 16);
    if (Number.isFinite(unit)) s += String.fromCharCode(unit);
  }
  return s;
}

/**
 * Build a code -> character map from one ToUnicode CMap stream.
 *
 * Subset fonts renumber their glyphs, so without this a report reads as
 * gibberish shifted by whatever offset that particular subset happened to use.
 * Turkish characters in particular only resolve through the CMap.
 */
function parseCMap(text) {
  const map = new Map();
  // How many bytes make one code. `<0000><FFFF>` means two, and these reports
  // put those two-byte codes inside ordinary `(...)` literals — so without
  // reading this, every second byte is a stray NUL and words come out as
  // "P o r t f ö y".
  const range = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  const first = range && /<([0-9A-Fa-f]+)>/.exec(range[1]);
  map.bytes = first ? Math.max(1, Math.ceil(first[1].length / 2)) : 1;

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const e of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(hexToInt(e[1]), hexToString(e[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    // <lo> <hi> <dstStart>
    for (const e of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = hexToInt(e[1]);
      const hi = hexToInt(e[2]);
      const dst = hexToInt(e[3]);
      // A runaway range would balloon memory; real ones are small.
      if (hi - lo > 0xffff) continue;
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(dst + (c - lo)));
    }
    // <lo> <hi> [<d1> <d2> ...]
    for (const e of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = hexToInt(e[1]);
      let i = 0;
      for (const d of e[3].matchAll(/<([0-9A-Fa-f]+)>/g)) map.set(lo + i++, hexToString(d[1]));
    }
  }
  return map;
}

/**
 * Every ToUnicode CMap in the file, in object order.
 *
 * Kept for inspection and tests; extraction resolves each font's own map by
 * reference rather than by position, since a report carries one per font.
 *
 * @returns {Map<number, string>[]}
 */
export function parseCMaps(buf) {
  const maps = [];
  for (const obj of indexObjects(buf).values()) {
    const raw = decodeStream(obj);
    if (!raw) continue;
    const text = raw.toString('latin1');
    if (!/begincmap|beginbfchar|beginbfrange/.test(text)) continue;
    const map = parseCMap(text);
    if (map.size) maps.push(map);
  }
  return maps;
}

/**
 * Page object numbers in reading order, by walking the /Pages tree.
 *
 * Object number order is not page order. It happens to match in a short report
 * and does not in a long one — an ETF files a month of daily reports as one
 * 114-page PDF, and taking objects as they come interleaves them, which puts
 * the last report's table under the first report's heading.
 */
function pageOrder(objs) {
  const root = [...objs].find(([, o]) => /\/Type\s*\/Pages\b/.test(o.dict) && !/\/Parent\b/.test(o.dict));
  const order = [];
  const seen = new Set();
  const walk = (num, depth) => {
    if (depth > 64 || seen.has(num)) return;
    seen.add(num);
    const obj = objs.get(num);
    if (!obj) return;
    if (/\/Type\s*\/Page(?![s])/.test(obj.dict)) { order.push(num); return; }
    const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(obj.dict);
    if (!kids) return;
    for (const k of kids[1].matchAll(/(\d+)\s+0\s+R/g)) walk(Number(k[1]), depth + 1);
  };
  if (root) walk(root[0], 0);
  // A file with no usable tree still has to produce something.
  for (const [num, obj] of objs) {
    if (!seen.has(num) && /\/Type\s*\/Page(?![s])/.test(obj.dict)) order.push(num);
  }
  return order;
}

/**
 * The body of a dictionary entry, whether written inline or held elsewhere.
 *
 * A page may carry `/Resources <</Font<<…>>>>` or `/Resources 6 0 R`, and both
 * are common. Following the reference is not optional: a page whose resources
 * live in their own object otherwise appears to have no fonts, and every glyph
 * then decodes to its raw code.
 *
 * @returns {string|null} the text between the dictionary's own `<<` and `>>`
 */
function subDict(objs, dict, key) {
  if (!dict) return null;
  const ref = new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`).exec(dict);
  if (ref) return objs.get(Number(ref[1]))?.dict ?? null;

  const at = new RegExp(`/${key}\\s*<<`).exec(dict);
  if (!at) return null;
  // Balance the brackets: a resource dictionary nests, so stopping at the first
  // `>>` would cut it off mid-way.
  let depth = 0;
  const from = at.index + at[0].length - 2;
  for (let i = from; i < dict.length - 1; i++) {
    if (dict[i] === '<' && dict[i + 1] === '<') { depth++; i++; }
    else if (dict[i] === '>' && dict[i + 1] === '>') {
      if (--depth === 0) return dict.slice(from + 2, i);
      i++;
    }
  }
  return null;
}

/**
 * The pages of a document, each with its own content and font map.
 *
 * Pages must stay apart. Pooling every content stream into one coordinate space
 * merges rows that merely share a y on different sheets — in these reports that
 * splices the fund-identity table into the middle of the holdings rows.
 *
 * @returns {{content: string, fonts: Map<string, Map|null>}[]}
 */
function parsePages(buf) {
  const objs = indexObjects(buf);
  const cmapCache = new Map();
  const cmapFor = (num) => {
    if (!cmapCache.has(num)) {
      const raw = decodeStream(objs.get(num));
      cmapCache.set(num, raw ? parseCMap(raw.toString('latin1')) : null);
    }
    return cmapCache.get(num);
  };

  const pages = [];
  for (const num of pageOrder(objs)) {
    const obj = objs.get(num);
    if (!obj || !/\/Type\s*\/Page(?![s])/.test(obj.dict)) continue;

    // /Contents is one reference or an array of them.
    const refs = [];
    const single = /\/Contents\s+(\d+)\s+0\s+R/.exec(obj.dict);
    if (single) refs.push(Number(single[1]));
    const array = /\/Contents\s*\[([^\]]*)\]/.exec(obj.dict);
    if (array) for (const r of array[1].matchAll(/(\d+)\s+0\s+R/g)) refs.push(Number(r[1]));

    let content = '';
    for (const ref of refs) {
      const raw = decodeStream(objs.get(ref));
      if (raw) content += raw.toString('latin1') + '\n';
    }
    if (!content) continue;

    // Resolve /F1 -> font object -> its ToUnicode map. Doing this by name rather
    // than by position matters: a report's fonts are not in resource order, and
    // a simple WinAnsi font has no map at all.
    const fonts = new Map();
    const dict = subDict(objs, subDict(objs, obj.dict, 'Resources') ?? obj.dict, 'Font');
    if (dict) {
      for (const f of dict.matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
        const font = objs.get(Number(f[2]));
        const toUni = font && /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(font.dict);
        fonts.set(f[1], toUni ? cmapFor(Number(toUni[1])) : null);
      }
    }
    pages.push({ content, fonts });
  }
  return pages;
}

/**
 * Decode one hex text operand.
 *
 * Identity-H strings are hex, two bytes per glyph, and only make sense through a
 * CMap.
 */
function decodeHex(hex, cmap) {
  const width = (cmap?.bytes ?? 1) * 2; // hex chars per code
  let s = '';
  for (let i = 0; i + width - 1 < hex.length; i += width) {
    const code = parseInt(hex.slice(i, i + width), 16);
    if (!Number.isFinite(code)) continue;
    s += cmap ? (cmap.get(code) ?? '') : String.fromCharCode(code);
  }
  return s;
}

function decodeLiteral(lit, cmap) {
  const bytes = [];
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i];
    if (ch !== '\\') { bytes.push(lit.charCodeAt(i)); continue; }
    const next = lit[++i];
    if (next === undefined) break;
    const esc = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 }[next];
    if (esc !== undefined) { bytes.push(esc); continue; }
    if (next >= '0' && next <= '7') {
      let oct = next;
      while (oct.length < 3 && lit[i + 1] >= '0' && lit[i + 1] <= '7') oct += lit[++i];
      bytes.push(parseInt(oct, 8));
      continue;
    }
    bytes.push(lit.charCodeAt(i));
  }
  if (!cmap) return bytes.map((b) => String.fromCharCode(b)).join('');

  // Multi-byte fonts pack their codes big-endian inside the literal.
  const width = cmap.bytes ?? 1;
  if (width === 1) return bytes.map((b) => cmap.get(b) ?? String.fromCharCode(b)).join('');

  let s = '';
  for (let i = 0; i + width - 1 < bytes.length; i += width) {
    let code = 0;
    for (let k = 0; k < width; k++) code = (code << 8) | bytes[i + k];
    s += cmap.get(code) ?? '';
  }
  return s;
}

/** Multiply two PDF matrices, [a b c d e f] each. */
function mul(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * Kerning wide enough to mean "new column", in thousandths of an em.
 *
 * A space is roughly 280 and letter spacing far less, so one em is comfortably
 * past anything used inside a word. Set it lower and a value like
 * "36.814.306,59" risks being split down the middle, which would leave the
 * number unparseable.
 */
const COLUMN_KERN = 1000;

/** The operators worth interpreting. Everything else is graphics. */
const TOKEN = new RegExp([
  /\/(?<font>[\w+.\-]+)\s+(?<fsize>[\d.]+)\s+Tf/,
  /(?<tdx>[-\d.]+)\s+(?<tdy>[-\d.]+)\s+(?<td>TD|Td)\b/,
  /(?<ma>[-\d.]+)\s+(?<mb>[-\d.]+)\s+(?<mc>[-\d.]+)\s+(?<md>[-\d.]+)\s+(?<me>[-\d.]+)\s+(?<mf>[-\d.]+)\s+(?<mop>cm|Tm)\b/,
  /(?<leading>[-\d.]+)\s+TL\b/,
  /(?<text>T\*|BT|ET)\b/,
  /(?<=^|\s)(?<gfx>q|Q)(?=\s|$)/,
  /\[(?<tj>(?:[^\[\]\\]|\\.)*)\]\s*TJ\b/,
  /(?<tjs><[0-9A-Fa-f\s]*>|\((?:[^()\\]|\\.)*\))\s*(?<tjop>Tj|')/,
].map((r) => r.source).join('|'), 'g');

/**
 * Positioned text runs from a content stream.
 *
 * Text-state and text-positioning operators are interpreted along with the
 * graphics matrix, and everything else is skipped.
 *
 * The matrix is not optional. Several filers draw their whole page through a
 * vertical flip — `cm 0.75 0 0 -0.75 0 841.92` — so ignoring it turns every page
 * upside down. That is not a cosmetic problem: rows come out bottom-to-top, the
 * section headings land under the tables they introduce, and the report parses
 * to nothing. It also carries the scale, without which font sizes are wrong by
 * whatever factor the producer chose, and group headings are told from data rows
 * by their size.
 *
 * @returns {{x:number, y:number, s:string, size:number}[]}
 */
function runsFromContent(content, fonts) {
  const runs = [];
  let cmap = null;
  let ctm = IDENTITY;
  const stack = [];
  let tm = IDENTITY;   // text matrix
  let tlm = IDENTITY;  // text line matrix — where the current line began
  let leading = 0;
  let size = 10;

  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(content)) !== null) {
    const g = m.groups;

    if (g.gfx) {
      if (g.gfx === 'q') stack.push(ctm);
      else ctm = stack.pop() ?? IDENTITY;
      continue;
    }
    if (g.mop) {
      const matrix = [g.ma, g.mb, g.mc, g.md, g.me, g.mf].map(Number);
      if (g.mop === 'cm') ctm = mul(matrix, ctm);
      else tlm = tm = matrix;
      continue;
    }
    if (g.font) {
      cmap = fonts.get(g.font) ?? null;
      size = Number(g.fsize) || size;
      continue;
    }
    if (g.text === 'BT') { tm = tlm = IDENTITY; continue; }
    if (g.text === 'ET') continue;
    if (g.leading != null) { leading = Number(g.leading); continue; }
    if (g.text === 'T*') { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; continue; }
    if (g.td) {
      if (g.td === 'TD') leading = -Number(g.tdy);
      tlm = mul([1, 0, 0, 1, Number(g.tdx), Number(g.tdy)], tlm);
      tm = tlm;
      continue;
    }

    // Where the run lands on the page, and how big it actually is.
    const at = mul(tm, ctm);
    const across = Math.hypot(at[0], at[1]) || 1;
    const down = Math.hypot(at[2], at[3]) || 1;

    const pieces = [];
    if (g.tj != null) {
      // A TJ array is strings interleaved with kerning offsets. Most producers
      // use it for letter spacing, but some lay a whole table row out inside a
      // single array — so a jump wide enough to be a column break starts a new
      // run rather than being swallowed into the previous one.
      let dx = 0;
      let buf = '';
      let bufAt = 0;
      for (const part of g.tj.matchAll(/<([0-9A-Fa-f\s]*)>|\(((?:[^()\\]|\\.)*)\)|(-?[\d.]+)/g)) {
        if (part[3] != null) {
          const kern = Number(part[3]);
          if (kern < -COLUMN_KERN && buf) { pieces.push([bufAt, buf]); buf = ''; }
          dx -= (kern / 1000) * size;
          continue;
        }
        const text = part[1] != null
          ? decodeHex(part[1].replace(/\s+/g, ''), cmap)
          : decodeLiteral(part[2], cmap);
        if (!text) continue;
        if (!buf) bufAt = dx;
        buf += text;
        dx += text.length * ADVANCE * size;
      }
      if (buf) pieces.push([bufAt, buf]);
    } else if (g.tjs != null) {
      const text = g.tjs.startsWith('<')
        ? decodeHex(g.tjs.slice(1, -1).replace(/\s+/g, ''), cmap)
        : decodeLiteral(g.tjs.slice(1, -1), cmap);
      if (text) pieces.push([0, text]);
    }

    for (const [dx, s] of pieces) {
      runs.push({ x: at[4] + dx * across, y: at[5], s, size: size * down });
    }
  }
  return runs;
}

/**
 * Group positioned runs into visual rows.
 *
 * PDF has no notion of a table row — the reports only look tabular because cells
 * share a baseline. Runs within `tolerance` units of the same y are one row, and
 * sorting by x puts the columns back in reading order.
 */
export function rowsFromRuns(runs, tolerance = 2.5) {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  let current = null;
  for (const run of sorted) {
    if (!current || Math.abs(current.y - run.y) > tolerance) {
      current = { y: run.y, cells: [] };
      rows.push(current);
    }
    current.cells.push(run);
  }
  return rows.map((r) => ({
    y: r.y,
    cells: r.cells.sort((a, b) => a.x - b.x).map((c) => ({ x: c.x, text: c.s, size: c.size })),
  }));
}

/**
 * Extract a PDF's text as positioned rows, page by page.
 *
 * Each row carries the page it came from. Rows are never grouped across pages —
 * two sheets share a coordinate space, so pooling them interleaves unrelated
 * tables.
 *
 * @param {Buffer} buf the PDF file
 * @returns {{page:number, y:number, cells:{x:number,text:string,size:number}[]}[]}
 */
export function extractRows(buf) {
  const out = [];
  parsePages(buf).forEach((page, index) => {
    for (const row of rowsFromRuns(runsFromContent(page.content, page.fonts))) {
      out.push({ page: index, ...row });
    }
  });
  return out;
}

/**
 * Mean glyph advance as a fraction of font size. Arial-ish, and only used to
 * decide where one run ends — not for layout.
 */
const ADVANCE = 0.5;

/**
 * Join a row's runs back into readable text.
 *
 * There is no space character to go by: PDF positions text, it does not space
 * it. The only evidence of a gap is geometry, and the generators differ — some
 * emit a whole cell per run, some emit one glyph per run. So each run's rendered
 * width is estimated from its length and font size, and a space goes in wherever
 * the next run starts beyond where this one was going to end.
 *
 * That handles both shapes with one rule: consecutive glyphs of a word sit flush
 * against the estimate, while separate columns leave a visible gap.
 */
export function joinRow(cells) {
  if (!cells.length) return '';
  let out = cells[0].text;
  for (let i = 1; i < cells.length; i++) {
    const prev = cells[i - 1];
    const size = prev.size ?? 10;
    const expectedEnd = prev.x + prev.text.length * ADVANCE * size;
    out += cells[i].x - expectedEnd > size * 0.28 ? ' ' : '';
    out += cells[i].text;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Convenience: the whole document as lines of text, in page order. */
export function extractText(buf) {
  return extractRows(buf).map((r) => joinRow(r.cells)).filter(Boolean);
}

/**
 * KAP's file endpoint returns a Java-serialised `byte[]`, not a raw file — the
 * payload starts with the 0xACED stream magic and the PDF begins a few bytes in.
 */
export function unwrapPdf(buf) {
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return buf;
  const at = buf.indexOf('%PDF');
  return at > 0 ? buf.subarray(at) : null;
}
