/**
 * THE WHOLE CHAIN, END TO END:
 *
 *   captura -> persistencia BANCO x MONTO -> histórico -> tendencia
 *           -> patrones -> proyección -> señal -> Telegram
 *
 * Driven by time and a stubbed Binance. Nothing here calls an HTTP route: the
 * point is that the analysis happens with nobody watching, from the book the
 * maker sweep already captured, with no additional request.
 *
 * The Binance responses are SYNTHETIC. They prove the wiring and the
 * semantics, and say nothing about the real USDT/VES market.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeAdItem, makeBinanceResponse } from './helpers/fixtures.js';

const originalCwd = process.cwd();
let tmpDir: string;
let telegramSent: string[] = [];

/** A rising book: each sweep returns prices one cent higher than the last. */
function stubWorld(priceFor: (call: number) => { buyListing: string; sellListing: string }) {
  let sweep = 0;
  const mock = vi.fn(async (url: unknown, init: RequestInit) => {
    const href = String(url);
    if (href.includes('api.telegram.org')) {
      telegramSent.push(JSON.parse(String(init.body)).text as string);
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }

    const body = JSON.parse(String(init.body));
    const prices = priceFor(Math.floor(sweep / 14));
    sweep += 1;

    const price = body.tradeType === 'BUY' ? prices.buyListing : prices.sellListing;
    const ads = [
      makeAdItem({
        advNo: `${body.tradeType}-1`,
        price,
        min: '1000',
        max: '200000',
        surplus: '5000',
        tradable: '5000',
        tradeMethods: [{ payType: 'Banesco', tradeMethodName: 'Banesco' }],
      }),
    ];
    return { ok: true, status: 200, json: async () => makeBinanceResponse(ads) } as unknown as Response;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function freshStore() {
  vi.resetModules();
  const { CentralMarketStore } = await import('../server/centralStore.js');
  const { TelegramNotifier } = await import('../server/telegramNotifier.js');
  const { HistoricalMarketStore } = await import('../server/historicalMarketStore.js');
  TelegramNotifier.resetInstance();
  HistoricalMarketStore.resetCache();
  return {
    store: CentralMarketStore.getInstance(),
    HistoricalMarketStore,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-proj-'));
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

describe('captura -> persistencia por BANCO x MONTO', () => {
  it('writes one series per cell from the sweep already in memory', async () => {
    vi.useFakeTimers();
    /*
     * MY BUY rivals arrive under tradeType=SELL and MY SELL rivals under BUY.
     * The cents establish the 0.01 step by observation.
     */
    stubWorld(() => ({ buyListing: '945.25', sellListing: '940.75' }));

    const { store, HistoricalMarketStore } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    const series = HistoricalMarketStore.load('BANESCO', '10K');
    expect(series.length).toBeGreaterThan(0);

    const first = series[0];
    // MI COMPRA: one tick above the best buyer, who lives in the SELL listing.
    expect(first.buyLeaderPrice).toBe(940.75);
    expect(first.buyRecommendedPrice).toBe(940.76);
    // MI VENTA: one tick below the best seller, in the BUY listing.
    expect(first.sellLeaderPrice).toBe(945.25);
    expect(first.sellRecommendedPrice).toBe(945.24);

    store.stop();
  });

  it('keeps every cell apart, and records which listing each price came from', async () => {
    vi.useFakeTimers();
    stubWorld(() => ({ buyListing: '945.25', sellListing: '940.75' }));

    const { store, HistoricalMarketStore } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    const cells = HistoricalMarketStore.listCells();
    expect(cells.length).toBeGreaterThan(1);

    const observation = HistoricalMarketStore.load('BANESCO', '10K')[0];
    expect(observation.provenance?.buy?.tradeType).toBe('SELL');
    expect(observation.provenance?.sell?.tradeType).toBe('BUY');
    expect(observation.provenance?.buy?.advNo).toBe('SELL-1');
    expect(observation.provenance?.sell?.advNo).toBe('BUY-1');

    store.stop();
  });

  it('adds no Binance request of its own', async () => {
    vi.useFakeTimers();
    const mock = stubWorld(() => ({ buyListing: '945.25', sellListing: '940.75' }));

    /*
     * Counts MATRIX requests only. The 6-second global snapshot poll also
     * queries Binance and predates all of this; including it would measure the
     * capture loop rather than what FASE 2 added. Matrix queries are the ones
     * carrying transAmount - they ask about one specific amount tier.
     */
    const matrixCalls = () =>
      mock.mock.calls.filter((call) => {
        if (String(call[0]).includes('telegram')) return false;
        const body = JSON.parse(String((call[1] as RequestInit).body));
        return body.transAmount !== undefined && body.transAmount !== null;
      }).length;

    const { store } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(3_000);
    const afterBoot = matrixCalls();

    await vi.advanceTimersByTimeAsync(45_000);

    // 7 banks x 2 sides for the one rotated tier. Persistence and analysis
    // read the book that sweep produced and ask Binance for nothing.
    expect(matrixCalls() - afterBoot).toBe(14);

    store.stop();
  });
});

describe('histórico -> tendencia -> proyección -> señal', () => {
  it('builds a trend from the stored series and exposes it', async () => {
    vi.useFakeTimers();
    // Each sweep moves the book up by a cent: a genuine rising series.
    stubWorld((sweep) => ({
      buyListing: (945.25 + sweep * 0.01).toFixed(2),
      sellListing: (940.75 + sweep * 0.01).toFixed(2),
    }));

    const { store, HistoricalMarketStore } = await freshStore();
    store.start();
    // Boot sweep, then many rotations so one cell accumulates observations.
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(45_000 * 40);

    const series = HistoricalMarketStore.load('BANESCO', '10K');
    expect(series.length).toBeGreaterThanOrEqual(6);

    const { projections } = store.getProjections();
    const cell = projections.find((p) => p.bank === 'BANESCO' && p.amountKey === '10K');

    expect(cell).toBeDefined();
    expect(cell!.observations).toBe(series.length);
    expect(cell!.buy.trend.trend).toBe('BULLISH');
    expect(cell!.buy.trend.velocity).toBeGreaterThan(0);
    expect(cell!.buy.label).toBe('MI COMPRA DE USDT');
    expect(cell!.buy.listingTradeType).toBe('SELL');

    store.stop();
  });

  it('borrows the general market when the cell has almost no history, and says so', async () => {
    vi.useFakeTimers();
    stubWorld(() => ({ buyListing: '945.25', sellListing: '940.75' }));

    const { store } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    const { projections } = store.getProjections();
    const cell = projections.find((p) => p.bank === 'BANESCO' && p.amountKey === '10K');

    /*
     * One observation of its own is not a series. Rather than staying silent
     * the cell reads the general market - which is better informed and worse
     * matched - and labels the fact, so nobody mistakes a market-wide reading
     * for this bank at this amount.
     */
    expect(cell!.observations).toBe(1);
    expect(cell!.borrowedFrom).toBe('MERCADO GENERAL');
    expect(cell!.buy.borrowedFrom).toBe('MERCADO GENERAL');
    // And it still refuses to invent a band it has no moves to derive.
    expect(cell!.buy.projectedRange.low).toBeNull();

    store.stop();
  });

  it('reads a cell on its own terms once it has enough history', async () => {
    vi.useFakeTimers();
    stubWorld((sweep) => ({
      buyListing: (945.25 + sweep * 0.01).toFixed(2),
      sellListing: (940.75 + sweep * 0.01).toFixed(2),
    }));

    const { store } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(45_000 * 130);

    const { projections } = store.getProjections();
    const cell = projections.find((p) => p.bank === 'BANESCO' && p.amountKey === '10K');

    expect(cell!.observations).toBeGreaterThanOrEqual(20);
    expect(cell!.borrowedFrom).toBeNull();

    store.stop();
  });
});

describe('señal -> Telegram, sin vocabulario taker', () => {
  it('never sends the arbitrage model, whatever the series does', async () => {
    vi.useFakeTimers();
    stubWorld((sweep) => ({
      buyListing: (945.25 + sweep * 0.05).toFixed(2),
      sellListing: (940.75 + sweep * 0.05).toFixed(2),
    }));

    const { store } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(45_000 * 40);

    expect(telegramSent.length).toBeGreaterThan(0);
    for (const body of telegramSent) {
      expect(body).not.toMatch(
        /ARBITRAJE|OPORTUNIDAD DE|EXECUTABLE|Binance ASK|Binance BID|tradeType\/API/
      );
    }

    store.stop();
  });

  it('labels a projection as PROYECTADO and never as a Binance price', async () => {
    vi.useFakeTimers();
    stubWorld((sweep) => ({
      buyListing: (945.25 + sweep * 0.05).toFixed(2),
      sellListing: (940.75 + sweep * 0.05).toFixed(2),
    }));

    const { store } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(45_000 * 60);

    const projectionMessages = telegramSent.filter((t) => t.includes('Evidencia'));
    if (projectionMessages.length > 0) {
      const body = projectionMessages[0];
      expect(body).toContain('ACTUAL (precio para publicar)');
      expect(body).toContain('PROYECTADO');
      expect(body).toContain('Muestras:');
      expect(body).toContain('No es una orden automática');
    }

    store.stop();
  });
});

describe('13 - reinicio: la serie sobrevive al proceso', () => {
  it('reloads the stored series and keeps appending after a restart', async () => {
    vi.useFakeTimers();
    stubWorld(() => ({ buyListing: '945.25', sellListing: '940.75' }));

    const first = await freshStore();
    first.store.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const before = first.HistoricalMarketStore.load('BANESCO', '10K').length;
    first.store.stop();

    expect(before).toBeGreaterThan(0);

    // A whole new process: modules reset, caches gone, same DATA_DIR.
    stubWorld((sweep) => ({
      buyListing: (945.25 + (sweep + 1) * 0.01).toFixed(2),
      sellListing: (940.75 + (sweep + 1) * 0.01).toFixed(2),
    }));
    const second = await freshStore();
    second.store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    const after = second.HistoricalMarketStore.load('BANESCO', '10K').length;
    expect(after).toBeGreaterThan(before);

    second.store.stop();
  });
});
