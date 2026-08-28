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
/* ==========================================================================
 * THE ECONOMIC RULE.  ASK / BID  <->  MY OPERATION  <->  tradeType
 *
 * Written from the ECONOMICS of the operation, which is the only reading that
 * cannot be argued with. Advertiser action, taker action and parameter names
 * all point in different directions; the money does not.
 *
 *   BINANCE ASK   =  the price at which I BUY USDT       =  entry
 *                 =  an ad that is SELLING USDT
 *                 =  ARBITRAGE BUY LEG  ->  arbitrageBuyPrice
 *                 =  best is the LOWEST: I want to pay least
 *                 =  returned by tradeType: 'BUY'
 *
 *   BINANCE BID   =  the price at which I SELL USDT      =  exit
 *                 =  an ad that is BUYING USDT
 *                 =  ARBITRAGE SELL LEG  ->  arbitrageSellPrice
 *                 =  best is the HIGHEST: I want to receive most
 *                 =  returned by tradeType: 'SELL'
 *
 *   OPPORTUNITY  <=>  arbitrageSellPrice > arbitrageBuyPrice
 *   spreadAbsolute   =  arbitrageSellPrice - arbitrageBuyPrice
 *   spreadPercentage = ((arbitrageSellPrice - arbitrageBuyPrice)
 *                        / arbitrageBuyPrice) * 100
 *
 *   Signed. Never absolute-valued: a loss must stay a loss.
 *
 * WHY tradeType 'BUY' IS THE ASK, WHICH IS THE EASY PART TO GET BACKWARDS
 *
 * The parameter carries the SEARCHER's intent, not the advertiser's action.
 * Asking Binance for tradeType='BUY' is the API equivalent of pressing "Buy
 * USDT" on p2p.binance.com: it returns the ads you can buy FROM, which are the
 * asks. The advertisers behind them are selling, and reading the parameter as
 * the advertiser's side is what inverts the whole chain.
 *
 * HOW TO FALSIFY THIS, WITH DATA RATHER THAN WITH WORDS
 *
 * In any functioning market the ask sits at or above the bid, because crossing
 * costs the taker. Observed in production on the strategic medians - the
 * robust estimator, not the raw extremes:
 *
 *     median(tradeType='BUY')  = 945.75      <- higher: the ASK side
 *     median(tradeType='SELL') = 944.75      <- lower:  the BID side
 *
 * Crossing costs 0.11%, which is why no opportunity exists at the market
 * level. Swap the legs and that cost reads as a gain, on every bank and every
 * amount, for as long as the market has a spread - a permanent fictitious
 * profit, which REGLA 5 exists to prevent.
 *
 * If a future observation ever shows median(BID) persistently ABOVE
 * median(ASK), this mapping is wrong and the chain must be re-derived from
 * that evidence, not from this comment.
 *
 * STORAGE NAMES.  buyPrice / bestBuyPrice / strategicBuyPrice carry the ASK
 * (my purchase); sellPrice / bestSellPrice / strategicSellPrice carry the BID
 * (my sale). The names predate this vocabulary and are load-bearing in the
 * persisted history, so they stay; every label a human reads names the side.
 *
 * tests/arbitrageSideSemantics.test.ts pins every link in the chain.
 * ========================================================================== */

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

  /**
   * ADDITIVE. Absent on every record written before this existed - those are
   * v1, RAW-only, and are never backfilled with values nobody observed.
   *
   * buyPrice/sellPrice/spreadPct above stay exactly what they were: the raw
   * extremes of the book. These three are the strategic level - the median of
   * each side and the signed spread between them - which is what a market
   * projection should be built on. Both are kept because they answer
   * different questions, and a series must never mix them.
   */
  calculationVersion?: 'v2-strategic';
  strategicBuyPrice?: number;
  strategicSellPrice?: number;
  strategicSpreadPct?: number;
}

/** What the storage layer is actually doing, for diagnosing persistence. */
export interface StorageDiagnostics {
  dataDir: string;
  historyFile: string;
  exists: boolean;
  writable: boolean;
  recordCount: number;
  /** ISO timestamps of the first and last stored sample. null when empty. */
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
  /** How many stored records carry strategic prices. */
  strategicRecordCount: number;
  /**
   * RETENTION. Records beyond the active window are moved to a dated archive
   * under history_archive/ - never deleted. These fields make that visible
   * from /api/health, so a shrinking recordCount can be told apart from data
   * loss.
   */
  maxActiveRecords: number;
  archivedRecordCount: number;
  lastArchiveFile: string | null;
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

/* ------------------------------------------------------------------------ *
 * WALK-FORWARD BACKTEST
 *
 * Measures the projection engine that production actually publishes, by
 * calling it. Nothing here re-implements a heuristic: at each past record the
 * backtest rebuilds the inputs that record carries, invokes analyzeMarket and
 * generateProjections, and only then looks forward to score the result.
 * ------------------------------------------------------------------------ */

/** Which series the window resolved to - the same rule production applies. */
export type SeriesBasis = 'STRATEGIC' | 'RAW';

/** Where the evaluated history came from. Never inferred, always declared. */
export type BacktestSource = 'REAL_HISTORY' | 'SYNTHETIC_FIXTURE';

/**
 * Why an anchor produced no scored sample. Counted, never silently dropped -
 * a horizon reporting 4 samples out of 300 anchors has to say what happened
 * to the other 296.
 */
export type BacktestSkipReason =
  | 'BELOW_MIN_SAMPLES'
  | 'PRODUCTION_INSUFFICIENT_DATA'
  | 'NO_PROJECTION_VALUE'
  | 'NO_FUTURE_RECORD'
  | 'FUTURE_RECORD_WRONG_BASIS'
  | 'NON_POSITIVE_ACTUAL';

/** Error figures for one predictor over one horizon. null when nothing scored. */
export interface BacktestErrorMetrics {
  /** Mean Absolute Error, in VES. */
  mae: number | null;
  /** Root Mean Squared Error, in VES. */
  rmse: number | null;
  /** Mean Absolute Percentage Error, in %. */
  mapePct: number | null;
  /**
   * Share of samples whose predicted direction matched the realised one.
   *
   * UP / DOWN / FLAT, where FLAT means the move was below the precision the
   * history is stored at (prices are persisted to 2 decimals). The persistence
   * baseline predicts no change by construction, so its directional accuracy
   * is the share of genuinely flat outcomes - a low number there is the
   * metric behaving correctly, not the baseline failing.
   */
  directionalAccuracyPct: number | null;
  /**
   * Mean SIGNED error (predicted - actual), in VES. Positive means the model
   * runs high. Kept signed on purpose: an absolute value cannot show bias.
   */
  biasVes: number | null;
  biasDirection: 'OVERESTIMATES' | 'UNDERESTIMATES' | 'BALANCED' | null;
}

export interface HorizonBacktestResult {
  /** '+1H' ... '+24H', exactly the label generateProjections emits. */
  horizon: string;
  hours: number;
  status: 'OK' | 'INSUFFICIENT_DATA';
  /** Present whenever status is INSUFFICIENT_DATA. */
  reason: string | null;

  /** Past records considered as a standing point. */
  evaluatedSamples: number;
  /** Of those, the ones that produced a prediction AND had a real future. */
  validSamples: number;
  skippedSamples: number;
  skipReasons: Partial<Record<BacktestSkipReason, number>>;

  /** The production projection engine. */
  model: BacktestErrorMetrics;
  /** future = current price. The bar the model has to clear to be worth its constants. */
  persistence: BacktestErrorMetrics;

  /**
   * (persistence.mae - model.mae) / persistence.mae * 100.
   * Positive means the model beat doing nothing. null when either is null.
   */
  maeImprovementPct: number | null;
  beatsPersistence: boolean | null;

  /**
   * How often the realised price landed inside [rangeMin, rangeMax].
   *
   * This is a PROJECTION BAND - current price times a hand-picked multiple of
   * measured volatility. It is NOT a confidence interval and carries no
   * nominal coverage, so there is no advertised percentage for the observed
   * one to be compared against.
   */
  bandCoveragePct: number | null;
  bandSamples: number;
}

export interface WalkForwardBacktestResult {
  status: 'ok' | 'insufficient_data';
  /**
   * True only when this run actually scored the production engine on at least
   * one horizon. An implemented backtest with nothing to measure validates
   * nothing, and says so.
   */
  validatesProductionModel: boolean;
  method: 'WALK_FORWARD_PRODUCTION_MODEL';
  modelDescription: string;
  source: BacktestSource;
  baseline: 'PERSISTENCE';

  /** Basis of the last anchor evaluated, and the tally across all of them. */
  basis: SeriesBasis | null;
  basisCounts: { strategic: number; raw: number };

  totalRecords: number;
  strategicRecords: number;
  spanMinutes: number | null;
  medianIntervalSeconds: number | null;
  minSamplesForProjection: number;
  projectionWindowSize: number;
  anchorsConsidered: number;

  horizons: HorizonBacktestResult[];

  /**
   * Everything production computes that this backtest cannot reproduce from
   * stored history, named explicitly. An empty list would mean exact
   * reproduction; it is not empty, and pretending otherwise would be the
   * dishonest part.
   */
  reproductionGaps: string[];

  /** Always false here. Metrics are reported; confidence is not published. */
  confidencePublished: false;
  evaluatedAt: string;
}

/* ------------------------------------------------------------------------ *
 * TELEGRAM - SYSTEM ALERTS AND OPPORTUNITY LIFECYCLE
 * ------------------------------------------------------------------------ */

/**
 * Conditions about the SYSTEM, not about the market. They fire when the bot
 * stops being able to see or record the market - the cases where silence
 * would otherwise look identical to a calm market.
 */
export type SystemAlertKind =
  | 'BINANCE_OFFLINE'
  | 'BINANCE_RECOVERED'
  | 'DATA_STALE'
  | 'STORAGE_ERROR';

export interface TelegramSystemAlert {
  kind: SystemAlertKind;
  timestamp: number;
  /**
   * Identity of the CONDITION, not of the message. Two polls describing the
   * same outage share a state and only the first is sent.
   */
  state: string;
  detail: string;
}

/**
 * An opportunity is a position - one bank at one amount - that opens, moves
 * and closes. Reporting the phase is what keeps a live position from being
 * re-announced every poll.
 */
export type OpportunityPhase = 'DETECTED' | 'UPDATED' | 'CLOSED';

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
  /**
   * What Binance published about volume, per side, across every evaluated ad.
   *
   * ADDITIVE and purely descriptive - it changes no decision. It exists so a
   * cell can tell "nobody published any volume at all" (NO_LIQUIDITY) from
   * "volume exists but does not cover this amount" (INSUFFICIENT_LIQUIDITY).
   * evaluateAd rejects both as LIQUIDITY_INSUFFICIENT, correctly, but the two
   * mean very different things to someone deciding whether to wait.
   */
  buyLiquidity: Record<LiquidityStatus, number>;
  sellLiquidity: Record<LiquidityStatus, number>;
}

/* ------------------------------------------------------------------------ *
 * EXECUTABLE MATRIX
 *
 * The single structure the interface is allowed to present as a RATE.
 *
 * Every cell is one BANK x one AMOUNT, built from ads that passed evaluateAd
 * for that bank and that amount - bank verified by exact payType, amount
 * inside the ad's own limits, and published volume covering the operation.
 * A global best price can never reach this structure.
 * ------------------------------------------------------------------------ */

/**
 * What a cell is, in one word.
 *
 * EXECUTABLE is the ONLY value that means "you can run this operation at a
 * profit right now". Everything else is a specific, named absence - never a
 * zero, never a dash standing in for a price.
 */
export type CellStatus =
  /** Both legs executable AND the signed spread is strictly positive. */
  | 'EXECUTABLE'
  /** Both legs executable, but the spread is zero or negative. A loss is not an opportunity. */
  | 'NO_OPPORTUNITY'
  /** Ads exist for this bank and amount, but none published any volume above zero. */
  | 'NO_LIQUIDITY'
  /** Volume was published, and it does not cover this amount. */
  | 'INSUFFICIENT_LIQUIDITY'
  /** No ad of this bank covers this amount. */
  | 'NO_AD'
  /** The book behind this cell is older than the freshness window. */
  | 'STALE'
  /** A condition could not be established - unknown bank, or unpublished volume. */
  | 'NOT_VERIFIABLE'
  /** The query for this bank failed. Not the same as an empty book. */
  | 'ERROR';

/** One executable leg of a cell. Every field comes from the ad it names. */
export interface ExecutableSideView {
  price: number;
  advNo: string;
  merchant: string;
  /** The canonical Binance code that matched this bank exactly. */
  payType: string | null;
  paymentMethod: string | null;
  /** null when Binance published no volume. Never 0 standing in for unknown. */
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
  /** Why the status is what it is. Always present unless EXECUTABLE. */
  reason: string | null;

  /** RECOMPRA - what I pay. null when no ad of this bank can serve this amount. */
  buy: ExecutableSideView | null;
  /** VENTA - what I receive. */
  sell: ExecutableSideView | null;

  /**
   * ((venta - recompra) / recompra) * 100. SIGNED, denominator always the
   * repurchase. null unless both legs exist. Never absolute-valued.
   */
  spreadPct: number | null;
  /** min(buy, sell) when both published volume; null otherwise. Never invented. */
  availableUsdt: number | null;

  /**
   * The operation this cell represents, or null when there is none.
   *
   * THE single representation: the matrix, the opportunity card and Telegram
   * all read this object, so no consumer can arrive at a different price for
   * the same book.
   */
  opportunity: Opportunity | null;

  /** Per-leg diagnosis, so a blocked cell says which leg blocked it. */
  buyStatus: CellStatus;
  sellStatus: CellStatus;
  buyReason: string | null;
  sellReason: string | null;
  buyRejections: Record<string, number>;
  sellRejections: Record<string, number>;

  /** When the book behind this cell was captured. Real, never synthesised. */
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
  /** cells[bank][amountKey] */
  cells: Record<string, Record<string, ExecutableCell>>;
}

/**
 * The global market, kept deliberately apart from the matrix above.
 *
 * These prices are the level of the whole book with no bank filter and no
 * amount filter. They are legitimate CONTEXT and illegitimate as a quote:
 * nobody can execute at the median of every advertiser at once. The field
 * names say reference so no consumer has to remember the distinction.
 */
export interface MarketReference {
  referenceBuyPrice: number | null;
  referenceSellPrice: number | null;
  referenceSpreadPct: number | null;
  provenance: DataProvenance;
  capturedAt: number;
  ageSeconds: number;
  status: 'LIVE' | 'STALE' | 'OFFLINE';
  /** Stated in the payload itself, so it travels with the data. */
  executable: false;
  note: string;
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

/*
 * BankMatrixRow / BankRateCell REMOVED in FASE 5.
 *
 * They described a matrix built from ads filtered only by min/max - no bank
 * verification, no liquidity - whose "spreadPct" was the 0.01 VES undercut of
 * the leader expressed as a percentage. It was a second, weaker answer over
 * the same ads that evaluateBankTiers already answers correctly, and it was
 * the one the interface rendered. ExecutableCell / ExecutableMatrix replace it.
 */

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
