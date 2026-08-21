export type TradeType = 'BUY' | 'SELL';

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
  bestBuyPrice: number;
  bestSellPrice: number;
  averageBuyPrice: number;
  averageSellPrice: number;
  medianBuyPrice: number;
  medianSellPrice: number;
  weightedBuyPrice: number;
  weightedSellPrice: number;
  spreadAbsolute: number;
  spreadPercentage: number;
  topBuyAds: NormalizedAd[];
  topSellAds: NormalizedAd[];
  source: 'BINANCE_P2P';
  fetchDurationMs: number;
  status: 'LIVE' | 'STALE' | 'OFFLINE';
  lastError: string | null;
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
}

export type MarketTrend = 'ALCISTA' | 'BAJISTA' | 'LATERAL';
export type MomentumLevel = 'ALTO' | 'MODERADO' | 'NEUTRO' | 'NEGATIVO';
export type VolatilityLevel = 'ALTA' | 'MEDIA' | 'BAJA';
export type RiskLevel = 'BAJO' | 'MEDIO' | 'ALTO';

export interface MarketAnalysis {
  trend: MarketTrend;
  trendStrength: number;
  momentum: MomentumLevel;
  volatility: VolatilityLevel;
  volatilityPct: number;
  priceVsSmaPct: number;
  rsi: number;
  supportLevel: number;
  resistanceLevel: number;
  summaryText: string;
  reasons: string[];
}

export interface HourlyProjectionItem {
  horizon: string;
  targetTime: string;
  projectedBuy: number;
  projectedSell: number;
  rangeMin: number;
  rangeMax: number;
  confidence: number;
}

export interface MerchantDecisionAdvice {
  action: 'VENDER_AHORA' | 'MANTENER_INVENTARIO' | 'RECOMPRAR_AHORA' | 'ESPERAR_RETROCESO' | 'ARBITRAJE_RAPIDO';
  actionTitle: string;
  actionExplanation: string;
  optimalSellTimeWindow: string;
  optimalBuyTimeWindow: string;
  projectedPeakRate: number;
  projectedTroughRate: number;
  estimatedNetProfitPer1000UsdtVes: number;
  orderBookPressure: {
    buyVolumeUsdt: number;
    sellVolumeUsdt: number;
    buyPressurePct: number;
    sellPressurePct: number;
    dominantSide: 'COMPRA' | 'VENTA' | 'EQUILIBRADO';
  };
}

export interface MarketProjections {
  hasSufficientData: boolean;
  insufficientDataReason?: string;
  currentBuyPrice: number;
  currentSellPrice: number;
  daily: {
    floor: number;
    ceiling: number;
    rangeText: string;
    direction: MarketTrend;
    confidencePct: number;
    spreadMaxExpected: number;
    reasons: string[];
  };
  intradayHorizons: HourlyProjectionItem[];
  probabilities: {
    up: number;
    neutral: number;
    down: number;
  };
  hourlyTimeline: HourlyChartPoint[];
  merchantAdvice: MerchantDecisionAdvice;
  risk: {
    level: RiskLevel;
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
