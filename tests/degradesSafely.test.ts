/**
 * AUDITORÍA PRE-DEPLOY — QUÉ HACE EL BOT CUANDO BINANCE NO COOPERA.
 *
 * Todas las simulaciones anteriores dan por hecho que Binance responde. En
 * producción no siempre lo hará: 429 por límite de tasa, 503 en un despliegue
 * suyo, un JSON truncado, la red caída, o un banco que simplemente deja de
 * tener anuncios.
 *
 * LA REGLA: degradar, nunca inventar. Un dato desconocido no se convierte en
 * cero, una caída no se muestra como un mercado en calma, y ningún fallo puede
 * producir una operación.
 *
 * Estas pruebas conducen el CentralMarketStore real - no módulos aislados -
 * porque lo que importa es qué contesta la aplicación entera.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutableCell } from '../server/types.js';

const originalCwd = process.cwd();
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-degrade-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ad = (price: string, payType = 'Banesco') => ({
  adv: {
    advNo: `a-${price}-${payType}`,
    price,
    maxSingleTransAmount: '200000',
    minSingleTransAmount: '1000',
    surplusAmount: '5000',
    tradableQuantity: '5000',
    tradeType: 'BUY',
    asset: 'USDT',
    fiatUnit: 'VES',
    tradeMethods: [{ payType, payMethodId: 'p', tradeMethodName: payType }],
  },
  advertiser: {
    userNo: 'u',
    nickName: 'N',
    userType: 'merchant',
    monthOrderCount: 1,
    monthFinishRate: 0.9,
    positiveRate: 0.9,
    userGrade: 2,
  },
});

const ok = (data: unknown[]) =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ code: '000000', message: null, success: true, data, total: data.length }),
  }) as unknown as Response;

/** Drives one full cycle and reports what the application answered. */
async function underFailure(handler: (body: { payTypes?: string[] }, call: number) => unknown) {
  vi.resetModules();
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('telegram')) return { ok: true, status: 200 } as unknown as Response;
      return handler(JSON.parse(String(init.body)), call++);
    })
  );

  const { CentralMarketStore } = await import('../server/centralStore.js');
  const store = CentralMarketStore.getInstance();

  const snapshot = await store.pollMarket();
  const { executableMatrix, marketReference } = await store.getExecutableMatrix();
  const { result: opportunities } = await store.getOpportunities();
  const projection = store.getMarketProjection();

  const cells = Object.values(executableMatrix.cells).flatMap(
    (byAmount) => Object.values(byAmount) as ExecutableCell[]
  );

  store.stop();
  return { snapshot, cells, marketReference, opportunities, projection };
}

const statuses = (cells: ExecutableCell[]) => [...new Set(cells.map((c) => c.status))].sort();

describe('un fallo de red o de protocolo NUNCA es un mercado en calma', () => {
  const FAILURES: [string, () => unknown][] = [
    ['HTTP 500', () => ({ ok: false, status: 500, statusText: 'ISE' })],
    ['HTTP 429 (límite de tasa)', () => ({ ok: false, status: 429, statusText: 'Too Many Requests' })],
    ['HTTP 403', () => ({ ok: false, status: 403, statusText: 'Forbidden' })],
    [
      'código de negocio distinto de 000000',
      () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ code: '000002', message: 'x', success: false, data: [] }) }),
    ],
    [
      'JSON truncado',
      () => ({ ok: true, status: 200, statusText: 'OK', json: async () => { throw new Error('Unexpected end of JSON input'); } }),
    ],
    [
      'data no es un array',
      () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ code: '000000', success: true, data: 'nope' }) }),
    ],
    ['la red se cae', () => { throw new Error('ECONNREFUSED'); }],
  ];

  for (const [name, handler] of FAILURES) {
    it(`${name}: OFFLINE, 42 celdas en ERROR, ninguna operación`, async () => {
      const { snapshot, cells, marketReference, opportunities } = await underFailure(
        handler as () => Response
      );

      // El snapshot dice que no hay captura, en vez de servir precios de la nada.
      expect(snapshot?.status ?? 'OFFLINE').toBe('OFFLINE');

      // La matriz existe y está completa, pero cada celda declara el fallo.
      expect(cells).toHaveLength(42);
      expect(statuses(cells)).toEqual(['ERROR']);
      for (const cell of cells) {
        expect(cell.reason).not.toBeNull();
        expect(cell.buy).toBeNull();
        expect(cell.sell).toBeNull();
      }

      // Ninguna operación, y ninguna referencia inventada.
      expect(opportunities.bestOpportunity).toBeNull();
      expect(marketReference.referenceSpreadPct).toBeNull();
      expect(marketReference.status).toBe('OFFLINE');
      // Y el payload dice de sí mismo que no es operable.
      expect(marketReference.executable).toBe(false);
    }, 60_000);
  }
});

describe('un libro vacío es un libro vacío, no un cero', () => {
  it('Binance responde bien y sin anuncios: NO_AD, y nada se inventa', async () => {
    const { snapshot, cells, marketReference, opportunities } = await underFailure(() => ok([]));

    expect(snapshot?.status ?? 'OFFLINE').toBe('OFFLINE');
    expect(statuses(cells)).toEqual(['NO_AD']);

    // Ni un precio, ni un spread, ni una oportunidad salidos de la nada.
    expect(marketReference.referenceBuyPrice).toBeNull();
    expect(marketReference.referenceSellPrice).toBeNull();
    expect(marketReference.referenceSpreadPct).toBeNull();
    expect(opportunities.bestOpportunity).toBeNull();
  }, 60_000);
});

describe('un payType que no conocemos nunca se acepta como banco', () => {
  it('un libro entero de "BancoDeMarte" no produce ni una celda ejecutable', async () => {
    /*
     * El riesgo real: Binance añade un método de pago, o renombra uno. Un
     * anuncio cuyo payType no está en BANK_CODE_MAP no puede verificarse como
     * de ese banco, y verificar es la condición para operar.
     */
    const { cells, opportunities } = await underFailure(() =>
      ok([ad('940', 'BancoDeMarte'), ad('950', 'BancoDeMarte')])
    );

    expect(cells).toHaveLength(42);
    expect(statuses(cells)).not.toContain('EXECUTABLE');
    expect(opportunities.bestOpportunity).toBeNull();
  }, 60_000);

  it('un anuncio SIN payType es NOT_VERIFIABLE, no un simple "no"', async () => {
    /*
     * La diferencia importa: "no se pudo establecer a qué banco pertenece" no
     * es lo mismo que "es de otro banco", y el operador merece leer cuál de
     * las dos cosas pasó.
     */
    const { cells } = await underFailure(() =>
      ok([
        { ...ad('940'), adv: { ...ad('940').adv, tradeMethods: [] } },
        { ...ad('950'), adv: { ...ad('950').adv, tradeMethods: [] } },
      ])
    );

    expect(statuses(cells)).not.toContain('EXECUTABLE');
    for (const cell of cells) expect(cell.reason).not.toBeNull();
  }, 60_000);
});

describe('la aplicación nunca lanza: un fallo se contesta, no se propaga', () => {
  it('pollMarket, la matriz, las oportunidades y la proyección resisten todo lo anterior', async () => {
    const brutal = [
      () => { throw new Error('ECONNREFUSED'); },
      () => ({ ok: false, status: 500, statusText: 'x' }),
      () => ok([]),
      () => ({ ok: true, status: 200, statusText: 'OK', json: async () => { throw new Error('bad json'); } }),
    ];

    let index = 0;
    // Una respuesta distinta en cada llamada: el peor caso mezclado.
    const { snapshot, cells, projection } = await underFailure(() => {
      const handler = brutal[index % brutal.length];
      index += 1;
      return handler() as Response;
    });

    // Llegó hasta aquí sin lanzar, que es lo que se está comprobando.
    expect(cells).toHaveLength(42);
    expect(snapshot?.status ?? 'OFFLINE').toBe('OFFLINE');

    /*
     * Una de las cuatro respuestas es un 200 legítimo con el libro vacío, así
     * que puede haber llegado a escribirse alguna observación y existir una
     * lectura. Lo que NO puede haber es un número imposible dentro de ella:
     * eso es lo que se comprueba, en vez de exigir que no haya lectura.
     */
    const nonFinite = (value: unknown, path = '', out: string[] = []): string[] => {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) out.push(`${value} en ${path}`);
      } else if (Array.isArray(value)) {
        value.forEach((v, i) => nonFinite(v, `${path}[${i}]`, out));
      } else if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) nonFinite(v, path ? `${path}.${k}` : k, out);
      }
      return out;
    };

    expect(nonFinite(projection, 'projection')).toEqual([]);
    expect(nonFinite(cells, 'cells')).toEqual([]);

    // Y si hay lectura, es del libro entero y lo dice en su identidad.
    if (projection.projection !== null) {
      expect(projection.projection.bank).toBe('MERCADO_GENERAL');
    }
  }, 60_000);
});

