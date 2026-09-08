/**
 * PROYECCIÓN GENERAL USDT/VES ORIENTADA A DECIDIR
 * =================================================
 *
 * Punto de entrada del motor nuevo. Toma el histórico GENERAL —el mismo
 * `market_history.json` de siempre, sin banco, sin monto, sin precio
 * estratégico— y produce, por pierna y por horizonte: qué se observó, qué se
 * espera, con cuánta incertidumbre, y qué hacer.
 *
 * ═══ SEMÁNTICA, INTACTA ═══
 *
 *   COMPRA = mínimo BUY  (record.buyPrice)   Binance BUY  = el anunciante vende
 *   VENTA  = máximo SELL (record.sellPrice)  Binance SELL = el anunciante compra
 *
 * ═══ LO QUE ESTE MOTOR NO HACE ═══
 *
 * No lee banco, monto, payType, precio maker ni celda de matriz. No rellena
 * huecos. No inventa una confianza cuando no hay evidencia: dice NO_DECIDIR,
 * que es una salida legítima y frecuente.
 */

import { StorageEngine } from './storage.js';
import type { HistoryRecord } from './types.js';
import { buildHourlyGrid, type HourlyGrid } from './projection/hourlyGrid.js';
import { computeFeatureSeries, legConsistency, featuresFrom } from './projection/marketFeatures.js';
import { runWalkForward, HORIZONS, type Horizon, type WalkForwardReport } from './projection/walkForward.js';
import {
  decideLeg,
  DECISION_TEXT,
  REGIME_TEXT,
  type Decision,
  type LegDecision,
} from './projection/decisionEngine.js';
import { summariseProvenance, type DataProvenanceSummary } from './dailyProjection.js';

/** Horizonte que la pantalla destaca cuando el operador no elige otro. */
export const HEADLINE_HORIZON: Horizon = 4;

export interface MarketReadingReport {
  generatedAt: number;
  source: 'market_history.json';
  /** Horas realmente observadas en la rejilla, y huecos. */
  observedHours: number;
  missingHours: number;
  /** Cadencia: capturas por hora, mediana. Dice si el histórico da para esto. */
  capturesPerHour: number | null;

  /** Decisiones por pierna y horizonte. */
  venta: LegDecision[];
  compra: LegDecision[];

  /** Horizonte destacado. */
  headlineHorizon: Horizon;
  /** Lectura conjunta de las dos piernas en el horizonte destacado. */
  reading: string;
  /** Decisión conjunta: la más conservadora de las dos piernas. */
  decision: Decision;
  decisionText: string;
  /** ¿Las dos piernas se mueven en la misma dirección? */
  legsAgree: number | null;

  /** Evidencia: el walk-forward completo, para que la pantalla pueda mostrarlo. */
  walkForward: WalkForwardReport;
  dataProvenance: DataProvenanceSummary;
  /** Por qué el motor no puede decidir, cuando no puede. */
  insufficientReason: string | null;
}

/** Capturas por hora, mediana sobre las horas observadas. */
function capturesPerHour(grid: HourlyGrid): number | null {
  const counts = grid.cells.filter((c) => c !== null).map((c) => c!.observations);
  if (counts.length === 0) return null;
  counts.sort((a, b) => a - b);
  const mid = Math.floor(counts.length / 2);
  return counts.length % 2 === 1 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;
}

/**
 * La decisión conjunta es la MÁS CONSERVADORA de las dos piernas.
 *
 * Las dos piernas pueden pedir cosas opuestas —vender caro y comprar barato
 * no siempre apuntan al mismo lado— y en ese caso el operador no tiene una
 * acción única: tiene dos decisiones separadas, que es lo que la pantalla
 * muestra. Este campo sólo resume, y ante desacuerdo se abstiene.
 */
export function combineDecisions(venta: Decision, compra: Decision): Decision {
  if (venta === 'NO_DECIDIR' || compra === 'NO_DECIDIR') return 'NO_DECIDIR';
  if (venta === compra) return venta;
  // Cualquier desacuerdo entre piernas se resuelve sin inventar una tercera
  // acción: se mantiene, que es lo único que no compromete ninguna de las dos.
  return 'MANTENER_PRECIO';
}

export function buildMarketReading(
  records: readonly HistoryRecord[],
  now = Date.now()
): MarketReadingReport {
  const ventaGrid = buildHourlyGrid(records, 'VENTA');
  const compraGrid = buildHourlyGrid(records, 'COMPRA');

  const ventaFeatures = computeFeatureSeries(ventaGrid);
  const compraFeatures = computeFeatureSeries(compraGrid);

  const ventaWF = runWalkForward(ventaGrid);
  const compraWF = runWalkForward(compraGrid);

  const venta = HORIZONS.map((h) => decideLeg(ventaGrid, ventaFeatures, ventaWF, 'VENTA', h));
  const compra = HORIZONS.map((h) => decideLeg(compraGrid, compraFeatures, compraWF, 'COMPRA', h));

  const headVenta = venta.find((d) => d.horizon === HEADLINE_HORIZON) ?? venta[0] ?? null;
  const headCompra = compra.find((d) => d.horizon === HEADLINE_HORIZON) ?? compra[0] ?? null;

  const lastVenta = ventaGrid.cells.length - 1;
  const lastCompra = compraGrid.cells.length - 1;
  const legsAgree = legConsistency(
    featuresFrom(ventaGrid, lastVenta, ventaFeatures),
    featuresFrom(compraGrid, lastCompra, compraFeatures)
  );

  const decision =
    headVenta && headCompra ? combineDecisions(headVenta.decision, headCompra.decision) : 'NO_DECIDIR';

  const insufficientReason = !ventaWF.evaluable
    ? ventaWF.reason
    : !compraWF.evaluable
      ? compraWF.reason
      : null;

  const reading =
    headVenta === null || headCompra === null
      ? 'Sin datos suficientes para leer el mercado.'
      : `MI VENTA: ${REGIME_TEXT[headVenta.regime]} MI COMPRA: ${REGIME_TEXT[headCompra.regime]}`;

  return {
    generatedAt: now,
    source: 'market_history.json',
    observedHours: ventaGrid.observedHours,
    missingHours: ventaGrid.missingHours,
    capturesPerHour: capturesPerHour(ventaGrid),
    venta,
    compra,
    headlineHorizon: HEADLINE_HORIZON,
    reading,
    decision,
    decisionText: DECISION_TEXT[decision],
    legsAgree,
    walkForward: ventaWF,
    dataProvenance: summariseProvenance(records),
    insufficientReason,
  };
}

export function marketReadingFromStorage(
  now = Date.now(),
  readRecords: () => readonly HistoryRecord[] = () => StorageEngine.getHistory()
): MarketReadingReport {
  return buildMarketReading(readRecords(), now);
}
