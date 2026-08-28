// Headless logic for FundHunter: formatting, i18n, search/filter/sort, portfolio
// composition maths and risk metrics.
//
// Deliberately DOM-free so it runs in Node — the browser (ui.js), the data build
// (scripts/fetch-tefas.mjs) and the tests all import this same module, which keeps
// the metric definitions honest: there is exactly one implementation of "what a
// 1-year return means".

// ---------------------------------------------------------------- i18n

export const LANGS = ['tr', 'en'];

export const STRINGS = {
  tr: {
    tagline: 'Türkiye’deki tüm yatırım fonları ve gerçekte ne tuttukları.',
    industryTotal: 'Toplam portföy büyüklüğü',
    fundsCounted: '{n} fon',
    asOf: '{date} itibarıyla',
    search: 'Fon kodu veya adı ara',
    kind: 'Fon tipi',
    category: 'Kategori',
    founder: 'Kurucu',
    exposure: 'Ağırlıklı içerik',
    exposureHint: '%50’den fazlası',
    sort: 'Sırala',
    all: 'Tümü',
    reset: 'Filtreleri temizle',
    noResults: 'Bu filtrelerle eşleşen fon yok.',
    noResultsHint: 'Aramayı sadeleştirin veya filtreleri temizleyin.',
    showing: '{n} fon gösteriliyor',
    code: 'Kod',
    name: 'Fon',
    size: 'Büyüklük',
    investors: 'Yatırımcı',
    price: 'Fiyat',
    composition: 'İçerik',
    return1w: '1 Hafta',
    return1m: '1 Ay',
    return3m: '3 Ay',
    return6m: '6 Ay',
    return1y: '1 Yıl',
    volatility: 'Oynaklık',
    maxDrawdown: 'Maks. düşüş',
    riskLabel: 'Yıllık oynaklık',
    back: 'Tüm fonlar',
    portfolio: 'Portföy dağılımı',
    portfolioOverTime: 'Dağılımın zaman içindeki değişimi',
    assetClass: 'Varlık sınıfı',
    weight: 'Ağırlık',
    share: 'Pay',
    holdings: 'Fon neye yatırım yapmış',
    holdingsNote:
      'Fonun elindeki tek tek kıymetler — hisseler, tahviller, sertifikalar. ' +
      'TEFAS yalnızca varlık sınıfı yüzdelerini yayınlar; bu liste KAP\'a verilen ' +
      'aylık portföy dağılım raporundan çıkarılır.',
    holdingsAsOf: 'KAP {period} raporu',
    holdingsSource: 'Kaynak: KAP portföy dağılım raporu',
    security: 'Kıymet',
    issuer: 'İhraççı',
    holdingsMissing: 'İçerik listesi bu fon için henüz yok.',
    holdingsMissingWhy:
      'Bu liste, fonların her ay KAP’a verdiği portföy dağılım raporundan çıkarılır. ' +
      'Bu fonun raporu ya henüz işlenmedi ya da okunabilir biçimde verilmemiş — bazı ' +
      'kurumlar raporu taranmış görüntü olarak yüklüyor.',
    holdingsCount: '{n} pozisyon',
    holdingsMore: 'Tümünü göster ({n})',
    holdingsLess: 'Daha az göster',
    holdingsOtherFund: 'fon',
    holdingsVersus: '{period} ile karşılaştırıldı',
    holdingsPrevMonth: 'Önceki ay',
    holdingsDiff: 'Fark',
    holdingsDiffUnit: 'Fark (puan)',
    holdingsHidden: '+{n} pozisyon daha',
    holdingsNoneMatch: 'Bu filtreyle eşleşen pozisyon yok.',
    holdingsNewTitle: 'Bu pozisyon önceki ayın raporunda yoktu.',
    holdingsDelayTitle: 'Borsa verisi 15 dakika gecikmelidir.',
    hg_equityTr: 'Yerli Hisseler',
    hg_equityFx: 'Yabancı Hisseler',
    hg_funds: 'BYF / Fonlar',
    hg_debt: 'Borçlanma Araçları',
    hg_lease: 'Kira Sertifikaları',
    hg_metals: 'Kıymetli Madenler',
    hg_derivatives: 'Türev / VİOP',
    hg_cash: 'Nakit, Mevduat ve Repo',
    hg_other: 'Diğer',
    move_all: 'Tümü',
    move_up: 'Artanlar',
    move_down: 'Azalanlar',
    move_new: 'Yeni',
    holdingsFlagged:
      'Raporun kendi yüzdeleri %100\'e ulaşmıyor ({total}). Satırlar ve ara ' +
      'toplamlar tutuyor, yani fark bizim okumamızda değil raporun kendisinde.',
    lastPrice: 'Son fiyat',
    dayChange: 'Bugün',
    liveToday: 'Tahmini hareket · bugün',
    liveLastSession: 'Tahmini hareket · son seans',
    livePriced: 'Fiyatlanabilen pay',
    livePositions: 'Fiyatlanan pozisyon',
    liveLevered: 'Bu fon borçlanarak net varlığından fazla hisse tutuyor, bu yüzden fiyatlanan pay %100’ü aşıyor.',
    liveNote:
      'Fonun rapordaki pozisyonlarının son borsa hareketi, portföy ağırlıklarıyla toplandı. ' +
      'Borsada fiyatı olmayan kalemler — tahvil, mevduat, fon katılma payları — değişmemiş ' +
      'sayıldı; fon da rapordan bu yana alım satım yapmış olabilir. TEFAS fon fiyatlarını bir iş ' +
      'günü gecikmeyle yayınladığı için bu hareket fonun yayınlanmış fiyatına henüz ' +
      'yansımamıştır. Kısacası bu, fonun açıklanacak fiyatı değil, elindeki kıymetlerin hareketidir.',
    liveTooLittle:
      'Portföyün yalnızca {n} kadarı borsada fiyatlanabiliyor. Bu kadarından fonun ' +
      'günlük hareketi tahmin edilemez, o yüzden bir sayı verilmiyor.',
    liveNonePriced:
      'Bu fonun elindeki kıymetlerin hiçbiri fiyatını alabildiğimiz borsalarda — Borsa ' +
      'İstanbul ve ABD — işlem görmüyor.',
    liveUnavailable:
      'Canlı fiyatlar şu anda alınamadı; tablo yalnızca rapordaki değerleri gösteriyor.',
    liveWeightsOff:
      'Bu raporun ağırlıkları bir portföy toplamadığı için günlük tahmin hesaplanmadı. ' +
      'Satırlardaki fiyatlar yine de canlıdır.',
    liveAsOf: '{market} {time}',
    liveDelayed: '{n} dk gecikmeli',
    liveClosedLabel: 'Borsa',
    liveClosed: 'kapalı',
    market_bist: 'Borsa İstanbul',
    market_us: 'ABD borsaları',
    liveSessionOpen: 'açık',
    liveSessionShut: 'kapalı',
    liveSessions: 'Seans: {list}',
    liveFxNote:
      'Yabancı hisseler dolar cinsinden işlem gördüğü için lira karşılıkları hem ' +
      'hissenin hem de doların günlük hareketiyle hesaplandı.',
    liveSourceHead: 'Fiyatlar: ',
    liveSourceTail: ' · piyasa verisi {n} dakika gecikmelidir',
    loading: 'Yükleniyor…',
    loadError: 'Veri yüklenemedi.',
    retry: 'Tekrar dene',
    notFound: 'Fon bulunamadı.',
    negativeNote:
      'Bu fon negatif repo bildiriyor (borçlanma). Çubuk yalnızca pozitif kalemleri gösterir; tablo gerçek değerleri verir.',
    benchmarkFund: 'Fon',
    dataSource: 'Kaynak: TEFAS',
    updated: 'Güncelleme: {date}',
    indexedNote: '{date} = 100 olacak şekilde ölçeklenmiştir',
    noHistory: 'Bu fon için yeterli geçmiş veri yok.',
    tableView: 'Tablo görünümü',
    perYear: 'yıllık',
    sortSize: 'Büyüklük',
    sortName: 'İsim',
    sortRet1m: '1 Aylık getiri',
    sortRet3m: '3 Aylık getiri',
    sortRet6m: '6 Aylık getiri',
    sortRet1y: '1 Yıllık getiri',
    sortInvestors: 'Yatırımcı sayısı',
    sortRisk: 'Oynaklık (düşükten)',
    sortExcess: 'Para piyasasına göre fazla getiri',
    sortRatio: 'Risk başına fazla getiri',
    sortFlow30: '30 günlük para girişi',
    sortInvestors30: '30 günde yatırımcı artışı',

    // preferences
    prefs: 'Tercihler',
    riskTolerance: 'Risk toleransı',
    riskUpTo: 'En fazla {n}. seviye',
    horizon: 'Vade',
    taxPref: 'Stopaj',
    taxDefault: 'Fon tipine göre',
    taxNone: 'Brüt (vergisiz)',
    onlyBeatsCash: 'Sadece para piyasasını geçenler',
    onlyNewFunds: 'Sadece yeni fonlar',
    onlyLevered: 'Kaldıraç kullananlar',
    leverageChip: 'Kaldıraç {n}×',
    leverageNote:
      'Bu fon borçlanarak (çoğunlukla repo ile) net varlığından fazlasını yatırıma ' +
      'koyuyor. Kaldıraç kazancı da kaybı da aynı oranda büyütür. Oran, fonun TEFAS’a ' +
      'bildirdiği dağılımdan hesaplanır: borçlanma negatif kalem olarak görünür, ' +
      'pozitif kalemler de %100’ü aşar. VİOP üzerinden alınan kaldıraç bu orana ' +
      'girmez — vadeli işlemin ağırlığı sözleşme büyüklüğü değil portföy değeri ' +
      'üzerinden bildirilir.',
    // --- crash protection ---
    navCrash: 'Düşüşler',
    crashTitle: 'Düşüşte koruma',
    crashLede:
      'BIST 100 son {y} yılda {n} kez en az %10 geriledi. Bu sayfa her fonun tam o ' +
      'tarihler arasında ne yaptığını gösteriyor. Getiri tabloları yükselen piyasada ' +
      'herkesi iyi gösterir; fonlar arasındaki asıl fark düşerken ortaya çıkar.',
    crashEyebrow: 'Son {y} yılda {n} düşüş',
    crashSpared: 'Kaçınılan düşüş',
    crashSparedNote:
      'Piyasanın kaybettiği değerin ne kadarından kurtulduğunuz. %100, fon değerini ' +
      'korudu demek; %0, endeksle aynı oranda düştü; %100’ün üstü, endeks düşerken ' +
      'kazandırdı; eksi ise endeksten fazla düştü. Üstteki tek oran, düşüşlerin ' +
      'ortancasıdır — bileşik değil, çünkü bileşikte tek bir olağanüstü dönem bütün ' +
      'notu taşır. Her iki taraftan da para piyasası getirisi düşülür. İki uyarı: bu ' +
      'ölçü iyi savunma yapmayı da piyasada hiç olmamayı da neredeyse aynı ölçüde ' +
      'ödüllendirir — para piyasası fonları her seferinde %100 çıkar — ve bir ortanca ' +
      'en kötü durumu anlatmaz, onun için yanındaki rakam var.',
    crashFund: 'Fon',
    crashBench: 'BIST 100',
    crashCovered: 'Kapsanan düşüş',
    crashCoveredNote:
      'Fon, ölçülen {of} düşüşün {n} tanesinde vardı. Oranlar yalnızca bu düşüşler ' +
      'üzerinden, endeksin aynı düşüşlerdeki kaybına karşı hesaplanır — sonradan ' +
      'kurulan bir fon, göremediği düşüşlerden sorumlu tutulmaz.',
    crashWorst: 'En kötü düşüş',
    crashPeriod: 'Dönem',
    crashThisFund: 'Bu fon',
    crashSection: 'Piyasa düştüğünde',
    crashNotEnough:
      'Bu fon, ölçülen düşüşlerin en az ikisini yaşayacak kadar eski değil. Koruma ' +
      'oranı iki düşüşten az veriyle hesaplanmıyor.',
    crashLagNote:
      'TEFAS bir fonun fiyatını, yansıttığı piyasa gününden bir iş günü sonra ' +
      'yayımlar. Bu yüzden her düşüşün iki ucunda da o tarihten sonraki ilk fiyat ' +
      'kullanılıyor.',
    crashDays: '{n} gün',
    onlyCrashProof: 'Düşüşlerde değer kaybetmeyenler',
    onlyCrashProofNote:
      'Ölçülen BIST düşüşlerinin tamamı boyunca, bileşik olarak, fon fiyatı ' +
      'gerilememiş. Endeksten az düşmek yetmez; hiç düşmemiş olması gerekir.',
    sortCrash: 'Düşüşte koruma',
    crashChip: 'Düşüşte koruma {n}',
    crashEmpty: 'Bu filtrelerle düşüş kaydı olan fon kalmadı.',
    crashMeasured: 'Ölçülen düşüşler',
    crashBest: 'En iyi korunanlar',
    crashFell: 'En çok düşenler',
    crashFellNote:
      'Aynı düşüşlerde en kötü sonucu veren fonlar. Bir fonun uzun vadeli getirisi ' +
      'iyi olabilir; bu liste, o getiriyi almak için hangi düşüşlere katlanmanız ' +
      'gerektiğini gösteriyor.',
    crashCash: 'Para piyasası',
    crashCashNote:
      'Her düşüşün yanındaki para piyasası getirisi, aynı iki fiyat arasında TL para ' +
      'piyasası fonlarının ortancasının kazandırdığı orandır ve hem fondan hem ' +
      'endeksten düşülür. Düşülmese, iki ay süren bir pencerede sadece mevduat faizi ' +
      'birkaç puan eklediği için repo dışında bir şey tutmayan bir fon portföyü ' +
      'ustaca savunmuş gibi görünürdü.',
    crashFundsSeen: 'Ölçülen fon',
    // --- themes and dividends ---
    themeLabel: 'Sektör teması',
    themeHint:
      'Fonun tek tek hisselerinden hesaplanır, TEFAS’ın varlık sınıfı dağılımından ' +
      'değil. Bu yüzden yalnızca KAP portföy raporu okunabilen fonlarda var.',
    themeShare: 'En az pay',
    themeShareOf: 'Fonun en az %{n}’i',
    themeSection: 'Ne işe yatırıyor',
    themeNote:
      'Fonun her hissesi, işlem gördüğü borsadaki sınıflandırmasına göre bir temaya ' +
      'yazılır ve ağırlıklar fonun tamamına göredir — kompozisyon çubuğuyla aynı ' +
      'ölçekte. Temalar kesişmez, o yüzden toplanabilirler. Borsa yatırım fonları ' +
      'bir şirket olmadığı için tema almaz.',
    themeCovered: 'Hisselerin %{n}’i sınıflandırıldı',
    themeNone: 'Bu fonun KAP portföy raporu okunamadı, bu yüzden tema dağılımı yok.',
    themeBanks: 'Bankacılık',
    themeFinance: 'Finans (banka dışı)',
    themeRealEstate: 'Gayrimenkul',
    themeDefence: 'Savunma ve havacılık',
    themeSemis: 'Yarı iletken',
    themeTech: 'Teknoloji ve yazılım',
    themeTelecom: 'Telekom ve medya',
    themeEnergy: 'Enerji',
    themeMetals: 'Madencilik ve metal',
    themeIndustrial: 'Sanayi ve makine',
    themeConstruction: 'İnşaat ve yapı',
    themeAutos: 'Otomotiv',
    themeChemicals: 'Kimya',
    themeFood: 'Gıda, içecek ve tarım',
    themeRetail: 'Perakende',
    themeHealth: 'Sağlık',
    themeTransport: 'Ulaştırma',
    themeTourism: 'Turizm ve eğlence',
    themeTextile: 'Tekstil ve giyim',
    dividendLabel: 'Temettü getirisi',
    dividendAtLeast: 'En az %{n}',
    dividendStat: 'Portföyün temettüsü',
    dividendNote:
      'Fonun elindeki hisselerin son bir yılda ödediği temettünün, fonun ' +
      'büyüklüğüne oranı. Bu size ödenen bir tutar değil: Türkiye’de yatırım ' +
      'fonları dağıtım yapmaz, temettü fon fiyatının içinde kalır. TEFAS’ın hiçbir ' +
      'alanında dağıtım bilgisi yok; bu rakam KAP raporundaki hisselerden ' +
      'hesaplanıyor.',
    dividendVsMarket: 'BIST 100’ün kendi temettü getirisi %{n}',
    dividendSection: 'Temettü',
    sortDividend: 'Temettü getirisi',
    // --- dashboard ---
    // --- shares ---
    navShares: 'Hisseler',
    company: 'Şirket',
    return1d: 'Bugün',
    win1d: 'Bugün',
    win1m: '1A',
    win3m: '3A',
    win6m: '6A',
    win1y: '1Y',
    watchPerTile: 'Her kutu kendi dönemi',
    watchNoSession: 'işlem yok',
    shareNotFound: '{code} diye bir borsa kodu yok.',
    kindEtf: 'Borsa yatırım fonu',
    kindTrust: 'Yatırım ortaklığı',
    themeOther: 'Diğer',
    navMarket: 'Piyasa',
    marketChart: 'Borsa, altın, dolar, euro',
    marketMap: 'Borsa haritası',
    marketMapNote: 'En büyük {n} şirket. Kutunun büyüklüğü piyasa değeri, rengi bugünkü değişim; sektörlerine göre gruplanmış.',
    searchFunds: 'Bu listede ara',
    searchNoHits: 'Eşleşme yok',
    searchFundKind: 'Fon',
    searchShareKind: 'Hisse',
    fundsInTheme: '{name} fonları →',
    fund: 'Fon',
    themeAny: 'Tüm temalar',
    showMore: 'Daha fazla göster',
    shareSearch: 'Hisse ara',
    shareCount: '{n} hisse',
    heldOnly: 'Yalnızca fonların tuttukları',
    sharesUnavailable: 'Hisse verisi henüz yok.',
    sharesStamp: 'Fiyatlar {n} dakika gecikmeli. Diğer rakamlar son kapanışa ait.',
    sharesClose: '{date} kapanışı. Canlı fiyat alınamadı.',
    marketCap: 'Piyasa değeri',
    peRatio: 'F/K',
    peNote: 'Fiyat / son 12 ayın hisse başına kârı. Zarar eden şirkette boştur.',
    pbRatio: 'PD/DD',
    pbNote: 'Piyasa değeri / defter değeri.',
    psRatio: 'PD/Satış',
    evEbitda: 'FD/FAVÖK',
    eps: 'Hisse başına kâr',
    epsNote: 'Son 12 ay, seyreltilmiş.',
    epsGrowth: 'HBK büyümesi',
    dividendYield: 'Temettü getirisi',
    payout: 'Dağıtım oranı',
    payoutNote: 'Kârın temettü olarak dağıtılan kısmı.',
    dps: 'Hisse başına temettü',
    shareYieldNote: 'Son 12 ayda ödenen temettünün bugünkü fiyata oranı.',
    revenue: 'Hasılat',
    netIncome: 'Net kâr',
    ebitda: 'FAVÖK',
    freeCashFlow: 'Serbest nakit akışı',
    fcfNote: 'Faaliyetten gelen nakit eksi yatırım harcamaları.',
    grossMargin: 'Brüt marj',
    operatingMargin: 'Faaliyet marjı',
    netMargin: 'Net marj',
    roe: 'Özkaynak kârlılığı',
    roeNote: 'Net kâr / özkaynak.',
    roic: 'Yatırılan sermaye kârlılığı',
    debtEquity: 'Borç / özkaynak',
    debtEquityNote: 'Toplam finansal borcun özkaynağa oranı.',
    currentRatio: 'Cari oran',
    totalDebt: 'Toplam borç',
    staff: 'Çalışan sayısı',
    shareValuation: 'Değerleme ve temettü',
    shareBusiness: 'Şirketin işi',
    shareTrading: 'Fiyat ve işlem',
    sharePriceChart: 'Fiyat ve endeks',
    volume: 'İşlem hacmi (adet)',
    avgVolume: '10 günlük ortalama',
    avgVolumeNote: 'Son on günün ortalama işlem adedi.',
    relVolume: 'Göreli hacim',
    relVolumeNote: 'Bugünkü hacmin on günlük ortalamaya oranı. 1’in üstü, olağandan hareketli demek.',
    volatility1m: 'Oynaklık (aylık)',
    shareVolNote: 'Son bir ayın günlük fiyat değişimlerinin standart sapması.',
    beta: 'Beta',
    betaNote: 'Endeks %1 hareket ettiğinde hissenin ortalama hareketi. 1’in üstü endeksten sert demek.',
    rsi: 'RSI',
    rsiNote: '14 günlük göreli güç. 70 üstü “çok alınmış”, 30 altı “çok satılmış” diye okunur.',
    sma50: '50 günlük ortalama',
    sma200: '200 günlük ortalama',
    smaNote: 'Fiyatın ortalamasının üstünde mi altında mı olduğu, trend göstergesi olarak okunur.',
    freeFloat: 'Halka açıklık',
    floatNote: 'Sermayenin borsada serbestçe işlem gören kısmı.',
    sharesOut: 'Toplam pay adedi',
    range52: '52 hafta',
    // --- portföy ---
    navPortfolio: 'Portföy',
    portfolio: 'Portföy',
    portfolioEmpty: 'Burada henüz bir şey yok.',
    portAddCode: 'Kod',
    portAddButton: 'Ekle',
    portAddUnknown: 'Bu kodda bir fon ya da hisse yok.',
    portAddNoUnits: 'Kaç adet aldığınızı yazın.',
    posAdded: 'Eklendiği tarih',
    posSince: '{date} tarihinden beri',
    posSinceShort: 'Eklendiğinden beri',
    posUnits: 'Adet',
    posUnitsHint: 'Kaç pay tuttuğunuz',
    posCostHint: 'Maliyeti bilinmeyen alımlar, o günkü fiyattan değerlenir.',
    posAvg: 'Ortalama maliyet',
    posLots: 'Alım ve satımlar',
    posLotCount: '{n} işlem',
    posLotRemove: 'Bu işlemi sil',
    posBuy: 'Alış',
    posSell: 'Satış',
    posAdd: 'Ekle',
    posSellAll: 'tamamını sat',
    posHeld: '{n} adet',
    posUnitPrice: 'Birim fiyat',
    posUnitPriceHint: 'Bir adedi kaça aldığınız. Toplam tutar değil.',
    posSellPrice: 'Satış fiyatı',
    posSellPriceHint: 'Bir adedi kaça sattığınız.',
    posRealised: 'gerçekleşen {v}',
    posPrice: 'Güncel fiyat',
    posValue: 'Değer',
    posProfit: 'Kâr / zarar',
    posAssumed: 'tahmini maliyet',
    // --- toplamlar ---
    portTotalValue: 'Toplam değer',
    portTotalCost: 'Toplam maliyet',
    portProfit: 'Kâr / zarar',
    portVsCash: 'Aynı paranın para piyasasındaki hâli',
    portVsCashGap: 'Fark',
    portCounted: '{n}/{of} pozisyon değerlendi',
    portNoBasis: '{n} pozisyonun maliyeti bilinmiyor, kâr hesabına katılmadı.',
    portSpecValue: 'Bu hisselere denk gelen',
    portMix: 'Portföyün gerçek dağılımı',
    portMixNote:
      'Her fonun içeriği, tuttuğunuz tutara göre ağırlıklandırıldı. Panodaki ' +
      'eşit ağırlıklı hâlinin aksine bu sizin gerçek dağılımınız.',
    portSpec: 'Spekülatif hisse maruziyeti',
    portSpecNote: 'Tuttuğunuz fonların spekülatif görünümlü hisselere ağırlığı, tutarınıza göre.',
    // --- içine bakış ---
    portLook: 'Gerçekte neye sahipsiniz',
    portLookConc: 'Etkin pozisyon',
    portLookConcHint:
      'Aynı yoğunluktaki eşit büyüklükte pozisyon sayısı. Otuz pozisyonun hepsi ' +
      'tek bir bahisse, bu sayı bire yaklaşır.',
    portLookEquity: 'Hisse tarafında',
    portLookEquityHint: 'Yalnızca hisseler üzerinden. Tahvil, mevduat ve kıymetli maden sayılmaz.',
    portLookNames: 'Farklı pozisyon',
    portLookPosition: 'Pozisyon',
    portLookValue: 'Tutarınız',
    portLookWeight: 'Payı',
    portLookVia: 'Fonlar',
    portLookDirect: 'Doğrudan',
    portLookUncovered: '{v} açılamadı: bu fonların KAP bildirimi yok.',
    portLookUnnamed: '{v} kodsuz bildirildi; aynı varlık olarak birleştirilmedi.',
    portLookHidden: 'En büyük {n} pozisyon gösteriliyor.',
    // --- kayıtlı ekranlar ---
    screenName: 'Ekran adı',
    screenSave: 'Kaydet',
    screenCopy: 'Bağlantıyı kopyala',
    screenCopied: 'Kopyalandı',
    screenDelete: 'Sil',
    // --- karşılaştırma ---
    compare: 'Karşılaştır',
    compareN: 'Karşılaştır ({n})',
    compareAdd: 'Karşılaştırmaya ekle',
    compareRemove: 'Karşılaştırmadan çıkar',
    comparePickTwo: 'Karşılaştırmak için en az iki fon seçin.',
    compareUnknown: 'Böyle bir fon kodu yok.',
    compareFull: 'Aynı anda en fazla {n} fon karşılaştırılabilir.',
    compareChart: 'Aynı günden başlayarak 100’e endekslenmiş',
    compareMix: 'Dağılımları',
    compareFigures: 'Rakamlar',
    compareOverlap: 'Aynı şeyi mi tutuyorlar',
    compareNoShared: 'Ortak pozisyon yok.',
    compareUnfiled: '{n} fonun KAP bildirimi okunamadı; bu tablo onları kapsamıyor.',
    // --- yıllık getiri oranı ve ücret ---
    portRate: 'Yıllık getiri oranı',
    portRateHint:
      'Her alımın ne kadar süredir portföyde olduğuna göre hesaplanan iç verim ' +
      'oranı (XIRR). Bir yıllık paranız ile iki haftalık paranız aynı sayılmaz.',
    portRatePartial: '{n}/{of} pozisyon üzerinden; maliyeti bilinmeyenler dışarıda.',
    portFees: 'Fonların aldığı yönetim ücreti',
    portFeesNote:
      'Bu tutar ödenecek bir masraf değil: ücret fon fiyatının içinden kesiliyor, ' +
      'yani zaten ödendi. Alış ile bugünkü değerin ortalaması üzerinden hesaplandı.',
    portFeesTotal: 'Bugüne kadar',
    portFeesYears: '{n} yıl',
    portFeesPartial: '{n} pozisyonun gider oranı yayımlanmamış; hesaba katılmadı.',
    // --- stopaj ---
    portTax: 'Bugün satsanız stopaj',
    portTaxGain: 'Kâğıt üstündeki kazanç',
    portTaxDue: 'Kesilecek stopaj',
    portTaxNet: 'Elinize geçecek',
    portTaxHint:
      'Kazançlı pozisyonların her biri kendi oranından hesaplandı. Zarardaki ' +
      'pozisyonlar kazançtan düşülmedi: mahsup edilip edilemeyeceği tüm yıllık ' +
      'kazancınıza bağlı ve burası onu bilemez.',
    portTaxNote:
      'Hisse senedi yoğun fonlarda kazanç stopajdan muaf, süre şartı yok. Bu bilgi ' +
      'TEFAS’ın yayımladığı resmî fon unvanından okunuyor, tahmin edilmiyor. ' +
      'İzahnamesinde %51 taahhüdü olup 1 yıl sonra muaf olan fonlar burada tespit ' +
      'edilemiyor ve vergili görünür. Oranlar varsayımdır, vergi tavsiyesi değildir.',
    portTaxPartial: '{n} pozisyonun maliyeti bilinmiyor ya da fon değil; hesaba katılmadı.',
    taxPrefNote:
      'Türkiye’de fon kazancında iki oran var: %17,5 ve sıfır. Hisse senedi yoğun ' +
      'fonlarda kazanç süre şartı olmadan muaf; bu, fonun resmî unvanından okunuyor. ' +
      'Kesin bilgi için fonun KAP’taki izahnamesine bakın.',
    taxBucket_exempt: 'Hisse senedi yoğun fon — muaf',
    taxBucket_standard: 'Stopaja tabi',
    posHeldDays: '{n} gün',
    posTurnsOn: 'Bir yılı {date} tarihinde doluyor.',
    posOverYear: 'Bir yıldan uzun süredir elinizde.',
    // --- istikrar ---
    consistency: 'Para piyasasını ne sıklıkla geçti',
    consistencyHint:
      'Geçmişteki her başlangıç tarihinden itibaren bu uzunluktaki pencerelerin ' +
      'kaçında fon, para piyasası fonlarının önünde bitirdi. Pencereler üst üste ' +
      'biner; bu bir isabet oranıdır, istatistiksel bir testin sonucu değil.',
    consistencyOf: '{n}/{of} pencere',
    consistencyMedian: 'ortanca {v}',
    consistencyNote:
      'Tek bir dönemin getirisi şansa bağlı olabilir; her pencerede önde bitirmek ' +
      'daha zordur. Ortanca fark, pencerelerin yarısında bundan iyi, yarısında ' +
      'bundan kötü olduğunu söyler.',
    // --- reel ---
    realTerms: 'Reel',
    realTermsHint:
      'Tüm lira tutarlarını, en son yayımlanan yılın parasına çevirir. Yıllık TÜFE ' +
      'kullanılır; yıl içinde ara değer üretilmez, her dönem kendi yılının ' +
      'endeksinden hesaplanır. Endeks yıllık ortalamadır.',
    realTermsNote: '{year} yılı lirasıyla, Dünya Bankası TÜFE verisine göre.',
    realTermsPartial:
      'Grafikteki {n} dönem {year} sonrasına ait; çevrilecek endeks yok, nominal bırakıldı.',
    // --- son ziyaretten beri ---
    sinceVisit: 'Son ziyaretinizden beri',
    sinceVisitDays: '{n} gün',
    sinceVisitMedian: 'Fonlarınızın ortancası',
    sinceVisitHint:
      'Takip ettiğiniz fonların bu süredeki getirilerinin ortancası. Ortalama ' +
      'değil: birkaç fonluk bir listede tek bir fonun sıçraması diğerleri ' +
      'hakkında hiçbir şey söylemez.',
    sinceVisitOf: '{n} fon',
    sinceVisitBest: 'En iyisi',
    sinceVisitWorst: 'En kötüsü',
    sinceVisitNew: 'Yeni fon',
    // --- birlikte hareket ---
    portTogether: 'Gerçekten farklı bahisler mi',
    portTogetherBets: 'Bağımsız pozisyon sayısı',
    portTogetherHint:
      'Fonlarınızın günlük getirileri birbirine ne kadar benziyorsa, portföy o ' +
      'kadar az sayıda bahis gibi davranır. Aynı hisseleri tutmasalar bile iki ' +
      'Türk hisse fonu aynı bahistir; üstteki panel neyi iki kez tuttuğunuzu, ' +
      'bu panel neyin birlikte hareket ettiğini söyler.',
    portTogetherOf: '{n} fon',
    portTogetherAvg: 'Ortalama korelasyon',
    portTogetherPartial: '{n} pozisyon için yeterli ortak fiyat geçmişi yok.',
    portOnlyWatching: 'Yalnızca izlediğiniz',
    portHolding: 'Tuttuklarınız',
    portRing: 'Paranın dağılımı',
    portToday: 'Son kapanıştan beri',
    portTodayNote: 'Hisseler canlı, fonlar TEFAS’ın yayımladığı son fiyattan.',
    portOthers: 'Diğerleri ({n})',
    portRingPartial: '{v} hesaba katılmadı: önceki kapanışı yok.',
    // --- spekülatif tahtalar ---
    specPanel: 'Spekülatif görünüm',
    specChip: 'Spekülatif görünüm',
    specNote:
      'Aşağıdakilerin hepsi borsanın yayımladığı rakamlar ve her biri BIST’in en ' +
      'uç yüzde onunda. Bunlar şirket ya da yatırımcıları hakkında bir iddia ' +
      'değil: fiyatın kolay oynatılabileceğini ve dayanacak bir mali tablo ' +
      'olmadığını söylüyor. Piyasadaki adıyla “tahta” denen tablo budur.',
    specMet: '{of} ölçütün {n} tanesi',
    specFlagRunUp: 'Sert yükseliş',
    specFlagThinFloat: 'Düşük halka açıklık',
    specFlagConcentrated: 'Tek fonda yoğunlaşma',
    specFlagNoEarnings: 'Arkasında kâr yok',
    specFlagRichBook: 'Defter değerinin çok üstünde',
    specFlagViolent: 'Sert günlük hareketler',
    specFlagRunUpNote: 'Son bir yılda ya da son üç ayda olağanüstü yükseliş.',
    specFlagThinFloatNote: 'Payların dörtte birinden azı borsada işlem görüyor.',
    specFlagConcentratedNote: 'Tek bir fon şirketin en az yirmide birini tutuyor.',
    specFlagNoEarningsNote: 'Şirket zarar ediyor ya da fiyat kârın yüz katından fazla.',
    specFlagRichBookNote: 'Piyasa değeri özkaynağının en az on katı.',
    specFlagViolentNote: 'Günlük dalgalanma borsanın ortancasının iki katı.',
    // --- fon tarafı ---
    specFundPanel: 'Spekülatif görünümlü hisseler',
    specFundClean: 'Spekülatif görünümlü hisse yok',
    // The conditions live on the share pages, not this one, so the note cannot
    // say "the ones above" — it has to name them.
    specFundNote:
      'Fonun KAP bildirimindeki hisselerden kaçı şu ölçütleri karşılıyor: sert bir ' +
      'fiyat yükselişi ve buna eşlik eden en az iki koşul daha — ince halka açıklık, ' +
      'tek bir fonun büyük payı, fiyatın arkasında kâr olmaması, defter değerinin çok ' +
      'üstü bir fiyat, sert günlük hareketler. Hangileri olduğu her hissenin kendi ' +
      'sayfasında yazıyor. Bir endeks fonu bunları seçmiş olmayabilir — endekste ' +
      'oldukları için tutar — ama tutan fonun yatırımcısı yine de bu fiyatlara maruz ' +
      'kalıyor.',
    specWeight: 'Portföydeki ağırlığı',
    specOfEquity: 'Hisse kısmının',
    specCount: 'Hisse sayısı',
    specFilter: 'Spekülatif hisse',
    specFilterNone: 'Hiç tutmayanlar',
    specFilterAtLeast: '%{n} ve üstü',
    specFilterNoneChip: 'Spekülatif hisse tutmayanlar',
    specFilterNote:
      'KAP portföy raporu okunabilen ve hisse tutan fonlarda. Raporu okunamayan ' +
      'bir fon “tutmayanlar” arasında sayılmaz: bilinmiyor olması temiz olması demek değil.',
    specNoneFlagged:
      'Bu fon hisse tutuyor ve KAP bildirimindeki hisselerin hiçbiri spekülatif ' +
      'görünümün ölçütlerini karşılamıyor: sert bir fiyat yükselişi ve buna eşlik ' +
      'eden en az iki koşul daha. Ölçütlerin tamamı her hissenin kendi sayfasında.',
    // --- finansal tablolar ---
    financials: 'Finansal tablolar',
    financialsNote:
      'Şirketin kendi bildirdiği rakamlar, düzeltilmemiş lirayla. Türkiye’de ' +
      '2023’ten beri enflasyon muhasebesi uygulanıyor: 2019’un lirasıyla ' +
      '2026’nın lirası aynı lira değil, uzak yılları yan yana koyarken dikkat.',
    periodQuarter: 'Çeyreklik',
    periodTtm: 'Son 12 ay',
    periodYear: 'Yıllık',
    periodLabel: 'Dönem',
    metricLabel: 'Kalem',
    grossProfit: 'Brüt kâr',
    capex: 'Yatırım harcaması',
    latestPeriod: 'Son dönem',
    yoyChange: 'Yıllık değişim',
    ofRevenue: 'Satışa oranı',
    noStatements: 'Bu şirket için finansal tablo yok.',
    statementTable: 'Dönem dönem',
    ttmNote: 'Art arda dört çeyreğin toplamı: mevsimsellik böyle temizleniyor.',
    // --- bilanço ---
    shareBalance: 'Bilanço',
    totalAssets: 'Toplam varlık',
    totalLiabilities: 'Toplam yükümlülük',
    totalEquity: 'Özkaynak',
    cashHeld: 'Nakit ve benzerleri',
    shortTermDebt: 'Kısa vadeli borç',
    longTermDebt: 'Uzun vadeli borç',
    netDebt: 'Net borç',
    netDebtNote: 'Finansal borçtan nakit düşülmüş hali. Eksiyse şirketin borcundan çok nakdi var.',
    netCash: 'Net nakit',
    netDebtEbitda: 'Net borç / FAVÖK',
    netDebtEbitdaNote: 'Şirketin bugünkü faaliyet kârıyla borcunu kaç yılda kapatabileceği.',
    bookValuePerShare: 'Hisse başına özkaynak',
    nYears: '{n} yıl',
    // --- analistler ---
    shareAnalysts: 'Analist beklentisi',
    coverage: 'İzleyen kurum',
    priceTarget: 'Hedef fiyat',
    targetUpside: 'Hedefe uzaklık',
    targetRange: 'Hedef aralığı',
    analystNote: 'Hisseyi izleyen kurumların 12 aylık hedefleri ve tavsiyeleri. Tahmin, söz değil.',
    ratingBuy: 'Al',
    ratingHold: 'Tut',
    ratingSell: 'Sat',
    noAnalysts: 'Bu hisseyi izleyen analist yok.',
    // --- mali sağlamlık ---
    shareHealth: 'Mali sağlamlık',
    altmanZ: 'Altman Z',
    altmanNote: 'İflas riski göstergesi. 2,99 üstü güvenli, 1,81 altı riskli. Bankalar için hesaplanmaz.',
    piotroskiF: 'Piotroski F',
    piotroskiNote: 'Dokuz muhasebe testinden kaçını geçtiği. 7 ve üstü güçlü, 3 ve altı zayıf.',
    bandSafe: 'güçlü',
    bandGrey: 'ara bölge',
    bandDistress: 'zayıf',
    // --- temettü ---
    shareDividends: 'Temettü geçmişi',
    dpsByYear: 'Yıllara göre hisse başına temettü',
    dividendStreak: 'Kesintisiz ödeme',
    lastExDate: 'Son temettü tarihi',
    noDividends: 'Bu şirketin kayıtlı temettü ödemesi yok.',
    dpsNote: 'Beyan edildiği yılın lirasıyla. Bedelsiz sermaye artırımı hisse başına tutarı böler.',
    // --- beklenti ---
    shareEstimates: 'Beklenti ve gerçekleşen',
    estimateActual: 'Gerçekleşen',
    estimateForecast: 'Beklenti',
    surprise: 'Sapma',
    beatCount: '{n} çeyreğin {b} tanesinde beklentinin üstünde',
    awaitingReport: 'Henüz açıklanmadı',
    estimatesNote:
      'Kurumların çeyreklik satış beklentisi ile şirketin bildirdiği rakam. ' +
      'Yalnızca satış: aynı kaynağın hisse başına kâr tarafı şirketin kendi ' +
      'tablolarıyla tutmuyor, o yüzden yayımlanmıyor.',
    // --- benzerleri ---
    sharePeers: 'Aynı işi yapanlar',
    peersNote:
      'Aynı sanayi kolundaki en büyük şirketler. Sektör değil sanayi kolu: ' +
      '“Finans” hem bankayı hem gayrimenkul ortaklığını içeriyor ve ikisinin ' +
      'çarpanlarının birbirine söyleyeceği bir şey yok.',
    industryMedian: 'Ortanca',
    thisCompany: 'Bu şirket',
    noPeers: 'Aynı sanayi kolunda karşılaştırılacak başka şirket yok.',
    // --- pazar ve takvim ---
    marketStars: 'Yıldız Pazar',
    marketMain: 'Ana Pazar',
    marketSub: 'Alt Pazar',
    marketPre: 'Piyasa Öncesi İşlem Platformu',
    marketFunds: 'Fon Pazarı',
    marketWatch: 'Yakın İzleme Pazarı',
    marketWatchNote: 'Bu pazardaki şirketler borsanın özel gözetimi altında işlem görüyor.',
    nextReport: 'Sonraki bilanço',
    revenuePerStaff: 'Çalışan başına satış',
    dividendYears: 'Kesintisiz temettü',
    // --- who owns it ---
    shareOwners: 'Bu hisseyi kimler tutuyor',
    shareOwnersNote:
      'KAP’a bildirilen fon portföylerinden. Fonların elindeki kısım; şirketin ' +
      'geri kalanını bireyler, yabancılar ve ortaklar tutuyor.',
    shareNoOwners: 'Hiçbir fonun portföyünde bu hisse görünmüyor.',
    heldByFunds: 'Fon sayısı',
    heldValue: 'Fonların tuttuğu',
    fundOwned: 'Şirketin yüzdesi',
    fundOwnedNote: 'Fonların elindeki pay adedinin toplam pay adedine oranı.',
    byValue: 'Değere göre',
    byValueNote: 'Aynı hesap para üzerinden: tutulan tutarın piyasa değerine oranı. İkisi yakın çıkmalı.',
    addedBy: '{n} fon artırdı',
    trimmedBy: '{n} fon azalttı',
    ofCompared: '· önceki dönemle karşılaştırılabilen {n} fon içinde',
    noComparable: 'Önceki dönem ağırlıkları karşılaştırmaya elverişli değil.',
    ownWeight: 'Fondaki ağırlık',
    ownWeightNote: 'Hissenin o fonun portföyündeki payı.',
    ownMove: 'Değişim',
    ownMoveNote: 'Bir önceki portföy bildirimine göre ağırlık değişimi, puan olarak.',
    navDash: 'Ana Sayfa',
    dashPopular: 'Bu hafta para girenler',
    dashFlowOut: 'Bu hafta para çıkanlar',
    dashFavourites: 'Fonlarınız',
    dashFlowWeek: '{n} giriş',
    dashFlowWeekOut: '{n} çıkış',
    flowIn: 'Giren',
    flowOut: 'Çıkan',
    flowDirection: 'Para yönü',
    // --- örtüşme ---
    dashOverlap: 'Portföy örtüşmesi',
    overlapNote:
      'Takip ettiğiniz fonların KAP bildirimlerinden. İki fonun ortak tuttuğu ' +
      'kısım ikinci bir pozisyon değil: o kadarı aynı şirket, iki isim altında.',
    overlapPair: '%{n} aynı',
    overlapShared: 'İkisinde de',
    overlapClean: 'Takip ettiğiniz fonlar birbirini tekrar etmiyor.',
    // --- para piyasasına karşı ---
    vsCashHead: 'Para piyasasına karşı',
    vsCashMedian: 'Fonlarınızın ortancası',
    vsCashHurdle: 'Para piyasası',
    vsCashGap: 'Fark',
    vsCashAhead: '{n}/{of} fon önde',
    // --- piyasa ---
    dashThemes: 'Sektörler bugün',
    themesNote: 'Her sektörün bugünkü hareketi, piyasa değerine göre ağırlıklı.',
    dashMovers: 'Bugün öne çıkanlar',
    trendPanel: 'Yükselişte',
    trendWindow: 'son bir hafta',
    trendSectors: 'Sektörler',
    trendShares: 'Hisseler',
    moversNote:
      'BIST 100 içinde. Borsanın tamamında en çok hareket edenler her zaman ' +
      'en küçük şirketlerdir; günü anlatan onlar değil.',
    moversUp: 'Yükselenler',
    moversDown: 'Düşenler',
    awaitingQuotes: 'Fiyatlar bekleniyor…',
    dashLast: 'Son fiyat',
    dashLastNote:
      'TEFAS’ın yayımladığı en son fiyat değişimi. Bir iş günü gecikmeli: bugünün ' +
      'piyasası bu rakamda yok.',
    dashLive: 'Canlı',
    dashLiveHead: 'Fonun elindeki hisselerin şu anki fiyatlarından tahmin',
    dashLiveNote: 'Portföyün %{n}’i fiyatlanabildi',
    dashLiveNone:
      'Bu fon için canlı tahmin yok: portföy raporu okunamadı, fiyatlanabilen kısmı ' +
      'çok küçük, ya da ağırlıkları toplanmıyor.',
    dashMore: 'Hepsi →',
    watchPanel: 'Takip ettikleriniz',

    watchNoneHint: 'Henüz yıldızladığınız fon yok — bu hafta para girenler çizildi.',
    stanceLabel: 'Duruş',
    stanceAggressive: 'Agresif',
    stanceBalanced: 'Dengeli',
    stanceDefensive: 'Temkinli',
    maxFeeLabel: 'Gider oranı üst sınırı',
    feeUpTo: 'En fazla %{n}',

    // navigation
    navFunds: 'Fonlar',
    navPopular: 'Popüler',
    navFavorites: 'Favoriler',
    searchShort: 'Fon veya hisse ara',
    searchHint: 'Fon kodu, hisse kodu veya ad',
    openMenu: 'Menü',

    // market tape
    marketTape: 'Piyasa',
    tapeClose: '{date} kapanışı',
    tapeLive: 'Canlı · {time}',
    tapeLiveOne: 'Canlı fiyat',
    tapeCloseOne: '{date} kapanışı',
    tapeDayChange: 'Günlük değişim',
    tapeSource: 'Canlı fiyatlar: {name}',
    tapeFallback: 'Canlı fiyatlara ulaşılamadı; kapanış değerleri gösteriliyor.',
    hurdleMark: 'ölçüt',
    hurdleTitle: 'Bu uygulamada tüm fonlar bu getiriye göre değerlendirilir.',
    bist100: 'BİST 100',
    bist30: 'BİST 30',
    usdtry: 'Dolar',
    eurtry: 'Euro',
    goldgram: 'Gram Altın',
    mmf: 'Para Piyasası',

    // toolbar
    filterButton: 'Filtreler',
    filterCount: '{n} filtre',
    clearAll: 'Tümünü temizle',
    industryTotalShort: 'Sektör',
    lastMove: 'Son değişim',
    highlights: 'Öne çıkan fonlar',
    highlightsNote: 'Son 30 günde en çok para girişi alanlar',
    seeAll: 'Tümünü gör',

    // favourites
    favoriteAdd: 'Favorilere ekle',
    favoriteRemove: 'Favorilerden çıkar',
    favorites: 'Favorileriniz',
    favoritesEmpty: 'Henüz favori eklemediniz.',
    favoritesHint:
      'Fon ve hisse listelerindeki yıldıza dokunarak ekleyebilirsiniz. Favoriler yalnızca bu tarayıcıda saklanır.',
    favoritesCount: '{n} favori fon',
    favouriteShares: 'Hisseleriniz',
    favoritesCountBoth: '{f} fon · {s} hisse',

    // popular
    popular: 'Popüler fonlar',
    popularNote:
      'Son günlerde en çok para ve yatırımcı çeken fonlar. Bu bir kalite ölçüsü değil, ilgi ölçüsüdür — para girişi fonun iyi olduğunu göstermez.',
    popularRiskNote:
      'Yalnızca TEFAS’ta işlem gören ve risk değeri {n} ve üzeri olan fonlar. Para piyasası ve kısa vadeli borçlanma fonları listelenmez.',
    popularRiskShort: 'Risk {n}+ · TEFAS’ta işlem görenler',
    popularFlow: 'En çok para girişi (30 gün)',
    popularInvestors: 'En çok yeni yatırımcı (30 gün)',
    popularNew: 'Yeni açılan fonlar',
    flowNote:
      'Net giriş, portföy büyüklüğündeki değişimin fiyat hareketiyle açıklanmayan kısmıdır: fiyatı ikiye katlandığı için büyüyen bir fon para almamıştır.',
    shareOfSize: 'Büyüklüğe oranı',
    launched: 'Yaş',
    ageDays: '{n} gün',
    noneYet: 'Bu sıralama için yeterli veri yok.',

    // quality
    quality: 'Kalite göstergeleri',
    vsCash: 'Para piyasasına göre',
    vsCashTitle: 'Para piyasası fonlarıyla karşılaştırma',
    vsCashNote:
      'Her iki getiri de aynı dönem için ve stopaj sonrasıdır. Fark, yüzde değil yüzde puan cinsindendir.',
    vsCashMore: '{period}: {code}, para piyasası fonlarından {n} daha fazla kazandırdı.',
    vsCashLess: '{period}: {code}, para piyasası fonlarından {n} daha az kazandırdı.',
    vsCashSame: '{period}: {code}, para piyasası fonlarıyla aynı getiriyi sağladı.',
    vsCashUnavailable: 'Bu dönem için karşılaştırma yapılamıyor.',
    thisFund: 'Bu fon (vergi sonrası)',
    cashBenchmark: 'Para piyasası fonları',
    difference: 'Fark',
    points: 'puan',
    vsPeers: 'Benzerlerine göre',
    peerGroup: 'Benzer fon grubu',
    peerMedian: 'Grup ortancası',
    ratioLabel: 'Risk başına fazla getiri',
    riskLevel: 'Risk değeri',
    riskLevelOfficial: 'TEFAS fon risk değeri (1–7)',
    volBand: 'Oynaklık bandı',
    qualifiedOnly: 'Nitelikli yatırımcı gerekir',
    qualifiedNote:
      'TEFAS risk değeri 7 olan fonlar yalnızca nitelikli yatırımcılara satılabilir.',
    hideQualified: 'Nitelikli yatırımcı şartı olanları gizle',
    tradeableOnly: 'Sadece TEFAS’ta işlem görenler',
    platformStatus: 'Platform durumu',
    tefasTraded: 'TEFAS’ta işlem görüyor',
    tefasNotTraded: 'TEFAS’ta işlem görmüyor',
    platformUnknown: 'Platform durumu bilinmiyor',
    mgmtFee: 'Yönetim ücreti',
    maxMgmtFee: 'İçtüzük üst sınırı',
    expenseRatio: 'Toplam gider oranı',
    feeNote: 'Yıllık, yüzde olarak',
    returnYtd: 'Yıl başından',
    return3y: '3 Yıl',
    return5y: '5 Yıl',
    sortFee: 'Toplam gider oranı (düşükten)',
    sortRetYtd: 'Yıl başından getiri',
    rangeLabel: 'Dönem',
    rangeAll: 'Tümü',
    chartHint: 'Değerleri görmek için grafiğin üzerine gelin veya ok tuşlarını kullanın.',
    chartPanel: 'Fiyat ve karşılaştırma',
    seriesLabel: 'Seriler',
    pickAtLeastOne: 'Grafiği çizmek için en az bir seri işaretleyin.',
    nativeNote:
      '{name} kendi birimiyle gösteriliyor. Karşılaştırmak için ikinci bir seri işaretleyin.',
    tooShortForRange: 'Bu dönem için yeterli veri yok.',
    flagBeatsCash: 'Nakit getirisini geçiyor',
    flagBeatsCashNo: 'Nakit getirisinin altında',
    flagBeatsPeers: 'Benzerlerinin üzerinde',
    flagBeatsPeersNo: 'Benzerlerinin altında',
    flagDrawdown: 'Düşüşü sınırlı',
    flagDrawdownNo: 'Sert düşüş yaşamış',
    flagShortHistory: 'Geçmişi kısa',
    flagSmallFund: 'Küçük fon',
    cashHurdle:
      '{period}: para piyasası fonları %{n} getirdi. Bunun altında kalan her fon, risksiz alternatife göre kaybettirmiştir.',
    cashHurdleUnknown:
      'Bu dönem için para piyasası karşılaştırması hesaplanamadı; sıralama ve “fazla getiri” sütunu boş kalır.',

    // prediction
    prediction: 'Tahmini güncel değer',
    predictionNote:
      'TEFAS fiyatları bir iş günü gecikmeli yayınlar. Bu tahmin, fonun son fiyatından bu yana BİST, altın, dolar ve nakit endekslerindeki hareketi fonun kendi duyarlılığıyla çarpar.',
    predictedChange: 'Son yayınlanan fiyattan bu yana tahmini değişim',
    predictedPrice: 'Tahmini fiyat',
    predictionRange: '{from} – {to} arası hareketle',
    explained: 'Açıklanabilirlik',
    explainedNote: 'Fonun günlük hareketinin ne kadarı bu dört göstergeyle açıklanabiliyor',
    lowConfidence:
      'Bu fonun hareketi piyasa göstergeleriyle zayıf açıklanıyor (R² {n}). Tahmin gösterilmiyor.',
    exposureModel: 'Piyasa duyarlılığı',
    alpha: 'Alfa (yıllık)',
    alphaNote: 'Piyasa duyarlılığıyla açıklanamayan yıllık getiri',
    turnover: 'Dağılım değişimi',
    turnoverNote: 'Haftalık ortalama portföy yeniden dağılımı',
    flow30: '30 günlük net para girişi',
    investors30: '30 günde yatırımcı değişimi',
    newFund: 'Yeni fon',
  },
  en: {
    tagline: 'Every investment fund in Türkiye, and what they actually hold.',
    industryTotal: 'Total portfolio size',
    fundsCounted: '{n} funds',
    asOf: 'as of {date}',
    search: 'Search fund code or name',
    kind: 'Fund type',
    category: 'Category',
    founder: 'Manager',
    exposure: 'Mostly holds',
    exposureHint: 'over 50%',
    sort: 'Sort',
    all: 'All',
    reset: 'Clear filters',
    noResults: 'No funds match these filters.',
    noResultsHint: 'Try a simpler search or clear the filters.',
    showing: 'Showing {n} funds',
    code: 'Code',
    name: 'Fund',
    size: 'Size',
    investors: 'Investors',
    price: 'Price',
    composition: 'Holdings',
    return1w: '1 Week',
    return1m: '1 Month',
    return3m: '3 Months',
    return6m: '6 Months',
    return1y: '1 Year',
    volatility: 'Volatility',
    maxDrawdown: 'Max drawdown',
    riskLabel: 'Annualised volatility',
    back: 'All funds',
    portfolio: 'Portfolio breakdown',
    portfolioOverTime: 'How the breakdown changed',
    assetClass: 'Asset class',
    weight: 'Weight',
    share: 'Share',
    holdings: 'What this fund owns',
    holdingsNote:
      'The individual securities the fund holds — the actual shares, bonds and ' +
      'certificates. TEFAS publishes only asset-class percentages; this comes ' +
      'from the monthly portfolio report the fund files with KAP.',
    holdingsAsOf: 'From the {period} KAP filing',
    holdingsSource: 'Source: KAP portfolio distribution report',
    security: 'Security',
    issuer: 'Issuer',
    holdingsMissing: 'No holdings list for this fund yet.',
    holdingsMissingWhy:
      'This list comes from the portfolio report each fund files monthly with KAP. ' +
      'This fund’s report has either not been processed yet or was not filed in a ' +
      'readable form — some managers upload it as a scanned image.',
    holdingsCount: '{n} positions',
    holdingsMore: 'Show all ({n})',
    holdingsLess: 'Show fewer',
    holdingsOtherFund: 'fund',
    holdingsVersus: 'compared with {period}',
    holdingsPrevMonth: 'Last month',
    holdingsDiff: 'Change',
    holdingsDiffUnit: 'Change (pts)',
    holdingsHidden: '+{n} more positions',
    holdingsNoneMatch: 'No positions match this filter.',
    holdingsNewTitle: 'This position was not in last month’s filing.',
    holdingsDelayTitle: 'Exchange data is 15 minutes delayed.',
    hg_equityTr: 'Turkish Shares',
    hg_equityFx: 'Foreign Shares',
    hg_funds: 'ETFs / Funds',
    hg_debt: 'Debt Instruments',
    hg_lease: 'Lease Certificates',
    hg_metals: 'Precious Metals',
    hg_derivatives: 'Derivatives / VİOP',
    hg_cash: 'Cash, Deposits and Repo',
    hg_other: 'Other',
    move_all: 'All',
    move_up: 'Up',
    move_down: 'Down',
    move_new: 'New',
    holdingsFlagged:
      "The report's own percentages do not reach 100% ({total}). Every row and " +
      'subtotal reconciles, so the gap is in the filing rather than in our reading.',
    lastPrice: 'Last price',
    dayChange: 'Today',
    liveToday: 'Estimated move · today',
    liveLastSession: 'Estimated move · last session',
    livePriced: 'Share of portfolio priced',
    livePositions: 'Positions priced',
    liveLevered: 'This fund borrows to hold more shares than it has net assets, which is why the priced share passes 100%.',
    liveNote:
      'The latest market move on the positions in the filing, weighted by how much ' +
      'of the portfolio each one is. Anything the exchange does not price — bonds, ' +
      'deposits, fund units — is treated as unchanged, and the fund may have traded ' +
      'since it filed. TEFAS publishes fund prices a business day late, so this move ' +
      "has not reached the fund's published price yet. In short: this is the move in " +
      'what the fund holds, not the price it is about to publish.',
    liveTooLittle:
      'Only {n} of this portfolio can be priced on the exchange — too little to ' +
      "estimate the fund's day from, so no figure is given.",
    liveNonePriced:
      'None of what this fund holds trades on a market we can price — Borsa ' +
      'İstanbul and the US.',
    liveUnavailable:
      'Live prices could not be fetched just now; the table shows the filed values only.',
    liveWeightsOff:
      'This filing’s weights do not add up to a portfolio, so no day estimate was ' +
      'computed. The prices on each row are still live.',
    liveAsOf: '{market} {time}',
    liveDelayed: '{n} min delayed',
    liveClosedLabel: 'Market',
    liveClosed: 'closed',
    market_bist: 'Borsa İstanbul',
    market_us: 'US markets',
    liveSessionOpen: 'open',
    liveSessionShut: 'closed',
    liveSessions: 'Sessions: {list}',
    liveFxNote:
      'Foreign shares trade in dollars, so their lira value carries both the ' +
      "share's move and the dollar's.",
    liveSourceHead: 'Prices: ',
    liveSourceTail: ' · market data is {n} minutes delayed',
    loading: 'Loading…',
    loadError: 'Could not load data.',
    retry: 'Try again',
    notFound: 'Fund not found.',
    negativeNote:
      'This fund reports negative repo (it is borrowing). The bar shows positive holdings only; the table gives the true values.',
    benchmarkFund: 'Fund',
    dataSource: 'Source: TEFAS',
    updated: 'Updated {date}',
    indexedNote: 'Indexed so that {date} = 100',
    noHistory: 'Not enough history for this fund.',
    tableView: 'Table view',
    perYear: 'per year',
    sortSize: 'Size',
    sortName: 'Name',
    sortRet1m: '1-month return',
    sortRet3m: '3-month return',
    sortRet6m: '6-month return',
    sortRet1y: '1-year return',
    sortInvestors: 'Investor count',
    sortRisk: 'Volatility (lowest first)',
    sortExcess: 'Excess return vs money market',
    sortRatio: 'Excess return per unit of risk',
    sortFlow30: '30-day net inflow',
    sortInvestors30: '30-day investor growth',

    // preferences
    prefs: 'Preferences',
    riskTolerance: 'Risk tolerance',
    riskUpTo: 'Up to level {n}',
    horizon: 'Horizon',
    taxPref: 'Withholding',
    taxDefault: 'By fund type',
    taxNone: 'Gross (untaxed)',
    onlyBeatsCash: 'Only funds that beat the money market',
    onlyNewFunds: 'Only new funds',
    onlyLevered: 'Funds using leverage',
    leverageChip: 'Leverage {n}×',
    leverageNote:
      'This fund borrows — usually through repo — to invest more than it owns. ' +
      'Leverage multiplies the losses as well as the gains. The multiple comes from ' +
      'the allocation the fund reports to TEFAS: the borrowing shows up as a ' +
      'negative line and the positive lines then add up to more than 100%. Leverage ' +
      'taken through VİOP futures is not in this figure — a futures position is ' +
      "reported against the portfolio's value, not the contract's size.",
    // --- crash protection ---
    navCrash: 'Market falls',
    crashTitle: 'Crash protection',
    crashLede:
      'BIST 100 fell at least 10% {n} times in the last {y} years. This page shows ' +
      'what every fund did between exactly those dates. Return tables flatter ' +
      'everyone in a rising market; what separates funds shows on the way down.',
    crashEyebrow: '{n} falls in {y} years',
    crashSpared: 'Fall avoided',
    crashSparedNote:
      'How much of the market’s fall you were spared. 100% means the fund held its ' +
      'value; 0% means it fell just as far; above 100% means it rose while the index ' +
      'dropped; below zero means it fell further. The single figure is the median of ' +
      'the falls rather than a compounded one, because compounding lets a single ' +
      'extraordinary window carry the score. The money-market return is taken off ' +
      'both sides. Two cautions: this rewards not being in the market almost as much ' +
      'as it rewards defending well — money-market funds score 100 every time — and a ' +
      'median says nothing about the worst case, which is the figure beside it.',
    crashFund: 'Fund',
    crashBench: 'BIST 100',
    crashCovered: 'Falls covered',
    crashCoveredNote:
      'The fund was around for {n} of the {of} falls measured. Both figures cover ' +
      'only those, against what the index lost over the same ones — a fund launched ' +
      'later is not held to the falls it never saw.',
    crashWorst: 'Worst fall',
    crashPeriod: 'Period',
    crashThisFund: 'This fund',
    crashSection: 'When the market fell',
    crashNotEnough:
      'This fund is not old enough to have lived through two of the falls measured, ' +
      'and one fall is an anecdote rather than a record.',
    crashLagNote:
      'TEFAS publishes a fund’s price one business day after the market day it ' +
      'reflects, so both ends of every fall are read from the first price published ' +
      'after that date.',
    crashDays: '{n} days',
    onlyCrashProof: 'Held their value through the falls',
    onlyCrashProofNote:
      'The fund’s price did not fall across the measured BIST falls taken together. ' +
      'Falling less than the index is not enough — it has to have not fallen.',
    sortCrash: 'Crash protection',
    crashChip: 'Crash protection {n}',
    crashEmpty: 'No fund with a fall record is left under these filters.',
    crashMeasured: 'The falls measured',
    crashBest: 'Held up best',
    crashFell: 'Fell hardest',
    crashFellNote:
      'The worst outcomes over the same falls. A fund can have an excellent ' +
      'long-run return and still be on this list — it says what you had to sit ' +
      'through to collect it.',
    crashCash: 'Money market',
    crashCashNote:
      'The money-market figure beside each fall is what the median TRY money-market ' +
      'fund returned between the same two prices, and it is taken off both the fund ' +
      'and the index. Without it a fund holding nothing but repo would look like it ' +
      'had defended the portfolio brilliantly: over a two-month window the deposit ' +
      'rate alone adds several per cent.',
    crashFundsSeen: 'Funds measured',
    // --- themes and dividends ---
    themeLabel: 'Sector theme',
    themeHint:
      'Worked out from the fund’s individual shares rather than from the asset-class ' +
      'split TEFAS publishes, so it exists only for funds whose KAP portfolio report ' +
      'could be read.',
    themeShare: 'At least',
    themeShareOf: 'At least {n}% of the fund',
    themeSection: 'What it is invested in',
    themeNote:
      'Each of the fund’s shares is filed under one theme, from how its exchange ' +
      'classifies it, and the weights are shares of the whole fund — the same scale ' +
      'as the composition bar. The themes do not overlap, so they add up. An ' +
      'exchange-traded fund is not a company and carries no theme.',
    themeCovered: '{n}% of the shares classified',
    themeNone: 'This fund’s KAP portfolio report could not be read, so there is no theme breakdown.',
    themeBanks: 'Banking',
    themeFinance: 'Finance (non-bank)',
    themeRealEstate: 'Real estate',
    themeDefence: 'Defence & aerospace',
    themeSemis: 'Semiconductors',
    themeTech: 'Technology & software',
    themeTelecom: 'Telecoms & media',
    themeEnergy: 'Energy',
    themeMetals: 'Mining & metals',
    themeIndustrial: 'Industry & machinery',
    themeConstruction: 'Construction',
    themeAutos: 'Automotive',
    themeChemicals: 'Chemicals',
    themeFood: 'Food, drink & farming',
    themeRetail: 'Retail',
    themeHealth: 'Health',
    themeTransport: 'Transport',
    themeTourism: 'Tourism & leisure',
    themeTextile: 'Textiles & clothing',
    dividendLabel: 'Dividend yield',
    dividendAtLeast: 'At least {n}%',
    dividendStat: 'Portfolio dividend',
    dividendNote:
      'What the shares this fund holds paid in dividends over the last year, as a ' +
      'share of the fund. It is not a payment to you: Turkish funds do not ' +
      'distribute, so the dividend stays inside the unit price. TEFAS publishes no ' +
      'distribution field anywhere, so this is computed from the shares in the KAP ' +
      'report.',
    dividendVsMarket: 'BIST 100 yields {n}% itself',
    dividendSection: 'Dividends',
    sortDividend: 'Dividend yield',
    // --- dashboard ---
    // --- shares ---
    navShares: 'Shares',
    company: 'Company',
    return1d: 'Today',
    win1d: 'Today',
    win1m: '1M',
    win3m: '3M',
    win6m: '6M',
    win1y: '1Y',
    watchPerTile: 'Each box, its own window',
    watchNoSession: 'not trading',
    shareNotFound: 'There is no listing with the code {code}.',
    kindEtf: 'Exchange-traded fund',
    kindTrust: 'Investment trust',
    themeOther: 'Other',
    navMarket: 'Market',
    marketChart: 'Index, gold, dollar, euro',
    marketMap: 'The market map',
    marketMapNote: 'The largest {n} companies. Box size is market value, colour is today, grouped by line of business.',
    searchFunds: 'Search this list',
    searchNoHits: 'No matches',
    searchFundKind: 'Fund',
    searchShareKind: 'Share',
    fundsInTheme: '{name} funds →',
    fund: 'Fund',
    themeAny: 'All themes',
    showMore: 'Show more',
    shareSearch: 'Search shares',
    shareCount: '{n} shares',
    heldOnly: 'Only ones funds hold',
    sharesUnavailable: 'No share data yet.',
    sharesStamp: 'Prices are {n} minutes delayed. The other figures are from the last close.',
    sharesClose: 'Close of {date}. No live price this session.',
    marketCap: 'Market cap',
    peRatio: 'P/E',
    peNote: 'Price over the last twelve months of earnings per share. Empty for a company making a loss.',
    pbRatio: 'P/B',
    pbNote: 'Market value over book value.',
    psRatio: 'P/S',
    evEbitda: 'EV/EBITDA',
    eps: 'Earnings per share',
    epsNote: 'Last twelve months, diluted.',
    epsGrowth: 'EPS growth',
    dividendYield: 'Dividend yield',
    payout: 'Payout ratio',
    payoutNote: 'The share of earnings paid out as dividends.',
    dps: 'Dividend per share',
    shareYieldNote: 'Dividends paid over the last twelve months against today’s price.',
    revenue: 'Revenue',
    netIncome: 'Net income',
    ebitda: 'EBITDA',
    freeCashFlow: 'Free cash flow',
    fcfNote: 'Cash from operations less capital spending.',
    grossMargin: 'Gross margin',
    operatingMargin: 'Operating margin',
    netMargin: 'Net margin',
    roe: 'Return on equity',
    roeNote: 'Net income over shareholders’ equity.',
    roic: 'Return on invested capital',
    debtEquity: 'Debt / equity',
    debtEquityNote: 'Total borrowings against shareholders’ equity.',
    currentRatio: 'Current ratio',
    totalDebt: 'Total debt',
    staff: 'Employees',
    shareValuation: 'Valuation and dividend',
    shareBusiness: 'The business',
    shareTrading: 'Price and trading',
    sharePriceChart: 'Price against the index',
    volume: 'Volume (shares)',
    avgVolume: '10-day average',
    avgVolumeNote: 'Average shares traded over the last ten days.',
    relVolume: 'Relative volume',
    relVolumeNote: 'Today’s volume against the ten-day average. Above 1 means busier than usual.',
    volatility1m: 'Volatility (monthly)',
    shareVolNote: 'Standard deviation of daily moves over the last month.',
    beta: 'Beta',
    betaNote: 'How far the share moves when the index moves 1%. Above 1 is sharper than the market.',
    rsi: 'RSI',
    rsiNote: '14-day relative strength. Above 70 reads as overbought, below 30 as oversold.',
    sma50: '50-day average',
    sma200: '200-day average',
    smaNote: 'Whether the price sits above or below its own average, read as a trend.',
    freeFloat: 'Free float',
    floatNote: 'The share of the capital that trades freely on the exchange.',
    sharesOut: 'Shares outstanding',
    range52: '52 weeks',
    // --- portfolio ---
    navPortfolio: 'Portfolio',
    portfolio: 'Portfolio',
    portfolioEmpty: 'Nothing here yet.',
    portAddCode: 'Code',
    portAddButton: 'Add',
    portAddUnknown: 'No fund or share with that code.',
    portAddNoUnits: 'Say how many units you bought.',
    posAdded: 'Added',
    posSince: 'since {date}',
    posSinceShort: 'Since added',
    posUnits: 'Units',
    posUnitsHint: 'How many units you hold',
    posCostHint: 'A buy with no price recorded is valued at the price on its own day.',
    posAvg: 'Average cost',
    posLots: 'Buys and sells',
    posLotCount: '{n} entries',
    posLotRemove: 'Delete this entry',
    posBuy: 'Buy',
    posSell: 'Sell',
    posAdd: 'Add',
    posSellAll: 'sell all',
    posHeld: '{n} units',
    posUnitPrice: 'Unit price',
    posUnitPriceHint: 'What one unit cost you. Not the total.',
    posSellPrice: 'Sale price',
    posSellPriceHint: 'What one unit sold for.',
    posRealised: '{v} realised',
    posPrice: 'Price now',
    posValue: 'Value',
    posProfit: 'Profit / loss',
    posAssumed: 'assumed cost',
    // --- totals ---
    portTotalValue: 'Total value',
    portTotalCost: 'Total cost',
    portProfit: 'Profit / loss',
    portVsCash: 'The same money, in cash',
    portVsCashGap: 'Gap',
    portCounted: '{n} of {of} positions valued',
    portNoBasis: '{n} positions have no known cost and are left out of the profit.',
    portSpecValue: 'Your money in them',
    portMix: 'What you actually hold',
    portMixNote:
      'Each fund’s own composition, weighted by how much of it you hold. Unlike ' +
      'the equal-weighted version on the dashboard, this is your real mix.',
    portSpec: 'Exposure to speculative shares',
    portSpecNote: 'What your funds hold in shares with a speculative profile, weighted by your money.',
    // --- look-through ---
    portLook: 'What you actually own',
    portLookConc: 'Effective positions',
    portLookConcHint:
      'The number of equal-sized positions that would be exactly this concentrated. ' +
      'Thirty holdings that are really one bet come out near one.',
    portLookEquity: 'Among the shares',
    portLookEquityHint: 'Counted over shares alone. Bonds, deposits and metals are left out.',
    portLookNames: 'Distinct positions',
    portLookPosition: 'Position',
    portLookValue: 'Your money',
    portLookWeight: 'Share',
    portLookVia: 'Through',
    portLookDirect: 'Held directly',
    portLookUncovered: '{v} could not be opened up: those funds have no KAP filing.',
    portLookUnnamed: '{v} was filed with no code and is not pooled with the same holding elsewhere.',
    portLookHidden: 'Showing the largest {n} positions.',
    // --- saved screens ---
    screenName: 'Screen name',
    screenSave: 'Save',
    screenCopy: 'Copy link',
    screenCopied: 'Copied',
    screenDelete: 'Remove',
    // --- comparison ---
    compare: 'Compare',
    compareN: 'Compare ({n})',
    compareAdd: 'Add to comparison',
    compareRemove: 'Remove from comparison',
    comparePickTwo: 'Pick at least two funds to compare.',
    compareUnknown: 'No fund has that code.',
    compareFull: 'At most {n} funds can be compared at once.',
    compareChart: 'Indexed to 100 from the same day',
    compareMix: 'What each one holds',
    compareFigures: 'The figures',
    compareOverlap: 'Are they the same thing',
    compareNoShared: 'No position is held by more than one of them.',
    compareUnfiled: '{n} of them have no readable KAP filing and are not in this table.',
    // --- annualised rate and fees ---
    portRate: 'Annualised rate',
    portRateHint:
      'The internal rate of return (XIRR), weighted by how long each purchase ' +
      'has been in. Money in for a year does not count the same as money in for a fortnight.',
    portRatePartial: 'Over {n} of {of} positions; those with no known cost are left out.',
    portFees: 'What the fees have taken',
    portFeesNote:
      'Not a bill: a fund’s expense ratio is deducted inside the unit price, so this ' +
      'has already been paid. Charged against the mean of what you paid and what you hold.',
    portFeesTotal: 'So far',
    portFeesYears: '{n} yr',
    portFeesPartial: '{n} positions publish no expense ratio and are left out.',
    // --- withholding ---
    portTax: 'If you sold today',
    portTaxGain: 'Gain on paper',
    portTaxDue: 'Withheld',
    portTaxNet: 'What reaches you',
    portTaxHint:
      'Each position that is up is taxed at its own rate. Positions at a loss are ' +
      'not set against them: whether they can be depends on your whole year, which ' +
      'this page does not know.',
    portTaxNote:
      'A hisse senedi yoğun fon is exempt outright, with no holding period. That is ' +
      'read from the official fund title TEFAS publishes, not inferred. Funds exempt ' +
      'after a year under a 51% izahname commitment are not detected here and show ' +
      'as taxed. The rates are assumptions, not tax advice.',
    portTaxPartial: '{n} positions have no known cost or are not funds, and are left out.',
    taxPrefNote:
      'Turkish fund gains carry two rates: 17.5% and nothing. A hisse senedi yoğun ' +
      'fon is exempt with no holding period, read from the fund’s official title. ' +
      'Check the izahname on KAP to be certain.',
    taxBucket_exempt: 'Equity-intensive — exempt',
    taxBucket_standard: 'Taxed',
    posHeldDays: '{n} days',
    posTurnsOn: 'Turns a year on {date}.',
    posOverYear: 'Held for more than a year.',
    // --- consistency ---
    consistency: 'How often it beat the money market',
    consistencyHint:
      'Of every window of this length starting anywhere in the history, how many ' +
      'the fund finished ahead of money-market funds. Windows overlap, so this is ' +
      'a hit rate rather than the result of a significance test.',
    consistencyOf: '{n} of {of} windows',
    consistencyMedian: 'median {v}',
    consistencyNote:
      'One period’s return can be luck; finishing ahead in window after window is ' +
      'harder to arrive at by accident. The median gap says the fund did better ' +
      'than that in half its windows and worse in the other half.',
    // --- real terms ---
    realTerms: 'Real',
    realTermsHint:
      'Restates every lira figure in the latest published year’s money. The index ' +
      'is annual: nothing is interpolated inside a year, so each period is ' +
      'deflated at its own year’s figure. The index is an annual average.',
    realTermsNote: 'In {year} lira, using World Bank CPI.',
    realTermsPartial:
      '{n} of the periods shown fall after {year}; there is no index for them yet, so they are left nominal.',
    // --- since your last visit ---
    sinceVisit: 'Since you last looked',
    sinceVisitDays: '{n} days',
    sinceVisitMedian: 'Median of your funds',
    sinceVisitHint:
      'The median return of the funds you follow over this gap. Not the average: ' +
      'in a list of a handful, one fund jumping says nothing about the rest.',
    sinceVisitOf: '{n} funds',
    sinceVisitBest: 'Best',
    sinceVisitWorst: 'Worst',
    sinceVisitNew: 'New funds',
    // --- moving together ---
    portTogether: 'Are these different bets',
    portTogetherBets: 'Independent positions',
    portTogetherHint:
      'The more alike your funds’ daily returns are, the fewer bets the portfolio ' +
      'behaves like. Two Turkish equity funds are one bet even if they hold no ' +
      'share in common: the panel above says what you own twice, this one says ' +
      'what moves together.',
    portTogetherOf: 'of {n} funds',
    portTogetherAvg: 'Average correlation',
    portTogetherPartial: '{n} positions have too little shared price history.',
    portOnlyWatching: 'Watching only',
    portHolding: 'Held',
    portRing: 'Where your money is',
    portToday: 'Since the last close',
    portTodayNote: 'Shares live, funds at the last price TEFAS published.',
    portOthers: 'Others ({n})',
    portRingPartial: '{v} left out: no previous close.',
    // --- speculative boards ---
    specPanel: 'Speculative profile',
    specChip: 'Speculative profile',
    specNote:
      'All of these are figures the exchange publishes, and each sits in the ' +
      'most extreme tenth of Borsa İstanbul. They are not a claim about the ' +
      'company or about anybody trading it: they say this price would be easy ' +
      'to move and has little in the accounts to argue with. This is the ' +
      'picture the market calls a “tahta”.',
    specMet: '{n} of {of} conditions',
    specFlagRunUp: 'Sharp run-up',
    specFlagThinFloat: 'Thin free float',
    specFlagConcentrated: 'One fund holds a large stake',
    specFlagNoEarnings: 'No earnings behind the price',
    specFlagRichBook: 'Far above book value',
    specFlagViolent: 'Violent daily moves',
    specFlagRunUpNote: 'An extraordinary rise over the last year, or over the last quarter.',
    specFlagThinFloatNote: 'Less than a quarter of the shares trade on the exchange.',
    specFlagConcentratedNote: 'A single fund holds at least a twentieth of the whole company.',
    specFlagNoEarningsNote: 'The company loses money, or the price is over a hundred years of profit.',
    specFlagRichBookNote: 'Worth at least ten times the equity on its own books.',
    specFlagViolentNote: 'Daily swings twice the exchange’s median.',
    // --- the fund side ---
    specFundPanel: 'Shares with a speculative profile',
    specFundClean: 'No shares with a speculative profile',
    // The conditions live on the share pages, not this one, so the fund-page note
    // cannot say "above" — it has to name them.
    specFundNote:
      'How much of the fund’s filed equity meets these conditions: a sharp run-up, ' +
      'plus at least two more of a thin free float, one fund holding a large stake, ' +
      'no earnings behind the price, a price far above book value, and violent daily ' +
      'moves. Each share’s own page says which. An index fund may not have chosen ' +
      'them — it holds what the index holds — but its investor is exposed to those ' +
      'prices either way.',
    specWeight: 'Of the portfolio',
    specOfEquity: 'Of its equity',
    specCount: 'How many',
    specFilter: 'Speculative shares',
    specFilterNone: 'Holds none',
    specFilterAtLeast: 'At least {n}%',
    specFilterNoneChip: 'Holds no speculative shares',
    specFilterNote:
      'Covers funds whose KAP filing could be read and which hold shares. A fund ' +
      'whose filing could not be read is not counted as holding none: unknown is not clean.',
    specNoneFlagged:
      'This fund holds shares, and none of them meets the conditions for a ' +
      'speculative profile: a sharp run-up plus at least two more of the conditions ' +
      'listed on each share’s own page.',
    // --- the statements ---
    financials: 'Financial statements',
    financialsNote:
      'The company’s own reported figures, in unadjusted lira. Turkey has ' +
      'applied inflation accounting since 2023: a 2019 lira and a 2026 lira are ' +
      'not the same lira, so treat distant years with care.',
    periodQuarter: 'Quarterly',
    periodTtm: 'Trailing 12 months',
    periodYear: 'Annual',
    periodLabel: 'Period',
    metricLabel: 'Line',
    grossProfit: 'Gross profit',
    capex: 'Capital spending',
    latestPeriod: 'Latest period',
    yoyChange: 'Year on year',
    ofRevenue: 'Of revenue',
    noStatements: 'No financial statements are published for this company.',
    statementTable: 'Period by period',
    ttmNote: 'Four consecutive quarters added together, which is what removes the season.',
    // --- balance sheet ---
    shareBalance: 'Balance sheet',
    totalAssets: 'Total assets',
    totalLiabilities: 'Total liabilities',
    totalEquity: 'Shareholders’ equity',
    cashHeld: 'Cash and equivalents',
    shortTermDebt: 'Short-term debt',
    longTermDebt: 'Long-term debt',
    netDebt: 'Net debt',
    netDebtNote: 'Borrowings less cash. Below zero means the company holds more cash than debt.',
    netCash: 'Net cash',
    netDebtEbitda: 'Net debt / EBITDA',
    netDebtEbitdaNote: 'How many years of current operating profit it would take to repay the debt.',
    bookValuePerShare: 'Book value per share',
    nYears: '{n} years',
    // --- analysts ---
    shareAnalysts: 'What analysts expect',
    coverage: 'Covered by',
    priceTarget: 'Price target',
    targetUpside: 'Distance to target',
    targetRange: 'Target range',
    analystNote: 'Twelve-month targets and ratings from the brokers covering it. A forecast, not a promise.',
    ratingBuy: 'Buy',
    ratingHold: 'Hold',
    ratingSell: 'Sell',
    noAnalysts: 'No analyst covers this share.',
    // --- financial strength ---
    shareHealth: 'Financial strength',
    altmanZ: 'Altman Z',
    altmanNote: 'A bankruptcy-risk score. Above 2.99 is safe, below 1.81 is distressed. Not defined for banks.',
    piotroskiF: 'Piotroski F',
    piotroskiNote: 'How many of nine accounting tests it passes. Seven and up is strong, three and under weak.',
    bandSafe: 'strong',
    bandGrey: 'grey zone',
    bandDistress: 'weak',
    // --- dividends ---
    shareDividends: 'Dividend history',
    dpsByYear: 'Dividend per share, by year',
    dividendStreak: 'Unbroken run',
    lastExDate: 'Last ex-dividend date',
    noDividends: 'This company has no recorded dividend payment.',
    dpsNote: 'In the lira of the year declared. A bonus issue divides the per-share amount.',
    // --- forecasts ---
    shareEstimates: 'Forecast against reported',
    estimateActual: 'Reported',
    estimateForecast: 'Forecast',
    surprise: 'Surprise',
    beatCount: 'Above forecast in {b} of {n} quarters',
    awaitingReport: 'Not yet reported',
    estimatesNote:
      'Brokers’ quarterly revenue forecasts against what the company reported. ' +
      'Revenue only: the same source’s earnings-per-share figures do not agree ' +
      'with the company’s own statements, so they are not published here.',
    // --- peers ---
    sharePeers: 'Companies in the same line',
    peersNote:
      'The largest companies in the same industry. Industry rather than sector: ' +
      '“Finance” holds both a bank and a property trust, and their multiples have ' +
      'nothing to say to each other.',
    industryMedian: 'Median',
    thisCompany: 'This company',
    noPeers: 'No other company in this industry to compare it with.',
    // --- market and calendar ---
    marketStars: 'Star Market',
    marketMain: 'Main Market',
    marketSub: 'Sub Market',
    marketPre: 'Pre-Market Trading Platform',
    marketFunds: 'Funds Market',
    marketWatch: 'Watchlist Market',
    marketWatchNote: 'Companies on this market trade under special exchange supervision.',
    nextReport: 'Next results',
    revenuePerStaff: 'Revenue per employee',
    dividendYears: 'Unbroken dividends',
    // --- who owns it ---
    shareOwners: 'Which funds hold it',
    shareOwnersNote:
      'From the fund portfolios filed with KAP. This is the funds’ share of the ' +
      'company; individuals, foreign investors and the founding families hold the rest.',
    shareNoOwners: 'No fund reports holding this share.',
    heldByFunds: 'Funds holding',
    heldValue: 'Held by funds',
    fundOwned: 'Of the company',
    fundOwnedNote: 'Shares held by funds against the company’s total shares outstanding.',
    byValue: 'By value',
    byValueNote: 'The same sum in lira: value held against market cap. The two should agree.',
    addedBy: '{n} funds added',
    trimmedBy: '{n} trimmed',
    ofCompared: '· of the {n} that filed a comparable position',
    noComparable: 'No previous weights fit to compare against.',
    ownWeight: 'Weight in fund',
    ownWeightNote: 'How much of that fund’s portfolio the share is.',
    ownMove: 'Change',
    ownMoveNote: 'Change in that weight since the previous filing, in percentage points.',
    navDash: 'Dashboard',
    dashPopular: 'Money in this week',
    dashFlowOut: 'Money out this week',
    dashFavourites: 'Your funds',
    dashFlowWeek: '{n} in',
    dashFlowWeekOut: '{n} out',
    flowIn: 'In',
    flowOut: 'Out',
    flowDirection: 'Direction of money',
    // --- overlap ---
    dashOverlap: 'Portfolio overlap',
    overlapNote:
      'From the KAP filings of the funds you follow. What two funds hold in ' +
      'common is not a second position: that much of it is one company, held ' +
      'under two names.',
    overlapPair: '{n}% the same',
    overlapShared: 'In both',
    overlapClean: 'The funds you follow do not repeat each other.',
    // --- against cash ---
    vsCashHead: 'Against the money market',
    vsCashMedian: 'Median of your funds',
    vsCashHurdle: 'Money market',
    vsCashGap: 'Gap',
    vsCashAhead: '{n} of {of} ahead',
    // --- the market ---
    dashThemes: 'Themes today',
    themesNote: 'What each theme did today, weighted by market value.',
    dashMovers: 'Movers today',
    trendPanel: 'Trending',
    trendWindow: 'past week',
    trendSectors: 'Sectors',
    trendShares: 'Shares',
    moversNote:
      'Within the BIST 100. The biggest movers on the whole exchange are ' +
      'always its smallest listings, and they are not what the day was about.',
    moversUp: 'Gainers',
    moversDown: 'Fallers',
    awaitingQuotes: 'Waiting for prices…',
    dashLast: 'Last price',
    dashLastNote:
      'The most recent published change in the NAV. It runs one business day ' +
      'behind, so today’s market is not in it.',
    dashLive: 'Live',
    dashLiveHead: 'Estimated from what the fund’s shares are trading at now',
    dashLiveNote: '{n}% of the portfolio could be priced',
    dashLiveNone:
      'No live estimate for this fund: its portfolio report could not be read, too ' +
      'little of it can be priced, or its weights do not reconcile.',
    dashMore: 'All of them →',
    watchPanel: 'What you follow',

    watchNoneHint: 'No starred funds yet — showing this week’s inflows.',
    stanceLabel: 'Stance',
    stanceAggressive: 'Aggressive',
    stanceBalanced: 'Balanced',
    stanceDefensive: 'Defensive',
    maxFeeLabel: 'Expense ratio cap',
    feeUpTo: 'Up to {n}%',

    // navigation
    navFunds: 'Funds',
    navPopular: 'Popular',
    navFavorites: 'Favourites',
    searchShort: 'Search funds and shares',
    searchHint: 'Fund code, ticker or name',
    openMenu: 'Menu',

    // market tape
    marketTape: 'Markets',
    tapeClose: '{date} close',
    tapeLive: 'Live · {time}',
    tapeLiveOne: 'Live price',
    tapeCloseOne: '{date} close',
    tapeDayChange: 'Daily change',
    tapeSource: 'Live prices: {name}',
    tapeFallback: 'Live prices unavailable — showing closing values.',
    hurdleMark: 'hurdle',
    hurdleTitle: 'Every fund in this app is judged against this return.',
    bist100: 'BIST 100',
    bist30: 'BIST 30',
    usdtry: 'USD/TRY',
    eurtry: 'EUR/TRY',
    goldgram: 'Gram Gold',
    mmf: 'Money Market',

    // toolbar
    filterButton: 'Filters',
    filterCount: '{n} filters',
    clearAll: 'Clear all',
    industryTotalShort: 'Industry',
    lastMove: 'Last move',
    highlights: 'Funds in focus',
    highlightsNote: 'Biggest net inflow over the past 30 days',
    seeAll: 'See all',

    // favourites
    favoriteAdd: 'Add to favourites',
    favoriteRemove: 'Remove from favourites',
    favorites: 'Your favourites',
    favoritesEmpty: 'You have not added any favourites yet.',
    favoritesHint:
      'Tap the star in any fund or share list to add one. Favourites are stored in this browser only.',
    favoritesCount: '{n} favourite funds',
    favouriteShares: 'Your shares',
    favoritesCountBoth: '{f} funds · {s} shares',

    // popular
    popular: 'Popular funds',
    popularNote:
      'The funds taking in the most money and investors lately. This measures attention, not quality — an inflow is not evidence that a fund is good.',
    popularRiskNote:
      'Funds traded on TEFAS with a risk value of {n} and above only. Money-market and short-term debt funds are left out.',
    popularRiskShort: 'Risk {n}+ · traded on TEFAS',
    popularFlow: 'Biggest net inflow (30 days)',
    popularInvestors: 'Most new investors (30 days)',
    popularNew: 'Recently launched funds',
    flowNote:
      'Net inflow is the part of the change in portfolio size that the price move does not explain: a fund that grew because its price doubled took in nothing.',
    shareOfSize: 'Share of size',
    launched: 'Age',
    ageDays: '{n} days',
    noneYet: 'Not enough data for this ranking.',

    // quality
    quality: 'Quality signals',
    vsCash: 'vs money market',
    vsCashTitle: 'Compared with money-market funds',
    vsCashNote:
      'Both returns cover the same period and are net of withholding. The difference is in percentage points, not per cent.',
    vsCashMore: '{period}: {code} earned {n} more than money-market funds.',
    vsCashLess: '{period}: {code} earned {n} less than money-market funds.',
    vsCashSame: '{period}: {code} matched money-market funds.',
    vsCashUnavailable: 'No comparison is available for this period.',
    thisFund: 'This fund (after tax)',
    cashBenchmark: 'Money-market funds',
    difference: 'Difference',
    points: 'pts',
    vsPeers: 'vs peers',
    peerGroup: 'Peer group',
    peerMedian: 'Peer median',
    ratioLabel: 'Excess return per unit of risk',
    riskLevel: 'Risk value',
    riskLevelOfficial: 'TEFAS fund risk value (1–7)',
    volBand: 'Volatility band',
    qualifiedOnly: 'Qualified investors only',
    qualifiedNote:
      'Funds with a TEFAS risk value of 7 may only be sold to qualified investors.',
    hideQualified: 'Hide qualified-investor-only funds',
    tradeableOnly: 'Only funds traded on TEFAS',
    platformStatus: 'Platform status',
    tefasTraded: 'Traded on TEFAS',
    tefasNotTraded: 'Not traded on TEFAS',
    platformUnknown: 'Platform status unknown',
    mgmtFee: 'Management fee',
    maxMgmtFee: 'Prospectus cap',
    expenseRatio: 'Total expense ratio',
    feeNote: 'Annual, per cent',
    returnYtd: 'Year to date',
    return3y: '3 Years',
    return5y: '5 Years',
    sortFee: 'Total expense ratio (lowest first)',
    sortRetYtd: 'Year-to-date return',
    rangeLabel: 'Range',
    rangeAll: 'All',
    chartHint: 'Hover the chart or use the arrow keys to read values.',
    chartPanel: 'Price & comparison',
    seriesLabel: 'Series',
    pickAtLeastOne: 'Tick at least one series to draw the chart.',
    nativeNote: 'Showing {name} in its own units. Tick a second series to compare.',
    tooShortForRange: 'Not enough data for this range.',
    flagBeatsCash: 'Beats cash',
    flagBeatsCashNo: 'Below cash',
    flagBeatsPeers: 'Above peers',
    flagBeatsPeersNo: 'Below peers',
    flagDrawdown: 'Contained drawdown',
    flagDrawdownNo: 'Deep drawdown',
    flagShortHistory: 'Short history',
    flagSmallFund: 'Small fund',
    cashHurdle:
      '{period}: money-market funds returned {n}%. Any fund below that lost against the risk-free alternative.',
    cashHurdleUnknown:
      'No money-market comparison could be computed for this period, so the ranking and the excess-return column stay empty.',

    // prediction
    prediction: 'Estimated current value',
    predictionNote:
      'TEFAS publishes prices one business day late. This estimate applies the fund’s own sensitivity to how BIST, gold, the dollar and cash have moved since its last published price.',
    predictedChange: 'Estimated change since the last published price',
    predictedPrice: 'Estimated price',
    predictionRange: 'from moves between {from} and {to}',
    explained: 'Explained',
    explainedNote: 'How much of the fund’s daily movement these four benchmarks account for',
    lowConfidence:
      'This fund’s movement is poorly explained by market benchmarks (R² {n}), so no estimate is shown.',
    exposureModel: 'Market sensitivity',
    alpha: 'Alpha (annualised)',
    alphaNote: 'Return not explained by market sensitivity',
    turnover: 'Allocation shift',
    turnoverNote: 'Average weekly portfolio reshuffle',
    flow30: '30-day net inflow',
    investors30: '30-day investor change',
    newFund: 'New fund',
  },
};

/** Look up a string and interpolate `{name}` placeholders. */
export function t(lang, key, vars) {
  let s = STRINGS[lang]?.[key] ?? STRINGS.tr[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

/** Pick the display label from a {tr, en} pair, falling back to Turkish. */
export const label = (obj, lang) => (obj ? (obj[lang] ?? obj.tr ?? obj.en ?? '') : '');

// ---------------------------------------------------------------- horizons

/**
 * The return windows the app can reason about, in order.
 *
 * One list drives the horizon selector, the table's return column, the cash
 * hurdle and the sort options — so choosing "3 months" cannot end up comparing a
 * 3-month fund return against a 1-year benchmark.
 *
 * `days` is null for year-to-date, which is anchored to a calendar date rather
 * than a lookback.
 */
export const HORIZONS = [
  { key: 'm1', days: 30, labelKey: 'return1m', sortKey: 'ret1m' },
  { key: 'm3', days: 91, labelKey: 'return3m', sortKey: 'ret3m' },
  { key: 'm6', days: 182, labelKey: 'return6m', sortKey: 'ret6m' },
  { key: 'ytd', days: null, labelKey: 'returnYtd', sortKey: 'retYtd' },
  { key: 'y1', days: 365, labelKey: 'return1y', sortKey: 'ret1y' },
];

export const horizonOf = (key) => HORIZONS.find((hz) => hz.key === key) ?? HORIZONS.at(-1);

// ---------------------------------------------------------------- text

const TR_FOLD = {
  ı: 'i', İ: 'i', ş: 's', Ş: 's', ğ: 'g', Ğ: 'g',
  ü: 'u', Ü: 'u', ö: 'o', Ö: 'o', ç: 'c', Ç: 'c', â: 'a', î: 'i', û: 'u',
};

/**
 * Fold Turkish text for search so "sise" matches "ŞİŞE" and vice versa.
 * Diacritic-insensitive in both directions, which is what users expect when
 * typing fund names on an English keyboard.
 */
export function fold(s) {
  return String(s ?? '')
    .replace(/[ıİşŞğĞüÜöÖçÇâîû]/g, (c) => TR_FOLD[c])
    .toLowerCase()
    .trim();
}

/**
 * Tiers a query can match a code or a name in, best first.
 *
 * They are the whole ranking: an exact code beats a code that starts with the
 * query, which beats a name that starts with it, which beats either merely
 * containing it. Named rather than left as bare numbers because the caller sorts
 * on them and a reader should not have to guess what 3 means.
 */
export const MATCH = {
  code: 0,
  codeStart: 1,
  nameStart: 2,
  codeIn: 3,
  nameIn: 4,
};

/**
 * A matcher for a typed query, or null when there is nothing to match on.
 *
 * The query is folded ONCE and the returned function folds each candidate, so
 * every search in the app agrees about what "ısı" and "ISI" and "ışı" mean.
 * That agreement is the point of putting this here: the share list matched with
 * `toLocaleUpperCase('tr')` instead, which turns a typed "ism" into "İSM" — the
 * dotted capital — and then finds nothing in ISMEN. Turkish is the one language
 * where upper-casing a search box quietly breaks it.
 *
 * @param {string} query what the reader typed
 * @param {{min?: number}} [opts] shortest folded query worth matching
 * @returns {((code: string, name: string) => number|null)|null}
 */
export function queryMatcher(query, { min = 1 } = {}) {
  const q = fold(query);
  if (q.length < min) return null;

  return (code, name) => {
    const c = fold(code);
    const n = fold(name);
    if (c === q) return MATCH.code;
    if (c.startsWith(q)) return MATCH.codeStart;
    if (n.startsWith(q)) return MATCH.nameStart;
    if (c.includes(q)) return MATCH.codeIn;
    if (n.includes(q)) return MATCH.nameIn;
    return null;
  };
}

// ---------------------------------------------------------------- treemap

/**
 * The worst aspect ratio in a row, given the strip it is being laid along.
 *
 * This is the whole of the squarified algorithm's judgement: a row is worth
 * extending while adding the next rectangle makes its worst tile *less* oblong,
 * and is closed the moment it would make it more so.
 */
function worstRatio(areas, total, short) {
  if (!areas.length || total <= 0 || short <= 0) return Infinity;
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  const s2 = short * short;
  const t2 = total * total;
  return Math.max((s2 * max) / t2, t2 / (s2 * min));
}

/**
 * Squarified treemap: rectangles proportional to weight, as close to square as
 * the shape allows.
 *
 * Bruls, Huizing and van Wijk's algorithm, which exists because the naive
 * slice-and-dice layout produces slivers — and a market map made of slivers
 * cannot be read or clicked. Kept here rather than in the UI because it is
 * arithmetic over rectangles with no opinion about markets, and because a layout
 * that silently overlaps or overflows is exactly the kind of thing a test should
 * catch rather than an eye.
 *
 * @param {object[]} items anything, so long as `weightOf` finds a number
 * @param {{x:number,y:number,w:number,h:number}} rect the box to fill
 * @param {(item:object)=>number} [weightOf]
 * @returns {object[]} one `{item, x, y, w, h}` per item with a positive weight,
 *   largest first
 */
export function squarify(items, rect, weightOf = (d) => d.weight) {
  const rows = (items ?? [])
    .map((item) => ({ item, weight: weightOf(item) }))
    .filter((d) => Number.isFinite(d.weight) && d.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  const total = rows.reduce((sum, d) => sum + d.weight, 0);
  if (!rows.length || total <= 0 || !(rect?.w > 0) || !(rect?.h > 0)) return [];

  // Weights are converted to areas once, so the arithmetic below never has to
  // know what a weight meant.
  const scale = (rect.w * rect.h) / total;
  const queue = rows.map((d) => ({ item: d.item, area: d.weight * scale }));
  const out = [];
  let free = { ...rect };

  while (queue.length && free.w > 1e-9 && free.h > 1e-9) {
    const short = Math.min(free.w, free.h);
    const row = [];
    let rowArea = 0;

    while (queue.length) {
      const next = queue[0];
      const areas = row.map((c) => c.area);
      const now = row.length ? worstRatio(areas, rowArea, short) : Infinity;
      const then = worstRatio([...areas, next.area], rowArea + next.area, short);
      if (row.length && then > now) break;
      row.push(queue.shift());
      rowArea += next.area;
    }

    // The row is laid across the shorter side, which is what keeps the tiles
    // square: the thickness follows from the area it has to hold.
    const thickness = rowArea / short;
    const horizontal = free.w <= free.h;
    let offset = 0;
    for (const cell of row) {
      const length = cell.area / thickness;
      out.push(horizontal
        ? { item: cell.item, x: free.x + offset, y: free.y, w: length, h: thickness }
        : { item: cell.item, x: free.x, y: free.y + offset, w: thickness, h: length });
      offset += length;
    }

    free = horizontal
      ? { x: free.x, y: free.y + thickness, w: free.w, h: free.h - thickness }
      : { x: free.x + thickness, y: free.y, w: free.w - thickness, h: free.h };
  }

  return out;
}

// ------------------------------------------------------------ the ring
//
// The portfolio's donut. Here for the same reason squarify() is: it is
// arithmetic over a circle with no opinion about money, and a label column that
// silently overlaps itself is exactly the kind of thing a test should catch
// rather than an eye.

/** A full circle in radians. Angles here are turns, which is the readable unit. */
export const TURN = Math.PI * 2;

/**
 * The two layouts, and every number in one of them is relative to another.
 *
 * The wide one spends its sides on labels around the ring. The tight one has no
 * room for them, so it drops them, hands the naming to the legend underneath,
 * and spends the width it saves on a bigger ring instead of on empty margins.
 */
export const ringGeometry = (tight) => (tight
  ? { w: 320, h: 320, cx: 160, cy: 160, outer: 146, inner: 104, bend: 0, label: 0 }
  : { w: 600, h: 352, cx: 300, cy: 172, outer: 132, inner: 96, bend: 147, label: 164 });

/** A tenth of a unit is plenty of precision in a path, and keeps the markup readable. */
export const svgN = (n) => Math.round(n * 10) / 10;

/** A point on a circle, measured in turns clockwise from twelve o'clock. */
export const ringPoint = (g, r, turn) => [
  g.cx + r * Math.sin(turn * TURN),
  g.cy - r * Math.cos(turn * TURN),
];

/** One slice of the ring: out along one radius, round, and back along the other. */
export function ringPath(g, from, to) {
  const wide = to - from > 0.5 ? 1 : 0;
  const [x1, y1] = ringPoint(g, g.outer, from);
  const [x2, y2] = ringPoint(g, g.outer, to);
  const [x3, y3] = ringPoint(g, g.inner, to);
  const [x4, y4] = ringPoint(g, g.inner, from);
  return `M${svgN(x1)} ${svgN(y1)}`
    + `A${g.outer} ${g.outer} 0 ${wide} 1 ${svgN(x2)} ${svgN(y2)}`
    + `L${svgN(x3)} ${svgN(y3)}`
    + `A${g.inner} ${g.inner} 0 ${wide} 0 ${svgN(x4)} ${svgN(y4)}Z`;
}

/**
 * Push a column of labels apart so two neighbouring slices do not print on top
 * of each other.
 *
 * A pass down the column opens every gap to the minimum; if that runs the last
 * label off the bottom, the whole column shifts up and a pass back up reopens
 * the gaps it just closed. Two thin slices side by side is the normal case
 * rather than the exception — a portfolio is usually one or two big holdings
 * and a row of small ones.
 */
export function spreadLabels(items, gap, top, bottom) {
  items.sort((a, b) => a.y - b.y);
  for (let i = 1; i < items.length; i++) {
    items[i].y = Math.max(items[i].y, items[i - 1].y + gap);
  }
  const over = items.length ? items.at(-1).y - bottom : 0;
  if (over > 0) {
    for (const it of items) it.y -= over;
    for (let i = items.length - 2; i >= 0; i--) {
      items[i].y = Math.min(items[i].y, items[i + 1].y - gap);
    }
  }
  for (const it of items) it.y = Math.max(it.y, top);
  return items;
}

// ---------------------------------------------------------------- formatting

const nf = new Map();
function numberFormat(lang, opts) {
  const key = lang + JSON.stringify(opts);
  if (!nf.has(key)) nf.set(key, new Intl.NumberFormat(lang === 'tr' ? 'tr-TR' : 'en-US', opts));
  return nf.get(key);
}

export function fmtNum(n, lang = 'tr', digits = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  return numberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

export function fmtInt(n, lang = 'tr') {
  if (n == null || !Number.isFinite(n)) return '—';
  return numberFormat(lang, { maximumFractionDigits: 0 }).format(n);
}

const SCALES = {
  tr: [
    [1e12, 'tn'],
    [1e9, 'mr'],
    [1e6, 'mn'],
    [1e3, 'b'],
  ],
  en: [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ],
};

/** Compact Turkish-lira amount, e.g. "₺216,9 mr". Fund sizes reach trillions. */
export function fmtMoney(n, lang = 'tr') {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  for (const [factor, suffix] of SCALES[lang] ?? SCALES.tr) {
    if (abs >= factor) {
      // Always one decimal: ₺216,9 mr and ₺217,3 mr must stay distinguishable,
      // otherwise sorting the list by size shows a column of identical numbers.
      return `${sign}₺${fmtNum(abs / factor, lang, 1)} ${suffix}`;
    }
  }
  return `${sign}₺${fmtNum(abs, lang, 0)}`;
}

/**
 * Percentage, Turkish-style ("%12,5") or English ("12.5%").
 *
 * With `signed`, the value is prefixed by an arrow so direction is carried by a
 * glyph as well as by colour — required for the red/green return cells.
 */
export function fmtPct(n, lang = 'tr', { signed = false, digits = 2 } = {}) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (!signed) {
    // Turkish puts the percent sign first, but the minus stays ahead of it:
    // "-%25,2", never "%-25,2".
    if (lang !== 'tr') return `${fmtNum(n, lang, digits)}%`;
    return `${n < 0 ? '-' : ''}%${fmtNum(Math.abs(n), lang, digits)}`;
  }
  const arrow = n > 0 ? '▲' : n < 0 ? '▼' : '·';
  const abs = fmtNum(Math.abs(n), lang, digits);
  return lang === 'tr' ? `${arrow} %${abs}` : `${arrow} ${abs}%`;
}

/**
 * The gap between two percentages, in percentage POINTS.
 *
 * A fund returning 52% against a 48% benchmark did not beat it "by 4%" — it beat
 * it by 4 points, and printing that difference with a percent sign is the single
 * easiest way to mislead someone reading a comparison. So the unit is spelled out.
 */
export function fmtPoints(n, lang = 'tr', { signed = false, digits = 1, unit = true } = {}) {
  if (n == null || !Number.isFinite(n)) return '—';
  // A column of these states the unit once in its heading, so repeating it in
  // every cell only makes the column too wide to fit.
  const suffix = unit ? ` ${t(lang, 'points')}` : '';
  const abs = fmtNum(Math.abs(n), lang, digits);
  if (!signed) return `${n < 0 ? '-' : ''}${abs}${suffix}`;
  const arrow = n > 0 ? '▲' : n < 0 ? '▼' : '·';
  return `${arrow} ${abs}${suffix}`;
}

export function fmtDate(iso, lang = 'tr') {
  if (!iso) return '—';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === 'tr' ? 'tr-TR' : 'en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(d);
}

/** Sign class for return values. Paired with an arrow glyph, never colour alone. */
export const signOf = (n) => (n == null || !Number.isFinite(n) ? 'flat' : n > 0.0001 ? 'up' : n < -0.0001 ? 'down' : 'flat');

// ---------------------------------------------------------------- parsing

/** Parse newline-delimited JSON, skipping blank or truncated lines. */
export function parseJsonl(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A partially-written trailing line should not discard the whole file.
    }
  }
  return out;
}

// ---------------------------------------------------------------- filtering

/**
 * @typedef {object} FundQuery
 * @property {string} [search]
 * @property {string[]} [kinds]
 * @property {string[]} [categories]
 * @property {string[]} [founders]
 * @property {string} [exposure]   group id that must exceed `minExposure`
 * @property {number} [minExposure] percentage, default 50
 * @property {number} [minSize]    minimum portfolio size in TRY
 * @property {number} [maxRisk]    highest acceptable risk value, 1–7
 * @property {boolean} [beatsCash] keep only funds scoring above the cash hurdle
 * @property {boolean} [retailOnly] drop funds restricted to qualified investors
 * @property {boolean} [tradeableOnly] keep only funds buyable on TEFAS
 * @property {boolean} [onlyNew]  keep only funds launched inside the data window
 * @property {string} [stance]    'aggressive' | 'balanced' | 'defensive'
 * @property {number} [maxFee]    highest acceptable total expense ratio, per cent
 * @property {string[]} [codes]   restrict to an explicit set of fund codes
 * @property {boolean} [crashProof] keep only funds that held their value through
 *   the measured BIST falls
 * @property {string} [theme]     keep only funds with a real position in this
 *   line of business — one of THEME_IDS
 * @property {number} [minTheme]  the share of the fund that counts as a position
 * @property {number} [minDividend] lowest acceptable portfolio dividend yield
 */

/**
 * Above this multiple of net assets a fund is called levered.
 *
 * Not 1.0: composition weights are published to two decimals and a fund can
 * round its way to 100.4% without having borrowed anything. 5% is where
 * borrowing is a decision rather than an artefact.
 *
 * It lives here rather than in analytics.js because `filterFunds` is what reads
 * it, and core.js imports nothing.
 */
export const LEVERED_FROM = 1.05;

/**
 * The lines of business a fund can be filtered by, in display order.
 *
 * Ours, not a standard: TradingView files the shares Turkish funds hold under
 * 102 industries, and a filter with 102 entries is not a filter. The grouping
 * from industry to theme lives in scripts/lib/taxonomy.mjs, which is build-only;
 * this list is what the UI offers and where the labels are. The two must stay in
 * step, and a test asserts they do.
 *
 * `banks` sits apart from `finance` because Turkish funds are sold on that
 * distinction — there are bank-sector funds and the exchange runs bank indices —
 * and the themes are a partition, so nothing is counted twice.
 */
export const THEME_IDS = [
  'banks', 'finance', 'realEstate', 'defence', 'semis', 'tech', 'telecom',
  'energy', 'metals', 'industrial', 'construction', 'autos', 'chemicals',
  'food', 'retail', 'health', 'transport', 'tourism', 'textile',
];

/**
 * Default share of a fund a theme must reach before the fund counts as being in
 * it. Ten per cent, not fifty like the asset-class filter: a fund with a tenth
 * of its money in defence is running a defence position on purpose, while a
 * fund with half is a defence fund and there are only a handful. The UI offers
 * the tighter thresholds too.
 */
export const MIN_THEME = 10;


/**
 * At or above this share of the market's fall avoided, a fund is called one that
 * held its value.
 *
 * 100 is not an arbitrary line: `spared` is one minus the fund's return over the
 * index's, and both are negative through a fall, so exactly 100 is the point
 * where the fund's own return crosses zero. Below it the fund lost money, above
 * it the fund made money — while the market was falling. Anything else would be
 * a taste dressed up as a threshold.
 */
export const CRASH_PROOF_FROM = 100;

/** The "holds none of them" setting, kept out of the numeric thresholds. */
export const SPEC_NONE = 'none';

/**
 * The thresholds the speculative filter offers, in per cent of the portfolio.
 * Read as "at least", which is what the labels say and what the filter tests.
 *
 * 25 is SPECULATIVE_HEAVY from analytics.js, so that step lands exactly on the
 * threshold that paints a fund's own panel red: a reader who picks it gets the
 * funds the panel calls heavy, no more and no fewer. It is repeated rather than
 * imported because core.js imports nothing, and a test asserts the two stay in
 * step.
 */
export const SPEC_STEPS = [5, 10, 25, 50];

/**
 * How much of itself a fund must hold in shares before "holds none" means
 * anything.
 *
 * Without it the answer is 397 funds, most of them bond and money-market funds
 * carrying a rounding error's worth of equity. A fund that is 2% shares has not
 * avoided these companies; it has avoided the stock market.
 */
export const SPEC_MIN_EQUITY = 5;

/** Apply the filter bar to the fund index. Pure; returns a new array. */
export function filterFunds(funds, query = {}) {
  const {
    search, kinds, categories, founders, exposure, minExposure = 50, minSize,
    maxRisk, beatsCash, retailOnly, tradeableOnly, onlyNew, stance, maxFee, codes,
    levered, crashProof, theme, minTheme = MIN_THEME, minDividend, speculative,
  } = query;
  const needle = search ? fold(search) : null;
  const kindSet = kinds?.length ? new Set(kinds) : null;
  const catSet = categories?.length ? new Set(categories) : null;
  const founderSet = founders?.length ? new Set(founders) : null;
  // A present-but-empty code list means "nothing selected", not "no restriction".
  const codeSet = codes ? new Set(codes) : null;

  return funds.filter((f) => {
    if (codeSet && !codeSet.has(f.c)) return false;
    if (kindSet && !kindSet.has(f.k)) return false;
    if (catSet && !catSet.has(f.cat)) return false;
    if (founderSet && !founderSet.has(f.f)) return false;
    if (minSize != null && (f.sz ?? 0) < minSize) return false;
    if (exposure && (f.g?.[exposure] ?? 0) < minExposure) return false;
    if (onlyNew && f.new !== true) return false;
    if (stance && f.stance !== stance) return false;
    // Gross exposure past the threshold means the fund borrows to hold more than
    // it owns. An unknown composition is not a yes, same as the other filters.
    if (levered && !(f.lev > LEVERED_FROM)) return false;
    // A fund too young to have been measured is not a fund that held its value.
    if (crashProof && !(f.cr?.s >= CRASH_PROOF_FROM)) return false;
    // Themes and dividends come from the KAP filings, so a fund whose filing
    // could not be read drops out of these two rather than passing unchecked.
    // The UI says so where the controls are, because the alternative is a filter
    // that silently answers over half the universe.
    if (theme && !((f.th?.[theme] ?? 0) >= minTheme)) return false;
    if (minDividend != null && !(f.dy >= minDividend)) return false;
    // Both directions read `spec`, which is absent for a fund whose filing could
    // not be read AND for one that holds no shares at all. Neither has been
    // cleared of anything, so "none" needs a fund that was actually looked at
    // and found to hold shares — the same rule as the fee cap, where an unknown
    // fee is not a cheap one.
    //
    // "None" is the empty holdings list, never `w === 0`: the weight is rounded
    // to two decimals, so a fund holding 0.004% of a flagged share rounds to a
    // clean zero while its own page lists that share. The page and the filter
    // have to answer the same question off the same fact.
    if (speculative === SPEC_NONE
      && !(f.spec && !f.spec.codes?.length && f.spec.equity >= SPEC_MIN_EQUITY)) return false;
    if (typeof speculative === 'number' && !(f.spec?.w >= speculative)) return false;
    // An unknown fee cannot satisfy a fee cap: the whole point of the cap is to
    // exclude funds you would be overpaying, and "unknown" is not "cheap".
    if (maxFee != null && (f.expenseRatio == null || f.expenseRatio > maxFee)) return false;
    // Unrated funds are excluded by a risk cap rather than silently kept: an
    // unknown risk is not the same as an acceptable one.
    if (maxRisk != null && (f.risk == null || f.risk > maxRisk)) return false;
    // TEFAS risk value 7 means qualified investors only — a legal restriction,
    // so it is filtered on the official value, never on a derived one.
    if (retailOnly && f.risk === 7) return false;
    // Only `true` counts as tradeable. An unknown status is not a yes — a fund
    // you cannot actually buy has no business topping a "worth buying" list.
    if (tradeableOnly && f.tefas !== true) return false;
    if (beatsCash && !(f._score?.excess > 0)) return false;
    if (needle) {
      // Code first: typing "AAK" should not be beaten by a name substring.
      if (!fold(f.c).includes(needle) && !fold(f.n).includes(needle) && !fold(f.f).includes(needle)) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Sort keys the UI exposes, mapped to their accessor.
 *
 * `excess` and `ratio` read `_score`, which the caller attaches before sorting —
 * those values depend on the user's tax and horizon preferences, so they cannot
 * be baked into the data file.
 */
export const SORTS = {
  size: (f) => f.sz ?? -Infinity,
  name: (f) => f.n ?? '',
  investors: (f) => f.iv ?? -Infinity,
  ret1m: (f) => f.r?.m1 ?? -Infinity,
  ret3m: (f) => f.r?.m3 ?? -Infinity,
  ret6m: (f) => f.r?.m6 ?? -Infinity,
  ret1y: (f) => f.r?.y1 ?? -Infinity,
  risk: (f) => (f.vol == null ? Infinity : f.vol),
  excess: (f) => f._score?.excess ?? -Infinity,
  ratio: (f) => f._score?.ratio ?? -Infinity,
  retYtd: (f) => f.r?.ytd ?? -Infinity,
  flow30: (f) => f.fl30 ?? -Infinity,
  investors30: (f) => f.iv30 ?? -Infinity,
  age: (f) => f.age ?? Infinity,
  // Unmeasured funds sort last in a "best protected first" list rather than
  // sitting above funds with a real record.
  crash: (f) => f.cr?.s ?? -Infinity,
  dividend: (f) => f.dy ?? -Infinity,
  // Unknown fees sort last in an ascending "cheapest first" list rather than
  // masquerading as free.
  fee: (f) => (f.expenseRatio == null ? Infinity : f.expenseRatio),
};

/**
 * Which of a row of values wins, when funds are put side by side.
 *
 * Returned as a set of indexes rather than one, because a tie is a real answer:
 * two funds charging the same fee are equally cheap and marking one of them the
 * winner would be inventing a difference. A row where every value is the same is
 * nobody's win, and neither is a row with only one fund in it — highlighting the
 * sole value as "best" says nothing.
 *
 * `dir` is which direction is better: 'high' for a return, 'low' for a fee. A
 * maximum drawdown is 'high', because -4% is a better result than -22%.
 *
 * It has no default, and that is the point. Defaulting to 'high' meant a row
 * that simply forgot to say — a unit price, a fund's size, its volatility — got
 * a tick beside its largest value, and `undefined` silently took the default
 * while an explicit `null` did not. Saying which way is better is now the
 * caller's job, and a row that has no answer marks nothing.
 *
 * @returns {Set<number>} indexes of the winning values
 */
export function bestIndexes(values, dir = null) {
  // A measure with no better direction marks nothing. Most of the rows in a
  // comparison are like that — a unit price, a fund's size, its investor count,
  // its volatility — and defaulting them to "highest wins" would put a tick
  // beside the biggest fund as though bigger were a result.
  if (dir !== 'high' && dir !== 'low') return new Set();
  const usable = [];
  for (let i = 0; i < (values?.length ?? 0); i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) usable.push([i, v]);
  }
  if (usable.length < 2) return new Set();
  const best = usable.reduce((acc, [, v]) =>
    (dir === 'low' ? Math.min(acc, v) : Math.max(acc, v)), usable[0][1]);
  const winners = usable.filter(([, v]) => v === best);
  // Every fund tying is not a comparison, so nothing is marked.
  if (winners.length === usable.length) return new Set();
  return new Set(winners.map(([i]) => i));
}

/** Sort a fund list. `dir` is 'asc' | 'desc'. Pure; returns a new array. */
export function sortFunds(funds, key = 'size', dir = 'desc') {
  const get = SORTS[key] ?? SORTS.size;
  const sign = dir === 'asc' ? 1 : -1;
  return [...funds].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (typeof x === 'string' || typeof y === 'string') {
      return String(x).localeCompare(String(y), 'tr') * sign;
    }
    if (x === y) return String(a.c).localeCompare(String(b.c), 'tr');
    return (x < y ? -1 : 1) * sign;
  });
}

// ---------------------------------------------------------------- real terms
//
// Every lira series on a share page is nominal, and saying so in a note was
// never enough: the twenty-year dividend chart has fifteen invisible bars
// because a 2005 lira is 27 of today's, and a reader looking at it concludes the
// company stopped paying.
//
// The deflator is annual, because the only free, keyless, authoritative Turkish
// CPI is annual. That is a real constraint and the arithmetic here is shaped by
// refusing to paper over it:
//
//   - a figure is deflated at ITS OWN YEAR's index. Nothing is interpolated
//     inside a year, so four quarters of 2019 all carry 2019's index. Sliding
//     between two annual points to make quarters look smooth would be a
//     judgement no reader could see had been made.
//   - the series lags. A period after the last published year cannot be deflated
//     at all, and comes back untouched and flagged rather than deflated against
//     the newest year that happens to exist.

/**
 * A period label's year, or null.
 *
 * The statement periods arrive as ISO dates ("2026-03-31") and the chart labels
 * as short dates, so this reads the year off the front and accepts nothing else.
 */
export function yearOf(period) {
  const match = /^(\d{4})/.exec(String(period ?? ''));
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1900 && year <= 2999 ? year : null;
}

/**
 * One nominal lira figure restated in the latest published year's money.
 *
 * @param {number|null} value
 * @param {string|number} period anything carrying a four-digit year
 * @param {{years: Record<string, number>, latest: number}} cpi
 * @returns {{value:number|null, real:boolean}} `real` false means it could not
 *   be deflated and `value` is the untouched nominal figure
 */
export function deflate(value, period, cpi) {
  if (value == null || !Number.isFinite(value)) return { value, real: false };
  const year = yearOf(period);
  const base = cpi?.years?.[cpi?.latest];
  const then = year == null ? null : cpi?.years?.[year];
  // Past the last published year there is no index to deflate against. The
  // figure is returned as it came, and the caller marks it.
  if (!(base > 0) || !(then > 0)) return { value, real: false };
  return { value: (value * base) / then, real: true };
}

/**
 * A whole series deflated, keeping the shape the chart already expects.
 *
 * Returns the values in the same order with the same holes, plus how many could
 * be restated — a chart that silently mixed deflated and nominal bars would be
 * worse than one that was nominal throughout.
 *
 * @returns {{values:(number|null)[], real:boolean[], deflated:number, nominal:number}}
 */
export function deflateSeries(values, periods, cpi) {
  const out = [];
  const real = [];
  let deflated = 0;
  let nominal = 0;
  for (let i = 0; i < (values?.length ?? 0); i++) {
    const hit = deflate(values[i], periods?.[i], cpi);
    out.push(hit.value == null ? null : hit.value);
    real.push(hit.real);
    if (values[i] == null) continue;
    if (hit.real) deflated++;
    else nominal++;
  }
  return { values: out, real, deflated, nominal };
}

// ---------------------------------------------------------------- the screen
//
// A screen is the whole question the list is answering: what is being filtered,
// how it is ranked, and over which window and tax treatment. It used to live
// only in memory, which meant a reload lost it and there was no way to send
// anybody "risk 4 or under, defensive, beats cash, fee under 1.5%" — the sort of
// thing this site exists to let you find and therefore the sort of thing worth
// being able to hand to someone.
//
// It goes in the hash, after the route, so the URL stays the one piece of state
// that travels. Favourites deliberately do NOT: a favourites list is personal,
// and a link that quietly carried one would be a different thing entirely.
//
// Only what differs from the default is written, so an untouched list has a
// clean `#/fonlar` and every parameter present in a link is one somebody chose.

/** The boolean preferences, and the short tag each travels under. */
export const SCREEN_FLAGS = {
  cash: 'beatsCash',
  retail: 'retailOnly',
  tefas: 'tradeableOnly',
  new: 'onlyNew',
  lev: 'levered',
  crash: 'crashProof',
};

/** The three stances a fund can be filtered to. */
export const STANCES = ['aggressive', 'balanced', 'defensive'];

/**
 * A screen with nothing set.
 *
 * The single definition of "no filter". It used to be written twice in ui.js —
 * once building the state object and once in the reset — and the two had already
 * drifted: one carried an `exposure` key and the other did not.
 */
export function defaultScreen() {
  return {
    filters: {
      search: '', kinds: [], categories: [], founders: [],
      exposure: undefined, minExposure: undefined,
      theme: undefined, minTheme: undefined,
    },
    prefs: {
      tax: 'default', horizon: 'y1', maxRisk: null,
      beatsCash: false, retailOnly: false, tradeableOnly: false,
      onlyNew: false, stance: '', maxFee: null, levered: false, crashProof: false,
      minDividend: null, speculative: '',
    },
    sort: { key: 'size', dir: 'desc' },
  };
}

/**
 * Which keys a "clear all" clears.
 *
 * The tax treatment and the return window are not filters: they are how the list
 * is read, and clearing a filter chip has no business resetting them. This is
 * what keeps the reset honest about that.
 */
export const SCREEN_FILTER_PREFS = [
  'maxRisk', 'beatsCash', 'retailOnly', 'tradeableOnly', 'onlyNew', 'stance',
  'maxFee', 'levered', 'crashProof', 'minDividend', 'speculative',
];

/**
 * A screen as a query string — the part of the hash after `?`.
 *
 * @param {{filters?:object, prefs?:object, sort?:object}} screen
 * @returns {string} '' when nothing is set
 */
export function encodeScreen(screen) {
  const base = defaultScreen();
  const f = screen?.filters ?? {};
  const p = screen?.prefs ?? {};
  const s = screen?.sort ?? {};
  const q = new URLSearchParams();

  if (f.search) q.set('q', f.search);
  if (f.kinds?.length) q.set('kind', f.kinds.join(','));
  // Categories and managers are names out of meta.json, not a vocabulary this
  // file controls, so they get a parameter each rather than being joined on a
  // separator one of them could one day contain. No manager is called
  // "X, Y & Co" today; the encoding should not be what stops one from being.
  for (const cat of f.categories ?? []) q.append('cat', cat);
  for (const mgr of f.founders ?? []) q.append('mgr', mgr);
  if (f.exposure) {
    q.set('holds', f.exposure);
    // The threshold rides with the filter it belongs to, and only when it is not
    // the default — "in equities" at 50% is the filter, not a choice.
    if (f.minExposure != null && f.minExposure !== 50) q.set('holdsmin', String(f.minExposure));
  }
  if (f.theme) {
    q.set('theme', f.theme);
    if (f.minTheme != null && f.minTheme !== MIN_THEME) q.set('thememin', String(f.minTheme));
  }

  if (p.maxRisk != null) q.set('risk', String(p.maxRisk));
  if (p.maxFee != null) q.set('fee', String(p.maxFee));
  if (p.stance) q.set('stance', p.stance);
  if (p.minDividend != null) q.set('div', String(p.minDividend));
  if (p.speculative) q.set('spec', String(p.speculative));

  // One parameter for the six switches rather than six of `x=1`, which is both
  // shorter and readable at a glance in a pasted link.
  const on = Object.entries(SCREEN_FLAGS).filter(([, key]) => p[key]).map(([tag]) => tag);
  if (on.length) q.set('on', on.join(','));

  if (p.horizon && p.horizon !== base.prefs.horizon) q.set('hz', p.horizon);
  if (p.tax && p.tax !== base.prefs.tax) q.set('tax', p.tax);

  // The direction rides on the key, because a sort is one choice: `sort=fee-asc`
  // rather than a pair that can arrive half-set.
  if (s.key && (s.key !== base.sort.key || s.dir !== base.sort.dir)) {
    q.set('sort', s.dir === 'asc' ? `${s.key}-asc` : s.key);
  }
  // A comma is legal in a query value, and `on=retail,lev,crash` is the whole
  // point of packing the switches into one parameter — `on=retail%2Clev%2Ccrash`
  // is not a link anybody reads. Safe as a blanket replacement because nothing
  // here splits a value on a comma any more except the two closed vocabularies,
  // whose members cannot contain one.
  return q.toString().replace(/%2C/g, ',');
}

/**
 * A query string back into a screen, with everything it cannot vouch for dropped.
 *
 * A hash is typed, edited and truncated by hand, so nothing here trusts its
 * input: a value that is not one of the things the control could have produced
 * is discarded and the default stands. The alternative is a list silently
 * filtered by a category that does not exist, which looks exactly like a list
 * with no matches.
 *
 * Two things are deliberately NOT validated here, because core.js has no way to:
 * category names and manager names come from `meta.json`. An unknown one matches
 * no fund, which is the same visible outcome as a typo in the search box.
 */
export function decodeScreen(query) {
  const out = defaultScreen();
  if (!query) return out;
  const q = new URLSearchParams(String(query).replace(/^[?#]/, ''));
  const { filters: f, prefs: p, sort } = out;

  const list = (key) => (q.get(key) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  /** A number inside its own range, or null. Anything else is not a control value. */
  const num = (key, lo, hi) => {
    const raw = q.get(key);
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };

  f.search = q.get('q') ?? '';
  f.kinds = list('kind').filter((k) => k === 'YAT' || k === 'BYF');
  f.categories = q.getAll('cat').filter(Boolean);
  f.founders = q.getAll('mgr').filter(Boolean);

  const holds = q.get('holds');
  if (holds) {
    f.exposure = holds;
    f.minExposure = num('holdsmin', 0, 100) ?? undefined;
  }
  const theme = q.get('theme');
  if (theme && THEME_IDS.includes(theme)) {
    f.theme = theme;
    f.minTheme = num('thememin', 0, 100) ?? MIN_THEME;
  }

  p.maxRisk = num('risk', 1, 7);
  p.maxFee = num('fee', 0, 100);
  p.minDividend = num('div', 0, 100);
  const stance = q.get('stance');
  if (STANCES.includes(stance)) p.stance = stance;

  // "none" and a threshold are the same control, so they arrive under one key
  // and only the values the control actually offers are honoured.
  const spec = q.get('spec');
  if (spec === SPEC_NONE) p.speculative = SPEC_NONE;
  else if (spec != null && SPEC_STEPS.includes(Number(spec))) p.speculative = Number(spec);

  const on = new Set(list('on'));
  for (const [tag, key] of Object.entries(SCREEN_FLAGS)) if (on.has(tag)) p[key] = true;

  const hz = q.get('hz');
  if (hz && HORIZONS.some((h) => h.key === hz)) p.horizon = hz;
  // The tax control is either the published defaults or one flat rate somebody
  // typed. `taxRatesFor` already falls back safely, but an unrecognised value
  // would still sit in the URL and in the control looking like a setting.
  const tax = q.get('tax');
  if (tax === 'default') p.tax = tax;
  else if (tax != null && tax !== '' && Number(tax) >= 0 && Number(tax) <= 1) p.tax = tax;

  const raw = q.get('sort');
  if (raw) {
    const asc = raw.endsWith('-asc');
    const key = asc ? raw.slice(0, -4) : raw;
    if (Object.hasOwn(SORTS, key)) {
      sort.key = key;
      sort.dir = asc ? 'asc' : 'desc';
    }
  }
  return out;
}

// ---------------------------------------------------------------- holdings

/**
 * The buckets the holdings table groups rows under, and the colour each borrows
 * from the asset-class palette so a group reads the same here as in the bar.
 *
 * These are OUR names, not the filings'. Filers use around sixty different
 * group labels for the same dozen kinds of thing — "BORÇLANMA SENETLERİ",
 * "FİNANSMAN BONOLARI", "DEVLET TAHVİLİ VE", "DÖVİZE ENDEKSLİ TAHVİLLER" are all
 * debt — and a table with sixty headings is not a grouped table.
 */
export const HOLDING_GROUPS = [
  { id: 'equityTr', color: 'equity' },
  { id: 'equityFx', color: 'foreign' },
  { id: 'funds', color: 'other' },
  { id: 'debt', color: 'govDebt' },
  { id: 'lease', color: 'lease' },
  { id: 'metals', color: 'metals' },
  { id: 'derivatives', color: 'corpDebt' },
  { id: 'cash', color: 'cash' },
  { id: 'other', color: 'other' },
];

/**
 * Which bucket a holding belongs in.
 *
 * Matched on the uppercased text, because `/i` does not fold the Turkish dotted
 * İ in "HİSSE" onto an `i` while `toUpperCase` normalises both spellings.
 *
 * Anything unrecognised lands in `other` rather than being forced into a bucket
 * that looks plausible — the group heading is visible, so a misfiling would be
 * read as fact.
 */
export function holdingGroupOf(holding) {
  const group = String(holding?.group ?? '').toUpperCase();
  const subgroup = String(holding?.subgroup ?? '').toUpperCase();
  const both = `${group} ${subgroup}`;

  // Foreign shares first: they are also "HİSSE", so the general rule would
  // swallow them.
  if (/YABANCI/.test(both) && /H[İI]SSE/.test(both)) return 'equityFx';
  // Single-stock and index futures. The filings put them under "Kısa"/"Uzun"
  // (short/long) with a weight of zero, because a future's weight is stated
  // against the portfolio's value rather than the contract's size.
  // "VADELİ" is deliberately absent: it reads as "forward" but every row filed
  // under it is a time deposit ("Vadeli Mevduat YP gün 3"), so it belongs in cash.
  if (/^(KISA|UZUN|T[ÜU]REV|V[İI]OP)/.test(group)
    || /FORWARD|SWAP|OPS[İI]YON|\bCALL\b|\bPUT\b/.test(both)) {
    return 'derivatives';
  }
  if (/H[İI]SSE/.test(both) || /^(ÖD[ÜU]N[ÇC] ALMA|A[ÇC]I[ĞG]A SATI[ŞS])/.test(group)) return 'equityTr';
  // Fund units, Turkish or foreign, listed or not.
  if (/Y\.?\s*FONU|YATIRIM FONU|KATILMA BELGE|FON SEPET/.test(both)) return 'funds';
  if (/K[İI]RA SERT[İI]F[İI]KA/.test(both)) return 'lease';
  if (/D\.\s*MADEN|KIYMETL[İI] MADEN/.test(both)) return 'metals';
  // Debt before cash, because "DÖVİZE ENDEKSLİ TAHVİLLER" is an FX-indexed BOND
  // and the cash rule's "Döviz" would otherwise claim it. The reverse mistake is
  // not possible: no cash label carries a debt word.
  if (/BOR[ÇC]LANMA|TAHV[İI]L|BONO|EUROBOND|VARLI[ĞG]A DAYALI|HAZ[İI]NE|TAAHH[ÜU]T|YAPILANDIRILMI[ŞS]/.test(both)) {
    return 'debt';
  }
  if (/MEVDUAT|VADEL[İI]|KATIL(IM|MA)\s*HESA|REPO|PARA P[İI]YASASI|^TPP|TAKASBANK|D[ÖO]V[İI]Z|NAK[İI]T/
    .test(both)) {
    return 'cash';
  }
  return 'other';
}

/**
 * One row per position, because a filing is not one row per position.
 *
 * Managers split a single holding across several lines — a long and a short leg,
 * lots bought on different dates, a slice lent out — and a table that repeats
 * ASELS five times is answering a bookkeeping question rather than "what does
 * this fund own". The weights are summed, which is the fund's actual exposure.
 *
 * `prevWeight` is already the position's total in the data file, so it is taken
 * rather than summed: adding it up per row would multiply it by the split.
 *
 * @param {object[]} holdings rows from data/holdings/<CODE>.json
 * @returns {object[]} one row per position, weight-descending
 */
export function aggregateHoldings(holdings) {
  const byPosition = new Map();

  for (const holding of holdings ?? []) {
    const key = String(holding.isin || holding.code || '').trim().toUpperCase()
      || `#${byPosition.size}`;
    const held = byPosition.get(key);
    if (!held) {
      byPosition.set(key, {
        ...holding,
        weight: holding.weight ?? null,
        rows: 1,
        group: holdingGroupOf(holding),
        filedGroup: holding.group,
      });
      continue;
    }
    if (holding.weight != null) held.weight = (held.weight ?? 0) + holding.weight;
    // A split position keeps the longest name and any ISIN, since filers fill
    // those in on one line and leave the others blank.
    if ((holding.name?.length ?? 0) > (held.name?.length ?? 0)) held.name = holding.name;
    held.isin ??= holding.isin;
    held.rows++;
  }

  return [...byPosition.values()].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
}

/**
 * Aggregated positions arranged into display groups, heaviest group first.
 *
 * Group weight is the sum of everything in it, including rows the table may be
 * folding away, so a heading never disagrees with the portfolio.
 *
 * @returns {{id:string, color:string, weight:number, rows:object[]}[]}
 */
export function groupHoldings(positions) {
  const buckets = new Map();
  for (const spec of HOLDING_GROUPS) buckets.set(spec.id, { ...spec, weight: 0, rows: [] });

  for (const position of positions ?? []) {
    const bucket = buckets.get(position.group) ?? buckets.get('other');
    bucket.rows.push(position);
    bucket.weight += position.weight ?? 0;
  }

  return [...buckets.values()]
    .filter((bucket) => bucket.rows.length)
    .sort((a, b) => b.weight - a.weight);
}

// ---------------------------------------------------------------- composition

/**
 * Turn a group-mix object into drawable stacked segments.
 *
 * TEFAS reports repo as a negative percentage when a fund is borrowing, which a
 * stacked bar cannot express. Negative groups are dropped from the bar and the
 * remainder is rescaled to fill it; `hasNegative` lets the caller disclose that,
 * and the detail table still shows the true signed values.
 *
 * @returns {{segments: {id:string,pct:number,share:number}[], hasNegative:boolean, total:number}}
 */
export function compositionSegments(groupMix, groupOrder) {
  const order = groupOrder ?? Object.keys(groupMix ?? {});
  let hasNegative = false;
  const positives = [];
  let total = 0;

  for (const id of order) {
    const v = groupMix?.[id];
    if (v == null) continue;
    total += v;
    if (v < 0) {
      hasNegative = true;
      continue;
    }
    if (v > 0) positives.push({ id, pct: v });
  }

  const sum = positives.reduce((s, p) => s + p.pct, 0);
  const segments = sum > 0 ? positives.map((p) => ({ ...p, share: (p.pct / sum) * 100 })) : [];
  return { segments, hasNegative, total };
}

/**
 * Size-weighted composition across many funds — what the whole industry holds.
 * Weighting by portfolio size (not fund count) is what makes this meaningful:
 * one ₺200bn money-market fund matters more than fifty tiny ones.
 */
export function industryComposition(funds, groupOrder) {
  const totals = {};
  let aum = 0;
  for (const f of funds) {
    const size = f.sz;
    if (!size || size <= 0 || !f.g) continue;
    aum += size;
    for (const [id, pct] of Object.entries(f.g)) {
      totals[id] = (totals[id] ?? 0) + (pct / 100) * size;
    }
  }
  const mix = {};
  if (aum > 0) for (const [id, v] of Object.entries(totals)) mix[id] = (v / aum) * 100;
  return { mix, aum, ...compositionSegments(mix, groupOrder) };
}

/**
 * Expand a raw allocation object into labelled rows grouped by asset group,
 * for the fund detail table. Groups and rows are both sorted by weight.
 */
export function assetBreakdown(alloc, meta, lang = 'tr') {
  if (!alloc) return [];
  const byGroup = new Map();
  for (const [code, pct] of Object.entries(alloc)) {
    const asset = meta.assets?.[code];
    if (!asset || pct == null) continue;
    if (!byGroup.has(asset.group)) byGroup.set(asset.group, { id: asset.group, total: 0, rows: [] });
    const g = byGroup.get(asset.group);
    g.total += pct;
    g.rows.push({ code, pct, name: label(asset, lang) });
  }
  const order = new Map((meta.groups ?? []).map((g, i) => [g.id, i]));
  return [...byGroup.values()]
    .map((g) => ({
      ...g,
      name: label((meta.groups ?? []).find((x) => x.id === g.id), lang),
      rows: g.rows.sort((a, b) => b.pct - a.pct),
    }))
    .sort((a, b) => b.total - a.total || (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
}

// ---------------------------------------------------------------- metrics

/**
 * Percentage change between the last point and the closest point at or before
 * `days` ago.
 *
 * Returns null when the history is too short to answer honestly — a "1 year
 * return" computed from four months of data is worse than no number at all.
 *
 * @param {[string, number][]} series ascending [isoDate, value] pairs
 */
export function returnOver(series, days) {
  if (!series || series.length < 2) return null;
  const [lastDate, lastValue] = series[series.length - 1];
  if (!lastValue) return null;
  const lastTs = Date.parse(lastDate);
  const target = lastTs - days * 86400000;

  // Closest point to the target on either side — not the last point at or before
  // it. With exactly one year of history the earliest sample sits a day or two
  // *after* the 365-day mark, and a strict "at or before" rule would report null
  // for almost every fund's 1-year return.
  let pick = null;
  let bestDist = Infinity;
  for (const row of series) {
    const ts = Date.parse(row[0]);
    if (ts >= lastTs) break;
    if (row[1] == null || row[1] <= 0) continue;
    const dist = Math.abs(ts - target);
    if (dist < bestDist) {
      bestDist = dist;
      pick = row;
    }
  }
  if (!pick) return null;

  // Still refuse when the history genuinely does not cover the horizon.
  const span = (lastTs - Date.parse(pick[0])) / 86400000;
  if (span < days * 0.5) return null;
  return round2((lastValue / pick[1] - 1) * 100);
}

/**
 * Return since the start of the calendar year.
 *
 * The base is the last print *before* January 1st — the previous year's close —
 * because a series' first print of the new year already contains part of the
 * year's move. For a fund launched inside the year there is no prior close, so
 * its own first print is the only honest base.
 */
export function returnYtd(series) {
  if (!series || series.length < 2) return null;
  const [lastDate, lastValue] = series[series.length - 1];
  if (!lastValue) return null;
  const yearStart = `${lastDate.slice(0, 4)}-01-01`;

  let base = null;
  for (const [d, v] of series) {
    if (d >= yearStart) break;
    if (v != null && v > 0) base = v;
  }
  if (base == null) {
    const first = series.find(([d, v]) => d >= yearStart && v != null && v > 0);
    if (!first || first[0] === lastDate) return null;
    base = first[1];
  }
  return round2((lastValue / base - 1) * 100);
}

/** Return over one of the named HORIZONS, dispatching year-to-date correctly. */
export function returnForHorizon(series, key) {
  const hz = horizonOf(key);
  return hz.days == null ? returnYtd(series) : returnOver(series, hz.days);
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Annualised volatility (%) from daily values, using log returns. */
export function volatility(series, periodsPerYear = 252) {
  if (!series || series.length < 20) return null;
  const rets = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1][1];
    const b = series[i][1];
    if (!a || !b || a <= 0 || b <= 0) continue;
    rets.push(Math.log(b / a));
  }
  if (rets.length < 20) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return round2(Math.sqrt(variance) * Math.sqrt(periodsPerYear) * 100);
}

/** Largest peak-to-trough decline (%) over the series, as a negative number. */
export function maxDrawdown(series) {
  if (!series || series.length < 2) return null;
  let peak = -Infinity;
  let worst = 0;
  for (const [, v] of series) {
    if (!v || v <= 0) continue;
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.min(worst, v / peak - 1);
  }
  return worst === 0 ? 0 : round2(worst * 100);
}

/** Rebase a series so its first point equals `base`, for like-for-like charts. */
export function indexSeries(series, base = 100) {
  if (!series?.length) return [];
  const first = series.find(([, v]) => v != null && v > 0)?.[1];
  if (!first) return [];
  return series.filter(([, v]) => v != null && v > 0).map(([d, v]) => [d, (v / first) * base]);
}

/**
 * Restrict several date-keyed series to their shared date range and rebase each
 * to 100, so a fund and its benchmarks can share one axis.
 *
 * Two measures of different scale on one chart would need two y-axes; indexing
 * to a common base is how you avoid that.
 */
export function alignAndIndex(seriesMap, from) {
  const usable = Object.keys(seriesMap).filter((n) => seriesMap[n]?.length);
  if (!usable.length) return { dates: [], series: {} };

  // Every line must be rebased on the SAME date. The window therefore starts no
  // earlier than the latest first-observation among the series — otherwise a
  // benchmark whose history begins later would be indexed to 100 at a different
  // point than the fund, and the chart would overstate or understate it.
  const latestStart = usable.map((n) => seriesMap[n][0][0]).sort().at(-1);
  const start = from && from > latestStart ? from : latestStart;

  // Walk the full union first so a value from before `start` can be carried in;
  // slicing first would strand any series that has no print on the start date.
  const allDates = [...new Set(usable.flatMap((n) => seriesMap[n].map(([d]) => d)))].sort();

  const series = {};
  for (const n of usable) {
    const map = new Map(seriesMap[n]);
    let last = null;
    const filled = [];
    for (const d of allDates) {
      const v = map.get(d);
      if (v != null) last = v; // carry the previous close across holidays
      if (d >= start && last != null) filled.push([d, last]);
    }
    series[n] = indexSeries(filled);
  }
  return { dates: allDates.filter((d) => d >= start), series };
}
