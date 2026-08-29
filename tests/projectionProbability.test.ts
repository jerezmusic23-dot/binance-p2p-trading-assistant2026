/**
 * PROBABILIDADES QUE SON RECUENTOS, Y CALIBRACIÓN
 * ===============================================
 *
 * Aquí se comprueba que ningún porcentaje del sistema pueda salir de otro
 * sitio que no sea una división de dos enteros, que la precisión publicada no
 * supere a la que la muestra sostiene, y que el sistema sepa detectar cuándo
 * él mismo se pasa de confiado.
 */

import { describe, expect, it } from 'vitest';
import {
  CHANCE_LEVEL,
  MIN_SCENARIO_CASES,
  binomialTailProbability,
  buildScenarios,
  calibrate,
  classifyOutcome,
  roundProbability,
  wilsonInterval,
  type Analogue,
} from '../server/projection/index.js';
import { T0, rng } from './helpers/projectionSeries.js';

const analogue = (delta: number, i = 0): Analogue => ({
  index: i,
  t: T0 + i * 60_000,
  price: 940,
  delta,
  distance: 0,
});

describe('el contraste exacto', () => {
  it('es el binomial, no la aproximación normal', () => {
    // 9 casos, los 9 a favor: 1/2^9. La normal necesitaría un mínimo de casos
    // para ser válida; el exacto no, y por eso puede decidir con las pocas
    // decenas de anclas que hay.
    expect(binomialTailProbability(9, 9)).toBeCloseTo(1 / 512, 12);
    expect(binomialTailProbability(5, 10)).toBeCloseTo(0.623046875, 12);
    expect(binomialTailProbability(0, 10)).toBe(1);
    expect(binomialTailProbability(11, 10)).toBe(0);
    expect(binomialTailProbability(1, 0)).toBe(1);
    expect(binomialTailProbability(Number.NaN, 10)).toBe(1);
  });

  it('fija la mayoría que hace falta a cada número de anclas', () => {
    /*
     * Ésta es la derivación que decide el tope de anclas del backtest, y va
     * aquí para que no se pueda cambiar el tope sin ver qué le pasa al listón.
     * Con el umbral corregido rondando 0.005, la mayoría exigida es:
     *
     *   29 de 40 = 73%      41 de 60 = 68%      52 de 80 = 65%
     *
     * De 40 a 60 se ganan cinco puntos; de 60 a 80, tres, a cambio de un
     * tercio más de tiempo de cálculo. Por eso el tope está en 60.
     */
    expect(binomialTailProbability(29, 40)).toBeLessThan(0.005);
    expect(binomialTailProbability(28, 40)).toBeGreaterThan(0.005);

    expect(binomialTailProbability(41, 60)).toBeLessThan(0.005);
    expect(binomialTailProbability(40, 60)).toBeGreaterThan(0.005);

    expect(binomialTailProbability(52, 80)).toBeLessThan(0.005);
    expect(binomialTailProbability(51, 80)).toBeGreaterThan(0.005);
  });
});

describe('el intervalo de Wilson', () => {
  it('se estrecha al crecer la muestra y nunca se sale de [0,1]', () => {
    const small = wilsonInterval(20, 40);
    const large = wilsonInterval(200, 400);

    expect(small.high! - small.low!).toBeGreaterThan(large.high! - large.low!);
    for (const bound of [small.low!, small.high!, large.low!, large.high!]) {
      expect(bound).toBeGreaterThanOrEqual(0);
      expect(bound).toBeLessThanOrEqual(1);
    }
  });

  it('en los extremos no promete imposibles', () => {
    const all = wilsonInterval(40, 40);
    expect(all.high).toBeLessThanOrEqual(1);
    expect(all.low).toBeLessThan(1);
    expect(wilsonInterval(0, 0).low).toBeNull();
  });
});

describe('la precisión publicada', () => {
  it('no inventa decimales que la muestra no sostiene', () => {
    // 0.7384291... sobre 40 casos: el error estándar ronda los 8 puntos, así
    // que publicar cuatro decimales sería falso.
    expect(roundProbability(0.7384291, 40)).toBe(0.74);
    expect(roundProbability(0.7384291, 100)).toBe(0.74);
    // Con 400 o más casos el error baja de 2.5 puntos y cabe un decimal más.
    expect(roundProbability(0.7384291, 400)).toBe(0.738);
  });

  it('lo no finito no se redondea, se descarta', () => {
    expect(roundProbability(Number.NaN, 40)).toBeNull();
    expect(roundProbability(null, 40)).toBeNull();
    expect(roundProbability(Number.POSITIVE_INFINITY, 40)).toBeNull();
  });
});

describe('el desenlace se juzga contra el régimen', () => {
  it('superar la deriva estructural es subir; acompañarla no lo es', () => {
    expect(classifyOutcome(1.5, 1.0, 0.4)).toBe('UP');
    expect(classifyOutcome(1.3, 1.0, 0.4)).toBe('FLAT');
    expect(classifyOutcome(0.5, 1.0, 0.4)).toBe('DOWN');
  });

  it('contra cero, un mercado que se deprecia sería alcista siempre', () => {
    // Los mismos tres desenlaces medidos contra cero: los tres "suben".
    expect(classifyOutcome(1.5, 0, 0.4)).toBe('UP');
    expect(classifyOutcome(1.3, 0, 0.4)).toBe('UP');
    expect(classifyOutcome(0.5, 0, 0.4)).toBe('UP');
  });
});

describe('los tres escenarios', () => {
  const analogues = [
    ...Array.from({ length: 20 }, (_, i) => analogue(2 + i * 0.01, i)),
    ...Array.from({ length: 15 }, (_, i) => analogue(0, 100 + i)),
    ...Array.from({ length: 15 }, (_, i) => analogue(-2 - i * 0.01, 200 + i)),
  ];
  const scenarios = buildScenarios(analogues, 940, 0, 0.5);

  it('son grupos disjuntos: sus probabilidades suman 1 por construcción', () => {
    expect(scenarios.map((s) => s.kind)).toEqual(['BAJISTA', 'CENTRAL', 'ALCISTA']);
    expect(scenarios.reduce((acc, s) => acc + s.cases, 0)).toBe(analogues.length);
    expect(scenarios.reduce((acc, s) => acc + s.probability, 0)).toBeCloseTo(1, 6);
  });

  it('cada escenario lleva su recuento y su intervalo', () => {
    const bull = scenarios.find((s) => s.kind === 'ALCISTA')!;
    expect(bull.cases).toBe(20);
    expect(bull.probability).toBe(roundProbability(20 / 50, 50));
    expect(bull.probabilityLow!).toBeLessThanOrEqual(bull.probability);
    expect(bull.probabilityHigh!).toBeGreaterThanOrEqual(bull.probability);
  });

  it('los rangos se expresan en precio, ordenados de bajista a alcista', () => {
    const [bear, base, bull] = scenarios;
    expect(bear.high!).toBeLessThan(base.low!);
    expect(base.high!).toBeLessThan(bull.low!);
  });

  it('un grupo pequeño conserva su probabilidad pero NO recibe rango', () => {
    // Con menos de MIN_SCENARIO_CASES los percentiles 10 y 90 serían el mínimo
    // y el máximo del grupo: dos observaciones sueltas disfrazadas de banda.
    const few = [
      ...Array.from({ length: 40 }, (_, i) => analogue(0, i)),
      ...Array.from({ length: 3 }, (_, i) => analogue(5, 100 + i)),
    ];
    const built = buildScenarios(few, 940, 0, 0.5);
    const bull = built.find((s) => s.kind === 'ALCISTA')!;

    expect(bull.cases).toBe(3);
    expect(bull.cases).toBeLessThan(MIN_SCENARIO_CASES);
    expect(bull.probability).toBeGreaterThan(0);
    expect(bull.hasRange).toBe(false);
    expect(bull.low).toBeNull();
    expect(bull.high).toBeNull();
  });

  it('sin análogos no hay escenarios con probabilidad', () => {
    for (const s of buildScenarios([], 940, 0, 0.5)) {
      expect(s.cases).toBe(0);
      expect(s.probability).toBe(0);
      expect(s.hasRange).toBe(false);
    }
  });
});

describe('el nivel de azar', () => {
  it('con tres desenlaces excluyentes es un tercio, no un umbral elegido', () => {
    expect(CHANCE_LEVEL).toBeCloseTo(1 / 3, 12);
  });
});

describe('la calibración', () => {
  it('un predictor honesto no sale marcado', () => {
    // Se anuncia 0.7 y ocurre el 70% de las veces.
    const rnd = rng(3);
    const samples = Array.from({ length: 400 }, () => ({
      predicted: 0.7,
      occurred: rnd() < 0.7,
    }));
    const report = calibrate(samples);

    expect(report.overconfident).toBe(false);
    expect(report.predictions).toBe(400);
    const bucket = report.buckets.find((b) => b.from === 0.7)!;
    expect(bucket.observedFrequency!).toBeGreaterThan(0.6);
    expect(bucket.observedFrequency!).toBeLessThan(0.8);
  });

  it('detecta al que promete 90% y acierta la mitad', () => {
    const rnd = rng(4);
    const report = calibrate(
      Array.from({ length: 300 }, () => ({ predicted: 0.9, occurred: rnd() < 0.5 }))
    );

    expect(report.overconfident).toBe(true);
    expect(report.worstOverconfidence!).toBeGreaterThan(0.3);
    expect(report.buckets.find((b) => b.from === 0.9)!.overconfident).toBe(true);
  });

  it('no marca exceso de confianza cuando el bucket tiene demasiado pocos casos', () => {
    // Dos predicciones no distinguen un modelo confiado de la mala suerte: el
    // margen del bucket es enorme y absorbe la diferencia.
    const report = calibrate([
      { predicted: 0.9, occurred: false },
      { predicted: 0.9, occurred: true },
    ]);
    expect(report.buckets.find((b) => b.from === 0.9)!.overconfident).toBe(false);
  });

  it('el Brier compara contra predecir siempre la frecuencia base', () => {
    // Un predictor que sólo repite la frecuencia base no aporta información
    // sobre el caso concreto: su Brier iguala al de la climatología.
    const flat = calibrate(
      Array.from({ length: 100 }, (_, i) => ({ predicted: 0.5, occurred: i % 2 === 0 }))
    );
    expect(flat.brier).toBeCloseTo(flat.brierBaseline!, 10);

    // Uno que acierta a ciegas lo baja.
    const perfect = calibrate(
      Array.from({ length: 100 }, (_, i) => ({ predicted: i % 2 === 0 ? 1 : 0, occurred: i % 2 === 0 }))
    );
    expect(perfect.brier).toBe(0);
    expect(perfect.brierBaseline!).toBeGreaterThan(0);
  });

  it('sin predicciones no inventa un informe', () => {
    const report = calibrate([]);
    expect(report.predictions).toBe(0);
    expect(report.brier).toBeNull();
    expect(report.overconfident).toBe(false);
  });

  it('descarta probabilidades imposibles en lugar de propagarlas', () => {
    const report = calibrate([
      { predicted: Number.NaN, occurred: true },
      { predicted: 1.4, occurred: true },
      { predicted: -0.2, occurred: false },
      { predicted: 0.5, occurred: true },
    ]);
    expect(report.predictions).toBe(1);
  });
});
