// TEFAS portfolio-allocation taxonomy.
//
// The allocation endpoint (dagilimSiraliGetirT) returns ~55 short-coded percentage
// fields. TEFAS reports *leaf* values only: when a breakdown is available the
// aggregate is null, and vice versa, so the non-null fields of a row sum to ~100.
// That means every field below can be summed without double counting.
//
// This file is the single source of truth. The fetch pipeline emits it into
// public/data/meta.json, and the UI reads it from there — nothing imports across
// the script/app boundary.

/**
 * Asset-class groups, in stack order.
 *
 * Eight is a hard cap, not a coincidence: these are the categorical colour slots
 * a composition bar can carry while staying distinguishable under colour-vision
 * deficiency. `light`/`dark` are the validated slot colours (adjacent-pair CVD
 * ΔE 9.1 light / 8.4 dark against this site's surfaces) — the ORDER below is
 * what makes that hold, so do not reshuffle it without re-running the validator.
 *
 * The 55 raw TEFAS fields still show individually in the fund detail table; these
 * groups only govern colour and the coarse exposure filters.
 */
export const GROUPS = [
  { id: 'equity', tr: 'Hisse Senedi', en: 'Equity', light: '#2a78d6', dark: '#3987e5' },
  { id: 'govDebt', tr: 'Kamu Borçlanma', en: 'Government Debt', light: '#eb6834', dark: '#d95926' },
  { id: 'corpDebt', tr: 'Özel Sektör Borçlanma', en: 'Corporate Debt', light: '#1baf7a', dark: '#199e70' },
  { id: 'lease', tr: 'Kira Sertifikaları', en: 'Lease Certificates', light: '#eda100', dark: '#c98500' },
  { id: 'cash', tr: 'Nakit ve Para Piyasası', en: 'Cash & Money Market', light: '#e87ba4', dark: '#d55181' },
  { id: 'metals', tr: 'Kıymetli Madenler', en: 'Precious Metals', light: '#008300', dark: '#008300' },
  { id: 'foreign', tr: 'Yabancı Menkul Kıymetler', en: 'Foreign Securities', light: '#4a3aa7', dark: '#9085e9' },
  { id: 'other', tr: 'Fon Payları ve Diğer', en: 'Fund Units & Other', light: '#e34948', dark: '#e66767' },
];

/** TEFAS field code -> { group, tr, en }. Keys are the raw API field names. */
export const ASSETS = {
  // --- Equity ---
  hs: { group: 'equity', tr: 'Hisse Senedi', en: 'Equity' },
  yhs: { group: 'equity', tr: 'Yabancı Hisse Senedi', en: 'Foreign Equity' },

  // --- Government debt ---
  dt: { group: 'govDebt', tr: 'Devlet Tahvili', en: 'Government Bond' },
  hb: { group: 'govDebt', tr: 'Hazine Bonosu', en: 'Treasury Bill' },
  kba: { group: 'govDebt', tr: 'Kamu İç Borçlanma Aracı (Döviz)', en: 'Gov. Domestic Debt (FX)' },
  kibd: { group: 'govDebt', tr: 'Kamu Dış Borçlanma Aracı', en: 'Gov. Foreign Debt' },
  eut: { group: 'govDebt', tr: 'Eurobond', en: 'Eurobond' },
  dot: { group: 'govDebt', tr: 'Dövize Ödemeli Bono', en: 'FX-Payable Bill' },
  db: { group: 'govDebt', tr: 'Dövize Ödemeli Tahvil', en: 'FX-Payable Bond' },

  // --- Corporate debt ---
  ost: { group: 'corpDebt', tr: 'Özel Sektör Tahvili', en: 'Corporate Bond' },
  fb: { group: 'corpDebt', tr: 'Finansman Bonosu', en: 'Financing Bill' },
  bb: { group: 'corpDebt', tr: 'Banka Bonosu', en: 'Bank Bill' },
  vdm: { group: 'corpDebt', tr: 'Varlığa Dayalı Menkul Kıymet', en: 'Asset-Backed Security' },
  osdb: { group: 'corpDebt', tr: 'Özel Sektör Dış Borçlanma Aracı', en: 'Corporate Foreign Debt' },

  // --- Lease certificates (sukuk) ---
  kks: { group: 'lease', tr: 'Kamu Kira Sertifikası', en: 'Gov. Lease Certificate' },
  kkstl: { group: 'lease', tr: 'Kamu Kira Sertifikası (TL)', en: 'Gov. Lease Certificate (TRY)' },
  kksd: { group: 'lease', tr: 'Kamu Kira Sertifikası (Döviz)', en: 'Gov. Lease Certificate (FX)' },
  kksyd: { group: 'lease', tr: 'Kamu Yabancı Kira Sertifikası', en: 'Gov. Foreign Lease Certificate' },
  osks: { group: 'lease', tr: 'Özel Sektör Kira Sertifikası', en: 'Corporate Lease Certificate' },
  oksyd: { group: 'lease', tr: 'Özel Sektör Yabancı Kira Sertifikası', en: 'Corporate Foreign Lease Cert.' },

  // --- Money market ---
  tpp: { group: 'cash', tr: 'Takasbank Para Piyasası', en: 'Takasbank Money Market' },
  bpp: { group: 'cash', tr: 'BİST Para Piyasası', en: 'BIST Money Market' },
  btaa: { group: 'cash', tr: 'BİST Taahhütlü Alım', en: 'BIST Committed Purchase' },
  btas: { group: 'cash', tr: 'BİST Taahhütlü Satım', en: 'BIST Committed Sale' },
  r: { group: 'cash', tr: 'Repo', en: 'Repo' },
  tr: { group: 'cash', tr: 'Ters Repo', en: 'Reverse Repo' },

  // --- Deposits & participation accounts ---
  vm: { group: 'cash', tr: 'Vadeli Mevduat', en: 'Term Deposit' },
  vmtl: { group: 'cash', tr: 'Vadeli Mevduat (TL)', en: 'Term Deposit (TRY)' },
  vmd: { group: 'cash', tr: 'Vadeli Mevduat (Döviz)', en: 'Term Deposit (FX)' },
  vmau: { group: 'cash', tr: 'Vadeli Mevduat (Altın)', en: 'Term Deposit (Gold)' },
  kh: { group: 'cash', tr: 'Katılma Hesabı', en: 'Participation Account' },
  khtl: { group: 'cash', tr: 'Katılma Hesabı (TL)', en: 'Participation Account (TRY)' },
  khd: { group: 'cash', tr: 'Katılma Hesabı (Döviz)', en: 'Participation Account (FX)' },
  khau: { group: 'cash', tr: 'Katılma Hesabı (Altın)', en: 'Participation Account (Gold)' },

  // --- Precious metals ---
  km: { group: 'metals', tr: 'Kıymetli Madenler', en: 'Precious Metals' },
  kmbyf: { group: 'metals', tr: 'Kıymetli Maden BYF', en: 'Precious Metals ETF' },
  kmkba: { group: 'metals', tr: 'Kıymetli Maden Kamu Borçlanma', en: 'Precious Metals Gov. Debt' },
  kmkks: { group: 'metals', tr: 'Kıymetli Maden Kira Sertifikası', en: 'Precious Metals Lease Cert.' },

  // --- Foreign securities ---
  ymk: { group: 'foreign', tr: 'Yabancı Menkul Kıymet', en: 'Foreign Security' },
  yba: { group: 'foreign', tr: 'Yabancı Borçlanma Aracı', en: 'Foreign Debt Instrument' },
  ybkb: { group: 'foreign', tr: 'Yabancı Kamu Borçlanma Aracı', en: 'Foreign Gov. Debt' },
  ybosb: { group: 'foreign', tr: 'Yabancı Özel Sektör Borçlanma Aracı', en: 'Foreign Corporate Debt' },
  ybyf: { group: 'foreign', tr: 'Yabancı Borsa Yatırım Fonu', en: 'Foreign ETF' },

  // --- Fund units ---
  fkb: { group: 'other', tr: 'Fon Katılma Payı', en: 'Fund Participation Certificate' },
  yyf: { group: 'other', tr: 'Yatırım Fonu', en: 'Investment Fund' },
  byf: { group: 'other', tr: 'Borsa Yatırım Fonu', en: 'Exchange-Traded Fund' },
  gykb: { group: 'other', tr: 'Gayrimenkul Yatırım Fonu', en: 'Real Estate Fund' },
  gyy: { group: 'other', tr: 'Gayrimenkul Yatırımı', en: 'Real Estate Investment' },
  gsykb: { group: 'other', tr: 'Girişim Sermayesi Yatırım Fonu', en: 'Venture Capital Fund' },
  gsyy: { group: 'other', tr: 'Girişim Sermayesi Yatırımı', en: 'Venture Capital Investment' },

  // --- Derivatives & other ---
  t: { group: 'other', tr: 'Türev Araçlar', en: 'Derivatives' },
  vint: { group: 'other', tr: 'Vadeli İşlem Nakit Teminatı', en: 'Futures Cash Collateral' },
  gas: { group: 'other', tr: 'Gayrimenkul Sertifikası', en: 'Real Estate Certificate' },
  d: { group: 'other', tr: 'Diğer', en: 'Other' },
};

/** Raw allocation field codes, in taxonomy order. */
export const ASSET_CODES = Object.keys(ASSETS);

/**
 * Fund types the site covers (TEFAS `fonTipi`).
 *
 * Everything here is something a saver can go and buy today. That rules out:
 *
 * - GYF (real estate) and GSYF (venture capital) — closed-end vehicles retail
 *   investors cannot buy on the platform;
 * - EMK (pension) — you cannot buy one directly either. A pension fund is reached
 *   only through a BES contract with its own provider, its own entry rules and
 *   its own tax treatment on exit, so it does not belong in a list whose question
 *   is "which of these is worth buying". They also trade on BEFAS rather than
 *   TEFAS, which meant a second set of platform wording for funds nobody here can
 *   act on.
 */
export const KINDS = [
  { id: 'YAT', tr: 'Yatırım Fonu', en: 'Mutual Fund' },
  { id: 'BYF', tr: 'Borsa Yatırım Fonu', en: 'Exchange-Traded Fund' },
];

/**
 * English names for the umbrella-fund categories TEFAS returns via fonTurGetir.
 * Keyed by the Turkish description so unknown/new categories degrade gracefully
 * (we fall back to the Turkish string rather than dropping the fund).
 */
export const CATEGORY_EN = {
  'Borçlanma Araçları Şemsiye Fonu': 'Debt Instruments',
  'Değişken Şemsiye Fonu': 'Variable',
  'Fon Sepeti Şemsiye Fonu': 'Fund Basket',
  'Garantili Şemsiye Fonu': 'Guaranteed',
  'Gayrimenkul Şemsiye Fonu': 'Real Estate',
  'Girişim Sermayesi Şemsiye Fonu': 'Venture Capital',
  'Hisse Senedi Şemsiye Fonu': 'Equity',
  'Karma Şemsiye Fonu': 'Mixed',
  'Katılım Şemsiye Fonu': 'Participation (Islamic)',
  'Kıymetli Madenler Şemsiye Fonu': 'Precious Metals',
  'Para Piyasası Şemsiye Fonu': 'Money Market',
  'Serbest Şemsiye Fonu': 'Hedge / Free',
  'Koruma Amaçlı Şemsiye Fonu': 'Capital Protected',
  'Endeks Şemsiye Fonu': 'Index',
  'Katkı Şemsiye Fonu': 'Contribution',
  'Standart Şemsiye Fonu': 'Standard',
  'Altın Şemsiye Fonu': 'Gold',
};

/**
 * Themes, as a partition of the industries a listing can be filed under.
 *
 * The industry comes from TradingView's classification, which is the same feed
 * quotes.js already prices these shares from — one request per market gives the
 * sector, the industry and the trailing dividend yield for every listing. The
 * grouping below is ours: 102 industries appear in Turkish funds' holdings, and
 * a filter with 102 entries is not a filter.
 *
 * Every industry belongs to exactly ONE theme. Overlapping themes would let a
 * fund's exposures add up past its own equity sleeve, and "40% banks, 55%
 * finance" invites the reader to add them. `banks` and `finance` are separate
 * rather than nested because Turkish funds are sold by that distinction — there
 * are bank-sector funds, and the exchange runs bank indices.
 *
 * Order is display order, roughly by how much of the industry's money sits in
 * each. THEME_IDS in core.js must stay in step: that list is what the UI offers
 * and what carries the labels.
 */
export const THEME_INDUSTRIES = {
  banks: ['Major Banks', 'Regional Banks', 'Savings Banks'],
  finance: ['Investment Banks/Brokers', 'Investment Managers', 'Finance/Rental/Leasing',
    'Financial Conglomerates', 'Multi-Line Insurance', 'Life/Health Insurance',
    'Insurance Brokers/Services', 'Specialty Insurance', 'Property/Casualty Insurance',
    'Financial Publishing/Services'],
  realEstate: ['Real Estate Investment Trusts', 'Real Estate Development', 'Homebuilding'],
  defence: ['Aerospace & Defense'],
  semis: ['Semiconductors', 'Electronic Production Equipment'],
  tech: ['Packaged Software', 'Information Technology Services', 'Internet Software/Services',
    'Data Processing Services', 'Computer Processing Hardware', 'Computer Peripherals',
    'Computer Communications', 'Electronic Components', 'Electronic Equipment/Instruments',
    'Telecommunications Equipment', 'Internet Retail'],
  telecom: ['Wireless Telecommunications', 'Major Telecommunications',
    'Specialty Telecommunications', 'Cable/Satellite TV', 'Broadcasting',
    'Media Conglomerates', 'Publishing: Newspapers', 'Publishing: Books/Magazines',
    'Advertising/Marketing Services'],
  energy: ['Oil Refining/Marketing', 'Integrated Oil', 'Oil & Gas Production',
    'Oilfield Services/Equipment', 'Oil & Gas Pipelines', 'Contract Drilling',
    'Electric Utilities', 'Gas Distributors', 'Alternative Power Generation',
    'Water Utilities', 'Coal'],
  metals: ['Steel', 'Precious Metals', 'Other Metals/Minerals', 'Aluminum',
    'Metal Fabrication', 'Forest Products', 'Pulp & Paper'],
  industrial: ['Industrial Machinery', 'Trucks/Construction/Farm Machinery',
    'Electrical Products', 'Building Products', 'Miscellaneous Manufacturing',
    'Industrial Conglomerates', 'Office Equipment/Supplies', 'Containers/Packaging',
    'Industrial Specialties', 'Electronics Distributors', 'Wholesale Distributors',
    'Miscellaneous Commercial Services', 'Commercial Printing/Forms',
    'Personnel Services', 'Environmental Services', 'Financial/Business Services'],
  construction: ['Engineering & Construction', 'Construction Materials'],
  autos: ['Motor Vehicles', 'Auto Parts: OEM', 'Automotive Aftermarket',
    'Tools & Hardware', 'Recreational Products'],
  chemicals: ['Chemicals: Specialty', 'Chemicals: Major Diversified',
    'Chemicals: Agricultural', 'Industrial Gases'],
  food: ['Food: Specialty/Candy', 'Food: Major Diversified', 'Food: Meat/Fish/Dairy',
    'Beverages: Non-Alcoholic', 'Beverages: Alcoholic', 'Agricultural Commodities/Milling',
    'Food Distributors', 'Tobacco', 'Household/Personal Care', 'Consumer Sundries'],
  retail: ['Food Retail', 'Specialty Stores', 'Apparel/Footwear Retail', 'Discount Stores',
    'Department Stores', 'Home Improvement Chains', 'Drugstore Chains',
    'Catalog/Specialty Distribution', 'Electronics/Appliance Stores',
    'Home Furnishings', 'Electronics/Appliances'],
  health: ['Pharmaceuticals: Major', 'Pharmaceuticals: Other', 'Pharmaceuticals: Generic',
    'Biotechnology', 'Medical Specialties', 'Medical Distributors', 'Managed Health Care',
    'Hospital/Nursing Management', 'Medical/Nursing Services', 'Services to the Health Industry'],
  transport: ['Airlines', 'Railroads', 'Other Transportation', 'Marine Shipping',
    'Air Freight/Couriers', 'Trucking', 'Oil & Gas Transportation'],
  tourism: ['Hotels/Resorts/Cruise lines', 'Restaurants', 'Casinos/Gaming',
    'Movies/Entertainment', 'Other Consumer Services', 'Other Consumer Specialties'],
  textile: ['Textiles', 'Apparel/Footwear'],
};

/**
 * Listings whose theme the industry gets wrong for THIS market.
 *
 * Kept to the cases where the classification is not merely coarse but reads as
 * broken to someone who follows Borsa İstanbul: Otokar builds the Cobra armoured
 * vehicle and Katmerciler builds armoured and riot-control vehicles, and both
 * are filed under road transport. Somebody filtering for savunma sanayi and not
 * finding Otokar would conclude the filter does not work.
 *
 * Deliberately short. Every entry here is a judgement rather than a fact, so the
 * list is visible, named, and the README says it exists.
 */
export const THEME_OVERRIDES = {
  OTKAR: 'defence',
  KATMR: 'defence',
};

/** industry name -> theme id, derived once from THEME_INDUSTRIES. */
export const THEME_OF_INDUSTRY = new Map(
  Object.entries(THEME_INDUSTRIES).flatMap(([id, list]) => list.map((i) => [i, id]))
);

/**
 * TradingView's industry for a pooled vehicle rather than a company. A fund of
 * funds holding SOXX is holding semiconductors, but an ETF has no industry of
 * its own and there are 180 distinct ones in the data, so they are counted as
 * unclassified rather than guessed at. Nine tenths of that money is in precious
 * metal ETFs, which the asset-class composition already shows.
 */
export const POOLED_INDUSTRY = 'Investment Trusts/Mutual Funds';
