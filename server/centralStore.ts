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
  BankMatrixRow,
  AlertRule,
  AlertTriggerLog,
  BacktestMetrics,
} from './types.js';
import { BinanceP2PService, BANK_CODE_MAP } from './binanceP2PService.js';
import { StorageEngine } from './storage.js';
import { ProjectionEngine } from './projectionEngine.js';
import { TelegramNotifier } from './telegramNotifier.js';

export class CentralMarketStore {
  private static instance: CentralMarketStore;

  private currentSnapshot: MarketSnapshot | null = null;
  private lastValidSnapshot: MarketSnapshot | null = null;
  private pollingIntervalMs = 6000; // 6 seconds for fast live updates
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private bankMatrixCache: { timestamp: number; buyMatrix: BankMatrixRow[]; sellMatrix: BankMatrixRow[] } | null = null;
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

    // Also trigger initial bank matrix population
    setTimeout(() => {
      this.refreshBankMatrix();
    }, 2000);
  }

  public stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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
        };

        StorageEngine.appendRecord(record);
      } else {
        console.warn(
          '[CentralStore] Snapshot incompleto (BUY o SELL sin anuncios): no se registra en el histórico.'
        );
      }

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
        };
      }
      return this.currentSnapshot;
    } finally {
      this.isPolling = false;
    }
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

    const history = StorageEngine.getHistory(100);
    const analysis = ProjectionEngine.analyzeMarket(snapshot, history);
    return ProjectionEngine.generateProjections(snapshot, history, analysis);
  }

  /**
   * Gets Backtest Metrics from real historical dataset
   */
  public getBacktestMetrics(): BacktestMetrics {
    const history = StorageEngine.getHistory();
    return ProjectionEngine.runBacktest(history);
  }

  /**
   * Bank Multi-Filter Matrix Aggregator
   * Queries real Binance order book across requested banks and amounts
   */
  public async getBankMatrix(tradeType: 'BUY' | 'SELL' = 'SELL', forceRefresh = false): Promise<{
    rows: BankMatrixRow[];
    timestamp: number;
    tradeType: 'BUY' | 'SELL';
  }> {
    const amounts = [10000, 20000, 30000, 40000, 50000, 100000];
    const amountKeys = ['10K', '20K', '30K', '40K', '50K', '100K'];

    // Check cache (valid for 45 seconds)
    const isCacheFresh = this.bankMatrixCache && Date.now() - this.bankMatrixCache.timestamp < 45000;
    if (isCacheFresh && !forceRefresh) {
      const rows = tradeType === 'SELL' ? this.bankMatrixCache!.sellMatrix : this.bankMatrixCache!.buyMatrix;
      return {
        rows,
        timestamp: this.bankMatrixCache!.timestamp,
        tradeType,
      };
    }

    await this.refreshBankMatrix();

    const rows =
      this.bankMatrixCache && tradeType === 'SELL'
        ? this.bankMatrixCache.sellMatrix
        : this.bankMatrixCache
        ? this.bankMatrixCache.buyMatrix
        : [];

    return {
      rows,
      timestamp: this.bankMatrixCache?.timestamp || Date.now(),
      tradeType,
    };
  }

  private async refreshBankMatrix(): Promise<void> {
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

      const buyRows: BankMatrixRow[] = [];
      const sellRows: BankMatrixRow[] = [];

      // Query banks in sequence or controlled chunks to avoid rate limits
      for (const bankKey of banks) {
        const bankConfig = BANK_CODE_MAP[bankKey];

        const buyRow: BankMatrixRow = {
          bankKey,
          bankDisplayName: bankConfig.displayName,
          ratesByAmount: {},
        };

        const sellRow: BankMatrixRow = {
          bankKey,
          bankDisplayName: bankConfig.displayName,
          ratesByAmount: {},
        };

        // Query both BUY and SELL for each amount or for the primary bank query
        try {
          const [rawBuyAds, rawSellAds] = await Promise.all([
            BinanceP2PService.queryP2PAds({
              tradeType: 'BUY',
              payTypes: bankConfig.apiPayTypes,
              rows: 15,
            }),
            BinanceP2PService.queryP2PAds({
              tradeType: 'SELL',
              payTypes: bankConfig.apiPayTypes,
              rows: 15,
            }),
          ]);

          const normalizedBuy = BinanceP2PService.normalizeAds(rawBuyAds);
          const normalizedSell = BinanceP2PService.normalizeAds(rawSellAds);

          for (const amt of amounts) {
            // Find best matching ads within min-max limits for this amount
            const matchingBuyAds = normalizedBuy.filter(
              (ad) => amt.val >= ad.minAmountVes && (ad.maxAmountVes === 0 || amt.val <= ad.maxAmountVes)
            );
            const matchingSellAds = normalizedSell.filter(
              (ad) => amt.val >= ad.minAmountVes && (ad.maxAmountVes === 0 || amt.val <= ad.maxAmountVes)
            );

            // Buy Side
            if (matchingBuyAds.length > 0) {
              const bestBuy = matchingBuyAds.sort((a, b) => a.price - b.price)[0];
              const suggested = Number((bestBuy.price + 0.01).toFixed(2));
              buyRow.ratesByAmount[amt.key] = {
                leaderPrice: bestBuy.price,
                suggestedPrice: suggested,
                spreadPct: Number((((suggested - bestBuy.price) / bestBuy.price) * 100).toFixed(2)),
                availableMerchant: bestBuy.merchantName,
                orderCount: bestBuy.ordersCount,
                adCount: matchingBuyAds.length,
                provenance: 'REAL',
              };
            } else {
              /*
               * C2: no fallback to another tier's price. If no ad covers this
               * amount there is no executable rate, and null says exactly that.
               */
              buyRow.ratesByAmount[amt.key] = {
                leaderPrice: null,
                suggestedPrice: null,
                spreadPct: null,
                adCount: 0,
                provenance: 'REAL',
                provenanceReason:
                  normalizedBuy.length > 0
                    ? `Ningun anuncio de compra de este banco cubre ${amt.val} VES.`
                    : 'El banco no devolvio ningun anuncio de compra.',
              };
            }

            // Sell Side
            if (matchingSellAds.length > 0) {
              const bestSell = matchingSellAds.sort((a, b) => b.price - a.price)[0];
              const suggested = Number((bestSell.price + 0.01).toFixed(2));
              sellRow.ratesByAmount[amt.key] = {
                leaderPrice: bestSell.price,
                suggestedPrice: suggested,
                spreadPct: Number((((suggested - bestSell.price) / bestSell.price) * 100).toFixed(2)),
                availableMerchant: bestSell.merchantName,
                orderCount: bestSell.ordersCount,
                adCount: matchingSellAds.length,
                provenance: 'REAL',
              };
            } else {
              sellRow.ratesByAmount[amt.key] = {
                leaderPrice: null,
                suggestedPrice: null,
                spreadPct: null,
                adCount: 0,
                provenance: 'REAL',
                provenanceReason:
                  normalizedSell.length > 0
                    ? `Ningun anuncio de venta de este banco cubre ${amt.val} VES.`
                    : 'El banco no devolvio ningun anuncio de venta.',
              };
            }
          }
        } catch (err) {
          console.warn(`[CentralStore] Bank matrix fetch failed for ${bankKey}:`, err);
        }

        buyRows.push(buyRow);
        sellRows.push(sellRow);
      }

      this.bankMatrixCache = {
        timestamp: Date.now(),
        buyMatrix: buyRows,
        sellMatrix: sellRows,
      };
    } catch (err) {
      console.error('[CentralStore] Error refreshing bank matrix:', err);
    } finally {
      this.matrixPollingInProgress = false;
    }
  }

  private evaluateAlerts(snapshot: MarketSnapshot): void {
    const rules = StorageEngine.getAlerts().filter((r) => r.enabled);
    const now = Date.now();

    for (const rule of rules) {
      // Prevent rapid spam triggers (minimum 5 minutes between triggers for same rule)
      if (rule.lastTriggeredAt && now - rule.lastTriggeredAt < 300000) {
        continue;
      }

      const targetPrice = rule.targetSide === 'BUY' ? snapshot.bestBuyPrice : snapshot.bestSellPrice;
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
        snapshot.spreadPercentage === null
      ) {
        continue;
      }

      switch (rule.condition) {
        case 'ABOVE':
          if (targetPrice !== null && targetPrice >= rule.targetValue) {
            triggered = true;
            message = `Precio ${rule.targetSide} (${targetPrice.toFixed(2)} VES) superó el umbral de ${rule.targetValue} VES.`;
          }
          break;
        case 'BELOW':
          if (targetPrice !== null && targetPrice <= rule.targetValue) {
            triggered = true;
            message = `Precio ${rule.targetSide} (${targetPrice.toFixed(2)} VES) cayó por debajo de ${rule.targetValue} VES.`;
          }
          break;
        case 'SPREAD_ABOVE':
          if (snapshot.spreadPercentage !== null && snapshot.spreadPercentage >= rule.targetValue) {
            triggered = true;
            message = `Spread P2P (${snapshot.spreadPercentage.toFixed(2)}%) superó el umbral de ${rule.targetValue}%.`;
          }
          break;
        case 'VOLATILITY_SPIKE':
          if (snapshot.spreadPercentage !== null && snapshot.spreadPercentage > rule.targetValue * 1.5) {
            triggered = true;
            message = `Alta volatilidad detectada en el libro de órdenes Binance P2P.`;
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
        if (targetPrice === null) continue;

        rule.lastTriggeredAt = now;
        StorageEngine.saveAlert(rule);

        const log: AlertTriggerLog = {
          id: `trigger-${now}-${Math.random().toString(36).substr(2, 5)}`,
          ruleId: rule.id,
          ruleName: rule.name,
          message,
          price: targetPrice,
          timestamp: now,
        };
        StorageEngine.logTrigger(log);
        console.log(`[Alerts] TRIGGERED: ${message}`);

        /*
         * Notification only. Fire-and-forget by design: notifyAlert never
         * throws and never rejects, so a Telegram outage cannot interrupt the
         * alert loop, the polling cycle or persistence.
         */
        void TelegramNotifier.getInstance().notifyAlert(log, rule, snapshot);
      }
    }
  }
}
