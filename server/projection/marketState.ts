/**
 * EL ESTADO DEL MERCADO EN UN INSTANTE
 * ====================================
 *
 * Convierte una ventana de la serie en un vector comparable. Todo el motor
 * descansa en esto: dos instantes son "parecidos" si sus vectores lo son, y si
 * el vector estuviera mal construido las analogías serían casuales por muy
 * correcta que fuese la estadística posterior.
 *
 * TODO EN UNIDADES DE LA PROPIA SERIE
 *
 * Cada componente se divide por `typicalStep`, el movimiento típico de esta
 * serie. Un mercado a 940 VES que se mueve de 0.01 en 0.01 y otro a 47 que se
 * mueve de 2 en 2 tienen que poder estar "en el mismo estado", y ninguna
 * constante en VES puede entrar en la comparación. Ésa es la razón de que no
 * haya —ni pueda haber— un 1.6, un 1.15 ni un 0.0035 en este archivo.
 *
 * LA HORA DEL DÍA NO ENTRA
 *
 * Es tentadora y sería un error con este histórico. Condicionar por hora
 * dividiría la muestra por 24 y dejaría todos los horizontes sin análogos. Se
 * conserva como metadato del ancla, no como componente de la distancia; cuando
 * el histórico dé para ello, entrará por aquí y se medirá si aporta.
 */

import { medianAbsoluteDeviation } from '../marketStatistics.js';
import type { SeriesPoint } from './series.js';

export interface MarketState {
  /** Recorrido de toda la ventana, en pasos típicos. */
  drift: number;
  /** Recorrido por observación, en pasos típicos. */
  velocity: number;
  /** Velocidad de la segunda mitad menos la de la primera: acelera o frena. */
  acceleration: number;
  /** Dispersión de los saltos dentro de la ventana, en pasos típicos. */
  volatility: number;
  /** Dónde está el precio dentro del rango de la ventana, 0..1. */
  position: number;
  /**
   * Proporción de saltos que fueron en la dirección dominante, 0.5..1.
   *
   * Distingue "subió 10 pasos seguidos" de "subió y bajó y acabó arriba". Un
   * recorrido idéntico con persistencia distinta no es el mismo estado, y sin
   * este componente el motor los confundiría.
   */
  persistence: number;
}

export const STATE_KEYS: readonly (keyof MarketState)[] = [
  'drift',
  'velocity',
  'acceleration',
  'volatility',
  'position',
  'persistence',
];

/**
 * Describe la ventana `points[from..to]`.
 *
 * `step` es el movimiento típico de la serie completa. Cuando vale 0 la serie
 * nunca se movió: los componentes de recorrido son 0 POR DEFINICIÓN, no por
 * una división por cero.
 *
 * Devuelve null cuando la ventana es demasiado corta para tener dos mitades.
 */
export function buildState(
  points: readonly SeriesPoint[],
  from: number,
  to: number,
  step: number
): MarketState | null {
  const span = to - from;
  if (span < 2) return null;
  if (from < 0 || to >= points.length) return null;

  const norm = (value: number) => (step > 0 ? value / step : 0);

  const first = points[from].price;
  const last = points[to].price;
  const drift = norm(last - first);
  const velocity = drift / span;

  const mid = from + Math.floor(span / 2);
  const firstHalf = mid - from;
  const secondHalf = to - mid;
  const acceleration =
    firstHalf >= 1 && secondHalf >= 1
      ? norm(points[to].price - points[mid].price) / secondHalf -
        norm(points[mid].price - points[from].price) / firstHalf
      : 0;

  const steps: number[] = [];
  let min = points[from].price;
  let max = points[from].price;
  let up = 0;
  let down = 0;
  for (let i = from + 1; i <= to; i += 1) {
    const move = points[i].price - points[i - 1].price;
    steps.push(move);
    if (move > 0) up += 1;
    else if (move < 0) down += 1;
    if (points[i].price < min) min = points[i].price;
    if (points[i].price > max) max = points[i].price;
  }

  const mad = medianAbsoluteDeviation(steps);
  const volatility = mad === null ? 0 : norm(mad);

  const range = max - min;
  const position = range > 0 ? (last - min) / range : 0.5;

  // Sin ningún movimiento no hay dirección dominante: 0.5 es "ninguna", que es
  // exactamente lo que significa en esta escala.
  const moves = up + down;
  const persistence = moves > 0 ? Math.max(up, down) / moves : 0.5;

  const state: MarketState = {
    drift,
    velocity,
    acceleration,
    volatility,
    position,
    persistence,
  };
  for (const key of STATE_KEYS) {
    if (!Number.isFinite(state[key])) return null;
  }
  return state;
}

/**
 * Escala de cada componente: su MAD sobre el conjunto de candidatos.
 *
 * Sin esto, el componente con más rango domina la distancia por accidente de
 * unidades, y la "similitud" acaba decidida por una elección de escala que
 * nadie tomó conscientemente. Dividiendo por la dispersión observada de cada
 * componente, la distancia queda en desviaciones robustas de la propia serie:
 * ninguna ponderación entra a mano.
 *
 * MAD 0 (todos los candidatos idénticos en ese componente) cae a 1, que en
 * estas unidades es "un paso típico". No se descarta el componente: el
 * presente sí puede diferir de esa constante, y esa diferencia es real.
 */
export function stateScales(states: readonly MarketState[]): Record<string, number> {
  const scales: Record<string, number> = {};
  for (const key of STATE_KEYS) {
    const mad = medianAbsoluteDeviation(states.map((s) => s[key]));
    scales[key] = mad !== null && mad > 0 ? mad : 1;
  }
  return scales;
}

/** Distancia euclídea en desviaciones robustas de cada componente. */
export function stateDistance(
  a: MarketState,
  b: MarketState,
  scales: Record<string, number>
): number {
  let sum = 0;
  for (const key of STATE_KEYS) {
    const d = (a[key] - b[key]) / scales[key];
    sum += d * d;
  }
  return Math.sqrt(sum);
}
