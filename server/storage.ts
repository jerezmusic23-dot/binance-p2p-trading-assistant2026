/**
 * Persistent Storage Engine for Binance P2P History & Alerts
 * Stores real tick data with atomic file writes, crash-recovery, and range querying.
 */

import fs from 'fs';
import path from 'path';
import { HistoryRecord, AlertRule, AlertTriggerLog } from './types.js';

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
    // Persist to disk (debounce or direct write)
    this.saveHistory();
  }

  private static saveHistory(): void {
    try {
      if (!fs.existsSync(this.DATA_DIR)) {
        fs.mkdirSync(this.DATA_DIR, { recursive: true });
      }
      this.writeFileAtomicSync(this.HISTORY_FILE, JSON.stringify(this.history, null, 2));
    } catch (err) {
      console.error('[Storage] Error saving history:', err);
    }
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

  public static getHistorySummary(): {
    totalRecords: number;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
    availableDays: number;
    availableHours: number;
  } {
    this.initialize();
    if (this.history.length === 0) {
      return {
        totalRecords: 0,
        oldestTimestamp: null,
        newestTimestamp: null,
        availableDays: 0,
        availableHours: 0,
      };
    }

    const oldest = this.history[0].timestamp;
    const newest = this.history[this.history.length - 1].timestamp;
    const diffMs = Math.max(0, newest - oldest);
    const availableHours = Number((diffMs / (1000 * 60 * 60)).toFixed(1));
    const availableDays = Number((diffMs / (1000 * 60 * 60 * 24)).toFixed(2));

    return {
      totalRecords: this.history.length,
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
