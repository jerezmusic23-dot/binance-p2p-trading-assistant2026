/**
 * FILAS DE LA GRÁFICA DEL DÍA
 * ===========================
 *
 * Convierte el informe del servidor en una fila por hora. Vive fuera del
 * componente porque es justo la parte que puede mentir sin que se note: basta
 * con colocar un precio proyectado en el campo de lo real para que la pantalla
 * afirme que algo ocurrió. Aquí se puede probar; dentro de recharts, no.
 *
 * Las series se llaman por LA OPERACIÓN —venta y compra—, nunca por el lado de
 * Binance a secas, para que un cruce de líneas se lea mal en voz alta antes de
 * llegar a producción.
 *
 * No inventa horas. Una hora que nadie observó y que no se proyectó sale con
 * los campos ausentes, y la gráfica —con `connectNulls` desactivado— deja el
 * hueco a la vista en vez de trazar una recta por encima.
 */

import { DailyLegProjection, DailyProjectionResponse, MakerLeg } from './types';

export interface DailyChartRow {
  hour: number;
  label: string;
  ventaReal?: number;
  ventaProjected?: number;
  ventaBand?: [number, number];
  compraReal?: number;
  compraProjected?: number;
  compraBand?: [number, number];
  /** Movimiento de la hora en MI VENTA, real si existe y proyectado si no. */
  movePct?: number;
  moveIsReal?: boolean;
}

/** '8 AM', '12 PM', '8 PM'. */
export function hourLabel(hour: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${suffix}`;
}

export function legOf(
  report: DailyProjectionResponse,
  leg: MakerLeg
): DailyLegProjection | undefined {
  return report.legs.find((l) => l.projection.leg === leg)?.projection;
}

export function buildRows(report: DailyProjectionResponse): DailyChartRow[] {
  const venta = legOf(report, 'VENTA');
  const compra = legOf(report, 'COMPRA');
  const rows: DailyChartRow[] = [];

  for (let hour = report.startHour; hour <= report.endHour; hour += 1) {
    const row: DailyChartRow = { hour, label: hourLabel(hour) };

    const ventaReal = venta?.real.find((r) => r.hour === hour);
    const compraReal = compra?.real.find((r) => r.hour === hour);
    const ventaProjected = venta?.projected.find((p) => p.hour === hour);
    const compraProjected = compra?.projected.find((p) => p.hour === hour);

    if (ventaReal !== undefined) row.ventaReal = ventaReal.price;
    if (compraReal !== undefined) row.compraReal = compraReal.price;

    if (ventaProjected !== undefined) {
      row.ventaProjected = ventaProjected.central;
      row.ventaBand = [ventaProjected.low, ventaProjected.high];
    }
    if (compraProjected !== undefined) {
      row.compraProjected = compraProjected.central;
      row.compraBand = [compraProjected.low, compraProjected.high];
    }

    /*
     * El ancla pertenece a las dos series: es el punto donde lo real se
     * convierte en proyección, y sin repetirlo las líneas aparecerían separadas
     * por un hueco que no existe. Se copia el precio REAL, nunca al revés, y no
     * se le pone banda: esa hora ya ocurrió.
     */
    if (hour === report.anchorHour) {
      if (ventaReal !== undefined) row.ventaProjected = ventaReal.price;
      if (compraReal !== undefined) row.compraProjected = compraReal.price;
    }

    if (ventaReal?.movePct != null) {
      row.movePct = ventaReal.movePct;
      row.moveIsReal = true;
    } else if (ventaProjected?.movePct != null) {
      row.movePct = ventaProjected.movePct;
      row.moveIsReal = false;
    }

    rows.push(row);
  }
  return rows;
}
