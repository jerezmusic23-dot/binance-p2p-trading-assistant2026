/**
 * TRES HORIZONTES, O NINGUNO — pero nunca tres etiquetas sobre un cálculo.
 *
 * La regla del operador: si la interfaz dice que hay VERY_SHORT, SHORT y
 * MEDIUM, cada uno tiene que tener datos propios y un spanMs real. Si una
 * vista usa sólo uno, debe decirlo. Los minutos no se inventan nunca: salen de
 * la cadencia observada de la celda, y cuando no hay cadencia suficiente, no
 * hay minutos.
 *
 * Hay dos cosas distintas y este fichero las separa, porque confundirlas fue
 * lo que hizo que un informe anterior dijera que "no existe separación real":
 *
 *   LA TENDENCIA        tiene TRES horizontes de verdad, cada uno sobre su
 *                       propia ventana de observaciones, con su dirección, su
 *                       grado y el tiempo real que resultó cubrir.
 *   LA BANDA PROYECTADA tiene UNO, de stepsAhead observaciones, y ahora dice
 *                       cuánto es eso en minutos medidos.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { analyseTrend } from '../server/trendEngine.js';
import {
  DEFAULT_HORIZON_STEPS,
  observedStepMs,
  projectCell,
} from '../server/makerProjectionEngine.js';
import { ramp, seriesFromBuyPrices, STEP_MS } from './helpers/series.js';

const CELL = {
  bank: 'VENEZUELA',
  bankDisplayName: 'Banco de Venezuela',
  amountKey: '10K',
  amountVes: 10_000,
};

describe('LA TENDENCIA — los tres horizontes son tres cálculos', () => {
  const trend = analyseTrend(seriesFromBuyPrices(ramp(940, 960, 40)), 'BUY');

  it('los tres existen y están nombrados', () => {
    expect(trend.horizons.map((h) => h.name)).toEqual(['VERY_SHORT', 'SHORT', 'MEDIUM']);
  });

  it('cada uno se calcula sobre su propia ventana, y son de tamaños distintos', () => {
    const [veryShort, short, medium] = trend.horizons;

    expect(veryShort.observations).toBeGreaterThan(0);
    expect(veryShort.observations).toBeLessThan(short.observations);
    expect(short.observations).toBeLessThan(medium.observations);
  });

  it('cada uno reporta el tiempo REAL que cubre, no un intervalo supuesto', () => {
    for (const horizon of trend.horizons) {
      expect(horizon.spanMs).not.toBeNull();
      // El span es la ventana medida: (obs - 1) huecos de la cadencia real.
      expect(horizon.spanMs).toBe((horizon.observations - 1) * STEP_MS);
    }

    const [veryShort, , medium] = trend.horizons;
    expect(medium.spanMs as number).toBeGreaterThan(veryShort.spanMs as number);
  });

  it('cada uno lleva su propia lectura, y pueden discrepar', () => {
    /*
     * Un mercado que sube y se queda quieto: los horizontes corto y muy corto
     * ven lateral mientras el medio sigue viendo la subida de fondo. Si los
     * tres devolvieran siempre lo mismo serían una etiqueta y no un cálculo.
     *
     * El caso simétrico (subida y giro) NO sirve para esto, y saberlo importa:
     * la ventana media son 20 observaciones, así que un giro de 10 la arrastra
     * entera y los tres coinciden en bajista. Eso también es correcto - es lo
     * que dicen los datos - pero no demuestra que sean independientes.
     */
    const stalling = analyseTrend(
      seriesFromBuyPrices([
        ...ramp(940, 960, 30),
        ...Array.from({ length: 10 }, (_, i) => 960 + [0, 0.01, 0, -0.01][i % 4]),
      ]),
      'BUY'
    );

    const directions = new Set(stalling.horizons.map((h) => h.direction));
    expect(directions.size).toBeGreaterThan(1);
    expect(stalling.divergence).not.toBeNull();

    const [veryShort, short, medium] = stalling.horizons;
    expect(veryShort.direction).toBe('SIDEWAYS');
    expect(short.direction).toBe('SIDEWAYS');
    expect(medium.direction).toBe('BULLISH');
  });

  it('con una serie ilegible no inventa horizontes: devuelve ninguno', () => {
    const blind = analyseTrend(seriesFromBuyPrices([940, 940]), 'BUY');
    expect(blind.horizons).toEqual([]);
    expect(blind.trendConfidence).toBe('NO_DATA');
  });

  it('un horizonte con una sola observación no reporta span', () => {
    // spanMs necesita dos puntos para existir. Con uno, es null y no cero.
    const thin = analyseTrend(seriesFromBuyPrices(ramp(940, 946, 7)), 'BUY');
    for (const horizon of thin.horizons) {
      if (horizon.observations < 2) expect(horizon.spanMs).toBeNull();
    }
  });
});

describe('LA BANDA — un horizonte, y sus minutos están medidos', () => {
  const series = seriesFromBuyPrices(ramp(940, 960, 60));
  const projection = projectCell({ ...CELL, series, currentBuyPrice: 960, currentSellPrice: null });

  it('la cadencia sale de las marcas de tiempo de la propia celda', () => {
    expect(observedStepMs(series.map((o) => ({ t: o.timestamp, price: 0 })))).toBe(STEP_MS);
  });

  it('el horizonte en minutos es la cadencia medida por los pasos declarados', () => {
    const range = projection.buy.projectedRange;

    expect(range.stepsAhead).toBe(DEFAULT_HORIZON_STEPS);
    expect(range.observedStepMs).toBe(STEP_MS);
    expect(range.horizonMs).toBe(STEP_MS * DEFAULT_HORIZON_STEPS);
  });

  it('el texto que se muestra dice los minutos medidos, no unos supuestos', () => {
    const range = projection.buy.projectedRange;
    expect(range.basis).toContain(`${Math.round((range.horizonMs as number) / 60_000)} min`);
    expect(range.basis).toContain('medidos');
  });

  it('sin cadencia que medir, NO hay minutos — y tampoco un cero', () => {
    /*
     * La mediana de los huecos necesita al menos dos observaciones. Con una,
     * la respuesta es "no medible", nunca "0 min".
     */
    const single = projectCell({
      ...CELL,
      series: seriesFromBuyPrices([940]),
      currentBuyPrice: 940,
      currentSellPrice: null,
    });

    expect(single.buy.projectedRange.observedStepMs).toBeNull();
    expect(single.buy.projectedRange.horizonMs).toBeNull();
    expect(single.buy.projectedRange.basis).not.toContain('min');
  });

  it('un hueco enorme por una caída de captura no redefine la cadencia', () => {
    /*
     * MEDIANA, no media. Un reinicio o un corte de Binance deja un hueco
     * gigante, y con la media ese único agujero pasaría a describir el ritmo
     * de todo lo demás.
     */
    const normal = Array.from({ length: 20 }, (_, i) => ({ t: i * STEP_MS, price: 940 }));
    const withOutage = [...normal, { t: 19 * STEP_MS + 6 * 60 * 60 * 1000, price: 940 }];

    expect(observedStepMs(withOutage)).toBe(STEP_MS);
  });
});

describe('LA INTERFAZ — dice el período, y no lo esconde', () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), 'src', file), 'utf8');

  it('los tres horizontes muestran sus observaciones y sus minutos como texto', () => {
    for (const file of ['MarketAnalysisPanel.tsx', 'MarketProjectionPanel.tsx']) {
      const body = read(file);
      // El span estuvo en un atributo title, invisible en un móvil.
      expect(body, file).toMatch(/horizon\.spanMs/);
      expect(body, file).not.toMatch(/title=\{`\$\{horizon\.observations\}/);
    }
  });

  it('la banda proyectada muestra su horizonte sólo cuando está medido', () => {
    for (const file of ['MarketAnalysisPanel.tsx', 'MarketProjectionPanel.tsx']) {
      const body = read(file);
      expect(body, file).toMatch(/range\.horizonMs !== null/);
    }
  });

  it('ninguna vista escribe un número de minutos a mano', () => {
    /*
     * Un literal como "a 30 min" en el JSX sería un minuto inventado. Los
     * únicos minutos permitidos salen de una división de horizonMs o spanMs.
     */
    for (const file of ['MarketAnalysisPanel.tsx', 'MarketProjectionPanel.tsx', 'MarketPulse.tsx']) {
      const body = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
      const literals = body.match(/[^{}\w]\d+\s*min\b/g) ?? [];
      expect(literals, file).toEqual([]);
    }
  });
});
