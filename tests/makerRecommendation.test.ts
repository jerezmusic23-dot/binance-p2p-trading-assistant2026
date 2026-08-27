/**
 * THE PUBLISHED PRICE, AND THE MARGIN BETWEEN MY TWO ADS.
 *
 * The operator's worked example is pinned first and literally: a buy ladder led
 * at 940.00 and a sell ladder led at 945.00 must produce 940.01 and 944.99,
 * leaving 4.98 VES of MARGEN BRUTO per USDT.
 *
 * The rest of the suite pins the one thing the engine is allowed to decide on
 * its own - whether a pair loses money - and pins that it decides it against
 * zero and against nothing else.
 */

import { describe, expect, it } from 'vitest';
import { buildMakerRecommendation } from '../server/makerRecommendation.js';
import { makeNormalizedAd } from './helpers/fixtures.js';
import type { NormalizedAd } from '../server/types.js';

const BANESCO = ['Banesco'];
const AT = 1_756_000_000_000;

function ad(price: number, overrides: Partial<NormalizedAd> = {}): NormalizedAd {
  return { ...makeNormalizedAd(price), advNo: `adv-${price}`, ...overrides };
}

/** A cents-quoting ad, so the 0.01 step is observed rather than assumed. */
const CENTS_WITNESS = ad(900.25, {
  paymentOptions: [{ payType: 'Mercantil', tradeMethodName: 'Mercantil' }],
});

/**
 * `myBuyRivals` are the ads I compete with when I publish a BUY ad - which
 * Binance returns under tradeType=SELL. The mirror is applied here, once, so
 * every case below reads in the operator's vocabulary.
 */
function build(myBuyRivals: NormalizedAd[], mySellRivals: NormalizedAd[]) {
  return buildMakerRecommendation({
    bank: 'Banesco',
    amountVes: 10_000,
    listings: {
      SELL: [...myBuyRivals, CENTS_WITNESS],
      BUY: [...mySellRivals, CENTS_WITNESS],
    },
    bankAllowedCodes: BANESCO,
    capturedAt: AT,
  });
}

describe("the operator's worked example", () => {
  const rec = build([ad(940), ad(939), ad(938)], [ad(945), ad(946), ad(947)]);

  it('publishes one tick above the best buyer and one tick below the best seller', () => {
    expect(rec.buyAnalysis.leaderPrice).toBe(940);
    expect(rec.sellAnalysis.leaderPrice).toBe(945);
    expect(rec.priceToBeFirstBuy).toBe(940.01);
    expect(rec.priceToBeFirstSell).toBe(944.99);
  });

  it('leaves 4.98 VES per USDT of MARGEN BRUTO', () => {
    expect(rec.recommended).not.toBeNull();
    expect(rec.recommended!.position).toBe(1);
    expect(rec.recommended!.buy.price).toBe(940.01);
    expect(rec.recommended!.sell.price).toBe(944.99);
    expect(rec.recommended!.grossMarginVes).toBe(4.98);
    expect(rec.basis).toBe('FIRST_POSITION_PROFITABLE');
  });

  it('states the margin over what I pay, unrounded', () => {
    expect(rec.recommended!.grossMarginPct).toBeCloseTo((4.98 / 940.01) * 100, 12);
  });

  it('names the exact ad each published price steps ahead of', () => {
    expect(rec.recommended!.buy).toMatchObject({ beatsAdvNo: 'adv-940', beatsPrice: 940 });
    expect(rec.recommended!.sell).toMatchObject({ beatsAdvNo: 'adv-945', beatsPrice: 945 });
  });

  it('reports nothing queued ahead of a first position', () => {
    expect(rec.recommended!.buy.queueAheadUsdt).toBe(0);
    expect(rec.recommended!.sell.queueAheadUsdt).toBe(0);
  });
});

describe('when leading both ladders loses money', () => {
  // Buy leader and sell leader at the same price: being #1 on both sides means
  // paying 945.01 to sell at 944.99.
  const rec = build([ad(945), ad(944), ad(943)], [ad(945), ad(946), ad(947)]);

  it('reports the losing first position with its sign intact', () => {
    expect(rec.firstPositionPairing!.position).toBe(1);
    expect(rec.firstPositionPairing!.grossMarginVes).toBe(-0.02);
  });

  it('recommends the shallowest position that actually pays', () => {
    expect(rec.basis).toBe('DEEPER_POSITION_REQUIRED');
    expect(rec.recommended!.position).toBe(2);
    expect(rec.recommended!.buy.price).toBe(944.01);
    expect(rec.recommended!.sell.price).toBe(945.99);
    expect(rec.recommended!.grossMarginVes).toBe(1.98);
  });

  it('still reports the price to be #1, which the operator asked never to lose', () => {
    expect(rec.priceToBeFirstBuy).toBe(945.01);
    expect(rec.priceToBeFirstSell).toBe(944.99);
  });

  it('explains why it walked back instead of leading', () => {
    expect(rec.reason).toContain('posición 2');
  });

  it('reports the volume queued ahead of the recommended position', () => {
    // One ad of 100 USDT sits in front on each side.
    expect(rec.recommended!.buy.queueAheadUsdt).toBe(100);
    expect(rec.recommended!.sell.queueAheadUsdt).toBe(100);
  });
});

describe('when no depth in the capture pays', () => {
  // An inverted book: every seller is cheaper than every buyer is willing to pay.
  const rec = build([ad(930)], [ad(920)]);

  it('recommends nothing rather than the least-bad loss', () => {
    expect(rec.recommended).toBeNull();
    expect(rec.basis).toBe('NO_PROFITABLE_POSITION');
  });

  it('still shows the numbers it refused on', () => {
    expect(rec.firstPositionPairing!.grossMarginVes).toBe(-10.02);
    expect(rec.bestMarginPairing!.grossMarginVes).toBe(-10.02);
    expect(rec.reason).toContain('margen positivo');
  });
});

describe('the alternatives ladder', () => {
  const rec = build([ad(940), ad(939), ad(938)], [ad(945), ad(946), ad(947)]);

  it('offers one pair per depth the capture supports', () => {
    expect(rec.alternatives.map((p) => p.position)).toEqual([1, 2, 3]);
  });

  it('pays strictly more the deeper I sit, which is why depth needs a reason', () => {
    const margins = rec.alternatives.map((p) => p.grossMarginVes);
    expect(margins).toEqual([4.98, 6.98, 8.98]);
    expect(rec.bestMarginPairing!.position).toBe(3);
  });

  it('accumulates the volume queued ahead, position by position', () => {
    expect(rec.alternatives.map((p) => p.buy.queueAheadUsdt)).toEqual([0, 100, 200]);
  });

  it('stops at the shallower of the two ladders', () => {
    const lopsided = build([ad(940), ad(939), ad(938)], [ad(945)]);
    expect(lopsided.alternatives).toHaveLength(1);
  });
});

describe('BUG: unknown volume must never be reported as zero volume', () => {
  it('reports the queue ahead as unknown once any ad in front published none', () => {
    const rec = build(
      [ad(940, { availableUsdtReported: null }), ad(939), ad(938)],
      [ad(945), ad(946), ad(947)]
    );
    expect(rec.alternatives[0].buy.queueAheadUsdt).toBe(0);
    expect(rec.alternatives[1].buy.queueAheadUsdt).toBeNull();
    expect(rec.alternatives[1].buy.queueAheadVerifiable).toBe(false);
    expect(rec.alternatives[2].buy.queueAheadUsdt).toBeNull();
  });
});

describe('when there is no market to price against', () => {
  it('withholds both prices and names the side that is missing', () => {
    const rec = build([ad(940)], []);
    expect(rec.basis).toBe('INSUFFICIENT_DATA');
    expect(rec.recommended).toBeNull();
    expect(rec.firstPositionPairing).toBeNull();
    expect(rec.alternatives).toEqual([]);
    expect(rec.reason).toContain('MI VENTA DE USDT');
    expect(rec.reason).not.toContain('MI COMPRA DE USDT');
  });

  it('withholds the price when the capture cannot establish the step', () => {
    const rec = buildMakerRecommendation({
      bank: 'Banesco',
      amountVes: 10_000,
      listings: { SELL: [ad(940)], BUY: [ad(945)] },
      bankAllowedCodes: BANESCO,
      capturedAt: AT,
    });
    expect(rec.basis).toBe('INSUFFICIENT_DATA');
    expect(rec.reason).toContain('paso de precio');
  });
});

describe('BUG: the two listings must never be swapped', () => {
  it('reads my buy rivals from tradeType=SELL and my sell rivals from tradeType=BUY', () => {
    const rec = buildMakerRecommendation({
      bank: 'Banesco',
      amountVes: 10_000,
      // Deliberately asymmetric books, so a swap cannot pass unnoticed.
      listings: { SELL: [ad(940), CENTS_WITNESS], BUY: [ad(945), CENTS_WITNESS] },
      bankAllowedCodes: BANESCO,
      capturedAt: AT,
    });
    expect(rec.buyAnalysis.leaderPrice).toBe(940);
    expect(rec.sellAnalysis.leaderPrice).toBe(945);
    // Swapped, this margin would read -4.98 and the robot would advise a loss.
    expect(rec.recommended!.grossMarginVes).toBe(4.98);
  });
});

describe('no fixed margin threshold exists anywhere in the engine', () => {
  it('publishes a pair whose margin is one single tick', () => {
    // 0.01 VES per USDT would fail any invented "minimum 0.30%" rule. It is
    // positive, so the engine must recommend it and let the operator judge.
    const rec = build([ad(940)], [ad(940.03)]);
    expect(rec.recommended!.grossMarginVes).toBe(0.01);
    expect(rec.basis).toBe('FIRST_POSITION_PROFITABLE');
  });

  it('refuses a pair that is exactly break-even', () => {
    const rec = build([ad(940)], [ad(940.02)]);
    expect(rec.recommended).toBeNull();
    expect(rec.firstPositionPairing!.grossMarginVes).toBe(0);
  });
});
