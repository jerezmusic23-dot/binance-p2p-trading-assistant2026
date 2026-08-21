import React, { useState, useEffect } from 'react';
import { HistoryRecord, HistorySummary, BacktestMetrics } from './types';
import { ApiService } from './api';
import {
  History,
  AlertCircle,
  Download,
  Sparkles,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';

export const HistoryAndBacktest: React.FC = () => {
  const [range, setRange] = useState<string>('24h');
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [backtest, setBacktest] = useState<BacktestMetrics | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const loadData = async (selectedRange: string) => {
    try {
      setIsLoading(true);
      const [histRes, backRes] = await Promise.all([
        ApiService.getHistory(selectedRange),
        ApiService.getBacktestMetrics(),
      ]);
      setRecords(histRes.records || []);
      setSummary(histRes.summary || null);
      setBacktest(backRes.backtest || null);
    } catch (err) {
      console.error('Error loading history and backtest:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData(range);
  }, [range]);

  const exportCSV = () => {
    if (records.length === 0) return;
    const headers = ['Timestamp', 'Date', 'BuyPrice_VES', 'SellPrice_VES', 'SpreadPct', 'BuyMerchant', 'SellMerchant'];
    const rows = records.map((r) => [
      r.timestamp,
      r.dateStr,
      r.buyPrice,
      r.sellPrice,
      r.spreadPct,
      `"${r.bestBuyMerchant}"`,
      `"${r.bestSellMerchant}"`,
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `binance_p2p_history_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const formatSafeTime = (ts: number) => {
    try {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return '--:--';
    }
  };

  const formatSafeDateTime = (ts?: number | null) => {
    if (!ts) return 'N/A';
    try {
      const d = new Date(ts);
      return `${d.toLocaleDateString()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return 'N/A';
    }
  };

  const chartData = records.map((r) => ({
    time: formatSafeTime(r.timestamp),
    buy: r.buyPrice,
    sell: r.sellPrice,
    spread: r.spreadPct,
  }));

  return (
    <div id="history-backtest-container" className="space-y-4">
      {/* Top Banner & Range Selector */}
      <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-[#2b2f36] pb-4">
          <div>
            <h2 className="text-xs uppercase text-[#848e9c] font-bold tracking-wider flex items-center gap-2">
              <History className="w-4 h-4 text-[#FCD535]" />
              HISTÓRICO REAL & VALIDACIÓN BACKTESTING
            </h2>
            <p className="text-[11px] text-[#848e9c] mt-0.5">
              Registro continuo desde la instalación. Sin datos sintéticos ni interpolaciones ficticias.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center bg-[#111417] p-1 rounded border border-[#2b2f36] text-xs">
              {['1h', '24h', '7d', '30d', 'all'].map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`px-3 py-1 rounded font-mono text-xs uppercase transition cursor-pointer ${
                    range === r ? 'bg-[#1e2329] text-[#FCD535] font-bold border border-[#FCD535]/40' : 'text-[#848e9c] hover:text-[#e0e0e0]'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>

            <button
              onClick={exportCSV}
              disabled={records.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#1e2329] hover:bg-[#2b2f36] text-[#e0e0e0] border border-[#474d57] text-xs font-medium cursor-pointer disabled:opacity-50 transition"
            >
              <Download className="w-3.5 h-3.5 text-[#FCD535]" />
              <span className="hidden sm:inline">Exportar CSV</span>
            </button>
          </div>
        </div>

        {/* Real History Summary Tracker */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-4 text-xs font-mono">
          <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]">
            <span className="text-[10px] text-[#848e9c] uppercase block">Histórico Disponible</span>
            <span className="text-sm font-bold text-[#FCD535]">
              {summary ? `${summary.availableDays} días (${summary.availableHours}h)` : '0 días'}
            </span>
          </div>

          <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]">
            <span className="text-[10px] text-[#848e9c] uppercase block">Total Registros</span>
            <span className="text-sm font-bold text-[#e0e0e0]">{summary?.totalRecords || 0} ticks</span>
          </div>

          <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]">
            <span className="text-[10px] text-[#848e9c] uppercase block">Primer Registro</span>
            <span className="text-xs text-[#848e9c] truncate block mt-0.5">
              {formatSafeDateTime(summary?.oldestTimestamp)}
            </span>
          </div>

          <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]">
            <span className="text-[10px] text-[#848e9c] uppercase block">Último Registro</span>
            <span className="text-xs text-[#02c076] truncate block mt-0.5">
              {formatSafeDateTime(summary?.newestTimestamp)}
            </span>
          </div>
        </div>
      </div>

      {/* Backtesting Performance Card */}
      <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-[#2b2f36] pb-3">
          <div>
            <h3 className="text-xs font-bold text-[#848e9c] uppercase tracking-wider flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#FCD535]" />
              MÉTRICAS DE PRECISIÓN HISTÓRICA DEL MODELO (BACKTESTING)
            </h3>
            <p className="text-[11px] text-[#848e9c]">
              Evaluación de predicciones pasadas vs precios reales que ocurrieron.
            </p>
          </div>
        </div>

        {backtest?.hasSufficientData ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3.5 rounded bg-[#111417] border border-[#2b2f36]">
              <span className="text-[10px] text-[#848e9c] uppercase font-mono block">Precisión Direccional</span>
              <span className="text-xl font-bold font-mono text-[#02c076]">{backtest.directionalAccuracyPct}%</span>
              <span className="text-[10px] text-[#848e9c] block mt-1">Acierto de tendencia</span>
            </div>

            <div className="p-3.5 rounded bg-[#111417] border border-[#2b2f36]">
              <span className="text-[10px] text-[#848e9c] uppercase font-mono block">Error Absoluto (MAE)</span>
              <span className="text-xl font-bold font-mono text-[#FCD535]">{backtest.mae} <span className="text-xs text-[#848e9c]">VES</span></span>
              <span className="text-[10px] text-[#848e9c] block mt-1">Mean Absolute Error</span>
            </div>

            <div className="p-3.5 rounded bg-[#111417] border border-[#2b2f36]">
              <span className="text-[10px] text-[#848e9c] uppercase font-mono block">Error Porcentual (MAPE)</span>
              <span className="text-xl font-bold font-mono text-[#e0e0e0]">{backtest.mape}%</span>
              <span className="text-[10px] text-[#848e9c] block mt-1">Desviación % promedio</span>
            </div>

            <div className="p-3.5 rounded bg-[#111417] border border-[#2b2f36]">
              <span className="text-[10px] text-[#848e9c] uppercase font-mono block">Muestras Evaluadas</span>
              <span className="text-xl font-bold font-mono text-[#e0e0e0]">{backtest.sampleSize}</span>
              <span className="text-[10px] text-[#848e9c] block mt-1">Ventanas históricas</span>
            </div>
          </div>
        ) : (
          <div className="p-4 rounded bg-[#111417] border border-[#FCD535]/30 text-xs text-[#FCD535] flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-[#FCD535] shrink-0 mt-0.5" />
            <div>
              <p className="font-bold">DATOS INSUFICIENTES PARA BACKTESTING</p>
              <p className="mt-0.5 text-[#848e9c]">
                Se requieren al menos 10 registros históricos acumulados en el Central Market Store para realizar la validación retrospectiva. El sistema está acumulando datos automáticamente con cada sondeo a Binance P2P.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Historical Time Series Chart */}
      <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-bold text-[#848e9c] uppercase tracking-wider">Serie Temporal de Precios Reales (USDT/VES)</h3>
        {chartData.length > 0 ? (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2b2f36" opacity={0.6} />
                <XAxis dataKey="time" stroke="#848e9c" fontSize={10} fontFamily="monospace" />
                <YAxis stroke="#848e9c" fontSize={10} fontFamily="monospace" domain={['auto', 'auto']} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#111417', borderColor: '#2b2f36', borderRadius: '4px', fontSize: '11px', color: '#e0e0e0', fontFamily: 'monospace' }}
                />
                <Line type="monotone" dataKey="sell" stroke="#FCD535" strokeWidth={2} name="Tasa Venta" dot={false} />
                <Line type="monotone" dataKey="buy" stroke="#02c076" strokeWidth={2} name="Tasa Recompra" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="p-8 text-center text-[#848e9c] text-xs font-mono">
            Sin registros en el rango seleccionado.
          </div>
        )}
      </div>
    </div>
  );
};

