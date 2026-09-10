/**
 * SALUD DEL DATASET HISTÓRICO
 * ===========================
 *
 * ═══ QUÉ ES Y QUÉ NO ES ═══
 *
 * Esto NO es una señal, ni un score, ni una probabilidad, ni entra en ninguna
 * proyección. Es exclusivamente una descripción del fichero histórico: cuántas
 * observaciones hay, cuántas debería haber, dónde faltan y qué partes del
 * estado de mercado no se pudieron medir.
 *
 * Existe porque D7 es una fase de ACUMULACIÓN: antes de preguntarle nada al
 * histórico hay que poder afirmar cuánto histórico hay de verdad. Un dataset
 * con un 60% de cobertura y otro con un 99% producen la misma media y no son
 * el mismo experimento, y desde fuera del proceso eran indistinguibles.
 *
 * ═══ AUSENCIA ═══
 *
 * Lo que no se puede calcular vale `null`, jamás 0. Con cero registros no hay
 * "0% de cobertura": no hay cobertura que medir.
 */

import { AMOUNT_TIERS } from './executability.js';
import { MARKET_STATE_VERSION, type MarketStateSnapshot } from './marketState.js';
import type { HistoryRecord } from './types.js';

/**
 * Cadencia real de PERSISTENCIA del histórico, en ms.
 *
 * Vive aquí y `centralStore` la importa, en vez de al revés, porque el número
 * que decide cada cuánto se escribe y el número contra el que se mide la
 * cobertura tienen que ser el MISMO. Dos copias que se separen convertirían la
 * métrica en ficción sin que nadie se enterase.
 */
export const HISTORY_INTERVAL_MS = 60_000;

/**
 * Cadencia real de POLLING, en ms. No es la de persistencia: el mercado se
 * observa diez veces por cada vez que se escribe.
 */
export const POLLING_INTERVAL_MS = 6_000;

/**
 * A partir de qué separación entre dos registros consecutivos se declara hueco.
 *
 * 1.5 intervalos, no 1: la escritura ocurre en la captura DEBIDA, que llega
 * hasta seis segundos tarde, así que una separación de 66 s es la cadencia
 * normal y llamarla hueco sería inventar un problema.
 */
export const GAP_TOLERANCE = 1.5;

export interface DatasetGap {
  fromTimestamp: number;
  toTimestamp: number;
  gapMs: number;
  /** Cuántas observaciones habrían cabido dentro del hueco. */
  missingRecords: number;
}

export interface CellCoverage {
  /** Banco de la consulta, o 'GENERAL' cuando la captura no filtró por banco. */
  bank: string;
  /** Tramo de monto, o 'ALL' cuando la captura no filtró por monto. */
  amountBucket: string;
  records: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface ContinuityBreak {
  /** Registro cuyo `previousAt` no apunta al estado anterior. */
  timestamp: number;
  expectedPreviousAt: number;
  actualPreviousAt: number | null;
}

export interface DatasetHealth {
  /** Cadencias contra las que se mide todo lo demás. */
  historyIntervalMs: number;
  pollingIntervalMs: number;

  persistedRecords: number;
  /** Cuántos cabrían entre el primero y el último a la cadencia declarada. */
  expectedRecords: number | null;
  /** persistidos/esperados en %. Puede pasar de 100 tras un reinicio. */
  coveragePct: number | null;

  firstTimestamp: number | null;
  lastTimestamp: number | null;
  spanMs: number | null;

  gaps: {
    count: number;
    missingRecords: number;
    /** Los mayores primero. La lista se recorta; `count` no. */
    largest: DatasetGap[];
  };
  /**
   * Separaciones MENORES de medio intervalo. No son huecos: son registros más
   * juntos de lo previsto, típicamente el primero tras un reinicio.
   */
  shortIntervals: number;

  marketState: {
    withState: number;
    withCurrentVersion: number;
    withoutState: number;
    /** Estados en los que ese lado pudo describirse. Se cuentan por separado. */
    compraSides: number;
    ventaSides: number;
    /** Estados con AL MENOS una medición sin valor. */
    withNullMeasurements: number;
    /** Cuántas veces quedó sin medir cada campo. */
    nullsByField: Record<string, number>;
  };

  previousAtContinuity: {
    /** Pares consecutivos de estados que se pueden comparar. */
    comparable: number;
    continuous: number;
    breaks: ContinuityBreak[];
    /** El primer estado de la serie no puede tener pasado: debe ser null. */
    firstHasNullPrevious: boolean | null;
  };

  coverageByCell: CellCoverage[];
}

/* ------------------------------------------------------------------------ *
 * CONTINUIDAD TRAS UN REINICIO
 * ------------------------------------------------------------------------ */

/**
 * El último estado de mercado que llegó a persistirse.
 *
 * Se usa al arrancar para reconstruir `lastPersistedMarketState`, que en
 * memoria se perdía con el proceso: sin esto, el primer registro tras cada
 * reinicio declaraba `previousAt: null` y rompía la cadena del histórico por
 * un motivo que no ocurrió en el mercado, sino en el contenedor.
 *
 * Recorre hacia atrás y se queda con el primero que lleve estado, que es
 * EXACTAMENTE la regla que sigue el proceso en marcha: un registro sin
 * `marketState` no mueve la referencia. Determinista y sin heurística.
 */
export function lastPersistedMarketStateOf(
  records: readonly HistoryRecord[]
): MarketStateSnapshot | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const state = records[i]?.marketState;
    if (state !== undefined) return state;
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * MÉTRICAS
 * ------------------------------------------------------------------------ */

/** Campos de un lado cuya ausencia se cuenta, con el nombre con que se reporta. */
const SIDE_MEASUREMENTS = [
  'leaderPrice',
  'leaderGapPct',
  'leaderKey',
  'declaredUsdt',
  'priceP10',
  'priceP50',
  'priceP90',
  'priceRangePct',
  'leaderChanged',
  'declaredUsdtDeltaPct',
  'leaderPriceDeltaPct',
] as const;

function amountBucketOf(amount: number | null | undefined): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return 'ALL';
  const tier = AMOUNT_TIERS.find((t) => t.val === amount);
  return tier ? tier.key : String(amount);
}

function bankOf(record: HistoryRecord): string {
  return record.filterBank ?? record.marketState?.filterBank ?? 'GENERAL';
}

function amountOf(record: HistoryRecord): number | null {
  return record.filterAmount ?? record.marketState?.filterAmountVes ?? null;
}

/**
 * Describe el histórico persistido. No lo modifica y no decide nada sobre él.
 *
 * `records` debe llegar ordenado por timestamp, que es como el almacenamiento
 * lo mantiene. Se ordena una copia de todos modos: una métrica de continuidad
 * que dependa del orden de entrada no mide el dataset, mide a quien la llama.
 */
export function buildDatasetHealth(
  records: readonly HistoryRecord[],
  opts: { historyIntervalMs?: number; maxGapsListed?: number } = {}
): DatasetHealth {
  const interval = opts.historyIntervalMs ?? HISTORY_INTERVAL_MS;
  const maxGapsListed = opts.maxGapsListed ?? 20;
  const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp);

  const first = sorted[0]?.timestamp ?? null;
  const last = sorted[sorted.length - 1]?.timestamp ?? null;
  const spanMs = first !== null && last !== null ? last - first : null;

  /* ── Cobertura temporal ────────────────────────────────────────────── */
  const expectedRecords = spanMs === null ? null : Math.floor(spanMs / interval) + 1;
  const coveragePct =
    expectedRecords === null || expectedRecords <= 0
      ? null
      : Number(((sorted.length / expectedRecords) * 100).toFixed(2));

  /* ── Huecos ────────────────────────────────────────────────────────── */
  const gaps: DatasetGap[] = [];
  let shortIntervals = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const gapMs = sorted[i].timestamp - sorted[i - 1].timestamp;
    if (gapMs > interval * GAP_TOLERANCE) {
      gaps.push({
        fromTimestamp: sorted[i - 1].timestamp,
        toTimestamp: sorted[i].timestamp,
        gapMs,
        missingRecords: Math.max(0, Math.round(gapMs / interval) - 1),
      });
    } else if (gapMs < interval / 2) {
      shortIntervals += 1;
    }
  }

  /* ── Estado de mercado ─────────────────────────────────────────────── */
  const nullsByField: Record<string, number> = {};
  const countNull = (key: string) => {
    nullsByField[key] = (nullsByField[key] ?? 0) + 1;
  };

  let withState = 0;
  let withCurrentVersion = 0;
  let compraSides = 0;
  let ventaSides = 0;
  let withNullMeasurements = 0;

  for (const record of sorted) {
    const state = record.marketState;
    if (state === undefined) continue;
    withState += 1;
    if (state.version === MARKET_STATE_VERSION) withCurrentVersion += 1;
    if (state.compra !== null) compraSides += 1;
    if (state.venta !== null) ventaSides += 1;

    let sawNull = false;
    for (const [leg, side] of [
      ['compra', state.compra],
      ['venta', state.venta],
    ] as const) {
      if (side === null) {
        countNull(`${leg}.side`);
        sawNull = true;
        continue;
      }
      for (const field of SIDE_MEASUREMENTS) {
        if (side[field] === null) {
          countNull(`${leg}.${field}`);
          sawNull = true;
        }
      }
      for (const level of side.depth) {
        if (level.usdt === null) {
          countNull(`${leg}.depth@${level.pct}%`);
          sawNull = true;
        }
      }
    }
    if (sawNull) withNullMeasurements += 1;
  }

  /* ── Continuidad de previousAt ─────────────────────────────────────── */
  const stateful = sorted.filter((r) => r.marketState !== undefined);
  const breaks: ContinuityBreak[] = [];
  let continuous = 0;
  for (let i = 1; i < stateful.length; i += 1) {
    const expected = stateful[i - 1].timestamp;
    const actual = stateful[i].marketState!.previousAt;
    if (actual === expected) continuous += 1;
    else
      breaks.push({
        timestamp: stateful[i].timestamp,
        expectedPreviousAt: expected,
        actualPreviousAt: actual,
      });
  }

  /* ── Cobertura por celda ───────────────────────────────────────────── */
  const cells = new Map<string, CellCoverage>();
  for (const record of sorted) {
    const bank = bankOf(record);
    const amountBucket = amountBucketOf(amountOf(record));
    const key = `${bank}|${amountBucket}`;
    const cell = cells.get(key);
    if (cell === undefined) {
      cells.set(key, {
        bank,
        amountBucket,
        records: 1,
        firstTimestamp: record.timestamp,
        lastTimestamp: record.timestamp,
      });
    } else {
      cell.records += 1;
      cell.lastTimestamp = record.timestamp;
    }
  }

  return {
    historyIntervalMs: interval,
    pollingIntervalMs: POLLING_INTERVAL_MS,
    persistedRecords: sorted.length,
    expectedRecords,
    coveragePct,
    firstTimestamp: first,
    lastTimestamp: last,
    spanMs,
    gaps: {
      count: gaps.length,
      missingRecords: gaps.reduce((acc, g) => acc + g.missingRecords, 0),
      largest: [...gaps].sort((a, b) => b.gapMs - a.gapMs).slice(0, maxGapsListed),
    },
    shortIntervals,
    marketState: {
      withState,
      withCurrentVersion,
      withoutState: sorted.length - withState,
      compraSides,
      ventaSides,
      withNullMeasurements,
      nullsByField,
    },
    previousAtContinuity: {
      comparable: Math.max(0, stateful.length - 1),
      continuous,
      breaks,
      firstHasNullPrevious:
        stateful.length === 0 ? null : stateful[0].marketState!.previousAt === null,
    },
    coverageByCell: [...cells.values()].sort(
      (a, b) => b.records - a.records || a.bank.localeCompare(b.bank)
    ),
  };
}
