/**
 * EL BOT NO SE APAGA POR HORARIO
 * ===============================
 *
 * Aserciones sobre el FUENTE, no sólo sobre el comportamiento: lo que hay que
 * impedir es que alguien introduzca una condición de horario en la captura de
 * Binance, en el refresco autónomo de la matriz o en el resumen de Telegram —
 * el motor de proyección ya dejó de tener una ventana 08:00–20:00
 * (`tests/dailyShape.test.ts`, `tests/dailyProjection.test.ts`), pero nada
 * impide que alguien reintroduzca la misma idea en otro sitio si nadie la
 * prohíbe explícitamente.
 *
 * También fija, en el mismo sitio, que el resumen de Telegram sigue leyendo
 * `recommendation.recommended` — la política de selección real, calculada por
 * `makerRecommendation.ts` — y nunca `bestMarginPairing`, que es sólo un
 * diagnóstico y nunca debe convertirse en la recomendación publicada.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SERVER = path.join(process.cwd(), 'server');
const read = (f: string) => fs.readFileSync(f, 'utf-8');
/** Fuente sin comentarios: un horario mencionado en un comentario es legítimo. */
const codeOnly = (f: string) =>
  read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ALWAYS_ON_FILES = [
  path.join(SERVER, 'centralStore.ts'),
  path.join(SERVER, 'makerAlerts.ts'),
  path.join(SERVER, 'makerMatrix.ts'),
  path.join(SERVER, 'telegramNotifier.ts'),
  path.join(process.cwd(), 'server.ts'),
];

describe('nada en la captura, la matriz autónoma o Telegram se condiciona por hora de reloj', () => {
  for (const file of ALWAYS_ON_FILES) {
    it(`${path.basename(file)} no compara la hora del día para decidir si actúa`, () => {
      const body = codeOnly(file);
      // Ninguna de las dos formas de leer "qué hora es" para condicionar algo.
      expect(body).not.toMatch(/getHours\(\)/);
      expect(body).not.toMatch(/getUTCHours\(\)/);
      expect(body).not.toMatch(/isMarketOpen|businessHours|BUSINESS_HOURS|MARKET_OPEN/i);
    });
  }

  it('el sondeo de Binance y el refresco autónomo de la matriz son setInterval incondicionales', () => {
    const body = codeOnly(path.join(SERVER, 'centralStore.ts'));
    expect(body).toMatch(/this\.pollTimer\s*=\s*setInterval\(/);
    expect(body).toMatch(/this\.matrixTimer\s*=\s*setInterval\(/);
  });
});

describe('el resumen de Telegram usa la recomendación real, nunca el diagnóstico', () => {
  const CHAIN_FILES = [
    path.join(SERVER, 'makerAlerts.ts'),
    path.join(SERVER, 'makerMatrix.ts'),
    path.join(SERVER, 'telegramNotifier.ts'),
  ];

  it('lee recommendation.recommended', () => {
    for (const file of CHAIN_FILES) {
      expect(codeOnly(file), path.basename(file)).toMatch(/recommendation\?\.recommended/);
    }
  });

  it('ninguno de los tres sustituye la recomendación por bestMarginPairing', () => {
    for (const file of CHAIN_FILES) {
      expect(codeOnly(file), path.basename(file)).not.toMatch(/bestMarginPairing/);
    }
  });
});
