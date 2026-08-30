/**
 * PROYECCIÓN DE FLUCTUACIÓN DIARIA
 * ================================
 *
 * Adaptador entre el histórico persistido y `projection/dailyShape.ts`. Toda la
 * estadística está allí; aquí se decide QUÉ SERIE se le da, se calculan las
 * cifras de cabecera y se explica cada una, que es la parte que puede
 * equivocarse en silencio.
 *
 * ═══ LA MISMA SERIE QUE EL RESTO DEL PREDICTOR ═══
 *
 * `strategicBuyPrice` / `strategicSellPrice` de `market_history.json`, vía
 * `extractStrategicSeries`, exactamente igual que `marketProjection.ts`. No se
 * usa `buyPrice`/`sellPrice`: ésos son los extremos crudos del TOP 20 y un solo
 * anuncio de 20 USDT los mueve enteros. Y no se mezcla con el CSV de
 * usdt.com.ve: es otro estimador, de otra fuente, con otra definición de precio.
 *
 * ═══ LOS DOS LADOS NO SE DERIVAN UNO DEL OTRO ═══
 *
 * Se proyectan por separado. Aplicar el spread de hoy a la proyección del otro
 * lado daría una línea que ninguna serie respalda. La semántica fijada en
 * `types.ts` se conserva: recompra = ask (lo que pago), venta = bid (lo que me
 * pagan), y el spread firmado es ((venta − recompra) / recompra) × 100, la
 * misma fórmula que ya usa la matriz.
 *
 * ═══ NINGUNA CIFRA DE CABECERA ES UNA CONSTANTE ═══
 *
 * El umbral de giro, la velocidad del mercado y la ventana a vigilar salen de
 * percentiles de la propia serie. Un "±0.3 %" escrito a mano decidiría qué se
 * le anuncia al propietario sin que nadie lo haya medido.
 */

import { StorageEngine } from './storage.js';
import type { HistoryRecord } from './types.js';
import { extractStrategicSeries, type MarketSide, type SeriesExtraction } from './marketProjection.js';
import {
  DEFAULT_DAY_END_HOUR,
  DEFAULT_DAY_START_HOUR,
  MIN_PROFILE_DAYS,
  TIER_TEXT,
  groupByDay,
  projectRestOfDay,
  turnThreshold,
  validateShape,
  venezuelaDayKey,
  type DailyTier,
  type DayProjection,
  type ShapeValidation,
  type TurnThreshold,
} from './projection/dailyShape.js';
import { percentileOf } from './projection/series.js';

export type DayDirection = 'SUBIENDO' | 'BAJANDO' | 'LATERAL' | 'INDETERMINADA';
export type DaySpeed = 'LENTO' | 'MODERADO' | 'RAPIDO' | 'INDETERMINADA';

export interface DayExtreme {
  price: number;
  hour: number;
  side: MarketSide;
  /** false cuando cae en el tramo proyectado. */
  observed: boolean;
}

export interface HourSpread {
  hour: number;
  /** ((venta − recompra) / recompra) × 100. Negativo es normal y válido. */
  spreadPct: number;
  observed: boolean;
}

export interface DailyMarketSummary {
  direction: DayDirection;
  speed: DaySpeed;
  /** Cambio del ancla al cierre de la ventana, en %. null sin proyección. */
  changePct: number | null;
  /** Lado sobre el que se resume. Se usa el de recompra por ser el que pago. */
  side: MarketSide;
}

export interface DailyProjectionReport {
  generatedAt: number;
  source: 'market_history.json';
  dayKey: string;
  startHour: number;
  endHour: number;
  /** Hora local de Venezuela en la que se ancla la proyección. */
  anchorHour: number;

  sides: DayProjection[];
  extraction: Record<MarketSide, Omit<SeriesExtraction, 'points'>>;

  ceiling: DayExtreme | null;
  floor: DayExtreme | null;
  maxSpread: HourSpread | null;
  market: DailyMarketSummary;

  turn: TurnThreshold;
  /** true si el último movimiento real por hora superó el umbral y cambió de signo. */
  turningNow: boolean;
  /**
   * Parte del recorrido del día que todavía no ha ocurrido, 0–100.
   * null cuando no hay proyección con la que medirlo.
   */
  remainingPct: number | null;
  /** Tramo con el mayor movimiento esperado. null si no hay proyección. */
  watchWindow: { fromHour: number; toHour: number; movePct: number } | null;

  /** El nivel más bajo de los dos lados: la pantalla no puede prometer más. */
  tier: DailyTier;
  tierText: string;
  validation: ShapeValidation;
  /** Días anteriores que faltan para poder dibujar una curva. 0 si ya se puede. */
  daysMissing: number;
}

/** Serie de un lado lista para el estimador de forma del día. */
function seriesFor(records: readonly HistoryRecord[], side: MarketSide) {
  return extractStrategicSeries(records, side);
}

/** Trayectoria completa de un lado: horas reales primero, proyectadas después. */
function fullPath(day: DayProjection): { hour: number; price: number; observed: boolean }[] {
  return [
    ...day.real.map((r) => ({ hour: r.hour, price: r.price, observed: true })),
    ...day.projected.map((p) => ({ hour: p.hour, price: p.central, observed: false })),
  ];
}

function extremesOf(sides: readonly DayProjection[]): { ceiling: DayExtreme | null; floor: DayExtreme | null } {
  let ceiling: DayExtreme | null = null;
  let floor: DayExtreme | null = null;

  for (const day of sides) {
    for (const point of fullPath(day)) {
      const candidate: DayExtreme = {
        price: point.price,
        hour: point.hour,
        side: day.side,
        observed: point.observed,
      };
      if (ceiling === null || point.price > ceiling.price) ceiling = candidate;
      if (floor === null || point.price < floor.price) floor = candidate;
    }
  }
  return { ceiling, floor };
}

/**
 * Mayor spread del día, hora a hora.
 *
 * Sólo se compara una hora consigo misma: cruzar la recompra de las 9 con la
 * venta de las 14 daría un spread que nunca estuvo disponible para nadie.
 */
function maxSpreadOf(sides: readonly DayProjection[]): HourSpread | null {
  const buy = sides.find((s) => s.side === 'BUY');
  const sell = sides.find((s) => s.side === 'SELL');
  if (buy === undefined || sell === undefined) return null;

  const buyByHour = new Map(fullPath(buy).map((p) => [p.hour, p]));
  let best: HourSpread | null = null;

  for (const sellPoint of fullPath(sell)) {
    const buyPoint = buyByHour.get(sellPoint.hour);
    if (buyPoint === undefined || buyPoint.price <= 0) continue;
    const spreadPct = ((sellPoint.price - buyPoint.price) / buyPoint.price) * 100;
    if (best === null || Math.abs(spreadPct) > Math.abs(best.spreadPct)) {
      best = {
        hour: sellPoint.hour,
        spreadPct,
        observed: sellPoint.observed && buyPoint.observed,
      };
    }
  }
  return best;
}

/**
 * Velocidad del mercado, medida contra sus propios días.
 *
 * `changePct` se sitúa entre los recorridos que la serie hizo históricamente en
 * lo que queda de jornada. Los tercios de esa distribución son LENTO / MODERADO
 * / RÁPIDO. Sin muestra no hay velocidad: INDETERMINADA, y no "moderado" por
 * defecto.
 */
function speedFor(changePct: number | null, historicalMoves: readonly number[]): DaySpeed {
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

/** Recorridos absolutos ancla→cierre observados en los días del histórico. */
function historicalDayMoves(
  records: readonly HistoryRecord[],
  side: MarketSide,
  anchorHour: number,
  endHour: number,
  startHour: number
): number[] {
  const { points } = seriesFor(records, side);
  const days = groupByDay(points, side, startHour, endHour);
  const moves: number[] = [];
  for (const day of days) {
    const from = day.hours.get(anchorHour);
    const to = day.hours.get(endHour);
    if (from === undefined || to === undefined || from.best <= 0) continue;
    moves.push(Math.abs((to.best - from.best) / from.best) * 100);
  }
  return moves;
}

/**
 * ¿Está girando ahora?
 *
 * Un giro es el último movimiento real por hora cuando (a) supera el umbral
 * medido y (b) invierte el signo del movimiento anterior. Las dos condiciones
 * juntas: un movimiento grande que continúa la tendencia no es un giro, y un
 * cambio de signo minúsculo es ruido.
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
 * Recorrido = suma de los movimientos absolutos hora a hora, no la diferencia
 * entre extremos: un día que sube 2 y baja 2 se movió, aunque termine donde
 * empezó, y quien opera dentro lo nota.
 */
export function remainingShare(
  real: readonly { hour: number; price: number }[],
  projected: readonly { hour: number; movePct: number | null }[]
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

/** El tramo con mayor movimiento esperado: dónde merece la pena mirar. */
function watchWindowOf(day: DayProjection): { fromHour: number; toHour: number; movePct: number } | null {
  let best: { fromHour: number; toHour: number; movePct: number } | null = null;
  let previousHour = day.anchorHour;
  for (const p of day.projected) {
    if (p.movePct !== null && (best === null || Math.abs(p.movePct) > Math.abs(best.movePct))) {
      best = { fromHour: previousHour, toHour: p.hour, movePct: p.movePct };
    }
    previousHour = p.hour;
  }
  return best;
}

/** El nivel de evidencia de la pantalla es el PEOR de los dos lados. */
const TIER_ORDER: DailyTier[] = ['SIN_DATOS', 'SOLO_HOY', 'PERFIL_LIMITADO', 'PERFIL_CONDICIONADO'];

function worstTier(sides: readonly DayProjection[]): DailyTier {
  if (sides.length === 0) return 'SIN_DATOS';
  return sides.reduce<DailyTier>(
    (worst, side) => (TIER_ORDER.indexOf(side.tier) < TIER_ORDER.indexOf(worst) ? side.tier : worst),
    'PERFIL_CONDICIONADO'
  );
}

export function buildDailyProjection(
  records: readonly HistoryRecord[],
  now: number,
  startHour = DEFAULT_DAY_START_HOUR,
  endHour = DEFAULT_DAY_END_HOUR
): DailyProjectionReport {
  const buySeries = seriesFor(records, 'BUY');
  const sellSeries = seriesFor(records, 'SELL');

  const buy = projectRestOfDay(buySeries.points, 'BUY', now, startHour, endHour);
  const sell = projectRestOfDay(sellSeries.points, 'SELL', now, startHour, endHour);
  const sides = [buy, sell];

  const { ceiling, floor } = extremesOf(sides);
  const maxSpread = maxSpreadOf(sides);

  /*
   * El umbral de giro y la validación se miden sobre el lado de RECOMPRA: es el
   * precio que el propietario paga, y usar dos umbrales distintos obligaría a
   * explicar cuál manda en cada rótulo.
   */
  const buyDays = groupByDay(buySeries.points, 'BUY', startHour, endHour);
  const todayKey = venezuelaDayKey(now);
  const previousDays = buyDays.filter((d) => d.dayKey < todayKey);

  const turn = turnThreshold(previousDays);
  const validation = validateShape(previousDays, startHour, endHour);

  const lastProjected = buy.projected.length > 0 ? buy.projected[buy.projected.length - 1] : null;
  const changePct =
    lastProjected !== null && buy.anchorPrice !== null && buy.anchorPrice > 0
      ? ((lastProjected.central - buy.anchorPrice) / buy.anchorPrice) * 100
      : null;

  const direction: DayDirection =
    changePct === null
      ? 'INDETERMINADA'
      : turn.pct !== null && Math.abs(changePct) <= turn.pct
        ? 'LATERAL'
        : changePct > 0
          ? 'SUBIENDO'
          : 'BAJANDO';

  const market: DailyMarketSummary = {
    direction,
    speed: speedFor(
      changePct,
      historicalDayMoves(records, 'BUY', buy.anchorHour, endHour, startHour)
    ),
    changePct,
    side: 'BUY',
  };

  const tier = worstTier(sides);

  return {
    generatedAt: now,
    source: 'market_history.json',
    dayKey: todayKey,
    startHour,
    endHour,
    anchorHour: buy.anchorHour,
    sides,
    extraction: {
      BUY: {
        recordsRead: buySeries.recordsRead,
        droppedLegacy: buySeries.droppedLegacy,
        droppedInvalid: buySeries.droppedInvalid,
      },
      SELL: {
        recordsRead: sellSeries.recordsRead,
        droppedLegacy: sellSeries.droppedLegacy,
        droppedInvalid: sellSeries.droppedInvalid,
      },
    },
    ceiling,
    floor,
    maxSpread,
    market,
    turn,
    turningNow: detectTurn(buy.real, turn.pct),
    remainingPct: remainingShare(buy.real, buy.projected),
    watchWindow: watchWindowOf(buy),
    tier,
    tierText: TIER_TEXT[tier],
    validation,
    daysMissing: Math.max(0, MIN_PROFILE_DAYS - previousDays.length),
  };
}

/**
 * Lee el histórico persistido y construye el informe del día.
 *
 * `readRecords` se inyecta —igual que en `marketProjection.ts`— para poder
 * probar el informe con una serie conocida sin tocar el fichero de producción.
 */
export function dailyProjectionFromStorage(
  now = Date.now(),
  readRecords: () => readonly HistoryRecord[] = () => StorageEngine.getHistory()
): DailyProjectionReport {
  return buildDailyProjection(readRecords(), now);
}
