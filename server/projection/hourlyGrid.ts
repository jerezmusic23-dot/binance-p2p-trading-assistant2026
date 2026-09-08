/**
 * LA REJILLA HORARIA: UN NIVEL POR HORA, NO UN EXTREMO DE N MUESTRAS
 * ===================================================================
 *
 * ═══ EL DEFECTO QUE ESTE MÓDULO EXISTE PARA CORREGIR ═══
 *
 * `dailyShape.groupByDay` resume cada hora con el EXTREMO de todas las
 * capturas de esa hora (máximo en VENTA, mínimo en COMPRA). Suena natural y es
 * incorrecto como NIVEL, por dos razones medidas, no supuestas:
 *
 *   1. El máximo de N muestras crece con N. Una hora con 60 capturas y otra
 *      con 12 no son comparables aunque el mercado no se haya movido: el
 *      cociente entre ellas lleva dentro un término que sólo depende de
 *      cuántas veces miramos. Medido sobre ruido puro (σ=1.5 VES, sin deriva):
 *        60 vs 12 capturas -> −0.109% de movimiento fantasma
 *        60 vs  2 capturas -> −0.280% de movimiento fantasma
 *      Un movimiento que al operador le importa ronda el 0.30%. El sesgo por
 *      conteo de muestras es del mismo orden que la señal que se busca.
 *
 *   2. Aun con captura pareja (60 vs 60), el extremo mete 3.3x el ruido de la
 *      mediana en el cociente hora-a-hora. Ese ruido va directo al
 *      denominador de la relación señal/ruido y es la razón principal de que
 *      la proyección anterior no alcanzara el umbral para decidir.
 *
 * ═══ LO QUE NO CAMBIA: LA SEMÁNTICA ═══
 *
 * `record.buyPrice` ya es el MÍNIMO del lado Binance BUY y `record.sellPrice`
 * el MÁXIMO del lado Binance SELL, calculados por captura en
 * `binanceP2PService`. Eso es correcto y NO se toca: es el mejor precio
 * disponible en ese instante.
 *
 *   COMPRA = mínimo BUY  (Binance BUY  = el anunciante vende USDT = mi compra)
 *   VENTA  = máximo SELL (Binance SELL = el anunciante compra USDT = mi venta)
 *
 * Lo que cambia es cómo se resumen MUCHAS capturas dentro de una hora: la
 * mediana de esos extremos instantáneos, que es un nivel, en vez del extremo
 * de los extremos, que es un estadístico de orden.
 *
 * ═══ HUECOS ═══
 *
 * Una hora sin capturas NO se rellena. La rejilla lleva el hueco explícito
 * (`cell === null`) y cada consumidor decide si puede trabajar con él. Nunca
 * se interpola: un precio que nadie observó no existe.
 */

import type { HistoryRecord } from '../types.js';
import { venezuelaDayKey, venezuelaHourOf } from './venezuelaClock.js';

/** Milisegundos de una hora. La rejilla es horaria por construcción. */
export const HOUR_MS = 3_600_000;

/**
 * Capturas mínimas para considerar la hora bien observada.
 *
 * No descarta la celda: la marca. Con la cadencia de producción (persistencia
 * cada minuto) una hora completa trae ~60; por debajo de 3 la mediana es una o
 * dos observaciones y el consumidor debe poder saberlo.
 */
export const WELL_OBSERVED_MIN = 3;

export type GridLeg = 'VENTA' | 'COMPRA';

/** De qué campo del histórico general sale cada pierna. Única definición. */
export const GRID_FIELD: Record<GridLeg, 'buyPrice' | 'sellPrice'> = {
  VENTA: 'sellPrice',
  COMPRA: 'buyPrice',
};

export interface GridCell {
  /** Inicio de la hora, en ms UTC. La rejilla trabaja con timestamps reales. */
  t: number;
  /** Nivel de la hora: mediana de las capturas. Nunca un extremo de extremos. */
  level: number;
  /** Cuántas capturas sostienen ese nivel. */
  observations: number;
  /** Hora de reloj de Venezuela, sólo para mostrar y para analogías. */
  hourOfDay: number;
  /** Día calendario de Venezuela. */
  dayKey: string;
  /** Día de la semana (0-6), para analogías. */
  weekday: number;
  /** `observations >= WELL_OBSERVED_MIN`. */
  wellObserved: boolean;
}

/** Rejilla horaria continua: una entrada por hora, `null` donde no se observó. */
export interface HourlyGrid {
  leg: GridLeg;
  /** Inicio de la primera hora con datos. */
  startMs: number;
  /** Celdas consecutivas separadas exactamente una hora. `null` = hueco real. */
  cells: (GridCell | null)[];
  /** Horas con observación. */
  observedHours: number;
  /** Horas sin ninguna captura dentro del tramo cubierto. */
  missingHours: number;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Inicio de la hora que contiene `t`, en ms. */
export function hourFloor(t: number): number {
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

/**
 * Construye la rejilla de una pierna a partir del histórico general.
 *
 * Sólo lee `timestamp` y el campo de su pierna. No conoce banco, monto,
 * payType ni precio estratégico: la proyección general no puede depender de
 * ninguno de ellos.
 */
export function buildHourlyGrid(records: readonly HistoryRecord[], leg: GridLeg): HourlyGrid {
  const field = GRID_FIELD[leg];
  const buckets = new Map<number, number[]>();

  for (const record of records) {
    if (!record || typeof record.timestamp !== 'number' || !Number.isFinite(record.timestamp)) continue;
    const price = record[field];
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;

    const key = hourFloor(record.timestamp);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [price]);
    else bucket.push(price);
  }

  if (buckets.size === 0) {
    return { leg, startMs: 0, cells: [], observedHours: 0, missingHours: 0 };
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const startMs = keys[0];
  const endMs = keys[keys.length - 1];
  const length = Math.round((endMs - startMs) / HOUR_MS) + 1;

  const cells: (GridCell | null)[] = new Array(length).fill(null);
  let observedHours = 0;

  for (const key of keys) {
    const level = median(buckets.get(key)!);
    if (level === null || !Number.isFinite(level) || level <= 0) continue;
    const observations = buckets.get(key)!.length;
    const idx = Math.round((key - startMs) / HOUR_MS);
    cells[idx] = {
      t: key,
      level,
      observations,
      hourOfDay: venezuelaHourOf(key),
      dayKey: venezuelaDayKey(key),
      weekday: new Date(key - 4 * HOUR_MS).getUTCDay(),
      wellObserved: observations >= WELL_OBSERVED_MIN,
    };
    observedHours += 1;
  }

  return { leg, startMs, cells, observedHours, missingHours: length - observedHours };
}

/** La celda del índice, o `null` si es hueco o cae fuera. */
export function cellAt(grid: HourlyGrid, index: number): GridCell | null {
  if (index < 0 || index >= grid.cells.length) return null;
  return grid.cells[index];
}

/**
 * Cambio porcentual entre dos índices de la rejilla, o `null`.
 *
 * SIGNADO siempre. Nunca `Math.abs`: una bajada tiene que seguir siendo
 * distinguible de una subida en cualquier punto del motor.
 */
export function pctChange(from: GridCell | null, to: GridCell | null): number | null {
  if (from === null || to === null || from.level <= 0) return null;
  return ((to.level - from.level) / from.level) * 100;
}

/** Índices con celda observada, en orden. Base de todo recorrido temporal. */
export function observedIndices(grid: HourlyGrid): number[] {
  const out: number[] = [];
  for (let i = 0; i < grid.cells.length; i += 1) if (grid.cells[i] !== null) out.push(i);
  return out;
}
