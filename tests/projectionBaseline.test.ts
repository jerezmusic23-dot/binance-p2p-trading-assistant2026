/**
 * EL BACKTEST Y LA BASELINE DE PERSISTENCIA
 * =========================================
 *
 * La única pregunta que decide si esto sirve: ¿acierta más que decir "el
 * precio se queda donde está"? Una precisión del 68% no significa nada suelta;
 * si la persistencia consigue el 71%, el motor no ha demostrado nada.
 *
 * Aquí se prueba que el contraste es honesto en LAS DOS DIRECCIONES: que no
 * valide ruido y que sí valide estructura real.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_BACKTEST_ANCHORS,
  MIN_BACKTEST_ANCHORS,
  VALIDATION_ALPHA,
  backtestHorizon,
  backtestHorizonAsync,
  binomialTailProbability,
  decideValidation,
  projectWithBacktest,
  projectWithBacktestAsync,
} from '../server/projection/index.js';
import {
  H15,
  H30,
  pointsFrom,
  randomWalk,
  sawtooth,
  sine,
} from './helpers/projectionSeries.js';

describe('sobre ruido puro no encuentra ventaja', () => {
  it('un paseo aleatorio no se declara utilizable', () => {
    const projection = projectWithBacktest(pointsFrom(randomWalk(940, 0.01, 2000, 23)), {
      horizonsMs: [H15],
    });

    expect(projection.baselines[0].anchors).toBeGreaterThanOrEqual(MIN_BACKTEST_ANCHORS);
    expect(projection.baselines[0].beatsPersistence).toBe(false);
    expect(projection.horizons[0].status).toBe('NO_EDGE');
    expect(projection.usable).toBe(false);
    expect(projection.notice).toContain('NO VALIDADA');
  });

  it('LA PRECISIÓN DIRECCIONAL GANA SOBRE RUIDO PURO, y por eso no decide', () => {
    /*
     * Éste es el falso positivo concreto que costó rehacer el criterio.
     *
     * Bajo una banda de ±1 paso típico, "no se mueve" es un desenlace poco
     * frecuente, así que cualquier predictor que se atreva a decir SUBE o BAJA
     * le gana por frecuencia de clases, sin habilidad. Medido sobre 40
     * semillas distintas, la precisión direccional superaba a la persistencia
     * en 36 de 40 series SIN NINGUNA ESTRUCTURA.
     *
     * El criterio real es el error de precio, que no se puede ganar así.
     */
    const baseline = backtestHorizon(pointsFrom(randomWalk(940, 0.01, 2000, 23)), H15);

    expect(baseline.directionalAccuracy!).toBeGreaterThan(
      baseline.persistenceDirectionalAccuracy!
    );
    expect(baseline.pValue!).toBeGreaterThan(VALIDATION_ALPHA);
  });

  it('ninguna de veinte semillas de ruido se valida', () => {
    // Un solo paseo aleatorio podría pasar por azar; veinte no deberían. Esto
    // es la tasa de falsos positivos del criterio, medida y fijada.
    let validated = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      const projection = projectWithBacktest(pointsFrom(randomWalk(940, 0.01, 1600, seed)), {
        horizonsMs: [H15],
      });
      if (projection.usable) validated += 1;
    }

    expect(validated).toBe(0);
  });
});

describe('sobre estructura real sí valida', () => {
  /*
   * Onda de periodo 25 pasos frente a una ventana de contexto de 15: el estado
   * ve una fracción suficiente del ciclo para situar la fase. Sin este caso la
   * puerta de validación sería código muerto y nada demostraría que abre.
   */
  const learnable = pointsFrom(sine(940, 0.4, 25, 2000));

  it('gana en error de precio y el horizonte llega a READY', () => {
    const projection = projectWithBacktest(learnable, { horizonsMs: [H15] });
    const baseline = projection.baselines[0];

    expect(baseline.modelMedianAbsError!).toBeLessThan(baseline.persistenceMedianAbsError!);
    expect(baseline.beatsPersistence).toBe(true);
    expect(projection.horizons[0].status).toBe('READY');
    expect(projection.usable).toBe(true);
    expect(projection.notice).toBeNull();
  });

  it('NO valida cuando el ciclo es más largo que la ventana de contexto', () => {
    /*
     * Límite real del método, no un fallo. Con un diente de sierra de 60 pasos
     * de subida, una ventana de 15 ve "lleva 15 pasos subiendo" tanto a mitad
     * de la subida como justo en el pico: el modelo predice continuación y se
     * equivoca en cada giro. El backtest lo detecta y no lo publica, que es lo
     * único que se le pide.
     */
    const projection = projectWithBacktest(pointsFrom(sawtooth(940, 0.02, 60, 2000)), {
      horizonsMs: [H15],
    });

    expect(projection.baselines[0].beatsPersistence).toBe(false);
    expect(projection.horizons[0].status).toBe('NO_EDGE');
    expect(projection.usable).toBe(false);
  });
});

describe('cuando la persistencia es imbatible', () => {
  it('no reclama ventaja aunque el modelo acierte perfectamente', () => {
    /*
     * Onda de periodo 15 con horizonte de 15 pasos: el precio vuelve
     * exactamente a donde estaba. La persistencia acierta al milímetro, y el
     * modelo también. Todos los pares empatan, no hay ninguno discordante, y
     * un test de signos sin pares discordantes no puede concluir nada.
     *
     * Lo que se exige aquí es que ese "nada" se publique como NO_EDGE y no
     * como un empate presentado como éxito.
     */
    const projection = projectWithBacktest(pointsFrom(sine(940, 0.4, 15, 2000)), {
      horizonsMs: [H15],
    });
    const baseline = projection.baselines[0];

    expect(baseline.modelBetterCount).toBe(0);
    expect(baseline.persistenceBetterCount).toBe(0);
    expect(baseline.tiedCount).toBe(baseline.anchors);
    expect(baseline.pValue).toBeNull();
    expect(baseline.beatsPersistence).toBe(false);
    expect(projection.horizons[0].status).toBe('NO_EDGE');
    expect(projection.usable).toBe(false);
  });
});

describe('las métricas del backtest', () => {
  const baseline = backtestHorizon(pointsFrom(randomWalk(940, 0.01, 2000, 23)), H15);

  it('mide la persistencia explícitamente, no la da por supuesta', () => {
    expect(baseline.persistenceMedianAbsError).not.toBeNull();
    expect(baseline.modelMedianAbsError).not.toBeNull();
    expect(baseline.modelBetterCount + baseline.persistenceBetterCount + baseline.tiedCount).toBe(
      baseline.anchors
    );
  });

  it('publica cobertura junto a la cobertura prometida', () => {
    // La banda son los percentiles 10 y 90, así que promete 80%. Publicar la
    // cobertura sin el objetivo dejaría al lector sin con qué compararla.
    expect(baseline.coverageTarget).toBeCloseTo(0.8, 10);
    expect(baseline.bandCoverage!).toBeGreaterThanOrEqual(0);
    expect(baseline.bandCoverage!).toBeLessThanOrEqual(1);
  });

  it('publica la anchura de la banda: cubrir con una banda enorme no es mérito', () => {
    expect(baseline.medianBandWidth!).toBeGreaterThan(0);
  });

  it('el test de signos excluye los empates, que no distinguen a nadie', () => {
    const decisive = baseline.modelBetterCount + baseline.persistenceBetterCount;
    expect(decisive).toBeLessThanOrEqual(baseline.anchors);
    expect(baseline.pValue).toBeCloseTo(
      binomialTailProbability(baseline.modelBetterCount, decisive),
      12
    );
  });

  it('incluye la calibración de las probabilidades que anunció', () => {
    expect(baseline.calibration.predictions).toBe(baseline.anchors);
    expect(baseline.calibration.brier).not.toBeNull();
    expect(baseline.calibration.brierBaseline).not.toBeNull();
    const counted = baseline.calibration.buckets.reduce((acc, b) => acc + b.predictions, 0);
    expect(counted).toBe(baseline.anchors);
  });

  it('las anclas no se solapan: el paso nunca baja del horizonte', () => {
    const audit = projectWithBacktest(pointsFrom(randomWalk(940, 0.01, 2000, 23)), {
      horizonsMs: [H15],
    });
    const horizonSteps = audit.horizons[0].audit!.horizonSteps;
    expect(baseline.anchorStride).toBeGreaterThanOrEqual(horizonSteps);
    expect(baseline.anchors).toBeLessThanOrEqual(MAX_BACKTEST_ANCHORS);
  });
});

describe('cuando no hay pruebas suficientes', () => {
  it('declara INSUFFICIENT_ANCHORS sin gastar el cálculo', () => {
    const baseline = backtestHorizon(pointsFrom(randomWalk(940, 0.01, 1400, 9)), H30);

    expect(baseline.reason).toBe('INSUFFICIENT_ANCHORS');
    expect(baseline.beatsPersistence).toBeNull();
    expect(baseline.anchors).toBeLessThan(MIN_BACKTEST_ANCHORS);
    // No se recorre un horizonte que ya se sabe que no llega al suelo.
    expect(baseline.anchors).toBe(0);
  });

  it('un horizonte sin contraste no puede alcanzar READY', () => {
    const projection = projectWithBacktest(pointsFrom(sine(940, 0.4, 25, 1200)), {
      horizonsMs: [H15, H30],
    });
    const untested = projection.horizons.find((h) => h.requestedHorizonMs === H30)!;
    expect(untested.status).not.toBe('READY');
  });
});

describe('la corrección por comparaciones múltiples', () => {
  it('endurece el umbral en proporción a los contrastes ejecutados', () => {
    const one = projectWithBacktest(pointsFrom(randomWalk(940, 0.01, 2000, 23)), {
      horizonsMs: [H15],
    });
    expect(one.baselines[0].familySize).toBe(1);
    expect(one.baselines[0].alpha).toBeCloseTo(VALIDATION_ALPHA, 12);

    const both = decideValidation([one, one]);
    expect(both[0].baselines[0].familySize).toBe(2);
    expect(both[0].baselines[0].alpha).toBeCloseTo(VALIDATION_ALPHA / 2, 12);
  });

  it('no cuenta como contraste un horizonte que se quedó sin anclas', () => {
    const projection = projectWithBacktest(pointsFrom(randomWalk(940, 0.01, 2000, 23)), {
      horizonsMs: [H15, 6 * 60 * 60 * 1000],
    });

    const tested = projection.baselines.filter((b) => b.pValue !== null);
    expect(tested).toHaveLength(1);
    expect(tested[0].familySize).toBe(1);
  });

  it('la misma evidencia deja de bastar cuando la familia crece', () => {
    /*
     * La evidencia no cambia; cambia cuántas veces se ha mirado.
     *
     * Se parte de una proyección validada y se le sustituye el p-valor por uno
     * alcanzable, porque el de la onda sintética es de 1e-10 y la familia que
     * haría falta para tumbarlo tendría cientos de millones de contrastes. Lo
     * que se prueba es la REGLA, no la aritmética de un caso extremo.
     */
    const learnable = projectWithBacktest(pointsFrom(sine(940, 0.4, 25, 2000)), {
      horizonsMs: [H15],
    });
    expect(learnable.usable).toBe(true);

    const weakened = {
      ...learnable,
      baselines: [{ ...learnable.baselines[0], pValue: 0.02 }],
    };

    // Un solo contraste: 0.02 <= 0.05, pasa.
    const alone = decideValidation([weakened]);
    expect(alone[0].baselines[0].alpha).toBeCloseTo(VALIDATION_ALPHA, 12);
    expect(alone[0].usable).toBe(true);

    // Cinco contrastes simultáneos: el umbral baja a 0.01 y 0.02 ya no basta.
    const family = decideValidation(Array.from({ length: 5 }, () => weakened));
    expect(family[0].baselines[0].familySize).toBe(5);
    expect(family[0].baselines[0].alpha).toBeCloseTo(VALIDATION_ALPHA / 5, 12);
    expect(family[0].usable).toBe(false);
    expect(family[0].horizons[0].status).toBe('NO_EDGE');
  });

  it('decideValidation es pura: no toca lo que recibe', () => {
    const original = projectWithBacktest(pointsFrom(sine(940, 0.4, 25, 2000)), {
      horizonsMs: [H15],
    });
    const snapshot = JSON.stringify(original);

    decideValidation([original, original, original]);

    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe('la variante que no bloquea el hilo', () => {
  it('produce EXACTAMENTE el mismo informe que la síncrona', async () => {
    // Dos caminos para el mismo cálculo es la forma más fácil de que se
    // separen sin que nadie lo note. Esto lo impide.
    const points = pointsFrom(randomWalk(940, 0.01, 1600, 13));

    const sync = backtestHorizon(points, H15);
    const async = await backtestHorizonAsync(points, H15);
    expect(JSON.stringify(async)).toBe(JSON.stringify(sync));

    const syncFull = projectWithBacktest(points, { horizonsMs: [H15], now: 0 });
    const asyncFull = await projectWithBacktestAsync(points, { horizonsMs: [H15], now: 0 });
    expect(JSON.stringify(asyncFull)).toBe(JSON.stringify(syncFull));
  });
});
