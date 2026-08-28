/**
 * WHEN A MESSAGE IS ALLOWED TO LEAVE, AND HOW MANY OF THEM.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Detection and delivery were the same act: the sweep found a changed price
 * and a message went out. With 42 cells and a book that moves, that is a
 * stream, and a stream nobody reads is the same as no alerts at all.
 *
 * So they are now separate concerns. makerAlerts still DETECTS every change
 * the moment it happens - that part must stay immediate, or the record of what
 * changed would be wrong. This module decides when the accumulated changes are
 * worth one message, and merges them into it.
 *
 * THE DEDUPLICATION THAT MATTERS
 *
 * A cell that goes 940.00 -> 940.20 -> 940.10 inside one window produced two
 * detections and zero news: what the operator was last TOLD is 940.00 and what
 * it IS now is 940.10, so the digest reports that one move. A cell that ends
 * the window back where it started is dropped entirely - there is nothing to
 * republish.
 *
 * PURE. No clock, no network. The caller passes the time in.
 */

import type { MakerMatrixCell } from './makerMatrix.js';
import type { MakerPairing } from './makerRecommendation.js';

/**
 * How urgent a message is, which decides whether it waits for the digest.
 *
 *   INFO       a normal price move; it can wait for the periodic summary
 *   WARNING    something changed in the market's behaviour
 *   IMPORTANT  a level that mattered has been reached
 *   CRITICAL   a confirmed break or an exceptional move; sent immediately
 */
export type AlertPriority = 'INFO' | 'WARNING' | 'IMPORTANT' | 'CRITICAL';

export const PRIORITY_ORDER: Record<AlertPriority, number> = {
  CRITICAL: 0,
  IMPORTANT: 1,
  WARNING: 2,
  INFO: 3,
};

/** Default gap between two grouped price-change messages. */
export const DEFAULT_PRICE_CHANGE_INTERVAL_MS = 30 * 60 * 1000;

/**
 * The shortest interval the operator may configure.
 *
 * Below this the digest stops being a digest: at 5 minutes a moving market
 * produces twelve messages an hour, which is the stream this module exists to
 * prevent. Stated as a floor rather than enforced silently - readInterval
 * reports when it clamps.
 */
export const MIN_PRICE_CHANGE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How often a projection signal may reach Telegram AT ALL, across the matrix.
 *
 * ITS OWN INTERVAL, not the generic alert cooldown, and that distinction was
 * measured rather than assumed. Bound to the 5-minute cooldown, a three-hour
 * scripted market produced 18 signal messages - and every one of them was the
 * same reading about the same bank, arriving once per amount tier, because the
 * six tiers of a bank track substantially the same book. The floor was working;
 * five minutes was simply the wrong granularity for "do I need to look now?".
 *
 * Thirty minutes matches the summary and the price digest, so the bot has one
 * rhythm rather than three.
 */
export const DEFAULT_SIGNAL_INTERVAL_MS = 30 * 60 * 1000;
export const MIN_SIGNAL_INTERVAL_MS = 15 * 60 * 1000;

export function readSignalInterval(env: NodeJS.ProcessEnv = process.env): {
  intervalMs: number;
  clamped: boolean;
} {
  return readInterval(
    env.MAKER_SIGNAL_ALERT_INTERVAL_MS,
    DEFAULT_SIGNAL_INTERVAL_MS,
    MIN_SIGNAL_INTERVAL_MS
  );
}

/** Shared parsing: a bad value falls back, a short one clamps and says so. */
function readInterval(
  raw: string | undefined,
  fallback: number,
  minimum: number
): { intervalMs: number; clamped: boolean } {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return { intervalMs: fallback, clamped: false };

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return { intervalMs: fallback, clamped: false };
  if (parsed < minimum) return { intervalMs: minimum, clamped: true };
  return { intervalMs: parsed, clamped: false };
}

export function readPriceChangeInterval(env: NodeJS.ProcessEnv = process.env): {
  intervalMs: number;
  clamped: boolean;
} {
  const raw = env.MAKER_PRICE_CHANGE_ALERT_INTERVAL_MS?.trim();
  if (raw === undefined || raw === '') {
    return { intervalMs: DEFAULT_PRICE_CHANGE_INTERVAL_MS, clamped: false };
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { intervalMs: DEFAULT_PRICE_CHANGE_INTERVAL_MS, clamped: false };
  }
  if (parsed < MIN_PRICE_CHANGE_INTERVAL_MS) {
    return { intervalMs: MIN_PRICE_CHANGE_INTERVAL_MS, clamped: true };
  }
  return { intervalMs: parsed, clamped: false };
}

/** One cell's accumulated movement over the current window. */
export interface PendingPriceChange {
  bank: string;
  bankDisplayName: string;
  amountKey: string;
  amountVes: number;

  /** What the operator was last TOLD. Fixed for the whole window. */
  announcedBuyPrice: number;
  announcedSellPrice: number;
  /** What it is NOW. Overwritten by every detection in the window. */
  latestBuyPrice: number;
  latestSellPrice: number;

  firstDetectedAt: number;
  lastDetectedAt: number;
  /** How many times this cell moved inside the window. */
  detections: number;
}

export interface PriceChangeDigestState {
  pending: Record<string, PendingPriceChange>;
  /** null until the first digest goes out. */
  lastReleasedAt: number | null;
}

export const EMPTY_DIGEST_STATE: PriceChangeDigestState = {
  pending: {},
  lastReleasedAt: null,
};

/**
 * The digest state a running process should start from.
 *
 * WHY THIS EXISTS. With lastReleasedAt null, releasePriceChangeDigest fires as
 * soon as it has anything at all - which on a fresh process means the sweep
 * after boot, roughly 45 seconds in. Measured on a scripted market, that put a
 * digest on the wire at t+0m45s, right behind the boot summary that had just
 * listed every one of those prices, and it did so again on every restart.
 *
 * The operator asked for the opposite shape:
 *   13:00 -> digest, 13:01-13:29 -> accumulate, 13:30 -> next digest
 * so the window is anchored at start-up and the first digest is due one whole
 * interval later. Nothing is lost by waiting: the boot summary already carried
 * every current price, and a "what changed since then" message covering the
 * previous 45 seconds had nothing to add.
 *
 * EMPTY_DIGEST_STATE is kept for the pure tests, which construct their own
 * timeline and need the unanchored form.
 */
export function startDigestState(nowMs: number): PriceChangeDigestState {
  return { pending: {}, lastReleasedAt: nowMs };
}

export interface PriceChangeDigest {
  changes: PendingPriceChange[];
  /** Cells that moved and came back: counted, not reported as changes. */
  revertedCells: number;
  releasedAt: number;
  nextReleaseAt: number;
}

function key(bank: string, amountKey: string): string {
  return `${bank}:${amountKey}`;
}

/**
 * Folds one detected change into the window.
 *
 * The FIRST detection for a cell fixes `announced` - that is the number the
 * operator last saw, and later moves inside the same window do not change what
 * they were told, only what is true now.
 */
export function accumulatePriceChange(
  state: PriceChangeDigestState,
  change: {
    cell: MakerMatrixCell;
    pairing: MakerPairing;
    previous: { buyPrice: number; sellPrice: number };
  },
  nowMs: number
): PriceChangeDigestState {
  const cellKey = key(change.cell.bank, change.cell.amountKey);
  const existing = state.pending[cellKey];

  const pending: PendingPriceChange = existing
    ? {
        ...existing,
        latestBuyPrice: change.pairing.buy.price,
        latestSellPrice: change.pairing.sell.price,
        lastDetectedAt: nowMs,
        detections: existing.detections + 1,
      }
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

/**
 * Releases the window's changes as one digest, or nothing.
 *
 * The first window releases as soon as it has something to say; after that,
 * only once the interval has elapsed. A cell whose price came back to where it
 * was is dropped: two detections that cancel are not news, and reporting
 * "942.10 → 942.10" would be worse than silence.
 */
export function releasePriceChangeDigest(
  state: PriceChangeDigestState,
  nowMs: number,
  intervalMs: number
): { digest: PriceChangeDigest | null; state: PriceChangeDigestState } {
  const pending = Object.values(state.pending);
  if (pending.length === 0) return { digest: null, state };

  if (state.lastReleasedAt !== null && nowMs - state.lastReleasedAt < intervalMs) {
    return { digest: null, state };
  }

  const changes = pending.filter(
    (p) =>
      p.announcedBuyPrice !== p.latestBuyPrice || p.announcedSellPrice !== p.latestSellPrice
  );
  const revertedCells = pending.length - changes.length;

  // Everything cancelled out: the window is cleared and nothing is sent.
  if (changes.length === 0) {
    return {
      digest: null,
      state: { pending: {}, lastReleasedAt: state.lastReleasedAt },
    };
  }

  /* Grouped by bank, then by amount, so the message reads like the matrix. */
  changes.sort(
    (a, b) =>
      a.bankDisplayName.localeCompare(b.bankDisplayName) ||
      a.amountVes - b.amountVes
  );

  return {
    digest: {
      changes,
      revertedCells,
      releasedAt: nowMs,
      nextReleaseAt: nowMs + intervalMs,
    },
    state: { pending: {}, lastReleasedAt: nowMs },
  };
}

/* ------------------------------------------------------------------------ *
 * PRIORITY OF A MARKET SIGNAL
 * ------------------------------------------------------------------------ */

/**
 * How urgent a signal is.
 *
 * Derived from what the signal IS, never from how interesting it looks. A
 * confirmed break of a level the series built is the only thing that skips the
 * queue; everything else waits its turn behind the cooldown.
 */
export function priorityOf(signal: {
  kind: string;
  status: 'EARLY_WARNING' | 'CONFIRMED';
}): AlertPriority {
  const confirmed = signal.status === 'CONFIRMED';

  switch (signal.kind) {
    case 'BREAKOUT_UP':
    case 'BREAKOUT_DOWN':
      return confirmed ? 'CRITICAL' : 'IMPORTANT';
    /*
     * An invalidation is IMPORTANT, not CRITICAL: it cancels a decision rather
     * than demanding a new one, and it must not be able to interrupt as often
     * as a genuine break.
     */
    case 'BREAKOUT_INVALIDATED':
      return 'IMPORTANT';
    case 'TREND_CHANGE':
      return confirmed ? 'IMPORTANT' : 'WARNING';
    case 'CONFIRMED_TOP':
    case 'CONFIRMED_BOTTOM':
      return 'IMPORTANT';
    case 'POSSIBLE_TOP':
    case 'POSSIBLE_BOTTOM':
    case 'EXHAUSTION':
      return 'WARNING';
    case 'ACCUMULATION':
    case 'DISTRIBUTION':
      return 'INFO';
    default:
      return confirmed ? 'WARNING' : 'INFO';
  }
}
