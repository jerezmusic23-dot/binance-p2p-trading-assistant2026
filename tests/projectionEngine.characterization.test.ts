/**
 * CHARACTERIZATION TESTS - server/projectionEngine.ts
 *
 * Freezes the engine's current output shape and its known-defective
 * behaviours before the Phase 2 (remove fabricated data) and Phase 6 (new
 * predictionEngine) work.
 *
 * "BUG:" tests assert what the code does TODAY and cite the audit finding.
 * They must be updated deliberately when the behaviour is fixed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProjectionEngine } from '../server/projectionEngine.js';
import { makeHistory, makeSnapshot, makeNormalizedAd } from './helpers/fixtures.js';

// 2026-08-23T16:00:00Z == 12:00 VET (UTC-4), inside the 8:00-20:00 session.
const FIXED_NOW = Date.parse('2026-08-23T16:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getVenezuelaHour', () => {
  it('converts UTC to America/Caracas (UTC-4)', () => {
    expect(ProjectionEngine.getVenezuelaHour(Date.parse('2026-08-23T16:00:00Z'))).toBe(12);
    expect(ProjectionEngine.getVenezuelaHour(Date.parse('2026-08-23T02:00:00Z'))).toBe(22);
  });

  it('normalises midnight to 0 rather than 24', () => {
    expect(ProjectionEngine.getVenezuelaHour(Date.parse('2026-08-23T04:00:00Z'))).toBe(0);
  });
});

describe('analyzeMarket', () => {
  it('returns the full MarketAnalysis contract', () => {
    const analysis = ProjectionEngine.analyzeMarket(makeSnapshot(), makeHistory(40));

    expect(Object.keys(analysis).sort()).toEqual(
      [
        'momentum',
        'priceVsSmaPct',
        'reasons',
        'resistanceLevel',
        'rsi',
        'summaryText',
        'supportLevel',
        'trend',
        'trendStrength',
        'volatility',
        'volatilityPct',
      ].sort()
    );
    expect(analysis.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it('classifies a flat series as LATERAL with zero volatility', () => {
    const analysis = ProjectionEngine.analyzeMarket(makeSnapshot(), makeHistory(40, { drift: 0 }));
    expect(analysis.trend).toBe('LATERAL');
    expect(analysis.volatilityPct).toBe(0);
    expect(analysis.volatility).toBe('BAJA');
  });

  it('BUG: a perfectly flat market reports RSI 100 (extreme overbought)', () => {
    // calculateRSI checks `losses === 0` BEFORE `gains === 0`, so a series with
    // no movement at all is indistinguishable from an uninterrupted rally.
    // Downstream this adds +6 to downScore in generateProjections.
    const analysis = ProjectionEngine.analyzeMarket(makeSnapshot(), makeHistory(40, { drift: 0 }));
    expect(analysis.rsi).toBe(100);
  });

  it('classifies a rising series as ALCISTA and a falling one as BAJISTA', () => {
    const rising = makeHistory(40, { drift: 0.5 });
    const up = ProjectionEngine.analyzeMarket(
      makeSnapshot({ bestBuyPrice: rising[rising.length - 1].buyPrice }),
      rising
    );
    expect(up.trend).toBe('ALCISTA');
    expect(up.momentum).toBe('ALTO');
    expect(up.rsi).toBe(100); // no losing steps at all

    const falling = makeHistory(40, { startBuy: 950, drift: -0.5 });
    const down = ProjectionEngine.analyzeMarket(
      makeSnapshot({ bestBuyPrice: falling[falling.length - 1].buyPrice }),
      falling
    );
    expect(down.trend).toBe('BAJISTA');
    expect(down.momentum).toBe('NEGATIVO');
    expect(down.rsi).toBe(0);
  });

  it('BUG: mixes the live snapshot price with the history series unchecked', () => {
    // momentum and priceVsSmaPct compare snapshot.bestBuyPrice against a
    // history array that nothing guarantees is the same series (different bank
    // filter, different amount tier, or simply stale). A rising history read
    // against a lower live price is reported as NEGATIVE momentum.
    const rising = makeHistory(40, { drift: 0.5 }); // ends at 937.50
    const analysis = ProjectionEngine.analyzeMarket(makeSnapshot({ bestBuyPrice: 918 }), rising);
    expect(analysis.trend).toBe('ALCISTA');
    expect(analysis.momentum).toBe('NEGATIVO');
  });

  it('falls back to the live snapshot price when history is empty', () => {
    const analysis = ProjectionEngine.analyzeMarket(makeSnapshot({ bestBuyPrice: 918 }), []);
    expect(analysis.priceVsSmaPct).toBe(0);
    expect(analysis.trend).toBe('LATERAL');
    expect(analysis.trendStrength).toBe(35); // the hardcoded floor
  });

  it('BUG: trendStrength has a hardcoded floor of 35 even with zero evidence', () => {
    // Audit: trendStrength = |slope%| * 600 + 35. The 600 and the 35 have no
    // empirical basis, so "strength" is never allowed to report 0.
    const analysis = ProjectionEngine.analyzeMarket(makeSnapshot(), makeHistory(40, { drift: 0 }));
    expect(analysis.trendStrength).toBe(35);
  });
});

describe('computeOrderBookPressure', () => {
  it('splits pressure by available USDT and names the dominant side', () => {
    const snapshot = makeSnapshot({
      topBuyAds: [makeNormalizedAd(918, 800)],
      topSellAds: [makeNormalizedAd(921, 200)],
    });
    const pressure = ProjectionEngine.computeOrderBookPressure(snapshot);
    expect(pressure).toEqual({
      buyVolumeUsdt: 800,
      sellVolumeUsdt: 200,
      buyPressurePct: 80,
      sellPressurePct: 20,
      dominantSide: 'COMPRA',
    });
  });

  it('reports EQUILIBRADO below the 58% dominance threshold', () => {
    const snapshot = makeSnapshot({
      topBuyAds: [makeNormalizedAd(918, 550)],
      topSellAds: [makeNormalizedAd(921, 450)],
    });
    expect(ProjectionEngine.computeOrderBookPressure(snapshot).dominantSide).toBe('EQUILIBRADO');
  });

  it('BUG: invents 15000/15000 USDT of liquidity when the book is empty', () => {
    // Audit B6 / project rule 1: absent liquidity must be reported as absent.
    const snapshot = makeSnapshot({ topBuyAds: [], topSellAds: [] });
    expect(ProjectionEngine.computeOrderBookPressure(snapshot)).toEqual({
      buyVolumeUsdt: 15000,
      sellVolumeUsdt: 15000,
      buyPressurePct: 50,
      sellPressurePct: 50,
      dominantSide: 'EQUILIBRADO',
    });
  });
});

describe('generateProjections', () => {
  function project(history = makeHistory(40), snapshot = makeSnapshot()) {
    const analysis = ProjectionEngine.analyzeMarket(snapshot, history);
    return ProjectionEngine.generateProjections(snapshot, history, analysis);
  }

  it('returns the full MarketProjections contract', () => {
    const p = project();
    expect(Object.keys(p).sort()).toEqual(
      [
        'daily',
        'hasSufficientData',
        'hourlyTimeline',
        'intradayHorizons',
        'merchantAdvice',
        'probabilities',
        'risk',
        'currentBuyPrice',
        'currentSellPrice',
      ].sort()
    );
    expect(p.daily.rangeText).toMatch(/^\d+(\.\d+)? - \d+(\.\d+)? VES$/);
    expect(p.risk.factors.length).toBeGreaterThan(0);
  });

  it('emits exactly the six documented intraday horizons', () => {
    expect(project().intradayHorizons.map((h) => h.horizon)).toEqual([
      '+1H',
      '+2H',
      '+4H',
      '+6H',
      '+12H',
      '+24H',
    ]);
  });

  it('keeps probabilities summing to 100 and clamped to [8, 88]', () => {
    const p = project(makeHistory(40, { drift: 2 }));
    const { up, neutral, down } = p.probabilities;
    expect(up + neutral + down).toBe(100);
    expect(up).toBeLessThanOrEqual(88);
    expect(down).toBeGreaterThanOrEqual(8);
  });

  it('BUG: hasSufficientData is always true, even with zero history', () => {
    // Audit B4 / project rule 1: the field exists to signal missing data and
    // never does. insufficientDataReason is never populated.
    const empty = project([], makeSnapshot());
    expect(empty.hasSufficientData).toBe(true);
    expect(empty.insufficientDataReason).toBeUndefined();
  });

  it('BUG: substitutes a hardcoded 918 / 918.04 when the snapshot has no price', () => {
    // Audit B5 / project rule 6: a missing price must be null.
    const dead = makeSnapshot({ bestBuyPrice: 0, bestSellPrice: 0, topBuyAds: [], topSellAds: [] });
    const p = project([], dead);
    expect(p.currentBuyPrice).toBe(918);
    expect(p.currentSellPrice).toBe(918.04);
  });

  it('BUG: confidence is a function of sample count only, never of measured error', () => {
    // Audit B4 / project rule 4: confidence = 62 + min(25, n * 0.35), clamped
    // to [55, 94]. It rises with more rows regardless of accuracy.
    expect(project([]).daily.confidencePct).toBe(62);
    expect(project(makeHistory(20)).daily.confidencePct).toBe(69); // 62 + 7
    expect(project(makeHistory(500)).daily.confidencePct).toBe(87); // 62 + 25
  });

  it('BUG: spreadMaxExpected applies an artificial 1.2% floor', () => {
    const p = project(makeHistory(40), makeSnapshot({ spreadPercentage: 0.1 }));
    expect(p.daily.spreadMaxExpected).toBe(1.38); // max(0.1, 1.2) * 1.15
  });

  it('BUG: the optimal trade windows are constant strings, never computed', () => {
    // Audit: identical output for a rising, falling and flat market.
    const rising = project(makeHistory(40, { drift: 2 }));
    const falling = project(makeHistory(40, { startBuy: 950, drift: -2 }));
    expect(rising.merchantAdvice.optimalSellTimeWindow).toBe('01:30 PM - 03:45 PM VET');
    expect(rising.merchantAdvice.optimalBuyTimeWindow).toBe('10:00 AM - 11:45 AM VET');
    expect(falling.merchantAdvice.optimalSellTimeWindow).toBe(
      rising.merchantAdvice.optimalSellTimeWindow
    );
  });

  it('BUG: estimatedNetProfitPer1000Usdt is the whole projected range x 1000', () => {
    // Audit: assumes capturing the exact floor AND the exact ceiling, ignores
    // fees, slippage and execution. Violates project rule 7.
    const p = project();
    const expected = Number(((p.daily.ceiling - p.daily.floor) * 1000).toFixed(2));
    expect(p.merchantAdvice.estimatedNetProfitPer1000UsdtVes).toBe(expected);
  });
});

describe('buildHourlyTimeline (via generateProjections)', () => {
  function timelineFor(history = makeHistory(40)) {
    const snapshot = makeSnapshot();
    const analysis = ProjectionEngine.analyzeMarket(snapshot, history);
    return ProjectionEngine.generateProjections(snapshot, history, analysis).hourlyTimeline;
  }

  it('covers the 8:00-20:00 VET session as 13 points', () => {
    const timeline = timelineFor();
    expect(timeline).toHaveLength(13);
    expect(timeline.map((p) => p.hour)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(timeline[0].label).toBe('8 AM');
    expect(timeline[12].label).toBe('8 PM');
  });

  it('marks hours after the current VET hour as projected, with null observations', () => {
    const future = timelineFor().filter((p) => p.hour > 12);
    expect(future).toHaveLength(8);
    for (const point of future) {
      expect(point.isProjected).toBe(true);
      expect(point.buyPrice).toBeNull();
      expect(point.sellPrice).toBeNull();
      expect(point.projectedBuy).not.toBeNull();
    }
  });

  it('BUG: synthesises past hours with a hardcoded curve and marks them isProjected: false', () => {
    // Audit B1 - the most serious finding. History here contains no records in
    // hours 8-11, so those points are generated from sessionCurveMultipliers
    // and published as real observations.
    const timeline = timelineFor([]); // no history at all
    const past = timeline.filter((p) => p.hour < 12);

    expect(past).toHaveLength(4);
    for (const point of past) {
      expect(point.isProjected).toBe(false); // <- claims to be a real observation
      expect(point.buyPrice).not.toBeNull(); // <- but no such tick ever existed
      expect(point.projectedBuy).toBeNull();
    }
    // 8 AM offset = (-0.0025 - 0.0018) applied to the live 918.00 price.
    expect(past[0].buyPrice).toBe(914.05);
  });

  it('BUG: annotates a fabricated point with a PICO/RETROCESO note', () => {
    const notes = timelineFor([])
      .filter((p) => !p.isProjected && p.notes)
      .map((p) => p.notes);
    expect(notes.join(' ')).toMatch(/PICO|RETROCESO/);
  });

  it('uses the real tick when history does cover the hour', () => {
    // 2026-08-23T16:00:00Z is 12:00 VET; build ticks inside that hour.
    const history = makeHistory(5, { startTs: Date.parse('2026-08-23T16:10:00Z'), drift: 1 });
    const point = timelineFor(history).find((p) => p.hour === 12);
    expect(point?.isProjected).toBe(false);
    expect(point?.buyPrice).toBe(922); // last tick of that hour: 918 + 4
  });
});

describe('runBacktest', () => {
  it('reports insufficient data below 10 samples', () => {
    const result = ProjectionEngine.runBacktest(makeHistory(9));
    expect(result).toMatchObject({
      hasSufficientData: false,
      sampleSize: 9,
      samplePeriodDays: 0,
      mae: 0,
      rmse: 0,
      mape: 0,
      directionalAccuracyPct: 0,
    });
  });

  it('produces metrics once there are enough samples', () => {
    const result = ProjectionEngine.runBacktest(makeHistory(50, { drift: 0.1 }));
    expect(result.hasSufficientData).toBe(true);
    expect(result.sampleSize).toBe(44); // windowSize 5 .. length-1
    expect(result.mae).toBeGreaterThanOrEqual(0);
    expect(result.directionalAccuracyPct).toBeGreaterThanOrEqual(0);
    expect(result.directionalAccuracyPct).toBeLessThanOrEqual(100);
  });

  it('BUG: evaluates a 5-point linear model, NOT the model used in production', () => {
    // Audit B10 / project rule "backtest must evaluate the production model".
    // A perfectly linear series is predicted exactly, so MAE collapses to ~0
    // and the dashboard reports near-perfect accuracy for a model nobody runs.
    const result = ProjectionEngine.runBacktest(makeHistory(50, { drift: 1 }));
    expect(result.mae).toBeLessThan(0.001);
    expect(result.mape).toBe(0);
    expect(result.directionalAccuracyPct).toBe(100);
  });

  it('BUG: measures 6-second steps, so the horizon is meaningless for trading', () => {
    const sixSecondSteps = ProjectionEngine.runBacktest(makeHistory(50, { stepMs: 6000 }));
    expect(sixSecondSteps.samplePeriodDays).toBe(0);
  });
});
