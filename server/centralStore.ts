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

      // Validation check
      if (snapshot.bestBuyPrice <= 0 || snapshot.bestSellPrice <= 0) {
        throw new Error('Validation failed: Non-positive price returned from Binance');
      }

      this.currentSnapshot = snapshot;
      this.lastValidSnapshot = snapshot;

      // Append record to historical storage with Venezuelan hour
      const record: HistoryRecord = {
        id: `tick-${snapshot.timestamp}`,
        timestamp: snapshot.timestamp,
        dateStr: new Date(snapshot.timestamp).toISOString(),
        hour: ProjectionEngine.getVenezuelaHour(snapshot.timestamp),
        buyPrice: snapshot.bestBuyPrice,
        sellPrice: snapshot.bestSellPrice,
        spreadPct: snapshot.spreadPercentage,
        bestBuyMerchant: snapshot.topBuyAds[0]?.merchantName || 'N/A',
        bestSellMerchant: snapshot.topSellAds[0]?.merchantName || 'N/A',
        activeBuyAds: snapshot.topBuyAds.length,
        activeSellAds: snapshot.topSellAds.length,
        source: 'BINANCE_P2P',
      };

      StorageEngine.appendRecord(record);

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
          bestBuyPrice: 0,
          bestSellPrice: 0,
          averageBuyPrice: 0,
          averageSellPrice: 0,
          medianBuyPrice: 0,
          medianSellPrice: 0,
          weightedBuyPrice: 0,
          weightedSellPrice: 0,
          spreadAbsolute: 0,
          spreadPercentage: 0,
          topBuyAds: [],
          topSellAds: [],
          source: 'BINANCE_P2P',
          fetchDurationMs: 0,
          status: 'OFFLINE',
          lastError: err.message || 'Sin conexión a Binance P2P',
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
      // Fallback to central snapshot if specific bank fails
      const fallback = this.getCurrentSnapshot();
      return fallback;
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
    if (!snapshot || snapshot.bestBuyPrice <= 0) return null;

    const history = StorageEngine.getHistory(100);
    return ProjectionEngine.analyzeMarket(snapshot, history);
  }

  /**
   * Gets Market Projections computed by Projection Engine
   */
  public getMarketProjections(): MarketProjections | null {
    const { snapshot } = this.getCurrentSnapshot();
    if (!snapshot || snapshot.bestBuyPrice <= 0) return null;

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
              };
            } else if (normalizedBuy.length > 0) {
              // Fallback to top bank rate if no specific tier match
              const bestBuy = normalizedBuy[0];
              buyRow.ratesByAmount[amt.key] = {
                leaderPrice: bestBuy.price,
                suggestedPrice: Number((bestBuy.price + 0.01).toFixed(2)),
                spreadPct: 0.01,
                availableMerchant: bestBuy.merchantName,
                orderCount: bestBuy.ordersCount,
                adCount: normalizedBuy.length,
              };
            } else {
              buyRow.ratesByAmount[amt.key] = {
                leaderPrice: null,
                suggestedPrice: null,
                spreadPct: null,
                adCount: 0,
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
              };
            } else if (normalizedSell.length > 0) {
              const bestSell = normalizedSell[0];
              sellRow.ratesByAmount[amt.key] = {
                leaderPrice: bestSell.price,
                suggestedPrice: Number((bestSell.price + 0.01).toFixed(2)),
                spreadPct: 0.01,
                availableMerchant: bestSell.merchantName,
                orderCount: bestSell.ordersCount,
                adCount: normalizedSell.length,
              };
            } else {
              sellRow.ratesByAmount[amt.key] = {
                leaderPrice: null,
                suggestedPrice: null,
                spreadPct: null,
                adCount: 0,
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

      switch (rule.condition) {
        case 'ABOVE':
          if (targetPrice >= rule.targetValue) {
            triggered = true;
            message = `Precio ${rule.targetSide} (${targetPrice.toFixed(2)} VES) superó el umbral de ${rule.targetValue} VES.`;
          }
          break;
        case 'BELOW':
          if (targetPrice <= rule.targetValue) {
            triggered = true;
            message = `Precio ${rule.targetSide} (${targetPrice.toFixed(2)} VES) cayó por debajo de ${rule.targetValue} VES.`;
          }
          break;
        case 'SPREAD_ABOVE':
          if (snapshot.spreadPercentage >= rule.targetValue) {
            triggered = true;
            message = `Spread P2P (${snapshot.spreadPercentage.toFixed(2)}%) superó el umbral de ${rule.targetValue}%.`;
          }
          break;
        case 'VOLATILITY_SPIKE':
          if (snapshot.spreadPercentage > rule.targetValue * 1.5) {
            triggered = true;
            message = `Alta volatilidad detectada en el libro de órdenes Binance P2P.`;
          }
          break;
      }

      if (triggered) {
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
      }
    }
  }
}
