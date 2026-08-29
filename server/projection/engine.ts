/**
 * EL MOTOR: DIRECCIÓN, FUERZA, ESCENARIOS Y ESTADO DE EVIDENCIA
 * ============================================================
 *
 * Orquesta las piezas: describe el presente, busca análogos, cuenta desenlaces
 * y publica. No calcula ninguna estadística por su cuenta; su trabajo es
 * decidir QUÉ puede publicarse y con qué etiqueta.
 *
 * LA REGLA QUE GOBIERNA TODO ESTE ARCHIVO
 *
 * Falta de evidencia NUNCA se convierte en una predicción. Cada horizonte sale
 * con un estado explícito, y sólo READY significa "esto puede usarse":
 *
 *   INSUFFICIENT_DATA       no hay serie, cadencia ni longitud para el horizonte
 *   INSUFFICIENT_ANALOGIES  hay serie, pero no bastantes situaciones comparables
 *   LOW_CONFIDENCE          hay análogos y ninguna dirección destaca del azar
 *   NO_EDGE                 el backtest no demuestra ventaja sobre la persistencia
 *   READY                   hay evidencia, hay señal y el backtest la respalda
 *
 * LA REJILLA DE PRECIOS, Y POR QUÉ EL ESCENARIO CENTRAL SALTA
 *
 * Binance publica precios de 0.01 en 0.01, así que los desenlaces observados
 * son múltiplos enteros del tick y el escenario central —una mediana de esos
 * desenlaces— sólo puede caer sobre esa rejilla. Consecuencia medida: cambiar
 * uno o dos análogos de los ochenta puede mover el central un escalón COMPLETO
 * y, con él, la etiqueta de dirección entre LATERAL y ALCISTA.
 *
 * No se interpola para suavizarlo. Un percentil interpolado daría un precio
 * que nunca existió, que es peor que un salto honesto. Lo que sí es estable es
 * la probabilidad, porque es un recuento sobre decenas de casos y no depende
 * de dónde caiga un único valor central.
 */

import { median } from '../marketStatistics.js';
import {
  describeHorizon,
  finiteOrNull,
  lookbackFor,
  medianIntervalMs,
  percentileOf,
  sanitiseSeries,
  typicalStep,
  type SeriesPoint,
} from './series.js';
import {
  MIN_ANALOGUES,
  findAnalogies,
  type Analogue,
} from './historicalAnalogies.js';
import {
  CHANCE_LEVEL,
  VALIDATION_ALPHA,
  buildScenarios,
  classifyOutcome,
  roundProbability,
  wilsonInterval,
  type Outcome,
  type Scenario,
} from './probability.js';
import type { BaselineReport } from './backtest.js';

export type ProjectionStatus =
  | 'READY'
  | 'INSUFFICIENT_DATA'
  | 'INSUFFICIENT_ANALOGIES'
  | 'LOW_CONFIDENCE'
  | 'NO_EDGE';

export type Direction = 'ALCISTA' | 'BAJISTA' | 'LATERAL' | 'INDETERMINADA';

export type Strength = 'MUY_DEBIL' | 'DEBIL' | 'MODERADA' | 'FUERTE' | 'MUY_FUERTE';

/**
 * Horizontes que se INTENTAN. No es una promesa: cada uno se publica sólo si
 * el histórico lo sostiene, y aparece SOLO el día que haya datos, sin tocar
 * código.
 *
 * Lo que cada uno cuesta, a un registro por minuto (41·H observaciones):
 *
 *   +15 min  ~10 h de histórico      +4 h    ~7 días
 *   +30 min  ~21 h                   +12 h   ~21 días
 *   +1 h     ~41 h                   +24 h   ~42 días
 *   +2 h     ~3.5 días
 *
 * Los largos dirán INSUFICIENTE HISTÓRICO durante semanas, y es correcto que
 * lo digan: publicar +24 h con dos días de datos sería inventarse la mitad.
 */
export const DEFAULT_HORIZONS_MS: readonly number[] = [
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];

export const DEFAULT_HISTORY_TAIL = 240;

/**
 * Observaciones mínimas para que un horizonte sea siquiera posible:
 * MIN_ANALOGUES tramos de H pasos sin solaparse, más el tramo del presente,
 * más la ventana de contexto.
 */
export function minimumLengthFor(horizonSteps: number, lookbackSteps: number): number {
  return lookbackSteps + horizonSteps * (MIN_ANALOGUES + 1);
}

export interface AnalogueSample {
  t: number;
  price: number;
  delta: number;
  outcome: Outcome;
  distance: number;
}

export interface ProjectionAudit {
  observations: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  medianIntervalMs: number | null;
  typicalStep: number | null;

  horizonSteps: number;
  measuredHorizonMs: number | null;
  lookbackSteps: number;

  candidatePool: number;
  analoguesUsed: number;
  /** Igual a analoguesUsed: la independencia es estructural, no estimada. */
  independentAnalogues: number;
  maxDistanceUsed: number | null;
  stateScales: Record<string, number>;

  upCount: number;
  flatCount: number;
  downCount: number;

  regimeDelta: number | null;
  directionThreshold: number | null;

  p10: number | null;
  p50: number | null;
  p90: number | null;

  /** Los casos concretos: la respuesta a "¿de dónde salió esta probabilidad?". */
  samples: AnalogueSample[];
}

export interface HorizonProjection {
  requestedHorizonMs: number;
  label: string;
  /** Instante al que apunta la proyección. */
  estimatedAt: number | null;

  status: ProjectionStatus;
  statusText: string;
  /** true sólo cuando hay números publicados (status !== INSUFFICIENT_*). */
  available: boolean;

  currentPrice: number | null;
  central: number | null;
  low: number | null;
  high: number | null;

  probabilityUp: number | null;
  probabilityFlat: number | null;
  probabilityDown: number | null;
  probabilityUpLow: number | null;
  probabilityUpHigh: number | null;

  direction: Direction | null;
  strength: Strength | null;

  scenarios: Scenario[];
  evidence: string | null;
  audit: ProjectionAudit | null;
}

export interface SeriesProjection {
  seriesId: string;
  label: string;
  generatedAt: number;

  observations: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  medianIntervalMs: number | null;
  typicalStep: number | null;
  currentPrice: number | null;

  /** Serie REAL observada, para la parte HISTÓRICO del gráfico. */
  history: SeriesPoint[];

  horizons: HorizonProjection[];
  baselines: BaselineReport[];

  /** true si algún horizonte llegó a READY. */
  usable: boolean;
  notice: string | null;
}

export interface ProjectSeriesOptions {
  seriesId?: string;
  label?: string;
  horizonsMs?: readonly number[];
  historyTail?: number;
  now?: number;
}

export const STATUS_TEXT: Record<ProjectionStatus, string> = {
  READY: 'Proyección respaldada por casos históricos y validada contra la persistencia.',
  INSUFFICIENT_DATA:
    'INSUFICIENTE HISTÓRICO: no hay observaciones suficientes para sostener este horizonte.',
  INSUFFICIENT_ANALOGIES: `INSUFICIENTE HISTÓRICO: hacen falta ${MIN_ANALOGUES} situaciones comparables que no se solapen entre sí, y no las hay.`,
  LOW_CONFIDENCE:
    'BAJA CONFIANZA: los casos comparables no apuntan a ninguna dirección por encima del azar.',
  NO_EDGE:
    'SIN VENTAJA: el modelo no supera al supuesto de que el precio se queda donde está. No usar como recomendación.',
};

/* ------------------------------------------------------------------------ *
 * DIRECCIÓN Y FUERZA
 * ------------------------------------------------------------------------ */

/**
 * ¿Apunta algún desenlace por encima del azar?
 *
 * Con tres clases excluyentes, acertar por casualidad es 1/3. Se exige que el
 * EXTREMO INFERIOR del intervalo de confianza de alguna clase supere ese
 * nivel; si ninguno lo hace, los análogos se contradicen entre sí y decir una
 * dirección sería inventarla.
 */
export function hasSignal(counts: Record<Outcome, number>, total: number): boolean {
  if (total <= 0) return false;
  return (['UP', 'FLAT', 'DOWN'] as Outcome[]).some((outcome) => {
    const { low } = wilsonInterval(counts[outcome], total);
    return low !== null && low > CHANCE_LEVEL;
  });
}

export function gradeDirection(excess: number, step: number, signal: boolean): Direction {
  if (!signal) return 'INDETERMINADA';
  if (step > 0 && Math.abs(excess) <= step) return 'LATERAL';
  if (step <= 0) return excess > 0 ? 'ALCISTA' : excess < 0 ? 'BAJISTA' : 'LATERAL';
  return excess > 0 ? 'ALCISTA' : 'BAJISTA';
}

/**
 * Cinco niveles, y ni uno solo sale de un umbral en VES.
 *
 * La escala es la DISTRIBUCIÓN EMPÍRICA de los movimientos que este mercado ha
 * hecho a este mismo horizonte, medidos también contra el régimen. Los cortes
 * son los quintiles de esa distribución: "MUY FUERTE" significa literalmente
 * "está entre el 20% de movimientos más grandes que este mercado hace a este
 * plazo". Cinco niveles, cinco tramos iguales, ninguna frontera elegida.
 *
 * Un movimiento que no llega al ruido de la serie es MUY DÉBIL aunque su
 * quintil diga otra cosa: por debajo del movimiento típico no hay nada que
 * graduar.
 */
export function gradeStrength(
  excess: number,
  step: number,
  historicalExcesses: readonly number[]
): Strength {
  const size = Math.abs(excess);
  if (step > 0 && size <= step) return 'MUY_DEBIL';
  if (historicalExcesses.length === 0) return 'MUY_DEBIL';

  const sorted = [...historicalExcesses].sort((a, b) => a - b);
  const q = (v: number) => percentileOf(sorted, v) as number;

  if (size < q(0.2)) return 'MUY_DEBIL';
  if (size < q(0.4)) return 'DEBIL';
  if (size < q(0.6)) return 'MODERADA';
  if (size < q(0.8)) return 'FUERTE';
  return 'MUY_FUERTE';
}

/* ------------------------------------------------------------------------ */

function unpublished(
  requested: number,
  status: ProjectionStatus,
  currentPrice: number | null,
  now: number | null
): HorizonProjection {
  // Nunca se devuelve un horizonte no finito: la garantía del motor es que
  // ningún NaN ni Infinity sale de él.
  const requestedHorizonMs = Number.isFinite(requested) && requested > 0 ? requested : 0;

  return {
    requestedHorizonMs,
    label: describeHorizon(requestedHorizonMs),
    estimatedAt: now === null ? null : now + requestedHorizonMs,
    status,
    statusText: STATUS_TEXT[status],
    available: false,
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
    scenarios: [],
    evidence: null,
    audit: null,
  };
}

/**
 * Proyecta un horizonte usando SÓLO `points`.
 *
 * Esta función no sabe nada de "ahora": el presente es siempre el último punto
 * que recibe. Por eso el backtest puede llamarla con un prefijo y obtener
 * exactamente la proyección que el sistema habría publicado en ese momento,
 * sin ninguna ruta por la que se cuele información futura.
 */
export function projectHorizon(
  points: readonly SeriesPoint[],
  requestedHorizonMs: number
): HorizonProjection {
  const currentPrice = points.length > 0 ? points[points.length - 1].price : null;
  const now = points.length > 0 ? points[points.length - 1].t : null;

  // Un horizonte de cero o negativo no es "muy corto": es una pregunta sobre
  // el pasado disfrazada de proyección.
  if (!Number.isFinite(requestedHorizonMs) || requestedHorizonMs <= 0) {
    return unpublished(requestedHorizonMs, 'INSUFFICIENT_DATA', currentPrice, now);
  }
  if (points.length < 2) {
    return unpublished(requestedHorizonMs, 'INSUFFICIENT_DATA', currentPrice, now);
  }

  const cadence = medianIntervalMs(points);
  const step = typicalStep(points);
  if (cadence === null || step === null) {
    return unpublished(requestedHorizonMs, 'INSUFFICIENT_DATA', currentPrice, now);
  }

  const horizonSteps = Math.max(1, Math.round(requestedHorizonMs / cadence));
  const lookbackSteps = lookbackFor(horizonSteps);
  if (points.length < minimumLengthFor(horizonSteps, lookbackSteps)) {
    return unpublished(requestedHorizonMs, 'INSUFFICIENT_DATA', currentPrice, now);
  }

  const search = findAnalogies(points, horizonSteps, step, cadence);
  if (search.current === null) {
    return unpublished(requestedHorizonMs, 'INSUFFICIENT_DATA', currentPrice, now);
  }
  if (search.analogues.length < MIN_ANALOGUES) {
    return unpublished(requestedHorizonMs, 'INSUFFICIENT_ANALOGIES', currentPrice, now);
  }

  // El régimen se mide sobre TODO el histórico disponible del horizonte, no
  // sobre los análogos: es el fondo contra el que los análogos se juzgan.
  const poolDeltas = search.pool.map((c) => c.delta as number);
  const regimeDelta = median(poolDeltas);
  const regime = regimeDelta ?? 0;

  const analogues: readonly Analogue[] = search.analogues;
  const deltas = analogues.map((a) => a.delta);
  const sorted = [...deltas].sort((a, b) => a - b);
  const p10 = percentileOf(sorted, 0.1);
  const p50 = percentileOf(sorted, 0.5);
  const p90 = percentileOf(sorted, 0.9);

  const counts: Record<Outcome, number> = { UP: 0, FLAT: 0, DOWN: 0 };
  const samples: AnalogueSample[] = analogues.map((a) => {
    const outcome = classifyOutcome(a.delta, regime, step);
    counts[outcome] += 1;
    return { t: a.t, price: a.price, delta: a.delta, outcome, distance: a.distance };
  });

  const total = samples.length;
  const price = currentPrice as number;
  const excess = (p50 ?? 0) - regime;
  const signal = hasSignal(counts, total);

  const direction = gradeDirection(excess, step, signal);
  const strength = gradeStrength(
    excess,
    step,
    poolDeltas.map((d) => Math.abs(d - regime))
  );

  const wilsonUp = wilsonInterval(counts.UP, total);
  const status: ProjectionStatus = signal ? 'READY' : 'LOW_CONFIDENCE';

  return {
    requestedHorizonMs,
    label: describeHorizon(requestedHorizonMs),
    estimatedAt: (now as number) + requestedHorizonMs,
    status,
    statusText: STATUS_TEXT[status],
    available: true,
    currentPrice: finiteOrNull(price),
    central: finiteOrNull(p50 === null ? null : price + p50),
    low: finiteOrNull(p10 === null ? null : price + p10),
    high: finiteOrNull(p90 === null ? null : price + p90),
    probabilityUp: roundProbability(counts.UP / total, total),
    probabilityFlat: roundProbability(counts.FLAT / total, total),
    probabilityDown: roundProbability(counts.DOWN / total, total),
    probabilityUpLow: roundProbability(wilsonUp.low, total),
    probabilityUpHigh: roundProbability(wilsonUp.high, total),
    direction,
    strength,
    scenarios: buildScenarios(analogues, price, regime, step),
    evidence:
      `En situaciones históricas similares, ${counts.UP} de ${total} casos terminaron ` +
      `por encima del precio actual a ${describeHorizon(requestedHorizonMs)}.`,
    audit: {
      observations: points.length,
      firstTimestamp: points[0].t,
      lastTimestamp: points[points.length - 1].t,
      medianIntervalMs: cadence,
      typicalStep: step,
      horizonSteps,
      measuredHorizonMs: horizonSteps * cadence,
      lookbackSteps,
      candidatePool: search.pool.length,
      analoguesUsed: total,
      independentAnalogues: total,
      maxDistanceUsed: search.maxDistance,
      stateScales: search.scales,
      upCount: counts.UP,
      flatCount: counts.FLAT,
      downCount: counts.DOWN,
      regimeDelta: finiteOrNull(regimeDelta),
      directionThreshold: finiteOrNull(step),
      p10,
      p50,
      p90,
      samples,
    },
  };
}

/* ------------------------------------------------------------------------ *
 * PROYECCIÓN COMPLETA DE UNA SERIE
 * ------------------------------------------------------------------------ */

/**
 * Arma la proyección con unas baselines YA CALCULADAS.
 *
 * El backtest no se ejecuta aquí a propósito: es la parte cara y quien llama
 * decide si la corre de un tirón (tests) o cediendo el hilo entre bloques
 * (la ruta HTTP, para no bloquear la captura). Así `engine` tampoco depende de
 * `backtest`, y `backtest` puede depender de `engine` sin ciclo.
 */
export function projectSeries(
  rawPoints: readonly SeriesPoint[],
  options: ProjectSeriesOptions = {},
  baselines: readonly BaselineReport[] = []
): SeriesProjection {
  const series = sanitiseSeries(rawPoints);
  const horizonsMs = options.horizonsMs ?? DEFAULT_HORIZONS_MS;
  const tail = options.historyTail ?? DEFAULT_HISTORY_TAIL;
  const generatedAt = options.now ?? Date.now();

  const draft: SeriesProjection = {
    seriesId: options.seriesId ?? 'SERIE',
    label: options.label ?? 'Serie histórica',
    generatedAt,
    observations: series.length,
    firstTimestamp: series.length > 0 ? series[0].t : null,
    lastTimestamp: series.length > 0 ? series[series.length - 1].t : null,
    medianIntervalMs: medianIntervalMs(series),
    typicalStep: typicalStep(series),
    currentPrice: finiteOrNull(series.length > 0 ? series[series.length - 1].price : null),
    history: tail > 0 ? series.slice(-tail) : [],
    horizons: horizonsMs.map((ms) => projectHorizon(series, ms)),
    baselines: [...baselines],
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
 * Sin esta corrección, con alpha 0.05 y diez contrastes simultáneos —dos lados
 * por cinco horizontes— la probabilidad de que ALGUNO salga "validado" sobre
 * ruido puro es del 40%. Está medido: sobre un paseo aleatorio sintético de
 * 3.073 puntos, +30 min salía validado en los dos lados.
 *
 * La familia son los contrastes REALMENTE EJECUTADOS: un horizonte que se
 * quedó sin anclas no contrastó nada, y contarlo endurecería el umbral con
 * pruebas que nunca se hicieron.
 *
 * Función pura: devuelve copias. Volver a llamarla con otra familia recalcula
 * la decisión sin repetir el backtest, que es la parte cara.
 */
export function decideValidation(
  projections: readonly SeriesProjection[]
): SeriesProjection[] {
  const familySize = projections.reduce(
    (count, p) => count + p.baselines.filter((b) => b.pValue !== null).length,
    0
  );
  const alpha = familySize > 0 ? VALIDATION_ALPHA / familySize : null;

  return projections.map((projection) => {
    const baselines = projection.baselines.map((baseline) => {
      if (baseline.pValue === null || alpha === null) {
        return {
          ...baseline,
          alpha: null,
          familySize: null,
          beatsPersistence: baseline.reason === null ? false : null,
        };
      }
      return {
        ...baseline,
        alpha,
        familySize,
        beatsPersistence: baseline.pValue <= alpha,
      };
    });

    const horizons = projection.horizons.map((horizon) => {
      // Sin números publicados no hay nada que degradar.
      if (!horizon.available) return horizon;

      const baseline = baselines.find(
        (b) => b.requestedHorizonMs === horizon.requestedHorizonMs
      );

      /*
       * NO_EDGE pesa más que LOW_CONFIDENCE. Que los análogos no señalen una
       * dirección es una pega sobre esta lectura concreta; que el backtest no
       * encuentre ventaja es una pega sobre el modelo entero a ese horizonte,
       * y es lo primero que hay que decirle a quien mira.
       */
      if (baseline?.beatsPersistence !== true) {
        return { ...horizon, status: 'NO_EDGE' as const, statusText: STATUS_TEXT.NO_EDGE };
      }
      return horizon;
    });

    const ready = horizons.filter((h) => h.status === 'READY');
    const published = horizons.filter((h) => h.available);

    let notice: string | null = null;
    if (published.length === 0) {
      notice =
        'INSUFICIENTE HISTÓRICO: ningún horizonte tiene todavía suficientes situaciones ' +
        'comparables. No se publica ninguna proyección.';
    } else if (ready.length === 0) {
      notice =
        'PROYECCIÓN NO VALIDADA: ningún horizonte supera todavía, de forma estadísticamente ' +
        'significativa, al supuesto de que el precio se queda donde está. Los números se ' +
        'muestran como referencia, no como recomendación.';
    }

    return { ...projection, horizons, baselines, usable: ready.length > 0, notice };
  });
}
