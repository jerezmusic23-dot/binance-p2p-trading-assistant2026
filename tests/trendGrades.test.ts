/**
 * THE SEVEN-LEVEL READING, THE THREE HORIZONS, AND THE DISAGREEMENT.
 *
 * The adjective ("strong", "weak") is graded against the CELL'S OWN noise, so
 * the same 0.5 VES move can be STRONG_UP in a calm cell and LATERAL in a wild
 * one. That is the property this suite exists to protect: no VES threshold is
 * ever hardcoded, because one would be wrong for every cell but one.
 */

import { describe, expect, it } from 'vitest';
import {
  GRADE_MODERATE_MULTIPLE,
  GRADE_STRONG_MULTIPLE,
  analyseTrend,
  gradeOf,
  noiseMultiple,
} from '../server/trendEngine.js';
import { T0, STEP_MS, oscillate, ramp, seriesFromBuyPrices } from './helpers/series.js';

describe('the grading scale', () => {
  it('is LATERAL inside the cell own noise', () => {
    expect(gradeOf(0)).toBe('LATERAL');
    expect(gradeOf(0.9)).toBe('LATERAL');
    expect(gradeOf(-1)).toBe('LATERAL');
  });

  it('grades by how many multiples of that noise the move covered', () => {
    expect(gradeOf(1.5)).toBe('WEAK_UP');
    expect(gradeOf(GRADE_MODERATE_MULTIPLE)).toBe('UP');
    expect(gradeOf(GRADE_STRONG_MULTIPLE)).toBe('STRONG_UP');
    expect(gradeOf(-1.5)).toBe('WEAK_DOWN');
    expect(gradeOf(-GRADE_MODERATE_MULTIPLE)).toBe('DOWN');
    expect(gradeOf(-GRADE_STRONG_MULTIPLE)).toBe('STRONG_DOWN');
  });

  it('says UNKNOWN rather than LATERAL when there is nothing to measure', () => {
    expect(gradeOf(null)).toBe('UNKNOWN');
    expect(noiseMultiple([], 0.01)).toBeNull();
    expect(noiseMultiple([{ t: T0, price: 1 }, { t: T0 + 1, price: 2 }], null)).toBeNull();
    expect(noiseMultiple([{ t: T0, price: 1 }, { t: T0 + 1, price: 2 }], 0)).toBeNull();
  });
});

describe('the grade is relative to the cell, never to a VES constant', () => {
  it('calls the same move strong in a calm cell and lateral in a wild one', () => {
    // Calm: steps of 0.01, then a sustained climb of 0.5.
    const calm = analyseTrend(
      seriesFromBuyPrices([940, 940.01, 940.02, 940.03, 940.15, 940.3, 940.45, 940.5]),
      'BUY'
    );
    // Wild: swings of 2 VES; the same 0.5 net move is nothing here.
    const wild = analyseTrend(
      seriesFromBuyPrices([940, 942, 940, 942, 940, 942, 940, 940.5]),
      'BUY'
    );

    expect(['UP', 'STRONG_UP', 'WEAK_UP']).toContain(calm.grade);
    expect(wild.grade).toBe('LATERAL');
  });
});

describe('three horizons, always reported', () => {
  const state = analyseTrend(seriesFromBuyPrices(ramp(940, 946, 30)), 'BUY');

  it('reports very short, short and medium', () => {
    expect(state.horizons.map((h) => h.name)).toEqual(['VERY_SHORT', 'SHORT', 'MEDIUM']);
  });

  it('states the real time each window covers, not an assumed cadence', () => {
    for (const horizon of state.horizons) {
      expect(horizon.observations).toBeGreaterThan(1);
      expect(horizon.spanMs).toBe((horizon.observations - 1) * STEP_MS);
    }
  });

  it('carries a grade and a velocity per horizon', () => {
    for (const horizon of state.horizons) {
      expect(horizon.grade).not.toBe('UNKNOWN');
      expect(horizon.velocity).not.toBeNull();
    }
  });
});

describe('disagreement between horizons is the finding, not a problem', () => {
  it('names a short-term push inside a flat market', () => {
    /*
     * The push has to be big enough to clear the noise over 6 observations and
     * small enough not to over 20 - which is precisely what "short-term push
     * inside a flat market" means, and why the threshold has to scale with the
     * window rather than being a fixed number of VES.
     */
    const state = analyseTrend(
      seriesFromBuyPrices([...oscillate(940, 0.02, 40), ...ramp(940, 940.12, 6)]),
      'BUY'
    );

    expect(state.divergence).not.toBeNull();
    expect(state.divergence).toMatch(/corto plazo/i);
    expect(state.basis.join(' ')).toContain(state.divergence as string);
  });

  it('names a background trend that has gone flat recently', () => {
    const state = analyseTrend(
      seriesFromBuyPrices([...ramp(940, 946, 20), ...oscillate(946, 0.02, 6)]),
      'BUY'
    );

    expect(state.divergence).not.toBeNull();
    expect(state.divergence).toMatch(/fondo|plana/i);
  });

  it('leaves divergence null when the horizons agree', () => {
    const state = analyseTrend(seriesFromBuyPrices(ramp(940, 946, 30)), 'BUY');
    expect(state.divergence).toBeNull();
  });
});

describe('an unreadable series grades as UNKNOWN', () => {
  it('reports UNKNOWN and no horizons at all', () => {
    const state = analyseTrend([], 'BUY');
    expect(state.grade).toBe('UNKNOWN');
    expect(state.horizons).toEqual([]);
    expect(state.divergence).toBeNull();
  });
});
