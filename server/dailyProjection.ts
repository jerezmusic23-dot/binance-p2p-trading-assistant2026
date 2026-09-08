/**
 * PROYECCIÓN GENERAL DEL MERCADO USDT/VES
 * ========================================
 *
 * La proyección NO es una matriz bancaria ni una proyección de maker.
 * Usa exclusivamente el libro GENERAL de Binance P2P almacenado en
 * market_history.json.
 *
 * Regla de precio:
 *   VENTA  = precio MÁS ALTO del lado de venta (sellPrice / BID)
 *   COMPRA = precio MÁS BAJO del lado de compra (buyPrice / ASK)
 *
 * En cada hora se conserva el extremo correspondiente. Después se estudia
 * cómo esos mismos extremos se han movido históricamente para estimar dirección,
 * fuerza y trayectoria futura. Nunca se sustituye por un banco, monto,
 * strategicBuyPrice, strategicSellPrice ni otra serie.
 */

import { StorageEngine } from './storage.js';
import type { HistoryRecord } from './types.js';
import {
  DEFAULT_HORIZON_HOURS,
  LEG_LABEL,
  MIN_PROFILE_DAYS,
  TIER_TEXT,
  assertInstant,
  groupByDay,
  isBetterForLeg,
  projectLeg,
  venezuelaDayKey,
  type DailyEvidenceLevel,
  type DailyTier,
  type LegProjection,
  type MakerLeg,
} from './projection/dailyShape.js';
import {
  DAILY_EVIDENCE_TEXT,
  backtestLeg,
  evidenceFor,
  type LegBacktest,
} from './projection/dailyBacktest.js';
import {
  bestOpportunity,
  favourableHours,
  projectedTurn,
  turnThreshold,
  type HourFavourability,
  type LegOpportunity,
  type ProjectedTurn,
  type TurnThreshold,
} from './projection/dailyOpportunity.js';
import type { SeriesPoint } from './projection/series.js';
import {
  detectTurn,
  historicalDayMoves,
  maxSpreadOf,
  remainingShare,
  speedFor,
  type DaySpeed,
  type HourSpread,
} from './dailyMetrics.js';

export type ScreenState =
  | 'SIN_DATOS'
  | 'DATOS_INSUFICIENTES'
  | 'PROYECCION_LIMITADA'
  | 'PROYECCION_CONDICIONADA'
  | 'PROYECCION_VALIDADA';

export const SCREEN_STATE_TEXT: Record<ScreenState, string> = {
  SIN_DATOS: 'No hay histórico capturado todavía.',
  DATOS_INSUFICIENTES: 'Hay datos, pero no alcanzan para proyectar el mercado.',
  PROYECCION_LIMITADA: 'Evidencia inicial: pocos días históricos disponibles.',
  PROYECCION_CONDICIONADA: 'Proyección respaldada por días históricos comparables.',
  PROYECCION_VALIDADA: 'El backtest walk-forward demuestra ventaja sobre la persistencia.',
};

export interface PriceOrigin {
  field: 'buyPrice' | 'sellPrice';
  binanceSide: 'BUY' | 'SELL';
  leg: MakerLeg;
  calculation: string;
  kind: 'OBSERVADO' | 'PROYECTADO';
  daysUsed: number | null;
}

export type DayDirection = 'SUBIENDO' | 'BAJANDO' | 'LATERAL' | 'INDETERMINADA';
export { detectTurn, maxSpreadOf, remainingShare, speedFor };
export type { DaySpeed, HourSpread };

export interface LegExtraction {
  recordsRead: number;
  droppedLegacy: number;
  droppedInvalid: number;
}

export interface DayExtreme {
  leg: MakerLeg;
  binanceSide: 'BUY' | 'SELL';
  observed: { price: number; hour: number } | null;
  projected: { price: number; low: number; high: number; daysUsed: number } | null;
  dayBest: number | null;
  dayBestIsProjected: boolean;
  origin: PriceOrigin;
}

export interface DailyMarketSummary {
  leg: MakerLeg;
  direction: DayDirection;
  speed: DaySpeed;
  changePct: number | null;
}

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
  now: number | null;
  nowOrigin: PriceOrigin;
  opportunity: LegOpportunity | null;
  favourableHours: HourFavourability[];
  turn: ProjectedTurn | null;
}

export interface DailyProjectionReport {
  generatedAt: number;
  source: 'market_history.json';
  dayKey: string;
  anchorHour: number;
  horizonHours: number;
  legs: DailyLegReport[];
  ceiling: DayExtreme;
  floor: DayExtreme;
  maxSpread: HourSpread | null;
  turn: TurnThreshold;
  turningNow: boolean;
  remainingPct: number | null;
  watchWindow: {
    fromHoursAhead: number;
    toHoursAhead: number;
    toHourOfDay: number;
    toDayKey: string;
    movePct: number;
    leg: MakerLeg;
  } | null;
  tier: DailyTier;
  tierText: string;
  state: ScreenState;
  stateText: string;
  daysMissing: number;
  variables: VariableReport;
  dataProvenance: DataProvenanceSummary;
}

/**
 * Cuánto del histórico usado puede afirmarse libre de Recarga Pines.
 *
 * `generalReferenceVersion` sólo existe en los registros capturados después
 * de que `filterGeneralReferenceAds` excluyera Recarga Pines de
 * buyPrice/sellPrice (server/marketContext.ts). Los registros anteriores no
 * se descartan - Regla 5/8: no se destruye histórico existente ni se inventa
 * limpieza que nadie observó - pero tampoco se presentan como verificados.
 * `unverifiedRecords > 0` es la señal explícita de que una parte del
 * histórico no puede confirmarse, que la pantalla debe poder mostrar.
 */
export interface DataProvenanceSummary {
  totalRecords: number;
  verifiedCleanRecords: number;
  unverifiedRecords: number;
  /** true sólo cuando CADA registro usado lleva la marca v4. */
  fullyVerified: boolean;
}

export function summariseProvenance(records: readonly HistoryRecord[]): DataProvenanceSummary {
  let verified = 0;
  for (const record of records) {
    if (record?.generalReferenceVersion === 'v4-no-recarga-pines') verified += 1;
  }
  return {
    totalRecords: records.length,
    verifiedCleanRecords: verified,
    unverifiedRecords: records.length - verified,
    fullyVerified: records.length > 0 && verified === records.length,
  };
}

/**
 * Fuente única de la proyección general.
 *
 * VENTA -> sellPrice: el precio más alto publicado para vender USDT.
 * COMPRA -> buyPrice: el precio más bajo publicado para comprar USDT.
 *
 * Estos son los extremos crudos que ya vienen en cada HistoryRecord. No se
 * leen strategicBuyPrice/strategicSellPrice y no se descartan los registros
 * antiguos por carecer de campos estratégicos.
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
    const price = leg === 'VENTA' ? record.sellPrice : record.buyPrice;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      droppedInvalid += 1;
      continue;
    }
    points.push({ t: record.timestamp, price });
  }

  return { points, extraction: { recordsRead: records.length, droppedLegacy, droppedInvalid } };
}

/** Techo = máximo de VENTA; piso = mínimo de COMPRA. Nunca se mezclan. */
export function extremeOfLeg(projection: LegProjection): DayExtreme {
  const observed = projection.observedExtreme;
  const q = projection.projectedExtreme;
  const projected = q === null ? null : {
    price: q.central,
    low: q.low,
    high: q.high,
    daysUsed: q.daysUsed,
  };

  let dayBest: number | null = observed?.price ?? null;
  let fromProjection = false;
  if (projected !== null && (dayBest === null || isBetterForLeg(projection.leg, projected.price, dayBest))) {
    dayBest = projected.price;
    fromProjection = true;
  }

  const field = projection.leg === 'VENTA' ? 'sellPrice' : 'buyPrice';
  const operation = projection.leg === 'VENTA' ? 'precio MÁS ALTO de VENTA' : 'precio MÁS BAJO de COMPRA';

  return {
    leg: projection.leg,
    binanceSide: projection.binanceSide,
    observed,
    projected,
    dayBest,
    dayBestIsProjected: fromProjection,
    origin: {
      field,
      binanceSide: projection.binanceSide,
      leg: projection.leg,
      calculation: fromProjection
        ? `proyección del ${operation} usando el movimiento histórico del mismo extremo`
        : `${operation} observado por hora en el mercado general`,
      kind: fromProjection ? 'PROYECTADO' : 'OBSERVADO',
      daysUsed: fromProjection ? (projected?.daysUsed ?? null) : null,
    },
  };
}

export const FIELD_FOR_LEG: Record<MakerLeg, 'buyPrice' | 'sellPrice'> = {
  VENTA: 'sellPrice',
  COMPRA: 'buyPrice',
};

const TIER_ORDER: DailyTier[] = ['SIN_DATOS', 'SOLO_HOY', 'PERFIL_LIMITADO', 'PERFIL_CONDICIONADO'];

function worstTier(legs: readonly LegProjection[]): DailyTier {
  if (legs.length === 0) return 'SIN_DATOS';
  return legs.reduce<DailyTier>(
    (worst, leg) => TIER_ORDER.indexOf(leg.tier) < TIER_ORDER.indexOf(worst) ? leg.tier : worst,
    'PERFIL_CONDICIONADO'
  );
}

function summariseLeg(
  projection: LegProjection,
  points: readonly SeriesPoint[],
  turn: TurnThreshold,
  horizonHours: number
): DailyMarketSummary {
  const close = projection.projectedClose;
  const anchor = projection.anchorPrice;
  const changePct = close !== null && anchor !== null && anchor > 0
    ? ((close.central - anchor) / anchor) * 100
    : null;

  const direction: DayDirection = changePct === null
    ? 'INDETERMINADA'
    : turn.pct !== null && Math.abs(changePct) <= turn.pct
      ? 'LATERAL'
      : changePct > 0 ? 'SUBIENDO' : 'BAJANDO';

  return {
    leg: projection.leg,
    direction,
    speed: speedFor(changePct, historicalDayMoves(points, projection.leg, projection.anchorHour, horizonHours)),
    changePct,
  };
}

function variableReport(records: readonly HistoryRecord[], previousDays: number): VariableReport {
  const has = (pick: (r: HistoryRecord) => unknown) => records.some((r) => pick(r) !== undefined);
  const used = [
    'hora del día (Venezuela)',
    'precio MÁS ALTO de VENTA (sellPrice)',
    'precio MÁS BAJO de COMPRA (buyPrice)',
    'extremo horario de cada lado',
    'movimiento histórico hora a hora',
    'días históricos comparables',
  ];
  const availableNotUsed: { name: string; reason: string }[] = [
    {
      name: 'precio estratégico',
      reason: 'no participa en la proyección general; pertenece a la lógica de publicación/maker.',
    },
  ];
  if (has((r) => r.buyLiquidityUsdt) || has((r) => r.sellLiquidityUsdt)) {
    availableNotUsed.push({
      name: 'liquidez y profundidad',
      reason: 'se reserva para ejecución y contexto; no altera el precio proyectado sin evidencia predictiva.',
    });
  }
  if (previousDays < 20) {
    availableNotUsed.push({
      name: 'volatilidad como segundo filtro',
      reason: `hay ${previousDays} días; añadir otro filtro reduciría demasiado la muestra.`,
    });
  }
  return { used, availableNotUsed };
}

export function screenState(tier: DailyTier, legs: readonly DailyLegReport[]): ScreenState {
  if (tier === 'SIN_DATOS') return 'SIN_DATOS';
  if (tier === 'SOLO_HOY') return 'DATOS_INSUFICIENTES';
  if (legs.length > 0 && legs.every((l) => l.backtest.beatsPersistence)) return 'PROYECCION_VALIDADA';
  return tier === 'PERFIL_CONDICIONADO' ? 'PROYECCION_CONDICIONADA' : 'PROYECCION_LIMITADA';
}

export function buildDailyProjection(
  records: readonly HistoryRecord[],
  now: number,
  horizonHours = DEFAULT_HORIZON_HOURS
): DailyProjectionReport {
  assertInstant(now, 'buildDailyProjection(now)');

  const ventaSeries = extractLegSeries(records, 'VENTA');
  const compraSeries = extractLegSeries(records, 'COMPRA');
  const venta = projectLeg(ventaSeries.points, 'VENTA', now, horizonHours);
  const compra = projectLeg(compraSeries.points, 'COMPRA', now, horizonHours);

  const todayKey = venezuelaDayKey(now);
  const ventaDays = groupByDay(ventaSeries.points, 'VENTA');
  const compraDays = groupByDay(compraSeries.points, 'COMPRA');
  const previousVenta = ventaDays.filter((d) => d.dayKey < todayKey);
  const previousCompra = compraDays.filter((d) => d.dayKey < todayKey);

  const ventaBacktest = backtestLeg(previousVenta, 'VENTA', horizonHours);
  const compraBacktest = backtestLeg(previousCompra, 'COMPRA', horizonHours);
  const turn = turnThreshold(previousVenta);

  const buildLeg = (
    projection: LegProjection,
    backtest: LegBacktest,
    extraction: LegExtraction,
    points: readonly SeriesPoint[],
    previousDays: readonly ReturnType<typeof groupByDay>[number][]
  ): DailyLegReport => {
    const evidence = evidenceFor(projection, backtest);
    return {
      projection,
      backtest,
      evidence,
      evidenceText: DAILY_EVIDENCE_TEXT[evidence],
      label: LEG_LABEL[projection.leg],
      extraction,
      market: summariseLeg(projection, points, turn, horizonHours),
      now: projection.anchorPrice,
      nowOrigin: {
        field: FIELD_FOR_LEG[projection.leg],
        binanceSide: projection.binanceSide,
        leg: projection.leg,
        calculation: projection.leg === 'VENTA'
          ? 'precio MÁS ALTO de VENTA observado en la hora actual del mercado general'
          : 'precio MÁS BAJO de COMPRA observado en la hora actual del mercado general',
        kind: 'OBSERVADO',
        daysUsed: null,
      },
      opportunity: bestOpportunity(projection.projected, projection.leg, projection.anchorPrice),
      favourableHours: favourableHours(previousDays, projection.leg),
      turn: projectedTurn(projection.projected, turn.pct),
    };
  };

  const legs: DailyLegReport[] = [
    buildLeg(venta, ventaBacktest, ventaSeries.extraction, ventaSeries.points, previousVenta),
    buildLeg(compra, compraBacktest, compraSeries.extraction, compraSeries.points, previousCompra),
  ];

  let watchWindow: DailyProjectionReport['watchWindow'] = null;
  for (const leg of [venta, compra]) {
    let previousHoursAhead = 0;
    for (const p of leg.projected) {
      if (p.movePct !== null && (watchWindow === null || Math.abs(p.movePct) > Math.abs(watchWindow.movePct))) {
        watchWindow = {
          fromHoursAhead: previousHoursAhead,
          toHoursAhead: p.hoursAhead,
          toHourOfDay: p.hourOfDay,
          toDayKey: p.dayKey,
          movePct: p.movePct,
          leg: leg.leg,
        };
      }
      previousHoursAhead = p.hoursAhead;
    }
  }

  const tier = worstTier([venta, compra]);
  const state = screenState(tier, legs);

  return {
    generatedAt: now,
    source: 'market_history.json',
    dayKey: todayKey,
    anchorHour: venta.anchorHour,
    horizonHours,
    legs,
    ceiling: extremeOfLeg(venta),
    floor: extremeOfLeg(compra),
    maxSpread: maxSpreadOf(venta, compra),
    turn,
    turningNow: detectTurn(venta.real, turn.pct),
    remainingPct: remainingShare(venta.real, venta.projected),
    watchWindow,
    tier,
    tierText: TIER_TEXT[tier],
    state,
    stateText: SCREEN_STATE_TEXT[state],
    daysMissing: Math.max(0, MIN_PROFILE_DAYS - previousVenta.length),
    variables: variableReport(records, previousVenta.length),
    dataProvenance: summariseProvenance(records),
  };
}

export function dailyProjectionFromStorage(
  now = Date.now(),
  readRecords: () => readonly HistoryRecord[] = () => StorageEngine.getHistory()
): DailyProjectionReport {
  return buildDailyProjection(readRecords(), now);
}
