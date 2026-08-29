/**
 * BACKTEST: ¿ESTO SIRVE PARA ALGO?
 * ================================
 *
 * Simula estar en el pasado. En cada ancla se llama al motor con el PREFIJO de
 * la serie hasta ese instante, se avanza hasta el horizonte y se compara la
 * predicción con lo que realmente pasó.
 *
 * SIN FUGA DE FUTURO. El motor recibe `points.slice(0, anchor + 1)` y trata su
 * último punto como el presente. No hay ninguna otra vía de entrada: ni el
 * régimen, ni el paso típico, ni las escalas de estado se calculan sobre la
 * serie completa. El resultado real también se clasifica con el régimen y el
 * paso MEDIDOS SOBRE EL PREFIJO — juzgar el pasado con el régimen final sería
 * usar información que en ese momento no existía.
 *
 * ANCLAS NO SOLAPADAS. Se avanza de H en H pasos como mínimo, así que cada
 * ancla es una prueba independiente y el contraste no cuenta dos veces la
 * misma evidencia.
 *
 * POR QUÉ LA PRECISIÓN DIRECCIONAL NO DECIDE
 *
 * Fue el primer criterio y estaba roto. Bajo una banda de ±1 paso típico, "no
 * se mueve" es un desenlace POCO FRECUENTE; en una serie que se mueve el 85%
 * de las veces, cualquier predictor que se atreva a decir SUBE o BAJA supera a
 * "siempre LATERAL" por la frecuencia de las clases, sin una sola pizca de
 * habilidad. Medido sobre 40 paseos aleatorios sintéticos, la precisión
 * direccional ganaba en 36 de 40 series SIN NINGUNA ESTRUCTURA.
 *
 * El criterio es el ERROR DE PRECIO contra la persistencia, que no se puede
 * ganar así: hay que acercarse al precio real más que quedándose quieto. Sobre
 * esas mismas 40 semillas, cero validaciones.
 */

import { median } from '../marketStatistics.js';
import {
  describeHorizon,
  finiteOrNull,
  lookbackFor,
  medianIntervalMs,
  typicalStep,
  type SeriesPoint,
} from './series.js';
import {
  binomialTailProbability,
  calibrate,
  classifyOutcome,
  type CalibrationReport,
  type Outcome,
} from './probability.js';
import { minimumLengthFor, projectHorizon } from './engine.js';

/**
 * Anclas mínimas para que el backtest signifique algo.
 *
 * Las anclas no se solapan, así que 20 anclas son 20 pruebas independientes.
 * Por debajo, la comparación contra la persistencia no distingue habilidad de
 * suerte.
 */
export const MIN_BACKTEST_ANCHORS = 20;

/**
 * Tope de anclas evaluadas por horizonte.
 *
 * Cada ancla vuelve a proyectar sobre su prefijo entero, y no se puede
 * reutilizar nada entre anclas: el paso típico y la cadencia se miden sobre
 * cada prefijo, así que TODOS los estados cambian de una a otra. Esa es
 * precisamente la razón de que no haya fuga de futuro, y también de que el
 * coste sea cuadrático en la longitud de la serie.
 *
 * 60 es donde el contraste ya tiene lo que necesita. Con el umbral corregido
 * por comparaciones múltiples rondando 0.005, el test de signos exacto exige
 * estas mayorías: 29 de 40 (73%), 41 de 60 (68%), 52 de 80 (65%). De 40 a 60
 * el listón baja cinco puntos; de 60 a 80, sólo tres, y cuesta un tercio más
 * de tiempo. Ahí es donde deja de compensar: más anclas dan resolución que
 * nadie lee y cuestan tiempo que la captura de Binance necesita.
 *
 * Cuando hay más anclas disponibles se AMPLÍA EL PASO en múltiplos del
 * horizonte, nunca se recorta el tramo evaluado: se sigue cubriendo todo el
 * histórico, sólo que con menos densidad. El paso resultante nunca baja del
 * horizonte, así que las anclas siguen sin solaparse.
 */
export const MAX_BACKTEST_ANCHORS = 60;

/*
 * La variante asíncrona cede el hilo UNA VEZ POR ANCLA.
 *
 * La captura de Binance es prioritaria y no puede degradarse. Un backtest
 * completo tarda segundos, y en Node eso son segundos en los que el poll no
 * corre. Cediendo en cada ancla, el bloque más largo es el de una sola
 * proyección —decenas de milisegundos— y el trabajo total es idéntico.
 *
 * Se midió con 5 anclas por cesión y el bloqueo llegaba a 907 ms, porque una
 * sola ancla sobre 3.000 puntos ya cuesta decenas de ms y los horizontes que
 * se quedan cortos gastan varias antes de rendirse. Una por ancla es la única
 * cadencia que acota el bloqueo por construcción.
 */

/** Cobertura que la banda p10–p90 promete por construcción. */
export const COVERAGE_TARGET = 0.8;

export interface BaselineReport {
  requestedHorizonMs: number;
  label: string;
  /** Anclas no solapadas realmente evaluadas. */
  anchors: number;
  skipped: number;
  /** Paso entre anclas, en observaciones. Nunca menor que el horizonte. */
  anchorStride: number;

  /*
   * DIAGNÓSTICO, NO CRITERIO. Ver la cabecera: bajo una banda de ±1 paso
   * típico estas dos cifras se ganan por frecuencia de clases, no por
   * habilidad. Se publican porque son legibles, no porque decidan.
   */
  directionalAccuracy: number | null;
  persistenceDirectionalAccuracy: number | null;

  /** Anclas cuyo precio real cayó dentro de la banda publicada. */
  bandCoverage: number | null;
  coverageTarget: number;
  /** Anchura mediana de la banda, en VES: una banda ancha "cubre" sin decir nada. */
  medianBandWidth: number | null;

  /* EL CRITERIO: error absoluto de precio contra el de la persistencia. */
  modelMedianAbsError: number | null;
  persistenceMedianAbsError: number | null;
  modelBetterCount: number;
  persistenceBetterCount: number;
  tiedCount: number;

  /** Test de signos exacto sobre los pares no empatados. */
  pValue: number | null;
  alpha: number | null;
  familySize: number | null;
  beatsPersistence: boolean | null;

  calibration: CalibrationReport;
  reason: 'INSUFFICIENT_ANCHORS' | null;
}

interface AnchorResult {
  directionCorrect: boolean;
  persistenceDirectionCorrect: boolean;
  insideBand: boolean;
  bandWidth: number;
  modelAbsError: number;
  persistenceAbsError: number;
  /** Probabilidad que el modelo anunció para la clase que predijo. */
  predicted: number;
  occurred: boolean;
}

/**
 * El backtest como GENERADOR.
 *
 * El cuerpo existe una sola vez; lo conducen dos funciones, una síncrona y una
 * que cede el hilo. Duplicar la lógica para tener una versión asíncrona sería
 * la forma más fácil de que las dos se separaran sin que nadie lo notara — hay
 * un test que comprueba que producen exactamente el mismo informe.
 */
function* runBacktest(
  points: readonly SeriesPoint[],
  requestedHorizonMs: number
): Generator<void, BaselineReport, void> {
  // Nada no finito sale de aquí, ni siquiera el eco del horizonte pedido.
  const echoHorizonMs =
    Number.isFinite(requestedHorizonMs) && requestedHorizonMs > 0 ? requestedHorizonMs : 0;

  const empty: BaselineReport = {
    requestedHorizonMs: echoHorizonMs,
    label: describeHorizon(echoHorizonMs),
    anchors: 0,
    skipped: 0,
    anchorStride: 0,
    directionalAccuracy: null,
    persistenceDirectionalAccuracy: null,
    bandCoverage: null,
    coverageTarget: COVERAGE_TARGET,
    medianBandWidth: null,
    modelMedianAbsError: null,
    persistenceMedianAbsError: null,
    modelBetterCount: 0,
    persistenceBetterCount: 0,
    tiedCount: 0,
    pValue: null,
    alpha: null,
    familySize: null,
    beatsPersistence: null,
    calibration: calibrate([]),
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

  // Paso entre anclas: el horizonte, ampliado si eso diera más anclas de las
  // que hacen falta. Sigue siendo >= horizonte, así que la independencia se
  // conserva.
  const available = Math.floor((points.length - horizonSteps - firstAnchor) / horizonSteps);
  const strideMultiple = Math.max(1, Math.ceil(available / MAX_BACKTEST_ANCHORS));
  const stride = horizonSteps * strideMultiple;

  /*
   * Si ni siquiera en el mejor caso hay anclas suficientes, no se empieza.
   *
   * Sin esta comprobación, un horizonte que se queda a mitad recorre ocho o
   * diez anclas carísimas para acabar devolviendo INSUFFICIENT_ANCHORS. Medido:
   * 600 ms tirados por lado en el horizonte de +1 h. El recuento de después no
   * sobra —las anclas que el motor descarta pueden dejarlo por debajo del
   * suelo— pero esto evita el trabajo que ya se sabe inútil.
   */
  const plannedAnchors = Math.floor((points.length - 1 - horizonSteps - firstAnchor) / stride) + 1;
  if (plannedAnchors < MIN_BACKTEST_ANCHORS) {
    return { ...empty, anchors: 0, skipped: 0, anchorStride: stride };
  }

  const results: AnchorResult[] = [];
  let skipped = 0;

  for (let anchor = firstAnchor; anchor + horizonSteps < points.length; anchor += stride) {
    // Una cesión por ancla: acota el bloqueo del hilo por construcción.
    yield;

    const prefix = points.slice(0, anchor + 1);
    const projection = projectHorizon(prefix, requestedHorizonMs);
    if (!projection.available || projection.audit === null || projection.central === null) {
      skipped += 1;
      continue;
    }

    const anchorPrice = points[anchor].price;
    const actualPrice = points[anchor + horizonSteps].price;
    const actualDelta = actualPrice - anchorPrice;

    const prefixRegime = projection.audit.regimeDelta ?? 0;
    const prefixStep = projection.audit.typicalStep ?? 0;
    const actualOutcome = classifyOutcome(actualDelta, prefixRegime, prefixStep);

    const predictedOutcome: Outcome =
      projection.direction === 'ALCISTA'
        ? 'UP'
        : projection.direction === 'BAJISTA'
          ? 'DOWN'
          : 'FLAT';

    // La probabilidad que el modelo anunció PARA LO QUE PREDIJO. Es la cifra
    // cuya honestidad mide la calibración.
    const announced =
      predictedOutcome === 'UP'
        ? projection.probabilityUp
        : predictedOutcome === 'DOWN'
          ? projection.probabilityDown
          : projection.probabilityFlat;

    results.push({
      directionCorrect: predictedOutcome === actualOutcome,
      // La persistencia no se aparta del régimen: su predicción es LATERAL.
      persistenceDirectionCorrect: actualOutcome === 'FLAT',
      insideBand:
        projection.low !== null &&
        projection.high !== null &&
        actualPrice >= projection.low &&
        actualPrice <= projection.high,
      bandWidth:
        projection.low !== null && projection.high !== null
          ? projection.high - projection.low
          : 0,
      modelAbsError: Math.abs(actualPrice - projection.central),
      // La persistencia predice literalmente el precio de ahora.
      persistenceAbsError: Math.abs(actualPrice - anchorPrice),
      predicted: announced ?? 0,
      occurred: predictedOutcome === actualOutcome,
    });
  }

  if (results.length < MIN_BACKTEST_ANCHORS) {
    return { ...empty, anchors: results.length, skipped, anchorStride: stride };
  }

  const n = results.length;
  const directionCorrect = results.filter((r) => r.directionCorrect).length;
  const persistenceDirection = results.filter((r) => r.persistenceDirectionCorrect).length;
  const inside = results.filter((r) => r.insideBand).length;

  /*
   * TEST DE SIGNOS EXACTO SOBRE EL ERROR DE PRECIO.
   *
   * Se cuenta en cuántas anclas el modelo se acercó más que la persistencia.
   * Si los dos fueran igual de buenos, ese recuento sería una binomial de
   * p=0.5, y su cola se calcula exacta. Los empates no distinguen a nadie y se
   * excluyen, que es lo que hace un test de signos.
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

  // La decisión se deja SIN TOMAR: depende de cuántos contrastes se ejecuten a
  // la vez, y este horizonte no lo sabe. `decideValidation` la toma.
  return {
    requestedHorizonMs: echoHorizonMs,
    label: describeHorizon(echoHorizonMs),
    anchors: n,
    skipped,
    anchorStride: stride,
    directionalAccuracy: directionCorrect / n,
    persistenceDirectionalAccuracy: persistenceDirection / n,
    bandCoverage: inside / n,
    coverageTarget: COVERAGE_TARGET,
    medianBandWidth: median(results.map((r) => r.bandWidth)),
    modelMedianAbsError: median(results.map((r) => r.modelAbsError)),
    persistenceMedianAbsError: median(results.map((r) => r.persistenceAbsError)),
    modelBetterCount,
    persistenceBetterCount,
    tiedCount,
    pValue: decisive > 0 ? binomialTailProbability(modelBetterCount, decisive) : null,
    alpha: null,
    familySize: null,
    beatsPersistence: null,
    calibration: calibrate(
      results.map((r) => ({ predicted: r.predicted, occurred: r.occurred }))
    ),
    reason: null,
  };
}

/** Conduce el generador de un tirón. Lo que usan los tests. */
export function backtestHorizon(
  points: readonly SeriesPoint[],
  requestedHorizonMs: number
): BaselineReport {
  const it = runBacktest(points, requestedHorizonMs);
  let step = it.next();
  while (!step.done) step = it.next();
  return step.value;
}

/**
 * Conduce el mismo generador cediendo el hilo en cada pausa.
 *
 * Ésta es la que usa la ruta HTTP: el trabajo total es idéntico, pero se parte
 * en bloques cortos para que el bucle de captura siga corriendo entre ellos.
 */
export async function backtestHorizonAsync(
  points: readonly SeriesPoint[],
  requestedHorizonMs: number
): Promise<BaselineReport> {
  const it = runBacktest(points, requestedHorizonMs);
  let step = it.next();
  while (!step.done) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    step = it.next();
  }
  return step.value;
}
