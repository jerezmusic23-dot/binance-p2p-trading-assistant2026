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
import {
  EMPTY_DIGEST_STATE,
  accumulatePriceChange,
  releasePriceChangeDigest,
} from '../server/alertScheduler.js';
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

  it('reports DISABLED and sends nothing for a price digest', async () => {
    const notifier = new TelegramNotifier(null);
    const result = await notifier.notifyPriceChangeDigest({
      changes: [],
      revertedCells: 0,
      releasedAt: T0,
      nextReleaseAt: T0,
    });

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
/*
 * THIS BLOCK USED TO TEST A PER-CELL EMITTER: one message per changed cell,
 * throttled per cell.
 *
 * That emitter is gone. Detection still happens per cell and immediately, but
 * delivery is now one grouped digest per window, so the guarantees move with
 * it: a window that produced no NET change sends nothing, a cell that moved
 * five times contributes one line, and the whole matrix produces one message.
 */
describe('Telegram: price changes are grouped, not repeated', () => {
  /*
   * `to` is the RECOMMENDED price, which sits one observed tick above the
   * leader - so the fixture builds the cell from `to - 0.01`. Passing `to` as
   * the leader would silently produce a recommendation of `to + 0.01` and make
   * every assertion below one cent wrong.
   */
  const change = (bank: string, amountKey: string, from: number, to: number) => {
    const cell = makeCell(Number((to - 0.01).toFixed(2)), 945);
    return {
      cell: { ...cell, bank, amountKey, bankDisplayName: bank },
      pairing: cell.recommendation!.recommended!,
      previous: { buyPrice: from, sellPrice: 944.99 },
    };
  };

  it('sends ONE message for many cells that moved', async () => {
    const notifier = configured();
    let state = EMPTY_DIGEST_STATE;
    for (const [bank, amount, from, to] of [
      ['Banesco', '10K', 941, 942],
      ['Banesco', '20K', 940, 941],
      ['Mercantil', '10K', 939, 940],
      ['Venezuela', '30K', 938, 939],
    ] as const) {
      state = accumulatePriceChange(state, change(bank, amount, from, to), T0);
    }

    const released = releasePriceChangeDigest(state, T0, 1_800_000);
    await notifier.notifyPriceChangeDigest(released.digest!);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [body] = sentBodies();
    expect(body).toContain('CAMBIOS DE PRECIOS PARA PUBLICAR');
    expect(body).toContain('Se detectaron 4 cambio(s).');
  });

  it('holds the window shut until the interval has elapsed', () => {
    let state = releasePriceChangeDigest(
      accumulatePriceChange(EMPTY_DIGEST_STATE, change('Banesco', '10K', 941, 942), T0),
      T0,
      1_800_000
    ).state;

    state = accumulatePriceChange(state, change('Banesco', '10K', 942, 943), T0 + 60_000);
    expect(releasePriceChangeDigest(state, T0 + 60_000, 1_800_000).digest).toBeNull();
    expect(releasePriceChangeDigest(state, T0 + 1_800_000, 1_800_000).digest).not.toBeNull();
  });

  it('drops a cell that moved and came back, rather than reporting a non-change', async () => {
    const notifier = configured();
    let state = accumulatePriceChange(
      EMPTY_DIGEST_STATE,
      change('Banesco', '10K', 941, 942),
      T0
    );
    // Back to where it started, inside the same window.
    state = accumulatePriceChange(state, change('Banesco', '10K', 942, 941), T0 + 60_000);

    const released = releasePriceChangeDigest(state, T0, 1_800_000);
    expect(released.digest).toBeNull();

    const result = await notifier.notifyPriceChangeDigest({
      changes: [],
      revertedCells: 1,
      releasedAt: T0,
      nextReleaseAt: T0 + 1_800_000,
    });
    expect(result.outcome).toBe('UNCHANGED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports the NET move, not every wobble', async () => {
    const notifier = configured();
    let state = accumulatePriceChange(EMPTY_DIGEST_STATE, change('Banesco', '10K', 941, 942), T0);
    state = accumulatePriceChange(state, change('Banesco', '10K', 942, 943), T0 + 60_000);

    await notifier.notifyPriceChangeDigest(releasePriceChangeDigest(state, T0, 1_800_000).digest!);

    const [body] = sentBodies();
    // Announced 941, now 943: the 942 in between is not a decision anybody made.
    expect(body).toContain('10K → compra 941.00 → <b>943.00</b>');
    expect(body).not.toContain('942.00 →');
    expect(body).toContain('2 movimientos en la ventana');
  });

  it('says when the next revision is due', async () => {
    const notifier = configured();
    const state = accumulatePriceChange(
      EMPTY_DIGEST_STATE,
      change('Banesco', '10K', 941, 942),
      T0
    );
    await notifier.notifyPriceChangeDigest(releasePriceChangeDigest(state, T0, 1_800_000).digest!);

    expect(sentBodies()[0]).toMatch(/Próxima revisión automática:/);
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
    const result = await configured().notifyPriceChangeDigest({
      changes: [
        {
          bank: 'BANESCO',
          bankDisplayName: 'Banesco',
          amountKey: '10K',
          amountVes: 10_000,
          announcedBuyPrice: 941,
          announcedSellPrice: 946,
          latestBuyPrice: 942,
          latestSellPrice: 946,
          firstDetectedAt: T0,
          lastDetectedAt: T0,
          detections: 1,
        },
      ],
      revertedCells: 0,
      releasedAt: T0,
      nextReleaseAt: T0 + 1_800_000,
    });

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
