/**
 * EL MOTOR DE DECISIÓN, PROTEGIDO EN LO QUE PUEDE ROMPERSE EN SILENCIO
 * =====================================================================
 *
 * Cada bloque corresponde a una garantía que, si se pierde, no produce
 * ningún error visible: sigue saliendo un número, sólo que deja de
 * significar lo que dice. Ése es exactamente el fallo que este motor existe
 * para no repetir.
 */

import { describe, expect, it } from 'vitest';
import {
  buildHourlyGrid,
  GRID_FIELD,
  pctChange,
  type HourlyGrid,
} from '../server/projection/hourlyGrid.js';
import {
  computeFeatureSeries,
  featuresAt,
  legConsistency,
} from '../server/projection/marketFeatures.js';
import {
  buildModels,
  medianMove,
  momentum,
  naive,
  MODEL_IDS,
} from '../server/projection/forecastModels.js';
import {
  runWalkForward,
  HORIZONS,
  MIN_HISTORY_HOURS,
  SIGNAL_TO_NOISE_FLOOR,
} from '../server/projection/walkForward.js';
import {
  classifyConfidence,
  classifyRegime,
  decideAction,
  empiricalContinuation,
} from '../server/projection/decisionEngine.js';
import { buildMarketReading, combineDecisions } from '../server/marketDecision.js';
import type { HistoryRecord } from '../server/types.js';

/* ------------------------------------------------------------------------ *
 * GENERADORES DETERMINISTAS
 * ------------------------------------------------------------------------ */

// mulberry32: aritmética de 32 bits exacta vía Math.imul y periodo 2^32.
// El LCG anterior (s * 1103515245) desbordaba 2^53, perdía precisión y para
// algunas semillas entraba en ciclos cortos (seed 37: periodo 220), de modo
// que la serie "aleatoria" era en realidad periódica y por tanto predecible.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normalFrom(seed: number) {
  const r = rng(seed);
  return () => {
    const u = Math.max(r(), 1e-9);
    const v = Math.max(r(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

const T0 = Date.UTC(2026, 3, 1, 4, 0, 0);

function record(t: number, buyPrice: number, sellPrice: number): HistoryRecord {
  return {
    id: `r-${t}-${sellPrice}`,
    timestamp: t,
    dateStr: Number.isFinite(t) ? new Date(t).toISOString() : 'invalid',
    hour: 0,
    buyPrice,
    sellPrice,
    spreadPct: ((sellPrice - buyPrice) / buyPrice) * 100,
    bestBuyMerchant: 'general',
    bestSellMerchant: 'general',
    activeBuyAds: 20,
    activeSellAds: 20,
    source: 'TEST',
  };
}

type Regime = 'trend_up' | 'trend_down' | 'flat' | 'randomwalk';

/** Histórico sintético de `hours` horas con `perHour` capturas por hora. */
function synthetic(regime: Regime, hours: number, seed: number, perHour = 12): HistoryRecord[] {
  const N = normalFrom(seed);
  const out: HistoryRecord[] = [];
  let price = 940;
  for (let h = 0; h < hours; h += 1) {
    if (regime === 'trend_up') price *= 1 + 0.0008 + 0.0006 * N();
    else if (regime === 'trend_down') price *= 1 - 0.0008 + 0.0006 * N();
    else if (regime === 'randomwalk') price *= 1 + 0.0012 * N();
    else price = 940 + 0.05 * N(); // plano: ruido minúsculo alrededor de 940
    const base = T0 + h * 3_600_000;
    for (let k = 0; k < perHour; k += 1) {
      const p = price * (1 + 0.0002 * N());
      out.push(record(base + k * 60_000, p - 2, p));
    }
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════
 * 1. SEMÁNTICA: VENTA = máximo sellPrice, COMPRA = mínimo buyPrice
 * ════════════════════════════════════════════════════════════════════════ */
describe('1. la semántica del libro no se puede invertir', () => {
  it('cada pierna lee su propio campo, declarado en un solo sitio', () => {
    expect(GRID_FIELD).toEqual({ VENTA: 'sellPrice', COMPRA: 'buyPrice' });
  });

  it('VENTA sale de sellPrice y COMPRA de buyPrice, nunca cruzados', () => {
    const records = [
      record(T0, 930, 950),
      record(T0 + 60_000, 931, 951),
      record(T0 + 120_000, 932, 952),
    ];
    const venta = buildHourlyGrid(records, 'VENTA');
    const compra = buildHourlyGrid(records, 'COMPRA');

    // Mediana de los sellPrice y de los buyPrice, cada una en su pierna.
    expect(venta.cells[0]!.level).toBe(951);
    expect(compra.cells[0]!.level).toBe(931);
    expect(venta.cells[0]!.level).not.toBe(compra.cells[0]!.level);
  });

  it('cambiar sólo buyPrice no mueve la serie de VENTA', () => {
    const base = [record(T0, 930, 950), record(T0 + 60_000, 931, 951)];
    const altered = base.map((r) => ({ ...r, buyPrice: 1 }));
    const a = buildHourlyGrid(base, 'VENTA').cells[0]!.level;
    const b = buildHourlyGrid(altered, 'VENTA').cells[0]!.level;
    expect(a).toBe(b);
  });

  it('la decisión de cada pierna es opuesta ante la misma subida', () => {
    // MI VENTA sube -> conviene esperar/pedir más. MI COMPRA sube -> comprar ya.
    expect(decideAction('VENTA', +1, 'CONTINUACION', 'MEDIA')).toBe('ESPERAR');
    expect(decideAction('COMPRA', +1, 'CONTINUACION', 'MEDIA')).toBe('PUBLICAR');
    // Y ante la misma bajada, también opuestas.
    expect(decideAction('VENTA', -1, 'CONTINUACION', 'MEDIA')).toBe('BAJAR_PRECIO');
    expect(decideAction('COMPRA', -1, 'CONTINUACION', 'MEDIA')).toBe('ESPERAR');
  });

  it('el cambio porcentual conserva el signo: nunca Math.abs', () => {
    const down = pctChange(
      { t: 0, level: 100, observations: 5, hourOfDay: 0, dayKey: 'd', weekday: 1, wellObserved: true },
      { t: 0, level: 90, observations: 5, hourOfDay: 1, dayKey: 'd', weekday: 1, wellObserved: true }
    );
    expect(down).toBe(-10);
    expect(down).not.toBe(Math.abs(down!));
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 2. SIN LOOK-AHEAD
 * ════════════════════════════════════════════════════════════════════════ */
describe('2. el futuro no puede cambiar una señal del pasado', () => {
  it('los estados del pasado son idénticos aunque se añada futuro nuevo', () => {
    const past = synthetic('trend_up', 120, 5);
    const withFuture = [...past, ...synthetic('trend_down', 60, 9).map((r) => ({
      ...r,
      timestamp: r.timestamp + 120 * 3_600_000,
      id: `${r.id}-future`,
    }))];

    const gridPast = buildHourlyGrid(past, 'VENTA');
    const gridBoth = buildHourlyGrid(withFuture, 'VENTA');

    // Mismo origen -> los mismos índices describen las mismas horas.
    expect(gridBoth.startMs).toBe(gridPast.startMs);

    for (let i = 0; i < gridPast.cells.length; i += 1) {
      const a = featuresAt(gridPast, i);
      const b = featuresAt(gridBoth, i);
      expect(b?.level ?? null).toBe(a?.level ?? null);
      expect(b?.velocityPctPerHour ?? null).toBe(a?.velocityPctPerHour ?? null);
      expect(b?.accelerationPctPerHour2 ?? null).toBe(a?.accelerationPctPerHour2 ?? null);
      expect(b?.volatilityPct ?? null).toBe(a?.volatilityPct ?? null);
    }
  });

  it('las predicciones de un índice pasado no cambian al conocerse el futuro', () => {
    const past = synthetic('trend_up', 120, 13);
    const withFuture = [...past, ...synthetic('trend_down', 60, 17).map((r) => ({
      ...r,
      timestamp: r.timestamp + 120 * 3_600_000,
      id: `${r.id}-f`,
    }))];
    const gridPast = buildHourlyGrid(past, 'VENTA');
    const gridBoth = buildHourlyGrid(withFuture, 'VENTA');
    const models = buildModels();

    for (const id of MODEL_IDS) {
      for (const horizon of [1, 4, 24] as const) {
        const i = 100; // un índice bien dentro del pasado común
        const a = models[id]({ grid: gridPast, i, horizon });
        const b = models[id]({ grid: gridBoth, i, horizon });
        expect(b, `${id} h=${horizon}`).toBe(a);
      }
    }
  });

  it('la caché de estados devuelve exactamente lo mismo que calcularlos', () => {
    const grid = buildHourlyGrid(synthetic('randomwalk', 80, 23), 'VENTA');
    const cache = computeFeatureSeries(grid);
    for (let i = 0; i < grid.cells.length; i += 1) {
      expect(cache[i]?.velocityPctPerHour ?? null).toBe(featuresAt(grid, i)?.velocityPctPerHour ?? null);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 3. LA REJILLA ES UN NIVEL, NO UN EXTREMO DE N MUESTRAS
 * ════════════════════════════════════════════════════════════════════════ */
describe('3. el nivel horario no depende de cuántas veces se capturó', () => {
  it('duplicar las capturas de una hora no mueve su nivel', () => {
    const few = [record(T0, 928, 948), record(T0 + 60_000, 930, 950), record(T0 + 120_000, 932, 952)];
    // Las mismas tres observaciones repetidas: un extremo subiría, la mediana no.
    const many = [...few, ...few.map((r, k) => ({ ...r, id: `${r.id}-dup${k}`, timestamp: r.timestamp + 1_000 }))];

    const a = buildHourlyGrid(few, 'VENTA').cells[0]!;
    const b = buildHourlyGrid(many, 'VENTA').cells[0]!;
    expect(b.level).toBe(a.level);
    expect(b.observations).toBeGreaterThan(a.observations);
  });

  it('una hora poco observada se marca, pero no se descarta ni se rellena', () => {
    const grid = buildHourlyGrid([record(T0, 930, 950)], 'VENTA');
    expect(grid.cells[0]!.wellObserved).toBe(false);
    expect(grid.cells[0]!.observations).toBe(1);
    expect(grid.cells[0]!.level).toBe(950);
  });

  it('una hora sin capturas queda como hueco, jamás interpolada', () => {
    const records = [record(T0, 930, 950), record(T0 + 2 * 3_600_000, 940, 960)];
    const grid = buildHourlyGrid(records, 'VENTA');
    expect(grid.cells).toHaveLength(3);
    expect(grid.cells[1]).toBeNull();
    expect(grid.missingHours).toBe(1);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 4. MERCADO LATERAL: NO INVENTA UNA DIRECCIÓN
 * ════════════════════════════════════════════════════════════════════════ */
describe('4. un mercado lateral no produce una señal direccional', () => {
  it('no emite acción direccional sobre ruido plano', () => {
    const reading = buildMarketReading(synthetic('flat', 240, 31));
    for (const d of [...reading.venta, ...reading.compra]) {
      expect(['SUBIR_PRECIO', 'BAJAR_PRECIO', 'AUMENTAR_EXPOSICION']).not.toContain(d.decision);
    }
  });

  /*
   * SOBRE UN PASEO ALEATORIO NO HAY NADA QUE PREDECIR.
   *
   * La afirmación honesta NO es "ningún horizonte elige modelo jamás": con 7
   * modelos, 6 horizontes y un alfa distinto de cero, algún falso positivo
   * ocasional es matemáticamente inevitable, y además un camino aleatorio
   * concreto puede tener deriva realizada que un modelo de tendencia explota
   * legítimamente. Afirmar lo contrario sería un test que sólo pasa eligiendo
   * la semilla que conviene.
   *
   * Lo que sí se exige, y es lo que protege al maker, son tres propiedades
   * sobre un CONJUNTO de semillas:
   *   1. lo normal es abstenerse (mediana de horizontes elegidos = 0);
   *   2. los falsos positivos se quedan dentro del presupuesto de alfa;
   *   3. y sobre todo: NUNCA se publica una señal peor que una moneda.
   *
   * La tercera es la crítica. Antes de la puerta de confirmación en test, el
   * motor llegaba a publicar modelos con 27%-34% de acierto: no ruido, sino
   * señal INVERTIDA, que haría perder dinero.
   */
  it('sobre paseos aleatorios se abstiene, y jamás publica una señal peor que el azar', () => {
    const seeds = [37, 31, 41, 7, 101, 202, 303, 404];
    const chosenPerSeed: number[] = [];
    let slots = 0;
    let selected = 0;

    for (const seed of seeds) {
      const grid = buildHourlyGrid(synthetic('randomwalk', 600, seed), 'VENTA');
      const wf = runWalkForward(grid);
      expect(wf.evaluable).toBe(true);

      const chosen = HORIZONS.filter((h) => wf.chosen[h] != null);
      chosenPerSeed.push(chosen.length);
      slots += HORIZONS.length;
      selected += chosen.length;

      // 3. Ningún modelo publicado puede acertar menos que una moneda.
      for (const h of chosen) {
        const t = wf.test.find((m) => m.horizon === h && m.model === wf.chosen[h]);
        expect(t).toBeDefined();
        expect(t!.signalAccuracy).not.toBeNull();
        expect(t!.signalAccuracy!).toBeGreaterThan(0.5);
      }
    }

    // 1. Lo normal, sobre datos sin memoria, es no encontrar modelo.
    const sorted = [...chosenPerSeed].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]).toBe(0);

    // 2. Los falsos positivos caben en el presupuesto de alfa (0.05).
    expect(selected / slots).toBeLessThanOrEqual(0.05);
  }, 60_000);
});

/* ════════════════════════════════════════════════════════════════════════
 * 5. CONTINUACIÓN Y REVERSIÓN, MEDIDAS Y NO AFIRMADAS
 * ════════════════════════════════════════════════════════════════════════ */
describe('5. continuación y reversión salen de frecuencias observadas', () => {
  it('una tendencia sostenida registra más continuaciones que giros', () => {
    const grid = buildHourlyGrid(synthetic('trend_up', 300, 41), 'VENTA');
    const features = computeFeatureSeries(grid);
    const last = grid.cells.length - 1;
    const evidence = empiricalContinuation(grid, features, last, 4);
    expect(evidence.cases).toBeGreaterThanOrEqual(20);
    expect(evidence.continuedCount).toBeGreaterThan(evidence.reversedCount);
  });

  it('con muestra corta no se publica ninguna frecuencia', () => {
    const grid = buildHourlyGrid(synthetic('trend_up', 12, 43), 'VENTA');
    const features = computeFeatureSeries(grid);
    const evidence = empiricalContinuation(grid, features, grid.cells.length - 1, 4);
    expect(evidence.continuation).toBeNull();
    expect(evidence.reversal).toBeNull();
  });

  it('una diferencia que cabe en el azar no se nombra régimen direccional', () => {
    const f = {
      index: 10, t: T0, level: 940, hourOfDay: 5, weekday: 2,
      direction: 1 as const, magnitudePct: 1, velocityPctPerHour: 0.25,
      accelerationPctPerHour2: 0.01, volatilityPct: 0.1, rangePosition: 0.8,
      consistency: 0.9, contiguousHours: 24, usable: true,
    };
    // 18 continuaciones frente a 20 giros: ruido puro con esta muestra.
    expect(classifyRegime(f, { continuedCount: 18, reversedCount: 20, cases: 40 })).not.toBe('REVERSION');
    // 36 frente a 4 sí sale del azar.
    expect(classifyRegime(f, { continuedCount: 36, reversedCount: 4, cases: 40 })).toBe('CONTINUACION');
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 6. INCERTIDUMBRE: UNA SEÑAL MENOR QUE EL ERROR NO DECIDE
 * ════════════════════════════════════════════════════════════════════════ */
describe('6. una proyección menor que el error histórico no produce señal', () => {
  it('por debajo del suelo señal/ruido la confianza es NULA', () => {
    expect(classifyConfidence(0.5, 100, true)).toBe('NULA');
    expect(classifyConfidence(SIGNAL_TO_NOISE_FLOOR - 0.01, 100, true)).toBe('NULA');
  });

  it('con confianza NULA la acción es siempre NO_DECIDIR', () => {
    for (const leg of ['VENTA', 'COMPRA'] as const) {
      for (const move of [-2, -0.1, 0.1, 2]) {
        expect(decideAction(leg, move, 'CONTINUACION', 'NULA')).toBe('NO_DECIDIR');
      }
    }
  });

  it('sin modelo validado tampoco hay confianza', () => {
    expect(classifyConfidence(5, 100, false)).toBe('NULA');
  });

  it('el ejemplo del operador: +0.15% con error ±0.40% no decide; +1.20% con ±0.35% sí', () => {
    expect(classifyConfidence(0.15 / 0.4, 40, true)).toBe('NULA');
    expect(classifyConfidence(1.2 / 0.35, 40, true)).toBe('ALTA');
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 7. DATOS INSUFICIENTES
 * ════════════════════════════════════════════════════════════════════════ */
describe('7. sin evidencia suficiente el motor dice NO DECIDIR', () => {
  it('un histórico corto no produce walk-forward', () => {
    const grid = buildHourlyGrid(synthetic('trend_up', MIN_HISTORY_HOURS - 10, 47), 'VENTA');
    const wf = runWalkForward(grid);
    expect(wf.evaluable).toBe(false);
    expect(wf.reason).toMatch(/insuficiente/i);
  });

  it('un histórico vacío no lanza y devuelve NO_DECIDIR', () => {
    const reading = buildMarketReading([]);
    expect(reading.decision).toBe('NO_DECIDIR');
    expect(reading.observedHours).toBe(0);
    expect(reading.venta.every((d) => d.decision === 'NO_DECIDIR')).toBe(true);
  });

  it('un histórico corto decide NO_DECIDIR y lo explica', () => {
    const reading = buildMarketReading(synthetic('trend_up', 20, 53));
    expect(reading.decision).toBe('NO_DECIDIR');
    expect(reading.insufficientReason).toMatch(/insuficiente/i);
    expect(reading.venta[0].reason.length).toBeGreaterThan(20);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 8. DATOS INVÁLIDOS
 * ════════════════════════════════════════════════════════════════════════ */
describe('8. NaN, Infinity, negativos y timestamps rotos no entran', () => {
  it('la rejilla descarta precios imposibles y timestamps no finitos', () => {
    const records: HistoryRecord[] = [
      record(T0, 930, Number.NaN),
      record(T0 + 60_000, 930, Number.POSITIVE_INFINITY),
      record(T0 + 120_000, 930, -5),
      record(T0 + 180_000, 930, 0),
      { ...record(T0 + 240_000, 930, 950), timestamp: Number.NaN },
      record(T0 + 300_000, 930, 950),
    ];
    const grid = buildHourlyGrid(records, 'VENTA');
    expect(grid.observedHours).toBe(1);
    expect(grid.cells[0]!.level).toBe(950);
    expect(grid.cells[0]!.observations).toBe(1);
  });

  it('el motor completo no lanza con entrada hostil', () => {
    const hostile: HistoryRecord[] = [
      record(Number.NaN, Number.NaN, Number.NaN),
      record(T0, -1, -1),
      record(T0 + 3_600_000, Number.POSITIVE_INFINITY, 0),
    ];
    expect(() => buildMarketReading(hostile)).not.toThrow();
    expect(buildMarketReading(hostile).decision).toBe('NO_DECIDIR');
  });

  it('ninguna salida del motor es NaN o Infinity', () => {
    const reading = buildMarketReading(synthetic('trend_up', 300, 59));
    for (const d of [...reading.venta, ...reading.compra]) {
      for (const v of [
        d.currentPrice.value, d.projectedPrice.value, d.projectedLow.value, d.projectedHigh.value,
        d.expectedMovePct.value, d.historicalErrorPct.value, d.signalToNoise.value,
        d.velocityPctPerHour.value, d.accelerationPctPerHour2.value, d.volatilityPct.value,
      ]) {
        if (v !== null) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 9. PROCEDENCIA
 * ════════════════════════════════════════════════════════════════════════ */
describe('9. cada número dice de dónde salió', () => {
  it('lo observado es REAL, lo proyectado es PROJECTED, lo derivado AGGREGATED', () => {
    const reading = buildMarketReading(synthetic('trend_up', 300, 61));
    const d = reading.venta[0];
    expect(d.currentPrice.provenance).toBe('REAL');
    expect(d.projectedPrice.provenance).toBe('PROJECTED');
    expect(d.projectedLow.provenance).toBe('PROJECTED');
    expect(d.velocityPctPerHour.provenance).toBe('AGGREGATED');
    expect(d.continuationProbability.provenance).toBe('AGGREGATED');
    // Y cada uno explica su origen en una frase.
    expect(d.currentPrice.source.length).toBeGreaterThan(5);
    expect(d.historicalErrorPct.source).toMatch(/validación/i);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 10. LA PROYECCIÓN GENERAL NO USA BANCO NI MONTO
 * ════════════════════════════════════════════════════════════════════════ */
describe('10. el motor lee sólo el libro general', () => {
  it('un campo de banco/monto en el registro no cambia nada', () => {
    const base = synthetic('trend_up', 200, 67);
    const tagged = base.map((r) => ({ ...r, filterBank: 'BANESCO', filterAmount: 999_999 }));
    const a = buildMarketReading(base, T0 + 200 * 3_600_000);
    const b = buildMarketReading(tagged, T0 + 200 * 3_600_000);
    expect(b.venta[0].currentPrice.value).toBe(a.venta[0].currentPrice.value);
    expect(b.venta[0].decision).toBe(a.venta[0].decision);
  });

  it('los módulos del motor no importan ninguna fuente por banco', async () => {
    const fs = await import('node:fs');
    for (const file of [
      'hourlyGrid.ts', 'marketFeatures.ts', 'forecastModels.ts', 'walkForward.ts', 'decisionEngine.ts',
    ]) {
      const src = fs.readFileSync(`server/projection/${file}`, 'utf8');
      expect(src, file).not.toMatch(/HistoricalMarketStore|makerMatrix|executableMatrix|strategicBuyPrice|strategicSellPrice/);
    }
    const top = fs.readFileSync('server/marketDecision.ts', 'utf8');
    expect(top).not.toMatch(/HistoricalMarketStore|makerMatrix|executableMatrix/);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 11. MODELOS Y COMBINACIÓN DE DECISIONES
 * ════════════════════════════════════════════════════════════════════════ */
describe('11. los modelos y la combinación se comportan como dicen', () => {
  it('el ingenuo devuelve exactamente el precio actual', () => {
    const grid: HourlyGrid = buildHourlyGrid(synthetic('trend_up', 40, 71), 'VENTA');
    const i = grid.cells.length - 1;
    expect(naive({ grid, i, horizon: 4 })).toBe(grid.cells[i]!.level);
  });

  it('el momento extrapola en la dirección de la velocidad', () => {
    const grid = buildHourlyGrid(synthetic('trend_up', 60, 73), 'VENTA');
    const i = grid.cells.length - 1;
    const now = grid.cells[i]!.level;
    const predicted = momentum({ grid, i, horizon: 4 });
    const velocity = featuresAt(grid, i)!.velocityPctPerHour!;
    expect(predicted).not.toBeNull();
    expect(Math.sign(predicted! - now)).toBe(Math.sign(velocity));
  });

  it('la mediana de movimientos necesita muestra antes de responder', () => {
    const grid = buildHourlyGrid(synthetic('trend_up', 6, 79), 'VENTA');
    expect(medianMove({ grid, i: grid.cells.length - 1, horizon: 4 })).toBeNull();
  });

  it('dos piernas en desacuerdo REAL no inventan una tercera acción', () => {
    // ESPERAR es alcista y PUBLICAR bajista: conflicto de sentido de verdad.
    expect(combineDecisions('ESPERAR', 'PUBLICAR')).toBe('MANTENER_PRECIO');
    expect(combineDecisions('SUBIR_PRECIO', 'REDUCIR_EXPOSICION')).toBe('MANTENER_PRECIO');
    expect(combineDecisions('ESPERAR', 'ESPERAR')).toBe('ESPERAR');
    expect(combineDecisions('NO_DECIDIR', 'PUBLICAR')).toBe('NO_DECIDIR');
    expect(combineDecisions('PUBLICAR', 'NO_DECIDIR')).toBe('NO_DECIDIR');
  });

  /*
   * El titular no puede contradecir a sus propias piernas. Dos acciones
   * distintas que apuntan al MISMO lado del mercado no son un desacuerdo: en
   * una tendencia alcista, subir el precio de venta y aumentar la exposición
   * comprada son las dos la misma lectura.
   */
  it('acciones distintas pero del mismo sentido no se resumen como MANTENER', () => {
    expect(combineDecisions('SUBIR_PRECIO', 'AUMENTAR_EXPOSICION')).toBe('SUBIR_PRECIO');
    expect(combineDecisions('BAJAR_PRECIO', 'REDUCIR_EXPOSICION')).toBe('BAJAR_PRECIO');
  });

  it('una tendencia alcista clara no acaba aconsejando mantener el precio', () => {
    const reading = buildMarketReading(synthetic('trend_up', 700, 41));
    const venta = reading.venta.find((d) => d.horizon === reading.headlineHorizon)!;
    const compra = reading.compra.find((d) => d.horizon === reading.headlineHorizon)!;

    // Precondición: la tendencia es detectada por las dos piernas.
    expect(venta.decision).toBe('SUBIR_PRECIO');
    expect(compra.decision).toBe('AUMENTAR_EXPOSICION');

    // Y el titular las respeta en vez de contradecirlas.
    expect(reading.decision).toBe('SUBIR_PRECIO');
  }, 30_000);

  it('el acuerdo entre piernas sólo se mide sobre el mismo instante', () => {
    const a = { t: 1, direction: 1 } as any;
    const b = { t: 2, direction: 1 } as any;
    expect(legConsistency(a, b)).toBeNull();
    expect(legConsistency(a, { ...b, t: 1 })).toBe(1);
    expect(legConsistency(a, { t: 1, direction: -1 } as any)).toBe(0);
  });
});
