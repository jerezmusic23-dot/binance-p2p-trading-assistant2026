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

/** Liquidity-weighted average price of one side, or null when no ad reports volume. */
function liquidityWeightedPrice(ads: NormalizedAd[]): number | null {
  return round2(
    weightedAverage(ads.map((ad) => ({ value: ad.price, weight: ad.availableUsdt })))
  );
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

      const tradeMethods = Array.isArray(item.adv.tradeMethods) ? item.adv.tradeMethods : [];

      // UNCHANGED: the human-readable list existing consumers already read.
      const paymentMethods = tradeMethods.map((m) => m.tradeMethodName || m.payType).filter(Boolean);

      /*
       * FASE 3: Binance's payment methods kept VERBATIM, canonical code
       * included. paymentMethods above collapses payType into
       * tradeMethodName, so the canonical code ('BBVAProvincial') was lost
       * and only the label ('Provincial (BBVA)') survived - a label that does
       * not equal any code in BANK_CODE_MAP.apiPayTypes. Bank verification
       * compares against payType and nothing else.
       */
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
    //
    // FASE 2: every descriptive statistic now comes from marketStatistics, so
    // BUY and SELL use identical definitions. The previous code sorted BUY
    // ascending and SELL descending and then indexed [floor(n/2)] on both,
    // which returned a different middle element per side for an even count.
    const buyStats = describeSide(topBuyAds.map((a) => a.price));
    const sellStats = describeSide(topSellAds.map((a) => a.price));

    const hasBuySide = buyStats.count > 0;
    const hasSellSide = sellStats.count > 0;

    // Buy side (Taker pays VES to buy USDT): best price is the lowest ask.
    const bestBuyPrice = round2(buyStats.min);
    // Sell side: best price is the highest bid.
    const bestSellPrice = round2(sellStats.max);

    const averageBuyPrice = round2(buyStats.mean);
    const averageSellPrice = round2(sellStats.mean);

    const medianBuyPrice = round2(buyStats.median);
    const medianSellPrice = round2(sellStats.median);

    const weightedBuyPrice = liquidityWeightedPrice(topBuyAds);
    const weightedSellPrice = liquidityWeightedPrice(topSellAds);

    // A spread needs two prices. With one side missing there is no spread.
    // NOTE: still the RAW extreme spread. FASE 3 replaces this with the signed
    // strategic spread computed from the medians.
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

    /*
     * STRATEGIC PRICES.
     *
     * RECOMPRA = Binance BUY, VENTA = Binance SELL. Both are taken as the
     * MEDIAN of their side, which is where the market actually is. The
     * extremes above (min BUY / max SELL) estimate the tail of the ad
     * population: one distant ad at 980 VES moves max(SELL) by 58 VES and
     * leaves the median untouched. They stay in the snapshot as the raw audit
     * trail, but nothing decides on them any more.
     */
    const strategicBuyPrice = medianBuyPrice;
    const strategicSellPrice = medianSellPrice;

    // Signed on purpose: venta below recompra is a LOSS and has to stay
    // distinguishable from a gain. Denominator is always the repurchase price.
    const strategicSpreadPct = round2(signedSpreadPct(strategicSellPrice, strategicBuyPrice));

    const strategicReason =
      strategicBuyPrice === null && strategicSellPrice === null
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
      strategicProvenance: 'STRATEGIC',
    };
  }
}
