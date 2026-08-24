/**
 * Binance P2P Data Service
 * Connects directly to Binance P2P public endpoints with validation and error handling.
 */

import {
  BinanceAdItem,
  BinanceP2PResponse,
  NormalizedAd,
  MarketSnapshot,
  Valued,
} from './types.js';

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

export const BANK_CODE_MAP: Record<string, { code: string; displayName: string; apiPayTypes: string[] }> = {
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
    apiPayTypes: ['BNC'],
  },
  BANCAMIGA: {
    code: 'BANCAMIGA',
    displayName: 'Bancamiga',
    apiPayTypes: ['Bancamiga'],
  },
  VENEZUELA: {
    code: 'VENEZUELA',
    displayName: 'Banco de Venezuela',
    apiPayTypes: ['BancodeVenezuela'],
  },
  PAGO_MOVIL: {
    code: 'PAGO_MOVIL',
    displayName: 'Pago Móvil',
    apiPayTypes: ['PagoMovil'],
  },
};

/** Rounds to the 2 decimals this market quotes in. */
function round2(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * Liquidity-weighted average price of a side. null when the side is empty or
 * when no ad reports any available amount - a weighted average with zero total
 * weight is undefined, not zero.
 */
function weightedAverage(ads: NormalizedAd[]): number | null {
  let totalVolume = 0;
  let weightedSum = 0;
  for (const ad of ads) {
    totalVolume += ad.availableUsdt;
    weightedSum += ad.price * ad.availableUsdt;
  }
  return totalVolume > 0 ? round2(weightedSum / totalVolume) : null;
}

export class BinanceP2PService {
  private static readonly ENDPOINT = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
  private static readonly TIMEOUT_MS = 12000;

  /**
   * Performs an authentic POST query to Binance P2P API
   */
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

      if (!response.ok) {
        throw new Error(`Binance HTTP error: ${response.status} ${response.statusText}`);
      }

      const json = (await response.json()) as BinanceP2PResponse;

      if (json.code !== '000000') {
        throw new Error(`Binance API code error: ${json.code} - ${json.message || 'Unknown error'}`);
      }

      if (!Array.isArray(json.data)) {
        throw new Error('Invalid data payload returned from Binance API');
      }

      return json.data;
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error(`Binance P2P request timed out after ${this.TIMEOUT_MS}ms`);
      }
      throw err;
    }
  }

  /**
   * Normalizes raw Binance Ad objects into validated numbers
   */
  public static normalizeAds(rawAds: BinanceAdItem[]): NormalizedAd[] {
    const list: NormalizedAd[] = [];

    for (const item of rawAds) {
      if (!item || !item.adv || !item.advertiser) continue;

      const price = parseFloat(item.adv.price);
      if (isNaN(price) || price <= 0) continue;

      const minAmountVes = parseFloat(item.adv.minSingleTransAmount) || 0;
      const maxAmountVes = parseFloat(item.adv.maxSingleTransAmount) || 0;
      const availableUsdt = parseFloat(item.adv.tradableQuantity || item.adv.surplusAmount) || 0;

      const paymentMethods = Array.isArray(item.adv.tradeMethods)
        ? item.adv.tradeMethods.map((m) => m.tradeMethodName || m.payType).filter(Boolean)
        : [];

      list.push({
        advNo: item.adv.advNo,
        price,
        minAmountVes,
        maxAmountVes,
        availableUsdt,
        merchantName: item.advertiser.nickName || 'Anónimo',
        userType: item.advertiser.userType || 'user',
        ordersCount: item.advertiser.monthOrderCount || 0,
        finishRate: item.advertiser.monthFinishRate || 0,
        paymentMethods,
      });
    }

    return list;
  }

  /**
   * Fetches real live market snapshot for both BUY and SELL sides concurrently
   */
  public static async fetchFullMarketSnapshot(filterBank?: string, filterAmount?: number): Promise<MarketSnapshot> {
    const startTime = Date.now();
    let payTypes: string[] = [];

    if (filterBank && BANK_CODE_MAP[filterBank]) {
      payTypes = BANK_CODE_MAP[filterBank].apiPayTypes;
    }

    // Query BUY side (Taker buys USDT, paying VES)
    // Query SELL side (Taker sells USDT, receiving VES)
    const [rawBuyAds, rawSellAds] = await Promise.all([
      this.queryP2PAds({
        tradeType: 'BUY',
        payTypes,
        transAmount: filterAmount || null,
        rows: 20,
      }),
      this.queryP2PAds({
        tradeType: 'SELL',
        payTypes,
        transAmount: filterAmount || null,
        rows: 20,
      }),
    ]);

    const topBuyAds = this.normalizeAds(rawBuyAds);
    const topSellAds = this.normalizeAds(rawSellAds);

    if (topBuyAds.length === 0 && topSellAds.length === 0) {
      throw new Error('No active P2P ads found for the specified criteria.');
    }

    // Calculate real stats.
    // C2: a side with no ads yields null everywhere. Nothing is derived from
    // the opposite side and nothing defaults to 0 - an absent price is absent.
    const buyPrices = topBuyAds.map((a) => a.price).sort((a, b) => a - b);
    const sellPrices = topSellAds.map((a) => a.price).sort((a, b) => b - a);

    const hasBuySide = buyPrices.length > 0;
    const hasSellSide = sellPrices.length > 0;

    // Buy side (Taker pays VES to buy USDT): best price is the lowest ask.
    const bestBuyPrice = hasBuySide ? round2(buyPrices[0]) : null;
    // Sell side: best price is the highest bid.
    const bestSellPrice = hasSellSide ? round2(sellPrices[0]) : null;

    const averageBuyPrice = hasBuySide
      ? round2(buyPrices.reduce((acc, p) => acc + p, 0) / buyPrices.length)
      : null;
    const averageSellPrice = hasSellSide
      ? round2(sellPrices.reduce((acc, p) => acc + p, 0) / sellPrices.length)
      : null;

    const medianBuyPrice = hasBuySide ? round2(buyPrices[Math.floor(buyPrices.length / 2)]) : null;
    const medianSellPrice = hasSellSide
      ? round2(sellPrices[Math.floor(sellPrices.length / 2)])
      : null;

    const weightedBuyPrice = weightedAverage(topBuyAds);
    const weightedSellPrice = weightedAverage(topSellAds);

    // A spread needs two prices. With one side missing there is no spread.
    const spreadAbsolute =
      bestBuyPrice !== null && bestSellPrice !== null
        ? round2(Math.abs(bestBuyPrice - bestSellPrice))
        : null;
    const basePrice =
      bestBuyPrice !== null && bestSellPrice !== null
        ? Math.min(bestBuyPrice, bestSellPrice)
        : null;
    const spreadPercentage =
      spreadAbsolute !== null && basePrice !== null && basePrice > 0
        ? round2((spreadAbsolute / basePrice) * 100)
        : null;

    const missingSide = (side: 'BUY' | 'SELL') =>
      `El lado ${side} no devolvio anuncios. No hay precio: la ausencia es el dato.`;

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
      topBuyAds: topBuyAds.slice(0, 10),
      topSellAds: topSellAds.slice(0, 10),
      source: 'BINANCE_P2P',
      fetchDurationMs: duration,
      status: 'LIVE',
      lastError: null,
      bestBuy,
      bestSell,
      aggregatesProvenance: 'AGGREGATED',
      orderBookProvenance: 'REAL',
    };
  }
}
