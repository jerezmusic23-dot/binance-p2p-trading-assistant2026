/**
 * Telegram notification layer.
 *
 * This is a NOTIFIER, not part of the analysis engine. It reads an alert that
 * the existing engine already decided to fire and forwards it. It never
 * computes, changes or re-evaluates anything about the market, and a failure
 * here can never affect capture, analysis, persistence or the dashboard.
 *
 * Design constraints:
 *  - No dependencies: Node's built-in fetch, nothing else.
 *  - Never throws. Every path returns a result object.
 *  - Never logs the bot token or the chat id, including inside error text
 *    (a fetch error can embed the request URL, which contains the token).
 *  - Starts disabled and silent when credentials are absent.
 */

import { TelegramSystemAlert } from './types.js';
import type { MakerAlert } from './makerAlerts.js';
import type { MarketSignal } from './signalEngine.js';
import {
  PRIORITY_ORDER,
  priorityOf,
  readSignalInterval,
  type AlertPriority,
  type PriceChangeDigest,
} from './alertScheduler.js';
import type { MakerMatrix, MakerMatrixCell } from './makerMatrix.js';
import type { MakerPairing } from './makerRecommendation.js';

/**
 * Default gap between two Telegram messages for the same alert type.
 *
 * Matches the 5-minute per-rule cooldown that CentralMarketStore.evaluateAlerts
 * already enforces, so by default this layer never contradicts the engine: it
 * is a second line of defence that also covers two distinct rules producing the
 * same alert, and any future change to the polling cadence.
 */
export const DEFAULT_ALERT_COOLDOWN_MS = 300_000;

/** Short by design: a hung request must not hold up the alert loop. */
export const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Floor between two messages about the same system condition.
 *
 * A system alert is already gated on the condition CHANGING, so this only
 * bounds flapping: a capture that drops in and out at the poll rate would
 * otherwise announce every flip. Fifteen minutes is long enough to collapse a
 * flapping outage into one message and short enough that a genuine second
 * outage an hour later is still reported.
 */
export const DEFAULT_SYSTEM_ALERT_COOLDOWN_MS = 900_000;

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  cooldownMs: number;
  timeoutMs: number;
}

export type TelegramOutcome =
  | 'SENT'
  | 'DISABLED'
  | 'COOLDOWN'
  /**
   * The condition has not changed since the last message about it.
   *
   * Distinct from COOLDOWN on purpose: COOLDOWN means "something new, too
   * soon"; UNCHANGED means "nothing new at all". A six-second poll of a
   * two-hour outage produces UNCHANGED 1200 times and sends once.
   */
  | 'UNCHANGED'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR';

export interface TelegramResult {
  outcome: TelegramOutcome;
  /** Human-readable detail, already redacted. Never contains credentials. */
  detail?: string;
}

/**
 * Reads configuration from the environment.
 * Returns null when either credential is missing - that is the disabled state,
 * not an error.
 */
export function readTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();

  if (!botToken || !chatId) return null;

  const parsedCooldown = Number(env.TELEGRAM_ALERT_COOLDOWN_MS);
  const cooldownMs =
    Number.isFinite(parsedCooldown) && parsedCooldown >= 0
      ? parsedCooldown
      : DEFAULT_ALERT_COOLDOWN_MS;

  return { botToken, chatId, cooldownMs, timeoutMs: DEFAULT_TIMEOUT_MS };
}

/** Escapes the five characters Telegram's HTML parse mode cares about. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strips credentials from any text before it reaches a log.
 *
 * Needed because a failed fetch commonly reports the request URL, and the
 * Telegram URL carries the bot token in its path.
 */
export function redactSecrets(text: string, config: TelegramConfig | null): string {
  if (!config) return text;
  return text
    .split(config.botToken)
    .join('<redacted-token>')
    .split(config.chatId)
    .join('<redacted-chat-id>');
}

/** Wall-clock time in Venezuela, e.g. "23:51:31". */
export function formatVenezuelaClock(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString('es-VE', {
      timeZone: 'America/Caracas',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return new Date(timestamp).toISOString().slice(11, 19);
  }
}

/*
 * cooldownKey, marketLabel, strategicLines and formatAlertMessage USED TO LIVE
 * HERE, and all four are gone.
 *
 * formatAlertMessage was the only producer of the rule-alert family:
 *   🟢/🔻 ALERTA DE PRECIO   (conditions ABOVE / BELOW)
 *   🔴 ALERTA P2P            (condition SPREAD_ABOVE)
 *   ⚠️ ALTA VOLATILIDAD      (condition VOLATILITY_SPIKE)
 *
 * They announced that a MARKET LEVEL had crossed a number. For a maker that is
 * not a decision: the level of the book says nothing about what to publish, at
 * which bank, for which amount, or whether the pairing clears break-even. The
 * operator asked for the whole class to stop - not to be renamed, downgraded to
 * a WARNING, or re-emitted through another route - so the producer is deleted
 * rather than muted, and with it the three helpers that had no other caller.
 *
 * WHAT SURVIVES, deliberately: the alert RULES themselves. /api/alerts and
 * src/AlertsManager.tsx let the operator create, list and delete rules and read
 * the trigger history, and CentralMarketStore.evaluateAlerts still evaluates
 * them and still persists AlertTriggerLog. That is an in-app history panel the
 * operator opens on purpose. What no longer exists anywhere in this file is a
 * function that can turn one of those triggers into a Telegram message.
 *
 * tests/telegramNoPriceAlert.test.ts holds this shut structurally.
 */


/**
 * Telegram refuses a message longer than this. Splitting is deterministic and
 * happens on BANK boundaries - never per cell, which would be 42 messages.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Absent numbers are words. A price that was not derived is never printed. */
const vesPrice = (value: number | null): string =>
  value === null ? 'no verificable' : escapeHtml(value.toFixed(2));

const signedVes = (value: number, decimals = 2): string =>
  `${value >= 0 ? '+' : ''}${escapeHtml(value.toFixed(decimals))}`;

/**
 * What a cell says when it has no price to publish.
 *
 * Each state gets its own words. None of them is a number, and none of them
 * is an invented tick: a cell whose price step was never observed says so,
 * rather than quietly becoming leader + 0.01.
 */
function cellStateLine(cell: MakerMatrixCell): string {
  const rec = cell.recommendation;
  const tickUnknown =
    rec !== null &&
    (rec.buyAnalysis.tickProvenance === 'NOT_VERIFIABLE' ||
      rec.sellAnalysis.tickProvenance === 'NOT_VERIFIABLE');

  if (tickUnknown) return '⚠️ PRECIO NO VERIFICABLE';

  switch (cell.status) {
    case 'NO_MARGIN':
      return '⚪ Sin margen positivo';
    case 'FETCH_FAILED':
      return '⚠️ Binance no respondió';
    case 'STALE':
      return '⚠️ Dato antiguo';
    default:
      return '⚪ Sin datos';
  }
}

/** One cell, in the compact block the operator reads on a phone. */
function summaryCellBlock(cell: MakerMatrixCell): string[] {
  const pair = cell.recommendation?.recommended ?? null;
  const lines = [`💰 ${escapeHtml(cell.amountKey)}`];

  if (pair === null) {
    lines.push(cellStateLine(cell), '');
    return lines;
  }

  lines.push(
    `🟢 Compra: <b>${escapeHtml(pair.buy.price.toFixed(2))}</b>  (#${escapeHtml(
      String(pair.buy.position)
    )})`,
    `🔵 Venta: <b>${escapeHtml(pair.sell.price.toFixed(2))}</b>  (#${escapeHtml(
      String(pair.sell.position)
    )})`,
    `💵 Margen: <b>${signedVes(pair.grossMarginVes)} VES</b>${
      pair.grossMarginPct !== null ? ` · ${signedVes(pair.grossMarginPct, 4)}%` : ''
    }`,
    ''
  );
  return lines;
}

/**
 * 🟢 MIS PRECIOS PARA PUBLICAR — the whole BANCO x MONTO picture.
 *
 * Returns ONE message whenever it fits, and otherwise as few as it takes,
 * split on bank boundaries so a bank is never cut in half. Never one message
 * per cell: 7 banks x 6 amounts is 42 notifications nobody would read.
 *
 * This is not an opportunity feed. It answers "if I publish an ad right now,
 * what price does it carry" for every bank and amount, and says plainly where
 * it has no answer.
 */
export function formatMakerSummaryMessages(
  matrix: MakerMatrix,
  timestamp: number
): string[] {
  const header = [
    '🟢 <b>MIS PRECIOS PARA PUBLICAR</b>',
    '',
    `⏱ Capturado hace ${escapeHtml(String(matrix.ageSeconds))}s`,
    `👥 Compitiendo contra ${
      matrix.config.publisherFilter === 'ALL'
        ? 'todos los anunciantes'
        : matrix.config.publisherFilter === 'MERCHANT_ONLY'
        ? 'sólo comerciantes'
        : 'sólo no comerciantes'
    }`,
    `📊 Profundidad TOP ${escapeHtml(String(matrix.config.ladderDepth))}`,
    matrix.stale ? '⚠️ DATO ANTIGUO' : '',
    '',
  ].filter((line) => line !== '');

  const footer = [
    '━━━━━━━━━━━━━━━━━━',
    '',
    '⚠️ <b>MARGEN BRUTO POTENCIAL</b>',
    '',
    'No es una operación garantizada.',
    'No incluye comisiones, transferencias,',
    'slippage ni otros costos.',
    '',
    `Hora: ${formatVenezuelaClock(timestamp)}`,
  ];

  /* One block per bank, built whole so a split can never cut one apart. */
  const bankBlocks: string[][] = [];
  for (const bank of matrix.bankOrder) {
    const row = matrix.cells[bank];
    if (row === undefined) continue;

    const block = [
      '━━━━━━━━━━━━━━━━━━',
      '',
      `🏦 <b>${escapeHtml(matrix.bankDisplayNames[bank] ?? bank)}</b>`,
      '',
    ];
    for (const amountKey of matrix.amountKeys) {
      const cell = row[amountKey];
      if (cell === undefined) continue;
      block.push(...summaryCellBlock(cell));
    }
    bankBlocks.push(block);
  }

  if (bankBlocks.length === 0) {
    return [
      [
        ...header,
        'No hay ninguna celda capturada todavía.',
        '',
        `Hora: ${formatVenezuelaClock(timestamp)}`,
      ].join('\n'),
    ];
  }

  /* Greedy packing over whole banks: deterministic given the same matrix. */
  const parts: string[][] = [];
  let current: string[] = [...header];

  for (const block of bankBlocks) {
    const candidate = [...current, ...block];
    if (
      current.length > header.length &&
      [...candidate, ...footer].join('\n').length > TELEGRAM_MESSAGE_LIMIT
    ) {
      parts.push(current);
      current = [...header, ...block];
    } else {
      current = candidate;
    }
  }
  parts.push(current);

  const total = parts.length;
  return parts.map((part, index) => {
    const marker = total > 1 ? [`(${index + 1}/${total})`, ''] : [];
    return [...part, ...footer, ...marker].join('\n');
  });
}

/**
 * 🔔 CAMBIOS DE PRECIOS PARA PUBLICAR — one message for the whole window.
 *
 * REPLACES formatMakerPriceChangeMessage, which wrote one message per cell.
 * Five cells moving inside half an hour produced five notifications, which is
 * exactly the noise this phase exists to remove.
 *
 * Each line is one cell's NET move over the window: what the operator was last
 * told, and what it is now. Intermediate wobbles are not shown - nobody could
 * have acted on them - though the count is reported when a cell moved more
 * than once, because "this one is unstable" is worth knowing.
 */
export function formatPriceChangeDigestMessage(digest: PriceChangeDigest): string {
  const n = (value: number) => escapeHtml(value.toFixed(2));
  const clock = (ts: number) => formatVenezuelaClock(ts);

  const lines = [
    '🔔 <b>CAMBIOS DE PRECIOS PARA PUBLICAR</b>',
    '',
    `Actualizado: ${clock(digest.releasedAt)}`,
    '',
  ];

  let currentBank: string | null = null;
  for (const change of digest.changes) {
    if (change.bankDisplayName !== currentBank) {
      if (currentBank !== null) lines.push('');
      lines.push(`🏦 <b>${escapeHtml(change.bankDisplayName.toUpperCase())}</b>`);
      currentBank = change.bankDisplayName;
    }

    /* Only the side that actually moved is printed. */
    if (change.announcedBuyPrice !== change.latestBuyPrice) {
      lines.push(
        `${escapeHtml(change.amountKey)} → compra ${n(change.announcedBuyPrice)} → <b>${n(
          change.latestBuyPrice
        )}</b>`
      );
    }
    if (change.announcedSellPrice !== change.latestSellPrice) {
      lines.push(
        `${escapeHtml(change.amountKey)} → venta ${n(change.announcedSellPrice)} → <b>${n(
          change.latestSellPrice
        )}</b>`
      );
    }
    if (change.detections > 1) {
      lines.push(`<i>(${escapeHtml(String(change.detections))} movimientos en la ventana)</i>`);
    }
  }

  lines.push('', `Se detectaron ${escapeHtml(String(digest.changes.length))} cambio(s).`);
  if (digest.revertedCells > 0) {
    // Reported, not hidden: a cell that moved and came back still moved.
    lines.push(
      `${escapeHtml(String(digest.revertedCells))} celda(s) volvieron a su precio anterior.`
    );
  }
  lines.push('', `Próxima revisión automática: ${clock(digest.nextReleaseAt)}`);

  return lines.join('\n');
}

/**
 * 📈 PROYECCIÓN DE MERCADO / 🚨 CAMBIO DE TENDENCIA.
 *
 * A signal explains itself or it does not go out. Every message carries the
 * evidence that produced it, the number of observations behind that evidence,
 * and - loudly - the difference between what the price IS and what the series
 * suggests it might do.
 *
 * NOT AN INSTRUCTION. There is no "publica a", no "compra ahora" and no target.
 * The operator is told what the data shows and decides for themselves.
 */
export function formatMarketSignalMessage(
  signal: MarketSignal,
  priority: AlertPriority,
  timestamp: number
): string {
  const n = (value: number | null): string =>
    value === null ? 'no verificable' : escapeHtml(value.toFixed(2));

  const heading =
    signal.kind === 'TREND_CHANGE'
      ? signal.status === 'CONFIRMED'
        ? '🚨 <b>CAMBIO DE TENDENCIA</b>'
        : '⚠️ <b>POSIBLE CAMBIO DE TENDENCIA</b>'
      : signal.kind === 'BREAKOUT_UP' || signal.kind === 'BREAKOUT_DOWN'
      ? '🚀 <b>RUPTURA</b>'
      : '📈 <b>PROYECCIÓN DE MERCADO</b>';

  const statusLine =
    signal.status === 'CONFIRMED'
      ? 'Estado: <b>CONFIRMADA</b>'
      : 'Estado: <b>SEÑAL PARCIAL · AVISO TEMPRANO</b>';

  const lines = [
    heading,
    '',
    `🏦 ${escapeHtml(signal.bankDisplayName)} · ${escapeHtml(signal.amountKey)}`,
    `${signal.side === 'BUY' ? '🟢' : '🔵'} ${escapeHtml(signal.sideLabel)}`,
    '',
    escapeHtml(signal.headline),
    '',
    statusLine,
    `Prioridad: <b>${escapeHtml(priority)}</b>`,
    `Confianza: <b>${escapeHtml(signal.confidence)}</b> · Muestras: <b>${escapeHtml(
      String(signal.sampleSize)
    )}</b>`,
    '',
    /*
     * ACTUAL first and labelled, then PROYECTADO labelled separately. A band
     * rendered beside a live price with the same wording is how somebody ends
     * up publishing an ad at a number Binance never quoted.
     */
    `ACTUAL (precio para publicar): <b>${n(signal.currentPrice)} VES</b>`,
    signal.projectedLow !== null && signal.projectedHigh !== null
      ? `PROYECTADO (rango observado): <b>${n(signal.projectedLow)} – ${n(signal.projectedHigh)} VES</b>`
      : 'PROYECTADO: no verificable con el histórico disponible',
  ];

  if (signal.watchStartHour !== null && signal.watchEndHour !== null) {
    lines.push(
      '',
      `MIRAR: <b>${escapeHtml(String(signal.watchStartHour).padStart(2, '0'))}:00 – ${escapeHtml(
        String(signal.watchEndHour).padStart(2, '0')
      )}:00</b> (hora de Venezuela)`
    );
  }

  lines.push(
    '',
    '<b>Evidencia</b>',
    ...signal.evidence.map((line) => `· ${escapeHtml(line)}`),
    '',
    'No es una orden automática ni una operación garantizada.',
    'Una proyección no es un precio de Binance.',
    '',
    `Hora: ${formatVenezuelaClock(timestamp)}`
  );

  return lines.join('\n');
}

export function formatSystemAlertMessage(alert: TelegramSystemAlert): string {
  const heading: Record<TelegramSystemAlert['kind'], string> = {
    BINANCE_OFFLINE: '⛔ <b>BINANCE NO DISPONIBLE</b>',
    BINANCE_RECOVERED: '✅ <b>CAPTURA RESTABLECIDA</b>',
    DATA_STALE: '⚠️ <b>DATOS DESACTUALIZADOS</b>',
    STORAGE_ERROR: '🛑 <b>CRITICAL STORAGE ERROR</b>',
  };

  const consequence: Record<TelegramSystemAlert['kind'], string> = {
    BINANCE_OFFLINE:
      'No hay captura de mercado. Los precios mostrados son los ultimos conocidos, ' +
      'no el mercado actual.',
    BINANCE_RECOVERED: 'La captura de Binance P2P vuelve a responder.',
    DATA_STALE:
      'La ultima captura valida supera el umbral. No operar sobre estos precios ' +
      'sin refrescar.',
    STORAGE_ERROR:
      'El historico ha dejado de poder escribirse. Se siguen sirviendo datos en vivo, ' +
      'pero NO se esta acumulando historico y las proyecciones se degradaran.',
  };

  return [
    heading[alert.kind],
    '',
    escapeHtml(alert.detail),
    '',
    consequence[alert.kind],
    '',
    'Procedencia: SYSTEM (no es una señal de mercado).',
    '',
    `Hora: ${formatVenezuelaClock(alert.timestamp)}`,
  ].join('\n');
}

export class TelegramNotifier {
  private static instance: TelegramNotifier | null = null;

  private readonly lastSentAt = new Map<string, number>();
  /** Last state announced per system condition, so an unchanged one stays quiet. */
  private readonly lastSystemState = new Map<string, string>();
  private startupLogged = false;

  constructor(private readonly config: TelegramConfig | null) {}

  /** Process-wide instance, configured from the environment on first use. */
  public static getInstance(): TelegramNotifier {
    if (!TelegramNotifier.instance) {
      TelegramNotifier.instance = new TelegramNotifier(readTelegramConfig());
      TelegramNotifier.instance.logStartupStatus();
    }
    return TelegramNotifier.instance;
  }

  /** Test seam: drops the cached instance. */
  public static resetInstance(): void {
    TelegramNotifier.instance = null;
  }

  /** Test seam: forgets every dedup/cooldown record without rebuilding config. */
  public resetState(): void {
    this.lastSentAt.clear();
    this.lastSystemState.clear();
  }

  public isEnabled(): boolean {
    return this.config !== null;
  }

  /** One line at boot, then silence. Never repeats every 6 seconds. */
  public logStartupStatus(): void {
    if (this.startupLogged) return;
    this.startupLogged = true;

    if (!this.config) {
      console.warn('[Telegram] Notifications disabled: Telegram credentials not configured.');
    } else {
      console.log(
        `[Telegram] Notifications enabled (cooldown ${this.config.cooldownMs}ms, ` +
          `timeout ${this.config.timeoutMs}ms).`
      );
    }
  }

  /*
   * notifyAlert USED TO LIVE HERE, and it is gone.
   *
   * It was the only caller of formatAlertMessage and the only path from an
   * AlertTriggerLog to the wire. Removing the formatter without removing this
   * method would have left a public entry point one line away from being
   * re-wired to some other text, which is exactly the "no vuelva a aparecer por
   * otra ruta" the operator asked to prevent. CentralMarketStore.evaluateAlerts
   * no longer calls anything on this class.
   */

  /**
   * Puts market signals on the wire.
   *
   * DEDUPLICATED BY WHAT THEY SAY. A signal's identity is its kind, cell, side
   * and level - not its timestamp - so the same finding re-derived on the next
   * sweep sends nothing. That is what stops a stable market from producing a
   * message every 45 seconds for as long as the condition holds.
   *
   * COOLDOWN PER CELL, so one cell in a volatile stretch cannot crowd out the
   * other 41.
   */
  public async notifyMarketSignals(
    signals: readonly MarketSignal[],
    timestamp: number
  ): Promise<TelegramResult[]> {
    const results: TelegramResult[] = [];
    if (!this.config) return signals.map(() => ({ outcome: 'DISABLED' as const }));

    const now = timestamp || Date.now();

    /*
     * Most urgent first, so that when the per-cell cooldown allows exactly one
     * message from a cell, the one that gets through is the one that matters.
     * Without this the order would be whatever the engine happened to produce,
     * and a confirmed breakout could be crowded out by an accumulation note.
     */
    const ordered = [...signals].sort(
      (a, b) => PRIORITY_ORDER[priorityOf(a)] - PRIORITY_ORDER[priorityOf(b)]
    );

    /*
     * A CONDITION THAT IS STILL TRUE IS NOT NEWS AGAIN AN HOUR LATER.
     *
     * Dedup keys live in the same map as the cooldowns, and prune() drops
     * anything older than max(cooldownMs * 10, 1h). That is right for a
     * cooldown and wrong for an identity: a breakout that stays broken for two
     * hours had its key aged out and was announced a second time, as
     * BREAKOUT-XYZ all over again. The operator asked for one identity per
     * condition, not one per hour.
     *
     * The caller hands over every signal that is CURRENTLY live on each sweep,
     * so the notifier can tell "still true" from "gone": touching the key of
     * every live signal keeps it fresh for exactly as long as the condition
     * holds. Once the signal stops being derived, its key ages out normally and
     * a genuine recurrence later is announced again, which is correct.
     *
     * Only keys that already exist are touched. This creates nothing and can
     * never suppress a first announcement.
     */
    for (const signal of ordered) {
      const liveKey = `signal:${signal.identity}:${signal.status}`;
      if (this.lastSentAt.has(liveKey)) this.lastSentAt.set(liveKey, now);
    }

    for (const signal of ordered) {
      try {
        const priority = priorityOf(signal);

        /*
         * INFO NEVER REACHES TELEGRAM.
         *
         * Accumulation and distribution are worth knowing and not worth
         * interrupting for: they describe a market drifting, which is exactly
         * what a screen is for. Telegram answers "do I have to look at this
         * now?", and for an INFO signal the answer is no by definition. The
         * signal is still computed, still returned by the API and still
         * rendered - it simply does not ring.
         */
        if (priority === 'INFO') {
          results.push({ outcome: 'UNCHANGED' });
          continue;
        }

        const dedupKey = `signal:${signal.identity}:${signal.status}`;
        if (this.lastSentAt.has(dedupKey)) {
          results.push({ outcome: 'UNCHANGED' });
          continue;
        }

        /*
         * CRITICAL JUMPS THE QUEUE BUT STILL HAS A FLOOR.
         *
         * A confirmed break is worth interrupting for, so it is not held back
         * by a cell's ordinary cooldown. It is NOT exempt from all limits: a
         * live run showed why. In a sustained rise every sweep breaks a new
         * level, so the identity - which carries the level - is different each
         * time and dedup never fires. Twelve cells doing that produced a
         * message every couple of minutes.
         *
         * So CRITICAL has its own per-cell floor. The first break is
         * immediate; the same cell breaking again waits out the cooldown, and
         * the priority sort means the message a cell does get is the most
         * urgent one it had.
         */
        const cellKey =
          priority === 'CRITICAL'
            ? `signal:critical:${signal.bank}:${signal.amountKey}`
            : `signal:cell:${signal.bank}:${signal.amountKey}`;
        const previous = this.lastSentAt.get(cellKey);
        if (previous !== undefined && now - previous < this.config.cooldownMs) {
          results.push({ outcome: 'COOLDOWN' });
          continue;
        }

        /*
         * A GLOBAL FLOOR FOR EVERYTHING BELOW CRITICAL.
         *
         * Per-cell cooldowns bound each cell and say nothing about the total.
         * Measured on a live run: twelve cells each respecting a five-minute
         * floor still produced a message every couple of minutes, which is the
         * noise this whole phase exists to remove.
         *
         * So non-critical signals share ONE window across the entire matrix.
         * The priority sort above decides which one gets it, so what comes
         * through is the most urgent thing the market had to say - not
         * whichever cell happened to be evaluated first. CRITICAL is exempt
         * from this floor, and only from this one.
         */
        const globalKey = priority === 'CRITICAL' ? 'signal:any:critical' : 'signal:any';
        /*
         * CRITICAL gets a shorter global floor, not none.
         *
         * A market-wide move breaks a level in many cells at once, and that is
         * ONE event - not twelve. Without a global floor the same market
         * movement arrived as a dozen notifications, each true and each
         * redundant. Half the cooldown keeps a genuine break prompt while
         * making a simultaneous sweep of them a single message.
         */
        const signalInterval = readSignalInterval().intervalMs;
        const globalFloor = priority === 'CRITICAL' ? signalInterval / 2 : signalInterval;
        const globalPrevious = this.lastSentAt.get(globalKey);
        if (globalPrevious !== undefined && now - globalPrevious < globalFloor) {
          results.push({ outcome: 'COOLDOWN' });
          continue;
        }
        this.lastSentAt.set(globalKey, now);

        this.lastSentAt.set(dedupKey, now);
        this.lastSentAt.set(cellKey, now);
        this.prune(now);

        results.push(await this.send(formatMarketSignalMessage(signal, priority, now)));
      } catch (err) {
        console.warn(`[Telegram] Unexpected notifier error: ${this.describe(err)}`);
        results.push({ outcome: 'NETWORK_ERROR', detail: this.describe(err) });
      }
    }

    return results;
  }

  private async send(text: string): Promise<TelegramResult> {
    if (!this.config) return { outcome: 'DISABLED' };

    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = `HTTP ${response.status}`;
        console.warn(`[Telegram] Failed to send alert: ${detail}`);
        return { outcome: 'HTTP_ERROR', detail };
      }

      console.log('[Telegram] Alert sent successfully');
      return { outcome: 'SENT' };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const detail = isAbort ? `timeout after ${this.config.timeoutMs}ms` : this.describe(err);
      console.warn(`[Telegram] Failed to send alert: ${detail}`);
      return { outcome: isAbort ? 'TIMEOUT' : 'NETWORK_ERROR', detail };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Error text with any credential stripped out. */
  private describe(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return redactSecrets(raw, this.config);
  }

  /**
   * Forwards a system condition. Never rejects and never throws.
   *
   * Gated on the CONDITION changing, not on time alone: a stable outage is
   * announced once. The cooldown is a second gate that only bounds flapping.
   *
   * The state is recorded only when a message is actually attempted, so a
   * transition suppressed by the cooldown is retried on the next poll instead
   * of being lost.
   */
  public async notifySystemAlert(alert: TelegramSystemAlert): Promise<TelegramResult> {
    try {
      if (!this.config) return { outcome: 'DISABLED' };

      const key = `system:${alert.kind}`;
      const now = alert.timestamp || Date.now();

      if (this.lastSystemState.get(key) === alert.state) {
        return { outcome: 'UNCHANGED' };
      }

      const previous = this.lastSentAt.get(key);
      const cooldownMs = Math.max(this.config.cooldownMs, DEFAULT_SYSTEM_ALERT_COOLDOWN_MS);
      if (previous !== undefined && now - previous < cooldownMs) {
        return { outcome: 'COOLDOWN' };
      }

      this.lastSystemState.set(key, alert.state);
      this.lastSentAt.set(key, now);
      this.prune(now);

      return await this.send(formatSystemAlertMessage(alert));
    } catch (err) {
      console.warn(`[Telegram] Unexpected notifier error: ${this.describe(err)}`);
      return { outcome: 'NETWORK_ERROR', detail: this.describe(err) };
    }
  }

  /**
   * Sends the maker alerts a refresh produced.
   *
   * A PUBLISH alert is a new instruction - a bank, an amount and two prices
   * this robot has not asked for before - so it is never suppressed by the
   * cooldown: withholding it would mean withholding the only thing the
   * operator is meant to act on. A DISPLACED alert is about a price already
   * announced and can repeat as the book moves, so it is rate-limited per
   * cell.
   *
   * The caller decides WHAT changed (evaluateMakerAlerts, which is pure). This
   * method only decides whether to put it on the wire.
   */
  /**
   * Sends the periodic maker summary.
   *
   * PRICE_CHANGE NO LONGER PASSES THROUGH HERE. Detection stays immediate -
   * makerAlerts must record a move the moment it happens or the record of what
   * changed would be wrong - but delivery is now the digest's job, released on
   * its own interval by notifyPriceChangeDigest. A changed cell used to become
   * a notification within 45 seconds; now it becomes a line in one message
   * half an hour later, alongside every other cell that moved.
   *
   * The summary itself is never suppressed by a cooldown: evaluateMakerAlerts
   * already decides when it is due on its own 30-minute clock, and a second
   * gate here would silently skip one.
   */
  public async notifyMakerAlerts(
    alerts: readonly MakerAlert[],
    timestamp: number
  ): Promise<TelegramResult[]> {
    const results: TelegramResult[] = [];
    if (!this.config) return alerts.map(() => ({ outcome: 'DISABLED' as const }));

    const now = timestamp || Date.now();

    for (const alert of alerts) {
      try {
        if (alert.kind !== 'SUMMARY') {
          // Accumulated by the caller into the digest; nothing leaves here.
          results.push({ outcome: 'UNCHANGED' });
          continue;
        }
        for (const message of formatMakerSummaryMessages(alert.matrix, now)) {
          results.push(await this.send(message));
        }
      } catch (err) {
        console.warn(`[Telegram] Unexpected notifier error: ${this.describe(err)}`);
        results.push({ outcome: 'NETWORK_ERROR', detail: this.describe(err) });
      }
    }

    return results;
  }

  /**
   * Sends the grouped price-change digest.
   *
   * One message for every cell that moved during the window, whatever their
   * number. Deduplication happened upstream in the accumulator: a cell that
   * returned to its announced price is not in the digest at all.
   */
  public async notifyPriceChangeDigest(digest: PriceChangeDigest): Promise<TelegramResult> {
    try {
      if (!this.config) return { outcome: 'DISABLED' };
      if (digest.changes.length === 0) return { outcome: 'UNCHANGED' };

      this.lastSentAt.set('maker:digest', digest.releasedAt);
      this.prune(digest.releasedAt);

      return await this.send(formatPriceChangeDigestMessage(digest));
    } catch (err) {
      console.warn(`[Telegram] Unexpected notifier error: ${this.describe(err)}`);
      return { outcome: 'NETWORK_ERROR', detail: this.describe(err) };
    }
  }



  /*
   * notifyOpportunityLifecycle, closeOpenOpportunities and closeOpportunity
   * USED TO LIVE HERE, together with the openOpportunities map that tracked
   * which arbitrage position was "open".
   *
   * They were the loudest emitter in the system: driven by the 6-second poll,
   * announcing DETECTED / UPDATED / CLOSED for the taker engine's
   * BEST_OPPORTUNITY. Deleting the call site alone would have left a public
   * method any future caller could pick up again, so the method is gone with
   * it. There is no arbitrage lifecycle to announce any more, because Telegram
   * does not speak that model.
   */

  /** Keeps the cooldown map bounded; rules are few but the map is long-lived. */
  private prune(now: number): void {
    if (!this.config) return;
    const horizon = Math.max(this.config.cooldownMs * 10, 3_600_000);
    for (const [key, at] of this.lastSentAt) {
      if (now - at > horizon) this.lastSentAt.delete(key);
    }
  }
}
