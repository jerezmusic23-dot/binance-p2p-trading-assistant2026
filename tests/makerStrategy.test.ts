/**
 * MAKER SEMANTICS — the direction of every arrow, pinned.
 *
 * This suite exists because the project spent its first life answering the
 * taker's question ("can I trade against these ads?") when the operator is a
 * MAKER who publishes ads. Every assertion here is about direction: which
 * listing a side reads, which end of it leads, and which way I step to win.
 * Get any one of them backwards and the robot advises the operator to publish
 * the worst price on the board.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAKER_CONFIG,
  analyseMakerSide,
  deriveTick,
  estimatePosition,
  listingForMakerSide,
  makerSideDefinition,
  normalizeBinanceAdForMakerStrategy,
  readMakerConfig,
} from '../server/makerStrategy.js';
import { makeNormalizedAd } from './helpers/fixtures.js';
import type { NormalizedAd } from '../server/types.js';

const BANESCO = ['Banesco'];
const AT = 1_756_000_000_000;

function ad(price: number, overrides: Partial<NormalizedAd> = {}): NormalizedAd {
  return { ...makeNormalizedAd(price), ...overrides };
}

describe('the side definitions', () => {
  it('reads the SELL listing when I want to BUY USDT', () => {
    const d = makerSideDefinition('MAKER_BUY');
    expect(d.myAction).toBe('COMPRO USDT');
    expect(d.iHave).toBe('VES');
    expect(d.listingTradeType).toBe('SELL');
    expect(d.competitorsAre).toBe('compradores de USDT');
    expect(d.leaderIs).toBe('HIGHEST');
    expect(d.beatDirection).toBe('UP');
  });

  it('reads the BUY listing when I want to SELL USDT', () => {
    const d = makerSideDefinition('MAKER_SELL');
    expect(d.myAction).toBe('VENDO USDT');
    expect(d.iHave).toBe('USDT');
    expect(d.listingTradeType).toBe('BUY');
    expect(d.competitorsAre).toBe('vendedores de USDT');
    expect(d.leaderIs).toBe('LOWEST');
    expect(d.beatDirection).toBe('DOWN');
  });

  it('sends each side to the MIRROR listing, never its own name', () => {
    expect(listingForMakerSide('MAKER_BUY')).toBe('SELL');
    expect(listingForMakerSide('MAKER_SELL')).toBe('BUY');
  });
});

describe('normalizeBinanceAdForMakerStrategy', () => {
  const params = {
    side: 'MAKER_BUY' as const,
    bankAllowedCodes: BANESCO,
    amountVes: 10_000,
    capturedAt: AT,
  };

  it('keeps the provenance an operator needs to audit a recommendation', () => {
    const c = normalizeBinanceAdForMakerStrategy(ad(940), params);
    expect(c.relevant).toBe(true);
    expect(c).toMatchObject({
      advNo: 'adv-940',
      price: 940,
      listingTradeType: 'SELL',
      payType: 'Banesco',
      minAmountVes: 1000,
      maxAmountVes: 50_000,
      availableUsdt: 100,
      capturedAt: AT,
    });
  });

  it('counts a rival I could never trade with: it still sits ahead of me', () => {
    // Zero published volume makes an ad unexecutable for a taker. It changes
    // nothing about the queue: the counterparty still sees it before me.
    const c = normalizeBinanceAdForMakerStrategy(
      ad(940, { availableUsdt: 0, availableUsdtReported: 0 }),
      params
    );
    expect(c.relevant).toBe(true);
    expect(c.availableUsdt).toBe(0);
  });

  it('separates "no canonical code at all" from "code did not match"', () => {
    const unverifiable = normalizeBinanceAdForMakerStrategy(
      ad(940, { paymentOptions: [{ payType: null, tradeMethodName: 'Pago Móvil' }] }),
      params
    );
    expect(unverifiable.irrelevanceReason).toBe('BANK_NOT_VERIFIABLE');

    const mismatched = normalizeBinanceAdForMakerStrategy(
      ad(940, { paymentOptions: [{ payType: 'Mercantil', tradeMethodName: 'Mercantil' }] }),
      params
    );
    expect(mismatched.irrelevanceReason).toBe('BANK_NOT_MATCHED');
  });

  it('drops rivals whose own limits exclude this amount', () => {
    const below = normalizeBinanceAdForMakerStrategy(ad(940, { minAmountVes: 20_000 }), params);
    expect(below.irrelevanceReason).toBe('AMOUNT_BELOW_THEIR_MIN');

    const above = normalizeBinanceAdForMakerStrategy(ad(940, { maxAmountVes: 5_000 }), params);
    expect(above.irrelevanceReason).toBe('AMOUNT_ABOVE_THEIR_MAX');
  });

  it('excludes my own merchant when, and only when, it is configured', () => {
    const mine = ad(940, { merchantName: 'MI_TIENDA' });
    expect(normalizeBinanceAdForMakerStrategy(mine, params).relevant).toBe(true);

    const excluded = normalizeBinanceAdForMakerStrategy(mine, {
      ...params,
      config: { ...DEFAULT_MAKER_CONFIG, excludeMerchants: ['MI_TIENDA'] },
    });
    expect(excluded.irrelevanceReason).toBe('EXCLUDED_MERCHANT');
  });
});

describe('the shipped configuration', () => {
  it('ships with no merchant excluded and competing against everyone', () => {
    expect(DEFAULT_MAKER_CONFIG.excludeMerchants).toEqual([]);
    expect(DEFAULT_MAKER_CONFIG.publisherFilter).toBe('ALL');
  });

  it('leaves the exclusion unconfigured when the env says nothing', () => {
    expect(readMakerConfig({}).excludeMerchants).toEqual([]);
    expect(readMakerConfig({ MAKER_EXCLUDE_MERCHANTS: '  ' }).excludeMerchants).toEqual([]);
  });

  it('reads an exclusion list when one is supplied', () => {
    const c = readMakerConfig({ MAKER_EXCLUDE_MERCHANTS: 'MI_TIENDA, OTRO ' });
    expect(c.excludeMerchants).toEqual(['MI_TIENDA', 'OTRO']);
  });

  it('falls back to ALL for an unrecognised publisher filter', () => {
    expect(readMakerConfig({ MAKER_PUBLISHER_FILTER: 'nonsense' }).publisherFilter).toBe('ALL');
    expect(readMakerConfig({ MAKER_PUBLISHER_FILTER: 'merchant_only' }).publisherFilter).toBe(
      'MERCHANT_ONLY'
    );
  });
});

describe('deriveTick', () => {
  it('derives the step from the decimals the book actually quotes', () => {
    expect(deriveTick([940.0, 939.5])).toBe(0.1);
    expect(deriveTick([940.01, 939.5])).toBe(0.01);
    expect(deriveTick([940.001])).toBe(0.001);
  });

  it('refuses to guess when no ad in the book quotes a decimal', () => {
    // Binance sends "940.00"; parsing leaves 940 and the precision is gone.
    // Assuming 0.01 invents it; assuming 1 would advise outbidding a 940.00
    // leader with 941.00. Neither is observable, so neither is returned.
    expect(deriveTick([940, 939])).toBeNull();
    expect(deriveTick([])).toBeNull();
  });
});

describe('analyseMakerSide — MI COMPRA DE USDT', () => {
  const ads = [ad(938.75), ad(940), ad(939)];
  const analysis = analyseMakerSide({
    side: 'MAKER_BUY',
    bank: 'Banesco',
    amountVes: 10_000,
    ads,
    bankAllowedCodes: BANESCO,
    capturedAt: AT,
  });

  it('leads with the HIGHEST bid: the buyer paying most wins the seller', () => {
    expect(analysis.leaderPrice).toBe(940);
    expect(analysis.secondPrice).toBe(939);
    expect(analysis.thirdPrice).toBe(938.75);
  });

  it('beats the leader by stepping UP exactly one tick', () => {
    // The operator's own example: leader 940.00 -> I publish 940.01.
    expect(analysis.tickProvenance).toBe('OBSERVED');
    expect(analysis.tick).toBe(0.01);
    expect(analysis.priceToBeFirst).toBe(940.01);
  });

  it('measures the gap behind the leader without absolute values', () => {
    expect(analysis.ladder.map((e) => e.deltaFromLeader)).toEqual([0, 1, 1.25]);
  });
});

describe('analyseMakerSide — MI VENTA DE USDT', () => {
  const ads = [ad(947.25), ad(945), ad(946)];
  const analysis = analyseMakerSide({
    side: 'MAKER_SELL',
    bank: 'Banesco',
    amountVes: 10_000,
    ads,
    bankAllowedCodes: BANESCO,
    capturedAt: AT,
  });

  it('leads with the LOWEST ask: the seller charging least wins the buyer', () => {
    expect(analysis.leaderPrice).toBe(945);
    expect(analysis.secondPrice).toBe(946);
    expect(analysis.thirdPrice).toBe(947.25);
  });

  it('beats the leader by stepping DOWN exactly one tick', () => {
    // The operator's own example: leader 945.00 -> I publish 944.99.
    expect(analysis.priceToBeFirst).toBe(944.99);
  });
});

describe('the price step comes from the whole listing, not this bank\'s slice', () => {
  const params = {
    side: 'MAKER_BUY' as const,
    bank: 'Banesco',
    amountVes: 10_000,
    bankAllowedCodes: BANESCO,
    capturedAt: AT,
  };

  it('learns the step from an ad of another bank when mine quote round numbers', () => {
    const otherBank = ad(944.75, {
      paymentOptions: [{ payType: 'Mercantil', tradeMethodName: 'Mercantil' }],
    });
    const analysis = analyseMakerSide({ ...params, ads: [ad(940), ad(939), otherBank] });
    expect(analysis.competitors).toBe(2);
    expect(analysis.tick).toBe(0.01);
    expect(analysis.priceToBeFirst).toBe(940.01);
  });

  it('withholds the price rather than guessing when nothing quotes decimals', () => {
    const analysis = analyseMakerSide({ ...params, ads: [ad(940), ad(939)] });
    expect(analysis.leaderPrice).toBe(940);
    expect(analysis.tickProvenance).toBe('NOT_VERIFIABLE');
    expect(analysis.priceToBeFirst).toBeNull();
    expect(analysis.reason).toContain('paso de precio');
  });
});

describe('analyseMakerSide — when there is nothing to price against', () => {
  it('states the absence instead of inventing a leader', () => {
    const analysis = analyseMakerSide({
      side: 'MAKER_BUY',
      bank: 'Banesco',
      amountVes: 10_000,
      ads: [],
      bankAllowedCodes: BANESCO,
      capturedAt: AT,
    });
    expect(analysis.leaderPrice).toBeNull();
    expect(analysis.priceToBeFirst).toBeNull();
    expect(analysis.reason).toContain('no devolvió anuncios');
  });

  it('reports why every returned ad was discarded', () => {
    const analysis = analyseMakerSide({
      side: 'MAKER_BUY',
      bank: 'Banesco',
      amountVes: 10_000,
      ads: [ad(940, { minAmountVes: 90_000 }), ad(939, { minAmountVes: 90_000 })],
      bankAllowedCodes: BANESCO,
      capturedAt: AT,
    });
    expect(analysis.competitors).toBe(0);
    expect(analysis.irrelevanceTally.AMOUNT_BELOW_THEIR_MIN).toBe(2);
    expect(analysis.leaderPrice).toBeNull();
  });
});

describe('estimatePosition', () => {
  const analysis = analyseMakerSide({
    side: 'MAKER_BUY',
    bank: 'Banesco',
    amountVes: 10_000,
    ads: [ad(940), ad(939), ad(938.75)],
    bankAllowedCodes: BANESCO,
    capturedAt: AT,
  });

  it('counts only the rivals quoting better than me', () => {
    expect(estimatePosition(940.01, analysis)).toBe(1);
    expect(estimatePosition(939.5, analysis)).toBe(2);
    expect(estimatePosition(937, analysis)).toBe(4);
  });
});

describe('BUG: the ladder must never be capped below the depth the operator asked for', () => {
  it('keeps 20 competitors, not the 3 the taker matrix used to keep', () => {
    const many = Array.from({ length: 30 }, (_, i) => ad(900.25 + i));
    const analysis = analyseMakerSide({
      side: 'MAKER_BUY',
      bank: 'Banesco',
      amountVes: 10_000,
      ads: many,
      bankAllowedCodes: BANESCO,
      capturedAt: AT,
    });
    expect(analysis.competitors).toBe(30);
    expect(analysis.ladder).toHaveLength(20);
    expect(analysis.ladder[0].price).toBe(929.25);
  });
});
