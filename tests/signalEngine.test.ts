/**
 * SIGNALS: what is said, and the far more important question of what is not.
 *
 * Two things this suite exists to prevent:
 *   - an EARLY_WARNING rendered as if it were a CONFIRMED change;
 *   - a signal fired by something that is not the operator's business, such as
 *     a leader moving without the recommendation moving.
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_SIGNAL_MEMORY, evaluateSignals } from '../server/signalEngine.js';
import { projectCell } from '../server/makerProjectionEngine.js';
import { ramp, seriesFromBuyPrices, observation, STEP_MS, T0 } from './helpers/series.js';
import type { HistoricalObservation } from '../server/historicalMarketStore.js';

const CELL = {
  bank: 'VENEZUELA',
  bankDisplayName: 'Banco de Venezuela',
  amountKey: '10K',
  amountVes: 10_000,
};

function project(series: HistoricalObservation[], currentBuyPrice: number | null) {
  return projectCell({ ...CELL, series, currentBuyPrice, currentSellPrice: null });
}

function signalsFor(series: HistoricalObservation[], price: number | null, memory = EMPTY_SIGNAL_MEMORY) {
  return evaluateSignals({ projections: [project(series, price)], memory });
}

describe('4 - cambio alcista y 5 - cambio bajista', () => {
  it('reports a change only against a remembered previous trend', () => {
    const falling = seriesFromBuyPrices(ramp(950, 940, 25));
    const first = signalsFor(falling, 940);

    // Nothing to compare against yet: the first reading is not a change.
    expect(first.signals.filter((s) => s.kind === 'TREND_CHANGE')).toEqual([]);
    expect(first.memory.lastTrend['VENEZUELA:10K:BUY']).toBe('BEARISH');

    const rising = seriesFromBuyPrices([...ramp(950, 940, 25), ...ramp(940, 950, 25)]);
    const second = signalsFor(rising, 950, first.memory);
    const change = second.signals.find((s) => s.kind === 'TREND_CHANGE');

    expect(change).toBeDefined();
    expect(change!.headline).toContain('BEARISH → BULLISH');
    expect(change!.evidence.join(' ')).toMatch(/Tendencia anterior registrada: BEARISH/);
  });

  it('BUG: a TRANSITION must not overwrite the remembered trend', () => {
    /*
     * If TRANSITION were recorded, the next real reversal would compare
     * against "TRANSITION", never match a directional pair, and never fire.
     */
    const falling = seriesFromBuyPrices(ramp(950, 940, 25));
    const memory = signalsFor(falling, 940).memory;

    const transitioning = seriesFromBuyPrices([...ramp(950, 940, 25), ...ramp(940, 941, 6)]);
    const after = signalsFor(transitioning, 941, memory);

    expect(after.memory.lastTrend['VENEZUELA:10K:BUY']).toBe('BEARISH');
  });
});

describe('an early warning is never dressed as a confirmation', () => {
  it('marks exhaustion EARLY_WARNING, always', () => {
    const prices = [...ramp(940, 945, 14), 945.4, 945.6, 945.7, 945.75, 945.78, 945.8];
    const { signals } = signalsFor(seriesFromBuyPrices(prices), 945.8);
    const exhaustion = signals.find((s) => s.kind === 'EXHAUSTION');

    expect(exhaustion).toBeDefined();
    expect(exhaustion!.status).toBe('EARLY_WARNING');
    expect(exhaustion!.headline).toMatch(/posible agotamiento/);
  });

  it('carries confidence and sample size on every signal', () => {
    const prices = [...ramp(940, 945, 14), 945.4, 945.6, 945.7, 945.75, 945.78, 945.8];
    const { signals } = signalsFor(seriesFromBuyPrices(prices), 945.8);

    for (const signal of signals) {
      expect(signal.confidence).toBeDefined();
      expect(signal.sampleSize).toBeGreaterThan(0);
      expect(signal.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe('9 - ruptura', () => {
  const wave = [940, 942, 944, 946, 944, 942, 940, 942, 944, 946, 944, 942, 940, 942, 944, 946, 944, 942, 940];

  it('reports a breakout above every observed ceiling', () => {
    const { signals } = signalsFor(seriesFromBuyPrices([...wave, 952]), 952);
    const breakout = signals.find((s) => s.kind === 'BREAKOUT_UP');

    expect(breakout).toBeDefined();
    expect(breakout!.status).toBe('CONFIRMED');
    expect(breakout!.evidence.join(' ')).toMatch(/Nivel roto: 946\.00/);
    expect(breakout!.evidence.join(' ')).toMatch(/pasos típicos/);
  });

  it('calls a hair over the level an EARLY_WARNING, not a breakout', () => {
    // Inside one typical step of the ceiling: that is the noise that built it.
    const { signals } = signalsFor(seriesFromBuyPrices([...wave, 946.5]), 946.5);
    const breakout = signals.find((s) => s.kind === 'BREAKOUT_UP');

    expect(breakout).toBeDefined();
    expect(breakout!.status).toBe('EARLY_WARNING');
  });

  it('reports a breakout below every observed floor', () => {
    const { signals } = signalsFor(seriesFromBuyPrices([...wave, 930]), 930);
    expect(signals.find((s) => s.kind === 'BREAKOUT_DOWN')).toBeDefined();
  });
});

describe('10 - ausencia de datos y 11 - muestras insuficientes', () => {
  it('says nothing at all from an empty series', () => {
    expect(signalsFor([], null).signals).toEqual([]);
  });

  it('says nothing from a series too short to support a direction', () => {
    expect(signalsFor(seriesFromBuyPrices(ramp(940, 946, 4)), 946).signals).toEqual([]);
  });
});

describe('BUG: a leader that moves without moving my price must produce no signal', () => {
  it('ignores changes to leader, position, volume and advNo', () => {
    const flat = Array.from({ length: 25 }, (_, i) =>
      observation({
        timestamp: T0 + i * STEP_MS,
        buyRecommendedPrice: 940,
        sellRecommendedPrice: 945,
        // Everything else churns violently, observation by observation.
        buyLeaderPrice: 939.99 - i * 0.5,
        buyPosition: (i % 7) + 1,
        buyAvailableUsdt: i * 137,
        buyCompetitorCount: (i % 11) + 1,
      })
    );

    const { signals } = signalsFor(flat, 940);
    // A price that has not moved is not a trend, a change or a breakout.
    expect(signals.filter((s) => s.kind === 'TREND_CHANGE')).toEqual([]);
    expect(signals.filter((s) => s.kind === 'BREAKOUT_UP')).toEqual([]);
    expect(signals.filter((s) => s.kind === 'EXHAUSTION')).toEqual([]);
  });
});

describe('the maker semantics survive into the signal', () => {
  it('labels the BUY side as MI COMPRA and points it at the SELL listing', () => {
    const projection = project(seriesFromBuyPrices(ramp(940, 946, 25)), 946);

    expect(projection.buy.label).toBe('MI COMPRA DE USDT');
    expect(projection.buy.listingTradeType).toBe('SELL');
    expect(projection.sell.label).toBe('MI VENTA DE USDT');
    expect(projection.sell.listingTradeType).toBe('BUY');
  });

  it('never emits taker vocabulary in a headline or an evidence line', () => {
    const { signals } = signalsFor(seriesFromBuyPrices([...ramp(950, 940, 25), ...ramp(940, 950, 25)]), 950);
    const text = signals.flatMap((s) => [s.headline, ...s.evidence]).join(' ');

    expect(text).not.toMatch(/ARBITRAJE|OPORTUNIDAD|EXECUTABLE|Binance ASK|Binance BID/i);
  });
});

describe('ACTUAL and PROYECTADO never share a field', () => {
  it('keeps the live price apart from the projected band', () => {
    const { signals } = signalsFor(seriesFromBuyPrices([...ramp(950, 940, 25), ...ramp(940, 950, 25)]), 950);
    const signal = signals[0];

    expect(signal.currentPrice).toBe(950);
    // The band is a separate pair of fields, and may be null independently.
    expect(signal).toHaveProperty('projectedLow');
    expect(signal).toHaveProperty('projectedHigh');
  });
});

/**
 * TWO REFUSALS THAT A LIVE RUN FOUND.
 *
 * Driving the real store for 150 simulated minutes produced 744 signal
 * messages out of 759 sent. Neither cause is visible from a single cell, which
 * is why unit tests over one projection had missed both.
 */
describe('BUG: a shared reading must not become 42 identical alerts', () => {
  it('says nothing at all from a borrowed reading', () => {
    const general = seriesFromBuyPrices(ramp(940, 960, 60));
    const borrowed = projectCell({
      ...CELL,
      series: seriesFromBuyPrices([940, 940.5, 941]),
      currentBuyPrice: 960,
      currentSellPrice: null,
      generalSeries: general,
    });

    expect(borrowed.buy.borrowedFrom).toBe('MERCADO GENERAL');
    // The reading still exists and still renders; it is simply not news 42
    // times over, once per cell that borrowed the same series.
    expect(borrowed.buy.trend.trend).not.toBe('UNKNOWN');
    expect(evaluateSignals({ projections: [borrowed], memory: EMPTY_SIGNAL_MEMORY }).signals)
      .toEqual([]);
  });

  it('says nothing about a cell with no live price to publish', () => {
    const projection = projectCell({
      ...CELL,
      series: seriesFromBuyPrices(ramp(940, 960, 60)),
      // No recommendation right now: nothing to act on, so nothing to say.
      currentBuyPrice: null,
      currentSellPrice: null,
    });

    expect(evaluateSignals({ projections: [projection], memory: EMPTY_SIGNAL_MEMORY }).signals)
      .toEqual([]);
  });

  it('still speaks when the cell has its own reading and a live price', () => {
    const projection = projectCell({
      ...CELL,
      series: seriesFromBuyPrices(ramp(940, 960, 60)),
      currentBuyPrice: 960,
      currentSellPrice: null,
    });

    expect(projection.buy.borrowedFrom).toBeNull();
    expect(
      evaluateSignals({ projections: [projection], memory: EMPTY_SIGNAL_MEMORY }).signals.length
    ).toBeGreaterThan(0);
  });
});

describe('BUG: a breakout that continues is the same breakout', () => {
  it('keeps one identity while the move is sustained', () => {
    const wave = [940, 942, 944, 946, 944, 942, 940, 942, 944, 946, 944, 942, 940];

    const first = evaluateSignals({
      projections: [
        projectCell({
          ...CELL,
          series: seriesFromBuyPrices([...wave, 952]),
          currentBuyPrice: 952,
          currentSellPrice: null,
        }),
      ],
      memory: EMPTY_SIGNAL_MEMORY,
    }).signals.find((s) => s.kind === 'BREAKOUT_UP');

    const later = evaluateSignals({
      projections: [
        projectCell({
          ...CELL,
          series: seriesFromBuyPrices([...wave, 952, 954, 956]),
          currentBuyPrice: 956,
          currentSellPrice: null,
        }),
      ],
      memory: EMPTY_SIGNAL_MEMORY,
    }).signals.find((s) => s.kind === 'BREAKOUT_UP');

    /*
     * Keying the identity on the broken LEVEL made every sweep of a rising
     * market a brand-new event, so deduplication never matched and one
     * continuing move became a stream of messages.
     */
    expect(first).toBeDefined();
    expect(later).toBeDefined();
    expect(later!.identity).toBe(first!.identity);
  });
});
