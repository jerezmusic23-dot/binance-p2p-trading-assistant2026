/**
 * FORMA DEL DÍA — PROYECCIÓN DE MI VENTA Y MI COMPRA
 * =================================================
 *
 * ═══ SEMÁNTICA OPERACIONAL. ES LA PARTE QUE NO SE PUEDE EQUIVOCAR ═══
 *
 * El propietario opera como MAKER: publica anuncios. Desde su lado:
 *
 *   BINANCE BUY   → gente que quiere COMPRAR USDT → si publico ahí, VENDO
 *                 → MI VENTA   → interesa el precio MÁS ALTO → TECHO
 *
 *   BINANCE SELL  → gente que VENDE USDT → si publico ahí, RECOMPRO
 *                 → MI COMPRA  → interesa el precio MÁS BAJO → PISO
 *
 * Esto no es una convención elegida aquí: es la que ya usa el resto del camino
 * maker del sistema. `tests/arbitrageSideSemantics.test.ts` lo fija con un caso
 * literal — con anuncios BUY a 945 y SELL a 940, el mensaje de Telegram dice
 * «Venta: 944.99» y «Compra: 940.01». Vender por encima de donde se recompra es
 * exactamente de lo que vive un maker.
 *
 * ═══ POR QUÉ EXISTE `MakerLeg` Y NO UN `side: 'BUY' | 'SELL'` ═══
 *
 * La versión anterior de este módulo usaba `'BUY' | 'SELL'` y aplicaba el
 * criterio del TAKER: el mejor BUY era el más barato. Para un maker es al revés
 * y el error era invisible, porque la gráfica seguía saliendo bonita y las dos
 * líneas seguían en su sitio: sólo estaban sistemáticamente pegadas al centro
 * del libro en vez de a los extremos que el propietario puede capturar.
 *
 * Nombrar la pierna por LA OPERACIÓN y no por el lado de Binance hace que ese
 * error no se pueda volver a escribir sin que se lea mal en voz alta.
 *
 * ═══ CADA PIERNA TIENE SU PROPIO EXTREMO Y NUNCA SE COMPARAN ═══
 *
 * VENTA agrega por MÁXIMO. COMPRA agrega por MÍNIMO. No hay ni un punto del
 * módulo donde se calcule `max(VENTA, COMPRA)` o `min(VENTA, COMPRA)`: son dos
 * operaciones distintas y mezclarlas produce un techo que no se pudo vender y
 * un piso que no se pudo comprar. Hay tests que lo prohíben explícitamente.
 *
 * ═══ POR QUÉ EL DÍA ES LA UNIDAD DE EVIDENCIA ═══
 *
 * El motor de horizontes busca analogías minuto a minuto y necesita ~41
 * separadas por el horizonte completo: llegar a las 20:00 desde media mañana le
 * cuesta ~18 días de serie continua. Aquí la unidad es EL DÍA —"de esta hora al
 * cierre, ¿qué hicieron los días anteriores?"— y con 5 días ya hay una mediana.
 * Son dos estimadores distintos y no se mezclan.
 */

import { percentileOf, type SeriesPoint } from './series.js';
import {
  VENEZUELA_OFFSET_MS,
  venezuelaDayKey,
  venezuelaHourOf,
  venezuelaWeekday,
} from './venezuelaClock.js';

/*
 * Se reexportan para que quien ya importaba el reloj desde aquí siga
 * funcionando: la división es de responsabilidades, no de contrato.
 */
export {
  VENEZUELA_OFFSET_MS,
  venezuelaDayKey,
  venezuelaHourOf,
  venezuelaWeekday,
} from './venezuelaClock.js';
export { InvalidInstantError, assertInstant } from './venezuelaClock.js';
import { binomialTailProbability } from './probability.js';


/**
 * Ventana del día que se dibuja. DECISIÓN DE PRESENTACIÓN, no una medición:
 * son las horas que el propietario quiere ver, y por eso es un parámetro.
 */
export const DEFAULT_DAY_START_HOUR = 8;
export const DEFAULT_DAY_END_HOUR = 20;

/** La operación del propietario. Nunca el lado de Binance a secas. */
export type MakerLeg = 'VENTA' | 'COMPRA';

/**
 * De qué lado de Binance se lee cada pierna. ÚNICA definición del módulo.
 *
 * Si alguna vez hay que cambiarla, se cambia aquí y en ningún otro sitio; todo
 * lo demás la consulta.
 */
export const LEG_BINANCE_SIDE: Record<MakerLeg, 'BUY' | 'SELL'> = {
  VENTA: 'BUY',
  COMPRA: 'SELL',
};

export const LEG_LABEL: Record<MakerLeg, string> = {
  VENTA: 'MI VENTA (Binance BUY)',
  COMPRA: 'MI COMPRA (Binance SELL)',
};

/**
 * Días mínimos para dibujar una curva.
 *
 * Por debajo de 5 la mediana de los cocientes es una o dos observaciones. No es
 * un umbral de significación —no lo hay con estos tamaños— sino un suelo para
 * no publicar una curva sostenida por un solo día. `daysUsed` viaja siempre.
 */
export const MIN_PROFILE_DAYS = 5;

/**
 * Días mínimos para CONDICIONAR por el estado de hoy. Condicionar se queda con
 * la mitad más parecida: con menos de 12 esa mitad baja de 6 y el condicionado
 * tendría menos evidencia que el sin condicionar.
 */
export const MIN_CONDITIONED_DAYS = 12;

/**
 * Días mínimos para condicionar por DOS variables (recorrido + volatilidad).
 *
 * Cada dimensión que se añade divide el pool. Con 20 días, quedarse con la
 * mitad deja 10, que es el mínimo con el que los percentiles siguen siendo
 * percentiles. Por debajo, añadir la segunda variable cambiaría evidencia por
 * apariencia de sofisticación.
 */
export const MIN_TWO_FACTOR_DAYS = 20;

/** Fracción de días análogos que se conserva al condicionar. */
export const CONDITIONED_FRACTION = 0.5;

/**
 * Días mínimos para llamar percentiles a los extremos de la banda. Con 9 o
 * menos, el "p10" caería sobre el mínimo observado y llamarlo percentil
 * sugeriría una precisión inexistente.
 */
export const BAND_PERCENTILE_DAYS = 10;

export type DailyTier =
  | 'SIN_DATOS'
  | 'SOLO_HOY'
  | 'PERFIL_LIMITADO'
  | 'PERFIL_CONDICIONADO';

export const TIER_TEXT: Record<DailyTier, string> = {
  SIN_DATOS: 'No hay serie suficiente para dibujar el día.',
  SOLO_HOY: 'Sólo hay datos de hoy. Faltan días anteriores para proyectar el resto de la jornada.',
  PERFIL_LIMITADO: 'Proyección sobre pocos días, sin filtrar por el estado de hoy.',
  PERFIL_CONDICIONADO: 'Proyección sobre los días que llegaron a esta hora en un estado parecido al de hoy.',
};

/** Fuerza de la evidencia, separada del nivel de perfil. */
export type DailyEvidenceLevel =
  | 'SIN_DATOS_SUFICIENTES'
  | 'SOLO_OBSERVACION'
  | 'ESTIMACION_SIN_VALIDAR'
  | 'EVIDENCIA_DEBIL'
  | 'EVIDENCIA_FUERTE';


/**
 * ¿Mejora `candidate` a `incumbent` PARA ESTA PIERNA?
 *
 * VENTA quiere el más alto (vendo más caro). COMPRA quiere el más bajo
 * (recompro más barato). Es la regla de la que cuelga todo lo demás.
 *
 * ═══ POR QUÉ COMPRUEBA LA PIERNA EN VEZ DE USAR UN TERNARIO ═══
 *
 * Escrito como `leg === 'VENTA' ? mayor : menor`, cualquier valor que no fuera
 * exactamente 'VENTA' —undefined incluido— caía en la rama de COMPRA y el motor
 * devolvía mínimos donde debía devolver máximos, sin un solo error. Ocurrió: una
 * llamada a la que le faltaba el argumento produjo un backtest entero con la
 * pierna equivocada y resultados que parecían razonables. TypeScript lo impide
 * en compilación; esto lo impide también en ejecución, que es donde llegan los
 * datos de fuera.
 */
export function isBetterForLeg(leg: MakerLeg, candidate: number, incumbent: number): boolean {
  if (leg === 'VENTA') return candidate > incumbent;
  if (leg === 'COMPRA') return candidate < incumbent;
  throw new Error(`Pierna desconocida: ${String(leg)}. Debe ser VENTA o COMPRA.`);
}

/** El extremo de la pierna: máximo para VENTA, mínimo para COMPRA. */
export function extremeForLeg(leg: MakerLeg, values: readonly number[]): number | null {
  let best: number | null = null;
  for (const v of values) {
    if (!Number.isFinite(v) || v <= 0) continue;
    if (best === null || isBetterForLeg(leg, v, best)) best = v;
  }
  return best;
}

export interface HourCell {
  hour: number;
  /** El extremo de la pierna dentro de esa hora. */
  best: number;
  observations: number;
  lastT: number;
}

export interface DayShape {
  dayKey: string;
  weekday: number;
  /** Sólo horas realmente observadas. Las que faltan NO se rellenan. */
  hours: Map<number, HourCell>;
}

/**
 * Agrupa una serie en días y horas locales quedándose con el extremo de la
 * pierna. Las horas fuera de la ventana se descartan aquí, no más tarde, para
 * que el perfil y el dibujo hablen del mismo tramo del día.
 */
export function groupByDay(
  points: readonly SeriesPoint[],
  leg: MakerLeg,
  startHour = DEFAULT_DAY_START_HOUR,
  endHour = DEFAULT_DAY_END_HOUR
): DayShape[] {
  const days = new Map<string, DayShape>();

  for (const p of points) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.price) || p.price <= 0) continue;
    const hour = venezuelaHourOf(p.t);
    if (hour < startHour || hour > endHour) continue;

    const key = venezuelaDayKey(p.t);
    let day = days.get(key);
    if (day === undefined) {
      day = { dayKey: key, weekday: venezuelaWeekday(p.t), hours: new Map() };
      days.set(key, day);
    }

    const cell = day.hours.get(hour);
    if (cell === undefined) {
      day.hours.set(hour, { hour, best: p.price, observations: 1, lastT: p.t });
      continue;
    }
    cell.observations += 1;
    if (p.t > cell.lastT) cell.lastT = p.t;
    if (isBetterForLeg(leg, p.price, cell.best)) cell.best = p.price;
  }

  return [...days.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

/**
 * Cociente de precio entre dos horas del mismo día.
 *
 * Cocientes y no diferencias porque el VES tiene deriva: 3 bolívares sobre 900
 * y 3 sobre 300 no son el mismo movimiento y promediarlos deformaría el perfil.
 */
export interface RatioSample {
  dayKey: string;
  ratio: number;
}

export function ratiosBetween(
  days: readonly DayShape[],
  anchorHour: number,
  targetHour: number
): RatioSample[] {
  const out: RatioSample[] = [];
  for (const day of days) {
    const a = day.hours.get(anchorHour);
    const t = day.hours.get(targetHour);
    if (a === undefined || t === undefined) continue; // no se interpola la que falta
    if (a.best <= 0 || t.best <= 0) continue;
    out.push({ dayKey: day.dayKey, ratio: t.best / a.best });
  }
  return out;
}

/**
 * Cociente entre el EXTREMO del tramo que queda y el ancla, por día.
 *
 * Es lo que responde "¿hasta dónde llegó a subir mi venta después de esta
 * hora?". Se calcula por día y LUEGO se toman percentiles, que no es lo mismo
 * que tomar el máximo de los percentiles hora a hora: eso último sería el
 * máximo de ocho p90 distintos y exageraría el techo sistemáticamente.
 */
export function remainingExtremeRatios(
  days: readonly DayShape[],
  leg: MakerLeg,
  anchorHour: number,
  endHour: number
): RatioSample[] {
  const out: RatioSample[] = [];
  for (const day of days) {
    const anchor = day.hours.get(anchorHour);
    if (anchor === undefined || anchor.best <= 0) continue;

    const future: number[] = [];
    for (let h = anchorHour + 1; h <= endHour; h += 1) {
      const cell = day.hours.get(h);
      if (cell !== undefined) future.push(cell.best);
    }
    const extreme = extremeForLeg(leg, future);
    if (extreme === null) continue;
    out.push({ dayKey: day.dayKey, ratio: extreme / anchor.best });
  }
  return out;
}

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type BandKind = 'P10_P90' | 'RANGO_OBSERVADO';

/** Distribución empírica de un cociente, aplicada a un precio ancla. */
export interface Quantiles {
  central: number;
  low: number;
  high: number;
  bandKind: BandKind;
  daysUsed: number;
}

export function quantilesFrom(ratios: readonly number[], anchorPrice: number): Quantiles | null {
  if (ratios.length === 0 || anchorPrice <= 0) return null;
  const sorted = [...ratios].sort((a, b) => a - b);
  const central = medianOf(sorted);
  if (central === null) return null;

  const usePercentiles = sorted.length >= BAND_PERCENTILE_DAYS;
  const low = usePercentiles ? percentileOf(sorted, 0.1) : sorted[0];
  const high = usePercentiles ? percentileOf(sorted, 0.9) : sorted[sorted.length - 1];
  if (low === null || high === null) return null;

  return {
    central: anchorPrice * central,
    low: anchorPrice * low,
    high: anchorPrice * high,
    bandKind: usePercentiles ? 'P10_P90' : 'RANGO_OBSERVADO',
    daysUsed: sorted.length,
  };
}

export interface HourProjection extends Quantiles {
  hour: number;
  /** Cambio del central respecto de la hora anterior de la trayectoria, en %. */
  movePct: number | null;
}

export function projectHour(
  days: readonly DayShape[],
  anchorHour: number,
  targetHour: number,
  anchorPrice: number
): HourProjection | null {
  const ratios = ratiosBetween(days, anchorHour, targetHour).map((s) => s.ratio);
  const q = quantilesFrom(ratios, anchorPrice);
  return q === null ? null : { ...q, hour: targetHour, movePct: null };
}

/**
 * Recorrido de un día desde su primera hora observada hasta `hour`.
 *
 * Descriptor del estado del día: dos días que a la misma hora llevaban el mismo
 * recorrido desde la apertura estaban, en lo medible aquí, en el mismo sitio.
 * Sólo mira horas ≤ `hour`, que es lo que lo hace utilizable en tiempo real.
 */
export function openToHourRatio(day: DayShape, hour: number): number | null {
  const target = day.hours.get(hour);
  if (target === undefined || target.best <= 0) return null;

  let openHour = Number.POSITIVE_INFINITY;
  for (const h of day.hours.keys()) if (h < openHour && h <= hour) openHour = h;
  if (!Number.isFinite(openHour) || openHour >= hour) return null;

  const open = day.hours.get(openHour);
  if (open === undefined || open.best <= 0) return null;
  return target.best / open.best;
}

/**
 * Volatilidad realizada hasta el ancla: mediana de |cambio| entre horas
 * contiguas. Segunda variable de condicionamiento — una mañana tranquila y una
 * violenta no predicen la misma tarde — y también mira sólo el pasado.
 */
export function realisedVolatilityUpTo(day: DayShape, hour: number): number | null {
  const hours = [...day.hours.values()].filter((c) => c.hour <= hour).sort((a, b) => a.hour - b.hour);
  const moves: number[] = [];
  for (let i = 1; i < hours.length; i += 1) {
    if (hours[i].hour !== hours[i - 1].hour + 1) continue;
    const from = hours[i - 1].best;
    if (from <= 0) continue;
    moves.push(Math.abs((hours[i].best - from) / from));
  }
  return medianOf(moves);
}

export interface TodayState {
  openToAnchor: number | null;
  volatility: number | null;
}

export interface DaySelection {
  days: DayShape[];
  conditioned: boolean;
  /** Variables que realmente filtraron. Vacío si no se condicionó. */
  factors: string[];
}

/**
 * Elige los días parecidos al estado de hoy.
 *
 * Devuelve TODOS cuando no hay días de sobra: preferir un subconjunto pequeño y
 * parecido a un conjunto grande es cambiar evidencia por estética. La segunda
 * variable sólo entra por encima de `MIN_TWO_FACTOR_DAYS` por la misma razón.
 */
export function selectAnalogousDays(
  days: readonly DayShape[],
  anchorHour: number,
  today: TodayState
): DaySelection {
  const none: DaySelection = { days: [...days], conditioned: false, factors: [] };
  if (today.openToAnchor === null || days.length < MIN_CONDITIONED_DAYS) return none;

  const useVolatility = days.length >= MIN_TWO_FACTOR_DAYS && today.volatility !== null;

  const scored: { day: DayShape; distance: number }[] = [];
  for (const day of days) {
    const ratio = openToHourRatio(day, anchorHour);
    if (ratio === null) continue;
    // Log para que un +1% y un −1% disten lo mismo del centro.
    let distance = Math.abs(Math.log(ratio) - Math.log(today.openToAnchor));

    if (useVolatility) {
      const vol = realisedVolatilityUpTo(day, anchorHour);
      if (vol === null) continue;
      /*
       * Las dos distancias son ya adimensionales y del mismo orden (fracciones
       * de precio), así que se suman sin pesos inventados. Un peso elegido a
       * mano decidiría en silencio cuál de las dos manda.
       */
      distance += Math.abs(vol - today.volatility!);
    }
    scored.push({ day, distance });
  }

  if (scored.length < MIN_CONDITIONED_DAYS) return none;

  scored.sort((a, b) => a.distance - b.distance);
  const keep = Math.max(MIN_PROFILE_DAYS, Math.round(scored.length * CONDITIONED_FRACTION));
  return {
    days: scored.slice(0, keep).map((s) => s.day),
    conditioned: true,
    factors: useVolatility ? ['recorrido desde la apertura', 'volatilidad realizada'] : ['recorrido desde la apertura'],
  };
}

export interface LegProjection {
  leg: MakerLeg;
  binanceSide: 'BUY' | 'SELL';
  tier: DailyTier;
  anchorHour: number;
  anchorPrice: number | null;

  /** Horas ya ocurridas hoy, con el extremo de la pierna en cada una. */
  real: { hour: number; price: number; observations: number; movePct: number | null }[];
  /** Extremo YA OCURRIDO hoy: techo observado en VENTA, piso observado en COMPRA. */
  observedExtreme: { price: number; hour: number } | null;

  /** Horas que quedan. Vacío si no hay evidencia. */
  projected: HourProjection[];
  /** Extremo del tramo que queda, estimado de la distribución por día. */
  projectedExtreme: Quantiles | null;
  /** Precio estimado al cierre de la ventana. */
  projectedClose: Quantiles | null;

  profileDays: number;
  candidateDays: number;
  conditioned: boolean;
  conditioningFactors: string[];
}

/**
 * Proyecta una pierna: lo real hasta ahora y lo que queda después.
 *
 * `now` se pasa explícito para que la función sea determinista y para que el
 * backtest pueda situarse en un instante del pasado sin tocar el reloj.
 */
export function projectLeg(
  points: readonly SeriesPoint[],
  leg: MakerLeg,
  now: number,
  startHour = DEFAULT_DAY_START_HOUR,
  endHour = DEFAULT_DAY_END_HOUR
): LegProjection {
  const all = groupByDay(points, leg, startHour, endHour);
  const todayKey = venezuelaDayKey(now);
  return projectLegFromDays(all, leg, todayKey, venezuelaHourOf(now), startHour, endHour);
}

/**
 * El núcleo, ya sobre días agrupados.
 *
 * Separado de `projectLeg` porque el backtest necesita entrar aquí con un
 * conjunto de días RECORTADO —sólo los anteriores al que evalúa— y ésa es la
 * única forma de garantizar por construcción que no hay look-ahead.
 */
export function projectLegFromDays(
  allDays: readonly DayShape[],
  leg: MakerLeg,
  todayKey: string,
  rawAnchorHour: number,
  startHour = DEFAULT_DAY_START_HOUR,
  endHour = DEFAULT_DAY_END_HOUR
): LegProjection {
  const today = allDays.find((d) => d.dayKey === todayKey) ?? null;
  const previous = allDays.filter((d) => d.dayKey < todayKey);
  const anchorHour = Math.min(Math.max(rawAnchorHour, startHour), endHour);

  const observedHours =
    today === null
      ? []
      : [...today.hours.values()].filter((c) => c.hour <= anchorHour).sort((a, b) => a.hour - b.hour);

  const real = observedHours.map((c, i) => {
    const before = i > 0 ? observedHours[i - 1] : null;
    // Sólo entre horas contiguas: saltar un hueco daría un "movimiento por
    // hora" que en realidad son varias.
    const contiguous = before !== null && before.hour === c.hour - 1 && before.best > 0;
    return {
      hour: c.hour,
      price: c.best,
      observations: c.observations,
      movePct: contiguous ? ((c.best - before!.best) / before!.best) * 100 : null,
    };
  });

  let observedExtreme: { price: number; hour: number } | null = null;
  for (const r of real) {
    if (observedExtreme === null || isBetterForLeg(leg, r.price, observedExtreme.price)) {
      observedExtreme = { price: r.price, hour: r.hour };
    }
  }

  const anchorCell = today?.hours.get(anchorHour) ?? null;
  // Si la hora en curso aún no tiene observación, se ancla en la última que sí.
  const anchorPrice = anchorCell?.best ?? (real.length > 0 ? real[real.length - 1].price : null);

  const base: LegProjection = {
    leg,
    binanceSide: LEG_BINANCE_SIDE[leg],
    tier: real.length === 0 ? 'SIN_DATOS' : 'SOLO_HOY',
    anchorHour,
    anchorPrice,
    real,
    observedExtreme,
    projected: [],
    projectedExtreme: null,
    projectedClose: null,
    profileDays: 0,
    candidateDays: previous.length,
    conditioned: false,
    conditioningFactors: [],
  };

  if (anchorPrice === null || previous.length < MIN_PROFILE_DAYS) return base;

  const state: TodayState =
    today === null
      ? { openToAnchor: null, volatility: null }
      : {
          openToAnchor: openToHourRatio(today, anchorHour),
          volatility: realisedVolatilityUpTo(today, anchorHour),
        };

  const selection = selectAnalogousDays(previous, anchorHour, state);
  if (selection.days.length < MIN_PROFILE_DAYS) return base;

  const projected: HourProjection[] = [];
  let previousPrice = anchorPrice;
  for (let hour = anchorHour + 1; hour <= endHour; hour += 1) {
    const projection = projectHour(selection.days, anchorHour, hour, anchorPrice);
    if (projection === null) continue;
    projection.movePct =
      previousPrice > 0 ? ((projection.central - previousPrice) / previousPrice) * 100 : null;
    previousPrice = projection.central;
    projected.push(projection);
  }
  if (projected.length === 0) return base;

  const extremeRatios = remainingExtremeRatios(selection.days, leg, anchorHour, endHour).map((s) => s.ratio);
  const closeRatios = ratiosBetween(selection.days, anchorHour, endHour).map((s) => s.ratio);

  return {
    ...base,
    tier: selection.conditioned ? 'PERFIL_CONDICIONADO' : 'PERFIL_LIMITADO',
    projected,
    projectedExtreme: quantilesFrom(extremeRatios, anchorPrice),
    projectedClose: quantilesFrom(closeRatios, anchorPrice),
    profileDays: selection.days.length,
    conditioned: selection.conditioned,
    conditioningFactors: selection.factors,
  };
}
