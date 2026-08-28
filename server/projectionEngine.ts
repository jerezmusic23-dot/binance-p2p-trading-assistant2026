/**
 * Projection & Statistical Analysis Engine
 * Time series modeling, Venezuelan session dynamics (8:00 AM - 8:00 PM VET),
 * volatility estimation, order book depth pressure, and merchant decision support.
 */

import {
  HistoryRecord,
  MarketSnapshot,
  MarketTrend,
  MomentumLevel,
  VolatilityLevel,
  RiskLevel,
  MarketAnalysis,
  MarketProjections,
  HourlyChartPoint,
  HourlyProjectionItem,
  BacktestMetrics,
  MerchantDecisionAdvice,
  DataProvenance,
  DataWindow,
  Valued,
} from './types.js';

export class ProjectionEngine {
  /**
   * Minimum stored observations before projections are considered to have any
   * evidential basis.
   *
   * DECLARED ASSUMPTION, not an empirically derived threshold: nothing in the
   * data has been measured to justify 30 rather than 20 or 200. It exists so
   * that hasSufficientData can be false for an obviously empty store instead
   * of being hardcoded true. It should be replaced by a value derived from
   * measured projection error once the backtest evaluates the production model.
   */
  public static readonly MIN_SAMPLES_FOR_PROJECTION = 30;

  /**
   * The horizons this engine publishes, and the band multiplier each one
   * applies to the measured volatility.
   *
   * Unchanged values, lifted out of generateProjections so the backtest reads
   * the labels and hours from here instead of keeping a second list that could
   * drift out of step with the one production emits.
   */
  public static readonly HORIZONS: ReadonlyArray<{
    label: string;
    hours: number;
    mult: number;
  }> = [
    { label: '+1H', hours: 1, mult: 0.35 },
    { label: '+2H', hours: 2, mult: 0.55 },
    { label: '+4H', hours: 4, mult: 0.85 },
    { label: '+6H', hours: 6, mult: 1.15 },
    { label: '+12H', hours: 12, mult: 1.55 },
    { label: '+24H', hours: 24, mult: 2.0 },
  ];

  /** Describes the stored observations a derived value was computed from. */
  public static describeWindow(history: HistoryRecord[]): DataWindow {
    if (history.length === 0) {
      return { sampleCount: 0, fromTimestamp: null, toTimestamp: null, spanMinutes: null };
    }
    const first = history[0].timestamp;
    const last = history[history.length - 1].timestamp;
    return {
      sampleCount: history.length,
      fromTimestamp: first,
      toTimestamp: last,
      spanMinutes: Number((Math.max(0, last - first) / 60000).toFixed(1)),
    };
  }

  /**
   * Returns the hour of day in Venezuelan Standard Time (VET, UTC-4 / America/Caracas)
   */
  public static getVenezuelaHour(ts: number = Date.now()): number {
    try {
      const d = new Date(ts);
      const vetString = d.toLocaleString('en-US', { timeZone: 'America/Caracas', hour: 'numeric', hour12: false });
      const hour = parseInt(vetString, 10);
      if (!isNaN(hour)) {
        return hour === 24 ? 0 : hour;
      }
    } catch {
      // Fallback: UTC-4
    }
    const d = new Date(ts);
    return (d.getUTCHours() - 4 + 24) % 24;
  }

  /**
   * Formats a timestamp into a friendly VET time string (e.g., "11:30 a. m.")
   */
  public static formatVenezuelaTime(ts: number): string {
    try {
      return new Date(ts).toLocaleTimeString('es-VE', {
        timeZone: 'America/Caracas',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return new Date(ts).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
    }
  }

  /**
   * Performs technical and statistical analysis on real historical records and current snapshot
   */
  /**
   * Picks ONE definition for the series and its latest point.
   *
   * A market projection should read the strategic level - the median of each
   * side - not the raw extremes. But the series and the anchor must come from
   * the SAME definition. Feeding a strategic median as the newest point of a
   * series of raw minima offsets that point by the gap between the two
   * definitions (~2.4 VES in the observed book) and manufactures a momentum
   * signal out of a change of units.
   *
   * So: strategic only when EVERY record in the window carries it and the
   * snapshot has one too. A window mixing v1 and v2 records stays entirely
   * RAW - consistent, and honest about what it is. As v2 records accumulate
   * the window flips over on its own, with no migration and nothing
   * backfilled.
   *
   * PUBLIC so the backtest can ask which definition a given window resolves
   * to, and compare its prediction against the SAME field in the future
   * record. Duplicating this rule in the backtest would let the two drift
   * apart silently; there is one definition and both callers read it.
   */
  public static selectSeriesBasis(
    snapshot: MarketSnapshot,
    history: HistoryRecord[]
  ): {
    basis: 'STRATEGIC' | 'RAW';
    buyPrices: number[];
    currentBuy: number | null;
    currentSell: number | null;
  } {
    const allStrategic =
      history.length > 0 &&
      history.every(
        (h) =>
          h.calculationVersion === 'v2-strategic' &&
          h.strategicBuyPrice !== undefined &&
          h.strategicSellPrice !== undefined
      );

    if (allStrategic && snapshot.strategicBuyPrice !== null && snapshot.strategicSellPrice !== null) {
      return {
        basis: 'STRATEGIC',
        buyPrices: history.map((h) => h.strategicBuyPrice as number).filter((p) => p > 0),
        currentBuy: snapshot.strategicBuyPrice,
        currentSell: snapshot.strategicSellPrice,
      };
    }

    return {
      basis: 'RAW',
      buyPrices: history.map((h) => h.buyPrice).filter((p) => p > 0),
      currentBuy: snapshot.bestBuyPrice,
      currentSell: snapshot.bestSellPrice,
    };
  }

  public static analyzeMarket(
    snapshot: MarketSnapshot,
    history: HistoryRecord[]
  ): MarketAnalysis {
    // Series and anchor from one definition - see selectSeriesBasis.
    const series = this.selectSeriesBasis(snapshot, history);
    const buyPrices = series.buyPrices;
    const currentPrice = series.currentBuy;
    const dataWindow = this.describeWindow(history);
    const provenance = {
      overall: 'AGGREGATED' as const,
      trendStrength: 'AGGREGATED' as const,
      supportResistance: 'HEURISTIC' as const,
    };

    // C2: the live price is no longer pushed into the series as a stand-in for
    // history, and no metric falls back to an invented constant. With nothing
    // to measure, every derived figure is null.
    if (buyPrices.length === 0 || currentPrice === null) {
      return {
        trend: null,
        trendStrength: null,
        momentum: null,
        volatility: null,
        volatilityPct: null,
        priceVsSmaPct: null,
        rsi: null,
        supportLevel: null,
        resistanceLevel: null,
        summaryText: 'Sin observaciones suficientes para analizar el mercado.',
        reasons: [
          buyPrices.length === 0
            ? 'No hay ningun tick almacenado sobre el que calcular estadisticas.'
            : 'No hay precio de compra vigente en el snapshot de Binance.',
        ],
        provenance,
        dataWindow,
      };
    }

    const len = buyPrices.length;

    // 1. Simple Moving Average & linear regression slope
    const smaWindow = Math.min(len, 25);
    const recentBuyPrices = buyPrices.slice(-smaWindow);
    const sma = recentBuyPrices.reduce((a, b) => a + b, 0) / recentBuyPrices.length;

    let slope: number | null = null;
    if (len >= 3) {
      const regPoints = buyPrices.slice(-Math.min(len, 35));
      const n = regPoints.length;
      let sumX = 0;
      let sumY = 0;
      let sumXY = 0;
      let sumX2 = 0;

      for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += regPoints[i];
        sumXY += i * regPoints[i];
        sumX2 += i * i;
      }
      const denom = n * sumX2 - sumX * sumX;
      slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : null;
    }

    // Trend from the slope as a percentage of price. Fewer than 3 points means
    // there is no slope to speak of, so trend and strength stay null.
    const slopePctPerStep = slope !== null ? (slope / currentPrice) * 100 : null;

    let trend: MarketTrend | null = null;
    let trendStrength: number | null = null;
    if (slopePctPerStep !== null) {
      trend =
        slopePctPerStep > 0.025 ? 'ALCISTA' : slopePctPerStep < -0.025 ? 'BAJISTA' : 'LATERAL';
      // C2: no artificial floor. A flat slope is strength 0, which is the
      // truth, not 35.
      trendStrength = Math.min(100, Math.round(Math.abs(slopePctPerStep) * 600));
    }

    // 2. Volatility. A single sample has no dispersion to measure.
    let stdDev: number | null = null;
    if (recentBuyPrices.length > 1) {
      let variance = 0;
      for (const p of recentBuyPrices) variance += Math.pow(p - sma, 2);
      stdDev = Math.sqrt(variance / (recentBuyPrices.length - 1));
    }
    const volatilityPct =
      stdDev !== null ? Number(((stdDev / currentPrice) * 100).toFixed(2)) : null;

    let volatility: VolatilityLevel | null = null;
    if (volatilityPct !== null) {
      volatility = volatilityPct < 0.35 ? 'BAJA' : volatilityPct > 1.1 ? 'ALTA' : 'MEDIA';
    }

    // 3. Momentum. Needs an earlier point that is actually earlier.
    const lookbackIndex = Math.max(0, len - 6);
    const oldPrice = len > 1 ? buyPrices[lookbackIndex] : null;
    const rocPct =
      oldPrice !== null && oldPrice > 0 ? ((currentPrice - oldPrice) / oldPrice) * 100 : null;

    let momentum: MomentumLevel | null = null;
    if (rocPct !== null) {
      momentum =
        rocPct > 0.15 ? 'ALTO' : rocPct > 0.03 ? 'MODERADO' : rocPct < -0.15 ? 'NEGATIVO' : 'NEUTRO';
    }

    // 4. RSI - undefined when the series never moves.
    const rsi = this.calculateRSI(buyPrices, 14);

    // 5. Price vs SMA
    const priceVsSmaPct = sma > 0 ? Number((((currentPrice - sma) / sma) * 100).toFixed(2)) : null;

    // Support and resistance. The 1.6-sigma band is a hand-picked multiplier,
    // hence HEURISTIC; without a sigma there is no band at all.
    const recentMin = Math.min(...recentBuyPrices);
    const recentMax = Math.max(...recentBuyPrices);
    const supportLevel =
      stdDev !== null ? Number(Math.min(recentMin, currentPrice - stdDev * 1.6).toFixed(2)) : null;
    const resistanceLevel =
      stdDev !== null ? Number(Math.max(recentMax, currentPrice + stdDev * 1.6).toFixed(2)) : null;

    const reasons: string[] = [];
    if (slope !== null && trend !== null) {
      reasons.push(
        `Tendencia ${trend.toLowerCase()}: pendiente de regresión ${slope >= 0 ? '+' : ''}${slope.toFixed(3)} VES/muestra.`
      );
    } else {
      reasons.push('Tendencia no calculable: se requieren al menos 3 observaciones.');
    }
    if (momentum !== null && rocPct !== null) {
      reasons.push(
        `Momentum ${momentum.toLowerCase()}: variación reciente ${rocPct >= 0 ? '+' : ''}${rocPct.toFixed(2)}%.`
      );
    }
    if (volatility !== null && stdDev !== null) {
      reasons.push(
        `Volatilidad ${volatility.toLowerCase()} (${volatilityPct}%): desviación estándar ±${stdDev.toFixed(2)} VES.`
      );
    } else {
      reasons.push('Volatilidad no calculable: se requiere más de una observación.');
    }
    if (priceVsSmaPct !== null) {
      reasons.push(
        `Posición relativa: precio ${priceVsSmaPct >= 0 ? '+' : ''}${priceVsSmaPct}% respecto a la media móvil (SMA ${sma.toFixed(2)} VES).`
      );
    }
    if (rsi === null) {
      reasons.push('RSI no calculable: la serie no registra ninguna variación de precio.');
    } else if (rsi < 35) {
      reasons.push(`RSI en zona de sobreventa (${rsi.toFixed(1)}).`);
    } else if (rsi > 65) {
      reasons.push(`RSI en zona de sobrecompra (${rsi.toFixed(1)}).`);
    }

    const summaryText =
      trend !== null && momentum !== null && volatility !== null
        ? `Mercado ${trend} con momentum ${momentum.toLowerCase()} y volatilidad ${volatility.toLowerCase()}.`
        : 'Análisis parcial: faltan observaciones para clasificar el mercado por completo.';

    return {
      trend,
      trendStrength,
      momentum,
      volatility,
      volatilityPct,
      priceVsSmaPct,
      rsi: rsi === null ? null : Number(rsi.toFixed(1)),
      supportLevel,
      resistanceLevel,
      summaryText,
      reasons,
      provenance,
      dataWindow,
    };
  }

  /**
   * Computes order book volume pressure on both BUY and SELL sides
   */
  public static computeOrderBookPressure(snapshot: MarketSnapshot): MerchantDecisionAdvice['orderBookPressure'] {
    const buyVolumeUsdt = snapshot.topBuyAds.reduce((acc, ad) => acc + (ad.availableUsdt || 0), 0);
    const sellVolumeUsdt = snapshot.topSellAds.reduce((acc, ad) => acc + (ad.availableUsdt || 0), 0);
    const totalVolume = buyVolumeUsdt + sellVolumeUsdt;

    if (totalVolume <= 0) {
      // C2: an empty book is a real observation - Binance answered and there
      // was nothing there. The volumes are null; nothing is invented.
      const noLiquidity =
        'El libro de ordenes no contiene liquidez publicada. No hay volumen que medir.';
      return {
        buyVolumeUsdt: null,
        sellVolumeUsdt: null,
        buyPressurePct: null,
        sellPressurePct: null,
        dominantSide: null,
        buyVolume: { value: null, provenance: 'REAL', reason: noLiquidity },
        sellVolume: { value: null, provenance: 'REAL', reason: noLiquidity },
      };
    }

    const buyPressurePct = Math.round((buyVolumeUsdt / totalVolume) * 100);
    const sellPressurePct = 100 - buyPressurePct;

    let dominantSide: 'COMPRA' | 'VENTA' | 'EQUILIBRADO' = 'EQUILIBRADO';
    if (buyPressurePct >= 58) dominantSide = 'COMPRA';
    else if (sellPressurePct >= 58) dominantSide = 'VENTA';

    const buy = Number(buyVolumeUsdt.toFixed(2));
    const sell = Number(sellVolumeUsdt.toFixed(2));

    return {
      buyVolumeUsdt: buy,
      sellVolumeUsdt: sell,
      buyPressurePct,
      sellPressurePct,
      dominantSide,
      buyVolume: { value: buy, provenance: 'AGGREGATED' },
      sellVolume: { value: sell, provenance: 'AGGREGATED' },
    };
  }

  /**
   * Generates Daily and Intraday Projections with rigorous statistical boundaries and decision support
   */
  public static generateProjections(
    snapshot: MarketSnapshot,
    history: HistoryRecord[],
    analysis: MarketAnalysis,
    /*
     * The instant this projection is made from. Defaults to the wall clock, so
     * production behaviour is byte-for-byte what it was.
     *
     * It exists because the horizons are anchored in time: the seasonal
     * coefficient depends on the Venezuela hour of now + h hours. A
     * walk-forward backtest standing at a past record has to make the engine
     * believe 'now' is that record's timestamp, or it would price a past
     * projection against today's session curve. No heuristic changes - only
     * where the clock is read from.
     */
    nowMs?: number,
    /*
     * The series the HOURLY TIMELINE is drawn from. Defaults to `history`, so
     * every existing caller behaves exactly as before.
     *
     * It exists because the two consumers of `history` need different windows
     * and one of them was starving. Everything statistical - SMA, slope,
     * volatility, bands, probabilities, dataWindow - reads the 100-record
     * window and MUST keep reading it: that window is the methodology.
     * buildHourlyTimeline does something else entirely: it buckets records by
     * hour-of-day across a fixed 13-hour session. 100 records at one per
     * minute span 99 minutes and can therefore fill at most two of those
     * thirteen buckets, which is why the chart reported eleven hours with no
     * tick while the ticks were on disk all along.
     */
    timelineHistory?: HistoryRecord[]
  ): MarketProjections {
    // Same single definition as analyzeMarket, for the same reason.
    const seriesBasis = this.selectSeriesBasis(snapshot, history);
    const currentBuy = seriesBasis.currentBuy;
    const currentSell = seriesBasis.currentSell;
    const projectionNow = nowMs ?? Date.now();
    const currentVetHour = this.getVenezuelaHour(projectionNow);
    const orderBookPressure = this.computeOrderBookPressure(snapshot);
    const dataWindow = this.describeWindow(history);

    const provenance = {
      daily: 'PROJECTED' as const,
      probabilities: 'HEURISTIC' as const,
      confidence: 'HEURISTIC' as const,
      seasonality: 'HEURISTIC' as const,
      merchantAdvice: 'HEURISTIC' as const,
      risk: 'HEURISTIC' as const,
    };

    // C2: no hardcoded 918 / 918.04 stand-in. A missing price is null.
    const currentBuyValued: Valued<number | null> = {
      value: currentBuy,
      provenance: snapshot.bestBuy.provenance,
      reason: snapshot.bestBuy.reason,
    };
    const currentSellValued: Valued<number | null> = {
      value: currentSell,
      provenance: snapshot.bestSell.provenance,
      reason: snapshot.bestSell.reason,
    };

    let insufficientDataReason: string | undefined;
    if (currentBuy === null || currentSell === null) {
      insufficientDataReason =
        'No hay un precio de mercado valido: el snapshot de Binance llego sin precio en al ' +
        'menos uno de los dos lados.';
    } else if (history.length < this.MIN_SAMPLES_FOR_PROJECTION) {
      insufficientDataReason =
        `Solo hay ${history.length} observaciones almacenadas (ventana: ` +
        `${dataWindow.spanMinutes ?? 0} min). Se requieren al menos ` +
        `${this.MIN_SAMPLES_FOR_PROJECTION} para que estas proyecciones tengan alguna base.`;
    }
    const hasSufficientData = insufficientDataReason === undefined;

    // Without a live price nothing downstream can be computed. Everything is
    // null and the timeline is built from stored ticks alone.
    if (currentBuy === null || currentSell === null) {
      return {
        hasSufficientData,
        insufficientDataReason,
        currentBuyPrice: currentBuy,
        currentSellPrice: currentSell,
        currentBuy: currentBuyValued,
        currentSell: currentSellValued,
        dataWindow,
        provenance,
        daily: {
          floor: null,
          ceiling: null,
          rangeText: null,
          direction: analysis.trend,
          confidencePct: null,
          spreadMaxExpected: null,
          reasons: analysis.reasons,
        },
        intradayHorizons: [],
        probabilities: { up: null, neutral: null, down: null },
        hourlyTimeline: this.buildHourlyTimeline(
          snapshot,
          timelineHistory ?? history,
          null,
          null,
          analysis,
          currentVetHour
        ),
        merchantAdvice: this.buildMerchantAdvice(
          snapshot,
          analysis,
          orderBookPressure,
          null,
          null,
          currentVetHour
        ),
        risk: { level: null, factors: ['Sin precio de mercado: no se puede evaluar el riesgo.'] },
      };
    }

    // Volatility band. C2: no 0.65% floor - without a measured volatility
    // there is no band, and therefore no floor/ceiling.
    const baseVolPct = analysis.volatilityPct;
    const dailyDrift =
      analysis.trend === 'ALCISTA' ? 0.007 : analysis.trend === 'BAJISTA' ? -0.007 : 0.001;

    const expectedFloor =
      baseVolPct !== null
        ? Number((currentBuy * (1 - (baseVolPct / 100) * 1.5 + Math.min(0, dailyDrift))).toFixed(2))
        : null;
    const expectedCeiling =
      baseVolPct !== null
        ? Number((currentBuy * (1 + (baseVolPct / 100) * 1.6 + Math.max(0, dailyDrift))).toFixed(2))
        : null;

    /*
     * DIRECTIONAL PROBABILITIES ARE NULL, AND THAT IS THE ANSWER.
     *
     * A hand-written point system used to live here: 33.3 to each outcome,
     * then +26 for the classified trend, -20 against it, +/-8 for order-book
     * pressure, +/-6 for RSI, normalised and clamped to [8, 88]. Its three
     * outputs were rendered on the first screen of the app under
     * "DISTRIBUCION DE PROBABILIDAD (REGRESION & PROFUNDIDAD)" and described
     * as an estimate computed in real time.
     *
     * None of those coefficients was measured. Nothing here counted how often
     * a market in this state actually rose, so the numbers were a rendering of
     * the scoring rules and not of the market. A reader cannot tell those
     * apart, which makes a fabricated 61% worse than an honest gap.
     *
     * This is the same decision, and for the same reason, that was already
     * taken for confidencePct below - which used to be 62 + min(25, n * 0.35)
     * and is now null. Neither is replaced by another arbitrary number.
     *
     * WHERE A REAL ANSWER LIVES. patternEngine.outcomesInWindow counts, on a
     * cell's own series, how many observations in the same situation ended
     * higher, flat or lower a stated horizon later, and reports the sample
     * size and INSUFFICIENT_HISTORY instead of a rate when the counting cannot
     * support one. That is a frequency the operator can check. It is per cell,
     * which is what a maker acts on, and it is already on the analysis screen.
     */
    const pUp: number | null = null;
    const pDown: number | null = null;
    const pNeutral: number | null = null;

    /*
     * C2: confidence is null. It used to be 62 + min(25, n * 0.35), a function
     * of row count rather than of accuracy. A real value requires the backtest
     * to measure this engine's own error (phase 8). It is NOT replaced by
     * another arbitrary number.
     */
    const confidencePct: number | null = null;

    const horizons = ProjectionEngine.HORIZONS;

    const now = projectionNow;
    const intradayHorizons: HourlyProjectionItem[] = horizons.map((h) => {
      const targetTs = now + h.hours * 3600 * 1000;
      const targetVetHour = this.getVenezuelaHour(targetTs);

      // Hand-tuned seasonal coefficients: HEURISTIC, kept and declared.
      let seasonalFactor = 0;
      if (targetVetHour >= 13 && targetVetHour <= 15) seasonalFactor = 0.0035;
      else if (targetVetHour >= 8 && targetVetHour <= 10) seasonalFactor = -0.002;

      const trendFactor =
        analysis.trend === 'ALCISTA'
          ? 0.0022 * h.hours
          : analysis.trend === 'BAJISTA'
          ? -0.0022 * h.hours
          : 0;

      const expectedBuy = currentBuy * (1 + trendFactor + seasonalFactor);
      const expectedSell = currentSell * (1 + trendFactor + seasonalFactor);
      const rangeMargin = baseVolPct !== null ? currentBuy * ((baseVolPct / 100) * h.mult) : null;

      return {
        horizon: h.label,
        targetTime: this.formatVenezuelaTime(targetTs),
        projectedBuy: Number(expectedBuy.toFixed(2)),
        projectedSell: Number(expectedSell.toFixed(2)),
        rangeMin: rangeMargin !== null ? Number((expectedBuy - rangeMargin).toFixed(2)) : null,
        rangeMax: rangeMargin !== null ? Number((expectedBuy + rangeMargin).toFixed(2)) : null,
        confidence: null,
      };
    });

    const hourlyTimeline = this.buildHourlyTimeline(
      snapshot,
      timelineHistory ?? history,
      expectedFloor,
      expectedCeiling,
      analysis,
      currentVetHour
    );

    const merchantAdvice = this.buildMerchantAdvice(
      snapshot,
      analysis,
      orderBookPressure,
      expectedFloor,
      expectedCeiling,
      currentVetHour
    );

    // Risk. Fixed thresholds, hence HEURISTIC; a factor whose input is null is
    // simply not evaluated rather than assumed benign.
    let riskLevel: RiskLevel | null = 'MEDIO';
    const riskFactors: string[] = [];

    if (analysis.volatility === 'ALTA') {
      riskLevel = 'ALTO';
      riskFactors.push('Elevada dispersión de precios en anuncios P2P recientes.');
    }
    /*
     * STRATEGIC, not RAW.
     *
     * spreadPercentage is |max(SELL) - min(BUY)| over the whole book: a single
     * distant ad pushed it to 6.64% while the market sat at 0.14%, and this
     * branch then declared a wide spread and higher friction that did not
     * exist. Friction is a property of the market level, so the market level
     * is what it must read.
     */
    if (snapshot.strategicSpreadPct !== null && snapshot.strategicSpreadPct > 1.8) {
      riskFactors.push(
        `Spread amplio (${snapshot.strategicSpreadPct.toFixed(2)}%): mayor costo de fricción.`
      );
    }
    if (orderBookPressure.sellPressurePct !== null && orderBookPressure.sellPressurePct > 70) {
      riskFactors.push('Fuerte acumulación de oferta vendedora en el libro de órdenes.');
    }
    if (analysis.volatility === null) {
      // Cannot claim low risk when volatility was never measured.
      riskLevel = null;
      riskFactors.push('Riesgo no evaluable: la volatilidad no se ha podido calcular.');
    } else if (riskFactors.length === 0) {
      riskLevel = 'BAJO';
      riskFactors.push('Volatilidad controlada y liquidez comercial equilibrada en USDT/VES.');
    }

    return {
      hasSufficientData,
      insufficientDataReason,
      currentBuyPrice: currentBuy,
      currentSellPrice: currentSell,
      currentBuy: currentBuyValued,
      currentSell: currentSellValued,
      dataWindow,
      provenance,
      daily: {
        floor: expectedFloor,
        ceiling: expectedCeiling,
        rangeText:
          expectedFloor !== null && expectedCeiling !== null
            ? `${expectedFloor} - ${expectedCeiling} VES`
            : null,
        direction: analysis.trend,
        confidencePct,
        // C2: no 1.2% artificial floor. The real expected spread, or null.
        // STRATEGIC: projecting the market's expected spread from a raw
        // extreme projected an outlier forward, not the market.
        spreadMaxExpected:
          snapshot.strategicSpreadPct !== null
            ? Number((snapshot.strategicSpreadPct * 1.15).toFixed(2))
            : null,
        reasons: analysis.reasons,
      },
      intradayHorizons,
      probabilities: { up: pUp, neutral: pNeutral, down: pDown },
      hourlyTimeline,
      merchantAdvice,
      risk: { level: riskLevel, factors: riskFactors },
    };
  }

  /**
   * Builds strategic, forward-looking advice tailored to active P2P merchants
   */
  private static buildMerchantAdvice(
    snapshot: MarketSnapshot,
    analysis: MarketAnalysis,
    orderBookPressure: MerchantDecisionAdvice['orderBookPressure'],
    floor: number | null,
    ceiling: number | null,
    currentVetHour: number
  ): MerchantDecisionAdvice {
    /*
     * PENDING - target classification is OPPORTUNITY, not STRATEGIC: this is
     * advice about an operation, so it should read the best executable
     * quotes. The function has no opportunity input yet and its signature is
     * part of the current contract, so the change waits for the wiring rather
     * than being guessed at here.
     */
    const currentBuy = snapshot.bestBuyPrice;
    const currentSell = snapshot.bestSellPrice;

    /*
     * C2 removals in this block:
     *  - estimatedNetProfitPer1000UsdtVes was (ceiling - floor) * 1000. That
     *    assumes buying the exact low and selling the exact high, and ignores
     *    fees, slippage, liquidity and execution risk. There is no cost model
     *    yet, so the honest value is null (project rule 7).
     *  - optimalSellTimeWindow / optimalBuyTimeWindow were constant strings
     *    returned for every market. Nothing computes them, so they are null.
     */
    const base: Pick<
      MerchantDecisionAdvice,
      | 'optimalSellTimeWindow'
      | 'optimalBuyTimeWindow'
      | 'projectedPeakRate'
      | 'projectedTroughRate'
      | 'estimatedNetProfitPer1000UsdtVes'
      | 'orderBookPressure'
    > = {
      optimalSellTimeWindow: null,
      optimalBuyTimeWindow: null,
      projectedPeakRate: ceiling,
      projectedTroughRate: floor,
      estimatedNetProfitPer1000UsdtVes: null,
      orderBookPressure,
    };

    if (currentBuy === null || currentSell === null) {
      return {
        action: 'ESPERAR_RETROCESO',
        actionTitle: 'Sin datos de mercado suficientes',
        actionExplanation:
          'No hay precio vigente en al menos uno de los dos lados del libro. No es posible ' +
          'recomendar ninguna acción sobre datos ausentes.',
        ...base,
      };
    }

    const rangeText =
      floor !== null && ceiling !== null ? `entre ${floor} VES y ${ceiling} VES` : 'sin rango calculable';

    let action: MerchantDecisionAdvice['action'] = 'ARBITRAJE_RAPIDO';
    let actionTitle = 'Arbitraje Continuo con Spreads Ajustados';
    let actionExplanation =
      `El mercado oscila en un canal lateral ${rangeText}. Se recomienda mantener anuncios ` +
      'activos de compra y venta rotando inventario rápidamente.';

    const buyPressure = orderBookPressure.buyPressurePct;
    const sellPressure = orderBookPressure.sellPressurePct;

    if (analysis.trend === 'ALCISTA' || (buyPressure !== null && buyPressure > 60)) {
      if (currentVetHour < 14) {
        action = 'MANTENER_INVENTARIO';
        actionTitle = 'Mantener USDT y Esperar Pico de la Tarde';
        actionExplanation =
          `La presión compradora es alta (${buyPressure ?? 'n/d'}%). ` +
          (ceiling !== null
            ? `Se proyecta un pico de venta hacia ~${ceiling} VES. `
            : 'No hay techo proyectado calculable. ') +
          'Conviene aguantar inventario.';
      } else {
        action = 'VENDER_AHORA';
        actionTitle = 'Vender USDT en Rango Alto Proyectado';
        actionExplanation =
          `Estamos en zona de pico vespertino (${currentSell.toFixed(2)} VES). Conviene publicar ` +
          'anuncios de venta de USDT para capturar el margen antes del cierre bancario.';
      }
    } else if (analysis.trend === 'BAJISTA' || (sellPressure !== null && sellPressure > 60)) {
      if (floor !== null && currentBuy <= floor * 1.004) {
        action = 'RECOMPRAR_AHORA';
        actionTitle = 'Oportunidad de Recompra en Piso de Soporte';
        actionExplanation =
          `El precio de compra (${currentBuy.toFixed(2)} VES) se encuentra cerca del piso ` +
          `proyectado (${floor} VES).`;
      } else {
        action = 'ESPERAR_RETROCESO';
        actionTitle = 'Esperar Retroceso para Recomprar USDT';
        actionExplanation =
          'Tendencia a la baja en curso. ' +
          (floor !== null
            ? `No apresurar recompras por encima de ${((floor + currentBuy) / 2).toFixed(2)} VES.`
            : 'No hay piso proyectado calculable; esperar confirmación de soporte.');
      }
    }

    return { action, actionTitle, actionExplanation, ...base };
  }

  /**
   * Builds the comprehensive 8 AM - 8 PM intraday chart data points with real historical marks & projections
   */
  private static buildHourlyTimeline(
    snapshot: MarketSnapshot,
    history: HistoryRecord[],
    floor: number | null,
    ceiling: number | null,
    analysis: MarketAnalysis,
    currentVetHour: number
  ): HourlyChartPoint[] {
    const hours = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const hourLabels: Record<number, string> = {
      8: '8 AM',
      9: '9 AM',
      10: '10 AM',
      11: '11 AM',
      12: '12 PM',
      13: '1 PM',
      14: '2 PM',
      15: '3 PM',
      16: '4 PM',
      17: '5 PM',
      18: '6 PM',
      19: '7 PM',
      20: '8 PM',
    };

    // PENDING - RAW anchor on a RAW history series, consistent as it stands.
    const currentBuy = snapshot.bestBuyPrice;
    const currentSell = snapshot.bestSellPrice;

    // Group real historical data by Venezuelan hour of day
    const recordsByHour: Record<number, HistoryRecord[]> = {};
    for (const rec of history) {
      const recHour = this.getVenezuelaHour(rec.timestamp);
      if (!recordsByHour[recHour]) recordsByHour[recHour] = [];
      recordsByHour[recHour].push(rec);
    }

    const activeHour = Math.min(20, Math.max(8, currentVetHour));

    /*
     * Hand-tuned session shape. C2 keeps it ONLY for hours that have not
     * happened yet, where it is declared HEURISTIC seasonality. It is no
     * longer used to manufacture past observations.
     */
    const sessionCurveMultipliers: Record<number, number> = {
      8: -0.0025,
      9: -0.0018,
      10: -0.0008,
      11: 0.0005,
      12: 0.0018,
      13: 0.0032,
      14: 0.0045, // Afternoon Peak
      15: 0.0038,
      16: 0.002,
      17: 0.0005,
      18: -0.0005,
      19: -0.0012,
      20: -0.0018,
    };

    const timeline: HourlyChartPoint[] = [];

    let maxSellSoFar: number | null = null;
    let minBuySoFar: number | null = null;
    let peakHour: number | null = null;
    let troughHour: number | null = null;

    for (const h of hours) {
      const isProjected = h > activeHour;
      const label = hourLabels[h];

      if (!isProjected) {
        const hourData = recordsByHour[h];
        let buyPrice: number | null = null;
        let sellPrice: number | null = null;
        let provenanceReason: string | undefined;

        if (hourData && hourData.length > 0) {
          buyPrice = hourData[hourData.length - 1].buyPrice;
          sellPrice = hourData[hourData.length - 1].sellPrice;
        } else if (h === activeHour && currentBuy !== null && currentSell !== null) {
          buyPrice = currentBuy;
          sellPrice = currentSell;
        } else {
          /*
           * C2 - audit finding B1 removed. This hour has no stored tick, so it
           * is a real gap. Previously the session curve manufactured a price
           * here and published it with isProjected: false, i.e. as a genuine
           * observation. Now it stays null and the chart draws a hole.
           */
          provenanceReason = `No se capturó ningún tick a las ${h}:00 VET.`;
        }

        if (sellPrice !== null && (maxSellSoFar === null || sellPrice > maxSellSoFar)) {
          maxSellSoFar = sellPrice;
          peakHour = h;
        }
        if (buyPrice !== null && (minBuySoFar === null || buyPrice < minBuySoFar)) {
          minBuySoFar = buyPrice;
          troughHour = h;
        }

        const spreadPct =
          buyPrice !== null && sellPrice !== null && buyPrice > 0
            ? Number((((sellPrice - buyPrice) / buyPrice) * 100).toFixed(2))
            : null;

        timeline.push({
          hour: h,
          label,
          sellPrice,
          buyPrice,
          spreadPct,
          projectedSell: null,
          projectedBuy: null,
          floor,
          ceiling,
          isProjected: false,
          provenance: 'REAL',
          provenanceReason,
        });
      } else {
        // Future hour. Needs a live anchor price to extrapolate from.
        if (currentBuy === null || currentSell === null) {
          timeline.push({
            hour: h,
            label,
            sellPrice: null,
            buyPrice: null,
            spreadPct: null,
            projectedSell: null,
            projectedBuy: null,
            floor,
            ceiling,
            isProjected: true,
            provenance: 'PROJECTED',
            provenanceReason: 'Sin precio vigente desde el que extrapolar.',
          });
          continue;
        }

        const hoursAhead = h - activeHour;
        const trendSlope =
          analysis.trend === 'ALCISTA' ? 0.0015 : analysis.trend === 'BAJISTA' ? -0.0015 : 0;
        const curveOffset =
          (sessionCurveMultipliers[h] || 0) - (sessionCurveMultipliers[activeHour] || 0);

        const projectedBuy = Number((currentBuy * (1 + trendSlope * hoursAhead + curveOffset)).toFixed(2));
        const projectedSell = Number((currentSell * (1 + trendSlope * hoursAhead + curveOffset)).toFixed(2));

        timeline.push({
          hour: h,
          label,
          sellPrice: null,
          buyPrice: null,
          spreadPct: Number((((projectedSell - projectedBuy) / projectedBuy) * 100).toFixed(2)),
          projectedSell,
          projectedBuy,
          floor,
          ceiling,
          isProjected: true,
          provenance: 'PROJECTED',
          provenanceReason:
            'Extrapolacion hacia una hora que aun no ha ocurrido, usando la pendiente de ' +
            'tendencia y la curva horaria codificada a mano.',
        });
      }
    }

    /*
     * Peak / trough annotations. C2: only a point with a real price can be a
     * peak or a trough. A gap is never annotated.
     */
    return timeline.map((pt) => {
      let isPeak = false;
      let isTrough = false;
      let isCoincide = false;
      let notes: string | undefined;

      if (!pt.isProjected) {
        if (pt.hour === peakHour && pt.sellPrice !== null) {
          isPeak = true;
          isCoincide = true;
          notes = `PICO ${pt.sellPrice.toFixed(2)}`;
        }
        if (pt.hour === troughHour && pt.buyPrice !== null) {
          isTrough = true;
          notes = `RETROCESO ${pt.buyPrice.toFixed(2)}`;
        }
      } else if (pt.hour === 14 && pt.projectedSell !== null && pt.projectedSell !== undefined) {
        isPeak = true;
        notes = `PICO PROYECTADO ${pt.projectedSell.toFixed(2)}`;
      }

      return { ...pt, isPeak, isTrough, isCoincide, notes };
    });
  }

  /**
   * Backtesting Engine
   * Validates projection accuracy against real accumulated historical data
   */
  public static runBacktest(history: HistoryRecord[]): BacktestMetrics {
    const minSamplesRequired = 10;
    if (history.length < minSamplesRequired) {
      return {
        validatesProductionModel: false,
        modelDescription:
          'Pendiente lineal sobre 5 puntos de history.buyPrice (RAW), prediciendo el siguiente registro almacenado (~6 s). NO es el modelo que genera las proyecciones.',
        hasSufficientData: false,
        sampleSize: history.length,
        samplePeriodDays: 0,
        mae: 0,
        rmse: 0,
        mape: 0,
        directionalAccuracyPct: 0,
        lastEvaluatedAt: new Date().toISOString(),
      };
    }

    let absoluteErrorsSum = 0;
    let squaredErrorsSum = 0;
    let percentageErrorsSum = 0;
    let correctDirectionCount = 0;
    let totalTests = 0;

    const windowSize = 5;
    for (let i = windowSize; i < history.length - 1; i++) {
      const subHistory = history.slice(0, i);
      const currentPoint = history[i];
      const actualNextPoint = history[i + 1];

      const regPoints = subHistory.slice(-windowSize).map((h) => h.buyPrice);
      const n = regPoints.length;
      let sumX = 0;
      let sumY = 0;
      let sumXY = 0;
      let sumX2 = 0;

      for (let j = 0; j < n; j++) {
        sumX += j;
        sumY += regPoints[j];
        sumXY += j * regPoints[j];
        sumX2 += j * j;
      }
      const denom = n * sumX2 - sumX * sumX;
      const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
      const predictedNextBuy = currentPoint.buyPrice + slope;

      const actualBuy = actualNextPoint.buyPrice;
      const absError = Math.abs(predictedNextBuy - actualBuy);
      const sqError = Math.pow(predictedNextBuy - actualBuy, 2);
      const pctError = actualBuy > 0 ? (absError / actualBuy) * 100 : 0;

      absoluteErrorsSum += absError;
      squaredErrorsSum += sqError;
      percentageErrorsSum += pctError;

      const predictedDirection = predictedNextBuy > currentPoint.buyPrice ? 1 : predictedNextBuy < currentPoint.buyPrice ? -1 : 0;
      const actualDirection = actualBuy > currentPoint.buyPrice ? 1 : actualBuy < currentPoint.buyPrice ? -1 : 0;
      if (predictedDirection === actualDirection) {
        correctDirectionCount++;
      }

      totalTests++;
    }

    if (totalTests === 0) {
      return {
        validatesProductionModel: false,
        modelDescription:
          'Pendiente lineal sobre 5 puntos de history.buyPrice (RAW), prediciendo el siguiente registro almacenado (~6 s). NO es el modelo que genera las proyecciones.',
        hasSufficientData: false,
        sampleSize: history.length,
        samplePeriodDays: 0,
        mae: 0,
        rmse: 0,
        mape: 0,
        directionalAccuracyPct: 0,
        lastEvaluatedAt: new Date().toISOString(),
      };
    }

    const mae = Number((absoluteErrorsSum / totalTests).toFixed(3));
    const rmse = Number(Math.sqrt(squaredErrorsSum / totalTests).toFixed(3));
    const mape = Number((percentageErrorsSum / totalTests).toFixed(2));
    const directionalAccuracyPct = Number(((correctDirectionCount / totalTests) * 100).toFixed(1));

    const oldestTs = history[0].timestamp;
    const newestTs = history[history.length - 1].timestamp;
    const daysDiff = Number(((newestTs - oldestTs) / (1000 * 60 * 60 * 24)).toFixed(2));

    return {
      validatesProductionModel: false,
        modelDescription:
          'Pendiente lineal sobre 5 puntos de history.buyPrice (RAW), prediciendo el siguiente registro almacenado (~6 s). NO es el modelo que genera las proyecciones.',
        hasSufficientData: true,
      sampleSize: totalTests,
      samplePeriodDays: daysDiff,
      mae,
      rmse,
      mape,
      directionalAccuracyPct,
      lastEvaluatedAt: new Date().toISOString(),
    };
  }

  /**
   * RSI over the last `period` changes.
   *
   * C2: returns null instead of a plausible number when RSI is undefined -
   * fewer than two prices, or a series with no movement at all. The old code
   * checked `losses === 0` first, so a perfectly flat market reported 100
   * (extreme overbought), which then pushed the direction scoring downward.
   */
  private static calculateRSI(prices: number[], period = 14): number | null {
    if (prices.length < 2) return null;
    const changes: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i] - prices[i - 1]);
    }
    const recentChanges = changes.slice(-period);
    let gains = 0;
    let losses = 0;

    for (const chg of recentChanges) {
      if (chg > 0) gains += chg;
      else losses += Math.abs(chg);
    }

    if (gains === 0 && losses === 0) return null; // no movement: RSI undefined
    if (losses === 0) return 100;
    if (gains === 0) return 0;

    const avgGain = gains / recentChanges.length;
    const avgLoss = losses / recentChanges.length;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }
}
