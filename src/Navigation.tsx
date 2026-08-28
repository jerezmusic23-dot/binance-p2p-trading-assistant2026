import React from 'react';
import {
  LayoutDashboard,
  TrendingUp,
  Grid3X3,
  BookOpen,
  History,
  Bell,
  Tag,
  Activity,
} from 'lucide-react';

export type TabType =
  | 'overview'
  | 'publish'
  | 'analysis'
  | 'projections'
  | 'matrix'
  | 'orderbook'
  | 'history'
  | 'alerts';

interface NavigationProps {
  activeTab: TabType;
  onSelectTab: (tab: TabType) => void;
  activeAlertsCount?: number;
}

export const Navigation: React.FC<NavigationProps> = ({
  activeTab,
  onSelectTab,
  activeAlertsCount = 0,
}) => {
  const tabs: { id: TabType; label: string; icon: React.ReactNode; badge?: number }[] = [
    {
      id: 'overview',
      label: 'Panel Principal',
      icon: <LayoutDashboard className="w-4 h-4" />,
    },
    {
      /* The maker screen sits right after the dashboard: it is the answer the
         operator opens the app for. */
      id: 'publish',
      label: 'Mis Precios para Publicar',
      icon: <Tag className="w-4 h-4" />,
    },
    {
      /* Trend, ceilings, floors and signals per BANCO x MONTO - the analyst
         view, distinct from the older global session projection below. */
      id: 'analysis',
      label: 'Análisis del Mercado',
      icon: <Activity className="w-4 h-4" />,
    },
    {
      id: 'projections',
      /*
       * "Proyección Diaria (8AM-8PM)" named the old session chart: trece
       * cubos horarios rellenados hacia adelante con una curva escrita a
       * mano. Esa vista no existe. Lo que hay ahora es el libro completo
       * leído con el mismo motor que cada celda, sin franja horaria fija.
       */
      label: 'Proyección del Mercado',
      icon: <TrendingUp className="w-4 h-4" />,
    },
    {
      id: 'matrix',
      label: 'Matriz Multifiltro',
      icon: <Grid3X3 className="w-4 h-4" />,
    },
    {
      id: 'orderbook',
      label: 'Anuncios Reales P2P',
      icon: <BookOpen className="w-4 h-4" />,
    },
    {
      id: 'history',
      label: 'Histórico & Backtest',
      icon: <History className="w-4 h-4" />,
    },
    {
      id: 'alerts',
      label: 'Alertas',
      icon: <Bell className="w-4 h-4" />,
      badge: activeAlertsCount > 0 ? activeAlertsCount : undefined,
    },
  ];

  return (
    <nav id="main-navigation" className="bg-[#111417] border-b border-[#2b2f36] px-4 lg:px-8 py-2 overflow-x-auto no-scrollbar">
      <div className="max-w-7xl mx-auto flex items-center gap-2 min-w-max">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`nav-tab-${tab.id}`}
              onClick={() => onSelectTab(tab.id)}
              className={`flex items-center gap-2 px-3.5 py-2 rounded text-xs transition cursor-pointer font-medium tracking-wide ${
                isActive
                  ? 'bg-[#181a20] text-[#FCD535] border border-[#474d57] shadow-sm font-bold'
                  : 'text-[#848e9c] hover:text-[#e0e0e0] hover:bg-[#181a20]/50 border border-transparent'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
              {tab.badge && (
                <span className="w-4 h-4 rounded-full bg-[#cf304a] text-white text-[10px] flex items-center justify-center font-bold font-mono">
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
};
