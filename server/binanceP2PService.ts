/**
 * Binance P2P Data Service
 * Connects directly to Binance P2P public endpoints with validation and error handling.
 */

import { BinanceAdItem, BinanceP2PResponse, NormalizedAd, MarketSnapshot } from './types.js';

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

    // Calculate real stats
    // Buy side (Taker pays VES to buy USDT): Best price is lowest price among ads
    const buyPrices = topBuyAds.map((a) => a.price).sort((a, b) => a - b);
    const sellPrices = topSellAds.map((a) => a.price).sort((a, b) => b - a);

    const bestBuyPrice = buyPrices[0] || (sellPrices[0] ? sellPrices[0] * 1.01 : 0);
    const bestSellPrice = sellPrices[0] || (buyPrices[0] ? buyPrices[0] * 0.99 : 0);

    const averageBuyPrice = buyPrices.length
      ? buyPrices.reduce((acc, p) => acc + p, 0) / buyPrices.length
      : bestBuyPrice;

    const averageSellPrice = sellPrices.length
      ? sellPrices.reduce((acc, p) => acc + p, 0) / sellPrices.length
      : bestSellPrice;

    const medianBuyPrice = buyPrices.length ? buyPrices[Math.floor(buyPrices.length / 2)] : bestBuyPrice;
    const medianSellPrice = sellPrices.length ? sellPrices[Math.floor(sellPrices.length / 2)] : bestSellPrice;

    // Weighted averages by available USDT liquidity
    let totalBuyVolume = 0;
    let weightedBuySum = 0;
    topBuyAds.forEach((ad) => {
      totalBuyVolume += ad.availableUsdt;
      weightedBuySum += ad.price * ad.availableUsdt;
    });
    const weightedBuyPrice = totalBuyVolume > 0 ? weightedBuySum / totalBuyVolume : averageBuyPrice;

    let totalSellVolume = 0;
    let weightedSellSum = 0;
    topSellAds.forEach((ad) => {
      totalSellVolume += ad.availableUsdt;
      weightedSellSum += ad.price * ad.availableUsdt;
    });
    const weightedSellPrice = totalSellVolume > 0 ? weightedSellSum / totalSellVolume : averageSellPrice;

    const spreadAbsolute = Math.abs(bestBuyPrice - bestSellPrice);
    const basePrice = Math.min(bestBuyPrice, bestSellPrice);
    const spreadPercentage = basePrice > 0 ? (spreadAbsolute / basePrice) * 100 : 0;

    const duration = Date.now() - startTime;

    return {
      timestamp: Date.now(),
      isoDate: new Date().toISOString(),
      asset: 'USDT',
      fiat: 'VES',
      bestBuyPrice: Number(bestBuyPrice.toFixed(2)),
      bestSellPrice: Number(bestSellPrice.toFixed(2)),
      averageBuyPrice: Number(averageBuyPrice.toFixed(2)),
      averageSellPrice: Number(averageSellPrice.toFixed(2)),
      medianBuyPrice: Number(medianBuyPrice.toFixed(2)),
      medianSellPrice: Number(medianSellPrice.toFixed(2)),
      weightedBuyPrice: Number(weightedBuyPrice.toFixed(2)),
      weightedSellPrice: Number(weightedSellPrice.toFixed(2)),
      spreadAbsolute: Number(spreadAbsolute.toFixed(2)),
      spreadPercentage: Number(spreadPercentage.toFixed(2)),
      topBuyAds: topBuyAds.slice(0, 10),
      topSellAds: topSellAds.slice(0, 10),
      source: 'BINANCE_P2P',
      fetchDurationMs: duration,
      status: 'LIVE',
      lastError: null,
    };
  }
}
