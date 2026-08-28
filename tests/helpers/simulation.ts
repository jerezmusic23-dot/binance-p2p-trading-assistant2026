/**
 * A HARNESS FOR DRIVING THE WHOLE ROBOT AND COUNTING WHAT COMES OUT.
 *
 * Unit tests answer "is this function right". They cannot answer the question
 * that matters here - "what happens when 42 cells all behave correctly at the
 * same time for two hours" - and every noise defect this project has had was
 * of exactly that shape: correct per cell, unusable in aggregate.
 *
 * So this boots the real store with Binance and Telegram stubbed, runs a
 * scripted market for a chosen number of sweeps, and returns the counts:
 *
 *     capturas -> observaciones -> señales -> mensajes de Telegram
 *
 * Nothing here is evidence about the real market. The books are scripted and
 * say only what the wiring does with them.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { makeAdItem, makeBinanceResponse } from './fixtures.js';

/** The price of the two listings at a given sweep. */
export interface ScriptedBook {
  /** Ads under tradeType=BUY: my SELL rivals. */
  buyListing: number;
  /** Ads under tradeType=SELL: my BUY rivals. */
  sellListing: number;
}

export type MessageStream = 'SUMMARY' | 'PRICE_DIGEST' | 'SIGNAL' | 'SYSTEM' | 'OTHER';

export interface SentMessage {
  /** Milliseconds of simulated time since the store was started. */
  atMs: number;
  stream: MessageStream;
  heading: string;
  text: string;
}

/** Which emitter a body came from, decided by what only that emitter writes. */
export function classify(text: string): MessageStream {
  if (text.includes('MIS PRECIOS PARA PUBLICAR')) return 'SUMMARY';
  if (text.includes('CAMBIOS DE PRECIOS')) return 'PRICE_DIGEST';
  if (text.includes('<b>Evidencia</b>')) return 'SIGNAL';
  if (/BINANCE|DATOS DESACTUALIZADOS|STORAGE/.test(text)) return 'SYSTEM';
  return 'OTHER';
}

/** Gaps in minutes between consecutive messages of one stream. */
export function gapsMinutes(timeline: SentMessage[], stream: MessageStream): number[] {
  const times = timeline.filter((m) => m.stream === stream).map((m) => m.atMs);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 60_000);
  return gaps;
}

export interface SimulationResult {
  sweeps: number;
  /** Requests that carried transAmount: the bank-matrix sweep. */
  matrixRequests: number;
  /** Observations stored for the reference cell. */
  observations: number;
  /**
   * What the engine did internally, before any delivery gate.
   *
   * Telegram counts alone cannot distinguish a quiet market from a loud one
   * being suppressed correctly. These are the denominators.
   */
  internal: { sweeps: number; priceChangesDetected: number; signalsDerived: number };
  /** Signals the engine produced on the final evaluation. */
  finalSignals: string[];
  /** Every Telegram body, in order. */
  messages: string[];
  /**
   * Every message with the simulated instant it left, and which stream it
   * belongs to.
   *
   * COUNTS ALONE CANNOT ANSWER "does 30 minutes mean 30 minutes". Three
   * emitters each honouring their own half-hour still put a message on the
   * phone every few minutes if their clocks are not aligned, and that is
   * indistinguishable from a broken interval unless the instants are recorded.
   */
  timeline: SentMessage[];
  /** Messages grouped by their first line. */
  byHeading: Record<string, number>;
  counts: {
    summary: number;
    priceDigest: number;
    signal: number;
    system: number;
    takerVocabulary: number;
  };
}

/**
 * Runs one scripted market.
 *
 * `book(sweep)` is called once per full matrix sweep and decides both
 * listings. The MIRROR IS APPLIED BY THE STORE, not here: `sellListing` holds
 * my BUY rivals because they live under tradeType=SELL, and a harness that
 * pre-swapped them would hide the very inversion these tests guard.
 */
export async function simulateMarket(params: {
  book: (sweep: number) => ScriptedBook;
  /** Matrix sweeps to run. Each is 45 seconds of simulated time. */
  sweeps: number;
  /** Price-change digest interval. Default: the production default. */
  priceChangeIntervalMs?: number;
  /** Which cell's series is reported back. */
  referenceBank?: string;
  referenceAmount?: string;
  /**
   * Run inside an EXISTING directory instead of a fresh one, and leave it in
   * place afterwards.
   *
   * This is how a restart is simulated honestly: the process is new - modules
   * reset, singletons rebuilt, every in-memory clock back to zero - while the
   * history on disk is the one the previous run wrote. Two runs in two
   * different temporary directories are not a restart, they are two first
   * boots, and they cannot show whether coming back produces a burst.
   */
  dataDir?: string;
}): Promise<SimulationResult> {
  const reusing = params.dataDir !== undefined;
  const tmpDir = params.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-sim-'));
  fs.mkdirSync(tmpDir, { recursive: true });
  const originalCwd = process.cwd();
  process.chdir(tmpDir);

  process.env.TELEGRAM_BOT_TOKEN = '1234567890:TEST-TOKEN-NOT-REAL';
  process.env.TELEGRAM_CHAT_ID = '-1001234567890';
  if (params.priceChangeIntervalMs !== undefined) {
    process.env.MAKER_PRICE_CHANGE_ALERT_INTERVAL_MS = String(params.priceChangeIntervalMs);
  } else {
    delete process.env.MAKER_PRICE_CHANGE_ALERT_INTERVAL_MS;
  }

  const messages: string[] = [];
  const timeline: SentMessage[] = [];
  let startedAt = 0;
  let binanceCalls = 0;
  let matrixRequests = 0;

  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
    const href = String(url);
    if (href.includes('api.telegram.org')) {
      const text = JSON.parse(String(init.body)).text as string;
      messages.push(text);
      timeline.push({
        atMs: Date.now() - startedAt,
        stream: classify(text),
        heading: text.split('\n')[0].replace(/<[^>]+>/g, '').trim(),
        text,
      });
      return new Response('{"ok":true}', { status: 200 });
    }

    const body = JSON.parse(String(init.body));
    const isMatrix = body.transAmount !== undefined && body.transAmount !== null;
    if (isMatrix) matrixRequests += 1;

    // 7 banks x 2 sides per sweep for the rotated tier.
    const sweep = Math.floor(binanceCalls / 14);
    binanceCalls += 1;
    const prices = params.book(sweep);
    const price = body.tradeType === 'BUY' ? prices.buyListing : prices.sellListing;

    const ads = [
      makeAdItem({
        advNo: `${body.tradeType}-1`,
        price: price.toFixed(2),
        min: '1000',
        max: '200000',
        surplus: '5000',
        tradable: '5000',
        tradeMethods: [{ payType: 'BancoDeVenezuela', tradeMethodName: 'BDV' }],
      }),
      // A second ad a quarter of a VES away, so a ladder and a tick exist.
      makeAdItem({
        advNo: `${body.tradeType}-2`,
        price: (price + (body.tradeType === 'BUY' ? 1.25 : -1.25)).toFixed(2),
        min: '1000',
        max: '200000',
        surplus: '5000',
        tradable: '5000',
        tradeMethods: [{ payType: 'BancoDeVenezuela', tradeMethodName: 'BDV' }],
      }),
    ];
    return new Response(JSON.stringify(makeBinanceResponse(ads)), { status: 200 });
  });

  vi.useFakeTimers();
  vi.resetModules();
  const { CentralMarketStore } = await import('../../server/centralStore.js');
  const { HistoricalMarketStore } = await import('../../server/historicalMarketStore.js');

  const store = CentralMarketStore.getInstance();
  startedAt = Date.now();
  store.start();
  // Boot snapshot plus the 2s full sweep.
  await vi.advanceTimersByTimeAsync(3_000);
  await vi.advanceTimersByTimeAsync(45_000 * params.sweeps);

  const bank = params.referenceBank ?? 'VENEZUELA';
  const amount = params.referenceAmount ?? '10K';
  const observations = HistoricalMarketStore.load(bank, amount).length;
  const internal = store.getEventCounters();
  const finalSignals = store.getProjections().signals.map((s) => `${s.kind}:${s.status}`);

  store.stop();

  const byHeading: Record<string, number> = {};
  for (const message of messages) {
    const heading = message.split('\n')[0].replace(/<[^>]+>/g, '').trim();
    byHeading[heading] = (byHeading[heading] ?? 0) + 1;
  }

  const counts = {
    summary: messages.filter((m) => m.includes('MIS PRECIOS PARA PUBLICAR')).length,
    priceDigest: messages.filter((m) => m.includes('CAMBIOS DE PRECIOS')).length,
    signal: messages.filter((m) => m.includes('<b>Evidencia</b>')).length,
    system: messages.filter((m) => /BINANCE|DATOS DESACTUALIZADOS|STORAGE/.test(m)).length,
    takerVocabulary: messages.filter((m) =>
      /ARBITRAJE|OPORTUNIDAD DE|EXECUTABLE|Binance ASK|Binance BID|tradeType\/API/.test(m)
    ).length,
  };

  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.chdir(originalCwd);
  if (!reusing) fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.MAKER_PRICE_CHANGE_ALERT_INTERVAL_MS;

  return {
    sweeps: params.sweeps,
    matrixRequests,
    observations,
    internal,
    finalSignals,
    messages,
    timeline,
    byHeading,
    counts,
  };
}

/* ---------------------------------------------------------------------- *
 * SCRIPTED MARKETS
 *
 * My BUY rivals live under tradeType=SELL, so `sellListing` is the lower of
 * the two - it is the book of people buying USDT. Written out rather than
 * abstracted, because this is the mapping every scenario depends on.
 * ---------------------------------------------------------------------- */

const BUY_BASE = 945.25;
const SELL_BASE = 940.75;

/** Goes nowhere: a small deterministic wobble around a fixed level. */
export const lateralMarket = (sweep: number): ScriptedBook => {
  const wobble = [0, 0.02, 0, -0.02][sweep % 4];
  return { buyListing: BUY_BASE + wobble, sellListing: SELL_BASE + wobble };
};

/** Climbs steadily. */
export const risingMarket = (sweep: number): ScriptedBook => ({
  buyListing: BUY_BASE + sweep * 0.05,
  sellListing: SELL_BASE + sweep * 0.05,
});

/** Falls steadily. */
export const fallingMarket = (sweep: number): ScriptedBook => ({
  buyListing: BUY_BASE - sweep * 0.05,
  sellListing: SELL_BASE - sweep * 0.05,
});

/** Oscillates between two levels, so floors and ceilings exist. */
export const rangingMarket = (sweep: number): ScriptedBook => {
  const cycle = [0, 0.5, 1, 1.5, 2, 1.5, 1, 0.5][sweep % 8];
  return { buyListing: BUY_BASE + cycle, sellListing: SELL_BASE + cycle };
};

/** Ranges, then breaks out and stays out. */
export const breakoutMarket = (sweep: number): ScriptedBook => {
  if (sweep < 40) return rangingMarket(sweep);
  const push = (sweep - 40) * 0.3;
  return { buyListing: BUY_BASE + 2 + push, sellListing: SELL_BASE + 2 + push };
};

/** Ranges, breaks out briefly, and falls back inside: a false break. */
export const falseBreakoutMarket = (sweep: number): ScriptedBook => {
  if (sweep < 40) return rangingMarket(sweep);
  if (sweep < 46) {
    const push = (sweep - 40) * 0.5;
    return { buyListing: BUY_BASE + 2 + push, sellListing: SELL_BASE + 2 + push };
  }
  return rangingMarket(sweep);
};

/** Climbs, then turns and falls: a genuine reversal. */
export const reversingMarket = (sweep: number): ScriptedBook => {
  const half = 40;
  const level = sweep < half ? sweep * 0.05 : (half - (sweep - half)) * 0.05;
  return { buyListing: BUY_BASE + level, sellListing: SELL_BASE + level };
};

/** Changes the publishable price on a handful of sweeps, then holds. */
export const steppingMarket = (sweep: number): ScriptedBook => {
  const step = Math.min(4, Math.floor(sweep / 3)) * 0.2;
  return { buyListing: BUY_BASE + step, sellListing: SELL_BASE + step };
};

/** Moves away and comes back to exactly where it started. */
export const roundTripMarket = (sweep: number): ScriptedBook => {
  const path = [0, 0.2, 0.1, 0];
  const offset = path[Math.min(path.length - 1, Math.floor(sweep / 3))];
  return { buyListing: BUY_BASE + offset, sellListing: SELL_BASE + offset };
};
