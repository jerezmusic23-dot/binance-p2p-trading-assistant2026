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
 * ═══════════════════════════════════════════════════════════════════════
 * DOS ROLES, EL MISMO NÚMERO. LÉASE ESTO ANTES DE "CORREGIR" NADA AQUÍ.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Este módulo describe al TAKER: alguien que cruza el spread. Para él,
 * tradeType 'BUY' es de verdad una compra, porque paga el ask.
 *
 * El propietario también opera como MAKER, publicando anuncios, y en ese rol el
 * MISMO lado significa lo contrario:
 *
 *              tradeType='BUY' (el ask)      tradeType='SELL' (el bid)
 *   TAKER      compro, pago el ask           vendo, cobro el bid
 *   MAKER      publico mi VENTA aquí         publico mi COMPRA aquí
 *
 * Las dos lecturas son correctas: un maker que quiere vender compite con los
 * anuncios que devuelve 'BUY', porque son los rivales que verá su comprador.
 * Y por eso el maker gana el spread donde el taker lo paga.
 *
 * El mapa del maker vive en `projection/dailyShape.ts` (`LEG_BINANCE_SIDE`):
 *
 *   MI VENTA  = tradeType 'BUY'  = strategicBuyPrice  -> techo
 *   MI COMPRA = tradeType 'SELL' = strategicSellPrice -> piso
 *
 * NO renombrar `arbitrageBuyPrice` a "mi venta". Sería falso en este rol:
 * `isArbitrageOpportunity` compara la entrada contra la salida DEL TAKER, y
 * cambiarle el nombre invertiría el sentido de una comparación que decide si
 * una operación gana o pierde dinero. Los dos módulos no se contradicen; hablan
 * de dos operaciones distintas sobre el mismo libro.
 *
 * `tests/arbitrageSideSemantics.test.ts` fija que ambos mapas apuntan al mismo
 * lado de Binance, de modo que si alguien invierte uno de los dos, salta.
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
