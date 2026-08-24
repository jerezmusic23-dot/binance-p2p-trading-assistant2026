/**
 * FASE 1 - pure market statistics.
 *
 * These are not characterization tests: they assert the behaviour the strategy
 * engine requires. The headline case is the one that produced the 6.64% false
 * spread in production - a single 980 VES ad in a market trading at ~921.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OUTLIER_THRESHOLD,
  describeSide,
  detectOutliers,
  mean,
  median,
  medianAbsoluteDeviation,
  robustZScore,
  round2,
  signedSpreadPct,
  weightedAverage,
} from '../server/marketStatistics.js';

/** A realistic USDT/VES book: 19 ads around 921, matching the observed market. */
const MARKET_LEVEL = Array.from({ length: 19 }, (_, i) => 921.0 + i * 0.05);
/** The same book with the ad that caused the incident, as the 20th entry. */
const MARKET_WITH_OUTLIER = [...MARKET_LEVEL, 980.0];
/** Control: same 20 entries, but the 20th is an ordinary price. */
const MARKET_WITH_NORMAL = [...MARKET_LEVEL, 921.95];

describe('median', () => {
  it('returns the middle element for an odd count', () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([5])).toBe(5);
  });

  it('averages the two middle elements for an even count', () => {
    // The exact case from the spec: [1,2,3,4] -> 2.5, not 3.
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([10, 20])).toBe(15);
  });

  it('does not depend on the order the values arrive in', () => {
    // This is what makes the BUY side (sorted ascending) and the SELL side
    // (sorted descending) agree. The old implementation did not.
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([4, 3, 2, 1])).toBe(2.5);
    expect(median([3, 1, 4, 2])).toBe(2.5);
    expect(median([2, 4, 1, 3])).toBe(median([1, 2, 3, 4]));
  });

  it('never mutates the caller array', () => {
    const input = [4, 3, 2, 1];
    median(input);
    expect(input).toEqual([4, 3, 2, 1]);
  });

  it('returns null for an empty sample', () => {
    expect(median([])).toBeNull();
  });

  it('ignores non-finite values instead of poisoning the result', () => {
    expect(median([1, 2, NaN, 3, Infinity])).toBe(2);
  });
});

describe('mean', () => {
  it('averages a sample', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it('returns null for an empty sample', () => {
    expect(mean([])).toBeNull();
  });

  it('is dragged by an extreme value, unlike the median', () => {
    const withoutOutlier = mean(MARKET_LEVEL)!;
    const withOutlier = mean(MARKET_WITH_OUTLIER)!;
    expect(withOutlier - withoutOutlier).toBeGreaterThan(2.5);
  });
});

describe('weightedAverage', () => {
  it('weights each value by its liquidity', () => {
    // (918*100 + 919*300) / 400
    expect(
      weightedAverage([
        { value: 918, weight: 100 },
        { value: 919, weight: 300 },
      ])
    ).toBe(918.75);
  });

  it('returns null when the total weight is zero - undefined, not zero', () => {
    expect(
      weightedAverage([
        { value: 918, weight: 0 },
        { value: 921, weight: 0 },
      ])
    ).toBeNull();
    expect(weightedAverage([])).toBeNull();
  });

  it('skips samples with missing or negative weight', () => {
    expect(
      weightedAverage([
        { value: 900, weight: -5 },
        { value: 920, weight: 10 },
        { value: 999, weight: NaN },
      ])
    ).toBe(920);
  });
});

describe('medianAbsoluteDeviation', () => {
  it('measures dispersion around the median', () => {
    // median = 3; deviations = [2,1,0,1,2]; median of those = 1
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5])).toBe(1);
  });

  it('is 0 when most values are identical - that is dispersion zero, not an error', () => {
    expect(medianAbsoluteDeviation([921, 921, 921, 921])).toBe(0);
  });

  it('barely moves when one extreme value is added', () => {
    const before = medianAbsoluteDeviation(MARKET_LEVEL)!;
    const after = medianAbsoluteDeviation(MARKET_WITH_OUTLIER)!;
    expect(Math.abs(after - before)).toBeLessThan(0.2);
  });

  it('returns null for an empty sample', () => {
    expect(medianAbsoluteDeviation([])).toBeNull();
  });
});

describe('robustZScore', () => {
  it('scores a value against the sample it belongs to', () => {
    const score = robustZScore(980, MARKET_WITH_OUTLIER)!;
    expect(score).toBeGreaterThan(DEFAULT_OUTLIER_THRESHOLD);
  });

  it('scores a normal value near zero', () => {
    expect(Math.abs(robustZScore(921.45, MARKET_WITH_OUTLIER)!)).toBeLessThan(1);
  });

  it('returns null when the MAD is zero - refuses to divide by zero', () => {
    expect(robustZScore(980, [921, 921, 921, 921])).toBeNull();
  });

  it('returns null for a sample too small to judge', () => {
    expect(robustZScore(980, [921, 922])).toBeNull();
  });
});

describe('detectOutliers - the 980 VES incident', () => {
  it('flags the 980 ad in a market trading at 921', () => {
    const report = detectOutliers(MARKET_WITH_OUTLIER);

    expect(report.isDecidable).toBe(true);
    expect(report.outlierIndices).toEqual([19]); // the appended 980
    expect(report.median).toBeCloseTo(921.475, 3);
  });

  it('flags nothing in a book with no extreme ad', () => {
    expect(detectOutliers(MARKET_LEVEL).outlierIndices).toEqual([]);
  });

  it('reports indices into the ORIGINAL array, so nothing has to be deleted', () => {
    // The raw ad stays available for auditing; the caller only excludes it
    // from the strategic price.
    const values = [980.0, ...MARKET_LEVEL];
    const report = detectOutliers(values);

    expect(report.outlierIndices).toEqual([0]);
    expect(values).toHaveLength(20); // untouched
    expect(values[0]).toBe(980.0);
  });

  it('refuses to judge a sample that is too small', () => {
    const report = detectOutliers([921, 980]);
    expect(report.isDecidable).toBe(false);
    expect(report.outlierIndices).toEqual([]);
  });

  it('refuses to judge when every value is identical (MAD 0)', () => {
    const report = detectOutliers([921, 921, 921, 921, 980]);
    expect(report.isDecidable).toBe(false);
    expect(report.outlierIndices).toEqual([]);
  });

  it('honours a custom threshold', () => {
    expect(detectOutliers(MARKET_WITH_OUTLIER, 1000).outlierIndices).toEqual([]);
  });
});

describe('the median resists the outlier that the extremes do not', () => {
  it('moves the max by 58 VES and the median by exactly 0', () => {
    // Like-for-like: same 20 ads, only the last one differs (980 vs 921.95).
    // This isolates the outlier's influence from the odd/even count effect.
    const control = describeSide(MARKET_WITH_NORMAL);
    const dirty = describeSide(MARKET_WITH_OUTLIER);

    expect(dirty.max! - control.max!).toBeCloseTo(58.05, 2);
    expect(dirty.median).toBe(control.median); // 921.475 either way
    expect(dirty.median).toBe(921.475);
  });

  it('the mean IS dragged by the same ad that leaves the median untouched', () => {
    const control = describeSide(MARKET_WITH_NORMAL);
    const dirty = describeSide(MARKET_WITH_OUTLIER);

    expect(dirty.mean! - control.mean!).toBeGreaterThan(2.5);
    expect(dirty.median! - control.median!).toBe(0);
  });

  it('a strategic rate built on the median is not hostage to one ad', () => {
    // Excluding the flagged ad leaves the remaining 19, whose median differs
    // only by the count-parity step - never by the outlier's magnitude.
    const report = detectOutliers(MARKET_WITH_OUTLIER);
    const withoutOutliers = MARKET_WITH_OUTLIER.filter(
      (_, i) => !report.outlierIndices.includes(i)
    );
    expect(Math.abs(median(withoutOutliers)! - median(MARKET_WITH_OUTLIER)!)).toBeLessThan(0.05);
  });
});

describe('describeSide', () => {
  it('returns every descriptive statistic in one pass', () => {
    expect(describeSide([921, 919, 923, 920])).toEqual({
      count: 4,
      min: 919,
      max: 923,
      mean: 920.75,
      median: 920.5,
      mad: 1,
    });
  });

  it('returns nulls, not zeros, for an empty side', () => {
    expect(describeSide([])).toEqual({
      count: 0,
      min: null,
      max: null,
      mean: null,
      median: null,
      mad: null,
    });
  });
});

describe('signedSpreadPct', () => {
  it('computes ((venta - recompra) / recompra) * 100', () => {
    // The real market: repurchase 921.70, sale 921.79.
    expect(signedSpreadPct(921.79, 921.7)).toBeCloseTo(0.009765, 5);
  });

  it('KEEPS THE SIGN when selling below the cost of repurchasing', () => {
    // Math.abs() would report this as a 0.11% opportunity. It is a loss.
    const spread = signedSpreadPct(920.7, 921.7)!;
    expect(spread).toBeLessThan(0);
    expect(spread).toBeCloseTo(-0.1085, 4);
  });

  it('uses the repurchase price as the denominator, always', () => {
    // Cost of capital, not min(a,b): comparable across time and across banks.
    const venta = 1000;
    const recompra = 900;
    expect(signedSpreadPct(venta, recompra)).toBeCloseTo((100 / 900) * 100, 6);
    // Swapping the roles must NOT give the same magnitude.
    expect(Math.abs(signedSpreadPct(recompra, venta)!)).not.toBeCloseTo(
      signedSpreadPct(venta, recompra)!,
      6
    );
  });

  it('is exactly 0 when both sides match', () => {
    expect(signedSpreadPct(921.5, 921.5)).toBe(0);
  });

  it('returns null when either side is missing', () => {
    expect(signedSpreadPct(null, 921)).toBeNull();
    expect(signedSpreadPct(921, null)).toBeNull();
    expect(signedSpreadPct(undefined, undefined)).toBeNull();
  });

  it('returns null rather than dividing by a non-positive denominator', () => {
    expect(signedSpreadPct(921, 0)).toBeNull();
    expect(signedSpreadPct(921, -5)).toBeNull();
  });

  it('reproduces the production incident and shows the honest figure', () => {
    // What the dashboard showed: |919 - 980| / min(919,980) -> 6.64%
    const falseSpread = (Math.abs(919 - 980) / Math.min(919, 980)) * 100;
    expect(Number(falseSpread.toFixed(2))).toBe(6.64);

    // What the medians of the same book give instead.
    const recompra = median(MARKET_LEVEL)!;
    const venta = median(MARKET_WITH_OUTLIER)!;
    expect(Math.abs(signedSpreadPct(venta, recompra)!)).toBeLessThan(0.05);
  });
});

describe('round2', () => {
  it('rounds to the 2 decimals this market quotes in', () => {
    expect(round2(921.7049)).toBe(921.7);
    expect(round2(0.115)).toBe(0.12);
  });

  it('preserves null instead of turning it into 0', () => {
    expect(round2(null)).toBeNull();
    expect(round2(NaN)).toBeNull();
  });
});
