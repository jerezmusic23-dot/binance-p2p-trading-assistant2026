/**
 * THE SERIES ON DISK.
 *
 * Two properties matter more than anything else here: a cell's series is its
 * own and never mixes with another's, and a process killed mid-write costs at
 * most the observation it was writing.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoricalMarketStore } from '../server/historicalMarketStore.js';
import { observation } from './helpers/series.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-cells-'));
  HistoricalMarketStore.configure(dir);
});

afterEach(() => {
  HistoricalMarketStore.resetCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

const obs = (over: Parameters<typeof observation>[0]) => observation(over);

describe('14 - múltiples bancos y 15 - múltiples montos stay isolated', () => {
  it('writes one file per cell and never mixes two', () => {
    HistoricalMarketStore.record(
      obs({ timestamp: 1000, bank: 'VENEZUELA', amountKey: '10K', buyRecommendedPrice: 940 }),
      1000
    );
    HistoricalMarketStore.record(
      obs({ timestamp: 1000, bank: 'VENEZUELA', amountKey: '50K', buyRecommendedPrice: 950 }),
      1000
    );
    HistoricalMarketStore.record(
      obs({ timestamp: 1000, bank: 'BANESCO', amountKey: '10K', buyRecommendedPrice: 960 }),
      1000
    );

    expect(HistoricalMarketStore.load('VENEZUELA', '10K').map((o) => o.buyRecommendedPrice)).toEqual([940]);
    expect(HistoricalMarketStore.load('VENEZUELA', '50K').map((o) => o.buyRecommendedPrice)).toEqual([950]);
    expect(HistoricalMarketStore.load('BANESCO', '10K').map((o) => o.buyRecommendedPrice)).toEqual([960]);
  });

  it('lists every cell that has a series', () => {
    HistoricalMarketStore.record(obs({ timestamp: 1, bank: 'VENEZUELA', amountKey: '10K' }), 1);
    HistoricalMarketStore.record(obs({ timestamp: 1, bank: 'BANESCO', amountKey: '20K' }), 1);

    const cells = HistoricalMarketStore.listCells().sort((a, b) => a.bank.localeCompare(b.bank));
    expect(cells).toEqual([
      { bank: 'BANESCO', amountKey: '20K' },
      { bank: 'VENEZUELA', amountKey: '10K' },
    ]);
  });
});

describe('BUG: the same capture must never be stored twice', () => {
  it('refuses a repeat of a capturedAt already recorded', () => {
    const first = HistoricalMarketStore.record(obs({ timestamp: 1000 }), 1000);
    const second = HistoricalMarketStore.record(obs({ timestamp: 1000 }), 1000);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(HistoricalMarketStore.load('VENEZUELA', '10K')).toHaveLength(1);
  });

  it('accepts the next real capture', () => {
    HistoricalMarketStore.record(obs({ timestamp: 1000 }), 1000);
    expect(HistoricalMarketStore.record(obs({ timestamp: 2000 }), 2000)).toBe(true);
    expect(HistoricalMarketStore.load('VENEZUELA', '10K')).toHaveLength(2);
  });
});

describe('deltas against the previous observation', () => {
  it('computes the signed change, and leaves the first one null', () => {
    HistoricalMarketStore.record(obs({ timestamp: 1000, buyRecommendedPrice: 940 }), 1000);
    HistoricalMarketStore.record(obs({ timestamp: 2000, buyRecommendedPrice: 941.5 }), 2000);
    HistoricalMarketStore.record(obs({ timestamp: 3000, buyRecommendedPrice: 940.5 }), 3000);

    const series = HistoricalMarketStore.load('VENEZUELA', '10K');
    expect(series[0].buySpreadVsPrevious).toBeNull();
    expect(series[1].buySpreadVsPrevious).toBe(1.5);
    // A fall keeps its sign.
    expect(series[2].buySpreadVsPrevious).toBe(-1);
  });

  it('leaves the delta null rather than treating a missing price as zero', () => {
    HistoricalMarketStore.record(obs({ timestamp: 1000, buyRecommendedPrice: null }), 1000);
    HistoricalMarketStore.record(obs({ timestamp: 2000, buyRecommendedPrice: 940 }), 2000);

    expect(HistoricalMarketStore.load('VENEZUELA', '10K')[1].buySpreadVsPrevious).toBeNull();
  });
});

describe('13 - reinicio', () => {
  it('reads the series back after the process forgets everything', () => {
    HistoricalMarketStore.record(obs({ timestamp: 1000, buyRecommendedPrice: 940 }), 1000);
    HistoricalMarketStore.record(obs({ timestamp: 2000, buyRecommendedPrice: 941 }), 2000);

    // A restart: caches gone, disk untouched.
    HistoricalMarketStore.resetCache();
    HistoricalMarketStore.configure(dir);

    const series = HistoricalMarketStore.load('VENEZUELA', '10K');
    expect(series.map((o) => o.buyRecommendedPrice)).toEqual([940, 941]);
  });

  it('keeps appending to the existing series rather than starting a new one', () => {
    HistoricalMarketStore.record(obs({ timestamp: 1000, buyRecommendedPrice: 940 }), 1000);
    HistoricalMarketStore.resetCache();
    HistoricalMarketStore.configure(dir);
    HistoricalMarketStore.record(obs({ timestamp: 2000, buyRecommendedPrice: 941 }), 2000);

    expect(HistoricalMarketStore.load('VENEZUELA', '10K')).toHaveLength(2);
  });
});

describe('12 - datos irregulares: a torn write costs one observation, not the series', () => {
  it('skips a malformed final line and reads everything before it', () => {
    HistoricalMarketStore.record(obs({ timestamp: 1000, buyRecommendedPrice: 940 }), 1000);
    HistoricalMarketStore.record(obs({ timestamp: 2000, buyRecommendedPrice: 941 }), 2000);

    // Simulate a process killed halfway through writing the third line.
    const file = path.join(dir, 'VENEZUELA__10K.ndjson');
    fs.appendFileSync(file, '{"timestamp":3000,"bank":"VENEZ');

    HistoricalMarketStore.resetCache();
    HistoricalMarketStore.configure(dir);

    const series = HistoricalMarketStore.load('VENEZUELA', '10K');
    expect(series).toHaveLength(2);
    expect(series.map((o) => o.buyRecommendedPrice)).toEqual([940, 941]);
  });
});

describe('describe() states what the series contains, so nothing is assumed', () => {
  it('reports zero and nulls for a cell that has never been written', () => {
    expect(HistoricalMarketStore.describe('MERCANTIL', '30K')).toEqual({
      observations: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      medianIntervalMs: null,
      usableObservations: 0,
    });
  });

  it('measures the real cadence instead of assuming the sweep interval', () => {
    for (let i = 0; i < 5; i += 1) {
      HistoricalMarketStore.record(obs({ timestamp: 1000 + i * 270_000 }), 1000 + i * 270_000);
    }
    const described = HistoricalMarketStore.describe('VENEZUELA', '10K');
    expect(described.observations).toBe(5);
    expect(described.medianIntervalMs).toBe(270_000);
    expect(described.usableObservations).toBe(5);
  });

  it('counts usable observations apart from total ones', () => {
    HistoricalMarketStore.record(obs({ timestamp: 1000, buyRecommendedPrice: 940 }), 1000);
    HistoricalMarketStore.record(
      obs({ timestamp: 2000, buyRecommendedPrice: null, sellRecommendedPrice: null }),
      2000
    );

    const described = HistoricalMarketStore.describe('VENEZUELA', '10K');
    expect(described.observations).toBe(2);
    expect(described.usableObservations).toBe(1);
  });
});

describe('rotation never deletes', () => {
  it('moves the overflow to an archive file and keeps reading the live one', () => {
    HistoricalMarketStore.configure(dir, 10);
    for (let i = 0; i < 14; i += 1) {
      HistoricalMarketStore.record(obs({ timestamp: 1000 + i, buyRecommendedPrice: 940 + i }), 1000 + i);
    }

    const live = HistoricalMarketStore.load('VENEZUELA', '10K');
    expect(live.length).toBeLessThanOrEqual(10);

    const archiveDir = path.join(dir, 'archive');
    expect(fs.existsSync(archiveDir)).toBe(true);
    const archived = fs
      .readdirSync(archiveDir)
      .flatMap((f) => fs.readFileSync(path.join(archiveDir, f), 'utf8').trim().split('\n'))
      .map((line) => JSON.parse(line).buyRecommendedPrice);

    // Nothing was lost: archived + live covers every observation written.
    expect(new Set([...archived, ...live.map((o) => o.buyRecommendedPrice)]).size).toBe(14);
  });
});
