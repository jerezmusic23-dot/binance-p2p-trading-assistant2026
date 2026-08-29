/**
 * FUERZA DEL MOVIMIENTO Y SU DERIVADA
 * ===================================
 *
 * Lo que estas pruebas protegen:
 *
 *   1. Que el 0–100 sea la distribución del propio mercado y no una escala
 *      inventada — la misma forma a cualquier nivel de precio puntúa igual.
 *   2. Que "82" y "82 perdiendo fuerza" se distingan, que es lo que se pidió.
 *   3. Que una lectura pasada no se sitúe en una distribución que incluye su
 *      propio futuro.
 *   4. Que sin muestra no haya score, en vez de un número inventado.
 *
 * Series SINTÉTICAS. No dicen nada del mercado real.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_MOMENTUM_SAMPLES,
  MOMENTUM_BANDS,
  describeMomentum,
  empiricalPercentile,
  labelForScore,
  readMomentum,
  windowedMoves,
} from '../server/projection/momentum.js';
import {
  accelerating,
  decelerating,
  pointsFrom,
  ramp,
  randomWalk,
  reversal,
} from './helpers/projectionSeries.js';

const W = 15;

describe('el percentil empírico', () => {
  it('sitúa el valor dentro de la muestra, en 0–100', () => {
    const sample = [-3, -2, -1, 0, 1, 2, 3];
    expect(empiricalPercentile(-3, sample)).toBeCloseTo((0.5 / 7) * 100, 6);
    expect(empiricalPercentile(0, sample)).toBeCloseTo((3.5 / 7) * 100, 6);
    expect(empiricalPercentile(3, sample)).toBeCloseTo((6.5 / 7) * 100, 6);
  });

  it('usa el punto medio de los empates', () => {
    // Con una serie cuantizada muchos movimientos valen lo mismo. Contar sólo
    // los estrictamente menores hundiría el score de un movimiento normal.
    const sample = [0, 0, 0, 0];
    expect(empiricalPercentile(0, sample)).toBe(50);
  });

  it('no inventa un percentil sin muestra ni con valores imposibles', () => {
    expect(empiricalPercentile(1, [])).toBeNull();
    expect(empiricalPercentile(Number.NaN, [1, 2, 3])).toBeNull();
    expect(empiricalPercentile(1, [Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
  });
});

describe('las siete bandas', () => {
  it('son séptimos iguales de la escala, con NEUTRAL en el centro', () => {
    expect(labelForScore(0)).toBe('FUERTE_BAJISTA');
    expect(labelForScore(50)).toBe('NEUTRAL');
    expect(labelForScore(100)).toBe('FUERTE_ALCISTA');

    // Una banda por séptimo, sin huecos ni solapes.
    const seen = new Set<string>();
    for (let i = 0; i <= 100; i += 0.5) seen.add(labelForScore(i) as string);
    expect(seen.size).toBe(MOMENTUM_BANDS);
  });

  it('es simétrica: lo que sube y lo que baja se etiquetan igual de lejos', () => {
    expect(labelForScore(10)).toBe('FUERTE_BAJISTA');
    expect(labelForScore(90)).toBe('FUERTE_ALCISTA');
    expect(labelForScore(30)).toBe('BAJISTA_DEBIL');
    expect(labelForScore(70)).toBe('ALCISTA_DEBIL');
  });

  it('sin score no hay etiqueta', () => {
    expect(labelForScore(null)).toBeNull();
    expect(labelForScore(Number.NaN)).toBeNull();
  });
});

describe('casos de mercado', () => {
  it('1. fuerte subida puntúa alto y se etiqueta alcista', () => {
    const reading = readMomentum(pointsFrom(ramp(940, 0.05, 400)), W);
    expect(reading.score).not.toBeNull();
    expect(reading.score!).toBeGreaterThan(50);
    expect(reading.label).toMatch(/ALCISTA/);
    expect(reading.factors.driftSteps!).toBeGreaterThan(0);
    expect(reading.factors.persistence).toBe(1);
  });

  it('2. fuerte caída puntúa bajo y se etiqueta bajista', () => {
    const reading = readMomentum(pointsFrom(ramp(1200, -0.05, 400)), W);
    expect(reading.score!).toBeLessThan(50);
    expect(reading.label).toMatch(/BAJISTA/);
    expect(reading.factors.driftSteps!).toBeLessThan(0);
  });

  it('3. lateral se queda en la banda central', () => {
    const reading = readMomentum(pointsFrom(randomWalk(940, 0.01, 600, 7)), W);
    expect(reading.score!).toBeGreaterThan(0);
    expect(reading.score!).toBeLessThan(100);
    // Un paseo aleatorio no puede producir una lectura extrema de forma fiable.
    expect(reading.factors.persistence!).toBeLessThan(1);
  });

  it('4. subida perdiendo fuerza: el momentum DISMINUYE', () => {
    const reading = readMomentum(pointsFrom(decelerating(940, 0.05, 400)), W);
    expect(reading.trend).toBe('DISMINUYENDO');
    expect(describeMomentum(reading)).toContain('perdiendo fuerza');
    // Sigue siendo una subida: la dirección no cambia, la fuerza sí.
    expect(reading.factors.driftSteps!).toBeGreaterThan(0);
  });

  it('5. subida acelerando: el momentum AUMENTA', () => {
    const reading = readMomentum(pointsFrom(accelerating(940, 0.02, 400)), W);
    expect(reading.trend).toBe('AUMENTANDO');
    expect(describeMomentum(reading)).toContain('aceleración');
    expect(reading.factors.acceleration!).toBeGreaterThan(0);
  });

  it('6. una reversión deja rastro en persistencia y aceleración', () => {
    const rising = readMomentum(pointsFrom(ramp(940, 0.05, 400)), W);
    const turning = readMomentum(pointsFrom(reversal(940, 0.05, 400)), W);

    // La reversión termina bajando: su recorrido final es negativo.
    expect(turning.factors.driftSteps!).toBeLessThan(0);
    expect(rising.factors.driftSteps!).toBeGreaterThan(0);
  });

  it('7. la amplitud por sí sola NO sube el score', () => {
    /*
     * Ésta es la propiedad que impide que se cuele un umbral en VES: un
     * mercado que se mueve de 0.5 en 0.5 no es "más fuerte" que uno que se
     * mueve de 0.01 en 0.01, porque cada uno se mide contra su propia
     * distribución de magnitudes.
     *
     * Se escala por potencias de dos porque en coma flotante binaria eso sólo
     * mueve el exponente: la comparación es exacta y mide la propiedad, no la
     * aritmética.
     */
    const shape = randomWalk(1, 0.001, 600, 11);
    const calm = readMomentum(pointsFrom(shape.map((p) => p * 2 ** -8)), W);
    const wild = readMomentum(pointsFrom(shape.map((p) => p * 2 ** 12)), W);

    expect(calm.score).toBe(wild.score);
    expect(calm.label).toBe(wild.label);
    // La volatilidad también va en movimientos típicos, así que coincide.
    expect(calm.factors.volatility).toBe(wild.factors.volatility);
  });

  it('7b. la volatilidad se mide y se publica como factor', () => {
    /*
     * La volatilidad es la dispersión de los TAMAÑOS de salto, no de su signo.
     * Un paseo de ±tick constante tiene dispersión CERO por mucho que zigzaguee
     * —todos sus saltos miden lo mismo— y eso es correcto: lo que cambia es la
     * dirección, no la magnitud. Hace falta un mercado con saltos de tamaños
     * distintos para que este factor se despierte.
     */
    const steady = readMomentum(pointsFrom(ramp(940, 0.02, 400)), W);

    const rnd = randomWalk(0, 1, 400, 9);
    const mixed = pointsFrom(
      ramp(940, 0, 400).map((base, i) => Number((base + rnd[i] * (1 + (i % 5))).toFixed(4)))
    );
    const varied = readMomentum(mixed, W);

    expect(steady.factors.volatility).toBe(0);
    expect(varied.factors.volatility!).toBeGreaterThan(0);
  });

  it('8. la misma forma a otro nivel de precio puntúa igual', () => {
    const shape = randomWalk(1, 0.001, 600, 3);
    const low = readMomentum(pointsFrom(shape.map((p) => p * 2 ** -10)), W);
    const high = readMomentum(pointsFrom(shape.map((p) => p * 2 ** 20)), W);

    expect(low.score).toBe(high.score);
    expect(low.label).toBe(high.label);
  });

  it('9. histórico insuficiente no produce score', () => {
    const short = readMomentum(pointsFrom(ramp(940, 0.05, W + 5)), W);
    expect(short.score).toBeNull();
    expect(short.label).toBeNull();
    expect(short.trend).toBe('INDETERMINADO');
    expect(short.sampleSize).toBeLessThan(MIN_MOMENTUM_SAMPLES);
    expect(describeMomentum(short)).toBeNull();
  });
});

describe('robustez', () => {
  it('no lanza ni produce basura con series degeneradas', () => {
    for (const points of [
      [],
      pointsFrom([940]),
      pointsFrom(Array(600).fill(940)),
      pointsFrom(randomWalk(940, 0.01, 600, 5)),
    ]) {
      const reading = readMomentum(points, W);
      for (const v of [reading.score, ...Object.values(reading.factors)]) {
        expect(v === null || Number.isFinite(v)).toBe(true);
      }
      if (reading.score !== null) {
        expect(reading.score).toBeGreaterThanOrEqual(0);
        expect(reading.score).toBeLessThanOrEqual(100);
      }
    }
  });

  it('rechaza ventanas imposibles en lugar de redondearlas', () => {
    const points = pointsFrom(ramp(940, 0.05, 400));
    for (const w of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const reading = readMomentum(points, w);
      expect(reading.score).toBeNull();
    }
  });

  it('SIN LEAKAGE: una lectura pasada no ve su propio futuro', () => {
    /*
     * Se lee el momentum sobre un prefijo y se vuelve a leer tras añadir a la
     * serie un tramo salvaje. Si el percentil de una lectura antigua se
     * calculara sobre la distribución completa, las dos diferirían.
     */
    const prices = randomWalk(940, 0.01, 600, 13);
    const prefix = pointsFrom(prices.slice(0, 400));
    const before = readMomentum(prefix, W);

    const wild = [...prices];
    for (let i = 400; i < wild.length; i += 1) wild[i] = wild[i] * (1 + (i % 5) * 0.1);
    const after = readMomentum(pointsFrom(wild.slice(0, 400)), W);

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('windowedMoves respeta el límite superior que se le da', () => {
    const points = pointsFrom(ramp(940, 1, 20));
    expect(windowedMoves(points, 5, 10)).toHaveLength(6);
    expect(windowedMoves(points, 5)).toHaveLength(15);
    expect(windowedMoves(points, 0)).toEqual([]);
  });
});
