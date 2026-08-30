/**
 * EL INFORME DEL DÍA
 * ==================
 *
 * Comprueba las cifras de cabecera: techo, piso, spread máximo, dirección,
 * velocidad, giro y cuánto queda por venir. Las series son ARTIFICIALES y están
 * construidas para que la respuesta correcta se pueda calcular a mano.
 *
 * Lo que más importa aquí es lo que el informe NO debe hacer: cruzar horas
 * distintas para inflar el spread, poner "moderado" cuando no hay con qué
 * medir la velocidad, o llenar la pantalla cuando el histórico está vacío.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDailyProjection,
  detectTurn,
  remainingShare,
} from '../server/dailyProjection.js';
import { MIN_PROFILE_DAYS } from '../server/projection/dailyShape.js';
import type { HistoryRecord } from '../server/types.js';

const at = (day: number, hour: number, minute = 0): number =>
  Date.UTC(2026, 7, day, hour + 4, minute, 0);

/** Registro v2 con los dos precios estratégicos, que es lo que el motor lee. */
const record = (t: number, buy: number, sell: number): HistoryRecord => ({
  id: `tick-${t}`,
  timestamp: t,
  dateStr: new Date(t).toISOString(),
  hour: new Date(t - 4 * 3_600_000).getUTCHours(),
  buyPrice: buy,
  sellPrice: sell,
  spreadPct: ((sell - buy) / buy) * 100,
  bestBuyMerchant: 'artificial',
  bestSellMerchant: 'artificial',
  activeBuyAds: 20,
  activeSellAds: 20,
  source: 'TEST',
  calculationVersion: 'v2-strategic',
  strategicBuyPrice: buy,
  strategicSellPrice: sell,
  strategicSpreadPct: ((sell - buy) / buy) * 100,
});

/** Día entero de 8 a 20, un registro por hora. */
const day = (d: number, buyAt: (h: number) => number, sellAt: (h: number) => number) => {
  const out: HistoryRecord[] = [];
  for (let h = 8; h <= 20; h += 1) out.push(record(at(d, h, 10), buyAt(h), sellAt(h)));
  return out;
};

const NOW = at(20, 12, 30);

describe('sin histórico no se llena la pantalla', () => {
  it('devuelve SIN_DATOS y dice cuántos días faltan', () => {
    const report = buildDailyProjection([], NOW);
    expect(report.tier).toBe('SIN_DATOS');
    expect(report.daysMissing).toBe(MIN_PROFILE_DAYS);
    expect(report.ceiling).toBeNull();
    expect(report.floor).toBeNull();
    expect(report.market.direction).toBe('INDETERMINADA');
    expect(report.market.speed).toBe('INDETERMINADA');
    expect(report.remainingPct).toBeNull();
    expect(report.turn.pct).toBeNull();
  });

  it('los registros v1 no cuentan como serie y la pérdida se publica', () => {
    const legacy = day(19, () => 900, () => 890).map((r) => {
      const { calculationVersion, strategicBuyPrice, strategicSellPrice, ...rest } = r;
      return rest as HistoryRecord;
    });
    const report = buildDailyProjection(legacy, NOW);
    expect(report.tier).toBe('SIN_DATOS');
    expect(report.extraction.BUY.droppedLegacy).toBe(legacy.length);
  });
});

describe('con días suficientes', () => {
  /*
   * Cinco días anteriores con la misma forma —sube hasta las 14, baja después—
   * y un hoy que va por un nivel más alto. Recompra (ask) por encima de venta
   * (bid), que es la relación normal del libro y la que fija types.ts.
   */
  const shape = (h: number) => 1 + (h <= 14 ? (h - 8) * 0.004 : 0.024 - (h - 14) * 0.004);
  const records = [
    ...Array.from({ length: MIN_PROFILE_DAYS + 1 }, (_, i) =>
      day(10 + i, (h) => 900 * shape(h), (h) => 890 * shape(h))
    ).flat(),
    ...day(20, (h) => 950 * shape(h), (h) => 940 * shape(h)),
  ];

  const report = buildDailyProjection(records, NOW);

  it('proyecta los dos lados por separado y alcanza el nivel de perfil', () => {
    expect(report.tier).toBe('PERFIL_LIMITADO');
    expect(report.sides.map((s) => s.side).sort()).toEqual(['BUY', 'SELL']);
    for (const side of report.sides) expect(side.projected.length).toBeGreaterThan(0);
  });

  it('el techo y el piso salen de la trayectoria real y proyectada', () => {
    expect(report.ceiling).not.toBeNull();
    expect(report.floor).not.toBeNull();
    expect(report.ceiling!.price).toBeGreaterThan(report.floor!.price);
    // El techo está en la recompra, que es el lado alto del libro.
    expect(report.ceiling!.side).toBe('BUY');
    expect(report.floor!.side).toBe('SELL');
  });

  it('el spread máximo compara cada hora consigo misma', () => {
    expect(report.maxSpread).not.toBeNull();
    // venta por debajo de recompra: spread firmado negativo, que es lo normal.
    expect(report.maxSpread!.spreadPct).toBeLessThan(0);
    // 940 contra 950 son -1.05 %; cruzar horas distintas daría otra cosa.
    expect(report.maxSpread!.spreadPct).toBeCloseTo(((940 - 950) / 950) * 100, 6);
    expect(report.maxSpread!.hour).toBeGreaterThanOrEqual(report.startHour);
    expect(report.maxSpread!.hour).toBeLessThanOrEqual(report.endHour);
  });

  it('la dirección sigue a la forma: por la tarde estos días bajan', () => {
    expect(report.market.changePct).toBeLessThan(0);
    expect(report.market.direction).toBe('BAJANDO');
    expect(report.market.side).toBe('BUY');
  });

  it('publica el umbral de giro medido y la validación con su p', () => {
    expect(report.turn.pct).not.toBeNull();
    expect(report.turn.sampleSize).toBeGreaterThan(0);
    expect(report.validation.comparisons).toBeLessThanOrEqual(MIN_PROFILE_DAYS + 1);
  });

  it('la ventana a vigilar es un tramo real de la proyección', () => {
    expect(report.watchWindow).not.toBeNull();
    expect(report.watchWindow!.toHour).toBeGreaterThan(report.watchWindow!.fromHour);
    expect(report.watchWindow!.toHour).toBeLessThanOrEqual(report.endHour);
  });

  it('lo que queda por venir es una fracción, no un precio', () => {
    expect(report.remainingPct).not.toBeNull();
    expect(report.remainingPct!).toBeGreaterThanOrEqual(0);
    expect(report.remainingPct!).toBeLessThanOrEqual(100);
  });
});

describe('el giro necesita cambio de signo Y tamaño', () => {
  const path = (prices: number[]) => prices.map((price, i) => ({ hour: 8 + i, price }));

  it('un movimiento grande que sigue la tendencia no es un giro', () => {
    expect(detectTurn(path([900, 910, 920]), 0.5)).toBe(false);
  });

  it('un cambio de signo por debajo del umbral es ruido', () => {
    expect(detectTurn(path([900, 910, 909.5]), 0.5)).toBe(false);
  });

  it('cambio de signo y por encima del umbral sí es un giro', () => {
    expect(detectTurn(path([900, 910, 895]), 0.5)).toBe(true);
  });

  it('sin umbral medido no se declara ningún giro', () => {
    expect(detectTurn(path([900, 910, 895]), null)).toBe(false);
  });

  it('con menos de tres horas no hay movimiento anterior con el que comparar', () => {
    expect(detectTurn(path([900, 895]), 0.1)).toBe(false);
  });
});

describe('cuánto queda por venir', () => {
  it('suma recorrido, no diferencia entre extremos', () => {
    /*
     * Sube 900→909 (+1 %) y vuelve a 900 (−0.990 %): el recorrido pasado es
     * 1.990 %, no 0 %. Medido como diferencia entre extremos el pasado valdría
     * cero y esto diría "queda por venir el 100 %" de un día ya medio andado.
     */
    const real = [
      { hour: 8, price: 900 },
      { hour: 9, price: 909 },
      { hour: 10, price: 900 },
    ];
    const projected = [{ hour: 11, movePct: 1 }, { hour: 12, movePct: -1 }];
    const share = remainingShare(real, projected);
    expect(share).not.toBeNull();
    const past = 1 + (9 / 909) * 100; // +1.000 % y luego −0.990 %
    const ahead = 1 + 1;
    expect(share!).toBeCloseTo((ahead / (past + ahead)) * 100, 6);
    expect(share!).toBeLessThan(100);
  });

  it('sin nada que sumar no inventa un porcentaje', () => {
    expect(remainingShare([], [])).toBeNull();
  });

  it('las horas proyectadas sin movimiento medible no cuentan', () => {
    const real = [
      { hour: 8, price: 900 },
      { hour: 9, price: 909 },
    ];
    expect(remainingShare(real, [{ hour: 10, movePct: null }])).toBeCloseTo(0, 6);
  });
});
