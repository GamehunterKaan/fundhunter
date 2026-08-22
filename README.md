# FundHunter

Every investment fund in Türkiye, and what they actually hold.

**[fundhunter.kaangultekin.net](https://fundhunter.kaangultekin.net/)**

A static, serverless site over the buyable TEFAS universe — **2,063 funds**,
mutual (YAT) and exchange-traded (BYF) — and all **648 Borsa İstanbul listings**
alongside them, showing each fund's portfolio composition, price history,
returns and risk, and each company's statements and who owns it — with
everything filtered and searched in the browser.

Data refreshes daily via GitHub Actions and is committed as JSON. There is no
backend and no build step. The only runtime dependency is the live-quote feed
behind the market tape, and the page falls back to committed closes without it.

---

## Why this exists

TEFAS publishes the data but makes it hard to *compare*. The question a saver
actually has — "which funds are worth buying, and what am I really exposed to?" —
needs composition, cost of risk, and a benchmark side by side. That is what this
builds toward.

The design follows from the data: every fund is a set of weights summing to 100,
so the **composition bar** is the recurring unit of the interface — one for the
whole industry in the hero, one per row in the table, one full breakdown per fund.

---

## Architecture

Deliberately the same shape as [canakkale-hat-sefer](https://github.com/GamehunterKaan/canakkale-hat-sefer):
plain ES modules, no bundler, GitHub Pages.

```
index.html          shell — masthead (nav + search), market tape, toggles, mount
live.js             runtime quotes for the market tape (index, FX, gold), with a
                    testable parser and a fall back to the committed closes
quotes.js           runtime quotes for every share on Borsa Istanbul and the US
                    names funds hold, plus the arithmetic that turns them into a
                    fund's estimated move. Separate from live.js: different
                    source, different failure mode — one being blocked must not
                    take the other down
core.js             headless logic: i18n, formatting, filter/sort, composition
                    maths, return/risk metrics, and HORIZONS — the one list of
                    return windows. No DOM: imported by the browser, the build
                    scripts AND the tests, so a "1-year return" has exactly one
                    definition.
analytics.js        tax model, peer groups, risk bands, fund flows, factor
                    models and ranking. Same three consumers.
ui.js               browser layer: routing, rendering, inline-SVG charts
styles.css          design tokens + layout

data/               committed output of the daily cron
  meta.json           taxonomy, categories, managers, colours, peer stats
  funds.json          one line per fund — the list/search index
  history/<CODE>.jsonl  per-fund daily prices + weekly allocation
  benchmarks.jsonl    BIST 100/30, USD, EUR, gold, money-market index — five
                      years, because the crash measure needs to see past falls
  sectors.json        the line of business and dividend yield of every listing
                      the funds hold. Build input; the browser never fetches it
  crashes.json        BIST's falls, and what every fund did over each of them
  stocks.json         648 Borsa Istanbul listings: figures, balance sheet,
                      analyst targets, and which funds hold each one. Fetched
                      only when a share page or the share list is opened
  stocks/<CODE>.jsonl per-share daily adjusted close and volume
  stocks/<CODE>.fin.json  the company's own statements — 32 quarters and 20
                        years. Fetched only on that company's page
  holdings/<CODE>.json  individual positions, from the monthly KAP filing, each
                        with what it weighed the month before
  holdings/index.json   which funds have holdings, and the coverage figures

The universe is what a saver can actually buy: pension (EMK) funds were dropped
because you cannot buy one directly — a BES contract with its provider is the only
route — and GYF/GSYF are closed-end. `pruneHistory` deletes the history files of
anything that leaves the universe, so a delisting does not leave a file behind.

scripts/
  fetch-tefas.mjs       funds, holdings, history  → data/
  fetch-benchmarks.mjs  comparison series         → data/benchmarks.jsonl
  build-analytics.mjs   flows, factor models, peer groups, crash protection,
                        themes and dividends → enriches funds.json; share
                        ownership → enriches stocks.json
  fetch-holdings.mjs    individual positions from KAP → data/holdings/
  fetch-sectors.mjs     sectors and dividend yields → data/sectors.json
  fetch-stocks.mjs      every Borsa Istanbul share, its figures and a year of
                        prices → data/stocks.json + data/stocks/
  fetch-crashes.mjs     fund prices at both ends of every BIST fall → crashes.json
  serve.mjs             local static server
  lib/tefas.mjs         TEFAS API client (retry, throttle, disk cache)
  lib/kap.mjs           KAP disclosure client (finds and downloads the filings)
  lib/pdf.mjs           PDF text extractor — positioned runs, no dependency
  lib/portfolio.mjs     reads a filing into holdings, and reconciles it
  lib/taxonomy.mjs      asset-class taxonomy + validated colour palette
  lib/jsonl.mjs         append-friendly JSONL storage

test/               node:test suites over core.js and analytics.js
```

### Running it

```bash
npm test              # 156 tests, no dependencies
npm run build:data    # all five stages in order
npm run serve         # http://localhost:8080
```

The five data stages must run in order — the falls need the benchmarks, the
sectors need the holdings, and analytics needs all of them. A cold `fetch-tefas`
takes ~30 minutes; with `.cache/` warm it is seconds.

`scripts/fetch-tefas.mjs --quick` fetches one month instead of twelve — useful
when working on the UI.

Holdings are refreshed separately, once a month rather than daily, because that
is how often the source is published. Each run also reads the month before, to
work out which positions grew, shrank or are new:

```bash
npm run fetch:holdings              # last month, every fund
node scripts/fetch-holdings.mjs --month 2026-07 --report   # coverage, writes nothing
node scripts/fetch-holdings.mjs --codes TLY,HVZ            # a couple of funds
node scripts/fetch-holdings.mjs --no-previous               # skip the comparison month
```

The first pass downloads about a thousand PDFs per month and KAP throttles hard —
measured at roughly 200 an hour — so expect hours, not minutes. Downloads are
cached, so a re-run only fetches what is new, and each fund is written the moment
both of its months are read: an interrupted run leaves a consistent partial state
rather than nothing. Funds are processed largest first, so the pages most people
open have their comparison within the first few minutes rather than the last.

---

## The TEFAS API

TEFAS moved to `tefas.gov.tr` on a Next.js stack; the old
`fundturkey.com.tr/api/DB/BindHistory*` endpoints are gone. The current API is
public and unauthenticated but undocumented. All methods are `POST` with a JSON
body and live under `https://www.tefas.gov.tr/api/funds/`:

| Method | Returns |
|---|---|
| `fonGnlBlgSiraliGetir` | price, shares, investor count, portfolio size |
| `dagilimSiraliGetirT` | portfolio allocation — ~55 percentage fields |
| `fonTurGetir` | umbrella fund categories (`sfonTuru` codes) |
| `fonGrupGetir` | fund groups |
| `fonGetir` | the full universe with fine-grained `fonTurAciklama` |
| `fonBilgiGetir` | per fund: category, peer rank, market share (1 request/fund) |

Every request must carry the full body shape even for unused filters; see
`requestBody()` in `scripts/lib/tefas.mjs`.

One endpoint lives elsewhere and answers with a **bare array** rather than the
`{resultList}` envelope:

```
POST /api/fund-returns/export
{
  format,       // excel | csv | pdf | json
  listingType,  // return | management | operatingExpense | size
  fundType,     // YAT | EMK | BYF
  locale,       // tr | en
  filters: {
    islem,          // 1 = traded on the platform, 0 = not, null = all
    calismaTipi,    // 1 when a date range is given, else 2
    kurucuKodu, fonTurKod, fonGrubu, fonTurAciklama, sfonTurKod,
    // listingType 'return' ONLY — omit these and every getiri* column is null:
    getiriOrani: '1',
    donemGetiri1a: '1', donemGetiri3a: '1', donemGetiri6a: '1',
    donemGetiriyb: '1', donemGetiri1y: '1', donemGetiri3y: '1', donemGetiri5y: '1'
  }
}
```

It is the only public source for three things that matter a lot:

- `listingType: 'return'` → **`riskDegeri`**, TEFAS's official risk value (1–7),
  plus 1m/3m/6m/YTD/1y/3y/5y returns. A risk value of 7 also means the fund may
  only be sold to qualified investors.
- `listingType: 'management'` → **`fonTopGiderKesoran`** (total expense ratio),
  `uygulananYu1Y` (applied management fee) and `fonIcTuzukYu1G` (prospectus cap).
- **Platform status** — whether the fund is actually buyable. The site decides this
  from a `tefasDurum` field (`befasDurum` for pension funds), but the export
  *strips* it: it is on the hidden-column list in `common-*.js`. Instead, query
  `filters.islem = 1` and take membership of the result. For YAT that partitions
  cleanly — 1052 traded + 1085 not = 2137 total, zero overlap.

Numbers there are Turkish-formatted strings — `"2,04"` means 2.04.

TEFAS's published returns are preferred over ones computed from the price series,
because they are what the site itself displays. They do differ: TEFAS reports
684.94% for TLY over one year where our series gives 779.65%.

Things learned the hard way, all handled in the client:

- **One month per request.** Longer ranges are silently truncated, so date ranges
  are split into 28-day chunks.
- **Rate limiting is aggressive.** Concurrency 2 with adaptive backoff; a 429
  widens the global request spacing and it decays back after a clean streak.
- **Weekends and holidays** come back as `errorMessage: "Index 0 out of bounds…"`
  rather than an empty list. That is an empty result, not a failure.
- **The HTML site is behind F5 bot protection**, but the JSON API is not. Even a
  real headless browser gets "Request Rejected" on fund pages, so the API is the
  only viable route.
- **Chunk boundaries are anchored to a fixed epoch**, not to the requested range.
  Anchoring to "today" gave every chunk a new cache key when the trading date
  rolled over, so the cron re-fetched all ~200 requests daily instead of one.
- **Allocation percentages are leaf values.** When a breakdown is present the
  aggregate is null and vice versa, so the non-null fields of a row sum to ~100
  and can be added without double counting.
- **Repo can be negative** when a fund is borrowing. Bars show positive holdings
  only and disclose it; the breakdown table shows true signed values.

Responses are cached gzipped under `.cache/` (git-ignored), which makes re-runs
cheap and the job resumable.

---

## The KAP filings

TEFAS says a fund is 37% precious metals. It never says *which* metals, or which
shares make up the equity sleeve. That comes from the **Portföy Dağılım Raporu**,
the portfolio distribution report every fund files monthly with
[KAP](https://www.kap.org.tr), and it is the only public route to a fund's actual
positions.

KAP's *pages* are behind bot protection — a headless browser renders about 1.4KB
of chrome and nothing else. Its **JSON tier is not**, which is the same split
TEFAS has, and that is what `lib/kap.mjs` uses.

```
POST /tr/api/disclosure/funds/byCriteria   {fromDate, toDate}
  → every fund disclosure in the range; keep subject == "Portföy Dağılım Raporu"
GET  /tr/Bildirim/{disclosureIndex}
  → the Next.js flight payload carries attachments: [{objId, fileName}]
GET  /tr/api/file/download/{objId}
  → the PDF
```

Four things about this that are not obvious:

- The disclosure query **caps at 2000 rows and its `page` field does nothing** —
  asking for page 2 returns the identical set. The only way past the cap is to
  narrow the dates, so the filing window is walked day by day.
- Sending the filter fields KAP's own UI sends (`disclosureClass`, `subjectList`,
  …) makes the endpoint answer **HTTP 500**. A bare date range works, so subject
  filtering happens client-side.
- The file endpoint returns a **Java-serialised `byte[]`**, not a file: the
  0xACED stream magic comes first and `%PDF` starts a few bytes in.
- `attachmentCount` is in the listing, so the handful of filings with no PDF are
  skipped without spending a request on them.

Reports are filed between roughly the 3rd and the 10th of the following month.

### Reading the PDFs

`lib/pdf.mjs` is a small PDF text extractor — Flate streams, Type0 fonts, a
ToUnicode CMap per font — returning positioned text runs and leaving table
reconstruction to the caller. A library would have been the obvious move; this
project has no dependencies by design and the reports use a narrow slice of the
format.

Four bugs in it each produced *nothing* rather than something visibly wrong, so
all four are regression-tested:

1. **Pages were pooled** into one coordinate space, so rows that merely shared a
   y on different sheets merged — the fund-identity table ended up spliced
   through the holdings rows.
2. **Page order came from object numbering**, which is not page order. An ETF
   files a month of daily reports as one 114-page PDF, and its table landed under
   the wrong heading.
3. **Streams were assumed to be Flate.** Several filers store their ToUnicode
   CMaps uncompressed, and their fonts then decoded to raw glyph codes.
4. **The graphics matrix was ignored.** A whole class of filers draws the page
   through a vertical flip (`cm 0.75 0 0 -0.75 0 841.92`), which turns every page
   upside down: headings under their own tables, nothing parseable. Honouring the
   matrix took that group from 0 to 100% parsed.

Two encoding traps sit underneath: the fonts are **subsetted**, so glyph codes
are renumbered and Turkish never resolves without the CMap; and the codes are
**two bytes packed inside ordinary `(...)` literals**, so a byte-at-a-time read
puts a NUL between every glyph and yields `P o r t f ö y`.

### Reading the table

`lib/portfolio.mjs` turns a filing into holdings. The regulator fixes the
contents but not the typesetting, so filers use **two templates** and both are
supported — a wide landscape table for most of the market, and a narrow portrait
one with lettered asset-class sections. Numbers arrive as `1.234,56` or
`1,234.56` depending on the filer, so the convention is detected per document;
reading one as the other is silent and off by a factor of a thousand.

**The weight has to come from the FPD column, not from the value.** A report
prints three percentages per row: share of its group, share of the fund's
*portfolio* value (FPD), and share of the fund's *total* value (FTD). Only FPD is
a portfolio weight, and the difference is not cosmetic — a futures position or an
FX balance carries a market value but an FPD of zero. One sampled fund holds
8.8bn of futures notional against a 43bn portfolio; deriving weights from value
would have shown it owning a fifth more than it does.

### Trusting the result

Every group prints a subtotal directly beneath the rows that make it up, so a
parse that read the wrong column, dropped a row or double-counted one cannot add
up. That check is the whole safety net, and it separates two failures that look
identical from outside:

- **The parse is wrong** — subtotals do not reproduce. The fund is skipped, never
  published.
- **The report is wrong** — every subtotal reconciles but the overall total does
  not. One filer states a weight computed against a position's dollar nominal
  rather than its lira value, so its own percentages sum to 94.94%. Throwing that
  fund away over someone else's arithmetic would be the wrong call, so it
  publishes with the discrepancy recorded and shown on the page.

Some reports cannot be read at all and are skipped with a reason rather than
guessed at: a filer who submits a scan with no text layer, one Ghostscript
producer whose fonts carry no usable encoding, and options tables whose column
layout puts the value column beyond reach.

One more trap worth writing down, because it is invisible until it bites:
**JavaScript's `i` flag does not fold Turkish dotted İ onto i**. A pattern ending
in a literal `i` matched the mixed-case reports and silently missed every
upper-case one, which cost the net asset value across a whole template.

---

## Data model

History is **cumulative and append-only**. The fetch window slides forward, but
nothing already on disk is dropped, and files are newline-delimited and sorted by
date — so a daily run appends a line or two per fund and the git delta stays
proportional to what changed rather than to the file size.

`data/history/AAK.jsonl`:

```json
{"d":"2026-08-13","p":3.4589,"iv":4468,"sz":2111110055.37}
{"d":"2026-08-14","p":3.4617,"iv":4468,"sz":2113904811.02,"a":{"hs":79.76,"tr":13.08}}
```

`p` price · `iv` investors · `sz` portfolio size · `a` allocation (weekly
snapshots only, raw TEFAS field codes). Shares outstanding is deliberately not
stored — it is exactly `sz / p`.

`data/stocks/ASELS.jsonl` is the same shape for a share:

```json
{"d":"2026-08-19","p":381.25,"v":27561732}
{"d":"2026-08-20","p":402.25,"v":26923899}
```

`p` is the **adjusted** close and `v` the volume in shares. Same window as the
funds, same merge-don't-overwrite rule: a day the source stops returning is still
a day that happened.

### Benchmarks

Sourced from Yahoo Finance: `XU100.IS`, `XU030.IS`, `USDTRY=X`, `EURTRY=X`,
`GC=F`. Gram gold in TRY is derived (`goldusd / 31.1035 × usdtry`).

Five years of it, rather than the two the charts need: [crash
protection](#crash-protection) cuts the index into its falls, and it can only
find the fall of March 2025 if it can also see the peaks either side of it.

The deposit benchmark (`mmf`) is **derived, not quoted**: TCMB publishes
weighted-average deposit rates only through EVDS, which needs an API key. Instead
it chains the size-weighted daily return of every TRY money-market fund on TEFAS.
Those funds hold deposits and repo, so the series tracks realised deposit yield
net of fund fees — and unlike a headline rate, it is something you can actually
buy.

---

## Asset-class colours

The eight asset groups use a **CVD-validated categorical palette in a fixed
order**. Eight is a hard cap, not a coincidence — it is how many hues stay
distinguishable under colour-vision deficiency. Adjacent-pair separation is
ΔE 9.1 (light) and 8.4 (dark) against this site's surfaces.

Reordering or extending `GROUPS` in `scripts/lib/taxonomy.mjs` invalidates that,
so re-run the validator if you touch it. The 55 raw TEFAS fields still appear
individually in the fund detail table; the groups only govern colour and the
coarse exposure filters.

Two related rules the UI holds to: the teal accent exists precisely because red
and green are reserved for gains and losses, and every return value pairs its
colour with an arrow glyph so colour is never the only carrier of meaning.

---

## Quality scoring

Only **349 of 1,991 funds (17.5%) beat cash** over the past year, after tax. The
median equity fund returned 28.2% and the median bond fund 23.6%, against 47.8%
for money-market funds. Any ranking that does not put that hurdle front and
centre would be flattering nonsense, so the money market is the benchmark
everything is measured against.

Funds are ranked on **after-tax excess return over cash, per unit of volatility**
— one defensible number rather than a blended score with invented weights.
Everything else is an explicit flag you can read and disagree with: beats cash,
beats peers, contained drawdown, short history, small fund.

Two rules keep that comparison honest, and both started as bugs:

- **The hurdle matches the horizon.** `meta.cashReturns` holds a money-market
  return per window — 3.48% over a month, 10.45% over three, 47.80% over a year.
  Subtracting the annual figure from a three-month fund return is a 37-point
  error on every row, so `cashReturnFor` returns null rather than substitute the
  wrong window, and the ranking blanks instead of lying.
- **The gap is in percentage points, not per cent.** A fund on 52% against a
  benchmark on 48% did not beat it "by 4%". `fmtPoints` spells out the unit, and
  a test asserts the output never contains a percent sign.

The horizon control drives all of it at once: the return column, the hurdle, the
ranking and the sort. `HORIZONS` in `core.js` is the only list of windows, and a
test asserts each one has a label, a sort string and a matching sort accessor.

Peers are derived from **what a fund actually holds**, not TEFAS's umbrella
category, which files a gold fund and a leveraged equity fund under the same
label. Eight peer groups, each with its own median.

Withholding rates are **configurable defaults, not advice**. Turkish rates differ
by fund type and holding period and have been amended repeatedly; the UI labels
them as assumptions and lets you override them.

### Leverage

**82 of 2,062 funds hold more than they own**, 14 of them past 2× and the largest
at 10.6×. There is a filter for them and a chip on the fund page carrying the
multiple, because leverage multiplies the losses as well as the gains and a saver
comparing returns deserves to know which ones came geared.

It reads off TEFAS's own composition. Asset-class weights are published against
net asset value and sum to 100, so a fund that borrows reports the borrowing as a
**negative class** — almost always cash, where repo sits — and its positive
classes then add up to more than 100. Summing the positive side is the gross
exposure.

Two things about that choice:

- **TEFAS rather than the KAP filings**, even though the filings are richer. The
  composition covers all 2,062 funds instead of the 874 whose filing could be
  read, and a filing lists gross buys and sells rather than a netted position —
  summing its positive weights counts a share bought and sold twice, reading one
  fund as 389% gross against 106% here.
- **Derivative leverage is not in the figure**, and the tooltip says so. A futures
  position's weight is stated against the portfolio's value rather than the
  contract's size, so a fund can run large index exposure through VİOP and still
  report 1.0×. The filings do show the cash posted as margin — 6 funds have more
  than half their portfolio sitting at the derivatives exchange as collateral —
  which is a signal but not a multiple, and inferring one from a margin rate would
  be guessing.

The threshold is 1.05×, not 1.0: weights are published to two decimals and a fund
can round its way past 100% without having borrowed anything.

## Crash protection

Every return on this site is measured over a window the market spent mostly
rising. That flatters everyone. This measures the other thing: **what happened to
your money the last ten times BIST fell**.

`#/dusus` carries it, there is a filter and a sort on the main list, and every
fund page shows its own record fall by fall.

### Finding the falls

`crashEpisodes()` in [analytics.js](analytics.js) cuts the BIST 100 series into
declines of **10% or more, from a local high to the low that follows it**, over
the last three years. Ten of them:

| From | To | Days | BIST 100 | Money market | Funds priced |
|---|---|---|---|---|---|
| 3 Oct 2023 | 20 Oct 2023 | 17 | −11.8% | +1.8% | 1,180 |
| 27 Nov 2023 | 27 Dec 2023 | 30 | −10.5% | +3.3% | 1,218 |
| 22 Jul 2024 | 26 Aug 2024 | 35 | −14.4% | +4.8% | 1,413 |
| 2 Sep 2024 | 5 Nov 2024 | 64 | −14.8% | +8.8% | 1,451 |
| 17 Mar 2025 | 21 Mar 2025 | 4 | −16.7% | +0.6% | 1,615 |
| 26 Aug 2025 | 12 Sep 2025 | 17 | −10.0% | +2.1% | 1,803 |
| 22 Sep 2025 | 17 Oct 2025 | 25 | −11.0% | +3.0% | 1,820 |
| 16 Feb 2026 | 30 Mar 2026 | 42 | −12.0% | +4.2% | 1,945 |
| 11 May 2026 | 21 May 2026 | 10 | −13.0% | +1.0% | 1,972 |
| 18 Jun 2026 | 30 Jul 2026 | 42 | −10.4% | +4.6% | 1,986 |

This is **not** the textbook drawdown, which runs from a peak until that peak is
regained. That definition merges separate crashes into one long underwater
stretch: BIST's July 2024 high was not reclaimed until August 2025, which
swallows the March 2025 crash — the deepest of the three years, and the one
everybody remembers — whole. Here a fall ends when the index rebounds 5% off its
low, and the next high is measured from there.

Three years rather than five because coverage is what limits it: 1,184 of 2,063
funds have three years of history and only 620 have five, so a longer window
would score most funds on the recent falls anyway while making the few old funds'
figures incomparable with everyone else's.

### Measuring the funds

A fund's return over a fall needs two prices, not a daily series, so
[fetch-crashes.mjs](scripts/fetch-crashes.mjs) asks TEFAS for the NAV at the two
ends of each one — around 40 small requests, cached by date, so a past fall is
only ever fetched once. That is what keeps `data/history/` at twelve months while
the falls reach back three years.

**Prices are read one business day after the market date**, on both ends, because
that is how TEFAS dates a NAV. Measured on four BIST 30 index trackers over five
falls: aligning on the date itself puts them 3.5 points off the index on average,
aligning on the next print 0.9.

### What the number means

**`spared` is the share of the fall the fund's holders were spared**, and the
whole scale is readable: 100 means they came through no worse off than if the
money had sat in a money-market fund, 0 means they took the index's hit in full,
above 100 means the fund made money the market did not, below 0 means it fell
further. Six BIST 30 index trackers land at 1, 2, 2, 3, 4 and 5 — which is the
calibration check, since tracking the index is exactly what avoiding none of its
fall looks like.

Two choices carry the measure.

- **Both sides are net of the money market**, and in Turkey that is not a
  refinement. These windows run up to two months and deposit rates alone add
  several per cent over one, so on raw returns a fund holding nothing but repo
  reads as having defended the portfolio brilliantly. İş Portföy's money-market
  fund scores 129 on raw returns and exactly 100 once the rate is off — and 100
  is the right answer, because holding a money-market fund is precisely what it
  did. Each fall carries its own rate: the median of what TRY money-market
  funds returned between the same two prices, since the `mmf` series in
  `benchmarks.jsonl` only spans the year of daily history the site publishes.
- **The headline is the median fall, not the compounded one.** Compounding lets a
  single extraordinary window carry the score. Hedef Portföy Doğu gained 160%
  across the ten falls taken together, which divided into the index's loss reads
  as 297 — a fund that looks like it defended superbly. It fell in six of the
  ten, by as much as 21%, and its median fall is 65: below the 88 the median fund
  managed. The median says what a fund usually does when the market falls.

Two things it does not say, both of which the page states rather than buries:

- It **rewards not being in the market almost as much as it rewards defending
  well**. A money-market fund scores exactly 100 every time, because it does. The
  top of the ranking is gold funds and money-market funds, and it should be.
- A median says **nothing about the worst case**. A fund can sit at 172 and still
  have lost 23% in a single fall — Tera Portföy Birinci does — so the worst fall
  is returned beside the score and shown in the same row, everywhere.

### Two ways the data lies, and what is done about it

- **Unit-price restatements.** A fund occasionally multiplies its unit price by
  some factor and divides the units by the same one, leaving holders with exactly
  what they had. TEFAS publishes the new price with no marker, so the two prices
  either side read as a return of +8,229% — NEO Portföy İkinci, ₺1.20 to ₺116.87
  overnight in September 2025 — or of −99%. The units outstanding give it away: a
  return does not move them, flows do not move them opposite to the price, and
  only a restatement moves both by a large factor in opposite directions. Seven
  found and dropped.
- **Funds too small to have a price.** Under about ₺5m a unit price is not a
  market price — one subscription moves it. Pardus Dokuzuncu held ₺3.3m in July
  2024, reported its units as 9.5m, 1.5m, 3.3m and 265k on four consecutive days,
  and came out of that window with a "return" of +672%. Every remaining figure
  above +200% in three years of falls was one of these; the floor costs 436 of
  16,839 measurements and none survive it.

### Coverage

**2,008 of 2,063 funds are measured**, 99.7% of the industry's money, and 1,116
of them lived through all ten falls. The median fund was spared 88% of the fall;
367 came through without losing value at all, which is what the "held their value
through the falls" filter selects — the threshold is 100 because that is exactly
where the fund's own return crosses zero, not a taste dressed up as a number.

A fund needs **two** falls to get a figure. One is an anecdote.

## Themes and dividends

Two questions off the same fact — what line of business a share is in, and what
it paid — so they share one fetch and one pass over the holdings.

| | Where |
|---|---|
| **Theme** | a filter on the main list, plus a share threshold, and a breakdown on every fund page |
| **Dividend** | a yield floor in the preferences, a sort, and the same fund-page panel |

Neither is derivable from TEFAS. It publishes asset-*class* weights and, checked
field by field across all three of its exports, **no distribution column at all**
— only returns, risk and fees. Both figures therefore come from the individual
positions in the KAP filings, and exist only for the funds whose filing could be
read.

### Where the classification comes from

[fetch-sectors.mjs](scripts/fetch-sectors.mjs) asks TradingView's scanner — the
same feed [quotes.js](quotes.js) already prices these shares from — for the
sector, the industry and the trailing dividend yield of every listing. One
request covers the whole Turkish market; the foreign names are asked for by
ticker, read out of the filings. 1,415 listings, 58KB, and the browser never
downloads it.

**The grouping into themes is ours.** 102 industries appear in Turkish funds'
holdings and a filter with 102 entries is not a filter, so
[taxonomy.mjs](scripts/lib/taxonomy.mjs) maps them onto nineteen. Every industry
belongs to exactly one theme — overlapping themes would let a fund's exposures
add up past its own equity sleeve, and "40% banks, 55% finance" invites the
reader to add them. `banks` sits apart from `finance` because Turkish funds are
sold on that distinction and the exchange runs bank indices.

**Two tickers are overridden by hand**, and the list is deliberately two long:
Otokar builds the Cobra armoured vehicle and Katmerciler builds armoured and
riot-control vehicles, and both are filed under road transport. Somebody
filtering for savunma sanayi and not finding Otokar would conclude the filter is
broken. Every other assignment is the exchange's own.

**Exchange-traded funds carry no theme.** An ETF is not a company; there are 180
distinct ones in the holdings, and guessing which is which would be curation
dressed as data. Nine tenths of that money is in precious-metal ETFs — SLV, GLD,
GMSTR — which the asset-class composition already shows as metals.

97.5% of the share weight in a readable filing resolves to a theme.

### What the numbers mean

Theme weights are shares of the **whole fund**, not of its equity sleeve, so they
read against the composition bar and against each other. A levered fund's themes
can add past 100, which is correct: it holds more equity than it owns.

`dy` is the **dividend income of the portfolio** — each holding's trailing yield
times what the fund has in it. Two things it is not:

- It is **not a payment to you.** Turkish funds accumulate; the dividend lands in
  the unit price. The fund page says so where the number is.
- It is **not the yield of the shares.** A fund that is 30% equity in companies
  yielding 5% shows 1.5%, because that is what the fund earns.

The reference beside it is BIST 100's own cap-weighted yield, **1.49%**, and it
is offered as one of the filter's steps because "more than the market pays" is
the only threshold here that is not somebody's taste.

### Does it work

Neither measure ever looks at a fund's name, so the funds that name themselves
after a theme are the test:

| Fund | Named | Measured |
|---|---|---|
| IJC | İş Portföy **Yarı İletken** Teknolojileri | 60.8% semiconductors — top of the list |
| IEV | İş Portföy **Havacılık ve Savunma** Teknolojileri | 62.9% defence — top of the list |
| SSS | Yapı Kredi **Savunma Sanayii** Şirketleri Endeksi | 25.3% defence |
| YLY | Yapı Kredi **Kar Payı Ödeyen** Hisse Senedi | 6.65% yield — top of the list |
| PTO | Pardus **Temettü Ödeyen** Şirketler | 3.98% yield |

Every dividend-named fund whose filing can be read is in the top handful by
yield, and no fund is named for a theme it does not hold.

The share threshold matters and the control exposes it: **defence at 10% returns
34 funds**, most of them BIST 30 trackers — ASELS is around a tenth of that index,
so they hold it whether they meant to or not. At 50% it returns one, and that one
has "Havacılık ve Savunma" in its name.

### Coverage, which is the real limit

**438 funds get themes and 508 get a dividend figure**, out of 881 filings and
2,063 funds. The gap is not shyness about the data — it is that 1,182 funds have
no readable filing, and of the 881 that do, most are bond and money-market funds
with no shares to classify. 25 more are dropped by the same reconciliation gate
the live estimate uses: their weights parse into totals of millions of per cent,
and a theme weight taken off one of those is a percentage of nothing.

Both filters therefore answer over a subset, and the controls say so rather than
implying the rest hold nothing.

## Prediction

TEFAS publishes a fund's NAV one business day after the market it reflects — so
on any given day the benchmark closes are already known and the fund's price is
not. That gap is the prediction, and it needs no live data.

Each fund's daily returns are regressed (ridge) on BIST 100, gram gold, USD/TRY
and the cash index; the betas, R² and residual σ are stored at build time. The
browser applies them to the moves the fund has not yet priced in.

Estimates are **withheld below R² 0.5** and the explainability figure is always
shown. A BIST-30 index fund fits at R² 0.967 with beta 1.05; a hedge fund fits at
0.08 and gets no estimate rather than a confident-looking guess.

Two bugs here would have silently ruined the feature, and both are now
regression-tested: an *absolute* ridge penalty swamped daily-return-scale data
and collapsed every coefficient to zero, and naive date alignment gave a gold
fund a negative gold beta because TEFAS dates its NAV a day after the market.

## The main page

Masthead (nav + search, `/` to focus) → market tape → a short rail of funds
taking in money → toolbar → table. The first fund row sits at y≈382 rather than
y≈860, because the industry total, its composition bar and the whole filter block
are no longer in front of it.

**BIST 100, the dollar, the euro and gram gold are live**, polled every 60 seconds
from [Truncgil](https://finans.truncgil.com), which is the one host that both
serves these instruments and sends `Access-Control-Allow-Origin: *`. Yahoo and
TEFAS refuse cross-origin requests, which is why the *history* still comes from
the cron.

This is the only third party the page calls at runtime, and the rule is that the
page is no worse off when it fails: a timeout, an outage or a blocked request
falls back to the committed closes, and the stamp downgrades from "Canlı · 22:00"
to the close date. A figure is never labelled live unless it came from a response
in that session.

The money-market index on the tape is deliberately *not* live and cannot be — it
is derived from TEFAS fund NAVs, which are daily and a day behind. It rides the
tape anyway, marked *ölçüt*: it is not a market, it is the thing that beat four
fifths of the funds in the table.

Filters live behind a button, but their **state does not** — every active filter
is a named, removable chip in the toolbar with a count on the button, so a
narrowed list can never be mistaken for the full universe.

## The dashboard

`#/` is no longer the fund list. The list is where you go to **look for** a fund;
the dashboard is where you go to see what the ones you already care about are
doing. The list moved to `#/fonlar` with everything it had.

Three panes across the top, one question each, and three more below them:

| | |
|---|---|
| **Money in this week** | the seven-day net flow ranking, in either direction |
| **What you follow** | a month of each starred fund, one chart per fund |
| **Your funds** | the same funds as rows, over the money-market hurdle |
| **Portfolio overlap** | whether two funds you hold are the same fund |
| **Themes today** | what each line of business did, weighted by market value |
| **Movers today** | the best and worst of the BIST 100 |

The three below are the ones a fund page cannot answer, because each needs more
than one fund — or more than one company — at a time.

It carries **no page heading and no standing prose**. A title reading
"Dashboard" over a paragraph explaining what a dashboard is spends the top third
of the screen telling you what you can already see; what a column means lives in
its tooltip instead. For the same reason the page runs **full bleed** — a
three-pane layout and an eleven-column table both want the screen, not a 1440px
column with a hand's width of background either side of it.

### Two figures, side by side

Every row carries the same pair, and they are adjacent on purpose:

- **Last price** — the most recent change TEFAS published. It runs one business
  day behind the market it reflects, so today is not in it.
- **Live** — what the fund's actual holdings have done since, from share prices
  delayed 15 minutes. The same number the fund page shows, computed the same way,
  with the same gates: no figure when the filing could not be read, when under
  10% of the portfolio can be priced, or when the weights do not reconcile.

The second is an estimate of the move the first has not caught up with yet. That
is the whole reason the dashboard exists, and it is why a fund with no readable
filing shows "—" rather than a zero.

**One market scan covers the whole page.** Borsa İstanbul comes back whole in a
single request, so the cost of another row is one holdings file, not another
round trip to the exchange. Holdings and price history are both cached for the
session, so going to a fund and back costs nothing.

### The seven-day window

`fl7` and `iv7` are new alongside the thirty-day figures, because on a page you
open daily the monthly number barely moves. Same measure as the popular page:
**money in, not growth in size** — a fund that grew because its price rose took
nothing in. Same floor too, funds traded on TEFAS at risk 4 and above, without
which the ranking is money-market funds all the way down.

One subtlety the test pins down: the window runs back from **the fund's own last
print**, not from today. Every fund in the ranking prints daily and ends on the
same date, so they stay comparable — but the figure is not "the last seven days"
in the calendar sense, and nothing should assume it is.

### The charts

**One chart per fund, not one chart with every fund on it.** A shared axis asks
two things of you before it says anything: every line has to be rebased to 100,
since a ₺8,600 unit and a ₺1.05 one cannot share a scale, and then six colours
have to be held in your head to know which line is whose. Six small charts, each
over its own price under its own code, ask for neither.

Each tile carries the fund's code, its name, the change across the window, and
the window's two ends under the line. It is scaled to its own window rather than
to zero — a fund that moved 2% would otherwise draw a flat line — and takes its
colour from the direction it went, so the line and the wash under it are red or
green together.

The dates are not decoration. A fund younger than the window draws whatever
history it has, and without them **a six-week-old fund looks like a fund that
went nowhere for a year**. They switch from days to months as the window grows,
because "17 Ağu … 17 Ağu" over a year reads as a single day.

### Money in, and money out

One rail with a direction toggle rather than two panes. Arriving and leaving are
the same question asked twice, and a reader comparing them wants both in the
same place at the same size. Prices for both directions are fetched together, so
switching does not go back to the exchange.

The risk floor that already governs this rail is doing real work here: money-market
funds hold the bulk of the industry's cash and therefore dominate both ends of
any weekly flow ranking — ₺51.6bn left one of them in a week — which says
something about the treasury and nothing about the fund.

### Against the money market

The hurdle sits at the top of the funds you actually hold, because that is the
one place on the site where "did this beat doing nothing" is a question about
your own money.

The **median**, not the average. One fund up 600% would otherwise report a
portfolio comfortably ahead of cash when most of it was behind, so the count of
how many actually clear the hurdle sits under it. The gap is in **points**,
because it is the difference between two percentages.

It is equal-weighted and has to be: the site knows which funds you follow, not
how much of each you hold. That is why it says "median of your funds" rather
than "your return", which would be a number nobody could act on.

### Portfolio overlap

**The panel no fund page can ever draw**, because it needs every fund's filing at
once.

Two funds sharing most of their portfolio are one position wearing two names, and
someone holding both believes they have diversified. Across the equity funds that
file, the worst pair on the exchange is:

```
PHE + PBR   81% the same
in both:  ODINE 13.7%   GUNDG 9.5%   KTLEV 8.9%   PCS-PUSULA 8.6%  …
```

The measure is the **sum of the smaller weight wherever both hold the same
thing** — two funds each 40% in a share overlap 40 points there; one at 40% and
one at 5% overlap 5. That is the amount of the pair which is not a second
position at all, and it runs 0 to 100 the way a reader expects. Not correlation,
which two funds holding entirely different banks would score high on and which
says nothing about owning the same shares twice.

The median pair overlaps **nothing at all**, so on most watchlists this draws one
line saying the funds do not repeat each other — which is itself worth reading
once. It is checked only against your own funds: two strangers in the popular
rail overlapping is not your problem.

Positions with no code in the filing are left out rather than matched by name, so
every figure is a floor.

### Themes today, and the movers

Both come out of the scan the dashboard **already makes** — it asks the scanner
for the whole exchange to price the rails — so this row costs no network at all.
What the browser was missing was only which ticker belongs to what, and that now
travels in `meta.json`: 608 companies with their weight inside a theme, and the
100 index members. Together about 4.5KB gzipped, against the 900KB of
`stocks.json` it saves the home page from fetching.

A theme's move is **weighted by market value**, not averaged. An equal-weighted
"banks" figure lets the smallest listed bank move the number as far as the
largest. Weights are renormalised over the members that actually have a quote, so
a suspended share shrinks the theme rather than dragging it toward zero, and a
theme with less than half of itself priced reports nothing.

Worth knowing when reading it: some themes are one company. ASELS is 96% of
defence by market value, so "defence today" is very nearly "ASELS today" — which
is true of the sector itself, not an artefact of the measure.

The movers list is deliberately **confined to the BIST 100**. The biggest movers
on the whole exchange are always its smallest listings, hitting their price limit
on a few thousand lira of trade, and a home page that leads with those is
reporting noise as news.

The tiles are coloured by the same `moveColor()` the market map uses, but with a
lower ceiling on the mix. A map tile labels itself with a ticker; a theme tile
carries the theme's name, and at the map's full saturation the worst tile
measured **4.17:1** against the page's ink in the dark theme — under the 4.5:1
that text this size needs. At the lower ceiling both themes clear it at better
than 6.7:1 and the colour still runs a full gradient.

### Each tile, its own window

A share and a fund are not asking the same question, so they do not open on the
same window:

| | opens on | shows |
|---|---|---|
| **a share** | today | the session so far, and the live price |
| **a fund** | the month | daily NAVs, which is all a fund has |

A fund's price is published once a night; there is no such thing as a fund's
afternoon. Every tile carries its own picker between the two ends of its window,
and the choice is remembered per code.

**The intraday line comes from a feed with no history.** TradingView's scanner
will not give you a series, but it will tell you what a share has done over the
last 1, 5, 15, 30, 60, 120 and 240 minutes — and a price now with a change over
the last N minutes *is* the price N minutes ago. Chained, those seven numbers
plus the opening price are a real path through the session, from the same request
that prices fund holdings. Four hours is the feed's limit (300, 360, 480 and 720
all come back null), so on a long session the morning between the open and the
earliest step is the straight line it is.

Yahoo's chart endpoint would have given proper minute bars and is what the build
uses for daily history — but it sends no CORS headers, so the browser cannot ask
it. Everything intraday here comes from the one feed that answers a browser.

The previous close is left off the line even though the arithmetic needs it: a
line that starts at yesterday draws the overnight gap as though it were a trade
and flattens the session beside it. The figure above the chart is the day's
change, measured against that close, so nothing is lost.

The windows on offer are the fund chart's — 1 month, 3, 6, a year — plus a day
for shares, and minus its "all", since the history files are a year long and it
would be the 1Y option under a second name. Changing one is a redraw and not a
fetch; the daily histories are already in hand.

The grid is **sized against the pane, not the window** — a container query, since
this pane sits between two fixed rails and its width and the viewport's are not
the same question. At a 1250px viewport the screen is wide and this pane is
458px, which is two tiles with a readable name on them, not three.

With nothing starred the pane borrows the week's inflows and says so in its one
surviving line of prose. `renderChart` — the fund page's big chart — stays
series-agnostic and knows nothing about funds, which is what shares will need
later.

## Shares

Borsa İstanbul, 624 companies, read the other way through the same filings.

Any share page can tell you what ASELS costs. **What none of them can tell you is
that 197 Turkish funds hold it, that between them they own 0.61% of the company,
and that 91 of the 145 who filed a comparable position last month added to it.**
That takes every fund's KAP filing at once, which is the one thing this project
already has. So the ownership half comes from us, and the rest comes from the
same feeds the fund side already uses.

| | |
|---|---|
| **figures** | TradingView's scanner — the same feed `quotes.js` prices holdings from and `fetch-sectors.mjs` reads industries from. One request, ninety columns, the whole exchange |
| **history** | Yahoo Finance's chart endpoint, one request per share, a year of daily closes |
| **live price** | the 15-minute delayed scan, the same one a fund page prices its holdings with — so a share's move on its own page can never disagree with its move inside a fund |
| **statements** | the same scanner request — eight years of quarters and twenty of years, written per company to `data/stocks/<CODE>.fin.json`, 4KB apiece |
| **ownership** | `data/holdings/*.json` — 856 filings that reconcile, aggregated by ticker |

### Prices are adjusted, and the file says so

Turkish companies issue bonus shares constantly. A raw close series reads a 1:10
bonus issue as a **90% crash**, so what is stored is Yahoo's adjusted close:
the same number as the raw one on the last day, and the only one that survives a
split. `data/stocks.json` carries `priceBasis: "adjusted"` rather than leaving
the reader to assume. It makes the series a total-return one, which is also what
the fund NAVs on the other side of the chart are.

### Who owns it

The panel that leads a share page, because it is the one nobody else can draw:

- **how many funds** hold it, and **what they hold between them** in lira
- **how much of the company** that is — twice, from two independent sources.
  `pctShares` divides share counts from the filings by the count on the
  exchange's listing; `pctCap` divides lira by market value. On the large names
  they agree within a few tenths, which is the check that the filings' `nominal`
  really is a share count.
- **which way they moved it**: how many funds added and how many trimmed since
  the previous filing, out of the ones that filed a comparable position.
- the **twelve largest holders**, each with its weight and its move in points,
  linking back to the fund.

**The movement is a count and never a sum of lira.** Pricing each weight change
at the fund's current size is arithmetic anyone can do, and it produces nonsense:
one fund's previous ASELS weight of 22.69% against today's 0.14% valued the sale
at ₺63bn, more than the company is worth. A weight from a filing a month old
cannot be multiplied by a portfolio value from today. Counting how many funds
went each way is robust to exactly the errors that break the product.

Three data traps sit under that panel, and all three are handled where they
happen rather than papered over in the display:

1. **A filing said last month's ASELS weight was 2,070,000%.** A position cannot
   move further than the whole portfolio it sits in, so a move past 100 points is
   read as a filing error: the fund still counts as a holder, it just casts no
   vote on direction. Unguarded, that one row moved the exchange's estimated flow
   by ₺1.3 trillion.
2. **A blank previous weight is not a new position.** Three quarters of filings
   carry one; the rest leave the column empty. Reading empty as "opened this
   month" would have every share on the exchange being bought by everybody, so
   `compared` counts the ones that can actually be compared and the page says so.
3. **The same holding is filed under an ISIN on one line and a ticker on the
   next.** Weights and lira are summed across a split position; the previous
   weight is *taken*, not summed, because the field already holds the position's
   total — summing double-counted it.

### The statements

Eight years of quarters and twenty years of years, per company, for **no extra
request**. TradingView's scanner takes a `_h` suffix on its fundamental columns
and answers with the whole history as an array — so the same one call that
already prices the exchange now also returns revenue, gross profit, EBITDA, net
income, earnings per share, free cash flow, capital spending, total assets and
total debt, quarter by quarter, for 602 of the 624 companies.

The panel is one set of controls over one dataset: pick **quarterly, trailing
twelve months or annual**, pick a line, and the chart, the three figures under it
and the eight-column table beneath all move together. A chart panel and a table
panel with separate controls could disagree with each other, and would.

**Bars, not a line.** A price is continuous — it had a value at every moment
between two points, so joining them says something true. A quarter's revenue is
one number for a three-month block, and a slope drawn between two of them claims
the company earned its way smoothly from one to the other. The zero line sits
wherever zero falls rather than at the foot of the box, so a quarter of negative
free cash flow hangs below it and reads as one.

**Trailing twelve months is one click, and worth it.** Ford Otosan's fourth
quarter is always its biggest; the shape of the quarterly bars says more about
the calendar than about the company. Four consecutive quarters added together
removes the season. The first three periods have nothing behind them and are
**null, not partial sums**.

### The arrays have no dates on them

This is the part that had to be got right, because everything else on the panel
hangs off it. The scanner returns `total_revenue_fq_h` as thirty-two bare
numbers, newest first, with no periods attached. Its own `fiscal_period_current`
field is not usable: it disagrees with the last reported quarter for **36 of the
105** Borsa İstanbul companies that carry both.

So the anchor is `fiscal_period_end_fq` — the actual end date of the last filed
quarter — walked back three months at a time. Two things make that non-trivial:

- **Not every Turkish company closes its books in December.** Beşiktaş ends its
  year on 31 May, Mavi and Kayseri Şeker in April. Three months back from 31 May
  is 28 February, and a naive date subtraction lands on 3 March — dating every
  one of their quarters to the wrong period.
- **The arrays are not all the same length.** A company can have thirty-two
  quarters of revenue and twenty-four of EBITDA. Since index 0 is the latest for
  every one of them, they are padded at the *old* end and then reversed.

`revenues_fq_h` is the check. It is the one series that labels its own periods,
so the build cross-checks the derived dates against it every run and reports what
it found:

```
dating check over 1349 labelled quarters: 698 match on date, 66 one quarter back, 108 one forward
```

Not "do they agree" but "**which shift agrees best**". Turkish inflation
accounting restates prior periods constantly, so a mismatch at the right date is
normal and says nothing; a mismatch that would go away one quarter to the side is
the alarm. If that first number ever stops dominating the other two, the build
says so in capitals.

### The lira are nominal, and the page says so

Turkey has applied inflation accounting since 2023. A 2019 lira and a 2026 lira
are not the same lira, and every lira series on the page carries a note saying
exactly that. Nothing here deflates anything — a CPI deflator is a real piece of
work and pretending to one would be worse than the caveat.

It shows most plainly in the twenty-year dividend chart, where the last two bars
tower over the first fifteen. Ford Otosan has not raised its dividend
seventy-fold since 2012; the lira has fallen. The bars still answer the question
the panel is actually for — **has it kept paying** — and the unbroken-run figure
answers it in words.

### Forecast against reported

91 companies have broker revenue forecasts on file, quarter by quarter, going
back to 2021 — and the next unreported quarter's forecast sits at the top of the
table, which is the row a reader is looking for.

**Revenue only.** The scanner offers the same structure for earnings per share
and it does not survive checking: of 370 quarters where both it and the company's
own statements carry a figure, **148 disagree by more than 5%**. Ford Otosan's
March quarter comes back exactly ten times too large; İş Bankası's is out by a
factor of 280. Revenue agrees wherever both are present, so revenue is what gets
published and the earnings series is left alone.

A quarter the feed marks reported but files no revenue for is dropped rather than
shown with a dash: the panel is a comparison, and a forecast with nothing beside
it is not one.

### The rest of the page

| Panel | What it is for |
|---|---|
| **balance sheet** | assets, liabilities, equity, cash, short and long-term debt, net debt and book value per share. A company with more cash than borrowings is described as holding **net cash**, not as owing a negative amount — and it gets no net-debt-to-EBITDA row, because "minus 1.2 years to repay" is not a sentence |
| **what analysts expect** | the target as the middle of a range with the price marked in it, and a buy/hold/sell bar. The count leads: one broker's number and the middle of eleven are different objects, and only the spread says which you are looking at. 78 companies have coverage |
| **financial strength** | Altman Z and Piotroski F, each with its band named beside it. A score whose scale a reader has to look up elsewhere is not information |
| **companies in the same line** | the largest others in the same **industry** — not sector, because "Finance" holds both a bank and a property trust — with the industry median on its own row. A P/E of 14 is cheap for a bank and dear for a steel mill, and a multiple with no neighbours beside it is not a judgement |

Everything degrades by disappearing. A bank files no gross profit, no EBITDA and
no Altman Z, so those lines are not offered and that panel is not drawn. An
exchange-traded fund has no statements at all — and `stocks.json` carries a flag
saying so, so its page never opens by asking for a file that was never written.

### Two more things the scanner had been asked for all along

`indexes` gives index membership, so a page can say **BIST 30** — the narrowest
headline index a share is in, since every BIST 30 member is also in the 50 and
the 100. `submarket` gives the exchange's own market, which matters most when it
reads **Yakın İzleme Pazarı**: the exchange puts a company there when something
about it needs supervising, and that belongs above the P/E rather than nowhere.

One figure got dropped on the way in. The scanner reports a payout ratio of
**exactly zero for 179 companies that also report a positive dividend yield** —
Ford Otosan yields 12% and is filed as paying out none of its earnings. The yield
is the half that can be checked against a price, so the ratio is dropped rather
than printed as a fact.

### The pages

`#/hisseler` is the list: search, theme filter, "only ones funds hold", and every
column sortable — a share table is read by ranking it.

`#/hisse/CODE` is one company, in the order the questions get asked: what it
costs, what the price has done against BIST 100, **what the company earns**, then
who owns it and what the market charges for those earnings — valuation, the
business, the balance sheet, trading, analysts, financial strength — then the
dividend record, the forecasts, and the neighbours. The statements come before
the multiples on purpose: every ratio in the grid below them is a ratio to those
numbers. Neither page carries a heading; the nav already says which one you are
on.

### Two searches

The **masthead** field covers everything — 2,063 funds and 624 shares — and takes
you to a page. Type `ASELS`, press Enter, you are on it; arrow keys move through
the eight suggestions. Each **list** has its own field that narrows the table in
front of you.

They used to be one control, which meant the only way to search was to be on the
fund list and the only thing you could find was a fund.

Ranking alone was not enough. Best match first — exact code, then code prefix,
then name prefix, then name anywhere, biggest first inside each tier — meant
"garanti" returned eight Garanti Portföy funds and not the bank, because a fund
whose name *starts* with the word outranks a company whose name merely contains
it. **Each kind now keeps three of the eight places** when both have matches, and
the list is sorted by rank again afterwards, so the reservation decides who
appears and never in what order.

Both searches go through one matcher in `core.js`, and it **folds** rather than
upper-cases. This is not a style preference: `'ism'.toLocaleUpperCase('tr')` is
`"İSM"` — Turkish's dotted capital — which is not a substring of `ISMEN` and
never will be. The share list did exactly that, so typing a code in lower case
found nothing while typing it in capitals worked. Folding maps `ı İ ş ğ ü ö ç â`
down on both sides at once, so `şişe`, `sise` and `ŞİŞE` all reach SISE, and a
test pins it.

Every line in a **fund's holdings table that has a page here is now a link**, and
a filing lists three kinds of thing that do:

| The row is | It goes to |
|---|---|
| another fund — `PKT`, `ACU - İSTANBUL` | `#/fon/PKT`, checked against the fund universe already in memory |
| a share — `ASELS`, `Tem.Ver. SASA` | `#/hisse/ASELS` |
| an exchange-traded fund — `ZPLIB` | `#/hisse/ZPLIB` |

The last one is why `data/stocks.json` carries the exchange's 20 ETFs and 4
closed-end trusts alongside its 624 companies: they are what a fund holds, they
have a price and a chart, and without them "ZPLIB" led to a page saying the fund
did not exist. They are marked `kind` and kept out of the share **list**, which
has a P/E column an ETF can never fill.

**A row only links to a code the exchange actually lists.** The share index is
half a megabyte and a fund page has no other use for it, so `meta.json` — which
every visitor loads anyway — carries the bare list of 648 codes, about 5KB. Eight
tickers across the 882 filings are not on it (ZPX30 and APLIB among them: small
ETFs and delisted names the scanner has never carried), and those rows stay plain
text rather than promising a page that does not exist.

### Codes tell the two apart

Every TEFAS fund code is exactly three letters and every Borsa İstanbul ticker is
four or five, so **one favourites list holds both** and can never confuse them.
Star a share and it joins your funds on the dashboard chart; the code decides
which file its history comes from and which page it links to.

## Speculative boards

"Tahta" is Turkish market slang for a share whose price board a small group can
move at will. **Nothing in any dataset can prove that anyone did**, and this does
not try to. What it measures is not conduct but condition: how little of a
company actually trades, how much of it one holder has, how far the price has
run, and how little in the accounts anchors it anywhere.

Every one of the six is a figure the exchange itself publishes, and every
threshold sits at roughly the top decile of Borsa İstanbul — so a flag means
"unusual for this exchange", not "unusual anywhere".

| Condition | Threshold |
|---|---|
| **Sharp run-up** | +75% over a quarter, or +200% over a year |
| **Thin free float** | a quarter or less of the shares actually trade |
| **One fund holds a large stake** | a single fund holds ≥5% of the whole company |
| **No earnings behind the price** | the company loses money, or P/E ≥ 100 |
| **Far above book value** | P/B ≥ 10 |
| **Violent daily moves** | monthly volatility ≥ 8%, twice the exchange's median |

**The run-up is required.** A thin, loss-making, closely-held company whose price
has not moved is an illiquid company, not a board being worked — and saying
otherwise about a real business would be both wrong and unfair. Three conditions
including that one is the bar; **25 of 624 companies** clear it.

A test that cannot run is never counted as passed or failed, and exchange-traded
funds are excluded outright: a tracker has no float, no earnings and no book
value, so it would score two out of two and be called speculative for doing its
job.

The strongest example currently on file hits all six:

```
GUNDG   +2,080% over a year · 21.9% float · one fund holds 7.8% of it
        loses money · 87.6× book · 9.7% daily volatility
```

### The half that matters: which funds are in them

A share page can show the conditions. **Only this project can tell you that two
thirds of a fund you might buy is in shares like that**, because that needs every
fund's KAP filing at once.

```
PBR   66.9% of the portfolio — 84.9% of its equity — across 8 shares
PHE   65.7%
TLY   54.8%
```

77 funds hold at least one; 9 hold a quarter or more of themselves in them. Two
figures rather than one, because either alone misleads: 30% of a portfolio is a
very different sentence when the fund is 35% shares than when it is 95%.

**Equity only.** A fund holding a company's commercial paper or lending against
it in reverse repo is not holding the share. The first version of this counted
`code` matches and put three *money-market* funds at the top of the list, which
would have been a serious thing to publish and completely wrong — `isPriceable()`
already gated on the filing's own group, and the fix was to use it.

Index trackers appear here too, and the panel says why: a BIST Technology fund
holds what the index holds. It did not pick those names, but its investors are
exposed to those prices either way.

### Filtering on it, in both directions

The fund list carries one control with both questions in it, because they are
one question:

| | |
|---|---|
| **Holds none** | 352 funds — read, holding shares, and none of them flagged |
| **Over 5 / 10 / 25 / 50%** | 30 · 20 · 9 · 3 funds |

**"Holds none" needs a fund that was actually looked at.** A fund whose KAP
filing could not be read is not clean, it is unknown, and it drops out of both
directions rather than passing unchecked — the same rule the fee cap follows,
where an unknown fee is not a cheap one.

It also needs the fund to hold shares. Without a floor the answer was 397 funds,
most of them bond and money-market funds carrying a rounding error's worth of
equity: a fund that is 2% shares has not avoided these companies, it has avoided
the stock market. Five per cent of the portfolio is the floor.

A fund that clears it and holds none of them gets told so on its own page, the
same way the dashboard says when the funds you follow do not repeat each other.

### What this deliberately does not claim

The exchange keeps its own **Watchlist Market** for companies that need
supervising, and 17 companies are on it. **None of them is flagged here** — the
two lists are looking at different problems. The exchange watchlists distress:
companies that have already collapsed, or failed to file. This looks for a live
run-up. An earlier version without the run-up requirement did line up with the
watchlist — those companies scored a median of 32 against 19 for the market — and
that version was measuring susceptibility rather than the thing being asked for.

The concentration test sees **funds only**. A company controlled by one family
shows up here as a thin float and not as concentration, because KAP filings are
fund portfolios and there is no equivalent public feed for individual holders.

## The market

`#/piyasa` is the two things the tape can only hint at.

### The four lines

BIST 100, gram gold, the dollar, the euro — and the money-market index, because
it is the one line on the chart you can hold without taking any risk at all.
Indexed to 100 at the window's start, on the same chart component the fund pages
use, so the comparison is a year's worth of "which of these actually kept up".

Over the last year that reads: gold +59.8%, money market +48.8%, BIST 100
+31.1%, euro +18.3%, dollar +17.7%. A saver who did nothing but roll a
money-market fund beat the index by seventeen points.

### The map

The hundred largest companies, **area by market value, colour by today's move,
grouped by line of business** — a squarified treemap, two levels deep.

One level would say which companies moved. Two says which *industries* did, which
is the only thing a market map is really for: a red block where the banks are
tells you something a list of a hundred percentages never will.

The layout lives in `core.js` as `squarify()` and has tests, because a treemap
that silently overlaps or overflows its box is exactly the kind of bug an eye
skips over. The algorithm is Bruls, Huizing and van Wijk's — the naive
slice-and-dice layout gives twenty equal tiles in a 2:1 box an aspect ratio of
10:1 each, and a map made of slivers cannot be read or clicked.

Colour saturates at ±4% with a floor under it, so a share that moved 0.05% still
reads as green rather than as a hole. The scale is drawn under the map, because a
colour that means a number should say which number.

Tiles smaller than 46×26px lose their label — a clipped ticker is worse than
none — and everything is a link to the share behind it. The whole thing is
coloured from the same 15-minute-delayed scan that prices fund holdings, so it
never disagrees with a fund page about what a share did today.

## Pages

Eight routes, all client-side off the same data:

| Route | What it is |
|---|---|
| `#/` | **[the dashboard](#the-dashboard)** — what you follow, and what took money in this week |
| `#/fonlar` | the full universe, filtered and ranked |
| `#/hisseler` | **[Borsa İstanbul shares](#shares)** — sortable on any column, filterable by theme |
| `#/piyasa` | **[the market](#the-market)** — index, gold, dollar and euro on one chart, and BIST as a heat map |
| `#/populer` | biggest 30-day net inflow, most new investors, newest launches — **traded on TEFAS, risk 4 and above** |
| `#/dusus` | BIST's ten falls of the last three years, and which funds came through them — **[crash protection](#crash-protection)** |
| `#/favoriler` | your starred **funds and shares** — the fund list with a code restriction, so the filter bar and preferences apply inside it, and a panel of shares under it |
| `#/fon/CODE` | one fund: composition, **which lines of business it is in**, **what it actually holds**, quality, prediction, **its record through every fall**, price and benchmarks |
| `#/hisse/CODE` | one company: **which funds hold it and which way they moved**, valuation, the business, trading, price against BIST 100 |

"Popular" ranks on **net flow, not growth in size**: a fund whose size doubled
because its price doubled took in nothing. The page also says outright that it
measures attention rather than quality — the two are frequently opposites.

Favourites live in `localStorage` and hold **both kinds**: a three-letter code is
a fund, a four or five letter one is a listing, so one list can never confuse
them. The page shows whichever halves you have — starring only shares used to be
reported as having no favourites at all. Nothing leaves the browser, and a saved
code whose fund has since been delisted is counted out of the heading rather than
making it disagree with the table.

Charts carry a crosshair readout driven by pointer **or** arrow keys; a chart
whose only readout is hover cannot be read without a pointer at all.

### The fund chart

One panel covers the fund's price *and* its benchmarks, with a checkbox per
series and a range control. The rule that lets one chart do both jobs:

- **one series** draws in its own units — ₺ for a NAV or a gram gold price, index
  points for BIST — because that is the number people look up;
- **two or more** index to 100 at the window start, which is the only way a NAV,
  an index, a gram price and an FX rate share a linear axis.

Untick every benchmark and you have a plain price chart. Every series shares one
window, floored at the latest first-observation among the *ticked* ones, and
unticked series still show their change over that same window — otherwise gram
gold reports +153.7% over its own two years beside the fund's +45.0% over one, in
the same row.

### What a fund holds

Below the asset-class breakdown, the individual positions from the fund's KAP
filing — the actual shares, bonds and certificates — **grouped by asset class,
heaviest group first**, because "what is this fund really betting on" is the
question being asked. Each group heading carries its own share of the portfolio,
and that figure counts the whole group including any rows the fold is hiding: a
heading that agreed only with what is on screen would misstate the fund.

**One row per position, not per filed line.** Managers split a single holding
across several lines — a long and a short leg, lots bought on different dates, a
slice lent out — and TLY files ALKLC, ANELE, MANAS, SELEC and TEHOL twice each.
A table that repeats them is answering a bookkeeping question rather than "what
does this fund own", so lines are summed by ISIN into 41 positions from 291 rows.

**The groups are ours, not the filings'.** Filers use around sixty different group
labels for the same dozen kinds of thing: `BORÇLANMA SENETLERİ`, `FİNANSMAN
BONOLARI`, `DEVLET TAHVİLİ VE` and `DÖVİZE ENDEKSLİ TAHVİLLER` are all debt. Nine
buckets cover 99.7% of holdings weight, and anything unrecognised lands in
"Other" rather than in a bucket that merely looks plausible — the heading is
visible, so a misfiling would be read as fact.

Two of the labels needed the data checked rather than assumed. `Kısa` and `Uzun`
("short" and "long") turn out to be single-stock futures legs, filed with a weight
of zero because a future's weight is stated against the portfolio's value rather
than the contract's size. `VADELİ` reads as "forward" but every row filed under it
is a time deposit, so it is cash.

Two filter rails sit above the table: one per asset class, one for which way a
position moved today — and, where last month's filing could be read, which
positions are new. Both carry counts, and the counts are of the whole fund rather
than of the current filter, so a chip can be used to navigate rather than only to
narrow.

A fund that holds other funds is a different animal from one that picks
securities, so a held fund is marked as such on its own row and links straight
through to it. Where a filing's own percentages do not reach 100%, the page says
so rather than quietly presenting a short list as complete.

Funds whose report could not be read simply have no panel; the section is absent
rather than empty.

### What changed since last month

Where the previous month's filing could also be read, each position shows what it
weighed then and the change, and positions the fund did not hold last month are
marked new. It is the one thing a list of holdings cannot tell you on its own:
whether a manager has been buying or selling.

The change is stated in **percentage points**, and the column says so in its
heading. A position going from 14.17% to 32.59% of a portfolio did not move "by
18.42%" — that is the project's existing rule for the gap between two
percentages, and the commercial sites all print it with a percent sign.

Only the earlier month's **weights** are kept, one number per position. Holding
two months of positions for 1,300 funds to show two extra columns would double the
data directory for a comparison.

A fund whose earlier filing could not be read shows no comparison at all rather
than treating every position as new — those two columns simply do not appear for
it. The month-over-month coverage is therefore a subset of the holdings coverage,
and the two are independent: a readable July with an unreadable June is common.

### What it is doing right now

Every position that trades on Borsa İstanbul or a US exchange carries its last
price and the day's move, and above the table the fund's own estimated move is
built from them.

The figure is stated **at the level of the fund, not the position**. A fund with a
fifth of its money in shares that rose 3% had a 0.6% day; printing 3% beside its
name would be a different claim altogether. The share of the portfolio behind the
number sits next to it, so a thin estimate reads as thin, and below 10% no figure
is given at all — a money-market fund with 2% in shares would produce a real
number that a reader would take for the fund's own.

Three things are said plainly rather than buried, because each of them changes
what the number means:

- **The prices are 15 minutes delayed.** Borsa İstanbul's real-time feed is
  licensed. The delay is not hard-coded — the source states it per row
  (`update_mode: "delayed_streaming_900"`) and the page prints what it finds.
- **When the exchange is shut, the same figure is the last session's move**, and
  it says so. The feed keeps stamping rows for hours after the close, so a page
  that trusted that stamp would announce a "market time" of 22:10 and call a
  closed session's move today's.
- **It is not the price the fund is about to publish.** The holdings are a month
  old, the unpriced remainder is assumed flat, and TEFAS dates a NAV a business
  day behind the market it reflects. The next-published-price question has its
  own panel, answered by the factor model.
- **A foreign holding moves twice.** A lira fund holding NVDA earns the share's
  move *and* the dollar's, so the two are compounded rather than added and the
  page says so. Each market is also read in its own session: New York opens at
  16:30 Istanbul, so through a Turkish morning the panel is showing one live
  session and one closed one, and it names which is which.

**A ticker-shaped code is not enough to price a row.** Two funds proved it. A
money-market fund names its repo counterparty in the code column — DSTKF is a
listed company, but that row is a repo, and it was contributing 446 "priced
positions" to one fund. A gold fund codes its bars `ALTIN LBMA 995`, and ALTIN is
also a listed company, so that fund reported 88% of its portfolio priced at ₺73 a
gram. The group has to agree the row is a shareholding, and the allow-list is
deliberate: a group nobody has catalogued yet goes unpriced rather than being
priced on a guess.

Coverage above 100% is left alone rather than clamped. Twelve funds borrow to hold
more shares than they have net assets, and a fund with 175% of itself in shares
really does move 1.75 times what the market does — the page names the leverage
instead of hiding it.

Of the 874 funds with a filing, 501 hold at least one position on a market this
prices and 439 clear the coverage floor — 7.5% of the industry's money. 137 funds
hold at least one US name, and the second scan is what takes 40 of them past the
floor; 32 of them hold nothing Turkish at all and would otherwise show no price
anywhere. 768 distinct US tickers are needed and 709 still resolve, the rest
having been delisted or renamed since the filing.

Only 7.5% of the industry's money is the honest shape of this market rather than a
gap in the feature: most Turkish fund money sits in money-market and debt funds
that own nothing an exchange quotes.

The other ten exchanges in the filings — London, Frankfurt, Paris, Zurich, Tokyo,
Hong Kong, Copenhagen, Stockholm, Oslo, Toronto, Warsaw — are 0.5% of all holdings
weight between them, against 7.3% for the US. They stay unpriced and are counted
as unpriced, rather than each getting a scanner, a session and a currency leg.

### Where the share prices come from

`POST https://scanner.tradingview.com/turkey/scan` returns all 646 symbols the
exchange lists — 621 shares, 21 exchange-traded funds, 4 closed-end funds — for
16KB gzipped. One request serves every fund on the site, so switching funds costs
nothing and the whole page makes one call a minute while a holdings table is open.

The US comes from `…/america/scan`, which is thousands of symbols, so that one is
asked only for the tickers the open fund holds: a `name in_range` filter, because
the filings never say which exchange a name is on and `NASDAQ:NVDA` would have to
be guessed. The largest fund needs 114 names and gets 113 back in under 2KB — one
request, no paging.

Reading the listing out of the row is the fiddly part. Filers write foreign
holdings Bloomberg-style — `MSFT US`, `NVDA US EQUITY`, `700 HK`, `BA/ LN` — and
that two-letter code is the only thing saying where the name trades; `AIR US` is
AAR Corp on the NYSE while `AIR FP` is Airbus in Paris. When the code column holds
an ISIN instead, the same pattern is read out of the name.

The detail that makes it work from a browser at all: the request sends
`Content-Type: text/plain`, which keeps it a CORS *simple* request. The endpoint's
preflight reply allows only `Referer` and `Accept`, so `application/json` would
fail preflight and return nothing.

If it goes away, the table loses two columns and the estimate, and everything
else on the page is unaffected — the same rule `live.js` follows.

### Table layout

`table-layout: fixed`. An auto table inside an `overflow-x: auto` wrapper is given
unlimited width and sizes itself to max-content, so the list was a rigid 1639px at
every viewport and scrolled sideways even on a 1600px screen. Optional columns
drop at 1200px; below 820px each row becomes a card, because eight columns on a
phone leave the fund name at 38px.

## Roadmap

Fund-vs-fund comparison, "tahta" detection (now unblocked — it was waiting on the
KAP holdings, which landed), and inflation-adjusted statements on the share pages
— every lira series is nominal today and says so, which for Turkey is a real gap
rather than a footnote.

---

## Data & disclaimer

Fund data from [TEFAS](https://www.tefas.gov.tr) (Takasbank). Benchmark history
from Yahoo Finance. Tape quotes from [Truncgil](https://finans.truncgil.com);
share prices from [TradingView](https://www.tradingview.com/markets/stocks-turkey/),
delayed 15 minutes as Borsa İstanbul's real-time feed is licensed. This is an
independent project with no affiliation to any of them.

**Not investment advice.** Past performance does not guarantee future results.

### Licence

The source is [MIT](LICENSE).

That covers the code, not the contents of `data/`, which is fetched from the
sources above and republished unchanged. Each remains subject to its own
source's terms — and none of them is affiliated with this project.
