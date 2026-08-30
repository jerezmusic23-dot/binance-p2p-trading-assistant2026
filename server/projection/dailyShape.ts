/**
 * FORMA DEL DÍA: PROYECCIÓN DE FLUCTUACIÓN INTRADÍA
 * ================================================
 *
 * Proyecta el precio de cada hora que queda del día a partir de LO QUE HICIERON
 * LOS DÍAS ANTERIORES A ESA MISMA HORA, anclado en el precio de ahora.
 *
 * ═══ POR QUÉ NO SIRVE EL MOTOR DE HORIZONTES QUE YA EXISTE ═══
 *
 * `projectSeries` proyecta a +15m, +1h, +4h… buscando analogías MINUTO a minuto,
 * y necesita ~41 analogías independientes separadas por el horizonte completo.
 * Para llegar a las 8 de la tarde desde las 9 de la mañana hacen falta 11 horas
 * de horizonte, y eso son ~41 × 11 h ≈ 18 días de serie continua antes de poder
 * dibujar nada.
 *
 * Este estimador pregunta otra cosa: "de las 9 a las 8 de la tarde, ¿cuánto se
 * movió el precio los días anteriores?". La unidad de evidencia pasa a ser EL
 * DÍA, no el minuto, así que con 5 días ya hay una mediana que mirar. Esa es la
 * única razón por la que existe un segundo estimador: compra los horizontes
 * largos que el primero no alcanza. No lo sustituye ni se mezcla con él —
 * mezclar dos estimadores produce un número que ninguno de los dos respalda.
 *
 * ═══ QUÉ ES "EL MEJOR PRECIO DE LA HORA" ═══
 *
 * Cada hora se resume por su MEJOR precio, no por su media, y "mejor" depende
 * del lado, con la semántica que ya está fijada en `types.ts` y que aquí no se
 * toca:
 *
 *   BUY  = el ask, lo que me cuesta comprar USDT  → mejor es el MÁS BAJO
 *   SELL = el bid, lo que me pagan por venderlos  → mejor es el MÁS ALTO
 *
 * Invertir esto daría una proyección coherente consigo misma y equivocada en
 * todas partes, así que hay un test que lo fija.
 *
 * ═══ EL MOMENTO DEL MERCADO ENTRA COMO CONDICIÓN, NO COMO CORRECCIÓN ═══
 *
 * No se proyecta la forma media del día y luego se le suma algo por el momentum.
 * Se ELIGEN los días análogos: aquellos que a esta misma hora llevaban un
 * recorrido parecido al de hoy desde la apertura. La proyección es la mediana
 * de lo que hicieron ESOS días. Es la misma idea que el motor de analogías, con
 * el día como unidad.
 *
 * Condicionar exige días de sobra: con 7 días, quedarse con los 3 más parecidos
 * no es condicionar, es tirar cuatro quintos de la evidencia. Por eso hay dos
 * niveles y el informe dice siempre cuál se usó y con cuántos días.
 *
 * ═══ LO QUE ESTE MÓDULO NO HACE ═══
 *
 * No inventa horas que nadie observó, no rellena días incompletos, no promedia
 * entre días con y sin datos, y no convierte una mediana de 5 días en una
 * probabilidad. Cuando no hay evidencia devuelve el nivel `SOLO_HOY` o
 * `SIN_DATOS` y el panel dibuja lo real y nada más.
 */

import { percentileOf, type SeriesPoint } from './series.js';
import { binomialTailProbability } from './probability.js';

/** Venezuela: UTC-4 fijo, sin horario de verano. Igual que `venezuelaHour`. */
export const VENEZUELA_OFFSET_MS = 4 * 3_600_000;

/**
 * Ventana del día que se dibuja.
 *
 * Es una DECISIÓN DE PRESENTACIÓN, no una medición: son las horas que el
 * propietario quiere ver. Se deja como parámetro para que nadie la lea como
 * "está demostrado que el mercado sólo se mueve de 8 a 20".
 */
export const DEFAULT_DAY_START_HOUR = 8;
export const DEFAULT_DAY_END_HOUR = 20;

/**
 * Días mínimos para dibujar una curva de forma del día.
 *
 * Por debajo de 5, la mediana de los cocientes es prácticamente una o dos
 * observaciones y la banda es el recorrido de un puñado de puntos. No es un
 * umbral de significación —no lo hay con estos tamaños— sino un suelo para no
 * publicar una curva sostenida por un solo día. `daysUsed` viaja siempre en la
 * respuesta para que quien la lea juzgue por sí mismo.
 */
export const MIN_PROFILE_DAYS = 5;

/**
 * Días mínimos para CONDICIONAR por el momento del mercado.
 *
 * Condicionar se queda con la mitad más parecida. Con menos de 12 días esa
 * mitad baja de 6 y el condicionado tendría menos evidencia que el sin
 * condicionar: se preferiría un filtro elegante a un dato mejor.
 */
export const MIN_CONDITIONED_DAYS = 12;

/** Fracción de días análogos que se conserva al condicionar. */
export const CONDITIONED_FRACTION = 0.5;

/**
 * Días mínimos para llamar percentiles a los extremos de la banda.
 *
 * Con 9 días o menos, el "p10" caería sobre el mínimo observado; llamarlo
 * percentil sugeriría una precisión que no existe, así que la banda se publica
 * como RANGO_OBSERVADO y el nombre lo dice.
 */
export const BAND_PERCENTILE_DAYS = 10;

export type DailySide = 'BUY' | 'SELL';

export type DailyTier =
  /** Ni siquiera hay serie de hoy. */
  | 'SIN_DATOS'
  /** Hay hoy, pero no hay días anteriores suficientes: no se proyecta nada. */
  | 'SOLO_HOY'
  /** Perfil de hora del día sin condicionar por el momento del mercado. */
  | 'PERFIL_LIMITADO'
  /** Perfil construido sólo con los días análogos al momento de hoy. */
  | 'PERFIL_CONDICIONADO';

export const TIER_TEXT: Record<DailyTier, string> = {
  SIN_DATOS: 'No hay serie suficiente para dibujar el día.',
  SOLO_HOY: 'Sólo hay datos de hoy. Faltan días anteriores para proyectar el resto de la jornada.',
  PERFIL_LIMITADO: 'Proyección sobre pocos días, sin filtrar por el momento del mercado.',
  PERFIL_CONDICIONADO: 'Proyección sobre los días que llegaron a esta hora en un estado parecido al de hoy.',
};

/** Hora local de Venezuela de un instante. */
export function venezuelaHourOf(t: number): number {
  return new Date(t - VENEZUELA_OFFSET_MS).getUTCHours();
}

/** Clave de día local 'YYYY-MM-DD'. Dos instantes del mismo día la comparten. */
export function venezuelaDayKey(t: number): string {
  return new Date(t - VENEZUELA_OFFSET_MS).toISOString().slice(0, 10);
}

/** El mejor precio de un lado es el más bajo comprando y el más alto vendiendo. */
export function isBetter(side: DailySide, candidate: number, incumbent: number): boolean {
  return side === 'BUY' ? candidate < incumbent : candidate > incumbent;
}

export interface HourCell {
  hour: number;
  /** Mejor precio observado en esa hora. */
  best: number;
  observations: number;
  /** Último instante observado dentro de la hora. */
  lastT: number;
}

export interface DayShape {
  dayKey: string;
  /** Sólo horas realmente observadas. Las que faltan NO se rellenan. */
  hours: Map<number, HourCell>;
}

/**
 * Agrupa una serie en días y horas locales, quedándose con el mejor precio.
 *
 * Las horas fuera de la ventana se descartan aquí y no más tarde: así el perfil
 * y el dibujo hablan exactamente del mismo tramo del día.
 */
export function groupByDay(
  points: readonly SeriesPoint[],
  side: DailySide,
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
      day = { dayKey: key, hours: new Map() };
      days.set(key, day);
    }

    const cell = day.hours.get(hour);
    if (cell === undefined) {
      day.hours.set(hour, { hour, best: p.price, observations: 1, lastT: p.t });
      continue;
    }
    cell.observations += 1;
    if (p.t > cell.lastT) cell.lastT = p.t;
    if (isBetter(side, p.price, cell.best)) cell.best = p.price;
  }

  return [...days.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

/**
 * Cociente de precio entre dos horas del mismo día.
 *
 * Se trabaja en cocientes y no en diferencias absolutas porque el VES tiene
 * deriva: 3 bolívares en un día de 900 y 3 en un día de 300 no son el mismo
 * movimiento, y promediarlos como si lo fueran deformaría el perfil.
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
    // Un día sin una de las dos horas no aporta: no se interpola la que falta.
    if (a === undefined || t === undefined) continue;
    if (a.best <= 0 || t.best <= 0) continue;
    out.push({ dayKey: day.dayKey, ratio: t.best / a.best });
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

export interface HourProjection {
  hour: number;
  /** Escenario central: la mediana de lo que hicieron los días análogos. */
  central: number;
  low: number;
  high: number;
  bandKind: BandKind;
  /** Días que aportaron esta hora. Puede ser menor que el total del perfil. */
  daysUsed: number;
  /** Cambio respecto de la hora anterior de la trayectoria, en %. */
  movePct: number | null;
}

/**
 * Proyecta una hora desde el ancla.
 *
 * `null` cuando ningún día análogo tenía esa hora: una hora sin evidencia no se
 * dibuja, en vez de heredar la de al lado.
 */
export function projectHour(
  days: readonly DayShape[],
  anchorHour: number,
  targetHour: number,
  anchorPrice: number
): HourProjection | null {
  const samples = ratiosBetween(days, anchorHour, targetHour);
  if (samples.length === 0 || anchorPrice <= 0) return null;

  const ratios = samples.map((s) => s.ratio).sort((a, b) => a - b);
  const central = medianOf(ratios);
  if (central === null) return null;

  const usePercentiles = ratios.length >= BAND_PERCENTILE_DAYS;
  const lowRatio = usePercentiles ? percentileOf(ratios, 0.1) : ratios[0];
  const highRatio = usePercentiles ? percentileOf(ratios, 0.9) : ratios[ratios.length - 1];
  if (lowRatio === null || highRatio === null) return null;

  return {
    hour: targetHour,
    central: anchorPrice * central,
    low: anchorPrice * lowRatio,
    high: anchorPrice * highRatio,
    bandKind: usePercentiles ? 'P10_P90' : 'RANGO_OBSERVADO',
    daysUsed: ratios.length,
    movePct: null, // lo rellena projectRestOfDay, que conoce la hora anterior
  };
}

/**
 * Recorrido de un día desde su primera hora observada hasta `hour`.
 *
 * Es el descriptor del "momento del mercado" con el que se eligen los días
 * análogos: dos días que a la misma hora llevaban el mismo recorrido desde la
 * apertura estaban, en lo que aquí se puede medir, en el mismo estado.
 */
export function openToHourRatio(day: DayShape, hour: number): number | null {
  const target = day.hours.get(hour);
  if (target === undefined || target.best <= 0) return null;

  let openHour = Number.POSITIVE_INFINITY;
  for (const h of day.hours.keys()) if (h < openHour) openHour = h;
  if (!Number.isFinite(openHour) || openHour >= hour) return null;

  const open = day.hours.get(openHour);
  if (open === undefined || open.best <= 0) return null;
  return target.best / open.best;
}

/**
 * Se queda con los días cuyo recorrido hasta el ancla se parece más al de hoy.
 *
 * Devuelve TODOS los días cuando no hay suficientes para condicionar: preferir
 * un subconjunto pequeño y parecido a un conjunto grande es cambiar evidencia
 * por estética.
 */
export function selectAnalogousDays(
  days: readonly DayShape[],
  anchorHour: number,
  todayRatio: number | null
): { days: DayShape[]; conditioned: boolean } {
  if (todayRatio === null || days.length < MIN_CONDITIONED_DAYS) {
    return { days: [...days], conditioned: false };
  }

  const scored: { day: DayShape; distance: number }[] = [];
  for (const day of days) {
    const ratio = openToHourRatio(day, anchorHour);
    if (ratio === null) continue;
    scored.push({ day, distance: Math.abs(Math.log(ratio) - Math.log(todayRatio)) });
  }
  if (scored.length < MIN_CONDITIONED_DAYS) return { days: [...days], conditioned: false };

  scored.sort((a, b) => a.distance - b.distance);
  const keep = Math.max(MIN_PROFILE_DAYS, Math.round(scored.length * CONDITIONED_FRACTION));
  return { days: scored.slice(0, keep).map((s) => s.day), conditioned: true };
}

export interface DayProjection {
  tier: DailyTier;
  side: DailySide;
  anchorHour: number;
  anchorPrice: number | null;
  /**
   * Horas ya ocurridas hoy, con su mejor precio real.
   *
   * `movePct` viaja calculado desde aquí y no se deja para la pantalla: el
   * panel no debe restar precios, porque en cuanto lo haga tendrá que decidir
   * qué hacer con las horas que faltan y esa decisión es estadística, no de
   * presentación.
   */
  real: { hour: number; price: number; observations: number; movePct: number | null }[];
  /** Horas que quedan, proyectadas. Vacío si no hay evidencia. */
  projected: HourProjection[];
  /** Días del perfil tras condicionar (o todos, si no se condicionó). */
  profileDays: number;
  /** Días disponibles antes de condicionar. */
  candidateDays: number;
  conditioned: boolean;
}

/**
 * Construye el día completo de un lado: lo real hasta ahora y lo proyectado
 * después. `now` se pasa explícito para que la función sea determinista y
 * testable.
 */
export function projectRestOfDay(
  points: readonly SeriesPoint[],
  side: DailySide,
  now: number,
  startHour = DEFAULT_DAY_START_HOUR,
  endHour = DEFAULT_DAY_END_HOUR
): DayProjection {
  const all = groupByDay(points, side, startHour, endHour);
  const todayKey = venezuelaDayKey(now);
  const today = all.find((d) => d.dayKey === todayKey) ?? null;
  const previous = all.filter((d) => d.dayKey < todayKey);

  const anchorHour = Math.min(Math.max(venezuelaHourOf(now), startHour), endHour);

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

  const anchorCell = today?.hours.get(anchorHour) ?? null;
  // Si la hora en curso aún no tiene observación, se ancla en la última que sí.
  const anchor = anchorCell ?? (real.length > 0 ? { best: real[real.length - 1].price } : null);
  const anchorPrice = anchor?.best ?? null;

  const base: DayProjection = {
    tier: real.length === 0 ? 'SIN_DATOS' : 'SOLO_HOY',
    side,
    anchorHour,
    anchorPrice,
    real,
    projected: [],
    profileDays: 0,
    candidateDays: previous.length,
    conditioned: false,
  };

  if (anchorPrice === null) return base;
  if (previous.length < MIN_PROFILE_DAYS) return base;

  const todayRatio = today === null ? null : openToHourRatio(today, anchorHour);
  const { days: profile, conditioned } = selectAnalogousDays(previous, anchorHour, todayRatio);
  if (profile.length < MIN_PROFILE_DAYS) return base;

  const projected: HourProjection[] = [];
  let previousPrice = anchorPrice;
  for (let hour = anchorHour + 1; hour <= endHour; hour += 1) {
    const projection = projectHour(profile, anchorHour, hour, anchorPrice);
    if (projection === null) continue;
    projection.movePct = previousPrice > 0 ? ((projection.central - previousPrice) / previousPrice) * 100 : null;
    previousPrice = projection.central;
    projected.push(projection);
  }

  if (projected.length === 0) return base;

  return {
    ...base,
    tier: conditioned ? 'PERFIL_CONDICIONADO' : 'PERFIL_LIMITADO',
    projected,
    profileDays: profile.length,
    conditioned,
  };
}

/**
 * Umbral de giro, MEDIDO en vez de elegido.
 *
 * Un giro es un cambio de hora a hora mayor que el de una hora corriente. Cuál
 * es "una hora corriente" lo dice la propia serie: la mediana de los cambios
 * absolutos entre horas consecutivas. Poner aquí un 0.3 % fijo sería inventar
 * el listón que decide qué se le anuncia al propietario.
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
      // Horas no contiguas no forman un cambio "por hora": el hueco se respeta.
      if (hours[i].hour !== hours[i - 1].hour + 1) continue;
      const from = hours[i - 1].best;
      if (from <= 0) continue;
      moves.push(Math.abs((hours[i].best - from) / from) * 100);
    }
  }
  return { pct: medianOf(moves), sampleSize: moves.length };
}

/**
 * ¿Bate el perfil a "el precio se queda donde está"?
 *
 * Validación dejando un día fuera: para cada día anterior se construye el perfil
 * con los DEMÁS y se compara su error contra el de la persistencia. El contraste
 * es el mismo que usa el motor de horizontes —signo exacto sobre el error
 * absoluto— para que las dos partes del sistema se juzguen con la misma vara.
 *
 * ═══ UN DÍA, UN CASO ═══
 *
 * Cada día produce decenas de pares ancla→objetivo, y es tentador contarlos
 * todos: daría cientos de "casos" y una p diminuta. Serían falsos. Todos esos
 * pares recorren la MISMA trayectoria de un mismo día, así que un día
 * excepcional se contaría cincuenta veces y el contraste mediría la suerte de
 * un día como si fueran cincuenta días.
 *
 * Por eso el día entero aporta UN caso: se promedia su error en todos los pares
 * y se compara con el promedio de la persistencia en los mismos pares. Con 10
 * días eso son 10 casos, y con 10 casos el signo exacto rara vez llegará a
 * significación. Ese es el punto: mientras no llegue, el sistema NO puede
 * afirmar que el perfil aporte nada, y lo dice.
 */
export interface ShapeValidation {
  /** Días comparados. Cada día es UN caso, no uno por par de horas. */
  comparisons: number;
  profileWins: number;
  persistenceWins: number;
  ties: number;
  /** Pares ancla→objetivo que sostienen la comparación, para dar contexto. */
  pairs: number;
  pValue: number | null;
  beatsPersistence: boolean;
}

export const SHAPE_VALIDATION_ALPHA = 0.05;

export function validateShape(
  days: readonly DayShape[],
  startHour = DEFAULT_DAY_START_HOUR,
  endHour = DEFAULT_DAY_END_HOUR
): ShapeValidation {
  let profileWins = 0;
  let persistenceWins = 0;
  let ties = 0;
  let pairs = 0;

  for (const held of days) {
    const others = days.filter((d) => d.dayKey !== held.dayKey);
    if (others.length < MIN_PROFILE_DAYS) continue;

    let profileError = 0;
    let persistenceError = 0;
    let dayPairs = 0;

    for (let anchor = startHour; anchor < endHour; anchor += 1) {
      const anchorCell = held.hours.get(anchor);
      if (anchorCell === undefined || anchorCell.best <= 0) continue;

      for (let target = anchor + 1; target <= endHour; target += 1) {
        const actual = held.hours.get(target);
        if (actual === undefined) continue;
        const projection = projectHour(others, anchor, target, anchorCell.best);
        if (projection === null) continue;

        profileError += Math.abs(projection.central - actual.best);
        persistenceError += Math.abs(anchorCell.best - actual.best);
        dayPairs += 1;
      }
    }

    if (dayPairs === 0) continue;
    pairs += dayPairs;
    // Promedios, no sumas: un día con más horas observadas no pesa más.
    const profileMean = profileError / dayPairs;
    const persistenceMean = persistenceError / dayPairs;
    if (profileMean < persistenceMean) profileWins += 1;
    else if (profileMean > persistenceMean) persistenceWins += 1;
    else ties += 1;
  }

  const comparisons = profileWins + persistenceWins;
  /*
   * Los empates se descartan, no se reparten: el signo exacto se define sobre
   * los casos que discrepan. Repartirlos inflaría la muestra con días que no
   * distinguen nada.
   */
  const pValue = comparisons === 0 ? null : binomialTailProbability(profileWins, comparisons);

  return {
    comparisons,
    profileWins,
    persistenceWins,
    ties,
    pairs,
    pValue,
    beatsPersistence:
      pValue !== null && pValue < SHAPE_VALIDATION_ALPHA && profileWins > persistenceWins,
  };
}
