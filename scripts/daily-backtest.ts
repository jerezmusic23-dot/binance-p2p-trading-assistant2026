/**
 * BACKTEST TEMPORAL DE LA PROYECCIÓN DIARIA
 * =========================================
 *
 * Recorre el histórico REAL hacia adelante y, para cada día evaluable, pregunta
 * "¿qué habría proyectado en este instante usando SÓLO lo anterior?". No hay
 * mocks: si no hay histórico, lo dice y no inventa uno.
 *
 * La ausencia de look-ahead es estructural, no una promesa: el perfil de cada
 * día se construye con `days.slice(0, i)` y el día evaluado se recorta hasta la
 * hora ancla antes de proyectar. Hay tests que lo comprueban.
 *
 * Uso:
 *   npx tsx scripts/daily-backtest.ts [ruta-al-json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { extractLegSeries } from '../server/dailyProjection.js';
import {
  MIN_PROFILE_DAYS,
  backtestLeg,
  groupByDay,
  type LegBacktest,
  type MakerLeg,
} from '../server/projection/dailyShape.js';
import type { HistoryRecord } from '../server/types.js';

const file = process.argv[2] ?? path.join(process.cwd(), 'data', 'market_history.json');

function readRecords(): HistoryRecord[] {
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Array.isArray(raw)) return raw as HistoryRecord[];
    if (raw && Array.isArray(raw.records)) return raw.records as HistoryRecord[];
    return [];
  } catch {
    return [];
  }
}

const n = (v: number | null, digits = 3) => (v === null ? '—' : v.toFixed(digits));

function report(leg: MakerLeg, side: string, b: LegBacktest): void {
  console.log(`\n── ${leg}  (Binance ${side}) ──`);
  console.log(`  días evaluados      : ${b.days}   (anclas día×hora: ${b.anchors})`);
  if (b.days === 0) {
    console.log('  SIN EVIDENCIA SUFICIENTE: no hay días bastantes para evaluar nada.');
    return;
  }
  console.log(`  error cierre modelo : ${n(b.closeErrorModel)} VES`);
  console.log(`  error cierre persis.: ${n(b.closeErrorPersistence)} VES`);
  console.log(`  error extremo modelo: ${n(b.extremeErrorModel)} VES`);
  console.log(`  error extremo persis: ${n(b.extremeErrorPersistence)} VES`);
  console.log(`  cobertura del rango : ${b.coverage === null ? '—' : (b.coverage * 100).toFixed(1) + '%'}`);
  console.log(`  dirección acertada  : ${b.directionHits}/${b.directionTotal}`);
  console.log(`  días ganados modelo : ${b.modelWins} · persistencia ${b.persistenceWins} · empates ${b.ties}`);
  console.log(`  p (signo exacto)    : ${n(b.pValue, 4)}`);
  console.log(
    `  VEREDICTO           : ${
      b.beatsPersistence
        ? 'BATE A LA PERSISTENCIA'
        : 'NO SE PUEDE AFIRMAR QUE MEJORE A LA PERSISTENCIA'
    }`
  );
}

function main(): void {
  console.log('═══════ BACKTEST TEMPORAL — PROYECCIÓN DIARIA ═══════');
  console.log(`fichero: ${file}`);

  const records = readRecords();
  console.log(`registros leídos: ${records.length}`);

  const venta = extractLegSeries(records, 'VENTA');
  const compra = extractLegSeries(records, 'COMPRA');
  console.log(
    `serie MI VENTA : ${venta.points.length} puntos (descartados: ${venta.extraction.droppedLegacy} v1, ${venta.extraction.droppedInvalid} inválidos)`
  );
  console.log(
    `serie MI COMPRA: ${compra.points.length} puntos (descartados: ${compra.extraction.droppedLegacy} v1, ${compra.extraction.droppedInvalid} inválidos)`
  );

  const ventaDays = groupByDay(venta.points, 'VENTA');
  const compraDays = groupByDay(compra.points, 'COMPRA');
  console.log(`días completos en la ventana 8–20: ${ventaDays.length}`);

  if (ventaDays.length <= MIN_PROFILE_DAYS) {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  SIN EVIDENCIA SUFICIENTE PARA UN BACKTEST                   ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log(
      `Hacen falta más de ${MIN_PROFILE_DAYS} días para que exista siquiera un día evaluable,`
    );
    console.log('porque el perfil de cada día se construye SÓLO con los anteriores.');
    console.log(`Ahora mismo hay ${ventaDays.length}.`);
    console.log('\nNo se sustituye por datos sintéticos: un backtest sobre datos inventados');
    console.log('mediría la calidad del inventor, no la del modelo.');
    return;
  }

  report('VENTA', 'BUY', backtestLeg(ventaDays, 'VENTA'));
  report('COMPRA', 'SELL', backtestLeg(compraDays, 'COMPRA'));
}

main();
