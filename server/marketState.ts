/**
 * ESTADO DE MERCADO COMPACTO, POR CAPTURA
 * =======================================
 *
 * ═══ EL PROBLEMA QUE RESUELVE ═══
 *
 * La captura recibe el libro entero (`topBuyAds`/`topSellAds`: precio, volumen,
 * límites, comerciante, métodos de pago de CADA anuncio) y `centralStore` sólo
 * persistía de él dos extremos, dos medianas, dos sumas de liquidez y dos
 * recuentos. Todo lo demás se descartaba en la frontera de almacenamiento.
 *
 * Consecuencia medida en la auditoría: profundidad, concentración, dispersión y
 * rotación del libro NO son estudiables por mucho histórico que se acumule,
 * porque el dato nunca llegó a guardarse. Ése es el cuello de botella, y es
 * anterior a cualquier modelo.
 *
 * ═══ QUÉ HACE Y QUÉ NO ═══
 *
 * Guarda AGREGADOS, no el libro. Un anuncio individual no se persiste.
 *
 * Y NO produce ninguna señal: aquí no hay pesos, ni scores, ni probabilidades,
 * ni "confianza". Es evidencia en bruto para que una fase posterior pueda
 * PREGUNTARSE si alguna de estas variables predice algo. Mientras esa pregunta
 * no se responda con histórico real, ninguna de ellas entra en la proyección.
 *
 * ═══ SEMÁNTICA ═══
 *
 * Los lados se nombran por la OPERACIÓN DEL USUARIO (`MakerLeg`), nunca por el
 * parámetro de Binance:
 *
 *   COMPRA <- topBuyAds  (tradeType=BUY:  el anunciante VENDE USDT)  quiero bajo
 *   VENTA  <- topSellAds (tradeType=SELL: el anunciante COMPRA USDT) quiero alto
 *
 * ═══ AUSENCIA ═══
 *
 * Un campo que no se pudo calcular vale `null`, JAMÁS 0. Cero es una medida
 * ("nadie publicó volumen"); `null` es la ausencia de medida ("no se pudo
 * establecer"). Confundirlos es inventar datos.
 */

import { isBetterForLeg, type MakerLeg } from './projection/hourSummary.js';
import type { MarketSnapshot, NormalizedAd } from './types.js';

/** Marca de versión del bloque. Los registros anteriores no la llevan. */
export const MARKET_STATE_VERSION = 'v5-market-state';

/**
 * Distancias al precio estratégico a las que se mide la profundidad, en %.
 *
 * No son una verdad científica: son la rejilla que el operador pidió para poder
 * investigar después. Se declaran aquí y se persisten dentro del propio
 * snapshot (`depthLevelsPct`), de modo que un registro guardado hoy siga siendo
 * interpretable si mañana la rejilla cambia.
 */
export const DEPTH_LEVELS_PCT = [0.1, 0.25, 0.5, 1] as const;

/** Cuántos anuncios entran en cada agregado de concentración. */
export const CONCENTRATION_TOPS = [1, 3, 5] as const;

export interface DepthLevel {
  /** Distancia al precio estratégico, en %. */
  pct: number;
  /** USDT declarados a un precio no peor que esa distancia. `null` si no medible. */
  usdt: number | null;
  /** Cuántos anuncios entran en ese nivel. `null` si no medible. */
  ads: number | null;
}

export interface SideState {
  leg: MakerLeg;
  /** Anuncios devueltos por la captura para este lado. */
  ads: number;
  /** Cuántos de ellos publicaron volumen. El resto no se inventa. */
  adsWithVolume: number;

  /** Mejor precio del lado según la pierna. `null` si no hay anuncios. */
  leaderPrice: number | null;
  /**
   * Distancia FIRMADA del líder a la referencia estratégica, en %.
   * Sin `Math.abs`: que el líder esté por encima o por debajo es información.
   */
  leaderGapPct: number | null;
  /**
   * Identidad técnica del líder, para poder decir si cambió entre capturas.
   * Es un hash de `advNo` (identificador del anuncio), NO el nombre del
   * comerciante: la métrica no necesita saber quién es nadie.
   */
  leaderKey: string | null;

  /** USDT declarados, sumando SÓLO los anuncios que los publicaron. */
  declaredUsdt: number | null;
  /** USDT de los N mejores anuncios del lado. */
  topUsdt: Record<number, number | null>;
  /** Fracción del volumen declarado que está en los N mejores. 0..1. */
  topShare: Record<number, number | null>;

  /** Profundidad acumulada por distancia al precio estratégico. */
  depth: DepthLevel[];

  /** Dispersión de precios del lado: percentiles y rango, en precio. */
  priceP10: number | null;
  priceP50: number | null;
  priceP90: number | null;
  /** Rango relativo (p90-p10)/p50, en %. `null` si no medible. */
  priceRangePct: number | null;

  /* ── Cambios contra la captura ANTERIOR conocida. Nunca hacia adelante. ── */
  leaderChanged: boolean | null;
  declaredUsdtDeltaPct: number | null;
  leaderPriceDeltaPct: number | null;
}

/** Participación de un método de pago dentro del lado. */
export interface PayTypeShare {
  payType: string;
  ads: number;
  usdt: number | null;
}

export interface MarketStateSnapshot {
  version: typeof MARKET_STATE_VERSION;
  capturedAt: number;
  captureStatus: 'LIVE' | 'STALE';
  /** La rejilla de profundidad usada, para que el registro sea interpretable. */
  depthLevelsPct: number[];
  compra: SideState | null;
  venta: SideState | null;
  /**
   * Banco/monto de la consulta. En la captura GENERAL no hay ninguno, y eso se
   * dice con `null` - no se inventa un banco.
   */
  filterBank: string | null;
  filterAmountVes: number | null;
  /** Composición por método de pago, por lado. Vacío si la captura no la trae. */
  payTypesCompra: PayTypeShare[];
  payTypesVenta: PayTypeShare[];
  /** Instante de la captura anterior contra la que se midieron los cambios. */
  previousAt: number | null;
}

/* ------------------------------------------------------------------------ *
 * AYUDAS
 * ------------------------------------------------------------------------ */

const usable = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Hash corto y determinista de un identificador de anuncio.
 *
 * No es criptográfico y no pretende serlo: sólo tiene que responder "¿es el
 * mismo anuncio que antes?" sin guardar el identificador ni, sobre todo, el
 * nombre del comerciante.
 */
export function leaderKeyOf(advNo: string | null | undefined): string | null {
  if (typeof advNo !== 'string' || advNo.length === 0) return null;
  let h = 2166136261;
  for (let i = 0; i < advNo.length; i += 1) {
    h ^= advNo.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Percentil por interpolación lineal sobre una muestra ya ordenada. */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Los anuncios utilizables de un lado: precio positivo y finito. */
function usableAds(ads: readonly NormalizedAd[]): NormalizedAd[] {
  return ads.filter((a) => a && usable(a.price));
}

/** Mejor primero para esta pierna. Empates por advNo, para ser determinista. */
function orderedForLeg(ads: readonly NormalizedAd[], leg: MakerLeg): NormalizedAd[] {
  return [...ads].sort((a, b) => {
    if (a.price !== b.price) return isBetterForLeg(leg, a.price, b.price) ? -1 : 1;
    return a.advNo < b.advNo ? -1 : a.advNo > b.advNo ? 1 : 0;
  });
}

/**
 * Suma de USDT declarados. `null` cuando NADIE publicó volumen: eso no es cero
 * liquidez, es liquidez desconocida.
 */
function declaredUsdtOf(ads: readonly NormalizedAd[]): { usdt: number | null; ads: number } {
  let total = 0;
  let count = 0;
  for (const ad of ads) {
    const v = ad.availableUsdtReported;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      total += v;
      count += 1;
    }
  }
  return { usdt: count > 0 ? total : null, ads: count };
}

/**
 * Profundidad: USDT declarados a un precio NO PEOR que la referencia movida
 * `pct` en la dirección desfavorable.
 *
 *   COMPRA (quiero bajo): cuentan los anuncios con precio <= ref*(1+pct)
 *   VENTA  (quiero alto): cuentan los anuncios con precio >= ref*(1-pct)
 *
 * Así el número responde siempre a la misma pregunta -"cuánta liquidez tengo
 * cerca de la referencia"- sin depender del lado ni necesitar valor absoluto.
 */
function depthOf(
  ads: readonly NormalizedAd[],
  leg: MakerLeg,
  reference: number | null
): DepthLevel[] {
  return DEPTH_LEVELS_PCT.map((pct) => {
    if (!usable(reference)) return { pct, usdt: null, ads: null };
    const limit = leg === 'COMPRA' ? reference * (1 + pct / 100) : reference * (1 - pct / 100);
    const within = ads.filter((a) => (leg === 'COMPRA' ? a.price <= limit : a.price >= limit));
    const { usdt } = declaredUsdtOf(within);
    return { pct, usdt, ads: within.length };
  });
}

/** Participación por método de pago. Sólo lo que la captura trajo. */
function payTypesOf(ads: readonly NormalizedAd[]): PayTypeShare[] {
  const acc = new Map<string, { ads: number; usdt: number; withVolume: number }>();
  for (const ad of ads) {
    for (const opt of ad.paymentOptions ?? []) {
      const key = opt.payType;
      if (typeof key !== 'string' || key.length === 0) continue;
      const entry = acc.get(key) ?? { ads: 0, usdt: 0, withVolume: 0 };
      entry.ads += 1;
      const v = ad.availableUsdtReported;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        entry.usdt += v;
        entry.withVolume += 1;
      }
      acc.set(key, entry);
    }
  }
  return [...acc.entries()]
    .map(([payType, e]) => ({ payType, ads: e.ads, usdt: e.withVolume > 0 ? e.usdt : null }))
    .sort((a, b) => b.ads - a.ads || a.payType.localeCompare(b.payType));
}

/** Variación relativa firmada entre dos medidas. `null` si no es calculable. */
function deltaPct(previous: number | null | undefined, current: number | null): number | null {
  if (!usable(previous) || current === null || !Number.isFinite(current)) return null;
  return ((current - previous) / previous) * 100;
}

/* ------------------------------------------------------------------------ *
 * CONSTRUCCIÓN
 * ------------------------------------------------------------------------ */

function buildSide(
  rawAds: readonly NormalizedAd[],
  leg: MakerLeg,
  reference: number | null,
  previous: SideState | null
): SideState | null {
  const ads = usableAds(rawAds);
  if (ads.length === 0) return null;

  const ordered = orderedForLeg(ads, leg);
  const leader = ordered[0];
  const { usdt: declaredUsdt, ads: adsWithVolume } = declaredUsdtOf(ads);

  const topUsdt: Record<number, number | null> = {};
  const topShare: Record<number, number | null> = {};
  for (const n of CONCENTRATION_TOPS) {
    const slice = ordered.slice(0, n);
    const { usdt } = declaredUsdtOf(slice);
    topUsdt[n] = usdt;
    // La cuota sólo tiene sentido si hay un total declarado positivo detrás.
    topShare[n] = usdt !== null && usable(declaredUsdt) ? usdt / declaredUsdt : null;
  }

  const prices = ads.map((a) => a.price).sort((x, y) => x - y);
  const p10 = percentile(prices, 0.1);
  const p50 = percentile(prices, 0.5);
  const p90 = percentile(prices, 0.9);

  return {
    leg,
    ads: ads.length,
    adsWithVolume,
    leaderPrice: leader.price,
    leaderGapPct: usable(reference) ? ((leader.price - reference) / reference) * 100 : null,
    leaderKey: leaderKeyOf(leader.advNo),
    declaredUsdt,
    topUsdt,
    topShare,
    depth: depthOf(ads, leg, reference),
    priceP10: p10,
    priceP50: p50,
    priceP90: p90,
    priceRangePct: p10 !== null && p90 !== null && usable(p50) ? ((p90 - p10) / p50) * 100 : null,
    leaderChanged:
      previous === null || previous.leaderKey === null
        ? null
        : previous.leaderKey !== leaderKeyOf(leader.advNo),
    declaredUsdtDeltaPct: deltaPct(previous?.declaredUsdt ?? null, declaredUsdt),
    leaderPriceDeltaPct: deltaPct(previous?.leaderPrice ?? null, leader.price),
  };
}

/**
 * Construye el estado de mercado de UNA captura.
 *
 * `previous` es el último estado CONOCIDO, no el de la captura inmediatamente
 * anterior en el reloj: si hubo capturas fallidas por medio, los cambios se
 * miden contra el último estado real, y `previousAt` dice cuál fue. Nunca se
 * mira hacia adelante.
 *
 * Devuelve `null` cuando la captura no describe un mercado -sin datos, o con
 * `status` distinto de LIVE/STALE-. Una captura fallida NO es un estado de
 * mercado, y convertirla en uno fabricaría liquidez y persistencia que nadie
 * observó.
 */
export function buildMarketState(
  snapshot: MarketSnapshot | null | undefined,
  previous: MarketStateSnapshot | null = null
): MarketStateSnapshot | null {
  if (!snapshot) return null;
  if (snapshot.status !== 'LIVE' && snapshot.status !== 'STALE') return null;

  const compra = buildSide(
    snapshot.topBuyAds ?? [],
    'COMPRA',
    snapshot.strategicBuyPrice ?? null,
    previous?.compra ?? null
  );
  const venta = buildSide(
    snapshot.topSellAds ?? [],
    'VENTA',
    snapshot.strategicSellPrice ?? null,
    previous?.venta ?? null
  );

  // Sin ningún lado no hay estado que describir.
  if (compra === null && venta === null) return null;

  return {
    version: MARKET_STATE_VERSION,
    capturedAt: snapshot.timestamp,
    captureStatus: snapshot.status,
    depthLevelsPct: [...DEPTH_LEVELS_PCT],
    compra,
    venta,
    filterBank: snapshot.filterBank ?? null,
    filterAmountVes: snapshot.filterAmount ?? null,
    payTypesCompra: payTypesOf(snapshot.topBuyAds ?? []),
    payTypesVenta: payTypesOf(snapshot.topSellAds ?? []),
    previousAt: previous?.capturedAt ?? null,
  };
}
