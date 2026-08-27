/**
 * MAKER RECOMMENDATION — "at what price should I publish, on both sides?"
 *
 * Consumes two independent ladders (my buy-USDT competitors and my sell-USDT
 * competitors, each read from the mirror listing - see makerStrategy.ts) and
 * turns them into publishable prices plus the gross margin those prices imply.
 *
 * NO FIXED MARGIN CONSTANT LIVES HERE.
 *
 * There is exactly one number this module compares against, and it is zero:
 * break-even. Zero is arithmetic, not a tuned parameter - below it I would
 * publish a pair of ads that loses VES on every completed round trip. Anything
 * else ("at least 0.30%", "at least 0.50%") would be a number nobody measured,
 * so it is not here.
 *
 * WHY POSITION k IS PAIRED WITH POSITION k
 *
 * Margin is non-decreasing with depth on each side taken alone: sitting one
 * place further back on the buy ladder means I only have to beat a cheaper
 * buyer, so I buy cheaper; one place further back on the sell ladder means I
 * only have to undercut a dearer seller, so I sell dearer. Therefore, among all
 * pairs whose two positions are both within depth d, the highest margin is
 * always the pair (d, d). The diagonal is the efficient frontier, not a
 * simplification.
 *
 * WHAT DEPTH ACTUALLY COSTS
 *
 * Sitting deeper earns more per trade and gets chosen less often. The project
 * has no fill-rate data, and inventing a fill probability would be inventing
 * data. What the capture does contain is the volume queued ahead of me, so that
 * is what is reported: to reach my ad at position k, counterparties must first
 * consume the advertised volume of the k-1 ads in front. When any of those ads
 * publishes no volume the total is null - never 0 standing in for unknown.
 *
 * The operator makes the depth call with those real numbers. The engine only
 * refuses to recommend a losing pair.
 */

import {
  analyseMakerSide,
  listingForMakerSide,
  makerSideDefinition,
  type MakerConfig,
  type MakerSide,
  type MakerSideAnalysis,
} from './makerStrategy.js';
import type { NormalizedAd } from './types.js';

/* ------------------------------------------------------------------------ *
 * ONE PUBLISHABLE PRICE
 * ------------------------------------------------------------------------ */

export interface PricePoint {
  side: MakerSide;
  /** Where my ad would sit once published at this price. */
  position: number;
  /** What I publish. Derived from a real ad's price plus one observed tick. */
  price: number;
  /** The competing ad this price steps ahead of. */
  beatsAdvNo: string;
  beatsPrice: number;
  beatsMerchant: string;
  /** How far behind the leader I would be, in VES. 0 at position 1. */
  gapBehindLeader: number;
  /**
   * Advertised volume queued ahead of me, in USDT. null when at least one ad
   * ahead published no volume: unknown stays unknown.
   */
  queueAheadUsdt: number | null;
  queueAheadVerifiable: boolean;
}

/* ------------------------------------------------------------------------ *
 * ONE PAIR OF PRICES AND THE MARGIN BETWEEN THEM
 * ------------------------------------------------------------------------ */

export interface MakerPairing {
  /** Depth on both sides. 1 means "first on both ladders". */
  position: number;
  buy: PricePoint;
  sell: PricePoint;
  /**
   * MARGEN BRUTO, VES per USDT, signed. Never an absolute value: a pair that
   * loses money must read negative. Gross - Binance fees, taxes and the risk
   * of one leg never filling are not modelled here.
   */
  grossMarginVes: number;
  /** The same margin over the price I would pay. null if that price is not > 0. */
  grossMarginPct: number | null;
}

export type RecommendationBasis =
  /** Leading both ladders already pays. Publish at the top. */
  | 'FIRST_POSITION_PROFITABLE'
  /** Leading both ladders loses money; a deeper pair is the shallowest that pays. */
  | 'DEEPER_POSITION_REQUIRED'
  /** No depth in the captured ladders produces a positive margin. */
  | 'NO_PROFITABLE_POSITION'
  /** One or both sides have no observable competition to price against. */
  | 'INSUFFICIENT_DATA';

export interface MakerRecommendation {
  bank: string;
  amountVes: number;
  capturedAt: number;

  buyAnalysis: MakerSideAnalysis;
  sellAnalysis: MakerSideAnalysis;

  /**
   * The price that makes me #1 on each ladder. ALWAYS reported, including when
   * the engine recommends something else - the operator asked to never lose
   * sight of it.
   */
  priceToBeFirstBuy: number | null;
  priceToBeFirstSell: number | null;
  /** The pair at position 1, whatever its margin. null if either ladder is empty. */
  firstPositionPairing: MakerPairing | null;

  /** The shallowest pair with a positive margin, or null if none exists. */
  recommended: MakerPairing | null;
  basis: RecommendationBasis;

  /** Every depth the captured ladders support, shallowest first. */
  alternatives: readonly MakerPairing[];
  /** The deepest pair examined - the most margin the capture can evidence. */
  bestMarginPairing: MakerPairing | null;

  reason: string | null;
}

/* ------------------------------------------------------------------------ *
 * BUILDING THE PRICE POINTS
 * ------------------------------------------------------------------------ */

/**
 * Turns a ladder into the prices I could publish, one per depth.
 *
 * To sit at position k I must step ahead of the ad currently at position k,
 * which is exactly the priceToBeat the ladder already carries.
 */
function pricePoints(analysis: MakerSideAnalysis): PricePoint[] {
  const points: PricePoint[] = [];
  let queue = 0;
  let queueVerifiable = true;

  analysis.ladder.forEach((entry, index) => {
    // No established price step means no publishable price. See deriveTick.
    if (entry.priceToBeat === null) return;
    points.push({
      side: analysis.side,
      position: index + 1,
      price: entry.priceToBeat,
      beatsAdvNo: entry.advNo,
      beatsPrice: entry.price,
      beatsMerchant: entry.merchant,
      gapBehindLeader: entry.deltaFromLeader,
      queueAheadUsdt: queueVerifiable ? Number(queue.toFixed(8)) : null,
      queueAheadVerifiable: queueVerifiable,
    });

    // Volume of THIS ad joins the queue that the NEXT position sits behind.
    if (entry.availableUsdt === null) queueVerifiable = false;
    else queue += entry.availableUsdt;
  });

  return points;
}

/**
 * MARGEN BRUTO between the two prices I would publish.
 *
 * Buying costs buy.price VES per USDT and selling returns sell.price, so the
 * difference is what a completed round trip leaves per USDT. Signed, always.
 */
function pairAt(position: number, buy: PricePoint, sell: PricePoint): MakerPairing {
  const grossMarginVes = Number((sell.price - buy.price).toFixed(8));
  return {
    position,
    buy,
    sell,
    grossMarginVes,
    grossMarginPct: buy.price > 0 ? (grossMarginVes / buy.price) * 100 : null,
  };
}

/** Names which of the two things a side is missing, rather than lumping them. */
function sideBlockReason(analysis: MakerSideAnalysis): string {
  if (analysis.tickProvenance === 'NOT_VERIFIABLE') {
    return `${analysis.definition.label}: el paso de precio no se puede establecer con lo capturado.`;
  }
  return `${analysis.definition.label}: sin competencia observable.`;
}

/* ------------------------------------------------------------------------ *
 * THE RECOMMENDATION
 * ------------------------------------------------------------------------ */

/**
 * Ads as they come off the wire, keyed by the tradeType they were REQUESTED
 * with. Keyed this way on purpose: naming them "buy ads" and "sell ads" is
 * what lets a caller hand the wrong book to the wrong side, so the caller
 * states which Binance listing each came from and this module - the only place
 * that knows the mirror - does the rest.
 */
export interface CapturedListings {
  BUY: readonly NormalizedAd[];
  SELL: readonly NormalizedAd[];
}

export function buildMakerRecommendation(params: {
  bank: string;
  amountVes: number;
  listings: CapturedListings;
  bankAllowedCodes: readonly string[];
  capturedAt: number;
  config?: MakerConfig;
}): MakerRecommendation {
  const buyAnalysis = analyseMakerSide({
    side: 'MAKER_BUY',
    bank: params.bank,
    amountVes: params.amountVes,
    ads: params.listings[listingForMakerSide('MAKER_BUY')],
    bankAllowedCodes: params.bankAllowedCodes,
    capturedAt: params.capturedAt,
    config: params.config,
  });

  const sellAnalysis = analyseMakerSide({
    side: 'MAKER_SELL',
    bank: params.bank,
    amountVes: params.amountVes,
    ads: params.listings[listingForMakerSide('MAKER_SELL')],
    bankAllowedCodes: params.bankAllowedCodes,
    capturedAt: params.capturedAt,
    config: params.config,
  });

  const buyPoints = pricePoints(buyAnalysis);
  const sellPoints = pricePoints(sellAnalysis);

  const base = {
    bank: params.bank,
    amountVes: params.amountVes,
    capturedAt: params.capturedAt,
    buyAnalysis,
    sellAnalysis,
    priceToBeFirstBuy: buyAnalysis.priceToBeFirst,
    priceToBeFirstSell: sellAnalysis.priceToBeFirst,
  };

  /*
   * A side with no competitors gives me nothing to price against. Publishing a
   * number anyway would be inventing a market, so the recommendation is
   * withheld and the missing side is named.
   */
  const depth = Math.min(buyPoints.length, sellPoints.length);
  if (depth === 0) {
    const blocked: string[] = [];
    if (buyPoints.length === 0) blocked.push(sideBlockReason(buyAnalysis));
    if (sellPoints.length === 0) blocked.push(sideBlockReason(sellAnalysis));
    return {
      ...base,
      firstPositionPairing: null,
      recommended: null,
      basis: 'INSUFFICIENT_DATA',
      alternatives: [],
      bestMarginPairing: null,
      reason: `${blocked.join(' ')} No se publica un precio sin mercado de referencia (${params.bank}, ${params.amountVes.toLocaleString('es-VE')} VES).`,
    };
  }

  const alternatives: MakerPairing[] = [];
  for (let i = 0; i < depth; i += 1) {
    alternatives.push(pairAt(i + 1, buyPoints[i], sellPoints[i]));
  }

  const firstPositionPairing = alternatives[0];
  const bestMarginPairing = alternatives[alternatives.length - 1];

  // Break-even, and nothing else, decides whether a pair is publishable.
  const recommended = alternatives.find((p) => p.grossMarginVes > 0) ?? null;

  if (recommended === null) {
    return {
      ...base,
      firstPositionPairing,
      recommended: null,
      basis: 'NO_PROFITABLE_POSITION',
      alternatives,
      bestMarginPairing,
      reason: `Ninguna de las ${alternatives.length} posiciones observadas deja margen positivo; la mejor (posición ${bestMarginPairing.position}) deja ${bestMarginPairing.grossMarginVes} VES por USDT.`,
    };
  }

  return {
    ...base,
    firstPositionPairing,
    recommended,
    basis: recommended.position === 1 ? 'FIRST_POSITION_PROFITABLE' : 'DEEPER_POSITION_REQUIRED',
    alternatives,
    bestMarginPairing,
    reason:
      recommended.position === 1
        ? null
        : `Ser #1 en ambos lados deja ${firstPositionPairing.grossMarginVes} VES por USDT; la posición ${recommended.position} es la menos profunda con margen positivo.`,
  };
}

/** Re-exported so callers never have to remember which listing feeds which side. */
export { listingForMakerSide };
