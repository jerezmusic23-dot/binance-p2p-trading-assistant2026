/**
 * WHAT GETS ANNOUNCED, AND WHAT STAYS QUIET.
 *
 * The rule this suite exists to enforce is one sentence: the only event worth
 * a message is a change in the number the operator would type into the Binance
 * ad form.
 *
 * Everything else moves constantly across 7 banks x 6 amounts x 2 sides -
 * leaders, positions, advNos, advertised volume - and alerting on any of it
 * produces a stream nobody reads, which is the same as having no alerts.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_MAKER_ALERT_STATE,
  MAKER_SUMMARY_INTERVAL_MS,
  cellKey,
  evaluateMakerAlerts,
  type MakerAlertState,
} from '../server/makerAlerts.js';
import { buildMakerMatrix, type MakerMatrix } from '../server/makerMatrix.js';
import { DEFAULT_MAKER_CONFIG } from '../server/makerStrategy.js';
import { makeNormalizedAd } from './helpers/fixtures.js';
import type { NormalizedAd } from '../server/types.js';

const AT = 1_756_000_000_000;

function ad(price: number, overrides: Partial<NormalizedAd> = {}): NormalizedAd {
  return { ...makeNormalizedAd(price), advNo: `adv-${price}`, ...overrides };
}

/** Establishes the 0.01 step by observation, without competing for any bank. */
const CENTS_WITNESS = ad(900.25, {
  paymentOptions: [{ payType: 'Provincial', tradeMethodName: 'Provincial' }],
});

function matrix(
  cells: Record<string, { buy: NormalizedAd[]; sell: NormalizedAd[] }>,
  opts: { nowMs?: number; failed?: Set<string> } = {}
): MakerMatrix {
  const listings: Record<string, Record<string, { BUY: NormalizedAd[]; SELL: NormalizedAd[] }>> = {
    '10K': {},
    '20K': {},
  };
  for (const [key, book] of Object.entries(cells)) {
    const [amountKey, bank] = key.split('@');
    listings[amountKey][bank] = {
      SELL: [...book.buy, CENTS_WITNESS],
      BUY: [...book.sell, CENTS_WITNESS],
    };
  }

  return buildMakerMatrix({
    bankOrder: ['banesco', 'venezuela'],
    bankDisplayNames: { banesco: 'Banesco', venezuela: 'Banco de Venezuela' },
    bankAllowedCodes: { banesco: ['Banesco'], venezuela: ['Banesco'] },
    amounts: [
      { key: '10K', val: 10_000 },
      { key: '20K', val: 20_000 },
    ],
    listingsByTier: listings,
    failedBanksByTier: opts.failed ? { '10K': opts.failed } : {},
    capturedAtByTier: { '10K': AT, '20K': AT },
    capturedAt: AT,
    config: DEFAULT_MAKER_CONFIG,
    nowMs: opts.nowMs ?? AT + 1000,
  });
}

const ONE_CELL = { '10K@banesco': { buy: [ad(940)], sell: [ad(945)] } };

function evaluate(m: MakerMatrix, state: MakerAlertState, nowMs = AT + 1000) {
  return evaluateMakerAlerts({ matrix: m, state, nowMs });
}

/** State as it stands once the first summary has gone out and prices learned. */
function settled(m: MakerMatrix, nowMs = AT + 1000): MakerAlertState {
  return evaluate(m, EMPTY_MAKER_ALERT_STATE, nowMs).state;
}

describe('the first evaluation', () => {
  const { alerts, state } = evaluate(matrix(ONE_CELL), EMPTY_MAKER_ALERT_STATE);

  it('publishes the summary and nothing else', () => {
    expect(alerts.map((a) => a.kind)).toEqual(['SUMMARY']);
  });

  it('learns the prices silently, so a first sighting is never a change', () => {
    expect(state.recommended[cellKey('banesco', '10K')]).toEqual({
      buyPrice: 940.01,
      sellPrice: 944.99,
    });
    expect(state.lastSummaryAt).toBe(AT + 1000);
  });
});

describe('an unchanged book', () => {
  it('says nothing at all before the next summary is due', () => {
    const m = matrix(ONE_CELL);
    const second = evaluate(m, settled(m), AT + 60_000);
    expect(second.alerts).toEqual([]);
  });
});

describe('BUG: a leader that moves without moving my price must stay silent', () => {
  it('is quiet when a new rival appears deep in the book', () => {
    const m = matrix(ONE_CELL);
    const state = settled(m);
    // A buyer at 930 joins the ladder. The leader is still 940, so I still
    // publish 940.01 - nothing for the operator to do.
    const after = evaluate(
      matrix({ '10K@banesco': { buy: [ad(940), ad(930)], sell: [ad(945)] } }),
      state,
      AT + 60_000
    );
    expect(after.alerts).toEqual([]);
  });

  it('is quiet when the leader ad is replaced by another at the same price', () => {
    const m = matrix(ONE_CELL);
    const state = settled(m);
    const replaced = ad(940);
    replaced.advNo = 'a-completely-different-ad';
    const after = evaluate(
      matrix({ '10K@banesco': { buy: [replaced], sell: [ad(945)] } }),
      state,
      AT + 60_000
    );
    expect(after.alerts).toEqual([]);
  });

  it('is quiet when only the advertised volume changed', () => {
    const m = matrix(ONE_CELL);
    const state = settled(m);
    const after = evaluate(
      matrix({
        '10K@banesco': {
          buy: [ad(940, { availableUsdt: 9999, availableUsdtReported: 9999 })],
          sell: [ad(945)],
        },
      }),
      state,
      AT + 60_000
    );
    expect(after.alerts).toEqual([]);
  });
});

describe('when the price I must publish really changes', () => {
  const m = matrix(ONE_CELL);
  const state = settled(m);
  // Leader 940.00 -> 940.01, so my price 940.01 -> 940.02.
  const after = evaluate(
    matrix({ '10K@banesco': { buy: [ad(940.01)], sell: [ad(945)] } }),
    state,
    AT + 60_000
  );

  it('raises exactly one alert', () => {
    expect(after.alerts.map((a) => a.kind)).toEqual(['PRICE_CHANGE']);
  });

  it('carries what changed, from and to', () => {
    const alert = after.alerts[0];
    expect(alert.kind).toBe('PRICE_CHANGE');
    if (alert.kind !== 'PRICE_CHANGE') return;
    expect(alert.previous).toEqual({ buyPrice: 940.01, sellPrice: 944.99 });
    expect(alert.current).toEqual({ buyPrice: 940.02, sellPrice: 944.99 });
    expect(alert.cell.bankDisplayName).toBe('Banesco');
    expect(alert.cell.amountKey).toBe('10K');
  });

  it('does not raise it a second time once recorded', () => {
    const again = evaluate(
      matrix({ '10K@banesco': { buy: [ad(940.01)], sell: [ad(945)] } }),
      after.state,
      AT + 120_000
    );
    expect(again.alerts).toEqual([]);
  });
});

describe('the 30-minute summary', () => {
  it('is due exactly every 30 minutes, whatever else happened', () => {
    expect(MAKER_SUMMARY_INTERVAL_MS).toBe(1_800_000);

    const m = matrix(ONE_CELL);
    const state = settled(m);

    const early = evaluate(m, state, AT + 1000 + MAKER_SUMMARY_INTERVAL_MS - 1);
    expect(early.alerts.filter((a) => a.kind === 'SUMMARY')).toEqual([]);

    const due = evaluate(m, state, AT + 1000 + MAKER_SUMMARY_INTERVAL_MS);
    expect(due.alerts.filter((a) => a.kind === 'SUMMARY')).toHaveLength(1);
    expect(due.state.lastSummaryAt).toBe(AT + 1000 + MAKER_SUMMARY_INTERVAL_MS);
  });

  it('is one alert for the whole matrix, never one per cell', () => {
    const m = matrix({
      '10K@banesco': { buy: [ad(940)], sell: [ad(945)] },
      '20K@banesco': { buy: [ad(941)], sell: [ad(946)] },
      '10K@venezuela': { buy: [ad(942)], sell: [ad(947)] },
      '20K@venezuela': { buy: [ad(943)], sell: [ad(948)] },
    });
    const { alerts } = evaluate(m, EMPTY_MAKER_ALERT_STATE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('SUMMARY');
  });

  it('waits until there is something to say', () => {
    const empty = matrix({});
    const { alerts, state } = evaluate(empty, EMPTY_MAKER_ALERT_STATE);
    expect(alerts).toEqual([]);
    expect(state.lastSummaryAt).toBeNull();
  });
});

describe('BANCO x MONTO stay isolated', () => {
  const m = matrix({
    '10K@banesco': { buy: [ad(940)], sell: [ad(945)] },
    '20K@banesco': { buy: [ad(950)], sell: [ad(955)] },
    '10K@venezuela': { buy: [ad(960)], sell: [ad(965)] },
  });
  const state = settled(m);

  it('records one price pair per cell, keyed by both', () => {
    expect(state.recommended[cellKey('banesco', '10K')]).toEqual({
      buyPrice: 940.01,
      sellPrice: 944.99,
    });
    expect(state.recommended[cellKey('banesco', '20K')]).toEqual({
      buyPrice: 950.01,
      sellPrice: 954.99,
    });
    expect(state.recommended[cellKey('venezuela', '10K')]).toEqual({
      buyPrice: 960.01,
      sellPrice: 964.99,
    });
  });

  it('alerts only for the cell that moved, never for its neighbours', () => {
    const moved = matrix({
      '10K@banesco': { buy: [ad(940)], sell: [ad(945)] },
      '20K@banesco': { buy: [ad(951)], sell: [ad(955)] },
      '10K@venezuela': { buy: [ad(960)], sell: [ad(965)] },
    });
    const { alerts } = evaluate(moved, state, AT + 60_000);

    expect(alerts).toHaveLength(1);
    const alert = alerts[0];
    if (alert.kind !== 'PRICE_CHANGE') throw new Error('expected a price change');
    expect(alert.cell.bank).toBe('banesco');
    expect(alert.cell.amountKey).toBe('20K');
  });
});

describe('a cell with no verifiable price', () => {
  it('never invents one, and never alerts', () => {
    // No ad in either listing quotes a decimal: the step is unobservable.
    const m = buildMakerMatrix({
      bankOrder: ['banesco'],
      bankDisplayNames: { banesco: 'Banesco' },
      bankAllowedCodes: { banesco: ['Banesco'] },
      amounts: [{ key: '10K', val: 10_000 }],
      listingsByTier: { '10K': { banesco: { SELL: [ad(940)], BUY: [ad(945)] } } },
      failedBanksByTier: {},
      capturedAtByTier: { '10K': AT },
      capturedAt: AT,
      config: DEFAULT_MAKER_CONFIG,
      nowMs: AT + 1000,
    });

    const cell = m.cells.banesco['10K'];
    expect(cell.recommendation!.buyAnalysis.tickProvenance).toBe('NOT_VERIFIABLE');
    expect(cell.recommendation!.priceToBeFirstBuy).toBeNull();

    const { alerts, state } = evaluate(m, EMPTY_MAKER_ALERT_STATE);
    expect(alerts).toEqual([]);
    expect(state.recommended).toEqual({});
  });
});

describe('BUG: a failed sweep must not erase what the operator was last told', () => {
  it('keeps the recorded price when Binance did not answer', () => {
    const m = matrix(ONE_CELL);
    const state = settled(m);

    const failed = evaluate(
      matrix(ONE_CELL, { failed: new Set(['banesco']) }),
      state,
      AT + 60_000
    );

    expect(failed.alerts).toEqual([]);
    expect(failed.state.recommended[cellKey('banesco', '10K')]).toEqual({
      buyPrice: 940.01,
      sellPrice: 944.99,
    });
  });

  it('does forget a cell that genuinely stopped having a price', () => {
    const m = matrix(ONE_CELL);
    const state = settled(m);
    // An inverted book: no depth pays, so there is no price to publish.
    const gone = evaluate(
      matrix({ '10K@banesco': { buy: [ad(930)], sell: [ad(920)] } }),
      state,
      AT + 60_000
    );

    expect(gone.alerts).toEqual([]);
    expect(gone.state.recommended[cellKey('banesco', '10K')]).toBeUndefined();
  });
});
