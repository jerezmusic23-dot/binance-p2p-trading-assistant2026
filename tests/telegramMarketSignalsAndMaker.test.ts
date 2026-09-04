/**
 * TELEGRAM CARRIES TWO VOICES: MARKET SIGNALS AND MAKER ALERTS.
 *
 * This file used to pin the opposite contract - that notifyMarketSignals was
 * a permanent no-op and Telegram was maker-only (server/telegramNotifier.ts,
 * commit d78c74c, "fix: keep Telegram strictly maker-facing"). The operator's
 * explicit later instruction reversed that decision: "No elimines las
 * señales de mercado. Las señales de mercado y las alertas maker son
 * categorías diferentes y ambas deben funcionar." So this file now pins the
 * restored contract instead of the one it used to guard - a real signal DOES
 * reach Telegram, subject only to the priority/dedup/cooldown rules in
 * notifyMarketSignals (see tests/alertScheduler.test.ts, "signal throttling,
 * as measured", for the throttle mechanics themselves).
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { TelegramNotifier, type TelegramConfig } from '../server/telegramNotifier.js';
import type { MarketSignal } from '../server/signalEngine.js';

const config: TelegramConfig = {
  botToken: 'test-token',
  chatId: 'test-chat',
  cooldownMs: 0,
  timeoutMs: 20,
};

const signal = {
  kind: 'BREAKOUT_UP',
  status: 'CONFIRMED',
  identity: 'banesco:10K:BUY:100',
  bank: 'banesco',
  bankDisplayName: 'Banesco',
  amountKey: '10K',
  side: 'BUY',
  sideLabel: 'MI COMPRA',
  headline: 'Ruptura',
  confidence: 'HIGH',
  sampleSize: 20,
  currentPrice: 100,
  projectedLow: 101,
  projectedHigh: 102,
  watchStartHour: null,
  watchEndHour: null,
  evidence: ['test'],
} as unknown as MarketSignal;

afterEach(() => vi.unstubAllGlobals());

describe('Telegram carries market signals again', () => {
  it('sends a confirmed breakout to Telegram, not just to the API/UI', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new TelegramNotifier(config);
    const result = await notifier.notifyMarketSignals([signal], Date.now());

    expect(result).toHaveLength(1);
    expect(result[0]?.outcome).toBe('SENT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body.text).toMatch(/RUPTURA/);
  });

  it('an INFO-priority signal (ACCUMULATION/DISTRIBUTION) still never reaches Telegram', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new TelegramNotifier(config);
    const result = await notifier.notifyMarketSignals(
      [{ ...signal, kind: 'ACCUMULATION', status: 'EARLY_WARNING' } as MarketSignal],
      Date.now()
    );

    expect(result[0]?.outcome).toBe('UNCHANGED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with Telegram disabled (no config), every signal reports DISABLED and nothing is sent', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new TelegramNotifier(null);
    const result = await notifier.notifyMarketSignals([signal], Date.now());

    expect(result[0]?.outcome).toBe('DISABLED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
