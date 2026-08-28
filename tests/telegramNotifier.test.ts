/**
 * Telegram notification layer - TRANSPORT.
 *
 * No test performs real network I/O: fetch is always stubbed, so nothing is
 * ever sent to a real chat.
 *
 * THIS FILE USED TO DRIVE EVERY TRANSPORT TEST THROUGH notifyAlert, the
 * emitter that turned an AlertTriggerLog into "🟢 ALERTA DE PRECIO",
 * "🔴 ALERTA P2P" and "⚠️ ALTA VOLATILIDAD". That emitter is gone, together
 * with formatAlertMessage, cooldownKey, marketLabel and strategicLines.
 *
 * The transport concerns those tests covered are real and independent of which
 * message rides on top - the POST shape, DISABLED, HTTP errors, aborts, the
 * cooldown, and the guarantee that neither credential ever reaches a log - so
 * every one of them is kept and re-pointed at notifySystemAlert, which uses
 * the same send() path. Nothing was dropped except the assertions about the
 * deleted formatter itself.
 *
 * That the price alert can no longer be produced at all is asserted
 * structurally and end-to-end in tests/telegramNoPriceAlert.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ALERT_COOLDOWN_MS,
  DEFAULT_SYSTEM_ALERT_COOLDOWN_MS,
  TelegramNotifier,
  escapeHtml,
  readTelegramConfig,
  redactSecrets,
} from '../server/telegramNotifier.js';
import type { TelegramConfig } from '../server/telegramNotifier.js';
import { makeAdItem, makeBinanceResponse } from './helpers/fixtures.js';
import type { TelegramSystemAlert } from '../server/types.js';

const TOKEN = '7654321:AAF-TestTokenValueThatMustNeverLeak';
const CHAT_ID = '-1002233445566';

const config = (overrides: Partial<TelegramConfig> = {}): TelegramConfig => ({
  botToken: TOKEN,
  chatId: CHAT_ID,
  cooldownMs: DEFAULT_ALERT_COOLDOWN_MS,
  timeoutMs: 5000,
  ...overrides,
});

const BASE_TS = Date.parse('2026-08-23T03:51:31Z'); // 23:51:31 VET the day before

/**
 * A system alert is the vehicle for the transport tests.
 *
 * `state` is the identity of the CONDITION: notifySystemAlert reports
 * UNCHANGED when the same state is handed to it twice, so every test that
 * needs a second attempt to reach the wire varies the state.
 */
function makeSystemAlert(overrides: Partial<TelegramSystemAlert> = {}): TelegramSystemAlert {
  return {
    kind: 'BINANCE_OFFLINE',
    timestamp: BASE_TS,
    state: 'offline-1',
    detail: 'La captura no responde.',
    ...overrides,
  };
}

/** Collects everything written to the console during a test. */
function captureConsole() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(record);
  vi.spyOn(console, 'warn').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
  return lines;
}

function stubFetchOk() {
  const mock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  TelegramNotifier.resetInstance();
});

describe('readTelegramConfig', () => {
  it('is enabled when both credentials are present', () => {
    const cfg = readTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT_ID });
    expect(cfg).toMatchObject({ botToken: TOKEN, chatId: CHAT_ID });
    expect(cfg?.cooldownMs).toBe(DEFAULT_ALERT_COOLDOWN_MS);
  });

  it('is disabled when either credential is missing or blank', () => {
    expect(readTelegramConfig({ TELEGRAM_CHAT_ID: CHAT_ID })).toBeNull();
    expect(readTelegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN })).toBeNull();
    expect(readTelegramConfig({})).toBeNull();
    expect(
      readTelegramConfig({ TELEGRAM_BOT_TOKEN: '   ', TELEGRAM_CHAT_ID: CHAT_ID })
    ).toBeNull();
  });

  it('honours TELEGRAM_ALERT_COOLDOWN_MS and ignores nonsense values', () => {
    const custom = readTelegramConfig({
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_CHAT_ID: CHAT_ID,
      TELEGRAM_ALERT_COOLDOWN_MS: '60000',
    });
    expect(custom?.cooldownMs).toBe(60000);

    const bogus = readTelegramConfig({
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_CHAT_ID: CHAT_ID,
      TELEGRAM_ALERT_COOLDOWN_MS: 'not-a-number',
    });
    expect(bogus?.cooldownMs).toBe(DEFAULT_ALERT_COOLDOWN_MS);
  });
});

describe('TEST 1 - configured: the message is sent', () => {
  it('POSTs to the Telegram API with the expected payload', async () => {
    const fetchMock = stubFetchOk();
    const notifier = new TelegramNotifier(config());

    const result = await notifier.notifySystemAlert(
      makeSystemAlert({ detail: 'Binance devolvio 403 en las ultimas 3 capturas.' })
    );

    expect(result.outcome).toBe('SENT');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');

    const body = JSON.parse(String(init.body));
    expect(body.chat_id).toBe(CHAT_ID);
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('403');
  });

  it('logs a success line', async () => {
    const lines = captureConsole();
    stubFetchOk();
    await new TelegramNotifier(config()).notifySystemAlert(makeSystemAlert());
    expect(lines.join('\n')).toContain('[Telegram] Alert sent successfully');
  });
});

describe('TEST 2 - not configured: the system keeps working', () => {
  it('reports DISABLED and never touches the network', async () => {
    const fetchMock = stubFetchOk();
    const notifier = new TelegramNotifier(null);

    const result = await notifier.notifySystemAlert(makeSystemAlert());

    expect(result.outcome).toBe('DISABLED');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notifier.isEnabled()).toBe(false);
  });

  it('warns exactly once at startup, never on every message', async () => {
    const lines = captureConsole();
    stubFetchOk();
    const notifier = new TelegramNotifier(null);

    notifier.logStartupStatus();
    notifier.logStartupStatus();
    for (let i = 0; i < 5; i++) {
      await notifier.notifySystemAlert(makeSystemAlert({ state: `offline-${i}` }));
    }

    const warnings = lines.filter((l) => l.includes('Notifications disabled'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      '[Telegram] Notifications disabled: Telegram credentials not configured.'
    );
  });
});

describe('TEST 3 - HTTP error: the bot keeps working', () => {
  it.each([429, 500, 401])('handles HTTP %i without throwing', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status }) as unknown as Response));
    const notifier = new TelegramNotifier(config());

    const result = await notifier.notifySystemAlert(makeSystemAlert());

    expect(result.outcome).toBe('HTTP_ERROR');
    expect(result.detail).toBe(`HTTP ${status}`);
  });

  it('logs the status code and nothing else', async () => {
    const lines = captureConsole();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429 }) as unknown as Response));

    await new TelegramNotifier(config()).notifySystemAlert(makeSystemAlert());

    expect(lines.join('\n')).toContain('[Telegram] Failed to send alert: HTTP 429');
  });

  it('survives a network-level failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED api.telegram.org');
      })
    );

    const result = await new TelegramNotifier(config()).notifySystemAlert(makeSystemAlert());
    expect(result.outcome).toBe('NETWORK_ERROR');
  });
});

describe('TEST 4 - timeout: the bot keeps working', () => {
  const hangingFetch = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('This operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          })
      )
    );

  it('aborts the request and reports TIMEOUT', async () => {
    hangingFetch();

    const notifier = new TelegramNotifier(config({ timeoutMs: 20 }));
    const result = await notifier.notifySystemAlert(makeSystemAlert());

    expect(result.outcome).toBe('TIMEOUT');
    expect(result.detail).toContain('timeout after 20ms');
  });

  it('does not leave the caller waiting forever', async () => {
    hangingFetch();

    const started = Date.now();
    await new TelegramNotifier(config({ timeoutMs: 20 })).notifySystemAlert(makeSystemAlert());
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('TEST 5 - the same condition does not spam', () => {
  /*
   * notifySystemAlert applies max(config.cooldownMs, DEFAULT_SYSTEM_ALERT_
   * COOLDOWN_MS), so the effective window here is the 15-minute floor, and a
   * repeated state is refused as UNCHANGED before the cooldown is even
   * consulted. Both gates are exercised.
   */
  const FLOOR = DEFAULT_SYSTEM_ALERT_COOLDOWN_MS;

  it('sends once and then reports UNCHANGED for an identical condition', async () => {
    const fetchMock = stubFetchOk();
    const notifier = new TelegramNotifier(config());

    const first = await notifier.notifySystemAlert(makeSystemAlert({ timestamp: BASE_TS }));
    expect(first.outcome).toBe('SENT');

    // 100 further polls across the next 10 minutes of the same condition.
    for (let i = 1; i <= 100; i++) {
      const result = await notifier.notifySystemAlert(
        makeSystemAlert({ timestamp: BASE_TS + i * 6000 })
      );
      expect(result.outcome).toBe('UNCHANGED');
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports COOLDOWN when the condition flaps inside the window', async () => {
    const fetchMock = stubFetchOk();
    const notifier = new TelegramNotifier(config());

    await notifier.notifySystemAlert(makeSystemAlert({ timestamp: BASE_TS, state: 'a' }));
    const flap = await notifier.notifySystemAlert(
      makeSystemAlert({ timestamp: BASE_TS + 6000, state: 'b' })
    );

    expect(flap.outcome).toBe('COOLDOWN');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not let one condition silence a different one', async () => {
    const fetchMock = stubFetchOk();
    const notifier = new TelegramNotifier(config());

    await notifier.notifySystemAlert(makeSystemAlert({ timestamp: BASE_TS }));
    const other = await notifier.notifySystemAlert(
      makeSystemAlert({ kind: 'STORAGE_ERROR', state: 'disk-full', timestamp: BASE_TS + 6000 })
    );

    expect(other.outcome).toBe('SENT');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on every poll while Telegram is failing', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const notifier = new TelegramNotifier(config());

    for (let i = 0; i < 20; i++) {
      await notifier.notifySystemAlert(
        makeSystemAlert({ state: `flap-${i}`, timestamp: BASE_TS + i * 6000 })
      );
    }
    // A 429 must not turn into 20 more requests.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('TEST 6 - sends again once the window has elapsed', async () => {
    const fetchMock = stubFetchOk();
    const notifier = new TelegramNotifier(config());

    expect(
      (await notifier.notifySystemAlert(makeSystemAlert({ timestamp: BASE_TS, state: 'a' })))
        .outcome
    ).toBe('SENT');
    expect(
      (
        await notifier.notifySystemAlert(
          makeSystemAlert({ timestamp: BASE_TS + FLOOR - 1, state: 'b' })
        )
      ).outcome
    ).toBe('COOLDOWN');
    expect(
      (
        await notifier.notifySystemAlert(
          makeSystemAlert({ timestamp: BASE_TS + FLOOR, state: 'c' })
        )
      ).outcome
    ).toBe('SENT');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('TEST 7 & 8 - credentials never reach the logs', () => {
  it('keeps the token and chat id out of a successful send', async () => {
    const lines = captureConsole();
    stubFetchOk();
    await new TelegramNotifier(config()).notifySystemAlert(makeSystemAlert());

    const output = lines.join('\n');
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(CHAT_ID);
  });

  it('keeps them out of an HTTP error', async () => {
    const lines = captureConsole();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response));
    await new TelegramNotifier(config()).notifySystemAlert(makeSystemAlert());

    const output = lines.join('\n');
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(CHAT_ID);
  });

  it('redacts a fetch error that echoes the request URL', async () => {
    // A real failure often reports the URL, and the URL carries the token.
    const lines = captureConsole();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(
          `request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, chat ${CHAT_ID}`
        );
      })
    );

    const result = await new TelegramNotifier(config()).notifySystemAlert(makeSystemAlert());

    const output = lines.join('\n');
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(CHAT_ID);
    expect(output).toContain('<redacted-token>');
    expect(result.detail).not.toContain(TOKEN);
  });

  it('never prints the variable names with a value attached', async () => {
    const lines = captureConsole();
    stubFetchOk();
    const notifier = new TelegramNotifier(config());
    notifier.logStartupStatus();
    await notifier.notifySystemAlert(makeSystemAlert());

    expect(lines.join('\n')).not.toMatch(/TELEGRAM_BOT_TOKEN\s*[=:]/);
    expect(lines.join('\n')).not.toMatch(/TELEGRAM_CHAT_ID\s*[=:]/);
  });

  it('redactSecrets strips both credentials from arbitrary text', () => {
    const text = `token ${TOKEN} and chat ${CHAT_ID}`;
    const clean = redactSecrets(text, config());
    expect(clean).not.toContain(TOKEN);
    expect(clean).not.toContain(CHAT_ID);
  });

  it('escapes HTML so crafted text cannot break the message', () => {
    expect(escapeHtml('<b>x</b> & "y"')).not.toContain('<b>');
    expect(escapeHtml('a & b')).toContain('&amp;');
  });
});

describe('integration - the alert engine keeps running when Telegram fails', () => {
  const originalCwd = process.cwd();
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-telegram-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });

  /**
   * Seeds the rule by hand.
   *
   * storage.ts no longer invents rules on a fresh install - that is what made a
   * new deployment start announcing market levels before anybody configured
   * anything - so a test that wants a rule to fire has to create one, exactly
   * as /api/alerts would.
   */
  async function seedSpreadRule() {
    const { StorageEngine } = await import('../server/storage.js');
    StorageEngine.saveAlert({
      id: 'rule-spread-high',
      name: 'Spread Mayor a 2.0%',
      condition: 'SPREAD_ABOVE',
      targetValue: 2.0,
      targetSide: 'SELL',
      enabled: true,
      createdAt: 1,
    });
  }

  async function pollWithBinance(buyPrice: string, sellPrice: string) {
    vi.resetModules();
    const { CentralMarketStore } = await import('../server/centralStore.js');
    const store = CentralMarketStore.getInstance();
    const telegramCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (String(url).includes('api.telegram.org')) {
          telegramCalls.push(String(url));
          throw new Error('Telegram API unavailable');
        }
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () =>
            makeBinanceResponse([
              makeAdItem({ price: body.tradeType === 'BUY' ? buyPrice : sellPrice }),
            ]),
        } as unknown as Response;
      })
    );
    await seedSpreadRule();
    return { store, telegramCalls };
  }

  it('still captures, persists and alerts when Telegram throws', async () => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_CHAT_ID = CHAT_ID;

    const { store } = await pollWithBinance('918.00', '941.00'); // spread 2.51% > 2%
    const snapshot = await store.pollMarket();

    // Capture is unaffected.
    expect(snapshot?.status).toBe('LIVE');
    expect(snapshot?.bestBuyPrice).toBe(918);

    // History is written.
    const history = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'data', 'market_history.json'), 'utf-8')
    );
    expect(history).toHaveLength(1);

    // The alert itself still fired and was logged to disk.
    await vi.waitFor(() => {
      const triggers = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'data', 'alert_triggers.json'), 'utf-8')
      );
      expect(triggers.length).toBeGreaterThan(0);
    });
  });

  it('runs identically with Telegram unconfigured', async () => {
    const { store } = await pollWithBinance('918.00', '941.00');
    const snapshot = await store.pollMarket();

    expect(snapshot?.status).toBe('LIVE');
    const triggers = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'data', 'alert_triggers.json'), 'utf-8')
    );
    expect(triggers.length).toBeGreaterThan(0);
  });
});
