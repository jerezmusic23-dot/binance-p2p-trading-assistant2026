import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramNotifier } from '../server/telegramNotifier.js';
import type { MarketSignal } from '../server/signalEngine.js';

const config = {
  botToken: 'test-token',
  chatId: 'test-chat',
  cooldownMs: 300_000,
  timeoutMs: 100,
};

const signal: MarketSignal = {
  kind: 'PROJECTION',
  identity: 'retry-cell',
  status: 'CONFIRMED',
  bank: 'VENEZUELA',
  bankDisplayName: 'Banco de Venezuela',
  amountKey: '10K',
  side: 'BUY',
  sideLabel: 'MI VENTA',
  headline: 'Prueba de entrega',
  confidence: 'MEDIA',
  sampleSize: 10,
  currentPrice: 950,
  projectedLow: 949,
  projectedHigh: 952,
  watchStartHour: null,
  watchEndHour: null,
  evidence: ['prueba'],
};

afterEach(() => {
  vi.unstubAllGlobals();
  TelegramNotifier.resetInstance();
});

describe('Telegram delivery retry', () => {
  it('does not consume the dedup/cooldown window when the first delivery fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new TelegramNotifier(config);
    const first = await notifier.notifyMarketSignals([signal], 1_000);
    const second = await notifier.notifyMarketSignals([signal], 2_000);

    expect(first[0].outcome).toBe('HTTP_ERROR');
    expect(second[0].outcome).toBe('SENT');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
