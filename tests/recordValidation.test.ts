/**
 * QUÉ PUEDE ENTRAR EN EL HISTÓRICO
 * ================================
 *
 * Un registro corrupto no se nota el día que se escribe: se nota semanas
 * después, cuando una mediana sale absurda y ya no se puede saber cuál de
 * cuarenta mil observaciones la envenenó. Estas pruebas fijan exactamente qué
 * se rechaza y por qué, y que el rechazo deja un HUECO en lugar de un valor
 * inventado.
 */

import { describe, expect, it } from 'vitest';
import {
  CLOCK_SKEW_TOLERANCE_MS,
  EARLIEST_PLAUSIBLE_TIMESTAMP,
  validateHistoryRecord,
} from '../server/recordValidation.js';
import { buildMarketContext, sumSideLiquidity } from '../server/marketContext.js';
import type { HistoryRecord, MarketSnapshot, NormalizedAd } from '../server/types.js';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

function record(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: 'tick-1',
    timestamp: NOW - 60_000,
    dateStr: '2026-08-01',
    hour: 8,
    buyPrice: 940,
    sellPrice: 945,
    spreadPct: 0.53,
    bestBuyMerchant: 'A',
    bestSellMerchant: 'B',
    activeBuyAds: 20,
    activeSellAds: 20,
    source: 'BINANCE_P2P',
    ...overrides,
  };
}

const ok = (r: HistoryRecord) => validateHistoryRecord(r, NOW).ok;
const why = (r: HistoryRecord) => validateHistoryRecord(r, NOW).reasons.join('; ');

describe('un registro sano pasa', () => {
  it('acepta el registro mínimo válido', () => {
    expect(ok(record())).toBe(true);
    expect(validateHistoryRecord(record(), NOW).reasons).toEqual([]);
  });

  it('un spread NEGATIVO es válido: vender por debajo de la recompra es una pérdida real', () => {
    // Borrarla falsearía el mercado. Sólo se exige que el número exista.
    expect(ok(record({ spreadPct: -1.2 }))).toBe(true);
  });
});

describe('precios imposibles', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negativo', -940],
    ['cero', 0],
  ])('rechaza buyPrice %s', (_name, value) => {
    expect(ok(record({ buyPrice: value }))).toBe(false);
    expect(why(record({ buyPrice: value }))).toContain('buyPrice imposible');
  });

  it('rechaza sellPrice imposible por separado', () => {
    expect(why(record({ sellPrice: -1 }))).toContain('sellPrice imposible');
  });

  it('rechaza un spread no finito', () => {
    expect(why(record({ spreadPct: Number.NaN }))).toContain('spreadPct no finito');
  });
});

describe('timestamps', () => {
  it('rechaza los no finitos', () => {
    expect(why(record({ timestamp: Number.NaN }))).toContain('timestamp no finito');
  });

  it('rechaza un reloj anterior al proyecto', () => {
    expect(why(record({ timestamp: EARLIEST_PLAUSIBLE_TIMESTAMP - 1 }))).toContain(
      'anterior al proyecto'
    );
  });

  it('rechaza un futuro inventado pero tolera el desfase de reloj', () => {
    expect(ok(record({ timestamp: NOW + CLOCK_SKEW_TOLERANCE_MS - 1000 }))).toBe(true);
    expect(why(record({ timestamp: NOW + CLOCK_SKEW_TOLERANCE_MS + 1000 }))).toContain(
      'en el futuro'
    );
  });
});

describe('recuentos de anuncios', () => {
  it.each([
    ['negativo', -1],
    ['fraccionario', 2.5],
    ['NaN', Number.NaN],
  ])('rechaza activeBuyAds %s', (_name, value) => {
    expect(why(record({ activeBuyAds: value }))).toContain('activeBuyAds');
  });
});

describe('la capa estratégica es todo o nada', () => {
  it('exige los tres campos cuando se declara v2', () => {
    const partial = record({
      calculationVersion: 'v2-strategic',
      strategicBuyPrice: 940,
      strategicSellPrice: Number.NaN,
      strategicSpreadPct: 0.5,
    });
    expect(why(partial)).toContain('strategicSellPrice imposible');
  });

  it('rechaza precios estratégicos sin la versión que los declara', () => {
    // Nadie sabría después con qué método se calcularon.
    expect(why(record({ strategicBuyPrice: 940 }))).toContain('sin calculationVersion');
  });

  it('acepta un registro v2 completo y sano', () => {
    expect(
      ok(
        record({
          calculationVersion: 'v2-strategic',
          strategicBuyPrice: 940,
          strategicSellPrice: 945,
          strategicSpreadPct: 0.53,
        })
      )
    ).toBe(true);
  });
});

describe('la capa de contexto v3', () => {
  const v3 = (o: Partial<HistoryRecord>) => record({ enrichmentVersion: 'v3-context', ...o });

  it('acepta liquidez CERO: es un libro seco, no un error', () => {
    expect(ok(v3({ buyLiquidityUsdt: 0, buyLiquidityAds: 3 }))).toBe(true);
  });

  it('rechaza liquidez negativa o no finita', () => {
    expect(why(v3({ buyLiquidityUsdt: -5 }))).toContain('buyLiquidityUsdt imposible');
    expect(why(v3({ sellLiquidityUsdt: Number.POSITIVE_INFINITY }))).toContain(
      'sellLiquidityUsdt imposible'
    );
  });

  it('rechaza más anuncios reportando volumen que anuncios en el lado', () => {
    expect(why(v3({ activeBuyAds: 5, buyLiquidityAds: 9 }))).toContain('supera a activeBuyAds');
  });

  it('rechaza un precio ponderado imposible', () => {
    expect(why(v3({ weightedBuyPrice: 0 }))).toContain('weightedBuyPrice imposible');
  });

  it('acepta un spreadAbsolute negativo', () => {
    expect(ok(v3({ spreadAbsolute: -2 }))).toBe(true);
    expect(why(v3({ spreadAbsolute: Number.NaN }))).toContain('spreadAbsolute no finito');
  });
});

describe('acumula TODOS los motivos, no sólo el primero', () => {
  it('un registro con tres defectos los nombra los tres', () => {
    const bad = record({ buyPrice: -1, sellPrice: Number.NaN, timestamp: Number.NaN });
    const { reasons } = validateHistoryRecord(bad, NOW);
    expect(reasons).toHaveLength(3);
  });

  it('no lanza con basura en lugar de un registro', () => {
    expect(validateHistoryRecord(null as never, NOW).ok).toBe(false);
    expect(validateHistoryRecord(undefined as never, NOW).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */

const ad = (o: Partial<NormalizedAd> = {}): NormalizedAd =>
  ({
    advNo: 'a1',
    price: 940,
    minAmountVes: 100,
    maxAmountVes: 10_000,
    availableUsdt: 50,
    availableUsdtReported: 50,
    merchantName: 'M',
    userType: 'user',
    ordersCount: 10,
    finishRate: 0.98,
    paymentMethods: [],
    ...o,
  }) as NormalizedAd;

const snapshot = (o: Partial<MarketSnapshot> = {}): MarketSnapshot =>
  ({
    timestamp: NOW,
    topBuyAds: [],
    topSellAds: [],
    weightedBuyPrice: null,
    weightedSellPrice: null,
    spreadAbsolute: null,
    status: 'LIVE',
    ...o,
  }) as MarketSnapshot;

describe('liquidez publicada', () => {
  it('suma sólo los anuncios que publicaron volumen, y dice cuántos fueron', () => {
    // Sin el recuento, una suma baja no distingue "poca liquidez" de "casi
    // nadie la publicó".
    const side = sumSideLiquidity([
      ad({ availableUsdtReported: 100 }),
      ad({ availableUsdtReported: null }),
      ad({ availableUsdtReported: 50 }),
    ]);
    expect(side.usdt).toBe(150);
    expect(side.ads).toBe(2);
  });

  it('ningún anuncio con volumen publicado NO es cero liquidez', () => {
    const side = sumSideLiquidity([ad({ availableUsdtReported: null })]);
    expect(side.usdt).toBeNull();
    expect(side.ads).toBe(0);
  });

  it('descarta volúmenes imposibles en lugar de corregirlos', () => {
    const side = sumSideLiquidity([
      ad({ availableUsdtReported: Number.NaN }),
      ad({ availableUsdtReported: -10 }),
      ad({ availableUsdtReported: 20 }),
    ]);
    expect(side.usdt).toBe(20);
    expect(side.ads).toBe(1);
  });
});

describe('el contexto de mercado', () => {
  it('marca v3 sólo cuando hay algo real detrás', () => {
    const built = buildMarketContext(
      snapshot({ topBuyAds: [ad({ availableUsdtReported: 100 })], weightedBuyPrice: 941 })
    );
    expect(built.enrichmentVersion).toBe('v3-context');
    expect(built.buyLiquidityUsdt).toBe(100);
    expect(built.weightedBuyPrice).toBe(941);
    expect(built.captureStatus).toBe('LIVE');
  });

  it('no inventa campos que la captura no produjo', () => {
    const built = buildMarketContext(
      snapshot({ topBuyAds: [ad({ availableUsdtReported: null })], status: undefined as never })
    );
    expect(built).toEqual({});
    expect(built.enrichmentVersion).toBeUndefined();
  });

  it('descarta precios ponderados imposibles', () => {
    const built = buildMarketContext(
      snapshot({ weightedBuyPrice: 0, weightedSellPrice: Number.NaN, spreadAbsolute: -3 })
    );
    expect(built.weightedBuyPrice).toBeUndefined();
    expect(built.weightedSellPrice).toBeUndefined();
    // El spread negativo SÍ pasa: es una pérdida real.
    expect(built.spreadAbsolute).toBe(-3);
  });

  it('lo que produce siempre pasa la validación', () => {
    const built = buildMarketContext(
      snapshot({
        topBuyAds: [ad({ availableUsdtReported: 100 }), ad({ availableUsdtReported: 20 })],
        topSellAds: [ad({ availableUsdtReported: 5 })],
        weightedBuyPrice: 941,
        spreadAbsolute: 5,
      })
    );
    expect(ok(record({ ...built, activeBuyAds: 2, activeSellAds: 1 }))).toBe(true);
  });
});
