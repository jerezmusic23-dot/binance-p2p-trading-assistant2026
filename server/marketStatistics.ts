/**
 * Pure market statistics.
 *
 * No I/O, no Date.now(), no global state: every function is deterministic and
 * depends only on its arguments. This module exists so the numbers the
 * dashboard and the strategy engine rely on can be tested without a network,
 * a filesystem or a clock.
 *
 * Design rules enforced here:
 *  - An undefined statistic returns null. Never 0, never a plausible stand-in.
 *  - BUY and SELL use the SAME definitions. Nothing depends on the caller
 *    having pre-sorted the input, or on which direction it was sorted.
 *  - An outlier is flagged, never deleted. Callers decide what to exclude
 *    from a strategic price; the raw ad always stays visible.
 */

/**
 * Threshold for the modified (MAD-based) z-score.
 *
 * DECLARED ASSUMPTION, not calibrated against this market: 3.5 is the
 * conventional cutoff for the modified z-score. It is exported so it can be
 * tuned, and any value derived with it must be labelled HEURISTIC until there
 * is enough of our own history to calibrate it.
 */
export const DEFAULT_OUTLIER_THRESHOLD = 3.5;

/** Scaling constant that makes the MAD a consistent estimator of sigma for normal data. */
const MAD_TO_SIGMA = 0.6745;

/** Keeps only finite numbers; anything else is absent, not zero. */
function finite(values: readonly number[]): number[] {
  return values.filter((v) => typeof v === 'number' && Number.isFinite(v));
}

/** Ascending copy. The input is never mutated. */
function sortedAsc(values: readonly number[]): number[] {
  return finite(values).slice().sort((a, b) => a - b);
}

/** Arithmetic mean, or null when there is nothing to average. */
export function mean(values: readonly number[]): number | null {
  const clean = finite(values);
  if (clean.length === 0) return null;
  return clean.reduce((acc, v) => acc + v, 0) / clean.length;
}

/**
 * Median.
 *
 * Odd n  -> the middle element.
 * Even n -> the average of the two middle elements, e.g. [1,2,3,4] -> 2.5.
 *
 * The input is sorted internally, so the result does not depend on the order
 * it arrives in: [1,2,3,4] and [4,3,2,1] both give 2.5. This is what makes the
 * BUY side (previously sorted ascending) and the SELL side (previously sorted
 * descending) agree.
 */
export function median(values: readonly number[]): number | null {
  const sorted = sortedAsc(values);
  const n = sorted.length;
  if (n === 0) return null;

  if (n % 2 === 1) return sorted[(n - 1) / 2];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

export interface WeightedSample {
  value: number;
  /** Must be >= 0. A sample with zero weight contributes nothing. */
  weight: number;
}

/**
 * Weight-weighted average, or null when the total weight is zero.
 *
 * Zero total weight makes the average undefined, not zero - that is the
 * difference between "no liquidity reported" and "priced at 0".
 */
export function weightedAverage(samples: readonly WeightedSample[]): number | null {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const { value, weight } of samples) {
    if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) continue;
    totalWeight += weight;
    weightedSum += value * weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : null;
}

/**
 * Median Absolute Deviation: median(|x - median(x)|).
 *
 * Robust measure of spread: unlike the standard deviation, a single extreme
 * value cannot inflate it. Returns null when there is no median to deviate
 * from. Returns 0 legitimately when more than half the values are identical -
 * callers must treat 0 as "no dispersion", not as an error.
 */
export function medianAbsoluteDeviation(values: readonly number[]): number | null {
  const clean = finite(values);
  const center = median(clean);
  if (center === null) return null;
  return median(clean.map((v) => Math.abs(v - center)));
}

/**
 * Modified z-score of one value against a sample: 0.6745 * (x - median) / MAD.
 *
 * Returns null when it cannot be computed - fewer than 3 values, or a MAD of 0
 * (which would divide by zero). A null score means "cannot judge", never
 * "not an outlier".
 */
export function robustZScore(value: number, values: readonly number[]): number | null {
  const clean = finite(values);
  if (clean.length < 3 || !Number.isFinite(value)) return null;

  const center = median(clean);
  const mad = medianAbsoluteDeviation(clean);
  if (center === null || mad === null || mad === 0) return null;

  return (MAD_TO_SIGMA * (value - center)) / mad;
}

export interface OutlierReport {
  /** Indices into the ORIGINAL array that exceeded the threshold. */
  outlierIndices: number[];
  /** Modified z-score per original index; null where it could not be computed. */
  scores: (number | null)[];
  median: number | null;
  mad: number | null;
  /** False when the sample is too small or too degenerate to judge. */
  isDecidable: boolean;
  threshold: number;
}

/**
 * Flags values that sit far from the sample's own centre.
 *
 * This is what stops a single 980 VES ad from setting the strategic rate while
 * the market is at 921. The ad is reported, NOT removed: `outlierIndices` tells
 * the caller what to exclude from a strategic price, and the raw list is
 * untouched so the ad stays auditable.
 *
 * When the sample cannot be judged (fewer than 3 values, or MAD 0),
 * `isDecidable` is false and no value is flagged - refusing to decide is
 * safer than inventing a verdict.
 */
export function detectOutliers(
  values: readonly number[],
  threshold: number = DEFAULT_OUTLIER_THRESHOLD
): OutlierReport {
  const clean = finite(values);
  const center = median(clean);
  const mad = medianAbsoluteDeviation(clean);
  const isDecidable = clean.length >= 3 && mad !== null && mad > 0;

  const scores = values.map((v) => (isDecidable ? robustZScore(v, clean) : null));
  const outlierIndices = isDecidable
    ? scores.reduce<number[]>((acc, score, i) => {
        if (score !== null && Math.abs(score) > threshold) acc.push(i);
        return acc;
      }, [])
    : [];

  return { outlierIndices, scores, median: center, mad, isDecidable, threshold };
}

/** Full descriptive summary of one side of the book. */
export interface SideStatistics {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  mad: number | null;
}

/** Computes every descriptive statistic for one side in a single pass. */
export function describeSide(values: readonly number[]): SideStatistics {
  const sorted = sortedAsc(values);
  return {
    count: sorted.length,
    min: sorted.length > 0 ? sorted[0] : null,
    max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
    mean: mean(sorted),
    median: median(sorted),
    mad: medianAbsoluteDeviation(sorted),
  };
}

/**
 * Signed spread between a sale price and a repurchase price.
 *
 * ((venta - recompra) / recompra) * 100
 *
 * The sign is kept on purpose: a negative result means selling below the cost
 * of repurchasing, i.e. NO margin. Math.abs() would hide exactly the case the
 * operator most needs to see. Returns null if either side is missing or the
 * denominator is not positive.
 */
export function signedSpreadPct(
  venta: number | null | undefined,
  recompra: number | null | undefined
): number | null {
  if (venta === null || venta === undefined || !Number.isFinite(venta)) return null;
  if (recompra === null || recompra === undefined || !Number.isFinite(recompra)) return null;
  if (recompra <= 0) return null;

  return ((venta - recompra) / recompra) * 100;
}

/** Rounds to the 2 decimals this market quotes in, preserving null. */
export function round2(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(2));
}
