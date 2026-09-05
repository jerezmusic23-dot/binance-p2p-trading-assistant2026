import type { MakerMatrixCell } from './makerMatrix.js';
import type { MakerPairing } from './makerRecommendation.js';

export type AlertPriority = 'INFO' | 'WARNING' | 'IMPORTANT' | 'CRITICAL';
export const PRIORITY_ORDER: Record<AlertPriority, number> = { CRITICAL: 0, IMPORTANT: 1, WARNING: 2, INFO: 3 };

export const DEFAULT_PRICE_CHANGE_INTERVAL_MS = 30 * 60 * 1000;
export const MIN_PRICE_CHANGE_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_SIGNAL_INTERVAL_MS = 5 * 60 * 1000;
export const MIN_SIGNAL_INTERVAL_MS = 5 * 60 * 1000;

function readInterval(raw: string | undefined, fallback: number, minimum: number): { intervalMs: number; clamped: boolean } {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return { intervalMs: fallback, clamped: false };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return { intervalMs: fallback, clamped: false };
  if (parsed < minimum) return { intervalMs: minimum, clamped: true };
  return { intervalMs: parsed, clamped: false };
}

export function readSignalInterval(env: NodeJS.ProcessEnv = process.env): { intervalMs: number; clamped: boolean } {
  return readInterval(env.MAKER_SIGNAL_ALERT_INTERVAL_MS, DEFAULT_SIGNAL_INTERVAL_MS, MIN_SIGNAL_INTERVAL_MS);
}

export function readPriceChangeInterval(env: NodeJS.ProcessEnv = process.env): { intervalMs: number; clamped: boolean } {
  return readInterval(env.MAKER_PRICE_CHANGE_ALERT_INTERVAL_MS, DEFAULT_PRICE_CHANGE_INTERVAL_MS, MIN_PRICE_CHANGE_INTERVAL_MS);
}

export interface PendingPriceChange {
  bank: string;
  bankDisplayName: string;
  amountKey: string;
  amountVes: number;
  announcedBuyPrice: number;
  announcedSellPrice: number;
  latestBuyPrice: number;
  latestSellPrice: number;
  firstDetectedAt: number;
  lastDetectedAt: number;
  detections: number;
}

export interface PriceChangeDigestState {
  pending: Record<string, PendingPriceChange>;
  lastReleasedAt: number | null;
}

export const EMPTY_DIGEST_STATE: PriceChangeDigestState = { pending: {}, lastReleasedAt: null };
export function startDigestState(nowMs: number): PriceChangeDigestState { return { pending: {}, lastReleasedAt: nowMs }; }

export interface PriceChangeDigest {
  changes: PendingPriceChange[];
  revertedCells: number;
  releasedAt: number;
  nextReleaseAt: number;
}

function key(bank: string, amountKey: string): string { return `${bank}:${amountKey}`; }

export function accumulatePriceChange(
  state: PriceChangeDigestState,
  change: { cell: MakerMatrixCell; pairing: MakerPairing; previous: { buyPrice: number; sellPrice: number } },
  nowMs: number
): PriceChangeDigestState {
  const cellKey = key(change.cell.bank, change.cell.amountKey);
  const existing = state.pending[cellKey];
  const pending: PendingPriceChange = existing
    ? { ...existing, latestBuyPrice: change.pairing.buy.price, latestSellPrice: change.pairing.sell.price, lastDetectedAt: nowMs, detections: existing.detections + 1 }
    : {
        bank: change.cell.bank,
        bankDisplayName: change.cell.bankDisplayName,
        amountKey: change.cell.amountKey,
        amountVes: change.cell.amountVes,
        announcedBuyPrice: change.previous.buyPrice,
        announcedSellPrice: change.previous.sellPrice,
        latestBuyPrice: change.pairing.buy.price,
        latestSellPrice: change.pairing.sell.price,
        firstDetectedAt: nowMs,
        lastDetectedAt: nowMs,
        detections: 1,
      };
  return { ...state, pending: { ...state.pending, [cellKey]: pending } };
}

export function releasePriceChangeDigest(
  state: PriceChangeDigestState,
  nowMs: number,
  intervalMs: number
): { digest: PriceChangeDigest | null; state: PriceChangeDigestState } {
  const pending = Object.values(state.pending);
  if (pending.length === 0 || (state.lastReleasedAt !== null && nowMs - state.lastReleasedAt < intervalMs)) return { digest: null, state };
  const changes = pending.filter(p => p.announcedBuyPrice !== p.latestBuyPrice || p.announcedSellPrice !== p.latestSellPrice);
  const revertedCells = pending.length - changes.length;
  if (changes.length === 0) return { digest: null, state: { pending: {}, lastReleasedAt: state.lastReleasedAt } };
  changes.sort((a, b) => a.bankDisplayName.localeCompare(b.bankDisplayName) || a.amountVes - b.amountVes);
  return { digest: { changes, revertedCells, releasedAt: nowMs, nextReleaseAt: nowMs + intervalMs }, state: { pending: {}, lastReleasedAt: nowMs } };
}

export function priorityOf(signal: { kind: string; status: 'EARLY_WARNING' | 'CONFIRMED'; bank?: string }): AlertPriority {
  // Telegram market-analysis alerts are intentionally restricted to these two banks.
  // The signal remains available to the interface; INFO is the notifier's non-delivery class.
  if (signal.bank !== undefined && signal.bank !== 'MERCANTIL' && signal.bank !== 'BANCAMIGA') return 'INFO';
  const confirmed = signal.status === 'CONFIRMED';
  switch (signal.kind) {
    case 'BREAKOUT_UP':
    case 'BREAKOUT_DOWN': return confirmed ? 'CRITICAL' : 'IMPORTANT';
    case 'BREAKOUT_INVALIDATED': return 'IMPORTANT';
    case 'TREND_CHANGE': return confirmed ? 'IMPORTANT' : 'WARNING';
    case 'CONFIRMED_TOP':
    case 'CONFIRMED_BOTTOM': return 'IMPORTANT';
    case 'POSSIBLE_TOP':
    case 'POSSIBLE_BOTTOM':
    case 'EXHAUSTION': return 'WARNING';
    case 'ACCUMULATION':
    case 'DISTRIBUTION': return 'INFO';
    default: return confirmed ? 'WARNING' : 'INFO';
  }
}
