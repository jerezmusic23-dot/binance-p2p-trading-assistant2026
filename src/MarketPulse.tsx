/**
 * PULSO DEL MERCADO — the three questions after "what do I publish".
 *
 *   ¿Qué está haciendo el mercado?   trend, at the strongest-evidenced cell
 *   ¿Qué puede pasar?                the projected band, labelled as such
 *   ¿Qué debo vigilar?               the live signals and the watch window
 *
 * Compact by design: this sits on the dashboard under the publish panel, and
 * the full per-cell analysis lives in its own screen. It computes NOTHING -
 * the cell it shows is the one with the most observations, which is a display
 * choice, not an economic one.
 */

import React, { useEffect, useState } from 'react';
import { CellProjection, MarketSignal, TrendGrade } from './types';
import { ApiService } from './api';
import { Activity, ArrowRight } from 'lucide-react';

const GRADE: Record<TrendGrade, { label: string; className: string }> = {
  STRONG_UP: { label: 'ALCISTA FUERTE', className: 'text-[#02c076]' },
  UP: { label: 'ALCISTA', className: 'text-[#02c076]' },
  WEAK_UP: { label: 'ALCISTA DÉBIL', className: 'text-[#02c076]/80' },
  LATERAL: { label: 'LATERAL', className: 'text-[#848e9c]' },
  WEAK_DOWN: { label: 'BAJISTA DÉBIL', className: 'text-[#f6465d]/80' },
  DOWN: { label: 'BAJISTA', className: 'text-[#f6465d]' },
  STRONG_DOWN: { label: 'BAJISTA FUERTE', className: 'text-[#f6465d]' },
  UNKNOWN: { label: 'SIN DATOS', className: 'text-[#5e6673]' },
};

const ves = (v: number | null) => (v === null ? 'no verificable' : v.toFixed(2));

export const MarketPulse: React.FC<{ onOpenAnalysis?: () => void }> = ({ onOpenAnalysis }) => {
  const [projections, setProjections] = useState<CellProjection[]>([]);
  const [signals, setSignals] = useState<MarketSignal[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      ApiService.getMakerProjections()
        .then((res) => {
          if (cancelled) return;
          setProjections(res.projections);
          setSignals(res.signals);
        })
        .catch((err) => console.error('Failed to load market pulse:', err))
        .finally(() => {
          if (!cancelled) setLoaded(true);
        });

    load();
    const timer = setInterval(load, 45_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!loaded) {
    return (
      <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-4 text-[11px] text-[#848e9c]">
        Leyendo el pulso del mercado…
      </div>
    );
  }

  /* The best-evidenced cell, which is a display choice and nothing more. */
  const cell = [...projections].sort((a, b) => b.observations - a.observations)[0] ?? null;

  if (cell === null || cell.observations === 0) {
    return (
      <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-4">
        <h2 className="text-sm font-bold text-[#e0e0e0] uppercase tracking-wide flex items-center gap-2 mb-1">
          <Activity className="w-4 h-4 text-[#FCD535]" />
          Pulso del mercado
        </h2>
        <p className="text-[11px] text-[#848e9c]">
          Todavía no hay histórico. Cada celda acumula su propia serie desde su primera captura, y
          el motor no dice nada sobre el mercado antes de tenerla.
        </p>
      </div>
    );
  }

  const side = cell.buy;
  const grade = GRADE[side.trend.grade];
  const window = side.watchWindows[0] ?? null;

  return (
    <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-bold text-[#e0e0e0] uppercase tracking-wide flex items-center gap-2">
          <Activity className="w-4 h-4 text-[#FCD535]" />
          Pulso del mercado
        </h2>
        <span className="text-[10px] text-[#848e9c]">
          {cell.bankDisplayName} · {cell.amountKey} · {cell.observations} obs.
          {cell.borrowedFrom !== null && (
            <span className="text-[#f0b90b]"> · lectura del mercado general</span>
          )}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* 2. QUÉ ESTÁ HACIENDO EL MERCADO */}
        <div>
          <div className="text-[9px] uppercase tracking-wide text-[#848e9c]">Tendencia</div>
          <div className={`text-lg font-bold ${grade.className}`}>{grade.label}</div>
          {side.trend.divergence !== null && (
            <div className="text-[9px] text-[#f0b90b] leading-tight mt-0.5">
              {side.trend.divergence}
            </div>
          )}
          <div className="text-[9px] text-[#5e6673] mt-0.5">
            Confianza {side.trend.trendConfidence} · {side.trend.sampleSize} obs.
          </div>
        </div>

        {/* 3. QUÉ PUEDE PASAR — labelled PROYECTADO, never a price */}
        <div>
          <div className="text-[9px] uppercase tracking-wide text-[#f0b90b]">
            Proyectado · rango
          </div>
          <div className="font-mono text-[13px] text-[#e0e0e0]">
            {side.projectedRange.low === null
              ? 'no verificable'
              : `${ves(side.projectedRange.low)} – ${ves(side.projectedRange.high)}`}
          </div>
          <div className="text-[9px] text-[#5e6673] mt-0.5">
            {side.projectedRange.low === null
              ? `Muestras insuficientes (${side.projectedRange.sampleSize}).`
              : `${side.projectedRange.sampleSize} movimientos reales.`}
          </div>
        </div>

        {/* 4. QUÉ DEBO VIGILAR */}
        <div>
          <div className="text-[9px] uppercase tracking-wide text-[#848e9c]">Mirar</div>
          <div className="font-mono text-[13px] text-[#e0e0e0]">
            {window === null
              ? 'sin ventana medida'
              : `${String(window.startHour).padStart(2, '0')}:00 – ${String(
                  window.endHour
                ).padStart(2, '0')}:00`}
          </div>
          <div className="text-[9px] text-[#5e6673] mt-0.5">
            {window === null
              ? 'No hay observaciones suficientes por hora.'
              : `${window.sampleSize} observaciones en esa franja.`}
          </div>
        </div>
      </div>

      <div>
        <div className="text-[9px] uppercase tracking-wide text-[#848e9c] mb-1">
          Señales activas
        </div>
        {signals.length === 0 ? (
          <p className="text-[10px] text-[#848e9c]">
            Ninguna. Con series cortas es lo esperado: el motor no emite hasta tener observaciones
            suficientes.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {signals.slice(0, 3).map((signal) => (
              <li key={`${signal.identity}:${signal.status}`} className="text-[10px]">
                <span
                  className={
                    signal.status === 'CONFIRMED' ? 'text-[#f6465d]' : 'text-[#f0b90b]'
                  }
                >
                  {signal.status === 'CONFIRMED' ? '●' : '○'}
                </span>{' '}
                <span className="text-[#e0e0e0]">{signal.headline}</span>{' '}
                <span className="text-[#5e6673]">
                  ({signal.bankDisplayName} {signal.amountKey} · {signal.sampleSize} obs.)
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {onOpenAnalysis !== undefined && (
        <button
          type="button"
          onClick={onOpenAnalysis}
          className="flex items-center gap-1 text-[10px] text-[#FCD535] hover:underline"
        >
          Ver el análisis completo por banco y monto <ArrowRight className="w-3 h-3" />
        </button>
      )}

      <p className="text-[9px] text-[#5e6673] leading-tight">
        Una proyección no es un precio de Binance ni una orden. Es el rango en el que esta celda
        se movió históricamente a esa distancia.
      </p>
    </div>
  );
};
