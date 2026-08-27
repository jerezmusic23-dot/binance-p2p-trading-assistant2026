/**
 * BINANCE  ->  MY OPERATION.  The only translation in the system.
 *
 * Every price the robot acts on passes through here. Nowhere else may decide
 * what a Binance ad means for the user, because the moment two places decide
 * it, one of them will eventually decide it backwards and every spread in the
 * system flips sign.
 *
 * THE RULE, STATED AS THE USER'S MONEY
 *
 *   An ad that SELLS USDT is an ad I can BUY from.
 *     -> it is an ASK
 *     -> it is my ENTRY
 *     -> arbitrageBuyPrice
 *     -> the best one is the CHEAPEST: I want to pay least
 *     -> Binance returns these for tradeType 'BUY'
 *
 *   An ad that BUYS USDT is an ad I can SELL into.
 *     -> it is a BID
 *     -> it is my EXIT
 *     -> arbitrageSellPrice
 *     -> the best one is the DEAREST: I want to receive most
 *     -> Binance returns these for tradeType 'SELL'
 *
 *   opportunity  <=>  arbitrageSellPrice > arbitrageBuyPrice
 *   spreadVes    =  arbitrageSellPrice - arbitrageBuyPrice
 *   spreadPct    = (spreadVes / arbitrageBuyPrice) * 100     signed, never abs
 *
 * WHY tradeType READS BACKWARDS AT FIRST GLANCE
 *
 * The parameter carries the SEARCHER's intent, not the advertiser's action.
 * Asking for tradeType 'BUY' is pressing "Buy USDT" on p2p.binance.com: it
 * returns the ads you buy FROM, whose advertisers are selling. Reading the
 * parameter as the advertiser's side is the inversion this module exists to
 * make impossible.
 *
 * HOW TO FALSIFY IT WITH DATA
 *
 * In a functioning market the ask sits at or above the bid, because crossing
 * costs the taker. Production medians: 945.75 on the tradeType 'BUY' side
 * against 944.75 on 'SELL' - ask above bid, so crossing costs 0.11%. If a
 * sustained observation ever shows the BID side above the ASK side, this
 * mapping is wrong and must be re-derived from that evidence.
 */

/** What the user does. The only vocabulary downstream code should use. */
export type ArbitrageLeg = 'ARBITRAGE_BUY' | 'ARBITRAGE_SELL';

/** Where the price sits in the book. */
export type BookSide = 'ASK' | 'BID';

/** The Binance API parameter. Kept at the edge, never used as a meaning. */
export type BinanceTradeType = 'BUY' | 'SELL';

export interface LegDefinition {
  leg: ArbitrageLeg;
  bookSide: BookSide;
  tradeType: BinanceTradeType;
  /** What the advertiser is doing, which is the opposite of what I do. */
  advertiserAction: 'VENDE USDT' | 'COMPRA USDT';
  /** What I do. */
  userAction: 'COMPRO USDT' | 'VENDO USDT';
  /** Which extreme of this side is the best price for me. */
  bestIs: 'LOWEST' | 'HIGHEST';
  /** Ready-to-render Spanish label. The UI must not invent its own. */
  label: string;
  sourceLabel: string;
}

const ARBITRAGE_BUY: LegDefinition = {
  leg: 'ARBITRAGE_BUY',
  bookSide: 'ASK',
  tradeType: 'BUY',
  advertiserAction: 'VENDE USDT',
  userAction: 'COMPRO USDT',
  bestIs: 'LOWEST',
  label: 'MI COMPRA',
  sourceLabel: 'Anuncio que VENDE USDT · Binance ASK · tradeType=BUY',
};

const ARBITRAGE_SELL: LegDefinition = {
  leg: 'ARBITRAGE_SELL',
  bookSide: 'BID',
  tradeType: 'SELL',
  advertiserAction: 'COMPRA USDT',
  userAction: 'VENDO USDT',
  bestIs: 'HIGHEST',
  label: 'MI VENTA',
  sourceLabel: 'Anuncio que COMPRA USDT · Binance BID · tradeType=SELL',
};

export const ARBITRAGE_LEGS: readonly LegDefinition[] = [ARBITRAGE_BUY, ARBITRAGE_SELL];

/**
 * The translation, in the direction the capture layer needs it: given an ad
 * fetched under a tradeType, which leg of MY operation is it?
 *
 * This is the function the whole rule reduces to. If it is ever wrong, every
 * price in the system is wrong, and exactly one place has to change.
 */
export function mapBinanceAdToArbitrageLeg(tradeType: BinanceTradeType): LegDefinition {
  return tradeType === 'BUY' ? ARBITRAGE_BUY : ARBITRAGE_SELL;
}

/** The same translation, asked from the other direction. */
export function legDefinition(leg: ArbitrageLeg): LegDefinition {
  return leg === 'ARBITRAGE_BUY' ? ARBITRAGE_BUY : ARBITRAGE_SELL;
}

/** Which tradeType to ask Binance for, to fill this leg. */
export function tradeTypeForLeg(leg: ArbitrageLeg): BinanceTradeType {
  return legDefinition(leg).tradeType;
}

/**
 * The spread of an operation, signed.
 *
 * Denominator is ALWAYS the entry price: it is the money actually committed.
 * Never absolute-valued - a loss that reads as a gain is the one failure this
 * project cannot have.
 */
export function arbitrageSpreadPct(
  arbitrageBuyPrice: number,
  arbitrageSellPrice: number
): number {
  return ((arbitrageSellPrice - arbitrageBuyPrice) / arbitrageBuyPrice) * 100;
}

export function arbitrageSpreadVes(
  arbitrageBuyPrice: number,
  arbitrageSellPrice: number
): number {
  return arbitrageSellPrice - arbitrageBuyPrice;
}

/**
 * Break-even is NOT an opportunity: zero margin before Binance commission,
 * bank transfer costs and slippage is a loss once they are paid.
 */
export function isArbitrageOpportunity(
  arbitrageBuyPrice: number,
  arbitrageSellPrice: number
): boolean {
  return arbitrageSellPrice > arbitrageBuyPrice;
}
