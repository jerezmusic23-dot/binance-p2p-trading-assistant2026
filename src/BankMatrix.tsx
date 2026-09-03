/**
 * TASAS EJECUTABLES - BANCO x MONTO
 *
 * Every number on this screen comes from `executableMatrix`: a cell built
 * server-side from ads verified as that bank's, accepting that amount, with
 * published volume covering the operation.
 *
 * This component performs NO economic calculation. It does not compute a
 * spread, does not pick a best price, does not compare banks. The backend
 * decided all of it; this renders the decision and names the absences.
 *
 * The previous version consumed `ratesByAmount`, whose cells came from ads
 * filtered only by min/max - no bank verification, no liquidity - and whose
 * "spread" column was the 0.01 VES undercut of the leader. Neither that
 * structure nor that endpoint exists any more.
 */

import React, { useState, useEffect } from 'react';
import {
  CellStatus,
  ExecutableCell,
  ExecutableMatrix,
  MarketReference,
  GlobalFilterState,
  BankFilterKey,
  AmountFilterKey,
} from './types';
import { ApiService } from './api';
import { filterMatrixView } from './bankMatrixFilter';
import {
  Building2,
  RefreshCw,
  Info,
  CheckCircle2,
  AlertTriangle,
  Clock,
  HelpCircle,
  XCircle,
  Droplet,
} from 'lucide-react';

interface BankMatrixProps {
  activeGlobalFilter?: GlobalFilterState;
  onSelectFilter?: (bank: BankFilterKey, amount: AmountFilterKey) => void;
  onNavigateTab?: (tab: 'overview' | 'projections' | 'orderbook') => void;
}

/**
 * How each status reads on screen.
 *
 * EXECUTABLE is the only one that gets a price-forward treatment. Every other
 * state is shown with its own label and colour - none is rendered as 0, as
 * "--" standing in for a price, or hidden. A blocked cell is information.
 */
const STATUS_STYLE: Record<
  CellStatus,
  { label: string; className: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  EXECUTABLE: {
    label: 'EJECUTABLE',
    className: 'text-[#02c076] border-[#02c076]/40 bg-[#02c076]/10',
    Icon: CheckCircle2,
  },
  NO_OPPORTUNITY: {
    label: 'SIN ARBITRAJE',
    className: 'text-[#848e9c] border-[#2b2f36] bg-[#181a20]',
    Icon: XCircle,
  },
  NO_LIQUIDITY: {
    label: 'SIN LIQUIDEZ',
    className: 'text-[#f0b90b] border-[#f0b90b]/40 bg-[#f0b90b]/10',
    Icon: Droplet,
  },
  INSUFFICIENT_LIQUIDITY: {
    label: 'LIQUIDEZ INSUF.',
    className: 'text-[#f0b90b] border-[#f0b90b]/40 bg-[#f0b90b]/10',
    Icon: Droplet,
  },
  NO_AD: {
    label: 'SIN ANUNCIO',
    className: 'text-[#5e6673] border-[#2b2f36] bg-[#181a20]',
    Icon: Info,
  },
  STALE: {
    label: 'DATO ANTIGUO',
    className: 'text-[#f0b90b] border-[#f0b90b]/40 bg-[#f0b90b]/10',
    Icon: Clock,
  },
  NOT_VERIFIABLE: {
    label: 'NO VERIFICABLE',
    className: 'text-[#848e9c] border-[#848e9c]/40 bg-[#181a20]',
    Icon: HelpCircle,
  },
  ERROR: {
    label: 'ERROR',
    className: 'text-[#f6465d] border-[#f6465d]/40 bg-[#f6465d]/10',
    Icon: AlertTriangle,
  },
};

const fmtPrice = (v: number | null) => (v === null ? null : v.toFixed(2));

/**
 * Signed, always, and to four decimals.
 *
 * Two decimals hid the market: real spreads here live in the third and fourth,
 * so a genuine +0.0042% opportunity rendered as "0.00%" beside a cell marked
 * EXECUTABLE. The same four decimals are what Telegram sends.
 */
const fmtSpread = (v: number | null) =>
  v === null ? 'no verificable' : `${v >= 0 ? '+' : ''}${v.toFixed(4)}%`;

const fmtUsdt = (v: number | null) =>
  v === null ? 'no verificable' : `${v.toFixed(2)} USDT`;

/**
 * LA RESPUESTA A UNA OPERACIÓN CONCRETA.
 *
 * Aparece cuando el Filtro Global ya eligió un banco Y un monto: la matriz
 * completa deja de ser la pregunta y la celda señalada pasa a serlo. Responde
 * exactamente lo que el operador necesita antes de publicar - ¿puedo operar?,
 * ¿a qué precio entro/salgo?, ¿cuánto gano?, ¿qué liquidez hay?, ¿qué anuncio
 * de Binance lo permite? - y si no puede operar, POR QUÉ, en una frase humana,
 * nunca en un guion o un cero disfrazado de precio.
 */
const OperationDetailCard: React.FC<{ cell: ExecutableCell }> = ({ cell }) => {
  const style = STATUS_STYLE[cell.status];
  const op = cell.opportunity;
  const executable = cell.status === 'EXECUTABLE' && op !== null;

  return (
    <div
      className={`rounded-lg border p-4 ${
        executable ? 'border-[#02c076]/50 bg-[#02c076]/5' : 'border-[#2b2f36] bg-[#181a20]'
      }`}
    >
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2.5">
        <div className="text-sm font-bold text-[#e0e0e0] flex items-center gap-2">
          <Building2 className="w-4 h-4 text-[#FCD535]" />
          {cell.bankDisplayName} · {cell.amountVes.toLocaleString('es-VE')} VES
        </div>
        <span
          className={`flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${style.className}`}
        >
          <style.Icon className="w-3 h-3" />
          {style.label}
        </span>
      </div>

      <div className="text-[12px] mb-2">
        ¿Puedo operar?{' '}
        {executable ? (
          <strong className="text-[#02c076]">Sí</strong>
        ) : (
          <strong className="text-[#f6465d]">No</strong>
        )}
      </div>

      {executable ? (
        <div className="grid gap-1.5 text-[12px] sm:grid-cols-2">
          <div>
            <span className="text-[#848e9c]">Precio de entrada (MI COMPRA)</span>
            <div className="font-mono text-[13px] text-[#e0e0e0]">
              {op.arbitrageBuyPrice.toFixed(2)} VES
              <span className="ml-1.5 text-[9px] text-[#5e6673]">anuncio {op.buyAdvNo}</span>
            </div>
          </div>
          <div>
            <span className="text-[#848e9c]">Precio de salida (MI VENTA)</span>
            <div className="font-mono text-[13px] text-[#e0e0e0]">
              {op.arbitrageSellPrice.toFixed(2)} VES
              <span className="ml-1.5 text-[9px] text-[#5e6673]">anuncio {op.sellAdvNo}</span>
            </div>
          </div>
          <div>
            <span className="text-[#848e9c]">Margen</span>
            <div className="font-mono text-[13px] text-[#02c076]">
              {op.marginVes.toFixed(2)} VES ({op.marginPct >= 0 ? '+' : ''}
              {op.marginPct.toFixed(2)}%)
            </div>
          </div>
          <div>
            <span className="text-[#848e9c]">Liquidez disponible</span>
            <div className="font-mono text-[13px] text-[#e0e0e0]">{fmtUsdt(op.availableUsdt)}</div>
          </div>
          <div className="sm:col-span-2 text-[9px] text-[#5e6673]">
            Margen bruto: no descuenta comisiones, transferencias, slippage ni tiempo de ejecución.
          </div>
        </div>
      ) : (
        <div className="text-[12px] text-[#848e9c] leading-relaxed">
          {cell.reason ?? 'Sin motivo adicional registrado.'}
        </div>
      )}
    </div>
  );
};

const CellView: React.FC<{ cell: ExecutableCell; onSelect?: () => void }> = ({
  cell,
  onSelect,
}) => {
  const style = STATUS_STYLE[cell.status];
  const buyPrice = fmtPrice(cell.buy?.price ?? null);
  const sellPrice = fmtPrice(cell.sell?.price ?? null);

  return (
    <button
      type="button"
      onClick={onSelect}
      title={cell.reason ?? `${cell.bankDisplayName} · ${cell.amountVes.toLocaleString('es-VE')} VES`}
      className={`w-full text-left rounded-md border px-2 py-1.5 transition-colors ${style.className}`}
    >
      <div className="flex items-center gap-1 mb-1">
        <style.Icon className="w-3 h-3 shrink-0" />
        <span className="text-[9px] font-bold uppercase tracking-wide truncate">
          {style.label}
        </span>
      </div>

      {/*
        Prices are printed ONLY when the leg is executable. A blocked leg says
        so in words - it never borrows a number from anywhere else.
      */}
      <div className="font-mono text-[11px] leading-tight">
        <div className="flex justify-between gap-1">
          {/*
            The Binance side is named on the label, not left to the reader.
            "Compra" alone is ambiguous: an ad you buy from is one the
            ADVERTISER is selling, so anyone reading in ad direction infers the
            opposite side and the whole spread flips sign.
          */}
          <span
            className="text-[#848e9c]"
            title="MI COMPRA: el precio al que YO compro USDT. Fuente: anuncio que VENDE USDT · Binance ASK · tradeType=BUY."
          >
            MI COMPRA <span className="text-[8px] text-[#5e6673]">ASK</span>
          </span>
          <span className={buyPrice ? 'text-[#e0e0e0]' : 'text-[#5e6673] italic'}>
            {buyPrice ?? '—'}
          </span>
        </div>
        <div className="flex justify-between gap-1">
          <span
            className="text-[#848e9c]"
            title="MI VENTA: el precio al que YO vendo USDT. Fuente: anuncio que COMPRA USDT · Binance BID · tradeType=SELL."
          >
            MI VENTA <span className="text-[8px] text-[#5e6673]">BID</span>
          </span>
          <span className={sellPrice ? 'text-[#e0e0e0]' : 'text-[#5e6673] italic'}>
            {sellPrice ?? '—'}
          </span>
        </div>
        <div className="flex justify-between gap-1 mt-0.5 pt-0.5 border-t border-current/10">
          <span className="text-[#848e9c]">Spread</span>
          <span
            className={
              cell.spreadPct === null
                ? 'text-[#5e6673] italic'
                : cell.spreadPct > 0
                ? 'text-[#02c076]'
                : 'text-[#f6465d]'
            }
          >
            {cell.spreadPct === null ? '—' : fmtSpread(cell.spreadPct)}
          </span>
        </div>
        <div className="flex justify-between gap-1">
          <span className="text-[#848e9c]">Liquidez</span>
          <span className={cell.availableUsdt === null ? 'text-[#5e6673] italic' : 'text-[#e0e0e0]'}>
            {cell.availableUsdt === null ? 'n/v' : cell.availableUsdt.toFixed(0)}
          </span>
        </div>
      </div>
    </button>
  );
};

export const BankMatrix: React.FC<BankMatrixProps> = ({
  activeGlobalFilter,
  onSelectFilter,
}) => {
  const [matrix, setMatrix] = useState<ExecutableMatrix | null>(null);
  const [reference, setReference] = useState<MarketReference | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMatrix = async (force = false) => {
    try {
      if (force) setIsRefreshing(true);
      else setIsLoading(true);

      const res = await ApiService.getExecutableMatrix(force);
      setMatrix(res.executableMatrix);
      setReference(res.marketReference);
      setError(null);
    } catch (err: any) {
      console.error('Failed to load executable matrix:', err);
      setError(err.message || 'Error al obtener la matriz ejecutable');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    fetchMatrix(false);
  }, []);

  if (isLoading) {
    return (
      <div className="p-6 text-center text-[#848e9c] text-sm">
        Cargando tasas ejecutables…
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="p-6 text-center text-[#f6465d] text-sm border border-[#f6465d]/30 rounded-lg">
        {error}
      </div>
    );
  }

  if (matrix === null) {
    return (
      <div className="p-6 text-center text-[#848e9c] text-sm">
        No hay matriz ejecutable disponible.
      </div>
    );
  }

  const executableCount = Object.values(matrix.cells)
    .flatMap((row) => Object.values(row))
    .filter((c) => c.status === 'EXECUTABLE').length;

  /*
   * EL FILTRO GLOBAL DEBE FILTRAR LA MATRIZ, NO SÓLO ANOTARLA.
   *
   * `activeGlobalFilter` viajaba hasta aquí y sólo se usaba en la frase del
   * pie de página: la tabla seguía dibujando todos los bancos y todos los
   * montos aunque el operador ya hubiera elegido uno. `filterMatrixView`
   * reduce de verdad las filas y columnas visibles - nunca los datos de la
   * celda, que siguen viniendo tal cual del servidor - y vive fuera de este
   * componente precisamente para poder probarse sin renderizar nada.
   */
  const { visibleBanks, visibleAmounts, bankUnavailable, singleCell } = filterMatrixView(
    matrix,
    activeGlobalFilter
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-[#e0e0e0] uppercase tracking-wide flex items-center gap-2">
            <Building2 className="w-4 h-4 text-[#FCD535]" />
            Mis operaciones por banco y monto
          </h2>
          <p className="text-[10px] text-[#848e9c] mt-0.5">
            Cada celda proviene de anuncios verificados de ese banco que aceptan ese monto y
            publican liquidez suficiente. No es un precio global.
          </p>
        </div>

        <div className="flex items-center gap-3 text-[10px] text-[#848e9c]">
          <span>
            Capturado hace <strong className="font-mono">{matrix.ageSeconds}s</strong>
            {matrix.stale && (
              <span className="text-[#f0b90b] font-semibold"> · DATO ANTIGUO</span>
            )}
          </span>
          <span>
            <strong className="font-mono text-[#02c076]">{executableCount}</strong> ejecutables
          </span>
          <button
            type="button"
            onClick={() => fetchMatrix(true)}
            disabled={isRefreshing}
            className="flex items-center gap-1 px-2 py-1 rounded border border-[#2b2f36] hover:border-[#FCD535] transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refrescar
          </button>
        </div>
      </div>

      {/*
        The global reference is shown here ONLY as context, labelled as such and
        visually demoted. It is never a column of the matrix.
      */}
      {reference !== null && (
        <div className="text-[10px] text-[#5e6673] border border-dashed border-[#2b2f36] rounded px-2 py-1">
          Referencia de mercado (no ejecutable):{' '}
          <span className="font-mono">
            recompra {reference.referenceBuyPrice?.toFixed(2) ?? 'n/v'} · venta{' '}
            {reference.referenceSellPrice?.toFixed(2) ?? 'n/v'}
          </span>
          . {reference.note}
        </div>
      )}

      {/*
        Con banco Y monto ya elegidos, la pregunta deja de ser "¿qué banco me
        conviene?" y pasa a ser "¿puedo hacer ESTA operación?". La tarjeta
        contesta eso directamente; la tabla de abajo, reducida a esa misma
        celda, sigue disponible para que la respuesta nunca dependa de un
        cálculo que el operador no puede ver.
      */}
      {singleCell !== null && (
        <OperationDetailCard cell={singleCell} />
      )}

      {!bankUnavailable && visibleBanks.length === 1 && visibleAmounts.length === 1 && singleCell === null && (
        <div className="text-[11px] text-[#848e9c] border border-[#2b2f36] rounded px-3 py-2">
          ¿Puedo operar? <strong className="text-[#f6465d]">No</strong>. Todavía no hay datos
          capturados de {matrix.bankDisplayNames[visibleBanks[0]] ?? visibleBanks[0]} para{' '}
          {visibleAmounts[0]}: la matriz recorre los bancos y montos por turnos y a éste todavía no
          le ha tocado.
        </div>
      )}

      {bankUnavailable && (
        <div className="text-[11px] text-[#f0b90b] border border-[#f0b90b]/30 rounded px-3 py-2">
          El banco «{activeGlobalFilter?.bankDisplayName}» no está disponible en esta matriz: no
          hay ninguna columna capturada para él.
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1">
          <thead>
            <tr>
              <th className="text-left text-[10px] uppercase text-[#848e9c] font-semibold px-2">
                Banco
              </th>
              {visibleAmounts.map((amt) => (
                <th
                  key={amt}
                  className="text-center text-[10px] uppercase text-[#848e9c] font-semibold min-w-[110px]"
                >
                  {amt}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleBanks.map((bank) => (
              <tr key={bank}>
                <td className="text-[11px] font-semibold text-[#e0e0e0] px-2 whitespace-nowrap">
                  {matrix.bankDisplayNames[bank] ?? bank}
                </td>
                {visibleAmounts.map((amt) => {
                  const cell = matrix.cells[bank]?.[amt];
                  if (cell === undefined) {
                    return (
                      <td key={amt} className="text-center text-[10px] text-[#5e6673]">
                        sin datos
                      </td>
                    );
                  }
                  return (
                    <td key={amt}>
                      <CellView
                        cell={cell}
                        onSelect={() =>
                          onSelectFilter?.(bank as BankFilterKey, amt as AmountFilterKey)
                        }
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-[#848e9c]">
        <strong>MI COMPRA</strong> = lo que <em>tú</em> pagas por cada USDT · anuncio que{' '}
        <strong>VENDE</strong> USDT · Binance ASK · <code>tradeType=BUY</code>.
        <br />
        <strong>MI VENTA</strong> = lo que <em>tú</em> recibes por cada USDT · anuncio que{' '}
        <strong>COMPRA</strong> USDT · Binance BID · <code>tradeType=SELL</code>.
        <br />
        SPREAD firmado: <strong>((venta − recompra) / recompra) × 100</strong>. Un valor negativo
        se muestra negativo y se clasifica SIN ARBITRAJE — nunca se convierte en oportunidad.
        MARGEN BRUTO: no descuenta comisiones, transferencias, slippage ni tiempo de ejecución.
      </p>

      {activeGlobalFilter !== undefined && activeGlobalFilter.bank !== 'ALL' && (
        <p className="text-[10px] text-[#5e6673]">
          Filtro activo: {activeGlobalFilter.bank} · {activeGlobalFilter.amount}
        </p>
      )}
    </div>
  );
};
