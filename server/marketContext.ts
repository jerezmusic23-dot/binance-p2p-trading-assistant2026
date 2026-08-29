/**
 * EL CONTEXTO DE MERCADO QUE LA CAPTURA YA CONOCE
 * ===============================================
 *
 * Traduce un `MarketSnapshot` a la capa v3 de `HistoryRecord`: liquidez,
 * profundidad y nivel ponderado por volumen.
 *
 * POR QUÉ EXISTE
 *
 * Cada captura ya calculaba estos valores y los tiraba al persistir. Una
 * proyección construida sólo sobre el precio no puede distinguir un movimiento
 * sostenido por volumen de otro que ocurre sobre un libro vacío, y ésos no son
 * el mismo mercado. Sin liquidez en el histórico, esa distinción es
 * irrecuperable: no se puede reconstruir a posteriori lo que no se guardó.
 *
 * LO QUE NO HACE
 *
 * No deriva, no rellena y no colapsa ausencias a cero. Un anuncio que no
 * publicó volumen no cuenta como "cero USDT disponibles": cuenta como que no
 * se sabe, y por eso se guarda aparte cuántos anuncios sí lo publicaron. Una
 * suma de 0 sobre 12 anuncios que reportan es un libro seco; una suma de 0
 * sobre 0 anuncios que reportan no dice nada en absoluto.
 *
 * Función pura: recibe el snapshot, devuelve un fragmento de registro. Si no
 * hay nada que añadir devuelve `{}` y el registro se queda en v2, que es una
 * situación normal y no un error.
 */

import type { HistoryRecord, MarketSnapshot, NormalizedAd } from './types.js';

export interface SideLiquidity {
  /** USDT sumados sobre los anuncios que SÍ publicaron volumen. */
  usdt: number | null;
  /** Cuántos anuncios lo publicaron. Sin esto, una suma baja es ambigua. */
  ads: number;
}

/**
 * Suma la liquidez publicada de un lado del libro.
 *
 * `availableUsdtReported` es el único campo que distingue "sin liquidez" de
 * "liquidez desconocida"; `availableUsdt` colapsa el null a 0 por compatibilidad
 * y aquí no sirve. Los valores no finitos o negativos se descartan: un anuncio
 * con volumen imposible no se suma ni se corrige.
 */
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
 * Fragmento v3 del registro, o `{}` cuando la captura no aportó ninguno.
 *
 * `enrichmentVersion` sólo se marca si hay al menos un campo real detrás: un
 * registro etiquetado como enriquecido pero vacío mentiría sobre lo que
 * contiene.
 */
export function buildMarketContext(snapshot: MarketSnapshot): Partial<HistoryRecord> {
  const buy = sumSideLiquidity(snapshot?.topBuyAds ?? []);
  const sell = sumSideLiquidity(snapshot?.topSellAds ?? []);

  const context: Partial<HistoryRecord> = {};

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

  // El spread absoluto SÍ puede ser negativo: vender por debajo de la
  // recompra es una pérdida y borrarla falsearía el mercado.
  const spread = finiteOrUndefined(snapshot?.spreadAbsolute);
  if (spread !== undefined) context.spreadAbsolute = spread;

  if (snapshot?.status === 'LIVE' || snapshot?.status === 'STALE' || snapshot?.status === 'OFFLINE') {
    context.captureStatus = snapshot.status;
  }

  if (Object.keys(context).length === 0) return {};
  return { enrichmentVersion: 'v3-context', ...context };
}
