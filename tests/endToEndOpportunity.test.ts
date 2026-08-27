/**
 * THE WHOLE ROBOT, END TO END.
 *
 *   Binance -> capture -> history -> executable matrix -> opportunity engine
 *           -> lastOpportunities -> Telegram
 *
 * Driven by time alone. Nothing here calls /api/market/opportunities or
 * /api/market/matrix, because the point is that the bot works with nobody
 * watching - which is exactly what it could not do before the matrix interval
 * existed.
 *
 * The Binance responses are SYNTHETIC and say nothing about the real market.
 * What they prove is that a book which DOES contain an executable operation
 * travels the whole chain and comes out as a correctly worded Telegram
 * message, and that a book which does not stays silent.
 *
 * ECONOMICS UNDER TEST
 *
 *   ASK 940 = an ad SELLING USDT   = I buy   = arbitrageBuyPrice
 *   BID 950 = an ad BUYING USDT    = I sell  = arbitrageSellPrice
 *   opportunity <=> sell > buy
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

describe('a book WITH an executable operation reaches Telegram on its own', () => {
  it('ASK 940 / BID 950 becomes an arbitrage message, no HTTP request involved', async () => {
    vi.useFakeTimers();
    stubWorld([banesco('ask-1', '940.00')], [banesco('bid-1', '950.00')]);

    const { store } = await freshStore();
    store.start();

    // Boot snapshot, then the 2s matrix population. Time only.
    await vi.advanceTimersByTimeAsync(3_000);
    // One poll after the matrix exists, so evaluateAlerts sees the result.
    await vi.advanceTimersByTimeAsync(7_000);

    const opportunity = store.getCachedBestOpportunity();
    expect(opportunity).not.toBeNull();

    // The economics, as MY operation.
    expect(opportunity?.buyPrice).toBe(940);
    expect(opportunity?.sellPrice).toBe(950);
    expect(opportunity?.spreadAbsolute).toBe(10);
    expect(opportunity?.marginPct).toBeGreaterThan(0);
    expect(opportunity?.marginPct).toBeCloseTo(1.0638, 3);
    expect(opportunity?.verification).toBe('VERIFIED');
    expect(opportunity?.bank).toBe('BANESCO');

    // And it left the building.
    const arbitrage = telegramSent.filter((t) => t.includes('OPORTUNIDAD DE ARBITRAJE'));
    expect(arbitrage.length).toBeGreaterThan(0);

    const body = arbitrage[0];
    expect(body).toContain('COMPRA USDT');
    expect(body).toContain('Fuente: Binance ASK');
    expect(body).toContain('940.00 VES');
    expect(body).toContain('VENTA USDT');
    expect(body).toContain('Fuente: Binance BID');
    expect(body).toContain('950.00 VES');
    expect(body).toContain('SPREAD: <b>+10.00 VES</b>');
    expect(body).toContain('Estado: VERIFIED / EXECUTABLE');
    expect(body).toContain('MARGEN BRUTO');

    store.stop();
  });

  it('a stable opportunity is announced once, not every 45 seconds', async () => {
    vi.useFakeTimers();
    stubWorld([banesco('ask-1', '940.00')], [banesco('bid-1', '950.00')]);

    const { store } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    const afterFirst = telegramSent.filter((t) => t.includes('ARBITRAJE')).length;
    expect(afterFirst).toBe(1);

    // Four more matrix windows, same book. The cooldown must hold.
    await vi.advanceTimersByTimeAsync(45_000 * 4);
    const afterFour = telegramSent.filter((t) => t.includes('ARBITRAJE')).length;
    expect(afterFour).toBe(1);

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
  it('ASK 950.00 / BID 950.50 -> +0.50 VES, +0.0526%, and those exact prices', async () => {
    vi.useFakeTimers();
    stubWorld([banesco('ask-1', '950.00')], [banesco('bid-1', '950.50')]);

    const { store } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    const opportunity = store.getCachedBestOpportunity();
    expect(opportunity?.buyPrice).toBe(950.0);
    expect(opportunity?.sellPrice).toBe(950.5);
    expect(opportunity?.spreadAbsolute).toBeCloseTo(0.5, 6);
    expect(opportunity?.marginPct).toBeCloseTo(0.0526, 4);

    const body = telegramSent.filter((t) => t.includes('ARBITRAJE'))[0];
    // The prices Telegram prints are the ads' own prices, not a derived figure.
    expect(body).toContain('950.00 VES');
    expect(body).toContain('950.50 VES');
    expect(body).toContain('SPREAD: <b>+0.50 VES</b>');
    expect(body).toContain('RENDIMIENTO: <b>+0.0526%</b>');

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
