/**
 * HISTÓRICO Y PROYECCIÓN, SIN QUE SE CONFUNDAN
 * ============================================
 *
 * Lo que este componente tiene que hacer imposible es que alguien lea un
 * precio proyectado creyendo que ocurrió. Por eso:
 *
 *   - El tramo real es una línea CONTINUA y sólida, rotulada HISTÓRICO.
 *   - El tramo proyectado es DISCONTINUO, rotulado PROYECCIÓN, y sólo existe a
 *     la derecha de una vertical marcada AHORA.
 *   - La franja del rango probable sombrea únicamente el futuro.
 *   - El fondo del futuro va tintado y la leyenda lo nombra.
 *   - Los tres escenarios se marcan como puntos sobre cada horizonte, no como
 *     líneas: son desenlaces alternativos, no tres trayectorias.
 *
 * El escenario central se dibuja como línea porque así se pidió; la banda va
 * SIEMPRE con él, y su anchura es la incertidumbre. Una línea sola afirmaría
 * una precisión que estos datos no tienen.
 *
 * Este componente NO CALCULA NADA. Cada punto del futuro viene de un horizonte
 * que el servidor publicó con sus casos detrás; los horizontes sin evidencia
 * suficiente sencillamente no se dibujan.
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
import { MarketSideProjection } from './types';

interface Props {
  projection: MarketSideProjection;
}

const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });

interface Row {
  timestamp: number;
  real?: number;
  central?: number;
  band?: [number, number];
  bear?: number;
  base?: number;
  bull?: number;
}

const SERIES_LABEL: Record<string, string> = {
  real: 'Precio observado',
  central: 'Escenario central',
  bear: 'Escenario bajista',
  base: 'Escenario lateral',
  bull: 'Escenario alcista',
};

export const ProbabilisticProjectionChart: React.FC<Props> = ({ projection }) => {
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
      const scenarioOf = (kind: string) =>
        horizon.scenarios.find((s) => s.kind === kind && s.hasRange)?.median ?? undefined;

      rows.push({
        timestamp: (horizon.estimatedAt as number) ?? now + horizon.requestedHorizonMs,
        central: horizon.central as number,
        band: [horizon.low as number, horizon.high as number],
        bear: scenarioOf('BAJISTA'),
        base: scenarioOf('CENTRAL'),
        bull: scenarioOf('ALCISTA'),
      });
    }
  }

  const lastFuture = rows[rows.length - 1].timestamp;
  const firstReal = rows[0].timestamp;

  return (
    <div className="w-full h-72">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 20, right: 12, bottom: 4, left: 0 }}>
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
              return ts > now ? `${clock(ts)} · PROYECCIÓN` : `${clock(ts)} · HISTÓRICO`;
            }}
            formatter={(value: any, name: any) => {
              if (name === 'band' && Array.isArray(value)) {
                return [`${value[0].toFixed(2)} – ${value[1].toFixed(2)}`, 'Rango probable'];
              }
              const label = SERIES_LABEL[String(name)] ?? String(name);
              return [typeof value === 'number' ? value.toFixed(2) : value, label];
            }}
          />

          {/* El futuro va tintado y rotulado; nada aquí ocurrió. */}
          {publishable.length > 0 && (
            <ReferenceArea
              x1={now}
              x2={lastFuture}
              fill="#f0b90b"
              fillOpacity={0.05}
              stroke="none"
              label={{ value: 'PROYECCIÓN', fill: '#f0b90b', fontSize: 10, position: 'insideTop' }}
            />
          )}
          <ReferenceArea
            x1={firstReal}
            x2={now}
            fill="transparent"
            stroke="none"
            label={{ value: 'HISTÓRICO', fill: '#02c076', fontSize: 10, position: 'insideTop' }}
          />

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

          {/* Escenarios: puntos, no trayectorias. Son alternativas excluyentes. */}
          <Line
            dataKey="bear"
            stroke="none"
            dot={{ r: 3, fill: '#f6465d' }}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            dataKey="base"
            stroke="none"
            dot={{ r: 3, fill: '#848e9c' }}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Line
            dataKey="bull"
            stroke="none"
            dot={{ r: 3, fill: '#02c076' }}
            isAnimationActive={false}
            connectNulls={false}
          />

          <ReferenceLine
            x={now}
            stroke="#eaecef"
            strokeDasharray="3 3"
            label={{ value: 'AHORA', fill: '#eaecef', fontSize: 9, position: 'top' }}
          />
        </ComposedChart>
      </ResponsiveContainer>

      <div className="flex flex-wrap gap-x-4 gap-y-1 justify-center mt-1 text-[10px] text-[#848e9c]">
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-[2px] bg-[#02c076]" /> HISTÓRICO — precio observado
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 border-t-2 border-dashed border-[#f0b90b]" />
          PROYECCIÓN — escenario central
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-2 bg-[#f0b90b] opacity-25" /> Rango probable
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-[#f6465d]" />
          <span className="inline-block w-2 h-2 rounded-full bg-[#848e9c]" />
          <span className="inline-block w-2 h-2 rounded-full bg-[#02c076]" /> Escenarios
        </span>
      </div>
    </div>
  );
};
