/**
 * Central Market Store - Single Source of Truth
 * Coordinates polling, validation, normalization, historical recording,
 * bank matrix aggregation, projection execution, and alert evaluations.
 */

import {
  MarketSnapshot,
  HistoryRecord,
  MarketAnalysis,
  MarketProjections,
  BankAmountExecutability,
  Opportunity,
  OpportunityEngineResult,
  PayTypeMappingReport,
  NormalizedAd,
  AlertRule,
  AlertTriggerLog,
  BacktestMetrics,
  WalkForwardBacktestResult,
  ExecutableMatrix,
  MarketReference,
} from './types.js';
import { BinanceP2PService, BANK_CODE_MAP } from './binanceP2PService.js';
import { countVerifications } from './bankMatching.js';
import { AMOUNT_TIERS, evaluateBankTiers } from './executability.js';
import { runOpportunityEngine } from './opportunityEngine.js';
import { BacktestEngine } from './backtestEngine.js';

/**
 * How far back the hourly session chart reads.
 *
 * 24 hours: the chart renders a 13-hour Venezuelan session (08:00-20:00 VET)
 * bucketed by hour-of-day, so it needs the whole day behind it. Not a tuning
 * knob - it is the span the chart already claimed to show.
 */
const TIMELINE_WINDOW_MS = 24 * 60 * 60 * 1000;
import {
  MATRIX_STALE_AFTER_MS,
  buildExecutableMatrix,
  buildMarketReference,
} from './executableMatrix.js';
import { assessPayTypeMapping, describeMappingForLog } from './payTypeMappingStatus.js';
import { StorageEngine } from './storage.js';
import { ProjectionEngine } from './projectionEngine.js';
import { TelegramNotifier } from './telegramNotifier.js';

export class CentralMarketStore {
  private static instance: CentralMarketStore;

  private currentSnapshot: MarketSnapshot | null = null;
  private lastValidSnapshot: MarketSnapshot | null = null;
  private pollingIntervalMs = 6000; // 6 seconds for fast live updates
  /*
   * LIVE CAPTURE and HISTORICAL PERSISTENCE are two different cadences.
   *
   * The screen wants every observation it can get; the history does not.
   * Writing every 6s appended ~14,400 near-identical records a day and
   * rewrote the whole file each time, so the cost grew with the square of the
   * history. Sampling once a minute keeps the same 100/500-record windows the
   * consumers already ask for, but each covers ten times more real time -
   * which is what a 1-4 hour projection horizon actually needs.
   *
   * Polling is NOT slowed down. Only the write is sampled.
   */
  private readonly historyIntervalMs = 60_000;
  private lastPersistedAt: number | null = null;
  /** Newest observation not yet written. Flushed on stop(). */
  private pendingRecord: HistoryRecord | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  /** Autonomous bank-matrix refresh, so opportunities do not depend on a viewer. */
  private matrixTimer: NodeJS.Timeout | null = null;
  private matrixBootTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private bankMatrixCache: {
    timestamp: number;
    /**
     * Banks whose Binance query threw. An ERROR cell is not an empty book, and
     * conflating them is how a broken query comes to look like a calm market.
     */
    failedBanks: Set<string>;
    /** Ads actually evaluated per bank and side, for diagnosing a blocked cell. */
    adCounts: Record<string, { buy: number; sell: number }>;
    /*
     * FASE 3: the normalized ads behind the matrix, kept per bank and side.
     *
     * refreshBankMatrix issues exactly ONE query per bank per side and
     * evaluates the amount tiers in memory. Retaining the ads keeps the
     * request budget at 14 per cycle while making BANK x AMOUNT x SIDE
     * derivable without a single extra call.
     */
    adsByBank: Record<string, { buy: NormalizedAd[]; sell: NormalizedAd[] }>;
  } | null = null;
  /*
   * The opportunity engine's answer for the book the bank matrix last
   * captured. Recomputed in refreshBankMatrix (every 45s at most), never on
   * its own schedule, so nothing here adds a request to Binance.
   *
   * null means "not computed yet", which is NOT the same as "no opportunity
   * exists" - the alert loop must not fire on either.
   */
  private lastOpportunities: OpportunityEngineResult | null = null;
  /*
   * Whether BANK_CODE_MAP.apiPayTypes matches what Binance really sends,
   * assessed from the UNFILTERED snapshot book (payTypes: []), which is
   * representative of the whole market. The bank-matrix queries filter BY
   * those same codes, so they cannot be used as evidence about themselves.
   *
   * null means "not assessed yet" and is reported as NOT_VERIFIABLE, never as
   * working.
   */
  private payTypeMapping: PayTypeMappingReport | null = null;
  private mappingStatusLogged: string | null = null;

  /**
   * Last capture state announced, and last storage failure seen.
   *
   * null means nothing has been announced yet, which is why a process that
   * starts healthy does not announce a recovery it never had.
   */
  private lastCaptureState: 'LIVE' | 'STALE' | 'OFFLINE' | null = null;
  private lastStorageError: string | null = null;
  private matrixPollingInProgress = false;
  private filteredCache = new Map<
    string,
    {
      timestamp: number;
      snapshot: MarketSnapshot;
      analysis: MarketAnalysis | null;
      projections: MarketProjections | null;
    }
  >();

  private constructor() {
    StorageEngine.initialize();
  }

  public static getInstance(): CentralMarketStore {
    if (!CentralMarketStore.instance) {
      CentralMarketStore.instance = new CentralMarketStore();
    }
    return CentralMarketStore.instance;
  }

  /**
   * Starts the centralized polling loop
   */
  public start(): void {
    if (this.pollTimer) return;

    console.log('[CentralStore] Starting central market polling loop (every 6s)...');

    // Notification layer: logs its enabled/disabled status once, here, so the
    // warning appears at boot rather than whenever the first alert fires.
    TelegramNotifier.getInstance();
    // Initial fetch immediately
    this.pollMarket();

    this.pollTimer = setInterval(() => {
      this.pollMarket();
    }, this.pollingIntervalMs);

    // First bank matrix population, shortly after the first snapshot.
    this.matrixBootTimer = setTimeout(() => {
      this.matrixBootTimer = null;
      void this.refreshBankMatrix();
    }, 2000);

    /*
     * AUTONOMOUS MATRIX REFRESH.
     *
     * Until this existed, refreshBankMatrix ran once at boot and then only
     * when an HTTP request found the cache cold. With nobody on the dashboard
     * lastOpportunities stayed frozen at its boot value forever, so the
     * lifecycle notifier re-evaluated the same stale answer every 6s and a
     * real opportunity appearing later was never seen. Alerts on price kept
     * arriving because those read the 6s snapshot instead.
     *
     * The interval is MATRIX_STALE_AFTER_MS, not a new number: it is the TTL
     * the cache already used to decide a matrix was too old to serve, so the
     * loop refreshes exactly when a reader would have forced it to. Request
     * cost is unchanged per refresh - 14, one per bank per side - and now
     * predictable at ~18.7/min rather than dependent on who is watching.
     */
    this.matrixTimer = setInterval(() => {
      void this.refreshBankMatrix();
    }, MATRIX_STALE_AFTER_MS);
  }

  public stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.matrixTimer) {
      clearInterval(this.matrixTimer);
      this.matrixTimer = null;
    }
    if (this.matrixBootTimer) {
      clearTimeout(this.matrixBootTimer);
      this.matrixBootTimer = null;
    }
    this.flushPendingRecord();
  }

  /**
   * Writes the newest observation that the sampling interval skipped.
   *
   * Called from stop(), which server.ts now wires to SIGTERM and SIGINT, so a
   * container recycled by the platform flushes the skipped observation before
   * exiting. The remaining loss window is an UNCLEAN kill - SIGKILL, OOM, a
   * hardware fault - which costs at most one sampling interval and cannot be
   * closed from inside the process.
   */
  public flushPendingRecord(): void {
    if (this.pendingRecord === null) return;
    StorageEngine.appendRecord(this.pendingRecord);
    this.lastPersistedAt = this.pendingRecord.timestamp;
    this.pendingRecord = null;
  }

  public setPollingInterval(ms: number): void {
    this.pollingIntervalMs = Math.max(3000, ms);
    if (this.pollTimer) {
      this.stop();
      this.start();
    }
  }

  /**
   * The core single-fetch pipeline: BINANCE -> P2P SERVICE -> VALIDATION -> NORMALIZATION -> CENTRAL STORE
   */
  public async pollMarket(): Promise<MarketSnapshot | null> {
    if (this.isPolling) return this.currentSnapshot;
    this.isPolling = true;

    try {
      const snapshot = await BinanceP2PService.fetchFullMarketSnapshot();

      this.currentSnapshot = snapshot;
      this.lastValidSnapshot = snapshot;

      /*
       * C2 / decision (b): the history only ever stores complete observations.
       * When either side of the book was empty there is no price to record, so
       * nothing is appended - the gap in the series is the honest record of
       * what happened. This keeps HistoryRecord and storage.ts unchanged.
       */
      const { bestBuyPrice, bestSellPrice, spreadPercentage } = snapshot;
      if (bestBuyPrice !== null && bestSellPrice !== null && spreadPercentage !== null) {
        const record: HistoryRecord = {
          id: `tick-${snapshot.timestamp}`,
          timestamp: snapshot.timestamp,
          dateStr: new Date(snapshot.timestamp).toISOString(),
          hour: ProjectionEngine.getVenezuelaHour(snapshot.timestamp),
          buyPrice: bestBuyPrice,
          sellPrice: bestSellPrice,
          spreadPct: spreadPercentage,
          bestBuyMerchant: snapshot.topBuyAds[0]?.merchantName || 'N/A',
          bestSellMerchant: snapshot.topSellAds[0]?.merchantName || 'N/A',
          activeBuyAds: snapshot.topBuyAds.length,
          activeSellAds: snapshot.topSellAds.length,
          source: 'BINANCE_P2P',
          /*
           * ADDITIVE. The raw extremes above are untouched; these carry the
           * strategic level of the same observation, which is what a market
           * projection needs. Written only when both sides produced one -
           * never derived, never defaulted.
           */
          ...(snapshot.strategicBuyPrice !== null &&
          snapshot.strategicSellPrice !== null &&
          snapshot.strategicSpreadPct !== null
            ? {
                calculationVersion: 'v2-strategic' as const,
                strategicBuyPrice: snapshot.strategicBuyPrice,
                strategicSellPrice: snapshot.strategicSellPrice,
                strategicSpreadPct: snapshot.strategicSpreadPct,
              }
            : {}),
        };

        /*
         * One write per historyIntervalMs. The first observation always
         * persists, so a fresh process records immediately instead of staying
         * blank for a minute. Skipped observations are not lost data: they
         * reached the LIVE snapshot, they simply were not sampled.
         */
        const due =
          this.lastPersistedAt === null ||
          snapshot.timestamp - this.lastPersistedAt >= this.historyIntervalMs;

        if (due) {
          /*
           * A failed write must never take down capture, but it must never be
           * silent either: the dashboard keeps showing live prices while the
           * history quietly stops growing, and the projections degrade weeks
           * later for no visible reason.
           */
          try {
            StorageEngine.appendRecord(record);
            this.lastPersistedAt = snapshot.timestamp;
            this.pendingRecord = null;
            this.reportStorageState(snapshot.timestamp, null);
          } catch (storageErr: any) {
            const detail = String(storageErr?.message ?? storageErr);
            console.error(`[CentralStore] CRITICAL STORAGE ERROR: ${detail}`);
            this.pendingRecord = record;
            this.reportStorageState(snapshot.timestamp, detail);
          }
        } else {
          this.pendingRecord = record;
        }
      } else {
        console.warn(
          '[CentralStore] Snapshot incompleto (BUY o SELL sin anuncios): no se registra en el histórico.'
        );
      }

      /*
       * Assess the payType mapping against what Binance actually sent. This
       * is the only evidence available: the codes in BANK_CODE_MAP were
       * written by hand and no test can confirm them.
       *
       * Logged once per status change - loudly when the mapping is wrong, so
       * "no opportunities" can never be mistaken for a quiet market.
       */
      const observedOptions = [...snapshot.topBuyAds, ...snapshot.topSellAds].flatMap(
        (ad) => ad.paymentOptions
      );
      this.payTypeMapping = assessPayTypeMapping(observedOptions, BANK_CODE_MAP, {
        buyAds: snapshot.topBuyAds.length,
        sellAds: snapshot.topSellAds.length,
        totalAds: snapshot.topBuyAds.length + snapshot.topSellAds.length,
        paymentMethodEntries: observedOptions.length,
      });
      if (this.mappingStatusLogged !== this.payTypeMapping.status) {
        this.mappingStatusLogged = this.payTypeMapping.status;
        const line = describeMappingForLog(this.payTypeMapping);
        if (this.payTypeMapping.status === 'NOT_VERIFIED') console.error(line);
        else console.warn(line);
      }

      /*
       * Capture is healthy. Announced only as a TRANSITION - if the previous
       * state was already LIVE the notifier returns UNCHANGED and nothing is
       * sent.
       */
      this.reportCaptureState(snapshot.status, snapshot.timestamp, null);

      // Evaluate alert rules
      this.evaluateAlerts(snapshot);

      return snapshot;
    } catch (err: any) {
      console.error('[CentralStore] Polling error:', err.message || err);

      if (this.lastValidSnapshot) {
        // Mark as STALE or OFFLINE but retain last known valid price
        this.currentSnapshot = {
          ...this.lastValidSnapshot,
          status: 'STALE',
          lastError: err.message || 'Error de conexión con Binance',
        };
      } else {
        this.currentSnapshot = {
          timestamp: Date.now(),
          isoDate: new Date().toISOString(),
          asset: 'USDT',
          fiat: 'VES',
          bestBuyPrice: null,
          bestSellPrice: null,
          averageBuyPrice: null,
          averageSellPrice: null,
          medianBuyPrice: null,
          medianSellPrice: null,
          weightedBuyPrice: null,
          weightedSellPrice: null,
          spreadAbsolute: null,
          spreadPercentage: null,
          strategicBuyPrice: null,
          strategicSellPrice: null,
          strategicSpreadPct: null,
          strategicReason: 'No se ha obtenido ningun snapshot valido de Binance todavia.',
          topBuyAds: [],
          topSellAds: [],
          source: 'BINANCE_P2P',
          fetchDurationMs: 0,
          status: 'OFFLINE',
          lastError: err.message || 'Sin conexión a Binance P2P',
          bestBuy: {
            value: null,
            provenance: 'REAL',
            reason: 'No se ha obtenido ningun snapshot valido de Binance todavia.',
          },
          bestSell: {
            value: null,
            provenance: 'REAL',
            reason: 'No se ha obtenido ningun snapshot valido de Binance todavia.',
          },
          aggregatesProvenance: 'REAL',
          orderBookProvenance: 'REAL',
          strategicProvenance: 'STRATEGIC',
        };
      }
      this.reportCaptureState(
        this.currentSnapshot.status,
        this.currentSnapshot.timestamp,
        this.currentSnapshot.lastError
      );

      return this.currentSnapshot;
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Reports how capture is doing, as a TRANSITION.
   *
   * The notifier suppresses an unchanged state, so a two-hour outage polled
   * every six seconds produces one message, not twelve hundred. RECOVERED is
   * sent as its own condition because "the alerts stopped" is not evidence
   * that anything was fixed.
   */
  private reportCaptureState(
    status: 'LIVE' | 'STALE' | 'OFFLINE',
    timestamp: number,
    lastError: string | null
  ): void {
    const notifier = TelegramNotifier.getInstance();

    if (status === 'LIVE') {
      if (this.lastCaptureState !== null && this.lastCaptureState !== 'LIVE') {
        void notifier.notifySystemAlert({
          kind: 'BINANCE_RECOVERED',
          timestamp,
          state: 'LIVE',
          detail: 'La captura de Binance P2P vuelve a responder con datos completos.',
        });
      }
      this.lastCaptureState = 'LIVE';
      return;
    }

    this.lastCaptureState = status;
    const reason = lastError ?? 'Sin detalle del fallo de captura.';
    void notifier.notifySystemAlert({
      kind: status === 'OFFLINE' ? 'BINANCE_OFFLINE' : 'DATA_STALE',
      timestamp,
      /*
       * The state is the KIND plus the reason, not the timestamp: two polls
       * failing the same way share a state and only the first is sent.
       */
      state: `${status}:${reason}`,
      detail:
        status === 'OFFLINE'
          ? `Binance P2P no responde: ${reason}`
          : `Los datos de mercado no se han podido refrescar: ${reason}`,
    });
  }

  /** Same transition discipline for the history file. */
  private reportStorageState(timestamp: number, error: string | null): void {
    const notifier = TelegramNotifier.getInstance();

    if (error === null) {
      this.lastStorageError = null;
      return;
    }

    this.lastStorageError = error;
    void notifier.notifySystemAlert({
      kind: 'STORAGE_ERROR',
      timestamp,
      state: `STORAGE_ERROR:${error}`,
      detail: `No se ha podido escribir el historico: ${error}`,
    });
  }

  /**
   * Retrieves the current central snapshot with real age calculation
   */
  public getCurrentSnapshot(): {
    snapshot: MarketSnapshot | null;
    ageSeconds: number;
    effectiveStatus: 'LIVE' | 'STALE' | 'OFFLINE';
  } {
    if (!this.currentSnapshot) {
      return {
        snapshot: null,
        ageSeconds: 9999,
        effectiveStatus: 'OFFLINE',
      };
    }

    const ageSeconds = Math.round((Date.now() - this.currentSnapshot.timestamp) / 1000);
    let effectiveStatus: 'LIVE' | 'STALE' | 'OFFLINE' = this.currentSnapshot.status;

    if (effectiveStatus !== 'OFFLINE') {
      if (ageSeconds > 35) {
        effectiveStatus = 'STALE';
      } else {
        effectiveStatus = 'LIVE';
      }
    }

    return {
      snapshot: {
        ...this.currentSnapshot,
        status: effectiveStatus,
      },
      ageSeconds,
      effectiveStatus,
    };
  }

  /**
   * Gets or computes a multi-filtered market snapshot tailored to a specific Bank and Amount
   */
  public async getFilteredSnapshot(
    bank?: string,
    amount?: number
  ): Promise<{
    snapshot: MarketSnapshot | null;
    ageSeconds: number;
    effectiveStatus: 'LIVE' | 'STALE' | 'OFFLINE';
  }> {
    const normalizedBank = !bank || bank === 'ALL' ? 'ALL' : bank;
    const normalizedAmount = !amount || isNaN(amount) || amount <= 0 ? 0 : amount;

    if (normalizedBank === 'ALL' && normalizedAmount === 0) {
      return this.getCurrentSnapshot();
    }

    const cacheKey = `${normalizedBank}_${normalizedAmount}`;
    const cached = this.filteredCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < 10000) {
      const ageSeconds = Math.round((Date.now() - cached.timestamp) / 1000);
      return {
        snapshot: { ...cached.snapshot, status: 'LIVE' },
        ageSeconds,
        effectiveStatus: 'LIVE',
      };
    }

    try {
      const filterBankParam = normalizedBank !== 'ALL' ? normalizedBank : undefined;
      const filterAmountParam = normalizedAmount > 0 ? normalizedAmount : undefined;

      const rawSnapshot = await BinanceP2PService.fetchFullMarketSnapshot(filterBankParam, filterAmountParam);

      const bankConfig = BANK_CODE_MAP[normalizedBank];
      const snapshot: MarketSnapshot = {
        ...rawSnapshot,
        filterBank: normalizedBank,
        filterBankName: bankConfig?.displayName || (normalizedBank !== 'ALL' ? normalizedBank : 'Todos los Bancos'),
        filterAmount: normalizedAmount > 0 ? normalizedAmount : null,
      };

      const history = StorageEngine.getHistory(100);
      const analysis = ProjectionEngine.analyzeMarket(snapshot, history);
      const projections = ProjectionEngine.generateProjections(snapshot, history, analysis);

      this.filteredCache.set(cacheKey, {
        timestamp: Date.now(),
        snapshot,
        analysis,
        projections,
      });

      return {
        snapshot,
        ageSeconds: 0,
        effectiveStatus: 'LIVE',
      };
    } catch (err: any) {
      console.warn(`[CentralStore] Filtered snapshot query failed for ${normalizedBank} ${normalizedAmount}:`, err);
      // Fallback to central snapshot if specific bank fails. C1: the fallback
      // is kept, but it is no longer silent - the snapshot now says the filter
      // was not honoured, so the UI can stop claiming these are Banesco rates.
      const fallback = this.getCurrentSnapshot();
      if (!fallback.snapshot) return fallback;
      return {
        ...fallback,
        snapshot: {
          ...fallback.snapshot,
          filterFallbackReason:
            `La consulta filtrada (banco: ${normalizedBank}, monto: ${normalizedAmount || 'ALL'}) ` +
            'fallo. Estos datos corresponden a TODOS los bancos sin filtro de monto.',
        },
      };
    }
  }

  /**
   * Gets Market Analysis computed by Projection Engine with Multi-Filter support
   */
  public async getFilteredAnalysis(bank?: string, amount?: number): Promise<MarketAnalysis | null> {
    const normalizedBank = !bank || bank === 'ALL' ? 'ALL' : bank;
    const normalizedAmount = !amount || isNaN(amount) || amount <= 0 ? 0 : amount;

    if (normalizedBank === 'ALL' && normalizedAmount === 0) {
      return this.getMarketAnalysis();
    }

    const cacheKey = `${normalizedBank}_${normalizedAmount}`;
    const cached = this.filteredCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < 10000 && cached.analysis) {
      return cached.analysis;
    }

    await this.getFilteredSnapshot(bank, amount);
    return this.filteredCache.get(cacheKey)?.analysis || this.getMarketAnalysis();
  }

  /**
   * Gets Market Projections computed by Projection Engine with Multi-Filter support
   */
  public async getFilteredProjections(bank?: string, amount?: number): Promise<MarketProjections | null> {
    const normalizedBank = !bank || bank === 'ALL' ? 'ALL' : bank;
    const normalizedAmount = !amount || isNaN(amount) || amount <= 0 ? 0 : amount;

    if (normalizedBank === 'ALL' && normalizedAmount === 0) {
      return this.getMarketProjections();
    }

    const cacheKey = `${normalizedBank}_${normalizedAmount}`;
    const cached = this.filteredCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < 10000 && cached.projections) {
      return cached.projections;
    }

    await this.getFilteredSnapshot(bank, amount);
    return this.filteredCache.get(cacheKey)?.projections || this.getMarketProjections();
  }

  /**
   * Refreshes a multi-filter snapshot immediately
   */
  public async refreshFilteredMarket(
    bank?: string,
    amount?: number
  ): Promise<{
    snapshot: MarketSnapshot | null;
    ageSeconds: number;
    effectiveStatus: 'LIVE' | 'STALE' | 'OFFLINE';
  }> {
    const normalizedBank = !bank || bank === 'ALL' ? 'ALL' : bank;
    const normalizedAmount = !amount || isNaN(amount) || amount <= 0 ? 0 : amount;

    if (normalizedBank === 'ALL' && normalizedAmount === 0) {
      await this.pollMarket();
      return this.getCurrentSnapshot();
    }

    const cacheKey = `${normalizedBank}_${normalizedAmount}`;
    this.filteredCache.delete(cacheKey);
    return this.getFilteredSnapshot(bank, amount);
  }

  /**
   * Gets Market Analysis computed by Projection Engine
   */
  public getMarketAnalysis(): MarketAnalysis | null {
    const { snapshot } = this.getCurrentSnapshot();
    if (!snapshot) return null;

    const history = StorageEngine.getHistory(100);
    return ProjectionEngine.analyzeMarket(snapshot, history);
  }

  /**
   * Gets Market Projections computed by Projection Engine
   */
  public getMarketProjections(): MarketProjections | null {
    const { snapshot } = this.getCurrentSnapshot();
    if (!snapshot) return null;

    /*
     * TWO WINDOWS, because two consumers need different things.
     *
     * `history` is the statistical window: 100 records, unchanged, and the
     * basis of every projection figure. `timelineHistory` is the session day
     * the hourly chart draws, which needs every tick of the last 24 hours -
     * asking it to render thirteen hour-buckets out of 99 minutes of data is
     * what produced "11 of the 13 past hours have no tick" while those ticks
     * sat on disk.
     *
     * Bounded by TIME, not by count, and read from the same in-memory array,
     * so it costs a filter rather than a disk read.
     */
    const history = StorageEngine.getHistory(100);
    const timelineHistory = StorageEngine.getHistory(
      undefined,
      Date.now() - TIMELINE_WINDOW_MS
    );
    const analysis = ProjectionEngine.analyzeMarket(snapshot, history);
    return ProjectionEngine.generateProjections(
      snapshot,
      history,
      analysis,
      undefined,
      timelineHistory
    );
  }

  /**
   * Gets Backtest Metrics from real historical dataset
   */
  public getBacktestMetrics(): BacktestMetrics {
    const history = StorageEngine.getHistory();
    return ProjectionEngine.runBacktest(history);
  }

  /**
   * Walk-forward backtest of the production projection engine.
   *
   * source is REAL_HISTORY because StorageEngine is the persisted store this
   * process actually writes to - the file under DATA_DIR, not a fixture. A
   * test calling BacktestEngine.run directly passes SYNTHETIC_FIXTURE and its
   * output can never be mistaken for market evidence.
   */
  public getWalkForwardBacktest(): WalkForwardBacktestResult {
    const history = StorageEngine.getHistory();
    return BacktestEngine.run(history, 'REAL_HISTORY');
  }

  /**
   * Bank Multi-Filter Matrix Aggregator
   * Queries real Binance order book across requested banks and amounts
   */
  public async getExecutableMatrix(forceRefresh = false): Promise<{
    executableMatrix: ExecutableMatrix;
    marketReference: MarketReference;
  }> {
    const isCacheFresh =
      this.bankMatrixCache && Date.now() - this.bankMatrixCache.timestamp < MATRIX_STALE_AFTER_MS;
    if (forceRefresh || !isCacheFresh) {
      await this.refreshBankMatrix();
    }

    const cache = this.bankMatrixCache;
    const bankOrder = Object.keys(BANK_CODE_MAP);
    const bankDisplayNames: Record<string, string> = {};
    for (const bank of bankOrder) bankDisplayNames[bank] = BANK_CODE_MAP[bank].displayName;

    /*
     * ONE derivation, shared with the opportunity engine and therefore with
     * Telegram. The matrix the interface renders and the opportunity the bot
     * announces are computed from the same evaluateBankTiers result over the
     * same captured book - there is no second calculation to disagree with.
     */
    const executableMatrix = buildExecutableMatrix({
      byBank: this.deriveExecutability(cache?.adsByBank ?? {}),
      bankOrder,
      bankDisplayNames,
      amountKeys: AMOUNT_TIERS.map((t) => t.key),
      adCounts: cache?.adCounts ?? {},
      failedBanks: cache?.failedBanks,
      /*
       * The real capture instant of the book behind every cell. Never Date.now()
       * at render time: that would make a stale cell look fresh.
       */
      capturedAt: cache?.timestamp ?? 0,
    });

    const { snapshot, effectiveStatus, ageSeconds } = this.getCurrentSnapshot();

    return {
      executableMatrix,
      marketReference: buildMarketReference(snapshot, effectiveStatus, ageSeconds),
    };
  }

  /**
   * Executability for every BANK x AMOUNT x SIDE, derived from the ads the
   * bank matrix already captured.
   *
   * Reads `adsByBank` and issues NO request of its own: the 6 amount tiers are
   * filtered in memory from the same 14 responses per cycle. Refreshing the
   * matrix when the cache is cold is the only thing that talks to Binance, and
   * that is the refresh the matrix would have done anyway.
   */
  public async getExecutability(forceRefresh = false): Promise<{
    timestamp: number;
    byBank: Record<string, Record<string, BankAmountExecutability>>;
    amountKeys: string[];
  }> {
    const isCacheFresh = this.bankMatrixCache && Date.now() - this.bankMatrixCache.timestamp < MATRIX_STALE_AFTER_MS;
    if (forceRefresh || !isCacheFresh) {
      await this.refreshBankMatrix();
    }

    const cache = this.bankMatrixCache;
    const byBank = this.deriveExecutability(cache?.adsByBank ?? {});

    return {
      timestamp: cache?.timestamp ?? Date.now(),
      byBank,
      amountKeys: AMOUNT_TIERS.map((t) => t.key),
    };
  }

  /**
   * The best executable operation available right now, or null.
   *
   * Derived from the SAME captured book the bank matrix uses. Refreshing when
   * the cache is cold is the refresh the matrix would have done anyway - no
   * query is issued on behalf of opportunities.
   */
  public async getOpportunities(forceRefresh = false): Promise<{
    timestamp: number;
    result: OpportunityEngineResult;
  }> {
    const isCacheFresh = this.bankMatrixCache && Date.now() - this.bankMatrixCache.timestamp < MATRIX_STALE_AFTER_MS;
    if (forceRefresh || !isCacheFresh || this.lastOpportunities === null) {
      await this.refreshBankMatrix();
    }

    return {
      timestamp: this.bankMatrixCache?.timestamp ?? Date.now(),
      result: this.lastOpportunities ?? { opportunities: [], byBank: {}, bestOpportunity: null, context: {} },
    };
  }

  /**
   * The payType mapping assessment. NOT_VERIFIABLE until a poll has observed
   * real ads - never optimistic about a question nobody has answered.
   */
  public getPayTypeMapping(): PayTypeMappingReport {
    if (this.payTypeMapping !== null) return this.payTypeMapping;

    /*
     * Nothing polled yet. Built by the same assessor over an empty sample, so
     * there is one definition of the report and not a hand-written copy that
     * can drift from it.
     */
    return assessPayTypeMapping([], BANK_CODE_MAP, {
      buyAds: 0,
      sellAds: 0,
      totalAds: 0,
      paymentMethodEntries: 0,
    });
  }

  /** Cached best opportunity. null when none exists OR none was computed yet. */
  public getCachedBestOpportunity(): Opportunity | null {
    return this.lastOpportunities?.bestOpportunity ?? null;
  }

  /** One executability evaluation, shared by the matrix and the opportunities. */
  private deriveExecutability(
    adsByBank: Record<string, { buy: NormalizedAd[]; sell: NormalizedAd[] }>
  ): Record<string, Record<string, BankAmountExecutability>> {
    const byBank: Record<string, Record<string, BankAmountExecutability>> = {};
    for (const bankKey of Object.keys(BANK_CODE_MAP)) {
      const ads = adsByBank[bankKey];
      byBank[bankKey] = evaluateBankTiers({
        bank: bankKey,
        allowedCodes: BANK_CODE_MAP[bankKey].apiPayTypes,
        buyAds: ads?.buy ?? [],
        sellAds: ads?.sell ?? [],
      });
    }
    return byBank;
  }

  private async refreshBankMatrix(): Promise<void> {
    /*
     * One refresh at a time.
     *
     * Now load-bearing for the autonomous interval as well as for concurrent
     * HTTP readers: if a refresh takes longer than MATRIX_STALE_AFTER_MS the
     * next tick returns immediately instead of starting a second pass, so 14
     * requests can never become 28 and two engine runs can never race to
     * overwrite lastOpportunities out of order.
     */
    if (this.matrixPollingInProgress) return;
    this.matrixPollingInProgress = true;

    try {
      const banks = Object.keys(BANK_CODE_MAP);
      const amounts = [
        { key: '10K', val: 10000 },
        { key: '20K', val: 20000 },
        { key: '30K', val: 30000 },
        { key: '40K', val: 40000 },
        { key: '50K', val: 50000 },
        { key: '100K', val: 100000 },
      ];

      const adsByBank: Record<string, { buy: NormalizedAd[]; sell: NormalizedAd[] }> = {};
      const adCounts: Record<string, { buy: number; sell: number }> = {};
      const failedBanks = new Set<string>();

      // Query banks in sequence or controlled chunks to avoid rate limits
      for (const bankKey of banks) {
        const bankConfig = BANK_CODE_MAP[bankKey];

        /*
         * ONE query per bank per side. Unchanged: 7 banks x 2 sides = 14
         * requests per cycle. The six amount tiers are evaluated in memory by
         * evaluateBankTiers over these same ads, so adding tiers costs nothing
         * and no tier is ever served a price fetched for a different amount.
         */
        try {
          const [rawBuyAds, rawSellAds] = await Promise.all([
            /*
             * rows: 20, the only page size this project has OBSERVED Binance
             * accept - it is what the unfiltered snapshot query uses, and that
             * query works in production.
             *
             * This was 50, introduced with a comment asserting 50 was
             * Binance's page size. That was an assumption, not an
             * observation, and production answered every bank query with
             * "000002 illegal parameter" - including BANESCO, whose payType
             * Binance demonstrably publishes. A valid filter with an invalid
             * page size leaves the page size as the cause.
             *
             * The request count is unchanged: one query per bank per side.
             * Depth drops from 50 ads to 20, which may leave the 50K/100K
             * tiers empty for want of book rather than for want of an offer -
             * a smaller problem than the entire matrix being down.
             */
            BinanceP2PService.queryP2PAds({
              tradeType: 'BUY',
              payTypes: bankConfig.apiPayTypes,
              rows: 20,
            }),
            BinanceP2PService.queryP2PAds({
              tradeType: 'SELL',
              payTypes: bankConfig.apiPayTypes,
              rows: 20,
            }),
          ]);

          const normalizedBuy = BinanceP2PService.normalizeAds(rawBuyAds);
          const normalizedSell = BinanceP2PService.normalizeAds(rawSellAds);

          // Reusable by FASE 4 without a single extra request to Binance.
          adsByBank[bankKey] = { buy: normalizedBuy, sell: normalizedSell };

          adCounts[bankKey] = { buy: normalizedBuy.length, sell: normalizedSell.length };

          /*
           * FASE 5: bank verification is now ENFORCED, not merely reported.
           *
           * evaluateAd rejects any ad whose payType does not match one of this
           * bank's canonical codes exactly, so an ad that reached this response
           * without belonging to the bank can no longer produce a rate. The
           * count is still logged because an all-zero bank is the signature of
           * a wrong code in BANK_CODE_MAP, and that has to stay visible.
           */
          const verifiedBuy = countVerifications(normalizedBuy, bankConfig.apiPayTypes);
          const verifiedSell = countVerifications(normalizedSell, bankConfig.apiPayTypes);
          if (verifiedBuy.verified === 0 && verifiedSell.verified === 0 &&
              normalizedBuy.length + normalizedSell.length > 0) {
            console.warn(
              `[CentralStore] ${bankKey}: ninguno de los ` +
                `${normalizedBuy.length + normalizedSell.length} anuncios devueltos verifica ` +
                `contra sus codigos canonicos. Revisar BANK_CODE_MAP.`
            );
          }
        } catch (err) {
          console.warn(`[CentralStore] Bank matrix fetch failed for ${bankKey}:`, err);
          failedBanks.add(bankKey);
          adCounts[bankKey] = { buy: 0, sell: 0 };
        }
      }

      this.bankMatrixCache = {
        timestamp: Date.now(),
        failedBanks,
        adCounts,
        adsByBank,
      };

      /*
       * EXECUTABLE -> OPPORTUNITY, from the book just captured. Pure
       * computation over data already in memory: zero additional requests.
       */
      this.lastOpportunities = runOpportunityEngine({
        byBank: this.deriveExecutability(adsByBank),
        bankOrder: Object.keys(BANK_CODE_MAP),
      });
    } catch (err) {
      console.error('[CentralStore] Error refreshing bank matrix:', err);
    } finally {
      this.matrixPollingInProgress = false;
    }
  }

  private evaluateAlerts(snapshot: MarketSnapshot): void {
    /*
     * Opportunity lifecycle, once per pass and independent of the alert rules.
     *
     * Guarded on lastOpportunities having been computed at all: null there
     * means "not evaluated yet", which must never be reported as a position
     * closing. Only once the engine has produced an answer does a null best
     * opportunity mean the book no longer holds one.
     *
     * The notifier dedups by position, so calling this every poll produces one
     * DETECTED, then silence until the cooldown allows an UPDATED.
     */
    if (this.lastOpportunities !== null) {
      void TelegramNotifier.getInstance().notifyOpportunityLifecycle(
        this.lastOpportunities.bestOpportunity ?? null,
        snapshot.timestamp,
        this.bankMatrixCache?.timestamp ?? null
      );
    }

    const rules = StorageEngine.getAlerts().filter((r) => r.enabled);
    const now = Date.now();

    for (const rule of rules) {
      // Prevent rapid spam triggers (minimum 5 minutes between triggers for same rule)
      if (rule.lastTriggeredAt && now - rule.lastTriggeredAt < 300000) {
        continue;
      }

      /*
       * FASE 2: alerts decide on the STRATEGIC price, never on the extremes.
       *
       * targetSide 'BUY' is the repurchase price (Binance BUY, what I pay);
       * 'SELL' is the sale price (Binance SELL, what I receive). Reading
       * bestBuyPrice / bestSellPrice here is what let a single 980 VES ad on
       * one side of the book fire Telegram: max(SELL) tracks the furthest ad,
       * not the market.
       */
      const targetPrice =
        rule.targetSide === 'BUY' ? snapshot.strategicBuyPrice : snapshot.strategicSellPrice;
      const spreadPct = snapshot.strategicSpreadPct;
      /*
       * Read from cache only. Computing it here would force a bank-matrix
       * refresh on every 6s poll and multiply the request budget; the cached
       * value is refreshed by refreshBankMatrix at most every 45s.
       *
       * null means "no verifiable opportunity right now" OR "not computed
       * yet". Neither may fire an alert - a missing opportunity is never
       * reported as one.
       */
      const opportunity = this.getCachedBestOpportunity();
      let triggered = false;
      let message = '';

      /*
       * C2: a rule cannot fire on a price that does not exist. Previously a
       * missing side surfaced as 0, which made every BELOW rule fire.
       */
      const needsPrice = rule.condition === 'ABOVE' || rule.condition === 'BELOW';
      if (needsPrice && targetPrice === null) continue;
      if (
        (rule.condition === 'SPREAD_ABOVE' || rule.condition === 'VOLATILITY_SPIKE') &&
        spreadPct === null
      ) {
        continue;
      }
      if (rule.condition === 'OPPORTUNITY_ABOVE' && opportunity === null) continue;

      switch (rule.condition) {
        case 'ABOVE':
          if (targetPrice !== null && targetPrice >= rule.targetValue) {
            triggered = true;
            message = `Precio estratégico ${rule.targetSide} (${targetPrice.toFixed(2)} VES) superó el umbral de ${rule.targetValue} VES.`;
          }
          break;
        case 'BELOW':
          if (targetPrice !== null && targetPrice <= rule.targetValue) {
            triggered = true;
            message = `Precio estratégico ${rule.targetSide} (${targetPrice.toFixed(2)} VES) cayó por debajo de ${rule.targetValue} VES.`;
          }
          break;
        case 'SPREAD_ABOVE':
          if (spreadPct !== null && spreadPct >= rule.targetValue) {
            triggered = true;
            message = `Spread estratégico (${spreadPct.toFixed(2)}%) superó el umbral de ${rule.targetValue}%.`;
          }
          break;
        case 'OPPORTUNITY_ABOVE':
          /*
           * Fires on a real operation: same bank, same amount, both legs
           * executable, liquidity established on both. Never on a spread
           * between two ads nobody can pair.
           */
          if (
            opportunity !== null &&
            opportunity.verification === 'VERIFIED' &&
            opportunity.marginPct >= rule.targetValue
          ) {
            triggered = true;
            message =
              `Oportunidad ejecutable en ${opportunity.bank} para ` +
              `${opportunity.amountVes} VES: recompra ${opportunity.buyPrice.toFixed(2)}, ` +
              `venta ${opportunity.sellPrice.toFixed(2)}, margen bruto ` +
              `${opportunity.marginPct.toFixed(4)}%.`;
          }
          break;
        case 'VOLATILITY_SPIKE':
          if (spreadPct !== null && spreadPct > rule.targetValue * 1.5) {
            triggered = true;
            message = `Spread estratégico (${spreadPct.toFixed(2)}%) superó ${(rule.targetValue * 1.5).toFixed(2)}% en el libro Binance P2P.`;
          }
          break;
      }

      if (triggered) {
        /*
         * Unreachable in practice: every branch that sets `triggered` already
         * required a non-null price (ABOVE/BELOW skip early, and a non-null
         * spread implies both sides exist). The guard keeps the persisted
         * AlertTriggerLog schema free of nulls without touching storage.ts.
         */
        // An opportunity alert logs the sale price of the operation it reports;
        // every other condition already required a non-null strategic price.
        const loggedPrice =
          rule.condition === 'OPPORTUNITY_ABOVE' ? (opportunity?.sellPrice ?? null) : targetPrice;
        if (loggedPrice === null) continue;

        rule.lastTriggeredAt = now;
        StorageEngine.saveAlert(rule);

        const log: AlertTriggerLog = {
          id: `trigger-${now}-${Math.random().toString(36).substr(2, 5)}`,
          ruleId: rule.id,
          ruleName: rule.name,
          message,
          price: loggedPrice,
          timestamp: now,
        };
        StorageEngine.logTrigger(log);
        console.log(`[Alerts] TRIGGERED: ${message}`);

        /*
         * Notification only. Fire-and-forget by design: notifyAlert never
         * throws and never rejects, so a Telegram outage cannot interrupt the
         * alert loop, the polling cycle or persistence.
         */
        void TelegramNotifier.getInstance().notifyAlert(
          log,
          rule,
          snapshot,
          opportunity,
          this.bankMatrixCache?.timestamp ?? null
        );
      }
    }
  }
}
