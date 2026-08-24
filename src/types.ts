export type TradeType = 'BUY' | 'SELL';

/**
 * Where a value came from. Mirrors server/types.ts - keep both in sync.
 * REAL       - observed directly from Binance.
 * AGGREGATED - computed from REAL observations.
 * PROJECTED  - an extrapolation about a moment that has not happened yet.
 * HEURISTIC  - a hand-written rule, hardcoded constant or invented fallback.
 */
export type DataProvenance = 'REAL' | 'AGGREGATED' | 'PROJECTED' | 'HEURISTIC' | 'STRATEGIC';

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

export interface BankRateItem {
  leaderPrice: number | null;
  suggestedPrice: number | null;
  spreadPct: number | null;
  availableMerchant?: string;
  orderCount?: number;
  adCount: number;
  provenance: DataProvenance;
  provenanceReason?: string;
}

export interface BankMatrixRow {
  bankKey: string;
  bankDisplayName: string;
  ratesByAmount: {
    [amountKey: string]: BankRateItem;
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
