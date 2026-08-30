/**
 * EL ADAPTADOR DE P2P.ARMY
 * ========================
 *
 * ═══ QUÉ SE PRUEBA AQUÍ Y QUÉ NO ═══
 *
 * La PRUEBA DE INTEGRACIÓN real es `scripts/p2p-army-probe.ts`, que habla con
 * la API de verdad y no se simula en ningún sitio. Este fichero prueba las
 * piezas PURAS: el validador del lote y la protección de la credencial. No hay
 * mock de red porque no hay red que mockear — nada de lo que se prueba aquí
 * sale a internet.
 *
 * Los payloads son artificiales A PROPÓSITO: sirven para comprobar que el
 * validador detecta desorden, duplicados, huecos y valores imposibles. Ninguno
 * pretende ser una respuesta real de p2p.army ni se presenta como tal.
 */

import { describe, expect, it } from 'vitest';
import {
  extractRows,
  parseTimestamp,
  validateHistoryBatch,
} from '../server/external/p2pArmyHistory.js';
import {
  API_KEY_ENV,
  callP2PArmy,
  describeRequest,
  hasApiKey,
} from '../server/external/p2pArmyClient.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);

const row = (i: number, over: Record<string, unknown> = {}) => ({
  timestamp: (T0 + i * HOUR) / 1000,
  buy: 940 + i,
  buy_avg: 941 + i,
  sell: 945 + i,
  sell_avg: 946 + i,
  ...over,
});

describe('la credencial nunca sale del módulo', () => {
  it('describeRequest produce una URL registrable sin secretos', () => {
    const url = describeRequest({
      path: '/v1/api/history/p2p_prices',
      query: { market: 'binance', fiat: 'VES', asset: 'USDT' },
    });

    expect(url).toContain('/v1/api/history/p2p_prices');
    expect(url).toContain('market=binance');
    expect(url.toLowerCase()).not.toContain('apikey');
    expect(url.toLowerCase()).not.toContain('key=');
  });

  it('hasApiKey informa de la presencia sin revelar el valor', () => {
    const original = process.env[API_KEY_ENV];
    try {
      delete process.env[API_KEY_ENV];
      expect(hasApiKey()).toBe(false);

      process.env[API_KEY_ENV] = '   ';
      expect(hasApiKey()).toBe(false); // sólo espacios no es una clave

      process.env[API_KEY_ENV] = 'valor-de-prueba-local';
      expect(hasApiKey()).toBe(true);
      // Lo que devuelve es un booleano, nunca la cadena.
      expect(typeof hasApiKey()).toBe('boolean');
    } finally {
      if (original === undefined) delete process.env[API_KEY_ENV];
      else process.env[API_KEY_ENV] = original;
    }
  });

  it('ningún fichero del adaptador lleva una clave escrita', async () => {
    const fs = await import('node:fs');
    for (const f of [
      'server/external/p2pArmyClient.ts',
      'server/external/p2pArmyHistory.ts',
      'scripts/p2p-army-probe.ts',
    ]) {
      const source = fs.readFileSync(f, 'utf-8');
      // Se referencia el NOMBRE de la variable, nunca un valor asignado.
      expect(source).not.toMatch(/P2P_ARMY_API_KEY\s*=\s*['"][^'"]+['"]/);
      expect(source).not.toMatch(/X-APIKEY['"]\s*\]\s*=\s*['"][^'"]{8,}/);
    }
  });
});

describe('encuentra los registros dentro del sobre', () => {
  it('acepta el array pelado y los envoltorios habituales', () => {
    expect(extractRows([row(0)])).toHaveLength(1);
    expect(extractRows({ data: [row(0), row(1)] })).toHaveLength(2);
    expect(extractRows({ result: [row(0)] })).toHaveLength(1);
    expect(extractRows({ prices: [row(0)] })).toHaveLength(1);
  });

  it('dice que no hay array en vez de devolver uno vacío', () => {
    expect(extractRows({ mensaje: 'sin permisos' })).toBeNull();
    expect(extractRows(null)).toBeNull();
    expect(extractRows('texto')).toBeNull();
  });
});

describe('interpreta el tiempo en cualquiera de sus formas', () => {
  it('segundos, milisegundos e ISO 8601', () => {
    expect(parseTimestamp(1_756_000_000)).toBe(1_756_000_000_000);
    expect(parseTimestamp(1_756_000_000_000)).toBe(1_756_000_000_000);
    expect(parseTimestamp('2026-08-01T00:00:00Z')).toBe(T0);
    expect(parseTimestamp('1756000000')).toBe(1_756_000_000_000);
  });

  it('devuelve null en lugar de una fecha inventada', () => {
    expect(parseTimestamp('no es fecha')).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(Number.NaN)).toBeNull();
  });
});

describe('validación del lote', () => {
  it('publica QUÉ campos encontró, para que un cambio de nombres se vea', () => {
    const v = validateHistoryBatch([row(0), row(1)]);
    expect(v.detectedFields).toEqual({
      timestamp: 'timestamp',
      buy: 'buy',
      buyAvg: 'buy_avg',
      sell: 'sell',
      sellAvg: 'sell_avg',
      // Ausentes en este payload, y por eso null: el motor necesita saber que
      // no hay profundidad, no deducirlo del silencio.
      volume: null,
      ads: null,
      spread: null,
    });
    expect(v.points).toHaveLength(2);
  });

  it('si el proveedor renombra los campos, lo DICE en vez de callar', () => {
    const v = validateHistoryBatch([{ momento: 1, precio: 2 }]);
    expect(v.points).toHaveLength(0);
    expect(v.rejectionReasons.join(' ')).toContain('sin campo de tiempo reconocible');
    // Y enumera las claves que sí venían, para poder corregirlo.
    expect(v.rejectionReasons.join(' ')).toContain('momento');
  });

  it('detecta que llega desordenado sin arreglarlo en silencio', () => {
    const v = validateHistoryBatch([row(5), row(1), row(3)]);
    expect(v.chronological).toBe(false);
    // Los puntos sí salen ordenados, pero el hecho queda publicado.
    expect(v.points[0].t).toBeLessThan(v.points[1].t);
  });

  it('cuenta duplicados y huecos', () => {
    // Hacen falta varios intervalos normales para que la mediana signifique
    // algo: con sólo dos (1 h y 8 h) la mediana sería 4,5 h y no describiría
    // la cadencia de nadie.
    const v = validateHistoryBatch([row(0), row(0), row(1), row(2), row(3), row(11)]);

    expect(v.duplicateTimestamps).toBe(1);
    expect(v.medianIntervalMs).toBe(HOUR);
    expect(v.gaps).toHaveLength(1);
    expect(v.gaps[0].gapMs).toBe(8 * HOUR);
  });

  it('descarta precios imposibles y los cuenta', () => {
    const v = validateHistoryBatch([
      row(0, { buy: -5 }),
      row(1, { sell: 'Infinity' }),
      row(2, { buy_avg: 0 }),
    ]);
    expect(v.nonFiniteValues).toBe(3);
    expect(v.points[0].buy).toBeNull();
    // El resto de la fila se conserva: sólo se pierde el valor malo.
    expect(v.points[0].sell).toBe(945);
  });

  it('una fila sin ni un precio utilizable no cuenta como observación', () => {
    const v = validateHistoryBatch([
      row(0),
      { timestamp: (T0 + HOUR) / 1000, buy: null, buy_avg: null, sell: null, sell_avg: null },
    ]);
    expect(v.rowsReceived).toBe(2);
    expect(v.points).toHaveLength(1);
    expect(v.rejected).toBe(1);
  });

  it('mide la cobertura frente a lo que la cadencia haría esperar', () => {
    // Diez horas de span con una hora de cadencia: 11 puntos esperados.
    const v = validateHistoryBatch([row(0), row(1), row(2), row(10)]);
    expect(v.expectedPoints).toBe(11);
    expect(v.coveragePct).toBeCloseTo((4 / 11) * 100, 6);
  });

  it('publica el esquema real, anonimizando el texto', () => {
    /*
     * Ésta es la respuesta a "¿qué variables históricas tenemos realmente?".
     * Los números se ven; el texto NO, porque un campo de texto en una
     * respuesta P2P puede ser el nick de un comerciante y esto acaba en los
     * logs de Railway.
     */
    const v = validateHistoryBatch([row(0, { merchant: 'NombreDeUnComerciante', volume: 1500 })]);
    const byKey = Object.fromEntries(v.schemaSummary.map((e) => [e.key, e]));

    expect(byKey.volume.example).toBe('1500');
    expect(byKey.merchant.type).toBe('string');
    expect(byKey.merchant.example).not.toContain('NombreDeUnComerciante');
    expect(byKey.merchant.example).toMatch(/texto, \d+ car\./);
  });

  it('detecta volumen, anuncios y spread, o dice que no están', () => {
    const conVolumen = validateHistoryBatch([row(0, { volume: 900, ads_count: 12 })]);
    expect(conVolumen.detectedFields.volume).toBe('volume');
    expect(conVolumen.detectedFields.ads).toBe('ads_count');

    // Si sólo hay precios agregados, se dice: no se inventa profundidad.
    const soloPrecios = validateHistoryBatch([row(0)]);
    expect(soloPrecios.detectedFields.volume).toBeNull();
    expect(soloPrecios.detectedFields.ads).toBeNull();
    expect(soloPrecios.detectedFields.spread).toBeNull();
  });

  it('un lote vacío o un error del servidor no lanzan', () => {
    expect(validateHistoryBatch([]).points).toEqual([]);
    expect(validateHistoryBatch({ error: 'forbidden' }).rejectionReasons.join(' ')).toContain(
      'no contiene ningún array'
    );
    expect(validateHistoryBatch(null).points).toEqual([]);
  });
});

/**
 * EL CLIENTE: MÉTODO HTTP Y DISECCIÓN DE LA RESPUESTA
 * ==================================================
 *
 * Aquí SÍ se sustituye `fetch`, y conviene decir por qué eso no contradice el
 * encabezado de este fichero. No se está simulando p2p.army para fingir que la
 * integración funciona: la integración se sigue probando contra el servidor real
 * en el probe. Lo que se comprueba aquí es LO QUE NOSOTROS ENVIAMOS y CÓMO
 * INTERPRETAMOS lo que llega — dos cosas que ocurren enteras dentro de este
 * proceso y que la API real no puede validar por nosotros.
 *
 * Existe por un fallo concreto: la fase 1 consultó el histórico por GET con los
 * parámetros en la query. El servidor lee el cuerpo, no la query, así que
 * respondió 200 con cero registros y el informe lo leyó como "no hay datos".
 * Estas pruebas fijan la diferencia entre GET y POST para que no vuelva a
 * pasarse por alto.
 */
describe('el cliente construye la petición que dice construir', () => {
  const withFetch = async (
    impl: (url: string, init: RequestInit) => Promise<Response>,
    run: () => Promise<void>
  ) => {
    const original = globalThis.fetch;
    const key = process.env[API_KEY_ENV];
    process.env[API_KEY_ENV] = 'clave-local-de-prueba';
    globalThis.fetch = ((url: string, init: RequestInit) => impl(url, init)) as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
      if (key === undefined) delete process.env[API_KEY_ENV];
      else process.env[API_KEY_ENV] = key;
    }
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('POST manda los parámetros en el cuerpo, no en la query', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;

    await withFetch(
      async (url, init) => {
        seenUrl = url;
        seenInit = init;
        return json({ data: [] });
      },
      async () => {
        await callP2PArmy({
          path: '/v1/api/history/p2p_prices',
          method: 'POST',
          body: { market: 'binance', fiat: 'VES', asset: 'USDT', limit: 200 },
        });
      }
    );

    expect(seenInit?.method).toBe('POST');
    // El fallo de la fase 1 al revés: los filtros van donde el servidor los mira.
    expect(seenUrl).not.toContain('market=');
    expect(seenUrl).not.toContain('fiat=');
    expect(JSON.parse(String(seenInit?.body))).toEqual({
      market: 'binance',
      fiat: 'VES',
      asset: 'USDT',
      limit: 200,
    });
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('GET no lleva cuerpo y sí lleva query', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;

    await withFetch(
      async (url, init) => {
        seenUrl = url;
        seenInit = init;
        return json([]);
      },
      async () => {
        await callP2PArmy({ path: '/v1/api/ping', query: { market: 'binance' } });
      }
    );

    expect(seenInit?.method).toBe('GET');
    expect(seenInit?.body).toBeUndefined();
    expect(seenUrl).toContain('market=binance');
  });

  it('la clave viaja sólo en la cabecera: ni en la URL ni en el cuerpo', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;

    await withFetch(
      async (url, init) => {
        seenUrl = url;
        seenInit = init;
        return json({ data: [] });
      },
      async () => {
        await callP2PArmy({
          path: '/v1/api/history/p2p_prices',
          method: 'POST',
          body: { market: 'binance' },
        });
      }
    );

    const headers = seenInit?.headers as Record<string, string>;
    expect(headers['X-APIKEY']).toBe('clave-local-de-prueba');
    expect(seenUrl).not.toContain('clave-local-de-prueba');
    expect(String(seenInit?.body)).not.toContain('clave-local-de-prueba');
  });
});

describe('el cliente distingue lo que la fase 1 no supo distinguir', () => {
  const withFetch = async (response: Response | Error, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    const key = process.env[API_KEY_ENV];
    process.env[API_KEY_ENV] = 'clave-local-de-prueba';
    globalThis.fetch = (async () => {
      if (response instanceof Error) throw response;
      return response;
    }) as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
      if (key === undefined) delete process.env[API_KEY_ENV];
      else process.env[API_KEY_ENV] = key;
    }
  };

  it('un 200 que devuelve HTML no se presenta como JSON', async () => {
    await withFetch(
      new Response('<html><body>  Not found  </body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      async () => {
        const res = await callP2PArmy({ path: '/v1/api/lo-que-sea' });
        expect(res.status).toBe(200);
        expect(res.isJson).toBe(false);
        expect(res.contentType).toContain('text/html');
        expect(res.rootKeys).toEqual([]);
        // El preview colapsa espacios: en un log de Railway una sola línea se lee.
        expect(res.bodyPreview).toBe('<html><body> Not found </body></html>');
        expect(res.bodyLength).toBeGreaterThan(0);
      }
    );
  });

  it('publica las claves de la raíz para poder nombrar el envoltorio', async () => {
    await withFetch(
      new Response(JSON.stringify({ status: 'ok', data: [], total: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      async () => {
        const res = await callP2PArmy({ path: '/v1/api/history/p2p_prices', method: 'POST' });
        expect(res.isJson).toBe(true);
        expect(res.rootKeys).toEqual(['status', 'data', 'total']);
        // 200 con envoltorio y cero filas: el estado exacto que hay que poder ver.
        expect(extractRows(res.body)).toEqual([]);
      }
    );
  });

  it('un array pelado no tiene claves de raíz y no se inventa ninguna', async () => {
    await withFetch(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      async () => {
        const res = await callP2PArmy({ path: '/v1/api/history/p2p_prices', method: 'POST' });
        expect(res.rootKeys).toEqual([]);
        expect(res.isJson).toBe(true);
      }
    );
  });

  it('un fallo de red se informa como tal y sin la credencial', async () => {
    await withFetch(new Error('getaddrinfo ENOTFOUND p2p.army'), async () => {
      const res = await callP2PArmy({ path: '/v1/api/ping' });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0); // 0 = no hubo respuesta, distinto de cualquier HTTP
      expect(res.error).toContain('ENOTFOUND');
      expect(res.error).not.toContain('clave-local-de-prueba');
      expect(res.isJson).toBe(false);
      expect(res.bodyLength).toBe(0);
      expect(res.rootKeys).toEqual([]);
    });
  });
});
