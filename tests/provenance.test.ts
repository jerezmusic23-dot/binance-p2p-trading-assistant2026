/**
 * PHASE 5-C1 - data provenance
 *
 * Every figure the system publishes must be classifiable as REAL, AGGREGATED,
 * PROJECTED or HEURISTIC, and a fabricated value must never be labelled REAL.
 *
 * C1 only labels. The fabricated VALUES are still present and are replaced by
 * null in C2 - several tests below assert that a wrong number is at least
 * honestly tagged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProjectionEngine } from '../server/projectionEngine.js';
import { BinanceP2PService } from '../server/binanceP2PService.js';
import {
  makeAdItem,
  makeBinanceResponse,
  makeHistory,
  makeNormalizedAd,
  makeSnapshot,
} from './helpers/fixtures.js';

const FIXED_NOW = Date.parse('2026-08-23T16:00:00Z'); // 12:00 VET

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function project(history = makeHistory(60), snapshot = makeSnapshot()) {
  const analysis = ProjectionEngine.analyzeMarket(snapshot, history);
  return ProjectionEngine.generateProjections(snapshot, history, analysis);
}

describe('capture provenance', () => {
  const buyAds = [makeAdItem({ advNo: 'b1', price: '918.00' })];
  const sellAds = [makeAdItem({ advNo: 's1', price: '921.00' })];

  function stub(buy: typeof buyAds, sell: typeof sellAds) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => makeBinanceResponse(body.tradeType === 'BUY' ? buy : sell),
        } as unknown as Response;
      })
    );
  }

  it('labels both sides REAL when both actually had ads', async () => {
    stub(buyAds, sellAds);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.bestBuy).toEqual({ value: 918, provenance: 'REAL' });
    expect(snap.bestSell).toEqual({ value: 921, provenance: 'REAL' });
    expect(snap.bestBuy.value).toBe(snap.bestBuyPrice);
    expect(snap.bestSell.value).toBe(snap.bestSellPrice);
  });

  it('reports an absent side as a REAL null with an explanation', async () => {
    stub([], sellAds); // no BUY ads at all

    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    // C2: the absence itself is the observation. Nothing is derived.
    expect(snap.bestBuy.value).toBeNull();
    expect(snap.bestBuy.provenance).toBe('REAL');
    expect(snap.bestBuy.reason).toMatch(/no devolvio anuncios/i);
    // The side that really existed is untouched.
    expect(snap.bestSell.provenance).toBe('REAL');
    expect(snap.bestSell.value).toBe(921);
  });

  it('classifies aggregates and the order book separately from the prices', async () => {
    stub(buyAds, sellAds);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.aggregatesProvenance).toBe('AGGREGATED');
    expect(snap.orderBookProvenance).toBe('REAL');
  });

  it('never publishes a price that no advertiser posted', async () => {
    stub([], sellAds);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();
    // The only prices in the snapshot come from the SELL side that existed.
    expect(snap.bestBuyPrice).toBeNull();
    expect(snap.bestBuy.value).toBeNull();
  });
});

describe('analysis provenance', () => {
  it('separates derived statistics from hand-tuned constants', () => {
    const analysis = ProjectionEngine.analyzeMarket(makeSnapshot(), makeHistory(60));

    expect(analysis.provenance.overall).toBe('AGGREGATED');
    // C2 removed the +35 floor, so trendStrength is now a plain derived
    // magnitude. The support/resistance band still uses a hand-picked 1.6
    // sigma multiplier and stays HEURISTIC.
    expect(analysis.provenance.trendStrength).toBe('AGGREGATED');
    expect(analysis.provenance.supportResistance).toBe('HEURISTIC');
  });

  it('reports the window the statistics were computed over', () => {
    const history = makeHistory(100, { stepMs: 6000 }); // 99 * 6s = 9.9 min
    const analysis = ProjectionEngine.analyzeMarket(makeSnapshot(), history);

    expect(analysis.dataWindow.sampleCount).toBe(100);
    expect(analysis.dataWindow.spanMinutes).toBe(9.9);
    expect(analysis.dataWindow.fromTimestamp).toBe(history[0].timestamp);
    expect(analysis.dataWindow.toTimestamp).toBe(history[99].timestamp);
  });

  it('reports an empty window rather than inventing one', () => {
    const analysis = ProjectionEngine.analyzeMarket(makeSnapshot(), []);
    expect(analysis.dataWindow).toEqual({
      sampleCount: 0,
      fromTimestamp: null,
      toTimestamp: null,
      spanMinutes: null,
    });
  });
});

describe('order book pressure provenance', () => {
  it('is AGGREGATED when summed from real ads', () => {
    const snapshot = makeSnapshot({
      topBuyAds: [makeNormalizedAd(918, 800)],
      topSellAds: [makeNormalizedAd(921, 200)],
    });
    const pressure = ProjectionEngine.computeOrderBookPressure(snapshot);

    expect(pressure.buyVolume.provenance).toBe('AGGREGATED');
    expect(pressure.buyVolume.value).toBe(pressure.buyVolumeUsdt);
    expect(pressure.buyVolume.reason).toBeUndefined();
  });

  it('is a REAL null when the book was empty - absence is an observation', () => {
    const pressure = ProjectionEngine.computeOrderBookPressure(
      makeSnapshot({ topBuyAds: [], topSellAds: [] })
    );
    expect(pressure.buyVolume.value).toBeNull();
    expect(pressure.sellVolume.value).toBeNull();
    expect(pressure.buyVolume.provenance).toBe('REAL');
    expect(pressure.buyVolume.reason).toBeTruthy();
  });
});

describe('projection provenance', () => {
  it('classifies every projection block explicitly', () => {
    const p = project();
    expect(p.provenance).toEqual({
      daily: 'PROJECTED',
      probabilities: 'HEURISTIC',
      confidence: 'HEURISTIC',
      seasonality: 'HEURISTIC',
      merchantAdvice: 'HEURISTIC',
      risk: 'HEURISTIC',
    });
  });

  it('never labels the point-scoring probabilities as anything but HEURISTIC', () => {
    /*
     * The label survives the removal of the numbers, deliberately. The block
     * now carries { up: null, neutral: null, down: null } - the point-scoring
     * rule clamped to [8, 88] is gone - and HEURISTIC remains the honest
     * classification of a block that has never been calibrated against
     * anything. If a measured distribution is ever built, the label is what
     * has to change with it.
     */
    expect(project().provenance.probabilities).toBe('HEURISTIC');
    expect(project().probabilities).toEqual({ up: null, neutral: null, down: null });
  });

  it('never labels the sample-count confidence as measured evidence', () => {
    // confidencePct = 62 + min(25, n * 0.35): a function of row count, not error.
    const p = project();
    expect(p.provenance.confidence).toBe('HEURISTIC');
    expect(p.provenance.confidence).not.toBe('AGGREGATED');
  });

  it('carries the live price provenance through to currentBuy / currentSell', () => {
    const tagged = makeSnapshot({
      bestBuy: { value: 918, provenance: 'REAL', reason: 'lado presente' },
    });
    const p = project(makeHistory(60), tagged);
    expect(p.currentBuy.provenance).toBe('REAL');
    expect(p.currentBuy.reason).toBe('lado presente');
    expect(p.currentSell.provenance).toBe('REAL');
  });

  it('reports null prices instead of the old hardcoded 918 fallback', () => {
    const dead = makeSnapshot({
      bestBuyPrice: null,
      bestSellPrice: null,
      bestBuy: { value: null, provenance: 'REAL', reason: 'sin anuncios' },
      bestSell: { value: null, provenance: 'REAL', reason: 'sin anuncios' },
    });
    const p = project([], dead);

    expect(p.currentBuyPrice).toBeNull();
    expect(p.currentBuy.value).toBeNull();
    expect(p.currentBuy.provenance).toBe('REAL');
    expect(p.currentSell.value).toBeNull();
  });

  it('reports the data window the projections rest on', () => {
    const p = project(makeHistory(60));
    expect(p.dataWindow.sampleCount).toBe(60);
    expect(p.dataWindow.spanMinutes).toBe(5.9);
  });
});

describe('hourly timeline provenance', () => {
  function timeline(history = makeHistory(60)) {
    const snapshot = makeSnapshot();
    const analysis = ProjectionEngine.analyzeMarket(snapshot, history);
    return ProjectionEngine.generateProjections(snapshot, history, analysis).hourlyTimeline;
  }

  it('labels future hours PROJECTED', () => {
    for (const point of timeline().filter((p) => p.hour > 12)) {
      expect(point.provenance).toBe('PROJECTED');
      expect(point.provenanceReason).toMatch(/aun no ha ocurrido/i);
    }
  });

  it('leaves a past hour with no tick as a REAL gap, not a synthesised price', () => {
    // Audit B1, fixed in C2: the session curve no longer manufactures past
    // observations.
    const past = timeline([]).filter((p) => p.hour < 12);
    expect(past).toHaveLength(4);

    for (const point of past) {
      expect(point.isProjected).toBe(false); // past, not future
      expect(point.buyPrice).toBeNull();
      expect(point.provenance).toBe('REAL');
      expect(point.provenanceReason).toMatch(/No se capturó ningún tick/i);
    }
  });

  it('labels an hour backed by a stored tick REAL', () => {
    const history = makeHistory(5, {
      startTs: Date.parse('2026-08-23T16:10:00Z'),
      drift: 1,
    });
    const point = timeline(history).find((p) => p.hour === 12);
    expect(point?.provenance).toBe('REAL');
    expect(point?.provenanceReason).toBeUndefined();
  });

  it('isProjected means "future hour" and nothing else', () => {
    const points = timeline(makeHistory(60));
    for (const point of points) {
      if (point.isProjected) {
        expect(point.hour).toBeGreaterThan(12);
        expect(point.buyPrice).toBeNull();
        expect(point.sellPrice).toBeNull();
        expect(point.provenance).toBe('PROJECTED');
      } else {
        expect(point.hour).toBeLessThanOrEqual(12);
        expect(point.projectedBuy).toBeNull();
        expect(point.provenance).toBe('REAL');
      }
    }
  });

  it('every point carries a provenance', () => {
    for (const point of timeline()) {
      expect(['REAL', 'AGGREGATED', 'PROJECTED', 'HEURISTIC']).toContain(point.provenance);
    }
  });
});
