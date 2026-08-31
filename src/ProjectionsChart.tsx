/**
 * LA GRÁFICA ÚNICA: EL DÍA SIN CONFUNDIR LO VIVIDO CON LO PROYECTADO
 * =================================================================
 *
 * Lo que este componente tiene que hacer imposible es que alguien lea un precio
 * proyectado creyendo que ocurrió. Por eso, igual que en la gráfica de
 * horizontes:
 *
 *   - El tramo real es línea CONTINUA con punto sólido.
 *   - El tramo proyectado es PUNTEADO, sólo existe a la derecha de AHORA, y el
 *     fondo de ese lado va tintado.
 *   - La banda sombreada acompaña SIEMPRE a la línea proyectada. Una línea sola
 *     afirmaría una precisión que estos datos no tienen.
 *   - Las horas sin evidencia no se dibujan. No heredan el precio de al lado.
 *
 * La hora del ancla aparece en las DOS series a propósito: es el punto donde lo
 * real se convierte en proyección, y repetirlo es lo que hace que las líneas se
 * toquen en vez de aparecer separadas por un hueco que no existe.
 *
 * ESTE COMPONENTE NO CALCULA NADA. Cada precio, cada banda y cada movimiento
 * por hora vienen del servidor con los días que los sostienen.
 */

import React from 'react';
import {
  Area,
  Bar,
  Cell,
  ComposedChart,
  CartesianGrid,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { DailyProjectionResponse } from './types';
import { buildRows, hourLabel, type DailyChartRow } from './dailyChartRows';

/* MI VENTA va arriba (techo) y MI COMPRA abajo (piso). El color no decide
   nada: lo decide el campo del que sale cada serie. */
const VENTA_COLOR = '#f0b90b';
const COMPRA_COLOR = '#02c076';
const GRID = '#2b2f36';
const MUTED = '#848e9c';

const money = (v: number | undefined) => (v == null ? '—' : v.toFixed(2));

const TooltipBox: React.FC<{ active?: boolean; payload?: any[]; label?: string }> = ({
  active,
  payload,
  label,
}) => {
  if (!active || !payload || payload.length === 0) return null;
  const row: DailyChartRow = payload[0].payload;
  const projected = row.ventaReal === undefined && row.ventaProjected !== undefined;

  return (
    <div className="bg-[#181a20] border border-[#2b2f36] rounded px-3 py-2 text-[11px]">
      <div className="text-[#eaecef] font-semibold mb-1">
        {label}
        <span className={`ml-2 text-[9px] ${projected ? 'text-[#848e9c]' : 'text-[#02c076]'}`}>
          {projected ? 'PROYECCIÓN' : 'OCURRIÓ'}
        </span>
      </div>
      <div style={{ color: VENTA_COLOR }}>
        MI VENTA {money(row.ventaReal ?? row.ventaProjected)}
        {row.ventaBand && !row.ventaReal && (
          <span className="text-[#5e6673]"> ({money(row.ventaBand[0])}–{money(row.ventaBand[1])})</span>
        )}
      </div>
      <div style={{ color: COMPRA_COLOR }}>
        MI COMPRA {money(row.compraReal ?? row.compraProjected)}
        {row.compraBand && !row.compraReal && (
          <span className="text-[#5e6673]"> ({money(row.compraBand[0])}–{money(row.compraBand[1])})</span>
        )}
      </div>
      {row.movePct !== undefined && (
        <div className="text-[#848e9c] mt-1">
          movimiento {row.movePct >= 0 ? '+' : ''}
          {row.movePct.toFixed(2)}% {row.moveIsReal ? '(real)' : '(esperado)'}
        </div>
      )}
    </div>
  );
};

interface Props {
  report: DailyProjectionResponse;
}

export const ProjectionsChart: React.FC<Props> = ({ report }) => {
  const rows = buildRows(report);
  const anchorLabel = hourLabel(report.anchorHour);
  const hasProjection = report.legs.some((l) => l.projection.projected.length > 0);
  const threshold = report.turn.pct;

  return (
    <div>
      <div style={{ width: '100%', height: 320 }}>
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 16, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: MUTED, fontSize: 10 }} stroke={GRID} />
            <YAxis
              tick={{ fill: MUTED, fontSize: 10 }}
              stroke={GRID}
              domain={['dataMin - 2', 'dataMax + 2']}
              tickFormatter={(v: number) => v.toFixed(0)}
              width={48}
            />
            <Tooltip content={<TooltipBox />} />

            {/* El futuro va tintado: se ve de un vistazo dónde deja de haber hechos. */}
            {hasProjection && (
              <ReferenceArea
                x1={anchorLabel}
                x2={hourLabel(report.endHour)}
                fill="#ffffff"
                fillOpacity={0.03}
              />
            )}

            {/* La ventana que merece vigilancia, si el servidor pudo señalar una. */}
            {report.watchWindow && (
              <ReferenceArea
                x1={hourLabel(report.watchWindow.fromHour)}
                x2={hourLabel(report.watchWindow.toHour)}
                fill={VENTA_COLOR}
                fillOpacity={0.07}
                label={{ value: 'MIRAR AQUÍ', position: 'insideTop', fill: MUTED, fontSize: 9 }}
              />
            )}

            <Area
              dataKey="ventaBand"
              stroke="none"
              fill={VENTA_COLOR}
              fillOpacity={0.1}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Area
              dataKey="compraBand"
              stroke="none"
              fill={COMPRA_COLOR}
              fillOpacity={0.1}
              isAnimationActive={false}
              connectNulls={false}
            />

            <Line
              dataKey="ventaReal"
              stroke={VENTA_COLOR}
              strokeWidth={2}
              dot={{ r: 2, fill: VENTA_COLOR }}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Line
              dataKey="compraReal"
              stroke={COMPRA_COLOR}
              strokeWidth={2}
              dot={{ r: 2, fill: COMPRA_COLOR }}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Line
              dataKey="ventaProjected"
              stroke={VENTA_COLOR}
              strokeWidth={2}
              strokeDasharray="3 3"
              dot={{ r: 2, fill: 'none', stroke: VENTA_COLOR }}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Line
              dataKey="compraProjected"
              stroke={COMPRA_COLOR}
              strokeWidth={2}
              strokeDasharray="3 3"
              dot={{ r: 2, fill: 'none', stroke: COMPRA_COLOR }}
              isAnimationActive={false}
              connectNulls={false}
            />

            <ReferenceLine
              x={anchorLabel}
              stroke="#eaecef"
              strokeDasharray="4 4"
              label={{ value: 'AHORA', position: 'top', fill: '#eaecef', fontSize: 9 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/*
        MOVIMIENTO POR HORA.
        El umbral de giro es una línea MEDIDA —la mediana de los cambios de hora
        a hora del histórico—, no un 0.3 % elegido a mano. Sin muestra no se
        dibuja ninguna línea, que es más honesto que dibujar una por defecto.
      */}
      <div className="text-[9px] text-[#5e6673] uppercase tracking-wide mt-2 mb-1">
        Movimiento por hora (mi venta)
        {threshold !== null && (
          <span className="ml-2 normal-case tracking-normal">
            · umbral de giro medido ±{threshold.toFixed(2)}% sobre {report.turn.sampleSize} cambios
          </span>
        )}
      </div>
      <div style={{ width: '100%', height: 92 }}>
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: MUTED, fontSize: 10 }} stroke={GRID} />
            <YAxis
              tick={{ fill: MUTED, fontSize: 9 }}
              stroke={GRID}
              width={48}
              tickFormatter={(v: number) => `${v.toFixed(1)}%`}
            />
            <Tooltip content={<TooltipBox />} />
            <ReferenceLine y={0} stroke={GRID} />
            {threshold !== null && (
              <>
                <ReferenceLine y={threshold} stroke={MUTED} strokeDasharray="2 3" />
                <ReferenceLine y={-threshold} stroke={MUTED} strokeDasharray="2 3" />
              </>
            )}
            <Bar dataKey="movePct" isAnimationActive={false}>
              {rows.map((row) => (
                <Cell
                  key={row.hour}
                  fill={(row.movePct ?? 0) >= 0 ? VENTA_COLOR : COMPRA_COLOR}
                  /* Hueco = todavía no ha ocurrido. Misma regla que los puntos. */
                  fillOpacity={row.moveIsReal ? 0.85 : 0.35}
                />
              ))}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
