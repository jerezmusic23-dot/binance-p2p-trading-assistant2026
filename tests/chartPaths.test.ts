/**
 * PHASE 5-C2 - chart gap geometry
 *
 * The invariant under test: an hour with no captured price must produce a
 * genuine discontinuity. Before C2, getY returned the vertical midpoint for a
 * null, so a missing hour was drawn as a point in the middle of the chart and
 * the line ran straight through it - a price nobody ever published.
 */

import { describe, it, expect } from 'vitest';
import {
  CHART_GEOMETRY,
  buildTimelinePaths,
  computeScale,
  countSubpaths,
  getX,
  getY,
} from '../src/chartPaths';
import type { HourlyChartPoint } from '../src/types';

/** Past hour with an observed price. */
function observed(hour: number, buyPrice: number, sellPrice: number): HourlyChartPoint {
  return {
    hour,
    label: `${hour}h`,
    buyPrice,
    sellPrice,
    spreadPct: Number((((sellPrice - buyPrice) / buyPrice) * 100).toFixed(2)),
    projectedBuy: null,
    projectedSell: null,
    floor: null,
    ceiling: null,
    isProjected: false,
    provenance: 'REAL',
  };
}

/** Past hour with no captured tick - a real gap. */
function gap(hour: number): HourlyChartPoint {
  return {
    hour,
    label: `${hour}h`,
    buyPrice: null,
    sellPrice: null,
    spreadPct: null,
    projectedBuy: null,
    projectedSell: null,
    floor: null,
    ceiling: null,
    isProjected: false,
    provenance: 'REAL',
    provenanceReason: `No se capturó ningún tick a las ${hour}:00 VET.`,
  };
}

/** Future hour. */
function projected(hour: number, buy: number, sell: number): HourlyChartPoint {
  return {
    hour,
    label: `${hour}h`,
    buyPrice: null,
    sellPrice: null,
    spreadPct: null,
    projectedBuy: buy,
    projectedSell: sell,
    floor: null,
    ceiling: null,
    isProjected: true,
    provenance: 'PROJECTED',
  };
}

const { paddingY, chartH } = CHART_GEOMETRY;
const VERTICAL_MIDPOINT = chartH / 2 + paddingY; // what the old getY returned for null

describe('computeScale', () => {
  it('spans the observed and projected prices', () => {
    const scale = computeScale([observed(8, 918, 921), projected(13, 930, 933)], null, null);
    expect(scale.hasScale).toBe(true);
    expect(scale.minVal).toBeCloseTo(918 * 0.996, 5);
    expect(scale.maxVal).toBeCloseTo(933 * 1.004, 5);
  });

  it('includes floor and ceiling when present', () => {
    const scale = computeScale([observed(8, 918, 921)], 900, 950);
    expect(scale.minVal).toBeCloseTo(900 * 0.996, 5);
    expect(scale.maxVal).toBeCloseTo(950 * 1.004, 5);
  });

  it('reports no scale at all when nothing can be plotted', () => {
    // Was: a hardcoded 900-930 axis painted over an empty dataset.
    const scale = computeScale([gap(8), gap(9), gap(10)], null, null);
    expect(scale.hasScale).toBe(false);
  });

  it('ignores gaps when computing the bounds', () => {
    const withGaps = computeScale([observed(8, 918, 921), gap(9), observed(10, 919, 922)], null, null);
    const without = computeScale([observed(8, 918, 921), observed(10, 919, 922)], null, null);
    expect(withGaps).toEqual(without);
  });
});

describe('getY', () => {
  const scale = computeScale([observed(8, 900, 1000)], null, null);

  it('returns null for a missing value instead of a plottable position', () => {
    expect(getY(null, scale)).toBeNull();
    expect(getY(undefined, scale)).toBeNull();
  });

  it('never returns the vertical midpoint for a null (the old fabrication)', () => {
    expect(getY(null, scale)).not.toBe(VERTICAL_MIDPOINT);
  });

  it('maps a higher price to a smaller y (SVG y grows downward)', () => {
    const low = getY(910, scale);
    const high = getY(990, scale);
    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    expect(high!).toBeLessThan(low!);
  });

  it('keeps every plotted point inside the drawing area', () => {
    for (const price of [900, 950, 1000]) {
      const y = getY(price, scale)!;
      expect(y).toBeGreaterThanOrEqual(paddingY - 1);
      expect(y).toBeLessThanOrEqual(paddingY + chartH + 1);
    }
  });

  it('preserves a legitimate 0 rather than treating it as absent', () => {
    const zeroScale = computeScale([observed(8, 0, 10)], null, null);
    expect(getY(0, zeroScale)).not.toBeNull();
  });
});

describe('buildTimelinePaths - discontinuities', () => {
  it('draws one continuous subpath when every hour has data', () => {
    const timeline = [observed(8, 918, 921), observed(9, 919, 922), observed(10, 920, 923)];
    const paths = buildTimelinePaths(timeline, computeScale(timeline, null, null));

    expect(countSubpaths(paths.realVenta)).toBe(1);
    expect(countSubpaths(paths.realRecompra)).toBe(1);
    expect(paths.realVenta.startsWith('M ')).toBe(true);
    expect((paths.realVenta.match(/ L /g) || []).length).toBe(2);
  });

  it('BREAKS the line at a gap instead of bridging it', () => {
    const timeline = [observed(8, 918, 921), gap(9), observed(10, 920, 923)];
    const paths = buildTimelinePaths(timeline, computeScale(timeline, null, null));

    // Two subpaths = one real hole. A single subpath would mean the renderer
    // drew a segment straight across the missing hour.
    expect(countSubpaths(paths.realVenta)).toBe(2);
    expect(countSubpaths(paths.realRecompra)).toBe(2);
  });

  it('emits no coordinate at all for the missing hour', () => {
    const timeline = [observed(8, 918, 921), gap(9), observed(10, 920, 923)];
    const scale = computeScale(timeline, null, null);
    const paths = buildTimelinePaths(timeline, scale);

    const gapX = getX(1, timeline.length);
    expect(paths.realVenta).not.toContain(String(gapX));
    expect(paths.realRecompra).not.toContain(String(gapX));

    // And nothing sits at the vertical midpoint.
    expect(paths.realVenta).not.toContain(String(VERTICAL_MIDPOINT));
    expect(paths.realRecompra).not.toContain(String(VERTICAL_MIDPOINT));
  });

  it('counts one subpath per contiguous run of data', () => {
    const timeline = [
      observed(8, 918, 921),
      gap(9),
      observed(10, 920, 923),
      observed(11, 921, 924),
      gap(12),
      gap(13),
      observed(14, 925, 928),
    ];
    const paths = buildTimelinePaths(timeline, computeScale(timeline, null, null));
    expect(countSubpaths(paths.realVenta)).toBe(3);
  });

  it('produces an empty path when every past hour is a gap', () => {
    const timeline = [gap(8), gap(9), gap(10)];
    const paths = buildTimelinePaths(timeline, computeScale(timeline, null, null));

    expect(paths.realVenta).toBe('');
    expect(paths.realRecompra).toBe('');
    expect(paths.lastRealIndex).toBe(-1);
  });

  it('handles a leading gap without emitting a stray segment', () => {
    const timeline = [gap(8), observed(9, 919, 922), observed(10, 920, 923)];
    const paths = buildTimelinePaths(timeline, computeScale(timeline, null, null));

    expect(countSubpaths(paths.realVenta)).toBe(1);
    expect(paths.realVenta.startsWith(`M ${getX(1, timeline.length)}`)).toBe(true);
  });

  it('handles a trailing gap without extending the line into it', () => {
    const timeline = [observed(8, 918, 921), observed(9, 919, 922), gap(10)];
    const paths = buildTimelinePaths(timeline, computeScale(timeline, null, null));

    expect(countSubpaths(paths.realVenta)).toBe(1);
    expect((paths.realVenta.match(/ L /g) || []).length).toBe(1); // 2 points, 1 segment
  });

  it('breaks the two series independently', () => {
    // A tick with a sell price but no buy price: only the buy line breaks.
    const halfGap: HourlyChartPoint = { ...observed(9, 0, 922), buyPrice: null };
    const timeline = [observed(8, 918, 921), halfGap, observed(10, 920, 923)];
    const paths = buildTimelinePaths(timeline, computeScale(timeline, null, null));

    expect(countSubpaths(paths.realVenta)).toBe(1); // sell side is continuous
    expect(countSubpaths(paths.realRecompra)).toBe(2); // buy side has the hole
  });
});

describe('buildTimelinePaths - projections', () => {
  it('anchors the projection to the last observed point', () => {
    const timeline = [observed(8, 918, 921), observed(9, 919, 922), projected(10, 925, 928)];
    const scale = computeScale(timeline, null, null);
    const paths = buildTimelinePaths(timeline, scale);

    expect(paths.lastRealIndex).toBe(1);
    const anchorX = getX(1, timeline.length);
    const anchorY = getY(922, scale)!;
    expect(paths.projVenta.startsWith(`M ${anchorX} ${anchorY}`)).toBe(true);
  });

  it('does not start a projection when no observed point exists to anchor it', () => {
    const timeline = [gap(8), gap(9), projected(10, 925, 928)];
    const paths = buildTimelinePaths(timeline, computeScale(timeline, null, null));

    expect(paths.projVenta).toBe('');
    expect(paths.projRecompra).toBe('');
  });

  it('anchors to the last hour that has data, skipping a trailing gap', () => {
    const timeline = [observed(8, 918, 921), gap(9), projected(10, 925, 928)];
    const paths = buildTimelinePaths(timeline, computeScale(timeline, null, null));
    expect(paths.lastRealIndex).toBe(0);
  });

  it('ignores projected points that carry no value', () => {
    const emptyProjection: HourlyChartPoint = { ...projected(10, 0, 0), projectedBuy: null, projectedSell: null };
    const timeline = [observed(8, 918, 921), emptyProjection, projected(11, 925, 928)];
    const paths = buildTimelinePaths(timeline, computeScale(timeline, null, null));

    // Anchor + the one projection that has a value: a single L segment.
    expect((paths.projVenta.match(/ L /g) || []).length).toBe(1);
  });

  it('never mixes observed and projected points in the same path', () => {
    const timeline = [observed(8, 918, 921), projected(9, 925, 928)];
    const scale = computeScale(timeline, null, null);
    const paths = buildTimelinePaths(timeline, scale);

    const projectedY = getY(928, scale)!;
    expect(paths.realVenta).not.toContain(String(projectedY));
    expect(countSubpaths(paths.realVenta)).toBe(1);
  });
});

describe('getX', () => {
  it('spreads the points across the drawing width', () => {
    expect(getX(0, 13)).toBe(CHART_GEOMETRY.paddingX);
    expect(getX(12, 13)).toBe(CHART_GEOMETRY.paddingX + CHART_GEOMETRY.chartW);
  });

  it('does not divide by zero for a single point', () => {
    expect(Number.isFinite(getX(0, 1))).toBe(true);
  });
});
