import React, { useState } from 'react';
import { MarketSnapshot, MarketProjections, MarketAnalysis, HourlyChartPoint } from './types';
import { ProvenanceTag, InsufficientDataNotice } from './ProvenanceTag';
import { fmt, fmtPct, fmtSignedPct, fmtText, NO_DATA } from './format';
import {
  CHART_GEOMETRY,
  buildTimelinePaths,
  computeScale,
  getX as scaleX,
  getY as scaleY,
} from './chartPaths';
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

  /*
   * C1: puntos que el motor presenta como observaciones pasadas pero que en
   * realidad sintetizó con la curva horaria codificada a mano. Se cuentan y se
   * declaran; C2 los convertirá en huecos reales del gráfico.
   */
  const observedPointsCount = timeline.filter(
    (pt) => !pt.isProjected && pt.buyPrice !== null
  ).length;
  const missingPointsCount = timeline.filter(
    (pt) => !pt.isProjected && pt.buyPrice === null
  ).length;
  const quedaPorVenirPct = Math.round((remainingPointsCount / Math.max(1, timeline.length)) * 100);

  // Market status label
  const marketStatus = `${fmtText(analysis?.trend)} ${fmtSignedPct(analysis?.priceVsSmaPct)}`;

  /*
   * Geometry and path construction live in ./chartPaths as pure functions so
   * the null handling is unit-testable without a DOM.
   */
  const scale = computeScale(timeline, floor, ceiling);
  const { minVal, maxVal, valRange } = scale;

  const { svgWidth, svgHeight, paddingX, paddingY, chartW, chartH } = CHART_GEOMETRY;

  const getX = (index: number) => scaleX(index, timeline.length, CHART_GEOMETRY);
  const getY = (val: number | null | undefined) => scaleY(val, scale, CHART_GEOMETRY);

  const {
    realVenta: realVentaPath,
    realRecompra: realRecompraPath,
    projVenta: projVentaPath,
    projRecompra: projRecompraPath,
  } = buildTimelinePaths(timeline, scale, CHART_GEOMETRY);

  return (
    <div id="daily-fluctuation-container" className="space-y-4">
      {!projections.hasSufficientData && (
        <InsufficientDataNotice reason={projections.insufficientDataReason} />
      )}

      {missingPointsCount > 0 && (
        <InsufficientDataNotice
          reason={
            `${missingPointsCount} de las ${pastPointsCount} horas pasadas no tienen ningún tick ` +
            `capturado. Aparecen como huecos en el gráfico, no como precios. Sólo ` +
            `${observedPointsCount} hora(s) corresponden a observaciones reales.`
          }
        />
      )}

      <div className="flex flex-wrap items-center gap-3 text-[10px] font-mono text-[#848e9c]">
        <span className="flex items-center gap-1">
          <ProvenanceTag provenance="REAL" /> tick almacenado
        </span>
        <span className="flex items-center gap-1">
          <ProvenanceTag provenance="PROJECTED" /> extrapolación
        </span>
        <span className="flex items-center gap-1">
          {NO_DATA} hora sin captura (hueco real)
        </span>
        <span className="ml-auto">
          Ventana: {projections.dataWindow.sampleCount} obs.
          {projections.dataWindow.spanMinutes !== null &&
            ` (${projections.dataWindow.spanMinutes} min)`}
        </span>
      </div>

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
                {/*
                  * C2: the old figure was (techo - piso) * 1000, i.e. the whole
                  * projected range presented as net profit, with no fees,
                  * slippage or liquidity. There is no cost model yet.
                  */}
                <span className="text-base font-bold font-mono text-[#848e9c]" title="Requiere un modelo de costes: comisiones, slippage, liquidez y límites de la oferta.">
                  {NO_DATA} <span className="text-[10px] text-[#848e9c]">VES</span>
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
              {fmt(ceiling)}
            </div>
          </div>

          {/* 2. PISO DEL DÍA */}
          <div className="space-y-1">
            <span className="text-[10px] font-bold tracking-wider text-[#848e9c] uppercase">PISO DEL DÍA</span>
            <div className="text-2xl font-bold font-mono text-[#02c076]">
              {fmt(floor)}
            </div>
          </div>

          {/* 3. SPREAD MÁXIMO */}
          <div className="space-y-1">
            <span className="text-[10px] font-bold tracking-wider text-[#848e9c] uppercase">SPREAD MÁXIMO</span>
            <div className="text-2xl font-bold font-mono text-[#e0e0e0]">
              {fmtPct(spreadMax)}
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
              Venta: <strong className="text-[#FCD535] font-mono">{fmt(selectedPoint.sellPrice ?? selectedPoint.projectedSell)}</strong> |
              Recompra: <strong className="text-[#02c076] font-mono">{fmt(selectedPoint.buyPrice ?? selectedPoint.projectedBuy)}</strong>
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
                    {/* Venta Node - C2: no circle where there is no price. */}
                    {sellY !== null && (
                      <circle
                        cx={x}
                        cy={sellY}
                        r={isProjected ? 3.5 : 4.5}
                        fill={isProjected ? '#181a20' : '#FCD535'}
                        stroke="#FCD535"
                        strokeWidth="2"
                      />
                    )}

                    {/* Recompra Node */}
                    {buyY !== null && (
                      <circle
                        cx={x}
                        cy={buyY}
                        r={isProjected ? 3.5 : 4.5}
                        fill={isProjected ? '#181a20' : '#02c076'}
                        stroke="#02c076"
                        strokeWidth="2"
                      />
                    )}

                    {/* Top Peak Badge */}
                    {pt.isPeak && sellY !== null && (
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
                          PICO {fmt(pt.sellPrice ?? pt.projectedSell)}
                        </text>
                      </g>
                    )}

                    {/* Bottom Trough Badge */}
                    {pt.isTrough && buyY !== null && (
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
                          RETROCESO {fmt(pt.buyPrice ?? pt.projectedBuy)}
                        </text>
                      </g>
                    )}

                    {/* Numeric Price Tag for projected hours */}
                    {isProjected && sellY !== null && (
                      <text
                        x={x}
                        y={sellY - 8}
                        textAnchor="middle"
                        fill="#FCD535"
                        fontSize="9"
                        fontFamily="monospace"
                      >
                        {fmt(pt.projectedSell, 1)}
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
              /*
               * C2: the old code was `pt.sellPrice || pt.projectedSell || 918`,
               * which invented a price for every hour without data and then
               * drew a variation bar from it. With no pair of consecutive
               * prices there is no variation to draw.
               */
              const currentPrice = pt.sellPrice ?? pt.projectedSell ?? null;
              const prev = timeline[i - 1];
              const prevPrice = prev ? prev.sellPrice ?? prev.projectedSell ?? null : null;

              const delta =
                currentPrice !== null && prevPrice !== null && prevPrice !== 0
                  ? ((currentPrice - prevPrice) / prevPrice) * 100
                  : null;

              const barHeight = delta === null ? 0 : Math.min(22, Math.max(4, Math.abs(delta) * 50));
              const isPositive = delta !== null && delta >= 0;

              return (
                <div key={i} className="flex flex-col items-center justify-center h-full">
                  <div className="w-full flex items-center justify-center h-8 relative">
                    {delta === null ? (
                      <span
                        className="text-[9px] font-mono text-[#848e9c]"
                        title={`${pt.label}: sin datos para calcular la variación.`}
                      >
                        {NO_DATA}
                      </span>
                    ) : isPositive ? (
                      <div
                        className="w-3 bg-[#FCD535] rounded-xs"
                        style={{ height: `${barHeight}px`, transform: 'translateY(-50%)' }}
                        title={`${pt.label}: ${fmtSignedPct(delta)}`}
                      />
                    ) : (
                      <div
                        className="w-3 bg-[#02c076] rounded-xs"
                        style={{ height: `${barHeight}px`, transform: 'translateY(50%)' }}
                        title={`${pt.label}: ${fmtSignedPct(delta)}`}
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
            <span>· Los puntos proyectados son extrapolaciones heurísticas; su precisión no está medida todavía.</span>
          </div>
        </div>
      </div>
    </div>
  );
};
