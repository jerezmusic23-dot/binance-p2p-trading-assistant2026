/**
 * CONTRATO DE PROYECCIÓN GENERAL
 *
 * La proyección de la pantalla NO usa banco, monto ni medio de pago/payType.
 * Su fuente es únicamente HistoryRecord.buyPrice/sellPrice del libro general:
 *   VENTA  = máximo de sellPrice
 *   COMPRA = mínimo de buyPrice
 *
 * Los campos strategic* se incluyen deliberadamente con valores distintos en
 * estos fixtures para demostrar que no pueden contaminar la proyección.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDailyProjection,
  EXECUTABLE_FIELD,
  extractLegSeries,
  FIELD_FOR_LEG,
} from '../server/dailyProjection.js';
import type { HistoryRecord } from '../server/types.js';

const at = (day: number, hour: number): number =>
  Date.UTC(2026, 7, day, hour + 4, 0, 0);

function record(
  timestamp: number,
  buyPrice: number,
  sellPrice: number,
  strategicBuyPrice = buyPrice + 1000,
  strategicSellPrice = sellPrice - 1000,
): HistoryRecord {
  return {
    id: `tick-${timestamp}`,
    timestamp,
    dateStr: new Date(timestamp).toISOString(),
    hour: new Date(timestamp - 4 * 3_600_000).getUTCHours(),
    buyPrice,
    sellPrice,
    spreadPct: ((sellPrice - buyPrice) / buyPrice) * 100,
    bestBuyMerchant: 'general-buy',
    bestSellMerchant: 'general-sell',
    activeBuyAds: 20,
    activeSellAds: 20,
    source: 'TEST',
    calculationVersion: 'v2-strategic',
    strategicBuyPrice,
    strategicSellPrice,
    strategicSpreadPct: ((strategicSellPrice - strategicBuyPrice) / strategicBuyPrice) * 100,
  };
}

describe('D4 · la proyección general parte de la referencia estratégica', () => {
  it('VENTA lee el lado SELL y COMPRA el lado BUY, pero por su MEDIANA', () => {
    // Extremos y referencia deliberadamente distintos, para que se vea cuál usa.
    const rows = [
      record(at(20, 9), 930, 950, 934, 946),
      record(at(20, 10), 940, 960, 944, 956),
      record(at(20, 11), 935, 955, 939, 951),
    ];

    /*
     * El LADO no cambia -VENTA sigue leyendo el lado SELL y COMPRA el lado
     * BUY-; cambia el ESTADÍSTICO: se proyecta la mediana, no el extremo.
     */
    expect(FIELD_FOR_LEG).toEqual({ VENTA: 'strategicSellPrice', COMPRA: 'strategicBuyPrice' });
    expect(EXECUTABLE_FIELD).toEqual({ VENTA: 'sellPrice', COMPRA: 'buyPrice' });

    // `record()` fija strategicBuyPrice/strategicSellPrice por defecto.
    // La proyección toma la referencia estratégica...
    expect(extractLegSeries(rows, 'VENTA').points.map((p) => p.price)).toEqual([946, 956, 951]);
    expect(extractLegSeries(rows, 'COMPRA').points.map((p) => p.price)).toEqual([934, 944, 939]);

    // ...y los extremos siguen disponibles, pedidos explícitamente.
    expect(extractLegSeries(rows, 'VENTA', 'EXECUTABLE').points.map((p) => p.price)).toEqual([950, 960, 955]);
    expect(extractLegSeries(rows, 'COMPRA', 'EXECUTABLE').points.map((p) => p.price)).toEqual([930, 940, 935]);
  });

  it('el techo sale del lado VENTA y el piso del lado COMPRA (sobre la referencia)', () => {
    // Referencia estratégica explícita: es la serie que ahora se proyecta.
    const rows = [
      record(at(20, 9), 111, 999, 930, 950),
      record(at(20, 10), 111, 999, 940, 960),
      record(at(20, 11), 111, 999, 935, 955),
    ];
    const report = buildDailyProjection(rows, at(20, 20));

    expect(report.ceiling.observed?.price).toBe(960);
    expect(report.ceiling.leg).toBe('VENTA');
    expect(report.ceiling.binanceSide).toBe('SELL');
    expect(report.floor.observed?.price).toBe(930);
    expect(report.floor.leg).toBe('COMPRA');
    expect(report.floor.binanceSide).toBe('BUY');
  });

  it('el caso cruzado no mezcla las dos piernas', () => {
    const rows = [
      record(at(20, 9), 111, 999, 930, 920),
      record(at(20, 10), 111, 999, 936, 945),
    ];
    const report = buildDailyProjection(rows, at(20, 20));

    // Techo = máximo del lado VENTA = 945. Nunca 920 (un valor de VENTA de la
    // fila cruzada) filtrándose como si fuera el mínimo del lado COMPRA.
    expect(report.ceiling.observed?.price).toBe(945);
    expect(report.ceiling.observed?.price).not.toBe(936);
    // Piso = mínimo del lado COMPRA = 930. 920 pertenece a VENTA, así que no
    // es candidato para COMPRA aunque sea el valor más bajo de la tabla.
    expect(report.floor.observed?.price).toBe(930);
    expect(report.floor.observed?.price).not.toBe(920);
  });
});

describe('D4 · qué mueve la proyección y qué no', () => {
  const base = [
    record(at(20, 9), 930, 950, 5000, 100),
    record(at(20, 10), 940, 960, 5100, 100),
    record(at(20, 11), 935, 955, 5200, 100),
  ];

  it('cambiar strategic* SÍ cambia la serie proyectada: es su fuente', () => {
    const altered = base.map((r) => ({ ...r, strategicBuyPrice: 1, strategicSellPrice: 999999 }));
    expect(extractLegSeries(altered, 'VENTA').points.map((p) => p.price)).toEqual([999999, 999999, 999999]);
    expect(extractLegSeries(altered, 'COMPRA').points.map((p) => p.price)).toEqual([1, 1, 1]);
  });

  it('cambiar los EXTREMOS ya no mueve la serie proyectada', () => {
    // Éste es el corazón de D4: un anuncio anómalo vive en el extremo.
    const poisoned = base.map((r) => ({ ...r, buyPrice: 920.659, sellPrice: 1200 }));
    const baseVenta = extractLegSeries(base, 'VENTA').points.map((p) => p.price);
    const baseCompra = extractLegSeries(base, 'COMPRA').points.map((p) => p.price);

    expect(extractLegSeries(poisoned, 'VENTA').points.map((p) => p.price)).toEqual(baseVenta);
    expect(extractLegSeries(poisoned, 'COMPRA').points.map((p) => p.price)).toEqual(baseCompra);

    // Y el extremo envenenado sigue siendo visible cuando se pide.
    expect(extractLegSeries(poisoned, 'COMPRA', 'EXECUTABLE').points[0].price).toBe(920.659);
  });

  it('un registro sin strategic* sigue siendo válido', () => {
    const legacyShape = { ...base[0] };
    delete legacyShape.strategicBuyPrice;
    delete legacyShape.strategicSellPrice;
    delete legacyShape.strategicSpreadPct;
    const report = buildDailyProjection([legacyShape], at(20, 20));

    expect(report.legs[0].now).toBe(950);
    expect(report.legs[1].now).toBe(930);
  });
});

describe('sin histórico no se inventan precios', () => {
  it('mantiene ambos extremos sin datos', () => {
    const report = buildDailyProjection([], at(20, 12));
    expect(report.ceiling.observed).toBeNull();
    expect(report.floor.observed).toBeNull();
    expect(report.ceiling.dayBest).toBeNull();
    expect(report.floor.dayBest).toBeNull();
  });
});
