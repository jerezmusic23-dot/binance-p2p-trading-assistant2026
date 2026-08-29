/**
 * COMPROBAR SI LA PROYECCIÓN ACERTÓ
 * =================================
 *
 * El backtest recorre el pasado simulando decisiones. Esto es lo contrario y
 * hace falta igual: se guarda lo que el sistema dijo EN VIVO, y cuando vence
 * el horizonte se mira qué pasó de verdad.
 *
 * La diferencia importa. Un backtest puede salir bien y el sistema fallar en
 * producción por mil motivos que el backtest no ve: huecos de captura, una
 * cadencia distinta, un régimen que no estaba en el histórico. Sólo el
 * registro en vivo mide lo que el bot realmente dijo.
 *
 * NADA SE EVALÚA A OJO. Cada proyección guarda el precio que había cuando se
 * emitió, así que la comparación posterior no depende de recordar nada ni de
 * volver a calcular el estado de entonces.
 *
 * Y NADA SE AFIRMA SIN MUESTRA: el agregado publica siempre cuántas
 * proyecciones vencidas lo sostienen, y por debajo del suelo dice que no se
 * puede concluir en lugar de enseñar un porcentaje que nadie debería creerse.
 */

import { median } from '../marketStatistics.js';
import { finiteOrNull, type SeriesPoint } from './series.js';
import type { MomentumLabel } from './momentum.js';

export type ForecastDirection = 'ALCISTA' | 'BAJISTA' | 'LATERAL' | 'INDETERMINADA';
export type ForecastOutcome = 'UP' | 'FLAT' | 'DOWN';

/**
 * Lo que se guarda EN EL MOMENTO de proyectar.
 *
 * Todo lo necesario para juzgarla después sin reconstruir nada: el contexto que
 * la produjo viaja con ella.
 */
export interface ForecastRecord {
  id: string;
  createdAt: number;
  /** Qué serie se proyectó: los dos lados se evalúan por separado. */
  seriesId: string;
  priceAtForecast: number;
  horizonMs: number;
  /** Instante al que apunta. */
  dueAt: number;

  direction: ForecastDirection;
  central: number | null;
  low: number | null;
  high: number | null;
  probabilityUp: number | null;

  /** Contexto: permite medir el rendimiento POR fuerza del momentum. */
  momentumScore: number | null;
  momentumLabel: MomentumLabel | null;
  analoguesUsed: number | null;
  evidenceTier: string | null;

  /** Se rellenan al vencer. `null` mientras está pendiente. */
  evaluatedAt: number | null;
  actualPrice: number | null;
  directionHit: boolean | null;
  insideBand: boolean | null;
  absError: number | null;
  persistenceAbsError: number | null;
  /** Por qué no se pudo evaluar, cuando no se pudo. */
  unevaluableReason: string | null;
}

/**
 * Suelo de proyecciones vencidas para publicar un agregado.
 *
 * 20 pruebas independientes es el mismo suelo que usa el backtest, y por el
 * mismo motivo: por debajo, la diferencia entre habilidad y suerte no se
 * distingue. Aquí además son independientes de verdad, porque cada proyección
 * se emitió en un instante distinto y en vivo.
 */
export const MIN_EVALUATED_FORECASTS = 20;

/**
 * Tolerancia para dar por buena la observación que cierra una proyección.
 *
 * Se acepta la primera observación en o después del vencimiento, siempre que
 * no llegue más de una cadencia tarde. Más allá de eso hubo un hueco de
 * captura y la proyección NO se evalúa: puntuarla contra un precio de veinte
 * minutos después sería medir otra cosa.
 */
export const DUE_TOLERANCE_INTERVALS = 1;

/** Primera observación en o después de `dueAt`, dentro de la tolerancia. */
export function observationAtDue(
  series: readonly SeriesPoint[],
  dueAt: number,
  cadenceMs: number
): SeriesPoint | null {
  const limit = dueAt + cadenceMs * DUE_TOLERANCE_INTERVALS;
  for (const point of series) {
    if (point.t < dueAt) continue;
    return point.t <= limit ? point : null;
  }
  return null;
}

/**
 * Clasifica lo que realmente hizo el precio.
 *
 * Se usa la misma banda de +-1 movimiento típico con la que se clasifican los
 * análogos: si se juzgara con otro criterio, "acertó" significaría algo
 * distinto de lo que el modelo predijo.
 */
export function classifyActual(delta: number, step: number): ForecastOutcome {
  if (!Number.isFinite(delta) || !Number.isFinite(step)) return 'FLAT';
  if (delta > step) return 'UP';
  if (delta < -step) return 'DOWN';
  return 'FLAT';
}

export interface EvaluationInput {
  series: readonly SeriesPoint[];
  cadenceMs: number;
  typicalStep: number;
  now: number;
}

/**
 * Evalúa una proyección vencida. Devuelve una COPIA; no muta la original.
 *
 * Una proyección que aún no vence se devuelve intacta: no hay nada que juzgar
 * todavía y marcarla sería inventar un resultado.
 */
export function evaluateForecast(
  forecast: ForecastRecord,
  input: EvaluationInput
): ForecastRecord {
  if (forecast.evaluatedAt !== null) return forecast;
  if (input.now < forecast.dueAt) return forecast;

  const observed = observationAtDue(input.series, forecast.dueAt, input.cadenceMs);
  if (observed === null) {
    return {
      ...forecast,
      evaluatedAt: input.now,
      unevaluableReason:
        'sin observación dentro de la tolerancia al vencimiento (hueco de captura)',
    };
  }

  const actualDelta = observed.price - forecast.priceAtForecast;
  const actualOutcome = classifyActual(actualDelta, input.typicalStep);
  const predicted: ForecastOutcome =
    forecast.direction === 'ALCISTA' ? 'UP' : forecast.direction === 'BAJISTA' ? 'DOWN' : 'FLAT';

  return {
    ...forecast,
    evaluatedAt: input.now,
    actualPrice: observed.price,
    // INDETERMINADA no predijo nada, así que no se le apunta ni acierto ni fallo.
    directionHit: forecast.direction === 'INDETERMINADA' ? null : predicted === actualOutcome,
    insideBand:
      forecast.low !== null && forecast.high !== null
        ? observed.price >= forecast.low && observed.price <= forecast.high
        : null,
    absError: forecast.central === null ? null : Math.abs(observed.price - forecast.central),
    persistenceAbsError: Math.abs(observed.price - forecast.priceAtForecast),
    unevaluableReason: null,
  };
}

export interface ForecastPerformance {
  horizonMs: number;
  label: string;
  evaluated: number;
  pending: number;
  unevaluable: number;
  /** Fracción de aciertos direccionales, o null sin muestra suficiente. */
  directionalAccuracy: number | null;
  /** Fracción de precios reales dentro de la banda publicada. */
  bandCoverage: number | null;
  medianAbsError: number | null;
  /** El mismo error si se hubiera dicho "no se mueve". */
  persistenceMedianAbsError: number | null;
  /** Positivo = el modelo proyectó por encima de la realidad. */
  bias: number | null;
  /** true sólo con muestra suficiente Y error menor que la persistencia. */
  beatsPersistence: boolean | null;
  reason: 'INSUFFICIENT_EVALUATED' | null;
}

export interface PerformanceByMomentum {
  label: MomentumLabel;
  evaluated: number;
  directionalAccuracy: number | null;
}

export interface ForecastReport {
  totalForecasts: number;
  evaluated: number;
  pending: number;
  unevaluable: number;
  byHorizon: ForecastPerformance[];
  byMomentum: PerformanceByMomentum[];
  /** Frase honesta sobre si ya se puede concluir algo. */
  verdict: string;
}

function describeHorizon(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `+${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `+${hours} h` : `+${hours.toFixed(1)} h`;
}

/** Agrega el rendimiento observado. Nada se afirma por debajo del suelo. */
export function summariseForecasts(forecasts: readonly ForecastRecord[]): ForecastReport {
  const evaluated = forecasts.filter((f) => f.evaluatedAt !== null && f.unevaluableReason === null);
  const unevaluable = forecasts.filter((f) => f.unevaluableReason !== null);
  const pending = forecasts.filter((f) => f.evaluatedAt === null);

  const horizons = [...new Set(forecasts.map((f) => f.horizonMs))].sort((a, b) => a - b);
  const byHorizon: ForecastPerformance[] = horizons.map((horizonMs) => {
    const all = forecasts.filter((f) => f.horizonMs === horizonMs);
    const done = evaluated.filter((f) => f.horizonMs === horizonMs);
    const base: ForecastPerformance = {
      horizonMs,
      label: describeHorizon(horizonMs),
      evaluated: done.length,
      pending: all.filter((f) => f.evaluatedAt === null).length,
      unevaluable: all.filter((f) => f.unevaluableReason !== null).length,
      directionalAccuracy: null,
      bandCoverage: null,
      medianAbsError: null,
      persistenceMedianAbsError: null,
      bias: null,
      beatsPersistence: null,
      reason: 'INSUFFICIENT_EVALUATED',
    };
    if (done.length < MIN_EVALUATED_FORECASTS) return base;

    const scored = done.filter((f) => f.directionHit !== null);
    const banded = done.filter((f) => f.insideBand !== null);
    const errors = done.map((f) => f.absError).filter((v): v is number => v !== null);
    const persistence = done
      .map((f) => f.persistenceAbsError)
      .filter((v): v is number => v !== null);
    const signedGap = done
      .filter((f) => f.central !== null && f.actualPrice !== null)
      .map((f) => (f.central as number) - (f.actualPrice as number));

    const modelError = median(errors);
    const persistenceError = median(persistence);

    return {
      ...base,
      directionalAccuracy:
        scored.length > 0 ? scored.filter((f) => f.directionHit).length / scored.length : null,
      bandCoverage:
        banded.length > 0 ? banded.filter((f) => f.insideBand).length / banded.length : null,
      medianAbsError: modelError,
      persistenceMedianAbsError: persistenceError,
      bias: finiteOrNull(median(signedGap)),
      beatsPersistence:
        modelError !== null && persistenceError !== null ? modelError < persistenceError : null,
      reason: null,
    };
  });

  const labels = [...new Set(evaluated.map((f) => f.momentumLabel).filter(Boolean))] as MomentumLabel[];
  const byMomentum: PerformanceByMomentum[] = labels.map((label) => {
    const done = evaluated.filter((f) => f.momentumLabel === label && f.directionHit !== null);
    return {
      label,
      evaluated: done.length,
      directionalAccuracy:
        done.length >= MIN_EVALUATED_FORECASTS
          ? done.filter((f) => f.directionHit).length / done.length
          : null,
    };
  });

  const usable = byHorizon.filter((h) => h.reason === null);
  const verdict =
    usable.length === 0
      ? `Todavía no hay ${MIN_EVALUATED_FORECASTS} proyecciones vencidas en ningún horizonte: no se puede afirmar nada sobre el rendimiento del modelo.`
      : `Rendimiento medido sobre ${evaluated.length} proyecciones vencidas en ${usable.length} horizonte(s).`;

  return {
    totalForecasts: forecasts.length,
    evaluated: evaluated.length,
    pending: pending.length,
    unevaluable: unevaluable.length,
    byHorizon,
    byMomentum,
    verdict,
  };
}
