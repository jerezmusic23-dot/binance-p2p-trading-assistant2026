/**
 * FUERZA DEL MOVIMIENTO, Y SI ESTÁ GANANDO O PERDIENDO FUERZA
 * ===========================================================
 *
 * CÓMO SE CONSTRUYE EL 0–100, Y POR QUÉ ASÍ
 *
 *     score = 50 + 50 · signo(movimiento) · P(|movimiento| >= |históricos|)
 *
 * Es decir: la DIRECCIÓN del movimiento actual, multiplicada por lo grande que
 * es ese movimiento COMPARADO CON LOS QUE ESTE MISMO MERCADO SUELE HACER.
 *
 *   50  = no se mueve.
 *   100 = sube tan fuerte como lo más fuerte que ha subido nunca.
 *   0   = baja tan fuerte como lo más fuerte que ha bajado nunca.
 *
 * La escala no está inventada: el listón lo pone la distribución de magnitudes
 * del propio mercado. No entra ni una constante en VES, ni un multiplicador,
 * ni un umbral a mano. Y se adapta solo: 0.5 VES puntúa altísimo en un mercado
 * quieto y en la mitad en uno agitado.
 *
 * SE PROBÓ ANTES CON EL PERCENTIL CON SIGNO, Y ESTABA MAL. Situar el
 * movimiento actual dentro de la distribución de movimientos CON SIGNO da 50 a
 * una subida perfectamente constante: si todos los movimientos son idénticos,
 * el actual es exactamente el mediano. Técnicamente cierto —no es un
 * movimiento inusual— pero leer NEUTRAL en un mercado que no ha dejado de
 * subir es inútil. Separar signo y magnitud arregla eso sin meter ninguna
 * constante: la rampa constante puntúa 100, porque sube todo lo que sabe subir.
 *
 * POR QUÉ NO ES UNA MEZCLA PONDERADA DE SEÑALES
 *
 * La tentación es combinar velocidad, aceleración, persistencia, volatilidad y
 * liquidez en un solo número. Para hacerlo hay que decidir cuánto pesa cada
 * una, y esos pesos NO se pueden derivar de los datos: serían exactamente las
 * constantes arbitrarias que este proyecto lleva tres fases quitando.
 *
 * Así que el score mide una cosa sola y bien —cuán grande es este movimiento
 * para este mercado— y los demás factores se publican MEDIDOS Y APARTE, en
 * `MomentumFactors`, para que quien lea vea de qué está hecho el movimiento en
 * lugar de recibir un número opaco. La narrativa los cita uno a uno.
 *
 * LAS SIETE ETIQUETAS
 *
 * Siete bandas iguales sobre la escala de percentil: cada una es un séptimo de
 * la historia del propio mercado. NEUTRAL es la banda central por
 * construcción, y la escala es simétrica sin que nadie haya elegido dónde
 * cortar.
 */

import { median, medianAbsoluteDeviation } from '../marketStatistics.js';
import { finiteOrNull, percentileOf, typicalStep, type SeriesPoint } from './series.js';

export type MomentumLabel =
  | 'FUERTE_ALCISTA'
  | 'ALCISTA'
  | 'ALCISTA_DEBIL'
  | 'NEUTRAL'
  | 'BAJISTA_DEBIL'
  | 'BAJISTA'
  | 'FUERTE_BAJISTA';

export type MomentumTrend = 'AUMENTANDO' | 'ESTABLE' | 'DISMINUYENDO' | 'INDETERMINADO';

/** Siete bandas iguales sobre 0–100: un séptimo de la propia historia cada una. */
export const MOMENTUM_BANDS = 7;

/**
 * Lecturas de momentum que se comparan para saber si gana o pierde fuerza.
 *
 * Tres: la actual y dos anteriores. Con dos sólo se ve una diferencia, que no
 * distingue una tendencia de un rebote; con tres ya hay una dirección. Más
 * lecturas alargarían la ventana hacia atrás hasta describir un mercado que ya
 * no es el de ahora.
 */
export const MOMENTUM_READINGS = 3;

/** Observaciones mínimas para que un percentil signifique algo. */
export const MIN_MOMENTUM_SAMPLES = 20;

export interface MomentumFactors {
  /** Recorrido de la ventana en movimientos típicos. */
  driftSteps: number | null;
  /** Recorrido por observación, en movimientos típicos. */
  velocity: number | null;
  /** Velocidad de la segunda mitad menos la de la primera. */
  acceleration: number | null;
  /** Proporción de saltos en la dirección dominante, 0.5–1. */
  persistence: number | null;
  /** Saltos consecutivos en la misma dirección al final de la ventana. */
  consecutiveMoves: number | null;
  /** Dispersión de los saltos, en movimientos típicos. */
  volatility: number | null;
}

export interface MomentumReading {
  /** 0–100. null cuando no hay muestra para situar el movimiento. */
  score: number | null;
  label: MomentumLabel | null;
  trend: MomentumTrend;
  /** Las lecturas comparadas, de la más antigua a la actual. */
  history: number[];
  factors: MomentumFactors;
  /** Movimientos históricos con los que se calculó el percentil. */
  sampleSize: number;
  windowSteps: number;
}

/** Movimientos de `window` pasos observados en la serie, en orden temporal. */
export function windowedMoves(
  points: readonly SeriesPoint[],
  window: number,
  upTo: number = points.length - 1
): number[] {
  const moves: number[] = [];
  if (window < 1) return moves;
  for (let i = window; i <= upTo; i += 1) {
    const move = points[i].price - points[i - window].price;
    if (Number.isFinite(move)) moves.push(move);
  }
  return moves;
}

/**
 * Percentil empírico de `value` dentro de `sample`, en 0–100.
 *
 * Se usa el punto medio del rango de empates: con una serie cuantizada muchos
 * movimientos valen exactamente lo mismo, y contar sólo los estrictamente
 * menores hundiría el rango de un movimiento perfectamente corriente.
 */
export function empiricalPercentile(value: number, sample: readonly number[]): number | null {
  if (!Number.isFinite(value) || sample.length === 0) return null;

  let below = 0;
  let equal = 0;
  let total = 0;
  for (const v of sample) {
    if (!Number.isFinite(v)) continue;
    total += 1;
    if (v < value) below += 1;
    else if (v === value) equal += 1;
  }
  if (total === 0) return null;

  return ((below + equal / 2) / total) * 100;
}

/**
 * Score 0–100: dirección por magnitud relativa.
 *
 * La magnitud se compara contra los VALORES ABSOLUTOS de los movimientos
 * históricos, así que mide "cuán grande es esto para este mercado" sin que la
 * dirección contamine la referencia. El signo decide luego hacia qué lado del
 * 50 cae.
 */
export function directionalScore(move: number, sample: readonly number[]): number | null {
  if (!Number.isFinite(move)) return null;
  if (move === 0) return 50;

  const magnitudes = sample.filter((v) => Number.isFinite(v)).map((v) => Math.abs(v));
  const rank = empiricalPercentile(Math.abs(move), magnitudes);
  if (rank === null) return null;

  const score = 50 + (move > 0 ? 1 : -1) * (rank / 2);
  return Math.min(100, Math.max(0, score));
}

const LABELS: readonly MomentumLabel[] = [
  'FUERTE_BAJISTA',
  'BAJISTA',
  'BAJISTA_DEBIL',
  'NEUTRAL',
  'ALCISTA_DEBIL',
  'ALCISTA',
  'FUERTE_ALCISTA',
];

/** Séptimo de la escala en el que cae el score. */
export function labelForScore(score: number | null): MomentumLabel | null {
  if (score === null || !Number.isFinite(score)) return null;
  const band = Math.min(MOMENTUM_BANDS - 1, Math.floor((score / 100) * MOMENTUM_BANDS));
  return LABELS[Math.max(0, band)];
}

/** Saltos consecutivos en la misma dirección al final de la ventana. */
function consecutiveAtEnd(points: readonly SeriesPoint[], from: number, to: number): number | null {
  if (to - from < 1) return null;
  let run = 0;
  let direction = 0;
  for (let i = to; i > from; i -= 1) {
    const move = points[i].price - points[i - 1].price;
    if (move === 0) break;
    const sign = move > 0 ? 1 : -1;
    if (direction === 0) direction = sign;
    else if (sign !== direction) break;
    run += 1;
  }
  return run;
}

function measureFactors(
  points: readonly SeriesPoint[],
  from: number,
  to: number,
  step: number
): MomentumFactors {
  const empty: MomentumFactors = {
    driftSteps: null,
    velocity: null,
    acceleration: null,
    persistence: null,
    consecutiveMoves: null,
    volatility: null,
  };
  const span = to - from;
  if (span < 2 || from < 0 || to >= points.length) return empty;

  const norm = (v: number) => (step > 0 ? v / step : 0);
  const drift = norm(points[to].price - points[from].price);
  const mid = from + Math.floor(span / 2);
  const firstHalf = mid - from;
  const secondHalf = to - mid;

  const steps: number[] = [];
  let up = 0;
  let down = 0;
  for (let i = from + 1; i <= to; i += 1) {
    const move = points[i].price - points[i - 1].price;
    steps.push(move);
    if (move > 0) up += 1;
    else if (move < 0) down += 1;
  }
  const moves = up + down;
  const mad = medianAbsoluteDeviation(steps);

  return {
    driftSteps: finiteOrNull(drift),
    velocity: finiteOrNull(drift / span),
    acceleration:
      firstHalf >= 1 && secondHalf >= 1
        ? finiteOrNull(
            norm(points[to].price - points[mid].price) / secondHalf -
              norm(points[mid].price - points[from].price) / firstHalf
          )
        : 0,
    persistence: moves > 0 ? Math.max(up, down) / moves : 0.5,
    consecutiveMoves: consecutiveAtEnd(points, from, to),
    volatility: mad === null ? 0 : finiteOrNull(norm(mad)),
  };
}

/**
 * Lee el momentum de una serie sobre una ventana de `windowSteps`.
 *
 * `history` son `MOMENTUM_READINGS` lecturas separadas por una ventana
 * completa: separarlas menos haría que compartieran casi todas sus
 * observaciones y la comparación mediría ruido en vez de un cambio de fuerza.
 *
 * La tendencia se juzga contra el RUIDO DEL PROPIO MOMENTUM: la mediana de los
 * cambios absolutos entre lecturas consecutivas a lo largo de la serie. Un
 * cambio menor que ese ruido no es que suba ni baje, es que está estable — y
 * ese listón lo pone la serie, no una constante.
 */
export function readMomentum(
  points: readonly SeriesPoint[],
  windowSteps: number
): MomentumReading {
  const empty: MomentumReading = {
    score: null,
    label: null,
    trend: 'INDETERMINADO',
    history: [],
    factors: measureFactors([], 0, 0, 0),
    sampleSize: 0,
    windowSteps,
  };

  if (!Number.isFinite(windowSteps) || windowSteps < 1) return empty;
  if (points.length < windowSteps + 1) return empty;

  const step = typicalStep(points);
  if (step === null) return empty;

  const last = points.length - 1;
  const sample = windowedMoves(points, windowSteps, last);
  if (sample.length < MIN_MOMENTUM_SAMPLES) {
    return { ...empty, sampleSize: sample.length };
  }

  /*
   * TODAS LAS LECTURAS SE MIDEN CONTRA LA MISMA REFERENCIA: la distribución de
   * magnitudes de toda la serie disponible.
   *
   * Se intentó primero rankear cada lectura contra su propio prefijo, que
   * suena más puro, y produce una lectura inútil: en una serie que acelera,
   * CADA movimiento es el mayor de su propio pasado, así que las tres lecturas
   * salen a 99.9 y la derivada se aplana justo cuando más importa. Lo mismo al
   * revés en una que se frena. Cada lectura era extrema en su propio mundo y
   * ninguna era comparable con las otras.
   *
   * Esto NO es fuga de futuro: no se está simulando la decisión que se habría
   * tomado hace media hora, se está mirando hacia atrás desde ahora para
   * responder "¿el movimiento de ahora es más o menos fuerte que el de antes?".
   * Esa pregunta sólo tiene sentido con una vara de medir común. La proyección
   * y su backtest, que sí simulan el pasado, siguen usando prefijos y no pasan
   * por aquí.
   */
  const reference = sample;
  const scoreAt = (index: number): number | null => {
    if (index - windowSteps < 0) return null;
    const move = points[index].price - points[index - windowSteps].price;
    return directionalScore(move, reference);
  };

  const history: number[] = [];
  for (let k = MOMENTUM_READINGS - 1; k >= 0; k -= 1) {
    const s = scoreAt(last - k * windowSteps);
    if (s !== null) history.push(s);
  }

  const score = history.length > 0 ? history[history.length - 1] : null;

  /* Ruido propio del momentum: mediana del cambio absoluto entre lecturas. */
  const allScores: number[] = [];
  for (let i = windowSteps; i <= last; i += windowSteps) {
    const s = scoreAt(i);
    if (s !== null) allScores.push(s);
  }
  const jumps: number[] = [];
  for (let i = 1; i < allScores.length; i += 1) jumps.push(Math.abs(allScores[i] - allScores[i - 1]));
  const noise = median(jumps);

  let trend: MomentumTrend = 'INDETERMINADO';
  if (history.length >= 2 && noise !== null) {
    const change = history[history.length - 1] - history[0];
    if (Math.abs(change) <= noise) trend = 'ESTABLE';
    else trend = change > 0 ? 'AUMENTANDO' : 'DISMINUYENDO';
  }

  return {
    score: finiteOrNull(score),
    label: labelForScore(score),
    trend,
    history,
    factors: measureFactors(points, Math.max(0, last - windowSteps), last, step),
    sampleSize: sample.length,
    windowSteps,
  };
}

/**
 * Frase corta que combina fuerza y su derivada.
 *
 * "FUERTE ALCISTA" y "FUERTE ALCISTA perdiendo fuerza" son lecturas muy
 * distintas del mismo 82, y ésa es exactamente la diferencia que el propietario
 * pidió poder ver.
 */
export function describeMomentum(reading: MomentumReading): string | null {
  if (reading.label === null) return null;

  const base = reading.label.replace(/_/g, ' ');
  switch (reading.trend) {
    case 'AUMENTANDO':
      return `${base} — en aceleración`;
    case 'DISMINUYENDO':
      return `${base} — perdiendo fuerza`;
    case 'ESTABLE':
      return `${base} — sostenido`;
    default:
      return base;
  }
}
