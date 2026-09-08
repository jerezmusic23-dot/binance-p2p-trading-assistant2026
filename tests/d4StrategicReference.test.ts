/**
 * D4 — LA PROYECCIÓN GENERAL PARTE DE LA REFERENCIA ESTRATÉGICA
 *
 * Antes, `PROYECCIÓN DEL MERCADO · GENERAL USDT/VES` proyectaba los EXTREMOS
 * crudos (`buyPrice`/`sellPrice`) mientras D2 ya había creado una referencia
 * robusta que sólo consumía el motor de decisión. Un único anuncio anómalo
 * quedaba, por tanto, en la base de la proyección de esa pantalla.
 *
 * Estos tests fijan las cuatro cosas que NO deben mezclarse:
 *   precio ejecutable · referencia estratégica · proyección · arbitraje.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDailyProjection,
  EXECUTABLE_FIELD,
  extractLegSeries,
  FIELD_FOR_LEG,
  latestExecutableExtreme,
} from '../server/dailyProjection.js';
import { classifyAd, isExecutionEligible, isReferenceEligible } from '../server/adQuality.js';
import { evaluateBankAmount } from '../server/executability.js';
import { buildOpportunity } from '../server/opportunityEngine.js';
import { BANK_CODE_MAP } from '../server/binanceP2PService.js';
import type { HistoryRecord, NormalizedAd } from '../server/types.js';

const at = (day: number, hour: number) => Date.UTC(2026, 7, day, hour + 4, 0, 0);

/** Extremo y referencia deliberadamente distintos, para ver cuál se usa. */
function rec(
  t: number,
  opts: { buy: number; sell: number; sBuy?: number | undefined; sSell?: number | undefined }
): HistoryRecord {
  const base: HistoryRecord = {
    id: `r-${t}`,
    timestamp: t,
    dateStr: new Date(t).toISOString(),
    hour: 0,
    buyPrice: opts.buy,
    sellPrice: opts.sell,
    spreadPct: ((opts.sell - opts.buy) / opts.buy) * 100,
    bestBuyMerchant: 'g',
    bestSellMerchant: 'g',
    activeBuyAds: 20,
    activeSellAds: 20,
    source: 'TEST',
  };
  if (opts.sBuy === undefined || opts.sSell === undefined) return base;
  return {
    ...base,
    calculationVersion: 'v2-strategic',
    strategicBuyPrice: opts.sBuy,
    strategicSellPrice: opts.sSell,
    strategicSpreadPct: ((opts.sSell - opts.sBuy) / opts.sBuy) * 100,
  };
}

/** Un día limpio de referencia, con el extremo envenenado si se pide. */
function day(poison: boolean): HistoryRecord[] {
  return Array.from({ length: 12 }, (_, i) =>
    rec(at(20, 8 + i), {
      buy: poison ? 920.659 : 969.3,
      sell: poison ? 1200 : 970.15,
      sBuy: 969.95,
      sSell: 966.8,
    })
  );
}

const ad = (advNo: string, price: number, over: Partial<NormalizedAd> = {}): NormalizedAd => ({
  advNo,
  price,
  minAmountVes: 5_000,
  maxAmountVes: 200_000,
  availableUsdt: 500,
  availableUsdtReported: 500,
  merchantName: advNo,
  userType: 'user',
  ordersCount: 90,
  finishRate: 0.97,
  paymentMethods: ['Mercantil'],
  paymentOptions: [{ payType: 'Mercantil', tradeMethodName: 'Mercantil' }],
  ...over,
});

/* ── 1 ─────────────────────────────────────────────────────────────── */
describe('1. un outlier no mueve la referencia estratégica', () => {
  it('la serie proyectada es idéntica con y sin extremo envenenado', () => {
    const clean = extractLegSeries(day(false), 'COMPRA').points.map((p) => p.price);
    const poisoned = extractLegSeries(day(true), 'COMPRA').points.map((p) => p.price);
    expect(poisoned).toEqual(clean);
    expect(new Set(poisoned)).toEqual(new Set([969.95]));
  });
});

/* ── 2 ─────────────────────────────────────────────────────────────── */
describe('2. la proyección usa strategic* cuando existe', () => {
  it('FIELD_FOR_LEG nombra la referencia; EXECUTABLE_FIELD nombra el extremo', () => {
    expect(FIELD_FOR_LEG).toEqual({ VENTA: 'strategicSellPrice', COMPRA: 'strategicBuyPrice' });
    expect(EXECUTABLE_FIELD).toEqual({ VENTA: 'sellPrice', COMPRA: 'buyPrice' });
  });

  it('el ancla del informe declara el campo estratégico como origen', () => {
    const report = buildDailyProjection(day(false), at(20, 20));
    for (const leg of report.legs) {
      expect(leg.nowOrigin.field).toMatch(/^strategic(Buy|Sell)Price$/);
      expect(leg.nowOrigin.calculation).toMatch(/referencia estratégica/);
    }
  });
});

/* ── 3 ─────────────────────────────────────────────────────────────── */
describe('3. legacy: sin strategic* se usa el extremo, y se cuenta', () => {
  it('cae al extremo explícitamente y lo declara en legacyRecords', () => {
    const legacy = Array.from({ length: 6 }, (_, i) => rec(at(20, 8 + i), { buy: 969.3, sell: 970.15 }));
    const s = extractLegSeries(legacy, 'COMPRA');
    expect(s.points.map((p) => p.price)).toEqual(Array(6).fill(969.3));
    expect(s.extraction.legacyRecords).toBe(6);
  });

  it('una serie con referencia no cuenta ningún legacy', () => {
    expect(extractLegSeries(day(false), 'COMPRA').extraction.legacyRecords).toBe(0);
  });

  it('no se fabrica una mediana retrospectiva a partir del extremo', () => {
    const legacy = [rec(at(20, 9), { buy: 969.3, sell: 970.15 })];
    // El punto usado ES el extremo, sin inventar un valor intermedio.
    expect(extractLegSeries(legacy, 'VENTA').points[0].price).toBe(970.15);
  });
});

/* ── 4 ─────────────────────────────────────────────────────────────── */
describe('4. la ejecutabilidad no cambia', () => {
  it('el par ejecutable sigue saliendo de los precios ejecutables', () => {
    const codes = BANK_CODE_MAP.MERCANTIL.apiPayTypes;
    const cell = evaluateBankAmount({
      bank: 'MERCANTIL',
      allowedCodes: codes,
      amountVes: 20_000,
      buyAds: [969.299, 969.5, 969.9, 970].map((p, i) => ad(`B${i}`, p)),
      sellAds: [970.15, 967, 966.8, 966.54].map((p, i) => ad(`S${i}`, p)),
    });
    expect(cell.pair!.buy.price).toBe(969.299);
    expect(cell.pair!.sell.price).toBe(970.15);
    expect(buildOpportunity(cell)!.spreadPct).toBeCloseTo(((970.15 - 969.299) / 969.299) * 100, 6);
  });
});

/* ── 5 y 6 ─────────────────────────────────────────────────────────── */
describe('5-6. el contrato D1 de PROMOTED y OUTLIER sigue intacto', () => {
  const book = [969.3, 969.5, 969.9, 970].map((p, i) => ad(`B${i}`, p));
  const other = [970.15, 967, 966.8].map((p, i) => ad(`S${i}`, p));

  it('PROMOTED normal: ejecutable, no referencia', () => {
    const promo = ad('P', 969.4, { promoted: true });
    const v = classifyAd(promo, [promo, ...book], other, 'ASK');
    expect(v.quality).toBe('PROMOTED');
    expect(isExecutionEligible(v.quality)).toBe(true);
    expect(isReferenceEligible(v.quality)).toBe(false);
  });

  it('OUTLIER: ni ejecutable ni referencia', () => {
    const bad = ad('O', 920.659);
    const v = classifyAd(bad, [bad, ...book], other, 'ASK');
    expect(v.quality).toBe('OUTLIER');
    expect(isExecutionEligible(v.quality)).toBe(false);
    expect(isReferenceEligible(v.quality)).toBe(false);
  });
});

/* ── 7 ─────────────────────────────────────────────────────────────── */
describe('7. referencia y precio ejecutable conviven con valores distintos', () => {
  it('ninguno sustituye al otro dentro del mismo informe', () => {
    const report = buildDailyProjection(day(false), at(20, 19));
    const compra = report.legs.find((l) => l.projection.leg === 'COMPRA')!;

    // La referencia (mediana) y el extremo ejecutable son valores DISTINTOS...
    expect(compra.now).toBe(969.95);
    expect(compra.executableExtreme!.price).toBe(969.3);
    expect(compra.now).not.toBe(compra.executableExtreme!.price);

    // ...y cada uno declara de qué campo salió.
    expect(compra.nowOrigin.field).toBe('strategicBuyPrice');
    expect(compra.executableExtreme!.field).toBe('buyPrice');
    expect(compra.executableExtreme!.calculation).toMatch(/observado/);
  });

  it('el extremo ejecutable es un OBSERVADO de la hora en curso, nunca proyectado', () => {
    const points = extractLegSeries(day(false), 'VENTA', 'EXECUTABLE').points;
    const e = latestExecutableExtreme(points, 'VENTA', at(20, 19))!;
    expect(e.price).toBe(970.15);
    expect(e.hour).toBe(19);
    expect(e.observations).toBe(1);
    // Fuera de toda hora observada no se inventa nada.
    expect(latestExecutableExtreme(points, 'VENTA', at(21, 3))).toBeNull();
  });
});

/* ── 8 ─────────────────────────────────────────────────────────────── */
describe('8. la proyección no queda anclada a un extremo artificial', () => {
  it('920.659 en el extremo no ancla ni el ancla ni el techo/piso proyectado', () => {
    const poisoned = buildDailyProjection(day(true), at(20, 20));
    const compra = poisoned.legs.find((l) => l.projection.leg === 'COMPRA')!;

    expect(compra.now).toBe(969.95);
    expect(compra.now).not.toBe(920.659);
    expect(poisoned.floor.observed?.price).not.toBe(920.659);
    expect(poisoned.ceiling.observed?.price).not.toBe(1200);

    // El informe sale idéntico al del mismo día sin envenenar.
    const clean = buildDailyProjection(day(false), at(20, 20));
    expect(compra.now).toBe(clean.legs.find((l) => l.projection.leg === 'COMPRA')!.now);
    expect(poisoned.ceiling.observed?.price).toBe(clean.ceiling.observed?.price);

    /*
     * Y el extremo envenenado SIGUE visible como lo que es. Se mira en la
     * última hora observada (19): a las 20 no hay captura, y ahí el extremo
     * ejecutable es `null` en vez de un valor inventado.
     */
    const enHora19 = buildDailyProjection(day(true), at(20, 19)).legs
      .find((l) => l.projection.leg === 'COMPRA')!;
    expect(enHora19.executableExtreme!.price).toBe(920.659);
    expect(compra.executableExtreme).toBeNull();
  });
});
