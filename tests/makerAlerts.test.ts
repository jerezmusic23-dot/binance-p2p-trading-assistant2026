/**
 * WHAT GETS ANNOUNCED, AND WHAT STAYS QUIET.
 *
 * The failure this suite exists to prevent is a stream: 7 banks x 6 amounts x
 * 2 sides of leaders moving every 45 seconds is thousands of messages a day,
 * and an operator who mutes the bot has the same information as one with no
 * bot. So a displacement is only news about a price this robot actually
 * announced, and it is news once per move, not once per refresh.
 */

import { describe, expect, it } from 'vitest';
import { evaluateMakerAlerts, type AnnouncedPublication } from '../server/makerAlerts.js';
import { buildMakerMatrix, selectBestMakerCell } from '../server/makerMatrix.js';
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

function matrix(myBuyRivals: NormalizedAd[], mySellRivals: NormalizedAd[]) {
  return buildMakerMatrix({
    bankOrder: ['banesco'],
    bankDisplayNames: { banesco: 'Banesco' },
    bankAllowedCodes: { banesco: ['Banesco'] },
    amounts: [{ key: '10K', val: 10_000 }],
    listingsByTier: {
      '10K': {
        banesco: {
          SELL: [...myBuyRivals, CENTS_WITNESS],
          BUY: [...mySellRivals, CENTS_WITNESS],
        },
      },
    },
    failedBanksByTier: {},
    capturedAtByTier: { '10K': AT },
    capturedAt: AT,
    config: DEFAULT_MAKER_CONFIG,
    nowMs: AT + 1000,
  });
}

function evaluate(m: ReturnType<typeof matrix>, announced: AnnouncedPublication | null) {
  return evaluateMakerAlerts({
    matrix: m,
    announced,
    best: selectBestMakerCell(m),
    nowMs: AT + 1000,
  });
}

describe('the first instruction', () => {
  const { alerts, announced } = evaluate(matrix([ad(940)], [ad(945)]), null);

  it('announces the price to publish', () => {
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('PUBLISH');
  });

  it('records exactly what was announced, so displacement can be measured', () => {
    expect(announced).toMatchObject({
      bank: 'banesco',
      bankDisplayName: 'Banesco',
      amountKey: '10K',
      amountVes: 10_000,
      buyPrice: 940.01,
      sellPrice: 944.99,
      buyPosition: 1,
      sellPosition: 1,
      grossMarginVes: 4.98,
      announcedAt: AT + 1000,
    });
  });
});

describe('an unchanged book', () => {
  it('says nothing at all', () => {
    const first = evaluate(matrix([ad(940)], [ad(945)]), null);
    const second = evaluate(matrix([ad(940)], [ad(945)]), first.announced);
    expect(second.alerts).toEqual([]);
    expect(second.announced).toEqual(first.announced);
  });
});

describe('when somebody outbids the announced price', () => {
  const first = evaluate(matrix([ad(940)], [ad(945)]), null);
  // A new buyer at 941 pushes my announced 940.01 from first to second place.
  const second = evaluate(matrix([ad(940), ad(941)], [ad(945)]), first.announced);

  it('announces the displacement', () => {
    const displaced = second.alerts.find((a) => a.kind === 'DISPLACED');
    expect(displaced).toBeDefined();
    expect(displaced).toMatchObject({ buyPosition: 2, sellPosition: 1 });
  });

  it('states the price that would take the lead back', () => {
    const displaced = second.alerts.find((a) => a.kind === 'DISPLACED');
    expect(displaced).toMatchObject({ priceToBeFirstBuy: 941.01, priceToBeFirstSell: 944.99 });
  });

  it('does not repeat the same displacement on the next refresh', () => {
    const third = evaluate(matrix([ad(940), ad(941)], [ad(945)]), second.announced);
    expect(third.alerts.filter((a) => a.kind === 'DISPLACED')).toEqual([]);
  });

  it('announces the new price to publish alongside it', () => {
    expect(second.alerts.map((a) => a.kind)).toEqual(['DISPLACED', 'PUBLISH']);
    expect(second.announced!.buyPrice).toBe(941.01);
  });
});

describe('BUG: a displacement must never be reported for a cell nobody was told to publish in', () => {
  it('stays silent about leaders moving elsewhere in the matrix', () => {
    const first = evaluate(matrix([ad(940)], [ad(945)]), null);
    // The announced cell is untouched; only an unrelated deeper ad appears.
    const second = evaluate(matrix([ad(940), ad(930)], [ad(945)]), first.announced);
    expect(second.alerts).toEqual([]);
  });
});

describe('when the market stops offering a margin', () => {
  it('keeps the announced instruction rather than silently forgetting it', () => {
    const first = evaluate(matrix([ad(940)], [ad(945)]), null);
    const second = evaluate(matrix([ad(930)], [ad(920)]), first.announced);
    expect(second.alerts.filter((a) => a.kind === 'PUBLISH')).toEqual([]);
    expect(second.announced!.buyPrice).toBe(940.01);
  });
});
