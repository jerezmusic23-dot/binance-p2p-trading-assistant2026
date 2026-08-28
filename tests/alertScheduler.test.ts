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
