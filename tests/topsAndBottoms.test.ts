/**
 * TECHOS Y PISOS: posible frente a confirmado, y el fallback de mercado.
 *
 * A top does not mean the price will fall. It means the series has turned here
 * before and the push into it is failing. POSSIBLE while that is still being
 * anticipated; CONFIRMED once the turn has actually been observed. Rendering
 * the two the same way would be the whole defect.
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_SIGNAL_MEMORY, evaluateSignals } from '../server/signalEngine.js';
import { MIN_OBSERVATIONS_FOR_OWN_READING, projectCell } from '../server/makerProjectionEngine.js';
import { ramp, seriesFromBuyPrices } from './helpers/series.js';
import type { HistoricalObservation } from '../server/historicalMarketStore.js';

const CELL = {
  bank: 'VENEZUELA',
  bankDisplayName: 'Banco de Venezuela',
  amountKey: '10K',
  amountVes: 10_000,
};

/** Three clean bounces between 940 and 946, so both zones exist in the data. */
const WAVE = [
  940, 942, 944, 946, 944, 942, 940, 942, 944, 946, 944, 942, 940, 942, 944, 946, 944, 942, 940,
];

function signalsFor(prices: (number | null)[], current: number | null) {
  const projection = projectCell({
    ...CELL,
    series: seriesFromBuyPrices(prices),
    currentBuyPrice: current,
    currentSellPrice: null,
  });
  return { projection, ...evaluateSignals({ projections: [projection], memory: EMPTY_SIGNAL_MEMORY }) };
}

describe('techo', () => {
  it('reports POSSIBLE_TOP while the push into the zone is still on', () => {
    // Climbing into the ceiling for the fourth time.
    const { signals } = signalsFor([...WAVE, 942, 944, 946], 946);
    const top = signals.find((s) => s.kind === 'POSSIBLE_TOP');

    expect(top).toBeDefined();
    expect(top!.status).toBe('EARLY_WARNING');
    expect(top!.headline).toMatch(/posible techo/);
    expect(top!.evidence.join(' ')).toMatch(/La serie giró ahí 3 vez\(ces\)/);
  });

  it('never promises a fall', () => {
    const { signals } = signalsFor([...WAVE, 942, 944, 946], 946);
    const top = signals.find((s) => s.kind === 'POSSIBLE_TOP');
    expect(top!.evidence.join(' ')).toContain('no significa que el precio vaya a bajar');
  });

  it('reports CONFIRMED_TOP once the background was climbing and the turn happened', () => {
    /*
     * Uniform 0.5 steps throughout, so the cell's typical step is unambiguous.
     * A confirmed top needs BOTH a background that was climbing and a turn
     * that clears the same noise - which is demanding on purpose.
     */
    const wave = [941, 941.5, 942, 942.5, 943, 942.5, 942, 941.5, 941, 941.5, 942, 942.5, 943, 942.5, 942, 941.5, 941];
    const climb = Array.from({ length: 9 }, (_, i) => 941 + (i + 1) * 0.5);
    const top = climb[climb.length - 1];
    const fall = Array.from({ length: 4 }, (_, i) => top - (i + 1) * 0.5);

    const { signals, projection } = signalsFor([...wave, ...climb, ...fall], fall[fall.length - 1]);
    const confirmed = signals.find((s) => s.kind === 'CONFIRMED_TOP');

    expect(projection.buy.trend.backgroundDirection).toBe('BULLISH');
    expect(projection.buy.trend.shortDirection).toBe('BEARISH');
    expect(confirmed).toBeDefined();
    expect(confirmed!.status).toBe('CONFIRMED');
    expect(confirmed!.evidence.join(' ')).toMatch(/ya giró a la baja/);
  });

  it('confirms against the background, because the turn erases the climb', () => {
    /*
     * THE DEFECT THIS PINS: measured live, a fall big enough to turn the short
     * window also drags the medium window's net move back to flat - so
     * "medium BULLISH and short BEARISH" could never both hold and no top
     * could ever be confirmed. The background is the medium window with the
     * recent move cut off, which keeps saying what it was doing.
     */
    const wave = [941, 941.5, 942, 942.5, 943, 942.5, 942, 941.5, 941, 941.5, 942, 942.5, 943, 942.5, 942, 941.5, 941];
    const climb = Array.from({ length: 9 }, (_, i) => 941 + (i + 1) * 0.5);
    const top = climb[climb.length - 1];
    const fall = Array.from({ length: 4 }, (_, i) => top - (i + 1) * 0.5);

    const { projection } = signalsFor([...wave, ...climb, ...fall], fall[fall.length - 1]);

    // The live medium reading has already been flattened by the fall...
    expect(projection.buy.trend.mediumDirection).not.toBe('BULLISH');
    // ...and the background still remembers the climb.
    expect(projection.buy.trend.backgroundDirection).toBe('BULLISH');
  });

  it('reports a top the price has just left, not only one it is standing on', () => {
    const wave = [941, 941.5, 942, 942.5, 943, 942.5, 942, 941.5, 941, 941.5, 942, 942.5, 943, 942.5, 942, 941.5, 941];
    const { projection } = signalsFor([...wave, 941.5, 942, 942.5, 943, 942.5, 942], 942);

    // No longer at 943, but it was there within the recent window.
    expect(projection.buy.atCeiling).toBeNull();
    expect(projection.buy.reachedCeiling).not.toBeNull();
  });
});

describe('piso', () => {
  it('reports POSSIBLE_BOTTOM while the fall into the zone is still on', () => {
    const { signals } = signalsFor([...WAVE, 944, 942, 940], 940);
    const bottom = signals.find((s) => s.kind === 'POSSIBLE_BOTTOM');

    expect(bottom).toBeDefined();
    expect(bottom!.status).toBe('EARLY_WARNING');
    expect(bottom!.evidence.join(' ')).toContain('no significa que el precio vaya a subir');
  });
});

describe('no zone, no claim', () => {
  it('claims nothing when the series never turned', () => {
    const { signals } = signalsFor(ramp(940, 960, 30), 960);
    expect(signals.filter((s) => s.kind.includes('TOP'))).toEqual([]);
    expect(signals.filter((s) => s.kind.includes('BOTTOM'))).toEqual([]);
  });
});

describe('fallback al mercado general', () => {
  const thin = seriesFromBuyPrices([940, 940.5, 941]);
  const general: HistoricalObservation[] = seriesFromBuyPrices(ramp(940, 950, 60));

  it('borrows the general market when the cell is too thin, and labels it', () => {
    const projection = projectCell({
      ...CELL,
      series: thin,
      currentBuyPrice: 941,
      currentSellPrice: null,
      generalSeries: general,
    });

    expect(thin.length).toBeLessThan(MIN_OBSERVATIONS_FOR_OWN_READING);
    expect(projection.borrowedFrom).toBe('MERCADO GENERAL');
    expect(projection.buy.borrowedFrom).toBe('MERCADO GENERAL');
    // The cell's OWN counts are still reported, never the borrowed ones.
    expect(projection.observations).toBe(3);
  });

  it('reduces the confidence of every signal built from a borrowed reading', () => {
    const borrowed = projectCell({
      ...CELL,
      series: thin,
      currentBuyPrice: 950,
      currentSellPrice: null,
      generalSeries: general,
    });
    const own = projectCell({
      ...CELL,
      series: general,
      currentBuyPrice: 950,
      currentSellPrice: null,
    });

    const borrowedSignals = evaluateSignals({
      projections: [borrowed],
      memory: EMPTY_SIGNAL_MEMORY,
    }).signals;
    const ownSignals = evaluateSignals({ projections: [own], memory: EMPTY_SIGNAL_MEMORY }).signals;

    for (const signal of borrowedSignals) {
      expect(signal.evidence.join(' ')).toMatch(/Confianza reducida/);
      expect(signal.confidence).not.toBe('HIGH');
    }
    // The same reading on the cell's own data is not downgraded.
    for (const signal of ownSignals) {
      expect(signal.evidence.join(' ')).not.toMatch(/Confianza reducida/);
    }
  });

  it('does not borrow when the general market is no better informed', () => {
    const projection = projectCell({
      ...CELL,
      series: thin,
      currentBuyPrice: 941,
      currentSellPrice: null,
      generalSeries: seriesFromBuyPrices([940, 941]),
    });

    expect(projection.borrowedFrom).toBeNull();
    expect(projection.reason).toBe('INSUFFICIENT_HISTORY');
  });

  it('reads the cell on its own terms once it has enough', () => {
    const projection = projectCell({
      ...CELL,
      series: general,
      currentBuyPrice: 950,
      currentSellPrice: null,
      generalSeries: general,
    });
    expect(projection.borrowedFrom).toBeNull();
  });
});

describe('continuation counted from the cell own history', () => {
  it('reports the outcome distribution with its sample size', () => {
    const projection = projectCell({
      ...CELL,
      series: seriesFromBuyPrices(ramp(940, 960, 60)),
      currentBuyPrice: 960,
      currentSellPrice: null,
    });

    const overall = projection.buy.continuation.overall;
    expect(overall.sampleSize).toBeGreaterThan(0);
    expect(overall.upRate).toBe(1);
    expect(projection.buy.continuation.byDay).toHaveLength(7);
  });

  it('reports INSUFFICIENT_HISTORY instead of a rate from a short series', () => {
    const projection = projectCell({
      ...CELL,
      series: seriesFromBuyPrices([940, 941, 942]),
      currentBuyPrice: 942,
      currentSellPrice: null,
    });
    expect(projection.buy.continuation.overall.upRate).toBeNull();
  });
});
