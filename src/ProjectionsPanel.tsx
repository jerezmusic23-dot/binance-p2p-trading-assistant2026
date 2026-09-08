import React, { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import { ApiService } from './api';
import type { DailyLegReport, DailyProjectionResponse, ScreenState } from './types';
import { ProjectionsChart } from './ProjectionsChart';
import { MarketDecisionPanel } from './MarketDecisionPanel';
import { hourLabel } from './dailyChartRows';

const VENTA = '#f0b90b';
const COMPRA = '#02c076';

const stateText: Record<ScreenState, string> = {
  SIN_DATOS: 'SIN DATOS',
  DATOS_INSUFICIENTES: 'HISTÓRICO INSUFICIENTE',
  PROYECCION_LIMITADA: 'PROYECCIÓN LIMITADA',
  PROYECCION_CONDICIONADA: 'PROYECCIÓN CONDICIONADA',
  PROYECCION_VALIDADA: 'PROYECCIÓN VALIDADA',
};

const money = (v: number | null | undefined) =>
  v == null ? 'no verificable' : `${v.toFixed(2)} VES`;

function directionLabel(direction: DailyLegReport['market']['direction']) {
  switch (direction) {
    case 'SUBIENDO': return 'ALCISTA';
    case 'BAJANDO': return 'BAJISTA';
    case 'LATERAL': return 'LATERAL';
    default: return 'SIN DATOS';
  }
}

function directionClass(direction: DailyLegReport['market']['direction']) {
  switch (direction) {
    case 'SUBIENDO': return 'text-[#02c076]';
    case 'BAJANDO': return 'text-[#f6465d]';
    case 'LATERAL': return 'text-[#f0b90b]';
    default: return 'text-[#848e9c]';
  }
}

const ExtremeCard: React.FC<{
  title: string;
  subtitle: string;
  color: string;
  icon: React.ReactNode;
  leg: DailyLegReport | undefined;
}> = ({ title, subtitle, color, icon, leg }) => {
  if (!leg) return null;
  const projected = leg.projection.projectedClose;
  const change = leg.market.changePct;
  return (
    <section className="rounded-xl border border-[#2b2f36] bg-[#111417] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider" style={{ color }}>
            {icon}
            {title}
          </div>
          <div className="mt-1 text-[10px] text-[#5e6673]">{subtitle}</div>
        </div>
        <div className={`text-right text-[11px] font-bold ${directionClass(leg.market.direction)}`}>
          {directionLabel(leg.market.direction)}
          <div className="font-mono text-[9px] font-normal text-[#5e6673]">
            {change == null ? 'sin cambio medible' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-3">
          <div className="text-[9px] uppercase tracking-wider text-[#5e6673]">Ahora · observado</div>
          <div className="mt-1 font-mono text-2xl" style={{ color }}>{money(leg.now)}</div>
          <div className="mt-1 text-[9px] text-[#848e9c]">Precio real del mercado general capturado por Binance P2P.</div>
        </div>
        <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-3">
          <div className="text-[9px] uppercase tracking-wider text-[#5e6673]">24 h · proyectado</div>
          <div className="mt-1 font-mono text-2xl" style={{ color }}>{money(projected?.central)}</div>
          <div className="mt-1 text-[9px] text-[#848e9c]">
            Rango: {money(projected?.low)} – {money(projected?.high)} · {projected?.daysUsed ?? 0} días de evidencia.
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-[#2b2f36] bg-[#181a20] p-3 text-[9px] leading-relaxed text-[#848e9c]">
        <b className="text-[#e0e0e0]">Fuente:</b> mercado general USDT/VES · <b className="text-[#e0e0e0]">regla:</b> {leg.projection.leg === 'VENTA' ? 'precio MÁS ALTO de VENTA (techo)' : 'precio MÁS BAJO de COMPRA (piso)'}.
        <br />No usa banco, monto, anuncios prestados ni precio estratégico.
      </div>
    </section>
  );
};

const HourTable: React.FC<{ leg: DailyLegReport; color: string }> = ({ leg, color }) => (
  <section className="rounded-lg border border-[#2b2f36] bg-[#111417] p-3">
    <div className="mb-2 text-[10px] font-bold uppercase tracking-wider" style={{ color }}>
      {leg.projection.leg === 'VENTA' ? 'Máximo de VENTA' : 'Mínimo de COMPRA'} · trayectoria
    </div>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[430px] text-[9px]">
        <thead>
          <tr className="text-[#5e6673]">
            <th className="text-left">+H</th>
            <th className="text-left">Hora</th>
            <th className="text-right">Central</th>
            <th className="text-right">Rango</th>
            <th className="text-right">Días</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {leg.projection.projected.map((h) => (
            <tr key={h.hoursAhead} className="border-t border-[#2b2f36]">
              <td className="py-1.5">+{h.hoursAhead}h</td>
              <td className="py-1.5 text-[#848e9c]">{hourLabel(h.hourOfDay)}</td>
              <td className="py-1.5 text-right" style={{ color }}>{money(h.central)}</td>
              <td className="py-1.5 text-right text-[#5e6673]">{money(h.low)} – {money(h.high)}</td>
              <td className="py-1.5 text-right text-[#5e6673]">{h.daysUsed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
);

export const ProjectionsPanel: React.FC = () => {
  const [report, setReport] = useState<DailyProjectionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await ApiService.getDailyProjection());
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'No se pudo cargar la proyección general del mercado.');
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
    return <div className="rounded-xl border border-[#2b2f36] bg-[#1e2329] p-6 text-sm text-[#848e9c]">Analizando máximo de venta y mínimo de compra del mercado general…</div>;
  }
  if (error && report === null) {
    return <div className="rounded-xl border border-[#f6465d]/30 bg-[#1e2329] p-6 text-sm text-[#f6465d]">{error}<button type="button" onClick={() => void load()} className="ml-3 underline">Reintentar</button></div>;
  }
  if (!report) return null;

  const venta = report.legs.find((l) => l.projection.leg === 'VENTA');
  const compra = report.legs.find((l) => l.projection.leg === 'COMPRA');
  const latest = report.generatedAt ? new Date(report.generatedAt).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' }) : '—';

  return (
    <div className="space-y-4">
      {/*
        La lectura orientada a decidir va PRIMERO: es la que responde "qué
        hago". Debajo se conserva la proyección hora a hora del día, que
        responde "cómo se ha movido" - dos preguntas distintas, cada una con su
        motor y su bloque.
      */}
      <MarketDecisionPanel />

    <div className="space-y-4 rounded-xl border border-[#2b2f36] bg-[#1e2329] p-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold tracking-wide text-[#eaecef]">
            <Activity size={16} className="text-[#f0b90b]" />
            PROYECCIÓN DEL MERCADO · GENERAL USDT/VES
          </h2>
          <p className="mt-1 text-[10px] text-[#5e6673]">
            Máximo de VENTA + mínimo de COMPRA · movimiento de ambos extremos · horizonte 24 h · actualizado {latest}.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="text-[#848e9c] hover:text-[#eaecef]" title="Actualizar">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      <section className="rounded-lg border border-[#2b2f36] bg-[#111417] p-3">
        <div className="text-[9px] uppercase tracking-wider text-[#5e6673]">Lectura actual</div>
        <div className="mt-1 text-sm font-bold text-[#e0e0e0]">
          {stateText[report.state]} · {venta ? `VENTA ${directionLabel(venta.market.direction).toLowerCase()}` : 'VENTA sin datos'} · {compra ? `COMPRA ${directionLabel(compra.market.direction).toLowerCase()}` : 'COMPRA sin datos'}.
        </div>
        <div className="mt-1 text-[9px] text-[#848e9c]">La fuerza describe cómo se han movido estos dos extremos; no representa una oportunidad de arbitraje.</div>
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <ExtremeCard title="Precio máximo de VENTA" subtitle="Techo del mercado general · extremo más alto observado/proyectado" color={VENTA} icon={<TrendingUp size={14} />} leg={venta} />
        <ExtremeCard title="Precio mínimo de COMPRA" subtitle="Piso del mercado general · extremo más bajo observado/proyectado" color={COMPRA} icon={<TrendingDown size={14} />} leg={compra} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {venta && <HourTable leg={venta} color={VENTA} />}
        {compra && <HourTable leg={compra} color={COMPRA} />}
      </div>

      <ProjectionsChart report={report} />

      <section className="rounded-lg border border-[#2b2f36] bg-[#111417] p-3 text-[9px] leading-relaxed text-[#848e9c]">
        <div className="font-bold uppercase tracking-wider text-[#e0e0e0]">Cómo se construye</div>
        <p className="mt-1">1. Binance P2P general captura el libro sin banco ni monto.</p>
        <p>2. En cada hora se conserva el <b className="text-[#f0b90b]">precio más alto de VENTA</b> y el <b className="text-[#02c076]">precio más bajo de COMPRA</b>.</p>
        <p>3. El histórico compara cómo se movieron esos mismos extremos y calcula dirección, fuerza y trayectoria futura.</p>
        <p>4. Si falta evidencia, se muestra “no verificable”; nunca se sustituye por otra fuente.</p>
        {report.dataProvenance.unverifiedRecords > 0 && (
          <p className="mt-2 text-[#f0b90b]">
            ⚠ {report.dataProvenance.unverifiedRecords} de {report.dataProvenance.totalRecords}{' '}
            observaciones del histórico son anteriores al filtro de Recarga Pines y no se puede
            confirmar que lo excluyan. Se usan igual, sin descartarlas ni inventar que están limpias.
          </p>
        )}
      </section>
    </div>
    </div>
  );
};
