/**
 * D6 — TEMPORALIDAD DEL ESTADO DE MERCADO PERSISTIDO
 *
 * ═══ EL DEFECTO QUE FIJAN ESTOS TESTS ═══
 *
 * El polling observa cada ~6 s; el histórico se escribe cada ~60 s. El estado
 * de mercado medía sus cambios -rotación del líder, variación de liquidez,
 * variación del precio líder- contra "la captura anterior", que casi siempre
 * era una captura intermedia que NADIE guardó.
 *
 * Resultado: un registro de las 14:01 podía llevar deltas de seis segundos, y
 * la misma columna del histórico significaba una ventana temporal distinta
 * según cuántas capturas intermedias hubiese habido. No era look-ahead -jamás
 * se miró hacia adelante- pero una variable cuya ventana cambia sin avisar no
 * se puede estudiar, y estudiar es justo lo que D6 existe para permitir.
 *
 * ═══ LA REGLA QUE SE FIJA AQUÍ ═══
 *
 * El `marketState` que viaja en un HistoryRecord compara SIEMPRE contra el
 * estado del último registro HISTÓRICO PERSISTIDO. La observación en vivo no
 * desaparece: vive aparte, en `getLiveMarketState()`, con su cadencia de ~6 s.
 *
 *   14:00:00  registro persistido   previousAt = null
 *   14:00:06  captura en vivo       la referencia histórica NO se mueve
 *   14:00:12  captura en vivo       la referencia histórica NO se mueve
 *   ...
 *   14:01:00  registro persistido   previousAt = 14:00:00
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeAdItem, makeBinanceResponse } from './helpers/fixtures.js';
import type { HistoryRecord } from '../server/types.js';

const T0 = Date.UTC(2026, 8, 10, 18, 0, 0); // 14:00:00 VET

const originalCwd = process.cwd();
let tmpDir: string;

/** Libro de un anuncio por lado, para que la identidad del líder sea evidente. */
type Book = { buyNo: string; buyPrice: string; buyUsdt: string; sellNo: string; sellPrice: string };

/**
 * Devuelve el libro que `current()` diga EN EL MOMENTO de la llamada, de modo
 * que cada captura pueda ver un mercado distinto sin re-stubbear.
 */
function stubBinanceDynamic(current: () => Book) {
  const mock = vi.fn(async (_url: string, init: RequestInit) => {
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
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Una captura que no describe un mercado: el lado COMPRA llega vacío. */
function stubBinanceBuySideEmpty() {
  const mock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const items = body.tradeType === 'BUY' ? [] : [makeAdItem({ advNo: 's1', price: '921.00' })];
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => makeBinanceResponse(items),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function freshStore() {
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-temporality-'));
  process.chdir(tmpDir);
  // Sólo se falsea Date: los `await` de la captura siguen resolviéndose solos.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('1. la primera captura persistida no puede afirmar nada sobre un pasado', () => {
  it('previousAt, leaderChanged y los deltas son null, no cero', async () => {
    stubBinanceDynamic(() => ({
      buyNo: 'b1',
      buyPrice: '900.00',
      buyUsdt: '500',
      sellNo: 's1',
      sellPrice: '921.00',
    }));
    const store = await freshStore();
    await store.pollMarket();

    const [record] = history();
    const state = record.marketState!;

    expect(state.previousAt).toBeNull();
    for (const side of [state.compra!, state.venta!]) {
      expect(side.leaderChanged).toBeNull();
      expect(side.declaredUsdtDeltaPct).toBeNull();
      expect(side.leaderPriceDeltaPct).toBeNull();
    }
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('2-4. el registro compara contra el registro anterior, no contra la captura de 6 s', () => {
  /**
   * Corre la secuencia del enunciado: un registro a las 14:00:00, nueve
   * capturas en vivo cada 6 s con un mercado MUY distinto, y un registro a las
   * 14:01:00. Si la referencia fuese la captura intermedia, los números del
   * segundo registro serían otros, y se comprueba que no lo son.
   */
  async function runSequence() {
    let book: Book = {
      buyNo: 'b-historico',
      buyPrice: '900.00',
      buyUsdt: '500',
      sellNo: 's1',
      sellPrice: '921.00',
    };
    stubBinanceDynamic(() => book);
    const store = await freshStore();

    // 14:00:00 - se persiste.
    await store.pollMarket();

    // 14:00:06 .. 14:00:54 - capturas en vivo con OTRO líder y OTRA liquidez.
    for (let i = 1; i <= 9; i += 1) {
      book = {
        buyNo: 'b-intermedio',
        buyPrice: '990.00',
        buyUsdt: '4000',
        sellNo: 's1',
        sellPrice: '921.00',
      };
      vi.setSystemTime(T0 + i * 6_000);
      await store.pollMarket();
    }

    // 14:01:00 - se persiste. Vuelve el líder histórico, con +1% de precio.
    book = {
      buyNo: 'b-historico',
      buyPrice: '909.00',
      buyUsdt: '600',
      sellNo: 's1',
      sellPrice: '921.00',
    };
    vi.setSystemTime(T0 + 60_000);
    await store.pollMarket();

    return store;
  }

  it('las capturas intermedias no se escriben: el histórico tiene dos registros', async () => {
    await runSequence();
    const records = history();
    expect(records.map((r) => r.timestamp)).toEqual([T0, T0 + 60_000]);
  });

  it('previousAt es EXACTAMENTE el timestamp del registro histórico anterior', async () => {
    await runSequence();
    const records = history();
    expect(records[0].marketState!.previousAt).toBeNull();
    expect(records[1].marketState!.previousAt).toBe(records[0].timestamp);
    expect(records[1].marketState!.previousAt).toBe(T0);
    // Y NO el de ninguna de las nueve capturas intermedias.
    for (let i = 1; i <= 9; i += 1) {
      expect(records[1].marketState!.previousAt).not.toBe(T0 + i * 6_000);
    }
  });

  it('los deltas miden 60 s de mercado, no 6 s', async () => {
    await runSequence();
    const compra = history()[1].marketState!.compra!;

    // 900 -> 909 es +1% contra el registro anterior.
    // Contra la captura intermedia (990) habría sido -8.18%.
    expect(compra.leaderPriceDeltaPct).toBeCloseTo(1, 6);

    // 500 -> 600 es +20% contra el registro anterior.
    // Contra la captura intermedia (4000) habría sido -85%.
    expect(compra.declaredUsdtDeltaPct).toBeCloseTo(20, 6);
  });

  it('leaderChanged compara identidades históricas: el ir y venir intermedio no cuenta', async () => {
    await runSequence();
    /*
     * El líder de las 14:00 y el de las 14:01 son el MISMO anuncio. Entre
     * medias hubo otro, pero no quedó en el histórico: entre dos observaciones
     * históricas consecutivas el líder no cambió, y eso es lo que se guarda.
     */
    expect(history()[1].marketState!.compra!.leaderChanged).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('5. una captura fallida no mueve la referencia histórica', () => {
  it('el hueco se salta y el siguiente registro sigue midiendo contra el último persistido', async () => {
    let book: Book = {
      buyNo: 'b1',
      buyPrice: '900.00',
      buyUsdt: '500',
      sellNo: 's1',
      sellPrice: '921.00',
    };
    stubBinanceDynamic(() => book);
    const store = await freshStore();

    // 14:00:00 - se persiste.
    await store.pollMarket();

    // 14:01:00 - tocaba escribir, pero el lado COMPRA llega vacío: no hay
    // mercado que describir y no se escribe nada. El hueco queda.
    stubBinanceBuySideEmpty();
    vi.setSystemTime(T0 + 60_000);
    await store.pollMarket();
    expect(history()).toHaveLength(1);

    // 14:02:00 - vuelve el mercado.
    book = {
      buyNo: 'b1',
      buyPrice: '909.00',
      buyUsdt: '600',
      sellNo: 's1',
      sellPrice: '921.00',
    };
    stubBinanceDynamic(() => book);
    vi.setSystemTime(T0 + 120_000);
    await store.pollMarket();

    const records = history();
    expect(records.map((r) => r.timestamp)).toEqual([T0, T0 + 120_000]);

    // La referencia sigue siendo el último registro REAL, y lo dice.
    const state = records[1].marketState!;
    expect(state.previousAt).toBe(T0);
    expect(state.compra!.leaderPriceDeltaPct).toBeCloseTo(1, 6);
    expect(state.compra!.declaredUsdtDeltaPct).toBeCloseTo(20, 6);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('6. la observación en vivo sigue existiendo, con su propia cadencia', () => {
  it('el estado en vivo avanza cada captura y compara contra la captura anterior', async () => {
    let book: Book = {
      buyNo: 'b1',
      buyPrice: '900.00',
      buyUsdt: '500',
      sellNo: 's1',
      sellPrice: '921.00',
    };
    stubBinanceDynamic(() => book);
    const store = await freshStore();

    await store.pollMarket(); // 14:00:00
    expect(store.getLiveMarketState()!.capturedAt).toBe(T0);
    expect(store.getLiveMarketState()!.previousAt).toBeNull();

    book = { ...book, buyPrice: '901.00' };
    vi.setSystemTime(T0 + 6_000);
    await store.pollMarket(); // 14:00:06

    book = { ...book, buyPrice: '902.00' };
    vi.setSystemTime(T0 + 12_000);
    await store.pollMarket(); // 14:00:12

    const live = store.getLiveMarketState()!;
    expect(live.capturedAt).toBe(T0 + 12_000);
    // En vivo la ventana es de 6 s: la captura anterior, no el registro.
    expect(live.previousAt).toBe(T0 + 6_000);

    // Y el histórico, mientras tanto, sigue con un único registro sin pasado.
    const records = history();
    expect(records).toHaveLength(1);
    expect(records[0].marketState!.previousAt).toBeNull();
  });

  it('el estado en vivo NO se persiste: el registro no lo contiene', async () => {
    stubBinanceDynamic(() => ({
      buyNo: 'b1',
      buyPrice: '900.00',
      buyUsdt: '500',
      sellNo: 's1',
      sellPrice: '921.00',
    }));
    const store = await freshStore();
    await store.pollMarket();

    const [record] = history();
    expect(record).not.toHaveProperty('liveMarketState');
    expect(Object.keys(record).filter((k) => k.toLowerCase().includes('live'))).toEqual([]);
  });
});
