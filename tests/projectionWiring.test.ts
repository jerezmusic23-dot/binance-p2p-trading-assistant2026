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

describe('la ruta /api/market/projections/analog', () => {
  let tmpDir: string;
  let server: Server;
  let base: string;

  async function boot(): Promise<void> {
    // Módulos frescos: StorageEngine resuelve sus rutas en inicializadores
    // estáticos, y el router guarda su caché en estado de módulo.
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

  it('responde con los dos lados y nombra su fuente', async () => {
    const res = await fetch(`${base}/api/market/projections/analog`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.source).toBe('market_history.json');
    expect(body.sides.map((s: any) => s.side)).toEqual(['BUY', 'SELL']);
    expect(body.sides[0].observations).toBe(1200);
    expect(typeof body.usable).toBe('boolean');
  });

  it('cada horizonte llega con estado, y sin evidencia no lleva números', async () => {
    const body = await (await fetch(`${base}/api/market/projections/analog`)).json();
    const seen = new Set<string>();

    for (const side of body.sides) {
      for (const horizon of side.horizons) {
        seen.add(horizon.status);
        expect(horizon.statusText).toBeTruthy();
        expect(Number.isFinite(horizon.requestedHorizonMs)).toBe(true);

        if (!horizon.available) {
          expect(horizon.probabilityUp).toBeNull();
          expect(horizon.central).toBeNull();
          expect(horizon.scenarios).toEqual([]);
          continue;
        }
        expect(horizon.audit.samples.length).toBe(horizon.audit.analoguesUsed);
        expect(horizon.evidence).toContain(`${horizon.audit.upCount} de`);
        expect(horizon.scenarios).toHaveLength(3);
        expect(horizon.estimatedAt).toBeGreaterThan(side.lastTimestamp);
      }
    }

    // Con este histórico corto tiene que aparecer al menos un estado de
    // insuficiencia: es el caso que más importa que llegue bien a la pantalla.
    expect([...seen].some((s) => s.startsWith('INSUFFICIENT'))).toBe(true);
  });

  it('ninguna salida de la ruta es NaN o Infinity', async () => {
    const body = await (await fetch(`${base}/api/market/projections/analog`)).json();

    // JSON.stringify convierte los no finitos en null, así que se comprueba
    // sobre el texto crudo: si algo se colase, aparecería como null donde
    // debería haber número, o como literal.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('NaN');
    expect(raw).not.toContain('Infinity');

    const walk = (value: unknown, at = 'root'): void => {
      if (typeof value === 'number') {
        expect(Number.isFinite(value), `${at} = ${value}`).toBe(true);
      } else if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${at}[${i}]`));
      } else if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, `${at}.${k}`);
      }
    };
    walk(body);
  });

  it('sirve desde caché mientras el histórico no cambie', async () => {
    const first = await (await fetch(`${base}/api/market/projections/analog`)).json();
    const second = await (await fetch(`${base}/api/market/projections/analog`)).json();

    // Mismo objeto cacheado: generatedAt no se vuelve a sellar.
    expect(second.generatedAt).toBe(first.generatedAt);
  });

  it('dos peticiones simultáneas comparten un solo cálculo', async () => {
    const [a, b] = await Promise.all([
      fetch(`${base}/api/market/projections/analog`).then((r) => r.json()),
      fetch(`${base}/api/market/projections/analog`).then((r) => r.json()),
    ]);

    expect(a.generatedAt).toBe(b.generatedAt);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('no lanza cuando no hay ningún histórico que leer', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.writeFileSync(path.join(tmpDir, 'data', 'market_history.json'), '[]');
    await boot();

    const res = await fetch(`${base}/api/market/projections/analog`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.usable).toBe(false);
    for (const side of body.sides) {
      expect(side.observations).toBe(0);
      expect(side.notice).toContain('INSUFICIENTE HISTÓRICO');
    }
  });

  it('no rompe las rutas de proyección que ya existían', async () => {
    for (const route of ['/api/market/projections/general', '/api/market/history']) {
      const res = await fetch(`${base}${route}`);
      expect(res.status, route).toBe(200);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * 2. NO SE HA VUELTO AL MODELO ANTERIOR CON OTRO NOMBRE
 * ------------------------------------------------------------------------ */

describe('el motor nuevo no recupera nada del anterior', () => {
  const ENGINE_FILES = [
    path.join(ENGINE, 'series.ts'),
    path.join(ENGINE, 'marketState.ts'),
    path.join(ENGINE, 'historicalAnalogies.ts'),
    path.join(ENGINE, 'probability.ts'),
    path.join(ENGINE, 'engine.ts'),
    path.join(ENGINE, 'backtest.ts'),
    path.join(SERVER, 'marketProjection.ts'),
  ];
  const UI_FILES = [
    path.join(SRC, 'ProbabilisticProjectionPanel.tsx'),
    path.join(SRC, 'ProbabilisticProjectionChart.tsx'),
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
    const panel = code(path.join(SRC, 'ProbabilisticProjectionPanel.tsx'));

    // ALCISTA/BAJISTA llegan ya decididos contra el régimen. Compararlos aquí
    // contra cero reintroduciría exactamente el sesgo que el motor evita.
    expect(panel).not.toMatch(/delta\s*>\s*0\s*\?\s*'ALCISTA'/);
    expect(panel).not.toMatch(/central[^\n]*>\s*currentPrice/);
  });

  it('la ruta invalida la caché con el estado real de la serie', () => {
    const routes = code(path.join(SERVER, 'routes.ts'));

    // Contra los datos, no contra el reloj: un TTL serviría una proyección
    // vieja, o recalcularía sin que hubiera cambiado nada.
    expect(routes).toMatch(/const key = `\$\{records\.length\}:\$\{newest\}`/);
    expect(routes).toMatch(/analogCache\.key === key/);
    // Y la ruta usa la variante que cede el hilo: la captura es prioritaria.
    expect(routes).toMatch(/buildMarketProjectionAsync/);
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
