/**
 * Deterministic fixtures for characterization tests.
 *
 * These builders produce SHAPES that mirror what Binance returns and what the
 * codebase stores. They are test inputs only - never production data.
 */

import type {
  BinanceAdItem,
  BinanceP2PResponse,
  HistoryRecord,
  MarketSnapshot,
  NormalizedAd,
} from '../../server/types.js';

export function makeAdItem(overrides: {
  advNo?: string;
  price?: string;
  min?: string;
  max?: string;
  tradable?: string;
  surplus?: string;
  nickName?: string;
  userType?: string;
  monthOrderCount?: number;
  monthFinishRate?: number;
  payTypes?: string[];
  tradeType?: string;
} = {}): BinanceAdItem {
  return {
    adv: {
      advNo: overrides.advNo ?? 'adv-1',
      price: overrides.price ?? '918.00',
      maxSingleTransAmount: overrides.max ?? '50000',
      minSingleTransAmount: overrides.min ?? '1000',
      surplusAmount: overrides.surplus ?? '500',
      tradableQuantity: overrides.tradable ?? '1000',
      tradeType: overrides.tradeType ?? 'BUY',
      asset: 'USDT',
      fiatUnit: 'VES',
      tradeMethods: (overrides.payTypes ?? ['Banesco']).map((p, i) => ({
        payType: p,
        payMethodId: `pm-${i}`,
        tradeMethodName: p,
      })),
    },
    advertiser: {
      userNo: 'user-1',
      nickName: overrides.nickName ?? 'Comerciante',
      userType: overrides.userType ?? 'merchant',
      monthOrderCount: overrides.monthOrderCount ?? 120,
      monthFinishRate: overrides.monthFinishRate ?? 0.98,
      positiveRate: 0.99,
      userGrade: 2,
    },
  };
}

export function makeBinanceResponse(data: BinanceAdItem[]): BinanceP2PResponse {
  return { code: '000000', message: null, data, total: data.length, success: true };
}

/** Builds a fetch mock that returns `queue[n]` for the n-th call, cycling on the last entry. */
export function makeFetchMock(queue: BinanceP2PResponse[]) {
  let call = 0;
  return async (_url: string, _init: RequestInit): Promise<Response> => {
    const body = queue[Math.min(call, queue.length - 1)];
    call += 1;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
    } as unknown as Response;
  };
}

/** Reads and parses the JSON body of the n-th call of a stubbed fetch. */
export function requestBody(
  mock: { mock: { calls: [string, RequestInit][] } },
  index = 0
): Record<string, unknown> {
  return JSON.parse(String(mock.mock.calls[index][1].body)) as Record<string, unknown>;
}

export function makeNormalizedAd(price: number, availableUsdt = 100): NormalizedAd {
  return {
    advNo: `adv-${price}`,
    price,
    minAmountVes: 1000,
    maxAmountVes: 50000,
    availableUsdt,
    merchantName: 'Comerciante',
    userType: 'merchant',
    ordersCount: 100,
    finishRate: 0.98,
    paymentMethods: ['Banesco'],
  };
}

export function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    timestamp: 1_756_000_000_000,
    isoDate: '2025-08-24T02:26:40.000Z',
    asset: 'USDT',
    fiat: 'VES',
    bestBuyPrice: 918.0,
    bestSellPrice: 921.0,
    averageBuyPrice: 918.5,
    averageSellPrice: 920.5,
    medianBuyPrice: 918.4,
    medianSellPrice: 920.6,
    weightedBuyPrice: 918.3,
    weightedSellPrice: 920.7,
    spreadAbsolute: 3.0,
    spreadPercentage: 0.33,
    topBuyAds: [makeNormalizedAd(918.0), makeNormalizedAd(918.5)],
    topSellAds: [makeNormalizedAd(921.0), makeNormalizedAd(920.5)],
    source: 'BINANCE_P2P',
    fetchDurationMs: 120,
    status: 'LIVE',
    lastError: null,
    ...overrides,
  };
}

/**
 * Builds a monotonic history series. `startTs` defaults to a fixed epoch so
 * suites stay deterministic; VET hour derivation is exercised separately.
 */
export function makeHistory(
  count: number,
  opts: { startTs?: number; stepMs?: number; startBuy?: number; drift?: number } = {}
): HistoryRecord[] {
  const startTs = opts.startTs ?? 1_756_000_000_000;
  const stepMs = opts.stepMs ?? 6000;
  const startBuy = opts.startBuy ?? 918.0;
  const drift = opts.drift ?? 0;

  return Array.from({ length: count }, (_, i) => {
    const buyPrice = Number((startBuy + drift * i).toFixed(2));
    const sellPrice = Number((buyPrice + 3).toFixed(2));
    const ts = startTs + i * stepMs;
    return {
      id: `tick-${ts}`,
      timestamp: ts,
      dateStr: new Date(ts).toISOString(),
      hour: 12,
      buyPrice,
      sellPrice,
      spreadPct: Number((((sellPrice - buyPrice) / buyPrice) * 100).toFixed(2)),
      bestBuyMerchant: 'Comerciante A',
      bestSellMerchant: 'Comerciante B',
      activeBuyAds: 10,
      activeSellAds: 10,
      source: 'BINANCE_P2P',
    };
  });
}
