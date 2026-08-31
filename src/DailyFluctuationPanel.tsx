/**
 * PROYECCIÓN DE FLUCTUACIÓN DIARIA — MI VENTA Y MI COMPRA
 * ======================================================
 *
 * Responde: con lo que sabemos de los días anteriores y con lo que ha ocurrido
 * hoy hasta ahora, ¿qué precios cabe esperar para MI VENTA y MI COMPRA en las
 * horas que quedan?
 *
 * ═══ LA PANTALLA NOMBRA LA OPERACIÓN, NO EL LADO DE BINANCE ═══
 *
 *   MI VENTA  (Binance BUY)   → arriba → TECHO
 *   MI COMPRA (Binance SELL)  → abajo  → PISO
 *
 * Cada rótulo lleva el lado de Binance entre paréntesis para que la traducción
 * quede a la vista y nadie tenga que recordarla.
 *
 * ═══ DOS PROYECCIONES INDEPENDIENTES ═══
 *
 * Las dos piernas se proyectan por separado y no se derivan una de otra:
 * aplicar el spread de hoy a la proyección de la otra daría una línea que
 * ninguna serie respalda.
 *
 * ═══ LO QUE ESTA PANTALLA SE NIEGA A HACER ═══
 *
 *   - Dibujar proyección sin días que la sostengan.
 *   - Llamar percentil a la banda con menos de 10 días.
 *   - Decir "compra ahora" o "vende ahora". Dice qué evidencia hay y de qué
 *     tamaño, y la decisión la toma quien opera.
 *   - Calcular. Todo llega del servidor.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpToLine, CalendarClock, RefreshCw } from 'lucide-react';
import { ApiService } from './api';
import {
  DailyEvidenceLevel,
  DailyExtreme,
  DailyLegReport,
  DailyProjectionResponse,
} from './types';
import { DailyFluctuationChart } from './DailyFluctuationChart';
import { hourLabel } from './dailyChartRows';

const DIRECTION_TEXT: Record<string, string> = {
  SUBIENDO: 'SUBIENDO',
  BAJANDO: 'BAJANDO',
  LATERAL: 'SIN RUMBO',
  INDETERMINADA: 'SIN MEDIR',
};

const SPEED_TEXT: Record<string, string> = {
  LENTO: 'LENTO',
  MODERADO: 'MODERADO',
  RAPIDO: 'RÁPIDO',
  INDETERMINADA: '',
};

const EVIDENCE_COLOR: Record<DailyEvidenceLevel, string> = {
  SIN_DATOS_SUFICIENTES: '#5e6673',
  SOLO_OBSERVACION: '#848e9c',
  ESTIMACION_SIN_VALIDAR: '#f0b90b',
  EVIDENCIA_DEBIL: '#f0b90b',
  EVIDENCIA_FUERTE: '#02c076',
};

const EVIDENCE_SHORT: Record<DailyEvidenceLevel, string> = {
  SIN_DATOS_SUFICIENTES: 'SIN DATOS SUFICIENTES',
  SOLO_OBSERVACION: 'SÓLO OBSERVACIÓN',
  ESTIMACION_SIN_VALIDAR: 'ESTIMACIÓN SIN VALIDAR',
  EVIDENCIA_DEBIL: 'EVIDENCIA DÉBIL',
  EVIDENCIA_FUERTE: 'EVIDENCIA FUERTE',
};

const money = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(2));
const signed = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

/**
 * Techo o piso, con sus tres piezas separadas: lo observado, lo proyectado y el
 * mejor de los dos. Fundirlos en un número borraría qué parte ya ocurrió.
 */
const ExtremeCard: React.FC<{
  title: string;
  extreme: DailyExtreme;
  color: string;
  icon: React.ReactNode;
}> = ({ title, extreme, color, icon }) => (
  <div className="bg-[#181a20] border border-[#2b2f36] rounded p-3 flex-1 min-w-[210px]">
    <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-[#5e6673]">
      {icon}
      {title}
      <span className="normal-case tracking-normal text-[#5e6673]">
        · Binance {extreme.binanceSide}
      </span>
    </div>
    <div className="text-2xl font-semibold font-mono mt-1" style={{ color }}>
      {money(extreme.dayBest)}
      {extreme.dayBest !== null && (
        <span className="text-[9px] ml-2 font-sans font-normal text-[#5e6673] uppercase">
          {extreme.dayBestIsProjected ? 'proyectado' : 'ocurrió'}
        </span>
      )}
    </div>
    <div className="text-[10px] text-[#848e9c] mt-1.5 leading-relaxed">
      <div>
        observado hoy:{' '}
        <span className="font-mono text-[#eaecef]">{money(extreme.observed?.price)}</span>
        {extreme.observed && ` · ${hourLabel(extreme.observed.hour)}`}
      </div>
      <div>
        proyectado:{' '}
        <span className="font-mono text-[#eaecef]">{money(extreme.projected?.price)}</span>
        {extreme.projected && (
          <span className="text-[#5e6673]">
            {' '}
            ({money(extreme.projected.low)}–{money(extreme.projected.high)}) ·{' '}
            {extreme.projected.daysUsed} días
          </span>
        )}
      </div>
    </div>
  </div>
);

/** Ficha de una pierna: ahora, extremos, cierre y qué evidencia la sostiene. */
const LegCard: React.FC<{ report: DailyLegReport; color: string }> = ({ report, color }) => {
  const p = report.projection;
  const b = report.backtest;

  return (
    <div className="bg-[#181a20] border border-[#2b2f36] rounded p-3 flex-1 min-w-[280px]">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-bold tracking-wide" style={{ color }}>
          {report.label}
        </span>
        <span
          className="text-[9px] font-semibold"
          style={{ color: EVIDENCE_COLOR[report.evidence] }}
        >
          {EVIDENCE_SHORT[report.evidence]}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-[10px]">
        <div className="text-[#848e9c]">Ahora</div>
        <div className="font-mono text-[#eaecef] text-right">{money(p.anchorPrice)}</div>

        <div className="text-[#848e9c]">
          {p.leg === 'VENTA' ? 'Máximo observado' : 'Mínimo observado'}
        </div>
        <div className="font-mono text-[#eaecef] text-right">{money(p.observedExtreme?.price)}</div>

        <div className="text-[#848e9c]">
          {p.leg === 'VENTA' ? 'Máximo proyectado' : 'Mínimo proyectado'}
        </div>
        <div className="font-mono text-right" style={{ color }}>
          {money(p.projectedExtreme?.central)}
        </div>

        <div className="text-[#848e9c]">Cierre proyectado</div>
        <div className="font-mono text-right" style={{ color }}>
          {money(p.projectedClose?.central)}
        </div>

        <div className="text-[#848e9c]">Rango al cierre</div>
        <div className="font-mono text-[#848e9c] text-right">
          {p.projectedClose
            ? `${money(p.projectedClose.low)}–${money(p.projectedClose.high)}`
            : '—'}
        </div>

        <div className="text-[#848e9c]">Mercado</div>
        <div className="text-right">
          {DIRECTION_TEXT[report.market.direction]}{' '}
          <span className="text-[#5e6673]">{SPEED_TEXT[report.market.speed]}</span>{' '}
          <span className="font-mono">{signed(report.market.changePct)}</span>
        </div>
      </div>

      <div className="text-[9px] text-[#5e6673] mt-2 leading-relaxed border-t border-[#2b2f36] pt-2">
        {p.projectedClose && (
          <div>
            Banda:{' '}
            {p.projectedClose.bandKind === 'P10_P90'
              ? 'P10–P90'
              : 'rango observado (menos de 10 días: llamarlo percentil sería exagerar)'}{' '}
            · {p.projectedClose.daysUsed} días
          </div>
        )}
        <div>
          Perfil: {p.profileDays} de {p.candidateDays} días
          {p.conditioned
            ? ` · condicionado por ${p.conditioningFactors.join(' y ')}`
            : ' · sin condicionar (no hay días de sobra)'}
        </div>
        <div>
          Backtest temporal: {b.days === 0 ? 'sin días evaluables' : `${b.days} días, ${b.anchors} anclas`}
          {b.days > 0 && (
            <>
              {' '}· error de cierre {b.closeErrorModel?.toFixed(2) ?? '—'} frente a{' '}
              {b.closeErrorPersistence?.toFixed(2) ?? '—'} de la persistencia
              {b.coverage !== null && ` · cobertura ${(b.coverage * 100).toFixed(0)}%`}
              {b.directionTotal > 0 &&
                ` · dirección ${b.directionHits}/${b.directionTotal}`}
              {b.pValue !== null && ` · p = ${b.pValue.toFixed(3)}`}
            </>
          )}
        </div>
        <div style={{ color: EVIDENCE_COLOR[report.evidence] }}>{report.evidenceText}</div>
      </div>
    </div>
  );
};

export const DailyFluctuationPanel: React.FC = () => {
  const [report, setReport] = useState<DailyProjectionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await ApiService.getDailyProjection());
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'No se pudo cargar la proyección diaria');
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
      <div className="bg-[#1e2329] border border-[#2b2f36] rounded-lg p-6 text-[#848e9c] text-sm">
        Cargando proyección diaria…
      </div>
    );
  }

  if (error !== null && report === null) {
    return (
      <div className="bg-[#1e2329] border border-[#2b2f36] rounded-lg p-6">
        <div className="text-[#f6465d] text-sm font-semibold">{error}</div>
        <button onClick={() => void load()} className="mt-3 text-[11px] text-[#f0b90b] underline">
          Reintentar
        </button>
      </div>
    );
  }

  if (report === null) return null;

  const venta = report.legs.find((l) => l.projection.leg === 'VENTA');
  const compra = report.legs.find((l) => l.projection.leg === 'COMPRA');
  const drawable = report.tier === 'PERFIL_LIMITADO' || report.tier === 'PERFIL_CONDICIONADO';

  return (
    <div className="bg-[#1e2329] border border-[#2b2f36] rounded-lg p-5">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h2 className="text-[#eaecef] font-bold tracking-wide flex items-center gap-2">
            <CalendarClock size={16} className="text-[#f0b90b]" />
            PROYECCIÓN DE FLUCTUACIÓN DIARIA
          </h2>
          <div className="text-[10px] text-[#5e6673] mt-1">
            {hourLabel(report.startHour)} – {hourLabel(report.endHour)} · hora de Venezuela ·
            línea punteada = proyección · VES
          </div>
          <div className="text-[10px] text-[#848e9c] mt-1">
            <span className="text-[#f0b90b]">MI VENTA = Binance BUY</span>
            <span className="text-[#5e6673]"> · </span>
            <span className="text-[#02c076]">MI COMPRA = Binance SELL</span>
          </div>
        </div>
        <button
          onClick={() => void load()}
          className="text-[#848e9c] hover:text-[#eaecef]"
          title="Actualizar"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* TECHO Y PISO. Cada uno de SU pierna; nunca se comparan entre sí. */}
      <div className="flex flex-wrap gap-3 my-4">
        <ExtremeCard
          title="Techo del día · mi venta"
          extreme={report.ceiling}
          color="#f0b90b"
          icon={<ArrowUpToLine size={11} />}
        />
        <ExtremeCard
          title="Piso del día · mi compra"
          extreme={report.floor}
          color="#02c076"
          icon={<ArrowDownToLine size={11} />}
        />
        <div className="bg-[#181a20] border border-[#2b2f36] rounded p-3 min-w-[150px]">
          <div className="text-[9px] uppercase tracking-wider text-[#5e6673]">Margen máximo</div>
          <div className="text-2xl font-semibold font-mono mt-1 text-[#eaecef]">
            {report.maxSpread ? `${report.maxSpread.spreadPct.toFixed(2)}%` : '—'}
          </div>
          <div className="text-[10px] text-[#848e9c] mt-1.5">
            {report.maxSpread ? `a las ${hourLabel(report.maxSpread.hour)}` : 'sin medir'}
            <div className="text-[9px] text-[#5e6673]">(venta − compra) / compra, misma hora</div>
          </div>
        </div>
        <div className="bg-[#181a20] border border-[#2b2f36] rounded p-3 min-w-[150px]">
          <div className="text-[9px] uppercase tracking-wider text-[#5e6673]">Ahora</div>
          <div
            className={`text-2xl font-semibold mt-1 ${report.turningNow ? 'text-[#f0b90b]' : 'text-[#848e9c]'}`}
          >
            {report.turningNow ? 'GIRANDO' : 'SIN GIROS'}
          </div>
          <div className="text-[10px] text-[#848e9c] mt-1.5">
            {report.turn.pct === null
              ? 'sin umbral medido'
              : `umbral ±${report.turn.pct.toFixed(2)}% · ${report.turn.sampleSize} cambios`}
            <div className="text-[9px] text-[#5e6673]">
              queda por venir:{' '}
              {report.remainingPct === null ? '—' : `${report.remainingPct.toFixed(0)}%`}
            </div>
          </div>
        </div>
      </div>

      {/* SIN EVIDENCIA NO HAY CURVA. */}
      {!drawable && (
        <div className="bg-[#181a20] border border-[#2b2f36] rounded p-4 mb-4">
          <div className="text-[#f0b90b] text-sm font-semibold mb-1">
            Todavía no se puede proyectar el día
          </div>
          <div className="text-[11px] text-[#848e9c] leading-relaxed">
            {report.tierText}
            {report.daysMissing > 0 && (
              <>
                {' '}
                Faltan <strong className="text-[#eaecef]">{report.daysMissing}</strong> día
                {report.daysMissing === 1 ? '' : 's'} completo
                {report.daysMissing === 1 ? '' : 's'} de captura para dibujar la primera curva.
              </>
            )}
            {venta && venta.extraction.droppedLegacy > 0 && (
              <>
                {' '}
                Se descartaron {venta.extraction.droppedLegacy} registros antiguos sin precio
                estratégico: no se rellenan hacia atrás porque nadie observó esos valores.
              </>
            )}
          </div>
        </div>
      )}

      <DailyFluctuationChart report={report} />

      <div className="flex flex-wrap gap-4 mt-3 text-[10px] text-[#848e9c]">
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-0.5 bg-[#f0b90b]" /> MI VENTA (Binance BUY) ↑ techo
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-0.5 bg-[#02c076]" /> MI COMPRA (Binance SELL) ↓ piso
        </span>
        <span className="text-[#5e6673]">
          punto sólido = ocurrió · punto hueco y línea punteada = proyección
        </span>
      </div>

      <div className="flex flex-wrap gap-3 mt-4">
        {venta && <LegCard report={venta} color="#f0b90b" />}
        {compra && <LegCard report={compra} color="#02c076" />}
      </div>

      {/* QUÉ MIRA EL MODELO Y QUÉ NO. Sin esto habría que deducirlo del silencio. */}
      <details className="mt-4 pt-3 border-t border-[#2b2f36]">
        <summary className="text-[10px] text-[#848e9c] cursor-pointer">
          Variables que usa el modelo y las que no
        </summary>
        <div className="text-[10px] text-[#5e6673] mt-2 leading-relaxed">
          <div className="text-[#848e9c] mb-1">En uso:</div>
          <ul className="list-disc ml-4">
            {report.variables.used.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
          <div className="text-[#848e9c] mt-2 mb-1">Disponibles pero todavía no usadas:</div>
          <ul className="list-disc ml-4">
            {report.variables.availableNotUsed.map((v) => (
              <li key={v.name}>
                <strong className="text-[#848e9c]">{v.name}</strong>: {v.reason}
              </li>
            ))}
          </ul>
          <div className="mt-2">
            Fuente: {report.source} · precios estratégicos (mediana de cada lado del libro), no los
            extremos crudos del TOP 20 · {venta?.extraction.recordsRead ?? 0} registros leídos.
          </div>
        </div>
      </details>
    </div>
  );
};
