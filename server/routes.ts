/**
 * Express API Routes for Binance P2P Trading Assistant
 * Exposes Central Market Store data cleanly to the React frontend.
 */

import { Router } from 'express';
import { CentralMarketStore } from './centralStore.js';
import { StorageEngine } from './storage.js';
import { AlertRule } from './types.js';

export const apiRouter = Router();
const centralStore = CentralMarketStore.getInstance();

// 1. Current Live Market Snapshot (supports bank and amount filter)
apiRouter.get('/market/latest', async (req, res) => {
  try {
    const bank = (req.query.bank as string) || 'ALL';
    const amount = req.query.amount ? parseFloat(req.query.amount as string) : undefined;
    const data = await centralStore.getFilteredSnapshot(bank, amount);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error fetching latest market data' });
  }
});

// 2. Technical & Statistical Market Analysis (supports bank and amount filter)
apiRouter.get('/market/analysis', async (req, res) => {
  try {
    const bank = (req.query.bank as string) || 'ALL';
    const amount = req.query.amount ? parseFloat(req.query.amount as string) : undefined;
    const analysis = await centralStore.getFilteredAnalysis(bank, amount);
    res.json({ analysis });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error computing analysis' });
  }
});

// 3. Projections & Probabilities (supports bank and amount filter)
apiRouter.get('/market/projections', async (req, res) => {
  try {
    const bank = (req.query.bank as string) || 'ALL';
    const amount = req.query.amount ? parseFloat(req.query.amount as string) : undefined;
    const projections = await centralStore.getFilteredProjections(bank, amount);
    res.json({ projections });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error computing projections' });
  }
});

// 4. Multi-Filter Bank Matrix
/*
 * Two structures, named so they cannot be confused.
 *
 * executableMatrix - BANK x AMOUNT, every cell from ads verified as that
 *                    bank's, accepting that amount, with volume covering it.
 *                    The ONLY thing here that may be presented as a rate.
 * marketReference  - the level of the whole book, no bank and no amount. It
 *                    carries executable: false inside the payload.
 *
 * The tradeType query parameter is gone: a cell is not one side, it is an
 * operation with both. Asking for "the SELL matrix" was itself the shape of
 * the old mistake.
 */
apiRouter.get('/market/matrix', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const { executableMatrix, marketReference } = await centralStore.getExecutableMatrix(
      forceRefresh
    );
    res.json({ marketReference, executableMatrix });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error fetching executable matrix' });
  }
});

// 5. Historical Data & Summary
/*
 * Best executable operation right now, plus every bank x amount cell.
 *
 * A NEW endpoint rather than a field on /market/latest: that route returns a
 * MarketSnapshot, whose shape the frontend types mirror exactly, and an
 * opportunity is a different object with a different lifetime (it follows the
 * 45s bank-matrix cache, not the 6s poll). Adding it there would change an
 * existing contract for every consumer; a separate read-only route changes
 * none of them.
 *
 * Reads the cached book. Issues no query to Binance of its own.
 */
apiRouter.get('/market/opportunities', async (_req, res) => {
  try {
    const { timestamp, result } = await centralStore.getOpportunities();
    res.json({
      timestamp,
      // Without this a null bestOpportunity is ambiguous: bad market, or
      // broken mapping? The report says which.
      payTypeMapping: centralStore.getPayTypeMapping(),
      bestOpportunity: result.bestOpportunity,
      opportunities: result.opportunities,
      byBank: result.byBank,
      context: result.context,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error computing opportunities' });
  }
});

apiRouter.get('/market/history', (req, res) => {
  try {
    const range = (req.query.range as string) || '24h';
    let sinceTimestamp = 0;
    const now = Date.now();

    switch (range) {
      case '1h':
        sinceTimestamp = now - 3600 * 1000;
        break;
      case '24h':
        sinceTimestamp = now - 24 * 3600 * 1000;
        break;
      case '7d':
        sinceTimestamp = now - 7 * 24 * 3600 * 1000;
        break;
      case '30d':
        sinceTimestamp = now - 30 * 24 * 3600 * 1000;
        break;
      case 'all':
      default:
        sinceTimestamp = 0;
        break;
    }

    const records = StorageEngine.getHistory(500, sinceTimestamp);
    const summary = StorageEngine.getHistorySummary();

    res.json({
      records,
      summary,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error retrieving history' });
  }
});

// 6. Backtest Metrics
apiRouter.get('/market/backtest', (req, res) => {
  try {
    /*
     * Two measurements, both reported.
     *
     * backtest      - the legacy one-step linear fit over RAW buyPrice. It
     *                 still says validatesProductionModel: false, because it
     *                 still does not measure the engine that publishes.
     * walkForward   - the production engine itself, replayed at every past
     *                 record. This is the one that can validate the model, and
     *                 it does so only when it actually scored samples.
     *
     * The old one is kept rather than replaced: it is the record of what was
     * being measured before, and deleting it would erase the comparison.
     */
    const backtest = centralStore.getBacktestMetrics();
    const walkForward = centralStore.getWalkForwardBacktest();
    res.json({ backtest, walkForward });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error computing backtest' });
  }
});

// 7. On-demand Refresh (supports bank and amount filter)
apiRouter.post('/market/refresh', async (req, res) => {
  try {
    const bank = (req.query.bank as string) || (req.body?.bank as string) || 'ALL';
    const amount = req.query.amount ? parseFloat(req.query.amount as string) : req.body?.amount ? parseFloat(req.body.amount) : undefined;
    const data = await centralStore.refreshFilteredMarket(bank, amount);
    res.json({ success: true, ...data });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Refresh failed' });
  }
});

// 8. Alerts & Rules Management
apiRouter.get('/alerts', (req, res) => {
  try {
    const alerts = StorageEngine.getAlerts();
    const triggers = StorageEngine.getTriggers();
    res.json({ alerts, triggers });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error fetching alerts' });
  }
});

apiRouter.post('/alerts', (req, res) => {
  try {
    const { name, condition, targetValue, targetSide, enabled } = req.body;
    if (!name || !condition || targetValue === undefined) {
      res.status(400).json({ error: 'Missing required alert fields' });
      return;
    }

    const newRule: AlertRule = {
      id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      name,
      condition,
      targetValue: parseFloat(targetValue),
      targetSide: targetSide === 'BUY' ? 'BUY' : 'SELL',
      enabled: enabled !== false,
      createdAt: Date.now(),
    };

    StorageEngine.saveAlert(newRule);
    res.json({ success: true, rule: newRule });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error saving alert' });
  }
});

apiRouter.delete('/alerts/:id', (req, res) => {
  try {
    const success = StorageEngine.deleteAlert(req.params.id);
    res.json({ success });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error deleting alert' });
  }
});

// 9. Health & Binance Status
apiRouter.get('/health', (req, res) => {
  const { snapshot, effectiveStatus, ageSeconds } = centralStore.getCurrentSnapshot();
  res.json({
    status: 'ok',
    binanceStatus: effectiveStatus,
    dataAgeSeconds: ageSeconds,
    market: 'USDT/VES',
    timestamp: Date.now(),
    currentBuyPrice: snapshot?.bestBuyPrice ?? null,
    currentSellPrice: snapshot?.bestSellPrice ?? null,
    /*
     * Whether BANK_CODE_MAP matches what Binance really sends. Without this,
     * a wrong mapping and a quiet market are indistinguishable from outside:
     * both produce no opportunities and no alerts.
     */
    payTypeMapping: (() => {
      const m = centralStore.getPayTypeMapping();
      return { status: m.status, reason: m.reason, observedAdCount: m.observedAdCount };
    })(),
    /*
     * Where the history is actually being written. Code resolving DATA_DIR
     * correctly does not prove the platform mounted a persistent volume
     * there; a recordCount that resets to zero after every deploy does prove
     * it did not. A path and some counts only - no environment dump.
     */
    storage: StorageEngine.describeStorage(),
    /*
     * How much of the capture is actually being recorded. A history with holes
     * is either an honest gap in the market or a loss on our side, and from
     * outside the process those looked identical until these counters existed.
     */
    capture: centralStore.getCaptureStats(),
  });
});

/*
 * The raw payment methods Binance published, for auditing the mapping.
 *
 * Carries payType and tradeMethodName verbatim and nothing else - no
 * merchant nickname, no advNo, no prices. NormalizedAd never kept userNo, so
 * there is no advertiser identity here to leak.
 */
apiRouter.get('/diagnostics/paytypes', (_req, res) => {
  const { snapshot } = centralStore.getCurrentSnapshot();
  const mapping = centralStore.getPayTypeMapping();

  res.json({
    observedAt: snapshot?.timestamp ?? null,

    /*
     * How much book this verdict rests on. A bank missing from a 40-ad sample
     * says far less than one missing from a 400-ad sample, and the reader
     * cannot judge that without the denominator.
     */
    inspected: mapping.inspected ?? null,

    /* Every code Binance published, most frequent first, with its labels. */
    observed: mapping.observations,

    /*
     * Codes Binance returns that no configured bank claims. These are the
     * only admissible evidence for correcting BANK_CODE_MAP.
     */
    observedUnmapped: mapping.observedUnmapped,

    /*
     * Per bank: VERIFIED or NOT_OBSERVED. NOT_OBSERVED is never a claim that
     * the configured code is wrong - see the reason on each verdict.
     */
    banks: mapping.bankVerdicts,

    mapping: {
      status: mapping.status,
      reason: mapping.reason,
      configuredCodes: mapping.configuredCodes,
      matchedCodes: mapping.matchedCodes,
      observedPayTypes: mapping.observedPayTypes,
      unmatchedObserved: mapping.unmatchedObserved,
      banksVerified: mapping.banksVerified,
      banksNotObserved: mapping.banksNotObserved,
    },
  });
});
