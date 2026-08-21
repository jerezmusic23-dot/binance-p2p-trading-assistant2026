/**
 * Core type definitions for Binance P2P Trading Assistant
 * Single Source of Truth for Data Contracts
 */

export type TradeType = 'BUY' | 'SELL';

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
  
  // Real raw prices from top ads (The exact ads on the book)
  bestBuyPrice: number; // Lowest price to buy USDT (Taker pays VES to get USDT)
  bestSellPrice: number; // Highest price to sell USDT (Taker gives USDT to get VES)
  
  // Aggregate stats (clearly labeled as aggregated)
  averageBuyPrice: number;
  averageSellPrice: number;
  medianBuyPrice: number;
  medianSellPrice: number;
  weightedBuyPrice: number;
  weightedSellPrice: number;
  
  spreadAbsolute: number; // Sell price - Buy price or spread difference
  spreadPercentage: number; // ((Sell - Buy) / Buy) * 100
  
  // Raw ad lists
  topBuyAds: NormalizedAd[];
  topSellAds: NormalizedAd[];
  
  // Health & Source metadata
  source: 'BINANCE_P2P';
  fetchDurationMs: number;
  status: 'LIVE' | 'STALE' | 'OFFLINE';
  lastError: string | null;
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
}

export type MarketTrend = 'ALCISTA' | 'BAJISTA' | 'LATERAL';
export type MomentumLevel = 'ALTO' | 'MODERADO' | 'NEUTRO' | 'NEGATIVO';
export type VolatilityLevel = 'ALTA' | 'MEDIA' | 'BAJA';
export type RiskLevel = 'BAJO' | 'MEDIO' | 'ALTO';

export interface MarketAnalysis {
  trend: MarketTrend;
  trendStrength: number; // 0 to 100
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
  horizon: string; // "+1H", "+2H", "+4H", "+6H", "+12H", "+24H"
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
    floor: number; // Piso del día
    ceiling: number; // Techo del día
    rangeText: string;
    direction: MarketTrend;
    confidencePct: number;
    spreadMaxExpected: number;
    reasons: string[];
  };
  
  intradayHorizons: HourlyProjectionItem[];
  
  probabilities: {
    up: number; // Probabilidad subir %
    neutral: number; // Probabilidad mantener %
    down: number; // Probabilidad bajar %
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
