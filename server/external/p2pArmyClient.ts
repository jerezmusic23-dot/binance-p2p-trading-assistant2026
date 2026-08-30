/**
 * ADAPTADOR AISLADO PARA P2P.ARMY
 * ===============================
 *
 * Cliente de sólo lectura para el histórico de precios P2P de p2p.army.
 *
 * ═══ AISLADO DE VERDAD ═══
 *
 * Nada del bot importa este módulo. No toca `market_history.json`, ni el
 * polling de Binance, ni las oportunidades, ni Telegram, ni el motor de
 * proyección. Existe para responder UNA pregunta —¿podemos traer histórico
 * real y cuánto?— y hasta que esa respuesta sea sí, no se conecta a nada.
 *
 * ═══ LA CLAVE NO SE GUARDA, NO SE IMPRIME, NO SE DEVUELVE ═══
 *
 * `P2P_ARMY_API_KEY` se lee de `process.env` en el momento de construir la
 * petición y viaja sólo en la cabecera `X-APIKEY`. No se copia a ningún campo
 * del resultado, no aparece en los mensajes de error y `describeRequest()`
 * existe precisamente para poder registrar qué se pidió sin registrar con qué
 * credencial. Hay un test que lo comprueba.
 *
 * ═══ LO QUE ESTÁ VERIFICADO Y LO QUE NO ═══
 *
 * VERIFICADO (documentación pública de p2p.army, consultada 2026-08-29):
 *   - Endpoint de histórico: /v1/api/history/p2p_prices
 *   - Autenticación por cabecera X-APIKEY; `ping` y `time` no la exigen
 *   - Acepta market, fiat, asset, método de pago y límite
 *   - Base de datos de Binance recopilada desde marzo de 2023
 *   - El histórico está en los planes de pago (Pro / Business)
 *
 * NO VERIFICADO, y por eso NO se codifica aquí como si lo estuviera:
 *   - Los nombres exactos de los parámetros y de los campos de respuesta
 *   - Qué valores de método de pago admite VES
 *   - Los límites de paginación y de frecuencia
 *
 * Esas cuatro cosas las DESCUBRE el probe en ejecución (scripts/p2p-army-probe.ts)
 * contra la API real. Inventarlas aquí habría producido un cliente que compila,
 * pasa tests y falla contra el servidor de verdad.
 */

export const P2P_ARMY_BASE_URL = process.env.P2P_ARMY_BASE_URL ?? 'https://p2p.army';

/** Nombre de la variable. El VALOR nunca sale de este módulo. */
export const API_KEY_ENV = 'P2P_ARMY_API_KEY';

export interface P2PArmyRequest {
  path: string;
  /**
   * Método HTTP.
   *
   * `/history/p2p_prices` es POST según su documentación. Se hizo GET en el
   * primer probe y el servidor devolvió 200 con cuerpo vacío en lugar de un
   * 405: los parámetros viajaban en la query, donde no los mira, así que la
   * respuesta parecía "no hay datos" cuando en realidad era "no me has
   * preguntado nada". De ahí que el método sea explícito aquí.
   */
  method?: 'GET' | 'POST';
  /** Parámetros de consulta. Nunca debe incluir credenciales. */
  query?: Record<string, string | number | undefined>;
  /** Cuerpo JSON para POST. Nunca debe incluir credenciales. */
  body?: Record<string, unknown>;
  /** Algunas rutas (ping/time) no exigen clave. */
  requiresKey?: boolean;
  timeoutMs?: number;
}

export interface P2PArmyResponse {
  ok: boolean;
  status: number;
  /** Cuerpo ya parseado, o el texto crudo si no era JSON. */
  body: unknown;
  /** URL pedida SIN credenciales, apta para registrar. */
  requestedUrl: string;
  method: string;
  durationMs: number;
  /** Cabeceras útiles para deducir límites de frecuencia. */
  rateLimitHeaders: Record<string, string>;
  error: string | null;

  /*
   * DIAGNÓSTICO DE LA RESPUESTA CRUDA.
   *
   * Sin esto, un 200 que devuelve HTML es indistinguible de un 200 que
   * devuelve un JSON vacío, y las dos cosas significan problemas
   * completamente distintos.
   */
  contentType: string | null;
  bodyLength: number;
  isJson: boolean;
  /** Primeras claves del objeto raíz, o [] si no es un objeto. */
  rootKeys: string[];
  /** Primeros caracteres del cuerpo crudo, para ver qué llegó de verdad. */
  bodyPreview: string;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      `Falta ${API_KEY_ENV} en el entorno. Esta comprobación necesita ejecutarse ` +
        `donde la variable esté configurada (Railway), no en un contenedor de desarrollo.`
    );
    this.name = 'MissingApiKeyError';
  }
}

/** true si la clave está disponible. NO devuelve ni registra su valor. */
export function hasApiKey(): boolean {
  const key = process.env[API_KEY_ENV];
  return typeof key === 'string' && key.trim().length > 0;
}

/** URL completa sin credenciales: lo que se puede escribir en un log. */
export function describeRequest(request: P2PArmyRequest): string {
  const url = new URL(request.path, P2P_ARMY_BASE_URL);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Cabeceras que suelen describir el consumo de cuota.
 *
 * Se recogen en vez de suponerlas: el informe necesita decir cuál es el límite
 * real, y eso sólo lo sabe el servidor.
 */
const RATE_LIMIT_HEADER_HINTS = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
];

/**
 * Ejecuta una petición real. Sin mocks: si no hay red o no hay clave, esto
 * falla y lo dice, que es información igual de válida que un 200.
 */
export async function callP2PArmy(request: P2PArmyRequest): Promise<P2PArmyResponse> {
  const requestedUrl = describeRequest(request);
  const started = Date.now();

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (request.requiresKey !== false) {
    const key = process.env[API_KEY_ENV];
    if (typeof key !== 'string' || key.trim() === '') throw new MissingApiKeyError();
    headers['X-APIKEY'] = key.trim();
  }

  const method = request.method ?? 'GET';
  let payload: string | undefined;
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(request.body ?? {});
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 20_000);

  const failed = (error: string): P2PArmyResponse => ({
    ok: false,
    status: 0,
    body: null,
    requestedUrl,
    method,
    durationMs: Date.now() - started,
    rateLimitHeaders: {},
    error,
    contentType: null,
    bodyLength: 0,
    isJson: false,
    rootKeys: [],
    bodyPreview: '',
  });

  try {
    const res = await fetch(requestedUrl, {
      method,
      headers,
      body: payload,
      signal: controller.signal,
    });
    const text = await res.text();

    let body: unknown = text;
    let isJson = false;
    try {
      body = JSON.parse(text);
      isJson = true;
    } catch {
      // Se conserva el texto: un HTML de error dice tanto como un JSON.
    }

    const rateLimitHeaders: Record<string, string> = {};
    for (const hint of RATE_LIMIT_HEADER_HINTS) {
      const value = res.headers.get(hint);
      if (value !== null) rateLimitHeaders[hint] = value;
    }

    return {
      ok: res.ok,
      status: res.status,
      body,
      requestedUrl,
      method,
      durationMs: Date.now() - started,
      rateLimitHeaders,
      error: res.ok ? null : `HTTP ${res.status}`,
      contentType: res.headers.get('content-type'),
      bodyLength: text.length,
      isJson,
      rootKeys:
        isJson && body !== null && typeof body === 'object' && !Array.isArray(body)
          ? Object.keys(body as Record<string, unknown>)
          : [],
      // Recortado: sólo hace falta ver QUÉ llegó, no todo lo que llegó.
      bodyPreview: text.slice(0, 240).replace(/\s+/g, ' '),
    };
  } catch (err: unknown) {
    // El mensaje de red nunca contiene la clave: viaja en una cabecera.
    return failed(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeout);
  }
}
