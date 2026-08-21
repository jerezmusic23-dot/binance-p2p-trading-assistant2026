import React, { useState, useEffect } from 'react';
import { BankMatrixRow, TradeType, GlobalFilterState, BankFilterKey, AmountFilterKey } from './types';
import { ApiService } from './api';
import {
  Building2,
  Trophy,
  RefreshCw,
  Info,
  CheckCircle2,
  SlidersHorizontal,
  ArrowRight,
  Sparkles,
} from 'lucide-react';

interface BankMatrixProps {
  initialTradeType?: TradeType;
  activeGlobalFilter?: GlobalFilterState;
  onSelectFilter?: (bank: BankFilterKey, amount: AmountFilterKey) => void;
  onNavigateTab?: (tab: 'overview' | 'projections' | 'orderbook') => void;
}

export const BankMatrix: React.FC<BankMatrixProps> = ({
  initialTradeType = 'SELL',
  activeGlobalFilter,
  onSelectFilter,
  onNavigateTab,
}) => {
  const [tradeType, setTradeType] = useState<TradeType>(initialTradeType);
  const [matrixRows, setMatrixRows] = useState<BankMatrixRow[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now());
  const [error, setError] = useState<string | null>(null);

  const amountTiers: AmountFilterKey[] = ['50K', '40K', '30K', '20K', '10K', '100K'];

  const fetchMatrix = async (type: TradeType, force = false) => {
    try {
      if (force) setIsRefreshing(true);
      else setIsLoading(true);

      const res = await ApiService.getBankMatrix(type, force);
      setMatrixRows(res.rows || []);
      setLastUpdated(res.timestamp || Date.now());
      setError(null);
    } catch (err: any) {
      console.error('Failed to load bank matrix:', err);
      setError(err.message || 'Error al obtener la matriz de bancos');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    fetchMatrix(tradeType, false);
  }, [tradeType]);

  // Find the top spread or best deal row across the matrix to place the trophy
  let bestRowKey = '';
  let bestSpread = -1;

  matrixRows.forEach((row) => {
    amountTiers.forEach((amt) => {
      const cell = row.ratesByAmount?.[amt];
      if (cell && cell.spreadPct !== null && cell.spreadPct > bestSpread) {
        bestSpread = cell.spreadPct;
        bestRowKey = `${row.bankKey}-${amt}`;
      }
    });
  });

  const handleCellClick = (bankKey: string, amt: AmountFilterKey) => {
    if (onSelectFilter) {
      onSelectFilter(bankKey as BankFilterKey, amt);
    }
  };

  return (
    <div id="bank-matrix-container" className="space-y-4">
      {/* Top Banner & Global Connection Indicator */}
      <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-[#2b2f36] pb-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xs uppercase text-[#848e9c] font-bold tracking-wider flex items-center gap-2">
                <Building2 className="w-4 h-4 text-[#FCD535]" />
                MATRIZ MULTIFILTRO POR BANCO Y MONTO
              </h2>
              <span className="text-[10px] bg-[#02c076]/20 text-[#02c076] px-2 py-0.5 rounded font-mono font-bold">
                Conexión Global Activa
              </span>
            </div>
            <p className="text-[11px] text-[#848e9c] mt-1">
              Haz clic en cualquier celda o banco para <strong>conectar y filtrar toda la interfaz</strong> (precios, gráfico 8AM-8PM, proyección y libro de órdenes) a esa tasa específica.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => fetchMatrix(tradeType, true)}
              disabled={isRefreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#1e2329] hover:bg-[#2b2f36] text-[#e0e0e0] border border-[#474d57] text-xs font-medium cursor-pointer transition disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-[#FCD535]' : 'text-[#FCD535]'}`} />
              <span>Actualizar Matriz</span>
            </button>
          </div>
        </div>

        {/* Tab Selector: Venta Multifiltro / Recompra Multifiltro */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4">
          <div className="grid grid-cols-2 gap-3 max-w-md w-full">
            <button
              onClick={() => setTradeType('SELL')}
              className={`py-2 px-3 rounded text-xs font-bold transition flex items-center justify-center gap-2 cursor-pointer font-mono tracking-wide ${
                tradeType === 'SELL'
                  ? 'bg-[#1e2329] border border-[#FCD535] text-[#FCD535] shadow-sm'
                  : 'bg-[#111417] text-[#848e9c] hover:text-[#e0e0e0] border border-[#2b2f36]'
              }`}
            >
              <span>Venta (Tú recibes VES)</span>
            </button>

            <button
              onClick={() => setTradeType('BUY')}
              className={`py-2 px-3 rounded text-xs font-bold transition flex items-center justify-center gap-2 cursor-pointer font-mono tracking-wide ${
                tradeType === 'BUY'
                  ? 'bg-[#1e2329] border border-[#02c076] text-[#02c076] shadow-sm'
                  : 'bg-[#111417] text-[#848e9c] hover:text-[#e0e0e0] border border-[#2b2f36]'
              }`}
            >
              <span>Recompra (Tú pagas VES)</span>
            </button>
          </div>

          {activeGlobalFilter && (activeGlobalFilter.bank !== 'ALL' || activeGlobalFilter.amount !== 'ALL') && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded bg-[#FCD535]/10 border border-[#FCD535]/40 text-xs font-mono">
              <span className="text-[#848e9c]">Filtro aplicado en dashboard:</span>
              <span className="text-[#FCD535] font-bold">
                {activeGlobalFilter.bankDisplayName} · {activeGlobalFilter.amount}
              </span>
              {onNavigateTab && (
                <button
                  onClick={() => onNavigateTab('overview')}
                  className="ml-2 flex items-center gap-1 text-[11px] font-bold text-[#e0e0e0] hover:text-[#FCD535] cursor-pointer"
                >
                  <span>Ver Resumen</span>
                  <ArrowRight className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Loading State */}
      {isLoading && matrixRows.length === 0 && (
        <div className="p-12 text-center bg-[#181a20] rounded-lg border border-[#2b2f36]">
          <div className="w-8 h-8 border-3 border-[#FCD535] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-[#e0e0e0] text-sm font-medium">Consultando profundidad bancaria en Binance P2P...</p>
          <p className="text-[#848e9c] text-xs mt-1">Obteniendo tasas de Banesco, Mercantil, Provincial, BNC, Bancamiga, Venezuela y Pago Móvil</p>
        </div>
      )}

      {/* Matrix Tables Grouped by Bank */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {matrixRows.map((bankRow) => {
          const isBankActive = activeGlobalFilter?.bank === bankRow.bankKey;

          return (
            <div
              key={bankRow.bankKey}
              id={`matrix-bank-${bankRow.bankKey.toLowerCase()}`}
              className={`bg-[#181a20] border rounded-lg overflow-hidden flex flex-col justify-between transition ${
                isBankActive ? 'border-[#FCD535] shadow-md ring-1 ring-[#FCD535]/30' : 'border-[#2b2f36]'
              }`}
            >
              <div>
                {/* Bank Table Header */}
                <div className="bg-[#111417] border-b border-[#2b2f36] px-4 py-2.5 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Building2 className={`w-4 h-4 ${isBankActive ? 'text-[#FCD535]' : 'text-[#848e9c]'}`} />
                    <h3 className="font-bold text-[#e0e0e0] text-xs uppercase tracking-wider">{bankRow.bankDisplayName}</h3>
                    {isBankActive && (
                      <span className="text-[10px] bg-[#FCD535] text-black px-1.5 py-0.2 rounded font-mono font-bold">
                        CONECTADO
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleCellClick(bankRow.bankKey, 'ALL')}
                      className="text-[10px] text-[#FCD535] hover:underline font-mono uppercase cursor-pointer"
                      title="Aplicar este banco a todo el dashboard"
                    >
                      Filtrar Banco
                    </button>
                  </div>
                </div>

                {/* Data Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="bg-[#111417]/80 text-[#848e9c] text-[10px] uppercase font-bold border-b border-[#2b2f36]">
                        <th className="py-2.5 px-3 font-semibold">Filtro</th>
                        <th className="py-2.5 px-3 font-semibold">Precio Líder</th>
                        <th className="py-2.5 px-3 font-semibold">Sugerido</th>
                        <th className="py-2.5 px-3 font-semibold">Spread %</th>
                        <th className="py-2.5 px-3 font-semibold text-right">Acción</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#2b2f36]">
                      {amountTiers.map((amt) => {
                        const cell = bankRow.ratesByAmount[amt];
                        const isTrophy = `${bankRow.bankKey}-${amt}` === bestRowKey;
                        const isCellSelected =
                          activeGlobalFilter?.bank === bankRow.bankKey && activeGlobalFilter?.amount === amt;

                        if (!cell || cell.leaderPrice === null) {
                          return (
                            <tr key={amt} className="hover:bg-[#2b2f36]/30 transition">
                              <td className="py-2.5 px-3 font-bold font-mono text-[#848e9c]">{amt}</td>
                              <td colSpan={4} className="py-2.5 px-3 text-[#848e9c] italic text-[11px]">
                                SIN DATOS EN LIBRO BINANCE
                              </td>
                            </tr>
                          );
                        }

                        return (
                          <tr
                            key={amt}
                            onClick={() => handleCellClick(bankRow.bankKey, amt)}
                            className={`transition font-mono cursor-pointer ${
                              isCellSelected
                                ? 'bg-[#FCD535]/20 border-l-3 border-[#FCD535] text-[#FCD535] font-bold'
                                : isTrophy
                                ? 'bg-[#FCD535]/10 text-[#FCD535] hover:bg-[#FCD535]/15'
                                : 'hover:bg-[#2b2f36]/50 text-[#e0e0e0]'
                            }`}
                            title="Haz clic para conectar este precio a toda la interfaz"
                          >
                            <td className="py-2.5 px-3 font-bold flex items-center gap-1.5">
                              {isTrophy && <Trophy className="w-3.5 h-3.5 text-[#FCD535]" />}
                              {isCellSelected && <CheckCircle2 className="w-3.5 h-3.5 text-[#FCD535]" />}
                              <span>{amt}</span>
                            </td>
                            <td className="py-2.5 px-3 font-bold text-[#FCD535]">
                              {cell.leaderPrice !== null ? cell.leaderPrice.toFixed(2) : '--'}
                            </td>
                            <td className="py-2.5 px-3 text-[#02c076]">
                              {cell.suggestedPrice?.toFixed(2) || '--'}
                            </td>
                            <td className="py-2.5 px-3 font-semibold text-[#e0e0e0]">
                              {cell.spreadPct !== null ? `${cell.spreadPct.toFixed(2)}%` : '--'}
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCellClick(bankRow.bankKey, amt);
                                }}
                                className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase transition cursor-pointer ${
                                  isCellSelected
                                    ? 'bg-[#FCD535] text-black'
                                    : 'bg-[#1e2329] hover:bg-[#FCD535] text-[#848e9c] hover:text-black border border-[#2b2f36]'
                                }`}
                              >
                                {isCellSelected ? 'Conectado' : 'Conectar'}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="bg-[#111417] px-3 py-1.5 border-t border-[#2b2f36] text-[10px] text-[#848e9c] font-mono flex items-center justify-between">
                <span>Filtro P2P automático</span>
                <span>Binance Direct API</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Info Footnote */}
      <div className="p-4 rounded-lg bg-[#181a20] border border-[#2b2f36] text-xs text-[#848e9c] flex items-start gap-2.5">
        <Info className="w-4 h-4 text-[#FCD535] shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-[#e0e0e0]">¿Cómo interactúa la matriz con el resto de la aplicación?</p>
          <p className="mt-0.5">
            Al seleccionar un banco y rango de capital, la aplicación reconfigura inmediatamente el motor estadístico: el Resumen Principal, las Proyecciones Horarias (8:00 AM - 8:00 PM), los Pisos/Techos esperados y el Libro de Órdenes se calibran en tiempo real con la liquidez de ese banco en Binance P2P.
          </p>
        </div>
      </div>
    </div>
  );
};


