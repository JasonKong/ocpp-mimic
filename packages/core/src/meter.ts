/**
 * The energy meter of one connector: power integrated over time into a
 * register that only goes up, plus the MeterValue samples built from it.
 */
import type { Measurand } from './ocpp16.js';
import type { MeterValue, ReadingContext, SampledValue } from './ocpp16-messages.js';

export interface MeterState {
  /** The energy register in Wh, kept as a float; reported values are rounded. */
  readonly energyWh: number;
  /** Power currently delivered to the EV, in W. */
  readonly powerW: number;
  /** Power the connector offers, in W. */
  readonly offeredW: number;
  readonly voltageV: number;
  /** Time (ms since the epoch) the register was last brought up to date. */
  readonly updatedAt: number;
}

export interface CreateMeterOptions {
  now: number;
  energyWh?: number;
  offeredW?: number;
  voltageV?: number;
}

export function createMeter(options: CreateMeterOptions): MeterState {
  return {
    energyWh: options.energyWh ?? 0,
    powerW: 0,
    offeredW: options.offeredW ?? 7360,
    voltageV: options.voltageV ?? 230,
    updatedAt: options.now,
  };
}

/** The meter brought up to `now`: the current power integrated since the last update. */
export function meterAt(meter: MeterState, now: number): MeterState {
  const elapsedMs = Math.max(0, now - meter.updatedAt);
  if (elapsedMs === 0) return meter;
  return {
    ...meter,
    energyWh: meter.energyWh + (meter.powerW * elapsedMs) / 3_600_000,
    updatedAt: Math.max(now, meter.updatedAt),
  };
}

/** Changes the delivered power at `now`, after integrating the power so far. */
export function withPower(meter: MeterState, now: number, powerW: number): MeterState {
  const current = meterAt(meter, now);
  return { ...current, powerW: Math.max(0, Math.min(powerW, current.offeredW)) };
}

/** The energy register as reported: whole Wh. */
export function registerWh(meter: MeterState): number {
  return Math.round(meter.energyWh);
}

/** Measurands this meter can sample; others in a configured list are skipped. */
export const SUPPORTED_MEASURANDS: readonly Measurand[] = [
  'Energy.Active.Import.Register',
  'Power.Active.Import',
  'Power.Offered',
  'Current.Import',
  'Current.Offered',
  'Voltage',
];

const round1 = (value: number) => (Math.round(value * 10) / 10).toString();

function sampledValue(
  meter: MeterState,
  measurand: Measurand,
  context: ReadingContext,
): SampledValue | undefined {
  const base = { context, measurand, location: 'Outlet' as const };
  switch (measurand) {
    case 'Energy.Active.Import.Register':
      return { ...base, value: String(registerWh(meter)), unit: 'Wh' };
    case 'Power.Active.Import':
      return { ...base, value: round1(meter.powerW), unit: 'W' };
    case 'Power.Offered':
      return { ...base, value: round1(meter.offeredW), unit: 'W' };
    case 'Current.Import':
      return { ...base, value: round1(meter.powerW / meter.voltageV), unit: 'A' };
    case 'Current.Offered':
      return { ...base, value: round1(meter.offeredW / meter.voltageV), unit: 'A' };
    case 'Voltage':
      return { ...base, value: round1(meter.voltageV), unit: 'V' };
    default:
      return undefined;
  }
}

/**
 * One MeterValue at `now` with a sampled value for each supported measurand in
 * `measurands`, or undefined when none of them is supported.
 */
export function sampleMeter(
  meter: MeterState,
  now: number,
  measurands: readonly string[],
  context: ReadingContext,
): MeterValue | undefined {
  const current = meterAt(meter, now);
  const values = measurands
    .map((m) => sampledValue(current, m as Measurand, context))
    .filter((v): v is SampledValue => v !== undefined);
  const [first, ...rest] = values;
  if (first === undefined) return undefined;
  return { timestamp: new Date(now).toISOString(), sampledValue: [first, ...rest] };
}

/**
 * When the next periodic sample of a transaction started at `startedAt` is
 * due, or undefined when `intervalS` is 0 (sampling off).
 */
export function nextPeriodicSample(
  startedAt: number,
  intervalS: number,
  now: number,
): number | undefined {
  if (intervalS <= 0) return undefined;
  const intervalMs = intervalS * 1000;
  const elapsed = Math.max(0, now - startedAt);
  return startedAt + (Math.floor(elapsed / intervalMs) + 1) * intervalMs;
}

/**
 * When the next clock-aligned sample is due: intervals of `intervalS` seconds
 * counted from midnight (UTC), or undefined when `intervalS` is 0.
 */
export function nextAlignedSample(intervalS: number, now: number): number | undefined {
  if (intervalS <= 0) return undefined;
  const intervalMs = intervalS * 1000;
  const midnight = Math.floor(now / 86_400_000) * 86_400_000;
  return midnight + (Math.floor((now - midnight) / intervalMs) + 1) * intervalMs;
}
