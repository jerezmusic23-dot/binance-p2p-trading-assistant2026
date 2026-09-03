/**
 * QUÉ VE LA MATRIZ CUANDO EL FILTRO GLOBAL YA ELIGIÓ ALGO
 * =========================================================
 *
 * Antes, `activeGlobalFilter` llegaba hasta BankMatrix y sólo se usaba en una
 * frase de pie de página: la tabla seguía dibujando todos los bancos y todos
 * los montos aunque el operador ya hubiera elegido uno concreto. Esta función
 * es la parte que decide QUÉ FILAS Y COLUMNAS quedan visibles, separada del
 * componente precisamente para poder probarla sin renderizar nada - igual que
 * `dailyChartRows.ts` hace con la gráfica de proyección.
 *
 * No decide NINGÚN dato de la celda: eso sigue viniendo tal cual del
 * servidor. Sólo decide qué parte de la matriz ya construida se muestra.
 */

import type { AmountFilterKey, BankFilterKey, ExecutableCell, ExecutableMatrix, GlobalFilterState } from './types';

export interface MatrixView {
  visibleBanks: string[];
  visibleAmounts: string[];
  /** true cuando el banco elegido no tiene ninguna columna en la matriz. */
  bankUnavailable: boolean;
  /** La única celda, cuando banco Y monto quedaron reducidos a uno solo. */
  singleCell: ExecutableCell | null;
}

export function filterMatrixView(
  matrix: ExecutableMatrix,
  filter: Pick<GlobalFilterState, 'bank' | 'amount'> | undefined
): MatrixView {
  const filterBank: BankFilterKey = filter?.bank ?? 'ALL';
  const filterAmount: AmountFilterKey = filter?.amount ?? 'ALL';

  const visibleBanks =
    filterBank === 'ALL' ? matrix.bankOrder : matrix.bankOrder.filter((b) => b === filterBank);
  const visibleAmounts =
    filterAmount === 'ALL' ? matrix.amountKeys : matrix.amountKeys.filter((a) => a === filterAmount);

  const bankUnavailable = filterBank !== 'ALL' && visibleBanks.length === 0;
  const singleCell =
    visibleBanks.length === 1 && visibleAmounts.length === 1
      ? matrix.cells[visibleBanks[0]]?.[visibleAmounts[0]] ?? null
      : null;

  return { visibleBanks, visibleAmounts, bankUnavailable, singleCell };
}
