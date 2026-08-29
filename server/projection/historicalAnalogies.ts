/**
 * BUSCAR SITUACIONES HISTÓRICAS PARECIDAS A LA DE AHORA
 * =====================================================
 *
 * Aquí vive la única operación que hace que esto no sea una caja negra: dado
 * el estado actual, encontrar los instantes del pasado que más se le parecen y
 * traer lo que ocurrió después de cada uno, con su fecha.
 *
 * PROHIBIDO EL LEAKAGE TEMPORAL
 *
 * Un candidato en el índice i se describe SÓLO con points[i-L..i] y su
 * desenlace se lee en points[i+H]. La función no recibe nunca "la serie
 * completa más un índice del presente": recibe una serie y trata su ÚLTIMO
 * punto como el presente. Por eso el backtest puede llamarla con un prefijo y
 * obtener exactamente lo que el sistema habría publicado en ese momento — no
 * hay ninguna ruta por la que información posterior al ancla influya en que un
 * instante sea elegido como parecido.
 *
 * VENTANAS SOLAPADAS: EL ERROR QUE ESTE MÓDULO EXISTE PARA EVITAR
 *
 * Una serie de N puntos contiene N-H ventanas de horizonte H, pero sólo ~N/H
 * INDEPENDIENTES. En una serie temporal los vecinos más cercanos de un
 * instante son casi siempre los instantes de al lado: comparten casi todas sus
 * observaciones y casi todo su movimiento. Un k-NN de manual devolvería 100
 * "casos" que en realidad son tres o cuatro tramos contados muchas veces, y la
 * probabilidad resultante parecería descansar sobre 100 pruebas cuando
 * descansa sobre cuatro.
 *
 * La selección exige por tanto que dos análogos disten al menos H pasos. Lo
 * que se pierde son vecinos muy próximos que no añadían información; lo que se
 * gana es que el recuento signifique literalmente "situaciones distintas".
 */

import {
  GAP_TOLERANCE_MULTIPLE,
  gapFree,
  lookbackFor,
  type SeriesPoint,
} from './series.js';
import { buildState, stateDistance, stateScales, type MarketState } from './marketState.js';

/**
 * Mínimo de análogos NO SOLAPADOS para publicar algo.
 *
 * Cubre las dos exigencias a la vez:
 *
 *   - La banda publicada son los percentiles 10 y 90. Con n=40 descansan sobre
 *     el 4º y el 37º valor ordenado, no sobre un único extremo: un dato raro
 *     no puede fijar el borde de la banda. Con n=10 sí podría.
 *   - El error estándar de una proporción es <= 0.5/sqrt(n): con n=40 el peor
 *     caso son 7.9 puntos porcentuales. Es un suelo bajo a propósito. No
 *     pretende que 40 ventanas den precisión; pretende que por debajo no hay
 *     ni siquiera una lectura. La imprecisión restante la enseña el intervalo
 *     de confianza, que se publica siempre.
 *
 * Consecuencia medible: un horizonte de H pasos necesita ~41·H observaciones.
 * A 1 registro/minuto son ~10 h de histórico para +15 min, ~21 h para +30 min
 * y ~41 h para +1 h. Los horizontes largos callarán durante bastante tiempo, y
 * es correcto que callen.
 */
export const MIN_ANALOGUES = 40;

/**
 * Cuántos análogos se usan cuando hay de sobra.
 *
 * k está FIJO y epsilon (la distancia máxima aceptada) es su CONSECUENCIA: no
 * hay ningún umbral de similitud elegido a mano. Con más histórico, los mismos
 * 100 vecinos son simplemente más parecidos al presente. 100 es donde el error
 * estándar de una proporción deja de mejorar rápido: pasar de 100 a 200 baja
 * el peor caso de 5.0 a 3.5 puntos.
 */
export const TARGET_ANALOGUES = 100;

export interface Candidate {
  index: number;
  t: number;
  price: number;
  state: MarketState;
  /** Cambio observado H pasos después, o null si no hay futuro completo. */
  delta: number | null;
}

export interface Analogue {
  index: number;
  t: number;
  price: number;
  delta: number;
  distance: number;
}

export interface AnalogySearch {
  /** Instantes descriptibles con desenlace ya observado. */
  pool: Candidate[];
  /** Los elegidos, sin solaparse entre sí, ordenados por cercanía. */
  analogues: Analogue[];
  /** Estado del instante presente (el último punto de la serie). */
  current: Candidate | null;
  scales: Record<string, number>;
  horizonSteps: number;
  lookbackSteps: number;
  /** Distancia del análogo más lejano aceptado: epsilon, como consecuencia. */
  maxDistance: number | null;
}

/**
 * Todos los instantes de la serie que se pueden describir, con su desenlace a
 * H pasos cuando existe.
 *
 * Una ventana con un hueco de captura dentro se descarta entera: si falta una
 * observación en medio, el "paso" medido a través del hueco no es un paso.
 */
export function buildCandidates(
  points: readonly SeriesPoint[],
  horizonSteps: number,
  lookbackSteps: number,
  step: number,
  cadenceMs: number
): Candidate[] {
  const tolerance = cadenceMs * GAP_TOLERANCE_MULTIPLE;
  const out: Candidate[] = [];

  for (let i = lookbackSteps; i < points.length; i += 1) {
    if (!gapFree(points, i - lookbackSteps, i, tolerance)) continue;
    const state = buildState(points, i - lookbackSteps, i, step);
    if (state === null) continue;

    let delta: number | null = null;
    const future = i + horizonSteps;
    if (future < points.length && gapFree(points, i, future, tolerance)) {
      const d = points[future].price - points[i].price;
      if (Number.isFinite(d)) delta = d;
    }

    out.push({ index: i, t: points[i].t, price: points[i].price, state, delta });
  }

  return out;
}

/**
 * Elige por cercanía, aceptando un ancla sólo si dista al menos H pasos de
 * todas las ya aceptadas.
 */
function selectIndependent(
  ranked: readonly Analogue[],
  horizonSteps: number,
  cap: number
): Analogue[] {
  const taken: Analogue[] = [];
  const indices: number[] = [];

  for (const entry of ranked) {
    if (taken.length >= cap) break;
    if (indices.every((other) => Math.abs(entry.index - other) >= horizonSteps)) {
      taken.push(entry);
      indices.push(entry.index);
    }
  }

  return taken;
}

/**
 * Busca las situaciones históricas más parecidas al PRESENTE, que es siempre
 * el último punto de `points`.
 */
export function findAnalogies(
  points: readonly SeriesPoint[],
  horizonSteps: number,
  step: number,
  cadenceMs: number
): AnalogySearch {
  const lookbackSteps = lookbackFor(horizonSteps);
  const candidates = buildCandidates(points, horizonSteps, lookbackSteps, step, cadenceMs);

  const lastIndex = points.length - 1;
  const current = candidates.find((c) => c.index === lastIndex) ?? null;
  const pool = candidates.filter((c) => c.delta !== null && c.index !== lastIndex);

  const empty: AnalogySearch = {
    pool,
    analogues: [],
    current,
    scales: {},
    horizonSteps,
    lookbackSteps,
    maxDistance: null,
  };
  if (current === null || pool.length === 0) return empty;

  const scales = stateScales(pool.map((c) => c.state));
  const ranked: Analogue[] = pool
    .map((c) => ({
      index: c.index,
      t: c.t,
      price: c.price,
      delta: c.delta as number,
      distance: stateDistance(current.state, c.state, scales),
    }))
    .filter((a) => Number.isFinite(a.distance))
    .sort((a, b) => a.distance - b.distance);

  const analogues = selectIndependent(ranked, horizonSteps, TARGET_ANALOGUES);

  return {
    pool,
    analogues,
    current,
    scales,
    horizonSteps,
    lookbackSteps,
    maxDistance: analogues.length > 0 ? analogues[analogues.length - 1].distance : null,
  };
}
