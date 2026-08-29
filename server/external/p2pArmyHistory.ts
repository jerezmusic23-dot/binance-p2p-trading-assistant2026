/**
 * VALIDACIÓN DE UN LOTE HISTÓRICO DE P2P.ARMY
 * ===========================================
 *
 * Toma la respuesta cruda del endpoint de histórico y responde, con números, si
 * sirve: cuántos registros, qué rango, si están ordenados, si hay duplicados,
 * si hay huecos, y si algún valor es imposible.
 *
 * ═══ TOLERANTE CON LA FORMA, ESTRICTO CON LOS VALORES ═══
 *
 * Los nombres exactos de los campos de p2p.army no están verificados, así que
 * este módulo NO los da por supuestos: busca entre varios candidatos y publica
 * CUÁLES encontró (`detectedFields`). Si mañana el proveedor los llama de otra
 * forma, esto lo dice en vez de devolver una serie vacía en silencio, que es
 * el fallo caro.
 *
 * Con los valores, en cambio, no hay tolerancia ninguna: un precio no finito,
 * negativo o cero se descarta con su motivo, igual que en la captura propia.
 */

export interface HistoryPoint {
  t: number;
  buy: number | null;
  buyAvg: number | null;
  sell: number | null;
  sellAvg: number | null;
}

export interface HistoryValidation {
  /** Registros que venían en el cuerpo, antes de filtrar. */
  rowsReceived: number;
  points: HistoryPoint[];
  rejected: number;
  rejectionReasons: string[];

  /** Qué nombre de campo se encontró para cada dato, o null. */
  detectedFields: {
    timestamp: string | null;
    buy: string | null;
    buyAvg: string | null;
    sell: string | null;
    sellAvg: string | null;
    volume: string | null;
    ads: string | null;
    spread: string | null;
  };

  /**
   * TODAS las claves del primer registro, con su tipo y un ejemplo.
   *
   * Es lo que responde de verdad a "¿qué variables históricas tenemos?": si
   * p2p.army sólo entrega precios agregados, aquí se verá que no hay ni
   * volumen ni número de anuncios, en vez de deducirlo del silencio.
   *
   * Los valores de texto se anonimizan: pueden traer nombres de comerciante.
   */
  schemaSummary: { key: string; type: string; example: string }[];

  firstTimestamp: number | null;
  lastTimestamp: number | null;
  spanHours: number | null;

  /** Comprobaciones que el propietario pidió explícitamente. */
  chronological: boolean;
  duplicateTimestamps: number;
  medianIntervalMs: number | null;
  /** Huecos mayores que 1.5x la cadencia mediana. */
  gaps: { at: number; gapMs: number }[];
  nonFiniteValues: number;

  /** Cobertura real frente a la esperada por la cadencia. */
  expectedPoints: number | null;
  coveragePct: number | null;
}

/** Candidatos por campo, del más probable al menos. */
const FIELD_CANDIDATES = {
  timestamp: ['timestamp', 'time', 'date', 'datetime', 'created_at', 'ts', 'dt'],
  buy: ['buy', 'buy_price', 'buyPrice', 'price_buy'],
  buyAvg: ['buy_avg', 'buyAvg', 'avg_buy', 'buy_average'],
  sell: ['sell', 'sell_price', 'sellPrice', 'price_sell'],
  sellAvg: ['sell_avg', 'sellAvg', 'avg_sell', 'sell_average'],
  volume: ['volume', 'vol', 'amount', 'total_volume', 'liquidity', 'available'],
  ads: ['ads', 'ads_count', 'adsCount', 'orders', 'orders_count', 'count', 'offers'],
  spread: ['spread', 'spread_pct', 'spreadPct', 'spread_percent'],
} as const;

function findField(sample: Record<string, unknown>, candidates: readonly string[]): string | null {
  for (const name of candidates) {
    if (Object.prototype.hasOwnProperty.call(sample, name)) return name;
  }
  return null;
}

/**
 * Extrae el array de registros del cuerpo.
 *
 * Las APIs envuelven de formas distintas: el array pelado, `{data:[...]}`,
 * `{result:[...]}`. Se prueban las tres en vez de exigir una.
 */
export function extractRows(body: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body !== null && typeof body === 'object') {
    for (const key of ['data', 'result', 'results', 'items', 'prices', 'history']) {
      const value = (body as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as Record<string, unknown>[];
    }
  }
  return null;
}

/** Interpreta un timestamp en segundos, milisegundos o ISO 8601. */
export function parseTimestamp(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Menos de 10^12 es casi seguro segundos: 10^12 ms son ya el año 2001.
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && raw.trim() !== '') {
      return asNumber < 1e12 ? asNumber * 1000 : asNumber;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parsePrice(raw: unknown): { value: number | null; bad: boolean } {
  if (raw === null || raw === undefined || raw === '') return { value: null, bad: false };
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return { value: null, bad: true };
  if (n <= 0) return { value: null, bad: true };
  return { value: n, bad: false };
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const GAP_TOLERANCE_MULTIPLE = 1.5;

/**
 * Describe el esquema real de un registro sin exponer su contenido.
 *
 * Los números y booleanos se muestran tal cual —no identifican a nadie— pero
 * las cadenas se reducen a su tipo y longitud: un campo de texto en una
 * respuesta P2P puede ser el nick de un comerciante, y esto acaba en los logs
 * de Railway.
 */
export function summariseSchema(
  sample: Record<string, unknown>
): { key: string; type: string; example: string }[] {
  return Object.entries(sample).map(([key, value]) => {
    if (value === null) return { key, type: 'null', example: 'null' };
    if (typeof value === 'number' || typeof value === 'boolean') {
      return { key, type: typeof value, example: String(value) };
    }
    if (typeof value === 'string') {
      // Fechas y números en texto son seguros y útiles de ver.
      if (Number.isFinite(Number(value)) || Number.isFinite(Date.parse(value))) {
        return { key, type: 'string(numérico/fecha)', example: value };
      }
      return { key, type: 'string', example: `<texto, ${value.length} car.>` };
    }
    if (Array.isArray(value)) return { key, type: `array[${value.length}]`, example: '[…]' };
    return { key, type: typeof value, example: '{…}' };
  });
}

export function validateHistoryBatch(body: unknown): HistoryValidation {
  const empty: HistoryValidation = {
    rowsReceived: 0,
    points: [],
    rejected: 0,
    rejectionReasons: [],
    detectedFields: {
      timestamp: null,
      buy: null,
      buyAvg: null,
      sell: null,
      sellAvg: null,
      volume: null,
      ads: null,
      spread: null,
    },
    schemaSummary: [],
    firstTimestamp: null,
    lastTimestamp: null,
    spanHours: null,
    chronological: true,
    duplicateTimestamps: 0,
    medianIntervalMs: null,
    gaps: [],
    nonFiniteValues: 0,
    expectedPoints: null,
    coveragePct: null,
  };

  const rows = extractRows(body);
  if (rows === null) {
    return { ...empty, rejectionReasons: ['el cuerpo no contiene ningún array de registros'] };
  }
  if (rows.length === 0) return { ...empty, rowsReceived: 0 };

  const sample = rows[0] ?? {};
  const detectedFields = {
    timestamp: findField(sample, FIELD_CANDIDATES.timestamp),
    buy: findField(sample, FIELD_CANDIDATES.buy),
    buyAvg: findField(sample, FIELD_CANDIDATES.buyAvg),
    sell: findField(sample, FIELD_CANDIDATES.sell),
    sellAvg: findField(sample, FIELD_CANDIDATES.sellAvg),
    volume: findField(sample, FIELD_CANDIDATES.volume),
    ads: findField(sample, FIELD_CANDIDATES.ads),
    spread: findField(sample, FIELD_CANDIDATES.spread),
  };
  const schemaSummary = summariseSchema(sample);

  const reasons = new Set<string>();
  if (detectedFields.timestamp === null) {
    reasons.add(
      `sin campo de tiempo reconocible; claves presentes: ${Object.keys(sample).join(', ')}`
    );
    return {
      ...empty,
      rowsReceived: rows.length,
      detectedFields,
      schemaSummary,
      rejectionReasons: [...reasons],
    };
  }

  const points: HistoryPoint[] = [];
  let rejected = 0;
  let nonFiniteValues = 0;

  for (const row of rows) {
    const t = parseTimestamp(row[detectedFields.timestamp]);
    if (t === null) {
      rejected += 1;
      reasons.add('timestamp ilegible');
      continue;
    }

    const read = (field: string | null) => {
      if (field === null) return null;
      const { value, bad } = parsePrice(row[field]);
      if (bad) {
        nonFiniteValues += 1;
        reasons.add(`valor imposible en ${field}`);
      }
      return value;
    };

    const point: HistoryPoint = {
      t,
      buy: read(detectedFields.buy),
      buyAvg: read(detectedFields.buyAvg),
      sell: read(detectedFields.sell),
      sellAvg: read(detectedFields.sellAvg),
    };

    // Una fila sin ni un precio utilizable no aporta nada.
    if (point.buy === null && point.buyAvg === null && point.sell === null && point.sellAvg === null) {
      rejected += 1;
      reasons.add('fila sin ningún precio utilizable');
      continue;
    }
    points.push(point);
  }

  // El orden se comprueba TAL COMO LLEGÓ, antes de tocarlo: si el proveedor lo
  // envía al revés hay que saberlo, no arreglarlo en silencio.
  let chronological = true;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].t < points[i - 1].t) {
      chronological = false;
      break;
    }
  }

  const sorted = [...points].sort((a, b) => a.t - b.t);
  let duplicateTimestamps = 0;
  const gaps: { at: number; gapMs: number }[] = [];
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const delta = sorted[i].t - sorted[i - 1].t;
    if (delta === 0) duplicateTimestamps += 1;
    else intervals.push(delta);
  }

  const medianIntervalMs = medianOf(intervals);
  if (medianIntervalMs !== null) {
    const tolerance = medianIntervalMs * GAP_TOLERANCE_MULTIPLE;
    for (let i = 1; i < sorted.length; i += 1) {
      const delta = sorted[i].t - sorted[i - 1].t;
      if (delta > tolerance) gaps.push({ at: sorted[i - 1].t, gapMs: delta });
    }
  }

  const first = sorted.length > 0 ? sorted[0].t : null;
  const last = sorted.length > 0 ? sorted[sorted.length - 1].t : null;
  const spanMs = first !== null && last !== null ? last - first : null;
  const expectedPoints =
    spanMs !== null && medianIntervalMs !== null && medianIntervalMs > 0
      ? Math.floor(spanMs / medianIntervalMs) + 1
      : null;

  return {
    rowsReceived: rows.length,
    points: sorted,
    rejected,
    rejectionReasons: [...reasons],
    detectedFields,
    schemaSummary,
    firstTimestamp: first,
    lastTimestamp: last,
    spanHours: spanMs === null ? null : spanMs / 3_600_000,
    chronological,
    duplicateTimestamps,
    medianIntervalMs,
    gaps,
    nonFiniteValues,
    expectedPoints,
    coveragePct:
      expectedPoints !== null && expectedPoints > 0
        ? Math.min(100, (sorted.length / expectedPoints) * 100)
        : null,
  };
}
