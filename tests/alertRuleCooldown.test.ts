/**
 * EL COOLDOWN DE LAS REGLAS DE ALERTA: 30 MINUTOS, POR REGLA, Y PERSISTIDO.
 *
 * QUÉ GOBIERNA ESTE INTERVALO, para que no se confunda con otra cosa.
 *
 * Estas reglas ya NO tienen camino a Telegram: notifyAlert y formatAlertMessage
 * no existen, y tests/telegramNoPriceAlert.test.ts lo mantiene cerrado por tres
 * vías. Lo que este intervalo gobierna es el HISTORIAL que /api/alerts sirve y
 * que AlertsManager muestra en pantalla.
 *
 * Sigue importando. Una regla de precio se cumple de forma CONTINUA - en cuanto
 * el mercado cruza el umbral se queda cruzado - así que a cinco minutos el
 * mismo hecho entraba doce veces por hora en ese panel. Un historial que repite
 * el mismo suceso no es un historial.
 *
 * LO QUE ESTE FICHERO DEMUESTRA:
 *   1. la misma regla no puede repetirse antes de 30 minutos;
 *   2. dos reglas distintas NO se bloquean entre sí;
 *   3. el reloj es de la regla y sobrevive a un reinicio del proceso;
 *   4. y nada de esto llega a Telegram.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALERT_RULE_COOLDOWN_MS } from '../server/centralStore.js';
import { makeAdItem, makeBinanceResponse } from './helpers/fixtures.js';
import type { AlertRule, AlertTriggerLog } from '../server/types.js';

const originalCwd = process.cwd();
let tmpDir: string;

const T0 = Date.parse('2026-08-29T16:00:00Z');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-cooldown-'));
  process.chdir(tmpDir);
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

/**
 * FÁBRICAS, NO CONSTANTES.
 *
 * evaluateAlerts escribe lastTriggeredAt sobre el objeto de la regla que se le
 * entregó, y getAlerts devuelve el array interno por referencia. Una constante
 * compartida arrastraría el reloj de un test al siguiente - cosa que ya pasó
 * una vez en esta suite.
 */
const priceRule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: 'regla-precio',
  name: 'Precio estratégico BUY sobre 930',
  condition: 'ABOVE',
  targetValue: 930,
  targetSide: 'BUY',
  enabled: true,
  createdAt: 1,
  ...over,
});

const spreadRule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: 'regla-spread',
  name: 'Spread por encima de 1%',
  condition: 'SPREAD_ABOVE',
  targetValue: 1,
  targetSide: 'SELL',
  enabled: true,
  createdAt: 1,
  ...over,
});

/** Un libro que cumple las dos reglas a la vez, sweep tras sweep. */
function stubBinance(buyPrice = '945.31', sellPrice = '960.03') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('api.telegram.org')) {
        return { ok: true, status: 200 } as unknown as Response;
      }
      const body = JSON.parse(String(init.body));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () =>
          makeBinanceResponse([
            makeAdItem({ price: body.tradeType === 'BUY' ? buyPrice : sellPrice }),
          ]),
      } as unknown as Response;
    })
  );
}

async function freshStore(rules: AlertRule[]) {
  vi.resetModules();
  const { StorageEngine } = await import('../server/storage.js');
  const { CentralMarketStore } = await import('../server/centralStore.js');
  const store = CentralMarketStore.getInstance();
  for (const rule of rules) StorageEngine.saveAlert(rule);
  return { store, StorageEngine };
}

const triggers = (): AlertTriggerLog[] => {
  const file = path.join(tmpDir, 'data', 'alert_triggers.json');
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as AlertTriggerLog[]) : [];
};

const forRule = (id: string) => triggers().filter((t) => t.ruleId === id);

describe('la constante es media hora, y no un número suelto', () => {
  it('ALERT_RULE_COOLDOWN_MS son 30 minutos', () => {
    expect(ALERT_RULE_COOLDOWN_MS).toBe(30 * 60 * 1000);
  });

  it('no queda ningún 300000 suelto gobernando las reglas', () => {
    const source = fs
      .readFileSync(path.join(originalCwd, 'server', 'centralStore.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(source).not.toMatch(/lastTriggeredAt\s*<\s*300000/);
    expect(source).toMatch(/lastTriggeredAt\s*<\s*ALERT_RULE_COOLDOWN_MS/);
  });
});

describe('1 — LA MISMA REGLA no puede repetirse antes de 30 minutos', () => {
  it('dispara una vez y calla el resto de la media hora, aunque el mercado siga cumpliéndola', async () => {
    stubBinance();
    const { store } = await freshStore([priceRule()]);

    await store.pollMarket();
    expect(forRule('regla-precio')).toHaveLength(1);

    /*
     * 300 sondeos a seis segundos: media hora entera de mercado cumpliendo la
     * condición sin interrupción. Es exactamente lo que hace una regla de
     * precio cuando el umbral queda cruzado.
     */
    for (let i = 1; i <= 299; i += 1) {
      vi.setSystemTime(T0 + i * 6_000);
      await store.pollMarket();
    }

    // 29,9 minutos después: sigue habiendo UNA sola entrada.
    expect(forRule('regla-precio')).toHaveLength(1);

    // A los cinco minutos habrían sido dos, y a la hora habrían sido doce.
    vi.setSystemTime(T0 + 5 * 60_000 + 1);
    await store.pollMarket();
    expect(forRule('regla-precio')).toHaveLength(1);
  }, 60_000);

  it('el borde exacto: un milisegundo antes calla, en el instante justo habla', async () => {
    stubBinance();
    const { store } = await freshStore([priceRule()]);

    await store.pollMarket();
    expect(forRule('regla-precio')).toHaveLength(1);

    vi.setSystemTime(T0 + ALERT_RULE_COOLDOWN_MS - 1);
    await store.pollMarket();
    expect(forRule('regla-precio')).toHaveLength(1);

    vi.setSystemTime(T0 + ALERT_RULE_COOLDOWN_MS);
    await store.pollMarket();
    expect(forRule('regla-precio')).toHaveLength(2);
  }, 60_000);

  it('en tres horas de condición ininterrumpida entran seis entradas, no treinta y seis', async () => {
    stubBinance();
    const { store } = await freshStore([priceRule()]);

    // Un sondeo por minuto durante tres horas: 181 evaluaciones.
    for (let minute = 0; minute <= 180; minute += 1) {
      vi.setSystemTime(T0 + minute * 60_000);
      await store.pollMarket();
    }

    // 180 minutos / 30 = 6 ventanas, contando la de t=0.
    expect(forRule('regla-precio')).toHaveLength(7);

    /*
     * Y las entradas están separadas por media hora exacta.
     *
     * logTrigger hace unshift, así que el historial va del más reciente al más
     * antiguo - es lo que un panel quiere mostrar. Se ordena antes de medir
     * las distancias, en vez de dar por hecho el sentido.
     */
    const times = forRule('regla-precio')
      .map((t) => t.timestamp)
      .sort((a, b) => a - b);

    expect(times[0]).toBe(T0);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i] - times[i - 1]).toBe(ALERT_RULE_COOLDOWN_MS);
    }
  }, 60_000);
});

describe('2 — DOS REGLAS DISTINTAS no se bloquean entre sí', () => {
  it('el reloj es de cada regla: las dos disparan en el mismo sondeo', async () => {
    /*
     * El fallo que esto impide: un cooldown GLOBAL habría dejado que la regla
     * de precio silenciara a la de spread durante media hora, y el operador
     * habría perdido un aviso distinto por culpa de otro.
     */
    stubBinance('945.31', '960.03');
    const { store } = await freshStore([priceRule(), spreadRule()]);

    await store.pollMarket();

    expect(forRule('regla-precio')).toHaveLength(1);
    expect(forRule('regla-spread')).toHaveLength(1);
    expect(triggers()).toHaveLength(2);
  }, 60_000);

  it('una regla dentro de su cooldown no impide que la otra empiece el suyo', async () => {
    stubBinance('945.31', '960.03');
    // Sólo la de precio existe al principio.
    const { store, StorageEngine } = await freshStore([priceRule()]);

    await store.pollMarket();
    expect(forRule('regla-precio')).toHaveLength(1);

    // Diez minutos después - la de precio sigue callada - aparece la de spread.
    vi.setSystemTime(T0 + 10 * 60_000);
    StorageEngine.saveAlert(spreadRule());
    await store.pollMarket();

    expect(forRule('regla-precio')).toHaveLength(1); // sigue en su ventana
    expect(forRule('regla-spread')).toHaveLength(1); // y la nueva sí habla
  }, 60_000);

  it('dos reglas del mismo tipo con umbrales distintos también son independientes', async () => {
    stubBinance();
    const { store } = await freshStore([
      priceRule({ id: 'sobre-930', targetValue: 930 }),
      priceRule({ id: 'sobre-940', targetValue: 940, name: 'Precio BUY sobre 940' }),
    ]);

    await store.pollMarket();

    expect(forRule('sobre-930')).toHaveLength(1);
    expect(forRule('sobre-940')).toHaveLength(1);
  }, 60_000);

  it('sus ventanas corren por separado, no en bloque', async () => {
    stubBinance('945.31', '960.03');
    const { store, StorageEngine } = await freshStore([priceRule()]);

    await store.pollMarket(); // precio dispara en T0

    vi.setSystemTime(T0 + 15 * 60_000);
    StorageEngine.saveAlert(spreadRule());
    await store.pollMarket(); // spread dispara en T0+15

    // La de precio vuelve en T0+30; la de spread no, porque la suya acaba en T0+45.
    vi.setSystemTime(T0 + 30 * 60_000);
    await store.pollMarket();
    expect(forRule('regla-precio')).toHaveLength(2);
    expect(forRule('regla-spread')).toHaveLength(1);

    // Y en T0+45 le toca a la de spread.
    vi.setSystemTime(T0 + 45 * 60_000);
    await store.pollMarket();
    expect(forRule('regla-spread')).toHaveLength(2);
  }, 60_000);
});

describe('3 — el reloj vive en la regla, y sobrevive a un reinicio', () => {
  it('reiniciar el proceso a los diez minutos no reabre la ventana', async () => {
    /*
     * lastTriggeredAt se persiste con saveAlert, así que la ventana está en
     * disco. Un contador en memoria habría dejado que cada reinicio
     * republicase el mismo hecho.
     */
    stubBinance();
    const first = await freshStore([priceRule()]);
    await first.store.pollMarket();
    expect(forRule('regla-precio')).toHaveLength(1);
    first.store.stop();

    // Proceso nuevo, mismo DATA_DIR, diez minutos después.
    vi.setSystemTime(T0 + 10 * 60_000);
    stubBinance();
    vi.resetModules();
    const { CentralMarketStore } = await import('../server/centralStore.js');
    const second = CentralMarketStore.getInstance();
    await second.pollMarket();

    expect(forRule('regla-precio')).toHaveLength(1);

    // Y pasada la media hora desde el disparo ORIGINAL, vuelve a hablar.
    vi.setSystemTime(T0 + ALERT_RULE_COOLDOWN_MS);
    await second.pollMarket();
    expect(forRule('regla-precio')).toHaveLength(2);
    second.stop();
  }, 60_000);

  it('el disparo queda escrito en la regla, no en una variable del proceso', async () => {
    stubBinance();
    const { store, StorageEngine } = await freshStore([priceRule()]);
    await store.pollMarket();

    const saved = StorageEngine.getAlerts().find((r) => r.id === 'regla-precio')!;
    expect(saved.lastTriggeredAt).toBe(T0);

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'data', 'alerts.json'), 'utf8')
    ) as AlertRule[];
    expect(onDisk.find((r) => r.id === 'regla-precio')?.lastTriggeredAt).toBe(T0);
  }, 60_000);
});

describe('4 — y nada de esto llega a Telegram', () => {
  it('media hora de reglas disparando no pone un solo mensaje en el cable', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '1234567890:FAKE-NOT-REAL';
    process.env.TELEGRAM_CHAT_ID = '-1001234567890';

    const wire: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (String(url).includes('api.telegram.org')) {
          wire.push(String(init.body));
          return { ok: true, status: 200 } as unknown as Response;
        }
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () =>
            makeBinanceResponse([
              makeAdItem({ price: body.tradeType === 'BUY' ? '945.31' : '960.03' }),
            ]),
        } as unknown as Response;
      })
    );

    const { store } = await freshStore([priceRule(), spreadRule()]);

    for (let minute = 0; minute <= 60; minute += 1) {
      vi.setSystemTime(T0 + minute * 60_000);
      await store.pollMarket();
    }

    // Las reglas dispararon de verdad: esto no pasa por no haber pasado nada.
    expect(triggers().length).toBeGreaterThan(2);
    // pollMarket no es la vía del resumen maker, así que el cable está vacío.
    expect(wire).toEqual([]);
    store.stop();
  }, 60_000);
});
