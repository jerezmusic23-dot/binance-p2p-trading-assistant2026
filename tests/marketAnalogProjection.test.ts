/**
 * QUÉ SERIE ALIMENTA AL PREDICTOR, Y QUÉ SE QUEDA FUERA
 * ====================================================
 *
 * El motor estadístico está probado en analogProjection.test.ts. Aquí se
 * prueba la decisión anterior a la estadística, que es la que puede
 * equivocarse sin que ningún número parezca raro: de dónde se leen los datos,
 * qué campo se proyecta, y qué se descarta.
 *
 * Los registros son SINTÉTICOS. Ninguno se escribe en `data/`.
 */

import { describe, expect, it } from 'vitest';
import {
  buildMarketAnalogProjection,
  extractStrategicSeries,
} from '../server/marketAnalogProjection.js';
import type { HistoryRecord } from '../server/types.js';

const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);
const MINUTE = 60_000;
const H30 = 30 * MINUTE;

function record(i: number, overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  const buy = 940 + i * 0.01;
  const sell = 945 + i * 0.01;
  return {
    id: `r${i}`,
    timestamp: T0 + i * MINUTE,
    dateStr: '2026-08-01',
    hour: 0,
    // Extremos crudos del libro: deliberadamente distintos de los estratégicos.
    buyPrice: buy - 3,
    sellPrice: sell + 3,
    spreadPct: 0,
    bestBuyMerchant: 'A',
    bestSellMerchant: 'B',
    activeBuyAds: 20,
    activeSellAds: 20,
    source: 'test',
    calculationVersion: 'v2-strategic',
    strategicBuyPrice: Number(buy.toFixed(4)),
    strategicSellPrice: Number(sell.toFixed(4)),
    strategicSpreadPct: 0,
    ...overrides,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Histórico sintético con los dos lados moviéndose de forma independiente. */
function history(count: number, seed = 17): HistoryRecord[] {
  const rnd = mulberry32(seed);
  let buy = 940;
  let sell = 945;
  return Array.from({ length: count }, (_, i) => {
    buy += (rnd() < 0.5 ? -1 : 1) * 0.01;
    sell += (rnd() < 0.5 ? -1 : 1) * 0.02;
    return record(i, {
      strategicBuyPrice: Number(buy.toFixed(4)),
      strategicSellPrice: Number(sell.toFixed(4)),
    });
  });
}

describe('qué campo se proyecta', () => {
  it('usa la mediana estratégica, no el extremo crudo del libro', () => {
    const records = [record(0), record(1)];

    // Los extremos crudos existen en el registro y valen otra cosa. Si el
    // predictor los cogiera, estaría midiendo la varianza de un solo anuncio.
    expect(records[0].buyPrice).not.toBe(records[0].strategicBuyPrice);
    expect(extractStrategicSeries(records, 'BUY').points.map((p) => p.price)).toEqual([
      records[0].strategicBuyPrice,
      records[1].strategicBuyPrice,
    ]);
    expect(extractStrategicSeries(records, 'SELL').points.map((p) => p.price)).toEqual([
      records[0].strategicSellPrice,
      records[1].strategicSellPrice,
    ]);
  });

  it('descarta los registros v1 y NO les inventa un precio estratégico', () => {
    const records = [
      record(0),
      // v1: nunca tuvo mediana y no hay forma de recuperarla.
      record(1, {
        calculationVersion: undefined,
        strategicBuyPrice: undefined,
        strategicSellPrice: undefined,
      }),
      record(2),
    ];

    const extracted = extractStrategicSeries(records, 'BUY');
    expect(extracted.points).toHaveLength(2);
    expect(extracted.droppedLegacy).toBe(1);
    expect(extracted.recordsRead).toBe(3);
    expect(extracted.points.map((p) => p.t)).toEqual([T0, T0 + 2 * MINUTE]);
  });

  it('publica lo que descartó, para que una serie corta se pueda explicar', () => {
    const records = [
      record(0),
      record(1, { strategicBuyPrice: Number.NaN }),
      record(2, { strategicBuyPrice: 0 }),
      record(3, { timestamp: Number.NaN }),
      record(4, { calculationVersion: undefined, strategicBuyPrice: undefined }),
    ];

    const extracted = extractStrategicSeries(records, 'BUY');
    expect(extracted.points).toHaveLength(1);
    expect(extracted.droppedInvalid).toBe(3);
    expect(extracted.droppedLegacy).toBe(1);
  });

  it('no lanza con un histórico vacío', () => {
    expect(extractStrategicSeries([], 'BUY')).toEqual({
      points: [],
      recordsRead: 0,
      droppedLegacy: 0,
      droppedInvalid: 0,
    });
  });
});

describe('el informe de mercado', () => {
  it('nombra su fuente en lugar de dejar que la pantalla la suponga', () => {
    const report = buildMarketAnalogProjection({
      readRecords: () => history(1400),
      horizonsMs: [H30],
      now: T0,
    });

    expect(report.source).toBe('market_history.json');
    expect(report.generatedAt).toBe(T0);
  });

  it('proyecta los dos lados por separado, cada uno con su propia serie', () => {
    const report = buildMarketAnalogProjection({
      readRecords: () => history(1400),
      horizonsMs: [H30],
    });

    expect(report.sides.map((s) => s.side)).toEqual(['BUY', 'SELL']);
    expect(report.sides[0].seriesId).toBe('STRATEGIC_BUY');
    expect(report.sides[1].seriesId).toBe('STRATEGIC_SELL');
    // Dos mercados distintos: si el precio actual coincidiera, se habría
    // proyectado la misma serie dos veces.
    expect(report.sides[0].currentPrice).not.toBe(report.sides[1].currentPrice);
    expect(report.sides[0].label).toContain('BUY');
    expect(report.sides[1].label).toContain('SELL');
  });

  it('arrastra al informe lo que se descartó de cada lado', () => {
    const records = history(1400);
    records[5] = record(5, { calculationVersion: undefined, strategicBuyPrice: undefined });

    const report = buildMarketAnalogProjection({ readRecords: () => records, horizonsMs: [H30] });

    expect(report.sides[0].extraction.recordsRead).toBe(1400);
    expect(report.sides[0].extraction.droppedLegacy).toBe(1);
    expect(report.sides[0].observations).toBe(1399);
  });

  it('corrige el umbral contando los contrastes de LOS DOS lados', () => {
    const report = buildMarketAnalogProjection({
      readRecords: () => history(2400),
      horizonsMs: [H30],
    });

    const tested = report.sides.flatMap((s) => s.baselines).filter((b) => b.pValue !== null);
    expect(tested.length).toBeGreaterThan(1);
    for (const baseline of tested) {
      // La familia son los dos lados juntos, no cada lado por su cuenta:
      // quien mira la pantalla ve ambos y se queda con el que salga bien.
      expect(baseline.familySize).toBe(tested.length);
    }
  });

  it('sobre datos sin estructura no se declara utilizable', () => {
    const report = buildMarketAnalogProjection({
      readRecords: () => history(2400, 23),
      horizonsMs: [H30],
    });

    expect(report.usable).toBe(false);
    for (const side of report.sides) {
      expect(side.notice).not.toBeNull();
    }
  });

  it('degrada a INSUFICIENTE HISTÓRICO sin histórico, en lugar de lanzar', () => {
    const report = buildMarketAnalogProjection({ readRecords: () => [], horizonsMs: [H30] });

    expect(report.usable).toBe(false);
    for (const side of report.sides) {
      expect(side.observations).toBe(0);
      expect(side.currentPrice).toBeNull();
      expect(side.horizons[0].available).toBe(false);
      expect(side.notice).toContain('INSUFICIENTE HISTÓRICO');
    }
  });

  it('un histórico entero en v1 no produce ninguna proyección', () => {
    const legacy = history(1400).map((r) => ({
      ...r,
      calculationVersion: undefined,
      strategicBuyPrice: undefined,
      strategicSellPrice: undefined,
    }));

    const report = buildMarketAnalogProjection({ readRecords: () => legacy, horizonsMs: [H30] });

    for (const side of report.sides) {
      expect(side.observations).toBe(0);
      expect(side.extraction.droppedLegacy).toBe(1400);
      expect(side.horizons[0].available).toBe(false);
    }
    expect(report.usable).toBe(false);
  });
});
