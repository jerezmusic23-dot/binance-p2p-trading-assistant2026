/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
} from 'react';

import { Header } from './Header';
import { Navigation } from './Navigation';

import {
  GlobalFilterBar,
  BANK_OPTIONS,
} from './GlobalFilterBar';

import { MainOverview } from './MainOverview';
import { DailyFluctuationChart } from './DailyFluctuationChart';
import { BankMatrix } from './BankMatrix';
import { MakerMatrix } from './MakerMatrix';
import { MarketAnalysisPanel } from './MarketAnalysisPanel';
import { OrderBookView } from './OrderBookView';
import { HistoryAndBacktest } from './HistoryAndBacktest';
import { AlertsManager } from './AlertsManager';

import { ApiService } from './api';

import type {
  MarketSnapshot,
  MarketAnalysis,
  MarketProjections,
  GlobalFilterState,
  BankFilterKey,
  AmountFilterKey,
} from './types';

type TabType =
  | 'overview'
  | 'publish'
  | 'analysis'
  | 'projections'
  | 'matrix'
  | 'orderbook'
  | 'history'
  | 'alerts';

export default function App() {
  const [activeTab, setActiveTab] =
    useState<TabType>('overview');

  const [globalFilter, setGlobalFilter] =
    useState<GlobalFilterState>({
      bank: 'ALL',
      bankDisplayName: 'Todos los Bancos',
      amount: 'ALL',
      amountVal: null,
    });

  const [snapshot, setSnapshot] =
    useState<MarketSnapshot | null>(null);

  const [analysis, setAnalysis] =
    useState<MarketAnalysis | null>(null);

  const [projections, setProjections] =
    useState<MarketProjections | null>(null);

  const [ageSeconds, setAgeSeconds] =
    useState<number>(0);

  const [effectiveStatus, setEffectiveStatus] =
    useState<'LIVE' | 'STALE' | 'OFFLINE'>('LIVE');

  const [isRefreshing, setIsRefreshing] =
    useState<boolean>(false);

  const [errorMessage, setErrorMessage] =
    useState<string | null>(null);

  /*
   * C1 / decision C.4(ii): cuando el análisis o las proyecciones no se pueden
   * refrescar, conservamos el último valor válido pero anotamos CUÁNDO se
   * obtuvo, para poder marcarlo como STALE con su antigüedad real. Nunca debe
   * parecer un dato en tiempo real.
   */
  const [derivedUpdatedAt, setDerivedUpdatedAt] =
    useState<number | null>(null);

  const [derivedStale, setDerivedStale] =
    useState<boolean>(false);

  const [nowTick, setNowTick] =
    useState<number>(() => Date.now());

  /*
   * Refs para evitar closures obsoletas dentro
   * del polling automático.
   */
  const filterRef = useRef<GlobalFilterState>(globalFilter);
  const snapshotRef = useRef<MarketSnapshot | null>(snapshot);

  useEffect(() => {
    filterRef.current = globalFilter;
  }, [globalFilter]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  /*
   * Sólo mientras el dato derivado esté rancio hace falta un reloj: es lo que
   * permite mostrar su antigüedad real en lugar de un número congelado.
   */
  useEffect(() => {
    if (!derivedStale) return;

    setNowTick(Date.now());
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [derivedStale]);

  const derivedAgeSeconds =
    derivedStale && derivedUpdatedAt !== null
      ? Math.max(0, (nowTick - derivedUpdatedAt) / 1000)
      : 0;

  /*
   * Convierte el filtro actual en parámetros para la API.
   */
  const getApiParams = useCallback(
    (filter: GlobalFilterState) => {
      const bankParam =
        filter.bank !== 'ALL'
          ? filter.bank
          : undefined;

      const amountParam =
        filter.amountVal !== null &&
        filter.amountVal !== undefined
          ? filter.amountVal
          : undefined;

      return {
        bankParam,
        amountParam,
      };
    },
    []
  );

  /*
   * Carga toda la información del mercado.
   */
  const fetchCentralData = useCallback(
    async (
      force = false,
      filterToUse?: GlobalFilterState
    ) => {
      const currentFilter =
        filterToUse ?? filterRef.current;

      const { bankParam, amountParam } =
        getApiParams(currentFilter);

      if (force) {
        setIsRefreshing(true);
      }

      try {
        const results = await Promise.allSettled([
          force
            ? ApiService.refreshMarket(
                bankParam,
                amountParam
              )
            : ApiService.getLatestMarket(
                bankParam,
                amountParam
              ),

          ApiService.getMarketAnalysis(
            bankParam,
            amountParam
          ),

          ApiService.getMarketProjections(
            bankParam,
            amountParam
          ),
        ]);

        const [
          latestResult,
          analysisResult,
          projectionsResult,
        ] = results;

        let hasError = false;

        /*
         * MARKET SNAPSHOT
         */
        if (
          latestResult.status === 'fulfilled' &&
          latestResult.value?.snapshot
        ) {
          const data = latestResult.value;

          setSnapshot(data.snapshot);

          setAgeSeconds(
            typeof data.ageSeconds === 'number'
              ? data.ageSeconds
              : 0
          );

          setEffectiveStatus(
            data.effectiveStatus === 'STALE'
              ? 'STALE'
              : data.effectiveStatus === 'OFFLINE'
              ? 'OFFLINE'
              : 'LIVE'
          );

          snapshotRef.current = data.snapshot;
        } else if (
          latestResult.status === 'rejected'
        ) {
          hasError = true;

          console.warn(
            '[Market] Snapshot request failed:',
            latestResult.reason
          );

          /*
           * Si tenemos datos anteriores, mantenemos
           * la aplicación funcionando como STALE.
           */
          if (snapshotRef.current) {
            setEffectiveStatus('STALE');
          } else {
            setEffectiveStatus('OFFLINE');
          }
        }

        /*
         * MARKET ANALYSIS
         */
        let derivedOk = true;

        if (
          analysisResult.status === 'fulfilled' &&
          analysisResult.value?.analysis
        ) {
          setAnalysis(
            analysisResult.value.analysis
          );
        } else {
          /*
           * Rechazo o `analysis: null`. Conservamos el valor previo, pero
           * deja de ser un dato fresco.
           */
          derivedOk = false;

          if (analysisResult.status === 'rejected') {
            hasError = true;

            console.warn(
              '[Market] Analysis request failed:',
              analysisResult.reason
            );
          }
        }

        /*
         * MARKET PROJECTIONS
         */
        if (
          projectionsResult.status === 'fulfilled' &&
          projectionsResult.value?.projections
        ) {
          setProjections(
            projectionsResult.value.projections
          );
        } else {
          derivedOk = false;

          if (projectionsResult.status === 'rejected') {
            hasError = true;

            console.warn(
              '[Market] Projections request failed:',
              projectionsResult.reason
            );
          }
        }

        if (derivedOk) {
          setDerivedUpdatedAt(Date.now());
          setDerivedStale(false);
        } else {
          setDerivedStale(true);
        }

        /*
         * Mostramos error solamente si alguna
         * petición realmente falló.
         */
        if (hasError) {
          setErrorMessage(
            'No se pudieron actualizar todos los datos del mercado.'
          );
        } else {
          setErrorMessage(null);
        }
      } catch (error) {
        console.error(
          '[Market] Unexpected error:',
          error
        );

        if (snapshotRef.current) {
          setEffectiveStatus('STALE');
        } else {
          setEffectiveStatus('OFFLINE');
        }

        setDerivedStale(true);

        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Error comunicando con el servidor.'
        );
      } finally {
        if (force) {
          setIsRefreshing(false);
        }
      }
    },
    [getApiParams]
  );

  /*
   * Cambio del filtro global.
   */
  const handleFilterChange = useCallback(
    (newFilter: GlobalFilterState) => {
      setGlobalFilter(newFilter);

      filterRef.current = newFilter;

      void fetchCentralData(false, newFilter);
    },
    [fetchCentralData]
  );

  /*
   * Selección de una celda de la matriz.
   */
  const handleSelectMatrixCell = useCallback(
    (
      bankKey: BankFilterKey,
      amountKey: AmountFilterKey
    ) => {
      const amountMap: Record<
        AmountFilterKey,
        number | null
      > = {
        '10K': 10000,
        '20K': 20000,
        '30K': 30000,
        '40K': 40000,
        '50K': 50000,
        '100K': 100000,
        ALL: null,
      };

      const amountVal =
        amountMap[amountKey] ?? null;

      const bankOption =
        BANK_OPTIONS.find(
          (bank) => bank.key === bankKey
        );

      const bankDisplayName =
        bankOption?.name ?? bankKey;

      const newFilter: GlobalFilterState = {
        bank: bankKey,
        bankDisplayName,
        amount: amountKey,
        amountVal,
      };

      setGlobalFilter(newFilter);

      filterRef.current = newFilter;

      void fetchCentralData(
        false,
        newFilter
      );
    },
    [fetchCentralData]
  );

  /*
   * Carga inicial + polling.
   *
   * IMPORTANTE:
   * fetchCentralData ya no depende de snapshot,
   * por lo que este efecto NO se reinicia cada
   * vez que cambia el snapshot.
   */
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

  /*
   * Navegación segura entre tabs.
   */
  const handleNavigateTab = useCallback(
    (tab: TabType) => {
      setActiveTab(tab);
    },
    []
  );

  return (
    <div className="min-h-screen bg-[#0a0c0f] text-[#e0e0e0] flex flex-col font-sans selection:bg-[#FCD535]/30 selection:text-[#FCD535]">

      {/* HEADER */}
      <Header
        snapshot={snapshot}
        globalFilter={globalFilter}
        ageSeconds={ageSeconds}
        status={effectiveStatus}
        isRefreshing={isRefreshing}
        onRefresh={() =>
          void fetchCentralData(true)
        }
      />

      {/* NAVIGATION */}
      <Navigation
        activeTab={activeTab}
        onSelectTab={handleNavigateTab}
      />

      {/* GLOBAL FILTER */}
      <GlobalFilterBar
        filter={globalFilter}
        onFilterChange={handleFilterChange}
        onViewMatrixClick={() =>
          setActiveTab('matrix')
        }
      />

      {/* MAIN */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-6 py-4">

        {/* ERROR */}
        {errorMessage && (
          <div className="mb-4 p-3 rounded bg-[#cf304a]/10 border border-[#cf304a]/30 text-[#cf304a] text-xs flex items-center justify-between gap-3 font-mono">

            <span>
              {errorMessage}
            </span>

            <button
              type="button"
              onClick={() =>
                void fetchCentralData(true)
              }
              disabled={isRefreshing}
              className="px-3 py-1.5 bg-[#cf304a]/20 hover:bg-[#cf304a]/30 disabled:opacity-50 rounded text-xs font-bold cursor-pointer disabled:cursor-not-allowed"
            >
              {isRefreshing
                ? 'Actualizando...'
                : 'Reintentar'}
            </button>
          </div>
        )}

        {/* OVERVIEW */}
        {activeTab === 'overview' && (
          <MainOverview
            snapshot={snapshot}
            analysis={analysis}
            projections={projections}
            ageSeconds={ageSeconds}
            effectiveStatus={effectiveStatus}
            derivedStale={derivedStale}
            derivedAgeSeconds={derivedAgeSeconds}
            onNavigateTab={handleNavigateTab}
          />
        )}

        {/* PROJECTIONS */}
        {activeTab === 'projections' && (
          <DailyFluctuationChart
            snapshot={snapshot}
            projections={projections}
            analysis={analysis}
          />
        )}

        {/* WHAT PRICE MY OWN AD SHOULD CARRY */}
        {activeTab === 'publish' && <MakerMatrix />}

        {/* TREND, CEILINGS, FLOORS AND SIGNALS PER CELL */}
        {activeTab === 'analysis' && <MarketAnalysisPanel />}

        {/* MATRIX */}
        {activeTab === 'matrix' && (
          <BankMatrix
            activeGlobalFilter={globalFilter}
            onSelectFilter={handleSelectMatrixCell}
            onNavigateTab={handleNavigateTab}
          />
        )}

        {/* ORDER BOOK */}
        {activeTab === 'orderbook' && (
          <OrderBookView
            snapshot={snapshot}
          />
        )}

        {/* HISTORY */}
        {activeTab === 'history' && (
          <HistoryAndBacktest />
        )}

        {/* ALERTS */}
        {activeTab === 'alerts' && (
          <AlertsManager />
        )}

      </main>

      {/* FOOTER */}
      <footer className="border-t border-[#2b2f36] bg-[#111417] py-3 px-4 text-center text-xs text-[#848e9c]">

        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] font-mono">

          <span>
            Binance P2P Trading Assistant ·
            Conexión Directa Binance P2P API
          </span>

          <span>
            Mercado Activo: USDT/VES · Filtro:{' '}
            <strong className="text-[#FCD535]">
              {globalFilter.bankDisplayName} (
              {globalFilter.amount})
            </strong>
          </span>

        </div>

      </footer>
    </div>
  );
}
