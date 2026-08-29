// Which website belongs to which fund manager.
//
// TEFAS names a fund's manager and nothing else: no website, no ticker, no
// identifier a logo could be looked up by. TradingView, which supplies every
// other logo on the site, does not carry TEFAS funds at all — its Turkey scan
// is 623 listed companies and 24 exchange-traded funds, and not one open-end
// fund among them. So this table is the missing join, and it is a table rather
// than a rule because the obvious rules are wrong:
//
//   "AK PORTFÖY"        the first listing whose name starts AK is an Ak Portföy
//                       ETF, not Akbank
//   "ATA PORTFÖY"       matches ATATR, Ata Turizm — a different company that
//                       merely shares a word
//   "İSTANBUL PORTFÖY"  matches GMSTR, a silver ETF
//
// Every entry below was resolved by fetching the site and confirming the page
// says the manager's name back — see the title in the comment where the host is
// not self-evident. Three managers have no site this could find (Astra, Aura,
// Logos); they are absent on purpose and fall back to the monogram, which is
// also what a manager admitted after this was written will do until it is added
// here.
//
// Keyed by BRAND, not by the founder string TEFAS prints: one manager reaches
// the fund list under several names — "AZİMUT PORTFÖY", "AZİMUT PYŞ BİRİNCİ",
// "AZİMUT PYŞ KAR" and three more are one company with one logo.

/** Turkish letters to their ASCII counterparts, for keys and comparisons. */
export const deTr = (s) => String(s ?? '')
  .replace(/İ/g, 'I').replace(/ı/g, 'i')
  .replace(/Ş/g, 'S').replace(/ş/g, 's')
  .replace(/Ğ/g, 'G').replace(/ğ/g, 'g')
  .replace(/Ü/g, 'U').replace(/ü/g, 'u')
  .replace(/Ö/g, 'O').replace(/ö/g, 'o')
  .replace(/Ç/g, 'C').replace(/ç/g, 'c');

/**
 * The company behind a founder string.
 *
 * "AZİMUT PYŞ STRATEJİ-1" and "AZİMUT PORTFÖY" are the same firm wearing two
 * of its umbrella names, so everything from the legal form rightwards is cut
 * and what remains is the brand.
 */
export const brandOf = (founder) => deTr(founder).toUpperCase()
  .replace(/\s+(PORTFOY|PYS)\b.*$/, '')
  .replace(/[^A-Z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Brand -> the site its logo is taken from.
 *
 * A few point at the parent rather than at the asset manager, because the
 * manager has no separate site and the group's mark is the one the fund is sold
 * under anyway: A1 Capital, Emlak Katılım, Meksa and Phillip are the four.
 */
export const MANAGER_SITES = {
  'A1 CAPITAL': 'https://a1capital.com.tr',
  AHLATCI: 'https://ahlatciportfoy.com.tr',
  AK: 'https://www.akportfoy.com.tr',
  AKTIF: 'https://www.aktifportfoy.com.tr',
  ALBARAKA: 'https://www.albarakaportfoy.com.tr',
  ALLBATROSS: 'https://allbatrossportfoy.com',
  ATA: 'https://ataportfoy.com.tr',
  ATLAS: 'https://atlasportfoy.com',
  AZIMUT: 'https://azimutportfoy.com',
  BULLS: 'https://bullsportfoy.com',
  BV: 'https://www.bvportfoy.com',
  DENIZ: 'https://www.denizportfoy.com',
  DESTEK: 'https://destekportfoy.com',
  // Trades as Emaa Blue, files under emaaportfoy.com.tr.
  'EMAA BLUE': 'https://www.emaaportfoy.com.tr',
  'EMLAK KATILIM': 'https://www.emlakkatilim.com.tr',
  FIBA: 'https://fibaportfoy.com.tr',
  FONMAP: 'https://www.fonmap.com',
  GARANTI: 'https://www.garantibbvaportfoy.com.tr',
  'GLOBAL MD': 'https://www.globalmdportfoy.com.tr',
  'GOLDEN GLOBAL': 'https://goldenglobalportfoy.com.tr',
  HAS: 'https://hasportfoy.com.tr',
  HEDEF: 'https://hedefportfoy.com.tr',
  HSBC: 'https://www.hsbcportfoy.com.tr',
  INCIR: 'https://incirportfoy.com.tr',
  INVEO: 'https://inveoportfoy.com.tr',
  IS: 'https://www.isportfoy.com.tr',
  ISTANBUL: 'https://www.istanbulportfoy.com',
  KARE: 'https://www.kareportfoy.com.tr',
  'KUVEYT TURK': 'https://www.kuveytturkportfoy.com.tr',
  'MARMARA CAPITAL': 'https://www.marmaracapital.com.tr',
  MEKSA: 'https://www.meksa.com.tr',
  MT: 'https://www.mtportfoy.com',
  NEO: 'https://www.neoportfoy.com.tr',
  NUROL: 'https://www.nurolportfoy.com.tr',
  ONE: 'https://oneportfoy.com.tr',
  OSMANLI: 'https://osmanliportfoy.com.tr',
  OYAK: 'https://oyakportfoy.com.tr',
  PARDUS: 'https://pardusportfoy.com',
  PERFORM: 'https://www.performportfoy.com',
  PHILLIP: 'https://phillipcapital.com.tr',
  PIRAMIT: 'https://piramitportfoy.com',
  PUSULA: 'https://www.pusulaportfoy.com.tr',
  QNB: 'https://www.qnbportfoy.com.tr',
  // TEFAS prints "RE-PIE"; the hyphen is dropped by brandOf().
  'RE PIE': 'https://www.repieportfoy.com',
  ROTA: 'https://rotaportfoy.com.tr',
  SPARTA: 'https://spartaportfoy.com.tr',
  STATECH: 'https://statechportfoy.com.tr',
  STRATEJI: 'https://www.stratejiportfoy.com.tr',
  TACIRLER: 'https://tacirlerportfoy.com.tr',
  TEB: 'https://www.tebportfoy.com.tr',
  TERA: 'https://www.teraportfoy.com',
  TRIVE: 'https://www.triveportfoy.com.tr',
  UNLU: 'https://www.unluportfoy.com',
  V: 'https://www.vportfoy.com.tr',
  'VAKIF KATILIM': 'https://vakifkatilimportfoy.com.tr',
  VEGA: 'https://www.vegaportfoy.com',
  'YAPI KREDI': 'https://www.yapikrediportfoy.com.tr',
  ZIRAAT: 'https://ziraatportfoy.com',
};

/**
 * Brand -> the listed company whose mark the manager wears.
 *
 * Where a manager's group is on the exchange, the share's logo is the one to
 * use and the manager's own favicon is not. They are drawn from the same brand
 * book but they are not the same file — İş Portföy's site icon and İş
 * Yatırım's exchange logo differ in crop and in weight — and a page that shows
 * a fund one way and its manager's listed parent another, a row apart, looks
 * like two companies.
 *
 * Every entry was checked against the `logoid` TradingView actually serves for
 * that ticker, not against the company name, because the two disagree more
 * often than you would expect. Two that were rejected on exactly that basis:
 *
 *   INVEO     Inveo Yatırım Holding is served with `gedik-yatirim`, its
 *             subsidiary's mark, which is not what Inveo Portföy wears
 *   GMSTR     an İstanbul Portföy silver ETF, served with `qnb-finansbank`
 *
 * And four rejected because the name is shared but the company is not: Ata
 * Turizm is not Ata Portföy's group, Marmara Holding is not Marmara Capital,
 * Vakıfbank is not Vakıf Katılım, and Emlak Konut is not Emlak Katılım. All six
 * keep the icon from their own website.
 */
export const MANAGER_TICKERS = {
  'A1 CAPITAL': 'A1CAP',
  AHLATCI: 'AHGAZ',
  AK: 'AKBNK',
  ALBARAKA: 'ALBRK',
  ATLAS: 'ATLAS',
  BULLS: 'BULGS',
  DENIZ: 'DZGYO',
  DESTEK: 'DSTKF',
  GARANTI: 'GARAN',
  'GLOBAL MD': 'GLBMD',
  HEDEF: 'HEDEF',
  IS: 'ISMEN',
  NUROL: 'NUGYO',
  OSMANLI: 'OSMEN',
  OYAK: 'OYYAT',
  PARDUS: 'PRDGS',
  QNB: 'QNBTR',
  TERA: 'TERA',
  UNLU: 'UNLU',
  'YAPI KREDI': 'YKBNK',
  ZIRAAT: 'ZRGYO',
};

/** The site for a founder string as TEFAS prints it, or null. */
export const siteOf = (founder) => MANAGER_SITES[brandOf(founder)] ?? null;

/** The listed company a founder string borrows its mark from, or null. */
export const tickerOf = (founder) => MANAGER_TICKERS[brandOf(founder)] ?? null;
