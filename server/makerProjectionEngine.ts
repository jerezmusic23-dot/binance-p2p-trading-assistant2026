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
  outcomesByDay,
  outcomesInWindow,
  watchWindows,
  type EmpiricalRange,
  type OutcomeDistribution,
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
  exhaustion: { exhausted: boolean; direction: 'BULLISH' | 'BEARISH' | null; reason: string | null };

  /** PROYECTADO: a band, explicitly labelled, never a single number. */
  projectedRange: ProjectedRange;

  /** Zones the series actually turned in. Strongest first. */
  floors: PriceZone[];
  ceilings: PriceZone[];

  /** The nearest zone above and below the live price, for "próximo techo/piso". */
  nextCeiling: PriceZone | null;
  nextFloor: PriceZone | null;

  /**
   * The zone the price is IN, or within one typical step of.
   *
   * Distinct from nextCeiling on purpose. "Next" means the one still ahead, and
   * a price sitting exactly on a ceiling has no ceiling ahead of it - which is
   * precisely the moment a top matters. Reading the top signal off `next`
   * silently made it undetectable at the level itself.
   */
  atCeiling: PriceZone | null;
  atFloor: PriceZone | null;

  /**
   * A zone the price REACHED in the recent window and has since left.
   *
   * Needed because a confirmed top is, by definition, no longer at the level:
   * confirming it means the price got there and turned away. Requiring it to
   * still be in the zone made CONFIRMED_TOP unreachable - the stronger the
   * climb that justified it, the further past the zone the turn happened.
   */
  reachedCeiling: PriceZone | null;
  reachedFloor: PriceZone | null;

  /** Whether the live price has left the zone structure entirely. */
  breakout: Breakout | null;

  watchWindows: WatchWindow[];

  /**
   * What historically followed from moments like this one, counted.
   *
   * `overall` uses every observation; `inWatchWindow` narrows to the hours
   * this cell actually moves in, when such a window exists. Both carry their
   * sample size, and both report INSUFFICIENT_HISTORY rather than a rate when
   * the counting cannot support one.
   */
  continuation: {
    overall: OutcomeDistribution;
    inWatchWindow: OutcomeDistribution | null;
    byDay: { day: number; dayName: string; outcomes: OutcomeDistribution }[];
  };

  /**
   * Set when this side's own series was too thin and the reading came from the
   * general market instead. Null means the answer is this cell's own.
   */
  borrowedFrom: string | null;
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
  /** 'MERCADO GENERAL' when this cell was too thin to be read on its own. */
  borrowedFrom: string | null;
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
 * The zone the price is standing in, within one typical step either side.
 *
 * One step of tolerance because a zone was built from turning points that
 * themselves scattered by about that much; demanding an exact hit would make
 * the level detectable only by coincidence.
 */
function zoneAt(zones: PriceZone[], price: number | null, step: number | null): PriceZone | null {
  if (price === null || step === null || step <= 0) return null;
  const inside = zones.filter((z) => price >= z.low - step && price <= z.high + step);
  if (inside.length === 0) return null;
  // Strongest first: the ordering findZones already applied.
  return inside[0];
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

/** Did the price visit this zone within the recent window? */
function reached(
  zones: PriceZone[],
  observed: readonly { t: number; price: number }[],
  step: number | null,
  window: number
): PriceZone | null {
  if (step === null || step <= 0 || observed.length === 0) return null;
  const recent = observed.slice(-window);
  const visited = zones.filter((z) =>
    recent.some((p) => p.price >= z.low - step && p.price <= z.high + step)
  );
  return visited.length === 0 ? null : visited[0];
}

function projectSide(
  series: readonly HistoricalObservation[],
  which: TrendSeries,
  currentPrice: number | null,
  stepsAhead: number,
  borrowedFrom: string | null = null,
  includeDayPatterns = false
): SideProjection {
  const observed = points(series, which);
  const trend = analyseTrend(series, which);
  const zones = findZones(observed);
  const windows = watchWindows(hourlyActivity(series, which));

  return {
    continuation: {
      overall: outcomesInWindow(series, which, {
        horizon: stepsAhead,
        description: 'Todas las observaciones de esta celda',
      }),
      inWatchWindow:
        windows.length === 0
          ? null
          : outcomesInWindow(series, which, {
              horizon: stepsAhead,
              hours: Array.from(
                { length: windows[0].endHour - windows[0].startHour },
                (_, i) => windows[0].startHour + i
              ),
              description: `Observaciones entre las ${windows[0].startHour}:00 y las ${windows[0].endHour}:00`,
            }),
      /*
       * DAY PATTERNS ARE OPT-IN, and that is a measured decision.
       *
       * Seven distributions per side per cell is 588 passes over the series on
       * every 45-second sweep, and nothing on the alerting path reads them -
       * only the screen showing one cell does. Computing them for all 42 cells
       * made the sweep slow enough to time out a test, which is the cheapest
       * possible way to find out.
       */
      byDay: includeDayPatterns ? outcomesByDay(series, which, stepsAhead) : [],
    },
    borrowedFrom,
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
    atCeiling: zoneAt(zones.ceilings, currentPrice, zones.step),
    atFloor: zoneAt(zones.floors, currentPrice, zones.step),
    reachedCeiling: reached(zones.ceilings, observed, zones.step, 6),
    reachedFloor: reached(zones.floors, observed, zones.step, 6),
    breakout: detectBreakout(currentPrice, zones, zones.step),
    watchWindows: windows,
  };
}

/**
 * Observations a cell needs before it is read on its own terms.
 *
 * Below this the cell borrows the general market's reading and says so, with
 * confidence explicitly reduced. DECLARED ASSUMPTION: it is the trend engine's
 * medium window, so "enough to have a medium-term view" is the same number in
 * both places rather than a second threshold nobody can trace.
 */
export const MIN_OBSERVATIONS_FOR_OWN_READING = 20;

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
  /**
   * Every observation across every cell, for the fallback.
   *
   * NOT a substitute for the cell's own series and never merged with it: it is
   * used only when the cell has too little of its own, and the answer is
   * labelled `borrowedFrom` so nobody can mistake a market-wide reading for
   * this bank at this amount.
   */
  generalSeries?: readonly HistoricalObservation[];
  /** Day-of-week distributions. Off by default; see projectSide. */
  includeDayPatterns?: boolean;
}): CellProjection {
  const stepsAhead = params.stepsAhead ?? DEFAULT_HORIZON_STEPS;
  const series = params.series;

  /*
   * The fallback is offered only when it would actually be better informed.
   * Borrowing a reading that is just as thin adds a caveat and no information.
   */
  const thin = series.length < MIN_OBSERVATIONS_FOR_OWN_READING;
  const general = params.generalSeries ?? [];
  const canBorrow = thin && general.length > series.length;
  const borrowedFrom = canBorrow ? 'MERCADO GENERAL' : null;
  const readingSeries = canBorrow ? general : series;

  return {
    bank: params.bank,
    bankDisplayName: params.bankDisplayName,
    amountKey: params.amountKey,
    amountVes: params.amountVes,
    buy: projectSide(
      readingSeries,
      'BUY',
      params.currentBuyPrice,
      stepsAhead,
      borrowedFrom,
      params.includeDayPatterns
    ),
    sell: projectSide(
      readingSeries,
      'SELL',
      params.currentSellPrice,
      stepsAhead,
      borrowedFrom,
      params.includeDayPatterns
    ),
    // The cell's OWN counts, always - never the borrowed series's.
    observations: series.length,
    firstObservedAt: series.length > 0 ? series[0].timestamp : null,
    lastObservedAt: series.length > 0 ? series[series.length - 1].timestamp : null,
    borrowedFrom,
    reason:
      series.length === 0 && !canBorrow
        ? 'NO_DATA'
        : series.length < 6 && !canBorrow
        ? 'INSUFFICIENT_HISTORY'
        : null,
  };
}
