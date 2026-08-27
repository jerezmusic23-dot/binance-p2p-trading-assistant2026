/**
 * THE MATRIX THE OPERATOR ACTUALLY ASKED FOR: BANCO x MONTO, and for each
 * cell, the price to publish on each side and the margin between them.
 *
 * PURE TRANSFORMATION. Every price in here was decided by makerRecommendation
 * over a captured book; this module only arranges the answers and attaches the
 * one thing the pure engine cannot know - how old the book is.
 *
 * WHAT REPLACES WHAT
 *
 * The executable matrix answered "could I take an ad at this bank and amount?".
 * That is the taker's question, and it is not the operator's: they publish ads.
 * This matrix answers "what price should MY ad carry at this bank and amount,
 * and what does the pair of prices leave me?". The two matrices are different
 * questions over the same captured book, so both can be served without a
 * single extra request to Binance.
 */

import {
  buildMakerRecommendation,
  type CapturedListings,
  type MakerRecommendation,
} from './makerRecommendation.js';
import type { MakerConfig } from './makerStrategy.js';

/** How old a cell's book may be before the interface must say so. */
export const MAKER_MATRIX_STALE_AFTER_MS = 45_000 * 7;

export type MakerCellStatus =
  /** A price to publish on both sides, leading both ladders. */
  | 'PUBLISH_AT_TOP'
  /** A price to publish, but not at the top: leading loses money here. */
  | 'PUBLISH_DEEPER'
  /** Real ladders on both sides, and no depth in them pays. */
  | 'NO_MARGIN'
  /** Not enough captured market to derive a price. Never a number instead. */
  | 'NO_DATA'
  /** Binance did not answer for this bank on this tier's sweep. */
  | 'FETCH_FAILED'
  /** The book behind this cell is older than one full sweep. */
  | 'STALE';

export interface MakerMatrixCell {
  bank: string;
  bankDisplayName: string;
  amountKey: string;
  amountVes: number;
  status: MakerCellStatus;
  /** Null only when the bank was never captured for this tier. */
  recommendation: MakerRecommendation | null;
  capturedAt: number;
  ageSeconds: number;
  /** Ads Binance returned for each listing, before any relevance test. */
  adsReturned: { buyListing: number; sellListing: number };
  reason: string | null;
}

export interface MakerMatrix {
  capturedAt: number;
  ageSeconds: number;
  stale: boolean;
  staleAfterSeconds: number;
  bankOrder: string[];
  bankDisplayNames: Record<string, string>;
  amountKeys: string[];
  cells: Record<string, Record<string, MakerMatrixCell>>;
  /** The configuration the recommendations were produced under. */
  config: MakerConfig;
}

/**
 * Status from the recommendation, never from a second opinion.
 *
 * The matrix used to decide a cell's status with its own reading of the
 * numbers, and the day rounding made the two readings differ the dashboard
 * said NO_OPPORTUNITY while Telegram announced one. The status is now derived
 * from the recommendation object itself, so the two cannot disagree.
 */
function statusFor(rec: MakerRecommendation, stale: boolean, failed: boolean): MakerCellStatus {
  if (failed) return 'FETCH_FAILED';
  if (stale) return 'STALE';
  switch (rec.basis) {
    case 'FIRST_POSITION_PROFITABLE':
      return 'PUBLISH_AT_TOP';
    case 'DEEPER_POSITION_REQUIRED':
      return 'PUBLISH_DEEPER';
    case 'NO_PROFITABLE_POSITION':
      return 'NO_MARGIN';
    case 'INSUFFICIENT_DATA':
      return 'NO_DATA';
  }
}

export function buildMakerCell(params: {
  bank: string;
  bankDisplayName: string;
  amountKey: string;
  amountVes: number;
  listings: CapturedListings | null;
  bankAllowedCodes: readonly string[];
  capturedAt: number;
  nowMs: number;
  failed: boolean;
  config?: MakerConfig;
}): MakerMatrixCell {
  const ageSeconds = Math.max(0, Math.round((params.nowMs - params.capturedAt) / 1000));
  const stale = params.nowMs - params.capturedAt > MAKER_MATRIX_STALE_AFTER_MS;

  const base = {
    bank: params.bank,
    bankDisplayName: params.bankDisplayName,
    amountKey: params.amountKey,
    amountVes: params.amountVes,
    capturedAt: params.capturedAt,
    ageSeconds,
  };

  if (params.listings === null) {
    return {
      ...base,
      status: params.failed ? 'FETCH_FAILED' : 'NO_DATA',
      recommendation: null,
      adsReturned: { buyListing: 0, sellListing: 0 },
      reason: params.failed
        ? `Binance no respondió para ${params.bankDisplayName} en este monto.`
        : `Todavía no se ha capturado ${params.bankDisplayName} para ${params.amountKey}.`,
    };
  }

  const recommendation = buildMakerRecommendation({
    bank: params.bankDisplayName,
    amountVes: params.amountVes,
    listings: params.listings,
    bankAllowedCodes: params.bankAllowedCodes,
    capturedAt: params.capturedAt,
    config: params.config,
  });

  return {
    ...base,
    status: statusFor(recommendation, stale, params.failed),
    recommendation,
    adsReturned: {
      buyListing: recommendation.buyAnalysis.adsExamined,
      sellListing: recommendation.sellAnalysis.adsExamined,
    },
    reason: recommendation.reason,
  };
}

export function buildMakerMatrix(params: {
  bankOrder: string[];
  bankDisplayNames: Record<string, string>;
  bankAllowedCodes: Record<string, readonly string[]>;
  amounts: { key: string; val: number }[];
  /** listingsByTier[amountKey][bank] - each tier keeps its own captured book. */
  listingsByTier: Record<string, Record<string, CapturedListings>>;
  failedBanksByTier: Record<string, ReadonlySet<string>>;
  capturedAtByTier: Record<string, number>;
  capturedAt: number;
  config: MakerConfig;
  nowMs?: number;
}): MakerMatrix {
  const nowMs = params.nowMs ?? Date.now();
  const cells: Record<string, Record<string, MakerMatrixCell>> = {};

  for (const bank of params.bankOrder) {
    cells[bank] = {};
    for (const amount of params.amounts) {
      /*
       * A tier never captured yet has no capturedAt. 0 makes it maximally old,
       * so it reports its own emptiness rather than borrowing another tier's
       * freshness; the rotating sweep fills it within six ticks.
       */
      const capturedAt = params.capturedAtByTier[amount.key] ?? 0;
      cells[bank][amount.key] = buildMakerCell({
        bank,
        bankDisplayName: params.bankDisplayNames[bank] ?? bank,
        amountKey: amount.key,
        amountVes: amount.val,
        listings: params.listingsByTier[amount.key]?.[bank] ?? null,
        bankAllowedCodes: params.bankAllowedCodes[bank] ?? [],
        capturedAt,
        nowMs,
        failed: params.failedBanksByTier[amount.key]?.has(bank) ?? false,
        config: params.config,
      });
    }
  }

  return {
    capturedAt: params.capturedAt,
    ageSeconds: Math.max(0, Math.round((nowMs - params.capturedAt) / 1000)),
    stale: nowMs - params.capturedAt > MAKER_MATRIX_STALE_AFTER_MS,
    staleAfterSeconds: MAKER_MATRIX_STALE_AFTER_MS / 1000,
    bankOrder: params.bankOrder,
    bankDisplayNames: params.bankDisplayNames,
    amountKeys: params.amounts.map((a) => a.key),
    cells,
    config: params.config,
  };
}

/**
 * The single best cell to act on right now, or null.
 *
 * Ranked by MARGEN BRUTO per USDT at the recommended pair. A cell with no
 * recommendation is not ranked at all - it has no price to act on.
 */
export function selectBestMakerCell(matrix: MakerMatrix): MakerMatrixCell | null {
  let best: MakerMatrixCell | null = null;
  let bestMargin = 0;

  for (const bank of matrix.bankOrder) {
    for (const amountKey of matrix.amountKeys) {
      const cell = matrix.cells[bank]?.[amountKey];
      const pair = cell?.recommendation?.recommended;
      if (cell === undefined || pair === undefined || pair === null) continue;
      if (cell.status !== 'PUBLISH_AT_TOP' && cell.status !== 'PUBLISH_DEEPER') continue;
      if (pair.grossMarginVes > bestMargin) {
        best = cell;
        bestMargin = pair.grossMarginVes;
      }
    }
  }

  return best;
}
