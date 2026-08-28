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
  delete process.env.HISTORY_MAX_RECORDS;
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('initialize', () => {
  it('creates data/ and seeds NO alert rules', async () => {
    /*
     * THIS TEST USED TO ASSERT THE OPPOSITE, and the opposite was the defect.
     *
     * initialize() created 'rule-spread-high' (SPREAD_ABOVE 2.0) and
     * 'rule-volatility-spike' (VOLATILITY_SPIKE 1.5), both enabled, on any
     * install that had no alerts.json. Together with the six-second evaluation
     * loop that is why a brand-new deployment started announcing market levels
     * on Telegram before the operator had configured anything at all.
     *
     * A rule now exists only because it was created through /api/alerts.
     */
    const StorageEngine = await freshStorage();
    StorageEngine.initialize();

    expect(fs.existsSync(path.join(tmpDir, 'data'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'data', 'market_history.json'))).toBe(true);

    expect(readJson<AlertRule[]>('alerts.json')).toEqual([]);
    expect(StorageEngine.getAlerts()).toEqual([]);
  });

  it('keeps rules an existing deployment already saved', async () => {
    // Removing the seeding must not touch anybody's stored rules.
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'alerts.json'),
      JSON.stringify([
        {
          id: 'mine',
          name: 'Mi regla',
          condition: 'ABOVE',
          targetValue: 930,
          targetSide: 'BUY',
          enabled: true,
          createdAt: 1,
        },
      ])
    );

    const StorageEngine = await freshStorage();
    StorageEngine.initialize();
    expect(StorageEngine.getAlerts().map((a) => a.id)).toEqual(['mine']);
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

  it('is idempotent - a second call does not resurrect a deleted rule', async () => {
    const StorageEngine = await freshStorage();
    StorageEngine.initialize();
    StorageEngine.saveAlert({
      id: 'a',
      name: 'A',
      condition: 'ABOVE',
      targetValue: 930,
      targetSide: 'BUY',
      enabled: true,
      createdAt: 1,
    });
    StorageEngine.saveAlert({
      id: 'b',
      name: 'B',
      condition: 'BELOW',
      targetValue: 900,
      targetSide: 'SELL',
      enabled: true,
      createdAt: 1,
    });
    StorageEngine.deleteAlert('a');
    StorageEngine.initialize();
    expect(StorageEngine.getAlerts().map((r) => r.id)).toEqual(['b']);
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
    /*
     * 601 records * 6s = 3600s = exactly 1 hour.
     *
     * Seeded through the file rather than 601 appendRecord calls. Each append
     * rewrites the whole history atomically, so 601 of them serialise ~56 MB
     * and issue 1202 fsyncs in order to assert something about an in-memory
     * array. That cost is the subject of the retention work, not of this test,
     * and on a slow CI runner it exceeded the 5s timeout while passing in
     * ~700ms locally. Seeding asserts exactly the same three values in ~13ms.
     */
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'market_history.json'),
      JSON.stringify(makeHistory(601)),
      'utf-8'
    );

    const StorageEngine = await freshStorage();
    StorageEngine.initialize();

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

describe('retention: the active window is bounded, history is never destroyed', () => {
  /*
   * Every append rewrites the whole file. Measured over 601 appends: 56.1 MB
   * serialised for a 191 KB file. Capping the active window bounds that cost;
   * archiving rather than deleting keeps REGLA 2 intact.
   */
  it('archives the overflow in batches instead of dropping it', async () => {
    /*
     * cap 10 -> batch 1 (a tenth, floored at 1). Archiving fires once the
     * window exceeds cap + batch, and each batch gets a file of its own that
     * is never reopened.
     */
    process.env.HISTORY_MAX_RECORDS = '10';
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(14)) StorageEngine.appendRecord(rec);

    expect(StorageEngine.getHistory().length).toBeLessThanOrEqual(11);

    const archiveDir = path.join(tmpDir, 'data', 'history_archive');
    const files = fs.readdirSync(archiveDir);
    expect(files.length).toBeGreaterThan(0);

    const archived = files.flatMap(
      (f) => JSON.parse(fs.readFileSync(path.join(archiveDir, f), 'utf-8')) as HistoryRecord[]
    );
    expect(archived.length + StorageEngine.getHistory().length).toBe(14);
  });

  it('never reopens an archive file - each batch is written once', async () => {
    /*
     * The first version of this read the archive and rewrote it on every
     * append past the cap, which merely moved the quadratic cost from one file
     * to the other: benchmarked at 2000 appends it was SLOWER than no
     * retention at all. Each batch now owns a file nothing ever writes twice.
     */
    process.env.HISTORY_MAX_RECORDS = '20';
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(60)) StorageEngine.appendRecord(rec);

    const archiveDir = path.join(tmpDir, 'data', 'history_archive');
    const files = fs.readdirSync(archiveDir);
    const sizes = files.map((f) => JSON.parse(
      fs.readFileSync(path.join(archiveDir, f), 'utf-8')
    ).length as number);

    // Every file holds exactly one batch: none grew by being reopened.
    expect(new Set(sizes)).toEqual(new Set([2]));
    expect(files.length).toBe(sizes.length);
  });

  it('loses no observation: archived + active == everything appended', async () => {
    process.env.HISTORY_MAX_RECORDS = '10';
    const StorageEngine = await freshStorage();
    const all = makeHistory(37);
    for (const rec of all) StorageEngine.appendRecord(rec);

    const active = StorageEngine.getHistory();
    const archiveDir = path.join(tmpDir, 'data', 'history_archive');
    const archived = fs
      .readdirSync(archiveDir)
      .flatMap(
        (f) => JSON.parse(fs.readFileSync(path.join(archiveDir, f), 'utf-8')) as HistoryRecord[]
      );

    expect(archived.length + active.length).toBe(37);
    const ids = new Set([...archived, ...active].map((r) => r.id));
    expect(ids.size).toBe(37);
    for (const rec of all) expect(ids.has(rec.id)).toBe(true);
  });

  it('keeps the NEWEST records in the active window', async () => {
    process.env.HISTORY_MAX_RECORDS = '5';
    const StorageEngine = await freshStorage();
    const all = makeHistory(12);
    for (const rec of all) StorageEngine.appendRecord(rec);

    const active = StorageEngine.getHistory();
    expect(active.map((r) => r.id)).toEqual(all.slice(-5).map((r) => r.id));
  });

  it('HISTORY_MAX_RECORDS=0 restores the previous unbounded behaviour', async () => {
    process.env.HISTORY_MAX_RECORDS = '0';
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(30)) StorageEngine.appendRecord(rec);

    expect(StorageEngine.getHistory()).toHaveLength(30);
    expect(fs.existsSync(path.join(tmpDir, 'data', 'history_archive'))).toBe(false);
  });

  it('does not archive at all below the cap', async () => {
    process.env.HISTORY_MAX_RECORDS = '100';
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(20)) StorageEngine.appendRecord(rec);

    expect(StorageEngine.getHistory()).toHaveLength(20);
    expect(fs.existsSync(path.join(tmpDir, 'data', 'history_archive'))).toBe(false);
  });

  it('reports the retention state in the diagnostics', async () => {
    process.env.HISTORY_MAX_RECORDS = '10';
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(13)) StorageEngine.appendRecord(rec);

    const d = StorageEngine.describeStorage();
    expect(d.maxActiveRecords).toBe(10);
    expect(d.archivedRecordCount).toBeGreaterThan(0);
    expect(d.archivedRecordCount + d.recordCount).toBe(13);
    expect(d.lastArchiveFile).toMatch(
      /history_archive[/\\]market_history-\d{4}-\d{2}-\d{2}T[\d-]+\.json$/
    );
  });

  it('writes the active history compactly, not pretty-printed', async () => {
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(3)) StorageEngine.appendRecord(rec);

    const raw = fs.readFileSync(path.join(tmpDir, 'data', 'market_history.json'), 'utf-8');
    expect(raw.startsWith('[{')).toBe(true);
    expect(raw).not.toContain('\n  ');
    // Still valid JSON with every record intact.
    expect(JSON.parse(raw)).toHaveLength(3);
  });

  it('still reads a pretty-printed file written before this change', async () => {
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'market_history.json'),
      JSON.stringify(makeHistory(4), null, 2),
      'utf-8'
    );

    const StorageEngine = await freshStorage();
    StorageEngine.initialize();
    expect(StorageEngine.getHistory()).toHaveLength(4);
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

    // A fresh install seeds no rules, so the count starts at zero.
    StorageEngine.saveAlert(rule);
    expect(StorageEngine.getAlerts()).toHaveLength(1);

    StorageEngine.saveAlert({ ...rule, targetValue: 999 });
    expect(StorageEngine.getAlerts()).toHaveLength(1);
    expect(readJson<AlertRule[]>('alerts.json').find((a) => a.id === 'custom-1')?.targetValue)
      .toBe(999);
  });

  it('deleteAlert returns false for an unknown id and does not rewrite', async () => {
    const StorageEngine = await freshStorage();
    StorageEngine.saveAlert({
      id: 'mine',
      name: 'Mi regla',
      condition: 'ABOVE',
      targetValue: 930,
      targetSide: 'BUY',
      enabled: true,
      createdAt: 1,
    });

    expect(StorageEngine.deleteAlert('does-not-exist')).toBe(false);
    expect(StorageEngine.deleteAlert('mine')).toBe(true);
    expect(readJson<AlertRule[]>('alerts.json')).toHaveLength(0);
  });

  it('BUG: getAlerts hands out the internal array by reference', async () => {
    // Audit B18: callers mutate stored rules directly, bypassing saveAlert.
    const StorageEngine = await freshStorage();
    StorageEngine.saveAlert({
      id: 'mine',
      name: 'Mi regla',
      condition: 'ABOVE',
      targetValue: 930,
      targetSide: 'BUY',
      enabled: true,
      createdAt: 1,
    });

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
    /*
     * CONTRACT CHANGE: three retention fields added.
     *
     * The purpose of this assertion is unchanged and is the reason it pins the
     * exact key list: describeStorage is served publicly on /api/health, so
     * every field has to be a deliberate decision rather than an accident.
     *
     * maxActiveRecords is a configured number, archivedRecordCount a count,
     * and lastArchiveFile a path under dataDir - which this same payload
     * already publishes. No new class of information is exposed.
     */
    expect(Object.keys(StorageEngine.describeStorage()).sort()).toEqual([
      'archivedRecordCount', 'dataDir', 'exists', 'historyFile', 'lastArchiveFile',
      'maxActiveRecords', 'newestTimestamp', 'oldestTimestamp',
      'recordCount', 'strategicRecordCount', 'writable',
    ]);
    delete process.env.TELEGRAM_BOT_TOKEN;
  });
});
