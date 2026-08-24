/**
 * Display helpers for a contract where any figure can legitimately be absent.
 *
 * Phase C2 rule: a missing value is rendered as an explicit gap. It is never
 * coerced to 0, to a plausible number, or to an empty string that reads like a
 * value. `||` is never used for this - a legitimate 0 must survive.
 */

export const NO_DATA = '--';

/** Fixed-decimal number, or the no-data marker. */
export function fmt(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || Number.isNaN(value)
    ? NO_DATA
    : value.toFixed(digits);
}

/** Percentage with its sign kept, or the no-data marker. */
export function fmtPct(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || Number.isNaN(value)
    ? NO_DATA
    : `${value.toFixed(digits)}%`;
}

/** Signed percentage (leading + for non-negative values). */
export function fmtSignedPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return NO_DATA;
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

/** Thousands-separated integer, or the no-data marker. */
export function fmtInt(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value)
    ? NO_DATA
    : value.toLocaleString();
}

/** A string field that may be absent. */
export function fmtText(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? NO_DATA : value;
}
