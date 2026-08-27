/**
 * BINANCE tradeType <-> ARBITRAGE LEG, pinned at every link in the chain.
 *
 * Getting this backwards does not break anything visibly. It inverts the sign
 * of every spread, which turns the market's own bid-ask - what a taker pays to
 * cross - into a permanent, fictitious profit on every bank and every amount.
 * A dashboard full of opportunities that cannot be executed looks healthier
 * than an honest one, which is exactly why it needs a test rather than a
 * comment.
 *
 * THE MAPPING
 *
 *   tradeType 'BUY'  -> arbitrage BUY leg  -> asks -> best is the LOWEST price
 *   tradeType 'SELL' -> arbitrage SELL leg -> bids -> best is the HIGHEST price
 *   spread = ((sellPrice - buyPrice) / buyPrice) * 100, signed
 *
 * The parameter is the SEARCHER's intent, not the advertiser's action: asking
 * for tradeType=BUY is pressing "Buy USDT" on p2p.binance.com and returns the
 * ads you buy FROM. The advertisers behind them are selling, and that reading
 * is what makes this easy to invert by accident.
 *
 * These fixtures are SYNTHETIC. They prove the wiring, not the market.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { BinanceP2PService } from '../server/binanceP2PService.js';
import { evaluateBankTiers } from '../server/executability.js';
import { runOpportunityEngine } from '../server/opportunityEngine.js';
import { buildCell } from '../server/executableMatrix.js';
import type { NormalizedAd } from '../server/types.js';
import { makeAdItem, makeBinanceResponse } from './helpers/fixtures.js';

const NOW = Date.UTC(2026, 0, 6, 12, 0, 0);

function ad(price: number, available = 500): NormalizedAd {
  return {
    advNo: `adv-${price}`,
    price,
    minAmountVes: 1_000,
    maxAmountVes: 100_000,
    availableUsdtReported: available,
    merchantName: 'M',
    ordersCount: 100,
    finishRate: 0.98,
    userType: 'merchant',
    paymentOptions: [{ payType: 'Banesco', tradeMethodName: 'Banesco' }],
  } as NormalizedAd;
}

function cellFor(buyAds: NormalizedAd[], sellAds: NormalizedAd[], amountKey = '20K') {
  const tiers = evaluateBankTiers({
    bank: 'BANESCO',
    allowedCodes: ['Banesco'],
    buyAds,
    sellAds,
  });
  return buildCell({
    cell: tiers[amountKey],
    bankDisplayName: 'Banesco',
    amountKey,
    capturedAt: NOW,
    nowMs: NOW,
    buyAdsEvaluated: buyAds.length,
    sellAdsEvaluated: sellAds.length,
  });
}

describe('capture: which extreme is best on each Binance side', () => {
  /*
   * Driven through the real fetch path, with the stub answering by tradeType,
   * so the assertion covers the routing as well as the arithmetic: an answer
   * delivered to the wrong side would fail here.
   */
  function stubSides(buyAds: ReturnType<typeof makeAdItem>[], sellAds: ReturnType<typeof makeAdItem>[]) {
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
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the BUY side takes the LOWEST price - it is the ask, and I pay it', async () => {
    stubSides(
      [makeAdItem({ advNo: 'b1', price: '950.00' }), makeAdItem({ advNo: 'b2', price: '940.00' })],
      [makeAdItem({ advNo: 's1', price: '930.00' })]
    );

    const snapshot = await BinanceP2PService.fetchFullMarketSnapshot();
    expect(snapshot.bestBuyPrice).toBe(940);
  });

  it('the SELL side takes the HIGHEST price - it is the bid, and I receive it', async () => {
    stubSides(
      [makeAdItem({ advNo: 'b1', price: '950.00' })],
      [makeAdItem({ advNo: 's1', price: '930.00' }), makeAdItem({ advNo: 's2', price: '945.00' })]
    );

    const snapshot = await BinanceP2PService.fetchFullMarketSnapshot();
    expect(snapshot.bestSellPrice).toBe(945);
  });

  it('the strategic medians stay on their own sides too', async () => {
    stubSides(
      [makeAdItem({ advNo: 'b1', price: '945.00' }), makeAdItem({ advNo: 'b2', price: '946.50' })],
      [makeAdItem({ advNo: 's1', price: '944.00' }), makeAdItem({ advNo: 's2', price: '945.50' })]
    );

    const snapshot = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snapshot.strategicBuyPrice).toBe(945.75);
    expect(snapshot.strategicSellPrice).toBe(944.75);
    // The shape observed in production: ask above bid, so crossing costs.
    expect(snapshot.strategicSpreadPct).toBeLessThan(0);
  });
});

describe('executability: the legs keep the same sides', () => {
  it('bestExecutableBuy is the cheapest ad on the Binance BUY side', () => {
    const cell = cellFor([ad(950), ad(940)], [ad(960)]);
    expect(cell.buy?.price).toBe(940);
  });

  it('bestExecutableSell is the dearest ad on the Binance SELL side', () => {
    const cell = cellFor([ad(940)], [ad(955), ad(960)]);
    expect(cell.sell?.price).toBe(960);
  });

  it('the legs never cross sides: a cheap SELL ad cannot become the buy leg', () => {
    // 800 is the cheapest price in the whole fixture, and it is on the SELL
    // side. It is a bid: nobody can buy at it.
    const cell = cellFor([ad(940)], [ad(800), ad(960)]);

    expect(cell.buy?.price).toBe(940);
    expect(cell.sell?.price).toBe(960);
    expect(cell.buy?.price).not.toBe(800);
  });
});

describe('the arbitrage arithmetic, stated as MY operation', () => {
  /*
   * These numbers are MY prices, not Binance's parameter names:
   *
   *   940 is what I PAY for USDT   -> the ASK -> tradeType 'BUY'
   *   950 is what I RECEIVE for it -> the BID -> tradeType 'SELL'
   *
   * The fixture feeds them in through those sides, so the test exercises the
   * mapping rather than assuming it.
   */
  it('I buy at 940 and sell at 950: +10 VES, +1.0638%, an opportunity', () => {
    const myPurchaseAtAsk = 940;
    const mySaleAtBid = 950;
    const cell = cellFor([ad(myPurchaseAtAsk)], [ad(mySaleAtBid)]);

    expect(cell.buy?.price).toBe(myPurchaseAtAsk);
    expect(cell.sell?.price).toBe(mySaleAtBid);
    expect(mySaleAtBid - myPurchaseAtAsk).toBe(10);
    expect(cell.spreadPct).toBeCloseTo(1.06, 2);
    expect(cell.status).toBe('EXECUTABLE');
  });

  it('I buy at 950 and sell at 940: a loss, and never an opportunity', () => {
    const myPurchaseAtAsk = 950;
    const mySaleAtBid = 940;
    const cell = cellFor([ad(myPurchaseAtAsk)], [ad(mySaleAtBid)]);

    expect(cell.spreadPct).toBeLessThan(0);
    expect(cell.status).toBe('NO_OPPORTUNITY');
    expect(cell.status).not.toBe('EXECUTABLE');
  });

  it('the engine reports the same signed margin, to four decimals', () => {
    const byBank = {
      BANESCO: evaluateBankTiers({
        bank: 'BANESCO',
        allowedCodes: ['Banesco'],
        buyAds: [ad(940)],
        sellAds: [ad(950)],
      }),
    };
    const result = runOpportunityEngine({ byBank, bankOrder: ['BANESCO'] });
    const best = result.bestOpportunity;

    expect(best).not.toBeNull();
    expect(best?.buyPrice).toBe(940);
    expect(best?.sellPrice).toBe(950);
    expect(best?.spreadAbsolute).toBe(10);
    expect(best?.marginPct).toBeCloseTo(1.0638, 3);
  });

  it('the engine produces nothing when my sale is below my purchase', () => {
    const byBank = {
      BANESCO: evaluateBankTiers({
        bank: 'BANESCO',
        allowedCodes: ['Banesco'],
        buyAds: [ad(950)],
        sellAds: [ad(940)],
      }),
    };
    const result = runOpportunityEngine({ byBank, bankOrder: ['BANESCO'] });

    expect(result.bestOpportunity).toBeNull();
  });
});

describe('REGRESSION: the sides must not be swapped', () => {
  /*
   * A real, healthy market: the ask sits above the bid, so crossing it costs
   * the taker. The medians observed in production were BUY 945.75 against
   * SELL 944.75 - the same shape.
   *
   * Under the correct mapping that is a 0.11% LOSS and no opportunity.
   * Swapped, it reads as a 0.11% gain, on every bank and every amount, for as
   * long as the market has a spread at all. This test is what makes that
   * inversion impossible to land quietly.
   */
  it('a normal market (ask above bid) yields a LOSS, not an opportunity', () => {
    const cell = cellFor([ad(945.75)], [ad(944.75)]);

    expect(cell.spreadPct).toBeLessThan(0);
    expect(cell.status).toBe('NO_OPPORTUNITY');
  });

  it('the sign would flip if the legs were read from the opposite sides', () => {
    const correct = cellFor([ad(945.75)], [ad(944.75)]);
    const swapped = cellFor([ad(944.75)], [ad(945.75)]);

    expect(correct.spreadPct).toBeLessThan(0);
    expect(swapped.spreadPct).toBeGreaterThan(0);
    // Same book, opposite verdicts. Only one of them can be true.
    expect(correct.status).toBe('NO_OPPORTUNITY');
    expect(swapped.status).toBe('EXECUTABLE');
  });

  it('the spread divides by the BUY leg, so the sign cannot come from the base', () => {
    const cell = cellFor([ad(1000)], [ad(900)]);

    expect(cell.spreadPct).toBe(-10);
    expect(cell.spreadPct).not.toBe(-11.11);
  });
});

describe('the labels state the economics before the API parameter', () => {
  const opportunity = {
    bank: 'Banesco',
    amountVes: 20_000,
    buyPrice: 940,
    sellPrice: 950,
    // Same values under the unambiguous names.
    arbitrageBuyPrice: 940,
    arbitrageSellPrice: 950,
    buyAdvNo: 'a',
    sellAdvNo: 'b',
    spreadAbsolute: 10,
    spreadPct: 1.0638,
    marginAbsolute: 10,
    marginPct: 1.0638,
    buyAvailableUsdt: 500,
    sellAvailableUsdt: 400,
    availableUsdt: 400,
    verification: 'VERIFIED' as const,
    provenance: 'EXECUTABLE' as const,
    reason: null,
  };

  it('the Telegram message names what I do, the Binance side, and the parameter', async () => {
    const { formatOpportunityLifecycleMessage } = await import('../server/telegramNotifier.js');
    const body = formatOpportunityLifecycleMessage('DETECTED', opportunity, NOW);

    expect(body).toContain('OPORTUNIDAD DE ARBITRAJE');
    expect(body).toContain('<b>COMPRA USDT</b> (entrada)');
    expect(body).toContain('Fuente: Binance ASK');
    expect(body).toContain('<b>VENTA USDT</b> (salida)');
    expect(body).toContain('Fuente: Binance BID');
    // The API parameter is present but subordinate to the economics.
    expect(body.indexOf('COMPRA USDT')).toBeLessThan(body.indexOf('tradeType/API: BUY'));
    expect(body.indexOf('VENTA USDT')).toBeLessThan(body.indexOf('tradeType/API: SELL'));
  });

  it('reports the spread and the yield with their signs', async () => {
    const { formatOpportunityLifecycleMessage } = await import('../server/telegramNotifier.js');
    const body = formatOpportunityLifecycleMessage('DETECTED', opportunity, NOW);

    expect(body).toContain('SPREAD: <b>+10.00 VES</b>');
    expect(body).toContain('RENDIMIENTO: <b>+1.0638%</b>');
    expect(body).toContain('Liquidez compra: <b>500.00 USDT</b>');
    expect(body).toContain('Liquidez venta: <b>400.00 USDT</b>');
    expect(body).toContain('Estado: VERIFIED / EXECUTABLE');
  });

  it('states both legs are the same bank, which is a structural constraint', async () => {
    const { formatOpportunityLifecycleMessage } = await import('../server/telegramNotifier.js');
    const body = formatOpportunityLifecycleMessage('DETECTED', opportunity, NOW);

    expect(body).toContain('Banco compra: <b>Banesco</b>');
    expect(body).toContain('Banco venta: <b>Banesco</b>');
  });

  it('calls the result MARGEN BRUTO and never net profit', async () => {
    const { formatOpportunityLifecycleMessage } = await import('../server/telegramNotifier.js');
    const body = formatOpportunityLifecycleMessage('DETECTED', opportunity, NOW);

    expect(body).toContain('MARGEN BRUTO');
    expect(body).toContain('NO es beneficio neto');
    expect(body).not.toMatch(/ganancia|profit/i);
  });

  it('prints absent liquidity as not verifiable, never as zero', async () => {
    const { formatOpportunityLifecycleMessage } = await import('../server/telegramNotifier.js');
    const body = formatOpportunityLifecycleMessage(
      'DETECTED',
      { ...opportunity, buyAvailableUsdt: null, availableUsdt: null },
      NOW
    );

    expect(body).toContain('Liquidez compra: no verificable');
    expect(body).not.toContain('Liquidez compra: <b>0.00 USDT</b>');
  });
});
