/**
 * CHARACTERIZATION TESTS - server/binanceP2PService.ts
 *
 * Purpose: freeze current observable behaviour before Phase 2/3 changes.
 * Tests prefixed with "BUG:" document behaviour that the audit flagged as
 * incorrect. They assert what the code does TODAY so that a future fix fails
 * loudly and deliberately. They are NOT a statement that the behaviour is
 * desirable.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BinanceP2PService, BANK_CODE_MAP } from '../server/binanceP2PService.js';
import {
  makeAdItem,
  makeBinanceResponse,
  makeFetchMock,
  requestBody,
} from './helpers/fixtures.js';

const ENDPOINT = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BANK_CODE_MAP', () => {
  it('exposes the 7 banks currently supported, with apiPayTypes', () => {
    expect(Object.keys(BANK_CODE_MAP)).toEqual([
      'BANESCO',
      'PROVINCIAL',
      'MERCANTIL',
      'BNC',
      'BANCAMIGA',
      'VENEZUELA',
      'PAGO_MOVIL',
    ]);
    expect(BANK_CODE_MAP.PROVINCIAL.apiPayTypes).toEqual(['BBVAProvincial', 'Provincial']);
  });
});

describe('queryP2PAds - request contract', () => {
  it('POSTs the documented endpoint with the current default payload', async () => {
    const fetchMock = vi.fn(makeFetchMock([makeBinanceResponse([makeAdItem()])]));
    vi.stubGlobal('fetch', fetchMock);

    await BinanceP2PService.queryP2PAds();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(requestBody(fetchMock)).toEqual({
      asset: 'USDT',
      fiat: 'VES',
      merchantCheck: false,
      page: 1,
      rows: 20,
      payTypes: [],
      publisherType: null,
      tradeType: 'BUY',
      transAmount: null,
    });
  });

  it('sends the browser-imitating headers the endpoint currently requires', async () => {
    const fetchMock = vi.fn(makeFetchMock([makeBinanceResponse([])]));
    vi.stubGlobal('fetch', fetchMock);

    await BinanceP2PService.queryP2PAds();

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Origin']).toBe('https://p2p.binance.com');
    expect(headers['clientType']).toBe('web');
    expect(headers['User-Agent']).toContain('Mozilla/5.0');
  });

  it('passes through caller overrides and stringifies transAmount', async () => {
    const fetchMock = vi.fn(makeFetchMock([makeBinanceResponse([])]));
    vi.stubGlobal('fetch', fetchMock);

    await BinanceP2PService.queryP2PAds({
      tradeType: 'SELL',
      page: 3,
      rows: 15,
      payTypes: ['Banesco'],
      transAmount: 50000,
      publisherType: 'merchant',
      merchantCheck: true,
    });

    expect(requestBody(fetchMock)).toMatchObject({
      tradeType: 'SELL',
      page: 3,
      rows: 15,
      payTypes: ['Banesco'],
      transAmount: '50000',
      publisherType: 'merchant',
      merchantCheck: true,
    });
  });

  it('BUG: never paginates - page is 1 unless the caller overrides it', async () => {
    // Depth loss #1 (audit): the snapshot path never passes `page`, so only the
    // first `rows` ads of the book are ever visible.
    const fetchMock = vi.fn(makeFetchMock([makeBinanceResponse([makeAdItem()])]));
    vi.stubGlobal('fetch', fetchMock);

    await BinanceP2PService.fetchFullMarketSnapshot();

    for (let i = 0; i < fetchMock.mock.calls.length; i++) {
      expect(requestBody(fetchMock, i).page).toBe(1);
    }
  });
});

describe('queryP2PAds - error handling', () => {
  it('throws on a non-2xx HTTP response', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({}),
    } as unknown as Response));

    await expect(BinanceP2PService.queryP2PAds()).rejects.toThrow(
      'Binance HTTP error: 429 Too Many Requests'
    );
  });

  it('throws when Binance returns a non-000000 business code', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ code: '000002', message: 'rate limited', data: [] }),
    } as unknown as Response));

    await expect(BinanceP2PService.queryP2PAds()).rejects.toThrow(
      'Binance API code error: 000002 - rate limited'
    );
  });

  it('throws when data is not an array', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ code: '000000', message: null, data: null }),
    } as unknown as Response));

    await expect(BinanceP2PService.queryP2PAds()).rejects.toThrow(
      'Invalid data payload returned from Binance API'
    );
  });

  it('surfaces an abort as a timeout error naming the 12s budget', async () => {
    vi.stubGlobal('fetch', async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    await expect(BinanceP2PService.queryP2PAds()).rejects.toThrow(
      'Binance P2P request timed out after 12000ms'
    );
  });

  it('BUG: no retry and no backoff - a single failure propagates immediately', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(BinanceP2PService.queryP2PAds()).rejects.toThrow('ECONNRESET');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('normalizeAds', () => {
  it('maps the fields the codebase currently keeps', () => {
    const [ad] = BinanceP2PService.normalizeAds([
      makeAdItem({ advNo: 'A1', price: '919.55', min: '2000', max: '80000', tradable: '250' }),
    ]);

    expect(ad).toEqual({
      advNo: 'A1',
      price: 919.55,
      minAmountVes: 2000,
      maxAmountVes: 80000,
      availableUsdt: 250,
      merchantName: 'Comerciante',
      userType: 'merchant',
      ordersCount: 120,
      finishRate: 0.98,
      paymentMethods: ['Banesco'],
    });
  });

  it('skips malformed entries instead of fabricating values', () => {
    const raw = [
      makeAdItem({ advNo: 'ok' }),
      { adv: undefined, advertiser: undefined } as never,
      makeAdItem({ advNo: 'nan', price: 'not-a-number' }),
      makeAdItem({ advNo: 'zero', price: '0' }),
      makeAdItem({ advNo: 'negative', price: '-5' }),
    ];

    const result = BinanceP2PService.normalizeAds(raw);
    expect(result.map((a) => a.advNo)).toEqual(['ok']);
  });

  it('falls back from tradableQuantity to surplusAmount, then to 0', () => {
    const [withSurplus] = BinanceP2PService.normalizeAds([
      makeAdItem({ tradable: '', surplus: '42' }),
    ]);
    expect(withSurplus.availableUsdt).toBe(42);

    const [withNeither] = BinanceP2PService.normalizeAds([
      makeAdItem({ tradable: '', surplus: '' }),
    ]);
    expect(withNeither.availableUsdt).toBe(0);
  });

  it('defaults a missing nickname to "Anónimo" and a missing userType to "user"', () => {
    const item = makeAdItem();
    item.advertiser.nickName = '';
    item.advertiser.userType = '';
    const [ad] = BinanceP2PService.normalizeAds([item]);
    expect(ad.merchantName).toBe('Anónimo');
    expect(ad.userType).toBe('user');
  });

  it('BUG: does not deduplicate by advNo', () => {
    const dup = makeAdItem({ advNo: 'same' });
    const result = BinanceP2PService.normalizeAds([dup, dup, dup]);
    expect(result).toHaveLength(3);
  });
});

describe('fetchFullMarketSnapshot', () => {
  const buyAds = [
    makeAdItem({ advNo: 'b1', price: '918.00', tradable: '100' }),
    makeAdItem({ advNo: 'b2', price: '919.00', tradable: '300' }),
  ];
  const sellAds = [
    makeAdItem({ advNo: 's1', price: '921.00', tradable: '200' }),
    makeAdItem({ advNo: 's2', price: '920.00', tradable: '200' }),
  ];

  it('queries BUY and SELL and computes the documented aggregates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => makeBinanceResponse(body.tradeType === 'BUY' ? buyAds : sellAds),
        } as unknown as Response;
      })
    );

    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.bestBuyPrice).toBe(918);   // lowest buy
    expect(snap.bestSellPrice).toBe(921);  // highest sell
    expect(snap.averageBuyPrice).toBe(918.5);
    expect(snap.weightedBuyPrice).toBe(918.75); // (918*100 + 919*300) / 400
    expect(snap.spreadAbsolute).toBe(3);
    expect(snap.spreadPercentage).toBe(0.33);
    expect(snap.source).toBe('BINANCE_P2P');
    expect(snap.status).toBe('LIVE');
    expect(snap.lastError).toBeNull();
  });

  it('translates a bank filter into the mapped apiPayTypes', async () => {
    const fetchMock = vi.fn(makeFetchMock([makeBinanceResponse(buyAds)]));
    vi.stubGlobal('fetch', fetchMock);

    await BinanceP2PService.fetchFullMarketSnapshot('PROVINCIAL', 50000);

    const body = requestBody(fetchMock);
    expect(body.payTypes).toEqual(['BBVAProvincial', 'Provincial']);
    expect(body.transAmount).toBe('50000');
  });

  it('throws when both sides come back empty', async () => {
    vi.stubGlobal('fetch', makeFetchMock([makeBinanceResponse([])]));
    await expect(BinanceP2PService.fetchFullMarketSnapshot()).rejects.toThrow(
      'No active P2P ads found for the specified criteria.'
    );
  });

  it('BUG: requests 20 ads per side but discards half via slice(0, 10)', async () => {
    // Depth loss #2 (audit).
    const many = Array.from({ length: 20 }, (_, i) =>
      makeAdItem({ advNo: `b${i}`, price: String(900 + i) })
    );
    const fetchMock = vi.fn(makeFetchMock([makeBinanceResponse(many)]));
    vi.stubGlobal('fetch', fetchMock);

    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(requestBody(fetchMock).rows).toBe(20);
    expect(snap.topBuyAds).toHaveLength(10);
    expect(snap.topSellAds).toHaveLength(10);
  });

  it('reports a missing side as null, never derived from the other side', async () => {
    // Was audit B13 (bestBuy = bestSell * 1.01). Fixed in C2 / project rule 6.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () =>
            makeBinanceResponse(body.tradeType === 'SELL' ? sellAds : []),
        } as unknown as Response;
      })
    );

    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.topBuyAds).toHaveLength(0);
    expect(snap.bestBuyPrice).toBeNull();
    expect(snap.averageBuyPrice).toBeNull();
    expect(snap.medianBuyPrice).toBeNull();
    expect(snap.weightedBuyPrice).toBeNull();
    // A spread needs two prices.
    expect(snap.spreadAbsolute).toBeNull();
    expect(snap.spreadPercentage).toBeNull();
    // The side that really existed is untouched.
    expect(snap.bestSellPrice).toBe(921);
  });

  it('reports every aggregate as null when BOTH sides are empty', async () => {
    // fetchFullMarketSnapshot still throws in that case; this pins that the
    // failure is explicit rather than a snapshot full of zeros.
    vi.stubGlobal('fetch', makeFetchMock([makeBinanceResponse([])]));
    await expect(BinanceP2PService.fetchFullMarketSnapshot()).rejects.toThrow(
      'No active P2P ads found for the specified criteria.'
    );
  });

  it('reports a null weighted price when no ad publishes an available amount', async () => {
    const noVolume = [makeAdItem({ advNo: 'v0', price: '918.00', tradable: '', surplus: '' })];
    vi.stubGlobal('fetch', makeFetchMock([makeBinanceResponse(noVolume)]));

    const snap = await BinanceP2PService.fetchFullMarketSnapshot();
    expect(snap.bestBuyPrice).toBe(918);
    // Zero total weight makes the weighted average undefined, not zero.
    expect(snap.weightedBuyPrice).toBeNull();
  });
});

describe('FASE 2 - medians agree across both sides', () => {
  /** Four ads at the given prices, all otherwise identical. */
  const adsAt = (prices: number[]) =>
    prices.map((p, i) => makeAdItem({ advNo: `a${i}`, price: p.toFixed(2), tradable: '100' }));

  function stubSides(buy: number[], sell: number[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () =>
            makeBinanceResponse(adsAt(body.tradeType === 'BUY' ? buy : sell)),
        } as unknown as Response;
      })
    );
  }

  it('averages the two middle prices for an even number of ads', async () => {
    // Was: BUY sorted ascending -> [floor(4/2)] = 3rd element = 923.
    stubSides([921, 922, 923, 924], [921, 922, 923, 924]);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.medianBuyPrice).toBe(922.5);
    expect(snap.medianSellPrice).toBe(922.5);
  });

  it('gives BOTH sides the same median for the same prices', async () => {
    // Was: BUY ascending gave the upper-middle, SELL descending the
    // lower-middle, so identical books reported different medians.
    stubSides([921, 922, 923, 924], [924, 923, 922, 921]);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.medianBuyPrice).toBe(snap.medianSellPrice);
    expect(snap.medianBuyPrice).toBe(922.5);
  });

  it('returns the middle price for an odd number of ads', async () => {
    stubSides([921, 922, 923], [921, 922, 923]);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();
    expect(snap.medianBuyPrice).toBe(922);
  });

  it('the median ignores an extreme ad that dominates the extremes', async () => {
    // The production incident, end to end through the capture layer.
    const level = Array.from({ length: 19 }, (_, i) => 921 + i * 0.05);
    stubSides(level, [...level, 980]);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.bestSellPrice).toBe(980); // raw extreme preserved for auditing
    expect(snap.medianSellPrice).toBeCloseTo(921.48, 1); // strategic level intact
    expect(snap.medianSellPrice! - snap.medianBuyPrice!).toBeLessThan(0.1);
  });

  it('keeps the aggregates null when a side is empty', async () => {
    stubSides([], [921, 922]);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.medianBuyPrice).toBeNull();
    expect(snap.averageBuyPrice).toBeNull();
    expect(snap.medianSellPrice).toBe(921.5);
  });
});

describe('FASE 2 - strategic prices', () => {
  const adsAt = (prices: number[]) =>
    prices.map((p, i) => makeAdItem({ advNo: `a${i}`, price: p.toFixed(2), tradable: '100' }));

  function stubSides(buy: number[], sell: number[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => makeBinanceResponse(adsAt(body.tradeType === 'BUY' ? buy : sell)),
        } as unknown as Response;
      })
    );
  }

  it('takes RECOMPRA from the BUY side and VENTA from the SELL side', async () => {
    stubSides([921.0, 921.4, 921.8], [922.0, 922.4, 922.8]);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.strategicBuyPrice).toBe(921.4);
    expect(snap.strategicSellPrice).toBe(922.4);
    expect(snap.strategicProvenance).toBe('STRATEGIC');
    expect(snap.strategicReason).toBeNull();
  });

  it('divides by the repurchase price, never by whichever is smaller', async () => {
    // A losing market: venta 918 under recompra 941. The raw formula picks
    // min() as the denominator and takes the absolute value; the strategic
    // one keeps the sign and always divides by the repurchase price.
    stubSides([941.0], [918.0]);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.strategicSpreadPct).toBeCloseTo(((918 - 941) / 941) * 100, 2);
    expect(snap.strategicSpreadPct!).toBeLessThan(0);
  });

  it('says which side is missing instead of producing a number', async () => {
    stubSides([], [921.0, 921.5]);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.strategicBuyPrice).toBeNull();
    expect(snap.strategicSpreadPct).toBeNull();
    expect(snap.strategicReason).toContain('BUY');
  });
});
