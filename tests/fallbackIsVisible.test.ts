/**
 * LA SERIE DE UNA CELDA ES LA SUYA, Y UN PRÉSTAMO SE VE.
 *
 * Las cuatro reglas del operador, y lo que cada una impide:
 *
 *   1. cada celda usa load(bank, amountKey) como serie principal
 *      -> BANESCO 10K no puede leerse con la historia de MERCANTIL 100K
 *   2. el fallback al mercado general sólo cuando corresponde
 *      -> pedir prestado teniendo datos propios sería tirar los datos propios
 *   3. etiquetado explícito MERCADO GENERAL
 *      -> nadie puede tomar una lectura del libro por una de su celda
 *   4. nunca se mezclan matemáticamente
 *      -> una tendencia hecha mitad de una celda y mitad del mercado no
 *         describe ninguna de las dos
 *
 * Y una quinta que se sigue de las anteriores: una lectura prestada no debe
 * producir señales que aparenten ser de esa celda. Con 42 celdas, un único
 * hallazgo del mercado general se convertiría en 42 notificaciones idénticas.
 */

import { describe, expect, it } from 'vitest';
import { projectCell, MIN_OBSERVATIONS_FOR_OWN_READING } from '../server/makerProjectionEngine.js';
import { EMPTY_SIGNAL_MEMORY, evaluateSignals } from '../server/signalEngine.js';
import { ramp, seriesFromBuyPrices } from './helpers/series.js';
import type { HistoricalObservation } from '../server/historicalMarketStore.js';

const CELL = {
  bank: 'BANESCO',
  bankDisplayName: 'Banesco',
  amountKey: '10K',
  amountVes: 10_000,
};

/** A series at a level far from the cell's own, so a mixture would be visible. */
const generalSeries = (): HistoricalObservation[] =>
  seriesFromBuyPrices(ramp(800, 830, 80)).map((observation) => ({
    ...observation,
    bank: 'MERCANTIL',
    amountKey: '100K',
    amountVes: 100_000,
  }));

describe('REGLA 1 y 2 — la propia serie manda mientras alcance', () => {
  it('con histórico propio suficiente NO pide prestado, aunque haya general', () => {
    const own = seriesFromBuyPrices(ramp(940, 960, MIN_OBSERVATIONS_FOR_OWN_READING + 10));
    const projection = projectCell({
      ...CELL,
      series: own,
      currentBuyPrice: 960,
      currentSellPrice: null,
      generalSeries: generalSeries(),
    });

    expect(projection.borrowedFrom).toBeNull();
    expect(projection.buy.borrowedFrom).toBeNull();
    expect(projection.observations).toBe(own.length);
  });

  it('con histórico propio escaso SÍ pide prestado, y sólo entonces', () => {
    const thin = seriesFromBuyPrices(ramp(940, 945, 5));
    const projection = projectCell({
      ...CELL,
      series: thin,
      currentBuyPrice: 945,
      currentSellPrice: null,
      generalSeries: generalSeries(),
    });

    expect(thin.length).toBeLessThan(MIN_OBSERVATIONS_FOR_OWN_READING);
    expect(projection.borrowedFrom).toBe('MERCADO GENERAL');
  });

  it('no pide prestado a una serie general que tampoco alcanza', () => {
    /*
     * Tomar una lectura igual de fina añade una advertencia y ninguna
     * información. Si no hay nada mejor, la respuesta es que no hay lectura.
     */
    const thin = seriesFromBuyPrices(ramp(940, 945, 5));
    const projection = projectCell({
      ...CELL,
      series: thin,
      currentBuyPrice: 945,
      currentSellPrice: null,
      generalSeries: seriesFromBuyPrices(ramp(800, 802, 3)),
    });

    expect(projection.borrowedFrom).toBeNull();
  });

  it('sin serie general no inventa una: la celda queda sin lectura', () => {
    const projection = projectCell({
      ...CELL,
      series: seriesFromBuyPrices([940, 941]),
      currentBuyPrice: 941,
      currentSellPrice: null,
    });

    expect(projection.borrowedFrom).toBeNull();
    expect(projection.reason).not.toBeNull();
  });
});

describe('REGLA 3 — el préstamo se declara, en la celda y en cada lado', () => {
  const projection = projectCell({
    ...CELL,
    series: seriesFromBuyPrices(ramp(940, 945, 5)),
    currentBuyPrice: 945,
    currentSellPrice: 946,
    generalSeries: generalSeries(),
  });

  it('la etiqueta viaja con la celda y con las dos piernas', () => {
    expect(projection.borrowedFrom).toBe('MERCADO GENERAL');
    expect(projection.buy.borrowedFrom).toBe('MERCADO GENERAL');
    expect(projection.sell.borrowedFrom).toBe('MERCADO GENERAL');
  });

  it('la celda sigue diciendo cuántas observaciones tiene DE VERDAD', () => {
    // 5 propias. El préstamo no las convierte en 80.
    expect(projection.observations).toBe(5);
  });
});

describe('REGLA 4 — nunca se mezclan las dos series', () => {
  it('la lectura prestada es la del mercado, entera, no una media', () => {
    /*
     * La celda vive en 940-945 y el mercado general en 800-830. Si se
     * mezclaran, la banda saldría en algún punto intermedio que no describe
     * ninguno de los dos libros. La lectura prestada tiene que ser la del
     * mercado, tal cual.
     */
    const general = generalSeries();

    const borrowed = projectCell({
      ...CELL,
      series: seriesFromBuyPrices(ramp(940, 945, 5)),
      currentBuyPrice: 945,
      currentSellPrice: null,
      generalSeries: general,
    });

    const marketOnly = projectCell({
      ...CELL,
      series: general,
      currentBuyPrice: 945,
      currentSellPrice: null,
    });

    // Misma tendencia, mismo tamaño de muestra: es la serie del mercado y nada más.
    expect(borrowed.buy.trend.trend).toBe(marketOnly.buy.trend.trend);
    expect(borrowed.buy.trend.sampleSize).toBe(marketOnly.buy.trend.sampleSize);
    expect(borrowed.buy.projectedRange.sampleSize).toBe(
      marketOnly.buy.projectedRange.sampleSize
    );
  });

  it('y la celda con datos propios lee sólo los suyos', () => {
    const own = seriesFromBuyPrices(ramp(940, 960, 40));

    const withGeneral = projectCell({
      ...CELL,
      series: own,
      currentBuyPrice: 960,
      currentSellPrice: null,
      generalSeries: generalSeries(),
    });
    const withoutGeneral = projectCell({
      ...CELL,
      series: own,
      currentBuyPrice: 960,
      currentSellPrice: null,
    });

    // Ofrecer una serie general no cambia ni un número de la lectura propia.
    expect(withGeneral.buy.trend).toEqual(withoutGeneral.buy.trend);
    expect(withGeneral.buy.projectedRange).toEqual(withoutGeneral.buy.projectedRange);
  });
});

describe('REGLA 5 — una lectura prestada no habla como si fuera de la celda', () => {
  it('no produce ninguna señal', () => {
    /*
     * Es la regla que impide que un hallazgo del mercado general se convierta
     * en 42 notificaciones idénticas, una por celda.
     */
    const borrowed = projectCell({
      ...CELL,
      series: seriesFromBuyPrices(ramp(940, 945, 5)),
      currentBuyPrice: 945,
      currentSellPrice: null,
      generalSeries: generalSeries(),
    });

    expect(borrowed.borrowedFrom).toBe('MERCADO GENERAL');

    const { signals } = evaluateSignals({
      projections: [borrowed],
      memory: EMPTY_SIGNAL_MEMORY,
    });
    expect(signals).toEqual([]);
  });

  it('la misma serie, leída como propia, sí produce señales', () => {
    /*
     * El contraste que hace no vacía a la prueba anterior: no es que no haya
     * nada que decir, es que no se dice EN NOMBRE DE ESTA CELDA.
     */
    const asOwn = projectCell({
      ...CELL,
      series: generalSeries(),
      currentBuyPrice: 830,
      currentSellPrice: null,
    });

    expect(asOwn.borrowedFrom).toBeNull();

    const first = evaluateSignals({ projections: [asOwn], memory: EMPTY_SIGNAL_MEMORY });
    // La memoria registra la lectura aunque el primer barrido sea silencioso.
    expect(first.memory.lastReading['BANESCO:10K:BUY']).toBeDefined();
  });
});
