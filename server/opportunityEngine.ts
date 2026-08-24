/**
 * Opportunity engine: EXECUTABLE -> OPPORTUNITY.
 *
 *     RAW -> AGGREGATED -> VERIFIED -> EXECUTABLE -> OPPORTUNITY
 *
 * This module builds only the last arrow. It does NOT re-decide bank
 * membership, amount limits, price validity or liquidity - FASE 4 already
 * answered all of that, and duplicating it would create a second, divergent
 * definition of executability. Here we only SELECT among quotes that are
 * already EXECUTABLE.
 *
 * An Opportunity is a concrete operation: same bank, same amount, an
 * executable BUY and an executable SELL. The strategic median describes where
 * the market is; it never stands in for a price someone can actually trade at.
 *
 * PURE and DETERMINISTIC. No fetch, no filesystem, no Date, no global state,
 * no imports of storage, centralStore, Telegram, Express or React. It consumes
 * the SHAPE that CentralMarketStore.getExecutability() returns, so the store
 * can feed it without this module knowing the store exists.
 */

import {
  BankAmountExecutability,
  ExecutableQuote,
  Opportunity,
  OpportunityContext,
  OpportunityEngineResult,
} from './types.js';

/**
 * A quote may enter an Opportunity only if FASE 4 marked it EXECUTABLE.
 *
 * Defensive: `bestExecutableBuy`/`bestExecutableSell` are already filtered on
 * this, and `evaluateAd` cannot return EXECUTABLE with an unverifiable
 * liquidity (it rejects that case first). The guard exists so a future
 * relaxation of FASE 4 cannot silently promote a rejected ad into an
 * operation.
 */
function isExecutable(quote: ExecutableQuote | null): quote is ExecutableQuote {
  return quote !== null && quote.provenance === 'EXECUTABLE' && quote.rejection === null;
}

/**
 * Builds the Opportunity for ONE bank x amount cell, or null when there is none.
 *
 * Both sides come from the same cell, so they necessarily share the bank and
 * the amount: a BUY at Provincial can never meet a SELL at Banesco here, and
 * a 20K BUY can never meet a 30K SELL.
 *
 * No fallbacks. A missing side yields null - not the median, not the strategic
 * price, not the raw extreme, not a suggested price, not a historical value.
 */
export function buildOpportunity(cell: BankAmountExecutability): Opportunity | null {
  const buy = cell.bestExecutableBuy;
  const sell = cell.bestExecutableSell;

  if (!isExecutable(buy) || !isExecutable(sell)) return null;

  const buyPrice = buy.price;
  const sellPrice = sell.price;

  /*
   * Signed, and the denominator is ALWAYS the repurchase price.
   *
   * Deliberately NOT rounded to 2 decimals, unlike BankAmountExecutability
   * .spreadPct: real spreads in this market live in the third and fourth
   * decimal (0.0858%), and rounding would collapse genuinely different
   * opportunities into artificial ties during selection.
   */
  const spreadAbsolute = sellPrice - buyPrice;
  const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;

  const buyAvailableUsdt = buy.availableUsdt;
  const sellAvailableUsdt = sell.availableUsdt;

  // Common capacity of both legs. Unknown on either side means unknown, and
  // an unknown is never replaced by a number.
  const bothKnown = buyAvailableUsdt !== null && sellAvailableUsdt !== null;
  const availableUsdt = bothKnown ? Math.min(buyAvailableUsdt, sellAvailableUsdt) : null;

  const unverifiableSide =
    buyAvailableUsdt === null && sellAvailableUsdt === null
      ? 'ambos lados'
      : buyAvailableUsdt === null
        ? 'el lado de recompra (BUY)'
        : sellAvailableUsdt === null
          ? 'el lado de venta (SELL)'
          : null;

  return {
    bank: cell.bank,
    amountVes: cell.amountVes,
    buyPrice,
    sellPrice,
    buyAdvNo: buy.advNo,
    sellAdvNo: sell.advNo,
    spreadAbsolute,
    spreadPct,
    // Gross, by definition: no commission or operating cost is modelled here,
    // and none is invented.
    marginAbsolute: spreadAbsolute,
    marginPct: spreadPct,
    buyAvailableUsdt,
    sellAvailableUsdt,
    availableUsdt,
    verification: unverifiableSide === null ? 'VERIFIED' : 'NOT_VERIFIABLE',
    provenance: unverifiableSide === null ? 'EXECUTABLE' : 'NOT_VERIFIABLE',
    reason:
      unverifiableSide === null
        ? null
        : `No se pudo establecer la liquidez de ${unverifiableSide}. La operacion no es plenamente verificable.`,
  };
}

/**
 * Picks the best operation among VERIFIED opportunities only.
 *
 * A NOT_VERIFIABLE opportunity is never "the best" - an unestablished
 * liquidity is not a usable operation.
 *
 * Criteria, in order:
 *   1. higher marginPct
 *   2. higher availableUsdt
 *   3. lower buyPrice
 *   4. higher sellPrice
 *   5. canonical bank order
 *   6. smaller amount
 *
 * Fully determined by the data: no clock, no arrival order, no randomness.
 * `bankOrder` supplies criterion 5; a bank absent from it sorts last, by name,
 * so the result stays deterministic even for an unknown bank.
 */
export function selectBestOpportunity(
  opportunities: readonly Opportunity[],
  bankOrder: readonly string[] = []
): Opportunity | null {
  const rank = (bank: string) => {
    const i = bankOrder.indexOf(bank);
    return i === -1 ? bankOrder.length : i;
  };

  let best: Opportunity | null = null;

  for (const candidate of opportunities) {
    if (candidate.verification !== 'VERIFIED') continue;
    if (best === null) {
      best = candidate;
      continue;
    }
    if (isBetter(candidate, best, rank)) best = candidate;
  }

  return best;
}

function isBetter(
  a: Opportunity,
  b: Opportunity,
  rank: (bank: string) => number
): boolean {
  if (a.marginPct !== b.marginPct) return a.marginPct > b.marginPct;

  // VERIFIED implies both liquidities are known, so availableUsdt is a number.
  const aLiq = a.availableUsdt ?? 0;
  const bLiq = b.availableUsdt ?? 0;
  if (aLiq !== bLiq) return aLiq > bLiq;

  if (a.buyPrice !== b.buyPrice) return a.buyPrice < b.buyPrice;
  if (a.sellPrice !== b.sellPrice) return a.sellPrice > b.sellPrice;

  const aRank = rank(a.bank);
  const bRank = rank(b.bank);
  if (aRank !== bRank) return aRank < bRank;
  if (a.bank !== b.bank) return a.bank < b.bank;

  return a.amountVes < b.amountVes;
}

function toContext(cell: BankAmountExecutability): OpportunityContext {
  return {
    bank: cell.bank,
    amountVes: cell.amountVes,
    buyReason: cell.buyReason,
    sellReason: cell.sellReason,
    buyRejections: cell.buyRejections,
    sellRejections: cell.sellRejections,
  };
}

/**
 * Runs the engine over every BANK x AMOUNT cell.
 *
 * `byBank` is exactly the shape CentralMarketStore.getExecutability() returns.
 * Nothing here talks to Binance, disk or the store: the input is already the
 * answer FASE 4 computed from the book captured for the bank matrix, so this
 * adds zero requests.
 *
 * Rejections are preserved per cell, including cells that produced no
 * Opportunity - a rejected ad stays visible as a rejection and never becomes
 * an operation.
 */
export function runOpportunityEngine(params: {
  byBank: Record<string, Record<string, BankAmountExecutability>>;
  bankOrder?: readonly string[];
}): OpportunityEngineResult {
  const { byBank: executability, bankOrder = Object.keys(params.byBank) } = params;

  const opportunities: Opportunity[] = [];
  const byBank: Record<string, Record<string, Opportunity | null>> = {};
  const context: Record<string, Record<string, OpportunityContext>> = {};

  for (const bank of Object.keys(executability)) {
    byBank[bank] = {};
    context[bank] = {};

    for (const amountKey of Object.keys(executability[bank])) {
      const cell = executability[bank][amountKey];
      const opportunity = buildOpportunity(cell);

      byBank[bank][amountKey] = opportunity;
      context[bank][amountKey] = toContext(cell);
      if (opportunity !== null) opportunities.push(opportunity);
    }
  }

  return {
    opportunities,
    byBank,
    bestOpportunity: selectBestOpportunity(opportunities, bankOrder),
    context,
  };
}
