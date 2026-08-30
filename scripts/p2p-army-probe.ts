/**
 * PROBE REAL DE P2P.ARMY — FASE 2: POR QUÉ UN 200 SIN REGISTROS
 * =============================================================
 *
 * La primera ejecución devolvió HTTP 200 en todas las rutas y CERO registros en
 * todas ellas. Esta versión NO vuelve a hacer lo mismo esperando otro resultado:
 * está construida para DISTINGUIR entre las explicaciones posibles de ese 200.
 *
 * ═══ EL FALLO DE LA VERSIÓN ANTERIOR ═══
 *
 * `/v1/api/history/p2p_prices` es POST. Se consultó con GET y los parámetros en
 * la query. Un servidor que acepta ambos métodos y lee el cuerpo —no la query—
 * recibe una petición SIN filtros y responde con un conjunto vacío. El 200 no
 * significaba "no hay datos": significaba "no me has preguntado nada". Esta
 * versión manda POST con cuerpo JSON, que es la corrección directa, y además
 * conserva una petición GET idéntica para PROBAR esa diferencia en la misma
 * ejecución en vez de afirmarla.
 *
 * ═══ SIN CONTROLES, UN 200 NO DICE NADA ═══
 *
 * Dos controles hacen falta para poder interpretar cualquier respuesta:
 *
 *   RUTA INEXISTENTE — se pide a propósito una ruta que no puede existir. Si
 *   devuelve 200 con cuerpo vacío, entonces "200 + vacío" es exactamente lo que
 *   este servidor contesta a lo que no conoce, y los cuatro catálogos vacíos de
 *   la fase 1 quedan explicados sin suponer nada: esas rutas no existen.
 *
 *   PARÁMETROS IMPOSIBLES — se pide el histórico de un mercado y una moneda que
 *   no existen. Si eso también devuelve 200 y vacío, el servidor NO valida la
 *   entrada, y por tanto un 200 vacío con parámetros correctos tampoco prueba
 *   que no haya datos. Si en cambio devuelve un error, entonces sí valida, y el
 *   vacío de la consulta buena pasa a ser una respuesta con contenido.
 *
 * Sin estos dos controles cualquier conclusión sería una suposición con formato
 * de informe.
 *
 * ═══ LOS ESTADOS NO SE COLAPSAN ═══
 *
 * API_ACCESSIBLE, AUTHENTICATED, ENDPOINT_ACCESSIBLE y DATA_AVAILABLE se
 * informan por separado. Un 200 nunca se convierte en "disponible": DATA_AVAILABLE
 * exige registros parseados, con fechas y precios. Es la confusión que produjo el
 * informe optimista de la fase 1.
 *
 * ═══ PRESUPUESTO ═══
 *
 * Seis peticiones planificadas y una séptima que SÓLO se gasta si el servidor
 * revela vocabulario válido (un mensaje de error que nombre parámetros o valores).
 * No se prueban métodos de pago uno a uno: hasta saber si `payment_method` es
 * obligatorio, eso sería quemar el presupuesto adivinando.
 *
 * ═══ NO IMPORTA NADA ═══
 *
 * No escribe ficheros, no toca `market_history.json` ni `forecast_log.json`, no
 * alimenta el motor de proyección. Sólo diagnostica.
 *
 * ═══ LA CLAVE ═══
 *
 * Se lee de process.env y viaja sólo en la cabecera X-APIKEY. Nada de lo que
 * esto imprime la contiene, ni siquiera los mensajes de error.
 */

import {
  API_KEY_ENV,
  P2P_ARMY_BASE_URL,
  callP2PArmy,
  hasApiKey,
  type P2PArmyResponse,
} from '../server/external/p2pArmyClient.js';
import { extractRows, validateHistoryBatch, type HistoryValidation } from '../server/external/p2pArmyHistory.js';

/** 6 planificadas + 1 reservada para seguir una pista que dé el servidor. */
const MAX_REQUESTS = 7;
const REQUEST_TIMEOUT_MS = 15_000;

const HISTORY_PATH = '/v1/api/history/p2p_prices';

/**
 * Ruta que no puede existir. Lleva un sufijo aleatorio para que no pueda
 * coincidir jamás con algo real ni quedar cacheada de una ejecución anterior.
 */
const NONEXISTENT_PATH = `/v1/api/__ruta_inexistente_de_control_${Math.random().toString(36).slice(2, 10)}`;

const out: string[] = [];
const say = (s = '') => out.push(s);
const flush = () => console.log(out.join('\n'));

let spent = 0;

/*
 * Estado compartido con el formateador: `notRun()` necesita saber POR QUÉ se
 * saltó una petición, y quien la salta es main(). Se declaran aquí en vez de
 * pasarlos por parámetro a cada llamada de `describe`.
 */
let apiAccessible = false;
let authRejected = false;

interface Attempt {
  label: string;
  method: string;
  url: string;
  status: number;
  contentType: string | null;
  bodyLength: number;
  isJson: boolean;
  rootKeys: string[];
  preview: string;
  error: string | null;
}

const attempts: Attempt[] = [];

async function request(
  label: string,
  init: {
    path: string;
    method?: 'GET' | 'POST';
    query?: Record<string, string | number | undefined>;
    body?: Record<string, unknown>;
    requiresKey?: boolean;
  }
): Promise<P2PArmyResponse | null> {
  if (spent >= MAX_REQUESTS) return null;
  spent += 1;

  const res = await callP2PArmy({ ...init, timeoutMs: REQUEST_TIMEOUT_MS });
  attempts.push({
    label,
    method: res.method,
    url: res.requestedUrl,
    status: res.status,
    contentType: res.contentType,
    bodyLength: res.bodyLength,
    isJson: res.isJson,
    rootKeys: res.rootKeys,
    preview: res.bodyPreview,
    error: res.error,
  });
  return res;
}

function section(title: string, body: string | string[]): void {
  say();
  say(`${title}:`);
  for (const line of Array.isArray(body) ? body : [body]) say(`  ${line}`);
}

/**
 * Por qué una petición no llegó a hacerse.
 *
 * Decir "presupuesto agotado" cuando la causa fue que no había conectividad
 * manda a pedir más cuota para arreglar un problema de red. Es el mismo tipo de
 * confusión que produjo el informe de la fase 1, así que la causa se nombra.
 */
function notRun(): string {
  if (!apiAccessible) return 'NO EJECUTADA — el ping no respondió 2xx: no se llegó al servidor';
  if (authRejected) return 'NO EJECUTADA — la API rechazó la credencial';
  return 'NO EJECUTADA — presupuesto de peticiones agotado';
}

/** Ficha cruda de una respuesta. Es la materia prima del diagnóstico. */
function describe(res: P2PArmyResponse | null): string[] {
  if (res === null) return [notRun()];
  return [
    `${res.method} ${res.requestedUrl}`,
    `HTTP ${res.status}${res.error ? ` (${res.error})` : ''} · ${res.durationMs} ms`,
    `Content-Type: ${res.contentType ?? '—'}`,
    `tamaño del cuerpo: ${res.bodyLength} caracteres · JSON válido: ${res.isJson ? 'sí' : 'NO'}`,
    `claves de la raíz: ${res.rootKeys.length > 0 ? res.rootKeys.join(', ') : '(ninguna: no es un objeto)'}`,
    `cuerpo: ${res.bodyPreview === '' ? '(vacío)' : res.bodyPreview}`,
  ];
}

/** ¿Trae un array de registros y cuántos? Distinto de "respondió 200". */
function rowCount(res: P2PArmyResponse | null): number | null {
  if (res === null || !res.isJson) return null;
  const rows = extractRows(res.body);
  return rows === null ? null : rows.length;
}

/** Lo mismo, en texto, sin confundir "no se pidió" con "no venía ningún array". */
function rowCountLabel(res: P2PArmyResponse | null): string {
  if (res === null) return notRun();
  if (!res.isJson) return 'la respuesta no era JSON';
  const n = rowCount(res);
  return n === null ? 'JSON sin ningún array de registros' : String(n);
}

/**
 * Un mensaje de error del servidor suele nombrar el parámetro que falta o los
 * valores que acepta. Es la única fuente legítima de vocabulario: lo demás
 * sería inventarlo.
 */
function serverMessage(res: P2PArmyResponse | null): string | null {
  if (res === null || !res.isJson || res.body === null || typeof res.body !== 'object') return null;
  const obj = res.body as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail', 'details', 'msg', 'errors', 'reason']) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim() !== '') return `${key}: ${value.slice(0, 300)}`;
    if (value !== undefined && value !== null && typeof value === 'object') {
      return `${key}: ${JSON.stringify(value).slice(0, 300)}`;
    }
  }
  return null;
}

async function main(): Promise<void> {
  say('========== P2P.ARMY REAL PROBE — FASE 2 (DIAGNÓSTICO) ==========');
  say(`Timestamp: ${new Date().toISOString()}`);
  say(`Base URL: ${P2P_ARMY_BASE_URL}`);
  say(`${API_KEY_ENV} present: ${hasApiKey()}`);

  if (!hasApiKey()) {
    say();
    say(`ABORTED: ${API_KEY_ENV} no está en el entorno de ejecución.`);
    say('Sin clave no hay prueba real, y simular una sería peor que no tenerla.');
    say('========== END P2P.ARMY REAL PROBE ==========');
    flush();
    return;
  }

  /* ── R1. ¿Se llega al servidor? ──────────────────────────────────────── */
  const ping = await request('R1 ping (sin clave)', { path: '/v1/api/ping', requiresKey: false });
  // CONECTIVIDAD = respondió 2xx. Un 403 puede venir de un intermediario que
  // ni siquiera dejó salir la petición; darlo por "hablamos con p2p.army"
  // manda a revisar una credencial que está bien.
  apiAccessible = ping !== null && ping.ok;
  section('R1 · ¿la API responde?', describe(ping));

  /* ── R2. ¿La clave vale? ─────────────────────────────────────────────── */
  const authed = apiAccessible ? await request('R2 autenticación', { path: '/v1/api/time' }) : null;
  const authenticated = authed !== null && authed.ok;
  authRejected = authed !== null && (authed.status === 401 || authed.status === 403);
  section('R2 · ¿la clave es aceptada?', describe(authed));

  /* ── R3. CONTROL: ruta que no existe ─────────────────────────────────── */
  /*
   * Calibra el significado de un 200. Todo lo que se concluya de las respuestas
   * siguientes depende de saber qué contesta este servidor a lo que no conoce.
   */
  const control404 = apiAccessible ? await request('R3 control: ruta inexistente', { path: NONEXISTENT_PATH }) : null;
  section('R3 · CONTROL, ruta que no puede existir', describe(control404));

  const unknownRouteReturns200 = control404 !== null && control404.status === 200;
  section(
    'R3 · lectura del control',
    control404 === null
      ? 'no ejecutado'
      : unknownRouteReturns200
        ? [
            'Una ruta inexistente devuelve HTTP 200.',
            'CONSECUENCIA: en esta API un 200 NO prueba que la ruta exista.',
            'Los cuatro catálogos vacíos de la fase 1 quedan explicados por esto.',
          ]
        : [
            `Una ruta inexistente devuelve HTTP ${control404.status}.`,
            'CONSECUENCIA: el servidor SÍ distingue rutas. Un 200 en otra ruta significa que esa ruta existe.',
          ]
  );

  /* ── R4. El histórico, POST y con cuerpo ─────────────────────────────── */
  /*
   * Parámetros: sólo los que la documentación pública nombra Y cuyo valor se
   * puede formar sin inventar vocabulario.
   *
   *   market / fiat / asset  → valores evidentes.
   *   from_date / to_date    → nombres documentados; el FORMATO no está
   *                            verificado, se envía ISO 'YYYY-MM-DD' y si es
   *                            incorrecto el error del servidor lo dirá.
   *   limit                  → documentado.
   *
   * Se OMITEN a propósito `payment_method`, `mode`, `period_type` y `date_format`:
   * sus nombres están documentados pero sus VALORES admitidos no. Enviarlos con
   * un valor adivinado convertiría un "no hay datos" en un "rechazado por un
   * parámetro que me inventé", indistinguibles en el resultado. Si alguno es
   * obligatorio, el servidor lo dirá y R7 lo recoge.
   */
  const day = (offsetDays: number) =>
    new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);

  const historyBody: Record<string, unknown> = {
    market: 'binance',
    fiat: 'VES',
    asset: 'USDT',
    from_date: day(7),
    to_date: day(0),
    limit: 200,
  };

  const post = apiAccessible && !authRejected
    ? await request('R4 histórico POST', { path: HISTORY_PATH, method: 'POST', body: historyBody })
    : null;
  section('R4 · histórico por POST (cuerpo JSON)', [
    `cuerpo enviado: ${JSON.stringify(historyBody)}`,
    ...describe(post),
  ]);

  /* ── R5. CONTROL: los mismos parámetros por GET ──────────────────────── */
  /*
   * A/B en la misma ejecución. Si POST trae registros y GET no, la causa del
   * 200 vacío de la fase 1 queda demostrada, no argumentada.
   */
  const get = apiAccessible && !authRejected
    ? await request('R5 control: mismo histórico por GET', {
        path: HISTORY_PATH,
        method: 'GET',
        query: {
          market: 'binance',
          fiat: 'VES',
          asset: 'USDT',
          from_date: day(7),
          to_date: day(0),
          limit: 200,
        },
      })
    : null;
  section('R5 · CONTROL, el mismo histórico por GET', describe(get));

  /* ── R6. CONTROL: parámetros imposibles ──────────────────────────────── */
  /*
   * ¿Valida el servidor lo que recibe? Si un mercado y una moneda inexistentes
   * dan el mismo 200 vacío que la consulta correcta, entonces el vacío no
   * informa de nada sobre la disponibilidad de datos.
   */
  const nonsenseBody: Record<string, unknown> = {
    market: '__mercado_que_no_existe__',
    fiat: 'ZZZ',
    asset: '__moneda_que_no_existe__',
    from_date: day(7),
    to_date: day(0),
    limit: 5,
  };
  const nonsense = apiAccessible && !authRejected
    ? await request('R6 control: parámetros imposibles', {
        path: HISTORY_PATH,
        method: 'POST',
        body: nonsenseBody,
      })
    : null;
  section('R6 · CONTROL, parámetros imposibles', [
    `cuerpo enviado: ${JSON.stringify(nonsenseBody)}`,
    ...describe(nonsense),
  ]);

  const validatesInput =
    nonsense !== null && post !== null && (nonsense.status !== post.status || nonsense.bodyLength !== post.bodyLength);
  section(
    'R6 · lectura del control',
    nonsense === null
      ? 'no ejecutado'
      : validatesInput
        ? [
            'Parámetros imposibles producen una respuesta DISTINTA de la consulta válida.',
            'CONSECUENCIA: el servidor valida la entrada; un vacío en la consulta válida sí es informativo.',
          ]
        : [
            'Parámetros imposibles producen la MISMA respuesta que la consulta válida.',
            'CONSECUENCIA: el servidor no valida (o no diferencia) la entrada.',
            'Un 200 vacío con parámetros correctos NO prueba ausencia de datos.',
          ]
  );

  /* ── R7. Reservada: sólo si el servidor reveló vocabulario ───────────── */
  /*
   * No se gasta a ciegas. Únicamente si R4 o R6 devolvieron un mensaje de error
   * que nombra un parámetro que falta o unos valores admitidos.
   */
  const hint = serverMessage(post) ?? serverMessage(nonsense);
  let followUp: P2PArmyResponse | null = null;
  if (hint !== null && post !== null && !post.ok) {
    followUp = await request('R7 reintento guiado por el mensaje del servidor', {
      path: HISTORY_PATH,
      method: 'POST',
      // Mismo cuerpo: lo que cambia es que ahora el informe lleva el mensaje
      // literal del servidor, que es lo que permitirá construir el cuerpo
      // correcto en la fase siguiente sin adivinar.
      body: historyBody,
    });
  }
  section(
    'R7 · pista del servidor',
    hint === null
      ? 'el servidor no devolvió ningún mensaje que nombre parámetros ni valores'
      : [`mensaje literal: ${hint}`, ...(followUp ? describe(followUp) : ['no se reintentó'])]
  );

  /* ── Lectura de los datos, si los hay ────────────────────────────────── */
  const best = [post, followUp, get].find((r) => r !== null && r.ok && (rowCount(r) ?? 0) > 0) ?? post;
  let validation: HistoryValidation | null = null;
  if (best !== null && best !== undefined && best.isJson) validation = validateHistoryBatch(best.body);

  const iso = (t: number | null | undefined) => (t == null ? '—' : new Date(t).toISOString());
  const f = validation?.detectedFields;

  section('Registros devueltos (POST)', rowCountLabel(post));
  section('Registros devueltos (GET)', rowCountLabel(get));
  section('Registros válidos tras parsear', String(validation?.points.length ?? 0));
  section('Fecha más antigua', iso(validation?.firstTimestamp));
  section('Fecha más reciente', iso(validation?.lastTimestamp));
  section(
    'Granularidad medida',
    validation?.medianIntervalMs == null
      ? '—'
      : `${(validation.medianIntervalMs / 60000).toFixed(1)} min (mediana real, no la pedida)`
  );
  section('Campos detectados', f ? JSON.stringify(f) : '—');
  section('Variables de profundidad', [
    `volumen: ${f?.volume ?? 'NO PRESENTE'}`,
    `nº de anuncios: ${f?.ads ?? 'NO PRESENTE'}`,
    `spread: ${f?.spread ?? 'NO PRESENTE'}`,
  ]);
  section(
    'Esquema crudo del primer registro',
    validation && validation.schemaSummary.length > 0
      ? validation.schemaSummary.map((s) => `${s.key}: ${s.type} = ${s.example}`)
      : '— (no llegó ningún registro que inspeccionar)'
  );

  /* ── Estados, sin colapsar ───────────────────────────────────────────── */
  /*
   * Cuatro preguntas distintas. La fase 1 las respondió con una sola palabra y
   * por eso dijo "AVAILABLE" de un endpoint que no había devuelto ni un dato.
   */
  const endpointAccessible =
    post !== null && post.ok && (unknownRouteReturns200 ? validatesInput : true);
  const dataAvailable = (validation?.points.length ?? 0) > 0;

  section('ESTADOS', [
    `API_ACCESSIBLE      : ${apiAccessible ? 'sí' : 'NO'} — ${
      apiAccessible ? 'el ping respondió 2xx' : 'no hubo respuesta 2xx del ping'
    }`,
    `AUTHENTICATED       : ${
      authenticated
        ? 'sí — una ruta con clave respondió 2xx'
        : authRejected
          ? 'NO — la API rechazó la clave (401/403)'
          : 'DESCONOCIDO — no se pudo comprobar'
    }`,
    `ENDPOINT_ACCESSIBLE : ${
      post === null
        ? 'NO COMPROBADO'
        : endpointAccessible
          ? 'sí — la ruta existe y responde'
          : unknownRouteReturns200
            ? 'INDETERMINADO — un 200 aquí no distingue de una ruta inexistente'
            : `NO — HTTP ${post.status}`
    }`,
    `DATA_AVAILABLE      : ${
      dataAvailable
        ? `sí — ${validation?.points.length} registros con fecha y precio`
        : 'NO — no llegó ni un registro utilizable'
    }`,
    '',
    'DATA_AVAILABLE exige registros parseados. Un HTTP 200 nunca se cuenta como',
    'datos disponibles: ese fue exactamente el error del informe anterior.',
  ]);

  /* ── Diagnóstico del 200 sin registros ───────────────────────────────── */
  const verdict: string[] = [];
  if (post === null) {
    verdict.push('No se pudo consultar el histórico; no hay diagnóstico posible.');
  } else if (dataAvailable) {
    verdict.push('CAUSA CONFIRMADA: el método HTTP. Con POST y cuerpo JSON llegan registros.');
    verdict.push(`POST devolvió ${rowCount(post) ?? 0} filas; GET devolvió ${rowCount(get) ?? 0}.`);
    verdict.push('El 200 vacío de la fase 1 era una consulta sin filtros, no una ausencia de datos.');
  } else if (unknownRouteReturns200 && post.status === 200) {
    verdict.push('CAUSA CONFIRMADA: este servidor responde 200 a rutas que no existen.');
    verdict.push('Un 200 vacío aquí es indistinguible de "esta ruta no está publicada".');
    verdict.push('Explica también los cuatro catálogos vacíos sin necesidad de otra hipótesis.');
  } else if (post.status === 402 || post.status === 403) {
    verdict.push(`CAUSA CONFIRMADA: restricción de plan o de permisos (HTTP ${post.status}).`);
  } else if (post.status === 200 && !validatesInput) {
    verdict.push('CAUSA PROBABLE: el servidor ignora los parámetros que enviamos.');
    verdict.push('Parámetros imposibles dan la misma respuesta que los correctos.');
    verdict.push('Falta por determinar el nombre o el formato exacto que sí lee.');
  } else if (post.status === 200 && validatesInput) {
    verdict.push('CAUSA PROBABLE: la consulta es correcta y no hay histórico para VES/USDT en ese rango.');
    verdict.push('El servidor valida la entrada, así que el vacío es una respuesta real.');
  } else {
    verdict.push(`Sin conclusión: HTTP ${post.status} y ningún mensaje que la explique.`);
  }
  section('DIAGNÓSTICO DEL 200 SIN REGISTROS', verdict);

  /* ── Trazabilidad ────────────────────────────────────────────────────── */
  section(
    'Registro de peticiones (sin credenciales)',
    attempts.flatMap((a) => [
      `${a.method.padEnd(4)} HTTP ${String(a.status).padStart(3)} · ${a.label}`,
      `     ${a.url}`,
      `     ${a.bodyLength} car. · ${a.contentType ?? 'sin content-type'} · json=${a.isJson} · raíz=[${a.rootKeys.join(', ')}]`,
      `     ${a.preview === '' ? '(cuerpo vacío)' : a.preview.slice(0, 200)}`,
    ])
  );
  section(
    'Cabeceras de límite de frecuencia',
    JSON.stringify(post?.rateLimitHeaders ?? ping?.rateLimitHeaders ?? {})
  );
  section('Peticiones gastadas', `${spent}/${MAX_REQUESTS}`);

  say();
  say('Lo que no aparezca en este informe es que NO se pudo comprobar,');
  say('no que no exista.');
  say('========== END P2P.ARMY REAL PROBE ==========');
  flush();
}

main().catch((err) => {
  say();
  say(`ERROR NO CONTROLADO: ${err instanceof Error ? err.message : String(err)}`);
  say('========== END P2P.ARMY REAL PROBE ==========');
  flush();
});
