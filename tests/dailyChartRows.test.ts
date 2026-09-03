/**
 * LAS FILAS DE LA GRÁFICA DIARIA
 * ==============================
 *
 * Lo que se comprueba es que la pantalla no pueda afirmar que algo ocurrió
 * cuando fue proyectado, y que la serie de MI VENTA no se dibuje jamás con
 * datos de MI COMPRA. Un precio proyectado colocado en el campo de lo real
 * trazaría una línea continua sobre el futuro y nadie lo notaría mirando el
 * gráfico.
 *
 * Con el motor 24/7 se añade una comprobación más: el horizonte puede cruzar
 * medianoche, así que una misma hora de reloj puede aparecer dos veces en el
 * mismo informe (hoy real, mañana proyectada). Las filas se emparejan por
 * `step` —único por fila— precisamente para que esas dos ocurrencias nunca se
 * confundan.
 */

import { describe, expect, it } from 'vitest';
import { buildRows, hourLabel, legOf } from '../src/dailyChartRows';
import type { DailyLegReport, DailyProjectionResponse } from '../src/types';

const q = (central: number, low: number, high: number) => ({
  central,
  low,
  high,
  bandKind: 'RANGO_OBSERVADO' as const,
  daysUsed: 6,
});

const legReport = (
  leg: 'VENTA' | 'COMPRA',
  binanceSide: 'BUY' | 'SELL',
  anchorHour: number,
  real: { hour: number; price: number; movePct: number | null }[],
  projected: { hoursAhead: number; hourOfDay: number; dayKey: string; central: number; movePct: number | null }[]
): DailyLegReport => ({
  projection: {
    leg,
    binanceSide,
    tier: 'PERFIL_LIMITADO',
    anchorHour,
    anchorPrice: real.length > 0 ? real[real.length - 1].price : null,
    real: real.map((r) => ({ ...r, observations: 3 })),
    observedExtreme: real.length > 0 ? { price: real[0].price, hour: real[0].hour } : null,
    projected: projected.map((p) => ({
      ...q(p.central, p.central - 3, p.central + 3),
      hoursAhead: p.hoursAhead,
      hourOfDay: p.hourOfDay,
      dayKey: p.dayKey,
      movePct: p.movePct,
    })),
    projectedExtreme: q(940, 937, 943),
    projectedClose: q(937, 934, 940),
    profileDays: 6,
    candidateDays: 6,
    conditioned: false,
    conditioningFactors: [],
  },
  backtest: {
    leg,
    days: 0,
    anchors: 0,
    closeErrorModel: null,
    closeErrorPersistence: null,
    extremeErrorModel: null,
    extremeErrorPersistence: null,
    coverage: null,
    directionHits: 0,
    directionTotal: 0,
    modelWins: 0,
    persistenceWins: 0,
    ties: 0,
    pValue: null,
    beatsPersistence: false,
  },
  now: real.length > 0 ? real[real.length - 1].price : null,
  nowOrigin: {
    field: leg === 'VENTA' ? 'strategicBuyPrice' : 'strategicSellPrice',
    binanceSide,
    leg,
    calculation: 'artificial',
    kind: 'OBSERVADO',
    daysUsed: null,
  },
  opportunity: null,
  favourableHours: [],
  turn: null,
  evidence: 'ESTIMACION_SIN_VALIDAR',
  evidenceText: 'artificial',
  label: leg === 'VENTA' ? 'MI VENTA (Binance BUY)' : 'MI COMPRA (Binance SELL)',
  extraction: { recordsRead: 100, droppedLegacy: 0, droppedInvalid: 0 },
  market: { leg, direction: 'SUBIENDO', speed: 'LENTO', changePct: 0.5 },
});

const base = (): DailyProjectionResponse => ({
  generatedAt: Date.UTC(2026, 7, 20, 16, 30),
  source: 'market_history.json',
  dayKey: '2026-08-20',
  anchorHour: 10,
  horizonHours: 12,
  legs: [
    legReport(
      'VENTA',
      'BUY',
      10,
      [
        { hour: 8, price: 936, movePct: null },
        { hour: 9, price: 937, movePct: 0.107 },
        { hour: 10, price: 938, movePct: 0.107 },
      ],
      [
        { hoursAhead: 1, hourOfDay: 11, dayKey: '2026-08-20', central: 940, movePct: 0.21 },
        { hoursAhead: 2, hourOfDay: 12, dayKey: '2026-08-20', central: 941, movePct: 0.11 },
      ]
    ),
    legReport(
      'COMPRA',
      'SELL',
      10,
      [{ hour: 10, price: 931, movePct: null }],
      [{ hoursAhead: 1, hourOfDay: 11, dayKey: '2026-08-20', central: 930, movePct: -0.11 }]
    ),
  ],
  ceiling: {
    leg: 'VENTA',
    binanceSide: 'BUY',
    observed: { price: 938, hour: 10 },
    projected: { price: 941, low: 938, high: 944, daysUsed: 6 },
    dayBest: 941,
    dayBestIsProjected: true,
    origin: {
      field: 'strategicBuyPrice',
      binanceSide: 'BUY',
      leg: 'VENTA',
      calculation: 'artificial',
      kind: 'PROYECTADO',
      daysUsed: 6,
    },
  },
  floor: {
    leg: 'COMPRA',
    binanceSide: 'SELL',
    observed: { price: 931, hour: 10 },
    projected: { price: 930, low: 927, high: 933, daysUsed: 6 },
    dayBest: 930,
    dayBestIsProjected: true,
    origin: {
      field: 'strategicSellPrice',
      binanceSide: 'SELL',
      leg: 'COMPRA',
      calculation: 'artificial',
      kind: 'PROYECTADO',
      daysUsed: 6,
    },
  },
  maxSpread: { hour: 10, spreadPct: 0.75, observed: true },
  turn: { pct: 0.2, sampleSize: 40 },
  turningNow: false,
  remainingPct: 40,
  watchWindow: null,
  tier: 'PERFIL_LIMITADO',
  tierText: 'artificial',
  state: 'PROYECCION_LIMITADA',
  stateText: 'artificial',
  daysMissing: 0,
  variables: { used: [], availableNotUsed: [] },
});

describe('las horas se rotulan en formato de 12 horas', () => {
  it('cubre mediodía y medianoche sin producir un 0', () => {
    expect(hourLabel(8)).toBe('8 AM');
    expect(hourLabel(12)).toBe('12 PM');
    expect(hourLabel(20)).toBe('8 PM');
    expect(hourLabel(0)).toBe('12 AM');
  });
});

describe('cada serie se busca por su pierna, no por su posición', () => {
  it('legOf encuentra la venta y la compra por nombre', () => {
    const report = base();
    expect(legOf(report, 'VENTA')?.binanceSide).toBe('BUY');
    expect(legOf(report, 'COMPRA')?.binanceSide).toBe('SELL');
  });

  it('sobrevive a que el servidor cambie el orden de las piernas', () => {
    const report = base();
    report.legs.reverse();
    expect(legOf(report, 'VENTA')?.binanceSide).toBe('BUY');
    const rows = buildRows(report);
    expect(rows.find((r) => r.hour === 8)?.ventaReal).toBe(936);
  });
});

describe('sólo hay fila donde alguna pierna tiene dato, real o proyectado', () => {
  const rows = buildRows(base());
  const at = (hour: number) => rows.find((r) => r.hour === hour)!;

  it('no rellena horas que ninguna pierna observó ni proyectó', () => {
    // venta: 8,9,10 reales + 11,12 proyectadas · compra: 10 real + 11 proyectada.
    // Unión de pasos: -2,-1,0,1,2 → cinco filas, ni una de relleno.
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.step)).toEqual([-2, -1, 0, 1, 2]);
  });

  it('antes del ancla sólo hay valores reales, sin banda', () => {
    expect(at(9).ventaReal).toBe(937);
    expect(at(9).ventaProjected).toBeUndefined();
    expect(at(9).ventaBand).toBeUndefined();
  });

  it('después del ancla sólo hay proyección, nunca un valor real', () => {
    expect(at(11).ventaReal).toBeUndefined();
    expect(at(11).ventaProjected).toBe(940);
    expect(at(11).ventaBand).toEqual([937, 943]);
  });

  it('el ancla aparece en las dos series con el precio REAL y sin banda', () => {
    expect(at(10).ventaReal).toBe(938);
    expect(at(10).ventaProjected).toBe(938); // copiado de lo real, no al revés
    expect(at(10).ventaBand).toBeUndefined();
  });

  it('la venta nunca toma prestados los datos de la compra', () => {
    // La compra sólo tiene las 10; la venta tiene 8, 9 y 10.
    expect(at(8).ventaReal).toBe(936);
    expect(at(8).compraReal).toBeUndefined();
    expect(at(9).compraReal).toBeUndefined();
    expect(at(10).compraReal).toBe(931);
  });

  it('las dos series llevan precios distintos en la misma hora', () => {
    expect(at(10).ventaReal).not.toBe(at(10).compraReal);
    expect(at(11).ventaProjected).not.toBe(at(11).compraProjected);
  });
});

describe('el movimiento por hora dice si ya ocurrió', () => {
  const rows = buildRows(base());
  const at = (hour: number) => rows.find((r) => r.hour === hour)!;

  it('marca como real el movimiento de una hora vivida', () => {
    expect(at(9).movePct).toBeCloseTo(0.107, 6);
    expect(at(9).moveIsReal).toBe(true);
  });

  it('marca como esperado el de una hora proyectada', () => {
    expect(at(11).movePct).toBeCloseTo(0.21, 6);
    expect(at(11).moveIsReal).toBe(false);
  });

  it('la primera hora del día no inventa un movimiento anterior', () => {
    expect(at(8).movePct).toBeUndefined();
  });
});

describe('sin proyección, la gráfica sólo puede dibujar hechos', () => {
  it('un informe SOLO_HOY no produce ni banda ni línea punteada', () => {
    const report = base();
    report.tier = 'SOLO_HOY';
    for (const leg of report.legs) {
      leg.projection.tier = 'SOLO_HOY';
      leg.projection.projected = [];
    }
    const rows = buildRows(report);
    expect(rows.some((r) => r.ventaBand !== undefined)).toBe(false);
    expect(rows.some((r) => r.compraBand !== undefined)).toBe(false);
    // El ancla sigue en la serie proyectada, pero con su valor real: es el
    // único punto donde ambas coinciden y no afirma ningún futuro.
    expect(rows.filter((r) => r.ventaProjected !== undefined).map((r) => r.hour)).toEqual([10]);
  });
});

describe('el horizonte cruza medianoche sin confundir dos horas iguales', () => {
  /*
   * Ancla a la 1 AM con dos horas reales previas (0 y 1 de HOY) y un
   * horizonte que llega hasta la 1 AM de MAÑANA: la hora de reloj 0 y la hora
   * de reloj 1 aparecen entonces DOS VECES en el mismo informe. Si las filas
   * se emparejaran por `hour` en vez de por `step`, la fila proyectada de
   * mañana pisaría o se confundiría con la real de hoy.
   */
  const report: DailyProjectionResponse = {
    ...base(),
    dayKey: '2026-08-20',
    anchorHour: 1,
    legs: [
      legReport(
        'VENTA',
        'BUY',
        1,
        [
          { hour: 0, price: 900, movePct: null },
          { hour: 1, price: 901, movePct: 0.11 },
        ],
        [
          { hoursAhead: 23, hourOfDay: 0, dayKey: '2026-08-21', central: 910, movePct: 0.5 },
          { hoursAhead: 24, hourOfDay: 1, dayKey: '2026-08-21', central: 911, movePct: 0.11 },
        ]
      ),
      legReport('COMPRA', 'SELL', 1, [{ hour: 1, price: 895, movePct: null }], []),
    ],
  };

  const rows = buildRows(report);

  it('produce una fila distinta por cada paso, aunque la hora de reloj se repita', () => {
    expect(rows.map((r) => r.step)).toEqual([-1, 0, 23, 24]);
    // La hora 0 y la hora 1 aparecen CADA UNA dos veces —hoy real, mañana
    // proyectada—: son dos filas distintas, nunca una que pise a la otra.
    expect(rows.filter((r) => r.hour === 0)).toHaveLength(2);
    expect(rows.filter((r) => r.hour === 1)).toHaveLength(2);
  });

  it('la hora real de hoy y la proyectada de mañana no se mezclan', () => {
    const todayZero = rows.find((r) => r.step === -1)!;
    expect(todayZero.hour).toBe(0);
    expect(todayZero.dayKey).toBe('2026-08-20');
    expect(todayZero.ventaReal).toBe(900);
    expect(todayZero.ventaProjected).toBeUndefined();

    const tomorrowZero = rows.find((r) => r.step === 23)!;
    expect(tomorrowZero.hour).toBe(0);
    expect(tomorrowZero.dayKey).toBe('2026-08-21');
    expect(tomorrowZero.ventaReal).toBeUndefined();
    expect(tomorrowZero.ventaProjected).toBe(910);
  });

  it('el ancla (paso 0) es real, no proyección de otro día', () => {
    const anchor = rows.find((r) => r.step === 0)!;
    expect(anchor.hour).toBe(1);
    expect(anchor.dayKey).toBe('2026-08-20');
    expect(anchor.ventaReal).toBe(901);
    expect(anchor.ventaProjected).toBe(901); // copiado de lo real, no al revés
  });
});
