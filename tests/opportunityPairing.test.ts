/**
 * THE TWO LEGS OF AN OPERATION ARE CHOSEN TOGETHER, OR NOT AT ALL.
 *
 * The sequential search - best BUY, then a SELL for it - produced a
 * demonstrated FALSE NEGATIVE:
 *
 *     BUY  940 -> needs 53.191489 USDT
 *     BUY  941 -> needs 53.134963 USDT
 *     SELL 950, liquidity 53.15 USDT
 *
 * 940 does not fit, and 941 was never tried, so the cell reported NO
 * OPPORTUNITY while 941 -> 950 sat there, executable and worth +0.9564%.
 *
 * The version BEFORE that had the opposite defect - it checked each leg
 * against its own price and reported pairs nobody could execute - so the fix
 * is not a revert. Every case below is either "the operation exists and must
 * be found" or "it does not exist and must not be invented", and the two are
 * tested against the same engine.
 *
 * Cases A-K are the ones the operator asked for, by their letters.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateBankAmount,
  selectExecutablePair,
  evaluateAd,
} from '../server/executability.js';
import { buildOpportunity, selectBestOpportunity } from '../server/opportunityEngine.js';
import { BANK_CODE_MAP } from '../server/binanceP2PService.js';
import type { ExecutableQuote, NormalizedAd } from '../server/types.js';

const BANESCO = BANK_CODE_MAP.BANESCO.apiPayTypes;
const PROVINCIAL = BANK_CODE_MAP.PROVINCIAL.apiPayTypes;

/** An ad at Banesco, 1.000-100.000 VES, with the stated price and volume. */
function ad(
  advNo: string,
  price: number,
  availableUsdt: number,
  overrides: Partial<NormalizedAd> = {}
): NormalizedAd {
  return {
    advNo,
    price,
    minAmountVes: 1_000,
    maxAmountVes: 100_000,
    availableUsdt,
    availableUsdtReported: availableUsdt,
    merchantName: 'Comerciante',
    userType: 'merchant',
    ordersCount: 120,
    finishRate: 0.98,
    paymentMethods: ['Banesco'],
    paymentOptions: [{ payType: 'Banesco', tradeMethodName: 'Banesco' }],
    ...overrides,
  };
}

function cell(params: {
  amountVes?: number;
  buy: NormalizedAd[];
  sell: NormalizedAd[];
  bank?: 'BANESCO' | 'PROVINCIAL';
}) {
  const bank = params.bank ?? 'BANESCO';
  return evaluateBankAmount({
    bank,
    allowedCodes: bank === 'BANESCO' ? BANESCO : PROVINCIAL,
    amountVes: params.amountVes ?? 50_000,
    buyAds: params.buy,
    sellAds: params.sell,
  });
}

const AMOUNT = 50_000;
/** What each purchase price actually obtains, on 50.000 VES. */
const usdtFor = (buyPrice: number) => AMOUNT / buyPrice;

describe('the numbers the operator gave, exactly', () => {
  it('states the three quantities the case turns on', () => {
    expect(usdtFor(940)).toBeCloseTo(53.191489, 6);
    expect(usdtFor(941)).toBeCloseTo(53.134963, 6);
    // The seller sits between them: that is the whole point.
    expect(53.15).toBeLessThan(usdtFor(940));
    expect(53.15).toBeGreaterThan(usdtFor(941));
  });
});

describe('CASO A - best BUY compatible with best SELL', () => {
  it('takes both, and reports the USDT actually traded', () => {
    const c = cell({
      buy: [ad('b940', 940, 5_000), ad('b941', 941, 5_000)],
      sell: [ad('s950', 950, 5_000)],
    });

    expect(c.pair?.buy.advNo).toBe('b940');
    expect(c.pair?.sell.advNo).toBe('s950');
    expect(c.pair?.usdtTraded).toBeCloseTo(usdtFor(940), 6);
    expect(c.pair?.spreadPct).toBeCloseTo(((950 - 940) / 940) * 100, 10);
  });
});

describe('CASO B - the best BUY does not fit, the second does', () => {
  it('THE FALSE NEGATIVE: finds 941 -> 950 where the old engine found nothing', () => {
    const c = cell({
      buy: [ad('b940', 940, 5_000), ad('b941', 941, 5_000)],
      sell: [ad('s950', 950, 53.15)],
    });

    expect(c.pair).not.toBeNull();
    expect(c.pair!.buy.advNo).toBe('b941');
    expect(c.pair!.sell.advNo).toBe('s950');
    // Executable, and profitable, and it was being thrown away.
    expect(c.pair!.usdtTraded).toBeCloseTo(53.134963, 6);
    expect(c.pair!.usdtTraded).toBeLessThanOrEqual(53.15);
    expect(c.pair!.spreadPct).toBeCloseTo(0.956429, 5);

    const op = buildOpportunity(c)!;
    expect(op.buyPrice).toBe(941);
    expect(op.sellPrice).toBe(950);
    expect(selectBestOpportunity([op])).not.toBeNull();
  });

  it('and the cheaper buy is still preferred whenever it fits', () => {
    // One hundredth more volume and 940 becomes reachable again.
    const c = cell({
      buy: [ad('b940', 940, 5_000), ad('b941', 941, 5_000)],
      sell: [ad('s950', 950, 53.2)],
    });
    expect(c.pair!.buy.advNo).toBe('b940');
  });
});

describe('CASO C - the best SELL does not fit, the second does', () => {
  it('drops to the seller who can actually absorb the purchase', () => {
    const c = cell({
      // Only one buy, so the sell side is the one that has to give way.
      buy: [ad('b940', 940, 5_000)],
      sell: [
        ad('s960', 960, 10), // richest, and far too thin
        ad('s950', 950, 5_000), // second best, and executable
      ],
    });

    expect(c.pair!.sell.advNo).toBe('s950');
    // The richer seller is still visible as the best on its side - it simply
    // cannot form an operation.
    expect(c.bestExecutableSell?.advNo).toBe('s960');
    expect(c.pairing.compatiblePairs).toBe(1);
  });
});

describe('CASO D - many candidates on both sides', () => {
  it('finds the best pair that is genuinely executable, not the best-looking one', () => {
    /*
     * The headline pair 938 -> 962 is unreachable: 962 holds 20 USDT and 938
     * obtains 53.30. Working down, the best pair that actually clears is
     * 939 -> 958, and it must beat 941 -> 958 on margin.
     */
    const c = cell({
      buy: [
        ad('b938', 938, 5_000),
        ad('b939', 939, 5_000),
        ad('b941', 941, 5_000),
        ad('b944', 944, 5_000),
      ],
      sell: [
        ad('s962', 962, 20),
        ad('s958', 958, 53.25),
        ad('s952', 952, 5_000),
      ],
    });

    expect(usdtFor(938)).toBeCloseTo(53.304904, 6);
    expect(usdtFor(939)).toBeCloseTo(53.248136, 6);

    expect(c.pair!.buy.advNo).toBe('b939');
    expect(c.pair!.sell.advNo).toBe('s958');

    // And it really is the best: brute force over every combination agrees.
    expect(bestByBruteForce(c.buyQuotes, c.sellQuotes, AMOUNT)).toEqual({
      buy: 'b939',
      sell: 's958',
    });
  });
});

describe('CASO E - no compatible pair at all', () => {
  it('reports NO OPPORTUNITY and says why, without blaming either side', () => {
    const c = cell({
      buy: [ad('b940', 940, 5_000)],
      sell: [ad('s950', 950, 10)], // nowhere near 53.19
    });

    expect(c.pair).toBeNull();
    expect(buildOpportunity(c)).toBeNull();
    expect(c.spreadPct).toBeNull();
    // Both sides DO hold executable ads; the operation is what does not exist.
    expect(c.buyReason).toBeNull();
    expect(c.sellReason).toBeNull();
    expect(c.noPairReason).toContain('ninguna pareja');
    expect(c.pairing.compatiblePairs).toBe(0);
  });
});

describe('CASO F - zero margin', () => {
  it('is not an opportunity', () => {
    const c = cell({
      buy: [ad('b950', 950, 5_000)],
      sell: [ad('s950', 950, 5_000)],
    });

    expect(c.pair).not.toBeNull();
    expect(c.spreadPct).toBe(0);
    const op = buildOpportunity(c)!;
    expect(op.marginPct).toBe(0);
    // Break-even before commission and transfer costs is a loss.
    expect(selectBestOpportunity([op])).toBeNull();
  });
});

describe('CASO G - negative margin', () => {
  it('is not an opportunity, and the sign is preserved rather than hidden', () => {
    const c = cell({
      buy: [ad('b950', 950, 5_000)],
      sell: [ad('s940', 940, 5_000)],
    });

    expect(c.spreadPct as number).toBeLessThan(0);
    const op = buildOpportunity(c)!;
    expect(op.marginPct).toBeLessThan(0);
    expect(selectBestOpportunity([op])).toBeNull();
  });

  it('never prefers the least bad loss', () => {
    const worse = buildOpportunity(
      cell({ buy: [ad('b960', 960, 5_000)], sell: [ad('s940', 940, 5_000)] })
    )!;
    const bad = buildOpportunity(
      cell({ buy: [ad('b950', 950, 5_000)], sell: [ad('s949', 949, 5_000)] })
    )!;
    expect(selectBestOpportunity([worse, bad])).toBeNull();
  });
});

describe('CASO H - wrong bank', () => {
  it('a Banesco book yields nothing for Provincial, at any price', () => {
    const c = cell({
      bank: 'PROVINCIAL',
      buy: [ad('b500', 500, 5_000)], // absurdly cheap
      sell: [ad('s1500', 1_500, 5_000)], // absurdly rich
    });

    expect(c.pair).toBeNull();
    expect(c.buyQuotes).toHaveLength(0);
    expect(c.sellQuotes).toHaveLength(0);
    expect(c.buyRejections.BANK_NOT_VERIFIED).toBe(1);
    expect(buildOpportunity(c)).toBeNull();
  });
});

describe('CASO I - wrong amount', () => {
  it('an amount outside the ad limits never becomes an operation', () => {
    const below = cell({
      amountVes: 500,
      buy: [ad('b940', 940, 5_000)],
      sell: [ad('s950', 950, 5_000)],
    });
    expect(below.pair).toBeNull();
    expect(below.buyRejections.AMOUNT_BELOW_MIN).toBe(1);

    const above = cell({
      amountVes: 500_000,
      buy: [ad('b940', 940, 5_000)],
      sell: [ad('s950', 950, 5_000)],
    });
    expect(above.pair).toBeNull();
    expect(above.buyRejections.AMOUNT_ABOVE_MAX).toBe(1);
  });

  it('maxAmountVes 0 is "no ceiling", not a zero ceiling', () => {
    const c = cell({
      amountVes: 500_000,
      buy: [ad('b940', 940, 5_000, { maxAmountVes: 0 })],
      sell: [ad('s950', 950, 5_000, { maxAmountVes: 0 })],
    });
    expect(c.pair).not.toBeNull();
  });
});

describe('CASO J - insufficient liquidity', () => {
  it('a purchase that cannot fill itself is rejected before any pairing', () => {
    const c = cell({
      buy: [ad('b940', 940, 10)], // needs 53.19, holds 10
      sell: [ad('s950', 950, 5_000)],
    });

    expect(c.buyQuotes).toHaveLength(0);
    expect(c.buyRejections.LIQUIDITY_INSUFFICIENT).toBe(1);
    expect(c.pair).toBeNull();
  });

  it('an unpublished volume is NOT_VERIFIABLE, never assumed to be enough', () => {
    const c = cell({
      buy: [ad('b940', 940, 0, { availableUsdt: null as unknown as number, availableUsdtReported: null })],
      sell: [ad('s950', 950, 5_000)],
    });

    expect(c.buyQuotes).toHaveLength(0);
    expect(c.buyRejections.LIQUIDITY_NOT_VERIFIABLE).toBe(1);
    expect(c.pair).toBeNull();
  });

  it('a seller with no published volume can never enter a pair', () => {
    const c = cell({
      buy: [ad('b940', 940, 5_000)],
      sell: [ad('s950', 950, 0, { availableUsdt: null as unknown as number, availableUsdtReported: null })],
    });

    expect(c.sellQuotes).toHaveLength(0);
    expect(c.pair).toBeNull();
  });
});

describe('CASO K - the TOP 20 limit, stated rather than hidden', () => {
  /*
   * binanceP2PService requests rows: 20 per side. An ad ranked 21st is not in
   * the book this engine ever sees, so no algorithm here can find it. That is
   * a capture limit, not a search limit, and it is reported per cell rather
   * than left to be discovered.
   */
  it('20 unusable ads and a 21st that would have worked: nothing is found', () => {
    const twenty = Array.from({ length: 20 }, (_, i) =>
      ad(`dead-${String(i).padStart(2, '0')}`, 940 + i * 0.01, 1)
    );
    const withoutTwentyFirst = cell({ buy: twenty, sell: [ad('s950', 950, 5_000)] });

    expect(withoutTwentyFirst.pairing.buyAdsSeen).toBe(20);
    expect(withoutTwentyFirst.buyQuotes).toHaveLength(0);
    expect(withoutTwentyFirst.pair).toBeNull();

    // The same book plus the ad Binance did not return.
    const withIt = cell({
      buy: [...twenty, ad('alive-21', 941, 5_000)],
      sell: [ad('s950', 950, 5_000)],
    });
    expect(withIt.pair!.buy.advNo).toBe('alive-21');
  });

  it('the cell reports how many ads it actually saw, so the cap is visible', () => {
    const c = cell({
      buy: Array.from({ length: 20 }, (_, i) => ad(`b${i}`, 940 + i, 5_000)),
      sell: Array.from({ length: 20 }, (_, i) => ad(`s${i}`, 960 - i, 5_000)),
    });

    expect(c.pairing.buyAdsSeen).toBe(20);
    expect(c.pairing.sellAdsSeen).toBe(20);
    expect(c.pairing.pairsPossible).toBe(400);
  });
});

/* ---------------------------------------------------------------------- *
 * DOMINANCE: the search is cheaper than the product, and loses nothing.
 * ---------------------------------------------------------------------- */

/** Every combination, checked jointly. The reference the fast search must match. */
function bestByBruteForce(
  buys: readonly ExecutableQuote[],
  sells: readonly ExecutableQuote[],
  amountVes: number
): { buy: string; sell: string } | null {
  let best: { buy: ExecutableQuote; sell: ExecutableQuote; margin: number } | null = null;
  for (const buy of buys) {
    for (const sell of sells) {
      const required = amountVes / buy.price;
      if ((sell.availableUsdt ?? 0) < required) continue;
      const margin = ((sell.price - buy.price) / buy.price) * 100;
      if (
        best === null ||
        margin > best.margin ||
        (margin === best.margin &&
          Math.min(buy.availableUsdt ?? 0, sell.availableUsdt ?? 0) >
            Math.min(best.buy.availableUsdt ?? 0, best.sell.availableUsdt ?? 0))
      ) {
        best = { buy, sell, margin };
      }
    }
  }
  return best === null ? null : { buy: best.buy.advNo, sell: best.sell.advNo };
}

describe('dominance', () => {
  const quote = (advNo: string, price: number, availableUsdt: number): ExecutableQuote =>
    evaluateAd(ad(advNo, price, availableUsdt), {
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: AMOUNT,
      side: 'BUY',
    });

  it('for a fixed seller, the cheapest compatible buy dominates every other', () => {
    /*
     * The proof the fast search rests on. Compatibility is
     *     available(s) >= amountVes / price(b)   <=>   price(b) >= pMin(s)
     * and margin is strictly decreasing in price(b). So among the compatible
     * buys the cheapest one has the largest margin, always.
     */
    const seller = quote('s955', 955, 53.2);
    const pMin = AMOUNT / (seller.availableUsdt ?? 1);
    expect(pMin).toBeCloseTo(939.849624, 6);

    const compatible = [940, 941, 942, 950].map((p) => quote(`b${p}`, p, 5_000));
    for (const b of compatible) expect(b.price).toBeGreaterThanOrEqual(pMin);

    const margins = compatible.map((b) => ((955 - b.price) / b.price) * 100);
    for (let i = 1; i < margins.length; i++) expect(margins[i]).toBeLessThan(margins[i - 1]);
  });

  it('examines one buy per seller, not every combination', () => {
    const buys = Array.from({ length: 20 }, (_, i) => ad(`b${i}`, 930 + i * 0.5, 5_000));
    const sells = Array.from({ length: 20 }, (_, i) => ad(`s${i}`, 960 - i * 0.5, 60));
    const c = cell({ buy: buys, sell: sells });

    expect(c.pairing.pairsPossible).toBe(400);
    // One candidate buy per seller: 20 joint checks, not 400.
    expect(c.pairing.pairsExamined).toBeLessThanOrEqual(20);
    expect(c.pairing.pairsExamined).toBeLessThan(c.pairing.pairsPossible);
  });

  it('agrees with brute force over 400 randomised books', () => {
    /*
     * The dominance argument is only worth having if it is TRUE. A seeded
     * generator builds books with awkward volumes - many sellers who can only
     * absorb part of what the cheap buys obtain - and the fast search must
     * return exactly what checking all 400 combinations returns.
     */
    let seed = 20260828;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    for (let trial = 0; trial < 400; trial++) {
      const buys = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) =>
        ad(`b${i}`, 930 + Math.round(rnd() * 3000) / 100, 5_000)
      );
      const sells = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) =>
        // Volumes straddle the 50-56 USDT band the purchases actually need.
        ad(`s${i}`, 930 + Math.round(rnd() * 4000) / 100, 50 + Math.round(rnd() * 600) / 100)
      );

      const c = cell({ buy: buys, sell: sells });
      const reference = bestByBruteForce(c.buyQuotes, c.sellQuotes, AMOUNT);

      if (reference === null) {
        expect(c.pair).toBeNull();
      } else {
        expect(c.pair).not.toBeNull();
        expect({ buy: c.pair!.buy.advNo, sell: c.pair!.sell.advNo }).toEqual(reference);
      }
    }
  });

  it('never reports a pair whose seller cannot absorb the purchase', () => {
    /*
     * The false-POSITIVE guarantee, over the same randomised books: whatever
     * the search returns, the arithmetic has to hold.
     */
    let seed = 987654321;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    let found = 0;
    for (let trial = 0; trial < 400; trial++) {
      const buys = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) =>
        ad(`b${i}`, 930 + Math.round(rnd() * 2000) / 100, 40 + Math.round(rnd() * 2000) / 100)
      );
      const sells = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) =>
        ad(`s${i}`, 930 + Math.round(rnd() * 4000) / 100, 45 + Math.round(rnd() * 1500) / 100)
      );

      const c = cell({ buy: buys, sell: sells });
      if (c.pair === null) continue;
      found += 1;

      const required = AMOUNT / c.pair.buy.price;
      expect(c.pair.usdtTraded).toBeCloseTo(required, 9);
      expect(c.pair.sell.availableUsdt!).toBeGreaterThanOrEqual(required);
      expect(c.pair.buy.availableUsdt!).toBeGreaterThanOrEqual(required);
    }
    // The sweep has to actually find operations, or it proves nothing.
    expect(found).toBeGreaterThan(50);
  });

  it('is deterministic: the same book always yields the same pair', () => {
    const buys = [ad('b-second', 940, 5_000), ad('b-first', 940, 5_000)];
    const sells = [ad('s-second', 950, 5_000), ad('s-first', 950, 5_000)];

    const a = cell({ buy: buys, sell: sells });
    const b = cell({ buy: [...buys].reverse(), sell: [...sells].reverse() });

    expect(a.pair!.buy.advNo).toBe('b-first');
    expect(a.pair!.sell.advNo).toBe('s-first');
    expect(b.pair!.buy.advNo).toBe(a.pair!.buy.advNo);
    expect(b.pair!.sell.advNo).toBe(a.pair!.sell.advNo);
  });

  it('selectExecutablePair is pure: it reports the counts it actually did', () => {
    const c = cell({
      buy: [ad('b940', 940, 5_000), ad('b941', 941, 5_000)],
      sell: [ad('s950', 950, 53.15), ad('s960', 960, 10)],
    });

    const direct = selectExecutablePair({
      buyCandidates: c.buyQuotes,
      sellCandidates: c.sellQuotes,
      amountVes: AMOUNT,
    });

    expect(direct.pair!.buy.advNo).toBe('b941');
    // s960 holds 10 USDT: no buy price in the book is high enough to need only
    // that much, so it contributes no joint check at all.
    expect(direct.pairsExamined).toBe(1);
    expect(direct.compatiblePairs).toBe(1);
  });
});

/* ---------------------------------------------------------------------- *
 * WHAT "THE BEST OPPORTUNITY" MEANS.
 *
 * The current policy - marginPct first, availableUsdt as a tie-break - is
 * examined here rather than assumed. These tests do not propose a policy: they
 * pin what the present one DOES, with the numbers, so the choice can be made
 * on evidence. Nothing below changes selectBestOpportunity.
 * ---------------------------------------------------------------------- */

describe('the selection policy, measured', () => {
  const opportunity = (params: {
    bank: string;
    amountVes: number;
    buyPrice: number;
    sellPrice: number;
    volume: number;
  }) => {
    const c = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: params.amountVes,
      buyAds: [ad('b', params.buyPrice, params.volume)],
      sellAds: [ad('s', params.sellPrice, params.volume)],
    });
    const op = buildOpportunity(c)!;
    return { ...op, bank: params.bank };
  };

  it('surplus liquidity does not make an operation worth more', () => {
    /*
     * The operator's own example: A at 3% with 50 USDT against B at 2.9% with
     * 5.000 USDT. The operation size is the TIER, and executability already
     * requires the volume to cover it - so volume beyond that requirement is
     * consumed by nothing and earns nothing. On the same 10.000 VES tier both
     * operations move the same USDT, and A simply pays more.
     */
    const a = opportunity({ bank: 'A', amountVes: 10_000, buyPrice: 940, sellPrice: 968.2, volume: 50 });
    const b = opportunity({ bank: 'B', amountVes: 10_000, buyPrice: 940, sellPrice: 967.26, volume: 5_000 });

    expect(a.marginPct).toBeGreaterThan(b.marginPct);
    expect(a.marginVes).toBeGreaterThan(b.marginVes);
    // Both move the same quantity: the extra 4.950 USDT at B does nothing.
    expect(a.amountVes).toBe(b.amountVes);
    expect(selectBestOpportunity([a, b], ['A', 'B'])!.bank).toBe('A');
  });

  it('BUT a rate ignores the size of the operation, and the tiers differ tenfold', () => {
    /*
     * THE REAL GAP, and it is not about liquidity. marginPct is a rate;
     * marginVes is money. Across tiers they disagree, and the selector ranks
     * on the rate:
     *
     *     3,00% on 10.000 VES  ->    300 VES
     *     2,90% on 100.000 VES ->  2.900 VES
     *
     * The engine currently answers "the 10.000 one". Whether that is right is
     * a decision about the operator's money, not a fact about the book, so it
     * is measured here and left to them.
     */
    const small = opportunity({ bank: 'A', amountVes: 10_000, buyPrice: 940, sellPrice: 968.2, volume: 5_000 });
    const large = opportunity({ bank: 'B', amountVes: 100_000, buyPrice: 940, sellPrice: 967.26, volume: 5_000 });

    expect(small.marginPct).toBeGreaterThan(large.marginPct);
    expect(small.marginVes).toBeLessThan(large.marginVes);
    expect(Math.round(small.marginVes)).toBe(300);
    expect(Math.round(large.marginVes)).toBe(2_900);

    // What the engine does today, stated rather than implied.
    expect(selectBestOpportunity([small, large], ['A', 'B'])!.bank).toBe('A');
  });

  it('marginVes is derived from the same two prices, never measured apart', () => {
    const op = opportunity({ bank: 'A', amountVes: 50_000, buyPrice: 940, sellPrice: 950, volume: 5_000 });
    expect(op.marginVes).toBeCloseTo((op.amountVes * op.marginPct) / 100, 9);
    expect(op.marginVes).toBeCloseTo((50_000 / 940) * (950 - 940), 9);
  });

  it('within one cell the two criteria cannot disagree', () => {
    /*
     * Inside a cell the tier is fixed, so marginVes is a positive multiple of
     * marginPct and ranking on either gives the same pair. The disagreement
     * above is strictly an ACROSS-cell question.
     */
    const c = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 50_000,
      buyAds: [ad('b940', 940, 5_000), ad('b945', 945, 5_000)],
      sellAds: [ad('s950', 950, 5_000), ad('s955', 955, 5_000)],
    });
    const op = buildOpportunity(c)!;
    expect(op.buyPrice).toBe(940);
    expect(op.sellPrice).toBe(955);
    expect(op.marginVes).toBeCloseTo((op.amountVes * op.marginPct) / 100, 9);
  });
});
