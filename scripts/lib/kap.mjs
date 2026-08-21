// Minimal client for KAP (Kamuyu Aydınlatma Platformu), the public disclosure
// platform every Turkish fund files to.
//
// We want one thing from it: the monthly "Portföy Dağılım Raporu", which lists
// the individual securities a fund holds. TEFAS publishes only asset-class
// percentages, so this is the only public route to "which stocks does this fund
// actually own".
//
// KAP's *pages* sit behind bot protection — a headless browser renders about
// 1.4KB of chrome and nothing else. Its JSON tier is open, which is the same
// split TEFAS has, and that is what this client uses.

import fs from 'node:fs/promises';
import path from 'node:path';

const KAP = 'https://www.kap.org.tr';

/** The disclosure subject we want. Filed monthly, for the prior month. */
export const PORTFOLIO_SUBJECT = 'Portföy Dağılım Raporu';

const HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
  Referer: `${KAP}/tr/bildirim-sorgu`,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `dd.MM.yyyy HH:mm:ss` (KAP's own format) -> `yyyy-MM-dd`. */
export function publishDay(publishDate) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(String(publishDate ?? ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** KAP's day-first timestamp reordered so plain string comparison sorts it. */
function sortableDate(publishDate) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})(.*)$/.exec(String(publishDate ?? ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}${m[4]}` : String(publishDate ?? '');
}

/**
 * Pull the attachment list out of a disclosure page.
 *
 * The page is a Next.js shell, but its flight payload carries the attachments
 * inline. The payload is sometimes embedded with escaped quotes and sometimes
 * not, depending on which streaming chunk it lands in, so the quotes are matched
 * optionally rather than parsing the whole thing as JSON.
 *
 * @returns {{objId: string, fileName: string}[]}
 */
export function parseAttachments(html) {
  const re = /\\?"objId\\?"\s*:\s*\\?"([0-9a-fA-F]{16,})\\?"\s*,\s*\\?"fileName\\?"\s*:\s*\\?"([^"\\]+)/g;
  const seen = new Set();
  const out = [];
  for (const m of String(html).matchAll(re)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ objId: m[1], fileName: m[2] });
  }
  return out;
}

/**
 * KAP's file endpoint answers with a Java-serialised `byte[]`, not a raw file:
 * the 0xACED stream magic comes first and the PDF starts a few bytes in.
 */
export function unwrap(buf) {
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return buf;
  const at = buf.indexOf('%PDF');
  return at > 0 ? buf.subarray(at) : null;
}

export class KapClient {
  /**
   * @param {object} opts
   * @param {string} [opts.cacheDir] Directory for cached PDFs and queries. Omit to disable.
   * @param {number} [opts.minIntervalMs] Floor on spacing between requests.
   * @param {number} [opts.maxRetry] Attempts per request before giving up.
   * @param {number} [opts.timeoutMs] Per-request timeout.
   */
  constructor({ cacheDir = null, minIntervalMs = 450, maxRetry = 7, timeoutMs = 60000 } = {}) {
    this.cacheDir = cacheDir;
    this.minIntervalMs = minIntervalMs;
    this.maxRetry = maxRetry;
    this.timeoutMs = timeoutMs;
    this._baseIntervalMs = minIntervalMs;
    this._okStreak = 0;
    this._failStreak = 0;
    this._lastAt = 0;
    this._gate = Promise.resolve();
    this.maxCoolOffMs = 600000;
    /** Called with (waitMs, streak) when a run pauses to wait out a block. */
    this.onCoolOff = null;
    this.stats = { requests: 0, cacheHits: 0, retries: 0, throttled: 0, coolOffMs: 0, bytes: 0 };
  }

  /** Serialize the request-rate floor across concurrent callers. */
  async _throttle() {
    const prev = this._gate;
    let release;
    this._gate = new Promise((r) => (release = r));
    await prev;
    const wait = this.minIntervalMs - (Date.now() - this._lastAt);
    if (wait > 0) await sleep(wait);
    this._lastAt = Date.now();
    release();
  }

  async _cached(key, produce) {
    const file = this.cacheDir ? path.join(this.cacheDir, key) : null;
    if (file) {
      try {
        const hit = await fs.readFile(file);
        this.stats.cacheHits++;
        return hit;
      } catch {
        // Not cached yet.
      }
    }
    const buf = await produce();
    if (file && buf) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, buf);
    }
    return buf;
  }

  /**
   * Widen the global request spacing after a rebuff, narrow it after a run of
   * clean responses.
   *
   * KAP tolerates a few hundred downloads and then starts refusing connections
   * outright rather than answering 429, so a fixed delay either crawls through
   * the easy stretch or collapses in the hard one. Backing off globally slows
   * every later request, not just the one that failed, which is what actually
   * lets a long run finish.
   */
  _penalise() {
    this.stats.throttled++;
    this._okStreak = 0;
    this.minIntervalMs = Math.min(8000, Math.round(this.minIntervalMs * 1.7) + 150);
  }

  _reward() {
    this._failStreak = 0;
    if (++this._okStreak < 25) return;
    this._okStreak = 0;
    this.minIntervalMs = Math.max(this._baseIntervalMs, Math.round(this.minIntervalMs * 0.8));
  }

  /**
   * Wait out a block rather than spending the rest of the run on it.
   *
   * After a few hundred downloads KAP stops answering for a while. Retrying into
   * that costs about two minutes per fund and fails every one of them, so a long
   * run would grind through its whole remaining list and report almost nothing.
   * Pausing once, for minutes rather than seconds, lets the block lift and the
   * run carry on at full speed.
   */
  async _coolOff() {
    if (++this._failStreak < 3) return;
    const wait = Math.min(this.maxCoolOffMs, 60000 * 2 ** (this._failStreak - 3));
    this.stats.coolOffMs += wait;
    if (this.onCoolOff) this.onCoolOff(wait, this._failStreak);
    await sleep(wait);
  }

  async _fetch(url, init = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt < this.maxRetry; attempt++) {
      if (attempt > 0) {
        this.stats.retries++;
        await sleep(Math.min(30000, 1500 * 2 ** (attempt - 1)) + Math.random() * 500);
      }
      await this._throttle();

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        this.stats.requests++;
        const res = await fetch(url, { ...init, headers: { ...HEADERS, ...init.headers }, signal: ctrl.signal });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}`);
          this._penalise();
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        const buf = Buffer.from(await res.arrayBuffer());
        this.stats.bytes += buf.length;
        this._reward();
        return buf;
      } catch (err) {
        lastErr = err.name === 'AbortError' ? new Error(`Timeout after ${this.timeoutMs}ms`) : err;
        // A dropped connection is this server's way of saying "too fast".
        this._penalise();
      } finally {
        clearTimeout(timer);
      }
    }
    await this._coolOff();
    throw lastErr ?? new Error(`Failed: ${url}`);
  }

  /**
   * Every fund disclosure published in a date range (inclusive, `yyyy-MM-dd`).
   *
   * Two traps here, both found the hard way:
   *
   * - The response is **capped at 2000 rows** and the `page` field does nothing —
   *   asking for page 2 returns the identical set. The only way to see past the
   *   cap is to narrow the date range, so callers must walk day by day.
   * - Sending the filter fields the site's own UI sends (`disclosureClass`,
   *   `subjectList`, …) makes the endpoint answer **HTTP 500**. It wants either
   *   a bare date range or a fully-populated body; the bare range is the one
   *   that works, so subject filtering happens client-side.
   */
  async disclosures(fromDate, toDate = fromDate) {
    const buf = await this._cached(`query/${fromDate}_${toDate}.json`, () =>
      this._fetch(`${KAP}/tr/api/disclosure/funds/byCriteria`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromDate, toDate }),
      }));
    const rows = JSON.parse(buf.toString('utf8'));
    return Array.isArray(rows) ? rows : [];
  }

  /** The portfolio reports among a day's disclosures, newest first. */
  async portfolioReports(fromDate, toDate = fromDate) {
    const rows = await this.disclosures(fromDate, toDate);
    return rows
      .filter((r) => r?.subject === PORTFOLIO_SUBJECT && r.fundCode)
      .sort((a, b) => String(b.publishDate).localeCompare(String(a.publishDate)));
  }

  /**
   * The most recent portfolio report for each fund across a set of days.
   *
   * Filing is spread over the week or so before the deadline, so finding a
   * month's reports means walking several days and keeping the newest per fund.
   * A disclosure with `attachmentCount: 0` carries no PDF at all — a handful are
   * filed that way — so an older filing that does have one is preferred over a
   * newer one that does not, and the listing says which is which without costing
   * a request.
   *
   * @param {string[]} days `yyyy-MM-dd`, any order
   */
  async latestReports(days) {
    const best = new Map();
    for (const day of days) {
      for (const r of await this.portfolioReports(day)) {
        const held = best.get(r.fundCode);
        if (!held) { best.set(r.fundCode, r); continue; }
        const better = (r.attachmentCount > 0) !== (held.attachmentCount > 0)
          ? r.attachmentCount > 0
          : sortableDate(r.publishDate) > sortableDate(held.publishDate);
        if (better) best.set(r.fundCode, r);
      }
    }
    return best;
  }

  /** The attachments filed with one disclosure. */
  async attachments(disclosureIndex) {
    const buf = await this._cached(`disclosure/${disclosureIndex}.html`, () =>
      this._fetch(`${KAP}/tr/Bildirim/${disclosureIndex}`, { headers: { Accept: 'text/html' } }));
    return parseAttachments(buf.toString('utf8'));
  }

  /** Download one attachment, unwrapped into a plain PDF buffer. */
  async file(objId) {
    const buf = await this._cached(`file/${objId}.pdf`, async () => {
      const raw = await this._fetch(`${KAP}/tr/api/file/download/${objId}`);
      const pdf = unwrap(raw);
      if (!pdf) throw new Error(`Not a PDF: ${objId}`);
      return pdf;
    });
    return buf;
  }

  /** The PDF of a disclosure's first PDF attachment. */
  async reportPdf(disclosureIndex) {
    const files = await this.attachments(disclosureIndex);
    const pdf = files.find((f) => /\.pdf$/i.test(f.fileName)) ?? files[0];
    if (!pdf) return null;
    return this.file(pdf.objId);
  }
}
