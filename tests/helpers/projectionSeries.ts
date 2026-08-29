/**
 * FORMAS SINTÉTICAS PARA LAS PRUEBAS DEL MOTOR DE PROYECCIÓN.
 *
 * Todo lo que hay aquí son FIXTURES DETERMINISTAS. Describen formas —rampa,
 * reversión, aceleración, onda, paseo aleatorio— y no dicen absolutamente nada
 * sobre el USDT/VES real. Ninguna se escribe en `data/`, y ningún resultado
 * obtenido con ellas puede presentarse como validación contra el mercado.
 *
 * El generador pseudoaleatorio lleva semilla explícita: la misma semilla da
 * siempre la misma serie, así que un test que falla se puede reproducir.
 */

import type { SeriesPoint } from '../../server/projection/index.js';
import type { HistoryRecord } from '../../server/types.js';

export const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);
export const MINUTE = 60_000;
export const H15 = 15 * MINUTE;
export const H30 = 30 * MINUTE;
export const H60 = 60 * MINUTE;

export function pointsFrom(prices: readonly number[], stepMs = MINUTE): SeriesPoint[] {
  return prices.map((price, i) => ({ t: T0 + i * stepMs, price }));
}

/** mulberry32: rápido, determinista y sin dependencias. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paseo aleatorio: por construcción no hay nada que predecir. */
export function randomWalk(base: number, tick: number, count: number, seed: number): number[] {
  const rnd = rng(seed);
  const out: number[] = [];
  let price = base;
  for (let i = 0; i < count; i += 1) {
    out.push(Number(price.toFixed(6)));
    price += (rnd() < 0.5 ? -1 : 1) * tick;
  }
  return out;
}

/** Rampa lineal: la deriva estructural en estado puro. */
export function ramp(from: number, increment: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => Number((from + i * increment).toFixed(6)));
}

/** Sube la primera mitad y baja la segunda, o al revés si `increment` es negativo. */
export function reversal(base: number, increment: number, count: number): number[] {
  const half = Math.floor(count / 2);
  const out: number[] = [];
  let price = base;
  for (let i = 0; i < count; i += 1) {
    out.push(Number(price.toFixed(6)));
    price += i < half ? increment : -increment;
  }
  return out;
}

/** Cada paso es mayor que el anterior: aceleración. */
export function accelerating(base: number, increment: number, count: number): number[] {
  const out: number[] = [];
  let price = base;
  for (let i = 0; i < count; i += 1) {
    out.push(Number(price.toFixed(6)));
    price += increment * (1 + i / count);
  }
  return out;
}

/** Cada paso es menor que el anterior: desaceleración. */
export function decelerating(base: number, increment: number, count: number): number[] {
  const out: number[] = [];
  let price = base;
  for (let i = 0; i < count; i += 1) {
    out.push(Number(price.toFixed(6)));
    price += increment * (1 - (i / count) * 0.9);
  }
  return out;
}

/** Onda determinista de periodo `period` observaciones. */
export function sine(base: number, amplitude: number, period: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) =>
    Number((base + amplitude * Math.sin((2 * Math.PI * i) / period)).toFixed(6))
  );
}

/** Diente de sierra: sube `half` pasos, baja `half` pasos. */
export function sawtooth(base: number, increment: number, half: number, count: number): number[] {
  const out: number[] = [];
  let price = base;
  let up = true;
  for (let i = 0; i < count; i += 1) {
    out.push(Number(price.toFixed(6)));
    price += up ? increment : -increment;
    if ((i + 1) % half === 0) up = !up;
  }
  return out;
}

/** Registro de histórico global sintético, en v2-strategic. */
export function historyRecord(i: number, overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  const buy = 940 + i * 0.01;
  const sell = 945 + i * 0.01;
  return {
    id: `r${i}`,
    timestamp: T0 + i * MINUTE,
    dateStr: '2026-08-01',
    hour: 0,
    // Extremos crudos del libro: deliberadamente distintos de los estratégicos,
    // para que un test note si el motor coge el campo equivocado.
    buyPrice: buy - 3,
    sellPrice: sell + 3,
    spreadPct: 0,
    bestBuyMerchant: 'A',
    bestSellMerchant: 'B',
    activeBuyAds: 20,
    activeSellAds: 20,
    source: 'fixture',
    calculationVersion: 'v2-strategic',
    strategicBuyPrice: Number(buy.toFixed(4)),
    strategicSellPrice: Number(sell.toFixed(4)),
    strategicSpreadPct: 0,
    ...overrides,
  };
}

/** Histórico global con los dos lados moviéndose de forma independiente. */
export function syntheticHistory(count: number, seed = 17): HistoryRecord[] {
  const rnd = rng(seed);
  let buy = 940;
  let sell = 945;
  return Array.from({ length: count }, (_, i) => {
    buy += (rnd() < 0.5 ? -1 : 1) * 0.01;
    sell += (rnd() < 0.5 ? -1 : 1) * 0.02;
    return historyRecord(i, {
      strategicBuyPrice: Number(buy.toFixed(4)),
      strategicSellPrice: Number(sell.toFixed(4)),
    });
  });
}

/** Recorre cualquier objeto y falla ante el primer número no finito. */
export function expectAllFinite(
  expect: (value: unknown, message?: string) => { toBe: (v: unknown) => void },
  value: unknown,
  path = 'root'
): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} = ${value}`).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => expectAllFinite(expect, entry, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      expectAllFinite(expect, entry, `${path}.${key}`);
    }
  }
}
