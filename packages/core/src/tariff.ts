/**
 * The reference tariff and what it makes of a session. A reference tariff
 * is an OCPP 2.1 TariffType, so the same JSON can be sent to a 2.1 station,
 * with every 2.1 price condition (time of day, weekday, dates, EVSE kind,
 * energy, current, power, durations; payment for fixed fees). A session is
 * priced from its reported values only, as a CSMS or a third party would:
 * the readings, power, current and charging states replay through the same
 * cost meter a 2.1 station prices with (I12), so the two agree on a 2.1
 * tariff. Every item names the frames it used.
 *
 * Parts: fixedFee once the transaction started; energy from the meter
 * readings (interpolated at price changes); chargingTime while the EV
 * charges; idleTime while it is connected without charging by its own
 * choice (SuspendedEV, Finishing, EVConnected), after an optional grace
 * period. Time the station itself suspends (SuspendedEVSE) is not billed,
 * which a 2.1 station counts as idle time. minCost applies once the session
 * has ended; maxCost caps the total as it is reached.
 */
import {
  createCostMeter,
  fixedConditionsHold,
  stackedTax,
  type CostPeriod,
  type Tariff21,
  type TariffPlace,
  type TariffSituation,
} from './ocpp21/tariff-cost.js';
import type { ChargingStateLabel, SessionRecord } from './session.js';

export interface TaxRate {
  /** e.g. "GST" or "State", for the receipt. */
  type: string;
  /** Percent. */
  tax: number;
  /** 0 taxes the net price; a higher stack also taxes the taxes below it. */
  stack?: number;
}

export interface Price {
  exclTax?: number;
  inclTax?: number;
  /** minCost and maxCost: the taxes on exclTax when inclTax is not given (2.1 PriceType). */
  taxRates?: TaxRate[];
}

interface Part<P> {
  prices: P[];
  taxRates?: TaxRate[];
}

/** The calendar part of 2.1 TariffConditions (local time of the station). */
export interface TimeConditions {
  /** HH:MM; a window that ends before it starts runs across midnight. */
  startTimeOfDay?: string;
  endTimeOfDay?: string;
  dayOfWeek?: (
    'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday'
  )[];
  /** YYYY-MM-DD, from inclusive, to exclusive. */
  validFromDate?: string;
  validToDate?: string;
  evseKind?: 'AC' | 'DC';
}

/** When an energy, charging time or idle time price applies: 2.1 TariffConditions. */
export interface TariffConditions extends TimeConditions {
  /** Energy of the transaction so far, in Wh. */
  minEnergy?: number;
  maxEnergy?: number;
  /** Current over the phases, in A. */
  minCurrent?: number;
  maxCurrent?: number;
  /** In W. */
  minPower?: number;
  maxPower?: number;
  /** Seconds of the transaction, of charging and of idle time so far. */
  minTime?: number;
  maxTime?: number;
  minChargingTime?: number;
  maxChargingTime?: number;
  minIdleTime?: number;
  maxIdleTime?: number;
}

/** When a fixed fee applies: 2.1 TariffConditionsFixed. */
export interface FixedConditions extends TimeConditions {
  paymentBrand?: string;
  paymentRecognition?: string;
}

export interface ReferenceTariff {
  tariffId: string;
  /** ISO 4217. */
  currency: string;
  description?: { format: string; content: string; language?: string }[];
  fixedFee?: Part<{ priceFixed: number; conditions?: FixedConditions }>;
  energy?: Part<{ priceKwh: number; conditions?: TariffConditions }>;
  chargingTime?: Part<{ priceMinute: number; conditions?: TariffConditions }>;
  idleTime?: Part<{ priceMinute: number; conditions?: TariffConditions }>;
  minCost?: Price;
  maxCost?: Price;
}

export type PricePart = 'fixedFee' | 'energy' | 'chargingTime' | 'idleTime';

export interface PriceItem {
  part: PricePart;
  quantity: number;
  unit: 'session' | 'kWh' | 'min';
  unitPrice: number;
  exclTax: number;
  tax: number;
  inclTax: number;
  /** Seqs of the frames the item comes from. */
  frames: number[];
  /** A price with conditions: when it applies. */
  conditions?: TariffConditions | FixedConditions;
}

export interface SessionPrice {
  tariffId: string;
  currency: string;
  items: PriceItem[];
  exclTax: number;
  tax: number;
  inclTax: number;
  /** The total was raised to minCost or lowered to maxCost. */
  adjusted?: 'minCost' | 'maxCost';
}

const PARTS = {
  fixedFee: 'priceFixed',
  energy: 'priceKwh',
  chargingTime: 'priceMinute',
  idleTime: 'priceMinute',
} as const;
const UNSUPPORTED = ['reservationTime', 'reservationFixed', 'validFrom'];
const KNOWN = new Set([
  'tariffId',
  'currency',
  'description',
  'minCost',
  'maxCost',
  ...Object.keys(PARTS),
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const amount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const cents = (value: number) => Math.round(value * 100) / 100;

/** Tax rates: each with a type, a tax of at least 0 and an optional whole stack. */
function ratesValid(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (rate) =>
        isObject(rate) &&
        typeof rate.type === 'string' &&
        amount(rate.tax) &&
        (rate.stack === undefined || (Number.isInteger(rate.stack) && Number(rate.stack) >= 0)),
    )
  );
}

/** Problems with a reference tariff, empty when it is usable. */
export function tariffProblems(value: unknown): string[] {
  if (!isObject(value)) return ['a tariff must be an object'];
  const problems: string[] = [];
  if (typeof value.tariffId !== 'string' || value.tariffId === '' || value.tariffId.length > 60) {
    problems.push('tariffId must be a string of 1 to 60 characters');
  }
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) {
    problems.push('currency must be an ISO 4217 code such as NZD');
  }
  for (const key of Object.keys(value)) {
    if (UNSUPPORTED.includes(key)) problems.push(`${key} is not supported yet`);
    else if (!KNOWN.has(key)) problems.push(`unknown field ${key}`);
  }
  for (const [part, field] of Object.entries(PARTS)) {
    const entry = value[part];
    if (entry === undefined) continue;
    if (!isObject(entry) || !Array.isArray(entry.prices)) {
      problems.push(`${part}.prices must be a list`);
      continue;
    }
    if (entry.prices.length === 0) problems.push(`${part} needs a price`);
    const prices: unknown[] = entry.prices;
    for (const price of prices) {
      if (!isObject(price) || !amount(price[field])) {
        problems.push(`${part}.prices: ${field} must be a number of at least 0`);
      } else if (price.conditions !== undefined) {
        problems.push(...conditionProblems(part, price.conditions));
      }
    }
    if (entry.taxRates !== undefined && !ratesValid(entry.taxRates)) {
      problems.push(
        `${part}.taxRates: each needs a type, a tax of at least 0 and an optional stack`,
      );
    }
  }
  for (const key of ['minCost', 'maxCost'] as const) {
    const cost = value[key];
    if (cost === undefined) continue;
    if (!isObject(cost) || (!amount(cost.exclTax) && !amount(cost.inclTax))) {
      problems.push(`${key} needs exclTax or inclTax of at least 0`);
    } else if (cost.taxRates !== undefined && !ratesValid(cost.taxRates)) {
      problems.push(
        `${key}.taxRates: each needs a type, a tax of at least 0 and an optional stack`,
      );
    }
  }
  const min = isObject(value.minCost) ? value.minCost.exclTax : undefined;
  const max = isObject(value.maxCost) ? value.maxCost.exclTax : undefined;
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    problems.push('minCost must not be above maxCost');
  }
  return problems;
}

const CALENDAR_KEYS = [
  'startTimeOfDay',
  'endTimeOfDay',
  'dayOfWeek',
  'validFromDate',
  'validToDate',
  'evseKind',
];
const AMOUNT_KEYS = [
  'minEnergy',
  'maxEnergy',
  'minCurrent',
  'maxCurrent',
  'minPower',
  'maxPower',
  'minTime',
  'maxTime',
  'minChargingTime',
  'maxChargingTime',
  'minIdleTime',
  'maxIdleTime',
];
const PAYMENT_KEYS = ['paymentBrand', 'paymentRecognition'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Problems with a price's 2.1 conditions: TariffConditionsFixed for fixed fees, else TariffConditions. */
function conditionProblems(part: string, value: unknown): string[] {
  const where = `${part}.prices`;
  if (!isObject(value)) return [`${where}: conditions must be an object`];
  const allowed = [...CALENDAR_KEYS, ...(part === 'fixedFee' ? PAYMENT_KEYS : AMOUNT_KEYS)];
  const problems: string[] = [];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`${where}: condition ${key} is not one of ${part}'s`);
  }
  for (const key of ['startTimeOfDay', 'endTimeOfDay'] as const) {
    const time = value[key];
    if (
      time !== undefined &&
      !(typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    ) {
      problems.push(`${where}: ${key} must be HH:MM`);
    }
  }
  for (const key of ['validFromDate', 'validToDate'] as const) {
    const date = value[key];
    if (date !== undefined && !(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))) {
      problems.push(`${where}: ${key} must be YYYY-MM-DD`);
    }
  }
  const days = value.dayOfWeek;
  if (
    days !== undefined &&
    !(Array.isArray(days) && days.length > 0 && days.every((d) => WEEKDAYS.includes(String(d))))
  ) {
    problems.push(`${where}: dayOfWeek must list days such as Monday`);
  }
  if (value.evseKind !== undefined && value.evseKind !== 'AC' && value.evseKind !== 'DC') {
    problems.push(`${where}: evseKind must be AC or DC`);
  }
  for (const key of AMOUNT_KEYS) {
    if (value[key] !== undefined && allowed.includes(key) && !amount(value[key])) {
      problems.push(`${where}: ${key} must be a number of at least 0`);
    }
  }
  for (const key of PAYMENT_KEYS) {
    if (value[key] !== undefined && allowed.includes(key) && typeof value[key] !== 'string') {
      problems.push(`${where}: ${key} must be a string`);
    }
  }
  return problems;
}

/** Tax on `net` at these rates: each stack taxes the net price and the taxes of lower stacks. */
export function taxOn(net: number, rates: readonly TaxRate[] = []): number {
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
  return cents(total);
}

/** The energy delivered in Wh, from the readings at the start and the stop (else the first and latest). */
export function deliveredWh(record: SessionRecord): { wh: number; frames: (number | undefined)[] } {
  const readings = record.samples.filter((s) => s.energyWh !== undefined);
  const first = readings[0];
  const last = readings.at(-1);
  const startWh = record.meterStartWh ?? first?.energyWh;
  const stopWh = record.meterStopWh ?? last?.energyWh;
  if (startWh === undefined || stopWh === undefined) return { wh: 0, frames: [] };
  return {
    wh: Math.max(0, stopWh - startWh),
    frames: [
      record.meterStartWh === undefined ? first?.seq : record.meterStartSeq,
      record.meterStopWh === undefined ? last?.seq : record.meterStopSeq,
    ],
  };
}

/** The frame that started the transaction: StartTransaction or TransactionEvent Started. */
function startFrame(record: SessionRecord): number | undefined {
  return record.timeline.find(
    (step) =>
      step.messageType === 2 &&
      (step.action === 'StartTransaction' ||
        (step.action === 'TransactionEvent' && step.status?.startsWith('Started') === true)),
  )?.seq;
}

/** Where and how a session is priced. */
export interface PricingPlace {
  /** The station's time zone, for time-of-day prices (default UTC). */
  timeZone?: string;
  /** For prices with an evseKind condition (default AC). */
  evseKind?: 'AC' | 'DC';
  /** Idle minutes not priced, at the start of the idle time (default 0). */
  idleGraceMinutes?: number;
}

const PART_UNIT = {
  fixedFee: 'session',
  energy: 'kWh',
  chargingTime: 'min',
  idleTime: 'min',
} as const;

/** What the session reported over time: energy (from the start), power, current and state. */
function sessionCourse(record: SessionRecord, startAt: number) {
  const valid = (at: string | undefined) => (at === undefined ? NaN : Date.parse(at));
  const readings: { at: number; wh: number; seq?: number | undefined }[] = [];
  const firstSample = record.samples.find((s) => s.energyWh !== undefined);
  const baseWh = record.meterStartWh ?? firstSample?.energyWh ?? 0;
  readings.push({
    at: startAt,
    wh: 0,
    ...(record.meterStartWh !== undefined &&
      record.meterStartSeq !== undefined && { seq: record.meterStartSeq }),
  });
  for (const s of record.samples) {
    const at = valid(s.at);
    if (s.energyWh !== undefined && Number.isFinite(at)) {
      readings.push({ at: Math.max(at, startAt), wh: s.energyWh - baseWh, seq: s.seq });
    }
  }
  const endedAt = valid(record.endedAt);
  if (record.meterStopWh !== undefined && Number.isFinite(endedAt)) {
    readings.push({ at: endedAt, wh: record.meterStopWh - baseWh, seq: record.meterStopSeq });
  }
  readings.sort((a, b) => a.at - b.at);
  // Between two readings, energy rises only while the EV charges (else evenly, if it never did).
  function energyAt(at: number): number {
    let before = readings[0] ?? { at: startAt, wh: 0 };
    for (const r of readings) {
      if (r.at <= at) {
        before = r;
        continue;
      }
      const span = r.at - before.at;
      if (span <= 0) return r.wh;
      const chargingSpan = chargingMs(before.at, r.at);
      const share =
        chargingSpan > 0 ? chargingMs(before.at, at) / chargingSpan : (at - before.at) / span;
      return before.wh + (r.wh - before.wh) * share;
    }
    return before.wh;
  }
  const stepAt = <T>(pick: (s: SessionRecord['samples'][number]) => T | undefined, at: number) => {
    let value: T | undefined;
    for (const s of record.samples) {
      const sAt = valid(s.at);
      if (!Number.isFinite(sAt) || sAt > at) continue;
      const v = pick(s);
      if (v !== undefined) value = v;
    }
    return value;
  };
  const states = [...record.states]
    .map((c) => ({ at: valid(c.at), state: c.state }))
    .filter((c) => Number.isFinite(c.at))
    .sort((a, b) => a.at - b.at);
  const stateAt = (at: number): ChargingStateLabel => {
    let state: ChargingStateLabel = 'idle';
    for (const c of states) if (c.at <= at) state = c.state;
    return state;
  };
  /** Milliseconds in the charging state between `from` and `to`. */
  function chargingMs(from: number, to: number): number {
    let total = 0;
    let since = from;
    let state = stateAt(from);
    for (const c of states) {
      if (c.at <= from) continue;
      if (c.at >= to) break;
      if (state === 'charging') total += c.at - since;
      since = c.at;
      state = c.state;
    }
    if (state === 'charging') total += to - since;
    return total;
  }
  const changes = [...readings.map((r) => r.at), ...states.map((c) => c.at)];
  return {
    readings,
    changes,
    energyAt,
    powerAt: (at: number) => stepAt((s) => s.powerW, at) ?? 0,
    currentAt: (at: number) => {
      const currents = stepAt((s) => s.currentA, at);
      return currents === undefined ? 0 : Object.values(currents).reduce((a, b) => a + (b ?? 0), 0);
    },
    stateAt,
  };
}

/** What `tariff` makes of `record`, up to its end or `now` while it runs. */
export function priceSession(
  record: SessionRecord,
  tariff: ReferenceTariff,
  now: string,
  place: PricingPlace = {},
): SessionPrice {
  const empty = {
    tariffId: tariff.tariffId,
    currency: tariff.currency,
    items: [],
    exclTax: 0,
    tax: 0,
    inclTax: 0,
  };
  if (record.startedAt === undefined || record.state === 'not-started') return empty;
  const startAt = Date.parse(record.startedAt);
  const endAt = Math.max(startAt, Date.parse(record.endedAt ?? now));
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) return empty;
  const meterPlace: TariffPlace = {
    timeZone: place.timeZone || 'UTC',
    evseKind: place.evseKind ?? 'AC',
  };
  const course = sessionCourse(record, startAt);
  let graceLeftS = Math.max(0, (place.idleGraceMinutes ?? 0) * 60);
  const situationAt = (at: number): TariffSituation & { grace: boolean } => {
    const state = course.stateAt(at);
    const idle = state === 'suspendedEV' || state === 'idle';
    const grace = idle && graceLeftS > 1e-9;
    return {
      at,
      energyWh: course.energyAt(at),
      powerW: course.powerAt(at),
      currentA: course.currentAt(at),
      durationS: (at - startAt) / 1000,
      chargingS: 0,
      idleS: 0,
      charging: state === 'charging',
      paused: state === 'suspendedEVSE' || grace,
      grace,
    };
  };
  let current = situationAt(startAt);
  const meter = createCostMeter({ tariff: tariff as Tariff21, place: meterPlace, start: current });
  const events = [...new Set(course.changes)]
    .filter((t) => t > startAt && t < endAt)
    .sort((a, b) => a - b);
  events.push(endAt);
  let cursor = startAt;
  for (const target of events) {
    while (cursor < target) {
      let next = target;
      const calendar = meter.nextChange();
      if (calendar !== undefined && calendar > cursor && calendar < next) next = calendar;
      if (current.grace && cursor + graceLeftS * 1000 < next) next = cursor + graceLeftS * 1000;
      if (current.grace) graceLeftS = Math.max(0, graceLeftS - (next - cursor) / 1000);
      cursor = next;
      current = situationAt(cursor);
      meter.advance(current);
    }
  }
  const final = record.endedAt !== undefined || record.state === 'finished';
  const total = meter.details(final).totalCost;
  const items = priceItems(record, tariff, meter.periods(), startAt, endAt, course, meterPlace);
  const exclTax = total.total?.exclTax ?? 0;
  const inclTax = total.total?.inclTax ?? 0;
  const adjusted =
    total.typeOfCost === 'MinCost'
      ? 'minCost'
      : total.typeOfCost === 'MaxCost'
        ? 'maxCost'
        : undefined;
  return {
    tariffId: tariff.tariffId,
    currency: tariff.currency,
    items,
    exclTax,
    tax: cents(inclTax - exclTax),
    inclTax,
    ...(adjusted !== undefined && { adjusted }),
  };
}

/** One item per price used in each part (and the parts' prices without conditions), in the tariff's order. */
function priceItems(
  record: SessionRecord,
  tariff: ReferenceTariff,
  periods: CostPeriod[],
  startAt: number,
  endAt: number,
  course: ReturnType<typeof sessionCourse>,
  place: TariffPlace,
): PriceItem[] {
  const items: PriceItem[] = [];
  const make = (
    part: PricePart,
    unitPrice: number,
    quantityExact: number,
    rates: readonly TaxRate[] | undefined,
    frames: (number | undefined)[],
    conditions: TariffConditions | FixedConditions | undefined,
  ): PriceItem => {
    const excl = quantityExact * unitPrice;
    const exclTax = cents(excl);
    const inclTax = cents(excl + stackedTax(excl, rates));
    return {
      part,
      quantity:
        part === 'energy'
          ? Math.round(quantityExact * 1000) / 1000
          : Math.round(quantityExact * 100) / 100,
      unit: PART_UNIT[part],
      unitPrice,
      exclTax,
      tax: cents(inclTax - exclTax),
      inclTax,
      frames: [...new Set(frames.filter((f): f is number => f !== undefined))],
      ...(conditions !== undefined && { conditions }),
    };
  };
  // The fixed fee: the first price whose conditions hold at the start (I12.FR.30).
  const fixedPrices = tariff.fixedFee?.prices ?? [];
  const fixed = fixedPrices.find((p) => fixedConditionsHold(p.conditions, startAt, place));
  if (fixed !== undefined) {
    items.push(
      make(
        'fixedFee',
        fixed.priceFixed,
        1,
        tariff.fixedFee?.taxRates,
        [startFrame(record)],
        fixed.conditions,
      ),
    );
  }
  const ends = periods.map((p, i) => periods[i + 1]?.startPeriod ?? endAt);
  const inPeriods = (index: number, key: 'energy' | 'chargingTime' | 'idleTime') =>
    periods.flatMap((p, i) =>
      p[key] === index ? [[p.startPeriod, ends[i] ?? endAt] as const] : [],
    );
  const dimension = (
    part: 'energy' | 'chargingTime' | 'idleTime',
    prices: readonly { conditions?: TariffConditions }[],
    unitPriceOf: (i: number) => number,
    amountOf: (p: CostPeriod) => number,
    framesOf: (spans: (readonly [number, number])[]) => (number | undefined)[],
    rates: readonly TaxRate[] | undefined,
  ) => {
    prices.forEach((price, i) => {
      const used = periods.filter((p) => p[part] === i);
      const quantity = used.reduce((sum, p) => sum + amountOf(p), 0);
      if (quantity <= 0 && price.conditions !== undefined) return;
      items.push(
        make(part, unitPriceOf(i), quantity, rates, framesOf(inPeriods(i, part)), price.conditions),
      );
    });
  };
  const readingFrames = (spans: (readonly [number, number])[]) =>
    course.readings.filter((r) => spans.some(([a, b]) => r.at >= a && r.at <= b)).map((r) => r.seq);
  const stateFrames = (states: string[]) => (spans: (readonly [number, number])[]) =>
    record.states
      .filter((c) => states.includes(c.state))
      .filter((c) => {
        const at = Date.parse(c.at);
        return spans.length === 0 || spans.some(([a, b]) => at >= a - 1 && at <= b) || at < startAt;
      })
      .map((c) => c.seq);
  const energy = tariff.energy;
  if (energy !== undefined) {
    dimension(
      'energy',
      energy.prices,
      (i) => energy.prices[i]?.priceKwh ?? 0,
      (p) => p.energyWh / 1000,
      readingFrames,
      energy.taxRates,
    );
  }
  const charging = tariff.chargingTime;
  if (charging !== undefined) {
    dimension(
      'chargingTime',
      charging.prices,
      (i) => charging.prices[i]?.priceMinute ?? 0,
      (p) => p.chargingS / 60,
      stateFrames(['charging']),
      charging.taxRates,
    );
  }
  const idle = tariff.idleTime;
  if (idle !== undefined) {
    dimension(
      'idleTime',
      idle.prices,
      (i) => idle.prices[i]?.priceMinute ?? 0,
      (p) => p.idleS / 60,
      stateFrames(['suspendedEV', 'idle']),
      idle.taxRates,
    );
  }
  return items;
}
