/**
 * D7 — ACUMULACIÓN Y CALIDAD DE HISTORIA REAL
 *
 * D7 no toca la lógica predictiva. Su única pregunta es: ¿se puede AFIRMAR
 * cuánta historia real hay, y es continua?
 *
 * Estos tests recorren la tubería de verdad -captura, persistencia, fallo,
 * rechazo, hueco, reinicio- y comprueban el comportamiento observable, no la
 * existencia de campos. Cada uno describe una situación que ocurre en
 * producción y fija qué debe quedar escrito en el fichero cuando ocurre.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeAdItem, makeBinanceResponse } from './helpers/fixtures.js';
import {
  GAP_TOLERANCE,
  HISTORY_INTERVAL_MS,
  POLLING_INTERVAL_MS,
  buildDatasetHealth,
  lastPersistedMarketStateOf,
} from '../server/datasetHealth.js';
import { MARKET_STATE_VERSION, buildMarketState } from '../server/marketState.js';
import type { HistoryRecord, MarketSnapshot, NormalizedAd } from '../server/types.js';

const T0 = Date.UTC(2026, 8, 10, 18, 0, 0); // 14:00:00 VET

/**
 * Timestamps que la validación debe rechazar en esta ejecución.
 *
 * Un rechazo real es difícil de provocar desde fuera -la validación es
 * estricta justamente para que lo sea-, así que se inyecta. Lo que se prueba
 * no es la validación (ya tiene sus propios tests) sino la REACCIÓN del store
 * a un rechazo: no escribe, cuenta, y no mueve la referencia histórica.
 */
const injectedRejections = new Set<number>();

vi.doMock('../server/recordValidation.js', async () => {
  const actual = await vi.importActual<typeof import('../server/recordValidation.js')>(
    '../server/recordValidation.js'
  );
  return {
    ...actual,
    validateHistoryRecord: (record: HistoryRecord, now?: number) =>
      injectedRejections.has(record?.timestamp)
        ? { ok: false, reasons: ['rechazo inyectado por el test'] }
        : actual.validateHistoryRecord(record, now),
  };
});

const originalCwd = process.cwd();
let tmpDir: string;

type Book = { buyNo: string; buyPrice: string; buyUsdt: string; sellNo: string; sellPrice: string };

const BOOK: Book = {
  buyNo: 'b1',
  buyPrice: '900.00',
  buyUsdt: '500',
  sellNo: 's1',
  sellPrice: '921.00',
};

function stubBinance(current: () => Book) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const book = current();
      const items =
        body.tradeType === 'BUY'
          ? [makeAdItem({ advNo: book.buyNo, price: book.buyPrice, tradable: book.buyUsdt })]
          : [makeAdItem({ advNo: book.sellNo, price: book.sellPrice, tradable: '500' })];
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => makeBinanceResponse(items),
      } as unknown as Response;
    })
  );
}

/** Binance no responde: la petición revienta, como en una caída de red. */
function stubBinanceDown() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('ECONNRESET simulado');
    })
  );
}

/**
 * Arranca un proceso NUEVO sobre el mismo directorio de datos.
 *
 * `resetModules` tira el grafo de módulos entero, así que tanto el store como
 * el StorageEngine vuelven a nacer y releen el fichero: es la simulación fiel
 * de un reinicio de contenedor, no un `new` sobre el mismo estado.
 */
async function bootProcess() {
  vi.resetModules();
  const { CentralMarketStore } = await import('../server/centralStore.js');
  return CentralMarketStore.getInstance();
}

function history(): HistoryRecord[] {
  const file = path.join(tmpDir, 'data', 'market_history.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as HistoryRecord[];
}

beforeEach(() => {
  injectedRejections.clear();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-d7-'));
  process.chdir(tmpDir);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ════════════════════════════════════════════════════════════════════ *
 * 1-3. LA SERIE SE CONSTRUYE A LA CADENCIA DE PERSISTENCIA
 * ════════════════════════════════════════════════════════════════════ */
describe('1-3. primer registro, segundo registro y capturas intermedias', () => {
  it('el primer registro histórico existe y no afirma nada sobre un pasado', async () => {
    stubBinance(() => BOOK);
    const store = await bootProcess();
    await store.pollMarket();

    const records = history();
    expect(records).toHaveLength(1);
    expect(records[0].timestamp).toBe(T0);

    const health = buildDatasetHealth(records);
    expect(health.persistedRecords).toBe(1);
    expect(health.expectedRecords).toBe(1);
    expect(health.coveragePct).toBe(100);
    expect(health.gaps.count).toBe(0);
    expect(health.previousAtContinuity.firstHasNullPrevious).toBe(true);
    expect(health.previousAtContinuity.comparable).toBe(0);
  });

  it('nueve capturas intermedias no se escriben, y el segundo registro llega al minuto', async () => {
    stubBinance(() => BOOK);
    const store = await bootProcess();

    await store.pollMarket(); // 14:00:00 -> se escribe
    for (let i = 1; i <= 9; i += 1) {
      vi.setSystemTime(T0 + i * POLLING_INTERVAL_MS);
      await store.pollMarket(); // 14:00:06 .. 14:00:54 -> NO se escriben
    }
    vi.setSystemTime(T0 + HISTORY_INTERVAL_MS);
    await store.pollMarket(); // 14:01:00 -> se escribe

    const records = history();
    expect(records.map((r) => r.timestamp)).toEqual([T0, T0 + HISTORY_INTERVAL_MS]);

    // El segundo encadena con el primero, no con la captura de las 14:00:54.
    expect(records[1].marketState!.previousAt).toBe(T0);

    const health = buildDatasetHealth(records);
    expect(health.persistedRecords).toBe(2);
    expect(health.expectedRecords).toBe(2);
    expect(health.coveragePct).toBe(100);
    expect(health.gaps.count).toBe(0);
    expect(health.previousAtContinuity.comparable).toBe(1);
    expect(health.previousAtContinuity.continuous).toBe(1);
    expect(health.previousAtContinuity.breaks).toEqual([]);
  });
});

/* ════════════════════════════════════════════════════════════════════ *
 * 4-5. LO QUE NO SE PUDO OBSERVAR NO SE ESCRIBE NI MUEVE LA REFERENCIA
 * ════════════════════════════════════════════════════════════════════ */
describe('4. Binance no responde', () => {
  it('no escribe nada, no rompe la captura y no mueve la referencia histórica', async () => {
    stubBinance(() => BOOK);
    const store = await bootProcess();
    await store.pollMarket(); // 14:00:00 -> se escribe

    // 14:01:00 - tocaba escribir y la red se cae.
    stubBinanceDown();
    vi.setSystemTime(T0 + HISTORY_INTERVAL_MS);
    await store.pollMarket();

    expect(history()).toHaveLength(1);
    expect(store.getCurrentSnapshot().effectiveStatus).not.toBe('LIVE');

    // 14:02:00 - vuelve el mercado, con el líder 1% más caro.
    stubBinance(() => ({ ...BOOK, buyPrice: '909.00', buyUsdt: '600' }));
    vi.setSystemTime(T0 + 2 * HISTORY_INTERVAL_MS);
    await store.pollMarket();

    const records = history();
    expect(records.map((r) => r.timestamp)).toEqual([T0, T0 + 2 * HISTORY_INTERVAL_MS]);

    // Mide contra el último registro REAL, y lo declara.
    const state = records[1].marketState!;
    expect(state.previousAt).toBe(T0);
    expect(state.compra!.leaderPriceDeltaPct).toBeCloseTo(1, 6);
    expect(state.compra!.declaredUsdtDeltaPct).toBeCloseTo(20, 6);

    // El hueco de un minuto NO se rellena: queda medido como tal.
    const health = buildDatasetHealth(records);
    expect(health.gaps.count).toBe(1);
    expect(health.gaps.largest[0]).toMatchObject({
      fromTimestamp: T0,
      toTimestamp: T0 + 2 * HISTORY_INTERVAL_MS,
      missingRecords: 1,
    });
    expect(health.coveragePct).toBeCloseTo(66.67, 1);
  });
});

describe('5. un registro rechazado por validación', () => {
  it('no se escribe, se cuenta, y la referencia histórica no avanza', async () => {
    stubBinance(() => BOOK);
    const store = await bootProcess();
    await store.pollMarket(); // 14:00:00 -> se escribe

    // 14:01:00 - el registro se construye pero la validación lo rechaza.
    injectedRejections.add(T0 + HISTORY_INTERVAL_MS);
    stubBinance(() => ({ ...BOOK, buyPrice: '950.00', buyUsdt: '9000' }));
    vi.setSystemTime(T0 + HISTORY_INTERVAL_MS);
    await store.pollMarket();

    expect(history()).toHaveLength(1);
    expect(store.getCaptureStats().rejectedRecords).toBe(1);
    expect(store.getCaptureStats().rejectedReason).toContain('rechazo inyectado');

    // 14:02:00 - captura buena. Mide contra las 14:00, no contra el rechazado.
    injectedRejections.clear();
    stubBinance(() => ({ ...BOOK, buyPrice: '909.00', buyUsdt: '600' }));
    vi.setSystemTime(T0 + 2 * HISTORY_INTERVAL_MS);
    await store.pollMarket();

    const records = history();
    expect(records.map((r) => r.timestamp)).toEqual([T0, T0 + 2 * HISTORY_INTERVAL_MS]);
    const state = records[1].marketState!;
    expect(state.previousAt).toBe(T0);
    expect(state.compra!.leaderPriceDeltaPct).toBeCloseTo(1, 6);
  });
});

/* ════════════════════════════════════════════════════════════════════ *
 * 6. HUECOS
 * ════════════════════════════════════════════════════════════════════ */
describe('6. un hueco temporal se detecta y se cuantifica', () => {
  it('cinco minutos sin observar dejan un hueco de cuatro registros', async () => {
    stubBinance(() => BOOK);
    const store = await bootProcess();
    await store.pollMarket(); // 14:00:00

    vi.setSystemTime(T0 + 5 * HISTORY_INTERVAL_MS); // 14:05:00
    await store.pollMarket();

    const health = buildDatasetHealth(history());
    expect(health.persistedRecords).toBe(2);
    expect(health.expectedRecords).toBe(6);
    expect(health.coveragePct).toBeCloseTo(33.33, 1);
    expect(health.gaps.count).toBe(1);
    expect(health.gaps.missingRecords).toBe(4);
    expect(health.gaps.largest[0].gapMs).toBe(5 * HISTORY_INTERVAL_MS);
  });

  it('la cadencia normal no se declara hueco, ni siquiera llegando tarde', () => {
    // 66 s: la captura debida llega hasta seis segundos tarde. Eso es normal.
    const late = HISTORY_INTERVAL_MS + POLLING_INTERVAL_MS;
    expect(late).toBeLessThan(HISTORY_INTERVAL_MS * GAP_TOLERANCE);
    const health = buildDatasetHealth([recordAt(T0), recordAt(T0 + late)]);
    expect(health.gaps.count).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════ *
 * 7-9. REINICIO DEL PROCESO Y CONTINUIDAD
 * ════════════════════════════════════════════════════════════════════ */
describe('7-9. reinicio del proceso, recuperación y continuidad de previousAt', () => {
  it('tras reiniciar, el primer registro encadena con el último persistido', async () => {
    stubBinance(() => BOOK);
    const before = await bootProcess();
    await before.pollMarket(); // 14:00:00
    vi.setSystemTime(T0 + HISTORY_INTERVAL_MS);
    await before.pollMarket(); // 14:01:00
    expect(history()).toHaveLength(2);

    // ── El proceso muere y arranca otro sobre el mismo directorio ──
    stubBinance(() => ({ ...BOOK, buyPrice: '909.00', buyUsdt: '600' }));
    vi.setSystemTime(T0 + 2 * HISTORY_INTERVAL_MS);
    const after = await bootProcess();
    await after.pollMarket(); // 14:02:00

    const records = history();
    expect(records.map((r) => r.timestamp)).toEqual([
      T0,
      T0 + HISTORY_INTERVAL_MS,
      T0 + 2 * HISTORY_INTERVAL_MS,
    ]);

    /*
     * LO QUE D7 CORRIGE. Antes de reconstruir la referencia, este registro
     * salía con previousAt=null y los tres deltas en null: una ruptura de la
     * cadena que no ocurrió en el mercado, sino en el contenedor.
     */
    const state = records[2].marketState!;
    expect(state.previousAt).toBe(T0 + HISTORY_INTERVAL_MS);
    expect(state.compra!.leaderChanged).toBe(false);
    expect(state.compra!.leaderPriceDeltaPct).toBeCloseTo(1, 6);
    expect(state.compra!.declaredUsdtDeltaPct).toBeCloseTo(20, 6);
  });

  it('la cadena de previousAt queda íntegra a ambos lados del reinicio', async () => {
    stubBinance(() => BOOK);
    const before = await bootProcess();
    await before.pollMarket();
    vi.setSystemTime(T0 + HISTORY_INTERVAL_MS);
    await before.pollMarket();

    vi.setSystemTime(T0 + 2 * HISTORY_INTERVAL_MS);
    const after = await bootProcess();
    await after.pollMarket();
    vi.setSystemTime(T0 + 3 * HISTORY_INTERVAL_MS);
    await after.pollMarket();

    const health = buildDatasetHealth(history());
    expect(health.persistedRecords).toBe(4);
    expect(health.previousAtContinuity.comparable).toBe(3);
    expect(health.previousAtContinuity.continuous).toBe(3);
    expect(health.previousAtContinuity.breaks).toEqual([]);
    expect(health.previousAtContinuity.firstHasNullPrevious).toBe(true);
    expect(health.coveragePct).toBe(100);
  });

  it('la métrica de continuidad SÍ detecta una cadena rota', () => {
    /*
     * Control negativo: si la métrica no supiera fallar, los dos tests de
     * arriba no demostrarían nada.
     */
    const a = recordAt(T0);
    const b = recordAt(T0 + HISTORY_INTERVAL_MS, { previousAt: null });
    const health = buildDatasetHealth([a, b]);
    expect(health.previousAtContinuity.continuous).toBe(0);
    expect(health.previousAtContinuity.breaks).toEqual([
      {
        timestamp: T0 + HISTORY_INTERVAL_MS,
        expectedPreviousAt: T0,
        actualPreviousAt: null,
      },
    ]);
  });

  it('la reconstrucción se salta los registros sin estado, como hace el proceso vivo', () => {
    const withState = recordAt(T0);
    const legacy = recordAt(T0 + HISTORY_INTERVAL_MS);
    delete legacy.marketState;

    expect(lastPersistedMarketStateOf([withState, legacy])?.capturedAt).toBe(T0);
    expect(lastPersistedMarketStateOf([])).toBeNull();
    expect(lastPersistedMarketStateOf([legacy])).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════════════ *
 * 10. NADA MIRA HACIA ADELANTE
 * ════════════════════════════════════════════════════════════════════ */
describe('10. ausencia de look-ahead', () => {
  it('ningún previousAt apunta a su propio registro ni a uno posterior', async () => {
    stubBinance(() => BOOK);
    const store = await bootProcess();
    for (let i = 0; i < 5; i += 1) {
      vi.setSystemTime(T0 + i * HISTORY_INTERVAL_MS);
      await store.pollMarket();
    }

    const records = history();
    expect(records).toHaveLength(5);
    for (let i = 0; i < records.length; i += 1) {
      const previousAt = records[i].marketState!.previousAt;
      if (i === 0) {
        expect(previousAt).toBeNull();
        continue;
      }
      expect(previousAt).not.toBeNull();
      expect(previousAt!).toBeLessThan(records[i].timestamp);
      // Y es el anterior de la serie, no cualquier instante del pasado.
      expect(previousAt).toBe(records[i - 1].timestamp);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════ *
 * 11-12. COBERTURA POR CELDA Y POR LADO
 * ════════════════════════════════════════════════════════════════════ */
describe('11. cobertura por banco x monto', () => {
  it('cada celda se cuenta por separado, con su propio rango temporal', () => {
    const records = [
      recordAt(T0, { bank: 'BANESCO', amount: 20_000 }),
      recordAt(T0 + HISTORY_INTERVAL_MS, { bank: 'BANESCO', amount: 20_000 }),
      recordAt(T0 + 2 * HISTORY_INTERVAL_MS, { bank: 'BANESCO', amount: 50_000 }),
      recordAt(T0 + 3 * HISTORY_INTERVAL_MS, { bank: 'MERCANTIL', amount: 20_000 }),
      recordAt(T0 + 4 * HISTORY_INTERVAL_MS),
    ];
    const cells = buildDatasetHealth(records).coverageByCell;

    expect(cells).toHaveLength(4);
    expect(cells[0]).toMatchObject({
      bank: 'BANESCO',
      amountBucket: '20K',
      records: 2,
      firstTimestamp: T0,
      lastTimestamp: T0 + HISTORY_INTERVAL_MS,
    });
    expect(cells.find((c) => c.bank === 'BANESCO' && c.amountBucket === '50K')!.records).toBe(1);
    expect(cells.find((c) => c.bank === 'MERCANTIL')!.amountBucket).toBe('20K');
    // La captura general no inventa un banco ni un monto: es su propia celda.
    expect(cells.find((c) => c.bank === 'GENERAL')!.amountBucket).toBe('ALL');
  });

  it('un monto fuera de los tramos conocidos se reporta tal cual, no se encaja a la fuerza', () => {
    const cells = buildDatasetHealth([recordAt(T0, { bank: 'BNC', amount: 37_500 })]).coverageByCell;
    expect(cells[0].amountBucket).toBe('37500');
  });

  it('la serie que produce la captura real cae ENTERA en la celda GENERAL/ALL', async () => {
    stubBinance(() => BOOK);
    const store = await bootProcess();
    await store.pollMarket();
    vi.setSystemTime(T0 + HISTORY_INTERVAL_MS);
    await store.pollMarket();

    /*
     * Hecho medido, no limitación disimulada: hoy sólo se persiste el mercado
     * GENERAL. La matriz banco x monto se consulta en vivo y no llega al
     * histórico, así que la cobertura por celda tiene exactamente una celda.
     * Cuando eso cambie, la métrica ya sabe contarlo -el test de arriba lo
     * demuestra- y el cambio será visible aquí.
     */
    const cells = buildDatasetHealth(history()).coverageByCell;
    expect(cells).toEqual([
      { bank: 'GENERAL', amountBucket: 'ALL', records: 2, firstTimestamp: T0, lastTimestamp: T0 + HISTORY_INTERVAL_MS },
    ]);
  });
});

describe('12. COMPRA y VENTA se cuentan independientemente', () => {
  it('un lado ausente no descuenta al otro, y queda registrado como no medido', () => {
    const ambos = recordAt(T0);
    const soloCompra = recordAt(T0 + HISTORY_INTERVAL_MS, { sellAds: [] });
    const soloVenta = recordAt(T0 + 2 * HISTORY_INTERVAL_MS, { buyAds: [] });

    const health = buildDatasetHealth([ambos, soloCompra, soloVenta]);
    expect(health.marketState.withState).toBe(3);
    expect(health.marketState.withCurrentVersion).toBe(3);
    expect(health.marketState.compraSides).toBe(2);
    expect(health.marketState.ventaSides).toBe(2);

    // La ausencia de un lado se nombra; no se convierte en un cero.
    expect(health.marketState.nullsByField['venta.side']).toBe(1);
    expect(health.marketState.nullsByField['compra.side']).toBe(1);
    expect(health.marketState.withNullMeasurements).toBe(3);
  });

  it('un registro sin estado de mercado se cuenta aparte, no como estado vacío', () => {
    const legacy = recordAt(T0);
    delete legacy.marketState;
    const health = buildDatasetHealth([legacy, recordAt(T0 + HISTORY_INTERVAL_MS)]);
    expect(health.marketState.withState).toBe(1);
    expect(health.marketState.withoutState).toBe(1);
  });
});

/* ════════════════════════════════════════════════════════════════════ *
 * CADENCIAS: UNA SOLA FUENTE
 * ════════════════════════════════════════════════════════════════════ */
describe('las cadencias que mide la métrica son las que usa la captura', () => {
  it('centralStore importa los intervalos en vez de repetir los números', () => {
    const src = fs.readFileSync(path.join(originalCwd, 'server/centralStore.ts'), 'utf-8');
    expect(src).toMatch(/private pollingIntervalMs = POLLING_INTERVAL_MS;/);
    expect(src).toMatch(/private readonly historyIntervalMs = HISTORY_INTERVAL_MS;/);
    expect(HISTORY_INTERVAL_MS).toBe(60_000);
    expect(POLLING_INTERVAL_MS).toBe(6_000);
  });

  it('la salud del dataset no emite ninguna señal de mercado', () => {
    /*
     * Se mira el CÓDIGO, no los comentarios: la cabecera del módulo dice
     * justamente que aquí no hay scores ni probabilidades, y esa frase no
     * puede hacer fallar al test que comprueba lo mismo.
     */
    const src = fs
      .readFileSync(path.join(originalCwd, 'server/datasetHealth.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const forbidden of [/\bscore/i, /\bweight/i, /probabilit/i, /confidence/i, /\bsignal/i]) {
      expect(src).not.toMatch(forbidden);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════ *
 * 13. LAS MÉTRICAS SE PUEDEN OBTENER DE VERDAD
 * ════════════════════════════════════════════════════════════════════ */
describe('13. /api/diagnostics/dataset entrega las métricas por HTTP', () => {
  it('responde con la salud del dataset realmente persistido', async () => {
    stubBinance(() => BOOK);
    const store = await bootProcess();
    await store.pollMarket();
    vi.setSystemTime(T0 + 5 * HISTORY_INTERVAL_MS);
    await store.pollMarket();

    /*
     * Se levanta el router de verdad y se le pregunta por HTTP: que la función
     * calcule bien no sirve de nada si la ruta no la entrega. `fetch` real -el
     * stub se retira antes- contra un puerto efímero.
     */
    vi.unstubAllGlobals();
    const express = (await import('express')).default;
    const { apiRouter } = await import('../server/routes.js');
    const app = express();
    app.use('/api', apiRouter);

    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/dataset`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        dataset: ReturnType<typeof buildDatasetHealth>;
        capture: { rejectedRecords: number };
        storage: { recordCount: number };
        archive: { recordCount: number };
      };

      expect(body.dataset.persistedRecords).toBe(2);
      expect(body.dataset.expectedRecords).toBe(6);
      expect(body.dataset.coveragePct).toBeCloseTo(33.33, 1);
      expect(body.dataset.gaps.count).toBe(1);
      expect(body.dataset.gaps.missingRecords).toBe(4);
      expect(body.dataset.firstTimestamp).toBe(T0);
      expect(body.dataset.lastTimestamp).toBe(T0 + 5 * HISTORY_INTERVAL_MS);
      expect(body.dataset.marketState.withCurrentVersion).toBe(2);
      expect(body.dataset.previousAtContinuity.breaks).toEqual([]);
      expect(body.dataset.coverageByCell[0].bank).toBe('GENERAL');
      // Contadores del proceso y del fichero, separados y ambos presentes.
      expect(body.capture.rejectedRecords).toBe(0);
      expect(body.storage.recordCount).toBe(2);
      expect(body.archive.recordCount).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/* ------------------------------------------------------------------------ *
 * FIXTURES
 *
 * Entradas de test, nunca datos de mercado: no se escriben en ningún fichero
 * real ni se presentan como observaciones. Sirven para provocar formas que la
 * captura real produciría.
 * ------------------------------------------------------------------------ */

function ad(advNo: string, price: number): NormalizedAd {
  return {
    advNo,
    price,
    minAmountVes: 1_000,
    maxAmountVes: 100_000,
    availableUsdt: 500,
    availableUsdtReported: 500,
    merchantName: `nick-${advNo}`,
    userType: 'user',
    ordersCount: 10,
    finishRate: 0.99,
    paymentMethods: ['Banesco'],
    paymentOptions: [{ payType: 'Banesco', tradeMethodName: 'Banesco' }],
  };
}

function recordAt(
  timestamp: number,
  opts: {
    bank?: string;
    amount?: number;
    previousAt?: number | null;
    buyAds?: NormalizedAd[];
    sellAds?: NormalizedAd[];
  } = {}
): HistoryRecord {
  const buyAds = opts.buyAds ?? [ad('b1', 900)];
  const sellAds = opts.sellAds ?? [ad('s1', 921)];
  const snapshot = {
    timestamp,
    status: 'LIVE' as const,
    topBuyAds: buyAds,
    topSellAds: sellAds,
    strategicBuyPrice: 900,
    strategicSellPrice: 921,
    filterBank: opts.bank ?? null,
    filterAmount: opts.amount ?? null,
  } as unknown as MarketSnapshot;

  const state = buildMarketState(snapshot)!;
  expect(state.version).toBe(MARKET_STATE_VERSION);

  return {
    id: `tick-${timestamp}`,
    timestamp,
    dateStr: new Date(timestamp).toISOString(),
    hour: 14,
    buyPrice: 900,
    sellPrice: 921,
    spreadPct: 2.33,
    bestBuyMerchant: 'N/A',
    bestSellMerchant: 'N/A',
    activeBuyAds: buyAds.length,
    activeSellAds: sellAds.length,
    source: 'BINANCE_P2P',
    ...(opts.bank === undefined ? {} : { filterBank: opts.bank }),
    ...(opts.amount === undefined ? {} : { filterAmount: opts.amount }),
    marketState: {
      ...state,
      previousAt: opts.previousAt !== undefined ? opts.previousAt : timestamp - HISTORY_INTERVAL_MS,
    },
  };
}
