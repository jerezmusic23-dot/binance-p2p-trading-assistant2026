/**
 * PATTERNS: what this cell has actually done before.
 *
 * Every number this module produces is a COUNT or a QUANTILE over observations
 * that exist on disk. There is no model, no fitted curve and no coefficient.
 * That is deliberate: a probability nobody counted is a decoration, and this
 * project has a rule against decorations.
 *
 * THE PROBABILITY RULE
 *
 *   probability = veces que el patrón fue seguido del resultado
 *                 / veces que el patrón apareció
 *
 * and `sampleSize` travels with it, always. A pattern seen twice reports
 * INSUFFICIENT_HISTORY even when both times it ended the same way, because two
 * out of two is not evidence of anything.
 *
 * PURE, and therefore backtestable: hand it a prefix of a series and it cannot
 * see past the end of that prefix.
 */

import type { HistoricalObservation } from './historicalMarketStore.js';
import { typicalStep, type Confidence, type TrendSeries } from './trendEngine.js';

/**
 * Below this many occurrences a rate is not reported as a probability.
 *
 * DECLARED ASSUMPTION, and the one place a threshold like this is allowed to
 * live. It is not tuned to make any particular pattern look good; it exists so
 * that "2 de 2 = 100%" cannot reach a screen. Exported so a backtest can move
 * it and see what changes.
 */
export const MIN_SAMPLES_FOR_PROBABILITY = 8;

export interface PatternEvidence {
  /** Occurrences of the pattern in the observed series. */
  sampleSize: number;
  /** Of those, how many were followed by the outcome. null when too few. */
  occurrences: number;
  probability: number | null;
  confidence: Confidence;
  reason: 'INSUFFICIENT_HISTORY' | 'NO_DATA' | null;
  description: string;
}

/**
 * Counts a pattern and its outcome over one series.
 *
 * NO LOOK-AHEAD BY CONSTRUCTION: `matched` may only read indices up to i, and
 * `outcome` reads strictly after i. The split is enforced by the signatures,
 * which is stronger than a comment asking callers to behave.
 */
export function measurePattern(
  points: readonly { t: number; price: number }[],
  params: {
    description: string;
    /** True when the pattern is present AT index i, using data up to i only. */
    matched: (history: readonly { t: number; price: number }[], i: number) => boolean;
    /** True when the outcome followed, reading only indices after i. */
    outcome: (future: readonly { t: number; price: number }[]) => boolean;
    /** How far ahead the outcome is looked for. */
    horizon: number;
  }
): PatternEvidence {
  if (points.length === 0) {
    return {
      sampleSize: 0,
      occurrences: 0,
      probability: null,
      confidence: 'NO_DATA',
      reason: 'NO_DATA',
      description: params.description,
    };
  }

  let sampleSize = 0;
  let occurrences = 0;

  /*
   * The loop stops early enough that every counted occurrence has a FULL
   * horizon of real observations after it. Counting a pattern whose outcome
   * has not happened yet would quietly bias the rate towards whatever the
   * series was doing when capture stopped.
   */
  for (let i = 0; i + params.horizon < points.length; i += 1) {
    if (!params.matched(points.slice(0, i + 1), i)) continue;
    sampleSize += 1;
    if (params.outcome(points.slice(i + 1, i + 1 + params.horizon))) occurrences += 1;
  }

  if (sampleSize < MIN_SAMPLES_FOR_PROBABILITY) {
    return {
      sampleSize,
      occurrences,
      probability: null,
      confidence: sampleSize === 0 ? 'NO_DATA' : 'LOW',
      reason: 'INSUFFICIENT_HISTORY',
      description: params.description,
    };
  }

  return {
    sampleSize,
    occurrences,
    probability: occurrences / sampleSize,
    confidence: sampleSize >= MIN_SAMPLES_FOR_PROBABILITY * 4 ? 'HIGH' : 'MEDIUM',
    reason: null,
    description: params.description,
  };
}

/* ------------------------------------------------------------------------ *
 * LEVELS: floors and ceilings, as ZONES
 * ------------------------------------------------------------------------ */

export interface PriceZone {
  /** The zone, low to high. A level is never a single number here. */
  low: number;
  high: number;
  /** How many observed turning points fell inside it. */
  touches: number;
  /** The most recent moment the series was in this zone. */
  lastTouchedAt: number;
  kind: 'FLOOR' | 'CEILING';
  confidence: Confidence;
}

/**
 * Turning points: an observation higher (or lower) than its immediate
 * neighbours by more than this cell's own typical step.
 *
 * The step requirement is what stops every jitter from becoming a "level".
 */
function swings(
  points: readonly { t: number; price: number }[],
  step: number
): { highs: { t: number; price: number }[]; lows: { t: number; price: number }[] } {
  const highs: { t: number; price: number }[] = [];
  const lows: { t: number; price: number }[] = [];

  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1].price;
    const here = points[i].price;
    const next = points[i + 1].price;

    if (here - prev >= step && here - next >= step) highs.push(points[i]);
    if (prev - here >= step && next - here >= step) lows.push(points[i]);
  }

  return { highs, lows };
}

/**
 * Groups turning points that sit within one typical step of each other.
 *
 * A zone is where the series turned around REPEATEDLY. One turn is an event;
 * several at the same price is a level, and the count travels with it so a
 * reader can judge it.
 */
function cluster(
  turns: readonly { t: number; price: number }[],
  step: number,
  kind: 'FLOOR' | 'CEILING'
): PriceZone[] {
  if (turns.length === 0) return [];

  const sorted = [...turns].sort((a, b) => a.price - b.price);
  const zones: PriceZone[] = [];
  let current: { t: number; price: number }[] = [sorted[0]];

  const flush = () => {
    const prices = current.map((p) => p.price);
    zones.push({
      low: Math.min(...prices),
      high: Math.max(...prices),
      touches: current.length,
      lastTouchedAt: Math.max(...current.map((p) => p.t)),
      kind,
      confidence:
        current.length >= 5 ? 'HIGH' : current.length >= 3 ? 'MEDIUM' : 'LOW',
    });
  };

  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].price - current[current.length - 1].price <= step) {
      current.push(sorted[i]);
    } else {
      flush();
      current = [sorted[i]];
    }
  }
  flush();

  // Strongest first: most touches, then most recent.
  return zones.sort((a, b) => b.touches - a.touches || b.lastTouchedAt - a.lastTouchedAt);
}

export function findZones(
  points: readonly { t: number; price: number }[]
): { floors: PriceZone[]; ceilings: PriceZone[]; step: number | null } {
  const step = typicalStep(points);
  if (step === null || step === 0 || points.length < 5) {
    return { floors: [], ceilings: [], step };
  }

  const { highs, lows } = swings(points, step);
  return {
    floors: cluster(lows, step, 'FLOOR'),
    ceilings: cluster(highs, step, 'CEILING'),
    step,
  };
}

/* ------------------------------------------------------------------------ *
 * EMPIRICAL RANGE: where the price went, historically, from here
 * ------------------------------------------------------------------------ */

export interface EmpiricalRange {
  /** Observations of an h-ahead move that this range was built from. */
  sampleSize: number;
  /** The 10th and 90th percentile of observed h-ahead changes, in VES. */
  lowDelta: number | null;
  highDelta: number | null;
  /** Median observed change, signed. */
  medianDelta: number | null;
  confidence: Confidence;
  reason: 'INSUFFICIENT_HISTORY' | 'NO_DATA' | null;
}

/**
 * How much this cell has historically moved over `stepsAhead` observations.
 *
 * NOT a model. It is the empirical distribution of every h-ahead change the
 * series contains, and the projected band is two of its quantiles. If the cell
 * has never moved more than 0.4 VES over that span, the band says 0.4 - it
 * cannot invent a wider one to look prudent, or a narrower one to look sharp.
 */
export function empiricalRange(
  points: readonly { t: number; price: number }[],
  stepsAhead: number
): EmpiricalRange {
  if (points.length === 0) {
    return {
      sampleSize: 0,
      lowDelta: null,
      highDelta: null,
      medianDelta: null,
      confidence: 'NO_DATA',
      reason: 'NO_DATA',
    };
  }

  const deltas: number[] = [];
  for (let i = 0; i + stepsAhead < points.length; i += 1) {
    deltas.push(points[i + stepsAhead].price - points[i].price);
  }

  if (deltas.length < MIN_SAMPLES_FOR_PROBABILITY) {
    return {
      sampleSize: deltas.length,
      lowDelta: null,
      highDelta: null,
      medianDelta: null,
      confidence: deltas.length === 0 ? 'NO_DATA' : 'LOW',
      reason: 'INSUFFICIENT_HISTORY',
    };
  }

  deltas.sort((a, b) => a - b);
  const at = (q: number) => deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))];

  return {
    sampleSize: deltas.length,
    lowDelta: at(0.1),
    highDelta: at(0.9),
    medianDelta: at(0.5),
    confidence: deltas.length >= MIN_SAMPLES_FOR_PROBABILITY * 4 ? 'HIGH' : 'MEDIUM',
    reason: null,
  };
}

/* ------------------------------------------------------------------------ *
 * TIME WINDOWS: when this cell actually moves
 * ------------------------------------------------------------------------ */

export interface HourlyActivity {
  /** Hour of day in Venezuela time, 0-23. */
  hour: number;
  /** Observations recorded in this hour, across every day in the series. */
  sampleSize: number;
  /** Median absolute change between consecutive observations in this hour. */
  medianAbsMoveVes: number | null;
}

export interface WatchWindow {
  startHour: number;
  endHour: number;
  sampleSize: number;
  medianAbsMoveVes: number;
  confidence: Confidence;
}

/** Venezuela is UTC-4 year round; no DST to model. */
export function venezuelaHour(timestamp: number): number {
  return new Date(timestamp - 4 * 3_600_000).getUTCHours();
}

/**
 * Which hours this cell moves in, measured rather than assumed.
 *
 * The 4-hour blocks in the brief are not used as given: they are a guess about
 * the day, and the data decides instead. Contiguous hours whose median move
 * beats the cell's overall median become a window, and each carries the count
 * it was built from.
 */
export function hourlyActivity(
  series: readonly HistoricalObservation[],
  which: TrendSeries
): HourlyActivity[] {
  const byHour = new Map<number, number[]>();

  let previous: { t: number; price: number } | null = null;
  for (const observation of series) {
    const price =
      which === 'BUY' ? observation.buyRecommendedPrice : observation.sellRecommendedPrice;
    if (price === null) {
      previous = null; // A gap breaks the pair; no move is invented across it.
      continue;
    }
    const point = { t: observation.timestamp, price };
    if (previous !== null) {
      const hour = venezuelaHour(point.t);
      const moves = byHour.get(hour) ?? [];
      moves.push(Math.abs(point.price - previous.price));
      byHour.set(hour, moves);
    }
    previous = point;
  }

  const out: HourlyActivity[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const moves = byHour.get(hour) ?? [];
    moves.sort((a, b) => a - b);
    out.push({
      hour,
      sampleSize: moves.length,
      medianAbsMoveVes: moves.length === 0 ? null : moves[Math.floor(moves.length / 2)],
    });
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * WHAT HAPPENED NEXT: outcome distributions, counted
 * ------------------------------------------------------------------------ */

/** Venezuela day of week, 0 = Sunday. UTC-4 year round, no DST to model. */
export function venezuelaDay(timestamp: number): number {
  return new Date(timestamp - 4 * 3_600_000).getUTCDay();
}

export const DAY_NAMES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

/**
 * How a stretch of series ended, relative to where it started.
 *
 * Three buckets and nothing else. A finer classification would suggest a
 * precision the counting cannot support.
 */
export type Outcome = 'UP' | 'FLAT' | 'DOWN';

export interface OutcomeDistribution {
  sampleSize: number;
  up: number;
  flat: number;
  down: number;
  /** Shares of the total, or null below the sample floor. */
  upRate: number | null;
  flatRate: number | null;
  downRate: number | null;
  confidence: Confidence;
  reason: 'INSUFFICIENT_HISTORY' | 'NO_DATA' | null;
  description: string;
}

function classify(from: number, to: number, step: number): Outcome {
  const move = to - from;
  // "Flat" is one typical step of this cell, not a percentage somebody chose.
  if (Math.abs(move) <= step) return 'FLAT';
  return move > 0 ? 'UP' : 'DOWN';
}

function distribution(
  counts: { up: number; flat: number; down: number },
  description: string
): OutcomeDistribution {
  const sampleSize = counts.up + counts.flat + counts.down;
  if (sampleSize < MIN_SAMPLES_FOR_PROBABILITY) {
    return {
      sampleSize,
      ...counts,
      upRate: null,
      flatRate: null,
      downRate: null,
      confidence: sampleSize === 0 ? 'NO_DATA' : 'LOW',
      reason: sampleSize === 0 ? 'NO_DATA' : 'INSUFFICIENT_HISTORY',
      description,
    };
  }
  return {
    sampleSize,
    ...counts,
    upRate: counts.up / sampleSize,
    flatRate: counts.flat / sampleSize,
    downRate: counts.down / sampleSize,
    confidence: sampleSize >= MIN_SAMPLES_FOR_PROBABILITY * 4 ? 'HIGH' : 'MEDIUM',
    reason: null,
    description,
  };
}

/**
 * What historically followed, from moments matching a time window.
 *
 * The counting is the whole method: of every observation that fell in this
 * window and had a full horizon of real data after it, how many ended higher,
 * flat, or lower. No model, no fitted curve, and the sample size travels with
 * the answer so "68% continuó alcista" can never appear next to n=3.
 */
export function outcomesInWindow(
  series: readonly HistoricalObservation[],
  which: TrendSeries,
  params: {
    horizon: number;
    /** Restrict to these Venezuela hours. Empty means every hour. */
    hours?: readonly number[];
    /** Restrict to these Venezuela days. Empty means every day. */
    days?: readonly number[];
    description: string;
  }
): OutcomeDistribution {
  const points: { t: number; price: number }[] = [];
  for (const observation of series) {
    const price =
      which === 'BUY' ? observation.buyRecommendedPrice : observation.sellRecommendedPrice;
    if (price === null) continue;
    points.push({ t: observation.timestamp, price });
  }

  const step = typicalStep(points);
  if (step === null || points.length === 0) {
    return distribution({ up: 0, flat: 0, down: 0 }, params.description);
  }

  const hours = params.hours ?? [];
  const days = params.days ?? [];
  const counts = { up: 0, flat: 0, down: 0 };

  /*
   * Stops a full horizon short of the end. An observation whose outcome has
   * not happened yet cannot be counted, and counting it would bias the rates
   * towards whatever the series was doing when capture stopped.
   */
  for (let i = 0; i + params.horizon < points.length; i += 1) {
    if (hours.length > 0 && !hours.includes(venezuelaHour(points[i].t))) continue;
    if (days.length > 0 && !days.includes(venezuelaDay(points[i].t))) continue;

    const outcome = classify(points[i].price, points[i + params.horizon].price, step);
    if (outcome === 'UP') counts.up += 1;
    else if (outcome === 'DOWN') counts.down += 1;
    else counts.flat += 1;
  }

  return distribution(counts, params.description);
}

/**
 * The same counting, per day of week.
 *
 * Returns every day, including the ones with no evidence - a caller that only
 * saw the days that happened to clear the floor would have no way to know how
 * much of the week is simply unmeasured.
 */
export function outcomesByDay(
  series: readonly HistoricalObservation[],
  which: TrendSeries,
  horizon: number
): { day: number; dayName: string; outcomes: OutcomeDistribution }[] {
  return DAY_NAMES.map((dayName, day) => ({
    day,
    dayName,
    outcomes: outcomesInWindow(series, which, {
      horizon,
      days: [day],
      description: `Observaciones de ${dayName}`,
    }),
  }));
}

/**
 * The hours worth watching, or none.
 *
 * Returns an empty list rather than a plausible-looking window when the series
 * is too short. "MIRAR: 5-8 PM" printed from four observations would be an
 * invention, and this is exactly where one would be easiest to slip in.
 */
export function watchWindows(activity: readonly HourlyActivity[]): WatchWindow[] {
  const measured = activity.filter(
    (a) => a.medianAbsMoveVes !== null && a.sampleSize >= MIN_SAMPLES_FOR_PROBABILITY
  );
  if (measured.length < 3) return [];

  const overall = [...measured.map((a) => a.medianAbsMoveVes as number)].sort((a, b) => a - b);
  const median = overall[Math.floor(overall.length / 2)];

  const busy = new Set(
    measured.filter((a) => (a.medianAbsMoveVes as number) > median).map((a) => a.hour)
  );
  if (busy.size === 0) return [];

  /* Contiguous runs of busy hours become windows. */
  const windows: WatchWindow[] = [];
  let start: number | null = null;

  for (let hour = 0; hour <= 24; hour += 1) {
    const isBusy = busy.has(hour % 24) && hour < 24;
    if (isBusy && start === null) start = hour;
    if (!isBusy && start !== null) {
      const hours = activity.filter((a) => a.hour >= (start as number) && a.hour < hour);
      const samples = hours.reduce((sum, a) => sum + a.sampleSize, 0);
      const moves = hours
        .map((a) => a.medianAbsMoveVes)
        .filter((m): m is number => m !== null)
        .sort((a, b) => a - b);

      if (moves.length > 0) {
        windows.push({
          startHour: start,
          endHour: hour,
          sampleSize: samples,
          medianAbsMoveVes: moves[Math.floor(moves.length / 2)],
          confidence:
            samples >= MIN_SAMPLES_FOR_PROBABILITY * 8
              ? 'HIGH'
              : samples >= MIN_SAMPLES_FOR_PROBABILITY * 3
              ? 'MEDIUM'
              : 'LOW',
        });
      }
      start = null;
    }
  }

  return windows.sort((a, b) => b.medianAbsMoveVes - a.medianAbsMoveVes);
}
