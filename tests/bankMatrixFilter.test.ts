/**
 * EL FILTRO GLOBAL DEBE FILTRAR LA MATRIZ MULTI FILTRO
 * =====================================================
 *
 * El defecto que esto prueba: `activeGlobalFilter` llegaba a BankMatrix y
 * sólo se usaba en una frase de pie de página - la tabla seguía mostrando
 * todos los bancos y todos los montos aunque el operador ya hubiera elegido
 * uno concreto. `filterMatrixView` es la parte pura de esa decisión, y estas
 * pruebas comprueban exactamente lo que el Filtro Global promete: elegir un
 * banco reduce las filas, elegir un monto reduce las columnas, y elegir los
 * dos identifica UNA sola celda - la que responde si se puede operar.
 */

import { describe, expect, it } from 'vitest';
import { filterMatrixView } from '../src/bankMatrixFilter';
import type { ExecutableCell, ExecutableMatrix } from '../src/types';

function cell(bank: string, amountKey: string, overrides: Partial<ExecutableCell> = {}): ExecutableCell {
  return {
    bank,
    bankDisplayName: bank,
    amountKey,
    amountVes: 20_000,
    status: 'NO_AD',
    reason: 'Ningún anuncio verificado.',
    buy: null,
    sell: null,
    spreadPct: null,
    availableUsdt: null,
    opportunity: null,
    buyStatus: 'NO_AD',
    sellStatus: 'NO_AD',
    buyReason: null,
    sellReason: null,
    buyRejections: {},
    sellRejections: {},
    capturedAt: Date.UTC(2026, 0, 6, 12, 0, 0),
    ageSeconds: 3,
    provenance: 'REAL',
    ...overrides,
  };
}

function matrix(banks: string[], amounts: string[]): ExecutableMatrix {
  const cells: Record<string, Record<string, ExecutableCell>> = {};
  for (const bank of banks) {
    cells[bank] = {};
    for (const amt of amounts) cells[bank][amt] = cell(bank, amt);
  }
  return {
    capturedAt: Date.UTC(2026, 0, 6, 12, 0, 0),
    ageSeconds: 3,
    stale: false,
    staleAfterSeconds: 315,
    bankOrder: banks,
    bankDisplayNames: Object.fromEntries(banks.map((b) => [b, b])),
    amountKeys: amounts,
    cells,
  };
}

const BANKS = ['BANESCO', 'PROVINCIAL', 'MERCANTIL'];
const AMOUNTS = ['10K', '20K', '30K'];

describe('sin filtro, se ve la matriz entera', () => {
  it('todos los bancos y todos los montos quedan visibles', () => {
    const view = filterMatrixView(matrix(BANKS, AMOUNTS), { bank: 'ALL', amount: 'ALL' });
    expect(view.visibleBanks).toEqual(BANKS);
    expect(view.visibleAmounts).toEqual(AMOUNTS);
    expect(view.bankUnavailable).toBe(false);
    expect(view.singleCell).toBeNull();
  });

  it('sin filtro (prop ausente) también se ve la matriz entera', () => {
    const view = filterMatrixView(matrix(BANKS, AMOUNTS), undefined);
    expect(view.visibleBanks).toEqual(BANKS);
    expect(view.visibleAmounts).toEqual(AMOUNTS);
  });
});

describe('elegir un banco reduce las filas, no las columnas', () => {
  it('sólo el banco elegido queda visible', () => {
    const view = filterMatrixView(matrix(BANKS, AMOUNTS), { bank: 'PROVINCIAL', amount: 'ALL' });
    expect(view.visibleBanks).toEqual(['PROVINCIAL']);
    expect(view.visibleAmounts).toEqual(AMOUNTS);
    expect(view.bankUnavailable).toBe(false);
  });
});

describe('elegir un monto reduce las columnas, no las filas', () => {
  it('sólo el monto elegido queda visible', () => {
    const view = filterMatrixView(matrix(BANKS, AMOUNTS), { bank: 'ALL', amount: '20K' });
    expect(view.visibleAmounts).toEqual(['20K']);
    expect(view.visibleBanks).toEqual(BANKS);
  });
});

describe('elegir banco Y monto identifica una única celda', () => {
  it('reduce a una fila y una columna, con la celda correcta', () => {
    const m = matrix(BANKS, AMOUNTS);
    m.cells.MERCANTIL['30K'] = cell('MERCANTIL', '30K', {
      status: 'EXECUTABLE',
      reason: null,
    });
    const view = filterMatrixView(m, { bank: 'MERCANTIL', amount: '30K' });

    expect(view.visibleBanks).toEqual(['MERCANTIL']);
    expect(view.visibleAmounts).toEqual(['30K']);
    expect(view.singleCell).not.toBeNull();
    expect(view.singleCell!.bank).toBe('MERCANTIL');
    expect(view.singleCell!.amountKey).toBe('30K');
    expect(view.singleCell!.status).toBe('EXECUTABLE');
  });

  it('una celda no ejecutable sigue siendo LA celda, con su motivo', () => {
    const m = matrix(BANKS, AMOUNTS);
    m.cells.BANESCO['10K'] = cell('BANESCO', '10K', {
      status: 'INSUFFICIENT_LIQUIDITY',
      reason: 'El volumen publicado no cubre 10.000 VES.',
    });
    const view = filterMatrixView(m, { bank: 'BANESCO', amount: '10K' });

    expect(view.singleCell!.status).toBe('INSUFFICIENT_LIQUIDITY');
    expect(view.singleCell!.reason).toMatch(/no cubre/);
  });
});

describe('un banco que no está en la matriz se marca como no disponible', () => {
  it('bankUnavailable es true y no hay filas', () => {
    const view = filterMatrixView(matrix(BANKS, AMOUNTS), { bank: 'BNC', amount: 'ALL' });
    expect(view.visibleBanks).toEqual([]);
    expect(view.bankUnavailable).toBe(true);
    expect(view.singleCell).toBeNull();
  });

  it('un monto que no existe en la matriz simplemente deja la columna vacía', () => {
    // amountKeys es un conjunto fijo servido por el backend; esto documenta
    // que no inventa una columna que el servidor no envió.
    const view = filterMatrixView(matrix(BANKS, AMOUNTS), { bank: 'ALL', amount: '100K' as any });
    expect(view.visibleAmounts).toEqual([]);
    expect(view.singleCell).toBeNull();
  });
});

describe('la celda que falta se distingue de la celda que no puede operar', () => {
  it('cuando el servidor todavía no capturó esa combinación, singleCell es null sin más', () => {
    // MERCANTIL x 30K nunca se rellenó en el fixture base.
    const view = filterMatrixView(matrix(BANKS, AMOUNTS.slice(0, 2)), {
      bank: 'MERCANTIL',
      amount: '30K' as any,
    });
    expect(view.visibleBanks).toEqual(['MERCANTIL']);
    expect(view.visibleAmounts).toEqual([]);
    expect(view.singleCell).toBeNull();
  });
});
