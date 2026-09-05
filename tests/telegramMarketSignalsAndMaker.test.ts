import { describe, expect, it, vi, afterEach } from 'vitest';
import { TelegramNotifier, type TelegramConfig } from '../server/telegramNotifier.js';
import type { MarketSignal } from '../server/signalEngine.js';

const config: TelegramConfig = { botToken: 'test-token', chatId: 'test-chat', cooldownMs: 0, timeoutMs: 20 };
const signal = {
  kind: 'BREAKOUT_UP', status: 'CONFIRMED', identity: 'mercantil:10K:BUY:100', bank: 'MERCANTIL', bankDisplayName: 'Mercantil', amountKey: '10K', side: 'BUY', sideLabel: 'MI COMPRA', headline: 'Ruptura', confidence: 'HIGH', sampleSize: 20, currentPrice: 100, projectedLow: 101, projectedHigh: 102, watchStartHour: null, watchEndHour: null, evidence: ['test'],
} as unknown as MarketSignal;

afterEach(() => vi.unstubAllGlobals());

describe('Telegram carries market signals for target banks only', () => {
  it('sends a confirmed breakout from Mercantil to Telegram', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const notifier = new TelegramNotifier(config);
    const result = await notifier.notifyMarketSignals([signal], Date.now());
    expect(result[0]?.outcome).toBe('SENT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not send a market signal from a non-target bank', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const notifier = new TelegramNotifier(config);
    const result = await notifier.notifyMarketSignals([{ ...signal, bank: 'BANESCO', bankDisplayName: 'Banesco' } as MarketSignal], Date.now());
    expect(result[0]?.outcome).toBe('UNCHANGED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an INFO-priority signal (ACCUMULATION/DISTRIBUTION) still never reaches Telegram', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const notifier = new TelegramNotifier(config);
    const result = await notifier.notifyMarketSignals([{ ...signal, kind: 'ACCUMULATION', status: 'EARLY_WARNING' } as MarketSignal], Date.now());
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
