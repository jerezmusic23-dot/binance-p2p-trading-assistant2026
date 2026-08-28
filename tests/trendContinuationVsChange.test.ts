/**
 * CONTINUACIÓN vs CAMBIO.
 *
 * The rule the operator stated, and the one this file holds shut:
 *
 *     ALCISTA -> ALCISTA -> ALCISTA -> ALCISTA   -> ONE signal, not four
 *     ALCISTA -> LATERAL                          -> a new event
 *     LATERAL -> BAJISTA                          -> a new event
 *     ALCISTA -> BAJISTA                          -> a new event, more important
 *
 * Only the last of those used to fire. The condition required BOTH the old and
 * the new reading to be directional, so a trend fading into sideways - the
 * moment a maker stops pushing - said nothing, and neither did a flat market
 * that started to move.
 *
 * The importance difference is real, not decorative: a reversal contradicts
 * what the operator was last told and can be CONFIRMED (IMPORTANT); a fade or
 * an emergence is a change of regime and stays EARLY_WARNING (WARNING).
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_SIGNAL_MEMORY, evaluateSignals } from '../server/signalEngine.js';
import { projectCell } from '../server/makerProjectionEngine.js';
import { priorityOf } from '../server/alertScheduler.js';
import { ramp, seriesFromBuyPrices } from './helpers/series.js';
import type { HistoricalObservation } from '../server/historicalMarketStore.js';
import type { SignalMemory } from '../server/signalEngine.js';

const CELL = {
  bank: 'VENEZUELA',
  bankDisplayName: 'Banco de Venezuela',
  amountKey: '10K',
  amountVes: 10_000,
};
const KEY = 'VENEZUELA:10K:BUY';

function step(series: HistoricalObservation[], price: number, memory: SignalMemory) {
  return evaluateSignals({
    projections: [projectCell({ ...CELL, series, currentBuyPrice: price, currentSellPrice: null })],
    memory,
  });
}

/** A price path that stays flat: no move clears the cell's own noise. */
const flatPath = (level: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => level + [0, 0.01, 0, -0.01][i % 4]);

describe('CONTINUACIÓN — a trend that holds says nothing more', () => {
  it('four consecutive bullish readings produce ONE change signal at most', () => {
    let series = seriesFromBuyPrices(ramp(950, 940, 25)); // establish BEARISH
    let memory = step(series, 940, EMPTY_SIGNAL_MEMORY).memory;
    expect(memory.lastTrend[KEY]).toBe('BEARISH');

    // Now it turns and keeps climbing, evaluated four times as it extends.
    const changes: string[] = [];
    for (const extra of [25, 30, 35, 40]) {
      series = seriesFromBuyPrices([...ramp(950, 940, 25), ...ramp(940, 955, extra)]);
      const result = step(series, 955, memory);
      memory = result.memory;
      for (const s of result.signals.filter((s) => s.kind === 'TREND_CHANGE')) {
        changes.push(s.identity);
      }
    }

    // The change is derived on the first of the four; the identity is stable,
    // so every later re-derivation is the SAME event, not a new one.
    expect(changes.length).toBeGreaterThan(0);
    expect(new Set(changes).size).toBe(1);
    expect(changes[0]).toContain('BEARISH->BULLISH');
  });

  it('the memory records the reading even when nothing is announced', () => {
    const rising = seriesFromBuyPrices(ramp(940, 955, 30));
    const first = step(rising, 955, EMPTY_SIGNAL_MEMORY);

    // The first reading has nothing to differ from: silent, and remembered.
    expect(first.signals.filter((s) => s.kind === 'TREND_CHANGE')).toEqual([]);
    expect(first.memory.lastTrend[KEY]).toBe('BULLISH');
    expect(first.memory.lastReading[KEY]).toBe('BULLISH');
  });
});

describe('CAMBIO — each transition is its own event', () => {
  it('ALCISTA -> LATERAL is announced, and was previously silent', () => {
    const rising = seriesFromBuyPrices(ramp(940, 955, 30));
    const established = step(rising, 955, EMPTY_SIGNAL_MEMORY);
    expect(established.memory.lastReading[KEY]).toBe('BULLISH');

    // The climb stops and the price sits still.
    const stalled = seriesFromBuyPrices([...ramp(940, 955, 30), ...flatPath(955, 30)]);
    const result = step(stalled, 955, established.memory);
    const change = result.signals.find((s) => s.kind === 'TREND_CHANGE');

    expect(change).toBeDefined();
    expect(change!.headline).toContain('BULLISH →');
    expect(change!.evidence.join(' ')).toMatch(/ha dejado de sostenerse/);
    // A fade is a change of regime, not a contradiction: it does not interrupt
    // as loudly as a reversal.
    expect(change!.status).toBe('EARLY_WARNING');
    expect(priorityOf(change!)).toBe('WARNING');
  });

  it('LATERAL -> BAJISTA is announced', () => {
    const flatSeries = seriesFromBuyPrices(flatPath(950, 30));
    const established = step(flatSeries, 950, EMPTY_SIGNAL_MEMORY);
    expect(['SIDEWAYS', 'TRANSITION']).toContain(established.memory.lastReading[KEY]);

    const falling = seriesFromBuyPrices([...flatPath(950, 30), ...ramp(950, 935, 30)]);
    const result = step(falling, 935, established.memory);
    const change = result.signals.find((s) => s.kind === 'TREND_CHANGE');

    expect(change).toBeDefined();
    expect(change!.headline).toContain('→ BEARISH');
    expect(change!.evidence.join(' ')).toMatch(/ha empezado a moverse/);
    expect(change!.status).toBe('EARLY_WARNING');
  });

  it('ALCISTA -> BAJISTA outranks both, and can be CONFIRMED', () => {
    const rising = seriesFromBuyPrices(ramp(940, 955, 30));
    const established = step(rising, 955, EMPTY_SIGNAL_MEMORY);

    const reversed = seriesFromBuyPrices([...ramp(940, 955, 30), ...ramp(955, 935, 30)]);
    const result = step(reversed, 935, established.memory);
    const change = result.signals.find((s) => s.kind === 'TREND_CHANGE');

    expect(change).toBeDefined();
    expect(change!.headline).toContain('BULLISH → BEARISH');
    expect(change!.evidence.join(' ')).toMatch(/Cambio de sentido/);
    // A reversal is the only one of the three that reaches IMPORTANT.
    expect(change!.status).toBe('CONFIRMED');
    expect(priorityOf(change!)).toBe('IMPORTANT');
  });

  it('a reversal through the middle is ONE event, not an emergence as well', () => {
    /*
     * BULLISH -> SIDEWAYS -> BEARISH. The fade is announced when it happens;
     * when the fall arrives, the finding is the REVERSAL against the last
     * directional reading, and the emergence out of sideways must not be
     * announced on top of it as a second message about one turn.
     */
    const rising = seriesFromBuyPrices(ramp(940, 955, 30));
    let memory = step(rising, 955, EMPTY_SIGNAL_MEMORY).memory;

    const stalled = seriesFromBuyPrices([...ramp(940, 955, 30), ...flatPath(955, 30)]);
    memory = step(stalled, 955, memory).memory;

    const falling = seriesFromBuyPrices([
      ...ramp(940, 955, 30),
      ...flatPath(955, 30),
      ...ramp(955, 935, 30),
    ]);
    const result = step(falling, 935, memory);
    const changes = result.signals.filter((s) => s.kind === 'TREND_CHANGE');

    expect(changes).toHaveLength(1);
    expect(changes[0].headline).toContain('BULLISH → BEARISH');
  });
});

describe('an outage is not a change of regime', () => {
  it('UNKNOWN never overwrites the remembered reading', () => {
    /*
     * A series too short to read at all returns UNKNOWN. If that were
     * remembered, the first reading after a capture gap would look like
     * "UNKNOWN -> BULLISH" and be announced as a change the market never made.
     */
    const rising = seriesFromBuyPrices(ramp(940, 955, 30));
    const established = step(rising, 955, EMPTY_SIGNAL_MEMORY);
    expect(established.memory.lastReading[KEY]).toBe('BULLISH');

    const tooShort = seriesFromBuyPrices([950, 950]);
    const blind = step(tooShort, 950, established.memory);

    expect(blind.memory.lastReading[KEY]).toBe('BULLISH');
    expect(blind.signals.filter((s) => s.kind === 'TREND_CHANGE')).toEqual([]);
  });
});
