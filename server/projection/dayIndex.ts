/**
 * ÍNDICE DE DÍAS Y RESOLUCIÓN DE HORAS A TRAVÉS DE MEDIANOCHE
 * =============================================================
 *
 * Responsabilidad separada de `dailyShape.ts`: allí se agrupa la serie en
 * días y horas locales; aquí se resuelve "¿qué celda hay N horas después de
 * ésta, aunque cruce medianoche, fin de mes o fin de año?". Es aritmética de
 * timestamps, no de calendario — mezclarla con la lógica de piernas
 * (VENTA/COMPRA) juntaría dos responsabilidades que cambian por razones
 * distintas.
 */

import { extremeForLeg, type DayShape, type HourCell, type MakerLeg } from './dailyShape.js';
import { VENEZUELA_OFFSET_MS, venezuelaDayKey, venezuelaHourOf } from './venezuelaClock.js';

/**
 * Cociente de precio entre el ancla y `hoursAhead` horas después.
 *
 * Cocientes y no diferencias porque el VES tiene deriva: 3 bolívares sobre 900
 * y 3 sobre 300 no son el mismo movimiento y promediarlos deformaría el perfil.
 */
export interface RatioSample {
  dayKey: string;
  ratio: number;
}

/**
 * Índice por clave de día, para resolver "la hora siguiente" cuando cruza
 * medianoche. Se construye UNA VEZ por informe y se reutiliza.
 */
export function buildDayIndex(days: readonly DayShape[]): Map<string, DayShape> {
  const index = new Map<string, DayShape>();
  for (const day of days) index.set(day.dayKey, day);
  return index;
}

/**
 * Timestamp UTC del INICIO de `hour` (hora local de Venezuela) del día
 * `dayKey`. Es la inversa exacta de `venezuelaDayKey` + `venezuelaHourOf`.
 */
export function hourStartMs(dayKey: string, hour: number): number {
  return Date.parse(`${dayKey}T00:00:00.000Z`) + hour * 3_600_000 + VENEZUELA_OFFSET_MS;
}

export interface ResolvedHour {
  dayKey: string;
  hour: number;
  cell: HourCell;
}

/**
 * La celda que está `hoursAhead` horas después de (dayKey, hour).
 *
 * ═══ CÓMO CRUZA MEDIANOCHE SIN UN SOLO `if` DE CALENDARIO ═══
 *
 * En vez de sumar horas y comprobar si el resultado se sale de 0–23 —la
 * aritmética que se equivoca en el cambio de día, de mes y de año—, esto suma
 * MILISEGUNDOS a un timestamp real y vuelve a preguntarle a `venezuelaDayKey` /
 * `venezuelaHourOf` qué día y qué hora son. Un 23:00 + 3 horas cae solo en el
 * día siguiente a la 02:00, con la misma función que ya se usa en todo el
 * motor y que ya está probada contra ese cruce.
 *
 * `undefined` cuando ese día no está en el índice —no hay historia esa lejos,
 * o (en el backtest) esa hora todavía no había ocurrido— y eso es exactamente
 * lo correcto: ninguna muestra en vez de una inventada.
 */
export function hourCellAhead(
  index: ReadonlyMap<string, DayShape>,
  dayKey: string,
  hour: number,
  hoursAhead: number
): ResolvedHour | undefined {
  const targetMs = hourStartMs(dayKey, hour) + hoursAhead * 3_600_000;
  const targetDayKey = venezuelaDayKey(targetMs);
  const targetHour = venezuelaHourOf(targetMs);
  const cell = index.get(targetDayKey)?.hours.get(targetHour);
  return cell === undefined ? undefined : { dayKey: targetDayKey, hour: targetHour, cell };
}

export function ratiosAhead(
  days: readonly DayShape[],
  index: ReadonlyMap<string, DayShape>,
  anchorHour: number,
  hoursAhead: number
): RatioSample[] {
  const out: RatioSample[] = [];
  for (const day of days) {
    const a = day.hours.get(anchorHour);
    if (a === undefined || a.best <= 0) continue;
    const target = hourCellAhead(index, day.dayKey, anchorHour, hoursAhead);
    if (target === undefined || target.cell.best <= 0) continue;
    out.push({ dayKey: day.dayKey, ratio: target.cell.best / a.best });
  }
  return out;
}

/**
 * Cociente entre el EXTREMO del tramo que queda y el ancla, por día.
 *
 * Es lo que responde "¿hasta dónde llegó a subir mi venta después de esta
 * hora?". Se calcula por día y LUEGO se toman percentiles, que no es lo mismo
 * que tomar el máximo de los percentiles hora a hora: eso último sería el
 * máximo de ocho p90 distintos y exageraría el techo sistemáticamente.
 *
 * `horizonHours` reemplaza al viejo `endHour`: ya no hay un cierre de jornada
 * que marque el final, así que el tramo que queda se mide en horas hacia
 * adelante y puede cruzar medianoche, vía `hourCellAhead`.
 */
export function remainingExtremeRatios(
  days: readonly DayShape[],
  index: ReadonlyMap<string, DayShape>,
  leg: MakerLeg,
  anchorHour: number,
  horizonHours: number
): RatioSample[] {
  const out: RatioSample[] = [];
  for (const day of days) {
    const anchor = day.hours.get(anchorHour);
    if (anchor === undefined || anchor.best <= 0) continue;

    const future: number[] = [];
    for (let k = 1; k <= horizonHours; k += 1) {
      const target = hourCellAhead(index, day.dayKey, anchorHour, k);
      if (target !== undefined) future.push(target.cell.best);
    }
    const extreme = extremeForLeg(leg, future);
    if (extreme === null) continue;
    out.push({ dayKey: day.dayKey, ratio: extreme / anchor.best });
  }
  return out;
}
