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

describe('Telegram maker-only boundary', () => {
  it('never sends projection/trend market signals to Telegram', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new TelegramNotifier(config);
    const result = await notifier.notifyMarketSignals([signal], Date.now());

    expect(result).toHaveLength(1);
    expect(result[0]?.outcome).toBe('UNCHANGED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
