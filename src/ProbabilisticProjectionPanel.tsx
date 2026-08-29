/**
 * PROYECCIÓN PROBABILÍSTICA DEL MERCADO
 * =====================================
 *
 * Esta pantalla promete exactamente lo que el motor puede demostrar:
 *
 *   - Cada porcentaje es un RECUENTO. Debajo está la frase "En situaciones
 *     históricas similares, X de N casos terminaron por encima del precio
 *     actual", y el detalle abre los N casos con su fecha.
 *   - Cada porcentaje va con su INTERVALO al 95%. Un 74% sobre 40 casos y un
 *     74% sobre 400 no son lo mismo, y aquí se ve la diferencia.
 *   - Cada horizonte lleva un ESTADO explícito. Sólo READY significa que puede
 *     usarse; INSUFFICIENT_DATA, INSUFFICIENT_ANALOGIES, LOW_CONFIDENCE y
 *     NO_EDGE se muestran tal cual, sin maquillar.
 *   - Se publica la CALIBRACIÓN: si lo anunciado al 70% ocurre el 45% de las
 *     veces, se dice.
 *
 * TENDENCIA CONTRA EL RÉGIMEN. El bolívar se deprecia de forma estructural, así
 * que "sube" no puede significar "delta > 0": significaría ALCISTA siempre.
 * ALCISTA aquí quiere decir "sube MÁS de lo que este mercado sube por defecto",
 * y la deriva contra la que se compara está en el detalle.
 *
 * Este componente NO CALCULA NADA. Todos los valores llegan del servidor.
 */

import React, { useEffect, useState } from 'react';
import { Activity, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { ApiService } from './api';
import {
  BaselineReport,
  HorizonProjection,
  MarketProjectionResponse,
  MarketSideProjection,
  ProjectionStatus,
} from './types';
import { NO_DATA, fmt, fmtInt } from './format';
import { ProbabilisticProjectionChart } from './ProbabilisticProjectionChart';

const DIRECTION_STYLE: Record<string, { label: string; className: string }> = {
  ALCISTA: { label: '🟢 ALCISTA', className: 'text-[#02c076]' },
  LATERAL: { label: '🟡 LATERAL', className: 'text-[#f0b90b]' },
  BAJISTA: { label: '🔴 BAJISTA', className: 'text-[#f6465d]' },
  INDETERMINADA: { label: '⚪ INDETERMINADA', className: 'text-[#848e9c]' },
};

const STRENGTH_LABEL: Record<string, string> = {
  MUY_DEBIL: 'muy débil',
  DEBIL: 'débil',
  MODERADA: 'moderada',
  FUERTE: 'fuerte',
  MUY_FUERTE: 'muy fuerte',
};

const STATUS_STYLE: Record<ProjectionStatus, string> = {
  READY: 'text-[#02c076] border-[#02c076]/40 bg-[#02c076]/5',
  INSUFFICIENT_DATA: 'text-[#848e9c] border-[#848e9c]/40 bg-[#848e9c]/5',
  INSUFFICIENT_ANALOGIES: 'text-[#848e9c] border-[#848e9c]/40 bg-[#848e9c]/5',
  LOW_CONFIDENCE: 'text-[#f0b90b] border-[#f0b90b]/40 bg-[#f0b90b]/5',
  NO_EDGE: 'text-[#f6465d] border-[#f6465d]/40 bg-[#f6465d]/5',
};

const pct = (v: number | null) =>
  v === null || !Number.isFinite(v) ? NO_DATA : `${Math.round(v * 100)}%`;

const stamp = (ts: number | null) =>
  ts === null
    ? NO_DATA
    : new Date(ts).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' });

const hhmm = (ts: number | null) =>
  ts === null
    ? NO_DATA
    : new Date(ts).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });

const StatusChip: React.FC<{ status: ProjectionStatus }> = ({ status }) => (
  <span className={`px-1.5 py-0.5 rounded border text-[9px] font-semibold ${STATUS_STYLE[status]}`}>
    {status}
  </span>
);

/* ------------------------------------------------------------------------ */

const HorizonRow: React.FC<{ horizon: HorizonProjection }> = ({ horizon }) => {
  const [open, setOpen] = useState(false);

  if (!horizon.available) {
    return (
      <tr className="border-t border-[#2b2f36]">
        <td className="py-2 px-2 font-mono text-[#eaecef] whitespace-nowrap">
          {horizon.label}
          <div className="text-[9px] text-[#5e6673]">{hhmm(horizon.estimatedAt)}</div>
        </td>
        <td className="py-2 px-2" colSpan={5}>
          <StatusChip status={horizon.status} />
          <span className="text-[#848e9c] text-[10px] ml-2">{horizon.statusText}</span>
        </td>
      </tr>
    );
  }

  const style = DIRECTION_STYLE[horizon.direction ?? 'INDETERMINADA'];
  const audit = horizon.audit;

  return (
    <>
      <tr className="border-t border-[#2b2f36]">
        <td className="py-2 px-2 font-mono text-[#eaecef] whitespace-nowrap">
          {horizon.label}
          <div className="text-[9px] text-[#5e6673]">{hhmm(horizon.estimatedAt)}</div>
        </td>
        <td className="py-2 px-2 whitespace-nowrap">
          <span className={style.className}>{style.label}</span>
          <div className="text-[9px] text-[#848e9c]">
            fuerza {STRENGTH_LABEL[horizon.strength ?? 'MUY_DEBIL']}
          </div>
          <StatusChip status={horizon.status} />
        </td>
        <td className="py-2 px-2 font-mono text-right text-[#eaecef]">{fmt(horizon.central)}</td>
        <td className="py-2 px-2 font-mono text-right text-[#848e9c] whitespace-nowrap">
          {fmt(horizon.low)} – {fmt(horizon.high)}
        </td>
        <td className="py-2 px-2 text-right whitespace-nowrap">
          <span className="text-[#02c076]">{pct(horizon.probabilityUp)}</span>
          <span className="text-[#5e6673]"> / </span>
          <span className="text-[#f0b90b]">{pct(horizon.probabilityFlat)}</span>
          <span className="text-[#5e6673]"> / </span>
          <span className="text-[#f6465d]">{pct(horizon.probabilityDown)}</span>
          <div className="text-[9px] text-[#5e6673]">
            sube: IC95% {pct(horizon.probabilityUpLow)}–{pct(horizon.probabilityUpHigh)}
          </div>
        </td>
        <td className="py-2 px-2 text-right">
          <button
            onClick={() => setOpen(!open)}
            className="text-[10px] text-[#848e9c] hover:text-[#f0b90b] flex items-center gap-1 ml-auto"
          >
            {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {audit?.analoguesUsed ?? 0} casos
          </button>
        </td>
      </tr>

      {open && audit && (
        <tr className="bg-[#0d0f14]">
          <td colSpan={6} className="px-3 py-3 text-[10px] text-[#848e9c]">
            <p className="text-[#eaecef] mb-2">{horizon.evidence}</p>

            <p className="text-[#eaecef] mb-1">Escenarios (grupos disjuntos de esos casos):</p>
            <table className="w-full mb-3 border border-[#2b2f36] rounded">
              <tbody>
                {horizon.scenarios.map((s) => (
                  <tr key={s.kind} className="border-b border-[#1a1d23] last:border-0">
                    <td className="px-2 py-1 font-semibold">{s.kind}</td>
                    <td className="px-2 py-1 text-right font-mono">{s.cases} casos</td>
                    <td className="px-2 py-1 text-right font-mono">
                      {pct(s.probability)}
                      <span className="text-[#5e6673]">
                        {' '}
                        (IC95% {pct(s.probabilityLow)}–{pct(s.probabilityHigh)})
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right font-mono">
                      {s.hasRange ? (
                        `${fmt(s.low)} – ${fmt(s.high)}`
                      ) : (
                        <span className="text-[#5e6673]">sin rango: muy pocos casos</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1 mb-3">
              <span>
                Casos comparables: <b className="text-[#eaecef]">{audit.analoguesUsed}</b> de{' '}
                {fmtInt(audit.candidatePool)} instantes posibles
              </span>
              <span>
                Horizonte medido: <b className="text-[#eaecef]">{audit.horizonSteps}</b>{' '}
                observaciones ={' '}
                {audit.measuredHorizonMs === null
                  ? NO_DATA
                  : `${Math.round(audit.measuredHorizonMs / 60000)} min`}
              </span>
              <span>
                Ventana de contexto: <b className="text-[#eaecef]">{audit.lookbackSteps}</b>{' '}
                observaciones
              </span>
              <span>
                Deriva del régimen: <b className="text-[#eaecef]">{fmt(audit.regimeDelta, 4)}</b> VES
              </span>
              <span>
                Movimiento típico: <b className="text-[#eaecef]">{fmt(audit.typicalStep, 4)}</b> VES
              </span>
              <span>
                Percentiles 10/50/90: {fmt(audit.p10, 4)} / {fmt(audit.p50, 4)} / {fmt(audit.p90, 4)}
              </span>
              <span>Distancia máxima aceptada: {fmt(audit.maxDistanceUsed, 3)}</span>
              <span>
                Ventanas independientes: <b className="text-[#eaecef]">{audit.independentAnalogues}</b>
              </span>
            </div>

            <p className="mb-1 text-[#eaecef]">
              Los casos concretos (fecha, precio de entonces, y qué hizo después):
            </p>
            <div className="max-h-40 overflow-y-auto border border-[#2b2f36] rounded">
              <table className="w-full text-[10px]">
                <tbody>
                  {audit.samples.map((sample) => (
                    <tr key={sample.t} className="border-b border-[#1a1d23] last:border-0">
                      <td className="px-2 py-1 font-mono">{stamp(sample.t)}</td>
                      <td className="px-2 py-1 font-mono text-right">{fmt(sample.price)}</td>
                      <td
                        className={`px-2 py-1 font-mono text-right ${
                          sample.delta > 0
                            ? 'text-[#02c076]'
                            : sample.delta < 0
                              ? 'text-[#f6465d]'
                              : ''
                        }`}
                      >
                        {sample.delta > 0 ? '+' : ''}
                        {fmt(sample.delta, 4)}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {sample.outcome === 'UP'
                          ? 'sube'
                          : sample.outcome === 'DOWN'
                            ? 'baja'
                            : 'lateral'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
};

/* ------------------------------------------------------------------------ */

const CalibrationTable: React.FC<{ baseline: BaselineReport }> = ({ baseline }) => {
  const used = baseline.calibration.buckets.filter((b) => b.predictions > 0);
  if (used.length === 0) return null;

  return (
    <div className="mt-2">
      <p className="text-[10px] text-[#eaecef] mb-1">
        Calibración de {baseline.label}: ¿ocurre el 70% de lo anunciado al 70%?
      </p>
      <table className="w-full text-[10px]">
        <thead className="text-[#5e6673]">
          <tr>
            <th className="text-left py-1 px-2">Bucket</th>
            <th className="text-right py-1 px-2">Predicciones</th>
            <th className="text-right py-1 px-2">Prometido</th>
            <th className="text-right py-1 px-2">Observado</th>
            <th className="text-right py-1 px-2">Veredicto</th>
          </tr>
        </thead>
        <tbody className="text-[#848e9c]">
          {used.map((b) => (
            <tr key={b.from} className="border-t border-[#2b2f36]">
              <td className="py-1 px-2 font-mono">
                {pct(b.from)}–{pct(b.to)}
              </td>
              <td className="py-1 px-2 text-right font-mono">{b.predictions}</td>
              <td className="py-1 px-2 text-right font-mono">{pct(b.meanPredicted)}</td>
              <td className="py-1 px-2 text-right font-mono">{pct(b.observedFrequency)}</td>
              <td
                className={`py-1 px-2 text-right ${
                  b.overconfident ? 'text-[#f6465d] font-semibold' : ''
                }`}
              >
                {b.overconfident ? 'EXCESO DE CONFIANZA' : 'dentro del margen'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[9px] text-[#5e6673] mt-1">
        Brier {fmt(baseline.calibration.brier, 4)} frente a {fmt(baseline.calibration.brierBaseline, 4)} de
        la climatología (predecir siempre la frecuencia base). Menor es mejor; no bajar de la
        climatología significa no aportar información sobre el caso concreto.
      </p>
    </div>
  );
};

const BaselineTable: React.FC<{ side: MarketSideProjection }> = ({ side }) => {
  const tested = side.baselines.filter((b) => b.reason === null);

  if (tested.length === 0) {
    return (
      <p className="text-[10px] text-[#848e9c]">
        Todavía no hay anclas suficientes para contrastar el modelo contra la persistencia en
        ningún horizonte. Sin ese contraste ninguna proyección puede presentarse como utilizable.
      </p>
    );
  }

  return (
    <>
      <table className="w-full text-[10px]">
        <thead className="text-[#5e6673]">
          <tr>
            <th className="text-left py-1 px-2">Horizonte</th>
            <th className="text-right py-1 px-2">Predicciones</th>
            <th className="text-right py-1 px-2">Error modelo</th>
            <th className="text-right py-1 px-2">Error persistencia</th>
            <th className="text-right py-1 px-2">Gana modelo</th>
            <th className="text-right py-1 px-2">Cobertura</th>
            <th className="text-right py-1 px-2">p / umbral</th>
            <th className="text-right py-1 px-2">Veredicto</th>
          </tr>
        </thead>
        <tbody className="text-[#848e9c]">
          {tested.map((b) => (
            <tr key={b.requestedHorizonMs} className="border-t border-[#2b2f36]">
              <td className="py-1 px-2 font-mono text-[#eaecef]">{b.label}</td>
              <td className="py-1 px-2 text-right font-mono">{b.anchors}</td>
              <td className="py-1 px-2 text-right font-mono">{fmt(b.modelMedianAbsError, 4)}</td>
              <td className="py-1 px-2 text-right font-mono">
                {fmt(b.persistenceMedianAbsError, 4)}
              </td>
              <td className="py-1 px-2 text-right font-mono">
                {b.modelBetterCount} / {b.modelBetterCount + b.persistenceBetterCount}
              </td>
              <td className="py-1 px-2 text-right font-mono">
                {pct(b.bandCoverage)}
                <span className="text-[#5e6673]"> / {pct(b.coverageTarget)}</span>
              </td>
              <td className="py-1 px-2 text-right font-mono">
                {b.pValue === null ? NO_DATA : b.pValue.toFixed(4)} /{' '}
                {b.alpha === null ? NO_DATA : b.alpha.toFixed(4)}
              </td>
              <td
                className={`py-1 px-2 text-right font-semibold ${
                  b.beatsPersistence ? 'text-[#02c076]' : 'text-[#f6465d]'
                }`}
              >
                {b.beatsPersistence ? 'SUPERA' : 'NO_EDGE'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tested.map((b) => (
        <CalibrationTable key={b.requestedHorizonMs} baseline={b} />
      ))}
    </>
  );
};

/* ------------------------------------------------------------------------ */

const SideBlock: React.FC<{ side: MarketSideProjection }> = ({ side }) => {
  /*
   * La cabecera muestra el horizonte publicable más corto: es el que más
   * evidencia tiene detrás. No se promedian los horizontes — cuando discrepan,
   * la discrepancia es información, no un problema que haya que suavizar.
   */
  const headline = side.horizons.find((h) => h.available) ?? null;
  const style = headline ? DIRECTION_STYLE[headline.direction ?? 'INDETERMINADA'] : null;

  return (
    <div className="border border-[#2b2f36] rounded bg-[#181a20] mb-4">
      <div className="px-3 py-2 border-b border-[#2b2f36]">
        <h3 className="text-xs font-semibold text-[#eaecef]">{side.label}</h3>
        <p className="text-[10px] text-[#848e9c]">
          {fmtInt(side.observations)} observaciones ·{' '}
          {side.medianIntervalMs === null
            ? 'cadencia no medible'
            : `1 cada ${Math.round(side.medianIntervalMs / 1000)} s`}{' '}
          · {stamp(side.firstTimestamp)} → {stamp(side.lastTimestamp)}
          {side.extraction.droppedLegacy > 0 && (
            <>
              {' '}
              ·{' '}
              <span className="text-[#f0b90b]">
                {fmtInt(side.extraction.droppedLegacy)} registros antiguos descartados (sin precio
                estratégico; no se rellenan)
              </span>
            </>
          )}
        </p>
      </div>

      {side.notice && (
        <div className="mx-3 mt-3 px-3 py-2 rounded border border-[#f0b90b]/40 bg-[#f0b90b]/5 text-[10px] text-[#f0b90b]">
          {side.notice}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-3">
        <div>
          <p className="text-[10px] text-[#5e6673] uppercase">Precio actual</p>
          <p className="text-lg font-mono text-[#eaecef]">{fmt(side.currentPrice)}</p>
        </div>
        <div>
          <p className="text-[10px] text-[#5e6673] uppercase">Dirección</p>
          <p className={`text-base font-semibold ${style?.className ?? 'text-[#848e9c]'}`}>
            {style?.label ?? 'SIN LECTURA'}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-[#5e6673] uppercase">Fuerza</p>
          <p className="text-base text-[#eaecef]">
            {headline ? STRENGTH_LABEL[headline.strength ?? 'MUY_DEBIL'] : NO_DATA}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-[#5e6673] uppercase">Movimiento típico</p>
          <p className="text-base font-mono text-[#eaecef]">{fmt(side.typicalStep, 4)}</p>
        </div>
      </div>

      <div className="px-3 pb-3">
        <ProbabilisticProjectionChart projection={side} />
      </div>

      <div className="px-1 pb-2 overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="text-[#5e6673]">
            <tr>
              <th className="text-left py-1 px-2">Horizonte</th>
              <th className="text-left py-1 px-2">Dirección / fuerza</th>
              <th className="text-right py-1 px-2">Escenario central</th>
              <th className="text-right py-1 px-2">Rango probable</th>
              <th className="text-right py-1 px-2">Sube / Lateral / Baja</th>
              <th className="text-right py-1 px-2">Evidencia</th>
            </tr>
          </thead>
          <tbody>
            {side.horizons.map((h) => (
              <HorizonRow key={h.requestedHorizonMs} horizon={h} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-3 py-3 border-t border-[#2b2f36]">
        <h4 className="text-[11px] font-semibold text-[#eaecef] mb-1">
          Contraste contra “el precio se queda donde está”
        </h4>
        <p className="text-[10px] text-[#848e9c] mb-2">
          Se compara, ancla por ancla y sin ver el futuro, quién se acercó más al precio real: el
          escenario central del modelo o el precio de ese momento. El umbral se reparte entre todos
          los contrastes simultáneos, para que mirar muchos horizontes no acabe validando uno por
          casualidad.
        </p>
        <BaselineTable side={side} />
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------ */

export const ProbabilisticProjectionPanel: React.FC = () => {
  const [data, setData] = useState<MarketProjectionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setData(await ApiService.getAnalogProjection());
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Error cargando la proyección');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-[#eaecef] flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#f0b90b]" />
            Proyección del Mercado — probabilística por analogía
          </h2>
          <p className="text-[10px] text-[#848e9c] max-w-3xl">
            Cada probabilidad de esta pantalla es un recuento de situaciones históricas parecidas a
            la actual, no la salida de una fórmula. Pulsa “casos” en cualquier fila para ver las
            fechas exactas de las que salió el número. Fuente:{' '}
            <span className="font-mono">{data?.source ?? 'market_history.json'}</span>.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-[10px] text-[#848e9c] hover:text-[#f0b90b] flex items-center gap-1 shrink-0"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          Actualizar
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded border border-[#f6465d]/40 bg-[#f6465d]/5 text-[10px] text-[#f6465d] mb-3">
          {error}
        </div>
      )}

      {!data && !error && <p className="text-[10px] text-[#848e9c]">Leyendo el histórico…</p>}

      {data && !data.usable && (
        <div className="px-3 py-2 rounded border border-[#f0b90b]/40 bg-[#f0b90b]/5 text-[10px] text-[#f0b90b] mb-3">
          Ningún horizonte ha alcanzado el estado READY. Lo que se muestra abajo es una lectura del
          histórico, no una recomendación de operación.
        </div>
      )}

      {data?.sides.map((side) => <SideBlock key={side.side} side={side} />)}
    </div>
  );
};
