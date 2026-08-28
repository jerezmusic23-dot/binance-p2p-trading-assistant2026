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
import { MarketSnapshot, MarketAnalysis, MarketProjections } from './types';
import { ProvenanceTag, InsufficientDataNotice, StaleTag } from './ProvenanceTag';
import { MyOperationPanel } from './MyOperationPanel';
import { PublishPanel } from './PublishPanel';
import { fmt, fmtPct, fmtSignedPct, fmtInt, fmtText, NO_DATA } from './format';

interface MainOverviewProps {
  snapshot: MarketSnapshot | null;
  analysis: MarketAnalysis | null;
  projections: MarketProjections | null;
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
  analysis,
  projections,
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

  const advice = projections?.merchantAdvice;
  /*
   * C2: the frontend invents nothing. When the server does not deliver a
   * block, the UI shows a gap.
   */
  const probs = projections?.probabilities ?? { up: null, neutral: null, down: null };
  const probsProvenance = projections?.provenance.probabilities ?? null;

  const pressure = advice?.orderBookPressure ?? null;

  return (
    <div id="main-overview-panel" className="space-y-4">
      {projections && !projections.hasSufficientData && (
        <InsufficientDataNotice reason={projections.insufficientDataReason} />
      )}

      {snapshot.filterFallbackReason && (
        <InsufficientDataNotice reason={snapshot.filterFallbackReason} />
      )}

      {derivedStale && (
        <div className="flex items-center gap-2 text-[11px] text-[#848e9c] font-mono">
          <StaleTag ageSeconds={derivedAgeSeconds} />
          <span>Análisis y proyecciones no se han podido refrescar; se muestra el último valor válido.</span>
        </div>
      )}

      {/* Strategic Decision & Actionable Forecast Banner */}
      {advice && (
        <div id="card-forecast-action" className="bg-[#181a20] border-2 border-[#FCD535]/50 rounded-lg p-5 relative overflow-hidden shadow-lg">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 border-b border-[#2b2f36] pb-4">
            <div className="flex items-center gap-3.5">
              <div className="w-11 h-11 rounded-lg bg-[#FCD535]/15 border border-[#FCD535]/50 flex items-center justify-center text-[#FCD535]">
                <Compass className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-[#FCD535] text-black font-mono">
                    ¿QUÉ PASARÁ CON EL PRECIO?
                  </span>
                  <span className="text-xs font-mono text-[#02c076] flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-[#02c076] animate-pulse" />
                    Proyección Activa
                  </span>
                </div>
                <h3 className="text-base font-bold text-[#e0e0e0] mt-1">
                  {advice.actionTitle}
                </h3>
              </div>
            </div>

            {/* Quick action timing windows */}
            <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
              <div className="bg-[#111417] border border-[#2b2f36] px-3.5 py-2 rounded">
                <span className="text-[#848e9c] text-[10px] uppercase block font-semibold">Ventana Venta Óptima</span>
                <span className="text-[#FCD535] font-bold text-sm">{fmtText(advice.optimalSellTimeWindow)}</span>
              </div>
              <div className="bg-[#111417] border border-[#2b2f36] px-3.5 py-2 rounded">
                <span className="text-[#848e9c] text-[10px] uppercase block font-semibold">Ventana Recompra Óptima</span>
                <span className="text-[#02c076] font-bold text-sm">{fmtText(advice.optimalBuyTimeWindow)}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 pt-4">
            {/* Explanation */}
            <div className="lg:col-span-2 text-[#848e9c] leading-relaxed flex items-start gap-3">
              <CheckCircle2 className="w-4 h-4 text-[#02c076] shrink-0 mt-0.5" />
              <div>
                <p className="text-xs text-[#e0e0e0] font-medium leading-relaxed">
                  {advice.actionExplanation}
                </p>
                <div className="flex items-center gap-4 mt-2 text-[11px] font-mono text-[#848e9c]">
                  <span>Pico estimado: <strong className="text-[#FCD535]">{fmt(advice.projectedPeakRate)} VES</strong></span>
                  <span>·</span>
                  <span>Piso estimado: <strong className="text-[#02c076]">{fmt(advice.projectedTroughRate)} VES</strong></span>
                </div>
              </div>
            </div>

            {/* Order Book Pressure Gauge */}
            <div className="bg-[#111417] border border-[#2b2f36] p-3.5 rounded-lg flex flex-col justify-between">
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="text-[10px] uppercase text-[#848e9c] font-bold tracking-wider flex items-center gap-1.5">
                  <Scale className="w-3.5 h-3.5 text-[#FCD535]" />
                  Presión del Libro (Binance)
                </span>
                <span className={`text-[10px] font-bold uppercase font-mono ${
                  pressure?.dominantSide === 'COMPRA'
                    ? 'text-[#02c076]'
                    : pressure?.dominantSide === 'VENTA'
                    ? 'text-[#cf304a]'
                    : 'text-[#848e9c]'
                }`}>
                  {fmtText(pressure?.dominantSide)}
                </span>
              </div>

              {/*
                * C2: with no published liquidity there are no bars to draw.
                * The former 50/50 split over 12000 invented USDT is gone.
                */}
              {pressure && pressure.buyPressurePct !== null && pressure.sellPressurePct !== null ? (
                <div className="space-y-1.5">
                  <div className="w-full bg-[#cf304a]/30 h-2.5 rounded-full overflow-hidden flex">
                    <div
                      className="bg-[#02c076] h-full transition-all duration-500"
                      style={{ width: `${pressure.buyPressurePct}%` }}
                      title={`Compradores: ${pressure.buyPressurePct}%`}
                    />
                    <div
                      className="bg-[#cf304a] h-full transition-all duration-500"
                      style={{ width: `${pressure.sellPressurePct}%` }}
                      title={`Vendedores: ${pressure.sellPressurePct}%`}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[10px] font-mono">
                    <span className="text-[#02c076] font-bold flex items-center gap-1">
                      Compra: {fmtPct(pressure.buyPressurePct, 0)} ({fmtInt(pressure.buyVolumeUsdt)} USDT)
                      <ProvenanceTag
                        provenance={pressure.buyVolume.provenance}
                        reason={pressure.buyVolume.reason}
                      />
                    </span>
                    <span className="text-[#cf304a] font-bold flex items-center gap-1">
                      Venta: {fmtPct(pressure.sellPressurePct, 0)} ({fmtInt(pressure.sellVolumeUsdt)} USDT)
                      <ProvenanceTag
                        provenance={pressure.sellVolume.provenance}
                        reason={pressure.sellVolume.reason}
                      />
                    </span>
                  </div>
                </div>
              ) : (
                <div className="text-[10px] font-mono text-[#848e9c] flex items-center gap-1.5">
                  {NO_DATA} Sin liquidez publicada en el libro: no hay presión que medir.
                  {pressure && (
                    <ProvenanceTag
                      provenance={pressure.buyVolume.provenance}
                      reason={pressure.buyVolume.reason}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/*
        OPORTUNIDADES EJECUTABLES - separated from MERCADO GLOBAL below.

        This section is the only place an arbitrage may be declared, and it is
        fed by /market/opportunities, which is the executability cell for one
        bank and one amount. The cards below it are market context.
      */}
      {/*
        WHAT TO PUBLISH, first. The operator is a maker: this is the question
        they open the app to answer, and it comes before anything about taking
        somebody else's ad.
      */}
      <section aria-label="Precios a publicar">
        <PublishPanel onOpenMatrix={() => onNavigateTab('publish')} />
      </section>

      <section aria-label="Oportunidades ejecutables">
        <MyOperationPanel />
      </section>

      {/* 4 Primary Metric Cards - MERCADO GLOBAL: contexto, no cotizacion */}
      <h2 className="text-[10px] uppercase text-[#848e9c] font-bold tracking-wider pt-2">
        Mercado global (referencia, no ejecutable)
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
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

        {/* Card 2: 2 & 3. Tendencia & Dirección */}
        <div id="card-trend" className="bg-[#181a20] border border-[#2b2f36] p-5 rounded-lg relative">
          <div className="flex items-center justify-between text-xs mb-3">
            <span className="text-[10px] uppercase text-[#848e9c] font-bold tracking-wider">2 & 3. Tendencia & Dirección</span>
            <span className="text-[10px] text-[#848e9c] font-mono flex items-center gap-1">
              Fuerza: {fmtPct(analysis?.trendStrength, 0)}
              {analysis && (
                <ProvenanceTag
                  provenance={analysis.provenance.trendStrength}
                  reason="trendStrength = |pendiente%| * 600 + 35. Ninguna de las dos constantes procede de los datos."
                  dataWindow={analysis.dataWindow}
                />
              )}
            </span>
          </div>

          <div className="mt-1 flex items-center justify-between">
            <div>
              <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-bold border ${getTrendColor(analysis?.trend)}`}>
                {getTrendIcon(analysis?.trend)}
                <span>{fmtText(analysis?.trend)}</span>
              </div>
              <p className="text-xs text-[#848e9c] mt-3 font-mono">
                Momentum: <strong className="text-[#e0e0e0]">{fmtText(analysis?.momentum)}</strong>
              </p>
            </div>
            <div className="text-right text-xs">
              <span className="text-[10px] uppercase text-[#848e9c] block">vs Media SMA:</span>
              <span className={`font-mono font-bold text-sm ${
                analysis?.priceVsSmaPct == null
                  ? 'text-[#848e9c]'
                  : analysis.priceVsSmaPct >= 0
                  ? 'text-[#02c076]'
                  : 'text-[#cf304a]'
              }`}>
                {fmtSignedPct(analysis?.priceVsSmaPct)}
              </span>
            </div>
          </div>
        </div>

        {/* Card 3: 5 & 6. Rango Esperado del Día */}
        <div id="card-expected-range" className="bg-[#181a20] border border-[#2b2f36] p-5 rounded-lg relative">
          <div className="flex items-center justify-between text-xs mb-3">
            <span className="text-[10px] uppercase text-[#848e9c] font-bold tracking-wider flex items-center gap-1.5">
              5 &amp; 6. Rango del Día (VES)
              {projections && (
                <ProvenanceTag
                  provenance={projections.provenance.daily}
                  dataWindow={projections.dataWindow}
                />
              )}
            </span>
            <span className="text-[10px] text-[#FCD535] font-mono flex items-center gap-1">
              Confianza: {fmtPct(projections?.daily.confidencePct, 0)}
              {projections && (
                <ProvenanceTag
                  provenance={projections.provenance.confidence}
                  reason="La confianza es hoy una función del número de muestras (62 + n*0.35), no del error medido."
                />
              )}
            </span>
          </div>

          <div className="mt-1">
            <div className="text-xl font-bold font-mono text-[#FCD535] leading-tight">
              {fmt(projections?.daily.floor)} — {fmt(projections?.daily.ceiling)} <span className="text-xs text-[#848e9c]">VES</span>
            </div>
            <div className="flex items-center justify-between text-xs mt-4 pt-3 border-t border-[#2b2f36] text-[#848e9c]">
              <span>Piso: <strong className="text-[#02c076] font-mono">{fmt(projections?.daily.floor)}</strong></span>
              <span>Techo: <strong className="text-[#FCD535] font-mono">{fmt(projections?.daily.ceiling)}</strong></span>
            </div>
          </div>
        </div>

        {/* Card 4: 7 & 8. Riesgo & Probabilidad */}
        <div id="card-risk-level" className="bg-[#181a20] border border-[#2b2f36] p-5 rounded-lg relative">
          <div className="flex items-center justify-between text-xs mb-3">
            <span className="text-[10px] uppercase text-[#848e9c] font-bold tracking-wider flex items-center gap-1.5">
              7 &amp; 8. Riesgo &amp; Probabilidad
              {probsProvenance && <ProvenanceTag provenance={probsProvenance} />}
            </span>
            <span className="text-[10px] font-mono text-[#848e9c]">RSI: {fmt(analysis?.rsi, 1)}</span>
          </div>

          <div className="mt-1 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5">
                <span className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${
                  projections?.risk.level === 'ALTO' ? 'bg-[#472c2c] border border-[#cf304a] text-[#cf304a]' :
                  projections?.risk.level === 'MEDIO' ? 'bg-[#FCD535]/15 border border-[#FCD535]/40 text-[#FCD535]' :
                  'bg-[#02c076]/15 border border-[#02c076]/40 text-[#02c076]'
                }`}>
                  RIESGO {fmtText(projections?.risk.level)}
                </span>
              </div>
              <p className="text-xs text-[#848e9c] mt-3 font-mono">
                Volatilidad: <strong className="text-[#e0e0e0]">{fmtText(analysis?.volatility)}</strong>
              </p>
            </div>

            <div className="text-right text-xs">
              <span className="text-[10px] uppercase text-[#848e9c] block">Más Probable:</span>
              <span className="font-bold text-[#e0e0e0] font-mono">
                {probs.up === null || probs.down === null || probs.neutral === null
                  ? NO_DATA
                  : probs.up > probs.down && probs.up > probs.neutral
                  ? '▲ SUBIR'
                  : probs.down > probs.up && probs.down > probs.neutral
                  ? '▼ BAJAR'
                  : '■ MANTENER'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Section: Probabilidades Estadísticas + Horizontes + Reasons */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Left 2 Cols: Probabilidades & Horizontes Temporales */}
        <div id="section-where-is-market-going" className="lg:col-span-2 bg-[#181a20] border border-[#2b2f36] rounded-lg p-5 space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-b border-[#2b2f36] pb-3">
            <div>
              <h2 className="text-xs uppercase text-[#848e9c] font-bold tracking-wider flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-[#FCD535]" />
                DISTRIBUCIÓN DE PROBABILIDAD (REGRESIÓN & PROFUNDIDAD)
              </h2>
              <p className="text-[11px] text-[#848e9c] mt-0.5">
                Estimación multivariable calculada sobre la sesión venezolana en tiempo real.
              </p>
            </div>
            <button
              onClick={() => onNavigateTab('projections')}
              className="text-xs font-semibold text-[#FCD535] hover:text-amber-300 flex items-center gap-1 cursor-pointer transition"
            >
              <span>Ver Gráfico 8AM-8PM</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* 3-Column Probabilities Bar */}
          <div className="grid grid-cols-3 gap-3">
            {/* SUBIR */}
            <div className={`p-3.5 rounded border transition ${(probs.up ?? 0) >= 45 ? 'bg-[#111417] border-[#02c076]' : 'bg-[#111417] border-[#2b2f36]'}`}>
              <div className="flex items-center justify-between text-xs text-[#848e9c] mb-1">
                <span className="font-bold text-[#02c076] flex items-center gap-1 text-[11px]">
                  <ArrowUpRight className="w-3.5 h-3.5" /> SUBIR
                </span>
                <span className="text-[10px] uppercase font-mono">Alcista</span>
              </div>
              <div className="text-2xl font-bold font-mono text-[#02c076]">{fmtPct(probs.up, 0)}</div>
              <div className="w-full bg-[#2b2f36] h-1.5 rounded-full mt-2 overflow-hidden">
                <div className="bg-[#02c076] h-full rounded-full transition-all duration-500" style={{ width: `${probs.up ?? 0}%` }} />
              </div>
            </div>

            {/* MANTENER */}
            <div className={`p-3.5 rounded border transition ${(probs.neutral ?? 0) >= 45 ? 'bg-[#111417] border-[#FCD535]' : 'bg-[#111417] border-[#2b2f36]'}`}>
              <div className="flex items-center justify-between text-xs text-[#848e9c] mb-1">
                <span className="font-bold text-[#FCD535] flex items-center gap-1 text-[11px]">
                  <Minus className="w-3.5 h-3.5" /> MANTENER
                </span>
                <span className="text-[10px] uppercase font-mono">Lateral</span>
              </div>
              <div className="text-2xl font-bold font-mono text-[#FCD535]">{fmtPct(probs.neutral, 0)}</div>
              <div className="w-full bg-[#2b2f36] h-1.5 rounded-full mt-2 overflow-hidden">
                <div className="bg-[#FCD535] h-full rounded-full transition-all duration-500" style={{ width: `${probs.neutral ?? 0}%` }} />
              </div>
            </div>

            {/* BAJAR */}
            <div className={`p-3.5 rounded border transition ${(probs.down ?? 0) >= 45 ? 'bg-[#111417] border-[#cf304a]' : 'bg-[#111417] border-[#2b2f36]'}`}>
              <div className="flex items-center justify-between text-xs text-[#848e9c] mb-1">
                <span className="font-bold text-[#cf304a] flex items-center gap-1 text-[11px]">
                  <ArrowDownRight className="w-3.5 h-3.5" /> BAJAR
                </span>
                <span className="text-[10px] uppercase font-mono">Bajista</span>
              </div>
              <div className="text-2xl font-bold font-mono text-[#cf304a]">{fmtPct(probs.down, 0)}</div>
              <div className="w-full bg-[#2b2f36] h-1.5 rounded-full mt-2 overflow-hidden">
                <div className="bg-[#cf304a] h-full rounded-full transition-all duration-500" style={{ width: `${probs.down ?? 0}%` }} />
              </div>
            </div>
          </div>

          {/* Intraday Horizons Preview */}
          <div className="mt-4 pt-3 border-t border-[#2b2f36]">
            <h3 className="text-[10px] font-bold text-[#848e9c] uppercase tracking-wider mb-2.5">
              Proyección Intradía por Horizontes Temporales (Tasa Esperada Venta / Recompra)
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              {projections?.intradayHorizons?.map((h) => (
                <div key={h.horizon} className="bg-[#111417] border border-[#2b2f36] p-2.5 rounded text-center">
                  <div className="text-[11px] font-bold text-[#FCD535]">{h.horizon}</div>
                  <div className="text-[10px] text-[#848e9c] font-mono">{h.targetTime}</div>
                  <div className="font-mono text-xs font-bold text-[#e0e0e0] mt-1">{fmt(h.projectedBuy)}</div>
                  <div className="text-[9px] text-[#848e9c] font-mono mt-0.5">
                    {fmt(h.rangeMin, 1)} - {fmt(h.rangeMax, 1)}
                  </div>
                  {/* C2: no sample-count confidence. Absent until the backtest measures it. */}
                  <div className="text-[9px] text-[#848e9c] font-medium mt-1 font-mono">
                    Conf: {fmtPct(h.confidence, 0)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Col: Fundamentos y Razones Estadísticas */}
        <div id="section-why-reasons" className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5 flex flex-col justify-between">
          <div>
            <div className="border-b border-[#2b2f36] pb-3 mb-3">
              <h2 className="text-xs uppercase text-[#848e9c] font-bold tracking-wider flex items-center gap-2">
                <Info className="w-3.5 h-3.5 text-[#FCD535]" />
                9. FUNDAMENTOS ESTADÍSTICOS ('POR QUÉ')
              </h2>
              <p className="text-[11px] text-[#848e9c] mt-0.5">
                Factores técnicos en tiempo real que sustentan la proyección.
              </p>
            </div>

            <div className="space-y-2.5">
              {analysis?.reasons && analysis.reasons.length > 0 ? (
                analysis.reasons.map((reason, idx) => (
                  <div key={idx} className="flex items-start gap-2.5 text-xs text-[#e0e0e0] bg-[#111417] p-2.5 rounded border border-[#2b2f36]">
                    <span className="mt-1 w-1.5 h-1.5 rounded-full bg-[#02c076] shrink-0" />
                    <span className="leading-relaxed">{reason}</span>
                  </div>
                ))
              ) : (
                <p className="text-xs text-[#848e9c]">Recopilando datos de mercado en tiempo real...</p>
              )}
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-[#2b2f36] flex items-center justify-between">
            <span className="text-[10px] text-[#848e9c] font-mono uppercase tracking-wider">Binance P2P: Sincronizado</span>
            <button
              onClick={() => onNavigateTab('matrix')}
              className="text-xs font-semibold text-[#FCD535] hover:text-amber-300 flex items-center gap-1 cursor-pointer"
            >
              <span>Matriz Bancos</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Direct Quick Shortcuts */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <button
          onClick={() => onNavigateTab('projections')}
          className="p-4 rounded-lg bg-[#181a20] border border-[#2b2f36] hover:border-[#474d57] text-left transition group cursor-pointer"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-[#FCD535] flex items-center gap-1.5 uppercase tracking-wide">
              <Sparkles className="w-4 h-4" /> Gráfico Fluctuation 8AM-8PM
            </span>
            <ChevronRight className="w-4 h-4 text-[#848e9c] group-hover:translate-x-1 transition" />
          </div>
          <p className="text-xs text-[#848e9c]">
            Curvas de Venta y Recompra con picos, retrocesos, techos, pisos y línea punteada proyectada.
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
