/**
 * Core type definitions for Binance P2P Trading Assistant
 * Single Source of Truth for Data Contracts
 */

export type TradeType = 'BUY' | 'SELL';

/**
 * Where a value came from. Every number this system publishes must be
 * classifiable as exactly one of these, and the four are never mixed silently.
 *
 * REAL       - observed directly from Binance (a published ad price, an ad's
 *              available amount, a stored tick that was captured live).
 * AGGREGATED - computed deterministically from REAL observations (mean,
 *              median, volume-weighted price, standard deviation, RSI).
 * PROJECTED  - an extrapolation about a moment that has not happened yet.
 * HEURISTIC  - produced by a hand-written rule with no empirical derivation:
 *              hardcoded coefficients, fixed thresholds, invented fallbacks.
 *
 * A value that would otherwise be unknown is HEURISTIC, never REAL. Phase C2
 * replaces those with null; C1 only labels them.
 */
export type DataProvenance = 'REAL' | 'AGGREGATED' | 'PROJECTED' | 'HEURISTIC';

/** The stored observations an AGGREGATED or PROJECTED value was derived from. */
export interface DataWindow {
  sampleCount: number;
  fromTimestamp: number | null;
  toTimestamp: number | null;
  spanMinutes: number | null;
}

/**
 * A number carrying its own provenance. Used for the figures the UI presents
 * directly AND whose provenance varies at runtime - i.e. exactly the values
 * that are sometimes real and sometimes fabricated. Values with a fixed
 * classification use a separate provenance field on their block instead.
 */
export interface Valued<T> {
  value: T;
  provenance: DataProvenance;
  /** Why this provenance, when it is not self-evident. Required for HEURISTIC. */
  reason?: string;
  dataWindow?: DataWindow;
}

export type MerchantFilterType = 'ALL' | 'MERCHANT' | 'PRO';

export type BankFilterKey = 'ALL' | 'BANESCO' | 'PROVINCIAL' | 'MERCANTIL' | 'BNC' | 'BANCAMIGA' | 'VENEZUELA' | 'PAGO_MOVIL';
export type AmountFilterKey = 'ALL' | '10K' | '20K' | '30K' | '40K' | '50K' | '100K';

export interface GlobalFilterState {
  bank: BankFilterKey;
  bankDisplayName: string;
  amount: AmountFilterKey;
  amountVal: number | null;
}

export interface BinanceTradeMethod {
  payType: string;
  payMethodId: string;
  tradeMethodName: string;
}

export interface BinanceAdv {
  advNo: string;
  price: string;
  maxSingleTransAmount: string;
  minSingleTransAmount: string;
  surplusAmount: string;
  tradableQuantity: string;
  tradeType: string;
  asset: string;
  fiatUnit: string;
  tradeMethods: BinanceTradeMethod[];
}

export interface BinanceAdvertiser {
  userNo: string;
  nickName: string;
  userType: string; // 'merchant', 'user', etc.
  monthOrderCount: number;
  monthFinishRate: number;
  positiveRate: number;
  userGrade: number;
}

export interface BinanceAdItem {
  adv: BinanceAdv;
  advertiser: BinanceAdvertiser;
}

export interface BinanceP2PResponse {
  code: string;
  message: string | null;
  data: BinanceAdItem[];
  total: number;
  success: boolean;
}

export interface NormalizedAd {
  advNo: string;
  price: number;
  minAmountVes: number;
  maxAmountVes: number;
  availableUsdt: number;
  merchantName: string;
  userType: string;
  ordersCount: number;
  finishRate: number;
  paymentMethods: string[];
}

export interface MarketSnapshot {
  timestamp: number;
  isoDate: string;
  asset: 'USDT';
  fiat: 'VES';
  
  // Multi-filter metadata
  filterBank?: string;
  filterBankName?: string;
  filterAmount?: number | null;
  filterAmountKey?: string;
  
  // Real raw prices from top ads (The exact ads on the book).
  // null means that side of the book returned no ads. It is NEVER derived
  // from the opposite side and never defaults to 0.
  bestBuyPrice: number | null; // Lowest price to buy USDT (Taker pays VES to get USDT)
  bestSellPrice: number | null; // Highest price to sell USDT (Taker gives USDT to get VES)

  // Aggregate stats (clearly labeled as aggregated). null when the side they
  // aggregate over was empty.
  averageBuyPrice: number | null;
  averageSellPrice: number | null;
  medianBuyPrice: number | null;
  medianSellPrice: number | null;
  weightedBuyPrice: number | null;
  weightedSellPrice: number | null;

  /** null unless BOTH sides are present - a spread needs two prices. */
  spreadAbsolute: number | null;
  spreadPercentage: number | null;
  
  // Raw ad lists
  topBuyAds: NormalizedAd[];
  topSellAds: NormalizedAd[];
  
  // Health & Source metadata
  source: 'BINANCE_P2P';
  fetchDurationMs: number;
  status: 'LIVE' | 'STALE' | 'OFFLINE';
  lastError: string | null;

  /**
   * Provenance mirrors of bestBuyPrice / bestSellPrice. The plain fields above
   * are kept unchanged in C1; C2 replaces them with these.
   * REAL when the side actually had ads, HEURISTIC when the value was derived
   * from the opposite side.
   */
  bestBuy: Valued<number | null>;
  bestSell: Valued<number | null>;
  /** average/median/weighted prices and the spread: always AGGREGATED. */
  aggregatesProvenance: DataProvenance;
  /** topBuyAds / topSellAds: always REAL, they are the ads as published. */
  orderBookProvenance: DataProvenance;
  /**
   * Set when a bank/amount filter was requested but the filtered query failed
   * and unfiltered data was served instead. Absent means the filter was honoured.
   */
  filterFallbackReason?: string;
}

export interface HistoryRecord {
  id: string;
  timestamp: number;
  dateStr: string;
  hour: number;
  buyPrice: number; // Taker BUY USDT price (Tasa de recompra)
  sellPrice: number; // Taker SELL USDT price (Tasa de venta)
  spreadPct: number;
  bestBuyMerchant: string;
  bestSellMerchant: string;
  activeBuyAds: number;
  activeSellAds: number;
  source: string;
  filterBank?: string;
  filterAmount?: number;
}

export interface HourlyChartPoint {
  hour: number;
  label: string; // e.g. "8 AM", "9 AM", "4 PM"
  fullTimestamp?: number;
  sellPrice: number | null; // Tasa de venta real
  buyPrice: number | null; // Tasa de recompra real
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
  /**
   * REAL      - a stored tick was found for this hour.
   * PROJECTED - a future hour extrapolated forward.
   * HEURISTIC - no tick existed and the value was synthesised from the
   *             hardcoded session curve. C1 labels it; C2 makes it null.
   */
  provenance: DataProvenance;
  provenanceReason?: string;
}

export type MarketTrend = 'ALCISTA' | 'BAJISTA' | 'LATERAL';
export type MomentumLevel = 'ALTO' | 'MODERADO' | 'NEUTRO' | 'NEGATIVO';
export type VolatilityLevel = 'ALTA' | 'MEDIA' | 'BAJA';
export type RiskLevel = 'BAJO' | 'MEDIO' | 'ALTO';

export interface MarketAnalysis {
  /** null when there is no price series to classify. */
  trend: MarketTrend | null;
  /**
   * 0 to 100. 0 means a genuinely flat slope. null means the slope could not
   * be computed at all. There is no artificial floor.
   */
  trendStrength: number | null;
  momentum: MomentumLevel | null;
  volatility: VolatilityLevel | null;
  volatilityPct: number | null;
  priceVsSmaPct: number | null;
  /** null when the series has no movement at all - RSI is undefined there. */
  rsi: number | null;
  supportLevel: number | null;
  resistanceLevel: number | null;
  summaryText: string;
  reasons: string[];

  provenance: {
    /** trend, momentum, volatility, rsi, priceVsSmaPct: derived from stored ticks. */
    overall: DataProvenance;
    /** |slope%| * 600 + 35 - the constants have no empirical basis. */
    trendStrength: DataProvenance;
    /** min/max +/- 1.6 standard deviations - the multiplier is hand-picked. */
    supportResistance: DataProvenance;
  };
  /** The stored observations `overall` was computed from. */
  dataWindow: DataWindow;
}

export interface HourlyProjectionItem {
  horizon: string; // "+1H", "+2H", "+4H", "+6H", "+12H", "+24H"
  targetTime: string;
  projectedBuy: number | null;
  projectedSell: number | null;
  rangeMin: number | null;
  rangeMax: number | null;
  /** null until the backtest measures real error - never a sample-count proxy. */
  confidence: number | null;
}

export interface MerchantDecisionAdvice {
  action: 'VENDER_AHORA' | 'MANTENER_INVENTARIO' | 'RECOMPRAR_AHORA' | 'ESPERAR_RETROCESO' | 'ARBITRAJE_RAPIDO';
  actionTitle: string;
  actionExplanation: string;
  /** null - these windows are not computed from anything yet. */
  optimalSellTimeWindow: string | null;
  optimalBuyTimeWindow: string | null;
  projectedPeakRate: number | null;
  projectedTroughRate: number | null;
  /**
   * null. The former value was (ceiling - floor) * 1000, which assumes
   * capturing both extremes and ignores fees, slippage and liquidity. A real
   * figure requires the cost model of project rule 7.
   */
  estimatedNetProfitPer1000UsdtVes: number | null;
  orderBookPressure: {
    buyVolumeUsdt: number | null;
    sellVolumeUsdt: number | null;
    buyPressurePct: number | null;
    sellPressurePct: number | null;
    dominantSide: 'COMPRA' | 'VENTA' | 'EQUILIBRADO' | null;
    /**
     * Provenance mirrors of the two volumes. AGGREGATED when summed from real
     * ads, HEURISTIC when the order book was empty and a placeholder was used.
     */
    buyVolume: Valued<number | null>;
    sellVolume: Valued<number | null>;
  };
}

export interface MarketProjections {
  /**
   * True only when there is a valid live price AND at least
   * ProjectionEngine.MIN_SAMPLES_FOR_PROJECTION stored observations.
   */
  hasSufficientData: boolean;
  /** Populated whenever hasSufficientData is false. */
  insufficientDataReason?: string;
  currentBuyPrice: number | null;
  currentSellPrice: number | null;

  /** Provenance mirrors of currentBuyPrice / currentSellPrice. */
  currentBuy: Valued<number | null>;
  currentSell: Valued<number | null>;
  /** The stored observations these projections were computed from. */
  dataWindow: DataWindow;
  provenance: {
    /** floor / ceiling: extrapolations about the rest of the session. */
    daily: DataProvenance;
    /** Point-scoring rules, not a calibrated distribution. */
    probabilities: DataProvenance;
    /** 62 + min(25, n * 0.35) - a function of sample count, not of error. */
    confidence: DataProvenance;
    /** Fixed hourly coefficients and constant trade windows. */
    seasonality: DataProvenance;
    /** if/else over trend, pressure and clock time. */
    merchantAdvice: DataProvenance;
    /** Fixed thresholds (volatility ALTA, spread > 1.8%, pressure > 70%). */
    risk: DataProvenance;
  };
  
  daily: {
    floor: number | null; // Piso del día
    ceiling: number | null; // Techo del día
    /** null when there is no range to describe. */
    rangeText: string | null;
    direction: MarketTrend | null;
    /**
     * null until Phase 8 derives it from measured projection error. It is NOT
     * replaced by another arbitrary number.
     */
    confidencePct: number | null;
    /** The real expected spread, with no artificial floor. */
    spreadMaxExpected: number | null;
    reasons: string[];
  };
  
  intradayHorizons: HourlyProjectionItem[];
  
  probabilities: {
    up: number | null; // Probabilidad subir %
    neutral: number | null; // Probabilidad mantener %
    down: number | null; // Probabilidad bajar %
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
  mae: number; // Mean Absolute Error
  rmse: number; // Root Mean Square Error
  mape: number; // Mean Absolute Percentage Error (%)
  directionalAccuracyPct: number; // % of times predicted trend matched actual
  lastEvaluatedAt: string;
}

export interface BankMatrixRow {
  bankKey: string;
  bankDisplayName: string;
  iconName?: string;
  ratesByAmount: {
    [amountKey: string]: {
      leaderPrice: number | null;
      suggestedPrice: number | null;
      spreadPct: number | null;
      availableMerchant?: string;
      orderCount?: number;
      adCount: number;
      /**
       * REAL when an ad actually covers this amount tier; HEURISTIC when no ad
       * matched and the bank's top ad was used instead - that rate is not
       * executable at this amount.
       */
      provenance: DataProvenance;
      provenanceReason?: string;
    };
  };
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
