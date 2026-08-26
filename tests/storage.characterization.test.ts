/**
 * CHARACTERIZATION TESTS - server/storage.ts
 *
 * StorageEngine resolves its paths from process.cwd() in static field
 * initializers, so each test chdirs into a fresh temp dir and re-imports the
 * module. Nothing here touches the repository's own data/ directory.
 *
 * "BUG:" tests pin behaviour the audit flagged as defective.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeHistory } from './helpers/fixtures.js';
import type { AlertRule, AlertTriggerLog, HistoryRecord } from '../server/types.js';

type StorageModule = typeof import('../server/storage.js');

const originalCwd = process.cwd();
let tmpDir: string;

/** Fresh temp cwd + fresh module instance (static state is per-module). */
async function freshStorage(): Promise<StorageModule['StorageEngine']> {
  vi.resetModules();
  const { StorageEngine } = (await import('../server/storage.js')) as StorageModule;
  return StorageEngine;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', file), 'utf-8')) as T;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-storage-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  delete process.env.DATA_DIR;
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('initialize', () => {
  it('creates data/ and seeds the two default alert rules', async () => {
    const StorageEngine = await freshStorage();
    StorageEngine.initialize();

    expect(fs.existsSync(path.join(tmpDir, 'data'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'data', 'market_history.json'))).toBe(true);

    const alerts = readJson<AlertRule[]>('alerts.json');
    expect(alerts.map((a) => a.id)).toEqual(['rule-spread-high', 'rule-volatility-spike']);
    expect(alerts[0]).toMatchObject({
      condition: 'SPREAD_ABOVE',
      targetValue: 2.0,
      targetSide: 'SELL',
      enabled: true,
    });
    expect(alerts[1]).toMatchObject({
      condition: 'VOLATILITY_SPIKE',
      targetValue: 1.5,
      targetSide: 'BUY',
    });
  });

  it('writes an empty history file when none exists', async () => {
    const StorageEngine = await freshStorage();
    StorageEngine.initialize();
    expect(readJson<HistoryRecord[]>('market_history.json')).toEqual([]);
  });

  it('does not create alert_triggers.json until a trigger fires', async () => {
    const StorageEngine = await freshStorage();
    StorageEngine.initialize();
    expect(fs.existsSync(path.join(tmpDir, 'data', 'alert_triggers.json'))).toBe(false);
    expect(StorageEngine.getTriggers()).toEqual([]);
  });

  it('reloads an existing history file from disk', async () => {
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    const seeded = makeHistory(3);
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'market_history.json'),
      JSON.stringify(seeded),
      'utf-8'
    );

    const StorageEngine = await freshStorage();
    expect(StorageEngine.getHistory()).toHaveLength(3);
  });

  it('is idempotent - a second call does not reseed', async () => {
    const StorageEngine = await freshStorage();
    StorageEngine.initialize();
    StorageEngine.deleteAlert('rule-spread-high');
    StorageEngine.initialize();
    expect(StorageEngine.getAlerts().map((a) => a.id)).toEqual(['rule-volatility-spike']);
  });
});

describe('BUG: corrupt history is silently discarded, not quarantined', () => {
  it('resets to [] when market_history.json is unparseable', async () => {
    // Audit B2: a crash mid-write leaves truncated JSON. On next boot the parse
    // error is swallowed and the array is reset - the next append then
    // overwrites the file, losing everything permanently and silently.
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'market_history.json'),
      '[{"id":"tick-1","timestamp":1,"buyPri',
      'utf-8'
    );

    const StorageEngine = await freshStorage();
    expect(StorageEngine.getHistory()).toEqual([]);

    StorageEngine.appendRecord(makeHistory(1)[0]);
    expect(readJson<HistoryRecord[]>('market_history.json')).toHaveLength(1);
  });

  it('resets to [] when the history file holds a non-array JSON value', async () => {
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'market_history.json'),
      '{"not":"an array"}',
      'utf-8'
    );
    const StorageEngine = await freshStorage();
    expect(StorageEngine.getHistory()).toEqual([]);
  });
});

describe('appendRecord / getHistory', () => {
  it('persists each record and preserves insertion order', async () => {
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(3, { drift: 0.5 })) {
      StorageEngine.appendRecord(rec);
    }

    const onDisk = readJson<HistoryRecord[]>('market_history.json');
    expect(onDisk.map((r) => r.buyPrice)).toEqual([918, 918.5, 919]);
  });

  it('BUG: rewrites the entire array on every append', async () => {
    // Audit B3: O(n) write per tick -> O(n^2) total. At the 6s polling cadence
    // this is ~35.8 GB written in the first 24h.
    const StorageEngine = await freshStorage();
    const historyFile = path.join(tmpDir, 'data', 'market_history.json');

    StorageEngine.appendRecord(makeHistory(1)[0]);
    const sizeAfterOne = fs.statSync(historyFile).size;

    for (const rec of makeHistory(10, { startTs: 1_756_000_100_000 })) {
      StorageEngine.appendRecord(rec);
    }
    const sizeAfterEleven = fs.statSync(historyFile).size;

    expect(sizeAfterEleven).toBeGreaterThan(sizeAfterOne * 10);
  });

  it('BUG: enforces no retention limit on history', async () => {
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(250)) StorageEngine.appendRecord(rec);
    expect(StorageEngine.getHistory()).toHaveLength(250);
  });

  it('limit returns the NEWEST n records', async () => {
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(10, { drift: 1 })) StorageEngine.appendRecord(rec);
    const last3 = StorageEngine.getHistory(3);
    expect(last3.map((r) => r.buyPrice)).toEqual([925, 926, 927]);
  });

  it('sinceTimestamp filters inclusively, and limit is applied AFTER the filter', async () => {
    const StorageEngine = await freshStorage();
    const records = makeHistory(10, { drift: 1 });
    for (const rec of records) StorageEngine.appendRecord(rec);

    const since = records[4].timestamp;
    expect(StorageEngine.getHistory(undefined, since)).toHaveLength(6);
    // Audit B8: this ordering is why /api/market/history?range=30d still
    // returns at most the newest 500 ticks.
    expect(StorageEngine.getHistory(2, since).map((r) => r.buyPrice)).toEqual([926, 927]);
  });

  it('returns a copy - mutating the result does not corrupt the store', async () => {
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(3)) StorageEngine.appendRecord(rec);
    StorageEngine.getHistory().pop();
    expect(StorageEngine.getHistory()).toHaveLength(3);
  });
});

describe('getHistorySummary', () => {
  it('reports zeros and nulls on an empty store', async () => {
    const StorageEngine = await freshStorage();
    expect(StorageEngine.getHistorySummary()).toEqual({
      totalRecords: 0,
      oldestTimestamp: null,
      newestTimestamp: null,
      availableDays: 0,
      availableHours: 0,
    });
  });

  it('derives the span from the FIRST and LAST array entries, not from min/max', async () => {
    const StorageEngine = await freshStorage();
    // 601 records * 6s = 3600s = exactly 1 hour
    for (const rec of makeHistory(601)) StorageEngine.appendRecord(rec);

    const summary = StorageEngine.getHistorySummary();
    expect(summary.totalRecords).toBe(601);
    expect(summary.availableHours).toBe(1);
    expect(summary.availableDays).toBe(0.04);
  });

  it('BUG: an out-of-order append yields a nonsensical span (clamped to 0)', async () => {
    const StorageEngine = await freshStorage();
    const [newer] = makeHistory(1, { startTs: 2_000_000_000_000 });
    const [older] = makeHistory(1, { startTs: 1_000_000_000_000 });
    StorageEngine.appendRecord(newer);
    StorageEngine.appendRecord(older);

    const summary = StorageEngine.getHistorySummary();
    expect(summary.oldestTimestamp).toBe(2_000_000_000_000); // actually the newest
    expect(summary.availableHours).toBe(0);
  });
});

describe('alerts', () => {
  it('saveAlert inserts a new rule and updates an existing one in place', async () => {
    const StorageEngine = await freshStorage();
    const rule: AlertRule = {
      id: 'custom-1',
      name: 'Test',
      condition: 'ABOVE',
      targetValue: 950,
      targetSide: 'SELL',
      enabled: true,
      createdAt: 1,
    };

    StorageEngine.saveAlert(rule);
    expect(StorageEngine.getAlerts()).toHaveLength(3);

    StorageEngine.saveAlert({ ...rule, targetValue: 999 });
    expect(StorageEngine.getAlerts()).toHaveLength(3);
    expect(readJson<AlertRule[]>('alerts.json').find((a) => a.id === 'custom-1')?.targetValue)
      .toBe(999);
  });

  it('deleteAlert returns false for an unknown id and does not rewrite', async () => {
    const StorageEngine = await freshStorage();
    expect(StorageEngine.deleteAlert('does-not-exist')).toBe(false);
    expect(StorageEngine.deleteAlert('rule-spread-high')).toBe(true);
    expect(readJson<AlertRule[]>('alerts.json')).toHaveLength(1);
  });

  it('BUG: getAlerts hands out the internal array by reference', async () => {
    // Audit B18: callers (CentralMarketStore.evaluateAlerts) mutate stored
    // rules directly, bypassing saveAlert.
    const StorageEngine = await freshStorage();
    StorageEngine.getAlerts()[0].enabled = false;
    expect(StorageEngine.getAlerts()[0].enabled).toBe(false);
  });
});

describe('triggers', () => {
  const trigger = (n: number): AlertTriggerLog => ({
    id: `trigger-${n}`,
    ruleId: 'rule-spread-high',
    ruleName: 'Spread Mayor a 2.0%',
    message: `msg ${n}`,
    price: 918 + n,
    timestamp: 1_756_000_000_000 + n,
  });

  it('stores newest-first and caps the log at 100 entries', async () => {
    const StorageEngine = await freshStorage();
    for (let i = 0; i < 120; i++) StorageEngine.logTrigger(trigger(i));

    const stored = readJson<AlertTriggerLog[]>('alert_triggers.json');
    expect(stored).toHaveLength(100);
    expect(stored[0].id).toBe('trigger-119');
    expect(stored[99].id).toBe('trigger-20');
  });

  it('getTriggers defaults to the newest 30', async () => {
    const StorageEngine = await freshStorage();
    for (let i = 0; i < 50; i++) StorageEngine.logTrigger(trigger(i));
    expect(StorageEngine.getTriggers()).toHaveLength(30);
    expect(StorageEngine.getTriggers(5)[0].id).toBe('trigger-49');
  });
});

describe('data directory resolution (DATA_DIR)', () => {
  it('defaults to <cwd>/data when DATA_DIR is unset', async () => {
    delete process.env.DATA_DIR;
    const StorageEngine = await freshStorage();
    expect(StorageEngine.getDataDir()).toBe(path.join(fs.realpathSync(tmpDir), 'data'));
  });

  it('writes all three files into an absolute DATA_DIR', async () => {
    const volume = path.join(tmpDir, 'volume');
    process.env.DATA_DIR = volume;

    const StorageEngine = await freshStorage();
    StorageEngine.initialize();
    StorageEngine.appendRecord(makeHistory(1)[0]);
    StorageEngine.logTrigger({
      id: 't1',
      ruleId: 'rule-spread-high',
      ruleName: 'Spread Mayor a 2.0%',
      message: 'x',
      price: 918,
      timestamp: 1,
    });

    expect(StorageEngine.getDataDir()).toBe(volume);
    expect(fs.readdirSync(volume).sort()).toEqual([
      'alert_triggers.json',
      'alerts.json',
      'market_history.json',
    ]);
    // Nothing leaks into the legacy <cwd>/data location.
    expect(fs.existsSync(path.join(tmpDir, 'data'))).toBe(false);
  });

  it('resolves a relative DATA_DIR against the working directory', async () => {
    process.env.DATA_DIR = 'var/market';
    const StorageEngine = await freshStorage();
    StorageEngine.initialize();
    expect(StorageEngine.getDataDir()).toBe(path.resolve('var/market'));
    expect(fs.existsSync(path.join(tmpDir, 'var', 'market', 'alerts.json'))).toBe(true);
  });

  it('treats an empty or whitespace-only DATA_DIR as unset', async () => {
    process.env.DATA_DIR = '   ';
    const StorageEngine = await freshStorage();
    expect(StorageEngine.getDataDir()).toBe(path.join(fs.realpathSync(tmpDir), 'data'));
  });

  it('reads back an existing history from the configured volume', async () => {
    const volume = path.join(tmpDir, 'volume');
    fs.mkdirSync(volume, { recursive: true });
    fs.writeFileSync(
      path.join(volume, 'market_history.json'),
      JSON.stringify(makeHistory(7)),
      'utf-8'
    );

    process.env.DATA_DIR = volume;
    const StorageEngine = await freshStorage();
    expect(StorageEngine.getHistory()).toHaveLength(7);
  });
});

describe('storage diagnostics', () => {
  it('reports the configured DATA_DIR, resolved to an absolute path', async () => {
    process.env.DATA_DIR = path.join(tmpDir, 'volume');
    vi.resetModules();
    const { StorageEngine } = await import('../server/storage.js');

    const d = StorageEngine.describeStorage();

    expect(d.dataDir).toBe(path.join(tmpDir, 'volume'));
    expect(d.historyFile).toBe(path.join(tmpDir, 'volume', 'market_history.json'));
    delete process.env.DATA_DIR;
  });

  it('falls back to ./data when DATA_DIR is unset', async () => {
    delete process.env.DATA_DIR;
    vi.resetModules();
    const { StorageEngine } = await import('../server/storage.js');

    expect(StorageEngine.describeStorage().dataDir).toBe(path.join(process.cwd(), 'data'));
  });

  it('reports the directory as existing and writable once initialised', async () => {
    vi.resetModules();
    const { StorageEngine } = await import('../server/storage.js');
    const d = StorageEngine.describeStorage();

    expect(d.exists).toBe(true);
    expect(d.writable).toBe(true);
  });

  it('counts records and reports the real time span', async () => {
    vi.resetModules();
    const { StorageEngine } = await import('../server/storage.js');
    const at = (iso: string) => ({
      id: iso, timestamp: Date.parse(iso), dateStr: iso, hour: 12,
      buyPrice: 919, sellPrice: 921, spreadPct: 0.2,
      bestBuyMerchant: 'A', bestSellMerchant: 'B',
      activeBuyAds: 1, activeSellAds: 1, source: 'BINANCE_P2P',
    });
    StorageEngine.appendRecord(at('2026-08-25T10:00:00.000Z'));
    StorageEngine.appendRecord(at('2026-08-25T10:05:00.000Z'));

    const d = StorageEngine.describeStorage();

    expect(d.recordCount).toBe(2);
    expect(d.oldestTimestamp).toBe('2026-08-25T10:00:00.000Z');
    expect(d.newestTimestamp).toBe('2026-08-25T10:05:00.000Z');
    expect(d.strategicRecordCount).toBe(0); // both are legacy records
  });

  it('reports an empty history as empty, not as unknown', async () => {
    vi.resetModules();
    const { StorageEngine } = await import('../server/storage.js');
    const d = StorageEngine.describeStorage();

    expect(d.recordCount).toBe(0);
    expect(d.oldestTimestamp).toBeNull();
    expect(d.newestTimestamp).toBeNull();
  });

  it('exposes no environment, credentials or file contents', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'secret-token-value';
    vi.resetModules();
    const { StorageEngine } = await import('../server/storage.js');

    const serialised = JSON.stringify(StorageEngine.describeStorage());

    expect(serialised).not.toContain('secret-token-value');
    expect(Object.keys(StorageEngine.describeStorage()).sort()).toEqual([
      'dataDir', 'exists', 'historyFile', 'newestTimestamp', 'oldestTimestamp',
      'recordCount', 'strategicRecordCount', 'writable',
    ]);
    delete process.env.TELEGRAM_BOT_TOKEN;
  });
});
