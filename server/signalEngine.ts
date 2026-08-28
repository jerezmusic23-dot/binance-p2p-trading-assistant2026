/**
 * SIGNALS: what is worth telling the operator, and what it is based on.
 *
 * A signal is never an instruction. It says what the series shows, how sure
 * that is, and what evidence produced it - and then stops. The operator
 * decides. This module contains no "publish at", no "act now" and no advice.
 *
 * TWO GRADES, NEVER CONFLATED
 *
 *   EARLY_WARNING  the evidence has started to appear
 *   CONFIRMED      the evidence is complete on its own terms
 *
 * A trend that is decelerating is an EARLY_WARNING of exhaustion. It is not a
 * reversal, it does not become one by being repeated, and the two must never
 * be rendered with the same word.
 *
 * PURE, and therefore backtestable at any past timestamp.
 */

import type { CellProjection, SideProjection } from './makerProjectionEngine.js';
import type { Confidence, TrendDirection } from './trendEngine.js';

export type SignalKind =
  | 'TREND_CHANGE'
  | 'EXHAUSTION'
  | 'CEILING_APPROACH'
  | 'FLOOR_APPROACH'
  | 'BREAKOUT_UP'
  | 'BREAKOUT_DOWN'
  | 'ACCUMULATION'
  | 'DISTRIBUTION';

export type SignalStatus = 'EARLY_WARNING' | 'CONFIRMED';

export interface MarketSignal {
  kind: SignalKind;
  status: SignalStatus;
  bank: string;
  bankDisplayName: string;
  amountKey: string;
  amountVes: number;
  side: 'BUY' | 'SELL';
  sideLabel: string;

  /** One line a human reads first. */
  headline: string;
  /** Why this signal exists. Every entry is a measured fact. */
  evidence: string[];

  confidence: Confidence;
  /** Observations the signal was derived from. */
  sampleSize: number;

  /** ACTUAL, never a projection. */
  currentPrice: number | null;
  /** PROYECTADO, and named as such wherever it is rendered. */
  projectedLow: number | null;
  projectedHigh: number | null;

  /** Hours this cell historically moves in. Empty when unmeasured. */
  watchStartHour: number | null;
  watchEndHour: number | null;

  /** Stable across re-evaluations of the same situation, for dedup. */
  identity: string;
}

/**
 * The previous trend a cell was in, per side, so a CHANGE can be detected at
 * all. Held by the caller and passed back in - this module stays pure.
 */
export interface SignalMemory {
  /** `${bank}:${amountKey}:${side}` -> the last CONFIRMED direction seen. */
  lastTrend: Record<string, TrendDirection>;
}

export const EMPTY_SIGNAL_MEMORY: SignalMemory = { lastTrend: {} };

function memoryKey(bank: string, amountKey: string, side: string): string {
  return `${bank}:${amountKey}:${side}`;
}

/** Signals are identified by what they say, not when they were said. */
function identityOf(
  kind: SignalKind,
  bank: string,
  amountKey: string,
  side: string,
  discriminator: string
): string {
  return `${kind}:${bank}:${amountKey}:${side}:${discriminator}`;
}

function base(
  projection: CellProjection,
  sideProjection: SideProjection
): Omit<MarketSignal, 'kind' | 'status' | 'headline' | 'evidence' | 'confidence' | 'identity'> {
  return {
    bank: projection.bank,
    bankDisplayName: projection.bankDisplayName,
    amountKey: projection.amountKey,
    amountVes: projection.amountVes,
    side: sideProjection.side,
    sideLabel: sideProjection.label,
    sampleSize: sideProjection.trend.sampleSize,
    currentPrice: sideProjection.currentPrice,
    projectedLow: sideProjection.projectedRange.low,
    projectedHigh: sideProjection.projectedRange.high,
    watchStartHour: sideProjection.watchWindows[0]?.startHour ?? null,
    watchEndHour: sideProjection.watchWindows[0]?.endHour ?? null,
  };
}

/** How close to a zone counts as "approaching": one typical step. */
function withinOneStep(price: number | null, low: number, high: number, step: number | null): boolean {
  if (price === null || step === null || step === 0) return false;
  return price >= low - step && price <= high + step;
}

function evaluateSide(
  projection: CellProjection,
  sideProjection: SideProjection,
  memory: SignalMemory
): { signals: MarketSignal[]; memory: SignalMemory } {
  const signals: MarketSignal[] = [];
  const trend = sideProjection.trend;
  const key = memoryKey(projection.bank, projection.amountKey, sideProjection.side);
  const lastTrend = memory.lastTrend[key];
  const nextMemory: SignalMemory = { lastTrend: { ...memory.lastTrend } };

  // Nothing is claimed from a series that cannot support a direction.
  if (trend.reason !== null && trend.trend === 'UNKNOWN') {
    return { signals, memory: nextMemory };
  }

  const common = base(projection, sideProjection);
  const step = trend.typicalStepVes;

  /* ---- TREND CHANGE ---------------------------------------------------- */
  if (
    (trend.trend === 'BULLISH' || trend.trend === 'BEARISH') &&
    lastTrend !== undefined &&
    lastTrend !== trend.trend &&
    (lastTrend === 'BULLISH' || lastTrend === 'BEARISH')
  ) {
    signals.push({
      ...common,
      kind: 'TREND_CHANGE',
      status: trend.trendConfidence === 'HIGH' ? 'CONFIRMED' : 'EARLY_WARNING',
      headline: `${sideProjection.label}: ${lastTrend} → ${trend.trend}`,
      evidence: [
        `Tendencia anterior registrada: ${lastTrend}.`,
        ...trend.basis,
        `Confianza por tamaño de muestra: ${trend.trendConfidence} (${trend.sampleSize} obs.).`,
      ],
      confidence: trend.trendConfidence,
      identity: identityOf(
        'TREND_CHANGE',
        projection.bank,
        projection.amountKey,
        sideProjection.side,
        `${lastTrend}->${trend.trend}`
      ),
    });
  }

  /*
   * The remembered trend only advances on a directional reading. A TRANSITION
   * must not overwrite it, or the next real change would compare against
   * "TRANSITION" and never fire.
   */
  if (trend.trend === 'BULLISH' || trend.trend === 'BEARISH') {
    nextMemory.lastTrend[key] = trend.trend;
  }

  /* ---- EXHAUSTION ------------------------------------------------------ */
  if (sideProjection.exhaustion.exhausted) {
    signals.push({
      ...common,
      kind: 'EXHAUSTION',
      // Always early: a slowing trend has not turned, and saying so would lie.
      status: 'EARLY_WARNING',
      headline: `${sideProjection.label}: posible agotamiento ${trend.trend === 'BULLISH' ? 'alcista' : 'bajista'}`,
      evidence: [
        sideProjection.exhaustion.reason ?? '',
        ...trend.basis,
      ].filter((line) => line !== ''),
      confidence: trend.trendConfidence,
      identity: identityOf(
        'EXHAUSTION',
        projection.bank,
        projection.amountKey,
        sideProjection.side,
        trend.trend
      ),
    });
  }

  /* ---- APPROACHING A ZONE ---------------------------------------------- */
  const ceiling = sideProjection.nextCeiling;
  if (ceiling !== null && withinOneStep(sideProjection.currentPrice, ceiling.low, ceiling.high, step)) {
    signals.push({
      ...common,
      kind: 'CEILING_APPROACH',
      status: ceiling.confidence === 'HIGH' ? 'CONFIRMED' : 'EARLY_WARNING',
      headline: `${sideProjection.label}: cerca de un techo observado`,
      evidence: [
        `Zona ${ceiling.low.toFixed(2)} – ${ceiling.high.toFixed(2)} VES.`,
        `La serie giró ahí ${ceiling.touches} vez(ces).`,
      ],
      confidence: ceiling.confidence,
      identity: identityOf(
        'CEILING_APPROACH',
        projection.bank,
        projection.amountKey,
        sideProjection.side,
        ceiling.high.toFixed(2)
      ),
    });
  }

  const floor = sideProjection.nextFloor;
  if (floor !== null && withinOneStep(sideProjection.currentPrice, floor.low, floor.high, step)) {
    signals.push({
      ...common,
      kind: 'FLOOR_APPROACH',
      status: floor.confidence === 'HIGH' ? 'CONFIRMED' : 'EARLY_WARNING',
      headline: `${sideProjection.label}: cerca de un piso observado`,
      evidence: [
        `Zona ${floor.low.toFixed(2)} – ${floor.high.toFixed(2)} VES.`,
        `La serie giró ahí ${floor.touches} vez(ces).`,
      ],
      confidence: floor.confidence,
      identity: identityOf(
        'FLOOR_APPROACH',
        projection.bank,
        projection.amountKey,
        sideProjection.side,
        floor.low.toFixed(2)
      ),
    });
  }

  /* ---- BREAKOUT -------------------------------------------------------- */
  const breakout = sideProjection.breakout;
  if (breakout !== null) {
    signals.push({
      ...common,
      kind: breakout.direction === 'UP' ? 'BREAKOUT_UP' : 'BREAKOUT_DOWN',
      status: breakout.status,
      headline: `${sideProjection.label}: ruptura ${breakout.direction === 'UP' ? 'al alza' : 'a la baja'}`,
      evidence: [
        `Nivel roto: ${breakout.level.toFixed(2)} VES.`,
        `Actual: ${breakout.currentPrice.toFixed(2)} VES (${breakout.distanceVes >= 0 ? '+' : ''}${breakout.distanceVes.toFixed(2)}).`,
        breakout.distanceInSteps !== null
          ? `Distancia: ${breakout.distanceInSteps} pasos típicos de esta celda.`
          : '',
        `Fuerza: ${breakout.strength}.`,
      ].filter((line) => line !== ''),
      confidence: trend.trendConfidence,
      identity: identityOf(
        breakout.direction === 'UP' ? 'BREAKOUT_UP' : 'BREAKOUT_DOWN',
        projection.bank,
        projection.amountKey,
        sideProjection.side,
        breakout.level.toFixed(2)
      ),
    });
  }

  /* ---- ACCUMULATION / DISTRIBUTION ------------------------------------- */
  /*
   * A sideways stretch sitting on a floor is accumulation; sitting under a
   * ceiling is distribution. Both require the zone to exist in the data - a
   * flat series with no observed turning points is just flat, and is reported
   * as SIDEWAYS by the trend and as nothing at all here.
   */
  if (trend.trend === 'SIDEWAYS' && trend.reason === null) {
    if (floor !== null && withinOneStep(sideProjection.currentPrice, floor.low, floor.high, step)) {
      signals.push({
        ...common,
        kind: 'ACCUMULATION',
        status: 'EARLY_WARNING',
        headline: `${sideProjection.label}: lateral sobre un piso observado`,
        evidence: [
          `Lateralización con ${trend.sampleSize} observaciones.`,
          `Piso ${floor.low.toFixed(2)} – ${floor.high.toFixed(2)} VES, ${floor.touches} giro(s).`,
        ],
        confidence: floor.confidence,
        identity: identityOf(
          'ACCUMULATION',
          projection.bank,
          projection.amountKey,
          sideProjection.side,
          floor.low.toFixed(2)
        ),
      });
    }
    if (ceiling !== null && withinOneStep(sideProjection.currentPrice, ceiling.low, ceiling.high, step)) {
      signals.push({
        ...common,
        kind: 'DISTRIBUTION',
        status: 'EARLY_WARNING',
        headline: `${sideProjection.label}: lateral bajo un techo observado`,
        evidence: [
          `Lateralización con ${trend.sampleSize} observaciones.`,
          `Techo ${ceiling.low.toFixed(2)} – ${ceiling.high.toFixed(2)} VES, ${ceiling.touches} giro(s).`,
        ],
        confidence: ceiling.confidence,
        identity: identityOf(
          'DISTRIBUTION',
          projection.bank,
          projection.amountKey,
          sideProjection.side,
          ceiling.high.toFixed(2)
        ),
      });
    }
  }

  return { signals, memory: nextMemory };
}

export function evaluateSignals(params: {
  projections: readonly CellProjection[];
  memory: SignalMemory;
}): { signals: MarketSignal[]; memory: SignalMemory } {
  let memory = params.memory;
  const signals: MarketSignal[] = [];

  for (const projection of params.projections) {
    for (const side of [projection.buy, projection.sell]) {
      const result = evaluateSide(projection, side, memory);
      signals.push(...result.signals);
      memory = result.memory;
    }
  }

  /* Confirmed before early, then by sample size: the best-evidenced first. */
  const rank = (signal: MarketSignal) => (signal.status === 'CONFIRMED' ? 0 : 1);
  signals.sort((a, b) => rank(a) - rank(b) || b.sampleSize - a.sampleSize);

  return { signals, memory };
}
