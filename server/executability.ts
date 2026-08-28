/**
 * Executability: can I actually run THIS operation, right now?
 *
 *     RAW -> VERIFIED BANK -> EXECUTABLE QUOTE
 *
 * An ad is a price on a screen. A quote is a price I can actually transact at,
 * for a specific bank, a specific amount and a specific side. Turning the
 * first into the second is what stops an isolated 980 VES ad from looking like
 * an opportunity: being extreme is not being executable.
 *
 * RECOMPRA = Binance BUY  : what I pay to acquire USDT. Best = LOWEST price.
 * VENTA    = Binance SELL : what I receive selling USDT.  Best = HIGHEST price.
 *
 * The load-bearing rule of this module: a condition that could not be
 * ESTABLISHED is never treated as satisfied. An unverifiable bank and an
 * unpublished volume both produce NOT_VERIFIABLE, never EXECUTABLE.
 *
 * Pure module: no clock, no network, no filesystem, no global state. This
 * layer decides executability - not the UI, not the notifier.
 */

import { mapBinanceAdToArbitrageLeg } from './arbitrageSides.js';
import {
  BankAmountExecutability,
  ExecutabilityRejection,
  ExecutableQuote,
  LiquidityStatus,
  ExecutablePair,
  NormalizedAd,
  PairSearchReport,
} from './types.js';
import { verifyBank } from './bankMatching.js';
import { round2, signedSpreadPct } from './marketStatistics.js';

/** The amount tiers the bank matrix already works in, in VES. */
export const AMOUNT_TIERS: { key: string; val: number }[] = [
  { key: '10K', val: 10_000 },
  { key: '20K', val: 20_000 },
  { key: '30K', val: 30_000 },
  { key: '40K', val: 40_000 },
  { key: '50K', val: 50_000 },
  { key: '100K', val: 100_000 },
];

/** What Binance published about this ad's volume, without interpretation. */
/**
 * ARBITRAGE_BUY quotes come from tradeType 'BUY' - ads SELLING USDT, my entry.
 * ARBITRAGE_SELL quotes come from tradeType 'SELL' - ads BUYING USDT, my exit.
 * Both statements are made by arbitrageSides.ts and read from it here.
 */
export function classifyLiquidity(availableUsdtReported: number | null): LiquidityStatus {
  if (availableUsdtReported === null || !Number.isFinite(availableUsdtReported)) {
    return 'LIQUIDITY_NOT_VERIFIABLE';
  }
  return availableUsdtReported > 0 ? 'LIQUIDITY_VERIFIED' : 'LIQUIDITY_ZERO';
}

const REJECTION_REASONS: Record<ExecutabilityRejection, string> = {
  BANK_NOT_VERIFIED:
    'Ningun payType del anuncio coincide exactamente con un codigo canonico de este banco.',
  BANK_NOT_VERIFIABLE:
    'No se puede establecer a que banco pertenece el anuncio. La ausencia de verificacion no es una operacion ejecutable.',
  INVALID_PRICE: 'El anuncio no publica un precio positivo utilizable.',
  AMOUNT_BELOW_MIN: 'El monto solicitado esta por debajo del minimo que acepta el anuncio.',
  AMOUNT_ABOVE_MAX: 'El monto solicitado supera el maximo que acepta el anuncio.',
  LIQUIDITY_INSUFFICIENT: 'El volumen publicado no cubre el monto solicitado.',
  LIQUIDITY_NOT_VERIFIABLE:
    'Binance no publico volumen para este anuncio. No se inventa liquidez: la operacion queda sin verificar.',
};

/**
 * Evaluates one ad against one bank, amount and side.
 *
 * Checks run in a fixed order so the reported reason is always the FIRST
 * unmet condition, and the result is deterministic:
 *   bank -> price -> amount limits -> liquidity
 */
export function evaluateAd(
  ad: NormalizedAd,
  params: {
    bank: string;
    allowedCodes: readonly string[];
    /** The VES capital of the operation. Never a USDT quantity. */
    amountVes: number;
    side: 'BUY' | 'SELL';
    /**
     * How many USDT this ad must be able to move, when the caller already
     * knows it. In USDT, never in VES.
     *
     * Needed because the two legs do not require the same quantity. The first
     * leg spends amountVes at ITS OWN price, so the volume it consumes is
     * derivable from the ad alone. The second leg has to move exactly the USDT
     * the first one bought - a quantity that depends on the OTHER ad's price,
     * which a single-ad evaluation cannot see.
     *
     * Omitted, the requirement falls back to this ad's own price. That is
     * correct for a first leg and for evaluating one ad in isolation; it is
     * what the second leg must not do.
     */
    requiredUsdt?: number;
  }
): ExecutableQuote {
  const { bank, allowedCodes, amountVes, side } = params;
  const verification = verifyBank(ad.paymentOptions, allowedCodes);
  const liquidityStatus = classifyLiquidity(ad.availableUsdtReported);

  const base = {
    bank,
    bankVerification: verification.verification,
    amountVes,
    side,
    price: ad.price,
    advNo: ad.advNo,
    merchant: ad.merchantName,
    paymentMethod:
      ad.paymentOptions.find((o) => o.payType === verification.matchedPayType)?.tradeMethodName ??
      null,
    payType: verification.matchedPayType,
    minAmountVes: ad.minAmountVes,
    maxAmountVes: ad.maxAmountVes,
    availableUsdt: ad.availableUsdtReported,
    liquidityStatus,
    merchantQuality: {
      ordersCount: ad.ordersCount,
      finishRate: ad.finishRate,
      userType: ad.userType,
    },
  };

  const reject = (rejection: ExecutabilityRejection): ExecutableQuote => ({
    ...base,
    // An unanswerable question is NOT_VERIFIABLE; an answered "no" is a plain
    // rejection. Neither is ever EXECUTABLE.
    provenance:
      rejection === 'BANK_NOT_VERIFIABLE' || rejection === 'LIQUIDITY_NOT_VERIFIABLE'
        ? 'NOT_VERIFIABLE'
        : 'REAL',
    rejection,
    reason: REJECTION_REASONS[rejection],
  });

  if (verification.verification === 'NOT_VERIFIABLE') return reject('BANK_NOT_VERIFIABLE');
  if (verification.verification === 'NOT_VERIFIED') return reject('BANK_NOT_VERIFIED');

  if (!Number.isFinite(ad.price) || ad.price <= 0) return reject('INVALID_PRICE');

  if (amountVes < ad.minAmountVes) return reject('AMOUNT_BELOW_MIN');
  // maxAmountVes === 0 is Binance's "no upper limit", not a zero ceiling.
  if (ad.maxAmountVes !== 0 && amountVes > ad.maxAmountVes) return reject('AMOUNT_ABOVE_MAX');

  if (liquidityStatus === 'LIQUIDITY_NOT_VERIFIABLE') return reject('LIQUIDITY_NOT_VERIFIABLE');
  if (liquidityStatus === 'LIQUIDITY_ZERO') return reject('LIQUIDITY_INSUFFICIENT');

  /*
   * THE VOLUME THIS AD MUST BE ABLE TO MOVE, IN USDT.
   *
   * Supplied by the caller when the other leg's price is already known;
   * otherwise derived from this ad's own price, which is right for a first leg
   * and for a standalone evaluation.
   */
  const requiredUsdt = params.requiredUsdt ?? amountVes / ad.price;
  if ((ad.availableUsdtReported ?? 0) < requiredUsdt) return reject('LIQUIDITY_INSUFFICIENT');

  return { ...base, provenance: 'EXECUTABLE', rejection: null, reason: null };
}

/**
 * Counts what Binance published about volume, across every evaluated ad.
 *
 * Descriptive only: nothing here rejects or accepts anything. It lets a caller
 * separate "no advertiser published any volume" from "volume exists but is too
 * small", which evaluateAd correctly rejects with the same reason.
 */
function tallyLiquidity(
  quotes: readonly ExecutableQuote[]
): Record<LiquidityStatus, number> {
  const counts: Record<LiquidityStatus, number> = {
    LIQUIDITY_VERIFIED: 0,
    LIQUIDITY_ZERO: 0,
    LIQUIDITY_NOT_VERIFIABLE: 0,
  };
  for (const q of quotes) counts[q.liquidityStatus] += 1;
  return counts;
}

function tally(quotes: readonly ExecutableQuote[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const q of quotes) {
    if (q.rejection === null) continue;
    counts[q.rejection] = (counts[q.rejection] ?? 0) + 1;
  }
  return counts;
}

/**
 * The best ad on ONE side, on its own terms.
 *
 * DIAGNOSTIC, never an operation. Two of these do not make a pair: the
 * quantity the sell leg must move depends on the buy leg's price, so they can
 * only be chosen together. selectExecutablePair does that; this exists so the
 * matrix can show what each side holds when no pair exists.
 *
 * Equal prices resolve to the lowest advNo, so the same book always yields the
 * same quote.
 */
function bestOnSide(
  quotes: readonly ExecutableQuote[],
  bestIs: 'LOWEST' | 'HIGHEST'
): ExecutableQuote | null {
  let best: ExecutableQuote | null = null;
  for (const q of quotes) {
    if (best === null) best = q;
    else if (bestIs === 'LOWEST' ? q.price < best.price : q.price > best.price) best = q;
    else if (q.price === best.price && q.advNo < best.advNo) best = q;
  }
  return best;
}

/*
 * pickBest USED TO LIVE HERE, and it is gone.
 *
 * It chose the best quote on ONE side in isolation, which is the shape of the
 * defect: the two legs of an operation cannot be chosen independently, because
 * the quantity the second must move is set by the price of the first. Choosing
 * a pair is selectExecutablePair's job, and the ordering it uses is total, so
 * nothing needs a second, per-side notion of "best".
 */

/** Ascending by price, then by advNo, so the order is total and stable. */
function byPriceThenAdv(a: ExecutableQuote, b: ExecutableQuote): number {
  return a.price - b.price || (a.advNo < b.advNo ? -1 : a.advNo > b.advNo ? 1 : 0);
}

/**
 * THE BEST PAIR OF LEGS THAT CAN ACTUALLY BE EXECUTED TOGETHER.
 *
 * THE DEFECT THIS REPLACES
 *
 * The old search resolved the legs in sequence: pick the best BUY, derive the
 * USDT it obtains, then look for a SELL that can absorb them. When the best
 * buy produced more USDT than any seller could take, the cell was declared
 * NO OPPORTUNITY - and the second-best buy, which would have produced fewer
 * USDT and paired perfectly, was never tried. Demonstrated:
 *
 *     BUY 940 -> needs 53.191489 USDT
 *     BUY 941 -> needs 53.134963 USDT
 *     SELL 950, liquidity 53.15 USDT
 *
 * 940 does not fit, so the cell reported nothing. 941 -> 950 fits and is worth
 * +0.9564%. That opportunity existed and was never reported.
 *
 * WHY THIS IS NOT A RETURN TO THE OLDER, LOOSER ALGORITHM
 *
 * The version before that checked each leg against its OWN price, so the sell
 * leg was verified for amountVes / sellPrice USDT when amountVes / buyPrice
 * were going to be sold - always fewer, by exactly the margin. It found pairs
 * that could not be executed. Here every reported pair has been checked
 * against the real quantity, jointly. Nothing is relaxed; the search is
 * widened.
 *
 * THE DOMINANCE THAT KEEPS IT CHEAP
 *
 * A pair (b, s) is compatible when
 *
 *     available(s)  >=  amountVes / price(b)
 *
 * which rearranges to a MINIMUM BUY PRICE for that seller:
 *
 *     price(b)  >=  amountVes / available(s)  =:  pMin(s)
 *
 * and the margin (price(s) - price(b)) / price(b) is strictly decreasing in
 * price(b). So for a FIXED seller:
 *
 *   - every buy below pMin(s) is infeasible;
 *   - among the feasible ones, the CHEAPEST maximises the margin, and every
 *     other feasible buy is strictly dominated by it.
 *
 * One buy per seller is therefore enough, and it is found by binary search on
 * the sorted buy prices. The search is O(m log n) instead of O(n x m), and no
 * pair it skips could have won. `pairsExamined` in the report is that count,
 * so the saving is measured rather than asserted.
 *
 * The sellers cannot be reduced the same way: a higher sale price often comes
 * with less published volume, which forces a more expensive buy, so every
 * seller has to be tried.
 *
 * PURE. Sorting is by (price, advNo), so equal prices resolve to the lowest
 * advNo and the same book always yields the same pair.
 */
export function selectExecutablePair(params: {
  buyCandidates: readonly ExecutableQuote[];
  sellCandidates: readonly ExecutableQuote[];
  amountVes: number;
}): { pair: ExecutablePair | null; pairsExamined: number; compatiblePairs: number } {
  const { amountVes } = params;
  const buys = [...params.buyCandidates].sort(byPriceThenAdv);
  const sells = [...params.sellCandidates].sort(byPriceThenAdv);

  /** Index of the cheapest buy priced at or above `floor`, or -1. */
  const cheapestAtLeast = (floor: number): number => {
    let lo = 0;
    let hi = buys.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (buys[mid].price >= floor) {
        found = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return found;
  };

  let best: ExecutablePair | null = null;
  let pairsExamined = 0;
  let compatiblePairs = 0;

  for (const sell of sells) {
    /*
     * A seller with no published volume never reaches here - evaluateAd
     * rejects LIQUIDITY_NOT_VERIFIABLE and LIQUIDITY_ZERO before this. The
     * guard keeps the arithmetic total rather than trusting that.
     */
    const available = sell.availableUsdt;
    if (available === null || !Number.isFinite(available) || available <= 0) continue;

    const index = cheapestAtLeast(amountVes / available);
    if (index === -1) continue;

    const buy = buys[index];
    pairsExamined += 1;

    const usdtTraded = amountVes / buy.price;
    // The same inequality again, evaluated directly rather than inferred from
    // the threshold: the reported pair is verified, not deduced.
    if (available < usdtTraded) continue;
    compatiblePairs += 1;

    /*
     * signedSpreadPct is the domain's single definition of the sign and it
     * returns null for a non-positive or non-finite denominator. Both prices
     * passed INVALID_PRICE, so null cannot occur here - and if it ever did,
     * skipping the pair is the only safe answer: no spread, no operation.
     */
    const spreadPct = signedSpreadPct(sell.price, buy.price);
    if (spreadPct === null) continue;

    const candidate: ExecutablePair = { buy, sell, usdtTraded, spreadPct };
    if (best === null || betterPair(candidate, best)) best = candidate;
  }

  return { pair: best, pairsExamined, compatiblePairs };
}

/**
 * Ranking WITHIN one cell.
 *
 * Margin first. Inside a cell the operation size is fixed - it is the tier -
 * so a higher rate is a higher absolute gain, and the two cannot disagree
 * here. Surplus liquidity beyond what the operation consumes buys nothing for
 * THIS operation, so it ranks below the price and only breaks ties.
 *
 * The remaining keys exist to make the answer total: two books that differ in
 * no observable way must not produce different pairs.
 */
function betterPair(a: ExecutablePair, b: ExecutablePair): boolean {
  if (a.spreadPct !== b.spreadPct) return a.spreadPct > b.spreadPct;

  const aLiq = Math.min(a.buy.availableUsdt ?? 0, a.sell.availableUsdt ?? 0);
  const bLiq = Math.min(b.buy.availableUsdt ?? 0, b.sell.availableUsdt ?? 0);
  if (aLiq !== bLiq) return aLiq > bLiq;

  if (a.buy.price !== b.buy.price) return a.buy.price < b.buy.price;
  if (a.sell.price !== b.sell.price) return a.sell.price > b.sell.price;
  if (a.buy.advNo !== b.buy.advNo) return a.buy.advNo < b.buy.advNo;
  return a.sell.advNo < b.sell.advNo;
}

/**
 * Executability of one BANK x AMOUNT cell.
 *
 * Both sides are drawn from the SAME bank's ads. There is no cross-bank
 * pairing here and there cannot be one: a BUY at Provincial and a SELL at
 * Banesco do not form an operation anyone can execute, however wide the
 * apparent spread.
 *
 * No fallbacks. When no pair of legs can be executed together the answer is
 * null on both sides - not the median, not the best raw ad, not a suggested
 * price, and never two legs that were only checked separately.
 */
export function evaluateBankAmount(params: {
  bank: string;
  allowedCodes: readonly string[];
  amountVes: number;
  buyAds: readonly NormalizedAd[];
  sellAds: readonly NormalizedAd[];
}): BankAmountExecutability {
  const { bank, allowedCodes, amountVes, buyAds, sellAds } = params;

  /*
   * CANDIDATES ARE THE ADS THAT PASS EVERY CHECK THAT DOES NOT DEPEND ON THE
   * OTHER LEG: bank, price, amount limits, and a published, non-zero volume.
   *
   * The buy leg spends amountVes at its own price, so its requirement is
   * self-contained and evaluateAd's default is exactly right.
   *
   * The sell leg's requirement is NOT self-contained - it depends on which buy
   * it is paired with - so requiredUsdt is 0 here and the real quantity is
   * checked in selectExecutablePair, jointly, for every pair it reports. This
   * is deliberately the only place the sell side is evaluated leniently, and
   * nothing downstream reads these quotes as executable operations.
   */
  const allBuy = buyAds.map((ad) =>
    evaluateAd(ad, { bank, allowedCodes, amountVes, side: 'BUY' })
  );
  const buyQuotes = allBuy.filter((q) => q.provenance === 'EXECUTABLE');

  const allSell = sellAds.map((ad) =>
    evaluateAd(ad, { bank, allowedCodes, amountVes, side: 'SELL', requiredUsdt: 0 })
  );
  const sellQuotes = allSell.filter((q) => q.provenance === 'EXECUTABLE');

  const search = selectExecutablePair({
    buyCandidates: buyQuotes,
    sellCandidates: sellQuotes,
    amountVes,
  });

  /*
   * TWO DIFFERENT QUESTIONS, AND THEY MUST NOT SHARE A FIELD.
   *
   *   bestExecutableBuy / bestExecutableSell answer "what is the best ad on
   *   this side, on its own terms". The matrix screen needs that even when no
   *   operation exists: "there is a buy at 921.10 and no seller who can absorb
   *   it" is a useful answer, and "nothing here" is not.
   *
   *   `pair` answers "which two legs can actually be executed together". Only
   *   this is an operation, and it is the ONLY thing buildOpportunity reads.
   *
   * Collapsing them is how the older code produced pairs that had never been
   * checked jointly. They are kept apart on purpose.
   */
  const bestExecutableBuy = bestOnSide(buyQuotes, 'LOWEST');
  const bestExecutableSell = bestOnSide(sellQuotes, 'HIGHEST');

  const noneReason = (side: 'compra' | 'venta', evaluated: number) =>
    evaluated === 0
      ? `El banco no devolvio anuncios de ${side}.`
      : `Ninguno de los ${evaluated} anuncios de ${side} es ejecutable para ${amountVes} VES en este banco.`;

  /*
   * WHY THERE IS NO OPERATION, when there is none.
   *
   * The case the old code could not express: both sides hold executable ads
   * and there is still nothing to do, because no buy and no sell can move the
   * same USDT. Reporting that as "not executable" would be false, and
   * reporting nothing at all is what sent the operator looking for a bug.
   */
  const pairReason =
    search.pair !== null
      ? null
      : buyQuotes.length === 0 || sellQuotes.length === 0
        ? `No hay anuncios ejecutables en ${buyQuotes.length === 0 ? 'compra' : 'venta'} para ${amountVes} VES en este banco.`
        : `Hay ${buyQuotes.length} anuncios de compra y ${sellQuotes.length} de venta ejecutables, pero ninguna pareja puede mover los mismos USDT para ${amountVes} VES.`;

  const pairing: PairSearchReport = {
    buyAdsSeen: buyAds.length,
    sellAdsSeen: sellAds.length,
    buyCandidates: buyQuotes.length,
    sellCandidates: sellQuotes.length,
    pairsPossible: buyQuotes.length * sellQuotes.length,
    pairsExamined: search.pairsExamined,
    compatiblePairs: search.compatiblePairs,
    usdtTraded: search.pair?.usdtTraded ?? null,
  };

  return {
    bank,
    amountVes,
    buyQuotes,
    sellQuotes,
    bestExecutableBuy,
    bestExecutableSell,
    pair: search.pair,
    pairing,
    noPairReason: pairReason,
    /*
     * FULL PRECISION, not rounded.
     *
     * This was round2, and rounding a DECISION input silently broke the one
     * rule the system is built on: matrix and engine must agree. A real spread
     * of +0.0042% rounded to 0.00, so the cell reported NO_OPPORTUNITY while
     * the opportunity engine - which never rounded - reported EXECUTABLE and
     * Telegram announced it. Same book, two answers.
     *
     * Real spreads in this market live in the third and fourth decimal.
     * Rounding is a presentation concern and belongs in the view.
     */
    spreadPct: search.pair?.spreadPct ?? null,
    buyReason: bestExecutableBuy === null ? noneReason('compra', allBuy.length) : null,
    sellReason: bestExecutableSell === null ? noneReason('venta', allSell.length) : null,
    buyRejections: tally(allBuy),
    sellRejections: tally(allSell),
    buyLiquidity: tallyLiquidity(allBuy),
    sellLiquidity: tallyLiquidity(allSell),
  };
}

/**
 * Every amount tier for one bank, from ONE captured book per side.
 *
 * The tiers are filtered in memory from the ads already fetched. No tier
 * triggers a request of its own.
 */
export function evaluateBankTiers(params: {
  bank: string;
  allowedCodes: readonly string[];
  buyAds: readonly NormalizedAd[];
  sellAds: readonly NormalizedAd[];
  tiers?: { key: string; val: number }[];
}): Record<string, BankAmountExecutability> {
  const tiers = params.tiers ?? AMOUNT_TIERS;
  const out: Record<string, BankAmountExecutability> = {};
  for (const tier of tiers) {
    out[tier.key] = evaluateBankAmount({ ...params, amountVes: tier.val });
  }
  return out;
}
