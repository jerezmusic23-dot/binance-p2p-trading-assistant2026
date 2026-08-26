import { ProjectionEngine } from './projectionEngine.js';
import type {
  BacktestErrorMetrics,
  BacktestSkipReason,
  BacktestSource,
  HistoryRecord,
  HorizonBacktestResult,
  MarketSnapshot,
  SeriesBasis,
  WalkForwardBacktestResult,
} from './types.js';

/**
 * WALK-FORWARD BACKTEST OF THE PRODUCTION PROJECTION ENGINE
 *
 * The old runBacktest fitted a 5-point line to history.buyPrice and predicted
 * the next stored record. Production does none of those things, so that
 * measurement said nothing about it and declares validatesProductionModel:
 * false. It is left exactly as it was.
 *
 * This module measures the engine that actually publishes. At every past
 * record T it rebuilds the inputs T carries, calls ProjectionEngine.
 * analyzeMarket and ProjectionEngine.generateProjections - the real ones, not
 * a copy - and only afterwards looks forward to score what they said.
 *
 * THE ONE RULE
 *
 *   Building the prediction for T may read history[..T]. Nothing beyond T.
 *   history[T+1...] exists only to grade the answer.
 *
 * The window handed to the engine is history.slice(T - 100, T), which is
 * production's StorageEngine.getHistory(100), and the snapshot is rebuilt from
 * history[T] alone - the same shape as the live tick production would have
 * been holding at that instant.
 */
export class BacktestEngine {
  /** production: StorageEngine.getHistory(100) feeds getProjections(). */
  public static readonly PROJECTION_WINDOW = 100;

  /**
   * A move smaller than this counts as FLAT.
   *
   * Not a tuned threshold: prices are persisted through toFixed(2), so half a
   * cent is below the resolution the history can express. Anything smaller is
   * indistinguishable from no move at all in the stored data.
   */
  public static readonly FLAT_EPSILON_VES = 0.005;

  /** Fallback spacing when the history is too short to measure its own cadence. */
  private static readonly DEFAULT_INTERVAL_MS = 60_000;

  /**
   * Reproduces the tick production was holding at record T.
   *
   * Only fields the history actually stores are populated. Everything the
   * record does not carry stays null or empty - most importantly the order
   * book, which was never persisted. An empty book is handled by
   * computeOrderBookPressure as "no liquidity to measure", so the pressure
   * term drops out instead of being guessed. Inventing ads to fill it would
   * fabricate the very input the measurement is supposed to test.
   */
  public static reconstructSnapshot(record: HistoryRecord): MarketSnapshot {
    const notStored = 'No reconstruible: el histórico no almacena este campo.';
    const hasStrategic =
      record.calculationVersion === 'v2-strategic' &&
      record.strategicBuyPrice !== undefined &&
      record.strategicSellPrice !== undefined;

    return {
      timestamp: record.timestamp,
      isoDate: record.dateStr,
      asset: 'USDT',
      fiat: 'VES',

      bestBuyPrice: record.buyPrice,
      bestSellPrice: record.sellPrice,

      averageBuyPrice: null,
      averageSellPrice: null,
      medianBuyPrice: hasStrategic ? (record.strategicBuyPrice as number) : null,
      medianSellPrice: hasStrategic ? (record.strategicSellPrice as number) : null,
      weightedBuyPrice: null,
      weightedSellPrice: null,

      spreadAbsolute: null,
      spreadPercentage: record.spreadPct,

      strategicBuyPrice: hasStrategic ? (record.strategicBuyPrice as number) : null,
      strategicSellPrice: hasStrategic ? (record.strategicSellPrice as number) : null,
      strategicSpreadPct: hasStrategic ? (record.strategicSpreadPct ?? null) : null,
      strategicReason: hasStrategic
        ? null
        : 'Registro v1: fue almacenado antes de que existiera el nivel estratégico.',

      // Never persisted. Empty is the truth; a fabricated book is not.
      topBuyAds: [],
      topSellAds: [],

      source: 'BINANCE_P2P',
      fetchDurationMs: 0,
      status: 'LIVE',
      lastError: null,

      bestBuy: { value: record.buyPrice, provenance: 'REAL' },
      bestSell: { value: record.sellPrice, provenance: 'REAL' },
      aggregatesProvenance: 'AGGREGATED',
      orderBookProvenance: 'NOT_VERIFIABLE',
      strategicProvenance: hasStrategic ? 'STRATEGIC' : 'NOT_VERIFIABLE',
      filterFallbackReason: hasStrategic ? undefined : notStored,
    };
  }

  /** Median gap between consecutive records. Measured, never assumed. */
  public static medianIntervalMs(history: HistoryRecord[]): number | null {
    if (history.length < 2) return null;
    const gaps: number[] = [];
    for (let i = 1; i < history.length; i++) {
      const gap = history[i].timestamp - history[i - 1].timestamp;
      if (gap > 0) gaps.push(gap);
    }
    if (gaps.length === 0) return null;
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    return gaps.length % 2 === 1 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
  }

  /**
   * The record closest to targetTs, if one lands within tolerance.
   *
   * Records sit on a sampling grid, so an exact +1H match will not usually
   * exist. Accepting the nearest within one sampling interval is as tight as
   * the grid allows; anything looser would score a prediction against a time
   * it was not made for. Searching starts after the anchor, so a past record
   * can never be mistaken for the future.
   */
  public static findFutureRecord(
    history: HistoryRecord[],
    anchorIndex: number,
    targetTs: number,
    toleranceMs: number
  ): HistoryRecord | null {
    /*
     * Binary search, not a scan. On a real history this runs once per anchor
     * per horizon, and a linear walk to the +24H target would make the whole
     * backtest quadratic in the number of records.
     */
    let lo = anchorIndex + 1;
    let hi = history.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (history[mid].timestamp < targetTs) lo = mid + 1;
      else hi = mid;
    }

    let best: HistoryRecord | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    // The first record at or after the target, and the last one before it.
    for (const i of [lo - 1, lo]) {
      if (i <= anchorIndex || i >= history.length) continue;
      const delta = Math.abs(history[i].timestamp - targetTs);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = history[i];
      }
    }

    return best !== null && bestDelta <= toleranceMs ? best : null;
  }

  /** UP / DOWN / FLAT, with FLAT bounded by the precision of the stored price. */
  private static direction(from: number, to: number): -1 | 0 | 1 {
    const delta = to - from;
    if (Math.abs(delta) < this.FLAT_EPSILON_VES) return 0;
    return delta > 0 ? 1 : -1;
  }

  private static emptyMetrics(): BacktestErrorMetrics {
    return {
      mae: null,
      rmse: null,
      mapePct: null,
      directionalAccuracyPct: null,
      biasVes: null,
      biasDirection: null,
    };
  }

  /**
   * Scores one predictor over the samples collected for one horizon.
   *
   * predicted[i] and actual[i] are the same instant on the same series - the
   * caller guarantees it by refusing any sample whose future record does not
   * carry the basis the anchor resolved to.
   */
  public static score(
    predicted: number[],
    actual: number[],
    anchors: number[]
  ): BacktestErrorMetrics {
    const n = predicted.length;
    if (n === 0 || n !== actual.length || n !== anchors.length) return this.emptyMetrics();

    let absSum = 0;
    let sqSum = 0;
    let signedSum = 0;
    let pctSum = 0;
    let pctCount = 0;
    let directionHits = 0;

    for (let i = 0; i < n; i++) {
      const error = predicted[i] - actual[i];
      absSum += Math.abs(error);
      sqSum += error * error;
      signedSum += error;

      if (actual[i] > 0) {
        pctSum += (Math.abs(error) / actual[i]) * 100;
        pctCount++;
      }

      if (this.direction(anchors[i], predicted[i]) === this.direction(anchors[i], actual[i])) {
        directionHits++;
      }
    }

    const bias = signedSum / n;
    // BALANCED only below the resolution the prices are stored at.
    const biasDirection =
      Math.abs(bias) < this.FLAT_EPSILON_VES
        ? 'BALANCED'
        : bias > 0
        ? 'OVERESTIMATES'
        : 'UNDERESTIMATES';

    return {
      mae: Number((absSum / n).toFixed(4)),
      rmse: Number(Math.sqrt(sqSum / n).toFixed(4)),
      mapePct: pctCount > 0 ? Number((pctSum / pctCount).toFixed(4)) : null,
      directionalAccuracyPct: Number(((directionHits / n) * 100).toFixed(2)),
      biasVes: Number(bias.toFixed(4)),
      biasDirection,
    };
  }

  /**
   * Runs the walk-forward.
   *
   * source is passed in, never guessed: only the caller knows whether these
   * records came off the production volume or out of a fixture, and a fixture
   * must never be reported as market evidence.
   */
  public static run(
    history: HistoryRecord[],
    source: BacktestSource,
    nowMs: number = Date.now()
  ): WalkForwardBacktestResult {
    const sorted = [...history].sort((a, b) => a.timestamp - b.timestamp);
    const minSamples = ProjectionEngine.MIN_SAMPLES_FOR_PROJECTION;
    const strategicRecords = sorted.filter((h) => h.calculationVersion === 'v2-strategic').length;
    const measuredInterval = this.medianIntervalMs(sorted);
    const toleranceMs = measuredInterval ?? this.DEFAULT_INTERVAL_MS;

    const spanMinutes =
      sorted.length >= 2
        ? Number(
            ((sorted[sorted.length - 1].timestamp - sorted[0].timestamp) / 60_000).toFixed(2)
          )
        : null;

    const modelDescription =
      'Walk-forward sobre ProjectionEngine.analyzeMarket + generateProjections, ' +
      'las mismas funciones que publica producción. En cada registro T la ventana ' +
      `es history[T-${this.PROJECTION_WINDOW}..T-1] y el snapshot se reconstruye de ` +
      'history[T]; el reloj del motor se fija en T. Ningún dato posterior a T ' +
      'interviene en la predicción. Baseline: persistencia (precio futuro = precio actual).';

    const reproductionGaps = [
      'orderBookPressure: el histórico no almacena topBuyAds/topSellAds, así que ' +
        'dominantSide queda null y el ajuste de ±8 puntos sobre las probabilidades ' +
        'no se aplica. Afecta a probabilities y a un factor de risk. NO afecta a ' +
        'projectedBuy, projectedSell ni a las bandas, que es lo que se mide aquí.',
    ];

    /* Horizon labels and hours come from the engine, not from a second list. */
    const horizonSpecs = ProjectionEngine.HORIZONS;

    interface Bucket {
      modelPredicted: number[];
      persistencePredicted: number[];
      actual: number[];
      anchors: number[];
      bandHits: number;
      bandSamples: number;
      skips: Partial<Record<BacktestSkipReason, number>>;
      evaluated: number;
    }
    const buckets = new Map<string, Bucket>();
    for (const spec of horizonSpecs) {
      buckets.set(spec.label, {
        modelPredicted: [],
        persistencePredicted: [],
        actual: [],
        anchors: [],
        bandHits: 0,
        bandSamples: 0,
        skips: {},
        evaluated: 0,
      });
    }
    const skip = (bucket: Bucket, reason: BacktestSkipReason) => {
      bucket.skips[reason] = (bucket.skips[reason] ?? 0) + 1;
    };

    let anchorsConsidered = 0;
    let lastBasis: SeriesBasis | null = null;
    const basisCounts = { strategic: 0, raw: 0 };

    for (let t = 0; t < sorted.length; t++) {
      const windowStart = Math.max(0, t - this.PROJECTION_WINDOW);
      const window = sorted.slice(windowStart, t);
      anchorsConsidered++;

      const belowMin = window.length < minSamples;
      const snapshot = this.reconstructSnapshot(sorted[t]);

      if (belowMin) {
        for (const spec of horizonSpecs) {
          const bucket = buckets.get(spec.label) as Bucket;
          bucket.evaluated++;
          skip(bucket, 'BELOW_MIN_SAMPLES');
        }
        continue;
      }

      /* The same rule production applies - read, never re-implemented. */
      const seriesBasis = ProjectionEngine.selectSeriesBasis(snapshot, window);
      lastBasis = seriesBasis.basis;
      if (seriesBasis.basis === 'STRATEGIC') basisCounts.strategic++;
      else basisCounts.raw++;

      const analysis = ProjectionEngine.analyzeMarket(snapshot, window);
      const projections = ProjectionEngine.generateProjections(
        snapshot,
        window,
        analysis,
        sorted[t].timestamp
      );

      const anchorPrice = seriesBasis.currentBuy;

      for (const spec of horizonSpecs) {
        const bucket = buckets.get(spec.label) as Bucket;
        bucket.evaluated++;

        if (!projections.hasSufficientData || anchorPrice === null) {
          skip(bucket, 'PRODUCTION_INSUFFICIENT_DATA');
          continue;
        }

        const item = projections.intradayHorizons.find((h) => h.horizon === spec.label);
        if (item === undefined || item.projectedBuy === null) {
          skip(bucket, 'NO_PROJECTION_VALUE');
          continue;
        }

        const targetTs = sorted[t].timestamp + spec.hours * 3_600_000;
        const future = this.findFutureRecord(sorted, t, targetTs, toleranceMs);
        if (future === null) {
          skip(bucket, 'NO_FUTURE_RECORD');
          continue;
        }

        /*
         * The realised value must be the SAME definition the prediction was
         * made on. A strategic projection graded against a raw future would
         * charge the model for the gap between two definitions of price.
         */
        let actualPrice: number | null;
        if (seriesBasis.basis === 'STRATEGIC') {
          actualPrice =
            future.calculationVersion === 'v2-strategic' &&
            future.strategicBuyPrice !== undefined
              ? future.strategicBuyPrice
              : null;
          if (actualPrice === null) {
            skip(bucket, 'FUTURE_RECORD_WRONG_BASIS');
            continue;
          }
        } else {
          actualPrice = future.buyPrice;
        }

        if (!(actualPrice > 0)) {
          skip(bucket, 'NON_POSITIVE_ACTUAL');
          continue;
        }

        bucket.modelPredicted.push(item.projectedBuy);
        bucket.persistencePredicted.push(anchorPrice);
        bucket.actual.push(actualPrice);
        bucket.anchors.push(anchorPrice);

        if (item.rangeMin !== null && item.rangeMax !== null) {
          bucket.bandSamples++;
          if (actualPrice >= item.rangeMin && actualPrice <= item.rangeMax) bucket.bandHits++;
        }
      }
    }

    const horizons: HorizonBacktestResult[] = horizonSpecs.map((spec) => {
      const bucket = buckets.get(spec.label) as Bucket;
      const validSamples = bucket.actual.length;
      const model = this.score(bucket.modelPredicted, bucket.actual, bucket.anchors);
      const persistence = this.score(
        bucket.persistencePredicted,
        bucket.actual,
        bucket.anchors
      );

      let maeImprovementPct: number | null = null;
      let beatsPersistence: boolean | null = null;
      if (model.mae !== null && persistence.mae !== null && persistence.mae > 0) {
        maeImprovementPct = Number(
          (((persistence.mae - model.mae) / persistence.mae) * 100).toFixed(2)
        );
        beatsPersistence = model.mae < persistence.mae;
      }

      const dominantSkip = (Object.entries(bucket.skips) as [BacktestSkipReason, number][]).sort(
        (a, b) => b[1] - a[1]
      )[0];

      return {
        horizon: spec.label,
        hours: spec.hours,
        status: validSamples > 0 ? 'OK' : 'INSUFFICIENT_DATA',
        reason:
          validSamples > 0
            ? null
            : dominantSkip === undefined
            ? 'No hay ningún registro en el histórico.'
            : this.explainSkip(dominantSkip[0], dominantSkip[1], spec.hours, minSamples),
        evaluatedSamples: bucket.evaluated,
        validSamples,
        skippedSamples: bucket.evaluated - validSamples,
        skipReasons: bucket.skips,
        model,
        persistence,
        maeImprovementPct,
        beatsPersistence,
        bandCoveragePct:
          bucket.bandSamples > 0
            ? Number(((bucket.bandHits / bucket.bandSamples) * 100).toFixed(2))
            : null,
        bandSamples: bucket.bandSamples,
      };
    });

    const anyScored = horizons.some((h) => h.validSamples > 0);

    return {
      status: anyScored ? 'ok' : 'insufficient_data',
      validatesProductionModel: anyScored,
      method: 'WALK_FORWARD_PRODUCTION_MODEL',
      modelDescription,
      source,
      baseline: 'PERSISTENCE',
      basis: lastBasis,
      basisCounts,
      totalRecords: sorted.length,
      strategicRecords,
      spanMinutes,
      medianIntervalSeconds:
        measuredInterval !== null ? Number((measuredInterval / 1000).toFixed(2)) : null,
      minSamplesForProjection: minSamples,
      projectionWindowSize: this.PROJECTION_WINDOW,
      anchorsConsidered,
      horizons,
      reproductionGaps,
      confidencePublished: false,
      evaluatedAt: new Date(nowMs).toISOString(),
    };
  }

  /** Says what is missing, in records and in wall-clock time. */
  private static explainSkip(
    reason: BacktestSkipReason,
    count: number,
    hours: number,
    minSamples: number
  ): string {
    switch (reason) {
      case 'BELOW_MIN_SAMPLES':
        return (
          `Ningún registro llega a tener ${minSamples} observaciones previas, que es ` +
          `el mínimo que exige producción para proyectar.`
        );
      case 'NO_FUTURE_RECORD':
        return (
          `El histórico no alcanza ${hours}h más allá de ningún punto evaluable: ` +
          `${count} anclajes se quedaron sin futuro con el que compararse. Se ` +
          `necesitan al menos ${minSamples + hours * 60 + 1} registros ` +
          `(~${(minSamples + hours * 60 + 1) / 60} h de captura continua) para una sola muestra.`
        );
      case 'PRODUCTION_INSUFFICIENT_DATA':
        return `Producción declaró datos insuficientes en ${count} anclajes.`;
      case 'FUTURE_RECORD_WRONG_BASIS':
        return (
          `${count} anclajes estratégicos apuntaban a un registro futuro v1, sin ` +
          `precio estratégico con el que compararse. Mezclar definiciones falsearía el error.`
        );
      case 'NO_PROJECTION_VALUE':
        return `El motor no produjo un valor proyectado en ${count} anclajes.`;
      case 'NON_POSITIVE_ACTUAL':
        return `${count} registros futuros no tenían un precio positivo.`;
    }
  }
}
