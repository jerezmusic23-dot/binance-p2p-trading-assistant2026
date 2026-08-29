/**
 * PROYECCIÓN POR ANALOGÍA: DISTRIBUCIÓN EMPÍRICA CONDICIONADA
 * ==========================================================
 *
 * Este módulo responde a UNA pregunta y sólo a una:
 *
 *     "Dado como se ha comportado el precio en las últimas L observaciones,
 *      ¿qué pasó históricamente en las situaciones más parecidas a ésta,
 *      H observaciones más tarde?"
 *
 * La respuesta no es un modelo ajustado ni una fórmula. Es un RECUENTO sobre
 * la propia serie: se buscan los momentos del pasado cuyo estado se parece más
 * al estado actual, se mira qué precio tenían H pasos después, y se publica la
 * distribución de esos resultados. Por eso toda probabilidad que sale de aquí
 * puede contestar "¿de dónde salió este número?" con "de N situaciones
 * históricas concretas", y el audit trail lleva los timestamps de esas N.
 *
 * LO QUE ESTE MÓDULO NO HACE
 * --------------------------
 * No introduce ningún coeficiente inventado. No hay multiplicadores de curva
 * de sesión, ni 1.004, ni 1.15, ni 1.6, ni un `confidencePct` calculado con
 * una fórmula sin respaldo. Cada constante de este archivo es (a) una unidad
 * medida sobre la propia serie, o (b) un umbral estadístico cuya derivación
 * está escrita al lado de la constante. No hay una tercera categoría.
 *
 * No toca captura, normalización, oportunidades, alertas ni Telegram: sólo
 * consume una serie de puntos {t, price} que ya existe.
 *
 * LA UNIDAD DE TODO: typicalStep
 * ------------------------------
 * Comparar "subió 0.8 VES" entre dos momentos no significa nada si en uno el
 * mercado se movía de 0.1 en 0.1 y en el otro de 2 en 2. Todo lo que se mide
 * aquí se divide por `typicalStep` (mediana de los saltos NO nulos de la
 * serie, importada de trendEngine), que es el tamaño de un movimiento normal
 * PARA ESTA SERIE. Así ninguna constante externa entra en la comparación.
 *
 * LA DERIVA ESTRUCTURAL DEL VES
 * -----------------------------
 * El bolívar se deprecia. Si "subió" se definiera como "delta > 0", casi todo
 * el histórico sería ALCISTA y la señal no diría nada. Por eso la dirección se
 * mide CONTRA EL RÉGIMEN: `regimeDelta` es la mediana de TODOS los cambios a H
 * pasos de la serie, y un análogo cuenta como UP sólo si superó esa deriva por
 * más de un typicalStep. "Subir" aquí significa "subir más de lo que este
 * mercado sube por defecto".
 *
 * LIMITACIONES CONOCIDAS, MEDIDAS, NO SUPUESTAS
 * ---------------------------------------------
 * 1. El estado mira L pasos hacia atrás, y L es el propio horizonte. Un ciclo
 *    más largo que L es INVISIBLE para él: si el mercado sube durante 60
 *    observaciones, una ventana de 30 ve "lleva 30 subiendo" tanto a mitad de
 *    la subida como justo en el máximo, y el modelo predice continuación en el
 *    giro. Comprobado sobre un diente de sierra sintético: el modelo queda por
 *    DEBAJO de la persistencia, y el backtest lo detecta y no lo publica.
 * 2. La hora del día no entra en la distancia (ver `AnalogState`), así que un
 *    patrón puramente horario no se puede aprender con este histórico.
 * 3. El método es empírico: no puede proyectar un régimen que la serie no haya
 *    contenido nunca. Ante un salto sin precedentes no tiene análogos, y lo
 *    que dirá es INSUFICIENTE HISTÓRICO, no una advertencia.
 *
 * VENTANAS SOLAPADAS E INDEPENDENCIA
 * ----------------------------------
 * Una serie de N puntos contiene N-H ventanas de horizonte H, pero sólo ~N/H
 * INDEPENDIENTES: dos ventanas que se solapan comparten casi todo su
 * movimiento y no son dos pruebas del modelo, son casi una. El punto estimado
 * se calcula con todos los análogos elegidos; el intervalo de confianza se
 * calcula con el número de análogos NO SOLAPADOS, que es el tamaño muestral
 * que realmente existe. Publicar el intervalo es obligatorio: es lo que
 * impide que "74%" se lea como una precisión que no tenemos.
 */

import { median, medianAbsoluteDeviation } from './marketStatistics';
import { typicalStep, GRADE_MODERATE_MULTIPLE, GRADE_STRONG_MULTIPLE } from './trendEngine';

export interface AnalogPoint {
  t: number;
  price: number;
}

export type AnalogOutcome = 'UP' | 'FLAT' | 'DOWN';
export type AnalogDirection = 'ALCISTA' | 'LATERAL' | 'BAJISTA';
export type AnalogStrength = 'DEBIL' | 'MODERADA' | 'FUERTE';

export type AnalogSkipReason =
  | 'INVALID_HORIZON'
  | 'NO_SERIES'
  | 'NO_CADENCE'
  | 'NO_TYPICAL_STEP'
  | 'HORIZON_LONGER_THAN_HISTORY'
  | 'CURRENT_STATE_UNMEASURABLE'
  | 'NOT_ENOUGH_ANALOGUES'
  | 'NOT_ENOUGH_INDEPENDENT_ANALOGUES';

/* ==========================================================================
 * CONSTANTES. Cada una con su derivación al lado, o no existe.
 * ========================================================================== */

/**
 * Un hueco de captura invalida la ventana que lo contiene.
 *
 * 1.5x la cadencia mediana es el punto medio entre el jitter normal de un
 * scheduler (un tick que llega tarde sigue siendo el mismo tick) y una
 * observación que sencillamente falta. Por debajo se descartarían ventanas
 * sanas; por encima se aceptaría una ventana con un agujero dentro y se
 * mediría un "paso" que en realidad son dos.
 */
export const GAP_TOLERANCE_MULTIPLE = 1.5;

/**
 * Mínimo de análogos NO SOLAPADOS para publicar algo.
 *
 * Los análogos se eligen ya sin solaparse (ver `selectIndependent`), así que
 * este único suelo cubre las dos exigencias a la vez:
 *
 *   - La banda publicada son los percentiles 10 y 90. Con n=40 descansan sobre
 *     el 4º y el 37º valor ordenado, no sobre un único extremo: un dato raro
 *     no puede fijar el borde de la banda. Con n=10 sí podría.
 *   - El error estándar de una proporción es <= 0.5/sqrt(n): con n=40 el peor
 *     caso son 7.9 puntos porcentuales. Es un suelo bajo a propósito. No
 *     pretende que 40 ventanas den precisión; pretende que por debajo no hay
 *     ni siquiera una lectura. La imprecisión que quede la enseña el intervalo
 *     de confianza, que se publica siempre.
 *
 * Consecuencia medible: para un horizonte de H pasos hacen falta ~41·H
 * observaciones. A 1 registro/minuto eso son ~21 h de histórico para publicar
 * +30 min, ~41 h para +1 h, y bastante más para +2 h. Los horizontes largos
 * dirán INSUFICIENTE HISTÓRICO durante mucho tiempo, y es correcto que lo
 * digan.
 */
export const MIN_ANALOGUES = 40;

/**
 * Cuántos análogos se usan cuando hay de sobra.
 *
 * k está FIJO y epsilon (la distancia máxima aceptada) es su CONSECUENCIA, no
 * al revés: no hay ningún umbral de similitud elegido a mano. Con más
 * histórico, los mismos 100 vecinos son simplemente más parecidos al presente.
 * 100 es donde el error estándar de una proporción deja de mejorar rápido:
 * pasar de 100 a 200 baja el peor caso de 5.0 a 3.5 puntos.
 */
export const TARGET_ANALOGUES = 100;

/**
 * Ventana mínima de contexto, en pasos.
 *
 * El estado incluye una aceleración, que es la velocidad de la segunda mitad
 * de la ventana menos la de la primera. Una ventana necesita por tanto dos
 * mitades de al menos dos puntos cada una: 4 pasos. Para horizontes mayores la
 * ventana es el propio horizonte (ver `lookbackFor`).
 */
export const MIN_LOOKBACK_STEPS = 4;

/** z de la normal a dos colas al 95%, para el intervalo de Wilson. */
export const CONFIDENCE_Z = 1.96;

/**
 * Nivel del contraste contra la persistencia, A UNA COLA.
 *
 * A una cola porque la pregunta no es "¿son distintos?" sino "¿es el modelo
 * MEJOR?". Un modelo significativamente peor que no hacer nada tampoco se
 * publica, pero no por este contraste: por no superarlo.
 *
 * Se corrige por Bonferroni entre todos los contrastes que se ejecutan a la
 * vez (ver `decideValidation`). Sin esa corrección, con 0.05 y diez contrastes
 * simultáneos —dos lados por cinco horizontes— la probabilidad de que ALGUNO
 * salga "validado" sobre ruido puro es del 40%. Medido: sobre un paseo
 * aleatorio sintético de 3.073 puntos, el horizonte de +30 min salía validado
 * en los dos lados. Ese es exactamente el falso positivo que la Regla 5
 * existe para impedir.
 */
export const VALIDATION_ALPHA = 0.05;

/**
 * Anclas mínimas para que el backtest signifique algo.
 *
 * Las anclas del backtest se toman cada H pasos, es decir sin solaparse, así
 * que 20 anclas son 20 pruebas independientes del modelo. Por debajo, la
 * comparación contra la persistencia no distingue habilidad de suerte.
 */
export const MIN_BACKTEST_ANCHORS = 20;

/**
 * Horizontes que se INTENTAN. No es una promesa: cada uno se publica sólo si
 * el histórico disponible lo sostiene, y si no, se marca INSUFICIENTE
 * HISTÓRICO. La lista es de intentos, no de resultados.
 */
export const DEFAULT_HORIZONS_MS: readonly number[] = [
  30 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
];

/* ==========================================================================
 * ESTADO: cómo se describe un instante
 * ========================================================================== */

/**
 * El vector de estado en un instante. Cada componente está en unidades de la
 * propia serie (typicalStep) o es una fracción acotada, nunca en VES crudos:
 * un mercado a 940 y uno a 47 tienen que poder ser "el mismo estado".
 *
 * La hora del día NO entra aquí. Con dos días de histórico, condicionar por
 * hora dividiría la muestra por 24 y dejaría cada horizonte sin análogos; se
 * guarda como metadato del ancla, no como componente de la distancia.
 */
export interface AnalogState {
  /** Recorrido de toda la ventana, en pasos típicos. */
  drift: number;
  /** Recorrido por observación, en pasos típicos. */
  velocity: number;
  /** Velocidad de la segunda mitad menos la de la primera. */
  acceleration: number;
  /** Dispersión de los saltos dentro de la ventana, en pasos típicos. */
  volatility: number;
  /** Dónde está el precio actual dentro del rango de la ventana, 0..1. */
  position: number;
}

const FEATURE_KEYS: readonly (keyof AnalogState)[] = [
  'drift',
  'velocity',
  'acceleration',
  'volatility',
  'position',
];

interface Candidate {
  index: number;
  t: number;
  price: number;
  state: AnalogState;
  /** Cambio observado H pasos después, o null si no hay futuro completo. */
  delta: number | null;
}

/* ==========================================================================
 * SALIDA
 * ========================================================================== */

export interface AnalogSample {
  t: number;
  price: number;
  delta: number;
  outcome: AnalogOutcome;
  distance: number;
}

export interface AnalogAudit {
  /** Serie y tramo del que salió todo. */
  observations: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  medianIntervalMs: number | null;
  typicalStep: number | null;

  /** Horizonte tal y como se midió realmente sobre esta cadencia. */
  horizonSteps: number;
  measuredHorizonMs: number | null;
  lookbackSteps: number;

  /** De cuántos candidatos salieron los análogos, y hasta qué distancia. */
  candidatePool: number;
  analoguesUsed: number;
  independentAnalogues: number;
  maxDistanceUsed: number | null;
  featureScales: Record<string, number>;

  /** La división de la que sale la probabilidad, con sus dos términos. */
  upCount: number;
  flatCount: number;
  downCount: number;

  /** La deriva del régimen contra la que se juzgó cada análogo. */
  regimeDelta: number | null;
  directionThreshold: number | null;

  /** Los percentiles publicados. */
  p10: number | null;
  p50: number | null;
  p90: number | null;

  /** Los N casos concretos. Esto es la respuesta a "¿de dónde salió?". */
  samples: AnalogSample[];
}

export interface AnalogHorizonProjection {
  requestedHorizonMs: number;
  label: string;
  available: boolean;
  reason: AnalogSkipReason | null;
  /** Texto listo para pantalla cuando `available` es false. */
  reasonText: string | null;

  currentPrice: number | null;
  /** Escenario central: precio actual + mediana de los análogos. */
  central: number | null;
  /** Rango probable: percentiles 10 y 90 de los análogos. */
  low: number | null;
  high: number | null;

  /** Fracciones 0..1, calculadas sobre `analoguesUsed`. */
  probabilityUp: number | null;
  probabilityFlat: number | null;
  probabilityDown: number | null;
  /** Intervalo de Wilson al 95% sobre probabilityUp, con n independiente. */
  probabilityUpLow: number | null;
  probabilityUpHigh: number | null;

  direction: AnalogDirection | null;
  strength: AnalogStrength | null;

  /** La frase que el usuario aprobó, o null si no hay proyección. */
  evidence: string | null;

  audit: AnalogAudit | null;
}

export interface AnalogBaselineReport {
  requestedHorizonMs: number;
  label: string;
  /** Anclas no solapadas realmente evaluadas. */
  anchors: number;
  skipped: number;

  /*
   * DIAGNÓSTICO, NO CRITERIO.
   *
   * Estas dos precisiones se publican porque son legibles, pero NO deciden
   * nada, y la razón importa: bajo una banda de +-1 paso típico, "no se mueve"
   * es un resultado POCO FRECUENTE. En una serie que se mueve el 85% de las
   * veces, cualquier predictor que se atreva a decir SUBE o BAJA supera a
   * "siempre LATERAL" por la frecuencia de las clases, sin una sola pizca de
   * habilidad. Comparar estas dos cifras y declarar ventaja fue exactamente el
   * falso positivo que se midió sobre un paseo aleatorio sintético.
   */
  directionalAccuracy: number | null;
  persistenceDirectionalAccuracy: number | null;
  /** Anclas cuyo precio real cayó dentro de la banda publicada. */
  bandCoverage: number | null;

  /*
   * EL CRITERIO. Error absoluto de precio contra el de la persistencia.
   *
   * La persistencia predice "el precio de dentro de H es el de ahora". El
   * modelo predice su escenario central. Se compara ancla por ancla quién se
   * acercó más. Esto no se puede ganar explotando la frecuencia de una clase:
   * hay que acertar el precio mejor que no moverse.
   */
  modelMedianAbsError: number | null;
  persistenceMedianAbsError: number | null;
  modelBetterCount: number;
  persistenceBetterCount: number;
  tiedCount: number;

  /** Test de signos exacto sobre los pares no empatados. */
  pValue: number | null;
  /** Nivel exigido tras corregir por el número de contrastes simultáneos. */
  alpha: number | null;
  /** Cuántos contrastes entraron en esa corrección. */
  familySize: number | null;
  /** true sólo si pValue <= alpha. null si el contraste no llegó a hacerse. */
  beatsPersistence: boolean | null;
  reason: 'INSUFFICIENT_ANCHORS' | null;
}

export interface AnalogProjection {
  seriesId: string;
  label: string;
  generatedAt: number;

  observations: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  medianIntervalMs: number | null;
  typicalStep: number | null;
  currentPrice: number | null;

  /** Serie REAL observada, para la parte izquierda del gráfico. */
  history: AnalogPoint[];

  horizons: AnalogHorizonProjection[];
  baselines: AnalogBaselineReport[];

  /**
   * false mientras el modelo no supere a la persistencia de forma
   * estadísticamente razonable. Los números siguen publicándose, pero la UI
   * tiene que decir que no son utilizables todavía.
   */
  usable: boolean;
  notice: string | null;
}

export interface AnalogProjectionOptions {
  seriesId?: string;
  label?: string;
  horizonsMs?: readonly number[];
  /** Cuántos puntos reales devolver para el gráfico. */
  historyTail?: number;
  now?: number;
}

/* ==========================================================================
 * UTILIDADES
 * ========================================================================== */

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Serie limpia: finita, precio positivo, orden ascendente, sin t repetidos. */
export function sanitiseSeries(points: readonly AnalogPoint[]): AnalogPoint[] {
  const clean = points
    .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.price) && p.price > 0)
    .map((p) => ({ t: p.t, price: p.price }))
    .sort((a, b) => a.t - b.t);

  const out: AnalogPoint[] = [];
  for (const p of clean) {
    if (out.length > 0 && out[out.length - 1].t === p.t) {
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/** Cadencia real de la serie: mediana de los huecos entre observaciones. */
export function medianIntervalMs(points: readonly AnalogPoint[]): number | null {
  if (points.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const gap = points[i].t - points[i - 1].t;
    if (gap > 0) gaps.push(gap);
  }
  const m = median(gaps);
  return m !== null && m > 0 ? m : null;
}

function gapFree(points: readonly AnalogPoint[], from: number, to: number, tolerance: number): boolean {
  for (let i = from + 1; i <= to; i += 1) {
    if (points[i].t - points[i - 1].t > tolerance) return false;
  }
  return true;
}

/**
 * Percentil por orden estadístico, misma convención que patternEngine:
 * el índice es floor(q*n) acotado, sin interpolar. Dos módulos que publican
 * bandas tienen que calcularlas igual o sus números no son comparables.
 */
export function percentileOf(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** Ventana de contexto para un horizonte: describir el mismo tramo que se va a proyectar. */
export function lookbackFor(horizonSteps: number): number {
  return Math.max(MIN_LOOKBACK_STEPS, horizonSteps);
}

/**
 * Observaciones mínimas para que un horizonte sea siquiera posible.
 *
 * MIN_ANALOGUES tramos de H pasos que no se solapan, más el tramo del presente,
 * más la ventana de contexto que hay que poder mirar hacia atrás.
 */
export function minimumLengthFor(horizonSteps: number, lookbackSteps: number): number {
  return lookbackSteps + horizonSteps * (MIN_ANALOGUES + 1);
}

export function describeSkipReason(reason: AnalogSkipReason): string {
  switch (reason) {
    case 'INVALID_HORIZON':
      return 'HORIZONTE INVÁLIDO: sólo se puede proyectar hacia adelante.';
    case 'NO_SERIES':
      return 'SIN DATOS: no hay serie histórica que analizar.';
    case 'NO_CADENCE':
      return 'SIN DATOS: no se puede medir la cadencia de captura.';
    case 'NO_TYPICAL_STEP':
      return 'SIN DATOS: no hay suficientes observaciones para medir un movimiento típico.';
    case 'HORIZON_LONGER_THAN_HISTORY':
      return 'INSUFICIENTE HISTÓRICO: el horizonte es más largo que el histórico disponible.';
    case 'CURRENT_STATE_UNMEASURABLE':
      return 'INSUFICIENTE HISTÓRICO: faltan observaciones recientes continuas para describir el estado actual.';
    case 'NOT_ENOUGH_ANALOGUES':
      return `INSUFICIENTE HISTÓRICO: no hay ni ${MIN_ANALOGUES} instantes pasados con su resultado ya observado.`;
    case 'NOT_ENOUGH_INDEPENDENT_ANALOGUES':
      return `INSUFICIENTE HISTÓRICO: hacen falta ${MIN_ANALOGUES} situaciones comparables que no se solapen entre sí, y no las hay.`;
    default:
      return 'INSUFICIENTE HISTÓRICO.';
  }
}

export function describeHorizon(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `+${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `+${hours} h` : `+${hours.toFixed(1)} h`;
}

/**
 * Intervalo de Wilson al 95%.
 *
 * En lugar del intervalo normal, que a proporciones extremas se sale de [0,1]
 * y con n pequeño miente. `n` debe ser el número de observaciones
 * INDEPENDIENTES, no el de ventanas solapadas.
 */
/** log Gamma (Lanczos), para calcular combinatorios sin desbordar. */
function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = c[0];
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i += 1) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * P(X >= successes) con X ~ Binomial(trials, 0.5). Contraste EXACTO.
 *
 * Se usa el exacto y no la aproximación normal de McNemar porque con pocos
 * pares discordantes la normal es sencillamente incorrecta, y "pocos pares
 * discordantes" es el caso NORMAL aquí: un histórico de dos días da unas
 * decenas de anclas no solapadas, no miles. La aproximación obligaría además
 * a un mínimo artificial de discordantes; el exacto no necesita ninguno.
 */
export function binomialTailProbability(successes: number, trials: number): number {
  if (!Number.isFinite(successes) || !Number.isFinite(trials) || trials <= 0) return 1;
  const k0 = Math.max(0, Math.ceil(successes));
  if (k0 > trials) return 0;

  const logHalfPow = -trials * Math.LN2;
  let total = 0;
  for (let k = k0; k <= trials; k += 1) {
    const logTerm =
      logGamma(trials + 1) - logGamma(k + 1) - logGamma(trials - k + 1) + logHalfPow;
    total += Math.exp(logTerm);
  }
  return Math.min(1, Math.max(0, total));
}

export function wilsonInterval(successes: number, total: number, n: number): {
  low: number | null;
  high: number | null;
} {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || total <= 0 || n <= 0) {
    return { low: null, high: null };
  }
  const p = successes / total;
  const z = CONFIDENCE_Z;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return {
    low: Math.max(0, centre - half),
    high: Math.min(1, centre + half),
  };
}

/* ==========================================================================
 * EL ESTADO DE UN INSTANTE
 * ========================================================================== */

/**
 * Describe la ventana `points[from..to]` como vector de estado.
 *
 * `step` es el typicalStep de la serie completa. Cuando es 0 la serie nunca se
 * movió: todos los componentes de recorrido son 0 por definición, no por
 * división por cero.
 */
export function stateOf(
  points: readonly AnalogPoint[],
  from: number,
  to: number,
  step: number
): AnalogState | null {
  const span = to - from;
  if (span < 2) return null;

  const norm = (value: number) => (step > 0 ? value / step : 0);

  const first = points[from].price;
  const last = points[to].price;
  const drift = norm(last - first);
  const velocity = drift / span;

  const mid = from + Math.floor(span / 2);
  const firstHalfSpan = mid - from;
  const secondHalfSpan = to - mid;
  const acceleration =
    firstHalfSpan >= 1 && secondHalfSpan >= 1
      ? norm(points[to].price - points[mid].price) / secondHalfSpan -
        norm(points[mid].price - points[from].price) / firstHalfSpan
      : 0;

  const steps: number[] = [];
  let min = points[from].price;
  let max = points[from].price;
  for (let i = from + 1; i <= to; i += 1) {
    steps.push(points[i].price - points[i - 1].price);
    if (points[i].price < min) min = points[i].price;
    if (points[i].price > max) max = points[i].price;
  }
  const mad = medianAbsoluteDeviation(steps);
  const volatility = mad === null ? 0 : norm(mad);

  const range = max - min;
  const position = range > 0 ? (last - min) / range : 0.5;

  const state: AnalogState = { drift, velocity, acceleration, volatility, position };
  for (const key of FEATURE_KEYS) {
    if (!Number.isFinite(state[key])) return null;
  }
  return state;
}

/**
 * Todos los instantes de la serie que se pueden describir, con su resultado a
 * H pasos cuando existe.
 *
 * Una ventana con un hueco de captura dentro se descarta entera: si falta una
 * observación en medio, el "paso" medido a través del hueco no es un paso.
 */
function buildCandidates(
  points: readonly AnalogPoint[],
  horizonSteps: number,
  lookbackSteps: number,
  step: number,
  cadenceMs: number
): Candidate[] {
  const tolerance = cadenceMs * GAP_TOLERANCE_MULTIPLE;
  const out: Candidate[] = [];

  for (let i = lookbackSteps; i < points.length; i += 1) {
    if (!gapFree(points, i - lookbackSteps, i, tolerance)) continue;
    const state = stateOf(points, i - lookbackSteps, i, step);
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
 * Escala de cada componente: su MAD sobre el conjunto de candidatos.
 *
 * Sin esto, el componente con más rango domina la distancia por accidente de
 * unidades y la "similitud" acaba decidida por una elección de escala que
 * nadie tomó conscientemente. Dividiendo por la dispersión observada de cada
 * componente, la distancia queda en desviaciones robustas de la propia serie:
 * ninguna ponderación entra a mano.
 *
 * MAD 0 (todos los candidatos idénticos en ese componente) cae a 1, que en
 * estas unidades es "un paso típico": no se descarta el componente, porque el
 * presente sí puede diferir de esa constante y esa diferencia es real.
 */
function featureScales(candidates: readonly Candidate[]): Record<string, number> {
  const scales: Record<string, number> = {};
  for (const key of FEATURE_KEYS) {
    const values = candidates.map((c) => c.state[key]);
    const mad = medianAbsoluteDeviation(values);
    scales[key] = mad !== null && mad > 0 ? mad : 1;
  }
  return scales;
}

function distanceBetween(
  a: AnalogState,
  b: AnalogState,
  scales: Record<string, number>
): number {
  let sum = 0;
  for (const key of FEATURE_KEYS) {
    const d = (a[key] - b[key]) / scales[key];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Clasifica un resultado CONTRA EL RÉGIMEN, no contra cero.
 *
 * `regime` es la deriva mediana de la serie a este horizonte. Un análogo sube
 * sólo si superó esa deriva por más de un paso típico; si no, hizo lo que este
 * mercado hace por defecto, que no es una subida: es el fondo.
 */
export function classifyOutcome(delta: number, regime: number, step: number): AnalogOutcome {
  const threshold = step;
  const excess = delta - regime;
  if (excess > threshold) return 'UP';
  if (excess < -threshold) return 'DOWN';
  return 'FLAT';
}

/** Grado del movimiento en pasos típicos, con los mismos cortes que trendEngine. */
function gradeMove(excess: number, step: number): { direction: AnalogDirection; strength: AnalogStrength } {
  if (step <= 0) {
    return {
      direction: excess > 0 ? 'ALCISTA' : excess < 0 ? 'BAJISTA' : 'LATERAL',
      strength: excess === 0 ? 'DEBIL' : 'FUERTE',
    };
  }
  const multiple = excess / step;
  const size = Math.abs(multiple);
  const direction: AnalogDirection = size <= 1 ? 'LATERAL' : multiple > 0 ? 'ALCISTA' : 'BAJISTA';
  const strength: AnalogStrength =
    size >= GRADE_STRONG_MULTIPLE ? 'FUERTE' : size >= GRADE_MODERATE_MULTIPLE ? 'MODERADA' : 'DEBIL';
  return { direction, strength };
}

/**
 * Elige los `cap` análogos más parecidos QUE NO SE SOLAPAN ENTRE SÍ.
 *
 * Éste es el punto donde el motor se aparta del k-NN de manual, y a propósito.
 * En una serie temporal los vecinos más cercanos de un instante son casi
 * siempre los instantes de al lado: sus ventanas comparten casi todas las
 * observaciones y sus resultados casi todo el movimiento. Un k-NN corriente
 * devolvería 100 "casos" que en realidad son tres o cuatro tramos contados
 * muchas veces, y la probabilidad resultante parecería descansar sobre 100
 * pruebas cuando descansa sobre cuatro.
 *
 * Se recorre por cercanía y se acepta un ancla sólo si dista al menos H pasos
 * de todas las ya aceptadas. Lo que se pierde son vecinos muy próximos que no
 * añadían información; lo que se gana es que `analoguesUsed` signifique
 * literalmente "situaciones distintas", y que el intervalo de confianza pueda
 * calcularse con ese número sin mentir.
 */
function selectIndependent<T extends { candidate: Candidate }>(
  ranked: readonly T[],
  horizonSteps: number,
  cap: number
): T[] {
  const taken: T[] = [];
  const takenIndices: number[] = [];

  for (const entry of ranked) {
    if (taken.length >= cap) break;
    const index = entry.candidate.index;
    if (takenIndices.every((other) => Math.abs(index - other) >= horizonSteps)) {
      taken.push(entry);
      takenIndices.push(index);
    }
  }

  return taken;
}

function unavailable(
  requested: number,
  reason: AnalogSkipReason,
  currentPrice: number | null
): AnalogHorizonProjection {
  /*
   * Se devuelve el horizonte pedido, pero NUNCA un no-finito: la garantía de
   * este módulo es que ningún NaN ni Infinity sale de él, y devolver tal cual
   * lo que llegó abriría justo esa puerta. Un horizonte no finito se informa
   * como 0, que es lo que vale como duración.
   */
  const requestedHorizonMs = Number.isFinite(requested) ? requested : 0;

  return {
    requestedHorizonMs,
    label: describeHorizon(requestedHorizonMs),
    available: false,
    reason,
    reasonText: describeSkipReason(reason),
    currentPrice,
    central: null,
    low: null,
    high: null,
    probabilityUp: null,
    probabilityFlat: null,
    probabilityDown: null,
    probabilityUpLow: null,
    probabilityUpHigh: null,
    direction: null,
    strength: null,
    evidence: null,
    audit: null,
  };
}

/* ==========================================================================
 * PROYECCIÓN DE UN HORIZONTE
 * ========================================================================== */

/**
 * Proyecta un horizonte sobre `points`, usando SÓLO `points`.
 *
 * Esta función no sabe nada de "ahora": el presente es siempre el último punto
 * que recibe. Por eso el backtest puede llamarla con un prefijo y obtener
 * exactamente la proyección que el sistema habría publicado en ese momento,
 * sin ninguna fuga de futuro.
 */
export function projectHorizon(
  points: readonly AnalogPoint[],
  requestedHorizonMs: number
): AnalogHorizonProjection {
  const series = points;
  const currentPrice = series.length > 0 ? series[series.length - 1].price : null;

  /*
   * Un horizonte de cero o negativo no es "muy corto": es una pregunta sobre
   * el pasado disfrazada de proyección. Se rechaza aquí en lugar de redondear
   * a un paso, que además convertía el backtest en un recorrido cuadrático
   * sobre la serie entera.
   */
  if (!Number.isFinite(requestedHorizonMs) || requestedHorizonMs <= 0) {
    return unavailable(requestedHorizonMs, 'INVALID_HORIZON', currentPrice);
  }

  if (series.length < 2) return unavailable(requestedHorizonMs, 'NO_SERIES', currentPrice);

  const cadence = medianIntervalMs(series);
  if (cadence === null) return unavailable(requestedHorizonMs, 'NO_CADENCE', currentPrice);

  const step = typicalStep(series);
  if (step === null) return unavailable(requestedHorizonMs, 'NO_TYPICAL_STEP', currentPrice);

  const horizonSteps = Math.max(1, Math.round(requestedHorizonMs / cadence));
  const lookbackSteps = lookbackFor(horizonSteps);

  // Longitud mínima concebible: la ventana de contexto, más MIN_ANALOGUES
  // tramos de H pasos que no se solapan, más el tramo del propio presente.
  // Por debajo de eso la serie NO PUEDE contener los análogos exigidos, y
  // recorrerla entera para descubrirlo sería trabajo tirado.
  if (series.length < minimumLengthFor(horizonSteps, lookbackSteps)) {
    return unavailable(requestedHorizonMs, 'HORIZON_LONGER_THAN_HISTORY', currentPrice);
  }

  const candidates = buildCandidates(series, horizonSteps, lookbackSteps, step, cadence);
  const lastIndex = series.length - 1;
  const current = candidates.find((c) => c.index === lastIndex);
  if (!current) return unavailable(requestedHorizonMs, 'CURRENT_STATE_UNMEASURABLE', currentPrice);

  const pool = candidates.filter((c) => c.delta !== null && c.index !== lastIndex);
  if (pool.length < MIN_ANALOGUES) {
    return unavailable(requestedHorizonMs, 'NOT_ENOUGH_ANALOGUES', currentPrice);
  }

  const scales = featureScales(pool);
  const ranked = pool
    .map((c) => ({ candidate: c, distance: distanceBetween(current.state, c.state, scales) }))
    .filter((r) => Number.isFinite(r.distance))
    .sort((a, b) => a.distance - b.distance);

  if (ranked.length < MIN_ANALOGUES) {
    return unavailable(requestedHorizonMs, 'NOT_ENOUGH_ANALOGUES', currentPrice);
  }

  const chosen = selectIndependent(ranked, horizonSteps, TARGET_ANALOGUES);
  if (chosen.length < MIN_ANALOGUES) {
    return unavailable(requestedHorizonMs, 'NOT_ENOUGH_INDEPENDENT_ANALOGUES', currentPrice);
  }
  // Independientes por construcción: `selectIndependent` no acepta dos anclas
  // separadas por menos del horizonte.
  const independent = chosen.length;

  // El régimen se mide sobre TODA la historia disponible del horizonte, no
  // sobre los análogos: es el fondo contra el que los análogos se juzgan.
  const regimeDelta = median(pool.map((c) => c.delta as number));
  const regime = regimeDelta ?? 0;

  const deltas = chosen.map((r) => r.candidate.delta as number);
  const sorted = [...deltas].sort((a, b) => a - b);
  const p10 = percentileOf(sorted, 0.1);
  const p50 = percentileOf(sorted, 0.5);
  const p90 = percentileOf(sorted, 0.9);

  let upCount = 0;
  let downCount = 0;
  let flatCount = 0;
  const samples: AnalogSample[] = chosen.map((r) => {
    const delta = r.candidate.delta as number;
    const outcome = classifyOutcome(delta, regime, step);
    if (outcome === 'UP') upCount += 1;
    else if (outcome === 'DOWN') downCount += 1;
    else flatCount += 1;
    return {
      t: r.candidate.t,
      price: r.candidate.price,
      delta,
      outcome,
      distance: r.distance,
    };
  });

  const total = samples.length;
  const price = currentPrice as number;
  const central = p50 === null ? null : price + p50;
  const low = p10 === null ? null : price + p10;
  const high = p90 === null ? null : price + p90;

  const wilson = wilsonInterval(upCount, total, independent);
  const { direction, strength } = gradeMove((p50 ?? 0) - regime, step);

  return {
    requestedHorizonMs,
    label: describeHorizon(requestedHorizonMs),
    available: true,
    reason: null,
    reasonText: null,
    currentPrice: finiteOrNull(price),
    central: finiteOrNull(central),
    low: finiteOrNull(low),
    high: finiteOrNull(high),
    probabilityUp: total > 0 ? upCount / total : null,
    probabilityFlat: total > 0 ? flatCount / total : null,
    probabilityDown: total > 0 ? downCount / total : null,
    probabilityUpLow: finiteOrNull(wilson.low),
    probabilityUpHigh: finiteOrNull(wilson.high),
    direction,
    strength,
    evidence:
      `En situaciones históricas similares, ${upCount} de ${total} casos terminaron ` +
      `por encima del precio actual a ${describeHorizon(requestedHorizonMs)}.`,
    audit: {
      observations: series.length,
      firstTimestamp: series[0].t,
      lastTimestamp: series[lastIndex].t,
      medianIntervalMs: cadence,
      typicalStep: step,
      horizonSteps,
      measuredHorizonMs: horizonSteps * cadence,
      lookbackSteps,
      candidatePool: pool.length,
      analoguesUsed: total,
      independentAnalogues: independent,
      maxDistanceUsed: chosen.length > 0 ? chosen[chosen.length - 1].distance : null,
      featureScales: scales,
      upCount,
      flatCount,
      downCount,
      regimeDelta: finiteOrNull(regimeDelta),
      directionThreshold: finiteOrNull(step),
      p10,
      p50,
      p90,
      samples,
    },
  };
}

/* ==========================================================================
 * BACKTEST CONTRA PERSISTENCIA
 * ==========================================================================
 *
 * La única pregunta que decide si esto sirve: ¿acierta más que decir "el
 * precio se queda donde está"? Una precisión direccional del 68% no significa
 * nada suelta; si la persistencia acierta el 70% en la misma serie, el modelo
 * está por debajo de no hacer nada.
 *
 * SIN FUGA DE FUTURO. En cada ancla se llama a `projectHorizon` con el
 * PREFIJO de la serie hasta esa ancla. El modelo ve exactamente lo que habría
 * visto en ese instante.
 *
 * ANCLAS NO SOLAPADAS. Se avanza de H en H pasos, así que cada ancla es una
 * prueba independiente y el contraste estadístico no cuenta la misma
 * evidencia varias veces.
 */

interface AnchorResult {
  directionCorrect: boolean;
  persistenceDirectionCorrect: boolean;
  insideBand: boolean;
  modelAbsError: number;
  persistenceAbsError: number;
}

export function backtestHorizon(
  points: readonly AnalogPoint[],
  requestedHorizonMs: number
): AnalogBaselineReport {
  // Mismo motivo que en `unavailable`: nada no finito sale de aquí.
  const echoHorizonMs = Number.isFinite(requestedHorizonMs) ? requestedHorizonMs : 0;
  const label = describeHorizon(echoHorizonMs);
  const empty: AnalogBaselineReport = {
    requestedHorizonMs: echoHorizonMs,
    label,
    anchors: 0,
    skipped: 0,
    directionalAccuracy: null,
    persistenceDirectionalAccuracy: null,
    bandCoverage: null,
    modelMedianAbsError: null,
    persistenceMedianAbsError: null,
    modelBetterCount: 0,
    persistenceBetterCount: 0,
    tiedCount: 0,
    pValue: null,
    alpha: null,
    familySize: null,
    beatsPersistence: null,
    reason: 'INSUFFICIENT_ANCHORS',
  };

  if (!Number.isFinite(requestedHorizonMs) || requestedHorizonMs <= 0) return empty;

  const cadence = medianIntervalMs(points);
  const step = typicalStep(points);
  if (cadence === null || step === null) return empty;

  const horizonSteps = Math.max(1, Math.round(requestedHorizonMs / cadence));
  const lookbackSteps = lookbackFor(horizonSteps);
  const firstAnchor = minimumLengthFor(horizonSteps, lookbackSteps);
  if (firstAnchor >= points.length - horizonSteps) return empty;

  const results: AnchorResult[] = [];
  let skipped = 0;

  for (let anchor = firstAnchor; anchor + horizonSteps < points.length; anchor += horizonSteps) {
    const prefix = points.slice(0, anchor + 1);
    const projection = projectHorizon(prefix, requestedHorizonMs);
    if (!projection.available || projection.audit === null || projection.central === null) {
      skipped += 1;
      continue;
    }

    const anchorPrice = points[anchor].price;
    const actualPrice = points[anchor + horizonSteps].price;
    const actualDelta = actualPrice - anchorPrice;

    // El resultado real se clasifica con el régimen y el paso MEDIDOS SOBRE EL
    // PREFIJO, nunca sobre la serie completa: usar el régimen final sería
    // juzgar el pasado con información que en ese momento no existía.
    const prefixRegime = projection.audit.regimeDelta ?? 0;
    const prefixStep = projection.audit.typicalStep ?? 0;
    const actualOutcome = classifyOutcome(actualDelta, prefixRegime, prefixStep);

    const predicted: AnalogOutcome =
      projection.direction === 'ALCISTA' ? 'UP' : projection.direction === 'BAJISTA' ? 'DOWN' : 'FLAT';

    results.push({
      directionCorrect: predicted === actualOutcome,
      // La persistencia no se aparta del régimen: su predicción es LATERAL.
      persistenceDirectionCorrect: actualOutcome === 'FLAT',
      insideBand:
        projection.low !== null &&
        projection.high !== null &&
        actualPrice >= projection.low &&
        actualPrice <= projection.high,
      modelAbsError: Math.abs(actualPrice - projection.central),
      // La persistencia predice literalmente el precio de ahora.
      persistenceAbsError: Math.abs(actualPrice - anchorPrice),
    });
  }

  if (results.length < MIN_BACKTEST_ANCHORS) {
    return { ...empty, anchors: results.length, skipped };
  }

  const n = results.length;
  const directionCorrect = results.filter((r) => r.directionCorrect).length;
  const persistenceDirection = results.filter((r) => r.persistenceDirectionCorrect).length;
  const inside = results.filter((r) => r.insideBand).length;

  /*
   * TEST DE SIGNOS EXACTO SOBRE EL ERROR DE PRECIO.
   *
   * Se cuenta en cuántas anclas el modelo se acercó más que la persistencia.
   * Bajo la hipótesis de que los dos son igual de buenos, ese recuento es una
   * binomial de p=0.5, y su cola es exacta sin ninguna aproximación. Los
   * empates no distinguen a nadie y se excluyen, que es lo que hace un test de
   * signos.
   *
   * No paramétrico a propósito: los errores de precio tienen colas gruesas y
   * una t de Student sobre ellos prometería una precisión que no existe.
   */
  let modelBetterCount = 0;
  let persistenceBetterCount = 0;
  let tiedCount = 0;
  for (const r of results) {
    if (r.modelAbsError < r.persistenceAbsError) modelBetterCount += 1;
    else if (r.modelAbsError > r.persistenceAbsError) persistenceBetterCount += 1;
    else tiedCount += 1;
  }
  const decisive = modelBetterCount + persistenceBetterCount;

  // La decisión se deja SIN TOMAR aquí a propósito: depende de cuántos
  // contrastes se ejecuten a la vez, y este horizonte no lo sabe.
  // `decideValidation` la toma cuando la familia completa está sobre la mesa.
  return {
    requestedHorizonMs,
    label,
    anchors: n,
    skipped,
    directionalAccuracy: directionCorrect / n,
    persistenceDirectionalAccuracy: persistenceDirection / n,
    bandCoverage: inside / n,
    modelMedianAbsError: median(results.map((r) => r.modelAbsError)),
    persistenceMedianAbsError: median(results.map((r) => r.persistenceAbsError)),
    modelBetterCount,
    persistenceBetterCount,
    tiedCount,
    pValue: decisive > 0 ? binomialTailProbability(modelBetterCount, decisive) : null,
    alpha: null,
    familySize: null,
    beatsPersistence: null,
    reason: null,
  };
}

/* ==========================================================================
 * ENTRADA PÚBLICA
 * ========================================================================== */

export const DEFAULT_HISTORY_TAIL = 240;

export function projectByAnalogy(
  rawPoints: readonly AnalogPoint[],
  options: AnalogProjectionOptions = {}
): AnalogProjection {
  const series = sanitiseSeries(rawPoints);
  const horizonsMs = options.horizonsMs ?? DEFAULT_HORIZONS_MS;
  const tail = options.historyTail ?? DEFAULT_HISTORY_TAIL;
  const generatedAt = options.now ?? Date.now();

  const cadence = medianIntervalMs(series);
  const step = typicalStep(series);
  const currentPrice = series.length > 0 ? series[series.length - 1].price : null;

  const horizons = horizonsMs.map((ms) => projectHorizon(series, ms));
  const baselines = horizonsMs.map((ms) => backtestHorizon(series, ms));

  const draft: AnalogProjection = {
    seriesId: options.seriesId ?? 'SERIE',
    label: options.label ?? 'Serie histórica',
    generatedAt,
    observations: series.length,
    firstTimestamp: series.length > 0 ? series[0].t : null,
    lastTimestamp: series.length > 0 ? series[series.length - 1].t : null,
    medianIntervalMs: cadence,
    typicalStep: step,
    currentPrice: finiteOrNull(currentPrice),
    history: tail > 0 ? series.slice(-tail) : [],
    horizons,
    baselines,
    usable: false,
    notice: null,
  };

  return decideValidation([draft])[0];
}

/**
 * TOMA LA DECISIÓN "¿ESTO SIRVE?" PARA UNA FAMILIA DE CONTRASTES A LA VEZ.
 *
 * Se separa del cálculo porque la corrección por comparaciones múltiples sólo
 * puede aplicarse cuando se sabe cuántos contrastes se están haciendo. Un
 * horizonte aislado no lo sabe; la pantalla, que enseña dos lados y varios
 * horizontes juntos, sí.
 *
 * La familia son los contrastes REALMENTE EJECUTADOS: los horizontes que se
 * quedaron sin anclas no llegaron a contrastar nada y no cuentan. Contarlos
 * endurecería el umbral con pruebas que nunca se hicieron.
 *
 * Función pura: devuelve copias, no toca lo que recibe. Volver a llamarla con
 * otra familia recalcula la decisión sin repetir el backtest, que es la parte
 * cara.
 */
export function decideValidation(
  projections: readonly AnalogProjection[]
): AnalogProjection[] {
  const familySize = projections.reduce(
    (count, projection) =>
      count + projection.baselines.filter((b) => b.pValue !== null).length,
    0
  );
  const alpha = familySize > 0 ? VALIDATION_ALPHA / familySize : null;

  return projections.map((projection) => {
    const baselines = projection.baselines.map((baseline) => {
      if (baseline.pValue === null || alpha === null) {
        return { ...baseline, alpha: null, familySize: null, beatsPersistence: baseline.reason === null ? false : null };
      }
      return {
        ...baseline,
        alpha,
        familySize,
        beatsPersistence: baseline.pValue <= alpha,
      };
    });

    const validated = projection.horizons.filter((h) => {
      if (!h.available) return false;
      const baseline = baselines.find((b) => b.requestedHorizonMs === h.requestedHorizonMs);
      return baseline?.beatsPersistence === true;
    });

    const published = projection.horizons.filter((h) => h.available);
    let notice: string | null = null;
    if (published.length === 0) {
      notice =
        'INSUFICIENTE HISTÓRICO: ningún horizonte tiene todavía suficientes situaciones ' +
        'comparables. No se publica ninguna proyección.';
    } else if (validated.length === 0) {
      notice =
        'PROYECCIÓN NO VALIDADA: el modelo todavía no supera de forma estadísticamente ' +
        'significativa al supuesto de que el precio se queda donde está. Los números se ' +
        'muestran como referencia, no como recomendación.';
    }

    return { ...projection, baselines, usable: validated.length > 0, notice };
  });
}
