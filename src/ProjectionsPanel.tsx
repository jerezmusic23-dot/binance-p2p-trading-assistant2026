import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDownRight, ArrowRight, ArrowUpRight, CalendarClock, RefreshCw } from 'lucide-react';
import { ApiService } from './api';
import type { CellProjection, DailyLegReport, DailyProjectionResponse, OutcomeDistribution, ScreenState } from './types';
import { ProjectionsChart } from './ProjectionsChart';
import { hourLabel } from './dailyChartRows';

const VENTA = '#f0b90b';
const COMPRA = '#02c076';
const TARGET_BANKS = new Set(['MERCANTIL', 'BANCAMIGA']);

const stateText: Record<ScreenState, string> = {
  SIN_DATOS: 'SIN DATOS',
  DATOS_INSUFICIENTES: 'HISTÓRICO INSUFICIENTE',
  PROYECCION_LIMITADA: 'PROYECCIÓN LIMITADA',
  PROYECCION_CONDICIONADA: 'PROYECCIÓN CONDICIONADA',
  PROYECCION_VALIDADA: 'PROYECCIÓN VALIDADA',
};

const money = (v: number | null | undefined) => v == null ? 'no verificable' : `${v.toFixed(2)} VES`;
const rate = (v: number | null) => v == null ? 'no verificable' : `${(v * 100).toFixed(0)}%`;

function directionLabel(direction: string): string {
  if (direction === 'BULLISH') return 'ALCISTA';
  if (direction === 'BEARISH') return 'BAJISTA';
  if (direction === 'SIDEWAYS') return 'LATERAL';
  if (direction === 'TRANSITION') return 'EN TRANSICIÓN';
  return 'SIN DATOS';
}

function gradeLabel(grade: string): string {
  const labels: Record<string, string> = {
    STRONG_UP: 'ALCISTA FUERTE', UP: 'ALCISTA', WEAK_UP: 'ALCISTA DÉBIL', LATERAL: 'LATERAL',
    WEAK_DOWN: 'BAJISTA DÉBIL', DOWN: 'BAJISTA', STRONG_DOWN: 'BAJISTA FUERTE', UNKNOWN: 'SIN DATOS',
  };
  return labels[grade] ?? 'SIN DATOS';
}

function trendColor(direction: string): string {
  if (direction === 'BULLISH') return '#02c076';
  if (direction === 'BEARISH') return '#f6465d';
  if (direction === 'TRANSITION') return '#f0b90b';
  return '#848e9c';
}

function turnProbability(trend: CellProjection['buy']['trend'], continuation: OutcomeDistribution): number | null {
  if (trend.trend === 'BULLISH') return continuation.downRate;
  if (trend.trend === 'BEARISH') return continuation.upRate;
  return null;
}

function ProbabilityBar({ label, value, count, total, className }: { label: string; value: number | null; count: number; total: number; className: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px]"><span className={className}>{label}</span><span className="font-mono text-[#e0e0e0]">{rate(value)} · {count}/{total}</span></div>
      <div className="h-1.5 overflow-hidden rounded bg-[#2b2f36]"><div className="h-full rounded bg-current" style={{ width: `${Math.max(0, Math.min(100, (value ?? 0) * 100))}%` }} /></div>
    </div>
  );
}

const OutlookCard: React.FC<{ projection: CellProjection; side: 'BUY' | 'SELL' }> = ({ projection, side }) => {
  const p = side === 'BUY' ? projection.buy : projection.sell;
  const c = p.continuation.overall;
  const color = side === 'BUY' ? COMPRA : VENTA;
  const turn = turnProbability(p.trend, c);
  const directional = p.trend.trend === 'BULLISH' || p.trend.trend === 'BEARISH';
  return (
    <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-3">
      <div className="flex items-center justify-between gap-2">
        <div><div className="text-[9px] uppercase tracking-wider text-[#5e6673]">{p.label}</div><div className="font-mono text-xl" style={{ color }}>{money(p.currentPrice)}</div></div>
        <div className="text-right"><div className="text-[9px] text-[#5e6673]">FUERZA ACTUAL</div><div className="text-[12px] font-bold" style={{ color: trendColor(p.trend.trend) }}>{gradeLabel(p.trend.grade)}</div><div className="text-[9px] text-[#5e6673]">{directionLabel(p.trend.trend)} · {p.trend.sampleSize} obs.</div></div>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="rounded border border-[#2b2f36] p-2"><div className="text-[9px] uppercase text-[#5e6673]">Probabilidad histórica de subida</div><div className="mt-1 text-lg font-bold text-[#02c076]">{rate(c.upRate)}</div><div className="text-[9px] text-[#5e6673]">{c.up} casos de {c.sampleSize} · horizonte {p.projectedRange.stepsAhead} obs.</div></div>
        <div className="rounded border border-[#2b2f36] p-2"><div className="text-[9px] uppercase text-[#5e6673]">Probabilidad histórica de giro</div><div className="mt-1 text-lg font-bold" style={{ color: turn == null ? '#848e9c' : '#f0b90b' }}>{turn == null ? 'no aplica' : rate(turn)}</div><div className="text-[9px] text-[#5e6673]">{directional ? `movimiento contrario a la tendencia ${directionLabel(p.trend.trend).toLowerCase()}` : 'el mercado está lateral/transición; no hay sentido único que invertir'}</div></div>
      </div>
      <div className="mt-2 space-y-1.5">
        <ProbabilityBar label="ALCISTA" value={c.upRate} count={c.up} total={c.sampleSize} className="text-[#02c076]" />
        <ProbabilityBar label="LATERAL" value={c.flatRate} count={c.flat} total={c.sampleSize} className="text-[#848e9c]" />
        <ProbabilityBar label="BAJISTA" value={c.downRate} count={c.down} total={c.sampleSize} className="text-[#f6465d]" />
      </div>
      <div className="mt-2 text-[9px] text-[#5e6673]">Las probabilidades son frecuencias históricas condicionadas a esta serie y este horizonte; no son garantía. La fuerza es una descripción de movimientos observados, no una probabilidad.</div>
    </div>
  );
};

const BankOutlook: React.FC<{ projections: CellProjection[] }> = ({ projections }) => {
  const target = projections.filter(p => TARGET_BANKS.has(p.bank));
  const byBank = useMemo(() => {
    const result: Record<string, CellProjection[]> = {};
    for (const p of target) (result[p.bankDisplayName] ??= []).push(p);
    return result;
  }, [target]);
  if (target.length === 0) return null;
  return (
    <section className="space-y-2">
      <div><h3 className="text-[10px] font-bold uppercase tracking-wider text-[#e0e0e0]">Probabilidades por banco · Mercantil y Bancamiga</h3><p className="mt-0.5 text-[9px] text-[#5e6673]">Se muestran sólo celdas de estos bancos. Cada porcentaje lleva sus casos para que puedas juzgar la evidencia.</p></div>
      {Object.entries(byBank).map(([bank, cells]) => (
        <div key={bank} className="rounded border border-[#2b2f36] bg-[#111417] p-2.5"><div className="mb-2 text-[11px] font-bold text-[#e0e0e0]">{bank}</div><div className="grid gap-2 xl:grid-cols-2">{cells.map(p => <div key={`${p.bank}:${p.amountKey}`} className="rounded border border-[#2b2f36] p-2"><div className="mb-2 flex justify-between text-[9px] text-[#848e9c]"><span>{p.amountKey}</span><span>{p.observations} obs.</span></div><div className="grid grid-cols-3 gap-2 text-[10px] font-mono"><div><div className="text-[#5e6673]">SUBE</div><div className="text-[#02c076]">{rate(p.buy.continuation.overall.upRate)}</div></div><div><div className="text-[#5e6673]">LATERAL</div><div className="text-[#848e9c]">{rate(p.buy.continuation.overall.flatRate)}</div></div><div><div className="text-[#5e6673]">BAJA</div><div className="text-[#f6465d]">{rate(p.buy.continuation.overall.downRate)}</div></div></div></div>)}</div></div>
      ))}
    </section>
  );
};

const HourTable: React.FC<{ leg: DailyLegReport; color: string }> = ({ leg, color }) => {
  const rows = leg.projection.projected;
  return <div className="min-w-[330px] flex-1"><div className="mb-1 text-[10px] font-bold" style={{ color }}>{leg.projection.leg === 'VENTA' ? 'MI VENTA · Binance BUY' : 'MI COMPRA · Binance SELL'}</div><table className="w-full text-[9px]"><thead><tr className="text-[#5e6673]"><th className="text-left">H</th><th className="text-left">Hora</th><th className="text-right">Central</th><th className="text-right">Rango</th><th className="text-right">N</th></tr></thead><tbody className="font-mono">{rows.map(h => <tr key={h.hoursAhead} className="border-t border-[#2b2f36]"><td className="py-1">+{h.hoursAhead}h</td><td className="py-1 text-[#848e9c]">{hourLabel(h.hourOfDay)}</td><td className="py-1 text-right" style={{ color }}>{money(h.central)}</td><td className="py-1 text-right text-[#5e6673]">{money(h.low)}–{money(h.high)}</td><td className="py-1 text-right text-[#5e6673]">{h.daysUsed}</td></tr>)}</tbody></table></div>;
};

export const ProjectionsPanel: React.FC = () => {
  const [report, setReport] = useState<DailyProjectionResponse | null>(null);
  const [maker, setMaker] = useState<CellProjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [daily, makerResponse] = await Promise.all([ApiService.getDailyProjection(), ApiService.getMakerProjections()]);
      setReport(daily);
      setMaker(makerResponse.projections);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'No se pudo cargar la proyección del mercado');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); const timer = setInterval(() => void load(), 60_000); return () => clearInterval(timer); }, [load]);

  if (loading && report === null) return <div className="rounded-lg border border-[#2b2f36] bg-[#1e2329] p-6 text-sm text-[#848e9c]">Analizando mercado y calculando escenarios históricos…</div>;
  if (error && report === null) return <div className="rounded-lg border border-[#f6465d]/30 bg-[#1e2329] p-6 text-sm text-[#f6465d]">{error}<button type="button" onClick={() => void load()} className="ml-3 underline">Reintentar</button></div>;
  if (!report) return null;

  const venta = report.legs.find(l => l.projection.leg === 'VENTA');
  const compra = report.legs.find(l => l.projection.leg === 'COMPRA');
  const bestEvidence = maker.filter(p => p.observations > 0).sort((a,b) => b.observations - a.observations)[0] ?? null;

  return (
    <div className="rounded-lg border border-[#2b2f36] bg-[#1e2329] p-5 space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 font-bold tracking-wide text-[#eaecef]"><CalendarClock size={16} className="text-[#f0b90b]" />PROYECCIÓN DEL MERCADO · 24 HORAS</h2><p className="mt-1 text-[10px] text-[#5e6673]">Desde {hourLabel(report.anchorHour)} VET · {report.horizonHours} horas hacia adelante · cruza medianoche sin reiniciar el horizonte.</p></div><button type="button" onClick={() => void load()} className="text-[#848e9c] hover:text-[#eaecef]" title="Actualizar"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button></header>

      <section className="rounded-lg border border-[#2b2f36] bg-[#111417] p-3"><div className="flex items-center gap-2"><Activity size={14} className="text-[#f0b90b]" /><div><div className="text-[10px] font-bold text-[#e0e0e0]">LECTURA EN UNA FRASE</div><div className="text-[11px] text-[#848e9c]">{stateText[report.state]} · el mercado está {report.legs.map(l => `${l.projection.leg === 'VENTA' ? 'MI VENTA' : 'MI COMPRA'} ${l.market.direction.toLowerCase()} (${l.market.changePct == null ? 'sin cambio medible' : `${l.market.changePct >= 0 ? '+' : ''}${l.market.changePct.toFixed(2)}%`})`).join(' · ')}.</div></div></div></section>

      <div className="grid gap-3 lg:grid-cols-2">{venta && bestEvidence && <OutlookCard projection={bestEvidence} side="SELL" />}{compra && bestEvidence && <OutlookCard projection={bestEvidence} side="BUY" />}</div>
      <BankOutlook projections={maker} />

      <div><div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#e0e0e0]">Trayectoria proyectada · cada hora</div><div className="grid gap-4 lg:grid-cols-2"><HourTable leg={venta!} color={VENTA} /><HourTable leg={compra!} color={COMPRA} /></div></div>

      <ProjectionsChart report={report} />

      <details className="rounded border border-[#2b2f36] bg-[#181a20] p-3"><summary className="cursor-pointer text-[10px] font-semibold text-[#848e9c]">Cómo interpretar fuerza, subida y giro</summary><div className="mt-2 space-y-2 text-[10px] leading-relaxed text-[#848e9c]"><p><b className="text-[#e0e0e0]">Fuerza:</b> ALCISTA FUERTE / ALCISTA / DÉBIL / LATERAL / BAJISTA DÉBIL / BAJISTA / BAJISTA FUERTE. Se calcula con la consistencia y magnitud de movimientos observados en la propia celda; no es una probabilidad.</p><p><b className="text-[#02c076]">Probabilidad de subida:</b> frecuencia histórica de casos que terminaron más arriba en el horizonte mostrado. <b className="text-[#f0b90b]">Probabilidad de giro:</b> cuando hay una tendencia direccional, es la frecuencia histórica de terminar en la dirección contraria; si está lateral, se muestra «no aplica».</p><p><b className="text-[#e0e0e0]">Muestra:</b> siempre se enseña N. Si no hay suficientes casos, el porcentaje queda como «no verificable». Así evitamos convertir 2 de 2 en un falso 100%.</p><p><b className="text-[#e0e0e0]">Matriz:</b> sólo la Matriz MultiFiltro decide si existe una operación real. La proyección no inventa anuncios ni liquidez.</p></div></details>
    </div>
  );
};
