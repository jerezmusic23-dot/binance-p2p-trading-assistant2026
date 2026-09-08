/**
 * CALIDAD DEL ANUNCIO: ¿este precio describe el mercado, o es un anuncio raro?
 *
 *     RAW -> NORMALIZADO -> **CALIDAD** -> LIBRO EJECUTABLE
 *
 * Existe porque un anuncio con precio positivo, banco verificable, límites
 * compatibles y liquidez publicada podía convertirse en el extremo del libro y
 * producir una operación que nadie puede ejecutar. Medido sobre precios reales
 * observados en Binance P2P VES:
 *
 *   BUY normales 969.299 … 970.000 + uno a 920.659
 *      -> bestBuyPrice pasaba de 969.30 a 920.66
 *      -> spread de +0.0878% a +5.3756%, margen de 17.56 a 1075.12 VES (x61)
 *   SELL normales 966.530 … 970.150 + uno a 1200
 *      -> spread +23.80%, margen 4760.16 VES (x271)
 *
 * ═══ ESTE MÓDULO NO CONOCE BUY NI SELL ═══
 *
 * La calidad es una propiedad del ANUNCIO, no del lado. `BookSideRole` sólo
 * dice contra qué distribución se compara (regla C), nunca qué significa el
 * anuncio: esa traducción vive en `arbitrageSides.ts` y en ningún otro sitio.
 *
 * ═══ POR QUÉ NO SE USA `detectOutliers` COMO PUERTA ═══
 *
 * `marketStatistics.detectOutliers` (z modificado sobre la MAD) es correcto
 * para lo que fue escrito - vigilar el NIVEL estratégico - y NO sirve para
 * decidir elegibilidad. Se comprobó con los precios reales de arriba:
 *
 *   · sobre el libro SELL limpio, marca 970.15 con z=8.69: el MEJOR bid
 *     legítimo, el que produce la oportunidad real de +0.0878%;
 *   · sobre el libro BUY limpio, marca 969.299 con z=-4.05: el MEJOR ask;
 *   · sobre un libro apretado (969.30 x4 + 920.659) la MAD vale 0, se declara
 *     no decidible y NO marca nada: falla ABIERTO justo en el caso que importa.
 *
 * La causa es de fondo: la MAD mide la distancia al centro EN UNIDADES DE LO
 * APRETADO QUE ESTÁ EL PELOTÓN, y la cima del libro es por definición su
 * extremo. Prohibir lo que marque equivale a prohibir el mejor precio. Por eso
 * la puerta usa distancia RELATIVA, que no se estrecha cuando el libro se
 * aprieta, y `detectOutliers` se conecta donde sí corresponde.
 */

import { median } from './marketStatistics.js';
import type { AdQuality, AdQualityVerdict, NormalizedAd, QualityExclusion } from './types.js';

/**
 * REGLA A - umbral de desviación relativa a la mediana del PROPIO lado.
 *
 * No es una constante elegida a ojo ni ajustada para que pasen los tests: sale
 * de la separación medida sobre los precios reales observados.
 *
 *   normales BUY   -0.062% … +0.010%      anómalo  -5.077%
 *   normales SELL  -0.028% … +0.347%      anómalo +24.121%
 *
 * Los normales caben en ±0.35% y los anómalos están a 5% y 24%. Cualquier
 * umbral entre ~1% y ~4% los separa. 2% deja ~6x de margen sobre la dispersión
 * normal y ~2.5x por debajo del anómalo más cercano, así que la clasificación
 * no cambia si el mercado se ensancha algo.
 */
export const OUTLIER_RELATIVE_THRESHOLD = 0.02;

/**
 * REGLA C - distancia al nivel del lado CONTRARIO a partir de la cual el
 * anuncio deja de ser plausible.
 *
 * C NO BLOQUEA POR SÍ SOLA, y esto es deliberado: un ask por debajo del bid es
 * exactamente la oportunidad que este bot busca. Tratar "ASK < BID" como
 * absurdo sería borrar el producto. C sólo REFUERZA la evidencia cuando A ya
 * ha dicho que el precio es anómalo.
 *
 * 3% está muy por encima de cualquier arbitraje P2P VES realista (décimas de
 * punto), de modo que una oportunidad real nunca lo cruza, y por debajo del
 * -4.78% del anuncio anómalo observado, de modo que sí lo cruza cuando el
 * precio es falso.
 */
export const CROSS_SIDE_THRESHOLD = 0.03;

/** Anuncios mínimos en un lado para que su dispersión pueda juzgarse. */
export const MIN_ADS_TO_ASSESS = 3;

/**
 * Contra qué distribución se compara el anuncio en la regla C.
 * ASK = libro devuelto por tradeType 'BUY'. BID = el de tradeType 'SELL'.
 */
export type BookSideRole = 'ASK' | 'BID';

/**
 * Veredicto de un anuncio promocionado cuyo PRECIO no es anómalo.
 *
 * Sigue siendo ejecutable: una colocación pagada es una contraparte válida.
 * Queda fuera de la REFERENCIA porque no es una muestra del mercado abierto.
 */
const PROMOTED_VERDICT: AdQualityVerdict = {
  quality: 'PROMOTED',
  rule: 'PROMOTION_FLAG',
  reason:
    'Binance lo publica como promocionado (colocación pagada). Sigue siendo ejecutable ' +
    'porque su precio no es anómalo, pero no define el nivel del mercado abierto.',
  deviationPct: null,
  crossSideFlag: false,
  assessed: true,
};

function finitePrices(ads: readonly NormalizedAd[]): number[] {
  return ads.map((a) => a.price).filter((p) => Number.isFinite(p) && p > 0);
}

/**
 * Clasifica UN anuncio contra su propio lado y, como refuerzo, contra el otro.
 *
 * El orden importa: una bandera de promoción publicada por Binance y una
 * liquidez que Binance no publicó son hechos sobre el anuncio, y se responden
 * antes de mirar ninguna distribución.
 */
export function classifyAd(
  ad: NormalizedAd,
  ownSide: readonly NormalizedAd[],
  oppositeSide: readonly NormalizedAd[],
  role: BookSideRole
): AdQualityVerdict {
  /*
   * Sin volumen publicado no se puede establecer nada sobre el anuncio. Ya era
   * no ejecutable (LIQUIDITY_NOT_VERIFIABLE); aquí el motivo se hace explícito
   * y viaja con el anuncio en vez de aparecer sólo al final de la cadena.
   */
  if (ad.availableUsdtReported === null) {
    return {
      quality: 'UNVERIFIABLE',
      rule: 'LIQUIDITY_NOT_PUBLISHED',
      reason: 'Binance no publicó volumen para este anuncio: su calidad no puede establecerse.',
      deviationPct: null,
      crossSideFlag: false,
      assessed: true,
    };
  }

  const own = median(finitePrices(ownSide));
  const assessable = finitePrices(ownSide).length >= MIN_ADS_TO_ASSESS && own !== null && own > 0;

  if (!assessable) {
    /*
     * Menos de tres anuncios: no hay distribución que juzgar. NO se excluye.
     * Inventar una restricción cuando no se puede medir dejaría al operador
     * sin libro en los mercados delgados, que es donde más lo necesita.
     */
    return ad.promoted === true
      ? { ...PROMOTED_VERDICT, assessed: false }
      : {
          quality: 'NORMAL',
          rule: 'NOT_ASSESSED',
          reason: `Menos de ${MIN_ADS_TO_ASSESS} anuncios comparables: la dispersión no puede juzgarse y no se inventa una restricción.`,
          deviationPct: null,
          crossSideFlag: false,
          assessed: false,
        };
  }

  const deviation = (ad.price - own!) / own!;
  const aFires = Math.abs(deviation) > OUTLIER_RELATIVE_THRESHOLD;

  // REGLA C, sólo en la dirección que FABRICA un spread fantasma.
  const opposite = median(finitePrices(oppositeSide));
  const crossSideFlag =
    opposite !== null && opposite > 0
      ? role === 'ASK'
        ? ad.price < opposite * (1 - CROSS_SIDE_THRESHOLD)
        : ad.price > opposite * (1 + CROSS_SIDE_THRESHOLD)
      : false;

  const pct = (deviation * 100).toFixed(2);

  if (aFires) {
    return {
      quality: 'OUTLIER',
      rule: 'A_RELATIVE_DEVIATION',
      reason:
        `Se aleja ${pct}% de la mediana de su lado (${own!.toFixed(3)}), por encima del ` +
        `${(OUTLIER_RELATIVE_THRESHOLD * 100).toFixed(0)}% admitido` +
        (crossSideFlag ? '; además contradice la distribución del lado contrario' : '') +
        (ad.promoted === true ? '; el anuncio además está promocionado.' : '.'),
      deviationPct: deviation * 100,
      crossSideFlag,
      assessed: true,
    };
  }

  /*
   * ORDEN: la regla A se evalúa ANTES que la promoción, y OUTLIER manda.
   *
   * Un anuncio promocionado con precio anómalo es peligroso por el PRECIO. Si
   * la promoción se resolviera primero, ese anuncio saldría PROMOTED - que sí
   * es ejecutable - y el precio anómalo entraría en una operación. Fue este
   * mismo caso, "promoted + outlier", el que descubrió el orden equivocado.
   */
  if (ad.promoted === true) {
    return { ...PROMOTED_VERDICT, deviationPct: deviation * 100, crossSideFlag };
  }

  return {
    quality: 'NORMAL',
    rule: 'A_RELATIVE_DEVIATION',
    reason: crossSideFlag
      ? `Dentro de la dispersión de su lado (${pct}%). Está lejos del lado contrario, pero eso solo no lo descalifica: puede ser una oportunidad real.`
      : `Dentro de la dispersión de su lado (${pct}%).`,
    deviationPct: deviation * 100,
    crossSideFlag,
    assessed: true,
  };
}

/** Un anuncio y su veredicto, para no perder de vista los excluidos. */
export interface ClassifiedAd {
  ad: NormalizedAd;
  verdict: AdQualityVerdict;
}

export interface SideClassification {
  /** Todos los anuncios, en el orden recibido, cada uno con su veredicto. */
  classified: ClassifiedAd[];
  /** Los que pueden formar parte de una operación. */
  executionEligible: NormalizedAd[];
  /** Los que pueden definir el nivel del mercado. Subconjunto del anterior. */
  referenceEligible: NormalizedAd[];
  /** Todo lo que no salió NORMAL, con su motivo. Nunca desaparece en silencio. */
  notNormal: ClassifiedAd[];
}

/**
 * DOS ELEGIBILIDADES DISTINTAS, PORQUE SON DOS PREGUNTAS DISTINTAS.
 *
 *   ejecución  - "¿puedo operar contra este anuncio?"
 *   referencia - "¿describe este anuncio el nivel del mercado abierto?"
 *
 * ═══ POR QUÉ `PROMOTED` NO BLOQUEA LA EJECUCIÓN ═══
 *
 * Un anuncio promocionado es una COLOCACIÓN PAGADA: alguien compró
 * visibilidad. Eso no dice nada sobre si su precio se puede ejecutar. Si lleva
 * precio normal, límites compatibles, banco verificado y liquidez publicada, es
 * una contraparte tan válida como cualquier otra, y apartarlo perdería
 * operaciones reales sin ninguna evidencia que lo respalde.
 *
 * El anuncio promocionado de 920.659 que motivó esta puerta es peligroso por su
 * PRECIO, no por estar promocionado, y de ese precio ya se ocupa la regla A.
 *
 * Sí queda fuera de la REFERENCIA: una colocación pagada no es una muestra del
 * mercado abierto, y el nivel estratégico pretende describir ese mercado.
 *
 * ═══ `UNVERIFIABLE` NO SE APARTA AQUÍ ═══
 *
 * Un anuncio sin volumen publicado ya es no ejecutable en la capa de liquidez,
 * y allí el motivo es más preciso (`LIQUIDITY_NOT_VERIFIABLE`, "no se inventa
 * liquidez"). Apartarlo aquí no lo protegería más y sustituiría ese motivo
 * exacto por uno genérico. Su veredicto se registra igualmente.
 */
export function isExecutionEligible(quality: AdQuality): boolean {
  return quality !== 'OUTLIER';
}

export function isReferenceEligible(quality: AdQuality): boolean {
  return quality !== 'OUTLIER' && quality !== 'PROMOTED';
}

/**
 * EL GRUPO DE COMPARACIÓN: anuncios que compiten por la MISMA operación.
 *
 * ═══ POR QUÉ NO BASTA "EL MISMO LADO" ═══
 *
 * Un anuncio que sólo acepta operaciones de 500.000 VES en adelante y otro que
 * sirve 20.000 no compiten por nada: los bloques grandes se pagan distinto, y
 * comparar sus precios es juzgar un valor contra una distribución que no es la
 * suya - el mismo error de categoría que hace inservible a la MAD como puerta.
 *
 * Medido sobre el propio libro general, comparando todo el lado a la vez:
 *   · un anuncio de bloque legítimo a 1010 (tramo 500K-1M) salía OUTLIER
 *     por compararse contra minoristas en 969;
 *   · y con varios bloques presentes, los tres salían OUTLIER a la vez.
 *
 * ═══ LA REGLA, UNA SOLA PARA LOS DOS CAMINOS ═══
 *
 * Se define el RANGO DE LA OPERACIÓN y se comparan los anuncios que pueden
 * servirlo:
 *
 *   · matriz banco x monto (`transAmount` conocido) -> rango [importe, importe];
 *     comparables = los que admiten ese importe exacto.
 *   · captura general (`transAmount: null`) -> no hay importe, así que el rango
 *     es el del PROPIO anuncio que se juzga; comparables = aquellos cuyo rango
 *     se solapa con el suyo, es decir, con los que existe algún tamaño de
 *     operación que ambos podrían atender.
 *
 * El primer caso es el segundo con un rango de un solo punto, así que hay un
 * único camino de código y no dos que puedan divergir.
 */
interface AmountRange {
  min: number;
  max: number;
}

function rangeOf(ad: NormalizedAd): AmountRange {
  return { min: ad.minAmountVes, max: ad.maxAmountVes };
}

function overlaps(a: AmountRange, b: AmountRange): boolean {
  return a.min <= b.max && b.min <= a.max;
}

/** Anuncios que podrían atender alguna operación en común con `range`. */
function comparableTo(side: readonly NormalizedAd[], range: AmountRange): NormalizedAd[] {
  return side.filter((a) => overlaps(rangeOf(a), range));
}

const OUT_OF_TIER: AdQualityVerdict = {
  quality: 'NORMAL',
  rule: 'NOT_ASSESSED',
  reason: 'Fuera del tramo de importe pedido: no se compara con anuncios que sirven otra operación.',
  deviationPct: null,
  crossSideFlag: false,
  assessed: false,
};

/**
 * Clasifica un lado entero y lo parte en elegibles y apartados.
 *
 * `amountVes` es el importe de la operación cuando se conoce (matriz banco x
 * monto). `null` = captura general: cada anuncio se juzga contra los que
 * solapan su propio tramo.
 */
export function classifySide(
  side: readonly NormalizedAd[],
  oppositeSide: readonly NormalizedAd[],
  role: BookSideRole,
  amountVes: number | null = null
): SideClassification {
  const classified = side.map((ad) => {
    const range: AmountRange =
      amountVes === null ? rangeOf(ad) : { min: amountVes, max: amountVes };

    // Con importe pedido, un anuncio que no lo admite no se juzga aquí: sus
    // propios límites lo rechazan después, con un motivo más exacto.
    if (amountVes !== null && !overlaps(rangeOf(ad), range)) {
      return { ad, verdict: OUT_OF_TIER };
    }

    return {
      ad,
      verdict: classifyAd(ad, comparableTo(side, range), comparableTo(oppositeSide, range), role),
    };
  });

  return {
    classified,
    executionEligible: classified.filter((c) => isExecutionEligible(c.verdict.quality)).map((c) => c.ad),
    referenceEligible: classified.filter((c) => isReferenceEligible(c.verdict.quality)).map((c) => c.ad),
    notNormal: classified.filter((c) => c.verdict.quality !== 'NORMAL'),
  };
}

/** Convierte un veredicto en una fila de traza auditable. */
export function exclusionRow(c: ClassifiedAd, side: 'BUY' | 'SELL'): QualityExclusion {
  return {
    advNo: c.ad.advNo,
    side,
    price: c.ad.price,
    quality: c.verdict.quality,
    rule: c.verdict.rule,
    reason: c.verdict.reason,
    deviationPct: c.verdict.deviationPct,
    crossSideFlag: c.verdict.crossSideFlag,
    assessed: c.verdict.assessed,
    availableUsdtReported: c.ad.availableUsdtReported,
    promoted: c.ad.promoted ?? null,
    executionEligible: isExecutionEligible(c.verdict.quality),
    referenceEligible: isReferenceEligible(c.verdict.quality),
  };
}
