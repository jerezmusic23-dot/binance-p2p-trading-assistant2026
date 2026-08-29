/**
 * EL MOTOR: EVIDENCIA, DIRECCIÓN, FUERZA Y ESTADO
 * ===============================================
 *
 * Lo que estas pruebas protegen no es que el motor acierte —sobre fixtures
 * sintéticos no hay nada que acertar— sino las cuatro cosas que lo separan de
 * una caja negra:
 *
 *   1. Toda probabilidad es un recuento de casos concretos, y esos casos están
 *      en el audit trail con su fecha.
 *   2. La dirección se mide contra la deriva estructural, no contra cero.
 *   3. Sin evidencia se publica un ESTADO, nunca un número inventado.
 *   4. Ningún análogo puede usar información posterior a su propia ancla.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HORIZONS_MS,
  MIN_ANALOGUES,
  gradeDirection,
  gradeStrength,
  hasSignal,
  minimumLengthFor,
  projectHorizon,
  projectWithBacktest,
} from '../server/projection/index.js';
import {
  H15,
  H30,
  MINUTE,
  accelerating,
  decelerating,
  pointsFrom,
  ramp,
  randomWalk,
  reversal,
} from './helpers/projectionSeries.js';

describe('sin evidencia se publica un estado, no un número', () => {
  it('un horizonte más largo que el histórico dice INSUFFICIENT_DATA', () => {
    const short = projectHorizon(pointsFrom(ramp(940, 0.01, 100)), H30);

    expect(short.status).toBe('INSUFFICIENT_DATA');
    expect(short.available).toBe(false);
    expect(short.statusText).toContain('INSUFICIENTE HISTÓRICO');
    expect(short.central).toBeNull();
    expect(short.probabilityUp).toBeNull();
    expect(short.direction).toBeNull();
    expect(short.scenarios).toEqual([]);
    expect(short.audit).toBeNull();
  });

  it('una observación menos de las que el suelo exige ya no basta', () => {
    const steps = 15;
    const justUnder = minimumLengthFor(steps, steps) - 1;
    const result = projectHorizon(pointsFrom(randomWalk(940, 0.01, justUnder, 7)), H15);

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.available).toBe(false);
  });

  it('un horizonte de cero o negativo se rechaza, no se redondea a un paso', () => {
    for (const horizon of [0, -H15, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = projectHorizon(pointsFrom(randomWalk(940, 0.01, 1200, 3)), horizon);
      expect(result.status).toBe('INSUFFICIENT_DATA');
      expect(result.central).toBeNull();
      expect(Number.isFinite(result.requestedHorizonMs)).toBe(true);
    }
  });

  it('los horizontes largos aparecen SOLOS cuando el histórico llega', () => {
    // Nada se configura a mano: el mismo motor, con más serie, publica más
    // horizontes. Con 1.200 observaciones sólo +15 min es posible.
    const shortHistory = projectWithBacktest(pointsFrom(randomWalk(940, 0.01, 1200, 5)));
    const available = shortHistory.horizons.filter((h) => h.available).map((h) => h.label);

    expect(shortHistory.horizons).toHaveLength(DEFAULT_HORIZONS_MS.length);
    expect(available).toEqual(['+15 min']);
    for (const horizon of shortHistory.horizons.filter((h) => !h.available)) {
      expect(horizon.status).toBe('INSUFFICIENT_DATA');
      expect(horizon.central).toBeNull();
    }
  });
});

describe('la probabilidad es un recuento de casos reales', () => {
  const points = pointsFrom(randomWalk(940, 0.01, 1600, 11));
  const result = projectHorizon(points, H15);

  it('produce una proyección con este histórico', () => {
    expect(result.available).toBe(true);
    expect(result.audit).not.toBeNull();
    expect(result.audit!.analoguesUsed).toBeGreaterThanOrEqual(MIN_ANALOGUES);
  });

  it('la fracción publicada es casos_favorables / casos_totales', () => {
    const audit = result.audit!;
    const n = audit.analoguesUsed;

    expect(audit.upCount + audit.flatCount + audit.downCount).toBe(n);
    expect(result.probabilityUp).toBe(Number((audit.upCount / n).toFixed(2)));
    expect(result.probabilityFlat).toBe(Number((audit.flatCount / n).toFixed(2)));
    expect(result.probabilityDown).toBe(Number((audit.downCount / n).toFixed(2)));
  });

  it('adjunta los casos concretos, y todos ocurrieron de verdad', () => {
    const audit = result.audit!;
    const observed = new Map(points.map((p) => [p.t, p.price]));

    expect(audit.samples).toHaveLength(audit.analoguesUsed);
    expect(audit.samples.filter((s) => s.outcome === 'UP')).toHaveLength(audit.upCount);
    for (const sample of audit.samples) {
      expect(observed.get(sample.t)).toBe(sample.price);
    }
  });

  it('la frase publicada dice los dos términos de la división', () => {
    const audit = result.audit!;
    expect(result.evidence).toBe(
      `En situaciones históricas similares, ${audit.upCount} de ${audit.analoguesUsed} casos ` +
        `terminaron por encima del precio actual a +15 min.`
    );
  });

  it('SIN LEAKAGE: ningún análogo depende de un futuro que aún no ocurrió', () => {
    const audit = result.audit!;
    // El desenlace de un análogo se observa horizonSteps más tarde, así que
    // ningún ancla puede estar después del último instante cuyo futuro ya está
    // dentro de la serie.
    const latestUsable = points[points.length - 1 - audit.horizonSteps].t;
    for (const sample of audit.samples) {
      expect(sample.t).toBeLessThanOrEqual(latestUsable);
    }
  });

  it('SIN LEAKAGE: añadir futuro no cambia lo que se proyectó en el pasado', () => {
    // La prueba directa de que el motor no mira hacia adelante: se proyecta
    // sobre un prefijo, se le añade a la serie un tramo salvaje, y se vuelve a
    // proyectar sobre EL MISMO prefijo. Si algo del futuro se colara por
    // cualquier vía —régimen, paso típico, escalas— los dos diferirían.
    const prefix = points.slice(0, 1300);
    const before = projectHorizon(prefix, H15);

    const wild = [...points];
    for (let i = 1300; i < wild.length; i += 1) {
      wild[i] = { ...wild[i], price: wild[i].price * (1 + (i % 7) * 0.05) };
    }
    const after = projectHorizon(wild.slice(0, 1300), H15);

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('los análogos no se solapan entre sí: son situaciones distintas', () => {
    const audit = result.audit!;
    expect(audit.independentAnalogues).toBe(audit.analoguesUsed);

    const times = audit.samples.map((s) => s.t).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(
        audit.horizonSteps * (audit.medianIntervalMs as number)
      );
    }
  });

  it('k está topado y epsilon es su consecuencia, no un umbral elegido', () => {
    const audit = result.audit!;
    expect(audit.analoguesUsed).toBeLessThanOrEqual(100);
    expect(audit.candidatePool).toBeGreaterThan(audit.analoguesUsed);
    expect(audit.maxDistanceUsed).toBeGreaterThanOrEqual(0);
  });

  it('los escenarios reparten exactamente esos mismos casos', () => {
    const audit = result.audit!;
    const byKind = Object.fromEntries(result.scenarios.map((s) => [s.kind, s.cases]));

    expect(byKind.ALCISTA).toBe(audit.upCount);
    expect(byKind.CENTRAL).toBe(audit.flatCount);
    expect(byKind.BAJISTA).toBe(audit.downCount);
  });
});

describe('la dirección se mide contra el régimen, no contra cero', () => {
  it('una deriva estructural constante NO es una tendencia alcista', () => {
    // El VES se deprecia. Esta serie sube en cada observación, así que un
    // modelo que definiera "sube" como "delta > 0" diría 100% ALCISTA.
    const projection = projectHorizon(pointsFrom(ramp(940, 0.02, 1200)), H15);

    expect(projection.available).toBe(true);
    expect(projection.audit!.regimeDelta).toBeCloseTo(15 * 0.02, 6);
    expect(projection.probabilityUp).toBe(0);
    expect(projection.probabilityFlat).toBe(1);
    expect(projection.direction).toBe('LATERAL');
  });

  it('el escenario central sí recoge la deriva, aunque la dirección sea LATERAL', () => {
    const projection = projectHorizon(pointsFrom(ramp(940, 0.02, 1200)), H15);

    // Subir con el mercado no es "subir"; el precio proyectado sí sube.
    expect(projection.central! - projection.currentPrice!).toBeCloseTo(15 * 0.02, 6);
  });

  it('una serie claramente bajista se lee como tal', () => {
    // Bajada constante con ruido encima: el régimen es la bajada, y lo que se
    // clasifica es apartarse de ella.
    const rnd = randomWalk(0, 0.01, 1600, 21);
    const prices = ramp(1200, -0.03, 1600).map((p, i) => Number((p + rnd[i]).toFixed(6)));
    const projection = projectHorizon(pointsFrom(prices), H15);

    expect(projection.available).toBe(true);
    expect(projection.audit!.regimeDelta!).toBeLessThan(0);
    expect(projection.central!).toBeLessThan(projection.currentPrice!);
  });
});

describe('dirección y fuerza como funciones puras', () => {
  it('sin señal la dirección es INDETERMINADA, no una inventada', () => {
    // Tres desenlaces repartidos casi por igual: ninguno destaca del azar.
    expect(hasSignal({ UP: 34, FLAT: 33, DOWN: 33 }, 100)).toBe(false);
    expect(gradeDirection(5, 0.1, false)).toBe('INDETERMINADA');

    // Uno claramente dominante sí destaca.
    expect(hasSignal({ UP: 70, FLAT: 20, DOWN: 10 }, 100)).toBe(true);
    expect(gradeDirection(5, 0.1, true)).toBe('ALCISTA');
  });

  it('dentro del ruido de la serie es LATERAL aunque haya señal', () => {
    expect(gradeDirection(0.05, 0.1, true)).toBe('LATERAL');
    expect(gradeDirection(-0.05, 0.1, true)).toBe('LATERAL');
    expect(gradeDirection(-5, 0.1, true)).toBe('BAJISTA');
  });

  it('la fuerza son los quintiles de lo que ESTE mercado hace, no umbrales en VES', () => {
    const historical = Array.from({ length: 100 }, (_, i) => i * 0.1);
    const step = 0.01;

    expect(gradeStrength(0.5, step, historical)).toBe('MUY_DEBIL');
    expect(gradeStrength(2.5, step, historical)).toBe('DEBIL');
    expect(gradeStrength(4.5, step, historical)).toBe('MODERADA');
    expect(gradeStrength(6.5, step, historical)).toBe('FUERTE');
    expect(gradeStrength(9.5, step, historical)).toBe('MUY_FUERTE');
  });

  it('la misma cifra en VES cambia de fuerza según el mercado', () => {
    // 0.5 VES es enorme en un mercado quieto y ridículo en uno agitado. Un
    // umbral fijo en VES sería correcto para un mercado y falso para el otro.
    const calm = Array.from({ length: 100 }, (_, i) => i * 0.001);
    const wild = Array.from({ length: 100 }, (_, i) => i * 0.5);

    expect(gradeStrength(0.5, 0.001, calm)).toBe('MUY_FUERTE');
    expect(gradeStrength(0.5, 0.001, wild)).toBe('MUY_DEBIL');
  });

  it('por debajo del movimiento típico no hay nada que graduar', () => {
    const historical = Array.from({ length: 100 }, (_, i) => i * 0.1);
    expect(gradeStrength(0.005, 0.01, historical)).toBe('MUY_DEBIL');
  });
});

describe('formas de tendencia reconocibles', () => {
  const shapes = {
    alcista: ramp(940, 0.03, 1600),
    bajista: ramp(1000, -0.03, 1600),
    lateral: randomWalk(940, 0.01, 1600, 33),
    reversion: reversal(940, 0.03, 1600),
    aceleracion: accelerating(940, 0.02, 1600),
    desaceleracion: decelerating(940, 0.02, 1600),
  };

  for (const [name, prices] of Object.entries(shapes)) {
    it(`no lanza ni produce basura sobre una serie ${name}`, () => {
      const projection = projectHorizon(pointsFrom(prices), H15);

      for (const value of [
        projection.central,
        projection.low,
        projection.high,
        projection.probabilityUp,
      ]) {
        expect(value === null || Number.isFinite(value)).toBe(true);
      }
      if (projection.available) {
        expect(projection.high!).toBeGreaterThanOrEqual(projection.low!);
        expect(projection.scenarios).toHaveLength(3);
        expect(projection.estimatedAt).toBe(
          pointsFrom(prices)[prices.length - 1].t + H15
        );
      }
    });
  }

  it('en una rampa perfecta el rango probable no puede ser negativo', () => {
    const projection = projectHorizon(pointsFrom(shapes.alcista), H15);
    expect(projection.high! - projection.low!).toBeGreaterThanOrEqual(0);
  });
});

describe('la hora estimada', () => {
  it('apunta al instante del horizonte, no a un momento inventado', () => {
    const points = pointsFrom(randomWalk(940, 0.01, 1600, 11));
    const last = points[points.length - 1].t;

    const projection = projectHorizon(points, H15);
    expect(projection.estimatedAt).toBe(last + 15 * MINUTE);
  });
});
