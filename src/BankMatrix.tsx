import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, Building2, CheckCircle2, Clock, Droplet, HelpCircle, Info, RefreshCw, XCircle } from 'lucide-react';
import type { AmountFilterKey, BankFilterKey, CellStatus, ExecutableCell, ExecutableMatrix, GlobalFilterState, MarketReference } from './types';
import { ApiService } from './api';
import { filterMatrixView } from './bankMatrixFilter';

interface BankMatrixProps {
  activeGlobalFilter?: GlobalFilterState;
  onSelectFilter?: (bank: BankFilterKey, amount: AmountFilterKey) => void;
  onNavigateTab?: (tab: 'overview' | 'projections' | 'orderbook') => void;
}

const STATUS: Record<CellStatus, { label: string; className: string; Icon: React.ComponentType<{ className?: string }> }> = {
  EXECUTABLE: { label: 'EJECUTABLE', className: 'text-[#02c076] border-[#02c076]/40 bg-[#02c076]/10', Icon: CheckCircle2 },
  NO_OPPORTUNITY: { label: 'SIN ARBITRAJE', className: 'text-[#848e9c] border-[#2b2f36] bg-[#181a20]', Icon: XCircle },
  NO_LIQUIDITY: { label: 'SIN LIQUIDEZ', className: 'text-[#f0b90b] border-[#f0b90b]/40 bg-[#f0b90b]/10', Icon: Droplet },
  INSUFFICIENT_LIQUIDITY: { label: 'LIQUIDEZ INSUF.', className: 'text-[#f0b90b] border-[#f0b90b]/40 bg-[#f0b90b]/10', Icon: Droplet },
  NO_AD: { label: 'SIN ANUNCIO', className: 'text-[#5e6673] border-[#2b2f36] bg-[#181a20]', Icon: Info },
  STALE: { label: 'DATO ANTIGUO', className: 'text-[#f0b90b] border-[#f0b90b]/40 bg-[#f0b90b]/10', Icon: Clock },
  NOT_VERIFIABLE: { label: 'NO VERIFICABLE', className: 'text-[#848e9c] border-[#848e9c]/40 bg-[#181a20]', Icon: HelpCircle },
  ERROR: { label: 'ERROR', className: 'text-[#f6465d] border-[#f6465d]/40 bg-[#f6465d]/10', Icon: AlertTriangle },
};

const money = (v: number | null | undefined) => v == null ? 'no verificable' : `${v.toFixed(2)} VES`;
const usdt = (v: number | null) => v == null ? 'no verificable' : `${v.toFixed(2)} USDT`;
const pct = (v: number | null | undefined) => v == null ? 'no verificable' : `${v >= 0 ? '+' : ''}${v.toFixed(4)}%`;

function Cell({ cell, onSelect }: { cell: ExecutableCell; onSelect: () => void }) {
  const s = STATUS[cell.status];
  return (
    <button type="button" onClick={onSelect} title={cell.reason ?? undefined} className={`w-full min-w-[155px] rounded-md border px-2.5 py-2 text-left ${s.className}`}>
      <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wide"><s.Icon className="h-3 w-3" />{s.label}</div>
      <div className="mt-1.5 space-y-0.5 font-mono text-[10px]">
        <div className="flex justify-between gap-2"><span className="text-[#848e9c]">MI COMPRA · BID</span><span>{cell.buy ? cell.buy.price.toFixed(2) : '—'}</span></div>
        <div className="flex justify-between gap-2"><span className="text-[#848e9c]">MI VENTA · ASK</span><span>{cell.sell ? cell.sell.price.toFixed(2) : '—'}</span></div>
        <div className="flex justify-between gap-2 border-t border-current/10 pt-0.5"><span className="text-[#848e9c]">Margen</span><span>{pct(cell.spreadPct)}</span></div>
        <div className="flex justify-between gap-2"><span className="text-[#848e9c]">Liquidez</span><span>{cell.availableUsdt == null ? 'n/v' : cell.availableUsdt.toFixed(0)}</span></div>
      </div>
    </button>
  );
}

function FlowCard({ cell, onNavigateTab }: { cell: ExecutableCell; onNavigateTab?: (tab: 'overview' | 'projections' | 'orderbook') => void }) {
  const op = cell.opportunity;
  const executable = cell.status === 'EXECUTABLE' && op !== null;
  return (
    <div className={`rounded-lg border p-4 ${executable ? 'border-[#02c076]/50 bg-[#02c076]/5' : 'border-[#2b2f36] bg-[#181a20]'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-bold text-[#e0e0e0]">{cell.bankDisplayName} · {cell.amountVes.toLocaleString('es-VE')} VES</div>
        <span className={`rounded border px-2 py-0.5 text-[10px] font-bold ${STATUS[cell.status].className}`}>{STATUS[cell.status].label}</span>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-4 text-[11px]">
        <div className="rounded border border-[#2b2f36] p-2"><div className="text-[#5e6673]">1 · ENTRADA</div><div className="font-bold text-[#02c076]">MI COMPRA</div><div className="text-[#848e9c]">Binance SELL / BID · yo compro USDT</div><div className="font-mono text-[#e0e0e0]">{executable ? money(op!.arbitrageBuyPrice) : 'no disponible'}</div></div>
        <div className="rounded border border-[#2b2f36] p-2"><div className="text-[#5e6673]">2 · SALIDA</div><div className="font-bold text-[#FCD535]">MI VENTA</div><div className="text-[#848e9c]">Binance BUY / ASK · yo vendo USDT</div><div className="font-mono text-[#e0e0e0]">{executable ? money(op!.arbitrageSellPrice) : 'no disponible'}</div></div>
        <div className="rounded border border-[#2b2f36] p-2"><div className="text-[#5e6673]">3 · RESULTADO</div><div className={`font-bold ${executable ? 'text-[#02c076]' : 'text-[#f6465d]'}`}>{executable ? 'MARGEN POSITIVO' : 'NO OPERAR'}</div><div className="text-[#848e9c]">{cell.reason ?? 'Ambas piernas y liquidez verificadas.'}</div><div className="font-mono text-[#e0e0e0]">{executable ? `${op!.marginVes.toFixed(2)} VES · ${pct(op!.marginPct)}` : '—'}</div></div>
        <div className="rounded border border-[#2b2f36] p-2"><div className="text-[#5e6673]">4 · SIGUIENTE</div><div className="font-bold text-[#e0e0e0]">PUBLICACIÓN / ANÁLISIS</div><div className="text-[#848e9c]">La matriz responde ejecución; Proyección responde contexto.</div><div className="mt-1 flex gap-2"><button type="button" onClick={() => onNavigateTab?.('projections')} className="text-[#FCD535] underline">Proyección</button><button type="button" onClick={() => onNavigateTab?.('orderbook')} className="text-[#FCD535] underline">Libro</button></div></div>
      </div>
      {executable && <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-3"><div><span className="text-[#5e6673]">Anuncio entrada:</span> <span className="font-mono">#{op!.buyAdvNo}</span></div><div><span className="text-[#5e6673]">Anuncio salida:</span> <span className="font-mono">#{op!.sellAdvNo}</span></div><div><span className="text-[#5e6673]">Liquidez común:</span> <span className="font-mono">{usdt(op!.availableUsdt)}</span></div></div>}
    </div>
  );
}

export const BankMatrix: React.FC<BankMatrixProps> = ({ activeGlobalFilter, onSelectFilter, onNavigateTab }) => {
  const [matrix, setMatrix] = useState<ExecutableMatrix | null>(null);
  const [reference, setReference] = useState<MarketReference | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (force = false) => {
    try {
      force ? setRefreshing(true) : setLoading(true);
      const response = await ApiService.getExecutableMatrix(force);
      setMatrix(response.executableMatrix);
      setReference(response.marketReference);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo cargar la matriz ejecutable.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { void load(); }, []);

  if (loading) return <div className="p-6 text-center text-sm text-[#848e9c]">Cargando matriz ejecutable…</div>;
  if (error) return <div className="rounded-lg border border-[#f6465d]/30 p-6 text-sm text-[#f6465d]">{error}<button type="button" onClick={() => void load(true)} className="ml-3 underline">Reintentar</button></div>;
  if (!matrix) return <div className="p-6 text-center text-sm text-[#848e9c]">No hay matriz disponible.</div>;

  const view = filterMatrixView(matrix, activeGlobalFilter);
  const selected = view.singleCell;
  const executableCount = Object.values(matrix.cells).flatMap(row => Object.values(row)).filter(c => c.status === 'EXECUTABLE').length;

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-[#2b2f36] bg-[#111417] p-4">
        <div className="flex items-start gap-3"><Building2 className="mt-0.5 h-5 w-5 text-[#FCD535]" /><div><h2 className="text-sm font-bold text-[#e0e0e0]">MATRIZ MULTIFILTRO · FLUJO DE OPERACIÓN</h2><p className="mt-1 text-[11px] leading-relaxed text-[#848e9c]">La matriz no es otra cotización: es el punto donde el bot cruza <b className="text-[#e0e0e0]">BANCO + MONTO + DOS PIERNAS + LIQUIDEZ</b>. El flujo correcto es <b className="text-[#02c076]">MI COMPRA → MI VENTA → MARGEN</b>.</p></div></div>
        <div className="mt-3 grid gap-2 md:grid-cols-4 text-[10px]"><div className="rounded border border-[#2b2f36] p-2"><b>1. Binance SELL / BID</b><br/><span className="text-[#848e9c]">anuncio que vende USDT → MI COMPRA.</span></div><ArrowRight className="hidden md:block self-center text-[#5e6673]" /><div className="rounded border border-[#2b2f36] p-2"><b>2. Binance BUY / ASK</b><br/><span className="text-[#848e9c]">anuncio que compra USDT → MI VENTA.</span></div><ArrowRight className="hidden md:block self-center text-[#5e6673]" /><div className="rounded border border-[#2b2f36] p-2"><b>3. OPORTUNIDAD</b><br/><span className="text-[#848e9c]">MI VENTA − MI COMPRA &gt; 0 y ambas piernas son ejecutables.</span></div><ArrowRight className="hidden md:block self-center text-[#5e6673]" /><div className="rounded border border-[#2b2f36] p-2"><b>4. CONTEXTO</b><br/><span className="text-[#848e9c]">Proyección y análisis dicen qué está haciendo el mercado; no sustituyen los anuncios.</span></div></div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-[#2b2f36] bg-[#181a20] p-3 text-[11px]">
        <div><span className="text-[#5e6673]">Filtro activo:</span> <b>{activeGlobalFilter?.bankDisplayName ?? 'Todos los Bancos'}</b> · <b>{activeGlobalFilter?.amount ?? 'ALL'}</b> · <span className="text-[#5e6673]">Ejecutables detectados: {executableCount}</span></div>
        <button type="button" onClick={() => void load(true)} disabled={refreshing} className="flex items-center gap-1 rounded border border-[#2b2f36] px-2 py-1 hover:bg-[#2b2f36] disabled:opacity-50"><RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />Actualizar</button>
      </div>

      {view.bankUnavailable ? <div className="rounded border border-[#f6465d]/30 p-4 text-xs text-[#f6465d]">El banco seleccionado no está disponible en la matriz capturada. No se sustituyen datos de otro banco.</div> : (
        <div className="overflow-x-auto rounded-lg border border-[#2b2f36]">
          <table className="w-full min-w-[760px] border-collapse text-[10px]"><thead><tr className="bg-[#181a20] text-[#848e9c]"><th className="p-2 text-left">BANCO / MONTO</th>{view.visibleAmounts.map(a => <th key={a} className="p-2 text-left font-mono">{a}</th>)}</tr></thead><tbody>{view.visibleBanks.map(bank => <tr key={bank} className="border-t border-[#2b2f36] align-top"><th className="p-2 text-left font-bold text-[#e0e0e0]">{matrix.bankDisplayNames[bank] ?? bank}</th>{view.visibleAmounts.map(amount => { const cell = matrix.cells[bank]?.[amount]; return <td key={amount} className="p-1.5">{cell ? <Cell cell={cell} onSelect={() => onSelectFilter?.(bank as BankFilterKey, amount as AmountFilterKey)} /> : <span className="text-[#5e6673]">Sin captura</span>}</td>; })}</tr>)}</tbody></table>
        </div>
      )}

      {selected && <FlowCard cell={selected} onNavigateTab={onNavigateTab} />}
      {!selected && activeGlobalFilter && (activeGlobalFilter.bank !== 'ALL' || activeGlobalFilter.amount !== 'ALL') && <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-4 text-[11px] text-[#848e9c]">Selecciona banco y monto para ver el flujo completo de esa operación. Si falta una pierna, se explica el motivo; nunca se inventa un precio.</div>}

      {reference && <div className="rounded border border-[#2b2f36] p-3 text-[10px] text-[#5e6673]">Referencia general: {reference.note} · capturada hace {reference.ageSeconds}s. No es una cotización ejecutable.</div>}
    </div>
  );
};
