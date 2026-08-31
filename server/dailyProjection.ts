/**
 * PROYECCIÓN DE FLUCTUACIÓN DIARIA — MI VENTA Y MI COMPRA
 * ======================================================
 *
 * Adaptador entre el histórico persistido y `projection/dailyShape.ts`. La
 * estadística está allí; aquí se decide QUÉ SERIE alimenta cada pierna y se
 * calculan techo, piso y las cifras de cabecera.
 *
 * ═══ EL MAPEO. ES LO ÚNICO QUE NO PUEDE ESTAR MAL ═══
 *
 *   MI VENTA  ← strategicBuyPrice   (lado Binance BUY)   → agrega por MÁXIMO
 *   MI COMPRA ← strategicSellPrice  (lado Binance SELL)  → agrega por MÍNIMO
 *
 *   TECHO = máximo de MI VENTA        (la mejor tasa a la que pude vender)
 *   PISO  = mínimo de MI COMPRA       (la mejor tasa a la que pude recomprar)
 *
 * `strategicBuyPrice` es la mediana del lado que Binance devuelve con
 * tradeType=BUY, y ése es el lado donde compiten mis anuncios de VENTA: para
 * publicar una venta me pongo justo por debajo del vendedor más barato de esa
 * lista. Lo mismo al revés con SELL y mi recompra. No es una interpretación de
 * este fichero: es lo que ya hace el camino maker del sistema, y
 * `tests/arbitrageSideSemantics.test.ts` lo fija con anuncios BUY a 945 → «Venta
 * 944.99» y SELL a 940 → «Compra 940.01».
 *
 * ═══ EL ERROR QUE ESTO CORRIGE ═══
 *
 * La versión anterior calculaba `ceiling` y `floor` recorriendo LAS DOS piernas
 * y quedándose con el máximo y el mínimo globales: literalmente `max(BUY, SELL)`
 * y `min(BUY, SELL)`. Con el libro en su estado normal —venta por encima de
 * compra— el resultado caía por casualidad en el lado correcto y parecía bien.
 * El día que las dos series se cruzan, y en este mercado se cruzan, el techo
 * pasaba a ser un precio al que nunca pude vender. Además agregaba cada hora con
 * el criterio del TAKER (mejor BUY = más barato), que para un maker es al revés.
 *
 * Ahora cada pierna tiene su propio extremo y NUNCA se comparan entre sí.
 */

import { StorageEngine } from './storage.js';
import type { HistoryRecord } from './types.js';
import {
  DEFAULT_DAY_END_HOUR,
  DEFAULT_DAY_START_HOUR,
  DAILY_EVIDENCE_TEXT,
  LEG_BINANCE_SIDE,
  LEG_LABEL,
  MIN_PROFILE_DAYS,
  TIER_TEXT,
  backtestLeg,
  evidenceFor,
  groupByDay,
  isBetterForLeg,
  projectLeg,
  turnThreshold,
  venezuelaDayKey,
  type DailyEvidenceLevel,
  type DailyTier,
  type LegBacktest,
  type LegProjection,
  type MakerLeg,
  type TurnThreshold,
} from './projection/dailyShape.js';
import { percentileOf, type SeriesPoint } from './projection/series.js';

export type DayDirection = 'SUBIENDO' | 'BAJANDO' | 'LATERAL' | 'INDETERMINADA';
export type DaySpeed = 'LENTO' | 'MODERADO' | 'RAPIDO' | 'INDETERMINADA';

/** Qué se pudo leer del histórico y qué se descartó, por pierna. */
export interface LegExtraction {
  recordsRead: number;
  droppedLegacy: number;
  droppedInvalid: number;
}

/**
 * Extremo del día de UNA pierna, con sus tres piezas separadas.
 *
 * Observado y proyectado van aparte a propósito: el primero ocurrió y el
 * segundo no, y fundirlos en un número borraría justo esa diferencia.
 */
export interface DayExtreme {
  leg: MakerLeg;
  binanceSide: 'BUY' | 'SELL';
  observed: { price: number; hour: number } | null;
  projected: { price: number; low: number; high: number; daysUsed: number } | null;
  /** El mejor de los dos para la pierna. null si no hay ninguno. */
  dayBest: number | null;
  /** true si `dayBest` sale del tramo proyectado. */
  dayBestIsProjected: boolean;
}

export interface HourSpread {
  hour: number;
  /** ((venta − compra) / compra) × 100. Para un maker, positivo es su margen. */
  spreadPct: number;
  observed: boolean;
}

export interface DailyMarketSummary {
  leg: MakerLeg;
  direction: DayDirection;
  speed: DaySpeed;
  changePct: number | null;
}

/** Qué variables del histórico entraron y cuáles están pero aún no se usan. */
export interface VariableReport {
  used: string[];
  availableNotUsed: { name: string; reason: string }[];
}

export interface DailyLegReport {
  projection: LegProjection;
  backtest: LegBacktest;
  evidence: DailyEvidenceLevel;
  evidenceText: string;
  label: string;
  extraction: LegExtraction;
  market: DailyMarketSummary;
}

export interface DailyProjectionReport {
  generatedAt: number;
  source: 'market_history.json';
  dayKey: string;
  startHour: number;
  endHour: number;
  anchorHour: number;

  /** Siempre dos entradas: VENTA primero, COMPRA después. */
  legs: DailyLegReport[];

  ceiling: DayExtreme;
  floor: DayExtreme;
  maxSpread: HourSpread | null;

  turn: TurnThreshold;
  turningNow: boolean;
  remainingPct: number | null;
  watchWindow: { fromHour: number; toHour: number; movePct: number; leg: MakerLeg } | null;

  /** El peor nivel de las dos piernas: la pantalla no puede prometer más. */
  tier: DailyTier;
  tierText: string;
  daysMissing: number;
  variables: VariableReport;
}

/**
 * Serie de una pierna.
 *
 * VENTA lee `strategicBuyPrice`, COMPRA lee `strategicSellPrice`. Se usan los
 * estratégicos (la mediana de cada lado) y no `buyPrice`/`sellPrice`, que son
 * los extremos crudos del TOP 20: un solo anuncio de 20 USDT mueve esos enteros,
 * así que su varianza es la de un participante y no la del mercado. Los
 * registros v1 no los tienen y NO se rellenan — nadie observó esa mediana.
 */
export function extractLegSeries(
  records: readonly HistoryRecord[],
  leg: MakerLeg
): { points: SeriesPoint[]; extraction: LegExtraction } {
  const points: SeriesPoint[] = [];
  let droppedLegacy = 0;
  let droppedInvalid = 0;

  for (const record of records) {
    if (!record || typeof record.timestamp !== 'number' || !Number.isFinite(record.timestamp)) {
      droppedInvalid += 1;
      continue;
    }
    if (record.calculationVersion !== 'v2-strategic') {
      droppedLegacy += 1;
      continue;
    }
    const price =
      LEG_BINANCE_SIDE[leg] === 'BUY' ? record.strategicBuyPrice : record.strategicSellPrice;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      droppedInvalid += 1;
      continue;
    }
    points.push({ t: record.timestamp, price });
  }

  return {
    points,
    extraction: { recordsRead: records.length, droppedLegacy, droppedInvalid },
  };
}

/**
 * Techo o piso de UNA pierna. No recibe la otra, así que no puede mezclarlas.
 *
 * Ésta es la corrección estructural: la función que produce el techo nunca ve
 * la serie de compra, y la que produce el piso nunca ve la de venta.
 */
export function extremeOfLeg(projection: LegProjection): DayExtreme {
  const observed = projection.observedExtreme;
  const q = projection.projectedExtreme;
  const projected =
    q === null
      ? null
      : { price: q.central, low: q.low, high: q.high, daysUsed: q.daysUsed };

  let dayBest: number | null = null;
  let fromProjection = false;
  if (observed !== null) dayBest = observed.price;
  if (projected !== null && (dayBest === null || isBetterForLeg(projection.leg, projected.price, dayBest))) {
    dayBest = projected.price;
    fromProjection = true;
  }

  return {
    leg: projection.leg,
    binanceSide: projection.binanceSide,
    observed,
    projected,
    dayBest,
    dayBestIsProjected: fromProjection,
  };
}

/** Trayectoria completa de una pierna: horas reales y después proyectadas. */
function fullPath(p: LegProjection): { hour: number; price: number; observed: boolean }[] {
  return [
    ...p.real.map((r) => ({ hour: r.hour, price: r.price, observed: true })),
    ...p.projected.map((x) => ({ hour: x.hour, price: x.central, observed: false })),
  ];
}

/**
 * Mayor margen del día, hora a hora.
 *
 * Sólo se compara una hora consigo misma: cruzar la venta de las 9 con la
 * compra de las 14 daría un margen que nunca estuvo disponible. El signo se
 * conserva — vender por debajo de donde se recompra es una pérdida y tiene que
 * seguir siendo distinguible de una ganancia.
 */
export function maxSpreadOf(venta: LegProjection, compra: LegProjection): HourSpread | null {
  const compraByHour = new Map(fullPath(compra).map((p) => [p.hour, p]));
  let best: HourSpread | null = null;

  for (const v of fullPath(venta)) {
    const c = compraByHour.get(v.hour);
    if (c === undefined || c.price <= 0) continue;
    const spreadPct = ((v.price - c.price) / c.price) * 100;
    if (best === null || Math.abs(spreadPct) > Math.abs(best.spreadPct)) {
      best = { hour: v.hour, spreadPct, observed: v.observed && c.observed };
    }
  }
  return best;
}

/**
 * Velocidad medida contra los propios días de la serie: los tercios de los
 * recorridos históricos ancla→cierre. Sin muestra, INDETERMINADA — nunca
 * "moderado" por defecto.
 */
export function speedFor(changePct: number | null, historicalMoves: readonly number[]): DaySpeed {
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

/**
 * ¿Está girando ahora? Exige las dos cosas: que el último movimiento por hora
 * invierta el signo del anterior Y que supere el umbral medido. Un movimiento
 * grande que continúa la tendencia no es un giro; un cambio de signo minúsculo
 * es ruido.
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
 * Recorrido = suma de movimientos absolutos hora a hora, no la diferencia entre
 * extremos: un día que sube 2 y baja 2 se movió, aunque acabe donde empezó.
 */
export function remainingShare(
  real: readonly { price: number }[],
  projected: readonly { movePct: number | null }[]
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

const TIER_ORDER: DailyTier[] = ['SIN_DATOS', 'SOLO_HOY', 'PERFIL_LIMITADO', 'PERFIL_CONDICIONADO'];

function worstTier(legs: readonly LegProjection[]): DailyTier {
  if (legs.length === 0) return 'SIN_DATOS';
  return legs.reduce<DailyTier>(
    (worst, leg) => (TIER_ORDER.indexOf(leg.tier) < TIER_ORDER.indexOf(worst) ? leg.tier : worst),
    'PERFIL_CONDICIONADO'
  );
}

/** Recorridos absolutos ancla→cierre observados en los días del histórico. */
function historicalDayMoves(
  points: readonly SeriesPoint[],
  leg: MakerLeg,
  anchorHour: number,
  startHour: number,
  endHour: number
): number[] {
  const moves: number[] = [];
  for (const day of groupByDay(points, leg, startHour, endHour)) {
    const from = day.hours.get(anchorHour);
    const to = day.hours.get(endHour);
    if (from === undefined || to === undefined || from.best <= 0) continue;
    moves.push(Math.abs((to.best - from.best) / from.best) * 100);
  }
  return moves;
}

function summariseLeg(
  projection: LegProjection,
  points: readonly SeriesPoint[],
  turn: TurnThreshold,
  startHour: number,
  endHour: number
): DailyMarketSummary {
  const close = projection.projectedClose;
  const anchor = projection.anchorPrice;
  const changePct =
    close !== null && anchor !== null && anchor > 0 ? ((close.central - anchor) / anchor) * 100 : null;

  const direction: DayDirection =
    changePct === null
      ? 'INDETERMINADA'
      : turn.pct !== null && Math.abs(changePct) <= turn.pct
        ? 'LATERAL'
        : changePct > 0
          ? 'SUBIENDO'
          : 'BAJANDO';

  return {
    leg: projection.leg,
    direction,
    speed: speedFor(
      changePct,
      historicalDayMoves(points, projection.leg, projection.anchorHour, startHour, endHour)
    ),
    changePct,
  };
}

/**
 * Qué variables del histórico entran en el modelo y cuáles no, con el motivo.
 *
 * Se publica para que nadie tenga que deducirlo del silencio, y para que añadir
 * una variable sea una decisión visible en vez de un detalle enterrado.
 */
function variableReport(records: readonly HistoryRecord[], previousDays: number): VariableReport {
  const has = (pick: (r: HistoryRecord) => unknown) => records.some((r) => pick(r) !== undefined);

  const used = [
    'hora del día (hora local de Venezuela)',
    'precio estratégico del lado BUY (mi venta)',
    'precio estratégico del lado SELL (mi compra)',
    'recorrido del día desde su apertura hasta la hora ancla',
    'extremo de cada hora según la pierna (máximo en venta, mínimo en compra)',
    'cambios hora a hora (umbral de giro y movimiento por hora)',
    'similitud entre el día de hoy y los días anteriores a la misma hora',
    'comportamiento posterior de esos días análogos',
    'número de días disponibles y continuidad de las observaciones',
  ];
  if (previousDays >= 20) used.push('volatilidad realizada del día hasta la hora ancla');

  const availableNotUsed: { name: string; reason: string }[] = [];
  if (previousDays < 20) {
    availableNotUsed.push({
      name: 'volatilidad realizada del día',
      reason: `entra como segundo filtro a partir de 20 días; hay ${previousDays}. Con menos, dividir el pool por dos variables deja menos evidencia de la que quita.`,
    });
  }
  availableNotUsed.push({
    name: 'día de la semana',
    reason: 'necesita varias semanas por cada día para que un lunes se compare con lunes; con el histórico actual reduciría el pool a uno o dos días.',
  });

  if (has((r) => r.buyLiquidityUsdt) || has((r) => r.sellLiquidityUsdt)) {
    availableNotUsed.push({
      name: 'liquidez y profundidad (v3)',
      reason: 'está almacenada pero sólo en los registros v3, y todavía no se ha medido que mejore la proyección. Entrará cuando el backtest pueda demostrarlo.',
    });
  } else {
    availableNotUsed.push({
      name: 'liquidez y profundidad (v3)',
      reason: 'no hay ningún registro que la traiga todavía.',
    });
  }
  availableNotUsed.push({
    name: 'spread entre las dos piernas',
    reason: 'se publica como margen máximo del día, pero no condiciona la elección de días análogos: no se ha medido que aporte.',
  });

  return { used, availableNotUsed };
}

export function buildDailyProjection(
  records: readonly HistoryRecord[],
  now: number,
  startHour = DEFAULT_DAY_START_HOUR,
  endHour = DEFAULT_DAY_END_HOUR
): DailyProjectionReport {
  const ventaSeries = extractLegSeries(records, 'VENTA');
  const compraSeries = extractLegSeries(records, 'COMPRA');

  const venta = projectLeg(ventaSeries.points, 'VENTA', now, startHour, endHour);
  const compra = projectLeg(compraSeries.points, 'COMPRA', now, startHour, endHour);

  const todayKey = venezuelaDayKey(now);
  const ventaDays = groupByDay(ventaSeries.points, 'VENTA', startHour, endHour);
  const compraDays = groupByDay(compraSeries.points, 'COMPRA', startHour, endHour);
  const previousVenta = ventaDays.filter((d) => d.dayKey < todayKey);
  const previousCompra = compraDays.filter((d) => d.dayKey < todayKey);

  /*
   * El backtest recorre SÓLO los días anteriores a hoy. El de hoy está a medias
   * y evaluarlo compararía una proyección contra media jornada.
   */
  const ventaBacktest = backtestLeg(previousVenta, 'VENTA', startHour, endHour);
  const compraBacktest = backtestLeg(previousCompra, 'COMPRA', startHour, endHour);

  /*
   * El umbral de giro se mide sobre MI VENTA. Es una sola cifra en pantalla y
   * usar dos obligaría a explicar cuál manda en el rótulo "AHORA".
   */
  const turn = turnThreshold(previousVenta);

  const legs: DailyLegReport[] = [
    {
      projection: venta,
      backtest: ventaBacktest,
      evidence: evidenceFor(venta, ventaBacktest),
      evidenceText: DAILY_EVIDENCE_TEXT[evidenceFor(venta, ventaBacktest)],
      label: LEG_LABEL.VENTA,
      extraction: ventaSeries.extraction,
      market: summariseLeg(venta, ventaSeries.points, turn, startHour, endHour),
    },
    {
      projection: compra,
      backtest: compraBacktest,
      evidence: evidenceFor(compra, compraBacktest),
      evidenceText: DAILY_EVIDENCE_TEXT[evidenceFor(compra, compraBacktest)],
      label: LEG_LABEL.COMPRA,
      extraction: compraSeries.extraction,
      market: summariseLeg(compra, compraSeries.points, turn, startHour, endHour),
    },
  ];

  // La ventana a vigilar sale de la pierna con el mayor movimiento esperado.
  let watchWindow: DailyProjectionReport['watchWindow'] = null;
  for (const leg of [venta, compra]) {
    let previousHour = leg.anchorHour;
    for (const p of leg.projected) {
      if (
        p.movePct !== null &&
        (watchWindow === null || Math.abs(p.movePct) > Math.abs(watchWindow.movePct))
      ) {
        watchWindow = { fromHour: previousHour, toHour: p.hour, movePct: p.movePct, leg: leg.leg };
      }
      previousHour = p.hour;
    }
  }

  const tier = worstTier([venta, compra]);

  return {
    generatedAt: now,
    source: 'market_history.json',
    dayKey: todayKey,
    startHour,
    endHour,
    anchorHour: venta.anchorHour,
    legs,
    // TECHO sólo de VENTA, PISO sólo de COMPRA. Nunca se comparan entre sí.
    ceiling: extremeOfLeg(venta),
    floor: extremeOfLeg(compra),
    maxSpread: maxSpreadOf(venta, compra),
    turn,
    turningNow: detectTurn(venta.real, turn.pct),
    remainingPct: remainingShare(venta.real, venta.projected),
    watchWindow,
    tier,
    tierText: TIER_TEXT[tier],
    daysMissing: Math.max(0, MIN_PROFILE_DAYS - previousVenta.length),
    variables: variableReport(records, previousVenta.length),
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
