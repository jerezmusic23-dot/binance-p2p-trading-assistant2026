/**
 * FILAS DE LA GRÁFICA DEL DÍA
 * ===========================
 *
 * Convierte el informe del servidor en una fila por hora. Vive fuera del
 * componente porque es justo la parte que puede mentir sin que se note: basta
 * con colocar un precio proyectado en el campo de lo real para que la pantalla
 * afirme que algo ocurrió. Aquí se puede probar; dentro de un componente de
 * recharts, no.
 *
 * No inventa horas. Una hora que nadie observó y que no se ha proyectado sale
 * con los campos ausentes, y la gráfica —con `connectNulls` desactivado— deja
 * el hueco a la vista en vez de trazar una recta por encima.
 */

import { DailyProjectionResponse, DailySideProjection } from './types';

export interface DailyChartRow {
  hour: number;
  label: string;
  buyReal?: number;
  buyProjected?: number;
  buyBand?: [number, number];
  sellReal?: number;
  sellProjected?: number;
  sellBand?: [number, number];
  /** Movimiento de la hora, real si existe y proyectado si no. */
  movePct?: number;
  moveIsReal?: boolean;
}

/** '8 AM', '12 PM', '8 PM'. */
export function hourLabel(hour: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${suffix}`;
}

const sideOf = (
  report: DailyProjectionResponse,
  side: 'BUY' | 'SELL'
): DailySideProjection | undefined => report.sides.find((s) => s.side === side);

export function buildRows(report: DailyProjectionResponse): DailyChartRow[] {
  const buy = sideOf(report, 'BUY');
  const sell = sideOf(report, 'SELL');
  const rows: DailyChartRow[] = [];

  for (let hour = report.startHour; hour <= report.endHour; hour += 1) {
    const row: DailyChartRow = { hour, label: hourLabel(hour) };

    const buyReal = buy?.real.find((r) => r.hour === hour);
    const sellReal = sell?.real.find((r) => r.hour === hour);
    const buyProjected = buy?.projected.find((p) => p.hour === hour);
    const sellProjected = sell?.projected.find((p) => p.hour === hour);

    if (buyReal !== undefined) row.buyReal = buyReal.price;
    if (sellReal !== undefined) row.sellReal = sellReal.price;

    if (buyProjected !== undefined) {
      row.buyProjected = buyProjected.central;
      row.buyBand = [buyProjected.low, buyProjected.high];
    }
    if (sellProjected !== undefined) {
      row.sellProjected = sellProjected.central;
      row.sellBand = [sellProjected.low, sellProjected.high];
    }

    /*
     * El ancla pertenece a las dos series: es el punto donde lo real se
     * convierte en proyección. Sin repetirlo, las dos líneas aparecerían
     * separadas por un hueco que no existe. Se copia el precio REAL, nunca al
     * revés, y no se le pone banda: esa hora ya ocurrió.
     */
    if (hour === report.anchorHour) {
      if (buyReal !== undefined) row.buyProjected = buyReal.price;
      if (sellReal !== undefined) row.sellProjected = sellReal.price;
    }

    // El movimiento por hora se toma del lado de recompra, que es el que pago.
    if (buyReal?.movePct != null) {
      row.movePct = buyReal.movePct;
      row.moveIsReal = true;
    } else if (buyProjected?.movePct != null) {
      row.movePct = buyProjected.movePct;
      row.moveIsReal = false;
    }

    rows.push(row);
  }
  return rows;
}
