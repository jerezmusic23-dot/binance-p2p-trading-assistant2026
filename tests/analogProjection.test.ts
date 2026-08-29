/**
 * LA PROYECCIÓN POR ANALOGÍA, Y LO QUE NO SE LE PERMITE HACER
 * ==========================================================
 *
 * Esta suite no comprueba que el motor "acierte". Comprueba las cuatro cosas
 * que lo separan de la caja negra que sustituye:
 *
 *   1. Que toda probabilidad publicada sea un recuento de casos concretos, y
 *      que esos casos estén en el audit trail con su fecha.
 *   2. Que la dirección se mida contra la deriva estructural del VES y no
 *      contra cero, porque contra cero todo sería ALCISTA.
 *   3. Que cuando no hay evidencia diga INSUFICIENTE HISTÓRICO en lugar de
 *      inventar un número.
 *   4. Que no se presente como utilizable mientras no gane a "el precio se
 *      queda donde está".
 *
 * Todas las series son SINTÉTICAS y describen formas (rampa, diente de
 * sierra, paseo aleatorio). No son datos de mercado ni pretenden parecerlo.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HORIZONS_MS,
  GAP_TOLERANCE_MULTIPLE,
  MIN_ANALOGUES,
  MIN_BACKTEST_ANCHORS,
  MIN_LOOKBACK_STEPS,
  VALIDATION_ALPHA,
  backtestHorizon,
  binomialTailProbability,
  classifyOutcome,
  decideValidation,
  describeHorizon,
  lookbackFor,
  minimumLengthFor,
  medianIntervalMs,
  percentileOf,
  projectByAnalogy,
  projectHorizon,
  sanitiseSeries,
  stateOf,
  wilsonInterval,
  type AnalogPoint,
} from '../server/analogProjection.js';

const T0 = Date.UTC(2026, 7, 1, 12, 0, 0);
const MINUTE = 60_000;
const H30 = 30 * MINUTE;

function seriesFrom(prices: readonly number[], stepMs = MINUTE): AnalogPoint[] {
  return prices.map((price, i) => ({ t: T0 + i * stepMs, price }));
}

/** Rampa lineal: sube siempre lo mismo. Es la deriva estructural en estado puro. */
function ramp(from: number, increment: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => Number((from + i * increment).toFixed(6)));
}

/** Diente de sierra: sube `half` pasos, baja `half` pasos, indefinidamente. */
function sawtooth(base: number, increment: number, half: number, count: number): number[] {
  const out: number[] = [];
  let price = base;
  let up = true;
  for (let i = 0; i < count; i += 1) {
    out.push(Number(price.toFixed(6)));
    price += up ? increment : -increment;
    if ((i + 1) % half === 0) up = !up;
  }
  return out;
}

/** Onda determinista de periodo `period` pasos. */
function sine(base: number, amplitude: number, period: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) =>
    Number((base + amplitude * Math.sin((2 * Math.PI * i) / period)).toFixed(6))
  );
}

/** PRNG determinista (mulberry32): el mismo seed da siempre la misma serie. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paseo aleatorio: por construcción no tiene nada que predecir. */
function randomWalk(base: number, tick: number, count: number, seed: number): number[] {
  const rnd = mulberry32(seed);
  const out: number[] = [];
  let price = base;
  for (let i = 0; i < count; i += 1) {
    out.push(Number(price.toFixed(6)));
    price += (rnd() < 0.5 ? -1 : 1) * tick;
  }
  return out;
}

/** Recorre cualquier objeto y falla ante el primer número no finito. */
function assertAllFinite(value: unknown, path = 'root'): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} = ${value}`).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => assertAllFinite(entry, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertAllFinite(entry, `${path}.${key}`);
    }
  }
}

/* ------------------------------------------------------------------------ */

describe('sin evidencia no hay proyección', () => {
  it('dice INSUFICIENTE HISTÓRICO en lugar de devolver un número', () => {
    const short = projectHorizon(seriesFrom(ramp(940, 0.01, 50)), H30);

    expect(short.available).toBe(false);
    expect(short.reason).toBe('HORIZON_LONGER_THAN_HISTORY');
    expect(short.reasonText).toContain('INSUFICIENTE HISTÓRICO');
    expect(short.central).toBeNull();
    expect(short.probabilityUp).toBeNull();
    expect(short.direction).toBeNull();
    expect(short.audit).toBeNull();
  });

  it('no publica una probabilidad con menos análogos de los exigidos', () => {
    // Una observación por debajo de lo que MIN_ANALOGUES tramos no solapados
    // necesitan. El motor no rebaja el suelo para poder decir algo.
    const horizonSteps = 30;
    const justUnder = minimumLengthFor(horizonSteps, lookbackFor(horizonSteps)) - 1;
    const result = projectHorizon(seriesFrom(randomWalk(940, 0.01, justUnder, 7)), H30);

    expect(result.available).toBe(false);
    expect(result.probabilityUp).toBeNull();
  });

  it('degrada sin lanzar ante series vacías, de un punto o constantes', () => {
    for (const points of [[], seriesFrom([940]), seriesFrom(Array(200).fill(940))]) {
      const projection = projectByAnalogy(points, { horizonsMs: [H30] });
      expect(() => assertAllFinite(projection)).not.toThrow();
      expect(projection.usable).toBe(false);
      expect(projection.notice).not.toBeNull();
    }
  });

  it('marca todos los horizontes que el histórico no sostiene', () => {
    const projection = projectByAnalogy(seriesFrom(randomWalk(940, 0.01, 800, 3)));

    expect(projection.horizons).toHaveLength(DEFAULT_HORIZONS_MS.length);
    const unsupported = projection.horizons.filter((h) => !h.available);
    expect(unsupported.length).toBeGreaterThan(0);
    for (const horizon of unsupported) {
      expect(horizon.reasonText).toBeTruthy();
      expect(horizon.central).toBeNull();
    }
  });
});

describe('la probabilidad es un recuento de casos reales', () => {
  const points = seriesFrom(randomWalk(940, 0.01, 1600, 11));
  const result = projectHorizon(points, H30);

  it('produce una proyección con este histórico', () => {
    expect(result.available).toBe(true);
    expect(result.audit).not.toBeNull();
  });

  it('la fracción publicada es exactamente casos_favorables / casos_totales', () => {
    const audit = result.audit!;
    expect(audit.upCount + audit.flatCount + audit.downCount).toBe(audit.analoguesUsed);
    expect(result.probabilityUp).toBeCloseTo(audit.upCount / audit.analoguesUsed, 12);
    expect(result.probabilityFlat).toBeCloseTo(audit.flatCount / audit.analoguesUsed, 12);
    expect(result.probabilityDown).toBeCloseTo(audit.downCount / audit.analoguesUsed, 12);
    expect(
      (result.probabilityUp ?? 0) + (result.probabilityFlat ?? 0) + (result.probabilityDown ?? 0)
    ).toBeCloseTo(1, 12);
  });

  it('adjunta los N casos concretos de los que salió el número', () => {
    const audit = result.audit!;
    expect(audit.samples).toHaveLength(audit.analoguesUsed);
    expect(audit.samples.filter((s) => s.outcome === 'UP')).toHaveLength(audit.upCount);

    const observed = new Map(points.map((p) => [p.t, p.price]));
    for (const sample of audit.samples) {
      // Cada análogo es un instante que ocurrió, con el precio que tuvo.
      expect(observed.get(sample.t)).toBe(sample.price);
    }
  });

  it('la frase publicada dice los dos términos de la división', () => {
    const audit = result.audit!;
    expect(result.evidence).toBe(
      `En situaciones históricas similares, ${audit.upCount} de ${audit.analoguesUsed} casos ` +
        `terminaron por encima del precio actual a +30 min.`
    );
  });

  it('ningún análogo depende de un futuro que todavía no ha ocurrido', () => {
    const audit = result.audit!;
    // El resultado de un análogo se observa `horizonSteps` más tarde, así que
    // ningún ancla puede estar después del último instante que ya tiene su
    // futuro completo dentro de la serie.
    const latestUsable = points[points.length - 1 - audit.horizonSteps].t;
    for (const sample of audit.samples) {
      expect(sample.t).toBeLessThanOrEqual(latestUsable);
    }
  });

  it('k está fijo y epsilon es su consecuencia, no un umbral elegido', () => {
    const audit = result.audit!;
    expect(audit.analoguesUsed).toBeLessThanOrEqual(100);
    expect(audit.analoguesUsed).toBeGreaterThanOrEqual(MIN_ANALOGUES);
    expect(audit.candidatePool).toBeGreaterThan(audit.analoguesUsed);
    expect(audit.maxDistanceUsed).toBeGreaterThanOrEqual(0);
  });

  it('el intervalo se calcula con las ventanas independientes, no con las solapadas', () => {
    const audit = result.audit!;
    // Independientes POR CONSTRUCCIÓN: ningún par de análogos comparte
    // movimiento, así que este número no es una estimación, es el recuento.
    expect(audit.independentAnalogues).toBe(audit.analoguesUsed);
    expect(audit.independentAnalogues).toBeGreaterThanOrEqual(MIN_ANALOGUES);
    const indices = audit.samples.map((s) => s.t).sort((a, b) => a - b);
    for (let i = 1; i < indices.length; i += 1) {
      expect(indices[i] - indices[i - 1]).toBeGreaterThanOrEqual(
        audit.horizonSteps * audit.medianIntervalMs!
      );
    }
    expect(result.probabilityUpLow!).toBeLessThanOrEqual(result.probabilityUp!);
    expect(result.probabilityUpHigh!).toBeGreaterThanOrEqual(result.probabilityUp!);
  });
});

describe('la dirección se mide contra el régimen, no contra cero', () => {
  it('una deriva estructural constante NO es una tendencia alcista', () => {
    // El VES se deprecia siempre. Esta serie sube en cada observación, así que
    // un modelo que definiera "sube" como "delta > 0" diría 100% ALCISTA.
    const projection = projectHorizon(seriesFrom(ramp(940, 0.02, 1600)), H30);

    expect(projection.available).toBe(true);
    expect(projection.audit!.regimeDelta).toBeCloseTo(30 * 0.02, 6);
    expect(projection.probabilityUp).toBe(0);
    expect(projection.probabilityFlat).toBe(1);
    expect(projection.direction).toBe('LATERAL');
  });

  it('el escenario central sí recoge la deriva, aunque la dirección sea LATERAL', () => {
    const projection = projectHorizon(seriesFrom(ramp(940, 0.02, 1600)), H30);
    const current = projection.currentPrice!;

    // Subir con el mercado no es "subir"; el precio proyectado sí sube.
    expect(projection.central!).toBeGreaterThan(current);
    expect(projection.central! - current).toBeCloseTo(30 * 0.02, 6);
  });

  it('classifyOutcome mide el exceso sobre el régimen en pasos típicos', () => {
    expect(classifyOutcome(1.5, 1.0, 0.4)).toBe('UP');
    expect(classifyOutcome(1.3, 1.0, 0.4)).toBe('FLAT');
    expect(classifyOutcome(0.5, 1.0, 0.4)).toBe('DOWN');
    // Contra cero, los tres serían "sube".
    expect(classifyOutcome(1.5, 0, 0.4)).toBe('UP');
    expect(classifyOutcome(0.5, 0, 0.4)).toBe('UP');
  });
});

describe('los huecos de captura invalidan la ventana que los contiene', () => {
  it('descarta las anclas cuya ventana atraviesa un hueco', () => {
    const prices = randomWalk(940, 0.01, 1600, 5);
    const clean = seriesFrom(prices);
    const withGap = seriesFrom(prices).map((p, i) =>
      i >= 800 ? { ...p, t: p.t + 20 * MINUTE } : p
    );

    const cleanResult = projectHorizon(clean, H30);
    const gapResult = projectHorizon(withGap, H30);

    expect(cleanResult.available).toBe(true);
    expect(gapResult.available).toBe(true);
    // El salto rompe toda ventana que lo cruza: menos candidatos, no los mismos.
    expect(gapResult.audit!.candidatePool).toBeLessThan(cleanResult.audit!.candidatePool);
  });

  it('tolera el jitter normal del scheduler sin descartar nada', () => {
    const prices = randomWalk(940, 0.01, 1600, 5);
    const clean = seriesFrom(prices);
    // Un tick de cada tres llega 24 s tarde: huecos de 1.4 / 0.6 / 1.0 min.
    // La cadencia mediana sigue siendo 1 min y ningún hueco alcanza el
    // múltiplo de tolerancia, así que no debe descartarse ni una ventana.
    const jittered = seriesFrom(prices).map((p, i) => ({
      ...p,
      t: p.t + (i % 3 === 1 ? Math.floor(MINUTE * (GAP_TOLERANCE_MULTIPLE - 1) * 0.8) : 0),
    }));
    expect(medianIntervalMs(jittered)).toBe(MINUTE);

    expect(projectHorizon(jittered, H30).audit!.candidatePool).toBe(
      projectHorizon(clean, H30).audit!.candidatePool
    );
  });
});

describe('el backtest contra la persistencia', () => {
  it('sobre un paseo aleatorio no encuentra ventaja, y el motor lo dice', () => {
    // No hay nada que predecir por construcción. Si el motor se declarara
    // utilizable aquí, estaría leyendo ruido.
    const projection = projectByAnalogy(seriesFrom(randomWalk(940, 0.01, 2400, 23)), {
      horizonsMs: [H30],
    });

    const baseline = projection.baselines[0];
    expect(baseline.anchors).toBeGreaterThanOrEqual(MIN_BACKTEST_ANCHORS);
    expect(baseline.beatsPersistence).toBe(false);
    expect(projection.usable).toBe(false);
    expect(projection.notice).toContain('NO VALIDADA');
  });

  it('LA PRECISIÓN DIRECCIONAL GANA SOBRE RUIDO PURO, y por eso no decide', () => {
    // Este es el falso positivo concreto que costó rehacer el criterio.
    //
    // Sobre este paseo aleatorio el modelo acierta la dirección MÁS veces que
    // la persistencia, y no por habilidad: bajo una banda de +-1 paso típico,
    // "no se mueve" es un resultado poco frecuente, así que cualquier
    // predictor que se atreva a decir SUBE o BAJA le gana por frecuencia de
    // clases. Medido sobre 40 semillas distintas, la precisión direccional
    // superaba a la persistencia en 36 de 40 series SIN NINGUNA ESTRUCTURA.
    //
    // El criterio real es el error de precio, que no se puede ganar así, y
    // sobre las mismas 40 semillas no validó ni una sola.
    const baseline = backtestHorizon(seriesFrom(randomWalk(940, 0.01, 2400, 23)), H30);

    expect(baseline.directionalAccuracy!).toBeGreaterThan(
      baseline.persistenceDirectionalAccuracy!
    );
    // Y aun así el modelo pierde en lo que importa: acercarse al precio.
    expect(baseline.persistenceBetterCount).toBeGreaterThan(baseline.modelBetterCount);
    expect(baseline.pValue!).toBeGreaterThan(VALIDATION_ALPHA);
  });

  it('mide la persistencia explícitamente, no la da por supuesta', () => {
    const baseline = backtestHorizon(seriesFrom(randomWalk(940, 0.01, 2400, 23)), H30);

    expect(baseline.persistenceMedianAbsError).not.toBeNull();
    expect(baseline.modelMedianAbsError).not.toBeNull();
    expect(baseline.bandCoverage).not.toBeNull();
    expect(baseline.modelBetterCount + baseline.persistenceBetterCount + baseline.tiedCount).toBe(
      baseline.anchors
    );
    for (const value of [
      baseline.directionalAccuracy,
      baseline.persistenceDirectionalAccuracy,
      baseline.bandCoverage,
    ]) {
      expect(value!).toBeGreaterThanOrEqual(0);
      expect(value!).toBeLessThanOrEqual(1);
    }
  });

  it('declara INSUFFICIENT_ANCHORS cuando no hay pruebas suficientes', () => {
    const baseline = backtestHorizon(seriesFrom(randomWalk(940, 0.01, 1400, 9)), H30);

    expect(baseline.reason).toBe('INSUFFICIENT_ANCHORS');
    expect(baseline.beatsPersistence).toBeNull();
    expect(baseline.anchors).toBeLessThan(MIN_BACKTEST_ANCHORS);
  });

  it('sobre una serie con estructura visible sí valida, y entonces usable es true', () => {
    // Onda de periodo 40 pasos, más corta que la ventana de contexto de 30:
    // el estado PUEDE ver en qué punto del ciclo está. Sin este caso, la
    // puerta de validación sería código muerto: nada demostraría que abre.
    const projection = projectByAnalogy(seriesFrom(sine(940, 0.4, 40, 2400)), {
      horizonsMs: [H30],
    });

    expect(projection.baselines[0].modelMedianAbsError!).toBeLessThan(
      projection.baselines[0].persistenceMedianAbsError!
    );
    expect(projection.baselines[0].beatsPersistence).toBe(true);
    expect(projection.usable).toBe(true);
    expect(projection.notice).toBeNull();
  });

  it('NO valida cuando el ciclo es más largo que la ventana de contexto', () => {
    // Límite real del método, no un fallo: con un diente de sierra de 60 pasos
    // de subida, una ventana de 30 ve "lleva 30 pasos subiendo" tanto a mitad
    // de la subida como justo en el pico. El modelo predice continuación y se
    // equivoca en cada giro, quedando POR DEBAJO de no moverse. El motor lo
    // detecta y no se publica como utilizable, que es lo único que se le pide.
    const projection = projectByAnalogy(seriesFrom(sawtooth(940, 0.02, 60, 2400)), {
      horizonsMs: [H30],
    });

    expect(projection.baselines[0].modelMedianAbsError!).toBeGreaterThan(
      projection.baselines[0].persistenceMedianAbsError!
    );
    expect(projection.baselines[0].beatsPersistence).toBe(false);
    expect(projection.usable).toBe(false);
  });

  it('el test de signos excluye los empates, que no distinguen a nadie', () => {
    const baseline = backtestHorizon(seriesFrom(randomWalk(940, 0.01, 2400, 23)), H30);
    const decisive = baseline.modelBetterCount + baseline.persistenceBetterCount;

    expect(baseline.tiedCount).toBeGreaterThan(0);
    expect(decisive).toBeLessThan(baseline.anchors);
    expect(baseline.pValue).toBeCloseTo(
      binomialTailProbability(baseline.modelBetterCount, decisive),
      12
    );
  });
});

describe('la corrección por comparaciones múltiples', () => {
  it('el contraste exacto es el binomial, no la normal de McNemar', () => {
    // 9 discordantes, los 9 a favor del modelo: 1/2^9.
    expect(binomialTailProbability(9, 9)).toBeCloseTo(1 / 512, 12);
    // La normal exigiría un mínimo de discordantes para ser válida; el exacto
    // no, y por eso puede decidir con las pocas decenas de anclas que hay.
    expect(binomialTailProbability(5, 10)).toBeCloseTo(0.623046875, 12);
    expect(binomialTailProbability(0, 10)).toBe(1);
    expect(binomialTailProbability(11, 10)).toBe(0);
    expect(binomialTailProbability(1, 0)).toBe(1);
  });

  it('endurece el umbral en proporción a los contrastes realmente ejecutados', () => {
    const walk = projectByAnalogy(seriesFrom(randomWalk(940, 0.01, 2400, 23)), {
      horizonsMs: [H30],
    });
    // Un solo contraste ejecutado: alpha entero.
    expect(walk.baselines[0].familySize).toBe(1);
    expect(walk.baselines[0].alpha).toBeCloseTo(VALIDATION_ALPHA, 12);

    // Dos series contrastadas a la vez: el umbral se reparte entre ambas.
    const both = decideValidation([walk, walk]);
    expect(both[0].baselines[0].familySize).toBe(2);
    expect(both[0].baselines[0].alpha).toBeCloseTo(VALIDATION_ALPHA / 2, 12);
  });

  it('no cuenta como contraste un horizonte que se quedó sin anclas', () => {
    // Un horizonte sin anclas no probó nada. Sumarlo a la familia endurecería
    // el umbral con una prueba que nunca se hizo.
    const projection = projectByAnalogy(seriesFrom(randomWalk(940, 0.01, 2400, 23)), {
      horizonsMs: [H30, 6 * 60 * 60 * 1000],
    });

    const tested = projection.baselines.filter((b) => b.pValue !== null);
    const untested = projection.baselines.filter((b) => b.pValue === null);
    expect(tested).toHaveLength(1);
    expect(untested).toHaveLength(1);
    expect(tested[0].familySize).toBe(1);
    expect(untested[0].beatsPersistence).toBeNull();
  });

  it('la misma evidencia deja de bastar cuando la familia crece', () => {
    // Éste es el falso positivo que la corrección existe para matar. La
    // evidencia no cambia; cambia cuántas veces se ha mirado. El tamaño de
    // familia se elige aquí a partir del p-valor observado, no al revés: se
    // busca el punto exacto donde ESA evidencia deja de superar el umbral.
    const saw = projectByAnalogy(seriesFrom(sine(940, 0.4, 40, 2400)), {
      horizonsMs: [H30],
    });
    expect(saw.usable).toBe(true);

    const pValue = saw.baselines[0].pValue!;
    const familySize = Math.ceil(VALIDATION_ALPHA / pValue) + 1;
    const family = decideValidation(Array.from({ length: familySize }, () => saw));

    expect(family[0].baselines[0].familySize).toBe(familySize);
    expect(family[0].baselines[0].alpha!).toBeLessThan(pValue);
    expect(family[0].usable).toBe(false);
    expect(family[0].notice).toContain('NO VALIDADA');
  });

  it('decideValidation es pura: no toca lo que recibe', () => {
    const original = projectByAnalogy(seriesFrom(sine(940, 0.4, 40, 2400)), {
      horizonsMs: [H30],
    });
    const snapshot = JSON.stringify(original);

    decideValidation([original, original, original]);

    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe('ningún NaN ni Infinity sale de este motor', () => {
  it('sobrevive a precios corruptos, timestamps desordenados y duplicados', () => {
    const hostile: AnalogPoint[] = [
      ...seriesFrom(randomWalk(940, 0.01, 1600, 31)),
      { t: T0 + 5 * MINUTE, price: Number.NaN },
      { t: T0 + 6 * MINUTE, price: Number.POSITIVE_INFINITY },
      { t: T0 + 7 * MINUTE, price: -940 },
      { t: T0 + 8 * MINUTE, price: 0 },
      { t: Number.NaN, price: 940 },
      { t: T0 + 9 * MINUTE, price: 941 },
      { t: T0 + 9 * MINUTE, price: 942 },
    ];

    const projection = projectByAnalogy(hostile, { horizonsMs: [H30] });
    assertAllFinite(projection);
    expect(projection.history.every((p) => Number.isFinite(p.price) && p.price > 0)).toBe(true);
  });

  it('sanitiseSeries deja la serie ordenada, finita y sin timestamps repetidos', () => {
    const cleaned = sanitiseSeries([
      { t: T0 + 2 * MINUTE, price: 942 },
      { t: T0, price: 940 },
      { t: T0 + MINUTE, price: Number.NaN },
      { t: T0 + 2 * MINUTE, price: 943 },
      { t: T0 + 3 * MINUTE, price: 0 },
    ]);

    expect(cleaned).toEqual([
      { t: T0, price: 940 },
      { t: T0 + 2 * MINUTE, price: 943 },
    ]);
  });

  it('no divide por cero cuando la serie nunca se movió', () => {
    const flat = seriesFrom(Array(1600).fill(940));
    const result = projectHorizon(flat, H30);

    assertAllFinite(result);
    if (result.available) {
      expect(result.central).toBe(940);
      expect(result.low).toBe(940);
      expect(result.high).toBe(940);
      expect(result.probabilityFlat).toBe(1);
      expect(result.direction).toBe('LATERAL');
    }
  });
});

describe('las piezas medibles por separado', () => {
  it('medianIntervalMs mide la cadencia real, no la supuesta', () => {
    expect(medianIntervalMs(seriesFrom([1, 2, 3, 4], 4.5 * MINUTE))).toBe(4.5 * MINUTE);
    expect(medianIntervalMs([])).toBeNull();
    expect(medianIntervalMs(seriesFrom([1]))).toBeNull();
  });

  it('la ventana de contexto es el propio horizonte, con un mínimo medible', () => {
    expect(lookbackFor(30)).toBe(30);
    expect(lookbackFor(1)).toBe(MIN_LOOKBACK_STEPS);
    expect(lookbackFor(MIN_LOOKBACK_STEPS)).toBe(MIN_LOOKBACK_STEPS);
  });

  it('percentileOf usa orden estadístico sin interpolar', () => {
    const sorted = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(percentileOf(sorted, 0.1)).toBe(1);
    expect(percentileOf(sorted, 0.5)).toBe(5);
    expect(percentileOf(sorted, 0.9)).toBe(9);
    expect(percentileOf([], 0.5)).toBeNull();
  });

  it('stateOf describe la ventana en pasos típicos, no en VES', () => {
    // La misma forma a dos niveles de precio distintos es el mismo estado.
    const low = seriesFrom([10, 11, 12, 13, 14]);
    const high = seriesFrom([940, 941, 942, 943, 944]);
    expect(stateOf(low, 0, 4, 1)).toEqual(stateOf(high, 0, 4, 1));
  });

  it('stateOf no puede describir una ventana demasiado corta', () => {
    expect(stateOf(seriesFrom([940, 941]), 0, 1, 1)).toBeNull();
  });

  it('el intervalo de Wilson se estrecha al crecer la muestra independiente', () => {
    const small = wilsonInterval(50, 100, 25);
    const large = wilsonInterval(50, 100, 100);

    expect(small.high! - small.low!).toBeGreaterThan(large.high! - large.low!);
    for (const bound of [small.low!, small.high!, large.low!, large.high!]) {
      expect(bound).toBeGreaterThanOrEqual(0);
      expect(bound).toBeLessThanOrEqual(1);
    }
    expect(wilsonInterval(0, 0, 0).low).toBeNull();
  });

  it('las etiquetas de horizonte dicen el horizonte pedido', () => {
    expect(describeHorizon(30 * MINUTE)).toBe('+30 min');
    expect(describeHorizon(60 * MINUTE)).toBe('+1 h');
    expect(describeHorizon(90 * MINUTE)).toBe('+1.5 h');
  });
});
