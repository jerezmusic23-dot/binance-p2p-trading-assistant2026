/**
 * PROBE REAL DE P2P.ARMY — Binance / USDT / VES
 * ============================================
 *
 * Consulta la API real y devuelve un informe. NO escribe ficheros, NO toca
 * `market_history.json` ni `forecast_log.json`, NO importa nada al motor. Esta
 * fase es sólo diagnóstico.
 *
 * ═══ SALIDA AMORTIGUADA ═══
 *
 * El informe se acumula y se imprime DE UNA VEZ al final. Corre en paralelo al
 * arranque del servidor, y si escribiera línea a línea quedaría entrelazado con
 * los logs del polling de Binance, ilegible justo en Railway, que es donde hay
 * que leerlo.
 *
 * ═══ DESCUBRE, NO SUPONE ═══
 *
 * De la documentación pública sólo está verificado: el endpoint
 * /v1/api/history/p2p_prices, la cabecera X-APIKEY, que acepta market / fiat /
 * asset / método de pago / límite, y que el histórico va en planes de pago.
 * Los nombres exactos de parámetros, los métodos de pago válidos para VES y los
 * límites NO están verificados: los averigua aquí, contra el servidor, e
 * imprime los errores literales — cuando una API rechaza un parámetro suele
 * decir en el mensaje qué valores acepta.
 *
 * ═══ LA CLAVE ═══
 *
 * Se lee de process.env y viaja sólo en la cabecera X-APIKEY. Nada de lo que
 * esto imprime la contiene, ni siquiera en los mensajes de error.
 */

import {
  API_KEY_ENV,
  P2P_ARMY_BASE_URL,
  callP2PArmy,
  hasApiKey,
  type P2PArmyResponse,
} from '../server/external/p2pArmyClient.js';
import { validateHistoryBatch, type HistoryValidation } from '../server/external/p2pArmyHistory.js';

const MAX_REQUESTS = 14;
const REQUEST_TIMEOUT_MS = 10_000;

const out: string[] = [];
const say = (s = '') => out.push(s);
const flush = () => console.log(out.join('\n'));

let spent = 0;
const attempts: { label: string; url: string; status: number; error: string | null }[] = [];

async function request(
  label: string,
  path: string,
  query?: Record<string, string | number | undefined>,
  requiresKey = true
): Promise<P2PArmyResponse | null> {
  if (spent >= MAX_REQUESTS) return null;
  spent += 1;

  const res = await callP2PArmy({ path, query, requiresKey, timeoutMs: REQUEST_TIMEOUT_MS });
  attempts.push({ label, url: res.requestedUrl, status: res.status, error: res.error });
  return res;
}

/** Cuerpo de error recortado. Nunca contiene la clave: viaja en cabecera. */
function errorBody(res: P2PArmyResponse): string {
  if (res.body === null) return res.error ?? 'sin cuerpo';
  const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  return text.slice(0, 300);
}

function section(title: string, body: string | string[]): void {
  say();
  say(`${title}:`);
  for (const line of Array.isArray(body) ? body : [body]) say(`  ${line}`);
}

async function main(): Promise<void> {
  say('========== P2P.ARMY REAL PROBE ==========');
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

  /* ── 1. Conectividad y autenticación ────────────────────────────────── */
  const ping = await request('ping (sin clave)', '/v1/api/ping', undefined, false);

  /*
   * CONECTIVIDAD = el ping RESPONDIÓ 2xx.
   *
   * No basta con "hubo algún status". Un intermediario —proxy corporativo,
   * egress de la plataforma, WAF— puede devolver 403 sin que la petición haya
   * llegado nunca a p2p.army. Contarlo como conectividad OK y el 403 siguiente
   * como "clave rechazada" enviaría a revisar una credencial que está
   * perfectamente bien. Se comprobó en un ensayo: con la red bloqueada, el
   * probe informaba exactamente de eso.
   */
  const connectivity = ping !== null && ping.ok;
  say(`P2P.Army connectivity: ${connectivity ? 'OK' : 'FAIL'}`);
  if (ping && !ping.ok) {
    say(`  HTTP ${ping.status} · ${errorBody(ping)}`);
    if (ping.status === 0) say('  la petición no llegó a completarse (red o DNS)');
    else say('  ATENCIÓN: esta respuesta puede venir de un intermediario, no de p2p.army');
  }

  const authed = await request('autenticación', '/v1/api/time');
  const authOk = authed !== null && authed.ok;
  // Sólo se puede hablar de credencial rechazada si se llegó a hablar con ellos.
  const authRejected =
    connectivity && authed !== null && (authed.status === 401 || authed.status === 403);
  say(
    `Authentication: ${
      authOk
        ? 'OK'
        : authRejected
          ? 'FAIL (la API rechazó la clave)'
          : connectivity
            ? 'UNKNOWN'
            : 'NOT TESTED (sin conectividad)'
    }`
  );
  if (authed && !authed.ok) say(`  HTTP ${authed.status} · ${errorBody(authed)}`);

  /* ── 2. Descubrimiento de rutas y vocabulario ───────────────────────── */
  const discovered: string[] = [];
  if (connectivity) {
    for (const [label, path] of [
      ['markets', '/v1/api/markets'],
      ['fiats', '/v1/api/fiats'],
      ['assets', '/v1/api/assets'],
      ['payment methods', '/v1/api/payment_methods'],
    ] as [string, string][]) {
      const res = await request(label, path, { market: 'binance', fiat: 'VES' });
      if (res === null) continue;
      const body = res.ok ? JSON.stringify(res.body).slice(0, 400) : errorBody(res);
      discovered.push(`${label.padEnd(16)} HTTP ${res.status} · ${body}`);
    }
  }

  /* ── 3. Histórico ───────────────────────────────────────────────────── */
  const base = { market: 'binance', fiat: 'VES', asset: 'USDT', limit: 200 };
  let historyRes: P2PArmyResponse | null = null;
  let validation: HistoryValidation | null = null;
  let paymentMethodUsed = 'not required';
  let granularityAsked = '1h';

  if (connectivity && !authRejected) {
    // Sin método de pago primero: si es obligatorio, el error dirá cuáles valen.
    historyRes = await request('histórico 1h sin payment_method', '/v1/api/history/p2p_prices', {
      ...base,
      period: '1h',
    });

    if (historyRes && !historyRes.ok) {
      // Un intento con nombres alternativos, UNA vez, sin inventar métodos de pago.
      const alt = await request('histórico, variante de parámetros', '/v1/api/history/p2p_prices', {
        ...base,
        fiat: 'ves',
        asset: 'usdt',
        interval: '1h',
      });
      if (alt?.ok) {
        historyRes = alt;
        granularityAsked = '1h (parámetro `interval`)';
      }
    }
    if (historyRes?.ok) validation = validateHistoryBatch(historyRes.body);
  }

  const histOk = historyRes !== null && historyRes.ok;
  say(`Historical endpoint: ${histOk ? 'OK' : historyRes === null ? 'NOT ATTEMPTED' : 'FAIL'}`);
  say(`HTTP status: ${historyRes?.status ?? 'n/a'}`);
  if (historyRes && !historyRes.ok) say(`  respuesta: ${errorBody(historyRes)}`);

  section('Market', 'Binance');
  section('Fiat', 'VES');
  section('Asset', 'USDT');
  section('Payment method', paymentMethodUsed);
  section('Granularity requested', granularityAsked);

  const iso = (t: number | null | undefined) => (t == null ? '—' : new Date(t).toISOString());
  const f = validation?.detectedFields;

  section('Records returned', String(validation?.points.length ?? 0));
  section('Oldest timestamp', iso(validation?.firstTimestamp));
  section('Newest timestamp', iso(validation?.lastTimestamp));
  section(
    'Granularity returned',
    validation?.medianIntervalMs == null
      ? '—'
      : `${(validation.medianIntervalMs / 60000).toFixed(1)} min (mediana medida)`
  );
  section('Detected fields', f ? JSON.stringify(f) : '—');
  section('BUY field', f?.buy ?? 'NO PRESENTE');
  section('SELL field', f?.sell ?? 'NO PRESENTE');
  section('BUY average', f?.buyAvg ?? 'NO PRESENTE');
  section('SELL average', f?.sellAvg ?? 'NO PRESENTE');
  section('Volume/depth fields', [
    `volumen: ${f?.volume ?? 'NO PRESENTE'}`,
    `nº de anuncios: ${f?.ads ?? 'NO PRESENTE'}`,
    `spread: ${f?.spread ?? 'NO PRESENTE'}`,
  ]);

  if (validation) {
    section('Data quality', [
      `orden cronológico: ${validation.chronological ? 'sí' : 'NO — llega desordenado'}`,
      `duplicados: ${validation.duplicateTimestamps}`,
      `huecos (>1.5x cadencia): ${validation.gaps.length}`,
      `valores imposibles: ${validation.nonFiniteValues}`,
      `cobertura: ${validation.coveragePct?.toFixed(1) ?? '—'}%`,
      `descartados: ${validation.rejected}`,
      validation.rejectionReasons.length > 0
        ? `motivos: ${validation.rejectionReasons.join(' | ')}`
        : 'sin descartes',
    ]);

    section(
      'Raw response schema summary',
      validation.schemaSummary.length === 0
        ? '—'
        : validation.schemaSummary.map((s) => `${s.key}: ${s.type} = ${s.example}`)
    );

    const sample = [
      ...validation.points.slice(0, 2),
      ...validation.points.slice(-1),
    ];
    section(
      'Sample records',
      sample.length === 0
        ? '—'
        : sample.map(
            (p) =>
              `${new Date(p.t).toISOString()} buy=${p.buy ?? 'null'} buy_avg=${p.buyAvg ?? 'null'} sell=${p.sell ?? 'null'} sell_avg=${p.sellAvg ?? 'null'}`
          )
    );
  }

  /* ── 4. Profundidad histórica ───────────────────────────────────────── */
  const depth: string[] = [];
  let deepest: string | null = null;
  if (histOk) {
    const now = Date.now();
    for (const [label, days] of [
      ['7 días', 7],
      ['30 días', 30],
      ['90 días', 90],
      ['365 días', 365],
    ] as [string, number][]) {
      const since = new Date(now - days * 86_400_000).toISOString();
      const res = await request(`profundidad ${label}`, '/v1/api/history/p2p_prices', {
        ...base,
        period: '1h',
        limit: 5,
        start: since,
        from: since,
      });
      if (res === null) {
        depth.push(`${label}: no comprobado (presupuesto agotado)`);
        break;
      }
      if (!res.ok) {
        depth.push(`${label}: HTTP ${res.status} · ${errorBody(res)}`);
        break;
      }
      const v = validateHistoryBatch(res.body);
      if (v.points.length === 0) {
        depth.push(`${label}: sin datos — el histórico no llega tan atrás`);
        break;
      }
      deepest = label;
      depth.push(`${label}: hay datos, el más antiguo del lote es ${iso(v.firstTimestamp)}`);
    }
  }
  section('Historical depth probing', depth.length > 0 ? depth : 'no ejecutado');

  const access = !connectivity
    ? 'UNKNOWN (sin conectividad)'
    : authRejected
      ? 'NOT_AVAILABLE (clave rechazada)'
      : histOk
        ? 'AVAILABLE'
        : historyRes?.status === 402 || historyRes?.status === 403
          ? 'NOT_AVAILABLE (restricción de plan)'
          : 'UNKNOWN';
  section('Historical access', access);
  section(
    'Account/plan restriction',
    historyRes && !historyRes.ok ? `HTTP ${historyRes.status} · ${errorBody(historyRes)}` : 'ninguna observada'
  );
  section('Max historical depth confirmed', deepest ?? 'ninguna confirmada');

  /* ── 5. Trazabilidad ────────────────────────────────────────────────── */
  section('Endpoints discovered', discovered.length > 0 ? discovered : 'ninguno respondió');
  section(
    'Request log (sin credenciales)',
    attempts.map((a) => `HTTP ${String(a.status).padStart(3)} · ${a.label} · ${a.url}`)
  );
  section('Rate limit headers', JSON.stringify(historyRes?.rateLimitHeaders ?? {}));
  section('Requests spent', `${spent}/${MAX_REQUESTS}`);

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
