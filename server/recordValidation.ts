/**
 * QUÉ PUEDE ENTRAR EN EL HISTÓRICO
 * ================================
 *
 * Un registro corrupto no se nota el día que se escribe: se nota semanas
 * después, cuando una mediana sale absurda y ya no se puede saber cuál de las
 * cuarenta mil observaciones la envenenó. Por eso la validación va aquí, en el
 * único sitio por el que pasa todo lo que se persiste, y no repartida por los
 * sitios que llaman.
 *
 * LA REGLA: lo que no se puede afirmar, no se guarda.
 *
 * Nada se corrige, se redondea ni se sustituye por un valor por defecto. Un
 * registro con un precio imposible se RECHAZA entero y el hueco queda en la
 * serie, que es el relato honesto de lo que pasó. Rellenarlo sería exactamente
 * lo que la Regla 5 prohíbe.
 *
 * Devuelve los motivos, no un booleano suelto: "se rechazó un registro" no se
 * puede diagnosticar, "se rechazó porque sellPrice era -1" sí.
 */

import type { HistoryRecord } from './types.js';

export interface RecordValidation {
  ok: boolean;
  reasons: string[];
}

/**
 * Ventana de timestamps aceptable.
 *
 * No es un umbral de mercado sino un control de cordura del reloj: un registro
 * fechado en 1970 o en 2100 viene de un reloj roto o de un parseo equivocado, y
 * en cualquiera de los dos casos contamina toda ventana temporal que lo toque.
 * El límite inferior es el arranque del proyecto; el superior, un día por
 * delante del momento de escribir, que absorbe cualquier desfase razonable
 * entre el reloj del contenedor y el de Binance sin admitir un futuro inventado.
 */
export const EARLIEST_PLAUSIBLE_TIMESTAMP = Date.UTC(2025, 0, 1);
export const CLOCK_SKEW_TOLERANCE_MS = 24 * 60 * 60 * 1000;

function finitePositive(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * `now` es inyectable para que los tests no dependan del reloj de la máquina.
 */
export function validateHistoryRecord(
  record: HistoryRecord,
  now: number = Date.now()
): RecordValidation {
  const reasons: string[] = [];

  if (!record || typeof record !== 'object') {
    return { ok: false, reasons: ['el registro no es un objeto'] };
  }

  /* --- Tiempo ---------------------------------------------------------- */
  const t = record.timestamp;
  if (typeof t !== 'number' || !Number.isFinite(t)) {
    reasons.push(`timestamp no finito (${String(t)})`);
  } else if (t < EARLIEST_PLAUSIBLE_TIMESTAMP) {
    reasons.push(`timestamp anterior al proyecto (${new Date(t).toISOString()})`);
  } else if (t > now + CLOCK_SKEW_TOLERANCE_MS) {
    reasons.push(`timestamp en el futuro (${new Date(t).toISOString()})`);
  }

  /* --- Precios crudos, siempre obligatorios ---------------------------- */
  if (!finitePositive(record.buyPrice)) reasons.push(`buyPrice imposible (${String(record.buyPrice)})`);
  if (!finitePositive(record.sellPrice)) reasons.push(`sellPrice imposible (${String(record.sellPrice)})`);
  if (typeof record.spreadPct !== 'number' || !Number.isFinite(record.spreadPct)) {
    // El spread SÍ puede ser negativo: vender por debajo de la recompra es una
    // pérdida, y borrarla sería falsear el mercado. Sólo se exige que exista.
    reasons.push(`spreadPct no finito (${String(record.spreadPct)})`);
  }

  /* --- Recuentos de anuncios ------------------------------------------- */
  for (const field of ['activeBuyAds', 'activeSellAds'] as const) {
    const v = record[field];
    if (!Number.isInteger(v) || (v as number) < 0) {
      reasons.push(`${field} no es un recuento válido (${String(v)})`);
    }
  }

  /* --- Capa estratégica: o está entera y sana, o no está --------------- */
  if (record.calculationVersion === 'v2-strategic') {
    if (!finitePositive(record.strategicBuyPrice)) {
      reasons.push(`strategicBuyPrice imposible (${String(record.strategicBuyPrice)})`);
    }
    if (!finitePositive(record.strategicSellPrice)) {
      reasons.push(`strategicSellPrice imposible (${String(record.strategicSellPrice)})`);
    }
    if (
      typeof record.strategicSpreadPct !== 'number' ||
      !Number.isFinite(record.strategicSpreadPct)
    ) {
      reasons.push(`strategicSpreadPct no finito (${String(record.strategicSpreadPct)})`);
    }
  } else if (
    record.strategicBuyPrice !== undefined ||
    record.strategicSellPrice !== undefined ||
    record.strategicSpreadPct !== undefined
  ) {
    // Precios estratégicos sin la versión que los declara: nadie sabría luego
    // con qué método se calcularon.
    reasons.push('precios estratégicos sin calculationVersion');
  }

  /* --- Capa de contexto v3 --------------------------------------------- */
  if (record.enrichmentVersion === 'v3-context') {
    for (const field of ['buyLiquidityUsdt', 'sellLiquidityUsdt'] as const) {
      const v = record[field];
      // La liquidez puede ser 0 (nadie publicó volumen); lo que no puede ser
      // es negativa ni infinita.
      if (v !== undefined && !finiteNonNegative(v)) {
        reasons.push(`${field} imposible (${String(v)})`);
      }
    }
    for (const field of ['buyLiquidityAds', 'sellLiquidityAds'] as const) {
      const v = record[field];
      if (v !== undefined && (!Number.isInteger(v) || v < 0)) {
        reasons.push(`${field} no es un recuento válido (${String(v)})`);
      }
    }
    for (const field of ['weightedBuyPrice', 'weightedSellPrice'] as const) {
      const v = record[field];
      if (v !== undefined && !finitePositive(v)) {
        reasons.push(`${field} imposible (${String(v)})`);
      }
    }
    if (
      record.spreadAbsolute !== undefined &&
      (typeof record.spreadAbsolute !== 'number' || !Number.isFinite(record.spreadAbsolute))
    ) {
      reasons.push(`spreadAbsolute no finito (${String(record.spreadAbsolute)})`);
    }
    // Más anuncios reportando volumen que anuncios en el lado es imposible.
    if (
      Number.isInteger(record.buyLiquidityAds) &&
      Number.isInteger(record.activeBuyAds) &&
      (record.buyLiquidityAds as number) > record.activeBuyAds
    ) {
      reasons.push('buyLiquidityAds supera a activeBuyAds');
    }
    if (
      Number.isInteger(record.sellLiquidityAds) &&
      Number.isInteger(record.activeSellAds) &&
      (record.sellLiquidityAds as number) > record.activeSellAds
    ) {
      reasons.push('sellLiquidityAds supera a activeSellAds');
    }
  }

  return { ok: reasons.length === 0, reasons };
}
