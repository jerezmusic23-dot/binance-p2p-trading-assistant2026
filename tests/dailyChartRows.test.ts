/**
 * LAS FILAS DE LA GRÁFICA DIARIA
 * ==============================
 *
 * Lo que se comprueba es que la pantalla no pueda afirmar que algo ocurrió
 * cuando fue proyectado, y que la serie de MI VENTA no se dibuje jamás con
 * datos de MI COMPRA. Un precio proyectado colocado en el campo de lo real
 * trazaría una línea continua sobre el futuro y nadie lo notaría mirando el
 * gráfico.
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
  real: { hour: number; price: number; movePct: number | null }[],
  projected: { hour: number; central: number; movePct: number | null }[]
): DailyLegReport => ({
  projection: {
    leg,
    binanceSide,
    tier: 'PERFIL_LIMITADO',
    anchorHour: 10,
    anchorPrice: real.length > 0 ? real[real.length - 1].price : null,
    real: real.map((r) => ({ ...r, observations: 3 })),
    observedExtreme: real.length > 0 ? { price: real[0].price, hour: real[0].hour } : null,
    projected: projected.map((p) => ({ ...q(p.central, p.central - 3, p.central + 3), hour: p.hour, movePct: p.movePct })),
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
  startHour: 8,
  endHour: 20,
  anchorHour: 10,
  legs: [
    legReport(
      'VENTA',
      'BUY',
      [
        { hour: 8, price: 936, movePct: null },
        { hour: 9, price: 937, movePct: 0.107 },
        { hour: 10, price: 938, movePct: 0.107 },
      ],
      [
        { hour: 11, central: 940, movePct: 0.21 },
        { hour: 12, central: 941, movePct: 0.11 },
      ]
    ),
    legReport('COMPRA', 'SELL', [{ hour: 10, price: 931, movePct: null }], [
      { hour: 11, central: 930, movePct: -0.11 },
    ]),
  ],
  ceiling: {
    leg: 'VENTA',
    binanceSide: 'BUY',
    observed: { price: 938, hour: 10 },
    projected: { price: 941, low: 938, high: 944, daysUsed: 6 },
    dayBest: 941,
    dayBestIsProjected: true,
  },
  floor: {
    leg: 'COMPRA',
    binanceSide: 'SELL',
    observed: { price: 931, hour: 10 },
    projected: { price: 930, low: 927, high: 933, daysUsed: 6 },
    dayBest: 930,
    dayBestIsProjected: true,
  },
  maxSpread: { hour: 10, spreadPct: 0.75, observed: true },
  turn: { pct: 0.2, sampleSize: 40 },
  turningNow: false,
  remainingPct: 40,
  watchWindow: null,
  tier: 'PERFIL_LIMITADO',
  tierText: 'artificial',
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

describe('lo real y lo proyectado no se mezclan', () => {
  const rows = buildRows(base());
  const at = (hour: number) => rows.find((r) => r.hour === hour)!;

  it('hay una fila por hora de la ventana, ni una más', () => {
    expect(rows).toHaveLength(13);
    expect(rows[0].hour).toBe(8);
    expect(rows[rows.length - 1].hour).toBe(20);
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

  it('las horas sin evidencia quedan vacías en vez de heredar la de al lado', () => {
    for (const hour of [13, 14, 15, 16, 17, 18, 19, 20]) {
      expect(at(hour).ventaReal).toBeUndefined();
      expect(at(hour).ventaProjected).toBeUndefined();
      expect(at(hour).ventaBand).toBeUndefined();
    }
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
