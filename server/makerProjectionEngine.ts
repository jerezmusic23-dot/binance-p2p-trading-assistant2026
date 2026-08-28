/**
 * PROJECTION, for the price I publish.
 *
 * Composes trendEngine and patternEngine into one answer per BANCO x MONTO x
 * SIDE. It adds no assumption of its own: every number here was either counted
 * or measured downstream, and this module's whole job is to put them together
 * and refuse to speak when they are not there.
 *
 * THE THREE THINGS THAT ARE NEVER MIXED
 *
 *   ACTUAL      the price to publish right now, from the live maker matrix
 *   PROYECTADO  a range this cell has historically moved into, from the series
 *   HISTÓRICO   the observations both of the above were derived from
 *
 * They travel in separate fields with separate names, because a projected
 * ceiling rendered next to a live price with the same styling is how somebody
 * ends up publishing an ad at a number Binance never quoted.
 *
 * MAKER SEMANTICS, UNCHANGED AND RE-STATED HERE BECAUSE THIS IS WHERE IT WOULD
 * BE EASIEST TO LOSE:
 *
 *   MI COMPRA -> listado tradeType=SELL -> líder = precio MÁS ALTO
 *   MI VENTA  -> listado tradeType=BUY  -> líder = precio MÁS BAJO
 *
 * This module never reads a listing itself. It reads the series that the maker
 * engine already wrote, whose buyRecommendedPrice is by construction the price
 * for MY buy ad. Nothing here can re-derive the mapping, and therefore nothing
 * here can invert it.
 */

import type { HistoricalObservation } from './historicalMarketStore.js';
import {
  analyseTrend,
  detectExhaustion,
  type Confidence,
  type TrendSeries,
  type TrendState,
} from './trendEngine.js';
import {
  empiricalRange,
  findZones,
  hourlyActivity,
  watchWindows,
  type EmpiricalRange,
  type PriceZone,
  type WatchWindow,
} from './patternEngine.js';

export interface ProjectedRange {
  /** Where the band sits in VES, or null when the series cannot support one. */
  low: number | null;
  high: number | null;
  /** Observations of this horizon the band was built from. */
  sampleSize: number;
  confidence: Confidence;
  /** How many observations ahead this describes. */
  stepsAhead: number;
  reason: EmpiricalRange['reason'];
  basis: string;
}

export interface SideProjection {
  side: TrendSeries;
  /** The maker label, so no consumer has to map it back. */
  label: 'MI COMPRA DE USDT' | 'MI VENTA DE USDT';
  /** Which Binance listing this side's competitors live in. */
  listingTradeType: 'BUY' | 'SELL';

  /** ACTUAL: the live price to publish. Never a projection. */
  currentPrice: number | null;

  trend: TrendState;
  exhaustion: { exhausted: boolean; reason: string | null };

  /** PROYECTADO: a band, explicitly labelled, never a single number. */
  projectedRange: ProjectedRange;

  /** Zones the series actually turned in. Strongest first. */
  floors: PriceZone[];
  ceilings: PriceZone[];

  /** The nearest zone above and below the live price. */
  nextCeiling: PriceZone | null;
  nextFloor: PriceZone | null;

  /** Whether the live price has left the zone structure entirely. */
  breakout: Breakout | null;

  watchWindows: WatchWindow[];
}

export interface Breakout {
  direction: 'UP' | 'DOWN';
  /** The zone that was broken. */
  level: number;
  currentPrice: number;
  /** Signed distance past the level, in VES. */
  distanceVes: number;
  /** Distance measured in this cell's own typical steps. */
  distanceInSteps: number | null;
  strength: 'ALTA' | 'MEDIA' | 'BAJA';
  status: 'EARLY_WARNING' | 'CONFIRMED';
}

export interface CellProjection {
  bank: string;
  bankDisplayName: string;
  amountKey: string;
  amountVes: number;

  buy: SideProjection;
  sell: SideProjection;

  /** What the series contains. Stated so nothing has to be assumed. */
  observations: number;
  firstObservedAt: number | null;
  lastObservedAt: number | null;
  reason: 'NO_DATA' | 'INSUFFICIENT_HISTORY' | null;
}

/**
 * How far ahead a projection describes, in OBSERVATIONS rather than minutes.
 *
 * The sweep rotates tiers, so a cell is observed roughly every four and a half
 * minutes - but that is a consequence of the current schedule, not a
 * guarantee. Counting in observations means the band stays meaningful if the
 * cadence changes, and the caller converts to wall-clock using the series's own
 * measured interval rather than an assumed one.
 */
export const DEFAULT_HORIZON_STEPS = 6;

function points(series: readonly HistoricalObservation[], which: TrendSeries) {
  const out: { t: number; price: number }[] = [];
  for (const observation of series) {
    const price =
      which === 'BUY' ? observation.buyRecommendedPrice : observation.sellRecommendedPrice;
    if (price === null || !Number.isFinite(price)) continue;
    out.push({ t: observation.timestamp, price });
  }
  return out;
}

/**
 * Projects a band around the live price from the observed distribution of
 * moves - not from the trend line.
 *
 * Extrapolating the slope would produce a confident-looking number with no
 * error attached. The empirical quantiles say instead: from a price like this,
 * over this many observations, this cell has historically ended up between
 * here and here, this many times.
 */
function projectRange(
  currentPrice: number | null,
  observed: { t: number; price: number }[],
  stepsAhead: number
): ProjectedRange {
  const range = empiricalRange(observed, stepsAhead);

  if (currentPrice === null || range.lowDelta === null || range.highDelta === null) {
    return {
      low: null,
      high: null,
      sampleSize: range.sampleSize,
      confidence: range.confidence,
      stepsAhead,
      reason: range.reason ?? (currentPrice === null ? 'NO_DATA' : null),
      basis:
        currentPrice === null
          ? 'No hay precio actual publicable sobre el que proyectar.'
          : `Sólo ${range.sampleSize} movimientos observados a ${stepsAhead} observaciones vista.`,
    };
  }

  return {
    low: Number((currentPrice + range.lowDelta).toFixed(4)),
    high: Number((currentPrice + range.highDelta).toFixed(4)),
    sampleSize: range.sampleSize,
    confidence: range.confidence,
    stepsAhead,
    reason: null,
    basis:
      `Percentiles 10-90 de ${range.sampleSize} movimientos reales de esta celda ` +
      `a ${stepsAhead} observaciones vista.`,
  };
}

/** The nearest zone strictly above / below the live price. */
function nearest(zones: PriceZone[], price: number | null, above: boolean): PriceZone | null {
  if (price === null) return null;
  const candidates = zones.filter((z) => (above ? z.low > price : z.high < price));
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) =>
    above ? a.low - b.low : b.high - a.high
  )[0];
}

/**
 * A breakout is the live price sitting OUTSIDE every zone the series built.
 *
 * Reported as EARLY_WARNING until it has moved more than one typical step past
 * the level - a price a hair over a ceiling is inside the noise that built the
 * ceiling in the first place.
 */
function detectBreakout(
  currentPrice: number | null,
  zones: { floors: PriceZone[]; ceilings: PriceZone[]; step: number | null },
  step: number | null
): Breakout | null {
  if (currentPrice === null || step === null || step === 0) return null;

  const topCeiling = zones.ceilings
    .slice()
    .sort((a, b) => b.high - a.high)[0];
  const bottomFloor = zones.floors.slice().sort((a, b) => a.low - b.low)[0];

  const evaluate = (
    level: number,
    direction: 'UP' | 'DOWN'
  ): Breakout => {
    const distanceVes = Number((currentPrice - level).toFixed(4));
    const steps = Math.abs(distanceVes) / step;
    return {
      direction,
      level,
      currentPrice,
      distanceVes,
      distanceInSteps: Number(steps.toFixed(2)),
      strength: steps >= 3 ? 'ALTA' : steps >= 1.5 ? 'MEDIA' : 'BAJA',
      status: steps > 1 ? 'CONFIRMED' : 'EARLY_WARNING',
    };
  };

  if (topCeiling !== undefined && currentPrice > topCeiling.high) {
    return evaluate(topCeiling.high, 'UP');
  }
  if (bottomFloor !== undefined && currentPrice < bottomFloor.low) {
    return evaluate(bottomFloor.low, 'DOWN');
  }
  return null;
}

function projectSide(
  series: readonly HistoricalObservation[],
  which: TrendSeries,
  currentPrice: number | null,
  stepsAhead: number
): SideProjection {
  const observed = points(series, which);
  const trend = analyseTrend(series, which);
  const zones = findZones(observed);

  return {
    side: which,
    label: which === 'BUY' ? 'MI COMPRA DE USDT' : 'MI VENTA DE USDT',
    // Restated from the maker model, never re-derived: my buy competes in SELL.
    listingTradeType: which === 'BUY' ? 'SELL' : 'BUY',
    currentPrice,
    trend,
    exhaustion: detectExhaustion(trend),
    projectedRange: projectRange(currentPrice, observed, stepsAhead),
    floors: zones.floors,
    ceilings: zones.ceilings,
    nextCeiling: nearest(zones.ceilings, currentPrice, true),
    nextFloor: nearest(zones.floors, currentPrice, false),
    breakout: detectBreakout(currentPrice, zones, zones.step),
    watchWindows: watchWindows(hourlyActivity(series, which)),
  };
}

export function projectCell(params: {
  bank: string;
  bankDisplayName: string;
  amountKey: string;
  amountVes: number;
  series: readonly HistoricalObservation[];
  /** The live prices from the maker matrix. null when there is none today. */
  currentBuyPrice: number | null;
  currentSellPrice: number | null;
  stepsAhead?: number;
}): CellProjection {
  const stepsAhead = params.stepsAhead ?? DEFAULT_HORIZON_STEPS;
  const series = params.series;

  return {
    bank: params.bank,
    bankDisplayName: params.bankDisplayName,
    amountKey: params.amountKey,
    amountVes: params.amountVes,
    buy: projectSide(series, 'BUY', params.currentBuyPrice, stepsAhead),
    sell: projectSide(series, 'SELL', params.currentSellPrice, stepsAhead),
    observations: series.length,
    firstObservedAt: series.length > 0 ? series[0].timestamp : null,
    lastObservedAt: series.length > 0 ? series[series.length - 1].timestamp : null,
    reason:
      series.length === 0
        ? 'NO_DATA'
        : series.length < 6
        ? 'INSUFFICIENT_HISTORY'
        : null,
  };
}
