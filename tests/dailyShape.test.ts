/**
 * LA FORMA DEL DÍA
 * ================
 *
 * Las series de este fichero son ARTIFICIALES y no pretenden parecerse a
 * Binance: sirven para comprobar que el estimador hace lo que dice —elegir el
 * mejor precio de cada hora según el lado, no inventar horas que nadie observó,
 * condicionar por el momento sólo cuando hay días de sobra y no declarar que
 * bate a la persistencia cuando lo que le dan es ruido—.
 *
 * Ninguna de estas cifras se presenta jamás como una observación de mercado.
 */

import { describe, expect, it } from 'vitest';
import {
  BAND_PERCENTILE_DAYS,
  MIN_CONDITIONED_DAYS,
  MIN_PROFILE_DAYS,
  groupByDay,
  isBetter,
  openToHourRatio,
  projectHour,
  projectRestOfDay,
  ratiosBetween,
  selectAnalogousDays,
  turnThreshold,
  validateShape,
  venezuelaDayKey,
  venezuelaHourOf,
} from '../server/projection/dailyShape.js';
import type { SeriesPoint } from '../server/projection/series.js';

/** Instante de la hora local de Venezuela `hour` del día `day` de agosto 2026. */
const at = (day: number, hour: number, minute = 0): number =>
  Date.UTC(2026, 7, day, hour + 4, minute, 0);

/** Un día completo de 8 a 20 con el precio que dicte `priceAt`. */
const dayPoints = (day: number, priceAt: (hour: number) => number): SeriesPoint[] => {
  const out: SeriesPoint[] = [];
  for (let hour = 8; hour <= 20; hour += 1) {
    out.push({ t: at(day, hour, 5), price: priceAt(hour) });
    out.push({ t: at(day, hour, 35), price: priceAt(hour) });
  }
  return out;
};

describe('la hora local no se confunde con la UTC', () => {
  it('Venezuela va cuatro horas por detrás de UTC', () => {
    expect(venezuelaHourOf(Date.UTC(2026, 7, 10, 12, 0, 0))).toBe(8);
    expect(venezuelaHourOf(Date.UTC(2026, 7, 10, 23, 0, 0))).toBe(19);
  });

  it('la medianoche UTC sigue siendo el día anterior en Caracas', () => {
    // 02:00 UTC del 11 son las 22:00 del 10 en Venezuela: mismo día de mercado.
    expect(venezuelaDayKey(Date.UTC(2026, 7, 11, 2, 0, 0))).toBe('2026-08-10');
    expect(venezuelaDayKey(Date.UTC(2026, 7, 11, 5, 0, 0))).toBe('2026-08-11');
  });
});

describe('el mejor precio de la hora depende del lado', () => {
  /*
   * Esta es la semántica fijada en types.ts y no se invierte nunca:
   * BUY es el ask que pago (mejor = más barato), SELL es el bid que cobro
   * (mejor = más caro). Invertirla daría una proyección coherente consigo
   * misma y equivocada en todas partes.
   */
  it('comprando es el más bajo y vendiendo el más alto', () => {
    expect(isBetter('BUY', 900, 910)).toBe(true);
    expect(isBetter('BUY', 920, 910)).toBe(false);
    expect(isBetter('SELL', 920, 910)).toBe(true);
    expect(isBetter('SELL', 900, 910)).toBe(false);
  });

  it('groupByDay se queda con el mejor de cada hora, según el lado', () => {
    const points: SeriesPoint[] = [
      { t: at(10, 9, 0), price: 905 },
      { t: at(10, 9, 30), price: 899 },
      { t: at(10, 9, 50), price: 912 },
    ];
    expect(groupByDay(points, 'BUY')[0].hours.get(9)?.best).toBe(899);
    expect(groupByDay(points, 'SELL')[0].hours.get(9)?.best).toBe(912);
    expect(groupByDay(points, 'BUY')[0].hours.get(9)?.observations).toBe(3);
  });
});

describe('no se inventan horas ni días', () => {
  it('deja fuera las horas de la ventana que nadie observó', () => {
    const points = [
      { t: at(10, 9), price: 900 },
      { t: at(10, 15), price: 910 },
    ];
    const day = groupByDay(points, 'BUY')[0];
    expect([...day.hours.keys()].sort((a, b) => a - b)).toEqual([9, 15]);
    // Las 10, 11, 12, 13 y 14 no existen: no heredan el precio de al lado.
    expect(day.hours.get(12)).toBeUndefined();
  });

  it('descarta lo que cae fuera de la ventana del día', () => {
    const points = [
      { t: at(10, 3), price: 800 }, // madrugada
      { t: at(10, 9), price: 900 },
      { t: at(10, 22), price: 999 }, // noche
    ];
    const day = groupByDay(points, 'BUY')[0];
    expect([...day.hours.keys()]).toEqual([9]);
  });

  it('un día al que le falta una de las dos horas no aporta cociente', () => {
    const days = [
      ...groupByDay(dayPoints(10, () => 900), 'BUY'),
      ...groupByDay([{ t: at(11, 9), price: 900 }], 'BUY'), // sólo tiene las 9
    ];
    // El día 11 tiene las 9 pero no las 15: no se interpola, se descarta.
    expect(ratiosBetween(days, 9, 15)).toHaveLength(1);
  });
});

describe('la proyección de una hora', () => {
  it('sin ningún día que la haya visto, no existe', () => {
    expect(projectHour([], 9, 15, 900)).toBeNull();
  });

  it('con pocos días la banda se llama rango observado, no percentil', () => {
    const days = Array.from({ length: MIN_PROFILE_DAYS }, (_, i) =>
      groupByDay(dayPoints(10 + i, (h) => 900 + h + i), 'BUY')[0]
    );
    const projection = projectHour(days, 9, 15, 900);
    expect(projection?.bandKind).toBe('RANGO_OBSERVADO');
    expect(projection?.daysUsed).toBe(MIN_PROFILE_DAYS);
  });

  it('con días suficientes sí son percentiles', () => {
    const days = Array.from({ length: BAND_PERCENTILE_DAYS }, (_, i) =>
      groupByDay(dayPoints(1 + i, (h) => 900 + h + i), 'BUY')[0]
    );
    expect(projectHour(days, 9, 15, 900)?.bandKind).toBe('P10_P90');
  });

  it('la banda contiene al escenario central', () => {
    const days = Array.from({ length: BAND_PERCENTILE_DAYS }, (_, i) =>
      groupByDay(dayPoints(1 + i, (h) => 900 + h * (i % 3) - i), 'BUY')[0]
    );
    const p = projectHour(days, 9, 15, 900);
    expect(p).not.toBeNull();
    expect(p!.low).toBeLessThanOrEqual(p!.central);
    expect(p!.high).toBeGreaterThanOrEqual(p!.central);
  });
});

describe('el momento del mercado condiciona, pero sólo con días de sobra', () => {
  it('con pocos días devuelve todos y lo dice', () => {
    const days = Array.from({ length: 7 }, (_, i) =>
      groupByDay(dayPoints(1 + i, (h) => 900 + h), 'BUY')[0]
    );
    const selected = selectAnalogousDays(days, 12, 1.01);
    expect(selected.conditioned).toBe(false);
    expect(selected.days).toHaveLength(7);
  });

  it('con días suficientes se queda con los parecidos a hoy', () => {
    // Mitad de días subiendo desde la apertura, mitad bajando.
    const days = Array.from({ length: MIN_CONDITIONED_DAYS + 2 }, (_, i) =>
      groupByDay(
        dayPoints(1 + i, (h) => (i % 2 === 0 ? 900 + (h - 8) * 2 : 900 - (h - 8) * 2)),
        'BUY'
      )[0]
    );
    // Hoy lleva subiendo: el ratio apertura→12 es mayor que 1.
    const selected = selectAnalogousDays(days, 12, (900 + 8) / 900);
    expect(selected.conditioned).toBe(true);
    expect(selected.days.length).toBeLessThan(days.length);
    // Todos los elegidos venían subiendo desde su apertura.
    for (const day of selected.days) {
      expect(openToHourRatio(day, 12)).toBeGreaterThan(1);
    }
  });

  it('openToHourRatio no mira hacia adelante', () => {
    const day = groupByDay(dayPoints(10, (h) => 900 + (h - 8) * 3), 'BUY')[0];
    // La apertura es las 8; a las 12 lleva +12 sobre 900.
    expect(openToHourRatio(day, 12)).toBeCloseTo(912 / 900, 10);
    // La hora de apertura no tiene recorrido contra sí misma.
    expect(openToHourRatio(day, 8)).toBeNull();
  });
});

describe('el día completo', () => {
  const now = at(20, 12, 30);

  it('sin días anteriores suficientes no dibuja ninguna proyección', () => {
    const points = [
      ...dayPoints(18, (h) => 900 + h),
      ...dayPoints(19, (h) => 900 + h),
      ...dayPoints(20, (h) => 920 + h),
    ];
    const day = projectRestOfDay(points, 'BUY', now);
    expect(day.tier).toBe('SOLO_HOY');
    expect(day.projected).toEqual([]);
    expect(day.candidateDays).toBe(2);
    // Lo real de hoy sí se conserva: es lo único que se puede afirmar.
    expect(day.real.length).toBeGreaterThan(0);
  });

  it('sin ningún dato de hoy no hay ancla y el nivel es SIN_DATOS', () => {
    const points = Array.from({ length: 8 }, (_, i) => dayPoints(1 + i, (h) => 900 + h)).flat();
    const day = projectRestOfDay(points, 'BUY', now);
    expect(day.tier).toBe('SIN_DATOS');
    expect(day.anchorPrice).toBeNull();
    expect(day.projected).toEqual([]);
  });

  it('con días suficientes proyecta sólo las horas que quedan', () => {
    const points = [
      ...Array.from({ length: MIN_PROFILE_DAYS + 1 }, (_, i) =>
        dayPoints(10 + i, (h) => 900 + (h - 8) * 2)
      ).flat(),
      ...dayPoints(20, (h) => 950 + (h - 8) * 2),
    ];
    const day = projectRestOfDay(points, 'BUY', now);
    expect(day.tier).toBe('PERFIL_LIMITADO');
    // Ancla a las 12: se proyecta de la 13 a la 20, ni una hora ya vivida.
    expect(day.anchorHour).toBe(12);
    expect(day.projected.map((p) => p.hour)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
    expect(day.real.every((r) => r.hour <= 12)).toBe(true);
  });

  it('la proyección arranca del precio real de ahora, no de la media histórica', () => {
    // Días anteriores planos en 900; hoy va por 950. La proyección debe salir
    // de 950 y aplicar la FORMA de los días anteriores, no volver a 900.
    const points = [
      ...Array.from({ length: MIN_PROFILE_DAYS + 1 }, (_, i) =>
        dayPoints(10 + i, (h) => 900 * (1 + (h - 8) * 0.01))
      ).flat(),
      ...dayPoints(20, () => 950),
    ];
    const day = projectRestOfDay(points, 'BUY', now);
    const first = day.projected[0];
    expect(first.central).toBeGreaterThan(950);
    expect(first.central).toBeLessThan(1000);
  });
});

describe('el umbral de giro se mide, no se elige', () => {
  it('sale de los cambios de hora a hora observados', () => {
    // Un 1 % exacto cada hora: la mediana de los cambios absolutos es 1 %.
    const days = groupByDay(dayPoints(10, (h) => 900 * 1.01 ** (h - 8)), 'BUY');
    const threshold = turnThreshold(days);
    expect(threshold.pct).toBeCloseTo(1, 6);
    expect(threshold.sampleSize).toBe(12);
  });

  it('sin muestra no hay umbral inventado', () => {
    expect(turnThreshold([]).pct).toBeNull();
  });

  it('no cruza horas no contiguas como si fueran un cambio por hora', () => {
    const days = groupByDay(
      [
        { t: at(10, 8), price: 900 },
        { t: at(10, 9), price: 909 },
        { t: at(10, 18), price: 500 }, // salto de nueve horas
      ],
      'BUY'
    );
    // Sólo cuenta el par 8→9. El salto a las 18 no es "un cambio por hora".
    expect(turnThreshold(days).sampleSize).toBe(1);
  });
});

describe('la validación contra la persistencia', () => {
  const noisyDays = (count: number, seed: number) => {
    let state = seed;
    const random = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    const points: SeriesPoint[] = [];
    for (let d = 0; d < count; d += 1) {
      let price = 900;
      for (let h = 8; h <= 20; h += 1) {
        price *= 1 + (random() - 0.5) * 0.02;
        points.push({ t: at(1 + d, h, 10), price });
      }
    }
    return groupByDay(points, 'BUY');
  };

  it('cada día aporta UN caso, no uno por cada par de horas', () => {
    const days = noisyDays(8, 7);
    const result = validateShape(days);
    // 8 días producen decenas de pares ancla→objetivo; los casos siguen siendo
    // como mucho 8. Contar los pares multiplicaría por diez la muestra aparente
    // sin añadir un solo día independiente.
    expect(result.comparisons).toBeLessThanOrEqual(days.length);
    expect(result.pairs).toBeGreaterThan(result.comparisons * 5);
  });

  it('con ruido puro casi nunca declara que bate a la persistencia', () => {
    let declared = 0;
    const trials = 40;
    for (let seed = 1; seed <= trials; seed += 1) {
      if (validateShape(noisyDays(8, seed * 977)).beatsPersistence) declared += 1;
    }
    /*
     * Bajo la hipótesis nula el signo exacto con 8 casos sólo llega a p<0.05
     * con 8/8 o 7/8, así que la tasa esperada de falsos positivos ronda el 3.5 %.
     * El listón se deja en 10 % para no depender de la semilla, pero lo que se
     * está comprobando es que el ruido NO produce una validación sistemática:
     * ese fue el fallo del primer motor y no se repite aquí.
     */
      expect(declared / trials).toBeLessThan(0.1);
  });

  it('sin días suficientes no compara nada y no afirma nada', () => {
    const result = validateShape(noisyDays(3, 11));
    expect(result.comparisons).toBe(0);
    expect(result.pValue).toBeNull();
    expect(result.beatsPersistence).toBe(false);
  });

  it('con una forma diaria real y repetida, sí la detecta', () => {
    /*
     * Días que suben por la mañana y bajan por la tarde, siempre igual, con un
     * nivel de partida distinto cada día. La persistencia no puede acertar esa
     * curva; el perfil sí. Es artificial a propósito: comprueba que la prueba
     * tiene poder, no que el mercado se comporte así.
     */
    const shape = (h: number) => 1 + (h <= 14 ? (h - 8) * 0.01 : (14 - 8) * 0.01 - (h - 14) * 0.01);
    const points: SeriesPoint[] = [];
    for (let d = 0; d < 12; d += 1) {
      for (let h = 8; h <= 20; h += 1) {
        points.push({ t: at(1 + d, h, 10), price: (900 + d * 5) * shape(h) });
      }
    }
    const result = validateShape(groupByDay(points, 'BUY'));
    expect(result.profileWins).toBe(result.comparisons);
    expect(result.beatsPersistence).toBe(true);
  });
});
