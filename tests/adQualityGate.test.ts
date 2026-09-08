/**
 * LA PUERTA DE CALIDAD: que un anuncio anómalo no se vuelva una operación.
 *
 * Los precios de estos tests son los OBSERVADOS por el operador en Binance
 * P2P VES, no números inventados para que la puerta luzca bien:
 *
 *   BUY  969.299  969.500  969.900  969.999  970.000     anómalo  920.659
 *   SELL 970.150  967.000  966.800  966.540  966.530     anómalo  1200
 *
 * Todos los anuncios de estos tests llevan BANCO VERIFICABLE, LÍMITES
 * COMPATIBLES y LIQUIDEZ PUBLICADA. Es deliberado: si el anómalo se rechazara
 * por sus propios límites, el test no probaría la puerta de calidad - que es
 * exactamente el agujero que tenía el test del atípico de 980.
 */

import { describe, expect, it } from 'vitest';
import { BinanceP2PService, BANK_CODE_MAP } from '../server/binanceP2PService.js';
import { evaluateBankAmount } from '../server/executability.js';
import { buildOpportunity, selectBestOpportunity } from '../server/opportunityEngine.js';
import {
  classifyAd,
  classifySide,
  isExecutionEligible,
  isReferenceEligible,
  OUTLIER_RELATIVE_THRESHOLD,
} from '../server/adQuality.js';
import { buildHourlyGrid, GRID_FIELD, GRID_FALLBACK_FIELD } from '../server/projection/hourlyGrid.js';
import type { HistoryRecord, NormalizedAd } from '../server/types.js';

const MERCANTIL = BANK_CODE_MAP.MERCANTIL.apiPayTypes;
const AMOUNT = 20_000;
const BUY_NORMAL = [969.299, 969.5, 969.9, 969.999, 970.0];
const SELL_NORMAL = [970.15, 967.0, 966.8, 966.54, 966.53];

function ad(advNo: string, price: number, over: Partial<NormalizedAd> = {}): NormalizedAd {
  return {
    advNo,
    price,
    minAmountVes: 5_000,
    maxAmountVes: 200_000,
    availableUsdt: 500,
    availableUsdtReported: 500,
    merchantName: `m-${advNo}`,
    userType: 'user',
    ordersCount: 120,
    finishRate: 0.98,
    paymentMethods: ['Mercantil'],
    paymentOptions: [{ payType: 'Mercantil', tradeMethodName: 'Mercantil' }],
    ...over,
  };
}
const side = (prices: number[], prefix: string) => prices.map((p, i) => ad(`${prefix}${i}`, p));

function cell(buyAds: NormalizedAd[], sellAds: NormalizedAd[]) {
  return evaluateBankAmount({
    bank: 'MERCANTIL',
    allowedCodes: MERCANTIL,
    amountVes: AMOUNT,
    buyAds,
    sellAds,
  });
}
const uiOf = (buyAds: NormalizedAd[], sellAds: NormalizedAd[]) => {
  const op = buildOpportunity(cell(buyAds, sellAds));
  return op ? selectBestOpportunity([op] as never) : null;
};

/* ════════════════════════════════════════════════════════════════════ */
describe('1. outlier BAJO en BUY: 920.659 no puede ser el precio de entrada', () => {
  const buyAds = [ad('OUT', 920.659), ...side(BUY_NORMAL, 'B')];
  const sellAds = side(SELL_NORMAL, 'S');

  it('se clasifica como OUTLIER pese a banco, límites y liquidez válidos', () => {
    const v = classifyAd(buyAds[0], buyAds, sellAds, 'ASK');
    expect(v.quality).toBe('OUTLIER');
    expect(v.deviationPct!).toBeLessThan(-OUTLIER_RELATIVE_THRESHOLD * 100);
    // Sus propios límites NO lo rechazan: la exclusión es por calidad.
    expect(buyAds[0].minAmountVes).toBeLessThanOrEqual(AMOUNT);
    expect(buyAds[0].maxAmountVes).toBeGreaterThanOrEqual(AMOUNT);
    expect(buyAds[0].availableUsdtReported).toBeGreaterThan(0);
  });

  it('no entra al libro ejecutable ni al par', () => {
    const c = cell(buyAds, sellAds);
    expect(c.buyQuotes.some((q) => q.advNo === 'OUT')).toBe(false);
    expect(c.pair?.buy.advNo).not.toBe('OUT');
  });

  it('no produce la oportunidad artificial de +5.37%', () => {
    const best = uiOf(buyAds, sellAds)!;
    expect(best.arbitrageBuyPrice).toBe(969.299);
    expect(best.spreadPct).toBeLessThan(1);
  });
});

describe('2. outlier ALTO en SELL: 1200 no puede ser el precio de salida', () => {
  const buyAds = side(BUY_NORMAL, 'B');
  const sellAds = [ad('OUT', 1200), ...side(SELL_NORMAL, 'S')];

  it('se clasifica como OUTLIER con límites y liquidez normales', () => {
    const v = classifyAd(sellAds[0], sellAds, buyAds, 'BID');
    expect(v.quality).toBe('OUTLIER');
    expect(v.deviationPct!).toBeGreaterThan(OUTLIER_RELATIVE_THRESHOLD * 100);
    expect(sellAds[0].minAmountVes).toBeLessThanOrEqual(AMOUNT);
    expect(sellAds[0].availableUsdtReported).toBeGreaterThan(0);
  });

  it('no llega a la UI como margen de 4760 VES', () => {
    const best = uiOf(buyAds, sellAds)!;
    expect(best.arbitrageSellPrice).toBe(970.15);
    expect(best.spreadPct).toBeLessThan(1);
  });
});

describe('3-4. PROMOTED: etiqueta de colocación, no juicio sobre el precio', () => {
  /*
   * Un "Promoted Ad" es publicidad pagada. Eso no dice nada sobre si su precio
   * se puede ejecutar, así que NO bloquea la ejecución: bloquea la REFERENCIA,
   * porque una colocación pagada no es una muestra del mercado abierto.
   */
  it('promocionado con precio NORMAL: ejecutable, pero fuera de la referencia', () => {
    const promo = ad('PROMO', 969.4, { promoted: true });
    const buyAds = [promo, ...side(BUY_NORMAL, 'B')];
    const v = classifyAd(promo, buyAds, side(SELL_NORMAL, 'S'), 'ASK');

    expect(v.quality).toBe('PROMOTED');
    expect(v.rule).toBe('PROMOTION_FLAG');
    expect(isExecutionEligible(v.quality)).toBe(true);
    expect(isReferenceEligible(v.quality)).toBe(false);

    const c = classifySide(buyAds, side(SELL_NORMAL, 'S'), 'ASK');
    expect(c.executionEligible.map((a) => a.advNo)).toContain('PROMO');
    expect(c.referenceEligible.map((a) => a.advNo)).not.toContain('PROMO');
  });

  it('un anuncio NORMAL equivalente recibe el mismo trato en ejecución', () => {
    const plain = ad('PLAIN', 969.4);
    const buyAds = [plain, ...side(BUY_NORMAL, 'B')];
    const v = classifyAd(plain, buyAds, side(SELL_NORMAL, 'S'), 'ASK');
    expect(v.quality).toBe('NORMAL');
    expect(isExecutionEligible(v.quality)).toBe(true);
    // La ÚNICA diferencia con el promocionado es la referencia.
    expect(isReferenceEligible(v.quality)).toBe(true);
  });

  it('promoted + OUTLIER: manda el precio, y no es ejecutable', () => {
    const bad = ad('PROMO_OUT', 920.659, { promoted: true });
    const buyAds = [bad, ...side(BUY_NORMAL, 'B')];
    const v = classifyAd(bad, buyAds, side(SELL_NORMAL, 'S'), 'ASK');

    expect(v.quality).toBe('OUTLIER'); // NO 'PROMOTED': el precio manda
    expect(v.rule).toBe('A_RELATIVE_DEVIATION');
    expect(isExecutionEligible(v.quality)).toBe(false);
    expect(v.reason).toMatch(/promocionado/);

    const c = cell(buyAds, side(SELL_NORMAL, 'S'));
    expect(c.buyQuotes.some((q) => q.advNo === 'PROMO_OUT')).toBe(false);
    expect(c.pair!.buy.price).toBe(969.299);
  });

  it('el espejo en SELL: promocionado alto y anómalo tampoco ejecuta', () => {
    const bad = ad('PROMO_OUT', 1200, { promoted: true });
    const sellAds = [bad, ...side(SELL_NORMAL, 'S')];
    expect(classifyAd(bad, sellAds, side(BUY_NORMAL, 'B'), 'BID').quality).toBe('OUTLIER');
    const c = cell(side(BUY_NORMAL, 'B'), sellAds);
    expect(c.pair!.sell.price).toBe(970.15);
  });

  it('promoción DESCONOCIDA no es promoción: sin bandera inequívoca, NORMAL', () => {
    const normal = ad('N', 969.5);
    expect(normal.promoted).toBeUndefined();
    const v = classifyAd(normal, side(BUY_NORMAL, 'B'), side(SELL_NORMAL, 'S'), 'ASK');
    expect(v.quality).toBe('NORMAL');
    // Y `false` tampoco es promoción.
    expect(classifyAd(ad('N2', 969.5, { promoted: null }), side(BUY_NORMAL, 'B'), side(SELL_NORMAL, 'S'), 'ASK').quality).toBe('NORMAL');
  });
});

describe('7. EXTREMO + NORMAL sigue siendo ejecutable', () => {
  it('el mejor ask legítimo 969.299 NO se bloquea por ser el extremo', () => {
    const buyAds = side(BUY_NORMAL, 'B');
    const v = classifyAd(buyAds[0], buyAds, side(SELL_NORMAL, 'S'), 'ASK');
    expect(v.quality).toBe('NORMAL');
    expect(cell(buyAds, side(SELL_NORMAL, 'S')).pair!.buy.price).toBe(969.299);
  });

  it('el mejor bid legítimo 970.15 NO se bloquea por ser el extremo', () => {
    const sellAds = side(SELL_NORMAL, 'S');
    expect(classifyAd(sellAds[0], sellAds, side(BUY_NORMAL, 'B'), 'BID').quality).toBe('NORMAL');
    expect(cell(side(BUY_NORMAL, 'B'), sellAds).pair!.sell.price).toBe(970.15);
  });

  it('la oportunidad legítima de +0.0878% sobrevive entera', () => {
    const best = uiOf(side(BUY_NORMAL, 'B'), side(SELL_NORMAL, 'S'))!;
    expect(best.arbitrageBuyPrice).toBe(969.299);
    expect(best.arbitrageSellPrice).toBe(970.15);
    expect(best.spreadPct).toBeCloseTo(((970.15 - 969.299) / 969.299) * 100, 6);
  });
});

describe('8. C sola nunca bloquea: un arbitraje real no se descarta', () => {
  /*
   * Libro ASK entero en 930-932 mientras los BID están en 966-970: un
   * arbitraje real del ~4%. La regla C se dispara (el ask contradice al lado
   * contrario) pero A no ve anomalía, así que el anuncio DEBE seguir vivo.
   * Tratar "ASK < BID" como absurdo borraría el producto.
   */
  const buyAds = side([930, 931, 932], 'B');
  const sellAds = side(SELL_NORMAL, 'S');

  it('C marca, A no, y el anuncio sigue siendo NORMAL y ejecutable', () => {
    const v = classifyAd(buyAds[0], buyAds, sellAds, 'ASK');
    expect(v.crossSideFlag).toBe(true);
    expect(v.quality).toBe('NORMAL');
    const best = uiOf(buyAds, sellAds)!;
    expect(best.arbitrageBuyPrice).toBe(930);
    expect(best.spreadPct).toBeGreaterThan(3);
  });

  it('cuando A y C coinciden, el motivo lo dice', () => {
    const buys = [ad('OUT', 920.659), ...side(BUY_NORMAL, 'B')];
    const v = classifyAd(buys[0], buys, sellAds, 'ASK');
    expect(v.quality).toBe('OUTLIER');
    expect(v.crossSideFlag).toBe(true);
    expect(v.reason).toContain('lado contrario');
  });
});

describe('nada desaparece en silencio', () => {
  it('cada anuncio apartado viaja con su clase, su precio y su motivo', () => {
    const c = cell([ad('OUT', 920.659), ...side(BUY_NORMAL, 'B')], side(SELL_NORMAL, 'S'));
    const ex = c.qualityExcluded.find((e) => e.advNo === 'OUT')!;
    expect(ex.side).toBe('BUY');
    expect(ex.price).toBe(920.659);
    expect(ex.quality).toBe('OUTLIER');
    expect(ex.reason.length).toBeGreaterThan(20);
  });

  it('sin volumen publicado es UNVERIFIABLE, y lo rechaza la capa de liquidez con su motivo exacto', () => {
    const noVol = ad('NOVOL', 969.4, { availableUsdtReported: null });
    const buys = [noVol, ...side(BUY_NORMAL, 'B')];
    expect(classifyAd(noVol, buys, side(SELL_NORMAL, 'S'), 'ASK').quality).toBe('UNVERIFIABLE');

    /*
     * La puerta de calidad NO lo aparta: ya era no ejecutable en la capa de
     * liquidez, y allí el motivo es más preciso. Apartarlo aquí sustituiría
     * "no se inventa liquidez" por un genérico "calidad".
     */
    const c = cell(buys, side(SELL_NORMAL, 'S'));
    expect(c.buyQuotes.some((q) => q.advNo === 'NOVOL')).toBe(false);
    expect(c.buyRejections.LIQUIDITY_NOT_VERIFIABLE).toBe(1);
  });

  it('con menos de 3 anuncios no se juzga, y no se inventa una restricción', () => {
    const buys = side([940, 952], 'B');
    const v = classifyAd(buys[0], buys, side(SELL_NORMAL, 'S'), 'ASK');
    expect(v.assessed).toBe(false);
    expect(v.quality).toBe('NORMAL');
    expect(classifySide(buys, side(SELL_NORMAL, 'S'), 'ASK').executionEligible).toHaveLength(2);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('5-6. la proyección se alimenta de la referencia robusta', () => {
  it('GRID_FIELD lee strategic*, no los extremos', () => {
    expect(GRID_FIELD).toEqual({ VENTA: 'strategicSellPrice', COMPRA: 'strategicBuyPrice' });
    expect(GRID_FALLBACK_FIELD).toEqual({ VENTA: 'sellPrice', COMPRA: 'buyPrice' });
  });

  const T0 = Date.UTC(2026, 3, 1, 4, 0, 0);
  /** `contaminatedFrom`: hora a partir de la cual el EXTREMO queda envenenado. */
  function history(contaminatedFrom: number | null, hours = 200, perHour = 12): HistoryRecord[] {
    const out: HistoryRecord[] = [];
    for (let h = 0; h < hours; h++) {
      for (let k = 0; k < perHour; k++) {
        const t = T0 + h * 3_600_000 + k * 60_000;
        const poisoned = contaminatedFrom !== null && h >= contaminatedFrom;
        out.push({
          id: `r${t}`,
          timestamp: t,
          dateStr: new Date(t).toISOString(),
          hour: 0,
          // El extremo se desploma cuando hay anuncio anómalo...
          buyPrice: poisoned ? 920.659 : 969.3,
          sellPrice: 970.15,
          spreadPct: 0.0878,
          // ...pero la mediana del lado apenas se mueve.
          calculationVersion: 'v2-strategic',
          strategicBuyPrice: 969.95,
          strategicSellPrice: 966.8,
          strategicSpreadPct: -0.32,
          bestBuyMerchant: 'm',
          bestSellMerchant: 'm',
          activeBuyAds: 6,
          activeSellAds: 5,
          source: 'BINANCE_P2P',
        });
      }
    }
    return out;
  }

  it('un outlier PERSISTENTE no desplaza la serie que proyecta', () => {
    const clean = buildHourlyGrid(history(null), 'COMPRA');
    const poisoned = buildHourlyGrid(history(150), 'COMPRA');
    const last = poisoned.cells.length - 1;
    expect(poisoned.cells[last]!.level).toBe(969.95);
    expect(poisoned.cells[last]!.level).toBe(clean.cells[last]!.level);
    expect(poisoned.legacyRecords).toBe(0);
  });

  it('un ÚNICO extremo contaminado tampoco la mueve', () => {
    const recs = history(null);
    recs[recs.length - 1].buyPrice = 920.659;
    const grid = buildHourlyGrid(recs, 'COMPRA');
    expect(grid.cells[grid.cells.length - 1]!.level).toBe(969.95);
  });

  it('los extremos SIGUEN en el histórico para diagnóstico', () => {
    const recs = history(150);
    expect(recs[recs.length - 1].buyPrice).toBe(920.659);
    expect(recs[recs.length - 1].sellPrice).toBe(970.15);
  });

  it('un registro legacy sin strategic* cae al extremo y se declara', () => {
    const recs = history(null, 5).map((r) => {
      const { strategicBuyPrice, strategicSellPrice, calculationVersion, ...rest } = r;
      return rest as HistoryRecord;
    });
    const grid = buildHourlyGrid(recs, 'COMPRA');
    expect(grid.cells[0]!.level).toBe(969.3);
    expect(grid.legacyRecords).toBe(recs.length);
  });
});

/* ════════════════════════════════════════════════════════════════════
 * COMPARABLES: SÓLO ANUNCIOS QUE COMPITEN POR LA MISMA OPERACIÓN
 * ════════════════════════════════════════════════════════════════════ */
describe('comparables por tramo de importe', () => {
  const tier = (advNo: string, price: number, min: number, max: number) =>
    ad(advNo, price, { minAmountVes: min, maxAmountVes: max });

  it('captura general: un anuncio de otro tramo NO se juzga contra el tramo minorista', () => {
    // El caso literal del enunciado.
    const book = [
      tier('A', 969, 20_000, 100_000),
      tier('A2', 969.5, 20_000, 100_000),
      tier('A3', 969.9, 20_000, 100_000),
      tier('B', 980, 500_000, 1_000_000),
    ];
    const c = classifySide(book, side(SELL_NORMAL, 'S'), 'ASK', null);
    const b = c.classified.find((x) => x.ad.advNo === 'B')!;
    expect(b.verdict.quality).not.toBe('OUTLIER');
    expect(b.verdict.assessed).toBe(false); // su tramo no tiene comparables suficientes
  });

  it('un bloque legítimo con prima no se marca OUTLIER por el tramo minorista', () => {
    const book = [
      ...BUY_NORMAL.map((p, i) => tier(`A${i}`, p, 20_000, 100_000)),
      tier('BLOQUE', 1010, 500_000, 1_000_000),
    ];
    const c = classifySide(book, side(SELL_NORMAL, 'S'), 'ASK', null);
    expect(c.classified.find((x) => x.ad.advNo === 'BLOQUE')!.verdict.quality).toBe('NORMAL');
  });

  it('y sin embargo un anómalo DENTRO de su tramo se sigue detectando', () => {
    const book = [
      tier('A0', 969.3, 20_000, 100_000),
      tier('A1', 969.5, 20_000, 100_000),
      tier('A2', 969.9, 20_000, 100_000),
      tier('MALO', 920.659, 20_000, 100_000),
      tier('B1', 1050, 500_000, 1_000_000),
      tier('B2', 1051, 500_000, 1_000_000),
      tier('B3', 1052, 500_000, 1_000_000),
    ];
    const c = classifySide(book, side(SELL_NORMAL, 'S'), 'ASK', null);
    const q = (n: string) => c.classified.find((x) => x.ad.advNo === n)!.verdict.quality;
    expect(q('MALO')).toBe('OUTLIER');
    // Los tres de bloque se juzgan entre ellos, no contra los minoristas.
    expect([q('B1'), q('B2'), q('B3')]).toEqual(['NORMAL', 'NORMAL', 'NORMAL']);
  });

  it('con importe pedido, comparables son los que admiten ESE importe', () => {
    const book = [tier('A0', 969.3, 20_000, 100_000), tier('B', 980, 500_000, 1_000_000)];
    const at600 = classifySide(book, side(SELL_NORMAL, 'S'), 'ASK', 600_000);
    // A0 no sirve 600K: no se juzga aquí, lo rechazan sus propios límites.
    expect(at600.classified.find((x) => x.ad.advNo === 'A0')!.verdict.assessed).toBe(false);
    // Y el 980 sigue siendo ejecutable a 600K, como fija el contrato del 980.
    expect(at600.executionEligible.map((a) => a.advNo)).toContain('B');
  });
});

/* ════════════════════════════════════════════════════════════════════
 * TRAZABILIDAD: SE PUEDE RECONSTRUIR POR QUÉ QUEDÓ APARTADO
 * ════════════════════════════════════════════════════════════════════ */
describe('qualityExcluded reconstruye la exclusión entera', () => {
  it('un OUTLIER trae anuncio, precio, lado, regla, evidencia y elegibilidades', () => {
    const c = cell([ad('OUT', 920.659), ...side(BUY_NORMAL, 'B')], side(SELL_NORMAL, 'S'));
    const e = c.qualityExcluded.find((x) => x.advNo === 'OUT')!;
    expect(e.side).toBe('BUY');
    expect(e.price).toBe(920.659);
    expect(e.quality).toBe('OUTLIER');
    expect(e.rule).toBe('A_RELATIVE_DEVIATION');
    expect(e.deviationPct!).toBeLessThan(-2);
    expect(e.crossSideFlag).toBe(true);
    expect(e.assessed).toBe(true);
    expect(e.availableUsdtReported).toBe(500);
    expect(e.promoted).toBeNull();
    expect(e.executionEligible).toBe(false);
    expect(e.referenceEligible).toBe(false);
  });

  it('un PROMOTED trae su bandera y sus dos elegibilidades distintas', () => {
    const c = cell([ad('P', 969.4, { promoted: true }), ...side(BUY_NORMAL, 'B')], side(SELL_NORMAL, 'S'));
    const e = c.qualityExcluded.find((x) => x.advNo === 'P')!;
    expect(e.rule).toBe('PROMOTION_FLAG');
    expect(e.promoted).toBe(true);
    expect(e.executionEligible).toBe(true);
    expect(e.referenceEligible).toBe(false);
  });

  it('un UNVERIFIABLE declara que Binance no publicó volumen', () => {
    const c = cell([ad('NV', 969.4, { availableUsdtReported: null }), ...side(BUY_NORMAL, 'B')], side(SELL_NORMAL, 'S'));
    const e = c.qualityExcluded.find((x) => x.advNo === 'NV')!;
    expect(e.quality).toBe('UNVERIFIABLE');
    expect(e.rule).toBe('LIQUIDITY_NOT_PUBLISHED');
    expect(e.availableUsdtReported).toBeNull();
  });
});
