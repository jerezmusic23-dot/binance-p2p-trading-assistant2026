import { describe, expect, it, vi, afterEach } from 'vitest';
import { DEFAULT_PRICE_CHANGE_INTERVAL_MS, DEFAULT_SIGNAL_INTERVAL_MS, MIN_SIGNAL_INTERVAL_MS, priorityOf, readSignalInterval, startDigestState, accumulatePriceChange, releasePriceChangeDigest, EMPTY_DIGEST_STATE } from '../server/alertScheduler.js';
import { TelegramNotifier } from '../server/telegramNotifier.js';
import type { MarketSignal } from '../server/signalEngine.js';

const T0 = Date.UTC(2026, 7, 1, 18, 0, 0);
const config = { botToken: '1234567890:TEST-TOKEN-NOT-REAL', chatId: '-1000000000000', cooldownMs: 0, timeoutMs: 1000 };

function signal(overrides: Partial<MarketSignal> = {}): MarketSignal {
  return {
    kind: 'TREND_CHANGE', status: 'CONFIRMED', bank: 'MERCANTIL', bankDisplayName: 'Mercantil', amountKey: '10K', amountVes: 10_000,
    side: 'BUY', sideLabel: 'MI COMPRA DE USDT', headline: 'cambio de tendencia', evidence: ['x'], confidence: 'MEDIUM', sampleSize: 30,
    currentPrice: 940, projectedLow: 939, projectedHigh: 941, watchStartHour: null, watchEndHour: null, identity: 'TREND_CHANGE:MERCANTIL:10K:BUY:1', ...overrides,
  } as MarketSignal;
}

afterEach(() => vi.unstubAllGlobals());

describe('signal timing and bank allowlist', () => {
  it('uses a five-minute default and minimum for market-analysis Telegram alerts', () => {
    expect(DEFAULT_SIGNAL_INTERVAL_MS).toBe(300_000);
    expect(MIN_SIGNAL_INTERVAL_MS).toBe(300_000);
    expect(readSignalInterval({}).intervalMs).toBe(300_000);
    expect(readSignalInterval({ MAKER_SIGNAL_ALERT_INTERVAL_MS: '1000' })).toEqual({ intervalMs: 300_000, clamped: true });
  });

  it('sends target-bank signals and blocks other banks', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const notifier = new TelegramNotifier(config);
    expect((await notifier.notifyMarketSignals([signal()], T0))[0].outcome).toBe('SENT');
    expect((await notifier.notifyMarketSignals([signal({ bank: 'BANCAMIGA', bankDisplayName: 'Bancamiga', identity: 'x2' })], T0 + 300_001))[0].outcome).toBe('SENT');
    expect((await notifier.notifyMarketSignals([signal({ bank: 'BANESCO', bankDisplayName: 'Banesco', identity: 'x3' })], T0 + 600_002))[0].outcome).toBe('UNCHANGED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps stable identity deduplication', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const notifier = new TelegramNotifier(config);
    expect((await notifier.notifyMarketSignals([signal()], T0))[0].outcome).toBe('SENT');
    expect((await notifier.notifyMarketSignals([signal()], T0 + 301_000))[0].outcome).toBe('UNCHANGED');
  });

  it('keeps CRITICAL for confirmed breakouts', () => {
    expect(priorityOf({ kind: 'BREAKOUT_UP', status: 'CONFIRMED' })).toBe('CRITICAL');
    expect(priorityOf({ kind: 'BREAKOUT_DOWN', status: 'CONFIRMED' })).toBe('CRITICAL');
    expect(priorityOf({ kind: 'TREND_CHANGE', status: 'EARLY_WARNING' })).toBe('WARNING');
    expect(priorityOf({ kind: 'ACCUMULATION', status: 'EARLY_WARNING' })).toBe('INFO');
  });
});

describe('price-change digest remains 30 minutes', () => {
  it('anchors the digest clock at startup', () => expect(startDigestState(T0)).toEqual({ pending: {}, lastReleasedAt: T0 }));
  it('does not change the maker digest cadence', () => expect(DEFAULT_PRICE_CHANGE_INTERVAL_MS).toBe(1_800_000));
  it('groups and releases a changed cell after the interval', () => {
    const cell = { bank: 'MERCANTIL', bankDisplayName: 'Mercantil', amountKey: '10K', amountVes: 10_000 } as any;
    const pairing = { buy: { price: 940 }, sell: { price: 945 } } as any;
    let state = accumulatePriceChange(EMPTY_DIGEST_STATE, { cell, pairing, previous: { buyPrice: 939, sellPrice: 945 } }, T0 + 1_000);
    expect(releasePriceChangeDigest(state, T0 + 1_000, DEFAULT_PRICE_CHANGE_INTERVAL_MS).digest).toBeNull();
    const released = releasePriceChangeDigest(state, T0 + DEFAULT_PRICE_CHANGE_INTERVAL_MS, DEFAULT_PRICE_CHANGE_INTERVAL_MS);
    expect(released.digest?.changes).toHaveLength(1);
    expect(released.state.pending).toEqual({});
  });
});
