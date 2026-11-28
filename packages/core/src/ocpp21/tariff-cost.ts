/**
 * Local cost calculation of OCPP 2.1 (block I, I07–I12): which tariff prices
 * apply, and the cost of a transaction as it runs, reported as costDetails.
 * Pure: the station feeds it the transaction's state (energy, charging or
 * idle, power, current) over time and asks for the cost.
 *
 * - Every dimension (energy, charging time, idle time) uses the first of its
 *   prices whose conditions all hold (Part 2, I 1.2); none, and the dimension
 *   costs nothing for that time. The fixed fee is chosen once, at the start
 *   (I12.FR.30).
 * - A charging period starts whenever the chosen prices or the tariff change
 *   (I12.FR.35, .36).
 * - Time and energy are priced pro rata (per second and per Wh): the
 *   specification has no billing increments. Amounts are reported in cents.
 * - Taxes stack (I12.FR.12, .13); minCost replaces a lower total at the end
 *   (FR.38); maxCost caps the total exactly once it is reached (FR.39, .40).
 * - Times of day and dates are local to the station's time zone; validFrom
 *   is UTC (I07.FR.17, .18).
 */
import type {
  CostDetailsType,
  PriceType,
  TariffConditionsFixedType,
  TariffConditionsType,
  TariffType,
  TaxRateType,
} from './messages.js';

type Bare<T> = Omit<T, 'customData'>;
export type Tariff21 = Bare<TariffType>;
type Rates = readonly Bare<TaxRateType>[] | undefined;

/** What a price's conditions look at. */
export interface TariffSituation {
  at: number;
  /** The transaction's energy so far, in Wh. */
  energyWh: number;
  powerW: number;
  /** Summed over the phases. */
  currentA: number;
  /** Seconds since the transaction started, charging and idle. */
  durationS: number;
  chargingS: number;
  idleS: number;
  /** Energy flows: the time counts as charging time, else as idle time. */
  charging: boolean;
  /**
   * Neither charging nor idle time: the time is not priced. The reference price uses it for time
   * the station withholds power (SuspendedEVSE) and for an idle grace period; a station never does.
   */
  paused?: boolean;
}

export interface TariffPlace {
  /** IANA time zone of the station (ClockCtrlr.TimeZone); UTC when empty. */
  timeZone: string;
  evseKind: 'AC' | 'DC';
  /** The payment's brand and recognition, for fixed fees of ad hoc payments (C18). */
  payment?: { brand?: string; recognition?: string };
}

// ---- Local time -------------------------------------------------------------

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone === '' ? 'UTC' : timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'long',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The local date (YYYY-MM-DD), weekday and minute of the day of `at` in `timeZone`. */
export function localTime(at: number, timeZone: string) {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const offsetMs =
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    ) -
    (at - (at % 1000));
  return { date, weekday: parts.weekday ?? '', minute, offsetMs };
}

/** The UTC moment of a local date and minute in `timeZone` (the first, around a DST change). */
function zonedMoment(date: string, minute: number, timeZone: string): number {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(minute / 60), minute % 60);
  const first = guess - localTime(guess, timeZone).offsetMs;
  return guess - localTime(first, timeZone).offsetMs;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const minuteOf = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// ---- Conditions ---------------------------------------------------------------

type Calendar = Pick<
  TariffConditionsType,
  'startTimeOfDay' | 'endTimeOfDay' | 'dayOfWeek' | 'validFromDate' | 'validToDate' | 'evseKind'
>;

function calendarHolds(c: Calendar, at: number, place: TariffPlace): boolean {
  const local = localTime(at, place.timeZone);
  if (c.startTimeOfDay !== undefined || c.endTimeOfDay !== undefined) {
    const start = c.startTimeOfDay === undefined ? 0 : minuteOf(c.startTimeOfDay);
    // 00:00 as the end means the end of the day.
    const endRaw = c.endTimeOfDay === undefined ? 1440 : minuteOf(c.endTimeOfDay);
    const end = endRaw === 0 ? 1440 : endRaw;
    const inside =
      start < end
        ? local.minute >= start && local.minute < end
        : local.minute >= start || local.minute < end;
    if (!inside) return false;
  }
  if (c.dayOfWeek !== undefined && !c.dayOfWeek.includes(local.weekday as never)) return false;
  if (c.validFromDate !== undefined && local.date < c.validFromDate) return false;
  if (c.validToDate !== undefined && local.date >= c.validToDate) return false;
  if (c.evseKind !== undefined && c.evseKind !== place.evseKind) return false;
  return true;
}

const within = (value: number, min: number | undefined, max: number | undefined) =>
  (min === undefined || value >= min) && (max === undefined || value < max);

/** Whether a price's conditions all hold (Part 2, I 1.2); none always holds. */
export function conditionsHold(
  c: Bare<TariffConditionsType> | undefined,
  s: TariffSituation,
  place: TariffPlace,
): boolean {
  if (c === undefined) return true;
  return (
    calendarHolds(c, s.at, place) &&
    within(s.energyWh, c.minEnergy, c.maxEnergy) &&
    within(s.currentA, c.minCurrent, c.maxCurrent) &&
    within(s.powerW, c.minPower, c.maxPower) &&
    within(s.durationS, c.minTime, c.maxTime) &&
    within(s.chargingS, c.minChargingTime, c.maxChargingTime) &&
    within(s.idleS, c.minIdleTime, c.maxIdleTime)
  );
}

/** Whether a fixed price's conditions hold at the start, payment included (C18). */
export function fixedConditionsHold(
  c: Bare<TariffConditionsFixedType> | undefined,
  at: number,
  place: TariffPlace,
): boolean {
  if (c === undefined) return true;
  if (c.paymentBrand !== undefined && c.paymentBrand !== place.payment?.brand) return false;
  if (c.paymentRecognition !== undefined && c.paymentRecognition !== place.payment?.recognition) {
    return false;
  }
  return calendarHolds(c, at, place);
}

/** The next moment after `at` a time-of-day, day or date condition can change. */
export function nextCalendarChange(
  tariff: Tariff21,
  at: number,
  place: TariffPlace,
): number | undefined {
  const conditions = [tariff.energy, tariff.chargingTime, tariff.idleTime].flatMap((d) =>
    (d?.prices ?? []).map((p) => p.conditions).filter((c) => c !== undefined),
  );
  if (conditions.length === 0) return undefined;
  const local = localTime(at, place.timeZone);
  const minutes = new Set<number>([0]);
  for (const c of conditions) {
    if (c.startTimeOfDay !== undefined) minutes.add(minuteOf(c.startTimeOfDay));
    if (c.endTimeOfDay !== undefined) minutes.add(minuteOf(c.endTimeOfDay));
  }
  const tomorrow = new Date(Date.parse(`${local.date}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  const candidates = [...minutes].flatMap((minute) => [
    zonedMoment(local.date, minute, place.timeZone),
    zonedMoment(tomorrow, minute, place.timeZone),
  ]);
  const next = candidates.filter((t) => t > at);
  return next.length === 0 ? undefined : Math.min(...next);
}

// ---- Checking a tariff (I07, I08, I11) --------------------------------------------

export type TariffCheck =
  | { status: 'Accepted' }
  | { status: 'TooManyElements' | 'ConditionNotSupported' | 'Rejected'; reason: string };

/**
 * Whether the station can use a tariff: at most `maxElements` prices per
 * dimension (TariffCostCtrlr.MaxElements), conditions only when supported,
 * and well-formed values (Rejected, reasonCode InvalidValue).
 */
export function checkTariff(
  tariff: Tariff21,
  limits: { maxElements: number; conditionsSupported: boolean },
): TariffCheck {
  if (!/^[A-Z]{3}$/.test(tariff.currency)) {
    return { status: 'Rejected', reason: `currency ${tariff.currency} is not an ISO 4217 code` };
  }
  const dimensions = {
    energy: tariff.energy,
    chargingTime: tariff.chargingTime,
    idleTime: tariff.idleTime,
    fixedFee: tariff.fixedFee,
    reservationTime: tariff.reservationTime,
    reservationFixed: tariff.reservationFixed,
  };
  for (const [name, dimension] of Object.entries(dimensions)) {
    const prices = (dimension?.prices ?? []) as { conditions?: Calendar }[];
    if (prices.length > limits.maxElements) {
      return { status: 'TooManyElements', reason: `${name} has ${prices.length} prices` };
    }
    for (const { conditions } of prices) {
      if (conditions === undefined) continue;
      if (!limits.conditionsSupported) {
        return { status: 'ConditionNotSupported', reason: `${name} has conditions` };
      }
      for (const key of ['startTimeOfDay', 'endTimeOfDay'] as const) {
        const value = conditions[key];
        if (value !== undefined && !HHMM.test(value)) {
          return { status: 'Rejected', reason: `${name}: ${key} ${value} is not hh:mm` };
        }
      }
      for (const key of ['validFromDate', 'validToDate'] as const) {
        const value = conditions[key];
        if (value !== undefined && !DATE.test(value)) {
          return { status: 'Rejected', reason: `${name}: ${key} ${value} is not a date` };
        }
      }
      if (
        conditions.dayOfWeek !== undefined &&
        conditions.dayOfWeek.some((d) => !DAYS.includes(d))
      ) {
        return { status: 'Rejected', reason: `${name}: unknown dayOfWeek` };
      }
    }
  }
  return { status: 'Accepted' };
}

// ---- The cost of a transaction ---------------------------------------------------

/** Tax at stacked rates, unrounded: each stack also taxes the taxes below it (I12.FR.13). */
export function stackedTax(net: number, rates: Rates): number {
  if (rates === undefined) return 0;
  const stacks = [...new Set(rates.map((r) => r.stack ?? 0))].sort((a, b) => a - b);
  let base = net;
  let total = 0;
  for (const stack of stacks) {
    const percent = rates
      .filter((r) => (r.stack ?? 0) === stack)
      .reduce((sum, r) => sum + r.tax, 0);
    const levelTax = (base * percent) / 100;
    total += levelTax;
    base += levelTax;
  }
  return total;
}

const cents = (value: number) => Math.round(value * 100) / 100;

type Dimension =
  'fixed' | 'energy' | 'chargingTime' | 'idleTime' | 'reservationTime' | 'reservationFixed';
const DIMENSIONS: readonly Dimension[] = [
  'fixed',
  'energy',
  'chargingTime',
  'idleTime',
  'reservationTime',
  'reservationFixed',
];

interface Amount {
  exclTax: number;
  inclTax: number;
  rates?: Rates;
}

interface Period {
  startPeriod: number;
  tariffId: string;
  /** The prices chosen: changes start a new period. */
  key: string;
  /** The index of the price chosen in each dimension, when one applied. */
  energy?: number;
  chargingTime?: number;
  idleTime?: number;
  energyWh: number;
  chargingS: number;
  idleS: number;
}

/** A charging period with the price chosen in each dimension (an index into its prices). */
export type CostPeriod = Readonly<Omit<Period, 'key'>>;

export interface CostMeterOptions {
  tariff: Tariff21;
  place: TariffPlace;
  /** The situation at the transaction's start. */
  start: TariffSituation;
  /** When the reservation the transaction used was made (I12.FR.06 to .08). */
  reservedAt?: number;
}

export interface CostMeter {
  readonly tariffId: string;
  readonly currency: string;
  /** Prices the time since the last call as the situation then was, and moves on to `s`. */
  advance(s: TariffSituation): void;
  /** Another tariff from now on (I11.FR.08); the currency stays. */
  changeTariff(tariff: Tariff21): void;
  /** The cost so far with tax, unrounded, after maxCost (and minCost when final) (E16.FR.16). */
  totalInclTax(final?: boolean): number;
  /** costDetails: running (no charging periods, I12.FR.02) or final (I12.FR.01). */
  details(final: boolean): Bare<CostDetailsType>;
  /** When a calendar condition next changes, to price up to it exactly. */
  nextChange(): number | undefined;
  /** The charging periods so far, with the prices chosen in each. */
  periods(): CostPeriod[];
}

export function createCostMeter(options: CostMeterOptions): CostMeter {
  const { place } = options;
  let tariff = options.tariff;
  let last = options.start;
  const amounts = new Map<Dimension, Amount>();
  const usage = { energyWh: 0, chargingS: 0, idleS: 0, reservationS: 0 };
  const periods: Period[] = [];
  let capped = false;

  const add = (dimension: Dimension, exclTax: number, rates: Rates) => {
    const current = amounts.get(dimension) ?? { exclTax: 0, inclTax: 0 };
    amounts.set(dimension, {
      exclTax: current.exclTax + exclTax,
      inclTax: current.inclTax + exclTax + stackedTax(exclTax, rates),
      ...(rates !== undefined && { rates }),
    });
  };
  const totals = () => {
    let exclTax = 0;
    let inclTax = 0;
    for (const amount of amounts.values()) {
      exclTax += amount.exclTax;
      inclTax += amount.inclTax;
    }
    return { exclTax, inclTax };
  };

  // The fixed fee, chosen once at the start (I12.FR.30).
  const fixed = tariff.fixedFee?.prices.find((p) =>
    fixedConditionsHold(p.conditions, last.at, place),
  );
  if (fixed !== undefined) add('fixed', fixed.priceFixed, tariff.fixedFee?.taxRates);
  // Reservation time and fee, when a reservation was used (I12.FR.06 to .08).
  if (options.reservedAt !== undefined) {
    const reservedS = Math.max(0, (last.at - options.reservedAt) / 1000);
    usage.reservationS = reservedS;
    const time = tariff.reservationTime?.prices.find((p) =>
      conditionsHold(p.conditions, last, place),
    );
    if (time !== undefined) {
      add('reservationTime', (reservedS / 60) * time.priceMinute, tariff.reservationTime?.taxRates);
    }
    const fee = tariff.reservationFixed?.prices.find((p) =>
      fixedConditionsHold(p.conditions, last.at, place),
    );
    if (fee !== undefined)
      add('reservationFixed', fee.priceFixed, tariff.reservationFixed?.taxRates);
  }

  const chosen = (s: TariffSituation) => {
    const pick = <P extends { conditions?: Bare<TariffConditionsType> }>(
      prices: readonly P[] | undefined,
    ) => {
      const view = { ...s, chargingS: usage.chargingS, idleS: usage.idleS };
      const index = (prices ?? []).findIndex((p) => conditionsHold(p.conditions, view, place));
      return index < 0 ? undefined : index;
    };
    const energy = pick(tariff.energy?.prices);
    const charging = pick(tariff.chargingTime?.prices);
    const idle = pick(tariff.idleTime?.prices);
    return { energy, charging, idle, key: `${tariff.tariffId}|${energy}|${charging}|${idle}` };
  };

  function advance(s: TariffSituation): void {
    const dtS = Math.max(0, (s.at - last.at) / 1000);
    const dWh = Math.max(0, s.energyWh - last.energyWh);
    const pick = chosen(last);
    let period = periods.at(-1);
    if (period === undefined || period.key !== pick.key) {
      period = {
        startPeriod: last.at,
        tariffId: tariff.tariffId,
        key: pick.key,
        ...(pick.energy !== undefined && { energy: pick.energy }),
        ...(pick.charging !== undefined && { chargingTime: pick.charging }),
        ...(pick.idle !== undefined && { idleTime: pick.idle }),
        energyWh: 0,
        chargingS: 0,
        idleS: 0,
      };
      periods.push(period);
    }
    const chargingS = last.charging ? dtS : 0;
    const idleS = last.charging || last.paused === true ? 0 : dtS;
    usage.energyWh += dWh;
    usage.chargingS += chargingS;
    usage.idleS += idleS;
    period.energyWh += dWh;
    period.chargingS += chargingS;
    period.idleS += idleS;
    last = s;
    if (capped) return;
    const before = totals();
    const accruals: [Dimension, number, Rates][] = [];
    if (pick.energy !== undefined && tariff.energy !== undefined) {
      const price = tariff.energy.prices[pick.energy]?.priceKwh ?? 0;
      accruals.push(['energy', (dWh / 1000) * price, tariff.energy.taxRates]);
    }
    if (pick.charging !== undefined && tariff.chargingTime !== undefined && chargingS > 0) {
      const price = tariff.chargingTime.prices[pick.charging]?.priceMinute ?? 0;
      accruals.push(['chargingTime', (chargingS / 60) * price, tariff.chargingTime.taxRates]);
    }
    if (pick.idle !== undefined && tariff.idleTime !== undefined && idleS > 0) {
      const price = tariff.idleTime.prices[pick.idle]?.priceMinute ?? 0;
      accruals.push(['idleTime', (idleS / 60) * price, tariff.idleTime.taxRates]);
    }
    const deltaExcl = accruals.reduce((sum, [, excl]) => sum + excl, 0);
    const deltaIncl = accruals.reduce(
      (sum, [, excl, rates]) => sum + excl + stackedTax(excl, rates),
      0,
    );
    // maxCost: the part of this accrual that reaches it, then nothing more (I12.FR.39, .40).
    let share = 1;
    const max = tariff.maxCost;
    if (max?.exclTax !== undefined && before.exclTax + deltaExcl >= max.exclTax && deltaExcl > 0) {
      share = Math.min(share, (max.exclTax - before.exclTax) / deltaExcl);
    }
    if (max?.inclTax !== undefined && before.inclTax + deltaIncl >= max.inclTax && deltaIncl > 0) {
      share = Math.min(share, (max.inclTax - before.inclTax) / deltaIncl);
    }
    share = Math.max(0, share);
    for (const [dimension, excl, rates] of accruals) add(dimension, excl * share, rates);
    if (share < 1) capped = true;
  }

  function price(amount: Amount | undefined): Bare<PriceType> | undefined {
    if (amount === undefined) return undefined;
    return {
      exclTax: cents(amount.exclTax),
      inclTax: cents(amount.inclTax),
      ...(amount.rates !== undefined &&
        amount.rates.length > 0 && { taxRates: [...amount.rates] as never }),
    };
  }

  /** minCost replaces a lower total once the transaction ends (I12.FR.38). */
  function belowMin(): boolean {
    const min = tariff.minCost;
    const { exclTax, inclTax } = totals();
    return (
      min !== undefined &&
      ((min.exclTax !== undefined && cents(exclTax) < min.exclTax) ||
        (min.inclTax !== undefined && cents(inclTax) < min.inclTax))
    );
  }

  function minCostTotal() {
    const min = tariff.minCost ?? {};
    const exclTax = min.exclTax ?? min.inclTax ?? 0;
    const inclTax = min.inclTax ?? exclTax + stackedTax(exclTax, min.taxRates);
    return { exclTax: cents(exclTax), inclTax: cents(inclTax) };
  }

  return {
    get tariffId() {
      return tariff.tariffId;
    },
    currency: tariff.currency,
    advance,
    changeTariff(next) {
      tariff = next;
      // The next advance opens a period for the new tariff.
    },
    totalInclTax(final = false) {
      // Unrounded: a limit compares the cost itself; cents are for reports.
      if (final && belowMin()) return minCostTotal().inclTax;
      return totals().inclTax;
    },
    details(final) {
      const usageOut = {
        energy: Math.round(usage.energyWh * 1000) / 1000,
        chargingTime: Math.round(usage.chargingS),
        idleTime: Math.round(usage.idleS),
        ...(options.reservedAt !== undefined && {
          reservationTime: Math.round(usage.reservationS),
        }),
      };
      let totalCost: Bare<CostDetailsType>['totalCost'];
      if (final && belowMin()) {
        const total = minCostTotal();
        totalCost = {
          currency: tariff.currency,
          typeOfCost: 'MinCost',
          fixed: {
            ...total,
            ...(tariff.minCost?.taxRates !== undefined && { taxRates: tariff.minCost.taxRates }),
          },
          total,
        };
      } else {
        const parts = Object.fromEntries(
          DIMENSIONS.map((d) => [d, price(amounts.get(d))]).filter(([, p]) => p !== undefined),
        ) as Partial<Record<Dimension, Bare<PriceType>>>;
        const sum = (key: 'exclTax' | 'inclTax') =>
          cents(Object.values(parts).reduce((s, p) => s + (p?.[key] ?? 0), 0));
        totalCost = {
          currency: tariff.currency,
          typeOfCost: capped ? 'MaxCost' : 'NormalCost',
          ...parts,
          total: { exclTax: sum('exclTax'), inclTax: sum('inclTax') },
        };
      }
      const chargingPeriods = periods.map((p) => ({
        tariffId: p.tariffId,
        startPeriod: new Date(p.startPeriod).toISOString(),
        dimensions: [
          { type: 'Energy' as const, volume: Math.round(p.energyWh * 1000) / 1000 },
          { type: 'ChargingTime' as const, volume: Math.round(p.chargingS) },
          { type: 'IdleTIme' as const, volume: Math.round(p.idleS) },
        ] as [
          { type: 'Energy'; volume: number },
          { type: 'ChargingTime'; volume: number },
          { type: 'IdleTIme'; volume: number },
        ],
      }));
      const [first, ...rest] = chargingPeriods;
      return {
        totalCost,
        totalUsage: usageOut,
        ...(final && first !== undefined && { chargingPeriods: [first, ...rest] }),
      };
    },
    nextChange: () => nextCalendarChange(tariff, last.at, place),
    periods: () => periods.map(({ key: _key, ...period }) => ({ ...period })),
  };
}
