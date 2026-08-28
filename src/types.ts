export type TradeType = 'BUY' | 'SELL';

/**
 * Where a value came from. Mirrors server/types.ts - keep both in sync.
 * REAL       - observed directly from Binance.
 * AGGREGATED - computed from REAL observations.
 * PROJECTED  - an extrapolation about a moment that has not happened yet.
 * HEURISTIC  - a hand-written rule, hardcoded constant or invented fallback.
 */
export type DataProvenance =
  | 'REAL'
  | 'AGGREGATED'
  | 'PROJECTED'
  | 'HEURISTIC'
  | 'STRATEGIC'
  | 'EXECUTABLE'
  | 'NOT_VERIFIABLE';

export interface DataWindow {
  sampleCount: number;
  fromTimestamp: number | null;
  toTimestamp: number | null;
  spanMinutes: number | null;
}

export interface Valued<T> {
  value: T;
  provenance: DataProvenance;
  reason?: string;
  dataWindow?: DataWindow;
}

export type BankFilterKey = 'ALL' | 'BANESCO' | 'PROVINCIAL' | 'MERCANTIL' | 'BNC' | 'BANCAMIGA' | 'VENEZUELA' | 'PAGO_MOVIL';
export type AmountFilterKey = 'ALL' | '10K' | '20K' | '30K' | '40K' | '50K' | '100K';

export interface GlobalFilterState {
  bank: BankFilterKey;
  bankDisplayName: string;
  amount: AmountFilterKey;
  amountVal: number | null;
}

/**
 * One payment method as Binance published it, kept VERBATIM.
 *
 * `payType` is the canonical machine code ('BBVAProvincial', 'PagoMovil'...)
 * and is the ONLY field bank verification is allowed to compare against.
 * `tradeMethodName` is the human-readable label; it exists for display and
 * for auditing what Binance actually sent, and matching on it would merge
 * banks that share a label.
 */
export interface AdPaymentMethod {
  payType: string | null;
  tradeMethodName: string | null;
}

/**
 * VERIFIED      - a payType matched a canonical bank code exactly.
 * NOT_VERIFIED  - the ad declares codes, none of them this bank's.
 * NOT_VERIFIABLE- the question cannot be answered: the ad carries no
 *                 canonical code, or the bank declares none. Never treated
 *                 as belonging to the bank.
 */
export type BankVerification = 'VERIFIED' | 'NOT_VERIFIED' | 'NOT_VERIFIABLE';

export interface NormalizedAd {
  advNo: string;
  price: number;
  minAmountVes: number;
  maxAmountVes: number;
  availableUsdt: number;
  /**
   * The volume Binance actually published, or null when it published none.
   * availableUsdt above collapses that null to 0 for backwards compatibility;
   * only this field can distinguish "no liquidity" from "liquidity unknown".
   */
  availableUsdtReported: number | null;
  merchantName: string;
  userType: string;
  ordersCount: number;
  finishRate: number;
  /**
   * Human-readable labels. UNCHANGED: existing consumers (OrderBookView)
   * still read this. Never used for bank verification.
   */
  paymentMethods: string[];
  /**
   * Binance's payment methods verbatim, canonical code included. This is what
   * bank verification compares against.
   */
  paymentOptions: AdPaymentMethod[];
}

export interface MarketSnapshot {
  timestamp: number;
  isoDate: string;
  asset: 'USDT';
  fiat: 'VES';
  filterBank?: string;
  filterBankName?: string;
  filterAmount?: number | null;
  filterAmountKey?: string;
  /** null means that side of the book returned no ads. Never derived, never 0. */
  bestBuyPrice: number | null;
  bestSellPrice: number | null;
  averageBuyPrice: number | null;
  averageSellPrice: number | null;
  medianBuyPrice: number | null;
  medianSellPrice: number | null;
  weightedBuyPrice: number | null;
  weightedSellPrice: number | null;
  spreadAbsolute: number | null;
  spreadPercentage: number | null;

  /**
   * STRATEGIC PRICES - what the operator actually decides on.
   * RECOMPRA = Binance BUY (what I pay), VENTA = Binance SELL (what I receive).
   * Robust central level of each side, not the extremes.
   */
  strategicBuyPrice: number | null;
  strategicSellPrice: number | null;
  /** ((venta - recompra) / recompra) * 100. SIGNED; denominator always recompra. */
  strategicSpreadPct: number | null;
  strategicReason: string | null;
  topBuyAds: NormalizedAd[];
  topSellAds: NormalizedAd[];
  source: 'BINANCE_P2P';
  fetchDurationMs: number;
  status: 'LIVE' | 'STALE' | 'OFFLINE';
  lastError: string | null;

  bestBuy: Valued<number | null>;
  bestSell: Valued<number | null>;
  aggregatesProvenance: DataProvenance;
  orderBookProvenance: DataProvenance;
  strategicProvenance: DataProvenance;
  /** Set when a bank/amount filter was requested but unfiltered data was served. */
  filterFallbackReason?: string;
}

export interface LatestApiResponse {
  snapshot: MarketSnapshot | null;
  ageSeconds: number;
  effectiveStatus: 'LIVE' | 'STALE' | 'OFFLINE';
}

export interface HistoryRecord {
  id: string;
  timestamp: number;
  dateStr: string;
  hour: number;
  buyPrice: number;
  sellPrice: number;
  spreadPct: number;
  bestBuyMerchant: string;
  bestSellMerchant: string;
  activeBuyAds: number;
  activeSellAds: number;
  source: string;
}

export interface HistorySummary {
  totalRecords: number;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
  availableDays: number;
  availableHours: number;
}



export type MarketTrend = 'ALCISTA' | 'BAJISTA' | 'LATERAL';
export type MomentumLevel = 'ALTO' | 'MODERADO' | 'NEUTRO' | 'NEGATIVO';
export type VolatilityLevel = 'ALTA' | 'MEDIA' | 'BAJA';
export type RiskLevel = 'BAJO' | 'MEDIO' | 'ALTO';











/*
 * BankRateItem REMOVED in FASE 5 - the shape of the old "best price" cell.
 * Its spreadPct was the 0.01 VES undercut of the leader, not an arbitrage
 * spread, and nothing in it guaranteed the bank or the liquidity. Replaced by
 * ExecutableCell below.
 */

export interface BankVerificationCounts {
  verified: number;
  notVerified: number;
  notVerifiable: number;
}

/**
 * LIQUIDITY_VERIFIED      - Binance published a volume above zero.
 * LIQUIDITY_ZERO          - Binance published a volume, and it is zero.
 * LIQUIDITY_NOT_VERIFIABLE- Binance published no volume at all. This is a
 *                           missing fact, NOT a fact about missing liquidity.
 */
export type LiquidityStatus =
  | 'LIQUIDITY_VERIFIED'
  | 'LIQUIDITY_ZERO'
  | 'LIQUIDITY_NOT_VERIFIABLE';

/** Why an ad is not executable for a given bank and amount. */
export type ExecutabilityRejection =
  | 'BANK_NOT_VERIFIED'
  | 'BANK_NOT_VERIFIABLE'
  | 'INVALID_PRICE'
  | 'AMOUNT_BELOW_MIN'
  | 'AMOUNT_ABOVE_MAX'
  | 'LIQUIDITY_INSUFFICIENT'
  | 'LIQUIDITY_NOT_VERIFIABLE';

/** What the merchant's record says. Observed values only - no score. */
export interface MerchantQuality {
  ordersCount: number;
  finishRate: number;
  userType: string;
}

/**
 * One ad evaluated against one concrete operation: this bank, this amount,
 * this side.
 *
 * `provenance` is 'EXECUTABLE' only when every condition was positively met.
 * Anything that could not be established - an unverifiable bank, an
 * unpublished volume - yields 'NOT_VERIFIABLE'. Uncertainty never becomes
 * executability.
 */
export interface ExecutableQuote {
  bank: string;
  bankVerification: BankVerification;
  amountVes: number;
  side: 'BUY' | 'SELL';
  price: number;
  advNo: string;
  merchant: string;
  /** Human-readable label of the payment method that matched, when it did. */
  paymentMethod: string | null;
  /** The canonical Binance code that matched exactly, when it did. */
  payType: string | null;
  minAmountVes: number;
  maxAmountVes: number;
  /** null when Binance published no volume. Never a fabricated number. */
  availableUsdt: number | null;
  liquidityStatus: LiquidityStatus;
  merchantQuality: MerchantQuality;
  provenance: DataProvenance;
  /** Set when the quote is not executable. null when it is. */
  rejection: ExecutabilityRejection | null;
  reason: string | null;
}

/** Executability of one BANK x AMOUNT cell, both sides. */
/** Two legs verified to be executable together. */
export interface ExecutablePair {
  buy: ExecutableQuote;
  sell: ExecutableQuote;
  /** USDT the buy leg obtains and the sell leg must be able to move. */
  usdtTraded: number;
  /** ((venta - recompra) / recompra) * 100. Signed, unrounded. */
  spreadPct: number;
}

/** What the pair search looked at for one BANK x AMOUNT cell. */
export interface PairSearchReport {
  /** Ads Binance returned per side, before any filter. Capped at rows=20. */
  buyAdsSeen: number;
  sellAdsSeen: number;
  /** Ads that pass every check that does not depend on the other leg. */
  buyCandidates: number;
  sellCandidates: number;
  /** |buyCandidates| x |sellCandidates|: the whole cartesian product. */
  pairsPossible: number;
  /** Joint compatibility checks actually performed. */
  pairsExamined: number;
  /** Of those examined, how many were compatible. */
  compatiblePairs: number;
  /** USDT the chosen buy leg obtains, which the sell leg must absorb. */
  usdtTraded: number | null;
}

export interface BankAmountExecutability {
  bank: string;
  amountVes: number;
  /** Only the quotes that are actually executable. */
  buyQuotes: ExecutableQuote[];
  sellQuotes: ExecutableQuote[];
  /** Cheapest executable BUY: the repurchase price I would actually pay. */
  bestExecutableBuy: ExecutableQuote | null;
  /** Highest executable SELL: the sale price I would actually receive. */
  bestExecutableSell: ExecutableQuote | null;
  /**
   * The two legs that can actually be executed TOGETHER, or null.
   *
   * The only field that describes an operation. bestExecutableBuy and
   * bestExecutableSell are per-side diagnostics chosen independently, and two
   * of those do not make a pair: the USDT the sell leg must move is set by the
   * buy leg's price, so they can only be chosen jointly. Everything that
   * builds an Opportunity reads THIS.
   */
  pair: ExecutablePair | null;
  /** Why there is no pair, when there is none. */
  noPairReason: string | null;
  /**
   * How the pair was searched for, and what was in range.
   *
   * DESCRIPTIVE: it decides nothing. It exists so "no opportunity" can be told
   * apart from "no opportunity among the twenty ads Binance returned", and so
   * the cost of the search is a measured number rather than a claim.
   */
  pairing: PairSearchReport;
  /** ((venta - recompra) / recompra) * 100. Signed. null unless both exist. */
  spreadPct: number | null;
  /** Why a side is null, when it is. */
  buyReason: string | null;
  sellReason: string | null;
  /** How every evaluated ad was classified. Nothing is silently dropped. */
  buyRejections: Record<string, number>;
  sellRejections: Record<string, number>;
}

/* ------------------------------------------------------------------------ *
 * EXECUTABLE MATRIX - mirror of server/types.ts
 *
 * The only structure this UI may render as a RATE. Every cell is one bank and
 * one amount, built server-side from ads verified as that bank's, accepting
 * that amount, with published volume covering it.
 * ------------------------------------------------------------------------ */

export type CellStatus =
  | 'EXECUTABLE'
  | 'NO_OPPORTUNITY'
  | 'NO_LIQUIDITY'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'NO_AD'
  | 'STALE'
  | 'NOT_VERIFIABLE'
  | 'ERROR';

export interface ExecutableSideView {
  price: number;
  advNo: string;
  merchant: string;
  payType: string | null;
  paymentMethod: string | null;
  availableUsdt: number | null;
  minAmountVes: number;
  maxAmountVes: number;
  liquidityStatus: LiquidityStatus;
}

export interface ExecutableCell {
  bank: string;
  bankDisplayName: string;
  amountKey: string;
  amountVes: number;
  status: CellStatus;
  reason: string | null;
  buy: ExecutableSideView | null;
  sell: ExecutableSideView | null;
  /** Signed. Negative stays negative. */
  spreadPct: number | null;
  availableUsdt: number | null;

  /**
   * The operation this cell represents, or null when there is none.
   *
   * THE single representation: the matrix, the opportunity card and Telegram
   * all read this object, so no consumer can arrive at a different price for
   * the same book.
   */
  opportunity: Opportunity | null;
  buyStatus: CellStatus;
  sellStatus: CellStatus;
  buyReason: string | null;
  sellReason: string | null;
  buyRejections: Record<string, number>;
  sellRejections: Record<string, number>;
  capturedAt: number;
  ageSeconds: number;
  provenance: DataProvenance;
}

export interface ExecutableMatrix {
  capturedAt: number;
  ageSeconds: number;
  stale: boolean;
  staleAfterSeconds: number;
  bankOrder: string[];
  bankDisplayNames: Record<string, string>;
  amountKeys: string[];
  cells: Record<string, Record<string, ExecutableCell>>;
}

/**
 * Global market level. Context only.
 *
 * `executable: false` is part of the payload, not a convention to remember.
 * Rendering these three numbers as a quote is the defect FASE 5 removed.
 */
export interface MarketReference {
  referenceBuyPrice: number | null;
  referenceSellPrice: number | null;
  referenceSpreadPct: number | null;
  provenance: DataProvenance;
  capturedAt: number;
  ageSeconds: number;
  status: 'LIVE' | 'STALE' | 'OFFLINE';
  executable: false;
  note: string;
}

export interface ExecutableMatrixResponse {
  marketReference: MarketReference;
  executableMatrix: ExecutableMatrix;
}

/* ==========================================================================
 * THE MAKER SIDE: what price MY ad should carry.
 *
 * Mirrors server/makerStrategy.ts, server/makerRecommendation.ts and
 * server/makerMatrix.ts field for field. The frontend computes NOTHING from
 * these: not a price, not a position, not a margin. Every number was decided
 * server-side over a captured book, and this file exists so the UI can render
 * that decision without being able to reach a second one.
 *
 * The vocabulary is the operator's, not Binance's. MAKER_BUY is "publico un
 * anuncio que COMPRA USDT", and the ads it competes with are the ones Binance
 * returns under tradeType=SELL - the mirror lives on the server and is not
 * re-derived here.
 * ========================================================================== */

export type MakerSide = 'MAKER_BUY' | 'MAKER_SELL';

export interface MakerSideDefinition {
  side: MakerSide;
  myAction: 'COMPRO USDT' | 'VENDO USDT';
  iHave: 'VES' | 'USDT';
  seenBy: string;
  listingTradeType: 'BUY' | 'SELL';
  competitorsAre: string;
  leaderIs: 'HIGHEST' | 'LOWEST';
  beatDirection: 'UP' | 'DOWN';
  label: string;
}

export interface MakerLadderEntry {
  position: number;
  price: number;
  priceToBeat: number | null;
  deltaFromLeader: number;
  advNo: string;
  merchant: string;
  availableUsdt: number | null;
}

export interface MakerSideAnalysis {
  side: MakerSide;
  definition: MakerSideDefinition;
  bank: string;
  amountVes: number;
  adsExamined: number;
  competitors: number;
  irrelevanceTally: Record<string, number>;
  ladder: MakerLadderEntry[];
  leaderPrice: number | null;
  secondPrice: number | null;
  thirdPrice: number | null;
  tick: number | null;
  tickProvenance: 'OBSERVED' | 'NOT_VERIFIABLE';
  priceToBeFirst: number | null;
  capturedAt: number;
  reason: string | null;
}

export interface MakerPricePoint {
  side: MakerSide;
  position: number;
  price: number;
  beatsAdvNo: string;
  beatsPrice: number;
  beatsMerchant: string;
  gapBehindLeader: number;
  /** null means unknown volume, never zero volume. */
  queueAheadUsdt: number | null;
  queueAheadVerifiable: boolean;
}

export interface MakerPairing {
  position: number;
  buy: MakerPricePoint;
  sell: MakerPricePoint;
  /** MARGEN BRUTO in VES per USDT. Signed: a losing pair reads negative. */
  grossMarginVes: number;
  grossMarginPct: number | null;
}

export type MakerRecommendationBasis =
  | 'FIRST_POSITION_PROFITABLE'
  | 'DEEPER_POSITION_REQUIRED'
  | 'NO_PROFITABLE_POSITION'
  | 'INSUFFICIENT_DATA';

export interface MakerRecommendation {
  bank: string;
  amountVes: number;
  capturedAt: number;
  buyAnalysis: MakerSideAnalysis;
  sellAnalysis: MakerSideAnalysis;
  /** Always present, even when the engine recommends a deeper position. */
  priceToBeFirstBuy: number | null;
  priceToBeFirstSell: number | null;
  firstPositionPairing: MakerPairing | null;
  recommended: MakerPairing | null;
  basis: MakerRecommendationBasis;
  alternatives: MakerPairing[];
  bestMarginPairing: MakerPairing | null;
  reason: string | null;
}

export type MakerCellStatus =
  | 'PUBLISH_AT_TOP'
  | 'PUBLISH_DEEPER'
  | 'NO_MARGIN'
  | 'NO_DATA'
  | 'FETCH_FAILED'
  | 'STALE';

export interface MakerMatrixCell {
  bank: string;
  bankDisplayName: string;
  amountKey: string;
  amountVes: number;
  status: MakerCellStatus;
  recommendation: MakerRecommendation | null;
  capturedAt: number;
  ageSeconds: number;
  adsReturned: { buyListing: number; sellListing: number };
  reason: string | null;
}

export interface MakerConfig {
  excludeMerchants: string[];
  publisherFilter: 'ALL' | 'MERCHANT_ONLY' | 'NON_MERCHANT_ONLY';
  ladderDepth: number;
}

export interface MakerMatrix {
  capturedAt: number;
  ageSeconds: number;
  stale: boolean;
  staleAfterSeconds: number;
  bankOrder: string[];
  bankDisplayNames: Record<string, string>;
  amountKeys: string[];
  cells: Record<string, Record<string, MakerMatrixCell>>;
  config: MakerConfig;
}

/* ==========================================================================
 * FASE 2: TREND, PROJECTION AND SIGNALS.
 *
 * Mirrors server/trendEngine.ts, patternEngine.ts, makerProjectionEngine.ts
 * and signalEngine.ts. The frontend computes NOTHING from these - no trend, no
 * band, no probability. Every number was derived server-side from the per-cell
 * series, and this file exists so a screen can render that decision without
 * being able to reach a second one.
 *
 * ACTUAL, PROYECTADO and HISTÓRICO are separate fields with separate names on
 * purpose: a projected ceiling rendered like a live price is how somebody ends
 * up publishing an ad at a number Binance never quoted.
 * ========================================================================== */

export type TrendDirection = 'BULLISH' | 'BEARISH' | 'SIDEWAYS' | 'TRANSITION' | 'UNKNOWN';

/** Seven levels, graded against each cell's own observed noise. */
export type TrendGrade =
  | 'STRONG_UP'
  | 'UP'
  | 'WEAK_UP'
  | 'LATERAL'
  | 'WEAK_DOWN'
  | 'DOWN'
  | 'STRONG_DOWN'
  | 'UNKNOWN';

export interface HorizonReading {
  name: 'VERY_SHORT' | 'SHORT' | 'MEDIUM';
  observations: number;
  spanMs: number | null;
  direction: TrendDirection;
  grade: TrendGrade;
  velocity: number | null;
  noiseMultiple: number | null;
}

export interface OutcomeDistribution {
  sampleSize: number;
  up: number;
  flat: number;
  down: number;
  upRate: number | null;
  flatRate: number | null;
  downRate: number | null;
  confidence: Confidence;
  reason: 'INSUFFICIENT_HISTORY' | 'NO_DATA' | null;
  description: string;
}
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NO_DATA';

export interface TrendState {
  trend: TrendDirection;
  grade: TrendGrade;
  horizons: HorizonReading[];
  /** Set when the horizons disagree, in words. */
  divergence: string | null;
  trendStrength: number | null;
  trendConfidence: Confidence;
  velocity: number | null;
  acceleration: number | null;
  shortDirection: TrendDirection;
  mediumDirection: TrendDirection;
  /** The medium window before the recent move: what the background was doing. */
  backgroundDirection: TrendDirection;
  typicalStepVes: number | null;
  sampleSize: number;
  reason: 'NO_DATA' | 'INSUFFICIENT_HISTORY' | 'NO_VARIATION_OBSERVED' | null;
  basis: string[];
}

export interface PriceZone {
  low: number;
  high: number;
  touches: number;
  lastTouchedAt: number;
  kind: 'FLOOR' | 'CEILING';
  confidence: Confidence;
}

export interface ProjectedRange {
  low: number | null;
  high: number | null;
  sampleSize: number;
  confidence: Confidence;
  stepsAhead: number;
  /**
   * What those steps are worth in real time, measured on this cell's own
   * timestamps: the median gap between observations times stepsAhead. null
   * when fewer than two observations exist - no interval is invented.
   */
  horizonMs: number | null;
  /** Median gap between consecutive observations of this cell. */
  observedStepMs: number | null;
  reason: 'INSUFFICIENT_HISTORY' | 'NO_DATA' | null;
  basis: string;
}

export interface Breakout {
  direction: 'UP' | 'DOWN';
  level: number;
  currentPrice: number;
  distanceVes: number;
  distanceInSteps: number | null;
  strength: 'ALTA' | 'MEDIA' | 'BAJA';
  status: 'EARLY_WARNING' | 'CONFIRMED';
}

export interface WatchWindow {
  startHour: number;
  endHour: number;
  sampleSize: number;
  medianAbsMoveVes: number;
  confidence: Confidence;
}

export interface SideProjection {
  side: 'BUY' | 'SELL';
  label: 'MI COMPRA DE USDT' | 'MI VENTA DE USDT';
  /** The Binance listing this side's competitors live in. Never re-derived here. */
  listingTradeType: 'BUY' | 'SELL';
  /** ACTUAL. The live price to publish. */
  currentPrice: number | null;
  trend: TrendState;
  exhaustion: {
    exhausted: boolean;
    direction: 'BULLISH' | 'BEARISH' | null;
    reason: string | null;
  };
  /** PROYECTADO. Always a band, never a single number. */
  projectedRange: ProjectedRange;
  floors: PriceZone[];
  ceilings: PriceZone[];
  nextCeiling: PriceZone | null;
  nextFloor: PriceZone | null;
  /** The zone the price is standing in. */
  atCeiling: PriceZone | null;
  atFloor: PriceZone | null;
  /** A zone reached in the recent window and since left. */
  reachedCeiling: PriceZone | null;
  reachedFloor: PriceZone | null;
  breakout: Breakout | null;
  watchWindows: WatchWindow[];
  /** What historically followed, counted. Never a rate without its sample. */
  continuation: {
    overall: OutcomeDistribution;
    inWatchWindow: OutcomeDistribution | null;
    byDay: { day: number; dayName: string; outcomes: OutcomeDistribution }[];
  };
  /** 'MERCADO GENERAL' when this cell was too thin to be read on its own. */
  borrowedFrom: string | null;
}

export interface CellProjection {
  bank: string;
  bankDisplayName: string;
  amountKey: string;
  amountVes: number;
  buy: SideProjection;
  sell: SideProjection;
  observations: number;
  firstObservedAt: number | null;
  lastObservedAt: number | null;
  borrowedFrom: string | null;
  reason: 'NO_DATA' | 'INSUFFICIENT_HISTORY' | null;
}

export type SignalKind =
  | 'TREND_CHANGE'
  | 'EXHAUSTION'
  | 'POSSIBLE_TOP'
  | 'CONFIRMED_TOP'
  | 'POSSIBLE_BOTTOM'
  | 'CONFIRMED_BOTTOM'
  | 'BREAKOUT_UP'
  | 'BREAKOUT_DOWN'
  | 'ACCUMULATION'
  | 'DISTRIBUTION';

export interface MarketSignal {
  kind: SignalKind;
  status: 'EARLY_WARNING' | 'CONFIRMED';
  bank: string;
  bankDisplayName: string;
  amountKey: string;
  amountVes: number;
  side: 'BUY' | 'SELL';
  sideLabel: string;
  headline: string;
  evidence: string[];
  confidence: Confidence;
  sampleSize: number;
  currentPrice: number | null;
  projectedLow: number | null;
  projectedHigh: number | null;
  watchStartHour: number | null;
  watchEndHour: number | null;
  identity: string;
}

/** One point of a cell's stored series, as the chart consumes it. */
export interface SeriesPoint {
  timestamp: number;
  buyRecommendedPrice: number | null;
  sellRecommendedPrice: number | null;
  buyLeaderPrice: number | null;
  sellLeaderPrice: number | null;
}

export interface CellSeriesResponse {
  describe: {
    observations: number;
    firstTimestamp: number | null;
    lastTimestamp: number | null;
    medianIntervalMs: number | null;
    usableObservations: number;
  };
  observations: SeriesPoint[];
}

/**
 * THE WHOLE BOOK, READ BY THE SAME ENGINE AS EVERY CELL.
 *
 * `projection` carries MERCADO_GENERAL as its bank and amountKey, because it
 * describes the book and is not a statement about any bank at any amount.
 * null before the first sweep has written observations.
 */
export interface GeneralProjectionResponse {
  projection: CellProjection | null;
  series: SeriesPoint[];
}

/** One anchor of the walk-forward replay. */
export interface BacktestAnchor {
  index: number;
  timestamp: number;
  priceAtAnchor: number | null;
  actualPrice: number | null;
  predictedDirection: 'UP' | 'DOWN' | 'FLAT' | null;
  actualDirection: 'UP' | 'DOWN' | 'FLAT' | null;
  bandLow: number | null;
  bandHigh: number | null;
  insideBand: boolean | null;
  skipped: string | null;
}

/**
 * How the projection engine ACTUALLY did, measured against a baseline.
 *
 * Replaces BacktestMetrics, which scored the old heuristic engine. A
 * directional accuracy is only meaningful next to the persistence baseline -
 * "the price will not move" - so both are reported and neither is presented as
 * a probability of being right next time.
 */
export interface BacktestReport {
  bank: string;
  amountKey: string;
  side: 'BUY' | 'SELL';
  anchorsEvaluated: number;
  anchorsSkipped: number;
  skipReasons: Record<string, number>;
  directionalCalls: number;
  directionalCorrect: number;
  directionalAccuracy: number | null;
  bandedCalls: number;
  bandHits: number;
  bandCoverage: number | null;
  baselineCorrect: number;
  baselineAccuracy: number | null;
  anchors: BacktestAnchor[];
  reason: 'NO_DATA' | 'INSUFFICIENT_HISTORY' | null;
}

export interface ProjectionBacktestResponse {
  series: { observations: number; firstTimestamp: number | null; lastTimestamp: number | null };
  report: BacktestReport;
}

export interface MakerProjectionsResponse {
  projections: CellProjection[];
  signals: MarketSignal[];
}

export interface MakerMatrixResponse {
  makerMatrix: MakerMatrix;
  /**
   * The cell with the largest MARGEN BRUTO right now, chosen server-side by
   * the same function that decides what Telegram announces. The interface
   * never ranks cells itself.
   */
  best: MakerMatrixCell | null;
}

/**
 * One real operation: a bank, an amount, two executable legs.
 *
 * Identical to the object the backend hands Telegram. There is no second
 * calculation - the card the user reads and the message the bot sends are the
 * same Opportunity.
 */
export interface Opportunity {
  bank: string;
  amountVes: number;
  buyPrice: number;
  sellPrice: number;
  /**
   * THE UNAMBIGUOUS NAMES. Identical values to buyPrice / sellPrice above.
   *
   * arbitrageBuyPrice is what I PAY to acquire USDT - the ASK, from an ad that
   * SELLS USDT, fetched with tradeType 'BUY'. arbitrageSellPrice is what I
   * RECEIVE - the BID, from an ad that BUYS USDT, tradeType 'SELL'.
   *
   * The short names are kept for the persisted history and existing consumers;
   * every human-facing surface reads these, because "buyPrice" on its own has
   * meant two opposite things to two readers.
   */
  arbitrageBuyPrice: number;
  arbitrageSellPrice: number;
  buyAdvNo: string;
  sellAdvNo: string;
  spreadAbsolute: number;
  /** Signed, denominator always buyPrice. */
  spreadPct: number;
  /** GROSS. Before commissions, transfers, slippage. Never net profit. */
  marginAbsolute: number;
  marginPct: number;
  /**
   * GROSS MARGIN OF THE WHOLE OPERATION, IN VES.
   *
   *     amountVes x marginPct / 100  ==  usdtTraded x (sellPrice - buyPrice)
   *
   * Derived, never measured separately: it is the same two prices and the same
   * tier, arranged so the size of the operation is visible. marginPct is a
   * RATE and says nothing about how much money the operation makes, which
   * matters because the tiers differ by a factor of ten: 2,90% on 100.000 VES
   * is 2.900 VES and 3,00% on 10.000 VES is 300.
   *
   * ADDITIVE and descriptive. selectBestOpportunity still ranks on marginPct;
   * this exists so that policy can be seen rather than assumed.
   */
  marginVes: number;
  buyAvailableUsdt: number | null;
  sellAvailableUsdt: number | null;
  availableUsdt: number | null;
  verification: 'VERIFIED' | 'NOT_VERIFIABLE';
  provenance: DataProvenance;
  reason: string | null;
}

export interface OpportunitiesResponse {
  timestamp: number;
  bestOpportunity: Opportunity | null;
  opportunities: Opportunity[];
  byBank: Record<string, Record<string, Opportunity | null>>;
}

export interface AlertRule {
  id: string;
  name: string;
  condition: 'ABOVE' | 'BELOW' | 'SPREAD_ABOVE' | 'VOLATILITY_SPIKE' | 'TREND_CHANGE';
  targetValue: number;
  targetSide: 'BUY' | 'SELL';
  enabled: boolean;
  createdAt: number;
  lastTriggeredAt?: number;
}

export interface AlertTriggerLog {
  id: string;
  ruleId: string;
  ruleName: string;
  message: string;
  price: number;
  timestamp: number;
}
