/**
 * CONTRATO DE LA PANTALLA DE PROYECCIONES
 *
 * La proyección general responde sólo a "hacia dónde se mueve el mercado".
 * No recibe banco, monto ni medio de pago/payType como dimensión de cálculo.
 *
 * Fuente única de precios:
 *   VENTA  = máximo de HistoryRecord.sellPrice
 *   COMPRA = mínimo de HistoryRecord.buyPrice
 *
 * Los campos strategic* se mantienen en HistoryRecord para otras funciones,
 * pero están explícitamente fuera de este contrato.
 */

import { describe, expect, it } from 'vitest';
import { buildDailyProjection, extractLegSeries, FIELD_FOR_LEG } from '../server/dailyProjection.js';
import type { HistoryRecord } from '../server/types.js';

const t = (hour: number) => Date.UTC(2026, 7, 20, hour + 4, 0, 0);

const row = (
  hour: number,
  buyPrice: number,
  sellPrice: number,
  strategicBuyPrice = 5000,
  strategicSellPrice = 100,
): HistoryRecord => ({
  id: `r-${hour}-${buyPrice}-${sellPrice}`,
  timestamp: t(hour),
  dateStr: new Date(t(hour)).toISOString(),
  hour,
  buyPrice,
  sellPrice,
  spreadPct: ((sellPrice - buyPrice) / buyPrice) * 100,
  bestBuyMerchant: 'general',
  bestSellMerchant: 'general',
  activeBuyAds: 20,
  activeSellAds: 20,
  source: 'TEST',
  calculationVersion: 'v2-strategic',
  strategicBuyPrice,
  strategicSellPrice,
  strategicSpreadPct: ((strategicSellPrice - strategicBuyPrice) / strategicBuyPrice) * 100,
});

describe('fuente de la proyección general', () => {
  it('declara los campos crudos como única fuente de cada pierna', () => {
    expect(FIELD_FOR_LEG).toEqual({ VENTA: 'sellPrice', COMPRA: 'buyPrice' });
  });

  it('VENTA toma el precio SELL más alto y COMPRA el BUY más bajo', () => {
    const records = [row(9, 930, 950), row(10, 940, 960), row(11, 935, 955)];
    const report = buildDailyProjection(records, t(20));

    expect(report.ceiling.observed?.price).toBe(960);
    expect(report.ceiling.leg).toBe('VENTA');
    expect(report.floor.observed?.price).toBe(930);
    expect(report.floor.leg).toBe('COMPRA');
  });

  it('no usa el máximo o mínimo global mezclando las dos piernas', () => {
    const records = [row(9, 930, 950), row(10, 936, 945), row(11, 940, 920)];
    const report = buildDailyProjection(records, t(20));

    // MAX sellPrice = 950; MIN buyPrice = 930.
    expect(report.ceiling.observed?.price).toBe(950);
    expect(report.floor.observed?.price).toBe(930);
  });
});

describe('bank/payType no forman parte de la serie general', () => {
  it('cambiar strategic* no cambia ninguna serie de precios proyectada', () => {
    const base = [row(9, 930, 950, 5000, 100), row(10, 940, 960, 5100, 101)];
    const altered = base.map((r) => ({
      ...r,
      strategicBuyPrice: 1,
      strategicSellPrice: 999999,
      strategicSpreadPct: 999999,
    }));

    expect(extractLegSeries(altered, 'VENTA').points.map((p) => p.price)).toEqual(
      extractLegSeries(base, 'VENTA').points.map((p) => p.price)
    );
    expect(extractLegSeries(altered, 'COMPRA').points.map((p) => p.price)).toEqual(
      extractLegSeries(base, 'COMPRA').points.map((p) => p.price)
    );
  });

  it('la proyección general no requiere datos estratégicos', () => {
    const raw = { ...row(9, 930, 950) };
    delete raw.strategicBuyPrice;
    delete raw.strategicSellPrice;
    delete raw.strategicSpreadPct;
    const report = buildDailyProjection([raw], t(20));

    expect(report.ceiling.observed?.price).toBe(950);
    expect(report.floor.observed?.price).toBe(930);
  });
});

// CI guard: this contract is intentionally independent of bank/payType filters.
