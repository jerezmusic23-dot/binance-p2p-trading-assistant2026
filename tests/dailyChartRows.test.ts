/**
 * LAS FILAS DE LA GRÁFICA DIARIA
 * ==============================
 *
 * Lo que se comprueba aquí es que la pantalla no pueda afirmar que algo ocurrió
 * cuando fue proyectado. Un precio proyectado colocado en el campo de lo real
 * dibujaría una línea continua sobre el futuro, y nadie lo notaría mirando el
 * gráfico: es el error caro de esta pantalla, así que va fijado con tests.
 */

import { describe, expect, it } from 'vitest';
import { buildRows, hourLabel } from '../src/dailyChartRows';
import type { DailyProjectionResponse } from '../src/types';

const base = (): DailyProjectionResponse => ({
  generatedAt: Date.UTC(2026, 7, 20, 16, 30),
  source: 'market_history.json',
  dayKey: '2026-08-20',
  startHour: 8,
  endHour: 20,
  anchorHour: 10,
  sides: [
    {
      tier: 'PERFIL_LIMITADO',
      side: 'BUY',
      anchorHour: 10,
      anchorPrice: 902,
      real: [
        { hour: 8, price: 900, observations: 5, movePct: null },
        { hour: 9, price: 901, observations: 5, movePct: 0.111 },
        { hour: 10, price: 902, observations: 3, movePct: 0.111 },
      ],
      projected: [
        { hour: 11, central: 905, low: 902, high: 908, bandKind: 'RANGO_OBSERVADO', daysUsed: 6, movePct: 0.33 },
        { hour: 12, central: 907, low: 903, high: 912, bandKind: 'RANGO_OBSERVADO', daysUsed: 6, movePct: 0.22 },
      ],
      profileDays: 6,
      candidateDays: 6,
      conditioned: false,
    },
    {
      tier: 'PERFIL_LIMITADO',
      side: 'SELL',
      anchorHour: 10,
      anchorPrice: 892,
      real: [{ hour: 10, price: 892, observations: 3, movePct: null }],
      projected: [
        { hour: 11, central: 894, low: 891, high: 897, bandKind: 'RANGO_OBSERVADO', daysUsed: 6, movePct: 0.22 },
      ],
      profileDays: 6,
      candidateDays: 6,
      conditioned: false,
    },
  ],
  extraction: {
    BUY: { recordsRead: 100, droppedLegacy: 0, droppedInvalid: 0 },
    SELL: { recordsRead: 100, droppedLegacy: 0, droppedInvalid: 0 },
  },
  ceiling: null,
  floor: null,
  maxSpread: null,
  market: { direction: 'SUBIENDO', speed: 'LENTO', changePct: 0.55, side: 'BUY' },
  turn: { pct: 0.2, sampleSize: 40 },
  turningNow: false,
  remainingPct: 40,
  watchWindow: null,
  tier: 'PERFIL_LIMITADO',
  tierText: 'artificial',
  validation: {
    comparisons: 0,
    profileWins: 0,
    persistenceWins: 0,
    ties: 0,
    pairs: 0,
    pValue: null,
    beatsPersistence: false,
  },
  daysMissing: 0,
});

describe('las horas se rotulan en formato de 12 horas', () => {
  it('cubre mediodía y medianoche sin producir un 0', () => {
    expect(hourLabel(8)).toBe('8 AM');
    expect(hourLabel(12)).toBe('12 PM');
    expect(hourLabel(20)).toBe('8 PM');
    expect(hourLabel(0)).toBe('12 AM');
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
    expect(at(9).buyReal).toBe(901);
    expect(at(9).buyProjected).toBeUndefined();
    expect(at(9).buyBand).toBeUndefined();
  });

  it('después del ancla sólo hay proyección, nunca un valor real', () => {
    expect(at(11).buyReal).toBeUndefined();
    expect(at(11).buyProjected).toBe(905);
    expect(at(11).buyBand).toEqual([902, 908]);
  });

  it('el ancla aparece en las dos series, con el precio REAL y sin banda', () => {
    expect(at(10).buyReal).toBe(902);
    expect(at(10).buyProjected).toBe(902); // copiado de lo real, no al revés
    expect(at(10).buyBand).toBeUndefined();
  });

  it('las horas sin evidencia quedan vacías en vez de heredar la de al lado', () => {
    // El día proyecta hasta las 12; de la 13 a la 20 no hay nada que dibujar.
    for (const hour of [13, 14, 15, 16, 17, 18, 19, 20]) {
      expect(at(hour).buyReal).toBeUndefined();
      expect(at(hour).buyProjected).toBeUndefined();
      expect(at(hour).buyBand).toBeUndefined();
    }
  });

  it('un lado con menos horas que el otro no toma prestadas las suyas', () => {
    // SELL no tiene las 8 ni las 9: la recompra sí, y no se copian.
    expect(at(8).buyReal).toBe(900);
    expect(at(8).sellReal).toBeUndefined();
    expect(at(9).sellReal).toBeUndefined();
  });
});

describe('el movimiento por hora dice si ya ocurrió', () => {
  const rows = buildRows(base());
  const at = (hour: number) => rows.find((r) => r.hour === hour)!;

  it('marca como real el movimiento de una hora vivida', () => {
    expect(at(9).movePct).toBeCloseTo(0.111, 6);
    expect(at(9).moveIsReal).toBe(true);
  });

  it('marca como esperado el de una hora proyectada', () => {
    expect(at(11).movePct).toBeCloseTo(0.33, 6);
    expect(at(11).moveIsReal).toBe(false);
  });

  it('la primera hora del día no inventa un movimiento anterior', () => {
    expect(at(8).movePct).toBeUndefined();
    expect(at(8).moveIsReal).toBeUndefined();
  });
});

describe('sin proyección, la gráfica sólo puede dibujar hechos', () => {
  it('un informe SOLO_HOY no produce ni una banda ni una línea punteada', () => {
    const report = base();
    report.tier = 'SOLO_HOY';
    for (const side of report.sides) {
      side.tier = 'SOLO_HOY';
      side.projected = [];
    }
    const rows = buildRows(report);
    expect(rows.some((r) => r.buyBand !== undefined)).toBe(false);
    expect(rows.some((r) => r.sellBand !== undefined)).toBe(false);
    // El ancla sigue apareciendo en la serie proyectada, pero con su valor real:
    // es el único punto donde ambas coinciden y no afirma ningún futuro.
    const projectedHours = rows.filter((r) => r.buyProjected !== undefined).map((r) => r.hour);
    expect(projectedHours).toEqual([report.anchorHour]);
  });
});
