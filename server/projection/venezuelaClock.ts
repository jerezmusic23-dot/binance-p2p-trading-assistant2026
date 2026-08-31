/**
 * EL RELOJ DE VENEZUELA
 * =====================
 *
 * Hora local y día local del mercado, más la comprobación de que el instante
 * que llega es utilizable.
 *
 * Vive aparte porque no es estadística: es la conversión de un timestamp a la
 * jornada de un operador en Caracas, y la usa todo el motor. Tenerla dentro de
 * `dailyShape.ts` mezclaba dos responsabilidades y empujaba ese fichero por
 * encima del límite de tamaño del proyecto.
 */

/** Venezuela: UTC-4 fijo, sin horario de verano. Igual que `venezuelaHour`. */
export const VENEZUELA_OFFSET_MS = 4 * 3_600_000;

/**
 * Instante inutilizable: no es un momento del calendario.
 *
 * Existe para que el fallo se lea. `new Date(NaN).toISOString()` lanza un
 * `RangeError: Invalid time value` desde las tripas de la librería estándar,
 * sin decir qué valor ni de dónde venía. Con esto, el mensaje nombra el
 * parámetro y el módulo.
 */
export class InvalidInstantError extends Error {
  constructor(value: unknown, where: string) {
    super(
      `${where}: se recibió un instante inutilizable (${String(value)}). ` +
        `Se esperaba un timestamp finito en milisegundos.`
    );
    this.name = 'InvalidInstantError';
  }
}

/** Lanza si `t` no es un instante utilizable. Devuelve `t` si lo es. */
export function assertInstant(t: number, where: string): number {
  if (!Number.isFinite(t)) throw new InvalidInstantError(t, where);
  return t;
}

export function venezuelaHourOf(t: number): number {
  return new Date(assertInstant(t, 'venezuelaHourOf') - VENEZUELA_OFFSET_MS).getUTCHours();
}

export function venezuelaDayKey(t: number): string {
  return new Date(assertInstant(t, 'venezuelaDayKey') - VENEZUELA_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

/** 0 = domingo. Sólo se publica; no condiciona hasta que haya semanas de sobra. */
export function venezuelaWeekday(t: number): number {
  return new Date(assertInstant(t, 'venezuelaWeekday') - VENEZUELA_OFFSET_MS).getUTCDay();
}
