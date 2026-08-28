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
  NormalizedAd,
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
 * Deterministic pick among equal prices: the lowest advNo wins, so the same
 * book always yields the same quote.
 */
function pickBest(
  quotes: readonly ExecutableQuote[],
  better: (candidate: number, incumbent: number) => boolean
): ExecutableQuote | null {
  let best: ExecutableQuote | null = null;
  for (const q of quotes) {
    if (best === null || better(q.price, best.price)) best = q;
    else if (q.price === best.price && q.advNo < best.advNo) best = q;
  }
  return best;
}

/**
 * Executability of one BANK x AMOUNT cell.
 *
 * Both sides are drawn from the SAME bank's ads. There is no cross-bank
 * pairing here and there cannot be one: a BUY at Provincial and a SELL at
 * Banesco do not form an operation anyone can execute, however wide the
 * apparent spread.
 *
 * No fallbacks. When a side has no executable quote the answer is null - not
 * the median, not the best raw ad, not a suggested price.
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
   * Which extreme is best comes from the leg definition, not from a comment.
   * mapBinanceAdToArbitrageLeg is the only place that knows a tradeType 'BUY'
   * ad is my purchase; asking it here means this file cannot drift from it.
   */
  const askLeg = mapBinanceAdToArbitrageLeg('BUY');
  const bidLeg = mapBinanceAdToArbitrageLeg('SELL');

  /*
   * THE TWO LEGS ARE EVALUATED IN ORDER, AND THAT ORDER IS THE FIX.
   *
   * The operation is VES -> USDT -> VES. The first leg spends amountVes and
   * receives amountVes / buyPrice USDT; the second leg has to move exactly
   * those USDT. Because an opportunity requires sellPrice > buyPrice, that
   * quantity is ALWAYS larger than amountVes / sellPrice.
   *
   * Both legs used to be checked against their own price, so the second was
   * asked to cover the smaller number. On a 50.000 VES operation at 940 -> 950
   * it was verified for 52,6316 USDT when 53,1915 were going to be sold: a
   * 1,05% shortfall, unnoticed. The gap is exactly the margin, so the more
   * profitable the operation looked, the more liquidity went unchecked.
   *
   * The buy leg therefore resolves first, and its price sizes the sell leg.
   * Picking the CHEAPEST buy is also the strictest choice: it buys the most
   * USDT, so it imposes the largest requirement on the seller.
   */
  const allBuy = buyAds.map((ad) =>
    evaluateAd(ad, { bank, allowedCodes, amountVes, side: 'BUY' })
  );
  const buyQuotes = allBuy.filter((q) => q.provenance === 'EXECUTABLE');
  const bestExecutableBuy = pickBest(buyQuotes, (c, i) =>
    askLeg.bestIs === 'LOWEST' ? c < i : c > i
  );

  /*
   * The USDT the first leg actually obtains. null when there is no executable
   * first leg: there is then no operation, no quantity to size against, and
   * the sell side falls back to evaluating each ad on its own terms - which is
   * what the per-side status on the cell reports.
   */
  const usdtToSell =
    bestExecutableBuy !== null ? amountVes / bestExecutableBuy.price : null;

  const allSell = sellAds.map((ad) =>
    evaluateAd(ad, {
      bank,
      allowedCodes,
      amountVes,
      side: 'SELL',
      requiredUsdt: usdtToSell ?? undefined,
    })
  );
  const sellQuotes = allSell.filter((q) => q.provenance === 'EXECUTABLE');
  const bestExecutableSell = pickBest(sellQuotes, (c, i) =>
    bidLeg.bestIs === 'LOWEST' ? c < i : c > i
  );

  const noneReason = (side: 'compra' | 'venta', evaluated: number) =>
    evaluated === 0
      ? `El banco no devolvio anuncios de ${side}.`
      : `Ninguno de los ${evaluated} anuncios de ${side} es ejecutable para ${amountVes} VES en este banco.`;

  return {
    bank,
    amountVes,
    buyQuotes,
    sellQuotes,
    bestExecutableBuy,
    bestExecutableSell,
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
    spreadPct:
      bestExecutableBuy !== null && bestExecutableSell !== null
        ? signedSpreadPct(bestExecutableSell.price, bestExecutableBuy.price)
        : null,
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
