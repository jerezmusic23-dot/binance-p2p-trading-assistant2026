/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Header } from './Header';
import { Navigation } from './Navigation';
import { MainOverview } from './MainOverview';
import { ProjectionsPanel } from './ProjectionsPanel';
import { MakerMatrix } from './MakerMatrix';
import { MarketAnalysisPanel } from './MarketAnalysisPanel';
import { OrderBookView } from './OrderBookView';
import { HistoryAndBacktest } from './HistoryAndBacktest';
import { AlertsManager } from './AlertsManager';
import { ApiService } from './api';
import type { MarketSnapshot, GlobalFilterState } from './types';

type TabType =
  | 'overview'
  | 'publish'
  | 'analysis'
  | 'projections'
  | 'orderbook'
  | 'history'
  | 'alerts';

export default function App() {
  const [activeTab, setActiveTab] = useState<TabType>('overview');

  // The application now stays on the general market view. Bank/amount
  // filtering belonged to the removed MultiFilter Matrix.
  const [globalFilter] = useState<GlobalFilterState>({
    bank: 'ALL',
    bankDisplayName: 'Todos los Bancos',
    amount: 'ALL',
    amountVal: null,
  });

  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [ageSeconds, setAgeSeconds] = useState<number>(0);
  const [effectiveStatus, setEffectiveStatus] = useState<'LIVE' | 'STALE' | 'OFFLINE'>('LIVE');
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const snapshotRef = useRef<MarketSnapshot | null>(snapshot);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const fetchCentralData = useCallback(async (force = false) => {
    if (force) setIsRefreshing(true);

    try {
      const result = force
        ? await ApiService.refreshMarket()
        : await ApiService.getLatestMarket();

      if (result?.snapshot) {
        setSnapshot(result.snapshot);
        setAgeSeconds(typeof result.ageSeconds === 'number' ? result.ageSeconds : 0);
        setEffectiveStatus(
          result.effectiveStatus === 'STALE'
            ? 'STALE'
            : result.effectiveStatus === 'OFFLINE'
              ? 'OFFLINE'
              : 'LIVE'
        );
        snapshotRef.current = result.snapshot;
        setErrorMessage(null);
      } else {
        setEffectiveStatus(snapshotRef.current ? 'STALE' : 'OFFLINE');
        setErrorMessage('No se pudieron actualizar los datos del mercado.');
      }
    } catch (error) {
      console.error('[Market] Snapshot request failed:', error);
      setEffectiveStatus(snapshotRef.current ? 'STALE' : 'OFFLINE');
      setErrorMessage(
        error instanceof Error ? error.message : 'Error comunicando con el servidor.'
      );
    } finally {
      if (force) setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchCentralData();

    const pollInterval = window.setInterval(() => {
      void fetchCentralData();
    }, 5000);

    const ageInterval = window.setInterval(() => {
      setAgeSeconds((previous) => previous + 1);
    }, 1000);

    return () => {
      window.clearInterval(pollInterval);
      window.clearInterval(ageInterval);
    };
  }, [fetchCentralData]);

  const handleNavigateTab = useCallback((tab: TabType) => {
    setActiveTab(tab);
  }, []);

  return (
    <div className="min-h-screen bg-[#0a0c0f] text-[#e0e0e0] flex flex-col font-sans selection:bg-[#FCD535]/30 selection:text-[#FCD535]">
      <Header
        snapshot={snapshot}
        globalFilter={globalFilter}
        ageSeconds={ageSeconds}
        status={effectiveStatus}
        isRefreshing={isRefreshing}
        onRefresh={() => void fetchCentralData(true)}
      />

      <Navigation
        activeTab={activeTab}
        onSelectTab={handleNavigateTab}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-6 py-4">
        {errorMessage && (
          <div className="mb-4 p-3 rounded bg-[#cf304a]/10 border border-[#cf304a]/30 text-[#cf304a] text-xs flex items-center justify-between gap-3 font-mono">
            <span>{errorMessage}</span>
            <button
              type="button"
              onClick={() => void fetchCentralData(true)}
              disabled={isRefreshing}
              className="px-3 py-1.5 bg-[#cf304a]/20 hover:bg-[#cf304a]/30 disabled:opacity-50 rounded text-xs font-bold cursor-pointer disabled:cursor-not-allowed"
            >
              {isRefreshing ? 'Actualizando...' : 'Reintentar'}
            </button>
          </div>
        )}

        {activeTab === 'overview' && (
          <MainOverview
            snapshot={snapshot}
            ageSeconds={ageSeconds}
            effectiveStatus={effectiveStatus}
            onNavigateTab={handleNavigateTab}
          />
        )}

        {activeTab === 'projections' && <ProjectionsPanel />}
        {activeTab === 'publish' && <MakerMatrix />}
        {activeTab === 'analysis' && <MarketAnalysisPanel />}

        {activeTab === 'orderbook' && <OrderBookView />}
        {activeTab === 'history' && <HistoryAndBacktest />}
        {activeTab === 'alerts' && <AlertsManager />}
      </main>

      <footer className="border-t border-[#2b2f36] bg-[#111417] py-3 px-4 text-center text-xs text-[#848e9c]">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] font-mono">
          <span>Binance P2P Trading Assistant · Conexión Directa Binance P2P API</span>
          <span>
            Mercado Activo: USDT/VES · <strong className="text-[#FCD535]">Mercado General</strong>
          </span>
        </div>
      </footer>
    </div>
  );
}
