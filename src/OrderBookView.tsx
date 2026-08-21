import React, { useState } from 'react';
import { MarketSnapshot, NormalizedAd } from './types';
import { BookOpen, ArrowUpRight, ArrowDownRight } from 'lucide-react';

interface OrderBookViewProps {
  snapshot: MarketSnapshot | null;
}

export const OrderBookView: React.FC<OrderBookViewProps> = ({ snapshot }) => {
  const [activeSide, setActiveSide] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');

  if (!snapshot) {
    return (
      <div className="p-8 text-center bg-[#181a20] rounded-lg border border-[#2b2f36]">
        <p className="text-[#848e9c]">Cargando libro de anuncios Binance P2P...</p>
      </div>
    );
  }

  const renderAdCard = (ad: NormalizedAd, type: 'BUY' | 'SELL') => {
    const isBuy = type === 'BUY';
    return (
      <div
        key={ad.advNo}
        className="bg-[#111417] border border-[#2b2f36] rounded p-3.5 hover:border-[#474d57] transition space-y-2.5"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-bold text-[#e0e0e0] text-xs truncate max-w-[130px]">
              {ad.merchantName}
            </span>
            {ad.userType === 'merchant' && (
              <span className="px-1.5 py-0.2 rounded bg-[#FCD535]/15 text-[#FCD535] text-[10px] font-bold border border-[#FCD535]/30">
                PRO
              </span>
            )}
          </div>
          <div className="text-[11px] text-[#848e9c] font-mono">
            {ad.ordersCount} órd. · <span className="text-[#02c076]">{ad.finishRate * 100}%</span>
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
            <span className="text-[#e0e0e0]">
              {ad.minAmountVes.toLocaleString()} - {ad.maxAmountVes.toLocaleString()} VES
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-1 pt-1">
          {ad.paymentMethods.map((pm, idx) => (
            <span
              key={idx}
              className="px-1.5 py-0.5 rounded bg-[#181a20] text-[#848e9c] text-[10px] border border-[#2b2f36]"
            >
              {pm}
            </span>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div id="orderbook-view-container" className="space-y-4">
      {/* Aggregated vs Real Banner */}
      <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-5">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-[#2b2f36] pb-4">
          <div>
            <h2 className="text-xs uppercase text-[#848e9c] font-bold tracking-wider flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-[#FCD535]" />
              LIBRO DE ANUNCIOS REALES & MÉTRICAS AGREGADAS
            </h2>
            <p className="text-[11px] text-[#848e9c] mt-0.5">
              Transparencia total: precios de anuncios individuales vs precios agregados calculados.
            </p>
          </div>

          <div className="flex items-center gap-1 bg-[#111417] p-1 rounded border border-[#2b2f36] text-xs">
            <button
              onClick={() => setActiveSide('ALL')}
              className={`px-3 py-1 rounded text-xs font-mono transition cursor-pointer ${
                activeSide === 'ALL' ? 'bg-[#1e2329] text-[#e0e0e0] border border-[#474d57]' : 'text-[#848e9c] hover:text-[#e0e0e0]'
              }`}
            >
              Ambos Lados
            </button>
            <button
              onClick={() => setActiveSide('BUY')}
              className={`px-3 py-1 rounded text-xs font-mono font-bold transition cursor-pointer ${
                activeSide === 'BUY' ? 'bg-[#1e2329] text-[#02c076] border border-[#02c076]' : 'text-[#848e9c] hover:text-[#e0e0e0]'
              }`}
            >
              Recompra (BUY)
            </button>
            <button
              onClick={() => setActiveSide('SELL')}
              className={`px-3 py-1 rounded text-xs font-mono font-bold transition cursor-pointer ${
                activeSide === 'SELL' ? 'bg-[#1e2329] text-[#FCD535] border border-[#FCD535]' : 'text-[#848e9c] hover:text-[#e0e0e0]'
              }`}
            >
              Venta (SELL)
            </button>
          </div>
        </div>

        {/* Aggregated Rates Table */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-4 text-xs font-mono">
          <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]">
            <span className="text-[10px] text-[#848e9c] uppercase block">Promedio Compra</span>
            <span className="text-sm font-bold text-[#02c076]">{snapshot.averageBuyPrice.toFixed(2)} VES</span>
            <span className="text-[9px] text-[#848e9c] block mt-0.5">Tasa agregada</span>
          </div>

          <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]">
            <span className="text-[10px] text-[#848e9c] uppercase block">Promedio Venta</span>
            <span className="text-sm font-bold text-[#FCD535]">{snapshot.averageSellPrice.toFixed(2)} VES</span>
            <span className="text-[9px] text-[#848e9c] block mt-0.5">Tasa agregada</span>
          </div>

          <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]">
            <span className="text-[10px] text-[#848e9c] uppercase block">Mediana Compra</span>
            <span className="text-sm font-bold text-[#02c076]">{snapshot.medianBuyPrice.toFixed(2)} VES</span>
            <span className="text-[9px] text-[#848e9c] block mt-0.5">Tasa agregada</span>
          </div>

          <div className="bg-[#111417] p-3 rounded border border-[#2b2f36]">
            <span className="text-[10px] text-[#848e9c] uppercase block">Ponderado Liquidez</span>
            <span className="text-sm font-bold text-[#e0e0e0]">{snapshot.weightedBuyPrice.toFixed(2)} VES</span>
            <span className="text-[9px] text-[#848e9c] block mt-0.5">Volumen USDT</span>
          </div>
        </div>
      </div>

      {/* Two Columns: BUY side and SELL side Ads */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* BUY Side */}
        {(activeSide === 'ALL' || activeSide === 'BUY') && (
          <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-[#2b2f36]">
              <div className="flex items-center gap-2">
                <ArrowDownRight className="w-4 h-4 text-[#02c076]" />
                <h3 className="font-bold text-[#e0e0e0] text-xs uppercase tracking-wider">Anuncios de Recompra (Tú pagas VES)</h3>
              </div>
              <span className="text-xs font-mono font-bold text-[#02c076]">
                Mejor: {snapshot.bestBuyPrice.toFixed(2)} VES
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {snapshot.topBuyAds.map((ad) => renderAdCard(ad, 'BUY'))}
            </div>
          </div>
        )}

        {/* SELL Side */}
        {(activeSide === 'ALL' || activeSide === 'SELL') && (
          <div className="bg-[#181a20] border border-[#2b2f36] rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-[#2b2f36]">
              <div className="flex items-center gap-2">
                <ArrowUpRight className="w-4 h-4 text-[#FCD535]" />
                <h3 className="font-bold text-[#e0e0e0] text-xs uppercase tracking-wider">Anuncios de Venta (Tú recibes VES)</h3>
              </div>
              <span className="text-xs font-mono font-bold text-[#FCD535]">
                Mejor: {snapshot.bestSellPrice.toFixed(2)} VES
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {snapshot.topSellAds.map((ad) => renderAdCard(ad, 'SELL'))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

