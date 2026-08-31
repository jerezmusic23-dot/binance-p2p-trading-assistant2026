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
import { ProjectionsPanel } from './ProjectionsPanel';
import { BankMatrix } from './BankMatrix';
import { MakerMatrix } from './MakerMatrix';
import { MarketAnalysisPanel } from './MarketAnalysisPanel';
import { OrderBookView } from './OrderBookView';
import { HistoryAndBacktest } from './HistoryAndBacktest';
import { AlertsManager } from './AlertsManager';

import { ApiService } from './api';

import type {
  MarketSnapshot,
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

  const [ageSeconds, setAgeSeconds] =
    useState<number>(0);

  const [effectiveStatus, setEffectiveStatus] =
    useState<'LIVE' | 'STALE' | 'OFFLINE'>('LIVE');

  const [isRefreshing, setIsRefreshing] =
    useState<boolean>(false);

  const [errorMessage, setErrorMessage] =
    useState<string | null>(null);

  /*
   * THE DERIVED-STALENESS CLOCK USED TO LIVE HERE.
   *
   * analysis and projections arrived from two extra endpoints that could fail
   * independently of the snapshot, so the screen had to be able to say "these
   * numbers are the last good ones, and this is how old they are". Both
   * endpoints are gone with the old engine; every derived reading now comes
   * from components that fetch and report their own freshness.
   */

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
        /*
         * ONE REQUEST, NOT THREE.
         *
         * getMarketAnalysis and getMarketProjections used to ride alongside
         * this call. Both were served by the old ProjectionEngine - a
         * 1.6-sigma band, a hand-picked intraday session curve, a 0.0035
         * seasonal coefficient and a point-scored probability distribution -
         * and every screen that consumed them now reads the engine that
         * derives everything from the stored series. The endpoints, the state
         * they filled and the staleness flag they needed are all gone; what is
         * left is the observed snapshot.
         */
        const [latestResult] = await Promise.allSettled([
          force
            ? ApiService.refreshMarket(
                bankParam,
                amountParam
              )
            : ApiService.getLatestMarket(
                bankParam,
                amountParam
              ),
        ]);

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
            ageSeconds={ageSeconds}
            effectiveStatus={effectiveStatus}
            onNavigateTab={handleNavigateTab}
          />
        )}

        {/* PROJECTIONS */}
        {/*
          UN SOLO SISTEMA DE PROYECCIONES.

          Aquí había tres paneles alimentados por tres motores distintos que
          respondían a la misma pregunta con métodos distintos, y ninguno decía
          cuál hablaba. Los dos antiguos —ProbabilisticProjectionPanel sobre
          /projections/analog y MarketProjectionPanel sobre /projections/general—
          se han eliminado junto con sus rutas.

          Queda uno: ProjectionsPanel, sobre /projections/daily, que nombra cada
          pierna por LA OPERACIÓN del propietario (MI VENTA = Binance BUY,
          MI COMPRA = Binance SELL) y publica la procedencia de cada precio.
        */}
        {activeTab === 'projections' && <ProjectionsPanel />}

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
