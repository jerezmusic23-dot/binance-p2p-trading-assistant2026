/**
 * D6 — PERSISTENCIA DEL ESTADO DE MERCADO
 *
 * El libro completo llegaba a la captura y se descartaba antes de guardarse, de
 * modo que profundidad, concentración, dispersión y rotación no eran
 * estudiables por mucho histórico que se acumulase. Estos tests fijan que ahora
 * se conserva un agregado compacto, y -sobre todo- que la ausencia de un dato
 * NUNCA se guarda como cero.
 *
 * Aquí no se valida ninguna señal predictiva: D6 sólo conserva evidencia.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CONCENTRATION_TOPS,
  DEPTH_LEVELS_PCT,
  MARKET_STATE_VERSION,
  buildMarketState,
  leaderKeyOf,
} from '../server/marketState.js';
import { isBetterForLeg } from '../server/projection/hourSummary.js';
import { extractLegSeries } from '../server/dailyProjection.js';
import type { HistoryRecord, MarketSnapshot, NormalizedAd } from '../server/types.js';

const T0 = Date.UTC(2026, 8, 10, 14, 0, 0);

function ad(advNo: string, price: number, over: Partial<NormalizedAd> = {}): NormalizedAd {
  return {
    advNo,
    price,
    minAmountVes: 5_000,
    maxAmountVes: 200_000,
    availableUsdt: 100,
    availableUsdtReported: 100,
    merchantName: `nick-${advNo}`,
    userType: 'user',
    ordersCount: 50,
    finishRate: 0.97,
    paymentMethods: ['Mercantil'],
    paymentOptions: [{ payType: 'Mercantil', tradeMethodName: 'Mercantil' }],
    ...over,
  };
}

function snapshot(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    timestamp: T0,
    isoDate: new Date(T0).toISOString(),
    asset: 'USDT',
    fiat: 'VES',
    bestBuyPrice: 969.3,
    bestSellPrice: 970.15,
    averageBuyPrice: null,
    averageSellPrice: null,
    medianBuyPrice: 969.9,
    medianSellPrice: 966.8,
    weightedBuyPrice: null,
    weightedSellPrice: null,
    spreadAbsolute: 0.85,
    spreadPercentage: 0.0878,
    strategicBuyPrice: 969.9,
    strategicSellPrice: 966.8,
    strategicSpreadPct: -0.32,
    strategicReason: null,
    topBuyAds: [],
    topSellAds: [],
    qualityExcluded: [],
    strategicOutlierWatch: { buyFlagged: 0, sellFlagged: 0, buyDecidable: false, sellDecidable: false },
    source: 'BINANCE_P2P',
    fetchDurationMs: 100,
    status: 'LIVE',
    lastError: null,
    bestBuy: { value: 969.3, provenance: 'REAL' },
    bestSell: { value: 970.15, provenance: 'REAL' },
    aggregatesProvenance: 'AGGREGATED',
    orderBookProvenance: 'REAL',
    strategicProvenance: 'STRATEGIC',
    ...over,
  } as MarketSnapshot;
}

/* ════════════════════════════════════════════════════════════════════ */
describe('1. semántica: COMPRA quiere bajo, VENTA quiere alto', () => {
  const buyAds = [ad('b1', 970.0), ad('b2', 969.3), ad('b3', 969.6)];
  const sellAds = [ad('s1', 966.5), ad('s2', 967.4), ad('s3', 966.9)];
  const st = buildMarketState(snapshot({ topBuyAds: buyAds, topSellAds: sellAds }))!;

  it('el líder de COMPRA es el precio MENOR del lado Binance BUY', () => {
    expect(st.compra!.leaderPrice).toBe(969.3);
    expect(isBetterForLeg('COMPRA', 969.3, 970.0)).toBe(true);
  });

  it('el líder de VENTA es el precio MAYOR del lado Binance SELL', () => {
    expect(st.venta!.leaderPrice).toBe(967.4);
    expect(isBetterForLeg('VENTA', 967.4, 966.5)).toBe(true);
  });

  it('los lados no se cruzan', () => {
    expect(st.compra!.leg).toBe('COMPRA');
    expect(st.venta!.leg).toBe('VENTA');
    expect(st.compra!.leaderPrice).not.toBe(st.venta!.leaderPrice);
  });

  it('el gap al estratégico va FIRMADO, sin valor absoluto', () => {
    // COMPRA: líder 969.3 por DEBAJO de 969.9 -> negativo.
    expect(st.compra!.leaderGapPct!).toBeLessThan(0);
    // VENTA: líder 967.4 por ENCIMA de 966.8 -> positivo.
    expect(st.venta!.leaderGapPct!).toBeGreaterThan(0);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('2. liquidez y concentración', () => {
  // 100 + 50 + 30 + 20 = 200 USDT declarados, ordenados mejor-primero.
  const buyAds = [
    ad('b1', 969.3, { availableUsdtReported: 100 }),
    ad('b2', 969.4, { availableUsdtReported: 50 }),
    ad('b3', 969.5, { availableUsdtReported: 30 }),
    ad('b4', 969.6, { availableUsdtReported: 20 }),
  ];
  const st = buildMarketState(snapshot({ topBuyAds: buyAds }))!;

  it('suma sólo lo declarado y cuenta cuántos lo declararon', () => {
    expect(st.compra!.declaredUsdt).toBe(200);
    expect(st.compra!.adsWithVolume).toBe(4);
    expect(st.compra!.ads).toBe(4);
  });

  it('Top 1/3/5 se acumulan mejor-primero', () => {
    expect(st.compra!.topUsdt[1]).toBe(100);
    expect(st.compra!.topUsdt[3]).toBe(180);
    expect(st.compra!.topUsdt[5]).toBe(200); // sólo hay 4: no inventa un quinto
  });

  it('las cuotas son fracciones posibles y coherentes', () => {
    expect(st.compra!.topShare[1]).toBeCloseTo(0.5, 10);
    expect(st.compra!.topShare[3]).toBeCloseTo(0.9, 10);
    expect(st.compra!.topShare[5]).toBeCloseTo(1, 10);
    for (const n of CONCENTRATION_TOPS) {
      const share = st.compra!.topShare[n]!;
      expect(share).toBeGreaterThanOrEqual(0);
      expect(share).toBeLessThanOrEqual(1);
    }
  });

  it('si NADIE publica volumen, la liquidez es null, no cero', () => {
    const sinVolumen = [ad('x1', 969.3, { availableUsdtReported: null })];
    const s = buildMarketState(snapshot({ topBuyAds: sinVolumen }))!;
    expect(s.compra!.declaredUsdt).toBeNull();
    expect(s.compra!.adsWithVolume).toBe(0);
    expect(s.compra!.topUsdt[1]).toBeNull();
    expect(s.compra!.topShare[1]).toBeNull();
  });

  it('volumen declarado 0 SÍ es cero: es una medida, no una ausencia', () => {
    const cero = [ad('x1', 969.3, { availableUsdtReported: 0 })];
    const s = buildMarketState(snapshot({ topBuyAds: cero }))!;
    expect(s.compra!.declaredUsdt).toBe(0);
    expect(s.compra!.adsWithVolume).toBe(1);
    expect(s.compra!.topShare[1]).toBeNull(); // sin total positivo no hay cuota
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('3. profundidad relativa al precio estratégico', () => {
  it('COMPRA acumula lo que está en el techo o por debajo', () => {
    // ref = 969.9. Al 0.10% el techo es 970.8699; al 0.25%, 972.32.
    const ads = [
      ad('b1', 969.3, { availableUsdtReported: 10 }),  // dentro de todos
      ad('b2', 970.5, { availableUsdtReported: 20 }),  // dentro de 0.10% y superiores
      ad('b3', 975.0, { availableUsdtReported: 40 }),  // fuera hasta 0.50%; dentro de 1%? 979.6 -> sí
    ];
    const st = buildMarketState(snapshot({ topBuyAds: ads }))!;
    const at = (pct: number) => st.compra!.depth.find((d) => d.pct === pct)!;

    expect(at(0.1).usdt).toBe(30);
    expect(at(0.25).usdt).toBe(30);
    expect(at(1).usdt).toBe(70);
    expect(at(1).ads).toBe(3);
  });

  it('VENTA acumula lo que está en el suelo o por encima', () => {
    // ref = 966.8. Al 0.10% el suelo es 965.83; al 1%, 957.13.
    const ads = [
      ad('s1', 967.4, { availableUsdtReported: 10 }),
      ad('s2', 966.0, { availableUsdtReported: 20 }),
      ad('s3', 960.0, { availableUsdtReported: 40 }),
    ];
    const st = buildMarketState(snapshot({ topSellAds: ads }))!;
    const at = (pct: number) => st.venta!.depth.find((d) => d.pct === pct)!;

    expect(at(0.1).usdt).toBe(30);
    expect(at(1).usdt).toBe(70);
  });

  it('sin referencia estratégica la profundidad es null, no cero', () => {
    const st = buildMarketState(
      snapshot({ topBuyAds: [ad('b1', 969.3)], strategicBuyPrice: null })
    )!;
    for (const level of st.compra!.depth) {
      expect(level.usdt).toBeNull();
      expect(level.ads).toBeNull();
    }
  });

  it('la rejilla usada viaja dentro del propio snapshot', () => {
    const st = buildMarketState(snapshot({ topBuyAds: [ad('b1', 969.3)] }))!;
    expect(st.depthLevelsPct).toEqual([...DEPTH_LEVELS_PCT]);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('4. dispersión', () => {
  it('percentiles y rango relativo salen de los precios del lado', () => {
    const ads = [966, 967, 968, 969, 970].map((p, i) => ad(`b${i}`, p));
    const st = buildMarketState(snapshot({ topBuyAds: ads }))!;
    expect(st.compra!.priceP50).toBe(968);
    expect(st.compra!.priceP10).toBeCloseTo(966.4, 10);
    expect(st.compra!.priceP90).toBeCloseTo(969.6, 10);
    expect(st.compra!.priceRangePct).toBeCloseTo(((969.6 - 966.4) / 968) * 100, 8);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('5. persistencia y rotación, sin mirar hacia adelante', () => {
  const primera = buildMarketState(
    snapshot({ topBuyAds: [ad('b1', 969.3, { availableUsdtReported: 100 })] })
  )!;

  it('la primera captura no puede afirmar que el líder cambió', () => {
    expect(primera.compra!.leaderChanged).toBeNull();
    expect(primera.compra!.declaredUsdtDeltaPct).toBeNull();
    expect(primera.previousAt).toBeNull();
  });

  it('mismo anuncio líder = sin cambio', () => {
    const segunda = buildMarketState(
      snapshot({ timestamp: T0 + 60_000, topBuyAds: [ad('b1', 969.3, { availableUsdtReported: 100 })] }),
      primera
    )!;
    expect(segunda.compra!.leaderChanged).toBe(false);
    expect(segunda.previousAt).toBe(T0);
  });

  it('otro anuncio líder = cambio detectado, con su variación firmada', () => {
    const segunda = buildMarketState(
      snapshot({ timestamp: T0 + 60_000, topBuyAds: [ad('b9', 969.0, { availableUsdtReported: 150 })] }),
      primera
    )!;
    expect(segunda.compra!.leaderChanged).toBe(true);
    expect(segunda.compra!.declaredUsdtDeltaPct).toBeCloseTo(50, 8);
    expect(segunda.compra!.leaderPriceDeltaPct!).toBeLessThan(0); // bajó: firmado
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('6. una captura fallida no es un estado de mercado', () => {
  it('OFFLINE no produce estado', () => {
    expect(buildMarketState(snapshot({ status: 'OFFLINE', topBuyAds: [ad('b1', 969.3)] }))).toBeNull();
  });

  it('un libro vacío no produce estado', () => {
    expect(buildMarketState(snapshot({ topBuyAds: [], topSellAds: [] }))).toBeNull();
  });

  it('y NO avanza la persistencia: el siguiente estado real sigue midiendo contra el último conocido', () => {
    const fallida = buildMarketState(snapshot({ timestamp: T0 + 60_000, status: 'OFFLINE' }), primeraGlobal);
    expect(fallida).toBeNull();

    // El consumidor conserva `primeraGlobal`, así que la siguiente captura real
    // mide contra ella y no contra un hueco inventado.
    const tercera = buildMarketState(
      snapshot({ timestamp: T0 + 120_000, topBuyAds: [ad('b1', 969.3, { availableUsdtReported: 100 })] }),
      primeraGlobal
    )!;
    expect(tercera.previousAt).toBe(T0);
    expect(tercera.compra!.leaderChanged).toBe(false);
  });

  const primeraGlobal = buildMarketState(
    snapshot({ topBuyAds: [ad('b1', 969.3, { availableUsdtReported: 100 })] })
  )!;
});

/* ════════════════════════════════════════════════════════════════════ */
describe('7. banco/monto y métodos de pago', () => {
  it('la captura GENERAL no inventa un banco', () => {
    const st = buildMarketState(snapshot({ topBuyAds: [ad('b1', 969.3)] }))!;
    expect(st.filterBank).toBeNull();
    expect(st.filterAmountVes).toBeNull();
  });

  it('la composición por método de pago sale de los anuncios, sin inventar', () => {
    const ads = [
      ad('b1', 969.3, { paymentOptions: [{ payType: 'Mercantil', tradeMethodName: 'Mercantil' }] }),
      ad('b2', 969.4, { paymentOptions: [{ payType: 'Banesco', tradeMethodName: 'Banesco' }] }),
      ad('b3', 969.5, { paymentOptions: [{ payType: 'Mercantil', tradeMethodName: 'Mercantil' }] }),
    ];
    const st = buildMarketState(snapshot({ topBuyAds: ads }))!;
    expect(st.payTypesCompra.map((p) => p.payType)).toEqual(['Mercantil', 'Banesco']);
    expect(st.payTypesCompra[0].ads).toBe(2);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('8. no se guarda PII innecesaria', () => {
  it('el estado no contiene nombres de comerciantes en ninguna parte', () => {
    const st = buildMarketState(
      snapshot({ topBuyAds: [ad('b1', 969.3)], topSellAds: [ad('s1', 967.4)] })
    )!;
    const serialised = JSON.stringify(st);
    expect(serialised).not.toContain('nick-');
    expect(serialised).not.toContain('merchantName');
    expect(serialised).not.toContain('advNo');
  });

  it('la identidad del líder es un hash estable, no el identificador', () => {
    expect(leaderKeyOf('b1')).toBe(leaderKeyOf('b1'));
    expect(leaderKeyOf('b1')).not.toBe(leaderKeyOf('b2'));
    expect(leaderKeyOf('b1')).not.toContain('b1');
    expect(leaderKeyOf(null)).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('9. compatibilidad: registros legacy y round-trip', () => {
  const legacy: HistoryRecord = {
    id: 'legacy',
    timestamp: T0,
    dateStr: new Date(T0).toISOString(),
    hour: 10,
    buyPrice: 969.3,
    sellPrice: 970.15,
    spreadPct: 0.0878,
    bestBuyMerchant: 'x',
    bestSellMerchant: 'y',
    activeBuyAds: 5,
    activeSellAds: 5,
    source: 'BINANCE_P2P',
  };

  it('un registro sin marketState sigue siendo legible por la proyección', () => {
    const s = extractLegSeries([legacy], 'COMPRA');
    expect(s.points).toHaveLength(1);
    expect(s.points[0].price).toBe(969.3); // respaldo legacy al extremo
    expect(s.extraction.legacyRecords).toBe(1);
    expect(legacy.marketState).toBeUndefined();
  });

  it('el bloque v5 sobrevive un round-trip JSON con sus nulls intactos', () => {
    const st = buildMarketState(
      snapshot({ topBuyAds: [ad('b1', 969.3, { availableUsdtReported: null })] })
    )!;
    const record: HistoryRecord = { ...legacy, marketState: st };
    const revived = JSON.parse(JSON.stringify(record)) as HistoryRecord;

    expect(revived.marketState!.version).toBe(MARKET_STATE_VERSION);
    expect(revived.marketState!.compra!.declaredUsdt).toBeNull();
    expect(revived.marketState!.compra!.leaderPrice).toBe(969.3);
    expect(revived.marketState!.depthLevelsPct).toEqual([...DEPTH_LEVELS_PCT]);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('10. el script de backtest sigue siendo importable', () => {
  it('cada símbolo que importa existe donde dice importarlo', async () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'daily-backtest.ts'), 'utf8');
    // Se rompió antes por importar `backtestLeg` de un módulo que no lo exporta.
    expect(src).toMatch(/from '\.\.\/server\/projection\/dailyBacktest\.js'/);

    const backtest = await import('../server/projection/dailyBacktest.js');
    expect(typeof backtest.backtestLeg).toBe('function');
    const shape = await import('../server/projection/dailyShape.js');
    expect(typeof shape.groupByDay).toBe('function');
    const daily = await import('../server/dailyProjection.js');
    expect(typeof daily.extractLegSeries).toBe('function');
    expect(daily.STRATEGIC_SUMMARY).toBe('MEDIAN');
  });

  it('agrupa con el MISMO resumen horario que produce la proyección real', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'daily-backtest.ts'), 'utf8');
    expect(src).toMatch(/groupByDay\(venta\.points, 'VENTA', STRATEGIC_SUMMARY\)/);
    expect(src).toMatch(/groupByDay\(compra\.points, 'COMPRA', STRATEGIC_SUMMARY\)/);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('11. el extremo ejecutable y la referencia estratégica no se contaminan', () => {
  /*
   * Invariante heredado de D2/D4 y que D6 no puede romper: el líder es el
   * EXTREMO ejecutable y la referencia es la MEDIANA. Mover el extremo sin
   * mover la mediana debe cambiar el líder y dejar la referencia intacta.
   */
  const base = [
    ad('b1', 969.3, { availableUsdtReported: 10 }),
    ad('b2', 969.9, { availableUsdtReported: 10 }),
    ad('b3', 970.5, { availableUsdtReported: 10 }),
  ];

  it('un líder más agresivo no altera la referencia estratégica', () => {
    const antes = buildMarketState(snapshot({ topBuyAds: base }))!;
    // El nuevo anuncio es el mejor para COMPRA, pero la mediana del lado
    // sigue calculándose fuera de aquí: el snapshot la trae ya fijada.
    const conLider = buildMarketState(
      snapshot({ topBuyAds: [ad('b0', 960.0, { availableUsdtReported: 10 }), ...base] })
    )!;

    expect(antes.compra!.leaderPrice).toBe(969.3);
    expect(conLider.compra!.leaderPrice).toBe(960.0);

    // La referencia usada por ambos es la MISMA: 969.9 del snapshot.
    // El gap se recalcula, que es justamente para lo que existe.
    expect(antes.compra!.leaderGapPct).toBeCloseTo(((969.3 - 969.9) / 969.9) * 100, 8);
    expect(conLider.compra!.leaderGapPct).toBeCloseTo(((960.0 - 969.9) / 969.9) * 100, 8);
    expect(conLider.compra!.leaderGapPct!).toBeLessThan(antes.compra!.leaderGapPct!);
  });

  it('el estado no reescribe ni guarda una referencia estratégica propia', () => {
    const st = buildMarketState(snapshot({ topBuyAds: base }))!;
    // La referencia vive en el registro (D2/D4), no duplicada aquí: si D6
    // guardara su propia copia, podrían divergir.
    expect(Object.keys(st.compra!)).not.toContain('strategicBuyPrice');
    expect(Object.keys(st)).not.toContain('strategicBuyPrice');
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('12. banco y monto no mezclan celdas', () => {
  it('el estado conserva EXACTAMENTE el banco y el monto de su propia consulta', () => {
    const c20 = buildMarketState(
      snapshot({ filterBank: 'MERCANTIL', filterAmount: 20_000, topBuyAds: [ad('b1', 969.3)] })
    )!;
    const c50 = buildMarketState(
      snapshot({ filterBank: 'MERCANTIL', filterAmount: 50_000, topBuyAds: [ad('b1', 969.3)] })
    )!;

    expect(c20.filterAmountVes).toBe(20_000);
    expect(c50.filterAmountVes).toBe(50_000);
    expect(c20.filterBank).toBe('MERCANTIL');
  });

  it('una celda no hereda el banco de la captura anterior', () => {
    const previa = buildMarketState(
      snapshot({ filterBank: 'BANESCO', filterAmount: 20_000, topBuyAds: [ad('b1', 969.3)] })
    )!;
    // La siguiente captura es GENERAL: no debe arrastrar BANESCO.
    const general = buildMarketState(snapshot({ topBuyAds: [ad('b1', 969.3)] }), previa)!;
    expect(general.filterBank).toBeNull();
    expect(general.filterAmountVes).toBeNull();
  });
});
