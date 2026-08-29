/**
 * PROBABILIDADES QUE SON RECUENTOS
 * ================================
 *
 * Ninguna función de este archivo inventa una probabilidad. Todas parten de
 * "de N casos, X hicieron tal cosa" y devuelven X/N con su incertidumbre al
 * lado. Si un día alguien quiere saber de dónde salió un 74%, la respuesta
 * está en los dos enteros que lo produjeron.
 *
 * PRECISIÓN HONESTA
 *
 * Una frecuencia de 40 casos no se publica como 73.84291%. Los porcentajes se
 * redondean a la precisión que la muestra sostiene (ver `roundProbability`) y
 * SIEMPRE viajan con su intervalo de confianza al 95%.
 */

import type { Analogue } from './historicalAnalogies.js';
import { finiteOrNull, percentileOf } from './series.js';

export type Outcome = 'UP' | 'FLAT' | 'DOWN';

/** z de la normal a dos colas al 95%. */
export const CONFIDENCE_Z = 1.96;

/**
 * Nivel del contraste contra la persistencia, A UNA COLA.
 *
 * A una cola porque la pregunta no es "¿son distintos?" sino "¿es el modelo
 * MEJOR?". Se corrige por Bonferroni entre todos los contrastes simultáneos.
 */
export const VALIDATION_ALPHA = 0.05;

/**
 * Casos mínimos para dar un rango a un escenario.
 *
 * Un rango son los percentiles 10 y 90 del grupo. Con menos de 10 casos esos
 * percentiles SON el mínimo y el máximo del grupo, es decir dos observaciones
 * sueltas presentadas como una banda. La probabilidad del escenario sí se
 * publica siempre —es un recuento válido con cualquier n— pero su rango no.
 */
export const MIN_SCENARIO_CASES = 10;

/**
 * Nivel de azar con tres desenlaces mutuamente excluyentes.
 *
 * No es un umbral elegido: con tres clases, acertar por casualidad es 1/3. Una
 * clase cuyo intervalo de confianza no supera ese nivel no ha demostrado nada.
 */
export const CHANCE_LEVEL = 1 / 3;

/* ------------------------------------------------------------------------ *
 * CONTRASTES EXACTOS
 * ------------------------------------------------------------------------ */

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
 * Exacto y no la aproximación normal porque con pocos casos discordantes la
 * normal es sencillamente incorrecta, y "pocos casos discordantes" es el caso
 * NORMAL aquí: dos días de histórico dan decenas de anclas no solapadas, no
 * miles. El exacto además no necesita ningún mínimo artificial.
 */
export function binomialTailProbability(successes: number, trials: number): number {
  if (!Number.isFinite(successes) || !Number.isFinite(trials) || trials <= 0) return 1;
  const k0 = Math.max(0, Math.ceil(successes));
  if (k0 > trials) return 0;

  const logHalfPow = -trials * Math.LN2;
  let total = 0;
  for (let k = k0; k <= trials; k += 1) {
    total += Math.exp(
      logGamma(trials + 1) - logGamma(k + 1) - logGamma(trials - k + 1) + logHalfPow
    );
  }
  return Math.min(1, Math.max(0, total));
}

/**
 * Intervalo de Wilson al 95%.
 *
 * En lugar del intervalo normal, que a proporciones extremas se sale de [0,1]
 * y con n pequeño miente.
 */
export function wilsonInterval(
  successes: number,
  total: number
): { low: number | null; high: number | null } {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || total <= 0) {
    return { low: null, high: null };
  }
  const p = successes / total;
  const z = CONFIDENCE_Z;
  const denom = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * Redondea una frecuencia a la precisión que su muestra sostiene.
 *
 * El error estándar de una proporción es <= 0.5/sqrt(n). Publicar decimales
 * por debajo de ese error es ruido tipográfico: con 40 casos el error ronda
 * los 8 puntos, así que "0.58" ya dice más de lo que se sabe y "0.5823" es
 * directamente falso. Se redondea al 1% cuando n < 400 y al 0.1% por encima,
 * que es donde el error estándar baja de 2.5 puntos.
 */
export function roundProbability(value: number | null, sampleSize: number): number | null {
  const clean = finiteOrNull(value);
  if (clean === null) return null;
  const decimals = sampleSize >= 400 ? 3 : 2;
  return Number(clean.toFixed(decimals));
}

/* ------------------------------------------------------------------------ *
 * DESENLACES Y ESCENARIOS
 * ------------------------------------------------------------------------ */

/**
 * Clasifica un desenlace CONTRA EL RÉGIMEN, no contra cero.
 *
 * `regime` es la deriva mediana de la serie a este horizonte. Un análogo sube
 * sólo si superó esa deriva por más de un movimiento típico; si no, hizo lo
 * que este mercado hace por defecto, que no es una subida: es el fondo.
 *
 * Ésta es la respuesta a la deriva estructural del bolívar. Con "delta > 0"
 * como criterio, un mercado que se deprecia sería ALCISTA todos los días.
 */
export function classifyOutcome(delta: number, regime: number, step: number): Outcome {
  const excess = delta - regime;
  if (excess > step) return 'UP';
  if (excess < -step) return 'DOWN';
  return 'FLAT';
}

export type ScenarioKind = 'BAJISTA' | 'CENTRAL' | 'ALCISTA';

export interface Scenario {
  kind: ScenarioKind;
  /** Desenlace que agrupa este escenario. */
  outcome: Outcome;
  cases: number;
  probability: number;
  probabilityLow: number | null;
  probabilityHigh: number | null;
  /** Rango de precio, null cuando el grupo no tiene casos suficientes. */
  low: number | null;
  high: number | null;
  median: number | null;
  /** false = hay probabilidad pero no rango: el grupo es demasiado pequeño. */
  hasRange: boolean;
}

const SCENARIO_OF: Record<Outcome, ScenarioKind> = {
  DOWN: 'BAJISTA',
  FLAT: 'CENTRAL',
  UP: 'ALCISTA',
};

/**
 * Parte los análogos en tres escenarios y da a cada uno su rango y su
 * probabilidad.
 *
 * Los tres son grupos DISJUNTOS del mismo recuento, así que sus
 * probabilidades suman 1 por construcción, no por normalización.
 */
export function buildScenarios(
  analogues: readonly Analogue[],
  currentPrice: number,
  regime: number,
  step: number
): Scenario[] {
  const total = analogues.length;
  const groups: Record<Outcome, number[]> = { UP: [], FLAT: [], DOWN: [] };
  for (const a of analogues) groups[classifyOutcome(a.delta, regime, step)].push(a.delta);

  const order: Outcome[] = ['DOWN', 'FLAT', 'UP'];
  return order.map((outcome) => {
    const deltas = [...groups[outcome]].sort((a, b) => a - b);
    const cases = deltas.length;
    const wilson = wilsonInterval(cases, total);
    const hasRange = cases >= MIN_SCENARIO_CASES;

    return {
      kind: SCENARIO_OF[outcome],
      outcome,
      cases,
      probability: total > 0 ? (roundProbability(cases / total, total) as number) : 0,
      probabilityLow: roundProbability(wilson.low, total),
      probabilityHigh: roundProbability(wilson.high, total),
      low: hasRange ? currentPrice + (percentileOf(deltas, 0.1) as number) : null,
      high: hasRange ? currentPrice + (percentileOf(deltas, 0.9) as number) : null,
      median: hasRange ? currentPrice + (percentileOf(deltas, 0.5) as number) : null,
      hasRange,
    };
  });
}

/* ------------------------------------------------------------------------ *
 * CALIBRACIÓN
 * ------------------------------------------------------------------------ */

export interface CalibrationBucket {
  from: number;
  to: number;
  predictions: number;
  meanPredicted: number | null;
  observedFrequency: number | null;
  /** Margen binomial al 95% de la frecuencia observada en este bucket. */
  margin: number | null;
  /** true si lo prometido supera a lo observado MÁS ALLÁ de ese margen. */
  overconfident: boolean;
}

export interface CalibrationReport {
  buckets: CalibrationBucket[];
  /** Brier del modelo: media de (probabilidad - resultado)^2. Menor es mejor. */
  brier: number | null;
  /**
   * Brier de la climatología: predecir siempre la frecuencia base observada.
   * Un modelo que no baje de aquí no aporta información sobre el caso concreto.
   */
  brierBaseline: number | null;
  /** Peor exceso de confianza, en puntos de probabilidad. */
  worstOverconfidence: number | null;
  overconfident: boolean;
  predictions: number;
}

/** Buckets de 10 puntos: la rejilla habitual de un diagrama de fiabilidad. */
const BUCKET_EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];

/**
 * ¿Ocurre el 70% de las veces lo que se anunció al 70%?
 *
 * Un modelo puede acertar la dirección a menudo y aun así mentir sobre su
 * propia seguridad. Esto lo detecta sin montar nada académico: se agrupan las
 * predicciones por la probabilidad que prometieron y se compara con la
 * frecuencia observada, exigiendo que la diferencia supere el margen
 * estadístico del bucket antes de llamarla exceso de confianza.
 */
export function calibrate(
  samples: readonly { predicted: number; occurred: boolean }[]
): CalibrationReport {
  const clean = samples.filter(
    (s) => Number.isFinite(s.predicted) && s.predicted >= 0 && s.predicted <= 1
  );

  const empty: CalibrationReport = {
    buckets: [],
    brier: null,
    brierBaseline: null,
    worstOverconfidence: null,
    overconfident: false,
    predictions: clean.length,
  };
  if (clean.length === 0) return empty;

  const baseRate = clean.filter((s) => s.occurred).length / clean.length;
  const brier =
    clean.reduce((acc, s) => acc + (s.predicted - (s.occurred ? 1 : 0)) ** 2, 0) / clean.length;
  const brierBaseline =
    clean.reduce((acc, s) => acc + (baseRate - (s.occurred ? 1 : 0)) ** 2, 0) / clean.length;

  let worst: number | null = null;
  const buckets: CalibrationBucket[] = [];

  for (let i = 0; i < BUCKET_EDGES.length - 1; i += 1) {
    const from = BUCKET_EDGES[i];
    const to = BUCKET_EDGES[i + 1];
    const inBucket = clean.filter((s) => s.predicted >= from && s.predicted < to);
    if (inBucket.length === 0) {
      buckets.push({
        from,
        to: Math.min(to, 1),
        predictions: 0,
        meanPredicted: null,
        observedFrequency: null,
        margin: null,
        overconfident: false,
      });
      continue;
    }

    const n = inBucket.length;
    const meanPredicted = inBucket.reduce((acc, s) => acc + s.predicted, 0) / n;
    const observed = inBucket.filter((s) => s.occurred).length / n;
    const wilson = wilsonInterval(inBucket.filter((s) => s.occurred).length, n);
    const margin =
      wilson.low !== null && wilson.high !== null ? (wilson.high - wilson.low) / 2 : null;

    const excess = meanPredicted - observed;
    const flagged = margin !== null && excess > margin;
    if (flagged && (worst === null || excess > worst)) worst = excess;

    buckets.push({
      from,
      to: Math.min(to, 1),
      predictions: n,
      meanPredicted,
      observedFrequency: observed,
      margin,
      overconfident: flagged,
    });
  }

  return {
    buckets,
    brier: finiteOrNull(brier),
    brierBaseline: finiteOrNull(brierBaseline),
    worstOverconfidence: worst,
    overconfident: worst !== null,
    predictions: clean.length,
  };
}
