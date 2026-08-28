/**
 * TREND: what the series is doing, and how sure the data lets us be.
 *
 * PURE. Given a series it returns the same answer forever. No clock, no
 * network, no storage - which is also what makes a backtest without look-ahead
 * possible: hand it a prefix of the series and it cannot know what came after.
 *
 * WHY NOT ONE REGRESSION
 *
 * A single least-squares slope over a window answers "did it go up", which is
 * not the question. A market that rose sharply and is now flattening has a
 * positive slope and a decelerating one, and those are different situations
 * requiring different actions. So three things are measured independently and
 * only then combined:
 *
 *   SHORT   the most recent stretch  - what is happening now
 *   MEDIUM  a longer stretch         - what has been happening
 *   CONTEXT the whole usable series  - what normal looks like here
 *
 * Agreement between short and medium is what "trend" means. Disagreement is
 * TRANSITION, which is a finding, not a failure to decide.
 *
 * WHAT DECIDES "FLAT"
 *
 * Not a hardcoded number of VES. A move is flat when it is small COMPARED TO
 * THIS CELL'S OWN observed volatility - the median absolute step between
 * consecutive observations. A cell that normally moves 0.02 and a cell that
 * normally moves 2.00 are then judged on the same terms, and neither threshold
 * was invented by me.
 */

import type { HistoricalObservation } from './historicalMarketStore.js';

export type TrendDirection = 'BULLISH' | 'BEARISH' | 'SIDEWAYS' | 'TRANSITION' | 'UNKNOWN';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NO_DATA';

/** Why an answer could not be produced. Always stated, never implied. */
export type InsufficiencyReason =
  | 'NO_DATA'
  | 'INSUFFICIENT_HISTORY'
  | 'NO_VARIATION_OBSERVED'
  | null;

export interface TrendState {
  trend: TrendDirection;
  /** 0..1, how consistently the series moved in the trend's direction. */
  trendStrength: number | null;
  trendConfidence: Confidence;
  /** VES per hour, signed. The slope of the short window. */
  velocity: number | null;
  /** Change in velocity between the older and newer half of the window. */
  acceleration: number | null;

  shortDirection: TrendDirection;
  mediumDirection: TrendDirection;

  /** The cell's own typical step, which is what "small" is measured against. */
  typicalStepVes: number | null;
  /** Observations the answer was computed from. */
  sampleSize: number;
  reason: InsufficiencyReason;
  /** Human-readable evidence, for a message that must explain itself. */
  basis: string[];
}

/**
 * Minimum observations before a direction is claimed at all.
 *
 * DECLARED ASSUMPTION, not a measured optimum: a slope needs at least a few
 * points before it describes anything, and 6 is the smallest number for which
 * short and medium windows can differ. It is exported so a backtest can vary
 * it rather than having to reproduce it.
 */
export const MIN_OBSERVATIONS_FOR_TREND = 6;

/** Which price a trend is being measured on. Both are maker prices. */
export type TrendSeries = 'BUY' | 'SELL';

function priceOf(observation: HistoricalObservation, series: TrendSeries): number | null {
  return series === 'BUY' ? observation.buyRecommendedPrice : observation.sellRecommendedPrice;
}

/** Points with a real price and a real timestamp. Gaps stay gaps. */
function usablePoints(
  series: readonly HistoricalObservation[],
  which: TrendSeries
): { t: number; price: number }[] {
  const points: { t: number; price: number }[] = [];
  for (const observation of series) {
    const price = priceOf(observation, which);
    if (price === null || !Number.isFinite(price)) continue;
    points.push({ t: observation.timestamp, price });
  }
  return points;
}

/**
 * Least-squares slope in VES per hour.
 *
 * Regressed against real elapsed time, not against the index: observations
 * arrive at irregular intervals and a gap of forty minutes must not count the
 * same as one of four.
 */
export function slopeVesPerHour(points: readonly { t: number; price: number }[]): number | null {
  if (points.length < 2) return null;

  const hours = points.map((p) => p.t / 3_600_000);
  const meanT = hours.reduce((a, b) => a + b, 0) / hours.length;
  const meanP = points.reduce((a, b) => a + b.price, 0) / points.length;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < points.length; i += 1) {
    const dt = hours[i] - meanT;
    numerator += dt * (points[i].price - meanP);
    denominator += dt * dt;
  }

  // Every observation at the same instant: no slope exists to report.
  if (denominator === 0) return null;
  return numerator / denominator;
}

/**
 * The cell's own typical move between consecutive observations.
 *
 * The MEDIAN absolute step, not the mean: one 8-VES jump in an otherwise calm
 * series must not redefine what calm means. This is the yardstick everything
 * else is measured against, and it comes entirely from the cell's own history.
 */
export function typicalStep(points: readonly { t: number; price: number }[]): number | null {
  if (points.length < 2) return null;

  /*
   * NON-ZERO steps only.
   *
   * A cell that sat still for half the window and then moved has a median step
   * of zero, and taking that literally declares "no variation observed" about
   * a series that plainly varied. What this measures is the size of a move
   * WHEN IT MOVES; stretches of no change say nothing about that and are not
   * evidence of a smaller one.
   */
  const steps: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const move = Math.abs(points[i].price - points[i - 1].price);
    if (move > 0) steps.push(move);
  }
  if (steps.length === 0) return 0;
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)];
}

/**
 * Direction of one window.
 *
 * The move over the window is compared against what this cell normally does in
 * that many steps. Below that, it is SIDEWAYS - the series wandered by its own
 * usual amount and calling it a trend would be reading noise.
 */
function directionOf(
  points: readonly { t: number; price: number }[],
  step: number | null
): TrendDirection {
  if (points.length < 2) return 'UNKNOWN';

  const move = points[points.length - 1].price - points[0].price;

  /*
   * A random walk of n steps of size s drifts about s * sqrt(n). Requiring the
   * move to beat that is asking it to be larger than this cell's own noise
   * would typically produce - a comparison against measured behaviour, not
   * against a threshold somebody picked.
   */
  if (step !== null && step > 0) {
    const noise = step * Math.sqrt(points.length - 1);
    if (Math.abs(move) <= noise) return 'SIDEWAYS';
  } else if (move === 0) {
    return 'SIDEWAYS';
  }

  return move > 0 ? 'BULLISH' : 'BEARISH';
}

/** How consistently the steps pointed the same way. 0..1. */
function consistency(points: readonly { t: number; price: number }[]): number | null {
  if (points.length < 2) return null;
  let up = 0;
  let down = 0;
  for (let i = 1; i < points.length; i += 1) {
    const diff = points[i].price - points[i - 1].price;
    if (diff > 0) up += 1;
    else if (diff < 0) down += 1;
  }
  const moved = up + down;
  if (moved === 0) return 0;
  return Math.abs(up - down) / moved;
}

export interface TrendOptions {
  /** Observations in the short window. */
  shortWindow?: number;
  /** Observations in the medium window. */
  mediumWindow?: number;
  minObservations?: number;
}

export function analyseTrend(
  series: readonly HistoricalObservation[],
  which: TrendSeries,
  options: TrendOptions = {}
): TrendState {
  const shortWindow = options.shortWindow ?? 6;
  const mediumWindow = options.mediumWindow ?? 20;
  const minObservations = options.minObservations ?? MIN_OBSERVATIONS_FOR_TREND;

  const empty = (reason: InsufficiencyReason, sampleSize: number, basis: string[]): TrendState => ({
    trend: 'UNKNOWN',
    trendStrength: null,
    trendConfidence: 'NO_DATA',
    velocity: null,
    acceleration: null,
    shortDirection: 'UNKNOWN',
    mediumDirection: 'UNKNOWN',
    typicalStepVes: null,
    sampleSize,
    reason,
    basis,
  });

  const points = usablePoints(series, which);
  if (points.length === 0) {
    return empty('NO_DATA', 0, ['La serie no contiene ningún precio utilizable.']);
  }
  if (points.length < minObservations) {
    return empty('INSUFFICIENT_HISTORY', points.length, [
      `Sólo ${points.length} observaciones; se necesitan ${minObservations}.`,
    ]);
  }

  const step = typicalStep(points);
  if (step === null || step === 0) {
    /*
     * A completely flat series is a real observation, not an error: the cell
     * has not moved once. Reported as SIDEWAYS with the reason stated, so a
     * reader can tell it apart from "we could not tell".
     */
    return {
      ...empty('NO_VARIATION_OBSERVED', points.length, [
        'El precio no ha cambiado en ninguna observación registrada.',
      ]),
      trend: 'SIDEWAYS',
      trendStrength: 0,
      trendConfidence: 'LOW',
      velocity: 0,
      typicalStepVes: 0,
      shortDirection: 'SIDEWAYS',
      mediumDirection: 'SIDEWAYS',
    };
  }

  const shortPoints = points.slice(-shortWindow);
  const mediumPoints = points.slice(-mediumWindow);

  const shortDirection = directionOf(shortPoints, step);
  const mediumDirection = directionOf(mediumPoints, step);
  const velocity = slopeVesPerHour(shortPoints);

  /*
   * ACCELERATION: the recent slope against the established one.
   *
   * Comparing the two halves of the SHORT window only was the obvious
   * implementation and it is blind to the case that matters: a series that
   * climbed steeply for an hour and has spent the last half hour crawling is
   * a straight line inside the short window, so the halves agree and the
   * reading comes out as zero - precisely when a human would say it is losing
   * steam. Measured against the medium window, that same series reports the
   * deceleration it plainly has.
   */
  const mediumSlope = slopeVesPerHour(mediumPoints);
  const acceleration =
    velocity === null || mediumSlope === null ? null : velocity - mediumSlope;

  /*
   * The two windows decide together. Agreement is a trend; disagreement is a
   * TRANSITION, which is exactly the situation this engine exists to catch and
   * must never be flattened into whichever window shouted louder.
   */
  let trend: TrendDirection;
  if (shortDirection === mediumDirection) {
    trend = shortDirection;
  } else if (shortDirection === 'SIDEWAYS' || mediumDirection === 'SIDEWAYS') {
    trend = 'TRANSITION';
  } else {
    // Opposite directions: the short window is the newer information.
    trend = 'TRANSITION';
  }

  const strength = consistency(shortPoints);

  /*
   * Confidence is about how much evidence there is, never about how much the
   * engine likes the answer. Sample size and agreement, nothing else.
   */
  let trendConfidence: Confidence;
  if (points.length >= mediumWindow && shortDirection === mediumDirection) {
    trendConfidence = 'HIGH';
  } else if (points.length >= mediumWindow || shortDirection === mediumDirection) {
    trendConfidence = 'MEDIUM';
  } else {
    trendConfidence = 'LOW';
  }

  const basis = [
    `Ventana corta (${shortPoints.length} obs.): ${shortDirection}.`,
    `Ventana media (${mediumPoints.length} obs.): ${mediumDirection}.`,
    `Paso típico de esta celda: ${step.toFixed(4)} VES.`,
  ];
  if (velocity !== null) basis.push(`Velocidad: ${velocity.toFixed(4)} VES/hora.`);
  if (acceleration !== null) {
    basis.push(
      acceleration > 0
        ? `Acelerando (${acceleration.toFixed(4)} VES/hora²).`
        : acceleration < 0
        ? `Desacelerando (${acceleration.toFixed(4)} VES/hora²).`
        : 'Velocidad constante.'
    );
  }

  return {
    trend,
    trendStrength: strength,
    trendConfidence,
    velocity,
    acceleration,
    shortDirection,
    mediumDirection,
    typicalStepVes: step,
    sampleSize: points.length,
    reason: null,
    basis,
  };
}

/**
 * EXHAUSTION: the trend still points one way, but is running out of force.
 *
 * Deliberately NOT the same thing as a trend change. It is the early state -
 * still BULLISH, decelerating, losing consistency - and it is reported as such
 * so a reader is never told a reversal happened when it has not.
 */
export function detectExhaustion(state: TrendState): {
  exhausted: boolean;
  /** The direction that is running out. Never invented - it is the medium window's. */
  direction: 'BULLISH' | 'BEARISH' | null;
  reason: string | null;
} {
  const none = { exhausted: false, direction: null, reason: null } as const;

  /*
   * THE DIRECTION THAT IS TIRING IS THE ESTABLISHED ONE.
   *
   * Exhaustion is a stage in the sequence the operator described:
   *
   *   BAJISTA -> desaceleración -> lateralización -> ... -> ALCISTA
   *
   * The middle of that is a series whose medium window still points down while
   * the short one has gone flat. Requiring `trend` to still read BEARISH would
   * miss exactly that moment, because by then the two windows disagree and the
   * trend reads TRANSITION. So the medium window supplies the direction, and
   * the short window supplies the evidence that it is fading.
   */
  const established =
    state.mediumDirection === 'BULLISH' || state.mediumDirection === 'BEARISH'
      ? state.mediumDirection
      : null;
  if (established === null) return none;
  if (state.velocity === null || state.acceleration === null) return none;

  // The slope has shrunk relative to the established one.
  const slowing = established === 'BULLISH' ? state.acceleration < 0 : state.acceleration > 0;
  if (!slowing) return none;

  // ...and it has not yet crossed into the opposite direction, which would be
  // a reversal rather than exhaustion, and must not be reported as this.
  const reversed = established === 'BULLISH' ? state.velocity < 0 : state.velocity > 0;
  if (reversed) return none;

  return {
    exhausted: true,
    direction: established,
    reason:
      established === 'BULLISH'
        ? 'Sigue subiendo, pero cada vez más despacio.'
        : 'Sigue bajando, pero cada vez más despacio.',
  };
}
