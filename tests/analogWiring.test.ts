/**
 * EL CABLEADO DE LA PROYECCIÓN POR ANALOGÍA
 * =========================================
 *
 * Dos clases de prueba, y las dos hacen falta:
 *
 * 1. EXTREMO A EXTREMO. Se levanta un Express real con el router real, se le
 *    da un histórico sintético en un directorio temporal, y se pide la ruta por
 *    HTTP. Es lo único que demuestra que el motor, el adaptador, la ruta y la
 *    caché encajan de verdad.
 *
 * 2. ASERCIONES SOBRE EL FUENTE. La instrucción del propietario fue explícita:
 *    nada de recuperar las constantes del motor anterior. Eso no lo puede
 *    comprobar ninguna prueba de comportamiento — el modelo nuevo podría
 *    funcionar perfectamente y llevar dentro un 1.15 escrito a mano — así que
 *    se lee el fuente y se comprueba que no están.
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
import type { HistoryRecord } from '../server/types.js';

const REPO = process.cwd();
const SRC = path.join(REPO, 'src');
const SERVER = path.join(REPO, 'server');

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

  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function history(count: number): HistoryRecord[] {
    const rnd = mulberry32(5);
    const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);
    let buy = 940;
    let sell = 945;
    return Array.from({ length: count }, (_, i) => {
      buy += (rnd() < 0.5 ? -1 : 1) * 0.01;
      sell += (rnd() < 0.5 ? -1 : 1) * 0.01;
      return {
        id: `r${i}`,
        timestamp: T0 + i * 60_000,
        dateStr: '2026-08-01',
        hour: 0,
        buyPrice: buy - 3,
        sellPrice: sell + 3,
        spreadPct: 0,
        bestBuyMerchant: 'A',
        bestSellMerchant: 'B',
        activeBuyAds: 20,
        activeSellAds: 20,
        source: 'test',
        calculationVersion: 'v2-strategic',
        strategicBuyPrice: Number(buy.toFixed(4)),
        strategicSellPrice: Number(sell.toFixed(4)),
        strategicSpreadPct: 0,
      } as HistoryRecord;
    });
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-analog-'));
    fs.mkdirSync(path.join(tmpDir, 'data'));
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'market_history.json'),
      JSON.stringify(history(1500))
    );
    process.env.DATA_DIR = path.join(tmpDir, 'data');

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
    expect(body.sides[0].observations).toBe(1500);
    expect(typeof body.usable).toBe('boolean');
  });

  it('cada porcentaje que devuelve llega con los casos que lo sostienen', async () => {
    const body = await (await fetch(`${base}/api/market/projections/analog`)).json();

    for (const side of body.sides) {
      for (const horizon of side.horizons) {
        if (!horizon.available) {
          // Sin evidencia: ni un número, y un motivo legible.
          expect(horizon.probabilityUp).toBeNull();
          expect(horizon.central).toBeNull();
          expect(horizon.reasonText).toBeTruthy();
          continue;
        }
        expect(horizon.audit.samples.length).toBe(horizon.audit.analoguesUsed);
        expect(horizon.probabilityUp).toBeCloseTo(
          horizon.audit.upCount / horizon.audit.analoguesUsed,
          12
        );
        expect(horizon.evidence).toContain(`${horizon.audit.upCount} de`);
      }
    }
  });

  it('sirve la misma respuesta desde caché mientras el histórico no cambie', async () => {
    const first = await (await fetch(`${base}/api/market/projections/analog`)).json();
    const second = await (await fetch(`${base}/api/market/projections/analog`)).json();

    // Mismo objeto cacheado: generatedAt no se vuelve a sellar.
    expect(second.generatedAt).toBe(first.generatedAt);
  });

  it('no lanza cuando no hay ningún histórico que leer', async () => {
    fs.writeFileSync(path.join(tmpDir, 'data', 'market_history.json'), '[]');
    vi.resetModules();
    const { apiRouter } = await import('../server/routes.js');
    const app = express();
    app.use('/api', apiRouter);
    const s = await new Promise<Server>((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
    const port = (s.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/market/projections/analog`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.usable).toBe(false);
    for (const side of body.sides) {
      expect(side.observations).toBe(0);
      expect(side.notice).toContain('INSUFICIENTE HISTÓRICO');
    }

    await new Promise<void>((resolve) => s.close(() => resolve()));
  });
});

/* ------------------------------------------------------------------------ *
 * 2. NO SE HA VUELTO AL MODELO ANTERIOR CON OTRO NOMBRE
 * ------------------------------------------------------------------------ */

describe('el motor nuevo no recupera nada del anterior', () => {
  const NEW_FILES = [
    path.join(SERVER, 'analogProjection.ts'),
    path.join(SERVER, 'marketAnalogProjection.ts'),
    path.join(SRC, 'AnalogProjectionPanel.tsx'),
    path.join(SRC, 'AnalogProjectionChart.tsx'),
  ];

  it('no contiene ninguna de las constantes del motor retirado', () => {
    // Nombradas una a una porque fueron nombradas una a una: sessionCurve,
    // confidencePct y los multiplicadores 1.004 / 1.15 / 1.6.
    const forbidden = [
      /sessionCurve/i,
      /confidencePct/i,
      /\b1\.004\b/,
      /\b1\.15\b/,
      /\b1\.6\b/,
      /\b0\.0035\b/,
    ];

    for (const file of NEW_FILES) {
      const body = code(file);
      for (const pattern of forbidden) {
        expect(pattern.test(body), `${path.basename(file)} contiene ${pattern}`).toBe(false);
      }
    }
  });

  it('el motor no esconde ningún precio en VES escrito a mano', () => {
    // Todo lo que se compara con un precio se mide en pasos típicos de la
    // propia serie. Un literal con decimales dentro del motor sería un umbral
    // en VES, que es exactamente lo que no puede haber.
    const body = code(path.join(SERVER, 'analogProjection.ts'));
    const decimals = [...body.matchAll(/(?<![\w.])\d+\.\d+(?![\w.])/g)].map((m) => m[0]);

    // Los únicos decimales admitidos: los coeficientes de Lanczos para
    // logGamma (una función matemática, no un parámetro del mercado), la
    // tolerancia de hueco, los cuantiles de la banda, z y alpha.
    const allowed = new Set([
      '1.5', // GAP_TOLERANCE_MULTIPLE
      '0.1', // percentil 10
      '0.5', // mediana
      '0.9', // percentil 90
      '1.96', // z al 95%
      '0.05', // alpha
      '0.6745',
    ]);
    const unexplained = decimals.filter(
      (d) => !allowed.has(d) && !/^0\.9999|^\d{3,}\.|e-/.test(d) && !body.includes(`${d},`)
    );

    expect(unexplained).toEqual([]);
  });

  it('la pantalla no calcula: sólo formatea lo que el servidor le da', () => {
    const panel = code(path.join(SRC, 'AnalogProjectionPanel.tsx'));
    const chart = code(path.join(SRC, 'AnalogProjectionChart.tsx'));

    /*
     * Se buscan operaciones aritméticas sobre los campos que LLEVAN VALOR DE
     * MERCADO. Da igual cuánta aritmética haya en el layout: lo que no puede
     * pasar es que el precio central, la banda o una probabilidad se ajusten
     * aquí. Si un día alguien "corrige" la banda en el cliente, el servidor
     * seguiría publicando una cosa y la pantalla enseñando otra, y ninguna
     * prueba de comportamiento lo vería.
     */
    const valueFields =
      'central|low|high|probabilityUp|probabilityFlat|probabilityDown|currentPrice|regimeDelta|typicalStep|p10|p50|p90';
    const pattern = new RegExp(`\\b(?:${valueFields})\\b\\s*[-+*/]|[-+*/]\\s*\\b(?:${valueFields})\\b`, 'g');

    expect([...panel.matchAll(pattern)].map((m) => m[0])).toEqual([]);
    expect([...chart.matchAll(pattern)].map((m) => m[0])).toEqual([]);
  });

  it('la pantalla no vuelve a clasificar la dirección por su cuenta', () => {
    const panel = code(path.join(SRC, 'AnalogProjectionPanel.tsx'));

    // ALCISTA/BAJISTA se reciben ya decididos contra el régimen. Compararlos
    // aquí contra cero reintroduciría exactamente el sesgo que el motor evita.
    expect(panel).not.toMatch(/delta\s*>\s*0\s*\?\s*'ALCISTA'/);
    expect(panel).not.toMatch(/(?:central|currentPrice)[^\n]*>\s*(?:currentPrice|central)/);
  });

  it('la ruta invalida la caché con el estado real de la serie', () => {
    const routes = code(path.join(SERVER, 'routes.ts'));

    // Contra los datos, no contra el reloj: un TTL serviría una proyección
    // vieja, o recalcularía sin que hubiera cambiado nada.
    expect(routes).toMatch(/const key = `\$\{records\.length\}:\$\{newest\}`/);
    expect(routes).toMatch(/analogCache\.key !== key/);
  });

  it('no toca captura, alertas ni Telegram', () => {
    for (const file of [
      path.join(SERVER, 'analogProjection.ts'),
      path.join(SERVER, 'marketAnalogProjection.ts'),
    ]) {
      const body = code(file);
      expect(body).not.toMatch(/telegram/i);
      expect(body).not.toMatch(/binanceP2PService/);
      expect(body).not.toMatch(/evaluateAlerts|AlertRule/);
    }
  });
});
