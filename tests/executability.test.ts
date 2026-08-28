import { describe, it, expect } from 'vitest';
import {
  AMOUNT_TIERS,
  classifyLiquidity,
  evaluateAd,
  evaluateBankAmount,
  evaluateBankTiers,
} from '../server/executability.js';
import { buildOpportunity, selectBestOpportunity } from '../server/opportunityEngine.js';
import { BANK_CODE_MAP } from '../server/binanceP2PService.js';
import { NormalizedAd } from '../server/types.js';

const PROVINCIAL = BANK_CODE_MAP.PROVINCIAL.apiPayTypes;
const BANESCO = BANK_CODE_MAP.BANESCO.apiPayTypes;

/**
 * An ad with sane defaults: Banesco, 1000-100000 VES, ample liquidity.
 * Every test overrides only the field it is about.
 */
function ad(overrides: Partial<NormalizedAd> = {}): NormalizedAd {
  const payType = overrides.paymentOptions ? null : 'Banesco';
  return {
    advNo: 'adv-1',
    price: 921.0,
    minAmountVes: 1_000,
    maxAmountVes: 100_000,
    availableUsdt: 5_000,
    availableUsdtReported: 5_000,
    merchantName: 'Comerciante',
    userType: 'merchant',
    ordersCount: 120,
    finishRate: 0.98,
    paymentMethods: payType ? [payType] : [],
    paymentOptions: payType ? [{ payType, tradeMethodName: payType }] : [],
    ...overrides,
  };
}

const evalBanesco = (a: NormalizedAd, amountVes = 20_000, side: 'BUY' | 'SELL' = 'BUY') =>
  evaluateAd(a, { bank: 'BANESCO', allowedCodes: BANESCO, amountVes, side });

describe('TEST 1 - an amount inside min/max is executable', () => {
  it('accepts an amount within the ad limits', () => {
    const quote = evalBanesco(ad({ minAmountVes: 1_000, maxAmountVes: 50_000 }), 20_000);

    expect(quote.provenance).toBe('EXECUTABLE');
    expect(quote.rejection).toBeNull();
    expect(quote.bankVerification).toBe('VERIFIED');
    expect(quote.payType).toBe('Banesco');
    expect(quote.amountVes).toBe(20_000);
  });

  it('accepts the boundaries themselves', () => {
    expect(evalBanesco(ad({ minAmountVes: 20_000 }), 20_000).provenance).toBe('EXECUTABLE');
    expect(evalBanesco(ad({ maxAmountVes: 20_000 }), 20_000).provenance).toBe('EXECUTABLE');
  });
});

describe('TEST 2 - an amount below the minimum is rejected', () => {
  it('rejects and says which condition failed', () => {
    const quote = evalBanesco(ad({ minAmountVes: 30_000 }), 20_000);

    expect(quote.provenance).not.toBe('EXECUTABLE');
    expect(quote.rejection).toBe('AMOUNT_BELOW_MIN');
  });
});

describe('TEST 3 - an amount above the maximum is rejected', () => {
  it('rejects when the tier exceeds the ceiling', () => {
    const quote = evalBanesco(ad({ maxAmountVes: 50_000 }), 100_000);

    expect(quote.provenance).not.toBe('EXECUTABLE');
    expect(quote.rejection).toBe('AMOUNT_ABOVE_MAX');
  });
});

describe('TEST 4 - maxAmountVes 0 means no ceiling, not a zero ceiling', () => {
  it('accepts any amount above the minimum', () => {
    const quote = evalBanesco(ad({ maxAmountVes: 0, availableUsdtReported: 5_000 }), 100_000);
    expect(quote.provenance).toBe('EXECUTABLE');
  });
});

describe('TEST 5 - an exact payType verifies the bank', () => {
  it('carries the matched canonical code and its label', () => {
    const quote = evaluateAd(
      ad({
        paymentOptions: [{ payType: 'BBVAProvincial', tradeMethodName: 'Provincial (BBVA)' }],
      }),
      { bank: 'PROVINCIAL', allowedCodes: PROVINCIAL, amountVes: 20_000, side: 'BUY' }
    );

    expect(quote.bankVerification).toBe('VERIFIED');
    expect(quote.provenance).toBe('EXECUTABLE');
    expect(quote.payType).toBe('BBVAProvincial');
    expect(quote.paymentMethod).toBe('Provincial (BBVA)');
  });
});

describe('TEST 6 - a wrong payType is not executable', () => {
  it('rejects on the bank before looking at anything else', () => {
    const quote = evaluateAd(ad(), {
      bank: 'PROVINCIAL',
      allowedCodes: PROVINCIAL,
      amountVes: 20_000,
      side: 'BUY',
    });

    expect(quote.provenance).not.toBe('EXECUTABLE');
    expect(quote.rejection).toBe('BANK_NOT_VERIFIED');
    expect(quote.payType).toBeNull();
  });

  it('a matching label does not rescue a wrong code', () => {
    const quote = evaluateAd(
      ad({ paymentOptions: [{ payType: 'Banesco', tradeMethodName: 'Provincial (BBVA)' }] }),
      { bank: 'PROVINCIAL', allowedCodes: PROVINCIAL, amountVes: 20_000, side: 'BUY' }
    );
    expect(quote.rejection).toBe('BANK_NOT_VERIFIED');
  });
});

describe('TEST 7 - an absent payType is not executable', () => {
  it('is NOT_VERIFIABLE, never assumed to belong to the bank', () => {
    const quote = evalBanesco(ad({ paymentOptions: [], paymentMethods: [] }));

    expect(quote.bankVerification).toBe('NOT_VERIFIABLE');
    expect(quote.provenance).toBe('NOT_VERIFIABLE');
    expect(quote.rejection).toBe('BANK_NOT_VERIFIABLE');
  });

  it('a null payType with a label present is still not executable', () => {
    const quote = evalBanesco(
      ad({ paymentOptions: [{ payType: null, tradeMethodName: 'Banesco' }] })
    );
    expect(quote.provenance).toBe('NOT_VERIFIABLE');
  });
});

describe('TEST 8 - the executable BUY is the cheapest repurchase', () => {
  it('picks the lowest executable price, not the lowest ad', () => {
    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 20_000,
      buyAds: [
        ad({ advNo: 'too-small', price: 900, maxAmountVes: 5_000 }), // cheapest, unusable
        ad({ advNo: 'usable-low', price: 921.1 }),
        ad({ advNo: 'usable-high', price: 921.9 }),
      ],
      sellAds: [],
    });

    expect(cell.bestExecutableBuy?.advNo).toBe('usable-low');
    expect(cell.bestExecutableBuy?.price).toBe(921.1);
    expect(cell.buyQuotes).toHaveLength(2);
    expect(cell.buyRejections).toEqual({ AMOUNT_ABOVE_MAX: 1 });
  });
});

describe('TEST 9 - the executable SELL is the highest sale', () => {
  it('picks the highest executable price', () => {
    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 20_000,
      buyAds: [],
      sellAds: [
        ad({ advNo: 'low', price: 921.1 }),
        ad({ advNo: 'high', price: 922.4 }),
        ad({ advNo: 'highest-unusable', price: 980, minAmountVes: 500_000 }),
      ],
    });

    expect(cell.bestExecutableSell?.advNo).toBe('high');
    expect(cell.bestExecutableSell?.price).toBe(922.4);
  });
});

describe('TEST 10 - a different bank never crosses', () => {
  it('a Banesco ad is not executable for Provincial at any price', () => {
    const cell = evaluateBankAmount({
      bank: 'PROVINCIAL',
      allowedCodes: PROVINCIAL,
      amountVes: 20_000,
      buyAds: [ad({ price: 500 })], // absurdly cheap Banesco ad
      sellAds: [ad({ price: 1_500 })], // absurdly rich Banesco ad
    });

    expect(cell.bestExecutableBuy).toBeNull();
    expect(cell.bestExecutableSell).toBeNull();
    expect(cell.spreadPct).toBeNull();
  });

  it('both sides of a cell always carry the same bank', () => {
    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 20_000,
      buyAds: [ad({ advNo: 'b', price: 921 })],
      sellAds: [ad({ advNo: 's', price: 922 })],
    });

    expect(cell.bestExecutableBuy?.bank).toBe('BANESCO');
    expect(cell.bestExecutableSell?.bank).toBe(cell.bestExecutableBuy?.bank);
  });
});

describe('TEST 11 - sufficient liquidity', () => {
  it('accepts when the published volume covers the amount', () => {
    // 20000 VES / 921 = 21.71 USDT.
    const quote = evalBanesco(ad({ availableUsdtReported: 22 }), 20_000);

    expect(quote.provenance).toBe('EXECUTABLE');
    expect(quote.liquidityStatus).toBe('LIQUIDITY_VERIFIED');
    expect(quote.availableUsdt).toBe(22);
  });
});

describe('TEST 12 - insufficient liquidity', () => {
  it('rejects when the published volume falls short', () => {
    const quote = evalBanesco(ad({ availableUsdtReported: 21 }), 20_000);

    expect(quote.provenance).not.toBe('EXECUTABLE');
    expect(quote.rejection).toBe('LIQUIDITY_INSUFFICIENT');
    expect(quote.liquidityStatus).toBe('LIQUIDITY_VERIFIED'); // the fact IS known
  });

  it('a published zero is a fact about no liquidity', () => {
    const quote = evalBanesco(ad({ availableUsdtReported: 0 }), 20_000);

    expect(quote.liquidityStatus).toBe('LIQUIDITY_ZERO');
    expect(quote.rejection).toBe('LIQUIDITY_INSUFFICIENT');
  });
});

describe('TEST 13 - absent liquidity is NOT_VERIFIABLE, never invented', () => {
  it('does not treat an unpublished volume as zero, nor as enough', () => {
    const quote = evalBanesco(ad({ availableUsdtReported: null }), 20_000);

    expect(quote.liquidityStatus).toBe('LIQUIDITY_NOT_VERIFIABLE');
    expect(quote.provenance).toBe('NOT_VERIFIABLE');
    expect(quote.rejection).toBe('LIQUIDITY_NOT_VERIFIABLE');
    expect(quote.availableUsdt).toBeNull(); // no fabricated volume
  });

  it('distinguishes the three liquidity states', () => {
    expect(classifyLiquidity(null)).toBe('LIQUIDITY_NOT_VERIFIABLE');
    expect(classifyLiquidity(0)).toBe('LIQUIDITY_ZERO');
    expect(classifyLiquidity(10)).toBe('LIQUIDITY_VERIFIED');
  });

  it('an unverifiable volume never reaches bestExecutable', () => {
    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 20_000,
      buyAds: [ad({ advNo: 'unknown-vol', price: 900, availableUsdtReported: null })],
      sellAds: [],
    });

    expect(cell.bestExecutableBuy).toBeNull();
    expect(cell.buyRejections).toEqual({ LIQUIDITY_NOT_VERIFIABLE: 1 });
  });
});

describe('TEST 14 - no executable ad yields null, never a fallback', () => {
  it('returns null on both sides with an explicit reason', () => {
    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 100_000,
      buyAds: [ad({ price: 921, maxAmountVes: 5_000 })],
      sellAds: [],
    });

    expect(cell.bestExecutableBuy).toBeNull();
    expect(cell.bestExecutableSell).toBeNull();
    expect(cell.spreadPct).toBeNull();
    expect(cell.buyReason).toContain('ejecutable');
    expect(cell.sellReason).toContain('no devolvio anuncios');
  });

  it('never substitutes a median, a raw best or a suggested price', () => {
    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 100_000,
      buyAds: [ad({ price: 921, maxAmountVes: 5_000 }), ad({ price: 922, maxAmountVes: 5_000 })],
      sellAds: [],
    });

    expect(cell.bestExecutableBuy).toBeNull();
    expect(cell.buyQuotes).toHaveLength(0);
  });
});

describe('TEST 15 - an extreme price at an unverified bank never enters', () => {
  it('ignores the price entirely when the bank cannot be verified', () => {
    const cell = evaluateBankAmount({
      bank: 'PROVINCIAL',
      allowedCodes: PROVINCIAL,
      amountVes: 20_000,
      buyAds: [],
      sellAds: [ad({ advNo: 'extreme', price: 980, paymentOptions: [], paymentMethods: [] })],
    });

    expect(cell.bestExecutableSell).toBeNull();
    expect(cell.sellRejections).toEqual({ BANK_NOT_VERIFIABLE: 1 });
  });
});

describe('TEST 16 + PRUEBA ESPECIAL - the original 980 bug', () => {
  /*
   * The production incident, at the executability layer.
   *
   * BUY around 919-922, SELL around 921, plus ONE isolated ad at 980 whose
   * limits do not admit the amount. The 980 stays visible as a RAW ad; it
   * must not become VENTA = 980 for any executable operation.
   */
  const buyBook = [919.0, 920.2, 921.4, 922.0].map((price, i) =>
    ad({ advNo: `buy-${i}`, price, availableUsdtReported: 1_000 })
  );
  const sellBook = [
    ...[920.9, 921.2, 921.5].map((price, i) =>
      ad({ advNo: `sell-${i}`, price, availableUsdtReported: 1_000 })
    ),
    // The outlier: real, published, and not executable at 20K.
    ad({
      advNo: 'outlier-980',
      price: 980,
      minAmountVes: 500_000,
      maxAmountVes: 900_000,
      availableUsdtReported: 1_000,
    }),
  ];

  it('does not let the 980 become the sale price', () => {
    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 20_000,
      buyAds: buyBook,
      sellAds: sellBook,
    });

    expect(cell.bestExecutableSell?.price).toBe(921.5);
    expect(cell.bestExecutableSell?.advNo).not.toBe('outlier-980');
    expect(cell.bestExecutableBuy?.price).toBe(919);
    // ((921.5 - 919) / 919) * 100
    expect(cell.spreadPct).toBeCloseTo(0.27, 2);
    expect(cell.spreadPct).toBeLessThan(1);
  });

  it('keeps the 980 visible as a rejection rather than hiding it', () => {
    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 20_000,
      buyAds: buyBook,
      sellAds: sellBook,
    });

    expect(cell.sellRejections).toEqual({ AMOUNT_BELOW_MIN: 1 });
  });

  it('uses the 980 only where it is genuinely executable', () => {
    // At 600K VES the outlier's own limits DO admit the amount, and the
    // others do not. Executability is a property of the operation, not a
    // blanket ban on a price.
    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 600_000,
      buyAds: buyBook,
      sellAds: sellBook,
    });

    expect(cell.bestExecutableSell?.advNo).toBe('outlier-980');
    expect(cell.bestExecutableSell?.price).toBe(980);
  });
});

describe('TEST 17 / 18 - same bank pairs, different banks never do', () => {
  const banescoAd = (o: Partial<NormalizedAd>) => ad(o);
  const provincialAd = (o: Partial<NormalizedAd>) =>
    ad({
      ...o,
      paymentOptions: [{ payType: 'BBVAProvincial', tradeMethodName: 'Provincial (BBVA)' }],
      paymentMethods: ['Provincial (BBVA)'],
    });

  it('TEST 17: same bank, same amount, both sides executable', () => {
    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 20_000,
      buyAds: [banescoAd({ advNo: 'b', price: 919 })],
      sellAds: [banescoAd({ advNo: 's', price: 921.5 })],
    });

    expect(cell.bestExecutableBuy?.bank).toBe('BANESCO');
    expect(cell.bestExecutableSell?.bank).toBe('BANESCO');
    expect(cell.spreadPct).not.toBeNull();
  });

  it('TEST 18: a cheap Provincial BUY cannot pair with a rich Banesco SELL', () => {
    // The artificial opportunity: 500 vs 1500 would look like +200%.
    const cell = evaluateBankAmount({
      bank: 'PROVINCIAL',
      allowedCodes: PROVINCIAL,
      amountVes: 20_000,
      buyAds: [provincialAd({ advNo: 'p-buy', price: 500 })],
      sellAds: [banescoAd({ advNo: 'b-sell', price: 1_500 })],
    });

    expect(cell.bestExecutableBuy?.price).toBe(500); // Provincial, verified
    expect(cell.bestExecutableSell).toBeNull(); // Banesco cannot enter
    expect(cell.spreadPct).toBeNull(); // so no spread exists
  });
});

describe('TEST 19 - every amount tier is produced', () => {
  it('covers 10K/20K/30K/40K/50K/100K from a single captured book', () => {
    const tiers = evaluateBankTiers({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      buyAds: [ad({ price: 919, minAmountVes: 1_000, maxAmountVes: 40_000 })],
      sellAds: [ad({ price: 921.5, minAmountVes: 1_000, maxAmountVes: 40_000 })],
    });

    expect(Object.keys(tiers)).toEqual(['10K', '20K', '30K', '40K', '50K', '100K']);
    expect(tiers['40K'].bestExecutableBuy?.price).toBe(919);
    // 50K and 100K exceed the ad's ceiling: null, with a reason, no fallback.
    expect(tiers['50K'].bestExecutableBuy).toBeNull();
    expect(tiers['100K'].bestExecutableBuy).toBeNull();
    expect(tiers['100K'].buyReason).toContain('ejecutable');
  });

  it('the tier list matches the bank matrix tiers', () => {
    expect(AMOUNT_TIERS.map((t) => t.val)).toEqual([10_000, 20_000, 30_000, 40_000, 50_000, 100_000]);
  });
});

describe('determinism', () => {
  it('breaks a price tie by advNo, so the same book gives the same quote', () => {
    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 20_000,
      buyAds: [ad({ advNo: 'zzz', price: 919 }), ad({ advNo: 'aaa', price: 919 })],
      sellAds: [],
    });

    expect(cell.bestExecutableBuy?.advNo).toBe('aaa');
  });

  it('the spread divides by the repurchase price and keeps its sign', () => {
    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 20_000,
      buyAds: [ad({ advNo: 'b', price: 941 })],
      sellAds: [ad({ advNo: 's', price: 918 })],
    });

    expect(cell.spreadPct).toBeCloseTo(((918 - 941) / 941) * 100, 2);
    expect(cell.spreadPct!).toBeLessThan(0);
  });
});

/**
 * LA SEGUNDA PIERNA DEBE PODER VENDER LOS USDT QUE COMPRÓ LA PRIMERA.
 *
 * THE FALSE POSITIVE THIS PINS
 *
 * The operation is VES -> USDT -> VES. Both legs used to be checked against
 * their own price, so the seller was verified for `amountVes / sellPrice` when
 * the quantity actually being sold is `amountVes / buyPrice`. An opportunity
 * requires sellPrice > buyPrice, so the second number is ALWAYS larger and the
 * check was ALWAYS too lenient - by exactly the margin. The more profitable
 * the operation looked, the more liquidity went unverified.
 *
 * Units are kept apart on purpose throughout:
 *   amountVes    the VES capital of the operation
 *   requiredUsdt the USDT the leg must move
 *   available    the USDT the ad published
 */
describe('liquidez de la segunda pierna', () => {
  const AMOUNT_VES = 50_000;
  const BUY_PRICE = 940;
  const SELL_PRICE = 950;
  /** 50.000 / 940 = 53.191489... - what the first leg actually buys. */
  const USDT_BOUGHT = AMOUNT_VES / BUY_PRICE;

  const leg = (advNo: string, price: number, available: number): NormalizedAd =>
    ad({ advNo, price, availableUsdt: available, availableUsdtReported: available });

  const cellWith = (sellAvailable: number, buyPrice = BUY_PRICE, sellPrice = SELL_PRICE) =>
    evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: AMOUNT_VES,
      buyAds: [leg('A-buy', buyPrice, 5_000)],
      sellAds: [leg('B-sell', sellPrice, sellAvailable)],
    });

  it('la cantidad en juego es la que compra la primera pierna, no la derivada del precio de venta', () => {
    expect(USDT_BOUGHT).toBeCloseTo(53.191489, 6);
    // The number the check used to compare against, kept here so the gap is
    // visible rather than described.
    expect(AMOUNT_VES / SELL_PRICE).toBeCloseTo(52.631579, 6);
    expect(USDT_BOUGHT).toBeGreaterThan(AMOUNT_VES / SELL_PRICE);
  });

  it('CASO 1 - liquidez 53.20 USDT: suficiente, ejecutable', () => {
    const cell = cellWith(53.2);

    expect(53.2).toBeGreaterThan(USDT_BOUGHT);
    expect(cell.sellQuotes).toHaveLength(1);
    expect(cell.bestExecutableSell?.advNo).toBe('B-sell');
    expect(buildOpportunity(cell)).not.toBeNull();
  });

  it('CASO 2 - liquidez 52.90 USDT: insuficiente, rechazada', () => {
    /*
     * THE EXACT FALSE POSITIVE. 52.90 clears the old check (52.6316) and fails
     * the real requirement (53.1915), so this cell used to report EXECUTABLE
     * for an operation that could only partially fill.
     */
    const cell = cellWith(52.9);

    expect(52.9).toBeGreaterThan(AMOUNT_VES / SELL_PRICE); // passed the old check
    expect(52.9).toBeLessThan(USDT_BOUGHT); // fails the real one
    expect(cell.sellQuotes).toHaveLength(0);
    expect(cell.sellRejections.LIQUIDITY_INSUFFICIENT).toBe(1);
    expect(cell.bestExecutableSell).toBeNull();
    expect(buildOpportunity(cell)).toBeNull();
  });

  it('CASO 3 - margen cero: el comportamiento no cambia', () => {
    // Both legs at 950: the quantities coincide, so nothing about the
    // liquidity check moves. There is simply no opportunity.
    const cell = cellWith(60, 950, 950);

    expect(AMOUNT_VES / 950).toBeCloseTo(52.631579, 6);
    expect(cell.buyQuotes).toHaveLength(1);
    expect(cell.sellQuotes).toHaveLength(1);
    expect(cell.spreadPct).toBe(0);
    // Break-even is not an opportunity, and never was.
    expect(buildOpportunity(cell)?.marginPct).toBe(0);
  });

  it('CASO 4 - pérdida: sigue sin ser una oportunidad', () => {
    const cell = cellWith(60, 950, 940);

    expect(cell.spreadPct as number).toBeLessThan(0);
    const opportunity = buildOpportunity(cell);
    expect(opportunity?.marginPct).toBeLessThan(0);
    expect(selectBestOpportunity(opportunity ? [opportunity] : [])).toBeNull();
  });

  it('CASO 5 - a más margen, más USDT debe soportar la segunda pierna', () => {
    /*
     * The requirement is amountVes / buyPrice and does not depend on the sell
     * price at all - so a cheaper purchase, which is what widens the margin,
     * buys more USDT and demands more of the seller. Measured across three
     * buy prices with the sell price held at 950.
     */
    const measured = [960, 940, 900].map((buyPrice) => ({
      buyPrice,
      marginPct: ((SELL_PRICE - buyPrice) / buyPrice) * 100,
      requiredUsdt: AMOUNT_VES / buyPrice,
    }));

    expect(measured[0].marginPct).toBeLessThan(measured[1].marginPct);
    expect(measured[1].marginPct).toBeLessThan(measured[2].marginPct);
    expect(measured[0].requiredUsdt).toBeLessThan(measured[1].requiredUsdt);
    expect(measured[1].requiredUsdt).toBeLessThan(measured[2].requiredUsdt);

    // And the engine enforces it: a seller holding 53.19 covers a 940 purchase
    // and not a 900 one, on the same 50.000 VES.
    expect(cellWith(53.2, 940).sellQuotes).toHaveLength(1);
    expect(cellWith(53.2, 900).sellQuotes).toHaveLength(0);
    expect(AMOUNT_VES / 900).toBeCloseTo(55.555556, 6);
  });

  it('el precio de venta NO participa en el tamaño exigido a la segunda pierna', () => {
    // Same purchase, two very different sell prices: the requirement is the
    // same 53.19 USDT in both, because that is what was bought.
    const dearer = cellWith(53.19, BUY_PRICE, 1_200);
    const cheaper = cellWith(53.19, BUY_PRICE, 941);

    // 53.19 sits just below 53.191489 and is rejected either way.
    expect(dearer.sellQuotes).toHaveLength(0);
    expect(cheaper.sellQuotes).toHaveLength(0);
  });

  it('evaluar un anuncio aislado sigue midiéndose contra su propio precio', () => {
    /*
     * evaluateAd without a stated requirement is a standalone question - "can
     * this one ad move this amount" - and that is what a first leg needs. The
     * override exists only for the caller that already knows the other price.
     */
    const standalone = evaluateAd(leg('solo', SELL_PRICE, 52.7), {
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: AMOUNT_VES,
      side: 'SELL',
    });
    expect(standalone.provenance).toBe('EXECUTABLE');

    const paired = evaluateAd(leg('solo', SELL_PRICE, 52.7), {
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: AMOUNT_VES,
      side: 'SELL',
      requiredUsdt: USDT_BOUGHT,
    });
    expect(paired.rejection).toBe('LIQUIDITY_INSUFFICIENT');
  });
});
