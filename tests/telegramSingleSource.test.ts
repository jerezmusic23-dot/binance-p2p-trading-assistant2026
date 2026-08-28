/**
 * TELEGRAM HAS ONE SOURCE OF TRUTH, AND THESE ARE STATIC SOURCE ASSERTIONS.
 *
 * A behavioural test cannot catch the defect this file exists to prevent.
 * Somebody re-adds one line calling notifyOpportunityLifecycle from the poll
 * loop, or passes the taker engine's BEST_OPPORTUNITY into an alert body, and
 * every unit test still passes while the operator's phone starts announcing
 * arbitrage again - with the BUY/SELL mapping inverted for a maker.
 *
 * So these tests read the sources and assert WHICH module may speak.
 *
 * The taker engine is deliberately still here: opportunityEngine, executability
 * and the executable matrix still answer "could I take an ad", and the
 * /market/matrix screen still renders it. What they no longer have is a route
 * to Telegram.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SERVER = path.join(process.cwd(), 'server');

const read = (file: string) => readFileSync(path.join(SERVER, file), 'utf8');

/** Source with block and line comments removed - only code is asserted on. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('there is exactly one way to reach api.telegram.org', () => {
  it('only telegramNotifier posts to Telegram', () => {
    for (const file of ['centralStore.ts', 'routes.ts', 'makerAlerts.ts', 'makerMatrix.ts',
                        'makerRecommendation.ts', 'makerStrategy.ts', 'opportunityEngine.ts',
                        'executability.ts', 'executableMatrix.ts', 'binanceP2PService.ts']) {
      expect(code(file)).not.toMatch(/api\.telegram\.org/);
    }
    expect(code('telegramNotifier.ts').match(/api\.telegram\.org/g)).toHaveLength(1);
  });

  it('every send goes through the single private send method', () => {
    const notifier = code('telegramNotifier.ts');
    // One fetch in the file, and it is the one inside send().
    expect(notifier.match(/await fetch\(/g)).toHaveLength(1);
  });
});

describe('the arbitrage emitters are gone, not merely unused', () => {
  it('the notifier no longer defines them', () => {
    const notifier = code('telegramNotifier.ts');
    expect(notifier).not.toMatch(/notifyOpportunityLifecycle/);
    expect(notifier).not.toMatch(/formatOpportunityLifecycleMessage/);
    expect(notifier).not.toMatch(/formatOpportunityMessage/);
    expect(notifier).not.toMatch(/opportunityIdentity/);
    expect(notifier).not.toMatch(/closeOpportunity|openOpportunities/);
  });

  it('no arbitrage vocabulary survives anywhere in the notifier', () => {
    const notifier = code('telegramNotifier.ts');
    for (const banned of [
      'OPORTUNIDAD DE ARBITRAJE',
      'OPORTUNIDAD ACTUALIZADA',
      'OPORTUNIDAD CERRADA',
      'BEST OPPORTUNITY',
      'ARBITRAJE',
      'EXECUTABLE',
      'Binance ASK',
      'Binance BID',
      'tradeType/API',
    ]) {
      expect(notifier).not.toContain(banned);
    }
  });

  it('nothing in the store calls an arbitrage emitter', () => {
    const store = code('centralStore.ts');
    expect(store).not.toMatch(/notifyOpportunityLifecycle/);
  });
});

describe('BEST_OPPORTUNITY cannot produce a Telegram message', () => {
  it('the store never hands an opportunity to the notifier', () => {
    const store = code('centralStore.ts');
    const calls = store.match(/notify[A-Za-z]+\([\s\S]{0,240}?\);/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).not.toMatch(/opportunity/i);
      expect(call).not.toMatch(/bestOpportunity/);
    }
  });

  it('the OPPORTUNITY_ABOVE rule is refused before it can fire', () => {
    const store = code('centralStore.ts');
    expect(store).toMatch(/if \(rule\.condition === 'OPPORTUNITY_ABOVE'\) continue;/);
    // And no switch case remains that could set `triggered` for it.
    expect(store).not.toMatch(/case 'OPPORTUNITY_ABOVE':/);
  });

  it('the alert formatter cannot receive an opportunity at all', () => {
    const notifier = code('telegramNotifier.ts');
    const signature = notifier.slice(
      notifier.indexOf('export function formatAlertMessage('),
      notifier.indexOf('): string {', notifier.indexOf('export function formatAlertMessage('))
    );
    expect(signature).not.toMatch(/Opportunity/);
  });
});

describe('NO_OPPORTUNITY cannot produce a Telegram message either', () => {
  it('no cell status word reaches the notifier', () => {
    const notifier = code('telegramNotifier.ts');
    for (const status of ['NO_OPPORTUNITY', 'NO_LIQUIDITY', 'NOT_EXECUTABLE']) {
      expect(notifier).not.toContain(status);
    }
  });

  it('the maker emitter decides on maker types only', () => {
    const notifier = read('telegramNotifier.ts');
    // The only market-shaped imports are the maker ones.
    expect(notifier).toMatch(/import type \{ MakerAlert \} from '\.\/makerAlerts\.js';/);
    expect(notifier).toMatch(/from '\.\/makerMatrix\.js'/);
    expect(notifier).toMatch(/from '\.\/makerRecommendation\.js'/);
    expect(notifier).not.toMatch(/from '\.\/opportunityEngine\.js'/);
    expect(notifier).not.toMatch(/from '\.\/executability\.js'/);
    expect(notifier).not.toMatch(/from '\.\/arbitrageSides\.js'/);
  });
});

describe('two emitters can never speak at once', () => {
  it('the store has exactly one market-driven notifier call', () => {
    const store = code('centralStore.ts');
    const marketCalls = store.match(/notifyMakerAlerts|notifyOpportunityLifecycle/g) ?? [];
    expect(marketCalls).toEqual(['notifyMakerAlerts']);
  });

  it('the remaining emitters are the maker layer, user rules and system health', () => {
    const notifier = code('telegramNotifier.ts');
    const publicEmitters = (notifier.match(/public async notify[A-Za-z]+/g) ?? []).sort();
    /*
     * notifyMarketSignals joined in FASE 2. It is not a second market voice:
     * it is fed by signalEngine, which reads only the per-cell series the
     * maker layer wrote, and it deduplicates through the same lastSentAt map.
     * The rule was never "one method" - it was "one model", and both market
     * emitters speak the maker one.
     */
    expect(publicEmitters).toEqual([
      'public async notifyAlert',
      'public async notifyMakerAlerts',
      'public async notifyMarketSignals',
      'public async notifySystemAlert',
    ]);
  });

  it('the projection emitter is fed by the maker layer and nothing else', () => {
    const notifier = read('telegramNotifier.ts');
    expect(notifier).toMatch(/import type \{ MarketSignal \} from '\.\/signalEngine\.js';/);

    // signalEngine reads the per-cell series, never a listing or an opportunity.
    const signals = code('signalEngine.ts');
    expect(signals).not.toMatch(/tradeType\s*===|queryP2PAds|Opportunity|arbitrage/i);

    // And the projection message never speaks the taker model.
    const message = code('telegramNotifier.ts').slice(
      code('telegramNotifier.ts').indexOf('export function formatMarketSignalMessage'),
      code('telegramNotifier.ts').indexOf('export function formatSystemAlertMessage')
    );
    expect(message).not.toMatch(/ARBITRAJE|OPORTUNIDAD|EXECUTABLE|Binance ASK|Binance BID/i);
  });

  it('the maker emitter is driven from one place only', () => {
    const store = code('centralStore.ts');
    expect(store.match(/this\.announceMakerAlerts\(\)/g)).toHaveLength(1);
    expect(store).toMatch(/private announceMakerAlerts\(\): void \{/);
  });
});

describe('the maker layer is what decides, and it is pure', () => {
  it('makerAlerts imports no notifier, no clock and no network', () => {
    const alerts = code('makerAlerts.ts');
    expect(alerts).not.toMatch(/telegramNotifier|Date\.now\(\)|fetch\(/);
  });

  it('the summary interval is thirty minutes', () => {
    expect(code('makerAlerts.ts')).toMatch(
      /MAKER_SUMMARY_INTERVAL_MS = 30 \* 60 \* 1000/
    );
  });

  it('no new Binance request was added for Telegram', () => {
    const store = code('centralStore.ts');
    // Two calls, unchanged: one per side of the bank sweep. The maker layer
    // added none.
    expect(store.match(/BinanceP2PService\.queryP2PAds\(/g)).toHaveLength(2);
    // announceMakerAlerts reads the cache the sweep just filled.
    const method = store.slice(
      store.indexOf('private announceMakerAlerts'),
      store.indexOf('private tierListings')
    );
    expect(method).not.toMatch(/queryP2PAds|await/);
  });
});
