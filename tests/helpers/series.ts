/**
 * Deterministic series builders for the projection suites.
 *
 * These are TEST INPUTS ONLY. They describe shapes - a rising series, a
 * reversal, a flat stretch - and say nothing about the real USDT/VES market.
 * No fixture here is ever written to a production data directory.
 */

import type { HistoricalObservation } from '../../server/historicalMarketStore.js';

export const T0 = Date.UTC(2026, 7, 1, 12, 0, 0);
/** The cadence the tier rotation actually produces: one sweep per 4.5 min. */
export const STEP_MS = 270_000;

export function observation(
  overrides: Partial<HistoricalObservation> & { timestamp: number }
): HistoricalObservation {
  const buy = overrides.buyRecommendedPrice ?? 940;
  const sell = overrides.sellRecommendedPrice ?? 945;
  return {
    bank: 'VENEZUELA',
    amountKey: '10K',
    amountVes: 10_000,
    buyLeaderPrice: buy === null ? null : buy - 0.01,
    buyRecommendedPrice: buy,
    sellLeaderPrice: sell === null ? null : sell + 0.01,
    sellRecommendedPrice: sell,
    buySpreadVsPrevious: null,
    sellSpreadVsPrevious: null,
    grossSpreadVes: buy !== null && sell !== null ? Number((sell - buy).toFixed(8)) : null,
    grossSpreadPct: buy !== null && sell !== null ? ((sell - buy) / buy) * 100 : null,
    buyPosition: 1,
    sellPosition: 1,
    buyAvailableUsdt: 0,
    sellAvailableUsdt: 0,
    buyCompetitorCount: 5,
    sellCompetitorCount: 5,
    marketStatus: 'PUBLISH_AT_TOP',
    tick: 0.01,
    tickProvenance: 'OBSERVED',
    provenance: null,
    ...overrides,
  };
}

/** A series whose BUY price follows the given prices, one per sweep. */
export function seriesFromBuyPrices(
  prices: readonly (number | null)[],
  opts: { startMs?: number; stepMs?: number } = {}
): HistoricalObservation[] {
  const start = opts.startMs ?? T0;
  const step = opts.stepMs ?? STEP_MS;
  return prices.map((price, i) =>
    observation({
      timestamp: start + i * step,
      buyRecommendedPrice: price,
      sellRecommendedPrice: price === null ? null : price + 5,
    })
  );
}

/** Straight line from `from` to `to` in `count` points. */
export function ramp(from: number, to: number, count: number): number[] {
  if (count <= 1) return [from];
  const stepSize = (to - from) / (count - 1);
  return Array.from({ length: count }, (_, i) => Number((from + i * stepSize).toFixed(4)));
}

/** Alternates around `centre` by `amplitude`, deterministically. */
export function oscillate(centre: number, amplitude: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) =>
    Number((centre + (i % 2 === 0 ? amplitude : -amplitude)).toFixed(4))
  );
}
