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

/**
 * The seven-level reading the operator asked for.
 *
 * GRADED BY SIZE, AND THE YARDSTICK IS THE CELL'S OWN.
 *
 * The move over the window is divided by the drift a random walk of the same
 * length would produce at this cell's typical step. Below 1 the move is inside
 * its own noise - LATERAL. Between 1 and 2 it has cleared it but not by much.
 * Past 3 it is several times what this cell normally manages, which is what
 * "strong" can mean without inventing a VES threshold that would be wrong for
 * every other cell.
 *
 * The two boundaries (2 and 3 multiples of the noise) are DECLARED
 * ASSUMPTIONS. They are not tuned, they are not measured, and they only decide
 * the adjective - never whether a move happened, which is decided at 1 by the
 * random-walk comparison.
 */
export type TrendGrade =
  | 'STRONG_UP'
  | 'UP'
  | 'WEAK_UP'
  | 'LATERAL'
  | 'WEAK_DOWN'
  | 'DOWN'
  | 'STRONG_DOWN'
  | 'UNKNOWN';

/** Multiples of the cell's own noise at which the adjective changes. */
export const GRADE_MODERATE_MULTIPLE = 2;
export const GRADE_STRONG_MULTIPLE = 3;

/**
 * How far the move travelled, measured in this cell's own noise.
 *
 * Returns null when there is nothing to measure against, which is not the same
 * as zero and must not be rendered as LATERAL by accident.
 */
export function noiseMultiple(
  points: readonly { t: number; price: number }[],
  step: number | null
): number | null {
  if (points.length < 2 || step === null || step <= 0) return null;
  const move = points[points.length - 1].price - points[0].price;
  const noise = step * Math.sqrt(points.length - 1);
  if (noise === 0) return null;
  return move / noise;
}

export function gradeOf(multiple: number | null): TrendGrade {
  if (multiple === null) return 'UNKNOWN';
  const size = Math.abs(multiple);
  if (size <= 1) return 'LATERAL';

  const up = multiple > 0;
  if (size >= GRADE_STRONG_MULTIPLE) return up ? 'STRONG_UP' : 'STRONG_DOWN';
  if (size >= GRADE_MODERATE_MULTIPLE) return up ? 'UP' : 'DOWN';
  return up ? 'WEAK_UP' : 'WEAK_DOWN';
}

/**
 * One horizon's reading. Three of them are produced, and they are allowed to
 * disagree - a disagreement is the most useful thing this engine can report.
 */
export interface HorizonReading {
  name: 'VERY_SHORT' | 'SHORT' | 'MEDIUM';
  /** Observations in this horizon's window. */
  observations: number;
  /** Real elapsed time the window covers, so the reader can judge it. */
  spanMs: number | null;
  direction: TrendDirection;
  grade: TrendGrade;
  velocity: number | null;
  noiseMultiple: number | null;
}
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NO_DATA';

/** Why an answer could not be produced. Always stated, never implied. */
export type InsufficiencyReason =
  | 'NO_DATA'
  | 'INSUFFICIENT_HISTORY'
  | 'NO_VARIATION_OBSERVED'
  | null;

export interface TrendState {
  trend: TrendDirection;
  /** The seven-level reading of the SHORT horizon. */
  grade: TrendGrade;
  /** Three horizons, always present, allowed to disagree. */
  horizons: HorizonReading[];
  /**
   * Set when the horizons disagree, in the operator's words - "impulso alcista
   * de corto plazo" is more useful than flattening it to "alcista".
   */
  divergence: string | null;
  /**
   * 0..1, how consistently the series moved in the trend's direction.
   *
   * A DERIVED STATISTIC OVER OBSERVED STEPS, never a probability: it describes
   * the moves that happened and predicts nothing. directionalSteps carries the
   * counts it was computed from so no consumer has to present it as a bare
   * percentage.
   */
  trendStrength: number | null;
  /** The up and down steps trendStrength was computed from. */
  directionalSteps: { up: number; down: number } | null;
  trendConfidence: Confidence;
  /** VES per hour, signed. The slope of the short window. */
  velocity: number | null;
  /** Change in velocity between the older and newer half of the window. */
  acceleration: number | null;

  shortDirection: TrendDirection;
  mediumDirection: TrendDirection;
  /**
   * The medium window EXCLUDING the recent short one: what the background was
   * doing before the latest move.
   *
   * Needed to confirm a reversal at all. Confirming a top means "it was
   * climbing and it has turned", but a fall large enough to turn the short
   * window also erodes the medium window's net move - so measured live, the
   * two conditions cancel and a confirmation could never fire. Measured before
   * the turn, the background keeps saying what it was doing.
   */
  backgroundDirection: TrendDirection;

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
/**
 * How one-directional the observed steps were.
 *
 * NOT A PROBABILITY, and the counts travel with it so it cannot be read as
 * one. |up - down| / (up + down) is the net agreement of the moves that
 * actually happened; it says nothing about the next move. Rendered as a bare
 * "fuerza 73%" it read exactly like a chance of continuing, which is why the
 * raw counts are returned alongside and the interface prints those.
 */
function consistency(
  points: readonly { t: number; price: number }[]
): { value: number | null; up: number; down: number } {
  if (points.length < 2) return { value: null, up: 0, down: 0 };
  let up = 0;
  let down = 0;
  for (let i = 1; i < points.length; i += 1) {
    const diff = points[i].price - points[i - 1].price;
    if (diff > 0) up += 1;
    else if (diff < 0) down += 1;
  }
  const moved = up + down;
  if (moved === 0) return { value: 0, up, down };
  return { value: Math.abs(up - down) / moved, up, down };
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
    grade: 'UNKNOWN',
    horizons: [],
    divergence: null,
    trendStrength: null,
    directionalSteps: null,
    trendConfidence: 'NO_DATA',
    velocity: null,
    acceleration: null,
    shortDirection: 'UNKNOWN',
    mediumDirection: 'UNKNOWN',
    backgroundDirection: 'UNKNOWN',
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
      backgroundDirection: 'SIDEWAYS',
    };
  }

  const shortPoints = points.slice(-shortWindow);
  const mediumPoints = points.slice(-mediumWindow);

  const shortDirection = directionOf(shortPoints, step);
  const mediumDirection = directionOf(mediumPoints, step);
  /* The medium window with the recent move cut off the end. */
  const backgroundPoints = mediumPoints.slice(0, Math.max(0, mediumPoints.length - shortWindow));
  const backgroundDirection =
    backgroundPoints.length >= 2 ? directionOf(backgroundPoints, step) : mediumDirection;
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
   * THREE HORIZONS, and the disagreement between them is the finding.
   *
   * The windows are counted in OBSERVATIONS, not minutes, and each reading
   * reports the real time it actually covers. The capture cadence is a
   * consequence of the tier rotation rather than a guarantee, so a window
   * defined in minutes would silently change meaning the day the schedule
   * changes; a window of n observations always means the same thing, and
   * spanMs tells the reader how long that turned out to be.
   */
  const veryShortPoints = points.slice(-Math.max(3, Math.floor(shortWindow / 2)));
  const horizonOf = (
    name: HorizonReading['name'],
    window: readonly { t: number; price: number }[]
  ): HorizonReading => {
    const multiple = noiseMultiple(window, step);
    return {
      name,
      observations: window.length,
      spanMs: window.length < 2 ? null : window[window.length - 1].t - window[0].t,
      direction: directionOf(window, step),
      grade: gradeOf(multiple),
      velocity: slopeVesPerHour(window),
      noiseMultiple: multiple === null ? null : Number(multiple.toFixed(4)),
    };
  };

  const horizons: HorizonReading[] = [
    horizonOf('VERY_SHORT', veryShortPoints),
    horizonOf('SHORT', shortPoints),
    horizonOf('MEDIUM', mediumPoints),
  ];

  /*
   * Named in the operator's words when the horizons disagree. Flattening a
   * short-term push inside a flat medium term into "alcista" would be the
   * least useful true statement available.
   */
  let divergence: string | null = null;
  if (shortDirection !== mediumDirection) {
    const readable: Record<TrendDirection, string> = {
      BULLISH: 'alcista',
      BEARISH: 'bajista',
      SIDEWAYS: 'lateral',
      TRANSITION: 'en transición',
      UNKNOWN: 'sin datos',
    };
    divergence =
      mediumDirection === 'SIDEWAYS'
        ? `Impulso ${readable[shortDirection]} de corto plazo dentro de un mercado lateral.`
        : shortDirection === 'SIDEWAYS'
        ? `Tendencia ${readable[mediumDirection]} de fondo, plana en el corto plazo.`
        : `Corto plazo ${readable[shortDirection]} contra un fondo ${readable[mediumDirection]}.`;
  }

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
    `Ventana corta (${shortPoints.length} obs.): ${shortDirection} · ${horizons[1].grade}.`,
    `Ventana media (${mediumPoints.length} obs.): ${mediumDirection} · ${horizons[2].grade}.`,
    `Paso típico de esta celda: ${step.toFixed(4)} VES.`,
  ];
  if (divergence !== null) basis.push(divergence);
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
    grade: horizons[1].grade,
    horizons,
    divergence,
    trendStrength: strength.value,
    directionalSteps: { up: strength.up, down: strength.down },
    trendConfidence,
    velocity,
    acceleration,
    shortDirection,
    mediumDirection,
    backgroundDirection,
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
