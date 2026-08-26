import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildOpportunity,
  runOpportunityEngine,
  selectBestOpportunity,
} from '../server/opportunityEngine.js';
import { evaluateBankAmount, evaluateBankTiers } from '../server/executability.js';
import { BANK_CODE_MAP } from '../server/binanceP2PService.js';
import { BankAmountExecutability, NormalizedAd, Opportunity } from '../server/types.js';

/** The engine's source with comments removed, for purity assertions. */
function readEngineCode(): string {
  return fs
    .readFileSync(path.join(process.cwd(), 'server', 'opportunityEngine.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const BANESCO = BANK_CODE_MAP.BANESCO.apiPayTypes;
const PROVINCIAL = BANK_CODE_MAP.PROVINCIAL.apiPayTypes;
const BANK_ORDER = Object.keys(BANK_CODE_MAP);

/** An ad at a bank, with sane defaults. Overrides only what a test is about. */
function ad(bank: 'BANESCO' | 'PROVINCIAL', overrides: Partial<NormalizedAd> = {}): NormalizedAd {
  const payType = bank === 'BANESCO' ? 'Banesco' : 'BBVAProvincial';
  const label = bank === 'BANESCO' ? 'Banesco' : 'Provincial (BBVA)';
  return {
    advNo: `adv-${bank}`,
    price: 921,
    minAmountVes: 1_000,
    maxAmountVes: 100_000,
    availableUsdt: 5_000,
    availableUsdtReported: 5_000,
    merchantName: 'Comerciante',
    userType: 'merchant',
    ordersCount: 120,
    finishRate: 0.98,
    paymentMethods: [label],
    paymentOptions: [{ payType, tradeMethodName: label }],
    ...overrides,
  };
}

/** A real FASE 4 cell. Executability is never re-implemented in these tests. */
function cell(params: {
  bank?: 'BANESCO' | 'PROVINCIAL';
  amountVes?: number;
  buy?: Partial<NormalizedAd>[];
  sell?: Partial<NormalizedAd>[];
}): BankAmountExecutability {
  const bank = params.bank ?? 'BANESCO';
  return evaluateBankAmount({
    bank,
    allowedCodes: bank === 'BANESCO' ? BANESCO : PROVINCIAL,
    amountVes: params.amountVes ?? 20_000,
    buyAds: (params.buy ?? []).map((o) => ad(bank, o)),
    sellAds: (params.sell ?? []).map((o) => ad(bank, o)),
  });
}

describe('TEST 1 / 2 / 21 - selection among executable quotes', () => {
  it('TEST 1 + 21: takes the LOWEST executable BUY', () => {
    const op = buildOpportunity(
      cell({
        buy: [
          { advNo: 'b919', price: 919 },
          { advNo: 'b920', price: 920 },
          { advNo: 'b921', price: 921 },
        ],
        sell: [{ advNo: 's922', price: 922 }],
      })
    );

    expect(op?.buyPrice).toBe(919);
    expect(op?.buyAdvNo).toBe('b919');
  });

  it('TEST 2 + 21: takes the HIGHEST executable SELL', () => {
    const op = buildOpportunity(
      cell({
        buy: [{ advNo: 'b919', price: 919 }],
        sell: [
          { advNo: 's920', price: 920 },
          { advNo: 's921', price: 921 },
          { advNo: 's922', price: 922 },
        ],
      })
    );

    expect(op?.sellPrice).toBe(922);
    expect(op?.sellAdvNo).toBe('s922');
  });
});

describe('TEST 3 / 4 - a rejected quote never enters', () => {
  it('TEST 3: a cheaper BUY rejected on limits does not become the price', () => {
    const op = buildOpportunity(
      cell({
        buy: [
          { advNo: 'cheap-rejected', price: 800, maxAmountVes: 5_000 },
          { advNo: 'usable', price: 919 },
        ],
        sell: [{ advNo: 's', price: 922 }],
      })
    );

    expect(op?.buyPrice).toBe(919);
    expect(op?.buyAdvNo).toBe('usable');
  });

  it('TEST 4: a richer SELL rejected on limits does not become the price', () => {
    const op = buildOpportunity(
      cell({
        buy: [{ advNo: 'b', price: 919 }],
        sell: [
          { advNo: 'rich-rejected', price: 1_200, minAmountVes: 900_000 },
          { advNo: 'usable', price: 922 },
        ],
      })
    );

    expect(op?.sellPrice).toBe(922);
  });

  it('a quote hand-marked as rejected is refused even if passed as best', () => {
    // Defensive guard: FASE 4 cannot emit this, but a future relaxation must
    // not be able to promote a rejection into an operation.
    const good = cell({ buy: [{ price: 919 }], sell: [{ price: 922 }] });
    const tampered: BankAmountExecutability = {
      ...good,
      bestExecutableSell: {
        ...good.bestExecutableSell!,
        provenance: 'REAL',
        rejection: 'AMOUNT_BELOW_MIN',
      },
    };

    expect(buildOpportunity(tampered)).toBeNull();
  });
});

describe('TEST 5 / 6 / 20 - a missing side yields null, never a fallback', () => {
  it('TEST 5: no executable BUY', () => {
    const c = cell({ buy: [{ price: 919, maxAmountVes: 5_000 }], sell: [{ price: 922 }] });

    expect(c.bestExecutableBuy).toBeNull();
    expect(buildOpportunity(c)).toBeNull();
  });

  it('TEST 6: no executable SELL', () => {
    const c = cell({ buy: [{ price: 919 }], sell: [{ price: 922, minAmountVes: 900_000 }] });

    expect(c.bestExecutableSell).toBeNull();
    expect(buildOpportunity(c)).toBeNull();
  });

  it('TEST 20: an empty book on both sides yields null', () => {
    expect(buildOpportunity(cell({ buy: [], sell: [] }))).toBeNull();
  });

  it('never substitutes a median, average, strategic, raw or suggested price', () => {
    const c = cell({ buy: [], sell: [{ price: 922 }] });
    const op = buildOpportunity(c);

    expect(op).toBeNull();
    // The cell still carries a usable SELL - it is simply not an operation.
    expect(c.bestExecutableSell?.price).toBe(922);
  });
});

describe('TEST 7 / 18 / 40 - banks never cross', () => {
  it('TEST 7 + 40: a Provincial BUY cannot pair with a Banesco SELL', () => {
    // The artificial opportunity: 500 against 1500 would read as +200%.
    const c = evaluateBankAmount({
      bank: 'PROVINCIAL',
      allowedCodes: PROVINCIAL,
      amountVes: 20_000,
      buyAds: [ad('PROVINCIAL', { advNo: 'p-buy', price: 500 })],
      sellAds: [ad('BANESCO', { advNo: 'b-sell', price: 1_500 })],
    });

    expect(c.bestExecutableBuy?.price).toBe(500);
    expect(c.bestExecutableSell).toBeNull();
    expect(buildOpportunity(c)).toBeNull();
  });

  it('TEST 35: the canonical bank is part of the identity of both legs', () => {
    const op = buildOpportunity(cell({ buy: [{ price: 919 }], sell: [{ price: 922 }] }))!;

    expect(op.bank).toBe('BANESCO');
    expect(Object.keys(BANK_CODE_MAP)).toContain(op.bank);
  });
});

describe('TEST 8 / 24 - each amount has its own Opportunity', () => {
  const tiers = evaluateBankTiers({
    bank: 'BANESCO',
    allowedCodes: BANESCO,
    buyAds: [ad('BANESCO', { advNo: 'b', price: 919, maxAmountVes: 40_000 })],
    sellAds: [ad('BANESCO', { advNo: 's', price: 922, maxAmountVes: 40_000 })],
  });

  it('TEST 8: both legs always carry the same amount', () => {
    const op = buildOpportunity(tiers['20K'])!;

    expect(op.amountVes).toBe(20_000);
    expect(tiers['20K'].bestExecutableBuy?.amountVes).toBe(20_000);
    expect(tiers['20K'].bestExecutableSell?.amountVes).toBe(20_000);
  });

  it('CASO 3: a 20K BUY and a 30K SELL are never combined', () => {
    /*
     * Structurally impossible, not merely unchecked: an Opportunity is built
     * from ONE cell, and a cell carries one amount. There is no code path
     * that can reach across two of them.
     *
     * Here the 20K cell has a BUY at 919 and the 30K cell a SELL at 980. The
     * cross would read +6.6%; each cell on its own reads what it really is.
     */
    const buyOnly20K = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 20_000,
      buyAds: [ad('BANESCO', { advNo: 'b20', price: 919, maxAmountVes: 25_000 })],
      sellAds: [ad('BANESCO', { advNo: 's30', price: 980, minAmountVes: 26_000 })],
    });
    const sellOnly30K = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 30_000,
      buyAds: [ad('BANESCO', { advNo: 'b20', price: 919, maxAmountVes: 25_000 })],
      sellAds: [ad('BANESCO', { advNo: 's30', price: 980, minAmountVes: 26_000 })],
    });

    // 20K: a BUY but no SELL. 30K: a SELL but no BUY.
    expect(buyOnly20K.bestExecutableBuy?.price).toBe(919);
    expect(buyOnly20K.bestExecutableSell).toBeNull();
    expect(sellOnly30K.bestExecutableBuy).toBeNull();
    expect(sellOnly30K.bestExecutableSell?.price).toBe(980);

    // Neither cell yields an Opportunity, and nothing pairs them.
    expect(buildOpportunity(buyOnly20K)).toBeNull();
    expect(buildOpportunity(sellOnly30K)).toBeNull();

    const result = runOpportunityEngine({
      byBank: { BANESCO: { '20K': buyOnly20K, '30K': sellOnly30K } },
      bankOrder: BANK_ORDER,
    });
    expect(result.opportunities).toEqual([]);
    expect(result.bestOpportunity).toBeNull();
  });

  it('every Opportunity carries one amount, shared by both legs', () => {
    const result = runOpportunityEngine({
      byBank: { BANESCO: tiers },
      bankOrder: BANK_ORDER,
    });

    for (const [key, opportunity] of Object.entries(result.byBank.BANESCO)) {
      if (opportunity === null) continue;
      expect(opportunity.amountVes).toBe(tiers[key].amountVes);
    }
  });

  it('TEST 24: a tier the ads cannot cover has no Opportunity of its own', () => {
    expect(buildOpportunity(tiers['40K'])).not.toBeNull();
    expect(buildOpportunity(tiers['50K'])).toBeNull();
    expect(buildOpportunity(tiers['100K'])).toBeNull();
  });
});

describe('TEST 9 / 10 / 11 / 12 / 37 / 38 - liquidity', () => {
  /*
   * FASE 4 rejects an unverifiable liquidity before a quote can become
   * EXECUTABLE, so this state is unreachable through evaluateAd today. The
   * engine still defends against it: the check is what keeps a future
   * relaxation of FASE 4 from producing a "fully verifiable" operation whose
   * capacity nobody knows.
   */
  function withLiquidity(buyLiq: number | null, sellLiq: number | null): BankAmountExecutability {
    const base = cell({ buy: [{ advNo: 'b', price: 919 }], sell: [{ advNo: 's', price: 922 }] });
    return {
      ...base,
      bestExecutableBuy: { ...base.bestExecutableBuy!, availableUsdt: buyLiq },
      bestExecutableSell: { ...base.bestExecutableSell!, availableUsdt: sellLiq },
    };
  }

  it('TEST 9: a null BUY liquidity is not fully verifiable', () => {
    const op = buildOpportunity(withLiquidity(null, 5_000))!;

    expect(op.verification).toBe('NOT_VERIFIABLE');
    expect(op.provenance).toBe('NOT_VERIFIABLE');
    expect(op.buyAvailableUsdt).toBeNull();
    expect(op.availableUsdt).toBeNull();
    expect(op.reason).toContain('recompra');
  });

  it('TEST 10: a null SELL liquidity is not fully verifiable', () => {
    const op = buildOpportunity(withLiquidity(5_000, null))!;

    expect(op.verification).toBe('NOT_VERIFIABLE');
    expect(op.sellAvailableUsdt).toBeNull();
    expect(op.availableUsdt).toBeNull();
    expect(op.reason).toContain('venta');
  });

  it('TEST 38: null is never replaced by a number', () => {
    const op = buildOpportunity(withLiquidity(null, null))!;

    expect(op.buyAvailableUsdt).toBeNull();
    expect(op.sellAvailableUsdt).toBeNull();
    expect(op.availableUsdt).toBeNull();
    expect(op.availableUsdt).not.toBe(0);
  });

  it('TEST 11: a published zero stays zero and never becomes null', () => {
    const op = buildOpportunity(withLiquidity(0, 5_000))!;

    expect(op.buyAvailableUsdt).toBe(0);
    expect(op.availableUsdt).toBe(0);
    expect(op.verification).toBe('VERIFIED'); // the fact IS established
  });

  it('TEST 12: availableUsdt is the minimum of both legs', () => {
    expect(buildOpportunity(withLiquidity(300, 900))!.availableUsdt).toBe(300);
    expect(buildOpportunity(withLiquidity(900, 300))!.availableUsdt).toBe(300);
  });

  it('TEST 37: a VERIFIED opportunity always has both liquidities known', () => {
    const op = buildOpportunity(cell({ buy: [{ price: 919 }], sell: [{ price: 922 }] }))!;

    expect(op.verification).toBe('VERIFIED');
    expect(op.buyAvailableUsdt).not.toBeNull();
    expect(op.sellAvailableUsdt).not.toBeNull();
  });

  it('FASE 4 already keeps an unverifiable liquidity out of EXECUTABLE', () => {
    const c = cell({
      buy: [{ price: 919, availableUsdtReported: null }],
      sell: [{ price: 922 }],
    });

    expect(c.bestExecutableBuy).toBeNull();
    expect(c.buyRejections).toEqual({ LIQUIDITY_NOT_VERIFIABLE: 1 });
  });
});

describe('TEST 13 / 14 / 15 / 16 / 39 - spread and margin', () => {
  const spreadOf = (buyPrice: number, sellPrice: number) =>
    buildOpportunity(
      cell({ buy: [{ advNo: 'b', price: buyPrice }], sell: [{ advNo: 's', price: sellPrice }] })
    )!;

  it('TEST 13: a favourable market gives a positive spread', () => {
    const op = spreadOf(921.0, 921.79);

    expect(op.spreadAbsolute).toBeCloseTo(0.79, 10);
    expect(op.spreadPct).toBeCloseTo(0.0858, 4); // ((921.79-921)/921)*100
    expect(op.spreadPct).toBeGreaterThan(0);
  });

  it('TEST 14 + 39: a losing market stays negative', () => {
    const op = spreadOf(941, 918);

    expect(op.spreadAbsolute).toBe(-23);
    expect(op.spreadPct).toBeCloseTo(((918 - 941) / 941) * 100, 10);
    expect(op.spreadPct).toBeLessThan(0);
    expect(op.marginPct).toBeLessThan(0);
  });

  it('TEST 15: identical prices give exactly zero', () => {
    const op = spreadOf(921, 921);

    expect(op.spreadAbsolute).toBe(0);
    expect(op.spreadPct).toBe(0);
  });

  it('TEST 16: the sign is never flattened by an absolute value', () => {
    const loss = spreadOf(941, 918);
    const gain = spreadOf(918, 941);

    // Not mirror images: each divides by its own repurchase price. What must
    // hold is that the loss stays a loss.
    expect(Math.sign(loss.spreadAbsolute)).toBe(-1);
    expect(Math.sign(loss.spreadPct)).toBe(-1);
    expect(Math.sign(gain.spreadPct)).toBe(1);
    expect(loss.spreadPct).not.toBe(Math.abs(loss.spreadPct));
  });

  it('the denominator is always the repurchase price, never the smaller price', () => {
    const op = spreadOf(941, 918);
    // With min() as the denominator this would be -2.505%.
    expect(op.spreadPct).toBeCloseTo(-2.4442, 4);
    expect(op.spreadPct).not.toBeCloseTo(((918 - 941) / 918) * 100, 4);
  });

  it('margin equals the gross spread - no cost is modelled or invented', () => {
    const op = spreadOf(921, 921.79);

    expect(op.marginAbsolute).toBe(op.spreadAbsolute);
    expect(op.marginPct).toBe(op.spreadPct);
  });
});

describe('TEST 17 / 18 / 19 / 20 (sources) - never RAW, median or strategic', () => {
  it('the prices come from the executable quotes themselves', () => {
    const c = cell({
      buy: [
        { advNo: 'b-low', price: 919 },
        { advNo: 'b-high', price: 923 },
      ],
      sell: [
        { advNo: 's-low', price: 920 },
        { advNo: 's-high', price: 922 },
      ],
    });
    const op = buildOpportunity(c)!;

    expect(op.buyPrice).toBe(c.bestExecutableBuy!.price);
    expect(op.sellPrice).toBe(c.bestExecutableSell!.price);
    // Not the median of either side (921 / 921).
    expect(op.buyPrice).not.toBe(921);
    expect(op.sellPrice).not.toBe(921);
  });

  it('the engine imports nothing that could supply a raw or strategic price', () => {
    const source = readEngineCode();

    for (const forbidden of [
      'bestBuyPrice',
      'bestSellPrice',
      'spreadPercentage',
      'strategicBuyPrice',
      'strategicSellPrice',
      'medianBuyPrice',
      'medianSellPrice',
      'Math.abs',
    ]) {
      expect(source, `must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('TEST 22 + PRUEBA OBLIGATORIA - the 980 outlier', () => {
  /*
   * Section 16 of the contract, verbatim.
   *
   * BUY Provincial:  919 / 920.2 / 921.4 / 922
   * SELL Provincial: 920.9 / 921.2 / 921.5  + one at 980 with min 500000 VES
   */
  // The BUY side accepts any of the amounts under test, so what decides the
  // 20K vs 600K outcome is the SELL outlier's own limits and nothing else.
  const buyAds = [919, 920.2, 921.4, 922].map((price, i) =>
    ad('PROVINCIAL', {
      advNo: `buy-${i}`,
      price,
      maxAmountVes: 900_000,
      availableUsdtReported: 2_000,
    })
  );
  const sellAds = [
    ...[920.9, 921.2, 921.5].map((price, i) =>
      ad('PROVINCIAL', { advNo: `sell-${i}`, price, availableUsdtReported: 2_000 })
    ),
    ad('PROVINCIAL', {
      advNo: 'outlier-980',
      price: 980,
      minAmountVes: 500_000,
      maxAmountVes: 900_000,
      availableUsdtReported: 2_000,
    }),
  ];

  const at = (amountVes: number) =>
    buildOpportunity(
      evaluateBankAmount({
        bank: 'PROVINCIAL',
        allowedCodes: PROVINCIAL,
        amountVes,
        buyAds,
        sellAds,
      })
    );

  it('TEST 21 (contract): at 20K the 980 is not the sale price', () => {
    const op = at(20_000)!;

    expect(op.sellPrice).toBe(921.5);
    expect(op.sellAdvNo).not.toBe('outlier-980');
    expect(op.buyPrice).toBe(919);
    expect(op.spreadPct).toBeCloseTo(((921.5 - 919) / 919) * 100, 10);
    expect(op.spreadPct).toBeLessThan(1);
  });

  it('TEST 22 (contract): at 600K the same 980 IS the sale price', () => {
    // The rule never bans a high price; it asks whether the ad is usable.
    const op = at(600_000)!;

    expect(op.sellAdvNo).toBe('outlier-980');
    expect(op.sellPrice).toBe(980);
  });

  it('TEST 34: the rejected 980 survives as diagnostic context', () => {
    const result = runOpportunityEngine({
      byBank: {
        PROVINCIAL: {
          '20K': evaluateBankAmount({
            bank: 'PROVINCIAL',
            allowedCodes: PROVINCIAL,
            amountVes: 20_000,
            buyAds,
            sellAds,
          }),
        },
      },
      bankOrder: BANK_ORDER,
    });

    expect(result.context.PROVINCIAL['20K'].sellRejections).toEqual({ AMOUNT_BELOW_MIN: 1 });
    expect(result.byBank.PROVINCIAL['20K']?.sellPrice).toBe(921.5);
  });
});

describe('TEST 23 - several banks produce independent opportunities', () => {
  it('keeps each bank separate', () => {
    const result = runOpportunityEngine({
      byBank: {
        BANESCO: {
          '20K': evaluateBankAmount({
            bank: 'BANESCO',
            allowedCodes: BANESCO,
            amountVes: 20_000,
            buyAds: [ad('BANESCO', { advNo: 'bb', price: 919 })],
            sellAds: [ad('BANESCO', { advNo: 'bs', price: 921 })],
          }),
        },
        PROVINCIAL: {
          '20K': evaluateBankAmount({
            bank: 'PROVINCIAL',
            allowedCodes: PROVINCIAL,
            amountVes: 20_000,
            buyAds: [ad('PROVINCIAL', { advNo: 'pb', price: 918 })],
            sellAds: [ad('PROVINCIAL', { advNo: 'ps', price: 923 })],
          }),
        },
      },
      bankOrder: BANK_ORDER,
    });

    expect(result.opportunities).toHaveLength(2);
    expect(result.byBank.BANESCO['20K']?.bank).toBe('BANESCO');
    expect(result.byBank.PROVINCIAL['20K']?.bank).toBe('PROVINCIAL');
    // Each opportunity's legs belong to its own bank only.
    expect(result.byBank.BANESCO['20K']?.buyAdvNo).toBe('bb');
    expect(result.byBank.BANESCO['20K']?.sellAdvNo).toBe('bs');
  });
});

describe('TEST 25 / 26 / 27 / 28 / 29 - BEST_OPPORTUNITY', () => {
  function op(overrides: Partial<Opportunity>): Opportunity {
    const buyPrice = overrides.buyPrice ?? 900;
    const sellPrice = overrides.sellPrice ?? 909;
    return {
      bank: 'BANESCO',
      amountVes: 20_000,
      buyPrice,
      sellPrice,
      buyAdvNo: 'b',
      sellAdvNo: 's',
      spreadAbsolute: sellPrice - buyPrice,
      spreadPct: ((sellPrice - buyPrice) / buyPrice) * 100,
      marginAbsolute: sellPrice - buyPrice,
      marginPct: ((sellPrice - buyPrice) / buyPrice) * 100,
      buyAvailableUsdt: 1_000,
      sellAvailableUsdt: 1_000,
      availableUsdt: 1_000,
      verification: 'VERIFIED',
      provenance: 'EXECUTABLE',
      reason: null,
      ...overrides,
    };
  }

  it('TEST 25: picks the highest marginPct', () => {
    const best = selectBestOpportunity(
      [op({ bank: 'BANESCO', marginPct: 0.2 }), op({ bank: 'BNC', marginPct: 0.9 })],
      BANK_ORDER
    );

    expect(best?.bank).toBe('BNC');
  });

  it('TEST 26: on equal margin, the higher liquidity wins', () => {
    const best = selectBestOpportunity(
      [
        op({ bank: 'BANESCO', marginPct: 0.5, availableUsdt: 100 }),
        op({ bank: 'BNC', marginPct: 0.5, availableUsdt: 900 }),
      ],
      BANK_ORDER
    );

    expect(best?.bank).toBe('BNC');
  });

  it('TEST 27: then the lower buyPrice', () => {
    const best = selectBestOpportunity(
      [
        op({ bank: 'BANESCO', marginPct: 0.5, availableUsdt: 100, buyPrice: 925 }),
        op({ bank: 'BNC', marginPct: 0.5, availableUsdt: 100, buyPrice: 919 }),
      ],
      BANK_ORDER
    );

    expect(best?.bank).toBe('BNC');
  });

  it('TEST 28: then the higher sellPrice', () => {
    const best = selectBestOpportunity(
      [
        op({ bank: 'BANESCO', marginPct: 0.5, availableUsdt: 100, buyPrice: 919, sellPrice: 921 }),
        op({ bank: 'BNC', marginPct: 0.5, availableUsdt: 100, buyPrice: 919, sellPrice: 925 }),
      ],
      BANK_ORDER
    );

    expect(best?.bank).toBe('BNC');
  });

  it('then the canonical bank order', () => {
    const common = { marginPct: 0.5, availableUsdt: 100, buyPrice: 919, sellPrice: 921 };
    const best = selectBestOpportunity(
      [op({ bank: 'PROVINCIAL', ...common }), op({ bank: 'BANESCO', ...common })],
      BANK_ORDER
    );

    // BANESCO precedes PROVINCIAL in BANK_CODE_MAP.
    expect(best?.bank).toBe('BANESCO');
    expect(BANK_ORDER.indexOf('BANESCO')).toBeLessThan(BANK_ORDER.indexOf('PROVINCIAL'));
  });

  it('finally the smaller amount', () => {
    const common = { bank: 'BANESCO', marginPct: 0.5, availableUsdt: 100, buyPrice: 919, sellPrice: 921 };
    const best = selectBestOpportunity(
      [op({ ...common, amountVes: 50_000 }), op({ ...common, amountVes: 10_000 })],
      BANK_ORDER
    );

    expect(best?.amountVes).toBe(10_000);
  });

  it('TEST 29: the same input always gives the same answer, in any order', () => {
    const common = { marginPct: 0.5, availableUsdt: 100, buyPrice: 919, sellPrice: 921 };
    const a = op({ bank: 'BANESCO', ...common });
    const b = op({ bank: 'PROVINCIAL', ...common });
    const c = op({ bank: 'MERCANTIL', ...common });

    const first = selectBestOpportunity([a, b, c], BANK_ORDER);
    const second = selectBestOpportunity([c, b, a], BANK_ORDER);
    const third = selectBestOpportunity([b, a, c], BANK_ORDER);

    expect(first?.bank).toBe('BANESCO');
    expect(second?.bank).toBe(first?.bank);
    expect(third?.bank).toBe(first?.bank);
  });

  it('never selects a NOT_VERIFIABLE opportunity, however wide its margin', () => {
    const best = selectBestOpportunity(
      [
        op({ bank: 'BNC', marginPct: 99, verification: 'NOT_VERIFIABLE', availableUsdt: null }),
        op({ bank: 'BANESCO', marginPct: 0.1 }),
      ],
      BANK_ORDER
    );

    expect(best?.bank).toBe('BANESCO');
  });

  it('returns null when nothing is VERIFIED', () => {
    expect(
      selectBestOpportunity([op({ verification: 'NOT_VERIFIABLE', availableUsdt: null })], BANK_ORDER)
    ).toBeNull();
    expect(selectBestOpportunity([], BANK_ORDER)).toBeNull();
  });

  it('there is no best loss - an inverted market has no best opportunity', () => {
    /*
     * This used to return the least bad loss, and Telegram announced it as
     * the operation to run. Losses stay in `opportunities` as market
     * context; they are simply never the answer to "what should I trade".
     */
    const best = selectBestOpportunity(
      [op({ bank: 'BANESCO', marginPct: -0.9 }), op({ bank: 'BNC', marginPct: -0.2 })],
      BANK_ORDER
    );

    expect(best).toBeNull();
  });

  it('break-even is not an opportunity either', () => {
    // Zero margin is a loss once commission, transfer and slippage are paid.
    expect(selectBestOpportunity([op({ marginPct: 0 })], BANK_ORDER)).toBeNull();
  });

  it('picks the only profitable one out of a losing book', () => {
    const best = selectBestOpportunity(
      [
        op({ bank: 'BANESCO', marginPct: -0.9 }),
        op({ bank: 'BNC', marginPct: 0.05 }),
        op({ bank: 'MERCANTIL', marginPct: -0.2 }),
      ],
      BANK_ORDER
    );

    expect(best?.bank).toBe('BNC');
    expect(best!.marginPct).toBeGreaterThan(0);
  });
});

describe('TEST 30 / 31 / 32 / 33 / 36 - purity of the engine', () => {
  // Comments stripped: these assertions are about what the module DOES, not
  // about what its documentation is allowed to mention.
  const source = readEngineCode();

  it('TEST 33: does not read the clock', () => {
    expect(source).not.toContain('Date.now');
    expect(source).not.toMatch(/new Date\(/);
  });

  it('TEST 31: does not reach the network or the disk', () => {
    expect(source).not.toContain('fetch(');
    expect(source).not.toMatch(/from 'node:fs'/);
    expect(source).not.toContain('fs.');
    expect(source).not.toContain('queryP2PAds');
    expect(source).not.toContain('getExecutability');
  });

  it('carries none of the forbidden identifiers, in one sweep', () => {
    // The contract's list, checked against the code with comments removed.
    for (const forbidden of [
      'Date.now',
      'fetch(',
      'fs.',
      'bestBuyPrice',
      'bestSellPrice',
      'spreadPercentage',
      'strategicBuyPrice',
      'strategicSellPrice',
      'medianBuyPrice',
      'medianSellPrice',
      'Math.abs',
      'score',
      'weight',
      'confidence',
      'rank',
      'heuristicScore',
    ]) {
      expect(source, `engine must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the Opportunity type declares no speculative field', () => {
    const types = fs.readFileSync(path.join(process.cwd(), 'server', 'types.ts'), 'utf8');
    const block = types.slice(
      types.indexOf('export interface Opportunity {'),
      types.indexOf('export interface OpportunityContext')
    );
    const fields = [...block.matchAll(/^\s{2}([a-zA-Z]+)[?]?:/gm)].map((m) => m[1]);

    for (const forbidden of ['score', 'weight', 'confidence', 'rank', 'heuristicScore']) {
      expect(fields, `Opportunity must not declare ${forbidden}`).not.toContain(forbidden);
    }
    // The contract's minimum contract, all present.
    for (const required of [
      'bank',
      'amountVes',
      'buyPrice',
      'sellPrice',
      'buyAdvNo',
      'sellAdvNo',
      'spreadAbsolute',
      'spreadPct',
      'marginAbsolute',
      'marginPct',
      'buyAvailableUsdt',
      'sellAvailableUsdt',
      'availableUsdt',
      'verification',
    ]) {
      expect(fields, `Opportunity must declare ${required}`).toContain(required);
    }
  });

  it('TEST 32: imports no stateful module', () => {
    for (const forbidden of ['centralStore', 'storage', 'telegramNotifier', 'express', 'react']) {
      expect(source.toLowerCase(), `must not import ${forbidden}`).not.toContain(
        `from './${forbidden.toLowerCase()}`
      );
    }
    // Its only import is the type module.
    const imports = source.match(/from '[^']+'/g) ?? [];
    expect(imports).toEqual(["from './types.js'"]);
  });

  it('TEST 30: introduces no heuristic scoring', () => {
    expect(source).not.toMatch(/\bscore\b/i);
    expect(source).not.toMatch(/\bweight\b/i);
    expect(source).not.toMatch(/\bconfidence\b/i);
  });

  it('TEST 32: holds no module-level mutable state', () => {
    expect(source).not.toMatch(/^(let|var) /m);
  });

  it('TEST 36: both advNos belong to genuinely executable quotes', () => {
    const c = cell({
      buy: [
        { advNo: 'b-rejected', price: 800, maxAmountVes: 100 },
        { advNo: 'b-ok', price: 919 },
      ],
      sell: [
        { advNo: 's-rejected', price: 1_200, minAmountVes: 900_000 },
        { advNo: 's-ok', price: 922 },
      ],
    });
    const op = buildOpportunity(c)!;

    expect(c.buyQuotes.map((q) => q.advNo)).toContain(op.buyAdvNo);
    expect(c.sellQuotes.map((q) => q.advNo)).toContain(op.sellAdvNo);
    expect(c.buyQuotes.every((q) => q.provenance === 'EXECUTABLE')).toBe(true);
  });

  it('the same input object yields deeply equal results on repeated runs', () => {
    const input = {
      byBank: {
        BANESCO: {
          '20K': cell({ buy: [{ advNo: 'b', price: 919 }], sell: [{ advNo: 's', price: 922 }] }),
        },
      },
      bankOrder: BANK_ORDER,
    };

    expect(runOpportunityEngine(input)).toEqual(runOpportunityEngine(input));
  });
});

describe('runOpportunityEngine - full result', () => {
  it('reports opportunities, per-cell results, context and the global best', () => {
    const result = runOpportunityEngine({
      byBank: {
        BANESCO: {
          '20K': cell({ buy: [{ advNo: 'b', price: 919 }], sell: [{ advNo: 's', price: 921 }] }),
          '100K': cell({
            amountVes: 100_000,
            buy: [{ advNo: 'b', price: 919, maxAmountVes: 50_000 }],
            sell: [{ advNo: 's', price: 921 }],
          }),
        },
      },
      bankOrder: BANK_ORDER,
    });

    expect(result.opportunities).toHaveLength(1);
    expect(result.byBank.BANESCO['20K']).not.toBeNull();
    expect(result.byBank.BANESCO['100K']).toBeNull();
    expect(result.bestOpportunity?.amountVes).toBe(20_000);
    // Context survives even for the cell that produced nothing.
    expect(result.context.BANESCO['100K'].buyRejections).toEqual({ AMOUNT_ABOVE_MAX: 1 });
  });

  it('returns an empty, well-formed result for an empty input', () => {
    const result = runOpportunityEngine({ byBank: {} });

    expect(result.opportunities).toEqual([]);
    expect(result.bestOpportunity).toBeNull();
    expect(result.byBank).toEqual({});
  });
});

describe('spread selection over the real executable set', () => {
  it('CASO 15: the extremes ARE the maximum - no cartesian product needed', () => {
    /*
     * BUY 930/932/934 x SELL 931/933/935 has nine combinations. Enumerated,
     * the best is 930 -> 935 = +5, which is exactly min(BUY) -> max(SELL).
     *
     * That is not a coincidence: (sell - buy) / buy rises with sell and falls
     * with buy, so its maximum over the product always sits at that corner.
     * The test enumerates all nine and asserts the engine's answer equals the
     * enumerated winner - the guarantee, without paying O(n^2) for it.
     */
    const c = cell({
      buy: [
        { advNo: 'b930', price: 930 },
        { advNo: 'b932', price: 932 },
        { advNo: 'b934', price: 934 },
      ],
      sell: [
        { advNo: 's931', price: 931 },
        { advNo: 's933', price: 933 },
        { advNo: 's935', price: 935 },
      ],
    });
    const op = buildOpportunity(c)!;

    expect(op.buyPrice).toBe(930);
    expect(op.sellPrice).toBe(935);
    expect(op.spreadAbsolute).toBe(5);

    // Brute force, for comparison only - never used in production.
    const brute = c.buyQuotes.flatMap((b) =>
      c.sellQuotes.map((s) => ({ buy: b.price, sell: s.price, spread: s.price - b.price }))
    );
    expect(brute).toHaveLength(9);
    const bestBrute = brute.reduce((a, b) => (b.spread > a.spread ? b : a));
    expect(bestBrute).toEqual({ buy: 930, sell: 935, spread: 5 });
    expect(op.spreadAbsolute).toBe(bestBrute.spread);
  });

  it('CASO 16: an inverted cell is context, never the best opportunity', () => {
    const c = cell({
      buy: [{ advNo: 'b', price: 934 }],
      sell: [{ advNo: 's', price: 932 }],
    });
    const result = runOpportunityEngine({
      byBank: { BANESCO: { '20K': c } },
      bankOrder: BANK_ORDER,
    });

    // The cell exists and reports the real, negative spread...
    expect(result.byBank.BANESCO['20K']!.spreadAbsolute).toBe(-2);
    expect(result.opportunities).toHaveLength(1);
    // ...and it is not offered as an operation.
    expect(result.bestOpportunity).toBeNull();
  });

  it('CASO 19: a tier cannot borrow an ad that only covers another tier', () => {
    const ads = {
      buy: [{ advNo: 'only100k', price: 930, minAmountVes: 60_000, maxAmountVes: 100_000 }],
      sell: [{ advNo: 'any', price: 940 }],
    };

    const at20K = buildOpportunity(cell({ ...ads, amountVes: 20_000 }));
    const at100K = buildOpportunity(cell({ ...ads, amountVes: 100_000 }));

    expect(at20K).toBeNull(); // 20K is below the ad's minimum
    expect(at100K?.buyPrice).toBe(930); // 100K is inside its limits
    expect(at100K?.amountVes).toBe(100_000);
  });
});
