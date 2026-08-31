/**
 * EVERY NUMBER THE SYSTEM SHOWS, AND WHAT KIND OF NUMBER IT IS.
 *
 * The four categories, and the rule:
 *
 *   1. FRECUENCIA HISTÓRICA REAL   counted over observations on disk
 *   2. DERIVADO MATEMÁTICAMENTE    computed from observed values
 *   3. SCORE HEURÍSTICO            a rule somebody wrote down
 *   4. CONSTANTE ARBITRARIA        a number nobody measured
 *
 * Only 1 and 2 may be presented as quantitative evidence. A 3 may exist, but
 * it must be called a score, an index or a signal - never a probability - and
 * it must never be turned into a percentage that reads like one.
 *
 * The tests here are the standing guard. They are deliberately structural as
 * well as behavioural: the failure mode this project has actually suffered is
 * not a wrong formula, it is a correct formula presented as something it is
 * not, and only reading the rendered text catches that.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { analyseTrend } from '../server/trendEngine.js';
import {
  MIN_SAMPLES_FOR_PROBABILITY,
  measurePattern,
  outcomesInWindow,
} from '../server/patternEngine.js';
import { seriesFromBuyPrices, ramp } from './helpers/series.js';

const SRC = path.join(process.cwd(), 'src');
const SERVER = path.join(process.cwd(), 'server');

/** Source with comments stripped: prose about a removal is not code. */
const code = (file: string): string =>
  fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const filesIn = (dir: string, exts: string[]): string[] =>
  fs
    .readdirSync(dir)
    .filter((f) => exts.some((e) => f.endsWith(e)))
    .map((f) => path.join(dir, f));

describe('CATEGORÍA 1 — frecuencias históricas reales', () => {
  it('a rate is only reported once the sample can support it', () => {
    const rare = measurePattern(
      Array.from({ length: 5 }, (_, i) => ({ t: i * 1000, price: 940 + i })),
      { matched: () => true, outcome: () => true, horizon: 1, description: 'siempre' }
    );

    // Five out of five is not evidence of anything.
    expect(rare.sampleSize).toBeLessThan(MIN_SAMPLES_FOR_PROBABILITY);
    expect(rare.probability).toBeNull();
    expect(rare.reason).toBe('INSUFFICIENT_HISTORY');
  });

  it('and when it is reported, it is a count divided by a count', () => {
    const points = Array.from({ length: 40 }, (_, i) => ({ t: i * 1000, price: 940 + i }));
    const evidence = measurePattern(points, {
      matched: () => true,
      outcome: (after) => after[0].price > 0,
      horizon: 1,
      description: 'siempre',
    });

    expect(evidence.probability).toBe(evidence.occurrences / evidence.sampleSize);
    expect(evidence.sampleSize).toBeGreaterThanOrEqual(MIN_SAMPLES_FOR_PROBABILITY);
  });

  it('continuation rates carry their sample size and refuse when it is thin', () => {
    const thin = outcomesInWindow(seriesFromBuyPrices([940, 941, 942]), 'BUY', {
      horizon: 6,
      description: 'poco',
    });
    expect(thin.upRate).toBeNull();
    // Too little to count at all, or too little to count enough - either way
    // no rate is produced and the refusal is explicit.
    expect(['NO_DATA', 'INSUFFICIENT_HISTORY']).toContain(thin.reason);

    const rich = outcomesInWindow(seriesFromBuyPrices(ramp(940, 960, 60)), 'BUY', {
      horizon: 6,
      description: 'suficiente',
    });
    expect(rich.reason).toBeNull();
    expect(rich.upRate).not.toBeNull();
    expect(rich.sampleSize).toBeGreaterThan(0);
    // The three rates are shares of one count, so they add up.
    const total = (rich.upRate ?? 0) + (rich.flatRate ?? 0) + (rich.downRate ?? 0);
    expect(total).toBeCloseTo(1, 9);
  });
});

describe('CATEGORÍA 2 — derivado, y presentado como lo que es', () => {
  it('trendStrength travels with the counts it was computed from', () => {
    /*
     * |sube - baja| / (sube + baja) over the steps that HAPPENED. It describes
     * the past and predicts nothing, which is why the interface prints the
     * counts rather than a percentage.
     */
    const trend = analyseTrend(seriesFromBuyPrices(ramp(940, 960, 30)), 'BUY');

    expect(trend.directionalSteps).not.toBeNull();
    const { up, down } = trend.directionalSteps!;
    expect(trend.trendStrength).toBeCloseTo(Math.abs(up - down) / (up + down), 9);
  });

  it('a series with nothing to read reports null rather than zero', () => {
    const blind = analyseTrend(seriesFromBuyPrices([940, 940]), 'BUY');
    expect(blind.trendStrength).toBeNull();
    expect(blind.directionalSteps).toBeNull();
    expect(blind.trendConfidence).toBe('NO_DATA');
  });
});

describe('CATEGORÍA 3 — la confianza es evidencia, no probabilidad', () => {
  it('confidence is categorical everywhere, never a percentage', () => {
    const trend = analyseTrend(seriesFromBuyPrices(ramp(940, 960, 40)), 'BUY');
    expect(['HIGH', 'MEDIUM', 'LOW', 'NO_DATA']).toContain(trend.trendConfidence);
    expect(typeof trend.trendConfidence).toBe('string');
  });

  it('no server module produces a confidence percentage', () => {
    for (const file of filesIn(SERVER, ['.ts'])) {
      const body = code(file);
      expect(body, file).not.toMatch(/confidencePct/);
      expect(body, file).not.toMatch(/confidencePercent/);
    }
  });

  it('the interface never prints a confidence as a number', () => {
    for (const file of filesIn(SRC, ['.tsx'])) {
      const body = code(file);
      // "Confianza: 87%" in any spelling.
      expect(body, file).not.toMatch(/Confianza[^<]{0,40}fmtPct/);
      expect(body, file).not.toMatch(/Confianza[^<]{0,40}\* 100/);
    }
  });
});

describe('CATEGORÍA 4 — las constantes arbitrarias no han vuelto', () => {
  it('no invented probability distribution exists anywhere', () => {
    for (const file of [...filesIn(SERVER, ['.ts']), ...filesIn(SRC, ['.ts', '.tsx'])]) {
      const body = code(file);
      expect(body, file).not.toMatch(/upScore|downScore|neutralScore/);
      expect(body, file).not.toMatch(/probabilities\s*[:=]/);
      expect(body, file).not.toMatch(/pUp|pDown|pNeutral/);
    }
  });

  it('the heuristic forecast multipliers exist nowhere', () => {
    for (const file of filesIn(SERVER, ['.ts'])) {
      const body = code(file);
      for (const pattern of [/stdDev \* 1\.6/, /\* 1\.15\b/, /\* 1\.004\b/, /0\.0035/, /sessionCurve/]) {
        expect(body, `${file} :: ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});

describe('every percentage on the screen is a frequency or a price ratio', () => {
  /*
   * THE INVENTORY, checked rather than described.
   *
   * A percentage in this interface may only come from:
   *   - a measured frequency  (directionalAccuracy, bandCoverage, upRate ...)
   *   - a ratio of two observed prices (spreadPct, marginPct, finishRate)
   *
   * Anything else - a score scaled to 100, a confidence, a strength - is
   * forbidden, because a reader cannot tell those apart from the first two.
   */
  const ALLOWED = [
    // measured frequencies
    'directionalAccuracy',
    'baselineAccuracy',
    'bandCoverage',
    /*
     * Proyección por analogía. Las tres primeras son literalmente un recuento
     * partido por otro: casos_que_subieron / casos_comparables, con los dos
     * términos publicados al lado y las fechas de cada caso detrás. Las dos
     * últimas son los extremos del intervalo de Wilson al 95% de esa misma
     * frecuencia, así que son de la misma naturaleza que ella; existen
     * precisamente para que el porcentaje no se lea con más precisión de la
     * que tiene.
     */
    'probabilityUp',
    'probabilityFlat',
    'probabilityDown',
    'probabilityUpLow',
    'probabilityUpHigh',
    /*
     * Escenarios: la probabilidad de cada uno es su recuento de casos partido
     * por el total de análogos, y los dos términos se enseñan al lado. Low y
     * High son los extremos del intervalo de Wilson de esa misma frecuencia.
     */
    'probabilityLow',
    'probabilityHigh',
    'probability',
    /*
     * Calibración. `meanPredicted` es la media de probabilidades anunciadas y
     * `observedFrequency` la fracción de veces que ocurrieron: exactamente las
     * dos cifras que hay que comparar para saber si el modelo se pasa de
     * confiado. `from`/`to` son los bordes de un bucket, es decir puntos de la
     * propia escala de probabilidad, no una magnitud convertida a porcentaje.
     */
    'meanPredicted',
    'observedFrequency',
    'b.from',
    'b.to',
    /*
     * `coverageTarget` es la cobertura que la banda promete por construcción
     * (percentiles 10 y 90 = 80%). Se publica junto a `bandCoverage`, que es la
     * medida: sin el objetivo al lado, la medida no se puede juzgar.
     */
    'coverageTarget',
    /*
     * `coverage` es la cobertura MEDIDA de la proyección diaria: de los cierres
     * que el backtest temporal llegó a comparar, la fracción que cayó dentro de
     * la banda anunciada. Es un recuento partido por otro, de la misma
     * naturaleza que `observedFrequency`, y viaja junto al número de días y de
     * anclas que la sostienen. No es una confianza elegida.
     */
    'coverage',
    'upRate',
    'flatRate',
    'downRate',
    'finishRate',
    // ratios of observed prices
    'strategicSpreadPct',
    'spreadPct',
    'grossMarginPct',
    'marginPct',
    'buyPressurePct',
    'sellPressurePct',
    'priceVsSmaPct',
  ];

  it('lists every source of a rendered percentage, and each one is allowed', () => {
    const offenders: string[] = [];

    for (const file of filesIn(SRC, ['.tsx'])) {
      const body = code(file);
      // Any expression that multiplies by 100 and renders, or calls fmtPct.
      const matches = [
        ...body.matchAll(/([A-Za-z_.?[\]]+)\s*\*\s*100\b/g),
        ...body.matchAll(/fmtPct\(\s*([A-Za-z_.?[\]]+)/g),
        ...body.matchAll(/pct\(\s*([A-Za-z_.?[\]]+)/g),
      ];

      for (const match of matches) {
        const expression = match[1];
        const known = ALLOWED.some((name) => expression.includes(name));
        // A bare local like `v` inside a formatting helper carries no meaning
        // of its own; the call sites it serves are checked instead.
        const isHelperParam = /^[a-z]$/.test(expression.replace(/\?$/, ''));
        if (!known && !isHelperParam) offenders.push(`${path.basename(file)}: ${expression}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
