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
export type DataProvenance =
  | 'REAL'
  | 'AGGREGATED'
  | 'PROJECTED'
  | 'HEURISTIC'
  | 'STRATEGIC'
  | 'EXECUTABLE'
  | 'NOT_VERIFIABLE';

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

  /**
   * STRATEGIC PRICES - what the operator actually decides on.
   *
   * RECOMPRA = Binance BUY  : the price I pay to acquire USDT.
   * VENTA    = Binance SELL : the price I receive when selling USDT.
   *
   * These are the robust central level of each side (the median), NOT the
   * extremes. min(BUY) and max(SELL) estimate the tail of the ad population,
   * not the market level, so a single distant ad moves them by tens of VES
   * while leaving the real market untouched. bestBuyPrice / bestSellPrice are
   * kept above as the RAW audit trail; every decision is taken on these.
   */
  strategicBuyPrice: number | null;
  strategicSellPrice: number | null;
  /**
   * ((venta - recompra) / recompra) * 100.
   *
   * SIGNED - a negative value means selling below repurchase, i.e. a loss, and
   * must stay distinguishable from a gain. The denominator is ALWAYS the
   * repurchase price, never whichever of the two happens to be smaller.
   * null unless both strategic prices exist.
   */
  strategicSpreadPct: number | null;
  /** Why a strategic value is null, when it is. */
  strategicReason: string | null;
  
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
  /** strategicBuyPrice / strategicSellPrice / strategicSpreadPct. */
  strategicProvenance: DataProvenance;
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
  /**
   * FALSE, always, today.
   *
   * runBacktest fits a 5-point linear slope over history.buyPrice and predicts
   * the NEXT stored record - one polling step, about 6 seconds ahead.
   * generateProjections uses a different model entirely (volatility bands,
   * session curves, seasonal factors, heuristic probabilities) over horizons
   * of 1 to 4 hours. The two are not comparable, so these metrics do not
   * validate the projections the dashboard shows.
   */
  validatesProductionModel: boolean;
  /** What was actually measured, so the number cannot be read as more. */
  modelDescription: string;
  hasSufficientData: boolean;
  sampleSize: number;
  samplePeriodDays: number;
  mae: number; // Mean Absolute Error
  rmse: number; // Root Mean Square Error
  mape: number; // Mean Absolute Percentage Error (%)
  directionalAccuracyPct: number; // % of times predicted trend matched actual
  lastEvaluatedAt: string;
}

/** How a bank's ad population splits across the three verification verdicts. */
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

/**
 * VERIFIED       - both sides executable AND both liquidities verifiable.
 * NOT_VERIFIABLE - both sides executable, but a liquidity could not be
 *                  established. Kept as context; never a usable operation.
 */
export type OpportunityVerification = 'VERIFIED' | 'NOT_VERIFIABLE';

/** One bank's entry in BANK_CODE_MAP. */
export interface BankCodeConfig {
  code: string;
  displayName: string;
  apiPayTypes: string[];
}

/**
 * VERIFIED       - an observed payType matched a configured code exactly.
 * NOT_VERIFIED   - ads carry codes and none matches. The mapping is WRONG.
 * NOT_VERIFIABLE - nothing observed yet, or no ad carries a canonical code.
 */
export type PayTypeMappingStatus = 'VERIFIED' | 'NOT_VERIFIED' | 'NOT_VERIFIABLE';

/**
 * Whether BANK_CODE_MAP.apiPayTypes matches what Binance actually sends,
 * derived from observation rather than asserted by a constant.
 */
/**
 * One payType as Binance published it, with everything observed about it.
 *
 * `mapped` says whether any configured bank claims this code - NOT whether
 * the code is legitimate. An unmapped code is a real Binance rail we have no
 * entry for; it is evidence, not an error.
 */
export interface PayTypeObservation {
  payType: string;
  /** Labels seen alongside this code, verbatim. Several ads may disagree. */
  tradeMethodNames: string[];
  count: number;
  mapped: boolean;
  /** Configured banks claiming this code. Empty when OBSERVED_UNMAPPED. */
  banks: string[];
}

/**
 * VERIFIED     - a configured code for this bank appeared in the sample.
 * NOT_OBSERVED - it did not. This is NOT evidence that the code is wrong:
 *                the bank may simply have had no ad in the window. A code is
 *                only ever corrected against a payType Binance actually
 *                returned.
 */
export type BankMappingStatus = 'VERIFIED' | 'NOT_OBSERVED';

export interface BankMappingVerdict {
  bank: string;
  configuredCodes: string[];
  status: BankMappingStatus;
  matchedCodes: string[];
  reason: string;
}

/** How much book the assessment actually looked at. */
export interface PayTypeInspection {
  buyAds: number;
  sellAds: number;
  totalAds: number;
  /** Payment-method entries seen; an ad may publish several. */
  paymentMethodEntries: number;
}

export interface PayTypeMappingReport {
  status: PayTypeMappingStatus;
  reason: string;
  observedAdCount: number;
  /** Canonical codes actually seen, verbatim and deduplicated. */
  observedPayTypes: string[];
  configuredCodes: string[];
  matchedCodes: string[];
  /** Observed codes no bank claims - candidates for a corrected mapping. */
  unmatchedObserved: string[];
  banksVerified: string[];
  banksNotObserved: string[];

  /** How much book was inspected. Absent when the caller did not say. */
  inspected?: PayTypeInspection;
  /** Every payType observed, with frequency and labels. */
  observations: PayTypeObservation[];
  /** Observed codes no configured bank claims. */
  observedUnmapped: PayTypeObservation[];
  /** Per-bank verdict: VERIFIED or NOT_OBSERVED, never "wrong". */
  bankVerdicts: BankMappingVerdict[];
}

/**
 * One concrete operation: buy USDT and sell them back, same bank, same amount.
 *
 * Built EXCLUSIVELY from EXECUTABLE quotes. The strategic median describes
 * where the market is; an Opportunity describes a trade someone can actually
 * place. They are different questions and never substitute for one another.
 */
export interface Opportunity {
  bank: string;
  amountVes: number;

  /** Price paid to acquire USDT. From an EXECUTABLE BUY quote only. */
  buyPrice: number;
  /** Price received selling USDT. From an EXECUTABLE SELL quote only. */
  sellPrice: number;
  buyAdvNo: string;
  sellAdvNo: string;

  /** sellPrice - buyPrice. Signed. */
  spreadAbsolute: number;
  /** ((sellPrice - buyPrice) / buyPrice) * 100. Signed, denominator buyPrice. */
  spreadPct: number;

  /**
   * GROSS margin of the operation, identical to the spread above.
   *
   * BEFORE commissions, transfers, banking costs, slippage, rounding and any
   * other operating cost. This project does not model those yet, and none are
   * invented here. This is NOT net profit.
   */
  marginAbsolute: number;
  marginPct: number;

  /** null only if a side's liquidity could not be established. Never 0 for absent. */
  buyAvailableUsdt: number | null;
  sellAvailableUsdt: number | null;
  /** min(buy, sell) when both are known; null otherwise. Never invented. */
  availableUsdt: number | null;

  /**
   * Verification of the OPERATION'S LIQUIDITY (the contract's
   * `liquidityVerification`): VERIFIED only when both legs published a
   * volume. Executability of each leg was already settled upstream.
   */
  verification: OpportunityVerification;
  provenance: DataProvenance;
  /** Why this is not VERIFIED, when it is not. */
  reason: string | null;
}

/** Diagnostic context for one BANK x AMOUNT cell, kept even when no Opportunity exists. */
export interface OpportunityContext {
  bank: string;
  amountVes: number;
  buyReason: string | null;
  sellReason: string | null;
  buyRejections: Record<string, number>;
  sellRejections: Record<string, number>;
}

export interface OpportunityEngineResult {
  /** Every Opportunity found, VERIFIED and NOT_VERIFIABLE alike. */
  opportunities: Opportunity[];
  /** byBank[bank][amountKey] - null where no Opportunity exists. */
  byBank: Record<string, Record<string, Opportunity | null>>;
  /** Best operation overall. Chosen among VERIFIED opportunities ONLY. */
  bestOpportunity: Opportunity | null;
  /** Rejections preserved per cell. Nothing is silently dropped. */
  context: Record<string, Record<string, OpportunityContext>>;
}

export interface BankMatrixRow {
  bankKey: string;
  bankDisplayName: string;
  iconName?: string;
  /**
   * FASE 3: how many of this bank's ads could be positively verified as
   * belonging to it by exact canonical payType equality.
   *
   * Reported, NOT yet enforced. The rates below are still computed over every
   * ad Binance returned for the bank filter. Once these counts confirm what
   * Binance really sends in payType, FASE 4 can filter on them.
   */
  verificationBuy?: BankVerificationCounts;
  verificationSell?: BankVerificationCounts;
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
  /**
   * OPPORTUNITY_ABOVE fires on the gross margin of the BEST_OPPORTUNITY - a
   * real operation at one bank for one amount - not on a spread between two
   * unrelated ads. targetSide is ignored for it: an operation has both sides.
   */
  condition:
    | 'ABOVE'
    | 'BELOW'
    | 'SPREAD_ABOVE'
    | 'VOLATILITY_SPIKE'
    | 'TREND_CHANGE'
    | 'OPPORTUNITY_ABOVE';
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
