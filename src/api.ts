import {
  LatestApiResponse,
  ExecutableMatrixResponse,
  MakerMatrixResponse,
  MakerProjectionsResponse,
  DailyProjectionResponse,
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

  /*
   * getMarketAnalysis and getMarketProjections USED TO LIVE HERE.
   *
   * They fetched /api/market/analysis and /api/market/projections, both served
   * by the old ProjectionEngine, and both endpoints are gone. What replaces
   * them: getGeneralProjection() for the book as a whole, getMakerProjections()
   * for every cell, and getCellSeries() for the raw observations behind either.
   */

  public static async getExecutableMatrix(
    refresh = false
  ): Promise<ExecutableMatrixResponse> {
    return requestJson<ExecutableMatrixResponse>(
      `/api/market/matrix?refresh=${refresh}`
    );
  }

  /**
   * The maker matrix: what price MY ad should carry at each bank and amount.
   *
   * A different question from getExecutableMatrix over the same captured book,
   * and a different endpoint on purpose - neither answer can be mistaken for
   * the other by reaching for a field that merely sounds right.
   */
  public static async getMakerMatrix(refresh = false): Promise<MakerMatrixResponse> {
    return requestJson<MakerMatrixResponse>(`/api/market/maker-matrix?refresh=${refresh}`);
  }

  /**
   * Projections and signals per BANCO x MONTO.
   *
   * The SAME objects Telegram receives. The UI never derives a trend, a band
   * or a probability of its own.
   */
  public static async getMakerProjections(): Promise<MakerProjectionsResponse> {
    return requestJson<MakerProjectionsResponse>('/api/market/projections/maker');
  }


  /*
   * La proyección de fluctuación del día en curso.
   *
   * Barata de calcular —una pasada lineal por el histórico— así que el servidor
   * no la cachea y se puede pedir en cada refresco sin miedo.
   */
  public static async getDailyProjection(): Promise<DailyProjectionResponse> {
    return requestJson<DailyProjectionResponse>('/api/market/projections/daily');
  }

  /**
   * One cell's stored series, raw. Gaps stay gaps - the chart must be able to
   * show that capture missed a stretch rather than drawing through it.
   */
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

  /**
   * How the projection engine ACTUALLY did, replayed prefix by prefix.
   *
   * This replaced getBacktestMetrics(), which measured the old
   * ProjectionEngine and reported MAE / MAPE / directional accuracy for a
   * forecast built from hand-picked multipliers. Measuring a heuristic
   * precisely does not make it evidence.
   *
   * The report that comes back is a walk-forward over the stored series: every
   * anchor is computed from a PREFIX, so nothing it reports could have seen
   * the future it is scored against, and it carries a persistence baseline -
   * "the price will not move" - so a directional accuracy can be read against
   * something rather than admired on its own.
   */
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
