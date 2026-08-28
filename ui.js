// Browser layer: data loading, hash routing, rendering and charts.
// All logic worth testing lives in core.js; this file owns the DOM.

import {
  t, label, fold, fmtMoney, fmtNum, fmtInt, fmtPct, fmtPoints, fmtDate, signOf,
  parseJsonl, filterFunds, sortFunds, compositionSegments, industryComposition,
  assetBreakdown, alignAndIndex, returnOver, HORIZONS, horizonOf, LEVERED_FROM,
  CRASH_PROOF_FROM, THEME_IDS, MIN_THEME,
  aggregateHoldings, groupHoldings, HOLDING_GROUPS, queryMatcher, squarify,
  ringGeometry, ringPoint, ringPath, spreadLabels, svgN, TURN,
  SPEC_NONE, SPEC_STEPS, SPEC_MIN_EQUITY, bestIndexes, deflateSeries,
  defaultScreen, encodeScreen, decodeScreen, SCREEN_FILTER_PREFS,
} from './core.js';
import {
  taxRatesFor, taxRateFor, scoreFund, qualityFlags, predictReturn,
  pendingFactorReturns, requiresQualifiedInvestor, cashReturnFor, FACTORS,
  crashSpared, rangePosition,
  trailingTwelve, yearOnYear, ratioSeries, netDebtToEbitda, altmanBand, piotroskiBand,
  consensus, shareOfTotal, beatRecord, surpriseOf, peersOf, peerMedians,
  weightsOf, overlappingPairs, sharedPositions, sharedAcross, OVERLAP_FLOOR,
  themeMoves, moversIn, versusCash,
  boardFlags, SPECULATIVE_HEAVY,
  priceOn, priceEntryOn, returnSince, positionOf, portfolioTotals,
  cashOver, cashAlternative, portfolioMix, portfolioSlices, portfolioDayMove,
  lookThrough, LOOK_THROUGH_ROWS, portfolioXirr, feeDrag, taxIfSold, lotAges,
  consistency, sinceVisit, newSince, VISIT_MIN_DAYS,
  correlationMatrix, CORRELATION_HIGH,
} from './analytics.js';
import { LIVE_SOURCE, LIVE_REFRESH_MS, LIVE_TIMEOUT_MS, parseLiveQuotes, liveClock } from './live.js';
import {
  QUOTE_SOURCE, QUOTE_REFRESH_MS, QUOTE_TIMEOUT_MS, MIN_COVERAGE,
  MARKETS, scanRequest, parseQuotes, quoteFor, estimateMove, sessionOpen, foreignTickers,
  listingOf, intradaySeries, sessionOpenAt,
} from './quotes.js';

const DATA = 'data';
const PAGE_SIZE = 120;

/** Below this R² the factor model explains too little to show an estimate. */
const MIN_PREDICTION_R2 = 0.5;

/** How many funds each ranking on the popular page shows. */
const RANK_SIZE = 25;

/**
 * Lowest risk value a fund can have and still count as "popular".
 *
 * Without a floor these rankings are money-market funds all the way down —
 * they hold the bulk of the industry's money, so they take in the bulk of the
 * flows, every week, and the list says nothing. Risk 4 is where funds start
 * taking real market exposure, which is what someone browsing "popular" is
 * looking for. Unrated funds are excluded, as everywhere else a risk floor applies.
 */
const POPULAR_MIN_RISK = 4;

/**
 * The funds these rankings may draw from: rated at or above the risk floor, and
 * actually buyable. A fund you cannot open a position in has no business heading
 * a list of what people are buying, and `tefas !== true` covers both "not traded"
 * and "status unknown" — an unknown is not a yes.
 */
const popularPool = () =>
  state.funds.filter((f) => f.risk != null && f.risk >= POPULAR_MIN_RISK && f.tefas === true);

const state = {
  lang: 'tr',
  meta: null,
  funds: [],
  benchmarks: [],
  /** 'list' | 'favs' — both use the same filter bar and table. */
  page: 'list',
  /** Latest live quotes, or null when the feed has not answered this session. */
  live: null,
  /** Exchange quotes for the securities funds hold. Shared by every fund page. */
  quotes: null,
  favs: new Set(),
  /** Per favourite: when it was starred, and how much of it is held. */
  positions: {},
  // The three of these together are the screen, and `defaultScreen()` is their
  // one definition — they used to be written out here and again in the reset,
  // and the two copies had already drifted apart.
  ...defaultScreen(),
  /** Whether the filter panel is disclosed. Survives re-renders of the list. */
  filtersOpen: false,
  visible: PAGE_SIZE,
  results: [],
};

/** Scoring context derived from the current preferences. */
function scoringContext() {
  return {
    cashReturn: state.meta?.cashReturn ?? 0,
    cashReturns: state.meta?.cashReturns,
    taxRates: taxRatesFor(state.prefs.tax),
    horizon: state.prefs.horizon,
  };
}

/**
 * The two return columns the table shows.
 *
 * The primary column follows the horizon preference — the whole point of that
 * control is that it changes what you are looking at. The secondary column is
 * there for context, so it must never repeat the primary one.
 */
function returnColumns() {
  const primary = horizonOf(state.prefs.horizon);
  const secondary = horizonOf(primary.key === 'm1' ? 'y1' : 'm1');
  return { primary, secondary };
}

const view = document.getElementById('view');

// ---------------------------------------------------------------- dom helpers

/** Build an element. Children may be nodes, strings, or nested arrays. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/**
 * A label with the explanation of what it means, and the mark that advertises
 * one exists.
 *
 * Both go on the SAME element: the tooltip has to belong to the thing carrying
 * the `?`, or it pops up over whatever else happens to be in the row — over the
 * dropdown the reader is trying to use, in the case of the filter strip. With no
 * note it is a plain label, no mark and no title.
 */
function noted(tag, props, labelText, note) {
  return h(tag, { ...props, title: note || null },
    labelText,
    note ? h('span', { class: 'figure-mark', 'aria-hidden': 'true' }, '?') : null);
}

const svg = (tag, props = {}, ...children) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c);
  return el;
};

// The fallback matters: if data is ever written with a group the stylesheet does
// not define, an undefined custom property resolves to black in SVG fills.
const groupColor = (id) => `var(--g-${id}, var(--ink-muted))`;
const T = (key, vars) => t(state.lang, key, vars);

// ---------------------------------------------------------------- boot

async function boot() {
  restorePreferences();
  restoreSaved();
  restoreLastVisit();
  registerWorker();
  wireChrome();

  try {
    const [meta, funds] = await Promise.all([
      fetch(`${DATA}/meta.json`).then(okJson),
      fetch(`${DATA}/funds.json`).then(okJson),
    ]);
    state.meta = meta;
    state.funds = funds;
    // Benchmarks are optional: the fund pages still work without them.
    state.benchmarks = await fetch(`${DATA}/benchmarks.jsonl`)
      .then((r) => (r.ok ? r.text() : ''))
      .then(parseJsonl)
      .catch(() => []);
  } catch (e) {
    view.replaceChildren(
      h('div', { class: 'state-msg' },
        h('p', {}, T('loadError')),
        h('p', { class: 'colophon-note' }, String(e.message)),
        h('button', { class: 'ghost-btn', onClick: () => location.reload() }, T('retry'))
      )
    );
    return;
  }

  window.addEventListener('hashchange', route);
  route();
  renderTape();
  renderColophon();
  startLive();
  startQuotes();
  measureChrome();
  window.addEventListener('resize', debounce(measureChrome, 150));
}

const okJson = (r) => {
  if (!r.ok) throw new Error(`${r.status} ${r.url.split('/').pop()}`);
  return r.json();
};

// ---------------------------------------------------------------- preferences

function restorePreferences() {
  const lang = localStorage.getItem('fh-lang');
  if (lang === 'tr' || lang === 'en') state.lang = lang;
  const theme = localStorage.getItem('fh-theme') ?? 'auto';
  document.documentElement.dataset.theme = theme;
  try {
    const stored = JSON.parse(localStorage.getItem('fh-watch') ?? '{}');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) watchRanges = stored;
  } catch {
    // A single range key was stored here before every tile had its own; it is
    // not worth migrating one preference.
  }
  syncLangButtons();
}

/**
 * When this browser last opened the site, and stamping today over it.
 *
 * Read once into memory and immediately overwritten, so the dashboard is always
 * answering about the PREVIOUS visit rather than about this one. Two loads on
 * the same day leave nothing to report, which is correct — nothing happened
 * between them.
 *
 * A date, not a timestamp: fund prices are published once a night, so an hour is
 * not a unit anything here can answer in.
 */
const SEEN_KEY = 'fh-seen';

function restoreLastVisit() {
  const seen = localStorage.getItem(SEEN_KEY);
  state.lastSeen = /^\d{4}-\d{2}-\d{2}$/.test(seen ?? '') ? seen : null;
  try {
    localStorage.setItem(SEEN_KEY, todayIso());
  } catch {
    // Blocked storage costs the panel, not the page.
  }
}

/**
 * Register the service worker, and never let it break the page.
 *
 * Everything here is best-effort. It is unavailable over plain http on anything
 * but localhost, browsers can block it outright, and a registration that throws
 * must cost a cache rather than a boot — so this is fire-and-forget with the
 * failure swallowed. The site works identically without it; it is just slower.
 */
function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  // After load: registration competes with the data fetches for connections,
  // and the first visit is the one that can least afford the contention.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

function syncLangButtons() {
  document.documentElement.lang = state.lang;
  for (const b of document.querySelectorAll('#lang-toggle button')) {
    b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang));
  }
}

const NAV = [
  { route: '/', key: 'navDash' },
  { route: '/fonlar', key: 'navFunds' },
  { route: '/hisseler', key: 'navShares' },
  { route: '/favoriler', key: 'navFavorites' },
  { route: '/portfoy', key: 'navPortfolio' },
];

/**
 * The pages that sit under one nav entry.
 *
 * "Which funds is everyone buying" and "which funds held their value in a fall"
 * are two questions about the fund list, not two sections of the site; the
 * market is a question about the shares. They keep their own routes, because
 * links to them are out in the world, and the top nav that used to carry all
 * five now carries two.
 */
const SUB_NAV = {
  '/fonlar': [
    { route: '/fonlar', key: 'navFunds' },
    { route: '/populer', key: 'navPopular' },
    { route: '/dusus', key: 'navCrash' },
  ],
  '/hisseler': [
    { route: '/hisseler', key: 'navShares' },
    { route: '/piyasa', key: 'navMarket' },
  ],
};

/** Which nav entry a route belongs under. A detail page belongs to its own list. */
function parentRoute(hash) {
  if (hash.startsWith('/fon/')) return '/fonlar';
  if (hash.startsWith('/hisse/')) return '/hisseler';
  return Object.keys(SUB_NAV).find((p) => SUB_NAV[p].some((s) => s.route === hash)) ?? hash;
}

/**
 * The strip of sibling pages, drawn at the top of each of them.
 *
 * Nothing for a page with no siblings, and nothing for a detail page: a fund
 * page belongs under Funds for the purpose of highlighting the nav, but it is
 * not one of the three lists you switch between.
 */
function subNav(current) {
  const items = SUB_NAV[parentRoute(current)];
  if (!items?.some((s) => s.route === current)) return null;
  return h('nav', { class: 'sub-nav', 'aria-label': T(parentRoute(current) === '/fonlar' ? 'navFunds' : 'navShares') },
    items.map((s) => h('a', {
      class: `sub-nav-link${s.route === current ? ' is-on' : ''}`,
      // The screen travels with the link, so moving between the fund list and
      // its siblings does not silently drop a filter set.
      href: listHref(s.route),
      'aria-current': s.route === current ? 'page' : null,
    }, T(s.key))));
}

/** Label and highlight the section nav. */
function syncNav() {
  const hash = hashPath();
  const current = parentRoute(hash);
  for (const a of document.querySelectorAll('#main-nav a[data-route]')) {
    const item = NAV.find((n) => n.route === a.dataset.route);
    // Into the span, not the link: the link also holds the icon the bottom tab
    // bar draws, and `textContent =` would delete it.
    if (item) a.querySelector('.nav-label').textContent = T(item.key);
    // The two pages with a filter bar link to themselves carrying the screen, so
    // stepping out to a fund and back through the nav keeps it.
    if (a.dataset.route === '/fonlar' || a.dataset.route === '/favoriler') {
      a.setAttribute('href', listHref(a.dataset.route));
    }
    if (a.dataset.route === current) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

// ---------------------------------------------------------------- favourites
//
// Kept in localStorage rather than a URL: a favourites list is personal state,
// not something you link to. Nothing leaves the browser.

const FAVS_KEY = 'fh-favs';
const POSITIONS_KEY = 'fh-positions';

/**
 * Two lists, kept apart.
 *
 * A favourite is something you want to keep an eye on. A position is something
 * you actually hold. They are not the same question: you can follow a fund for a
 * year without owning any of it, and you can hold something you have no interest
 * in watching.
 *
 *   fh-favs       ["TLY", "ASELS"]
 *   fh-positions  { TLY: [ { at: "2026-08-22", units: 12.5, price: 8000 },
 *                          { at: "2026-09-01", units: -5,   price: 8400 } ] }
 *
 * **A position is a list of lots, not a number.** You buy the same fund twice at
 * two prices, and one `units` field can only answer that by throwing away what
 * each of them cost. Each lot is a day, a size, and what ONE unit changed hands
 * at — the number on the confirmation, and the one that survives editing the
 * size. `units` is negative on a sale, where `price` is what it sold at. What
 * the page shows is derived from the list every time rather than stored beside
 * it, so the two can never disagree.
 */
function restoreSaved() {
  state.favs = new Set();
  state.positions = {};
  const favs = readStored(FAVS_KEY);

  // Both lists used to live in this one key, as an object mapping code to
  // detail. Everything in it is still a favourite; the entries carrying a size
  // are what somebody actually typed in, so those — and only those — become
  // positions. An entry with no size was never a holding.
  if (favs && typeof favs === 'object' && !Array.isArray(favs)) {
    for (const [code, entry] of Object.entries(favs)) {
      if (typeof code !== 'string') continue;
      state.favs.add(code);
      if (entry && typeof entry === 'object' && entry.units > 0) {
        state.positions[code] = [readLot(entry)];
      }
    }
    saveFavorites();
    savePositions();
    return;
  }

  if (Array.isArray(favs)) {
    for (const code of favs) if (typeof code === 'string') state.favs.add(code);
  }
  const held = readStored(POSITIONS_KEY);
  if (!held || typeof held !== 'object' || Array.isArray(held)) return;
  let old = false;
  for (const [code, entry] of Object.entries(held)) {
    if (typeof code !== 'string' || !entry) continue;
    // A position was one lot before it was a list of them, and a lot carried a
    // total before it carried a unit price. Every shape reads.
    const rows = Array.isArray(entry) ? entry : [entry];
    if (!Array.isArray(entry) || rows.some((l) => l?.cost != null)) old = true;
    const lots = rows
      .filter((l) => l && typeof l === 'object' && Number.isFinite(l.units) && l.units !== 0)
      .map(readLot);
    if (lots.length) state.positions[code] = lots;
  }
  // Written back once, so what is on disk is what this version writes rather
  // than a shape that only survives because the reader still understands it.
  if (old) savePositions();
}

/** Whatever is under a key, or null — a corrupt value must not break the boot. */
function readStored(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or blocked storage quota must not break the page; the change simply
    // does not survive a reload.
  }
}

const readLot = (l) => {
  const units = Number.isFinite(l.units) && l.units !== 0 ? l.units : 0;
  // `cost` was the total for the lot before the field became a unit price.
  const price = Number.isFinite(l.price) && l.price > 0 ? l.price
    : (Number.isFinite(l.cost) && l.cost > 0 && units ? l.cost / Math.abs(units) : undefined);
  return { at: typeof l.at === 'string' ? l.at : todayIso(), units, price };
};

/** Today where the exchange is, not where the reader happens to be sitting. */
const todayIso = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: MARKETS.bist.zone }).format(new Date());

function saveFavorites() {
  writeStored(FAVS_KEY, [...state.favs]);
}

function savePositions() {
  const out = {};
  for (const [code, lots] of Object.entries(state.positions)) {
    const kept = (lots ?? []).filter((l) => Number.isFinite(l.units) && l.units !== 0);
    if (!kept.length) continue;
    out[code] = kept.map((l) => {
      const row = { at: l.at ?? todayIso(), units: l.units };
      if (l.price > 0) row.price = l.price;
      return row;
    });
  }
  writeStored(POSITIONS_KEY, out);
}

/** Star on, star off. It no longer touches what you hold — that is its own list. */
function toggleFavorite(code) {
  if (state.favs.has(code)) state.favs.delete(code);
  else state.favs.add(code);
  saveFavorites();
}

/**
 * Add a lot to a position, opening one if there is none.
 *
 * Buying more of something you already hold is a second lot rather than a
 * correction of the first: the page has to be able to say that ten came at ₺100
 * and twenty at ₺90, because that is what makes the average an average.
 */
function addLot(code, lot) {
  (state.positions[code] ??= []).push({
    at: lot.at || todayIso(),
    units: lot.units,
    price: lot.price > 0 ? lot.price : undefined,
  });
  savePositions();
}

/** Edit one field of one lot. A cleared field is an unknown, not a zero. */
function setLot(code, index, field, value) {
  const lot = state.positions[code]?.[index];
  if (!lot) return;
  if (field === 'at') lot.at = value || todayIso();
  else if (value == null || !Number.isFinite(value)) delete lot[field];
  else lot[field] = value;
  savePositions();
}

/** Drop one lot, and the position with it when it was the last one. */
function removeLot(code, index) {
  const lots = state.positions[code];
  if (!lots?.[index]) return;
  lots.splice(index, 1);
  if (!lots.length) delete state.positions[code];
  savePositions();
}

function removePosition(code) {
  delete state.positions[code];
  savePositions();
}

/**
 * Star toggle. `onDone` lets the favourites page drop the row immediately while
 * the fund list just repaints the one button.
 */
function favButton(code, onDone) {
  const on = state.favs.has(code);
  const btn = h('button', {
    type: 'button',
    class: `fav-btn${on ? ' is-on' : ''}`,
    'aria-pressed': String(on),
    title: T(on ? 'favoriteRemove' : 'favoriteAdd'),
    'aria-label': `${T(on ? 'favoriteRemove' : 'favoriteAdd')} — ${code}`,
    onClick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFavorite(code);
      if (onDone) onDone();
      else btn.replaceWith(favButton(code, onDone));
    },
  }, on ? '★' : '☆');
  return btn;
}

function wireChrome() {
  document.getElementById('lang-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-lang]');
    if (!btn) return;
    state.lang = btn.dataset.lang;
    localStorage.setItem('fh-lang', state.lang);
    syncLangButtons();
    route();
    renderTape();
    renderColophon();
  });

  document.getElementById('theme-toggle').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const cur = document.documentElement.dataset.theme ?? 'auto';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    document.documentElement.dataset.theme = next;
    localStorage.setItem('fh-theme', next);
  });

  // The masthead search covers the whole site: 2,063 funds and 623 shares, in
  // one field, going straight to the thing you typed. It used to drive the fund
  // list's filter, which meant it could only ever find funds and only ever from
  // the list — the list has its own search box now, in its toolbar.
  const form = document.getElementById('nav-search');
  const input = document.getElementById('nav-search-input');
  const results = document.getElementById('nav-results');
  let hits = [];
  let cursor = -1;

  const close = () => {
    results.hidden = true;
    results.replaceChildren();
    hits = [];
    cursor = -1;
    input.setAttribute('aria-expanded', 'false');
  };

  const go = (hit) => {
    if (!hit) return;
    close();
    input.value = '';
    input.blur();
    location.hash = hit.href;
  };

  const mark = () => {
    for (const [i, row] of [...results.children].entries()) {
      row.classList.toggle('is-on', i === cursor);
      if (i === cursor) row.scrollIntoView({ block: 'nearest' });
    }
    input.setAttribute('aria-activedescendant', cursor < 0 ? '' : `nav-hit-${cursor}`);
  };

  const draw = () => {
    hits = searchEverything(input.value);
    cursor = -1;
    if (!input.value.trim()) return close();

    results.replaceChildren(...(hits.length
      ? hits.map((hit, i) => h('a', {
        class: 'nav-hit', id: `nav-hit-${i}`, href: hit.href, role: 'option',
        onMouseEnter: () => { cursor = i; mark(); },
        onClick: (e) => { e.preventDefault(); go(hit); },
      },
        h('span', { class: 'nav-hit-code num' }, hit.code),
        h('span', { class: 'nav-hit-name' }, hit.name),
        h('span', { class: 'nav-hit-kind' }, T(hit.share ? 'searchShareKind' : 'searchFundKind'))))
      : [h('p', { class: 'nav-hit-empty' }, T('searchNoHits'))]));
    results.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  form.addEventListener('submit', (e) => e.preventDefault());

  // The share index is half a megabyte, so it is not part of the boot payload.
  // Focus is early enough to have it ready by the time a query is typed, and
  // late enough that someone who never searches never pays for it.
  input.addEventListener('focus', () => { loadShares().then(() => { if (input.value) draw(); }); });
  input.addEventListener('input', debounce(draw, 120));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return close();
    // Enter is handled here rather than left to the form's implicit submission,
    // which depends on the browser's own rules about what counts as a submitting
    // field. This is the same key doing the same thing on every page.
    if (e.key === 'Enter') {
      if (!hits.length) return;
      e.preventDefault();
      return go(hits[cursor >= 0 ? cursor : 0]);
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!hits.length) return;
    e.preventDefault();
    cursor = e.key === 'ArrowDown'
      ? (cursor + 1) % hits.length
      : (cursor <= 0 ? hits.length : cursor) - 1;
    mark();
  });

  // A click anywhere else dismisses it. `mousedown` rather than `click`, or the
  // blur fires first and the list is gone before the click lands on a row.
  document.addEventListener('mousedown', (e) => {
    if (!form.contains(e.target)) close();
  });

  // `/` to search is the convention every data-dense site shares; without it you
  // are reaching for the mouse on every lookup.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
}

/** How many hits the masthead offers. Past this it is a page, not a suggestion. */
const SEARCH_HITS = 8;

/**
 * Slots each kind keeps when both have something to show.
 *
 * Without it, "garanti" returned eight Garanti Portföy funds and not the bank:
 * a fund whose name STARTS with the word outranks a company whose name merely
 * contains it, and there are more than eight such funds. Ranking was right and
 * the answer was useless, so each kind is guaranteed a few places before rank
 * decides the rest.
 */
const SEARCH_KIND_FLOOR = 3;

/**
 * Funds and shares matching a query, best first.
 *
 * Ranked, not just filtered: typing "ak" should offer AKBNK before every fund
 * with "ak" somewhere in a sixty-character name. An exact code wins outright, a
 * code that starts with the query comes next, then a name that starts with it,
 * then a name that merely contains it — and within a tier the biggest goes first,
 * because size is the best available proxy for "the one they meant".
 *
 * Shares are only in the list once their index has loaded; until then it answers
 * with funds alone rather than making the field wait on a fetch.
 */
function searchEverything(query) {
  // Two characters, or a single letter offers a tenth of the exchange.
  const match = queryMatcher(query, { min: 2 });
  if (!match) return [];

  const out = [];
  for (const f of state.funds) {
    const rank = match(f.c, f.n);
    if (rank == null) continue;
    out.push({ code: f.c, name: f.n, size: f.sz ?? 0, share: false, rank, href: `#/fon/${f.c}` });
  }
  for (const s of shares?.list ?? []) {
    const rank = match(s.c, s.n);
    if (rank == null) continue;
    out.push({ code: s.c, name: s.n, size: s.cap ?? 0, share: true, rank, href: `#/hisse/${s.c}` });
  }

  const better = (a, b) => a.rank - b.rank || b.size - a.size;
  const funds = out.filter((x) => !x.share).sort(better);
  const listings = out.filter((x) => x.share).sort(better);

  // Each kind takes its reserved places first, then the free slots go to whoever
  // ranks highest across both. The final list is re-sorted, so the reservation
  // decides who appears and never in what order.
  const both = funds.length && listings.length;
  const reserve = both ? SEARCH_KIND_FLOOR : SEARCH_HITS;
  const picked = [...funds.slice(0, reserve), ...listings.slice(0, reserve)];
  const rest = [...funds.slice(reserve), ...listings.slice(reserve)].sort(better);
  picked.push(...rest.slice(0, Math.max(0, SEARCH_HITS - picked.length)));

  return picked.sort(better);
}

/**
 * Publish the chrome's real heights as custom properties.
 *
 * The masthead, the toolbar and the table header stack as sticky layers, and each
 * needs the height of the ones above it. Hard-coded offsets were already wrong by
 * 6px, and would drift again with a longer translation or a larger default font.
 */
function measureChrome() {
  const style = document.documentElement.style;
  const mast = document.querySelector('.masthead')?.offsetHeight ?? 0;
  const row = document.querySelector('.toolbar-row')?.offsetHeight ?? 0;
  style.setProperty('--stick-toolbar', `${mast}px`);
  style.setProperty('--stick-table', `${mast + row}px`);
}


/**
 * Keep both search fields honest.
 *
 * The masthead's is global and carries no state, so only its wording changes with
 * the language. The list's own field mirrors `state.filters.search`, which a
 * filter chip can clear out from under it.
 */
function syncSearchInput() {
  const input = document.getElementById('nav-search-input');
  if (input) {
    input.placeholder = T('searchShort');
    input.title = T('searchHint');
  }
  const list = document.getElementById('list-search');
  if (list && list.value !== state.filters.search) list.value = state.filters.search;
}

// ---------------------------------------------------------------- market tape

/**
 * The instruments a fund is worth judging against, as a rail under the masthead.
 *
 * The money-market index sits among them as a first-class instrument rather than
 * a footnote, marked as the hurdle: it is the thing that beat four fifths of the
 * funds below, so it belongs on the tape next to BIST and gold.
 *
 * The figure is the last close and the change is over 30 days, deliberately —
 * one period, one colour, and a horizon this app can actually defend. A
 * day-trader's tape would imply an intraday feed that a static site cannot have.
 */
const TAPE = [
  { key: 'bist100', digits: 0, prefix: '', live: true },
  { key: 'usdtry', digits: 4, prefix: '₺', live: true },
  { key: 'eurtry', digits: 4, prefix: '₺', live: true },
  { key: 'goldgram', digits: 2, prefix: '₺', live: true },
  // Derived from TEFAS fund NAVs, which are daily and a day behind. It can never
  // be live, so it keeps saying "close" while its neighbours say "live".
  { key: 'mmf', digits: 2, prefix: '', hurdle: true },
];

/** Days of history behind each tile's sparkline. */
const TAPE_DAYS = 30;

async function loadLive() {
  try {
    const r = await fetch(LIVE_SOURCE.url, { signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
    if (!r.ok) return null;
    return parseLiveQuotes(await r.json());
  } catch {
    // Offline, blocked, slow or malformed — all the same answer: keep the closes.
    return null;
  }
}

/** Poll while the tab is visible; stop bothering the source when it is not. */
function startLive() {
  const tick = async () => {
    if (document.hidden) return;
    const live = await loadLive();
    // A failed refresh must not wipe a good quote off the screen, but it must
    // not let it go on claiming to be live either — `renderTape` re-stamps it.
    state.live = live;
    renderTape();
  };
  tick();
  setInterval(tick, LIVE_REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
}

// ------------------------------------------------------------ share prices

/**
 * The holdings table currently on screen, or null when no fund page is open.
 *
 * Quotes arrive after the page is drawn and then refresh while it stays open,
 * so the table hands over a redraw rather than being rebuilt from the route.
 */
let holdingsView = null;

/**
 * The dashboard, while it is the open page. Same arrangement as holdingsView:
 * quotes arrive after the first paint and refresh on a timer, so the page hands
 * over a redraw rather than being rebuilt from the route.
 */
let dashView = null;

/**
 * The open share page's redraw, while it is open.
 *
 * Only the figures strip is redrawn, not the page: the share list is rebuilt
 * wholesale on every draw and refreshing that under a reader would take the
 * search box out from under their fingers mid-word.
 */
let sharePage = null;

/** Redraw for the portfolio page, so live share prices reach its totals. */
let portfolioView = null;

/** Below this width the ring drops its outside labels and uses a legend. */
const RING_TIGHT = '(max-width: 620px)';

// The ring is drawn in one of two layouts and a media query picks which, so the
// page has to be redrawn when that flips — rotating a phone would otherwise
// leave the wide layout squeezed into a narrow screen until something else
// happened to redraw it. `portfolioView` is null unless the page is open, so
// this one listener costs nothing anywhere else.
window.matchMedia?.(RING_TIGHT)?.addEventListener?.('change', () => portfolioView?.());

/** One scan in flight per market and ticker set; every caller shares its answer. */
const quoteJobs = new Map();

/** Whether a scan has ever come back, so the first paint says nothing yet. */
let quotesTried = false;

async function loadMarket(market, tickers) {
  try {
    const r = await fetch(MARKETS[market].scan, scanRequest(tickers, QUOTE_TIMEOUT_MS));
    if (!r.ok) return null;
    return parseQuotes(await r.json());
  } catch {
    // Offline, blocked, slow or malformed — all the same answer: no prices.
    return null;
  }
}

/**
 * Quotes for one market, fetched at most once per refresh interval.
 *
 * Borsa İstanbul comes back whole, so it is fetched once and shared by every fund
 * page. The US scan is asked only for the tickers the open fund holds, keyed on
 * that list so navigating to a fund with different foreign names refetches and
 * one with the same names does not.
 *
 * A failed refresh keeps the quotes already on screen instead of blanking the
 * table: they cannot go on pretending to be current, because the stamp under the
 * table comes from the payload's own timestamp and so ages by itself.
 */
function fetchMarket(market, tickers) {
  const key = `${market}|${tickers ? tickers.join(',') : '*'}`;
  const held = state.quotes?.[market];
  if (held?.key === key && Date.now() - held.fetchedAt < QUOTE_REFRESH_MS) return Promise.resolve();

  let job = quoteJobs.get(key);
  if (!job) {
    job = loadMarket(market, tickers).then((parsed) => {
      if (parsed) {
        state.quotes = { ...state.quotes, [market]: { ...parsed, key, fetchedAt: Date.now() } };
      }
      quotesTried = true;
      quoteJobs.delete(key);
    });
    quoteJobs.set(key, job);
  }
  return job;
}

/**
 * Every market the open fund needs. Borsa İstanbul is always worth having; the
 * US scan is only made when the fund actually holds something listed there.
 */
function ensureQuotes(holdings = null) {
  const foreign = holdings ? foreignTickers(holdings) : [];
  return Promise.all([
    fetchMarket('bist', null),
    ...(foreign.length ? [fetchMarket('us', foreign)] : []),
  ]);
}

/** Poll while a holdings table is on screen and the tab is being looked at. */
function startQuotes() {
  const tick = async () => {
    if (document.hidden) return;
    if (holdingsView) {
      await ensureQuotes(holdingsView.holdings);
      holdingsView?.draw();
      return;
    }
    if (sharePage) {
      await ensureQuotes(null);
      sharePage();
      return;
    }
    if (portfolioView) {
      await ensureQuotes(null);
      portfolioView();
      return;
    }
    if (dashView) await loadEstimates(dashView.codes, dashView.draw);
  };
  setInterval(tick, QUOTE_REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
}

function renderTape() {
  const rail = document.getElementById('market-tape');
  if (!rail || !state.benchmarks.length) return;

  const closeDate = state.benchmarks.at(-1)?.d;
  const live = state.live;
  const clock = liveClock(live?.updated);
  const tiles = [];
  let anyLive = false;

  for (const item of TAPE) {
    const series = state.benchmarks.filter((r) => r[item.key] != null).map((r) => [r.d, r[item.key]]);
    if (series.length < 2) continue;

    const cutoff = new Date(Date.parse(series.at(-1)[0]) - TAPE_DAYS * 86400000)
      .toISOString().slice(0, 10);
    const window = series.filter(([d]) => d >= cutoff);

    const quote = item.live ? live?.quotes?.[item.key] : null;
    const isLive = !!quote;
    if (isLive) anyLive = true;

    // Every tile shows a DAY's move, so live and close tiles stay comparable:
    // from the feed where there is one, from the last two closes where there is not.
    const closeLast = series.at(-1)[1];
    const closePrev = series.at(-2)[1];
    const price = quote?.price ?? closeLast;
    const change = quote?.change ?? (closePrev > 0 ? (closeLast / closePrev - 1) * 100 : null);

    tiles.push(
      h('a', {
        class: `tape-tile${isLive ? ' is-live' : ''}`,
        href: '#/piyasa',
        title: `${T(item.key)} · ${T('tapeDayChange')} · ` +
          (isLive
            ? `${T('tapeLiveOne')}${clock ? ` (${clock})` : ''}`
            : T('tapeCloseOne', { date: fmtDate(series.at(-1)[0], state.lang) })),
      },
        h('span', { class: 'tape-label' },
          isLive ? h('span', { class: 'live-dot', 'aria-hidden': 'true' }) : null,
          T(item.key),
          item.hurdle
            ? h('span', { class: 'tape-hurdle', title: T('hurdleTitle') }, T('hurdleMark'))
            : null
        ),
        h('span', { class: 'tape-body' },
          h('span', { class: 'tape-value num' },
            `${item.prefix}${fmtNum(price, state.lang, item.digits)}`),
          sparkline(window)
        ),
        h('span', { class: `tape-change delta ${signOf(change)}` },
          fmtPct(change, state.lang, { signed: true, digits: 1 }))
      )
    );
  }

  rail.replaceChildren(
    h('div', { class: 'tape-inner' },
      // The stamp is the honest part: live and its clock when the feed answered,
      // the close date when it did not. It is re-derived on every render, so a
      // dropped refresh downgrades the label rather than leaving a stale "live".
      h('span', { class: `tape-stamp${anyLive ? ' is-live' : ''}`,
        title: anyLive ? T('tapeSource', { name: LIVE_SOURCE.name }) : T('tapeFallback') },
        anyLive
          ? [h('b', {}, T('tapeLive', { time: clock ?? '' })), h('span', {}, T('tapeDayChange'))]
          : [h('b', {}, T('tapeClose', { date: fmtDate(closeDate, state.lang) })),
            h('span', {}, T('tapeDayChange'))]),
      h('div', { class: 'tape-scroll', role: 'list', 'aria-label': T('marketTape') }, tiles)
    )
  );
}

/**
 * 30-day shape behind the figure.
 *
 * Drawn in a neutral tone on purpose: the number beside it is a *day's* move, and
 * colouring a 30-day line red or green next to it would put two periods in one
 * tile under the same colour language.
 */
function sparkline(points) {
  const w = 62;
  const hh = 20;
  const values = points.map(([, v]) => v);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const d = values
    .map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(hh - ((v - lo) / span) * (hh - 3) - 1.5).toFixed(1)}`)
    .join('');
  return svg('svg', {
    class: 'spark', viewBox: `0 0 ${w} ${hh}`, width: w, height: hh,
    'aria-hidden': 'true', preserveAspectRatio: 'none',
  }, svg('path', { d, fill: 'none', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
}

function renderColophon() {
  const m = state.meta;
  if (!m) return;
  document.getElementById('colophon-source').replaceChildren(
    document.createTextNode(`${T('dataSource')} · `),
    h('a', { href: 'https://www.tefas.gov.tr', rel: 'noopener', target: '_blank' }, 'tefas.gov.tr'),
    document.createTextNode(` · ${T('updated', { date: fmtDate(m.latestDate, state.lang) })} · `),
    // The third parties this page calls at runtime, named where a reader can
    // see them rather than buried in a source file. Everything else on the page
    // is committed JSON.
    document.createTextNode(`${T('tapeSource', { name: '' }).replace(/:\s*$/, '')}: `),
    h('a', { href: LIVE_SOURCE.home, rel: 'noopener', target: '_blank' }, LIVE_SOURCE.name),
    document.createTextNode(', '),
    h('a', { href: QUOTE_SOURCE.home, rel: 'noopener', target: '_blank' }, QUOTE_SOURCE.name)
  );
  document.getElementById('colophon-note').textContent =
    state.lang === 'tr'
      ? 'Yatırım tavsiyesi değildir. Geçmiş getiri gelecek performansı garanti etmez.'
      : 'Not investment advice. Past performance does not guarantee future results.';
}

// ---------------------------------------------------------------- routing

function route() {
  const hash = hashPath();
  const fund = hash.match(/^\/fon\/([A-Za-z0-9]+)$/);
  const share = hash.match(/^\/hisse\/([A-Za-z0-9]+)$/);
  const versus = hash.match(/^\/karsilastir\/([A-Za-z0-9,]+)$/);
  syncNav();
  syncSearchInput();
  // Leaving the dashboard has to drop its refresh loop, or the timer keeps
  // redrawing a page that is no longer there.
  if (hash !== '/') dashView = null;
  if (!share) sharePage = null;
  if (hash !== '/portfoy') portfolioView = null;
  if (versus) renderCompare(versus[1].toUpperCase().split(',').filter(Boolean));
  else if (fund) renderDetail(fund[1].toUpperCase());
  else if (share) renderShare(share[1].toUpperCase());
  else if (hash === '/hisseler') renderShareList();
  else if (hash === '/piyasa') renderMarket();
  else if (hash === '/populer') renderPopular();
  else if (hash === '/dusus') renderCrashPage();
  else if (hash === '/favoriler') enterList('favs');
  else if (hash === '/portfoy') renderPortfolio();
  else if (hash === '/fonlar') enterList('list');
  else renderDashboard();
  view.focus({ preventScroll: true });
}

/**
 * The windows a chart can be read over. Declared here because both the fund
 * page's chart and the dashboard's watchlist offer them, and the two should
 * never drift into naming the same range differently.
 */
const CHART_RANGES = [
  { key: 'm1', days: 30, labelKey: 'return1m' },
  { key: 'm3', days: 91, labelKey: 'return3m' },
  { key: 'm6', days: 182, labelKey: 'return6m' },
  { key: 'y1', days: 365, labelKey: 'return1y' },
  { key: 'all', days: null, labelKey: 'rangeAll' },
];

// ---------------------------------------------------------------- dashboard
//
// The landing page. Not the fund list: the list is where you go to look for
// something, and this is where you go to see how what you already care about is
// doing. Three panes — who took money in this week, your own funds, and a
// month of each of theirs.
//
// It carries no heading and no standing prose. Everything on it is either a
// figure or a name; what a column means is in its tooltip.
//
// Everything here is a fund you can price, so every row carries the same two
// figures: the last NAV TEFAS published, and what the fund's holdings have done
// since, from live share prices. They are deliberately adjacent — the second is
// an estimate of the move the first has not caught up with yet.

/** How many funds each rail lists. Beyond this the pane stops being a glance. */
const DASH_ROWS = 6;

/**
 * The windows a watchlist tile offers.
 *
 * The fund chart's ranges, minus its "all" — the history files are a year long,
 * so it would be the 1Y option under a second name — plus a day, which only a
 * share can answer. A fund's price is published once a night; there is no such
 * thing as a fund's afternoon.
 */
const WATCH_RANGES = [
  { key: 'd1', days: null, labelKey: 'win1d' },
  // Short labels, because this picker is 60px wide inside a tile rather than a
  // row of buttons across a panel — "3 Months" does not fit and does not need to.
  ...CHART_RANGES.filter((r) => r.days != null)
    .map((r) => ({ ...r, labelKey: `win${r.key.replace(/^([my])(\d)$/, '$2$1')}` })),
];

/** Which window each code is drawn over: `{ ASELS: 'm1' }`. Per tile, remembered. */
let watchRanges = {};


/** code -> parsed holdings, or null when there is no filing. Survives navigation. */
const holdingsCache = new Map();
/** code -> the fund's own price history, for the watchlist chart. */
const historyCache = new Map();
/** One statement file per share, kept for as long as the tab is open. */
const finCache = new Map();
/** code -> estimateMove() result, recomputed whenever quotes refresh. */
const dashEstimates = new Map();

function loadHoldings(code) {
  if (holdingsCache.has(code)) return holdingsCache.get(code);
  const job = fetch(`${DATA}/holdings/${code}.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  holdingsCache.set(code, job);
  return job;
}

/**
 * Whether a code names a share rather than a fund.
 *
 * Every TEFAS fund code is exactly three letters and every Borsa İstanbul ticker
 * is four or five, so the code itself says which file to open and the two can
 * share one favourites list without ever colliding.
 */
const isShareCode = (code) => /^[A-Z][A-Z0-9]{3,4}$/.test(code);

function loadHistory(code) {
  if (historyCache.has(code)) return historyCache.get(code);
  const dir = isShareCode(code) ? 'stocks' : 'history';
  const job = fetch(`${DATA}/${dir}/${code}.jsonl`)
    .then((r) => (r.ok ? r.text() : ''))
    .then(parseJsonl)
    .then((rows) => rows.filter((r) => r.p != null).map((r) => [r.d, r.p]))
    .catch(() => []);
  historyCache.set(code, job);
  return job;
}

/**
 * The live estimate for a set of funds, filled in after the page is drawn.
 *
 * One market scan covers every fund on the page — Borsa İstanbul comes back
 * whole — so the cost of a second row is one small holdings file, not another
 * round trip to the exchange.
 */
async function loadEstimates(codes, redraw) {
  const filings = await Promise.all(codes.map(loadHoldings));
  const rows = filings.flatMap((f) => f?.holdings ?? []);
  if (!rows.length) return;
  await ensureQuotes(rows);

  for (let i = 0; i < codes.length; i++) {
    const filing = filings[i];
    if (!filing?.holdings) continue;
    dashEstimates.set(codes[i], estimateMove(
      aggregateHoldings(filing.holdings), state.quotes, state.live?.quotes ?? null
    ));
  }
  redraw();
}

/**
 * A fund's estimated move right now, or null when it cannot be stated.
 *
 * The same gates as the fund page, for the same reasons: weights that do not
 * reconcile cannot carry a total, and a figure built on a tenth of the portfolio
 * would be read as the fund's own move.
 */
function estimateFor(code) {
  const est = dashEstimates.get(code);
  if (!est || !est.reliable || est.priced < MIN_COVERAGE) return null;
  return est;
}

/**
 * One row of a dashboard rail.
 *
 * Two lines rather than four columns. A rail is about 300px wide, and a Turkish
 * fund name runs to sixty characters — squeezed into a column beside two figures
 * it renders as "TERA PORT…", which identifies nothing. So the code and the two
 * figures share the top line and the name gets the width to itself.
 */
function dashRow(fund, extra) {
  const est = estimateFor(fund.c);
  return h('a', { class: 'dash-row', href: `#/fon/${fund.c}` },
    h('span', { class: 'dash-top' },
      h('span', { class: 'dash-code num' }, fund.c),
      h('span', { class: `dash-last delta ${signOf(fund.ch)}`, title: T('dashLastNote') },
        fmtPct(fund.ch, state.lang, { signed: true, digits: 2 })),
      h('span', {
        class: `dash-live delta ${est ? signOf(est.move) : 'flat'}`,
        title: est ? T('dashLiveNote', { n: fmtPct(est.priced, state.lang, { digits: 0 }) })
          : T('dashLiveNone'),
      },
        est ? fmtPct(est.move, state.lang, { signed: true, digits: 2 }) : '—')
    ),
    h('span', { class: 'dash-title' }, fund.n),
    h('span', { class: 'dash-meta' }, extra)
  );
}

/** The column heads the top line of each row lines up under. */
const dashHead = () =>
  h('div', { class: 'dash-row dash-head' },
    h('span', { class: 'dash-top' },
      h('span', { class: 'dash-code' }, T('code')),
      h('span', { class: 'dash-last', title: T('dashLastNote') }, T('dashLast')),
      h('span', { class: 'dash-live', title: T('dashLiveHead') }, T('dashLive'))
    )
  );

/**
 * A rail: a heading, a link out, and rows.
 *
 * No standing explanation under the heading. A dashboard is read at a glance
 * every day, and a paragraph you have already read is noise the second time —
 * what the columns mean lives in their tooltips instead.
 */
function dashPane(titleKey, rows, link) {
  return h('section', { class: 'panel dash-pane' },
    h('div', { class: 'dash-pane-head' },
      h('h2', {}, T(titleKey)),
      link ? h('a', { class: 'dash-more', href: link.href }, link.text) : null),
    rows
  );
}

const favouritePool = () =>
  state.funds.filter((f) => state.favs.has(f.c)).slice(0, DASH_ROWS);

/** Starred shares, once the index they are named in has been loaded. */
const favouriteShares = () =>
  shares ? shares.list.filter((s) => state.favs.has(s.c)).slice(0, DASH_ROWS) : [];

function renderDashboard() {
  state.page = 'dash';
  const flows = renderFlows();
  const popular = flowPool(false);
  const favourites = favouritePool();
  // Shares are starred from the same list as funds — a three-letter code is a
  // fund and a four-letter one a share, so they never collide — and they join
  // the funds on the chart. The index they are named in is half a megabyte, so
  // it is fetched only when a starred share needs it, and the pane redraws.
  const starredShares = [...state.favs].some(isShareCode);
  if (starredShares && !shares) {
    loadShares().then(() => { if (state.page === 'dash') renderDashboard(); });
  }
  const watched = [...favourites, ...favouriteShares()];
  const fromFavourites = watched.length > 0;
  // Nothing starred: the pane borrows the week's inflows, and says so.
  if (!fromFavourites) watched.push(...popular);

  const draw = () => {
    if (state.page !== 'dash') return;
    flows.draw();
    const el = document.getElementById('dash-favs');
    if (el) el.replaceChildren(dashHead(), ...favourites.map((f) => dashRow(f, f.f)));
  };

  // Held rather than inlined, because the quote refresh below has to be able to
  // redraw its tiles: a share tile opens on today, and today is a quote.
  const watchlist = renderWatchlist(watched, fromFavourites);
  // Both read the whole-exchange scan the page already makes, so they cost a
  // membership map in meta.json and no request of their own.
  const market = renderMarketPanels();

  const favouritesPane = h('section', { class: 'panel dash-pane' },
    h('div', { class: 'dash-pane-head' },
      h('h2', {}, T('dashFavourites')),
      favourites.length
        ? h('a', { class: 'dash-more', href: '#/favoriler' }, T('dashMore')) : null),
    // The hurdle sits at the top of the funds you actually hold, because
    // that is the one place on the site where "did this beat doing nothing"
    // is a question about your own money rather than about a stranger's.
    favourites.length ? vsCashStrip(favourites) : null,
    favourites.length
      ? h('div', { class: 'dash-rows', id: 'dash-favs' }, dashHead(),
          ...favourites.map((f) => dashRow(f, f.f)))
      : h('p', { class: 'panel-note' }, T('favoritesEmpty')));

  // No page heading. The dashboard is the thing you open every morning, and a
  // title that says "Dashboard" over a lede explaining what a dashboard is costs
  // a third of the screen to tell you what you can already see. The tape above
  // carries the date the figures close on.
  //
  // A column and a rail, each packing its own panels top to bottom — not one
  // grid of cells. Every panel here is sized by data that changes daily: the
  // rail of inflows is six rows tall, the funds you follow may be none. Put
  // them in shared grid rows and the tallest sets the height of the row, so the
  // short one leaves a hole in the middle of the fold with content all round
  // it. Two independent stacks cannot do that — the leftover falls to the foot
  // of a column, next to the footer, where nobody reads it as a gap.
  //
  // What goes where is editorial, and it also happens to balance. The rail is
  // money: where the week's went, and where yours is — both lists of codes,
  // which read the same at 340px as at 900px. The column is the market: what
  // you follow, then the day by sector, then the day's extremes, then the week
  // — the first three want width, for a sparkline, nineteen labelled chips and
  // a three-figure row respectively, and the last belongs under the day it is
  // the longer view of.
  // What moved while you were away. Its own element, because the histories it
  // needs are a second round of requests and the rest of the page must not wait.
  const away = h('div', {});
  renderSinceVisit(favourites, away);

  view.replaceChildren(...[
    h('div', { class: 'dash-grid' },
      h('div', { class: 'dash-col' },
        watchlist.panel,
        market.themes,
        market.movers,
        // Off meta.json rather than the scan, so it is on screen before the
        // first quote arrives.
        renderTrending()),
      h('div', { class: 'dash-col dash-rail' },
        away,
        flows.panel,
        favouritesPane)
    ),
    // Full width, below both: a row of it is two fund names at either end of a
    // shared-weight bar, and there is no width at which that wants a column.
  ].filter(Boolean));

  // Prices arrive after the page is on screen, and again on every refresh while
  // it stays there. The watchlist redraws with them too, not only the rails: a
  // share tile opens on today, and today comes from the quotes rather than from
  // a file.
  // Both directions of the flows rail, so switching to outflows does not have
  // to go back to the exchange for prices it could already have had.
  const codes = [...new Set([...flows.codes(), ...favourites.map((f) => f.c)])];
  const drawAll = () => { draw(); watchlist.draw(); market.draw(); };
  if (codes.length) loadEstimates(codes, drawAll).catch(() => {});
  else ensureQuotes(null).then(drawAll);
  dashView = { codes, draw: drawAll };

  window.scrollTo({ top: 0 });
}

/**
 * The flows rail, in whichever direction you ask it for.
 *
 * One pane rather than two. Money arriving and money leaving are the same
 * question asked twice, and a reader comparing them wants them in the same
 * place at the same size — not one pane above the fold and its opposite below.
 *
 * Money-market funds dominate both ends, and for a good reason: they hold the
 * bulk of the industry's cash, so they take in and give up the bulk of its
 * movement every week. The risk floor that already governs this rail keeps them
 * out of both directions.
 */
function renderFlows() {
  let outward = false;
  const rows = h('div', { class: 'dash-rows', id: 'dash-popular' });
  const title = h('h2', {}, T('dashPopular'));

  const buttons = [['flowIn', false], ['flowOut', true]].map(([labelKey, dir]) =>
    h('button', {
      type: 'button', 'aria-pressed': String(outward === dir),
      onClick: () => { outward = dir; draw(); },
    }, T(labelKey)));

  const panel = h('section', { class: 'panel dash-pane' },
    h('div', { class: 'dash-pane-head' },
      title,
      h('div', { class: 'seg seg-mini', role: 'group', 'aria-label': T('flowDirection') }, buttons)),
    rows,
    h('a', { class: 'dash-more', href: '#/populer' }, T('dashMore'))
  );

  function draw() {
    const list = flowPool(outward);
    title.textContent = T(outward ? 'dashFlowOut' : 'dashPopular');
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(Boolean(i) === outward)));
    rows.replaceChildren(...(list.length
      ? [dashHead(), ...list.map((f) => dashRow(f,
          T(outward ? 'dashFlowWeekOut' : 'dashFlowWeek',
            { n: fmtMoney(Math.abs(f.fl7), state.lang) })))]
      : [h('p', { class: 'panel-note' }, T('noneYet'))]));
  }

  draw();
  return { panel, draw, codes: () => [...flowPool(false), ...flowPool(true)].map((f) => f.c) };
}

/** The week's biggest movements of money, in one direction or the other. */
const flowPool = (outward) =>
  popularPool()
    .filter((f) => f.fl7 != null && (outward ? f.fl7 < 0 : f.fl7 > 0))
    .sort((a, b) => (outward ? a.fl7 - b.fl7 : b.fl7 - a.fl7))
    .slice(0, DASH_ROWS);

/**
 * Whether the funds you follow are beating the thing you could have done instead.
 *
 * The money market is the hurdle everywhere else on this site, and the funds
 * pane is where it matters most: these are the ones you actually hold. The
 * median rather than the average, because one fund up 600% would otherwise
 * report a portfolio comfortably ahead when most of it is behind.
 *
 * Equal-weighted, and it has to be — the site knows which funds you follow and
 * not how much of each you hold. So it says "median of your funds" rather than
 * "your return", which would be a number nobody could act on.
 */
function vsCashStrip(funds) {
  const horizon = horizonOf(state.prefs.horizon);
  const view = versusCash(funds, horizon.key, state.meta?.cashReturns);
  if (!view || view.gap == null) return null;

  return h('div', { class: 'vs-cash' },
    h('div', { class: 'vs-cash-head' },
      h('span', {}, T('vsCashHead')),
      h('span', { class: 'vs-cash-hz num' }, T(horizon.labelKey))),
    h('dl', { class: 'vs-cash-figures' },
      h('div', {},
        h('dt', {}, T('vsCashMedian')),
        h('dd', { class: `num delta ${signOf(view.median)}` },
          fmtPct(view.median, state.lang, { signed: true, digits: 1 }))),
      h('div', {},
        h('dt', {}, T('vsCashHurdle')),
        h('dd', { class: 'num' }, fmtPct(view.cash, state.lang, { digits: 1 }))),
      h('div', {},
        // The gap is in POINTS. Two percentages differ by points, and printing
        // that difference with a percent sign is the easiest way to mislead.
        h('dt', {}, T('vsCashGap')),
        h('dd', { class: `num delta ${signOf(view.gap)}` },
          fmtPoints(view.gap, state.lang, { signed: true, digits: 1 })))
    ),
    // How many of them clear the hurdle, under the median that hides it: three
    // funds with a median ahead of cash can still be two funds behind it.
    h('p', { class: 'vs-cash-count' }, T('vsCashAhead', { n: view.beating, of: view.of }))
  );
}

/**
 * Whether two funds you follow are the same fund.
 *
 * The panel this project can draw and no fund page ever can: it needs every
 * fund's filing at once. Two funds sharing 81% of their portfolio are one
 * position wearing two names, and someone holding both believes they have
 * diversified.
 *
 * Silent unless there is something to say. Across the equity funds that file,
 * the median pair overlaps nothing at all, so on most watchlists this draws a
 * single line saying so — which is itself worth reading once.
 */
function renderOverlap(codes) {
  if (codes.length < 2) return null;
  const body = h('div', { class: 'overlap-body' },
    h('p', { class: 'panel-note' }, T('loading')));

  const panel = h('section', { class: 'panel overlap-panel' },
    h('h2', {}, T('dashOverlap')),
    h('p', { class: 'panel-note' }, T('overlapNote')),
    body
  );

  const page = state.page;
  Promise.all(codes.map(loadHoldings)).then((filings) => {
    // Whichever page asked for it must still be the page on screen.
    if (state.page !== page) return;
    const weights = {};
    codes.forEach((code, i) => {
      const rows = filings[i]?.holdings;
      // A filing whose weights do not reconcile is not published anywhere else
      // on this site and is not quietly used here either.
      if (rows?.length) weights[code] = weightsOf(rows);
    });

    const pairs = overlappingPairs(weights);
    if (!pairs.length) {
      body.replaceChildren(h('p', { class: 'panel-note' }, T('overlapClean')));
      return;
    }
    body.replaceChildren(...pairs.map((pair) => overlapRow(pair, weights)));
  }).catch(() => {
    body.replaceChildren(h('p', { class: 'panel-note' }, T('overlapClean')));
  });

  return panel;
}

/** One overlapping pair: how much, and which positions account for it. */
function overlapRow({ a, b, shared }, weights) {
  const both = sharedPositions(weights[a], weights[b]);
  const nameOf = (code) => state.funds.find((f) => f.c === code)?.n ?? '';

  return h('div', { class: 'overlap-pair' },
    h('div', { class: 'overlap-heads' },
      h('a', { class: 'overlap-fund', href: `#/fon/${a}` },
        h('span', { class: 'dash-code num' }, a),
        h('span', { class: 'row-sub' }, nameOf(a))),
      // The figure sits between the two codes it is about, so it never has to
      // repeat them to say what it means.
      h('span', { class: 'overlap-figure num' }, T('overlapPair', { n: fmtNum(shared, state.lang, 0) })),
      h('a', { class: 'overlap-fund', href: `#/fon/${b}` },
        h('span', { class: 'dash-code num' }, b),
        h('span', { class: 'row-sub' }, nameOf(b)))
    ),
    h('div', { class: 'overlap-bar' },
      h('span', { class: 'overlap-fill', style: `width:${Math.min(100, shared)}%` })),
    both.length ? h('ul', { class: 'overlap-shared' },
      h('li', { class: 'overlap-label' }, T('overlapShared')),
      both.map((row) => h('li', {},
        holdingCode(row.code),
        h('span', { class: 'num' }, fmtPct(row.weight, state.lang, { digits: 1 }))))
    ) : null
  );
}

/** A shared position's code, linked when the exchange lists it. */
function holdingCode(code) {
  const listed = state.meta?.listedCodes?.includes(code);
  return listed
    ? h('a', { class: 'code-link num', href: `#/hisse/${code}` }, code)
    : h('span', { class: 'num' }, code);
}

/**
 * What kind of day it was, by theme, and who moved most inside the index.
 *
 * Both come out of the scan the dashboard already makes — it asks for the whole
 * exchange — so the pair costs one small membership map in `meta.json` and no
 * network at all. Which ticker belongs to which theme, and which are in a
 * headline index, is the only thing the browser was missing.
 */
function renderMarketPanels() {
  const themesBody = h('div', { class: 'theme-heat' });
  const moversBody = h('div', { class: 'movers' });
  const waiting = () => h('p', { class: 'panel-note' }, T('awaitingQuotes'));
  themesBody.append(waiting());
  moversBody.append(waiting());

  // Handed back as two loose panels rather than a row of their own. The
  // dashboard packs them into its two columns — themes into the wide one it
  // needs, movers onto the rail — and a wrapper here would only be a box the
  // caller has to unpick.
  const themes = h('section', { class: 'panel' },
    h('h2', {}, T('dashThemes')),
    h('p', { class: 'panel-note' }, T('themesNote')),
    themesBody);
  const movers = h('section', { class: 'panel' },
    h('h2', {}, T('dashMovers')),
    h('p', { class: 'panel-note' }, T('moversNote')),
    moversBody);

  const draw = () => {
    if (state.page !== 'dash') return;
    const quotes = state.quotes?.bist?.quotes ?? null;
    if (!quotes) return;

    const moves = themeMoves(state.meta?.themeWeights, quotes);
    themesBody.replaceChildren(...(moves.length
      ? moves.map((t) => h('a', {
          class: 'theme-cell',
          href: listHref('/fonlar'),
          style: `background:${moveColor(t.move, THEME_TILE_CEILING)}`,
          title: `${themeName(t.id)} · ${t.priced}/${t.of}`,
          onClick: () => {
            // The same handoff a share page makes: set the filter, let the
            // router take the route. Two ways of saying it would be one too many.
            state.filters.theme = t.id;
            state.filters.minTheme = MIN_THEME;
          },
        },
          h('span', { class: 'theme-cell-name' }, themeName(t.id)),
          h('span', { class: 'theme-cell-move num' },
            fmtPct(t.move, state.lang, { signed: true, digits: 1 })))
        )
      : [waiting()]));

    const movers = moversIn(state.meta?.bist100, quotes);
    moversBody.replaceChildren(...(movers
      ? [
          moverColumn('moversUp', movers.up),
          moverColumn('moversDown', movers.down),
        ].filter(Boolean)
      : [waiting()]));
  };

  return { themes, movers, draw };
}

/** How many sectors the trending panel lists. Six is what fits without scrolling. */
const TREND_SECTORS = 6;

/**
 * What has been going up over the last few days.
 *
 * The panels above it are about today, which is the question the live scan can
 * answer. A week is not: it needs a price from a week ago for every listing on
 * the exchange, so it is computed once a day into meta.json — 1.5KB in a file
 * the page already loads — and this draws it with no request of its own and no
 * waiting for quotes.
 *
 * Both halves are rising things only. "Trending" over a week the whole market
 * fell is the least bad company, which is not what the heading says.
 */
function renderTrending() {
  const t = state.meta?.trending;
  const sectors = (t?.sectors ?? []).filter((s) => s.move > 0).slice(0, TREND_SECTORS);
  const shares = t?.shares ?? [];
  if (!sectors.length && !shares.length) return null;

  return h('section', { class: 'panel trend-panel' },
    h('div', { class: 'dash-pane-head' },
      h('h2', {}, T('trendPanel')),
      h('span', { class: 'trend-window' }, T('trendWindow'))),

    sectors.length ? h('div', { class: 'trend-half' },
      h('h3', {}, T('trendSectors')),
      h('ul', { class: 'trend-list' }, sectors.map((s) => h('li', {},
        h('a', {
          class: 'trend-name',
          href: listHref('/fonlar'),
          // The same handoff the themes strip makes: set the filter, let the
          // router take the route.
          onClick: () => {
            state.filters.theme = s.id;
            state.filters.minTheme = MIN_THEME;
          },
        }, themeName(s.id)),
        h('span', { class: `num delta ${signOf(s.move)}` },
          fmtPct(s.move, state.lang, { signed: true, digits: 1 })))))
    ) : null,

    shares.length ? h('div', { class: 'trend-half' },
      h('h3', {}, T('trendShares')),
      h('ul', { class: 'trend-list trend-shares' }, shares.map((s) => h('li', {},
        h('a', { class: 'code-link num', href: `#/hisse/${s.c}` }, s.c),
        h('span', { class: 'trend-share-name' }, s.n),
        // Carried through from the board scan. A list of what is running is
        // exactly where a name running for the wrong reasons turns up, and the
        // site says elsewhere which those are.
        s.spec
          ? h('a', {
              class: 'chip chip-warn trend-flag',
              href: `#/hisse/${s.c}`,
              title: T('specNote'),
            }, T('specChip'))
          : null,
        h('span', { class: `num delta ${signOf(s.move)}` },
          fmtPct(s.move, state.lang, { signed: true, digits: 1 })))))
    ) : null
  );
}

/** One side of the movers panel, or nothing when the market went one way. */
function moverColumn(titleKey, rows) {
  if (!rows.length) return null;
  return h('div', { class: 'mover-col' },
    h('h3', {}, T(titleKey)),
    h('ul', {}, rows.map((r) => h('li', {},
      h('a', { class: 'code-link num', href: `#/hisse/${r.code}` }, r.code),
      h('span', { class: 'mover-price num' }, `₺${fmtNum(r.price, state.lang, 2)}`),
      h('span', { class: `num delta ${signOf(r.change)}` },
        fmtPct(r.change, state.lang, { signed: true, digits: 2 })))))
  );
}

/**
 * How many columns of tiles fill best, for a given number of tiles.
 *
 * A fixed three leaves an orphan whenever you follow four funds; a fixed four
 * splits the six borrowed ones as 4 + 2. Neither number is right for both, so
 * pick the one that leaves the fewest empty slots and, where two tie, the wider
 * layout — four is the ceiling, because past it the sparkline is narrower than
 * the fund name over it.
 */
function watchColumns(n) {
  if (n < 2) return 1;
  let best = Math.min(n, 4);
  let waste = Infinity;
  for (const c of [4, 3, 2]) {
    if (c > n) continue;
    const empty = (c - (n % c)) % c;
    if (empty < waste) { waste = empty; best = c; }
  }
  return best;
}

/**
 * The funds you follow, one chart each.
 *
 * Not one chart with every fund on it. A shared axis forces two things on the
 * reader: every line has to be rebased to 100 before it can be compared at all,
 * and then six colours have to be held in your head to know which line is whose.
 * A fund's own month, over its own price, under its own code asks for neither.
 */
function renderWatchlist(items, fromFavourites) {
  // The container queries on .watch-grid still override this when the pane is
  // too narrow to honour the number.
  const grid = h('div', { class: 'watch-grid', style: `--watch-n:${watchColumns(items.length)}` });
  let histories = null;

  const draw = () => {
    if (!histories) return;
    const tiles = items.map((item, i) => watchTile(item, histories[i], draw)).filter(Boolean);
    grid.replaceChildren(...(tiles.length
      ? tiles
      : [h('p', { class: 'panel-note' }, T('noHistory'))]));
  };

  const panel = h('section', { class: 'panel dash-chart' },
    h('div', { class: 'dash-pane-head' },
      h('h2', {}, T('watchPanel')),
      h('span', { class: 'watch-window' }, T('watchPerTile'))),
    // The one line of prose that survives, and only when it is not yet your
    // list: without it the pane would claim you follow funds you have never seen.
    fromFavourites ? null : h('p', { class: 'panel-note' }, T('watchNoneHint')),
    grid
  );
  if (items.length) {
    Promise.all(items.map((f) => loadHistory(f.c))).then((loaded) => {
      if (state.page !== 'dash') return;
      histories = loaded;
      draw();
    }).catch(() => {});
  }

  return { panel, draw };
}

/**
 * One tile over its own window, or null when there is too little to draw.
 *
 * Each tile carries its own picker, because the two kinds on this pane are not
 * asking the same question. A share has a live price and a day that is still
 * happening; a fund has a NAV published once, last night, and a day means
 * nothing to it. So a share opens on today and a fund on the month, and either
 * can be changed without touching the other.
 *
 * The dates under the chart are not decoration: a fund younger than the window
 * draws whatever it has, and without them a six-week-old fund would look like it
 * had been flat for a year.
 */
function watchTile(item, points, redraw) {
  const share = isShareCode(item.c);
  const range = watchRangeFor(item.c, share);
  const quote = share ? shareQuote(item.c) : null;

  const series = range === 'd1'
    ? intraday(item.c, quote)
    : windowOf(points, range);
  if (!series || series.length < 2) {
    // A share whose intraday path has not arrived yet still has a month behind
    // it, so the tile shows that rather than an empty box.
    if (range !== 'd1') return null;
    const fallback = windowOf(points, 'm1');
    if (!fallback || fallback.length < 2) return null;
    return tileFor(item, fallback, range, share, quote, redraw, true);
  }
  return tileFor(item, series, range, share, quote, redraw, false);
}

/** The stored window for one code, or the default for its kind. */
function watchRangeFor(code, share) {
  const stored = watchRanges[code];
  if (stored && rangesFor(share).some((r) => r.key === stored)) return stored;
  return share ? 'd1' : 'm1';
}

/** Only a share has a today worth drawing; a fund's price moves once a night. */
const rangesFor = (share) => (share ? WATCH_RANGES : WATCH_RANGES.filter((r) => r.key !== 'd1'));

/** The tail of a daily series, by range key. */
function windowOf(points, range) {
  const all = points ?? [];
  if (all.length < 3) return null;
  const { days } = WATCH_RANGES.find((r) => r.key === range) ?? {};
  if (!days) return all;
  const cutoff = new Date(Date.parse(all.at(-1)[0]) - days * 86400000)
    .toISOString().slice(0, 10);
  const window = all.filter(([d]) => d >= cutoff);
  return window.length >= 3 ? window : null;
}

/** Today's path for a share, from the live feed rather than from a file. */
function intraday(code, quote) {
  if (!quote) return null;
  // The feed's own stamp, not the clock: the scan is fifteen minutes delayed and
  // a path drawn to `now` would claim a quarter hour it does not have.
  const asOf = state.quotes?.bist?.asOf ?? Date.now();
  const open = sessionOpenAt('bist', new Date(asOf));
  if (open == null) return null;
  // The previous close anchors the arithmetic, but it is not part of today: a
  // line that starts at yesterday draws the overnight gap as though it were a
  // trade, and flattens the session next to it. The figure above the chart still
  // comes from the day's change, so nothing is lost by leaving it out.
  return intradaySeries(quote, asOf, { sessionOpenMs: open })
    .filter(([iso]) => Date.parse(iso) >= open);
}

function tileFor(item, series, range, share, quote, redraw, fellBack) {
  const shown = fellBack ? 'm1' : range;
  const first = series[0][1];
  const last = series.at(-1)[1];
  // Over a day the feed's own figure is the answer — it is measured against
  // yesterday's close, which the line deliberately does not include.
  const change = shown === 'd1' && quote?.change != null
    ? quote.change
    : (first > 0 ? (last / first - 1) * 100 : null);
  const label = shown === 'd1' ? clockLabel : dateAxisLabeler([series[0][0], series.at(-1)[0]]);

  const picker = h('select', {
    class: 'watch-range', 'aria-label': T('rangeLabel'),
    onChange: (e) => {
      watchRanges[item.c] = e.target.value;
      localStorage.setItem('fh-watch', JSON.stringify(watchRanges));
      redraw();
    },
  }, rangesFor(share).map((r) =>
    h('option', { value: r.key, selected: r.key === range }, T(r.labelKey))));

  return h('div', { class: `watch-tile ${signOf(change)}` },
    h('a', { class: 'watch-head', href: `#/${share ? 'hisse' : 'fon'}/${item.c}`, title: item.n },
      h('span', { class: 'watch-top' },
        h('span', { class: 'dash-code num' }, item.c),
        h('span', { class: `delta ${signOf(change)}` },
          fmtPct(change, state.lang, { signed: true, digits: shown === 'd1' ? 2 : 1 }))),
      h('span', { class: 'watch-name' },
        h('span', { class: 'watch-name-text' }, item.n),
        // A share's price is live and is the thing you came to see; a fund's is
        // last night's NAV and is already the first column of the rail beside it.
        quote ? h('span', { class: 'watch-price num' }, `₺${fmtNum(quote.price, state.lang, 2)}`) : null),
      miniChart(series)),
    h('span', { class: 'watch-dates num' },
      h('span', {}, label(series[0][0])),
      picker,
      h('span', {}, fellBack ? T('watchNoSession') : label(series.at(-1)[0])))
  );
}

/** Time of day, for the one window where the date is the same at both ends. */
const clockLabel = (iso) =>
  new Intl.DateTimeFormat(state.lang === 'tr' ? 'tr-TR' : 'en-GB',
    { hour: '2-digit', minute: '2-digit', timeZone: MARKETS.bist.zone })
    .format(new Date(iso));

/**
 * A month of prices at tile size: a line, a wash under it, no axes.
 *
 * Scaled to its own window rather than to zero, because a fund that moved 2% in
 * a month would otherwise draw a flat line. The shape is what the tile is for;
 * the two figures around it carry the size.
 */
function miniChart(points) {
  const w = 100;
  const hh = 42;
  const pad = 4;
  const values = points.map(([, v]) => v);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const step = w / (values.length - 1);
  const at = (v, i) =>
    `${(i * step).toFixed(2)},${(pad + (1 - (v - lo) / span) * (hh - pad * 2)).toFixed(2)}`;
  const line = `M${values.map(at).join('L')}`;
  return svg('svg', {
    class: 'watch-spark', viewBox: `0 0 ${w} ${hh}`,
    preserveAspectRatio: 'none', 'aria-hidden': 'true',
  },
    svg('path', { class: 'watch-fill', d: `${line}L${w},${hh}L0,${hh}Z` }),
    svg('path', { class: 'watch-line', d: line, fill: 'none' })
  );
}

// ---------------------------------------------------------------- list view

/**
 * The fund list, and the favourites page — deliberately the same view.
 *
 * Favourites are a subset of the universe, so the filter bar, preferences and
 * table all apply unchanged; a separate implementation would only drift.
 */
function renderList(page = state.page) {
  state.page = page;
  applyFilters();

  if (page === 'favs') {
    // Funds and shares are starred from the same list, so the page has to be
    // able to show either half on its own: someone who has only starred shares
    // was being told they had no favourites at all.
    const shareCodes = [...state.favs].filter(isShareCode);
    const hasFunds = state.results.length > 0;
    view.replaceChildren(
      renderFavHead(),
      ...(hasFunds ? [renderToolbar(), renderTable()] : []),
      ...(shareCodes.length ? [renderFavShares(shareCodes)] : []),
      ...(hasFunds || shareCodes.length ? [] : [emptyFavs()])
    );
  } else {
    view.replaceChildren(
      subNav('/fonlar'), renderHighlights(), renderToolbar(), renderTable());
  }
  window.scrollTo({ top: 0 });
  measureChrome();
}

/**
 * Re-run the query without rebuilding the page.
 *
 * Every filter control lives inside a panel you are likely to change several
 * times in a row, and re-rendering the view would take focus off the control
 * under your hand after each one. Only the parts that actually change are
 * replaced.
 */
function applyAndRefresh() {
  applyFilters();
  refreshResults();
  // Every control on the page ends up here, so this is where the screen becomes
  // a link. Written before the chips are redrawn, since both read the same state.
  syncScreenUrl();
  const chips = document.getElementById('active-chips');
  if (chips) chips.replaceWith(renderActiveChips());
  // Chips wrapping onto a second line changes the toolbar's height, and the
  // table header sticks below it.
  measureChrome();
  const badge = document.getElementById('filter-badge');
  const n = activeFilters().length;
  if (badge) {
    badge.textContent = n ? String(n) : '';
    badge.hidden = !n;
  }
}


// ------------------------------------------------------------- the screen URL
//
// The hash carries two things now: the route, and — on the two pages that have
// a filter bar — the screen. `#/fonlar?risk=4&stance=defensive&on=cash`.
//
// Everything that changes the screen goes through `applyAndRefresh`, so that is
// the one place the URL is written, and it is written with `replaceState`:
// `location.hash = …` would fire `hashchange`, re-enter `route()` and redraw the
// page under the control somebody is still using. It also keeps the back button
// meaning "the page before this one" rather than "the last checkbox I ticked".

/** The route, with any screen stripped off it. */
const hashPath = () => {
  const raw = location.hash.slice(1) || '/';
  const cut = raw.indexOf('?');
  return cut === -1 ? raw : raw.slice(0, cut);
};

/** The screen, as it appears in the hash. '' when there is none. */
const hashQuery = () => {
  const raw = location.hash.slice(1);
  const cut = raw.indexOf('?');
  return cut === -1 ? '' : raw.slice(cut + 1);
};

/**
 * A link to one of the list pages carrying the screen currently in force.
 *
 * The nav, the sub-nav and every back link use it, so moving between the fund
 * list, the favourites and a fund page does not silently drop a filter set —
 * and the link somebody copies out of the address bar is the same link the page
 * links to itself with.
 */
function listHref(route) {
  const q = encodeScreen(state);
  return `#${route}${q ? `?${q}` : ''}`;
}

/**
 * Arrive at a list page, taking the screen from the hash.
 *
 * The URL is the truth on entry: whatever is in it wins, and a route with no
 * screen on it is a request for an unfiltered list. That is what makes a link
 * mean the same thing for the person who receives it as for the person who sent
 * it, and it is only sound because every link the site draws to these pages
 * carries the screen already.
 */
function enterList(page) {
  const screen = decodeScreen(hashQuery());
  state.filters = screen.filters;
  state.prefs = screen.prefs;
  state.sort = screen.sort;
  syncSearchInput();
  renderList(page);
  // Write it straight back, so the address bar always describes the list that is
  // actually on screen. A link carrying `risk=99` shows every fund, and leaving
  // that parameter sitting in the URL would be the page claiming a filter it
  // refused to apply.
  syncScreenUrl();
}

/** Write the screen back into the hash, without re-routing the page. */
function syncScreenUrl() {
  if (state.page !== 'list' && state.page !== 'favs') return;
  const q = encodeScreen(state);
  const next = `#${state.page === 'favs' ? '/favoriler' : '/fonlar'}${q ? `?${q}` : ''}`;
  if (next === location.hash) return;
  history.replaceState(null, '', next);
  syncSavedScreens();
}

// ---------------------------------------------------------- saved screens
//
// A screen that lives in the URL can be bookmarked, which is most of the value.
// The rest is not having to: the four or five questions somebody actually asks
// this site are asked over and over, and retyping six controls each time is what
// stops anybody from asking the sixth.
//
// Stored as the encoded query rather than as a parsed object, so a saved screen
// and a pasted link are the same thing and go through the same validation on the
// way back in. Local to the browser, like the favourites.

const SCREENS_KEY = 'fh-screens';

/** How many a person can keep before the chip row stops being a row. */
const MAX_SCREENS = 12;

/** The saved screens, or an empty list — a corrupt value must not break the page. */
function savedScreens() {
  const raw = readStored(SCREENS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s) => s && typeof s.n === 'string' && typeof s.q === 'string' && s.n.trim())
    .slice(0, MAX_SCREENS);
}

const saveScreens = (list) => writeStored(SCREENS_KEY, list);

/** The bar, while a list page is drawn. Null otherwise. */
let screensBar = null;

/**
 * The saved screens, and the two things you can do with the one on screen.
 *
 * Built once per list render: the name field holds a caret, so the chips are the
 * only part that gets replaced when a screen is added, applied or removed.
 */
function renderScreens() {
  const chips = h('ul', { class: 'screen-chips' });

  const name = h('input', {
    type: 'text', class: 'port-input screen-name', maxlength: '40',
    placeholder: T('screenName'), 'aria-label': T('screenName'),
  });

  const save = () => {
    const label = name.value.trim();
    if (!label) { name.focus(); return; }
    const q = encodeScreen(state);
    const list = savedScreens().filter((s) => s.n !== label);
    // Newest first, and re-saving a name replaces it rather than making a second
    // chip that reads the same and does something else.
    list.unshift({ n: label, q });
    saveScreens(list.slice(0, MAX_SCREENS));
    name.value = '';
    refresh();
  };

  const copy = h('button', {
    type: 'button', class: 'control screen-copy',
    onClick: async () => {
      const url = `${location.origin}${location.pathname}${listHref(
        state.page === 'favs' ? '/favoriler' : '/fonlar')}`;
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = T('screenCopied');
        setTimeout(() => { copy.textContent = T('screenCopy'); }, 1600);
      } catch {
        // Denied clipboard permission, or an insecure origin. The address bar
        // already holds the link, so there is nothing to fall back to and
        // nothing worth interrupting anybody over.
      }
    },
  }, T('screenCopy'));

  const form = h('form', {
    class: 'screen-form',
    onSubmit: (e) => { e.preventDefault(); save(); },
  }, name, h('button', { type: 'submit', class: 'control' }, T('screenSave')), copy);

  function refresh() {
    const here = encodeScreen(state);
    chips.replaceChildren(...savedScreens().map((s) => h('li', {},
      h('button', {
        type: 'button',
        class: `screen-chip${s.q === here ? ' is-on' : ''}`,
        'aria-pressed': String(s.q === here),
        onClick: () => {
          const screen = decodeScreen(s.q);
          state.filters = screen.filters;
          state.prefs = screen.prefs;
          state.sort = screen.sort;
          // A whole screen changing means every control is now showing the wrong
          // value, so this is the one case that redraws the page rather than
          // refreshing the results under the controls.
          syncSearchInput();
          renderList();
          syncScreenUrl();
        },
      }, s.n),
      h('button', {
        type: 'button', class: 'screen-x',
        'aria-label': `${T('screenDelete')}: ${s.n}`,
        onClick: () => {
          saveScreens(savedScreens().filter((x) => x.n !== s.n));
          refresh();
        },
      }, '×')
    )));
  }

  refresh();
  screensBar = { refresh };
  return h('div', { class: 'screens' }, chips, form);
}

/** Re-mark which saved screen, if any, is the one on screen. */
const syncSavedScreens = () => screensBar?.refresh();

function renderFavHead() {
  // Count only favourites that still resolve to something: a code saved before
  // a fund was delisted would otherwise make the heading disagree with the
  // table. Shares are counted by code shape, because the index they are named in
  // may not have arrived yet.
  const funds = state.funds.reduce((n, f) => n + (state.favs.has(f.c) ? 1 : 0), 0);
  const listings = [...state.favs].filter(isShareCode).length;
  return h('section', { class: 'page-head' },
    h('p', { class: 'eyebrow' }, listings
      ? T('favoritesCountBoth', {
        f: fmtInt(funds, state.lang), s: fmtInt(listings, state.lang),
      })
      : T('favoritesCount', { n: fmtInt(funds, state.lang) })),
    h('h1', { class: 'page-title' }, T('favorites')),
    h('p', { class: 'page-lede' }, T('favoritesHint'))
  );
}

/**
 * The shares you have starred, under the funds you have starred.
 *
 * A panel of its own rather than rows in the fund table. They share a favourites
 * list and nothing else: a fund has a NAV, an expense ratio and a risk band; a
 * share has a price, a P/E and a market value. One table carrying both would be
 * half empty on every row.
 *
 * The index is 450KB, so it is fetched only when there is a starred share to
 * name — someone who only follows funds never loads it.
 */
function renderFavShares(codes) {
  const body = h('tbody', {});
  const panel = h('section', { class: 'panel fav-shares' },
    h('div', { class: 'dash-pane-head' },
      h('h2', {}, T('favouriteShares')),
      h('a', { class: 'dash-more', href: '#/hisseler' }, T('dashMore'))),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'funds share-table' },
        h('thead', {},
          h('tr', {},
            h('th', { class: 'col-fav', 'aria-label': T('favorites') }, '★'),
            h('th', { class: 'col-code cell-code' }, T('code')),
            h('th', { class: 'col-name cell-name' }, T('company')),
            SHARE_COLUMNS.map((col) =>
              h('th', { class: 'col-figure num-cell' }, T(col.labelKey))))),
        body)));

  const draw = () => {
    if (state.page !== 'favs') return;
    const rows = (shares?.list ?? []).filter((s) => state.favs.has(s.c));
    // Unstarring the last one leaves the page rather than an empty table with a
    // heading over it.
    if (!rows.length) return renderList('favs');
    body.replaceChildren(...rows.map((stock) => shareRow(stock, draw)));
  };

  loadShares().then(() => {
    if (state.page !== 'favs') return;
    draw();
    // Same single scan as everywhere else, so the prices here and on the share
    // list are the same prices.
    ensureQuotes(null).then(draw);
  });

  // A code saved before a listing was delisted still counts here, and the table
  // simply has one row fewer than the star count — the same rule the fund half
  // has always followed.
  body.replaceChildren(h('tr', {},
    h('td', { colspan: String(SHARE_COLUMNS.length + 3) },
      h('span', { class: 'panel-note' }, T('loading')))));
  return panel;
}

const emptyFavs = () =>
  h('div', { class: 'state-msg' },
    h('p', {}, T('favoritesEmpty')),
    h('a', { class: 'back-link', href: listHref('/fonlar') }, `← ${T('navFunds')}`));

function applyFilters() {
  // Scores depend on tax/horizon preferences, so they are recomputed here rather
  // than stored in the data file. `_score` is transient view state.
  const ctx = scoringContext();
  for (const f of state.funds) f._score = scoreFund(f, ctx);

  const filtered = filterFunds(state.funds, {
    ...state.filters,
    ...riskFilters(),
    codes: state.page === 'favs' ? [...state.favs] : undefined,
  });
  state.results = sortFunds(filtered, state.sort.key, state.sort.dir);
  state.visible = PAGE_SIZE;
}

const riskFilters = () => ({
  maxRisk: state.prefs.maxRisk,
  beatsCash: state.prefs.beatsCash,
  retailOnly: state.prefs.retailOnly,
  tradeableOnly: state.prefs.tradeableOnly,
  onlyNew: state.prefs.onlyNew,
  stance: state.prefs.stance || undefined,
  maxFee: state.prefs.maxFee,
  levered: state.prefs.levered,
  crashProof: state.prefs.crashProof,
  minDividend: state.prefs.minDividend,
  // Kept as the raw control value and read as one of two things: the string
  // "none", or a threshold in per cent. The empty string is no filter at all.
  speculative: state.prefs.speculative === SPEC_NONE
    ? SPEC_NONE
    : (state.prefs.speculative ? Number(state.prefs.speculative) : null),
});

/**
 * A short rail of funds people are actually buying, with their prices.
 *
 * Ranked on 30-day net inflow rather than size, so it changes week to week and
 * answers "what is moving" instead of restating the same ten giants. The
 * composition bar rides along the bottom edge of each tile — the one thing this
 * site shows that a price screen does not.
 */
function renderHighlights() {
  const groupIds = state.meta.groups.map((g) => g.id);
  const picks = popularPool()
    .filter((f) => f.fl30 != null && f.fl30 > 0 && f.p != null)
    .sort((a, b) => b.fl30 - a.fl30)
    .slice(0, 6);
  if (!picks.length) return null;

  return h('section', { class: 'highlights' },
    h('div', { class: 'section-head' },
      h('h2', {}, T('highlights')),
      h('p', { class: 'section-note', title: T('popularRiskNote', { n: POPULAR_MIN_RISK }) },
        `${T('highlightsNote')} · ${T('popularRiskShort', { n: POPULAR_MIN_RISK })}`),
      h('a', { class: 'section-link', href: '#/populer' }, `${T('seeAll')} →`)
    ),
    h('div', { class: 'tile-rail' },
      picks.map((f) => {
        const { segments } = compositionSegments(f.g, groupIds);
        return h('a', { class: 'fund-tile', href: `#/fon/${f.c}` },
          h('span', { class: 'tile-top' },
            h('span', { class: 'tile-code num' }, f.c),
            h('span', { class: `delta ${signOf(f.ch)}` },
              fmtPct(f.ch, state.lang, { signed: true, digits: 2 }))
          ),
          h('span', { class: 'tile-name', title: f.n }, f.n),
          h('span', { class: 'tile-price num' }, `₺${fmtNum(f.p, state.lang, 4)}`),
          compBar(segments, 'tile-comp')
        );
      })
    )
  );
}

/**
 * Which filters are currently narrowing the list.
 *
 * Once the controls are behind a button, this is the only thing standing between
 * the user and a list quietly filtered by something they forgot they set — so
 * every active filter gets a named, removable chip.
 */
function activeFilters() {
  const f = state.filters;
  const p = state.prefs;
  const out = [];
  const add = (label, clear) => out.push({ label, clear });

  if (f.search) add(`"${f.search}"`, () => { f.search = ''; syncSearchInput(); });
  for (const id of f.kinds ?? []) {
    add(label(state.meta.kinds.find((k) => k.id === id), state.lang),
      () => { f.kinds = f.kinds.filter((x) => x !== id); });
  }
  for (const cat of f.categories ?? []) {
    add(label(state.meta.categories.find((c) => c.tr === cat), state.lang) || cat,
      () => { f.categories = f.categories.filter((x) => x !== cat); });
  }
  for (const founder of f.founders ?? []) {
    add(founder, () => { f.founders = f.founders.filter((x) => x !== founder); });
  }
  if (f.exposure) {
    add(`${T('exposure')}: ${label(state.meta.groups.find((g) => g.id === f.exposure), state.lang)}`,
      () => { f.exposure = undefined; });
  }
  if (f.theme) {
    // The share is in the chip because it is a real part of the question: "in
    // defence" means something different at 5% than at 50%.
    add(`${themeName(f.theme)} ${T('themeShareOf', { n: fmtNum(f.minTheme ?? MIN_THEME, state.lang, 0) })}`,
      () => { f.theme = undefined; });
  }
  if (p.maxRisk != null) add(T('riskUpTo', { n: p.maxRisk }), () => { p.maxRisk = null; });
  if (p.stance) {
    add(T(`stance${p.stance[0].toUpperCase()}${p.stance.slice(1)}`), () => { p.stance = ''; });
  }
  if (p.maxFee != null) {
    add(T('feeUpTo', { n: fmtNum(p.maxFee, state.lang, p.maxFee % 1 ? 1 : 0) }),
      () => { p.maxFee = null; });
  }
  if (p.beatsCash) add(T('onlyBeatsCash'), () => { p.beatsCash = false; });
  if (p.onlyNew) add(T('onlyNewFunds'), () => { p.onlyNew = false; });
  if (p.levered) add(T('onlyLevered'), () => { p.levered = false; });
  if (p.crashProof) add(T('onlyCrashProof'), () => { p.crashProof = false; });
  if (p.minDividend != null) {
    add(`${T('dividendLabel')}: ${T('dividendAtLeast', { n: fmtNum(p.minDividend, state.lang, 1) })}`,
      () => { p.minDividend = null; });
  }
  if (p.speculative) {
    add(p.speculative === SPEC_NONE
      ? T('specFilterNoneChip')
      : `${T('specFilter')}: ${T('specFilterAtLeast', { n: p.speculative })}`,
    () => { p.speculative = ''; });
  }
  if (p.retailOnly) add(T('hideQualified'), () => { p.retailOnly = false; });
  if (p.tradeableOnly) add(T('tradeableOnly'), () => { p.tradeableOnly = false; });
  return out;
}

function renderActiveChips() {
  const active = activeFilters();
  return h('ul', { class: 'active-chips', id: 'active-chips' },
    active.map((a) =>
      h('li', {},
        h('button', {
          type: 'button', class: 'active-chip',
          'aria-label': `${T('reset')}: ${a.label}`,
          onClick: () => { a.clear(); applyAndRefresh(); },
        }, a.label, h('span', { class: 'chip-x', 'aria-hidden': 'true' }, '×'))
      )
    ),
    active.length > 1
      ? h('li', {},
          h('button', { type: 'button', class: 'chip-clear', onClick: () => { resetFilters(); } },
            T('clearAll')))
      : null
  );
}

function resetFilters() {
  const base = defaultScreen();
  state.filters = base.filters;
  // Only the filtering preferences. The window and the tax treatment are how the
  // list is READ rather than what it is narrowed to, and clearing a filter chip
  // has no business resetting either — which is what SCREEN_FILTER_PREFS names.
  for (const key of SCREEN_FILTER_PREFS) state.prefs[key] = base.prefs[key];
  syncSearchInput();
  renderList();
  syncScreenUrl();
}

/** Result count, sort, and the filter disclosure. Sticky above the table. */
function renderToolbar() {
  const n = activeFilters().length;
  const panel = h('div', { class: 'filter-panel', id: 'filter-panel', hidden: !state.filtersOpen },
    renderScreens(), renderFilters(), renderPrefs());

  const toggle = h('button', {
    type: 'button', class: 'filter-btn', 'aria-expanded': String(!!state.filtersOpen),
    'aria-controls': 'filter-panel',
    onClick: () => {
      state.filtersOpen = !state.filtersOpen;
      panel.hidden = !state.filtersOpen;
      toggle.setAttribute('aria-expanded', String(!!state.filtersOpen));
      measureChrome();
    },
  },
    h('span', { class: 'filter-icon', 'aria-hidden': 'true' }),
    T('filterButton'),
    h('span', { class: 'filter-badge', id: 'filter-badge', hidden: !n }, n ? String(n) : '')
  );

  // The list's own search, beside the filters it belongs with. The masthead
  // field searches everything and takes you to a page; this one narrows the
  // table you are already looking at. Built once with the toolbar — a redraw on
  // every keystroke would take the caret out of it — so `applyAndRefresh`, which
  // deliberately leaves the toolbar alone, is what typing calls.
  const search = h('input', {
    type: 'search', class: 'list-search', id: 'list-search', value: state.filters.search,
    placeholder: T('searchFunds'), 'aria-label': T('searchFunds'),
    onInput: debounce((e) => {
      state.filters.search = e.target.value;
      syncSearchInput();
      applyAndRefresh();
    }, 150),
  });

  return h('section', { class: 'toolbar' },
    h('div', { class: 'toolbar-row' },
      toggle,
      search,
      renderActiveChips(),
      h('div', { class: 'compare-slot', id: 'compare-slot' }, compareBar()),
      h('span', { class: 'result-count', id: 'result-count', 'aria-live': 'polite' },
        T('showing', { n: fmtInt(state.results.length, state.lang) })),
      h('label', { class: 'sort-field' },
        h('span', {}, T('sort')),
        h('select', {
          onChange: (e) => {
            const [key, dir] = e.target.value.split(':');
            state.sort = { key, dir };
            applyAndRefresh();
          },
        },
          [
            ['size:desc', T('sortSize')],
            ['ratio:desc', T('sortRatio')],
            ['excess:desc', T('sortExcess')],
            ...HORIZONS.map((hz) => [`${hz.sortKey}:desc`, T(sortKeyString(hz.sortKey))]),
            ['crash:desc', T('sortCrash')],
            ['dividend:desc', T('sortDividend')],
            ['fee:asc', T('sortFee')],
            ['investors:desc', T('sortInvestors')],
            ['flow30:desc', T('sortFlow30')],
            ['investors30:desc', T('sortInvestors30')],
            ['risk:asc', T('sortRisk')],
            ['name:asc', T('sortName')],
          ].map(([v, text]) =>
            h('option', { value: v, selected: `${state.sort.key}:${state.sort.dir}` === v }, text))
        )
      )
    ),
    panel
  );
}

/** The recurring unit: a stacked proportion bar. */
function compBar(segments, className) {
  const m = state.meta;
  return h('div', { class: className, role: 'img',
    'aria-label': segments
      .map((s) => `${label(m.groups.find((g) => g.id === s.id), state.lang)} ${fmtPct(s.pct, state.lang, { digits: 1 })}`)
      .join(', ') },
    segments.map((s) =>
      h('span', {
        style: `flex:0 0 ${s.share}%;background:${groupColor(s.id)}`,
        title: `${label(m.groups.find((g) => g.id === s.id), state.lang)} — ${fmtPct(s.pct, state.lang, { digits: 1 })}`,
      })
    )
  );
}

const sortKeyString = (key) => `sort${key[0].toUpperCase()}${key.slice(1)}`;

function renderFilters() {
  const m = state.meta;
  const f = state.filters;

  const select = (key, labelText, options, current) =>
    h('div', { class: 'field' },
      h('label', { for: `f-${key}` }, labelText),
      h('select', {
        id: `f-${key}`,
        onChange: (e) => {
          state.filters[key] = e.target.value ? [e.target.value] : [];
          applyAndRefresh();
        },
      },
        h('option', { value: '' }, T('all')),
        options.map((o) =>
          h('option', { value: o.value, selected: current[0] === o.value }, o.text)
        )
      )
    );

  return h('div', { class: 'filters' },
    select('kinds', T('kind'), m.kinds.map((k) => ({ value: k.id, text: label(k, state.lang) })), f.kinds),
    select('categories', T('category'),
      m.categories.map((c) => ({ value: c.tr, text: label(c, state.lang) })), f.categories),
    select('founders', T('founder'), m.founders.map((x) => ({ value: x, text: x })), f.founders),
    // "Funds that are mostly equity" is the question this dataset is for, so it
    // gets a control rather than leaving the capability buried in core.js.
    h('div', { class: 'field' },
      h('label', { for: 'f-exposure' }, T('exposure')),
      h('select', {
        id: 'f-exposure',
        title: `${T('exposure')} — ${T('exposureHint')}`,
        onChange: (e) => {
          state.filters.exposure = e.target.value || undefined;
          state.filters.minExposure = 50;
          applyAndRefresh();
        },
      },
        h('option', { value: '' }, T('all')),
        m.groups.map((g) =>
          h('option', { value: g.id, selected: f.exposure === g.id }, label(g, state.lang)))
      )
    ),
    // Lines of business, from the individual holdings rather than the asset
    // classes — a different question about the same fund, so a separate control.
    h('div', { class: 'field' },
      h('label', { for: 'f-theme' }, T('themeLabel')),
      h('select', {
        id: 'f-theme',
        title: `${T('themeLabel')} — ${T('themeHint')}`,
        onChange: (e) => {
          state.filters.theme = e.target.value || undefined;
          const share = document.getElementById('f-theme-share');
          if (share) share.disabled = !state.filters.theme;
          applyAndRefresh();
        },
      },
        h('option', { value: '' }, T('all')),
        themeOrder().map((id) =>
          h('option', { value: id, selected: f.theme === id }, themeName(id)))
      )
    ),
    // Always in the panel, disabled until a theme is picked. Rendering it
    // conditionally looked tidier and did not work: changing a filter refreshes
    // the chips and the results but deliberately leaves the panel alone, so that
    // focus stays on the control under your hand — and the select would never
    // have appeared.
    h('div', { class: 'field' },
      h('label', { for: 'f-theme-share' }, T('themeShare')),
      h('select', {
        id: 'f-theme-share',
        disabled: !f.theme,
        onChange: (e) => {
          state.filters.minTheme = Number(e.target.value);
          applyAndRefresh();
        },
      },
        [5, 10, 25, 50].map((n) =>
          h('option', { value: n, selected: (f.minTheme ?? MIN_THEME) === n },
            T('themeShareOf', { n: fmtNum(n, state.lang, 0) })))
      )
    )
  );
}

/**
 * Preference strip: risk tolerance, horizon and withholding.
 *
 * These drive the ranking rather than just hiding rows, which is the point of
 * the app — "worth buying" depends on who is asking.
 */
function renderPrefs() {
  const p = state.prefs;
  // The hurdle quoted must be the one actually used, over the chosen window.
  const hz = horizonOf(p.horizon);
  const cash = cashReturnFor(scoringContext(), hz.key);

  const pick = (id, labelText, options, current, onPick, note = null) =>
    h('div', { class: 'field' },
      noted('label', { for: `p-${id}` }, labelText, note),
      h('select', {
        id: `p-${id}`,
        onChange: (e) => {
          onPick(e.target.value);
          applyAndRefresh();
        },
      },
        options.map(([value, text]) =>
          h('option', { value, selected: String(current) === String(value) }, text))
      )
    );

  return h('div', { class: 'prefs' },
    h('p', { class: 'eyebrow prefs-title' }, T('prefs')),
    h('div', { class: 'prefs-row' },
      pick('risk', T('riskTolerance'),
        [['', T('all')], ...[2, 3, 4, 5, 6, 7].map((n) => [n, T('riskUpTo', { n })])],
        p.maxRisk ?? '', (v) => { p.maxRisk = v ? Number(v) : null; }),

      // The horizon drives the return column, the money-market hurdle and the
      // ranking together — picking one and seeing the table unchanged would be a lie.
      pick('horizon', T('horizon'),
        HORIZONS.map((hz) => [hz.key, T(hz.labelKey)]),
        p.horizon, (v) => { p.horizon = v; }),

      // Two rates exist and nothing in between, so the override offers those and
      // not a made-up ladder of percentages.
      pick('tax', T('taxPref'),
        [['default', T('taxDefault')], ['0', T('taxNone')], ['0.175', '%17,5']],
        p.tax, (v) => { p.tax = v; }, T('taxPrefNote')),

      pick('stance', T('stanceLabel'),
        [['', T('all')], ['aggressive', T('stanceAggressive')],
          ['balanced', T('stanceBalanced')], ['defensive', T('stanceDefensive')]],
        p.stance, (v) => { p.stance = v; }),

      pick('fee', T('maxFeeLabel'),
        [['', T('all')], ...[0.5, 1, 1.5, 2, 3].map((n) =>
          [n, T('feeUpTo', { n: fmtNum(n, state.lang, n % 1 ? 1 : 0) })])],
        p.maxFee ?? '', (v) => { p.maxFee = v ? Number(v) : null; }),

      // The index's own yield is offered as one of the steps, since "more than
      // the market pays" is the only threshold here that is not a taste.
      pick('dividend', T('dividendLabel'),
        [['', T('all')], ...dividendSteps().map((n) =>
          [n, T('dividendAtLeast', { n: fmtNum(n, state.lang, n % 1 ? 2 : 0) })])],
        p.minDividend ?? '', (v) => { p.minDividend = v ? Number(v) : null; }),

      // Both directions in one control, because they are one question. Placed
      // beside the dividend picker, the other one that can only answer for funds
      // whose filing could be read.
      pick('speculative', T('specFilter'),
        [['', T('all')], [SPEC_NONE, T('specFilterNone')],
          ...SPEC_STEPS.map((n) => [n, T('specFilterAtLeast', { n })])],
        p.speculative ?? '', (v) => { p.speculative = v; }, T('specFilterNote')),

      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', checked: p.beatsCash,
          onChange: (e) => { p.beatsCash = e.target.checked; applyAndRefresh(); },
        }),
        h('span', {}, T('onlyBeatsCash'))
      ),
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', checked: p.onlyNew,
          onChange: (e) => { p.onlyNew = e.target.checked; applyAndRefresh(); },
        }),
        h('span', {}, T('onlyNewFunds'))
      ),
      h('label', { class: 'check', title: T('leverageNote') },
        h('input', {
          type: 'checkbox', checked: p.levered,
          onChange: (e) => { p.levered = e.target.checked; applyAndRefresh(); },
        }),
        h('span', {}, T('onlyLevered'))
      ),
      h('label', { class: 'check', title: T('onlyCrashProofNote') },
        h('input', {
          type: 'checkbox', checked: p.crashProof,
          onChange: (e) => { p.crashProof = e.target.checked; applyAndRefresh(); },
        }),
        h('span', {}, T('onlyCrashProof'))
      ),
      h('label', { class: 'check', title: T('qualifiedNote') },
        h('input', {
          type: 'checkbox', checked: p.retailOnly,
          onChange: (e) => { p.retailOnly = e.target.checked; applyAndRefresh(); },
        }),
        h('span', {}, T('hideQualified'))
      ),
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', checked: p.tradeableOnly,
          onChange: (e) => { p.tradeableOnly = e.target.checked; applyAndRefresh(); },
        }),
        h('span', {}, T('tradeableOnly'))
      )
    ),
    h('p', { class: 'prefs-note' },
      cash != null
        ? T('cashHurdle', { period: T(hz.labelKey), n: fmtNum(cash, state.lang, 1) })
        : T('cashHurdleUnknown'))
  );
}

function refreshResults() {
  const count = document.getElementById('result-count');
  if (count) count.textContent = T('showing', { n: fmtInt(state.results.length, state.lang) });
  const wrap = document.getElementById('table-wrap');
  if (wrap) wrap.replaceWith(renderTable());
}

/**
 * The table's columns, named once so the header and the body cannot drift apart.
 *
 * Widths live in the stylesheet against these classes, and the table is
 * `table-layout: fixed` — otherwise `overflow-x: auto` lets it lay itself out at
 * max-content and no column ever shrinks, which is what made the list scroll
 * sideways at every viewport width.
 */
/**
 * Whether the list is currently ranked on crash protection.
 *
 * Sorting a table on a figure it does not print makes the order look arbitrary,
 * so the vs-cash column gives way to the crash figure while that is what the
 * ranking is. A swap rather than a twelfth column: the row is already as wide as
 * it fits, and adding to it is what made it scroll sideways before.
 */
const crashRanked = () => state.sort.key === 'crash';

const COL = {
  fav: 'col-fav',
  code: 'col-code cell-code',
  name: 'col-name cell-name',
  size: 'col-size num-cell',
  inv: 'col-inv num-cell col-optional',
  ret2: 'col-ret num-cell col-optional',
  ret1: 'col-ret num-cell col-primary',
  excess: 'col-excess num-cell',
  fee: 'col-fee num-cell col-optional',
  risk: 'col-risk num-cell',
  comp: 'col-comp',
};

function renderTable() {
  if (!state.results.length) {
    return h('div', { class: 'table-wrap', id: 'table-wrap' },
      h('div', { class: 'state-msg' },
        h('p', {}, T('noResults')),
        h('p', { class: 'colophon-note' }, T('noResultsHint'))
      )
    );
  }

  const { primary, secondary } = returnColumns();
  const body = h('tbody', {});
  const wrap = h('div', { class: 'table-wrap', id: 'table-wrap' },
    h('table', { class: 'funds' },
      h('thead', {},
        h('tr', {},
          h('th', { class: COL.fav, 'aria-label': T('favorites') }, '★'),
          h('th', { class: COL.code }, T('code')),
          h('th', { class: COL.name }, T('name')),
          h('th', { class: COL.size }, T('size')),
          h('th', { class: COL.inv }, T('investors')),
          h('th', { class: COL.ret2 }, T(secondary.labelKey)),
          // The horizon column is marked so it is visibly the one being ranked on.
          h('th', { class: COL.ret1 }, T(primary.labelKey)),
          crashRanked()
            ? h('th', { class: COL.excess, title: T('crashSparedNote') }, T('crashSpared'))
            : h('th', { class: COL.excess, title: T('vsCashNote') }, T('vsCash')),
          h('th', { class: COL.fee }, T('expenseRatio')),
          h('th', { class: COL.risk }, T('riskLevel')),
          h('th', { class: COL.comp }, T('composition'))
        )
      ),
      body
    )
  );

  appendRows(body);

  // Infinite scroll keeps 2,400+ rows from all hitting the DOM at once.
  const sentinel = h('div', { style: 'height:1px' });
  wrap.append(sentinel);
  const io = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting) return;
    if (state.visible >= state.results.length) { io.disconnect(); return; }
    state.visible += PAGE_SIZE;
    appendRows(body);
  }, { rootMargin: '400px' });
  io.observe(sentinel);

  return wrap;
}

function appendRows(body) {
  const groupIds = state.meta.groups.map((g) => g.id);
  const { primary, secondary } = returnColumns();
  const rows = state.results.slice(body.childElementCount, state.visible);
  // On the favourites page, un-starring must remove the row rather than leave a
  // fund on a list it is no longer on.
  const onToggle = state.page === 'favs' ? () => renderList() : null;
  for (const f of rows) {
    const { segments } = compositionSegments(f.g, groupIds);
    body.append(
      h('tr', {},
        h('td', { class: COL.fav },
          favButton(f.c, onToggle),
          compareButton(f.c, syncCompareBar)),
        h('td', { class: COL.code }, h('a', { href: `#/fon/${f.c}` }, f.c)),
        h('td', { class: COL.name },
          h('a', { class: 'fund-name', href: `#/fon/${f.c}`, title: f.n }, f.n),
          h('span', { class: 'fund-meta' }, `${f.f} · ${label(catOf(f), state.lang)}`)
        ),
        // `data-label` is what the card layout on narrow screens prints above each
        // value, once there is no header row left to read them against.
        h('td', { class: `${COL.size} num`, dataset: { label: T('size') } },
          fmtMoney(f.sz, state.lang)),
        h('td', { class: `${COL.inv} num` }, fmtInt(f.iv, state.lang)),
        deltaCell(f.r?.[secondary.key], COL.ret2),
        deltaCell(f.r?.[primary.key], COL.ret1, T(primary.labelKey)),
        crashRanked()
          ? h('td', { class: COL.excess, dataset: { label: T('crashSpared') } },
              sparedCell(f.cr?.s))
          // A gap between two returns is measured in points, not per cent.
          : h('td', { class: COL.excess, dataset: { label: T('vsCash') } },
              h('span', { class: `delta ${signOf(f._score?.excess)}` },
                fmtPoints(f._score?.excess, state.lang, { signed: true, digits: 1 }))),
        h('td', { class: `${COL.fee} num` },
          f.expenseRatio == null ? '—' : fmtPct(f.expenseRatio, state.lang, { digits: 2 })),
        h('td', { class: COL.risk }, riskChip(f)),
        h('td', { class: COL.comp }, compBar(segments, 'mini-comp'))
      )
    );
  }
}

const catOf = (f) => state.meta.categories.find((c) => c.tr === f.cat) ?? { tr: f.cat ?? '—' };

/**
 * Whether the fund is actually buyable. An unknown status says so rather than
 * implying either answer.
 */
function platformChip(fund) {
  if (fund.tefas == null) {
    return h('li', { class: 'chip', title: T('platformStatus') }, T('platformUnknown'));
  }
  const key = fund.tefas ? 'tefasTraded' : 'tefasNotTraded';
  return h('li', {
    class: `chip ${fund.tefas ? 'chip-ok' : 'chip-warn'}`,
    title: T('platformStatus'),
  }, T(key));
}

const deltaCell = (v, cls = 'num-cell', dataLabel = null) =>
  h('td', {
    class: cls,
    dataset: dataLabel ? { label: dataLabel } : undefined,
  }, h('span', { class: `delta ${signOf(v)}` }, fmtPct(v, state.lang, { signed: true, digits: 1 })));

/**
 * TEFAS's official risk value, 1–7. The number carries the meaning; the colour
 * only reinforces it, so a monochrome or colour-blind reader loses nothing.
 * A 7 is marked because it restricts the fund to qualified investors.
 */
function riskChip(fund) {
  if (fund.risk == null) return h('span', { class: 'delta flat' }, '—');
  const qualified = requiresQualifiedInvestor(fund);
  const parts = [`${T('riskLevelOfficial')}: ${fund.risk}/7`];
  if (fund.vol != null) parts.push(`${T('volatility')} ${fmtPct(fund.vol, state.lang, { digits: 1 })}`);
  if (qualified) parts.push(T('qualifiedOnly'));
  return h('span', { class: 'risk-cell' },
    h('span', { class: `risk-chip risk-${fund.risk}`, title: parts.join(' · ') }, String(fund.risk)),
    qualified ? h('span', { class: 'nq-mark', title: T('qualifiedNote') }, 'NY') : null
  );
}

// ---------------------------------------------------------------- popular view

/**
 * What people are actually buying.
 *
 * Ranked on net flow rather than growth in size, because a fund whose size rose
 * purely because its price rose took in nothing. The note says as much: this is
 * a measure of attention, not of quality, and the two are frequently opposites.
 */
function renderPopular() {
  const pool = popularPool();

  const withFlow = pool
    .filter((f) => f.fl30 != null && f.fl30 > 0)
    .sort((a, b) => b.fl30 - a.fl30)
    .slice(0, RANK_SIZE);

  const withInvestors = pool
    .filter((f) => f.iv30 != null && f.iv30 > 0)
    .sort((a, b) => b.iv30 - a.iv30)
    .slice(0, RANK_SIZE);

  const newest = pool
    .filter((f) => f.new === true && f.age != null)
    .sort((a, b) => a.age - b.age)
    .slice(0, RANK_SIZE);

  view.replaceChildren(
    subNav('/populer'),
    h('section', { class: 'page-head' },
      h('p', { class: 'eyebrow' }, T('asOf', { date: fmtDate(state.meta.latestDate, state.lang) })),
      h('h1', { class: 'page-title' }, T('popular')),
      h('p', { class: 'page-lede' }, T('popularNote')),
      h('p', { class: 'page-lede' }, T('popularRiskNote', { n: POPULAR_MIN_RISK }))
    ),
    // The industry mix is market-level state, so it belongs on this page rather
    // than at the top of a list you came to filter.
    renderIndustry(),
    ranking('popularFlow', 'flowNote', withFlow, {
      header: T('flow30'),
      value: (f) => fmtMoney(f.fl30, state.lang),
      subHeader: T('shareOfSize'),
      // Absolute flow is dominated by the giants, so the relative figure sits
      // beside it: ₺2bn into a ₺200bn fund is not the same event as into a ₺2bn one.
      sub: (f) => (f.sz > 0 ? fmtPct((f.fl30 / f.sz) * 100, state.lang, { digits: 1 }) : '—'),
    }),
    ranking('popularInvestors', null, withInvestors, {
      header: T('investors30'),
      value: (f) => fmtInt(f.iv30, state.lang),
      subHeader: T('investors'),
      sub: (f) => fmtInt(f.iv, state.lang),
    }),
    ranking('popularNew', null, newest, {
      header: T('launched'),
      value: (f) => T('ageDays', { n: fmtInt(f.age, state.lang) }),
      subHeader: T('size'),
      sub: (f) => fmtMoney(f.sz, state.lang),
    })
  );
  window.scrollTo({ top: 0 });
}

/** What the whole industry holds, weighted by portfolio size. */
function renderIndustry() {
  const m = state.meta;
  const { segments, aum } = industryComposition(state.funds, m.groups.map((g) => g.id));
  if (!segments.length) return null;

  return h('section', { class: 'panel industry' },
    h('div', { class: 'industry-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, T('industryTotal')),
        h('p', { class: 'industry-figure num' }, fmtMoney(aum, state.lang))
      ),
      h('p', { class: 'panel-note' },
        T('fundsCounted', { n: fmtInt(state.funds.length, state.lang) }))
    ),
    compBar(segments, 'comp-bar'),
    h('ul', { class: 'comp-legend' },
      segments.map((s) =>
        h('li', {},
          h('span', { class: 'swatch', style: `background:${groupColor(s.id)}` }),
          h('span', {}, label(m.groups.find((g) => g.id === s.id), state.lang)),
          h('span', { class: 'val num' }, fmtPct(s.pct, state.lang, { digits: 1 }))))
    )
  );
}

function ranking(titleKey, noteKey, funds, spec) {
  const groupIds = state.meta.groups.map((g) => g.id);
  const { primary } = returnColumns();

  return h('section', { class: 'panel' },
    h('h2', {}, T(titleKey)),
    noteKey ? h('p', { class: 'panel-note' }, T(noteKey)) : null,
    funds.length
      ? h('div', { class: 'table-wrap table-flush' },
          h('table', { class: 'funds' },
            h('thead', {},
              h('tr', {},
                h('th', { class: 'col-rank num-cell' }, '#'),
                h('th', { class: COL.fav, 'aria-label': T('favorites') }, '★'),
                h('th', { class: COL.code }, T('code')),
                h('th', { class: COL.name }, T('name')),
                h('th', { class: 'col-metric num-cell' }, spec.header),
                h('th', { class: 'col-submetric num-cell col-optional' }, spec.subHeader),
                h('th', { class: COL.ret2 }, T(primary.labelKey)),
                h('th', { class: COL.risk }, T('riskLevel')),
                h('th', { class: `${COL.comp} col-optional` }, T('composition'))
              )
            ),
            h('tbody', {},
              funds.map((f, i) => {
                const { segments } = compositionSegments(f.g, groupIds);
                return h('tr', {},
                  h('td', { class: 'col-rank num-cell num' }, String(i + 1)),
                  h('td', { class: COL.fav }, favButton(f.c)),
                  h('td', { class: COL.code }, h('a', { href: `#/fon/${f.c}` }, f.c)),
                  h('td', { class: COL.name },
                    h('a', { class: 'fund-name', href: `#/fon/${f.c}`, title: f.n }, f.n),
                    h('span', { class: 'fund-meta' }, `${f.f} · ${label(catOf(f), state.lang)}`)),
                  h('td', { class: 'col-metric num-cell num', dataset: { label: spec.header } },
                    spec.value(f)),
                  h('td', { class: 'col-submetric num-cell num col-optional' }, spec.sub(f)),
                  deltaCell(f.r?.[primary.key], COL.ret2),
                  h('td', { class: COL.risk }, riskChip(f)),
                  h('td', { class: `${COL.comp} col-optional` }, compBar(segments, 'mini-comp'))
                );
              })
            )
          )
        )
      : h('p', { class: 'panel-note' }, T('noneYet'))
  );
}

// ---------------------------------------------------------------- themes & dividends
//
// The asset-class bar above says how much of the fund is in shares. This says
// which shares — the lines of business those companies are in, and what they pay
// in dividends. Both are read off the individual positions in the KAP filing, so
// both exist only for the funds whose filing could be read.

/** Theme ids the data actually carries, in the order core.js declares. */
const themeOrder = () => state.meta?.themes ?? THEME_IDS;

const themeName = (id) => T(`theme${id[0].toUpperCase()}${id.slice(1)}`);

/**
 * The yield thresholds the filter offers.
 *
 * The exchange's own yield is one of them, and it is the only step here that is
 * not somebody's taste: a fund yielding less than the index is not picking
 * dividend payers, whatever its name says. The rest are round numbers around it.
 */
function dividendSteps() {
  const market = state.meta?.marketYield;
  const steps = new Set([1, 2, 3, 4]);
  if (Number.isFinite(market) && market > 0) steps.add(market);
  return [...steps].sort((a, b) => a - b);
}

/**
 * The fund panel: what it pays first, then what it is in.
 *
 * Bars are scaled to the fund's largest theme rather than to 100, because the
 * question they answer is which line of business this fund leans on. The
 * percentage beside each is of the whole fund and is the figure that means
 * something; the bar is only there to make the order readable at a glance.
 */
function renderThemes(fund) {
  const themes = fund.th ?? {};
  const entries = themeOrder()
    .filter((id) => themes[id] != null)
    .map((id) => [id, themes[id]])
    .sort((a, b) => b[1] - a[1]);
  const dividend = fund.dy;
  if (!entries.length && dividend == null) {
    return h('section', { class: 'panel' },
      h('h2', {}, T('themeSection')),
      h('p', { class: 'panel-note' }, T('themeNone')));
  }

  const market = state.meta?.marketYield;
  const peak = entries[0]?.[1] ?? 1;
  const stat = (dt, dd, cls) =>
    h('div', { class: 'stat' }, h('dt', {}, dt), h('dd', { class: cls }, dd));

  return h('section', { class: 'panel' },
    h('h2', {}, T('themeSection')),
    dividend == null ? null : h('dl', { class: 'stat-row' },
      stat(T('dividendStat'), fmtPct(dividend, state.lang, { digits: 2 }),
        // Above the index's own yield is the only claim worth colouring: it is
        // what "picks dividend payers" actually means.
        market != null && dividend > market ? 'delta up' : null),
      stat(T('crashBench'), market == null ? '—' : fmtPct(market, state.lang, { digits: 2 }))
    ),
    dividend == null ? null : h('p', { class: 'panel-note' }, T('dividendNote')),
    entries.length
      ? h('ul', { class: 'theme-list' },
          entries.map(([id, weight]) =>
            h('li', {},
              h('span', { class: 'theme-name' }, themeName(id)),
              h('span', { class: 'theme-bar' },
                h('i', { style: `width:${Math.max(2, (weight / peak) * 100)}%` })),
              h('span', { class: 'theme-val num' }, fmtPct(weight, state.lang, { digits: 1 }))))
        )
      : null,
    entries.length ? h('p', { class: 'panel-note' }, T('themeNote')) : null
  );
}

// ---------------------------------------------------------------- crash protection
//
// How a fund behaved the last few times BIST fell, which is the one thing a
// return table cannot tell you. The episodes and the per-fund figures are built
// by scripts/fetch-crashes.mjs; see crashProtection() in analytics.js for what
// the number means and what it does not.

/** The falls the data was built against, or an empty list before it exists. */
const crashEpisodesOf = () => state.meta?.crashes ?? [];

/** How many days a fall lasted, as the reader counts them. */
const fallDays = (e) => Math.round((Date.parse(e.to) - Date.parse(e.from)) / 86400000);

/**
 * A fall's date range on one line. Both ends are market dates; the fund's own
 * prices are dated a business day later, which crashLagNote explains once per
 * page rather than on every row.
 */
const fallPeriod = (e) => `${fmtDate(e.from, state.lang)} – ${fmtDate(e.to, state.lang)}`;

/**
 * The protection figure, coloured on what it means rather than on its sign.
 *
 * The scale runs from below zero to well past 100, so signOf() would paint a
 * fund that avoided 2% of the fall the same green as one that avoided all of it.
 * The three bands that matter are: kept your money through the fall, took some
 * of the hit, and fell further than the index did. Above 100 is not an error —
 * it is a fund that gained while the market dropped.
 */
const sparedCell = (value) => {
  const tone = value == null ? 'flat'
    : value >= CRASH_PROOF_FROM ? 'up'
      : value < 0 ? 'down'
        : 'flat';
  return h('span', { class: `delta ${tone}` },
    value == null ? '—' : fmtPct(value, state.lang, { digits: 0 }));
};

/**
 * The fund-page panel: the headline figures, then every fall one row at a time
 * so the reader can check the number rather than take it.
 */
function renderCrash(fund) {
  const episodes = crashEpisodesOf();
  if (!episodes.length) return null;

  const cr = fund.cr;
  const stat = (dt, dd, cls) =>
    h('div', { class: 'stat' }, h('dt', {}, dt), h('dd', { class: cls }, dd));

  const head = [
    h('h2', {}, T('crashSection')),
    h('p', { class: 'panel-note' }, T('crashEyebrow', {
      n: fmtInt(episodes.length, state.lang),
      y: fmtInt(state.meta.crashYears ?? 3, state.lang),
    })),
  ];

  if (!cr) {
    return h('section', { class: 'panel crash' }, head,
      h('p', { class: 'panel-note' }, T('crashNotEnough')));
  }

  const rows = episodes.map((e, i) => {
    const ret = cr.e?.[i];
    const spared = crashSpared(e, ret);
    return h('tr', { class: ret == null ? 'is-absent' : null },
      h('td', { class: 'crash-period' },
        h('span', {}, fallPeriod(e)),
        h('span', { class: 'crash-days' }, T('crashDays', { n: fallDays(e) }))),
      h('td', { class: 'num-cell', dataset: { label: T('crashBench') } },
        h('span', { class: 'delta down' }, fmtPct(e.fall, state.lang, { digits: 1 }))),
      h('td', { class: 'num-cell', dataset: { label: T('crashThisFund') } },
        ret == null
          ? h('span', { class: 'delta flat' }, '—')
          : h('span', { class: `delta ${signOf(ret)}` },
              fmtPct(ret, state.lang, { signed: true, digits: 1 }))),
      h('td', { class: 'num-cell', dataset: { label: T('crashSpared') } }, sparedCell(spared))
    );
  });

  return h('section', { class: 'panel crash' }, head,
    h('dl', { class: 'stat-row' },
      stat(T('crashSpared'), sparedCell(cr.s)),
      stat(T('crashWorst'),
        fmtPct(cr.w, state.lang, { signed: true, digits: 1 }), `delta ${signOf(cr.w)}`),
      stat(T('crashCovered'), `${fmtInt(cr.n, state.lang)} / ${fmtInt(cr.of, state.lang)}`)
    ),
    h('p', { class: 'panel-note' }, T('crashSparedNote')),
    h('div', { class: 'table-wrap table-flush' },
      h('table', { class: 'funds crash-table' },
        h('thead', {},
          h('tr', {},
            h('th', {}, T('crashPeriod')),
            h('th', { class: 'num-cell' }, T('crashBench')),
            h('th', { class: 'num-cell' }, T('crashThisFund')),
            h('th', { class: 'num-cell' }, T('crashSpared'))
          )
        ),
        h('tbody', {}, rows)
      )
    ),
    cr.n < cr.of
      ? h('p', { class: 'panel-note' },
          T('crashCoveredNote', { n: fmtInt(cr.n, state.lang), of: fmtInt(cr.of, state.lang) }))
      : null,
    h('p', { class: 'panel-note' }, T('crashLagNote'))
  );
}

/**
 * The section page: what the falls were, then who came through them.
 *
 * Two rankings rather than one. The best-protected list is what the page is for,
 * but it is dominated by funds that simply were not in the market; the list of
 * funds that fell hardest sits beside it because that one is the warning, and it
 * is the harder of the two to find anywhere else.
 */
function renderCrashPage() {
  const episodes = crashEpisodesOf();
  const years = state.meta?.crashYears ?? 3;
  const pool = state.funds.filter((f) => f.cr && f.tefas === true);

  if (!episodes.length || !pool.length) {
    view.replaceChildren(
      subNav('/dusus'), h('div', { class: 'state-msg' }, h('p', {}, T('crashEmpty'))));
    return;
  }

  const ranked = [...pool].sort((a, b) => b.cr.s - a.cr.s);
  const spec = {
    header: T('crashSpared'),
    value: (f) => sparedCell(f.cr.s),
    subHeader: T('crashWorst'),
    sub: (f) => fmtPct(f.cr.w, state.lang, { signed: true, digits: 1 }),
  };

  view.replaceChildren(
    subNav('/dusus'),
    h('section', { class: 'page-head' },
      h('p', { class: 'eyebrow' }, T('crashEyebrow', {
        n: fmtInt(episodes.length, state.lang), y: fmtInt(years, state.lang),
      })),
      h('h1', { class: 'page-title' }, T('crashTitle')),
      h('p', { class: 'page-lede' }, T('crashLede', {
        n: fmtInt(episodes.length, state.lang), y: fmtInt(years, state.lang),
      }))
    ),
    renderCrashEpisodes(episodes),
    ranking('crashBest', 'crashSparedNote', ranked.slice(0, RANK_SIZE), spec),
    ranking('crashFell', 'crashFellNote', ranked.slice(-RANK_SIZE).reverse(), spec)
  );
  window.scrollTo({ top: 0 });
}

/** The falls themselves: the evidence every figure on the page is measured over. */
function renderCrashEpisodes(episodes) {
  return h('section', { class: 'panel' },
    h('h2', {}, T('crashMeasured')),
    h('div', { class: 'table-wrap table-flush' },
      h('table', { class: 'funds crash-table' },
        h('thead', {},
          h('tr', {},
            h('th', {}, T('crashPeriod')),
            h('th', { class: 'num-cell' }, T('crashBench')),
            h('th', { class: 'num-cell col-optional' }, T('crashCash')),
            h('th', { class: 'num-cell col-optional' }, T('crashFundsSeen'))
          )
        ),
        h('tbody', {},
          episodes.map((e) =>
            h('tr', {},
              h('td', { class: 'crash-period' },
                h('span', {}, fallPeriod(e)),
                h('span', { class: 'crash-days' }, T('crashDays', { n: fallDays(e) }))),
              h('td', { class: 'num-cell', dataset: { label: T('crashBench') } },
                h('span', { class: 'delta down' }, fmtPct(e.fall, state.lang, { digits: 1 }))),
              h('td', { class: 'num-cell col-optional', dataset: { label: T('crashCash') } },
                e.cash == null ? '—' : fmtPct(e.cash, state.lang, { signed: true, digits: 1 })),
              h('td', { class: 'num-cell col-optional' }, fmtInt(e.funds, state.lang))
            ))
        )
      )
    ),
    h('p', { class: 'panel-note' }, T('crashCashNote')),
    h('p', { class: 'panel-note' }, T('crashLagNote'))
  );
}

// ---------------------------------------------------------------- detail view

async function renderDetail(code) {
  const fund = state.funds.find((f) => f.c === code);
  if (!fund) {
    view.replaceChildren(h('div', { class: 'state-msg' },
      h('p', {}, T('notFound')),
      h('a', { class: 'back-link', href: listHref('/fonlar') }, `← ${T('back')}`)));
    return;
  }

  view.replaceChildren(h('p', { class: 'state-msg' }, T('loading')));

  // Holdings are a separate file per fund and only exist for funds whose KAP
  // report could be read, so a miss here is ordinary and silent.
  const [history, holdings] = await Promise.all([
    fetch(`${DATA}/history/${code}.jsonl`)
      .then((r) => (r.ok ? r.text() : ''))
      .then(parseJsonl)
      .catch(() => []),
    fetch(`${DATA}/holdings/${code}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  // A late-arriving fetch must not overwrite a page the user already left.
  if (!location.hash.endsWith(`/${code}`)) return;

  const prices = history.filter((r) => r.p != null).map((r) => [r.d, r.p]);
  const allocRows = history.filter((r) => r.a).map((r) => [r.d, r.a]);
  const latestAlloc = allocRows.at(-1)?.[1] ?? {};
  const groupIds = state.meta.groups.map((g) => g.id);
  const { segments, hasNegative } = compositionSegments(fund.g, groupIds);

  // Filtered: replaceChildren() stringifies null while h() skips it, so a panel
  // that declines to draw itself — no factor model, no crash record — arrived as
  // the literal text "null" on the page. ZIH showed one, SGK two.
  view.replaceChildren(...[
    h('div', { class: 'detail-head' },
      h('a', { class: 'back-link', href: listHref('/fonlar') }, `← ${T('back')}`),
      h('div', { class: 'detail-id' },
        h('div', { class: 'detail-code num' }, fund.c),
        favButton(fund.c),
        // Straight into a comparison carrying this fund. The page it lands on
        // asks for the second one, which is a shorter path than going back to
        // the list to tick two boxes.
        h('a', {
          class: 'control detail-compare',
          href: `#/karsilastir/${fund.c}`,
          title: T('compareAdd'),
        }, T('compare'))
      ),
      h('h1', { class: 'detail-title' }, fund.n),
      h('ul', { class: 'chips' },
        h('li', { class: 'chip' }, label(state.meta.kinds.find((k) => k.id === fund.k), state.lang)),
        fund.cat && h('li', { class: 'chip' }, label(catOf(fund), state.lang)),
        h('li', { class: 'chip' }, fund.f),
        platformChip(fund),
        requiresQualifiedInvestor(fund)
          ? h('li', { class: 'chip chip-warn', title: T('qualifiedNote') }, T('qualifiedOnly'))
          : null,
        // Borrowing to hold more than the fund owns multiplies both directions,
        // so it belongs beside the fund's name rather than inside a panel.
        fund.lev > LEVERED_FROM
          ? h('li', { class: 'chip chip-warn', title: T('leverageNote') },
              T('leverageChip', { n: fmtNum(fund.lev, state.lang, 1) }))
          : null,
        // Only when the fund actually came through the falls intact — a middling
        // figure is worth reading in the panel below, not announcing up here.
        fund.cr?.s >= CRASH_PROOF_FROM
          ? h('li', { class: 'chip chip-ok', title: T('crashSparedNote') },
              T('crashChip', { n: fmtPct(fund.cr.s, state.lang, { digits: 0 }) }))
          : null,
        // A fund launched inside the data window has too little history for most
        // of the metrics below, so say so up front rather than in a footnote.
        fund.new === true
          ? h('li', { class: 'chip', title: T('ageDays', { n: fmtInt(fund.age, state.lang) }) },
              T('newFund'))
          : null
      )
    ),
    renderStats(fund),
    renderVsCash(fund),
    renderPrediction(fund),
    renderQuality(fund),
    // Beside the other risk panels rather than beside the holdings table: what
    // the fund is holding is the table's job, and this is a warning about it.
    renderSpeculative(fund),
    renderCrash(fund),
    renderComposition(fund, segments, latestAlloc, hasNegative),
    renderThemes(fund),
    renderHoldings(holdings),
    allocRows.length > 2 ? renderAllocHistory(allocRows) : null,
    renderConsistency(prices),
    prices.length > 5 ? renderFundChart(fund, prices) : h('p', { class: 'panel-note' }, T('noHistory'))
  ].filter(Boolean));
  window.scrollTo({ top: 0 });
}

/**
 * How often this fund actually beat the money market, window after window.
 *
 * The trailing return above it is one window, picked by the calendar, and it is
 * the number this page leads with because everybody expects it there. It is also
 * the easiest number on the page to be fooled by: eleven months behind the
 * hurdle and one enormous fortnight prints the same figure as a fund that was
 * ahead the whole way.
 *
 * So this asks the same question at every start date instead. The rate is the
 * headline and the median excess sits under it, because a fund can win 60% of
 * its windows by a hair and lose the other 40% badly.
 */
function renderConsistency(prices) {
  const mmf = state.benchmarks.filter((r) => r.mmf != null).map((r) => [r.d, r.mmf]);
  const windows = consistency(prices, mmf);
  if (!windows) return null;

  return h('section', { class: 'panel' },
    h('h2', {}, T('consistency')),
    h('dl', { class: 'stat-row stat-row-inset' }, windows.map((w) => h('div', { class: 'stat' },
      h('dt', { title: T('consistencyHint') }, T(w.labelKey)),
      // The rate leads, but never without its denominator: an overlapping
      // window is not an independent trial and the count is what says so.
      h('dd', { class: `delta ${w.rate >= 50 ? 'up' : 'down'}` },
        fmtPct(w.rate, state.lang, { digits: 0 })),
      h('span', { class: 'stat-sub num' },
        T('consistencyOf', { n: w.wins, of: w.windows })),
      h('span', { class: `stat-sub num delta ${signOf(w.median)}` },
        T('consistencyMedian', {
          v: fmtPoints(w.median, state.lang, { signed: true, digits: 1 }) })))
    )),
    h('p', { class: 'panel-note' }, T('consistencyNote'))
  );
}

function renderStats(f) {
  const stat = (dt, dd, cls) =>
    h('div', { class: 'stat' }, h('dt', {}, dt), h('dd', { class: cls }, dd));

  const ret = (key, labelKey) =>
    f.r?.[key] == null
      ? null
      : stat(T(labelKey), fmtPct(f.r[key], state.lang, { signed: true, digits: 1 }),
          `delta ${signOf(f.r[key])}`);

  return h('dl', { class: 'stat-row' },
    stat(T('price'), `₺${fmtNum(f.p, state.lang, 4)}`),
    stat(T('size'), fmtMoney(f.sz, state.lang)),
    stat(T('investors'), fmtInt(f.iv, state.lang)),
    stat(T('riskLevel'), f.risk == null ? '—' : `${f.risk} / 7`),
    ret('m1', 'return1m'),
    ret('ytd', 'returnYtd'),
    ret('y1', 'return1y'),
    ret('y3', 'return3y'),
    ret('y5', 'return5y'),
    stat(T('riskLabel'), f.vol == null ? '—' : fmtPct(f.vol, state.lang, { digits: 1 })),
    stat(T('maxDrawdown'), f.mdd == null ? '—' : fmtPct(f.mdd, state.lang, { digits: 1 }),
      `delta ${signOf(f.mdd)}`),
    f.expenseRatio != null
      ? stat(T('expenseRatio'), fmtPct(f.expenseRatio, state.lang, { digits: 2 }))
      : null,
    f.mgmtFee != null
      ? stat(T('mgmtFee'), fmtPct(f.mgmtFee, state.lang, { digits: 2 }))
      : null
  );
}

/**
 * The money-market comparison, stated in full.
 *
 * A lone "vs cash: 4.5" is unreadable — 4.5 of what, against what? So both
 * returns are shown next to their difference, the difference is labelled in
 * percentage POINTS rather than per cent, and a sentence says which way round it
 * went. Every figure is over the same window and net of the same withholding.
 */
function renderVsCash(fund) {
  const ctx = scoringContext();
  const hz = horizonOf(state.prefs.horizon);
  const score = fund._score ?? scoreFund(fund, ctx);
  const period = T(hz.labelKey);

  if (!score) {
    return h('section', { class: 'panel' },
      h('h2', {}, T('vsCashTitle')),
      h('p', { class: 'panel-note' }, T('vsCashUnavailable'))
    );
  }

  const stat = (dt, dd, cls) =>
    h('div', { class: 'stat' }, h('dt', {}, dt), h('dd', { class: cls }, dd));

  const gap = score.excess;
  const verdict = gap > 0.05 ? 'vsCashMore' : gap < -0.05 ? 'vsCashLess' : 'vsCashSame';

  return h('section', { class: 'panel' },
    h('h2', {}, T('vsCashTitle')),
    h('p', { class: 'panel-note' }, T('vsCashNote')),
    h('dl', { class: 'stat-row stat-row-inset' },
      stat(`${T('thisFund')} · ${period}`,
        fmtPct(score.net, state.lang, { signed: true, digits: 1 }),
        `delta ${signOf(score.net)}`),
      stat(`${T('cashBenchmark')} · ${period}`,
        fmtPct(score.cashNet, state.lang, { signed: true, digits: 1 }),
        `delta ${signOf(score.cashNet)}`),
      stat(T('difference'),
        fmtPoints(gap, state.lang, { signed: true, digits: 1 }),
        `delta ${signOf(gap)}`)
    ),
    h('p', { class: 'note' },
      T(verdict, {
        period,
        code: fund.c,
        n: fmtPoints(Math.abs(gap), state.lang, { digits: 1 }),
      }))
  );
}

/**
 * Estimated value for the day TEFAS has not published yet.
 *
 * Shown only when the fund's factor model actually explains its movement —
 * a confident-looking number on an unexplainable fund would be worse than none.
 */
function renderPrediction(fund) {
  if (!fund.bm) return null;
  const r2Pct = fmtPct((fund.bm.r2 ?? 0) * 100, state.lang, { digits: 0 });

  if ((fund.bm.r2 ?? 0) < MIN_PREDICTION_R2) {
    return h('section', { class: 'panel' },
      h('h2', {}, T('prediction')),
      h('p', { class: 'panel-note' }, T('lowConfidence', { n: r2Pct }))
    );
  }

  const pending = pendingFactorReturns(state.benchmarks, fund.d);
  if (!pending) return null;

  const model = { intercept: fund.bm.i, coef: fund.bm.c, r2: fund.bm.r2, se: fund.bm.se };
  const out = predictReturn(model, pending.returns);
  if (!out) return null;

  const estPrice = fund.p * (1 + out.estimate / 100);

  return h('section', { class: 'panel' },
    h('h2', {}, T('prediction')),
    h('p', { class: 'panel-note' },
      T('predictionRange', { from: dayDate(pending.from), to: dayDate(pending.to) })),
    h('dl', { class: 'stat-row' },
      h('div', { class: 'stat' },
        h('dt', {}, T('predictedChange')),
        h('dd', { class: `delta ${signOf(out.estimate)}` },
          fmtPct(out.estimate, state.lang, { signed: true, digits: 2 }))),
      h('div', { class: 'stat' },
        h('dt', {}, T('predictedPrice')),
        h('dd', {}, `₺${fmtNum(estPrice, state.lang, 4)}`)),
      h('div', { class: 'stat' },
        h('dt', {}, T('explained')),
        h('dd', {}, r2Pct))
    ),
    h('p', { class: 'note' }, T('predictionNote'))
  );
}

/** Flag id -> [label when good, label when not]. */
const FLAG_LABELS = {
  beatsCash: ['flagBeatsCash', 'flagBeatsCashNo'],
  beatsPeers: ['flagBeatsPeers', 'flagBeatsPeersNo'],
  drawdown: ['flagDrawdown', 'flagDrawdownNo'],
  shortHistory: [null, 'flagShortHistory'],
  smallFund: [null, 'flagSmallFund'],
};

/** Peer comparison, tax-adjusted return, flags and the factor decomposition. */
function renderQuality(fund) {
  const ctx = scoringContext();
  const peer = state.meta.peerStats?.[fund.peer];
  const peerMedian = peer?.medianY1 ?? null;
  const flags = qualityFlags(fund, { ...ctx, peerMedian });
  const score = fund._score ?? scoreFund(fund, ctx);
  const peerName = label(state.meta.peerGroups?.find((g) => g.id === fund.peer), state.lang);

  const chips = flags.map((f) => {
    const [goodKey, badKey] = FLAG_LABELS[f.id] ?? [];
    const key = f.good === false ? badKey : goodKey;
    if (!key) return null;
    const tone = f.good === null ? 'neutral' : f.good ? 'good' : 'warn';
    const mark = f.good === null ? '•' : f.good ? '✓' : '!';
    return h('li', { class: `flag flag-${tone}` },
      h('span', { class: 'flag-mark', 'aria-hidden': 'true' }, mark),
      h('span', {}, T(key)));
  }).filter(Boolean);

  const stat = (dt, dd, cls) =>
    h('div', { class: 'stat' }, h('dt', {}, dt), h('dd', { class: cls }, dd));

  // The return-vs-cash figures live in their own panel above, stated properly;
  // repeating them here as a bare number is what made them misleading.
  const rows = [];
  if (score) {
    rows.push(stat(T('ratioLabel'), fmtNum(score.ratio, state.lang, 2),
      `delta ${signOf(score.ratio)}`));
  }
  if (peerMedian != null) {
    rows.push(stat(T('peerMedian'), fmtPct(peerMedian, state.lang, { digits: 1 })));
  }
  // Alpha is only meaningful when the factor model actually fits. Annualising a
  // daily intercept from an R²=0.02 regression produces figures like 23,878%,
  // which is noise wearing a decimal point.
  if (fund.alpha != null && (fund.bm?.r2 ?? 0) >= MIN_PREDICTION_R2) {
    rows.push(stat(T('alpha'), fmtPct(fund.alpha, state.lang, { signed: true, digits: 1 }),
      `delta ${signOf(fund.alpha)}`));
  }
  if (fund.fl30 != null) {
    rows.push(stat(T('flow30'), fmtMoney(fund.fl30, state.lang),
      `delta ${signOf(fund.fl30)}`));
  }
  if (fund.iv30 != null) {
    rows.push(stat(T('investors30'), fmtInt(fund.iv30, state.lang),
      `delta ${signOf(fund.iv30)}`));
  }
  if (fund.turn != null) {
    rows.push(stat(T('turnover'), fmtPct(fund.turn, state.lang, { digits: 1 })));
  }

  return h('section', { class: 'panel' },
    h('h2', {}, T('quality')),
    h('p', { class: 'panel-note' },
      peerName ? `${T('peerGroup')}: ${peerName} (${fmtInt(peer.count, state.lang)})` : ''),
    chips.length ? h('ul', { class: 'flags' }, chips) : null,
    rows.length ? h('dl', { class: 'stat-row stat-row-inset' }, rows) : null
  );
}

function renderComposition(fund, segments, latestAlloc, hasNegative) {
  const groups = assetBreakdown(latestAlloc, state.meta, state.lang);
  const rows = [];
  for (const g of groups) {
    rows.push(
      h('tr', { class: 'group-row' },
        h('td', {}, h('span', { class: 'swatch', style: `background:${groupColor(g.id)}` }), g.name),
        h('td', { class: 'pct' }, fmtPct(g.total, state.lang, { digits: 2 }))
      )
    );
    for (const r of g.rows) {
      rows.push(h('tr', { class: 'leaf' },
        h('td', {}, r.name),
        h('td', { class: 'pct' }, fmtPct(r.pct, state.lang, { digits: 2 }))));
    }
  }

  return h('section', { class: 'panel' },
    h('h2', {}, T('portfolio')),
    h('p', { class: 'panel-note' }, T('asOf', { date: fmtDate(fund.d, state.lang) })),
    compBar(segments, 'comp-bar'),
    h('ul', { class: 'comp-legend' },
      segments.map((s) =>
        h('li', {},
          h('span', { class: 'swatch', style: `background:${groupColor(s.id)}` }),
          h('span', {}, label(state.meta.groups.find((g) => g.id === s.id), state.lang)),
          h('span', { class: 'val num' }, fmtPct(s.pct, state.lang, { digits: 1 }))))),
    hasNegative ? h('p', { class: 'note' }, T('negativeNote')) : null,
    rows.length
      ? h('table', { class: 'breakdown' },
          h('thead', {}, h('tr', {},
            h('th', {}, T('assetClass')),
            h('th', { class: 'pct' }, T('weight')))),
          h('tbody', {}, rows))
      : null
  );
}

/**
 * A deterministic hue for a security, so the same ticker is always the same
 * colour and the table gains a scannable left edge.
 *
 * Company logos are what a commercial site would use here. Fetching a few
 * hundred of them from a third party on every fund page would be a second
 * runtime dependency for decoration, so a monogram stands in.
 */
function monogramHue(code) {
  let hash = 0;
  for (const ch of String(code ?? '')) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return hash;
}

/** The two-letter mark that leads a holding row. */
function monogram(position) {
  const label = String(position.code ?? position.name ?? '?')
    .replace(/[^A-Za-z0-9ÇĞİÖŞÜçğıöşü]/g, '')
    .slice(0, 2)
    .toUpperCase();
  return h('span', {
    class: 'holding-mark',
    style: `--mark-hue:${monogramHue(position.code ?? position.name)}`,
    'aria-hidden': 'true',
  }, label || '—');
}

/** Movement filters, which read the live quotes rather than the filing. */
const MOVES = [
  { id: 'all', match: () => true },
  { id: 'up', match: (row) => (row.change ?? 0) > 0 },
  { id: 'down', match: (row) => (row.change ?? 0) < 0 },
  // "New" is about the filing, not the market: a position the fund did not hold
  // last month. Only offered when there is a previous month to compare against.
  { id: 'new', match: (row) => row.position.prevWeight == null, needsPrevious: true },
];

/**
 * The individual positions from the fund's KAP filing.
 *
 * Grouped by asset class with each group's own weight on its heading, one row per
 * position rather than per filed line, and — where last month's filing could be
 * read — what each position weighed then and which way it moved since.
 *
 * @param {{code:string, period:string|null, prevPeriod:string|null,
 *          warnings:string[], holdings:object[]}} data
 */
function renderHoldings(data) {
  // Say why the list is missing rather than dropping the section. Coverage is
  // partial — a fund with nothing here looks identical to a feature that does
  // not exist, and the reader has no way to tell which they are looking at.
  if (!data?.holdings?.length) {
    holdingsView = null;
    return h('section', { class: 'panel' },
      h('h2', {}, T('holdings')),
      h('p', { class: 'panel-note' }, T('holdingsMissing')),
      h('p', { class: 'panel-note' }, T('holdingsMissingWhy')));
  }

  const positions = aggregateHoldings(data.holdings);
  const groups = groupHoldings(positions);
  const hasPrevious = !!data.prevPeriod && positions.some((p) => p.prevWeight != null);
  const FOLD_PER_GROUP = 6;

  let group = 'all';
  let move = 'all';
  let expanded = positions.length <= FOLD_PER_GROUP;

  const body = h('tbody', {});
  const toggle = h('button', { class: 'link-btn', type: 'button' });
  const groupRail = h('div', { class: 'rail-chips' });
  const moveRail = h('div', { class: 'rail-chips rail-chips-sub' });
  const summary = h('div', { class: 'live-summary' });
  const stamp = h('p', { class: 'panel-note' });

  /** Positions with their quote attached, so every filter reads one shape. */
  const priced = () => positions.map((position) => {
    const quote = quoteFor(position, state.quotes);
    return { position, quote, change: quote?.change ?? null };
  });

  const chip = (label, active, onClick) =>
    h('button', {
      class: `rail-chip${active ? ' is-on' : ''}`,
      type: 'button',
      'aria-pressed': active ? 'true' : 'false',
      onClick,
    }, label);

  const draw = () => {
    const rows = priced();
    const moves = MOVES.filter((m) => !m.needsPrevious || hasPrevious);
    const activeMove = moves.find((m) => m.id === move) ?? moves[0];

    // Counts are of the whole fund, not of the current filter: a chip that
    // recounted itself after every click could not be used to navigate.
    groupRail.replaceChildren(
      chip(`${T('all')} (${fmtInt(positions.length, state.lang)})`, group === 'all',
        () => { group = 'all'; draw(); }),
      ...groups.map((g) => chip(
        `${T(`hg_${g.id}`)} (${fmtInt(g.rows.length, state.lang)})`,
        group === g.id,
        () => { group = g.id; draw(); })));

    // A filter that would match nothing is not offered: a bond fund has no
    // risers and no fallers, and "Artanlar (0)" is a control that does nothing.
    const offered = moves
      .map((m) => ({ m, n: m.id === 'all' ? rows.length : rows.filter(m.match).length }))
      .filter(({ m, n }) => m.id === 'all' || n > 0);
    moveRail.replaceChildren(...offered.length > 1
      ? offered.map(({ m, n }) =>
        chip(`${T(`move_${m.id}`)}${m.id === 'all' ? '' : ` (${fmtInt(n, state.lang)})`}`,
          activeMove.id === m.id, () => { move = m.id; draw(); }))
      : []);

    const shown = groups
      .filter((g) => group === 'all' || g.id === group)
      .map((g) => {
        const kept = rows.filter((row) => row.position.group === g.id && activeMove.match(row));
        return { ...g, kept, hidden: expanded ? 0 : Math.max(0, kept.length - FOLD_PER_GROUP) };
      })
      .filter((g) => g.kept.length);

    const cells = [];
    for (const g of shown) {
      // One spanning cell rather than a heading cell plus a figure cell: the
      // narrow layout hides two columns, and a colspan cannot follow that, so a
      // two-cell heading came out misaligned on a phone. The weight is placed by
      // flex inside the span instead.
      cells.push(h('tr', { class: 'group-row' },
        h('td', { colspan: '6' },
          h('span', { class: 'group-accent', style: `background:${groupColor(g.color)}` }),
          h('span', { class: 'group-name' }, T(`hg_${g.id}`)),
          h('span', { class: 'group-count' }, fmtInt(g.rows.length, state.lang)),
          // The group's whole weight, including rows the fold is hiding — a
          // heading that agreed only with what is visible would misstate the fund.
          h('span', { class: 'pct num group-weight' },
            fmtPct(g.weight, state.lang, { digits: 2 })))));

      for (const { position, quote } of (expanded ? g.kept : g.kept.slice(0, FOLD_PER_GROUP))) {
        // A US listing is quoted in dollars. Printing "₺219,74" against NVDA
        // would be a wrong number, not a formatting slip.
        const symbol = quote ? MARKETS[quote.market].symbol : '';
        const diff = position.prevWeight == null || position.weight == null
          ? null
          : position.weight - position.prevWeight;

        cells.push(h('tr', {},
          h('td', { class: 'holding-asset' },
            monogram(position),
            h('span', { class: 'holding-id' },
              h('span', { class: 'holding-code num' },
                // A Borsa İstanbul line is a company with a page of its own, so
                // the code is the way through to it. Resolved through listingOf
                // rather than the raw code, which carries ISINs and pledge marks
                // beside the ticker.
                holdingLink(position) ?? position.code ?? '—',
                // A fund that holds other funds is a different animal from one
                // that picks securities, so the distinction is on the row.
                position.ref
                  ? h('a', { class: 'holding-ref', href: `#/fon/${position.ref}` },
                      T('holdingsOtherFund'))
                  : null,
                position.prevWeight == null && hasPrevious
                  ? h('span', { class: 'holding-new', title: T('holdingsNewTitle') }, T('move_new'))
                  : null),
              h('span', { class: 'holding-name', title: position.isin ?? '' },
                position.name ?? position.filedGroup ?? ''))),
          h('td', { class: 'holding-price num' },
            quote
              ? [h('span', { class: 'delay-dot', title: T('holdingsDelayTitle') }, '◷'),
                `${symbol}${fmtNum(quote.price, state.lang, 2)}`]
              : '—'),
          h('td', { class: `holding-move num delta ${signOf(quote?.change ?? null)}` },
            quote?.change == null
              ? '—'
              : fmtPct(quote.change, state.lang, { signed: true, digits: 2 })),
          h('td', { class: 'pct num holding-weight' },
            position.weight == null ? '—' : fmtPct(position.weight, state.lang, { digits: 2 })),
          hasPrevious
            ? h('td', { class: 'pct num holding-prev' },
                position.prevWeight == null
                  ? '—'
                  : fmtPct(position.prevWeight, state.lang, { digits: 2 }))
            : null,
          // A change between two percentages is percentage POINTS. The commercial
          // sites print it with a percent sign, which is the easiest way to make
          // a 2-point shift read as a 2% one.
          hasPrevious
            ? h('td', { class: `num delta ${signOf(diff)}` },
                diff == null ? '—' : fmtPoints(diff, state.lang, { signed: true, digits: 2, unit: false }))
            : null));
      }

      if (!expanded && g.hidden) {
        cells.push(h('tr', { class: 'fold-row' },
          h('td', { colspan: '6' },
            T('holdingsHidden', { n: fmtInt(g.hidden, state.lang) }))));
      }
    }

    body.replaceChildren(...cells.length
      ? cells
      : [h('tr', {}, h('td', { colspan: '6', class: 'fold-row' },
          T('holdingsNoneMatch')))]);

    // `replaceChildren` stringifies whatever it is given, so a null slips in as
    // the word "null" — unlike `h`, which drops it.
    summary.replaceChildren(...liveSummary(data.holdings).filter(Boolean));
    stamp.replaceChildren(...sourceLine());
    toggle.textContent = expanded ? T('holdingsLess') : T('holdingsMore', { n: positions.length });
    toggle.hidden = !groups.some((g) => g.rows.length > FOLD_PER_GROUP);
  };
  toggle.addEventListener('click', () => { expanded = !expanded; draw(); });

  // The table is drawn now and redrawn when quotes land, so the page does not
  // wait on a third party before showing what the fund holds.
  holdingsView = { code: data.code, holdings: data.holdings, draw };
  draw();
  ensureQuotes(data.holdings).then(() => { if (holdingsView?.draw === draw) draw(); });

  return h('section', { class: 'panel' },
    h('div', { class: 'holdings-head' },
      h('div', {},
        h('h2', {}, T('holdings')),
        h('p', { class: 'panel-note' }, T('holdingsNote'))),
      h('p', { class: 'holdings-stamp' },
        [data.period ? T('holdingsAsOf', { period: data.period }) : null,
          hasPrevious ? T('holdingsVersus', { period: data.prevPeriod }) : null]
          .filter(Boolean).join(' · '))),
    groupRail,
    moveRail,
    // Surfaced rather than buried: the parse reconciles against every subtotal,
    // so a total that misses 100% is the filer's arithmetic, not ours.
    data.warnings?.length
      ? h('p', { class: 'note' }, T('holdingsFlagged', { total: data.warnings[0].match(/[\d.]+%/)?.[0] ?? '—' }))
      : null,
    summary,
    h('table', { class: 'breakdown holdings-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, T('security')),
        h('th', { class: 'num-head' }, T('lastPrice')),
        h('th', { class: 'num-head' }, T('dayChange')),
        h('th', { class: 'pct' }, T('weight')),
        hasPrevious ? h('th', { class: 'pct' }, T('holdingsPrevMonth')) : null,
        hasPrevious ? h('th', { class: 'pct' }, T('holdingsDiffUnit')) : null)),
      body),
    toggle,
    h('p', { class: 'panel-note' }, T('holdingsSource')),
    stamp);
}

/** A market's clock for the moment its quotes reflect, in its own time zone. */
function marketClock(market, at) {
  if (!at) return null;
  return new Date(at).toLocaleTimeString(state.lang === 'tr' ? 'tr-TR' : 'en-GB',
    { hour: '2-digit', minute: '2-digit', timeZone: MARKETS[market].zone });
}

/** The longest delay among the markets in play, which is the honest one to quote. */
function delayMinutes(markets) {
  const delays = markets.map((m) => state.quotes?.[m]?.delaySeconds ?? 0);
  return Math.round(Math.max(0, ...delays) / 60);
}

/** Where the prices came from and how old they are. Absent until they arrive. */
function sourceLine() {
  if (!state.quotes) return [];
  const fetched = Object.keys(MARKETS).filter((m) => state.quotes[m]);
  return [
    T('liveSourceHead'),
    h('a', { href: QUOTE_SOURCE.home, rel: 'noopener', target: '_blank' }, QUOTE_SOURCE.name),
    T('liveSourceTail', { n: delayMinutes(fetched) }),
  ];
}

/**
 * What the day's market has done to this fund, from the positions it can price.
 *
 * The figure is deliberately the fund's own move rather than the move of the
 * shares in it: a fund with a fifth of its money in shares that rose 3% had a
 * 0.6% day, and printing 3% next to its name would be a different claim
 * altogether. The share of the portfolio behind the number sits beside it, so a
 * thin estimate reads as thin.
 */
function liveSummary(rows) {
  const quotes = state.quotes;
  // Nothing has come back yet: say nothing rather than flash a failure that is
  // about to be contradicted.
  if (!quotes) return quotesTried ? [h('p', { class: 'note' }, T('liveUnavailable'))] : [];

  // The tape's currency quotes carry the lira leg of a foreign holding.
  const est = estimateMove(rows, quotes, state.live?.quotes ?? null);
  if (!est) return [h('p', { class: 'note' }, T('liveNonePriced'))];
  // A dozen filings parse into weights that sum to millions. Their row prices
  // are real; no total built on those weights would be.
  if (!est.reliable) return [h('p', { class: 'note' }, T('liveWeightsOff'))];
  if (est.priced < MIN_COVERAGE) {
    return [h('p', { class: 'note' },
      T('liveTooLittle', { n: fmtPct(est.priced, state.lang, { digits: 1 }) }))];
  }

  const stat = (dt, dd, cls) =>
    h('div', { class: 'stat' }, h('dt', {}, dt), h('dd', { class: cls }, dd));

  // While a market is shut, the same number is the last session's move, not
  // today's, and the feed's timestamp keeps advancing regardless — so the clock
  // is only shown when there is a live session behind it. Borsa İstanbul's is
  // preferred: it is where most of a fund sits, and the session the reader is
  // most likely to be in.
  const trading = est.markets.filter((m) => sessionOpen(m));
  const clockMarket = trading.includes('bist') ? 'bist' : trading[0] ?? null;
  const clock = clockMarket ? marketClock(clockMarket, quotes[clockMarket]?.asOf) : null;

  // Sentences that only apply to some funds, merged into the standing note
  // rather than stacked as separate panels.
  const caveats = [
    // Priced positions worth more than the fund itself is leverage, not a bug,
    // and it is the most interesting thing on the page when it happens.
    est.priced > 100 ? T('liveLevered') : null,
    est.markets.some((m) => MARKETS[m].fx) ? T('liveFxNote') : null,
    T('liveNote'),
  ].filter(Boolean);

  return [
    h('dl', { class: 'stat-row stat-row-inset live-estimate' },
      stat(
        h('span', { class: 'live-label' },
          clock ? h('span', { class: 'live-dot', 'aria-hidden': 'true' }) : null,
          T(clock ? 'liveToday' : 'liveLastSession')),
        fmtPct(est.move, state.lang, { signed: true, digits: 2 }),
        `delta ${signOf(est.move)}`),
      stat(T('livePriced'), fmtPct(est.priced, state.lang, { digits: 0 })),
      stat(T('livePositions'), fmtInt(est.count, state.lang)),
      // Named rather than "the exchange": a fund holding only US shares is
      // reading New York, and calling that Borsa İstanbul would be wrong.
      clock
        ? stat(T('liveAsOf', { market: T(`market_${clockMarket}`), time: clock }),
            T('liveDelayed', { n: delayMinutes(est.markets) }), 'muted')
        : stat(est.markets.length === 1 ? T(`market_${est.markets[0]}`) : T('liveClosedLabel'),
            T('liveClosed'), 'muted')
    ),
    // Which sessions are behind the figure, said plainly, because a fund holding
    // both markets is reading one live session and one closed one.
    est.markets.length > 1
      ? h('p', { class: 'panel-note' }, T('liveSessions', {
        list: est.markets
          .map((m) => `${T(`market_${m}`)} ${T(sessionOpen(m) ? 'liveSessionOpen' : 'liveSessionShut')}`)
          .join(' · '),
      }))
      : null,
    h('p', { class: 'note' }, caveats.join(' ')),
  ];
}

// ---------------------------------------------------------------- the market
//
// The four numbers on the tape, drawn against each other, and the exchange as a
// map. Both answer the question the tape can only hint at: the tape says gold is
// up 0.3% today, this says gold has beaten the index by 40 points since April.
//
// Everything here is already in the browser or one request away — the benchmark
// series is the same file the fund charts read, and the map is coloured from the
// same delayed scan that prices fund holdings.

/**
 * The series the market chart offers.
 *
 * The four the tape carries, plus the money-market index — the hurdle every
 * other page measures against, and the only line here you can hold without
 * taking any risk at all.
 */
const MARKET_SERIES = [
  { key: 'bist100', color: 'var(--g-equity)', prefix: '', axisDigits: 0, tipDigits: 0 },
  { key: 'goldgram', color: 'var(--g-lease)', prefix: '₺', axisDigits: 0, tipDigits: 2 },
  { key: 'usdtry', color: 'var(--g-foreign)', prefix: '₺', axisDigits: 2, tipDigits: 4 },
  { key: 'eurtry', color: 'var(--g-corpDebt)', prefix: '₺', axisDigits: 2, tipDigits: 4 },
  { key: 'mmf', color: 'var(--g-cash)', prefix: '', axisDigits: 0, tipDigits: 2 },
];

/** How many companies the map draws. Past this a tile is smaller than its name. */
const MAP_SIZE = 100;

/** The move at which a tile is fully coloured. Beyond it the colour saturates. */
const MAP_FULL_MOVE = 4;

/** A tile smaller than this gets no label — a clipped ticker is worse than none. */
const MAP_LABEL_W = 46;
const MAP_LABEL_H = 26;

async function renderMarket() {
  state.page = 'market';
  view.replaceChildren(h('p', { class: 'state-msg' }, T('loading')));
  // The map needs the share index; the chart needs only what is already loaded,
  // so it is drawn first and the map fills in underneath it.
  const loaded = await loadShares();
  if (state.page !== 'market') return;

  const raw = {};
  for (const s of MARKET_SERIES) {
    const pts = state.benchmarks.filter((r) => r[s.key] != null).map((r) => [r.d, r[s.key]]);
    if (pts.length > 5) raw[s.key] = pts;
  }

  const mapPanel = h('section', { class: 'panel map-panel' },
    h('div', { class: 'dash-pane-head' },
      h('h2', {}, T('marketMap')),
      h('a', { class: 'dash-more', href: '#/hisseler' }, T('dashMore'))),
    h('p', { class: 'panel-note' }, T('marketMapNote', { n: MAP_SIZE })),
    h('div', { class: 'map-box', id: 'market-map' }),
    h('div', { class: 'map-key' },
      [-4, -2, 0, 2, 4].map((pct) =>
        h('span', { class: 'map-key-step', style: `background:${moveColor(pct)}` },
          fmtPct(pct, state.lang, { signed: true, digits: 0 }))))
  );

  view.replaceChildren(
    subNav('/piyasa'),
    renderChart({
      raw,
      titleKey: 'marketChart',
      series: MARKET_SERIES.filter((s) => raw[s.key]).map((s) => ({
        ...s, width: 2, name: () => T(s.key),
      })),
    }),
    loaded ? mapPanel : h('section', { class: 'panel' },
      h('h2', {}, T('marketMap')),
      h('p', { class: 'panel-note' }, T('sharesUnavailable')))
  );

  if (loaded) {
    drawMap();
    ensureQuotes(null).then(() => { if (state.page === 'market') drawMap(); });
    // The layout is in real pixels, so a resize has to redo it. Cheap — a
    // hundred rectangles over nineteen groups — and the listener drops itself
    // the moment the box it was drawing into leaves the page.
    const onResize = debounce(() => {
      if (!document.getElementById('market-map')) {
        window.removeEventListener('resize', onResize);
        return;
      }
      drawMap();
    }, 200);
    window.addEventListener('resize', onResize);
  }
  window.scrollTo({ top: 0 });
}

/** The colour for a day's move: red below, green above, flat in between. */
function moveColor(change, ceiling = 80) {
  if (change == null) return 'var(--surface-2, rgba(127,127,127,0.09))';
  const strength = Math.min(1, Math.abs(change) / MAP_FULL_MOVE);
  // A floor, so a share that moved 0.05% still reads as green rather than as a
  // hole in the map.
  const mix = Math.round(18 + strength * (ceiling - 18));
  return `color-mix(in srgb, var(--${change >= 0 ? 'up' : 'down'}) ${mix}%, var(--plane))`;
}

/**
 * The ceiling the dashboard's theme tiles use, and why it is lower.
 *
 * A map tile's label is a ticker beside a percentage and can sit at 0.7rem on a
 * fully saturated ground; a theme tile carries the theme's NAME, which is the
 * thing being read. At the map's ceiling the worst tile measured 4.17:1 against
 * the page's ink in the dark theme — under the 4.5:1 that text this size needs.
 * At 55 both themes clear it, and the colour still runs a full gradient.
 */
const THEME_TILE_CEILING = 55;

/**
 * Borsa İstanbul as a map: area is what a company is worth, colour is what it
 * did today, and the grouping is the line of business it is in.
 *
 * Two levels, because one is unreadable: a flat map of a hundred names says
 * which companies moved, and this says which *industries* did — which is the
 * only thing a market map is really for.
 */
function drawMap() {
  const box = document.getElementById('market-map');
  if (!box || !shares) return;

  const width = box.clientWidth;
  if (!width) return;
  const height = Math.max(320, Math.min(680, Math.round(width * 0.52)));
  box.style.height = `${height}px`;

  const top = shares.list
    .filter((s) => s.cap > 0)
    .slice(0, MAP_SIZE);

  // Grouped by theme, with everything unclassified in one bucket rather than as
  // nineteen groups of one.
  const groups = new Map();
  for (const stock of top) {
    const id = stock.th ?? 'other';
    if (!groups.has(id)) groups.set(id, { id, cap: 0, members: [] });
    const group = groups.get(id);
    group.cap += stock.cap;
    group.members.push(stock);
  }

  const laid = squarify([...groups.values()], { x: 0, y: 0, w: width, h: height },
    (g) => g.cap);

  const tiles = [];
  for (const cell of laid) {
    const group = cell.item;
    const head = cell.h > 34 && cell.w > 60 ? 15 : 0;
    tiles.push(h('div', {
      class: 'map-group',
      style: `left:${cell.x}px;top:${cell.y}px;width:${cell.w}px;height:${cell.h}px`,
    }, head ? h('span', { class: 'map-group-name' },
      group.id === 'other' ? T('themeOther') : themeName(group.id)) : null));

    const inner = { x: cell.x, y: cell.y + head, w: cell.w, h: cell.h - head };
    for (const tile of squarify(group.members, inner, (s) => s.cap)) {
      const stock = tile.item;
      const { change } = sharePrice(stock);
      const label = tile.w >= MAP_LABEL_W && tile.h >= MAP_LABEL_H;
      tiles.push(h('a', {
        class: 'map-tile',
        href: `#/hisse/${stock.c}`,
        title: `${stock.c} · ${stock.n} · ${fmtPct(change, state.lang, { signed: true, digits: 2 })} · ${fmtMoney(stock.cap, state.lang)}`,
        style: `left:${tile.x}px;top:${tile.y}px;width:${tile.w}px;height:${tile.h}px;`
          + `background:${moveColor(change)}`,
      },
        label ? h('span', { class: 'map-code num' }, stock.c) : null,
        label && tile.h >= 40
          ? h('span', { class: 'map-move num' }, fmtPct(change, state.lang, { signed: true, digits: 1 }))
          : null));
    }
  }

  box.replaceChildren(...tiles);
}


// ---------------------------------------------------------------- comparing
//
// Two or more funds on one indexed axis, with everything else that differs
// between them underneath.
//
// The site is good at answering "is this fund any good" one fund at a time, and
// that is not the question anybody actually has: they have three candidates and
// want to know which. Doing it by opening three tabs loses the one thing that
// matters most, which is that the three lines belong on the same axis rebased to
// the same day — the chart already refuses to do anything else, so this page is
// mostly a matter of handing it more than one fund.
//
// The codes are in the route, so a comparison is a link like any other screen.

/**
 * How many funds fit on one axis.
 *
 * Six lines is already a lot to hold apart, and the palette below runs out at
 * eight. Past this the chart stops being a comparison and becomes a texture.
 */
const COMPARE_MAX = 6;

/** Which funds are selected in the list, waiting to be compared. */
const compareSet = new Set();

/** A fund's line colour on the compare chart: its position, not its identity. */
const compareColor = (i) => `var(--slice-${(i % 8) + 1}, var(--ink-muted))`;

/**
 * The rows of the table under the chart.
 *
 * `dir` marks which way is better, and is deliberately absent from most of them.
 * A fee is unambiguous — you pay it, less is better. A return over a stated
 * window is unambiguous. Volatility is NOT: somebody comparing two equity funds
 * may well want the livelier one, and a green tick beside the calmer one would
 * be a taste presented as a finding. The same goes for size, for investor count
 * and for the official risk value, which is a constraint rather than a grade.
 *
 * A maximum drawdown is 'high' because it is negative: losing 4% at worst beats
 * losing 22%.
 */
/** A value at the precision its cell shows, so a comparison sees what a reader does. */
const roundTo = (v, digits) => {
  if (v == null || !Number.isFinite(v)) return v;
  const f = 10 ** (digits ?? 2);
  return Math.round(v * f) / f;
};

const COMPARE_ROWS = [
  { labelKey: 'price', digits: 4, get: (f) => f.p, fmt: (v) => `₺${fmtNum(v, state.lang, 4)}` },
  { labelKey: 'size', digits: 0, get: (f) => f.sz, fmt: (v) => fmtMoney(v, state.lang) },
  { labelKey: 'investors', digits: 0, get: (f) => f.iv, fmt: (v) => fmtInt(v, state.lang) },
  ...HORIZONS.map((hz) => ({
    labelKey: hz.labelKey, dir: 'high', delta: true, digits: 1,
    get: (f) => f.r?.[hz.key],
    fmt: (v) => fmtPct(v, state.lang, { signed: true, digits: 1 }),
  })),
  {
    labelKey: 'vsCash', dir: 'high', delta: true, digits: 1,
    get: (f) => f._score?.excess,
    fmt: (v) => fmtPoints(v, state.lang, { signed: true, digits: 1 }),
  },
  {
    labelKey: 'volatility', digits: 1,
    get: (f) => f.vol,
    fmt: (v) => fmtPct(v, state.lang, { digits: 1 }),
  },
  {
    labelKey: 'maxDrawdown', dir: 'high', delta: true, digits: 1,
    get: (f) => f.mdd,
    fmt: (v) => fmtPct(v, state.lang, { digits: 1 }),
  },
  {
    labelKey: 'expenseRatio', dir: 'low', digits: 2,
    get: (f) => f.expenseRatio,
    fmt: (v) => fmtPct(v, state.lang, { digits: 2 }),
  },
  {
    labelKey: 'crashSpared', dir: 'high', digits: 0,
    get: (f) => f.cr?.s,
    fmt: (v) => fmtNum(v, state.lang, 0),
  },
];

/** The rows that are a label rather than a number, printed under the figures. */
const COMPARE_FACTS = [
  { labelKey: 'category', get: (f) => label(catOf(f), state.lang) },
  { labelKey: 'founder', get: (f) => f.f },
  { labelKey: 'stanceLabel', get: (f) => (f.stance
    ? T(`stance${f.stance[0].toUpperCase()}${f.stance.slice(1)}`) : null) },
  { labelKey: 'riskLevel', get: (f) => (f.risk == null ? null : String(f.risk)) },
];

/**
 * The compare page.
 *
 * Codes come from the route rather than from memory, so a comparison can be
 * bookmarked and sent — which is most of what anybody wants to do with one.
 */
async function renderCompare(codes) {
  state.page = 'compare';
  const picked = codes
    .map((c) => state.funds.find((f) => f.c === c))
    .filter(Boolean)
    .slice(0, COMPARE_MAX);

  // The selection and the route are kept in step, so leaving the page and going
  // back to the list finds the same funds ticked.
  compareSet.clear();
  for (const f of picked) compareSet.add(f.c);

  if (picked.length < 2) {
    view.replaceChildren(renderCompareHead(picked), compareAdd(picked),
      h('div', { class: 'state-msg' }, h('p', {}, T('comparePickTwo'))));
    return;
  }

  view.replaceChildren(renderCompareHead(picked), compareAdd(picked),
    h('p', { class: 'state-msg' }, T('loading')));

  const histories = await Promise.all(picked.map((f) => loadHistory(f.c)));
  if (state.page !== 'compare') return;

  // Scores depend on the tax and horizon preferences, exactly as on the list.
  const ctx = scoringContext();
  for (const f of picked) f._score = scoreFund(f, ctx);

  const raw = {};
  picked.forEach((f, i) => { if (histories[i]?.length > 1) raw[f.c] = histories[i]; });

  const chart = Object.keys(raw).length > 1
    ? renderChart({
        raw,
        titleKey: 'compareChart',
        series: picked.filter((f) => raw[f.c]).map((f, i) => ({
          key: f.c, color: compareColor(i), width: 2, prefix: '₺', tipDigits: 4,
          axisDigits: null, name: () => f.c,
        })),
      })
    : null;

  const holdings = h('div', {});
  view.replaceChildren(
    renderCompareHead(picked),
    compareAdd(picked),
    ...(chart ? [chart] : []),
    compareMix(picked),
    compareTable(picked),
    holdings
  );
  window.scrollTo({ top: 0 });

  // The filings are a second round of requests, so the page is complete without
  // them and gains a panel when they land — the same bargain the look-through
  // makes on the portfolio page.
  const filings = await loadPortfolioFilings(picked.map((f) => f.c));
  if (state.page !== 'compare') return;
  holdings.replaceChildren(...[compareHoldings(picked, filings)].filter(Boolean));
}

function renderCompareHead(picked) {
  return h('section', { class: 'page-head' },
    h('p', { class: 'eyebrow' }, T('compare')),
    h('h1', { class: 'page-title' },
      picked.length ? picked.map((f) => f.c).join(' · ') : T('compare')),
    h('a', { class: 'back-link', href: listHref('/fonlar') }, `← ${T('navFunds')}`));
}

/** Add another fund, or drop one. The page's own picker. */
function compareAdd(picked) {
  const input = h('input', {
    type: 'text', class: 'port-input', list: 'compare-list', spellcheck: 'false',
    autocomplete: 'off', 'aria-label': T('compareAdd'), placeholder: T('compareAdd'),
  });
  const error = h('p', { class: 'port-add-error', role: 'alert' });

  const go = (codes) => { location.hash = `#/karsilastir/${codes.join(',')}`; };

  return h('section', { class: 'panel port-add-panel' },
    h('ul', { class: 'compare-chips' }, picked.map((f, i) => h('li', {},
      h('span', { class: 'compare-swatch', style: `background:${compareColor(i)}` }),
      h('a', { class: 'code-link num', href: `#/fon/${f.c}` }, f.c),
      h('span', { class: 'compare-chip-name', title: f.n }, f.n),
      h('button', {
        type: 'button', class: 'screen-x', 'aria-label': `${T('compareRemove')} — ${f.c}`,
        onClick: () => go(picked.filter((x) => x.c !== f.c).map((x) => x.c)),
      }, '×')
    ))),
    h('form', {
      class: 'port-add',
      onSubmit: (e) => {
        e.preventDefault();
        const code = input.value.trim().toUpperCase();
        if (!code) return;
        if (!state.funds.some((f) => f.c === code)) {
          error.textContent = T('compareUnknown');
          return;
        }
        if (picked.length >= COMPARE_MAX) {
          error.textContent = T('compareFull', { n: COMPARE_MAX });
          return;
        }
        error.textContent = '';
        input.value = '';
        go([...picked.map((f) => f.c), code]);
      },
    },
      h('div', { class: 'port-add-fields' },
        input,
        h('button', { type: 'submit', class: 'control port-add-go' }, T('portAddButton'))),
      // Funds only. A share and a fund do not share a price series anybody would
      // put on one axis, and the share pages already compare against the index.
      h('datalist', { id: 'compare-list' },
        state.funds.slice(0, 400).map((f) =>
          h('option', { value: f.c }, `${f.c} — ${f.n}`)))
    ),
    error
  );
}

/** The recurring unit, once per fund, stacked so the shapes line up. */
function compareMix(picked) {
  const groupIds = state.meta.groups.map((g) => g.id);
  return h('section', { class: 'panel' },
    h('h2', {}, T('compareMix')),
    h('ul', { class: 'compare-mix' }, picked.map((f) => {
      const { segments } = compositionSegments(f.g, groupIds);
      return h('li', {},
        h('span', { class: 'compare-mix-code num' }, f.c),
        compBar(segments, 'comp-bar'));
    })),
    h('ul', { class: 'comp-legend' }, state.meta.groups
      .filter((g) => picked.some((f) => (f.g?.[g.id] ?? 0) > 0))
      .map((g) => h('li', {},
        h('span', { class: 'swatch', style: `background:${groupColor(g.id)}` }),
        h('span', {}, label(g, state.lang)))))
  );
}

/** Every figure that differs, one row per measure, best marked. */
function compareTable(picked) {
  const row = (spec, isFact) => {
    const values = picked.map((f) => spec.get(f));
    // Compared at the precision the row PRINTS at. Two funds both showing
    // "▲ %5,3" are the same number as far as this page is concerned, and marking
    // one of them the winner over a third decimal nobody can see reads as a bug.
    const best = isFact
      ? new Set()
      : bestIndexes(values.map((v) => roundTo(v, spec.digits)), spec.dir);
    return h('tr', {},
      h('th', { scope: 'row' }, T(spec.labelKey)),
      ...values.map((v, i) => h('td', {
        class: `num${best.has(i) ? ' is-best' : ''}`,
      },
        v == null || (typeof v === 'number' && !Number.isFinite(v))
          ? '—'
          : h('span', { class: spec.delta ? `delta ${signOf(v)}` : '' },
              isFact ? v : spec.fmt(v)))));
  };

  return h('section', { class: 'panel' },
    h('h2', {}, T('compareFigures')),
    h('div', { class: 'own-scroll' },
      h('table', { class: 'own-table compare-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, ''),
          ...picked.map((f, i) => h('th', { class: 'num' },
            h('span', { class: 'compare-swatch', style: `background:${compareColor(i)}` }),
            h('a', { class: 'code-link num', href: `#/fon/${f.c}` }, f.c))))),
        h('tbody', {},
          COMPARE_ROWS.map((spec) => row(spec, false)),
          COMPARE_FACTS.map((spec) => row(spec, true)))))
  );
}

/**
 * Whether these funds are actually different things.
 *
 * The figures above can differ in every row while the funds hold the same twelve
 * companies, and that is the single most useful thing a comparison can say. The
 * pairwise number says how much is duplicated; the list says what.
 */
function compareHoldings(picked, filings) {
  const weights = {};
  let filed = 0;
  for (const f of picked) {
    const rows = filings[f.c];
    if (!rows?.length) continue;
    weights[f.c] = weightsOf(rows);
    filed++;
  }
  if (filed < 2) return null;

  const pairs = overlappingPairs(weights, 0);
  const shared = sharedAcross(weights, { min: 2, limit: 12 });
  const codes = Object.keys(weights);

  return h('section', { class: 'panel' },
    h('h2', {}, T('compareOverlap')),
    h('ul', { class: 'compare-pairs' }, pairs.map((p) => h('li', {},
      h('span', { class: 'num' }, `${p.a} · ${p.b}`),
      h('span', { class: 'look-bar' },
        h('span', { class: 'look-fill', style: `width:${svgN(p.shared)}%;`
          + `background:${p.shared >= OVERLAP_FLOOR ? 'var(--down)' : 'var(--accent)'}` })),
      h('span', { class: 'look-pct' }, fmtPct(p.shared, state.lang, { digits: 1 }))))),
    shared.length
      ? h('div', { class: 'own-scroll' },
          h('table', { class: 'own-table compare-table' },
            h('thead', {}, h('tr', {},
              h('th', {}, T('portLookPosition')),
              ...codes.map((c) => h('th', { class: 'num' }, c)))),
            h('tbody', {}, shared.map((r) => h('tr', {},
              h('th', { scope: 'row' }, h('span', { class: 'num' }, r.code)),
              ...codes.map((c) => h('td', { class: 'num' },
                r.weights[c] == null
                  ? '—'
                  : fmtPct(r.weights[c], state.lang, { digits: 2 }))))))))
      : h('p', { class: 'panel-note' }, T('compareNoShared')),
    // Which of them could be looked at at all. A pair figure over two funds when
    // four were asked for is not an answer about the four.
    filed < picked.length
      ? h('p', { class: 'panel-note' },
          T('compareUnfiled', { n: picked.length - filed }))
      : null
  );
}

/** The compare toggle that rides beside the star on every fund row. */
function compareButton(code, onDone) {
  const on = compareSet.has(code);
  const btn = h('button', {
    type: 'button',
    class: `cmp-btn${on ? ' is-on' : ''}`,
    'aria-pressed': String(on),
    title: T(on ? 'compareRemove' : 'compareAdd'),
    'aria-label': `${T(on ? 'compareRemove' : 'compareAdd')} — ${code}`,
    onClick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (on) compareSet.delete(code);
      else if (compareSet.size < COMPARE_MAX) compareSet.add(code);
      btn.replaceWith(compareButton(code, onDone));
      onDone?.();
    },
  }, on ? '◧' : '◫');
  return btn;
}

/**
 * What happened while you were away.
 *
 * The data here changes every night and the page looks identical, which is a
 * strange property for something meant to be opened daily. This is the one panel
 * that is different every time precisely because it is about the gap since last
 * time — and it disappears entirely when there is nothing to say, which on a
 * second load the same morning is the honest answer.
 *
 * Nothing about it leaves the browser: the date is a `localStorage` key beside
 * the favourites, and it is read once and stamped over at boot so this is always
 * answering about the PREVIOUS visit.
 */
async function renderSinceVisit(favourites, slot) {
  const from = state.lastSeen;
  if (!from || !favourites.length) return;
  const codes = favourites.map((f) => f.c);
  const histories = await Promise.all(codes.map(loadHistory));
  if (state.page !== 'dash') return;

  // Today, explicitly: the gap the heading names is calendar days between two
  // dates, and the prices are read at the last print on or before each end.
  const out = sinceVisit(
    codes.map((code, i) => ({ code, series: histories[i] })), from, todayIso());
  if (!out || out.days < VISIT_MIN_DAYS) return;

  // Funds younger than the gap did not exist last time. A count only: the list
  // of them is what `#/populer` is for, and this panel is a glance.
  const fresh = newSince(state.funds, out.days).length;

  slot.replaceChildren(h('section', { class: 'panel dash-pane away-pane' },
    h('div', { class: 'dash-pane-head' },
      h('h2', {}, T('sinceVisit')),
      h('span', { class: 'dash-more' }, T('sinceVisitDays', { n: out.days }))),
    h('dl', { class: 'stat-row stat-row-inset' },
      h('div', { class: 'stat' },
        // A median, because a handful of funds is a small sample and one of them
        // doubling says nothing about the rest — the same reason the cash
        // comparison on this page is a median and says so.
        h('dt', { title: T('sinceVisitHint') }, T('sinceVisitMedian')),
        h('dd', { class: `delta ${signOf(out.median)}` },
          fmtPct(out.median, state.lang, { signed: true, digits: 1 })),
        h('span', { class: 'stat-sub num' },
          T('sinceVisitOf', { n: out.counted }))),
      h('div', { class: 'stat' },
        h('dt', {}, T('sinceVisitBest')),
        h('dd', { class: `delta ${signOf(out.best.pct)}` },
          fmtPct(out.best.pct, state.lang, { signed: true, digits: 1 })),
        h('span', { class: 'stat-sub num' }, out.best.code)),
      out.worst.code === out.best.code ? null : h('div', { class: 'stat' },
        h('dt', {}, T('sinceVisitWorst')),
        h('dd', { class: `delta ${signOf(out.worst.pct)}` },
          fmtPct(out.worst.pct, state.lang, { signed: true, digits: 1 })),
        h('span', { class: 'stat-sub num' }, out.worst.code)),
      !fresh ? null : h('div', { class: 'stat' },
        h('dt', {}, T('sinceVisitNew')),
        h('dd', {}, fmtInt(fresh, state.lang)),
        h('span', { class: 'stat-sub' },
          h('a', { href: '#/populer' }, T('dashMore')))))
  ));
}

/** Redraw only the compare strip, leaving the rest of the toolbar alone. */
function syncCompareBar() {
  const slot = document.getElementById('compare-slot');
  if (slot) slot.replaceChildren(...[compareBar()].filter(Boolean));
  measureChrome();
}

/**
 * The selection, shown in the toolbar rather than in a tray of its own.
 *
 * The toolbar is already sticky and already carries the chips, so a second
 * sticky layer would cost a row of the table and collide with the tab bar a
 * phone draws along the bottom.
 */
function compareBar() {
  if (compareSet.size < 1) return null;
  const codes = [...compareSet];
  return h('div', { class: 'compare-bar' },
    h('a', {
      class: `control compare-go${codes.length < 2 ? ' is-off' : ''}`,
      href: codes.length < 2 ? null : `#/karsilastir/${codes.join(',')}`,
    }, T('compareN', { n: codes.length })),
    h('button', {
      type: 'button', class: 'chip-clear',
      onClick: () => { compareSet.clear(); renderList(); },
    }, T('clearAll')));
}

// ---------------------------------------------------------------- shares
//
// Borsa İstanbul, the other way through the same data.
//
// A share page anywhere else can tell you what ASELS costs. What none of them
// can tell you is that 197 Turkish funds hold it, that between them they own
// 0.61% of the company, and that 91 of the 145 who filed a comparable position
// last month added to it. That takes every fund's filing at once, which is the
// one thing this project already has.
//
// So the figures come from the same feeds as everything else — TradingView for
// the fundamentals, Yahoo for the history, the 15-minute delayed scan for the
// live price — and the ownership comes from us.

/**
 * The CPI deflator: 2KB, fetched the first time somebody asks for real terms.
 *
 * Not on boot and not with the share page, because most readers never press the
 * button — and a page that is nominal until asked must not pay for a file it may
 * never use.
 */
let cpi = null;
let cpiJob = null;

function loadCpi() {
  if (cpi) return Promise.resolve(cpi);
  cpiJob ??= fetch(`${DATA}/cpi.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      // A file with no `latest` cannot deflate anything, and half a deflator is
      // worse than none: the toggle simply does nothing rather than restating
      // some periods and not others without saying which.
      cpi = data?.years && data?.latest ? data : null;
      return cpi;
    })
    .catch(() => null);
  return cpiJob;
}

/** The share index: 450KB, so it is loaded when a share page is opened, not on boot. */
let shares = null;
let sharesJob = null;

function loadShares() {
  if (shares) return Promise.resolve(shares);
  sharesJob ??= fetch(`${DATA}/stocks.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data?.stocks) return null;
      shares = {
        ...data,
        list: data.stocks,
        byCode: new Map(data.stocks.map((s) => [s.c, s])),
      };
      return shares;
    })
    .catch(() => null);
  return sharesJob;
}

const shareOf = (code) => shares?.byCode.get(code) ?? null;

/**
 * A holdings row's code as a link to whatever the row actually is.
 *
 * A filing lists three kinds of thing that have a page here, and they need three
 * different answers:
 *
 *   another fund   "PKT", "ACU - İSTANBUL" — a three-letter TEFAS code, sometimes
 *                  with the manager's name stuck to it. Checked against the fund
 *                  universe, which is already in memory, so a code that is not a
 *                  fund is never linked as one.
 *   a share        four or five letters on Borsa İstanbul.
 *   an ETF         also four or five letters on Borsa İstanbul, which is why the
 *                  share index carries the exchange-traded funds too: without
 *                  them "ZPLIB" led to a page that said the fund did not exist.
 *
 * The share index is 450KB and a fund page does not load it, so a ticker cannot
 * be checked before linking — it goes on the same resolution the pricing uses.
 * A delisted name reaches a page that says so, which is true, and cheaper than
 * half a megabyte on every fund page.
 */
function holdingLink(position) {
  const text = position.code ?? '—';
  const first = String(position.code ?? '').trim().toUpperCase().split(/[\s/,;.-]+/)[0];

  // A fund's own code beats anything else the row could be: it is exact, and the
  // fund page has more on it than a price ever will.
  const fundCode = position.ref && state.funds.some((f) => f.c === position.ref)
    ? position.ref
    : state.funds.some((f) => f.c === first) ? first : null;
  if (fundCode) return h('a', { class: 'holding-link', href: `#/fon/${fundCode}` }, text);

  const listing = listingOf(position);
  if (listing?.market !== 'bist') return null;
  // Only codes the exchange actually lists. Some filings hold small ETFs and
  // delisted names the scanner has never carried, and a link that lands on "no
  // such code" is worse than plain text.
  const listed = state.meta?.listedCodes;
  const ticker = listing.tickers.find((t) => !listed || listed.includes(t));
  return ticker ? h('a', { class: 'holding-link', href: `#/hisse/${ticker}` }, text) : null;
}

/**
 * The live quote for a share, or null.
 *
 * The same scan that prices fund holdings, so a share's move on its own page and
 * inside a fund's portfolio can never disagree.
 */
const shareQuote = (code) => state.quotes?.bist?.quotes?.[code] ?? null;

/** The price to show: the delayed live one where there is one, the close otherwise. */
function sharePrice(stock) {
  const quote = shareQuote(stock.c);
  return {
    price: quote?.price ?? stock.p,
    change: quote?.change ?? stock.ch,
    live: !!quote,
  };
}

// ---------------------------------------------------------------- the list

const SHARE_PAGE_SIZE = 60;

/**
 * The columns, in the order they are drawn.
 *
 * `get` is both the sort key and the cell, so a column cannot sort by one number
 * and print another — the bug that makes a table quietly lie.
 */
const SHARE_COLUMNS = [
  { key: 'cap', labelKey: 'marketCap', num: true,
    get: (s) => s.cap, cell: (s) => fmtMoney(s.cap, state.lang) },
  { key: 'ch', labelKey: 'dayChange', num: true, delta: true,
    get: (s) => sharePrice(s).change,
    cell: (s) => fmtPct(sharePrice(s).change, state.lang, { signed: true, digits: 2 }) },
  { key: 'm1', labelKey: 'return1m', num: true, delta: true,
    get: (s) => s.r?.m1, cell: (s) => fmtPct(s.r?.m1, state.lang, { signed: true, digits: 1 }) },
  { key: 'y1', labelKey: 'return1y', num: true, delta: true,
    get: (s) => s.r?.y1, cell: (s) => fmtPct(s.r?.y1, state.lang, { signed: true, digits: 1 }) },
  { key: 'pe', labelKey: 'peRatio', num: true,
    get: (s) => s.pe, cell: (s) => fmtNum(s.pe, state.lang, 1) },
  { key: 'dy', labelKey: 'dividendYield', num: true,
    get: (s) => s.dy, cell: (s) => fmtPct(s.dy, state.lang, { digits: 2 }) },
  { key: 'owners', labelKey: 'heldByFunds', num: true,
    get: (s) => s.own?.funds ?? 0,
    cell: (s) => (s.own ? fmtInt(s.own.funds, state.lang) : '—') },
  { key: 'owned', labelKey: 'fundOwned', num: true,
    get: (s) => s.own?.pctShares ?? null,
    cell: (s) => fmtPct(s.own?.pctShares, state.lang, { digits: 2 }) },
];

/** Filter and sort state for the share list. Survives navigation, like the funds'. */
const shareView = {
  search: '',
  theme: '',
  held: false,
  sort: { key: 'cap', dir: 'desc' },
  visible: SHARE_PAGE_SIZE,
};

/** Companies only. The index also carries ETFs and trusts, which have no P/E. */
const listedCompanies = () => shares.list.filter((s) => s.kind === 'stock');

function shareResults() {
  // The same matcher the masthead uses, so a query that finds ISMEN there finds
  // it here. It folds rather than upper-cases: `'ism'.toLocaleUpperCase('tr')`
  // is "İSM", which is not in "ISMEN" and never will be.
  const match = queryMatcher(shareView.search);
  let rows = listedCompanies();
  if (match) rows = rows.filter((s) => match(s.c, s.n) != null);
  if (shareView.theme) rows = rows.filter((s) => s.th === shareView.theme);
  if (shareView.held) rows = rows.filter((s) => s.own);

  const column = SHARE_COLUMNS.find((c) => c.key === shareView.sort.key);
  const dir = shareView.sort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const x = column.get(a);
    const y = column.get(b);
    // Missing figures sink whichever way the column is pointing: a share with no
    // P/E is not the cheapest share on the exchange.
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * dir;
  });
}

async function renderShareList() {
  state.page = 'shares';
  view.replaceChildren(h('p', { class: 'state-msg' }, T('loading')));
  const loaded = await loadShares();
  if (state.page !== 'shares') return;
  if (!loaded) {
    view.replaceChildren(h('div', { class: 'state-msg' }, h('p', {}, T('sharesUnavailable'))));
    return;
  }

  // The controls are built ONCE and only the rows are redrawn. A full redraw on
  // every keystroke — which is what this did — replaces the input element under
  // the caret, so every second letter went nowhere.
  // No heading. The nav says Hisseler, the table says the rest, and a title over
  // a paragraph explaining what a share is spends the top of the screen on
  // something nobody reads twice.
  view.replaceChildren(
    subNav('/hisseler'),
    shareBar(),
    h('div', { id: 'share-rows' }),
    h('p', { class: 'panel-note', id: 'share-stamp' })
  );
  drawShares(true);
  // The whole exchange comes back in one request, so every row on the page is
  // priced by a single call.
  ensureQuotes(null).then(() => { if (state.page === 'shares') drawShares(); });
}

/** Search, theme, held-only and the count. Rendered once per visit. */
function shareBar() {
  return h('div', { class: 'share-bar' },
    h('input', {
      type: 'search', class: 'share-search', value: shareView.search,
      placeholder: T('shareSearch'), 'aria-label': T('shareSearch'),
      onInput: debounce((e) => { shareView.search = e.target.value; drawShares(true); }, 150),
    }),
    h('select', {
      class: 'share-theme', 'aria-label': T('themeLabel'),
      onChange: (e) => { shareView.theme = e.target.value; drawShares(true); },
    },
      h('option', { value: '', selected: !shareView.theme }, T('themeAny')),
      THEME_IDS.map((id) => h('option', { value: id, selected: shareView.theme === id }, themeName(id)))),
    h('label', { class: 'check' },
      h('input', {
        type: 'checkbox', checked: shareView.held,
        onChange: (e) => { shareView.held = e.target.checked; drawShares(true); },
      }),
      h('span', {}, T('heldOnly'))),
    h('span', { class: 'share-count', id: 'share-count' })
  );
}

function drawShares(fresh = false) {
  const host = document.getElementById('share-rows');
  if (!host) return;
  if (fresh) shareView.visible = SHARE_PAGE_SIZE;
  const rows = shareResults();

  // Sorting lives on the headers here rather than in a toolbar select as it does
  // on the fund list: a share table is read by ranking it — cheapest, most held,
  // biggest faller — and a column you can click is the shortest way to say that.
  const sortBy = (col) => {
    if (shareView.sort.key === col.key) {
      shareView.sort.dir = shareView.sort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      shareView.sort = { key: col.key, dir: 'desc' };
    }
    drawShares(true);
  };

  const head = h('thead', {},
    h('tr', {},
      h('th', { class: 'col-fav', 'aria-label': T('favorites') }, '★'),
      h('th', { class: 'col-code cell-code' }, T('code')),
      h('th', { class: 'col-name cell-name' }, T('company')),
      SHARE_COLUMNS.map((col) => {
        const on = shareView.sort.key === col.key;
        return h('th', {
          class: 'col-figure num-cell sortable',
          role: 'button',
          tabindex: '0',
          'aria-sort': on ? (shareView.sort.dir === 'asc' ? 'ascending' : 'descending') : null,
          onClick: () => sortBy(col),
          onKeydown: (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            sortBy(col);
          },
        }, T(col.labelKey), on ? h('span', { class: 'sort-arrow' }, shareView.sort.dir === 'asc' ? ' ↑' : ' ↓') : null);
      })
    )
  );

  // Filtered, not passed straight through: `replaceChildren` takes nodes OR
  // strings, so a null argument is not skipped the way h() skips one — it is
  // stringified, and the word "null" appears under the table.
  host.replaceChildren(...[
    rows.length
      ? h('div', { class: 'table-wrap' },
          h('table', { class: 'funds share-table' }, head,
            h('tbody', {}, rows.slice(0, shareView.visible).map(shareRow))))
      : h('div', { class: 'table-wrap' },
          h('div', { class: 'state-msg' }, h('p', {}, T('noResults')))),
    rows.length > shareView.visible
      ? h('div', { class: 'more-row' },
          h('button', {
            type: 'button', class: 'btn',
            onClick: () => { shareView.visible += SHARE_PAGE_SIZE; drawShares(); },
          }, T('showMore')))
      : null,
  ].filter(Boolean));

  const count = document.getElementById('share-count');
  if (count) count.textContent = T('shareCount', { n: fmtInt(rows.length, state.lang) });

  const stamp = document.getElementById('share-stamp');
  const quotes = state.quotes?.bist;
  if (stamp) {
    stamp.textContent = quotes
      ? T('sharesStamp', { n: Math.round((quotes.delaySeconds ?? 900) / 60) })
      : T('sharesClose', { date: fmtDate(shares.latestDate, state.lang) });
  }
}

function shareRow(stock, onFav = () => drawShares()) {
  const { live } = sharePrice(stock);
  return h('tr', {},
    h('td', { class: 'col-fav' }, favButton(stock.c, onFav)),
    h('td', { class: 'col-code cell-code' },
      h('a', { class: 'num', href: `#/hisse/${stock.c}` }, stock.c)),
    h('td', { class: 'col-name cell-name' },
      h('a', { href: `#/hisse/${stock.c}` }, stock.n),
      stock.th ? h('span', { class: 'row-sub' }, themeName(stock.th)) : null),
    SHARE_COLUMNS.map((col) =>
      h('td', { class: `col-figure num-cell${col.delta ? ` delta ${signOf(col.get(stock))}` : ''}` },
        // The dot marks the two cells the exchange is feeding live; the rest of
        // the row is last night's close and must not borrow its currency.
        col.key === 'ch' && live ? h('span', { class: 'live-dot', 'aria-hidden': 'true' }) : null,
        col.cell(stock)))
  );
}

// ---------------------------------------------------------------- one share

async function renderShare(code) {
  state.page = 'share';
  view.replaceChildren(h('p', { class: 'state-msg' }, T('loading')));
  const loaded = await loadShares();
  if (!location.hash.endsWith(`/${code}`)) return;

  const stock = loaded?.byCode.get(code);
  if (!stock) {
    // Its own wording, not the fund page's: "fon bulunamadı" under a /hisse/
    // address told the reader the wrong thing about what it had failed to find.
    view.replaceChildren(h('div', { class: 'state-msg' },
      h('p', {}, T('shareNotFound', { code })),
      h('a', { class: 'back-link', href: '#/hisseler' }, `← ${T('navShares')}`)));
    return;
  }

  // Both in flight at once: the statements are a separate file and waiting for
  // one after the other would put the page a round trip further away.
  const [history, fin] = await Promise.all([loadHistory(code), loadFundamentals(stock)]);
  if (!location.hash.endsWith(`/${code}`)) return;

  const draw = () => {
    if (state.page !== 'share') return;
    const el = document.getElementById('share-figures');
    if (el) el.replaceWith(shareFigures(stock));
  };

  // Filtered, not spread straight in. replaceChildren() takes nodes OR strings,
  // so a panel that declines to draw itself — a company with no dividend record,
  // no forecasts, no peers — arrives as the literal text "null" on the page.
  // h() skips nullish children; this is the one place that does not.
  view.replaceChildren(...[
    h('div', { class: 'detail-head' },
      h('a', { class: 'back-link', href: '#/hisseler' }, `← ${T('navShares')}`),
      h('div', { class: 'detail-id' },
        h('div', { class: 'detail-code num' }, stock.c),
        favButton(stock.c)
      ),
      h('h1', { class: 'detail-title' }, stock.n),
      h('ul', { class: 'chips' },
        // An exchange-traded fund has a price and a chart like a share and no
        // earnings at all, so the page says which it is looking at rather than
        // leaving a reader to wonder where the P/E went.
        stock.kind === 'stock' ? null
          : h('li', { class: 'chip chip-ok' }, T(stock.kind === 'trust' ? 'kindTrust' : 'kindEtf')),
        // Which headline index it is in, and which market it trades on. The
        // watchlist market is the one worth colouring: a company is put there
        // by the exchange, not by choice.
        stock.bx ? h('li', { class: 'chip chip-ok' }, `BIST ${stock.bx}`) : null,
        marketChip(stock.mkt),
        stock.spec ? h('li', { class: 'chip chip-warn' }, T('specChip')) : null,
        stock.th ? h('li', { class: 'chip' },
          // A link back into the funds, because "who buys this kind of company"
          // is the question a share page cannot answer on its own. The filter is
          // set here rather than passed in the hash: the router takes routes, and
          // giving it a query string would be a second way to say the same thing.
          h('a', {
            href: listHref('/fonlar'),
            onClick: () => {
              state.filters.theme = stock.th;
              state.filters.minTheme = MIN_THEME;
            },
          }, T('fundsInTheme', { name: themeName(stock.th) }))) : null,
        // Sector and industry stay in the exchange's own English. Translating a
        // hundred and thirty industry names would be inventing a taxonomy.
        stock.ind ? h('li', { class: 'chip chip-quiet' }, stock.ind) : null,
        stock.sec ? h('li', { class: 'chip chip-quiet' }, stock.sec) : null
      )
    ),
    shareFigures(stock),
    history.length > 5
      ? renderShareChart(stock, history)
      : h('section', { class: 'panel' }, h('p', { class: 'panel-note' }, T('noHistory'))),
    // Before the statements, because it is the reason to read them sceptically.
    shareBoard(stock),
    // What the company earns comes before what the market charges for it: the
    // multiples in the grid below are all ratios to these numbers.
    renderFinancials(stock, fin),
    h('div', { class: 'share-grid' },
      shareOwnership(stock),
      sharePanel('shareValuation', [
        ['peRatio', multiple(stock.pe), 'peNote'],
        ['pbRatio', multiple(stock.pb, 2), 'pbNote'],
        ['psRatio', multiple(stock.ps, 2), null],
        ['evEbitda', multiple(stock.evEbitda), null],
        ['eps', money(stock.eps, 2), 'epsNote'],
        ['epsGrowth', pct(stock.epsG, 1, true), null],
        ['dividendYield', pct(stock.dy, 2), 'shareYieldNote'],
        ['payout', pct(stock.payout, 1), 'payoutNote'],
        ['dps', money(stock.dps, 4), null],
      ]),
      sharePanel('shareBusiness', [
        ['revenue', fmtMoney(stock.rev, state.lang), null],
        ['netIncome', fmtMoney(stock.ni, state.lang), null],
        ['ebitda', fmtMoney(stock.ebitda, state.lang), null],
        ['freeCashFlow', fmtMoney(stock.fcf, state.lang), 'fcfNote'],
        ['grossMargin', pct(stock.gm, 1), null],
        ['operatingMargin', pct(stock.om, 1), null],
        ['netMargin', pct(stock.nm, 1), null],
        ['roe', pct(stock.roe, 1), 'roeNote'],
        ['roic', pct(stock.roic, 1), null],
        ['debtEquity', fmtNum(stock.de, state.lang, 2), 'debtEquityNote'],
        ['currentRatio', fmtNum(stock.cur, state.lang, 2), null],
        ['totalDebt', fmtMoney(stock.debt, state.lang), null],
        ['revenuePerStaff', fmtMoney(stock.revPer, state.lang), null],
        ['staff', fmtInt(stock.staff, state.lang), null],
      ]),
      shareBalance(stock),
      shareTrading(stock),
      shareAnalysts(stock),
      shareHealth(stock)
    ),
    renderDividends(stock, fin),
    renderEstimates(stock, fin),
    renderPeers(stock)
  ].filter(Boolean));

  // The whole exchange in one request, then the figures redraw with the live
  // price in them. The share list and every fund page share the same scan, and
  // the refresh loop keeps calling this while the page is open.
  sharePage = draw;
  ensureQuotes(null).then(draw);
  window.scrollTo({ top: 0 });
}

/** Formatters that answer "—" rather than "NaN" for a figure the source omits. */
const pct = (v, digits = 1, signed = false) =>
  v == null ? '—' : fmtPct(v, state.lang, { digits, signed });
const money = (v, digits = 2) => (v == null ? '—' : `₺${fmtNum(v, state.lang, digits)}`);

/**
 * A valuation multiple, with decimals only where they mean anything.
 *
 * A P/E of 9.4 and one of 9.5 are different claims; İş Bankası's founder share
 * is filed at 1,518,274.5 and the ".5" is noise on a figure that is really
 * saying "this class of share has almost no earnings behind it". Above a
 * hundred the decimal comes off.
 */
const multiple = (v, digits = 1) =>
  v == null ? '—' : fmtNum(v, state.lang, Math.abs(v) >= 100 ? 0 : digits);

/** The headline strip: what it costs now, and what it has done. */
function shareFigures(stock) {
  const { price, change, live } = sharePrice(stock);
  const stat = (dt, dd, cls) =>
    h('div', { class: 'stat' }, h('dt', {}, dt), h('dd', { class: cls }, dd));
  const ret = (key, labelKey) =>
    stock.r?.[key] == null ? null
      : stat(T(labelKey), fmtPct(stock.r[key], state.lang, { signed: true, digits: 1 }),
          `delta ${signOf(stock.r[key])}`);

  return h('dl', { class: 'stat-row', id: 'share-figures' },
    stat(T('price'), money(price, 2)),
    stat(
      live ? [h('span', { class: 'live-dot', 'aria-hidden': 'true' }), T('dayChange')] : T('dayChange'),
      fmtPct(change, state.lang, { signed: true, digits: 2 }),
      `delta ${signOf(change)}`
    ),
    stat(T('marketCap'), fmtMoney(stock.cap, state.lang)),
    ret('m1', 'return1m'),
    ret('ytd', 'returnYtd'),
    ret('y1', 'return1y'),
    ret('y5', 'return5y'),
    stock.own ? stat(T('heldByFunds'), fmtInt(stock.own.funds, state.lang)) : null
  );
}

/** A panel of label/figure rows, skipping the ones this company does not report. */
function sharePanel(titleKey, rows) {
  const kept = rows.filter(([, value]) => value !== '—');
  if (!kept.length) return null;
  return h('section', { class: 'panel share-panel' },
    h('h2', {}, T(titleKey)),
    h('dl', { class: 'figure-list' },
      kept.map(([labelKey, value, noteKey]) =>
        h('div', { class: 'figure' },
          noted('dt', {}, T(labelKey), noteKey ? T(noteKey) : null),
          h('dd', { class: 'num' }, value))))
  );
}

/**
 * Who owns the share.
 *
 * The panel the rest of the internet cannot draw, so it leads: the count of
 * funds, what they hold between them, how much of the company that is, and which
 * way they moved it last month.
 */
function shareOwnership(stock) {
  const own = stock.own;
  if (!own) {
    return h('section', { class: 'panel share-panel' },
      h('h2', {}, T('shareOwners')),
      h('p', { class: 'panel-note' }, T('shareNoOwners')));
  }

  const moved = own.compared > 0;
  return h('section', { class: 'panel share-panel share-owners' },
    h('h2', {}, T('shareOwners')),
    h('p', { class: 'panel-note' }, T('shareOwnersNote')),
    h('dl', { class: 'stat-row stat-row-inset' },
      h('div', { class: 'stat' },
        h('dt', {}, T('heldByFunds')), h('dd', {}, fmtInt(own.funds, state.lang))),
      h('div', { class: 'stat' },
        h('dt', {}, T('heldValue')), h('dd', {}, fmtMoney(own.value, state.lang))),
      h('div', { class: 'stat' },
        h('dt', { title: T('fundOwnedNote') }, T('fundOwned')),
        h('dd', {}, pct(own.pctShares, 2))),
      own.pctCap == null ? null : h('div', { class: 'stat' },
        h('dt', { title: T('byValueNote') }, T('byValue')),
        h('dd', {}, pct(own.pctCap, 2)))
    ),
    moved
      ? h('p', { class: 'own-move' },
          h('b', { class: 'delta up' }, T('addedBy', { n: own.adding })),
          h('span', {}, ' · '),
          h('b', { class: 'delta down' }, T('trimmedBy', { n: own.trimming })),
          h('span', { class: 'own-basis' }, T('ofCompared', { n: own.compared })))
      : h('p', { class: 'panel-note' }, T('noComparable')),
    h('div', { class: 'own-scroll' }, h('table', { class: 'own-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, T('fund')),
        h('th', { class: 'num' }, T('heldValue')),
        h('th', { class: 'num', title: T('ownWeightNote') }, T('ownWeight')),
        h('th', { class: 'num', title: T('ownMoveNote') }, T('ownMove')))),
      h('tbody', {}, own.top.map((row) => {
        const fund = state.funds.find((f) => f.c === row.c);
        return h('tr', {},
          h('td', {},
            h('a', { class: 'code-link num', href: `#/fon/${row.c}` }, row.c),
            fund ? h('span', { class: 'row-sub' }, fund.n) : null),
          h('td', { class: 'num' }, fmtMoney(row.v, state.lang)),
          h('td', { class: 'num' }, pct(row.w, 2)),
          h('td', { class: `num delta ${signOf(row.m)}` },
            row.m == null ? '—' : fmtPct(row.m, state.lang, { signed: true, digits: 2 })));
      }))
    ))
  );
}

/** Where the price sits, how much of it trades, and how hard it moves. */
function shareTrading(stock) {
  const { price } = sharePrice(stock);
  const position = rangePosition(price, stock.lo52, stock.hi52);

  return h('section', { class: 'panel share-panel' },
    h('h2', {}, T('shareTrading')),
    position == null ? null : h('div', { class: 'range-bar' },
      h('div', { class: 'range-track' },
        h('span', { class: 'range-mark', style: `left:${position}%` })),
      h('div', { class: 'range-ends num' },
        h('span', {}, money(stock.lo52, 2)),
        h('span', { class: 'range-label' }, T('range52')),
        h('span', {}, money(stock.hi52, 2)))
    ),
    h('dl', { class: 'figure-list' },
      [
        ['volume', fmtInt(stock.vol, state.lang), null],
        ['avgVolume', fmtInt(stock.avgVol, state.lang), 'avgVolumeNote'],
        ['relVolume', fmtNum(stock.relVol, state.lang, 2), 'relVolumeNote'],
        ['volatility1m', pct(stock.vola, 2), 'shareVolNote'],
        ['beta', fmtNum(stock.beta, state.lang, 2), 'betaNote'],
        ['rsi', fmtNum(stock.rsi, state.lang, 0), 'rsiNote'],
        ['sma50', money(stock.sma50, 2), 'smaNote'],
        ['sma200', money(stock.sma200, 2), 'smaNote'],
        ['freeFloat', pct(stock.float, 1), 'floatNote'],
        ['sharesOut', fmtInt(stock.shares, state.lang), null],
      ].filter(([, value]) => value !== '—' && value !== '')
        .map(([labelKey, value, noteKey]) =>
          h('div', { class: 'figure' },
            noted('dt', {}, T(labelKey), noteKey ? T(noteKey) : null),
            h('dd', { class: 'num' }, value))))
  );
}

/**
 * The share against the index it lives in.
 *
 * One series is a price; two are a comparison, and the only comparison worth
 * drawing for a Turkish share is the one that says whether it beat the market it
 * is part of. The chart indexes both to 100 as soon as the second is ticked.
 */
function renderShareChart(stock, history) {
  // loadHistory() hands back [date, price] pairs, the same shape the watchlist
  // draws — the file's own records never reach here.
  const raw = { share: history };
  const bist = state.benchmarks.filter((r) => r.bist100 != null).map((r) => [r.d, r.bist100]);
  if (bist.length > 5) raw.bist100 = bist;

  return renderChart({
    raw,
    emphasis: 'share',
    titleKey: 'sharePriceChart',
    series: [
      { key: 'share', color: 'var(--accent)', width: 2.5, prefix: '₺', tipDigits: 2,
        axisDigits: null, name: () => stock.c },
      ...(raw.bist100
        ? [{ key: 'bist100', color: 'var(--g-equity)', width: 2, prefix: '',
            tipDigits: 0, axisDigits: 0, name: () => T('bist100') }]
        : []),
    ],
  });
}

// ---------------------------------------------------------------- portfolio
//
// Two questions that turned out to be one. "What has this done since I starred
// it" needs the date; "what is my portfolio worth" needs the date and a size.
// So a position is a favourite that knows when it arrived, and optionally how
// much of it there is.

/**
 * The portfolio page.
 *
 * Everything starred, in one table, whether or not a size has been entered. A
 * row with no size still answers the first question, which is why the page is
 * worth opening before anybody has typed a number into it.
 */
async function renderPortfolio() {
  state.page = 'portfolio';
  const codes = Object.keys(state.positions);
  if (!codes.length) {
    view.replaceChildren(
      renderPortfolioHead(),
      portfolioAdd(),
      h('div', { class: 'state-msg' }, h('p', {}, T('portfolioEmpty')))
    );
    return;
  }

  view.replaceChildren(renderPortfolioHead(), h('p', { class: 'state-msg' }, T('loading')));

  // Shares need the index for their names, and every row needs its own history
  // to be able to say what it was worth on the day it was starred.
  const needsShares = codes.some(isShareCode);
  const [, histories] = await Promise.all([
    needsShares ? loadShares() : Promise.resolve(null),
    Promise.all(codes.map(loadHistory)),
  ]);
  if (state.page !== 'portfolio') return;
  const history = new Map(codes.map((c, i) => [c, histories[i]]));

  const table = h('div', { class: 'table-wrap' });
  const summary = h('div', { id: 'port-summary' });
  const panels = h('div', { id: 'port-panels' });
  // Correlation needs the price histories, which this page has already loaded
  // for the rows. Computed once here rather than on every quote refresh: it is
  // the one figure on the page that a live price cannot change.
  const together = correlationMatrix(
    codes.filter((c) => !isShareCode(c)).map((c) => ({ code: c, series: history.get(c) })));
  // The add control is built once and sits outside everything redraw() replaces,
  // for the same reason the rows do: a live quote arriving must not take the
  // caret out of a field somebody is typing a code into.
  view.replaceChildren(renderPortfolioHead(), summary, portfolioAdd(), table, panels);

  // Built once. The rows carry text inputs, and rebuilding the table on every
  // keystroke would take the caret out of the field being typed into — the same
  // trap the chart pickers and the search boxes each had to be written around.
  const rows = codes.map((code) => portfolioRow(code, history.get(code), redraw));
  table.replaceChildren(h('table', { class: 'funds port-table' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'col-fav', 'aria-label': T('posLots') }, ''),
      h('th', {}, T('code')),
      h('th', { class: 'num-cell' }, T('posSinceShort')),
      h('th', { class: 'num-cell' }, T('posUnits')),
      h('th', { class: 'num-cell' }, T('posAvg')),
      h('th', { class: 'num-cell' }, T('posPrice')),
      h('th', { class: 'num-cell' }, T('posValue')),
      h('th', { class: 'num-cell', title: T('posCostHint') }, T('posProfit')))),
    // The drawer is a row of its own behind each one, so opening it does not
    // have to nest a second table inside a cell.
    h('tbody', {}, rows.map((r) => [r.tr, r.drawerRow]))
  ));

  // The filings every fund on the page has, keyed by code. Empty until they
  // arrive, and the look-through panel simply is not drawn until then — it is
  // the one thing here that needs a second round of requests, and the rest of
  // the page must not wait on it.
  let filings = {};

  function redraw() {
    if (state.page !== 'portfolio') return;
    const valued = rows.map((r) => r.refresh()).filter(Boolean);
    summary.replaceChildren(
      ...[portfolioDonut(valued), portfolioSummary(valued, history)].filter(Boolean));
    panels.replaceChildren(...portfolioPanels(valued, filings, together).filter(Boolean));
  }

  redraw();
  // Share prices arrive after the page is drawn, and again on every refresh.
  portfolioView = redraw;
  ensureQuotes(null).then(redraw);
  loadPortfolioFilings(codes).then((loaded) => {
    if (state.page !== 'portfolio') return;
    filings = loaded;
    redraw();
  });
  window.scrollTo({ top: 0 });
}

function renderPortfolioHead() {
  return h('section', { class: 'page-head' },
    h('p', { class: 'eyebrow' }, T('portfolio')),
    h('h1', { class: 'page-title' }, T('portfolio'))
  );
}

/**
 * One row: what you hold, at what average, and what it has done.
 *
 * No inputs. A row is a summary of its lots, and the lots are edited in the
 * drawer it opens — putting a units box on the row was fine while a position
 * WAS a units box, and stopped being fine the moment it became a list of buys
 * at different prices.
 */
function portfolioRow(code, series, onChange) {
  const share = isShareCode(code);
  const meta = share ? shareOf(code) : state.funds.find((f) => f.c === code);
  const priceThen = (iso) => priceOn(series, iso);

  const cell = (labelKey, cls = 'num num-cell') =>
    h('td', { class: cls, 'data-label': T(labelKey) });
  const sinceCell = cell('posSinceShort');
  const unitsCell = cell('posUnits');
  const avgCell = cell('posAvg');
  const priceCell = cell('posPrice');
  const valueCell = cell('posValue');
  const profitCell = cell('posProfit');
  const lotsLabel = h('span', { class: 'row-sub port-added' });

  // The drawer is built once and kept: it holds the fields somebody edits, and
  // rebuilding it on a quote refresh would take the caret out of one of them.
  let drawer = null;
  const drawerRow = h('tr', { class: 'port-drawer-row', hidden: true },
    h('td', { colspan: 8 }));

  const toggle = h('button', {
    type: 'button', class: 'port-open', 'aria-expanded': 'false',
    'aria-label': `${T('posLots')} — ${code}`,
    onClick: () => {
      const open = drawerRow.hidden;
      drawerRow.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      tr.classList.toggle('is-open', open);
      if (open && !drawer) {
        drawer = lotEditor(code, meta, series, () => {
          // A lot changed: the row, the totals and the drawer's own figures all
          // read the same list, so one redraw settles all three.
          onChange();
          drawer.refresh();
        });
        drawerRow.firstChild.replaceChildren(drawer.el);
      }
      if (open) drawer.refresh();
    },
  }, '▸');

  const tr = h('tr', { class: 'port-row' },
    h('td', { class: 'col-fav' }, toggle),
    h('td', {},
      h('a', { class: 'code-link num', href: `#/${share ? 'hisse' : 'fon'}/${code}` }, code),
      h('span', { class: 'row-sub' }, meta?.n ?? ''),
      lotsLabel),
    sinceCell,
    unitsCell,
    avgCell,
    priceCell,
    valueCell,
    profitCell
  );

  /** Recompute every cell from the lots, and hand the valuation to the totals. */
  function refresh() {
    if (!tr.isConnected) return null;
    const lots = state.positions[code];
    if (!lots?.length) return null;
    const now = priceNow(code, share, meta, series);
    const pos = positionOf(lots, now, priceThen);
    if (!pos) return null;

    const from = priceEntryOn(series, pos.at);
    const since = returnSince(now, from?.[1] ?? null);

    lotsLabel.textContent = [
      from ? T('posSince', { date: fmtDate(from[0], state.lang) }) : null,
      pos.buys + pos.sells > 1 ? T('posLotCount', { n: pos.buys + pos.sells }) : null,
    ].filter(Boolean).join(' · ');

    sinceCell.className = `num num-cell delta ${signOf(since)}`;
    sinceCell.textContent = since == null
      ? '—' : fmtPct(since, state.lang, { signed: true, digits: 1 });

    unitsCell.textContent = fmtNum(pos.units, state.lang, pos.units % 1 ? 2 : 0);
    avgCell.textContent = pos.avg == null ? '—' : money(pos.avg, priceDigits(pos.avg));
    priceCell.textContent = now == null ? '—' : money(now, priceDigits(now));
    valueCell.textContent = pos.value == null ? '—' : fmtMoney(pos.value, state.lang);

    // Unrealised on top, and what selling already banked underneath it. Adding
    // the two into one figure would put money you have been paid and money you
    // might yet be paid behind the same number.
    profitCell.className = `num num-cell delta ${signOf(pos.profit)}`;
    profitCell.replaceChildren(...(pos.profit == null
      ? [text('—')]
      : [
          text(fmtMoney(pos.profit, state.lang)),
          h('span', { class: 'row-sub' },
            fmtPct(pos.pct, state.lang, { signed: true, digits: 1 })
            + (pos.assumed ? ` · ${T('posAssumed')}` : '')),
        ]));
    if (pos.realised != null && pos.realised !== 0) {
      profitCell.append(h('span', { class: `row-sub delta ${signOf(pos.realised)}` },
        T('posRealised', { v: fmtMoney(pos.realised, state.lang) })));
    }

    if (drawer && !drawerRow.hidden) drawer.refresh();

    return {
      code, share, ...pos, from: from?.[0] ?? null,
      change: dayChangeOf(code, share, meta),
      groups: share ? null : meta?.g, spec: share ? null : meta?.spec,
    };
  }

  return { tr, drawerRow, refresh };
}

/**
 * The drawer: every lot the position is made of, and the two ways to change it.
 *
 * Editable in place, because a mistyped cost is the most likely reason anybody
 * opens this at all. Deleting a lot is a `×` per row rather than one control
 * that clears the position: the whole point of keeping the lots is that they are
 * separately wrong.
 */
function lotEditor(code, meta, series, onChange) {
  const share = isShareCode(code);
  const priceThen = (iso) => priceOn(series, iso);
  const lotList = h('div', { class: 'lot-list' });
  const summary = h('p', { class: 'lot-summary' });

  const buy = lotForm(code, meta, series, 'buy', onChange);
  const sell = lotForm(code, meta, series, 'sell', onChange);
  // The rows are rebuilt only when the LIST changed — one added, one deleted,
  // one moved to another day. Rebuilding them on every keystroke would replace
  // the input being typed into, which is the trap every other live-editing
  // surface on this site had to be written around.
  let listing = null;

  const el = h('div', { class: 'port-drawer' },
    h('div', { class: 'lot-head' },
      h('h3', {}, T('posLots')),
      summary),
    lotList,
    h('div', { class: 'lot-forms' }, buy.el, sell.el)
  );

  function refresh() {
    const lots = state.positions[code] ?? [];
    const now = priceNow(code, share, meta, series);
    const pos = positionOf(lots, now, priceThen);

    summary.replaceChildren(...(pos
      ? [
          h('span', {}, T('posHeld', {
            n: fmtNum(pos.units, state.lang, pos.units % 1 ? 2 : 0),
          })),
          pos.avg == null ? null : h('span', {},
            `${T('posAvg')} ${money(pos.avg, priceDigits(pos.avg))}`),
          pos.realised == null || pos.realised === 0 ? null : h('span',
            { class: `delta ${signOf(pos.realised)}` },
            T('posRealised', { v: fmtMoney(pos.realised, state.lang) })),
        ].filter(Boolean)
      : []));

    // Newest first, which is the order somebody looking for the one they just
    // typed expects. The index into the stored list travels with the row, so
    // the display order cannot edit the wrong lot.
    const signature = `${lots.length}|${lots.map((l) => l.at).join(',')}`;
    if (signature !== listing) {
      listing = signature;
      const ordered = lots
        .map((lot, index) => ({ lot, index }))
        .sort((a, b) => String(b.lot.at ?? '').localeCompare(String(a.lot.at ?? '')));
      lotList.replaceChildren(
        ...ordered.map(({ lot, index }) => lotRow(code, lot, index, onChange)));
    }
    sell.setMax(pos?.units ?? 0);
  }

  return { el, refresh };
}

/** One lot, editable: the day, the size, and what changed hands. */
function lotRow(code, lot, index, onChange) {
  const sale = lot.units < 0;
  const field = (props) => h('input', {
    type: 'text', inputmode: 'decimal', class: 'port-input', ...props,
  });

  return h('div', { class: `lot-row ${sale ? 'is-sale' : ''}` },
    h('span', { class: 'lot-kind' }, T(sale ? 'posSell' : 'posBuy')),
    h('input', {
      type: 'date', class: 'port-date lot-date', value: lot.at ?? '', max: todayIso(),
      'aria-label': `${T('posAdded')} — ${code}`,
      onChange: (e) => { setLot(code, index, 'at', e.target.value); onChange(); },
    }),
    field({
      class: 'port-input lot-units',
      value: toField(Math.abs(lot.units), 4), 'aria-label': T('posUnits'), title: T('posUnitsHint'),
      onInput: (e) => {
        const n = decimal(e.target.value);
        // The sign is the lot's kind and is not something a text box may flip.
        setLot(code, index, 'units', n == null ? null : (sale ? -n : n));
        onChange();
      },
    }),
    field({
      class: 'port-input lot-money',
      value: toField(lot.price, 6), 'aria-label': T(sale ? 'posSellPrice' : 'posUnitPrice'),
      title: T(sale ? 'posSellPriceHint' : 'posUnitPriceHint'),
      onInput: (e) => { setLot(code, index, 'price', decimal(e.target.value)); onChange(); },
    }),
    // How long this purchase has been held. A fact, and only a fact: what a year
    // means for anybody's withholding depends on rules that have been amended
    // repeatedly, so the row states the age and claims nothing about it.
    lotAge(lot),
    h('button', {
      type: 'button', class: 'port-remove lot-remove',
      title: T('posLotRemove'), 'aria-label': `${T('posLotRemove')} — ${code}`,
      onClick: () => { removeLot(code, index); onChange(); },
    }, '×')
  );
}

/**
 * A buy's age. Nothing for a sale: its clock stopped when it was sold.
 *
 * A plain fact, and only a fact. It carried a tax countdown for a while, which
 * was wrong: the exemption this site models has no holding period at all, so
 * counting down to it invented a decision nobody has. The one exemption that
 * does turn on a year needs each fund's izahname, which is not read here.
 */
function lotAge(lot) {
  const [age] = lotAges([lot], todayIso());
  if (!age) return null;
  return h('span', {
    class: 'lot-age',
    title: age.on ? T('posTurnsOn', { date: fmtDate(age.on, state.lang) }) : T('posOverYear'),
  }, T('posHeldDays', { n: fmtInt(age.days, state.lang) }));
}

/**
 * The buy and sell forms, which are the same three fields twice.
 *
 * Both open with today's price already in them, because that is what a lot
 * being entered right now went for unless you say otherwise — and both let you
 * say otherwise, after which they stop guessing. Sell adds "all of it", which is
 * the amount nobody wants to look up and retype.
 */
function lotForm(code, meta, series, kind, onChange) {
  const sale = kind === 'sell';
  const share = isShareCode(code);
  let held = 0;
  let touched = false;

  const unitsInput = h('input', {
    type: 'text', inputmode: 'decimal', class: 'port-input lot-units',
    'aria-label': T('posUnits'), placeholder: T('posUnits'),
  });
  const moneyInput = h('input', {
    type: 'text', inputmode: 'decimal', class: 'port-input lot-money',
    'aria-label': T(sale ? 'posSellPrice' : 'posUnitPrice'),
    placeholder: T(sale ? 'posSellPrice' : 'posUnitPrice'),
    title: T(sale ? 'posSellPriceHint' : 'posUnitPriceHint'),
    // Once it has been typed into, it is the reader's number and the form stops
    // writing over it. Emptying it hands the guess back.
    onInput: (e) => { touched = e.target.value.trim() !== ''; },
  });
  const dateInput = h('input', {
    type: 'date', class: 'port-date lot-date', value: todayIso(), max: todayIso(),
    'aria-label': T('posAdded'),
    onChange: () => { if (!touched) fillMoney(); },
  });

  const fillMoney = () => {
    const at = dateInput.value;
    const price = at && at !== todayIso()
      ? priceOn(series, at)
      : priceNow(code, share, meta, series);
    moneyInput.value = toField(price, 6);
  };

  const all = h('button', {
    type: 'button', class: 'lot-all',
    onClick: () => {
      unitsInput.value = toField(held, 4);
      unitsInput.focus();
    },
  }, T('posSellAll'));

  const el = h('form', {
    class: `lot-form ${sale ? 'is-sale' : ''}`,
    onSubmit: (e) => {
      e.preventDefault();
      const units = decimal(unitsInput.value);
      if (!(units > 0)) return;
      // Never more than is held: a sale of what you do not have is not a short
      // position here, it is a typo.
      const size = sale ? -Math.min(units, held) : units;
      if (!size) return;
      addLot(code, { at: dateInput.value, units: size, price: decimal(moneyInput.value) });
      unitsInput.value = '';
      moneyInput.value = '';
      touched = false;
      onChange();
    },
  },
    h('span', { class: 'lot-kind' }, T(sale ? 'posSell' : 'posBuy')),
    dateInput,
    unitsInput,
    moneyInput,
    h('button', { type: 'submit', class: 'control lot-go' }, T(sale ? 'posSell' : 'posAdd')),
    sale ? all : null
  );

  fillMoney();

  return {
    el,
    setMax: (n) => {
      held = n > 0 ? n : 0;
      // Nothing to sell, nothing to offer: the form is gone rather than sitting
      // there refusing everything typed into it.
      el.hidden = sale && !held;
    },
  };
}

const toField = (n, dp = 2) => (n == null || !Number.isFinite(n)
  ? ''
  : String(Math.round(n * 10 ** dp) / 10 ** dp).replace('.', ','));

/**
 * A number typed on either kind of keyboard.
 *
 * Turkish keyboards produce a comma, and `Number('12,5')` is `NaN` — which would
 * silently clear the field as you typed. The dot is the thousands separator in
 * the same convention, so it goes. Null means "nothing usable here", which is
 * how both callers clear a value.
 */
function decimal(raw) {
  const clean = String(raw ?? '').trim().replace(/\./g, '').replace(',', '.');
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Is this a code the site actually has a page for? */
async function resolvesToPage(code) {
  if (state.funds.some((f) => f.c === code)) return true;
  if (!isShareCode(code)) return false;
  await loadShares();
  return !!shareOf(code);
}

/**
 * What the code field offers.
 *
 * Funds are already in memory. Shares are only offered once their index has been
 * fetched for something else — pulling 450KB to fill an autocomplete nobody has
 * typed into yet is not a trade worth making, and typing a share code that is
 * not on the list still works.
 */
function addOptions() {
  const out = state.funds.map((f) => h('option', { value: f.c, label: f.n }));
  for (const s of shares?.list ?? []) out.push(h('option', { value: s.c, label: s.n }));
  return out;
}

/**
 * The latest price for a code the page has not loaded a history for.
 *
 * The add form needs it before anything else about the code is on hand, which is
 * why it does not take the series the row helper does: a share falls back to its
 * own last close when the scan has not answered, and a fund is last night's NAV
 * either way.
 */
function currentPriceOf(code) {
  if (isShareCode(code)) return shareQuote(code)?.price ?? shareOf(code)?.p ?? null;
  return state.funds.find((f) => f.c === code)?.p ?? null;
}

/**
 * The control that opens a position.
 *
 * The price fills itself in at what one unit costs right now, because that is
 * what it cost if you are buying it now — which is when somebody is most likely
 * to be typing here. A price, not a total: it is the number on the confirmation,
 * and it does not change when you correct the size beside it. Type your own and
 * it stops guessing; clear yours and it starts again.
 *
 * A code already in the portfolio is not refused. Buying more of something is a
 * second lot, and the row it lands in works out the average.
 */
function portfolioAdd() {
  let touched = false;

  const field = (extra, labelKey, hintKey) => h('input', {
    type: 'text', class: 'port-input', autocomplete: 'off',
    'aria-label': T(labelKey), placeholder: T(labelKey),
    title: hintKey ? T(hintKey) : null, ...extra,
  });

  const codeInput = field(
    {
      list: 'port-add-list', spellcheck: 'false', class: 'port-input port-add-code',
      onInput: () => { if (!touched) fillCost(); },
    },
    'portAddCode', null);
  const unitsInput = field({ inputmode: 'decimal' }, 'posUnits', 'posUnitsHint');
  const costInput = field(
    {
      inputmode: 'decimal',
      onInput: (e) => { touched = e.target.value.trim() !== ''; },
    },
    'posUnitPrice', 'posUnitPriceHint');
  const error = h('p', { class: 'port-add-error', role: 'alert' });

  const fillCost = () => {
    costInput.value = toField(currentPriceOf(codeInput.value.trim().toUpperCase()), 6);
  };

  const form = h('form', {
    class: 'port-add',
    onSubmit: async (e) => {
      e.preventDefault();
      const code = codeInput.value.trim().toUpperCase();
      if (!code) return;
      if (!(await resolvesToPage(code))) {
        error.textContent = T('portAddUnknown');
        return;
      }
      error.textContent = '';
      const units = decimal(unitsInput.value);
      // A share's price may only have arrived with the index the check above
      // just fetched, so the guess is made again here rather than left empty
      // because it could not be made while the code was being typed.
      if (!touched && !costInput.value.trim()) fillCost();
      addLot(code, { at: todayIso(), units: units ?? 0, price: decimal(costInput.value) });
      // Nothing to add without a size: the code alone is a favourite, and there
      // is a star for that.
      if (!(units > 0)) {
        removeLot(code, (state.positions[code]?.length ?? 1) - 1);
        error.textContent = T('portAddNoUnits');
        return;
      }
      // The new row needs its own price history, so the page is rebuilt rather
      // than the row spliced in against data that has not been fetched.
      renderPortfolio();
    },
  },
    h('div', { class: 'port-add-fields' },
      codeInput, unitsInput, costInput,
      h('button', { type: 'submit', class: 'control port-add-go' }, T('portAddButton'))),
    h('datalist', { id: 'port-add-list' }, addOptions()),
    error
  );

  return h('section', { class: 'panel port-add-panel' }, form);
}

/**
 * What this position has done since the last close, in per cent.
 *
 * A share is the delayed live quote, falling back to its own last close when the
 * scan has not answered yet. A fund is the last net asset value TEFAS published
 * and nothing else: a fund's move today CAN be estimated from what its shares
 * are trading at, and the dashboard shows exactly that — but an estimate has no
 * business inside a lira figure printed under a total, so the ring takes the
 * last price and its note says that half runs a business day behind.
 */
function dayChangeOf(code, share, meta) {
  if (share) return shareQuote(code)?.change ?? meta?.ch ?? null;
  return meta?.ch ?? null;
}

/** The latest price for either kind: a share is live, a fund is last night's NAV. */
function priceNow(code, share, meta, series) {
  if (share) {
    const quote = shareQuote(code);
    if (quote?.price != null) return quote.price;
    if (meta?.p != null) return meta.p;
  } else if (meta?.p != null) {
    return meta.p;
  }
  return series?.at(-1)?.[1] ?? null;
}

/**
 * What it is all worth, and what the same money would have done in cash.
 *
 * The cash comparison is measured over each position's OWN period rather than
 * against the headline one-year figure: a holding opened three weeks ago has to
 * be judged against three weeks of the money market. The earliest position sets
 * the window, and the page says which date that is.
 */
function portfolioSummary(valued, history) {
  const totals = portfolioTotals(valued);
  if (!totals) return null;

  // The lots live in state rather than on the valued row, which only carries
  // what a row prints. A rate needs every purchase and every sale.
  const rate = portfolioXirr(
    valued.map((p) => ({ code: p.code, lots: state.positions[p.code], value: p.value })),
    todayIso());

  const mmf = state.benchmarks.filter((r) => r.mmf != null).map((r) => [r.d, r.mmf]);
  const alternative = cashAlternative(valued, mmf);
  const cash = alternative?.pct ?? null;
  const gap = totals.pct != null && cash != null ? round1(totals.pct - cash) : null;

  return h('section', { class: 'panel port-summary' },
    h('dl', { class: 'stat-row' },
      h('div', { class: 'stat' },
        h('dt', {}, T('portTotalValue')),
        h('dd', {}, fmtMoney(totals.value, state.lang))),
      totals.basis == null ? null : h('div', { class: 'stat' },
        h('dt', {}, T('portTotalCost')),
        h('dd', {}, fmtMoney(totals.basis, state.lang))),
      totals.profit == null ? null : h('div', { class: 'stat' },
        h('dt', {}, T('portProfit')),
        h('dd', { class: `delta ${signOf(totals.profit)}` },
          fmtMoney(totals.profit, state.lang)),
        h('span', { class: 'stat-sub num' },
          fmtPct(totals.pct, state.lang, { signed: true, digits: 1 }))),
      cash == null ? null : h('div', { class: 'stat' },
        h('dt', {}, T('portVsCash')),
        h('dd', { class: 'num' }, fmtPct(cash, state.lang, { digits: 1 })),
        h('span', { class: 'stat-sub num' }, fmtMoney(alternative.value, state.lang))),
      gap == null ? null : h('div', { class: 'stat' },
        h('dt', {}, T('portVsCashGap')),
        h('dd', { class: `delta ${signOf(gap)}` },
          fmtPoints(gap, state.lang, { signed: true, digits: 1 }))),
      // Beside the profit, because it is the same money asked a better
      // question: not how much, but at what rate.
      rate == null ? null : h('div', { class: 'stat' },
        h('dt', { title: T('portRateHint') }, T('portRate')),
        h('dd', { class: `delta ${signOf(rate.pct)}` },
          fmtPct(rate.pct, state.lang, { signed: true, digits: 1 })),
        rate.counted < rate.of
          ? h('span', { class: 'stat-sub num' },
              T('portRatePartial', { n: rate.counted, of: rate.of }))
          : null)
    ),
    // A total that quietly omitted a third of the holdings would be worse than
    // no total, so what was left out is stated rather than absorbed.
    totals.costed < totals.priced
      ? h('p', { class: 'panel-note' },
          T('portNoBasis', { n: totals.priced - totals.costed }))
      : null
  );
}

// ------------------------------------------------------------------- the ring
//
// One holding, one slice, largest first, clockwise from twelve — and in the
// hole in the middle the two numbers the page exists to answer: what it is all
// worth, and what it has done since the last close.

/** The ring's palette. The collected tail is always the grey, whatever its size. */
const sliceColor = (i, rest) => (rest
  ? 'var(--slice-rest, var(--ink-muted))'
  : `var(--slice-${(i % 8) + 1}, var(--ink-muted))`);

/**
 * What you hold, drawn as a ring, with the total in the hole in the middle.
 *
 * The figure in the middle is why this is a ring and not a bar: a total that
 * reads as money, and under it what that money has done since the last close.
 * The two halves of that move come from different places, and the note says so
 * rather than letting one number imply a single source — shares are live, funds
 * are the price TEFAS published last night.
 */
function portfolioDonut(valued) {
  const cut = portfolioSlices(valued);
  if (!cut) return null;
  const move = portfolioDayMove(valued);
  const tight = window.matchMedia?.(RING_TIGHT)?.matches ?? false;
  const g = ringGeometry(tight);

  const nameOf = (s) => (s.rest ? T('portOthers', { n: fmtInt(s.rest, state.lang) }) : s.code);
  const figureOf = (s) =>
    `${fmtMoney(s.value, state.lang)} · ${fmtPct(s.share, state.lang, { digits: 1 })}`;

  // Angles are taken from the values, never from the rounded shares: eight
  // roundings of two decimals leave a visible wedge of unpainted ring at the end.
  let sum = 0;
  for (const s of cut.slices) sum += s.value;
  let turn = 0;
  const placed = cut.slices.map((s, i) => {
    const from = turn;
    turn = i === cut.slices.length - 1 ? 1 : turn + s.value / sum;
    return { s, i, from, to: turn, mid: (from + turn) / 2 };
  });

  // One holding is the whole ring, and an arc from nought to one turn starts and
  // ends at the same point — which draws nothing at all. A stroked circle is the
  // same shape without the degenerate path. It carries its own class because on
  // a slice the stroke is the gap between neighbours, and here the stroke IS the
  // ring — `.donut-slice` would paint it 1.5 units wide in the page's own colour.
  const ring = placed.length === 1
    ? svg('circle', {
        class: 'donut-whole', cx: g.cx, cy: g.cy, r: (g.outer + g.inner) / 2,
        stroke: sliceColor(0, 0), 'stroke-width': g.outer - g.inner,
      }, svg('title', {}, text(`${nameOf(cut.slices[0])} — ${figureOf(cut.slices[0])}`)))
    : placed.map(({ s, i, from, to }) =>
        svg('path', { class: 'donut-slice', d: ringPath(g, from, to), fill: sliceColor(i, s.rest) },
          svg('title', {}, text(`${nameOf(s)} — ${figureOf(s)}`))));

  const centre = svg('g', { class: 'donut-centre', 'text-anchor': 'middle' },
    svg('text', { class: 'donut-eyebrow', x: g.cx, y: g.cy - (tight ? 36 : 42) },
      text(T('portTotalValue'))),
    svg('text', { class: 'donut-total', x: g.cx, y: g.cy - (tight ? 8 : 12) },
      text(fmtMoney(cut.total, state.lang))),
    move == null ? null : svg('text',
      { class: 'donut-eyebrow', x: g.cx, y: g.cy + (tight ? 18 : 16) }, text(T('portToday'))),
    move == null ? null : svg('text', {
      class: `donut-move ${signOf(move.pct)}`, x: g.cx, y: g.cy + (tight ? 40 : 38),
    },
      // Where the two halves of this number come from, on hover rather than in a
      // paragraph under the chart. The same place the dashboard puts it.
      svg('title', {}, text(T('portTodayNote'))),
      text(`${fmtPct(move.pct, state.lang, { signed: true, digits: 2 })}`
        + ` · ${fmtMoney(move.gain, state.lang)}`))
  );

  const legend = h('ul', { class: 'comp-legend donut-legend' },
    cut.slices.map((s, i) =>
      h('li', {},
        h('span', { class: 'swatch', style: `background:${sliceColor(i, s.rest)}` }),
        h('span', {}, nameOf(s)),
        h('span', { class: 'val num' }, fmtPct(s.share, state.lang, { digits: 1 })))));

  // What a screen reader is given instead of the picture: the same two figures,
  // then the holdings in the order they are drawn.
  const spoken = [
    `${T('portTotalValue')} ${fmtMoney(cut.total, state.lang)}`,
    move == null
      ? null
      : `${T('portToday')} ${fmtPct(move.pct, state.lang, { signed: true, digits: 2 })}`,
    ...cut.slices.map((s) => `${nameOf(s)} ${figureOf(s)}`),
  ].filter(Boolean).join('. ');

  return h('section', { class: 'panel port-ring' },
    h('h2', {}, T('portRing')),
    svg('svg', {
      class: `donut ${tight ? 'is-tight' : ''}`, viewBox: `0 0 ${g.w} ${g.h}`,
      role: 'img', 'aria-label': spoken,
    }, ring, tight ? null : ringTags(g, placed, nameOf, figureOf), centre),
    legend,
    // A move measured over four fifths of the money is not the portfolio's move,
    // so the part that could not be priced is named rather than quietly folded
    // in as flat. Nothing else is said: the ring explains itself.
    move == null || move.covered >= move.of ? null : h('p', { class: 'panel-note' },
      T('portRingPartial', { v: fmtMoney(move.of - move.covered, state.lang) }))
  );
}

/** The labels around the ring, each on a leader line back to its own slice. */
function ringTags(g, placed, nameOf, figureOf) {
  const sides = { left: [], right: [] };
  for (const p of placed) {
    const right = Math.sin(p.mid * TURN) >= 0;
    const [ax, ay] = ringPoint(g, g.outer + 4, p.mid);
    const [bx, by] = ringPoint(g, g.bend, p.mid);
    sides[right ? 'right' : 'left'].push({ ...p, right, ax, ay, bx, by, y: by });
  }
  const GAP = 34;
  spreadLabels(sides.left, GAP, 24, g.h - 18);
  spreadLabels(sides.right, GAP, 24, g.h - 18);

  return svg('g', { class: 'donut-tags' }, [...sides.left, ...sides.right].map((p) => {
    const x = p.right ? g.cx + g.label : g.cx - g.label;
    const tip = p.right ? x - 8 : x + 8;
    return svg('g', {},
      svg('polyline', {
        class: 'donut-leader',
        points: `${svgN(p.ax)},${svgN(p.ay)} ${svgN(p.bx)},${svgN(p.by)} ${svgN(tip)},${svgN(p.y)}`,
      }),
      svg('text', {
        class: 'donut-label', x, y: svgN(p.y - 4), 'text-anchor': p.right ? 'start' : 'end',
      },
        svg('tspan', { class: 'donut-code', x }, text(nameOf(p.s))),
        svg('tspan', { class: 'donut-figure', x, dy: 15 }, text(figureOf(p.s))))
    );
  }));
}

/** The aggregate views that only exist once the sizes are known. */
function portfolioPanels(valued, filings, together) {
  const funds = valued.filter((p) => !p.share && p.value != null);
  const mixed = portfolioMix(funds.map((p) => ({ value: p.value, groups: p.groups })));

  // Speculative exposure, weighted by money rather than by fund count.
  let specLira = 0;
  let specBase = 0;
  for (const p of funds) {
    if (!p.spec) continue;
    specBase += p.value;
    specLira += (p.value * p.spec.w) / 100;
  }
  const specPct = specBase > 0 ? round1((specLira / specBase) * 100) : null;

  return [
    mixed ? portfolioMixPanel(mixed) : null,
    // Duplication belongs beside the look-through and the correlation panel:
    // all three answer "is this portfolio as spread out as it looks", and only
    // here are the sizes known. On the dashboard it was asking about a list of
    // codes you follow, which is a weaker version of the same question.
    // The three of them read top to bottom as one argument: which companies you
    // actually own, which of your funds own the same ones, and whether they move
    // as one regardless. The look-through leads because it is the concrete
    // answer and the other two qualify it.
    portfolioLookPanel(valued, filings),
    renderOverlap(funds.map((p) => p.code)),
    portfolioTogetherPanel(together),
    portfolioTaxPanel(valued),
    portfolioFeePanel(valued),
    specPct == null ? null : h('section', { class: 'panel' },
      h('h2', {}, T('portSpec')),
      h('dl', { class: 'stat-row stat-row-inset' },
        h('div', { class: 'stat' },
          h('dt', {}, T('specWeight')),
          h('dd', { class: specPct >= SPECULATIVE_HEAVY ? 'delta down' : '' },
            fmtPct(specPct, state.lang, { digits: 1 }))),
        h('div', { class: 'stat' },
          h('dt', {}, T('portSpecValue')),
          h('dd', {}, fmtMoney(specLira, state.lang)))),
      h('p', { class: 'panel-note' }, T('portSpecNote'))),
  ];
}

/**
 * Whether the funds you hold are actually different bets.
 *
 * The look-through panel above answers "do I own the same company twice". This
 * answers the other half, and they are genuinely different questions: two funds
 * can share no position at all and still be one bet, because a Turkish equity
 * fund and a Turkish equity fund are both a bet on Turkish equity whichever
 * twelve companies they picked.
 *
 * The headline is not the average correlation, which nobody can act on. It is
 * how many independent positions the portfolio behaves like — four funds that
 * all move together are one bet, and that is a sentence.
 */
function portfolioTogetherPanel(together) {
  if (!together) return null;
  const peak = together.pairs[0]?.r ?? 0;

  return h('section', { class: 'panel' },
    h('h2', {}, T('portTogether')),
    h('dl', { class: 'stat-row stat-row-inset' },
      h('div', { class: 'stat' },
        h('dt', { title: T('portTogetherHint') }, T('portTogetherBets')),
        h('dd', {}, fmtNum(together.effective, state.lang, 1)),
        h('span', { class: 'stat-sub num' },
          T('portTogetherOf', { n: together.counted }))),
      h('div', { class: 'stat' },
        h('dt', {}, T('portTogetherAvg')),
        h('dd', { class: together.average >= CORRELATION_HIGH ? 'delta down' : '' },
          fmtNum(together.average, state.lang, 2)))),
    h('ul', { class: 'compare-pairs' }, together.pairs.map((p) => h('li', {},
      h('span', { class: 'num' }, `${p.a} · ${p.b}`),
      // A correlation runs from -1 to 1, so the bar is drawn from the middle
      // outward: a pair that hedges is a bar to the left, not a short one.
      h('span', { class: 'look-bar corr-bar' },
        h('span', {
          class: 'look-fill',
          style: `margin-left:${svgN(p.r < 0 ? 50 + p.r * 50 : 50)}%;`
            + `width:${svgN(Math.abs(p.r) * 50)}%;`
            + `background:${p.r >= CORRELATION_HIGH ? 'var(--down)' : 'var(--accent)'}`,
        })),
      h('span', { class: 'look-pct' }, fmtNum(p.r, state.lang, 2))))),
    together.counted < together.of
      ? h('p', { class: 'panel-note' },
          T('portTogetherPartial', { n: together.of - together.counted }))
      : null
  );
}

/**
 * What selling today would cost in withholding.
 *
 * The tax model has always been here, and has only ever been used to rank funds
 * — a gross return turned into a net one so two funds taxed differently can be
 * compared. Pointed at the holding instead it answers a question the ranking
 * never could: of the ₺10,600 you are up, how much is actually yours.
 *
 * Every figure on it is an assumption and the panel says so, because the rates
 * are defaults the reader can change and Turkish withholding has been amended
 * repeatedly. It is not tax advice and does not read as any.
 */
function portfolioTaxPanel(valued) {
  const rates = taxRatesFor(state.prefs.tax);
  const out = taxIfSold(valued.map((p) => ({
    code: p.code,
    // A share is not a fund and carries none of these rates.
    fund: p.share ? null : state.funds.find((f) => f.c === p.code),
    value: p.value,
    basis: p.basis,
  })), rates);
  if (!out) return null;

  return h('section', { class: 'panel' },
    h('h2', {}, T('portTax')),
    h('dl', { class: 'stat-row stat-row-inset' },
      h('div', { class: 'stat' },
        h('dt', {}, T('portTaxGain')),
        h('dd', { class: `delta ${signOf(out.gain)}` }, fmtMoney(out.gain, state.lang))),
      h('div', { class: 'stat' },
        h('dt', { title: T('portTaxHint') }, T('portTaxDue')),
        h('dd', { class: out.tax > 0 ? 'delta down' : '' }, fmtMoney(out.tax, state.lang))),
      h('div', { class: 'stat' },
        h('dt', {}, T('portTaxNet')),
        h('dd', { class: `delta ${signOf(out.net)}` }, fmtMoney(out.net, state.lang)))),
    h('ul', { class: 'fee-list' }, out.rows.map((r) => h('li', {},
      h('a', { class: 'code-link num', href: `#/fon/${r.code}` }, r.code),
      h('span', { class: 'fee-rate num' }, fmtPct(r.rate * 100, state.lang, { digits: 1 })),
      h('span', { class: 'fee-years' }, T(`taxBucket_${r.bucket}`)),
      h('span', { class: 'fee-lira num' }, fmtMoney(r.tax, state.lang))))),
    h('p', { class: 'panel-note' }, T('portTaxNote')),
    out.counted < out.of
      ? h('p', { class: 'panel-note' }, T('portTaxPartial', { n: out.of - out.counted }))
      : null
  );
}

/**
 * What the management fees have already taken out of what you hold.
 *
 * A cost nobody sees. The expense ratio is a column on the fund list and a line
 * on the fund page, and in both places it is a percentage — which is exactly the
 * form in which a 2.5% fee reads as nothing at all. In lira, against a real
 * holding, over the time it has actually been held, it does not.
 *
 * The panel says twice over that the money has already gone: the fee is taken
 * inside the unit price, so this is not a bill and must never be read as one.
 */
function portfolioFeePanel(valued) {
  const drag = feeDrag(valued.map((p) => {
    const fund = p.share ? null : state.funds.find((f) => f.c === p.code);
    return {
      code: p.code, basis: p.basis, value: p.value, from: p.at,
      // A share carries no expense ratio, which is not the same as carrying zero.
      rate: fund?.expenseRatio ?? null,
    };
  }), todayIso());
  if (!drag) return null;

  return h('section', { class: 'panel' },
    h('h2', {}, T('portFees')),
    h('dl', { class: 'stat-row stat-row-inset' },
      h('div', { class: 'stat' },
        h('dt', {}, T('portFeesTotal')),
        h('dd', { class: 'delta down' }, fmtMoney(drag.total, state.lang)))),
    h('ul', { class: 'fee-list' }, drag.rows.map((r) => h('li', {},
      h('a', { class: 'code-link num', href: `#/fon/${r.code}` }, r.code),
      h('span', { class: 'fee-rate num' }, fmtPct(r.rate, state.lang, { digits: 2 })),
      h('span', { class: 'fee-years' }, T('portFeesYears', {
        n: fmtNum(r.years, state.lang, 1) })),
      h('span', { class: 'fee-lira num' }, fmtMoney(r.lira, state.lang))))),
    h('p', { class: 'panel-note' }, T('portFeesNote')),
    drag.counted < drag.of
      ? h('p', { class: 'panel-note' },
          T('portFeesPartial', { n: drag.of - drag.counted }))
      : null
  );
}

/** The mix, with the legend that makes a bar of five colours readable. */
function portfolioMixPanel(mixed) {
  const segments = Object.entries(mixed.mix)
    .sort((a, b) => b[1] - a[1])
    .map(([id, pct]) => ({ id, pct, share: pct }));
  const groups = state.meta.groups;
  return h('section', { class: 'panel' },
    h('h2', {}, T('portMix')),
    h('p', { class: 'panel-note' }, T('portMixNote')),
    compBar(segments, 'comp-bar'),
    h('ul', { class: 'comp-legend' },
      segments.map((s) =>
        h('li', {},
          h('span', { class: 'swatch', style: `background:${groupColor(s.id)}` }),
          h('span', {}, label(groups.find((g) => g.id === s.id), state.lang)),
          h('span', { class: 'val num' }, fmtPct(s.pct, state.lang, { digits: 1 })))))
  );
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/**
 * Every filing the look-through needs, including one level of funds-in-funds.
 *
 * Two rounds, because the second round is not knowable until the first has been
 * read: a fund of funds names the funds it holds inside its own filing. Both
 * rounds go through `loadHoldings`, so a fund page opened earlier in the session
 * has already paid for its file and a portfolio of six funds is at most six
 * requests, not six every time the page is drawn.
 *
 * A missing filing is not an error here. It is the answer for 1,182 of the 2,063
 * funds, and the panel reports the money it could not see into rather than
 * pretending the rest is everything.
 */
async function loadPortfolioFilings(codes) {
  const funds = codes.filter((c) => !isShareCode(c));
  if (!funds.length) return {};

  const filings = {};
  const take = async (code) => {
    if (filings[code] !== undefined) return;
    const data = await loadHoldings(code);
    filings[code] = data?.holdings ? aggregateHoldings(data.holdings) : null;
  };

  await Promise.all(funds.map(take));
  // The funds those funds hold, on the build's own resolution.
  const nested = new Set();
  for (const rows of Object.values(filings)) {
    for (const p of rows ?? []) {
      if (p.group === 'funds' && p.ref && filings[p.ref] === undefined) nested.add(p.ref);
    }
  }
  await Promise.all([...nested].map(take));
  return filings;
}

/**
 * What you own once the funds are opened up, one row per company.
 *
 * The panel this project exists to be able to draw. Every other page answers
 * "what does this fund hold"; this is the only one that answers "what do I
 * hold", and it can only be drawn because the filings and the position sizes
 * are both on this page at once.
 *
 * Two figures lead it, and the second is the one that bites: how many equal
 * positions your money is really spread over, and how many once the bonds and
 * deposits are set aside. A saver holding four equity funds routinely finds the
 * second number is eight.
 */
function portfolioLookPanel(valued, filings) {
  const out = lookThrough(
    valued.map((p) => ({
      code: p.code,
      value: p.value,
      share: p.share,
      name: p.share ? shareOf(p.code)?.n ?? p.code : null,
    })),
    filings
  );
  if (!out?.rows.length) return null;

  const uncovered = round1(out.total - out.covered);
  const shown = out.rows.slice(0, LOOK_THROUGH_ROWS);

  return h('section', { class: 'panel' },
    h('h2', {}, T('portLook')),
    h('dl', { class: 'stat-row stat-row-inset' },
      h('div', { class: 'stat' },
        h('dt', { title: T('portLookConcHint') }, T('portLookConc')),
        h('dd', {}, fmtNum(out.effective, state.lang, 1))),
      out.equity == null ? null : h('div', { class: 'stat' },
        h('dt', { title: T('portLookEquityHint') }, T('portLookEquity')),
        h('dd', {}, fmtNum(out.equity.effective, state.lang, 1)),
        h('span', { class: 'stat-sub num' }, fmtMoney(out.equity.value, state.lang))),
      h('div', { class: 'stat' },
        h('dt', {}, T('portLookNames')),
        h('dd', {}, fmtInt(out.rows.length, state.lang)))
    ),
    h('div', { class: 'own-scroll' }, h('table', { class: 'own-table look-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, T('portLookPosition')),
        h('th', {}, T('portLookVia')),
        h('th', { class: 'num' }, T('portLookValue')),
        h('th', { class: 'num' }, T('portLookWeight')))),
      h('tbody', {}, shown.map((row) => h('tr', {},
        h('td', {},
          lookLink(row),
          row.name && row.name !== row.code
            ? h('span', { class: 'row-sub', title: row.isin ?? '' }, row.name)
            : null),
        // Which of your funds brought it, heaviest first. This column is the
        // reason the panel is a table and not a ring: "ASELS 7.2%" is a fact,
        // and "ASELS 7.2%, and it came from three funds you thought were
        // different" is the finding.
        h('td', { class: 'look-via' }, row.holders.map((holder, i) => [
          i ? h('span', { class: 'look-sep' }, '·') : null,
          holder.code === row.code
            ? h('span', { class: 'look-direct' }, T('portLookDirect'))
            : h('a', { class: 'code-link num', href: `#/fon/${holder.code}` }, holder.code),
        ])),
        h('td', { class: 'num' }, fmtMoney(row.value, state.lang)),
        h('td', { class: 'num' },
          // The bar is the column, not an ornament beside it: twenty rows of
          // percentages are read one at a time, and twenty bars are read at a
          // glance. Scaled to the largest row rather than to 100, or every bar
          // in a properly diversified portfolio would be an invisible sliver.
          h('span', { class: 'look-bar' },
            h('span', {
              class: 'look-fill',
              style: `width:${svgN((row.pct / shown[0].pct) * 100)}%;`
                + `background:${groupColor(HOLDING_COLOR[row.group] ?? 'other')}`,
            })),
          h('span', { class: 'look-pct' }, fmtPct(row.pct, state.lang, { digits: 2 })))
      )))
    )),
    out.rows.length > shown.length
      ? h('p', { class: 'panel-note' },
          T('portLookHidden', { n: fmtInt(shown.length, state.lang) }))
      : null,
    // What the figures above could not see. Stated for the same reason the
    // profit total states the positions it left out: a percentage of an unknown
    // fraction of somebody's money is not an answer.
    uncovered > 0
      ? h('p', { class: 'panel-note' },
          T('portLookUncovered', { v: fmtMoney(uncovered, state.lang) }))
      : null,
    out.unidentified > 0
      ? h('p', { class: 'panel-note' },
          T('portLookUnnamed', { v: fmtMoney(out.unidentified, state.lang) }))
      : null
  );
}

/** A look-through row's code, linked to whichever page it is a code for. */
function lookLink(row) {
  const text = row.code ?? row.isin ?? '—';
  // A share bought directly is already a company, and needs no resolving.
  if (row.direct) return h('a', { class: 'code-link num', href: `#/hisse/${row.code}` }, text);
  const target = row.ref ?? row.code;
  if (target && state.funds.some((f) => f.c === target)) {
    return h('a', { class: 'code-link num', href: `#/fon/${target}` }, text);
  }
  // Same resolution the holdings table links on, and the same refusal to link a
  // code the exchange does not list.
  const listing = listingOf(row);
  if (listing?.market === 'bist') {
    const listed = state.meta?.listedCodes;
    const ticker = listing.tickers.find((t) => !listed || listed.includes(t));
    if (ticker) return h('a', { class: 'code-link num', href: `#/hisse/${ticker}` }, text);
  }
  return h('span', { class: 'num' }, text);
}

/** Which of the eight palette colours a look-through row's group is drawn in. */
const HOLDING_COLOR = Object.fromEntries(HOLDING_GROUPS.map((g) => [g.id, g.color]));

// ------------------------------------------------------- speculative boards

/** How each condition's figure is written, in its own unit. */
const SPEC_VALUE = {
  runUp: (v) => fmtPct(v, state.lang, { signed: true, digits: 0 }),
  thinFloat: (v) => fmtPct(v, state.lang, { digits: 1 }),
  concentrated: (v) => fmtPct(v, state.lang, { digits: 1 }),
  noEarnings: (v) => (v == null ? null : `F/K ${fmtNum(v, state.lang, 0)}`),
  richBook: (v) => `${fmtNum(v, state.lang, 1)}×`,
  violent: (v) => fmtPct(v, state.lang, { digits: 1 }),
};

/**
 * What makes this listing easy to move, condition by condition.
 *
 * Drawn only when the conditions are actually met, and worded with care. Every
 * line is a figure the exchange itself publishes; none of them is an accusation,
 * and the panel says so before it says anything else. A company can meet all six
 * and be doing nothing whatever wrong — a thin float and a loss are not
 * misconduct — but a fund's investor is entitled to know that the price they are
 * exposed to has nothing underneath it.
 */
function shareBoard(stock) {
  const board = boardFlags(stock);
  if (!board?.speculative) return null;

  return h('section', { class: 'panel spec-panel' },
    h('div', { class: 'dash-pane-head' },
      h('h2', {}, T('specPanel')),
      h('span', { class: 'spec-count num' },
        T('specMet', { n: board.hit, of: board.tested }))),
    h('p', { class: 'panel-note' }, T('specNote')),
    h('ul', { class: 'spec-flags' },
      board.flags.map(({ id, value }) => {
        const shown = value == null ? null : SPEC_VALUE[id]?.(value);
        const key = `specFlag${id[0].toUpperCase()}${id.slice(1)}`;
        return h('li', {},
          h('span', { class: 'spec-mark', 'aria-hidden': 'true' }, '!'),
          h('span', { class: 'spec-body' },
            h('b', {}, T(key)),
            h('span', { class: 'spec-why' }, T(`${key}Note`))),
          shown ? h('span', { class: 'spec-value num' }, shown) : null);
      }))
  );
}

/**
 * How much of a fund sits in shares that look like that.
 *
 * The panel that turns a fact about the exchange into a fact about your money.
 * Two figures, because one of them alone misleads: 30% of a portfolio is a very
 * different sentence when the fund is 35% shares than when it is 95%.
 */
function renderSpeculative(fund) {
  const spec = fund?.spec;
  if (!spec) return null;
  // A fund that holds shares and none of them flagged has been told something,
  // and the dashboard's overlap panel already sets the precedent for saying so.
  // A bond fund has not avoided these companies, it has avoided the market, so
  // it gets nothing.
  //
  // `codes` is absent on a clean fund and on any older cached copy of the file,
  // so it is read defensively: a missing field must render nothing, never blank
  // the whole fund page from the render list this sits in.
  if (!spec.codes?.length) {
    return spec.equity >= SPEC_MIN_EQUITY
      ? h('section', { class: 'panel spec-fund' },
          h('h2', {}, T('specFundClean')),
          h('p', { class: 'panel-note' }, T('specNoneFlagged')))
      : null;
  }
  const heavy = spec.w >= SPECULATIVE_HEAVY;

  return h('section', { class: `panel spec-fund ${heavy ? 'is-heavy' : ''}` },
    h('h2', {}, T('specFundPanel')),
    h('dl', { class: 'stat-row stat-row-inset' },
      h('div', { class: 'stat' },
        h('dt', {}, T('specWeight')),
        h('dd', { class: heavy ? 'delta down' : '' }, pct(spec.w, 1))),
      h('div', { class: 'stat' },
        h('dt', {}, T('specOfEquity')),
        h('dd', {}, pct(spec.ofEquity, 1))),
      h('div', { class: 'stat' },
        h('dt', {}, T('specCount')),
        h('dd', {}, fmtInt(spec.codes.length, state.lang)))
    ),
    h('ul', { class: 'spec-holdings' },
      spec.codes.map(([code, weight]) => h('li', {},
        h('a', { class: 'code-link num', href: `#/hisse/${code}` }, code),
        h('span', { class: 'num' }, pct(weight, 1))))),
    h('p', { class: 'panel-note' }, T('specFundNote'))
  );
}

// ------------------------------------------------------- the statements

/**
 * A company's own numbers, fetched only when its page is open.
 *
 * Eight years of quarters and twenty of years is 8KB a company and 5MB across
 * the exchange. The index everyone downloads to see a LIST stays 700KB; this
 * arrives on the one page that has any use for it.
 */
function loadFundamentals(stock) {
  const code = stock?.c;
  // The index says which listings have statements at all, so an exchange-traded
  // fund's page does not open by asking for a file that was never written.
  if (!code || !stock.fin) return Promise.resolve(null);
  if (finCache.has(code)) return finCache.get(code);
  const job = fetch(`${DATA}/stocks/${code}.fin.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  finCache.set(code, job);
  return job;
}

/** Which lines can be charted, in the order a reader works down a statement. */
const STATEMENT_LINES = [
  { key: 'rev', labelKey: 'revenue', kind: 'money' },
  { key: 'gp', labelKey: 'grossProfit', kind: 'money', of: 'rev' },
  { key: 'ebitda', labelKey: 'ebitda', kind: 'money', of: 'rev' },
  { key: 'ni', labelKey: 'netIncome', kind: 'money', of: 'rev' },
  { key: 'eps', labelKey: 'eps', kind: 'perShare' },
  { key: 'fcf', labelKey: 'freeCashFlow', kind: 'money', of: 'rev' },
  { key: 'capex', labelKey: 'capex', kind: 'money', of: 'rev' },
  { key: 'assets', labelKey: 'totalAssets', kind: 'money' },
  { key: 'debt', labelKey: 'totalDebt', kind: 'money' },
];

/** How many periods the chart and the table show at once. */
const STATEMENT_WINDOW = 16;
const STATEMENT_COLUMNS = 8;

/**
 * The financial statements, charted and tabulated.
 *
 * One panel with one set of controls rather than a chart panel and a table
 * panel that could disagree with each other: the period toggle and the line
 * picker drive both, so what is drawn is always what is tabulated.
 *
 * The trailing-twelve-month view is the one worth defaulting to for a quarterly
 * series, but it is not the default here — a reader who opens a page and sees
 * bars wants the quarters the company actually reported, and can add the four
 * of them together with one click.
 */
function renderFinancials(stock, fin) {
  const hasQ = Boolean(fin?.q?.p?.length);
  const hasY = Boolean(fin?.y?.p?.length);
  if (!hasQ && !hasY) return null;

  const periods = [
    hasQ ? { key: 'q', labelKey: 'periodQuarter' } : null,
    hasQ ? { key: 'ttm', labelKey: 'periodTtm' } : null,
    hasY ? { key: 'y', labelKey: 'periodYear' } : null,
  ].filter(Boolean);

  // Whichever lines this company actually reports. A bank files no gross profit
  // and no EBITDA, and offering an empty chart is worse than offering nothing.
  const block = hasQ ? fin.q : fin.y;
  const lines = STATEMENT_LINES.filter((l) =>
    (fin.q?.[l.key] ?? []).some((v) => v != null) ||
    (fin.y?.[l.key] ?? []).some((v) => v != null));
  if (!lines.length || !block) return null;

  let period = periods[0].key;
  let line = lines[0].key;

  const chartSlot = h('div', { class: 'fin-chart' });
  const statsSlot = h('dl', { class: 'stat-row stat-row-inset' });
  const tableSlot = h('div', { class: 'table-wrap fin-table-wrap' });
  const noteEl = h('p', { class: 'panel-note' });

  const periodButtons = periods.map((p) =>
    h('button', {
      type: 'button', 'aria-pressed': String(period === p.key),
      onClick: () => { period = p.key; draw(); },
    }, T(p.labelKey)));

  const lineButtons = lines.map((l) =>
    h('button', {
      type: 'button', 'aria-pressed': String(line === l.key),
      onClick: () => { line = l.key; draw(); },
    }, T(l.labelKey)));

  // Nominal until asked otherwise. A reader opening a page should see the
  // figures the company actually filed; restating them is a thing you choose.
  let real = false;
  const realButton = h('button', {
    type: 'button', class: 'fin-real', 'aria-pressed': 'false',
    title: T('realTermsHint'),
    onClick: () => {
      real = !real;
      // The file is 2KB and only this panel wants it, so it is fetched on the
      // first press rather than on every share page.
      loadCpi().then(() => draw());
    },
  }, T('realTerms'));

  const panel = h('section', { class: 'panel fin-panel' },
    h('h2', {}, T('financials')),
    h('div', { class: 'panel-head fin-head' },
      h('div', { class: 'seg', role: 'group', 'aria-label': T('periodLabel') }, periodButtons),
      h('div', { class: 'seg seg-lines', role: 'group', 'aria-label': T('metricLabel') },
        lineButtons),
      realButton
    ),
    chartSlot,
    statsSlot,
    noteEl,
    h('h3', { class: 'fin-sub' }, T('statementTable')),
    tableSlot
  );

  /**
   * The labelled series for the current period setting, oldest-first.
   *
   * Deflated here rather than at the point of drawing, so the chart, the three
   * figures under it and the margin ratios all read the same numbers. A ratio of
   * two deflated series is the same as the ratio of the nominal ones, which is
   * correct: restating both sides of a margin cannot change it.
   */
  function viewOf(key) {
    const yearly = period === 'y';
    const periods = yearly ? fin.y.p.map(String) : fin.q.p;
    const raw = yearly
      ? (fin.y[key] ?? [])
      : (period === 'ttm' ? trailingTwelve(fin.q[key] ?? []) : (fin.q[key] ?? []));
    const labels = yearly ? periods : fin.q.p.map(shortDate);
    const step = yearly ? 1 : 4;
    // `real` can be on before the file has arrived; until it does there is
    // nothing to deflate against and the nominal figures stand.
    if (!real || !cpi) return { labels, values: raw, step, nominal: 0 };
    const out = deflateSeries(raw, periods, cpi);
    return { labels, values: out.values, step, nominal: out.nominal, marks: out.real };
  }

  function draw() {
    periodButtons.forEach((b, i) =>
      b.setAttribute('aria-pressed', String(periods[i].key === period)));
    lineButtons.forEach((b, i) =>
      b.setAttribute('aria-pressed', String(lines[i].key === line)));
    // Only pressed once the file is actually here, so the control never claims a
    // restatement that did not happen.
    const on = real && Boolean(cpi);
    realButton.setAttribute('aria-pressed', String(on));

    const spec = lines.find((l) => l.key === line);
    const view = viewOf(line);
    const { labels, values, step } = view;
    const from = Math.max(0, labels.length - STATEMENT_WINDOW);
    const bars = values.slice(from);
    const shownLabels = labels.slice(from);
    // How many of the bars ACTUALLY on screen are still nominal — not how many
    // in the whole series, which would name periods the reader cannot see.
    const shown = { nominal: (view.marks ?? []).slice(from)
      .filter((r, i) => !r && bars[i] != null).length };

    chartSlot.replaceChildren(bars.some((v) => v != null)
      ? barChart(shownLabels, bars, {
          format: (v) => formatLine(spec, v),
          ariaLabel: `${stock.c} · ${T(spec.labelKey)}`,
        })
      : h('p', { class: 'panel-note' }, T('noStatements')));

    // The three figures under the chart answer the three questions the bars
    // raise: how big is it now, is it growing, and how much of the top line
    // survives to this row.
    const lastAt = lastIndexOf(values);
    const growth = yearOnYear(values, step);
    const margins = spec.of ? ratioSeries(values, viewOf(spec.of).values) : null;
    statsSlot.replaceChildren(...[
      lastAt < 0 ? null : figureStat(T('latestPeriod'),
        formatLine(spec, values[lastAt]), labels[lastAt]),
      lastAt < 0 || growth[lastAt] == null ? null : figureStat(T('yoyChange'),
        fmtPct(growth[lastAt], state.lang, { signed: true, digits: 1 }), null,
        `delta ${signOf(growth[lastAt])}`),
      margins?.[lastAt] == null ? null : figureStat(T('ofRevenue'),
        fmtPct(margins[lastAt], state.lang, { digits: 1 }), null),
    ].filter(Boolean));

    // Which caveat applies depends on the view: a rolling window needs saying,
    // and every lira figure needs the inflation note whichever window it is in.
    // Which caveat applies depends on the view AND on whether the lira have been
    // restated: `financialsNote` says the figures are nominal, and printing that
    // under a deflated chart would be the page contradicting itself.
    const money = on
      ? [T('realTermsNote', { year: cpi.latest }),
          shown.nominal ? T('realTermsPartial', { n: shown.nominal, year: cpi.latest }) : null]
      : [T('financialsNote')];
    noteEl.replaceChildren(document.createTextNode(
      [period === 'ttm' ? T('ttmNote') : null, ...money].filter(Boolean).join(' ')));
    tableSlot.replaceChildren(statementTable(fin, period, labels));
  }

  draw();
  return panel;
}

/** One figure with its label and, where it helps, the period it belongs to. */
const figureStat = (label, value, sub, cls = '') =>
  h('div', { class: 'stat' },
    h('dt', {}, label),
    h('dd', { class: cls }, value),
    sub ? h('span', { class: 'stat-sub num' }, sub) : null);

/** The last position in a series that carries a figure, or -1. */
function lastIndexOf(values) {
  for (let i = (values?.length ?? 0) - 1; i >= 0; i--) if (values[i] != null) return i;
  return -1;
}

/** A statement line in its own unit: lira per share keeps its decimals. */
function formatLine(spec, value) {
  if (value == null) return '—';
  return spec.kind === 'perShare'
    ? `₺${fmtNum(value, state.lang, 2)}`
    : fmtMoney(value, state.lang);
}

/**
 * The last eight periods as a table, every line at once.
 *
 * Newest on the left. A statement is read "what did it just do, and what was it
 * doing before" — putting the oldest column first would make every reader start
 * at the far end of a horizontal scroll.
 */
function statementTable(fin, period, labels) {
  const block = period === 'y' ? fin.y : fin.q;
  const values = (key) => {
    const raw = block?.[key] ?? [];
    return period === 'ttm' ? trailingTwelve(raw) : raw;
  };

  const cols = [];
  for (let i = labels.length - 1; i >= 0 && cols.length < STATEMENT_COLUMNS; i--) cols.push(i);

  const rows = STATEMENT_LINES
    .map((spec) => [spec, values(spec.key)])
    .filter(([, v]) => cols.some((i) => v[i] != null));
  if (!rows.length) return h('p', { class: 'panel-note' }, T('noStatements'));

  return h('table', { class: 'funds fin-table' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'fin-line' }, T('metricLabel')),
      cols.map((i) => h('th', { class: 'num-cell' }, labels[i])))),
    h('tbody', {}, rows.map(([spec, v]) =>
      h('tr', {},
        h('th', { class: 'fin-line', scope: 'row' }, T(spec.labelKey)),
        cols.map((i) => h('td', { class: 'num num-cell' }, formatLine(spec, v[i]))))))
  );
}

/**
 * Bars over a shared baseline, with a readout.
 *
 * A line would be wrong here. A price is continuous — it had a value at every
 * moment between two points, and joining them says something true. A quarter's
 * revenue is one number for a three-month block, and drawing a slope between
 * two of them claims the company earned its way smoothly from one to the other.
 *
 * The zero line is drawn wherever zero falls rather than at the foot of the
 * box, because losses are the reason to look: a quarter of negative free cash
 * flow has to hang below the line to read as one.
 */
function barChart(labels, values, { format, ariaLabel }) {
  const { w, h: H, padL, padR, padT, padB } = CHART;
  const innerW = w - padL - padR;
  const innerH = H - padT - padB;

  const present = values.filter((v) => v != null);
  const hi = Math.max(0, ...present);
  const lo = Math.min(0, ...present);
  const span = hi - lo || 1;
  const yOf = (v) => padT + (1 - (v - lo) / span) * innerH;
  const zero = yOf(0);

  const slot = innerW / values.length;
  const barW = Math.max(2, slot * 0.62);
  const centre = (i) => padL + slot * (i + 0.5);

  const bars = values.map((v, i) => {
    if (v == null) return null;
    const y = yOf(v);
    return svg('rect', {
      class: `fin-bar ${v < 0 ? 'down' : 'up'}`,
      x: (centre(i) - barW / 2).toFixed(2),
      y: Math.min(y, zero).toFixed(2),
      width: barW.toFixed(2),
      // A bar for a value that rounds to nothing still has to be visible, or
      // the chart shows a gap where a reported zero belongs.
      height: Math.max(1, Math.abs(zero - y)).toFixed(2),
    });
  });

  // Every other label when they would collide; the last one always survives, as
  // it is the period the figures above the chart are talking about.
  const every = labels.length > 9 ? Math.ceil(labels.length / 8) : 1;
  const ticks = labels.map((label, i) =>
    (labels.length - 1 - i) % every === 0
      ? svg('text', {
          class: 'axis-x', x: centre(i).toFixed(2), y: H - 8, 'text-anchor': 'middle',
        }, text(label))
      : null);

  // Two labels, chosen by what the series does. All-positive gets the top and
  // its half, so a bar can be read against something other than the ceiling; a
  // series that goes negative gets both ends, because how far down it went is
  // the thing being asked.
  const gridValues = (lo < 0 ? [hi, lo] : [hi, hi / 2])
    .filter((v, i, a) => v !== 0 && a.indexOf(v) === i);
  const chart = svg('svg', {
    class: 'chart bar-chart', viewBox: `0 0 ${w} ${H}`,
    preserveAspectRatio: 'none', role: 'img', 'aria-label': ariaLabel,
  },
    gridValues.map((v) => svg('line', {
      class: 'grid', x1: padL, x2: w - padR, y1: yOf(v).toFixed(2), y2: yOf(v).toFixed(2),
    })),
    gridValues.map((v) => svg('text', {
      class: 'axis-y', x: padL - 6, y: (yOf(v) + 4).toFixed(2), 'text-anchor': 'end',
    }, text(format(v)))),
    svg('line', { class: 'grid grid-zero', x1: padL, x2: w - padR, y1: zero.toFixed(2), y2: zero.toFixed(2) }),
    bars,
    ticks
  );

  const wrap = chartFrame(chart, ariaLabel);
  attachCrosshair(wrap, chart, {
    dates: labels,
    xOf: (_, i) => centre(i),
    readout: (i) => ({
      title: labels[i],
      rows: [{ label: '', color: 'var(--accent)', value: format(values[i]) }],
    }),
  });
  return wrap;
}

/**
 * The exchange's own market for the listing, as a chip.
 *
 * The watchlist market earns a warning colour rather than the quiet grey: the
 * exchange moves a company there when something about it needs supervising, and
 * a reader looking at the price ought to know that before the P/E.
 */
function marketChip(code) {
  const name = MARKET_NAMES[code];
  if (!name) return null;
  const watched = code === 'WL';
  return h('li', {
    class: `chip ${watched ? 'chip-warn' : 'chip-quiet'}`,
    title: watched ? T('marketWatchNote') : null,
  }, T(name));
}

const MARKET_NAMES = {
  STARS: 'marketStars',
  MAIN: 'marketMain',
  SUBMARKET: 'marketSub',
  PMTP: 'marketPre',
  SPFM: 'marketFunds',
  WL: 'marketWatch',
};

// ------------------------------------------------------- the balance sheet

/** What the company owns, what it owes, and how far apart those are. */
function shareBalance(stock) {
  const ebitda = stock.ebitda ?? null;
  const leverage = netDebtToEbitda(stock.ndebt, ebitda);
  const netCash = stock.ndebt != null && stock.ndebt < 0;

  return sharePanel('shareBalance', [
    ['totalAssets', fmtMoney(stock.assets, state.lang), null],
    ['totalLiabilities', fmtMoney(stock.liab, state.lang), null],
    ['totalEquity', fmtMoney(stock.eq, state.lang), null],
    ['cashHeld', fmtMoney(stock.cash, state.lang), null],
    ['shortTermDebt', fmtMoney(stock.stDebt, state.lang), null],
    ['longTermDebt', fmtMoney(stock.ltDebt, state.lang), null],
    // A company holding more cash than debt is described that way rather than
    // as owing a negative amount, which is how a balance sheet is actually read.
    [netCash ? 'netCash' : 'netDebt',
      fmtMoney(netCash ? -stock.ndebt : stock.ndebt, state.lang), 'netDebtNote'],
    // Only asked of a company that owes something. "Minus 1.2 years to repay"
    // is not a sentence, and a net-cash balance sheet has already said the good
    // news on the row above.
    ['netDebtEbitda',
      netCash || leverage == null ? '—' : T('nYears', { n: fmtNum(leverage, state.lang, 1) }),
      'netDebtEbitdaNote'],
    ['bookValuePerShare', money(stock.bvps, 2), null],
  ]);
}

/**
 * Two published scores, with the band each one falls in.
 *
 * Both are stated with their thresholds rather than as bare numbers: "Altman Z
 * 3.2" means nothing without knowing that 2.99 is the line, and a score whose
 * scale a reader has to look up elsewhere is not information.
 */
function shareHealth(stock) {
  const rows = [
    stock.altman == null ? null
      : ['altmanZ', fmtNum(stock.altman, state.lang, 2), altmanBand(stock.altman), 'altmanNote'],
    stock.piotroski == null ? null
      : ['piotroskiF', `${stock.piotroski} / 9`, piotroskiBand(stock.piotroski), 'piotroskiNote'],
  ].filter(Boolean);
  if (!rows.length) return null;

  return h('section', { class: 'panel share-panel' },
    h('h2', {}, T('shareHealth')),
    h('dl', { class: 'figure-list' }, rows.map(([labelKey, value, band, noteKey]) =>
      h('div', { class: 'figure' },
        noted('dt', {}, T(labelKey), T(noteKey)),
        h('dd', { class: 'num' },
          value,
          h('span', { class: `band band-${band}` }, T(bandKey(band)))))))
  );
}

const bandKey = (band) =>
  band === 'safe' ? 'bandSafe' : band === 'distress' ? 'bandDistress' : 'bandGrey';

/**
 * Where the brokers covering the share think it is going.
 *
 * The count leads and the range is drawn, because the middle of eleven targets
 * and one broker's number are different objects and only the spread says which
 * one you are looking at.
 */
function shareAnalysts(stock) {
  const view = consensus(stock, sharePrice(stock).price);
  if (!view) return null;
  const { price } = sharePrice(stock);
  const position = rangePosition(price, view.low, view.high);
  const total = view.buy + view.hold + view.sell;

  return h('section', { class: 'panel share-panel' },
    h('h2', {}, T('shareAnalysts')),
    h('p', { class: 'panel-note' }, T('analystNote')),
    h('dl', { class: 'stat-row stat-row-inset' },
      h('div', { class: 'stat' },
        h('dt', {}, T('priceTarget')), h('dd', {}, money(view.target, 2))),
      view.upside == null ? null : h('div', { class: 'stat' },
        h('dt', {}, T('targetUpside')),
        h('dd', { class: `delta ${signOf(view.upside)}` },
          fmtPct(view.upside, state.lang, { signed: true, digits: 1 }))),
      h('div', { class: 'stat' },
        h('dt', {}, T('coverage')), h('dd', {}, fmtInt(view.n, state.lang))),
      stock.nextReport ? h('div', { class: 'stat' },
        h('dt', {}, T('nextReport')),
        h('dd', {}, fmtDate(stock.nextReport, state.lang))) : null
    ),
    // The track is deliberately not the red-to-green one the 52-week range uses.
    // Sitting at the bottom of a year's range and sitting at the bottom of what
    // analysts think it is worth are opposite pieces of news, and a gradient
    // that coloured the second like the first would say the wrong one.
    position == null ? null : h('div', { class: 'range-bar' },
      h('div', { class: 'range-track range-plain' },
        h('span', { class: 'range-mark', style: `left:${position}%` })),
      h('div', { class: 'range-ends num' },
        h('span', {}, money(view.low, 2)),
        h('span', { class: 'range-label' }, T('targetRange')),
        h('span', {}, money(view.high, 2)))
    ),
    total === 0 ? null : h('div', { class: 'rating-bar' },
      [['buy', view.buy], ['hold', view.hold], ['sell', view.sell]]
        .filter(([, n]) => n > 0)
        .map(([kind, n]) => h('span', {
          class: `rating rating-${kind}`,
          style: `width:${shareOfTotal(n, total)}%`,
          title: `${T(`rating${kind[0].toUpperCase()}${kind.slice(1)}`)}: ${n}`,
        }, String(n)))
    )
  );
}

// ------------------------------------------------------- dividends

/**
 * Twenty years of dividends per share.
 *
 * Charted rather than tabulated because the question is "has it kept paying",
 * and a gap in a row of bars answers that at a glance where a column of numbers
 * does not. The amounts are in the lira of the year declared and say so: a
 * company that paid ₺0.10 in 2012 and ₺7.76 in 2024 has not raised its dividend
 * seventy-fold, and a bonus issue divides the per-share figure besides.
 */
function renderDividends(stock, fin) {
  const years = fin?.y?.p ?? [];
  const dps = fin?.y?.dps ?? [];
  const paid = dps.some((v) => v != null && v > 0);

  const stats = [
    stock.dy == null ? null : figureStat(T('dividendYield'), pct(stock.dy, 2)),
    stock.payout == null ? null : figureStat(T('payout'), pct(stock.payout, 1)),
    stock.divYears ? figureStat(T('dividendStreak'),
      T('nYears', { n: fmtInt(stock.divYears, state.lang) })) : null,
    stock.exDiv ? figureStat(T('lastExDate'), fmtDate(stock.exDiv, state.lang)) : null,
  ].filter(Boolean);
  if (!paid && !stats.length) return null;

  return h('section', { class: 'panel' },
    h('h2', {}, T('shareDividends')),
    stats.length ? h('dl', { class: 'stat-row stat-row-inset' }, stats) : null,
    paid
      ? h('div', { class: 'fin-chart' },
          barChart(years.map(String), dps.map((v) => v ?? null), {
            format: (v) => (v == null ? '—' : `₺${fmtNum(v, state.lang, 2)}`),
            ariaLabel: `${stock.c} · ${T('dpsByYear')}`,
          }))
      : h('p', { class: 'panel-note' }, T('noDividends')),
    h('p', { class: 'panel-note' }, T('dpsNote'))
  );
}

// ------------------------------------------------------- forecasts

/**
 * What analysts expected each quarter against what the company reported.
 *
 * Newest first, and the quarter nobody has reported yet is kept at the top with
 * its forecast and no actual — the row a reader is actually looking for.
 */
function renderEstimates(stock, fin) {
  // A quarter the feed marks reported but files no revenue for is dropped: the
  // panel is a comparison, and a forecast with nothing beside it is not one.
  // The unreported quarter ahead is the deliberate exception.
  const rows = (fin?.est ?? []).filter((r) =>
    (r.done ? r.rev != null : r.revE != null));
  if (rows.length < 2) return null;
  // Brokers forecast years ahead — Tüpraş has six unreported quarters on file —
  // and a table of nothing but "not yet reported" answers no question. The next
  // one is worth showing; the five after it are not, and the reported quarters
  // they would have pushed out are the whole point of the panel.
  const done = rows.filter((r) => r.done);
  const ahead = rows.filter((r) => !r.done).slice(0, 1);
  const shown = [...ahead, ...done.slice(-(STATEMENT_COLUMNS - ahead.length)).reverse()];
  const record = beatRecord(rows, 'rev');

  return h('section', { class: 'panel' },
    h('h2', {}, T('shareEstimates')),
    record
      ? h('p', { class: 'own-move' },
          h('b', {}, T('beatCount', { b: record.beats, n: record.of })))
      : null,
    h('div', { class: 'table-wrap' },
      h('table', { class: 'funds' },
        h('thead', {}, h('tr', {},
          h('th', {}, T('periodLabel')),
          h('th', { class: 'num-cell' }, T('estimateForecast')),
          h('th', { class: 'num-cell' }, T('estimateActual')),
          h('th', { class: 'num-cell' }, T('surprise')))),
        h('tbody', {}, shown.map((r) => {
          const gap = r.done ? surpriseOf(r.rev, r.revE) : null;
          return h('tr', {},
            h('th', { class: 'num', scope: 'row' }, r.p),
            h('td', { class: 'num num-cell', 'data-label': T('estimateForecast') },
              fmtMoney(r.revE, state.lang)),
            h('td', { class: 'num num-cell', 'data-label': T('estimateActual') },
              r.done ? fmtMoney(r.rev, state.lang)
                : h('span', { class: 'row-sub' }, T('awaitingReport'))),
            h('td', { class: `num num-cell delta ${signOf(gap)}`, 'data-label': T('surprise') },
              gap == null ? '—' : fmtPct(gap, state.lang, { signed: true, digits: 1 })));
        }))
      )),
    h('p', { class: 'panel-note' }, T('estimatesNote'))
  );
}

// ------------------------------------------------------- peers

/** The columns a company is compared with its neighbours on. */
const PEER_COLUMNS = [
  { key: 'cap', labelKey: 'marketCap', fmt: (s) => fmtMoney(s.cap, state.lang) },
  { key: 'pe', labelKey: 'peRatio', fmt: (s) => multiple(s.pe) },
  { key: 'pb', labelKey: 'pbRatio', fmt: (s) => multiple(s.pb, 2) },
  { key: 'roe', labelKey: 'roe', fmt: (s) => pct(s.roe, 1) },
  { key: 'nm', labelKey: 'netMargin', fmt: (s) => pct(s.nm, 1) },
  { key: 'dy', labelKey: 'dividendYield', fmt: (s) => pct(s.dy, 2) },
];

/**
 * The company beside the largest others doing the same thing.
 *
 * A multiple on its own is not a judgement. A P/E of 14 is cheap for a bank and
 * dear for a steel mill, and the only way a page can say which is to put the
 * neighbours next to it — with the middle of the industry on its own row, so
 * the comparison has a centre rather than eight numbers to eyeball.
 */
function renderPeers(stock) {
  const peers = peersOf(stock, shares?.list ?? []);
  if (!peers.length) return null;
  const middle = peerMedians([stock, ...peers], PEER_COLUMNS.map((c) => c.key));

  // Every figure carries its own heading: below 820px the table becomes a stack
  // of cards with no header row to look up to, and six unlabelled numbers in a
  // column identify nothing.
  const row = (s, cls) => h('tr', { class: cls },
    h('th', { scope: 'row' },
      h('a', { class: 'code-link num', href: `#/hisse/${s.c}` }, s.c),
      h('span', { class: 'row-sub' }, s.n)),
    PEER_COLUMNS.map((c) =>
      h('td', { class: 'num num-cell', 'data-label': T(c.labelKey) }, c.fmt(s))));

  return h('section', { class: 'panel' },
    h('h2', {}, T('sharePeers')),
    h('p', { class: 'panel-note' }, `${stock.ind} · ${T('peersNote')}`),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'funds peer-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, T('company')),
          PEER_COLUMNS.map((c) => h('th', { class: 'num-cell' }, T(c.labelKey))))),
        h('tbody', {},
          row(stock, 'peer-self'),
          peers.map((s) => row(s, '')),
          h('tr', { class: 'peer-median' },
            h('th', { scope: 'row' }, T('industryMedian')),
            PEER_COLUMNS.map((c) =>
              h('td', { class: 'num num-cell', 'data-label': T(c.labelKey) },
                c.fmt({ ...middle, c: '', n: '' })))))
      ))
  );
}

// ---------------------------------------------------------------- charts

const CHART = { w: 900, h: 260, padL: 44, padR: 12, padT: 12, padB: 26 };

/** A focusable, position:relative box a chart and its readout can share. */
const chartFrame = (chart, ariaLabel) =>
  h('div', { class: 'chart-frame', tabindex: '0', role: 'group', 'aria-label': ariaLabel }, chart);

/**
 * Crosshair and readout for the hand-rolled SVG charts.
 *
 * The charts are drawn in viewBox units and stretched to the container width
 * (`preserveAspectRatio="none"`), so pointer positions are mapped back through
 * the element's measured box rather than assumed to be 1:1.
 *
 * Arrow-key support is part of the feature, not a courtesy: a chart whose only
 * readout is hover cannot be read without a pointer at all.
 *
 * @param {HTMLElement} wrap  the chart frame
 * @param {SVGElement} chart  the svg itself
 * @param {object} spec
 * @param {string[]} spec.dates      one entry per readable position, ascending
 * @param {(date:string, i:number)=>number} spec.xOf  viewBox x for a position
 * @param {(i:number)=>{title:string, rows:{label:string,color:string,value:string}[],
 *                      points?:{y:number,color:string}[]}} spec.readout
 */
function attachCrosshair(wrap, chart, { dates, xOf, readout }) {
  if (!dates || dates.length < 2) return;
  const { w, h: H, padT, padB } = CHART;
  const xs = dates.map((d, i) => xOf(d, i));

  const rule = svg('line', { x1: 0, x2: 0, y1: padT, y2: H - padB });
  const marks = svg('g', {});
  const layer = svg('g', { class: 'crosshair', opacity: '0' }, rule, marks);
  chart.append(layer);

  const tip = h('div', { class: 'chart-tip' });
  wrap.append(tip);

  let active = -1;

  const nearest = (vx) => {
    let best = 0;
    let dist = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(xs[i] - vx);
      if (d < dist) {
        dist = d;
        best = i;
      }
    }
    return best;
  };

  function show(i) {
    if (i < 0 || i >= dates.length) return;
    active = i;
    const out = readout(i);
    const at = xs[i].toFixed(1);
    rule.setAttribute('x1', at);
    rule.setAttribute('x2', at);
    marks.replaceChildren(...(out.points ?? []).map((p) =>
      svg('circle', {
        cx: at, cy: p.y.toFixed(1), r: 3.5, fill: p.color,
        stroke: 'var(--surface)', 'stroke-width': 1.5,
      })));
    layer.setAttribute('opacity', '1');

    tip.replaceChildren(
      h('p', { class: 'tip-date' }, out.title),
      h('ul', {}, out.rows.map((r) =>
        h('li', {},
          h('span', { class: 'swatch', style: `background:${r.color}` }),
          h('span', { class: 'tip-label' }, r.label),
          h('span', { class: 'tip-val num' }, r.value))))
    );
    // Positioned as a fraction of the box so it tracks the chart at any width,
    // and flipped near the right edge so it never leaves the panel.
    const frac = xs[i] / w;
    tip.style.left = `${(frac * 100).toFixed(2)}%`;
    tip.classList.toggle('flip', frac > 0.62);
    tip.classList.add('is-on');
  }

  function hide() {
    active = -1;
    layer.setAttribute('opacity', '0');
    tip.classList.remove('is-on');
  }

  const track = (ev) => {
    const box = chart.getBoundingClientRect();
    if (!box.width) return;
    show(nearest(((ev.clientX - box.left) / box.width) * w));
  };

  wrap.addEventListener('pointermove', track);
  wrap.addEventListener('pointerdown', track);
  wrap.addEventListener('pointerleave', hide);
  wrap.addEventListener('blur', hide);
  wrap.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') return hide();
    const step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    const from = active < 0 ? (step > 0 ? -1 : dates.length) : active;
    show(Math.min(dates.length - 1, Math.max(0, from + step)));
  });
}

/** Stacked area of how the portfolio mix moved over time. */
function renderAllocHistory(allocRows) {
  const { w, h: H, padL, padR, padT, padB } = CHART;
  const groups = state.meta.groups;
  const innerW = w - padL - padR;
  const innerH = H - padT - padB;

  const dates = allocRows.map(([d]) => d);
  // Position by date, not by sample index: allocation snapshots are not evenly
  // spaced (holidays shift them), and an index scale would silently distort time.
  const t0 = Date.parse(dates[0]);
  const span = Date.parse(dates.at(-1)) - t0;
  const x = (i) => padL + (span <= 0 ? innerW / 2 : ((Date.parse(dates[i]) - t0) / span) * innerW);
  const y = (v) => padT + innerH - (v / 100) * innerH;

  // Per-date group totals, positives only (a stacked area cannot show borrowing).
  const stacks = allocRows.map(([, alloc]) => {
    const mix = {};
    for (const [code, pct] of Object.entries(alloc)) {
      const g = state.meta.assets[code]?.group;
      if (!g || pct <= 0) continue;
      mix[g] = (mix[g] ?? 0) + pct;
    }
    const total = Object.values(mix).reduce((s, v) => s + v, 0) || 1;
    for (const k of Object.keys(mix)) mix[k] = (mix[k] / total) * 100;
    return mix;
  });

  const present = groups.filter((g) => stacks.some((s) => (s[g.id] ?? 0) > 0.05));
  const areas = [];
  const baseline = new Array(stacks.length).fill(0);

  for (const g of present) {
    const top = stacks.map((s, i) => baseline[i] + (s[g.id] ?? 0));
    const upper = top.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const lower = baseline
      .map((v, i) => [x(stacks.length - 1 - i), y(baseline[stacks.length - 1 - i])])
      .map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`)
      .join('');
    areas.push(
      svg('path', {
        d: `${upper}${lower}Z`,
        fill: groupColor(g.id),
        // A hairline in the surface colour is the 2px spacer between stacked fills.
        stroke: 'var(--surface)',
        'stroke-width': 1.25,
      })
    );
    for (let i = 0; i < baseline.length; i++) baseline[i] = top[i];
  }

  const ticks = [0, 25, 50, 75, 100].map((v) =>
    svg('g', {},
      svg('line', { x1: padL, x2: w - padR, y1: y(v), y2: y(v) }),
      svg('text', { x: padL - 8, y: y(v) + 3, 'text-anchor': 'end' }, text(`${v}%`))
    )
  );

  const axisLabel = dateAxisLabeler(dates);
  const labels = [0, Math.floor(dates.length / 2), dates.length - 1].map((i) =>
    svg('text', {
      x: x(i), y: H - 8,
      'text-anchor': i === 0 ? 'start' : i === dates.length - 1 ? 'end' : 'middle',
    }, text(axisLabel(dates[i])))
  );

  const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${w} ${H}`,
    preserveAspectRatio: 'none', role: 'img', 'aria-label': T('portfolioOverTime') },
    svg('g', { class: 'grid' }, ticks),
    areas,
    svg('g', { class: 'axis' }, labels)
  );
  const frame = chartFrame(chart, T('portfolioOverTime'));

  attachCrosshair(frame, chart, {
    dates,
    xOf: (_d, i) => x(i),
    readout: (i) => ({
      title: fmtDate(dates[i], state.lang),
      // Only the groups actually present at that snapshot, heaviest first — a
      // list of eight rows where six read 0% is not a readout.
      rows: present
        .map((g) => ({ g, pct: stacks[i][g.id] ?? 0 }))
        .filter((r) => r.pct > 0.05)
        .sort((a, b) => b.pct - a.pct)
        .map((r) => ({
          label: label(r.g, state.lang),
          color: groupColor(r.g.id),
          value: fmtPct(r.pct, state.lang, { digits: 1 }),
        })),
    }),
  });

  return h('section', { class: 'panel' },
    h('h2', {}, T('portfolioOverTime')),
    h('p', { class: 'panel-note' },
      `${axisLabel(dates[0])} – ${axisLabel(dates.at(-1))} · ${T('chartHint')}`),
    frame,
    h('ul', { class: 'comp-legend' },
      present.map((g) =>
        h('li', {},
          h('span', { class: 'swatch', style: `background:${groupColor(g.id)}` }),
          h('span', {}, label(g, state.lang))))
    )
  );
}

/** Trailing slice of a [date, value] series. Falls back to the whole series. */
function tailByDays(series, days) {
  if (days == null || series.length < 3) return series;
  const cutoff = Date.parse(series.at(-1)[0]) - days * 86400000;
  const cut = series.filter(([d]) => Date.parse(d) >= cutoff);
  return cut.length >= 3 ? cut : series;
}

/** Prices run from a few kuruş to hundreds of lira; the axis follows the scale. */
const priceDigits = (v) => (v < 10 ? 3 : v < 1000 ? 2 : 0);


// The fund itself is drawn in the teal accent, so no benchmark may use a
// neighbouring hue — green sits too close to teal to tell apart in a line chart.
// `prefix` and the digit counts are what each series reads as in its OWN units,
// which is what the chart falls back to when only one series is shown.
const BENCHMARK_SERIES = [
  { key: 'bist100', tr: 'BİST 100', en: 'BIST 100', color: 'var(--g-equity)',
    prefix: '', axisDigits: 0, tipDigits: 0 },
  { key: 'goldgram', tr: 'Gram Altın', en: 'Gram Gold', color: 'var(--g-lease)',
    prefix: '₺', axisDigits: 0, tipDigits: 2 },
  { key: 'usdtry', tr: 'Dolar', en: 'US Dollar', color: 'var(--g-foreign)',
    prefix: '₺', axisDigits: 2, tipDigits: 4 },
  { key: 'mmf', tr: 'Para Piyasası Fonları', en: 'Money-Market Funds', color: 'var(--g-cash)',
    prefix: '', axisDigits: 0, tipDigits: 2 },
];

/**
 * The fund and its benchmarks on one chart, with a series picker and a range.
 *
 * One chart rather than two because a fund's own price and a gold price cannot
 * share a linear axis — which is what forced them apart in the first place. The
 * rule that lets one panel do both:
 *
 *   - **one series** is drawn in its OWN units (₺ for a NAV or a gram price,
 *     points for BIST), because that is the number people actually look up;
 *   - **two or more** are indexed to 100 at the window start, because five
 *     different scales share an axis no other way.
 *
 * So unticking everything but the fund gives you a plain price chart, and the
 * mode is stated in the note rather than left to be inferred.
 */
/**
 * One fund against the benchmarks. A thin caller of the chart below, which knows
 * nothing about funds.
 */
function renderFundChart(fund, prices) {
  const raw = { fund: prices };
  for (const b of BENCHMARK_SERIES) {
    const pts = state.benchmarks.filter((r) => r[b.key] != null).map((r) => [r.d, r[b.key]]);
    if (pts.length > 5) raw[b.key] = pts;
  }

  return renderChart({
    raw,
    emphasis: 'fund',
    series: [
      { key: 'fund', color: 'var(--accent)', width: 2.5, prefix: '₺', tipDigits: 4,
        axisDigits: null, name: () => `${T('benchmarkFund')} ${fund.c}` },
      ...BENCHMARK_SERIES.filter((b) => raw[b.key]).map((b) => ({
        key: b.key, color: b.color, width: 2, prefix: b.prefix,
        tipDigits: b.tipDigits, axisDigits: b.axisDigits, name: () => label(b, state.lang),
      })),
    ],
  });
}

/**
 * A line chart over any set of dated series, with a picker, a range control and
 * a crosshair.
 *
 * Series-agnostic on purpose: it knows about points and how to label them, not
 * about funds, so the shares that are going on it later need nothing further.
 * (The dashboard does not use it — six funds want six small charts, not six
 * lines on one axis.)
 *
 * @param {object} spec
 * @param {Record<string, [string, number][]>} spec.raw key -> ascending [date, value]
 * @param {object[]} spec.series display spec per key, in picker order
 * @param {string} [spec.emphasis] the key drawn last and at full opacity
 * @param {string} [spec.titleKey] i18n key for the heading
 */
function renderChart({ raw, series: SERIES, emphasis = null, titleKey = 'chartPanel' }) {
  const { w, h: H, padL, padR, padT, padB } = CHART;
  const innerW = w - padL - padR;
  const innerH = H - padT - padB;

  const on = new Set(SERIES.map((s) => s.key));
  let range = 'all';

  // The controls are built ONCE and updated in place. Re-creating them on every
  // redraw would blow away keyboard focus the moment you ticked a box with the
  // space bar, which makes the picker unusable without a mouse.
  const noteEl = h('p', { class: 'panel-note' });
  const slot = h('div', {});
  const valueEls = new Map();

  const pickerEl = h('ul', { class: 'series-picker', 'aria-label': T('seriesLabel') },
    SERIES.map((s) => {
      const val = h('span', { class: 'val num delta' }, '—');
      valueEls.set(s.key, val);
      return h('li', {},
        h('label', { class: 'check' },
          h('input', {
            type: 'checkbox', checked: on.has(s.key),
            onChange: (e) => {
              if (e.target.checked) on.add(s.key);
              else on.delete(s.key);
              draw();
            },
          }),
          h('span', { class: 'swatch', style: `background:${s.color}` }),
          h('span', { class: 'pick-name' }, s.name()),
          val
        )
      );
    })
  );

  const rangeButtons = CHART_RANGES.map((r) =>
    h('button', {
      type: 'button',
      'aria-pressed': String(range === r.key),
      onClick: () => { range = r.key; draw(); },
    }, T(r.labelKey)));

  const panel = h('section', { class: 'panel chart-panel' },
    h('h2', {}, T(titleKey)),
    h('div', { class: 'panel-head' },
      noteEl,
      h('div', { class: 'seg seg-range', role: 'group', 'aria-label': T('rangeLabel') },
        rangeButtons)
    ),
    slot,
    pickerEl
  );

  /** Repaint the note, the chart and each series' window change. */
  const settle = (note, frame, changeOf) => {
    noteEl.replaceChildren(document.createTextNode(note));
    slot.replaceChildren(...(frame ? [frame] : []));
    rangeButtons.forEach((b, i) =>
      b.setAttribute('aria-pressed', String(CHART_RANGES[i].key === range)));
    for (const [key, el] of valueEls) {
      const change = changeOf?.(key);
      el.className = `val num delta ${signOf(change)}`;
      el.textContent = change == null
        ? '—'
        : fmtPct(change, state.lang, { signed: true, digits: 1 });
    }
  };

  function draw() {
    const active = SERIES.filter((s) => on.has(s.key));
    if (!active.length) return settle(T('pickAtLeastOne'), null, null);

    const days = CHART_RANGES.find((r) => r.key === range).days;
    // One window, shared by every series in the picker.
    //
    // It ends at the newest date any series has, and "all" is floored at the
    // latest first-observation among the TICKED series. Both halves matter:
    //
    //   - a shared window is what makes the figures in the picker comparable.
    //     Left to their own histories, gram gold reports +153.7% (two years of
    //     data) beside the fund's +45.0% (one), in the same row, as though the
    //     two numbers were about the same period.
    //   - the floor follows what is ticked, not the whole set, because the cash
    //     index only goes back 255 days. Flooring on all of them would clip the
    //     fund's own 368-day price history over a series you never selected.
    //
    // Unticked series are windowed to the same range, so their number stays
    // comparable — which is exactly what tells you whether to tick them.
    const latest = Object.values(raw).map((pts) => pts.at(-1)[0]).sort().at(-1);
    const activeStart = active.map((s) => raw[s.key][0][0]).sort().at(-1);
    const cutoff = days == null
      ? null
      : new Date(Date.parse(latest) - days * 86400000).toISOString().slice(0, 10);
    const from = cutoff && cutoff > activeStart ? cutoff : activeStart;

    const windowed = new Map();
    for (const s of SERIES) {
      const pts = raw[s.key].filter(([d]) => d >= from);
      if (pts.length >= 2) windowed.set(s.key, pts);
    }
    const changeOf = (key) => {
      const pts = windowed.get(key);
      return pts ? (pts.at(-1)[1] / pts[0][1] - 1) * 100 : null;
    };

    const sliced = {};
    for (const s of active) {
      if (windowed.has(s.key)) sliced[s.key] = windowed.get(s.key);
    }

    const drawnKeys = Object.keys(sliced);
    if (!drawnKeys.length) return settle(T('tooShortForRange'), null, changeOf);

    const single = drawnKeys.length === 1 ? SERIES.find((s) => s.key === drawnKeys[0]) : null;
    const { dates, series } = single
      ? { dates: sliced[single.key].map(([d]) => d), series: { [single.key]: sliced[single.key] } }
      : alignAndIndex(sliced, from);
    if (dates.length < 2) return settle(T('tooShortForRange'), null, changeOf);

    const all = Object.values(series).flatMap((s) => s.map(([, v]) => v));
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const pad = (hi - lo) * 0.08 || Math.max(Math.abs(hi) * 0.02, 0.0001);
    const yMin = lo - pad;
    const yMax = hi + pad;

    // Positioned by date, not by sample index: the series have different holidays
    // and an index scale would silently distort time.
    const t0 = Date.parse(dates[0]);
    const span = Date.parse(dates.at(-1)) - t0;
    const x = (d) => padL + (span <= 0 ? innerW / 2 : ((Date.parse(d) - t0) / span) * innerW);
    const y = (v) => padT + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

    const line = (pts) =>
      pts.map(([d, v], i) => `${i ? 'L' : 'M'}${x(d).toFixed(1)},${y(v).toFixed(1)}`).join('');

    // The emphasised series is drawn last, on top, and the rest recede: on a fund
    // page the fund is the subject and the benchmarks are context. With nothing
    // emphasised — a watchlist, where every line is equally the subject — they
    // are all drawn at full strength.
    const ordered = [...SERIES].filter((s) => series[s.key]?.length)
      .sort((a, b) => (a.key === emphasis ? 1 : 0) - (b.key === emphasis ? 1 : 0));
    const paths = ordered.map((s) =>
      svg('path', {
        class: 'series', d: line(series[s.key]), stroke: s.color,
        'stroke-width': s.width,
        opacity: !emphasis || single || s.key === emphasis ? 1 : 0.75,
      }));

    const axisDigits = single
      ? (single.axisDigits ?? priceDigits(hi))
      : 0;
    const yTicks = [yMin, (yMin + yMax) / 2, yMax].map((v) =>
      svg('g', {},
        svg('line', { x1: padL, x2: w - padR, y1: y(v), y2: y(v) }),
        svg('text', { x: padL - 8, y: y(v) + 3, 'text-anchor': 'end' },
          text(fmtNum(v, state.lang, axisDigits)))
      )
    );

    const axisLabel = dateAxisLabeler(dates);
    const xLabels = [0, Math.floor(dates.length / 2), dates.length - 1].map((i) =>
      svg('text', {
        x: x(dates[i]), y: H - 8,
        'text-anchor': i === 0 ? 'start' : i === dates.length - 1 ? 'end' : 'middle',
      }, text(axisLabel(dates[i])))
    );

    const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${w} ${H}`,
      preserveAspectRatio: 'none', role: 'img', 'aria-label': T(titleKey) },
      svg('g', { class: 'grid' }, yTicks),
      paths,
      svg('g', { class: 'axis' }, xLabels)
    );
    const frame = chartFrame(chart, T(titleKey));

    // A series can be missing a print on a day another traded through, so each
    // gets its own date lookup rather than an index into a shared array.
    const lookups = ordered.map((s) => ({ ...s, at: new Map(series[s.key]) }));

    attachCrosshair(frame, chart, {
      dates,
      xOf: (d) => x(d),
      readout: (i) => {
        const d = dates[i];
        const present = lookups.filter((l) => l.at.get(d) != null);
        return {
          title: fmtDate(d, state.lang),
          rows: present.map((l) => ({
            label: l.name(),
            color: l.color,
            // In native units, the value itself. Indexed, the change since the
            // window start — the raw index level is just that number plus 100.
            value: single
              ? `${l.prefix}${fmtNum(l.at.get(d), state.lang, l.tipDigits)}`
              : fmtPct(l.at.get(d) - 100, state.lang, { signed: true, digits: 1 }),
          })),
          points: present.map((l) => ({ y: y(l.at.get(d)), color: l.color })),
        };
      },
    });

    const note = single
      ? `${single.prefix}${fmtNum(sliced[single.key].at(-1)[1], state.lang, single.tipDigits)} · ` +
        T('nativeNote', { name: single.name() })
      : T('indexedNote', { date: axisLabel(dates[0]) });

    settle(`${note} · ${T('chartHint')}`, frame, changeOf);
  }

  draw();
  return panel;
}

const text = (s) => document.createTextNode(String(s));

const shortDate = (iso) =>
  new Intl.DateTimeFormat(state.lang === 'tr' ? 'tr-TR' : 'en-GB',
    { month: 'short', year: '2-digit', timeZone: 'UTC' })
    .format(new Date(`${iso}T00:00:00Z`));

/** Day precision — for spans of a few days, where "Aug 26 – Aug 26" says nothing. */
const dayDate = (iso) =>
  new Intl.DateTimeFormat(state.lang === 'tr' ? 'tr-TR' : 'en-GB',
    { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${iso}T00:00:00Z`));

/**
 * Axis labels that suit the window: a short range needs day precision, since
 * three ticks a fortnight apart would otherwise all read "Aug 26".
 */
function dateAxisLabeler(dates) {
  const span = (Date.parse(dates.at(-1)) - Date.parse(dates[0])) / 86400000;
  const fmt = new Intl.DateTimeFormat(
    state.lang === 'tr' ? 'tr-TR' : 'en-GB',
    span <= 120
      ? { day: 'numeric', month: 'short', timeZone: 'UTC' }
      : { month: 'short', year: '2-digit', timeZone: 'UTC' }
  );
  return (iso) => fmt.format(new Date(`${iso}T00:00:00Z`));
}

function debounce(fn, ms) {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
}

boot();
