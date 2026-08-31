/**
 * EL INFORME DEL DÍA — TECHO DE MI VENTA, PISO DE MI COMPRA
 * ========================================================
 *
 * Series ARTIFICIALES, construidas para que la respuesta correcta se pueda
 * calcular a mano.
 *
 * El foco es la corrección económica: el techo tiene que salir SÓLO del lado
 * donde vendo y el piso SÓLO del lado donde recompro. Hay un caso con las dos
 * series cruzadas porque es el único que distingue la fórmula correcta de
 * `max(BUY, SELL)`, que da el mismo número mientras el libro esté ordenado.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDailyProjection,
  detectTurn,
  extractLegSeries,
  maxSpreadOf,
  remainingShare,
  speedFor,
} from '../server/dailyProjection.js';
import { MIN_PROFILE_DAYS, projectLeg } from '../server/projection/dailyShape.js';
import type { HistoryRecord } from '../server/types.js';

const at = (day: number, hour: number, minute = 0): number =>
  Date.UTC(2026, 7, day, hour + 4, minute, 0);

/**
 * Registro v2 con los dos precios estratégicos.
 *
 * `binanceBuy` va a `strategicBuyPrice` — el lado donde compiten mis anuncios
 * de VENTA — y `binanceSell` a `strategicSellPrice`, donde compiten los de mi
 * RECOMPRA. Los nombres de los parámetros dicen el lado de Binance; los de los
 * campos son los históricos del almacenamiento.
 */
const record = (t: number, binanceBuy: number, binanceSell: number): HistoryRecord => ({
  id: `tick-${t}`,
  timestamp: t,
  dateStr: new Date(t).toISOString(),
  hour: new Date(t - 4 * 3_600_000).getUTCHours(),
  buyPrice: binanceBuy,
  sellPrice: binanceSell,
  spreadPct: ((binanceSell - binanceBuy) / binanceBuy) * 100,
  bestBuyMerchant: 'artificial',
  bestSellMerchant: 'artificial',
  activeBuyAds: 20,
  activeSellAds: 20,
  source: 'TEST',
  calculationVersion: 'v2-strategic',
  strategicBuyPrice: binanceBuy,
  strategicSellPrice: binanceSell,
  strategicSpreadPct: ((binanceSell - binanceBuy) / binanceBuy) * 100,
});

const day = (d: number, buyAt: (h: number) => number, sellAt: (h: number) => number) => {
  const out: HistoryRecord[] = [];
  for (let h = 8; h <= 20; h += 1) out.push(record(at(d, h, 10), buyAt(h), sellAt(h)));
  return out;
};

const NOW = at(20, 12, 30);

describe('cada pierna lee su propio lado de Binance', () => {
  const records = [record(at(20, 9), 936, 931)];

  it('MI VENTA lee strategicBuyPrice', () => {
    expect(extractLegSeries(records, 'VENTA').points[0].price).toBe(936);
  });

  it('MI COMPRA lee strategicSellPrice', () => {
    expect(extractLegSeries(records, 'COMPRA').points[0].price).toBe(931);
  });

  it('las dos piernas nunca leen el mismo número', () => {
    expect(extractLegSeries(records, 'VENTA').points[0].price).not.toBe(
      extractLegSeries(records, 'COMPRA').points[0].price
    );
  });

  it('los registros v1 no cuentan como serie y la pérdida se publica', () => {
    const legacy = day(19, () => 936, () => 931).map((r) => {
      const { calculationVersion, strategicBuyPrice, strategicSellPrice, ...rest } = r;
      return rest as HistoryRecord;
    });
    const extraction = extractLegSeries(legacy, 'VENTA');
    expect(extraction.points).toHaveLength(0);
    expect(extraction.extraction.droppedLegacy).toBe(legacy.length);
  });
});

describe('TECHO = MAX(BINANCE BUY), PISO = MIN(BINANCE SELL)', () => {
  /*
   * El fixture del propietario, repartido en cuatro horas del mismo día:
   *   BUY  = [930, 936, 934, 940] → TECHO = 940
   *   SELL = [928, 932, 929, 931] → PISO  = 928
   */
  const BUY = [930, 936, 934, 940];
  const SELL = [928, 932, 929, 931];
  const records = BUY.map((b, i) => record(at(20, 9 + i), b, SELL[i]));
  const report = buildDailyProjection(records, at(20, 20));

  it('el techo vale 940 y viene del lado BUY', () => {
    expect(report.ceiling.observed?.price).toBe(940);
    expect(report.ceiling.leg).toBe('VENTA');
    expect(report.ceiling.binanceSide).toBe('BUY');
  });

  it('el piso vale 928 y viene del lado SELL', () => {
    expect(report.floor.observed?.price).toBe(928);
    expect(report.floor.leg).toBe('COMPRA');
    expect(report.floor.binanceSide).toBe('SELL');
  });

  it('el techo no es el mínimo de BUY ni el piso el máximo de SELL', () => {
    expect(report.ceiling.observed?.price).not.toBe(930);
    expect(report.floor.observed?.price).not.toBe(932);
  });
});

describe('REGRESIÓN: el techo y el piso no mezclan las dos piernas', () => {
  /*
   * Series CRUZADAS. Es el caso que el fixture ordenado no puede detectar.
   *
   *   BINANCE BUY  (mi venta)  = [930, 936]  → TECHO correcto = 936
   *   BINANCE SELL (mi compra) = [920, 945]  → PISO  correcto = 920
   *
   * `max(BUY, SELL)` diría 945: un precio que existió en el lado donde YO
   * RECOMPRO y al que nunca pude vender. Es exactamente el error que había.
   */
  const records = [record(at(20, 9), 930, 920), record(at(20, 10), 936, 945)];
  const report = buildDailyProjection(records, at(20, 20));

  it('el techo es 936 y NO el 945 que apareció en el lado de compra', () => {
    expect(report.ceiling.observed?.price).toBe(936);
    expect(report.ceiling.observed?.price).not.toBe(945);
  });

  it('el piso es 920 y sale del lado de compra', () => {
    expect(report.floor.observed?.price).toBe(920);
    expect(report.floor.leg).toBe('COMPRA');
  });

  it('el techo nunca puede caer en la pierna de compra', () => {
    expect(report.ceiling.leg).toBe('VENTA');
    expect(report.floor.leg).toBe('COMPRA');
  });
});

describe('sin histórico no se llena la pantalla', () => {
  const report = buildDailyProjection([], NOW);

  it('devuelve SIN_DATOS y dice cuántos días faltan', () => {
    expect(report.tier).toBe('SIN_DATOS');
    expect(report.daysMissing).toBe(MIN_PROFILE_DAYS);
    expect(report.ceiling.observed).toBeNull();
    expect(report.ceiling.projected).toBeNull();
    expect(report.ceiling.dayBest).toBeNull();
    expect(report.floor.dayBest).toBeNull();
    expect(report.remainingPct).toBeNull();
    expect(report.turn.pct).toBeNull();
  });

  it('las dos piernas siguen presentes, cada una sin evidencia', () => {
    expect(report.legs.map((l) => l.projection.leg)).toEqual(['VENTA', 'COMPRA']);
    for (const leg of report.legs) {
      expect(leg.evidence).toBe('SIN_DATOS_SUFICIENTES');
      expect(leg.backtest.days).toBe(0);
      expect(leg.backtest.pValue).toBeNull();
      expect(leg.backtest.beatsPersistence).toBe(false);
    }
  });
});

describe('con días suficientes', () => {
  /*
   * Días con la misma forma —sube hasta las 14, baja después— y un hoy más
   * alto. Mi venta por encima de mi recompra, que es de lo que vive un maker.
   */
  const shape = (h: number) => 1 + (h <= 14 ? (h - 8) * 0.004 : 0.024 - (h - 14) * 0.004);
  const records = [
    ...Array.from({ length: MIN_PROFILE_DAYS + 1 }, (_, i) =>
      day(10 + i, (h) => 936 * shape(h), (h) => 931 * shape(h))
    ).flat(),
    ...day(20, (h) => 950 * shape(h), (h) => 945 * shape(h)),
  ];
  const report = buildDailyProjection(records, NOW);

  it('proyecta las dos piernas por separado', () => {
    expect(report.tier).toBe('PERFIL_LIMITADO');
    for (const leg of report.legs) {
      expect(leg.projection.projected.length).toBeGreaterThan(0);
      expect(leg.projection.projectedClose).not.toBeNull();
      expect(leg.projection.projectedExtreme).not.toBeNull();
    }
  });

  it('el techo del día es el mejor entre lo observado y lo proyectado', () => {
    const c = report.ceiling;
    expect(c.dayBest).not.toBeNull();
    const candidates = [c.observed?.price, c.projected?.price].filter(
      (x): x is number => x !== undefined && x !== null
    );
    expect(c.dayBest).toBe(Math.max(...candidates));
  });

  it('el piso del día es el mínimo entre lo observado y lo proyectado', () => {
    const f = report.floor;
    const candidates = [f.observed?.price, f.projected?.price].filter(
      (x): x is number => x !== undefined && x !== null
    );
    expect(f.dayBest).toBe(Math.min(...candidates));
  });

  it('el margen máximo compara cada hora consigo misma y es positivo', () => {
    expect(report.maxSpread).not.toBeNull();
    // Mi venta por encima de mi compra: el margen del maker es positivo.
    expect(report.maxSpread!.spreadPct).toBeGreaterThan(0);
    expect(report.maxSpread!.hour).toBeGreaterThanOrEqual(report.startHour);
    expect(report.maxSpread!.hour).toBeLessThanOrEqual(report.endHour);
  });

  it('publica qué variables usa y cuáles no, con el motivo', () => {
    expect(report.variables.used.length).toBeGreaterThan(3);
    expect(report.variables.availableNotUsed.length).toBeGreaterThan(0);
    for (const v of report.variables.availableNotUsed) expect(v.reason.length).toBeGreaterThan(10);
    // Con seis días, la volatilidad todavía no entra como segundo filtro.
    expect(report.variables.availableNotUsed.map((v) => v.name)).toContain(
      'volatilidad realizada del día'
    );
  });

  it('sin backtest evaluable, la evidencia es estimación sin validar', () => {
    for (const leg of report.legs) {
      expect(['ESTIMACION_SIN_VALIDAR', 'EVIDENCIA_DEBIL', 'EVIDENCIA_FUERTE']).toContain(
        leg.evidence
      );
    }
  });
});

describe('el margen máximo', () => {
  it('no cruza una hora con otra', () => {
    const venta = projectLeg(
      [
        { t: at(20, 9), price: 940 },
        { t: at(20, 10), price: 900 },
      ],
      'VENTA',
      at(20, 20)
    );
    const compra = projectLeg(
      [
        { t: at(20, 9), price: 935 },
        { t: at(20, 10), price: 700 },
      ],
      'COMPRA',
      at(20, 20)
    );
    const spread = maxSpreadOf(venta, compra);
    // Cruzar la venta de las 9 (940) con la compra de las 10 (700) daría 34%.
    // El máximo legítimo es a las 10: (900 − 700) / 700 = 28.57%.
    expect(spread!.hour).toBe(10);
    expect(spread!.spreadPct).toBeCloseTo(((900 - 700) / 700) * 100, 6);
  });
});

describe('la velocidad se mide contra los propios días', () => {
  it('sin muestra suficiente es INDETERMINADA, no "moderado"', () => {
    expect(speedFor(1.5, [])).toBe('INDETERMINADA');
    expect(speedFor(null, [1, 2, 3, 4, 5, 6])).toBe('INDETERMINADA');
  });

  it('sitúa el cambio entre los tercios de los recorridos históricos', () => {
    const moves = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    expect(speedFor(0.15, moves)).toBe('LENTO');
    expect(speedFor(2.0, moves)).toBe('RAPIDO');
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
});

describe('cuánto queda por venir', () => {
  it('suma recorrido, no diferencia entre extremos', () => {
    /*
     * Sube 900→909 (+1 %) y vuelve a 900 (−0.990 %): el recorrido pasado es
     * 1.990 %. Medido como diferencia entre extremos valdría cero y esto diría
     * "queda el 100 %" de un día ya medio andado.
     */
    const real = [{ price: 900 }, { price: 909 }, { price: 900 }];
    const projected = [{ movePct: 1 }, { movePct: -1 }];
    const past = 1 + (9 / 909) * 100;
    const ahead = 2;
    const share = remainingShare(real, projected);
    expect(share).toBeCloseTo((ahead / (past + ahead)) * 100, 6);
    expect(share!).toBeLessThan(100);
  });

  it('sin nada que sumar no inventa un porcentaje', () => {
    expect(remainingShare([], [])).toBeNull();
  });

  it('las horas proyectadas sin movimiento medible no cuentan', () => {
    expect(remainingShare([{ price: 900 }, { price: 909 }], [{ movePct: null }])).toBeCloseTo(0, 6);
  });
});
