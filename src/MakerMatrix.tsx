/**
 * MIS PRECIOS PARA PUBLICAR — BANCO x MONTO
 *
 * The screen for a MAKER. Every cell answers one question: if I publish an ad
 * at this bank for this amount, what price should it carry?
 *
 * This component performs NO economic calculation. It does not derive a price,
 * does not pick a position, does not compute a margin and does not compare
 * banks. All of that happened server-side in makerRecommendation over a
 * captured book; this renders the decision, names every absence in words, and
 * shows the real ads each recommendation came from so the operator can check
 * it against Binance themselves.
 *
 * WHY IT SITS BESIDE THE EXECUTABLE MATRIX RATHER THAN REPLACING IT
 *
 * That screen answers the taker's question - could I take an ad here. This one
 * answers the operator's. Both read the same capture, and keeping them apart
 * is what stops one vocabulary from leaking into the other.
 */

import React, { useEffect, useState } from 'react';
import {
  MakerCellStatus,
  MakerMatrix as MakerMatrixData,
  MakerMatrixCell,
  MakerSideAnalysis,
} from './types';
import { ApiService } from './api';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Clock,
  HelpCircle,
  RefreshCw,
  Tag,
  TrendingUp,
  XCircle,
} from 'lucide-react';

/**
 * How each status reads on screen.
 *
 * Only the two publishable states get a price-forward treatment. Every other
 * state carries its own label and colour - none is rendered as 0, as "--"
 * standing in for a price, or hidden. A cell with no recommendation is
 * information, not an empty box.
 */
const STATUS_STYLE: Record<
  MakerCellStatus,
  { label: string; className: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  PUBLISH_AT_TOP: {
    label: 'PUBLICAR #1',
    className: 'text-[#02c076] border-[#02c076]/40 bg-[#02c076]/10',
    Icon: TrendingUp,
  },
  PUBLISH_DEEPER: {
    label: 'PUBLICAR MÁS ABAJO',
    className: 'text-[#f0b90b] border-[#f0b90b]/40 bg-[#f0b90b]/10',
    Icon: ArrowDownRight,
  },
  NO_MARGIN: {
    label: 'SIN MARGEN',
    className: 'text-[#848e9c] border-[#2b2f36] bg-[#181a20]',
    Icon: XCircle,
  },
  NO_DATA: {
    label: 'SIN DATOS',
    className: 'text-[#848e9c] border-[#2b2f36] bg-[#181a20]',
    Icon: HelpCircle,
  },
  FETCH_FAILED: {
    label: 'SIN RESPUESTA',
    className: 'text-[#f6465d] border-[#f6465d]/40 bg-[#f6465d]/10',
    Icon: AlertTriangle,
  },
  STALE: {
    label: 'DATO ANTIGUO',
    className: 'text-[#f0b90b] border-[#f0b90b]/40 bg-[#f0b90b]/10',
    Icon: Clock,
  },
};

/** An absent number is always words, never a zero and never a dash. */
const price = (value: number | null): string =>
  value === null ? 'no verificable' : value.toFixed(2);

const signed = (value: number, decimals = 2): string =>
  `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}`;

const MatrixCell: React.FC<{
  cell: MakerMatrixCell;
  selected: boolean;
  onSelect: () => void;
}> = ({ cell, selected, onSelect }) => {
  const style = STATUS_STYLE[cell.status];
  const pair = cell.recommendation?.recommended ?? null;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded border px-2 py-1.5 transition-colors ${style.className} ${
        selected ? 'ring-1 ring-[#FCD535]' : ''
      }`}
    >
      <div className="flex items-center gap-1 text-[9px] uppercase font-semibold tracking-wide">
        <style.Icon className="w-3 h-3" />
        {style.label}
      </div>

      {pair !== null ? (
        <div className="mt-1 space-y-0.5 font-mono text-[11px] text-[#e0e0e0]">
          <div className="flex justify-between gap-2">
            <span className="text-[#848e9c]">compro</span>
            <span>{pair.buy.price.toFixed(2)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-[#848e9c]">vendo</span>
            <span>{pair.sell.price.toFixed(2)}</span>
          </div>
          <div className="flex justify-between gap-2 border-t border-current/20 pt-0.5">
            <span className="text-[#848e9c]">margen</span>
            <span>{signed(pair.grossMarginVes)}</span>
          </div>
        </div>
      ) : (
        <div className="mt-1 text-[9px] leading-tight text-[#848e9c]">
          {cell.reason ?? 'Sin recomendación para esta celda.'}
        </div>
      )}
    </button>
  );
};

/** The real ads a recommendation was derived from. Provenance, not decoration. */
const SideDetail: React.FC<{ analysis: MakerSideAnalysis; publishedAt: number | null }> = ({
  analysis,
  publishedAt,
}) => {
  const isBuy = analysis.side === 'MAKER_BUY';

  return (
    <div className="border border-[#2b2f36] rounded p-2 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-bold text-[#e0e0e0]">
        {isBuy ? (
          <ArrowUpRight className="w-3.5 h-3.5 text-[#02c076]" />
        ) : (
          <ArrowDownRight className="w-3.5 h-3.5 text-[#f6465d]" />
        )}
        {analysis.definition.label}
      </div>

      <p className="text-[9px] text-[#848e9c] leading-tight">
        Publico un anuncio que <strong>{analysis.definition.myAction}</strong>. Lo ve{' '}
        {analysis.definition.seenBy}, así que compito contra{' '}
        {analysis.definition.competitorsAre} en el listado{' '}
        <span className="font-mono">tradeType={analysis.definition.listingTradeType}</span>. Gana
        el precio {analysis.definition.leaderIs === 'HIGHEST' ? 'más alto' : 'más bajo'}.
      </p>

      <div className="grid grid-cols-3 gap-1 text-[10px] font-mono">
        <div>
          <div className="text-[#848e9c] text-[9px]">Líder</div>
          {price(analysis.leaderPrice)}
        </div>
        <div>
          <div className="text-[#848e9c] text-[9px]">2.º</div>
          {price(analysis.secondPrice)}
        </div>
        <div>
          <div className="text-[#848e9c] text-[9px]">3.º</div>
          {price(analysis.thirdPrice)}
        </div>
      </div>

      <div className="text-[10px] font-mono text-[#FCD535]">
        Para ser #1: {price(analysis.priceToBeFirst)}
        {analysis.tickProvenance === 'NOT_VERIFIABLE' && (
          <span className="text-[#f0b90b] text-[9px]"> · paso de precio no establecido</span>
        )}
      </div>

      {publishedAt !== null && (
        <div className="text-[10px] font-mono text-[#e0e0e0]">
          {/*
            CONTADA, no estimada - y con la condición dicha.

            Es cuántos anuncios de la escalera baten este precio, más uno. Lo
            que la hace condicional no es el cálculo sino el libro: son los 20
            anuncios que Binance devolvió, y nadie más se mueve mientras tanto.
          */}
          Publicando a {publishedAt.toFixed(2)}: posición{' '}
          {analysis.ladder.filter((e) =>
            analysis.definition.leaderIs === 'HIGHEST'
              ? e.price > publishedAt
              : e.price < publishedAt
          ).length + 1}
          <span className="text-[#5e6673]"> si el libro no se mueve</span>
        </div>
      )}

      <div className="text-[9px] text-[#848e9c]">
        {analysis.competitors} de {analysis.adsExamined} anuncios compiten aquí.
      </div>

      {analysis.ladder.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[9px] font-mono">
            <thead>
              <tr className="text-[#5e6673]">
                <th className="text-left font-normal">#</th>
                <th className="text-right font-normal">precio</th>
                <th className="text-right font-normal">dif.</th>
                <th className="text-right font-normal">USDT</th>
                <th className="text-left font-normal pl-2">anuncio</th>
              </tr>
            </thead>
            <tbody className="text-[#848e9c]">
              {analysis.ladder.map((entry) => (
                <tr key={entry.advNo}>
                  <td>{entry.position}</td>
                  <td className="text-right text-[#e0e0e0]">{entry.price.toFixed(2)}</td>
                  <td className="text-right">{entry.deltaFromLeader.toFixed(2)}</td>
                  <td className="text-right">
                    {/* Unknown volume is never printed as zero. */}
                    {entry.availableUsdt === null ? 'n/v' : entry.availableUsdt.toFixed(0)}
                  </td>
                  <td className="pl-2 truncate max-w-[120px]">
                    {entry.advNo} · {entry.merchant}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {analysis.reason !== null && (
        <div className="text-[9px] text-[#f0b90b] leading-tight">{analysis.reason}</div>
      )}
    </div>
  );
};

const CellDetail: React.FC<{ cell: MakerMatrixCell }> = ({ cell }) => {
  const rec = cell.recommendation;
  if (rec === null) {
    return (
      <div className="border border-[#2b2f36] rounded p-3 text-[11px] text-[#848e9c]">
        {cell.reason ?? 'Sin datos capturados para esta celda.'}
      </div>
    );
  }

  const pair = rec.recommended;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h3 className="text-xs font-bold text-[#e0e0e0] uppercase tracking-wide">
          {cell.bankDisplayName} · {cell.amountVes.toLocaleString('es-VE')} VES
        </h3>
        <span className="text-[10px] text-[#848e9c]">
          Capturado hace <span className="font-mono">{cell.ageSeconds}s</span>
        </span>
      </div>

      {pair !== null ? (
        <div className="border border-[#FCD535]/40 bg-[#FCD535]/5 rounded p-2 space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-[#FCD535] font-bold">
            Precio conveniente · posición {pair.position}
          </div>
          <div className="grid grid-cols-2 gap-2 font-mono text-[13px] text-[#e0e0e0]">
            <div>
              <div className="text-[9px] text-[#848e9c] font-sans uppercase">Mi compra</div>
              {pair.buy.price.toFixed(2)} VES
            </div>
            <div>
              <div className="text-[9px] text-[#848e9c] font-sans uppercase">Mi venta</div>
              {pair.sell.price.toFixed(2)} VES
            </div>
          </div>
          <div className="text-[11px] font-mono text-[#02c076]">
            MARGEN BRUTO {signed(pair.grossMarginVes)} VES por USDT
            {pair.grossMarginPct !== null && ` · ${signed(pair.grossMarginPct, 4)}%`}
          </div>
          <div className="text-[9px] text-[#848e9c] leading-tight">
            Supera a {pair.buy.beatsAdvNo} ({pair.buy.beatsPrice.toFixed(2)}) comprando y a{' '}
            {pair.sell.beatsAdvNo} ({pair.sell.beatsPrice.toFixed(2)}) vendiendo. Volumen por
            delante:{' '}
            {pair.buy.queueAheadUsdt === null
              ? 'no verificable'
              : `${pair.buy.queueAheadUsdt.toFixed(0)} USDT`}{' '}
            comprando ·{' '}
            {pair.sell.queueAheadUsdt === null
              ? 'no verificable'
              : `${pair.sell.queueAheadUsdt.toFixed(0)} USDT`}{' '}
            vendiendo.
          </div>
        </div>
      ) : (
        <div className="border border-[#2b2f36] rounded p-2 text-[11px] text-[#848e9c]">
          {rec.reason ?? 'No hay un par de precios con margen positivo en esta celda.'}
        </div>
      )}

      {/*
        Being first is shown whatever the engine recommended. The operator
        asked never to lose sight of it, including when it is the wrong move.
      */}
      {pair !== null && pair.position !== 1 && rec.firstPositionPairing !== null && (
        <div className="text-[10px] text-[#848e9c] border border-dashed border-[#2b2f36] rounded px-2 py-1 font-mono">
          Ser #1: compro {price(rec.priceToBeFirstBuy)} · vendo {price(rec.priceToBeFirstSell)} ·
          margen {signed(rec.firstPositionPairing.grossMarginVes)} VES
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        <SideDetail analysis={rec.buyAnalysis} publishedAt={pair?.buy.price ?? null} />
        <SideDetail analysis={rec.sellAnalysis} publishedAt={pair?.sell.price ?? null} />
      </div>

      {rec.alternatives.length > 1 && (
        <details className="text-[10px] text-[#848e9c]">
          <summary className="cursor-pointer">
            Otras posiciones ({rec.alternatives.length}) — más margen, más cola por delante
          </summary>
          <table className="w-full mt-1 font-mono text-[9px]">
            <thead>
              <tr className="text-[#5e6673]">
                <th className="text-left font-normal">pos</th>
                <th className="text-right font-normal">compro</th>
                <th className="text-right font-normal">vendo</th>
                <th className="text-right font-normal">margen</th>
                <th className="text-right font-normal">cola compra</th>
              </tr>
            </thead>
            <tbody>
              {rec.alternatives.map((alt) => (
                <tr
                  key={alt.position}
                  className={alt.position === pair?.position ? 'text-[#FCD535]' : ''}
                >
                  <td>{alt.position}</td>
                  <td className="text-right">{alt.buy.price.toFixed(2)}</td>
                  <td className="text-right">{alt.sell.price.toFixed(2)}</td>
                  <td className="text-right">{signed(alt.grossMarginVes)}</td>
                  <td className="text-right">
                    {alt.buy.queueAheadUsdt === null
                      ? 'n/v'
                      : alt.buy.queueAheadUsdt.toFixed(0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
};

export const MakerMatrix: React.FC = () => {
  const [matrix, setMatrix] = useState<MakerMatrixData | null>(null);
  const [selected, setSelected] = useState<{ bank: string; amount: string } | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMatrix = async (force = false) => {
    try {
      if (force) setIsRefreshing(true);
      else setIsLoading(true);
      const res = await ApiService.getMakerMatrix(force);
      setMatrix(res.makerMatrix);
      setError(null);
    } catch (err: any) {
      console.error('Failed to load maker matrix:', err);
      setError(err.message || 'Error al obtener la matriz de precios a publicar');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    fetchMatrix(false);
  }, []);

  if (isLoading) {
    return <div className="p-6 text-center text-[#848e9c] text-sm">Cargando precios…</div>;
  }

  if (error !== null) {
    return (
      <div className="p-6 text-center text-[#f6465d] text-sm border border-[#f6465d]/30 rounded-lg">
        {error}
      </div>
    );
  }

  if (matrix === null) {
    return (
      <div className="p-6 text-center text-[#848e9c] text-sm">
        No hay matriz de precios disponible.
      </div>
    );
  }

  const publishable = Object.values(matrix.cells)
    .flatMap((row) => Object.values(row))
    .filter((c) => c.status === 'PUBLISH_AT_TOP' || c.status === 'PUBLISH_DEEPER').length;

  const selectedCell =
    selected === null ? null : matrix.cells[selected.bank]?.[selected.amount] ?? null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-[#e0e0e0] uppercase tracking-wide flex items-center gap-2">
            <Tag className="w-4 h-4 text-[#FCD535]" />
            Mis precios para publicar
          </h2>
          <p className="text-[10px] text-[#848e9c] mt-0.5">
            A qué precio debe salir MI anuncio en cada banco y monto para ser competitivo. Cada
            precio se deriva de los anuncios reales contra los que compito.
          </p>
        </div>

        <div className="flex items-center gap-3 text-[10px] text-[#848e9c]">
          <span>
            Capturado hace <strong className="font-mono">{matrix.ageSeconds}s</strong>
            {matrix.stale && <span className="text-[#f0b90b] font-semibold"> · DATO ANTIGUO</span>}
          </span>
          <span>
            <strong className="font-mono text-[#02c076]">{publishable}</strong> con precio
          </span>
          <button
            type="button"
            onClick={() => fetchMatrix(true)}
            disabled={isRefreshing}
            className="flex items-center gap-1 px-2 py-1 rounded border border-[#2b2f36] hover:border-[#FCD535] transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refrescar
          </button>
        </div>
      </div>

      {/*
        The configuration is shown because it changes what the numbers mean. An
        empty exclusion list means my own ads, if any, are being counted as
        competition - the operator has to be able to see that at a glance.
      */}
      <div className="text-[10px] text-[#5e6673] border border-dashed border-[#2b2f36] rounded px-2 py-1">
        Compitiendo contra{' '}
        {matrix.config.publisherFilter === 'ALL'
          ? 'todos los anunciantes'
          : matrix.config.publisherFilter === 'MERCHANT_ONLY'
          ? 'sólo comerciantes verificados'
          : 'sólo anunciantes no comerciantes'}
        , profundidad {matrix.config.ladderDepth}.{' '}
        {matrix.config.excludeMerchants.length === 0
          ? 'Ningún anunciante excluido: si publicas con un nickname propio, todavía cuenta como competencia.'
          : `Excluidos: ${matrix.config.excludeMerchants.join(', ')}.`}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1">
          <thead>
            <tr>
              <th className="text-left text-[10px] uppercase text-[#848e9c] font-semibold px-2">
                Banco
              </th>
              {matrix.amountKeys.map((amt) => (
                <th
                  key={amt}
                  className="text-center text-[10px] uppercase text-[#848e9c] font-semibold min-w-[110px]"
                >
                  {amt}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.bankOrder.map((bank) => (
              <tr key={bank}>
                <td className="text-[11px] font-semibold text-[#e0e0e0] px-2 whitespace-nowrap">
                  {matrix.bankDisplayNames[bank] ?? bank}
                </td>
                {matrix.amountKeys.map((amt) => {
                  const cell = matrix.cells[bank]?.[amt];
                  if (cell === undefined) {
                    return (
                      <td key={amt} className="text-center text-[9px] text-[#5e6673]">
                        sin celda
                      </td>
                    );
                  }
                  return (
                    <td key={amt} className="align-top">
                      <MatrixCell
                        cell={cell}
                        selected={selected?.bank === bank && selected?.amount === amt}
                        onSelect={() => setSelected({ bank, amount: amt })}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedCell !== null ? (
        <CellDetail cell={selectedCell} />
      ) : (
        <div className="text-[10px] text-[#848e9c] text-center py-2">
          Selecciona una celda para ver los anuncios de los que sale cada precio.
        </div>
      )}

      <p className="text-[9px] text-[#5e6673] leading-tight">
        MARGEN BRUTO: no descuenta comisión de Binance, transferencia bancaria, slippage,
        redondeos ni otros costes operativos. No es beneficio neto. La posición es una
        ESTIMACIÓN: Binance ordena también por factores que esta captura no expone.
      </p>
    </div>
  );
};
