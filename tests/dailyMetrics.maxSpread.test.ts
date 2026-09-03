import { describe, expect, it } from 'vitest';
import { maxSpreadOf } from '../server/dailyMetrics.js';
import type { LegProjection } from '../server/projection/dailyShape.js';

function projection(
  real: Array<{ hour: number; price: number }>,
  projected: Array<{ hour: number; central: number }>
): LegProjection {
  return { real, projected } as unknown as LegProjection;
}

describe('maxSpreadOf', () => {
  it('chooses the highest signed spread, never the largest absolute loss', () => {
    const venta = projection(
      [
        { hour: 9, price: 100 },
        { hour: 10, price: 100.2 },
      ],
      []
    );
    const compra = projection(
      [
        { hour: 9, price: 108 },
        { hour: 10, price: 100 },
      ],
      []
    );

    const result = maxSpreadOf(venta, compra);

    expect(result?.hour).toBe(10);
    expect(result?.spreadPct).toBeCloseTo(0.2, 10);
    expect(result?.observed).toBe(true);
  });

  it('returns a negative spread when every aligned hour is a loss', () => {
    const venta = projection([{ hour: 9, price: 99 }], []);
    const compra = projection([{ hour: 9, price: 100 }], []);

    expect(maxSpreadOf(venta, compra)).toEqual({
      hour: 9,
      spreadPct: -1,
      observed: true,
    });
  });
});
