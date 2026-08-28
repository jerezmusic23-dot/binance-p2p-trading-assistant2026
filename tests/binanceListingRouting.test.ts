/**
 * EL PRIMER ESLABÓN: `tradeType` pedido -> libro que lo recibe.
 *
 * THE GAP THIS CLOSES
 *
 * Every other link in the chain was pinned by a test - the taker translation,
 * the executability legs, the maker mirror, the Telegram vocabulary. The FIRST
 * one was not: that the ads Binance returns for `tradeType=X` end up in the
 * book named X. It was guaranteed by reading centralStore.ts, and a reading is
 * not a guarantee.
 *
 * An accidental swap in binanceP2PService.fetchFullMarketSnapshot or in
 * CentralMarketStore.refreshBankMatrix would invert every downstream number
 * while leaving all those other tests green, because they all start AFTER this
 * point and take the books as given.
 *
 * HOW IT IS PROVEN
 *
 * The stub answers each request with ads that carry the requested tradeType in
 * their own advNo and merchant name, at prices that cannot be confused. Then
 * each public surface is asked where those specific ads ended up. Nothing is
 * inferred from a constant.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeAdItem, makeBinanceResponse } from './helpers/fixtures.js';

const originalCwd = process.cwd();
let tmpDir: string;

/**
 * Ads that announce which listing they came from.
 *
 * Deliberately marked in three independent ways - advNo, merchant and price -
 * so a test cannot pass by coincidence and a failure says which side leaked.
 */
const ASK_PRICE = 940; // returned for tradeType=BUY: ads that SELL USDT
const BID_PRICE = 950; // returned for tradeType=SELL: ads that BUY USDT

function stubBinanceByTradeType() {
  const seen: string[] = [];
  const mock = vi.fn(async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const tradeType = String(body.tradeType);
    seen.push(tradeType);

    const price = tradeType === 'BUY' ? ASK_PRICE : BID_PRICE;
    const ads = [
      makeAdItem({
        advNo: `ANUNCIO-DEL-LISTADO-${tradeType}`,
        nickName: `MERCHANT-${tradeType}`,
        price: price.toFixed(2),
        min: '1000',
        max: '200000',
        surplus: '5000',
        tradable: '5000',
        tradeMethods: [{ payType: 'Banesco', tradeMethodName: 'Banesco' }],
      }),
      // A second ad so an extreme has to be chosen rather than fallen into.
      makeAdItem({
        advNo: `ANUNCIO-2-DEL-LISTADO-${tradeType}`,
        nickName: `MERCHANT-${tradeType}`,
        price: (price + (tradeType === 'BUY' ? 5 : -5)).toFixed(2),
        min: '1000',
        max: '200000',
        surplus: '5000',
        tradable: '5000',
        tradeMethods: [{ payType: 'Banesco', tradeMethodName: 'Banesco' }],
      }),
    ];

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => makeBinanceResponse(ads),
    } as unknown as Response;
  });

  vi.stubGlobal('fetch', mock);
  return { mock, seen };
}

async function freshStore() {
  vi.resetModules();
  const { CentralMarketStore } = await import('../server/centralStore.js');
  const { BinanceP2PService } = await import('../server/binanceP2PService.js');
  return { store: CentralMarketStore.getInstance(), BinanceP2PService };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-routing-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('1. la petición cruda lleva el tradeType al cuerpo HTTP', () => {
  it('sends the tradeType it was asked for, verbatim', async () => {
    const { mock } = stubBinanceByTradeType();
    const { BinanceP2PService } = await freshStore();

    await BinanceP2PService.queryP2PAds({ tradeType: 'SELL', rows: 20 });

    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).tradeType).toBe('SELL');
  });

  it('returns exactly the ads the stub answered for that tradeType', async () => {
    stubBinanceByTradeType();
    const { BinanceP2PService } = await freshStore();

    const buyRaw = await BinanceP2PService.queryP2PAds({ tradeType: 'BUY', rows: 20 });
    const sellRaw = await BinanceP2PService.queryP2PAds({ tradeType: 'SELL', rows: 20 });

    expect(buyRaw[0].adv.advNo).toBe('ANUNCIO-DEL-LISTADO-BUY');
    expect(sellRaw[0].adv.advNo).toBe('ANUNCIO-DEL-LISTADO-SELL');
  });
});

describe('2. el snapshot deja cada libro donde le corresponde', () => {
  it('topBuyAds hold the tradeType=BUY ads, and topSellAds the SELL ones', async () => {
    stubBinanceByTradeType();
    const { BinanceP2PService } = await freshStore();

    const snapshot = await BinanceP2PService.fetchFullMarketSnapshot();

    /*
     * THE ASSERTION THAT WOULD CATCH A SWAP. If the two Promise.all results
     * were assigned the other way round in fetchFullMarketSnapshot, these
     * advNos would trade places and every price below would invert with them.
     */
    for (const ad of snapshot.topBuyAds) {
      expect(ad.advNo).toContain('LISTADO-BUY');
      expect(ad.merchantName).toBe('MERCHANT-BUY');
    }
    for (const ad of snapshot.topSellAds) {
      expect(ad.advNo).toContain('LISTADO-SELL');
      expect(ad.merchantName).toBe('MERCHANT-SELL');
    }
  });

  it('takes the LOWEST of the BUY listing and the HIGHEST of the SELL listing', async () => {
    stubBinanceByTradeType();
    const { BinanceP2PService } = await freshStore();

    const snapshot = await BinanceP2PService.fetchFullMarketSnapshot();

    // BUY listing holds 940 and 945: the ask I would pay is the cheaper one.
    expect(snapshot.bestBuyPrice).toBe(ASK_PRICE);
    // SELL listing holds 950 and 945: the bid I would receive is the dearer.
    expect(snapshot.bestSellPrice).toBe(BID_PRICE);
  });
});

describe('3. la matriz por banco conserva el enrutado', () => {
  it('the executable BUY leg comes from the tradeType=BUY listing', async () => {
    stubBinanceByTradeType();
    const { store } = await freshStore();

    const { byBank } = await store.getExecutability(true);
    const cell = byBank.BANESCO['10K'];

    /*
     * bestExecutableBuy is my ENTRY, and it must come from the ads that sell
     * USDT - the tradeType=BUY listing. The advNo says which listing it is,
     * so this cannot be satisfied by a coincidence of prices.
     */
    expect(cell.bestExecutableBuy?.advNo).toContain('LISTADO-BUY');
    expect(cell.bestExecutableBuy?.price).toBe(ASK_PRICE);

    expect(cell.bestExecutableSell?.advNo).toContain('LISTADO-SELL');
    expect(cell.bestExecutableSell?.price).toBe(BID_PRICE);
  });

  it('a swap here would invert the sign of the whole cell', async () => {
    stubBinanceByTradeType();
    const { store } = await freshStore();

    const { byBank } = await store.getExecutability(true);
    const cell = byBank.BANESCO['10K'];

    // Entry 940, exit 950: profitable, and positive.
    const spread = cell.spreadPct;
    expect(spread).not.toBeNull();
    expect(spread as number).toBeGreaterThan(0);
    // Read from the opposite listings it would be entry 950, exit 940.
    expect(spread as number).not.toBe(-(spread as number));
  });
});

describe('4. la capa maker aplica el espejo sobre ese mismo enrutado', () => {
  it('MI COMPRA competes with the ads from the tradeType=SELL listing', async () => {
    stubBinanceByTradeType();
    const { store } = await freshStore();

    const matrix = await store.getMakerMatrix(true);
    const analysis = matrix.cells.BANESCO['10K'].recommendation?.buyAnalysis;

    /*
     * THE MIRROR, PROVEN FROM THE HTTP RESPONSE.
     *
     * My buy ad is shown to people who want to sell USDT, and those people
     * search the tradeType=SELL listing - so my rivals are the ads that came
     * back from SELL. Their advNos say so. This is the only test in the suite
     * that follows that claim all the way from the wire.
     */
    expect(analysis?.definition.listingTradeType).toBe('SELL');
    expect(analysis?.ladder.length).toBeGreaterThan(0);
    for (const entry of analysis?.ladder ?? []) {
      expect(entry.advNo).toContain('LISTADO-SELL');
      expect(entry.merchant).toBe('MERCHANT-SELL');
    }
    // Leader of a buy ladder is the HIGHEST: 950, not 945.
    expect(analysis?.leaderPrice).toBe(BID_PRICE);
  });

  it('MI VENTA competes with the ads from the tradeType=BUY listing', async () => {
    stubBinanceByTradeType();
    const { store } = await freshStore();

    const matrix = await store.getMakerMatrix(true);
    const analysis = matrix.cells.BANESCO['10K'].recommendation?.sellAnalysis;

    expect(analysis?.definition.listingTradeType).toBe('BUY');
    for (const entry of analysis?.ladder ?? []) {
      expect(entry.advNo).toContain('LISTADO-BUY');
      expect(entry.merchant).toBe('MERCHANT-BUY');
    }
    // Leader of a sell ladder is the LOWEST: 940, not 945.
    expect(analysis?.leaderPrice).toBe(ASK_PRICE);
  });

  it('BUG: the two listings must not be interchangeable at any point', async () => {
    stubBinanceByTradeType();
    const { store } = await freshStore();

    const matrix = await store.getMakerMatrix(true);
    const rec = matrix.cells.BANESCO['10K'].recommendation;

    /*
     * The two ladders must not share a single ad. If any stage of the chain
     * fed the same book to both sides, this is where it would show.
     */
    const buyAdvNos = new Set((rec?.buyAnalysis.ladder ?? []).map((e) => e.advNo));
    const sellAdvNos = new Set((rec?.sellAnalysis.ladder ?? []).map((e) => e.advNo));

    expect(buyAdvNos.size).toBeGreaterThan(0);
    expect(sellAdvNos.size).toBeGreaterThan(0);
    for (const advNo of buyAdvNos) expect(sellAdvNos.has(advNo)).toBe(false);
  });
});

describe('5. la historia guardada hereda el mismo enrutado', () => {
  it('records the leading ad of each side with the listing it came from', async () => {
    stubBinanceByTradeType();
    const { store } = await freshStore();
    const { HistoricalMarketStore } = await import('../server/historicalMarketStore.js');

    await store.getMakerMatrix(true);
    // getMakerMatrix refreshes the sweep, which is what writes the series.
    const series = HistoricalMarketStore.load('BANESCO', '10K');

    expect(series.length).toBeGreaterThan(0);
    const provenance = series[series.length - 1].provenance;

    /*
     * The stored provenance names the tradeType each ad came from. A future
     * inversion in the capture would be visible here, in the persisted record,
     * long after the sweep that produced it.
     */
    expect(provenance?.buy?.tradeType).toBe('SELL');
    expect(provenance?.buy?.advNo).toContain('LISTADO-SELL');
    expect(provenance?.sell?.tradeType).toBe('BUY');
    expect(provenance?.sell?.advNo).toContain('LISTADO-BUY');
  });
});
