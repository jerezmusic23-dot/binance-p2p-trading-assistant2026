import React, { useState } from 'react';
import { MarketSnapshot, MarketProjections, MarketAnalysis, HourlyChartPoint } from '../types';
import { Sparkles, Compass, TrendingUp, TrendingDown, Clock, DollarSign, Activity, AlertCircle, CheckCircle2 } from 'lucide-react';

interface DailyFluctuationChartProps {
  snapshot: MarketSnapshot | null;
  projections: MarketProjections | null;
  analysis: MarketAnalysis | null;
}

export const DailyFluctuationChart: React.FC<DailyFluctuationChartProps> = ({
  snapshot,
  projections,
  analysis,
}) => {
  const [selectedPoint, setSelectedPoint] = useState<HourlyChartPoint | null>(null);

  if (!snapshot || !projections) {
    return (
      <div className="p-8 text-center bg-[#181a20] rounded-lg border border-[#2b2f36]">
        <div className="w-8 h-8 border-2 border-[#FCD535] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-[#848e9c]">Cargando proyección y modelo de fluctuación en tiempo real...</p>
      </div>
    );
  }

  const timeline = projections.hourlyTimeline || [];
  const currentPt = timeline.find((pt) => !pt.isProjected && pt.sellPrice !== null) || timeline[0];

  // Determine market metrics
  const ceiling = projections.daily.ceiling;
  const floor = projections.daily.floor;
  const spreadMax = projections.daily.spreadMaxExpected;
  const advice = projections.merchantAdvice;

  // Calculate percentage of day remaining based on timeline
  const pastPointsCount = timeline.filter((pt) => !pt.isProjected).length;
  const remainingPointsCount = timeline.filter((pt) => pt.isProjected).length;
  const quedaPorVenirPct = Math.round((remainingPointsCount / Math.max(1, timeline.length)) * 100);

  // Market status label
  const marketStatus = `${analysis?.trend || 'LATERAL'} ${(analysis?.priceVsSmaPct || 0) >= 0 ? '+' : ''}${analysis?.priceVsSmaPct || 0}%`;

  // Scale calculations for custom SVG chart
  const allPrices: number[] = [];
  timeline.forEach((pt) => {
    if (pt.sellPrice) allPrices.push(pt.sellPrice);
    if (pt.buyPrice) allPrices.push(pt.buyPrice);
    if (pt.projectedSell) allPrices.push(pt.projectedSell);
    if (pt.projectedBuy) allPrices.push(pt.projectedBuy);
  });
  if (ceiling) allPrices.push(ceiling);
  if (floor) allPrices.push(floor);

  const minVal = allPrices.length > 0 ? Math.min(...allPrices) * 0.996 : 900;
  const maxVal = allPrices.length > 0 ? Math.max(...allPrices) * 1.004 : 930;
  const valRange = Math.max(0.5, maxVal - minVal);

  const svgWidth = 960;
  const svgHeight = 360;
  const paddingX = 45;
  const paddingY = 40;
  const chartW = svgWidth - paddingX * 2;
  const chartH = svgHeight - paddingY * 2;

  const getX = (index: number) => {
    return paddingX + (index / Math.max(1, timeline.length - 1)) * chartW;
  };

  const getY = (val: number | null | undefined) => {
    if (val === null || val === undefined) return chartH / 2 + paddingY;
    const ratio = (val - minVal) / valRange;
    return paddingY + chartH - ratio * chartH;
  };

  // Generate SVG path strings for Real Venta, Real Recompra, Projected Venta, Projected Recompra
  let realVentaPath = '';
  let realRecompraPath = '';
  let projVentaPath = '';
  let projRecompraPath = '';

  let lastRealIndex = -1;
  timeline.forEach((pt, i) => {
    if (!pt.isProjected) {
      lastRealIndex = i;
      const x = getX(i);
      const ySell = getY(pt.sellPrice);
      const yBuy = getY(pt.buyPrice);

      realVentaPath += realVentaPath === '' ? `M ${x} ${ySell}` : ` L ${x} ${ySell}`;
      realRecompraPath += realRecompraPath === '' ? `M ${x} ${yBuy}` : ` L ${x} ${yBuy}`;
    }
  });

  // Projection paths continuing from the last real point
  if (lastRealIndex >= 0 && lastRealIndex < timeline.length - 1) {
    const startX = getX(lastRealIndex);
    const startSellY = getY(timeline[lastRealIndex].sellPrice);
    const startBuyY = getY(timeline[lastRealIndex].buyPrice);

    projVentaPath = `M ${startX} ${startSellY}`;
    projRecompraPath = `M ${startX} ${startBuyY}`;

    for (let i = lastRealIndex + 1; i < timeline.length; i++) {
      const pt = timeline[i];
      const x = getX(i);
      const ySell = getY(pt.projectedSell);
      const yBuy = getY(pt.projectedBuy);

      projVentaPath += ` L ${x} ${ySell}`;
      projRecompraPath += ` L ${x} ${yBuy}`;
    }
  }

  return (
    <div id="daily-fluctuation-container" className="space-y-4">
      {/* Strategic Decision & Forward-Looking Forecast Banner */}
      {advice && (
        <div id="merchant-decision-banner" className="bg-[#181a20] border-2 border-[#FCD535]/40 rounded-lg p-5 relative overflow-hidden shadow-lg">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 border-b border-[#2b2f36] pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#FCD535]/15 border border-[#FCD535]/50 flex items-center justify-center text-[#FCD535]">
                <Compass className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-[#FCD535] text-black font-mono">
                    PLAN DE ACCIÓN SUGERIDO
                  </span>
                  <span className="text-xs font-mono text-[#02c076] flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-[#02c076] animate-pulse" />
                    En Vivo
                  </span>
                </div>
                <h3 className="text-base font-bold text-[#e0e0e0] mt-1">
                  {advice.actionTitle}
                </h3>
              </div>
            </div>

            {/* Quick action timing windows */}
            <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
              <div className="bg-[#111417] border border-[#2b2f36] px-3 py-1.5 rounded">
                <span className="text-[#848e9c] text-[10px] uppercase block">Ventana Venta Óptima</span>
                <span className="text-[#FCD535] font-bold">{advice.optimalSellTimeWindow}</span>
              </div>
              <div className="bg-[#111417] border border-[#2b2f36] px-3 py-1.5 rounded">
                <span className="text-[#848e9c] text-[10px] uppercase block">Ventana Recompra Óptima</span>
                <span className="text-[#02c076] font-bold">{advice.optimalBuyTimeWindow}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 text-xs">
            {/* Explanation */}
            <div className="md:col-span-2 text-[#848e9c] leading-relaxed flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-[#02c076] shrink-0 mt-0.5" />
              <p className="text-xs text-[#e0e0e0]">
                {advice.actionExplanation}
              </p>
            </div>

            {/* Net Opportunity */}
            <div className="bg-[#111417] border border-[#2b2f36] p-3 rounded flex items-center justify-between">
              <div>
                <span className="text-[10px] text-[#848e9c] uppercase tracking-wider block">Margen x $1,000 USDT</span>
                <span className="text-base font-bold font-mono text-[#02c076]">
                  +{advice.estimatedNetProfitPer1000UsdtVes.toLocaleString('es-VE', { minimumFractionDigits: 2 })} <span className="text-[10px] text-[#848e9c]">VES</span>
                </span>
              </div>
              <DollarSign className="w-6 h-6 text-[#02c076]/40" />
            </div>
          </div>
        </div>
      )}

      {/* Top Header & Key Metrics matching Technical Dashboard */}
      <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 border-b border-[#2b2f36] pb-4">
          <div>
            <h2 className="text-xs uppercase text-[#848e9c] font-bold tracking-wider flex items-center gap-2">
              <Compass className="w-4 h-4 text-[#FCD535]" />
              PROYECCIÓN DE FLUCTUACIÓN DIARIA (SESIÓN VENEZUELA 8:00 AM - 8:00 PM)
            </h2>
            <p className="text-[11px] text-[#848e9c] font-mono mt-0.5">
              Línea continua = datos reales Binance P2P · Línea punteada = proyección probabilística · VES
            </p>
          </div>

          {/* Quick Guidance Pill */}
          <div className="flex items-center gap-2 bg-[#111417] border border-[#2b2f36] px-3 py-1.5 rounded text-xs">
            <Sparkles className="w-3.5 h-3.5 text-[#FCD535]" />
            <span className="text-[#848e9c] font-mono text-[11px]">
              Zona horaria VET (Caracas) · {pastPointsCount}h registradas · {remainingPointsCount}h proyectadas
            </span>
          </div>
        </div>

        {/* The 6 Big Metrics Row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 pt-4">
          {/* 1. TECHO DEL DÍA */}
          <div className="space-y-1">
            <span className="text-[10px] font-bold tracking-wider text-[#848e9c] uppercase">TECHO DEL DÍA</span>
            <div className="text-2xl font-bold font-mono text-[#FCD535]">
              {ceiling.toFixed(2)}
            </div>
          </div>

          {/* 2. PISO DEL DÍA */}
          <div className="space-y-1">
            <span className="text-[10px] font-bold tracking-wider text-[#848e9c] uppercase">PISO DEL DÍA</span>
            <div className="text-2xl font-bold font-mono text-[#02c076]">
              {floor.toFixed(2)}
            </div>
          </div>

          {/* 3. SPREAD MÁXIMO */}
          <div className="space-y-1">
            <span className="text-[10px] font-bold tracking-wider text-[#848e9c] uppercase">SPREAD MÁXIMO</span>
            <div className="text-2xl font-bold font-mono text-[#e0e0e0]">
              {spreadMax.toFixed(2)}%
            </div>
          </div>

          {/* 4. MERCADO */}
          <div className="space-y-1">
            <span className="text-[10px] font-bold tracking-wider text-[#848e9c] uppercase">MERCADO</span>
            <div className="text-base font-bold text-[#e0e0e0] font-mono uppercase">
              {marketStatus}
            </div>
          </div>

          {/* 5. AHORA */}
          <div className="space-y-1">
            <span className="text-[10px] font-bold tracking-wider text-[#848e9c] uppercase">ESTADO EN VIVO</span>
            <div className="text-base font-bold text-[#02c076] font-mono uppercase">
              {analysis?.momentum === 'ALTO' ? 'EN PICO' : analysis?.momentum === 'NEGATIVO' ? 'EN RETROCESO' : 'EN CANAL'}
            </div>
          </div>

          {/* 6. QUEDA POR VENIR */}
          <div className="space-y-1">
            <span className="text-[10px] font-bold tracking-wider text-[#848e9c] uppercase">QUEDA POR VENIR</span>
            <div className="text-2xl font-bold font-mono text-[#FCD535]">
              {quedaPorVenirPct}%
            </div>
          </div>
        </div>
      </div>

      {/* Main SVG Interactive Chart */}
      <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5 relative overflow-hidden">
        {/* Chart Legend */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4 text-xs font-mono">
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-1.5 text-[#FCD535]">
              <span className="w-4 h-0.5 bg-[#FCD535] rounded-full" />
              <span className="text-[#848e9c]">Tasa de venta USDT (Vender)</span>
            </div>
            <div className="flex items-center gap-1.5 text-[#02c076]">
              <span className="w-4 h-0.5 bg-[#02c076] rounded-full" />
              <span className="text-[#848e9c]">Tasa de recompra USDT (Comprar)</span>
            </div>
            <div className="flex items-center gap-1.5 text-[#848e9c]">
              <span className="w-4 h-0.5 border-t-2 border-dashed border-[#848e9c]" />
              <span>··· Proyección</span>
            </div>
          </div>

          {selectedPoint && (
            <div className="bg-[#111417] px-3 py-1 rounded border border-[#2b2f36] text-[#e0e0e0]">
              Hora: <strong className="text-[#FCD535]">{selectedPoint.label}</strong> |
              Venta: <strong className="text-[#FCD535] font-mono">{(selectedPoint.sellPrice || selectedPoint.projectedSell)?.toFixed(2)}</strong> |
              Recompra: <strong className="text-[#02c076] font-mono">{(selectedPoint.buyPrice || selectedPoint.projectedBuy)?.toFixed(2)}</strong>
            </div>
          )}
        </div>

        {/* Interactive SVG Canvas */}
        <div className="w-full overflow-x-auto">
          <div className="min-w-[800px]">
            <svg
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              className="w-full h-auto select-none"
              style={{ overflow: 'visible' }}
            >
              <defs>
                <linearGradient id="purpleBand" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.02" />
                </linearGradient>
              </defs>

              {/* Background Grid Lines */}
              {[0, 0.25, 0.5, 0.75, 1].map((r, i) => {
                const y = paddingY + chartH * r;
                const price = maxVal - r * valRange;
                return (
                  <g key={i}>
                    <line
                      x1={paddingX}
                      y1={y}
                      x2={svgWidth - paddingX}
                      y2={y}
                      stroke="#2b2f36"
                      strokeDasharray="3 3"
                    />
                    <text
                      x={paddingX - 8}
                      y={y + 4}
                      textAnchor="end"
                      fill="#848e9c"
                      fontSize="10"
                      fontFamily="monospace"
                    >
                      {price.toFixed(1)}
                    </text>
                  </g>
                );
              })}

              {/* Vertical Bands for Peak Hours */}
              {timeline.map((pt, i) => {
                if (pt.isCoincide || pt.isPeak) {
                  const x = getX(i);
                  return (
                    <g key={`band-${i}`}>
                      <rect
                        x={x - 24}
                        y={paddingY}
                        width="48"
                        height={chartH}
                        fill="url(#purpleBand)"
                        rx="4"
                      />
                    </g>
                  );
                }
                return null;
              })}

              {/* Real Curves */}
              {realVentaPath && (
                <path
                  d={realVentaPath}
                  fill="none"
                  stroke="#FCD535"
                  strokeWidth="2.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              {realRecompraPath && (
                <path
                  d={realRecompraPath}
                  fill="none"
                  stroke="#02c076"
                  strokeWidth="2.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}

              {/* Projected Dotted Curves */}
              {projVentaPath && (
                <path
                  d={projVentaPath}
                  fill="none"
                  stroke="#FCD535"
                  strokeWidth="2.2"
                  strokeDasharray="4 4"
                  strokeOpacity="0.85"
                />
              )}
              {projRecompraPath && (
                <path
                  d={projRecompraPath}
                  fill="none"
                  stroke="#02c076"
                  strokeWidth="2.2"
                  strokeDasharray="4 4"
                  strokeOpacity="0.85"
                />
              )}

              {/* Point Markers and Badges */}
              {timeline.map((pt, i) => {
                const x = getX(i);
                const isProjected = pt.isProjected;
                const sellY = getY(isProjected ? pt.projectedSell : pt.sellPrice);
                const buyY = getY(isProjected ? pt.projectedBuy : pt.buyPrice);

                return (
                  <g
                    key={`pt-${i}`}
                    className="cursor-pointer transition hover:opacity-80"
                    onClick={() => setSelectedPoint(pt)}
                  >
                    {/* Venta Node */}
                    <circle
                      cx={x}
                      cy={sellY}
                      r={isProjected ? 3.5 : 4.5}
                      fill={isProjected ? '#181a20' : '#FCD535'}
                      stroke="#FCD535"
                      strokeWidth="2"
                    />

                    {/* Recompra Node */}
                    <circle
                      cx={x}
                      cy={buyY}
                      r={isProjected ? 3.5 : 4.5}
                      fill={isProjected ? '#181a20' : '#02c076'}
                      stroke="#02c076"
                      strokeWidth="2"
                    />

                    {/* Top Peak Badge */}
                    {pt.isPeak && (
                      <g>
                        <rect
                          x={x - 38}
                          y={sellY - 26}
                          width="76"
                          height="18"
                          rx="3"
                          fill="#1e2329"
                          stroke="#FCD535"
                          strokeWidth="1.2"
                        />
                        <text
                          x={x}
                          y={sellY - 14}
                          textAnchor="middle"
                          fill="#FCD535"
                          fontSize="9"
                          fontWeight="bold"
                          fontFamily="monospace"
                        >
                          PICO {(pt.sellPrice || pt.projectedSell)?.toFixed(2)}
                        </text>
                      </g>
                    )}

                    {/* Bottom Trough Badge */}
                    {pt.isTrough && (
                      <g>
                        <rect
                          x={x - 48}
                          y={buyY + 12}
                          width="96"
                          height="18"
                          rx="3"
                          fill="#1e2329"
                          stroke="#02c076"
                          strokeWidth="1.2"
                        />
                        <text
                          x={x}
                          y={buyY + 24}
                          textAnchor="middle"
                          fill="#02c076"
                          fontSize="9"
                          fontWeight="bold"
                          fontFamily="monospace"
                        >
                          RETROCESO {(pt.buyPrice || pt.projectedBuy)?.toFixed(2)}
                        </text>
                      </g>
                    )}

                    {/* Numeric Price Tag for projected hours */}
                    {isProjected && (
                      <text
                        x={x}
                        y={sellY - 8}
                        textAnchor="middle"
                        fill="#FCD535"
                        fontSize="9"
                        fontFamily="monospace"
                      >
                        {pt.projectedSell?.toFixed(1)}
                      </text>
                    )}

                    {/* X-axis Label */}
                    <text
                      x={x}
                      y={paddingY + chartH + 20}
                      textAnchor="middle"
                      fill={!pt.isProjected ? '#FCD535' : '#848e9c'}
                      fontSize="10"
                      fontWeight={!pt.isProjected ? 'bold' : 'normal'}
                      fontFamily="monospace"
                    >
                      {pt.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        {/* Lower Hourly Movement Bars */}
        <div className="mt-8 pt-4 border-t border-[#2b2f36]">
          <div className="flex items-center justify-between text-xs text-[#848e9c] mb-2">
            <span className="font-mono text-[11px] uppercase tracking-wider">Flujo de variación horaria</span>
            <span className="font-mono text-[10px]">±0.2% umbral de giro</span>
          </div>

          <div className="grid grid-cols-13 gap-1 h-14 bg-[#111417] p-2 rounded border border-[#2b2f36] items-center">
            {timeline.map((pt, i) => {
              const currentPrice = pt.sellPrice || pt.projectedSell || 918;
              const prevPrice = (timeline[i - 1]?.sellPrice || timeline[i - 1]?.projectedSell || currentPrice);
              const delta = ((currentPrice - prevPrice) / prevPrice) * 100;

              const isPositive = delta >= 0;
              const barHeight = Math.min(22, Math.max(4, Math.abs(delta) * 50));

              return (
                <div key={i} className="flex flex-col items-center justify-center h-full">
                  <div className="w-full flex items-center justify-center h-8 relative">
                    {isPositive ? (
                      <div
                        className="w-3 bg-[#FCD535] rounded-xs"
                        style={{ height: `${barHeight}px`, transform: 'translateY(-50%)' }}
                        title={`${pt.label}: +${delta.toFixed(2)}%`}
                      />
                    ) : (
                      <div
                        className="w-3 bg-[#02c076] rounded-xs"
                        style={{ height: `${barHeight}px`, transform: 'translateY(50%)' }}
                        title={`${pt.label}: ${delta.toFixed(2)}%`}
                      />
                    )}
                  </div>
                  <span className="text-[9px] font-mono text-[#848e9c]">{pt.label.split(' ')[0]}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Explanatory Footnotes */}
        <div className="mt-4 pt-3 border-t border-[#2b2f36] text-[11px] text-[#848e9c] space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[#FCD535]">▼ Vender USDT (Pico)</span>
            <span className="text-[#02c076]">▲ Recomprar USDT (Piso)</span>
            <span>· Los puntos proyectados estiman la trayectoria intradía con intervalos de confianza del 95%.</span>
          </div>
        </div>
      </div>
    </div>
  );
};
