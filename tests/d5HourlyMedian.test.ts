/**
 * D5 — COHERENCIA ESTADÍSTICA DE LA AGREGACIÓN HORARIA
 *
 * `hourlyGrid.ts` resume cada hora por su MEDIANA; `dailyShape.ts` lo hacía por
 * el EXTREMO. Las dos rutas proyectan la misma referencia estratégica (D4) pero
 * con estadísticos horarios distintos, y el extremo es un estadístico de orden:
 * depende de cuántas capturas trajo la hora y lo domina un solo valor atípico.
 *
 * D5 alinea la ruta estratégica en MEDIANA conservando el extremo como dato
 * descriptivo, y mantiene EXTREME como modo por defecto para no cambiar en
 * silencio a ningún consumidor existente.
 */

import { describe, expect, it } from 'vitest';
import { historicalDayMoves } from '../server/dailyMetrics.js';
import {
  groupByDay,
  projectLeg,
  type HourSummary,
  type MakerLeg,
} from '../server/projection/dailyShape.js';
import type { SeriesPoint } from '../server/projection/series.js';

const at = (day: number, hour: number, min = 0) => Date.UTC(2026, 7, day, hour + 4, min, 0);

/** Las observaciones del enunciado: ocho valores tranquilos y uno atípico. */
const HORA = [966.80, 966.90, 967.00, 966.85, 966.95, 970.15, 966.88, 966.92];
const MEDIANA = 966.91; // (966.90 + 966.92) / 2
const pts = (values: number[], day = 20, hour = 9): SeriesPoint[] =>
  values.map((price, i) => ({ t: at(day, hour, i), price }));

const cell = (values: number[], leg: MakerLeg, summary?: HourSummary) =>
  groupByDay(pts(values), leg, summary)[0].hours.get(9)!;

/* ── A ─────────────────────────────────────────────────────────────── */
describe('A. compatibilidad: sin modo explícito se sigue usando EXTREME', () => {
  it('VENTA sin argumento = máximo; COMPRA sin argumento = mínimo', () => {
    expect(cell(HORA, 'VENTA').reference).toBe(970.15);
    expect(cell(HORA, 'COMPRA').reference).toBe(966.80);
  });

  it('y coincide exactamente con pedir EXTREME', () => {
    expect(cell(HORA, 'VENTA').reference).toBe(cell(HORA, 'VENTA', 'EXTREME').reference);
    expect(cell(HORA, 'COMPRA').reference).toBe(cell(HORA, 'COMPRA', 'EXTREME').reference);
  });
});

/* ── B y C ─────────────────────────────────────────────────────────── */
describe('B-C. MEDIAN es la mediana, y no depende de la pierna', () => {
  it('VENTA en MEDIAN da 966.91, no 970.15', () => {
    const c = cell(HORA, 'VENTA', 'MEDIAN');
    expect(c.reference).toBeCloseTo(MEDIANA, 10);
    expect(c.reference).not.toBe(970.15);
  });

  it('COMPRA en MEDIAN da la MISMA mediana', () => {
    expect(cell(HORA, 'COMPRA', 'MEDIAN').reference).toBeCloseTo(MEDIANA, 10);
  });

  it('la mediana es idéntica en ambas piernas: un nivel no tiene lado', () => {
    expect(cell(HORA, 'VENTA', 'MEDIAN').reference).toBe(cell(HORA, 'COMPRA', 'MEDIAN').reference);
  });
});

/* ── D ─────────────────────────────────────────────────────────────── */
describe('D. un extremo añadido no arrastra la mediana', () => {
  it('añadir 1200 mueve el extremo entero pero apenas la mediana', () => {
    const conOutlier = [...HORA, 1200];
    const venta = cell(conOutlier, 'VENTA', 'EXTREME').reference;
    const mediana = cell(conOutlier, 'VENTA', 'MEDIAN').reference;

    expect(venta).toBe(1200);                       // el extremo se lo lleva entero
    expect(mediana).toBeCloseTo(966.92, 10);        // la mediana se mueve 0.01
    expect(Math.abs(mediana - MEDIANA)).toBeLessThan(0.05);
  });

  it('un extremo bajo tampoco arrastra la mediana en COMPRA', () => {
    const conOutlier = [...HORA, 920.659];
    expect(cell(conOutlier, 'COMPRA', 'EXTREME').reference).toBe(920.659);
    expect(cell(conOutlier, 'COMPRA', 'MEDIAN').reference).toBeCloseTo(966.90, 10);
  });
});

/* ── E ─────────────────────────────────────────────────────────────── */
describe('E. EXTREME intacto, y `best` sobrevive en los dos modos', () => {
  it('best sigue siendo el extremo de la pierna aunque se pida MEDIAN', () => {
    const venta = cell(HORA, 'VENTA', 'MEDIAN');
    const compra = cell(HORA, 'COMPRA', 'MEDIAN');
    expect(venta.best).toBe(970.15);
    expect(compra.best).toBe(966.80);
    // Y la referencia es otra cosa: diagnóstico y referencia conviven.
    expect(venta.reference).not.toBe(venta.best);
  });

  it('observations y values reflejan todas las observaciones válidas', () => {
    const c = cell(HORA, 'VENTA', 'MEDIAN');
    expect(c.observations).toBe(HORA.length);
    expect(c.values).toEqual(HORA);
  });
});

/* ── F ─────────────────────────────────────────────────────────────── */
describe('F. projectLeg propaga el modo a la trayectoria y al ancla', () => {
  // Dos horas contiguas; en cada una, un valor atípico alto.
  const serie: SeriesPoint[] = [
    ...pts([966.80, 966.90, 967.00, 970.15], 20, 9),
    ...pts([967.10, 967.20, 967.30, 980.00], 20, 10),
  ];

  it('EXTREME ancla en el extremo; MEDIAN ancla en la mediana', () => {
    const extreme = projectLeg(serie, 'VENTA', at(20, 10, 59));
    const median = projectLeg(serie, 'VENTA', at(20, 10, 59), undefined, 'MEDIAN');

    expect(extreme.anchorPrice).toBe(980);
    expect(median.anchorPrice).toBeCloseTo(967.25, 10); // (967.20+967.30)/2
  });

  it('los movimientos horarios de `real` se calculan sobre el modo pedido', () => {
    const median = projectLeg(serie, 'VENTA', at(20, 10, 59), undefined, 'MEDIAN');
    const h9 = median.real.find((r) => r.hour === 9)!;
    const h10 = median.real.find((r) => r.hour === 10)!;

    expect(h9.price).toBeCloseTo(966.95, 10);  // (966.90+967.00)/2
    expect(h10.price).toBeCloseTo(967.25, 10);
    expect(h10.movePct).toBeCloseTo(((967.25 - 966.95) / 966.95) * 100, 8);

    // Con EXTREME ese mismo movimiento estaría dominado por 970.15 -> 980.
    const extreme = projectLeg(serie, 'VENTA', at(20, 10, 59));
    expect(extreme.real.find((r) => r.hour === 10)!.movePct).toBeCloseTo(
      ((980 - 970.15) / 970.15) * 100, 8
    );
  });
});

/* ── G ─────────────────────────────────────────────────────────────── */
describe('G. historicalDayMoves usa el mismo estadístico que se le pide', () => {
  const dias: SeriesPoint[] = [
    ...pts([900, 901, 950], 18, 9), ...pts([902, 903, 960], 18, 13),
    ...pts([900, 901, 950], 19, 9), ...pts([902, 903, 960], 19, 13),
  ];

  it('MEDIAN mide sobre medianas; EXTREME sobre extremos', () => {
    const extreme = historicalDayMoves(dias, 'VENTA', 9, 4);
    const median = historicalDayMoves(dias, 'VENTA', 9, 4, 'MEDIAN');

    // EXTREME: 950 -> 960. MEDIAN: 901 -> 903.
    expect(extreme[0]).toBeCloseTo(Math.abs((960 - 950) / 950) * 100, 8);
    expect(median[0]).toBeCloseTo(Math.abs((903 - 901) / 901) * 100, 8);
    expect(median[0]).not.toBeCloseTo(extreme[0], 4);
  });
});

/* ── H ─────────────────────────────────────────────────────────────── */
describe('H. los huecos horarios no fabrican movimientos', () => {
  const conHueco: SeriesPoint[] = [
    ...pts([966.9, 967.0], 20, 9),
    ...pts([967.4, 967.5], 20, 11), // la hora 10 no existe
  ];

  it('la hora ausente no se rellena, en ninguno de los dos modos', () => {
    for (const summary of ['EXTREME', 'MEDIAN'] as HourSummary[]) {
      const dia = groupByDay(conHueco, 'VENTA', summary)[0];
      expect([...dia.hours.keys()].sort((a, b) => a - b)).toEqual([9, 11]);
      expect(dia.hours.has(10)).toBe(false);
    }
  });

  it('no se calcula un movimiento 9 -> 11 como si fuese contiguo', () => {
    const p = projectLeg(conHueco, 'VENTA', at(20, 11, 59), undefined, 'MEDIAN');
    expect(p.real.find((r) => r.hour === 11)!.movePct).toBeNull();
  });
});

/* ── I ─────────────────────────────────────────────────────────────── */
describe('I. los valores inválidos no entran en la mediana', () => {
  it('NaN, Infinity, cero, negativos y timestamps rotos se descartan antes', () => {
    const sucio: SeriesPoint[] = [
      { t: at(20, 9, 0), price: 966.9 },
      { t: at(20, 9, 1), price: NaN },
      { t: at(20, 9, 2), price: Infinity },
      { t: at(20, 9, 3), price: 0 },
      { t: at(20, 9, 4), price: -5 },
      { t: NaN, price: 967.0 },
      { t: at(20, 9, 5), price: 967.1 },
    ];
    const c = groupByDay(sucio, 'VENTA', 'MEDIAN')[0].hours.get(9)!;

    expect(c.values).toEqual([966.9, 967.1]);
    expect(c.observations).toBe(2);
    expect(c.reference).toBeCloseTo(967.0, 10); // mediana de los DOS válidos
    expect(Number.isFinite(c.reference)).toBe(true);
  });
});
