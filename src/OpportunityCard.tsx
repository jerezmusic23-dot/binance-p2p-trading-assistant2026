/**
 * OPORTUNIDAD EJECUTABLE
 *
 * Renders `bestOpportunity` exactly as the backend computed it - the SAME
 * object Telegram receives. This component performs no economic calculation:
 * it does not compute a spread, does not compare banks, does not decide what
 * counts as an opportunity.
 *
 * It can never be built from snapshot.strategicBuyPrice / strategicSellPrice.
 * Those are the median of the whole book with no bank and no amount, and an
 * arbitrage declared from them is an arbitrage nobody can execute. An
 * Opportunity always names its bank and its amount because it is copied from
 * the executability cell those two identify.
 */

import React, { useEffect, useState } from 'react';
import { Opportunity } from './types';
import { ApiService } from './api';
import { CheckCircle2, HelpCircle, Info, RefreshCw } from 'lucide-react';

const fmtVes = (v: number) => v.toFixed(2);

/** Signed, always. A loss keeps its minus sign. */
const fmtSpread = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(4)}%`;

export const OpportunityCard: React.FC = () => {
  const [best, setBest] = useState<Opportunity | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [capturedAt, setCapturedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      setRefreshing(true);
      const res = await ApiService.getOpportunities();
      setBest(res.bestOpportunity);
      setCapturedAt(res.timestamp);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Error al obtener oportunidades');
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] uppercase text-[#848e9c] font-bold tracking-wider">
          Oportunidad ejecutable
        </span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="flex items-center gap-1 text-[10px] text-[#848e9c] hover:text-[#FCD535] transition-colors"
        >
          <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
          Refrescar
        </button>
      </div>

      {error !== null && <p className="text-xs text-[#f6465d]">{error}</p>}

      {/*
        Three distinct states, none of them a zero:
          not loaded yet  - we do not know
          loaded, null    - the book holds no executable operation right now
          loaded, present - a real operation, named by bank and amount
      */}
      {error === null && !loaded && (
        <p className="text-xs text-[#848e9c]">Evaluando el libro…</p>
      )}

      {error === null && loaded && best === null && (
        <div className="flex items-start gap-2 text-[#848e9c]">
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="text-xs leading-relaxed">
            <strong className="block text-[#e0e0e0] mb-1">SIN OPORTUNIDAD</strong>
            Ningún par banco/monto ofrece ahora mismo una venta por encima de la recompra con
            liquidez verificada. No se muestra ninguna tasa global en su lugar.
          </div>
        </div>
      )}

      {error === null && best !== null && (
        <div className="space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono">
            <span className="text-[#848e9c]">Banco</span>
            <span className="text-[#e0e0e0] font-semibold text-right">{best.bank}</span>

            <span className="text-[#848e9c]">Monto</span>
            <span className="text-[#e0e0e0] text-right">
              {best.amountVes.toLocaleString('es-VE')} VES
            </span>

            <span className="text-[#848e9c]">
              COMPRA ARBITRAJE
              <span className="block text-[9px] text-[#5e6673]">
                yo compro USDT · Binance ASK · tradeType BUY
              </span>
            </span>
            <span className="text-[#02c076] text-right">{fmtVes(best.buyPrice)} VES</span>

            <span className="text-[#848e9c]">
              VENTA ARBITRAJE
              <span className="block text-[9px] text-[#5e6673]">
                yo vendo USDT · Binance BID · tradeType SELL
              </span>
            </span>
            <span className="text-[#FCD535] text-right">{fmtVes(best.sellPrice)} VES</span>

            <span className="text-[#848e9c]">Spread</span>
            <span
              className={`text-right font-bold ${
                best.spreadPct > 0 ? 'text-[#02c076]' : 'text-[#f6465d]'
              }`}
            >
              {fmtSpread(best.spreadPct)}
            </span>

            <span className="text-[#848e9c]">Liquidez</span>
            <span className="text-[#e0e0e0] text-right">
              {best.availableUsdt === null
                ? 'no verificable'
                : `${best.availableUsdt.toFixed(2)} USDT`}
            </span>

            <span className="text-[#848e9c]">Estado</span>
            <span className="text-right flex items-center justify-end gap-1">
              {best.verification === 'VERIFIED' ? (
                <>
                  <CheckCircle2 className="w-3 h-3 text-[#02c076]" />
                  <span className="text-[#02c076] font-bold">EXECUTABLE</span>
                </>
              ) : (
                <>
                  <HelpCircle className="w-3 h-3 text-[#848e9c]" />
                  <span className="text-[#848e9c] font-bold">{best.verification}</span>
                </>
              )}
            </span>

            {capturedAt !== null && (
              <>
                <span className="text-[#848e9c]">Capturado</span>
                <span className="text-[#848e9c] text-right">
                  {new Date(capturedAt).toLocaleTimeString('es-VE')}
                </span>
              </>
            )}
          </div>

          <p className="text-[9px] text-[#5e6673] leading-snug pt-2 border-t border-[#2b2f36]">
            MARGEN BRUTO: no descuenta comisión de Binance, transferencia bancaria, slippage,
            redondeos ni tiempo de ejecución. NO es beneficio neto.
          </p>
        </div>
      )}
    </div>
  );
};
