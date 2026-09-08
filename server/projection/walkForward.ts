/**
 * WALK-FORWARD: LA ÚNICA EVIDENCIA QUE CUENTA
 * =============================================
 *
 * Recorre el histórico hacia adelante. En cada instante evaluable pregunta a
 * cada modelo qué habría dicho con lo que se sabía ENTONCES, y después mira
 * qué pasó. El modelo nunca recibe un índice mayor que el suyo — no es una
 * promesa, es la firma de `ForecastContext`, que sólo lleva `i`.
 *
 * ═══ TRAIN / VALIDATION / TEST ═══
 *
 * El histórico se parte por TIEMPO, nunca al azar:
 *
 *   [········ TRAIN ········][··· VALIDATION ···][··· TEST ···]
 *
 * · TRAIN      no se puntúa: es el pasado del que los modelos aprenden
 *              (analogías, medianas) en cada llamada.
 * · VALIDATION elige el modelo y el umbral. Es donde se permite mirar.
 * · TEST       sólo se lee UNA vez, al final, para reportar. Nada elegido
 *              sobre el test.
 *
 * Sin esta separación, "el mejor modelo" sería el que mejor memoriza el
 * histórico concreto que tenemos, que es exactamente el sobreajuste que hay
 * que evitar.
 *
 * ═══ QUÉ SE MIDE, Y POR QUÉ NO SÓLO EL ERROR ═══
 *
 * El MAE dice cuánto se equivoca el precio proyectado. No dice si sirve para
 * decidir. Un modelo puede tener MAE bajo prediciendo siempre "igual que
 * ahora" y ser inútil: nunca se moja. Por eso se mide además:
 *
 *   · aciertos de DIRECCIÓN, sobre los casos en que el mercado se movió;
 *   · lo mismo RESTRINGIDO a las señales que superan el umbral señal/ruido,
 *     que es la métrica que decide de verdad — precisión cuando se moja;
 *   · cuántas veces se abstiene, que es información y no un fallo.
 */

import { binomialTailProbability } from './probability.js';
import { cellAt, type HourlyGrid } from './hourlyGrid.js';
import { computeFeatureSeries, type FeatureSeries } from './marketFeatures.js';
import { buildModels, MODEL_IDS, type ForecastFn, type ModelId } from './forecastModels.js';

/** Horizontes evaluados, en horas. Los que el operador pidió. */
export const HORIZONS = [1, 2, 4, 6, 12, 24] as const;
export type Horizon = (typeof HORIZONS)[number];

/**
 * Un movimiento por debajo de esto se considera plano y no cuenta como
 * dirección acertada ni fallada: acertar el signo de un movimiento de 0.001%
 * no es acertar nada. Se expresa en múltiplos de la volatilidad medida, no
 * como una constante en VES.
 */
export const FLAT_VOLATILITY_FRACTION = 0.25;

export interface HorizonMetrics {
  model: ModelId;
  horizon: Horizon;
  /** Casos evaluados. */
  n: number;
  /** Error absoluto medio, en VES. */
  mae: number | null;
  /** Error absoluto medio en % del precio ancla. */
  mape: number | null;
  /** Aciertos de dirección / casos con movimiento real. */
  directionHits: number;
  directionTotal: number;
  directionAccuracy: number | null;
  /** p de que la precisión direccional salga de una moneda justa. */
  directionPValue: number | null;

  /** ── Métricas de DECISIÓN: sólo los casos en que el modelo se mojó ── */
  /** Señales emitidas (|movimiento esperado| > umbral·error). */
  signals: number;
  signalHits: number;
  /** Precisión cuando se moja. Es la métrica que importa para decidir. */
  signalAccuracy: number | null;
  /** Fracción de instantes en los que NO se emitió señal. */
  abstentionRate: number | null;
}

export interface WalkForwardSplit {
  trainEnd: number;
  validationEnd: number;
  testEnd: number;
  trainHours: number;
  validationHours: number;
  testHours: number;
}

export interface WalkForwardReport {
  split: WalkForwardSplit;
  validation: HorizonMetrics[];
  test: HorizonMetrics[];
  /**
   * Modelo utilizable por horizonte: elegido en validación Y confirmado en
   * test. `null` significa SIN MODELO, y el motor dirá NO DECIDIR.
   */
  chosen: Record<number, ModelId | null>;
  /** Error típico del modelo elegido por horizonte, en % (medido en validación). */
  chosenErrorPct: Record<number, number | null>;
  /**
   * Modelo que ganó la validación, ANTES de la puerta de confirmación. Se
   * conserva para poder decir por qué un horizonte se quedó sin modelo:
   * `candidate` con `chosen === null` = el candidato no confirmó en test.
   */
  candidate: Record<number, ModelId | null>;
  /** Por qué el horizonte quedó como quedó, en palabras. */
  horizonVerdict: Record<number, string>;
  evaluable: boolean;
  reason: string;
}

/**
 * Mínimo de casos para puntuar un (modelo, horizonte).
 *
 * Por debajo, una precisión direccional es una anécdota: con 10 casos, 7
 * aciertos (70%) sale de una moneda justa el 17% de las veces.
 */
export const MIN_CASES_PER_HORIZON = 30;

/** Horas mínimas de histórico para que el walk-forward tenga sentido. */
export const MIN_HISTORY_HOURS = 96;

function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Umbral señal/ruido: cuántas veces el error típico debe caber en el
 * movimiento esperado para que la señal se considere accionable.
 *
 * 1.0 significa "el movimiento esperado al menos iguala al error típico". Es
 * el mínimo defendible: por debajo, el propio error del modelo se come la
 * predicción. No es un parámetro ajustado a los datos - es la definición de
 * que una señal supere a su propio ruido.
 */
export const SIGNAL_TO_NOISE_FLOOR = 1.0;

/**
 * Señales mínimas en validación para que un modelo pueda ser elegido.
 *
 * Con menos de 20, el contraste binomial no puede distinguir una precisión
 * alta de la suerte: 8 de 10 aciertos sale de una moneda justa el 5.5% de las
 * veces, y con 20 casos hacen falta 15 aciertos para bajar de 0.05.
 */
export const MIN_SIGNALS_TO_QUALIFY = 20;

/**
 * Nivel del contraste "esta señal bate al azar", ANTES de corregir.
 *
 * Es el mismo 0.05 que el resto del proyecto usa para decidir si algo se
 * publica como evidencia. Un modelo que no lo pasa NO se usa: el horizonte se
 * queda sin modelo y la decisión será NO DECIDIR.
 */
export const SELECTION_ALPHA = 0.05;

/**
 * Corrección por comparaciones múltiples (Bonferroni).
 *
 * ═══ POR QUÉ HIZO FALTA ═══
 *
 * En cada horizonte compiten siete modelos, y hay seis horizontes: cuarenta y
 * dos contrastes. A 0.05 por contraste, dos "ganadores" por puro azar son lo
 * ESPERADO, no la excepción. Se detectó con un test: sobre un paseo aleatorio
 * de 600 horas —sin nada que predecir por construcción— algún horizonte
 * seguía encontrando modelo elegible.
 *
 * Publicar eso sería exactamente el fallo que este motor existe para evitar:
 * una señal con aspecto validado sobre un mercado que no tiene señal. Se
 * reparte el alfa entre los modelos que compiten en el horizonte, que es la
 * corrección más conservadora y la que no necesita suponer independencia
 * entre modelos (no la hay: comparten datos).
 */
export const SELECTION_ALPHA_CORRECTED = SELECTION_ALPHA / MODEL_IDS.length;

/**
 * Nivel del contraste de CONFIRMACIÓN sobre el test.
 *
 * ═══ POR QUÉ HACE FALTA UNA SEGUNDA PUERTA ═══
 *
 * La corrección de Bonferroni reduce los falsos positivos de la BÚSQUEDA,
 * pero no los elimina, y sobre todo no comprueba que el ganador siga siendo
 * bueno fuera de donde se le eligió. Medido sobre 18 paseos aleatorios de 600
 * horas —series sin nada que predecir por construcción— la selección por
 * validación seguía nombrando modelo en 5 de 18, y el modelo nombrado acertaba
 * el 34%, el 31% y el 27% de sus señales en el test: PEOR que una moneda. Una
 * señal así no es ruido inofensivo, es una señal invertida que haría perder
 * dinero al maker.
 *
 * Por eso el test no sólo se reporta: VETA. Con el modelo y el umbral ya
 * congelados en validación, el ganador tiene que volver a batir al azar en un
 * tramo que no participó en su elección. Aquí NO se corrige por comparaciones
 * múltiples porque no se compara nada: se contrasta un único modelo ya
 * elegido. El test se sigue leyendo una sola vez y no elige entre modelos —
 * sólo responde sí o no.
 *
 * Coste: la precisión reportada de un modelo que pasa las dos puertas es
 * optimista (está condicionada a haberlas pasado). Beneficio: la probabilidad
 * de publicar una señal sobre un mercado impredecible cae de ~0.05 a ~0.0036
 * por modelo y horizonte.
 */
export const CONFIRMATION_ALPHA = 0.05;

interface Case {
  i: number;
  anchor: number;
  actual: number;
  predicted: number;
  volatility: number | null;
}

/** Evalúa un modelo en un horizonte sobre un rango [from, to) de índices. */
function evaluate(
  grid: HourlyGrid,
  model: ForecastFn,
  horizon: Horizon,
  from: number,
  to: number,
  errorPctForSignal: number | null,
  features: FeatureSeries
): Omit<HorizonMetrics, 'model' | 'horizon'> {
  const cases: Case[] = [];

  for (let i = from; i < to; i += 1) {
    const here = cellAt(grid, i);
    if (here === null) continue;
    const future = cellAt(grid, i + horizon);
    if (future === null) continue;
    const predicted = model({ grid, i, horizon, features });
    if (predicted === null || !Number.isFinite(predicted) || predicted <= 0) continue;
    const f = features[i] ?? null;
    cases.push({
      i,
      anchor: here.level,
      actual: future.level,
      predicted,
      volatility: f?.volatilityPct ?? null,
    });
  }

  const absErrors = cases.map((c) => Math.abs(c.predicted - c.actual));
  const pctErrors = cases.map((c) => (Math.abs(c.predicted - c.actual) / c.anchor) * 100);

  let directionHits = 0;
  let directionTotal = 0;
  let signals = 0;
  let signalHits = 0;

  for (const c of cases) {
    const realMovePct = ((c.actual - c.anchor) / c.anchor) * 100;
    const expectedMovePct = ((c.predicted - c.anchor) / c.anchor) * 100;

    // Movimiento real demasiado pequeño para tener signo interpretable.
    const flatBand = c.volatility !== null ? c.volatility * FLAT_VOLATILITY_FRACTION : 0;
    const realIsFlat = Math.abs(realMovePct) <= flatBand;

    if (!realIsFlat && realMovePct !== 0 && expectedMovePct !== 0) {
      directionTotal += 1;
      if (Math.sign(realMovePct) === Math.sign(expectedMovePct)) directionHits += 1;
    }

    // ¿El modelo se moja? Sólo si su movimiento esperado supera su propio error.
    if (errorPctForSignal !== null && errorPctForSignal > 0) {
      const snr = Math.abs(expectedMovePct) / errorPctForSignal;
      if (snr >= SIGNAL_TO_NOISE_FLOOR && !realIsFlat && realMovePct !== 0) {
        signals += 1;
        if (Math.sign(realMovePct) === Math.sign(expectedMovePct)) signalHits += 1;
      }
    }
  }

  return {
    n: cases.length,
    mae: mean(absErrors),
    mape: mean(pctErrors),
    directionHits,
    directionTotal,
    directionAccuracy: directionTotal === 0 ? null : directionHits / directionTotal,
    directionPValue:
      directionTotal === 0 ? null : binomialTailProbability(directionHits, directionTotal),
    signals,
    signalHits,
    signalAccuracy: signals === 0 ? null : signalHits / signals,
    abstentionRate: cases.length === 0 ? null : 1 - signals / cases.length,
  };
}

/**
 * Corre la comparación completa y elige modelo por horizonte.
 *
 * La elección se hace SÓLO con validación, y con el criterio del operador:
 * primero precisión de la señal (¿acierta cuando se moja?), y el MAPE sólo
 * desempata. Un modelo con MAPE mejor que nunca emite señal no gana: no
 * sirve para decidir, que es para lo que se está eligiendo.
 */
export function runWalkForward(
  grid: HourlyGrid,
  trendWindow?: number,
  neighbours?: number
): WalkForwardReport {
  const models = buildModels(trendWindow, neighbours);
  const features = computeFeatureSeries(grid);
  const total = grid.cells.length;

  const emptySplit: WalkForwardSplit = {
    trainEnd: 0,
    validationEnd: 0,
    testEnd: 0,
    trainHours: 0,
    validationHours: 0,
    testHours: 0,
  };

  if (grid.observedHours < MIN_HISTORY_HOURS) {
    return {
      split: emptySplit,
      validation: [],
      test: [],
      chosen: {},
      chosenErrorPct: {},
      candidate: {},
      horizonVerdict: {},
      evaluable: false,
      reason:
        `Histórico insuficiente para validar: ${grid.observedHours} horas observadas, ` +
        `hacen falta ${MIN_HISTORY_HOURS}.`,
    };
  }

  // 50 / 25 / 25 por tiempo. El train es el más largo porque de él salen las
  // analogías y las medianas que los modelos consultan en cada llamada.
  const trainEnd = Math.floor(total * 0.5);
  const validationEnd = Math.floor(total * 0.75);
  const testEnd = total;

  const split: WalkForwardSplit = {
    trainEnd,
    validationEnd,
    testEnd,
    trainHours: trainEnd,
    validationHours: validationEnd - trainEnd,
    testHours: testEnd - validationEnd,
  };

  const validation: HorizonMetrics[] = [];
  const test: HorizonMetrics[] = [];
  const chosen: Record<number, ModelId | null> = {};
  const chosenErrorPct: Record<number, number | null> = {};
  const candidate: Record<number, ModelId | null> = {};
  const horizonVerdict: Record<number, string> = {};

  for (const horizon of HORIZONS) {
    // PASO 1 — validación sin umbral: se mide el error típico de cada modelo.
    const rawValidation = MODEL_IDS.map((id) => ({
      id,
      metrics: evaluate(grid, models[id], horizon, trainEnd, validationEnd, null, features),
    }));

    // PASO 2 — con ese error como umbral, se mide la precisión de la señal.
    const scoredValidation = rawValidation.map(({ id, metrics }) => {
      const withSignal = evaluate(grid, models[id], horizon, trainEnd, validationEnd, metrics.mape, features);
      const entry: HorizonMetrics = { model: id, horizon, ...withSignal };
      validation.push(entry);
      return entry;
    });

    /*
     * PASO 3 — elección, sólo con validación.
     *
     * ═══ LA PUERTA QUE LA EVIDENCIA OBLIGÓ A PONER ═══
     *
     * Sin el contraste contra la moneda, esta selección elegía un "ganador"
     * incluso en un paseo aleatorio, donde por construcción no hay nada que
     * predecir: sobre datos sintéticos sin memoria el modelo elegido acertaba
     * el 23.5% de sus señales a 4 horas. Es peor que lanzar una moneda, y se
     * habría publicado como una señal.
     *
     * Ganar la comparación entre modelos no basta: hay que batir al azar con
     * evidencia, y con el alfa ya repartido entre los modelos que compiten
     * (ver SELECTION_ALPHA_CORRECTED). Si ningún modelo lo consigue, el
     * horizonte se queda SIN MODELO y el motor dirá NO DECIDIR, que es la
     * respuesta correcta cuando el mercado no es predecible a ese plazo.
     */
    const eligible = scoredValidation.filter((m) => {
      if (m.n < MIN_CASES_PER_HORIZON) return false;
      if (m.signalAccuracy === null || m.signals < MIN_SIGNALS_TO_QUALIFY) return false;
      const betterThanChance = binomialTailProbability(m.signalHits, m.signals);
      return betterThanChance < SELECTION_ALPHA_CORRECTED;
    });
    const winner =
      eligible.length > 0
        ? eligible.reduce((best, m) => {
            if (m.signalAccuracy! !== best.signalAccuracy!) {
              return m.signalAccuracy! > best.signalAccuracy! ? m : best;
            }
            return (m.mape ?? Infinity) < (best.mape ?? Infinity) ? m : best;
          })
        : null;

    candidate[horizon] = winner?.model ?? null;

    if (winner === null) {
      chosen[horizon] = null;
      chosenErrorPct[horizon] = null;
      horizonVerdict[horizon] =
        'Ningún modelo batió al azar en validación con evidencia suficiente: SIN MODELO.';
      continue;
    }

    // PASO 4 — test, con el modelo y el umbral ya congelados en validación.
    const testMetrics = evaluate(
      grid,
      models[winner.model],
      horizon,
      validationEnd,
      testEnd,
      winner.mape,
      features
    );
    test.push({ model: winner.model, horizon, ...testMetrics });

    /*
     * PASO 5 — CONFIRMACIÓN. El test veta, no sólo informa.
     *
     * El candidato ganó donde se le eligió; eso no dice que sirva fuera. Aquí
     * se le exige repetir contra el azar en un tramo que no participó en su
     * elección. Un único contraste, sin corregir: no se compara nada, se
     * confirma un modelo ya decidido.
     */
    const enoughTest =
      testMetrics.n >= MIN_CASES_PER_HORIZON && testMetrics.signals >= MIN_SIGNALS_TO_QUALIFY;
    const confirmP = enoughTest
      ? binomialTailProbability(testMetrics.signalHits, testMetrics.signals)
      : null;
    const confirmed = confirmP !== null && confirmP < CONFIRMATION_ALPHA;

    chosen[horizon] = confirmed ? winner.model : null;
    chosenErrorPct[horizon] = confirmed ? winner.mape : null;

    if (!enoughTest) {
      horizonVerdict[horizon] =
        `${winner.model} ganó la validación, pero el tramo de test no tiene casos suficientes ` +
        `(${testMetrics.n} casos, ${testMetrics.signals} señales) para confirmarlo: EVIDENCIA INSUFICIENTE, SIN MODELO.`;
    } else if (!confirmed) {
      const acc = ((testMetrics.signalAccuracy ?? 0) * 100).toFixed(1);
      horizonVerdict[horizon] =
        `${winner.model} ganó la validación pero NO confirmó en test ` +
        `(${testMetrics.signalHits}/${testMetrics.signals} señales, ${acc}%): SIN MODELO.`;
    } else {
      const acc = ((testMetrics.signalAccuracy ?? 0) * 100).toFixed(1);
      horizonVerdict[horizon] =
        `${winner.model} elegido en validación y confirmado en test ` +
        `(${testMetrics.signalHits}/${testMetrics.signals} señales, ${acc}%).`;
    }
  }

  return {
    split,
    validation,
    test,
    chosen,
    chosenErrorPct,
    candidate,
    horizonVerdict,
    evaluable: true,
    reason: `Walk-forward sobre ${grid.observedHours} horas observadas.`,
  };
}
