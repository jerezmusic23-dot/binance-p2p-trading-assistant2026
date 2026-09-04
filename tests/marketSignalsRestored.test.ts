/**
 * 📈 PROYECCIÓN DE MERCADO · 🚀 RUPTURA · 🔄 CAMBIO DE TENDENCIA — DE VUELTA A TELEGRAM
 * =====================================================================================
 *
 * El propietario reportó que estas tres categorías dejaron de llegar a
 * Telegram. La arquitectura (server/signalEngine.ts -> evaluateSignals,
 * server/telegramNotifier.ts -> formatMarketSignalMessage/notifyMarketSignals,
 * server/centralStore.ts -> announceMakerAlerts/refreshProjections) ya
 * existía y seguía cableada — `tests/telegramSingleSource.test.ts` y
 * `tests/functionalSimulation.test.ts` ya lo comprobaban y seguían en verde.
 *
 * Lo que SÍ se encontró: `persistObservations` y `refreshProjections` vivían
 * al final del mismo try/catch que construye la matriz maker y evalúa sus
 * alertas. Un fallo en CUALQUIER paso anterior de ese try —incluido uno
 * disparado por un solo banco/monto con datos irregulares— abortaba en
 * silencio la persistencia del histórico Y la evaluación de señales para todo
 * ese sondeo, mientras el resumen maker —enviado ANTES del punto de fallo—
 * seguía llegando. Eso explica el patrón exacto reportado: maker sigue
 * funcionando, las tres señales de mercado no. server/centralStore.ts ahora
 * aísla ambas mitades en sus propios try/catch (`refreshMarketSignals`) y
 * aísla cada celda dentro de cada mitad, para que un banco/monto roto nunca
 * silencie a los otros 41.
 *
 * Este fichero fija, con datos sintéticos, que las tres categorías:
 *   - producen el mensaje correcto y la aclaración obligatoria;
 *   - se deduplican (no spam por cada sondeo repetido);
 *   - funcionan a cualquier hora, incluyendo el cruce de medianoche;
 * y que las alertas retiradas (ALERTA DE PRECIO, ALERTA P2P, ALTA
 * VOLATILIDAD, taker/arbitraje) siguen sin poder llegar a Telegram.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_SIGNAL_MEMORY, evaluateSignals } from '../server/signalEngine.js';
import { projectCell } from '../server/makerProjectionEngine.js';
import { TelegramNotifier, formatMarketSignalMessage } from '../server/telegramNotifier.js';
import { observation, ramp, seriesFromBuyPrices, STEP_MS } from './helpers/series.js';
import type { HistoricalObservation } from '../server/historicalMarketStore.js';
import type { MarketSignal } from '../server/signalEngine.js';

const CELL = {
  bank: 'VENEZUELA',
  bankDisplayName: 'Banco de Venezuela',
  amountKey: '10K',
  amountVes: 10_000,
};

function signalsFor(series: HistoricalObservation[], currentBuyPrice: number | null, memory = EMPTY_SIGNAL_MEMORY) {
  const projection = projectCell({ ...CELL, series, currentBuyPrice, currentSellPrice: null });
  return { projection, ...evaluateSignals({ projections: [projection], memory }) };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function notifier(overrides: Partial<{ cooldownMs: number }> = {}) {
  return new TelegramNotifier({
    botToken: '1234567890:TEST-TOKEN-NOT-REAL',
    chatId: '-1000000000000',
    cooldownMs: overrides.cooldownMs ?? 300_000,
    timeoutMs: 1000,
  });
}

/** Every message body actually sent this run. */
function sentTexts(): string[] {
  return fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string).text);
}

/* ════════════════════════════════════════════════════════════════════════
 * 📈 PROYECCIÓN DE MERCADO
 * ════════════════════════════════════════════════════════════════════════ */

describe('📈 proyección de mercado llega a Telegram', () => {
  /* Fondo alcista y giro, igual que tests/topsAndBottoms.test.ts. */
  const wave = [941, 941.5, 942, 942.5, 943, 942.5, 942, 941.5, 941, 941.5, 942, 942.5, 943, 942.5, 942, 941.5, 941];
  const climb = Array.from({ length: 9 }, (_, i) => 941 + (i + 1) * 0.5);
  const top = climb[climb.length - 1];
  const fall = Array.from({ length: 4 }, (_, i) => top - (i + 1) * 0.5);
  const confirmedTopSeries = seriesFromBuyPrices([...wave, ...climb, ...fall]);

  it('un CONFIRMED_TOP produce 📈 PROYECCIÓN DE MERCADO con la aclaración obligatoria', async () => {
    const { signals } = signalsFor(confirmedTopSeries, fall[fall.length - 1]);
    const signal = signals.find((s) => s.kind === 'CONFIRMED_TOP')!;
    expect(signal).toBeDefined();

    const message = formatMarketSignalMessage(signal, 'IMPORTANT', Date.now());
    expect(message).toContain('📈 <b>PROYECCIÓN DE MERCADO</b>');
    expect(message).toContain('No es una orden automática ni una operación garantizada.');
    expect(message).toContain('Una proyección no es un precio de Binance.');

    await notifier().notifyMarketSignals(signals, Date.now());
    expect(sentTexts().some((t) => t.includes('PROYECCIÓN DE MERCADO'))).toBe(true);
  });

  it('la misma proyección confirmada no se reenvía en el siguiente sondeo', async () => {
    const { signals } = signalsFor(confirmedTopSeries, fall[fall.length - 1]);
    const bot = notifier();
    const now = Date.now();

    const first = await bot.notifyMarketSignals(signals, now);
    expect(first.filter((r) => r.outcome === 'SENT')).toHaveLength(1);

    // El siguiente sondeo, 4.5 minutos después, ve la MISMA señal (misma
    // identity, mismo status): no debe generar un segundo mensaje.
    const second = await bot.notifyMarketSignals(signals, now + STEP_MS);
    expect(second.filter((r) => r.outcome === 'SENT')).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 🚀 RUPTURA
 * ════════════════════════════════════════════════════════════════════════ */

describe('🚀 ruptura llega a Telegram, alcista y bajista', () => {
  const wave = [940, 942, 944, 946, 944, 942, 940, 942, 944, 946, 944, 942, 940, 942, 944, 946, 944, 942, 940];

  it('ruptura alcista (BREAKOUT_UP) produce 🚀 RUPTURA', async () => {
    const { signals } = signalsFor(seriesFromBuyPrices([...wave, 952]), 952);
    const signal = signals.find((s) => s.kind === 'BREAKOUT_UP')!;
    expect(signal.status).toBe('CONFIRMED');

    const message = formatMarketSignalMessage(signal, 'CRITICAL', Date.now());
    expect(message).toContain('🚀 <b>RUPTURA</b>');

    await notifier().notifyMarketSignals(signals, Date.now());
    expect(sentTexts().some((t) => t.includes('🚀'))).toBe(true);
  });

  it('ruptura bajista (BREAKOUT_DOWN) produce 🚀 RUPTURA', async () => {
    const { signals } = signalsFor(seriesFromBuyPrices([...wave, 930]), 930);
    const signal = signals.find((s) => s.kind === 'BREAKOUT_DOWN')!;
    expect(signal.status).toBe('CONFIRMED');

    const message = formatMarketSignalMessage(signal, 'CRITICAL', Date.now());
    expect(message).toContain('🚀 <b>RUPTURA</b>');

    await notifier().notifyMarketSignals(signals, Date.now());
    expect(sentTexts().some((t) => t.includes('🚀'))).toBe(true);
  });

  it('una ruptura confirmada que sigue rota no se reenvía en cada sondeo', async () => {
    const bot = notifier();
    const now = Date.now();

    const first = signalsFor(seriesFromBuyPrices([...wave, 952]), 952);
    const firstResult = await bot.notifyMarketSignals(first.signals, now);
    expect(firstResult.filter((r) => r.outcome === 'SENT').length).toBeGreaterThan(0);

    // El precio se mantiene roto: misma identidad de nivel, mismo status.
    const second = signalsFor(seriesFromBuyPrices([...wave, 952, 952.2]), 952.2, first.memory);
    const secondResult = await bot.notifyMarketSignals(second.signals, now + STEP_MS);
    const stillSameBreak = second.signals.find((s) => s.kind === 'BREAKOUT_UP');
    if (stillSameBreak !== undefined) {
      const wasResent = secondResult[second.signals.indexOf(stillSameBreak)];
      expect(wasResent?.outcome).not.toBe('SENT');
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 🔄 CAMBIO DE TENDENCIA
 * ════════════════════════════════════════════════════════════════════════ */

describe('🔄 cambio de tendencia llega a Telegram, en los dos sentidos', () => {
  it('BAJISTA → ALCISTA produce 🔄 CAMBIO DE TENDENCIA', async () => {
    const falling = seriesFromBuyPrices(ramp(950, 940, 25));
    const first = signalsFor(falling, 940);
    expect(first.signals.filter((s) => s.kind === 'TREND_CHANGE')).toEqual([]);

    const rising = seriesFromBuyPrices([...ramp(950, 940, 25), ...ramp(940, 950, 25)]);
    const second = signalsFor(rising, 950, first.memory);
    const change = second.signals.find((s) => s.kind === 'TREND_CHANGE')!;
    expect(change).toBeDefined();
    expect(change.headline).toContain('BEARISH → BULLISH');

    const message = formatMarketSignalMessage(change, 'IMPORTANT', Date.now());
    expect(message).toContain('CAMBIO DE TENDENCIA');

    await notifier().notifyMarketSignals(second.signals, Date.now());
    expect(sentTexts().some((t) => t.includes('CAMBIO DE TENDENCIA'))).toBe(true);
  });

  it('ALCISTA → BAJISTA produce 🔄 CAMBIO DE TENDENCIA', async () => {
    const rising = seriesFromBuyPrices(ramp(940, 950, 25));
    const first = signalsFor(rising, 950);
    expect(first.memory.lastTrend['VENEZUELA:10K:BUY']).toBe('BULLISH');

    const falling = seriesFromBuyPrices([...ramp(940, 950, 25), ...ramp(950, 940, 25)]);
    const second = signalsFor(falling, 940, first.memory);
    const change = second.signals.find((s) => s.kind === 'TREND_CHANGE')!;
    expect(change).toBeDefined();
    expect(change.headline).toContain('BULLISH → BEARISH');

    const message = formatMarketSignalMessage(change, 'IMPORTANT', Date.now());
    expect(message).toContain('CAMBIO DE TENDENCIA');

    await notifier().notifyMarketSignals(second.signals, Date.now());
    expect(sentTexts().some((t) => t.includes('CAMBIO DE TENDENCIA'))).toBe(true);
  });

  it('el mismo cambio de tendencia no se reenvía dos veces', async () => {
    const falling = seriesFromBuyPrices(ramp(950, 940, 25));
    const first = signalsFor(falling, 940);
    const rising = seriesFromBuyPrices([...ramp(950, 940, 25), ...ramp(940, 950, 25)]);
    const second = signalsFor(rising, 950, first.memory);

    const bot = notifier();
    const now = Date.now();
    const firstSend = await bot.notifyMarketSignals(second.signals, now);
    expect(firstSend.filter((r) => r.outcome === 'SENT').length).toBeGreaterThan(0);

    const secondSend = await bot.notifyMarketSignals(second.signals, now + STEP_MS);
    expect(secondSend.filter((r) => r.outcome === 'SENT')).toHaveLength(0);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * 24/7: CUALQUIER HORA, INCLUIDO EL CRUCE DE MEDIANOCHE
 * ════════════════════════════════════════════════════════════════════════ */

describe('las tres señales funcionan a cualquier hora, sin ventana artificial', () => {
  /** Venezuela es UTC-4 todo el año: HH:00 local = (HH+4):00 UTC. */
  const veneMs = (y: number, m: number, d: number, hour: number) => Date.UTC(y, m, d, hour + 4, 0, 0);

  it('genera una ruptura confirmada anclada exactamente a medianoche (00:00 Venezuela)', () => {
    const wave = [940, 942, 944, 946, 944, 942, 940, 942, 944, 946, 944, 942, 940, 942, 944, 946, 944, 942, 940];
    const start = veneMs(2026, 7, 2, 0); // 00:00 Venezuela del 2 de agosto
    const series = wave.map((price, i) =>
      observation({ timestamp: start + i * STEP_MS, buyRecommendedPrice: price, sellRecommendedPrice: price + 5 })
    );
    series.push(observation({ timestamp: start + wave.length * STEP_MS, buyRecommendedPrice: 952, sellRecommendedPrice: 957 }));

    const { signals } = signalsFor(series, 952);
    expect(signals.find((s) => s.kind === 'BREAKOUT_UP')).toBeDefined();
  });

  it('una ruptura que cruza 23:00 → 00:00 → 01:00 se detecta igual que dentro de un mismo día', () => {
    const wave = [940, 942, 944, 946, 944, 942, 940, 942, 944, 946, 944, 942, 940, 942, 944, 946, 944, 942, 940];
    // Arranca a las 23:00 del día 1: con STEP_MS (4.5 min) por muestra, la
    // serie entera cruza 23:00 -> 00:00 -> 01:00 del día 2 sin que el motor
    // necesite saberlo - no agrupa por día, sólo mira la secuencia temporal.
    const start = veneMs(2026, 7, 1, 23);
    const series = wave.map((price, i) =>
      observation({ timestamp: start + i * STEP_MS, buyRecommendedPrice: price, sellRecommendedPrice: price + 5 })
    );
    series.push(observation({ timestamp: start + wave.length * STEP_MS, buyRecommendedPrice: 930, sellRecommendedPrice: 935 }));

    const { signals } = signalsFor(series, 930);
    const breakout = signals.find((s) => s.kind === 'BREAKOUT_DOWN');
    expect(breakout).toBeDefined();
    expect(breakout!.status).toBe('CONFIRMED');

    // Y el mensaje se construye igual, sin ningún error por cruzar el día.
    const message = formatMarketSignalMessage(breakout!, 'CRITICAL', start + wave.length * STEP_MS);
    expect(message).toContain('🚀 <b>RUPTURA</b>');
  });

  it('un cambio de tendencia detectado a la 01:00 (después de cruzar medianoche) llega a Telegram', async () => {
    const start = veneMs(2026, 7, 1, 23); // empieza a las 23:00
    const falling = ramp(950, 940, 25).map((price, i) =>
      observation({ timestamp: start + i * STEP_MS, buyRecommendedPrice: price, sellRecommendedPrice: price + 5 })
    );
    const first = signalsFor(falling, 940);

    const risingPrices = [...ramp(950, 940, 25), ...ramp(940, 950, 25)];
    const rising = risingPrices.map((price, i) =>
      observation({ timestamp: start + i * STEP_MS, buyRecommendedPrice: price, sellRecommendedPrice: price + 5 })
    );
    const second = signalsFor(rising, 950, first.memory);
    const change = second.signals.find((s) => s.kind === 'TREND_CHANGE');
    expect(change).toBeDefined();

    await notifier().notifyMarketSignals(second.signals, start + risingPrices.length * STEP_MS);
    expect(sentTexts().some((t) => t.includes('CAMBIO DE TENDENCIA'))).toBe(true);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * LO QUE SIGUE BLOQUEADO
 * ════════════════════════════════════════════════════════════════════════ */

describe('las alertas retiradas siguen sin poder llegar a Telegram', () => {
  it('ninguna de las tres señales de mercado puede hablar el vocabulario taker/retirado', () => {
    const banned = ['ALERTA DE PRECIO', 'ALERTA P2P', 'ALTA VOLATILIDAD', 'ARBITRAJE', 'OPORTUNIDAD DE ARBITRAJE'];
    const signal: MarketSignal = {
      kind: 'CONFIRMED_TOP',
      status: 'CONFIRMED',
      bank: 'VENEZUELA',
      bankDisplayName: 'Banco de Venezuela',
      amountKey: '10K',
      amountVes: 10_000,
      side: 'BUY',
      sideLabel: 'MI VENTA DE USDT',
      headline: 'techo confirmado',
      evidence: ['la serie giró ahí antes'],
      confidence: 'HIGH',
      sampleSize: 40,
      currentPrice: 945,
      projectedLow: 943,
      projectedHigh: 947,
      watchStartHour: 16,
      watchEndHour: 17,
      identity: 'CONFIRMED_TOP:VENEZUELA:10K:BUY:945',
    };
    const message = formatMarketSignalMessage(signal, 'IMPORTANT', Date.now());
    for (const term of banned) expect(message).not.toContain(term);
  });
});
