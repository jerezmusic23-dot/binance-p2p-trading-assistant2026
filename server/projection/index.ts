/**
 * Superficie pública del motor de proyección.
 *
 * El resto del servidor importa de aquí y no de los módulos internos, para que
 * reorganizar el paquete no obligue a tocar rutas ni adaptadores.
 */

export * from './series.js';
export * from './marketState.js';
export * from './historicalAnalogies.js';
export * from './probability.js';
export * from './engine.js';
export * from './backtest.js';
export * from './momentum.js';
export * from './reading.js';
export * from './forecastEvaluation.js';

import {
  DEFAULT_HORIZONS_MS,
  projectSeries,
  type ProjectSeriesOptions,
  type SeriesProjection,
} from './engine.js';
import { backtestHorizon, backtestHorizonAsync } from './backtest.js';
import { sanitiseSeries, type SeriesPoint } from './series.js';

/**
 * Proyecta una serie con su backtest incluido, de un tirón.
 *
 * Es la vía de los tests y de cualquier cálculo fuera del hilo de peticiones.
 * Para servir HTTP se usa `projectWithBacktestAsync`, que hace exactamente lo
 * mismo cediendo el hilo entre bloques.
 */
export function projectWithBacktest(
  points: readonly SeriesPoint[],
  options: ProjectSeriesOptions = {}
): SeriesProjection {
  // Se limpia UNA vez y se usa la misma serie para proyectar y para
  // contrastar. Si el backtest corriese sobre los puntos crudos, sus anclas no
  // serían las mismas que las del motor y estaría midiendo otra cosa.
  const series = sanitiseSeries(points);
  const horizons = options.horizonsMs ?? DEFAULT_HORIZONS_MS;
  const baselines = horizons.map((ms) => backtestHorizon(series, ms));
  return projectSeries(series, options, baselines);
}

/** Igual, pero sin bloquear el bucle de eventos. */
export async function projectWithBacktestAsync(
  points: readonly SeriesPoint[],
  options: ProjectSeriesOptions = {}
): Promise<SeriesProjection> {
  const series = sanitiseSeries(points);
  const horizons = options.horizonsMs ?? DEFAULT_HORIZONS_MS;
  const baselines: SeriesProjection['baselines'] = [];
  for (const ms of horizons) baselines.push(await backtestHorizonAsync(series, ms));
  return projectSeries(series, options, baselines);
}
