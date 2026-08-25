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

import { AlertRule, AlertTriggerLog, MarketSnapshot, Opportunity } from './types.js';

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

/**
 * Deduplication key: alert type plus the condition that defines it.
 *
 * Two rules with the same condition, side and threshold say the same thing, so
 * they share a key and only one message goes out per cooldown window.
 */
export function cooldownKey(rule: AlertRule): string {
  return `${rule.condition}|${rule.targetSide}|${rule.targetValue}`;
}

function marketLabel(snapshot: MarketSnapshot | null): string {
  if (!snapshot) return 'USDT/VES';
  return `${snapshot.asset}/${snapshot.fiat}`;
}

/**
 * The strategic level both sides of the operation sit at, when it is known.
 *
 * RECOMPRA is Binance BUY (what I pay), VENTA is Binance SELL (what I
 * receive). Printed so the recipient can see WHERE the market is, not only
 * that a threshold was crossed. Omitted entirely when a side is missing -
 * an absent price is never shown as 0 or as a plausible number.
 */
function strategicLines(snapshot: MarketSnapshot | null): string[] {
  const recompra = snapshot?.strategicBuyPrice;
  const venta = snapshot?.strategicSellPrice;
  if (recompra === null || recompra === undefined || venta === null || venta === undefined) {
    return [];
  }
  return [
    '',
    `Recompra (BUY): <b>${escapeHtml(recompra.toFixed(2))} VES</b>`,
    `Venta (SELL): <b>${escapeHtml(venta.toFixed(2))} VES</b>`,
  ];
}

/**
 * The BEST_OPPORTUNITY message.
 *
 * Reports ONE real operation: a bank, an amount, an executable repurchase and
 * an executable sale. Nothing here comes from the raw extremes of the book, so
 * an isolated 980 VES ad cannot produce this message.
 *
 * The margin is stated as GROSS on purpose. Binance commission, bank transfer
 * fees, slippage and rounding are not modelled anywhere in this project, so
 * calling it profit would be inventing a number.
 */
export function formatOpportunityMessage(
  opportunity: Opportunity,
  rule: AlertRule,
  timestamp: number,
  /** When the book behind this operation was captured. Omitted if unknown. */
  capturedAt?: number | null
): string {
  const n = (value: number, decimals = 2) => escapeHtml(value.toFixed(decimals));

  const lines = [
    '🚨 <b>BEST OPPORTUNITY</b>',
    '',
    `Banco: <b>${escapeHtml(opportunity.bank)}</b>`,
    `Monto: <b>${escapeHtml(opportunity.amountVes.toLocaleString('es-VE'))} VES</b>`,
    '',
    `Recompra (BUY): <b>${n(opportunity.buyPrice)} VES</b>`,
    `Venta (SELL): <b>${n(opportunity.sellPrice)} VES</b>`,
    '',
    `Spread: <b>${n(opportunity.spreadPct, 4)}%</b>`,
    `Margen BRUTO: <b>${n(opportunity.marginAbsolute)} VES por USDT</b>`,
  ];

  // Absent liquidity is never printed as a number.
  if (opportunity.availableUsdt !== null) {
    lines.push(`Liquidez: <b>${n(opportunity.availableUsdt)} USDT</b>`);
  } else {
    lines.push('Liquidez: no verificable');
  }

  /*
   * The opportunity comes from the bank-matrix cache, which can be up to 45s
   * old. Stating the age lets the reader judge whether the prices are still
   * on the book. Printed only when a real capture timestamp exists - never
   * invented, and never shown as 0 when unknown.
   */
  if (capturedAt !== null && capturedAt !== undefined && Number.isFinite(capturedAt)) {
    const ageSeconds = Math.max(0, Math.round((timestamp - capturedAt) / 1000));
    lines.push(`Antiguedad del dato: ${escapeHtml(String(ageSeconds))}s`);
  } else {
    lines.push('Antiguedad del dato: no verificable');
  }

  lines.push(
    '',
    `Umbral: ${escapeHtml(rule.targetValue.toFixed(4))}%`,
    `Estado: ${escapeHtml(opportunity.verification)} / EXECUTABLE`,
    '',
    'MARGEN BRUTO: no descuenta comision de Binance,',
    'transferencia bancaria, slippage, redondeos',
    'ni otros costes operativos. NO es beneficio neto.',
    '',
    `Hora: ${formatVenezuelaClock(timestamp)}`
  );

  return lines.join('\n');
}

/**
 * Builds the message body.
 *
 * Only values that actually exist are printed. Nothing is invented, and no
 * metric is renamed into something it is not - notably VOLATILITY_SPIKE is
 * evaluated against the spread, so the message says "spread", not "volatility
 * index".
 */
export function formatAlertMessage(
  trigger: AlertTriggerLog,
  rule: AlertRule,
  snapshot: MarketSnapshot | null,
  opportunity?: Opportunity | null,
  capturedAt?: number | null
): string {
  const time = formatVenezuelaClock(trigger.timestamp);

  /*
   * An opportunity alert reports the operation, never the market aggregate.
   * Without the opportunity there is nothing truthful to say, so no message
   * is fabricated from the snapshot instead.
   */
  if (rule.condition === 'OPPORTUNITY_ABOVE') {
    if (!opportunity) {
      return [
        '🚨 <b>BEST OPPORTUNITY</b>',
        '',
        'La alerta se disparo pero la oportunidad ya no esta disponible.',
        'No se reporta ningun precio: el dato falta.',
        '',
        `Hora: ${time}`,
      ].join('\n');
    }
    return formatOpportunityMessage(opportunity, rule, trigger.timestamp, capturedAt);
  }
  const market = escapeHtml(marketLabel(snapshot));
  /*
   * FASE 2: the STRATEGIC spread, the same number the rule was evaluated on.
   * spreadPercentage is the raw |max(SELL) - min(BUY)| figure and is what
   * reported 6.64% while the market sat at 0.14%. Reporting one number and
   * deciding on another is how the 980 VES ad became an alert.
   */
  const spread = snapshot?.strategicSpreadPct;

  if (rule.condition === 'SPREAD_ABOVE') {
    return [
      '🔴 <b>ALERTA P2P</b>',
      '',
      `Spread estratégico: <b>${spread !== null && spread !== undefined ? escapeHtml(spread.toFixed(2)) : '--'}%</b>`,
      `Umbral: ${escapeHtml(rule.targetValue.toFixed(2))}%`,
      '',
      `Mercado: ${market}`,
      ...strategicLines(snapshot),
      '',
      'Tipo: Spread estratégico (mediana VENTA vs mediana RECOMPRA)',
      'Estado: ACTIVADO',
      '',
      `Hora: ${time}`,
    ].join('\n');
  }

  if (rule.condition === 'VOLATILITY_SPIKE') {
    const lines = [
      '⚠️ <b>ALTA VOLATILIDAD</b>',
      '',
      'Se detectó alta volatilidad',
      'en el libro de órdenes Binance P2P.',
      '',
    ];
    // The rule compares the spread against targetValue * 1.5. Report exactly
    // that, so the number in the message matches what was measured.
    if (spread !== null && spread !== undefined) {
      lines.push(`Spread estratégico medido: <b>${escapeHtml(spread.toFixed(2))}%</b>`);
      lines.push(`Umbral efectivo: ${escapeHtml((rule.targetValue * 1.5).toFixed(2))}%`);
      lines.push('');
    }
    lines.push(`Mercado: ${market}`, ...strategicLines(snapshot), '', `Hora: ${time}`);
    return lines.join('\n');
  }

  // ABOVE / BELOW price alerts.
  const above = rule.condition === 'ABOVE';
  return [
    `${above ? '🟢' : '🔻'} <b>ALERTA DE PRECIO</b>`,
    '',
    `Precio estratégico ${escapeHtml(rule.targetSide)}: <b>${escapeHtml(trigger.price.toFixed(2))} VES</b>`,
    `Umbral: ${escapeHtml(rule.targetValue.toFixed(2))} VES`,
    '',
    `Mercado: ${market}`,
    ...strategicLines(snapshot),
    '',
    `Tipo: ${above ? 'Precio por encima del umbral' : 'Precio por debajo del umbral'}`,
    'Estado: ACTIVADO',
    '',
    `Hora: ${time}`,
  ].join('\n');
}

export class TelegramNotifier {
  private static instance: TelegramNotifier | null = null;

  private readonly lastSentAt = new Map<string, number>();
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

  /**
   * Forwards a triggered alert. Never rejects and never throws.
   *
   * The caller treats this as fire-and-forget; the returned promise exists so
   * tests can await the outcome.
   */
  public async notifyAlert(
    trigger: AlertTriggerLog,
    rule: AlertRule,
    snapshot: MarketSnapshot | null,
    opportunity?: Opportunity | null,
    capturedAt?: number | null
  ): Promise<TelegramResult> {
    try {
      if (!this.config) return { outcome: 'DISABLED' };

      const key = cooldownKey(rule);
      const now = trigger.timestamp || Date.now();
      const previous = this.lastSentAt.get(key);

      if (previous !== undefined && now - previous < this.config.cooldownMs) {
        return { outcome: 'COOLDOWN' };
      }

      /*
       * The attempt is recorded BEFORE sending, on purpose: if Telegram is
       * down or rate-limiting, we must not retry on every poll. A failed
       * message is skipped until the next cooldown window rather than
       * hammering the API.
       */
      this.lastSentAt.set(key, now);
      this.prune(now);

      return await this.send(formatAlertMessage(trigger, rule, snapshot, opportunity, capturedAt));
    } catch (err) {
      // Belt and braces: nothing above should throw, and if it somehow does,
      // the alert loop still must not notice.
      console.warn(`[Telegram] Unexpected notifier error: ${this.describe(err)}`);
      return { outcome: 'NETWORK_ERROR', detail: this.describe(err) };
    }
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

  /** Keeps the cooldown map bounded; rules are few but the map is long-lived. */
  private prune(now: number): void {
    if (!this.config) return;
    const horizon = Math.max(this.config.cooldownMs * 10, 3_600_000);
    for (const [key, at] of this.lastSentAt) {
      if (now - at > horizon) this.lastSentAt.delete(key);
    }
  }
}
