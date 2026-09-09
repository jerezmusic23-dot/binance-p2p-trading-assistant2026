/**
 * PROYECCIÓN GENERAL DEL MERCADO USDT/VES
 * ========================================
 *
 * La proyección NO es una matriz bancaria ni una proyección de maker.
 * Usa exclusivamente el libro GENERAL de Binance P2P almacenado en
 * market_history.json.
 *
 * ═══ QUÉ SE PROYECTA (D4) ═══
 *
 * Se proyecta la REFERENCIA ESTRATÉGICA del mercado general -la mediana de
 * cada lado- no el extremo crudo:
 *
 *   VENTA  = strategicSellPrice   COMPRA = strategicBuyPrice
 *
 * Un extremo sigue al anuncio más lejano, no al mercado: un único anuncio a
 * 920.659 movía el extremo 48.64 VES mientras la mediana se movía 0.05. Es la
 * misma referencia que ya usan `hourlyGrid.ts` y las alertas de Telegram.
 * LOS EXTREMOS NO DESAPARECEN: `sellPrice`/`buyPrice` siguen siendo el mejor
 * precio EJECUTABLE y se publican aparte, en `executableExtreme`.
 *
 *   referencia estratégica -> dónde está el mercado -> se proyecta
 *   extremo ejecutable     -> con quién puedo operar -> NO se proyecta
 * REGISTROS LEGACY: uno anterior a `v2-strategic` usa el extremo -lo único que
 * observó- y suma en `legacyRecords`. No se fabrica una mediana retrospectiva.
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
  venezuelaHourOf,
  type DailyEvidenceLevel,
  type DailyTier,
  type HourSummary,
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
  field: 'buyPrice' | 'sellPrice' | 'strategicBuyPrice' | 'strategicSellPrice';
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
  /**
   * Registros sin referencia estratégica que usaron el extremo como respaldo.
   * Se declara para no presentar como robusta una serie que en parte no lo es.
   */
  legacyRecords: number;
}

/**
 * El mejor precio EJECUTABLE de la hora en curso. Se publica junto a la
 * proyección pero no forma parte de ella.
 */
export interface ExecutableExtreme {
  leg: MakerLeg;
  price: number;
  hour: number;
  observations: number;
  field: 'buyPrice' | 'sellPrice';
  calculation: string;
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
  /** Referencia estratégica en la hora actual. Es lo que se proyecta. */
  now: number | null;
  nowOrigin: PriceOrigin;
  /** Mejor precio EJECUTABLE de la hora actual. Observado, nunca proyectado. */
  executableExtreme: ExecutableExtreme | null;
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
 * De qué campo del histórico sale cada serie. Dos preguntas distintas sobre la
 * misma captura, que no se sustituyen:
 *   STRATEGIC  - la mediana del lado. Es lo que se PROYECTA.
 *   EXECUTABLE - el extremo del lado. Es el precio con el que se OPERA.
 */
export type LegSource = 'STRATEGIC' | 'EXECUTABLE';

const STRATEGIC_FIELD: Record<MakerLeg, 'strategicBuyPrice' | 'strategicSellPrice'> = {
  VENTA: 'strategicSellPrice',
  COMPRA: 'strategicBuyPrice',
};

/** El extremo del MISMO lado. Respaldo para registros sin capa estratégica. */
export const EXECUTABLE_FIELD: Record<MakerLeg, 'buyPrice' | 'sellPrice'> = {
  VENTA: 'sellPrice',
  COMPRA: 'buyPrice',
};

function usableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Fuente de la serie de una pierna. Por defecto la REFERENCIA ESTRATÉGICA. El
 * lado de Binance no cambia -VENTA lee SELL y COMPRA lee BUY-; cambia qué
 * estadístico de ese lado se toma. Un registro sin referencia usa el extremo,
 * lo único que observó, y suma en `legacyRecords`.
 */
export function extractLegSeries(
  records: readonly HistoryRecord[],
  leg: MakerLeg,
  source: LegSource = 'STRATEGIC'
): { points: SeriesPoint[]; extraction: LegExtraction } {
  const points: SeriesPoint[] = [];
  const strategicField = STRATEGIC_FIELD[leg];
  const executableField = EXECUTABLE_FIELD[leg];
  let droppedInvalid = 0;
  let legacyRecords = 0;

  for (const record of records) {
    if (!record || typeof record.timestamp !== 'number' || !Number.isFinite(record.timestamp)) {
      droppedInvalid += 1;
      continue;
    }

    let price: unknown;
    if (source === 'EXECUTABLE') {
      price = record[executableField];
    } else {
      const robust = record[strategicField];
      if (usableNumber(robust)) {
        price = robust;
      } else {
        legacyRecords += 1;
        price = record[executableField];
      }
    }

    if (!usableNumber(price)) {
      droppedInvalid += 1;
      continue;
    }
    points.push({ t: record.timestamp, price });
  }

  return {
    points,
    extraction: { recordsRead: records.length, droppedLegacy: 0, droppedInvalid, legacyRecords },
  };
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

  const field = FIELD_FOR_LEG[projection.leg];
  const operation =
    projection.leg === 'VENTA'
      ? 'referencia estratégica del lado VENTA'
      : 'referencia estratégica del lado COMPRA';

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
        ? `proyección de la ${operation} usando el movimiento histórico de la misma referencia`
        : `${operation} observada por hora en el mercado general`,
      kind: fromProjection ? 'PROYECTADO' : 'OBSERVADO',
      daysUsed: fromProjection ? (projected?.daysUsed ?? null) : null,
    },
  };
}

/**
 * De qué campo sale la serie que se PROYECTA. Única definición.
 *
 * Es la referencia estratégica, no el extremo: `EXECUTABLE_FIELD` nombra al
 * extremo, y los dos coexisten porque responden a preguntas distintas.
 */
export const FIELD_FOR_LEG: Record<MakerLeg, 'strategicBuyPrice' | 'strategicSellPrice'> = {
  VENTA: 'strategicSellPrice',
  COMPRA: 'strategicBuyPrice',
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
  horizonHours: number,
  summary: HourSummary
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
    speed: speedFor(changePct, historicalDayMoves(points, projection.leg, projection.anchorHour, horizonHours, summary)),
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

/**
 * Es un OBSERVADO, nunca un proyectado: proyectarlo sería el error que D4
 * corrige. `null` cuando la hora en curso no tiene ninguna observación.
 */
export function latestExecutableExtreme(
  points: readonly SeriesPoint[],
  leg: MakerLeg,
  now: number
): ExecutableExtreme | null {
  const dayKey = venezuelaDayKey(now);
  const hour = venezuelaHourOf(now);
  let best: number | null = null;
  let observations = 0;

  for (const p of points) {
    if (venezuelaDayKey(p.t) !== dayKey || venezuelaHourOf(p.t) !== hour) continue;
    observations += 1;
    if (best === null || isBetterForLeg(leg, p.price, best)) best = p.price;
  }

  if (best === null) return null;
  return {
    leg,
    price: best,
    hour,
    observations,
    field: EXECUTABLE_FIELD[leg],
    calculation:
      leg === 'VENTA'
        ? 'precio MÁS ALTO de VENTA observado en la hora actual del mercado general'
        : 'precio MÁS BAJO de COMPRA observado en la hora actual del mercado general',
  };
}

/**
 * Cómo resume una hora la ruta ESTRATÉGICA (D5): la mediana, por coherencia con
 * `projection/hourlyGrid.ts`. Las dos rutas proyectan ya la misma referencia y
 * ahora también con el mismo estadístico horario.
 */
export const STRATEGIC_SUMMARY: HourSummary = 'MEDIAN';

export function buildDailyProjection(
  records: readonly HistoryRecord[],
  now: number,
  horizonHours = DEFAULT_HORIZON_HOURS
): DailyProjectionReport {
  assertInstant(now, 'buildDailyProjection(now)');

  // Lo que se PROYECTA: la referencia estratégica.
  const ventaSeries = extractLegSeries(records, 'VENTA');
  const compraSeries = extractLegSeries(records, 'COMPRA');

  /*
   * Lo que se OPERA: el extremo ejecutable. Se extrae aparte, se publica
   * aparte y NO se proyecta. Existe para que la pantalla pueda seguir
   * mostrando el mejor precio real sin que se confunda con la referencia.
   */
  const ventaExecutable = extractLegSeries(records, 'VENTA', 'EXECUTABLE');
  const compraExecutable = extractLegSeries(records, 'COMPRA', 'EXECUTABLE');
  // D5: la hora se resume por su MEDIANA. `best` sigue disponible como dato
  // descriptivo; cambia qué valor representa la hora en trayectoria, análogos,
  // volatilidad realizada, umbral de giro y backtest.
  const venta = projectLeg(ventaSeries.points, 'VENTA', now, horizonHours, STRATEGIC_SUMMARY);
  const compra = projectLeg(compraSeries.points, 'COMPRA', now, horizonHours, STRATEGIC_SUMMARY);

  const todayKey = venezuelaDayKey(now);
  const ventaDays = groupByDay(ventaSeries.points, 'VENTA', STRATEGIC_SUMMARY);
  const compraDays = groupByDay(compraSeries.points, 'COMPRA', STRATEGIC_SUMMARY);
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
    previousDays: readonly ReturnType<typeof groupByDay>[number][],
    executablePoints: readonly SeriesPoint[]
  ): DailyLegReport => {
    const evidence = evidenceFor(projection, backtest);
    return {
      projection,
      backtest,
      evidence,
      evidenceText: DAILY_EVIDENCE_TEXT[evidence],
      label: LEG_LABEL[projection.leg],
      extraction,
      market: summariseLeg(projection, points, turn, horizonHours, STRATEGIC_SUMMARY),
      now: projection.anchorPrice,
      nowOrigin: {
        field: FIELD_FOR_LEG[projection.leg],
        binanceSide: projection.binanceSide,
        leg: projection.leg,
        calculation: projection.leg === 'VENTA'
          ? 'referencia estratégica del lado VENTA (mediana del lado Binance SELL) en la hora actual'
          : 'referencia estratégica del lado COMPRA (mediana del lado Binance BUY) en la hora actual',
        kind: 'OBSERVADO',
        daysUsed: null,
      },
      executableExtreme: latestExecutableExtreme(executablePoints, projection.leg, now),
      opportunity: bestOpportunity(projection.projected, projection.leg, projection.anchorPrice),
      favourableHours: favourableHours(previousDays, projection.leg),
      turn: projectedTurn(projection.projected, turn.pct),
    };
  };

  const legs: DailyLegReport[] = [
    buildLeg(venta, ventaBacktest, ventaSeries.extraction, ventaSeries.points, previousVenta, ventaExecutable.points),
    buildLeg(compra, compraBacktest, compraSeries.extraction, compraSeries.points, previousCompra, compraExecutable.points),
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
