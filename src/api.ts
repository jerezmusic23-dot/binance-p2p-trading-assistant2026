import {
  LatestApiResponse,
  MakerMatrixResponse,
  MakerProjectionsResponse,
  DailyProjectionResponse,
  MarketReadingResponse,
  CellSeriesResponse,
  OpportunitiesResponse,
  HistoryRecord,
  HistorySummary,
  ProjectionBacktestResponse,
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
    if (err instanceof Error) throw err;
    throw new Error(String(err) || 'Error de conexión');
  }
}

export class ApiService {
  public static async getLatestMarket(bank?: string, amount?: number): Promise<LatestApiResponse> {
    const qs = buildQuery(bank, amount);
    return requestJson<LatestApiResponse>(`/api/market/latest${qs}`);
  }

  public static async getMakerMatrix(refresh = false): Promise<MakerMatrixResponse> {
    return requestJson<MakerMatrixResponse>(`/api/market/maker-matrix?refresh=${refresh}`);
  }

  public static async getMakerProjections(): Promise<MakerProjectionsResponse> {
    return requestJson<MakerProjectionsResponse>('/api/market/projections/maker');
  }

  public static async getDailyProjection(): Promise<DailyProjectionResponse> {
    return requestJson<DailyProjectionResponse>('/api/market/projections/daily');
  }

  public static async getMarketReading(): Promise<MarketReadingResponse> {
    return requestJson<MarketReadingResponse>('/api/market/reading');
  }

  public static async getCellSeries(
    bank: string,
    amountKey: string,
    limit = 300
  ): Promise<CellSeriesResponse> {
    return requestJson<CellSeriesResponse>(
      `/api/market/projections/series?bank=${encodeURIComponent(bank)}` +
        `&amount=${encodeURIComponent(amountKey)}&limit=${limit}`
    );
  }

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

  public static async getProjectionBacktest(
    bank = 'MERCADO_GENERAL',
    amountKey = 'MERCADO_GENERAL',
    side: 'BUY' | 'SELL' = 'BUY'
  ): Promise<ProjectionBacktestResponse> {
    return requestJson<ProjectionBacktestResponse>(
      `/api/market/projections/backtest?bank=${encodeURIComponent(bank)}` +
        `&amount=${encodeURIComponent(amountKey)}&side=${side}`
    );
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
