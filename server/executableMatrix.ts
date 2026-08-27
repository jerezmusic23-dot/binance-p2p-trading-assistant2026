/**
 * The executable matrix: BANK x AMOUNT, and nothing else.
 *
 * This module is PURE TRANSFORMATION. It computes no price, applies no filter
 * and decides no executability - all of that already happened in evaluateAd
 * and evaluateBankTiers, and duplicating any of it here would create a second
 * definition free to drift from the first. What this module does is give the
 * result a shape an interface can render without having to re-derive anything,
 * and attach the one thing the pure evaluator cannot know: how old the book is.
 *
 * WHY IT EXISTS
 *
 * The matrix the dashboard used to show was built from a different filter -
 * ads whose min/max bracketed the amount, with no bank verification and no
 * liquidity check - and its "spread" column was the 0.01 VES undercut of the
 * leader expressed as a percentage, a number near 0.001% that measured
 * nothing. Two answers over the same ads, and the interface showed the wrong
 * one. There is now one answer.
 *
 * THE RULE
 *
 *   A rate is executable only if a real ad, verified as this bank's, accepts
 *   this amount and published volume that covers it. Anything else has a name
 *   saying what is missing, never a number standing in for it.
 */

import { buildOpportunity } from './opportunityEngine.js';
import type {
  BankAmountExecutability,
  CellStatus,
  DataProvenance,
  ExecutableCell,
  ExecutableMatrix,
  ExecutableQuote,
  ExecutableSideView,
  LiquidityStatus,
  MarketReference,
  MarketSnapshot,
  Opportunity,
} from './types.js';

/**
 * How old the captured book may be and still be presented as executable.
 *
 * Not a new number: it is the bank-matrix cache TTL that already governed how
 * often refreshBankMatrix re-queries Binance. A cell can never be fresher than
 * the cache that produced it, so the same window decides both.
 */
export const MATRIX_REFRESH_MS = 45_000;

/**
 * How old a CELL may be and still be presented as executable.
 *
 * Longer than the refresh interval on purpose. Each refresh asks Binance about
 * one amount tier - the tier it is about to evaluate, so the ads it gets back
 * are the ads that actually accept that amount - and the six-tier sweep
 * therefore takes six ticks. A cell is at most one full sweep old, plus one
 * tick of margin, and its own capturedAt says exactly how old it is.
 *
 * The alternative was asking for all six tiers every tick: 84 requests every
 * 45s instead of 14, a different rate-limit risk for freshness nobody needs at
 * this cadence.
 */
export const MATRIX_STALE_AFTER_MS = MATRIX_REFRESH_MS * 7;

function toSideView(quote: ExecutableQuote | null): ExecutableSideView | null {
  if (quote === null) return null;
  return {
    price: quote.price,
    advNo: quote.advNo,
    merchant: quote.merchant,
    payType: quote.payType,
    paymentMethod: quote.paymentMethod,
    availableUsdt: quote.availableUsdt,
    minAmountVes: quote.minAmountVes,
    maxAmountVes: quote.maxAmountVes,
    liquidityStatus: quote.liquidityStatus,
  };
}

/**
 * Diagnoses ONE leg that produced no executable quote.
 *
 * The order is deliberate and reports the most fundamental obstacle first: a
 * bank that cannot be established outranks a volume that is too small, because
 * until the bank is known the volume is about somebody else's ad.
 */
export function diagnoseSide(
  rejections: Record<string, number>,
  liquidity: Record<LiquidityStatus, number>,
  evaluatedAds: number
): CellStatus {
  if (evaluatedAds === 0) return 'NO_AD';

  // Cannot be established - never silently downgraded to a plain "no".
  if ((rejections.BANK_NOT_VERIFIABLE ?? 0) > 0) return 'NOT_VERIFIABLE';
  if ((rejections.LIQUIDITY_NOT_VERIFIABLE ?? 0) > 0) return 'NOT_VERIFIABLE';

  if ((rejections.LIQUIDITY_INSUFFICIENT ?? 0) > 0) {
    /*
     * Both arrive as LIQUIDITY_INSUFFICIENT, and they are not the same
     * situation. Nobody publishing any volume is a dead book; volume that
     * exists but is too small is a book that may cover a lower tier.
     */
    return liquidity.LIQUIDITY_VERIFIED === 0 ? 'NO_LIQUIDITY' : 'INSUFFICIENT_LIQUIDITY';
  }

  /*
   * What is left is AMOUNT_BELOW_MIN, AMOUNT_ABOVE_MAX, BANK_NOT_VERIFIED and
   * INVALID_PRICE: Binance answered, and none of the ads it returned is an ad
   * of this bank for this amount. That is an absent ad, stated as one.
   */
  return 'NO_AD';
}

const STATUS_REASONS: Record<CellStatus, (bank: string, amountVes: number) => string> = {
  EXECUTABLE: () => '',
  NO_OPPORTUNITY: (bank, amount) =>
    `Ambos lados son ejecutables en ${bank} para ${amount.toLocaleString('es-VE')} VES, ` +
    `pero la venta no supera a la recompra: el margen bruto es cero o negativo. ` +
    `Una pérdida no es una oportunidad.`,
  NO_LIQUIDITY: (bank, amount) =>
    `Hay anuncios de ${bank} que aceptan ${amount.toLocaleString('es-VE')} VES, pero ` +
    `ninguno publica volumen por encima de cero.`,
  INSUFFICIENT_LIQUIDITY: (bank, amount) =>
    `El volumen publicado por ${bank} no cubre ${amount.toLocaleString('es-VE')} VES. ` +
    `Un anuncio más barato con menos liquidez no sirve para este monto.`,
  NO_AD: (bank, amount) =>
    `Ningún anuncio verificado de ${bank} acepta ${amount.toLocaleString('es-VE')} VES.`,
  STALE: (bank) =>
    `El libro de ${bank} es más antiguo que la ventana de frescura. No se presenta como ejecutable.`,
  NOT_VERIFIABLE: (bank, amount) =>
    `No se puede establecer que estos anuncios sean de ${bank} o qué volumen tienen. ` +
    `Lo no verificable nunca se presenta como ejecutable para ${amount.toLocaleString('es-VE')} VES.`,
  ERROR: (bank) => `La consulta de ${bank} a Binance falló. No es lo mismo que un libro vacío.`,
};

/**
 * One BANK x AMOUNT cell.
 *
 * `failed` marks a bank whose Binance query threw. That is not an empty book
 * and must not be shown as one - a silent ERROR is how "no opportunities"
 * comes to look like a calm market.
 */
export function buildCell(params: {
  cell: BankAmountExecutability;
  bankDisplayName: string;
  amountKey: string;
  capturedAt: number;
  nowMs: number;
  failed?: boolean;
  buyAdsEvaluated: number;
  sellAdsEvaluated: number;
}): ExecutableCell {
  const { cell, bankDisplayName, amountKey, capturedAt, nowMs, failed } = params;
  const ageSeconds = Math.max(0, Math.round((nowMs - capturedAt) / 1000));
  const stale = nowMs - capturedAt > MATRIX_STALE_AFTER_MS;

  const buy = toSideView(cell.bestExecutableBuy);
  const sell = toSideView(cell.bestExecutableSell);

  const buyStatus: CellStatus =
    buy !== null
      ? 'EXECUTABLE'
      : diagnoseSide(cell.buyRejections, cell.buyLiquidity, params.buyAdsEvaluated);
  const sellStatus: CellStatus =
    sell !== null
      ? 'EXECUTABLE'
      : diagnoseSide(cell.sellRejections, cell.sellLiquidity, params.sellAdsEvaluated);

  /*
   * The operation's liquidity is the narrower leg. A 200 USDT sale and a
   * 20 USDT repurchase make a 20 USDT operation, not a 200 USDT one.
   */
  const availableUsdt =
    buy?.availableUsdt != null && sell?.availableUsdt != null
      ? Math.min(buy.availableUsdt, sell.availableUsdt)
      : null;

  /*
   * ONE representation of the operation, shared.
   *
   * The cell used to decide EXECUTABLE from its own spreadPct while the
   * engine built an Opportunity separately from the same data. Two
   * computations over one book can disagree, and they did. The cell now
   * carries the very object the engine produces, so the matrix, the card and
   * Telegram read identical prices by construction rather than by luck.
   */
  const opportunity: Opportunity | null = buildOpportunity(cell);

  let status: CellStatus;
  if (failed === true) {
    status = 'ERROR';
  } else if (stale) {
    /*
     * Staleness outranks everything below it. A price that was executable a
     * minute ago is a claim about a book nobody has looked at since.
     */
    status = 'STALE';
  } else if (buy !== null && sell !== null) {
    /*
     * SIGNED, and compared against zero. cell.spreadPct is
     * ((venta - recompra) / recompra) * 100 as computed by evaluateBankAmount.
     * A negative value stays negative and can never reach EXECUTABLE.
     */
    /*
     * Decided on the OPPORTUNITY, not on a second calculation. An operation is
     * executable exactly when the engine says it is: both legs executable,
     * liquidity verified on both, and a strictly positive margin. Break-even
     * is a loss once commission and transfer costs are paid.
     */
    status =
      opportunity !== null && opportunity.verification === 'VERIFIED' && opportunity.marginPct > 0
        ? 'EXECUTABLE'
        : 'NO_OPPORTUNITY';
  } else if (buy === null && sell === null) {
    // Both legs blocked: report the repurchase, the leg executed first.
    status = buyStatus;
  } else {
    status = buy === null ? buyStatus : sellStatus;
  }

  const provenance: DataProvenance =
    status === 'EXECUTABLE'
      ? 'EXECUTABLE'
      : status === 'NOT_VERIFIABLE' || status === 'ERROR'
      ? 'NOT_VERIFIABLE'
      : 'REAL';

  return {
    bank: cell.bank,
    bankDisplayName,
    amountKey,
    amountVes: cell.amountVes,
    status,
    reason: status === 'EXECUTABLE' ? null : STATUS_REASONS[status](bankDisplayName, cell.amountVes),
    buy,
    sell,
    spreadPct: cell.spreadPct,
    availableUsdt,
    /*
     * The operation itself, or null. Whatever reads this cell reads the same
     * prices the notifier sends - there is nothing left to recompute.
     */
    opportunity,
    buyStatus,
    sellStatus,
    buyReason: cell.buyReason,
    sellReason: cell.sellReason,
    buyRejections: cell.buyRejections,
    sellRejections: cell.sellRejections,
    capturedAt,
    ageSeconds,
    provenance,
  };
}

/**
 * The whole matrix, from the executability already computed per bank.
 *
 * Banks and amounts are keyed by NAME throughout - never by array position.
 * The bank queries run concurrently, so a cell that found its bank by index
 * would silently attribute one bank's book to another the first time a
 * response arrived out of order.
 */
export function buildExecutableMatrix(params: {
  byBank: Record<string, Record<string, BankAmountExecutability>>;
  bankOrder: string[];
  bankDisplayNames: Record<string, string>;
  amountKeys: string[];
  /** adCountsByTier[amountKey][bank] - each tier has its own captured book. */
  adCountsByTier: Record<string, Record<string, { buy: number; sell: number }>>;
  failedBanksByTier: Record<string, ReadonlySet<string>>;
  capturedAtByTier: Record<string, number>;
  /** Newest capture across all tiers, for the matrix header. */
  capturedAt: number;
  nowMs?: number;
}): ExecutableMatrix {
  const nowMs = params.nowMs ?? Date.now();
  const cells: Record<string, Record<string, ExecutableCell>> = {};

  for (const bank of params.bankOrder) {
    cells[bank] = {};
    const tiers = params.byBank[bank] ?? {};

    for (const amountKey of params.amountKeys) {
      const cell = tiers[amountKey];
      if (cell === undefined) continue;

      const counts = params.adCountsByTier[amountKey]?.[bank] ?? { buy: 0, sell: 0 };
      /*
       * A tier never captured yet has no capturedAt. 0 makes it maximally old,
       * so it reports STALE rather than borrowing another tier's freshness -
       * the sweep fills it within six ticks and it says so meanwhile.
       */
      const capturedAt = params.capturedAtByTier[amountKey] ?? 0;

      cells[bank][amountKey] = buildCell({
        cell,
        bankDisplayName: params.bankDisplayNames[bank] ?? bank,
        amountKey,
        capturedAt,
        nowMs,
        failed: params.failedBanksByTier[amountKey]?.has(bank),
        buyAdsEvaluated: counts.buy,
        sellAdsEvaluated: counts.sell,
      });
    }
  }

  return {
    capturedAt: params.capturedAt,
    ageSeconds: Math.max(0, Math.round((nowMs - params.capturedAt) / 1000)),
    stale: nowMs - params.capturedAt > MATRIX_STALE_AFTER_MS,
    staleAfterSeconds: MATRIX_STALE_AFTER_MS / 1000,
    bankOrder: params.bankOrder,
    bankDisplayNames: params.bankDisplayNames,
    amountKeys: params.amountKeys,
    cells,
  };
}

/**
 * The global market, packaged so it cannot be mistaken for a quote.
 *
 * The field names carry the word reference, and `executable: false` travels
 * inside the payload. A consumer that renders this as a rate has to ignore
 * both, which is a much harder mistake to make by accident than reading a
 * field called bestBuyPrice.
 */
export function buildMarketReference(
  snapshot: MarketSnapshot | null,
  status: 'LIVE' | 'STALE' | 'OFFLINE',
  ageSeconds: number
): MarketReference {
  return {
    referenceBuyPrice: snapshot?.strategicBuyPrice ?? null,
    referenceSellPrice: snapshot?.strategicSellPrice ?? null,
    referenceSpreadPct: snapshot?.strategicSpreadPct ?? null,
    provenance: 'STRATEGIC',
    capturedAt: snapshot?.timestamp ?? 0,
    ageSeconds,
    status,
    executable: false,
    note:
      'Nivel mediano del libro completo, sin filtro de banco ni de monto. ' +
      'Es contexto de mercado: NADIE puede ejecutar a este precio. ' +
      'Las tasas ejecutables están en executableMatrix.',
  };
}
