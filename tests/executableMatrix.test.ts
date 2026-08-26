/**
 * The executable matrix: BANK + AMOUNT + LIQUIDITY, or nothing.
 *
 * Every fixture here is SYNTHETIC. Nothing in this file is evidence about the
 * real USDT/VES market; these tests prove that a rate cannot reach the
 * interface unless a real ad, verified as that bank's, accepts that amount and
 * published volume covering it.
 *
 * The defect being pinned shut: a global "best price" being presented as an
 * executable rate, and a negative spread being shown as an opportunity.
 */

import { describe, it, expect } from 'vitest';
import {
  MATRIX_STALE_AFTER_MS,
  buildCell,
  buildExecutableMatrix,
  buildMarketReference,
  diagnoseSide,
} from '../server/executableMatrix.js';
import { evaluateBankTiers } from '../server/executability.js';
import type { NormalizedAd } from '../server/types.js';

const NOW = Date.UTC(2026, 0, 6, 12, 0, 0);

/**
 * One ad. `available` is the volume Binance published, in USDT - the number
 * that decides whether an amount can actually be executed.
 */
function ad(overrides: Partial<NormalizedAd> & { price: number }): NormalizedAd {
  return {
    advNo: `adv-${overrides.price}-${overrides.availableUsdtReported ?? 'x'}`,
    minAmountVes: 1_000,
    maxAmountVes: 100_000,
    availableUsdtReported: 500,
    merchantName: 'M',
    ordersCount: 100,
    finishRate: 0.98,
    userType: 'merchant',
    paymentOptions: [{ payType: 'Banesco', tradeMethodName: 'Banesco' }],
    ...overrides,
  } as NormalizedAd;
}

function tiersFor(buyAds: NormalizedAd[], sellAds: NormalizedAd[], bank = 'BANESCO') {
  return evaluateBankTiers({
    bank,
    allowedCodes: ['Banesco'],
    buyAds,
    sellAds,
  });
}

function cellFor(
  buyAds: NormalizedAd[],
  sellAds: NormalizedAd[],
  amountKey = '20K',
  opts: { capturedAt?: number; failed?: boolean } = {}
) {
  const tiers = tiersFor(buyAds, sellAds);
  return buildCell({
    cell: tiers[amountKey],
    bankDisplayName: 'Banesco',
    amountKey,
    capturedAt: opts.capturedAt ?? NOW,
    nowMs: NOW,
    failed: opts.failed,
    buyAdsEvaluated: buyAds.length,
    sellAdsEvaluated: sellAds.length,
  });
}

describe('TEST 1 - correct bank and amount produce an executable cell', () => {
  it('names the bank, the amount and both executable legs', () => {
    const cell = cellFor([ad({ price: 944.75 })], [ad({ price: 960 })]);

    expect(cell.bank).toBe('BANESCO');
    expect(cell.amountVes).toBe(20_000);
    expect(cell.buy?.price).toBe(944.75);
    expect(cell.sell?.price).toBe(960);
    expect(cell.status).toBe('EXECUTABLE');
    expect(cell.provenance).toBe('EXECUTABLE');
  });

  it('cannot produce a rate without both a bank and an amount', () => {
    const cell = cellFor([ad({ price: 944 })], [ad({ price: 960 })]);
    // The two identifiers are structural, copied from the evaluated cell.
    expect(cell.bank).toBeTruthy();
    expect(cell.amountVes).toBeGreaterThan(0);
    expect(cell.buy?.minAmountVes).toBeLessThanOrEqual(cell.amountVes);
  });
});

describe('TEST 2 / 6 - insufficient liquidity is never executable', () => {
  it('rejects a cheaper ad that cannot cover the amount', () => {
    /*
     * 20 000 VES at 944 needs ~21.2 USDT. The cheap ad published 5 USDT, the
     * expensive one 500. The cheap price must not appear anywhere.
     */
    const cell = cellFor(
      [ad({ price: 900, availableUsdtReported: 5 }), ad({ price: 944, availableUsdtReported: 500 })],
      [ad({ price: 960 })]
    );

    expect(cell.buy?.price).toBe(944);
    expect(cell.buy?.price).not.toBe(900);
  });

  it('reports INSUFFICIENT_LIQUIDITY when volume exists but is too small', () => {
    const cell = cellFor(
      [ad({ price: 944, availableUsdtReported: 1 })],
      [ad({ price: 960, availableUsdtReported: 1 })],
      '100K'
    );

    expect(cell.status).toBe('INSUFFICIENT_LIQUIDITY');
    expect(cell.buy).toBeNull();
    expect(cell.reason).toMatch(/no cubre/i);
  });

  it('reports NO_LIQUIDITY when nobody published any volume above zero', () => {
    const cell = cellFor(
      [ad({ price: 944, availableUsdtReported: 0 })],
      [ad({ price: 960, availableUsdtReported: 0 })]
    );

    expect(cell.status).toBe('NO_LIQUIDITY');
    expect(cell.reason).toMatch(/ninguno publica volumen/i);
  });

  it('never reports absent liquidity as the number zero', () => {
    const cell = cellFor(
      [ad({ price: 944, availableUsdtReported: null })],
      [ad({ price: 960, availableUsdtReported: null })]
    );

    expect(cell.availableUsdt).toBeNull();
    expect(cell.availableUsdt).not.toBe(0);
    expect(cell.status).toBe('NOT_VERIFIABLE');
  });

  it('takes the narrower leg as the operation liquidity', () => {
    const cell = cellFor(
      [ad({ price: 944, availableUsdtReported: 30 })],
      [ad({ price: 960, availableUsdtReported: 500 })]
    );

    expect(cell.availableUsdt).toBe(30);
  });

  it('does not confuse ad count with liquidity', () => {
    // Twelve ads, none with volume for the amount: many ads, no liquidity.
    const thin = Array.from({ length: 12 }, (_, i) =>
      ad({ price: 944 + i, availableUsdtReported: 0.5 })
    );
    const cell = cellFor(thin, thin, '100K');

    expect(cell.status).not.toBe('EXECUTABLE');
    expect(cell.buy).toBeNull();
  });
});

describe('TEST 3 / 4 / 14 / 15 - the spread is signed and economic', () => {
  it('BUY > SELL yields a NEGATIVE spread', () => {
    const cell = cellFor([ad({ price: 946 })], [ad({ price: 945 })]);

    expect(cell.spreadPct).toBeLessThan(0);
    // evaluateBankAmount rounds to 2 decimals - -0.10571% becomes -0.11%,
    // which is exactly the figure that appeared on screen in production.
    expect(cell.spreadPct).toBe(-0.11);
  });

  it('BUY < SELL yields a POSITIVE spread', () => {
    const cell = cellFor([ad({ price: 944.75 })], [ad({ price: 960 })]);

    expect(cell.spreadPct).toBeGreaterThan(0);
    expect(cell.spreadPct).toBeCloseTo(((960 - 944.75) / 944.75) * 100, 2);
  });

  it('a negative spread can NEVER be EXECUTABLE', () => {
    const cell = cellFor([ad({ price: 946 })], [ad({ price: 945 })]);

    expect(cell.status).toBe('NO_OPPORTUNITY');
    expect(cell.status).not.toBe('EXECUTABLE');
  });

  it('break-even is not an opportunity either', () => {
    const cell = cellFor([ad({ price: 950 })], [ad({ price: 950 })]);

    expect(cell.spreadPct).toBe(0);
    expect(cell.status).toBe('NO_OPPORTUNITY');
  });

  it('keeps the loss visible instead of hiding its sign', () => {
    const cell = cellFor([ad({ price: 946 })], [ad({ price: 945 })]);

    expect(cell.spreadPct).not.toBe(Math.abs(cell.spreadPct as number));
    expect(cell.reason).toMatch(/pérdida no es una oportunidad/i);
  });

  it('always divides by the repurchase, never by the smaller of the two', () => {
    /*
     * A wide loss, so the two candidate denominators separate well above the
     * 2-decimal rounding: /recompra gives -10.00%, /min() gives -11.11%.
     * The repurchase is the money actually committed, so it is the base.
     */
    const cell = cellFor([ad({ price: 1000 })], [ad({ price: 900 })]);

    expect(cell.spreadPct).toBe(-10);
    expect(cell.spreadPct).not.toBe(-11.11);
  });
});

describe('TEST 5 - no ad', () => {
  it('reports NO_AD when Binance returned nothing', () => {
    const cell = cellFor([], []);

    expect(cell.status).toBe('NO_AD');
    expect(cell.buy).toBeNull();
    expect(cell.sell).toBeNull();
  });

  it('reports NO_AD when no ad of this bank accepts the amount', () => {
    const cell = cellFor(
      [ad({ price: 944, maxAmountVes: 5_000 })],
      [ad({ price: 960, maxAmountVes: 5_000 })]
    );

    expect(cell.status).toBe('NO_AD');
    expect(cell.reason).toMatch(/ningún anuncio verificado/i);
  });

  it('does not confuse a failed query with an empty book', () => {
    const empty = cellFor([], []);
    const failed = cellFor([], [], '20K', { failed: true });

    expect(empty.status).toBe('NO_AD');
    expect(failed.status).toBe('ERROR');
    expect(failed.reason).toMatch(/falló/i);
  });
});

describe('TEST 7 - stale', () => {
  it('marks a cell STALE once the book is older than the freshness window', () => {
    const cell = cellFor([ad({ price: 944 })], [ad({ price: 960 })], '20K', {
      capturedAt: NOW - MATRIX_STALE_AFTER_MS - 1_000,
    });

    expect(cell.status).toBe('STALE');
    expect(cell.ageSeconds).toBeGreaterThan(MATRIX_STALE_AFTER_MS / 1000);
  });

  it('a stale cell can never be EXECUTABLE, however good the spread', () => {
    const cell = cellFor([ad({ price: 900 })], [ad({ price: 999 })], '20K', {
      capturedAt: NOW - MATRIX_STALE_AFTER_MS - 1,
    });

    expect(cell.spreadPct).toBeGreaterThan(0);
    expect(cell.status).toBe('STALE');
  });

  it('carries a real capture timestamp, never a render-time one', () => {
    const capturedAt = NOW - 10_000;
    const cell = cellFor([ad({ price: 944 })], [ad({ price: 960 })], '20K', { capturedAt });

    expect(cell.capturedAt).toBe(capturedAt);
    expect(cell.ageSeconds).toBe(10);
  });
});

describe('TEST 10 / 11 - no bleeding between banks or amounts', () => {
  it('a bank only ever shows its own verified ads', () => {
    const banesco = ad({ price: 944 });
    const bnc = ad({
      price: 800,
      paymentOptions: [{ payType: 'BNCBancoNacional', tradeMethodName: 'BNC' }],
    });

    const matrix = buildExecutableMatrix({
      byBank: {
        BANESCO: tiersFor([banesco, bnc], [ad({ price: 960 })], 'BANESCO'),
        BNC: evaluateBankTiers({
          bank: 'BNC',
          allowedCodes: ['BNCBancoNacional'],
          buyAds: [banesco, bnc],
          sellAds: [ad({ price: 960 })],
        }),
      },
      bankOrder: ['BANESCO', 'BNC'],
      bankDisplayNames: { BANESCO: 'Banesco', BNC: 'BNC' },
      amountKeys: ['20K'],
      adCounts: { BANESCO: { buy: 2, sell: 1 }, BNC: { buy: 2, sell: 1 } },
      capturedAt: NOW,
      nowMs: NOW,
    });

    // The 800 ad is BNC's and is the cheapest. Banesco must not take it.
    expect(matrix.cells.BANESCO['20K'].buy?.price).toBe(944);
    expect(matrix.cells.BNC['20K'].buy?.price).toBe(800);
  });

  it('an amount only ever shows ads that accept that amount', () => {
    const small = ad({ price: 900, maxAmountVes: 20_000 });
    const large = ad({ price: 944, maxAmountVes: 100_000 });
    const tiers = tiersFor([small, large], [ad({ price: 960 })]);

    const at20 = buildCell({
      cell: tiers['20K'],
      bankDisplayName: 'Banesco',
      amountKey: '20K',
      capturedAt: NOW,
      nowMs: NOW,
      buyAdsEvaluated: 2,
      sellAdsEvaluated: 1,
    });
    const at50 = buildCell({
      cell: tiers['50K'],
      bankDisplayName: 'Banesco',
      amountKey: '50K',
      capturedAt: NOW,
      nowMs: NOW,
      buyAdsEvaluated: 2,
      sellAdsEvaluated: 1,
    });

    expect(at20.buy?.price).toBe(900);
    // 50K exceeds the cheap ad's ceiling: its price must not carry over.
    expect(at50.buy?.price).toBe(944);
  });

  it('keys cells by name, never by array position', () => {
    const matrix = buildExecutableMatrix({
      byBank: { BNC: tiersFor([ad({ price: 944 })], [ad({ price: 960 })], 'BNC') },
      // Bank order deliberately does not match the byBank insertion order.
      bankOrder: ['BANESCO', 'BNC'],
      bankDisplayNames: { BANESCO: 'Banesco', BNC: 'BNC' },
      amountKeys: ['20K'],
      adCounts: { BNC: { buy: 1, sell: 1 } },
      capturedAt: NOW,
      nowMs: NOW,
    });

    expect(matrix.cells.BANESCO).toEqual({});
    expect(matrix.cells.BNC['20K'].bank).toBe('BNC');
  });
});

describe('TEST 13 - no leaderPrice + 0.01 anywhere', () => {
  it('the cell exposes no suggested price at all', () => {
    const cell = cellFor([ad({ price: 944 })], [ad({ price: 960 })]);
    expect(cell).not.toHaveProperty('suggestedPrice');
    expect(cell).not.toHaveProperty('leaderPrice');
  });

  it('the spread is the arbitrage, not an undercut of the leader', () => {
    const cell = cellFor([ad({ price: 944 })], [ad({ price: 960 })]);
    // The old cell reported ((944.01 - 944) / 944) * 100 = 0.001%.
    expect(cell.spreadPct).toBeGreaterThan(1);
    expect(cell.spreadPct).not.toBeCloseTo(0.001, 3);
  });
});

describe('TEST 29 - regression: the exact figures reported in production', () => {
  it('944.75 sell / 945.75 buy is NO_OPPORTUNITY, not EXECUTABLE', () => {
    /*
     * The screen read:
     *     TASA VENTA: 944.75   TASA RECOMPRA: 945.75   SPREAD: -0.11%
     * Those were the global medians. Fed through the executable path as a real
     * bank/amount cell they are a LOSS, and must be classified as one.
     */
    const cell = cellFor([ad({ price: 945.75 })], [ad({ price: 944.75 })]);

    expect(cell.spreadPct).toBeCloseTo(-0.11, 2);
    expect(cell.status).toBe('NO_OPPORTUNITY');
    expect(cell.status).not.toBe('EXECUTABLE');
  });

  it('a genuine buy < sell is EXECUTABLE with a positive spread', () => {
    const cell = cellFor([ad({ price: 944.75 })], [ad({ price: 960 })]);

    expect(cell.spreadPct).toBeCloseTo(1.61, 2);
    expect(cell.status).toBe('EXECUTABLE');
  });
});

describe('market reference is packaged so it cannot pose as a quote', () => {
  it('carries executable: false and reference-prefixed field names', () => {
    const ref = buildMarketReference(
      { strategicBuyPrice: 945.75, strategicSellPrice: 944.75, strategicSpreadPct: -0.11, timestamp: NOW } as never,
      'LIVE',
      3
    );

    expect(ref.executable).toBe(false);
    expect(ref.referenceBuyPrice).toBe(945.75);
    expect(ref).not.toHaveProperty('bestBuyPrice');
    expect(ref).not.toHaveProperty('buyPrice');
    expect(ref.note).toContain('NADIE puede ejecutar');
  });

  it('reports nulls rather than zeros with no snapshot', () => {
    const ref = buildMarketReference(null, 'OFFLINE', 9999);

    expect(ref.referenceBuyPrice).toBeNull();
    expect(ref.referenceSellPrice).toBeNull();
    expect(ref.referenceSpreadPct).toBeNull();
  });
});

describe('diagnoseSide reports the most fundamental obstacle first', () => {
  it('an unestablished bank outranks a small volume', () => {
    expect(
      diagnoseSide(
        { BANK_NOT_VERIFIABLE: 1, LIQUIDITY_INSUFFICIENT: 5 },
        { LIQUIDITY_VERIFIED: 5, LIQUIDITY_ZERO: 0, LIQUIDITY_NOT_VERIFIABLE: 1 },
        6
      )
    ).toBe('NOT_VERIFIABLE');
  });

  it('separates no volume at all from volume that is too small', () => {
    expect(
      diagnoseSide(
        { LIQUIDITY_INSUFFICIENT: 3 },
        { LIQUIDITY_VERIFIED: 0, LIQUIDITY_ZERO: 3, LIQUIDITY_NOT_VERIFIABLE: 0 },
        3
      )
    ).toBe('NO_LIQUIDITY');

    expect(
      diagnoseSide(
        { LIQUIDITY_INSUFFICIENT: 3 },
        { LIQUIDITY_VERIFIED: 3, LIQUIDITY_ZERO: 0, LIQUIDITY_NOT_VERIFIABLE: 0 },
        3
      )
    ).toBe('INSUFFICIENT_LIQUIDITY');
  });

  it('an empty book is NO_AD, never a liquidity verdict', () => {
    expect(
      diagnoseSide({}, { LIQUIDITY_VERIFIED: 0, LIQUIDITY_ZERO: 0, LIQUIDITY_NOT_VERIFIABLE: 0 }, 0)
    ).toBe('NO_AD');
  });
});
