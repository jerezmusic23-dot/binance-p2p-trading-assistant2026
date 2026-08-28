/**
 * CHARACTERIZATION TESTS - server/centralStore.ts
 *
 * The store is a module-level singleton that writes through StorageEngine to
 * process.cwd()/data, so every test runs in a fresh temp cwd with a fresh
 * module graph. start() is never called - the 6s interval stays off.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeAdItem, makeBinanceResponse } from './helpers/fixtures.js';
import { BANK_CODE_MAP } from '../server/binanceP2PService.js';
import type { AlertRule, AlertTriggerLog, HistoryRecord } from '../server/types.js';

const originalCwd = process.cwd();
let tmpDir: string;

/** Reply to BUY with `buy`, to SELL with `sell`. */
function stubBinance(buy: ReturnType<typeof makeAdItem>[], sell: ReturnType<typeof makeAdItem>[]) {
  const mock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => makeBinanceResponse(body.tradeType === 'BUY' ? buy : sell),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function freshStore() {
  vi.resetModules();
  const { CentralMarketStore } = await import('../server/centralStore.js');
  const { StorageEngine } = await import('../server/storage.js');
  return { store: CentralMarketStore.getInstance(), StorageEngine };
}

function readData<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', file), 'utf-8')) as T;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-store-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getInstance', () => {
  it('returns the same singleton and initialises storage eagerly', async () => {
    vi.resetModules();
    const { CentralMarketStore } = await import('../server/centralStore.js');
    expect(CentralMarketStore.getInstance()).toBe(CentralMarketStore.getInstance());
    expect(fs.existsSync(path.join(tmpDir, 'data', 'alerts.json'))).toBe(true);
  });
});

describe('getCurrentSnapshot before any poll', () => {
  it('reports OFFLINE with the sentinel age of 9999s', async () => {
    const { store } = await freshStore();
    expect(store.getCurrentSnapshot()).toEqual({
      snapshot: null,
      ageSeconds: 9999,
      effectiveStatus: 'OFFLINE',
    });
  });

  it('returns null analysis and null projections without a snapshot', async () => {
    const { store } = await freshStore();
    expect(store.getMarketAnalysis()).toBeNull();
    expect(store.getMarketProjections()).toBeNull();
  });
});

describe('pollMarket - success path', () => {
  it('stores a LIVE snapshot and appends exactly one history record', async () => {
    stubBinance(
      [makeAdItem({ advNo: 'b1', price: '918.00', nickName: 'CompradorLider' })],
      [makeAdItem({ advNo: 's1', price: '921.00', nickName: 'VendedorLider' })]
    );
    const { store } = await freshStore();

    const snapshot = await store.pollMarket();
    expect(snapshot?.status).toBe('LIVE');
    expect(snapshot?.bestBuyPrice).toBe(918);
    expect(snapshot?.bestSellPrice).toBe(921);

    const history = readData<HistoryRecord[]>('market_history.json');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      buyPrice: 918,
      sellPrice: 921,
      bestBuyMerchant: 'CompradorLider',
      bestSellMerchant: 'VendedorLider',
      activeBuyAds: 1,
      activeSellAds: 1,
      source: 'BINANCE_P2P',
    });
    expect(history[0].id).toBe(`tick-${history[0].timestamp}`);
  });

  it('BUG: the history record drops the entire order book', async () => {
    // Depth loss #3 (audit) - the single most damaging gap for projections.
    // The order book is STILL dropped: the record now also carries the
    // strategic level of the observation, but not a single ad, price, limit
    // or liquidity figure from the book itself. Still a BUG:.
    const buy = Array.from({ length: 10 }, (_, i) =>
      makeAdItem({ advNo: `b${i}`, price: String(918 + i), tradable: '500' })
    );
    stubBinance(buy, [makeAdItem({ advNo: 's1', price: '930.00' })]);
    const { store } = await freshStore();

    const snapshot = await store.pollMarket();
    expect(snapshot?.topBuyAds).toHaveLength(10);

    const [record] = readData<HistoryRecord[]>('market_history.json');
    expect(Object.keys(record).sort()).toEqual(
      [
        'activeBuyAds',
        'activeSellAds',
        'bestBuyMerchant',
        'bestSellMerchant',
        'buyPrice',
        'dateStr',
        'hour',
        'id',
        'sellPrice',
        'source',
        'spreadPct',
        'timestamp',
        // Added additively: the strategic level of the same observation.
        'calculationVersion',
        'strategicBuyPrice',
        'strategicSellPrice',
        'strategicSpreadPct',
      ].sort()
    );
    // No liquidity, no per-ad prices, no payment methods, no merchant ratings.
    expect(record).not.toHaveProperty('topBuyAds');
    expect(record).not.toHaveProperty('availableUsdt');
  });

  it('BUG: filterBank and filterAmount are declared but never written', async () => {
    // Audit B16 - the history has no bank or amount dimension at all.
    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();
    await store.pollMarket();

    const [record] = readData<HistoryRecord[]>('market_history.json');
    expect(record.filterBank).toBeUndefined();
    expect(record.filterAmount).toBeUndefined();
  });

  it('BUG: dateStr is UTC while hour is VET, so the two disagree', async () => {
    // Audit B17: grouping by dateStr and grouping by hour give different days.
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-23T02:00:00Z')); // 22:00 VET on Aug 22
    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();
    await store.pollMarket();

    const [record] = readData<HistoryRecord[]>('market_history.json');
    expect(record.dateStr).toBe('2026-08-23T02:00:00.000Z'); // 23rd in UTC
    expect(record.hour).toBe(22); // 22:00 of the 22nd in VET
  });

  it('guards against re-entrant polling', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mock = vi.fn(async (_url: string, init: RequestInit) => {
      await gate;
      const body = JSON.parse(String(init.body));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => makeBinanceResponse([makeAdItem({ price: body.tradeType === 'BUY' ? '918.00' : '921.00' })]),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', mock);
    const { store } = await freshStore();

    const first = store.pollMarket();
    const second = store.pollMarket(); // must short-circuit
    release?.();
    await Promise.all([first, second]);

    expect(mock).toHaveBeenCalledTimes(2); // one BUY + one SELL, not four
    expect(readData<HistoryRecord[]>('market_history.json')).toHaveLength(1);
  });
});

describe('pollMarket - failure path', () => {
  it('returns a zeroed OFFLINE snapshot when nothing valid was ever seen', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('Binance unreachable');
    });
    const { store } = await freshStore();

    const snapshot = await store.pollMarket();
    // Was: a snapshot full of zeros, indistinguishable from a 0.00 VES market.
    expect(snapshot).toMatchObject({
      status: 'OFFLINE',
      bestBuyPrice: null,
      bestSellPrice: null,
      spreadPercentage: null,
      topBuyAds: [],
      topSellAds: [],
      lastError: 'Binance unreachable',
    });
  });

  it('does NOT append a history record on failure', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('boom');
    });
    const { store } = await freshStore();
    await store.pollMarket();
    expect(readData<HistoryRecord[]>('market_history.json')).toEqual([]);
  });

  it('degrades to STALE keeping the last valid price and its original timestamp', async () => {
    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();
    const good = await store.pollMarket();

    vi.stubGlobal('fetch', async () => {
      throw new Error('network down');
    });
    const stale = await store.pollMarket();

    expect(stale?.status).toBe('STALE');
    expect(stale?.bestBuyPrice).toBe(918);
    expect(stale?.timestamp).toBe(good?.timestamp);
    expect(stale?.lastError).toBe('network down');
    expect(readData<HistoryRecord[]>('market_history.json')).toHaveLength(1);
  });

  it('rejects a non-positive price as a validation failure', async () => {
    // normalizeAds already drops price<=0, so both sides come back empty and
    // fetchFullMarketSnapshot throws before validation is reached.
    stubBinance([makeAdItem({ price: '0' })], [makeAdItem({ price: '0' })]);
    const { store } = await freshStore();
    const snapshot = await store.pollMarket();
    expect(snapshot?.status).toBe('OFFLINE');
    expect(snapshot?.lastError).toContain('No active P2P ads found');
  });
});

describe('snapshot ageing', () => {
  it('flips LIVE to STALE once the snapshot is older than 35 seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-23T16:00:00Z'));
    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();
    await store.pollMarket();

    expect(store.getCurrentSnapshot().effectiveStatus).toBe('LIVE');
    vi.setSystemTime(Date.parse('2026-08-23T16:00:36Z'));
    const aged = store.getCurrentSnapshot();
    expect(aged.ageSeconds).toBe(36);
    expect(aged.effectiveStatus).toBe('STALE');
  });
});

describe('evaluateAlerts', () => {
  async function pollWithSpread(spreadBuy: string, spreadSell: string) {
    stubBinance([makeAdItem({ price: spreadBuy })], [makeAdItem({ price: spreadSell })]);
    return freshStore();
  }

  it('fires SPREAD_ABOVE and records a trigger log', async () => {
    const { store, StorageEngine } = await pollWithSpread('918.00', '941.00'); // 2.51%
    StorageEngine.deleteAlert('rule-volatility-spike');
    await store.pollMarket();

    const triggers = readData<AlertTriggerLog[]>('alert_triggers.json');
    expect(triggers).toHaveLength(1);
    expect(triggers[0].ruleId).toBe('rule-spread-high');
    expect(triggers[0].message).toContain('2.51%');
  });

  it('applies the hardcoded 5-minute cooldown per rule', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-23T16:00:00Z'));
    const { store, StorageEngine } = await pollWithSpread('918.00', '941.00');
    StorageEngine.deleteAlert('rule-volatility-spike');

    await store.pollMarket();
    await store.pollMarket();
    expect(readData<AlertTriggerLog[]>('alert_triggers.json')).toHaveLength(1);

    vi.setSystemTime(Date.parse('2026-08-23T16:05:01Z'));
    await store.pollMarket();
    expect(readData<AlertTriggerLog[]>('alert_triggers.json')).toHaveLength(2);
  });

  it('does not fire when the spread stays under the threshold', async () => {
    const { store } = await pollWithSpread('918.00', '921.00'); // 0.33%
    await store.pollMarket();
    expect(fs.existsSync(path.join(tmpDir, 'data', 'alert_triggers.json'))).toBe(false);
  });

  it('VOLATILITY_SPIKE names the metric it actually measures: the spread', async () => {
    // Audit B14 (FIXED in FASE 2): the rule compares the strategic spread
    // against targetValue*1.5. It never measured volatility, and the message
    // no longer claims it did - a wide but perfectly stable spread is
    // reported as exactly that.
    const { store, StorageEngine } = await pollWithSpread('918.00', '941.00'); // 2.51% > 1.5*1.5
    StorageEngine.deleteAlert('rule-spread-high');
    await store.pollMarket();

    const triggers = readData<AlertTriggerLog[]>('alert_triggers.json');
    expect(triggers).toHaveLength(1);
    expect(triggers[0].ruleId).toBe('rule-volatility-spike');
    expect(triggers[0].message).toContain('Spread estratégico');
    expect(triggers[0].message).toContain('2.51%');
    expect(triggers[0].message).not.toContain('Alta volatilidad');
  });

  it('FASE 2: a single distant ad no longer fires a spread alert', async () => {
    /*
     * The production incident, end to end through the real decision path.
     *
     * 19 SELL ads sitting at ~921 VES plus ONE at 980. The raw spread
     * |max(SELL) - min(BUY)| reads 6.64%, well over the 2% threshold, and
     * that is what used to reach Telegram. The market never moved: the
     * strategic spread is 0.06%, so nothing should fire.
     */
    const level = Array.from({ length: 19 }, (_, i) =>
      makeAdItem({ advNo: `s${i}`, price: (921 + i * 0.05).toFixed(2) })
    );
    stubBinance(level, [...level, makeAdItem({ advNo: 'outlier', price: '980.00' })]);
    const { store } = await freshStore();

    const snapshot = await store.pollMarket();

    // The raw extreme is preserved for auditing...
    expect(snapshot?.bestSellPrice).toBe(980);
    expect(snapshot?.spreadPercentage).toBeGreaterThan(6);
    // ...but the strategic level is where the market actually is.
    expect(snapshot?.strategicSpreadPct).toBeLessThan(0.2);
    // ...and no alert was raised.
    expect(fs.existsSync(path.join(tmpDir, 'data', 'alert_triggers.json'))).toBe(false);
  });

  it('FASE 2: a loss keeps its sign instead of being flattened by Math.abs', async () => {
    /*
     * Venta BELOW recompra is a losing operation.
     *
     * This test used to assert the DEFECT: the raw spread took the absolute
     * value, so a loss read as a gain, and the line said so - "raw: sign
     * destroyed". Only the strategic figure carried the truth. Both do now,
     * which is what types.ts always specified: "Signed. Never absolute-valued:
     * a loss must stay a loss."
     */
    stubBinance([makeAdItem({ price: '941.00' })], [makeAdItem({ price: '918.00' })]);
    const { store } = await freshStore();
    const snapshot = await store.pollMarket();

    expect(snapshot?.spreadPercentage).toBeLessThan(0); // raw: sign preserved
    expect(snapshot?.strategicSpreadPct).toBeLessThan(0); // strategic: it is a loss
  });

  it('persists the signed spread into the history, not an absolute one', async () => {
    // Ask 941 above bid 918: a taker crossing this loses. The stored series
    // has to say so, because a chart drawn from it is read as the market.
    stubBinance([makeAdItem({ price: '941.00' })], [makeAdItem({ price: '918.00' })]);
    const { store } = await freshStore();
    await store.pollMarket();

    const history = readData<{ spreadPct: number }[]>('market_history.json');
    expect(history.length).toBeGreaterThan(0);
    expect(history[history.length - 1].spreadPct).toBeLessThan(0);
  });

  it('FASE 2: an ABOVE rule decides on the strategic price, not on the extreme', async () => {
    /*
     * min(BUY) is 900 - below a 910 threshold - while the market sits at 921.
     * A BELOW rule at 910 used to fire on that single cheap ad.
     */
    const buy = [
      makeAdItem({ advNo: 'cheap', price: '900.00' }),
      ...Array.from({ length: 18 }, (_, i) =>
        makeAdItem({ advNo: `b${i}`, price: (921 + i * 0.05).toFixed(2) })
      ),
    ];
    stubBinance(buy, [makeAdItem({ price: '921.50' })]);
    const { store, StorageEngine } = await freshStore();
    StorageEngine.deleteAlert('rule-spread-high');
    StorageEngine.deleteAlert('rule-volatility-spike');
    StorageEngine.saveAlert({
      id: 'below-910',
      name: 'Recompra barata',
      condition: 'BELOW',
      targetValue: 910,
      targetSide: 'BUY',
      enabled: true,
      createdAt: 1,
    });

    const snapshot = await store.pollMarket();

    expect(snapshot?.bestBuyPrice).toBe(900); // the extreme is under the threshold
    expect(snapshot?.strategicBuyPrice).toBeGreaterThan(910);
    expect(fs.existsSync(path.join(tmpDir, 'data', 'alert_triggers.json'))).toBe(false);
  });

  it('BUG: TREND_CHANGE is a declared condition with no implementation', async () => {
    // Audit B15: no `case` in the switch, so such a rule can never fire.
    const { store, StorageEngine } = await pollWithSpread('918.00', '941.00');
    StorageEngine.deleteAlert('rule-spread-high');
    StorageEngine.deleteAlert('rule-volatility-spike');
    const rule: AlertRule = {
      id: 'trend-rule',
      name: 'Cambio de tendencia',
      condition: 'TREND_CHANGE',
      targetValue: 0,
      targetSide: 'BUY',
      enabled: true,
      createdAt: 1,
    };
    StorageEngine.saveAlert(rule);

    await store.pollMarket();
    expect(fs.existsSync(path.join(tmpDir, 'data', 'alert_triggers.json'))).toBe(false);
  });

  it('skips disabled rules', async () => {
    const { store, StorageEngine } = await pollWithSpread('918.00', '941.00');
    for (const rule of StorageEngine.getAlerts()) {
      StorageEngine.saveAlert({ ...rule, enabled: false });
    }
    await store.pollMarket();
    expect(fs.existsSync(path.join(tmpDir, 'data', 'alert_triggers.json'))).toBe(false);
  });
});

describe('analysis / projections window', () => {
  it('BUG: reads only the newest 100 history records (10 minutes at 6s)', async () => {
    // Audit B7: daily floor/ceiling and +24H horizons are derived from a
    // 10-minute window.
    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store, StorageEngine } = await freshStore();
    const spy = vi.spyOn(StorageEngine, 'getHistory');

    await store.pollMarket();
    store.getMarketProjections();

    expect(spy).toHaveBeenCalledWith(100);
  });

  it('runs the backtest over the UNBOUNDED history', async () => {
    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store, StorageEngine } = await freshStore();
    const spy = vi.spyOn(StorageEngine, 'getHistory');

    const metrics = store.getBacktestMetrics();
    expect(spy).toHaveBeenCalledWith();
    expect(metrics.hasSufficientData).toBe(false); // empty store
  });
});

describe('the bank matrix refreshes on its own, without a viewer', () => {
  /*
   * THE BUG THIS PINS
   *
   * refreshBankMatrix used to run once at boot and then only when an HTTP
   * request found the cache cold. With nobody on the dashboard,
   * lastOpportunities stayed frozen at its boot value for the life of the
   * process: the lifecycle notifier re-evaluated the same stale answer every
   * 6s and an opportunity appearing an hour later was never seen. Price
   * alerts kept arriving because those read the 6s snapshot instead, which is
   * exactly why the failure looked like "Telegram only sends price alerts".
   *
   * These tests drive the timers directly and never touch getBankMatrix,
   * getExecutableMatrix or getOpportunities - the three calls that used to be
   * the only way a refresh ever happened.
   */
  it('populates the matrix from the timer alone', async () => {
    vi.useFakeTimers();
    const mock = stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();

    store.start();
    // Boot snapshot + the 2s boot matrix population.
    await vi.advanceTimersByTimeAsync(2_100);
    const afterBoot = mock.mock.calls.length;
    expect(afterBoot).toBeGreaterThan(0);

    // No HTTP call of any kind, only time passing.
    await vi.advanceTimersByTimeAsync(46_000);
    expect(mock.mock.calls.length).toBeGreaterThan(afterBoot);

    store.stop();
    vi.useRealTimers();
  });

  it('keeps refreshing on every interval, so a later opportunity is seen', async () => {
    vi.useFakeTimers();
    const mock = stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();

    store.start();
    await vi.advanceTimersByTimeAsync(2_100);

    const bankCount = Object.keys(BANK_CODE_MAP).length;
    const afterBoot = mock.mock.calls.length;

    // Three further matrix windows.
    await vi.advanceTimersByTimeAsync(45_000 * 3 + 1_000);
    const added = mock.mock.calls.length - afterBoot;

    // Each window is one query per bank per side; the 6s snapshot poll adds
    // its own, so this is a floor rather than an equality.
    expect(added).toBeGreaterThanOrEqual(bankCount * 2 * 3);

    store.stop();
    vi.useRealTimers();
  });

  it('never runs two refreshes at once, however slow Binance is', async () => {
    vi.useFakeTimers();

    // A query that never settles: the refresh started at boot stays in flight
    // across several interval ticks.
    let started = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        started += 1;
        return new Promise(() => {});
      })
    );

    const { store } = await freshStore();
    store.start();
    await vi.advanceTimersByTimeAsync(2_100);
    const afterFirstPass = started;

    // Four more ticks. The in-flight guard must swallow every one of them.
    await vi.advanceTimersByTimeAsync(45_000 * 4);
    expect(started).toBe(afterFirstPass);

    store.stop();
    vi.useRealTimers();
  });

  it('stop() clears the matrix timer so nothing fires afterwards', async () => {
    vi.useFakeTimers();
    const mock = stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();

    store.start();
    await vi.advanceTimersByTimeAsync(2_100);
    store.stop();

    const afterStop = mock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(45_000 * 3);
    expect(mock.mock.calls.length).toBe(afterStop);

    vi.useRealTimers();
  });
});

describe('FASE 5 - the matrix is the executable matrix', () => {
  /*
   * CONTRACT CHANGE, deliberate.
   *
   * These tests previously asserted `matrix.rows[i].ratesByAmount`, the cells
   * built from ads filtered only by min/max - no bank verification, no
   * liquidity - whose spreadPct was the 0.01 VES undercut of the leader. That
   * structure is gone: it was a second, weaker answer over the same ads, and
   * it was the one the interface rendered.
   *
   * They now assert the same underlying properties (flat request budget, six
   * tiers, bank verification) against ExecutableMatrix. One test changes
   * meaning rather than shape and is renamed to say so.
   */
  it('keeps the request budget flat: 1 query per bank per side, 6 amount tiers in memory', async () => {
    const mock = stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();

    const { executableMatrix } = await store.getExecutableMatrix(true);

    const bankCount = Object.keys(BANK_CODE_MAP).length;
    /*
     * CONTRACT CHANGE: a cold cache does a FULL SWEEP.
     *
     * The tiers used to be filtered in memory from one book per bank per side,
     * which is why this asserted 14. That book was Binance's top 20 ORDERED BY
     * PRICE, so a cheap ad accepting only 50K sat below twenty ads that did
     * not and never reached the 50K cell - a false negative on a real
     * operation. Each tier is now its own question, with transAmount.
     *
     * 7 banks x 2 sides x 6 tiers = 84, paid once when the cache is cold.
     * Steady state rotates one tier per tick and stays at 14.
     */
    expect(mock).toHaveBeenCalledTimes(bankCount * 2 * 6);
    expect(executableMatrix.amountKeys).toEqual(['10K', '20K', '30K', '40K', '50K', '100K']);
    expect(Object.keys(executableMatrix.cells.BANESCO)).toEqual([
      '10K',
      '20K',
      '30K',
      '40K',
      '50K',
      '100K',
    ]);
  });

  it('ENFORCES bank verification instead of merely reporting it', async () => {
    /*
     * WAS: "reports verification without yet filtering the published rates",
     * which asserted provincial.ratesByAmount['10K'].leaderPrice === 921 -
     * a rate published for Provincial from an ad carrying Banesco's payType.
     *
     * That is exactly the defect FASE 5 removes. The fixture ad carries
     * payType 'Banesco' for every bank query, so Provincial must now produce
     * NO price at all rather than borrow one.
     */
    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();

    const { executableMatrix } = await store.getExecutableMatrix(true);
    const provincial = executableMatrix.cells.PROVINCIAL['10K'];

    expect(provincial.buy).toBeNull();
    expect(provincial.sell).toBeNull();
    expect(provincial.spreadPct).toBeNull();
    expect(provincial.status).not.toBe('EXECUTABLE');
  });

  it('never lets one bank inherit another bank\'s ad', async () => {
    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();

    const { executableMatrix } = await store.getExecutableMatrix(true);

    for (const bank of executableMatrix.bankOrder) {
      if (bank === 'BANESCO') continue;
      for (const amt of executableMatrix.amountKeys) {
        const cell = executableMatrix.cells[bank][amt];
        expect(cell.buy?.price ?? null).toBeNull();
        expect(cell.sell?.price ?? null).toBeNull();
      }
    }
  });

  it('marks a cell NOT_VERIFIABLE when the bank cannot be established', async () => {
    stubBinance(
      [makeAdItem({ price: '918.00', tradeMethods: [{ payType: '', tradeMethodName: 'Banesco' }] })],
      [makeAdItem({ price: '921.00', tradeMethods: [{ payType: '', tradeMethodName: 'Banesco' }] })]
    );
    const { store } = await freshStore();

    const { executableMatrix } = await store.getExecutableMatrix(true);
    const banesco = executableMatrix.cells.BANESCO['10K'];

    expect(banesco.status).toBe('NOT_VERIFIABLE');
    expect(banesco.provenance).toBe('NOT_VERIFIABLE');
  });

  it('separates the global reference from the executable matrix in one response', async () => {
    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();

    const res = await store.getExecutableMatrix(true);

    expect(res.marketReference.executable).toBe(false);
    expect(res.marketReference.note).toContain('NADIE puede ejecutar');
    expect(res.executableMatrix.cells).toBeDefined();
  });
});

describe('FASE 4 - executability from the captured book', () => {
  it('TEST 20: the 6 amount tiers add no requests at all', async () => {
    /*
     * 7 banks x 2 sides = 14 requests, exactly as before FASE 4. Six tiers
     * per bank per side would be 84 if each were queried. They are filtered
     * in memory from the same 14 responses.
     */
    const mock = stubBinance([makeAdItem({ price: '919.00' })], [makeAdItem({ price: '921.50' })]);
    const { store } = await freshStore();

    const result = await store.getExecutability(true);

    /*
     * CONTRACT CHANGE: a cold cache does a FULL SWEEP.
     *
     * The tiers used to be filtered in memory from one book per bank per side,
     * which is why this asserted 14. That book was Binance's top 20 ORDERED BY
     * PRICE, so a cheap ad accepting only 50K sat below twenty ads that did
     * not and never reached the 50K cell - a false negative on a real
     * operation. Each tier is now its own question, with transAmount.
     *
     * 7 banks x 2 sides x 6 tiers = 84, paid once when the cache is cold.
     * Steady state rotates one tier per tick and stays at 14.
     */
    expect(mock).toHaveBeenCalledTimes(Object.keys(BANK_CODE_MAP).length * 2 * 6);
    expect(result.amountKeys).toEqual(['10K', '20K', '30K', '40K', '50K', '100K']);
  });

  it('reads the cached book without touching Binance again', async () => {
    const mock = stubBinance([makeAdItem({ price: '919.00' })], [makeAdItem({ price: '921.50' })]);
    const { store } = await freshStore();

    await store.getExecutability(true);
    const afterFirst = mock.mock.calls.length;
    await store.getExecutability(); // cache is fresh

    expect(mock.mock.calls.length).toBe(afterFirst);
  });

  it('requests 20 rows per bank per side - the only page size Binance accepts here', async () => {
    /*
     * Was 50, which production rejected with "000002 illegal parameter" for
     * every bank - including one whose payType Binance demonstrably
     * publishes. 20 is what the unfiltered snapshot query uses, and that
     * query works against the real API.
     */
    const mock = stubBinance([makeAdItem({ price: '919.00' })], [makeAdItem({ price: '921.50' })]);
    const { store } = await freshStore();
    await store.getExecutability(true);

    const bodies = mock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(bodies.every((b) => b.rows === 20)).toBe(true);
  });

  it('produces executable quotes for the bank whose payType actually matches', async () => {
    // The fixture ad carries payType 'Banesco' for every bank query.
    stubBinance(
      [makeAdItem({ price: '919.00', tradable: '1000', min: '1000', max: '100000' })],
      [makeAdItem({ price: '921.50', tradable: '1000', min: '1000', max: '100000' })]
    );
    const { store } = await freshStore();

    const { byBank } = await store.getExecutability(true);
    const banesco = byBank.BANESCO['20K'];

    expect(banesco.bestExecutableBuy?.price).toBe(919);
    expect(banesco.bestExecutableSell?.price).toBe(921.5);
    expect(banesco.bestExecutableBuy?.provenance).toBe('EXECUTABLE');
    expect(banesco.spreadPct).toBeCloseTo(((921.5 - 919) / 919) * 100, 2);
  });

  it('leaves an unverified bank with no executable quote, never a fallback', async () => {
    stubBinance(
      [makeAdItem({ price: '919.00', tradable: '1000' })],
      [makeAdItem({ price: '921.50', tradable: '1000' })]
    );
    const { store } = await freshStore();

    const { byBank } = await store.getExecutability(true);
    const provincial = byBank.PROVINCIAL['20K'];

    expect(provincial.bestExecutableBuy).toBeNull();
    expect(provincial.bestExecutableSell).toBeNull();
    expect(provincial.spreadPct).toBeNull();
    expect(provincial.buyRejections).toEqual({ BANK_NOT_VERIFIED: 1 });
  });

  it('an unpublished volume never becomes an executable operation', async () => {
    stubBinance(
      [makeAdItem({ price: '919.00', tradable: '', surplus: '' })],
      [makeAdItem({ price: '921.50', tradable: '', surplus: '' })]
    );
    const { store } = await freshStore();

    const { byBank } = await store.getExecutability(true);
    const banesco = byBank.BANESCO['20K'];

    expect(banesco.bestExecutableBuy).toBeNull();
    expect(banesco.buyRejections).toEqual({ LIQUIDITY_NOT_VERIFIABLE: 1 });
  });
});

describe('FASE 6 - BEST_OPPORTUNITY end to end', () => {
  /** A book where Banesco is the only bank whose payType actually matches. */
  const liquidAd = (price: string, extra: Record<string, unknown> = {}) =>
    makeAdItem({ price, tradable: '5000', min: '1000', max: '100000', ...extra });

  it('exposes the best executable operation without extra requests', async () => {
    const mock = stubBinance([liquidAd('919.00')], [liquidAd('921.50')]);
    const { store } = await freshStore();

    const { result } = await store.getOpportunities(true);

    /*
     * CONTRACT CHANGE: a cold cache does a FULL SWEEP.
     *
     * The tiers used to be filtered in memory from one book per bank per side,
     * which is why this asserted 14. That book was Binance's top 20 ORDERED BY
     * PRICE, so a cheap ad accepting only 50K sat below twenty ads that did
     * not and never reached the 50K cell - a false negative on a real
     * operation. Each tier is now its own question, with transAmount.
     *
     * 7 banks x 2 sides x 6 tiers = 84, paid once when the cache is cold.
     * Steady state rotates one tier per tick and stays at 14.
     */
    expect(mock).toHaveBeenCalledTimes(Object.keys(BANK_CODE_MAP).length * 2 * 6);
    expect(result.bestOpportunity?.bank).toBe('BANESCO');
    expect(result.bestOpportunity?.buyPrice).toBe(919);
    expect(result.bestOpportunity?.sellPrice).toBe(921.5);
    expect(result.bestOpportunity?.verification).toBe('VERIFIED');
  });

  it('a second read adds no request at all', async () => {
    const mock = stubBinance([liquidAd('919.00')], [liquidAd('921.50')]);
    const { store } = await freshStore();

    await store.getOpportunities(true);
    const after = mock.mock.calls.length;
    await store.getOpportunities();

    expect(mock.mock.calls.length).toBe(after);
  });

  it('an isolated 980 ad does not become the best opportunity', async () => {
    // The production incident, through the whole pipeline.
    const level = Array.from({ length: 5 }, (_, i) =>
      liquidAd((921 + i * 0.1).toFixed(2), { advNo: `s${i}` })
    );
    stubBinance(
      [liquidAd('919.00')],
      [...level, liquidAd('980.00', { advNo: 'outlier', min: '500000', max: '900000' })]
    );
    const { store } = await freshStore();

    const { result } = await store.getOpportunities(true);

    expect(result.bestOpportunity?.sellPrice).toBe(921.4);
    expect(result.bestOpportunity?.sellAdvNo).not.toBe('outlier');
    expect(result.bestOpportunity!.marginPct).toBeLessThan(1);
  });

  it('reports no opportunity rather than inventing one', async () => {
    // No liquidity published anywhere: nothing is executable.
    stubBinance(
      [makeAdItem({ price: '919.00', tradable: '', surplus: '' })],
      [makeAdItem({ price: '921.50', tradable: '', surplus: '' })]
    );
    const { store } = await freshStore();

    const { result } = await store.getOpportunities(true);

    expect(result.bestOpportunity).toBeNull();
    expect(result.opportunities).toEqual([]);
  });

  /*
   * THIS TEST USED TO ASSERT THE OPPOSITE: that OPPORTUNITY_ABOVE fired and
   * logged "Oportunidad ejecutable en BANESCO".
   *
   * The rule announced the taker engine's BEST_OPPORTUNITY, which is the model
   * Telegram no longer speaks - and whose BUY/SELL mapping is inverted for a
   * maker. The rule is now refused in evaluateAlerts, so it can neither log a
   * trigger nor send a message. The opportunity itself is still computed and
   * still served by /api/market/opportunities; only its voice is gone.
   */
  it('OPPORTUNITY_ABOVE can no longer fire, even on a real operation', async () => {
    stubBinance([liquidAd('919.00')], [liquidAd('921.50')]);
    const { store, StorageEngine } = await freshStore();
    StorageEngine.deleteAlert('rule-spread-high');
    StorageEngine.deleteAlert('rule-volatility-spike');
    StorageEngine.saveAlert({
      id: 'op-rule',
      name: 'Oportunidad',
      condition: 'OPPORTUNITY_ABOVE',
      targetValue: 0.1,
      targetSide: 'BUY',
      enabled: true,
      createdAt: 1,
    });

    await store.getOpportunities(true); // warms the cache; no extra request later
    await store.pollMarket();

    // The operation exists...
    expect(store.getCachedBestOpportunity()!.marginPct).toBeGreaterThan(0);
    // ...and produced no trigger and no message.
    expect(fs.existsSync(path.join(tmpDir, 'data', 'alert_triggers.json'))).toBe(false);
  });

  it('does not fire an opportunity alert when no opportunity exists', async () => {
    stubBinance(
      [makeAdItem({ price: '919.00', tradable: '', surplus: '' })],
      [makeAdItem({ price: '980.00', tradable: '', surplus: '' })]
    );
    const { store, StorageEngine } = await freshStore();
    StorageEngine.deleteAlert('rule-spread-high');
    StorageEngine.deleteAlert('rule-volatility-spike');
    StorageEngine.saveAlert({
      id: 'op-rule',
      name: 'Oportunidad',
      condition: 'OPPORTUNITY_ABOVE',
      targetValue: 0.01,
      targetSide: 'BUY',
      enabled: true,
      createdAt: 1,
    });

    await store.getOpportunities(true);
    await store.pollMarket();

    expect(fs.existsSync(path.join(tmpDir, 'data', 'alert_triggers.json'))).toBe(false);
  });

  it('never fires an opportunity alert before the opportunity was computed', async () => {
    // The alert loop reads the cache only. A cold cache must stay silent
    // rather than force a bank-matrix refresh on every 6s poll.
    const mock = stubBinance([liquidAd('919.00')], [liquidAd('921.50')]);
    const { store, StorageEngine } = await freshStore();
    StorageEngine.deleteAlert('rule-spread-high');
    StorageEngine.deleteAlert('rule-volatility-spike');
    StorageEngine.saveAlert({
      id: 'op-rule',
      name: 'Oportunidad',
      condition: 'OPPORTUNITY_ABOVE',
      targetValue: 0.01,
      targetSide: 'BUY',
      enabled: true,
      createdAt: 1,
    });

    await store.pollMarket(); // cache still cold

    expect(fs.existsSync(path.join(tmpDir, 'data', 'alert_triggers.json'))).toBe(false);
    expect(mock).toHaveBeenCalledTimes(2); // the snapshot's two queries, nothing more
  });
});

describe('payType mapping status - no silent failure', () => {
  it('is NOT_VERIFIABLE before any poll, never optimistic', async () => {
    stubBinance([makeAdItem({ price: '919.00' })], [makeAdItem({ price: '921.50' })]);
    const { store } = await freshStore();

    const mapping = store.getPayTypeMapping();

    expect(mapping.status).toBe('NOT_VERIFIABLE');
    expect(mapping.observedAdCount).toBe(0);
    expect(mapping.banksVerified).toEqual([]);
    // The configured codes are still reported, for comparison.
    expect(mapping.configuredCodes).toContain('BBVAProvincial');
  });

  it('reports VERIFIED once a real ad matches a configured code', async () => {
    // The fixture ad carries payType 'Banesco', which IS configured.
    stubBinance([makeAdItem({ price: '919.00' })], [makeAdItem({ price: '921.50' })]);
    const { store } = await freshStore();
    await store.pollMarket();

    const mapping = store.getPayTypeMapping();

    expect(mapping.status).toBe('VERIFIED');
    expect(mapping.matchedCodes).toEqual(['Banesco']);
    expect(mapping.banksVerified).toEqual(['BANESCO']);
    expect(mapping.banksNotObserved).toContain('PROVINCIAL');
  });

  it('reports NOT_VERIFIED when Binance sends codes none of the banks claim', async () => {
    /*
     * The blocker this exists for. If BANK_CODE_MAP is wrong, every ad is
     * NOT_VERIFIED, every opportunity is null and Telegram goes quiet - which
     * from outside is indistinguishable from a calm market.
     */
    const foreign = { payType: 'BankTransferVES', tradeMethodName: 'Transferencia' };
    stubBinance(
      [makeAdItem({ price: '919.00', tradeMethods: [foreign] })],
      [makeAdItem({ price: '921.50', tradeMethods: [foreign] })]
    );
    const { store } = await freshStore();
    await store.pollMarket();

    const mapping = store.getPayTypeMapping();

    expect(mapping.status).toBe('NOT_VERIFIED');
    expect(mapping.observedPayTypes).toEqual(['BankTransferVES']);
    expect(mapping.matchedCodes).toEqual([]);
    expect(mapping.reason).toContain('BankTransferVES');
  });

  it('a wrong mapping produces no opportunity, and the reason is retrievable', async () => {
    const foreign = { payType: 'BankTransferVES', tradeMethodName: 'Transferencia' };
    stubBinance(
      [makeAdItem({ price: '919.00', tradable: '5000', tradeMethods: [foreign] })],
      [makeAdItem({ price: '921.50', tradable: '5000', tradeMethods: [foreign] })]
    );
    const { store } = await freshStore();
    await store.pollMarket();

    const { result } = await store.getOpportunities(true);

    expect(result.bestOpportunity).toBeNull();
    // ...and now it is possible to say WHY.
    expect(store.getPayTypeMapping().status).toBe('NOT_VERIFIED');
  });

  it('logs the wrong mapping as an error, once', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      errors.push(a.join(' '));
    });
    const foreign = { payType: 'BankTransferVES', tradeMethodName: 'Transferencia' };
    stubBinance(
      [makeAdItem({ price: '919.00', tradeMethods: [foreign] })],
      [makeAdItem({ price: '921.50', tradeMethods: [foreign] })]
    );
    const { store } = await freshStore();
    await store.pollMarket();
    await store.pollMarket();

    const mappingErrors = errors.filter((e) => e.includes('MAPPING INCORRECTO'));
    expect(mappingErrors).toHaveLength(1); // once per status change, not per poll
    spy.mockRestore();
  });
});

describe('live capture and historical persistence are different cadences', () => {
  const ad = (price: string) => makeAdItem({ price, tradable: '5000' });

  it('LIVE polling stays at 6 seconds - this test exists to stop it drifting to 60', async () => {
    /*
     * Sampling the HISTORY once a minute must never be mistaken for polling
     * Binance once a minute. The screen is the reason the poll is fast.
     * Measured through real fetch calls, not by reading a private field.
     */
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-23T16:00:00Z'));
    const mock = stubBinance([ad('919.00')], [ad('921.50')]);
    const { store } = await freshStore();

    store.start();
    await vi.advanceTimersByTimeAsync(30_000);
    store.stop();

    /*
     * 30s at 6s per poll = 6 polls (t=0 immediate, then 5 more), 2 requests
     * each.
     *
     * Discriminated by payTypes, not by rows: the snapshot queries the whole
     * book unfiltered (payTypes: []), the bank matrix always names a bank.
     * Both now send rows: 20, so rows can no longer tell them apart.
     */
    const polls = mock.mock.calls.filter(
      (c) => JSON.parse(String((c[1] as RequestInit).body)).payTypes.length === 0
    ).length / 2;
    expect(polls).toBeGreaterThanOrEqual(5);
    expect(polls).toBeLessThanOrEqual(6);
    vi.useRealTimers();
  });

  it('an intermediate observation reaches the LIVE snapshot but is not persisted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-23T16:00:00Z'));
    stubBinance([ad('919.00')], [ad('921.50')]);
    const { store } = await freshStore();

    await store.pollMarket(); // t=0 - first observation always persists
    expect(readData<HistoryRecord[]>('market_history.json')).toHaveLength(1);

    // A different market, 6 seconds later.
    vi.setSystemTime(Date.parse('2026-08-23T16:00:06Z'));
    stubBinance([ad('919.90')], [ad('922.40')]);
    const live = await store.pollMarket();

    // The screen sees it...
    expect(live?.strategicBuyPrice).toBe(919.9);
    expect(store.getCurrentSnapshot().snapshot?.strategicSellPrice).toBe(922.4);
    // ...the history does not.
    expect(readData<HistoryRecord[]>('market_history.json')).toHaveLength(1);
    vi.useRealTimers();
  });

  it('persists again once a full minute of observations has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-23T16:00:00Z'));
    stubBinance([ad('919.00')], [ad('921.50')]);
    const { store } = await freshStore();
    await store.pollMarket();

    // Nine more observations inside the minute: still one record.
    for (let i = 1; i <= 9; i += 1) {
      vi.setSystemTime(Date.parse('2026-08-23T16:00:00Z') + i * 6_000);
      await store.pollMarket();
    }
    expect(readData<HistoryRecord[]>('market_history.json')).toHaveLength(1);

    vi.setSystemTime(Date.parse('2026-08-23T16:01:00Z'));
    await store.pollMarket();
    expect(readData<HistoryRecord[]>('market_history.json')).toHaveLength(2);
    vi.useRealTimers();
  });

  it('stop() writes the newest observation the sampling skipped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-23T16:00:00Z'));
    stubBinance([ad('919.00')], [ad('921.50')]);
    const { store } = await freshStore();
    await store.pollMarket();

    vi.setSystemTime(Date.parse('2026-08-23T16:00:30Z'));
    stubBinance([ad('925.00')], [ad('926.00')]);
    await store.pollMarket(); // skipped by the sampling interval

    store.stop();

    const history = readData<HistoryRecord[]>('market_history.json');
    expect(history).toHaveLength(2);
    expect(history[1].buyPrice).toBe(925); // the skipped observation, not lost
    vi.useRealTimers();
  });

  it('an incomplete book is still never persisted, at any cadence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-23T16:00:00Z'));
    stubBinance([], [ad('921.50')]); // BUY side empty
    const { store } = await freshStore();
    await store.pollMarket();
    store.stop();

    // StorageEngine.initialize() creates the file; what matters is that no
    // observation was recorded into it.
    expect(readData<HistoryRecord[]>('market_history.json')).toEqual([]);
    vi.useRealTimers();
  });
});

describe('provenance (phase C1)', () => {
  it('marks a bank/amount cell EXECUTABLE when an ad of that bank really covers that tier', async () => {
    /*
     * CONTRACT CHANGE: was ratesByAmount['10K'].provenance === 'REAL'.
     * A cell is now EXECUTABLE only when the ad verified as this bank's, the
     * amount fits its limits AND its published volume covers the operation -
     * so the fixture ad has to carry a real volume, which it does.
     */
    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();

    const { executableMatrix } = await store.getExecutableMatrix(true);
    const cell = executableMatrix.cells.BANESCO['10K'];

    expect(cell.sell?.price).toBe(921);
    expect(cell.buy?.price).toBe(918);
    expect(cell.status).toBe('EXECUTABLE');
    expect(cell.provenance).toBe('EXECUTABLE');
  });

  it('reports null for a tier no ad can cover, never another tier price', async () => {
    // 100000 VES exceeds the ad's 50000 max.
    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();

    const { executableMatrix } = await store.getExecutableMatrix(true);
    const cell = executableMatrix.cells.BANESCO['100K'];

    expect(cell.buy).toBeNull();
    expect(cell.sell).toBeNull();
    expect(cell.spreadPct).toBeNull();
    expect(cell.availableUsdt).toBeNull();
    expect(cell.status).toBe('NO_AD');
    expect(cell.reason).toMatch(/ningún anuncio verificado/i);

    // The tier that IS covered still reports a real executable rate.
    expect(executableMatrix.cells.BANESCO['10K'].sell?.price).toBe(921);
  });

  it('says NO_AD for an empty side - an absent rate is an honest observation', async () => {
    stubBinance([], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();

    const { executableMatrix } = await store.getExecutableMatrix(true);
    const cell = executableMatrix.cells.BANESCO['10K'];

    expect(cell.buy).toBeNull();
    expect(cell.buyStatus).toBe('NO_AD');
    expect(cell.status).toBe('NO_AD');
  });

  it('flags an unfiltered snapshot served in place of a filtered one', async () => {
    // First poll succeeds so a central snapshot exists to fall back to.
    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();
    await store.pollMarket();

    // Now the filtered query fails.
    vi.stubGlobal('fetch', async () => {
      throw new Error('bank query failed');
    });
    const filtered = await store.getFilteredSnapshot('BANESCO', 50000);

    expect(filtered.snapshot?.bestBuyPrice).toBe(918); // unfiltered data
    expect(filtered.snapshot?.filterFallbackReason).toMatch(/TODOS los bancos/i);
  });

  it('does not flag a snapshot whose filter was honoured', async () => {
    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();

    const filtered = await store.getFilteredSnapshot('BANESCO', 50000);
    expect(filtered.snapshot?.filterFallbackReason).toBeUndefined();
  });

  it('reports the never-connected OFFLINE snapshot as null, not as 0', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('Binance unreachable');
    });
    const { store } = await freshStore();
    const snapshot = await store.pollMarket();

    expect(snapshot?.bestBuyPrice).toBeNull();
    expect(snapshot?.bestBuy.value).toBeNull();
    expect(snapshot?.bestBuy.provenance).toBe('REAL');
    expect(snapshot?.bestBuy.reason).toMatch(/No se ha obtenido ningun snapshot valido/i);
  });
});

describe('C2 - null contract', () => {
  it('does NOT persist a history record when one side of the book is empty', async () => {
    // Decision (b): the history only stores complete observations, so
    // HistoryRecord and storage.ts stay unchanged.
    stubBinance([], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();

    const snapshot = await store.pollMarket();
    expect(snapshot?.bestSellPrice).toBe(921);
    expect(snapshot?.bestBuyPrice).toBeNull();

    expect(readData<HistoryRecord[]>('market_history.json')).toEqual([]);
  });

  it('persists again as soon as both sides are back', async () => {
    stubBinance([], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();
    await store.pollMarket();
    expect(readData<HistoryRecord[]>('market_history.json')).toHaveLength(0);

    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    await store.pollMarket();

    const history = readData<HistoryRecord[]>('market_history.json');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ buyPrice: 918, sellPrice: 921 });
  });

  it('never writes a null price into the persisted schema', async () => {
    stubBinance([makeAdItem({ price: '918.00' })], []);
    const { store } = await freshStore();
    await store.pollMarket();

    for (const record of readData<HistoryRecord[]>('market_history.json')) {
      expect(record.buyPrice).not.toBeNull();
      expect(record.sellPrice).not.toBeNull();
      expect(record.spreadPct).not.toBeNull();
    }
  });

  it('does not fire a BELOW alert when the price is missing', async () => {
    // Before C2 a missing side surfaced as 0, so every BELOW rule fired.
    stubBinance([], [makeAdItem({ price: '921.00' })]);
    const { store, StorageEngine } = await freshStore();
    StorageEngine.deleteAlert('rule-spread-high');
    StorageEngine.deleteAlert('rule-volatility-spike');
    StorageEngine.saveAlert({
      id: 'below-rule',
      name: 'Precio por debajo de 900',
      condition: 'BELOW',
      targetValue: 900,
      targetSide: 'BUY',
      enabled: true,
      createdAt: 1,
    } satisfies AlertRule);

    await store.pollMarket();
    expect(fs.existsSync(path.join(tmpDir, 'data', 'alert_triggers.json'))).toBe(false);
  });

  it('does not fire a spread alert when the spread cannot be computed', async () => {
    stubBinance([], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();

    await store.pollMarket();
    expect(fs.existsSync(path.join(tmpDir, 'data', 'alert_triggers.json'))).toBe(false);
  });

  it('still fires a BELOW alert when the price does exist', async () => {
    stubBinance([makeAdItem({ price: '890.00' })], [makeAdItem({ price: '895.00' })]);
    const { store, StorageEngine } = await freshStore();
    StorageEngine.deleteAlert('rule-spread-high');
    StorageEngine.deleteAlert('rule-volatility-spike');
    StorageEngine.saveAlert({
      id: 'below-rule',
      name: 'Precio por debajo de 900',
      condition: 'BELOW',
      targetValue: 900,
      targetSide: 'BUY',
      enabled: true,
      createdAt: 1,
    } satisfies AlertRule);

    await store.pollMarket();
    const triggers = readData<AlertTriggerLog[]>('alert_triggers.json');
    expect(triggers).toHaveLength(1);
    expect(triggers[0].price).toBe(890);
  });
});

describe('C2 - LIVE / STALE / OFFLINE', () => {
  it('reports LIVE for a fresh snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-23T16:00:00Z'));
    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();
    await store.pollMarket();

    const current = store.getCurrentSnapshot();
    expect(current.effectiveStatus).toBe('LIVE');
    expect(current.ageSeconds).toBe(0);
  });

  it('reports STALE with a real age past the 35s threshold', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-23T16:00:00Z'));
    stubBinance([makeAdItem({ price: '918.00' })], [makeAdItem({ price: '921.00' })]);
    const { store } = await freshStore();
    await store.pollMarket();

    vi.setSystemTime(Date.parse('2026-08-23T16:02:00Z'));
    const current = store.getCurrentSnapshot();
    expect(current.effectiveStatus).toBe('STALE');
    expect(current.ageSeconds).toBe(120);
    // C.4(ii): the last good value is kept, but never as a live reading.
    expect(current.snapshot?.bestBuyPrice).toBe(918);
  });

  it('reports OFFLINE with null prices when nothing was ever captured', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('down');
    });
    const { store } = await freshStore();
    await store.pollMarket();

    const current = store.getCurrentSnapshot();
    expect(current.effectiveStatus).toBe('OFFLINE');
    expect(current.snapshot?.bestBuyPrice).toBeNull();
  });
});

describe('payType diagnostic over the full captured book', () => {
  it('reports the inspection window from the real snapshot', async () => {
    const buy = Array.from({ length: 20 }, (_, i) =>
      makeAdItem({ advNo: `b${i}`, price: (919 + i * 0.01).toFixed(2) })
    );
    const sell = Array.from({ length: 20 }, (_, i) =>
      makeAdItem({ advNo: `s${i}`, price: (921 + i * 0.01).toFixed(2) })
    );
    stubBinance(buy, sell);
    const { store } = await freshStore();
    await store.pollMarket();

    const m = store.getPayTypeMapping();

    // 20 + 20, now that the snapshot no longer discards half.
    expect(m.inspected).toEqual({
      buyAds: 20,
      sellAds: 20,
      totalAds: 40,
      paymentMethodEntries: 40,
    });
  });

  it('distinguishes a bank not observed from a code Binance does not know', async () => {
    // 'RecargaPines' is a real rail production returns and no bank claims.
    const unmapped = { payType: 'RecargaPines', tradeMethodName: 'Recarga Pines' };
    stubBinance(
      [makeAdItem({ price: '919.00', tradeMethods: [unmapped] })],
      [makeAdItem({ price: '921.50' })] // default fixture: Banesco
    );
    const { store } = await freshStore();
    await store.pollMarket();

    const m = store.getPayTypeMapping();
    const verdict = (bank: string) => m.bankVerdicts.find((v) => v.bank === bank)!;

    expect(verdict('BANESCO').status).toBe('VERIFIED');
    expect(verdict('VENEZUELA').status).toBe('NOT_OBSERVED'); // simply absent here
    // ...and the unclaimed code is preserved as evidence, not acted on.
    expect(m.observedUnmapped.map((o) => o.payType)).toContain('RecargaPines');
  });

  it('the corrected codes verify against the payTypes production really returns', async () => {
    /*
     * Production evidence, September 2026: Binance publishes
     * 'BNCBancoNacional' and 'BancoDeVenezuela'. The map previously carried
     * 'BNC' and 'BancodeVenezuela', neither of which matched anything.
     */
    stubBinance(
      [
        makeAdItem({
          advNo: 'bnc',
          price: '919.00',
          tradeMethods: [{ payType: 'BNCBancoNacional', tradeMethodName: 'BNC Banco Nacional' }],
        }),
      ],
      [
        makeAdItem({
          advNo: 'bdv',
          price: '921.50',
          tradeMethods: [{ payType: 'BancoDeVenezuela', tradeMethodName: 'Banco de Venezuela' }],
        }),
      ]
    );
    const { store } = await freshStore();
    await store.pollMarket();

    const m = store.getPayTypeMapping();
    const verdict = (bank: string) => m.bankVerdicts.find((v) => v.bank === bank)!;

    expect(verdict('BNC').status).toBe('VERIFIED');
    expect(verdict('BNC').matchedCodes).toEqual(['BNCBancoNacional']);
    expect(verdict('VENEZUELA').status).toBe('VERIFIED');
    expect(verdict('VENEZUELA').matchedCodes).toEqual(['BancoDeVenezuela']);
    // Neither is left sitting in the unmapped pile any more.
    expect(m.observedUnmapped).toEqual([]);
  });

  it('reports the window as zero before any poll, never as unknown depth', async () => {
    stubBinance([makeAdItem({ price: '919.00' })], [makeAdItem({ price: '921.50' })]);
    const { store } = await freshStore();

    expect(store.getPayTypeMapping().inspected).toEqual({
      buyAds: 0,
      sellAds: 0,
      totalAds: 0,
      paymentMethodEntries: 0,
    });
  });
});

describe('an inverted market produces no opportunity and no alert', () => {
  const liquid = (price: string, extra: Record<string, unknown> = {}) =>
    makeAdItem({ price, tradable: '5000', min: '1000', max: '100000', ...extra });

  it('BUY above SELL: the cell is kept as context, bestOpportunity is null', async () => {
    // Repurchase costlier than the sale. Real market state, not an operation.
    stubBinance([liquid('941.00')], [liquid('918.00')]);
    const { store } = await freshStore();

    const { result } = await store.getOpportunities(true);

    expect(result.opportunities.length).toBeGreaterThan(0);
    expect(result.byBank.BANESCO['20K']!.spreadPct).toBeLessThan(0);
    expect(result.bestOpportunity).toBeNull();
  });

  it('Telegram is never handed a losing operation', async () => {
    stubBinance([liquid('941.00')], [liquid('918.00')]);
    const { store, StorageEngine } = await freshStore();
    StorageEngine.deleteAlert('rule-spread-high');
    StorageEngine.deleteAlert('rule-volatility-spike');
    // A rule whose threshold a negative margin WOULD clear, if it ever arrived.
    StorageEngine.saveAlert({
      id: 'op-rule',
      name: 'Oportunidad',
      condition: 'OPPORTUNITY_ABOVE',
      targetValue: -99,
      targetSide: 'BUY',
      enabled: true,
      createdAt: 1,
    });

    await store.getOpportunities(true);
    await store.pollMarket();

    expect(store.getCachedBestOpportunity()).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'data', 'alert_triggers.json'))).toBe(false);
  });

  /*
   * Was: "a profitable market still alerts". It no longer does, and that is the
   * point of this phase - a profitable TAKER operation is not the operator's
   * business. What speaks now is the maker summary, from the same capture.
   */
  it('a profitable market is still silent on the arbitrage channel', async () => {
    stubBinance([liquid('919.00')], [liquid('921.50')]);
    const { store, StorageEngine } = await freshStore();
    StorageEngine.deleteAlert('rule-spread-high');
    StorageEngine.deleteAlert('rule-volatility-spike');
    StorageEngine.saveAlert({
      id: 'op-rule',
      name: 'Oportunidad',
      condition: 'OPPORTUNITY_ABOVE',
      targetValue: 0.1,
      targetSide: 'BUY',
      enabled: true,
      createdAt: 1,
    });

    await store.getOpportunities(true);
    await store.pollMarket();

    expect(store.getCachedBestOpportunity()!.marginPct).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tmpDir, 'data', 'alert_triggers.json'))).toBe(false);
  });
});

describe('CASO 20 - historical samples survive a restart', () => {
  const liquid = (price: string) => makeAdItem({ price, tradable: '5000' });

  it('stores a sample, reads it back, and keeps accumulating after a restart', async () => {
    vi.useFakeTimers();
    const t0 = Date.parse('2026-08-25T16:00:00Z');
    vi.setSystemTime(t0);
    stubBinance([liquid('919.00')], [liquid('921.50')]);

    const first = await freshStore();
    await first.store.pollMarket();
    vi.setSystemTime(t0 + 60_000);
    await first.store.pollMarket();
    expect(first.StorageEngine.getHistory()).toHaveLength(2);

    // Restart: fresh modules, same DATA_DIR. Nothing is carried in memory.
    vi.setSystemTime(t0 + 120_000);
    const second = await freshStore();

    // The samples written before the restart are still there...
    expect(second.StorageEngine.getHistory()).toHaveLength(2);
    // ...and the process keeps appending to them, it does not start over.
    await second.store.pollMarket();
    const after = second.StorageEngine.getHistory();
    expect(after).toHaveLength(3);

    // Chronological order, no gaps, no duplicates.
    const stamps = after.map((r) => r.timestamp);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(new Set(stamps).size).toBe(3);
    expect(after.every((r) => r.buyPrice === 919 && r.sellPrice === 921.5)).toBe(true);
    vi.useRealTimers();
  });
});

describe('strategic history records', () => {
  const liquid = (price: string) => makeAdItem({ price, tradable: '5000' });

  it('a new record carries the strategic level and its version', async () => {
    stubBinance([liquid('919.00')], [liquid('921.50')]);
    const { store } = await freshStore();
    await store.pollMarket();

    const [record] = readData<HistoryRecord[]>('market_history.json');

    expect(record.calculationVersion).toBe('v2-strategic');
    expect(record.strategicBuyPrice).toBe(919);
    expect(record.strategicSellPrice).toBe(921.5);
    expect(record.strategicSpreadPct).toBeCloseTo(((921.5 - 919) / 919) * 100, 2);
    // The raw fields are untouched and still there.
    expect(record.buyPrice).toBe(919);
    expect(record.sellPrice).toBe(921.5);
  });

  it('a legacy record is left exactly as written, never backfilled', async () => {
    stubBinance([liquid('919.00')], [liquid('921.50')]);
    const { StorageEngine } = await freshStore();

    // A v1 record, as an older build would have written it.
    StorageEngine.appendRecord({
      id: 'legacy-1',
      timestamp: Date.parse('2026-08-01T10:00:00Z'),
      dateStr: '2026-08-01',
      hour: 10,
      buyPrice: 900,
      sellPrice: 905,
      spreadPct: 0.55,
      bestBuyMerchant: 'A',
      bestSellMerchant: 'B',
      activeBuyAds: 3,
      activeSellAds: 3,
      source: 'BINANCE_P2P',
    });

    const [legacy] = StorageEngine.getHistory();

    expect(legacy.calculationVersion).toBeUndefined();
    expect(legacy.strategicBuyPrice).toBeUndefined();
    expect(legacy.buyPrice).toBe(900); // readable, unchanged
  });

  it('does not write strategic fields when a side had no price', async () => {
    stubBinance([], [liquid('921.50')]); // BUY side empty
    const { store } = await freshStore();
    await store.pollMarket();

    // C2: an incomplete observation is not recorded at all.
    expect(readData<HistoryRecord[]>('market_history.json')).toEqual([]);
  });

  it('storage diagnostics count the strategic records', async () => {
    stubBinance([liquid('919.00')], [liquid('921.50')]);
    const { store, StorageEngine } = await freshStore();
    await store.pollMarket();

    const d = StorageEngine.describeStorage();
    expect(d.recordCount).toBe(1);
    expect(d.strategicRecordCount).toBe(1);
  });
});

describe('shutdown flush', () => {
  const liquid = (price: string) => makeAdItem({ price, tradable: '5000' });

  it('stop() writes the sample the interval skipped', async () => {
    vi.useFakeTimers();
    const t0 = Date.parse('2026-08-25T18:00:00Z');
    vi.setSystemTime(t0);
    stubBinance([liquid('919.00')], [liquid('921.50')]);
    const { store } = await freshStore();

    await store.pollMarket(); // persists (first one always does)
    vi.setSystemTime(t0 + 30_000);
    stubBinance([liquid('925.00')], [liquid('926.00')]);
    await store.pollMarket(); // inside the sampling window: pending

    expect(readData<HistoryRecord[]>('market_history.json')).toHaveLength(1);
    store.stop();
    const after = readData<HistoryRecord[]>('market_history.json');

    expect(after).toHaveLength(2);
    expect(after[1].buyPrice).toBe(925);
    vi.useRealTimers();
  });

  it('stopping twice does not append the same sample again', async () => {
    /*
     * A platform commonly sends SIGTERM and then SIGINT. Flushing twice would
     * duplicate the newest observation, which would then look like two ticks
     * at the same instant.
     */
    vi.useFakeTimers();
    const t0 = Date.parse('2026-08-25T18:00:00Z');
    vi.setSystemTime(t0);
    stubBinance([liquid('919.00')], [liquid('921.50')]);
    const { store } = await freshStore();

    await store.pollMarket();
    vi.setSystemTime(t0 + 30_000);
    await store.pollMarket();

    store.stop();
    store.stop();
    store.stop();

    const after = readData<HistoryRecord[]>('market_history.json');
    expect(after).toHaveLength(2);
    expect(new Set(after.map((r) => r.timestamp)).size).toBe(2);
    vi.useRealTimers();
  });

  it('stop() with nothing pending writes nothing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-25T18:00:00Z'));
    stubBinance([liquid('919.00')], [liquid('921.50')]);
    const { store } = await freshStore();
    await store.pollMarket();

    store.stop();

    expect(readData<HistoryRecord[]>('market_history.json')).toHaveLength(1);
    vi.useRealTimers();
  });
});
