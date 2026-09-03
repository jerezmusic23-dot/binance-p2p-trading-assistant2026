/**
 * EL CONTRATO DE LA PANTALLA DE PROYECCIONES
 * ==========================================
 *
 * Un solo motor, una sola semántica, y ningún precio sin origen.
 *
 * Los fixtures son ARTIFICIALES y están elegidos para que la respuesta correcta
 * se pueda calcular a mano. El caso que más importa es el CRUZADO: mientras mi
 * venta esté por encima de mi compra, una fórmula equivocada —`max` global—
 * devuelve el número correcto por casualidad. Sólo cruzando las series se ve
 * quién calcula bien.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildDailyProjection,
  extractLegSeries,
  screenState,
  FIELD_FOR_LEG,
} from '../server/dailyProjection.js';
import { LEG_BINANCE_SIDE, MIN_PROFILE_DAYS, groupByDay } from '../server/projection/dailyShape.js';
import {
  bestOpportunity,
  favourableHours,
  projectedTurn,
} from '../server/projection/dailyOpportunity.js';
import type { HistoryRecord } from '../server/types.js';

const at = (day: number, hour: number, minute = 0): number =>
  Date.UTC(2026, 7, day, hour + 4, minute, 0);

/** `binanceBuy` va al lado BUY (mi venta) y `binanceSell` al SELL (mi compra). */
const record = (t: number, binanceBuy: number, binanceSell: number): HistoryRecord => ({
  id: `t-${t}`,
  timestamp: t,
  dateStr: new Date(t).toISOString(),
  hour: new Date(t - 4 * 3_600_000).getUTCHours(),
  buyPrice: binanceBuy,
  sellPrice: binanceSell,
  spreadPct: ((binanceSell - binanceBuy) / binanceBuy) * 100,
  bestBuyMerchant: 'artificial',
  bestSellMerchant: 'artificial',
  activeBuyAds: 20,
  activeSellAds: 20,
  source: 'TEST',
  calculationVersion: 'v2-strategic',
  strategicBuyPrice: binanceBuy,
  strategicSellPrice: binanceSell,
  strategicSpreadPct: ((binanceSell - binanceBuy) / binanceBuy) * 100,
});

/* ══════════════════════════════════════════════════════════════════════════
 * 1. UNA SOLA SEMÁNTICA
 * ══════════════════════════════════════════════════════════════════════════ */

describe('Binance BUY es MI VENTA y Binance SELL es MI COMPRA', () => {
  it('el mapeo vive en un único sitio', () => {
    expect(LEG_BINANCE_SIDE).toEqual({ VENTA: 'BUY', COMPRA: 'SELL' });
  });

  it('cada pierna arranca de su propio campo del histórico', () => {
    expect(FIELD_FOR_LEG.VENTA).toBe('strategicBuyPrice');
    expect(FIELD_FOR_LEG.COMPRA).toBe('strategicSellPrice');
  });

  it('las dos piernas nunca leen el mismo número', () => {
    const rows = [record(at(20, 9), 936, 931)];
    expect(extractLegSeries(rows, 'VENTA').points[0].price).toBe(936);
    expect(extractLegSeries(rows, 'COMPRA').points[0].price).toBe(931);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. TECHO Y PISO — INCLUIDO EL CASO CRUZADO
 * ══════════════════════════════════════════════════════════════════════════ */

describe('TECHO = máximo de MI VENTA, PISO = mínimo de MI COMPRA', () => {
  it('caso ordenado: venta 100/110/105, compra 90/95/92 → techo 110, piso 90', () => {
    const venta = [100, 110, 105];
    const compra = [90, 95, 92];
    const rows = venta.map((v, i) => record(at(20, 9 + i), v, compra[i]));
    const report = buildDailyProjection(rows, at(20, 20));

    expect(report.ceiling.observed?.price).toBe(110);
    expect(report.floor.observed?.price).toBe(90);
  });

  it('CASO CRUZADO: venta 100/102/101, compra 99/105/98 → techo 102, piso 98', () => {
    /*
     * El 105 aparece en MI COMPRA y supera a todo MI VENTA. Con `max` global el
     * techo saldría 105: un precio al que nunca pude vender, porque salió del
     * lado donde yo recompro. Éste es el caso que obliga a separar las piernas.
     */
    const venta = [100, 102, 101];
    const compra = [99, 105, 98];
    const rows = venta.map((v, i) => record(at(20, 9 + i), v, compra[i]));
    const report = buildDailyProjection(rows, at(20, 20));

    expect(report.ceiling.observed?.price).toBe(102);
    expect(report.ceiling.observed?.price).not.toBe(105);
    expect(report.floor.observed?.price).toBe(98);

    // Y la identidad de cada extremo declara de qué pierna vino.
    expect(report.ceiling.leg).toBe('VENTA');
    expect(report.ceiling.binanceSide).toBe('BUY');
    expect(report.floor.leg).toBe('COMPRA');
    expect(report.floor.binanceSide).toBe('SELL');
  });

  it('el máximo global de las dos series NO es el techo', () => {
    const rows = [record(at(20, 9), 100, 99), record(at(20, 10), 102, 105)];
    const report = buildDailyProjection(rows, at(20, 20));
    const globalMax = Math.max(100, 102, 99, 105);
    expect(globalMax).toBe(105);
    expect(report.ceiling.observed?.price).not.toBe(globalMax);
  });

  it('el mínimo global de las dos series NO es el piso', () => {
    const rows = [record(at(20, 9), 80, 99), record(at(20, 10), 102, 98)];
    const report = buildDailyProjection(rows, at(20, 20));
    const globalMin = Math.min(80, 102, 99, 98);
    expect(globalMin).toBe(80);
    expect(report.floor.observed?.price).not.toBe(globalMin);
    expect(report.floor.observed?.price).toBe(98);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. LAS PROYECCIONES NO SE CRUZAN
 * ══════════════════════════════════════════════════════════════════════════ */

describe('cada proyección consume sólo su propia serie', () => {
  const shape = (h: number) => 1 + (h - 8) * 0.004;
  const rows = [
    ...Array.from({ length: MIN_PROFILE_DAYS + 1 }, (_, i) =>
      Array.from({ length: 13 }, (_, k) =>
        record(at(10 + i, 8 + k), 936 * shape(8 + k), 931 * shape(8 + k))
      )
    ).flat(),
    ...Array.from({ length: 5 }, (_, k) => record(at(20, 8 + k), 950 * shape(8 + k), 945 * shape(8 + k))),
  ];

  it('cambiar SÓLO la serie de compra no altera la proyección de venta', () => {
    const base = buildDailyProjection(rows, at(20, 12));
    const altered = buildDailyProjection(
      rows.map((r) => ({ ...r, strategicSellPrice: r.strategicSellPrice! * 0.5 })),
      at(20, 12)
    );
    const ventaOf = (rep: ReturnType<typeof buildDailyProjection>) =>
      rep.legs.find((l) => l.projection.leg === 'VENTA')!.projection;

    expect(ventaOf(altered).anchorPrice).toBe(ventaOf(base).anchorPrice);
    expect(ventaOf(altered).projected.map((p) => p.central)).toEqual(
      ventaOf(base).projected.map((p) => p.central)
    );
    expect(altered.ceiling.observed?.price).toBe(base.ceiling.observed?.price);
  });

  it('cambiar SÓLO la serie de venta no altera la proyección de compra', () => {
    const base = buildDailyProjection(rows, at(20, 12));
    const altered = buildDailyProjection(
      rows.map((r) => ({ ...r, strategicBuyPrice: r.strategicBuyPrice! * 2 })),
      at(20, 12)
    );
    const compraOf = (rep: ReturnType<typeof buildDailyProjection>) =>
      rep.legs.find((l) => l.projection.leg === 'COMPRA')!.projection;

    expect(compraOf(altered).anchorPrice).toBe(compraOf(base).anchorPrice);
    expect(compraOf(altered).projected.map((p) => p.central)).toEqual(
      compraOf(base).projected.map((p) => p.central)
    );
    expect(altered.floor.observed?.price).toBe(base.floor.observed?.price);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. SIN DATOS NO SE INVENTA NADA
 * ══════════════════════════════════════════════════════════════════════════ */

describe('por debajo del mínimo no se fabrica una curva', () => {
  const dayOf = (d: number) =>
    Array.from({ length: 13 }, (_, k) => record(at(d, 8 + k), 936 + k, 931 + k));

  for (const days of [1, 2, 3, 4]) {
    it(`con ${days} día(s) anteriores no hay proyección ni percentiles`, () => {
      const rows = [
        ...Array.from({ length: days }, (_, i) => dayOf(10 + i)).flat(),
        ...dayOf(20).slice(0, 5),
      ];
      const report = buildDailyProjection(rows, at(20, 12));

      expect(report.state).toBe('DATOS_INSUFICIENTES');
      expect(report.daysMissing).toBe(MIN_PROFILE_DAYS - days);
      for (const leg of report.legs) {
        expect(leg.projection.projected).toEqual([]);
        expect(leg.projection.projectedClose).toBeNull();
        expect(leg.projection.projectedExtreme).toBeNull();
        expect(leg.opportunity).toBeNull();
      }
      // Lo observado hoy SÍ se conserva: es lo único que se puede afirmar.
      expect(report.ceiling.observed).not.toBeNull();
    });
  }

  it('sin ningún registro el estado es SIN_DATOS y no hay extremos', () => {
    const report = buildDailyProjection([], at(20, 12));
    expect(report.state).toBe('SIN_DATOS');
    expect(report.ceiling.dayBest).toBeNull();
    expect(report.floor.dayBest).toBeNull();
  });

  it('VALIDADA exige que el backtest gane en LAS DOS piernas', () => {
    const leg = (beats: boolean) =>
      ({ backtest: { beatsPersistence: beats } }) as any;
    expect(screenState('PERFIL_CONDICIONADO', [leg(true), leg(true)])).toBe('PROYECCION_VALIDADA');
    expect(screenState('PERFIL_CONDICIONADO', [leg(true), leg(false)])).toBe(
      'PROYECCION_CONDICIONADA'
    );
    expect(screenState('PERFIL_LIMITADO', [leg(false), leg(false)])).toBe('PROYECCION_LIMITADA');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. CADA PRECIO TIENE ORIGEN
 * ══════════════════════════════════════════════════════════════════════════ */

describe('ningún precio de la pantalla es mágico', () => {
  const rows = [record(at(20, 9), 936, 931), record(at(20, 10), 940, 928)];
  const report = buildDailyProjection(rows, at(20, 12));

  it('el techo declara campo, lado, pierna, cálculo y tipo', () => {
    const o = report.ceiling.origin;
    expect(o.field).toBe('strategicBuyPrice');
    expect(o.binanceSide).toBe('BUY');
    expect(o.leg).toBe('VENTA');
    expect(o.kind).toBe('OBSERVADO');
    expect(o.calculation.length).toBeGreaterThan(20);
  });

  it('el piso declara la cadena de la otra pierna', () => {
    const o = report.floor.origin;
    expect(o.field).toBe('strategicSellPrice');
    expect(o.binanceSide).toBe('SELL');
    expect(o.leg).toBe('COMPRA');
  });

  it('el precio de ahora de cada pierna trae su cadena', () => {
    for (const leg of report.legs) {
      expect(leg.nowOrigin.leg).toBe(leg.projection.leg);
      expect(leg.nowOrigin.field).toBe(FIELD_FOR_LEG[leg.projection.leg]);
      expect(leg.nowOrigin.kind).toBe('OBSERVADO');
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. HORARIOS FAVORABLES: POSICIÓN, NO MOVIMIENTO
 * ══════════════════════════════════════════════════════════════════════════ */

describe('las horas favorables miden posición dentro del día', () => {
  /** Días donde las 14 son SIEMPRE la hora más cara y las 9 la más barata. */
  const days = (leg: 'VENTA' | 'COMPRA') => {
    const points = [];
    for (let d = 0; d < MIN_PROFILE_DAYS + 2; d += 1) {
      for (let h = 8; h <= 20; h += 1) {
        const price = (900 + d * 10) * (h === 14 ? 1.02 : h === 9 ? 0.98 : 1);
        points.push({ t: at(1 + d, h, 10), price });
      }
    }
    return groupByDay(points, leg);
  };

  it('vendiendo, la hora más cara encabeza el ranking', () => {
    const ranked = favourableHours(days('VENTA'), 'VENTA');
    expect(ranked[0].hour).toBe(14);
    expect(ranked[0].score).toBe(1);
    expect(ranked[ranked.length - 1].hour).toBe(9);
  });

  it('recomprando, la hora más barata encabeza el ranking', () => {
    const ranked = favourableHours(days('COMPRA'), 'COMPRA');
    expect(ranked[0].hour).toBe(9);
    expect(ranked[ranked.length - 1].hour).toBe(14);
  });

  it('la deriva entre días no domina: el ranking es intradía', () => {
    // Los niveles suben 10 por día y aun así gana la hora, no el último día.
    const ranked = favourableHours(days('VENTA'), 'VENTA');
    expect(ranked[0].hour).toBe(14);
    for (const h of ranked) expect(h.daysUsed).toBeGreaterThanOrEqual(MIN_PROFILE_DAYS);
  });

  it('una hora vista en menos días que el mínimo no se publica', () => {
    const points = [{ t: at(1, 15, 0), price: 900 }, { t: at(1, 16, 0), price: 910 }];
    expect(favourableHours(groupByDay(points, 'VENTA'), 'VENTA')).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. OPORTUNIDAD Y GIRO
 * ══════════════════════════════════════════════════════════════════════════ */

describe('la mejor ocasión sigue el criterio de la pierna', () => {
  const q = (hoursAhead: number, central: number) => ({
    hoursAhead,
    hourOfDay: (12 + hoursAhead) % 24,
    dayKey: '2026-08-20',
    central,
    low: central - 1,
    high: central + 1,
    bandKind: 'RANGO_OBSERVADO' as const,
    daysUsed: 6,
    movePct: null,
  });

  it('vendiendo elige el máximo proyectado', () => {
    const best = bestOpportunity([q(1, 940), q(2, 950), q(3, 945)], 'VENTA', 936);
    expect(best?.hoursAhead).toBe(2);
    expect(best?.improvesOnNow).toBe(true);
    expect(best?.improvementPct).toBeCloseTo(((950 - 936) / 936) * 100, 6);
  });

  it('recomprando elige el mínimo proyectado', () => {
    const best = bestOpportunity([q(1, 930), q(2, 920), q(3, 925)], 'COMPRA', 931);
    expect(best?.hoursAhead).toBe(2);
    expect(best?.improvesOnNow).toBe(true);
    // Bajar el precio de compra es una MEJORA: el signo se invierte por pierna.
    expect(best?.improvementPct).toBeCloseTo(((920 - 931) / 931) * 100 * -1, 6);
  });

  it('si nada mejora el precio de ahora, lo dice', () => {
    const best = bestOpportunity([q(1, 930), q(2, 928)], 'VENTA', 936);
    expect(best?.improvesOnNow).toBe(false);
  });

  it('sin proyección no hay ocasión', () => {
    expect(bestOpportunity([], 'VENTA', 936)).toBeNull();
  });
});

describe('el giro proyectado exige cambio de signo y tamaño', () => {
  const p = (hoursAhead: number, movePct: number | null) => ({
    hoursAhead,
    hourOfDay: (12 + hoursAhead) % 24,
    dayKey: '2026-08-20',
    central: 900,
    low: 899,
    high: 901,
    bandKind: 'RANGO_OBSERVADO' as const,
    daysUsed: 6,
    movePct,
  });

  it('detecta el primer cambio de sentido por encima del umbral', () => {
    const turn = projectedTurn([p(1, 0.5), p(2, -0.6), p(3, -0.4)], 0.2);
    expect(turn?.hoursAhead).toBe(2);
    expect(turn?.from).toBe('SUBIENDO');
    expect(turn?.to).toBe('BAJANDO');
  });

  it('ignora un cambio de signo por debajo del umbral', () => {
    expect(projectedTurn([p(1, 0.5), p(2, -0.1)], 0.2)).toBeNull();
  });

  it('sin umbral medido no declara ningún giro', () => {
    expect(projectedTurn([p(1, 0.5), p(2, -0.6)], null)).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 8. UN SOLO MOTOR EN EL FLUJO DE PRODUCCIÓN
 * ══════════════════════════════════════════════════════════════════════════ */

describe('la pestaña de proyecciones tiene un único sistema', () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf-8');

  it('los paneles y rutas duplicados ya no existen', () => {
    for (const gone of [
      'src/ProbabilisticProjectionPanel.tsx',
      'src/ProbabilisticProjectionChart.tsx',
      'src/MarketProjectionPanel.tsx',
      'src/MarketStateBlock.tsx',
      'src/DailyFluctuationPanel.tsx',
    ]) {
      expect(fs.existsSync(path.join(process.cwd(), gone))).toBe(false);
    }
    /*
     * Se prohíbe el CABLEADO, no la mención: los comentarios que explican por
     * qué se retiraron esas rutas son documentación y deben poder nombrarlas.
     */
    const routes = read('server/routes.ts');
    expect(routes).not.toContain("apiRouter.get('/market/projections/analog'");
    expect(routes).not.toContain("apiRouter.get('/market/projections/general'");
  });

  it('la pestaña monta un solo panel de proyección', () => {
    const app = read('src/App.tsx');
    const mounted = app.match(/activeTab === 'projections' &&[\s\S]{0,200}?\/>/);
    expect(mounted).not.toBeNull();
    expect(mounted![0]).toContain('ProjectionsPanel');
    // Ni import ni JSX de los paneles retirados. El comentario sí puede citarlos.
    expect(app).not.toMatch(/import \{[^}]*MarketProjectionPanel/);
    expect(app).not.toMatch(/import \{[^}]*ProbabilisticProjectionPanel/);
    expect(app).not.toContain('<MarketProjectionPanel');
    expect(app).not.toContain('<ProbabilisticProjectionPanel');
  });

  it('el panel no calcula: sólo pide al endpoint único', () => {
    const panel = read('src/ProjectionsPanel.tsx');
    expect(panel).toContain('getDailyProjection');
    // Ninguna otra fuente de proyección entra en esta pantalla.
    expect(panel).not.toContain('getAnalogProjection');
    expect(panel).not.toContain('getGeneralProjection');
  });

  it('centralStore ya no cruza el precio estratégico con la serie maker', () => {
    const store = read('server/centralStore.ts');
    expect(store).not.toMatch(/currentBuyPrice:\s*this\.currentSnapshot\?\.strategicBuyPrice/);
    expect(store).not.toMatch(/currentSellPrice:\s*this\.currentSnapshot\?\.strategicSellPrice/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 9. CIERRE DE LA ARQUITECTURA: UNA API, UNA PANTALLA, NINGÚN HUÉRFANO
 * ══════════════════════════════════════════════════════════════════════════ */

describe('el máximo de una pierna no puede ser el extremo de la otra', () => {
  it('el MÁXIMO de MI COMPRA nunca se convierte en techo', () => {
    /*
     * MI COMPRA llega a 1000, muy por encima de todo MI VENTA. El techo tiene
     * que seguir siendo 102: 1000 es un precio del lado donde YO RECOMPRO y no
     * hay forma de haber vendido a esa tasa.
     */
    const rows = [
      record(at(20, 9), 100, 90),
      record(at(20, 10), 102, 1000),
      record(at(20, 11), 101, 95),
    ];
    const report = buildDailyProjection(rows, at(20, 20));
    expect(report.ceiling.observed?.price).toBe(102);
    expect(report.ceiling.leg).toBe('VENTA');
    // Y ese 1000 tampoco desaparece: es el máximo de su pierna, no un techo.
    expect(report.floor.observed?.price).toBe(90);
  });

  it('el MÍNIMO de MI VENTA nunca se convierte en piso', () => {
    /*
     * MI VENTA cae a 10, muy por debajo de todo MI COMPRA. El piso sigue
     * siendo 90: 10 salió del lado donde YO VENDO.
     */
    const rows = [
      record(at(20, 9), 100, 95),
      record(at(20, 10), 10, 90),
      record(at(20, 11), 101, 92),
    ];
    const report = buildDailyProjection(rows, at(20, 20));
    expect(report.floor.observed?.price).toBe(90);
    expect(report.floor.leg).toBe('COMPRA');
    expect(report.ceiling.observed?.price).toBe(101);
  });
});

describe('la API única devuelve exactamente lo que la pantalla consume', () => {
  const report = buildDailyProjection(
    [record(at(20, 9), 936, 931), record(at(20, 10), 940, 928)],
    at(20, 12)
  );

  it('trae los nueve bloques que la pantalla dibuja', () => {
    // 1 estado actual · 2 y 3 las piernas · 5 techo/piso · 7 giro · 9 suficiencia
    expect(report.legs).toHaveLength(2);
    for (const leg of report.legs) {
      expect(leg).toHaveProperty('now');
      expect(leg).toHaveProperty('nowOrigin');
      expect(leg).toHaveProperty('opportunity');
      expect(leg).toHaveProperty('favourableHours');
      expect(leg).toHaveProperty('turn');
      expect(leg).toHaveProperty('backtest');
      expect(leg).toHaveProperty('evidence');
      // 4. horizontes: la pantalla los lee de aquí, no los calcula.
      expect(Array.isArray(leg.projection.projected)).toBe(true);
    }
    expect(report).toHaveProperty('ceiling');
    expect(report).toHaveProperty('floor');
    expect(report).toHaveProperty('turningNow');
    expect(report).toHaveProperty('state');
    expect(report).toHaveProperty('daysMissing');
    expect(report).toHaveProperty('variables');
  });

  it('el ancla de cada pierna permite situar el horizonte de cada hora', () => {
    /*
     * La pantalla escribe "+N h" leyendo `hoursAhead` directamente, nunca
     * restando horas de reloj: eso rompería al cruzar medianoche. `hoursAhead`
     * es monótono creciente desde el ancla (1, 2, 3, ...) pase o no por 00:00.
     */
    for (const leg of report.legs) {
      expect(Number.isInteger(leg.projection.anchorHour)).toBe(true);
      let previousHoursAhead = 0;
      for (const h of leg.projection.projected) {
        expect(h.hoursAhead).toBeGreaterThan(previousHoursAhead);
        expect(h.hourOfDay).toBeGreaterThanOrEqual(0);
        expect(h.hourOfDay).toBeLessThanOrEqual(23);
        previousHoursAhead = h.hoursAhead;
      }
    }
  });
});

describe('no quedan consumidores de los motores retirados', () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf-8');
  /** Fuente sin comentarios: documentar la retirada es legítimo, usarla no. */
  const codeOnly = (f: string) =>
    read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

  const FILES = [
    'src/App.tsx',
    'src/api.ts',
    'src/types.ts',
    'src/ProjectionsPanel.tsx',
    'src/ProjectionsChart.tsx',
    'src/dailyChartRows.ts',
    'server/routes.ts',
    'server/centralStore.ts',
  ];

  const FORBIDDEN = [
    'ProbabilisticProjectionPanel',
    'MarketProjectionPanel',
    'DailyFluctuationPanel',
    'lastMarketProjection',
    'getAnalogProjection',
    'getGeneralProjection',
    'GeneralProjectionResponse',
    'MarketProjectionResponse',
  ];

  for (const term of FORBIDDEN) {
    it(`ningún fichero de producción usa ${term}`, () => {
      const offenders = FILES.filter((f) => codeOnly(f).includes(term));
      expect(offenders).toEqual([]);
    });
  }

  it('la única API de proyección que el cliente expone es la diaria', () => {
    const api = codeOnly('src/api.ts');
    const routes = [...api.matchAll(/\/api\/market\/projections\/(\w+)/g)].map((m) => m[1]);
    // maker, series y backtest sirven a OTRAS pestañas y siguen vivas.
    expect(new Set(routes)).toEqual(new Set(['daily', 'maker', 'series', 'backtest']));
    expect(routes).not.toContain('analog');
    expect(routes).not.toContain('general');
  });

  it('la pantalla se llama Proyección del Mercado', () => {
    expect(read('src/ProjectionsPanel.tsx')).toContain('PROYECCIÓN DEL MERCADO');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 10. UN RELOJ ROTO SE DENUNCIA, NO SE DISFRAZA DE "SIN DATOS"
 * ══════════════════════════════════════════════════════════════════════════ */

describe('un instante inutilizable falla en voz alta', () => {
  const rows = [record(at(20, 9), 936, 931)];

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    it(`buildDailyProjection rechaza now = ${bad}`, () => {
      expect(() => buildDailyProjection(rows, bad)).toThrow(/instante inutilizable/);
    });
  }

  it('el mensaje nombra el parámetro, no un RangeError de la librería', () => {
    /*
     * Antes esto lanzaba `RangeError: Invalid time value` desde dentro de
     * `toISOString`, sin decir qué valor ni de dónde venía.
     */
    try {
      buildDailyProjection(rows, Number.NaN);
      expect.unreachable('debería haber lanzado');
    } catch (err) {
      expect((err as Error).name).toBe('InvalidInstantError');
      expect((err as Error).message).toContain('buildDailyProjection(now)');
      expect((err as Error).message).not.toContain('Invalid time value');
    }
  });

  it('NO devuelve un informe SIN_DATOS: eso sería un diagnóstico falso', () => {
    // Un reloj roto no es un histórico vacío, y confundirlos manda a buscar
    // datos que ya están ahí.
    let report: unknown = null;
    try {
      report = buildDailyProjection(rows, Number.NaN);
    } catch {
      /* esperado */
    }
    expect(report).toBeNull();
  });

  it('un `now` válido sigue funcionando exactamente igual', () => {
    const report = buildDailyProjection(rows, at(20, 12));
    expect(report.ceiling.observed?.price).toBe(936);
    expect(report.state).toBe('DATOS_INSUFICIENTES');
  });

  it('las primitivas de hora local también se protegen', async () => {
    const { venezuelaDayKey, venezuelaHourOf, venezuelaWeekday } = await import(
      '../server/projection/dailyShape.js'
    );
    for (const fn of [venezuelaDayKey, venezuelaHourOf, venezuelaWeekday]) {
      expect(() => fn(Number.NaN)).toThrow(/instante inutilizable/);
    }
    // Y con un instante real siguen respondiendo lo de siempre.
    expect(venezuelaDayKey(at(20, 12))).toBe('2026-08-20');
    expect(venezuelaHourOf(at(20, 12))).toBe(12);
  });
});
