/**
 * THE GLOBAL AUDIT: nothing in this project may read tradeType=BUY as "mi
 * compra".
 *
 * This is the single most invertible fact in the codebase, and inverting it
 * does not crash anything - it quietly tells the operator to publish the worst
 * price on the board. So it is asserted structurally, over the sources, in one
 * place, and every new module has to pass through here.
 *
 *   tradeType=BUY   -> anuncios que VENDEN USDT  -> competencia para MI VENTA
 *   tradeType=SELL  -> anuncios que COMPRAN USDT -> competencia para MI COMPRA
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { listingForMakerSide, makerSideDefinition } from '../server/makerStrategy.js';
import { projectCell } from '../server/makerProjectionEngine.js';

const SERVER = path.join(process.cwd(), 'server');
const SRC = path.join(process.cwd(), 'src');

const read = (dir: string, file: string) => readFileSync(path.join(dir, file), 'utf8');

function code(dir: string, file: string): string {
  return read(dir, file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Every FASE 2 module, so a new one cannot be added without being audited. */
const PROJECTION_MODULES = [
  'historicalMarketStore.ts',
  'trendEngine.ts',
  'patternEngine.ts',
  'makerProjectionEngine.ts',
  'signalEngine.ts',
  'projectionBacktest.ts',
];

describe('the mapping itself', () => {
  it('sends MI COMPRA to the SELL listing and MI VENTA to the BUY listing', () => {
    expect(listingForMakerSide('MAKER_BUY')).toBe('SELL');
    expect(listingForMakerSide('MAKER_SELL')).toBe('BUY');
  });

  it('keeps the leader at the correct extreme on each side', () => {
    expect(makerSideDefinition('MAKER_BUY').leaderIs).toBe('HIGHEST');
    expect(makerSideDefinition('MAKER_BUY').beatDirection).toBe('UP');
    expect(makerSideDefinition('MAKER_SELL').leaderIs).toBe('LOWEST');
    expect(makerSideDefinition('MAKER_SELL').beatDirection).toBe('DOWN');
  });
});

describe('the projection layer carries the mapping without re-deriving it', () => {
  it('labels each side and names its listing', () => {
    const projection = projectCell({
      bank: 'VENEZUELA',
      bankDisplayName: 'Banco de Venezuela',
      amountKey: '10K',
      amountVes: 10_000,
      series: [],
      currentBuyPrice: null,
      currentSellPrice: null,
    });

    expect(projection.buy.label).toBe('MI COMPRA DE USDT');
    expect(projection.buy.listingTradeType).toBe('SELL');
    expect(projection.sell.label).toBe('MI VENTA DE USDT');
    expect(projection.sell.listingTradeType).toBe('BUY');
  });

  it('no projection module reads a listing itself', () => {
    /*
     * They consume the series the maker engine already wrote, whose
     * buyRecommendedPrice IS by construction the price for MY buy ad. A module
     * that queried or filtered a listing could re-derive - and re-invert - the
     * mapping, so none of them may.
     */
    for (const file of PROJECTION_MODULES) {
      const src = code(SERVER, file);
      expect(src).not.toMatch(/queryP2PAds|adv\/search|payTypes/);
      expect(src).not.toMatch(/tradeType\s*===\s*'(BUY|SELL)'/);
    }
  });
});

describe('nothing anywhere equates tradeType=BUY with my purchase', () => {
  const serverFiles = readdirSync(SERVER).filter((f) => f.endsWith('.ts'));
  const clientFiles = readdirSync(SRC).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));

  it('no source pairs a BUY listing with a compra label, or SELL with venta', () => {
    /*
     * Looks for the two inversions in their most likely written forms. The
     * correct pairings - "tradeType=SELL ... compra" and "tradeType=BUY ...
     * venta" - are what the codebase should contain instead.
     */
    const inversions = [
      /tradeType[=:]\s*'?BUY'?[^\n]{0,60}(mi compra|MI COMPRA|compro)/i,
      /tradeType[=:]\s*'?SELL'?[^\n]{0,60}(mi venta|MI VENTA|vendo)/i,
      /(mi compra|MI COMPRA)[^\n]{0,60}tradeType[=:]\s*'?BUY/i,
      /(mi venta|MI VENTA)[^\n]{0,60}tradeType[=:]\s*'?SELL/i,
    ];

    const offenders: string[] = [];
    for (const file of serverFiles) {
      const src = read(SERVER, file);
      for (const pattern of inversions) {
        if (pattern.test(src)) offenders.push(`server/${file}`);
      }
    }
    for (const file of clientFiles) {
      const src = read(SRC, file);
      for (const pattern of inversions) {
        if (pattern.test(src)) offenders.push(`src/${file}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the correct pairing is present where the mapping is defined', () => {
    const strategy = read(SERVER, 'makerStrategy.ts');
    expect(strategy).toMatch(/listingTradeType: 'SELL'/);
    expect(strategy).toMatch(/listingTradeType: 'BUY'/);
    // And the table that states it, so the reasoning survives the code.
    expect(strategy).toMatch(/tradeType=SELL/);
    expect(strategy).toMatch(/tradeType=BUY/);
  });
});

describe('the taker vocabulary cannot return to Telegram through the new modules', () => {
  it('no projection module mentions arbitrage at all', () => {
    for (const file of PROJECTION_MODULES) {
      const src = read(SERVER, file);
      expect(src).not.toMatch(/OPORTUNIDAD DE ARBITRAJE/);
      expect(src).not.toMatch(/COMPRA arbitraje|VENTA arbitraje/);
      expect(src).not.toMatch(/Fuente: Binance (ASK|BID)/);
      expect(src).not.toMatch(/lado Binance (BUY|SELL)/);
    }
  });

  it('the projection message speaks the maker vocabulary only', () => {
    /*
     * formatMarketSignalMessage is live again: notifyMarketSignals calls it
     * for every non-INFO signal that clears the dedup/cooldown floors (see
     * tests/alertScheduler.test.ts, "signal throttling, as measured"), so the
     * fuller PROYECTADO/MIRAR fields it was restored with are the ones that
     * actually reach Telegram, not a shape kept only for future use.
     */
    const notifier = read(SERVER, 'telegramNotifier.ts');
    const message = notifier.slice(
      notifier.indexOf('export function formatMarketSignalMessage'),
      notifier.indexOf('export function formatSystemAlertMessage')
    );

    expect(message.length).toBeGreaterThan(200);
    expect(message).not.toMatch(/ARBITRAJE|EXECUTABLE|Binance ASK|Binance BID/);
    expect(message).toMatch(/ACTUAL/);
    expect(message).toMatch(/PROYECTADO/);
    expect(message).toMatch(/no es un precio de Binance/);
    expect(message).toMatch(/No es una orden automática/);
  });

  it('the analysis screen separates ACTUAL from PROYECTADO in words', () => {
    const panel = read(SRC, 'MarketAnalysisPanel.tsx');
    expect(panel).toMatch(/Actual · precio para publicar/);
    expect(panel).toMatch(/Proyectado · rango observado/);
    expect(panel).not.toMatch(/ARBITRAJE|OPORTUNIDAD/i);
  });
});

describe('no invented number reaches a screen or a message', () => {
  it('no projection module hardcodes a probability or a price step', () => {
    for (const file of PROJECTION_MODULES) {
      const src = code(SERVER, file);
      // The banned shapes: a percentage constant, or an assumed tick.
      expect(src).not.toMatch(/0\.88|0\.82|88%|82%/);
      expect(src).not.toMatch(/=\s*0\.01\b/);
    }
  });

  it('every probability is a division by its own sample count', () => {
    const patterns = code(SERVER, 'patternEngine.ts');
    expect(patterns).toMatch(/occurrences \/ sampleSize/);
    expect(patterns).toMatch(/MIN_SAMPLES_FOR_PROBABILITY/);
  });

  it('the projection band comes from observed quantiles, not from a formula', () => {
    const projection = code(SERVER, 'makerProjectionEngine.ts');
    expect(projection).toMatch(/empiricalRange/);
    // No volatility multiplier, no confidence coefficient.
    expect(projection).not.toMatch(/\* 1\.96|\* 2\.5|stdDev|sigma/i);
  });
});
