/**
 * Binance P2P Data Service
 * Connects directly to Binance P2P public endpoints with validation and error handling.
 */

import {
  BankCodeConfig,
  BinanceAdItem,
  BinanceP2PResponse,
  NormalizedAd,
  MarketSnapshot,
  Valued,
} from './types.js';
import { describeSide, round2, signedSpreadPct, weightedAverage } from './marketStatistics.js';

export interface P2PSearchParams {
  asset?: string;
  fiat?: string;
  tradeType?: 'BUY' | 'SELL';
  page?: number;
  rows?: number;
  payTypes?: string[];
  transAmount?: string | number | null;
  publisherType?: 'merchant' | null;
  merchantCheck?: boolean;
}

export const BANK_CODE_MAP: Record<string, BankCodeConfig> = {
  BANESCO: {
    code: 'BANESCO',
    displayName: 'Banesco',
    apiPayTypes: ['Banesco'],
  },
  PROVINCIAL: {
    code: 'PROVINCIAL',
    displayName: 'Provincial (BBVA)',
    apiPayTypes: ['BBVAProvincial', 'Provincial'],
  },
  MERCANTIL: {
    code: 'MERCANTIL',
    displayName: 'Mercantil',
    apiPayTypes: ['Mercantil'],
  },
  BNC: {
    code: 'BNC',
    displayName: 'BNC',
    apiPayTypes: ['BNCBancoNacional'],
  },
  BANCAMIGA: {
    code: 'BANCAMIGA',
    displayName: 'Bancamiga',
    apiPayTypes: ['Bancamiga'],
  },
  VENEZUELA: {
    code: 'VENEZUELA',
    displayName: 'Banco de Venezuela',
    apiPayTypes: ['BancoDeVenezuela'],
  },
  PAGO_MOVIL: {
    code: 'PAGO_MOVIL',
    displayName: 'Pago Móvil',
    apiPayTypes: ['PagoMovil'],
  },
};

/**
 * Payment rails that are valid Binance P2P methods but are NOT a reliable
 * reference for the general USDT/VES market projection.
 *
 * Binance exposes Recarga Pines as its own P2P payment-method market, so its
 * prices must never define the general bank-transfer market reference.
 */
export const GENERAL_REFERENCE_EXCLUDED_PAY_TYPES = new Set(['recargapines']);

function canonicalPaymentName(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function isExcludedFromGeneralReference(ad: NormalizedAd): boolean {
  return ad.paymentOptions.some((method) => {
    const payType = canonicalPaymentName(method.payType);
    const methodName = canonicalPaymentName(method.tradeMethodName);
    return (
      GENERAL_REFERENCE_EXCLUDED_PAY_TYPES.has(payType) ||
      GENERAL_REFERENCE_EXCLUDED_PAY_TYPES.has(methodName) ||
      payType.includes('recargapines') ||
      methodName.includes('recargapines')
    );
  });
}

export function filterGeneralReferenceAds(ads: readonly NormalizedAd[]): NormalizedAd[] {
  return ads.filter((ad) => !isExcludedFromGeneralReference(ad));
}

function liquidityWeightedPrice(ads: NormalizedAd[]): number | null {
  return round2(
    weightedAverage(ads.map((ad) => ({ value: ad.price, weight: ad.availableUsdt })))
  );
}

export class BinanceP2PService {
  private static readonly ENDPOINT = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
  private static readonly TIMEOUT_MS = 12000;

  public static async queryP2PAds(params: P2PSearchParams = {}): Promise<BinanceAdItem[]> {
    const payload = {
      asset: params.asset || 'USDT',
      fiat: params.fiat || 'VES',
      merchantCheck: params.merchantCheck ?? false,
      page: params.page || 1,
      rows: params.rows || 20,
      payTypes: params.payTypes && params.payTypes.length > 0 ? params.payTypes : [],
      publisherType: params.publisherType || null,
      tradeType: params.tradeType || 'BUY',
      transAmount: params.transAmount ? String(params.transAmount) : null,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    try {
      const response = await fetch(this.ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Origin': 'https://p2p.binance.com',
          'clientType': 'web',
          'Cache-Control': 'no-cache',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`Binance HTTP error: ${response.status} ${response.statusText}`);

      const json = (await response.json()) as BinanceP2PResponse;
      if (json.code !== '000000') throw new Error(`Binance API code error: ${json.code} - ${json.message || 'Unknown error'}`);
      if (!Array.isArray(json.data)) throw new Error('Invalid data payload returned from Binance API');
      return json.data;
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') throw new Error(`Binance P2P request timed out after ${this.TIMEOUT_MS}ms`);
      throw err;
    }
  }

  public static normalizeAds(rawAds: BinanceAdItem[]): NormalizedAd[] {
    const list: NormalizedAd[] = [];

    for (const item of rawAds) {
      if (!item || !item.adv || !item.advertiser) continue;

      const price = parseFloat(item.adv.price);
      if (!Number.isFinite(price) || price <= 0) continue;

      const minAmountVes = parseFloat(item.adv.minSingleTransAmount);
      const maxAmountVes = parseFloat(item.adv.maxSingleTransAmount);
      if (!Number.isFinite(minAmountVes) || minAmountVes < 0) continue;
      if (!Number.isFinite(maxAmountVes) || maxAmountVes < 0) continue;

      const reportedAvailable = parseFloat(item.adv.tradableQuantity || item.adv.surplusAmount);
      const availableUsdtReported = Number.isFinite(reportedAvailable) && reportedAvailable >= 0 ? reportedAvailable : null;
      const availableUsdt = availableUsdtReported ?? 0;

      const tradeMethods = Array.isArray(item.adv.tradeMethods) ? item.adv.tradeMethods : [];
      const paymentMethods = tradeMethods.map((m) => m.tradeMethodName || m.payType).filter(Boolean);
      const paymentOptions = tradeMethods.map((m) => ({
        payType: m.payType ?? null,
        tradeMethodName: m.tradeMethodName ?? null,
      }));

      list.push({
        advNo: item.adv.advNo,
        price,
        minAmountVes,
        maxAmountVes,
        availableUsdt,
        availableUsdtReported,
        merchantName: item.advertiser.nickName || 'Anónimo',
        userType: item.advertiser.userType || 'user',
        ordersCount: item.advertiser.monthOrderCount || 0,
        finishRate: item.advertiser.monthFinishRate || 0,
        paymentMethods,
        paymentOptions,
      });
    }

    return list;
  }

  public static async fetchFullMarketSnapshot(filterBank?: string, filterAmount?: number): Promise<MarketSnapshot> {
    const startTime = Date.now();
    let payTypes: string[] = [];

    if (filterBank && BANK_CODE_MAP[filterBank]) payTypes = BANK_CODE_MAP[filterBank].apiPayTypes;

    const [rawBuyAds, rawSellAds] = await Promise.all([
      this.queryP2PAds({ tradeType: 'BUY', payTypes, transAmount: filterAmount || null, rows: 20 }),
      this.queryP2PAds({ tradeType: 'SELL', payTypes, transAmount: filterAmount || null, rows: 20 }),
    ]);

    const normalizedBuyAds = this.normalizeAds(rawBuyAds);
    const normalizedSellAds = this.normalizeAds(rawSellAds);
    const isGeneralReference = !filterBank && filterAmount == null;
    const topBuyAds = isGeneralReference ? filterGeneralReferenceAds(normalizedBuyAds) : normalizedBuyAds;
    const topSellAds = isGeneralReference ? filterGeneralReferenceAds(normalizedSellAds) : normalizedSellAds;

    if (topBuyAds.length === 0 && topSellAds.length === 0) {
      throw new Error('No active P2P ads found for the specified criteria after reference filtering.');
    }

    const buyStats = describeSide(topBuyAds.map((a) => a.price));
    const sellStats = describeSide(topSellAds.map((a) => a.price));
    const hasBuySide = buyStats.count > 0;
    const hasSellSide = sellStats.count > 0;

    const bestBuyPrice = round2(buyStats.min);
    const bestSellPrice = round2(sellStats.max);
    const averageBuyPrice = round2(buyStats.mean);
    const averageSellPrice = round2(sellStats.mean);
    const medianBuyPrice = round2(buyStats.median);
    const medianSellPrice = round2(sellStats.median);
    const weightedBuyPrice = liquidityWeightedPrice(topBuyAds);
    const weightedSellPrice = liquidityWeightedPrice(topSellAds);

    const spreadAbsolute = bestBuyPrice !== null && bestSellPrice !== null ? round2(bestSellPrice - bestBuyPrice) : null;
    const spreadPercentage = signedSpreadPct(bestSellPrice, bestBuyPrice);
    const missingSide = (side: 'BUY' | 'SELL') => `El lado ${side} no devolvio anuncios. No hay precio: la ausencia es el dato.`;

    const strategicBuyPrice = medianBuyPrice;
    const strategicSellPrice = medianSellPrice;
    const strategicSpreadPct = round2(signedSpreadPct(strategicSellPrice, strategicBuyPrice));
    const strategicReason = strategicBuyPrice === null && strategicSellPrice === null
      ? 'Ningun lado del libro devolvio anuncios: no hay precio estrategico.'
      : strategicBuyPrice === null
        ? missingSide('BUY')
        : strategicSellPrice === null
          ? missingSide('SELL')
          : null;

    const bestBuy: Valued<number | null> = hasBuySide
      ? { value: bestBuyPrice, provenance: 'REAL' }
      : { value: null, provenance: 'REAL', reason: missingSide('BUY') };
    const bestSell: Valued<number | null> = hasSellSide
      ? { value: bestSellPrice, provenance: 'REAL' }
      : { value: null, provenance: 'REAL', reason: missingSide('SELL') };

    const duration = Date.now() - startTime;

    return {
      timestamp: Date.now(),
      isoDate: new Date().toISOString(),
      asset: 'USDT',
      fiat: 'VES',
      bestBuyPrice,
      bestSellPrice,
      averageBuyPrice,
      averageSellPrice,
      medianBuyPrice,
      medianSellPrice,
      weightedBuyPrice,
      weightedSellPrice,
      spreadAbsolute,
      spreadPercentage,
      strategicBuyPrice,
      strategicSellPrice,
      strategicSpreadPct,
      strategicReason,
      topBuyAds,
      topSellAds,
      source: 'BINANCE_P2P',
      fetchDurationMs: duration,
      status: 'LIVE',
      lastError: null,
      bestBuy,
      bestSell,
      aggregatesProvenance: 'AGGREGATED',
      orderBookProvenance: 'REAL',
      strategicProvenance: 'STRATEGIC',
    };
  }
}
