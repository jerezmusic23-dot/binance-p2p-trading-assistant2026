/**
 * THE WHOLE ROBOT, END TO END.
 *
 *   Binance -> capture -> BANCO x MONTO -> maker strategy -> maker
 *           -> recommendation -> maker matrix -> Telegram
 *
 * Driven by time alone. Nothing here calls an HTTP route, because the point is
 * that the bot works with nobody watching.
 *
 * The Binance responses are SYNTHETIC and say nothing about the real market.
 * What they prove is that a captured book travels the whole chain and comes
 * out as a correctly worded price to publish, and that the taker engine - which
 * still runs, and still feeds the executable-matrix screen - no longer reaches
 * Telegram at all.
 *
 * THE TWO MODELS, AND WHY THEY DISAGREE ON PURPOSE
 *
 *   TAKER  ASK 940 / BID 950  ->  buy at 940, sell at 950, +10: an opportunity
 *   MAKER  the same book      ->  my buy ad competes in the SELL listing, whose
 *                                 leader is 950, and my sell ad in the BUY
 *                                 listing, whose leader is 940: publishing
 *                                 950.01 to sell at 939.99 LOSES 10.02
 *
 * That is not a contradiction, it is the spread: what the taker crosses, the
 * maker earns, and vice versa. A book that pays a taker cannot pay a maker on
 * both sides at once, which is why these suites assert opposite outcomes over
 * identical ads.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeAdItem, makeBinanceResponse } from './helpers/fixtures.js';

const originalCwd = process.cwd();
let tmpDir: string;

/** Every Telegram POST body the run produced. */
let telegramSent: string[] = [];

/**
 * One stub for both services, routed by URL.
 *
 * Binance answers by tradeType so the ASK and BID sides are genuinely
 * different books - a stub that returned the same ads to both would prove
 * nothing about the mapping.
 */
function stubWorld(askAds: ReturnType<typeof makeAdItem>[], bidAds: ReturnType<typeof makeAdItem>[]) {
  const mock = vi.fn(async (url: unknown, init: RequestInit) => {
    const href = String(url);

    if (href.includes('api.telegram.org')) {
      telegramSent.push(JSON.parse(String(init.body)).text as string);
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true }) } as unknown as Response;
    }

    const body = JSON.parse(String(init.body));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      // tradeType 'BUY' -> the ads I buy from -> the ASK side.
      json: async () => makeBinanceResponse(body.tradeType === 'BUY' ? askAds : bidAds),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function freshStore() {
  vi.resetModules();
  const { CentralMarketStore } = await import('../server/centralStore.js');
  const { StorageEngine } = await import('../server/storage.js');
  const { TelegramNotifier } = await import('../server/telegramNotifier.js');
  TelegramNotifier.resetInstance();
  return { store: CentralMarketStore.getInstance(), StorageEngine };
}

/** Banesco ads at a given price, with volume for the amounts under test. */
const banesco = (advNo: string, price: string) =>
  makeAdItem({
    advNo,
    price,
    min: '1000',
    max: '100000',
    surplus: '5000',
    tradable: '5000',
    tradeMethods: [{ payType: 'Banesco', tradeMethodName: 'Banesco' }],
  });

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-e2e-'));
  process.chdir(tmpDir);
  telegramSent = [];
  process.env.TELEGRAM_BOT_TOKEN = '1234567890:TEST-TOKEN-NOT-REAL';
  process.env.TELEGRAM_CHAT_ID = '-1001234567890';
});

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('a captured book becomes a price to publish, on its own', () => {
  /*
   * MY BUY rivals live in the tradeType=SELL listing, so they arrive as
   * `bidAds`; MY SELL rivals live in the tradeType=BUY listing and arrive as
   * `askAds`. Swap the two arguments below and the margin inverts - which is
   * exactly the mistake this whole phase exists to make impossible.
   *
   * The cents in 938.75 / 946.25 are load-bearing: they are what lets the
   * engine OBSERVE a 0.01 step. Without a single decimal anywhere in the book
   * the tick is unestablished and no price is proposed.
   */
  const myBuyRivals = [banesco('bid-1', '940.00'), banesco('bid-2', '938.75')];
  const mySellRivals = [banesco('ask-1', '945.00'), banesco('ask-2', '946.25')];

  it('publishes 940.01 / 944.99 and says so on Telegram, with no HTTP request', async () => {
    vi.useFakeTimers();
    stubWorld(mySellRivals, myBuyRivals);

    const { store } = await freshStore();
    store.start();

    // Boot snapshot, then the 2s matrix population. Time only.
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(7_000);

    const matrix = await store.getMakerMatrix();
    const cell = matrix.cells.BANESCO['20K'];

    // MI COMPRA: one tick above the highest buyer, read from the SELL listing.
    expect(cell.recommendation!.buyAnalysis.definition.listingTradeType).toBe('SELL');
    expect(cell.recommendation!.buyAnalysis.leaderPrice).toBe(940);
    expect(cell.recommendation!.priceToBeFirstBuy).toBe(940.01);

    // MI VENTA: one tick below the lowest seller, read from the BUY listing.
    expect(cell.recommendation!.sellAnalysis.definition.listingTradeType).toBe('BUY');
    expect(cell.recommendation!.sellAnalysis.leaderPrice).toBe(945);
    expect(cell.recommendation!.priceToBeFirstSell).toBe(944.99);

    expect(cell.recommendation!.recommended!.grossMarginVes).toBe(4.98);
    expect(cell.status).toBe('PUBLISH_AT_TOP');

    // And it left the building.
    const summaries = telegramSent.filter((t) => t.includes('MIS PRECIOS PARA PUBLICAR'));
    expect(summaries.length).toBeGreaterThan(0);

    const body = summaries[0];
    expect(body).toContain('Banesco');
    expect(body).toContain('🟢 Compra: <b>940.01</b>');
    expect(body).toContain('🔵 Venta: <b>944.99</b>');
    expect(body).toContain('💵 Margen: <b>+4.98 VES</b>');
    expect(body).toContain('MARGEN BRUTO POTENCIAL');

    store.stop();
  });

  it('sends nothing from the old arbitrage model, whatever the book pays', async () => {
    vi.useFakeTimers();
    // The classic taker opportunity: ASK 940, BID 950, +10 VES for a taker.
    stubWorld([banesco('ask-1', '940.00')], [banesco('bid-1', '950.00')]);

    const { store } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    // The taker engine still sees it...
    expect(store.getCachedBestOpportunity()?.marginPct).toBeGreaterThan(0);

    // ...and Telegram heard nothing about it.
    for (const body of telegramSent) {
      expect(body).not.toMatch(
        /ARBITRAJE|OPORTUNIDAD|EXECUTABLE|Binance ASK|Binance BID|tradeType\/API/
      );
    }

    store.stop();
  });

  it('a stable book produces one summary, not one every 45 seconds', async () => {
    vi.useFakeTimers();
    stubWorld(mySellRivals, myBuyRivals);

    const { store } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    const afterFirst = telegramSent.filter((t) => t.includes('MIS PRECIOS')).length;
    expect(afterFirst).toBe(1);

    // Four more matrix windows, same book. The 30-minute clock must hold.
    await vi.advanceTimersByTimeAsync(45_000 * 4);
    expect(telegramSent.filter((t) => t.includes('MIS PRECIOS')).length).toBe(1);
    // And no price changed, so no change alert either.
    expect(telegramSent.filter((t) => t.includes('CAMBIO DE PRECIO')).length).toBe(0);

    store.stop();
  });

  it('records the observation in the history while it is at it', async () => {
    vi.useFakeTimers();
    stubWorld([banesco('ask-1', '940.00')], [banesco('bid-1', '950.00')]);

    const { store, StorageEngine } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    const history = StorageEngine.getHistory();
    expect(history.length).toBeGreaterThan(0);
    // ASK is the buy leg; BID is the sell leg. Same mapping as the opportunity.
    expect(history[0].buyPrice).toBe(940);
    expect(history[0].sellPrice).toBe(950);

    const stats = store.getCaptureStats();
    expect(stats.completeSnapshots).toBeGreaterThan(0);
    expect(stats.incompleteSnapshots).toBe(0);

    store.stop();
  });
});

describe('the mandatory scenario, all the way to Telegram', () => {
  it('leader 940.00 / 945.00 -> publish 940.01 / 944.99, +4.98 VES, +0.5298%', async () => {
    vi.useFakeTimers();
    stubWorld(
      [banesco('ask-1', '945.00'), banesco('ask-2', '946.25')],
      [banesco('bid-1', '940.00'), banesco('bid-2', '938.75')]
    );

    const { store } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    const cell = (await store.getMakerMatrix()).cells.BANESCO['20K'];
    const pair = cell.recommendation!.recommended!;

    expect(pair.buy.price).toBe(940.01);
    expect(pair.sell.price).toBe(944.99);
    expect(pair.grossMarginVes).toBe(4.98);
    expect(pair.grossMarginPct).toBeCloseTo(0.5298, 4);

    const body = telegramSent.filter((t) => t.includes('MIS PRECIOS'))[0];
    // The prices Telegram prints are one observed tick off a real ad's price,
    // never a derived or rounded figure.
    expect(body).toContain('🟢 Compra: <b>940.01</b>');
    expect(body).toContain('🔵 Venta: <b>944.99</b>');
    expect(body).toContain('💵 Margen: <b>+4.98 VES</b> · +0.5298%');

    store.stop();
  });

  it('the matrix cell and the notifier report the identical operation', async () => {
    vi.useFakeTimers();
    stubWorld([banesco('ask-1', '950.00')], [banesco('bid-1', '950.50')]);

    const { store } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    const { executableMatrix } = await store.getExecutableMatrix();
    const sent = store.getCachedBestOpportunity();

    // Find the cell the notifier's opportunity came from.
    const cell = executableMatrix.cells[sent!.bank][
      executableMatrix.amountKeys.find(
        (k) => executableMatrix.cells[sent!.bank][k].amountVes === sent!.amountVes
      ) as string
    ];

    expect(cell.status).toBe('EXECUTABLE');
    expect(cell.opportunity?.buyPrice).toBe(sent?.buyPrice);
    expect(cell.opportunity?.sellPrice).toBe(sent?.sellPrice);
    expect(cell.opportunity?.marginPct).toBe(sent?.marginPct);

    store.stop();
  });
});

describe('a book WITHOUT an executable operation stays silent', () => {
  it('ASK 950 / BID 940 is a loss: no opportunity, no message', async () => {
    vi.useFakeTimers();
    stubWorld([banesco('ask-1', '950.00')], [banesco('bid-1', '940.00')]);

    const { store } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(store.getCachedBestOpportunity()).toBeNull();
    expect(telegramSent.filter((t) => t.includes('ARBITRAJE'))).toHaveLength(0);

    store.stop();
  });

  it('an ad of another bank cannot become an opportunity for this one', async () => {
    vi.useFakeTimers();
    // A superb spread, on ads that carry BNC's payType. No bank may claim them.
    const foreign = (advNo: string, price: string) =>
      makeAdItem({
        advNo,
        price,
        min: '1000',
        max: '100000',
        surplus: '5000',
        tradable: '5000',
        tradeMethods: [{ payType: 'NotARealBankCode', tradeMethodName: 'Unknown' }],
      });
    stubWorld([foreign('a', '900.00')], [foreign('b', '999.00')]);

    const { store } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(store.getCachedBestOpportunity()).toBeNull();
    expect(telegramSent.filter((t) => t.includes('ARBITRAJE'))).toHaveLength(0);

    store.stop();
  });

  it('an ad without the liquidity to cover the amount is not executable', async () => {
    vi.useFakeTimers();
    // A wide spread, but only 1 USDT published: it covers no tier here.
    const thin = (advNo: string, price: string) =>
      makeAdItem({
        advNo,
        price,
        min: '1000',
        max: '100000',
        surplus: '1',
        tradable: '1',
        tradeMethods: [{ payType: 'Banesco', tradeMethodName: 'Banesco' }],
      });
    stubWorld([thin('a', '900.00')], [thin('b', '999.00')]);

    const { store } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(store.getCachedBestOpportunity()).toBeNull();
    expect(telegramSent.filter((t) => t.includes('ARBITRAJE'))).toHaveLength(0);

    store.stop();
  });
});

describe('capture completeness is measured, not assumed', () => {
  it('counts an empty side instead of recording an invented price', async () => {
    vi.useFakeTimers();
    // Nothing on the BID side: there is no sale price to record.
    stubWorld([banesco('ask-1', '940.00')], []);

    const { store, StorageEngine } = await freshStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    const stats = store.getCaptureStats();
    expect(stats.incompleteSnapshots).toBeGreaterThan(0);
    expect(stats.bidSideEmpty).toBeGreaterThan(0);
    expect(stats.incompleteRatePct).toBeGreaterThan(0);
    expect(stats.lastIncompleteAt).not.toBeNull();

    // Nothing was written, and nothing was invented.
    expect(StorageEngine.getHistory()).toHaveLength(0);

    warn.mockRestore();
    store.stop();
  });

  it('reports no rate at all before anything has been observed', async () => {
    stubWorld([], []);
    const { store } = await freshStore();

    expect(store.getCaptureStats().incompleteRatePct).toBeNull();
  });
});
