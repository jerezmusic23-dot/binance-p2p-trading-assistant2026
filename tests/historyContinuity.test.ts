/**
 * THE ELEVEN MISSING HOURS
 *
 * Production reported: "11 de las 13 horas pasadas no tienen ningún tick
 * capturado. Sólo 2 horas corresponden a observaciones reales."
 *
 * No tick was lost. The chart draws a fixed thirteen-hour Venezuelan session
 * bucketed by hour-of-day, and it was being handed the 100-record statistical
 * window - 99 minutes at one record per minute, which can fill at most two of
 * those thirteen buckets. The records were on disk the whole time.
 *
 * These tests pin the arithmetic that produces the symptom, the fix, and the
 * persistence guarantees around it. All fixtures are SYNTHETIC.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectionEngine } from '../server/projectionEngine.js';
import { BacktestEngine } from '../server/backtestEngine.js';
import { makeHistory } from './helpers/fixtures.js';
import type { HistoryRecord } from '../server/types.js';

type StorageModule = typeof import('../server/storage.js');

const originalCwd = process.cwd();
let tmpDir: string;

async function freshStorage(): Promise<StorageModule['StorageEngine']> {
  vi.resetModules();
  const { StorageEngine } = (await import('../server/storage.js')) as StorageModule;
  return StorageEngine;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-continuity-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  delete process.env.HISTORY_MAX_RECORDS;
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Records one minute apart, ending at `endTs`. */
function minutes(n: number, endTs: number): HistoryRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const ts = endTs - (n - 1 - i) * 60_000;
    return {
      id: `tick-${ts}`,
      timestamp: ts,
      dateStr: new Date(ts).toISOString(),
      hour: ProjectionEngine.getVenezuelaHour(ts),
      buyPrice: 945.75,
      sellPrice: 944.75,
      spreadPct: -0.11,
      bestBuyMerchant: 'M1',
      bestSellMerchant: 'M2',
      activeBuyAds: 20,
      activeSellAds: 20,
      source: 'BINANCE_P2P',
    } as HistoryRecord;
  });
}

// 21:00 VET, so the session chart has all thirteen past hours behind it.
const NOW = Date.UTC(2026, 7, 28, 1, 0, 0);

function timelineFor(history: HistoryRecord[]) {
  const snapshot = BacktestEngine.reconstructSnapshot(history[history.length - 1]);
  const stats = history.slice(-100);
  const analysis = ProjectionEngine.analyzeMarket(snapshot, stats);
  const projections = ProjectionEngine.generateProjections(
    snapshot,
    stats,
    analysis,
    NOW,
    history
  );
  const past = projections.hourlyTimeline.filter((p) => !p.isProjected);
  return {
    past: past.length,
    empty: past.filter((p) => p.buyPrice === null).length,
    filled: past.filter((p) => p.buyPrice !== null).length,
  };
}

describe('the reported symptom, reproduced exactly', () => {
  it('100 records over 99 minutes leave 11 of 13 hours empty', () => {
    /*
     * The old call path: generateProjections received the 100-record window
     * and used it for the timeline too. Passing that same window as the
     * timeline source reproduces production verbatim.
     */
    const history = minutes(100, NOW);
    const snapshot = BacktestEngine.reconstructSnapshot(history[history.length - 1]);
    const analysis = ProjectionEngine.analyzeMarket(snapshot, history);
    const projections = ProjectionEngine.generateProjections(snapshot, history, analysis, NOW);

    const past = projections.hourlyTimeline.filter((p) => !p.isProjected);
    const empty = past.filter((p) => p.buyPrice === null);

    expect(past).toHaveLength(13);
    expect(empty).toHaveLength(11);
    expect(past.length - empty.length).toBe(2);
  });

  it('the gap is a window problem: the same records over a day fill the chart', () => {
    // 24 hours of ticks, one per minute. Same data rate, wider window.
    const result = timelineFor(minutes(24 * 60, NOW));

    expect(result.past).toBe(13);
    expect(result.empty).toBe(0);
    expect(result.filled).toBe(13);
  });

  it('a real gap still reads as a gap - nothing is invented to fill it', () => {
    /*
     * Only the last three hours were captured. The earlier buckets must stay
     * null: an absent observation is never replaced by a session curve.
     */
    const result = timelineFor(minutes(3 * 60, NOW));

    expect(result.past).toBe(13);
    expect(result.empty).toBeGreaterThan(0);
    expect(result.filled).toBeGreaterThan(0);
    expect(result.filled).toBeLessThanOrEqual(4);
  });

  it('the statistical window is untouched by the wider timeline', () => {
    const history = minutes(24 * 60, NOW);
    const snapshot = BacktestEngine.reconstructSnapshot(history[history.length - 1]);
    const stats = history.slice(-100);

    const analysis = ProjectionEngine.analyzeMarket(snapshot, stats);
    const withWideTimeline = ProjectionEngine.generateProjections(
      snapshot,
      stats,
      analysis,
      NOW,
      history
    );
    const withoutTimelineArg = ProjectionEngine.generateProjections(
      snapshot,
      stats,
      analysis,
      NOW
    );

    // Everything statistical is identical; only the timeline differs.
    expect(withWideTimeline.daily).toEqual(withoutTimelineArg.daily);
    expect(withWideTimeline.probabilities).toEqual(withoutTimelineArg.probabilities);
    expect(withWideTimeline.intradayHorizons).toEqual(withoutTimelineArg.intradayHorizons);
    expect(withWideTimeline.dataWindow).toEqual(withoutTimelineArg.dataWindow);
    expect(withWideTimeline.hourlyTimeline).not.toEqual(withoutTimelineArg.hourlyTimeline);
  });
});

describe('history survives archiving and a restart', () => {
  it('the summary knows the range of archive + active, not just active', async () => {
    process.env.HISTORY_MAX_RECORDS = '10';
    const StorageEngine = await freshStorage();

    const all = makeHistory(60);
    for (const rec of all) StorageEngine.appendRecord(rec);

    const summary = StorageEngine.getHistorySummary();
    const active = StorageEngine.getHistory();

    // The active window is bounded; the summary is not.
    expect(active.length).toBeLessThanOrEqual(11);
    expect(summary.totalRecords).toBe(60);
    expect(summary.oldestTimestamp).toBe(all[0].timestamp);
    expect(summary.newestTimestamp).toBe(all[all.length - 1].timestamp);
  });

  it('the range survives a restart, rebuilt from the archive on disk', async () => {
    process.env.HISTORY_MAX_RECORDS = '10';
    const first = await freshStorage();
    const all = makeHistory(60);
    for (const rec of all) first.appendRecord(rec);

    // A fresh module instance: nothing carries over in memory.
    const restarted = await freshStorage();
    const summary = restarted.getHistorySummary();

    expect(summary.totalRecords).toBe(60);
    expect(summary.oldestTimestamp).toBe(all[0].timestamp);
  });

  it('indexes the archive without retaining its records', async () => {
    process.env.HISTORY_MAX_RECORDS = '10';
    const first = await freshStorage();
    for (const rec of makeHistory(60)) first.appendRecord(rec);

    const restarted = await freshStorage();
    const archive = restarted.describeArchive();

    expect(archive.fileCount).toBeGreaterThan(0);
    expect(archive.recordCount).toBe(60 - restarted.getHistory().length);
    // getHistory serves the ACTIVE window only; the archive is not in RAM.
    expect(restarted.getHistory().length).toBeLessThanOrEqual(11);
  });

  it('an unreadable archive file is skipped, not fatal, and not silent', async () => {
    process.env.HISTORY_MAX_RECORDS = '10';
    const first = await freshStorage();
    for (const rec of makeHistory(60)) first.appendRecord(rec);

    const archiveDir = path.join(tmpDir, 'data', 'history_archive');
    const files = fs.readdirSync(archiveDir);
    fs.writeFileSync(path.join(archiveDir, files[0]), '[{"timestamp":1,"buy', 'utf-8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restarted = await freshStorage();
    const archive = restarted.describeArchive();

    // It still starts, still indexes the rest, and says which file it skipped.
    expect(archive.fileCount).toBe(files.length - 1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
    warn.mockRestore();
  });
});

describe('persistence has no silent losses', () => {
  it('a write failure is reported, never swallowed', async () => {
    const StorageEngine = await freshStorage();
    StorageEngine.appendRecord(makeHistory(1)[0]);

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw new Error('EROFS: read-only file system');
    });

    StorageEngine.appendRecord(makeHistory(1, { startTs: 2_000_000_000_000 })[0]);

    expect(error).toHaveBeenCalled();
    openSpy.mockRestore();
    error.mockRestore();
  });

  it('a record rejected by the write still lives in memory, not dropped', async () => {
    const StorageEngine = await freshStorage();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw new Error('ENOSPC');
    });

    StorageEngine.appendRecord(makeHistory(1)[0]);

    // The array holds it; only the disk write failed.
    expect(StorageEngine.getHistory()).toHaveLength(1);
    openSpy.mockRestore();
    error.mockRestore();
  });

  it('never fabricates a price for a record it did not receive', async () => {
    const StorageEngine = await freshStorage();
    for (const rec of makeHistory(5)) StorageEngine.appendRecord(rec);

    const history = StorageEngine.getHistory();
    expect(history).toHaveLength(5);
    for (const rec of history) {
      expect(rec.buyPrice).toBeGreaterThan(0);
      expect(rec.sellPrice).toBeGreaterThan(0);
    }
  });
});
