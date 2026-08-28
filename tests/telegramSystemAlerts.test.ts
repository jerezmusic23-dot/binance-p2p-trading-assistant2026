/**
 * Telegram: system alerts, and the maker emitter's anti-spam discipline.
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
  formatSystemAlertMessage,
  DEFAULT_ALERT_COOLDOWN_MS,
  DEFAULT_SYSTEM_ALERT_COOLDOWN_MS,
} from '../server/telegramNotifier.js';
import { buildMakerMatrix } from '../server/makerMatrix.js';
import { DEFAULT_MAKER_CONFIG } from '../server/makerStrategy.js';
import { makeNormalizedAd } from './helpers/fixtures.js';
import type { MakerAlert } from '../server/makerAlerts.js';
import type { NormalizedAd, TelegramSystemAlert } from '../server/types.js';

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

/** A cell whose recommended prices are exactly the two given. */
function makeCell(myBuyLeader: number, mySellLeader: number) {
  const ad = (price: number, payType = 'Banesco'): NormalizedAd => ({
    ...makeNormalizedAd(price),
    advNo: `adv-${price}`,
    paymentOptions: [{ payType, tradeMethodName: payType }],
  });
  // Establishes the 0.01 step by observation, without competing for Banesco.
  const witness = ad(900.25, 'Provincial');

  return buildMakerMatrix({
    bankOrder: ['banesco'],
    bankDisplayNames: { banesco: 'Banesco' },
    bankAllowedCodes: { banesco: ['Banesco'] },
    amounts: [{ key: '10K', val: 10_000 }],
    listingsByTier: {
      '10K': {
        banesco: { SELL: [ad(myBuyLeader), witness], BUY: [ad(mySellLeader), witness] },
      },
    },
    failedBanksByTier: {},
    capturedAtByTier: { '10K': T0 },
    capturedAt: T0,
    config: DEFAULT_MAKER_CONFIG,
    nowMs: T0,
  }).cells.banesco['10K'];
}

function priceChange(myBuyLeader: number, mySellLeader: number): MakerAlert {
  const cell = makeCell(myBuyLeader, mySellLeader);
  return {
    kind: 'PRICE_CHANGE',
    cell,
    pairing: cell.recommendation!.recommended!,
    previous: { buyPrice: 1, sellPrice: 2 },
    current: {
      buyPrice: cell.recommendation!.recommended!.buy.price,
      sellPrice: cell.recommendation!.recommended!.sell.price,
    },
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

  it('reports DISABLED and sends nothing for a maker alert', async () => {
    const notifier = new TelegramNotifier(null);
    const results = await notifier.notifyMakerAlerts([priceChange(940, 945)], T0);

    expect(results.map((r) => r.outcome)).toEqual(['DISABLED']);
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

/*
 * THESE TWO BLOCKS USED TO COVER THE ARBITRAGE LIFECYCLE - DETECTED, UPDATED,
 * CLOSED, dedup by bank+amount, and "EXECUTABLE is never confused with
 * STRATEGIC".
 *
 * That emitter is gone. The GUARANTEES it was protecting are not: an emitter
 * driven by a fast loop must not repeat itself, must not let one noisy cell
 * drown the rest, and must never publish a number nobody observed. They are
 * re-pinned here against the maker emitter, which is the only market emitter
 * left.
 */
describe('Telegram: the maker emitter does not repeat itself', () => {
  it('sends a price change once and stays quiet at the sweep rate', async () => {
    const notifier = configured();
    const alert = priceChange(940, 945);

    for (let i = 0; i < 5; i += 1) {
      await notifier.notifyMakerAlerts([alert], T0 + i * 45_000);
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deduplicates by the prices announced, not by the moment', async () => {
    const notifier = configured();
    const alert = priceChange(940, 945);

    const first = await notifier.notifyMakerAlerts([alert], T0);
    // Far beyond any cooldown: the same two prices are still not news.
    const later = await notifier.notifyMakerAlerts([alert], T0 + 86_400_000);

    expect(first[0].outcome).toBe('SENT');
    expect(later[0].outcome).toBe('UNCHANGED');
  });

  it('throttles a cell that keeps moving, rather than repeating it', async () => {
    const notifier = configured();

    const first = await notifier.notifyMakerAlerts([priceChange(940, 945)], T0);
    const second = await notifier.notifyMakerAlerts([priceChange(941, 946)], T0 + 45_000);

    expect(first[0].outcome).toBe('SENT');
    expect(second[0].outcome).toBe('COOLDOWN');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lets the same cell speak again once the cooldown has passed', async () => {
    const notifier = configured();

    await notifier.notifyMakerAlerts([priceChange(940, 945)], T0);
    const later = await notifier.notifyMakerAlerts(
      [priceChange(941, 946)],
      T0 + DEFAULT_ALERT_COOLDOWN_MS + 1
    );

    expect(later[0].outcome).toBe('SENT');
  });

  it('keeps every cell on its own cooldown', async () => {
    const notifier = configured();
    const banesco = priceChange(940, 945);
    const other = priceChange(942, 947);
    // Same bank in the fixture, so force a different cell identity.
    (other as { cell: { amountKey: string } }).cell.amountKey = '50K';

    const results = await notifier.notifyMakerAlerts([banesco, other], T0);

    expect(results.map((r) => r.outcome)).toEqual(['SENT', 'SENT']);
  });
});

describe('Telegram: the summary is the periodic voice, and is never throttled', () => {
  function matrixOf(cell: ReturnType<typeof makeCell>) {
    return {
      capturedAt: T0,
      ageSeconds: 12,
      stale: false,
      staleAfterSeconds: 315,
      bankOrder: ['banesco'],
      bankDisplayNames: { banesco: 'Banesco' },
      amountKeys: ['10K'],
      cells: { banesco: { '10K': cell } },
      config: DEFAULT_MAKER_CONFIG,
    };
  }

  it('sends the summary every time it is handed one', async () => {
    const notifier = configured();
    const summary: MakerAlert = { kind: 'SUMMARY', matrix: matrixOf(makeCell(940, 945)) };

    await notifier.notifyMakerAlerts([summary], T0);
    await notifier.notifyMakerAlerts([summary], T0 + 1_800_000);

    // The 30-minute clock lives in evaluateMakerAlerts; a second gate here
    // would silently swallow a due summary.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('names the bank, the amount, both prices and the margin', async () => {
    const notifier = configured();
    await notifier.notifyMakerAlerts(
      [{ kind: 'SUMMARY', matrix: matrixOf(makeCell(940, 945)) }],
      T0
    );

    const [body] = sentBodies();
    expect(body).toContain('MIS PRECIOS PARA PUBLICAR');
    expect(body).toContain('Banesco');
    expect(body).toContain('10K');
    expect(body).toContain('🟢 Compra: <b>940.01</b>');
    expect(body).toContain('🔵 Venta: <b>944.99</b>');
    expect(body).toContain('💵 Margen: <b>+4.98 VES</b>');
  });

  it('never speaks the arbitrage vocabulary', async () => {
    const notifier = configured();
    await notifier.notifyMakerAlerts(
      [{ kind: 'SUMMARY', matrix: matrixOf(makeCell(940, 945)) }],
      T0
    );

    const [body] = sentBodies();
    expect(body).not.toMatch(
      /ARBITRAJE|OPORTUNIDAD|EXECUTABLE|EJECUTABLE|NO_OPPORTUNITY|BEST.?OPPORTUNITY/i
    );
    expect(body).toContain('MARGEN BRUTO POTENCIAL');
    // The three phrasings the operator ruled out by name. The disclaimer's own
    // "No es una operación garantizada" is the opposite claim and must stay.
    expect(body).not.toMatch(/ganancia garantizada|arbitraje garantizado|oportunidad garantizada/i);
    expect(body).toContain('No es una operación garantizada.');
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
    const [result] = await configured().notifyMakerAlerts([priceChange(940, 945)], T0);

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
