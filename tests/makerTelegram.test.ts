/**
 * WHAT THE OPERATOR READS ON THEIR PHONE.
 *
 * These messages are the product. The operator acts on them without opening
 * the dashboard, so every number in them must be one they can retype into the
 * Binance ad form, and every number that is unknown must say so in words.
 */

import { describe, expect, it } from 'vitest';
import {
  formatMakerDisplacedMessage,
  formatMakerPublishMessage,
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

describe('PRECIO RECOMENDADO PARA PUBLICAR', () => {
  const cell = cellFor([ad(940)], [ad(945)]);
  const text = formatMakerPublishMessage(cell, cell.recommendation!.recommended!, AT + 5000);

  it('leads with what to do, not with what Binance calls it', () => {
    expect(text.startsWith('🟢 <b>PRECIO RECOMENDADO PARA PUBLICAR</b>')).toBe(true);
  });

  it('gives both prices to type into the ad form', () => {
    expect(text).toContain('<b>MI COMPRA DE USDT</b> (publico: COMPRO USDT)');
    expect(text).toContain('PUBLICAR A: <b>940.01 VES</b>');
    expect(text).toContain('<b>MI VENTA DE USDT</b> (publico: VENDO USDT)');
    expect(text).toContain('PUBLICAR A: <b>944.99 VES</b>');
  });

  it('names which listing each side competes in', () => {
    expect(text).toContain('Compito contra: compradores de USDT · listado tradeType SELL');
    expect(text).toContain('Compito contra: vendedores de USDT · listado tradeType BUY');
  });

  it('names the exact ad each price steps ahead of', () => {
    expect(text).toContain('Supera al anuncio adv-940 de Comerciante (940.00 VES)');
    expect(text).toContain('Supera al anuncio adv-945 de Comerciante (945.00 VES)');
  });

  it('calls the result MARGEN BRUTO and signs it', () => {
    expect(text).toContain('MARGEN BRUTO: <b>+4.98 VES por USDT</b>');
    // The number is never labelled profit; the only mention of the word is
    // the disclaimer saying it is not one.
    expect(text).not.toMatch(/ganancia|profit/i);
    expect(text.match(/beneficio/gi)).toEqual(['beneficio']);
    expect(text).toContain('NO es beneficio neto.');
  });

  it('says the position is an estimate rather than implying certainty', () => {
    expect(text).toContain('Posición estimada: <b>1</b>');
    expect(text).toContain('La posición es una ESTIMACION');
  });

  it('states the age of the book it was derived from', () => {
    expect(text).toContain('Antiguedad del dato: 5s');
  });
});

describe('when the engine recommends a position other than the first', () => {
  const cell = cellFor([ad(945), ad(944)], [ad(945), ad(946)]);
  const text = formatMakerPublishMessage(cell, cell.recommendation!.recommended!, AT + 5000);

  it('still reports the price that would take first place', () => {
    expect(text).toContain('Precio para ser #1 comprando: <b>945.01 VES</b>');
    expect(text).toContain('Precio para ser #1 vendiendo: <b>944.99 VES</b>');
  });

  it('shows the negative margin that ruled first place out, with its sign', () => {
    expect(text).toContain('Margen en la posición 1: <b>-0.02 VES por USDT</b>');
    expect(text).toContain('PUBLICAR A: <b>944.01 VES</b>');
  });
});

describe('BUG: unknown volume must never be printed as a number', () => {
  it('says "no verificable" instead of 0 USDT queued ahead', () => {
    const cell = cellFor(
      [ad(941, { availableUsdtReported: null }), ad(940)],
      [ad(945), ad(946)]
    );
    // Position 2 sits behind an ad that published no volume.
    const pairing = cell.recommendation!.alternatives[1];
    const text = formatMakerPublishMessage(cell, pairing, AT + 5000);
    expect(text).toContain('Volumen por delante (compra): no verificable');
    expect(text).toContain('Volumen por delante (venta): <b>100.00 USDT</b>');
  });
});

describe('CAMBIO DE PRECIO', () => {
  const text = formatMakerDisplacedMessage(
    {
      bankDisplayName: 'Banesco',
      amountVes: 10_000,
      buyPrice: 940.01,
      sellPrice: 944.99,
      buyPosition: 1,
      sellPosition: 1,
    },
    { buyPosition: 3, sellPosition: 1, priceToBeFirstBuy: 942.01, priceToBeFirstSell: 944.99 },
    AT
  );

  it('says which of my announced prices moved, and where to', () => {
    expect(text.startsWith('🔔 <b>CAMBIO DE PRECIO</b>')).toBe(true);
    expect(text).toContain('MI COMPRA a 940.01 VES: posición 1 → <b>3</b>');
    expect(text).toContain('MI VENTA a 944.99 VES: posición 1 → <b>1</b>');
  });

  it('offers the price to lead again without instructing the operator to take it', () => {
    expect(text).toContain('Para ser #1 comprando: <b>942.01 VES</b>');
    expect(text).toContain('Recuperar la primera posición no siempre conviene');
  });

  it('prints an underivable price as words', () => {
    const unknown = formatMakerDisplacedMessage(
      {
        bankDisplayName: 'Banesco',
        amountVes: 10_000,
        buyPrice: 940.01,
        sellPrice: 944.99,
        buyPosition: 1,
        sellPosition: 1,
      },
      { buyPosition: 2, sellPosition: 1, priceToBeFirstBuy: null, priceToBeFirstSell: null },
      AT
    );
    expect(unknown).toContain('Para ser #1 comprando: <b>no verificable VES</b>');
  });
});
