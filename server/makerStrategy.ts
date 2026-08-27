/**
 * MAKER STRATEGY — "if I publish an ad now, what price should I put?"
 *
 * This is NOT arbitrage. The robot does not take anybody's ad. It publishes
 * its own, and the only question is where to price it so that a counterparty
 * chooses it over the ads competing with it.
 *
 * THE FIVE THINGS THAT MUST NEVER BE CONFLATED
 *
 *   1. what Binance calls the tradeType parameter
 *   2. what the ADVERTISER of a listed ad is doing
 *   3. what I want to do
 *   4. which listing MY ad shows up in
 *   5. what price I should publish
 *
 * They are five different things and this module names all five, because
 * collapsing any two of them inverts the whole system.
 *
 * THE TABLE
 *
 *   | my need              | my ad      | I compete against | listing        | best price |
 *   |----------------------|------------|-------------------|----------------|------------|
 *   | have VES, want USDT  | I BUY USDT | other USDT buyers | tradeType=SELL | HIGHEST    |
 *   | have USDT, want VES  | I SELL USDT| other USDT sellers| tradeType=BUY  | LOWEST     |
 *
 * WHY THE LISTING IS THE MIRROR OF MY INTENT
 *
 * tradeType is the SEARCHER's intent. My buy-USDT ad is shown to people who
 * want to SELL USDT, and those people search the tradeType=SELL listing - so
 * that listing is where my ad lands and where my competitors already are.
 * Wanting to buy therefore means reading the SELL listing. This is the single
 * most invertible fact in the project and it lives here.
 *
 * NOTHING IS INVENTED. Every price comes from a real captured ad, and every
 * recommendation keeps the provenance of the ads it was derived from.
 */

import type { AdPaymentMethod, NormalizedAd } from './types.js';

/** What I am publishing. The only vocabulary the rest of the app should use. */
export type MakerSide = 'MAKER_BUY' | 'MAKER_SELL';

export interface MakerSideDefinition {
  side: MakerSide;
  /** What I do. */
  myAction: 'COMPRO USDT' | 'VENDO USDT';
  /** What I need to have before publishing. */
  iHave: 'VES' | 'USDT';
  /** Who sees my ad. */
  seenBy: 'quien quiere VENDER USDT' | 'quien quiere COMPRAR USDT';
  /** The Binance listing my ad lands in - and therefore where my rivals are. */
  listingTradeType: 'BUY' | 'SELL';
  /** What my competitors in that listing are doing. */
  competitorsAre: 'compradores de USDT' | 'vendedores de USDT';
  /** Which end of the competitor ladder is the leader. */
  leaderIs: 'HIGHEST' | 'LOWEST';
  /** Which way I move to beat them. */
  beatDirection: 'UP' | 'DOWN';
  label: string;
}

const MAKER_BUY: MakerSideDefinition = {
  side: 'MAKER_BUY',
  myAction: 'COMPRO USDT',
  iHave: 'VES',
  seenBy: 'quien quiere VENDER USDT',
  listingTradeType: 'SELL',
  competitorsAre: 'compradores de USDT',
  leaderIs: 'HIGHEST',
  beatDirection: 'UP',
  label: 'MI COMPRA DE USDT',
};

const MAKER_SELL: MakerSideDefinition = {
  side: 'MAKER_SELL',
  myAction: 'VENDO USDT',
  iHave: 'USDT',
  seenBy: 'quien quiere COMPRAR USDT',
  listingTradeType: 'BUY',
  competitorsAre: 'vendedores de USDT',
  leaderIs: 'LOWEST',
  beatDirection: 'DOWN',
  label: 'MI VENTA DE USDT',
};

export const MAKER_SIDES: readonly MakerSideDefinition[] = [MAKER_BUY, MAKER_SELL];

export function makerSideDefinition(side: MakerSide): MakerSideDefinition {
  return side === 'MAKER_BUY' ? MAKER_BUY : MAKER_SELL;
}

/** Which Binance listing holds my competitors for this side. */
export function listingForMakerSide(side: MakerSide): 'BUY' | 'SELL' {
  return makerSideDefinition(side).listingTradeType;
}

/* ------------------------------------------------------------------------ *
 * CONFIGURATION
 * ------------------------------------------------------------------------ */

export interface MakerConfig {
  /**
   * Merchant names to leave out of the competitor ladder.
   *
   * Empty by default. It exists so that once the operator publishes ads, the
   * robot can be told not to treat them as competition and advise outbidding
   * itself. Deliberately built now and left unconfigured.
   */
  excludeMerchants: readonly string[];
  /**
   * Which advertisers to compete against. 'ALL' represents the real market,
   * which is what the operator asked for; the other values exist so the
   * decision can change without touching the engine.
   */
  publisherFilter: 'ALL' | 'MERCHANT_ONLY' | 'NON_MERCHANT_ONLY';
  /** How deep a ladder to keep. The operator asked for the real top 20. */
  ladderDepth: number;
}

export const DEFAULT_MAKER_CONFIG: MakerConfig = {
  excludeMerchants: [],
  publisherFilter: 'ALL',
  ladderDepth: 20,
};

export function readMakerConfig(env: NodeJS.ProcessEnv = process.env): MakerConfig {
  const raw = env.MAKER_EXCLUDE_MERCHANTS?.trim();
  const excludeMerchants =
    raw === undefined || raw === ''
      ? []
      : raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

  const filter = env.MAKER_PUBLISHER_FILTER?.trim().toUpperCase();
  const publisherFilter: MakerConfig['publisherFilter'] =
    filter === 'MERCHANT_ONLY' || filter === 'NON_MERCHANT_ONLY' ? filter : 'ALL';

  return { ...DEFAULT_MAKER_CONFIG, excludeMerchants, publisherFilter };
}

/* ------------------------------------------------------------------------ *
 * ONE COMPETITOR
 * ------------------------------------------------------------------------ */

/** Why an ad is not a competitor of mine for this bank and this amount. */
export type IrrelevanceReason =
  | 'BANK_NOT_MATCHED'
  | 'BANK_NOT_VERIFIABLE'
  | 'AMOUNT_BELOW_THEIR_MIN'
  | 'AMOUNT_ABOVE_THEIR_MAX'
  | 'INVALID_PRICE'
  | 'EXCLUDED_MERCHANT'
  | 'PUBLISHER_FILTERED';

/**
 * A rival ad, with everything needed to audit where a recommendation came
 * from. Note what is NOT here: any notion of whether I could execute against
 * it. That is a taker's question. A rival ahead of me in the queue is ahead of
 * me whether or not I could trade with it.
 */
export interface CompetitorAd {
  advNo: string;
  price: number;
  merchant: string;
  userType: string;
  /** The Binance listing this ad was read from. */
  listingTradeType: 'BUY' | 'SELL';
  /** The canonical payType that matched this bank, when one did. */
  payType: string | null;
  paymentMethods: readonly AdPaymentMethod[];
  minAmountVes: number;
  maxAmountVes: number;
  /** null when Binance published no volume. Never 0 standing in for unknown. */
  availableUsdt: number | null;
  relevant: boolean;
  irrelevanceReason: IrrelevanceReason | null;
  capturedAt: number;
}

/**
 * THE TRANSLATION. One Binance ad -> one competitor of mine, or a stated
 * reason why it is not one.
 *
 * Relevance, NOT executability. evaluateAd asks "can I trade against this?",
 * which is the taker question and the wrong one here: an ad I cannot trade
 * with still sits above me in the listing and still takes the counterparty
 * that would otherwise have come to me.
 */
export function normalizeBinanceAdForMakerStrategy(
  ad: NormalizedAd,
  params: {
    side: MakerSide;
    bankAllowedCodes: readonly string[];
    amountVes: number;
    capturedAt: number;
    config?: MakerConfig;
  }
): CompetitorAd {
  const config = params.config ?? DEFAULT_MAKER_CONFIG;
  const definition = makerSideDefinition(params.side);

  const allowed = new Set(params.bankAllowedCodes);
  // payType is nullable in the capture contract: absent means Binance published
  // no canonical code, which is not the same as a code that failed to match.
  const matched = ad.paymentOptions.find((o) => o.payType !== null && allowed.has(o.payType));
  const anyCanonicalCode = ad.paymentOptions.some((o) => (o.payType ?? '').trim() !== '');

  const base = {
    advNo: ad.advNo,
    price: ad.price,
    merchant: ad.merchantName,
    userType: ad.userType,
    listingTradeType: definition.listingTradeType,
    payType: matched?.payType ?? null,
    paymentMethods: ad.paymentOptions,
    minAmountVes: ad.minAmountVes,
    maxAmountVes: ad.maxAmountVes,
    availableUsdt: ad.availableUsdtReported,
    capturedAt: params.capturedAt,
  };

  const irrelevant = (reason: IrrelevanceReason): CompetitorAd => ({
    ...base,
    relevant: false,
    irrelevanceReason: reason,
  });

  if (config.excludeMerchants.includes(ad.merchantName)) {
    return irrelevant('EXCLUDED_MERCHANT');
  }
  if (config.publisherFilter === 'MERCHANT_ONLY' && ad.userType !== 'merchant') {
    return irrelevant('PUBLISHER_FILTERED');
  }
  if (config.publisherFilter === 'NON_MERCHANT_ONLY' && ad.userType === 'merchant') {
    return irrelevant('PUBLISHER_FILTERED');
  }

  // An ad with no canonical code at all cannot be established as this bank's.
  if (!anyCanonicalCode) return irrelevant('BANK_NOT_VERIFIABLE');
  if (matched === undefined) return irrelevant('BANK_NOT_MATCHED');

  if (!Number.isFinite(ad.price) || ad.price <= 0) return irrelevant('INVALID_PRICE');

  /*
   * Their limits, not mine. An ad that does not accept this amount is not
   * competing for the same counterparty I am competing for.
   */
  if (params.amountVes < ad.minAmountVes) return irrelevant('AMOUNT_BELOW_THEIR_MIN');
  if (ad.maxAmountVes !== 0 && params.amountVes > ad.maxAmountVes) {
    return irrelevant('AMOUNT_ABOVE_THEIR_MAX');
  }

  return { ...base, relevant: true, irrelevanceReason: null };
}

/* ------------------------------------------------------------------------ *
 * THE TICK
 * ------------------------------------------------------------------------ */

/**
 * The smallest price step this book actually uses, or null when the capture
 * cannot establish it.
 *
 * DERIVED, never assumed. 0.01 is what the VES book happens to use today, but
 * hard-coding it would silently produce a price Binance rounds away the day a
 * market quotes three decimals. The most precise price observed sets the step.
 *
 * WHY THIS CAN RETURN null
 *
 * Binance publishes prices as strings ("940.00"), and parsing to a number
 * destroys the declared precision - String(940.00) is "940". So a book in
 * which no ad happens to quote a decimal proves nothing about the step, and
 * the two ways out of that are both inventions: assuming 0.01 fabricates
 * precision, while assuming 1 would advise the operator to outbid a 940.00
 * leader with 941.00 and hand away a whole VES per USDT. Neither is
 * observable, so neither is returned. Callers report the price as
 * unestablished instead. Evidence is drawn from every ad captured in the
 * listing, not only the ones competing for this bank, so in a live VES book
 * this is answered by the first ad quoting cents.
 */
export function deriveTick(prices: readonly number[]): number | null {
  let maxDecimals = 0;
  for (const price of prices) {
    if (!Number.isFinite(price)) continue;
    const text = String(price);
    const dot = text.indexOf('.');
    if (dot === -1) continue;
    maxDecimals = Math.max(maxDecimals, text.length - dot - 1);
  }
  if (maxDecimals === 0) return null;
  return Number(Math.pow(10, -maxDecimals).toFixed(maxDecimals));
}

/** Rounds to the tick's precision, so a recommendation is always publishable. */
function toTick(price: number, tick: number): number {
  const decimals = Math.max(0, Math.round(-Math.log10(tick)));
  return Number(price.toFixed(decimals));
}

/* ------------------------------------------------------------------------ *
 * ONE SIDE OF THE LADDER
 * ------------------------------------------------------------------------ */

export interface LadderEntry {
  position: number;
  price: number;
  /** What I would have to publish to sit immediately ahead of this ad. */
  priceToBeat: number | null;
  /** Distance from the leader, in VES. 0 for the leader itself. */
  deltaFromLeader: number;
  advNo: string;
  merchant: string;
  availableUsdt: number | null;
}

export interface MakerSideAnalysis {
  side: MakerSide;
  definition: MakerSideDefinition;
  bank: string;
  amountVes: number;

  /** Ads read, ads that actually compete, and why the rest do not. */
  adsExamined: number;
  competitors: number;
  irrelevanceTally: Partial<Record<IrrelevanceReason, number>>;

  /** The real ladder, ordered best-competitor first. Depth as configured. */
  ladder: readonly LadderEntry[];
  leaderPrice: number | null;
  secondPrice: number | null;
  thirdPrice: number | null;

  /** The observed price step, or null when the capture cannot establish one. */
  tick: number | null;
  tickProvenance: 'OBSERVED' | 'NOT_VERIFIABLE';
  /** Leader beaten by exactly one tick. Always reported, even if not advised. */
  priceToBeFirst: number | null;

  capturedAt: number;
  reason: string | null;
}

/**
 * How far behind the leader an ad sits, in VES.
 *
 * Direction comes from the side definition, not from Math.abs: taking an
 * absolute value would hide a sign error instead of exposing it. Because the
 * leader is by construction the extreme of the ladder, this is >= 0 whenever
 * the ordering is correct - and negative if it ever is not.
 */
function gapBehindLeader(
  price: number,
  leaderPrice: number,
  definition: MakerSideDefinition
): number {
  const gap = definition.leaderIs === 'HIGHEST' ? leaderPrice - price : price - leaderPrice;
  return Number(gap.toFixed(8));
}

/** Best-competitor-first, with a deterministic tie-break on advNo. */
function orderLadder(ads: readonly CompetitorAd[], leaderIs: 'HIGHEST' | 'LOWEST'): CompetitorAd[] {
  return [...ads].sort((a, b) => {
    if (a.price !== b.price) {
      return leaderIs === 'HIGHEST' ? b.price - a.price : a.price - b.price;
    }
    return a.advNo < b.advNo ? -1 : a.advNo > b.advNo ? 1 : 0;
  });
}

export function analyseMakerSide(params: {
  side: MakerSide;
  bank: string;
  amountVes: number;
  /** Ads from the listing this side competes in - see listingForMakerSide. */
  ads: readonly NormalizedAd[];
  bankAllowedCodes: readonly string[];
  capturedAt: number;
  config?: MakerConfig;
}): MakerSideAnalysis {
  const config = params.config ?? DEFAULT_MAKER_CONFIG;
  const definition = makerSideDefinition(params.side);

  const normalized = params.ads.map((ad) =>
    normalizeBinanceAdForMakerStrategy(ad, {
      side: params.side,
      bankAllowedCodes: params.bankAllowedCodes,
      amountVes: params.amountVes,
      capturedAt: params.capturedAt,
      config,
    })
  );

  const irrelevanceTally: Partial<Record<IrrelevanceReason, number>> = {};
  for (const ad of normalized) {
    if (ad.irrelevanceReason === null) continue;
    irrelevanceTally[ad.irrelevanceReason] = (irrelevanceTally[ad.irrelevanceReason] ?? 0) + 1;
  }

  const relevant = normalized.filter((a) => a.relevant);
  const ordered = orderLadder(relevant, definition.leaderIs).slice(0, config.ladderDepth);

  /*
   * The step is a property of the market, not of this bank's slice of it, so
   * every ad the listing returned counts as evidence - including the ones that
   * do not compete for this bank or this amount.
   */
  const tick = deriveTick(normalized.map((a) => a.price));
  const step = tick === null ? null : definition.beatDirection === 'UP' ? tick : -tick;

  const leaderPrice = ordered[0]?.price ?? null;

  const ladder: LadderEntry[] = ordered.map((ad, i) => ({
    position: i + 1,
    price: ad.price,
    priceToBeat: step === null || tick === null ? null : toTick(ad.price + step, tick),
    deltaFromLeader: leaderPrice === null ? 0 : gapBehindLeader(ad.price, leaderPrice, definition),
    advNo: ad.advNo,
    merchant: ad.merchant,
    availableUsdt: ad.availableUsdt,
  }));

  return {
    side: params.side,
    definition,
    bank: params.bank,
    amountVes: params.amountVes,
    adsExamined: normalized.length,
    competitors: relevant.length,
    irrelevanceTally,
    ladder,
    leaderPrice,
    secondPrice: ordered[1]?.price ?? null,
    thirdPrice: ordered[2]?.price ?? null,
    tick,
    tickProvenance: tick === null ? 'NOT_VERIFIABLE' : 'OBSERVED',
    priceToBeFirst:
      leaderPrice === null || step === null || tick === null
        ? null
        : toTick(leaderPrice + step, tick),
    capturedAt: params.capturedAt,
    reason:
      tick === null && normalized.length > 0
        ? `Ningún anuncio del listado ${definition.listingTradeType} cotiza decimales, así que el paso de precio no se puede establecer con lo capturado y no se propone un precio.`
        : relevant.length > 0
        ? null
        : normalized.length === 0
        ? `Binance no devolvió anuncios en el listado ${definition.listingTradeType} para este banco y monto.`
        : `Ninguno de los ${normalized.length} anuncios devueltos compite en ${params.bank} para ${params.amountVes.toLocaleString('es-VE')} VES.`,
  };
}

/**
 * Where my price would land in the queue.
 *
 * An ESTIMATE, and named as one: Binance may order by things this data does
 * not expose - completion rate, verification, promotion. What it does say
 * exactly is how many competing ads carry a better price than mine.
 */
export function estimatePosition(
  price: number,
  analysis: Pick<MakerSideAnalysis, 'ladder' | 'definition'>
): number {
  const better = analysis.definition.leaderIs === 'HIGHEST'
    ? analysis.ladder.filter((e) => e.price > price).length
    : analysis.ladder.filter((e) => e.price < price).length;
  return better + 1;
}
