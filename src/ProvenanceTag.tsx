import React from 'react';
import { DataProvenance, DataWindow } from './types';

/**
 * Minimal, functional provenance indicator.
 *
 * Every figure in this dashboard is REAL, AGGREGATED, PROJECTED or HEURISTIC.
 * This tag makes that visible without redesigning anything: a short code, a
 * colour, and the full explanation in the native tooltip.
 */

const LABELS: Record<DataProvenance, { short: string; title: string; className: string }> = {
  REAL: {
    short: 'REAL',
    title: 'Dato observado directamente en Binance P2P.',
    className: 'text-[#02c076] border-[#02c076]/40 bg-[#02c076]/10',
  },
  AGGREGATED: {
    short: 'AGREG',
    title: 'Calculado a partir de observaciones reales (media, mediana, desviación, RSI...).',
    className: 'text-[#7aa7ff] border-[#7aa7ff]/40 bg-[#7aa7ff]/10',
  },
  PROJECTED: {
    short: 'PROY',
    title: 'Extrapolación sobre un momento que todavía no ha ocurrido. No es un dato observado.',
    className: 'text-[#FCD535] border-[#FCD535]/40 bg-[#FCD535]/10',
  },
  STRATEGIC: {
    short: 'ESTRAT',
    title:
      'Precio de decisión: nivel central robusto del lado del libro (mediana), no el ' +
      'anuncio extremo. Un anuncio aislado y lejano no lo mueve.',
    className: 'text-[#f0b90b] border-[#f0b90b]/40 bg-[#f0b90b]/10',
  },
  EXECUTABLE: {
    short: 'EJEC',
    title:
      'Operacion realmente ejecutable: banco verificado por codigo canonico exacto, ' +
      'monto dentro de los limites del anuncio y liquidez publicada suficiente.',
    className: 'text-[#02c076] border-[#02c076]/40 bg-[#02c076]/10',
  },
  NOT_VERIFIABLE: {
    short: 'SIN VERIF',
    title:
      'No se pudo establecer una condicion necesaria (banco o liquidez). NO es ejecutable: ' +
      'la ausencia de verificacion nunca se convierte en una operacion.',
    className: 'text-[#848e9c] border-[#848e9c]/40 bg-[#848e9c]/10',
  },
  HEURISTIC: {
    short: 'HEUR',
    title:
      'Producido por una regla escrita a mano: constantes fijas, umbrales elegidos o valores ' +
      'de relleno. NO es un dato de mercado.',
    className: 'text-[#cf304a] border-[#cf304a]/50 bg-[#cf304a]/10',
  },
};

function describeWindow(window?: DataWindow): string {
  if (!window || window.sampleCount === 0) {
    return ' Sin observaciones almacenadas.';
  }
  return ` Basado en ${window.sampleCount} observaciones (${window.spanMinutes ?? 0} min).`;
}

interface ProvenanceTagProps {
  provenance: DataProvenance;
  reason?: string;
  dataWindow?: DataWindow;
}

export const ProvenanceTag: React.FC<ProvenanceTagProps> = ({
  provenance,
  reason,
  dataWindow,
}) => {
  const meta = LABELS[provenance];
  const title = `${meta.title}${reason ? ` ${reason}` : ''}${describeWindow(dataWindow)}`;

  return (
    <span
      title={title}
      className={`inline-block px-1 py-px rounded-xs border text-[9px] font-mono font-bold uppercase tracking-wider cursor-help ${meta.className}`}
    >
      {meta.short}
    </span>
  );
};

/**
 * Banner shown when the backend states it does not have enough data to project.
 * It shows the backend's own reason verbatim - it never guesses one.
 */
export const InsufficientDataNotice: React.FC<{ reason?: string }> = ({ reason }) => (
  <div className="bg-[#472c2c] border border-[#cf304a]/60 rounded-lg p-3 flex items-start gap-2.5">
    <span className="text-[#cf304a] font-bold text-xs font-mono mt-px">SIN DATOS SUFICIENTES</span>
    <span className="text-xs text-[#e0e0e0] leading-relaxed">
      {reason ?? 'El servidor no ha indicado un motivo.'}
    </span>
  </div>
);

/** Marks a value that is the last known good one, not a live reading. */
export const StaleTag: React.FC<{ ageSeconds: number }> = ({ ageSeconds }) => (
  <span
    title={`Este dato no se ha podido refrescar. Es el último valor válido conocido, de hace ${Math.round(ageSeconds)} segundos.`}
    className="inline-block px-1 py-px rounded-xs border border-[#FCD535]/50 bg-[#FCD535]/10 text-[#FCD535] text-[9px] font-mono font-bold uppercase tracking-wider cursor-help"
  >
    STALE {Math.round(ageSeconds)}s
  </span>
);
