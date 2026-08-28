/**
 * "Alert sent successfully" NO ES UNA ALERTA.
 *
 * EL SÍNTOMA REPORTADO: varias líneas
 *
 *     [Telegram] Alert sent successfully
 *
 * seguidas, en el mismo minuto, alrededor de las 19:58-19:59, junto a
 * `[Alerts] TRIGGERED: Precio estratégico BUY ...` en el mismo log. Leídas
 * juntas parecen "la alerta de precio se envió varias veces".
 *
 * NO LO SON, y son dos cosas independientes:
 *
 *   [Alerts] TRIGGERED       lo escribe evaluateAlerts al registrar un disparo
 *                            en el HISTORIAL. No envía nada: notifyAlert y
 *                            formatAlertMessage no existen.
 *
 *   [Telegram] Alert sent    lo escribe send(), que es COMPARTIDO por los
 *                            cuatro emisores que quedan. El texto dice "Alert"
 *                            por herencia de cuando había alertas; hoy lo
 *                            imprime cualquier mensaje que salga.
 *
 * Y la ráfaga tiene una causa concreta: el resumen maker de 42 celdas NO CABE
 * en un mensaje de Telegram (4096 bytes), así que formatMakerSummaryMessages
 * lo parte por frontera de banco y notifyMakerAlerts envía las partes en un
 * bucle. N partes = N líneas consecutivas, en el mismo segundo. UN mensaje
 * lógico, numerado (1/2), (2/2).
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  TelegramNotifier,
  TELEGRAM_MESSAGE_LIMIT,
  formatMakerSummaryMessages,
} from '../server/telegramNotifier.js';
import { buildMakerMatrix } from '../server/makerMatrix.js';
import { DEFAULT_MAKER_CONFIG } from '../server/makerStrategy.js';
import { BANK_CODE_MAP } from '../server/binanceP2PService.js';
import { makeNormalizedAd } from './helpers/fixtures.js';
import type { NormalizedAd } from '../server/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  TelegramNotifier.resetInstance();
});

const AT = 1_756_000_000_000;
const BANKS = Object.keys(BANK_CODE_MAP);
const AMOUNTS = [
  { key: '10K', val: 10_000 },
  { key: '20K', val: 20_000 },
  { key: '30K', val: 30_000 },
  { key: '40K', val: 40_000 },
  { key: '50K', val: 50_000 },
  { key: '100K', val: 100_000 },
];

/** La matriz real: 7 bancos x 6 montos, con precios publicables en cada celda. */
function fullMatrix() {
  const ad = (price: number, payType: string): NormalizedAd => ({
    ...makeNormalizedAd(price),
    advNo: `adv-${payType}-${price}`,
    paymentOptions: [{ payType, tradeMethodName: payType }],
    paymentMethods: [payType],
  });

  const listingsByTier: Record<
    string,
    Record<string, { BUY: NormalizedAd[]; SELL: NormalizedAd[] }>
  > = {};
  const capturedAtByTier: Record<string, number> = {};

  for (const amount of AMOUNTS) {
    listingsByTier[amount.key] = {};
    capturedAtByTier[amount.key] = AT;
    for (const bank of BANKS) {
      const payType = BANK_CODE_MAP[bank].apiPayTypes[0];
      // Los decimales hacen observable el paso de precio, así que hay recomendación.
      listingsByTier[amount.key][bank] = {
        SELL: [ad(940.25, payType), ad(939.5, payType)],
        BUY: [ad(945.75, payType), ad(946.4, payType)],
      };
    }
  }

  const bankDisplayNames: Record<string, string> = {};
  const bankAllowedCodes: Record<string, string[]> = {};
  for (const bank of BANKS) {
    bankDisplayNames[bank] = BANK_CODE_MAP[bank].displayName;
    bankAllowedCodes[bank] = BANK_CODE_MAP[bank].apiPayTypes;
  }

  return buildMakerMatrix({
    bankOrder: BANKS,
    bankDisplayNames,
    bankAllowedCodes,
    amounts: AMOUNTS,
    listingsByTier,
    failedBanksByTier: {},
    capturedAtByTier,
    capturedAt: AT,
    config: DEFAULT_MAKER_CONFIG,
    nowMs: AT + 1000,
  });
}

describe('el texto del log es genérico, y lo escribe send()', () => {
  it('la línea sale de send(), no de ningún emisor de alertas', () => {
    const source = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'server', 'telegramNotifier.ts'),
      'utf8'
    ) as string;

    // Una sola aparición, y dentro de send().
    expect(source.match(/Alert sent successfully/g)).toHaveLength(1);
    const sendStart = source.indexOf('private async send(');
    const lineAt = source.indexOf('Alert sent successfully');
    expect(lineAt).toBeGreaterThan(sendStart);
  });

  it('la escribe un mensaje que no es una alerta - por ejemplo el resumen maker', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response));

    const notifier = new TelegramNotifier({
      botToken: '1234567890:FAKE-NOT-REAL',
      chatId: '-1001234567890',
      cooldownMs: 300_000,
      timeoutMs: 1000,
    });

    await notifier.notifyMakerAlerts([{ kind: 'SUMMARY', matrix: fullMatrix() }], AT);

    expect(lines.filter((l) => l.includes('Alert sent successfully')).length).toBeGreaterThan(0);
  });
});

describe('LA RÁFAGA: N líneas seguidas son UN resumen partido en N', () => {
  const messages = formatMakerSummaryMessages(fullMatrix(), AT);

  it('el resumen de 42 celdas no cabe en un mensaje de Telegram', () => {
    const joined = messages.join('');
    expect(messages.length).toBeGreaterThan(1);
    expect(joined.length).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT);
  });

  it('cada parte sí cabe, y las partes van numeradas', () => {
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    messages.forEach((message, index) => {
      expect(message).toContain(`(${index + 1}/${messages.length})`);
    });
  });

  it('notifyMakerAlerts las envía en un bucle: N envíos, N líneas de log, un solo mensaje lógico', async () => {
    const bodies: string[] = [];
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)).text as string);
        return { ok: true, status: 200 } as unknown as Response;
      })
    );

    const notifier = new TelegramNotifier({
      botToken: '1234567890:FAKE-NOT-REAL',
      chatId: '-1001234567890',
      cooldownMs: 300_000,
      timeoutMs: 1000,
    });

    const results = await notifier.notifyMakerAlerts(
      [{ kind: 'SUMMARY', matrix: fullMatrix() }],
      AT
    );

    // Un SUMMARY -> tantos envíos como partes, y otras tantas líneas de log.
    expect(bodies).toHaveLength(messages.length);
    expect(results.filter((r) => r.outcome === 'SENT')).toHaveLength(messages.length);
    expect(lines.filter((l) => l.includes('Alert sent successfully'))).toHaveLength(
      messages.length
    );

    // Y todas las partes son el MISMO mensaje: la misma cabecera.
    for (const body of bodies) expect(body).toContain('MIS PRECIOS PARA PUBLICAR');
  });
});

describe('y ninguna de esas líneas corresponde a una alerta de precio', () => {
  it('ningún cuerpo enviado contiene el vocabulario de las reglas', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)).text as string);
        return { ok: true, status: 200 } as unknown as Response;
      })
    );

    const notifier = new TelegramNotifier({
      botToken: '1234567890:FAKE-NOT-REAL',
      chatId: '-1001234567890',
      cooldownMs: 300_000,
      timeoutMs: 1000,
    });
    await notifier.notifyMakerAlerts([{ kind: 'SUMMARY', matrix: fullMatrix() }], AT);

    const all = bodies.join('\n');
    for (const forbidden of [
      'ALERTA DE PRECIO',
      'ALERTA P2P',
      'ALTA VOLATILIDAD',
      'Precio estratégico',
      'Umbral',
      'Estado: ACTIVADO',
    ]) {
      expect(all, forbidden).not.toContain(forbidden);
    }
  });

  it('quedan cuatro emisores, y ninguno es de reglas', () => {
    const source = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'server', 'telegramNotifier.ts'),
      'utf8'
    ) as string;

    const emitters = (source.match(/public async notify[A-Za-z]+/g) ?? []).sort();
    expect(emitters).toEqual([
      'public async notifyMakerAlerts',
      'public async notifyMarketSignals',
      'public async notifyPriceChangeDigest',
      'public async notifySystemAlert',
    ]);
  });
});
