/**
 * WHAT THE OPERATOR READS ON THEIR PHONE.
 *
 * These messages are the product. The operator acts on them without opening
 * the dashboard, so every number in them must be one they can retype into the
 * Binance ad form, and every number that is unknown must say so in words.
 */

import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_MESSAGE_LIMIT,
  formatMakerPriceChangeMessage,
  formatMakerSummaryMessages,
} from '../server/telegramNotifier.js';
import { buildMakerMatrix } from '../server/makerMatrix.js';
import { DEFAULT_MAKER_CONFIG } from '../server/makerStrategy.js';
import { makeNormalizedAd } from './helpers/fixtures.js';
import type { NormalizedAd } from '../server/types.js';

const AT = 1_756_000_000_000;

function ad(price: number, overrides: Partial<NormalizedAd> = {}): NormalizedAd {
  return { ...makeNormalizedAd(price), advNo: `adv-${price}`, ...overrides };
}

const CENTS_WITNESS = ad(900.25, {
  paymentOptions: [{ payType: 'Provincial', tradeMethodName: 'Provincial' }],
});

function cellFor(myBuyRivals: NormalizedAd[], mySellRivals: NormalizedAd[]) {
  return buildMakerMatrix({
    bankOrder: ['banesco'],
    bankDisplayNames: { banesco: 'Banesco' },
    bankAllowedCodes: { banesco: ['Banesco'] },
    amounts: [{ key: '10K', val: 10_000 }],
    listingsByTier: {
      '10K': {
        banesco: { SELL: [...myBuyRivals, CENTS_WITNESS], BUY: [...mySellRivals, CENTS_WITNESS] },
      },
    },
    failedBanksByTier: {},
    capturedAtByTier: { '10K': AT },
    capturedAt: AT,
    config: DEFAULT_MAKER_CONFIG,
    nowMs: AT + 5000,
  }).cells.banesco['10K'];
}

/** The whole matrix, built from one book per bank so the layout is exercised. */
function fullMatrix(bankCount = 7, amountCount = 6) {
  const banks = ['banesco', 'provincial', 'mercantil', 'bnc', 'bancamiga', 'venezuela', 'pagomovil']
    .slice(0, bankCount);
  const amounts = [
    { key: '10K', val: 10_000 },
    { key: '20K', val: 20_000 },
    { key: '30K', val: 30_000 },
    { key: '40K', val: 40_000 },
    { key: '50K', val: 50_000 },
    { key: '100K', val: 100_000 },
  ].slice(0, amountCount);

  const bankDisplayNames: Record<string, string> = {};
  const bankAllowedCodes: Record<string, readonly string[]> = {};
  const listingsByTier: Record<string, Record<string, { BUY: NormalizedAd[]; SELL: NormalizedAd[] }>> = {};
  const capturedAtByTier: Record<string, number> = {};

  banks.forEach((bank) => {
    bankDisplayNames[bank] = `Banco ${bank.toUpperCase()}`;
    bankAllowedCodes[bank] = ['Banesco'];
  });

  amounts.forEach((amount, ai) => {
    listingsByTier[amount.key] = {};
    capturedAtByTier[amount.key] = AT;
    banks.forEach((bank, bi) => {
      const base = 940 + bi + ai * 0.5;
      listingsByTier[amount.key][bank] = {
        SELL: [ad(base), CENTS_WITNESS],
        BUY: [ad(base + 5), CENTS_WITNESS],
      };
    });
  });

  return buildMakerMatrix({
    bankOrder: banks,
    bankDisplayNames,
    bankAllowedCodes,
    amounts,
    listingsByTier,
    failedBanksByTier: {},
    capturedAtByTier,
    capturedAt: AT,
    config: DEFAULT_MAKER_CONFIG,
    nowMs: AT + 5000,
  });
}

describe('MIS PRECIOS PARA PUBLICAR — the periodic summary', () => {
  const messages = formatMakerSummaryMessages(fullMatrix(1, 1), AT + 5000);
  const [text] = messages;

  it('leads with what to publish, never with an opportunity', () => {
    expect(text.startsWith('🟢 <b>MIS PRECIOS PARA PUBLICAR</b>')).toBe(true);
    expect(text).not.toMatch(/OPORTUNIDAD|ARBITRAJE|EJECUTABLE|EXECUTABLE/i);
  });

  it('states the capture age, the competition and the depth', () => {
    expect(text).toContain('⏱ Capturado hace 5s');
    expect(text).toContain('👥 Compitiendo contra todos los anunciantes');
    expect(text).toContain('📊 Profundidad TOP 20');
  });

  it('carries bank, amount, both prices and the margin for each cell', () => {
    expect(text).toContain('🏦 <b>Banco BANESCO</b>');
    expect(text).toContain('💰 10K');
    expect(text).toContain('🟢 Compra: <b>940.01</b>');
    expect(text).toContain('🔵 Venta: <b>944.99</b>');
    expect(text).toContain('💵 Margen: <b>+4.98 VES</b> · +0.5298%');
  });

  it('closes with the gross-margin warning, and never claims a guarantee', () => {
    expect(text).toContain('⚠️ <b>MARGEN BRUTO POTENCIAL</b>');
    expect(text).toContain('No es una operación garantizada.');
    expect(text).not.toMatch(/ganancia garantizada|arbitraje garantizado|oportunidad garantizada/i);
  });
});

describe('the summary never becomes 42 messages', () => {
  const messages = formatMakerSummaryMessages(fullMatrix(), AT + 5000);

  it('sends a handful of messages at most, not one per cell', () => {
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.length).toBeLessThan(7);
  });

  it('respects the Telegram size limit in every part', () => {
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
  });

  it('splits on bank boundaries, never mid-bank', () => {
    // Every bank heading appears exactly once across the whole sequence.
    const joined = messages.join('\n');
    for (const bank of ['BANESCO', 'PROVINCIAL', 'MERCANTIL', 'BNC', 'BANCAMIGA', 'VENEZUELA', 'PAGOMOVIL']) {
      expect(joined.match(new RegExp(`🏦 <b>Banco ${bank}</b>`, 'g'))).toHaveLength(1);
    }
  });

  it('is deterministic: the same matrix produces the same split', () => {
    const again = formatMakerSummaryMessages(fullMatrix(), AT + 5000);
    expect(again).toEqual(messages);
  });

  it('numbers the parts when there is more than one', () => {
    if (messages.length === 1) return;
    messages.forEach((message, index) => {
      expect(message).toContain(`(${index + 1}/${messages.length})`);
    });
  });

  it('carries all six amounts for every bank', () => {
    const joined = messages.join('\n');
    for (const amount of ['10K', '20K', '30K', '40K', '50K', '100K']) {
      expect(joined.match(new RegExp(`💰 ${amount}\\n`, 'g'))).toHaveLength(7);
    }
  });
});

describe('a cell with nothing to say says so in words', () => {
  /*
   * `failed` omits the book entirely, which is what actually happens: when a
   * bank query throws, refreshBankMatrix records the failure and stores no ads
   * for it, so the cell has nothing to build a recommendation from.
   */
  function stateOf(sell: NormalizedAd[], buy: NormalizedAd[], failed = false) {
    const m = buildMakerMatrix({
      bankOrder: ['banesco'],
      bankDisplayNames: { banesco: 'Banesco' },
      bankAllowedCodes: { banesco: ['Banesco'] },
      amounts: [{ key: '10K', val: 10_000 }],
      listingsByTier: failed ? { '10K': {} } : { '10K': { banesco: { SELL: sell, BUY: buy } } },
      failedBanksByTier: failed ? { '10K': new Set(['banesco']) } : {},
      capturedAtByTier: { '10K': AT },
      capturedAt: AT,
      config: DEFAULT_MAKER_CONFIG,
      nowMs: AT + 5000,
    });
    return formatMakerSummaryMessages(m, AT + 5000)[0];
  }

  it('says PRECIO NO VERIFICABLE when the step was never observed', () => {
    // Round numbers only: nothing proves the market quotes cents.
    const text = stateOf([ad(940)], [ad(945)]);
    expect(text).toContain('⚠️ PRECIO NO VERIFICABLE');
    expect(text).not.toContain('940.01');
  });

  it('says sin margen rather than showing the least-bad loss', () => {
    const text = stateOf([ad(930), CENTS_WITNESS], [ad(920), CENTS_WITNESS]);
    expect(text).toContain('⚪ Sin margen positivo');
  });

  it('says Binance did not answer rather than showing a blank', () => {
    const text = stateOf([ad(940), CENTS_WITNESS], [ad(945), CENTS_WITNESS], true);
    expect(text).toContain('⚠️ Binance no respondió');
  });
});

describe('CAMBIO DE PRECIO PARA PUBLICAR', () => {
  const cell = cellFor([ad(940.02)], [ad(945)]);
  const text = formatMakerPriceChangeMessage(
    cell,
    cell.recommendation!.recommended!,
    { buyPrice: 940.01, sellPrice: 944.99 },
    AT + 5000
  );

  it('says which price moved, from and to', () => {
    expect(text.startsWith('🔔 <b>CAMBIO DE PRECIO PARA PUBLICAR</b>')).toBe(true);
    expect(text).toContain('🏦 Banesco');
    expect(text).toContain('💰 Filtro: 10K');
    expect(text).toContain('Antes: 940.01');
    expect(text).toContain('Ahora: <b>940.03</b>');
    expect(text).toContain('Antes: 944.99');
    expect(text).toContain('Ahora: <b>944.99</b>');
  });

  it('states the new margin as MARGEN BRUTO, signed', () => {
    expect(text).toContain('📊 Nuevo margen: <b>+4.96 VES/USDT</b>');
    expect(text).toContain('MARGEN BRUTO POTENCIAL');
    expect(text).not.toMatch(/ganancia garantizada|arbitraje garantizado|oportunidad garantizada/i);
  });

  it('never speaks the arbitrage vocabulary', () => {
    expect(text).not.toMatch(/ARBITRAJE|OPORTUNIDAD|EXECUTABLE|Binance ASK|Binance BID/i);
  });
});
