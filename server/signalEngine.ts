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

/**
 * A TOP is not a prediction that the price will fall.
 *
 * It means: the series has turned around at this price before, and it is here
 * again showing the same loss of force. POSSIBLE while the trend is still
 * pushing into it; CONFIRMED once the push has actually reversed at the level.
 * Neither is an instruction, and CONFIRMED does not mean "it will now fall" -
 * it means the turn has already been observed.
 */
export type SignalKind =
  | 'TREND_CHANGE'
  | 'EXHAUSTION'
  | 'POSSIBLE_TOP'
  | 'CONFIRMED_TOP'
  | 'POSSIBLE_BOTTOM'
  | 'CONFIRMED_BOTTOM'
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

  /*
   * A borrowed reading is worth less, and says so.
   *
   * When a cell is too thin to be read on its own the general market supplies
   * the trend - which is better than silence, and worse than the cell's own
   * data. Every signal built from it is downgraded one level and carries the
   * fact in its evidence, so nobody reads a market-wide trend as this bank at
   * this amount.
   */
  const borrowed = sideProjection.borrowedFrom;
  const downgrade = (confidence: Confidence): Confidence => {
    if (borrowed === null) return confidence;
    if (confidence === 'HIGH') return 'MEDIUM';
    if (confidence === 'MEDIUM') return 'LOW';
    return confidence;
  };
  const borrowedNote = (lines: string[]): string[] =>
    borrowed === null
      ? lines
      : [
          ...lines,
          `Esta celda tiene poco histórico propio: lectura tomada del ${borrowed}. Confianza reducida.`,
        ];

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
      evidence: borrowedNote([
        `Tendencia anterior registrada: ${lastTrend}.`,
        ...trend.basis,
        `Confianza por tamaño de muestra: ${trend.trendConfidence} (${trend.sampleSize} obs.).`,
      ]),
      confidence: downgrade(trend.trendConfidence),
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
      evidence: borrowedNote(
        [sideProjection.exhaustion.reason ?? '', ...trend.basis].filter((line) => line !== '')
      ),
      confidence: downgrade(trend.trendConfidence),
      identity: identityOf(
        'EXHAUSTION',
        projection.bank,
        projection.amountKey,
        sideProjection.side,
        trend.trend
      ),
    });
  }

  /* ---- TOPS AND BOTTOMS ------------------------------------------------- */
  /*
   * Being at a level is not a top. A top is being at a level the series has
   * turned at before, WITH evidence that the push into it is failing. The
   * distinction between POSSIBLE and CONFIRMED is whether the turn has been
   * observed yet or is merely being anticipated.
   */
  // The zone the price is AT - `next` is the one still ahead, and a price
  // sitting on a ceiling has none ahead of it.
  /*
   * At the zone, OR having just been there. The second case is what a
   * confirmed top actually looks like: the price reached the level and turned
   * away from it, so by the time the turn is visible it has already left.
   */
  const ceiling = sideProjection.atCeiling ?? sideProjection.reachedCeiling;
  if (ceiling !== null) {
    /*
     * THE ZONE ITSELF IS THE EVIDENCE.
     *
     * An earlier version required the medium term to be climbing before a top
     * could be reported, and that made tops undetectable in exactly the
     * oscillating market where they are most reliable: a price sitting on a
     * level it has turned at three times reads SIDEWAYS, so the gate closed.
     * Repeated turns at a price ARE the structural signal; the trend only
     * decides whether the turn has already happened.
     */
    const pushingUp = trend.mediumDirection === 'BULLISH';
    // Confirmed against the BACKGROUND, which is the medium window before the
    // turn - the turn itself would otherwise cancel the very climb it reverses.
    const turned =
      trend.shortDirection === 'BEARISH' &&
      (trend.backgroundDirection === 'BULLISH' || pushingUp);
    const fading =
      sideProjection.exhaustion.exhausted && sideProjection.exhaustion.direction === 'BULLISH';

    {
      const confirmed = turned;
      signals.push({
        ...common,
        kind: confirmed ? 'CONFIRMED_TOP' : 'POSSIBLE_TOP',
        status: confirmed ? 'CONFIRMED' : 'EARLY_WARNING',
        headline: confirmed
          ? `${sideProjection.label}: techo confirmado en zona observada`
          : `${sideProjection.label}: posible techo`,
        evidence: borrowedNote([
          `Zona ${ceiling.low.toFixed(2)} – ${ceiling.high.toFixed(2)} VES.`,
          `La serie giró ahí ${ceiling.touches} vez(ces).`,
          confirmed
            ? 'El corto plazo ya giró a la baja dentro de la zona.'
            : fading
            ? 'La subida sigue, pero perdiendo fuerza al llegar.'
            : pushingUp
            ? 'El fondo sigue empujando hacia la zona.'
            : 'El precio está en la zona sin una tendencia de fondo definida.',
          'Un techo no significa que el precio vaya a bajar obligatoriamente.',
        ]),
        confidence: downgrade(ceiling.confidence),
        identity: identityOf(
          confirmed ? 'CONFIRMED_TOP' : 'POSSIBLE_TOP',
          projection.bank,
          projection.amountKey,
          sideProjection.side,
          ceiling.high.toFixed(2)
        ),
      });
    }
  }

  const floor = sideProjection.atFloor ?? sideProjection.reachedFloor;
  if (floor !== null) {
    const pushingDown = trend.mediumDirection === 'BEARISH';
    const turned =
      trend.shortDirection === 'BULLISH' &&
      (trend.backgroundDirection === 'BEARISH' || pushingDown);
    const fading =
      sideProjection.exhaustion.exhausted && sideProjection.exhaustion.direction === 'BEARISH';

    {
      const confirmed = turned;
      signals.push({
        ...common,
        kind: confirmed ? 'CONFIRMED_BOTTOM' : 'POSSIBLE_BOTTOM',
        status: confirmed ? 'CONFIRMED' : 'EARLY_WARNING',
        headline: confirmed
          ? `${sideProjection.label}: piso confirmado en zona observada`
          : `${sideProjection.label}: posible piso`,
        evidence: borrowedNote([
          `Zona ${floor.low.toFixed(2)} – ${floor.high.toFixed(2)} VES.`,
          `La serie giró ahí ${floor.touches} vez(ces).`,
          confirmed
            ? 'El corto plazo ya giró al alza dentro de la zona.'
            : fading
            ? 'La bajada sigue, pero perdiendo fuerza al llegar.'
            : pushingDown
            ? 'El fondo sigue empujando hacia la zona.'
            : 'El precio está en la zona sin una tendencia de fondo definida.',
          'Un piso no significa que el precio vaya a subir obligatoriamente.',
        ]),
        confidence: downgrade(floor.confidence),
        identity: identityOf(
          confirmed ? 'CONFIRMED_BOTTOM' : 'POSSIBLE_BOTTOM',
          projection.bank,
          projection.amountKey,
          sideProjection.side,
          floor.low.toFixed(2)
        ),
      });
    }
  }

  /* ---- BREAKOUT -------------------------------------------------------- */
  const breakout = sideProjection.breakout;
  if (breakout !== null) {
    signals.push({
      ...common,
      kind: breakout.direction === 'UP' ? 'BREAKOUT_UP' : 'BREAKOUT_DOWN',
      status: breakout.status,
      headline: `${sideProjection.label}: ruptura ${breakout.direction === 'UP' ? 'al alza' : 'a la baja'}`,
      evidence: borrowedNote([
        `Nivel roto: ${breakout.level.toFixed(2)} VES.`,
        `Actual: ${breakout.currentPrice.toFixed(2)} VES (${breakout.distanceVes >= 0 ? '+' : ''}${breakout.distanceVes.toFixed(2)}).`,
        breakout.distanceInSteps !== null
          ? `Distancia: ${breakout.distanceInSteps} pasos típicos de esta celda.`
          : '',
        `Fuerza: ${breakout.strength}.`,
      ].filter((line) => line !== '')),
      confidence: downgrade(trend.trendConfidence),
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
  /*
   * Accumulation and distribution are about a level the price is drifting
   * TOWARDS while going nowhere - distinct from standing on one, which is the
   * tops-and-bottoms case above. Using the same zone for both produced two
   * signals about the same fact.
   */
  const floorAhead = sideProjection.nextFloor;
  const ceilingAhead = sideProjection.nextCeiling;
  if (trend.trend === 'SIDEWAYS' && trend.reason === null) {
    if (floorAhead !== null && withinOneStep(sideProjection.currentPrice, floorAhead.low, floorAhead.high, step)) {
      signals.push({
        ...common,
        kind: 'ACCUMULATION',
        status: 'EARLY_WARNING',
        headline: `${sideProjection.label}: lateral sobre un piso observado`,
        evidence: borrowedNote([
          `Lateralización con ${trend.sampleSize} observaciones.`,
          `Piso ${floorAhead.low.toFixed(2)} – ${floorAhead.high.toFixed(2)} VES, ${floorAhead.touches} giro(s).`,
        ]),
        confidence: downgrade(floorAhead.confidence),
        identity: identityOf(
          'ACCUMULATION',
          projection.bank,
          projection.amountKey,
          sideProjection.side,
          floorAhead.low.toFixed(2)
        ),
      });
    }
    if (
      ceilingAhead !== null &&
      withinOneStep(sideProjection.currentPrice, ceilingAhead.low, ceilingAhead.high, step)
    ) {
      signals.push({
        ...common,
        kind: 'DISTRIBUTION',
        status: 'EARLY_WARNING',
        headline: `${sideProjection.label}: lateral bajo un techo observado`,
        evidence: borrowedNote([
          `Lateralización con ${trend.sampleSize} observaciones.`,
          `Techo ${ceilingAhead.low.toFixed(2)} – ${ceilingAhead.high.toFixed(2)} VES, ${ceilingAhead.touches} giro(s).`,
        ]),
        confidence: downgrade(ceilingAhead.confidence),
        identity: identityOf(
          'DISTRIBUTION',
          projection.bank,
          projection.amountKey,
          sideProjection.side,
          ceilingAhead.high.toFixed(2)
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
