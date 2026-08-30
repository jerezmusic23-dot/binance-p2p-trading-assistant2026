/**
 * PROYECCIÓN DE FLUCTUACIÓN DIARIA
 * ================================
 *
 * Responde una pregunta que las otras pantallas no responden: qué le queda por
 * hacer al día de hoy, hora a hora, hasta el cierre de la jornada.
 *
 * ═══ POR QUÉ ES OTRO PANEL Y NO UNA PESTAÑA DEL ANTERIOR ═══
 *
 * `ProbabilisticProjectionPanel` proyecta a +15m, +1h, +4h buscando analogías
 * minuto a minuto, y para alcanzar las 8 de la tarde necesitaría ~18 días de
 * serie continua. Éste usa EL DÍA como unidad —qué hicieron los días anteriores
 * entre esta hora y el cierre— y empieza a poder decir algo con 5.
 *
 * Son dos estimadores distintos y se muestran separados a propósito. Promediar
 * sus curvas daría un número que ninguno de los dos respalda.
 *
 * ═══ LO QUE ESTA PANTALLA NO HACE ═══
 *
 *   - No dibuja proyección sin días que la sostengan: con menos de los mínimos
 *     enseña lo real de hoy y dice qué falta y cuánto.
 *   - No presenta una mediana de 5 días como si fuera de 50: `daysUsed` y el
 *     tipo de banda —percentil o rango observado— van escritos.
 *   - No afirma que el perfil sirva mientras no bata a la persistencia. Si no
 *     la bate, lo dice con todas las letras.
 *   - No calcula nada. Todo llega del servidor.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { CalendarClock, RefreshCw } from 'lucide-react';
import { ApiService } from './api';
import { DailyProjectionResponse } from './types';
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

const directionColor = (direction: string): string => {
  if (direction === 'SUBIENDO') return '#f6465d'; // pagar más caro es malo para quien compra
  if (direction === 'BAJANDO') return '#02c076';
  return '#848e9c';
};

const Metric: React.FC<{ label: string; children: React.ReactNode; hint?: string }> = ({
  label,
  children,
  hint,
}) => (
  <div className="min-w-[110px]">
    <div className="text-[9px] uppercase tracking-wider text-[#5e6673]">{label}</div>
    <div className="text-lg font-semibold leading-tight">{children}</div>
    {hint && <div className="text-[9px] text-[#5e6673] mt-0.5">{hint}</div>}
  </div>
);

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
      // El fallo se muestra; no se deja la pantalla anterior como si fuera de ahora.
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

  const drawable = report.tier === 'PERFIL_LIMITADO' || report.tier === 'PERFIL_CONDICIONADO';
  /*
   * El lado de recompra por su nombre, no por su posición en el array: es el
   * precio que el propietario paga y el que sostiene el resumen de evidencia.
   */
  const buySide = report.sides.find((s) => s.side === 'BUY') ?? null;
  const money = (v: number) => v.toFixed(2);
  const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

  return (
    <div className="bg-[#1e2329] border border-[#2b2f36] rounded-lg p-5">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h2 className="text-[#eaecef] font-bold tracking-wide flex items-center gap-2">
            <CalendarClock size={16} className="text-[#f0b90b]" />
            PROYECCIÓN DE FLUCTUACIÓN DIARIA
          </h2>
          <div className="text-[10px] text-[#5e6673] mt-1">
            {hourLabel(report.startHour)} – {hourLabel(report.endHour)} · línea punteada ={' '}
            proyección · VES · hora de Venezuela
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

      {/* CIFRAS DE CABECERA. Cada una dice si es un hecho o una proyección. */}
      <div className="flex flex-wrap gap-x-8 gap-y-3 my-4 pb-4 border-b border-[#2b2f36]">
        <Metric
          label="Techo del día"
          hint={
            report.ceiling
              ? `${hourLabel(report.ceiling.hour)} · ${report.ceiling.observed ? 'ocurrió' : 'proyectado'}`
              : undefined
          }
        >
          <span className="text-[#f0b90b] font-mono">
            {report.ceiling ? money(report.ceiling.price) : '—'}
          </span>
        </Metric>

        <Metric
          label="Piso del día"
          hint={
            report.floor
              ? `${hourLabel(report.floor.hour)} · ${report.floor.observed ? 'ocurrió' : 'proyectado'}`
              : undefined
          }
        >
          <span className="text-[#02c076] font-mono">
            {report.floor ? money(report.floor.price) : '—'}
          </span>
        </Metric>

        <Metric
          label="Spread máximo"
          hint={report.maxSpread ? `a las ${hourLabel(report.maxSpread.hour)}` : undefined}
        >
          <span className="text-[#eaecef] font-mono">
            {report.maxSpread ? `${report.maxSpread.spreadPct.toFixed(2)}%` : '—'}
          </span>
        </Metric>

        <Metric
          label="Mercado"
          hint={report.market.changePct === null ? 'sin proyección con la que medirlo' : 'de aquí al cierre'}
        >
          <span style={{ color: directionColor(report.market.direction) }}>
            {DIRECTION_TEXT[report.market.direction]}{' '}
            <span className="text-xs">{SPEED_TEXT[report.market.speed]}</span>
            {report.market.changePct !== null && (
              <span className="font-mono text-sm ml-2">{signed(report.market.changePct)}</span>
            )}
          </span>
        </Metric>

        <Metric
          label="Ahora"
          hint={
            report.turn.pct === null
              ? 'sin umbral medido todavía'
              : `umbral ±${report.turn.pct.toFixed(2)}%`
          }
        >
          <span className={report.turningNow ? 'text-[#f0b90b]' : 'text-[#848e9c]'}>
            {report.turningNow ? 'GIRANDO' : 'SIN GIROS'}
          </span>
        </Metric>

        <Metric label="Queda por venir" hint="del recorrido esperado del día">
          <span className="text-[#eaecef] font-mono">
            {report.remainingPct === null ? '—' : `${report.remainingPct.toFixed(0)}%`}
          </span>
        </Metric>
      </div>

      {/*
        SIN EVIDENCIA NO HAY CURVA.

        Con menos días de los mínimos la pantalla enseña lo real de hoy y dice
        exactamente qué falta. Dibujar una proyección "aproximada" mientras
        tanto sería justo lo que la Regla 5 prohíbe.
      */}
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
                {report.daysMissing === 1 ? '' : 's'} de captura para poder dibujar la primera
                curva.
              </>
            )}
            {report.extraction.BUY.droppedLegacy > 0 && (
              <>
                {' '}
                Se descartaron {report.extraction.BUY.droppedLegacy} registros antiguos sin precio
                estratégico: no se rellenan hacia atrás porque nadie observó esos valores.
              </>
            )}
          </div>
        </div>
      )}

      <DailyFluctuationChart report={report} />

      <div className="flex flex-wrap gap-4 mt-3 text-[10px] text-[#848e9c]">
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-0.5 bg-[#f0b90b]" /> recompra (lo que pago)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-0.5 bg-[#02c076]" /> venta (lo que me pagan)
        </span>
        <span className="text-[#5e6673]">
          punto sólido = ocurrió · punto hueco y línea punteada = proyección
        </span>
        <span className="text-[#5e6673]">cada punto es el MEJOR precio de esa hora</span>
      </div>

      {/* DE DÓNDE SALE LA CURVA. Sin esto, cada número es una afirmación desnuda. */}
      <div className="mt-4 pt-3 border-t border-[#2b2f36] text-[10px] text-[#5e6673] leading-relaxed">
        <div>
          <strong className="text-[#848e9c]">Evidencia:</strong> {report.tierText}{' '}
          {drawable && (
            <>
              Perfil construido con{' '}
              <strong className="text-[#eaecef]">{buySide?.profileDays ?? 0} días</strong> de{' '}
              {buySide?.candidateDays ?? 0} disponibles
              {buySide?.conditioned
                ? ', elegidos por parecerse al recorrido que hoy lleva desde la apertura.'
                : ', sin filtrar por el momento del mercado: no hay días de sobra para condicionar.'}
            </>
          )}
        </div>

        <div className="mt-1">
          <strong className="text-[#848e9c]">Contraste contra la persistencia:</strong>{' '}
          {report.validation.comparisons === 0 ? (
            <>
              todavía no hay días suficientes para comparar el perfil con «el precio se queda donde
              está». Mientras no los haya, esta curva no puede presentarse como mejor que no
              proyectar nada.
            </>
          ) : (
            <>
              {report.validation.profileWins} de {report.validation.comparisons} días
              {report.validation.pValue !== null && ` (p = ${report.validation.pValue.toFixed(3)})`}
              {report.validation.beatsPersistence ? (
                <span className="text-[#02c076]">
                  {' '}
                  · el perfil bate a la persistencia con estos días.
                </span>
              ) : (
                <span className="text-[#f0b90b]">
                  {' '}
                  · TODAVÍA NO se puede afirmar que el perfil mejore a «el precio se queda donde
                  está».
                </span>
              )}
              . Cada día cuenta como un caso, no cada par de horas: los pares de un mismo día
              recorren la misma trayectoria y contarlos por separado inflaría la muestra.
            </>
          )}
        </div>

        <div className="mt-1">
          <strong className="text-[#848e9c]">Fuente:</strong> {report.source} · precios
          estratégicos (mediana de cada lado), no los extremos del libro ·{' '}
          {report.extraction.BUY.recordsRead} registros leídos.
        </div>
      </div>
    </div>
  );
};
