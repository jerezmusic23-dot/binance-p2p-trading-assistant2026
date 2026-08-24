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
        'dataWindow',
        'momentum',
        'priceVsSmaPct',
        'provenance',
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

  it('reports RSI null on a perfectly flat market - RSI is undefined there', () => {
    // Was audit BUG: `losses === 0` was checked before `gains === 0`, so a
    // motionless series reported 100 (extreme overbought) and tilted the
    // direction scoring downward. Fixed in C2.
    const analysis = ProjectionEngine.analyzeMarket(makeSnapshot(), makeHistory(40, { drift: 0 }));
    expect(analysis.rsi).toBeNull();
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

  it('returns a fully null analysis when there is no history at all', () => {
    // Was: the live price was pushed into the series as a stand-in and every
    // metric got an invented fallback. Fixed in C2.
    const analysis = ProjectionEngine.analyzeMarket(makeSnapshot({ bestBuyPrice: 918 }), []);
    expect(analysis.trend).toBeNull();
    expect(analysis.trendStrength).toBeNull();
    expect(analysis.momentum).toBeNull();
    expect(analysis.volatility).toBeNull();
    expect(analysis.volatilityPct).toBeNull();
    expect(analysis.priceVsSmaPct).toBeNull();
    expect(analysis.rsi).toBeNull();
    expect(analysis.supportLevel).toBeNull();
    expect(analysis.resistanceLevel).toBeNull();
    expect(analysis.dataWindow.sampleCount).toBe(0);
  });

  it('reports trendStrength 0 for a genuinely flat slope, with no artificial floor', () => {
    // Was audit BUG: a hardcoded +35 floor. Fixed in C2.
    const analysis = ProjectionEngine.analyzeMarket(makeSnapshot(), makeHistory(40, { drift: 0 }));
    expect(analysis.trend).toBe('LATERAL');
    expect(analysis.trendStrength).toBe(0);
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
      buyVolume: { value: 800, provenance: 'AGGREGATED' },
      sellVolume: { value: 200, provenance: 'AGGREGATED' },
    });
  });

  it('reports EQUILIBRADO below the 58% dominance threshold', () => {
    const snapshot = makeSnapshot({
      topBuyAds: [makeNormalizedAd(918, 550)],
      topSellAds: [makeNormalizedAd(921, 450)],
    });
    expect(ProjectionEngine.computeOrderBookPressure(snapshot).dominantSide).toBe('EQUILIBRADO');
  });

  it('reports null liquidity when the book is empty, never an invented 15000', () => {
    // Was audit B6. Fixed in C2: an empty book is a REAL observation with no
    // volume to measure.
    const snapshot = makeSnapshot({ topBuyAds: [], topSellAds: [] });
    const pressure = ProjectionEngine.computeOrderBookPressure(snapshot);

    expect(pressure.buyVolumeUsdt).toBeNull();
    expect(pressure.sellVolumeUsdt).toBeNull();
    expect(pressure.buyPressurePct).toBeNull();
    expect(pressure.sellPressurePct).toBeNull();
    expect(pressure.dominantSide).toBeNull();

    expect(pressure.buyVolume.provenance).toBe('REAL');
    expect(pressure.buyVolume.value).toBeNull();
    expect(pressure.buyVolume.reason).toMatch(/no contiene liquidez/i);
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
        'currentBuy',
        'currentBuyPrice',
        'currentSell',
        'currentSellPrice',
        'daily',
        'dataWindow',
        'hasSufficientData',
        'hourlyTimeline',
        'insufficientDataReason',
        'intradayHorizons',
        'merchantAdvice',
        'probabilities',
        'provenance',
        'risk',
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
    expect(up).not.toBeNull();
    expect(up! + neutral! + down!).toBe(100);
    expect(up!).toBeLessThanOrEqual(88);
    expect(down!).toBeGreaterThanOrEqual(8);
  });

  it('reports insufficient data, with a reason, when history is empty', () => {
    // Was audit B4 (hardcoded true). Fixed in phase C1.
    const empty = project([], makeSnapshot());
    expect(empty.hasSufficientData).toBe(false);
    expect(empty.insufficientDataReason).toContain('0 observaciones');
    expect(empty.insufficientDataReason).toContain(
      String(ProjectionEngine.MIN_SAMPLES_FOR_PROJECTION)
    );
  });

  it('reports insufficient data when there is no valid live price', () => {
    const dead = makeSnapshot({ bestBuyPrice: null, bestSellPrice: null });
    const p = project(makeHistory(100), dead);
    expect(p.hasSufficientData).toBe(false);
    expect(p.insufficientDataReason).toMatch(/precio de mercado valido/i);
  });

  it('reports sufficient data once the sample threshold is met', () => {
    const p = project(makeHistory(ProjectionEngine.MIN_SAMPLES_FOR_PROJECTION));
    expect(p.hasSufficientData).toBe(true);
    expect(p.insufficientDataReason).toBeUndefined();
  });

  it('returns null prices when the snapshot has none, never a hardcoded 918', () => {
    // Was audit B5. Fixed in C2.
    const dead = makeSnapshot({
      bestBuyPrice: null,
      bestSellPrice: null,
      topBuyAds: [],
      topSellAds: [],
    });
    const p = project([], dead);
    expect(p.currentBuyPrice).toBeNull();
    expect(p.currentSellPrice).toBeNull();
    expect(p.daily.floor).toBeNull();
    expect(p.daily.ceiling).toBeNull();
    expect(p.daily.rangeText).toBeNull();
    expect(p.probabilities).toEqual({ up: null, neutral: null, down: null });
    expect(p.intradayHorizons).toEqual([]);
    expect(p.hasSufficientData).toBe(false);
  });

  it('reports confidence null - it is not derived from sample count any more', () => {
    // Was audit B4: 62 + min(25, n * 0.35). Fixed in C2; a real figure needs
    // the backtest to measure this engine's own error (phase 8).
    expect(project([]).daily.confidencePct).toBeNull();
    expect(project(makeHistory(20)).daily.confidencePct).toBeNull();
    expect(project(makeHistory(500)).daily.confidencePct).toBeNull();
    for (const h of project(makeHistory(500)).intradayHorizons) {
      expect(h.confidence).toBeNull();
    }
  });

  it('applies no artificial floor to spreadMaxExpected', () => {
    // Was audit BUG: max(spread, 1.2) * 1.15. Fixed in C2.
    const p = project(makeHistory(40), makeSnapshot({ spreadPercentage: 0.1 }));
    expect(p.daily.spreadMaxExpected).toBe(0.11); // 0.1 * 1.15 = 0.115 -> 0.11

    const noSpread = project(makeHistory(40), makeSnapshot({ spreadPercentage: null }));
    expect(noSpread.daily.spreadMaxExpected).toBeNull();
  });

  it('reports null trade windows instead of constant strings', () => {
    // Was audit BUG: the same two literals for every market. Nothing computes
    // them, so C2 reports their absence.
    const rising = project(makeHistory(40, { drift: 2 }));
    expect(rising.merchantAdvice.optimalSellTimeWindow).toBeNull();
    expect(rising.merchantAdvice.optimalBuyTimeWindow).toBeNull();
  });

  it('reports null net profit - there is no cost model yet', () => {
    // Was audit BUG: (ceiling - floor) * 1000, i.e. the whole range presented
    // as profit, ignoring fees, slippage, liquidity and execution risk
    // (project rule 7). Fixed in C2.
    expect(project().merchantAdvice.estimatedNetProfitPer1000UsdtVes).toBeNull();
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

  it('leaves past hours without a stored tick as real gaps', () => {
    // Was audit B1, the most serious finding: the session curve manufactured a
    // price and published it with isProjected: false, i.e. as an observation.
    // Fixed in C2 - the hour is simply empty.
    const timeline = timelineFor([]); // no history at all
    const past = timeline.filter((p) => p.hour < 12);

    expect(past).toHaveLength(4);
    for (const point of past) {
      expect(point.isProjected).toBe(false); // past, not future
      expect(point.buyPrice).toBeNull();
      expect(point.sellPrice).toBeNull();
      expect(point.spreadPct).toBeNull();
      expect(point.projectedBuy).toBeNull();
      expect(point.provenance).toBe('REAL');
      expect(point.provenanceReason).toMatch(/No se capturó ningún tick/i);
    }
  });

  it('never annotates PICO / RETROCESO on an hour without a price', () => {
    // With no history the only past point that has a price is the current
    // hour, anchored to the live snapshot. Every other past hour is a gap and
    // must carry no annotation.
    const past = timelineFor([]).filter((p) => !p.isProjected);
    for (const point of past) {
      if (point.buyPrice === null && point.sellPrice === null) {
        expect(point.notes).toBeUndefined();
        expect(point.isPeak).toBe(false);
        expect(point.isTrough).toBe(false);
      }
    }
    expect(past.filter((p) => p.notes).every((p) => p.sellPrice !== null || p.buyPrice !== null))
      .toBe(true);
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
