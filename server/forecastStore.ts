/**
 * REGISTRO DE PROYECCIONES EMITIDAS
 * =================================
 *
 * Guarda lo que el sistema dijo EN VIVO para poder juzgarlo cuando venza el
 * horizonte. Sin esto, "el modelo acierta" sería una opinión: el backtest
 * simula el pasado, pero sólo este registro mide lo que el bot realmente
 * publicó, con la cadencia y los huecos que hubo de verdad.
 *
 * DECISIONES DE PERSISTENCIA
 *
 * Fichero propio, no dentro de `market_history.json`. El histórico se reescribe
 * entero una vez por minuto y es la fuente de verdad del mercado; mezclar en
 * él un registro de predicciones haría cada escritura más cara y ataría dos
 * ciclos de vida que no tienen por qué coincidir.
 *
 * NO se emite una proyección por captura. Se emite como mucho una por serie y
 * horizonte cada `MIN_FORECAST_SPACING_RATIO` del propio horizonte: dos
 * proyecciones separadas por un minuto sobre un horizonte de una hora
 * comparten el 98% de su ventana y no son dos pruebas del modelo, son casi
 * una. Espaciarlas es lo que hace que el recuento posterior signifique algo.
 */

import fs from 'fs';
import { StorageEngine } from './storage.js';
import type { ForecastRecord } from './projection/forecastEvaluation.js';

/**
 * Separación mínima entre proyecciones de la misma serie y horizonte, como
 * fracción del horizonte.
 *
 * 1 = una proyección por horizonte completo, es decir ventanas que no se
 * solapan. Es el mismo criterio de independencia que usa el backtest, y por el
 * mismo motivo: dos pruebas que comparten casi toda su ventana son casi una.
 */
export const MIN_FORECAST_SPACING_RATIO = 1;

/**
 * Tope de proyecciones guardadas.
 *
 * A una proyección por horizonte y serie, con cinco horizontes y dos series,
 * 5.000 registros cubren meses de rendimiento medido. El fichero se reescribe
 * entero al guardar, así que el tope acota ese coste; al desbordar se descartan
 * las MÁS ANTIGUAS YA EVALUADAS, nunca las pendientes, que son las únicas que
 * todavía pueden aportar una medición.
 */
export const MAX_FORECAST_RECORDS = 5_000;

export class ForecastStore {
  private static FILE_NAME = 'forecast_log.json';
  private static forecasts: ForecastRecord[] | null = null;

  private static file(): string {
    return StorageEngine.dataFile(this.FILE_NAME);
  }

  /** Carga perezosa. Un fichero ilegible NO tumba el arranque. */
  private static load(): ForecastRecord[] {
    if (this.forecasts !== null) return this.forecasts;

    try {
      const path = this.file();
      if (!fs.existsSync(path)) {
        this.forecasts = [];
        return this.forecasts;
      }
      const parsed = JSON.parse(fs.readFileSync(path, 'utf-8'));
      this.forecasts = Array.isArray(parsed) ? (parsed as ForecastRecord[]) : [];
    } catch (err) {
      // Se empieza vacío en lugar de morir: perder el registro de rendimiento
      // es malo, pero no capturar el mercado es peor.
      console.error('[ForecastStore] Registro ilegible, se empieza vacío:', err);
      this.forecasts = [];
    }
    return this.forecasts;
  }

  private static save(): void {
    try {
      StorageEngine.writeJsonAtomic(this.file(), this.forecasts ?? []);
    } catch (err) {
      console.error('[ForecastStore] Error al guardar el registro:', err);
    }
  }

  public static all(): ForecastRecord[] {
    return [...this.load()];
  }

  public static pending(): ForecastRecord[] {
    return this.load().filter((f) => f.evaluatedAt === null);
  }

  /**
   * ¿Toca emitir una proyección para esta serie y horizonte?
   *
   * Sólo si la última dista al menos un horizonte completo. Devuelve la razón
   * cuando no toca, para que el motivo sea legible desde fuera.
   */
  public static shouldRecord(
    seriesId: string,
    horizonMs: number,
    now: number
  ): { record: boolean; reason: string | null } {
    if (!Number.isFinite(horizonMs) || horizonMs <= 0) {
      return { record: false, reason: 'horizonte inválido' };
    }

    const previous = this.load()
      .filter((f) => f.seriesId === seriesId && f.horizonMs === horizonMs)
      .reduce<number | null>((latest, f) => (latest === null || f.createdAt > latest ? f.createdAt : latest), null);

    if (previous === null) return { record: true, reason: null };

    const spacing = horizonMs * MIN_FORECAST_SPACING_RATIO;
    if (now - previous < spacing) {
      return {
        record: false,
        reason: `la anterior es de hace ${Math.round((now - previous) / 60000)} min y el espaciado exigido es ${Math.round(spacing / 60000)} min`,
      };
    }
    return { record: true, reason: null };
  }

  public static append(forecast: ForecastRecord): void {
    const list = this.load();
    list.push(forecast);
    this.enforceCap();
    this.save();
  }

  /** Sustituye los registros cuyo id coincida. Usado tras evaluar. */
  public static update(updated: readonly ForecastRecord[]): void {
    if (updated.length === 0) return;
    const byId = new Map(updated.map((f) => [f.id, f]));
    const list = this.load();
    for (let i = 0; i < list.length; i += 1) {
      const replacement = byId.get(list[i].id);
      if (replacement) list[i] = replacement;
    }
    this.save();
  }

  /**
   * Al desbordar se tiran las evaluadas más antiguas. Las pendientes se
   * conservan siempre: son las únicas que aún pueden producir una medición.
   */
  private static enforceCap(): void {
    const list = this.load();
    if (list.length <= MAX_FORECAST_RECORDS) return;

    const evaluated = list
      .map((f, index) => ({ f, index }))
      .filter(({ f }) => f.evaluatedAt !== null)
      .sort((a, b) => a.f.createdAt - b.f.createdAt);

    const excess = list.length - MAX_FORECAST_RECORDS;
    const drop = new Set(evaluated.slice(0, excess).map(({ index }) => index));
    this.forecasts = list.filter((_, index) => !drop.has(index));
  }

  /** Sólo para tests: olvida el estado en memoria. */
  public static reset(): void {
    this.forecasts = null;
  }
}
