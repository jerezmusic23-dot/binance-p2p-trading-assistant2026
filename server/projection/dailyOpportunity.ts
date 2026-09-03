/**
 * DÓNDE Y CUÁNDO CONVIENE PUBLICAR
 * ================================
 *
 * Lo que convierte una proyección en una decisión: la mejor ocasión que queda
 * por delante para cada pierna, las horas que históricamente le han sido
 * favorables, y el giro que la trayectoria proyectada anticipa.
 *
 * Vive aparte de `dailyShape.ts` porque aquello responde "¿qué precio?" y esto
 * responde "¿cuándo y me conviene?". Son preguntas distintas y se prueban por
 * separado.
 */

import {
  MIN_PROFILE_DAYS,
  isBetterForLeg,
  medianOf,
  type BandKind,
  type DayShape,
  type HourProjection,
  type MakerLeg,
} from './dailyShape.js';

/* ════════════════════════════════════════════════════════════════════════
 * HORARIOS FAVORABLES POR PIERNA
 * ════════════════════════════════════════════════════════════════════════
 *
 * "¿A qué horas he podido vender más caro?" no es lo mismo que "¿a qué horas
 * se mueve más el precio?". Una hora puede moverse mucho y ser mala para
 * vender. Por eso esto NO mide movimiento: mide POSICIÓN dentro del día.
 *
 * Para cada día se ordenan sus horas y se le da a cada una su rango relativo:
 * 1 = la mejor del día para esa pierna, 0 = la peor. En VENTA la mejor es la
 * más cara; en COMPRA, la más barata. Después se promedia ese rango por hora
 * a lo largo de los días.
 *
 * El rango se calcula DENTRO de cada día a propósito. El VES se deprecia, así
 * que comparar el precio absoluto de las 9 de un día con el de las 9 de otro
 * mediría la deriva, no la hora. Normalizando dentro del día, la deriva se
 * cancela y queda la pregunta que importa.
 */

export interface HourFavourability {
  hour: number;
  /** Rango medio dentro del día, 0–1. 1 = fue la mejor hora de la jornada. */
  score: number;
  /** Días que aportaron esta hora. Sin él, un 1.0 de un día engañaría. */
  daysUsed: number;
}

export function favourableHours(days: readonly DayShape[], leg: MakerLeg): HourFavourability[] {
  const totals = new Map<number, { sum: number; days: number }>();

  for (const day of days) {
    const cells = [...day.hours.values()];
    // Con una sola hora no hay "posición dentro del día" que medir.
    if (cells.length < 2) continue;

    // Mejor primero, según la pierna.
    const ordered = [...cells].sort((a, b) =>
      leg === 'VENTA' ? b.best - a.best : a.best - b.best
    );

    ordered.forEach((cell, index) => {
      const rank = 1 - index / (ordered.length - 1); // 1 = mejor, 0 = peor
      const acc = totals.get(cell.hour) ?? { sum: 0, days: 0 };
      acc.sum += rank;
      acc.days += 1;
      totals.set(cell.hour, acc);
    });
  }

  const out: HourFavourability[] = [];
  for (const [hour, acc] of totals) {
    // Una hora vista en menos días que el mínimo del perfil no se publica.
    if (acc.days < MIN_PROFILE_DAYS) continue;
    out.push({ hour, score: acc.sum / acc.days, daysUsed: acc.days });
  }
  return out.sort((a, b) => b.score - a.score || a.hour - b.hour);
}

/* ════════════════════════════════════════════════════════════════════════
 * LA MEJOR OCASIÓN QUE QUEDA POR DELANTE
 * ════════════════════════════════════════════════════════════════════════ */

export interface LegOpportunity {
  /** Horas desde el ancla. Siempre positivo, nunca envuelve. */
  hoursAhead: number;
  /** Hora de reloj (0–23), sólo para mostrarla. */
  hourOfDay: number;
  /** Día calendario (Venezuela) de ese momento. */
  dayKey: string;
  price: number;
  low: number;
  high: number;
  bandKind: BandKind;
  daysUsed: number;
  /** ¿Mejora el precio de ahora PARA ESTA PIERNA? */
  improvesOnNow: boolean;
  /** Mejora en %, con signo según la pierna. null si no hay ancla. */
  improvementPct: number | null;
}

/**
 * La hora proyectada con el mejor precio para la pierna.
 *
 * Mejor significa lo que significa en cada pierna: el máximo vendiendo y el
 * mínimo recomprando. `improvesOnNow` responde a la única pregunta operativa
 * —¿me conviene esperar?— y es false cuando el mejor momento proyectado no
 * mejora lo que ya tengo delante.
 */
export function bestOpportunity(
  projected: readonly HourProjection[],
  leg: MakerLeg,
  anchorPrice: number | null
): LegOpportunity | null {
  let best: HourProjection | null = null;
  for (const p of projected) {
    if (best === null || isBetterForLeg(leg, p.central, best.central)) best = p;
  }
  if (best === null) return null;

  const improvementPct =
    anchorPrice !== null && anchorPrice > 0
      ? ((best.central - anchorPrice) / anchorPrice) * 100 * (leg === 'VENTA' ? 1 : -1)
      : null;

  return {
    hoursAhead: best.hoursAhead,
    hourOfDay: best.hourOfDay,
    dayKey: best.dayKey,
    price: best.central,
    low: best.low,
    high: best.high,
    bandKind: best.bandKind,
    daysUsed: best.daysUsed,
    improvesOnNow: anchorPrice !== null && isBetterForLeg(leg, best.central, anchorPrice),
    improvementPct,
  };
}

/* ════════════════════════════════════════════════════════════════════════
 * GIRO PROYECTADO
 * ════════════════════════════════════════════════════════════════════════ */

export interface ProjectedTurn {
  /** Horas desde el ancla hasta el giro. Siempre positivo, nunca envuelve. */
  hoursAhead: number;
  /** Hora de reloj (0–23) del giro, sólo para mostrarla. */
  hourOfDay: number;
  /** Día calendario (Venezuela) del giro. */
  dayKey: string;
  from: 'SUBIENDO' | 'BAJANDO';
  to: 'SUBIENDO' | 'BAJANDO';
  /** Movimiento de la hora del giro, en %. */
  movePct: number;
}

/**
 * Primer cambio de sentido en la trayectoria proyectada que además supera el
 * umbral MEDIDO de giro.
 *
 * Las dos condiciones, igual que en el giro actual: un cambio de signo
 * minúsculo es ruido, y un movimiento grande que continúa la tendencia no es
 * un giro. Sin umbral medido no se declara ninguno — antes que inventar un
 * listón, se calla.
 */
export function projectedTurn(
  projected: readonly HourProjection[],
  thresholdPct: number | null
): ProjectedTurn | null {
  if (thresholdPct === null) return null;

  for (let i = 1; i < projected.length; i += 1) {
    const previous = projected[i - 1].movePct;
    const current = projected[i].movePct;
    if (previous === null || current === null) continue;
    if (previous === 0 || current === 0) continue;
    if (Math.sign(previous) === Math.sign(current)) continue;
    if (Math.abs(current) <= thresholdPct) continue;

    return {
      hoursAhead: projected[i].hoursAhead,
      hourOfDay: projected[i].hourOfDay,
      dayKey: projected[i].dayKey,
      from: previous > 0 ? 'SUBIENDO' : 'BAJANDO',
      to: current > 0 ? 'SUBIENDO' : 'BAJANDO',
      movePct: current,
    };
  }
  return null;
}

/**
 * Umbral de giro, MEDIDO en vez de elegido.
 *
 * Un giro es un cambio de hora a hora mayor que el de una hora corriente, y qué
 * es "corriente" lo dice la serie: la mediana de los cambios absolutos entre
 * horas contiguas. Un 0.3 % fijo decidiría qué se le anuncia al propietario sin
 * que nadie lo hubiera medido.
 */
export interface TurnThreshold {
  pct: number | null;
  sampleSize: number;
}

export function turnThreshold(days: readonly DayShape[]): TurnThreshold {
  const moves: number[] = [];
  for (const day of days) {
    const hours = [...day.hours.values()].sort((a, b) => a.hour - b.hour);
    for (let i = 1; i < hours.length; i += 1) {
      if (hours[i].hour !== hours[i - 1].hour + 1) continue; // el hueco se respeta
      const from = hours[i - 1].best;
      if (from <= 0) continue;
      moves.push(Math.abs((hours[i].best - from) / from) * 100);
    }
  }
  return { pct: medianOf(moves), sampleSize: moves.length };
}
