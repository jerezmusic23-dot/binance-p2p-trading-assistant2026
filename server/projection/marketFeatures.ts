/**
 * EL ESTADO DEL MERCADO EN UN INSTANTE, MEDIDO SÓLO HACIA ATRÁS
 * ==============================================================
 *
 * Nueve medidas, cada una con una pregunta concreta detrás. Ninguna es una
 * "fuerza" agregada: la fuerza como etiqueta única fue justamente lo que no
 * servía para decidir, porque mezclaba en un número magnitud, velocidad y
 * persistencia, que responden a preguntas distintas y a veces se contradicen.
 *
 * ═══ LA REGLA QUE NO SE PUEDE ROMPER ═══
 *
 * Todo se calcula con celdas de índice <= `i`. Ni una sola lectura futura.
 * `featuresAt` recibe el índice del "ahora" y jamás mira más allá; por eso el
 * backtest puede recorrer el histórico llamando a esta misma función y el
 * resultado es, por construcción, lo que el motor habría sabido entonces.
 *
 * ═══ POR QUÉ NO HAY PESOS ═══
 *
 * No se combinan en un score. Cada una viaja entera hasta la decisión, y es la
 * evidencia histórica —no un peso escrito a mano— la que dice cuánto importa
 * cada una. Un peso inventado decide en silencio.
 */

import { cellAt, pctChange, type GridCell, type HourlyGrid } from './hourlyGrid.js';

/**
 * Ventana de la velocidad y la aceleración, en horas.
 *
 * Cuatro horas es la ventana más corta que admite dos mitades de dos horas
 * (aceleración = velocidad de la segunda mitad menos la de la primera) sin
 * medir la aceleración sobre un solo paso, donde sería puro ruido.
 */
export const VELOCITY_WINDOW_HOURS = 4;

/**
 * Ventana de volatilidad y de posición en el rango, en horas.
 *
 * Un día. Menos deja la volatilidad dominada por la hora en curso; más mezcla
 * regímenes de días distintos dentro de una medida que quiere describir AHORA.
 */
export const CONTEXT_WINDOW_HOURS = 24;

/** Horas contiguas mínimas para que una medida sea publicable. */
export const MIN_CONTIGUOUS_HOURS = 3;

export interface MarketFeatures {
  /** Índice de la rejilla al que corresponde este estado. */
  index: number;
  /** Timestamp real del inicio de esa hora. */
  t: number;
  /** Nivel de referencia: el precio de la hora en curso. */
  level: number;
  hourOfDay: number;
  weekday: number;

  /** A. DIRECCIÓN — signo del recorrido de las últimas `VELOCITY_WINDOW_HOURS`. */
  direction: -1 | 0 | 1 | null;
  /** B. MAGNITUD — cuánto se ha movido en esa ventana, en % signado. */
  magnitudePct: number | null;
  /** C. VELOCIDAD — %/hora en la ventana. */
  velocityPctPerHour: number | null;
  /** D. ACELERACIÓN — %/hora² : velocidad reciente menos velocidad anterior. */
  accelerationPctPerHour2: number | null;
  /** G. VOLATILIDAD — mediana de |cambio| horario en la ventana de contexto, %. */
  volatilityPct: number | null;
  /** H. POSICIÓN EN EL RANGO — 0 = mínimo de 24h, 1 = máximo de 24h. */
  rangePosition: number | null;
  /** I. CONSISTENCIA — fracción de pasos de la ventana que van en la dirección dominante. */
  consistency: number | null;

  /** Horas contiguas realmente disponibles hacia atrás. Techo de todo lo anterior. */
  contiguousHours: number;
  /** Ninguna medida es publicable por debajo del mínimo de contigüidad. */
  usable: boolean;
}

/** Celdas contiguas (sin huecos) terminando en `i`, de más antigua a más nueva. */
export function contiguousWindow(grid: HourlyGrid, i: number, hours: number): GridCell[] {
  const out: GridCell[] = [];
  for (let k = 0; k < hours; k += 1) {
    const cell = cellAt(grid, i - k);
    if (cell === null) break;
    out.push(cell);
  }
  return out.reverse();
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Cambios porcentuales entre horas CONTIGUAS de una ventana. */
function stepChanges(window: readonly GridCell[]): number[] {
  const out: number[] = [];
  for (let k = 1; k < window.length; k += 1) {
    const change = pctChange(window[k - 1], window[k]);
    if (change !== null) out.push(change);
  }
  return out;
}

/**
 * El estado del mercado en el índice `i`.
 *
 * Devuelve siempre un objeto: las medidas que no se sostienen salen a `null`,
 * nunca a un valor por defecto. `usable` resume si hay contigüidad suficiente.
 */
export function featuresAt(grid: HourlyGrid, i: number): MarketFeatures | null {
  const here = cellAt(grid, i);
  if (here === null) return null;

  const velocityWindow = contiguousWindow(grid, i, VELOCITY_WINDOW_HOURS);
  const contextWindow = contiguousWindow(grid, i, CONTEXT_WINDOW_HOURS);
  const contiguousHours = contextWindow.length;

  const base: MarketFeatures = {
    index: i,
    t: here.t,
    level: here.level,
    hourOfDay: here.hourOfDay,
    weekday: here.weekday,
    direction: null,
    magnitudePct: null,
    velocityPctPerHour: null,
    accelerationPctPerHour2: null,
    volatilityPct: null,
    rangePosition: null,
    consistency: null,
    contiguousHours,
    usable: contiguousHours >= MIN_CONTIGUOUS_HOURS,
  };

  if (!base.usable) return base;

  // ── A/B/C: dirección, magnitud y velocidad sobre la ventana corta ──
  if (velocityWindow.length >= 2) {
    const spanHours = velocityWindow.length - 1;
    const magnitude = pctChange(velocityWindow[0], velocityWindow[velocityWindow.length - 1]);
    if (magnitude !== null) {
      base.magnitudePct = magnitude;
      base.velocityPctPerHour = magnitude / spanHours;
      base.direction = magnitude > 0 ? 1 : magnitude < 0 ? -1 : 0;
    }
  }

  // ── D: aceleración, dos mitades de la misma ventana ──
  if (velocityWindow.length >= 4) {
    const mid = Math.floor(velocityWindow.length / 2);
    const first = velocityWindow.slice(0, mid + 1);
    const second = velocityWindow.slice(mid);
    const firstMove = pctChange(first[0], first[first.length - 1]);
    const secondMove = pctChange(second[0], second[second.length - 1]);
    if (firstMove !== null && secondMove !== null) {
      const firstSpan = first.length - 1;
      const secondSpan = second.length - 1;
      if (firstSpan > 0 && secondSpan > 0) {
        base.accelerationPctPerHour2 = secondMove / secondSpan - firstMove / firstSpan;
      }
    }
  }

  // ── G: volatilidad realizada, mediana de |paso| ──
  const contextSteps = stepChanges(contextWindow);
  if (contextSteps.length >= 2) {
    base.volatilityPct = median(contextSteps.map((s) => Math.abs(s)));
  }

  // ── H: posición dentro del rango de la ventana de contexto ──
  if (contextWindow.length >= MIN_CONTIGUOUS_HOURS) {
    const levels = contextWindow.map((c) => c.level);
    const low = Math.min(...levels);
    const high = Math.max(...levels);
    base.rangePosition = high > low ? (here.level - low) / (high - low) : 0.5;
  }

  // ── I: consistencia del recorrido reciente ──
  const velocitySteps = stepChanges(velocityWindow);
  if (velocitySteps.length >= 2 && base.direction !== null && base.direction !== 0) {
    const aligned = velocitySteps.filter((s) => Math.sign(s) === base.direction).length;
    base.consistency = aligned / velocitySteps.length;
  }

  return base;
}

/**
 * Todos los estados de una rejilla, calculados UNA vez.
 *
 * `featuresAt` es puro y determinista, así que el resultado en el índice `i`
 * no depende de cuándo se pregunte: cachearlo no puede filtrar futuro. Las
 * analogías recorren el pasado entero en cada llamada; sin esta caché el
 * coste sería cúbico y el backtest dejaría de poder ejecutarse, que es la
 * forma más silenciosa de quedarse sin evidencia.
 */
export type FeatureSeries = (MarketFeatures | null)[];

export function computeFeatureSeries(grid: HourlyGrid): FeatureSeries {
  const out: FeatureSeries = new Array(grid.cells.length).fill(null);
  for (let i = 0; i < grid.cells.length; i += 1) out[i] = featuresAt(grid, i);
  return out;
}

/** Lee la caché si la hay; si no, calcula. Misma respuesta en ambos caminos. */
export function featuresFrom(
  grid: HourlyGrid,
  i: number,
  cache?: FeatureSeries
): MarketFeatures | null {
  if (cache !== undefined) return i >= 0 && i < cache.length ? cache[i] : null;
  return featuresAt(grid, i);
}

/**
 * I (segunda mitad): ¿VENTA y COMPRA se mueven en la misma dirección?
 *
 * Vive fuera de `featuresAt` porque necesita las DOS piernas, y las dos
 * rejillas comparten `startMs` sólo si se construyeron del mismo histórico.
 * Se comparan por timestamp, no por índice, para no depender de eso.
 */
export function legConsistency(venta: MarketFeatures | null, compra: MarketFeatures | null): number | null {
  if (venta === null || compra === null) return null;
  if (venta.t !== compra.t) return null;
  if (venta.direction === null || compra.direction === null) return null;
  if (venta.direction === 0 || compra.direction === 0) return 0.5;
  return venta.direction === compra.direction ? 1 : 0;
}
