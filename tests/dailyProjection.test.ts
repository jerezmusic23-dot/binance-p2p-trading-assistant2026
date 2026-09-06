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
import { buildDailyProjection, extractLegSeries, FIELD_FOR_LEG } from '../server/dailyProjection.js';
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

describe('la proyección general usa los extremos crudos del libro', () => {
  it('VENTA usa sellPrice y COMPRA usa buyPrice', () => {
    const rows = [
      record(at(20, 9), 930, 950),
      record(at(20, 10), 940, 960),
      record(at(20, 11), 935, 955),
    ];

    expect(FIELD_FOR_LEG).toEqual({ VENTA: 'sellPrice', COMPRA: 'buyPrice' });
    expect(extractLegSeries(rows, 'VENTA').points.map((p) => p.price)).toEqual([950, 960, 955]);
    expect(extractLegSeries(rows, 'COMPRA').points.map((p) => p.price)).toEqual([930, 940, 935]);
  });

  it('el techo es el máximo de VENTA y el piso el mínimo de COMPRA', () => {
    const rows = [
      record(at(20, 9), 930, 950),
      record(at(20, 10), 940, 960),
      record(at(20, 11), 935, 955),
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
      record(at(20, 9), 930, 920),
      record(at(20, 10), 936, 945),
    ];
    const report = buildDailyProjection(rows, at(20, 20));

    expect(report.ceiling.observed?.price).toBe(945);
    expect(report.ceiling.observed?.price).not.toBe(936);
    expect(report.floor.observed?.price).toBe(920);
    expect(report.floor.observed?.price).not.toBe(930);
  });
});

describe('los campos estratégicos no contaminan la proyección general', () => {
  const base = [
    record(at(20, 9), 930, 950, 5000, 100),
    record(at(20, 10), 940, 960, 5100, 100),
    record(at(20, 11), 935, 955, 5200, 100),
  ];

  it('cambiar strategic* no cambia las series de la proyección', () => {
    const altered = base.map((r) => ({
      ...r,
      strategicBuyPrice: 1,
      strategicSellPrice: 999999,
      strategicSpreadPct: 999999,
    }));

    const baseVenta = extractLegSeries(base, 'VENTA').points.map((p) => p.price);
    const alteredVenta = extractLegSeries(altered, 'VENTA').points.map((p) => p.price);
    const baseCompra = extractLegSeries(base, 'COMPRA').points.map((p) => p.price);
    const alteredCompra = extractLegSeries(altered, 'COMPRA').points.map((p) => p.price);

    expect(alteredVenta).toEqual(baseVenta);
    expect(alteredCompra).toEqual(baseCompra);
  });

  it('un registro sin strategic* sigue siendo válido', () => {
    const { strategicBuyPrice, strategicSellPrice, strategicSpreadPct, ...legacyShape } = base[0];
    const report = buildDailyProjection([legacyShape as HistoryRecord], at(20, 20));

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
