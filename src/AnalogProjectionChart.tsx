/**
 * PASADO REAL, PRESENTE, Y FUTURO PROYECTADO — SIN QUE SE CONFUNDAN.
 *
 * Lo que este componente tiene que hacer imposible es que alguien lea un
 * precio proyectado creyendo que ocurrió. Por eso:
 *
 *   - El tramo real es una línea CONTINUA y sólida.
 *   - El tramo proyectado es una línea DISCONTINUA, y sólo existe a la derecha
 *     de una línea vertical marcada "AHORA".
 *   - La franja del rango probable sombrea únicamente el futuro.
 *   - El fondo del futuro va tintado, y la leyenda lo nombra.
 *
 * El escenario central se dibuja como línea porque es lo que se pidió; la
 * banda va SIEMPRE con él, y su anchura es la incertidumbre. Una línea sola
 * afirmaría una precisión que estos datos no tienen.
 *
 * Este componente NO CALCULA NADA. Cada punto del futuro viene de un horizonte
 * que el servidor publicó con sus análogos detrás; los horizontes que dijeron
 * INSUFICIENTE HISTÓRICO sencillamente no se dibujan.
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
import { AnalogSideProjection } from './types';

interface Props {
  projection: AnalogSideProjection;
}

const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });

interface Row {
  timestamp: number;
  real?: number;
  central?: number;
  /* [suelo, techo] del rango probable. Ausente en el pasado, a propósito. */
  band?: [number, number];
}

export const AnalogProjectionChart: React.FC<Props> = ({ projection }) => {
  const history = projection.history.filter((p) => Number.isFinite(p.price));
  const publishable = projection.horizons.filter(
    (h) => h.available && h.central !== null && h.low !== null && h.high !== null
  );

  if (history.length < 2) {
    return (
      <div className="text-[10px] text-[#848e9c] border border-dashed border-[#2b2f36] rounded p-3 text-center">
        Serie demasiado corta para dibujar. El histórico se acumula desde la primera captura.
      </div>
    );
  }

  const now = history[history.length - 1].t;
  const currentPrice = history[history.length - 1].price;

  const rows: Row[] = history.map((p) => ({ timestamp: p.t, real: p.price }));

  /*
   * El presente pertenece a las dos partes: es el último dato real y el punto
   * de partida del escenario central. Sin este empalme la proyección arrancaría
   * despegada de la serie y parecería un salto que nadie observó.
   */
  if (publishable.length > 0) {
    rows[rows.length - 1] = {
      ...rows[rows.length - 1],
      central: currentPrice,
      band: [currentPrice, currentPrice],
    };

    for (const horizon of publishable) {
      rows.push({
        timestamp: now + horizon.requestedHorizonMs,
        central: horizon.central as number,
        band: [horizon.low as number, horizon.high as number],
      });
    }
  }

  const lastFuture = rows[rows.length - 1].timestamp;

  return (
    <div className="w-full h-64">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="#2b2f36" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="timestamp"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={clock}
            tick={{ fill: '#848e9c', fontSize: 10 }}
            stroke="#2b2f36"
          />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fill: '#848e9c', fontSize: 10 }}
            stroke="#2b2f36"
            width={62}
            tickFormatter={(v: number) => v.toFixed(2)}
          />
          <Tooltip
            contentStyle={{
              background: '#181a20',
              border: '1px solid #2b2f36',
              borderRadius: 4,
              fontSize: 11,
            }}
            labelFormatter={(label) => {
              const ts = Number(label);
              if (!Number.isFinite(ts)) return '';
              return ts > now ? `${clock(ts)} · PROYECCIÓN` : `${clock(ts)} · observado`;
            }}
            formatter={(value: any, name: any) => {
              if (name === 'band' && Array.isArray(value)) {
                return [`${value[0].toFixed(2)} – ${value[1].toFixed(2)}`, 'Rango probable'];
              }
              const label = name === 'real' ? 'Precio observado' : 'Escenario central';
              return [typeof value === 'number' ? value.toFixed(2) : value, label];
            }}
          />

          {publishable.length > 0 && (
            <ReferenceArea
              x1={now}
              x2={lastFuture}
              fill="#f0b90b"
              fillOpacity={0.05}
              stroke="none"
            />
          )}

          <Area
            dataKey="band"
            stroke="none"
            fill="#f0b90b"
            fillOpacity={0.16}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            dataKey="real"
            stroke="#02c076"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            dataKey="central"
            stroke="#f0b90b"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={{ r: 2, fill: '#f0b90b' }}
            isAnimationActive={false}
            connectNulls={false}
          />

          <ReferenceLine
            x={now}
            stroke="#848e9c"
            strokeDasharray="3 3"
            label={{ value: 'AHORA', fill: '#848e9c', fontSize: 9, position: 'top' }}
          />
        </ComposedChart>
      </ResponsiveContainer>

      <div className="flex flex-wrap gap-4 justify-center mt-1 text-[10px] text-[#848e9c]">
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-[2px] bg-[#02c076]" /> Precio real observado
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 border-t-2 border-dashed border-[#f0b90b]" />
          Escenario central (proyección)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-2 bg-[#f0b90b] opacity-25" /> Rango probable
        </span>
      </div>
    </div>
  );
};
