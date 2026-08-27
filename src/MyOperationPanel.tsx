/**
 * MI OPERACIÓN.
 *
 * The screen answers, without the reader having to translate anything:
 *
 *     what do I pay, what do I receive, what is left, can I execute it.
 *
 * The words BUY and SELL from the Binance API never appear as a heading here.
 * They are shown, but as provenance underneath the economics, because "BUY"
 * has meant two opposite things to two readers of this project and that
 * ambiguity has cost more than any bug in it.
 *
 * This component computes NOTHING. Every figure is read from the Opportunity
 * the backend built - the same object the matrix cell carries and the same one
 * Telegram sends.
 */

import React, { useEffect, useState } from 'react';
import { Opportunity } from './types';
import { ApiService } from './api';
import { ArrowDownToLine, ArrowUpFromLine, RefreshCw, ShieldCheck, Info } from 'lucide-react';

const ves = (v: number) => v.toFixed(2);

/** Signed, four decimals: real spreads here live in the third and fourth. */
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(4)}%`;
const signedVes = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

const Leg: React.FC<{
  kind: 'BUY' | 'SELL';
  price: number;
  liquidity: number | null;
}> = ({ kind, price, liquidity }) => {
  const buying = kind === 'BUY';
  return (
    <div
      className={`flex-1 rounded-lg border p-4 ${
        buying
          ? 'border-[#02c076]/40 bg-[#02c076]/[0.06]'
          : 'border-[#FCD535]/40 bg-[#FCD535]/[0.06]'
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        {buying ? (
          <ArrowDownToLine className="w-4 h-4 text-[#02c076]" />
        ) : (
          <ArrowUpFromLine className="w-4 h-4 text-[#FCD535]" />
        )}
        <span
          className={`text-[11px] font-black uppercase tracking-wider ${
            buying ? 'text-[#02c076]' : 'text-[#FCD535]'
          }`}
        >
          {buying ? 'Compro USDT' : 'Vendo USDT'}
        </span>
      </div>

      <div className="font-mono text-2xl font-black text-[#e0e0e0] leading-none">
        {ves(price)}
        <span className="text-[11px] font-semibold text-[#848e9c] ml-1.5">VES</span>
      </div>

      <p className="text-[10px] text-[#848e9c] mt-1.5">
        {buying ? 'Es lo que pago por cada USDT' : 'Es lo que recibo por cada USDT'}
      </p>

      {/* Provenance, deliberately subordinate to the economics above. */}
      <div className="mt-3 pt-2 border-t border-[#2b2f36] text-[9px] text-[#5e6673] leading-relaxed">
        <div>Anuncio que {buying ? 'VENDE' : 'COMPRA'} USDT</div>
        <div>
          Binance {buying ? 'ASK' : 'BID'} · <code>tradeType={buying ? 'BUY' : 'SELL'}</code>
        </div>
        <div className="mt-1 text-[#848e9c]">
          Liquidez: {liquidity === null ? 'no verificable' : `${liquidity.toFixed(2)} USDT`}
        </div>
      </div>
    </div>
  );
};

export const MyOperationPanel: React.FC = () => {
  const [best, setBest] = useState<Opportunity | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [capturedAt, setCapturedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setBusy(true);
      const res = await ApiService.getOpportunities();
      setBest(res.bestOpportunity);
      setCapturedAt(res.timestamp);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Error al obtener la operación');
    } finally {
      setLoaded(true);
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    /*
     * The bot finds opportunities on its own; this only mirrors that state.
     * Polling keeps the screen honest without ever being the thing that makes
     * the robot work.
     */
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-black text-[#e0e0e0] uppercase tracking-wider">
            Mi operación
          </h2>
          <p className="text-[10px] text-[#848e9c] mt-0.5">
            La mejor operación ejecutable ahora mismo en Binance P2P USDT/VES
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          className="flex items-center gap-1 text-[10px] text-[#848e9c] hover:text-[#FCD535] transition-colors"
        >
          <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} />
          Actualizar
        </button>
      </header>

      {error !== null && <p className="text-xs text-[#f6465d]">{error}</p>}

      {error === null && !loaded && (
        <p className="text-xs text-[#848e9c]">Evaluando el libro de Binance…</p>
      )}

      {error === null && loaded && best === null && (
        <div className="flex items-start gap-2 text-[#848e9c] py-4">
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="text-xs leading-relaxed">
            <strong className="block text-[#e0e0e0] mb-1 text-sm">SIN OPERACIÓN</strong>
            Ahora mismo no existe ningún par banco/monto donde el precio al que puedo vender
            supere al precio al que puedo comprar, con liquidez verificada en ambos lados.
            <span className="block mt-1 text-[#5e6673]">
              No se muestra ninguna tasa de referencia en su lugar: una referencia no es una
              operación.
            </span>
          </div>
        </div>
      )}

      {error === null && best !== null && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <Leg kind="BUY" price={best.arbitrageBuyPrice} liquidity={best.buyAvailableUsdt} />
            <Leg kind="SELL" price={best.arbitrageSellPrice} liquidity={best.sellAvailableUsdt} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-[#0b0e11] rounded-lg p-3 border border-[#2b2f36]">
              <span className="text-[9px] uppercase text-[#848e9c] font-bold block">Spread</span>
              <span
                className={`font-mono text-lg font-bold ${
                  best.spreadAbsolute > 0 ? 'text-[#02c076]' : 'text-[#f6465d]'
                }`}
              >
                {signedVes(best.spreadAbsolute)}
                <span className="text-[10px] text-[#848e9c] ml-1">VES</span>
              </span>
            </div>
            <div className="bg-[#0b0e11] rounded-lg p-3 border border-[#2b2f36]">
              <span className="text-[9px] uppercase text-[#848e9c] font-bold block">
                Rendimiento
              </span>
              <span
                className={`font-mono text-lg font-bold ${
                  best.marginPct > 0 ? 'text-[#02c076]' : 'text-[#f6465d]'
                }`}
              >
                {pct(best.marginPct)}
              </span>
            </div>
            <div className="bg-[#0b0e11] rounded-lg p-3 border border-[#2b2f36]">
              <span className="text-[9px] uppercase text-[#848e9c] font-bold block">Banco</span>
              <span className="font-mono text-sm font-bold text-[#e0e0e0]">{best.bank}</span>
            </div>
            <div className="bg-[#0b0e11] rounded-lg p-3 border border-[#2b2f36]">
              <span className="text-[9px] uppercase text-[#848e9c] font-bold block">Monto</span>
              <span className="font-mono text-sm font-bold text-[#e0e0e0]">
                {best.amountVes.toLocaleString('es-VE')}
                <span className="text-[10px] text-[#848e9c] ml-1">VES</span>
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between flex-wrap gap-2 pt-2 border-t border-[#2b2f36]">
            <span className="flex items-center gap-1.5 text-xs">
              <ShieldCheck className="w-4 h-4 text-[#02c076]" />
              <strong className="text-[#02c076] font-bold">{best.verification} / EXECUTABLE</strong>
            </span>
            {capturedAt !== null && (
              <span className="text-[10px] text-[#848e9c] font-mono">
                Capturado {new Date(capturedAt).toLocaleTimeString('es-VE')}
              </span>
            )}
          </div>

          <p className="text-[9px] text-[#5e6673] leading-snug">
            MARGEN BRUTO: no descuenta comisión de Binance, transferencia bancaria, slippage,
            redondeos ni otros costes operativos. NO es beneficio neto.
          </p>
        </div>
      )}
    </section>
  );
};
