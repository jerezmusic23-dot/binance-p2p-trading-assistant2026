/**
 * ESTADO ACTUAL DEL MERCADO
 * =========================
 *
 * La mitad de arriba de "Proyección del Mercado": qué está haciendo el precio
 * AHORA. Va separada de la proyección a propósito, porque responden a
 * preguntas distintas:
 *
 *   MOVIMIENTO  hacia dónde y con cuánta fuerza se mueve, comparado con lo que
 *               este mercado suele moverse. Descripción del presente.
 *   PROYECCIÓN  hacia dónde apuntan las situaciones históricas parecidas,
 *               medido contra la deriva estructural del bolívar.
 *
 * Un mercado puede estar subiendo y proyectarse LATERAL porque sube justo lo
 * que suele subir. Fundirlos en una etiqueta borraría esa diferencia.
 *
 * Este componente NO CALCULA NADA: cada número llega del servidor.
 */

import React from 'react';
import {
  EvidenceTier,
  HorizonMovement,
  MarketReadingResult,
  MomentumTrend,
  MovementDirection,
} from './types';
import { NO_DATA, fmt, fmtInt } from './format';

const DIRECTION_STYLE: Record<MovementDirection, { arrow: string; className: string }> = {
  ALCISTA: { arrow: '↑', className: 'text-[#02c076]' },
  BAJISTA: { arrow: '↓', className: 'text-[#f6465d]' },
  LATERAL: { arrow: '→', className: 'text-[#f0b90b]' },
  INDETERMINADA: { arrow: '·', className: 'text-[#848e9c]' },
};

const TREND_TEXT: Record<MomentumTrend, string> = {
  AUMENTANDO: 'en aceleración',
  ESTABLE: 'sostenido',
  DISMINUYENDO: 'perdiendo fuerza',
  INDETERMINADO: 'sin lectura',
};

const EVIDENCE_STYLE: Record<EvidenceTier, string> = {
  SIN_DATOS: 'text-[#848e9c] border-[#848e9c]/40 bg-[#848e9c]/5',
  DATOS_INSUFICIENTES: 'text-[#848e9c] border-[#848e9c]/40 bg-[#848e9c]/5',
  HISTORICO_LIMITADO: 'text-[#f0b90b] border-[#f0b90b]/40 bg-[#f0b90b]/5',
  HISTORICO_SUFICIENTE: 'text-[#02c076] border-[#02c076]/40 bg-[#02c076]/5',
  ALTA_CONFIANZA_ESTADISTICA: 'text-[#02c076] border-[#02c076]/60 bg-[#02c076]/10',
};

const hours = (ms: number | null) =>
  ms === null || !Number.isFinite(ms) ? NO_DATA : `${(ms / 3_600_000).toFixed(1)} h`;

/** Barra 0–100. La escala es la distribución del propio mercado, no una nota. */
const MomentumBar: React.FC<{ score: number | null }> = ({ score }) => {
  if (score === null) {
    return <div className="h-1.5 rounded bg-[#2b2f36]" />;
  }
  const above = score >= 50;
  return (
    <div className="relative h-1.5 rounded bg-[#2b2f36] overflow-hidden">
      {/* El 50 es "no se mueve": la barra crece desde el centro hacia el lado
          que corresponda, para que la dirección se vea sin leer el número. */}
      <div
        className={`absolute top-0 bottom-0 ${above ? 'bg-[#02c076]' : 'bg-[#f6465d]'}`}
        style={{
          left: above ? '50%' : `${score}%`,
          width: `${Math.abs(score - 50)}%`,
        }}
      />
      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-[#5e6673]" />
    </div>
  );
};

const HorizonRow: React.FC<{ horizon: HorizonMovement }> = ({ horizon }) => {
  const style = DIRECTION_STYLE[horizon.direction];
  const score = horizon.momentum.score;

  return (
    <tr className="border-t border-[#2b2f36]">
      <td className="py-1 px-2 font-mono text-[#eaecef]">{horizon.label}</td>
      <td className={`py-1 px-2 ${style.className}`}>
        {style.arrow} {horizon.direction === 'INDETERMINADA' ? 'sin lectura' : horizon.direction}
      </td>
      <td className="py-1 px-2 text-right font-mono text-[#eaecef]">
        {score === null ? NO_DATA : Math.round(score)}
      </td>
      <td className="py-1 px-2 w-24">
        <MomentumBar score={score} />
      </td>
      <td className="py-1 px-2 text-right text-[#5e6673] font-mono">
        {horizon.available ? `${horizon.windowSteps} obs` : 'sin datos'}
      </td>
    </tr>
  );
};

export const MarketStateBlock: React.FC<{ reading: MarketReadingResult }> = ({ reading }) => {
  const movement = reading.movement;
  const predominant = DIRECTION_STYLE[reading.predominant.direction];

  return (
    <div className="border-b border-[#2b2f36]">
      <div className="px-3 pt-3 pb-2">
        <h4 className="text-[11px] font-semibold text-[#eaecef] mb-2">Estado actual</h4>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <p className="text-[10px] text-[#5e6673] uppercase">Precio</p>
            <p className="text-lg font-mono text-[#eaecef]">{fmt(reading.currentPrice)}</p>
          </div>
          <div>
            <p className="text-[10px] text-[#5e6673] uppercase">Tendencia</p>
            <p className={`text-base font-semibold ${predominant.className}`}>
              {predominant.arrow} {reading.predominant.direction}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-[#5e6673] uppercase">Movimiento</p>
            <p className="text-base font-mono text-[#eaecef]">
              {movement.score === null ? NO_DATA : `${Math.round(movement.score)}/100`}
            </p>
            <p className="text-[10px] text-[#848e9c]">{TREND_TEXT[movement.trend]}</p>
          </div>
          <div>
            <p className="text-[10px] text-[#5e6673] uppercase">Volatilidad</p>
            <p className="text-base font-mono text-[#eaecef]">
              {fmt(movement.factors.volatility, 2)}
            </p>
            <p className="text-[10px] text-[#848e9c]">veces el movimiento típico</p>
          </div>
        </div>
      </div>

      {/* Tendencia por horizontes: no se reduce todo a una sola señal. */}
      <div className="px-1 pb-2 overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="text-[#5e6673]">
            <tr>
              <th className="text-left py-1 px-2">Ventana</th>
              <th className="text-left py-1 px-2">Dirección</th>
              <th className="text-right py-1 px-2">Fuerza</th>
              <th className="py-1 px-2" />
              <th className="text-right py-1 px-2">Muestra</th>
            </tr>
          </thead>
          <tbody>
            {reading.horizons.map((h) => (
              <HorizonRow key={h.label} horizon={h} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-3 pb-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-[10px]">
        <div>
          <p className="text-[#5e6673] uppercase">Observaciones</p>
          <p className="text-[#eaecef] font-mono">{fmtInt(reading.observations)}</p>
        </div>
        <div>
          <p className="text-[#5e6673] uppercase">Histórico disponible</p>
          <p className="text-[#eaecef] font-mono">{hours(reading.spanMs)}</p>
        </div>
        <div>
          <p className="text-[#5e6673] uppercase">Liquidez compra</p>
          <p className="text-[#eaecef] font-mono">
            {reading.liquidity?.buyUsdt === null || reading.liquidity === null
              ? NO_DATA
              : `${fmtInt(Math.round(reading.liquidity.buyUsdt))} USDT`}
          </p>
          <p className="text-[#5e6673]">
            {reading.liquidity?.buyAds === null || reading.liquidity === null
              ? 'nadie publicó volumen'
              : `${reading.liquidity.buyAds} anuncios`}
          </p>
        </div>
        <div>
          <p className="text-[#5e6673] uppercase">Liquidez venta</p>
          <p className="text-[#eaecef] font-mono">
            {reading.liquidity?.sellUsdt === null || reading.liquidity === null
              ? NO_DATA
              : `${fmtInt(Math.round(reading.liquidity.sellUsdt))} USDT`}
          </p>
          <p className="text-[#5e6673]">
            {reading.liquidity?.sellAds === null || reading.liquidity === null
              ? 'nadie publicó volumen'
              : `${reading.liquidity.sellAds} anuncios`}
          </p>
        </div>
      </div>

      {/* Por qué se concluye lo que se concluye. Más útil que el número solo. */}
      <div className="px-3 pb-3">
        <div className={`px-3 py-2 rounded border text-[10px] ${EVIDENCE_STYLE[reading.evidence]}`}>
          <p className="font-semibold mb-1">{reading.evidence.replace(/_/g, ' ')}</p>
          <ul className="space-y-0.5 text-[#eaecef]">
            {reading.narrative.map((line, i) => (
              <li key={i}>· {line}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};
