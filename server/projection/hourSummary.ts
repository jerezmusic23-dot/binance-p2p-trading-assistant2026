/**
 * EL RESUMEN DE UNA HORA: DE UNA SERIE A DÍAS Y HORAS
 * ====================================================
 *
 * Una hora tiene muchas capturas y hay que representarla con UN número. Cuál
 * se elija no es un detalle: es la diferencia entre describir el mercado y
 * describir su anuncio más lejano.
 *
 *   EXTREME - máximo (VENTA) o mínimo (COMPRA). Comportamiento histórico, y
 *             sigue siendo el dato descriptivo correcto: con quién se habría
 *             podido operar en el mejor momento de la hora.
 *   MEDIAN  - la mediana, IDÉNTICA para ambas piernas. Es un NIVEL, y un nivel
 *             no depende de qué lado se mire.
 *
 * La ruta estratégica de la proyección (D5) usa MEDIAN, por coherencia con
 * `hourlyGrid.ts`, que ya resume así. El resto sigue en EXTREME por defecto.
 *
 * Módulo puro: sin reloj propio más allá del calendario de Venezuela, sin red,
 * sin estado global.
 */

import { venezuelaDayKey, venezuelaHourOf, venezuelaWeekday } from './venezuelaClock.js';
import type { SeriesPoint } from './series.js';

/** La operación del usuario. VENTA quiere el precio alto; COMPRA, el bajo. */
export type MakerLeg = 'VENTA' | 'COMPRA';

/**
 * ¿Mejora `candidate` a `incumbent` PARA ESTA PIERNA?
 *
 * VENTA quiere el más alto (vendo más caro). COMPRA quiere el más bajo
 * (recompro más barato). Es la regla de la que cuelga todo lo demás.
 *
 * ═══ POR QUÉ COMPRUEBA LA PIERNA EN VEZ DE USAR UN TERNARIO ═══
 *
 * Escrito como `leg === 'VENTA' ? mayor : menor`, cualquier valor que no fuera
 * exactamente 'VENTA' —undefined incluido— caía en la rama de COMPRA y el motor
 * devolvía mínimos donde debía devolver máximos, sin un solo error. Ocurrió: una
 * llamada a la que le faltaba el argumento produjo un backtest entero con la
 * pierna equivocada y resultados que parecían razonables. TypeScript lo impide
 * en compilación; esto lo impide también en ejecución, que es donde llegan los
 * datos de fuera.
 */
export function isBetterForLeg(leg: MakerLeg, candidate: number, incumbent: number): boolean {
  if (leg === 'VENTA') return candidate > incumbent;
  if (leg === 'COMPRA') return candidate < incumbent;
  throw new Error(`Pierna desconocida: ${String(leg)}. Debe ser VENTA o COMPRA.`);
}

/** El extremo de la pierna: máximo para VENTA, mínimo para COMPRA. */
export function extremeForLeg(leg: MakerLeg, values: readonly number[]): number | null {
  let best: number | null = null;
  for (const v of values) {
    if (!Number.isFinite(v) || v <= 0) continue;
    if (best === null || isBetterForLeg(leg, v, best)) best = v;
  }
  return best;
}
export interface HourCell {
  hour: number;
  /**
   * El extremo de la pierna dentro de esa hora: máximo para VENTA, mínimo para
   * COMPRA. SIEMPRE se calcula, sea cual sea el resumen elegido, porque sigue
   * siendo información descriptiva útil (con quién se habría podido operar en
   * el mejor momento de la hora).
   */
  best: number;
  /**
   * EL VALOR QUE REPRESENTA LA HORA en los cálculos de trayectoria.
   *
   * Con `summary: 'EXTREME'` es exactamente `best`, así que el comportamiento
   * anterior queda intacto. Con `'MEDIAN'` es la mediana de las observaciones.
   *
   * Existe porque `best` es un ESTADÍSTICO DE ORDEN: su valor esperado depende
   * del número de capturas. Medido sobre un mercado simulado sin movimiento
   * real (media 966.90, sd 0.05), el `best` de VENTA sube de 966.9628 con 6
   * capturas a 967.0163 con 60 y el de COMPRA baja de 966.8392 a 966.7842: la
   * distancia entre piernas casi se duplica sin que el mercado se mueva. Y una
   * sola captura atípica se lleva la hora entera. La referencia robusta que
   * D2/D4 introdujeron pierde su sentido si el resumen horario la vuelve a
   * convertir en un extremo.
   */
  reference: number;
  /** Las observaciones válidas de la hora, en el orden recibido. */
  values: number[];
  observations: number;
  lastT: number;
}

/**
 * Cómo se resume una hora con varias observaciones.
 *
 *   EXTREME - máximo (VENTA) o mínimo (COMPRA). Comportamiento histórico.
 *   MEDIAN  - la mediana, IDÉNTICA para ambas piernas: es un nivel, no un
 *             extremo, y un nivel no depende de qué lado se mire.
 */
export type HourSummary = 'EXTREME' | 'MEDIAN';

export interface DayShape {
  dayKey: string;
  weekday: number;
  /** Sólo horas realmente observadas. Las que faltan NO se rellenan. */
  hours: Map<number, HourCell>;
}

/**
 * Agrupa una serie en días y horas locales. Las 24 horas cuentan y una hora sin
 * observaciones NO se rellena.
 *
 * `summary` decide qué valor REPRESENTA cada hora (`reference`). Por defecto
 * `'EXTREME'`, de modo que quien no lo pida se comporta exactamente igual que
 * antes; la ruta estratégica pide `'MEDIAN'`. `best` se calcula en ambos modos.
 */
export function groupByDay(
  points: readonly SeriesPoint[],
  leg: MakerLeg,
  summary: HourSummary = 'EXTREME'
): DayShape[] {
  const days = new Map<string, DayShape>();

  for (const p of points) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.price) || p.price <= 0) continue;
    const hour = venezuelaHourOf(p.t);

    const key = venezuelaDayKey(p.t);
    let day = days.get(key);
    if (day === undefined) {
      day = { dayKey: key, weekday: venezuelaWeekday(p.t), hours: new Map() };
      days.set(key, day);
    }

    const cell = day.hours.get(hour);
    if (cell === undefined) {
      day.hours.set(hour, {
        hour,
        best: p.price,
        reference: p.price,
        values: [p.price],
        observations: 1,
        lastT: p.t,
      });
      continue;
    }
    cell.observations += 1;
    cell.values.push(p.price);
    if (p.t > cell.lastT) cell.lastT = p.t;
    if (isBetterForLeg(leg, p.price, cell.best)) cell.best = p.price;
  }

  /*
   * La referencia se fija al final, cuando la hora ya tiene todas sus
   * observaciones: una mediana no se acumula valor a valor.
   *
   * Se fija en LOS DOS modos, no sólo en MEDIAN. Fijarla sólo en MEDIAN dejaba
   * `reference` valiendo la PRIMERA observación de la hora en modo EXTREME -no
   * el extremo-, y la suite existente no lo detectaba porque casi ningún test
   * tiene horas con varias observaciones desiguales.
   */
  for (const day of days.values()) {
    for (const cell of day.hours.values()) {
      cell.reference = summary === 'MEDIAN' ? medianOf(cell.values) ?? cell.best : cell.best;
    }
  }

  return [...days.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}