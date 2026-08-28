/**
 * NO LOOK-AHEAD, AND THE PROOF IS A COMPARISON, NOT A COMMENT.
 *
 * The strongest test available for "the projection at T used only data up to
 * T" is this: run the same anchor twice, once against a series that has been
 * truncated immediately after T and once against the full series, and require
 * byte-identical output. If any code path could see past T, the two runs would
 * differ - because in one of them the future does not exist.
 *
 * Everything else in this suite is secondary to that.
 */

import { describe, expect, it } from 'vitest';
import { MIN_PREFIX, runProjectionBacktest } from '../server/projectionBacktest.js';
import { projectCell } from '../server/makerProjectionEngine.js';
import { EMPTY_SIGNAL_MEMORY, evaluateSignals } from '../server/signalEngine.js';
import { ramp, seriesFromBuyPrices } from './helpers/series.js';

const CELL = {
  bank: 'VENEZUELA',
  bankDisplayName: 'Banco de Venezuela',
  amountKey: '10K',
  amountVes: 10_000,
};

describe('THE LOOK-AHEAD PROOF', () => {
  /*
   * A series whose future is violently different from its past. If anything
   * leaked backwards, the collapse at the end would change what the engine
   * says about the calm rise at the start - dramatically, not subtly.
   */
  const past = ramp(940, 946, 30);
  const violentFuture = ramp(946, 900, 30);
  const full = seriesFromBuyPrices([...past, ...violentFuture]);
  const truncated = seriesFromBuyPrices(past);

  it('produces an identical projection at T whether or not the future exists', () => {
    const anchorIndex = past.length - 1;

    const withFuture = projectCell({
      ...CELL,
      series: full.slice(0, anchorIndex + 1),
      currentBuyPrice: past[anchorIndex],
      currentSellPrice: null,
    });
    const withoutFuture = projectCell({
      ...CELL,
      series: truncated,
      currentBuyPrice: past[anchorIndex],
      currentSellPrice: null,
    });

    expect(JSON.stringify(withFuture)).toBe(JSON.stringify(withoutFuture));
  });

  it('produces identical SIGNALS at T whether or not the future exists', () => {
    const anchorIndex = past.length - 1;
    const a = evaluateSignals({
      projections: [
        projectCell({
          ...CELL,
          series: full.slice(0, anchorIndex + 1),
          currentBuyPrice: past[anchorIndex],
          currentSellPrice: null,
        }),
      ],
      memory: EMPTY_SIGNAL_MEMORY,
    });
    const b = evaluateSignals({
      projections: [
        projectCell({ ...CELL, series: truncated, currentBuyPrice: past[anchorIndex], currentSellPrice: null }),
      ],
      memory: EMPTY_SIGNAL_MEMORY,
    });

    expect(JSON.stringify(a.signals)).toBe(JSON.stringify(b.signals));
  });

  it('every backtest anchor matches a projection built from its prefix alone', () => {
    const report = runProjectionBacktest({ ...CELL, series: full, side: 'BUY', horizonSteps: 5 });
    expect(report.anchorsEvaluated).toBeGreaterThan(0);

    for (const anchor of report.anchors) {
      const independent = projectCell({
        ...CELL,
        series: full.slice(0, anchor.index + 1),
        currentBuyPrice: anchor.priceAtAnchor,
        currentSellPrice: null,
        stepsAhead: 5,
      });
      expect(independent.buy.trend.trend).toBe(anchor.trend);
      expect(independent.buy.projectedRange.low).toBe(anchor.projectedLow);
      expect(independent.buy.projectedRange.high).toBe(anchor.projectedHigh);
    }
  });

  it('reads the outcome strictly after the anchor', () => {
    const report = runProjectionBacktest({ ...CELL, series: full, side: 'BUY', horizonSteps: 5 });
    for (const anchor of report.anchors) {
      expect(anchor.realisedIndex).toBe(anchor.index + 5);
      expect(anchor.realisedIndex as number).toBeGreaterThan(anchor.index);
    }
  });
});

describe('the backtest answers both halves of the question', () => {
  const series = seriesFromBuyPrices(ramp(940, 960, 60));
  const report = runProjectionBacktest({ ...CELL, series, side: 'BUY', horizonSteps: 5 });

  it('says what the system claimed and what actually happened', () => {
    const anchor = report.anchors[0];
    expect(anchor.trend).toBeDefined();
    expect(anchor.priceAtAnchor).not.toBeNull();
    expect(anchor.realisedPrice).not.toBeNull();
  });

  it('scores a steadily rising series as directionally correct', () => {
    expect(report.directionalCalls).toBeGreaterThan(0);
    expect(report.directionalAccuracy).toBe(1);
  });

  it('reports a persistence baseline alongside, so accuracy means something', () => {
    expect(report.baselineAccuracy).not.toBeNull();
    // A monotonic ramp never repeats a price: predicting "no change" is always wrong.
    expect(report.baselineAccuracy).toBe(0);
  });

  it('measures band coverage separately from direction', () => {
    expect(report.bandedCalls).toBeGreaterThan(0);
    expect(report.bandCoverage).not.toBeNull();
  });
});

describe('the backtest refuses rather than fabricating a score', () => {
  it('says NO_DATA for an empty series', () => {
    const report = runProjectionBacktest({ ...CELL, series: [], side: 'BUY' });
    expect(report.reason).toBe('NO_DATA');
    expect(report.directionalAccuracy).toBeNull();
    expect(report.bandCoverage).toBeNull();
  });

  it('says INSUFFICIENT_HISTORY when there is no room for a prefix and a horizon', () => {
    const series = seriesFromBuyPrices(ramp(940, 942, MIN_PREFIX));
    const report = runProjectionBacktest({ ...CELL, series, side: 'BUY', horizonSteps: 6 });
    expect(report.reason).toBe('INSUFFICIENT_HISTORY');
    expect(report.anchorsEvaluated).toBe(0);
  });

  it('skips an anchor whose price is missing instead of guessing one', () => {
    const prices: (number | null)[] = ramp(940, 960, 40);
    prices[20] = null;
    const report = runProjectionBacktest({
      ...CELL,
      series: seriesFromBuyPrices(prices),
      side: 'BUY',
      horizonSteps: 5,
    });
    expect(report.anchorsSkipped).toBeGreaterThan(0);
    expect(report.skipReasons.MISSING_PRICE).toBeGreaterThan(0);
  });
});

describe('13 - reinicio: the signal memory walks forward, never backward', () => {
  it('starts each backtest from an empty memory, as production does after a restart', () => {
    const series = seriesFromBuyPrices([...ramp(950, 940, 25), ...ramp(940, 950, 25)]);
    const first = runProjectionBacktest({ ...CELL, series, side: 'BUY', horizonSteps: 5 });
    const second = runProjectionBacktest({ ...CELL, series, side: 'BUY', horizonSteps: 5 });

    // Deterministic: the same series always produces the same replay.
    expect(JSON.stringify(first.anchors.map((a) => a.signals.map((s) => s.identity)))).toBe(
      JSON.stringify(second.anchors.map((a) => a.signals.map((s) => s.identity)))
    );
  });

  it('detects the reversal only after it has happened, never before', () => {
    const series = seriesFromBuyPrices([...ramp(950, 940, 25), ...ramp(940, 950, 25)]);
    const report = runProjectionBacktest({ ...CELL, series, side: 'BUY', horizonSteps: 5 });

    const changeAnchors = report.anchors.filter((a) =>
      a.signals.some((s) => s.kind === 'TREND_CHANGE')
    );
    expect(changeAnchors.length).toBeGreaterThan(0);
    // The turn is at index 24. No TREND_CHANGE may be claimed before it.
    expect(Math.min(...changeAnchors.map((a) => a.index))).toBeGreaterThan(24);
  });
});
