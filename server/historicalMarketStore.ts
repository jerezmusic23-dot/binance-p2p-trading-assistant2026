/**
 * THE SERIES: one time series per BANCO x MONTO, and never one shared between
 * two of them.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The global history answers "where was the market" - one median per minute
 * across every bank and every amount. A projection for Banco de Venezuela at
 * 10K cannot be built from it: that cell has its own leaders, its own
 * competitors and its own liquidity, and mixing it with Banesco at 100K would
 * produce a number describing neither. So each cell gets its own file and its
 * own series, and nothing is ever derived across cells.
 *
 * WHY APPEND-ONLY, AND NOT THE EXISTING STORAGE ENGINE
 *
 * StorageEngine.appendRecord rewrites the WHOLE history file on every append -
 * 43,200 records serialised to add one. That cost was already measured once in
 * this project (301x write amplification) and bounded with archiving. Doing the
 * same for 42 cells would multiply it by 42.
 *
 * A time series is the one shape that does not need rewriting: observations
 * only ever arrive at the end. So each cell is an NDJSON journal, one line per
 * observation, appended in O(1) and fsynced. Nothing is ever rewritten, and a
 * torn final line from a crash costs exactly that one observation - the rest of
 * the series parses.
 *
 * WHAT IS NEVER WRITTEN HERE
 *
 * No gap is ever filled. No observation is ever interpolated, carried forward,
 * or synthesised from a neighbouring cell or amount. If capture missed 40
 * minutes, the series has a 40-minute hole and every consumer can see it.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * One observation of one cell at one moment.
 *
 * Every field is either something Binance published, something the maker
 * engine derived from what Binance published, or null. There is no third
 * category, and null never stands for zero.
 */
export interface HistoricalObservation {
  timestamp: number;
  bank: string;
  amountKey: string;
  amountVes: number;

  /** Best competing BUYER's price - the tradeType=SELL listing. */
  buyLeaderPrice: number | null;
  /** What I should publish to buy. null when the tick was not observable. */
  buyRecommendedPrice: number | null;

  /** Best competing SELLER's price - the tradeType=BUY listing. */
  sellLeaderPrice: number | null;
  sellRecommendedPrice: number | null;

  /**
   * Change against the PREVIOUS observation of THIS cell, in VES. Signed.
   * null on the first observation, and whenever either end is unknown -
   * a delta against a missing price is not zero.
   */
  buySpreadVsPrevious: number | null;
  sellSpreadVsPrevious: number | null;

  /** MARGEN BRUTO between my two recommended prices. Signed. */
  grossSpreadVes: number | null;
  grossSpreadPct: number | null;

  buyPosition: number | null;
  sellPosition: number | null;

  /** Volume queued ahead of my recommended price. null when unverifiable. */
  buyAvailableUsdt: number | null;
  sellAvailableUsdt: number | null;

  buyCompetitorCount: number;
  sellCompetitorCount: number;

  /** The cell status the maker matrix assigned at capture time. */
  marketStatus: string;

  /** The observed price step, and whether it was observed at all. */
  tick: number | null;
  tickProvenance: 'OBSERVED' | 'NOT_VERIFIABLE';

  /** The ads the two recommendations were derived from. */
  provenance: ObservationProvenance | null;
}

/** The real ad behind each side of a recommendation, for later audit. */
export interface ObservationProvenance {
  buy: AdProvenance | null;
  sell: AdProvenance | null;
  capturedAt: number;
}

export interface AdProvenance {
  advNo: string;
  merchant: string;
  price: number;
  /** The Binance listing this ad was read from. */
  tradeType: 'BUY' | 'SELL';
}

/** How many observations a live cell file keeps before rotating. */
export const DEFAULT_MAX_LINES_PER_CELL = 20_000;

/** A cell's identity as a filename. Uppercased and stripped, never guessed. */
export function cellFileName(bank: string, amountKey: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${safe(bank)}__${safe(amountKey)}.ndjson`;
}

export class HistoricalMarketStore {
  private static dataDir: string | null = null;
  private static maxLines = DEFAULT_MAX_LINES_PER_CELL;

  /** In-memory tail per cell, so a read does not touch disk every time. */
  private static cache = new Map<string, HistoricalObservation[]>();

  /**
   * capturedAt of the last observation written per cell.
   *
   * The sweep rotates one amount tier per tick, so most cells are unchanged on
   * most ticks. Writing them anyway would fill the series with duplicates of
   * one capture and make every velocity read as zero.
   */
  private static lastCapturedAt = new Map<string, number>();

  public static configure(dataDir: string, maxLines = DEFAULT_MAX_LINES_PER_CELL): void {
    this.dataDir = dataDir;
    this.maxLines = maxLines;
    this.cache.clear();
    this.lastCapturedAt.clear();
  }

  /** Resolved lazily so DATA_DIR is read at the same moment StorageEngine reads it. */
  private static resolveDir(): string {
    if (this.dataDir !== null) return this.dataDir;
    const configured = process.env.DATA_DIR?.trim();
    const base = configured ? path.resolve(configured) : path.join(process.cwd(), 'data');
    this.dataDir = path.join(base, 'cells');
    return this.dataDir;
  }

  private static filePath(bank: string, amountKey: string): string {
    return path.join(this.resolveDir(), cellFileName(bank, amountKey));
  }

  private static key(bank: string, amountKey: string): string {
    return `${bank}:${amountKey}`;
  }

  /**
   * Appends one observation, unless this cell's book has not moved.
   *
   * Returns whether anything was written, so the caller can report honestly
   * how much of a sweep actually produced new data.
   */
  public static record(
    observation: HistoricalObservation,
    capturedAt: number
  ): boolean {
    const key = this.key(observation.bank, observation.amountKey);

    // Same capture, already stored: a duplicate would be a fabricated sample.
    if (this.lastCapturedAt.get(key) === capturedAt) return false;

    const series = this.load(observation.bank, observation.amountKey);
    const previous = series.length > 0 ? series[series.length - 1] : null;

    const withDeltas: HistoricalObservation = {
      ...observation,
      buySpreadVsPrevious: delta(observation.buyRecommendedPrice, previous?.buyRecommendedPrice),
      sellSpreadVsPrevious: delta(observation.sellRecommendedPrice, previous?.sellRecommendedPrice),
    };

    try {
      this.appendLine(observation.bank, observation.amountKey, withDeltas);
    } catch (err) {
      console.error(
        `[HistoricalStore] No se pudo escribir ${observation.bank}/${observation.amountKey}:`,
        err
      );
      return false;
    }

    series.push(withDeltas);
    this.lastCapturedAt.set(key, capturedAt);
    this.rotateIfNeeded(observation.bank, observation.amountKey, series);
    return true;
  }

  /**
   * One line, appended and flushed to disk.
   *
   * open('a') -> write -> fsync -> close. The fsync is what makes the series
   * survive a container being killed, which on a hosted deploy is the normal
   * way a process ends rather than an exceptional one.
   */
  private static appendLine(
    bank: string,
    amountKey: string,
    observation: HistoricalObservation
  ): void {
    const dir = this.resolveDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const file = this.filePath(bank, amountKey);
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(observation)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Reads a cell's series, newest last.
   *
   * A malformed line is SKIPPED, not fatal. The last line of a journal killed
   * mid-write is the one that can be torn, and losing that single observation
   * is the correct outcome - refusing to read the other 20,000 is not.
   */
  public static load(bank: string, amountKey: string): HistoricalObservation[] {
    const key = this.key(bank, amountKey);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const file = this.filePath(bank, amountKey);
    const series: HistoricalObservation[] = [];

    if (fs.existsSync(file)) {
      let malformed = 0;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        try {
          const parsed = JSON.parse(line) as HistoricalObservation;
          if (typeof parsed.timestamp === 'number') series.push(parsed);
          else malformed += 1;
        } catch {
          malformed += 1;
        }
      }
      if (malformed > 0) {
        console.warn(
          `[HistoricalStore] ${bank}/${amountKey}: ${malformed} línea(s) ilegibles omitidas.`
        );
      }
    }

    this.cache.set(key, series);
    if (series.length > 0) {
      this.lastCapturedAt.set(key, series[series.length - 1].provenance?.capturedAt ?? 0);
    }
    return series;
  }

  /**
   * Moves the oldest half out to an archive file when a cell grows past the
   * cap. NOT a delete: the archive is written once and never reopened.
   */
  private static rotateIfNeeded(
    bank: string,
    amountKey: string,
    series: HistoricalObservation[]
  ): void {
    if (this.maxLines <= 0 || series.length <= this.maxLines) return;

    const keep = Math.floor(this.maxLines / 2);
    const overflow = series.slice(0, series.length - keep);
    const retained = series.slice(series.length - keep);

    try {
      const archiveDir = path.join(this.resolveDir(), 'archive');
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

      const stamp = overflow[overflow.length - 1].timestamp;
      const archiveFile = path.join(
        archiveDir,
        `${cellFileName(bank, amountKey).replace('.ndjson', '')}__${stamp}.ndjson`
      );
      fs.writeFileSync(
        archiveFile,
        `${overflow.map((o) => JSON.stringify(o)).join('\n')}\n`
      );

      const live = this.filePath(bank, amountKey);
      const tmp = `${live}.tmp`;
      fs.writeFileSync(tmp, `${retained.map((o) => JSON.stringify(o)).join('\n')}\n`);
      fs.renameSync(tmp, live);

      this.cache.set(this.key(bank, amountKey), retained);
    } catch (err) {
      // A failed rotation must never lose the live series.
      console.error(`[HistoricalStore] Rotación fallida en ${bank}/${amountKey}:`, err);
    }
  }

  /** Every cell that has a series on disk, for diagnostics and backtests. */
  public static listCells(): { bank: string; amountKey: string }[] {
    const dir = this.resolveDir();
    if (!fs.existsSync(dir)) return [];

    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.ndjson'))
      .map((name) => {
        const [bank, amountKey] = name.replace('.ndjson', '').split('__');
        return { bank, amountKey };
      })
      .filter((c) => c.bank !== undefined && c.amountKey !== undefined);
  }

  /** What the series actually contains, so nobody has to assume. */
  public static describe(bank: string, amountKey: string): {
    observations: number;
    firstTimestamp: number | null;
    lastTimestamp: number | null;
    /** Median gap between observations, or null with fewer than two. */
    medianIntervalMs: number | null;
    /** Observations carrying a usable pair of recommended prices. */
    usableObservations: number;
  } {
    const series = this.load(bank, amountKey);
    if (series.length === 0) {
      return {
        observations: 0,
        firstTimestamp: null,
        lastTimestamp: null,
        medianIntervalMs: null,
        usableObservations: 0,
      };
    }

    const gaps: number[] = [];
    for (let i = 1; i < series.length; i += 1) {
      gaps.push(series[i].timestamp - series[i - 1].timestamp);
    }
    gaps.sort((a, b) => a - b);

    return {
      observations: series.length,
      firstTimestamp: series[0].timestamp,
      lastTimestamp: series[series.length - 1].timestamp,
      medianIntervalMs: gaps.length === 0 ? null : gaps[Math.floor(gaps.length / 2)],
      usableObservations: series.filter(
        (o) => o.buyRecommendedPrice !== null && o.sellRecommendedPrice !== null
      ).length,
    };
  }

  /** Test seam: forgets the in-memory tail without touching disk. */
  public static resetCache(): void {
    this.cache.clear();
    this.lastCapturedAt.clear();
    this.dataDir = null;
  }
}

/** Signed change, or null when either end is unknown. Never 0 for unknown. */
function delta(current: number | null, previous: number | null | undefined): number | null {
  if (current === null || previous === null || previous === undefined) return null;
  return Number((current - previous).toFixed(8));
}
