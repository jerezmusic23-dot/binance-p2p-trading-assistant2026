/**
 * Express API Routes for Binance P2P Trading Assistant
 * Exposes Central Market Store data cleanly to the React frontend.
 */

import { Router } from 'express';
import { selectBestMakerCell } from './makerMatrix.js';
import { HistoricalMarketStore } from './historicalMarketStore.js';
import { runProjectionBacktest } from './projectionBacktest.js';
import { GENERAL_MARKET_KEY, projectCell } from './makerProjectionEngine.js';
import { CentralMarketStore } from './centralStore.js';
import { StorageEngine } from './storage.js';
import {
  buildMarketProjectionAsync,
  type MarketProjectionReport,
} from './marketProjection.js';
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

/*
 * THE MAKER MATRIX: what price to publish, per BANCO x MONTO.
 *
 * A separate route from /market/matrix on purpose. That one answers the
 * taker's question - could I take an ad here - and this one answers the
 * operator's: what should MY ad cost. Both read the same captured book, so
 * serving both costs Binance nothing extra, and keeping them apart means
 * neither can quietly inherit the other's vocabulary.
 */
apiRouter.get('/market/maker-matrix', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const makerMatrix = await centralStore.getMakerMatrix(forceRefresh);
    /*
     * The best cell is chosen HERE, by the same function that decides what
     * Telegram announces. Letting the interface rank the cells would be a
     * second economic decision, free to disagree with the first.
     */
    res.json({ makerMatrix, best: selectBestMakerCell(makerMatrix) });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error building maker matrix' });
  }
});

/*
 * PROJECTIONS AND SIGNALS, per BANCO x MONTO.
 *
 * Reads what the last sweep already computed. Issues no query to Binance and
 * performs no analysis of its own - the numbers a screen renders are the same
 * objects Telegram was handed, so the two cannot disagree.
 */
apiRouter.get('/market/projections/maker', (_req, res) => {
  try {
    const { projections, signals } = centralStore.getProjections();
    res.json({ projections, signals });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error building maker projections' });
  }
});

/*
 * THE WHOLE BOOK, READ BY THE SAME ENGINE AS EVERY CELL.
 *
 * This replaces /market/projections, which was served by the old
 * ProjectionEngine: a 1.6-sigma band around a rolling min/max, a hand-picked
 * intraday session curve, a 0.0035 seasonal coefficient and a point-scored
 * probability distribution. None of those coefficients was measured, and the
 * screen presented all of them as a forecast.
 *
 * What comes back instead is a projection over the general series - every
 * cell's observations in one chronological list - computed by
 * makerProjectionEngine: three trend horizons with their real spans, an
 * empirical band that is the 10th and 90th percentiles of the moves this book
 * actually made, zones the price genuinely turned in, and a horizon in minutes
 * measured from the observed cadence. Empty until the first sweep has written
 * observations: a market nobody has observed has no reading.
 */
apiRouter.get('/market/projections/general', (_req, res) => {
  try {
    const { projection, series } = centralStore.getMarketProjection();
    res.json({ projection, series });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error building market projection' });
  }
});

/*
 * PROYECCIÓN PROBABILÍSTICA DEL MERCADO, POR ANALOGÍA HISTÓRICA.
 *
 * Distinta de /projections/general, y no la sustituye: aquélla lee la serie de
 * celdas y da tendencia y banda empírica del libro maker. Ésta lee
 * market_history.json —la serie global de un registro por minuto— y responde a
 * "qué pasó históricamente en las situaciones parecidas a la de ahora".
 *
 * Todo número que sale de aquí llega con su procedencia: cuántos casos lo
 * sostienen, cuáles son con su fecha, contra qué deriva de régimen se
 * juzgaron, en qué estado está el horizonte (READY / INSUFFICIENT_DATA /
 * INSUFFICIENT_ANALOGIES / LOW_CONFIDENCE / NO_EDGE) y si el backtest contra
 * la persistencia lo respalda.
 *
 * LA CAPTURA ES PRIORITARIA.
 *
 * El backtest recorre el histórico una vez por ancla y tarda segundos. Dos
 * defensas, porque una sola no basta:
 *
 *   1. Se usa la variante ASÍNCRONA, que cede el hilo cada pocas anclas. El
 *      trabajo total es el mismo pero ningún bloque bloquea el poll de
 *      Binance.
 *   2. Se cachea contra el ESTADO REAL de la serie —cuántos registros hay y
 *      cuál es el último—, no contra el reloj. Un TTL podría servir datos
 *      viejos o recalcular sin que hubiera cambiado nada; así un registro
 *      nuevo invalida la caché al instante y nunca se sirve una proyección que
 *      no corresponda a los datos actuales.
 *
 * Y un cerrojo: si llegan dos peticiones mientras se calcula, la segunda
 * espera al mismo cálculo en vez de lanzar otro.
 */
let analogCache: { key: string; report: MarketProjectionReport } | null = null;
let analogInFlight: { key: string; promise: Promise<MarketProjectionReport> } | null = null;

apiRouter.get('/market/projections/analog', async (_req, res) => {
  try {
    const records = StorageEngine.getHistory();
    const newest = records.length > 0 ? records[records.length - 1].timestamp : 0;
    const key = `${records.length}:${newest}`;

    if (analogCache !== null && analogCache.key === key) {
      res.json(analogCache.report);
      return;
    }

    if (analogInFlight === null || analogInFlight.key !== key) {
      analogInFlight = {
        key,
        promise: buildMarketProjectionAsync({ readRecords: () => records }),
      };
    }

    const report = await analogInFlight.promise;
    analogCache = { key, report };
    analogInFlight = null;
    res.json(report);
  } catch (err: any) {
    analogInFlight = null;
    res.status(500).json({ error: err.message || 'Error building market projection' });
  }
});

/*
 * ONE CELL'S FULL ANALYSIS, day-of-week patterns included.
 *
 * Separate from /projections/maker because the day distributions are seven
 * passes over the series per side and nothing on the alerting path reads them.
 * Computing them for all 42 cells on every sweep was measurably slow; computed
 * for the one cell somebody is looking at, they are free.
 */
apiRouter.get('/market/projections/cell', (req, res) => {
  try {
    const bank = String(req.query.bank ?? '');
    const amountKey = String(req.query.amount ?? '');
    if (bank === '' || amountKey === '') {
      res.status(400).json({ error: 'bank y amount son obligatorios' });
      return;
    }

    const series = HistoricalMarketStore.load(bank, amountKey);
    const live = centralStore
      .getProjections()
      .projections.find((p) => p.bank === bank && p.amountKey === amountKey);

    res.json({
      projection: projectCell({
        bank,
        bankDisplayName: live?.bankDisplayName ?? bank,
        amountKey,
        amountVes: live?.amountVes ?? series[0]?.amountVes ?? 0,
        series,
        currentBuyPrice: live?.buy.currentPrice ?? null,
        currentSellPrice: live?.sell.currentPrice ?? null,
        includeDayPatterns: true,
      }),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error building cell projection' });
  }
});

/*
 * THE SERIES BEHIND ONE CELL, for the chart.
 *
 * Raw observations, exactly as stored. No smoothing, no gap filling and no
 * resampling: a hole in the capture must be visible as a hole.
 */
apiRouter.get('/market/projections/series', (req, res) => {
  try {
    const bank = String(req.query.bank ?? '');
    const amountKey = String(req.query.amount ?? '');
    if (bank === '' || amountKey === '') {
      res.status(400).json({ error: 'bank y amount son obligatorios' });
      return;
    }

    /*
     * PRE-DEPLOY: Number('abc') is NaN, and NaN survives Math.min/Math.max.
     *
     * `slice(-NaN)` is `slice(0)`, so ?limit=abc returned the WHOLE series
     * instead of the last 300 - a query parameter that removed the bound it
     * exists to impose. On a process that has been capturing for days that is
     * an unbounded response.
     */
    const requested = Number(req.query.limit ?? 300);
    const limit = Number.isFinite(requested)
      ? Math.min(2000, Math.max(1, Math.trunc(requested)))
      : 300;
    const series = HistoricalMarketStore.load(bank, amountKey);

    res.json({
      describe: HistoricalMarketStore.describe(bank, amountKey),
      observations: series.slice(-limit).map((o) => ({
        timestamp: o.timestamp,
        buyRecommendedPrice: o.buyRecommendedPrice,
        sellRecommendedPrice: o.sellRecommendedPrice,
        buyLeaderPrice: o.buyLeaderPrice,
        sellLeaderPrice: o.sellLeaderPrice,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error reading cell series' });
  }
});

/*
 * BACKTEST of one cell's projection, replayed over its own stored series.
 *
 * Every anchor is computed from a PREFIX of the series, so nothing it reports
 * could have used information from after the moment it describes.
 */
apiRouter.get('/market/projections/backtest', (req, res) => {
  try {
    const bank = String(req.query.bank ?? '');
    const amountKey = String(req.query.amount ?? '');
    const side = req.query.side === 'SELL' ? 'SELL' : 'BUY';
    if (bank === '' || amountKey === '') {
      res.status(400).json({ error: 'bank y amount son obligatorios' });
      return;
    }

    /*
     * MERCADO_GENERAL replays the whole book rather than one cell.
     *
     * The general series is not a file on disk - it is every cell's
     * observations in one chronological list, built by the sweep - so it is
     * read from the store instead of from HistoricalMarketStore. Everything
     * else about the replay is identical, prefix by prefix.
     */
    const general = bank === GENERAL_MARKET_KEY;
    const series = general
      ? centralStore.getMarketProjection().series
      : HistoricalMarketStore.load(bank, amountKey);

    res.json({
      series: general
        ? {
            observations: series.length,
            firstTimestamp: series[0]?.timestamp ?? null,
            lastTimestamp: series[series.length - 1]?.timestamp ?? null,
          }
        : HistoricalMarketStore.describe(bank, amountKey),
      report: runProjectionBacktest({
        bank,
        bankDisplayName: general ? 'Mercado general' : bank,
        amountKey,
        amountVes: general ? 0 : (series[0]?.amountVes ?? 0),
        series,
        side,
      }),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error running projection backtest' });
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

/*
 * /market/backtest USED TO LIVE HERE, and it is gone with the engine it scored.
 *
 * It reported two things about ProjectionEngine: a legacy one-step linear fit,
 * and a walk-forward replay of the same heuristic. Measuring a hand-picked
 * 1.6-sigma band precisely does not turn it into evidence, and the engine that
 * produced it is no longer in the production chain at all.
 *
 * /market/projections/backtest replaces it. It replays the engine that is
 * actually running, prefix by prefix, and reports a persistence baseline
 * alongside the accuracy - so a number can be read against something.
 */

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

    /*
     * PRE-DEPLOY: a rule whose threshold is NaN can never fire and never says
     * so. parseFloat('abc') was written straight to disk, where JSON turns it
     * into null; the rule then sat in the operator's panel looking configured
     * while every comparison against it was false. Refused at the door.
     */
    const threshold = parseFloat(targetValue);
    if (!Number.isFinite(threshold)) {
      res.status(400).json({ error: 'targetValue debe ser un numero' });
      return;
    }

    const newRule: AlertRule = {
      id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      name,
      condition,
      targetValue: threshold,
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

/*
 * PRE-DEPLOY: UNA RUTA /api DESCONOCIDA DEVOLVÍA LA APLICACIÓN ENTERA.
 *
 * server.ts registra el router y DESPUÉS el fallback SPA `app.get('*')`, así
 * que una ruta de API que no exista - una que se retiró, o un error de
 * tecleo en el frontend - caía en el fallback y contestaba index.html con un
 * HTTP 200. El consumidor recibía HTML donde esperaba JSON y fallaba con
 * "Unexpected token '<'", que no dice nada sobre lo que pasó.
 *
 * Esto ya no es hipotético: /api/market/analysis, /api/market/projections y
 * /api/market/backtest existieron y fueron retirados con el motor viejo.
 *
 * Un 404 con cuerpo JSON dice la verdad. Va al final, después de todas las
 * rutas reales, y sólo captura lo que ninguna de ellas atendió.
 */
apiRouter.use((req, res) => {
  res.status(404).json({
    error: `Ruta de API no encontrada: ${req.method} ${req.originalUrl}`,
  });
});
