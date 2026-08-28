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
      // FASE 4: additive. Distinguishes "no volume" from "volume unknown".
      availableUsdtReported: 250,
      merchantName: 'Comerciante',
      userType: 'merchant',
      ordersCount: 120,
      finishRate: 0.98,
      paymentMethods: ['Banesco'],
      // FASE 3: additive. The canonical code is kept alongside the label.
      paymentOptions: [{ payType: 'Banesco', tradeMethodName: 'Banesco' }],
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
    /*
     * SIGNED, and the percentage is no longer rounded to two decimals.
     *
     * Ask 918 below bid 921 is a profitable crossing, so both stay positive
     * here - the sign only becomes visible on a normal book, where the ask
     * sits above the bid. The percentage divides by the ENTRY price (918),
     * which is the money committed, not by whichever of the two is smaller.
     */
    expect(snap.spreadAbsolute).toBe(3);
    expect(snap.spreadPercentage).toBeCloseTo(0.3268, 4);
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

  it('keeps every ad it requested - no depth is discarded', async () => {
    /*
     * Was audit depth loss #2: rows was 20 but the snapshot exposed
     * slice(0, 10), so half of what had already been fetched, normalized and
     * fed to the aggregates never reached any consumer. An absent bank could
     * not be told from a bank that merely fell below tenth place.
     */
    const many = Array.from({ length: 20 }, (_, i) =>
      makeAdItem({ advNo: `b${i}`, price: String(900 + i) })
    );
    const fetchMock = vi.fn(makeFetchMock([makeBinanceResponse(many)]));
    vi.stubGlobal('fetch', fetchMock);

    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(requestBody(fetchMock).rows).toBe(20);
    expect(snap.topBuyAds).toHaveLength(20);
    expect(snap.topSellAds).toHaveLength(20);
    // The 20th ad is reachable, not just counted.
    expect(snap.topBuyAds[19].advNo).toBe('b19');
  });

  it('exposes exactly what was captured, however few', async () => {
    // Fewer ads than requested must not be padded, and none dropped.
    const three = Array.from({ length: 3 }, (_, i) =>
      makeAdItem({ advNo: `s${i}`, price: String(920 + i) })
    );
    vi.stubGlobal('fetch', vi.fn(makeFetchMock([makeBinanceResponse(three)])));

    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.topBuyAds).toHaveLength(3);
    expect(snap.topSellAds).toHaveLength(3);
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

describe('FASE 4 - liquidity absence survives normalization', () => {
  const normalizeOne = (o: Parameters<typeof makeAdItem>[0]) =>
    BinanceP2PService.normalizeAds([makeAdItem(o)])[0];

  it('reports a published volume as published', () => {
    const ad = normalizeOne({ tradable: '250' });
    expect(ad.availableUsdtReported).toBe(250);
    expect(ad.availableUsdt).toBe(250);
  });

  it('reports a published zero as zero, not as absent', () => {
    const ad = normalizeOne({ tradable: '0', surplus: '0' });
    expect(ad.availableUsdtReported).toBe(0);
  });

  it('reports an unpublished volume as null, not as zero', () => {
    // The old `parseFloat(...) || 0` mapped this onto 0, making "unknown"
    // indistinguishable from "none".
    const ad = normalizeOne({ tradable: '', surplus: '' });
    expect(ad.availableUsdtReported).toBeNull();
    expect(ad.availableUsdt).toBe(0); // compatibility field, unchanged
  });

  it('falls back to surplusAmount when tradableQuantity is absent', () => {
    expect(normalizeOne({ tradable: '', surplus: '77' }).availableUsdtReported).toBe(77);
  });
});

/**
 * THE RAW SPREAD KEEPS ITS SIGN.
 *
 * `spreadAbsolute` and `spreadPercentage` are the only figures the capture
 * layer publishes about the relationship between the two sides, and they are
 * persisted as HistoryRecord.spreadPct and drawn on the history screen. They
 * used to be absolute-valued, so on a normal book - ask above bid, which is
 * what a functioning market looks like - a loss was displayed as a gain.
 *
 * types.ts had specified the opposite all along: "Signed. Never
 * absolute-valued: a loss must stay a loss."
 */
describe('el spread crudo conserva el signo', () => {
  const adAt = (price: number) => makeAdItem({ price: price.toFixed(2), tradable: '100' });

  function stubBook(askSide: number, bidSide: number) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        // tradeType=BUY returns the ads I would buy FROM: the asks.
        const price = body.tradeType === 'BUY' ? askSide : bidSide;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => makeBinanceResponse([adAt(price)]),
        } as unknown as Response;
      })
    );
  }

  it('1 - libro rentable: entrada 940, salida 950 -> spread POSITIVO', async () => {
    stubBook(940, 950);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.bestBuyPrice).toBe(940);
    expect(snap.bestSellPrice).toBe(950);
    expect(snap.spreadAbsolute).toBe(10);
    // (950 - 940) / 940 * 100
    expect(snap.spreadPercentage).toBeCloseTo(1.0638, 4);
  });

  it('2 - libro perdedor: entrada 950, salida 940 -> spread NEGATIVO', async () => {
    stubBook(950, 940);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.spreadAbsolute).toBe(-10);
    expect(snap.spreadPercentage).toBeCloseTo(-1.0526, 4);
    expect(snap.spreadPercentage as number).toBeLessThan(0);
  });

  it('3 - libro plano: entrada 945, salida 945 -> spread CERO', async () => {
    stubBook(945, 945);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.spreadAbsolute).toBe(0);
    expect(snap.spreadPercentage).toBe(0);
  });

  it('4 - el libro real de producción ya no informa una pérdida como ganancia', async () => {
    /*
     * The medians observed in production: ask 945.75 above bid 944.75. Crossing
     * that costs the taker 0.1057%. The absolute-valued version reported
     * +0.1058% - the right magnitude with the wrong sign, which is the one
     * failure mode this project cannot have.
     */
    stubBook(945.75, 944.75);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.spreadPercentage).toBeCloseTo(-0.1057, 4);
    expect(snap.spreadPercentage).not.toBeCloseTo(0.1058, 4);
    expect(snap.spreadAbsolute).toBe(-1);
  });

  it('divides by the ENTRY price, not by whichever of the two is lower', async () => {
    /*
     * The old base was Math.min(ask, bid). On a losing book that is the bid -
     * money never committed. The denominator has to be what was actually put
     * in, which is the ask.
     */
    stubBook(1000, 900);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.spreadPercentage).toBeCloseTo(-10, 6); // -100 / 1000
    expect(snap.spreadPercentage).not.toBeCloseTo(-11.11, 2); // -100 / 900
  });

  it('reports no spread at all when one side of the book is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () =>
            makeBinanceResponse(body.tradeType === 'BUY' ? [adAt(940)] : []),
        } as unknown as Response;
      })
    );

    const snap = await BinanceP2PService.fetchFullMarketSnapshot();
    // An absent price is absent: never 0, and never derived from one side.
    expect(snap.spreadAbsolute).toBeNull();
    expect(snap.spreadPercentage).toBeNull();
  });
});
