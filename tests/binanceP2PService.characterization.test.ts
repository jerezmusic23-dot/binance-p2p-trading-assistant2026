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

  it('BUG: fabricates the missing side from the other side (+1% / -1%)', async () => {
    // Audit B13 / project rule 6: a missing side must be null, never derived.
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
    // 921 * 1.01 = 930.21 -> a price no advertiser ever published.
    expect(snap.bestBuyPrice).toBe(930.21);
  });
});
