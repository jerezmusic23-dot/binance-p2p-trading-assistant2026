/**
 * SIETE MODELOS CANDIDATOS, NINGUNO PRIVILEGIADO
 * ================================================
 *
 * Ninguno se elige por elegante. Todos compiten en `walkForward.ts` sobre
 * datos que no participaron en su elección, y gana el que decide mejor. Si
 * gana el ingenuo, se usa el ingenuo: es el resultado, no un fracaso.
 *
 * ═══ REGLAS COMUNES ═══
 *
 * · Sólo pueden leer celdas de índice <= `i`. La firma no recibe nada más.
 * · Devuelven un PRECIO para el índice `i + horizon`, o `null` si no pueden.
 * · Ninguno lleva una constante de amortiguación, un peso ni un coeficiente
 *   estacional escrito a mano. Donde hacía falta un parámetro (la ventana de
 *   una media móvil) se declara como parámetro del modelo y se elige en la
 *   partición de VALIDACIÓN, nunca sobre el test.
 */

import { cellAt, type HourlyGrid } from './hourlyGrid.js';
import { contiguousWindow, featuresFrom, type FeatureSeries } from './marketFeatures.js';

export type ModelId =
  | 'NAIVE'
  | 'MOMENTUM'
  | 'MOMENTUM_ACCEL'
  | 'TREND_MA'
  | 'ANALOGY'
  | 'MEDIAN_MOVE'
  | 'HYBRID';

export const MODEL_LABEL: Record<ModelId, string> = {
  NAIVE: 'A · Ingenuo (el precio se queda igual)',
  MOMENTUM: 'B · Momento (extrapola la velocidad reciente)',
  MOMENTUM_ACCEL: 'C · Momento + aceleración (Taylor de 2.º orden)',
  TREND_MA: 'D · Tendencia por regresión sobre la ventana',
  ANALOGY: 'E · Analogías históricas (misma hora del día)',
  MEDIAN_MOVE: 'F · Mediana de movimientos históricos a ese horizonte',
  HYBRID: 'G · Híbrido (mediana de los anteriores)',
};

export interface ForecastContext {
  grid: HourlyGrid;
  /** Índice del "ahora". Nada por encima de este índice es legible. */
  i: number;
  /** Horizonte en horas. */
  horizon: number;
  /**
   * Estados precalculados de la rejilla. Opcional: sin ella cada modelo los
   * recalcula y el resultado es idéntico, sólo más lento.
   */
  features?: FeatureSeries;
}

export type ForecastFn = (ctx: ForecastContext) => number | null;

/* ════════════════════════════════════════════════════════════════════════
 * A · INGENUO
 * El baseline honesto. Cualquier modelo que no lo bata sobra.
 * ════════════════════════════════════════════════════════════════════════ */
export const naive: ForecastFn = ({ grid, i }) => cellAt(grid, i)?.level ?? null;

/* ════════════════════════════════════════════════════════════════════════
 * B · MOMENTO
 * Extrapola la velocidad medida hacia adelante, sin amortiguar. Amortiguar
 * exigiría una constante que nadie ha medido; si el mercado amortigua de
 * verdad, el backtest lo dirá castigando a este modelo frente a los demás.
 * ════════════════════════════════════════════════════════════════════════ */
export const momentum: ForecastFn = ({ grid, i, horizon, features }) => {
  const f = featuresFrom(grid, i, features);
  if (f === null || !f.usable || f.velocityPctPerHour === null) return null;
  return f.level * (1 + (f.velocityPctPerHour * horizon) / 100);
};

/* ════════════════════════════════════════════════════════════════════════
 * C · MOMENTO + ACELERACIÓN
 * Segundo orden: x(t+h) = x + v·h + ½·a·h². El ½ no es un peso inventado, es
 * el término del desarrollo de Taylor.
 * ════════════════════════════════════════════════════════════════════════ */
export const momentumAccel: ForecastFn = ({ grid, i, horizon, features }) => {
  const f = featuresFrom(grid, i, features);
  if (f === null || !f.usable) return null;
  if (f.velocityPctPerHour === null || f.accelerationPctPerHour2 === null) return null;
  const movePct = f.velocityPctPerHour * horizon + 0.5 * f.accelerationPctPerHour2 * horizon * horizon;
  return f.level * (1 + movePct / 100);
};

/* ════════════════════════════════════════════════════════════════════════
 * D · TENDENCIA POR REGRESIÓN
 * Mínimos cuadrados sobre la ventana contigua, extrapolada. Menos sensible
 * que el momento a los dos puntos extremos de la ventana.
 * ════════════════════════════════════════════════════════════════════════ */
export function trendMA(windowHours: number): ForecastFn {
  return ({ grid, i, horizon }) => {
    const window = contiguousWindow(grid, i, windowHours);
    if (window.length < 3) return null;
    const n = window.length;
    // x = 0..n-1 (horas), y = nivel. Pendiente por mínimos cuadrados.
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let k = 0; k < n; k += 1) {
      sx += k;
      sy += window[k].level;
      sxy += k * window[k].level;
      sxx += k * k;
    }
    const denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    const slope = (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    const predicted = intercept + slope * (n - 1 + horizon);
    return Number.isFinite(predicted) && predicted > 0 ? predicted : null;
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * E · ANALOGÍAS HISTÓRICAS
 * "Cuando el mercado se parecía a ahora, ¿qué pasó después?"
 *
 * Similitud sobre el estado medido (velocidad, volatilidad, posición en el
 * rango, hora del día), no sobre el precio: dos días a 900 y a 1400 pueden
 * estar en el mismo estado. Distancias adimensionales y del mismo orden, así
 * que se suman sin pesos.
 * ════════════════════════════════════════════════════════════════════════ */
export const MIN_ANALOGS = 8;

export function analogy(neighbours: number): ForecastFn {
  return ({ grid, i, horizon, features }) => {
    const now = featuresFrom(grid, i, features);
    if (now === null || !now.usable || now.velocityPctPerHour === null) return null;

    const scored: { distance: number; ratio: number }[] = [];
    // Sólo el pasado: j + horizon debe seguir siendo <= i para que el
    // desenlace del análogo también sea pasado.
    for (let j = 0; j + horizon <= i; j += 1) {
      const past = featuresFrom(grid, j, features);
      if (past === null || !past.usable || past.velocityPctPerHour === null) continue;
      const future = cellAt(grid, j + horizon);
      if (future === null || past.level <= 0) continue;

      let distance = Math.abs(past.velocityPctPerHour - now.velocityPctPerHour);
      if (past.volatilityPct !== null && now.volatilityPct !== null) {
        distance += Math.abs(past.volatilityPct - now.volatilityPct);
      }
      if (past.rangePosition !== null && now.rangePosition !== null) {
        // Reescalado al orden de las otras dos (fracciones de precio en %).
        distance += Math.abs(past.rangePosition - now.rangePosition);
      }
      scored.push({ distance, ratio: future.level / past.level });
    }

    if (scored.length < MIN_ANALOGS) return null;
    scored.sort((a, b) => a.distance - b.distance);
    const keep = scored.slice(0, Math.max(MIN_ANALOGS, Math.min(neighbours, scored.length)));
    const ratios = keep.map((s) => s.ratio).sort((a, b) => a - b);
    const mid = Math.floor(ratios.length / 2);
    const ratio = ratios.length % 2 === 1 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
    return now.level * ratio;
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * F · MEDIANA DE MOVIMIENTOS HISTÓRICOS
 * Sin condicionar por nada: cuánto se mueve este mercado en `horizon` horas,
 * y ya. Captura la deriva estructural (un bolívar que se deprecia) sin
 * pretender leer el estado actual. Baseline del "régimen".
 * ════════════════════════════════════════════════════════════════════════ */
export const medianMove: ForecastFn = ({ grid, i, horizon }) => {
  const here = cellAt(grid, i);
  if (here === null) return null;
  const ratios: number[] = [];
  for (let j = 0; j + horizon <= i; j += 1) {
    const from = cellAt(grid, j);
    const to = cellAt(grid, j + horizon);
    if (from === null || to === null || from.level <= 0) continue;
    ratios.push(to.level / from.level);
  }
  if (ratios.length < MIN_ANALOGS) return null;
  ratios.sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  const ratio = ratios.length % 2 === 1 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  return here.level * ratio;
};

/* ════════════════════════════════════════════════════════════════════════
 * G · HÍBRIDO
 * Mediana de lo que dicen los demás. Combinación sin pesos: la mediana no
 * necesita decidir cuánto vale cada uno, y un modelo que se dispara no puede
 * arrastrar al conjunto.
 * ════════════════════════════════════════════════════════════════════════ */
export function hybrid(parts: readonly ForecastFn[]): ForecastFn {
  return (ctx) => {
    const values = parts.map((f) => f(ctx)).filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
    if (values.length < 2) return null;
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  };
}

/** Ventana por defecto de la regresión, en horas. Se valida como parámetro. */
export const DEFAULT_TREND_WINDOW = 6;
/** Vecinos por defecto de la analogía. Se valida como parámetro. */
export const DEFAULT_NEIGHBOURS = 20;

/** El catálogo completo, listo para competir. */
export function buildModels(
  trendWindow = DEFAULT_TREND_WINDOW,
  neighbours = DEFAULT_NEIGHBOURS
): Record<ModelId, ForecastFn> {
  const trend = trendMA(trendWindow);
  const analog = analogy(neighbours);
  return {
    NAIVE: naive,
    MOMENTUM: momentum,
    MOMENTUM_ACCEL: momentumAccel,
    TREND_MA: trend,
    ANALOGY: analog,
    MEDIAN_MOVE: medianMove,
    HYBRID: hybrid([naive, momentum, trend, analog, medianMove]),
  };
}

export const MODEL_IDS: ModelId[] = [
  'NAIVE',
  'MOMENTUM',
  'MOMENTUM_ACCEL',
  'TREND_MA',
  'ANALOGY',
  'MEDIAN_MOVE',
  'HYBRID',
];
