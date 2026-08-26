import {
  LatestApiResponse,
  MarketAnalysis,
  MarketProjections,
  ExecutableMatrixResponse,
  OpportunitiesResponse,
  HistoryRecord,
  HistorySummary,
  BacktestMetrics,
  AlertRule,
  AlertTriggerLog,
} from './types';

function buildQuery(bank?: string, amount?: number): string {
  const parts: string[] = [];
  if (bank && bank !== 'ALL') {
    parts.push(`bank=${encodeURIComponent(bank)}`);
  }
  if (amount && amount > 0) {
    parts.push(`amount=${encodeURIComponent(String(amount))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const errJson = await res.json();
        if (errJson?.error) message = errJson.error;
      } catch {
        // ignore non-json error responses
      }
      throw new Error(message);
    }
    return (await res.json()) as T;
  } catch (err: any) {
    if (err instanceof Error) {
      throw err;
    }
    throw new Error(String(err) || 'Error de conexión');
  }
}

export class ApiService {
  public static async getLatestMarket(bank?: string, amount?: number): Promise<LatestApiResponse> {
    const qs = buildQuery(bank, amount);
    return requestJson<LatestApiResponse>(`/api/market/latest${qs}`);
  }

  public static async getMarketAnalysis(bank?: string, amount?: number): Promise<{ analysis: MarketAnalysis | null }> {
    const qs = buildQuery(bank, amount);
    return requestJson<{ analysis: MarketAnalysis | null }>(`/api/market/analysis${qs}`);
  }

  public static async getMarketProjections(bank?: string, amount?: number): Promise<{ projections: MarketProjections | null }> {
    const qs = buildQuery(bank, amount);
    return requestJson<{ projections: MarketProjections | null }>(`/api/market/projections${qs}`);
  }

  /**
   * The executable matrix and the global reference, in one response.
   *
   * Deliberately returns both together and named apart: a consumer has to
   * choose `executableMatrix` or `marketReference` explicitly, and cannot pick
   * up a global price by reaching for a field that merely sounds like a rate.
   */
  public static async getExecutableMatrix(
    refresh = false
  ): Promise<ExecutableMatrixResponse> {
    return requestJson<ExecutableMatrixResponse>(
      `/api/market/matrix?refresh=${refresh}`
    );
  }

  /**
   * The operations the backend judged executable. The SAME objects Telegram
   * receives - the UI never recomputes an opportunity of its own.
   */
  public static async getOpportunities(): Promise<OpportunitiesResponse> {
    return requestJson<OpportunitiesResponse>('/api/market/opportunities');
  }


  public static async getHistory(
    range = '24h'
  ): Promise<{ records: HistoryRecord[]; summary: HistorySummary }> {
    return requestJson<{ records: HistoryRecord[]; summary: HistorySummary }>(
      `/api/market/history?range=${encodeURIComponent(range)}`
    );
  }

  public static async getBacktestMetrics(): Promise<{ backtest: BacktestMetrics }> {
    return requestJson<{ backtest: BacktestMetrics }>('/api/market/backtest');
  }

  public static async refreshMarket(bank?: string, amount?: number): Promise<LatestApiResponse> {
    const qs = buildQuery(bank, amount);
    return requestJson<LatestApiResponse>(`/api/market/refresh${qs}`, { method: 'POST' });
  }

  public static async getAlerts(): Promise<{ alerts: AlertRule[]; triggers: AlertTriggerLog[] }> {
    return requestJson<{ alerts: AlertRule[]; triggers: AlertTriggerLog[] }>('/api/alerts');
  }

  public static async createAlert(alert: Partial<AlertRule>): Promise<{ success: boolean; rule: AlertRule }> {
    return requestJson<{ success: boolean; rule: AlertRule }>('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alert),
    });
  }

  public static async deleteAlert(id: string): Promise<{ success: boolean }> {
    return requestJson<{ success: boolean }>(`/api/alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  public static async checkHealth(): Promise<any> {
    return requestJson<any>('/api/health');
  }
}
