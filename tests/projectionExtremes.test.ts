/**
 * CASOS EXTREMOS, SÓLO CON DATOS SINTÉTICOS
 * =========================================
 *
 * Ninguna de estas series pretende parecerse al USDT/VES. Son las formas que
 * rompen los motores estadísticos: magnitudes absurdas, saltos sin precedente,
 * horizontes imposibles, series degeneradas. Lo que se exige no es acertar
 * —sobre estas entradas no hay nada que acertar— sino DEGRADAR en lugar de
 * mentir: o se publica algo respaldado por casos reales, o se dice que no.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_ANALOGUES,
  backtestHorizon,
  buildState,
  projectHorizon,
  projectWithBacktest,
  type SeriesPoint,
} from '../server/projection/index.js';
import {
  H15,
  MINUTE,
  T0,
  expectAllFinite,
  pointsFrom,
  randomWalk,
} from './helpers/projectionSeries.js';

const allFinite = (value: unknown) => expectAllFinite(expect as never, value);

describe('magnitudes que desbordarían una implementación ingenua', () => {
  it('la escala del precio no cambia la lectura (escalas exactas)', () => {
    /*
     * El estado se normaliza por el movimiento típico de la propia serie, así
     * que la escala del precio no puede cambiar el resultado. Si lo cambiara,
     * habría un umbral en VES escondido en alguna parte.
     *
     * Se escala por POTENCIAS DE DOS porque en coma flotante binaria eso sólo
     * mueve el exponente: la comparación es exacta y mide la propiedad, no la
     * aritmética.
     */
    const shape = randomWalk(1, 0.001, 1600, 4);

    const tiny = projectHorizon(pointsFrom(shape.map((p) => p * 2 ** -20)), H15);
    const huge = projectHorizon(pointsFrom(shape.map((p) => p * 2 ** 30)), H15);

    expect(tiny.available).toBe(huge.available);
    expect(tiny.probabilityUp).toBe(huge.probabilityUp);
    expect(tiny.probabilityDown).toBe(huge.probabilityDown);
    expect(tiny.direction).toBe(huge.direction);
    expect(tiny.strength).toBe(huge.strength);
    expect(tiny.audit!.analoguesUsed).toBe(huge.audit!.analoguesUsed);
    allFinite(tiny);
    allFinite(huge);
  });

  it('con escalas decimales la lectura se mueve un escalón de la rejilla', () => {
    /*
     * HALLAZGO, no defecto, y conviene tenerlo escrito.
     *
     * Escalando por 1e-5 y 1e9 la serie ya no es exactamente proporcional: los
     * últimos bits difieren y el conjunto de análogos cambia en uno o dos
     * miembros (83 frente a 82). Eso bastó para mover el escenario central de
     * "+2 pasos típicos" a "+0", y con él la etiqueta de ALCISTA a LATERAL.
     *
     * La causa no es el umbral de dirección sino la REJILLA DE PRECIOS: los
     * precios están cuantizados, así que los desenlaces son múltiplos enteros
     * del tick y la mediana sólo puede caer en esos valores. Cambiar un
     * análogo la mueve un escalón completo, nunca un poco.
     *
     * Es un efecto real, no del fixture: Binance publica precios de 0.01 en
     * 0.01. Lo que se exige aquí es lo que sí es estable —la probabilidad, que
     * es un recuento sobre muchos casos— y que la dirección se mueva como
     * mucho a una etiqueta contigua.
     */
    const shape = randomWalk(1, 0.001, 1600, 4);

    const tiny = projectHorizon(pointsFrom(shape.map((p) => p * 0.00001)), H15);
    const huge = projectHorizon(pointsFrom(shape.map((p) => p * 1e9)), H15);

    expect(Math.abs(tiny.probabilityUp! - huge.probabilityUp!)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(tiny.audit!.analoguesUsed - huge.audit!.analoguesUsed)).toBeLessThanOrEqual(3);
    // Contiguas en la escala: nunca ALCISTA frente a BAJISTA.
    expect([tiny.direction, huge.direction].sort()).not.toEqual(['ALCISTA', 'BAJISTA']);
  });

  it('el escenario central cae SIEMPRE sobre la rejilla de precios', () => {
    // Consecuencia directa de lo anterior, y la razón de no interpolar los
    // percentiles: un precio interpolado sería un precio que nunca existió.
    const tick = 0.01;
    const prices = randomWalk(940, tick, 1600, 19);
    const result = projectHorizon(pointsFrom(prices), H15);

    expect(result.available).toBe(true);
    for (const value of [result.central!, result.low!, result.high!]) {
      const steps = value / tick;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
    }
  });

  it('no desborda cerca del máximo representable', () => {
    const result = projectHorizon(pointsFrom(randomWalk(1e300, 1e295, 1600, 6)), H15);

    allFinite(result);
    if (result.available) expect(result.high!).toBeGreaterThanOrEqual(result.low!);
  });

  it('buildState no produce NaN cuando el movimiento típico es cero', () => {
    const state = buildState(pointsFrom(Array(10).fill(940)), 0, 9, 0);
    expect(state).not.toBeNull();
    allFinite(state);
  });
});

describe('regímenes que el histórico nunca contuvo', () => {
  it('ante un salto sin precedente sigue respondiendo con casos reales', () => {
    // Una devaluación de golpe. El método es empírico: no puede prever el
    // salto. Lo que se exige es que no invente nada y que todo siga finito.
    const calm = randomWalk(940, 0.01, 1600, 8);
    const shocked = [...calm.slice(0, 1590), ...calm.slice(1590).map((p) => p * 1.3)];
    const points = pointsFrom(shocked);
    const result = projectHorizon(points, H15);

    allFinite(result);
    if (result.available) {
      const observed = new Set(points.map((p) => p.t));
      for (const sample of result.audit!.samples) expect(observed.has(sample.t)).toBe(true);
      expect(result.audit!.analoguesUsed).toBeGreaterThanOrEqual(MIN_ANALOGUES);
    }
  });

  it('una serie que sólo alterna entre dos precios no produce tendencia', () => {
    const flipflop = pointsFrom(
      Array.from({ length: 1600 }, (_, i) => (i % 2 === 0 ? 940 : 941))
    );
    const result = projectHorizon(flipflop, H15);

    allFinite(result);
    if (result.available) {
      expect(['LATERAL', 'INDETERMINADA']).toContain(result.direction);
    }
  });

  it('una serie literalmente constante no inventa movimiento', () => {
    const flat = projectHorizon(pointsFrom(Array(1600).fill(940)), H15);

    allFinite(flat);
    if (flat.available) {
      expect(flat.central).toBe(940);
      expect(flat.low).toBe(940);
      expect(flat.high).toBe(940);
      expect(flat.probabilityFlat).toBe(1);
    }
  });
});

describe('horizontes imposibles', () => {
  it('cero, negativo, NaN e Infinity se rechazan por igual', () => {
    for (const horizon of [0, -H15, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = projectHorizon(pointsFrom(randomWalk(940, 0.01, 1600, 3)), horizon);
      expect(result.status).toBe('INSUFFICIENT_DATA');
      allFinite(result);
    }
  });

  it('un horizonte más largo que toda la historia dice INSUFFICIENT_DATA', () => {
    const result = projectHorizon(
      pointsFrom(randomWalk(940, 0.01, 1600, 3)),
      365 * 24 * 3600 * 1000
    );

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.central).toBeNull();
  });

  it('el backtest tampoco lanza con horizontes degenerados', () => {
    for (const horizon of [0, -H15, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      const baseline = backtestHorizon(pointsFrom(randomWalk(940, 0.01, 1600, 3)), horizon);
      allFinite(baseline);
      expect(baseline.anchors).toBe(0);
      expect(baseline.reason).toBe('INSUFFICIENT_ANCHORS');
    }
  });
});

describe('series degeneradas', () => {
  it('sobrevive a una serie entera de timestamps idénticos', () => {
    const same = Array.from({ length: 500 }, (_, i) => ({ t: T0, price: 940 + i * 0.01 }));
    const projection = projectWithBacktest(same, { horizonsMs: [H15] });

    allFinite(projection);
    // Todos comparten instante: queda una sola observación, no 500.
    expect(projection.observations).toBe(1);
    expect(projection.usable).toBe(false);
  });

  it('sobrevive a una cadencia irregular extrema', () => {
    const erratic: SeriesPoint[] = Array.from({ length: 1600 }, (_, i) => ({
      t: T0 + i * MINUTE * (1 + (i % 7)),
      price: 940 + Math.sin(i) * 0.05,
    }));
    const projection = projectWithBacktest(erratic, { horizonsMs: [H15] });

    allFinite(projection);
    expect(projection.medianIntervalMs!).toBeGreaterThan(0);
  });

  it('con dos observaciones no hay nada que sostener', () => {
    const projection = projectWithBacktest(pointsFrom([940, 941]), { horizonsMs: [H15] });

    allFinite(projection);
    expect(projection.horizons[0].status).toBe('INSUFFICIENT_DATA');
    expect(projection.usable).toBe(false);
    expect(projection.notice).toContain('INSUFICIENTE HISTÓRICO');
  });

  it('con histórico vacío devuelve estado, no excepción', () => {
    const projection = projectWithBacktest([], { horizonsMs: [H15] });

    allFinite(projection);
    expect(projection.observations).toBe(0);
    expect(projection.currentPrice).toBeNull();
    expect(projection.horizons[0].status).toBe('INSUFFICIENT_DATA');
  });

  it('entrada hostil: NaN, Infinity, negativos, cero, desorden y duplicados', () => {
    const hostile: SeriesPoint[] = [
      ...pointsFrom(randomWalk(940, 0.01, 1600, 31)),
      { t: T0 + 5 * MINUTE, price: Number.NaN },
      { t: T0 + 6 * MINUTE, price: Number.POSITIVE_INFINITY },
      { t: T0 + 7 * MINUTE, price: -940 },
      { t: T0 + 8 * MINUTE, price: 0 },
      { t: Number.NaN, price: 940 },
      { t: T0 + 9 * MINUTE, price: 941 },
      { t: T0 + 9 * MINUTE, price: 942 },
    ];

    const projection = projectWithBacktest(hostile, { horizonsMs: [H15] });
    allFinite(projection);
    expect(projection.history.every((p) => Number.isFinite(p.price) && p.price > 0)).toBe(true);
  });

  it('una serie enorme sigue acotando lo que publica', () => {
    const big = projectHorizon(pointsFrom(randomWalk(940, 0.01, 20_000, 12)), H15);

    expect(big.available).toBe(true);
    expect(big.audit!.analoguesUsed).toBeLessThanOrEqual(100);
    expect(big.audit!.candidatePool).toBeGreaterThan(19_000);
    allFinite(big);
  });
});

describe('varias semillas, mismo contrato', () => {
  it('ninguna de treinta series aleatorias produce un número no finito', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const projection = projectHorizon(pointsFrom(randomWalk(940, 0.01, 1200, seed)), H15);
      allFinite(projection);
      if (projection.available) {
        expect(projection.high!).toBeGreaterThanOrEqual(projection.low!);
        const sum =
          (projection.probabilityUp ?? 0) +
          (projection.probabilityFlat ?? 0) +
          (projection.probabilityDown ?? 0);
        // Las tres se redondean por separado, así que la suma puede desviarse
        // como mucho medio punto por término.
        expect(Math.abs(sum - 1)).toBeLessThanOrEqual(0.015);
      }
    }
  });
});
