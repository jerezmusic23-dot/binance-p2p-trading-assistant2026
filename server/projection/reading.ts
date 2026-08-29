/**
 * LECTURA DEL MERCADO: LA CAPA QUE COMPONE, NO LA QUE CALCULA
 * ==========================================================
 *
 * Junta lo que las otras piezas ya miden y lo convierte en algo que una
 * persona pueda leer de un vistazo: estado actual, tendencia por horizontes,
 * fuerza del movimiento y su derivada, nivel de evidencia y una explicación en
 * castellano de por qué se concluye lo que se concluye.
 *
 * Aquí NO se inventa ninguna métrica nueva. Cada número viene de `momentum`,
 * `series` o del histórico persistido, y esta capa sólo los ordena.
 *
 * DOS "DIRECCIONES" QUE NO SON LA MISMA, Y POR ESO SE LLAMAN DISTINTO
 *
 *   MOVIMIENTO (aquí)  — hacia dónde y con cuánta fuerza se está moviendo el
 *                        precio AHORA, comparado con lo que este mercado suele
 *                        moverse. Es descripción del presente.
 *
 *   PROYECCIÓN (engine) — hacia dónde apuntan las situaciones históricas
 *                        parecidas, medido CONTRA LA DERIVA ESTRUCTURAL del
 *                        bolívar. Es una afirmación sobre el futuro.
 *
 * Un mercado puede estar subiendo (movimiento ALCISTA) y a la vez proyectarse
 * LATERAL, porque sube justo lo que suele subir. Mezclarlos en una sola
 * etiqueta borraría precisamente esa distinción, que es la útil.
 */

import { median } from '../marketStatistics.js';
import {
  finiteOrNull,
  medianIntervalMs,
  typicalStep,
  sanitiseSeries,
  type SeriesPoint,
} from './series.js';
import { describeMomentum, readMomentum, type MomentumReading } from './momentum.js';

export type MovementDirection = 'ALCISTA' | 'BAJISTA' | 'LATERAL' | 'INDETERMINADA';

/**
 * Cuánto histórico hay, dicho sin adornos.
 *
 * Los cortes NO son gustos: cada uno marca el punto donde una técnica concreta
 * empieza a poder aplicarse.
 *
 *   SIN_DATOS                  no hay ni una observación.
 *   DATOS_INSUFICIENTES        no llegan a MIN_MOMENTUM_SAMPLES movimientos:
 *                              no se puede situar un movimiento en ninguna
 *                              distribución, así que no hay ni momentum.
 *   HISTORICO_LIMITADO         hay momentum, pero ningún horizonte reúne los
 *                              análogos independientes que exige la proyección.
 *   HISTORICO_SUFICIENTE       al menos un horizonte tiene análogos de sobra.
 *   ALTA_CONFIANZA_ESTADISTICA además, el backtest respalda algún horizonte.
 */
export type EvidenceTier =
  | 'SIN_DATOS'
  | 'DATOS_INSUFICIENTES'
  | 'HISTORICO_LIMITADO'
  | 'HISTORICO_SUFICIENTE'
  | 'ALTA_CONFIANZA_ESTADISTICA';

export const EVIDENCE_TEXT: Record<EvidenceTier, string> = {
  SIN_DATOS: 'Sin datos: no hay ninguna observación del mercado todavía.',
  DATOS_INSUFICIENTES:
    'Datos insuficientes para proyección estadística: no hay movimientos suficientes para situar el actual.',
  HISTORICO_LIMITADO:
    'Histórico limitado: se puede describir el movimiento actual, pero ningún horizonte reúne situaciones comparables suficientes.',
  HISTORICO_SUFICIENTE:
    'Histórico suficiente: hay situaciones comparables para al menos un horizonte.',
  ALTA_CONFIANZA_ESTADISTICA:
    'Alta confianza estadística: además de haber situaciones comparables, el backtest respalda al menos un horizonte.',
};

/** Ventanas que se leen, nombradas por su duración real. */
export const READING_WINDOWS_MS: readonly { label: string; ms: number }[] = [
  { label: '15m', ms: 15 * 60 * 1000 },
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '4h', ms: 4 * 60 * 60 * 1000 },
  { label: '12h', ms: 12 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
];

export interface HorizonMovement {
  label: string;
  requestedMs: number;
  /** Ventana en observaciones, medida sobre la cadencia real. */
  windowSteps: number;
  measuredMs: number | null;
  available: boolean;
  direction: MovementDirection;
  momentum: MomentumReading;
}

export interface LiquiditySnapshot {
  buyUsdt: number | null;
  sellUsdt: number | null;
  buyAds: number | null;
  sellAds: number | null;
  /** Cambio de liquidez frente a la mediana reciente, en tanto por uno. */
  buyChange: number | null;
  sellChange: number | null;
}

export interface MarketReadingResult {
  observations: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  spanMs: number | null;
  medianIntervalMs: number | null;
  currentPrice: number | null;
  typicalStep: number | null;

  /** Movimiento de referencia: la ventana publicable más corta. */
  movement: MomentumReading;
  movementText: string | null;
  horizons: HorizonMovement[];
  /** Síntesis multi-horizonte: no se reduce todo a una sola señal. */
  predominant: { direction: MovementDirection; note: string };

  liquidity: LiquiditySnapshot | null;
  evidence: EvidenceTier;
  evidenceText: string;
  /** Por qué se concluye lo que se concluye, en frases cortas. */
  narrative: string[];
}

/** Dirección a partir de la etiqueta de momentum: una sola definición. */
export function directionOfMomentum(reading: MomentumReading): MovementDirection {
  if (reading.label === null) return 'INDETERMINADA';
  if (reading.label === 'NEUTRAL') return 'LATERAL';
  return reading.label.includes('ALCISTA') ? 'ALCISTA' : 'BAJISTA';
}

/**
 * Síntesis de los horizontes disponibles.
 *
 * NO se promedia. Si todos coinciden, se dice. Si discrepan, se dice CUÁLES
 * discrepan, porque la discrepancia entre corto y medio plazo es información
 * —consolidación, agotamiento, giro— y promediarla la borra.
 */
export function summarisePredominant(
  horizons: readonly HorizonMovement[]
): { direction: MovementDirection; note: string } {
  const usable = horizons.filter((h) => h.available && h.direction !== 'INDETERMINADA');
  if (usable.length === 0) {
    return { direction: 'INDETERMINADA', note: 'Ningún horizonte tiene lectura todavía.' };
  }

  const counts: Record<MovementDirection, number> = {
    ALCISTA: 0,
    BAJISTA: 0,
    LATERAL: 0,
    INDETERMINADA: 0,
  };
  for (const h of usable) counts[h.direction] += 1;

  const ranked = (['ALCISTA', 'BAJISTA', 'LATERAL'] as MovementDirection[]).sort(
    (a, b) => counts[b] - counts[a]
  );
  const top = ranked[0];

  // Empate real entre dos direcciones: no hay predominante que declarar.
  if (counts[ranked[0]] === counts[ranked[1]] && counts[ranked[0]] > 0) {
    const names = usable.map((h) => `${h.label} ${h.direction.toLowerCase()}`).join(', ');
    return {
      direction: 'INDETERMINADA',
      note: `Horizontes divididos sin predominio (${names}).`,
    };
  }

  const dissenting = usable.filter((h) => h.direction !== top);
  if (dissenting.length === 0) {
    return {
      direction: top,
      note: `Todos los horizontes disponibles coinciden (${usable.map((h) => h.label).join(', ')}).`,
    };
  }

  const detail = dissenting.map((h) => `${h.label} ${h.direction.toLowerCase()}`).join(', ');
  return {
    direction: top,
    note: `Predominante ${top.toLowerCase()}, con ${detail}.`,
  };
}

/**
 * Liquidez actual y su cambio frente a lo reciente.
 *
 * El cambio se mide contra la MEDIANA de la propia ventana, no contra la
 * observación anterior: comparar con un único punto convierte cualquier
 * hipo en un "derrumbe de liquidez".
 */
export function readLiquidity(
  current: { buyUsdt: number | null; sellUsdt: number | null; buyAds: number | null; sellAds: number | null },
  recentBuy: readonly number[],
  recentSell: readonly number[]
): LiquiditySnapshot {
  const change = (value: number | null, sample: readonly number[]): number | null => {
    if (value === null || !Number.isFinite(value)) return null;
    const base = median(sample.filter((v) => Number.isFinite(v)));
    if (base === null || base <= 0) return null;
    return finiteOrNull((value - base) / base);
  };

  return {
    buyUsdt: finiteOrNull(current.buyUsdt),
    sellUsdt: finiteOrNull(current.sellUsdt),
    buyAds: current.buyAds ?? null,
    sellAds: current.sellAds ?? null,
    buyChange: change(current.buyUsdt, recentBuy),
    sellChange: change(current.sellUsdt, recentSell),
  };
}

/* ------------------------------------------------------------------------ *
 * NARRATIVA
 * ------------------------------------------------------------------------ */

const DIRECTION_WORD: Record<MovementDirection, string> = {
  ALCISTA: 'alcista',
  BAJISTA: 'bajista',
  LATERAL: 'lateral',
  INDETERMINADA: 'indeterminada',
};

/**
 * Explica la conclusión citando SÓLO hechos medidos.
 *
 * Cada frase nombra el dato que la sostiene. Sin esto la pantalla entrega un
 * número y el lector tiene que creérselo; con esto puede discutirlo, que es
 * mucho más útil.
 *
 * Se devuelven frases sueltas y no un párrafo montado para que la interfaz
 * decida cómo mostrarlas y para que cada afirmación se pueda probar por
 * separado.
 */
export function buildNarrative(reading: {
  movement: MomentumReading;
  horizons: readonly HorizonMovement[];
  predominant: { direction: MovementDirection; note: string };
  liquidity: LiquiditySnapshot | null;
  evidence: EvidenceTier;
}): string[] {
  const lines: string[] = [];
  const { movement, predominant, liquidity, evidence } = reading;

  if (evidence === 'SIN_DATOS' || evidence === 'DATOS_INSUFICIENTES') {
    lines.push(EVIDENCE_TEXT[evidence]);
    return lines;
  }

  if (movement.score !== null && movement.label !== null) {
    const strength = Math.round(movement.score);
    const factors = movement.factors;
    const persistence =
      factors.persistence === null
        ? null
        : `${Math.round(factors.persistence * 100)}% de los saltos fueron en la misma dirección`;
    const consecutive =
      factors.consecutiveMoves && factors.consecutiveMoves > 1
        ? `${factors.consecutiveMoves} movimientos seguidos sin cambiar de sentido`
        : null;

    const support = [persistence, consecutive].filter(Boolean).join(' y ');
    lines.push(
      `Movimiento ${describeMomentum(movement)} (${strength}/100)` +
        (support ? `: ${support}.` : '.')
    );
  }

  switch (movement.trend) {
    case 'AUMENTANDO':
      lines.push(
        `La fuerza va en aumento: las últimas lecturas pasaron de ${movement.history
          .map((h) => Math.round(h))
          .join(' a ')}.`
      );
      break;
    case 'DISMINUYENDO':
      lines.push(
        `La fuerza está cediendo: las últimas lecturas pasaron de ${movement.history
          .map((h) => Math.round(h))
          .join(' a ')}, así que el movimiento continúa pero con menos empuje.`
      );
      break;
    case 'ESTABLE':
      lines.push('La fuerza se mantiene estable entre lecturas consecutivas.');
      break;
    default:
      break;
  }

  lines.push(`Tendencia ${DIRECTION_WORD[predominant.direction]}. ${predominant.note}`);

  if (movement.factors.volatility !== null) {
    const v = movement.factors.volatility;
    lines.push(
      v === 0
        ? 'Los saltos son todos del mismo tamaño: sin dispersión que reseñar.'
        : `Dispersión de los saltos: ${v.toFixed(2)} veces el movimiento típico.`
    );
  }

  if (liquidity) {
    const describe = (label: string, usdt: number | null, change: number | null): string | null => {
      if (usdt === null) return null;
      if (change === null) return `${label}: ${Math.round(usdt)} USDT publicados.`;
      const pctChange = Math.round(change * 100);
      const word = pctChange > 0 ? 'por encima' : pctChange < 0 ? 'por debajo' : 'en línea con';
      return `${label}: ${Math.round(usdt)} USDT publicados, ${Math.abs(pctChange)}% ${word} de lo habitual reciente.`;
    };
    const buy = describe('Liquidez del lado de compra', liquidity.buyUsdt, liquidity.buyChange);
    const sell = describe('Liquidez del lado de venta', liquidity.sellUsdt, liquidity.sellChange);
    if (buy) lines.push(buy);
    if (sell) lines.push(sell);
  }

  lines.push(EVIDENCE_TEXT[evidence]);
  return lines;
}

/* ------------------------------------------------------------------------ *
 * ENTRADA PÚBLICA
 * ------------------------------------------------------------------------ */

export interface MarketReadingOptions {
  /** Liquidez del último registro, cuando el histórico la trae. */
  liquidity?: {
    current: { buyUsdt: number | null; sellUsdt: number | null; buyAds: number | null; sellAds: number | null };
    recentBuy: readonly number[];
    recentSell: readonly number[];
  };
  /** true cuando el backtest respalda al menos un horizonte de la proyección. */
  backtestValidated?: boolean;
  /** true cuando algún horizonte reunió los análogos que exige la proyección. */
  hasSufficientAnalogues?: boolean;
  windows?: readonly { label: string; ms: number }[];
}

export function readMarket(
  rawPoints: readonly SeriesPoint[],
  options: MarketReadingOptions = {}
): MarketReadingResult {
  const points = sanitiseSeries(rawPoints);
  const cadence = medianIntervalMs(points);
  const step = typicalStep(points);
  const windows = options.windows ?? READING_WINDOWS_MS;

  const horizons: HorizonMovement[] = windows.map(({ label, ms }) => {
    // La ventana se mide en observaciones sobre la cadencia REAL, no sobre la
    // nominal: con huecos de captura, "15 minutos" y "15 observaciones" dejan
    // de ser lo mismo.
    const windowSteps = cadence === null ? 0 : Math.max(1, Math.round(ms / cadence));
    const momentum = cadence === null ? readMomentum([], 1) : readMomentum(points, windowSteps);
    return {
      label,
      requestedMs: ms,
      windowSteps,
      measuredMs: cadence === null ? null : windowSteps * cadence,
      available: momentum.score !== null,
      direction: directionOfMomentum(momentum),
      momentum,
    };
  });

  const headline = horizons.find((h) => h.available)?.momentum ?? readMomentum([], 1);
  const predominant = summarisePredominant(horizons);

  const liquidity = options.liquidity
    ? readLiquidity(options.liquidity.current, options.liquidity.recentBuy, options.liquidity.recentSell)
    : null;

  let evidence: EvidenceTier;
  if (points.length === 0) evidence = 'SIN_DATOS';
  else if (headline.score === null) evidence = 'DATOS_INSUFICIENTES';
  else if (options.backtestValidated) evidence = 'ALTA_CONFIANZA_ESTADISTICA';
  else if (options.hasSufficientAnalogues) evidence = 'HISTORICO_SUFICIENTE';
  else evidence = 'HISTORICO_LIMITADO';

  return {
    observations: points.length,
    firstTimestamp: points.length > 0 ? points[0].t : null,
    lastTimestamp: points.length > 0 ? points[points.length - 1].t : null,
    spanMs: points.length > 1 ? points[points.length - 1].t - points[0].t : null,
    medianIntervalMs: cadence,
    currentPrice: points.length > 0 ? finiteOrNull(points[points.length - 1].price) : null,
    typicalStep: step,
    movement: headline,
    movementText: describeMomentum(headline),
    horizons,
    predominant,
    liquidity,
    evidence,
    evidenceText: EVIDENCE_TEXT[evidence],
    narrative: buildNarrative({ movement: headline, horizons, predominant, liquidity, evidence }),
  };
}
