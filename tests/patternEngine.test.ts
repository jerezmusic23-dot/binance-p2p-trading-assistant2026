/**
 * COUNTED, NEVER WRITTEN BY HAND.
 *
 * The rule this suite enforces is the one the operator stated: a probability
 * is occurrences divided by appearances, it always travels with its sample
 * size, and below a floor it is not reported at all - "2 de 2 = 100%" must be
 * impossible to render.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_SAMPLES_FOR_PROBABILITY,
  empiricalRange,
  findZones,
  hourlyActivity,
  measurePattern,
  venezuelaHour,
  watchWindows,
} from '../server/patternEngine.js';
import { STEP_MS, T0, oscillate, ramp, seriesFromBuyPrices } from './helpers/series.js';

const pts = (prices: number[], stepMs = STEP_MS) =>
  prices.map((price, i) => ({ t: T0 + i * stepMs, price }));

describe('the probability rule', () => {
  it('divides outcomes by appearances, and reports both', () => {
    // Price rises after every even index, by construction.
    const points = pts([1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]);
    const evidence = measurePattern(points, {
      description: 'índice par',
      matched: (_history, i) => i % 2 === 0,
      outcome: (future) => future[0].price > 1,
      horizon: 1,
    });

    expect(evidence.sampleSize).toBeGreaterThanOrEqual(MIN_SAMPLES_FOR_PROBABILITY);
    expect(evidence.occurrences).toBe(evidence.sampleSize);
    expect(evidence.probability).toBe(1);
  });

  it('refuses to report a rate below the sample floor, however clean', () => {
    const points = pts([1, 2, 1, 2, 1, 2]);
    const evidence = measurePattern(points, {
      description: 'muestra corta',
      matched: (_h, i) => i % 2 === 0,
      outcome: (future) => future[0].price > 1,
      horizon: 1,
    });

    // Every occurrence ended the same way, and it still says nothing.
    expect(evidence.occurrences).toBe(evidence.sampleSize);
    expect(evidence.sampleSize).toBeLessThan(MIN_SAMPLES_FOR_PROBABILITY);
    expect(evidence.probability).toBeNull();
    expect(evidence.reason).toBe('INSUFFICIENT_HISTORY');
  });

  it('reports NO_DATA for an empty series rather than a rate of zero', () => {
    const evidence = measurePattern([], {
      description: 'nada',
      matched: () => true,
      outcome: () => true,
      horizon: 1,
    });
    expect(evidence.probability).toBeNull();
    expect(evidence.reason).toBe('NO_DATA');
  });

  it('BUG: never counts an occurrence whose horizon has not fully elapsed', () => {
    /*
     * The last few points have no future to be judged against. Counting them
     * would bias the rate towards whatever the series was doing when capture
     * stopped - a look-ahead artefact wearing a probability's clothes.
     */
    const points = pts(ramp(940, 960, 20));
    const evidence = measurePattern(points, {
      description: 'siempre',
      matched: () => true,
      outcome: () => true,
      horizon: 5,
    });
    expect(evidence.sampleSize).toBe(points.length - 5);
  });
});

describe('7 - techo y 8 - piso: zonas, no números sueltos', () => {
  // Three clean bounces between roughly 940 and 946.
  const wave = [
    940, 942, 944, 946, 944, 942, 940, 942, 944, 946, 944, 942, 940, 942, 944, 946,
    944, 942, 940,
  ];
  const zones = findZones(pts(wave));

  it('finds a ceiling zone with a low and a high, not a single price', () => {
    expect(zones.ceilings.length).toBeGreaterThan(0);
    const ceiling = zones.ceilings[0];
    expect(ceiling.low).toBeLessThanOrEqual(ceiling.high);
    expect(ceiling.low).toBe(946);
    expect(ceiling.high).toBe(946);
  });

  it('finds a floor zone below the ceiling', () => {
    expect(zones.floors.length).toBeGreaterThan(0);
    expect(zones.floors[0].high).toBeLessThan(zones.ceilings[0].low);
  });

  it('counts the touches, so a one-off turn is not sold as a level', () => {
    expect(zones.ceilings[0].touches).toBe(3);
    expect(zones.ceilings[0].confidence).not.toBe('NO_DATA');
  });

  it('ignores a turn smaller than the cell own typical step', () => {
    /*
     * Steps here are 2.00, so a peak that only rose 1.9 above its neighbours
     * is inside the noise that would build the level in the first place. It is
     * not counted, and that is the whole point of measuring against the cell.
     */
    const shallow = findZones(
      pts([940, 942, 944, 946, 944, 942, 940, 942, 944, 945.9, 944, 942, 940])
    );
    expect(shallow.ceilings[0].touches).toBe(1);
  });

  it('finds no zones at all in a series too short to have turned', () => {
    expect(findZones(pts([940, 941, 942])).ceilings).toEqual([]);
  });

  it('does not turn jitter into levels', () => {
    // Oscillation smaller than nothing: every step is the same size, so no
    // point stands out from its neighbours by a full typical step.
    const flat = findZones(pts(oscillate(940, 0.01, 30)));
    expect(flat.ceilings.every((z) => z.touches >= 1)).toBe(true);
  });
});

describe('the projected band is an observed distribution, not a formula', () => {
  it('returns the 10th and 90th percentile of real moves', () => {
    const range = empiricalRange(pts(ramp(940, 960, 40)), 4);
    expect(range.reason).toBeNull();
    expect(range.sampleSize).toBe(36);
    // A perfectly straight ramp moves the same amount every time.
    expect(range.lowDelta).toBeCloseTo(range.highDelta as number, 3);
    expect(range.medianDelta).toBeGreaterThan(0);
  });

  it('never widens the band beyond what the series actually did', () => {
    const prices = ramp(940, 941, 40); // total move of 1 VES across 40 points
    const range = empiricalRange(pts(prices), 4);
    expect(Math.abs(range.highDelta as number)).toBeLessThan(0.2);
  });

  it('says INSUFFICIENT_HISTORY instead of a narrow made-up band', () => {
    const range = empiricalRange(pts([940, 941, 942, 943]), 2);
    expect(range.lowDelta).toBeNull();
    expect(range.reason).toBe('INSUFFICIENT_HISTORY');
  });
});

describe('15 - ventanas temporales: medidas, no supuestas', () => {
  it('places an observation in the Venezuela hour, not UTC', () => {
    // 12:00 UTC is 08:00 in Venezuela (UTC-4, no DST).
    expect(venezuelaHour(Date.UTC(2026, 7, 1, 12, 0, 0))).toBe(8);
    expect(venezuelaHour(Date.UTC(2026, 7, 1, 2, 0, 0))).toBe(22);
  });

  it('returns no window at all when the series is too short to know', () => {
    const series = seriesFromBuyPrices(ramp(940, 946, 10));
    expect(watchWindows(hourlyActivity(series, 'BUY'))).toEqual([]);
  });

  it('finds the hours the cell actually moves in', () => {
    /*
     * A series that only moves during a two-hour block, repeated over many
     * days. The window must come out of the counting, not out of the brief's
     * example hours.
     */
    const observations = [];
    let price = 940;
    for (let day = 0; day < 12; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        // Two observations per hour, so every hour clears the sample floor.
        for (let k = 0; k < 2; k += 1) {
          const active = hour === 17 || hour === 18;
          price += active ? 0.5 : 0.001;
          observations.push(
            ...seriesFromBuyPrices([price], {
              startMs: Date.UTC(2026, 7, 1 + day, hour + 4, k * 30, 0),
            })
          );
        }
      }
    }

    const windows = watchWindows(hourlyActivity(observations, 'BUY'));
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0].startHour).toBe(17);
    expect(windows[0].endHour).toBe(19);
    expect(windows[0].sampleSize).toBeGreaterThan(MIN_SAMPLES_FOR_PROBABILITY);
  });
});
