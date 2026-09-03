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
  DEFAULT_HORIZON_HOURS,
  LEG_BINANCE_SIDE,
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
  fullPath,
  historicalDayMoves,
  maxSpreadOf,
  remainingShare,
  speedFor,
  type DaySpeed,
  type HourSpread,
} from './dailyMetrics.js';

/**
 * ESTADO DE LA PANTALLA. Cinco, y no se colapsan.
 *
 * `PROYECCION_VALIDADA` es el único que puede llamarse fiable, y sólo lo
 * concede el backtest walk-forward al batir a la persistencia. Tener muchos
 * registros no valida nada: valida ganarle a "el precio se queda igual".
 */
export type ScreenState =
  | 'SIN_DATOS'
  | 'DATOS_INSUFICIENTES'
  | 'PROYECCION_LIMITADA'
  | 'PROYECCION_CONDICIONADA'
  | 'PROYECCION_VALIDADA';

export const SCREEN_STATE_TEXT: Record<ScreenState, string> = {
  SIN_DATOS: 'No hay histórico capturado todavía.',
  DATOS_INSUFICIENTES: 'Hay datos, pero no alcanzan para proyectar el resto del día.',
  PROYECCION_LIMITADA: 'Evidencia inicial: pocos días y sin filtrar por el estado de hoy.',
  PROYECCION_CONDICIONADA: 'Hay días suficientes para comparar con jornadas parecidas a la de hoy.',
  PROYECCION_VALIDADA: 'El backtest walk-forward demuestra ventaja sobre la persistencia.',
};

/**
 * DE DÓNDE SALE UN PRECIO. Obligatorio en cada cifra de la pantalla.
 *
 * Sin esto un número como 935.47 es magia. Con esto se puede seguir la cadena
 * entera: qué campo del histórico, qué serie, qué cálculo y sobre cuántos días.
 */
export interface PriceOrigin {
  /** Campo literal del histórico del que arranca la cadena. */
  field: 'strategicBuyPrice' | 'strategicSellPrice';
  binanceSide: 'BUY' | 'SELL';
  leg: MakerLeg;
  /** Qué se hizo con él, en una frase legible. */
  calculation: string;
  /** OBSERVADO ocurrió; PROYECTADO no. */
  kind: 'OBSERVADO' | 'PROYECTADO';
  /** Días que sostienen el número. null cuando es una observación directa. */
  daysUsed: number | null;
}

export type DayDirection = 'SUBIENDO' | 'BAJANDO' | 'LATERAL' | 'INDETERMINADA';
export { detectTurn, maxSpreadOf, remainingShare, speedFor };
export type { DaySpeed, HourSpread };

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
  /** Cadena completa del número, para que ninguna cifra sea mágica. */
  origin: PriceOrigin;
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

  /** Precio de ahora, con su cadena. null cuando no hay observación hoy. */
  now: number | null;
  nowOrigin: PriceOrigin;
  /** La mejor ocasión que queda por delante para esta pierna. */
  opportunity: LegOpportunity | null;
  /** Horas históricamente mejores para esta pierna, mejor primero. */
  favourableHours: HourFavourability[];
  /** Giro proyectado en la trayectoria de esta pierna. */
  turn: ProjectedTurn | null;
}

export interface DailyProjectionReport {
  generatedAt: number;
  source: 'market_history.json';
  /** Día calendario (Venezuela) del ancla. */
  dayKey: string;
  anchorHour: number;
  /** Horas hacia adelante que cubre la proyección. Ya no hay "fin de jornada". */
  horizonHours: number;

  /** Siempre dos entradas: VENTA primero, COMPRA después. */
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

  /** El peor nivel de las dos piernas: la pantalla no puede prometer más. */
  tier: DailyTier;
  tierText: string;
  /** Estado de pantalla, que incorpora además el resultado del backtest. */
  state: ScreenState;
  stateText: string;
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

  const extremeWord = projection.leg === 'VENTA' ? 'máximo' : 'mínimo';
  return {
    leg: projection.leg,
    binanceSide: projection.binanceSide,
    observed,
    projected,
    dayBest,
    dayBestIsProjected: fromProjection,
    origin: {
      field: FIELD_FOR_LEG[projection.leg],
      binanceSide: projection.binanceSide,
      leg: projection.leg,
      calculation: fromProjection
        ? `mediana de los ${extremeWord}s que alcanzaron los días análogos entre la hora ancla y el cierre, aplicada al precio real de ahora`
        : `${extremeWord} de los ${extremeWord}s horarios realmente observados hoy`,
      kind: fromProjection ? 'PROYECTADO' : 'OBSERVADO',
      daysUsed: fromProjection ? (projected?.daysUsed ?? null) : null,
    },
  };
}

/** El campo del histórico del que arranca cada pierna. Una sola definición. */
export const FIELD_FOR_LEG: Record<MakerLeg, 'strategicBuyPrice' | 'strategicSellPrice'> = {
  VENTA: 'strategicBuyPrice',
  COMPRA: 'strategicSellPrice',
};










const TIER_ORDER: DailyTier[] = ['SIN_DATOS', 'SOLO_HOY', 'PERFIL_LIMITADO', 'PERFIL_CONDICIONADO'];

function worstTier(legs: readonly LegProjection[]): DailyTier {
  if (legs.length === 0) return 'SIN_DATOS';
  return legs.reduce<DailyTier>(
    (worst, leg) => (TIER_ORDER.indexOf(leg.tier) < TIER_ORDER.indexOf(worst) ? leg.tier : worst),
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
      historicalDayMoves(points, projection.leg, projection.anchorHour, horizonHours)
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

/**
 * El estado que la pantalla puede prometer.
 *
 * VALIDADA exige que el backtest walk-forward gane a la persistencia en AMBAS
 * piernas. Que una gane y la otra no significa que todavía no se sabe, y decir
 * "validada" ahí sería vender media evidencia como entera.
 */
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
  /*
   * ═══ POR QUÉ ESTO FALLA EN VEZ DE DEGRADAR ═══
   *
   * `now` no es un dato de mercado: es el reloj, y en producción siempre llega
   * de `Date.now()`. Un valor no finito no significa "hoy no hay datos",
   * significa que quien llamó está roto.
   *
   * Devolver un informe SIN_DATOS aquí sería cómodo y sería mentira: la
   * pantalla diría "no hay histórico" cuando el histórico puede estar entero y
   * lo que falla es el reloj. Ese diagnóstico equivocado costaría más que el
   * error. Así que se detiene, y el mensaje nombra el parámetro.
   *
   * La ruta ya envuelve esto en try/catch, de modo que el efecto visible es un
   * 500 con una causa legible en vez de un `RangeError: Invalid time value`
   * lanzado desde dentro de `toISOString`.
   */
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

  /*
   * El backtest recorre SÓLO los días anteriores a hoy. El de hoy está a medias
   * y evaluarlo compararía una proyección contra media jornada.
   */
  const ventaBacktest = backtestLeg(previousVenta, 'VENTA', horizonHours);
  const compraBacktest = backtestLeg(previousCompra, 'COMPRA', horizonHours);

  /*
   * El umbral de giro se mide sobre MI VENTA. Es una sola cifra en pantalla y
   * usar dos obligaría a explicar cuál manda en el rótulo "AHORA".
   */
  const turn = turnThreshold(previousVenta);
  const turnThresholdFor = turn;

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
        calculation:
          projection.leg === 'VENTA'
            ? 'máximo de strategicBuyPrice (mediana del lado Binance BUY) observado en la hora en curso'
            : 'mínimo de strategicSellPrice (mediana del lado Binance SELL) observado en la hora en curso',
        kind: 'OBSERVADO',
        daysUsed: null,
      },
      opportunity: bestOpportunity(projection.projected, projection.leg, projection.anchorPrice),
      favourableHours: favourableHours(previousDays, projection.leg),
      turn: projectedTurn(projection.projected, turnThresholdFor.pct),
    };
  };

  const legs: DailyLegReport[] = [
    buildLeg(venta, ventaBacktest, ventaSeries.extraction, ventaSeries.points, previousVenta),
    buildLeg(compra, compraBacktest, compraSeries.extraction, compraSeries.points, previousCompra),
  ];

  // La ventana a vigilar sale de la pierna con el mayor movimiento esperado.
  let watchWindow: DailyProjectionReport['watchWindow'] = null;
  for (const leg of [venta, compra]) {
    let previousHoursAhead = 0; // el ancla mismo: 0 horas adelante
    for (const p of leg.projected) {
      if (
        p.movePct !== null &&
        (watchWindow === null || Math.abs(p.movePct) > Math.abs(watchWindow.movePct))
      ) {
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

  return {
    generatedAt: now,
    source: 'market_history.json',
    dayKey: todayKey,
    anchorHour: venta.anchorHour,
    horizonHours,
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
    state: screenState(tier, legs),
    stateText: SCREEN_STATE_TEXT[screenState(tier, legs)],
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
