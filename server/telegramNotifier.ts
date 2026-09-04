import { TelegramSystemAlert } from './types.js';
import type { MakerAlert } from './makerAlerts.js';
import type { MarketSignal } from './signalEngine.js';
import type { MakerMatrix, MakerMatrixCell } from './makerMatrix.js';
import type { PriceChangeDigest } from './alertScheduler.js';

/**
 * Telegram is deliberately a maker-facing transport. Market/taker signals stay in the API/UI.
 *
 * 🟢 ALERTA DE PRECIO / 🔴 ALERTA P2P / ⚠️ ALTA VOLATILIDAD USED TO LIVE HERE, as
 * formatAlertMessage + notifyAlert reacting to a user AlertRule. Deleted, not
 * renamed or downgraded: a market level crossing a number was never a maker
 * decision, and the operator asked for the whole class gone for good.
 */
export const DEFAULT_ALERT_COOLDOWN_MS = 300_000;
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_SYSTEM_ALERT_COOLDOWN_MS = 900_000;
export const TELEGRAM_MESSAGE_LIMIT = 4096;

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
  | 'UNCHANGED'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR';

export interface TelegramResult {
  outcome: TelegramOutcome;
  detail?: string;
}

export function readTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!botToken || !chatId) return null;

  const parsedCooldown = Number(env.TELEGRAM_ALERT_COOLDOWN_MS);
  const cooldownMs = Number.isFinite(parsedCooldown) && parsedCooldown >= 0
    ? parsedCooldown
    : DEFAULT_ALERT_COOLDOWN_MS;
  return { botToken, chatId, cooldownMs, timeoutMs: DEFAULT_TIMEOUT_MS };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function redactSecrets(text: string, config: TelegramConfig | null): string {
  if (!config) return text;
  return text.split(config.botToken).join('<redacted-token>')
    .split(config.chatId).join('<redacted-chat-id>');
}

export function formatVenezuelaClock(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString('es-VE', {
      timeZone: 'America/Caracas', hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return new Date(timestamp).toISOString().slice(11, 19);
  }
}

function signedVes(value: number, decimals = 2): string {
  return `${value >= 0 ? '+' : ''}${escapeHtml(value.toFixed(decimals))}`;
}

function cellStateLine(cell: MakerMatrixCell): string {
  const rec = cell.recommendation;
  if (rec !== null && (
    rec.buyAnalysis.tickProvenance === 'NOT_VERIFIABLE' ||
    rec.sellAnalysis.tickProvenance === 'NOT_VERIFIABLE'
  )) return '⚠️ PRECIO NO VERIFICABLE';

  switch (cell.status) {
    case 'NO_MARGIN': return '⚪ Sin margen positivo';
    case 'FETCH_FAILED': return '⚠️ Binance no respondió';
    case 'STALE': return '⚠️ Dato antiguo';
    default: return '⚪ Sin datos';
  }
}

function summaryCellBlock(cell: MakerMatrixCell): string[] {
  const pair = cell.recommendation?.recommended ?? null;
  const lines = [`💰 ${escapeHtml(cell.amountKey)}`];
  if (pair === null) {
    lines.push(cellStateLine(cell), '');
    return lines;
  }
  lines.push(
    `🟢 Compra: <b>${escapeHtml(pair.buy.price.toFixed(2))}</b>  (#${escapeHtml(String(pair.buy.position))})`,
    `🔵 Venta: <b>${escapeHtml(pair.sell.price.toFixed(2))}</b>  (#${escapeHtml(String(pair.sell.position))})`,
    `💵 Margen: <b>${signedVes(pair.grossMarginVes)} VES</b>${pair.grossMarginPct !== null ? ` · ${signedVes(pair.grossMarginPct, 4)}%` : ''}`,
    ''
  );
  return lines;
}

export function formatMakerSummaryMessages(matrix: MakerMatrix, timestamp: number): string[] {
  const header = [
    '🟢 <b>MIS PRECIOS PARA PUBLICAR</b>', '',
    `⏱ Capturado hace ${escapeHtml(String(matrix.ageSeconds))}s`,
    `👥 Compitiendo contra ${matrix.config.publisherFilter === 'ALL' ? 'todos los anunciantes' : matrix.config.publisherFilter === 'MERCHANT_ONLY' ? 'sólo comerciantes' : 'sólo no comerciantes'}`,
    `📊 Profundidad TOP ${escapeHtml(String(matrix.config.ladderDepth))}`,
    matrix.stale ? '⚠️ DATO ANTIGUO' : '', '',
  ].filter(Boolean);

  const footer = [
    '━━━━━━━━━━━━━━━━━━', '', '⚠️ <b>MARGEN BRUTO POTENCIAL</b>', '',
    'No es una operación garantizada.',
    'No incluye comisiones, transferencias,', 'slippage ni otros costos.', '',
    `Hora: ${formatVenezuelaClock(timestamp)}`,
  ];

  const bankBlocks: string[][] = [];
  for (const bank of matrix.bankOrder) {
    const row = matrix.cells[bank];
    if (!row) continue;
    const block = ['━━━━━━━━━━━━━━━━━━', '', `🏦 <b>${escapeHtml(matrix.bankDisplayNames[bank] ?? bank)}</b>`, ''];
    for (const amountKey of matrix.amountKeys) {
      const cell = row[amountKey];
      if (cell) block.push(...summaryCellBlock(cell));
    }
    bankBlocks.push(block);
  }

  if (bankBlocks.length === 0) {
    return [[...header, 'No hay ninguna celda capturada todavía.', '', `Hora: ${formatVenezuelaClock(timestamp)}`].join('\n')];
  }

  const parts: string[][] = [];
  let current = [...header];
  for (const block of bankBlocks) {
    const candidate = [...current, ...block];
    if (current.length > header.length && [...candidate, ...footer].join('\n').length > TELEGRAM_MESSAGE_LIMIT) {
      parts.push(current);
      current = [...header, ...block];
    } else current = candidate;
  }
  parts.push(current);

  const total = parts.length;
  return parts.map((part, index) => {
    const marker = total > 1 ? [`(${index + 1}/${total})`, ''] : [];
    return [...part, ...footer, ...marker].join('\n');
  });
}

export function formatPriceChangeDigestMessage(digest: PriceChangeDigest): string {
  const n = (value: number) => escapeHtml(value.toFixed(2));
  const lines = [
    '🔔 <b>CAMBIOS DE PRECIOS PARA PUBLICAR</b>', '',
    `Actualizado: ${formatVenezuelaClock(digest.releasedAt)}`, '',
  ];
  let currentBank: string | null = null;
  for (const change of digest.changes) {
    if (change.bankDisplayName !== currentBank) {
      if (currentBank !== null) lines.push('');
      lines.push(`🏦 <b>${escapeHtml(change.bankDisplayName.toUpperCase())}</b>`);
      currentBank = change.bankDisplayName;
    }
    if (change.announcedBuyPrice !== change.latestBuyPrice) {
      lines.push(`${escapeHtml(change.amountKey)} → compra ${n(change.announcedBuyPrice)} → <b>${n(change.latestBuyPrice)}</b>`);
    }
    if (change.announcedSellPrice !== change.latestSellPrice) {
      lines.push(`${escapeHtml(change.amountKey)} → venta ${n(change.announcedSellPrice)} → <b>${n(change.latestSellPrice)}</b>`);
    }
    if (change.detections > 1) lines.push(`<i>(${escapeHtml(String(change.detections))} movimientos en la ventana)</i>`);
  }
  lines.push('', `Se detectaron ${escapeHtml(String(digest.changes.length))} cambio(s).`);
  if (digest.revertedCells > 0) lines.push(`${escapeHtml(String(digest.revertedCells))} celda(s) volvieron a su precio anterior.`);
  lines.push('', `Próxima revisión automática: ${formatVenezuelaClock(digest.nextReleaseAt)}`);
  return lines.join('\n');
}

/** Kept for UI/test compatibility; this formatter is never sent by Telegram. */
export function formatMarketSignalMessage(signal: MarketSignal, _priority: string, timestamp: number): string {
  const price = signal.currentPrice === null ? 'no verificable' : escapeHtml(signal.currentPrice.toFixed(2));
  return [
    '📈 <b>PROYECCIÓN DE MERCADO</b>', '',
    `🏦 ${escapeHtml(signal.bankDisplayName)} · ${escapeHtml(signal.amountKey)}`,
    `${signal.side === 'BUY' ? '🟢' : '🔵'} ${escapeHtml(signal.sideLabel)}`, '',
    escapeHtml(signal.headline), '',
    `ACTUAL (precio para publicar): <b>${price} VES</b>`,
    '', '<b>Evidencia</b>', ...signal.evidence.map((line) => `· ${escapeHtml(line)}`), '',
    'Una proyección no es un precio de Binance.', '', `Hora: ${formatVenezuelaClock(timestamp)}`,
  ].join('\n');
}

export function formatSystemAlertMessage(alert: TelegramSystemAlert): string {
  const heading: Record<TelegramSystemAlert['kind'], string> = {
    BINANCE_OFFLINE: '⛔ <b>BINANCE NO DISPONIBLE</b>',
    BINANCE_RECOVERED: '✅ <b>CAPTURA RESTABLECIDA</b>',
    DATA_STALE: '⚠️ <b>DATOS DESACTUALIZADOS</b>',
    STORAGE_ERROR: '🛑 <b>CRITICAL STORAGE ERROR</b>',
  };
  const consequence: Record<TelegramSystemAlert['kind'], string> = {
    BINANCE_OFFLINE: 'No hay captura de mercado. Los precios mostrados son los ultimos conocidos, no el mercado actual.',
    BINANCE_RECOVERED: 'La captura de Binance P2P vuelve a responder.',
    DATA_STALE: 'La ultima captura valida supera el umbral. No operar sobre estos precios sin refrescar.',
    STORAGE_ERROR: 'El historico ha dejado de poder escribirse. Se siguen sirviendo datos en vivo, pero NO se esta acumulando historico y las proyecciones se degradaran.',
  };
  return [heading[alert.kind], '', escapeHtml(alert.detail), '', consequence[alert.kind], '', 'Procedencia: SYSTEM (no es una señal de mercado).', '', `Hora: ${formatVenezuelaClock(alert.timestamp)}`].join('\n');
}

export class TelegramNotifier {
  private static instance: TelegramNotifier | null = null;
  private readonly lastSentAt = new Map<string, number>();
  private readonly lastSystemState = new Map<string, string>();
  private startupLogged = false;

  constructor(private readonly config: TelegramConfig | null) {}

  public static getInstance(): TelegramNotifier {
    if (!TelegramNotifier.instance) {
      TelegramNotifier.instance = new TelegramNotifier(readTelegramConfig());
      TelegramNotifier.instance.logStartupStatus();
    }
    return TelegramNotifier.instance;
  }

  public static resetInstance(): void { TelegramNotifier.instance = null; }
  public resetState(): void { this.lastSentAt.clear(); this.lastSystemState.clear(); }
  public isEnabled(): boolean { return this.config !== null; }

  public logStartupStatus(): void {
    if (this.startupLogged) return;
    this.startupLogged = true;
    if (!this.config) console.warn('[Telegram] Notifications disabled: Telegram credentials not configured.');
    else console.log(`[Telegram] Notifications enabled (cooldown ${this.config.cooldownMs}ms, timeout ${this.config.timeoutMs}ms).`);
  }

  /**
   * Intentionally inert. Telegram is maker-only. Projection/trend signals are
   * still computed and exposed through the API/UI, but can never reach the
   * Telegram transport through this compatibility method.
   */
  public async notifyMarketSignals(signals: readonly MarketSignal[], _timestamp: number): Promise<TelegramResult[]> {
    return signals.map(() => ({ outcome: 'UNCHANGED' as const, detail: 'Market signals are UI/API only; Telegram is maker-only.' }));
  }

  private async send(text: string): Promise<TelegramResult> {
    if (!this.config) return { outcome: 'DISABLED' };
    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.config.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
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
    } finally { clearTimeout(timeoutId); }
  }

  private describe(err: unknown): string {
    return redactSecrets(err instanceof Error ? err.message : String(err), this.config);
  }

  public async notifySystemAlert(alert: TelegramSystemAlert): Promise<TelegramResult> {
    try {
      if (!this.config) return { outcome: 'DISABLED' };
      const key = `system:${alert.kind}`;
      const now = alert.timestamp || Date.now();
      if (this.lastSystemState.get(key) === alert.state) return { outcome: 'UNCHANGED' };
      const previous = this.lastSentAt.get(key);
      const cooldownMs = Math.max(this.config.cooldownMs, DEFAULT_SYSTEM_ALERT_COOLDOWN_MS);
      if (previous !== undefined && now - previous < cooldownMs) return { outcome: 'COOLDOWN' };
      this.lastSystemState.set(key, alert.state);
      this.lastSentAt.set(key, now);
      this.prune(now);
      return await this.send(formatSystemAlertMessage(alert));
    } catch (err) {
      const detail = this.describe(err);
      return { outcome: 'NETWORK_ERROR', detail };
    }
  }

  public async notifyMakerAlerts(alerts: readonly MakerAlert[], timestamp: number): Promise<TelegramResult[]> {
    const results: TelegramResult[] = [];
    if (!this.config) return alerts.map(() => ({ outcome: 'DISABLED' as const }));
    const now = timestamp || Date.now();
    for (const alert of alerts) {
      try {
        if (alert.kind !== 'SUMMARY') { results.push({ outcome: 'UNCHANGED' }); continue; }
        for (const message of formatMakerSummaryMessages(alert.matrix, now)) results.push(await this.send(message));
      } catch (err) { results.push({ outcome: 'NETWORK_ERROR', detail: this.describe(err) }); }
    }
    return results;
  }

  public async notifyPriceChangeDigest(digest: PriceChangeDigest): Promise<TelegramResult> {
    try {
      if (!this.config) return { outcome: 'DISABLED' };
      if (digest.changes.length === 0) return { outcome: 'UNCHANGED' };
      this.lastSentAt.set('maker:digest', digest.releasedAt);
      this.prune(digest.releasedAt);
      return await this.send(formatPriceChangeDigestMessage(digest));
    } catch (err) { return { outcome: 'NETWORK_ERROR', detail: this.describe(err) }; }
  }

  private prune(now: number): void {
    if (!this.config) return;
    const horizon = Math.max(this.config.cooldownMs * 10, 3_600_000);
    for (const [key, at] of this.lastSentAt) if (now - at > horizon) this.lastSentAt.delete(key);
  }
}
