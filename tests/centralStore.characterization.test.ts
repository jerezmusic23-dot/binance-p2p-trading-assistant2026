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
    // 10 ads per side are fetched; two prices survive.
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
    expect(snapshot).toMatchObject({
      status: 'OFFLINE',
      bestBuyPrice: 0,
      bestSellPrice: 0,
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

  it('BUG: VOLATILITY_SPIKE actually measures the spread, not volatility', async () => {
    // Audit B14: the rule compares snapshot.spreadPercentage > targetValue*1.5.
    // A wide but perfectly stable spread reports a "volatility spike".
    const { store, StorageEngine } = await pollWithSpread('918.00', '941.00'); // 2.51% > 1.5*1.5
    StorageEngine.deleteAlert('rule-spread-high');
    await store.pollMarket();

    const triggers = readData<AlertTriggerLog[]>('alert_triggers.json');
    expect(triggers).toHaveLength(1);
    expect(triggers[0].ruleId).toBe('rule-volatility-spike');
    expect(triggers[0].message).toContain('Alta volatilidad');
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
