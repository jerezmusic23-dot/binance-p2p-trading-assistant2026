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
 * `generalReferenceVersion` marks observations captured after the general
 * reference was made independent of Recarga Pines. Older history has no
 * payment-method provenance, so the projection must not treat it as verified.
 */
export function buildMarketContext(snapshot: MarketSnapshot): Partial<HistoryRecord> {
  const buy = sumSideLiquidity(snapshot?.topBuyAds ?? []);
  const sell = sumSideLiquidity(snapshot?.topSellAds ?? []);

  const context: Partial<HistoryRecord> = {
    generalReferenceVersion: 'v4-no-recarga-pines',
  } as Partial<HistoryRecord>;

  if (buy.usdt !== null) {
    context.buyLiquidityUsdt = buy.usdt;
    context.buyLiquidityAds = buy.ads;
  }
  if (sell.usdt !== null) {
    context.sellLiquidityUsdt = sell.usdt;
    context.sellLiquidityAds = sell.ads;
  }

  const weightedBuy = positiveOrUndefined(snapshot?.weightedBuyPrice);
  const weightedSell = positiveOrUndefined(snapshot?.weightedSellPrice);
  if (weightedBuy !== undefined) context.weightedBuyPrice = weightedBuy;
  if (weightedSell !== undefined) context.weightedSellPrice = weightedSell;

  const spread = finiteOrUndefined(snapshot?.spreadAbsolute);
  if (spread !== undefined) context.spreadAbsolute = spread;

  if (snapshot?.status === 'LIVE' || snapshot?.status === 'STALE' || snapshot?.status === 'OFFLINE') {
    context.captureStatus = snapshot.status;
  }

  return context;
}
