/**
 * WHAT THE SERIES IS DOING, AND WHEN THE ENGINE MUST REFUSE TO SAY.
 *
 * The failure mode this suite guards against is confident nonsense: a slope
 * fitted through four points, a "trend" that is one tick of jitter, a
 * probability attached to a pattern seen twice. Every refusal below is as much
 * a requirement as every detection.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_OBSERVATIONS_FOR_TREND,
  analyseTrend,
  detectExhaustion,
  slopeVesPerHour,
  typicalStep,
} from '../server/trendEngine.js';
import { STEP_MS, T0, oscillate, ramp, seriesFromBuyPrices } from './helpers/series.js';

describe('the arithmetic underneath', () => {
  it('regresses against elapsed time, not against the index', () => {
    // Two points an hour apart, 10 VES higher: 10 VES/hour, whatever the index.
    const slope = slopeVesPerHour([
      { t: T0, price: 900 },
      { t: T0 + 3_600_000, price: 910 },
    ]);
    expect(slope).toBeCloseTo(10, 6);
  });

  it('reports no slope when every observation shares an instant', () => {
    expect(
      slopeVesPerHour([
        { t: T0, price: 900 },
        { t: T0, price: 910 },
      ])
    ).toBeNull();
  });

  it('takes the MEDIAN step, so one jump cannot redefine calm', () => {
    const points = [900, 900.1, 900.2, 900.3, 908].map((price, i) => ({
      t: T0 + i * STEP_MS,
      price,
    }));
    // Steps: 0.1, 0.1, 0.1, 7.7 -> median 0.1, not the mean 2.0.
    expect(typicalStep(points)).toBeCloseTo(0.1, 6);
  });
});

describe('1 - tendencia alcista', () => {
  const state = analyseTrend(seriesFromBuyPrices(ramp(940, 946, 24)), 'BUY');

  it('is BULLISH with a positive velocity', () => {
    expect(state.trend).toBe('BULLISH');
    expect(state.velocity).toBeGreaterThan(0);
  });

  it('states its evidence rather than only its verdict', () => {
    expect(state.basis.join(' ')).toMatch(/Ventana corta/);
    expect(state.basis.join(' ')).toMatch(/Paso típico/);
    expect(state.trendConfidence).toBe('HIGH');
    expect(state.sampleSize).toBe(24);
  });
});

describe('2 - tendencia bajista', () => {
  it('is BEARISH with a negative velocity', () => {
    const state = analyseTrend(seriesFromBuyPrices(ramp(946, 940, 24)), 'BUY');
    expect(state.trend).toBe('BEARISH');
    expect(state.velocity).toBeLessThan(0);
  });
});

describe('3 - mercado lateral', () => {
  it('calls jitter SIDEWAYS instead of inventing a direction', () => {
    const state = analyseTrend(seriesFromBuyPrices(oscillate(940, 0.01, 24)), 'BUY');
    expect(state.trend).toBe('SIDEWAYS');
  });

  it('reports a genuinely unchanging series as SIDEWAYS, and says why', () => {
    const state = analyseTrend(seriesFromBuyPrices(Array(20).fill(940)), 'BUY');
    expect(state.trend).toBe('SIDEWAYS');
    expect(state.reason).toBe('NO_VARIATION_OBSERVED');
    expect(state.basis.join(' ')).toMatch(/no ha cambiado/);
  });
});

describe('4 - aceleración y 5 - desaceleración', () => {
  it('reports acceleration when the move is speeding up', () => {
    // Flat, then steepening.
    const prices = [...Array(10).fill(940), ...ramp(940, 944, 10)];
    const state = analyseTrend(seriesFromBuyPrices(prices), 'BUY');
    expect(state.acceleration).not.toBeNull();
    expect(state.acceleration as number).toBeGreaterThan(0);
  });

  it('reports deceleration when the move is running out', () => {
    // Steep, then flattening.
    const prices = [...ramp(940, 944, 10), ...ramp(944, 944.2, 10)];
    const state = analyseTrend(seriesFromBuyPrices(prices), 'BUY');
    // Measured against the medium window, not against the two halves of the
    // short one - inside the short window this stretch is a straight line.
    expect(state.acceleration as number).toBeLessThan(0);
  });
});

describe('6 - agotamiento', () => {
  it('flags a rise that is still rising but slowing', () => {
    const prices = [...ramp(940, 945, 14), 945.4, 945.6, 945.7, 945.75, 945.78, 945.8];
    const state = analyseTrend(seriesFromBuyPrices(prices), 'BUY');
    const exhaustion = detectExhaustion(state);

    /*
     * The medium window is still climbing while the short one has flattened,
     * which is what the trend reports as TRANSITION - and is exactly the
     * moment "posible agotamiento" describes. The direction that is running
     * out comes from the medium window, never from a guess.
     */
    expect(state.mediumDirection).toBe('BULLISH');
    expect(state.acceleration as number).toBeLessThan(0);
    expect(exhaustion.exhausted).toBe(true);
    expect(exhaustion.direction).toBe('BULLISH');
    expect(exhaustion.reason).toMatch(/más despacio/);
  });

  it('does not call a completed reversal an exhaustion', () => {
    // Rose, then genuinely turned down: that is a change, not a fade.
    const prices = [...ramp(940, 946, 16), ...ramp(946, 941, 10)];
    const state = analyseTrend(seriesFromBuyPrices(prices), 'BUY');
    expect((state.velocity as number) < 0).toBe(true);
    expect(detectExhaustion(state).exhausted).toBe(false);
  });

  it('does not flag exhaustion in a sideways market', () => {
    const state = analyseTrend(seriesFromBuyPrices(oscillate(940, 0.01, 24)), 'BUY');
    expect(detectExhaustion(state).exhausted).toBe(false);
  });
});

describe('7 - cambio de tendencia: la transición se nombra, no se aplasta', () => {
  it('reports TRANSITION when the two windows disagree', () => {
    // Long fall, then a recent turn upward.
    const prices = [...ramp(950, 940, 20), ...ramp(940, 943, 6)];
    const state = analyseTrend(seriesFromBuyPrices(prices), 'BUY');

    expect(state.shortDirection).toBe('BULLISH');
    expect(state.mediumDirection).not.toBe('BULLISH');
    expect(state.trend).toBe('TRANSITION');
  });
});

describe('10 - ausencia de datos y 11 - muestras insuficientes', () => {
  it('says NO_DATA when nothing is usable', () => {
    const state = analyseTrend([], 'BUY');
    expect(state.trend).toBe('UNKNOWN');
    expect(state.reason).toBe('NO_DATA');
    expect(state.velocity).toBeNull();
    expect(state.trendConfidence).toBe('NO_DATA');
  });

  it('says INSUFFICIENT_HISTORY below the minimum, and names the number', () => {
    const state = analyseTrend(seriesFromBuyPrices(ramp(940, 946, 3)), 'BUY');
    expect(state.reason).toBe('INSUFFICIENT_HISTORY');
    expect(state.trend).toBe('UNKNOWN');
    expect(state.basis[0]).toContain(String(MIN_OBSERVATIONS_FOR_TREND));
  });

  it('never returns a trendStrength it did not measure', () => {
    expect(analyseTrend([], 'BUY').trendStrength).toBeNull();
  });
});

describe('12 - datos irregulares', () => {
  it('skips null prices instead of interpolating across the gap', () => {
    const prices = [940, 941, null, null, 944, 945, 946, 947];
    const state = analyseTrend(seriesFromBuyPrices(prices), 'BUY');
    // Six real prices, not eight: the gap was not filled in.
    expect(state.sampleSize).toBe(6);
  });

  it('weights a long gap by its real duration, not as one step', () => {
    const dense = seriesFromBuyPrices(ramp(940, 941, 10), { stepMs: 60_000 });
    const sparse = seriesFromBuyPrices(ramp(940, 941, 10), { stepMs: 3_600_000 });

    const fast = analyseTrend(dense, 'BUY').velocity as number;
    const slow = analyseTrend(sparse, 'BUY').velocity as number;

    // Same move, 60x the elapsed time: 60x slower in VES/hour.
    expect(fast / slow).toBeCloseTo(60, 0);
  });
});

describe('the flat threshold is the cell own volatility, not a constant', () => {
  it('calls the same 0.5 VES move a trend in a calm cell and noise in a wild one', () => {
    // Calm cell: steps of 0.01, then a 0.5 drift -> a real move.
    const calm = analyseTrend(
      seriesFromBuyPrices([940, 940.01, 940.02, 940.03, 940.04, 940.3, 940.4, 940.5]),
      'BUY'
    );
    // Wild cell: steps of ~2 VES; a 0.5 net move is nothing.
    const wild = analyseTrend(
      seriesFromBuyPrices([940, 942, 940, 942, 940, 942, 940, 940.5]),
      'BUY'
    );

    expect(calm.trend).toBe('BULLISH');
    expect(wild.trend).not.toBe('BULLISH');
  });
});
