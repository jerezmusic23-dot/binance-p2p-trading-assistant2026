/**
 * THE WHOLE BOOK, READ BY THE SAME ENGINE AS EVERY CELL.
 *
 * WHAT THIS REPLACED, AND WHY.
 *
 * This tab used to render DailyFluctuationChart, driven by the old
 * ProjectionEngine. Everything it presented as a forecast came out of
 * hand-picked constants:
 *
 *   daily.ceiling / floor     currentPrice ± stdDev * 1.6
 *   expectedFloor / Ceiling   ± volatility * 1.5 / 1.6, plus a ±0.007 drift
 *   intradayHorizons          a 0.0035 seasonal coefficient, a ×1.15 at +6H
 *   hourlyTimeline (future)   a hand-written per-hour session curve
 *   spreadMaxExpected         strategicSpreadPct * 1.15
 *
 * None of those was measured against anything. The screen drew them as a
 * projection, and a reader could not tell them from a reading of the market.
 *
 * What is here instead is the same engine every cell uses, run over the
 * general series - every cell's observations in one chronological list:
 *
 *   the band      the 10th and 90th percentile of the moves this book ACTUALLY
 *                 made over the same horizon, and nothing when there are too
 *                 few of them
 *   the horizon   measured from the observed cadence, in minutes, or absent
 *   the zones     prices the series genuinely turned at, with the turn count
 *   the trend     three horizons, each reporting its own window and real span
 *   confidence    HIGH/MEDIUM/LOW - evidence quality, never a probability
 *
 * IT DESCRIBES THE BOOK, NOT A CELL. Said in the header, because a market-wide
 * reading applied to one bank at one amount is exactly the confusion the
 * per-cell engine exists to avoid. What to publish is the Publicar tab; what a
 * single cell is doing is Análisis.
 */

import React, { useEffect, useState } from 'react';
import { ApiService } from './api';
import { ProjectionChart } from './ProjectionChart';
import { InsufficientDataNotice } from './ProvenanceTag';
import { CellProjection, Confidence, SeriesPoint, SideProjection, TrendGrade } from './types';
import { Activity, Compass } from 'lucide-react';

const GRADE_LABEL: Record<TrendGrade, string> = {
  STRONG_UP: 'alcista fuerte',
  UP: 'alcista',
  WEAK_UP: 'alcista débil',
  LATERAL: 'lateral',
  WEAK_DOWN: 'bajista débil',
  DOWN: 'bajista',
  STRONG_DOWN: 'bajista fuerte',
  UNKNOWN: 'sin lectura',
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  HIGH: 'ALTA',
  MEDIUM: 'MEDIA',
  LOW: 'BAJA',
  NO_DATA: 'SIN DATOS',
};

const HORIZON_LABEL: Record<'VERY_SHORT' | 'SHORT' | 'MEDIUM', string> = {
  VERY_SHORT: 'MUY CORTO',
  SHORT: 'CORTO',
  MEDIUM: 'MEDIO',
};

const ves = (value: number | null): string =>
  value === null ? 'no verificable' : `${value.toFixed(2)} VES`;

const minutes = (ms: number | null): string =>
  ms === null ? 'no medible' : `${Math.round(ms / 60000)} min`;

const SideBlock: React.FC<{ projection: SideProjection }> = ({ projection }) => {
  const range = projection.projectedRange;

  return (
    <div className="flex-1 space-y-2 rounded border border-[#2b2f36] bg-[#181a20] p-3">
      <div className="text-[10px] uppercase tracking-wide text-[#848e9c]">{projection.label}</div>

      {/* OBSERVADO — the live level, never a projection. */}
      <div>
        <div className="text-[9px] uppercase tracking-wide text-[#5e6673]">
          Observado · nivel actual del libro
        </div>
        <div className="font-mono text-[15px] text-[#e0e0e0]">{ves(projection.currentPrice)}</div>
      </div>

      {/* The three horizons, each with the period it actually covers. */}
      <div className="flex flex-wrap gap-1 text-[9px]">
        {projection.trend.horizons.map((horizon) => (
          <span
            key={horizon.name}
            className="rounded border border-[#2b2f36] px-1.5 py-0.5 font-mono text-[#848e9c]"
          >
            {HORIZON_LABEL[horizon.name]}: {GRADE_LABEL[horizon.grade]}
            <span className="text-[#5e6673]">
              {' '}
              ·{' '}
              {horizon.spanMs === null
                ? `${horizon.observations} obs.`
                : `${horizon.observations} obs. / ${Math.round(horizon.spanMs / 60000)} min`}
            </span>
          </span>
        ))}
      </div>
      {projection.trend.divergence !== null && (
        <div className="text-[10px] leading-tight text-[#f0b90b]">
          {projection.trend.divergence}
        </div>
      )}

      {/* PROYECTADO — a band with a stated period, or the refusal to draw one. */}
      <div className="rounded border border-dashed border-[#2b2f36] px-2 py-1.5">
        <div className="text-[9px] uppercase tracking-wide text-[#f0b90b]">
          Proyectado · rango observado
          {range.horizonMs !== null && (
            <span className="normal-case tracking-normal text-[#5e6673]">
              {' '}
              · a {minutes(range.horizonMs)} ({range.stepsAhead} obs.)
            </span>
          )}
        </div>
        {range.low !== null && range.high !== null ? (
          <>
            <div className="font-mono text-[13px] text-[#e0e0e0]">
              {ves(range.low)} – {ves(range.high)}
            </div>
            <div className="text-[9px] leading-tight text-[#5e6673]">{range.basis}</div>
          </>
        ) : (
          <div className="text-[10px] text-[#848e9c]">
            {range.reason === 'NO_DATA'
              ? 'Sin histórico para proyectar.'
              : `Muestras insuficientes (${range.sampleSize}).`}
          </div>
        )}
      </div>

      {/* Zones the book genuinely turned in, with the number of turns. */}
      <div className="grid grid-cols-2 gap-2 font-mono text-[10px]">
        <div>
          <div className="font-sans text-[9px] uppercase text-[#848e9c]">Próximo techo</div>
          {projection.nextCeiling === null
            ? 'no observado'
            : `${ves(projection.nextCeiling.low)} – ${ves(projection.nextCeiling.high)}`}
          {projection.nextCeiling !== null && (
            <span className="text-[#5e6673]"> ·{projection.nextCeiling.touches} giro(s)</span>
          )}
        </div>
        <div>
          <div className="font-sans text-[9px] uppercase text-[#848e9c]">Próximo piso</div>
          {projection.nextFloor === null
            ? 'no observado'
            : `${ves(projection.nextFloor.low)} – ${ves(projection.nextFloor.high)}`}
          {projection.nextFloor !== null && (
            <span className="text-[#5e6673]"> ·{projection.nextFloor.touches} giro(s)</span>
          )}
        </div>
      </div>

      <div className="text-[10px] text-[#848e9c]">
        Confianza {CONFIDENCE_LABEL[projection.trend.trendConfidence]} ·{' '}
        {projection.trend.sampleSize} obs.
        <span className="text-[#5e6673]">
          {' '}
          — calidad de la evidencia (muestra y acuerdo entre horizontes), no una probabilidad.
        </span>
      </div>
    </div>
  );
};

export const MarketProjectionPanel: React.FC = () => {
  const [projection, setProjection] = useState<CellProjection | null>(null);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [chartSide, setChartSide] = useState<'BUY' | 'SELL'>('BUY');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await ApiService.getGeneralProjection();
        if (cancelled) return;
        setProjection(res.projection);
        setSeries(res.series ?? []);
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    const timer = setInterval(load, 45_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (loading) {
    return (
      <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-8 text-center">
        <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-[#FCD535] border-t-transparent" />
        <p className="text-[#848e9c]">Leyendo el histórico del libro…</p>
      </div>
    );
  }

  if (failed) {
    return <InsufficientDataNotice reason="No se pudo leer la proyección del mercado." />;
  }

  if (projection === null) {
    return (
      <InsufficientDataNotice
        reason={
          'Todavía no hay observaciones almacenadas. La proyección se deriva del histórico ' +
          'real del libro, así que no existe hasta que el primer barrido lo escriba. No se ' +
          'muestra una estimación en su lugar.'
        }
      />
    );
  }

  const side = chartSide === 'BUY' ? projection.buy : projection.sell;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-4">
        <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#848e9c]">
          <Compass className="h-3.5 w-3.5 text-[#FCD535]" />
          Proyección del mercado general
        </h2>
        <p className="mt-1 text-[11px] leading-tight text-[#848e9c]">
          Describe el <strong>libro completo</strong>, no un banco a un monto concreto. Para el
          precio que debes publicar en una celda, usa <em>Publicar</em>; para lo que hace una
          celda, <em>Análisis</em>.
        </p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-[#5e6673]">
          <span>{projection.observations} observaciones</span>
          {projection.firstObservedAt !== null && projection.lastObservedAt !== null && (
            <span>
              {new Date(projection.firstObservedAt).toLocaleString('es-VE')} →{' '}
              {new Date(projection.lastObservedAt).toLocaleString('es-VE')}
            </span>
          )}
        </div>
      </div>

      {projection.reason !== null && (
        <InsufficientDataNotice
          reason={
            projection.reason === 'NO_DATA'
              ? 'Sin observaciones almacenadas.'
              : `Histórico insuficiente: ${projection.observations} observaciones.`
          }
        />
      )}

      <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[#848e9c]">
            <Activity className="h-3 w-3" /> Histórico real, después la banda
          </span>
          <div className="flex gap-1">
            {(['BUY', 'SELL'] as const).map((option) => (
              <button
                key={option}
                onClick={() => setChartSide(option)}
                className={`rounded border px-1.5 py-0.5 text-[9px] transition-colors ${
                  chartSide === option
                    ? 'border-[#FCD535] text-[#FCD535]'
                    : 'border-[#2b2f36] text-[#848e9c] hover:border-[#FCD535]'
                }`}
              >
                {option === 'BUY' ? 'MI COMPRA' : 'MI VENTA'}
              </button>
            ))}
          </div>
        </div>
        <ProjectionChart observations={series} projection={side} side={chartSide} />
      </div>

      <div className="flex flex-col gap-2 lg:flex-row">
        <SideBlock projection={projection.buy} />
        <SideBlock projection={projection.sell} />
      </div>

      <p className="text-[9px] leading-tight text-[#5e6673]">
        Todo lo anterior sale del histórico realmente capturado: percentiles de movimientos
        observados, zonas donde la serie giró y la cadencia medida de las observaciones. No hay
        distribución de probabilidad, no hay curva horaria estimada y no hay multiplicadores de
        volatilidad. Cuando no hay muestras suficientes, se dice, en vez de rellenar el hueco.
      </p>
    </div>
  );
};
