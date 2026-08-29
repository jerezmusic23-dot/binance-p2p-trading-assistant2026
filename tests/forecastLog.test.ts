/**
 * REGISTRO DE PROYECCIONES Y SU EVALUACIÓN POSTERIOR
 * =================================================
 *
 * El backtest simula el pasado; esto mide lo que el bot dijo EN VIVO. Lo que
 * se protege aquí:
 *
 *   1. Que una proyección no evaluada nunca cuente como acierto ni como fallo.
 *   2. Que un hueco de captura al vencimiento se marque como no evaluable en
 *      lugar de puntuarse contra un precio de otro momento.
 *   3. Que no se publique rendimiento sin muestra suficiente.
 *   4. Que dos proyecciones casi solapadas no cuenten como dos pruebas.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MIN_EVALUATED_FORECASTS,
  classifyActual,
  evaluateForecast,
  observationAtDue,
  summariseForecasts,
  type ForecastRecord,
} from '../server/projection/forecastEvaluation.js';
import { pointsFrom } from './helpers/projectionSeries.js';

const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

function forecast(overrides: Partial<ForecastRecord> = {}): ForecastRecord {
  return {
    id: 'f1',
    createdAt: T0,
    seriesId: 'STRATEGIC_BUY',
    priceAtForecast: 940,
    horizonMs: HOUR,
    dueAt: T0 + HOUR,
    direction: 'ALCISTA',
    central: 942,
    low: 941,
    high: 944,
    probabilityUp: 0.7,
    momentumScore: 80,
    momentumLabel: 'ALCISTA',
    analoguesUsed: 60,
    evidenceTier: 'HISTORICO_SUFICIENTE',
    evaluatedAt: null,
    actualPrice: null,
    directionHit: null,
    insideBand: null,
    absError: null,
    persistenceAbsError: null,
    unevaluableReason: null,
    ...overrides,
  };
}

const series = (prices: number[]) => pointsFrom(prices, MIN);

describe('encontrar la observación del vencimiento', () => {
  it('toma la primera en o después del vencimiento', () => {
    const s = series(Array.from({ length: 120 }, (_, i) => 940 + i * 0.01));
    const found = observationAtDue(s, T0 + 60 * MIN, MIN);
    expect(found?.t).toBe(T0 + 60 * MIN);
  });

  it('rechaza una observación que llega demasiado tarde', () => {
    // Hueco de captura: la siguiente observación es de veinte minutos después.
    const s = [
      { t: T0, price: 940 },
      { t: T0 + 80 * MIN, price: 950 },
    ];
    expect(observationAtDue(s, T0 + 60 * MIN, MIN)).toBeNull();
  });
});

describe('evaluar una proyección', () => {
  const s = series(Array.from({ length: 120 }, (_, i) => 940 + i * 0.05));

  it('no juzga una proyección que aún no ha vencido', () => {
    const pending = evaluateForecast(forecast(), {
      series: s,
      cadenceMs: MIN,
      typicalStep: 0.05,
      now: T0 + 10 * MIN,
    });
    expect(pending.evaluatedAt).toBeNull();
    expect(pending.directionHit).toBeNull();
  });

  it('al vencer compara contra el precio real y NO muta el original', () => {
    const original = forecast();
    const done = evaluateForecast(original, {
      series: s,
      cadenceMs: MIN,
      typicalStep: 0.05,
      now: T0 + HOUR,
    });

    expect(original.evaluatedAt).toBeNull();
    expect(done.evaluatedAt).toBe(T0 + HOUR);
    expect(done.actualPrice).toBe(943);
    expect(done.directionHit).toBe(true);
    expect(done.insideBand).toBe(true);
    expect(done.absError).toBeCloseTo(1, 6);
    expect(done.persistenceAbsError).toBeCloseTo(3, 6);
  });

  it('un hueco al vencimiento la deja NO EVALUABLE, no fallada', () => {
    const gapped = [
      { t: T0, price: 940 },
      { t: T0 + 90 * MIN, price: 950 },
    ];
    const done = evaluateForecast(forecast(), {
      series: gapped,
      cadenceMs: MIN,
      typicalStep: 0.05,
      now: T0 + HOUR,
    });

    expect(done.unevaluableReason).toContain('hueco de captura');
    expect(done.directionHit).toBeNull();
    expect(done.actualPrice).toBeNull();
  });

  it('INDETERMINADA no se apunta ni acierto ni fallo', () => {
    const done = evaluateForecast(forecast({ direction: 'INDETERMINADA' }), {
      series: s,
      cadenceMs: MIN,
      typicalStep: 0.05,
      now: T0 + HOUR,
    });
    expect(done.directionHit).toBeNull();
    // Pero el error de precio sí se mide: el escenario central existía.
    expect(done.absError).not.toBeNull();
  });

  it('no se re-evalúa lo ya evaluado', () => {
    const done = evaluateForecast(forecast({ evaluatedAt: T0 + HOUR, actualPrice: 999 }), {
      series: s,
      cadenceMs: MIN,
      typicalStep: 0.05,
      now: T0 + 5 * HOUR,
    });
    expect(done.actualPrice).toBe(999);
  });

  it('clasifica el resultado con la misma banda que el modelo', () => {
    expect(classifyActual(1, 0.5)).toBe('UP');
    expect(classifyActual(0.4, 0.5)).toBe('FLAT');
    expect(classifyActual(-1, 0.5)).toBe('DOWN');
    expect(classifyActual(Number.NaN, 0.5)).toBe('FLAT');
  });
});

describe('el agregado no afirma sin muestra', () => {
  const evaluated = (n: number, hit: boolean) =>
    Array.from({ length: n }, (_, i) =>
      forecast({
        id: `f${i}`,
        evaluatedAt: T0 + HOUR,
        actualPrice: hit ? 943 : 930,
        directionHit: hit,
        insideBand: hit,
        absError: hit ? 1 : 12,
        persistenceAbsError: hit ? 3 : 10,
      })
    );

  it('por debajo del suelo publica el recuento pero NINGÚN porcentaje', () => {
    const report = summariseForecasts(evaluated(MIN_EVALUATED_FORECASTS - 1, true));
    const h = report.byHorizon[0];

    expect(h.evaluated).toBe(MIN_EVALUATED_FORECASTS - 1);
    expect(h.reason).toBe('INSUFFICIENT_EVALUATED');
    expect(h.directionalAccuracy).toBeNull();
    expect(h.beatsPersistence).toBeNull();
    expect(report.verdict).toContain('no se puede afirmar');
  });

  it('con muestra suficiente publica acierto, cobertura, error y sesgo', () => {
    const report = summariseForecasts(evaluated(MIN_EVALUATED_FORECASTS, true));
    const h = report.byHorizon[0];

    expect(h.reason).toBeNull();
    expect(h.directionalAccuracy).toBe(1);
    expect(h.bandCoverage).toBe(1);
    expect(h.medianAbsError).toBe(1);
    expect(h.persistenceMedianAbsError).toBe(3);
    expect(h.beatsPersistence).toBe(true);
    // Sesgo: el central estaba por debajo del precio real.
    expect(h.bias).toBeCloseTo(942 - 943, 6);
  });

  it('no declara ventaja cuando la persistencia acierta más', () => {
    const report = summariseForecasts(evaluated(MIN_EVALUATED_FORECASTS, false));
    expect(report.byHorizon[0].beatsPersistence).toBe(false);
  });

  it('las no evaluables se cuentan aparte y no ensucian el acierto', () => {
    const mixed = [
      ...evaluated(MIN_EVALUATED_FORECASTS, true),
      forecast({ id: 'gap', evaluatedAt: T0 + HOUR, unevaluableReason: 'hueco de captura' }),
    ];
    const report = summariseForecasts(mixed);

    expect(report.unevaluable).toBe(1);
    expect(report.evaluated).toBe(MIN_EVALUATED_FORECASTS);
    expect(report.byHorizon[0].directionalAccuracy).toBe(1);
  });

  it('mide el rendimiento por fuerza del momentum', () => {
    const report = summariseForecasts(evaluated(MIN_EVALUATED_FORECASTS, true));
    const band = report.byMomentum.find((b) => b.label === 'ALCISTA');
    expect(band?.evaluated).toBe(MIN_EVALUATED_FORECASTS);
    expect(band?.directionalAccuracy).toBe(1);
  });

  it('sin ninguna proyección no lanza', () => {
    const report = summariseForecasts([]);
    expect(report.totalForecasts).toBe(0);
    expect(report.byHorizon).toEqual([]);
    expect(report.verdict).toContain('no se puede afirmar');
  });
});

describe('el almacén espacia las proyecciones', () => {
  let tmpDir: string;
  let ForecastStore: typeof import('../server/forecastStore.js').ForecastStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-forecast-'));
    fs.mkdirSync(path.join(tmpDir, 'data'));
    process.env.DATA_DIR = path.join(tmpDir, 'data');
    vi.resetModules();
    ({ ForecastStore } = await import('../server/forecastStore.js'));
    ForecastStore.reset();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('la primera siempre se registra', () => {
    expect(ForecastStore.shouldRecord('STRATEGIC_BUY', HOUR, T0).record).toBe(true);
  });

  it('dos proyecciones casi solapadas NO son dos pruebas', () => {
    ForecastStore.append(forecast({ createdAt: T0 }));

    const tooSoon = ForecastStore.shouldRecord('STRATEGIC_BUY', HOUR, T0 + 5 * MIN);
    expect(tooSoon.record).toBe(false);
    expect(tooSoon.reason).toContain('espaciado exigido');

    // Pasado un horizonte completo, las ventanas ya no se solapan.
    expect(ForecastStore.shouldRecord('STRATEGIC_BUY', HOUR, T0 + HOUR).record).toBe(true);
  });

  it('cada serie y cada horizonte llevan su propio espaciado', () => {
    ForecastStore.append(forecast({ createdAt: T0, seriesId: 'STRATEGIC_BUY' }));

    expect(ForecastStore.shouldRecord('STRATEGIC_SELL', HOUR, T0 + MIN).record).toBe(true);
    expect(ForecastStore.shouldRecord('STRATEGIC_BUY', 15 * MIN, T0 + MIN).record).toBe(true);
  });

  it('persiste entre instancias y actualiza por id', () => {
    ForecastStore.append(forecast({ id: 'a' }));
    ForecastStore.update([forecast({ id: 'a', evaluatedAt: T0 + HOUR, directionHit: true })]);

    ForecastStore.reset();
    const reloaded = ForecastStore.all();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].directionHit).toBe(true);
    expect(ForecastStore.pending()).toHaveLength(0);
  });

  it('un fichero ilegible no tumba el arranque', () => {
    fs.writeFileSync(path.join(tmpDir, 'data', 'forecast_log.json'), '{ esto no es json');
    ForecastStore.reset();
    expect(ForecastStore.all()).toEqual([]);
  });

  it('rechaza horizontes imposibles', () => {
    for (const h of [0, -HOUR, Number.NaN]) {
      expect(ForecastStore.shouldRecord('STRATEGIC_BUY', h, T0).record).toBe(false);
    }
  });
});
