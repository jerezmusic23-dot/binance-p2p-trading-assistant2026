/**
 * WHEN A MESSAGE IS ALLOWED TO LEAVE.
 *
 * The operator's complaint was noise: a notification every time a number
 * moved. This suite pins the fix - detection stays immediate, delivery waits,
 * and a window of many changes becomes one message.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PRICE_CHANGE_INTERVAL_MS,
  DEFAULT_SIGNAL_INTERVAL_MS,
  EMPTY_DIGEST_STATE,
  MIN_SIGNAL_INTERVAL_MS,
  MIN_PRICE_CHANGE_INTERVAL_MS,
  accumulatePriceChange,
  priorityOf,
  readPriceChangeInterval,
  readSignalInterval,
  releasePriceChangeDigest,
  startDigestState,
} from '../server/alertScheduler.js';
import { TelegramNotifier } from '../server/telegramNotifier.js';
import type { MarketSignal } from '../server/signalEngine.js';
import { buildMakerMatrix } from '../server/makerMatrix.js';
import { DEFAULT_MAKER_CONFIG } from '../server/makerStrategy.js';
import { makeNormalizedAd } from './helpers/fixtures.js';

const T0 = Date.UTC(2026, 7, 1, 18, 0, 0);

/** A cell whose recommended buy price is exactly `recommendedBuy`. */
function cellFor(bank: string, amountKey: string, recommendedBuy: number) {
  const ad = (price: number) => ({ ...makeNormalizedAd(price), advNo: `adv-${price}` });
  const witness = {
    ...makeNormalizedAd(900.25),
    advNo: 'w',
    paymentOptions: [{ payType: 'Provincial', tradeMethodName: 'Provincial' }],
  };
  // The recommendation sits one observed tick above the leader.
  const leader = Number((recommendedBuy - 0.01).toFixed(2));

  return buildMakerMatrix({
    bankOrder: [bank],
    bankDisplayNames: { [bank]: bank },
    bankAllowedCodes: { [bank]: ['Banesco'] },
    amounts: [{ key: amountKey, val: 10_000 }],
    listingsByTier: {
      [amountKey]: { [bank]: { SELL: [ad(leader), witness], BUY: [ad(950), witness] } },
    },
    failedBanksByTier: {},
    capturedAtByTier: { [amountKey]: T0 },
    capturedAt: T0,
    config: DEFAULT_MAKER_CONFIG,
    nowMs: T0,
  }).cells[bank][amountKey];
}

function change(bank: string, amountKey: string, from: number, to: number) {
  const cell = cellFor(bank, amountKey, to);
  return {
    cell,
    pairing: cell.recommendation!.recommended!,
    previous: { buyPrice: from, sellPrice: cell.recommendation!.recommended!.sell.price },
  };
}

describe('the window is anchored at start-up, not at the first change', () => {
  /*
   * MEASURED DEFECT. With lastReleasedAt null, releasePriceChangeDigest fires
   * as soon as it has anything - on a running process that is the sweep about
   * 45 seconds after boot. On a scripted rising market the merged timeline read
   *
   *     0m02 SUMMARY | 0m45 DIGEST | 30m45 SUMMARY+DIGEST | ...
   *
   * so every start, and every restart, put a "what changed" message on the wire
   * one sweep behind a summary that had just listed all of those prices.
   *
   * The shape asked for is: 13:00 digest, accumulate to 13:29, 13:30 next.
   */
  const HALF_HOUR = DEFAULT_PRICE_CHANGE_INTERVAL_MS;

  it('startDigestState fixes the origin of the first window', () => {
    expect(startDigestState(T0)).toEqual({ pending: {}, lastReleasedAt: T0 });
  });

  it('holds the first digest for a full interval after boot', () => {
    let state = startDigestState(T0);
    state = accumulatePriceChange(state, change('banesco', '10K', 940.01, 940.21), T0 + 45_000);

    // 45 seconds in - where the stray digest used to be emitted.
    expect(releasePriceChangeDigest(state, T0 + 45_000, HALF_HOUR).digest).toBeNull();
    // One second short of the boundary.
    expect(releasePriceChangeDigest(state, T0 + HALF_HOUR - 1, HALF_HOUR).digest).toBeNull();

    const due = releasePriceChangeDigest(state, T0 + HALF_HOUR, HALF_HOUR);
    expect(due.digest).not.toBeNull();
    expect(due.digest!.changes).toHaveLength(1);
  });

  it('accumulates the whole first window instead of reporting each move', () => {
    let state = startDigestState(T0);
    // Four cells move at four different minutes inside the first window.
    state = accumulatePriceChange(state, change('banesco', '10K', 940.01, 940.21), T0 + 60_000);
    state = accumulatePriceChange(state, change('banesco', '20K', 941.01, 941.31), T0 + 420_000);
    state = accumulatePriceChange(state, change('mercantil', '30K', 942.01, 942.11), T0 + 1_080_000);
    state = accumulatePriceChange(state, change('venezuela', '50K', 943.01, 943.51), T0 + 1_740_000);

    // Nothing at any of those instants.
    for (const at of [60_000, 420_000, 1_080_000, 1_740_000]) {
      expect(releasePriceChangeDigest(state, T0 + at, HALF_HOUR).digest).toBeNull();
    }

    const released = releasePriceChangeDigest(state, T0 + HALF_HOUR, HALF_HOUR);
    expect(released.digest!.changes).toHaveLength(4);
    // ONE digest, four cells - not four messages.
    expect(released.state.pending).toEqual({});
  });

  it('a restart cannot bring the digest forward', () => {
    /*
     * The process dies mid-window and comes back. The pending window is lost -
     * that is the accepted cost - but the clock restarts from the new boot, so
     * the operator does not get a digest 45 seconds after every restart.
     */
    const rebootAt = T0 + 12 * 60_000;
    let fresh = startDigestState(rebootAt);
    fresh = accumulatePriceChange(fresh, change('banesco', '10K', 940.01, 940.21), rebootAt + 45_000);

    expect(releasePriceChangeDigest(fresh, rebootAt + 45_000, HALF_HOUR).digest).toBeNull();
    expect(
      releasePriceChangeDigest(fresh, rebootAt + HALF_HOUR, HALF_HOUR).digest
    ).not.toBeNull();
  });

  it('EMPTY_DIGEST_STATE keeps the unanchored form for pure timelines', () => {
    expect(EMPTY_DIGEST_STATE.lastReleasedAt).toBeNull();
  });
});

describe('the configurable interval', () => {
  it('defaults to 30 minutes', () => {
    expect(DEFAULT_PRICE_CHANGE_INTERVAL_MS).toBe(1_800_000);
    expect(readPriceChangeInterval({}).intervalMs).toBe(1_800_000);
  });

  it('reads MAKER_PRICE_CHANGE_ALERT_INTERVAL_MS', () => {
    const read = readPriceChangeInterval({ MAKER_PRICE_CHANGE_ALERT_INTERVAL_MS: '1800000' });
    expect(read.intervalMs).toBe(1_800_000);
    expect(read.clamped).toBe(false);
  });

  it('accepts 15 minutes, the documented minimum', () => {
    const read = readPriceChangeInterval({ MAKER_PRICE_CHANGE_ALERT_INTERVAL_MS: '900000' });
    expect(read.intervalMs).toBe(MIN_PRICE_CHANGE_INTERVAL_MS);
    expect(read.clamped).toBe(false);
  });

  it('clamps anything shorter, and says that it clamped', () => {
    const read = readPriceChangeInterval({ MAKER_PRICE_CHANGE_ALERT_INTERVAL_MS: '5000' });
    expect(read.intervalMs).toBe(MIN_PRICE_CHANGE_INTERVAL_MS);
    expect(read.clamped).toBe(true);
  });

  it('falls back to the default for nonsense rather than to zero', () => {
    expect(readPriceChangeInterval({ MAKER_PRICE_CHANGE_ALERT_INTERVAL_MS: 'pronto' }).intervalMs)
      .toBe(DEFAULT_PRICE_CHANGE_INTERVAL_MS);
    expect(readPriceChangeInterval({ MAKER_PRICE_CHANGE_ALERT_INTERVAL_MS: '-1' }).intervalMs)
      .toBe(DEFAULT_PRICE_CHANGE_INTERVAL_MS);
  });
});

describe('grouping: many changes, one message', () => {
  it('accumulates every cell that moved into a single digest', () => {
    let state = EMPTY_DIGEST_STATE;
    state = accumulatePriceChange(state, change('BANESCO', '10K', 942.1, 942.3), T0);
    state = accumulatePriceChange(state, change('BANESCO', '20K', 941.6, 941.8), T0 + 1000);
    state = accumulatePriceChange(state, change('MERCANTIL', '10K', 940.0, 940.2), T0 + 2000);

    const { digest } = releasePriceChangeDigest(state, T0 + 3000, 1_800_000);
    expect(digest!.changes).toHaveLength(3);
  });

  it('orders by bank then by amount, so the message reads like the matrix', () => {
    let state = EMPTY_DIGEST_STATE;
    state = accumulatePriceChange(state, change('MERCANTIL', '10K', 940, 940.2), T0);
    state = accumulatePriceChange(state, change('BANESCO', '20K', 941.6, 941.8), T0);

    const { digest } = releasePriceChangeDigest(state, T0, 1_800_000);
    expect(digest!.changes.map((c) => c.bankDisplayName)).toEqual(['BANESCO', 'MERCANTIL']);
  });
});

describe('the window holds', () => {
  it('releases the first window as soon as it has something to say', () => {
    const state = accumulatePriceChange(EMPTY_DIGEST_STATE, change('BANESCO', '10K', 942.1, 942.3), T0);
    expect(releasePriceChangeDigest(state, T0, 1_800_000).digest).not.toBeNull();
  });

  it('then stays shut until the interval has elapsed', () => {
    let state = releasePriceChangeDigest(
      accumulatePriceChange(EMPTY_DIGEST_STATE, change('BANESCO', '10K', 942.1, 942.3), T0),
      T0,
      1_800_000
    ).state;

    state = accumulatePriceChange(state, change('BANESCO', '10K', 942.3, 942.5), T0 + 60_000);

    expect(releasePriceChangeDigest(state, T0 + 60_000, 1_800_000).digest).toBeNull();
    expect(releasePriceChangeDigest(state, T0 + 1_799_999, 1_800_000).digest).toBeNull();
    expect(releasePriceChangeDigest(state, T0 + 1_800_000, 1_800_000).digest).not.toBeNull();
  });

  it('sends nothing at all when no cell moved', () => {
    expect(releasePriceChangeDigest(EMPTY_DIGEST_STATE, T0, 1_800_000).digest).toBeNull();
  });
});

describe('deduplication inside the window', () => {
  it('keeps the announced price fixed and overwrites only the latest', () => {
    let state = accumulatePriceChange(EMPTY_DIGEST_STATE, change('BANESCO', '10K', 942.1, 942.3), T0);
    state = accumulatePriceChange(state, change('BANESCO', '10K', 942.3, 942.5), T0 + 60_000);
    state = accumulatePriceChange(state, change('BANESCO', '10K', 942.5, 942.7), T0 + 120_000);

    const { digest } = releasePriceChangeDigest(state, T0 + 130_000, 1_800_000);
    const entry = digest!.changes[0];

    expect(entry.announcedBuyPrice).toBe(942.1);
    expect(entry.latestBuyPrice).toBe(942.7);
    expect(entry.detections).toBe(3);
  });

  it('BUG: a cell that returns to its announced price is not a change', () => {
    let state = accumulatePriceChange(EMPTY_DIGEST_STATE, change('BANESCO', '10K', 940.0, 940.2), T0);
    state = accumulatePriceChange(state, change('BANESCO', '10K', 940.2, 940.0), T0 + 60_000);

    const { digest, state: after } = releasePriceChangeDigest(state, T0, 1_800_000);

    expect(digest).toBeNull();
    // The window is cleared even so: the changes were considered and dismissed.
    expect(after.pending).toEqual({});
  });

  it('counts reverted cells alongside real ones rather than hiding them', () => {
    let state = accumulatePriceChange(EMPTY_DIGEST_STATE, change('BANESCO', '10K', 940.0, 940.2), T0);
    state = accumulatePriceChange(state, change('BANESCO', '10K', 940.2, 940.0), T0 + 1000);
    state = accumulatePriceChange(state, change('MERCANTIL', '10K', 941.0, 941.4), T0 + 2000);

    const { digest } = releasePriceChangeDigest(state, T0, 1_800_000);
    expect(digest!.changes).toHaveLength(1);
    expect(digest!.revertedCells).toBe(1);
  });

  it('empties the window after a release, so nothing is sent twice', () => {
    const state = accumulatePriceChange(EMPTY_DIGEST_STATE, change('BANESCO', '10K', 942.1, 942.3), T0);
    const first = releasePriceChangeDigest(state, T0, 1_800_000);

    expect(first.digest).not.toBeNull();
    expect(releasePriceChangeDigest(first.state, T0 + 3_600_000, 1_800_000).digest).toBeNull();
  });
});

describe('priorities', () => {
  it('reserves CRITICAL for a confirmed break', () => {
    expect(priorityOf({ kind: 'BREAKOUT_UP', status: 'CONFIRMED' })).toBe('CRITICAL');
    expect(priorityOf({ kind: 'BREAKOUT_DOWN', status: 'CONFIRMED' })).toBe('CRITICAL');
    expect(priorityOf({ kind: 'BREAKOUT_UP', status: 'EARLY_WARNING' })).toBe('IMPORTANT');
  });

  it('grades a trend change by whether it is confirmed', () => {
    expect(priorityOf({ kind: 'TREND_CHANGE', status: 'CONFIRMED' })).toBe('IMPORTANT');
    expect(priorityOf({ kind: 'TREND_CHANGE', status: 'EARLY_WARNING' })).toBe('WARNING');
  });

  it('keeps exhaustion and zone notes below the interrupting grades', () => {
    expect(priorityOf({ kind: 'EXHAUSTION', status: 'EARLY_WARNING' })).toBe('WARNING');
    expect(priorityOf({ kind: 'ACCUMULATION', status: 'EARLY_WARNING' })).toBe('INFO');
    expect(priorityOf({ kind: 'DISTRIBUTION', status: 'EARLY_WARNING' })).toBe('INFO');
  });
});

/**
 * THE LIMITS A LIVE RUN FOUND.
 *
 * Every rule below exists because driving the real store for 150 simulated
 * minutes produced 744 signal messages out of 759 sent. Unit tests over single
 * cells could not have found any of them: each cause is about what happens
 * when 42 cells behave correctly at the same time.
 */
describe('signal throttling, as measured', () => {
  const notifier = () =>
    new TelegramNotifier({
      botToken: '1234567890:TEST-TOKEN-NOT-REAL',
      chatId: '-1000000000000',
      cooldownMs: 300_000,
      timeoutMs: 1000,
    });

  const signal = (over: Partial<MarketSignal> = {}): MarketSignal => ({
    kind: 'EXHAUSTION',
    status: 'EARLY_WARNING' as const,
    bank: 'BANESCO',
    bankDisplayName: 'Banesco',
    amountKey: '10K',
    amountVes: 10_000,
    side: 'BUY' as const,
    sideLabel: 'MI COMPRA DE USDT',
    headline: 'x',
    evidence: ['y'],
    confidence: 'MEDIUM' as const,
    sampleSize: 20,
    currentPrice: 940,
    projectedLow: 939,
    projectedHigh: 941,
    watchStartHour: null,
    watchEndHour: null,
    identity: 'EXHAUSTION:BANESCO:10K:BUY:BULLISH',
    ...over,
  });

  it('sends one non-critical signal per window across the WHOLE matrix', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await notifier().notifyMarketSignals(
      [
        signal({ bank: 'A', identity: 'a' }),
        signal({ bank: 'B', identity: 'b' }),
        signal({ bank: 'C', identity: 'c' }),
      ],
      T0
    );

    // Per-cell cooldowns bound each cell and say nothing about the total.
    expect(results.filter((r) => r.outcome === 'SENT')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('lets a CRITICAL through ahead of the queue', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await notifier().notifyMarketSignals(
      [
        signal({ bank: 'A', identity: 'a' }),
        signal({ bank: 'B', identity: 'b', kind: 'BREAKOUT_UP', status: 'CONFIRMED' }),
      ],
      T0
    );

    expect(results.filter((r) => r.outcome === 'SENT')).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it('treats a market-wide break as one event, not one per cell', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await notifier().notifyMarketSignals(
      ['A', 'B', 'C', 'D'].map((bank) =>
        signal({ bank, identity: `bk-${bank}`, kind: 'BREAKOUT_UP', status: 'CONFIRMED' })
      ),
      T0
    );

    // Four cells breaking at once is one market movement.
    expect(results.filter((r) => r.outcome === 'SENT')).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('does not re-announce a condition that is still true, however long it holds', async () => {
    /*
     * MEASURED RESERVE, now closed. Dedup keys share the map with the
     * cooldowns, and prune() drops anything older than max(cooldownMs * 10,
     * one hour). prune() only runs when a message is actually sent - so the
     * defect needs OTHER traffic to surface, which is exactly what a live
     * matrix has. A breakout that stayed broken for hours had its identity
     * aged out by somebody else's message and went out a second time: the
     * BREAKOUT-XYZ-01, -02, -03 the operator asked never to see.
     *
     * Here the long-lived condition is cell A. Cell Z produces a fresh
     * CRITICAL every 20 minutes, each of which sends and therefore prunes.
     * A must stay silent throughout.
     */
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const n = notifier();

    const held = signal({
      bank: 'A',
      identity: 'BREAKOUT-XYZ',
      kind: 'BREAKOUT_UP',
      status: 'CONFIRMED',
    });

    expect((await n.notifyMarketSignals([held], T0))[0].outcome).toBe('SENT');

    const outcomes: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const at = T0 + i * 20 * 60_000; // 20 minutes apart, four hours in total
      const noise = signal({
        bank: 'Z',
        amountKey: `${i}K`,
        identity: `noise-${i}`,
        kind: 'BREAKOUT_UP',
        status: 'CONFIRMED',
      });
      const results = await n.notifyMarketSignals([held, noise], at);
      outcomes.push(String(results[0].outcome));
    }

    // Four hours, twelve pruning opportunities, and A never speaks twice.
    expect(new Set(outcomes)).toEqual(new Set(['UNCHANGED']));

    vi.unstubAllGlobals();
  });

  it('announces a genuine recurrence once the condition has gone away', async () => {
    /*
     * The other half: freshness is granted only while the signal is still
     * being derived. Once it stops appearing, its key ages out normally and a
     * later recurrence is news again - otherwise the fix would have turned one
     * announcement into permanent silence.
     */
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const n = notifier();

    const condition = signal({
      bank: 'A',
      identity: 'BREAKOUT-XYZ',
      kind: 'BREAKOUT_UP',
      status: 'CONFIRMED',
    });
    expect((await n.notifyMarketSignals([condition], T0))[0].outcome).toBe('SENT');

    // Two hours in which A is NOT derived; other cells keep the notifier busy.
    for (let i = 1; i <= 6; i++) {
      await n.notifyMarketSignals(
        [
          signal({
            bank: 'Z',
            amountKey: `${i}K`,
            identity: `noise-${i}`,
            kind: 'BREAKOUT_UP',
            status: 'CONFIRMED',
          }),
        ],
        T0 + i * 20 * 60_000
      );
    }

    const again = await n.notifyMarketSignals([condition], T0 + 3 * 3_600_000);
    expect(again[0].outcome).toBe('SENT');

    vi.unstubAllGlobals();
  });

  it('CRITICAL gets fifteen minutes, ordinary signals thirty', async () => {
    /*
     * THE TWO FLOORS, STATED AS NUMBERS.
     *
     * A confirmed break is worth interrupting for, so it waits half as long as
     * anything else - but it is NOT exempt. Without a floor at all, a
     * market-wide move breaking a level in twelve cells arrived as twelve
     * notifications about one event, which is measured in the comment on
     * notifyMarketSignals.
     */
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const n = notifier();
    const HALF = DEFAULT_SIGNAL_INTERVAL_MS / 2;

    const critical = (i: number) =>
      signal({
        bank: `C${i}`,
        identity: `crit-${i}`,
        kind: 'BREAKOUT_UP',
        status: 'CONFIRMED',
      });

    expect((await n.notifyMarketSignals([critical(1)], T0))[0].outcome).toBe('SENT');
    // One second short of the half-hour floor: still shut.
    expect((await n.notifyMarketSignals([critical(2)], T0 + HALF - 1))[0].outcome).toBe(
      'COOLDOWN'
    );
    // Exactly at it: open.
    expect((await n.notifyMarketSignals([critical(3)], T0 + HALF))[0].outcome).toBe('SENT');

    vi.unstubAllGlobals();
  });

  it('an ordinary signal waits the full interval, not the critical half', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const n = notifier();
    const FULL = DEFAULT_SIGNAL_INTERVAL_MS;

    const ordinary = (i: number) =>
      signal({ bank: `O${i}`, identity: `warn-${i}`, kind: 'EXHAUSTION' });

    expect((await n.notifyMarketSignals([ordinary(1)], T0))[0].outcome).toBe('SENT');
    // At the CRITICAL floor an ordinary signal is still waiting.
    expect((await n.notifyMarketSignals([ordinary(2)], T0 + FULL / 2))[0].outcome).toBe(
      'COOLDOWN'
    );
    expect((await n.notifyMarketSignals([ordinary(3)], T0 + FULL))[0].outcome).toBe('SENT');

    vi.unstubAllGlobals();
  });

  it('a CRITICAL is never silenced by an ordinary signal that just went out', async () => {
    /*
     * The two floors are separate keys on purpose. If they shared one, an
     * exhaustion note would mute a confirmed break for half an hour.
     */
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const n = notifier();

    await n.notifyMarketSignals([signal({ bank: 'O', identity: 'warn' })], T0);
    const critical = await n.notifyMarketSignals(
      [signal({ bank: 'C', identity: 'crit', kind: 'BREAKOUT_UP', status: 'CONFIRMED' })],
      T0 + 60_000
    );

    expect(critical[0].outcome).toBe('SENT');
    vi.unstubAllGlobals();
  });

  it('says nothing at all when the signal has no live price', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    // Guarded upstream in signalEngine; asserted there too. Here the notifier
    // simply must not invent one.
    await notifier().notifyMarketSignals([signal({ currentPrice: null })], T0);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    const body = call === undefined ? '' : (JSON.parse(String(call[1].body)).text as string);
    expect(body).toContain('no verificable');
    vi.unstubAllGlobals();
  });
});

describe('el intervalo de señales es propio, no el cooldown genérico', () => {
  it('defaults to 30 minutes and floors at 15', () => {
    expect(DEFAULT_SIGNAL_INTERVAL_MS).toBe(1_800_000);
    expect(MIN_SIGNAL_INTERVAL_MS).toBe(900_000);
    expect(readSignalInterval({}).intervalMs).toBe(DEFAULT_SIGNAL_INTERVAL_MS);
    expect(readSignalInterval({ MAKER_SIGNAL_ALERT_INTERVAL_MS: '900000' }).intervalMs).toBe(
      MIN_SIGNAL_INTERVAL_MS
    );
  });

  it('clamps a shorter value and says that it clamped', () => {
    const read = readSignalInterval({ MAKER_SIGNAL_ALERT_INTERVAL_MS: '1000' });
    expect(read.intervalMs).toBe(MIN_SIGNAL_INTERVAL_MS);
    expect(read.clamped).toBe(true);
  });

  it('falls back to the default for nonsense', () => {
    expect(readSignalInterval({ MAKER_SIGNAL_ALERT_INTERVAL_MS: 'luego' }).intervalMs).toBe(
      DEFAULT_SIGNAL_INTERVAL_MS
    );
  });
});

describe('INFO nunca llega a Telegram', () => {
  it('drops an INFO signal without sending it', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new TelegramNotifier({
      botToken: '1234567890:TEST-TOKEN-NOT-REAL',
      chatId: '-1000000000000',
      cooldownMs: 300_000,
      timeoutMs: 1000,
    });

    const results = await notifier.notifyMarketSignals(
      [
        {
          kind: 'ACCUMULATION',
          status: 'EARLY_WARNING',
          bank: 'BANESCO',
          bankDisplayName: 'Banesco',
          amountKey: '10K',
          amountVes: 10_000,
          side: 'BUY',
          sideLabel: 'MI COMPRA DE USDT',
          headline: 'lateral sobre un piso',
          evidence: ['x'],
          confidence: 'MEDIUM',
          sampleSize: 30,
          currentPrice: 940,
          projectedLow: 939,
          projectedHigh: 941,
          watchStartHour: null,
          watchEndHour: null,
          identity: 'ACCUMULATION:BANESCO:10K:BUY:zona',
        },
      ],
      T0
    );

    // Computed, returned by the API, rendered on screen - and silent.
    expect(priorityOf({ kind: 'ACCUMULATION', status: 'EARLY_WARNING' })).toBe('INFO');
    expect(results[0].outcome).toBe('UNCHANGED');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
