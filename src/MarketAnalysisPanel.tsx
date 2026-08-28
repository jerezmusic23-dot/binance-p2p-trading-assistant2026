/**
 * ANÁLISIS DEL MERCADO — trend, projection and live signals per BANCO x MONTO.
 *
 * This component computes NOTHING. It does not derive a trend, a band, a zone
 * or a probability; all of that happened server-side over the per-cell series,
 * and this renders the decision plus the evidence behind it.
 *
 * THE ONE RULE THE LAYOUT ENFORCES
 *
 * ACTUAL and PROYECTADO never look alike. The live price is the large figure
 * and is labelled "publicar"; a projection is always a range, always carries
 * the word PROYECTADO, and always shows the sample size it came from. A
 * projected ceiling styled like a live price is how somebody publishes an ad
 * at a number Binance never quoted.
 */

import React, { useEffect, useState } from 'react';
import {
  CellProjection,
  Confidence,
  MarketSignal,
  SideProjection,
  SignalKind,
  TrendDirection,
} from './types';
import { ApiService } from './api';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  HelpCircle,
  RefreshCw,
  Rocket,
  Search,
} from 'lucide-react';

const TREND_STYLE: Record<
  TrendDirection,
  { label: string; className: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  BULLISH: { label: 'ALCISTA', className: 'text-[#02c076]', Icon: ArrowUpRight },
  BEARISH: { label: 'BAJISTA', className: 'text-[#f6465d]', Icon: ArrowDownRight },
  SIDEWAYS: { label: 'LATERAL', className: 'text-[#848e9c]', Icon: ArrowRight },
  TRANSITION: { label: 'EN TRANSICIÓN', className: 'text-[#f0b90b]', Icon: Activity },
  UNKNOWN: { label: 'SIN DATOS', className: 'text-[#5e6673]', Icon: HelpCircle },
};

const SIGNAL_LABEL: Record<SignalKind, string> = {
  TREND_CHANGE: 'Cambio de tendencia',
  EXHAUSTION: 'Agotamiento',
  CEILING_APPROACH: 'Cerca de un techo',
  FLOOR_APPROACH: 'Cerca de un piso',
  BREAKOUT_UP: 'Ruptura al alza',
  BREAKOUT_DOWN: 'Ruptura a la baja',
  ACCUMULATION: 'Acumulación',
  DISTRIBUTION: 'Distribución',
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  HIGH: 'ALTA',
  MEDIUM: 'MEDIA',
  LOW: 'BAJA',
  NO_DATA: 'SIN DATOS',
};

/** An absent number is words. Never a dash standing in for a price. */
const ves = (value: number | null): string =>
  value === null ? 'no verificable' : value.toFixed(2);

const hourRange = (start: number | null, end: number | null): string | null =>
  start === null || end === null
    ? null
    : `${String(start).padStart(2, '0')}:00 – ${String(end).padStart(2, '0')}:00`;

/** One side: what to publish now, and what the series says about where it goes. */
const SidePanel: React.FC<{ projection: SideProjection }> = ({ projection }) => {
  const trend = TREND_STYLE[projection.trend.trend];
  const range = projection.projectedRange;
  const buying = projection.side === 'BUY';

  return (
    <div className="flex-1 rounded-lg border border-[#2b2f36] p-3 space-y-2">
      <div className="flex items-center gap-1.5">
        <span className={buying ? 'text-[#02c076]' : 'text-[#FCD535]'}>{buying ? '🟢' : '🔵'}</span>
        <span className="text-[11px] font-bold uppercase text-[#e0e0e0]">{projection.label}</span>
      </div>
      <p className="text-[9px] text-[#5e6673] leading-tight">
        Compito en el listado{' '}
        <span className="font-mono">tradeType={projection.listingTradeType}</span>
      </p>

      {/* ACTUAL */}
      <div>
        <div className="text-[9px] uppercase tracking-wide text-[#848e9c]">
          Actual · precio para publicar
        </div>
        <div className="font-mono text-2xl text-[#e0e0e0]">{ves(projection.currentPrice)}</div>
      </div>

      <div className={`flex items-center gap-1 text-[11px] font-bold ${trend.className}`}>
        <trend.Icon className="w-3.5 h-3.5" />
        {trend.label}
        {projection.trend.trendStrength !== null && (
          <span className="text-[#848e9c] font-normal">
            · fuerza {(projection.trend.trendStrength * 100).toFixed(0)}%
          </span>
        )}
      </div>

      {/* PROYECTADO — visually and verbally separated from ACTUAL. */}
      <div className="rounded border border-dashed border-[#2b2f36] px-2 py-1.5">
        <div className="text-[9px] uppercase tracking-wide text-[#f0b90b]">
          Proyectado · rango observado
        </div>
        {range.low !== null && range.high !== null ? (
          <>
            <div className="font-mono text-[13px] text-[#e0e0e0]">
              {ves(range.low)} – {ves(range.high)}
            </div>
            <div className="text-[9px] text-[#5e6673] leading-tight">{range.basis}</div>
          </>
        ) : (
          <div className="text-[10px] text-[#848e9c]">
            {range.reason === 'NO_DATA'
              ? 'Sin histórico para proyectar.'
              : `Muestras insuficientes (${range.sampleSize}).`}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
        <div>
          <div className="text-[9px] text-[#848e9c] font-sans uppercase">Próximo techo</div>
          {projection.nextCeiling === null
            ? 'no observado'
            : `${ves(projection.nextCeiling.low)} – ${ves(projection.nextCeiling.high)}`}
          {projection.nextCeiling !== null && (
            <span className="text-[#5e6673]"> ·{projection.nextCeiling.touches} giro(s)</span>
          )}
        </div>
        <div>
          <div className="text-[9px] text-[#848e9c] font-sans uppercase">Próximo piso</div>
          {projection.nextFloor === null
            ? 'no observado'
            : `${ves(projection.nextFloor.low)} – ${ves(projection.nextFloor.high)}`}
          {projection.nextFloor !== null && (
            <span className="text-[#5e6673]"> ·{projection.nextFloor.touches} giro(s)</span>
          )}
        </div>
      </div>

      {projection.breakout !== null && (
        <div className="rounded border border-[#f0b90b]/40 bg-[#f0b90b]/10 px-2 py-1 text-[10px] text-[#f0b90b] font-mono">
          Ruptura {projection.breakout.direction === 'UP' ? 'al alza' : 'a la baja'} ·{' '}
          nivel {ves(projection.breakout.level)} · {projection.breakout.distanceVes >= 0 ? '+' : ''}
          {projection.breakout.distanceVes.toFixed(2)} VES · {projection.breakout.strength} ·{' '}
          {projection.breakout.status === 'CONFIRMED' ? 'CONFIRMADA' : 'AVISO TEMPRANO'}
        </div>
      )}

      {projection.watchWindows.length > 0 && (
        <div className="text-[10px] text-[#848e9c]">
          MIRAR:{' '}
          <span className="font-mono text-[#e0e0e0]">
            {hourRange(projection.watchWindows[0].startHour, projection.watchWindows[0].endHour)}
          </span>{' '}
          <span className="text-[#5e6673]">
            ({projection.watchWindows[0].sampleSize} obs.)
          </span>
        </div>
      )}

      <details className="text-[9px] text-[#5e6673]">
        <summary className="cursor-pointer">Por qué</summary>
        <ul className="mt-1 space-y-0.5">
          {projection.trend.basis.map((line) => (
            <li key={line}>· {line}</li>
          ))}
          <li>· Observaciones utilizables: {projection.trend.sampleSize}.</li>
          <li>· Confianza: {CONFIDENCE_LABEL[projection.trend.trendConfidence]}.</li>
        </ul>
      </details>
    </div>
  );
};

const SignalCard: React.FC<{ signal: MarketSignal }> = ({ signal }) => {
  const confirmed = signal.status === 'CONFIRMED';
  const Icon =
    signal.kind === 'BREAKOUT_UP' || signal.kind === 'BREAKOUT_DOWN'
      ? Rocket
      : confirmed
      ? AlertTriangle
      : Search;

  return (
    <div
      className={`rounded border px-2 py-1.5 ${
        confirmed
          ? 'border-[#f6465d]/40 bg-[#f6465d]/[0.07]'
          : 'border-[#f0b90b]/40 bg-[#f0b90b]/[0.07]'
      }`}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide">
        <Icon className={`w-3 h-3 ${confirmed ? 'text-[#f6465d]' : 'text-[#f0b90b]'}`} />
        <span className={confirmed ? 'text-[#f6465d]' : 'text-[#f0b90b]'}>
          {SIGNAL_LABEL[signal.kind]}
        </span>
        <span className="text-[#848e9c] font-normal normal-case">
          {confirmed ? '· CONFIRMADA' : '· señal parcial, aviso temprano'}
        </span>
      </div>

      <div className="mt-0.5 text-[11px] text-[#e0e0e0]">{signal.headline}</div>
      <div className="text-[10px] text-[#848e9c]">
        {signal.bankDisplayName} · {signal.amountKey}
      </div>

      <div className="mt-1 grid grid-cols-2 gap-2 text-[10px] font-mono">
        <div>
          <span className="text-[9px] text-[#848e9c] font-sans uppercase">Actual </span>
          {ves(signal.currentPrice)}
        </div>
        <div>
          <span className="text-[9px] text-[#f0b90b] font-sans uppercase">Proyectado </span>
          {signal.projectedLow === null || signal.projectedHigh === null
            ? 'no verificable'
            : `${ves(signal.projectedLow)} – ${ves(signal.projectedHigh)}`}
        </div>
      </div>

      <div className="mt-1 text-[9px] text-[#5e6673]">
        Confianza {CONFIDENCE_LABEL[signal.confidence]} · {signal.sampleSize} muestras
        {hourRange(signal.watchStartHour, signal.watchEndHour) !== null && (
          <> · MIRAR {hourRange(signal.watchStartHour, signal.watchEndHour)}</>
        )}
      </div>

      <details className="text-[9px] text-[#5e6673] mt-1">
        <summary className="cursor-pointer">Evidencia</summary>
        <ul className="mt-0.5 space-y-0.5">
          {signal.evidence.map((line) => (
            <li key={line}>· {line}</li>
          ))}
        </ul>
      </details>
    </div>
  );
};

export const MarketAnalysisPanel: React.FC = () => {
  const [projections, setProjections] = useState<CellProjection[]>([]);
  const [signals, setSignals] = useState<MarketSignal[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = async () => {
    try {
      setIsRefreshing(true);
      const res = await ApiService.getMakerProjections();
      setProjections(res.projections);
      setSignals(res.signals);
      setError(null);
    } catch (err: any) {
      console.error('Failed to load projections:', err);
      setError(err.message || 'Error al obtener el análisis de mercado');
    } finally {
      setLoaded(true);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    fetchAll();
    const timer = setInterval(fetchAll, 45_000);
    return () => clearInterval(timer);
  }, []);

  if (error !== null) {
    return (
      <div className="p-6 text-center text-[#f6465d] text-sm border border-[#f6465d]/30 rounded-lg">
        {error}
      </div>
    );
  }

  if (!loaded) {
    return <div className="p-6 text-center text-[#848e9c] text-sm">Analizando series…</div>;
  }

  const withHistory = projections.filter((p) => p.observations > 0);
  const key = (p: CellProjection) => `${p.bank}:${p.amountKey}`;
  const current = projections.find((p) => key(p) === selected) ?? withHistory[0] ?? null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-[#e0e0e0] uppercase tracking-wide flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#FCD535]" />
            Análisis del mercado
          </h2>
          <p className="text-[10px] text-[#848e9c] mt-0.5">
            Tendencia, techos, pisos y señales por banco y monto, calculados sobre la serie propia
            de cada celda. Una proyección nunca es un precio de Binance.
          </p>
        </div>
        <button
          type="button"
          onClick={fetchAll}
          disabled={isRefreshing}
          className="flex items-center gap-1 px-2 py-1 rounded border border-[#2b2f36] text-[10px] text-[#848e9c] hover:border-[#FCD535] transition-colors"
        >
          <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
          Refrescar
        </button>
      </div>

      {/* SEÑALES ACTIVAS */}
      <div>
        <h3 className="text-[10px] uppercase text-[#848e9c] font-bold tracking-wider mb-1">
          Señales activas
        </h3>
        {signals.length === 0 ? (
          <div className="text-[10px] text-[#848e9c] border border-dashed border-[#2b2f36] rounded px-2 py-1.5">
            Ninguna señal activa. Con series cortas esto es lo esperado: el motor no emite hasta
            tener observaciones suficientes.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            {signals.slice(0, 8).map((signal) => (
              <SignalCard key={`${signal.identity}:${signal.status}`} signal={signal} />
            ))}
          </div>
        )}
      </div>

      {/* SELECTOR DE CELDA */}
      <div className="flex flex-wrap gap-1">
        {projections.map((projection) => {
          const active = current !== null && key(projection) === key(current);
          const usable = projection.observations > 0;
          return (
            <button
              key={key(projection)}
              type="button"
              onClick={() => setSelected(key(projection))}
              className={`px-2 py-1 rounded border text-[10px] transition-colors ${
                active
                  ? 'border-[#FCD535] text-[#FCD535]'
                  : usable
                  ? 'border-[#2b2f36] text-[#848e9c] hover:border-[#FCD535]'
                  : 'border-[#2b2f36] text-[#5e6673]'
              }`}
            >
              {projection.bankDisplayName} · {projection.amountKey}
              <span className="ml-1 font-mono text-[9px]">({projection.observations})</span>
            </button>
          );
        })}
      </div>

      {current === null ? (
        <div className="text-[11px] text-[#848e9c] border border-[#2b2f36] rounded p-3">
          Todavía no hay ninguna serie almacenada. Cada celda empieza a acumular histórico desde su
          primera captura; el motor no proyecta antes de tenerlo.
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <h3 className="text-xs font-bold text-[#e0e0e0] uppercase tracking-wide">
              {current.bankDisplayName} · {current.amountVes.toLocaleString('es-VE')} VES
            </h3>
            <span className="text-[10px] text-[#848e9c] font-mono">
              {current.observations} observaciones
              {current.firstObservedAt !== null &&
                ` · desde ${new Date(current.firstObservedAt).toLocaleString('es-VE')}`}
            </span>
          </div>

          {current.reason !== null && (
            <div className="text-[10px] text-[#f0b90b] border border-[#f0b90b]/30 rounded px-2 py-1">
              {current.reason === 'NO_DATA'
                ? 'Esta celda no tiene ninguna observación almacenada todavía.'
                : 'Histórico insuficiente: el motor no proyecta con esta cantidad de observaciones.'}
            </div>
          )}

          <div className="flex flex-col lg:flex-row gap-2">
            <SidePanel projection={current.buy} />
            <SidePanel projection={current.sell} />
          </div>
        </div>
      )}

      <p className="text-[9px] text-[#5e6673] leading-tight">
        Las proyecciones se derivan del histórico real de cada celda: percentiles de movimientos
        observados, zonas donde la serie giró y horas en las que esta celda se mueve. No son
        órdenes, no son garantías y no incluyen comisiones ni costes operativos. Cuando no hay
        muestras suficientes el motor lo dice en vez de estimar.
      </p>
    </div>
  );
};
