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
import { binomialTailProbability } from './probability.js';

/** Venezuela: UTC-4 fijo, sin horario de verano. Igual que `venezuelaHour`. */
export const VENEZUELA_OFFSET_MS = 4 * 3_600_000;

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

export function venezuelaHourOf(t: number): number {
  return new Date(t - VENEZUELA_OFFSET_MS).getUTCHours();
}

export function venezuelaDayKey(t: number): string {
  return new Date(t - VENEZUELA_OFFSET_MS).toISOString().slice(0, 10);
}

/** 0 = domingo. Sólo se publica; no condiciona hasta que haya semanas de sobra. */
export function venezuelaWeekday(t: number): number {
  return new Date(t - VENEZUELA_OFFSET_MS).getUTCDay();
}

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

function medianOf(values: readonly number[]): number | null {
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

/**
 * Umbral de giro, MEDIDO en vez de elegido.
 *
 * Un giro es un cambio de hora a hora mayor que el de una hora corriente, y qué
 * es "corriente" lo dice la serie: la mediana de los cambios absolutos entre
 * horas contiguas. Un 0.3 % fijo decidiría qué se le anuncia al propietario sin
 * que nadie lo hubiera medido.
 */
export interface TurnThreshold {
  pct: number | null;
  sampleSize: number;
}

export function turnThreshold(days: readonly DayShape[]): TurnThreshold {
  const moves: number[] = [];
  for (const day of days) {
    const hours = [...day.hours.values()].sort((a, b) => a.hour - b.hour);
    for (let i = 1; i < hours.length; i += 1) {
      if (hours[i].hour !== hours[i - 1].hour + 1) continue; // el hueco se respeta
      const from = hours[i - 1].best;
      if (from <= 0) continue;
      moves.push(Math.abs((hours[i].best - from) / from) * 100);
    }
  }
  return { pct: medianOf(moves), sampleSize: moves.length };
}

/* ════════════════════════════════════════════════════════════════════════
 * BACKTEST TEMPORAL, SIN LOOK-AHEAD
 * ════════════════════════════════════════════════════════════════════════
 *
 * Se recorre el histórico hacia adelante. Para el día i el perfil se construye
 * con `days.slice(0, i)` — ESTRICTAMENTE los días anteriores.
 *
 * Esto no es un detalle: la versión anterior usaba "todos menos el día i", que
 * incluye días POSTERIORES. Eso es look-ahead puro y habría inflado el
 * resultado con información que en ese momento no existía. La garantía aquí es
 * estructural, no una promesa: el conjunto se recorta antes de entrar y la
 * función que proyecta no recibe nada más.
 *
 * Dentro del día evaluado, el ancla parte los datos en dos: hasta la hora ancla
 * se usa para condicionar, y sólo después se lee la realidad para comparar.
 */

export interface LegBacktest {
  leg: MakerLeg;
  /** Días evaluados. Es la unidad independiente del contraste. */
  days: number;
  /** Anclas día×hora evaluadas. Contexto, NO tamaño de muestra del contraste. */
  anchors: number;

  /** Error absoluto medio del cierre proyectado, y el de la persistencia. */
  closeErrorModel: number | null;
  closeErrorPersistence: number | null;
  /** Error absoluto medio del extremo (techo en VENTA, piso en COMPRA). */
  extremeErrorModel: number | null;
  extremeErrorPersistence: number | null;
  /** Proporción de veces que el cierre real cayó dentro de la banda, 0–1. */
  coverage: number | null;
  /** Aciertos de dirección sobre los casos en que hubo dirección que acertar. */
  directionHits: number;
  directionTotal: number;

  modelWins: number;
  persistenceWins: number;
  ties: number;
  pValue: number | null;
  beatsPersistence: boolean;
}

export const BACKTEST_ALPHA = 0.05;

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

export function backtestLeg(
  days: readonly DayShape[],
  leg: MakerLeg,
  startHour = DEFAULT_DAY_START_HOUR,
  endHour = DEFAULT_DAY_END_HOUR
): LegBacktest {
  const ordered = [...days].sort((a, b) => a.dayKey.localeCompare(b.dayKey));

  const closeModel: number[] = [];
  const closePersistence: number[] = [];
  const extremeModel: number[] = [];
  const extremePersistence: number[] = [];
  let covered = 0;
  let coverageCases = 0;
  let directionHits = 0;
  let directionTotal = 0;
  let anchors = 0;

  let modelWins = 0;
  let persistenceWins = 0;
  let ties = 0;
  let evaluatedDays = 0;

  for (let i = 0; i < ordered.length; i += 1) {
    // ESTRICTAMENTE anterior. Aquí es donde se impide el look-ahead.
    const past = ordered.slice(0, i);
    if (past.length < MIN_PROFILE_DAYS) continue;

    const actual = ordered[i];
    const dayModelErrors: number[] = [];
    const dayPersistenceErrors: number[] = [];

    for (let anchor = startHour; anchor < endHour; anchor += 1) {
      const anchorCell = actual.hours.get(anchor);
      if (anchorCell === undefined || anchorCell.best <= 0) continue;

      /*
       * El día evaluado se recorta hasta el ancla antes de proyectar: el motor
       * no puede ver ni una hora posterior de su propio día.
       */
      const visibleToday: DayShape = {
        dayKey: actual.dayKey,
        weekday: actual.weekday,
        hours: new Map([...actual.hours.entries()].filter(([h]) => h <= anchor)),
      };

      const projection = projectLegFromDays(
        [...past, visibleToday],
        leg,
        actual.dayKey,
        anchor,
        startHour,
        endHour
      );
      if (projection.projected.length === 0) continue;
      anchors += 1;

      // ── Cierre ──
      const closeCell = actual.hours.get(endHour);
      if (closeCell !== undefined && projection.projectedClose !== null) {
        const modelError = Math.abs(projection.projectedClose.central - closeCell.best);
        const persistenceError = Math.abs(anchorCell.best - closeCell.best);
        closeModel.push(modelError);
        closePersistence.push(persistenceError);
        dayModelErrors.push(modelError);
        dayPersistenceErrors.push(persistenceError);

        coverageCases += 1;
        const lo = Math.min(projection.projectedClose.low, projection.projectedClose.high);
        const hi = Math.max(projection.projectedClose.low, projection.projectedClose.high);
        if (closeCell.best >= lo && closeCell.best <= hi) covered += 1;

        // Dirección: sólo cuenta cuando el mercado se movió de verdad.
        const realMove = closeCell.best - anchorCell.best;
        const projectedMove = projection.projectedClose.central - anchorCell.best;
        if (realMove !== 0 && projectedMove !== 0) {
          directionTotal += 1;
          if (Math.sign(realMove) === Math.sign(projectedMove)) directionHits += 1;
        }
      }

      // ── Extremo del tramo restante ──
      const futureValues: number[] = [];
      for (let h = anchor + 1; h <= endHour; h += 1) {
        const cell = actual.hours.get(h);
        if (cell !== undefined) futureValues.push(cell.best);
      }
      const realExtreme = extremeForLeg(leg, futureValues);
      if (realExtreme !== null && projection.projectedExtreme !== null) {
        extremeModel.push(Math.abs(projection.projectedExtreme.central - realExtreme));
        // La persistencia no predice un extremo distinto del precio de ahora.
        extremePersistence.push(Math.abs(anchorCell.best - realExtreme));
      }
    }

    if (dayModelErrors.length === 0) continue;
    evaluatedDays += 1;
    /*
     * UN DÍA, UN CASO. Las anclas de un mismo día recorren la misma trayectoria;
     * contarlas por separado daría cientos de "casos" y una p diminuta que sería
     * falsa. Se promedian y el día aporta un solo signo.
     */
    const m = mean(dayModelErrors)!;
    const p = mean(dayPersistenceErrors)!;
    if (m < p) modelWins += 1;
    else if (m > p) persistenceWins += 1;
    else ties += 1;
  }

  const comparisons = modelWins + persistenceWins;
  const pValue = comparisons === 0 ? null : binomialTailProbability(modelWins, comparisons);

  return {
    leg,
    days: evaluatedDays,
    anchors,
    closeErrorModel: mean(closeModel),
    closeErrorPersistence: mean(closePersistence),
    extremeErrorModel: mean(extremeModel),
    extremeErrorPersistence: mean(extremePersistence),
    coverage: coverageCases === 0 ? null : covered / coverageCases,
    directionHits,
    directionTotal,
    modelWins,
    persistenceWins,
    ties,
    pValue,
    beatsPersistence: pValue !== null && pValue < BACKTEST_ALPHA && modelWins > persistenceWins,
  };
}

/** Fuerza de la evidencia de una pierna, a partir de su backtest y su perfil. */
export function evidenceFor(projection: LegProjection, backtest: LegBacktest): DailyEvidenceLevel {
  if (projection.tier === 'SIN_DATOS') return 'SIN_DATOS_SUFICIENTES';
  if (projection.tier === 'SOLO_HOY') return 'SOLO_OBSERVACION';
  if (backtest.days === 0 || backtest.pValue === null) return 'ESTIMACION_SIN_VALIDAR';
  return backtest.beatsPersistence ? 'EVIDENCIA_FUERTE' : 'EVIDENCIA_DEBIL';
}

export const DAILY_EVIDENCE_TEXT: Record<DailyEvidenceLevel, string> = {
  SIN_DATOS_SUFICIENTES: 'Sin datos suficientes para decir nada.',
  SOLO_OBSERVACION: 'Sólo lo observado hoy. No hay proyección.',
  ESTIMACION_SIN_VALIDAR: 'Estimación sin validar: no hay días bastantes para comparar contra la persistencia.',
  EVIDENCIA_DEBIL: 'Evidencia débil: el modelo todavía no mejora de forma demostrable a suponer que el precio se queda igual.',
  EVIDENCIA_FUERTE: 'Evidencia fuerte: el modelo bate a la persistencia en el histórico disponible.',
};
