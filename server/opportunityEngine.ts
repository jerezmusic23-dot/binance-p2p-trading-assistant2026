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

import { arbitrageSpreadPct, arbitrageSpreadVes } from './arbitrageSides.js';
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
  /*
   * READS cell.pair, NEVER the two per-side bests.
   *
   * bestExecutableBuy and bestExecutableSell are each chosen on their own
   * side's terms, and two independently-chosen legs are not an operation: the
   * USDT the sell leg must move is set by the BUY leg's price, so the pair has
   * to be verified jointly. cell.pair is the only field where that has been
   * done, and building an Opportunity from anything else is how a pair nobody
   * could execute reached Telegram.
   */
  if (cell.pair === null) return null;
  const buy: ExecutableQuote | null = cell.pair.buy;
  const sell: ExecutableQuote | null = cell.pair.sell;

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
  /*
   * Computed by arbitrageSides.ts, which owns the formula. Two copies of a
   * sign convention is one copy too many.
   */
  const spreadAbsolute = arbitrageSpreadVes(buyPrice, sellPrice);
  const spreadPct = arbitrageSpreadPct(buyPrice, sellPrice);

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
    /*
     * The same two numbers under names that cannot be misread. buyPrice and
     * sellPrice stay because the persisted history and every existing consumer
     * use them; these are what new code and every human-facing surface read,
     * because "buyPrice" alone has meant two different things to two readers
     * and that is precisely the defect.
     */
    arbitrageBuyPrice: buyPrice,
    arbitrageSellPrice: sellPrice,
    buyAdvNo: buy.advNo,
    sellAdvNo: sell.advNo,
    spreadAbsolute,
    spreadPct,
    // Gross, by definition: no commission or operating cost is modelled here,
    // and none is invented.
    marginAbsolute: spreadAbsolute,
    marginPct: spreadPct,
    /*
     * The same operation expressed as money rather than as a rate.
     *
     * usdtTraded is what the buy leg obtains for this tier, so multiplying by
     * the VES gained per USDT gives the gross margin of the whole operation.
     * Nothing new is measured: it is amountVes x spreadPct / 100 rearranged.
     */
    marginVes: cell.pair.usdtTraded * spreadAbsolute,
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
 * Picks the best operation among VERIFIED, PROFITABLE opportunities only.
 *
 * THE POLICY, AND IT IS A BUSINESS DECISION RATHER THAN A FACT ABOUT THE BOOK:
 *
 *   1. FULLY EXECUTABLE     verification VERIFIED, and a strictly positive
 *                           margin. Everything else is not a candidate at all.
 *   2. HIGHER marginVes     the gross margin of the whole operation, in money.
 *   3. HIGHER marginPct     the rate, as the secondary criterion.
 *   4-7. price, bank order, amount - only to make the answer total.
 *
 * WHY THE MONEY COMES FIRST. marginPct is a rate and says nothing about how
 * much the operation makes, and the tiers differ by a factor of ten:
 *
 *     3,00% on  10.000 VES  ->    300 VES
 *     2,90% on 100.000 VES  ->  2.900 VES
 *
 * Ranking on the rate answered "the 10.000 one" for a difference of a tenth of
 * a point, and gave up 2.600 VES to do it. When both are fully executable the
 * larger operation is worth more, and that is the whole of the argument.
 *
 * WHAT IS NOT A CRITERION ANY MORE: availableUsdt. It used to break ties on
 * "more liquidity is better", and surplus liquidity is not profit - the
 * operation consumes what the tier requires and executability has already
 * checked that the volume covers it. A seller holding ten times what the
 * operation needs earns exactly the same as one holding just enough.
 *
 * Fully determined by the data: no clock, no arrival order, no randomness.
 * `bankOrder` supplies criterion 6; a bank absent from it sorts last, by name,
 * so the result stays deterministic even for an unknown bank.
 *
 * CHANGING THIS MEANS CHANGING tests/opportunityPairing.test.ts, deliberately.
 */
export function selectBestOpportunity(
  opportunities: readonly Opportunity[],
  bankOrder: readonly string[] = []
): Opportunity | null {
  // Position in the canonical bank order - criterion 5. This is an index,
  // not a score: it ranks nothing about the quality of the operation.
  const bankOrderIndex = (bank: string) => {
    const i = bankOrder.indexOf(bank);
    return i === -1 ? bankOrder.length : i;
  };

  let best: Opportunity | null = null;

  for (const candidate of opportunities) {
    if (candidate.verification !== 'VERIFIED') continue;
    /*
     * A loss is not an opportunity, and neither is break-even.
     *
     * The selector used to rank on margin alone, so in an inverted market it
     * returned the least bad loss and Telegram announced it as the best
     * operation available. Zero is excluded too: break-even before Binance
     * commission, transfer fees and slippage is a loss once they are paid.
     *
     * Negative cells stay in `opportunities` and `byBank` - they are the real
     * state of the market. They just cannot be the answer to "what should I
     * trade right now".
     */
    if (candidate.marginPct <= 0) continue;
    if (best === null) {
      best = candidate;
      continue;
    }
    if (isBetter(candidate, best, bankOrderIndex)) best = candidate;
  }

  return best;
}

function isBetter(
  a: Opportunity,
  b: Opportunity,
  bankOrderIndex: (bank: string) => number
): boolean {
  // THE MONEY FIRST. See the policy note on selectBestOpportunity.
  if (a.marginVes !== b.marginVes) return a.marginVes > b.marginVes;

  // The rate second: between two operations worth the same, the cheaper one
  // to run is the one that commits less capital for it.
  if (a.marginPct !== b.marginPct) return a.marginPct > b.marginPct;

  /*
   * availableUsdt USED TO BE THE SECOND CRITERION, and it is gone. Surplus
   * liquidity is not profit: the operation moves what the tier requires, and
   * executability has already established the volume covers it.
   */
  if (a.buyPrice !== b.buyPrice) return a.buyPrice < b.buyPrice;
  if (a.sellPrice !== b.sellPrice) return a.sellPrice > b.sellPrice;

  const aOrder = bankOrderIndex(a.bank);
  const bOrder = bankOrderIndex(b.bank);
  if (aOrder !== bOrder) return aOrder < bOrder;
  if (a.bank !== b.bank) return a.bank < b.bank;

  return a.amountVes < b.amountVes;
}

function toContext(cell: BankAmountExecutability): OpportunityContext {
  return {
    bank: cell.bank,
    amountVes: cell.amountVes,
    /*
     * When both sides hold executable ads and no pair can move the same USDT,
     * the per-side reasons are both null and the cell would explain nothing.
     * noPairReason is the answer in exactly that case.
     */
    buyReason: cell.buyReason ?? (cell.pair === null ? cell.noPairReason : null),
    sellReason: cell.sellReason ?? (cell.pair === null ? cell.noPairReason : null),
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
