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
import type { MakerAlert } from './makerAlerts.js';
import type { MarketSignal } from './signalEngine.js';
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
  /*
   * NAMED BY THE LISTING AND THE ADVERTISER'S ACTION, never as "my" purchase
   * or sale.
   *
   * These lines used to read "Referencia compra (lado Binance BUY)". For a
   * maker that is backwards: the tradeType=BUY listing holds the ads I compete
   * with when I SELL, so calling it my compra points the reader at the wrong
   * book. What is true of it without any reference to me is that it contains
   * ads whose advertisers are selling USDT, and that is what it now says.
   *
   * This is a market level, not a price to publish. The price to publish is
   * the maker summary's business and never appears in a rule alert.
   */
  return [
    '',
    `Mediana del listado BUY (anuncios que VENDEN USDT): <b>${escapeHtml(
      recompra.toFixed(2)
    )} VES</b>`,
    `Mediana del listado SELL (anuncios que COMPRAN USDT): <b>${escapeHtml(
      venta.toFixed(2)
    )} VES</b>`,
    'Nivel de mercado, no un precio para publicar.',
  ];
}

/*
 * formatOpportunityMessage and formatOpportunityLifecycleMessage USED TO LIVE
 * HERE, and both are gone.
 *
 * They wrote the taker's model onto the operator's phone: "OPORTUNIDAD DE
 * ARBITRAJE", legs labelled COMPRA/VENTA USDT sourced from "Binance ASK" and
 * "Binance BID", and the API parameter printed underneath - tradeType BUY under
 * COMPRA, tradeType SELL under VENTA. For a MAKER that mapping is inverted:
 * my BUY ad competes in the tradeType=SELL listing, not the BUY one. Anyone
 * acting on those messages was reading the wrong book.
 *
 * The taker engine still exists and still feeds the executable matrix screen,
 * which asks a different and legitimate question. What it no longer has is a
 * route to Telegram. Telegram now has exactly one source of truth: the maker
 * layer, below.
 */
export function formatAlertMessage(
  trigger: AlertTriggerLog,
  rule: AlertRule,
  snapshot: MarketSnapshot | null
): string {
  const time = formatVenezuelaClock(trigger.timestamp);

  /*
   * OPPORTUNITY_ABOVE used to be handled here, reporting the taker engine's
   * BEST_OPPORTUNITY. It is gone: that rule is refused before it reaches this
   * function (see CentralMarketStore.evaluateAlerts), so no arbitrage figure
   * can reach Telegram through a user rule. The condition survives in the
   * AlertRule type because it is present in stored rule files, and silently
   * rewriting somebody's saved rules is not this phase's business.
   *
   * What remains here are MARKET rules over the strategic medians. They report
   * the level of the book, never an operation, and never a price to publish.
   */
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
 * 🔔 CAMBIO DE PRECIO PARA PUBLICAR.
 *
 * Sent ONLY when the number the operator would type into the ad form is
 * different from the one they were last told. A leader that moved without
 * moving the recommendation produces nothing, and so does a change of
 * position, of advertised volume or of who is in the ladder.
 */
export function formatMakerPriceChangeMessage(
  cell: MakerMatrixCell,
  pairing: MakerPairing,
  previous: { buyPrice: number; sellPrice: number },
  timestamp: number
): string {
  const n = (value: number) => escapeHtml(value.toFixed(2));

  return [
    '🔔 <b>CAMBIO DE PRECIO PARA PUBLICAR</b>',
    '',
    `🏦 ${escapeHtml(cell.bankDisplayName)}`,
    `💰 Filtro: ${escapeHtml(cell.amountKey)} (${escapeHtml(
      cell.amountVes.toLocaleString('es-VE')
    )} VES)`,
    '',
    '🟢 <b>COMPRA USDT</b>',
    `Antes: ${n(previous.buyPrice)}`,
    `Ahora: <b>${n(pairing.buy.price)}</b>`,
    `Posición estimada: #${escapeHtml(String(pairing.buy.position))}`,
    '',
    '🔵 <b>VENTA USDT</b>',
    `Antes: ${n(previous.sellPrice)}`,
    `Ahora: <b>${n(pairing.sell.price)}</b>`,
    `Posición estimada: #${escapeHtml(String(pairing.sell.position))}`,
    '',
    `📊 Nuevo margen: <b>${signedVes(pairing.grossMarginVes)} VES/USDT</b>`,
    pairing.grossMarginPct !== null
      ? `📈 Margen: <b>${signedVes(pairing.grossMarginPct, 4)}%</b>`
      : '📈 Margen: no verificable',
    '',
    '⚠️ MARGEN BRUTO POTENCIAL. No es una operación garantizada.',
    'La posición es una ESTIMACIÓN.',
    '',
    `Hora: ${formatVenezuelaClock(timestamp)}`,
  ].join('\n');
}

/*
 * formatMakerDisplacedMessage USED TO LIVE HERE and is gone.
 *
 * It announced that an announced price had lost POSITION - somebody moved
 * ahead of it. That is the wrong trigger: the operator's ad does not need
 * republishing because a rival appeared, it needs republishing when the price
 * they should be charging is different. A leader can move, a rival can
 * disappear, volume can change and positions can shuffle without the
 * publishable price moving one cent, and each of those produced a message.
 *
 * formatMakerPriceChangeMessage above replaces it, driven by the only thing
 * the operator can act on: the number changed.
 */

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
export function formatMarketSignalMessage(signal: MarketSignal, timestamp: number): string {
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

  /**
   * Forwards a triggered alert. Never rejects and never throws.
   *
   * The caller treats this as fire-and-forget; the returned promise exists so
   * tests can await the outcome.
   */
  public async notifyAlert(
    trigger: AlertTriggerLog,
    rule: AlertRule,
    snapshot: MarketSnapshot | null
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

      return await this.send(formatAlertMessage(trigger, rule, snapshot));
    } catch (err) {
      // Belt and braces: nothing above should throw, and if it somehow does,
      // the alert loop still must not notice.
      console.warn(`[Telegram] Unexpected notifier error: ${this.describe(err)}`);
      return { outcome: 'NETWORK_ERROR', detail: this.describe(err) };
    }
  }

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

    for (const signal of signals) {
      try {
        const dedupKey = `signal:${signal.identity}:${signal.status}`;
        if (this.lastSentAt.has(dedupKey)) {
          results.push({ outcome: 'UNCHANGED' });
          continue;
        }

        const cellKey = `signal:cell:${signal.bank}:${signal.amountKey}`;
        const previous = this.lastSentAt.get(cellKey);
        if (previous !== undefined && now - previous < this.config.cooldownMs) {
          results.push({ outcome: 'COOLDOWN' });
          continue;
        }

        this.lastSentAt.set(dedupKey, now);
        this.lastSentAt.set(cellKey, now);
        this.prune(now);

        results.push(await this.send(formatMarketSignalMessage(signal, now)));
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
   * Puts the maker layer's output on the wire. THE ONLY MARKET EMITTER LEFT.
   *
   * SUMMARY is the periodic picture. It is never suppressed by a cooldown -
   * evaluateMakerAlerts already decides when it is due, on its own 30-minute
   * clock, and a second gate here would silently skip one. A summary that does
   * not fit one Telegram message is split on bank boundaries and sent as a
   * short deterministic sequence, never as one message per cell.
   *
   * PRICE_CHANGE is rate-limited PER CELL and deduplicated by the pair of
   * prices it announces: the same change re-derived on a later sweep sends
   * nothing, and a busy cell cannot drown out the other 41.
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
        if (alert.kind === 'SUMMARY') {
          for (const message of formatMakerSummaryMessages(alert.matrix, now)) {
            results.push(await this.send(message));
          }
          continue;
        }

        const cell = alert.cell;
        /*
         * Dedup key carries the prices, so re-announcing the same move is a
         * no-op; cooldown key carries only the cell, so a cell that keeps
         * moving is throttled rather than repeated.
         */
        const dedupKey = `maker:price:${cell.bank}:${cell.amountKey}:${alert.pairing.buy.price}:${alert.pairing.sell.price}`;
        if (this.lastSentAt.has(dedupKey)) {
          results.push({ outcome: 'UNCHANGED' });
          continue;
        }

        const cooldownKeyForCell = `maker:cell:${cell.bank}:${cell.amountKey}`;
        const previous = this.lastSentAt.get(cooldownKeyForCell);
        if (previous !== undefined && now - previous < this.config.cooldownMs) {
          results.push({ outcome: 'COOLDOWN' });
          continue;
        }

        this.lastSentAt.set(dedupKey, now);
        this.lastSentAt.set(cooldownKeyForCell, now);
        this.prune(now);

        results.push(
          await this.send(
            formatMakerPriceChangeMessage(cell, alert.pairing, alert.previous, now)
          )
        );
      } catch (err) {
        console.warn(`[Telegram] Unexpected notifier error: ${this.describe(err)}`);
        results.push({ outcome: 'NETWORK_ERROR', detail: this.describe(err) });
      }
    }

    return results;
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
