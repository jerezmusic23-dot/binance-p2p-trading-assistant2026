/**
 * EL DATASET EXTERNO DE usdt.com.ve
 * =================================
 *
 * Se prueba contra el FICHERO REAL que hay en `reference-data/`, no contra un
 * fixture inventado: lo que importa de un importador es que aguante el fichero
 * que existe, con sus comentarios, sus nulls y sus huecos.
 *
 * Lo que se protege:
 *   1. Que la serie externa NO se confunda nunca con la nuestra.
 *   2. Que las filas que no se pueden afirmar se descarten con su motivo.
 *   3. Que el recuento de días por hora —la medida que decide si se puede
 *      hacer un perfil intradía— sea real y no una impresión.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { daysPerHourOfDay, parseUsdtVeCsv } from '../server/externalSeries.js';

const CSV = fs.readFileSync(
  path.join(process.cwd(), 'reference-data', 'usdt-ves-historical.csv'),
  'utf-8'
);
const report = parseUsdtVeCsv(CSV);
const binanceBuy = report.series.find((s) => s.source === 'binance' && s.field === 'buyRate')!;

describe('lee el fichero real', () => {
  it('salta los comentarios de cabecera y encuentra las tres fuentes', () => {
    expect(new Set(report.series.map((s) => s.source))).toEqual(
      new Set(['binance', 'bybit', 'bcv'])
    );
    expect(report.rowsRead).toBe(1000);
  });

  it('mide la cadencia en lugar de suponerla', () => {
    // 5 minutos, con el medio segundo que aporta promediar los dos huecos
    // centrales cuando su número es par. La mediana no se redondea a un valor
    // "bonito": se publica lo que se midió.
    expect(report.medianIntervalMs).toBeGreaterThan(4.9 * 60 * 1000);
    expect(report.medianIntervalMs).toBeLessThan(5.1 * 60 * 1000);
  });

  it('el BCV no tiene lado de venta, y eso no es un error', () => {
    // El dataset lo marca literalmente como `null`.
    const bcvSell = report.series.find((s) => s.source === 'bcv' && s.field === 'sellRate');
    expect(bcvSell).toBeUndefined();
    expect(report.series.some((s) => s.source === 'bcv' && s.field === 'buyRate')).toBe(true);
  });

  it('cada serie llega etiquetada con su origen y su método', () => {
    for (const s of report.series) {
      expect(s.label).toContain('usdt.com.ve');
    }
    expect(report.attribution).toContain('CC-BY-4.0');
  });

  it('las series salen ordenadas y sin valores imposibles', () => {
    for (const s of report.series) {
      for (let i = 1; i < s.points.length; i += 1) {
        expect(s.points[i].t).toBeGreaterThanOrEqual(s.points[i - 1].t);
      }
      for (const p of s.points) {
        expect(Number.isFinite(p.price)).toBe(true);
        expect(p.price).toBeGreaterThan(0);
      }
    }
  });
});

describe('descarta lo que no se puede afirmar', () => {
  const parse = (body: string) =>
    parseUsdtVeCsv(`# comentario\ncaptured_at,source,buy_rate,sell_rate\n${body}`);

  it('rechaza timestamps ilegibles y fuentes desconocidas', () => {
    const r = parse(
      [
        'no-es-fecha,binance,450,451',
        '2026-01-17T16:49:29Z,kraken,450,451',
        '2026-01-17T16:49:29Z,binance,450,451',
      ].join('\n')
    );
    expect(r.rowsRead).toBe(3);
    expect(r.rowsRejected).toBe(2);
    expect(r.rejectionReasons).toContain('timestamp ilegible');
    expect(r.series.flatMap((s) => s.points)).toHaveLength(2);
  });

  it('descarta precios imposibles sin tirar la fila entera', () => {
    const r = parse('2026-01-17T16:49:29Z,binance,-5,451');
    const buy = r.series.find((s) => s.field === 'buyRate');
    const sell = r.series.find((s) => s.field === 'sellRate');

    expect(buy).toBeUndefined();
    expect(sell!.points).toHaveLength(1);
    expect(r.rejectionReasons.some((x) => x.includes('precio imposible'))).toBe(true);
  });

  it('un fichero vacío o sin cabecera útil no lanza', () => {
    expect(parseUsdtVeCsv('').series).toEqual([]);
    expect(parseUsdtVeCsv('# sólo comentarios').series).toEqual([]);
    expect(parseUsdtVeCsv('a,b\n1,2').rejectionReasons).toContain(
      'cabecera sin captured_at o source'
    );
  });
});

describe('¿alcanza para un perfil por hora del día?', () => {
  it('el fichero real da 1 o 2 días por hora: NO alcanza', () => {
    /*
     * Éste es el número que decide si se puede publicar un gráfico tipo
     * "proyección de fluctuación diaria". Para decir qué suele pasar a las
     * 15:00 hacen falta muchas instancias de las 15:00. Con una o dos, lo que
     * hay es una anécdota.
     */
    const days = daysPerHourOfDay(binanceBuy.points);

    expect(days).toHaveLength(24);
    expect(Math.max(...days)).toBe(2);
    expect(Math.min(...days)).toBe(1);
    expect(days.every((d) => d <= 2)).toBe(true);
  });

  it('cuenta días distintos, no observaciones', () => {
    // Doce observaciones de la misma hora del mismo día son UN día.
    const sameHour = Array.from({ length: 12 }, (_, i) => ({
      t: Date.parse('2026-01-17T16:00:00Z') + i * 5 * 60 * 1000,
      price: 450,
    }));
    expect(daysPerHourOfDay(sameHour)[12]).toBe(1);
  });

  it('usa hora de Venezuela (UTC-4), no UTC', () => {
    // 02:00 UTC del día 18 son las 22:00 VET del día 17.
    const point = [{ t: Date.parse('2026-01-18T02:00:00Z'), price: 450 }];
    const days = daysPerHourOfDay(point);
    expect(days[22]).toBe(1);
    expect(days[2]).toBe(0);
  });

  it('no lanza con una serie vacía', () => {
    expect(daysPerHourOfDay([])).toHaveLength(24);
    expect(daysPerHourOfDay([]).every((d) => d === 0)).toBe(true);
  });
});
