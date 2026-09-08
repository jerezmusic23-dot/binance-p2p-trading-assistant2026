/**
 * LECTURA DEL MERCADO — LA PANTALLA QUE SIRVE PARA DECIDIR
 * =========================================================
 *
 * Enseña los tres bloques SEPARADOS, en el mismo orden en que el motor los
 * calcula, porque mezclarlos fue el defecto de la pantalla anterior:
 *
 *   OBSERVACIÓN   lo medido        (precio, velocidad, aceleración, volatilidad)
 *   PREDICCIÓN    lo esperado      (proyección, rango, error, señal/ruido)
 *   DECISIÓN      qué hacer        (acción + motivo escrito con esos números)
 *
 * Esta pantalla NO calcula nada. Ni una dirección, ni una probabilidad, ni un
 * umbral: todo llega decidido del servidor, con su procedencia al lado. Si
 * aquí se recalculara cualquier cosa, existirían dos motores libres de
 * discrepar, y el operador no sabría cuál está leyendo.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw, ShieldQuestion, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { ApiService } from './api';
import type {
  DecisionConfidence,
  LegDecisionView,
  MarketDecision,
  MarketReadingResponse,
  MarketRegime,
} from './types';

const VENTA_COLOR = '#f0b90b';
const COMPRA_COLOR = '#02c076';

const REGIME_LABEL: Record<MarketRegime, string> = {
  CONTINUACION: 'CONTINUACIÓN',
  REVERSION: 'REVERSIÓN',
  LATERAL: 'LATERAL',
  TRANSICION: 'TRANSICIÓN',
  INDETERMINADO: 'INDETERMINADO',
};

const REGIME_COLOR: Record<MarketRegime, string> = {
  CONTINUACION: '#02c076',
  REVERSION: '#f6465d',
  LATERAL: '#848e9c',
  TRANSICION: '#f0b90b',
  INDETERMINADO: '#5e6673',
};

const DECISION_LABEL: Record<MarketDecision, string> = {
  PUBLICAR: 'PUBLICAR',
  NO_PUBLICAR: 'NO PUBLICAR',
  ESPERAR: 'ESPERAR',
  SUBIR_PRECIO: 'SUBIR PRECIO',
  BAJAR_PRECIO: 'BAJAR PRECIO',
  MANTENER_PRECIO: 'MANTENER PRECIO',
  REDUCIR_EXPOSICION: 'REDUCIR EXPOSICIÓN',
  AUMENTAR_EXPOSICION: 'AUMENTAR EXPOSICIÓN',
  NO_DECIDIR: 'NO DECIDIR',
};

const CONFIDENCE_COLOR: Record<DecisionConfidence, string> = {
  ALTA: '#02c076',
  MEDIA: '#f0b90b',
  BAJA: '#f6465d',
  NULA: '#5e6673',
};

const money = (v: number | null | undefined) => (v == null ? 'no verificable' : `${v.toFixed(2)} VES`);
const signed = (v: number | null | undefined, d = 2) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const percent = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);

/** Flecha por el signo del movimiento esperado. Sin movimiento, raya. */
const MoveIcon: React.FC<{ movePct: number | null }> = ({ movePct }) => {
  if (movePct === null) return <Minus size={13} className="text-[#5e6673]" />;
  if (movePct > 0) return <TrendingUp size={13} className="text-[#02c076]" />;
  if (movePct < 0) return <TrendingDown size={13} className="text-[#f6465d]" />;
  return <Minus size={13} className="text-[#848e9c]" />;
};

const LegCard: React.FC<{ leg: LegDecisionView; color: string; title: string; want: string }> = ({
  leg,
  color,
  title,
  want,
}) => (
  <section className="rounded-xl border border-[#2b2f36] bg-[#111417] p-4">
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color }}>
          {title}
        </div>
        <div className="mt-0.5 text-[9px] text-[#5e6673]">
          Binance {leg.binanceSide} · {want}
        </div>
      </div>
      <div className="text-right">
        <div className="text-[9px] uppercase tracking-wider text-[#5e6673]">Decisión {leg.horizon}h</div>
        <div className="text-xs font-bold" style={{ color: CONFIDENCE_COLOR[leg.confidence] }}>
          {DECISION_LABEL[leg.decision]}
        </div>
      </div>
    </div>

    {/* ── OBSERVACIÓN ── */}
    <div className="mt-3 text-[9px] uppercase tracking-wider text-[#5e6673]">Observación</div>
    <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-2">
        <div className="text-[8px] uppercase text-[#5e6673]">Precio ahora</div>
        <div className="font-mono text-base" style={{ color }}>{money(leg.currentPrice.value)}</div>
      </div>
      <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-2">
        <div className="text-[8px] uppercase text-[#5e6673]">Velocidad</div>
        <div className="font-mono text-sm text-[#eaecef]">{signed(leg.velocityPctPerHour.value, 3)}/h</div>
      </div>
      <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-2">
        <div className="text-[8px] uppercase text-[#5e6673]">Aceleración</div>
        <div className="font-mono text-sm text-[#eaecef]">{signed(leg.accelerationPctPerHour2.value, 3)}/h²</div>
      </div>
      <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-2">
        <div className="text-[8px] uppercase text-[#5e6673]">Volatilidad</div>
        <div className="font-mono text-sm text-[#eaecef]">
          {leg.volatilityPct.value === null ? '—' : `${leg.volatilityPct.value.toFixed(3)}%/h`}
        </div>
      </div>
    </div>

    {/* ── PREDICCIÓN ── */}
    <div className="mt-3 text-[9px] uppercase tracking-wider text-[#5e6673]">
      Predicción · {leg.model ?? 'sin modelo validado'}
    </div>
    <div className="mt-1 rounded-lg border border-[#2b2f36] bg-[#181a20] p-2.5">
      <div className="flex items-baseline gap-2">
        <MoveIcon movePct={leg.expectedMovePct.value} />
        <span className="font-mono text-xl" style={{ color }}>{money(leg.projectedPrice.value)}</span>
        <span className="font-mono text-[11px] text-[#848e9c]">{signed(leg.expectedMovePct.value)}</span>
      </div>
      <div className="mt-1 font-mono text-[10px] text-[#5e6673]">
        Rango: {money(leg.projectedLow.value)} – {money(leg.projectedHigh.value)}
      </div>
      <div className="mt-1 text-[10px] text-[#848e9c]">
        Error típico del modelo ±{leg.historicalErrorPct.value?.toFixed(2) ?? '—'}% · señal/ruido{' '}
        <b className="text-[#eaecef]">{leg.signalToNoise.value?.toFixed(2) ?? '—'}</b>
      </div>
    </div>

    {/* ── INCERTIDUMBRE ── */}
    <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px]">
      <span
        className="rounded px-1.5 py-0.5 font-bold"
        style={{ color: REGIME_COLOR[leg.regime], border: `1px solid ${REGIME_COLOR[leg.regime]}44` }}
      >
        {REGIME_LABEL[leg.regime]}
      </span>
      <span className="text-[#848e9c]">
        Continuación <b className="text-[#eaecef]">{percent(leg.continuationProbability.value)}</b>
      </span>
      <span className="text-[#848e9c]">
        Reversión <b className="text-[#eaecef]">{percent(leg.reversalProbability.value)}</b>
      </span>
      <span className="text-[#5e6673]">({leg.analogCases} casos análogos)</span>
      <span className="text-[#848e9c]">
        Confianza <b style={{ color: CONFIDENCE_COLOR[leg.confidence] }}>{leg.confidence}</b>
      </span>
    </div>

    {/* ── MOTIVO ── */}
    <p className="mt-2 border-t border-[#2b2f36] pt-2 text-[10px] leading-relaxed text-[#848e9c]">
      {leg.reason}
    </p>
  </section>
);

export const MarketDecisionPanel: React.FC = () => {
  const [report, setReport] = useState<MarketReadingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [horizon, setHorizon] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await ApiService.getMarketReading();
      setReport(next);
      setHorizon((h) => h ?? next.headlineHorizon);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'No se pudo cargar la lectura del mercado.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading && report === null) {
    return (
      <div className="rounded-xl border border-[#2b2f36] bg-[#1e2329] p-6 text-sm text-[#848e9c]">
        Midiendo el mercado general y validando modelos…
      </div>
    );
  }
  if (error && report === null) {
    return (
      <div className="rounded-xl border border-[#f6465d]/30 bg-[#1e2329] p-6 text-sm text-[#f6465d]">
        {error}
        <button type="button" onClick={() => void load()} className="ml-3 underline">Reintentar</button>
      </div>
    );
  }
  if (!report) return null;

  const active = horizon ?? report.headlineHorizon;
  const venta = report.venta.find((d) => d.horizon === active) ?? null;
  const compra = report.compra.find((d) => d.horizon === active) ?? null;
  const horizons = report.venta.map((d) => d.horizon);
  const testRow = report.walkForward.test.find((m) => m.horizon === active) ?? null;

  return (
    <div className="space-y-4 rounded-xl border border-[#2b2f36] bg-[#1e2329] p-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold tracking-wide text-[#eaecef]">
            <Activity size={16} className="text-[#f0b90b]" />
            LECTURA DEL MERCADO · GENERAL USDT/VES
          </h2>
          <p className="mt-1 text-[10px] text-[#5e6673]">
            {report.observedHours} horas observadas · {report.capturesPerHour ?? '—'} capturas/hora ·
            mercado general, sin banco ni monto.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="text-[#848e9c] hover:text-[#eaecef]" title="Actualizar">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      {/* ── DECISIÓN CONJUNTA ── */}
      <section className="rounded-lg border border-[#2b2f36] bg-[#111417] p-3">
        <div className="text-[9px] uppercase tracking-wider text-[#5e6673]">Decisión · {active}h</div>
        <div className="mt-1 flex items-center gap-2">
          {report.decision === 'NO_DECIDIR' && <ShieldQuestion size={16} className="text-[#5e6673]" />}
          <span
            className="text-lg font-bold"
            style={{ color: report.decision === 'NO_DECIDIR' ? '#5e6673' : '#eaecef' }}
          >
            {DECISION_LABEL[report.decision]}
          </span>
        </div>
        <p className="mt-1 text-[10px] text-[#848e9c]">{report.reading}</p>
        {report.insufficientReason && (
          <p className="mt-1 text-[10px] text-[#f0b90b]">{report.insufficientReason}</p>
        )}
      </section>

      {/* ── HORIZONTES ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[9px] uppercase tracking-wider text-[#5e6673]">Horizonte:</span>
        {horizons.map((h) => (
          <button
            key={h}
            onClick={() => setHorizon(h)}
            className={`rounded border px-2.5 py-1 font-mono text-[11px] transition ${
              active === h
                ? 'border-[#f0b90b] bg-[#1e2329] text-[#f0b90b]'
                : 'border-[#2b2f36] text-[#848e9c] hover:text-[#e0e0e0]'
            }`}
          >
            +{h}h
          </button>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {venta && (
          <LegCard leg={venta} color={VENTA_COLOR} title="MI VENTA" want="máximo SELL · lo quiero alto" />
        )}
        {compra && (
          <LegCard leg={compra} color={COMPRA_COLOR} title="MI COMPRA" want="mínimo BUY · lo quiero bajo" />
        )}
      </div>

      {/* ── EVIDENCIA ── */}
      <section className="rounded-lg border border-[#2b2f36] bg-[#111417] p-3 text-[10px] leading-relaxed text-[#848e9c]">
        <div className="font-bold uppercase tracking-wider text-[#e0e0e0]">Evidencia</div>
        {report.walkForward.evaluable ? (
          <>
            <p className="mt-1">
              Walk-forward por tiempo: {report.walkForward.split.trainHours} h de entrenamiento,{' '}
              {report.walkForward.split.validationHours} h de validación (donde se elige el modelo) y{' '}
              {report.walkForward.split.testHours} h de test, que sólo se leen para reportar.
            </p>
            {testRow ? (
              <p className="mt-1">
                A {active}h ganó <b className="text-[#eaecef]">{testRow.model}</b>. Fuera de muestra:
                dirección acertada{' '}
                <b className="text-[#eaecef]">
                  {testRow.directionAccuracy !== null ? `${(testRow.directionAccuracy * 100).toFixed(1)}%` : '—'}
                </b>{' '}
                ({testRow.directionHits}/{testRow.directionTotal}); cuando se moja acierta{' '}
                <b className="text-[#eaecef]">
                  {testRow.signalAccuracy !== null ? `${(testRow.signalAccuracy * 100).toFixed(1)}%` : '—'}
                </b>{' '}
                ({testRow.signals} señales) y se abstiene el{' '}
                {testRow.abstentionRate !== null ? `${(testRow.abstentionRate * 100).toFixed(0)}%` : '—'} del tiempo.
              </p>
            ) : (
              <p className="mt-1 text-[#f0b90b]">
                A {active}h ningún modelo superó al azar con evidencia: por eso la decisión es NO DECIDIR.
              </p>
            )}
          </>
        ) : (
          <p className="mt-1 text-[#f0b90b]">{report.walkForward.reason}</p>
        )}
        {report.dataProvenance.unverifiedRecords > 0 && (
          <p className="mt-2 text-[#f0b90b]">
            ⚠ {report.dataProvenance.unverifiedRecords} de {report.dataProvenance.totalRecords} observaciones
            son anteriores al filtro de Recarga Pines y no se puede confirmar que lo excluyan. Se usan igual,
            sin descartarlas ni inventar que están limpias.
          </p>
        )}
      </section>
    </div>
  );
};
