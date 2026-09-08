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
import { describeSide, detectOutliers, round2, signedSpreadPct, weightedAverage } from './marketStatistics.js';
import { classifySide, exclusionRow } from './adQuality.js';

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

/**
 * La bandera de promoción que Binance haya publicado, sin deducir nada.
 *
 * ═══ LIMITACIÓN, DECLARADA ═══
 *
 * No se ha podido inspeccionar una respuesta RAW real de
 * `/bapi/c2c/v2/friendly/c2c/adv/search` desde este entorno (el proxy de
 * egreso deniega el host), así que el NOMBRE del campo que Binance usa para
 * marcar un anuncio promocionado NO está confirmado. Aquí se leen sólo
 * booleanos ESTRICTAMENTE `true` en campos con nombre de promoción; cualquier
 * otra cosa devuelve `null`.
 *
 * `null` = DESCONOCIDO, jamás "no promocionado". No se infiere promoción del
 * precio, del volumen ni de la posición en la lista: una heurística que
 * convirtiera anuncios normales en PROMOTED sería exactamente el tipo de dato
 * inventado que este proyecto no admite.
 *
 * Cuando se disponga de un RAW real, basta comprobar el nombre real del campo
 * y añadirlo a `PROMOTION_KEYS`.
 */
const PROMOTION_KEYS = ['isPromoted', 'promoted', 'advPromoted'] as const;

function readPromotedFlag(adv: unknown): boolean | null {
  if (adv === null || typeof adv !== 'object') return null;
  const record = adv as Record<string, unknown>;
  for (const key of PROMOTION_KEYS) {
    if (record[key] === true) return true;
  }
  return null;
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
        promoted: readPromotedFlag(item.adv),
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

    /*
     * CALIDAD ANTES DEL EXTREMO.
     *
     * `bestBuyPrice` es un MÍNIMO y `bestSellPrice` un MÁXIMO, así que un solo
     * anuncio anómalo se convierte en el precio del mercado. Medido sobre
     * precios reales: un anuncio a 920.659 en el lado BUY movía bestBuyPrice de
     * 969.30 a 920.66 y el spread de +0.0878% a +5.3756%.
     *
     * Los anuncios apartados NO se borran de `topBuyAds`/`topSellAds`: la UI
     * sigue viendo el libro entero y `qualityExcluded` dice cuáles no cuentan y
     * por qué. Lo que cambia es de qué anuncios sale el precio.
     */
    const buyClass = classifySide(topBuyAds, topSellAds, 'ASK');
    const sellClass = classifySide(topSellAds, topBuyAds, 'BID');
    const qualityExcluded = [
      ...buyClass.notNormal.map((c) => exclusionRow(c, 'BUY')),
      ...sellClass.notNormal.map((c) => exclusionRow(c, 'SELL')),
    ];

    /*
     * DOS ESTADÍSTICOS, DOS POBLACIONES.
     *
     * El EXTREMO describe con quién puedo operar -> anuncios ejecutables.
     * La MEDIANA describe dónde está el mercado  -> anuncios de referencia
     * (que excluyen además las colocaciones pagadas).
     */
    const buyExecStats = describeSide(buyClass.executionEligible.map((a) => a.price));
    const sellExecStats = describeSide(sellClass.executionEligible.map((a) => a.price));

    const buyEligiblePrices = buyClass.referenceEligible.map((a) => a.price);
    const sellEligiblePrices = sellClass.referenceEligible.map((a) => a.price);
    const buyStats = describeSide(buyEligiblePrices);
    const sellStats = describeSide(sellEligiblePrices);

    /*
     * VIGILANCIA DEL NIVEL ESTRATÉGICO (D3).
     *
     * `detectOutliers` no decide elegibilidad - se comprobó que sobre un libro
     * apretado marca el mejor precio legítimo, y que con MAD 0 no marca nada -
     * pero es exactamente la herramienta para la que fue escrita: avisar de que
     * la MEDIANA se está calculando sobre una distribución que aún contiene
     * valores lejanos. Es un aviso auditable, no una puerta.
     */
    const buyWatch = detectOutliers(buyEligiblePrices);
    const sellWatch = detectOutliers(sellEligiblePrices);
    const strategicOutlierWatch = {
      buyFlagged: buyWatch.outlierIndices.length,
      sellFlagged: sellWatch.outlierIndices.length,
      buyDecidable: buyWatch.isDecidable,
      sellDecidable: sellWatch.isDecidable,
    };
    const hasBuySide = buyExecStats.count > 0;
    const hasSellSide = sellExecStats.count > 0;

    const bestBuyPrice = round2(buyExecStats.min);
    const bestSellPrice = round2(sellExecStats.max);
    const averageBuyPrice = round2(buyStats.mean);
    const averageSellPrice = round2(sellStats.mean);
    const medianBuyPrice = round2(buyStats.median);
    const medianSellPrice = round2(sellStats.median);
    const weightedBuyPrice = liquidityWeightedPrice(buyClass.referenceEligible);
    const weightedSellPrice = liquidityWeightedPrice(sellClass.referenceEligible);

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
      qualityExcluded,
      strategicOutlierWatch,
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
