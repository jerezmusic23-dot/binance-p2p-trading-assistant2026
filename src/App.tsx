/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Header from './Header';
import { Navigation, TabType } from './components/Navigation';
import { GlobalFilterBar, BANK_OPTIONS } from './components/GlobalFilterBar';
import { MainOverview } from './components/MainOverview';
import { DailyFluctuationChart } from './components/DailyFluctuationChart';
import { BankMatrix } from './components/BankMatrix';
import { OrderBookView } from './components/OrderBookView';
import { HistoryAndBacktest } from './components/HistoryAndBacktest';
import { AlertsManager } from './components/AlertsManager';
import { ApiService } from './services/api';
import {
  MarketSnapshot,
  MarketAnalysis,
  MarketProjections,
  GlobalFilterState,
  BankFilterKey,
  AmountFilterKey,
} from './types';

export default function App() {
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [globalFilter, setGlobalFilter] = useState<GlobalFilterState>({
    bank: 'ALL',
    bankDisplayName: 'Todos los Bancos',
    amount: 'ALL',
    amountVal: null,
  });

  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [analysis, setAnalysis] = useState<MarketAnalysis | null>(null);
  const [projections, setProjections] = useState<MarketProjections | null>(null);
  const [ageSeconds, setAgeSeconds] = useState<number>(0);
  const [effectiveStatus, setEffectiveStatus] = useState<'LIVE' | 'STALE' | 'OFFLINE'>('LIVE');
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Keep a ref to the latest filter to avoid stale closures in polling intervals
  const filterRef = useRef(globalFilter);
  filterRef.current = globalFilter;

  const fetchCentralData = useCallback(async (force = false, filterToUse?: GlobalFilterState) => {
    const currentFilter = filterToUse || filterRef.current;
    const bankParam = currentFilter.bank !== 'ALL' ? currentFilter.bank : undefined;
    const amountParam = currentFilter.amountVal ? currentFilter.amountVal : undefined;

    try {
      if (force) setIsRefreshing(true);

      const results = await Promise.allSettled([
        force
          ? ApiService.refreshMarket(bankParam, amountParam)
          : ApiService.getLatestMarket(bankParam, amountParam),
        ApiService.getMarketAnalysis(bankParam, amountParam),
        ApiService.getMarketProjections(bankParam, amountParam),
      ]);

      const [latestResResult, analysisResResult, projResResult] = results;

      if (latestResResult.status === 'fulfilled' && latestResResult.value.snapshot) {
        setSnapshot(latestResResult.value.snapshot);
        setAgeSeconds(latestResResult.value.ageSeconds || 0);
        setEffectiveStatus(latestResResult.value.effectiveStatus || 'LIVE');
        setErrorMessage(null);
      } else if (latestResResult.status === 'rejected') {
        console.warn('Market snapshot fetch failed:', latestResResult.reason);
      }

      if (analysisResResult.status === 'fulfilled' && analysisResResult.value.analysis) {
        setAnalysis(analysisResResult.value.analysis);
      }

      if (projResResult.status === 'fulfilled' && projResResult.value.projections) {
        setProjections(projResResult.value.projections);
      }
    } catch (err: any) {
      console.error('Error fetching market state:', err);
      // Keep existing snapshot if available instead of hard offline
      setEffectiveStatus((prev) => (snapshot ? 'STALE' : 'OFFLINE'));
      setErrorMessage(err?.message || 'Error comunicando con el servidor local');
    } finally {
      if (force) setIsRefreshing(false);
    }
  }, [snapshot]);

  const handleFilterChange = (newFilter: GlobalFilterState) => {
    setGlobalFilter(newFilter);
    fetchCentralData(false, newFilter);
  };

  const handleSelectMatrixCell = (bankKey: BankFilterKey, amountKey: AmountFilterKey) => {
    const amountVal =
      amountKey === '10K'
        ? 10000
        : amountKey === '20K'
        ? 20000
        : amountKey === '30K'
        ? 30000
        : amountKey === '40K'
        ? 40000
        : amountKey === '50K'
        ? 50000
        : amountKey === '100K'
        ? 100000
        : null;

    const bankOption = BANK_OPTIONS.find((b) => b.key === bankKey);
    const bankDisplayName = bankOption?.name || bankKey;

    const newFilter: GlobalFilterState = {
      bank: bankKey,
      bankDisplayName,
      amount: amountKey,
      amountVal,
    };

    setGlobalFilter(newFilter);
    fetchCentralData(false, newFilter);
  };

  useEffect(() => {
    // Initial fetch
    fetchCentralData();

    // Fast polling every 5 seconds for real-time filtered market updates
    const pollInterval = setInterval(() => {
      fetchCentralData();
    }, 5000);

    // Increment age counter locally every second for seamless live feedback
    const ageInterval = setInterval(() => {
      setAgeSeconds((prev) => prev + 1);
    }, 1000);

    return () => {
      clearInterval(pollInterval);
      clearInterval(ageInterval);
    };
  }, [fetchCentralData]);

  return (
    <div className="min-h-screen bg-[#0a0c0f] text-[#e0e0e0] flex flex-col font-sans selection:bg-[#FCD535]/30 selection:text-[#FCD535]">
      {/* Top Main App Header with filter indicators */}
      <Header
        snapshot={snapshot}
        globalFilter={globalFilter}
        ageSeconds={ageSeconds}
        status={effectiveStatus}
        isRefreshing={isRefreshing}
        onRefresh={() => fetchCentralData(true)}
      />

      {/* Main Tab Navigation */}
      <Navigation activeTab={activeTab} onSelectTab={setActiveTab} />

      {/* Global Multi-Filter Bar connected to the Bank Matrix */}
      <GlobalFilterBar
        filter={globalFilter}
        onFilterChange={handleFilterChange}
        onViewMatrixClick={() => setActiveTab('matrix')}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-6 py-4">
        {errorMessage && (
          <div className="mb-4 p-3 rounded bg-[#cf304a]/10 border border-[#cf304a]/30 text-[#cf304a] text-xs flex items-center justify-between font-mono">
            <span>{errorMessage}</span>
            <button
              onClick={() => fetchCentralData(true)}
              className="px-2 py-1 bg-[#cf304a]/20 hover:bg-[#cf304a]/30 rounded text-xs font-bold cursor-pointer"
            >
              Reintentar
            </button>
          </div>
        )}

        {/* Dynamic Views */}
        {activeTab === 'overview' && (
          <MainOverview
            snapshot={snapshot}
            analysis={analysis}
            projections={projections}
            ageSeconds={ageSeconds}
            onNavigateTab={(tab) => setActiveTab(tab)}
          />
        )}

        {activeTab === 'projections' && (
          <DailyFluctuationChart
            snapshot={snapshot}
            projections={projections}
            analysis={analysis}
          />
        )}

        {activeTab === 'matrix' && (
          <BankMatrix
            activeGlobalFilter={globalFilter}
            onSelectFilter={handleSelectMatrixCell}
            onNavigateTab={(tab) => setActiveTab(tab)}
          />
        )}

        {activeTab === 'orderbook' && <OrderBookView snapshot={snapshot} />}

        {activeTab === 'history' && <HistoryAndBacktest />}

        {activeTab === 'alerts' && <AlertsManager />}
      </main>

      {/* Institutional Footer */}
      <footer className="border-t border-[#2b2f36] bg-[#111417] py-3 px-4 text-center text-xs text-[#848e9c]">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] font-mono">
          <span>Binance P2P Trading Assistant · Conexión Directa Binance P2P API</span>
          <span>
            Mercado Activo: USDT/VES · Filtro:{' '}
            <strong className="text-[#FCD535]">
              {globalFilter.bankDisplayName} ({globalFilter.amount})
            </strong>
          </span>
        </div>
      </footer>
    </div>
  );
}

