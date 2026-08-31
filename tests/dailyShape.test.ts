/**
 * LA FORMA DEL DÍA — SEMÁNTICA MAKER Y AUSENCIA DE LOOK-AHEAD
 * ==========================================================
 *
 * Las series son ARTIFICIALES y no pretenden parecerse a Binance: existen para
 * comprobar que el motor hace lo que dice.
 *
 * Lo que más se protege aquí es la semántica operacional, porque es el error
 * que no se ve: con el libro en su estado normal —mi venta por encima de mi
 * compra— una fórmula equivocada devuelve el número correcto por casualidad y
 * sólo falla el día que las dos series se cruzan.
 */

import { describe, expect, it } from 'vitest';
import {
  LEG_BINANCE_SIDE,
  MIN_CONDITIONED_DAYS,
  MIN_PROFILE_DAYS,
  backtestLeg,
  extremeForLeg,
  groupByDay,
  isBetterForLeg,
  openToHourRatio,
  projectHour,
  projectLeg,
  projectLegFromDays,
  ratiosBetween,
  remainingExtremeRatios,
  selectAnalogousDays,
  turnThreshold,
  venezuelaDayKey,
  venezuelaHourOf,
  type DayShape,
} from '../server/projection/dailyShape.js';
import type { SeriesPoint } from '../server/projection/series.js';

/** Instante de la hora local de Venezuela `hour` del día `day` de agosto 2026. */
const at = (day: number, hour: number, minute = 0): number =>
  Date.UTC(2026, 7, day, hour + 4, minute, 0);

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
    expect(venezuelaDayKey(Date.UTC(2026, 7, 11, 2, 0, 0))).toBe('2026-08-10');
    expect(venezuelaDayKey(Date.UTC(2026, 7, 11, 5, 0, 0))).toBe('2026-08-11');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * SEMÁNTICA OPERACIONAL. Es la parte que no puede estar mal.
 * ══════════════════════════════════════════════════════════════════════════ */

describe('MI VENTA es Binance BUY y MI COMPRA es Binance SELL', () => {
  it('el mapeo está declarado en un solo sitio y dice eso', () => {
    expect(LEG_BINANCE_SIDE.VENTA).toBe('BUY');
    expect(LEG_BINANCE_SIDE.COMPRA).toBe('SELL');
  });

  it('los dos lados de Binance NO son el mismo lado', () => {
    expect(LEG_BINANCE_SIDE.VENTA).not.toBe(LEG_BINANCE_SIDE.COMPRA);
  });

  it('vendiendo interesa el precio más alto; recomprando, el más bajo', () => {
    // Publico en el lado BUY de Binance para vender: quiero cobrar más.
    expect(isBetterForLeg('VENTA', 940, 936)).toBe(true);
    expect(isBetterForLeg('VENTA', 930, 936)).toBe(false);
    // Publico en el lado SELL de Binance para recomprar: quiero pagar menos.
    expect(isBetterForLeg('COMPRA', 928, 931)).toBe(true);
    expect(isBetterForLeg('COMPRA', 934, 931)).toBe(false);
  });

  it('el extremo de la pierna es máximo en venta y mínimo en compra', () => {
    expect(extremeForLeg('VENTA', [930, 936, 934, 940])).toBe(940);
    expect(extremeForLeg('COMPRA', [928, 932, 929, 931])).toBe(928);
  });

  it('una pierna desconocida falla en voz alta en vez de asumir COMPRA', () => {
    /*
     * Ocurrió de verdad: una llamada sin el argumento de la pierna hizo que
     * `undefined` cayera en la rama de COMPRA y el backtest entero midiera
     * mínimos donde debía medir máximos, devolviendo cifras plausibles.
     */
    expect(() => isBetterForLeg(undefined as never, 940, 936)).toThrow(/Pierna desconocida/);
    expect(() => extremeForLeg('BUY' as never, [930, 940])).toThrow(/Pierna desconocida/);
  });

  it('el extremo ignora valores imposibles en vez de propagarlos', () => {
    expect(extremeForLeg('VENTA', [930, Number.NaN, 940, -5, 0])).toBe(940);
    expect(extremeForLeg('COMPRA', [Number.POSITIVE_INFINITY, 931, 0])).toBe(931);
    expect(extremeForLeg('VENTA', [])).toBeNull();
  });
});

describe('TECHO = MAX(BUY) y PISO = MIN(SELL) — el fixture del propietario', () => {
  /*
   * BUY  = [930, 936, 934, 940]  → MI VENTA  → TECHO = 940
   * SELL = [928, 932, 929, 931]  → MI COMPRA → PISO  = 928
   */
  const BUY = [930, 936, 934, 940];
  const SELL = [928, 932, 929, 931];

  const points = (prices: number[]): SeriesPoint[] =>
    prices.map((price, i) => ({ t: at(10, 9 + i), price }));

  it('el techo sale del lado BUY y vale 940', () => {
    const venta = projectLeg(points(BUY), 'VENTA', at(10, 20));
    expect(venta.observedExtreme?.price).toBe(940);
  });

  it('el piso sale del lado SELL y vale 928', () => {
    const compra = projectLeg(points(SELL), 'COMPRA', at(10, 20));
    expect(compra.observedExtreme?.price).toBe(928);
  });

  it('el techo NO es el mínimo del lado BUY ni el máximo del lado SELL', () => {
    const venta = projectLeg(points(BUY), 'VENTA', at(10, 20));
    const compra = projectLeg(points(SELL), 'COMPRA', at(10, 20));
    expect(venta.observedExtreme?.price).not.toBe(930); // min(BUY): el criterio del taker
    expect(compra.observedExtreme?.price).not.toBe(932); // max(SELL): el criterio del taker
  });
});

describe('REGRESIÓN: max(BUY, SELL) y min(BUY, SELL) no pueden volver', () => {
  /*
   * Fixture que CRUZA las dos series. Es lo que el fixture normal no puede
   * detectar: con mi venta siempre por encima de mi compra, mezclar las dos
   * piernas da la respuesta correcta por casualidad. Aquí no.
   *
   * VENTA (BUY)   = [930, 936]        → TECHO correcto = 936
   * COMPRA (SELL) = [920, 945]        → PISO  correcto = 920
   *
   * Una fórmula que mezclara diría techo 945 (un precio al que NUNCA pude
   * vender, porque salió del lado donde yo recompro) y piso 920 por el motivo
   * equivocado. Se comprueban las dos cosas.
   */
  const ventaPoints: SeriesPoint[] = [
    { t: at(10, 9), price: 930 },
    { t: at(10, 10), price: 936 },
  ];
  const compraPoints: SeriesPoint[] = [
    { t: at(10, 9), price: 920 },
    { t: at(10, 10), price: 945 },
  ];

  it('el techo ignora por completo la serie de compra', () => {
    const venta = projectLeg(ventaPoints, 'VENTA', at(10, 20));
    expect(venta.observedExtreme?.price).toBe(936);
    // 945 existe en el mercado, pero en el lado donde yo COMPRO: no es techo.
    expect(venta.observedExtreme?.price).not.toBe(945);
  });

  it('el piso ignora por completo la serie de venta', () => {
    const compra = projectLeg(compraPoints, 'COMPRA', at(10, 20));
    expect(compra.observedExtreme?.price).toBe(920);
  });

  it('la pierna que produce el techo declara su lado de Binance', () => {
    const venta = projectLeg(ventaPoints, 'VENTA', at(10, 20));
    expect(venta.binanceSide).toBe('BUY');
    expect(projectLeg(compraPoints, 'COMPRA', at(10, 20)).binanceSide).toBe('SELL');
  });
});

describe('el extremo de cada hora sigue el criterio de la pierna', () => {
  const points: SeriesPoint[] = [
    { t: at(10, 9, 0), price: 934 },
    { t: at(10, 9, 30), price: 940 },
    { t: at(10, 9, 50), price: 930 },
  ];

  it('vendiendo, la hora se resume por su máximo', () => {
    expect(groupByDay(points, 'VENTA')[0].hours.get(9)?.best).toBe(940);
  });

  it('recomprando, la hora se resume por su mínimo', () => {
    expect(groupByDay(points, 'COMPRA')[0].hours.get(9)?.best).toBe(930);
  });

  it('cuenta las observaciones de la hora sin perderlas', () => {
    expect(groupByDay(points, 'VENTA')[0].hours.get(9)?.observations).toBe(3);
  });
});

describe('no se inventan horas ni días', () => {
  it('deja fuera las horas que nadie observó', () => {
    const day = groupByDay(
      [
        { t: at(10, 9), price: 900 },
        { t: at(10, 15), price: 910 },
      ],
      'VENTA'
    )[0];
    expect([...day.hours.keys()].sort((a, b) => a - b)).toEqual([9, 15]);
    expect(day.hours.get(12)).toBeUndefined();
  });

  it('descarta lo que cae fuera de la ventana del día', () => {
    const day = groupByDay(
      [
        { t: at(10, 3), price: 800 },
        { t: at(10, 9), price: 900 },
        { t: at(10, 22), price: 999 },
      ],
      'VENTA'
    )[0];
    expect([...day.hours.keys()]).toEqual([9]);
  });

  it('un día al que le falta una de las dos horas no aporta cociente', () => {
    const days = [
      ...groupByDay(dayPoints(10, () => 900), 'VENTA'),
      ...groupByDay([{ t: at(11, 9), price: 900 }], 'VENTA'),
    ];
    expect(ratiosBetween(days, 9, 15)).toHaveLength(1);
  });
});

describe('el extremo del tramo restante se estima por día, no por hora', () => {
  it('usa el máximo que alcanzó cada día y luego reparte percentiles', () => {
    /*
     * Tres días que suben hasta las 15 y luego bajan. El máximo del tramo
     * 12→20 es el de las 15 en los tres. Tomar el máximo de los percentiles
     * hora a hora daría un número mayor que cualquier día real.
     */
    const days = [10, 11, 12].map(
      (d) => groupByDay(dayPoints(d, (h) => (h <= 15 ? 900 + (h - 8) * 2 : 914 - (h - 15) * 2)), 'VENTA')[0]
    );
    const ratios = remainingExtremeRatios(days, 'VENTA', 12, 20).map((s) => s.ratio);
    expect(ratios).toHaveLength(3);
    // A las 12 vale 908; el máximo posterior es 914 (las 15). 914/908.
    for (const r of ratios) expect(r).toBeCloseTo(914 / 908, 10);
  });

  it('recomprando busca el mínimo del tramo restante', () => {
    const days = [10, 11, 12].map(
      (d) => groupByDay(dayPoints(d, (h) => (h <= 15 ? 900 - (h - 8) * 2 : 886 + (h - 15) * 2)), 'COMPRA')[0]
    );
    const ratios = remainingExtremeRatios(days, 'COMPRA', 12, 20).map((s) => s.ratio);
    // A las 12 vale 892; el mínimo posterior es 886.
    for (const r of ratios) expect(r).toBeCloseTo(886 / 892, 10);
  });
});

describe('el condicionamiento por el estado de hoy', () => {
  it('con pocos días devuelve todos y lo declara', () => {
    const days = Array.from({ length: 7 }, (_, i) =>
      groupByDay(dayPoints(1 + i, (h) => 900 + h), 'VENTA')[0]
    );
    const selected = selectAnalogousDays(days, 12, { openToAnchor: 1.01, volatility: 0.001 });
    expect(selected.conditioned).toBe(false);
    expect(selected.days).toHaveLength(7);
    expect(selected.factors).toEqual([]);
  });

  it('con días suficientes se queda con los parecidos a hoy', () => {
    const days = Array.from({ length: MIN_CONDITIONED_DAYS + 2 }, (_, i) =>
      groupByDay(
        dayPoints(1 + i, (h) => (i % 2 === 0 ? 900 + (h - 8) * 2 : 900 - (h - 8) * 2)),
        'VENTA'
      )[0]
    );
    const selected = selectAnalogousDays(days, 12, { openToAnchor: (900 + 8) / 900, volatility: null });
    expect(selected.conditioned).toBe(true);
    expect(selected.days.length).toBeLessThan(days.length);
    for (const day of selected.days) expect(openToHourRatio(day, 12)).toBeGreaterThan(1);
  });

  it('openToHourRatio sólo mira horas anteriores o iguales al ancla', () => {
    const day = groupByDay(dayPoints(10, (h) => 900 + (h - 8) * 3), 'VENTA')[0];
    expect(openToHourRatio(day, 12)).toBeCloseTo(912 / 900, 10);
    expect(openToHourRatio(day, 8)).toBeNull();
  });
});

describe('el día completo', () => {
  const now = at(20, 12, 30);

  it('sin días anteriores suficientes no dibuja proyección', () => {
    const points = [
      ...dayPoints(18, (h) => 900 + h),
      ...dayPoints(19, (h) => 900 + h),
      ...dayPoints(20, (h) => 920 + h),
    ];
    const leg = projectLeg(points, 'VENTA', now);
    expect(leg.tier).toBe('SOLO_HOY');
    expect(leg.projected).toEqual([]);
    expect(leg.projectedExtreme).toBeNull();
    expect(leg.projectedClose).toBeNull();
    expect(leg.real.length).toBeGreaterThan(0);
  });

  it('sin datos de hoy el nivel es SIN_DATOS y no hay ancla', () => {
    const points = Array.from({ length: 8 }, (_, i) => dayPoints(1 + i, (h) => 900 + h)).flat();
    const leg = projectLeg(points, 'VENTA', now);
    expect(leg.tier).toBe('SIN_DATOS');
    expect(leg.anchorPrice).toBeNull();
    expect(leg.projected).toEqual([]);
  });

  it('proyecta sólo las horas que quedan y parte del precio REAL de ahora', () => {
    const points = [
      ...Array.from({ length: MIN_PROFILE_DAYS + 1 }, (_, i) =>
        dayPoints(10 + i, (h) => 900 * (1 + (h - 8) * 0.01))
      ).flat(),
      ...dayPoints(20, () => 950),
    ];
    const leg = projectLeg(points, 'VENTA', now);
    expect(leg.tier).toBe('PERFIL_LIMITADO');
    expect(leg.anchorHour).toBe(12);
    expect(leg.projected.map((p) => p.hour)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
    expect(leg.real.every((r) => r.hour <= 12)).toBe(true);
    // Ancla real 950, no la media histórica de los días anteriores (~900).
    expect(leg.projected[0].central).toBeGreaterThan(950);
    expect(leg.projected[0].central).toBeLessThan(1000);
  });

  it('la banda contiene al central y declara si son percentiles', () => {
    const points = [
      ...Array.from({ length: MIN_PROFILE_DAYS + 1 }, (_, i) =>
        dayPoints(10 + i, (h) => 900 + h * (i % 3))
      ).flat(),
      ...dayPoints(20, () => 950),
    ];
    const leg = projectLeg(points, 'VENTA', now);
    for (const p of leg.projected) {
      expect(p.low).toBeLessThanOrEqual(p.central);
      expect(p.high).toBeGreaterThanOrEqual(p.central);
      // Seis días: por debajo de diez, la banda NO puede llamarse percentil.
      expect(p.bandKind).toBe('RANGO_OBSERVADO');
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * LOOK-AHEAD BIAS. La parte crítica.
 * ══════════════════════════════════════════════════════════════════════════ */

describe('el backtest no puede ver el futuro', () => {
  const buildDays = (count: number, priceAt: (d: number, h: number) => number): DayShape[] => {
    const points: SeriesPoint[] = [];
    for (let d = 0; d < count; d += 1) {
      for (let h = 8; h <= 20; h += 1) points.push({ t: at(1 + d, h, 10), price: priceAt(d, h) });
    }
    return groupByDay(points, 'VENTA');
  };

  const shape = (d: number, h: number) => (900 + d * 4) * (1 + (h - 8) * 0.003);

  it('añadir un día POSTERIOR no cambia la evaluación de los días anteriores', () => {
    /*
     * Ésta es la prueba decisiva. Con validación "dejando uno fuera" —que es lo
     * que hacía la versión anterior— el perfil de cada día incluía días
     * posteriores, así que añadir un día al final CAMBIABA el pasado. Aquí no
     * puede: el perfil del día i se construye con days.slice(0, i).
     */
    const base = buildDays(9, shape);
    const before = backtestLeg(base, 'VENTA');

    // Un décimo día con un comportamiento radicalmente distinto.
    const extended = buildDays(10, (d, h) => (d === 9 ? 2000 - (h - 8) * 50 : shape(d, h)));
    const after = backtestLeg(extended, 'VENTA');

    // Los días evaluados aumentan en uno, pero lo ya juzgado no se mueve.
    expect(after.days).toBe(before.days + 1);
    expect(after.modelWins).toBeGreaterThanOrEqual(before.modelWins);
    expect(after.persistenceWins).toBeGreaterThanOrEqual(before.persistenceWins);
    expect(after.modelWins + after.persistenceWins + after.ties).toBe(
      before.modelWins + before.persistenceWins + before.ties + 1
    );
  });

  it('los primeros días no se evalúan: no tienen pasado con el que proyectar', () => {
    const result = backtestLeg(buildDays(MIN_PROFILE_DAYS, shape), 'VENTA');
    expect(result.days).toBe(0);
    expect(result.pValue).toBeNull();
    expect(result.beatsPersistence).toBe(false);
  });

  it('la proyección de hoy no cambia si se altera lo que ocurre DESPUÉS del ancla', () => {
    const past = buildDays(8, shape);

    const todayEarly: SeriesPoint[] = [];
    for (let h = 8; h <= 12; h += 1) todayEarly.push({ t: at(20, h, 10), price: 950 + h });

    const withCalmAfternoon = [...todayEarly];
    for (let h = 13; h <= 20; h += 1) withCalmAfternoon.push({ t: at(20, h, 10), price: 962 });

    const withWildAfternoon = [...todayEarly];
    for (let h = 13; h <= 20; h += 1) withWildAfternoon.push({ t: at(20, h, 10), price: 5000 });

    const project = (todayPoints: SeriesPoint[]) => {
      const today = groupByDay(todayPoints, 'VENTA')[0];
      return projectLegFromDays([...past, today], 'VENTA', today.dayKey, 12);
    };

    const calm = project(withCalmAfternoon);
    const wild = project(withWildAfternoon);

    // Mismo ancla, misma trayectoria proyectada: la tarde no ha entrado.
    expect(wild.anchorPrice).toBe(calm.anchorPrice);
    expect(wild.projected.map((p) => p.central)).toEqual(calm.projected.map((p) => p.central));
    expect(wild.projectedClose?.central).toBe(calm.projectedClose?.central);
    expect(wild.projectedExtreme?.central).toBe(calm.projectedExtreme?.central);
  });

  it('lo observado que se publica llega sólo hasta el ancla', () => {
    const past = buildDays(8, shape);
    const points: SeriesPoint[] = [];
    for (let h = 8; h <= 20; h += 1) points.push({ t: at(20, h, 10), price: h === 18 ? 9999 : 950 });
    const today = groupByDay(points, 'VENTA')[0];

    const projection = projectLegFromDays([...past, today], 'VENTA', today.dayKey, 12);
    expect(projection.real.every((r) => r.hour <= 12)).toBe(true);
    // El pico de las 18 todavía no ha ocurrido: no puede ser el techo observado.
    expect(projection.observedExtreme?.price).toBe(950);
  });
});

describe('el backtest mide lo que dice medir', () => {
  const buildDays = (count: number, priceAt: (d: number, h: number) => number): DayShape[] => {
    const points: SeriesPoint[] = [];
    for (let d = 0; d < count; d += 1) {
      for (let h = 8; h <= 20; h += 1) points.push({ t: at(1 + d, h, 10), price: priceAt(d, h) });
    }
    return groupByDay(points, 'VENTA');
  };

  it('un día es un caso, no un caso por cada ancla', () => {
    const days = buildDays(12, (d, h) => (900 + d * 3) * (1 + (h - 8) * 0.002));
    const r = backtestLeg(days, 'VENTA');
    expect(r.modelWins + r.persistenceWins + r.ties).toBeLessThanOrEqual(r.days);
    // Cada día aporta muchas anclas, y ninguna de ellas cuenta como caso.
    expect(r.anchors).toBeGreaterThan(r.days * 3);
  });

  it('con una forma diaria repetida el modelo bate a la persistencia', () => {
    const shape = (h: number) => 1 + (h <= 14 ? (h - 8) * 0.01 : 0.06 - (h - 14) * 0.01);
    const r = backtestLeg(buildDays(14, (d, h) => (900 + d * 5) * shape(h)), 'VENTA');
    expect(r.days).toBeGreaterThan(0);
    expect(r.modelWins).toBe(r.days);
    expect(r.beatsPersistence).toBe(true);
    expect(r.closeErrorModel!).toBeLessThan(r.closeErrorPersistence!);
  });

  it('con ruido puro rara vez declara superioridad', () => {
    let declared = 0;
    const trials = 30;
    for (let seed = 1; seed <= trials; seed += 1) {
      let state = seed * 7919;
      const rnd = () => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state / 2_147_483_648 - 0.5;
      };
      const prices = new Map<string, number>();
      let price = 900;
      const days = buildDays(12, (d, h) => {
        const key = `${d}:${h}`;
        if (!prices.has(key)) {
          price *= 1 + rnd() * 0.02;
          prices.set(key, price);
        }
        return prices.get(key)!;
      });
      if (backtestLeg(days, 'VENTA').beatsPersistence) declared += 1;
    }
    /*
     * Bajo la nula, el signo exacto con ~7 casos sólo llega a p<0.05 con
     * prácticamente todos a favor. Lo que se comprueba es que el ruido no
     * produce validaciones sistemáticas: ése fue el fallo del primer motor.
     */
    expect(declared / trials).toBeLessThan(0.2);
  });

  it('la cobertura está entre 0 y 1 y la dirección no supera sus casos', () => {
    const r = backtestLeg(buildDays(12, (d, h) => (900 + d * 3) * (1 + (h - 8) * 0.004)), 'VENTA');
    if (r.coverage !== null) {
      expect(r.coverage).toBeGreaterThanOrEqual(0);
      expect(r.coverage).toBeLessThanOrEqual(1);
    }
    expect(r.directionHits).toBeLessThanOrEqual(r.directionTotal);
  });
});

describe('el umbral de giro se mide, no se elige', () => {
  it('sale de los cambios de hora a hora observados', () => {
    const days = groupByDay(dayPoints(10, (h) => 900 * 1.01 ** (h - 8)), 'VENTA');
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
        { t: at(10, 18), price: 500 },
      ],
      'VENTA'
    );
    expect(turnThreshold(days).sampleSize).toBe(1);
  });
});

describe('projectHour', () => {
  it('sin ningún día que la haya visto, no existe', () => {
    expect(projectHour([], 9, 15, 900)).toBeNull();
  });
});
