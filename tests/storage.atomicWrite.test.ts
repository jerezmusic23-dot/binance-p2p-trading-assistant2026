/**
 * PHASE 4 - atomic write guarantees for server/storage.ts
 *
 * These are NOT characterization tests: they assert the behaviour we now
 * require. A failure here means the history can be destroyed by an
 * interrupted write.
 *
 * Failures are injected by spying on the `fs` builtin, because the container
 * runs as root and permission-based failures would be bypassed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'node:os';
import path from 'node:path';
import { makeHistory } from './helpers/fixtures.js';
import type { AlertRule, AlertTriggerLog, HistoryRecord } from '../server/types.js';

const originalCwd = process.cwd();
let tmpDir: string;
let dataDir: string;

async function freshStorage() {
  vi.resetModules();
  const { StorageEngine } = await import('../server/storage.js');
  return StorageEngine;
}

const historyFile = () => path.join(dataDir, 'market_history.json');
const alertsFile = () => path.join(dataDir, 'alerts.json');
const triggersFile = () => path.join(dataDir, 'alert_triggers.json');

const readText = (file: string) => fs.readFileSync(file, 'utf-8');
const tempFiles = () => fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'));

const sampleTrigger = (n: number): AlertTriggerLog => ({
  id: `trigger-${n}`,
  ruleId: 'rule-spread-high',
  ruleName: 'Spread Mayor a 2.0%',
  message: `msg ${n}`,
  price: 918 + n,
  timestamp: 1_756_000_000_000 + n,
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-atomic-'));
  dataDir = path.join(tmpDir, 'data');
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('A/B - a normal write lands correctly', () => {
  it('writes exactly the expected JSON, byte for byte', async () => {
    /*
     * CONTRACT CHANGE: compact, no longer JSON.stringify(records, null, 2).
     *
     * The intent of this test is unchanged - the file must be exactly the
     * records and nothing else. What changed is the formatting: this file is
     * machine-written every 60s and rewritten in full each time, and the
     * indentation cost 21% of every byte for the benefit of no reader.
     * A separate test covers that a pretty-printed file written before this
     * change still loads.
     */
    const StorageEngine = await freshStorage();
    const records = makeHistory(3, { drift: 0.5 });
    for (const rec of records) StorageEngine.appendRecord(rec);

    expect(fs.existsSync(historyFile())).toBe(true);
    expect(readText(historyFile())).toBe(JSON.stringify(records));
  });

  it('leaves no temp file behind after a successful write', async () => {
    const StorageEngine = await freshStorage();
    StorageEngine.appendRecord(makeHistory(1)[0]);
    expect(tempFiles()).toEqual([]);
  });

  it('creates the temp file in the SAME directory as the target', async () => {
    // Required for rename(2) to be atomic: a cross-filesystem rename is a
    // copy+unlink and loses the guarantee.
    const StorageEngine = await freshStorage();
    const openSpy = vi.spyOn(fs, 'openSync');
    StorageEngine.appendRecord(makeHistory(1)[0]);

    const tempOpens = openSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((p) => p.endsWith('.tmp'));
    expect(tempOpens.length).toBeGreaterThan(0);
    for (const p of tempOpens) expect(path.dirname(p)).toBe(dataDir);
  });

  it('fsyncs the temp descriptor before renaming', async () => {
    const StorageEngine = await freshStorage();
    const order: string[] = [];
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      order.push('fsync');
    });
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      order.push('rename');
    });

    StorageEngine.appendRecord(makeHistory(1)[0]);
    expect(order.indexOf('fsync')).toBeLessThan(order.indexOf('rename'));
  });
});

describe('C - a subsequent write replaces the previous content', () => {
  it('replaces the file wholesale, with no leftovers of the old content', async () => {
    const StorageEngine = await freshStorage();
    StorageEngine.appendRecord(makeHistory(1)[0]);
    const first = readText(historyFile());

    for (const rec of makeHistory(5, { startTs: 1_756_000_100_000, drift: 2 })) {
      StorageEngine.appendRecord(rec);
    }
    const second = readText(historyFile());

    expect(second).not.toBe(first);
    expect(JSON.parse(second) as HistoryRecord[]).toHaveLength(6);
    expect(tempFiles()).toEqual([]);
  });
});

describe('D - a failure while writing the temp file preserves the target', () => {
  it('keeps the previous history byte-for-byte when writeFileSync throws', async () => {
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(4)) StorageEngine.appendRecord(rec);
    const before = readText(historyFile());

    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    StorageEngine.appendRecord(makeHistory(1, { startTs: 1_900_000_000_000 })[0]);

    expect(readText(historyFile())).toBe(before);
    expect(JSON.parse(readText(historyFile())) as HistoryRecord[]).toHaveLength(4);
  });

  it('keeps the target when the temp file cannot even be opened', async () => {
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(4)) StorageEngine.appendRecord(rec);
    const before = readText(historyFile());

    vi.spyOn(fs, 'openSync').mockImplementation((p: fs.PathLike) => {
      throw new Error(`EACCES: permission denied, open '${String(p)}'`);
    });
    StorageEngine.appendRecord(makeHistory(1, { startTs: 1_900_000_000_000 })[0]);

    expect(readText(historyFile())).toBe(before);
  });

  it('does not throw out of the public API on a write failure', async () => {
    const StorageEngine = await freshStorage();
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk on fire');
    });
    expect(() => StorageEngine.appendRecord(makeHistory(1)[0])).not.toThrow();
  });
});

describe('E - a failure after the write but before the rename preserves the target', () => {
  it('keeps the previous history when fsync fails', async () => {
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(4)) StorageEngine.appendRecord(rec);
    const before = readText(historyFile());

    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw new Error('EIO: i/o error');
    });
    StorageEngine.appendRecord(makeHistory(1, { startTs: 1_900_000_000_000 })[0]);

    expect(readText(historyFile())).toBe(before);
  });

  it('keeps the previous history when the rename itself fails', async () => {
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(4)) StorageEngine.appendRecord(rec);
    const before = readText(historyFile());

    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EXDEV: cross-device link not permitted');
    });
    StorageEngine.appendRecord(makeHistory(1, { startTs: 1_900_000_000_000 })[0]);

    expect(readText(historyFile())).toBe(before);
  });

  it('recovers on the next successful write', async () => {
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(4)) StorageEngine.appendRecord(rec);

    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EIO');
    });
    StorageEngine.appendRecord(makeHistory(1, { startTs: 1_900_000_000_000 })[0]);
    expect(JSON.parse(readText(historyFile())) as HistoryRecord[]).toHaveLength(4);

    renameSpy.mockRestore();
    StorageEngine.appendRecord(makeHistory(1, { startTs: 1_900_000_100_000 })[0]);
    // Both appends are in memory; the successful write flushes all 6.
    expect(JSON.parse(readText(historyFile())) as HistoryRecord[]).toHaveLength(6);
  });
});

describe('F - a temp file never substitutes for the target', () => {
  it('removes the temp file when the operation fails', async () => {
    const StorageEngine = await freshStorage();
    StorageEngine.appendRecord(makeHistory(1)[0]);

    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EIO');
    });
    StorageEngine.appendRecord(makeHistory(1, { startTs: 1_900_000_000_000 })[0]);

    expect(tempFiles()).toEqual([]);
  });

  it('never leaves the target absent or unparseable after a failure', async () => {
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(3)) StorageEngine.appendRecord(rec);

    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    StorageEngine.appendRecord(makeHistory(1, { startTs: 1_900_000_000_000 })[0]);

    expect(fs.existsSync(historyFile())).toBe(true);
    expect(() => JSON.parse(readText(historyFile()))).not.toThrow();
  });
});

describe('G - all three managed files use the safe mechanism', () => {
  it('routes history, alerts and triggers through a rename', async () => {
    const StorageEngine = await freshStorage();
    const renameSpy = vi.spyOn(fs, 'renameSync');

    StorageEngine.appendRecord(makeHistory(1)[0]);
    StorageEngine.saveAlert({
      id: 'custom-1',
      name: 'Test',
      condition: 'ABOVE',
      targetValue: 950,
      targetSide: 'SELL',
      enabled: true,
      createdAt: 1,
    } satisfies AlertRule);
    StorageEngine.logTrigger(sampleTrigger(1));

    const targets = new Set(renameSpy.mock.calls.map((c) => String(c[1])));
    expect(targets.has(historyFile())).toBe(true);
    expect(targets.has(alertsFile())).toBe(true);
    expect(targets.has(triggersFile())).toBe(true);
  });

  it('preserves alerts.json when its write fails', async () => {
    const StorageEngine = await freshStorage();
    StorageEngine.initialize();
    // A fresh install seeds nothing, so the rules to protect are created here,
    // exactly as /api/alerts would create them.
    for (const id of ['uno', 'dos']) {
      StorageEngine.saveAlert({
        id,
        name: id,
        condition: 'ABOVE',
        targetValue: 930,
        targetSide: 'BUY',
        enabled: true,
        createdAt: 1,
      });
    }
    const before = readText(alertsFile());

    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EIO');
    });
    StorageEngine.deleteAlert('uno');

    expect(readText(alertsFile())).toBe(before);
    expect(JSON.parse(readText(alertsFile())) as AlertRule[]).toHaveLength(2);
  });

  it('preserves alert_triggers.json when its write fails', async () => {
    const StorageEngine = await freshStorage();
    StorageEngine.logTrigger(sampleTrigger(1));
    const before = readText(triggersFile());

    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('EIO');
    });
    StorageEngine.logTrigger(sampleTrigger(2));

    expect(readText(triggersFile())).toBe(before);
    expect(JSON.parse(readText(triggersFile())) as AlertTriggerLog[]).toHaveLength(1);
  });
});

describe('quarantine - an unparseable file is never silently destroyed', () => {
  it('preserves a copy of a corrupt history before starting empty', async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    const damaged = '[{"id":"tick-1","timestamp":1,"buyPri';
    fs.writeFileSync(historyFile(), damaged, 'utf-8');

    const StorageEngine = await freshStorage();
    expect(StorageEngine.getHistory()).toEqual([]);

    const sidecars = fs.readdirSync(dataDir).filter((f) => f.includes('.corrupt-'));
    expect(sidecars).toHaveLength(1);
    expect(readText(path.join(dataDir, sidecars[0]))).toBe(damaged);
  });

  it('keeps the damaged original on disk until a write actually replaces it', async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    const damaged = '[{"id":"tick-1"';
    fs.writeFileSync(historyFile(), damaged, 'utf-8');

    const StorageEngine = await freshStorage();
    StorageEngine.initialize();
    expect(readText(historyFile())).toBe(damaged); // untouched by initialize

    StorageEngine.appendRecord(makeHistory(1)[0]); // now, and only now, replaced
    expect(JSON.parse(readText(historyFile())) as HistoryRecord[]).toHaveLength(1);
    expect(fs.readdirSync(dataDir).filter((f) => f.includes('.corrupt-'))).toHaveLength(1);
  });

  it('quarantines a corrupt alerts file too', async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(alertsFile(), '{oops', 'utf-8');

    const StorageEngine = await freshStorage();
    StorageEngine.initialize();
    expect(StorageEngine.getAlerts()).toEqual([]);
    expect(
      fs.readdirSync(dataDir).filter((f) => f.startsWith('alerts.json.corrupt-'))
    ).toHaveLength(1);
  });
});
