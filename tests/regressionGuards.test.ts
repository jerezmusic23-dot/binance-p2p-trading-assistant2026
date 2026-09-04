/**
 * GUARDIANES DE REGRESIÓN — LITERALES DE LA INSTRUCCIÓN DEL OPERADOR.
 * =====================================================================
 *
 * Cinco fallos exactos que el operador pidió que hicieran fallar la suite si
 * vuelven a ocurrir. Cada `describe` de aquí abajo existe para UNO de ellos,
 * y el título de cada test dice literalmente qué regresión detecta - no hay
 * que leer el motor para saber qué falló.
 *
 *   1. la proyección vuelve a limitarse a 08:00-20:00;
 *   2. una proyección de 24h no cruza medianoche;
 *   3. notifyMarketSignals() vuelve a ser no-op;
 *   4. una señal PROJECTION/BREAKOUT/TREND_CHANGE no llega al transport;
 *   5. las alertas antiguas (ALERTA DE PRECIO/P2P/VOLATILIDAD/taker) vuelven
 *      a Telegram.
 *
 * Cada behavioral test aquí llama a la función de producción real -
 * projectLeg, notifyMarketSignals - nunca una reimplementación paralela.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_HORIZON_HOURS, projectLeg } from '../server/projection/dailyShape.js';
import { TelegramNotifier } from '../server/telegramNotifier.js';
import type { MarketSignal } from '../server/signalEngine.js';

const SERVER = path.join(process.cwd(), 'server');
const read = (file: string) => fs.readFileSync(path.join(SERVER, file), 'utf8');
const code = (file: string) =>
  read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

afterEach(() => vi.unstubAllGlobals());

/** Venezuela es UTC-4 fijo: HH:00 local del día `d` = (HH+4):00 UTC. */
const vene = (day: number, hour: number): number => Date.UTC(2026, 7, day, hour + 4, 0, 0);

describe('1. la proyección NUNCA vuelve a limitarse a 08:00-20:00', () => {
  it('DEFAULT_HORIZON_HOURS sigue siendo 24, y las constantes de ventana no existen en ningún módulo', () => {
    expect(DEFAULT_HORIZON_HOURS).toBe(24);
    for (const file of fs.readdirSync(SERVER)) {
      if (!file.endsWith('.ts')) continue;
      const src = code(file);
      expect(src).not.toMatch(/DEFAULT_DAY_START_HOUR/);
      expect(src).not.toMatch(/DEFAULT_DAY_END_HOUR/);
    }
  });

  it('con evidencia real, un ancla a las 22:00 proyecta horas FUERA de 08:00-20:00 (23, 0, 1... 21)', () => {
    // Siete días completos (0-23) de evidencia previa, más "hoy" hasta las 22:00.
    const points: { t: number; price: number }[] = [];
    for (let day = 1; day <= 7; day++) {
      const lastHour = day === 7 ? 22 : 23;
      for (let hour = 0; hour <= lastHour; hour++) {
        points.push({ t: vene(day, hour), price: 940 + Math.sin(hour) * 2 });
      }
    }
    const now = vene(7, 22);
    const venta = projectLeg(points, 'VENTA', now, 24);

    expect(venta.projected).toHaveLength(24);
    const hoursOfDay = venta.projected.map((p) => p.hourOfDay);
    // Horas que la vieja ventana 08:00-20:00 habría descartado sin más:
    // de madrugada (0-7) y de noche (21-23). Todas deben estar presentes.
    for (const mustExist of [23, 0, 1, 2, 5, 21]) {
      expect(hoursOfDay).toContain(mustExist);
    }
    // Y ninguna hora se filtra por caer fuera de [8, 20]: las 24 están, sin excepción.
    expect(new Set(hoursOfDay).size).toBe(24);
  });
});

describe('2. una proyección de 24h SIEMPRE cruza medianoche cuando el ancla lo exige', () => {
  it('ancla 23:00, horizonte 24h: +1h es el día siguiente y +24h vuelve a las 23:00 de ESE día siguiente', () => {
    const points: { t: number; price: number }[] = [];
    for (let day = 1; day <= 8; day++) {
      const lastHour = day === 8 ? 23 : 23;
      for (let hour = 0; hour <= lastHour; hour++) {
        points.push({ t: vene(day, hour), price: 940 + hour * 0.1 });
      }
    }
    const now = vene(8, 23);
    const compra = projectLeg(points, 'COMPRA', now, 24);

    expect(compra.anchorDayKey).toBe('2026-08-08');
    const plus1 = compra.projected.find((p) => p.hoursAhead === 1)!;
    expect(plus1.hourOfDay).toBe(0);
    expect(plus1.dayKey).toBe('2026-08-09');

    const plus24 = compra.projected.find((p) => p.hoursAhead === 24)!;
    expect(plus24.hourOfDay).toBe(23);
    expect(plus24.dayKey).toBe('2026-08-09');

    // Al menos una hora del horizonte pertenece a un día calendario distinto
    // del ancla - la prueba directa de que el horizonte SÍ cruza medianoche.
    const dayKeys = new Set(compra.projected.map((p) => p.dayKey));
    expect(dayKeys.has('2026-08-09')).toBe(true);
    expect(dayKeys.has(compra.anchorDayKey)).toBe(false); // 24h enteras: ninguna se queda en el día del ancla.
  });
});

describe('3. notifyMarketSignals() NUNCA vuelve a ser un no-op permanente', () => {
  it('el código fuente ya no devuelve UNCHANGED incondicionalmente para toda señal', () => {
    const notifier = code('telegramNotifier.ts');
    expect(notifier).not.toMatch(
      /return signals\.map\(\(\) => \(\{ outcome: 'UNCHANGED' as const/
    );
    // Y el envío real sigue presente: el método llama a this.send con el
    // mensaje formateado, no sólo construye un resultado sintético.
    const method = notifier.slice(
      notifier.indexOf('public async notifyMarketSignals'),
      notifier.indexOf('private async send(')
    );
    expect(method).toMatch(/await this\.send\(formatMarketSignalMessage/);
  });

  it('una señal nueva, no-INFO, en un notifier limpio, se envía de verdad (SENT + fetch llamado)', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const notifier = new TelegramNotifier({
      botToken: '1234567890:TEST-TOKEN-NOT-REAL',
      chatId: '-1000000000000',
      cooldownMs: 0,
      timeoutMs: 1000,
    });

    const signal: MarketSignal = {
      kind: 'TREND_CHANGE',
      status: 'CONFIRMED',
      bank: 'BANESCO',
      bankDisplayName: 'Banesco',
      amountKey: '10K',
      amountVes: 10_000,
      side: 'BUY',
      sideLabel: 'MI COMPRA DE USDT',
      headline: 'cambio de tendencia confirmado',
      evidence: ['x'],
      confidence: 'HIGH',
      sampleSize: 40,
      currentPrice: 940,
      projectedLow: 938,
      projectedHigh: 942,
      watchStartHour: null,
      watchEndHour: null,
      identity: 'TREND_CHANGE:BANESCO:10K:BUY:regresion',
    } as MarketSignal;

    const [result] = await notifier.notifyMarketSignals([signal], Date.now());
    expect(result.outcome).toBe('SENT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('4. PROJECTION/BREAKOUT/TREND_CHANGE SIEMPRE llegan al transporte', () => {
  const base = {
    bank: 'MERCANTIL',
    bankDisplayName: 'Mercantil',
    amountKey: '20K',
    amountVes: 20_000,
    side: 'SELL' as const,
    sideLabel: 'MI VENTA DE USDT',
    evidence: ['evidencia'],
    confidence: 'HIGH' as const,
    sampleSize: 50,
    currentPrice: 950,
    projectedLow: 948,
    projectedHigh: 953,
    watchStartHour: null,
    watchEndHour: null,
  };

  async function sendOne(signal: MarketSignal) {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const notifier = new TelegramNotifier({
      botToken: '1234567890:TEST-TOKEN-NOT-REAL',
      chatId: '-1000000000000',
      cooldownMs: 0,
      timeoutMs: 1000,
    });
    const [result] = await notifier.notifyMarketSignals([signal], Date.now());
    const call = fetchMock.mock.calls[0];
    const text = call ? JSON.parse(String(call[1].body)).text : '';
    vi.unstubAllGlobals();
    return { result, text };
  }

  it('📈 PROYECCIÓN DE MERCADO (POSSIBLE_TOP) llega al transporte', async () => {
    const { result, text } = await sendOne({
      ...base,
      kind: 'POSSIBLE_TOP',
      status: 'EARLY_WARNING',
      headline: 'posible techo',
      identity: 'POSSIBLE_TOP:MERCANTIL:20K:SELL:1',
    } as MarketSignal);
    expect(result.outcome).toBe('SENT');
    expect(text).toMatch(/PROYECCIÓN DE MERCADO/);
  });

  it('🚀 RUPTURA (BREAKOUT_UP confirmado) llega al transporte', async () => {
    const { result, text } = await sendOne({
      ...base,
      kind: 'BREAKOUT_UP',
      status: 'CONFIRMED',
      headline: 'ruptura al alza',
      identity: 'BREAKOUT_UP:MERCANTIL:20K:SELL:1',
    } as MarketSignal);
    expect(result.outcome).toBe('SENT');
    expect(text).toMatch(/RUPTURA/);
  });

  it('🔄 CAMBIO DE TENDENCIA (TREND_CHANGE confirmado) llega al transporte', async () => {
    const { result, text } = await sendOne({
      ...base,
      kind: 'TREND_CHANGE',
      status: 'CONFIRMED',
      headline: 'la tendencia cambió',
      identity: 'TREND_CHANGE:MERCANTIL:20K:SELL:1',
    } as MarketSignal);
    expect(result.outcome).toBe('SENT');
    expect(text).toMatch(/CAMBIO DE TENDENCIA/);
  });

  it('centralStore.ts realmente llama a notifyMarketSignals tras evaluar las señales, no sólo las guarda', () => {
    const store = code('centralStore.ts');
    expect(store).toMatch(/TelegramNotifier\.getInstance\(\)\s*\n\s*\.notifyMarketSignals\(evaluated\.signals, Date\.now\(\)\)/);
  });
});

describe('5. las alertas antiguas NUNCA vuelven a Telegram', () => {
  it('ningún emisor ni plantilla sobrevive para ALERTA DE PRECIO / P2P / VOLATILIDAD', () => {
    for (const file of fs.readdirSync(SERVER)) {
      if (!file.endsWith('.ts')) continue;
      const src = code(file);
      expect(src).not.toMatch(/ALERTA DE PRECIO/);
      expect(src).not.toMatch(/ALERTA P2P/);
      expect(src).not.toMatch(/ALTA VOLATILIDAD/);
    }
    const notifier = code('telegramNotifier.ts');
    expect(notifier).not.toMatch(/formatAlertMessage/);
    expect(notifier).not.toMatch(/notifyAlert\(/);
  });

  it('ninguna oportunidad taker/arbitraje tiene ruta a Telegram', () => {
    const notifier = code('telegramNotifier.ts');
    expect(notifier).not.toMatch(/notifyOpportunityLifecycle/);
    expect(notifier).not.toMatch(/ARBITRAJE|BEST OPPORTUNITY|EXECUTABLE/);
    const store = code('centralStore.ts');
    expect(store).not.toMatch(/notifyOpportunityLifecycle/);
  });

  it('MIS PRECIOS PARA PUBLICAR sigue siendo la única voz maker, cada 30 minutos', () => {
    const alerts = code('makerAlerts.ts');
    expect(alerts).toMatch(/MAKER_SUMMARY_INTERVAL_MS = 30 \* 60 \* 1000/);
  });
});
