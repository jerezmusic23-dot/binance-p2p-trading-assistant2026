/**
 * EL CONTEXTO DE MERCADO QUE LA CAPTURA YA CONOCE
 * ===============================================
 *
 * Traduce un `MarketSnapshot` a la capa v3 de `HistoryRecord`: liquidez,
 * profundidad y nivel ponderado por volumen.
 */

import type { HistoryRecord, MarketSnapshot, NormalizedAd } from './types.js';

export interface SideLiquidity {
  usdt: number | null;
  ads: number;
}

export function sumSideLiquidity(ads: readonly NormalizedAd[]): SideLiquidity {
  let usdt = 0;
  let counted = 0;

  for (const ad of ads ?? []) {
    const reported = ad?.availableUsdtReported;
    if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) continue;
    usdt += reported;
    counted += 1;
  }

  return { usdt: counted > 0 ? usdt : null, ads: counted };
}

function positiveOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Contexto persistido junto a cada captura general.
 *
 * Dos marcas de procedencia independientes, una por cada capa:
 *
 * `generalReferenceVersion` va en TODO registro que pase por aquí, tenga o no
 * liquidez detrás: marca que su buyPrice/sellPrice se calcularon ya excluyendo
 * Recarga Pines (`filterGeneralReferenceAds`). Los registros anteriores a esta
 * versión no la llevan - no porque se les haya quitado nada, sino porque nadie
 * puede afirmar retroactivamente si un anuncio de Recarga Pines participó en
 * su precio. `dailyProjection.ts` cuenta ambos grupos y lo dice.
 *
 * `enrichmentVersion` (v3, previa a la anterior) sólo se marca cuando la
 * captura realmente trajo algo de la capa de liquidez/profundidad detrás -
 * `validateHistoryRecord` sólo exige esos campos cuando la marca está puesta.
 */
export function buildMarketContext(snapshot: MarketSnapshot): Partial<HistoryRecord> {
  const buy = sumSideLiquidity(snapshot?.topBuyAds ?? []);
  const sell = sumSideLiquidity(snapshot?.topSellAds ?? []);

  const context: Partial<HistoryRecord> = {
    generalReferenceVersion: 'v4-no-recarga-pines',
  };

  let hasEnrichment = false;

  if (buy.usdt !== null) {
    context.buyLiquidityUsdt = buy.usdt;
    context.buyLiquidityAds = buy.ads;
    hasEnrichment = true;
  }
  if (sell.usdt !== null) {
    context.sellLiquidityUsdt = sell.usdt;
    context.sellLiquidityAds = sell.ads;
    hasEnrichment = true;
  }

  const weightedBuy = positiveOrUndefined(snapshot?.weightedBuyPrice);
  const weightedSell = positiveOrUndefined(snapshot?.weightedSellPrice);
  if (weightedBuy !== undefined) { context.weightedBuyPrice = weightedBuy; hasEnrichment = true; }
  if (weightedSell !== undefined) { context.weightedSellPrice = weightedSell; hasEnrichment = true; }

  const spread = finiteOrUndefined(snapshot?.spreadAbsolute);
  if (spread !== undefined) { context.spreadAbsolute = spread; hasEnrichment = true; }

  if (hasEnrichment) context.enrichmentVersion = 'v3-context';

  if (snapshot?.status === 'LIVE' || snapshot?.status === 'STALE' || snapshot?.status === 'OFFLINE') {
    context.captureStatus = snapshot.status;
  }

  return context;
}
