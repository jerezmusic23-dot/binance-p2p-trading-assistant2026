/**
 * PRUEBA OBLIGATORIA DE MEDIANOCHE
 * =================================
 *
 * Cuatro casos, literales, pedidos explícitamente para fijar que el motor de
 * proyección diaria (dailyShape.ts / dayIndex.ts) trata el cruce de
 * medianoche como una distancia de tiempo real y nunca como una resta de
 * horas de reloj:
 *
 *   A. 23:00, 23:30, 00:00, 00:30, 01:00 mantienen el orden temporal correcto.
 *   B. Ancla 23:00, proyección 00:00  -> +1 hora,  NUNCA -23 horas.
 *   C. Ancla 22:00, proyección 01:00  -> +3 horas.
 *   D. Ancla 00:00, proyección 23:00  -> +23 horas.
 *
 * Todos usan las mismas primitivas que projectLeg/buildDailyProjection en
 * producción (hourCellAhead, buildDayIndex, groupByDay, venezuelaDayKey/Hour),
 * no una reimplementación paralela.
 */

import { describe, expect, it } from 'vitest';
import { groupByDay } from '../server/projection/dailyShape.js';
import type { SeriesPoint } from '../server/projection/series.js';
import { buildDayIndex, hourCellAhead, hourStartMs } from '../server/projection/dayIndex.js';
import { venezuelaDayKey, venezuelaHourOf } from '../server/projection/venezuelaClock.js';

/** Venezuela es UTC-4 fijo: HH:00 local del día `d` (2026-08-0`d`) = (HH+4):00 UTC. */
const vene = (day: number, hour: number, minute = 0): number =>
  Date.UTC(2026, 7, day, hour + 4, minute, 0);

describe('Caso A — 23:00, 23:30, 00:00, 00:30, 01:00 mantienen el orden temporal', () => {
  it('las cinco observaciones se agrupan en el día y la hora correctos, en orden', () => {
    const points: SeriesPoint[] = [
      { t: vene(1, 23, 0), price: 940 },
      { t: vene(1, 23, 30), price: 941 },
      { t: vene(2, 0, 0), price: 942 },
      { t: vene(2, 0, 30), price: 943 },
      { t: vene(2, 1, 0), price: 944 },
    ];

    // Orden temporal real: cada timestamp es estrictamente mayor que el anterior.
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].t).toBeGreaterThan(points[i - 1].t);
    }

    // Y cada uno se lee como la hora de reloj y el día calendario que le
    // corresponde - 23:30 sigue siendo el día 1, 00:30 ya es el día 2.
    expect(venezuelaDayKey(points[0].t)).toBe('2026-08-01');
    expect(venezuelaHourOf(points[0].t)).toBe(23);
    expect(venezuelaDayKey(points[1].t)).toBe('2026-08-01');
    expect(venezuelaHourOf(points[1].t)).toBe(23);
    expect(venezuelaDayKey(points[2].t)).toBe('2026-08-02');
    expect(venezuelaHourOf(points[2].t)).toBe(0);
    expect(venezuelaDayKey(points[3].t)).toBe('2026-08-02');
    expect(venezuelaHourOf(points[3].t)).toBe(0);
    expect(venezuelaDayKey(points[4].t)).toBe('2026-08-02');
    expect(venezuelaHourOf(points[4].t)).toBe(1);

    // groupByDay produce DOS días distintos, no uno mezclado: la hora 23 del
    // día 1 (con el mejor de sus dos observaciones, 941) y las horas 0 y 1
    // del día 2 - nunca una sola jornada "24:00-25:00" inventada.
    const days = groupByDay(points, 'VENTA');
    expect(days.map((d) => d.dayKey)).toEqual(['2026-08-01', '2026-08-02']);
    expect(days[0].hours.get(23)?.best).toBe(941);
    expect(days[1].hours.get(0)?.best).toBe(943);
    expect(days[1].hours.get(1)?.best).toBe(944);
  });
});

describe('Caso B — ancla 23:00, proyección 00:00 => +1 hora, nunca -23 horas', () => {
  it('hourCellAhead resuelve la 00:00 siguiente como hoursAhead=1', () => {
    const days = groupByDay(
      [
        { t: vene(1, 23, 0), price: 940 },
        { t: vene(2, 0, 0), price: 941 },
      ],
      'VENTA'
    );
    const index = buildDayIndex(days);

    const oneHourAhead = hourCellAhead(index, '2026-08-01', 23, 1);
    expect(oneHourAhead).toBeDefined();
    expect(oneHourAhead!.dayKey).toBe('2026-08-02');
    expect(oneHourAhead!.hour).toBe(0);
    expect(oneHourAhead!.cell.best).toBe(941);

    // La distancia es +1, un entero positivo pequeño - nunca -23. No hay
    // ninguna resta de horas de reloj (0 - 23) en este camino.
    const distanceHours = (hourStartMs('2026-08-02', 0) - hourStartMs('2026-08-01', 23)) / 3_600_000;
    expect(distanceHours).toBe(1);
    expect(distanceHours).not.toBe(-23);
  });
});

describe('Caso C — ancla 22:00, proyección 01:00 => +3 horas', () => {
  it('hourCellAhead resuelve la 01:00 del día siguiente como hoursAhead=3', () => {
    const days = groupByDay(
      [
        { t: vene(1, 22, 0), price: 950 },
        { t: vene(2, 1, 0), price: 952 },
      ],
      'VENTA'
    );
    const index = buildDayIndex(days);

    const threeHoursAhead = hourCellAhead(index, '2026-08-01', 22, 3);
    expect(threeHoursAhead).toBeDefined();
    expect(threeHoursAhead!.dayKey).toBe('2026-08-02');
    expect(threeHoursAhead!.hour).toBe(1);
    expect(threeHoursAhead!.cell.best).toBe(952);

    const distanceHours = (hourStartMs('2026-08-02', 1) - hourStartMs('2026-08-01', 22)) / 3_600_000;
    expect(distanceHours).toBe(3);
  });
});

describe('Caso D — ancla 00:00, proyección 23:00 => +23 horas', () => {
  it('hourCellAhead resuelve la 23:00 del MISMO día calendario como hoursAhead=23', () => {
    const days = groupByDay(
      [
        { t: vene(1, 0, 0), price: 930 },
        { t: vene(1, 23, 0), price: 936 },
      ],
      'VENTA'
    );
    const index = buildDayIndex(days);

    const twentyThreeAhead = hourCellAhead(index, '2026-08-01', 0, 23);
    expect(twentyThreeAhead).toBeDefined();
    expect(twentyThreeAhead!.dayKey).toBe('2026-08-01');
    expect(twentyThreeAhead!.hour).toBe(23);
    expect(twentyThreeAhead!.cell.best).toBe(936);

    const distanceHours = (hourStartMs('2026-08-01', 23) - hourStartMs('2026-08-01', 0)) / 3_600_000;
    expect(distanceHours).toBe(23);
  });

  it('y si el ancla de las 00:00 avanza un día completo (+24h), cae en la 00:00 del día SIGUIENTE', () => {
    // Contraste explícito: +23h se queda en el mismo día; +24h ya cruza.
    const days = groupByDay(
      [
        { t: vene(1, 0, 0), price: 930 },
        { t: vene(2, 0, 0), price: 933 },
      ],
      'VENTA'
    );
    const index = buildDayIndex(days);
    const twentyFourAhead = hourCellAhead(index, '2026-08-01', 0, 24);
    expect(twentyFourAhead).toBeDefined();
    expect(twentyFourAhead!.dayKey).toBe('2026-08-02');
    expect(twentyFourAhead!.hour).toBe(0);
    expect(twentyFourAhead!.cell.best).toBe(933);
  });
});
