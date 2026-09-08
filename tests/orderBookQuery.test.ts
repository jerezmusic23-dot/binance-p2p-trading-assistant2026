/**
 * ANUNCIOS REALES P2P — CONSULTA POR BANCO/MONTO, SIN MATRIZ.
 * =============================================================
 *
 * Después de retirar la Matriz Multifiltro, `OrderBookView.tsx` quedó sin
 * forma de pedir un banco o un monto específico: App.tsx sólo mantenía el
 * snapshot general y se lo pasaba tal cual. Este archivo fija el contrato de
 * la reparación - la etiqueta que ve el operador y la regla de
 * disponibilidad - con las funciones puras que el componente exporta, igual
 * que `dailyChartRows.test.ts` prueba `hourLabel`/`legOf` sin renderizar
 * nada. `tests/uiDataSources.test.ts` complementa esto con aserciones
 * estáticas sobre el propio archivo fuente.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isQueryUnavailable, queryLabel, BANK_OPTIONS, AMOUNT_OPTIONS } from '../src/OrderBookView';
import type { MarketSnapshot } from '../src/types';

const SRC = path.join(process.cwd(), 'src');
const code = (file: string) =>
  readFileSync(path.join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

function snapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    timestamp: Date.now(),
    isoDate: new Date().toISOString(),
    asset: 'USDT',
    fiat: 'VES',
    bestBuyPrice: 940,
    bestSellPrice: 945,
    averageBuyPrice: 940,
    averageSellPrice: 945,
    medianBuyPrice: 940,
    medianSellPrice: 945,
    weightedBuyPrice: 940,
    weightedSellPrice: 945,
    spreadAbsolute: 5,
    spreadPercentage: 0.53,
    strategicBuyPrice: 940,
    strategicSellPrice: 945,
    strategicSpreadPct: 0.53,
    strategicReason: null,
    topBuyAds: [],
    topSellAds: [],
    source: 'BINANCE_P2P',
    fetchDurationMs: 100,
    status: 'LIVE',
    lastError: null,
    bestBuy: { value: 940, provenance: 'REAL' },
    bestSell: { value: 945, provenance: 'REAL' },
    aggregatesProvenance: 'AGGREGATED',
    orderBookProvenance: 'REAL',
    strategicProvenance: 'STRATEGIC',
    ...overrides,
  } as MarketSnapshot;
}

describe('MERCADO GENERAL: sin banco ni monto', () => {
  it('la etiqueta es MERCADO GENERAL sin importar el snapshot', () => {
    expect(queryLabel(snapshot(), 'ALL', 'ALL')).toBe('MERCADO GENERAL');
    expect(queryLabel(null, 'ALL', 'ALL')).toBe('MERCADO GENERAL');
  });

  it('el mercado general nunca se marca como no disponible por sí mismo', () => {
    expect(isQueryUnavailable(false, null)).toBe(false);
    expect(isQueryUnavailable(false, snapshot({ filterFallbackReason: 'x' }))).toBe(false);
  });
});

describe('consulta por banco', () => {
  it('usa el banco que el servidor confirmó, no el pedido a ciegas', () => {
    const s = snapshot({ filterBank: 'MERCANTIL', filterBankName: 'Mercantil', filterAmount: null });
    expect(queryLabel(s, 'MERCANTIL', 'ALL')).toBe('MERCANTIL');
  });

  it('no está disponible cuando la respuesta confirma el filtro', () => {
    const s = snapshot({ filterBank: 'MERCANTIL', filterBankName: 'Mercantil', filterAmount: null });
    expect(isQueryUnavailable(true, s)).toBe(false);
  });
});

describe('consulta por monto', () => {
  it('usa transAmount cuando sólo se elige un monto, sin banco', () => {
    const s = snapshot({ filterBank: 'ALL', filterBankName: 'Todos los Bancos', filterAmount: 20000 });
    expect(queryLabel(s, 'ALL', '20K')).toBe('TODOS LOS BANCOS · 20K');
  });
});

describe('banco + monto juntos', () => {
  it('la etiqueta refleja ambos filtros confirmados a la vez', () => {
    const s = snapshot({ filterBank: 'MERCANTIL', filterBankName: 'Mercantil', filterAmount: 20000 });
    expect(queryLabel(s, 'MERCANTIL', '20K')).toBe('MERCANTIL · 20K');
    expect(isQueryUnavailable(true, s)).toBe(false);
  });
});

describe('banco sin anuncios verificables: NO DISPONIBLE, nunca el mercado general', () => {
  it('un snapshot ausente (la consulta ni siquiera llegó) es no disponible', () => {
    expect(isQueryUnavailable(true, null)).toBe(true);
    expect(queryLabel(null, 'BANCAMIGA', '20K')).toContain('no disponible');
  });

  it('un snapshot con filterFallbackReason (el servidor sustituyó por el general) es no disponible', () => {
    // Este es exactamente el caso que centralStore.getFilteredSnapshot produce
    // cuando la consulta filtrada falla: devuelve el snapshot GENERAL con la
    // razón puesta. La regla es no mostrarlo bajo el nombre del banco pedido.
    const s = snapshot({
      filterFallbackReason: 'La consulta filtrada (banco: BANCAMIGA) fallo.',
      bestBuyPrice: 940, // números del mercado general - nunca deben leerse como de Bancamiga
    });
    expect(isQueryUnavailable(true, s)).toBe(true);
    expect(queryLabel(s, 'BANCAMIGA', '20K')).toContain('no disponible');
    expect(queryLabel(s, 'BANCAMIGA', '20K')).not.toBe('MERCADO GENERAL');
  });
});

describe('reset: vuelve a MERCADO GENERAL sin reintroducir la matriz', () => {
  it('tras un reset (bank=ALL, amount=ALL) la consulta vuelve a ser general', () => {
    expect(isQueryUnavailable(false, snapshot())).toBe(false);
    expect(queryLabel(snapshot(), 'ALL', 'ALL')).toBe('MERCADO GENERAL');
  });
});

describe('catálogo de bancos y montos', () => {
  it('incluye General y los siete bancos configurados, cada uno una sola vez', () => {
    const keys = BANK_OPTIONS.map((b) => b.key);
    expect(keys).toEqual(['ALL', 'BANESCO', 'PROVINCIAL', 'MERCANTIL', 'VENEZUELA', 'BNC', 'BANCAMIGA', 'PAGO_MOVIL']);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('los montos son las seis franjas configuradas, cada una una sola vez', () => {
    const keys = AMOUNT_OPTIONS.map((a) => a.key);
    expect(keys).toEqual(['ALL', '10K', '20K', '30K', '40K', '50K', '100K']);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('cableado: no vuelve a ser una matriz', () => {
  it('no reintroduce BankMatrix ni GlobalFilterBar', () => {
    const src = code('OrderBookView.tsx');
    expect(src).not.toMatch(/BankMatrix|GlobalFilterBar/);
    // Una consulta, un banco y un monto a la vez - nunca una grilla banco×monto.
    expect(src).not.toMatch(/bankOrder\.map[\s\S]{0,80}amountKeys\.map/);
  });

  it('pide al mismo endpoint que ya soporta bank/amount, con y sin refresco forzado', () => {
    const src = code('OrderBookView.tsx');
    expect(src).toMatch(/ApiService\.getLatestMarket\(queryBank, amountVal/);
    expect(src).toMatch(/ApiService\.refreshMarket\(queryBank, amountVal/);
  });

  it('nunca renderiza los datos de la consulta cuando no está disponible', () => {
    const src = code('OrderBookView.tsx');
    // Los bloques que muestran precios/anuncios están condicionados a
    // !isUnavailable; el bloque de disponibilidad nunca lee snapshot.bestBuyPrice.
    expect(src).toMatch(/!isUnavailable && snapshot/);
    expect(src).toMatch(/id="orderbook-no-disponible"/);
  });
});

describe('la fuente correcta: payTypes/transAmount reales para la consulta específica', () => {
  it('fetchFullMarketSnapshot construye payTypes desde el banco y transAmount desde el monto', () => {
    const src = readFileSync(path.join(process.cwd(), 'server', 'binanceP2PService.ts'), 'utf8');
    expect(src).toMatch(/if \(filterBank && BANK_CODE_MAP\[filterBank\]\) payTypes = BANK_CODE_MAP\[filterBank\]\.apiPayTypes;/);
    expect(src).toMatch(/transAmount: filterAmount \|\| null/);
  });

  it('el mercado general usa payTypes: [] y transAmount: null, y excluye Recarga Pines', () => {
    const src = readFileSync(path.join(process.cwd(), 'server', 'binanceP2PService.ts'), 'utf8');
    expect(src).toMatch(/const isGeneralReference = !filterBank && filterAmount == null;/);
    expect(src).toMatch(/filterGeneralReferenceAds/);
  });
});
