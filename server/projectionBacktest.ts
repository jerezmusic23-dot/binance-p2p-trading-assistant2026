/**
 * BACKTEST: what would the system have said at time T, and what happened next?
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 *
 * A projection made at index i may read observations 0..i and NOTHING ELSE.
 * The outcome is then read from i+1 onwards, and the two are never allowed to
 * touch. Every helper below takes a `history` argument that is already a
 * prefix - the slice happens once, here, at the top of the loop, so no
 * downstream module can reach past it even by accident.
 *
 * WHY IT IS BUILT THIS WAY RATHER THAN WITH A FLAG
 *
 * "Do not use future data" as a comment is not enforceable. Passing a prefix
 * is: makeProjection literally does not hold the later observations, so a bug
 * that tried to peek would have nothing to peek at. The test suite asserts
 * this by running the same anchor against a truncated series and a full one
 * and requiring identical output.
 */

import type { HistoricalObservation } from './historicalMarketStore.js';
import { projectCell, type CellProjection } from './makerProjectionEngine.js';
import { evaluateSignals, EMPTY_SIGNAL_MEMORY, type MarketSignal, type SignalMemory } from './signalEngine.js';
import type { TrendDirection, TrendSeries } from './trendEngine.js';

export interface BacktestAnchor {
  /** Index in the series this projection was made at. */
  index: number;
  timestamp: number;
  /** What the system said, using data up to and including `index`. */
  trend: TrendDirection;
  projectedLow: number | null;
  projectedHigh: number | null;
  priceAtAnchor: number | null;
  signals: MarketSignal[];

  /** What actually happened, read strictly after `index`. */
  realisedPrice: number | null;
  realisedIndex: number | null;
  /** Did the realised price land inside the projected band? */
  landedInBand: boolean | null;
  /** Did the price move in the direction the trend claimed? */
  directionCorrect: boolean | null;
}

export interface BacktestReport {
  bank: string;
  amountKey: string;
  side: TrendSeries;
  /** Anchors evaluated, and why others were skipped. */
  anchorsEvaluated: number;
  anchorsSkipped: number;
  skipReasons: Record<string, number>;

  /** Of the anchors that made a directional call, how many were right. */
  directionalCalls: number;
  directionalCorrect: number;
  directionalAccuracy: number | null;

  /** Of the anchors that produced a band, how many contained the outcome. */
  bandedCalls: number;
  bandHits: number;
  bandCoverage: number | null;

  /** A persistence baseline: "the price will not move". */
  baselineCorrect: number;
  baselineAccuracy: number | null;

  anchors: BacktestAnchor[];
  reason: 'NO_DATA' | 'INSUFFICIENT_HISTORY' | null;
}

/**
 * Smallest prefix a projection is attempted from.
 *
 * Below this the trend engine returns UNKNOWN anyway; running the anchor
 * regardless would fill the report with skips and make the accuracy read as
 * though the engine had been asked and failed, rather than never asked.
 */
export const MIN_PREFIX = 8;

function priceAt(observation: HistoricalObservation, side: TrendSeries): number | null {
  return side === 'BUY' ? observation.buyRecommendedPrice : observation.sellRecommendedPrice;
}

export function runProjectionBacktest(params: {
  bank: string;
  bankDisplayName: string;
  amountKey: string;
  amountVes: number;
  series: readonly HistoricalObservation[];
  side: TrendSeries;
  /** How far ahead the outcome is measured, in observations. */
  horizonSteps?: number;
  minPrefix?: number;
}): BacktestReport {
  const horizon = params.horizonSteps ?? 6;
  const minPrefix = params.minPrefix ?? MIN_PREFIX;
  const series = params.series;

  const empty = (reason: BacktestReport['reason']): BacktestReport => ({
    bank: params.bank,
    amountKey: params.amountKey,
    side: params.side,
    anchorsEvaluated: 0,
    anchorsSkipped: 0,
    skipReasons: {},
    directionalCalls: 0,
    directionalCorrect: 0,
    directionalAccuracy: null,
    bandedCalls: 0,
    bandHits: 0,
    bandCoverage: null,
    baselineCorrect: 0,
    baselineAccuracy: null,
    anchors: [],
    reason,
  });

  if (series.length === 0) return empty('NO_DATA');
  if (series.length < minPrefix + horizon) return empty('INSUFFICIENT_HISTORY');

  const anchors: BacktestAnchor[] = [];
  const skipReasons: Record<string, number> = {};
  let skipped = 0;

  let directionalCalls = 0;
  let directionalCorrect = 0;
  let bandedCalls = 0;
  let bandHits = 0;
  let baselineCorrect = 0;

  /*
   * Signal memory walks forward with the anchors, exactly as it would in
   * production. Seeding it from the whole series would be look-ahead through
   * the back door: the memory IS information about the past, and it must be
   * the past as of this anchor, not as of the end.
   */
  let memory: SignalMemory = EMPTY_SIGNAL_MEMORY;

  for (let i = minPrefix - 1; i + horizon < series.length; i += 1) {
    /* THE CUT. Everything below sees only this. */
    const prefix = series.slice(0, i + 1);

    const priceAtAnchor = priceAt(series[i], params.side);
    const projection: CellProjection = projectCell({
      bank: params.bank,
      bankDisplayName: params.bankDisplayName,
      amountKey: params.amountKey,
      amountVes: params.amountVes,
      series: prefix,
      currentBuyPrice: params.side === 'BUY' ? priceAtAnchor : null,
      currentSellPrice: params.side === 'SELL' ? priceAtAnchor : null,
      stepsAhead: horizon,
    });

    const sideProjection = params.side === 'BUY' ? projection.buy : projection.sell;
    const evaluated = evaluateSignals({ projections: [projection], memory });
    memory = evaluated.memory;

    const realised = priceAt(series[i + horizon], params.side);

    if (priceAtAnchor === null || realised === null) {
      skipped += 1;
      skipReasons.MISSING_PRICE = (skipReasons.MISSING_PRICE ?? 0) + 1;
      continue;
    }

    const trend = sideProjection.trend.trend;
    const low = sideProjection.projectedRange.low;
    const high = sideProjection.projectedRange.high;

    let directionCorrect: boolean | null = null;
    if (trend === 'BULLISH' || trend === 'BEARISH') {
      directionalCalls += 1;
      directionCorrect =
        trend === 'BULLISH' ? realised > priceAtAnchor : realised < priceAtAnchor;
      if (directionCorrect) directionalCorrect += 1;
    }

    let landedInBand: boolean | null = null;
    if (low !== null && high !== null) {
      bandedCalls += 1;
      landedInBand = realised >= low && realised <= high;
      if (landedInBand) bandHits += 1;
    }

    /*
     * The baseline the engine has to beat: predicting no change. Without it an
     * accuracy figure means nothing - a market that drifts up 60% of the time
     * makes "BULLISH always" look skilful.
     */
    if (realised === priceAtAnchor) baselineCorrect += 1;

    anchors.push({
      index: i,
      timestamp: series[i].timestamp,
      trend,
      projectedLow: low,
      projectedHigh: high,
      priceAtAnchor,
      signals: evaluated.signals,
      realisedPrice: realised,
      realisedIndex: i + horizon,
      landedInBand,
      directionCorrect,
    });
  }

  return {
    bank: params.bank,
    amountKey: params.amountKey,
    side: params.side,
    anchorsEvaluated: anchors.length,
    anchorsSkipped: skipped,
    skipReasons,
    directionalCalls,
    directionalCorrect,
    directionalAccuracy: directionalCalls === 0 ? null : directionalCorrect / directionalCalls,
    bandedCalls,
    bandHits,
    bandCoverage: bandedCalls === 0 ? null : bandHits / bandedCalls,
    baselineCorrect,
    baselineAccuracy: anchors.length === 0 ? null : baselineCorrect / anchors.length,
    anchors,
    reason: anchors.length === 0 ? 'INSUFFICIENT_HISTORY' : null,
  };
}
