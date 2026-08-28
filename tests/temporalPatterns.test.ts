/**
 * WHAT HAPPENED NEXT, COUNTED BY WHEN.
 *
 * "68% de las veces continuó alcista" is only allowed to appear when 68% is
 * occurrences over appearances and the appearances are counted. This suite
 * pins that, and pins the refusals: an unmeasured day reports its emptiness
 * rather than borrowing the week's average.
 */

import { describe, expect, it } from 'vitest';
import {
  DAY_NAMES,
  MIN_SAMPLES_FOR_PROBABILITY,
  outcomesByDay,
  outcomesInWindow,
  venezuelaDay,
} from '../server/patternEngine.js';
import { observation } from './helpers/series.js';
import type { HistoricalObservation } from '../server/historicalMarketStore.js';

/** Observations every half hour from a given UTC start. */
function halfHourly(prices: number[], startUtc: number): HistoricalObservation[] {
  return prices.map((price, i) =>
    observation({
      timestamp: startUtc + i * 1_800_000,
      buyRecommendedPrice: price,
      sellRecommendedPrice: price + 5,
    })
  );
}

describe('the Venezuela calendar', () => {
  it('places a timestamp on the right day, not the UTC one', () => {
    // 2026-08-02 02:00 UTC is Saturday 22:00 in Venezuela (UTC-4).
    expect(venezuelaDay(Date.UTC(2026, 7, 2, 2, 0, 0))).toBe(6);
    expect(DAY_NAMES[6]).toBe('sábado');
    expect(venezuelaDay(Date.UTC(2026, 7, 2, 12, 0, 0))).toBe(0);
  });
});

describe('outcome distributions are counted, never asserted', () => {
  it('counts up, flat and down over the horizon', () => {
    // Monotonic rise: every window ends higher than it started.
    const series = halfHourly(
      Array.from({ length: 40 }, (_, i) => Number((940 + i * 0.5).toFixed(2))),
      Date.UTC(2026, 7, 3, 12, 0, 0)
    );

    const outcomes = outcomesInWindow(series, 'BUY', { horizon: 4, description: 'todo' });

    expect(outcomes.sampleSize).toBe(36);
    expect(outcomes.up).toBe(36);
    expect(outcomes.upRate).toBe(1);
    expect(outcomes.downRate).toBe(0);
    expect(outcomes.reason).toBeNull();
  });

  it('calls a move within one typical step FLAT, using the cell own step', () => {
    /*
     * Steps of 0.5 with a couple of tiny wobbles: the wobbles are inside one
     * step and must not be counted as direction.
     */
    const prices = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 940 : 940.01));
    const series = halfHourly(prices, Date.UTC(2026, 7, 3, 12, 0, 0));

    const outcomes = outcomesInWindow(series, 'BUY', { horizon: 2, description: 'plano' });
    expect(outcomes.flat).toBe(outcomes.sampleSize);
    expect(outcomes.flatRate).toBe(1);
  });

  it('refuses a rate below the sample floor, however consistent', () => {
    const series = halfHourly([940, 941, 942, 943, 944], Date.UTC(2026, 7, 3, 12, 0, 0));
    const outcomes = outcomesInWindow(series, 'BUY', { horizon: 2, description: 'corta' });

    expect(outcomes.sampleSize).toBeLessThan(MIN_SAMPLES_FOR_PROBABILITY);
    expect(outcomes.upRate).toBeNull();
    expect(outcomes.reason).toBe('INSUFFICIENT_HISTORY');
  });

  it('says NO_DATA for an empty series rather than zero rates', () => {
    const outcomes = outcomesInWindow([], 'BUY', { horizon: 2, description: 'vacía' });
    expect(outcomes.reason).toBe('NO_DATA');
    expect(outcomes.upRate).toBeNull();
  });

  it('BUG: never counts an observation whose horizon has not elapsed', () => {
    const series = halfHourly(
      Array.from({ length: 20 }, (_, i) => 940 + i),
      Date.UTC(2026, 7, 3, 12, 0, 0)
    );
    const outcomes = outcomesInWindow(series, 'BUY', { horizon: 5, description: 'todo' });
    expect(outcomes.sampleSize).toBe(15);
  });
});

describe('restricting to hours and days', () => {
  it('counts only the observations inside the requested hours', () => {
    const series = halfHourly(
      Array.from({ length: 96 }, (_, i) => Number((940 + i * 0.1).toFixed(2))),
      // 12:00 UTC = 08:00 Venezuela.
      Date.UTC(2026, 7, 3, 12, 0, 0)
    );

    const all = outcomesInWindow(series, 'BUY', { horizon: 2, description: 'todo' });
    const restricted = outcomesInWindow(series, 'BUY', {
      horizon: 2,
      hours: [8, 9],
      description: '08-10',
    });

    expect(restricted.sampleSize).toBeLessThan(all.sampleSize);
    expect(restricted.sampleSize).toBeGreaterThan(0);
  });
});

describe('by day of week', () => {
  const series = halfHourly(
    Array.from({ length: 400 }, (_, i) => Number((940 + i * 0.05).toFixed(2))),
    Date.UTC(2026, 7, 3, 12, 0, 0)
  );
  const byDay = outcomesByDay(series, 'BUY', 4);

  it('reports all seven days, including the unmeasured ones', () => {
    expect(byDay).toHaveLength(7);
    expect(byDay.map((d) => d.dayName)).toEqual([...DAY_NAMES]);
  });

  it('gives a measured day a rate, and an unmeasured one a reason', () => {
    const measured = byDay.filter((d) => d.outcomes.reason === null);
    const unmeasured = byDay.filter((d) => d.outcomes.reason !== null);

    expect(measured.length).toBeGreaterThan(0);
    for (const day of measured) {
      expect(day.outcomes.upRate).not.toBeNull();
      expect(day.outcomes.sampleSize).toBeGreaterThanOrEqual(MIN_SAMPLES_FOR_PROBABILITY);
    }
    for (const day of unmeasured) {
      // An unmeasured day borrows nothing from the week's average.
      expect(day.outcomes.upRate).toBeNull();
    }
  });

  it('never lets the three rates disagree with the counts', () => {
    for (const day of byDay) {
      if (day.outcomes.reason !== null) continue;
      const total = day.outcomes.up + day.outcomes.flat + day.outcomes.down;
      expect(total).toBe(day.outcomes.sampleSize);
      expect(
        (day.outcomes.upRate as number) +
          (day.outcomes.flatRate as number) +
          (day.outcomes.downRate as number)
      ).toBeCloseTo(1, 10);
    }
  });
});
