import { TelegramSystemAlert } from './types.js';
import type { MakerAlert } from './makerAlerts.js';
import type { MarketSignal } from './signalEngine.js';
import type { MakerMatrix, MakerMatrixCell } from './makerMatrix.js';
import {
  PRIORITY_ORDER,
  priorityOf,
  readSignalInterval,
  type AlertPriority,
  type PriceChangeDigest,
} from './alertScheduler.js';

/**
 * Telegram carries exactly TWO independent voices, and only two:
 *
 *   1. SEÑALES DE MERCADO (notifyMarketSignals) - 📈 PROYECCIÓN DE MERCADO,
 *      🚀 RUPTURA, 🔄 CAMBIO DE TENDENCIA. Fed by signalEngine, which reads
 *      only the per-cell maker series. Never a prediction dressed as an
 *      order: every message says so.
 *   2. ALERTAS MAKER (notifyMakerAlerts / notifyPriceChangeDigest) - the
 *      30-minute summary and the grouped price-change digest, both about
 *      what to PUBLISH, never about a market level crossing a number.
 *
 * 🟢 ALERTA DE PRECIO / 🔴 ALERTA P2P / ⚠️ ALTA VOLATILIDAD USED TO LIVE HERE, as
 * formatAlertMessage + notifyAlert reacting to a user AlertRule. Deleted, not
 * renamed or downgraded: a market level crossing a number was never a maker
 * decision, and the operator asked for the whole class gone for good. The
 * taker/arbitrage lifecycle announcement (OPORTUNIDAD DE ARBITRAJE) is gone
 * the same way, for the same reason: this operator is a maker.
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

export function formatMarketSignalMessage(signal: MarketSignal, priority: AlertPriority, timestamp: number): string {
  const n = (value: number | null): string =>
    value === null ? 'no verificable' : escapeHtml(value.toFixed(2));
  const heading =
    signal.kind === 'TREND_CHANGE'
      ? signal.status === 'CONFIRMED' ? '🔄 <b>CAMBIO DE TENDENCIA</b>' : '⚠️ <b>POSIBLE CAMBIO DE TENDENCIA</b>'
      : signal.kind === 'BREAKOUT_UP' || signal.kind === 'BREAKOUT_DOWN' ? '🚀 <b>RUPTURA</b>' : '📈 <b>PROYECCIÓN DE MERCADO</b>';
  const statusLine = signal.status === 'CONFIRMED' ? 'Estado: <b>CONFIRMADA</b>' : 'Estado: <b>SEÑAL PARCIAL · AVISO TEMPRANO</b>';
  const lines = [
    heading, '',
    `🏦 ${escapeHtml(signal.bankDisplayName)} · ${escapeHtml(signal.amountKey)}`,
    `${signal.side === 'BUY' ? '🟢' : '🔵'} ${escapeHtml(signal.sideLabel)}`, '',
    escapeHtml(signal.headline), '',
    statusLine,
    `Prioridad: <b>${escapeHtml(priority)}</b>`,
    `Confianza: <b>${escapeHtml(signal.confidence)}</b> · Muestras: <b>${escapeHtml(String(signal.sampleSize))}</b>`, '',
    `ACTUAL (precio para publicar): <b>${n(signal.currentPrice)} VES</b>`,
    signal.projectedLow !== null && signal.projectedHigh !== null
      ? `PROYECTADO (rango observado): <b>${n(signal.projectedLow)} – ${n(signal.projectedHigh)} VES</b>`
      : 'PROYECTADO: no verificable con el histórico disponible',
  ];
  if (signal.watchStartHour !== null && signal.watchEndHour !== null) {
    lines.push('', `MIRAR: <b>${escapeHtml(String(signal.watchStartHour).padStart(2, '0'))}:00 – ${escapeHtml(String(signal.watchEndHour).padStart(2, '0'))}:00</b> (hora de Venezuela)`);
  }
  lines.push('', '<b>Evidencia</b>', ...signal.evidence.map((line) => `· ${escapeHtml(line)}`), '', 'No es una orden automática ni una operación garantizada.', 'Una proyección no es un precio de Binance.', '', `Hora: ${formatVenezuelaClock(timestamp)}`);
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

  public async notifyMarketSignals(signals: readonly MarketSignal[], timestamp: number): Promise<TelegramResult[]> {
    if (!this.config) return signals.map(() => ({ outcome: 'DISABLED' as const }));
    const now = timestamp || Date.now();
    const { intervalMs } = readSignalInterval();
    const ordered = [...signals]
      .map((signal, index) => ({ signal, index, priority: priorityOf(signal) }))
      .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.index - b.index);
    const outcomeByIndex = new Map<number, TelegramResult>();

    for (const { signal, index, priority } of ordered) {
      try {
        if (priority === 'INFO') {
          outcomeByIndex.set(index, { outcome: 'UNCHANGED' });
          continue;
        }

        const dedupKey = `signal:${signal.identity}:${signal.status}`;
        if (this.lastSentAt.has(dedupKey)) {
          outcomeByIndex.set(index, { outcome: 'UNCHANGED' });
          continue;
        }

        const critical = priority === 'CRITICAL';
        const cellKey = critical
          ? `signal:critical:${signal.bank}:${signal.amountKey}`
          : `signal:cell:${signal.bank}:${signal.amountKey}`;
        const globalCheckKey = critical ? 'signal:any:critical' : 'signal:any';
        const floorMs = critical ? Math.floor(intervalMs / 2) : intervalMs;
        const lastCell = this.lastSentAt.get(cellKey);
        if (lastCell !== undefined && now - lastCell < floorMs) {
          outcomeByIndex.set(index, { outcome: 'COOLDOWN' });
          continue;
        }
        const lastGlobal = this.lastSentAt.get(globalCheckKey);
        if (lastGlobal !== undefined && now - lastGlobal < floorMs) {
          outcomeByIndex.set(index, { outcome: 'COOLDOWN' });
          continue;
        }

        const result = await this.send(formatMarketSignalMessage(signal, priority, now));
        outcomeByIndex.set(index, result);
        // IMPORTANT: throttles advance only after Telegram accepted the message.
        // A timeout/HTTP/network failure must remain retryable on the next sweep.
        if (result.outcome === 'SENT') {
          this.lastSentAt.set(dedupKey, now);
          this.lastSentAt.set(cellKey, now);
          this.lastSentAt.set('signal:any', now);
          if (critical) this.lastSentAt.set('signal:any:critical', now);
          this.prune(now);
        }
      } catch (err) {
        outcomeByIndex.set(index, { outcome: 'NETWORK_ERROR', detail: this.describe(err) });
      }
    }

    return signals.map((_, i) => outcomeByIndex.get(i)!);
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
      const result = await this.send(formatSystemAlertMessage(alert));
      if (result.outcome === 'SENT') {
        this.lastSystemState.set(key, alert.state);
        this.lastSentAt.set(key, now);
        this.prune(now);
      }
      return result;
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
      const result = await this.send(formatPriceChangeDigestMessage(digest));
      if (result.outcome === 'SENT') {
        this.lastSentAt.set('maker:digest', digest.releasedAt);
        this.prune(digest.releasedAt);
      }
      return result;
    } catch (err) { return { outcome: 'NETWORK_ERROR', detail: this.describe(err) }; }
  }

  private prune(now: number): void {
    if (!this.config) return;
    const horizon = Math.max(this.config.cooldownMs * 10, 3_600_000);
    for (const [key, at] of this.lastSentAt) if (now - at > horizon) this.lastSentAt.delete(key);
  }
}
