/**
 * PHASE 5-C1 - data provenance
 *
 * Every figure the system publishes must be classifiable as REAL, AGGREGATED,
 * PROJECTED or HEURISTIC, and a fabricated value must never be labelled REAL.
 *
 * C1 only labels. The fabricated VALUES are still present and are replaced by
 * null in C2 - several tests below assert that a wrong number is at least
 * honestly tagged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BinanceP2PService } from '../server/binanceP2PService.js';
import {
  makeAdItem,
  makeBinanceResponse,
  makeNormalizedAd,
  makeSnapshot,
} from './helpers/fixtures.js';

const FIXED_NOW = Date.parse('2026-08-23T16:00:00Z'); // 12:00 VET

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('capture provenance', () => {
  const buyAds = [makeAdItem({ advNo: 'b1', price: '918.00' })];
  const sellAds = [makeAdItem({ advNo: 's1', price: '921.00' })];

  function stub(buy: typeof buyAds, sell: typeof sellAds) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => makeBinanceResponse(body.tradeType === 'BUY' ? buy : sell),
        } as unknown as Response;
      })
    );
  }

  it('labels both sides REAL when both actually had ads', async () => {
    stub(buyAds, sellAds);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.bestBuy).toEqual({ value: 918, provenance: 'REAL' });
    expect(snap.bestSell).toEqual({ value: 921, provenance: 'REAL' });
    expect(snap.bestBuy.value).toBe(snap.bestBuyPrice);
    expect(snap.bestSell.value).toBe(snap.bestSellPrice);
  });

  it('reports an absent side as a REAL null with an explanation', async () => {
    stub([], sellAds); // no BUY ads at all

    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    // C2: the absence itself is the observation. Nothing is derived.
    expect(snap.bestBuy.value).toBeNull();
    expect(snap.bestBuy.provenance).toBe('REAL');
    expect(snap.bestBuy.reason).toMatch(/no devolvio anuncios/i);
    // The side that really existed is untouched.
    expect(snap.bestSell.provenance).toBe('REAL');
    expect(snap.bestSell.value).toBe(921);
  });

  it('classifies aggregates and the order book separately from the prices', async () => {
    stub(buyAds, sellAds);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snap.aggregatesProvenance).toBe('AGGREGATED');
    expect(snap.orderBookProvenance).toBe('REAL');
  });

  it('never publishes a price that no advertiser posted', async () => {
    stub([], sellAds);
    const snap = await BinanceP2PService.fetchFullMarketSnapshot();
    // The only prices in the snapshot come from the SELL side that existed.
    expect(snap.bestBuyPrice).toBeNull();
    expect(snap.bestBuy.value).toBeNull();
  });
});

/*
 * THE ANALYSIS, ORDER-BOOK-PRESSURE, PROJECTION AND HOURLY-TIMELINE PROVENANCE
 * BLOCKS USED TO LIVE HERE, and they went with the engine they described.
 *
 * They were an honest record of a dishonest thing: they asserted that a
 * 1.6-sigma support band was labelled HEURISTIC, that a per-hour session curve
 * marked future points PROJECTED, and that a point-scored distribution never
 * claimed to be AGGREGATED. Labelling a fabricated number correctly was the
 * best that could be done while it was still on the screen.
 *
 * ProjectionEngine is gone from the production chain and from the repository.
 * What replaces those assertions is the structural guarantee below: no module
 * can bring the heuristic forecast back without this failing.
 */
describe('the heuristic forecast engine is gone, not hidden', () => {
  const serverDir = path.join(process.cwd(), 'server');
  const srcDir = path.join(process.cwd(), 'src');

  const sources = (dir: string, ext: string[]): { file: string; body: string }[] =>
    fs
      .readdirSync(dir)
      .filter((f) => ext.some((e) => f.endsWith(e)))
      .map((f) => ({ file: f, body: fs.readFileSync(path.join(dir, f), 'utf8') }));

  /** Source with comments stripped: prose about the removal is not code. */
  const code = (body: string): string =>
    body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('neither engine file exists any more', () => {
    expect(fs.existsSync(path.join(serverDir, 'projectionEngine.ts'))).toBe(false);
    expect(fs.existsSync(path.join(serverDir, 'backtestEngine.ts'))).toBe(false);
  });

  it('nothing on the server imports it', () => {
    for (const { file, body } of sources(serverDir, ['.ts'])) {
      expect(code(body), file).not.toMatch(/from '\.\/projectionEngine\.js'/);
      expect(code(body), file).not.toMatch(/from '\.\/backtestEngine\.js'/);
      expect(code(body), file).not.toMatch(/\bProjectionEngine\./);
      expect(code(body), file).not.toMatch(/\bBacktestEngine\./);
    }
  });

  it('the heuristic multipliers exist nowhere in the server', () => {
    /*
     * The exact constants the audit named. Each was a forecast input nobody
     * measured: a 1.6-sigma band, a +6H factor, a floor-proximity threshold and
     * an afternoon seasonal bump.
     */
    for (const { file, body } of sources(serverDir, ['.ts'])) {
      const body_ = code(body);
      expect(body_, file).not.toMatch(/stdDev \* 1\.6/);
      expect(body_, file).not.toMatch(/\* 1\.15\b/);
      expect(body_, file).not.toMatch(/\* 1\.004\b/);
      expect(body_, file).not.toMatch(/seasonalFactor/);
      expect(body_, file).not.toMatch(/sessionCurveMultipliers/);
    }
  });

  it('no endpoint serves the old engine any more', () => {
    const routes = code(fs.readFileSync(path.join(serverDir, 'routes.ts'), 'utf8'));
    expect(routes).not.toMatch(/'\/market\/analysis'/);
    expect(routes).not.toMatch(/'\/market\/projections'/);
    expect(routes).not.toMatch(/'\/market\/backtest'/);
    // And the replacement is there.
    expect(routes).toMatch(/'\/market\/projections\/general'/);
  });

  it('the interface no longer renders a probability distribution', () => {
    for (const { file, body } of sources(srcDir, ['.tsx'])) {
      const body_ = code(body);
      expect(body_, file).not.toMatch(/DISTRIBUCIÓN DE PROBABILIDAD/);
      expect(body_, file).not.toMatch(/REGRESIÓN & PROFUNDIDAD/);
      expect(body_, file).not.toMatch(/probabilities/);
      expect(body_, file).not.toMatch(/intradayHorizons/);
      expect(body_, file).not.toMatch(/merchantAdvice/);
    }
  });
});
