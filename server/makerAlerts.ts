/**
 * WHEN THE OPERATOR NEEDS TO BE TOLD SOMETHING.
 *
 * Two events, and deliberately only two:
 *
 *   PUBLISH   - here is a price to publish, at this bank and this amount.
 *   DISPLACED - the price you were told to publish is no longer where it was.
 *               Somebody outbid it, so the ad is now further down the queue.
 *
 * WHY NOT "ANY LEADER CHANGE"
 *
 * Leaders move constantly across 7 banks x 6 amounts x 2 sides, and alerting on
 * all of them would produce a stream nobody reads, which is the same as no
 * alerts at all. What is actually actionable is narrower: whether the price
 * this robot last told the operator to publish is still competitive. That is
 * measured against the announced price, not against an arbitrary sample of the
 * book, and it is measured with the same estimatePosition the interface shows.
 *
 * PURE. No clock, no network, no notifier. It is handed the previous state and
 * the current matrix and it returns what changed.
 */

import type { MakerMatrix, MakerMatrixCell } from './makerMatrix.js';
import type { MakerPairing } from './makerRecommendation.js';
import { estimatePosition } from './makerStrategy.js';

/** What the operator was last told to publish. */
export interface AnnouncedPublication {
  bank: string;
  bankDisplayName: string;
  amountKey: string;
  amountVes: number;
  buyPrice: number;
  sellPrice: number;
  buyPosition: number;
  sellPosition: number;
  grossMarginVes: number;
  announcedAt: number;
}

export type MakerAlert =
  | { kind: 'PUBLISH'; cell: MakerMatrixCell; pairing: MakerPairing }
  | {
      kind: 'DISPLACED';
      announced: AnnouncedPublication;
      cell: MakerMatrixCell;
      /** Where the announced prices sit now. */
      buyPosition: number;
      sellPosition: number;
      /** The prices that would take the lead back, when they can be derived. */
      priceToBeFirstBuy: number | null;
      priceToBeFirstSell: number | null;
    };

/** Same bank, same amount, same two prices means the same instruction. */
function sameInstruction(
  announced: AnnouncedPublication | null,
  cell: MakerMatrixCell,
  pairing: MakerPairing
): boolean {
  return (
    announced !== null &&
    announced.bank === cell.bank &&
    announced.amountKey === cell.amountKey &&
    announced.buyPrice === pairing.buy.price &&
    announced.sellPrice === pairing.sell.price
  );
}

export function evaluateMakerAlerts(params: {
  matrix: MakerMatrix;
  announced: AnnouncedPublication | null;
  best: MakerMatrixCell | null;
  nowMs: number;
}): { alerts: MakerAlert[]; announced: AnnouncedPublication | null } {
  const alerts: MakerAlert[] = [];
  let announced = params.announced;

  /*
   * The old instruction first. It is about a price the operator may have
   * already published, so it matters even when a better cell exists elsewhere.
   */
  if (announced !== null) {
    const cell = params.matrix.cells[announced.bank]?.[announced.amountKey];
    const rec = cell?.recommendation ?? null;
    if (cell !== undefined && rec !== null) {
      const buyPosition = estimatePosition(announced.buyPrice, rec.buyAnalysis);
      const sellPosition = estimatePosition(announced.sellPrice, rec.sellAnalysis);
      if (buyPosition > announced.buyPosition || sellPosition > announced.sellPosition) {
        alerts.push({
          kind: 'DISPLACED',
          announced,
          cell,
          buyPosition,
          sellPosition,
          priceToBeFirstBuy: rec.priceToBeFirstBuy,
          priceToBeFirstSell: rec.priceToBeFirstSell,
        });
        /*
         * The recorded positions move with reality. Without this the same
         * displacement is re-announced on every refresh until the operator
         * republishes, which is exactly the stream this module exists to avoid.
         */
        announced = { ...announced, buyPosition, sellPosition };
      }
    }
  }

  const best = params.best;
  const pairing = best?.recommendation?.recommended ?? null;

  if (best !== null && pairing !== null && !sameInstruction(announced, best, pairing)) {
    alerts.push({ kind: 'PUBLISH', cell: best, pairing });
    announced = {
      bank: best.bank,
      bankDisplayName: best.bankDisplayName,
      amountKey: best.amountKey,
      amountVes: best.amountVes,
      buyPrice: pairing.buy.price,
      sellPrice: pairing.sell.price,
      buyPosition: pairing.buy.position,
      sellPosition: pairing.sell.position,
      grossMarginVes: pairing.grossMarginVes,
      announcedAt: params.nowMs,
    };
  }

  return { alerts, announced };
}
