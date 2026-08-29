/**
 * LA SERIE, SUS UNIDADES Y EL ESTADO DEL MERCADO
 * =============================================
 *
 * Las piezas de más abajo del motor. Si `typicalStep` o `buildState` se
 * equivocan, todo lo que hay encima produce números perfectamente formados y
 * completamente falsos, sin que ninguna prueba estadística lo note.
 *
 * Series SINTÉTICAS. No dicen nada sobre el mercado real.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_LOOKBACK_STEPS,
  buildState,
  gapFree,
  lookbackFor,
  medianIntervalMs,
  percentileOf,
  sanitiseSeries,
  stateDistance,
  stateScales,
  typicalStep,
} from '../server/projection/index.js';
import {
  MINUTE,
  T0,
  accelerating,
  decelerating,
  pointsFrom,
  ramp,
  reversal,
} from './helpers/projectionSeries.js';

describe('limpieza de la serie', () => {
  it('ordena, descarta lo no finito y colapsa timestamps repetidos', () => {
    const cleaned = sanitiseSeries([
      { t: T0 + 2 * MINUTE, price: 942 },
      { t: T0, price: 940 },
      { t: T0 + MINUTE, price: Number.NaN },
      { t: T0 + 2 * MINUTE, price: 943 },
      { t: T0 + 3 * MINUTE, price: 0 },
      { t: T0 + 4 * MINUTE, price: -5 },
      { t: Number.NaN, price: 941 },
      { t: T0 + 5 * MINUTE, price: Number.POSITIVE_INFINITY },
    ]);

    expect(cleaned).toEqual([
      { t: T0, price: 940 },
      // Timestamp repetido: gana el último leído, no se duplica la observación.
      { t: T0 + 2 * MINUTE, price: 943 },
    ]);
  });

  it('un precio de cero no es un precio', () => {
    expect(sanitiseSeries([{ t: T0, price: 0 }])).toEqual([]);
  });
});

describe('la cadencia se mide, no se supone', () => {
  it('devuelve la mediana real de los huecos', () => {
    expect(medianIntervalMs(pointsFrom([1, 2, 3, 4], 4.5 * MINUTE))).toBe(4.5 * MINUTE);
  });

  it('un hueco aislado no arrastra la mediana', () => {
    // Una caída del proceso deja un salto enorme. La cadencia sigue siendo la
    // de siempre: por eso se usa la mediana y no la media.
    const points = pointsFrom(Array.from({ length: 50 }, (_, i) => 940 + i));
    points[25] = { ...points[25], t: points[25].t + 6 * 60 * MINUTE };
    expect(medianIntervalMs(points)).toBe(MINUTE);
  });

  it('sin dos observaciones no hay cadencia que medir', () => {
    expect(medianIntervalMs([])).toBeNull();
    expect(medianIntervalMs(pointsFrom([940]))).toBeNull();
  });
});

describe('el movimiento típico', () => {
  it('ignora los tramos quietos: mide el salto CUANDO se mueve', () => {
    // Diez observaciones iguales y luego saltos de 0.5. Una mediana de todos
    // los saltos daría 0 y declararía "sin variación" sobre una serie que varía.
    const points = pointsFrom([940, 940, 940, 940, 940, 940.5, 941, 941.5, 942]);
    expect(typicalStep(points)).toBeCloseTo(0.5, 10);
  });

  it('una serie literalmente constante mide 0, que no es lo mismo que null', () => {
    expect(typicalStep(pointsFrom(Array(20).fill(940)))).toBe(0);
    expect(typicalStep(pointsFrom([940]))).toBeNull();
  });
});

describe('huecos de captura', () => {
  it('acepta el jitter y rechaza la observación que falta', () => {
    const points = pointsFrom([940, 941, 942, 943]);
    const jittered = points.map((p, i) => ({ ...p, t: p.t + (i === 2 ? 20_000 : 0) }));

    expect(gapFree(jittered, 0, 3, MINUTE * 1.5)).toBe(true);
    const holed = points.map((p, i) => ({ ...p, t: p.t + (i >= 2 ? 5 * MINUTE : 0) }));
    expect(gapFree(holed, 0, 3, MINUTE * 1.5)).toBe(false);
  });
});

describe('el vector de estado', () => {
  it('la misma forma a dos niveles de precio es el MISMO estado', () => {
    // Ninguna constante en VES puede entrar en la comparación: si entrara,
    // estos dos estados diferirían y el motor no encontraría analogías entre
    // tramos de precio distinto.
    const low = pointsFrom([10, 11, 12, 13, 14, 15]);
    const high = pointsFrom([940, 941, 942, 943, 944, 945]);
    expect(buildState(low, 0, 5, 1)).toEqual(buildState(high, 0, 5, 1));
  });

  it('distingue aceleración de desaceleración', () => {
    const up = pointsFrom(accelerating(940, 0.02, 40));
    const down = pointsFrom(decelerating(940, 0.02, 40));

    const accel = buildState(up, 0, 39, typicalStep(up) as number)!;
    const decel = buildState(down, 0, 39, typicalStep(down) as number)!;

    expect(accel.acceleration).toBeGreaterThan(0);
    expect(decel.acceleration).toBeLessThan(0);
  });

  it('distingue una subida sostenida de una que fue y volvió', () => {
    const straight = pointsFrom(ramp(940, 0.02, 40));
    const zigzag = pointsFrom(reversal(940, 0.02, 40));

    const a = buildState(straight, 0, 39, typicalStep(straight) as number)!;
    const b = buildState(zigzag, 0, 39, typicalStep(zigzag) as number)!;

    // Persistencia: la proporción de saltos en la dirección dominante.
    expect(a.persistence).toBe(1);
    expect(b.persistence).toBeLessThan(1);
    // Y la reversión acaba donde empezó: recorrido nulo.
    expect(Math.abs(b.drift)).toBeLessThan(Math.abs(a.drift));
  });

  it('sitúa el precio dentro del rango de su ventana', () => {
    const rising = pointsFrom(ramp(940, 0.02, 20));
    const falling = pointsFrom(ramp(940, -0.02, 20));

    expect(buildState(rising, 0, 19, 0.02)!.position).toBe(1);
    expect(buildState(falling, 0, 19, 0.02)!.position).toBe(0);
  });

  it('no divide por cero cuando la serie nunca se movió', () => {
    const state = buildState(pointsFrom(Array(10).fill(940)), 0, 9, 0)!;

    for (const value of Object.values(state)) expect(Number.isFinite(value)).toBe(true);
    expect(state.position).toBe(0.5);
    expect(state.persistence).toBe(0.5);
    expect(state.drift).toBe(0);
  });

  it('una ventana sin dos mitades no se puede describir', () => {
    expect(buildState(pointsFrom([940, 941]), 0, 1, 1)).toBeNull();
    expect(buildState(pointsFrom([940, 941, 942]), 0, 5, 1)).toBeNull();
  });
});

describe('la distancia entre estados', () => {
  it('no la decide la escala de ninguna componente', () => {
    // Las escalas salen de la dispersión observada de cada componente, así que
    // ninguna domina por accidente de unidades.
    const series = pointsFrom(ramp(940, 0.02, 60));
    const step = typicalStep(series) as number;
    const states = [
      buildState(series, 0, 10, step)!,
      buildState(series, 10, 20, step)!,
      buildState(series, 20, 30, step)!,
    ];

    const scales = stateScales(states);
    for (const value of Object.values(scales)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    expect(stateDistance(states[0], states[0], scales)).toBe(0);
  });
});

describe('utilidades de horizonte', () => {
  it('la ventana de contexto es el propio horizonte, con un mínimo medible', () => {
    expect(lookbackFor(30)).toBe(30);
    expect(lookbackFor(1)).toBe(MIN_LOOKBACK_STEPS);
  });

  it('percentileOf usa orden estadístico sin interpolar', () => {
    const sorted = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(percentileOf(sorted, 0.1)).toBe(1);
    expect(percentileOf(sorted, 0.5)).toBe(5);
    expect(percentileOf(sorted, 0.9)).toBe(9);
    expect(percentileOf([], 0.5)).toBeNull();
  });
});
