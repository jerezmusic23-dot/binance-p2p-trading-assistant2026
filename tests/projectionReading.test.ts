/**
 * LECTURA MULTI-HORIZONTE, NIVEL DE EVIDENCIA Y EXPLICACIÓN
 * ========================================================
 *
 * Lo que se protege aquí:
 *
 *   1. Que la discrepancia entre horizontes se PUBLIQUE en lugar de
 *      promediarse: "15m alcista, 4h lateral" es información, no un problema.
 *   2. Que el nivel de evidencia diga la verdad sobre cuánto histórico hay.
 *   3. Que cada frase de la explicación cite un dato medido.
 */

import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_TEXT,
  buildNarrative,
  directionOfMomentum,
  readLiquidity,
  readMarket,
  summarisePredominant,
  type HorizonMovement,
} from '../server/projection/reading.js';
import { readMomentum } from '../server/projection/momentum.js';
import { pointsFrom, ramp, randomWalk } from './helpers/projectionSeries.js';

const MIN = 60 * 1000;
/** Ventanas cortas para no necesitar días de serie sintética. */
const WINDOWS = [
  { label: '15m', ms: 15 * MIN },
  { label: '1h', ms: 60 * MIN },
];

const horizon = (label: string, direction: HorizonMovement['direction']): HorizonMovement => ({
  label,
  requestedMs: 15 * MIN,
  windowSteps: 15,
  measuredMs: 15 * MIN,
  available: true,
  direction,
  momentum: readMomentum([], 1),
});

describe('síntesis multi-horizonte', () => {
  it('cuando todos coinciden, lo dice y los nombra', () => {
    const result = summarisePredominant([
      horizon('15m', 'ALCISTA'),
      horizon('1h', 'ALCISTA'),
      horizon('4h', 'ALCISTA'),
    ]);
    expect(result.direction).toBe('ALCISTA');
    expect(result.note).toContain('coinciden');
    expect(result.note).toContain('4h');
  });

  it('cuando discrepan, publica CUÁLES discrepan en vez de promediar', () => {
    // Éste es el caso del enunciado: alcista con consolidación de medio plazo.
    const result = summarisePredominant([
      horizon('15m', 'ALCISTA'),
      horizon('1h', 'ALCISTA'),
      horizon('4h', 'LATERAL'),
      horizon('24h', 'ALCISTA'),
    ]);
    expect(result.direction).toBe('ALCISTA');
    expect(result.note).toContain('4h lateral');
  });

  it('un empate no se resuelve inventando un ganador', () => {
    const result = summarisePredominant([
      horizon('15m', 'ALCISTA'),
      horizon('1h', 'BAJISTA'),
    ]);
    expect(result.direction).toBe('INDETERMINADA');
    expect(result.note).toContain('divididos');
  });

  it('sin horizontes con lectura, no hay predominante', () => {
    expect(summarisePredominant([]).direction).toBe('INDETERMINADA');
    expect(summarisePredominant([{ ...horizon('15m', 'ALCISTA'), available: false }]).direction).toBe(
      'INDETERMINADA'
    );
  });
});

describe('dirección del movimiento', () => {
  it('sale de la etiqueta de momentum, sin una segunda definición', () => {
    const up = readMomentum(pointsFrom(ramp(940, 0.05, 400)), 15);
    expect(directionOfMomentum(up)).toBe('ALCISTA');

    const down = readMomentum(pointsFrom(ramp(1200, -0.05, 400)), 15);
    expect(directionOfMomentum(down)).toBe('BAJISTA');

    const none = readMomentum([], 1);
    expect(directionOfMomentum(none)).toBe('INDETERMINADA');
  });
});

describe('niveles de evidencia', () => {
  it('sin ninguna observación es SIN_DATOS', () => {
    const r = readMarket([], { windows: WINDOWS });
    expect(r.evidence).toBe('SIN_DATOS');
    expect(r.currentPrice).toBeNull();
    expect(r.narrative).toEqual([EVIDENCE_TEXT.SIN_DATOS]);
  });

  it('con serie demasiado corta es DATOS_INSUFICIENTES y NO hay momentum', () => {
    const r = readMarket(pointsFrom(ramp(940, 0.02, 18)), { windows: WINDOWS });
    expect(r.evidence).toBe('DATOS_INSUFICIENTES');
    expect(r.movement.score).toBeNull();
    expect(r.narrative.join(' ')).toContain('Datos insuficientes');
  });

  it('con momentum pero sin análogos suficientes es HISTORICO_LIMITADO', () => {
    const r = readMarket(pointsFrom(randomWalk(940, 0.01, 600, 3)), { windows: WINDOWS });
    expect(r.evidence).toBe('HISTORICO_LIMITADO');
    expect(r.movement.score).not.toBeNull();
  });

  it('sube a HISTORICO_SUFICIENTE y a ALTA_CONFIANZA según lo que aporte el motor', () => {
    const points = pointsFrom(randomWalk(940, 0.01, 600, 3));

    expect(readMarket(points, { windows: WINDOWS, hasSufficientAnalogues: true }).evidence).toBe(
      'HISTORICO_SUFICIENTE'
    );
    expect(
      readMarket(points, {
        windows: WINDOWS,
        hasSufficientAnalogues: true,
        backtestValidated: true,
      }).evidence
    ).toBe('ALTA_CONFIANZA_ESTADISTICA');
  });
});

describe('la ventana se mide sobre la cadencia real', () => {
  it('una cadencia de 5 min hace que "15m" sean 3 observaciones, no 15', () => {
    const points = pointsFrom(randomWalk(940, 0.01, 600, 9), 5 * MIN);
    const r = readMarket(points, { windows: WINDOWS });

    const short = r.horizons.find((h) => h.label === '15m')!;
    expect(short.windowSteps).toBe(3);
    expect(short.measuredMs).toBe(15 * MIN);
  });
});

describe('liquidez', () => {
  it('el cambio se mide contra la mediana reciente, no contra el punto anterior', () => {
    // Un único hipo no puede leerse como un derrumbe de liquidez.
    const snap = readLiquidity(
      { buyUsdt: 1000, sellUsdt: 500, buyAds: 10, sellAds: 8 },
      [1000, 1000, 1000, 10, 1000],
      [1000, 1000, 1000]
    );
    expect(snap.buyChange).toBeCloseTo(0, 6);
    expect(snap.sellChange).toBeCloseTo(-0.5, 6);
  });

  it('sin base con la que comparar no inventa un cambio', () => {
    const snap = readLiquidity({ buyUsdt: 1000, sellUsdt: null, buyAds: 5, sellAds: null }, [], []);
    expect(snap.buyChange).toBeNull();
    expect(snap.sellUsdt).toBeNull();
    expect(snap.sellChange).toBeNull();
  });

  it('valores imposibles no se propagan', () => {
    const snap = readLiquidity(
      { buyUsdt: Number.NaN, sellUsdt: Number.POSITIVE_INFINITY, buyAds: 1, sellAds: 1 },
      [100],
      [100]
    );
    expect(snap.buyUsdt).toBeNull();
    expect(snap.sellUsdt).toBeNull();
  });
});

describe('la explicación cita datos, no adjetivos', () => {
  const points = pointsFrom(ramp(940, 0.05, 400));
  const result = readMarket(points, { windows: WINDOWS, hasSufficientAnalogues: true });

  it('nombra la fuerza con su número', () => {
    expect(result.narrative.join(' ')).toMatch(/\d+\/100/);
  });

  it('nombra la persistencia observada', () => {
    expect(result.narrative.join(' ')).toContain('% de los saltos');
  });

  it('explica la derivada del momentum citando las lecturas', () => {
    const fading = readMarket(
      pointsFrom(
        Array.from({ length: 400 }, (_, i) => Number((940 + i * 0.05 * (1 - i / 500)).toFixed(6)))
      ),
      { windows: WINDOWS }
    );
    const text = fading.narrative.join(' ');
    if (fading.movement.trend === 'DISMINUYENDO') {
      expect(text).toContain('cediendo');
      expect(text).toMatch(/\d+ a \d+/);
    } else {
      expect(text).toMatch(/estable|aumento/);
    }
  });

  it('termina siempre diciendo qué evidencia hay detrás', () => {
    expect(result.narrative[result.narrative.length - 1]).toBe(EVIDENCE_TEXT.HISTORICO_SUFICIENTE);
  });

  it('no lanza sin liquidez ni con narrativa vacía', () => {
    expect(
      buildNarrative({
        movement: readMomentum([], 1),
        horizons: [],
        predominant: { direction: 'INDETERMINADA', note: 'x' },
        liquidity: null,
        evidence: 'SIN_DATOS',
      })
    ).toEqual([EVIDENCE_TEXT.SIN_DATOS]);
  });
});

describe('robustez de la lectura completa', () => {
  it('ningún número no finito sale de readMarket', () => {
    for (const points of [
      [],
      pointsFrom([940]),
      pointsFrom(Array(600).fill(940)),
      pointsFrom(randomWalk(940, 0.01, 600, 21)),
    ]) {
      const r = readMarket(points, { windows: WINDOWS });
      const walk = (v: unknown): void => {
        if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(r);
    }
  });
});
