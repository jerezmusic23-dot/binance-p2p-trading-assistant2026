/**
 * EL CONTRATO DE CAPTURA — qué se le pide a Binance, y cómo se lee lo que vuelve.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BLOQUEO EXTERNO, DECLARADO
 *
 * Este entorno NO puede alcanzar Binance. El proxy devuelve
 *
 *     curl: (56) CONNECT tunnel failed, response 403
 *
 * para p2p.binance.com. Por tanto NADA de este fichero es validación contra el
 * libro real: son fixtures deterministas con la FORMA de la respuesta de
 * Binance, y lo que comprueban es que el bot pide lo que cree pedir y lee lo
 * que cree leer.
 *
 * LO QUE QUEDA PENDIENTE DE VALIDACIÓN REAL, y no puede hacerse aquí:
 *   - que el endpoint siga aceptando esta carga útil sin cambios;
 *   - que tradableQuantity siga presente en los anuncios reales;
 *   - que los payTypes canónicos de los 7 bancos sigan siendo los de
 *     BANK_CODE_MAP (payTypeMappingStatus ya lo vigila en ejecución);
 *   - que rows:20 siga siendo el máximo útil por página.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SOBRE additionalKycVerifyFilter: no se envía, y eso es una decisión, no un
 * olvido. Omitirlo deja el filtro por defecto de Binance; enviarlo cambiaría
 * el conjunto de anuncios que el bot ve y por tanto los precios que
 * recomienda. No se añade "porque parece más correcto": haría falta observar
 * el libro real con y sin él, y este entorno no puede.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { BinanceP2PService, BANK_CODE_MAP } from '../server/binanceP2PService.js';
import { makeAdItem, makeBinanceResponse } from './helpers/fixtures.js';
import { AMOUNT_TIERS } from '../server/executability.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Captures every request body the service sends. */
function recordRequests(response = makeBinanceResponse([makeAdItem()])) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => response,
      } as unknown as Response;
    })
  );
  return bodies;
}

describe('LA PETICIÓN — cada campo, y por qué vale lo que vale', () => {
  it('el endpoint es el que el proyecto ya usaba, sin cambiar', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => makeBinanceResponse([makeAdItem()]),
        } as unknown as Response;
      })
    );

    await BinanceP2PService.queryP2PAds({ tradeType: 'BUY' });
    expect(urls[0]).toBe('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search');
  });

  it('asset y fiat son USDT/VES y no se derivan de nada', async () => {
    const bodies = recordRequests();
    await BinanceP2PService.queryP2PAds({ tradeType: 'BUY' });

    expect(bodies[0].asset).toBe('USDT');
    expect(bodies[0].fiat).toBe('VES');
  });

  it('la carga útil completa, campo por campo', async () => {
    const bodies = recordRequests();
    await BinanceP2PService.queryP2PAds({ tradeType: 'SELL', payTypes: ['Banesco'], transAmount: 10_000 });

    expect(bodies[0]).toEqual({
      asset: 'USDT',
      fiat: 'VES',
      merchantCheck: false,
      page: 1,
      rows: 20,
      payTypes: ['Banesco'],
      publisherType: null,
      tradeType: 'SELL',
      // transAmount viaja como CADENA: Binance lo rechaza como número.
      transAmount: '10000',
    });
  });

  it('additionalKycVerifyFilter NO se envía, deliberadamente', async () => {
    /*
     * Añadirlo cambiaría el conjunto de anuncios que el bot ve, y por tanto
     * los precios que recomienda. La decisión conservadora es no tocarlo sin
     * poder observar el libro real con y sin él.
     */
    const bodies = recordRequests();
    await BinanceP2PService.queryP2PAds({ tradeType: 'BUY' });

    expect(Object.keys(bodies[0])).not.toContain('additionalKycVerifyFilter');
  });

  it('sin banco, payTypes va vacío en vez de con un valor inventado', async () => {
    const bodies = recordRequests();
    await BinanceP2PService.queryP2PAds({ tradeType: 'BUY' });

    expect(bodies[0].payTypes).toEqual([]);
  });

  it('sin monto, transAmount va null en vez de 0', async () => {
    /*
     * Un 0 sería un filtro real ("operaciones de cero bolívares") y devolvería
     * un libro distinto. La ausencia de filtro es null.
     */
    const bodies = recordRequests();
    await BinanceP2PService.queryP2PAds({ tradeType: 'BUY' });

    expect(bodies[0].transAmount).toBeNull();
  });
});

describe('EL BARRIDO — dos listados por celda, con el monto de esa celda', () => {
  it('pide BUY y SELL, y sólo esos dos, por consulta de mercado', async () => {
    const bodies = recordRequests();
    await BinanceP2PService.fetchFullMarketSnapshot();

    expect(bodies).toHaveLength(2);
    expect(bodies.map((b) => b.tradeType).sort()).toEqual(['BUY', 'SELL']);
  });

  it('el filtro de banco se traduce a los payTypes canónicos de ese banco', async () => {
    for (const bank of Object.keys(BANK_CODE_MAP)) {
      const bodies = recordRequests();
      await BinanceP2PService.fetchFullMarketSnapshot(bank);

      for (const body of bodies) {
        expect(body.payTypes, bank).toEqual(BANK_CODE_MAP[bank].apiPayTypes);
      }
      vi.unstubAllGlobals();
    }
  });

  it('cada tramo pide SU monto, para recibir anuncios que lo aceptan', async () => {
    /*
     * Es la razón de que el barrido rote un tramo por vuelta en vez de filtrar
     * en memoria: pedir 100.000 devuelve los anuncios que aceptan 100.000, y
     * no un subconjunto de los que aceptan 10.000.
     */
    for (const tier of AMOUNT_TIERS) {
      const bodies = recordRequests();
      await BinanceP2PService.fetchFullMarketSnapshot('BANESCO', tier.val);

      for (const body of bodies) {
        expect(body.transAmount, tier.key).toBe(String(tier.val));
      }
      vi.unstubAllGlobals();
    }
  });

  it('rows es 20 en ambos lados: es un límite de CAPTURA', async () => {
    const bodies = recordRequests();
    await BinanceP2PService.fetchFullMarketSnapshot();

    for (const body of bodies) expect(body.rows).toBe(20);
  });
});

describe('LA RESPUESTA — cómo se interpreta cada campo del anuncio', () => {
  const raw = makeAdItem({
    advNo: 'contrato-1',
    price: '941.37',
    min: '5000',
    max: '150000',
    tradable: '312.45',
    surplus: '999.99',
    nickName: 'Comerciante',
    monthOrderCount: 412,
    monthFinishRate: 0.9731,
    tradeMethods: [{ payType: 'BBVAProvincial', tradeMethodName: 'Provincial (BBVA)' }],
  });

  const [ad] = BinanceP2PService.normalizeAds([raw]);

  it('el precio es VES por USDT, tal cual, sin redondear en la captura', () => {
    expect(ad.price).toBe(941.37);
  });

  it('los límites son VES: mínimo y máximo por operación', () => {
    expect(ad.minAmountVes).toBe(5_000);
    expect(ad.maxAmountVes).toBe(150_000);
  });

  it('la cantidad disponible es USDT, y tradableQuantity manda sobre surplusAmount', () => {
    /*
     * Los dos campos existen y no significan lo mismo: surplusAmount es el
     * saldo del anuncio, tradableQuantity lo que queda realmente negociable.
     * Confundirlos sobreestima la liquidez.
     */
    expect(ad.availableUsdt).toBe(312.45);
    expect(ad.availableUsdtReported).toBe(312.45);
  });

  it('un volumen ausente es null, no cero — son cosas distintas', () => {
    const [silent] = BinanceP2PService.normalizeAds([
      makeAdItem({ tradable: '', surplus: '' }),
    ]);
    expect(silent.availableUsdtReported).toBeNull();

    const [zero] = BinanceP2PService.normalizeAds([makeAdItem({ tradable: '0' })]);
    expect(zero.availableUsdtReported).toBe(0);
  });

  it('el payType canónico se conserva junto a la etiqueta legible', () => {
    /*
     * La verificación de banco compara contra payType y nada más. Quedarse
     * sólo con "Provincial (BBVA)" perdía el código y ningún anuncio volvía a
     * verificarse.
     */
    expect(ad.paymentOptions).toEqual([
      { payType: 'BBVAProvincial', tradeMethodName: 'Provincial (BBVA)' },
    ]);
    expect(ad.paymentMethods).toEqual(['Provincial (BBVA)']);
  });

  it('la calidad del comerciante viaja sin reinterpretarse', () => {
    expect(ad.ordersCount).toBe(412);
    expect(ad.finishRate).toBe(0.9731);
    expect(ad.userType).toBe('merchant');
  });

  it('un anuncio sin precio utilizable se descarta en vez de valer 0', () => {
    const list = BinanceP2PService.normalizeAds([
      makeAdItem({ advNo: 'bueno', price: '941.00' }),
      makeAdItem({ advNo: 'sin-precio', price: 'no-es-un-numero' }),
      makeAdItem({ advNo: 'negativo', price: '-5' }),
    ]);

    expect(list.map((a) => a.advNo)).toEqual(['bueno']);
  });
});

describe('LOS FALLOS DE BINANCE se propagan como fallos, no como precios', () => {
  it('un HTTP no-2xx no se convierte en un libro vacío', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, statusText: 'x' }) as unknown as Response));
    await expect(BinanceP2PService.queryP2PAds({ tradeType: 'BUY' })).rejects.toThrow(/503/);
  });

  it('un código de negocio distinto de 000000 tampoco', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ code: '000002', message: 'rate limited', data: [], success: false }),
      }) as unknown as Response)
    );
    await expect(BinanceP2PService.queryP2PAds({ tradeType: 'BUY' })).rejects.toThrow(/000002/);
  });

  it('los dos lados vacíos son un error, no un mercado en calma', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => makeBinanceResponse([]),
      }) as unknown as Response)
    );
    await expect(BinanceP2PService.fetchFullMarketSnapshot()).rejects.toThrow();
  });
});
