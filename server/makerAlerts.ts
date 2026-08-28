/**
 * WHEN THE OPERATOR NEEDS TO BE TOLD SOMETHING.
 *
 * Two things reach Telegram from here, and deliberately only two:
 *
 *   SUMMARY      - every 30 minutes, one compact picture of every BANCO x
 *                  MONTO and the price to publish in each.
 *   PRICE_CHANGE - the price I should actually publish in a cell changed.
 *
 * THE RULE THAT DEFINES THIS MODULE
 *
 * A change of leader is NOT news. Neither is a change of position, of advNo,
 * of advertised volume, or of who is in the ladder. The only event worth a
 * message is the one the operator can act on: the number they would type into
 * the Binance ad form is different from the number they were last told.
 *
 * A leader moving from 940.00 to 940.01 changes the recommendation from 940.01
 * to 940.02 - that is an alert. A leader moving somewhere deep in the book
 * while the recommendation stays at 940.01 is not, however much moved.
 *
 * PURE. No clock, no network, no notifier. It is handed the previous state and
 * the current matrix and returns what changed plus the new state.
 */

import type { MakerMatrix, MakerMatrixCell } from './makerMatrix.js';
import type { MakerPairing } from './makerRecommendation.js';

/** How often the full picture is published, independently of any change. */
export const MAKER_SUMMARY_INTERVAL_MS = 30 * 60 * 1000;

/** The two numbers the operator would type into the ad form for one cell. */
export interface PublishedPrices {
  buyPrice: number;
  sellPrice: number;
}

export interface MakerAlertState {
  /**
   * cellKey -> the recommended prices last known for it.
   *
   * A cell with no recommendation carries no entry: there is no price to
   * publish, so there is nothing a later price could differ from. Its return
   * is a first observation, which is silent and reported by the next summary.
   */
  recommended: Record<string, PublishedPrices>;
  /** null until the first summary goes out. */
  lastSummaryAt: number | null;
}

export const EMPTY_MAKER_ALERT_STATE: MakerAlertState = {
  recommended: {},
  lastSummaryAt: null,
};

export type MakerAlert =
  | { kind: 'SUMMARY'; matrix: MakerMatrix }
  | {
      kind: 'PRICE_CHANGE';
      cell: MakerMatrixCell;
      pairing: MakerPairing;
      previous: PublishedPrices;
      current: PublishedPrices;
    };

/** BANCO x MONTO, never mixed: one key per cell, and no cell shares another's. */
export function cellKey(bank: string, amountKey: string): string {
  return `${bank}:${amountKey}`;
}

function currentPrices(cell: MakerMatrixCell): PublishedPrices | null {
  const pair = cell.recommendation?.recommended ?? null;
  if (pair === null) return null;
  return { buyPrice: pair.buy.price, sellPrice: pair.sell.price };
}

/**
 * Which cells may speak at all.
 *
 * A stale or failed cell carries no current answer, so it neither alerts nor
 * updates the recorded price - it must not be able to erase what the operator
 * was last told just because one sweep did not come back.
 */
function isLive(cell: MakerMatrixCell): boolean {
  return cell.status === 'PUBLISH_AT_TOP' || cell.status === 'PUBLISH_DEEPER';
}

export function evaluateMakerAlerts(params: {
  matrix: MakerMatrix;
  state: MakerAlertState;
  nowMs: number;
  summaryIntervalMs?: number;
}): { alerts: MakerAlert[]; state: MakerAlertState } {
  const interval = params.summaryIntervalMs ?? MAKER_SUMMARY_INTERVAL_MS;
  const alerts: MakerAlert[] = [];
  const recommended: Record<string, PublishedPrices> = { ...params.state.recommended };

  for (const bank of params.matrix.bankOrder) {
    for (const amountKey of params.matrix.amountKeys) {
      const cell = params.matrix.cells[bank]?.[amountKey];
      if (cell === undefined) continue;

      const key = cellKey(bank, amountKey);

      if (!isLive(cell)) {
        /*
         * STALE and FETCH_FAILED say nothing about prices; they say the sweep
         * failed. Only a cell that genuinely has no recommendation clears its
         * recorded price.
         */
        if (cell.status !== 'STALE' && cell.status !== 'FETCH_FAILED') {
          delete recommended[key];
        }
        continue;
      }

      const current = currentPrices(cell);
      const pairing = cell.recommendation?.recommended ?? null;
      if (current === null || pairing === null) continue;

      const previous = recommended[key];
      recommended[key] = current;

      // A first observation has nothing to differ from; the summary reports it.
      if (previous === undefined) continue;

      if (previous.buyPrice === current.buyPrice && previous.sellPrice === current.sellPrice) {
        continue;
      }

      alerts.push({ kind: 'PRICE_CHANGE', cell, pairing, previous, current });
    }
  }

  /*
   * The summary is due on its own clock, not on anything that changed. The
   * first one goes out as soon as a matrix has something to say, so the
   * operator is not left waiting half an hour after a restart.
   */
  const hasAnythingToSay = Object.keys(recommended).length > 0;
  const summaryDue =
    params.state.lastSummaryAt === null
      ? hasAnythingToSay
      : params.nowMs - params.state.lastSummaryAt >= interval;

  let lastSummaryAt = params.state.lastSummaryAt;
  if (summaryDue) {
    alerts.unshift({ kind: 'SUMMARY', matrix: params.matrix });
    lastSummaryAt = params.nowMs;
  }

  return { alerts, state: { recommended, lastSummaryAt } };
}
