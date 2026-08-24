import React from 'react';
import { RefreshCw, ShieldCheck, Clock, AlertTriangle, Building2, DollarSign } from 'lucide-react';
import { MarketSnapshot, GlobalFilterState } from './types';
import { fmt, fmtPct } from './format';

interface HeaderProps {
  snapshot: MarketSnapshot | null;
  globalFilter: GlobalFilterState;
  ageSeconds: number;
  status: 'LIVE' | 'STALE' | 'OFFLINE';
  isRefreshing: boolean;
  onRefresh: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  snapshot,
  globalFilter,
  ageSeconds,
  status,
  isRefreshing,
  onRefresh,
}) => {
  const getStatusBadge = () => {
    switch (status) {
      case 'LIVE':
        return (
          <div id="badge-live-status" className="flex flex-col items-end">
            <span className="text-[10px] uppercase text-[#848e9c] tracking-widest font-semibold">Status</span>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#02c076] animate-pulse" />
              <span className="text-[#02c076] text-xs font-bold uppercase tracking-wider">Live</span>
            </div>
          </div>
        );
      case 'STALE':
        return (
          <div id="badge-stale-status" className="flex flex-col items-end">
            <span className="text-[10px] uppercase text-[#848e9c] tracking-widest font-semibold">Status</span>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#FCD535]" />
              <span className="text-[#FCD535] text-xs font-bold uppercase tracking-wider">Stale ({ageSeconds}s)</span>
            </div>
          </div>
        );
      case 'OFFLINE':
      default:
        return (
          <div id="badge-offline-status" className="flex flex-col items-end">
            <span className="text-[10px] uppercase text-[#848e9c] tracking-widest font-semibold">Status</span>
            <div className="flex items-center gap-1.5 text-[#cf304a]">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span className="text-xs font-bold uppercase tracking-wider">Offline</span>
            </div>
          </div>
        );
    }
  };

  const formatSafeTime = (ts?: number | null) => {
    if (!ts || isNaN(ts)) return '--:--:--';
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return '--:--:--';
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      const s = String(d.getSeconds()).padStart(2, '0');
      return `${h}:${m}:${s}`;
    } catch {
      return '--:--:--';
    }
  };

  const formattedTime = formatSafeTime(snapshot?.timestamp);

  const isFiltered = globalFilter.bank !== 'ALL' || globalFilter.amount !== 'ALL';

  return (
    <header id="app-header" className="sticky top-0 z-40 bg-[#111417] border-b border-[#2b2f36] shadow-md px-4 lg:px-8 py-3">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        {/* Left: Brand & Market Pair matching Technical Dashboard */}
        <div className="flex items-center gap-3.5 w-full md:w-auto justify-between md:justify-start">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#FCD535] rounded flex items-center justify-center font-bold text-black text-xl shadow-sm select-none">
              B
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg font-bold tracking-tight text-[#e0e0e0] flex items-center gap-1.5">
                  P2P <span className="text-[#848e9c] font-normal">ASSISTANT</span>
                </h1>
                <div className="px-2 py-0.5 bg-[#1e2329] border border-[#474d57] rounded-full text-xs font-mono font-medium text-[#FCD535]">
                  USDT / VES
                </div>

                {isFiltered ? (
                  <div className="px-2 py-0.5 bg-[#FCD535]/15 border border-[#FCD535]/40 rounded text-[11px] font-mono font-bold text-[#FCD535] flex items-center gap-1">
                    <Building2 className="w-3 h-3" />
                    <span>{globalFilter.bankDisplayName} {globalFilter.amount !== 'ALL' ? `· ${globalFilter.amount}` : ''}</span>
                  </div>
                ) : (
                  <div className="px-2 py-0.5 bg-[#181a20] border border-[#2b2f36] rounded text-[11px] font-mono text-[#848e9c] hidden sm:block">
                    Mercado General
                  </div>
                )}
              </div>
              <p className="text-[11px] text-[#848e9c] flex items-center gap-1 mt-0.5">
                <ShieldCheck className="w-3 h-3 text-[#02c076]" />
                Asistente Estadístico & Proyección en Tiempo Real
              </p>
            </div>
          </div>

          <div className="md:hidden">
            {getStatusBadge()}
          </div>
        </div>

        {/* Center: Live Rates Summary */}
        {snapshot && snapshot.strategicBuyPrice !== null && (
          <div className="hidden lg:flex items-center gap-5 bg-[#181a20] border border-[#2b2f36] px-4 py-2 rounded-lg text-xs">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase text-[#848e9c] font-semibold">
                {isFiltered ? `Venta (${globalFilter.bank}):` : 'Tasa Venta:'}
              </span>
              <span className="font-mono font-bold text-[#FCD535] text-sm">
                {fmt(snapshot.strategicSellPrice)} <span className="text-[10px] text-[#848e9c]">VES</span>
              </span>
            </div>
            <div className="w-px h-4 bg-[#2b2f36]" />
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase text-[#848e9c] font-semibold">
                {isFiltered ? `Recompra (${globalFilter.bank}):` : 'Tasa Recompra:'}
              </span>
              <span className="font-mono font-bold text-[#02c076] text-sm">
                {fmt(snapshot.strategicBuyPrice)} <span className="text-[10px] text-[#848e9c]">VES</span>
              </span>
            </div>
            <div className="w-px h-4 bg-[#2b2f36]" />
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase text-[#848e9c] font-semibold">Spread:</span>
              <span className="font-mono font-semibold text-[#e0e0e0]">
                {fmtPct(snapshot.strategicSpreadPct)}
              </span>
            </div>
          </div>
        )}

        {/* Right: Technical Telemetry & Controls */}
        <div className="flex items-center gap-6 w-full md:w-auto justify-between md:justify-end">
          <div className="hidden md:flex items-center gap-5">
            {getStatusBadge()}

            <div className="flex flex-col items-end">
              <span className="text-[10px] uppercase text-[#848e9c] tracking-widest font-semibold">Last Update</span>
              <span className="text-xs font-mono text-[#e0e0e0]">{formattedTime}</span>
            </div>

            <div className="flex flex-col items-end">
              <span className="text-[10px] uppercase text-[#848e9c] tracking-widest font-semibold">Age</span>
              <span className="text-xs font-mono text-[#e0e0e0]">{ageSeconds.toFixed(1)}s</span>
            </div>
          </div>

          <button
            id="btn-manual-refresh"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#1e2329] hover:bg-[#2b2f36] active:scale-95 text-[#e0e0e0] border border-[#474d57] transition disabled:opacity-50 text-xs font-medium cursor-pointer"
            title="Actualizar datos de Binance ahora"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-[#FCD535]' : 'text-[#FCD535]'}`} />
            <span className="hidden sm:inline">Actualizar</span>
          </button>
        </div>
      </div>
    </header>
  );
};

