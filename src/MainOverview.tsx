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

interface MainOverviewProps {
  snapshot: MarketSnapshot | null;
  analysis: MarketAnalysis | null;
  projections: MarketProjections | null;
  ageSeconds: number;
  onNavigateTab: (tab: 'projections' | 'matrix' | 'orderbook' | 'history') => void;
}

export const MainOverview: React.FC<MainOverviewProps> = ({
  snapshot,
  analysis,
  projections,
  ageSeconds,
  onNavigateTab,
}) => {
  if (!snapshot || snapshot.bestBuyPrice <= 0) {
    return (
      <div id="overview-loading" className="p-8 text-center bg-[#181a20] rounded-lg border border-[#2b2f36]">
        <div className="w-10 h-10 border-3 border-[#FCD535] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-[#e0e0e0] font-medium text-sm">Conectando con Binance P2P API...</p>
        <p className="text-[#848e9c] text-xs mt-1">Sincronizando libro de órdenes real USDT/VES y modelos predictivos</p>
      </div>
    );
  }

  const getTrendIcon = (trend?: string) => {
    switch (trend) {
      case 'ALCISTA':
        return <TrendingUp className="w-4 h-4 text-[#02c076]" />;
      case 'BAJISTA':
        return <TrendingDown className="w-4 h-4 text-[#cf304a]" />;
      default:
        return <Minus className="w-4 h-4 text-[#FCD535]" />;
    }
  };

  const getTrendColor = (trend?: string) => {
    switch (trend) {
      case 'ALCISTA':
        return 'text-[#02c076] bg-[#02c076]/10 border-[#02c076]/30';
      case 'BAJISTA':
        return 'text-[#cf304a] bg-[#472c2c] border-[#cf304a]/40';
      default:
        return 'text-[#FCD535] bg-[#FCD535]/10 border-[#FCD535]/30';
    }
  };

  const probs = projections?.probabilities || { up: 33, neutral: 34, down: 33 };
  const advice = projections?.merchantAdvice;
  const pressure = advice?.orderBookPressure || {
    buyVolumeUsdt: 12000,
    sellVolumeUsdt: 12000,
    buyPressurePct: 50,
    sellPressurePct: 50,
    dominantSide: 'EQUILIBRADO' as const,
  };

  return (
    <div id="main-overview-panel" className="space-y-4">
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
                <span className="text-[#FCD535] font-bold text-sm">{advice.optimalSellTimeWindow}</span>
              </div>
              <div className="bg-[#111417] border border-[#2b2f36] px-3.5 py-2 rounded">
                <span className="text-[#848e9c] text-[10px] uppercase block font-semibold">Ventana Recompra Óptima</span>
                <span className="text-[#02c076] font-bold text-sm">{advice.optimalBuyTimeWindow}</span>
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
                  <span>Pico estimado: <strong className="text-[#FCD535]">{advice.projectedPeakRate.toFixed(2)} VES</strong></span>
                  <span>·</span>
                  <span>Piso estimado: <strong className="text-[#02c076]">{advice.projectedTroughRate.toFixed(2)} VES</strong></span>
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
                <span className={`text-[10px] font-bold uppercase font-mono ${pressure.dominantSide === 'COMPRA' ? 'text-[#02c076]' : pressure.dominantSide === 'VENTA' ? 'text-[#cf304a]' : 'text-[#FCD535]'}`}>
                  {pressure.dominantSide}
                </span>
              </div>

              {/* Progress bar */}
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
                  <span className="text-[#02c076] font-bold">Compra: {pressure.buyPressurePct}% ({pressure.buyVolumeUsdt.toLocaleString()} USDT)</span>
                  <span className="text-[#cf304a] font-bold">Venta: {pressure.sellPressurePct}% ({pressure.sellVolumeUsdt.toLocaleString()} USDT)</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4 Primary Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Card 1: 1. Tasa Real Actual */}
        <div id="card-current-rate" className="bg-[#181a20] border border-[#2b2f36] p-5 rounded-lg relative overflow-hidden">
          <div className="flex items-center justify-between text-xs mb-3">
            <span className="text-[10px] uppercase text-[#848e9c] font-bold tracking-wider">1. Tasa Real Actual</span>
            <span className="flex items-center gap-1 text-[10px] text-[#02c076] font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-[#02c076] animate-pulse" />
              P2P LIVE ({ageSeconds.toFixed(0)}s)
            </span>
          </div>

          <div className="mt-1">
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-black font-mono tracking-tight text-[#FCD535] leading-none">
                {snapshot.bestBuyPrice.toFixed(2)}
              </span>
              <span className="text-xs font-semibold text-[#848e9c]">VES/USDT</span>
            </div>
            <div className="flex items-center justify-between text-xs mt-4 pt-3 border-t border-[#2b2f36] text-[#848e9c]">
              <span>Venta: <strong className="text-[#FCD535] font-mono">{snapshot.bestSellPrice.toFixed(2)}</strong></span>
              <span>Spread: <strong className="text-[#e0e0e0] font-mono">{snapshot.spreadPercentage.toFixed(2)}%</strong></span>
            </div>
          </div>
        </div>

        {/* Card 2: 2 & 3. Tendencia & Dirección */}
        <div id="card-trend" className="bg-[#181a20] border border-[#2b2f36] p-5 rounded-lg relative">
          <div className="flex items-center justify-between text-xs mb-3">
            <span className="text-[10px] uppercase text-[#848e9c] font-bold tracking-wider">2 & 3. Tendencia & Dirección</span>
            <span className="text-[10px] text-[#848e9c] font-mono">
              Fuerza: {analysis?.trendStrength || 50}%
            </span>
          </div>

          <div className="mt-1 flex items-center justify-between">
            <div>
              <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-bold border ${getTrendColor(analysis?.trend)}`}>
                {getTrendIcon(analysis?.trend)}
                <span>{analysis?.trend || 'LATERAL'}</span>
              </div>
              <p className="text-xs text-[#848e9c] mt-3 font-mono">
                Momentum: <strong className="text-[#e0e0e0]">{analysis?.momentum || 'NEUTRO'}</strong>
              </p>
            </div>
            <div className="text-right text-xs">
              <span className="text-[10px] uppercase text-[#848e9c] block">vs Media SMA:</span>
              <span className={`font-mono font-bold text-sm ${(analysis?.priceVsSmaPct || 0) >= 0 ? 'text-[#02c076]' : 'text-[#cf304a]'}`}>
                {(analysis?.priceVsSmaPct || 0) >= 0 ? '+' : ''}{analysis?.priceVsSmaPct || 0}%
              </span>
            </div>
          </div>
        </div>

        {/* Card 3: 5 & 6. Rango Esperado del Día */}
        <div id="card-expected-range" className="bg-[#181a20] border border-[#2b2f36] p-5 rounded-lg relative">
          <div className="flex items-center justify-between text-xs mb-3">
            <span className="text-[10px] uppercase text-[#848e9c] font-bold tracking-wider">5 & 6. Rango del Día (VES)</span>
            <span className="text-[10px] text-[#FCD535] font-mono">
              Confianza: {projections?.daily.confidencePct || 65}%
            </span>
          </div>

          <div className="mt-1">
            <div className="text-xl font-bold font-mono text-[#FCD535] leading-tight">
              {projections?.daily.floor.toFixed(2)} — {projections?.daily.ceiling.toFixed(2)} <span className="text-xs text-[#848e9c]">VES</span>
            </div>
            <div className="flex items-center justify-between text-xs mt-4 pt-3 border-t border-[#2b2f36] text-[#848e9c]">
              <span>Piso: <strong className="text-[#02c076] font-mono">{projections?.daily.floor.toFixed(2)}</strong></span>
              <span>Techo: <strong className="text-[#FCD535] font-mono">{projections?.daily.ceiling.toFixed(2)}</strong></span>
            </div>
          </div>
        </div>

        {/* Card 4: 7 & 8. Riesgo & Probabilidad */}
        <div id="card-risk-level" className="bg-[#181a20] border border-[#2b2f36] p-5 rounded-lg relative">
          <div className="flex items-center justify-between text-xs mb-3">
            <span className="text-[10px] uppercase text-[#848e9c] font-bold tracking-wider">7 & 8. Riesgo & Probabilidad</span>
            <span className="text-[10px] font-mono text-[#848e9c]">RSI: {analysis?.rsi || 50}</span>
          </div>

          <div className="mt-1 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5">
                <span className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider ${
                  projections?.risk.level === 'ALTO' ? 'bg-[#472c2c] border border-[#cf304a] text-[#cf304a]' :
                  projections?.risk.level === 'MEDIO' ? 'bg-[#FCD535]/15 border border-[#FCD535]/40 text-[#FCD535]' :
                  'bg-[#02c076]/15 border border-[#02c076]/40 text-[#02c076]'
                }`}>
                  RIESGO {projections?.risk.level || 'BAJO'}
                </span>
              </div>
              <p className="text-xs text-[#848e9c] mt-3 font-mono">
                Volatilidad: <strong className="text-[#e0e0e0]">{analysis?.volatility || 'MEDIA'}</strong>
              </p>
            </div>

            <div className="text-right text-xs">
              <span className="text-[10px] uppercase text-[#848e9c] block">Más Probable:</span>
              <span className="font-bold text-[#e0e0e0] font-mono">
                {probs.up > probs.down && probs.up > probs.neutral ? '▲ SUBIR' :
                 probs.down > probs.up && probs.down > probs.neutral ? '▼ BAJAR' : '■ MANTENER'}
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
            <div className={`p-3.5 rounded border transition ${probs.up >= 45 ? 'bg-[#111417] border-[#02c076]' : 'bg-[#111417] border-[#2b2f36]'}`}>
              <div className="flex items-center justify-between text-xs text-[#848e9c] mb-1">
                <span className="font-bold text-[#02c076] flex items-center gap-1 text-[11px]">
                  <ArrowUpRight className="w-3.5 h-3.5" /> SUBIR
                </span>
                <span className="text-[10px] uppercase font-mono">Alcista</span>
              </div>
              <div className="text-2xl font-bold font-mono text-[#02c076]">{probs.up}%</div>
              <div className="w-full bg-[#2b2f36] h-1.5 rounded-full mt-2 overflow-hidden">
                <div className="bg-[#02c076] h-full rounded-full transition-all duration-500" style={{ width: `${probs.up}%` }} />
              </div>
            </div>

            {/* MANTENER */}
            <div className={`p-3.5 rounded border transition ${probs.neutral >= 45 ? 'bg-[#111417] border-[#FCD535]' : 'bg-[#111417] border-[#2b2f36]'}`}>
              <div className="flex items-center justify-between text-xs text-[#848e9c] mb-1">
                <span className="font-bold text-[#FCD535] flex items-center gap-1 text-[11px]">
                  <Minus className="w-3.5 h-3.5" /> MANTENER
                </span>
                <span className="text-[10px] uppercase font-mono">Lateral</span>
              </div>
              <div className="text-2xl font-bold font-mono text-[#FCD535]">{probs.neutral}%</div>
              <div className="w-full bg-[#2b2f36] h-1.5 rounded-full mt-2 overflow-hidden">
                <div className="bg-[#FCD535] h-full rounded-full transition-all duration-500" style={{ width: `${probs.neutral}%` }} />
              </div>
            </div>

            {/* BAJAR */}
            <div className={`p-3.5 rounded border transition ${probs.down >= 45 ? 'bg-[#111417] border-[#cf304a]' : 'bg-[#111417] border-[#2b2f36]'}`}>
              <div className="flex items-center justify-between text-xs text-[#848e9c] mb-1">
                <span className="font-bold text-[#cf304a] flex items-center gap-1 text-[11px]">
                  <ArrowDownRight className="w-3.5 h-3.5" /> BAJAR
                </span>
                <span className="text-[10px] uppercase font-mono">Bajista</span>
              </div>
              <div className="text-2xl font-bold font-mono text-[#cf304a]">{probs.down}%</div>
              <div className="w-full bg-[#2b2f36] h-1.5 rounded-full mt-2 overflow-hidden">
                <div className="bg-[#cf304a] h-full rounded-full transition-all duration-500" style={{ width: `${probs.down}%` }} />
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
                  <div className="font-mono text-xs font-bold text-[#e0e0e0] mt-1">{h.projectedBuy.toFixed(2)}</div>
                  <div className="text-[9px] text-[#848e9c] font-mono mt-0.5">
                    {h.rangeMin.toFixed(1)} - {h.rangeMax.toFixed(1)}
                  </div>
                  <div className="text-[9px] text-[#02c076] font-medium mt-1 font-mono">Conf: {h.confidence}%</div>
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
