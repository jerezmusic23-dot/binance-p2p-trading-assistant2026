/**
 * SERIES EXTERNAS DE REFERENCIA (usdt.com.ve)
 * ===========================================
 *
 * Lee el dataset público USDT/VES de usdt.com.ve (CC-BY-4.0) y lo expone como
 * serie temporal. Sirve para dar CONTEXTO DE RÉGIMEN a un histórico propio que
 * todavía es corto.
 *
 * ═══ NO SE MEZCLA CON NUESTRA SERIE. NUNCA. ═══
 *
 * Ésta es la regla que gobierna el archivo entero, y no es cautela: es que los
 * dos números miden cosas distintas.
 *
 *   NUESTRO strategicBuyPrice   mediana del TOP 20 del libro, filtrado por
 *                               banco y por importe, con verificación de
 *                               ejecutabilidad.
 *   SU buy_rate                 "mediana de las primeras ofertas de vendedores
 *                               verificados" (según su propia documentación),
 *                               sin banco, sin importe y sin profundidad.
 *
 * Concatenarlas produciría una serie cuyos saltos no son movimientos del
 * mercado sino cambios de estimador. El proyecto ya separa por este motivo los
 * extremos crudos del libro de las medianas estratégicas; esto es el mismo
 * principio aplicado a una fuente de fuera.
 *
 * ═══ ADVERTENCIA MEDIDA SOBRE SU PAR buy/sell ═══
 *
 * En nuestra convención el ask (BUY, lo que pago por USDT) está SIEMPRE por
 * encima del bid (SELL, lo que me pagan). En este dataset, sobre las 343
 * observaciones de Binance del fichero de referencia:
 *
 *   buy_rate > sell_rate   en el 60% de las filas
 *   sell_rate > buy_rate   en el 37%
 *   iguales                en el 3%
 *
 * Un ask y un bid reales no se cruzan el 37% del tiempo. Sus dos columnas NO
 * son un par ask/bid limpio, así que aquí se exponen con nombres neutros
 * (`buyRate` / `sellRate`) y NO se mapean a nuestra semántica BUY/SELL. Quien
 * las use debe saber que son dos estimadores del nivel del mercado, no las dos
 * puntas de un libro.
 *
 * (Bybit, en el mismo fichero, sí es consistente: buy > sell en el 100%.)
 */

import type { SeriesPoint } from './projection/index.js';

export type ExternalSource = 'binance' | 'bybit' | 'bcv';
export type ExternalField = 'buyRate' | 'sellRate';

export interface ExternalSeries {
  source: ExternalSource;
  field: ExternalField;
  /** Etiqueta honesta sobre qué es este número. */
  label: string;
  points: SeriesPoint[];
}

export interface ExternalDatasetReport {
  /** Filas leídas del fichero, sin contar cabecera ni comentarios. */
  rowsRead: number;
  rowsRejected: number;
  rejectionReasons: string[];
  series: ExternalSeries[];
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  /** Cadencia mediana observada, medida y no supuesta. */
  medianIntervalMs: number | null;
  attribution: string;
}

const ATTRIBUTION =
  'usdt.com.ve, "USDT/VES Historical Rate Dataset", CC-BY-4.0, https://www.usdt.com.ve/datos';

const LABELS: Record<string, string> = {
  'binance:buyRate': 'usdt.com.ve · Binance P2P · buy_rate (mediana de primeras ofertas)',
  'binance:sellRate': 'usdt.com.ve · Binance P2P · sell_rate (mediana de primeras ofertas)',
  'bybit:buyRate': 'usdt.com.ve · Bybit P2P · buy_rate',
  'bybit:sellRate': 'usdt.com.ve · Bybit P2P · sell_rate',
  'bcv:buyRate': 'usdt.com.ve · BCV · tasa oficial (diaria, constante intradía)',
  'bcv:sellRate': 'usdt.com.ve · BCV · sell_rate (ausente en el dataset)',
};

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Parsea el CSV. Formato declarado en su cabecera de comentarios:
 *   captured_at (ISO 8601 UTC), source (binance|bybit|bcv), buy_rate, sell_rate
 *
 * Las líneas que empiezan por `#` son metadatos suyos y se saltan. Cualquier
 * fila que no se pueda afirmar se DESCARTA con su motivo: igual que en la
 * captura propia, un hueco honesto es preferible a un valor inventado.
 */
export function parseUsdtVeCsv(text: string): ExternalDatasetReport {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.startsWith('#'));

  const empty: ExternalDatasetReport = {
    rowsRead: 0,
    rowsRejected: 0,
    rejectionReasons: [],
    series: [],
    firstTimestamp: null,
    lastTimestamp: null,
    medianIntervalMs: null,
    attribution: ATTRIBUTION,
  };
  if (lines.length < 2) return empty;

  const header = lines[0].split(',').map((h) => h.trim());
  const idx = {
    t: header.indexOf('captured_at'),
    source: header.indexOf('source'),
    buy: header.indexOf('buy_rate'),
    sell: header.indexOf('sell_rate'),
  };
  if (idx.t < 0 || idx.source < 0) {
    return { ...empty, rejectionReasons: ['cabecera sin captured_at o source'] };
  }

  const buckets = new Map<string, SeriesPoint[]>();
  const reasons = new Set<string>();
  let rowsRead = 0;
  let rowsRejected = 0;

  for (const line of lines.slice(1)) {
    rowsRead += 1;
    const cells = line.split(',');
    const t = Date.parse(cells[idx.t]);
    const source = (cells[idx.source] ?? '').trim() as ExternalSource;

    if (!Number.isFinite(t)) {
      rowsRejected += 1;
      reasons.add('timestamp ilegible');
      continue;
    }
    if (source !== 'binance' && source !== 'bybit' && source !== 'bcv') {
      rowsRejected += 1;
      reasons.add(`fuente desconocida: ${source}`);
      continue;
    }

    let kept = false;
    for (const [field, column] of [
      ['buyRate', idx.buy],
      ['sellRate', idx.sell],
    ] as [ExternalField, number][]) {
      if (column < 0) continue;
      const raw = (cells[column] ?? '').trim();
      // `null` literal es como el dataset marca el lado ausente del BCV.
      if (raw === '' || raw === 'null') continue;

      const price = Number(raw);
      if (!Number.isFinite(price) || price <= 0) {
        reasons.add(`precio imposible en ${source}.${field}`);
        continue;
      }
      const key = `${source}:${field}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push({ t, price });
      kept = true;
    }
    if (!kept) rowsRejected += 1;
  }

  const series: ExternalSeries[] = [...buckets.entries()]
    .map(([key, points]) => {
      const [source, field] = key.split(':') as [ExternalSource, ExternalField];
      points.sort((a, b) => a.t - b.t);
      return { source, field, label: LABELS[key] ?? key, points };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const all = series.flatMap((s) => s.points.map((p) => p.t)).sort((a, b) => a - b);
  const reference = series.find((s) => s.source === 'binance')?.points ?? [];
  const gaps: number[] = [];
  for (let i = 1; i < reference.length; i += 1) {
    const gap = reference[i].t - reference[i - 1].t;
    if (gap > 0) gaps.push(gap);
  }

  return {
    rowsRead,
    rowsRejected,
    rejectionReasons: [...reasons],
    series,
    firstTimestamp: all.length > 0 ? all[0] : null,
    lastTimestamp: all.length > 0 ? all[all.length - 1] : null,
    medianIntervalMs: medianOf(gaps),
    attribution: ATTRIBUTION,
  };
}

/**
 * Días DISTINTOS observados para cada hora del día, en hora de Venezuela.
 *
 * Es LA medida que decide si se puede construir un perfil intradía ("¿qué
 * suele pasar a las 3 de la tarde?"). Un perfil por hora necesita muchas
 * instancias de esa hora; con una sola no hay patrón, hay una anécdota. Se
 * publica para que la respuesta sea un número y no una impresión.
 */
export function daysPerHourOfDay(points: readonly SeriesPoint[]): number[] {
  const perHour: Set<string>[] = Array.from({ length: 24 }, () => new Set<string>());

  for (const p of points) {
    if (!Number.isFinite(p.t)) continue;
    // Venezuela es UTC-4 todo el año: no hay horario de verano que corregir.
    const local = new Date(p.t - 4 * 3600 * 1000);
    perHour[local.getUTCHours()].add(local.toISOString().slice(0, 10));
  }

  return perHour.map((days) => days.size);
}
