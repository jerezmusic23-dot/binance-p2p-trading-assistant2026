/**
 * LA SERIE PRINCIPAL DEL PREDICTOR
 * ================================
 *
 * Adaptador entre el histórico persistido y el paquete `projection/`. Toda la
 * estadística está allí; aquí sólo se decide QUÉ SERIE se le da y se explica
 * por qué, que es la parte que se puede equivocar en silencio.
 *
 * DE DÓNDE SALEN LOS DATOS
 *
 * De `market_history.json` a través de `StorageEngine.getHistory()`, la misma
 * fuente que sirve `/api/market/history`. Es la serie global del libro, escrita
 * a razón de un registro por minuto, y es la única con cadencia uniforme y
 * longitud suficiente para sostener horizontes de un cuarto de hora en
 * adelante.
 *
 * NO se usan los 6 s del polling como observaciones: ese es el ritmo al que se
 * consulta a Binance, no el ritmo al que se escribe historia. Confundirlos
 * multiplicaría por diez el número aparente de observaciones sin añadir una
 * sola independiente.
 *
 * Los 42 ficheros `.ndjson` por celda tampoco entran como serie principal en
 * esta versión: su cadencia es de una observación cada ~4.5 min por celda, así
 * que el mismo tiempo produce ~6 veces menos observaciones, y además cada
 * celda tiene su liquidez y su comportamiento. Mezclarlos con la serie global
 * rompería la definición de "una observación". Son un complemento futuro.
 *
 * QUÉ CAMPO SE PROYECTA
 *
 * `strategicBuyPrice` y `strategicSellPrice`, no `buyPrice`/`sellPrice`.
 *
 * Los segundos son los extremos crudos del libro TOP 20: el anuncio más barato
 * y el más caro que había en ese instante. Un único anuncio de 20 USDT movido
 * por alguien mueve la serie entera, así que su varianza es la de un solo
 * participante y no la del mercado. Los estratégicos son la MEDIANA de cada
 * lado, que es lo que un maker mira cuando decide dónde publicar.
 *
 * Los registros anteriores a `calculationVersion === 'v2-strategic'` no tienen
 * esos campos y NO SE RELLENAN: no hay forma de recuperar la mediana de un
 * libro que ya no se puede leer, e inventarla sería justo lo que la Regla 5
 * prohíbe. Se descartan, y el número de descartes se publica para que la
 * pérdida sea visible.
 *
 * LOS DOS LADOS SE PROYECTAN POR SEPARADO
 *
 * BUY (el ask: lo que me cuesta comprar USDT) y SELL (el bid: lo que me pagan
 * por venderlos) son dos mercados con dos profundidades distintas. Mezclarlos
 * en una serie, o proyectar uno y aplicar el spread al otro, daría un número
 * que ninguna de las dos series respalda. La semántica BUY/SELL ya fijada en
 * `types.ts` se conserva intacta: aquí no se invierte ningún lado.
 */

import { StorageEngine } from './storage.js';
import { trackForecasts } from './forecastTracker.js';
import type { HistoryRecord } from './types.js';
import {
  DEFAULT_HORIZONS_MS,
  decideValidation,
  projectWithBacktest,
  projectWithBacktestAsync,
  readMarket,
  type ForecastReport,
  type MarketReadingResult,
  type SeriesPoint,
  type SeriesProjection,
} from './projection/index.js';

export type MarketSide = 'BUY' | 'SELL';

export interface SeriesExtraction {
  points: SeriesPoint[];
  /** Registros leídos del histórico antes de filtrar. */
  recordsRead: number;
  /** Registros descartados por ser v1 (sin precio estratégico). */
  droppedLegacy: number;
  /** Registros descartados por precio o timestamp ausente o no finito. */
  droppedInvalid: number;
}

/**
 * Extrae una de las dos series estratégicas del histórico.
 *
 * Devuelve además lo que se dejó fuera. Una serie corta porque el histórico es
 * corto y una serie corta porque se descartó la mitad son dos situaciones
 * distintas, y la pantalla tiene que poder distinguirlas.
 */
export function extractStrategicSeries(
  records: readonly HistoryRecord[],
  side: MarketSide
): SeriesExtraction {
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

    const price = side === 'BUY' ? record.strategicBuyPrice : record.strategicSellPrice;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      droppedInvalid += 1;
      continue;
    }

    points.push({ t: record.timestamp, price });
  }

  return { points, recordsRead: records.length, droppedLegacy, droppedInvalid };
}

export interface MarketSideProjection extends SeriesProjection {
  side: MarketSide;
  extraction: Omit<SeriesExtraction, 'points'>;
  /**
   * ESTADO ACTUAL, separado de la PROYECCIÓN a propósito.
   *
   * `reading` describe lo que el mercado está haciendo ahora —movimiento,
   * fuerza, tendencia por horizontes, liquidez— y `horizons` afirma hacia
   * dónde apuntan las situaciones históricas parecidas. Un mercado puede
   * estar subiendo y proyectarse LATERAL porque sube justo lo que suele
   * subir; fundir las dos cosas en una etiqueta borraría esa diferencia.
   */
  reading: MarketReadingResult;
}

export interface MarketProjectionReport {
  generatedAt: number;
  /** Fuente literal, para que la pantalla no tenga que suponerla. */
  source: 'market_history.json';
  sides: MarketSideProjection[];
  /** true si algún lado tiene al menos un horizonte READY. */
  usable: boolean;
  /**
   * Rendimiento de las proyecciones YA EMITIDAS Y VENCIDAS.
   *
   * null cuando el seguimiento está desactivado, que es el caso de los tests y
   * de cualquier cálculo que no deba escribir. La ruta HTTP sí lo activa: es
   * la única forma de saber si el modelo acierta en producción, y no en una
   * simulación del pasado.
   */
  forecastPerformance: ForecastReport | null;
}

export interface MarketProjectionOptions {
  horizonsMs?: readonly number[];
  historyTail?: number;
  now?: number;
  /** Inyectable para tests; por defecto lee el histórico persistido. */
  readRecords?: () => readonly HistoryRecord[];
  /**
   * Registra las proyecciones de ahora y evalúa las vencidas. ESCRIBE A DISCO,
   * así que está apagado por defecto: sólo la ruta HTTP lo enciende.
   */
  trackForecasts?: boolean;
}

const SIDE_LABEL: Record<MarketSide, string> = {
  BUY: 'Precio estratégico BUY (mediana del ask)',
  SELL: 'Precio estratégico SELL (mediana del bid)',
};

function assemble(
  order: MarketSide[],
  extractions: SeriesExtraction[],
  projections: SeriesProjection[],
  now: number,
  records: readonly HistoryRecord[]
): MarketProjectionReport {
  /*
   * LA CORRECCIÓN SE APLICA SOBRE LOS DOS LADOS A LA VEZ.
   *
   * La pantalla enseña BUY y SELL juntos, así que quien mira está haciendo
   * todos esos contrastes de una vez y se queda con el que salga bien.
   * Corregir cada lado por separado dejaría entrar precisamente ese sesgo.
   * Cada lado ya decidió con su propia familia; esto vuelve a decidir con la
   * familia completa, y es puro: no repite ningún backtest.
   */
  const decided = decideValidation(projections);

  const sides = order.map((side, i) => ({
    ...decided[i],
    side,
    extraction: {
      recordsRead: extractions[i].recordsRead,
      droppedLegacy: extractions[i].droppedLegacy,
      droppedInvalid: extractions[i].droppedInvalid,
    },
    reading: buildReading(extractions[i].points, decided[i], liquidityContext(records, side)),
  }));

  return {
    generatedAt: now,
    source: 'market_history.json',
    sides,
    usable: sides.some((s) => s.usable),
    forecastPerformance: null,
  };
}

/**
 * Añade al informe el seguimiento de proyecciones en vivo.
 *
 * Separado de `assemble` porque escribe: el informe se puede construir entero
 * sin tocar disco, y sólo quien quiera medir el rendimiento paga ese coste.
 */
function withForecastTracking(
  report: MarketProjectionReport,
  extractions: SeriesExtraction[],
  order: MarketSide[]
): MarketProjectionReport {
  const byId = new Map(
    order.map((side, i) => [`STRATEGIC_${side}`, extractions[i].points as readonly SeriesPoint[]])
  );
  const tracking = trackForecasts(
    report.sides,
    (seriesId) => byId.get(seriesId) ?? [],
    report.generatedAt
  );
  return { ...report, forecastPerformance: tracking.report };
}

/**
 * Liquidez de las últimas capturas, para la lectura del estado actual.
 *
 * Sólo los registros que la traen (v3). Los anteriores no se rellenan: nadie
 * observó esos valores.
 */
function liquidityContext(records: readonly HistoryRecord[], side: MarketSide) {
  const enriched = records.filter((r) => r?.enrichmentVersion === 'v3-context');
  if (enriched.length === 0) return undefined;

  const last = enriched[enriched.length - 1];
  const buys = enriched
    .map((r) => r.buyLiquidityUsdt)
    .filter((v): v is number => typeof v === 'number');
  const sells = enriched
    .map((r) => r.sellLiquidityUsdt)
    .filter((v): v is number => typeof v === 'number');

  return {
    current: {
      buyUsdt: last.buyLiquidityUsdt ?? null,
      sellUsdt: last.sellLiquidityUsdt ?? null,
      buyAds: last.buyLiquidityAds ?? null,
      sellAds: last.sellLiquidityAds ?? null,
    },
    recentBuy: buys,
    recentSell: sells,
  };
}

/**
 * Compone la lectura del estado actual con lo que la proyección ya descubrió.
 *
 * El nivel de evidencia no se decide aquí por su cuenta: se alimenta de si
 * algún horizonte reunió análogos y de si el backtest respaldó alguno, que son
 * hechos que sólo el motor conoce.
 */
function buildReading(
  points: readonly SeriesPoint[],
  projection: SeriesProjection,
  liquidity: ReturnType<typeof liquidityContext>
): MarketReadingResult {
  return readMarket(points, {
    liquidity,
    hasSufficientAnalogues: projection.horizons.some((h) => h.available),
    backtestValidated: projection.horizons.some((h) => h.status === 'READY'),
  });
}

function prepare(options: MarketProjectionOptions) {
  const read = options.readRecords ?? (() => StorageEngine.getHistory());
  const records = read();
  const order: MarketSide[] = ['BUY', 'SELL'];
  const now = options.now ?? Date.now();

  return {
    order,
    now,
    records,
    extractions: order.map((side) => extractStrategicSeries(records, side)),
    projectOptions: (side: MarketSide) => ({
      seriesId: `STRATEGIC_${side}`,
      label: SIDE_LABEL[side],
      horizonsMs: options.horizonsMs ?? DEFAULT_HORIZONS_MS,
      historyTail: options.historyTail,
      now,
    }),
  };
}

/** De un tirón. Lo que usan los tests. */
export function buildMarketProjection(
  options: MarketProjectionOptions = {}
): MarketProjectionReport {
  const { order, now, records, extractions, projectOptions } = prepare(options);
  const projections = order.map((side, i) =>
    projectWithBacktest(extractions[i].points, projectOptions(side))
  );
  const report = assemble(order, extractions, projections, now, records);
  return options.trackForecasts ? withForecastTracking(report, extractions, order) : report;
}

/**
 * Igual, pero cediendo el hilo entre bloques del backtest.
 *
 * Es la que usa la ruta HTTP. La captura de Binance es prioritaria y un
 * backtest completo tarda segundos; partido en bloques, esos segundos dejan de
 * ser un bloqueo. Hay un test que comprueba que ambas variantes producen
 * exactamente el mismo informe.
 */
export async function buildMarketProjectionAsync(
  options: MarketProjectionOptions = {}
): Promise<MarketProjectionReport> {
  const { order, now, records, extractions, projectOptions } = prepare(options);
  const projections: SeriesProjection[] = [];
  for (let i = 0; i < order.length; i += 1) {
    projections.push(await projectWithBacktestAsync(extractions[i].points, projectOptions(order[i])));
  }
  const report = assemble(order, extractions, projections, now, records);
  return options.trackForecasts ? withForecastTracking(report, extractions, order) : report;
}
