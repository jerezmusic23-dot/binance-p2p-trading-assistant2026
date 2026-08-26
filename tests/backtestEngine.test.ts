/**
 * Walk-forward backtest of the production projection engine.
 *
 * EVERY series in this file is SYNTHETIC. None of it is Binance data, and no
 * number produced here is evidence about the real USDT/VES market. These tests
 * prove the MEASUREMENT is built correctly - that it never reads the future,
 * that it grades a prediction against the same definition of price it was made
 * on, and that it says INSUFFICIENT_DATA instead of inventing a result.
 *
 * Whether the MODEL is any good is a different question, answerable only by
 * running this against the real history on the production volume.
 */

import { describe, it, expect, vi } from 'vitest';
import { BacktestEngine } from '../server/backtestEngine.js';
import { ProjectionEngine } from '../server/projectionEngine.js';
import type { HistoryRecord } from '../server/types.js';

const MINUTE = 60_000;
const BASE_TS = Date.UTC(2026, 0, 6, 12, 0, 0);

function makeRecord(
  index: number,
  price: number,
  opts: { strategic?: boolean; intervalMs?: number; sell?: number } = {}
): HistoryRecord {
  const intervalMs = opts.intervalMs ?? MINUTE;
  const timestamp = BASE_TS + index * intervalMs;
  const sellPrice = opts.sell ?? price + 6;
  const strategic = opts.strategic ?? true;

  return {
    id: `tick-${timestamp}`,
    timestamp,
    dateStr: new Date(timestamp).toISOString(),
    hour: ProjectionEngine.getVenezuelaHour(timestamp),
    buyPrice: price,
    sellPrice: sellPrice,
    spreadPct: Number((((sellPrice - price) / price) * 100).toFixed(4)),
    bestBuyMerchant: 'M1',
    bestSellMerchant: 'M2',
    activeBuyAds: 20,
    activeSellAds: 20,
    source: 'BINANCE_P2P',
    ...(strategic
      ? {
          calculationVersion: 'v2-strategic' as const,
          // Deliberately offset from the raw price: if the backtest ever mixed
          // the two definitions the difference would show up in the error.
          strategicBuyPrice: price + 2,
          strategicSellPrice: sellPrice - 2,
          strategicSpreadPct: Number(
            (((sellPrice - 2 - (price + 2)) / (price + 2)) * 100).toFixed(4)
          ),
        }
      : {}),
  };
}

/** n records, one per minute, on a gentle rising ramp with a little wobble. */
function makeSeries(
  n: number,
  opts: { strategic?: boolean; start?: number; slope?: number } = {}
): HistoryRecord[] {
  const start = opts.start ?? 940;
  const slope = opts.slope ?? 0.01;
  return Array.from({ length: n }, (_, i) =>
    makeRecord(i, Number((start + i * slope + Math.sin(i / 7) * 0.4).toFixed(2)), {
      strategic: opts.strategic,
    })
  );
}

describe('BacktestEngine - no look-ahead', () => {
  it('builds the prediction for T only from records strictly before T', () => {
    /*
     * The proof is direct: intercept the engine and assert that every window
     * it is handed ends before the anchor's own timestamp. A single future
     * record leaking into a window fails this.
     */
    const history = makeSeries(200);
    const calls: { anchorTs: number; windowMaxTs: number }[] = [];
    const original = ProjectionEngine.generateProjections.bind(ProjectionEngine);
    const spy = vi
      .spyOn(ProjectionEngine, 'generateProjections')
      .mockImplementation((snapshot, window, analysis, nowMs) => {
        calls.push({
          anchorTs: nowMs as number,
          windowMaxTs: window.length ? window[window.length - 1].timestamp : -1,
        });
        return original(snapshot, window, analysis, nowMs);
      });

    BacktestEngine.run(history, 'SYNTHETIC_FIXTURE');
    spy.mockRestore();

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.windowMaxTs).toBeLessThan(call.anchorTs);
    }
  });

  it('never hands the engine a window longer than production reads', () => {
    const history = makeSeries(400);
    const lengths: number[] = [];
    const original = ProjectionEngine.analyzeMarket.bind(ProjectionEngine);
    const spy = vi
      .spyOn(ProjectionEngine, 'analyzeMarket')
      .mockImplementation((snapshot, window) => {
        lengths.push(window.length);
        return original(snapshot, window);
      });

    BacktestEngine.run(history, 'SYNTHETIC_FIXTURE');
    spy.mockRestore();

    expect(Math.max(...lengths)).toBe(BacktestEngine.PROJECTION_WINDOW);
  });

  it('findFutureRecord only ever looks after the anchor index', () => {
    const history = makeSeries(50);
    // A target BEHIND the anchor must not resolve to the past record that matches it.
    const pastTarget = history[10].timestamp;
    const found = BacktestEngine.findFutureRecord(history, 30, pastTarget, MINUTE);
    expect(found).toBeNull();
  });
});

describe('BacktestEngine - walk-forward mechanics', () => {
  it('anchors every record and reports how many were considered', () => {
    const history = makeSeries(120);
    const result = BacktestEngine.run(history, 'SYNTHETIC_FIXTURE');
    expect(result.anchorsConsidered).toBe(120);
    expect(result.method).toBe('WALK_FORWARD_PRODUCTION_MODEL');
  });

  it('calls the real production engine rather than a re-implementation', () => {
    const history = makeSeries(150);
    const analyze = vi.spyOn(ProjectionEngine, 'analyzeMarket');
    const project = vi.spyOn(ProjectionEngine, 'generateProjections');

    BacktestEngine.run(history, 'SYNTHETIC_FIXTURE');

    expect(analyze).toHaveBeenCalled();
    expect(project).toHaveBeenCalled();
    analyze.mockRestore();
    project.mockRestore();
  });

  it('pins the engine clock to the anchor, not the wall clock', () => {
    const history = makeSeries(150);
    const anchors: number[] = [];
    const original = ProjectionEngine.generateProjections.bind(ProjectionEngine);
    const spy = vi
      .spyOn(ProjectionEngine, 'generateProjections')
      .mockImplementation((s, w, a, nowMs) => {
        anchors.push(nowMs as number);
        return original(s, w, a, nowMs);
      });

    BacktestEngine.run(history, 'SYNTHETIC_FIXTURE');
    spy.mockRestore();

    // Every clock value is one of the history timestamps - never Date.now().
    const validTs = new Set(history.map((h) => h.timestamp));
    expect(anchors.length).toBeGreaterThan(0);
    for (const ts of anchors) expect(validTs.has(ts)).toBe(true);
  });

  it('skips anchors below the production minimum and counts the reason', () => {
    const history = makeSeries(40);
    const result = BacktestEngine.run(history, 'SYNTHETIC_FIXTURE');
    const h1 = result.horizons.find((h) => h.horizon === '+1H');

    expect(result.minSamplesForProjection).toBe(ProjectionEngine.MIN_SAMPLES_FOR_PROJECTION);
    expect(h1?.skipReasons.BELOW_MIN_SAMPLES).toBe(
      ProjectionEngine.MIN_SAMPLES_FOR_PROJECTION
    );
  });
});

describe('BacktestEngine - series selection', () => {
  it('resolves STRATEGIC when every record in the window carries it', () => {
    const history = makeSeries(150, { strategic: true });
    const result = BacktestEngine.run(history, 'SYNTHETIC_FIXTURE');
    expect(result.basis).toBe('STRATEGIC');
    expect(result.basisCounts.raw).toBe(0);
    expect(result.basisCounts.strategic).toBeGreaterThan(0);
  });

  it('falls back to RAW when a single legacy record sits in the window', () => {
    const history = makeSeries(150, { strategic: true });
    history[100] = makeRecord(100, history[100].buyPrice, { strategic: false });

    const result = BacktestEngine.run(history, 'SYNTHETIC_FIXTURE');
    expect(result.basisCounts.raw).toBeGreaterThan(0);
  });

  it('is entirely RAW when no record is v2-strategic', () => {
    const history = makeSeries(150, { strategic: false });
    const result = BacktestEngine.run(history, 'SYNTHETIC_FIXTURE');
    expect(result.basis).toBe('RAW');
    expect(result.basisCounts.strategic).toBe(0);
    expect(result.strategicRecords).toBe(0);
  });

  it('grades a strategic prediction against the strategic future, never the raw one', () => {
    /*
     * The fixture offsets strategic from raw by a constant +2 VES. If the
     * backtest compared a strategic projection against a raw future, that
     * offset alone would appear as a systematic ~2 VES bias.
     */
    const history = makeSeries(300, { strategic: true, slope: 0 });
    const result = BacktestEngine.run(history, 'SYNTHETIC_FIXTURE');
    const h1 = result.horizons.find((h) => h.horizon === '+1H');

    expect(h1?.status).toBe('OK');
    expect(h1?.validSamples).toBeGreaterThan(0);
    expect(Math.abs(h1?.model.biasVes ?? 99)).toBeLessThan(1.5);
  });

  it('refuses to score a strategic anchor against a v1 future record', () => {
    const history = makeSeries(300, { strategic: true });
    // Blank the strategic fields on the entire future half.
    for (let i = 200; i < history.length; i++) {
      history[i] = makeRecord(i, history[i].buyPrice, { strategic: false });
    }
    const result = BacktestEngine.run(history, 'SYNTHETIC_FIXTURE');
    const h1 = result.horizons.find((h) => h.horizon === '+1H');
    expect((h1?.skipReasons.FUTURE_RECORD_WRONG_BASIS ?? 0)).toBeGreaterThan(0);
  });
});

describe('BacktestEngine - horizons', () => {
  it('evaluates exactly the horizons production publishes', () => {
    const result = BacktestEngine.run(makeSeries(120), 'SYNTHETIC_FIXTURE');
    expect(result.horizons.map((h) => h.horizon)).toEqual([
      '+1H',
      '+2H',
      '+4H',
      '+6H',
      '+12H',
      '+24H',
    ]);
    expect(result.horizons.map((h) => h.hours)).toEqual([1, 2, 4, 6, 12, 24]);
  });

  it('matches the future record at the right distance for each horizon', () => {
    const history = makeSeries(700);
    const result = BacktestEngine.run(history, 'SYNTHETIC_FIXTURE');

    const h1 = result.horizons.find((h) => h.horizon === '+1H');
    const h6 = result.horizons.find((h) => h.horizon === '+6H');
    const h24 = result.horizons.find((h) => h.horizon === '+24H');

    // 700 minutes of history: 1h and 6h are reachable, 24h is not.
    expect(h1?.status).toBe('OK');
    expect(h6?.status).toBe('OK');
    expect(h24?.status).toBe('INSUFFICIENT_DATA');
    expect(h1?.validSamples).toBeGreaterThan(h6?.validSamples ?? 0);
  }, 30_000);
});

describe('BacktestEngine - baseline and metrics', () => {
  it('always computes the persistence baseline alongside the model', () => {
    const result = BacktestEngine.run(makeSeries(300), 'SYNTHETIC_FIXTURE');
    const h1 = result.horizons.find((h) => h.horizon === '+1H');

    expect(result.baseline).toBe('PERSISTENCE');
    expect(h1?.persistence.mae).not.toBeNull();
    expect(h1?.model.mae).not.toBeNull();
    expect(typeof h1?.beatsPersistence).toBe('boolean');
  });

  it('persistence predicts the anchor price unchanged', () => {
    // On a perfectly flat series, doing nothing is exactly right.
    const flat = Array.from({ length: 300 }, (_, i) => makeRecord(i, 950));
    const result = BacktestEngine.run(flat, 'SYNTHETIC_FIXTURE');
    const h1 = result.horizons.find((h) => h.horizon === '+1H');

    expect(h1?.persistence.mae).toBe(0);
    expect(h1?.persistence.rmse).toBe(0);
  });

  it('MAE is the mean absolute error', () => {
    const metrics = BacktestEngine.score([10, 12], [11, 10], [10, 10]);
    expect(metrics.mae).toBe(1.5); // (|10-11| + |12-10|) / 2
  });

  it('RMSE penalises the larger error more than MAE does', () => {
    const metrics = BacktestEngine.score([10, 12], [11, 10], [10, 10]);
    // sqrt((1 + 4) / 2) = 1.5811...
    expect(metrics.rmse).toBeCloseTo(1.5811, 3);
    expect(metrics.rmse as number).toBeGreaterThan(metrics.mae as number);
  });

  it('MAPE is expressed against the realised value', () => {
    const metrics = BacktestEngine.score([110], [100], [100]);
    expect(metrics.mapePct).toBe(10);
  });

  it('MAPE ignores a non-positive actual rather than dividing by it', () => {
    const metrics = BacktestEngine.score([5], [0], [1]);
    expect(metrics.mapePct).toBeNull();
    expect(metrics.mae).toBe(5);
  });

  it('directional accuracy scores UP / DOWN / FLAT against the anchor', () => {
    // up-hit, down-hit, direction miss
    const metrics = BacktestEngine.score([11, 9, 11], [12, 8, 9], [10, 10, 10]);
    expect(metrics.directionalAccuracyPct).toBeCloseTo(66.67, 1);
  });

  it('treats a move below stored precision as FLAT', () => {
    const metrics = BacktestEngine.score([950], [950], [950]);
    expect(metrics.directionalAccuracyPct).toBe(100);
  });

  it('reports bias with its sign, so an overestimate is distinguishable', () => {
    const high = BacktestEngine.score([12, 13], [10, 10], [10, 10]);
    expect(high.biasVes).toBe(2.5);
    expect(high.biasDirection).toBe('OVERESTIMATES');

    const low = BacktestEngine.score([8, 7], [10, 10], [10, 10]);
    expect(low.biasVes).toBe(-2.5);
    expect(low.biasDirection).toBe('UNDERESTIMATES');
  });

  it('reports improvement over persistence as a signed percentage', () => {
    const result = BacktestEngine.run(makeSeries(300), 'SYNTHETIC_FIXTURE');
    const h1 = result.horizons.find((h) => h.horizon === '+1H');

    if (h1?.model.mae !== null && h1?.persistence.mae !== null) {
      const expected = Number(
        (((h1!.persistence.mae! - h1!.model.mae!) / h1!.persistence.mae!) * 100).toFixed(2)
      );
      expect(h1?.maeImprovementPct).toBe(expected);
      expect(h1?.beatsPersistence).toBe(h1!.model.mae! < h1!.persistence.mae!);
    }
  });
});

describe('BacktestEngine - projection band coverage', () => {
  it('counts how often the realised price landed inside the band', () => {
    const result = BacktestEngine.run(makeSeries(300), 'SYNTHETIC_FIXTURE');
    const h1 = result.horizons.find((h) => h.horizon === '+1H');

    expect(h1?.bandSamples).toBeGreaterThan(0);
    expect(h1?.bandCoveragePct).not.toBeNull();
    expect(h1?.bandCoveragePct).toBeGreaterThanOrEqual(0);
    expect(h1?.bandCoveragePct).toBeLessThanOrEqual(100);
  });

  it('never publishes a confidence figure from the band', () => {
    const result = BacktestEngine.run(makeSeries(300), 'SYNTHETIC_FIXTURE');
    expect(result.confidencePublished).toBe(false);
  });
});

describe('BacktestEngine - insufficient data', () => {
  it('returns insufficient_data for an empty history instead of zeros', () => {
    const result = BacktestEngine.run([], 'SYNTHETIC_FIXTURE');

    expect(result.status).toBe('insufficient_data');
    expect(result.validatesProductionModel).toBe(false);
    for (const h of result.horizons) {
      expect(h.status).toBe('INSUFFICIENT_DATA');
      expect(h.validSamples).toBe(0);
      expect(h.model.mae).toBeNull();
      expect(h.model.mapePct).toBeNull();
      expect(h.persistence.mae).toBeNull();
      expect(h.beatsPersistence).toBeNull();
      expect(h.bandCoveragePct).toBeNull();
    }
  });

  it('reports INSUFFICIENT_DATA on every horizon for a 51-record history', () => {
    /*
     * The production reading at the time this was written: 51 records, one per
     * minute. 51 minutes of span cannot reach even the +1H horizon, and saying
     * so is the correct answer.
     */
    const result = BacktestEngine.run(makeSeries(51), 'SYNTHETIC_FIXTURE');

    expect(result.status).toBe('insufficient_data');
    expect(result.validatesProductionModel).toBe(false);
    expect(result.horizons.every((h) => h.status === 'INSUFFICIENT_DATA')).toBe(true);
    expect(result.horizons.every((h) => h.reason !== null)).toBe(true);
  });

  it('explains what is missing in records and in hours', () => {
    const result = BacktestEngine.run(makeSeries(120), 'SYNTHETIC_FIXTURE');
    const h24 = result.horizons.find((h) => h.horizon === '+24H');

    expect(h24?.status).toBe('INSUFFICIENT_DATA');
    expect(h24?.reason).toContain('1471');
  });

  it('accounts for every anchor: valid + skipped == evaluated', () => {
    const result = BacktestEngine.run(makeSeries(300), 'SYNTHETIC_FIXTURE');
    for (const h of result.horizons) {
      expect(h.validSamples + h.skippedSamples).toBe(h.evaluatedSamples);
      const countedSkips = Object.values(h.skipReasons).reduce((a, b) => a + b, 0);
      expect(countedSkips).toBe(h.skippedSamples);
    }
  });
});

describe('BacktestEngine - honesty of the report', () => {
  it('never claims validation when nothing was scored', () => {
    const result = BacktestEngine.run(makeSeries(51), 'SYNTHETIC_FIXTURE');
    expect(result.validatesProductionModel).toBe(false);
  });

  it('claims validation only once a horizon actually scored samples', () => {
    const result = BacktestEngine.run(makeSeries(300), 'SYNTHETIC_FIXTURE');
    expect(result.validatesProductionModel).toBe(true);
    expect(result.horizons.some((h) => h.validSamples > 0)).toBe(true);
  });

  it('carries the source through untouched, so a fixture cannot pose as market data', () => {
    const fixture = BacktestEngine.run(makeSeries(300), 'SYNTHETIC_FIXTURE');
    expect(fixture.source).toBe('SYNTHETIC_FIXTURE');

    const real = BacktestEngine.run(makeSeries(300), 'REAL_HISTORY');
    expect(real.source).toBe('REAL_HISTORY');
  });

  it('declares the order book as a reproduction gap rather than hiding it', () => {
    const result = BacktestEngine.run(makeSeries(300), 'SYNTHETIC_FIXTURE');
    expect(result.reproductionGaps.length).toBeGreaterThan(0);
    expect(result.reproductionGaps.join(' ')).toContain('orderBookPressure');
  });

  it('measures the sampling cadence instead of assuming it', () => {
    const fiveMin = Array.from({ length: 300 }, (_, i) =>
      makeRecord(i, 940 + i * 0.01, { intervalMs: 5 * MINUTE })
    );
    const result = BacktestEngine.run(fiveMin, 'SYNTHETIC_FIXTURE');
    expect(result.medianIntervalSeconds).toBe(300);
  });
});

describe('BacktestEngine - snapshot reconstruction', () => {
  it('leaves the order book empty rather than inventing ads', () => {
    const snapshot = BacktestEngine.reconstructSnapshot(makeRecord(0, 950));
    expect(snapshot.topBuyAds).toEqual([]);
    expect(snapshot.topSellAds).toEqual([]);
    expect(snapshot.orderBookProvenance).toBe('NOT_VERIFIABLE');
  });

  it('never turns an absent strategic price into a number', () => {
    const snapshot = BacktestEngine.reconstructSnapshot(
      makeRecord(0, 950, { strategic: false })
    );
    expect(snapshot.strategicBuyPrice).toBeNull();
    expect(snapshot.strategicSellPrice).toBeNull();
    expect(snapshot.strategicSpreadPct).toBeNull();
    expect(snapshot.strategicReason).not.toBeNull();
  });

  it('carries the stored strategic level through unchanged', () => {
    const record = makeRecord(0, 950);
    const snapshot = BacktestEngine.reconstructSnapshot(record);
    expect(snapshot.strategicBuyPrice).toBe(record.strategicBuyPrice);
    expect(snapshot.strategicSellPrice).toBe(record.strategicSellPrice);
    expect(snapshot.bestBuyPrice).toBe(record.buyPrice);
  });

  it('produces an order-book pressure of null, so the ±8 term drops out', () => {
    const snapshot = BacktestEngine.reconstructSnapshot(makeRecord(0, 950));
    const pressure = ProjectionEngine.computeOrderBookPressure(snapshot);
    expect(pressure.dominantSide).toBeNull();
    expect(pressure.buyVolumeUsdt).toBeNull();
  });
});

describe('BacktestEngine - the legacy backtest is left alone', () => {
  it('still reports that it does not validate the production model', () => {
    const legacy = ProjectionEngine.runBacktest(makeSeries(300));
    expect(legacy.validatesProductionModel).toBe(false);
  });
});
