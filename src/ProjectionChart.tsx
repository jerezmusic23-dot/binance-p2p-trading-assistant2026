/**
 * THE CHART: real history, then a projected BAND — never a projected line.
 *
 * THE RULE THIS COMPONENT ENFORCES VISUALLY
 *
 * A projection is uncertain, so it is drawn as an area with a width, not as a
 * line with a value. Drawing it as a line would claim a precision the data
 * does not have, and a reader would take the last point of that line as a
 * price. The band's edges are the 10th and 90th percentile of moves this cell
 * actually made over the same horizon; its width IS the uncertainty.
 *
 * The real series and the projection are separated by a marked boundary and
 * drawn in different styles. Nothing to the right of that line ever happened.
 *
 * This component computes NOTHING: the band comes from the server's projection
 * and the points come from the stored series, unsmoothed. A gap in capture is
 * drawn as a gap.
 */

import React from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { SeriesPoint, SideProjection } from './types';

interface ProjectionChartProps {
  observations: SeriesPoint[];
  projection: SideProjection;
  /** Which price the chart draws. Both are maker prices. */
  side: 'BUY' | 'SELL';
}

const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });

export const ProjectionChart: React.FC<ProjectionChartProps> = ({
  observations,
  projection,
  side,
}) => {
  const priceOf = (point: SeriesPoint) =>
    side === 'BUY' ? point.buyRecommendedPrice : point.sellRecommendedPrice;

  const real = observations
    .filter((point) => priceOf(point) !== null)
    .map((point) => ({
      timestamp: point.timestamp,
      price: priceOf(point) as number,
      /* Undefined, not null: recharts must not draw the band over history. */
      bandLow: undefined as number | undefined,
      bandHigh: undefined as number | undefined,
    }));

  if (real.length < 2) {
    return (
      <div className="text-[10px] text-[#848e9c] border border-dashed border-[#2b2f36] rounded p-3 text-center">
        Serie demasiado corta para dibujar. Cada celda acumula su histórico desde su primera
        captura.
      </div>
    );
  }

  const range = projection.projectedRange;
  const last = real[real.length - 1];
  const cadence =
    real.length > 1
      ? (last.timestamp - real[0].timestamp) / (real.length - 1)
      : 300_000;

  /*
   * The projection is drawn as a widening band from the live price out to the
   * horizon. It widens because uncertainty grows with distance, and the far
   * edge is exactly the observed 10-90 range - not an extrapolation of it.
   */
  const projected: typeof real = [];
  if (range.low !== null && range.high !== null && projection.currentPrice !== null) {
    const steps = Math.max(1, range.stepsAhead);
    for (let i = 0; i <= steps; i += 1) {
      const share = i / steps;
      projected.push({
        timestamp: last.timestamp + i * cadence,
        price: undefined as unknown as number,
        bandLow: projection.currentPrice + (range.low - projection.currentPrice) * share,
        bandHigh: projection.currentPrice + (range.high - projection.currentPrice) * share,
      });
    }
    // Anchor the band to the last real point so it starts where history ends.
    projected[0].bandLow = projection.currentPrice;
    projected[0].bandHigh = projection.currentPrice;
  }

  const data = [...real, ...projected];
  const prices = real.map((point) => point.price);
  const lows = [...prices, ...(range.low !== null ? [range.low] : [])];
  const highs = [...prices, ...(range.high !== null ? [range.high] : [])];
  const pad = (Math.max(...highs) - Math.min(...lows)) * 0.1 || 0.5;

  const zones = side === 'BUY' ? projection : projection;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[9px] text-[#848e9c]">
        <span>
          <span className="inline-block w-3 border-t border-[#FCD535] align-middle mr-1" />
          Histórico real ({real.length} obs.)
        </span>
        <span>
          <span className="inline-block w-3 h-2 bg-[#f0b90b]/25 align-middle mr-1" />
          {range.low === null
            ? 'Sin proyección: muestras insuficientes'
            : `Proyectado · rango observado (${range.sampleSize} muestras)`}
        </span>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="#2b2f36" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={clock}
            tick={{ fill: '#5e6673', fontSize: 9 }}
            stroke="#2b2f36"
          />
          <YAxis
            domain={[Math.min(...lows) - pad, Math.max(...highs) + pad]}
            tickFormatter={(v: number) => v.toFixed(2)}
            tick={{ fill: '#5e6673', fontSize: 9 }}
            stroke="#2b2f36"
            width={52}
          />
          <Tooltip
            contentStyle={{
              background: '#181a20',
              border: '1px solid #2b2f36',
              fontSize: 11,
            }}
            labelFormatter={(label) => {
              const ts = Number(label);
              // The tooltip states which side of "now" the reader is on, so a
              // projected value can never be mistaken for an observed one.
              return ts > last.timestamp ? `${clock(ts)} · PROYECTADO` : `${clock(ts)} · real`;
            }}
            formatter={(value, name) => [
              typeof value === 'number' ? value.toFixed(2) : String(value),
              name === 'price'
                ? 'Precio real'
                : name === 'bandHigh'
                ? 'Banda alta (proyectada)'
                : 'Banda baja (proyectada)',
            ]}
          />

          {/* Observed zones: where the series actually turned. */}
          {zones.nextCeiling !== null && (
            <ReferenceArea
              y1={zones.nextCeiling.low}
              y2={zones.nextCeiling.high}
              fill="#f6465d"
              fillOpacity={0.12}
            />
          )}
          {zones.nextFloor !== null && (
            <ReferenceArea
              y1={zones.nextFloor.low}
              y2={zones.nextFloor.high}
              fill="#02c076"
              fillOpacity={0.12}
            />
          )}

          {/* Everything right of this line has not happened. */}
          <ReferenceLine
            x={last.timestamp}
            stroke="#848e9c"
            strokeDasharray="3 3"
            label={{ value: 'ahora', fill: '#848e9c', fontSize: 9, position: 'top' }}
          />

          {/* The band, drawn as an area because its WIDTH is the message. */}
          <Area
            dataKey="bandHigh"
            stroke="none"
            fill="#f0b90b"
            fillOpacity={0.22}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Area
            dataKey="bandLow"
            stroke="none"
            fill="#181a20"
            fillOpacity={1}
            connectNulls={false}
            isAnimationActive={false}
          />

          {/* The real series. connectNulls stays false so gaps stay gaps. */}
          <Line
            dataKey="price"
            stroke="#FCD535"
            strokeWidth={1.5}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>

      <p className="text-[9px] text-[#5e6673] leading-tight">
        La banda no es una predicción de precio: es el rango entre los percentiles 10 y 90 de los
        movimientos que esta celda realmente hizo a esa distancia. Se ensancha porque la
        incertidumbre crece. Nada a la derecha de «ahora» ha ocurrido.
      </p>
    </div>
  );
};
