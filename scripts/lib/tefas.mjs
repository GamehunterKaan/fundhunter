// Minimal client for the TEFAS JSON API (www.tefas.gov.tr/api/funds/*).
//
// The API is public and unauthenticated but undocumented. Every method is a POST
// that takes the same wide body shape; unused filters must still be present.
// Responses look like { errorCode, errorMessage, resultList, toplamSayi, toplamSayfa }.

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const API = 'https://www.tefas.gov.tr/api/funds';

const HEADERS = {
  Accept: '*/*',
  'Content-Type': 'application/json',
  'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
  Origin: 'https://www.tefas.gov.tr',
  Referer: 'https://www.tefas.gov.tr/tr/fon-verileri',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
};

/** TEFAS rejects requests that omit any of these keys, even when unused. */
export function requestBody(overrides = {}) {
  return {
    fonTipi: 'YAT',
    fonKodu: null,
    aramaMetni: null,
    fonTurKod: null,
    fonGrubu: null,
    sfonTurKod: null,
    fonTurAciklama: null,
    kurucuKod: null,
    basTarih: null,
    bitTarih: null,
    basSira: 1,
    bitSira: 100000,
    dil: 'TR',
    sFonTurKod: '',
    fonKod: '',
    fonGrup: '',
    fonUnvanTip: '',
    ...overrides,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * TEFAS returns these in `errorMessage` for weekends/holidays where no fund data
 * exists. They are empty results, not failures.
 */
const EMPTY_MARKERS = ['out of bounds', 'veri bulunamadı', 'kayıt bulunamadı'];

function isEmptyMarker(msg) {
  if (!msg) return false;
  const m = String(msg).toLowerCase();
  return EMPTY_MARKERS.some((x) => m.includes(x));
}

export class TefasClient {
  /**
   * @param {object} opts
   * @param {string} [opts.cacheDir] Directory for gzipped response cache. Omit to disable.
   * @param {number} [opts.maxRetry] Attempts per request before giving up.
   * @param {number} [opts.minIntervalMs] Floor on spacing between requests.
   * @param {number} [opts.timeoutMs] Per-request timeout.
   */
  constructor({ cacheDir = null, maxRetry = 8, minIntervalMs = 700, timeoutMs = 180000 } = {}) {
    this.cacheDir = cacheDir;
    this.maxRetry = maxRetry;
    this.minIntervalMs = minIntervalMs;
    this._baseIntervalMs = minIntervalMs;
    this._okStreak = 0;
    this.timeoutMs = timeoutMs;
    this._lastAt = 0;
    this._gate = Promise.resolve();
    this.stats = { requests: 0, cacheHits: 0, retries: 0, throttled: 0, bytes: 0 };
  }

  async _cachePath(key) {
    return path.join(this.cacheDir, `${key}.json.gz`);
  }

  async _readCache(key) {
    if (!this.cacheDir) return null;
    try {
      const buf = await fs.readFile(await this._cachePath(key));
      return JSON.parse((await gunzip(buf)).toString('utf8'));
    } catch {
      return null;
    }
  }

  async _writeCache(key, value) {
    if (!this.cacheDir) return;
    await fs.mkdir(this.cacheDir, { recursive: true });
    const buf = await gzip(Buffer.from(JSON.stringify(value), 'utf8'));
    await fs.writeFile(await this._cachePath(key), buf);
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

  /**
   * POST a `/api/funds/*` method and return its `resultList` (always an array).
   * @param {string} method API method name, e.g. 'fonGnlBlgSiraliGetir'
   * @param {object} body Request body (pass through `requestBody`)
   * @param {object} [opts]
   * @param {string} [opts.cacheKey] Enables caching for this call
   * @param {(rows:any[])=>any[]} [opts.reduce] Shrink rows before caching
   */
  post(method, body, opts) {
    return this.postUrl(`${API}/${method}`, body, opts);
  }

  /**
   * POST any TEFAS endpoint. Needed because the fund-returns export lives at
   * `/api/fund-returns/export` and answers with a bare array rather than the
   * `{resultList}` envelope the `/api/funds/*` methods use.
   */
  async postUrl(url, body, { cacheKey = null, reduce = null } = {}) {
    if (cacheKey) {
      const hit = await this._readCache(cacheKey);
      if (hit) {
        this.stats.cacheHits++;
        return hit;
      }
    }

    let lastErr = null;
    let penalty = 0;
    for (let attempt = 0; attempt < this.maxRetry; attempt++) {
      if (attempt > 0) {
        this.stats.retries++;
        const backoff = penalty || Math.min(30000, 1500 * 2 ** (attempt - 1));
        await sleep(backoff + Math.random() * 500);
        penalty = 0;
      }
      await this._throttle();

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        this.stats.requests++;
        const res = await fetch(url, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });

        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}`);
          if (res.status === 429) {
            // TEFAS throttles aggressively. Widen the global request spacing so
            // every in-flight worker slows down, not just this one.
            const retryAfter = Number(res.headers.get('retry-after'));
            penalty = Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : Math.min(60000, 8000 * (attempt + 1));
            this.minIntervalMs = Math.min(4000, Math.round(this.minIntervalMs * 1.6) + 100);
            this.stats.throttled++;
          }
          continue;
        }

        const text = await res.text();
        this.stats.bytes += text.length;

        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);

        let json;
        try {
          json = JSON.parse(text);
        } catch {
          // An HTML body here means the F5 bot-protection layer intercepted us.
          lastErr = new Error(`Non-JSON response (${text.slice(0, 120)})`);
          continue;
        }

        // The export endpoint reports failures as {error}, the funds API as
        // {errorMessage}; treat both as errors.
        if (json.error) throw new Error(`TEFAS error: ${json.error}`);
        const msg = json.errorMessage;
        if (msg && !isEmptyMarker(msg)) throw new Error(`TEFAS error: ${msg}`);

        // Ease the spacing back down after a clean streak, so a single 429 early
        // in a long run does not slow every later request.
        if (this.minIntervalMs > this._baseIntervalMs && ++this._okStreak >= 12) {
          this.minIntervalMs = Math.max(this._baseIntervalMs, Math.round(this.minIntervalMs * 0.75));
          this._okStreak = 0;
        }

        let rows = isEmptyMarker(msg)
          ? []
          : Array.isArray(json) // export endpoint returns a bare array
            ? json
            : json.resultList || [];
        if (reduce) rows = reduce(rows);
        if (cacheKey) await this._writeCache(cacheKey, rows);
        return rows;
      } catch (e) {
        if (e.name === 'AbortError') {
          lastErr = new Error(`timeout after ${this.timeoutMs}ms`);
          continue;
        }
        // Transient network faults are worth retrying; API-level errors are not.
        if (/TEFAS error|HTTP 4/.test(e.message)) throw e;
        lastErr = e;
      } finally {
        clearTimeout(timer);
      }
    }
    // `postUrl` takes a URL, not a method name — naming `method` here threw a
    // ReferenceError instead of this message every time a request ran out of
    // retries, which killed the nightly run and hid the reason it had failed.
    // `post()` builds the URL as `${API}/${method}`, so the last segment is the
    // method name it would have printed.
    const what = url.split('/').pop() || url;
    throw new Error(`${what} failed after ${this.maxRetry} attempts: ${lastErr?.message}`);
  }
}

/** Run `worker` over `items` with bounded concurrency, preserving input order. */
export async function mapPool(items, concurrency, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

// --- date helpers (TEFAS wants YYYYMMDD, and returns YYYY-MM-DD) ---

export const ymd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

export const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

/**
 * Fixed reference date for all chunk grids.
 *
 * Chunk boundaries are computed from this epoch rather than from the requested
 * range, so they do not move when the range does. That is what makes the disk
 * cache useful day to day: when the trading date rolls over, yesterday's chunks
 * keep their cache keys and only the newest chunk is actually fetched. Anchoring
 * to `end` instead re-fetched all ~200 requests every single day.
 */
const GRID_EPOCH = Date.UTC(2020, 0, 6); // a Monday

/**
 * Split [start, end] into inclusive chunks of at most `maxDays` days, aligned to
 * the fixed grid. The first and last chunk may extend beyond the requested range;
 * callers get slightly more data rather than a shifting cache key.
 */
export function splitRange(start, end, maxDays) {
  const span = maxDays * 86400000;
  const firstBlock = Math.floor((start.getTime() - GRID_EPOCH) / span);
  const lastBlock = Math.floor((end.getTime() - GRID_EPOCH) / span);

  const chunks = [];
  for (let block = firstBlock; block <= lastBlock; block++) {
    const blockStart = new Date(GRID_EPOCH + block * span);
    chunks.push([blockStart, addDays(blockStart, maxDays - 1)]);
  }
  return chunks;
}

/**
 * Weekly sampling anchors inside [start, end], aligned to the fixed grid so they
 * are stable across runs, newest first.
 */
export function weeklyAnchors(start, end) {
  const week = 7 * 86400000;
  const firstWeek = Math.ceil((start.getTime() - GRID_EPOCH) / week);
  const lastWeek = Math.floor((end.getTime() - GRID_EPOCH) / week);

  const anchors = [];
  for (let w = lastWeek; w >= firstWeek; w--) anchors.push(new Date(GRID_EPOCH + w * week));
  // The current partial week has no grid anchor yet, so add the latest date
  // itself — otherwise the newest allocation snapshot would be up to a week old.
  if (!anchors.length || anchors[0].getTime() < end.getTime()) anchors.unshift(new Date(end));
  return anchors;
}
