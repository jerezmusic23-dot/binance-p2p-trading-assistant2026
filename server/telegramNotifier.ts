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

import {
  AlertRule,
  AlertTriggerLog,
  MarketSnapshot,
  Opportunity,
  OpportunityPhase,
  TelegramSystemAlert,
} from './types.js';

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
    `Referencia compra (lado Binance BUY): <b>${escapeHtml(recompra.toFixed(2))} VES</b>`,
    `Referencia venta (lado Binance SELL): <b>${escapeHtml(venta.toFixed(2))} VES</b>`,
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
    /*
     * Both legs name the Binance side they came from. "Recompra" alone reads
     * as the advertiser's action to anyone thinking in ad direction, which is
     * exactly the inversion this wording exists to prevent.
     */
    `COMPRA arbitraje (lado Binance BUY): <b>${n(opportunity.buyPrice)} VES</b>`,
    `VENTA arbitraje (lado Binance SELL): <b>${n(opportunity.sellPrice)} VES</b>`,
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

/**
 * Identity of an opportunity POSITION: one bank, one amount.
 *
 * Deliberately NOT keyed on the prices. Prices move on every poll, so a
 * price-keyed identity would treat each tick as a brand new opportunity and
 * defeat the very deduplication it looks like it provides. The position is
 * what opens, moves and closes; the prices are what it currently shows.
 */
export function opportunityIdentity(opportunity: Opportunity): string {
  return `${opportunity.bank}|${opportunity.amountVes}`;
}

/**
 * The lifecycle message for a position.
 *
 * DETECTED once, UPDATED while it stays open and the cooldown allows, CLOSED
 * when it leaves the book. The reader can follow one position instead of
 * receiving the same paragraph every few seconds.
 */
export function formatOpportunityLifecycleMessage(
  phase: OpportunityPhase,
  opportunity: Opportunity,
  timestamp: number,
  capturedAt?: number | null
): string {
  const n = (value: number, decimals = 2) => escapeHtml(value.toFixed(decimals));
  const signed = (value: number, decimals = 2) =>
    `${value >= 0 ? '+' : ''}${escapeHtml(value.toFixed(decimals))}`;

  if (phase === 'CLOSED') {
    return [
      '✅ <b>OPORTUNIDAD CERRADA</b>',
      '',
      'USDT/VES',
      '',
      `Banco: <b>${escapeHtml(opportunity.bank)}</b>`,
      `Monto: <b>${escapeHtml(opportunity.amountVes.toLocaleString('es-VE'))} VES</b>`,
      '',
      'Esta operación ya no está en el libro con las condiciones anteriores.',
      '',
      `Hora: ${formatVenezuelaClock(timestamp)}`,
    ].join('\n');
  }

  /*
   * Each leg states the ECONOMICS first, then the Binance side, then the API
   * parameter. In that order on purpose: "what this does to my money" is the
   * part that cannot be misread, and it is what the reader needs before the
   * technical label. tradeType is printed last, and only because someone
   * verifying against the API by hand needs it.
   */
  const lines = [
    phase === 'DETECTED'
      ? '🟢 <b>OPORTUNIDAD DE ARBITRAJE</b>'
      : '🔄 <b>OPORTUNIDAD ACTUALIZADA</b>',
    '',
    'USDT/VES',
    '',
    '<b>COMPRA USDT</b> (entrada)',
    'Fuente: Binance ASK · anuncio que vende USDT',
    'tradeType/API: BUY',
    `Precio: <b>${n(opportunity.buyPrice)} VES</b>`,
    '',
    '<b>VENTA USDT</b> (salida)',
    'Fuente: Binance BID · anuncio que compra USDT',
    'tradeType/API: SELL',
    `Precio: <b>${n(opportunity.sellPrice)} VES</b>`,
    '',
    `SPREAD: <b>${signed(opportunity.spreadAbsolute)} VES</b>`,
    `RENDIMIENTO: <b>${signed(opportunity.marginPct, 4)}%</b>`,
    '',
    /*
     * Both legs are the SAME bank by construction: a purchase at one bank and
     * a sale at another is not an operation anyone can execute, so the
     * executability engine never pairs across banks. Printed twice because
     * that is what makes the constraint visible.
     */
    `Banco compra: <b>${escapeHtml(opportunity.bank)}</b>`,
    `Banco venta: <b>${escapeHtml(opportunity.bank)}</b>`,
    `Monto: <b>${escapeHtml(opportunity.amountVes.toLocaleString('es-VE'))} VES</b>`,
    '',
    // Absent liquidity is never printed as a number.
    opportunity.buyAvailableUsdt !== null
      ? `Liquidez compra: <b>${n(opportunity.buyAvailableUsdt)} USDT</b>`
      : 'Liquidez compra: no verificable',
    opportunity.sellAvailableUsdt !== null
      ? `Liquidez venta: <b>${n(opportunity.sellAvailableUsdt)} USDT</b>`
      : 'Liquidez venta: no verificable',
  ];

  if (capturedAt !== null && capturedAt !== undefined && Number.isFinite(capturedAt)) {
    const ageSeconds = Math.max(0, Math.round((timestamp - capturedAt) / 1000));
    lines.push(`Antiguedad del dato: ${escapeHtml(String(ageSeconds))}s`);
  } else {
    lines.push('Antiguedad del dato: no verificable');
  }

  lines.push(
    '',
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
 * The system-condition message.
 *
 * These are the alerts that fire when the bot stops being able to SEE the
 * market. Without them an outage is indistinguishable from a quiet market:
 * both produce no opportunity messages.
 */
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
  /** Positions currently announced as open, so CLOSED can be detected. */
  private readonly openOpportunities = new Map<string, number>();
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
    this.openOpportunities.clear();
  }

  /** Positions currently held open, for assertions and diagnostics. */
  public openOpportunityKeys(): string[] {
    return [...this.openOpportunities.keys()];
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
   * Announces an opportunity position by phase.
   *
   * DETECTED the first time the position appears - never suppressed by the
   * cooldown, because the first sighting is the message that matters. UPDATED
   * while it stays open, and only once per cooldown window. Passing null means
   * no position is open, which closes whatever was.
   *
   * Only VERIFIED / EXECUTABLE opportunities reach here; a strategic median is
   * not a position and has no lifecycle.
   */
  public async notifyOpportunityLifecycle(
    opportunity: Opportunity | null,
    timestamp: number,
    capturedAt?: number | null
  ): Promise<TelegramResult> {
    try {
      if (!this.config) return { outcome: 'DISABLED' };
      const now = timestamp || Date.now();

      if (opportunity === null) {
        return await this.closeOpenOpportunities(now);
      }

      /*
       * Two independent guards, both required.
       *
       * selectBestOpportunity already refuses anything that is not VERIFIED or
       * whose margin is not strictly positive, so in the normal path these
       * never fire. They are here because this method is public: a future
       * caller handing it any Opportunity must not be able to announce a loss,
       * or an operation whose liquidity could not be established, as something
       * to execute. Break-even is excluded too - zero before Binance
       * commission, transfer fees and slippage is a loss once they are paid.
       */
      if (opportunity.verification !== 'VERIFIED') {
        return { outcome: 'UNCHANGED' };
      }
      if (!(opportunity.marginPct > 0)) {
        return { outcome: 'UNCHANGED' };
      }

      const identity = opportunityIdentity(opportunity);

      /* A different position opened: the previous one is no longer current. */
      for (const key of this.openOpportunities.keys()) {
        if (key !== identity) {
          await this.closeOpportunity(key, now);
        }
      }

      const isNew = !this.openOpportunities.has(identity);
      const phase: OpportunityPhase = isNew ? 'DETECTED' : 'UPDATED';
      const cooldownKeyForPosition = `opportunity:${identity}`;

      if (!isNew) {
        const previous = this.lastSentAt.get(cooldownKeyForPosition);
        if (previous !== undefined && now - previous < this.config.cooldownMs) {
          this.openOpportunities.set(identity, now);
          return { outcome: 'COOLDOWN' };
        }
      }

      this.openOpportunities.set(identity, now);
      this.lastSentAt.set(cooldownKeyForPosition, now);
      this.prune(now);

      return await this.send(
        formatOpportunityLifecycleMessage(phase, opportunity, now, capturedAt)
      );
    } catch (err) {
      console.warn(`[Telegram] Unexpected notifier error: ${this.describe(err)}`);
      return { outcome: 'NETWORK_ERROR', detail: this.describe(err) };
    }
  }

  /** CLOSED for every position still marked open. */
  private async closeOpenOpportunities(now: number): Promise<TelegramResult> {
    const keys = [...this.openOpportunities.keys()];
    if (keys.length === 0) return { outcome: 'UNCHANGED' };

    let last: TelegramResult = { outcome: 'UNCHANGED' };
    for (const key of keys) {
      last = await this.closeOpportunity(key, now);
    }
    return last;
  }

  /**
   * CLOSED is not rate-limited.
   *
   * A position announced as open must always be announced as gone, or the
   * reader is left believing an operation is still on the book. Silence here
   * is the one failure mode this layer must not have.
   */
  private async closeOpportunity(identity: string, now: number): Promise<TelegramResult> {
    this.openOpportunities.delete(identity);
    this.lastSentAt.delete(`opportunity:${identity}`);

    const [bank, amountRaw] = identity.split('|');
    const amountVes = Number(amountRaw);

    return await this.send(
      [
        '✅ <b>OPORTUNIDAD CERRADA</b>',
        '',
        'USDT/VES',
        '',
        `Banco: <b>${escapeHtml(bank)}</b>`,
        `Monto: <b>${escapeHtml(
          Number.isFinite(amountVes) ? amountVes.toLocaleString('es-VE') : amountRaw
        )} VES</b>`,
        '',
        'Esta operación ya no está en el libro con las condiciones anteriores.',
        '',
        `Hora: ${formatVenezuelaClock(now)}`,
      ].join('\n')
    );
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
