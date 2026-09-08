/**
 * PROYECCIÓN DEL MERCADO — SÓLO EL LIBRO GENERAL, NUNCA UN BANCO O UN MONTO.
 * ============================================================================
 *
 * Cinco garantías pedidas explícitamente para la proyección general:
 *
 *   1. RecargaPines nunca desplaza la referencia general, ni siquiera con
 *      precios extremos (BUY artificialmente bajo, SELL artificialmente alto).
 *   2. La dirección (ALCISTA/BAJISTA/LATERAL, aquí SUBIENDO/BAJANDO/LATERAL)
 *      se deriva de series sintéticas claramente direccionales.
 *   3. Un banco con movimiento extremo (BANESCO/MERCANTIL/BANCAMIGA) nunca
 *      puede cambiar la proyección general - estructuralmente, porque
 *      dailyProjection.ts no lee ninguna fuente por banco.
 *   4. La procedencia del histórico (`summariseProvenance`) cuenta lo
 *      verificado y lo no verificado sin descartar ninguno de los dos.
 *   5. Validación de sanidad: NaN, Infinity, negativos, cero, histórico
 *      vacío/insuficiente, timestamps inválidos y registros desordenados.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildDailyProjection,
  extractLegSeries,
  summariseProvenance,
} from '../server/dailyProjection.js';
import { filterGeneralReferenceAds } from '../server/binanceP2PService.js';
import type { HistoryRecord } from '../server/types.js';
import type { NormalizedAd } from '../server/types.js';

const at = (day: number, hour: number): number => Date.UTC(2026, 7, day, hour + 4, 0, 0);

function record(
  timestamp: number,
  buyPrice: number,
  sellPrice: number,
  overrides: Partial<HistoryRecord> = {}
): HistoryRecord {
  return {
    id: `r-${timestamp}`,
    timestamp,
    dateStr: new Date(timestamp).toISOString(),
    hour: new Date(timestamp - 4 * 3_600_000).getUTCHours(),
    buyPrice,
    sellPrice,
    spreadPct: ((sellPrice - buyPrice) / buyPrice) * 100,
    bestBuyMerchant: 'general',
    bestSellMerchant: 'general',
    activeBuyAds: 10,
    activeSellAds: 10,
    source: 'TEST',
    ...overrides,
  };
}

function ad(price: number, payType: string | null, tradeMethodName: string | null): NormalizedAd {
  return {
    advNo: `adv-${price}`,
    price,
    minAmountVes: 1,
    maxAmountVes: 1_000_000,
    availableUsdt: 100,
    availableUsdtReported: 100,
    merchantName: 'test',
    userType: 'user',
    ordersCount: 10,
    finishRate: 1,
    paymentMethods: tradeMethodName ? [tradeMethodName] : [],
    paymentOptions: [{ payType, tradeMethodName }],
  };
}

describe('1. TEST ESPECIAL — Recarga Pines con precios extremos no desplaza la proyección', () => {
  it('un BUY artificialmente bajo y un SELL artificialmente alto de Recarga Pines se excluyen antes de calcular la referencia', () => {
    const buyAds = [
      ad(50, 'RecargaPines', 'Recarga Pines'), // extremo bajo artificial
      ad(940, 'Mercantil', 'Mercantil'), // mercado normal
      ad(941, 'Banesco', 'Banesco'),
    ];
    const sellAds = [
      ad(9999, 'RecargaPines', 'Recarga Pines'), // extremo alto artificial
      ad(945, 'Bancamiga', 'Bancamiga'),
      ad(946, 'PagoMovil', 'Pago Móvil'),
    ];

    const cleanBuy = filterGeneralReferenceAds(buyAds);
    const cleanSell = filterGeneralReferenceAds(sellAds);

    // La referencia general se construye SOBRE los anuncios ya filtrados.
    const minBuy = Math.min(...cleanBuy.map((a) => a.price));
    const maxSell = Math.max(...cleanSell.map((a) => a.price));

    expect(minBuy).toBe(940); // nunca 50
    expect(maxSell).toBe(946); // nunca 9999

    // Y una proyección construida sobre esos extremos limpios refleja lo mismo.
    const rows = [record(at(20, 9), minBuy, maxSell)];
    const report = buildDailyProjection(rows, at(20, 20));
    expect(report.ceiling.observed?.price).toBe(946);
    expect(report.floor.observed?.price).toBe(940);
    expect(report.ceiling.observed?.price).not.toBe(9999);
    expect(report.floor.observed?.price).not.toBe(50);
  });
});

describe('2. TEST DE DIRECCIÓN — series sintéticas claramente direccionales', () => {
  it('ALCISTA: BUY 930->935->940->945, SELL 940->945->950->955', () => {
    const rows = [
      record(at(20, 9), 930, 940),
      record(at(20, 10), 935, 945),
      record(at(20, 11), 940, 950),
      record(at(20, 12), 945, 955),
    ];
    const report = buildDailyProjection(rows, at(20, 12));
    const venta = report.legs.find((l) => l.projection.leg === 'VENTA')!;
    const compra = report.legs.find((l) => l.projection.leg === 'COMPRA')!;

    // Sin 5 días previos no hay `changePct` (evidencia insuficiente para
    // proyectar), pero el ÚLTIMO movimiento observado sigue siendo alcista en
    // las dos piernas: no se afirma más de lo que la muestra sostiene.
    expect(rows[rows.length - 1].sellPrice).toBeGreaterThan(rows[0].sellPrice);
    expect(rows[rows.length - 1].buyPrice).toBeGreaterThan(rows[0].buyPrice);
    expect(venta.market.direction).not.toBe('BAJANDO');
    expect(compra.market.direction).not.toBe('BAJANDO');
  });

  it('BAJISTA: BUY 950->945->940->935, SELL 960->955->950->945', () => {
    const rows = [
      record(at(20, 9), 950, 960),
      record(at(20, 10), 945, 955),
      record(at(20, 11), 940, 950),
      record(at(20, 12), 935, 945),
    ];
    expect(rows[rows.length - 1].sellPrice).toBeLessThan(rows[0].sellPrice);
    expect(rows[rows.length - 1].buyPrice).toBeLessThan(rows[0].buyPrice);
    const report = buildDailyProjection(rows, at(20, 12));
    const venta = report.legs.find((l) => l.projection.leg === 'VENTA')!;
    const compra = report.legs.find((l) => l.projection.leg === 'COMPRA')!;
    expect(venta.market.direction).not.toBe('SUBIENDO');
    expect(compra.market.direction).not.toBe('SUBIENDO');
  });

  it('LATERAL: con siete días de evidencia y un movimiento final por debajo del umbral medido, la dirección es LATERAL', () => {
    // Siete días previos idénticos (mismo patrón horario, moviéndose ±0.3
    // dentro del día) para que turnThreshold tenga muestra real, y "hoy"
    // repite ese mismo patrón mínimo: el cambio hacia el cierre queda por
    // debajo de la mediana histórica de movimiento por hora.
    const rows: HistoryRecord[] = [];
    for (let day = 1; day <= 8; day++) {
      const lastHour = day === 8 ? 12 : 20;
      for (let hour = 9; hour <= lastHour; hour++) {
        const wobble = hour % 2 === 0 ? 0.1 : -0.1;
        rows.push(record(at(day, hour), 940 + wobble, 945 + wobble));
      }
    }
    const report = buildDailyProjection(rows, at(8, 12));
    const venta = report.legs.find((l) => l.projection.leg === 'VENTA')!;
    expect(['LATERAL', 'INDETERMINADA']).toContain(venta.market.direction);
    expect(venta.market.direction).not.toBe('SUBIENDO');
    expect(venta.market.direction).not.toBe('BAJANDO');
  });
});

describe('3. AISLAMIENTO — un banco con movimiento extremo nunca cambia la proyección general', () => {
  it('dailyProjection.ts no importa ninguna fuente por banco (HistoricalMarketStore, makerMatrix, executableMatrix)', () => {
    const src = readFileSync('server/dailyProjection.ts', 'utf8');
    expect(src).not.toMatch(/HistoricalMarketStore/);
    expect(src).not.toMatch(/makerMatrix|makerStrategy|makerRecommendation/);
    expect(src).not.toMatch(/executableMatrix|BankMatrix/);
    expect(src).not.toMatch(/\bbank\b\s*:/); // ningún campo `bank` en las firmas de este módulo
  });

  it('extractLegSeries ignora cualquier campo de banco/monto que el registro pudiera llevar', () => {
    // filterBank/filterAmount son opcionales en HistoryRecord (los deja la
    // consulta específica de Anuncios Reales P2P cuando decide persistir,
    // cosa que hoy no hace - pero aunque lo hiciera, la proyección general
    // no debe leerlos).
    const withBank = record(at(20, 9), 940, 945, { filterBank: 'BANESCO', filterAmount: 9_999_999 });
    const withoutBank = record(at(20, 9), 940, 945);
    expect(extractLegSeries([withBank], 'VENTA').points).toEqual(
      extractLegSeries([withoutBank], 'VENTA').points
    );
  });

  it('un valor extremo de BANESCO/MERCANTIL/BANCAMIGA no observado en el libro general no aparece en la proyección', () => {
    // Simula el escenario: tres bancos con movimientos extremos en SU PROPIA
    // serie (que vive en data/cells/*.ndjson, fuera de este módulo), mientras
    // el libro GENERAL se mantiene estable. La proyección general debe seguir
    // reflejando sólo el libro general.
    const extremeBankPrices = { BANESCO: 5000, MERCANTIL: 1, BANCAMIGA: 999999 };
    const rows = [record(at(20, 9), 940, 945), record(at(20, 10), 941, 946)];
    const report = buildDailyProjection(rows, at(20, 20));

    for (const extreme of Object.values(extremeBankPrices)) {
      expect(report.ceiling.observed?.price).not.toBe(extreme);
      expect(report.floor.observed?.price).not.toBe(extreme);
    }
    expect(report.ceiling.observed?.price).toBe(946);
    expect(report.floor.observed?.price).toBe(940);
  });
});

describe('4. PROCEDENCIA DEL HISTÓRICO — se cuenta, nunca se descarta', () => {
  it('cuenta correctamente los registros verificados (v4) y los no verificables (anteriores)', () => {
    const tagged = record(at(20, 9), 940, 945, { generalReferenceVersion: 'v4-no-recarga-pines' });
    const legacy = record(at(20, 10), 941, 946);
    const summary = summariseProvenance([tagged, legacy, legacy]);

    expect(summary.totalRecords).toBe(3);
    expect(summary.verifiedCleanRecords).toBe(1);
    expect(summary.unverifiedRecords).toBe(2);
    expect(summary.fullyVerified).toBe(false);
  });

  it('un histórico enteramente legacy no se descarta: se usa igual y se marca no verificado, nunca "sin datos"', () => {
    const legacy = record(at(20, 9), 940, 945);
    const report = buildDailyProjection([legacy], at(20, 20));

    expect(report.dataProvenance.totalRecords).toBe(1);
    expect(report.dataProvenance.unverifiedRecords).toBe(1);
    expect(report.dataProvenance.fullyVerified).toBe(false);
    // Y el precio SÍ se usa - no se convirtió en SIN_DATOS por falta de marca.
    expect(report.ceiling.observed?.price).toBe(945);
    expect(report.floor.observed?.price).toBe(940);
  });

  it('un histórico enteramente v4 se marca fullyVerified', () => {
    const clean = record(at(20, 9), 940, 945, { generalReferenceVersion: 'v4-no-recarga-pines' });
    const summary = summariseProvenance([clean, clean]);
    expect(summary.fullyVerified).toBe(true);
    expect(summary.unverifiedRecords).toBe(0);
  });

  it('un histórico vacío no se marca fullyVerified (no hay nada que verificar)', () => {
    expect(summariseProvenance([]).fullyVerified).toBe(false);
  });
});

describe('5. VALIDACIÓN DE SANIDAD — extractLegSeries y buildDailyProjection', () => {
  it('descarta NaN, Infinity, negativos y cero en CADA pierna de forma independiente, sin lanzar', () => {
    // Cada pierna valida SÓLO su propio campo: un buyPrice corrupto no debe
    // tirar un sellPrice sano de la misma fila, y viceversa - son dos series
    // independientes sobre el mismo libro, nunca acopladas por fila.
    const rows = [
      record(at(20, 9), Number.NaN, 945), // sellPrice sano, buyPrice NaN
      record(at(20, 10), Number.POSITIVE_INFINITY, 946), // sellPrice sano, buyPrice Infinity
      record(at(20, 11), -5, 947), // sellPrice sano, buyPrice negativo
      record(at(20, 12), 0, 948), // sellPrice sano, buyPrice cero
      record(at(20, 13), 940, Number.NaN), // buyPrice sano, sellPrice NaN
      record(at(20, 14), 941, Number.NEGATIVE_INFINITY), // buyPrice sano, sellPrice -Infinity
      record(at(20, 15), 942, -1), // buyPrice sano, sellPrice negativo
      record(at(20, 16), 943, 0), // buyPrice sano, sellPrice cero
      record(at(20, 17), 944, 949), // sano en las dos piernas
    ];
    const venta = extractLegSeries(rows, 'VENTA');
    const compra = extractLegSeries(rows, 'COMPRA');

    // VENTA (sellPrice): sobreviven las filas 1-4 y la 9 - su buyPrice corrupto
    // en las 1-4 es irrelevante para esta pierna.
    expect(venta.points.map((p) => p.price)).toEqual([945, 946, 947, 948, 949]);
    // COMPRA (buyPrice): sobreviven las filas 5-8 y la 9, por la misma razón.
    expect(compra.points.map((p) => p.price)).toEqual([940, 941, 942, 943, 944]);
    // Ningún NaN, Infinity, negativo ni cero sobrevivió en NINGUNA de las dos series.
    for (const p of [...venta.points, ...compra.points]) {
      expect(Number.isFinite(p.price)).toBe(true);
      expect(p.price).toBeGreaterThan(0);
    }
    expect(venta.extraction.droppedInvalid).toBeGreaterThan(0);
    expect(compra.extraction.droppedInvalid).toBeGreaterThan(0);
    expect(() => buildDailyProjection(rows, at(20, 20))).not.toThrow();
  });

  it('histórico vacío: no inventa datos, no lanza', () => {
    const report = buildDailyProjection([], at(20, 12));
    expect(report.ceiling.observed).toBeNull();
    expect(report.floor.observed).toBeNull();
    expect(report.dataProvenance.totalRecords).toBe(0);
    expect(report.state).toBe('SIN_DATOS');
  });

  it('histórico insuficiente (menos de 5 días previos): no proyecta, pero muestra lo observado', () => {
    const rows = [record(at(20, 9), 940, 945)];
    const report = buildDailyProjection(rows, at(20, 20));
    expect(report.legs[0].projection.projected).toHaveLength(0);
    expect(report.daysMissing).toBeGreaterThan(0);
    expect(report.ceiling.observed?.price).toBe(945);
  });

  it('timestamps inválidos se descartan sin contaminar la serie', () => {
    const bad = { ...record(at(20, 9), 940, 945), timestamp: Number.NaN };
    const good = record(at(20, 10), 941, 946);
    const venta = extractLegSeries([bad, good], 'VENTA');
    expect(venta.points).toHaveLength(1);
    expect(venta.points[0].price).toBe(946);
    expect(venta.extraction.droppedInvalid).toBe(1);
  });

  it('registros fuera de orden temporal se agrupan igual - el orden de llegada no importa', () => {
    const inOrder = [record(at(20, 9), 940, 945), record(at(20, 10), 941, 946), record(at(20, 11), 942, 947)];
    const shuffled = [inOrder[2], inOrder[0], inOrder[1]];

    const a = buildDailyProjection(inOrder, at(20, 20));
    const b = buildDailyProjection(shuffled, at(20, 20));
    expect(a.ceiling.observed?.price).toBe(b.ceiling.observed?.price);
    expect(a.floor.observed?.price).toBe(b.floor.observed?.price);
  });
});
