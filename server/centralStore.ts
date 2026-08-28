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
import { AMOUNT_TIERS, evaluateBankAmount } from './executability.js';
import {
  EMPTY_MAKER_ALERT_STATE,
  evaluateMakerAlerts,
  type MakerAlertState,
} from './makerAlerts.js';
import {
  EMPTY_DIGEST_STATE,
  startDigestState,
  accumulatePriceChange,
  readPriceChangeInterval,
  releasePriceChangeDigest,
  type PriceChangeDigestState,
} from './alertScheduler.js';
import { buildMakerMatrix, type MakerMatrix } from './makerMatrix.js';
import {
  HistoricalMarketStore,
  type HistoricalObservation,
} from './historicalMarketStore.js';
import { projectCell, type CellProjection } from './makerProjectionEngine.js';
import {
  EMPTY_SIGNAL_MEMORY,
  evaluateSignals,
  type MarketSignal,
  type SignalMemory,
} from './signalEngine.js';
import type { CapturedListings } from './makerRecommendation.js';
import { readMakerConfig, type MakerConfig } from './makerStrategy.js';
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
  MATRIX_REFRESH_MS,
  MATRIX_STALE_AFTER_MS,
  buildExecutableMatrix,
  buildMarketReference,
} from './executableMatrix.js';
import { mapBinanceAdToArbitrageLeg } from './arbitrageSides.js';
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
  /** Which amount tier the next refresh will ask Binance about. */
  private matrixTierCursor = 0;

  /**
   * How often a capture arrived too incomplete to record, and in what way.
   *
   * A gap in the history is either "Binance had nothing to say" or "we lost
   * it". These counters separate the two from outside the process, which is
   * the only way to tell whether the skip policy is costing anything real.
   */
  private completeSnapshots = 0;
  private incompleteSnapshots = {
    total: 0,
    /** No ad on the ASK side: nothing to buy. */
    askSideEmpty: 0,
    /** No ad on the BID side: nothing to sell into. */
    bidSideEmpty: 0,
    bothSidesEmpty: 0,
    /** Both prices present, spread absent. */
    spreadMissing: 0,
    lastAt: null as number | null,
  };
  private isPolling = false;
  /**
   * The captured book, PER AMOUNT TIER.
   *
   * Each tier holds the ads Binance returned for THAT amount, and nothing is
   * ever shared between tiers: a cell can only be built from ads fetched for
   * its own amount, so no price can leak from 20K into 50K. Each tier carries
   * its own capturedAt, because they are refreshed on a rotation and their
   * ages genuinely differ.
   */
  /**
   * Read once at construction. Empty by design: the operator asked for the
   * exclusion capability to exist and to stay unconfigured until they publish
   * ads under a nickname worth excluding.
   */
  private readonly makerConfig: MakerConfig = readMakerConfig();

  /**
   * What Telegram has already said: the recommended prices per BANCO x MONTO,
   * and when the last periodic summary went out. In memory only - a restart
   * re-sends the summary and re-learns the prices silently, which is the safe
   * direction: it can repeat itself, never invent a change that did not happen.
   */
  private makerAlertState: MakerAlertState = EMPTY_MAKER_ALERT_STATE;

  /**
   * Price changes waiting to be sent as one grouped message.
   *
   * Detection stays immediate; delivery waits for the interval.
   *
   * IN MEMORY ON PURPOSE, and this is the whole persistence strategy for the
   * notification clocks. A restart drops the pending window and resets the
   * interval, and neither can produce spam:
   *
   *   - makerAlertState.recommended comes back empty, so every cell is a FIRST
   *     observation, and a first observation is silent by construction
   *     (evaluateMakerAlerts returns early when `previous === undefined`).
   *     A restart therefore cannot republish prices the operator already had.
   *   - lastReleasedAt is re-anchored at boot by start(), so the first digest
   *     after a restart is due a full interval later, not immediately.
   *
   * What a restart does cost is at most one pending digest - changes detected
   * in the open window are forgotten. That is the correct trade: the next
   * summary carries every current price 30 minutes later at the latest, and
   * persisting the window would risk announcing a "change" against a baseline
   * from before an outage, which is exactly the kind of invented event Regla 5
   * forbids. The one message a restart does add is the boot summary, which is
   * the operator asking for it by restarting.
   */
  /**
   * INTERNAL EVENT COUNTERS. Diagnostic only - nothing reads them to decide
   * anything.
   *
   * "How many Telegram messages did that market produce" is only half an
   * answer: without the number of internal events behind them there is no way
   * to tell a quiet market from a loud market that is being suppressed
   * correctly. These are the denominators of that ratio, and the functional
   * simulations print them.
   */
  private eventCounters = {
    /** Matrix sweeps completed. */
    sweeps: 0,
    /** PRICE_CHANGE alerts detected, before any grouping or delivery gate. */
    priceChangesDetected: 0,
    /** Signals the engine derived, before dedup, cooldown or the INFO drop. */
    signalsDerived: 0,
  };

  /** A snapshot of the internal event counters. Diagnostic. */
  public getEventCounters(): { sweeps: number; priceChangesDetected: number; signalsDerived: number } {
    return { ...this.eventCounters };
  }

  private priceChangeDigest: PriceChangeDigestState = EMPTY_DIGEST_STATE;
  private readonly priceChangeIntervalMs: number = readPriceChangeInterval().intervalMs;

  /** Projections and signals from the latest sweep. Recomputed, never stored. */
  private lastProjections: CellProjection[] = [];
  private lastSignals: MarketSignal[] = [];
  /**
   * The trend each cell was last seen in, so a CHANGE can be detected.
   * In memory only: a restart re-learns it silently rather than announcing a
   * change that did not happen.
   */
  private signalMemory: SignalMemory = EMPTY_SIGNAL_MEMORY;

  private bankMatrixCache: {
    /** Last time ANY tier was refreshed. */
    timestamp: number;
    tiers: Record<
      string,
      {
        capturedAt: number;
        adsByBank: Record<string, { buy: NormalizedAd[]; sell: NormalizedAd[] }>;
        adCounts: Record<string, { buy: number; sell: number }>;
        failedBanks: Set<string>;
      }
    >;
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

    /*
     * ONE RHYTHM FOR THE PERIODIC MESSAGES.
     *
     * Every periodic emitter honoured its own thirty minutes and the phone
     * still buzzed every few minutes, because the three clocks were anchored
     * at different instants. Measured on a scripted rising market before this,
     * the merged timeline read:
     *
     *   0m02 SUMMARY | 0m45 DIGEST | 30m45 SUMMARY+DIGEST | 60m45 SUMMARY+DIGEST
     *   81m45 SIGNAL | 90m45 SUMMARY+DIGEST | 111m45 SIGNAL | 120m45 SUMMARY+DIGEST
     *
     * Per stream the gaps were exactly 30.0 minutes - no timer drifted and no
     * interval was reset. As EXPERIENCED they were 21 minutes then 9 minutes,
     * over and over, which is the shape the operator reported.
     *
     * Two different causes, and only one of them is a defect:
     *
     *   1. The digest released its first window as soon as it had anything,
     *      which was the sweep 45 seconds after boot - right behind the boot
     *      summary that had just listed every one of those prices, and again on
     *      every restart. Anchoring the window here makes the first digest due
     *      one whole interval later, which is the shape that was asked for:
     *      13:00 digest, accumulate until 13:29, 13:30 next digest.
     *
     *   2. The projection signals are NOT in phase with either, and that is
     *      left alone deliberately. A signal is not a price change: it answers
     *      "do I have to look at this now", so holding one back to a grid
     *      boundary would delay the only messages that are supposed to be
     *      prompt. They keep their own floors - one shared 30-minute window for
     *      everything below CRITICAL, half that for a confirmed break.
     */
    this.priceChangeDigest = startDigestState(Date.now());

    // Initial fetch immediately
    this.pollMarket();

    this.pollTimer = setInterval(() => {
      this.pollMarket();
    }, this.pollingIntervalMs);

    // First bank matrix population, shortly after the first snapshot.
    this.matrixBootTimer = setTimeout(() => {
      this.matrixBootTimer = null;
      void this.refreshBankMatrix(true);
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
    }, MATRIX_REFRESH_MS);
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
        this.completeSnapshots += 1;
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
        /*
         * MEASURED, NOT CHANGED.
         *
         * The policy stands: an observation with an empty side has no price to
         * record, so nothing is written and the gap in the series is the
         * honest account of what happened. Nothing is invented to fill it.
         *
         * What was missing is how OFTEN this happens. A warning line per
         * occurrence is invisible in a log nobody reads, so the counters are
         * kept and published on /api/health: a capture that silently drops one
         * observation in three is a different system from one that drops one a
         * week, and until now they looked identical from outside.
         */
        this.incompleteSnapshots.total += 1;
        this.incompleteSnapshots.lastAt = snapshot.timestamp;
        if (snapshot.bestBuyPrice === null && snapshot.bestSellPrice === null) {
          this.incompleteSnapshots.bothSidesEmpty += 1;
        } else if (snapshot.bestBuyPrice === null) {
          this.incompleteSnapshots.askSideEmpty += 1;
        } else if (snapshot.bestSellPrice === null) {
          this.incompleteSnapshots.bidSideEmpty += 1;
        } else {
          // Both prices exist but the spread did not: a shape worth naming.
          this.incompleteSnapshots.spreadMissing += 1;
        }

        console.warn(
          '[CentralStore] Snapshot incompleto (BUY o SELL sin anuncios): no se registra en el ' +
            `histórico. Acumulado: ${this.incompleteSnapshots.total} de ` +
            `${this.completeSnapshots + this.incompleteSnapshots.total} observaciones.`
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
      await this.refreshBankMatrix(true);
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
      byBank: this.deriveExecutability(),
      bankOrder,
      bankDisplayNames,
      amountKeys: AMOUNT_TIERS.map((t) => t.key),
      /*
       * Per-tier, because the tiers are refreshed on a rotation and a cell must
       * report the age of ITS OWN book. A single capturedAt would make five of
       * the six tiers look fresher than they are.
       */
      adCountsByTier: this.tierAdCounts(),
      failedBanksByTier: this.tierFailedBanks(),
      capturedAtByTier: this.tierCapturedAt(),
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
      await this.refreshBankMatrix(true);
    }

    const cache = this.bankMatrixCache;
    const byBank = this.deriveExecutability();

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
      await this.refreshBankMatrix(true);
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
  /**
   * Capture completeness, for /api/health.
   *
   * Counts since this process started - deliberately not persisted. A number
   * that survived restarts would mix a fixed problem with a current one.
   */
  public getCaptureStats(): {
    completeSnapshots: number;
    incompleteSnapshots: number;
    incompleteRatePct: number | null;
    askSideEmpty: number;
    bidSideEmpty: number;
    bothSidesEmpty: number;
    spreadMissing: number;
    lastIncompleteAt: string | null;
  } {
    const total = this.completeSnapshots + this.incompleteSnapshots.total;
    return {
      completeSnapshots: this.completeSnapshots,
      incompleteSnapshots: this.incompleteSnapshots.total,
      // null, not 0: with nothing observed there is no rate to report.
      incompleteRatePct:
        total === 0
          ? null
          : Number(((this.incompleteSnapshots.total / total) * 100).toFixed(2)),
      askSideEmpty: this.incompleteSnapshots.askSideEmpty,
      bidSideEmpty: this.incompleteSnapshots.bidSideEmpty,
      bothSidesEmpty: this.incompleteSnapshots.bothSidesEmpty,
      spreadMissing: this.incompleteSnapshots.spreadMissing,
      lastIncompleteAt:
        this.incompleteSnapshots.lastAt === null
          ? null
          : new Date(this.incompleteSnapshots.lastAt).toISOString(),
    };
  }

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
  /**
   * BANK x AMOUNT executability, each cell from the ads fetched for ITS amount.
   *
   * Every tier owns its own captured book, so nothing here can serve a 50K
   * cell a price that Binance returned for a 20K question. evaluateAd still
   * re-checks the ad's own min/max as a second guard: transAmount is Binance
   * filtering for us, and trusting a remote filter we cannot inspect would be
   * exactly the kind of assumption this project keeps paying for.
   */
  /**
   * THE MAKER MATRIX: what price to publish at every BANCO x MONTO.
   *
   * Reads the SAME captured book the executable matrix reads and issues no
   * request of its own. The two matrices answer different questions - "what
   * should I publish?" against "could I take an ad?" - over one capture.
   *
   * The listings are handed over keyed by the tradeType they were REQUESTED
   * with, not by what they mean to me. `adsByBank[bank].buy` is the answer to
   * tradeType='BUY' and `.sell` the answer to tradeType='SELL'; which of the
   * two my buy ad competes in is makerStrategy's business, not this method's,
   * and that is the whole reason the mirror is applied in exactly one place.
   */
  public async getMakerMatrix(forceRefresh = false): Promise<MakerMatrix> {
    const isCacheFresh =
      this.bankMatrixCache && Date.now() - this.bankMatrixCache.timestamp < MATRIX_STALE_AFTER_MS;
    if (forceRefresh || !isCacheFresh) {
      await this.refreshBankMatrix(true);
    }

    const bankOrder = Object.keys(BANK_CODE_MAP);
    const bankDisplayNames: Record<string, string> = {};
    const bankAllowedCodes: Record<string, readonly string[]> = {};
    for (const bank of bankOrder) {
      bankDisplayNames[bank] = BANK_CODE_MAP[bank].displayName;
      bankAllowedCodes[bank] = BANK_CODE_MAP[bank].apiPayTypes;
    }

    return buildMakerMatrix({
      bankOrder,
      bankDisplayNames,
      bankAllowedCodes,
      amounts: AMOUNT_TIERS,
      listingsByTier: this.tierListings(),
      failedBanksByTier: this.tierFailedBanks(),
      capturedAtByTier: this.tierCapturedAt(),
      capturedAt: this.bankMatrixCache?.timestamp ?? 0,
      config: this.makerConfig,
    });
  }

  /**
   * Builds the maker matrix from the book just captured and sends whatever it
   * changed.
   *
   * Failures here must never take down a refresh: the matrix, the executable
   * cells and the opportunity engine are all already computed by this point,
   * and a Telegram outage is not a reason to lose them.
   */
  private announceMakerAlerts(): void {
    try {
      const bankOrder = Object.keys(BANK_CODE_MAP);
      const bankDisplayNames: Record<string, string> = {};
      const bankAllowedCodes: Record<string, readonly string[]> = {};
      for (const bank of bankOrder) {
        bankDisplayNames[bank] = BANK_CODE_MAP[bank].displayName;
        bankAllowedCodes[bank] = BANK_CODE_MAP[bank].apiPayTypes;
      }

      const matrix = buildMakerMatrix({
        bankOrder,
        bankDisplayNames,
        bankAllowedCodes,
        amounts: AMOUNT_TIERS,
        listingsByTier: this.tierListings(),
        failedBanksByTier: this.tierFailedBanks(),
        capturedAtByTier: this.tierCapturedAt(),
        capturedAt: this.bankMatrixCache?.timestamp ?? 0,
        config: this.makerConfig,
      });

      const now = Date.now();
      const { alerts, state } = evaluateMakerAlerts({
        matrix,
        state: this.makerAlertState,
        nowMs: now,
      });

      this.makerAlertState = state;

      /*
       * DETECTION IS IMMEDIATE, DELIVERY IS NOT.
       *
       * Every PRICE_CHANGE is folded into the open window the moment it is
       * detected - that record has to be accurate. What waits is the message:
       * the window is released as one grouped digest on its own interval, so
       * five cells moving in half an hour produce one notification rather than
       * five. The periodic summary is unaffected and still goes through
       * notifyMakerAlerts on its own 30-minute clock.
       */
      this.eventCounters.sweeps += 1;
      for (const alert of alerts) {
        if (alert.kind !== 'PRICE_CHANGE') continue;
        this.eventCounters.priceChangesDetected += 1;
        this.priceChangeDigest = accumulatePriceChange(
          this.priceChangeDigest,
          { cell: alert.cell, pairing: alert.pairing, previous: alert.previous },
          now
        );
      }

      const released = releasePriceChangeDigest(
        this.priceChangeDigest,
        now,
        this.priceChangeIntervalMs
      );
      this.priceChangeDigest = released.state;

      if (alerts.some((a) => a.kind === 'SUMMARY')) {
        void TelegramNotifier.getInstance().notifyMakerAlerts(alerts, now);
      }
      if (released.digest !== null) {
        void TelegramNotifier.getInstance().notifyPriceChangeDigest(released.digest);
      }

      /*
       * PERSISTENCE, then ANALYSIS - in that order, and both over the matrix
       * already in hand. Zero additional requests to Binance: the book was
       * captured by the sweep that just finished.
       */
      this.persistObservations(matrix);
      this.refreshProjections(matrix);
    } catch (err) {
      console.warn('[CentralStore] Maker alert evaluation failed:', err);
    }
  }

  /**
   * Writes one observation per cell whose book actually moved.
   *
   * The sweep rotates one amount tier per tick, so on a normal tick only 7 of
   * the 42 cells carry a new capture. HistoricalMarketStore refuses the other
   * 35 by capturedAt, because storing them again would fill the series with
   * copies of one capture and make every velocity read as zero.
   */
  private persistObservations(matrix: MakerMatrix): void {
    for (const bank of matrix.bankOrder) {
      for (const amountKey of matrix.amountKeys) {
        const cell = matrix.cells[bank]?.[amountKey];
        if (cell === undefined || cell.capturedAt === 0) continue;

        const rec = cell.recommendation;
        const pair = rec?.recommended ?? null;

        const observation: HistoricalObservation = {
          timestamp: cell.capturedAt,
          bank,
          amountKey,
          amountVes: cell.amountVes,

          buyLeaderPrice: rec?.buyAnalysis.leaderPrice ?? null,
          buyRecommendedPrice: pair?.buy.price ?? null,
          sellLeaderPrice: rec?.sellAnalysis.leaderPrice ?? null,
          sellRecommendedPrice: pair?.sell.price ?? null,

          // Filled in by the store against the previous observation.
          buySpreadVsPrevious: null,
          sellSpreadVsPrevious: null,

          grossSpreadVes: pair?.grossMarginVes ?? null,
          grossSpreadPct: pair?.grossMarginPct ?? null,

          buyPosition: pair?.buy.position ?? null,
          sellPosition: pair?.sell.position ?? null,

          buyAvailableUsdt: pair?.buy.queueAheadUsdt ?? null,
          sellAvailableUsdt: pair?.sell.queueAheadUsdt ?? null,

          buyCompetitorCount: rec?.buyAnalysis.competitors ?? 0,
          sellCompetitorCount: rec?.sellAnalysis.competitors ?? 0,

          marketStatus: cell.status,

          tick: rec?.buyAnalysis.tick ?? null,
          tickProvenance: rec?.buyAnalysis.tickProvenance ?? 'NOT_VERIFIABLE',

          /*
           * PROVENANCE SURVIVES A CELL WITH NO PROFITABLE PAIR.
           *
           * It used to be dropped whenever `recommended` was null, which threw
           * away the leading ads of every cell that happened to have no
           * positive margin that minute - precisely the observations somebody
           * auditing a flat or inverted stretch would want. The leaders are
           * known whether or not a pair pays, so they are recorded.
           */
          provenance:
            rec === null
              ? null
              : {
                  buy: CentralMarketStore.leaderAd(rec.buyAnalysis, 'SELL'),
                  sell: CentralMarketStore.leaderAd(rec.sellAnalysis, 'BUY'),
                  capturedAt: cell.capturedAt,
                },
        };

        HistoricalMarketStore.record(observation, cell.capturedAt);
      }
    }
  }

  /**
   * The leading ad of one side, as provenance.
   *
   * Taken from the ladder's first entry, which IS the leader by construction -
   * not from the recommendation, which may not exist. The tradeType is
   * restated from the maker model and never re-derived here.
   */
  private static leaderAd(
    analysis: { ladder: readonly { advNo: string; merchant: string; price: number }[] },
    tradeType: 'BUY' | 'SELL'
  ): { advNo: string; merchant: string; price: number; tradeType: 'BUY' | 'SELL' } | null {
    const leader = analysis.ladder[0];
    if (leader === undefined) return null;
    return {
      advNo: leader.advNo,
      merchant: leader.merchant,
      price: leader.price,
      tradeType,
    };
  }

  /**
   * Recomputes every cell's projection from its own series, and evaluates the
   * signals that follow.
   *
   * Pure computation over data already on disk and in memory. The signal
   * memory walks forward exactly as the backtest replays it, so what the
   * operator is told now is what the backtest would have said then.
   */
  private refreshProjections(matrix: MakerMatrix): void {
    const projections: CellProjection[] = [];

    /*
     * THE GENERAL MARKET, for cells too thin to be read on their own.
     *
     * Every cell's observations in one chronological list. It is NEVER merged
     * into a cell's own series - projectCell uses one or the other and labels
     * which - because a Banesco 10K trend built partly from Mercantil 100K
     * would describe neither.
     */
    const generalSeries: HistoricalObservation[] = [];
    for (const bank of matrix.bankOrder) {
      for (const amountKey of matrix.amountKeys) {
        generalSeries.push(...HistoricalMarketStore.load(bank, amountKey));
      }
    }
    generalSeries.sort((a, b) => a.timestamp - b.timestamp);

    for (const bank of matrix.bankOrder) {
      for (const amountKey of matrix.amountKeys) {
        const cell = matrix.cells[bank]?.[amountKey];
        if (cell === undefined) continue;

        const pair = cell.recommendation?.recommended ?? null;
        projections.push(
          projectCell({
            bank,
            bankDisplayName: cell.bankDisplayName,
            amountKey,
            amountVes: cell.amountVes,
            series: HistoricalMarketStore.load(bank, amountKey),
            currentBuyPrice: pair?.buy.price ?? null,
            currentSellPrice: pair?.sell.price ?? null,
            generalSeries,
          })
        );
      }
    }

    const evaluated = evaluateSignals({ projections, memory: this.signalMemory });
    this.signalMemory = evaluated.memory;
    this.lastProjections = projections;
    this.lastSignals = evaluated.signals;

    /*
     * Signals reach Telegram through the SAME notifier as the maker summary,
     * so the one-voice rule from the maker phase still holds: nothing here
     * introduces a second emitter, and the notifier deduplicates by what a
     * signal says rather than by when it was derived.
     */
    if (evaluated.signals.length > 0) {
      this.eventCounters.signalsDerived += evaluated.signals.length;
      void TelegramNotifier.getInstance().notifyMarketSignals(evaluated.signals, Date.now());
    }
  }

  /** The latest projection per cell, or an empty list before the first sweep. */
  public getProjections(): { projections: CellProjection[]; signals: MarketSignal[] } {
    return { projections: this.lastProjections, signals: this.lastSignals };
  }

  /** The captured books, keyed by the tradeType each was requested with. */
  private tierListings(): Record<string, Record<string, CapturedListings>> {
    const out: Record<string, Record<string, CapturedListings>> = {};
    for (const [key, tier] of Object.entries(this.bankMatrixCache?.tiers ?? {})) {
      out[key] = {};
      for (const [bank, ads] of Object.entries(tier.adsByBank)) {
        out[key][bank] = { BUY: ads.buy, SELL: ads.sell };
      }
    }
    return out;
  }

  private deriveExecutability(): Record<string, Record<string, BankAmountExecutability>> {
    const byBank: Record<string, Record<string, BankAmountExecutability>> = {};
    const tiers = this.bankMatrixCache?.tiers ?? {};

    for (const bankKey of Object.keys(BANK_CODE_MAP)) {
      byBank[bankKey] = {};
      for (const tier of AMOUNT_TIERS) {
        const captured = tiers[tier.key];
        const ads = captured?.adsByBank[bankKey];
        byBank[bankKey][tier.key] = evaluateBankAmount({
          bank: bankKey,
          allowedCodes: BANK_CODE_MAP[bankKey].apiPayTypes,
          amountVes: tier.val,
          buyAds: ads?.buy ?? [],
          sellAds: ads?.sell ?? [],
        });
      }
    }
    return byBank;
  }

  /** When each tier was captured, for per-cell freshness. */
  private tierCapturedAt(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, tier] of Object.entries(this.bankMatrixCache?.tiers ?? {})) {
      out[key] = tier.capturedAt;
    }
    return out;
  }

  private tierAdCounts(): Record<string, Record<string, { buy: number; sell: number }>> {
    const out: Record<string, Record<string, { buy: number; sell: number }>> = {};
    for (const [key, tier] of Object.entries(this.bankMatrixCache?.tiers ?? {})) {
      out[key] = tier.adCounts;
    }
    return out;
  }

  private tierFailedBanks(): Record<string, ReadonlySet<string>> {
    const out: Record<string, ReadonlySet<string>> = {};
    for (const [key, tier] of Object.entries(this.bankMatrixCache?.tiers ?? {})) {
      out[key] = tier.failedBanks;
    }
    return out;
  }

  /**
   * Refreshes the bank matrix.
   *
   * `fullSweep` fetches every amount tier in one pass - 7 banks x 2 sides x 6
   * tiers = 84 requests. That is the right cost exactly once, at boot or when
   * a caller finds the cache cold, because a matrix showing one populated tier
   * and five STALE ones is not a usable answer.
   *
   * Steady state rotates instead: one tier per tick, 14 requests, full sweep
   * every six ticks.
   */
  private async refreshBankMatrix(fullSweep = false): Promise<void> {
    /*
     * One refresh at a time.
     *
     * Now load-bearing for the autonomous interval as well as for concurrent
     * HTTP readers: if a refresh takes longer than MATRIX_REFRESH_MS the
     * next tick returns immediately instead of starting a second pass, so 14
     * requests can never become 28 and two engine runs can never race to
     * overwrite lastOpportunities out of order.
     */
    if (this.matrixPollingInProgress) return;
    this.matrixPollingInProgress = true;

    try {
      const banks = Object.keys(BANK_CODE_MAP);

      /*
       * ONE TIER PER REFRESH, rotating.
       *
       * Each tick asks Binance for the amount it is about to evaluate, so the
       * ads it gets back are the ads that actually accept that amount. The
       * request count per tick is unchanged - 7 banks x 2 sides = 14 - and the
       * whole six-tier sweep completes in six ticks.
       */
      const tiersToFetch = fullSweep
        ? [...AMOUNT_TIERS]
        : [AMOUNT_TIERS[this.matrixTierCursor % AMOUNT_TIERS.length]];
      if (!fullSweep) {
        this.matrixTierCursor = (this.matrixTierCursor + 1) % AMOUNT_TIERS.length;
      }

      for (const tier of tiersToFetch) {

      const adsByBank: Record<string, { buy: NormalizedAd[]; sell: NormalizedAd[] }> = {};
      const adCounts: Record<string, { buy: number; sell: number }> = {};
      const failedBanks = new Set<string>();

      // Query banks in sequence or controlled chunks to avoid rate limits
      for (const bankKey of banks) {
        const bankConfig = BANK_CODE_MAP[bankKey];

        try {
          /*
           * transAmount, so the depth problem stops costing real operations.
           *
           * Without it Binance returns the top 20 ads ORDERED BY PRICE, and a
           * cheap ad that only accepts 50K sits below twenty ads that do not -
           * invisible, so the 50K cell reported NO_AD while the operation
           * existed. That is a false negative, and the honest fix is to ask
           * Binance the question the cell actually asks.
           *
           * One tier per refresh, all banks, both sides: still 14 requests per
           * tick, and the full six-tier sweep completes in six ticks. Asking
           * for every tier at once would be 84 requests every 45s, which is a
           * different system with a different rate-limit risk.
           *
           * A tier's ads are ONLY ever used for that tier. Nothing is shared
           * across amounts, so no cell can inherit a price fetched for another.
           */
          const [rawBuyAds, rawSellAds] = await Promise.all([
            BinanceP2PService.queryP2PAds({
              // ASK side: ads SELLING USDT, which is my purchase.
              tradeType: mapBinanceAdToArbitrageLeg('BUY').tradeType,
              payTypes: bankConfig.apiPayTypes,
              transAmount: tier.val,
              rows: 20,
            }),
            BinanceP2PService.queryP2PAds({
              // BID side: ads BUYING USDT, which is my sale.
              tradeType: mapBinanceAdToArbitrageLeg('SELL').tradeType,
              payTypes: bankConfig.apiPayTypes,
              transAmount: tier.val,
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

      /*
       * MERGE, not replace. Only this tick's tier was refetched; the other
       * tiers keep the book and the capturedAt they were captured with.
       */
      this.bankMatrixCache = {
        timestamp: Date.now(),
        tiers: {
          ...(this.bankMatrixCache?.tiers ?? {}),
          [tier.key]: {
            capturedAt: Date.now(),
            adsByBank,
            adCounts,
            failedBanks,
          },
        },
      };
      }

      /*
       * EXECUTABLE -> OPPORTUNITY, from the book just captured. Pure
       * computation over data already in memory: zero additional requests.
       */
      this.lastOpportunities = runOpportunityEngine({
        byBank: this.deriveExecutability(),
        bankOrder: Object.keys(BANK_CODE_MAP),
      });

      /*
       * MAKER SIDE, from the same capture and with no request of its own.
       *
       * Announced BEFORE the opportunity lifecycle in wall-clock terms only
       * because this is where the book has just landed; the two are
       * independent, answer different questions and share no state.
       */
      this.announceMakerAlerts();
    } catch (err) {
      console.error('[CentralStore] Error refreshing bank matrix:', err);
    } finally {
      this.matrixPollingInProgress = false;
    }
  }

  private evaluateAlerts(snapshot: MarketSnapshot): void {
    /*
     * THE ARBITRAGE LIFECYCLE ANNOUNCEMENT USED TO BE HERE, and it is gone.
     *
     * It ran on the 6-second poll and pushed the taker engine's
     * BEST_OPPORTUNITY to Telegram as "OPORTUNIDAD DE ARBITRAJE", with legs
     * labelled from the Binance ASK/BID sides. The operator is a maker: that
     * mapping is inverted for them, and the whole message answered a question
     * they never asked. lastOpportunities is still computed and still feeds
     * /api/market/opportunities and the executable matrix screen; what it no
     * longer has is a path to Telegram.
     *
     * Telegram's market voice is now announceMakerAlerts, and only that.
     */

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
       * OPPORTUNITY_ABOVE IS REFUSED HERE, before anything else looks at it.
       *
       * It fired on the taker engine's BEST_OPPORTUNITY, which is the model
       * Telegram no longer speaks. The condition still exists in the AlertRule
       * type because saved rule files may contain it, and rewriting a user's
       * stored rules is not this phase's business - so the rule is kept,
       * disabled at the only place that could give it a voice.
       */
      if (rule.condition === 'OPPORTUNITY_ABOVE') continue;

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
        /*
         * No 'OPPORTUNITY_ABOVE' case: the rule is refused above and can never
         * reach this switch.
         */
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
        const loggedPrice = targetPrice;
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
         * NO TELEGRAM CALL HERE, and there must never be one again.
         *
         * This line used to read
         *   void TelegramNotifier.getInstance().notifyAlert(log, rule, snapshot);
         * and it ran on the 6-second poll. It is what produced
         * "🟢 ALERTA DE PRECIO", "🔴 ALERTA P2P" and "⚠️ ALTA VOLATILIDAD".
         * A market level crossing a number is not a maker decision, so the
         * whole class is gone: notifyAlert and formatAlertMessage no longer
         * exist on TelegramNotifier.
         *
         * The trigger is still logged above. That log is read by /api/alerts
         * and shown in src/AlertsManager.tsx - an in-app history the operator
         * opens deliberately, which is a different thing from a push message.
         */
      }
    }
  }
}
