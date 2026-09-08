/**
 * ANUNCIOS REALES P2P — EXPLORADOR INDEPENDIENTE
 * ================================================
 *
 * Consulta el libro real de Binance P2P, con dos modos que NUNCA se mezclan:
 *
 *   MERCADO GENERAL   banco=ALL, monto=ALL -> payTypes: [] · transAmount: null
 *                      y excluye Recarga Pines de la referencia (server-side,
 *                      binanceP2PService.ts::filterGeneralReferenceAds).
 *   CONSULTA ESPECÍFICA  banco y/o monto elegidos -> payTypes/transAmount
 *                      reales para ESE banco/monto.
 *
 * Esto es una consulta simple, no una matriz: una selección de banco+monto a
 * la vez, con los anuncios reales de esa consulta. La Matriz Multifiltro fue
 * retirada deliberadamente y esta pantalla no la reintroduce - no hay una
 * grilla banco×monto aquí, sólo la consulta activa.
 *
 * NUNCA presenta datos de otro banco/monto bajo la etiqueta del banco pedido:
 * si la consulta específica falla o no tiene anuncios verificables
 * (`snapshot.filterFallbackReason` presente, o snapshot ausente), la pantalla
 * dice NO DISPONIBLE en vez de mostrar en silencio los números generales.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, ArrowUpRight, ArrowDownRight, RefreshCw, RotateCcw, AlertTriangle } from 'lucide-react';
import { ApiService } from './api';
import { fmt } from './format';
import type { AmountFilterKey, BankFilterKey, MarketSnapshot, NormalizedAd } from './types';

export const BANK_OPTIONS: { key: BankFilterKey; name: string; shortName: string }[] = [
  { key: 'ALL', name: 'Mercado General (todos los bancos)', shortName: 'General' },
  { key: 'BANESCO', name: 'Banesco', shortName: 'Banesco' },
  { key: 'PROVINCIAL', name: 'Provincial (BBVA)', shortName: 'Provincial' },
  { key: 'MERCANTIL', name: 'Mercantil', shortName: 'Mercantil' },
  { key: 'VENEZUELA', name: 'Banco de Venezuela', shortName: 'Venezuela' },
  { key: 'BNC', name: 'Banco Nacional de Crédito', shortName: 'BNC' },
  { key: 'BANCAMIGA', name: 'Bancamiga', shortName: 'Bancamiga' },
  { key: 'PAGO_MOVIL', name: 'Pago Móvil', shortName: 'Pago Móvil' },
];

export const AMOUNT_OPTIONS: { key: AmountFilterKey; label: string; val: number | null }[] = [
  { key: 'ALL', label: 'Todos los montos', val: null },
  { key: '10K', label: '10K VES', val: 10000 },
  { key: '20K', label: '20K VES', val: 20000 },
  { key: '30K', label: '30K VES', val: 30000 },
  { key: '40K', label: '40K VES', val: 40000 },
  { key: '50K', label: '50K VES', val: 50000 },
  { key: '100K', label: '100K VES', val: 100000 },
];

/**
 * La consulta se pidió filtrada pero el servidor no la pudo honrar (falló o
 * no había anuncios verificables): jamás se presenta el sustituto general
 * como si fuera del banco/monto pedido - un banco sin anuncios muestra
 * NO DISPONIBLE, nunca los números generales bajo su nombre.
 */
export function isQueryUnavailable(isFilteredQuery: boolean, snapshot: MarketSnapshot | null): boolean {
  return isFilteredQuery && (snapshot === null || Boolean(snapshot.filterFallbackReason));
}

/** La consulta se muestra sobre la etiqueta REAL que el servidor confirmó, nunca sobre la pedida. */
export function queryLabel(snapshot: MarketSnapshot | null, requestedBank: BankFilterKey, requestedAmount: AmountFilterKey): string {
  if (requestedBank === 'ALL' && requestedAmount === 'ALL') return 'MERCADO GENERAL';
  if (!snapshot || snapshot.filterFallbackReason) {
    const amountText = requestedAmount === 'ALL' ? '' : ` · ${requestedAmount}`;
    const bankText = requestedBank === 'ALL' ? 'Todos los bancos' : requestedBank;
    return `${bankText}${amountText} (no disponible)`;
  }
  const bankText = snapshot.filterBankName ?? (snapshot.filterBank === 'ALL' || !snapshot.filterBank ? 'Todos los bancos' : snapshot.filterBank);
  const amountText = snapshot.filterAmount ? ` · ${requestedAmount !== 'ALL' ? requestedAmount : `${snapshot.filterAmount.toLocaleString()} VES`}` : '';
  return `${bankText}${amountText}`.toUpperCase();
}

export const OrderBookView: React.FC = () => {
  const [bank, setBank] = useState<BankFilterKey>('ALL');
  const [amount, setAmount] = useState<AmountFilterKey>('ALL');
  const [activeSide, setActiveSide] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (queryBank: BankFilterKey, queryAmount: AmountFilterKey, force: boolean) => {
    setLoading(true);
    setError(null);
    const amountVal = AMOUNT_OPTIONS.find((a) => a.key === queryAmount)?.val ?? null;
    try {
      const result = force
        ? await ApiService.refreshMarket(queryBank, amountVal ?? undefined)
        : await ApiService.getLatestMarket(queryBank, amountVal ?? undefined);
      setSnapshot(result?.snapshot ?? null);
    } catch (err: any) {
      setSnapshot(null);
      setError(err?.message ?? 'No se pudo consultar Binance P2P.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(bank, amount, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bank, amount]);

  const handleReset = () => {
    setBank('ALL');
    setAmount('ALL');
  };

  const isFilteredQuery = bank !== 'ALL' || amount !== 'ALL';
  const isUnavailable = isQueryUnavailable(isFilteredQuery, snapshot);

  const renderAdCard = (ad: NormalizedAd, type: 'BUY' | 'SELL') => {
    const isBuy = type === 'BUY';
    return (
      <div key={ad.advNo} className="bg-[#111417] border border-[#2b2f36] rounded p-3.5 hover:border-[#474d57] transition space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-bold text-[#e0e0e0] text-xs truncate max-w-[130px]">{ad.merchantName}</span>
            {ad.userType === 'merchant' && (
              <span className="px-1.5 py-0.2 rounded bg-[#FCD535]/15 text-[#FCD535] text-[10px] font-bold border border-[#FCD535]/30">PRO</span>
            )}
          </div>
          <div className="text-[11px] text-[#848e9c] font-mono">
            {ad.ordersCount} órd. · <span className="text-[#02c076]">{(ad.finishRate * 100).toFixed(1)}%</span>
          </div>
        </div>
        <div className="flex items-baseline justify-between pt-1 border-t border-[#2b2f36]">
          <span className="text-[10px] uppercase text-[#848e9c] font-semibold">Precio:</span>
          <span className={`text-base font-bold font-mono ${isBuy ? 'text-[#02c076]' : 'text-[#FCD535]'}`}>
            {ad.price.toFixed(2)} <span className="text-[10px] text-[#848e9c]">VES</span>
          </span>
        </div>
        <div className="text-[11px] text-[#848e9c] space-y-1 font-mono">
          <div className="flex justify-between">
            <span>Disponible:</span>
            <span className="text-[#e0e0e0]">{ad.availableUsdt.toFixed(2)} USDT</span>
          </div>
          <div className="flex justify-between">
            <span>Límites:</span>
            <span className="text-[#e0e0e0]">{ad.minAmountVes.toLocaleString()} - {ad.maxAmountVes.toLocaleString()} VES</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1 pt-1">
          {ad.paymentMethods.map((pm, idx) => (
            <span key={idx} className="px-1.5 py-0.5 rounded bg-[#181a20] text-[#848e9c] text-[10px] border border-[#2b2f36]">{pm}</span>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div id="orderbook-view-container" className="space-y-4">
      <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5">
        <div className="flex flex-col gap-3 border-b border-[#2b2f36] pb-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xs uppercase text-[#848e9c] font-bold tracking-wider flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-[#FCD535]" />
                ANUNCIOS REALES P2P
              </h2>
              <p className="text-[11px] text-[#848e9c] mt-0.5">
                Consulta directa al libro de Binance P2P, banco y monto a la vez. No es una matriz.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void load(bank, amount, true)}
                disabled={loading}
                className="p-1.5 text-[#848e9c] hover:text-[#eaecef] disabled:opacity-50"
                title="Actualizar"
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </button>
              {isFilteredQuery && (
                <button
                  type="button"
                  onClick={handleReset}
                  className="flex items-center gap-1 px-2 py-1 rounded border border-[#2b2f36] text-[10px] text-[#848e9c] hover:text-[#eaecef] hover:border-[#474d57]"
                  title="Volver al mercado general"
                >
                  <RotateCcw size={11} /> Mercado general
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] uppercase tracking-wider text-[#5e6673] font-mono mr-1">Banco:</span>
              {BANK_OPTIONS.map((b) => (
                <button
                  key={b.key}
                  onClick={() => setBank(b.key)}
                  className={`px-2.5 py-1 rounded text-[11px] font-mono transition cursor-pointer border ${
                    bank === b.key ? 'bg-[#1e2329] text-[#FCD535] border-[#FCD535]' : 'text-[#848e9c] border-[#2b2f36] hover:text-[#e0e0e0]'
                  }`}
                >
                  {b.shortName}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] uppercase tracking-wider text-[#5e6673] font-mono mr-1">Monto:</span>
              {AMOUNT_OPTIONS.map((a) => (
                <button
                  key={a.key}
                  onClick={() => setAmount(a.key)}
                  className={`px-2.5 py-1 rounded text-[11px] font-mono transition cursor-pointer border ${
                    amount === a.key ? 'bg-[#1e2329] text-[#FCD535] border-[#FCD535]' : 'text-[#848e9c] border-[#2b2f36] hover:text-[#e0e0e0]'
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-xs font-mono font-bold text-[#eaecef]">
              {loading && !snapshot ? 'Consultando…' : queryLabel(snapshot, bank, amount)}
            </div>
            {!isUnavailable && (
              <div className="flex items-center gap-1 bg-[#111417] p-1 rounded border border-[#2b2f36] text-xs">
                <button onClick={() => setActiveSide('ALL')} className={`px-3 py-1 rounded text-xs font-mono transition cursor-pointer ${activeSide === 'ALL' ? 'bg-[#1e2329] text-[#e0e0e0] border border-[#474d57]' : 'text-[#848e9c] hover:text-[#e0e0e0]'}`}>Ambos Lados</button>
                <button onClick={() => setActiveSide('BUY')} className={`px-3 py-1 rounded text-xs font-mono font-bold transition cursor-pointer ${activeSide === 'BUY' ? 'bg-[#1e2329] text-[#02c076] border border-[#02c076]' : 'text-[#848e9c] hover:text-[#e0e0e0]'}`}>Recompra (BUY)</button>
                <button onClick={() => setActiveSide('SELL')} className={`px-3 py-1 rounded text-xs font-mono font-bold transition cursor-pointer ${activeSide === 'SELL' ? 'bg-[#1e2329] text-[#FCD535] border border-[#FCD535]' : 'text-[#848e9c] hover:text-[#e0e0e0]'}`}>Venta (SELL)</button>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="mt-3 p-2.5 rounded bg-[#cf304a]/10 border border-[#cf304a]/30 text-[#cf304a] text-xs font-mono">{error}</div>
        )}

        {!error && isUnavailable && (
          <div id="orderbook-no-disponible" className="mt-3 p-4 rounded bg-[#181a20] border border-[#f0b90b]/30 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-[#f0b90b] mt-0.5 shrink-0" />
            <div className="text-xs text-[#e0e0e0]">
              <div className="font-bold uppercase tracking-wide text-[#f0b90b]">NO DISPONIBLE</div>
              <p className="mt-1 text-[#848e9c]">
                {bank === 'ALL' ? 'Ese monto' : BANK_OPTIONS.find((b) => b.key === bank)?.name ?? bank}
                {amount !== 'ALL' ? ` · ${amount}` : ''} no tiene anuncios verificables ahora mismo.
              </p>
              <p className="mt-1 text-[#5e6673]">
                No se muestran datos del mercado general ni de otro banco en su lugar.
              </p>
            </div>
          </div>
        )}

        {!error && !isUnavailable && snapshot && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-4 text-xs font-mono">
            <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]">
              <span className="text-[10px] text-[#848e9c] uppercase block">Promedio Compra</span>
              <span className="text-sm font-bold text-[#02c076]">{fmt(snapshot.averageBuyPrice, 2)} VES</span>
              <span className="text-[9px] text-[#848e9c] block mt-0.5">Tasa agregada</span>
            </div>
            <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]">
              <span className="text-[10px] text-[#848e9c] uppercase block">Promedio Venta</span>
              <span className="text-sm font-bold text-[#FCD535]">{fmt(snapshot.averageSellPrice, 2)} VES</span>
              <span className="text-[9px] text-[#848e9c] block mt-0.5">Tasa agregada</span>
            </div>
            <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]">
              <span className="text-[10px] text-[#848e9c] uppercase block">Mediana Compra</span>
              <span className="text-sm font-bold text-[#02c076]">{fmt(snapshot.medianBuyPrice, 2)} VES</span>
              <span className="text-[9px] text-[#848e9c] block mt-0.5">Tasa agregada</span>
            </div>
            <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]">
              <span className="text-[10px] text-[#848e9c] uppercase block">Ponderado Liquidez</span>
              <span className="text-sm font-bold text-[#e0e0e0]">{fmt(snapshot.weightedBuyPrice, 2)} VES</span>
              <span className="text-[9px] text-[#848e9c] block mt-0.5">Volumen USDT</span>
            </div>
          </div>
        )}
      </div>

      {!error && !isUnavailable && snapshot && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(activeSide === 'ALL' || activeSide === 'BUY') && (
            <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-[#2b2f36]">
                <div className="flex items-center gap-2">
                  <ArrowDownRight className="w-4 h-4 text-[#02c076]" />
                  <h3 className="font-bold text-[#e0e0e0] text-xs uppercase tracking-wider">Anuncios de Recompra (Tú pagas VES)</h3>
                </div>
                <span className="text-xs font-mono font-bold text-[#02c076]">Mejor: {fmt(snapshot.bestBuyPrice, 2)} VES</span>
              </div>
              {snapshot.topBuyAds.length === 0 ? (
                <div className="text-[11px] text-[#848e9c] py-3 text-center">Sin anuncios de este lado ahora mismo.</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{snapshot.topBuyAds.map((ad) => renderAdCard(ad, 'BUY'))}</div>
              )}
            </div>
          )}
          {(activeSide === 'ALL' || activeSide === 'SELL') && (
            <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-[#2b2f36]">
                <div className="flex items-center gap-2">
                  <ArrowUpRight className="w-4 h-4 text-[#FCD535]" />
                  <h3 className="font-bold text-[#e0e0e0] text-xs uppercase tracking-wider">Anuncios de Venta (Tú recibes VES)</h3>
                </div>
                <span className="text-xs font-mono font-bold text-[#FCD535]">Mejor: {fmt(snapshot.bestSellPrice, 2)} VES</span>
              </div>
              {snapshot.topSellAds.length === 0 ? (
                <div className="text-[11px] text-[#848e9c] py-3 text-center">Sin anuncios de este lado ahora mismo.</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{snapshot.topSellAds.map((ad) => renderAdCard(ad, 'SELL'))}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
