/**
 * Pure geometry for the intraday chart.
 *
 * Extracted from DailyFluctuationChart so the null handling can be tested
 * without a DOM. The C2 invariant this module exists to protect:
 *
 *   An hour with no captured price produces NO point and BREAKS the line.
 *   It must never be drawn at the vertical midpoint, nor bridged by a segment
 *   that runs straight through the gap - either would put a price on screen
 *   that nobody ever published.
 *
 * No React, no I/O, no Date.now().
 */

import { HourlyChartPoint } from './types';

export interface ChartGeometry {
  svgWidth: number;
  svgHeight: number;
  paddingX: number;
  paddingY: number;
  chartW: number;
  chartH: number;
}

export const CHART_GEOMETRY: ChartGeometry = (() => {
  const svgWidth = 960;
  const svgHeight = 360;
  const paddingX = 45;
  const paddingY = 40;
  return {
    svgWidth,
    svgHeight,
    paddingX,
    paddingY,
    chartW: svgWidth - paddingX * 2,
    chartH: svgHeight - paddingY * 2,
  };
})();

export interface ChartScale {
  /** False when no price at all is available: there is no axis to draw. */
  hasScale: boolean;
  minVal: number;
  maxVal: number;
  valRange: number;
}

/**
 * Price axis bounds from whatever real or projected values exist.
 * With nothing to plot, `hasScale` is false and the bounds are inert - the
 * former behaviour invented a 900-930 VES axis over an empty dataset.
 */
export function computeScale(
  timeline: HourlyChartPoint[],
  floor: number | null | undefined,
  ceiling: number | null | undefined
): ChartScale {
  const prices: number[] = [];

  for (const pt of timeline) {
    if (pt.sellPrice != null) prices.push(pt.sellPrice);
    if (pt.buyPrice != null) prices.push(pt.buyPrice);
    if (pt.projectedSell != null) prices.push(pt.projectedSell);
    if (pt.projectedBuy != null) prices.push(pt.projectedBuy);
  }
  if (ceiling != null) prices.push(ceiling);
  if (floor != null) prices.push(floor);

  const hasScale = prices.length > 0;
  const minVal = hasScale ? Math.min(...prices) * 0.996 : 0;
  const maxVal = hasScale ? Math.max(...prices) * 1.004 : 1;

  return { hasScale, minVal, maxVal, valRange: Math.max(0.5, maxVal - minVal) };
}

/** Horizontal position of the point at `index`. */
export function getX(index: number, pointCount: number, geo: ChartGeometry = CHART_GEOMETRY): number {
  return geo.paddingX + (index / Math.max(1, pointCount - 1)) * geo.chartW;
}

/**
 * Vertical position of a value, or null when there is no value.
 *
 * Returning null is the whole point: callers must skip the point rather than
 * place it somewhere plausible.
 */
export function getY(
  value: number | null | undefined,
  scale: ChartScale,
  geo: ChartGeometry = CHART_GEOMETRY
): number | null {
  if (value === null || value === undefined) return null;
  const ratio = (value - scale.minVal) / scale.valRange;
  return geo.paddingY + geo.chartH - ratio * geo.chartH;
}

export interface TimelinePaths {
  /** Observed sell prices. Multiple `M` commands mean the series has holes. */
  realVenta: string;
  /** Observed buy prices. */
  realRecompra: string;
  /** Projected sell prices, anchored to the last observed point. */
  projVenta: string;
  /** Projected buy prices. */
  projRecompra: string;
  /** Index of the last point with a real buy price, or -1. */
  lastRealIndex: number;
}

/**
 * Builds the four SVG path strings.
 *
 * A point without a price starts a new subpath (`M`) on the next point that
 * does have one, so the rendered line is genuinely discontinuous.
 */
export function buildTimelinePaths(
  timeline: HourlyChartPoint[],
  scale: ChartScale,
  geo: ChartGeometry = CHART_GEOMETRY
): TimelinePaths {
  let realVenta = '';
  let realRecompra = '';
  let projVenta = '';
  let projRecompra = '';
  let lastRealIndex = -1;

  let ventaBroken = false;
  let recompraBroken = false;

  timeline.forEach((pt, i) => {
    if (pt.isProjected) return;

    const x = getX(i, timeline.length, geo);
    const ySell = getY(pt.sellPrice, scale, geo);
    const yBuy = getY(pt.buyPrice, scale, geo);

    if (ySell === null) {
      ventaBroken = true;
    } else {
      realVenta += ventaBroken || realVenta === '' ? `M ${x} ${ySell}` : ` L ${x} ${ySell}`;
      ventaBroken = false;
    }

    if (yBuy === null) {
      recompraBroken = true;
    } else {
      realRecompra += recompraBroken || realRecompra === '' ? `M ${x} ${yBuy}` : ` L ${x} ${yBuy}`;
      recompraBroken = false;
      lastRealIndex = i; // projections continue from the last observed point
    }
  });

  if (lastRealIndex >= 0 && lastRealIndex < timeline.length - 1) {
    const startX = getX(lastRealIndex, timeline.length, geo);
    const startSellY = getY(timeline[lastRealIndex].sellPrice, scale, geo);
    const startBuyY = getY(timeline[lastRealIndex].buyPrice, scale, geo);

    if (startSellY !== null) projVenta = `M ${startX} ${startSellY}`;
    if (startBuyY !== null) projRecompra = `M ${startX} ${startBuyY}`;

    for (let i = lastRealIndex + 1; i < timeline.length; i++) {
      const pt = timeline[i];
      const x = getX(i, timeline.length, geo);
      const ySell = getY(pt.projectedSell, scale, geo);
      const yBuy = getY(pt.projectedBuy, scale, geo);

      if (ySell !== null && projVenta !== '') projVenta += ` L ${x} ${ySell}`;
      if (yBuy !== null && projRecompra !== '') projRecompra += ` L ${x} ${yBuy}`;
    }
  }

  return { realVenta, realRecompra, projVenta, projRecompra, lastRealIndex };
}

/** Number of `M` commands in a path: 0 = empty, 1 = continuous, n = n-1 gaps. */
export function countSubpaths(path: string): number {
  return (path.match(/M /g) || []).length;
}
