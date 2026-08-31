/**
 * MÉTRICAS DEL DÍA
 * ================
 *
 * Funciones puras que resumen la jornada: margen máximo, velocidad, giro actual
 * y cuánto del recorrido queda por delante. Viven aparte de `dailyProjection.ts`
 * porque ése ENSAMBLA el informe y éstas MIDEN; y porque cada una se prueba
 * sola, con entradas que caben en dos líneas.
 */

import {
  MIN_PROFILE_DAYS,
  groupByDay,
  type LegProjection,
  type MakerLeg,
} from './projection/dailyShape.js';
import type { SeriesPoint } from './projection/series.js';
import { percentileOf } from './projection/series.js';

export type DaySpeed = 'LENTO' | 'MODERADO' | 'RAPIDO' | 'INDETERMINADA';

export interface HourSpread {
  hour: number;
  /** ((venta − compra) / compra) × 100. Para un maker, positivo es su margen. */
  spreadPct: number;
  observed: boolean;
}

/** Trayectoria de una pierna: horas reales y después proyectadas. */
export interface PathPoint {
  hour: number;
  price: number;
  observed: boolean;
}

/** Trayectoria completa de una pierna: lo real primero, lo proyectado después. */
export function fullPath(p: LegProjection): PathPoint[] {
  return [
    ...p.real.map((r) => ({ hour: r.hour, price: r.price, observed: true })),
    ...p.projected.map((x) => ({ hour: x.hour, price: x.central, observed: false })),
  ];
}

/** Recorridos absolutos ancla→cierre observados en los días del histórico. */
export function historicalDayMoves(
  points: readonly SeriesPoint[],
  leg: MakerLeg,
  anchorHour: number,
  startHour: number,
  endHour: number
): number[] {
  const moves: number[] = [];
  for (const day of groupByDay(points, leg, startHour, endHour)) {
    const from = day.hours.get(anchorHour);
    const to = day.hours.get(endHour);
    if (from === undefined || to === undefined || from.best <= 0) continue;
    moves.push(Math.abs((to.best - from.best) / from.best) * 100);
  }
  return moves;
}

/**
 * Mayor margen del día, hora a hora.
 *
 * Sólo se compara una hora consigo misma: cruzar la venta de las 9 con la
 * compra de las 14 daría un margen que nunca estuvo disponible. El signo se
 * conserva — vender por debajo de donde se recompra es una pérdida y tiene que
 * seguir siendo distinguible de una ganancia.
 */
export function maxSpreadOf(venta: LegProjection, compra: LegProjection): HourSpread | null {
  const compraByHour = new Map(fullPath(compra).map((p) => [p.hour, p]));
  let best: HourSpread | null = null;

  for (const v of fullPath(venta)) {
    const c = compraByHour.get(v.hour);
    if (c === undefined || c.price <= 0) continue;
    const spreadPct = ((v.price - c.price) / c.price) * 100;
    if (best === null || Math.abs(spreadPct) > Math.abs(best.spreadPct)) {
      best = { hour: v.hour, spreadPct, observed: v.observed && c.observed };
    }
  }
  return best;
}
/**
 * Velocidad medida contra los propios días de la serie: los tercios de los
 * recorridos históricos ancla→cierre. Sin muestra, INDETERMINADA — nunca
 * "moderado" por defecto.
 */
export function speedFor(changePct: number | null, historicalMoves: readonly number[]): DaySpeed {
  if (changePct === null || historicalMoves.length < MIN_PROFILE_DAYS) return 'INDETERMINADA';
  const sorted = [...historicalMoves].sort((a, b) => a - b);
  const low = percentileOf(sorted, 1 / 3);
  const high = percentileOf(sorted, 2 / 3);
  if (low === null || high === null) return 'INDETERMINADA';
  const magnitude = Math.abs(changePct);
  if (magnitude <= low) return 'LENTO';
  if (magnitude <= high) return 'MODERADO';
  return 'RAPIDO';
}
/**
 * ¿Está girando ahora? Exige las dos cosas: que el último movimiento por hora
 * invierta el signo del anterior Y que supere el umbral medido. Un movimiento
 * grande que continúa la tendencia no es un giro; un cambio de signo minúsculo
 * es ruido.
 */
export function detectTurn(
  real: readonly { hour: number; price: number }[],
  thresholdPct: number | null
): boolean {
  if (thresholdPct === null || real.length < 3) return false;
  const [a, b, c] = real.slice(-3);
  if (a.price <= 0 || b.price <= 0) return false;
  const previous = (b.price - a.price) / a.price;
  const latest = (c.price - b.price) / b.price;
  if (previous === 0 || latest === 0) return false;
  if (Math.sign(previous) === Math.sign(latest)) return false;
  return Math.abs(latest) * 100 > thresholdPct;
}
/**
 * Cuánto del recorrido del día queda por delante.
 *
 * Recorrido = suma de movimientos absolutos hora a hora, no la diferencia entre
 * extremos: un día que sube 2 y baja 2 se movió, aunque acabe donde empezó.
 */
export function remainingShare(
  real: readonly { price: number }[],
  projected: readonly { movePct: number | null }[]
): number | null {
  let past = 0;
  for (let i = 1; i < real.length; i += 1) {
    const from = real[i - 1].price;
    if (from <= 0) continue;
    past += Math.abs((real[i].price - from) / from) * 100;
  }
  let ahead = 0;
  for (const p of projected) if (p.movePct !== null) ahead += Math.abs(p.movePct);

  const total = past + ahead;
  if (total <= 0) return null;
  return (ahead / total) * 100;
}