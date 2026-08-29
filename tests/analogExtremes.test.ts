/**
 * CASOS EXTREMOS, SÓLO CON DATOS SINTÉTICOS
 * =========================================
 *
 * Ninguna de estas series pretende parecerse al USDT/VES. Son las formas que
 * rompen los motores estadísticos: magnitudes absurdas, saltos sin precedente,
 * horizontes imposibles, series degeneradas. Lo que se exige aquí no es que el
 * motor acierte —sobre estas entradas no hay nada que acertar— sino que
 * DEGRADE en lugar de mentir: o publica algo respaldado por casos reales, o
 * dice que no puede.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_ANALOGUES,
  backtestHorizon,
  projectByAnalogy,
  projectHorizon,
  stateOf,
  type AnalogPoint,
} from '../server/analogProjection.js';

const T0 = Date.UTC(2026, 7, 1, 12, 0, 0);
const MINUTE = 60_000;
const H30 = 30 * MINUTE;

const seriesFrom = (prices: readonly number[], stepMs = MINUTE): AnalogPoint[] =>
  prices.map((price, i) => ({ t: T0 + i * stepMs, price }));

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomWalk(base: number, tick: number, count: number, seed: number): number[] {
  const rnd = mulberry32(seed);
  const out: number[] = [];
  let price = base;
  for (let i = 0; i < count; i += 1) {
    out.push(price);
    price += (rnd() < 0.5 ? -1 : 1) * tick;
  }
  return out;
}

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

describe('magnitudes que desbordarían una implementación ingenua', () => {
  it('proyecta igual de bien un precio de 0.00001 que uno de 1e9', () => {
    // El estado se normaliza por el paso típico de la propia serie, así que la
    // escala del precio no puede cambiar el resultado. Si cambiara, habría un
    // umbral en VES escondido en alguna parte.
    const shape = randomWalk(1, 0.001, 1600, 4);

    const tiny = projectHorizon(
      seriesFrom(shape.map((p) => p * 0.00001)),
      H30
    );
    const huge = projectHorizon(
      seriesFrom(shape.map((p) => p * 1e9)),
      H30
    );

    expect(tiny.available).toBe(huge.available);
    expect(tiny.probabilityUp).toBeCloseTo(huge.probabilityUp!, 10);
    expect(tiny.direction).toBe(huge.direction);
    assertAllFinite(tiny);
    assertAllFinite(huge);
  });

  it('no desborda con precios cercanos al máximo representable', () => {
    const series = seriesFrom(randomWalk(1e300, 1e295, 1600, 6));
    const result = projectHorizon(series, H30);

    assertAllFinite(result);
    if (result.available) {
      expect(Number.isFinite(result.central!)).toBe(true);
      expect(result.high!).toBeGreaterThanOrEqual(result.low!);
    }
  });

  it('stateOf no produce NaN cuando el paso típico es cero', () => {
    const flat = seriesFrom([940, 940, 940, 940, 940]);
    const state = stateOf(flat, 0, 4, 0);

    expect(state).not.toBeNull();
    assertAllFinite(state);
    expect(state!.position).toBe(0.5);
  });
});

describe('regímenes que el histórico nunca contuvo', () => {
  it('ante un salto sin precedente sigue respondiendo con casos reales', () => {
    // Una devaluación de golpe: 1600 observaciones tranquilas y un salto del
    // 30% al final. El método es empírico, así que no puede "prever" el salto;
    // lo que se exige es que no invente nada y que todo siga siendo finito.
    const calm = randomWalk(940, 0.01, 1600, 8);
    const shocked = [...calm.slice(0, 1590), ...calm.slice(1590).map((p) => p * 1.3)];
    const result = projectHorizon(seriesFrom(shocked), H30);

    assertAllFinite(result);
    if (result.available) {
      // Cada caso publicado ocurrió de verdad y está en la serie.
      const observed = new Set(seriesFrom(shocked).map((p) => p.t));
      for (const sample of result.audit!.samples) {
        expect(observed.has(sample.t)).toBe(true);
      }
      expect(result.audit!.analoguesUsed).toBeGreaterThanOrEqual(MIN_ANALOGUES);
    }
  });

  it('una serie que sólo alterna entre dos precios no produce una tendencia', () => {
    const flipflop = seriesFrom(
      Array.from({ length: 1600 }, (_, i) => (i % 2 === 0 ? 940 : 941))
    );
    const result = projectHorizon(flipflop, H30);

    assertAllFinite(result);
    if (result.available) {
      // El movimiento a 30 pasos es siempre 0 (par) o ±1 (impar). Ninguna
      // dirección puede destacar sobre el régimen.
      expect(result.direction).toBe('LATERAL');
    }
  });
});

describe('horizontes imposibles', () => {
  it('un horizonte de 0 ms se rechaza en lugar de redondearse a un paso', () => {
    for (const horizon of [0, -H30, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = projectHorizon(seriesFrom(randomWalk(940, 0.01, 1600, 3)), horizon);

      expect(result.available).toBe(false);
      expect(result.reason).toBe('INVALID_HORIZON');
      expect(result.central).toBeNull();
    }
  });

  it('un horizonte más largo que toda la historia dice INSUFICIENTE HISTÓRICO', () => {
    const result = projectHorizon(
      seriesFrom(randomWalk(940, 0.01, 1600, 3)),
      365 * 24 * 3600 * 1000
    );

    expect(result.available).toBe(false);
    expect(result.reasonText).toContain('INSUFICIENTE HISTÓRICO');
    expect(result.central).toBeNull();
  });

  it('el backtest tampoco lanza con horizontes degenerados', () => {
    for (const horizon of [0, -H30, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      const baseline = backtestHorizon(seriesFrom(randomWalk(940, 0.01, 1600, 3)), horizon);
      assertAllFinite(baseline);
      expect(baseline.anchors).toBe(0);
      expect(baseline.reason).toBe('INSUFFICIENT_ANCHORS');
    }
  });
});

describe('series degeneradas', () => {
  it('sobrevive a una serie entera de timestamps idénticos', () => {
    const same = Array.from({ length: 500 }, (_, i) => ({ t: T0, price: 940 + i * 0.01 }));
    const projection = projectByAnalogy(same, { horizonsMs: [H30] });

    assertAllFinite(projection);
    // Todos comparten instante: queda una sola observación, no 500.
    expect(projection.observations).toBe(1);
    expect(projection.usable).toBe(false);
  });

  it('sobrevive a una cadencia irregular extrema', () => {
    const erratic = Array.from({ length: 1600 }, (_, i) => ({
      t: T0 + i * MINUTE * (1 + (i % 7)),
      price: 940 + Math.sin(i) * 0.05,
    }));
    const projection = projectByAnalogy(erratic, { horizonsMs: [H30] });

    assertAllFinite(projection);
    expect(projection.medianIntervalMs).toBeGreaterThan(0);
  });

  it('con dos observaciones no hay ni cadencia que sostenga nada', () => {
    const projection = projectByAnalogy(seriesFrom([940, 941]), { horizonsMs: [H30] });

    assertAllFinite(projection);
    expect(projection.horizons[0].available).toBe(false);
    expect(projection.usable).toBe(false);
    expect(projection.notice).toContain('INSUFICIENTE HISTÓRICO');
  });

  it('una serie enorme sigue acotando lo que publica', () => {
    // 20.000 observaciones: los análogos siguen topados y la respuesta acotada.
    const big = projectHorizon(seriesFrom(randomWalk(940, 0.01, 20_000, 12)), H30);

    expect(big.available).toBe(true);
    expect(big.audit!.analoguesUsed).toBeLessThanOrEqual(100);
    expect(big.audit!.candidatePool).toBeGreaterThan(19_000);
    assertAllFinite(big);
  });
});
