import React from 'react';
import { Building2, DollarSign, Filter, RotateCcw, Check, Sparkles, SlidersHorizontal } from 'lucide-react';
import { BankFilterKey, AmountFilterKey, GlobalFilterState } from '../types';

interface GlobalFilterBarProps {
  filter: GlobalFilterState;
  onFilterChange: (newFilter: GlobalFilterState) => void;
  onViewMatrixClick?: () => void;
}

export const BANK_OPTIONS: { key: BankFilterKey; name: string; shortName: string }[] = [
  { key: 'ALL', name: 'Todos los Bancos (General)', shortName: 'General' },
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

export const GlobalFilterBar: React.FC<GlobalFilterBarProps> = ({
  filter,
  onFilterChange,
  onViewMatrixClick,
}) => {
  const isFiltered = filter.bank !== 'ALL' || filter.amount !== 'ALL';

  const handleBankSelect = (bankKey: BankFilterKey) => {
    const bankObj = BANK_OPTIONS.find((b) => b.key === bankKey);
    onFilterChange({
      ...filter,
      bank: bankKey,
      bankDisplayName: bankObj?.name || 'Todos los Bancos',
    });
  };

  const handleAmountSelect = (amountKey: AmountFilterKey) => {
    const amountObj = AMOUNT_OPTIONS.find((a) => a.key === amountKey);
    onFilterChange({
      ...filter,
      amount: amountKey,
      amountVal: amountObj?.val ?? null,
    });
  };

  const handleReset = () => {
    onFilterChange({
      bank: 'ALL',
      bankDisplayName: 'Todos los Bancos',
      amount: 'ALL',
      amountVal: null,
    });
  };

  return (
    <div id="global-multifilter-bar" className="bg-[#111417] border-b border-[#2b2f36] px-4 lg:px-8 py-2.5 shadow-inner">
      <div className="max-w-7xl mx-auto flex flex-col xl:flex-row items-start xl:items-center justify-between gap-3">
        {/* Left Section: Active Filter Status Badge */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs font-bold font-mono uppercase tracking-wider text-[#848e9c]">
            <SlidersHorizontal className="w-3.5 h-3.5 text-[#FCD535]" />
            <span>Filtro Global:</span>
          </div>

          {isFiltered ? (
            <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-[#FCD535]/15 border border-[#FCD535]/50 text-xs font-mono">
              <span className="w-2 h-2 rounded-full bg-[#FCD535] animate-pulse" />
              <span className="text-[#FCD535] font-bold">
                Conectado a Matriz: {filter.bankDisplayName} {filter.amount !== 'ALL' ? `· ${filter.amount} VES` : ''}
              </span>
              <button
                onClick={handleReset}
                className="ml-1 text-[#848e9c] hover:text-[#e0e0e0] cursor-pointer flex items-center gap-0.5 text-[10px] uppercase font-bold tracking-wider"
                title="Restablecer a mercado general"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Restablecer</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#1e2329] border border-[#2b2f36] text-xs font-mono text-[#848e9c]">
              <span className="w-2 h-2 rounded-full bg-[#02c076]" />
              <span>Mercado General P2P (Todos los Bancos y Montos)</span>
            </div>
          )}
        </div>

        {/* Center/Right Section: Interactive Filter Controls */}
        <div className="flex flex-wrap items-center gap-2 w-full xl:w-auto">
          {/* Bank Selector Horizontal Scroll / Wrap */}
          <div className="flex items-center gap-1 overflow-x-auto max-w-full py-0.5 scrollbar-thin">
            <span className="text-[10px] uppercase text-[#848e9c] font-bold font-mono mr-1 shrink-0 flex items-center gap-1">
              <Building2 className="w-3 h-3 text-[#FCD535]" /> Banco:
            </span>
            {BANK_OPTIONS.map((b) => {
              const isSelected = filter.bank === b.key;
              return (
                <button
                  key={b.key}
                  id={`filter-bank-${b.key.toLowerCase()}`}
                  onClick={() => handleBankSelect(b.key)}
                  className={`px-2 py-1 rounded text-xs font-medium font-mono whitespace-nowrap transition cursor-pointer ${
                    isSelected
                      ? 'bg-[#FCD535] text-black font-bold shadow-sm'
                      : 'bg-[#181a20] text-[#848e9c] hover:text-[#e0e0e0] hover:bg-[#2b2f36] border border-[#2b2f36]'
                  }`}
                >
                  {b.shortName}
                </button>
              );
            })}
          </div>

          <div className="hidden sm:block w-px h-4 bg-[#2b2f36]" />

          {/* Amount Tier Selector */}
          <div className="flex items-center gap-1 overflow-x-auto max-w-full py-0.5">
            <span className="text-[10px] uppercase text-[#848e9c] font-bold font-mono mr-1 shrink-0 flex items-center gap-1">
              <DollarSign className="w-3 h-3 text-[#02c076]" /> Monto:
            </span>
            {AMOUNT_OPTIONS.map((a) => {
              const isSelected = filter.amount === a.key;
              return (
                <button
                  key={a.key}
                  id={`filter-amount-${a.key.toLowerCase()}`}
                  onClick={() => handleAmountSelect(a.key)}
                  className={`px-2 py-1 rounded text-xs font-medium font-mono whitespace-nowrap transition cursor-pointer ${
                    isSelected
                      ? 'bg-[#02c076] text-black font-bold shadow-sm'
                      : 'bg-[#181a20] text-[#848e9c] hover:text-[#e0e0e0] hover:bg-[#2b2f36] border border-[#2b2f36]'
                  }`}
                >
                  {a.key === 'ALL' ? 'Todos' : a.key}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
