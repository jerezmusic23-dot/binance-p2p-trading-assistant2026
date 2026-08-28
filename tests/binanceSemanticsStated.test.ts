/**
 * LA SEMÁNTICA, ESCRITA COMO CUATRO FRASES Y COMPROBADA COMO CUATRO TESTS.
 *
 * El operador la enunció así:
 *
 *   BINANCE BUY  = el anuncio donde el usuario VENDE USDT en el mercado P2P.
 *   BINANCE SELL = el anuncio donde el usuario COMPRA USDT en el mercado P2P.
 *   COMPRA EN BINANCE = VENTA EN ARBITRAJE.
 *   VENTA EN BINANCE  = COMPRA EN ARBITRAJE.
 *
 * EL SUJETO DE ESAS FRASES ES EL ANUNCIANTE, no yo, y ahí está toda la
 * dificultad. `tradeType` lleva la intención del BUSCADOR: pedir tradeType=BUY
 * es pulsar "Comprar USDT" en p2p.binance.com y recibir los anuncios de quien
 * VENDE. Leído como la acción del anunciante, el parámetro dice lo contrario
 * de lo que hace, y esa lectura invertida es el defecto que este proyecto ya
 * ha tenido una vez.
 *
 * Con el anunciante como sujeto, las cuatro frases y el código dicen lo mismo:
 *
 *   listado tradeType=BUY   anuncios que VENDEN USDT   yo COMPRO   ASK  bestIs LOWEST
 *   listado tradeType=SELL  anuncios que COMPRAN USDT  yo VENDO    BID  bestIs HIGHEST
 *
 * Y por tanto, con "compra/venta EN BINANCE" entendido como lo que hace el
 * anunciante:
 *
 *   donde el anunciante COMPRA (tradeType=SELL)  ->  ahí está MI VENTA
 *   donde el anunciante VENDE  (tradeType=BUY)   ->  ahí está MI COMPRA
 *
 * Si alguna vez estos tests fallan, no se ajusta el test: se comprueba contra
 * el libro real cuál de las dos lecturas es la verdadera, porque cambiar esto
 * a ciegas invierte el signo de todos los márgenes del sistema.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  ARBITRAGE_LEGS,
  arbitrageSpreadPct,
  arbitrageSpreadVes,
  isArbitrageOpportunity,
  legDefinition,
  mapBinanceAdToArbitrageLeg,
  tradeTypeForLeg,
} from '../server/arbitrageSides.js';
import { evaluateBankAmount } from '../server/executability.js';
import { buildOpportunity } from '../server/opportunityEngine.js';
import { BinanceP2PService, BANK_CODE_MAP } from '../server/binanceP2PService.js';
import { makeAdItem, makeBinanceResponse } from './helpers/fixtures.js';
import type { NormalizedAd } from '../server/types.js';

const BANESCO = BANK_CODE_MAP.BANESCO.apiPayTypes;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FRASE 1 — BINANCE BUY es el listado donde el anunciante VENDE USDT', () => {
  const leg = mapBinanceAdToArbitrageLeg('BUY');

  it('el anunciante vende, y por tanto yo compro', () => {
    expect(leg.advertiserAction).toBe('VENDE USDT');
    expect(leg.userAction).toBe('COMPRO USDT');
  });

  it('es el lado ASK del libro, y mi mejor precio es el MÁS BAJO', () => {
    expect(leg.bookSide).toBe('ASK');
    expect(leg.bestIs).toBe('LOWEST');
  });

  it('es la pierna de entrada de la operación', () => {
    expect(leg.leg).toBe('ARBITRAGE_BUY');
    expect(tradeTypeForLeg('ARBITRAGE_BUY')).toBe('BUY');
    expect(legDefinition('ARBITRAGE_BUY').tradeType).toBe('BUY');
  });
});

describe('FRASE 2 — BINANCE SELL es el listado donde el anunciante COMPRA USDT', () => {
  const leg = mapBinanceAdToArbitrageLeg('SELL');

  it('el anunciante compra, y por tanto yo vendo', () => {
    expect(leg.advertiserAction).toBe('COMPRA USDT');
    expect(leg.userAction).toBe('VENDO USDT');
  });

  it('es el lado BID del libro, y mi mejor precio es el MÁS ALTO', () => {
    expect(leg.bookSide).toBe('BID');
    expect(leg.bestIs).toBe('HIGHEST');
  });

  it('es la pierna de salida de la operación', () => {
    expect(leg.leg).toBe('ARBITRAGE_SELL');
    expect(tradeTypeForLeg('ARBITRAGE_SELL')).toBe('SELL');
  });
});

describe('FRASE 3 y 4 — donde el anunciante COMPRA está MI VENTA, y al revés', () => {
  it('las dos piernas son espejo exacto: ninguna comparte lado, extremo ni acción', () => {
    const [entry, exit] = ARBITRAGE_LEGS;

    expect(entry.tradeType).not.toBe(exit.tradeType);
    expect(entry.bookSide).not.toBe(exit.bookSide);
    expect(entry.bestIs).not.toBe(exit.bestIs);
    expect(entry.advertiserAction).not.toBe(exit.advertiserAction);
    expect(entry.userAction).not.toBe(exit.userAction);

    // Y en cada pierna, lo que hace el anunciante es lo contrario de lo que hago yo.
    for (const definition of ARBITRAGE_LEGS) {
      const advertiserSells = definition.advertiserAction === 'VENDE USDT';
      const iBuy = definition.userAction === 'COMPRO USDT';
      expect(advertiserSells).toBe(iBuy);
    }
  });

  it('hay UNA sola función que traduce, y todo lo demás la consulta', () => {
    /*
     * Dos sitios que decidan qué significa un anuncio son dos sitios donde
     * puede decidirse al revés. Sólo arbitrageSides.ts puede nombrar la
     * relación entre tradeType y mi operación.
     */
    expect(mapBinanceAdToArbitrageLeg('BUY')).toBe(legDefinition('ARBITRAGE_BUY'));
    expect(mapBinanceAdToArbitrageLeg('SELL')).toBe(legDefinition('ARBITRAGE_SELL'));
  });
});

describe('la aritmética que se sigue de las cuatro frases', () => {
  it('el spread es venta menos compra, y el denominador es lo que comprometo', () => {
    expect(arbitrageSpreadVes(940, 950)).toBe(10);
    expect(arbitrageSpreadPct(940, 950)).toBeCloseTo((10 / 940) * 100, 12);
  });

  it('una pérdida conserva el signo en vez de leerse como ganancia', () => {
    expect(arbitrageSpreadVes(950, 940)).toBe(-10);
    expect(arbitrageSpreadPct(950, 940)).toBeLessThan(0);
    expect(isArbitrageOpportunity(950, 940)).toBe(false);
  });

  it('el equilibrio no es una oportunidad', () => {
    expect(isArbitrageOpportunity(940, 940)).toBe(false);
    expect(arbitrageSpreadPct(940, 940)).toBe(0);
  });
});

describe('EL PRIMER ESLABÓN — lo que Binance devuelve acaba en el lado correcto', () => {
  /**
   * Devuelve precios distintos por tradeType, de modo que un cruce de los dos
   * listados sea visible en el resultado en vez de quedar oculto.
   */
  function stubBinance(buyListingPrice: string, sellListingPrice: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const price = body.tradeType === 'BUY' ? buyListingPrice : sellListingPrice;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => makeBinanceResponse([makeAdItem({ price })]),
        } as unknown as Response;
      })
    );
  }

  it('el precio del listado BUY es el precio de MI COMPRA', async () => {
    stubBinance('945.31', '946.03');
    const snapshot = await BinanceP2PService.fetchFullMarketSnapshot();

    // El listado BUY (anunciantes que VENDEN) alimenta bestBuyPrice: mi entrada.
    expect(snapshot.bestBuyPrice).toBe(945.31);
    // El listado SELL (anunciantes que COMPRAN) alimenta bestSellPrice: mi salida.
    expect(snapshot.bestSellPrice).toBe(946.03);
  });

  it('un libro cruzado se reporta cruzado, no se corrige en silencio', async () => {
    /*
     * Si el lado BID quedara por encima del ASK de forma sostenida, el mapeo
     * estaría mal. Aquí sólo se comprueba que el sistema lo MUESTRA en vez de
     * darle la vuelta: el spread sale negativo y sigue negativo.
     */
    stubBinance('946.00', '945.00');
    const snapshot = await BinanceP2PService.fetchFullMarketSnapshot();

    expect(snapshot.bestBuyPrice).toBe(946);
    expect(snapshot.bestSellPrice).toBe(945);
    expect(snapshot.spreadPercentage as number).toBeLessThan(0);
  });
});

describe('LA OPERACIÓN — buyPrice es lo que pago, sellPrice lo que recibo', () => {
  const ad = (advNo: string, price: number, availableUsdt: number): NormalizedAd => ({
    advNo,
    price,
    minAmountVes: 1_000,
    maxAmountVes: 100_000,
    availableUsdt,
    availableUsdtReported: availableUsdt,
    merchantName: 'Comerciante',
    userType: 'merchant',
    ordersCount: 120,
    finishRate: 0.98,
    paymentMethods: ['Banesco'],
    paymentOptions: [{ payType: 'Banesco', tradeMethodName: 'Banesco' }],
  });

  it('la pierna comprada sale del libro BUY y la vendida del libro SELL', () => {
    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 50_000,
      // buyAds es el listado tradeType=BUY: anunciantes que VENDEN USDT.
      buyAds: [ad('desde-el-listado-BUY', 940, 5_000)],
      // sellAds es el listado tradeType=SELL: anunciantes que COMPRAN USDT.
      sellAds: [ad('desde-el-listado-SELL', 950, 5_000)],
    });

    const operation = buildOpportunity(cell)!;

    expect(operation.buyAdvNo).toBe('desde-el-listado-BUY');
    expect(operation.sellAdvNo).toBe('desde-el-listado-SELL');
    // Pago 940 y recibo 950: el margen es positivo y del signo correcto.
    expect(operation.buyPrice).toBe(940);
    expect(operation.sellPrice).toBe(950);
    expect(operation.marginPct).toBeGreaterThan(0);
  });

  it('los nombres inequívocos coinciden con los ambiguos, siempre', () => {
    /*
     * arbitrageBuyPrice / arbitrageSellPrice existen porque "buyPrice" ha
     * significado dos cosas para dos lectores. Deben ser el mismo número, o
     * los dos vocabularios habrían empezado a divergir.
     */
    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 50_000,
      buyAds: [ad('b', 940, 5_000)],
      sellAds: [ad('s', 950, 5_000)],
    });
    const operation = buildOpportunity(cell)!;

    expect(operation.arbitrageBuyPrice).toBe(operation.buyPrice);
    expect(operation.arbitrageSellPrice).toBe(operation.sellPrice);
  });

  it('invertir los dos libros invierte el signo del margen, y nada lo esconde', () => {
    /*
     * La prueba de que la orientación importa: con los listados cruzados la
     * misma celda produce una pérdida, y se reporta como pérdida.
     */
    const inverted = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 50_000,
      buyAds: [ad('b', 950, 5_000)],
      sellAds: [ad('s', 940, 5_000)],
    });

    expect(inverted.spreadPct as number).toBeLessThan(0);
    expect(buildOpportunity(inverted)!.marginPct).toBeLessThan(0);
  });
});

describe('el vocabulario del maker es el espejo, y también está fijado', () => {
  it('para publicar compito en el listado ESPEJO de mi intención', () => {
    /*
     * MI COMPRA de USDT compite con los OTROS COMPRADORES, que viven en el
     * listado tradeType=SELL - no en el BUY, que es donde compraría si fuera
     * taker. Es la misma frase del operador vista desde el otro lado, y es la
     * distinción que separa esta capa de la de arbitraje.
     */
    const iBuyAsTaker = mapBinanceAdToArbitrageLeg('BUY');
    expect(iBuyAsTaker.userAction).toBe('COMPRO USDT');

    // Como maker, mis rivales para comprar son los que también compran: SELL.
    const myRivalsWhenIBuy = mapBinanceAdToArbitrageLeg('SELL');
    expect(myRivalsWhenIBuy.advertiserAction).toBe('COMPRA USDT');

    // Los dos listados no son el mismo, que es justo lo que hay que recordar.
    expect(iBuyAsTaker.tradeType).not.toBe(myRivalsWhenIBuy.tradeType);
  });
});
