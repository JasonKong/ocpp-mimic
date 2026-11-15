/**
 * The reference tariff and what it makes of a session. A reference tariff
 * is an OCPP 2.1 TariffType without conditions (one price per part), so the
 * same JSON can later be sent to a 2.1 station. A session is priced from its
 * reported values only, as a CSMS or a third party would, and every item
 * names the frames it used.
 *
 * Parts: fixedFee once the transaction started; energy from the meter
 * readings at its start and stop (else its first and latest); chargingTime
 * while the EV charges; idleTime while it is connected without charging by
 * its own choice (SuspendedEV, Finishing, EVConnected). Time the station
 * itself suspends (SuspendedEVSE) is not billed. Each item is rounded to
 * cents; minCost and maxCost bound the total before tax.
 */
import { stateDurations, type SessionRecord } from './session.js';

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
}

interface Part<P> {
  prices: P[];
  taxRates?: TaxRate[];
}

export interface ReferenceTariff {
  tariffId: string;
  /** ISO 4217. */
  currency: string;
  description?: { format: string; content: string; language?: string }[];
  fixedFee?: Part<{ priceFixed: number }>;
  energy?: Part<{ priceKwh: number }>;
  chargingTime?: Part<{ priceMinute: number }>;
  idleTime?: Part<{ priceMinute: number }>;
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
    if (entry.prices.length !== 1) problems.push(`${part} must have exactly one price`);
    for (const price of entry.prices) {
      if (!isObject(price) || !amount(price[field])) {
        problems.push(`${part}.prices: ${field} must be a number of at least 0`);
      } else if (price.conditions !== undefined) {
        problems.push(`${part}.prices: conditions are not supported yet`);
      }
    }
    if (entry.taxRates !== undefined) {
      const rates = Array.isArray(entry.taxRates) ? entry.taxRates : [undefined];
      for (const rate of rates) {
        if (
          !isObject(rate) ||
          typeof rate.type !== 'string' ||
          !amount(rate.tax) ||
          (rate.stack !== undefined && !(Number.isInteger(rate.stack) && Number(rate.stack) >= 0))
        ) {
          problems.push(
            `${part}.taxRates: each needs a type, a tax of at least 0 and an optional stack`,
          );
        }
      }
    }
  }
  for (const key of ['minCost', 'maxCost'] as const) {
    const cost = value[key];
    if (cost === undefined) continue;
    if (!isObject(cost) || (!amount(cost.exclTax) && !amount(cost.inclTax))) {
      problems.push(`${key} needs exclTax or inclTax of at least 0`);
    }
  }
  const min = isObject(value.minCost) ? value.minCost.exclTax : undefined;
  const max = isObject(value.maxCost) ? value.maxCost.exclTax : undefined;
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    problems.push('minCost must not be above maxCost');
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

function item(
  part: PricePart,
  tariff: ReferenceTariff,
  quantity: number,
  frames: (number | undefined)[],
): PriceItem | undefined {
  const entry = tariff[part];
  const price = entry?.prices[0] as Record<string, number> | undefined;
  if (entry === undefined || price === undefined) return undefined;
  const unitPrice = price[PARTS[part]] ?? 0;
  const exclTax = cents(quantity * unitPrice);
  const tax = taxOn(exclTax, entry.taxRates);
  return {
    part,
    quantity,
    unit: part === 'fixedFee' ? 'session' : part === 'energy' ? 'kWh' : 'min',
    unitPrice,
    exclTax,
    tax,
    inclTax: cents(exclTax + tax),
    frames: [...new Set(frames.filter((f): f is number => f !== undefined))],
  };
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

/** What `tariff` makes of `record`, up to its end or `now` while it runs. */
export function priceSession(
  record: SessionRecord,
  tariff: ReferenceTariff,
  now: string,
): SessionPrice {
  const items: PriceItem[] = [];
  const started = record.startedAt !== undefined && record.state !== 'not-started';
  if (started) {
    const fixed = item('fixedFee', tariff, 1, [startFrame(record)]);
    if (fixed !== undefined) items.push(fixed);
    const energy = deliveredWh(record);
    const kwh = Math.round(energy.wh) / 1000;
    const energyItem = item('energy', tariff, kwh, energy.frames);
    if (energyItem !== undefined) items.push(energyItem);
    const durations = stateDurations(record, now);
    const minutes = (ms: number) => Math.round(ms / 600) / 100;
    const seqsOf = (...states: string[]) =>
      record.states.filter((s) => states.includes(s.state)).map((s) => s.seq);
    const charging = item('chargingTime', tariff, minutes(durations.charging), seqsOf('charging'));
    if (charging !== undefined) items.push(charging);
    const idle = item(
      'idleTime',
      tariff,
      minutes(durations.suspendedEV + durations.idle),
      seqsOf('suspendedEV', 'idle'),
    );
    if (idle !== undefined) items.push(idle);
  }
  let exclTax = cents(items.reduce((sum, i) => sum + i.exclTax, 0));
  let tax = cents(items.reduce((sum, i) => sum + i.tax, 0));
  let adjusted: SessionPrice['adjusted'];
  const bound = (limit: number) => {
    // Taxes follow the net total in proportion; without any, the limit carries none.
    tax = exclTax > 0 ? cents((tax * limit) / exclTax) : 0;
    exclTax = limit;
  };
  const min = tariff.minCost?.exclTax;
  const max = tariff.maxCost?.exclTax;
  if (started && min !== undefined && exclTax < min) {
    bound(min);
    adjusted = 'minCost';
  } else if (max !== undefined && exclTax > max) {
    bound(max);
    adjusted = 'maxCost';
  }
  return {
    tariffId: tariff.tariffId,
    currency: tariff.currency,
    items,
    exclTax,
    tax,
    inclTax: cents(exclTax + tax),
    ...(adjusted !== undefined && { adjusted }),
  };
}
