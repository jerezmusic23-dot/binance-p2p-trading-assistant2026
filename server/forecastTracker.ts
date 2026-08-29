/**
 * CIERRA EL CICLO: EMITIR, ESPERAR, COMPROBAR
 * ===========================================
 *
 * Une el informe de proyección con el registro persistido:
 *
 *   1. Evalúa las proyecciones cuyo horizonte ya venció, contra el precio que
 *      realmente hubo.
 *   2. Registra las de ahora, respetando el espaciado que las hace
 *      independientes entre sí.
 *   3. Devuelve el rendimiento acumulado, sin afirmar nada sin muestra.
 *
 * VIVE APARTE DEL MOTOR A PROPÓSITO. `marketProjection` es puro y se puede
 * probar sin tocar disco; esto escribe. Mantenerlos separados permite que la
 * ruta HTTP haga el seguimiento y que los tests del motor no arrastren un
 * fichero de por medio.
 *
 * NADA DE ESTO PUEDE TUMBAR LA CAPTURA. Un fallo al leer o escribir el
 * registro se traga y se reporta: perder la medición del rendimiento es malo,
 * dejar de capturar el mercado es peor.
 */

import { ForecastStore } from './forecastStore.js';
import {
  evaluateForecast,
  medianIntervalMs,
  summariseForecasts,
  typicalStep,
  type ForecastRecord,
  type ForecastReport,
  type SeriesPoint,
} from './projection/index.js';
import type { MarketSideProjection } from './marketProjection.js';

function buildRecord(
  side: MarketSideProjection,
  horizon: MarketSideProjection['horizons'][number],
  now: number
): ForecastRecord | null {
  if (!horizon.available || horizon.currentPrice === null) return null;

  const movement = side.reading.movement;
  return {
    id: `${side.seriesId}-${horizon.requestedHorizonMs}-${now}`,
    createdAt: now,
    seriesId: side.seriesId,
    priceAtForecast: horizon.currentPrice,
    horizonMs: horizon.requestedHorizonMs,
    dueAt: now + horizon.requestedHorizonMs,
    direction:
      horizon.direction === null || horizon.direction === 'INDETERMINADA'
        ? 'INDETERMINADA'
        : horizon.direction,
    central: horizon.central,
    low: horizon.low,
    high: horizon.high,
    probabilityUp: horizon.probabilityUp,
    momentumScore: movement.score,
    momentumLabel: movement.label,
    analoguesUsed: horizon.audit?.analoguesUsed ?? null,
    evidenceTier: side.reading.evidence,
    evaluatedAt: null,
    actualPrice: null,
    directionHit: null,
    insideBand: null,
    absError: null,
    persistenceAbsError: null,
    unevaluableReason: null,
  };
}

export interface TrackingResult {
  report: ForecastReport;
  recorded: number;
  evaluated: number;
}

/**
 * `seriesFor` entrega la serie real de cada lado, que es contra lo que se
 * juzga cada proyección vencida. Se inyecta para que los tests puedan darla
 * sin montar un histórico en disco.
 */
export function trackForecasts(
  sides: readonly MarketSideProjection[],
  seriesFor: (seriesId: string) => readonly SeriesPoint[],
  now: number
): TrackingResult {
  let recorded = 0;
  let evaluated = 0;

  try {
    /* 1. Evaluar lo vencido. */
    const updates: ForecastRecord[] = [];
    for (const pending of ForecastStore.pending()) {
      const series = seriesFor(pending.seriesId);
      const cadence = medianIntervalMs(series);
      const step = typicalStep(series);
      if (cadence === null || step === null) continue;

      const result = evaluateForecast(pending, { series, cadenceMs: cadence, typicalStep: step, now });
      if (result.evaluatedAt !== null) {
        updates.push(result);
        evaluated += 1;
      }
    }
    if (updates.length > 0) ForecastStore.update(updates);

    /* 2. Registrar las de ahora, si el espaciado lo permite. */
    for (const side of sides) {
      for (const horizon of side.horizons) {
        if (!horizon.available) continue;
        const { record } = ForecastStore.shouldRecord(
          side.seriesId,
          horizon.requestedHorizonMs,
          now
        );
        if (!record) continue;

        const built = buildRecord(side, horizon, now);
        if (built === null) continue;
        ForecastStore.append(built);
        recorded += 1;
      }
    }

    return { report: summariseForecasts(ForecastStore.all()), recorded, evaluated };
  } catch (err) {
    console.error('[ForecastTracker] Error siguiendo las proyecciones:', err);
    return { report: summariseForecasts([]), recorded, evaluated };
  }
}
