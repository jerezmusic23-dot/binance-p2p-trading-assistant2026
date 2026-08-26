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

export interface HourlyChartPoint {
  hour: number;
  label: string;
  fullTimestamp?: number;
  sellPrice: number | null;
  buyPrice: number | null;
  spreadPct: number | null;
  projectedSell?: number | null;
  projectedBuy?: number | null;
  floor?: number | null;
  ceiling?: number | null;
  isPeak?: boolean;
  isTrough?: boolean;
  isCoincide?: boolean;
  isProjected: boolean;
  notes?: string;
  provenance: DataProvenance;
  provenanceReason?: string;
}

export type MarketTrend = 'ALCISTA' | 'BAJISTA' | 'LATERAL';
export type MomentumLevel = 'ALTO' | 'MODERADO' | 'NEUTRO' | 'NEGATIVO';
export type VolatilityLevel = 'ALTA' | 'MEDIA' | 'BAJA';
export type RiskLevel = 'BAJO' | 'MEDIO' | 'ALTO';

export interface MarketAnalysis {
  trend: MarketTrend | null;
  /** 0 means a genuinely flat slope; null means it could not be computed. */
  trendStrength: number | null;
  momentum: MomentumLevel | null;
  volatility: VolatilityLevel | null;
  volatilityPct: number | null;
  priceVsSmaPct: number | null;
  /** null when the series has no movement - RSI is undefined there. */
  rsi: number | null;
  supportLevel: number | null;
  resistanceLevel: number | null;
  summaryText: string;
  reasons: string[];
  provenance: {
    overall: DataProvenance;
    trendStrength: DataProvenance;
    supportResistance: DataProvenance;
  };
  dataWindow: DataWindow;
}

export interface HourlyProjectionItem {
  horizon: string;
  targetTime: string;
  projectedBuy: number | null;
  projectedSell: number | null;
  rangeMin: number | null;
  rangeMax: number | null;
  confidence: number | null;
}

export interface MerchantDecisionAdvice {
  action: 'VENDER_AHORA' | 'MANTENER_INVENTARIO' | 'RECOMPRAR_AHORA' | 'ESPERAR_RETROCESO' | 'ARBITRAJE_RAPIDO';
  actionTitle: string;
  actionExplanation: string;
  optimalSellTimeWindow: string | null;
  optimalBuyTimeWindow: string | null;
  projectedPeakRate: number | null;
  projectedTroughRate: number | null;
  /** null: no cost model yet (fees, slippage, liquidity). */
  estimatedNetProfitPer1000UsdtVes: number | null;
  orderBookPressure: {
    buyVolumeUsdt: number | null;
    sellVolumeUsdt: number | null;
    buyPressurePct: number | null;
    sellPressurePct: number | null;
    dominantSide: 'COMPRA' | 'VENTA' | 'EQUILIBRADO' | null;
    buyVolume: Valued<number | null>;
    sellVolume: Valued<number | null>;
  };
}

export interface MarketProjections {
  hasSufficientData: boolean;
  insufficientDataReason?: string;
  currentBuyPrice: number | null;
  currentSellPrice: number | null;

  currentBuy: Valued<number | null>;
  currentSell: Valued<number | null>;
  dataWindow: DataWindow;
  provenance: {
    daily: DataProvenance;
    probabilities: DataProvenance;
    confidence: DataProvenance;
    seasonality: DataProvenance;
    merchantAdvice: DataProvenance;
    risk: DataProvenance;
  };
  daily: {
    floor: number | null;
    ceiling: number | null;
    rangeText: string | null;
    direction: MarketTrend | null;
    /** null until the backtest measures real error. Never a sample-count proxy. */
    confidencePct: number | null;
    spreadMaxExpected: number | null;
    reasons: string[];
  };
  intradayHorizons: HourlyProjectionItem[];
  probabilities: {
    up: number | null;
    neutral: number | null;
    down: number | null;
  };
  hourlyTimeline: HourlyChartPoint[];
  merchantAdvice: MerchantDecisionAdvice;
  risk: {
    level: RiskLevel | null;
    factors: string[];
  };
}

export interface BacktestMetrics {
  hasSufficientData: boolean;
  sampleSize: number;
  samplePeriodDays: number;
  mae: number;
  rmse: number;
  mape: number;
  directionalAccuracyPct: number;
  lastEvaluatedAt: string;
}

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
  buyAdvNo: string;
  sellAdvNo: string;
  spreadAbsolute: number;
  /** Signed, denominator always buyPrice. */
  spreadPct: number;
  /** GROSS. Before commissions, transfers, slippage. Never net profit. */
  marginAbsolute: number;
  marginPct: number;
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
