/**
 * QUÉ PUBLICO AHORA MISMO.
 *
 * The one answer the operator opens the app for, at the top of the dashboard:
 * a bank, an amount, the two prices to type into Binance, and what the pair
 * leaves per USDT.
 *
 * This component computes NOTHING. It does not rank cells, does not derive a
 * price and does not calculate a margin - `best` was chosen server-side by the
 * same function that decides what Telegram announces, so the screen and the
 * phone can never disagree about what to publish.
 */

import React, { useEffect, useState } from 'react';
import { MakerMatrixCell } from './types';
import { ApiService } from './api';
import { ArrowDownToLine, ArrowUpFromLine, Info, RefreshCw, Tag } from 'lucide-react';

const signed = (v: number, decimals = 2) =>
  `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}`;

const PriceLeg: React.FC<{
  kind: 'MAKER_BUY' | 'MAKER_SELL';
  price: number;
  position: number;
  leaderPrice: number | null;
  beatsAdvNo: string;
  beatsPrice: number;
  queueAheadUsdt: number | null;
}> = ({ kind, price, position, leaderPrice, beatsAdvNo, beatsPrice, queueAheadUsdt }) => {
  const buying = kind === 'MAKER_BUY';
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
        <span className="text-[11px] font-bold uppercase tracking-wide text-[#e0e0e0]">
          {buying ? 'Publico: COMPRO USDT' : 'Publico: VENDO USDT'}
        </span>
      </div>

      <div className="font-mono text-2xl text-[#e0e0e0]">{price.toFixed(2)}</div>
      <div className="text-[10px] text-[#848e9c]">VES por USDT</div>

      <div className="mt-2 space-y-0.5 text-[10px] text-[#848e9c]">
        <div>
          {/* Contada sobre la escalera capturada, no estimada. */}
          Posición <span className="font-mono text-[#e0e0e0]">{position}</span>{' '}
          <span className="text-[#5e6673]">si el libro no se mueve</span>
        </div>
        <div>
          Líder actual{' '}
          <span className="font-mono">
            {leaderPrice === null ? 'no verificable' : leaderPrice.toFixed(2)}
          </span>
        </div>
        <div className="truncate">
          Supera a <span className="font-mono">{beatsAdvNo}</span> ({beatsPrice.toFixed(2)})
        </div>
        <div>
          {/* Unknown volume is never rendered as zero volume. */}
          Volumen por delante{' '}
          <span className="font-mono">
            {queueAheadUsdt === null ? 'no verificable' : `${queueAheadUsdt.toFixed(0)} USDT`}
          </span>
        </div>
      </div>
    </div>
  );
};

export const PublishPanel: React.FC<{ onOpenMatrix?: () => void }> = ({ onOpenMatrix }) => {
  const [best, setBest] = useState<MakerMatrixCell | null>(null);
  const [loaded, setLoaded] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBest = async (force = false) => {
    try {
      if (force) setIsRefreshing(true);
      const res = await ApiService.getMakerMatrix(force);
      setBest(res.best);
      setError(null);
    } catch (err: any) {
      console.error('Failed to load maker recommendation:', err);
      setError(err.message || 'Error al obtener el precio recomendado');
    } finally {
      setLoaded(true);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    fetchBest(false);
    const timer = setInterval(() => fetchBest(false), 45_000);
    return () => clearInterval(timer);
  }, []);

  const header = (
    <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
      <h2 className="text-sm font-bold text-[#e0e0e0] uppercase tracking-wide flex items-center gap-2">
        <Tag className="w-4 h-4 text-[#FCD535]" />
        Qué publico ahora
      </h2>
      <button
        type="button"
        onClick={() => fetchBest(true)}
        disabled={isRefreshing}
        className="flex items-center gap-1 px-2 py-1 rounded border border-[#2b2f36] text-[10px] text-[#848e9c] hover:border-[#FCD535] transition-colors"
      >
        <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
        Refrescar
      </button>
    </div>
  );

  if (error !== null) {
    return (
      <div className="rounded-lg border border-[#f6465d]/30 bg-[#181a20] p-4">
        {header}
        <p className="text-[11px] text-[#f6465d]">{error}</p>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-4">
        {header}
        <p className="text-[11px] text-[#848e9c]">Calculando precios…</p>
      </div>
    );
  }

  const pair = best?.recommendation?.recommended ?? null;

  /*
   * No recommendation is a real answer and is shown as one. An empty panel, or
   * a zero, would read as "the robot is broken" when what it means is "the
   * book does not support a profitable pair right now".
   */
  if (best === null || pair === null) {
    return (
      <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-4">
        {header}
        <p className="text-[11px] text-[#848e9c]">
          Ningún banco y monto deja margen bruto positivo con los anuncios capturados. No hay un
          precio que recomendar.
        </p>
        {onOpenMatrix !== undefined && (
          <button
            type="button"
            onClick={onOpenMatrix}
            className="mt-2 text-[10px] text-[#FCD535] hover:underline"
          >
            Ver todas las celdas y sus anuncios →
          </button>
        )}
      </div>
    );
  }

  const rec = best.recommendation;

  return (
    <div className="rounded-lg border border-[#2b2f36] bg-[#181a20] p-4">
      {header}

      <div className="flex items-baseline gap-2 flex-wrap mb-3">
        <span className="text-[11px] font-bold text-[#e0e0e0]">{best.bankDisplayName}</span>
        <span className="text-[11px] text-[#848e9c]">
          {best.amountVes.toLocaleString('es-VE')} VES
        </span>
        <span className="text-[10px] text-[#848e9c]">
          · capturado hace <span className="font-mono">{best.ageSeconds}s</span>
        </span>
      </div>

      <div className="flex flex-col md:flex-row gap-3">
        <PriceLeg
          kind="MAKER_BUY"
          price={pair.buy.price}
          position={pair.buy.position}
          leaderPrice={rec?.buyAnalysis.leaderPrice ?? null}
          beatsAdvNo={pair.buy.beatsAdvNo}
          beatsPrice={pair.buy.beatsPrice}
          queueAheadUsdt={pair.buy.queueAheadUsdt}
        />
        <PriceLeg
          kind="MAKER_SELL"
          price={pair.sell.price}
          position={pair.sell.position}
          leaderPrice={rec?.sellAnalysis.leaderPrice ?? null}
          beatsAdvNo={pair.sell.beatsAdvNo}
          beatsPrice={pair.sell.beatsPrice}
          queueAheadUsdt={pair.sell.queueAheadUsdt}
        />
      </div>

      <div className="mt-3 flex items-baseline gap-3 flex-wrap font-mono text-[13px] text-[#02c076]">
        <span>MARGEN BRUTO {signed(pair.grossMarginVes)} VES por USDT</span>
        {pair.grossMarginPct !== null && <span>{signed(pair.grossMarginPct, 4)}%</span>}
      </div>

      {/* Being #1 is reported even when the engine advises against it. */}
      {pair.position !== 1 && rec !== null && rec.firstPositionPairing !== null && (
        <div className="mt-2 text-[10px] text-[#848e9c] font-mono border border-dashed border-[#2b2f36] rounded px-2 py-1">
          Ser #1: compro{' '}
          {rec.priceToBeFirstBuy === null ? 'no verificable' : rec.priceToBeFirstBuy.toFixed(2)} ·
          vendo{' '}
          {rec.priceToBeFirstSell === null ? 'no verificable' : rec.priceToBeFirstSell.toFixed(2)}{' '}
          · margen {signed(rec.firstPositionPairing.grossMarginVes)} VES
        </div>
      )}

      <div className="mt-2 flex items-start gap-1.5 text-[9px] text-[#5e6673] leading-tight">
        <Info className="w-3 h-3 mt-0.5 shrink-0" />
        <span>
          MARGEN BRUTO: no descuenta comisión de Binance, transferencia bancaria, slippage,
          redondeos ni otros costes operativos. No es beneficio neto. La posición es una
          ESTIMACIÓN: Binance ordena también por factores que esta captura no expone.
        </span>
      </div>

      {onOpenMatrix !== undefined && (
        <button
          type="button"
          onClick={onOpenMatrix}
          className="mt-2 text-[10px] text-[#FCD535] hover:underline"
        >
          Ver todas las celdas y sus anuncios →
        </button>
      )}
    </div>
  );
};
