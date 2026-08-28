/**
 * AUDITORÍA PRE-DEPLOY — UN ANUNCIO MARCADO, SEGUIDO DE BINANCE A TELEGRAM.
 *
 * Comprobar nombres de variables no demuestra nada: `buyPrice` puede llamarse
 * igual en los dos lados de una inversión. Así que aquí cada anuncio lleva un
 * advNo que dice DE QUÉ LISTADO VINO, y se sigue el mismo objeto por toda la
 * cadena:
 *
 *   respuesta de Binance -> normalizeAds -> CentralStore -> executableMatrix
 *   -> opportunityEngine -> buildOpportunity -> matriz de la UI -> Telegram
 *
 * Si algún eslabón invirtiera los lados, el advNo aparecería en el sitio
 * equivocado y ninguna coincidencia de nombres podría taparlo.
 *
 * EL LIBRO DE ESTA PRUEBA, elegido para que las dos capas den respuestas
 * OPUESTAS sobre el mismo mercado:
 *
 *   listado tradeType=BUY   (anunciantes que VENDEN USDT)   940,25 y 945,10
 *   listado tradeType=SELL  (anunciantes que COMPRAN USDT)  960,75 y 955,30
 *
 * Como TOMADOR compro a 940,25 y vendo a 960,75: +2,18%.
 * Como MAKER, para ser primero tendría que comprar por encima de 960,75 y
 * vender por debajo de 940,25: no hay margen.
 *
 * Que el motor diga las dos cosas a la vez, y no copie una en la otra, es la
 * prueba de que las dos capas no están confundidas.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutableCell } from '../server/types.js';

const originalCwd = process.cwd();
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-trace-'));
  process.chdir(tmpDir);
  process.env.TELEGRAM_BOT_TOKEN = '1234567890:TRACE-TOKEN-NOT-REAL';
  process.env.TELEGRAM_CHAT_ID = '-1001234567890';
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

/** El advNo declara su procedencia. Una inversión lo delata inmediatamente. */
const marked = (tradeType: 'BUY' | 'SELL', price: string, tag = 'MEJOR') => ({
  adv: {
    advNo: `${tag}-DESDE-LISTADO-${tradeType}`,
    price,
    maxSingleTransAmount: '200000',
    minSingleTransAmount: '1000',
    surplusAmount: '9000',
    tradableQuantity: '9000',
    tradeType,
    asset: 'USDT',
    fiatUnit: 'VES',
    tradeMethods: [{ payType: 'Banesco', payMethodId: 'p', tradeMethodName: 'Banesco' }],
  },
  advertiser: {
    userNo: 'u',
    nickName: `COMERCIANTE-${tradeType}`,
    userType: 'merchant',
    monthOrderCount: 1,
    monthFinishRate: 0.9,
    positiveRate: 0.9,
    userGrade: 2,
  },
});

async function traceOneBook() {
  vi.resetModules();
  const telegram: string[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('api.telegram.org')) {
        telegram.push(JSON.parse(String(init.body)).text as string);
        return { ok: true, status: 200 } as unknown as Response;
      }
      const body = JSON.parse(String(init.body));
      const data =
        body.tradeType === 'BUY'
          ? [marked('BUY', '940.25'), marked('BUY', '945.10', 'PEOR')]
          : [marked('SELL', '960.75'), marked('SELL', '955.30', 'PEOR')];

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ code: '000000', message: null, success: true, data, total: 2 }),
      } as unknown as Response;
    })
  );

  const { CentralMarketStore } = await import('../server/centralStore.js');
  const store = CentralMarketStore.getInstance();

  const snapshot = await store.pollMarket();
  const { executableMatrix } = await store.getExecutableMatrix();
  const { result: opportunities } = await store.getOpportunities();
  const makerMatrix = await store.getMakerMatrix();

  store.stop();
  return { snapshot, executableMatrix, opportunities, makerMatrix, telegram };
}

describe('ESLABÓN 1 — la captura pone cada listado en su lado', () => {
  it('el listado BUY alimenta MI COMPRA, y su mejor precio es el MÁS BAJO', async () => {
    const { snapshot } = await traceOneBook();

    expect(snapshot?.topBuyAds[0].advNo).toBe('MEJOR-DESDE-LISTADO-BUY');
    // De 940,25 y 945,10 el mejor para mí es el barato: es lo que pago.
    expect(snapshot?.bestBuyPrice).toBe(940.25);
  }, 60_000);

  it('el listado SELL alimenta MI VENTA, y su mejor precio es el MÁS ALTO', async () => {
    const { snapshot } = await traceOneBook();

    expect(snapshot?.topSellAds[0].advNo).toBe('MEJOR-DESDE-LISTADO-SELL');
    // De 960,75 y 955,30 el mejor para mí es el caro: es lo que recibo.
    expect(snapshot?.bestSellPrice).toBe(960.75);
  }, 60_000);

  it('y por tanto el spread es positivo, con el signo correcto', async () => {
    const { snapshot } = await traceOneBook();

    expect(snapshot?.spreadPercentage).toBeCloseTo(((960.75 - 940.25) / 940.25) * 100, 9);
    expect(snapshot?.spreadPercentage as number).toBeGreaterThan(0);
  }, 60_000);
});

describe('ESLABÓN 2 y 3 — la matriz y la oportunidad conservan la procedencia', () => {
  it('la celda toma la compra del listado BUY y la venta del listado SELL', async () => {
    const { executableMatrix } = await traceOneBook();
    const cell = executableMatrix.cells.BANESCO['10K'] as ExecutableCell;

    expect(cell.status).toBe('EXECUTABLE');
    expect(cell.buy?.advNo).toBe('MEJOR-DESDE-LISTADO-BUY');
    expect(cell.sell?.advNo).toBe('MEJOR-DESDE-LISTADO-SELL');
    expect(cell.buy?.price).toBe(940.25);
    expect(cell.sell?.price).toBe(960.75);
  }, 60_000);

  it('la operación anunciada lleva los mismos dos anuncios, no otros', async () => {
    const { opportunities } = await traceOneBook();
    const best = opportunities.bestOpportunity!;

    expect(best.buyAdvNo).toBe('MEJOR-DESDE-LISTADO-BUY');
    expect(best.sellAdvNo).toBe('MEJOR-DESDE-LISTADO-SELL');

    // Pago 940,25 y recibo 960,75. Invertido daría un margen negativo.
    expect(best.buyPrice).toBe(940.25);
    expect(best.sellPrice).toBe(960.75);
    expect(best.marginPct).toBeGreaterThan(0);

    // Y los nombres inequívocos coinciden con los ambiguos.
    expect(best.arbitrageBuyPrice).toBe(best.buyPrice);
    expect(best.arbitrageSellPrice).toBe(best.sellPrice);

    // El dinero es coherente con la tasa y el tramo.
    expect(best.marginVes).toBeCloseTo((best.amountVes * best.marginPct) / 100, 6);
  }, 60_000);
});

describe('ESLABÓN 4 — la capa MAKER es el espejo, y lo demuestra discrepando', () => {
  it('MI COMPRA compite contra el listado SELL, y para ser primero pago MÁS', async () => {
    const { makerMatrix } = await traceOneBook();
    const cell = makerMatrix.cells.BANESCO['10K'];
    const buyAnalysis = cell.recommendation!.buyAnalysis;

    // Mis rivales para comprar son los OTROS COMPRADORES: el listado SELL.
    expect(buyAnalysis.ladder[0].advNo).toBe('MEJOR-DESDE-LISTADO-SELL');
    expect(buyAnalysis.leaderPrice).toBe(960.75);
    expect(buyAnalysis.definition.leaderIs).toBe('HIGHEST');
  }, 60_000);

  it('MI VENTA compite contra el listado BUY, y para ser primero cobro MENOS', async () => {
    const { makerMatrix } = await traceOneBook();
    const cell = makerMatrix.cells.BANESCO['10K'];
    const sellAnalysis = cell.recommendation!.sellAnalysis;

    // Mis rivales para vender son los OTROS VENDEDORES: el listado BUY.
    expect(sellAnalysis.ladder[0].advNo).toBe('MEJOR-DESDE-LISTADO-BUY');
    expect(sellAnalysis.leaderPrice).toBe(940.25);
    expect(sellAnalysis.definition.leaderIs).toBe('LOWEST');
  }, 60_000);

  it('LA PRUEBA DECISIVA: el mismo libro, dos respuestas opuestas', async () => {
    /*
     * Si la capa maker hubiera copiado la del tomador, aquí saldría un margen
     * positivo. Sale NO_MARGIN porque ser primero en las dos colas significa
     * comprar por encima de 960,75 y vender por debajo de 940,25, que es una
     * pérdida - y el motor lo dice en vez de repetir el +2,18% del tomador.
     */
    const { opportunities, makerMatrix } = await traceOneBook();

    expect(opportunities.bestOpportunity!.marginPct).toBeGreaterThan(2);
    expect(makerMatrix.cells.BANESCO['10K'].status).toBe('NO_MARGIN');
  }, 60_000);
});

describe('ESLABÓN 5 — Telegram habla del maker, y declara su profundidad', () => {
  it('el único mensaje es el resumen maker, sin vocabulario de arbitraje', async () => {
    const { telegram } = await traceOneBook();

    expect(telegram.length).toBeGreaterThan(0);
    const all = telegram.join('\n');

    expect(all).toContain('MIS PRECIOS PARA PUBLICAR');
    for (const forbidden of [
      'ALERTA DE PRECIO',
      'ALERTA P2P',
      'ALTA VOLATILIDAD',
      'OPORTUNIDAD DE ARBITRAJE',
      'Binance ASK',
      'Binance BID',
    ]) {
      expect(all, forbidden).not.toContain(forbidden);
    }
  }, 60_000);

  it('el mensaje dice que sólo conoce los 20 anuncios que pidió', async () => {
    /*
     * TOP 20 es un límite de CAPTURA. El resumen no puede presentarse como
     * "lo mejor de todo Binance" cuando ha mirado veinte anuncios por lado.
     */
    const { telegram } = await traceOneBook();
    expect(telegram.join('\n')).toContain('TOP 20');
  }, 60_000);

  it('y no anuncia como maker la operación que el tomador sí tendría', async () => {
    const { telegram } = await traceOneBook();
    const all = telegram.join('\n');

    // El +2,18% del tomador no puede aparecer en el mensaje del maker.
    expect(all).not.toContain('2.18');
    expect(all).toContain('Sin margen positivo');
  }, 60_000);
});
