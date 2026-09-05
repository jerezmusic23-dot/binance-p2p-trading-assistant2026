import { describe, expect, it } from 'vitest';
import { buildRows } from '../src/dailyChartRows.js';
import type { DailyProjectionResponse } from '../src/types.js';

const report = {
  dayKey: '2026-09-04',
  anchorHour: 22,
  horizonHours: 24,
  legs: [
    {
      projection: {
        leg: 'VENTA',
        real: [],
        projected: [
          { hoursAhead: 1, hourOfDay: 23, dayKey: '2026-09-04', central: 950, low: 949, high: 951 },
          { hoursAhead: 3, hourOfDay: 1, dayKey: '2026-09-05', central: 952, low: 950, high: 954 },
        ],
      },
    },
    { projection: { leg: 'COMPRA', real: [], projected: [] } },
  ],
} as unknown as DailyProjectionResponse;

describe('24h chart contract', () => {
  it('keeps +1 through +24 visible even when evidence is missing for some hours', () => {
    const rows = buildRows(report);
    expect(rows.map((row) => row.step)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(rows.find((row) => row.step === 1)?.ventaProjected).toBe(950);
    expect(rows.find((row) => row.step === 2)?.ventaProjected).toBeUndefined();
    expect(rows.find((row) => row.step === 2)?.dayKey).toBe('2026-09-05');
    expect(rows.find((row) => row.step === 3)?.ventaProjected).toBe(952);
    expect(rows.find((row) => row.step === 24)?.hour).toBe(22);
    expect(rows.find((row) => row.step === 24)?.dayKey).toBe('2026-09-05');
  });
});
