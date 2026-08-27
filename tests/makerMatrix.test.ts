/**
 * BANCO x MONTO, in the operator's vocabulary.
 *
 * The status of a cell is the assertion that matters most here. A dashboard
 * that decides a cell's colour from its own reading of the numbers can - and
 * once did - contradict what Telegram announces about the same book. So the
 * status is derived from the recommendation object and this suite pins that.
 */

import { describe, expect, it } from 'vitest';
import {
  MAKER_MATRIX_STALE_AFTER_MS,
  buildMakerMatrix,
  selectBestMakerCell,
} from '../server/makerMatrix.js';
import { DEFAULT_MAKER_CONFIG } from '../server/makerStrategy.js';
import { makeNormalizedAd } from './helpers/fixtures.js';
import type { NormalizedAd } from '../server/types.js';

const AT = 1_756_000_000_000;
const AMOUNTS = [
  { key: '10K', val: 10_000 },
  { key: '20K', val: 20_000 },
];

function ad(price: number, overrides: Partial<NormalizedAd> = {}): NormalizedAd {
  return { ...makeNormalizedAd(price), advNo: `adv-${price}`, ...overrides };
}

/** Establishes the 0.01 step without competing for any bank under test. */
const CENTS_WITNESS = ad(900.25, {
  paymentOptions: [{ payType: 'Provincial', tradeMethodName: 'Provincial' }],
});

function matrix(overrides: {
  myBuyRivals?: NormalizedAd[];
  mySellRivals?: NormalizedAd[];
  capturedAt?: number;
  nowMs?: number;
  failed?: Set<string>;
  omitBook?: boolean;
} = {}) {
  const capturedAt = overrides.capturedAt ?? AT;
  const listings = {
    BUY: [...(overrides.mySellRivals ?? [ad(945), ad(946)]), CENTS_WITNESS],
    SELL: [...(overrides.myBuyRivals ?? [ad(940), ad(939)]), CENTS_WITNESS],
  };

  return buildMakerMatrix({
    bankOrder: ['banesco'],
    bankDisplayNames: { banesco: 'Banesco' },
    bankAllowedCodes: { banesco: ['Banesco'] },
    amounts: AMOUNTS,
    listingsByTier: overrides.omitBook === true ? {} : { '10K': { banesco: listings } },
    failedBanksByTier: overrides.failed ? { '10K': overrides.failed } : {},
    capturedAtByTier: { '10K': capturedAt },
    capturedAt,
    config: DEFAULT_MAKER_CONFIG,
    nowMs: overrides.nowMs ?? AT + 1000,
  });
}

describe('a cell with a real book', () => {
  const cell = matrix().cells.banesco['10K'];

  it('carries the two prices to publish and the margin between them', () => {
    expect(cell.status).toBe('PUBLISH_AT_TOP');
    expect(cell.recommendation!.recommended!.buy.price).toBe(940.01);
    expect(cell.recommendation!.recommended!.sell.price).toBe(944.99);
    expect(cell.recommendation!.recommended!.grossMarginVes).toBe(4.98);
  });

  it('names the bank and the amount it was built for', () => {
    expect(cell.bankDisplayName).toBe('Banesco');
    expect(cell.amountVes).toBe(10_000);
    expect(cell.amountKey).toBe('10K');
  });

  it('counts the ads each listing returned, before any relevance test', () => {
    expect(cell.adsReturned).toEqual({ buyListing: 3, sellListing: 3 });
  });

  it('reports the age of its OWN book', () => {
    expect(cell.capturedAt).toBe(AT);
    expect(cell.ageSeconds).toBe(1);
  });
});

describe('a cell status never disagrees with its recommendation', () => {
  it('says PUBLISH_DEEPER exactly when leading both ladders would lose', () => {
    const cell = matrix({
      myBuyRivals: [ad(945), ad(944)],
      mySellRivals: [ad(945), ad(946)],
    }).cells.banesco['10K'];
    expect(cell.recommendation!.basis).toBe('DEEPER_POSITION_REQUIRED');
    expect(cell.status).toBe('PUBLISH_DEEPER');
    expect(cell.recommendation!.recommended!.position).toBe(2);
  });

  it('says NO_MARGIN rather than showing the least-bad loss as a price', () => {
    const cell = matrix({ myBuyRivals: [ad(930)], mySellRivals: [ad(920)] }).cells.banesco['10K'];
    expect(cell.status).toBe('NO_MARGIN');
    expect(cell.recommendation!.recommended).toBeNull();
  });

  it('says NO_DATA for a tier the rotating sweep has not reached', () => {
    const cell = matrix().cells.banesco['20K'];
    expect(cell.status).toBe('NO_DATA');
    expect(cell.recommendation).toBeNull();
    expect(cell.reason).toContain('20K');
  });

  it('says FETCH_FAILED when Binance did not answer for that bank', () => {
    const cell = matrix({ failed: new Set(['banesco']) }).cells.banesco['10K'];
    expect(cell.status).toBe('FETCH_FAILED');
  });

  it('says STALE once the book is older than a full sweep', () => {
    const cell = matrix({ nowMs: AT + MAKER_MATRIX_STALE_AFTER_MS + 1 }).cells.banesco['10K'];
    expect(cell.status).toBe('STALE');
    // The numbers survive: a stale price is old, not unknown.
    expect(cell.recommendation!.recommended!.buy.price).toBe(940.01);
  });
});

describe('BUG: an unswept tier must not borrow another tier freshness', () => {
  it('gives a never-captured tier no age of its own to inherit', () => {
    const cell = matrix().cells.banesco['20K'];
    expect(cell.capturedAt).toBe(0);
    expect(cell.recommendation).toBeNull();
  });
});

describe('selectBestMakerCell', () => {
  it('returns null when nothing in the matrix has a price to publish', () => {
    expect(selectBestMakerCell(matrix({ omitBook: true }))).toBeNull();
    expect(selectBestMakerCell(matrix({ myBuyRivals: [ad(930)], mySellRivals: [ad(920)] }))).toBeNull();
  });

  it('picks the cell with the largest MARGEN BRUTO per USDT', () => {
    const built = buildMakerMatrix({
      bankOrder: ['banesco', 'mercantil'],
      bankDisplayNames: { banesco: 'Banesco', mercantil: 'Mercantil' },
      bankAllowedCodes: { banesco: ['Banesco'], mercantil: ['Mercantil'] },
      amounts: AMOUNTS,
      listingsByTier: {
        '10K': {
          banesco: { SELL: [ad(940), CENTS_WITNESS], BUY: [ad(945), CENTS_WITNESS] },
          mercantil: {
            SELL: [ad(940, { paymentOptions: [{ payType: 'Mercantil', tradeMethodName: 'M' }] }), CENTS_WITNESS],
            BUY: [ad(950, { paymentOptions: [{ payType: 'Mercantil', tradeMethodName: 'M' }] }), CENTS_WITNESS],
          },
        },
      },
      failedBanksByTier: {},
      capturedAtByTier: { '10K': AT },
      capturedAt: AT,
      config: DEFAULT_MAKER_CONFIG,
      nowMs: AT + 1000,
    });

    const best = selectBestMakerCell(built);
    expect(best!.bank).toBe('mercantil');
    expect(best!.recommendation!.recommended!.grossMarginVes).toBe(9.98);
  });

  it('never picks a stale or failed cell, however good its numbers look', () => {
    const stale = matrix({ nowMs: AT + MAKER_MATRIX_STALE_AFTER_MS + 1 });
    expect(selectBestMakerCell(stale)).toBeNull();
    expect(selectBestMakerCell(matrix({ failed: new Set(['banesco']) }))).toBeNull();
  });
});
