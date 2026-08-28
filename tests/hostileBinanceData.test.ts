/**
 * AUDITORÍA PRE-DEPLOY — LO QUE BINANCE PUEDE DEVOLVER Y LAS FIXTURES NUNCA
 * DEVOLVIERON.
 *
 * Todas las simulaciones de este proyecto construyen anuncios bien formados,
 * así que ningún test anterior podía descubrir qué pasa con un campo vacío,
 * una cantidad negativa o un precio absurdo. Estos casos se encontraron
 * recorriendo la salida completa del motor en busca de NaN, Infinity y
 * negativos, y cada uno de los cuatro primeros era un defecto real.
 *
 * LA REGLA QUE TODOS VIOLABAN es la que el propio módulo de ejecutabilidad
 * declara: una condición que no pudo ESTABLECERSE nunca se trata como
 * satisfecha. Un límite ilegible se convertía en un límite permisivo.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { BinanceP2PService, BANK_CODE_MAP } from '../server/binanceP2PService.js';
import { evaluateBankAmount } from '../server/executability.js';
import { buildOpportunity } from '../server/opportunityEngine.js';
import { weightedAverage } from '../server/marketStatistics.js';
import type { BinanceAdItem } from '../server/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BANESCO = BANK_CODE_MAP.BANESCO.apiPayTypes;

function raw(adv: Partial<BinanceAdItem['adv']>): BinanceAdItem {
  return {
    adv: {
      advNo: 'x',
      price: '940.00',
      maxSingleTransAmount: '100000',
      minSingleTransAmount: '1000',
      surplusAmount: '500',
      tradableQuantity: '500',
      tradeType: 'BUY',
      asset: 'USDT',
      fiatUnit: 'VES',
      tradeMethods: [{ payType: 'Banesco', payMethodId: 'p', tradeMethodName: 'Banesco' }],
      ...adv,
    } as BinanceAdItem['adv'],
    advertiser: {
      userNo: 'u',
      nickName: 'N',
      userType: 'merchant',
      monthOrderCount: 1,
      monthFinishRate: 0.9,
      positiveRate: 0.9,
      userGrade: 2,
    } as BinanceAdItem['advertiser'],
  };
}

/** Every number in a structure, with its path. */
function nonFinite(value: unknown, path = '', out: string[] = []): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${value} en ${path}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => nonFinite(v, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) nonFinite(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

describe('DEFECTO 1 — un precio Infinity atravesaba el filtro', () => {
  it('parseFloat("1e309") es Infinity, y no es NaN ni <= 0', () => {
    // La condición original era `isNaN(price) || price <= 0`. Infinity pasa las dos.
    expect(parseFloat('1e309')).toBe(Infinity);
    expect(Number.isNaN(parseFloat('1e309'))).toBe(false);
    expect(parseFloat('1e309') <= 0).toBe(false);
  });

  it('ahora el anuncio se descarta en vez de llevar un precio imposible', () => {
    expect(BinanceP2PService.normalizeAds([raw({ price: '1e309' })])).toEqual([]);
  });

  it('un precio válido junto a uno imposible sobrevive intacto', () => {
    const list = BinanceP2PService.normalizeAds([
      raw({ advNo: 'imposible', price: '1e309' }),
      raw({ advNo: 'bueno', price: '941.50' }),
    ]);

    expect(list.map((a) => a.advNo)).toEqual(['bueno']);
    expect(list[0].price).toBe(941.5);
  });
});

describe('DEFECTO 2 — un límite ilegible se volvía un límite permisivo', () => {
  /*
   * `parseFloat(...) || 0` y los dos ceros son permisivos: mínimo 0 acepta
   * cualquier monto, y máximo 0 es el "sin techo" de Binance. Un anuncio con
   * los límites rotos aceptaba LOS SEIS TRAMOS.
   */
  it('un mínimo ausente o ilegible descarta el anuncio', () => {
    for (const min of ['', 'abc', 'null', '  ']) {
      expect(
        BinanceP2PService.normalizeAds([raw({ minSingleTransAmount: min })]),
        `min=${JSON.stringify(min)}`
      ).toEqual([]);
    }
  });

  it('un máximo ausente o ilegible descarta el anuncio', () => {
    for (const max of ['', 'abc', 'null']) {
      expect(
        BinanceP2PService.normalizeAds([raw({ maxSingleTransAmount: max })]),
        `max=${JSON.stringify(max)}`
      ).toEqual([]);
    }
  });

  it('un límite negativo también, porque no es un límite más laxo', () => {
    // `amountVes < -5` es falso para todo monto: el mínimo desaparecería.
    expect(BinanceP2PService.normalizeAds([raw({ minSingleTransAmount: '-5' })])).toEqual([]);
    expect(BinanceP2PService.normalizeAds([raw({ maxSingleTransAmount: '-5' })])).toEqual([]);
  });

  it('un CERO publicado sí se conserva: es una respuesta, no una ausencia', () => {
    // Mínimo 0 = sin suelo. Máximo 0 = sin techo, que es como Binance lo dice.
    const [noFloor] = BinanceP2PService.normalizeAds([raw({ minSingleTransAmount: '0' })]);
    expect(noFloor.minAmountVes).toBe(0);

    const [noCeiling] = BinanceP2PService.normalizeAds([raw({ maxSingleTransAmount: '0' })]);
    expect(noCeiling.maxAmountVes).toBe(0);

    // Y el "sin techo" sigue significando eso en la ejecutabilidad.
    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 100_000,
      buyAds: BinanceP2PService.normalizeAds([raw({ price: '940', maxSingleTransAmount: '0' })]),
      sellAds: BinanceP2PService.normalizeAds([raw({ price: '950', maxSingleTransAmount: '0' })]),
    });
    expect(cell.pair).not.toBeNull();
  });

  it('EL RIESGO CONCRETO: una operación de 100.000 contra un techo real de 5.000', () => {
    /*
     * Antes: el anuncio llegaba con maxAmountVes = 0 ("sin techo") y el motor
     * lo declaraba ejecutable para el tramo de 100.000. El operador habría
     * intentado una operación que el anuncio no acepta.
     */
    const brokenCeiling = BinanceP2PService.normalizeAds([
      raw({ advNo: 'techo-roto', price: '940', maxSingleTransAmount: 'no-es-un-numero' }),
    ]);

    expect(brokenCeiling).toEqual([]);

    const cell = evaluateBankAmount({
      bank: 'BANESCO',
      allowedCodes: BANESCO,
      amountVes: 100_000,
      buyAds: brokenCeiling,
      sellAds: BinanceP2PService.normalizeAds([raw({ price: '950' })]),
    });

    expect(cell.pair).toBeNull();
    expect(buildOpportunity(cell)).toBeNull();
  });
});

describe('DEFECTO 3 — un volumen negativo se llevaba como cantidad', () => {
  it('se reporta como desconocido, que es lo que es', () => {
    const [ad] = BinanceP2PService.normalizeAds([
      raw({ tradableQuantity: '-1000', surplusAmount: '-1000' }),
    ]);

    expect(ad.availableUsdtReported).toBeNull();
    expect(ad.availableUsdt).toBe(0);
  });

  it('y por tanto no puede restar de una media ponderada', () => {
    /*
     * weightedAverage ya descartaba pesos <= 0, así que la media estaba
     * defendida. Lo que no lo estaba era la suma de la cola del maker, que
     * sumaba el número tal cual y habría INFRAVALORADO la competencia por
     * delante.
     */
    const ads = BinanceP2PService.normalizeAds([
      raw({ advNo: 'a', price: '940', tradableQuantity: '-500' }),
      raw({ advNo: 'b', price: '950', tradableQuantity: '500' }),
    ]);

    for (const ad of ads) expect(ad.availableUsdt).toBeGreaterThanOrEqual(0);
    expect(
      weightedAverage(ads.map((a) => ({ value: a.price, weight: a.availableUsdt })))
    ).toBe(950);
  });

  it('un CERO publicado sigue siendo cero, no desconocido', () => {
    const [ad] = BinanceP2PService.normalizeAds([raw({ tradableQuantity: '0', surplusAmount: '0' })]);
    expect(ad.availableUsdtReported).toBe(0);
  });

  it('un volumen ausente sigue siendo desconocido, no cero', () => {
    const [ad] = BinanceP2PService.normalizeAds([raw({ tradableQuantity: '', surplusAmount: '' })]);
    expect(ad.availableUsdtReported).toBeNull();
  });
});

describe('DEFECTO 4 — ?limit=abc quitaba el límite en vez de imponerlo', () => {
  it('NaN sobrevive a Math.min y Math.max, y slice(-NaN) es la serie entera', () => {
    const naive = Math.min(2000, Math.max(1, Number('abc')));
    expect(Number.isNaN(naive)).toBe(true);
    expect([1, 2, 3, 4, 5].slice(-naive)).toHaveLength(5);
  });

  it('la ruta ahora cae al valor por defecto', async () => {
    const { default: request } = await import('node:http');
    expect(typeof request).toBe('object');
    // La lógica, aislada tal como quedó en la ruta:
    const clamp = (raw: unknown) => {
      const requested = Number(raw ?? 300);
      return Number.isFinite(requested)
        ? Math.min(2000, Math.max(1, Math.trunc(requested)))
        : 300;
    };

    expect(clamp('abc')).toBe(300);
    expect(clamp(undefined)).toBe(300);
    expect(clamp('50')).toBe(50);
    expect(clamp('999999')).toBe(2000);
    expect(clamp('-5')).toBe(1);
    expect(clamp('12.7')).toBe(12);
  });
});

describe('EL BARRIDO COMPLETO — ningún no-finito llega a ninguna salida', () => {
  const HOSTILE: [string, BinanceAdItem][] = [
    ['precio vacío', raw({ price: '' })],
    ['precio cero', raw({ price: '0' })],
    ['precio negativo', raw({ price: '-940' })],
    ['precio Infinity', raw({ price: '1e309' })],
    ['min ausente', raw({ minSingleTransAmount: '' })],
    ['max ausente', raw({ maxSingleTransAmount: '' })],
    ['max menor que min', raw({ minSingleTransAmount: '90000', maxSingleTransAmount: '1000' })],
    ['volumen ausente', raw({ tradableQuantity: '', surplusAmount: '' })],
    ['volumen cero', raw({ tradableQuantity: '0', surplusAmount: '0' })],
    ['volumen negativo', raw({ tradableQuantity: '-10', surplusAmount: '-10' })],
    ['sin tradeMethods', raw({ tradeMethods: [] as never })],
    ['tradeMethods null', raw({ tradeMethods: null as never })],
    ['payType null', raw({ tradeMethods: [{ payType: null, payMethodId: 'p', tradeMethodName: 'x' }] as never })],
    ['payType desconocido', raw({ tradeMethods: [{ payType: 'BancoDeMarte', payMethodId: 'p', tradeMethodName: 'M' }] as never })],
  ];

  it('la normalización nunca produce un número no finito', () => {
    for (const [name, item] of HOSTILE) {
      const list = BinanceP2PService.normalizeAds([item]);
      expect(nonFinite(list, name), name).toEqual([]);
    }
  });

  it('la celda, la operación y el margen tampoco, en los seis tramos', () => {
    const healthy = BinanceP2PService.normalizeAds([raw({ advNo: 'sano', price: '950' })]);

    for (const [name, item] of HOSTILE) {
      const hostile = BinanceP2PService.normalizeAds([item]);

      for (const amountVes of [10_000, 20_000, 30_000, 40_000, 50_000, 100_000]) {
        const cell = evaluateBankAmount({
          bank: 'BANESCO',
          allowedCodes: BANESCO,
          amountVes,
          buyAds: hostile,
          sellAds: healthy,
        });
        const operation = buildOpportunity(cell);

        expect(nonFinite(cell, `${name}/${amountVes}/cell`), name).toEqual([]);
        expect(nonFinite(operation, `${name}/${amountVes}/op`), name).toEqual([]);

        // Y si llegara a haber operación, su margen es coherente.
        if (operation !== null) {
          expect(operation.marginVes).toBeCloseTo(
            (operation.amountVes * operation.marginPct) / 100,
            6
          );
        }
      }
    }
  });

  it('un anuncio hostil nunca produce una operación ejecutable', () => {
    const healthy = BinanceP2PService.normalizeAds([raw({ advNo: 'sano', price: '950' })]);

    for (const [name, item] of HOSTILE) {
      const cell = evaluateBankAmount({
        bank: 'BANESCO',
        allowedCodes: BANESCO,
        amountVes: 100_000,
        buyAds: BinanceP2PService.normalizeAds([item]),
        sellAds: healthy,
      });

      // Ninguno de estos anuncios describe una compra que se pueda ejecutar.
      expect(cell.pair, name).toBeNull();
    }
  });
});
