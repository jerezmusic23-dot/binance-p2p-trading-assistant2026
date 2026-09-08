import React, { useEffect, useMemo, useState } from 'react';
import { BookOpen, ArrowUpRight, ArrowDownRight, RefreshCw } from 'lucide-react';
import { ApiService } from './api';
import type { BankFilterKey, MarketSnapshot, NormalizedAd } from './types';
import { fmt } from './format';

interface OrderBookViewProps {
  snapshot: MarketSnapshot | null;
}

const BANKS: Array<{ key: BankFilterKey; label: string }> = [
  { key: 'ALL', label: 'Todos los bancos' },
  { key: 'BANESCO', label: 'Banesco' },
  { key: 'PROVINCIAL', label: 'Provincial (BBVA)' },
  { key: 'MERCANTIL', label: 'Mercantil' },
  { key: 'BNC', label: 'BNC' },
  { key: 'BANCAMIGA', label: 'Bancamiga' },
  { key: 'VENEZUELA', label: 'Banco de Venezuela' },
  { key: 'PAGO_MOVIL', label: 'Pago Móvil' },
];

const AMOUNTS: Array<{ key: 'ALL' | '10K' | '20K' | '30K' | '40K' | '50K' | '100K'; value: number | undefined }> = [
  { key: 'ALL', value: undefined },
  { key: '10K', value: 10_000 },
  { key: '20K', value: 20_000 },
  { key: '30K', value: 30_000 },
  { key: '40K', value: 40_000 },
  { key: '50K', value: 50_000 },
  { key: '100K', value: 100_000 },
];

export function isQueryUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('no active p2p ads') || message.includes('no disponible') || message.includes('http 404');
}

interface FilteredState {
  snapshot: MarketSnapshot | null;
  loading: boolean;
  unavailable: boolean;
  error: string | null;
}

export const OrderBookView: React.FC<OrderBookViewProps> = ({ snapshot: generalSnapshot }) => {
  const [bank, setBank] = useState<BankFilterKey>('ALL');
  const [amountKey, setAmountKey] = useState<(typeof AMOUNTS)[number]['key']>('ALL');
  const [activeSide, setActiveSide] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  const [state, setState] = useState<FilteredState>({
    snapshot: generalSnapshot,
    loading: false,
    unavailable: false,
    error: null,
  });

  const amount = useMemo(
    () => AMOUNTS.find((item) => item.key === amountKey)?.value,
    [amountKey]
  );

  const selectedBankLabel = BANKS.find((item) => item.key === bank)?.label ?? bank;

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setState({ snapshot: null, loading: true, unavailable: false, error: null });
      try {
        const result = await ApiService.getLatestMarket(bank === 'ALL' ? undefined : bank, amount);
        if (cancelled) return;
        setState({ snapshot: result.snapshot, loading: false, unavailable: false, error: null });
      } catch (error) {
        if (cancelled) return;
        const unavailable = isQueryUnavailable(error);
        setState({
          snapshot: null,
          loading: false,
          unavailable,
          error: unavailable
            ? `${selectedBankLabel}${amount ? ` · ${amountKey}` : ''} no disponible`
            : error instanceof Error ? error.message : 'Error consultando Binance P2P',
        });
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bank, amount, amountKey, selectedBankLabel]);

  const snapshot = state.snapshot;

  const renderAdCard = (ad: NormalizedAd, type: 'BUY' | 'SELL') => {
    const isBuy = type === 'BUY';
    return (
      <div key={ad.advNo} className="bg-[#111417] border border-[#2b2f36] rounded p-3.5 hover:border-[#474d57] transition space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-bold text-[#e0e0e0] text-xs truncate max-w-[150px]">{ad.merchantName}</span>
            {ad.userType === 'merchant' && <span className="px-1.5 py-0.2 rounded bg-[#FCD535]/15 text-[#FCD535] text-[10px] font-bold border border-[#FCD535]/30">PRO</span>}
          </div>
          <div className="text-[11px] text-[#848e9c] font-mono whitespace-nowrap">
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
          <div className="flex justify-between"><span>Disponible:</span><span className="text-[#e0e0e0]">{ad.availableUsdt.toFixed(2)} USDT</span></div>
          <div className="flex justify-between"><span>Límites:</span><span className="text-[#e0e0e0]">{ad.minAmountVes.toLocaleString()} - {ad.maxAmountVes.toLocaleString()} VES</span></div>
        </div>
        <div className="flex flex-wrap gap-1 pt-1">
          {ad.paymentMethods.map((method, index) => (
            <span key={`${ad.advNo}-${index}`} className="px-1.5 py-0.5 rounded bg-[#181a20] text-[#848e9c] text-[10px] border border-[#2b2f36]">{method}</span>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div id="orderbook-view-container" className="space-y-4">
      <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div>
              <h2 className="text-xs uppercase text-[#848e9c] font-bold tracking-wider flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-[#FCD535]" /> ANUNCIOS REALES P2P
              </h2>
              <p className="text-[11px] text-[#848e9c] mt-1">Consulta directa a Binance. El banco y el monto seleccionados se consultan por separado; no se sustituyen con el mercado general.</p>
            </div>
            <button type="button" onClick={() => { setBank('ALL'); setAmountKey('ALL'); setActiveSide('ALL'); }} className="px-3 py-2 rounded border border-[#2b2f36] text-[11px] font-mono text-[#848e9c] hover:text-[#e0e0e0] hover:border-[#474d57]">Restablecer</button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="space-y-1"><span className="text-[10px] uppercase tracking-wider text-[#848e9c] font-bold">Banco</span><select value={bank} onChange={(event) => setBank(event.target.value as BankFilterKey)} className="w-full bg-[#111417] border border-[#2b2f36] rounded px-3 py-2 text-xs text-[#e0e0e0]">{BANKS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
            <label className="space-y-1"><span className="text-[10px] uppercase tracking-wider text-[#848e9c] font-bold">Monto de operación</span><select value={amountKey} onChange={(event) => setAmountKey(event.target.value as typeof amountKey)} className="w-full bg-[#111417] border border-[#2b2f36] rounded px-3 py-2 text-xs text-[#e0e0e0]">{AMOUNTS.map((item) => <option key={item.key} value={item.key}>{item.key === 'ALL' ? 'Todos los montos' : `${item.key} VES`}</option>)}</select></label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[11px] font-mono text-[#848e9c]">Consulta: <span className="text-[#e0e0e0]">{selectedBankLabel}</span>{amount ? <><span> · </span><span className="text-[#e0e0e0]">{amountKey}</span></> : null}</div>
            <div className="flex items-center gap-1 bg-[#111417] p-1 rounded border border-[#2b2f36] text-xs">
              {(['ALL', 'BUY', 'SELL'] as const).map((side) => <button key={side} type="button" onClick={() => setActiveSide(side)} className={`px-3 py-1 rounded text-xs font-mono transition ${activeSide === side ? 'bg-[#1e2329] text-[#e0e0e0] border border-[#474d57]' : 'text-[#848e9c] hover:text-[#e0e0e0]'}`}>{side === 'ALL' ? 'Ambos lados' : side === 'BUY' ? 'Compra (BUY)' : 'Venta (SELL)'}</button>)}
            </div>
          </div>
        </div>
      </div>

      {state.loading && !snapshot && <div className="p-8 text-center bg-[#181a20] rounded-lg border border-[#2b2f36] text-[#848e9c] text-xs font-mono flex items-center justify-center gap-2"><RefreshCw className="w-4 h-4 animate-spin" /> Consultando Binance P2P...</div>}
      {state.unavailable && <div className="p-8 text-center bg-[#181a20] rounded-lg border border-[#cf304a]/30"><p className="text-[#cf304a] font-bold text-sm">NO DISPONIBLE</p><p className="text-[#848e9c] text-xs mt-1 font-mono">{state.error}</p><p className="text-[#848e9c] text-[10px] mt-2">No se muestran precios del mercado general para rellenar esta consulta.</p></div>}
      {state.error && !state.unavailable && <div className="p-3 rounded bg-[#cf304a]/10 border border-[#cf304a]/30 text-[#cf304a] text-xs font-mono">{state.error}</div>}

      {snapshot && !state.unavailable && <>
        <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
            <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]"><span className="text-[10px] text-[#848e9c] uppercase block">Promedio Compra</span><span className="text-sm font-bold text-[#02c076]">{fmt(snapshot.averageBuyPrice, 2)} VES</span></div>
            <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]"><span className="text-[10px] text-[#848e9c] uppercase block">Promedio Venta</span><span className="text-sm font-bold text-[#FCD535]">{fmt(snapshot.averageSellPrice, 2)} VES</span></div>
            <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]"><span className="text-[10px] text-[#848e9c] uppercase block">Mediana Compra</span><span className="text-sm font-bold text-[#02c076]">{fmt(snapshot.medianBuyPrice, 2)} VES</span></div>
            <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]"><span className="text-[10px] text-[#848e9c] uppercase block">Liquidez ponderada</span><span className="text-sm font-bold text-[#e0e0e0]">{fmt(snapshot.weightedBuyPrice, 2)} VES</span></div>
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(activeSide === 'ALL' || activeSide === 'BUY') && <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-4 space-y-3"><div className="flex items-center justify-between pb-2 border-b border-[#2b2f36]"><div className="flex items-center gap-2"><ArrowDownRight className="w-4 h-4 text-[#02c076]" /><h3 className="font-bold text-[#e0e0e0] text-xs uppercase tracking-wider">Compra — Binance BUY</h3></div><span className="text-xs font-mono font-bold text-[#02c076]">Mejor: {snapshot.bestBuyPrice == null ? '—' : `${fmt(snapshot.bestBuyPrice, 2)} VES`}</span></div><div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{snapshot.topBuyAds.map((ad) => renderAdCard(ad, 'BUY'))}</div></div>}
          {(activeSide === 'ALL' || activeSide === 'SELL') && <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-4 space-y-3"><div className="flex items-center justify-between pb-2 border-b border-[#2b2f36]"><div className="flex items-center gap-2"><ArrowUpRight className="w-4 h-4 text-[#FCD535]" /><h3 className="font-bold text-[#e0e0e0] text-xs uppercase tracking-wider">Venta — Binance SELL</h3></div><span className="text-xs font-mono font-bold text-[#FCD535]">Mejor: {snapshot.bestSellPrice == null ? '—' : `${fmt(snapshot.bestSellPrice, 2)} VES`}</span></div><div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{snapshot.topSellAds.map((ad) => renderAdCard(ad, 'SELL'))}</div></div>}
        </div>
      </>}
    </div>
  );
};
