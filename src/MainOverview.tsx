import React from 'react';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  CheckCircle2,
  Info,
  Layers,
  Sparkles,
  ChevronRight,
  ArrowUpRight,
  ArrowDownRight,
  Activity,
  Compass,
  DollarSign,
  ShieldCheck,
  Scale,
} from 'lucide-react';
import { MarketSnapshot } from './types';
import { ProvenanceTag, InsufficientDataNotice, StaleTag } from './ProvenanceTag';
import { MyOperationPanel } from './MyOperationPanel';
import { PublishPanel } from './PublishPanel';
import { MarketPulse } from './MarketPulse';
import { fmt, fmtPct, fmtSignedPct, fmtInt, fmtText, NO_DATA } from './format';

interface MainOverviewProps {
  snapshot: MarketSnapshot | null;
  /*
   * analysis and projections USED TO BE PROPS HERE, both from the old
   * ProjectionEngine. Nothing on this screen reads them any more: what the
   * market is doing comes from MarketPulse, which asks the same engine every
   * cell uses. Removing them from the signature is what stops the old engine
   * from being wired back in by habit.
   */
  ageSeconds: number;
  /** Real freshness of the snapshot. The price card must never claim LIVE otherwise. */
  effectiveStatus: 'LIVE' | 'STALE' | 'OFFLINE';
  /** True when analysis/projections could not be refreshed and are the last known good values. */
  derivedStale?: boolean;
  derivedAgeSeconds?: number;
  onNavigateTab: (
    tab: 'publish' | 'analysis' | 'projections' | 'matrix' | 'orderbook' | 'history'
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
  /*
   * The global snapshot gates only the GLOBAL cards below it.
   *
   * It used to gate this entire view, which coupled the executable path to the
   * reference path: with no global median the opportunities disappeared too,
   * even though they come from a different set of ads through a different
   * endpoint. The two are independent and are now rendered independently.
   */
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

  const getTrendIcon = (trend?: string | null) => {
    switch (trend) {
      case 'ALCISTA':
        return <TrendingUp className="w-4 h-4 text-[#02c076]" />;
      case 'BAJISTA':
        return <TrendingDown className="w-4 h-4 text-[#cf304a]" />;
      default:
        return <Minus className="w-4 h-4 text-[#FCD535]" />;
    }
  };

  const getTrendColor = (trend?: string | null) => {
    switch (trend) {
      case 'ALCISTA':
        return 'text-[#02c076] bg-[#02c076]/10 border-[#02c076]/30';
      case 'BAJISTA':
        return 'text-[#cf304a] bg-[#472c2c] border-[#cf304a]/40';
      default:
        return 'text-[#FCD535] bg-[#FCD535]/10 border-[#FCD535]/30';
    }
  };

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

      {/*
        THE STRATEGIC FORECAST BANNER USED TO LIVE HERE, and it is gone.

        It printed "pico estimado" and "piso estimado" alongside an optimal
        buy and sell time window. All four came from ProjectionEngine's
        merchantAdvice: the peak and trough were currentPrice ± volatility ×
        1.6 / 1.5 plus a ±0.007 drift, and the windows came from a
        hand-written per-hour session curve. Nothing measured any of it, and
        the banner was the first thing on the screen.

        What answers the same question from observation is MarketPulse below -
        trend, the empirical band, and the watch window only when the history
        supports one - and the per-cell analysis screen behind it.
      */}
      {/*
        OPORTUNIDADES EJECUTABLES - separated from MERCADO GLOBAL below.

        This section is the only place an arbitrage may be declared, and it is
        fed by /market/opportunities, which is the executability cell for one
        bank and one amount. The cards below it are market context.
      */}
      {/*
        THE ORDER IS THE ANSWER TO FOUR QUESTIONS, IN THIS SEQUENCE:

          1. what do I do now      -> PublishPanel
          2. what is the market doing / 3. what could happen / 4. what to watch
                                   -> MarketPulse
          ...and only then the market context cards below.

        The operator is a maker: what to publish comes before anything about
        taking somebody else's ad.
      */}
      <section aria-label="Precios a publicar">
        <PublishPanel onOpenMatrix={() => onNavigateTab('publish')} />
      </section>

      <section aria-label="Pulso del mercado">
        <MarketPulse onOpenAnalysis={() => onNavigateTab('analysis')} />
      </section>

      <section aria-label="Oportunidades ejecutables">
        <MyOperationPanel />
      </section>

      {/* MERCADO GLOBAL: contexto observado, no cotización */}
      <h2 className="text-[10px] uppercase text-[#848e9c] font-bold tracking-wider pt-2">
        Mercado global (referencia, no ejecutable)
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/*
          Card 1: MERCADO GLOBAL - reference only.

          The medians of the whole book, with no bank and no amount. Renamed
          from "Tasa Real Actual", which was the label that made a global level
          read as something you could trade at. The executable rates are in the
          TASAS EJECUTABLES matrix; the opportunity card below is the only place
          an arbitrage may be declared.
        */}
        <div id="card-current-rate" className="bg-[#181a20] border border-dashed border-[#2b2f36] p-5 rounded-lg relative overflow-hidden">
          <div className="flex items-center justify-between text-xs mb-3">
            <span className="text-[10px] uppercase text-[#848e9c] font-bold tracking-wider">1. Mercado global (referencia)</span>
            {/* C2: the card reports the real freshness, never a fixed "LIVE". */}
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
              Mediana del libro completo, sin filtro de banco ni de monto.
              NO es una tasa ejecutable: nadie puede operar a este precio.
            </p>
          </div>
        </div>

        {/*
          CARDS 2, 3 AND 4 USED TO LIVE HERE, and they went with the old engine.

            Card 2 "Tendencia & Dirección" showed analysis.trend, momentum, and
            a strength whose own provenance tag read "trendStrength =
            |pendiente%| * 600 + 35. Ninguna de las dos constantes procede de
            los datos."
            Card 3 "Rango del día" was currentPrice ± stdDev × 1.6, beside a
            confidence that had already been nulled for the same reason.
            Card 4 was a risk level and the winner of the point-scored
            distribution.

          The same four questions are answered from observation in Pulso del
          mercado directly below - trend with three real horizons, an empirical
          band, and confidence as evidence quality rather than a percentage.
          One engine, one answer.
        */}
      </div>

      {/*
        THE PROBABILITY / HORIZONS / REASONS GRID USED TO LIVE HERE, and it is
        gone with the engine that fed it.

          "DISTRIBUCIÓN DE PROBABILIDAD (REGRESIÓN & PROFUNDIDAD)" was a
          hand-written point system: 33.3 to each outcome, +26 for the
          classified trend, -20 against it, ±8 for order-book pressure, ±6 for
          RSI, clamped to [8, 88]. There was no regression, and nothing counted
          how often a market in that state actually rose.

          "Proyección Intradía por Horizontes Temporales" multiplied the
          current price by a 0.0035 seasonal coefficient and a per-horizon
          factor (×1.15 at +6H). Those horizons were labels, not measurements.

          "FUNDAMENTOS ESTADÍSTICOS" listed analysis.reasons, sentences
          generated from the same heuristics.

        The measured answers live where they can be checked: the empirical
        band and the three real trend horizons in Pulso del mercado and in
        Proyección, and the counted frequencies per cell in Análisis, each with
        its sample size.
      */}
      {/* Direct Quick Shortcuts */}
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
            Histórico real del libro, banda de percentiles observados, techos y pisos donde la
            serie giró de verdad. Sin curva horaria estimada.
          </p>
        </button>

        <button
          onClick={() => onNavigateTab('matrix')}
          className="p-4 rounded-lg bg-[#181a20] border border-[#2b2f36] hover:border-[#474d57] text-left transition group cursor-pointer"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-[#02c076] flex items-center gap-1.5 uppercase tracking-wide">
              <Layers className="w-4 h-4" /> Matriz Multifiltro por Banco
            </span>
            <ChevronRight className="w-4 h-4 text-[#848e9c] group-hover:translate-x-1 transition" />
          </div>
          <p className="text-xs text-[#848e9c]">
            Comparativa de tasas reales por banco (Banesco, Provincial, Mercantil, BNC, etc.) y montos (10K - 100K).
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
