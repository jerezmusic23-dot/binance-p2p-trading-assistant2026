/**
 * EL CABLEADO: RUTA HTTP Y ASERCIONES SOBRE EL FUENTE
 * ==================================================
 *
 * Dos clases de prueba, y las dos hacen falta:
 *
 * 1. EXTREMO A EXTREMO. Se levanta un Express real con el router real, se le
 *    da un histórico sintético en un directorio temporal y se pide la ruta por
 *    HTTP. Es lo único que demuestra que motor, adaptador, ruta y caché
 *    encajan de verdad.
 *
 * 2. ASERCIONES SOBRE EL FUENTE. La instrucción del propietario fue explícita:
 *    nada de recuperar las constantes ni la lógica del motor anterior. Eso no
 *    lo puede comprobar ninguna prueba de comportamiento —el modelo nuevo
 *    podría funcionar perfectamente y llevar dentro un 1.15 escrito a mano— así
 *    que se lee el fuente y se comprueba que no están.
 *
 * Ningún fichero se escribe en el `data/` del repositorio.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { syntheticHistory } from './helpers/projectionSeries.js';

const REPO = process.cwd();
const SRC = path.join(REPO, 'src');
const SERVER = path.join(REPO, 'server');
const ENGINE = path.join(SERVER, 'projection');

/** Fuente sin comentarios: sólo se afirma sobre el código. */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/* ------------------------------------------------------------------------ *
 * 1. EXTREMO A EXTREMO
 * ------------------------------------------------------------------------ */

describe('la ruta /api/market/projections/daily — la única de la pantalla', () => {
  let tmpDir: string;
  let server: Server;
  let base: string;

  async function boot(): Promise<void> {
    // Módulos frescos: StorageEngine resuelve sus rutas en inicializadores
    // estáticos.
    vi.resetModules();
    const { apiRouter } = await import('../server/routes.js');
    const app = express();
    app.use('/api', apiRouter);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function writeHistory(count: number): void {
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'market_history.json'),
      JSON.stringify(syntheticHistory(count))
    );
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-projection-'));
    fs.mkdirSync(path.join(tmpDir, 'data'));
    writeHistory(1200);
    process.env.DATA_DIR = path.join(tmpDir, 'data');
    await boot();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    process.chdir(REPO);
  });

  it('responde con las dos piernas nombradas por la operación', async () => {
    const res = await fetch(`${base}/api/market/projections/daily`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.source).toBe('market_history.json');
    expect(body.legs.map((l: any) => l.projection.leg)).toEqual(['VENTA', 'COMPRA']);
    // La traducción viaja en la respuesta, no se deduce en la pantalla.
    expect(body.legs[0].projection.binanceSide).toBe('BUY');
    expect(body.legs[1].projection.binanceSide).toBe('SELL');
  });

  it('el techo viene de MI VENTA y el piso de MI COMPRA, siempre', async () => {
    const body = await (await fetch(`${base}/api/market/projections/daily`)).json();
    expect(body.ceiling.leg).toBe('VENTA');
    expect(body.ceiling.binanceSide).toBe('BUY');
    expect(body.floor.leg).toBe('COMPRA');
    expect(body.floor.binanceSide).toBe('SELL');
  });

  it('cada precio de la respuesta trae su cadena de origen', async () => {
    const body = await (await fetch(`${base}/api/market/projections/daily`)).json();
    for (const origin of [body.ceiling.origin, body.floor.origin, ...body.legs.map((l: any) => l.nowOrigin)]) {
      expect(origin.field).toMatch(/^strategic(Buy|Sell)Price$/);
      expect(['BUY', 'SELL']).toContain(origin.binanceSide);
      expect(['VENTA', 'COMPRA']).toContain(origin.leg);
      expect(['OBSERVADO', 'PROYECTADO']).toContain(origin.kind);
      expect(origin.calculation.length).toBeGreaterThan(10);
    }
  });

  it('ninguna salida de la ruta es NaN o Infinity', async () => {
    const body = await (await fetch(`${base}/api/market/projections/daily`)).json();
    const bad: string[] = [];
    const walk = (value: unknown, path_ = ''): void => {
      if (typeof value === 'number' && !Number.isFinite(value)) bad.push(path_);
      else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path_}[${i}]`));
      else if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, path_ ? `${path_}.${k}` : k);
      }
    };
    walk(body);
    expect(bad).toEqual([]);
  });

  it('no lanza cuando no hay ningún histórico que leer', async () => {
    fs.writeFileSync(path.join(tmpDir, 'data', 'market_history.json'), '[]');
    await boot();
    const res = await fetch(`${base}/api/market/projections/daily`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('SIN_DATOS');
    // Y sin datos no se inventa ni un extremo.
    expect(body.ceiling.dayBest).toBeNull();
    expect(body.floor.dayBest).toBeNull();
  });

  it('el estado de pantalla llega decidido por el servidor', async () => {
    const body = await (await fetch(`${base}/api/market/projections/daily`)).json();
    expect([
      'SIN_DATOS',
      'DATOS_INSUFICIENTES',
      'PROYECCION_LIMITADA',
      'PROYECCION_CONDICIONADA',
      'PROYECCION_VALIDADA',
    ]).toContain(body.state);
    expect(body.stateText.length).toBeGreaterThan(10);
  });

  it('las rutas que NO son de esta pantalla siguen respondiendo', async () => {
    for (const route of ['/api/market/projections/maker', '/api/market/projections/series?bank=x&amount=y']) {
      const res = await fetch(`${base}${route}`);
      expect([200, 400, 404], route).toContain(res.status);
    }
  });

  it('las rutas de los motores retirados ya no existen', async () => {
    for (const gone of ['/api/market/projections/analog', '/api/market/projections/general']) {
      expect((await fetch(`${base}${gone}`)).status, gone).toBe(404);
    }
  });
});

describe('el motor nuevo no recupera nada del anterior', () => {
  /*
   * EL MOTOR QUE ESTÁ EN PRODUCCIÓN, no el que hubo. Al consolidar, la ruta
   * /projections/analog y sus paneles se eliminaron: los módulos de aquel
   * estimador quedan fuera del flujo y ya no se afirma nada sobre ellos aquí.
   */
  const ENGINE_FILES = [
    path.join(ENGINE, 'series.ts'),
    path.join(ENGINE, 'probability.ts'),
    path.join(ENGINE, 'dailyShape.ts'),
    path.join(ENGINE, 'dayIndex.ts'),
    path.join(SERVER, 'dailyProjection.ts'),
    path.join(SERVER, 'marketContext.ts'),
    path.join(SERVER, 'recordValidation.ts'),
  ];
  const UI_FILES = [
    path.join(SRC, 'ProjectionsPanel.tsx'),
    path.join(SRC, 'ProjectionsChart.tsx'),
    path.join(SRC, 'dailyChartRows.ts'),
  ];

  it('no contiene ninguna de las constantes ni los nombres retirados', () => {
    const forbidden = [
      /sessionCurve/i,
      /confidencePct/i,
      /notifyAlert/,
      /formatAlertMessage/,
      /ALERTA DE PRECIO/,
      /ALERTA P2P/,
      /ALTA VOLATILIDAD/,
      /\b1\.004\b/,
      /\b1\.15\b/,
      /\b1\.6\b/,
      /\b0\.0035\b/,
      /\b33\.3\b/,
    ];

    for (const file of [...ENGINE_FILES, ...UI_FILES]) {
      const body = code(file);
      for (const pattern of forbidden) {
        expect(pattern.test(body), `${path.basename(file)} contiene ${pattern}`).toBe(false);
      }
    }
  });

  it('el motor no esconde ningún precio en VES escrito a mano', () => {
    /*
     * Todo lo que se compara con un precio se mide en movimientos típicos de
     * la propia serie. Un literal decimal dentro del motor sería un umbral en
     * VES, que es exactamente lo que no puede haber.
     *
     * La lista blanca es corta y cada entrada está justificada en el fuente:
     * cuantiles, tolerancia de hueco, z y alpha. Los coeficientes de Lanczos
     * viven en probability.ts, que se comprueba aparte porque logGamma es una
     * función matemática y no un parámetro del mercado.
     */
    const allowed = new Set([
      '1.5', // GAP_TOLERANCE_MULTIPLE
      '0.1', // percentil 10 / borde de bucket
      '0.2',
      '0.3',
      '0.4',
      '0.5', // mediana, y "sin dirección dominante"
      '0.6',
      '0.7',
      '0.8', // percentil 90 / cobertura prometida
      '0.9',
      '1.0',
      '1.96', // z al 95%
      '0.05', // alpha
      '1.0001', // borde superior del último bucket
    ]);

    for (const file of [
      path.join(ENGINE, 'series.ts'),
      path.join(ENGINE, 'marketState.ts'),
      path.join(ENGINE, 'historicalAnalogies.ts'),
      path.join(ENGINE, 'engine.ts'),
      path.join(ENGINE, 'backtest.ts'),
      path.join(ENGINE, 'momentum.ts'),
      path.join(ENGINE, 'reading.ts'),
    ]) {
      const decimals = [...code(file).matchAll(/(?<![\w.])\d+\.\d+(?![\w.])/g)].map((m) => m[0]);
      const unexplained = decimals.filter((d) => !allowed.has(d));
      expect(unexplained, path.basename(file)).toEqual([]);
    }
  });

  it('la pantalla no calcula: sólo formatea lo que el servidor le da', () => {
    /*
     * Se buscan operaciones aritméticas sobre los campos que LLEVAN VALOR DE
     * MERCADO. Da igual cuánta aritmética haya en el layout: lo que no puede
     * pasar es que el precio central, la banda o una probabilidad se ajusten
     * aquí. Si alguien "corrigiera" la banda en el cliente, el servidor
     * publicaría una cosa y la pantalla enseñaría otra, y ninguna prueba de
     * comportamiento lo vería.
     */
    const fields =
      'central|low|high|probabilityUp|probabilityFlat|probabilityDown|currentPrice|regimeDelta|typicalStep|p10|p50|p90|modelMedianAbsError|persistenceMedianAbsError';
    const pattern = new RegExp(
      `\\b(?:${fields})\\b\\s*[-+*/]|[-+*/]\\s*\\b(?:${fields})\\b`,
      'g'
    );

    for (const file of UI_FILES) {
      expect([...code(file).matchAll(pattern)].map((m) => m[0]), path.basename(file)).toEqual([]);
    }
  });

  it('la pantalla no vuelve a clasificar la dirección por su cuenta', () => {
    const panel = code(path.join(SRC, 'ProjectionsPanel.tsx'));

    // ALCISTA/BAJISTA llegan ya decididos contra el régimen. Compararlos aquí
    // contra cero reintroduciría exactamente el sesgo que el motor evita.
    expect(panel).not.toMatch(/delta\s*>\s*0\s*\?\s*'ALCISTA'/);
    expect(panel).not.toMatch(/central[^\n]*>\s*currentPrice/);
  });

  it('la ruta no guarda caché, y por eso no puede servir algo viejo', () => {
    const routes = code(path.join(SERVER, 'routes.ts'));

    /*
     * El motor anterior cacheaba contra el estado de la serie porque buscar
     * analogías minuto a minuto era caro. Éste recorre el histórico una vez por
     * pierna y agrupa por horas: trabajo lineal. Sin caché no hay forma de
     * servir una proyección que ya no corresponde al histórico actual.
     */
    expect(routes).not.toMatch(/analogCache/);
    expect(routes).toMatch(/dailyProjectionFromStorage\(\)/);
  });

  it('no toca captura, alertas ni Telegram', () => {
    for (const file of ENGINE_FILES) {
      const body = code(file);
      expect(body, path.basename(file)).not.toMatch(/telegram/i);
      expect(body, path.basename(file)).not.toMatch(/binanceP2PService/);
      expect(body, path.basename(file)).not.toMatch(/evaluateAlerts|AlertRule|centralStore/);
    }
  });

  it('el paquete está separado por responsabilidades, no en un solo fichero', () => {
    // La instrucción fue explícita: nada de implementación monolítica.
    for (const file of ENGINE_FILES) {
      expect(fs.existsSync(file), file).toBe(true);
      const lines = fs.readFileSync(file, 'utf8').split('\n').length;
      expect(lines, path.basename(file)).toBeLessThan(600);
    }
  });
});
