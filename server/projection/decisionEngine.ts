/**
 * DE LA PREDICCIÓN A LA DECISIÓN, SIN MEZCLARLAS
 * ================================================
 *
 * Tres bloques que se calculan por separado y viajan por separado:
 *
 *   OBSERVACIÓN   qué se midió (nivel, velocidad, aceleración, volatilidad…)
 *   PREDICCIÓN    qué se espera, con qué rango y con qué error histórico
 *   DECISIÓN      qué hacer, y por qué
 *
 * Mezclarlos fue el defecto del motor anterior: la pantalla enseñaba
 * "SUBIENDO · MODERADO" sin decir que el movimiento esperado era la mitad del
 * error del propio modelo. Aquí la decisión NUNCA se emite sin haber
 * comparado antes la ventaja esperada contra la incertidumbre.
 *
 * ═══ LA SEMÁNTICA DEL MAKER, QUE ES DE DONDE SALE LA ACCIÓN ═══
 *
 *   MI VENTA  = Binance SELL = precio al que VENDO USDT   -> lo quiero ALTO
 *   MI COMPRA = Binance BUY  = precio al que COMPRO USDT  -> lo quiero BAJO
 *
 * De ahí sale todo lo demás: que MI VENTA suba es bueno para quien va a
 * vender (conviene esperar o pedir más), y que MI COMPRA suba es malo para
 * quien va a comprar (conviene comprar ya). La misma subida produce
 * decisiones opuestas según la pierna, y por eso cada pierna decide sola.
 */

import { binomialTailProbability, roundProbability, wilsonInterval } from './probability.js';
import { cellAt, type HourlyGrid } from './hourlyGrid.js';
import { featuresFrom, type FeatureSeries, type MarketFeatures } from './marketFeatures.js';
import { buildModels, type ModelId } from './forecastModels.js';
import {
  SIGNAL_TO_NOISE_FLOOR,
  type Horizon,
  type WalkForwardReport,
} from './walkForward.js';

/** Procedencia de cada número. No se etiqueta como REAL nada calculado. */
export type Provenance = 'REAL' | 'AGGREGATED' | 'PROJECTED' | 'HEURISTIC';

export interface Valued<T> {
  value: T;
  provenance: Provenance;
  /** De dónde salió, en una frase. */
  source: string;
}

/** Las cuatro situaciones que el operador pidió distinguir. */
export type MarketRegime = 'CONTINUACION' | 'REVERSION' | 'LATERAL' | 'TRANSICION' | 'INDETERMINADO';

export const REGIME_TEXT: Record<MarketRegime, string> = {
  CONTINUACION: 'El movimiento actual tiene evidencia histórica de continuar.',
  REVERSION: 'El movimiento pierde fuerza y el histórico registra giros desde aquí.',
  LATERAL: 'Sin dirección sostenida: el mercado se mueve dentro de su ruido.',
  TRANSICION: 'La dirección está cambiando y todavía no hay confirmación.',
  INDETERMINADO: 'No hay evidencia suficiente para clasificar el estado.',
};

export type Confidence = 'ALTA' | 'MEDIA' | 'BAJA' | 'NULA';

/** Las ocho acciones que el operador pidió, más la abstención. */
export type Decision =
  | 'PUBLICAR'
  | 'NO_PUBLICAR'
  | 'ESPERAR'
  | 'SUBIR_PRECIO'
  | 'BAJAR_PRECIO'
  | 'MANTENER_PRECIO'
  | 'REDUCIR_EXPOSICION'
  | 'AUMENTAR_EXPOSICION'
  | 'NO_DECIDIR';

export const DECISION_TEXT: Record<Decision, string> = {
  PUBLICAR: 'Publicar ahora.',
  NO_PUBLICAR: 'No publicar por ahora.',
  ESPERAR: 'Esperar: se espera un precio mejor.',
  SUBIR_PRECIO: 'Subir el precio publicado.',
  BAJAR_PRECIO: 'Bajar el precio publicado.',
  MANTENER_PRECIO: 'Mantener el precio publicado.',
  REDUCIR_EXPOSICION: 'Reducir exposición.',
  AUMENTAR_EXPOSICION: 'Aumentar exposición.',
  NO_DECIDIR: 'No decidir: la evidencia no alcanza.',
};

export type DecisionLeg = 'VENTA' | 'COMPRA';

export interface LegDecision {
  leg: DecisionLeg;
  binanceSide: 'BUY' | 'SELL';
  /** Horizonte al que se decide, en horas. */
  horizon: Horizon;

  /* ── OBSERVACIÓN ── */
  currentPrice: Valued<number | null>;
  velocityPctPerHour: Valued<number | null>;
  accelerationPctPerHour2: Valued<number | null>;
  volatilityPct: Valued<number | null>;
  rangePosition: Valued<number | null>;
  consistency: Valued<number | null>;

  /* ── PREDICCIÓN ── */
  model: ModelId | null;
  projectedPrice: Valued<number | null>;
  projectedLow: Valued<number | null>;
  projectedHigh: Valued<number | null>;
  expectedMovePct: Valued<number | null>;
  /** Error típico del modelo a este horizonte, medido en validación. */
  historicalErrorPct: Valued<number | null>;
  signalToNoise: Valued<number | null>;

  /* ── INCERTIDUMBRE ── */
  regime: MarketRegime;
  continuationProbability: Valued<number | null>;
  reversalProbability: Valued<number | null>;
  /** Casos históricos que sostienen esas dos frecuencias. */
  analogCases: number;
  confidence: Confidence;

  /* ── DECISIÓN ── */
  decision: Decision;
  reason: string;
  /**
   * Qué pasó con el modelo de este horizonte en el walk-forward: elegido y
   * confirmado, o por qué se descartó. Es lo que permite distinguir "el
   * mercado está plano" de "no tengo un modelo en el que confiar".
   */
  modelVerdict: string;
}

/* ------------------------------------------------------------------------ *
 * FRECUENCIAS EMPÍRICAS DE CONTINUACIÓN Y REVERSIÓN
 * ------------------------------------------------------------------------ */

/** Casos análogos mínimos para publicar una frecuencia. */
export const MIN_ANALOG_CASES = 20;

/**
 * ¿Qué pasó las otras veces que el mercado estuvo así?
 *
 * Se buscan instantes pasados con un estado parecido (velocidad, volatilidad
 * y posición en el rango) y se cuenta cuántas veces el precio SIGUIÓ en la
 * dirección que llevaba y cuántas la INVIRTIÓ, a este mismo horizonte.
 *
 * Es una frecuencia observada, con su tamaño de muestra al lado. No es una
 * probabilidad de un modelo: si la muestra es corta se devuelve `null` en vez
 * de un número que aparente precisión.
 */
export interface ContinuationEvidence {
  continuation: number | null;
  reversal: number | null;
  cases: number;
  /** Cuentas crudas: sin ellas no se puede contrastar nada. */
  continuedCount: number;
  reversedCount: number;
}

export function empiricalContinuation(
  grid: HourlyGrid,
  features: FeatureSeries,
  i: number,
  horizon: number,
  neighbours = 40
): ContinuationEvidence {
  const empty: ContinuationEvidence = {
    continuation: null,
    reversal: null,
    cases: 0,
    continuedCount: 0,
    reversedCount: 0,
  };
  const now = featuresFrom(grid, i, features);
  if (now === null || !now.usable || now.direction === null || now.direction === 0) {
    return empty;
  }

  const scored: { distance: number; continued: boolean; reversed: boolean }[] = [];
  for (let j = 0; j + horizon <= i; j += 1) {
    const past = featuresFrom(grid, j, features);
    if (past === null || !past.usable || past.direction === null || past.direction === 0) continue;
    if (past.velocityPctPerHour === null || now.velocityPctPerHour === null) continue;
    const future = cellAt(grid, j + horizon);
    const at = cellAt(grid, j);
    if (future === null || at === null || at.level <= 0) continue;

    let distance = Math.abs(past.velocityPctPerHour - now.velocityPctPerHour);
    if (past.volatilityPct !== null && now.volatilityPct !== null) {
      distance += Math.abs(past.volatilityPct - now.volatilityPct);
    }
    if (past.rangePosition !== null && now.rangePosition !== null) {
      distance += Math.abs(past.rangePosition - now.rangePosition);
    }
    // Sólo cuentan los análogos que iban en la MISMA dirección que ahora:
    // "continuar" sólo significa algo respecto de la dirección que se lleva.
    if (past.direction !== now.direction) continue;

    const movePct = ((future.level - at.level) / at.level) * 100;
    const flat = past.volatilityPct !== null ? past.volatilityPct * 0.25 : 0;
    const continued = Math.sign(movePct) === past.direction && Math.abs(movePct) > flat;
    const reversed = Math.sign(movePct) === -past.direction && Math.abs(movePct) > flat;
    scored.push({ distance, continued, reversed });
  }

  if (scored.length < MIN_ANALOG_CASES) return { ...empty, cases: scored.length };
  scored.sort((a, b) => a.distance - b.distance);
  const keep = scored.slice(0, Math.max(MIN_ANALOG_CASES, Math.min(neighbours, scored.length)));
  const continued = keep.filter((s) => s.continued).length;
  const reversed = keep.filter((s) => s.reversed).length;
  return {
    continuation: roundProbability(continued / keep.length, keep.length),
    reversal: roundProbability(reversed / keep.length, keep.length),
    cases: keep.length,
    continuedCount: continued,
    reversedCount: reversed,
  };
}

/* ------------------------------------------------------------------------ *
 * RÉGIMEN
 * ------------------------------------------------------------------------ */

/**
 * Nivel del contraste "continuar y girar no son igual de frecuentes".
 *
 * Sin él, 18 continuaciones contra 20 giros en 40 casos —que es ruido puro—
 * se leía como REVERSIÓN. Medido sobre un paseo aleatorio sintético, el motor
 * declaraba REVERSION con 0.45 frente a 0.50: dos frecuencias que ninguna
 * muestra de ese tamaño puede distinguir. El contraste obliga a que la
 * diferencia salga del azar antes de nombrar un régimen direccional.
 */
export const REGIME_ALPHA = 0.05;

/**
 * Las cuatro situaciones, decididas por la evidencia y no por la forma de las
 * últimas horas.
 *
 * ═══ POR QUÉ MANDA LA FRECUENCIA HISTÓRICA ═══
 *
 * La primera versión exigía además que el tramo reciente fuera "consistente"
 * (>=60% de pasos alineados) y que no estuviera desacelerando. Sobre una
 * tendencia bajista sintética clara —donde el histórico continuaba el 88% de
 * las veces— eso devolvía TRANSICION casi siempre: con una ventana de 4 horas
 * hay 3 pasos, y el ruido hora a hora rompe la consistencia y cambia el signo
 * de la aceleración continuamente aunque la tendencia sea firme.
 *
 * La consistencia y la aceleración describen el pasado INMEDIATO; la
 * frecuencia de continuación mide lo que pasó DESPUÉS desde estados
 * parecidos. Para predecir manda la segunda. Las otras dos se conservan para
 * distinguir TRANSICIÓN —donde la evidencia no separa continuar de girar pero
 * el movimiento se está frenando— de LATERAL.
 */
export function classifyRegime(
  f: MarketFeatures | null,
  evidence: Pick<ContinuationEvidence, 'continuedCount' | 'reversedCount' | 'cases'>,
  typicalAcceleration: number | null = null
): MarketRegime {
  if (f === null || !f.usable || f.direction === null) return 'INDETERMINADO';

  // Sin dirección medible, o movimiento dentro del propio ruido del mercado.
  const withinNoise =
    f.magnitudePct !== null && f.volatilityPct !== null && Math.abs(f.magnitudePct) <= f.volatilityPct;
  if (f.direction === 0 || withinNoise) return 'LATERAL';

  const decided = evidence.continuedCount + evidence.reversedCount;
  if (evidence.cases < MIN_ANALOG_CASES || decided === 0) return 'INDETERMINADO';

  /*
   * ¿Se está frenando DE VERDAD, o es el ruido de siempre?
   *
   * El signo de la aceleración cambia casi en cada hora en cualquier serie
   * con ruido: sobre una tendencia bajista sintética clara —donde el
   * histórico continuaba el 88% de las veces— basta con mirar el signo para
   * declarar TRANSICION prácticamente siempre. Así que la desaceleración
   * tiene que destacar sobre la aceleración TÍPICA de este mismo mercado,
   * medida (mediana de |aceleración| del histórico), no sobre cero y no
   * sobre una constante escrita a mano.
   */
  const againstDirection =
    f.accelerationPctPerHour2 !== null && Math.sign(f.accelerationPctPerHour2) === -f.direction;
  const notableSize =
    f.accelerationPctPerHour2 !== null &&
    (typicalAcceleration === null || Math.abs(f.accelerationPctPerHour2) > typicalAcceleration);
  const decelerating = againstDirection && notableSize;

  // ¿Continuar y girar son distinguibles con esta muestra?
  const continuationWins = evidence.continuedCount > evidence.reversedCount;
  const winner = Math.max(evidence.continuedCount, evidence.reversedCount);
  const separable = binomialTailProbability(winner, decided) < REGIME_ALPHA;

  if (!separable) {
    // La evidencia no separa. Si además se está frenando, es una transición;
    // si no, el mercado sencillamente no tiene dirección explotable.
    return decelerating ? 'TRANSICION' : 'LATERAL';
  }

  if (continuationWins) {
    // Continúa históricamente, pero AHORA se está frenando: todavía no está
    // confirmado que este caso vaya a continuar.
    return decelerating ? 'TRANSICION' : 'CONTINUACION';
  }
  return 'REVERSION';
}

/* ------------------------------------------------------------------------ *
 * CONFIANZA
 * ------------------------------------------------------------------------ */

/**
 * Confianza a partir de la relación señal/ruido y de la muestra que la sostiene.
 *
 * No es una etiqueta decorativa: es la que decide si se emite acción o
 * NO_DECIDIR. Por debajo del suelo señal/ruido la confianza es NULA por
 * definición, porque el movimiento esperado no supera al error del modelo.
 */
export function classifyConfidence(
  signalToNoise: number | null,
  analogCases: number,
  modelChosen: boolean
): Confidence {
  if (!modelChosen || signalToNoise === null) return 'NULA';
  if (signalToNoise < SIGNAL_TO_NOISE_FLOOR) return 'NULA';
  if (signalToNoise >= 2 && analogCases >= MIN_ANALOG_CASES) return 'ALTA';
  if (signalToNoise >= 1.5 || analogCases >= MIN_ANALOG_CASES) return 'MEDIA';
  return 'BAJA';
}

/* ------------------------------------------------------------------------ *
 * DECISIÓN
 * ------------------------------------------------------------------------ */

/**
 * La acción, derivada de la pierna y del signo del movimiento esperado.
 *
 * Una tabla, no un score: el operador tiene que poder discutir cada casilla.
 *
 *              MI VENTA (quiero vender caro)   MI COMPRA (quiero comprar barato)
 *   sube        esperar / subir precio          comprar ya / aumentar exposición
 *   baja        publicar ya / bajar precio      esperar
 *   lateral     mantener precio                 mantener precio
 */
export function decideAction(
  leg: DecisionLeg,
  expectedMovePct: number | null,
  regime: MarketRegime,
  confidence: Confidence
): Decision {
  if (confidence === 'NULA' || expectedMovePct === null) return 'NO_DECIDIR';
  if (regime === 'INDETERMINADO') return 'NO_DECIDIR';

  // Un mercado en transición con confianza baja no es una oportunidad: es un
  // momento para tener menos puesto, no para elegir dirección.
  if (regime === 'TRANSICION') return confidence === 'BAJA' ? 'REDUCIR_EXPOSICION' : 'ESPERAR';
  if (regime === 'LATERAL') return 'MANTENER_PRECIO';

  const rising = expectedMovePct > 0;

  if (leg === 'VENTA') {
    // El precio al que vendo va a subir: no malvendo ahora.
    if (rising) return confidence === 'ALTA' ? 'SUBIR_PRECIO' : 'ESPERAR';
    // Va a bajar: vender antes de que baje.
    return confidence === 'ALTA' ? 'PUBLICAR' : 'BAJAR_PRECIO';
  }

  // COMPRA: el precio al que compro va a subir -> comprar ya.
  if (rising) return confidence === 'ALTA' ? 'AUMENTAR_EXPOSICION' : 'PUBLICAR';
  // Va a bajar -> esperar a comprar más barato.
  return 'ESPERAR';
}

/* ------------------------------------------------------------------------ *
 * EL MOTIVO, ESCRITO CON LOS NÚMEROS QUE LO SOSTIENEN
 * ------------------------------------------------------------------------ */

const pct = (v: number | null, digits = 2): string => (v === null ? 'no medible' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`);

export function buildReason(d: Omit<LegDecision, 'reason'>): string {
  if (d.decision === 'NO_DECIDIR') {
    if (d.model === null) {
      return (
        `No hay modelo validado para ${d.horizon}h: ninguno de los siete candidatos superó al azar ` +
        `con evidencia en la partición de validación. Sin eso, cualquier dirección sería una opinión.`
      );
    }
    if (d.signalToNoise.value !== null && d.historicalErrorPct.value !== null) {
      return (
        `El movimiento esperado a ${d.horizon}h es ${pct(d.expectedMovePct.value)} y el error típico del ` +
        `modelo a ese plazo es ±${d.historicalErrorPct.value.toFixed(2)}%: la señal cabe dentro del ` +
        `error (relación ${d.signalToNoise.value.toFixed(2)}), así que no sostiene una decisión.`
      );
    }
    return `Evidencia insuficiente para decidir a ${d.horizon}h.`;
  }

  const parts: string[] = [];
  const legName = d.leg === 'VENTA' ? 'MI VENTA (Binance SELL)' : 'MI COMPRA (Binance BUY)';

  parts.push(
    `${legName} está en ${d.currentPrice.value?.toFixed(2) ?? 'n/d'} VES y el modelo ${d.model} ` +
      `proyecta ${d.projectedPrice.value?.toFixed(2) ?? 'n/d'} VES a ${d.horizon}h (${pct(d.expectedMovePct.value)}).`
  );

  if (d.signalToNoise.value !== null && d.historicalErrorPct.value !== null) {
    parts.push(
      `Ese movimiento es ${d.signalToNoise.value.toFixed(2)} veces el error típico del modelo ` +
        `(±${d.historicalErrorPct.value.toFixed(2)}%), que es lo que lo hace accionable.`
    );
  }

  if (d.continuationProbability.value !== null && d.analogCases > 0) {
    parts.push(
      `En ${d.analogCases} momentos históricos con un estado parecido, el precio continuó en la misma ` +
        `dirección el ${(d.continuationProbability.value * 100).toFixed(0)}% de las veces y se giró el ` +
        `${((d.reversalProbability.value ?? 0) * 100).toFixed(0)}%.`
    );
  }

  if (d.velocityPctPerHour.value !== null) {
    parts.push(
      `Velocidad medida ${pct(d.velocityPctPerHour.value, 3)}/h` +
        (d.accelerationPctPerHour2.value !== null
          ? `, aceleración ${pct(d.accelerationPctPerHour2.value, 3)}/h².`
          : '.')
    );
  }

  parts.push(`Estado: ${REGIME_TEXT[d.regime]} Confianza ${d.confidence}.`);
  return parts.join(' ');
}

/* ------------------------------------------------------------------------ *
 * ENSAMBLADO
 * ------------------------------------------------------------------------ */

const observed = <T>(value: T, source: string): Valued<T> => ({ value, provenance: 'REAL', source });
const derived = <T>(value: T, source: string): Valued<T> => ({ value, provenance: 'AGGREGATED', source });
const projected = <T>(value: T, source: string): Valued<T> => ({ value, provenance: 'PROJECTED', source });

/**
 * Aceleración típica del mercado: mediana de |aceleración| hasta el ancla.
 *
 * Escala de referencia para decidir si una desaceleración es notable. Sólo
 * mira índices <= `upTo`, así que no puede introducir look-ahead.
 */
export function typicalAbsAcceleration(features: FeatureSeries, upTo: number): number | null {
  const values: number[] = [];
  for (let i = 0; i <= upTo && i < features.length; i += 1) {
    const a = features[i]?.accelerationPctPerHour2;
    if (a !== null && a !== undefined && Number.isFinite(a)) values.push(Math.abs(a));
  }
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/** Decide una pierna en un horizonte, con todo lo anterior encadenado. */
export function decideLeg(
  grid: HourlyGrid,
  features: FeatureSeries,
  walkForward: WalkForwardReport,
  leg: DecisionLeg,
  horizon: Horizon,
  trendWindow?: number,
  neighbours?: number
): LegDecision {
  const i = grid.cells.length - 1;
  // El ancla es la última hora OBSERVADA, no la última posición de la rejilla.
  let anchorIndex = i;
  while (anchorIndex >= 0 && cellAt(grid, anchorIndex) === null) anchorIndex -= 1;

  const f = anchorIndex >= 0 ? featuresFrom(grid, anchorIndex, features) : null;
  const here = anchorIndex >= 0 ? cellAt(grid, anchorIndex) : null;
  const model = walkForward.chosen[horizon] ?? null;
  const errorPct = walkForward.chosenErrorPct[horizon] ?? null;

  let projectedPrice: number | null = null;
  if (model !== null && anchorIndex >= 0) {
    const models = buildModels(trendWindow, neighbours);
    projectedPrice = models[model]({ grid, i: anchorIndex, horizon, features });
  }

  const currentPrice = here?.level ?? null;
  const expectedMovePct =
    projectedPrice !== null && currentPrice !== null && currentPrice > 0
      ? ((projectedPrice - currentPrice) / currentPrice) * 100
      : null;
  const signalToNoise =
    expectedMovePct !== null && errorPct !== null && errorPct > 0
      ? Math.abs(expectedMovePct) / errorPct
      : null;

  const evidence =
    anchorIndex >= 0
      ? empiricalContinuation(grid, features, anchorIndex, horizon)
      : { continuation: null, reversal: null, cases: 0, continuedCount: 0, reversedCount: 0 };
  const { continuation, reversal, cases } = evidence;

  const regime = classifyRegime(f, evidence, typicalAbsAcceleration(features, anchorIndex));
  const confidence = classifyConfidence(signalToNoise, cases, model !== null);
  const decision = decideAction(leg, expectedMovePct, regime, confidence);

  // La banda sale del error histórico del modelo, no de una sigma inventada.
  const band =
    projectedPrice !== null && errorPct !== null
      ? { low: projectedPrice * (1 - errorPct / 100), high: projectedPrice * (1 + errorPct / 100) }
      : null;

  const partial: Omit<LegDecision, 'reason'> = {
    modelVerdict:
      walkForward.horizonVerdict[horizon] ??
      (walkForward.evaluable
        ? 'Horizonte no evaluado.'
        : 'Histórico insuficiente para validar ningún modelo.'),
    leg,
    binanceSide: leg === 'VENTA' ? 'SELL' : 'BUY',
    horizon,
    currentPrice: observed(currentPrice, 'mediana de las capturas de la hora en curso'),
    velocityPctPerHour: derived(f?.velocityPctPerHour ?? null, 'recorrido de las últimas 4 horas / horas'),
    accelerationPctPerHour2: derived(
      f?.accelerationPctPerHour2 ?? null,
      'velocidad de la segunda mitad menos la de la primera'
    ),
    volatilityPct: derived(f?.volatilityPct ?? null, 'mediana de |cambio| horario en 24h'),
    rangePosition: derived(f?.rangePosition ?? null, 'posición dentro del rango de 24h'),
    consistency: derived(f?.consistency ?? null, 'pasos alineados con la dirección dominante'),
    model,
    projectedPrice: projected(projectedPrice, model === null ? 'sin modelo validado' : `modelo ${model}`),
    projectedLow: projected(band?.low ?? null, 'proyección menos el error típico del modelo'),
    projectedHigh: projected(band?.high ?? null, 'proyección más el error típico del modelo'),
    expectedMovePct: projected(expectedMovePct, 'proyección frente al precio actual'),
    historicalErrorPct: derived(errorPct, 'MAPE del modelo en la partición de validación'),
    signalToNoise: derived(signalToNoise, 'movimiento esperado / error típico'),
    regime,
    continuationProbability: derived(continuation, `frecuencia observada en ${cases} análogos`),
    reversalProbability: derived(reversal, `frecuencia observada en ${cases} análogos`),
    analogCases: cases,
    confidence,
    decision,
  };

  return { ...partial, reason: buildReason(partial) };
}

/** Intervalo de Wilson de la frecuencia de continuación, para mostrar el error. */
export function continuationInterval(continuation: number | null, cases: number) {
  if (continuation === null || cases <= 0) return { low: null, high: null };
  return wilsonInterval(Math.round(continuation * cases), cases);
}
