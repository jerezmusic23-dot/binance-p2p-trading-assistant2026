/**
 * Telegram notification layer.
 *
 * No test performs real network I/O: fetch is always stubbed, so nothing is
 * ever sent to a real chat.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_ALERT_COOLDOWN_MS,
  TelegramNotifier,
  cooldownKey,
  escapeHtml,
  formatAlertMessage,
  readTelegramConfig,
  redactSecrets,
} from '../server/telegramNotifier.js';
import type { TelegramConfig } from '../server/telegramNotifier.js';
import { makeAdItem, makeBinanceResponse, makeSnapshot } from './helpers/fixtures.js';
import type { AlertRule, AlertTriggerLog } from '../server/types.js';

const TOKEN = '7654321:AAF-TestTokenValueThatMustNeverLeak';
const CHAT_ID = '-1002233445566';

const config = (overrides: Partial<TelegramConfig> = {}): TelegramConfig => ({
  botToken: TOKEN,
  chatId: CHAT_ID,
  cooldownMs: DEFAULT_ALERT_COOLDOWN_MS,
  timeoutMs: 5000,
  ...overrides,
});

const spreadRule: AlertRule = {
  id: 'rule-spread-high',
  name: 'Spread Mayor a 2.0%',
  condition: 'SPREAD_ABOVE',
  targetValue: 2.0,
  targetSide: 'SELL',
  enabled: true,
  createdAt: 1,
};

const volatilityRule: AlertRule = {
  id: 'rule-volatility-spike',
  name: 'Movimiento Brusco / Volatilidad',
  condition: 'VOLATILITY_SPIKE',
  targetValue: 1.5,
  targetSide: 'BUY',
  enabled: true,
  createdAt: 1,
};

function makeTrigger(overrides: Partial<AlertTriggerLog> = {}): AlertTriggerLog {
  return {
    id: 'trigger-1',
    ruleId: spreadRule.id,
    ruleName: spreadRule.name,
    message: 'Spread P2P (6.52%) superó el umbral de 2%.',
    price: 921.0,
    timestamp: Date.parse('2026-08-23T03:51:31Z'), // 23:51:31 VET the day before
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

describe('TEST 1 - configured: the alert is sent', () => {
  it('POSTs to the Telegram API with the expected payload', async () => {
    const fetchMock = stubFetchOk();
    const notifier = new TelegramNotifier(config());

    const result = await notifier.notifyAlert(makeTrigger(), spreadRule, makeSnapshot({
      strategicSpreadPct: 6.52,
    }));

    expect(result.outcome).toBe('SENT');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');

    const body = JSON.parse(String(init.body));
    expect(body.chat_id).toBe(CHAT_ID);
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('6.52%');
    expect(body.text).toContain('USDT/VES');
  });

  it('logs a success line', async () => {
    const lines = captureConsole();
    stubFetchOk();
    await new TelegramNotifier(config()).notifyAlert(makeTrigger(), spreadRule, makeSnapshot());
    expect(lines.join('\n')).toContain('[Telegram] Alert sent successfully');
  });
});

describe('TEST 2 - not configured: the system keeps working', () => {
  it('reports DISABLED and never touches the network', async () => {
    const fetchMock = stubFetchOk();
    const notifier = new TelegramNotifier(null);

    const result = await notifier.notifyAlert(makeTrigger(), spreadRule, makeSnapshot());

    expect(result.outcome).toBe('DISABLED');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notifier.isEnabled()).toBe(false);
  });

  it('warns exactly once at startup, never on every alert', async () => {
    const lines = captureConsole();
    stubFetchOk();
    const notifier = new TelegramNotifier(null);

    notifier.logStartupStatus();
    notifier.logStartupStatus();
    for (let i = 0; i < 5; i++) {
      await notifier.notifyAlert(makeTrigger({ id: `t${i}` }), spreadRule, makeSnapshot());
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

    const result = await notifier.notifyAlert(makeTrigger(), spreadRule, makeSnapshot());

    expect(result.outcome).toBe('HTTP_ERROR');
    expect(result.detail).toBe(`HTTP ${status}`);
  });

  it('logs the status code and nothing else', async () => {
    const lines = captureConsole();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429 }) as unknown as Response));

    await new TelegramNotifier(config()).notifyAlert(makeTrigger(), spreadRule, makeSnapshot());

    expect(lines.join('\n')).toContain('[Telegram] Failed to send alert: HTTP 429');
  });

  it('survives a network-level failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED api.telegram.org');
      })
    );

    const result = await new TelegramNotifier(config()).notifyAlert(
      makeTrigger(),
      spreadRule,
      makeSnapshot()
    );
    expect(result.outcome).toBe('NETWORK_ERROR');
  });
});

describe('TEST 4 - timeout: the bot keeps working', () => {
  it('aborts the request and reports TIMEOUT', async () => {
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

    const notifier = new TelegramNotifier(config({ timeoutMs: 20 }));
    const result = await notifier.notifyAlert(makeTrigger(), spreadRule, makeSnapshot());

    expect(result.outcome).toBe('TIMEOUT');
    expect(result.detail).toContain('timeout after 20ms');
  });

  it('does not leave the alert loop waiting forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          })
      )
    );

    const started = Date.now();
    await new TelegramNotifier(config({ timeoutMs: 20 })).notifyAlert(
      makeTrigger(),
      spreadRule,
      makeSnapshot()
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('TEST 5 - the same alert does not spam', () => {
  it('sends once and then reports COOLDOWN', async () => {
    const fetchMock = stubFetchOk();
    const notifier = new TelegramNotifier(config({ cooldownMs: 300_000 }));
    const base = makeTrigger().timestamp;

    const first = await notifier.notifyAlert(makeTrigger({ timestamp: base }), spreadRule, makeSnapshot());
    expect(first.outcome).toBe('SENT');

    // 100 further polls across the next 10 minutes of the same condition.
    for (let i = 1; i <= 100; i++) {
      const result = await notifier.notifyAlert(
        makeTrigger({ id: `t${i}`, timestamp: base + i * 6000 }),
        spreadRule,
        makeSnapshot()
      );
      if (base + i * 6000 - base < 300_000) expect(result.outcome).toBe('COOLDOWN');
    }

    // 101 polls span 600s. With a 300s cooldown the window opens at t=0,
    // t=300s and t=600s: 3 messages instead of 101.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keys the cooldown by alert type and condition, not by rule id', async () => {
    const fetchMock = stubFetchOk();
    const notifier = new TelegramNotifier(config());
    const base = makeTrigger().timestamp;

    // Two different rule ids saying exactly the same thing.
    const twin: AlertRule = { ...spreadRule, id: 'rule-spread-duplicate' };

    await notifier.notifyAlert(makeTrigger({ timestamp: base }), spreadRule, makeSnapshot());
    const second = await notifier.notifyAlert(
      makeTrigger({ id: 't2', ruleId: twin.id, timestamp: base + 6000 }),
      twin,
      makeSnapshot()
    );

    expect(second.outcome).toBe('COOLDOWN');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cooldownKey(spreadRule)).toBe(cooldownKey(twin));
  });

  it('does not let one alert type silence a different one', async () => {
    const fetchMock = stubFetchOk();
    const notifier = new TelegramNotifier(config());
    const base = makeTrigger().timestamp;

    await notifier.notifyAlert(makeTrigger({ timestamp: base }), spreadRule, makeSnapshot());
    const other = await notifier.notifyAlert(
      makeTrigger({ id: 't2', timestamp: base + 6000 }),
      volatilityRule,
      makeSnapshot()
    );

    expect(other.outcome).toBe('SENT');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on every poll while Telegram is failing', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const notifier = new TelegramNotifier(config({ cooldownMs: 300_000 }));
    const base = makeTrigger().timestamp;

    for (let i = 0; i < 20; i++) {
      await notifier.notifyAlert(
        makeTrigger({ id: `t${i}`, timestamp: base + i * 6000 }),
        spreadRule,
        makeSnapshot()
      );
    }
    // A 429 must not turn into 20 more requests.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('TEST 6 - a new alert after the cooldown is sent again', () => {
  it('sends again once the window has elapsed', async () => {
    const fetchMock = stubFetchOk();
    const notifier = new TelegramNotifier(config({ cooldownMs: 300_000 }));
    const base = makeTrigger().timestamp;

    expect((await notifier.notifyAlert(makeTrigger({ timestamp: base }), spreadRule, makeSnapshot())).outcome).toBe('SENT');
    expect(
      (await notifier.notifyAlert(makeTrigger({ id: 't2', timestamp: base + 299_999 }), spreadRule, makeSnapshot())).outcome
    ).toBe('COOLDOWN');
    expect(
      (await notifier.notifyAlert(makeTrigger({ id: 't3', timestamp: base + 300_000 }), spreadRule, makeSnapshot())).outcome
    ).toBe('SENT');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('TEST 7 & 8 - credentials never reach the logs', () => {
  it('keeps the token and chat id out of a successful send', async () => {
    const lines = captureConsole();
    stubFetchOk();
    await new TelegramNotifier(config()).notifyAlert(makeTrigger(), spreadRule, makeSnapshot());

    const output = lines.join('\n');
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(CHAT_ID);
  });

  it('keeps them out of an HTTP error', async () => {
    const lines = captureConsole();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response));
    await new TelegramNotifier(config()).notifyAlert(makeTrigger(), spreadRule, makeSnapshot());

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

    const result = await new TelegramNotifier(config()).notifyAlert(
      makeTrigger(),
      spreadRule,
      makeSnapshot()
    );

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
    await notifier.notifyAlert(makeTrigger(), spreadRule, makeSnapshot());

    expect(lines.join('\n')).not.toMatch(/TELEGRAM_BOT_TOKEN\s*[=:]/);
    expect(lines.join('\n')).not.toMatch(/TELEGRAM_CHAT_ID\s*[=:]/);
  });

  it('redactSecrets strips both credentials from arbitrary text', () => {
    const text = `token ${TOKEN} and chat ${CHAT_ID}`;
    const clean = redactSecrets(text, config());
    expect(clean).not.toContain(TOKEN);
    expect(clean).not.toContain(CHAT_ID);
  });
});

describe('message formatting', () => {
  it('renders the spread alert with the real measured values', () => {
    const text = formatAlertMessage(
      makeTrigger(),
      spreadRule,
      makeSnapshot({ strategicSpreadPct: 6.52 })
    );

    expect(text).toContain('ALERTA P2P');
    expect(text).toContain('Spread estratégico: <b>6.52%</b>');
    expect(text).toContain('Umbral: 2.00%');
    expect(text).toContain('Mercado: USDT/VES');
    expect(text).toContain('Estado: ACTIVADO');
    expect(text).toMatch(/Hora: \d{2}:\d{2}:\d{2}/);
  });

  it('renders the volatility alert naming the metric that was actually measured', () => {
    // The rule compares the spread against targetValue * 1.5, so the message
    // must say "spread", not invent a volatility index.
    const text = formatAlertMessage(
      makeTrigger({ message: 'Alta volatilidad detectada...' }),
      volatilityRule,
      makeSnapshot({ strategicSpreadPct: 6.52 })
    );

    expect(text).toContain('ALTA VOLATILIDAD');
    expect(text).toContain('Spread estratégico medido: <b>6.52%</b>');
    expect(text).toContain('Umbral efectivo: 2.25%'); // 1.5 * 1.5
  });

  it('omits the spread line rather than inventing one when it is null', () => {
    const text = formatAlertMessage(
      makeTrigger(),
      volatilityRule,
      makeSnapshot({ strategicSpreadPct: null })
    );
    expect(text).not.toContain('Spread estratégico medido');
    expect(text).toContain('ALTA VOLATILIDAD');
  });

  it('renders price alerts with the triggering price', () => {
    const rule: AlertRule = { ...spreadRule, condition: 'ABOVE', targetValue: 900, targetSide: 'BUY' };
    const text = formatAlertMessage(makeTrigger({ price: 918.35 }), rule, makeSnapshot());

    expect(text).toContain('ALERTA DE PRECIO');
    expect(text).toContain('Precio estratégico BUY: <b>918.35 VES</b>');
    expect(text).toContain('Umbral: 900.00 VES');
  });

  it('FASE 2: reports the strategic spread, never the raw extreme spread', () => {
    // The production incident: 19 ads at ~921 plus one at 980 VES. The raw
    // spread |max(SELL) - min(BUY)| reads 6.64%; the market is at 0.14%.
    // Reporting the raw figure is what made a single ad look like an
    // opportunity worth notifying.
    const text = formatAlertMessage(
      makeTrigger(),
      spreadRule,
      makeSnapshot({ spreadPercentage: 6.64, strategicSpreadPct: 0.14 })
    );

    expect(text).toContain('Spread estratégico: <b>0.14%</b>');
    expect(text).not.toContain('6.64');
  });

  it('FASE 2: prints where both sides of the operation actually are', () => {
    const text = formatAlertMessage(
      makeTrigger(),
      spreadRule,
      makeSnapshot({ strategicBuyPrice: 921.39, strategicSellPrice: 921.79 })
    );

    expect(text).toContain('Recompra (BUY): <b>921.39 VES</b>');
    expect(text).toContain('Venta (SELL): <b>921.79 VES</b>');
  });

  it('FASE 2: omits both levels rather than inventing one when a side is empty', () => {
    const text = formatAlertMessage(
      makeTrigger(),
      spreadRule,
      makeSnapshot({ strategicBuyPrice: null, strategicSellPrice: 921.79 })
    );

    expect(text).not.toContain('Recompra (BUY)');
    expect(text).not.toContain('Venta (SELL)');
  });

  it('escapes HTML so a crafted rule name cannot break the message', () => {
    expect(escapeHtml('<b>x</b> & "y"')).toBe('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;');
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

  async function pollWithBinance(buyPrice: string, sellPrice: string) {
    vi.resetModules();
    const { CentralMarketStore } = await import('../server/centralStore.js');
    const store = CentralMarketStore.getInstance();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (String(url).includes('api.telegram.org')) {
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
    return store;
  }

  it('still captures, persists and alerts when Telegram throws', async () => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_CHAT_ID = CHAT_ID;

    const store = await pollWithBinance('918.00', '941.00'); // spread 2.51% > 2%
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
    const store = await pollWithBinance('918.00', '941.00');
    const snapshot = await store.pollMarket();

    expect(snapshot?.status).toBe('LIVE');
    const triggers = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'data', 'alert_triggers.json'), 'utf-8')
    );
    expect(triggers.length).toBeGreaterThan(0);
  });
});

describe('BEST_OPPORTUNITY message', () => {
  const opportunityRule: AlertRule = {
    id: 'op-rule',
    name: 'Oportunidad ejecutable',
    condition: 'OPPORTUNITY_ABOVE',
    targetValue: 0.05,
    targetSide: 'BUY',
    enabled: true,
    createdAt: 1,
  };

  const opportunity = {
    bank: 'BANESCO',
    amountVes: 50_000,
    buyPrice: 921.39,
    sellPrice: 921.79,
    buyAdvNo: 'b',
    sellAdvNo: 's',
    spreadAbsolute: 0.4,
    spreadPct: 0.0434,
    marginAbsolute: 0.4,
    marginPct: 0.0434,
    buyAvailableUsdt: 900,
    sellAvailableUsdt: 480,
    availableUsdt: 480,
    verification: 'VERIFIED' as const,
    provenance: 'EXECUTABLE' as const,
    reason: null,
  };

  it('reports the operation: bank, amount, both prices, spread and liquidity', () => {
    const text = formatAlertMessage(makeTrigger(), opportunityRule, makeSnapshot(), opportunity);

    expect(text).toContain('BEST OPPORTUNITY');
    expect(text).toContain('Banco: <b>BANESCO</b>');
    expect(text).toContain('Recompra (BUY): <b>921.39 VES</b>');
    expect(text).toContain('Venta (SELL): <b>921.79 VES</b>');
    expect(text).toContain('0.0434%');
    expect(text).toContain('480.00 USDT');
    expect(text).toContain('VERIFIED');
  });

  it('calls the margin GROSS and says what it does not discount', () => {
    const text = formatAlertMessage(makeTrigger(), opportunityRule, makeSnapshot(), opportunity);

    expect(text).toContain('Margen BRUTO');
    expect(text).toContain('NO es beneficio neto');
    expect(text).not.toMatch(/beneficio neto:/i);
  });

  it('never reports a raw extreme, whatever the snapshot carries', () => {
    const text = formatAlertMessage(
      makeTrigger(),
      opportunityRule,
      makeSnapshot({ bestBuyPrice: 919, bestSellPrice: 980, spreadPercentage: 6.64 }),
      opportunity
    );

    expect(text).not.toContain('980');
    expect(text).not.toContain('6.64');
  });

  it('says liquidity is unverifiable instead of printing a number', () => {
    const text = formatAlertMessage(makeTrigger(), opportunityRule, makeSnapshot(), {
      ...opportunity,
      availableUsdt: null,
      sellAvailableUsdt: null,
      verification: 'NOT_VERIFIABLE',
      provenance: 'NOT_VERIFIABLE',
    });

    expect(text).toContain('Liquidez: no verificable');
    expect(text).not.toMatch(/Liquidez: <b>0/);
  });

  it('fabricates no opportunity when there is none to report', () => {
    const text = formatAlertMessage(makeTrigger(), opportunityRule, makeSnapshot(), null);

    expect(text).toContain('ya no esta disponible');
    expect(text).not.toContain('921');
  });
});
