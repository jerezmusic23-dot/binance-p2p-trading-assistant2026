/**
 * price threshold crossed -> NO Telegram.
 *
 * The operator asked for one class of message to disappear entirely:
 *
 *   🟢 ALERTA DE PRECIO
 *   Precio estratégico BUY: 945.31 VES
 *   Umbral: 930.00 VES
 *   Tipo: Precio por encima del umbral
 *   Estado: ACTIVADO
 *
 * ...and, explicitly, for it not to come back renamed, downgraded to a
 * WARNING, or re-emitted through some other route. Deleting the formatter is
 * not enough on its own: the interesting failure is a future change that wires
 * a surviving emitter back to an alert rule. So this file asserts three
 * different things, and any one of them failing means the class is back:
 *
 *   1. STRUCTURAL  - no producer and no emitter for a rule alert exists.
 *   2. BEHAVIOURAL - a rule that fires, on a live poll, sends nothing.
 *   3. VOCABULARY  - no surviving message can contain the words.
 *
 * No test performs real network I/O.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeAdItem, makeBinanceResponse } from './helpers/fixtures.js';
import type { AlertRule } from '../server/types.js';

const TOKEN = '7654321:AAF-TestTokenValueThatMustNeverLeak';
const CHAT_ID = '-1002233445566';

const read = (file: string): string =>
  fs.readFileSync(path.join(process.cwd(), 'server', file), 'utf8');

/** Source with comments stripped, so prose about the deleted code cannot pass for code. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('1. STRUCTURAL - the producer no longer exists', () => {
  it('telegramNotifier has no formatAlertMessage and no notifyAlert', () => {
    const notifier = code('telegramNotifier.ts');
    expect(notifier).not.toMatch(/formatAlertMessage/);
    expect(notifier).not.toMatch(/notifyAlert/);
  });

  it('telegramNotifier no longer knows the alert types at all', () => {
    /*
     * The strongest available structural statement: the file cannot even name
     * an AlertTriggerLog or an AlertRule, so no emitter inside it can be given
     * one without a visible import being added back first.
     */
    const notifier = code('telegramNotifier.ts');
    expect(notifier).not.toMatch(/\bAlertTriggerLog\b/);
    expect(notifier).not.toMatch(/\bAlertRule\b/);
  });

  it('the three deleted helpers are gone with it', () => {
    const notifier = code('telegramNotifier.ts');
    for (const helper of ['cooldownKey', 'marketLabel', 'strategicLines']) {
      expect(notifier).not.toMatch(new RegExp(`function ${helper}\\b`));
    }
  });

  it('centralStore.evaluateAlerts calls no notifier method', () => {
    const store = code('centralStore.ts');
    const start = store.indexOf('private evaluateAlerts(');
    expect(start).toBeGreaterThan(-1);
    const body = store.slice(start);
    expect(body).not.toMatch(/TelegramNotifier/);
    expect(body).not.toMatch(/notify[A-Z]/);
  });

  it('storage seeds no alert rule on a fresh install', () => {
    const storage = code('storage.ts');
    expect(storage).not.toMatch(/rule-spread-high/);
    expect(storage).not.toMatch(/rule-volatility-spike/);
  });
});

describe('3. VOCABULARY - no surviving message can say it', () => {
  it('the words appear nowhere in any emitter', () => {
    const notifier = read('telegramNotifier.ts');
    // Comments explaining the removal are allowed; message templates are not.
    const templates = code('telegramNotifier.ts');
    expect(templates).not.toMatch(/ALERTA DE PRECIO/);
    expect(templates).not.toMatch(/ALERTA P2P/);
    expect(templates).not.toMatch(/ALTA VOLATILIDAD/);
    expect(templates).not.toMatch(/Precio por encima del umbral/);
    expect(templates).not.toMatch(/Precio por debajo del umbral/);
    expect(templates).not.toMatch(/Estado: ACTIVADO/);
    // The removal is documented rather than silent.
    expect(notifier).toMatch(/USED TO LIVE\s*\n?\s*\*?\s*HERE/);
  });

  it('no other server module formats one either', () => {
    const dir = path.join(process.cwd(), 'server');
    const offenders: string[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const body = code(file);
      if (/ALERTA DE PRECIO|Estado: ACTIVADO/.test(body)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe('2. BEHAVIOURAL - a rule that fires sends nothing', () => {
  const originalCwd = process.cwd();
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-no-price-alert-'));
    process.chdir(tmpDir);
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.TELEGRAM_CHAT_ID = CHAT_ID;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Runs one live poll with Telegram fully configured and a rule that the
   * captured book is guaranteed to trigger, and reports every request that
   * reached api.telegram.org.
   */
  async function pollWithRule(rule: AlertRule, buyPrice: string, sellPrice: string) {
    vi.resetModules();
    const telegramBodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (String(url).includes('api.telegram.org')) {
          telegramBodies.push(String(init.body));
          return { ok: true, status: 200 } as unknown as Response;
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

    const { StorageEngine } = await import('../server/storage.js');
    StorageEngine.saveAlert(rule);

    const { CentralMarketStore } = await import('../server/centralStore.js');
    const snapshot = await CentralMarketStore.getInstance().pollMarket();

    const triggers = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'data', 'alert_triggers.json'), 'utf-8')
    );
    return { snapshot, triggers, telegramBodies };
  }

  const rule = (overrides: Partial<AlertRule>): AlertRule => ({
    id: 'r1',
    name: 'regla',
    condition: 'ABOVE',
    targetValue: 930,
    targetSide: 'BUY',
    enabled: true,
    createdAt: 1,
    ...overrides,
  });

  it('ABOVE: the threshold is crossed, the trigger is logged, Telegram stays silent', async () => {
    // strategicBuyPrice ~945 against a 930 threshold: the rule must fire.
    const { snapshot, triggers, telegramBodies } = await pollWithRule(
      rule({ condition: 'ABOVE', targetValue: 930, targetSide: 'BUY' }),
      '945.31',
      '946.03'
    );

    expect(snapshot?.status).toBe('LIVE');
    // The rule really did fire - this is not a test that passes by nothing happening.
    expect(triggers.length).toBeGreaterThan(0);
    expect(triggers[0].message).toMatch(/superó el umbral/);
    // And nothing went to the wire.
    expect(telegramBodies).toEqual([]);
  });

  it('BELOW: same result on the other side of the threshold', async () => {
    const { triggers, telegramBodies } = await pollWithRule(
      rule({ condition: 'BELOW', targetValue: 999, targetSide: 'SELL' }),
      '945.31',
      '946.03'
    );

    expect(triggers.length).toBeGreaterThan(0);
    expect(telegramBodies).toEqual([]);
  });

  it('SPREAD_ABOVE: the spread rule is silent too', async () => {
    const { triggers, telegramBodies } = await pollWithRule(
      rule({ condition: 'SPREAD_ABOVE', targetValue: 2.0, targetSide: 'SELL' }),
      '918.00',
      '941.00'
    );

    expect(triggers.length).toBeGreaterThan(0);
    expect(telegramBodies).toEqual([]);
  });

  it('VOLATILITY_SPIKE: the volatility rule is silent too', async () => {
    const { triggers, telegramBodies } = await pollWithRule(
      rule({ condition: 'VOLATILITY_SPIKE', targetValue: 1.0, targetSide: 'BUY' }),
      '918.00',
      '941.00'
    );

    expect(triggers.length).toBeGreaterThan(0);
    expect(telegramBodies).toEqual([]);
  });

  it('a hundred consecutive crossings still send nothing', async () => {
    /*
     * The old path had a 5-minute per-rule gate and a cooldown in the notifier.
     * With the emitter removed the number is not "few", it is zero, and it
     * stays zero however long the condition holds.
     */
    vi.resetModules();
    const telegramBodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (String(url).includes('api.telegram.org')) {
          telegramBodies.push(String(init.body));
          return { ok: true, status: 200 } as unknown as Response;
        }
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () =>
            makeBinanceResponse([
              makeAdItem({ price: body.tradeType === 'BUY' ? '945.31' : '946.03' }),
            ]),
        } as unknown as Response;
      })
    );

    const { StorageEngine } = await import('../server/storage.js');
    StorageEngine.saveAlert(rule({ condition: 'ABOVE', targetValue: 930, targetSide: 'BUY' }));

    const { CentralMarketStore } = await import('../server/centralStore.js');
    const store = CentralMarketStore.getInstance();
    for (let i = 0; i < 100; i++) await store.pollMarket();

    expect(telegramBodies).toEqual([]);
  });

  it('the alert history the UI reads is still written', async () => {
    /*
     * The rules were not deleted, only unplugged from Telegram: /api/alerts and
     * src/AlertsManager.tsx are a panel the operator opens on purpose. If this
     * ever fails, the removal went further than was asked for.
     */
    const { triggers } = await pollWithRule(
      rule({ condition: 'ABOVE', targetValue: 930, targetSide: 'BUY' }),
      '945.31',
      '946.03'
    );

    expect(triggers[0]).toMatchObject({ ruleId: 'r1', ruleName: 'regla' });
    expect(typeof triggers[0].price).toBe('number');
    expect(typeof triggers[0].timestamp).toBe('number');
  });
});
