/**
 * QUÉ SERIE ALIMENTA AL PREDICTOR, Y QUÉ SE QUEDA FUERA
 * ====================================================
 *
 * El motor estadístico está probado en las otras suites. Aquí se prueba la
 * decisión ANTERIOR a la estadística, que es la que puede equivocarse sin que
 * ningún número parezca raro: de dónde se leen los datos, qué campo se
 * proyecta y qué se descarta.
 *
 * Los registros son FIXTURES SINTÉTICOS. Ninguno se escribe en `data/`.
 */

import { describe, expect, it } from 'vitest';
import {
  buildMarketProjection,
  buildMarketProjectionAsync,
  extractStrategicSeries,
} from '../server/marketProjection.js';
import { H15, MINUTE, T0, historyRecord, syntheticHistory } from './helpers/projectionSeries.js';

describe('qué campo se proyecta', () => {
  it('usa la mediana estratégica, no el extremo crudo del libro', () => {
    const records = [historyRecord(0), historyRecord(1)];

    // Los extremos crudos existen en el registro y valen otra cosa. Si el
    // predictor los cogiera estaría midiendo la varianza de un solo anuncio.
    expect(records[0].buyPrice).not.toBe(records[0].strategicBuyPrice);
    expect(records[0].sellPrice).not.toBe(records[0].strategicSellPrice);

    expect(extractStrategicSeries(records, 'BUY').points.map((p) => p.price)).toEqual([
      records[0].strategicBuyPrice,
      records[1].strategicBuyPrice,
    ]);
    expect(extractStrategicSeries(records, 'SELL').points.map((p) => p.price)).toEqual([
      records[0].strategicSellPrice,
      records[1].strategicSellPrice,
    ]);
  });

  it('no invierte los lados: BUY sigue siendo el ask y SELL el bid', () => {
    // La semántica ya corregida del proyecto: el ask está por encima del bid en
    // estos fixtures, y el adaptador no puede cruzarlos.
    const records = [historyRecord(0)];
    const buy = extractStrategicSeries(records, 'BUY').points[0].price;
    const sell = extractStrategicSeries(records, 'SELL').points[0].price;

    expect(buy).toBe(records[0].strategicBuyPrice);
    expect(sell).toBe(records[0].strategicSellPrice);
    expect(buy).not.toBe(sell);
  });

  it('descarta los registros v1 y NO les inventa un precio estratégico', () => {
    const records = [
      historyRecord(0),
      // v1: nunca tuvo mediana y no hay forma de recuperarla.
      historyRecord(1, {
        calculationVersion: undefined,
        strategicBuyPrice: undefined,
        strategicSellPrice: undefined,
      }),
      historyRecord(2),
    ];

    for (const side of ['BUY', 'SELL'] as const) {
      const extracted = extractStrategicSeries(records, side);
      expect(extracted.points).toHaveLength(2);
      expect(extracted.droppedLegacy).toBe(1);
      expect(extracted.recordsRead).toBe(3);
      expect(extracted.points.map((p) => p.t)).toEqual([T0, T0 + 2 * MINUTE]);
    }
  });

  it('un registro sin strategicSellPrice sólo invalida el lado SELL', () => {
    // El lado BUY de ese mismo registro sigue siendo perfectamente válido.
    const records = [historyRecord(0), historyRecord(1, { strategicSellPrice: undefined })];

    expect(extractStrategicSeries(records, 'BUY').points).toHaveLength(2);
    expect(extractStrategicSeries(records, 'SELL').points).toHaveLength(1);
    expect(extractStrategicSeries(records, 'SELL').droppedInvalid).toBe(1);
  });

  it('publica lo que descartó, para que una serie corta se pueda explicar', () => {
    const records = [
      historyRecord(0),
      historyRecord(1, { strategicBuyPrice: Number.NaN }),
      historyRecord(2, { strategicBuyPrice: 0 }),
      historyRecord(3, { strategicBuyPrice: -940 }),
      historyRecord(4, { timestamp: Number.NaN }),
      historyRecord(5, { calculationVersion: undefined, strategicBuyPrice: undefined }),
    ];

    const extracted = extractStrategicSeries(records, 'BUY');
    expect(extracted.points).toHaveLength(1);
    expect(extracted.droppedInvalid).toBe(4);
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
    const report = buildMarketProjection({
      readRecords: () => syntheticHistory(1200),
      horizonsMs: [H15],
      now: T0,
    });

    expect(report.source).toBe('market_history.json');
    expect(report.generatedAt).toBe(T0);
  });

  it('proyecta los dos lados por separado, cada uno con su propia serie', () => {
    const report = buildMarketProjection({
      readRecords: () => syntheticHistory(1200),
      horizonsMs: [H15],
    });

    expect(report.sides.map((s) => s.side)).toEqual(['BUY', 'SELL']);
    expect(report.sides[0].seriesId).toBe('STRATEGIC_BUY');
    expect(report.sides[1].seriesId).toBe('STRATEGIC_SELL');
    // Dos mercados distintos: si el precio actual coincidiera, se habría
    // proyectado la misma serie dos veces.
    expect(report.sides[0].currentPrice).not.toBe(report.sides[1].currentPrice);
  });

  it('arrastra al informe lo que se descartó de cada lado', () => {
    const records = syntheticHistory(1200);
    records[5] = historyRecord(5, {
      calculationVersion: undefined,
      strategicBuyPrice: undefined,
    });

    const report = buildMarketProjection({ readRecords: () => records, horizonsMs: [H15] });

    expect(report.sides[0].extraction.recordsRead).toBe(1200);
    expect(report.sides[0].extraction.droppedLegacy).toBe(1);
    expect(report.sides[0].observations).toBe(1199);
  });

  it('corrige el umbral contando los contrastes de LOS DOS lados', () => {
    const report = buildMarketProjection({
      readRecords: () => syntheticHistory(2000),
      horizonsMs: [H15],
    });

    const tested = report.sides.flatMap((s) => s.baselines).filter((b) => b.pValue !== null);
    expect(tested.length).toBeGreaterThan(1);
    for (const baseline of tested) {
      // La familia son los dos lados juntos: quien mira la pantalla ve ambos y
      // se queda con el que salga bien.
      expect(baseline.familySize).toBe(tested.length);
    }
  });

  it('sobre datos sin estructura no se declara utilizable', () => {
    const report = buildMarketProjection({
      readRecords: () => syntheticHistory(2000, 23),
      horizonsMs: [H15],
    });

    expect(report.usable).toBe(false);
    for (const side of report.sides) {
      expect(side.notice).not.toBeNull();
      for (const horizon of side.horizons.filter((h) => h.available)) {
        expect(horizon.status).not.toBe('READY');
      }
    }
  });

  it('degrada a INSUFICIENTE HISTÓRICO sin histórico, en lugar de lanzar', () => {
    const report = buildMarketProjection({ readRecords: () => [], horizonsMs: [H15] });

    expect(report.usable).toBe(false);
    for (const side of report.sides) {
      expect(side.observations).toBe(0);
      expect(side.currentPrice).toBeNull();
      expect(side.horizons[0].status).toBe('INSUFFICIENT_DATA');
      expect(side.notice).toContain('INSUFICIENTE HISTÓRICO');
    }
  });

  it('un histórico entero en v1 no produce ninguna proyección', () => {
    const legacy = syntheticHistory(1200).map((r) => ({
      ...r,
      calculationVersion: undefined,
      strategicBuyPrice: undefined,
      strategicSellPrice: undefined,
    }));

    const report = buildMarketProjection({ readRecords: () => legacy, horizonsMs: [H15] });

    for (const side of report.sides) {
      expect(side.observations).toBe(0);
      expect(side.extraction.droppedLegacy).toBe(1200);
      expect(side.horizons[0].available).toBe(false);
    }
    expect(report.usable).toBe(false);
  });

  it('la variante asíncrona produce el mismo informe que la síncrona', async () => {
    const records = syntheticHistory(1200);
    const options = { readRecords: () => records, horizonsMs: [H15], now: T0 };

    const sync = buildMarketProjection(options);
    const async = await buildMarketProjectionAsync(options);

    expect(JSON.stringify(async)).toBe(JSON.stringify(sync));
  });
});
