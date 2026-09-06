import React from 'react';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Sparkles,
  ChevronRight,
  Activity,
} from 'lucide-react';
import { MarketSnapshot } from './types';
import { InsufficientDataNotice, StaleTag } from './ProvenanceTag';
import { MyOperationPanel } from './MyOperationPanel';
import { PublishPanel } from './PublishPanel';
import { MarketPulse } from './MarketPulse';
import { fmt, fmtPct } from './format';

interface MainOverviewProps {
  snapshot: MarketSnapshot | null;
  ageSeconds: number;
  effectiveStatus: 'LIVE' | 'STALE' | 'OFFLINE';
  derivedStale?: boolean;
  derivedAgeSeconds?: number;
  onNavigateTab: (
    tab: 'publish' | 'analysis' | 'projections' | 'orderbook' | 'history'
  ) => void;
}

export const MainOverview: React.FC<MainOverviewProps> = ({
  snapshot,
  ageSeconds,
  effectiveStatus,
  derivedStale = false,
  derivedAgeSeconds = 0,
  onNavigateTab,
}) => {
  if (!snapshot || snapshot.strategicBuyPrice === null) {
    return (
      <div className="space-y-4">
        <section aria-label="Precios a publicar">
          <PublishPanel onOpenMatrix={() => onNavigateTab('publish')} />
        </section>

        <section aria-label="Oportunidades ejecutables">
          <MyOperationPanel />
        </section>

        <div id="overview-loading" className="p-8 text-center bg-[#181a20] rounded-lg border border-[#2b2f36]">
          <div className="w-10 h-10 border-3 border-[#FCD535] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-[#e0e0e0] font-medium text-sm">Sin referencia de mercado global</p>
          <p className="text-[#848e9c] text-xs mt-1">
            El nivel mediano del libro no está disponible. Las tasas ejecutables de arriba no
            dependen de él.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div id="main-overview-panel" className="space-y-4">
      {snapshot.filterFallbackReason && (
        <InsufficientDataNotice reason={snapshot.filterFallbackReason} />
      )}

      {derivedStale && (
        <div className="flex items-center gap-2 text-[11px] text-[#848e9c] font-mono">
          <StaleTag ageSeconds={derivedAgeSeconds} />
          <span>Análisis y proyecciones no se han podido refrescar; se muestra el último valor válido.</span>
        </div>
      )}

      <section aria-label="Precios a publicar">
        <PublishPanel onOpenMatrix={() => onNavigateTab('publish')} />
      </section>

      <section aria-label="Pulso del mercado">
        <MarketPulse onOpenAnalysis={() => onNavigateTab('analysis')} />
      </section>

      <section aria-label="Oportunidades ejecutables">
        <MyOperationPanel />
      </section>

      <h2 className="text-[10px] uppercase text-[#848e9c] font-bold tracking-wider pt-2">
        Mercado global (referencia, no ejecutable)
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div id="card-current-rate" className="bg-[#181a20] border border-dashed border-[#2b2f36] p-5 rounded-lg relative overflow-hidden">
          <div className="flex items-center justify-between text-xs mb-3">
            <span className="text-[10px] uppercase text-[#848e9c] font-bold tracking-wider">1. Mercado global (referencia)</span>
            {effectiveStatus === 'LIVE' ? (
              <span className="flex items-center gap-1 text-[10px] text-[#02c076] font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-[#02c076] animate-pulse" />
                P2P LIVE ({ageSeconds.toFixed(0)}s)
              </span>
            ) : effectiveStatus === 'STALE' ? (
              <StaleTag ageSeconds={ageSeconds} />
            ) : (
              <span className="flex items-center gap-1 text-[10px] text-[#cf304a] font-mono font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-[#cf304a]" />
                OFFLINE
              </span>
            )}
          </div>

          <div className="mt-1">
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-black font-mono tracking-tight text-[#FCD535] leading-none">
                {fmt(snapshot.strategicBuyPrice)}
              </span>
              <span className="text-xs font-semibold text-[#848e9c]">VES/USDT</span>
            </div>
            <div className="flex items-center justify-between text-xs mt-4 pt-3 border-t border-[#2b2f36] text-[#848e9c]">
              <span>Venta ref.: <strong className="text-[#848e9c] font-mono">{fmt(snapshot.strategicSellPrice)}</strong></span>
              <span>Spread ref.: <strong className="text-[#848e9c] font-mono">{fmtPct(snapshot.strategicSpreadPct)}</strong></span>
            </div>
            <p className="text-[9px] text-[#5e6673] italic mt-2 leading-snug">
              Mediana del libro completo, sin filtro de banco ni de monto. NO es una tasa ejecutable.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <button
          onClick={() => onNavigateTab('projections')}
          className="p-4 rounded-lg bg-[#181a20] border border-[#2b2f36] hover:border-[#474d57] text-left transition group cursor-pointer"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-[#FCD535] flex items-center gap-1.5 uppercase tracking-wide">
              <Sparkles className="w-4 h-4" /> Proyección del mercado general
            </span>
            <ChevronRight className="w-4 h-4 text-[#848e9c] group-hover:translate-x-1 transition" />
          </div>
          <p className="text-xs text-[#848e9c]">
            Histórico real del libro, movimiento observado y fuerza de la tendencia. Sin curva horaria estimada.
          </p>
        </button>

        <button
          onClick={() => onNavigateTab('analysis')}
          className="p-4 rounded-lg bg-[#181a20] border border-[#2b2f36] hover:border-[#474d57] text-left transition group cursor-pointer"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-[#02c076] flex items-center gap-1.5 uppercase tracking-wide">
              <TrendingUp className="w-4 h-4" /> Análisis del mercado
            </span>
            <ChevronRight className="w-4 h-4 text-[#848e9c] group-hover:translate-x-1 transition" />
          </div>
          <p className="text-xs text-[#848e9c]">
            Tendencia y señales basadas en observaciones reales, separadas de la proyección general.
          </p>
        </button>

        <button
          onClick={() => onNavigateTab('orderbook')}
          className="p-4 rounded-lg bg-[#181a20] border border-[#2b2f36] hover:border-[#474d57] text-left transition group cursor-pointer"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-[#e0e0e0] flex items-center gap-1.5 uppercase tracking-wide">
              <Activity className="w-4 h-4" /> Libro de Anuncios Reales
            </span>
            <ChevronRight className="w-4 h-4 text-[#848e9c] group-hover:translate-x-1 transition" />
          </div>
          <p className="text-xs text-[#848e9c]">
            Comerciantes activos, límites en VES, saldo USDT disponible y tasa exacta de cada anuncio.
          </p>
        </button>
      </div>
    </div>
  );
};
