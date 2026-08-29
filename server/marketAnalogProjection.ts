/**
 * LA SERIE PRINCIPAL DEL PREDICTOR
 * ================================
 *
 * Adaptador entre el histórico persistido y `analogProjection`. Toda la
 * estadística está allí; aquí sólo se decide QUÉ SERIE se le da y se explica
 * por qué, que es la parte que se puede equivocar en silencio.
 *
 * DE DÓNDE SALEN LOS DATOS
 * ------------------------
 * De `market_history.json` a través de `StorageEngine.getHistory()`, la misma
 * fuente que sirve `/api/market/history`. Es la serie global del libro, escrita
 * a razón de un registro por minuto, y es la única con cadencia uniforme y
 * suficiente longitud para sostener horizontes de media hora en adelante.
 *
 * Los ficheros `.ndjson` por celda (banco × importe) NO se usan como serie
 * principal en esta versión: su cadencia es de una observación cada ~4.5 min
 * por celda, así que la misma cantidad de tiempo produce ~6 veces menos
 * observaciones, y además cada celda tiene su propia liquidez y su propio
 * comportamiento. Son un complemento, no la base del predictor.
 *
 * QUÉ CAMPO SE PROYECTA
 * ---------------------
 * `strategicBuyPrice` y `strategicSellPrice`, no `buyPrice`/`sellPrice`.
 *
 * Los segundos son los extremos crudos del libro: el anuncio más barato y el
 * más caro que había en ese instante. Un único anuncio de 20 USDT movido por
 * alguien mueve la serie entera, así que su varianza es la de un solo
 * participante y no la del mercado. Los estratégicos son la MEDIANA de cada
 * lado, que es lo que un maker está mirando cuando decide dónde publicar.
 *
 * Los registros anteriores a `calculationVersion === 'v2-strategic'` no tienen
 * esos campos y NO SE RELLENAN: no existe forma de recuperar la mediana de un
 * libro que ya no se puede leer, e inventarla sería exactamente lo que la
 * Regla 5 prohíbe. Esos registros se descartan de la serie, y el número de
 * descartes se publica para que la pérdida sea visible.
 *
 * LOS DOS LADOS SE PROYECTAN POR SEPARADO
 * ---------------------------------------
 * BUY (el ask: lo que me cuesta comprar USDT) y SELL (el bid: lo que me pagan
 * por venderlos) son dos mercados con dos profundidades distintas. Mezclarlos
 * en una sola serie o proyectar sólo uno y aplicar el spread al otro daría un
 * número que ninguna de las dos series respalda.
 */

import { StorageEngine } from './storage.js';
import type { HistoryRecord } from './types.js';
import {
  DEFAULT_HORIZONS_MS,
  decideValidation,
  projectByAnalogy,
  type AnalogPoint,
  type AnalogProjection,
} from './analogProjection.js';

export type AnalogSide = 'BUY' | 'SELL';

export interface AnalogSeriesExtraction {
  points: AnalogPoint[];
  /** Registros leídos del histórico antes de filtrar. */
  recordsRead: number;
  /** Registros descartados por ser v1 (sin precio estratégico). */
  droppedLegacy: number;
  /** Registros descartados por precio ausente o no finito. */
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
  side: AnalogSide
): AnalogSeriesExtraction {
  const points: AnalogPoint[] = [];
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

  return {
    points,
    recordsRead: records.length,
    droppedLegacy,
    droppedInvalid,
  };
}

export interface MarketAnalogProjection extends AnalogProjection {
  side: AnalogSide;
  /** Qué se leyó y qué se descartó para construir esta serie. */
  extraction: Omit<AnalogSeriesExtraction, 'points'>;
}

export interface MarketAnalogReport {
  generatedAt: number;
  /** Fuente literal, para que la pantalla no tenga que suponerla. */
  source: 'market_history.json';
  sides: MarketAnalogProjection[];
  /** true si algún lado tiene al menos un horizonte validado. */
  usable: boolean;
}

export interface MarketAnalogOptions {
  horizonsMs?: readonly number[];
  historyTail?: number;
  now?: number;
  /** Inyectable para tests; por defecto lee el histórico persistido. */
  readRecords?: () => readonly HistoryRecord[];
}

const SIDE_LABEL: Record<AnalogSide, string> = {
  BUY: 'Precio estratégico BUY (mediana del ask)',
  SELL: 'Precio estratégico SELL (mediana del bid)',
};

export function buildMarketAnalogProjection(
  options: MarketAnalogOptions = {}
): MarketAnalogReport {
  const read = options.readRecords ?? (() => StorageEngine.getHistory());
  const records = read();
  const now = options.now ?? Date.now();

  const order: AnalogSide[] = ['BUY', 'SELL'];
  const extractions = order.map((side) => extractStrategicSeries(records, side));
  const projections = order.map((side, i) =>
    projectByAnalogy(extractions[i].points, {
      seriesId: `STRATEGIC_${side}`,
      label: SIDE_LABEL[side],
      horizonsMs: options.horizonsMs ?? DEFAULT_HORIZONS_MS,
      historyTail: options.historyTail,
      now,
    })
  );

  /*
   * LA CORRECCIÓN SE APLICA SOBRE LOS DOS LADOS A LA VEZ.
   *
   * La pantalla enseña BUY y SELL juntos, así que quien mira está haciendo
   * todos esos contrastes de una vez y se queda con el que salga bien. Corregir
   * cada lado por separado dejaría entrar precisamente ese sesgo. `projectByAnalogy`
   * ya decidió con su propia familia; esto vuelve a decidir con la familia
   * completa, y es puro: no repite ningún backtest.
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
  }));

  return {
    generatedAt: now,
    source: 'market_history.json',
    sides,
    usable: sides.some((s) => s.usable),
  };
}
