import React, { useState, useEffect } from 'react';
import { AlertRule, AlertTriggerLog } from '../types';
import { ApiService } from '../api';
import { Bell, Plus, Trash2 } from 'lucide-react';

export const AlertsManager: React.FC = () => {
  const [alerts, setAlerts] = useState<AlertRule[]>([]);
  const [triggers, setTriggers] = useState<AlertTriggerLog[]>([]);
  const [isCreating, setIsCreating] = useState(false);

  // Form State
  const [name, setName] = useState('');
  const [condition, setCondition] = useState<'ABOVE' | 'BELOW' | 'SPREAD_ABOVE' | 'VOLATILITY_SPIKE'>('ABOVE');
  const [targetValue, setTargetValue] = useState('');
  const [targetSide, setTargetSide] = useState<'BUY' | 'SELL'>('BUY');

  const loadAlerts = async () => {
    try {
      const res = await ApiService.getAlerts();
      setAlerts(res.alerts || []);
      setTriggers(res.triggers || []);
    } catch (err) {
      console.error('Failed to load alerts:', err);
    }
  };

  useEffect(() => {
    loadAlerts();
    const interval = setInterval(loadAlerts, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !targetValue) return;

    try {
      await ApiService.createAlert({
        name,
        condition,
        targetValue: parseFloat(targetValue),
        targetSide,
        enabled: true,
      });
      setName('');
      setTargetValue('');
      setIsCreating(false);
      loadAlerts();
    } catch (err) {
      console.error('Failed to create alert:', err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await ApiService.deleteAlert(id);
      loadAlerts();
    } catch (err) {
      console.error('Failed to delete alert:', err);
    }
  };

  return (
    <div id="alerts-manager-container" className="space-y-4">
      {/* Header Banner */}
      <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xs uppercase text-[#848e9c] font-bold tracking-wider flex items-center gap-2">
            <Bell className="w-4 h-4 text-[#FCD535]" />
            SISTEMA DE ALERTAS EN TIEMPO REAL
          </h2>
          <p className="text-[11px] text-[#848e9c] mt-0.5">
            Monitoreo continuo conectado al Central Market Store de Binance P2P.
          </p>
        </div>

        <button
          onClick={() => setIsCreating(!isCreating)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#FCD535] hover:bg-[#FCD535]/90 text-black text-xs font-bold transition cursor-pointer font-mono"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Nueva Alerta</span>
        </button>
      </div>

      {/* Create Alert Modal / Panel */}
      {isCreating && (
        <form onSubmit={handleCreate} className="bg-[#181a20] border border-[#2b2f36] p-5 rounded-lg space-y-4">
          <h3 className="text-xs font-bold text-[#848e9c] uppercase tracking-wider">Configurar Regla de Alerta</h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <div>
              <label className="block text-[#848e9c] text-[10px] uppercase font-bold mb-1">Nombre Descriptivo</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ej. Tasa supera 930 VES"
                className="w-full px-3 py-2 bg-[#111417] border border-[#2b2f36] rounded text-[#e0e0e0] text-xs focus:outline-none focus:border-[#FCD535]"
                required
              />
            </div>

            <div>
              <label className="block text-[#848e9c] text-[10px] uppercase font-bold mb-1">Condición</label>
              <select
                value={condition}
                onChange={(e) => setCondition(e.target.value as any)}
                className="w-full px-3 py-2 bg-[#111417] border border-[#2b2f36] rounded text-[#e0e0e0] text-xs focus:outline-none focus:border-[#FCD535]"
              >
                <option value="ABOVE">Precio Supera (&gt;=)</option>
                <option value="BELOW">Precio Cae Debajo (&lt;=)</option>
                <option value="SPREAD_ABOVE">Spread Supera %</option>
                <option value="VOLATILITY_SPIKE">Pico de Volatilidad</option>
              </select>
            </div>

            <div>
              <label className="block text-[#848e9c] text-[10px] uppercase font-bold mb-1">Valor Objetivo</label>
              <input
                type="number"
                step="0.01"
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                placeholder="Ej. 930.00"
                className="w-full px-3 py-2 bg-[#111417] border border-[#2b2f36] rounded text-[#e0e0e0] text-xs focus:outline-none focus:border-[#FCD535] font-mono"
                required
              />
            </div>

            <div>
              <label className="block text-[#848e9c] text-[10px] uppercase font-bold mb-1">Lado</label>
              <select
                value={targetSide}
                onChange={(e) => setTargetSide(e.target.value as any)}
                className="w-full px-3 py-2 bg-[#111417] border border-[#2b2f36] rounded text-[#e0e0e0] text-xs focus:outline-none focus:border-[#FCD535]"
              >
                <option value="BUY">Recompra (BUY)</option>
                <option value="SELL">Venta (SELL)</option>
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsCreating(false)}
              className="px-3 py-1.5 bg-[#1e2329] hover:bg-[#2b2f36] text-[#e0e0e0] border border-[#474d57] rounded text-xs font-medium cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 bg-[#02c076] hover:bg-[#02c076]/90 text-black font-bold rounded text-xs cursor-pointer font-mono"
            >
              Guardar Alerta
            </button>
          </div>
        </form>
      )}

      {/* Rules List and Trigger Log */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Active Rules */}
        <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5 space-y-3">
          <h3 className="text-xs font-bold text-[#848e9c] uppercase tracking-wider pb-2 border-b border-[#2b2f36]">
            Reglas Activas ({alerts.length})
          </h3>

          <div className="space-y-2">
            {alerts.length > 0 ? (
              alerts.map((rule) => (
                <div
                  key={rule.id}
                  className="bg-[#111417] border border-[#2b2f36] p-3 rounded flex items-center justify-between text-xs"
                >
                  <div>
                    <div className="font-bold text-[#e0e0e0]">{rule.name}</div>
                    <div className="text-[11px] text-[#848e9c] font-mono mt-0.5">
                      {rule.condition} {rule.targetValue} ({rule.targetSide})
                    </div>
                  </div>

                  <button
                    onClick={() => handleDelete(rule.id)}
                    className="p-1.5 rounded bg-[#cf304a]/10 hover:bg-[#cf304a]/20 text-[#cf304a] border border-[#cf304a]/30 cursor-pointer transition"
                    title="Eliminar regla"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            ) : (
              <p className="text-xs text-[#848e9c] font-mono text-center py-4">
                No hay reglas configuradas.
              </p>
            )}
          </div>
        </div>

        {/* Trigger History */}
        <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5 space-y-3">
          <h3 className="text-xs font-bold text-[#848e9c] uppercase tracking-wider pb-2 border-b border-[#2b2f36]">
            Historial de Disparos Recientes
          </h3>

          <div className="space-y-2 max-h-72 overflow-y-auto no-scrollbar">
            {triggers.length > 0 ? (
              triggers.map((tr) => (
                <div
                  key={tr.id}
                  className="bg-[#111417] border border-[#2b2f36] p-3 rounded text-xs space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[#FCD535]">{tr.ruleName}</span>
                    <span className="text-[10px] text-[#848e9c] font-mono">
                      {(() => {
                        try {
                          const d = new Date(tr.timestamp);
                          return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
                        } catch {
                          return '--:--:--';
                        }
                      })()}
                    </span>
                  </div>
                  <p className="text-[#e0e0e0] text-[11px] font-mono">{tr.message}</p>
                </div>
              ))
            ) : (
              <p className="text-xs text-[#848e9c] font-mono text-center py-6">
                No hay disparos de alertas registrados aún.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

