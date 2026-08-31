/**
 * VALIDACIÓN WALK-FORWARD DE LA PROYECCIÓN DEL DÍA
 * ===============================================
 *
 * Separado de `dailyShape.ts` porque son dos responsabilidades: allí se
 * PROYECTA, aquí se comprueba si esa proyección vale algo. Mezclarlas producía
 * un fichero de casi mil líneas donde la garantía crítica —que el backtest no
 * puede ver el futuro— quedaba enterrada entre el resto.
 */

import { binomialTailProbability } from './probability.js';
import {
  DEFAULT_DAY_END_HOUR,
  DEFAULT_DAY_START_HOUR,
  MIN_PROFILE_DAYS,
  extremeForLeg,
  projectLegFromDays,
  type DailyEvidenceLevel,
  type DayShape,
  type LegProjection,
  type MakerLeg,
} from './dailyShape.js';

/* ════════════════════════════════════════════════════════════════════════
 * BACKTEST TEMPORAL, SIN LOOK-AHEAD
 * ════════════════════════════════════════════════════════════════════════
 *
 * Se recorre el histórico hacia adelante. Para el día i el perfil se construye
 * con `days.slice(0, i)` — ESTRICTAMENTE los días anteriores.
 *
 * Esto no es un detalle: la versión anterior usaba "todos menos el día i", que
 * incluye días POSTERIORES. Eso es look-ahead puro y habría inflado el
 * resultado con información que en ese momento no existía. La garantía aquí es
 * estructural, no una promesa: el conjunto se recorta antes de entrar y la
 * función que proyecta no recibe nada más.
 *
 * Dentro del día evaluado, el ancla parte los datos en dos: hasta la hora ancla
 * se usa para condicionar, y sólo después se lee la realidad para comparar.
 */

export interface LegBacktest {
  leg: MakerLeg;
  /** Días evaluados. Es la unidad independiente del contraste. */
  days: number;
  /** Anclas día×hora evaluadas. Contexto, NO tamaño de muestra del contraste. */
  anchors: number;

  /** Error absoluto medio del cierre proyectado, y el de la persistencia. */
  closeErrorModel: number | null;
  closeErrorPersistence: number | null;
  /** Error absoluto medio del extremo (techo en VENTA, piso en COMPRA). */
  extremeErrorModel: number | null;
  extremeErrorPersistence: number | null;
  /** Proporción de veces que el cierre real cayó dentro de la banda, 0–1. */
  coverage: number | null;
  /** Aciertos de dirección sobre los casos en que hubo dirección que acertar. */
  directionHits: number;
  directionTotal: number;

  modelWins: number;
  persistenceWins: number;
  ties: number;
  pValue: number | null;
  beatsPersistence: boolean;
}

export const BACKTEST_ALPHA = 0.05;

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

export function backtestLeg(
  days: readonly DayShape[],
  leg: MakerLeg,
  startHour = DEFAULT_DAY_START_HOUR,
  endHour = DEFAULT_DAY_END_HOUR
): LegBacktest {
  const ordered = [...days].sort((a, b) => a.dayKey.localeCompare(b.dayKey));

  const closeModel: number[] = [];
  const closePersistence: number[] = [];
  const extremeModel: number[] = [];
  const extremePersistence: number[] = [];
  let covered = 0;
  let coverageCases = 0;
  let directionHits = 0;
  let directionTotal = 0;
  let anchors = 0;

  let modelWins = 0;
  let persistenceWins = 0;
  let ties = 0;
  let evaluatedDays = 0;

  for (let i = 0; i < ordered.length; i += 1) {
    // ESTRICTAMENTE anterior. Aquí es donde se impide el look-ahead.
    const past = ordered.slice(0, i);
    if (past.length < MIN_PROFILE_DAYS) continue;

    const actual = ordered[i];
    const dayModelErrors: number[] = [];
    const dayPersistenceErrors: number[] = [];

    for (let anchor = startHour; anchor < endHour; anchor += 1) {
      const anchorCell = actual.hours.get(anchor);
      if (anchorCell === undefined || anchorCell.best <= 0) continue;

      /*
       * El día evaluado se recorta hasta el ancla antes de proyectar: el motor
       * no puede ver ni una hora posterior de su propio día.
       */
      const visibleToday: DayShape = {
        dayKey: actual.dayKey,
        weekday: actual.weekday,
        hours: new Map([...actual.hours.entries()].filter(([h]) => h <= anchor)),
      };

      const projection = projectLegFromDays(
        [...past, visibleToday],
        leg,
        actual.dayKey,
        anchor,
        startHour,
        endHour
      );
      if (projection.projected.length === 0) continue;
      anchors += 1;

      // ── Cierre ──
      const closeCell = actual.hours.get(endHour);
      if (closeCell !== undefined && projection.projectedClose !== null) {
        const modelError = Math.abs(projection.projectedClose.central - closeCell.best);
        const persistenceError = Math.abs(anchorCell.best - closeCell.best);
        closeModel.push(modelError);
        closePersistence.push(persistenceError);
        dayModelErrors.push(modelError);
        dayPersistenceErrors.push(persistenceError);

        coverageCases += 1;
        const lo = Math.min(projection.projectedClose.low, projection.projectedClose.high);
        const hi = Math.max(projection.projectedClose.low, projection.projectedClose.high);
        if (closeCell.best >= lo && closeCell.best <= hi) covered += 1;

        // Dirección: sólo cuenta cuando el mercado se movió de verdad.
        const realMove = closeCell.best - anchorCell.best;
        const projectedMove = projection.projectedClose.central - anchorCell.best;
        if (realMove !== 0 && projectedMove !== 0) {
          directionTotal += 1;
          if (Math.sign(realMove) === Math.sign(projectedMove)) directionHits += 1;
        }
      }

      // ── Extremo del tramo restante ──
      const futureValues: number[] = [];
      for (let h = anchor + 1; h <= endHour; h += 1) {
        const cell = actual.hours.get(h);
        if (cell !== undefined) futureValues.push(cell.best);
      }
      const realExtreme = extremeForLeg(leg, futureValues);
      if (realExtreme !== null && projection.projectedExtreme !== null) {
        extremeModel.push(Math.abs(projection.projectedExtreme.central - realExtreme));
        // La persistencia no predice un extremo distinto del precio de ahora.
        extremePersistence.push(Math.abs(anchorCell.best - realExtreme));
      }
    }

    if (dayModelErrors.length === 0) continue;
    evaluatedDays += 1;
    /*
     * UN DÍA, UN CASO. Las anclas de un mismo día recorren la misma trayectoria;
     * contarlas por separado daría cientos de "casos" y una p diminuta que sería
     * falsa. Se promedian y el día aporta un solo signo.
     */
    const m = mean(dayModelErrors)!;
    const p = mean(dayPersistenceErrors)!;
    if (m < p) modelWins += 1;
    else if (m > p) persistenceWins += 1;
    else ties += 1;
  }

  const comparisons = modelWins + persistenceWins;
  const pValue = comparisons === 0 ? null : binomialTailProbability(modelWins, comparisons);

  return {
    leg,
    days: evaluatedDays,
    anchors,
    closeErrorModel: mean(closeModel),
    closeErrorPersistence: mean(closePersistence),
    extremeErrorModel: mean(extremeModel),
    extremeErrorPersistence: mean(extremePersistence),
    coverage: coverageCases === 0 ? null : covered / coverageCases,
    directionHits,
    directionTotal,
    modelWins,
    persistenceWins,
    ties,
    pValue,
    beatsPersistence: pValue !== null && pValue < BACKTEST_ALPHA && modelWins > persistenceWins,
  };
}

/** Fuerza de la evidencia de una pierna, a partir de su backtest y su perfil. */
export function evidenceFor(projection: LegProjection, backtest: LegBacktest): DailyEvidenceLevel {
  if (projection.tier === 'SIN_DATOS') return 'SIN_DATOS_SUFICIENTES';
  if (projection.tier === 'SOLO_HOY') return 'SOLO_OBSERVACION';
  if (backtest.days === 0 || backtest.pValue === null) return 'ESTIMACION_SIN_VALIDAR';
  return backtest.beatsPersistence ? 'EVIDENCIA_FUERTE' : 'EVIDENCIA_DEBIL';
}

export const DAILY_EVIDENCE_TEXT: Record<DailyEvidenceLevel, string> = {
  SIN_DATOS_SUFICIENTES: 'Sin datos suficientes para decir nada.',
  SOLO_OBSERVACION: 'Sólo lo observado hoy. No hay proyección.',
  ESTIMACION_SIN_VALIDAR: 'Estimación sin validar: no hay días bastantes para comparar contra la persistencia.',
  EVIDENCIA_DEBIL: 'Evidencia débil: el modelo todavía no mejora de forma demostrable a suponer que el precio se queda igual.',
  EVIDENCIA_FUERTE: 'Evidencia fuerte: el modelo bate a la persistencia en el histórico disponible.',
};
