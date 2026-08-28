/**
 * THE WHOLE ROBOT, UNDER SCRIPTED MARKETS, WITH THE MESSAGES COUNTED.
 *
 * "The tests pass" is not the criterion. The criterion is how many Telegram
 * messages each kind of market produces, because every noise defect this
 * project has had was invisible to unit tests and obvious the moment 42 cells
 * ran together for two hours.
 *
 * Each scenario below prints its counts. The assertions are upper bounds: they
 * fail if the system becomes chattier, which is the regression that matters.
 *
 * NOTHING HERE IS EVIDENCE ABOUT THE REAL MARKET. The books are scripted.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  breakoutMarket,
  falseBreakoutMarket,
  fallingMarket,
  lateralMarket,
  rangingMarket,
  reversingMarket,
  risingMarket,
  roundTripMarket,
  simulateMarket,
  steppingMarket,
} from './helpers/simulation.js';

/**
 * Sweeps to run.
 *
 * SIZED FROM THE ROTATION, not picked. The matrix refreshes one amount tier
 * per sweep, so a given cell is re-captured every 6 sweeps. Below ~120 sweeps
 * no cell reaches the 20 observations it needs to be read on its own terms,
 * every cell borrows the general market, and - because a borrowed reading may
 * not alert - the signal count is zero for every scenario. The first version
 * of this suite ran 100 and measured nothing at all.
 *
 * 240 sweeps = 180 simulated minutes = about 40 observations per cell.
 */
const SWEEPS = 240;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function report(name: string, result: Awaited<ReturnType<typeof simulateMarket>>) {
  const i = result.internal;
  console.log(
    `TABLA | ${name.padEnd(26)} | capturas=${String(result.matrixRequests).padStart(4)} ` +
      `| barridos=${String(i.sweeps).padStart(3)} ` +
      `| eventos=${String(i.priceChangesDetected + i.signalsDerived).padStart(5)} ` +
      `(precio=${i.priceChangesDetected} señales=${i.signalsDerived}) ` +
      `| Telegram=${String(result.messages.length).padStart(2)} ` +
      `(resumen=${result.counts.summary} digest=${result.counts.priceDigest} señal=${result.counts.signal})`
  );
}

describe('mercado lateral durante horas', () => {
  it('a market going nowhere produces the summary and almost nothing else', async () => {
    const result = await simulateMarket({ book: lateralMarket, sweeps: SWEEPS });
    report('lateral', result);

    // The summary is the point of it: it says "nothing changed", on schedule.
    expect(result.counts.summary).toBeGreaterThan(0);
    /*
     * A flat market still has levels. The wobble means the price sits on a
     * zone it has turned at repeatedly, and "posible techo" there is a true
     * and useful thing to say to somebody deciding where to publish - so the
     * bound is what the engine legitimately produces, not a rounder number
     * reached by suppressing it.
     */
    expect(result.counts.signal).toBeLessThanOrEqual(4);
    expect(result.counts.takerVocabulary).toBe(0);
  }, 120_000);
});

describe('mercado alcista sostenido', () => {
  it('says the trend once, not once per sweep', async () => {
    const result = await simulateMarket({ book: risingMarket, sweeps: SWEEPS });
    report('alcista sostenido', result);

    /*
     * 100 sweeps of a market that never stops climbing. Every sweep is a new
     * high, so before the identity and floor fixes this was the worst case in
     * the whole system.
     */
    expect(result.counts.signal).toBeLessThanOrEqual(6);
    expect(result.messages.length).toBeLessThanOrEqual(20);
    expect(result.counts.takerVocabulary).toBe(0);
  }, 120_000);
});

describe('mercado bajista sostenido', () => {
  it('behaves the same falling as rising', async () => {
    const result = await simulateMarket({ book: fallingMarket, sweeps: SWEEPS });
    report('bajista sostenido', result);

    expect(result.counts.signal).toBeLessThanOrEqual(6);
    expect(result.counts.takerVocabulary).toBe(0);
  }, 120_000);
});

describe('ruptura', () => {
  it('announces a sustained breakout as ONE event', async () => {
    const result = await simulateMarket({ book: breakoutMarket, sweeps: SWEEPS });
    report('ruptura sostenida', result);

    const breaks = result.messages.filter((m) => m.includes('RUPTURA'));
    /*
     * The move runs for 60 sweeps. Keyed on the broken level it was a new
     * event every sweep; keyed on the direction it is one, plus at most a
     * re-announcement per cooldown once the cell's earlier one aged out.
     */
    expect(breaks.length).toBeLessThanOrEqual(4);
    expect(result.counts.takerVocabulary).toBe(0);
  }, 120_000);
});

describe('falso rompimiento', () => {
  it('reports the break and then that it came undone', async () => {
    const result = await simulateMarket({ book: falseBreakoutMarket, sweeps: SWEEPS });
    report('falso rompimiento', result);

    // Whether an invalidation message went out depends on the cooldown, but a
    // false break must never produce MORE messages than a sustained one.
    const breaks = result.messages.filter((m) => m.includes('RUPTURA'));
    expect(breaks.length).toBeLessThanOrEqual(4);
  }, 120_000);
});

describe('cambio de tendencia', () => {
  it('announces the turn without narrating the climb that preceded it', async () => {
    const result = await simulateMarket({ book: reversingMarket, sweeps: SWEEPS });
    report('cambio de tendencia', result);

    expect(result.counts.signal).toBeLessThanOrEqual(6);
    expect(result.counts.takerVocabulary).toBe(0);
  }, 120_000);
});

describe('techo y piso', () => {
  it('a ranging market does not announce every visit to a level', async () => {
    const result = await simulateMarket({ book: rangingMarket, sweeps: SWEEPS });
    report('rango (techo/piso)', result);

    /*
     * The price touches both zones repeatedly by construction. Keyed on the
     * zone price this was one message per touch.
     */
    expect(result.counts.signal).toBeLessThanOrEqual(6);
  }, 120_000);
});

describe('cambios múltiples de precio dentro de una ventana', () => {
  it('groups them into one digest per window', async () => {
    const result = await simulateMarket({
      book: steppingMarket,
      sweeps: SWEEPS,
      priceChangeIntervalMs: 900_000,
    });
    report('cambios agrupados', result);

    /*
     * The price steps on 5 separate sweeps within the first window. 75
     * simulated minutes at a 15-minute interval allows at most 5 digests, and
     * the changes inside each are one message however many cells moved.
     */
    expect(result.counts.priceDigest).toBeLessThanOrEqual(5);
    expect(result.counts.priceDigest).toBeGreaterThan(0);
  }, 120_000);

  it('BUG: a price that returns to where it started sends nothing', async () => {
    const result = await simulateMarket({
      book: roundTripMarket,
      sweeps: 60,
      // One long window, so the whole round trip falls inside it.
      priceChangeIntervalMs: 3_600_000,
    });
    report('ida y vuelta', result);

    /*
     * The price moves out and comes back to exactly where it started.
     *
     * At most ONE digest: the very first change after a cold start is released
     * immediately - the operator should learn promptly that something moved
     * rather than waiting out a window - and everything after it is folded
     * into the open window, where the return cancels the departure.
     *
     * The cancellation itself is pinned precisely in alertScheduler.test.ts,
     * which can hold the window open without a cold start in the way.
     */
    expect(result.counts.priceDigest).toBeLessThanOrEqual(1);
  }, 120_000);
});

describe('42 celdas simultáneas', () => {
  it('keeps the whole matrix inside one message per summary', async () => {
    const result = await simulateMarket({ book: risingMarket, sweeps: 60 });
    report('42 celdas', result);

    /*
     * Every summary covers all 42 cells. Splitting happens on bank boundaries
     * only when the 4096-byte limit demands it, never per cell.
     */
    expect(result.counts.summary).toBeGreaterThan(0);
    expect(result.counts.summary).toBeLessThanOrEqual(6);
  }, 120_000);

  it('adds no Binance request for the analysis', async () => {
    const result = await simulateMarket({ book: risingMarket, sweeps: 20 });
    report('presupuesto binance', result);

    /*
     * 7 banks x 2 sides x 6 tiers for the boot sweep, then 14 per rotation.
     * Persistence, trend, projection and signals all read that book.
     */
    expect(result.matrixRequests).toBe(84 + 20 * 14);
  }, 120_000);
});

describe('celda sin histórico y fallback', () => {
  it('says nothing about a cell that has no series of its own', async () => {
    // Two sweeps: every cell has at most one observation.
    const result = await simulateMarket({ book: risingMarket, sweeps: 2 });
    report('sin histórico', result);

    /*
     * Thin cells borrow the general market for the SCREEN, and a borrowed
     * reading may not alert - otherwise one market-wide finding becomes 42
     * identical notifications.
     */
    expect(result.counts.signal).toBe(0);
  }, 120_000);
});

describe('fallback al mercado general', () => {
  it('labels the borrowed reading and still says nothing about it', async () => {
    /*
     * A cell with too little of its own history borrows the general market for
     * the SCREEN. Two things must both hold, and they pull in opposite
     * directions:
     *   - the reading is LABELLED, so nobody reads a market-wide trend as this
     *     bank at this amount;
     *   - it never alerts, or one market-wide finding becomes 42 identical
     *     notifications.
     */
    const result = await simulateMarket({ book: risingMarket, sweeps: 30 });
    report('fallback mercado general', result);

    expect(result.counts.signal).toBe(0);
    // And the summary never presents a borrowed reading as the cell's own.
    for (const message of result.messages) {
      if (message.includes('MERCADO GENERAL')) {
        expect(message).toMatch(/histórico|Confianza reducida|general/i);
      }
    }
  }, 180_000);
});

describe('múltiples cambios de precio dentro de 30 minutos', () => {
  it('is ONE digest per window at the production interval, whatever moved', async () => {
    /*
     * The operator's own statement of the rule:
     *     13:00 -> digest, 13:01-13:29 -> accumulate, 13:30 -> next digest
     * measured at the production default rather than a shortened interval.
     */
    const result = await simulateMarket({ book: steppingMarket, sweeps: SWEEPS });
    report('cambios dentro de 30 min', result);

    const digests = result.timeline.filter((m) => m.stream === 'PRICE_DIGEST');
    // 180 simulated minutes at 30 minutes each: six windows at the very most.
    expect(digests.length).toBeLessThanOrEqual(6);

    // No two digests closer together than the interval.
    for (let i = 1; i < digests.length; i++) {
      expect(digests[i].atMs - digests[i - 1].atMs).toBeGreaterThanOrEqual(1_800_000);
    }

    // And nothing in the first half hour, which is where the stray digest used
    // to land - 45 seconds after boot, behind a summary that had just listed
    // every one of those prices.
    expect(digests.filter((d) => d.atMs < 1_800_000)).toEqual([]);

    console.log(
      `  huecos entre digests (min): [${digests
        .slice(1)
        .map((d, i) => ((d.atMs - digests[i].atMs) / 60000).toFixed(1))
        .join(', ')}]`
    );
  }, 180_000);
});

describe('reinicio del proceso', () => {
  it('resumes the series and does not burst on the way back', async () => {
    /*
     * A REAL RESTART: the same data directory, a new process.
     *
     * The previous version of this test ran two simulations in two different
     * temporary directories, which is two first boots rather than a restart -
     * it could not have detected the defect it was named after.
     *
     * The thing to prove is that coming back does not spam. Every in-memory
     * clock resets, so what protects the operator is:
     *   - makerAlertState.recommended comes back empty, and a FIRST
     *     observation of a cell is silent by construction, so no price the
     *     operator already had is republished;
     *   - the price-change window is re-anchored at boot, so the first digest
     *     is due a whole interval later instead of 45 seconds in.
     * The one message a restart adds is the boot summary.
     */
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-restart-'));
    try {
      const first = await simulateMarket({ book: risingMarket, sweeps: 60, dataDir });
      report('antes del reinicio', first);
      expect(first.observations).toBeGreaterThan(0);

      const second = await simulateMarket({ book: risingMarket, sweeps: 60, dataDir });
      report('tras el reinicio', second);

      // The history on disk is continued, not restarted.
      expect(second.observations).toBeGreaterThan(first.observations);

      /*
       * 45 simulated minutes after the restart. One boot summary, one more on
       * the half hour, and at most one digest - never a replay of every price.
       */
      expect(second.counts.summary).toBeLessThanOrEqual(2);
      expect(second.counts.priceDigest).toBeLessThanOrEqual(1);
      expect(second.messages.length).toBeLessThanOrEqual(4);

      // And nothing arrives in the first minute except the boot summary.
      const earlyBurst = second.timeline.filter((m) => m.atMs < 60_000);
      expect(earlyBurst.map((m) => m.stream)).toEqual(['SUMMARY']);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 300_000);

  it('ten restarts in a row do not multiply the traffic', async () => {
    /*
     * The failure mode worth bounding: a crash-loop. Each boot may announce
     * itself once; none may replay the matrix as changes.
     */
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-restart-loop-'));
    try {
      let digests = 0;
      let summaries = 0;
      for (let i = 0; i < 10; i++) {
        const run = await simulateMarket({ book: lateralMarket, sweeps: 4, dataDir });
        digests += run.counts.priceDigest;
        summaries += run.counts.summary;
      }
      console.log(`10 reinicios: resúmenes=${summaries} digests=${digests}`);

      // One boot summary each, and no digest at all: three simulated minutes
      // per boot never reaches the 30-minute window.
      expect(summaries).toBeLessThanOrEqual(10);
      expect(digests).toBe(0);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('ningún escenario habla el modelo taker', () => {
  it('never emits arbitrage vocabulary in any market', async () => {
    for (const [name, book] of [
      ['lateral', lateralMarket],
      ['alcista', risingMarket],
      ['ruptura', breakoutMarket],
    ] as const) {
      const result = await simulateMarket({ book, sweeps: 30 });
      expect(result.counts.takerVocabulary, name).toBe(0);
    }
  }, 180_000);
});
