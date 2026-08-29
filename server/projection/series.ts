/**
 * LA SERIE Y SUS UNIDADES
 * =======================
 *
 * Primitivas compartidas por el resto del motor de proyección: limpiar una
 * serie, medir su cadencia real, detectar huecos de captura y expresar
 * horizontes. Nada de aquí sabe nada de proyecciones; son las herramientas con
 * las que las demás piezas miden.
 *
 * POR QUÉ ESTE PAQUETE SE LLAMA `projection/` Y NO `projectionEngine.ts`
 *
 * Existió un `server/projectionEngine.ts` que se retiró: bandas de 1.6 sigma,
 * curva de sesión escrita a mano, coeficiente estacional de 0.0035. Reutilizar
 * ese nombre invitaría a confundir lo retirado con lo nuevo. Y ya existe un
 * `server/projectionBacktest.ts` de nivel superior, que es el backtest del
 * motor MAKER por celda y no tiene nada que ver con éste. Por eso el motor
 * nuevo vive entero bajo `server/projection/`, con nombres cortos que sólo
 * significan algo dentro de ese paquete.
 */

export interface SeriesPoint {
  t: number;
  price: number;
}

/**
 * Un hueco de captura invalida la ventana que lo contiene.
 *
 * 1.5x la cadencia mediana es el punto medio entre el jitter normal de un
 * scheduler (un tick que llega tarde sigue siendo el mismo tick) y una
 * observación que sencillamente falta. Por debajo se descartarían ventanas
 * sanas; por encima se aceptaría una ventana con un agujero dentro y se
 * mediría un "paso" que en realidad son dos.
 */
export const GAP_TOLERANCE_MULTIPLE = 1.5;

/**
 * Ventana mínima de contexto, en pasos.
 *
 * El estado incluye una aceleración, que es la velocidad de la segunda mitad
 * de la ventana menos la de la primera. Una ventana necesita por tanto dos
 * mitades de al menos dos puntos cada una: 4 pasos.
 */
export const MIN_LOOKBACK_STEPS = 4;

export function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Serie limpia: finita, precio positivo, orden ascendente, sin t repetidos. */
export function sanitiseSeries(points: readonly SeriesPoint[]): SeriesPoint[] {
  const clean = points
    .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.price) && p.price > 0)
    .map((p) => ({ t: p.t, price: p.price }))
    .sort((a, b) => a.t - b.t);

  const out: SeriesPoint[] = [];
  for (const p of clean) {
    if (out.length > 0 && out[out.length - 1].t === p.t) {
      // Timestamp repetido: gana el último leído, no se duplica la observación.
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/**
 * Cadencia real de la serie: mediana de los huecos entre observaciones.
 *
 * MEDIDA, nunca supuesta. El histórico global se escribe nominalmente una vez
 * por minuto, pero un reinicio, un despliegue o una caída de red dejan huecos,
 * y dar por buena la cadencia nominal convertiría "30 observaciones" en "30
 * minutos" cuando podrían ser dos horas.
 */
export function medianIntervalMs(points: readonly SeriesPoint[]): number | null {
  if (points.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const gap = points[i].t - points[i - 1].t;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;

  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const value = gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return value > 0 ? value : null;
}

/** ¿Todos los intervalos de points[from..to] caben en la tolerancia? */
export function gapFree(
  points: readonly SeriesPoint[],
  from: number,
  to: number,
  tolerance: number
): boolean {
  for (let i = from + 1; i <= to; i += 1) {
    if (points[i].t - points[i - 1].t > tolerance) return false;
  }
  return true;
}

/**
 * Movimiento típico de la serie: mediana de los saltos NO NULOS.
 *
 * Es la unidad en la que se mide todo lo demás. Una serie que estuvo quieta
 * media ventana y luego se movió tiene una mediana de saltos igual a cero, y
 * tomar eso al pie de la letra sería declarar "no se observó variación" sobre
 * una serie que varió a la vista. Lo que esto mide es el tamaño de un
 * movimiento CUANDO SE MUEVE.
 *
 * Devuelve 0 —no null— cuando la serie es literalmente constante: eso es una
 * medición, no una ausencia de medición.
 */
export function typicalStep(points: readonly SeriesPoint[]): number | null {
  if (points.length < 2) return null;

  const steps: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const move = Math.abs(points[i].price - points[i - 1].price);
    if (move > 0) steps.push(move);
  }
  if (steps.length === 0) return 0;

  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)];
}

/**
 * Percentil por orden estadístico, sin interpolar.
 *
 * Misma convención que `patternEngine.empiricalRange`: dos módulos que
 * publican bandas tienen que calcularlas igual o sus números no son
 * comparables entre sí.
 */
export function percentileOf(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** Ventana de contexto: describir el mismo tramo que se va a proyectar. */
export function lookbackFor(horizonSteps: number): number {
  return Math.max(MIN_LOOKBACK_STEPS, horizonSteps);
}

export function describeHorizon(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `+${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `+${hours} h` : `+${hours.toFixed(1)} h`;
}
