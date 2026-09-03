/**
 * PROYECCIÓN DEL MERCADO — LA ÚNICA PANTALLA
 * ==========================================
 *
 * Nueve bloques, en el orden en que se decide publicar un anuncio:
 *
 *   1. Estado actual          ¿a qué precio estoy?
 *   2. MI VENTA               ¿cuándo y a cuánto podría vender?
 *   3. MI COMPRA              ¿cuándo y a cuánto podría recomprar?
 *   4. Proyección por horizontes  ¿qué se espera hora a hora?
 *   5. Techo y piso           ¿hasta dónde puede llegar el día?
 *   6. Horarios favorables    ¿a qué horas ha convenido cada operación?
 *   7. Giro de mercado        ¿está cambiando algo?
 *   8. Evidencia / backtest   ¿por qué el sistema cree eso?
 *   9. Suficiencia de datos   ¿puede el sistema afirmar esto?
 *
 * Un precio no se repite en dos bloques salvo que aporte algo distinto.
 *
 * ═══ UNA SOLA SEMÁNTICA, ESCRITA EN CADA RÓTULO ═══
 *
 *   MI VENTA  = Binance BUY  = lado alto  → TECHO
 *   MI COMPRA = Binance SELL = lado bajo  → PISO
 *
 * ═══ UN SOLO MOTOR ═══
 *
 * Aquí había tres paneles sobre tres motores. Quedan uno y uno. Todo lo que se
 * ve viene de /api/market/projections/daily; este componente no calcula nada.
 *
 * ═══ NINGÚN NÚMERO SIN ORIGEN ═══
 *
 * Cada precio llega con su `origin`: el campo del histórico, el lado de
 * Binance, la pierna, el cálculo y los días que lo sostienen. La pantalla lo
 * enseña al pasar el ratón y en el bloque de evidencia. Si un número no puede
 * explicarse, no se muestra.
 *
 * ═══ SIN EVIDENCIA NO HAY CURVA ═══
 *
 * Con menos días de los mínimos no se dibuja ninguna proyección: se dice qué
 * falta y cuánto. La pantalla nunca escribe "compra ahora" ni "vende ahora".
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpToLine,
  CalendarClock,
  Clock,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { ApiService } from './api';
import {
  DailyExtreme,
  DailyLegReport,
  DailyProjectionResponse,
  PriceOrigin,
  ScreenState,
} from './types';
import { ProjectionsChart } from './ProjectionsChart';
import { hourLabel } from './dailyChartRows';

const VENTA = '#f0b90b';
const COMPRA = '#02c076';

const STATE_TEXT: Record<ScreenState, string> = {
  SIN_DATOS: 'SIN DATOS',
  DATOS_INSUFICIENTES: 'HISTÓRICO INSUFICIENTE',
  PROYECCION_LIMITADA: 'PROYECCIÓN LIMITADA',
  PROYECCION_CONDICIONADA: 'PROYECCIÓN CONDICIONADA',
  PROYECCION_VALIDADA: 'PROYECCIÓN VALIDADA',
};

const STATE_COLOR: Record<ScreenState, string> = {
  SIN_DATOS: '#5e6673',
  DATOS_INSUFICIENTES: '#848e9c',
  PROYECCION_LIMITADA: '#f0b90b',
  PROYECCION_CONDICIONADA: '#f0b90b',
  PROYECCION_VALIDADA: '#02c076',
};

const DIRECTION_TEXT: Record<string, string> = {
  SUBIENDO: 'subiendo',
  BAJANDO: 'bajando',
  LATERAL: 'sin rumbo',
  INDETERMINADA: 'sin medir',
};

const money = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(2));
const signed = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

/** Texto de trazabilidad: la cadena entera de un precio, en una frase. */
const originText = (o: PriceOrigin): string =>
  `${o.kind} · ${o.leg} (Binance ${o.binanceSide}) · campo ${o.field} · ${o.calculation}` +
  (o.daysUsed !== null ? ` · ${o.daysUsed} días` : '');

/* ── AHORA: el precio de cada pierna ─────────────────────────────────── */
const NowCard: React.FC<{ leg: DailyLegReport; color: string }> = ({ leg, color }) => (
  <div className="flex-1 min-w-[190px] rounded border border-[#2b2f36] bg-[#181a20] p-3">
    <div className="text-[9px] uppercase tracking-wider text-[#5e6673]">
      {leg.projection.leg === 'VENTA' ? 'Mi venta ahora' : 'Mi compra ahora'}
      <span className="ml-1 normal-case tracking-normal">· Binance {leg.projection.binanceSide}</span>
    </div>
    <div className="mt-1 font-mono text-2xl font-semibold" style={{ color }} title={originText(leg.nowOrigin)}>
      {money(leg.now)}
    </div>
    <div className="mt-1 text-[10px] text-[#848e9c]">
      {DIRECTION_TEXT[leg.market.direction]} {signed(leg.market.changePct)} de aquí al cierre
    </div>
  </div>
);

/* ── HOY: techo y piso, cada uno de SU pierna ────────────────────────── */
const ExtremeCard: React.FC<{
  title: string;
  extreme: DailyExtreme;
  color: string;
  icon: React.ReactNode;
}> = ({ title, extreme, color, icon }) => (
  <div className="flex-1 min-w-[210px] rounded border border-[#2b2f36] bg-[#181a20] p-3">
    <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-[#5e6673]">
      {icon}
      {title}
      <span className="normal-case tracking-normal">· Binance {extreme.binanceSide}</span>
    </div>
    <div className="mt-1 font-mono text-2xl font-semibold" style={{ color }} title={originText(extreme.origin)}>
      {money(extreme.observed?.price)}
      {extreme.observed && (
        <span className="ml-2 font-sans text-[9px] font-normal uppercase text-[#5e6673]">
          {hourLabel(extreme.observed.hour)} · ocurrió
        </span>
      )}
    </div>
    <div className="mt-1.5 text-[10px] text-[#848e9c]">
      {extreme.leg === 'VENTA' ? 'techo futuro' : 'piso futuro'}:{' '}
      <span className="font-mono text-[#eaecef]">{money(extreme.projected?.price)}</span>
      {extreme.projected && (
        <span className="text-[#5e6673]">
          {' '}({money(extreme.projected.low)}–{money(extreme.projected.high)}) ·{' '}
          {extreme.projected.daysUsed} días
        </span>
      )}
    </div>
  </div>
);

/* ── PRÓXIMA OPERACIÓN PROYECTADA ────────────────────────────────────── */
const OpportunityCard: React.FC<{ leg: DailyLegReport; color: string }> = ({ leg, color }) => {
  const o = leg.opportunity;
  const isSale = leg.projection.leg === 'VENTA';
  const b = leg.backtest;

  return (
    <div className="flex-1 min-w-[300px] rounded border border-[#2b2f36] bg-[#181a20] p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-bold tracking-wide" style={{ color }}>
          {isSale ? 'PRÓXIMA VENTA PROYECTADA' : 'PRÓXIMA COMPRA PROYECTADA'}
        </span>
        <span className="text-[9px] text-[#5e6673]">Binance {leg.projection.binanceSide}</span>
      </div>

      {o === null ? (
        <div className="mt-2 text-[11px] text-[#848e9c]">
          Sin evidencia suficiente para señalar una zona. {leg.evidenceText}
        </div>
      ) : (
        <>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="font-mono text-xl font-semibold" style={{ color }}>
              {money(o.low)} – {money(o.high)}
            </span>
            <span className="text-[10px] text-[#848e9c]">
              zona · central {money(o.price)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[#848e9c]">
            <Clock size={10} />
            hacia las {hourLabel(o.hourOfDay)}
            <span className="text-[#5e6673]">
              · {o.bandKind === 'P10_P90' ? 'P10–P90' : 'rango observado'} · {o.daysUsed} días
            </span>
          </div>
          <div className="mt-1 text-[10px]">
            {o.improvesOnNow ? (
              <span style={{ color }}>
                mejoraría el precio de ahora en {signed(o.improvementPct)}
              </span>
            ) : (
              <span className="text-[#848e9c]">
                no mejora el precio de ahora ({signed(o.improvementPct)})
              </span>
            )}
          </div>
        </>
      )}

      <div className="mt-2 border-t border-[#2b2f36] pt-2 text-[9px] leading-relaxed text-[#5e6673]">
        {b.days === 0
          ? 'Backtest: sin días evaluables todavía.'
          : `Backtest walk-forward: ${b.days} días · error de cierre ${b.closeErrorModel?.toFixed(2) ?? '—'} frente a ${b.closeErrorPersistence?.toFixed(2) ?? '—'} de la persistencia${b.coverage !== null ? ` · cobertura ${(b.coverage * 100).toFixed(0)}%` : ''}${b.pValue !== null ? ` · p = ${b.pValue.toFixed(3)}` : ''}`}
      </div>
    </div>
  );
};

/* ── 4. PROYECCIÓN POR HORIZONTES ────────────────────────────────────── */
const HorizonTable: React.FC<{ leg: DailyLegReport; color: string }> = ({ leg, color }) => {
  const p = leg.projection;
  if (p.projected.length === 0) return null;

  /*
   * `hora − ancla` es aritmética de RELOJ sobre dos enteros, no de mercado:
   * ningún precio se recalcula aquí. Los precios, la banda y los días llegan
   * ya decididos del servidor.
   */
  return (
    <div className="flex-1 min-w-[300px]">
      <div className="mb-1 text-[10px] font-semibold" style={{ color }}>
        {leg.label}
      </div>
      <table className="w-full text-[10px]">
        <thead>
          <tr className="text-[9px] uppercase text-[#5e6673]">
            <th className="pb-1 text-left font-normal">Horizonte</th>
            <th className="pb-1 text-left font-normal">Hora</th>
            <th className="pb-1 text-right font-normal">Esperado</th>
            <th className="pb-1 text-right font-normal">Rango</th>
            <th className="pb-1 text-right font-normal">Días</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {p.projected.map((h) => (
            <tr key={h.hoursAhead} className="border-t border-[#2b2f36]">
              <td className="py-0.5 text-[#848e9c]">+{h.hoursAhead} h</td>
              <td className="py-0.5 text-[#848e9c]">{hourLabel(h.hourOfDay)}</td>
              <td className="py-0.5 text-right" style={{ color }}>{money(h.central)}</td>
              <td className="py-0.5 text-right text-[#5e6673]">
                {money(h.low)}–{money(h.high)}
              </td>
              <td className="py-0.5 text-right text-[#5e6673]">{h.daysUsed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/* ── 6. HORARIOS HISTÓRICAMENTE FAVORABLES ───────────────────────────── */
const FavourableHours: React.FC<{ leg: DailyLegReport; color: string }> = ({ leg, color }) => {
  const isSale = leg.projection.leg === 'VENTA';
  if (leg.favourableHours.length === 0) {
    return (
      <div className="flex-1 min-w-[260px]">
        <div className="text-[10px] font-semibold" style={{ color }}>{leg.label}</div>
        <div className="mt-1 text-[10px] text-[#848e9c]">
          Todavía no hay días suficientes para saber qué horas han sido mejores.
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 min-w-[260px]">
      <div className="text-[10px] font-semibold" style={{ color }}>
        {isSale ? 'Mejores horas para vender alto' : 'Mejores horas para comprar bajo'}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {leg.favourableHours.slice(0, 6).map((favourability) => (
          <span
            key={favourability.hour}
            className="rounded border border-[#2b2f36] px-1.5 py-0.5 font-mono text-[10px]"
            style={{ color }}
            title={`Posición media dentro del día: ${(favourability.score * 100).toFixed(0)}% · ${favourability.daysUsed} días`}
          >
            {hourLabel(favourability.hour)}
          </span>
        ))}
      </div>
      <div className="mt-1 text-[9px] text-[#5e6673]">
        posición media de esa hora dentro de su propia jornada, no cuánto se movió el mercado
      </div>
    </div>
  );
};

/* ── 7. GIRO DE MERCADO ──────────────────────────────────────────────── */
/**
 * Dos cosas distintas, y se dicen por separado.
 *
 * El GIRO ACTUAL es una observación: el último movimiento por hora invirtió el
 * signo del anterior y superó el umbral medido. Ya ocurrió.
 *
 * El ESCENARIO FUTURO no es una predicción de giro. Es lo que la trayectoria
 * proyectada —la mediana de los días análogos— haría si se cumpliera. Se
 * enuncia como escenario porque el modelo no estima la probabilidad de que un
 * giro ocurra; sólo dibuja la forma media de los días parecidos.
 */
const TurnBlock: React.FC<{ report: DailyProjectionResponse }> = ({ report }) => {
  const scenarios = report.legs.filter((l) => l.turn !== null);

  return (
    <div className="rounded border border-[#2b2f36] bg-[#181a20] p-3">
      <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-[#5e6673]">
        <RotateCcw size={11} /> Giro de mercado
      </div>

      <div className="mt-1.5 text-[11px]">
        <span className="text-[#848e9c]">Ahora: </span>
        {report.turningNow ? (
          <span className="font-semibold text-[#f0b90b]">
            hay evidencia de giro en curso
          </span>
        ) : (
          <span className="text-[#eaecef]">sin giro en curso</span>
        )}
        <span className="text-[#5e6673]">
          {report.turn.pct === null
            ? ' · todavía no hay con qué medir un giro'
            : ` · un movimiento cuenta como giro por encima de ±${report.turn.pct.toFixed(2)}%, medido sobre ${report.turn.sampleSize} cambios reales`}
        </span>
      </div>

      {scenarios.length > 0 && (
        <div className="mt-2 border-t border-[#2b2f36] pt-2 text-[10px]">
          <div className="text-[#848e9c]">
            Escenario futuro (no es una predicción de giro):
          </div>
          {scenarios.map((l) => (
            <div key={l.projection.leg} className="mt-0.5 text-[#5e6673]">
              en {l.label.toLowerCase()}, la trayectoria media de los días parecidos cambiaría de{' '}
              {l.turn!.from.toLowerCase()} a {l.turn!.to.toLowerCase()} hacia las{' '}
              {hourLabel(l.turn!.hourOfDay)}.
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const ProjectionsPanel: React.FC = () => {
  const [report, setReport] = useState<DailyProjectionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await ApiService.getDailyProjection());
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'No se pudo cargar la proyección');
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
      <div className="rounded-lg border border-[#2b2f36] bg-[#1e2329] p-6 text-sm text-[#848e9c]">
        Cargando proyecciones…
      </div>
    );
  }

  if (error !== null && report === null) {
    return (
      <div className="rounded-lg border border-[#2b2f36] bg-[#1e2329] p-6">
        <div className="text-sm font-semibold text-[#f6465d]">{error}</div>
        <button onClick={() => void load()} className="mt-3 text-[11px] text-[#f0b90b] underline">
          Reintentar
        </button>
      </div>
    );
  }

  if (report === null) return null;

  const venta = report.legs.find((l) => l.projection.leg === 'VENTA');
  const compra = report.legs.find((l) => l.projection.leg === 'COMPRA');
  const drawable =
    report.state === 'PROYECCION_LIMITADA' ||
    report.state === 'PROYECCION_CONDICIONADA' ||
    report.state === 'PROYECCION_VALIDADA';

  return (
    <div className="rounded-lg border border-[#2b2f36] bg-[#1e2329] p-5">
      {/* ── CABECERA ─────────────────────────────────────────────────── */}
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="flex items-center gap-2 font-bold tracking-wide text-[#eaecef]">
            <CalendarClock size={16} className="text-[#f0b90b]" />
            PROYECCIÓN DEL MERCADO
          </h2>
          <div className="mt-1 text-[10px] text-[#5e6673]">
            24/7 · próximas {report.horizonHours} horas desde las {hourLabel(report.anchorHour)} · hora
            de Venezuela · VES · línea punteada = proyección
          </div>
          <div className="mt-1 text-[10px]">
            <span style={{ color: VENTA }}>MI VENTA = Binance BUY ↑ techo</span>
            <span className="text-[#5e6673]"> · </span>
            <span style={{ color: COMPRA }}>MI COMPRA = Binance SELL ↓ piso</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span
            className="rounded border px-2 py-0.5 text-[9px] font-semibold"
            style={{ color: STATE_COLOR[report.state], borderColor: STATE_COLOR[report.state] }}
            title={report.stateText}
          >
            {STATE_TEXT[report.state]}
          </span>
          <button onClick={() => void load()} className="text-[#848e9c] hover:text-[#eaecef]" title="Actualizar">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* ── 1. ESTADO ACTUAL ─────────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap gap-3">
        {venta && <NowCard leg={venta} color={VENTA} />}
        {compra && <NowCard leg={compra} color={COMPRA} />}
      </div>

      {/* ── 9. SUFICIENCIA DE DATOS (arriba cuando bloquea todo lo demás) ── */}
      {!drawable && (
        <div className="mb-4 rounded border border-[#2b2f36] bg-[#181a20] p-4">
          <div className="mb-1 text-sm font-semibold text-[#f0b90b]">
            {STATE_TEXT[report.state]}
          </div>
          <div className="text-[11px] leading-relaxed text-[#848e9c]">
            {report.stateText}
            {report.daysMissing > 0 && (
              <>
                {' '}
                Faltan <strong className="text-[#eaecef]">{report.daysMissing}</strong> día
                {report.daysMissing === 1 ? '' : 's'} completo
                {report.daysMissing === 1 ? '' : 's'} de captura para poder proyectar. Hasta
                entonces la pantalla sólo puede enseñar lo que realmente ha ocurrido.
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

      {/* ── 2 y 3. MI VENTA / MI COMPRA ──────────────────────────────── */}
      <div className="mb-4 flex flex-wrap gap-3">
        {venta && <OpportunityCard leg={venta} color={VENTA} />}
        {compra && <OpportunityCard leg={compra} color={COMPRA} />}
      </div>

      {/* ── GRÁFICA: real y proyectado, sin confundirse ──────────────── */}
      <ProjectionsChart report={report} />
      <div className="mt-3 flex flex-wrap gap-4 text-[10px] text-[#848e9c]">
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4" style={{ background: VENTA }} /> MI VENTA
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4" style={{ background: COMPRA }} /> MI COMPRA
        </span>
        <span className="text-[#5e6673]">
          punto sólido = ocurrió · punto hueco y línea punteada = proyección
        </span>
      </div>

      {/* ── 4. PROYECCIÓN POR HORIZONTES ─────────────────────────────── */}
      {drawable && (
        <div className="mt-4 border-t border-[#2b2f36] pt-3">
          <div className="mb-2 text-[9px] uppercase tracking-wider text-[#5e6673]">
            Proyección por horizontes
          </div>
          <div className="flex flex-wrap gap-6">
            {venta && <HorizonTable leg={venta} color={VENTA} />}
            {compra && <HorizonTable leg={compra} color={COMPRA} />}
          </div>
        </div>
      )}

      {/* ── 5. TECHO Y PISO ──────────────────────────────────────────── */}
      <div className="mt-4 flex flex-wrap gap-3">
        <ExtremeCard
          title="Techo del día · mi venta"
          extreme={report.ceiling}
          color={VENTA}
          icon={<ArrowUpToLine size={11} />}
        />
        <ExtremeCard
          title="Piso del día · mi compra"
          extreme={report.floor}
          color={COMPRA}
          icon={<ArrowDownToLine size={11} />}
        />
      </div>

      {/* ── 6. HORARIOS FAVORABLES ───────────────────────────────────── */}
      <div className="mt-4 rounded border border-[#2b2f36] bg-[#181a20] p-3">
        <div className="mb-2 text-[9px] uppercase tracking-wider text-[#5e6673]">
          Horarios históricamente favorables
        </div>
        <div className="flex flex-wrap gap-6">
          {venta && <FavourableHours leg={venta} color={VENTA} />}
          {compra && <FavourableHours leg={compra} color={COMPRA} />}
        </div>
      </div>

      {/* ── 7. GIRO ──────────────────────────────────────────────────── */}
      <div className="mt-3">
        <TurnBlock report={report} />
      </div>

      {/* ── D. EVIDENCIA Y TRAZABILIDAD ──────────────────────────────── */}
      {/* ── 8. EVIDENCIA Y TRAZABILIDAD ──────────────────────────────── */}
      <details className="mt-4 border-t border-[#2b2f36] pt-3">
        <summary className="cursor-pointer text-[10px] text-[#848e9c]">
          Evidencia: de dónde sale cada número
        </summary>
        <div className="mt-2 text-[10px] leading-relaxed text-[#5e6673]">
          <div className="mb-1 text-[#848e9c]">Cadena de cada precio:</div>
          <ul className="ml-4 list-disc">
            <li>techo del día → {originText(report.ceiling.origin)}</li>
            <li>piso del día → {originText(report.floor.origin)}</li>
            {report.legs.map((l) => (
              <li key={l.projection.leg}>
                {l.projection.leg.toLowerCase()} ahora → {originText(l.nowOrigin)}
              </li>
            ))}
          </ul>

          <div className="mb-1 mt-2 text-[#848e9c]">Variables en uso:</div>
          <ul className="ml-4 list-disc">
            {report.variables.used.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>

          <div className="mb-1 mt-2 text-[#848e9c]">Disponibles pero todavía no usadas:</div>
          <ul className="ml-4 list-disc">
            {report.variables.availableNotUsed.map((v) => (
              <li key={v.name}>
                <strong className="text-[#848e9c]">{v.name}</strong>: {v.reason}
              </li>
            ))}
          </ul>

          <div className="mt-2">
            Fuente: {report.source} · precios estratégicos (mediana de cada lado del libro), no los
            extremos crudos del TOP 20 · {venta?.extraction.recordsRead ?? 0} registros leídos ·
            umbral de giro medido{' '}
            {report.turn.pct === null ? '—' : `±${report.turn.pct.toFixed(2)}%`} sobre{' '}
            {report.turn.sampleSize} cambios.
          </div>
        </div>
      </details>
    </div>
  );
};
