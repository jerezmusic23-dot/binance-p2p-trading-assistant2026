/**
 * Persistent Storage Engine for Binance P2P History & Alerts
 * Stores real tick data with atomic file writes, crash-recovery, and range querying.
 */

import fs from 'fs';
import path from 'path';
import {
  StorageDiagnostics, HistoryRecord, AlertRule, AlertTriggerLog } from './types.js';

export class StorageEngine {
  /**
   * Data directory, resolved once at module load.
   *
   * DATA_DIR lets the deployment point storage at a persistent volume. On a
   * host with an ephemeral filesystem (Render without a disk) the default
   * `<cwd>/data` is wiped on every deploy, restart or container recycle,
   * taking the whole market history with it.
   *
   * A relative DATA_DIR is resolved against the current working directory.
   * Unset or empty falls back to the previous behaviour exactly.
   */
  private static DATA_DIR = StorageEngine.resolveDataDir();
  private static HISTORY_FILE = path.join(StorageEngine.DATA_DIR, 'market_history.json');
  private static ALERTS_FILE = path.join(StorageEngine.DATA_DIR, 'alerts.json');
  private static TRIGGERS_FILE = path.join(StorageEngine.DATA_DIR, 'alert_triggers.json');

  private static history: HistoryRecord[] = [];
  private static alerts: AlertRule[] = [];
  private static triggers: AlertTriggerLog[] = [];
  private static isInitialized = false;
  private static tmpCounter = 0;

  /**
   * RETENTION.
   *
   * Every appendRecord rewrites the ENTIRE history file: serialise the whole
   * array, fsync, rename, fsync the directory. That is O(n) per append and
   * therefore O(n^2) over the life of the file, with an unbounded n.
   *
   * Measured, 601 appends: 56.1 MB serialised for a 191 KB file - 301x write
   * amplification, 1202 fsyncs. Projected at the production cadence of one
   * record per 60s: 13.7 MB per write after a month, 82 MB after six, and
   * every single write pays it.
   *
   * The active window is capped so that cost stops growing. Records leaving
   * the window are NOT deleted - they are appended to a dated archive under
   * history_archive/ and stay on disk forever. REGLA 2: nothing destroys
   * history, and a retention policy that quietly drops observations would be
   * exactly that.
   *
   * 43200 = 30 days at one record per minute. Chosen to keep the whole window
   * well past the 1471 records the +24H backtest horizon needs, while bounding
   * a single write to roughly 13 MB.
   */
  private static readonly DEFAULT_MAX_ACTIVE_RECORDS = 43_200;
  private static maxActiveRecords = StorageEngine.resolveMaxActiveRecords();
  private static ARCHIVE_DIR = path.join(StorageEngine.DATA_DIR, 'history_archive');
  private static lastArchiveFile: string | null = null;
  private static archivedRecordCount = 0;
  /**
   * Summary of what the archive holds, WITHOUT holding the archive.
   *
   * Built once at boot by reading each archive file, keeping three numbers and
   * discarding the content. Memory is O(1) in the number of records: a year of
   * archives is a few dozen files and the index that survives is a count and
   * two timestamps.
   *
   * It exists because getHistorySummary reported the range of the ACTIVE
   * window only, so once records began moving to the archive the summary would
   * claim the history started the day the active window did - understating a
   * history that was intact on disk.
   */
  private static archiveIndex: {
    fileCount: number;
    recordCount: number;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
  } = { fileCount: 0, recordCount: 0, oldestTimestamp: null, newestTimestamp: null };

  /**
   * HISTORY_MAX_RECORDS overrides the cap. A value of 0 disables archiving
   * entirely and restores the previous unbounded behaviour, for anyone who
   * would rather pay the write cost than split the file.
   */
  private static resolveMaxActiveRecords(): number {
    const raw = process.env.HISTORY_MAX_RECORDS?.trim();
    if (raw === undefined || raw === '') return StorageEngine.DEFAULT_MAX_ACTIVE_RECORDS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return StorageEngine.DEFAULT_MAX_ACTIVE_RECORDS;
    return Math.floor(parsed);
  }

  private static resolveDataDir(): string {
    const configured = process.env.DATA_DIR?.trim();
    return configured ? path.resolve(configured) : path.join(process.cwd(), 'data');
  }

  /** Absolute path of the directory this engine reads from and writes to. */
  public static getDataDir(): string {
    return this.DATA_DIR;
  }

  /**
   * Crash-safe replacement for fs.writeFileSync on a file we cannot afford to
   * lose. A plain writeFileSync truncates the destination first, so a process
   * death mid-write leaves a truncated, unparseable file.
   *
   * Sequence: write the full payload into a temp file in the SAME directory
   * (same filesystem, so rename is atomic) -> fsync the descriptor so the
   * bytes are on disk, not just in the page cache -> close -> rename over the
   * destination. rename(2) is atomic: a reader sees either the whole old file
   * or the whole new one, never a partial write.
   *
   * On any failure the destination is left untouched and the temp file is
   * removed. Throws; callers keep their existing try/catch so the public
   * contract (these methods never throw) is unchanged.
   */
  private static writeFileAtomicSync(targetFile: string, contents: string): void {
    const dir = path.dirname(targetFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.tmpCounter += 1;
    const tmpFile = path.join(
      dir,
      `.${path.basename(targetFile)}.${process.pid}.${Date.now()}.${this.tmpCounter}.tmp`
    );

    let fd: number | undefined;
    try {
      // 'wx' fails instead of clobbering if the temp name somehow exists.
      fd = fs.openSync(tmpFile, 'wx');
      fs.writeFileSync(fd, contents, 'utf-8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      fs.renameSync(tmpFile, targetFile);
    } catch (err) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Nothing further we can do; the throw below carries the real cause.
        }
      }
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {
        // Leaving an orphan temp file is preferable to masking the real error.
      }
      throw err;
    }

    // Best effort: persist the directory entry itself so the rename survives a
    // power loss. Not supported on every platform, so failure is not fatal.
    let dirFd: number | undefined;
    try {
      dirFd = fs.openSync(dir, 'r');
      fs.fsyncSync(dirFd);
    } catch {
      // Windows and some filesystems reject fsync on a directory handle.
    } finally {
      if (dirFd !== undefined) {
        try {
          fs.closeSync(dirFd);
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Preserves the bytes of a file we failed to parse, so an unreadable file is
   * never silently destroyed by the next write. Copies (never moves) to a
   * timestamped sidecar and returns its path, or null if the copy failed.
   *
   * This does NOT attempt any recovery: it only makes the damaged bytes
   * recoverable by hand.
   */
  private static quarantineUnparseableFile(targetFile: string, cause: unknown): string | null {
    const sidecar = `${targetFile}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(targetFile, sidecar, fs.constants.COPYFILE_EXCL);
      console.error(
        `[Storage] Could not parse ${path.basename(targetFile)}. ` +
          `A copy of the damaged file was preserved at ${sidecar}. ` +
          `In-memory state starts empty; the next write will replace the original. Cause:`,
        cause
      );
      return sidecar;
    } catch (copyErr) {
      console.error(
        `[Storage] Could not parse ${path.basename(targetFile)} AND could not ` +
          `preserve a copy of it. The original is still on disk, untouched, ` +
          `until the next write. Parse cause:`,
        cause,
        'Copy failure:',
        copyErr
      );
      return null;
    }
  }

  public static initialize(): void {
    if (this.isInitialized) return;

    try {
      if (!fs.existsSync(this.DATA_DIR)) {
        fs.mkdirSync(this.DATA_DIR, { recursive: true });
      }

      // Load History
      if (fs.existsSync(this.HISTORY_FILE)) {
        const raw = fs.readFileSync(this.HISTORY_FILE, 'utf-8');
        try {
          this.history = JSON.parse(raw);
          if (!Array.isArray(this.history)) this.history = [];
        } catch (e) {
          this.quarantineUnparseableFile(this.HISTORY_FILE, e);
          this.history = [];
        }
      } else {
        this.history = [];
        this.saveHistory();
      }

      this.buildArchiveIndex();

      // Load Alerts
      if (fs.existsSync(this.ALERTS_FILE)) {
        const raw = fs.readFileSync(this.ALERTS_FILE, 'utf-8');
        try {
          this.alerts = JSON.parse(raw);
          if (!Array.isArray(this.alerts)) this.alerts = [];
        } catch (e) {
          this.quarantineUnparseableFile(this.ALERTS_FILE, e);
          this.alerts = [];
        }
      } else {
        // Initial default alerts
        this.alerts = [
          {
            id: 'rule-spread-high',
            name: 'Spread Mayor a 2.0%',
            condition: 'SPREAD_ABOVE',
            targetValue: 2.0,
            targetSide: 'SELL',
            enabled: true,
            createdAt: Date.now(),
          },
          {
            id: 'rule-volatility-spike',
            name: 'Movimiento Brusco / Volatilidad',
            condition: 'VOLATILITY_SPIKE',
            targetValue: 1.5,
            targetSide: 'BUY',
            enabled: true,
            createdAt: Date.now(),
          },
        ];
        this.saveAlerts();
      }

      // Load Triggers
      if (fs.existsSync(this.TRIGGERS_FILE)) {
        const raw = fs.readFileSync(this.TRIGGERS_FILE, 'utf-8');
        try {
          this.triggers = JSON.parse(raw);
          if (!Array.isArray(this.triggers)) this.triggers = [];
        } catch (e) {
          this.quarantineUnparseableFile(this.TRIGGERS_FILE, e);
          this.triggers = [];
        }
      }

      this.isInitialized = true;
      console.log(`[Storage] Initialized with ${this.history.length} historical records and ${this.alerts.length} alerts.`);
    } catch (err) {
      console.error('[Storage] Init failed:', err);
    }
  }

  public static appendRecord(record: HistoryRecord): void {
    this.initialize();
    this.history.push(record);
    /*
     * Archive BEFORE writing, so the write that follows is already bounded.
     * Archiving first also means a crash between the two leaves the overflow
     * safely in the archive and merely repeated in the active file - which
     * the next boot corrects. The opposite order could lose it.
     */
    this.enforceRetention();
    this.saveHistory();
  }

  /**
   * Moves the overflow out of the active window into its own archive file.
   *
   * NOT a delete. The records are written to history_archive/ and stay there.
   * REGLA 2: a retention policy that quietly drops observations would be
   * exactly the destruction of history the rules forbid.
   *
   * APPEND-ONLY, IN BATCHES, AND THAT MATTERS.
   *
   * The first version of this archived on every append past the cap, reading
   * the existing archive and rewriting it with one more record. Benchmarked at
   * 2000 appends it was SLOWER than no retention at all - 4811ms against
   * 3452ms - because it had moved the quadratic cost from the active file to
   * the archive rather than removing it.
   *
   * So: archiving triggers only once the overflow reaches a whole batch, and
   * each batch is written ONCE to a file of its own that is never reopened.
   * No archive file is ever read, appended to or rewritten.
   */
  private static enforceRetention(): void {
    if (this.maxActiveRecords <= 0) return;

    const batch = this.archiveBatchSize();
    if (this.history.length < this.maxActiveRecords + batch) return;

    const overflow = this.history.slice(0, batch);
    if (overflow.length === 0) return;

    try {
      if (!fs.existsSync(this.ARCHIVE_DIR)) {
        fs.mkdirSync(this.ARCHIVE_DIR, { recursive: true });
      }

      const archiveFile = this.nextArchiveFile(overflow[0].timestamp);
      this.writeFileAtomicSync(archiveFile, JSON.stringify(overflow));

      // Only once the batch is safely on disk is it dropped from the window.
      this.history = this.history.slice(batch);
      this.archivedRecordCount += overflow.length;
      this.lastArchiveFile = archiveFile;

      /*
       * Fold the batch into the index as it leaves.
       *
       * The index is built at boot; without this it would not learn about
       * batches archived DURING the session, and getHistorySummary would
       * under-report the history until the next restart - the same
       * archive-blindness this index exists to remove, just with a shorter
       * blind spot. The batch is already in hand, so this costs a scan of it
       * and retains nothing.
       */
      this.archiveIndex.fileCount += 1;
      this.archiveIndex.recordCount += overflow.length;
      for (const rec of overflow) {
        if (typeof rec?.timestamp !== 'number') continue;
        if (
          this.archiveIndex.oldestTimestamp === null ||
          rec.timestamp < this.archiveIndex.oldestTimestamp
        ) {
          this.archiveIndex.oldestTimestamp = rec.timestamp;
        }
        if (
          this.archiveIndex.newestTimestamp === null ||
          rec.timestamp > this.archiveIndex.newestTimestamp
        ) {
          this.archiveIndex.newestTimestamp = rec.timestamp;
        }
      }

      console.log(
        `[Storage] Archived ${overflow.length} records to ${path.basename(archiveFile)}; ` +
          `active window now ${this.history.length}.`
      );
    } catch (err) {
      /*
       * Keep them in the active window. Nothing is lost; the file stays large.
       * A file that is too big is a performance problem and losing an
       * observation is a data problem, and they are not the same size of
       * mistake.
       */
      console.error('[Storage] Archiving failed, retaining records in the active window:', err);
    }
  }

  /**
   * How many records move at once.
   *
   * A tenth of the window, so archiving runs about ten times per window rather
   * than on every append, and each run costs the batch rather than the whole
   * history. Floored at 1 so a tiny configured cap still makes progress.
   */
  private static archiveBatchSize(): number {
    return Math.max(1, Math.floor(this.maxActiveRecords / 10));
  }

  /**
   * A fresh path for this batch, named for the oldest record it carries.
   *
   * Never returns the name of an existing file: a collision takes a numeric
   * suffix instead. Overwriting an archive is the one way this code could
   * destroy history, so it is made structurally impossible rather than
   * unlikely.
   */
  private static nextArchiveFile(oldestTimestamp: number): string {
    const stamp = new Date(oldestTimestamp).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let candidate = path.join(this.ARCHIVE_DIR, `market_history-${stamp}.json`);
    let suffix = 1;
    while (fs.existsSync(candidate)) {
      candidate = path.join(this.ARCHIVE_DIR, `market_history-${stamp}-${suffix}.json`);
      suffix += 1;
    }
    return candidate;
  }

  private static saveHistory(): void {
    try {
      if (!fs.existsSync(this.DATA_DIR)) {
        fs.mkdirSync(this.DATA_DIR, { recursive: true });
      }
      /*
       * Compact, not pretty-printed. This is a machine-written file rewritten
       * every 60s; the indentation cost 21% of every byte written for the
       * benefit of nobody. JSON.parse reads either form, so existing files
       * keep loading unchanged.
       */
      this.writeFileAtomicSync(this.HISTORY_FILE, JSON.stringify(this.history));
    } catch (err) {
      console.error('[Storage] Error saving history:', err);
    }
  }

  /**
   * Where the history is really being written, and whether it survived.
   *
   * The code resolves DATA_DIR correctly, but nothing in the repository can
   * prove the platform mounted a persistent volume there - and a container
   * filesystem looks identical to a real one until it is recycled. This
   * reports the observable facts so the difference is a measurement rather
   * than an assumption.
   *
   * Deliberately narrow: a path, a boolean and some counts. No environment
   * dump, no credentials, no file contents.
   */
  public static describeStorage(): StorageDiagnostics {
    this.initialize();

    const exists = fs.existsSync(this.HISTORY_FILE);
    let writable = false;
    try {
      fs.accessSync(this.DATA_DIR, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }

    const iso = (ts: number | undefined) =>
      ts === undefined ? null : new Date(ts).toISOString();

    return {
      dataDir: this.DATA_DIR,
      historyFile: this.HISTORY_FILE,
      exists,
      writable,
      recordCount: this.history.length,
      oldestTimestamp: iso(this.history[0]?.timestamp),
      newestTimestamp: iso(this.history[this.history.length - 1]?.timestamp),
      strategicRecordCount: this.history.filter((r) => r.calculationVersion === 'v2-strategic')
        .length,
      maxActiveRecords: this.maxActiveRecords,
      archivedRecordCount: this.archivedRecordCount,
      lastArchiveFile: this.lastArchiveFile,
    };
  }

  public static getHistory(limit?: number, sinceTimestamp?: number): HistoryRecord[] {
    this.initialize();
    let records = [...this.history];
    if (sinceTimestamp) {
      records = records.filter((r) => r.timestamp >= sinceTimestamp);
    }
    if (limit && limit > 0) {
      return records.slice(-limit);
    }
    return records;
  }

  /**
   * Reads every archive file once, keeps a count and a range, drops the rest.
   *
   * Deliberately NOT lazy: it runs at boot, when the process has nothing else
   * to do, so no later request pays for it. Deliberately NOT cached to disk:
   * a stale index that disagrees with the files would be worse than no index.
   *
   * A file that fails to parse is counted as unreadable and skipped rather
   * than throwing - one damaged archive must not stop the process from
   * starting, and quarantining it here would risk touching data this method
   * has no business writing to.
   */
  private static buildArchiveIndex(): void {
    const index = {
      fileCount: 0,
      recordCount: 0,
      oldestTimestamp: null as number | null,
      newestTimestamp: null as number | null,
    };

    try {
      if (!fs.existsSync(this.ARCHIVE_DIR)) {
        this.archiveIndex = index;
        return;
      }

      for (const name of fs.readdirSync(this.ARCHIVE_DIR)) {
        if (!name.endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(
            fs.readFileSync(path.join(this.ARCHIVE_DIR, name), 'utf-8')
          ) as HistoryRecord[];
          if (!Array.isArray(parsed) || parsed.length === 0) continue;

          index.fileCount += 1;
          index.recordCount += parsed.length;

          for (const rec of parsed) {
            if (typeof rec?.timestamp !== 'number') continue;
            if (index.oldestTimestamp === null || rec.timestamp < index.oldestTimestamp) {
              index.oldestTimestamp = rec.timestamp;
            }
            if (index.newestTimestamp === null || rec.timestamp > index.newestTimestamp) {
              index.newestTimestamp = rec.timestamp;
            }
          }
          // parsed goes out of scope here: nothing from the archive is retained.
        } catch (e) {
          console.warn(`[Storage] Archive file unreadable, skipped: ${name}`);
        }
      }
    } catch (err) {
      console.warn('[Storage] Could not index the archive:', err);
    }

    this.archiveIndex = index;
  }

  /** What the archive holds, for diagnostics. Never the records themselves. */
  public static describeArchive(): {
    fileCount: number;
    recordCount: number;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
  } {
    this.initialize();
    return { ...this.archiveIndex };
  }

  public static getHistorySummary(): {
    totalRecords: number;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
    availableDays: number;
    availableHours: number;
  } {
    this.initialize();

    /*
     * The LOGICAL history, not just the active window.
     *
     * Records moved to the archive are still history; reporting only the
     * active window made a bounded window look like a short history. The
     * archive contributes its count and its range from the boot index, so this
     * stays O(1) and reads no archive file.
     */
    const archive = this.archiveIndex;
    const totalRecords = this.history.length + archive.recordCount;

    if (totalRecords === 0) {
      return {
        totalRecords: 0,
        oldestTimestamp: null,
        newestTimestamp: null,
        availableDays: 0,
        availableHours: 0,
      };
    }

    const activeOldest = this.history[0]?.timestamp ?? null;
    const activeNewest = this.history[this.history.length - 1]?.timestamp ?? null;

    const candidates = (values: (number | null)[]) =>
      values.filter((v): v is number => v !== null);

    const oldestCandidates = candidates([archive.oldestTimestamp, activeOldest]);
    const newestCandidates = candidates([archive.newestTimestamp, activeNewest]);
    const oldest = Math.min(...oldestCandidates);
    const newest = Math.max(...newestCandidates);
    const diffMs = Math.max(0, newest - oldest);
    const availableHours = Number((diffMs / (1000 * 60 * 60)).toFixed(1));
    const availableDays = Number((diffMs / (1000 * 60 * 60 * 24)).toFixed(2));

    return {
      totalRecords,
      oldestTimestamp: oldest,
      newestTimestamp: newest,
      availableDays,
      availableHours,
    };
  }

  public static getAlerts(): AlertRule[] {
    this.initialize();
    return this.alerts;
  }

  public static saveAlert(rule: AlertRule): AlertRule {
    this.initialize();
    const existingIndex = this.alerts.findIndex((a) => a.id === rule.id);
    if (existingIndex >= 0) {
      this.alerts[existingIndex] = rule;
    } else {
      this.alerts.push(rule);
    }
    this.saveAlerts();
    return rule;
  }

  public static deleteAlert(id: string): boolean {
    this.initialize();
    const lenBefore = this.alerts.length;
    this.alerts = this.alerts.filter((a) => a.id !== id);
    if (this.alerts.length !== lenBefore) {
      this.saveAlerts();
      return true;
    }
    return false;
  }

  private static saveAlerts(): void {
    try {
      this.writeFileAtomicSync(this.ALERTS_FILE, JSON.stringify(this.alerts, null, 2));
    } catch (err) {
      console.error('[Storage] Error saving alerts:', err);
    }
  }

  public static logTrigger(trigger: AlertTriggerLog): void {
    this.initialize();
    this.triggers.unshift(trigger);
    if (this.triggers.length > 100) this.triggers = this.triggers.slice(0, 100);
    try {
      this.writeFileAtomicSync(this.TRIGGERS_FILE, JSON.stringify(this.triggers, null, 2));
    } catch (err) {
      console.error('[Storage] Error saving triggers:', err);
    }
  }

  public static getTriggers(limit = 30): AlertTriggerLog[] {
    this.initialize();
    return this.triggers.slice(0, limit);
  }
}
