/**
 * Telegram: system alerts and the opportunity lifecycle.
 *
 * NOTHING here talks to Telegram or to Binance. fetch is stubbed in every
 * test. These assertions are about the notifier's discipline - that it stays
 * silent without credentials, that it never repeats an unchanged condition,
 * and that it never dresses a strategic median up as an executable operation.
 *
 * No test in this file is evidence that the bot is correctly configured in
 * production. That can only be established against the live deployment.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TelegramNotifier,
  readTelegramConfig,
  opportunityIdentity,
  formatOpportunityLifecycleMessage,
  formatSystemAlertMessage,
  DEFAULT_ALERT_COOLDOWN_MS,
  DEFAULT_SYSTEM_ALERT_COOLDOWN_MS,
} from '../server/telegramNotifier.js';
import type { Opportunity, TelegramSystemAlert } from '../server/types.js';

const TOKEN = '1234567890:TEST-TOKEN-NOT-REAL';
const CHAT = '-1001234567890';
const T0 = Date.UTC(2026, 0, 6, 12, 0, 0);

function configured() {
  return new TelegramNotifier({
    botToken: TOKEN,
    chatId: CHAT,
    cooldownMs: DEFAULT_ALERT_COOLDOWN_MS,
    timeoutMs: 1_000,
  });
}

function makeOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  const buyPrice = 944;
  const sellPrice = 955;
  return {
    bank: 'Banco de Venezuela',
    amountVes: 50_000,
    buyPrice,
    sellPrice,
    // Same values under the unambiguous names.
    arbitrageBuyPrice: buyPrice,
    arbitrageSellPrice: sellPrice,
    buyAdvNo: 'BUY-1',
    sellAdvNo: 'SELL-1',
    spreadAbsolute: sellPrice - buyPrice,
    spreadPct: Number((((sellPrice - buyPrice) / buyPrice) * 100).toFixed(4)),
    marginAbsolute: sellPrice - buyPrice,
    marginPct: Number((((sellPrice - buyPrice) / buyPrice) * 100).toFixed(4)),
    buyAvailableUsdt: 500,
    sellAvailableUsdt: 400,
    availableUsdt: 400,
    verification: 'VERIFIED',
    provenance: 'EXECUTABLE',
    reason: null,
    ...overrides,
  };
}

function makeSystemAlert(overrides: Partial<TelegramSystemAlert> = {}): TelegramSystemAlert {
  return {
    kind: 'BINANCE_OFFLINE',
    timestamp: T0,
    state: 'OFFLINE:connection refused',
    detail: 'Binance P2P no responde: connection refused',
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  TelegramNotifier.resetInstance();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  TelegramNotifier.resetInstance();
});

/** Every message body the notifier tried to send. */
function sentBodies(): string[] {
  return fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string).text);
}

describe('Telegram without a token', () => {
  it('reads no config when the token is absent', () => {
    expect(readTelegramConfig({ TELEGRAM_CHAT_ID: CHAT } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('reads no config when the chat id is absent', () => {
    expect(readTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('treats whitespace-only credentials as absent rather than valid', () => {
    expect(
      readTelegramConfig({
        TELEGRAM_BOT_TOKEN: '   ',
        TELEGRAM_CHAT_ID: '  ',
      } as NodeJS.ProcessEnv)
    ).toBeNull();
  });

  it('reports DISABLED and sends nothing for a system alert', async () => {
    const notifier = new TelegramNotifier(null);
    const result = await notifier.notifySystemAlert(makeSystemAlert());

    expect(result.outcome).toBe('DISABLED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports DISABLED and sends nothing for an opportunity', async () => {
    const notifier = new TelegramNotifier(null);
    const result = await notifier.notifyOpportunityLifecycle(makeOpportunity(), T0);

    expect(result.outcome).toBe('DISABLED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Telegram with a token', () => {
  it('reads both credentials and the optional cooldown from the environment', () => {
    const config = readTelegramConfig({
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_CHAT_ID: CHAT,
      TELEGRAM_ALERT_COOLDOWN_MS: '60000',
    } as NodeJS.ProcessEnv);

    expect(config).not.toBeNull();
    expect(config?.cooldownMs).toBe(60_000);
  });

  it('falls back to the default cooldown when the override is not a number', () => {
    const config = readTelegramConfig({
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_CHAT_ID: CHAT,
      TELEGRAM_ALERT_COOLDOWN_MS: 'soon',
    } as NodeJS.ProcessEnv);

    expect(config?.cooldownMs).toBe(DEFAULT_ALERT_COOLDOWN_MS);
  });

  it('actually posts a system alert', async () => {
    const result = await configured().notifySystemAlert(makeSystemAlert());

    expect(result.outcome).toBe('SENT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never puts the token or the chat id in the message body', async () => {
    await configured().notifySystemAlert(makeSystemAlert());
    const [url, init] = fetchMock.mock.calls[0];
    const body = (init as RequestInit).body as string;

    // The token belongs in the URL and nowhere else.
    expect(String(url)).toContain(TOKEN);
    expect(JSON.parse(body).text).not.toContain(TOKEN);
  });
});

describe('Telegram anti-spam: system alerts', () => {
  it('sends an unchanged condition exactly once, however often it is reported', async () => {
    const notifier = configured();
    const outcomes: string[] = [];

    // A six-second poll during a ten-minute outage: 100 reports.
    for (let i = 0; i < 100; i++) {
      const result = await notifier.notifySystemAlert(makeSystemAlert({ timestamp: T0 + i * 6_000 }));
      outcomes.push(result.outcome);
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcomes[0]).toBe('SENT');
    expect(outcomes.slice(1).every((o) => o === 'UNCHANGED')).toBe(true);
  });

  it('applies a cooldown floor when the condition flaps', async () => {
    const notifier = configured();

    await notifier.notifySystemAlert(makeSystemAlert({ state: 'OFFLINE:a', timestamp: T0 }));
    const flap = await notifier.notifySystemAlert(
      makeSystemAlert({ state: 'OFFLINE:b', timestamp: T0 + 30_000 })
    );

    expect(flap.outcome).toBe('COOLDOWN');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not lose a transition that the cooldown suppressed', async () => {
    const notifier = configured();

    await notifier.notifySystemAlert(makeSystemAlert({ state: 'OFFLINE:a', timestamp: T0 }));
    await notifier.notifySystemAlert(makeSystemAlert({ state: 'OFFLINE:b', timestamp: T0 + 30_000 }));

    // Once the window passes, the still-current state is announced.
    const later = await notifier.notifySystemAlert(
      makeSystemAlert({
        state: 'OFFLINE:b',
        timestamp: T0 + DEFAULT_SYSTEM_ALERT_COOLDOWN_MS + 1_000,
      })
    );

    expect(later.outcome).toBe('SENT');
  });

  it('keeps each condition on its own cooldown', async () => {
    const notifier = configured();

    await notifier.notifySystemAlert(makeSystemAlert({ kind: 'BINANCE_OFFLINE' }));
    const storage = await notifier.notifySystemAlert(
      makeSystemAlert({ kind: 'STORAGE_ERROR', state: 'STORAGE_ERROR:EACCES' })
    );

    expect(storage.outcome).toBe('SENT');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('Telegram: Binance offline and stale data', () => {
  it('says the prices are not the current market when capture is down', async () => {
    await configured().notifySystemAlert(makeSystemAlert({ kind: 'BINANCE_OFFLINE' }));
    const body = sentBodies()[0];

    expect(body).toContain('BINANCE NO DISPONIBLE');
    expect(body).toContain('no el mercado actual');
    expect(body).toContain('SYSTEM');
  });

  it('warns against operating on stale prices', async () => {
    await configured().notifySystemAlert(
      makeSystemAlert({ kind: 'DATA_STALE', state: 'STALE:timeout' })
    );
    const body = sentBodies()[0];

    expect(body).toContain('DATOS DESACTUALIZADOS');
    expect(body).toContain('No operar');
  });

  it('announces recovery as its own event rather than by going quiet', async () => {
    await configured().notifySystemAlert(
      makeSystemAlert({ kind: 'BINANCE_RECOVERED', state: 'LIVE', detail: 'Captura restablecida.' })
    );

    expect(sentBodies()[0]).toContain('CAPTURA RESTABLECIDA');
  });

  it('never presents a system alert as a market signal', () => {
    const body = formatSystemAlertMessage(makeSystemAlert());
    expect(body).toContain('no es una señal de mercado');
    expect(body).not.toContain('OPORTUNIDAD');
  });
});

describe('Telegram: storage error', () => {
  it('states that the history has stopped growing', async () => {
    await configured().notifySystemAlert(
      makeSystemAlert({
        kind: 'STORAGE_ERROR',
        state: 'STORAGE_ERROR:EROFS',
        detail: 'No se ha podido escribir el historico: EROFS',
      })
    );
    const body = sentBodies()[0];

    expect(body).toContain('CRITICAL STORAGE ERROR');
    expect(body).toContain('NO se esta acumulando historico');
  });

  it('does not claim the live data is wrong, only that it is not being kept', async () => {
    await configured().notifySystemAlert(
      makeSystemAlert({ kind: 'STORAGE_ERROR', state: 'STORAGE_ERROR:EROFS' })
    );
    expect(sentBodies()[0]).toContain('datos en vivo');
  });
});

describe('Telegram: opportunity deduplication', () => {
  it('identifies a position by bank and amount, not by its current prices', () => {
    const a = makeOpportunity({ buyPrice: 944, sellPrice: 955 });
    const b = makeOpportunity({ buyPrice: 943.5, sellPrice: 956.2 });

    expect(opportunityIdentity(a)).toBe(opportunityIdentity(b));
  });

  it('distinguishes two different positions at the same bank', () => {
    const small = makeOpportunity({ amountVes: 10_000 });
    const large = makeOpportunity({ amountVes: 100_000 });

    expect(opportunityIdentity(small)).not.toBe(opportunityIdentity(large));
  });

  it('announces DETECTED once and then stays quiet at the poll rate', async () => {
    const notifier = configured();
    const outcomes: string[] = [];

    // 6-second polling for two minutes on the same live position.
    for (let i = 0; i < 20; i++) {
      const result = await notifier.notifyOpportunityLifecycle(
        makeOpportunity({ buyPrice: 944 + i * 0.1 }),
        T0 + i * 6_000
      );
      outcomes.push(result.outcome);
    }

    expect(outcomes[0]).toBe('SENT');
    expect(outcomes.slice(1).every((o) => o === 'COOLDOWN')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBodies()[0]).toContain('OPORTUNIDAD DE ARBITRAJE');
  });

  it('sends UPDATED, not a second DETECTED, once the cooldown elapses', async () => {
    const notifier = configured();

    await notifier.notifyOpportunityLifecycle(makeOpportunity(), T0);
    await notifier.notifyOpportunityLifecycle(
      makeOpportunity({ buyPrice: 940 }),
      T0 + DEFAULT_ALERT_COOLDOWN_MS + 1_000
    );

    const bodies = sentBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('OPORTUNIDAD DE ARBITRAJE');
    expect(bodies[1]).toContain('OPORTUNIDAD ACTUALIZADA');
  });

  it('closes a position when it leaves the book', async () => {
    const notifier = configured();

    await notifier.notifyOpportunityLifecycle(makeOpportunity(), T0);
    const closed = await notifier.notifyOpportunityLifecycle(null, T0 + 30_000);

    expect(closed.outcome).toBe('SENT');
    expect(sentBodies()[1]).toContain('OPORTUNIDAD CERRADA');
    expect(notifier.openOpportunityKeys()).toEqual([]);
  });

  it('does not send CLOSED for a position that was never announced', async () => {
    const notifier = configured();
    const result = await notifier.notifyOpportunityLifecycle(null, T0);

    expect(result.outcome).toBe('UNCHANGED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('closes the previous position when a different one takes over', async () => {
    const notifier = configured();

    await notifier.notifyOpportunityLifecycle(makeOpportunity({ amountVes: 10_000 }), T0);
    await notifier.notifyOpportunityLifecycle(
      makeOpportunity({ amountVes: 100_000 }),
      T0 + 30_000
    );

    const bodies = sentBodies();
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toContain('OPORTUNIDAD DE ARBITRAJE');
    expect(bodies[1]).toContain('OPORTUNIDAD CERRADA');
    expect(bodies[2]).toContain('OPORTUNIDAD DE ARBITRAJE');
    expect(notifier.openOpportunityKeys()).toHaveLength(1);
  });

  it('CLOSED is never suppressed by a cooldown', async () => {
    const notifier = configured();

    await notifier.notifyOpportunityLifecycle(makeOpportunity(), T0);
    // One second later - far inside the cooldown window.
    const closed = await notifier.notifyOpportunityLifecycle(null, T0 + 1_000);

    expect(closed.outcome).toBe('SENT');
  });
});

describe('Telegram: EXECUTABLE is never confused with STRATEGIC', () => {
  it('ignores an opportunity that is not VERIFIED', async () => {
    const notifier = configured();
    const result = await notifier.notifyOpportunityLifecycle(
      makeOpportunity({
        verification: 'NOT_VERIFIABLE',
        availableUsdt: null,
        reason: 'Un lado no publicó volumen.',
      }),
      T0
    );

    expect(result.outcome).toBe('UNCHANGED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('labels the message EXECUTABLE and names the bank and amount', () => {
    const body = formatOpportunityLifecycleMessage('DETECTED', makeOpportunity(), T0, T0 - 20_000);

    expect(body).toContain('EXECUTABLE');
    expect(body).toContain('Banco de Venezuela');
    /*
     * The economics lead, the Binance side follows, the API parameter last.
     * A reader must never have to infer which side of the book a leg came
     * from, nor what it does to their money.
     */
    expect(body).toContain('COMPRA USDT');
    expect(body).toContain('Fuente: Binance ASK');
    expect(body).toContain('VENTA USDT');
    expect(body).toContain('Fuente: Binance BID');
    expect(body).not.toContain('STRATEGIC');
    expect(body).not.toContain('mediana');
  });

  it('calls the result MARGEN BRUTO and never net profit', () => {
    const body = formatOpportunityLifecycleMessage('DETECTED', makeOpportunity(), T0);

    expect(body).toContain('MARGEN BRUTO');
    expect(body).toContain('NO es beneficio neto');
    expect(body).not.toMatch(/beneficio neto:/i);
    expect(body).not.toMatch(/ganancia/i);
    expect(body).not.toMatch(/profit/i);
  });

  it('never issues an instruction to trade', () => {
    const body = formatOpportunityLifecycleMessage('DETECTED', makeOpportunity(), T0);

    expect(body).not.toMatch(/COMPRA AHORA/i);
    expect(body).not.toMatch(/VENTA AHORA/i);
    expect(body).not.toMatch(/GARANTIZAD/i);
  });

  it('prints absent liquidity as not verifiable rather than as zero', () => {
    const body = formatOpportunityLifecycleMessage(
      'DETECTED',
      /*
       * The buy leg published nothing. Reported per leg now, so an unknown on
       * one side cannot be masked by a known figure on the other - which is
       * what a single combined "Liquidez" line used to allow.
       */
      makeOpportunity({ buyAvailableUsdt: null, availableUsdt: null }),
      T0
    );

    expect(body).toContain('Liquidez compra: no verificable');
    expect(body).not.toContain('Liquidez compra: <b>0.00 USDT</b>');
    // The side that DID publish is still reported as the number it is.
    expect(body).toContain('Liquidez venta: <b>400.00 USDT</b>');
  });

  it('prints an unknown capture age as not verifiable rather than as 0s', () => {
    const body = formatOpportunityLifecycleMessage('DETECTED', makeOpportunity(), T0, null);
    expect(body).toContain('Antiguedad del dato: no verificable');
  });
});

describe('Telegram: failures never escape the notifier', () => {
  it('returns a result instead of throwing when the network fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const result = await configured().notifySystemAlert(makeSystemAlert());

    expect(result.outcome).toBe('NETWORK_ERROR');
  });

  it('returns a result instead of throwing when Telegram rejects the message', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 429 }));
    const result = await configured().notifyOpportunityLifecycle(makeOpportunity(), T0);

    expect(result.outcome).toBe('HTTP_ERROR');
    expect(result.detail).toContain('429');
  });

  it('does not retry a failed message on the next poll', async () => {
    const notifier = configured();
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    await notifier.notifySystemAlert(makeSystemAlert({ timestamp: T0 }));
    const second = await notifier.notifySystemAlert(makeSystemAlert({ timestamp: T0 + 6_000 }));

    expect(second.outcome).toBe('UNCHANGED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
