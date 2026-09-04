/**
 * PRUEBA FUNCIONAL DE MATRIZ MULTI FILTRO — Test 1 a 8, literales
 * =================================================================
 *
 * Ocho escenarios pedidos explícitamente, verificados de punta a punta:
 * celdas construidas por el motor real (buildCell/evaluateBankTiers, igual
 * que executableMatrix.test.ts) y luego reducidas por filterMatrixView -
 * exactamente lo que BankMatrix.tsx hace para decidir qué banco/monto se ve.
 *
 * Complementa (no repite) bankMatrixFilter.test.ts, que ya cubre la
 * reducción con fixtures a mano; aquí las celdas nacen del motor real para
 * que "Test 6/7/8" prueben la semántica de margen sobre datos que pasaron
 * por evaluateBankTiers de verdad, no por un objeto escrito en el test.
 */

import { describe, expect, it } from 'vitest';
import { buildCell } from '../server/executableMatrix.js';
import { evaluateBankTiers } from '../server/executability.js';
import { filterMatrixView } from '../src/bankMatrixFilter.js';
import type { NormalizedAd } from '../server/types.js';
import type { ExecutableCell, ExecutableMatrix } from '../src/types.js';

const NOW = Date.UTC(2026, 0, 6, 12, 0, 0);
const BANKS = ['BANESCO', 'PROVINCIAL', 'MERCANTIL', 'VENEZUELA', 'BNC', 'BANCAMIGA', 'PAGO_MOVIL'];
const AMOUNTS = ['10K', '20K', '30K', '40K', '50K', '100K'];

function ad(overrides: Partial<NormalizedAd> & { price: number }): NormalizedAd {
  return {
    advNo: `adv-${overrides.price}`,
    minAmountVes: 1_000,
    maxAmountVes: 200_000,
    availableUsdtReported: 500,
    merchantName: 'M',
    ordersCount: 100,
    finishRate: 0.98,
    userType: 'merchant',
    paymentOptions: [{ payType: 'BNCBancoNacional', tradeMethodName: 'BNC' }],
    ...overrides,
  } as NormalizedAd;
}

function cellFor(
  bank: string,
  amountKey: string,
  buyAds: NormalizedAd[],
  sellAds: NormalizedAd[]
): ExecutableCell {
  const tiers = evaluateBankTiers({ bank, allowedCodes: ['BNCBancoNacional'], buyAds, sellAds });
  return buildCell({
    cell: tiers[amountKey],
    bankDisplayName: bank,
    amountKey,
    capturedAt: NOW,
    nowMs: NOW,
    buyAdsEvaluated: buyAds.length,
    sellAdsEvaluated: sellAds.length,
  }) as unknown as ExecutableCell;
}

function fullMatrix(bnc100kBuy: NormalizedAd[], bnc100kSell: NormalizedAd[]): ExecutableMatrix {
  const cells: Record<string, Record<string, ExecutableCell>> = {};
  for (const bank of BANKS) {
    cells[bank] = {};
    for (const amt of AMOUNTS) {
      cells[bank][amt] =
        bank === 'BNC' && amt === '100K'
          ? cellFor(bank, amt, bnc100kBuy, bnc100kSell)
          : cellFor(bank, amt, [], []); // sin anuncios: NO_AD en todas las demás celdas.
    }
  }
  return {
    capturedAt: NOW, ageSeconds: 3, stale: false, staleAfterSeconds: 315,
    bankOrder: BANKS,
    bankDisplayNames: Object.fromEntries(BANKS.map((b) => [b, b])),
    amountKeys: AMOUNTS, cells,
  };
}

describe('Test 1 — sin filtro: 7 bancos × N montos, matriz completa', () => {
  it('todas las filas y columnas quedan visibles', () => {
    const matrix = fullMatrix([ad({ price: 944 })], [ad({ price: 960 })]);
    const view = filterMatrixView(matrix, { bank: 'ALL', amount: 'ALL' });
    expect(view.visibleBanks).toHaveLength(7);
    expect(view.visibleAmounts).toHaveLength(6);
    expect(view.singleCell).toBeNull();
  });
});

describe('Test 2 — banco BNC: sólo BNC', () => {
  it('reduce a una única fila', () => {
    const matrix = fullMatrix([ad({ price: 944 })], [ad({ price: 960 })]);
    const view = filterMatrixView(matrix, { bank: 'BNC', amount: 'ALL' });
    expect(view.visibleBanks).toEqual(['BNC']);
    expect(view.visibleAmounts).toHaveLength(6);
  });
});

describe('Test 3 — monto 100K: sólo 100K', () => {
  it('reduce a una única columna', () => {
    const matrix = fullMatrix([ad({ price: 944 })], [ad({ price: 960 })]);
    const view = filterMatrixView(matrix, { bank: 'ALL', amount: '100K' });
    expect(view.visibleAmounts).toEqual(['100K']);
    expect(view.visibleBanks).toHaveLength(7);
  });
});

describe('Test 4 — BNC + 100K: exactamente una celda visible', () => {
  it('una fila, una columna, una celda', () => {
    const matrix = fullMatrix([ad({ price: 944 })], [ad({ price: 960 })]);
    const view = filterMatrixView(matrix, { bank: 'BNC', amount: '100K' });
    expect(view.visibleBanks).toEqual(['BNC']);
    expect(view.visibleAmounts).toEqual(['100K']);
    expect(view.singleCell).not.toBeNull();
    expect(view.singleCell!.bank).toBe('BNC');
    expect(view.singleCell!.amountKey).toBe('100K');
  });
});

describe('Test 5 — filtro inexistente: estado vacío claro', () => {
  it('un banco que la matriz nunca capturó se marca como no disponible, no como vacío silencioso', () => {
    const matrix = fullMatrix([ad({ price: 944 })], [ad({ price: 960 })]);
    const view = filterMatrixView(matrix, { bank: 'INEXISTENTE' as any, amount: 'ALL' });
    expect(view.visibleBanks).toEqual([]);
    expect(view.bankUnavailable).toBe(true);
  });
});

describe('Test 6 — celda ejecutable: entrada, salida, margen y anuncios', () => {
  it('BNC × 100K con anuncios compatibles y margen positivo es EXECUTABLE con todos los datos', () => {
    const matrix = fullMatrix([ad({ price: 944.5 })], [ad({ price: 960.2 })]);
    const cell = matrix.cells.BNC['100K'];

    expect(cell.status).toBe('EXECUTABLE');
    expect(cell.opportunity).not.toBeNull();
    const op = cell.opportunity!;
    // Entrada = Binance BUY (yo compro), salida = Binance SELL (yo vendo).
    expect(op.arbitrageBuyPrice).toBe(944.5);
    expect(op.arbitrageSellPrice).toBe(960.2);
    expect(op.buyAdvNo).toBeTruthy();
    expect(op.sellAdvNo).toBeTruthy();
    expect(op.marginVes).toBeGreaterThan(0);
    expect(op.marginPct).toBeCloseTo(((960.2 - 944.5) / 944.5) * 100, 6);
    expect(op.availableUsdt).not.toBeNull();
    expect(cell.bank).toBe('BNC');
    expect(cell.amountKey).toBe('100K');
  });
});

describe('Test 7 — celda negativa: nunca ejecutable', () => {
  it('BUY por encima de SELL (margen negativo) es NO_OPPORTUNITY, no EXECUTABLE', () => {
    const matrix = fullMatrix([ad({ price: 965 })], [ad({ price: 950 })]);
    const cell = matrix.cells.BNC['100K'];

    expect(cell.status).not.toBe('EXECUTABLE');
    expect(cell.status).toBe('NO_OPPORTUNITY');
    expect(cell.spreadPct).toBeLessThan(0);
    /*
     * `opportunity` sigue construido - es el mismo par diagnosticado el que
     * explica POR QUÉ no es ejecutable (margen negativo real, nunca oculto)
     * - pero jamás con un margen positivo, y el status es lo único que la
     * pantalla usa para decidir si muestra "¿Puedo operar? Sí".
     */
    expect(cell.opportunity).not.toBeNull();
    expect(cell.opportunity!.marginPct).toBeLessThan(0);

    const view = filterMatrixView(matrix, { bank: 'BNC', amount: '100K' });
    expect(view.singleCell!.status).not.toBe('EXECUTABLE');
  });
});

describe('Test 8 — SELL <= BUY: jamás EXECUTABLE, y nunca por Math.abs', () => {
  it('SELL == BUY (margen cero) tampoco es ejecutable', () => {
    const matrix = fullMatrix([ad({ price: 950 })], [ad({ price: 950 })]);
    const cell = matrix.cells.BNC['100K'];
    expect(cell.status).not.toBe('EXECUTABLE');
    expect(cell.spreadPct).toBe(0);
  });

  it('SELL < BUY (pérdida) nunca se disfraza de margen positivo vía Math.abs', () => {
    const matrix = fullMatrix([ad({ price: 970 })], [ad({ price: 940 })]);
    const cell = matrix.cells.BNC['100K'];

    expect(cell.status).not.toBe('EXECUTABLE');
    expect(cell.spreadPct).toBeLessThan(0);
    // La prueba directa de que no hay Math.abs: el valor NUNCA coincide con
    // su propio valor absoluto cuando es negativo.
    expect(cell.spreadPct).not.toBe(Math.abs(cell.spreadPct as number));
  });
});
