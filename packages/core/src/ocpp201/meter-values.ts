/**
 * MeterValues in OCPP 2.0.1's shape, from the same meter as 1.6: numeric
 * values and a unitOfMeasure instead of strings and a unit.
 */
import { meterAt, sampleMeter, type MeterState, type SampleExtras } from '../meter.js';
import { vehicleSampledValues, type VehicleReadings } from '../ocpp21/iso15118-20.js';
import type {
  MeterValueType,
  ReadingContextEnumType,
  SampledValueType,
} from '../ocpp21/messages.js';

/**
 * One MeterValue at `now` with the supported measurands of `measurands` (a
 * comma-separated MemberList), or undefined when none of them is supported.
 */
export function sampleMeter201(
  meter: MeterState,
  now: number,
  measurands: string,
  context: ReadingContextEnumType,
  extras: SampleExtras & {
    /** 2.1: an ISO 15118-20 EV's values for the Display.* and EnergyRequest.* measurands. */
    vehicle?: VehicleReadings;
  } = {},
): MeterValueType | undefined {
  const list = measurands
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m !== '');
  const sample = sampleMeter(meter, now, list, context, extras);
  const vehicle =
    extras.vehicle === undefined ? [] : vehicleSampledValues(extras.vehicle, list, context);
  const values = (sample?.sampledValue ?? []).map((v): SampledValueType => ({
    value: Number(v.value),
    ...(v.context !== undefined && { context: v.context }),
    // The meter only samples measurands both versions have.
    ...(v.measurand !== undefined && {
      measurand: v.measurand as SampledValueType['measurand'] & string,
    }),
    ...(v.phase !== undefined && { phase: v.phase }),
    ...(v.location !== undefined && { location: v.location }),
    ...(v.unit !== undefined && { unitOfMeasure: { unit: v.unit } }),
  }));
  const [first, ...rest] = [...values, ...vehicle];
  if (first === undefined) return undefined;
  return {
    timestamp: sample?.timestamp ?? new Date(now).toISOString(),
    sampledValue: [first, ...rest],
  };
}

/**
 * The station's simulated upstream meter (2.1, location Upstream): it sits on
 * the grid side and also counts the conversion and cable losses, a fixed
 * share of what the EVSEs deliver.
 */
export const UPSTREAM_LOSS = 0.02;

/**
 * One MeterValue of the upstream meter at `now` for the given outlet meters
 * (one EVSE's for sampled data, all of them for clock-aligned data): energy,
 * power and current with the losses on top, the same voltage; every value
 * with location Upstream. SoC has no upstream reading.
 */
export function sampleUpstream(
  meters: readonly MeterState[],
  now: number,
  measurands: string,
  context: ReadingContextEnumType,
): MeterValueType | undefined {
  const current = meters.map((m) => meterAt(m, now));
  const [first] = current;
  if (first === undefined) return undefined;
  const factor = 1 + UPSTREAM_LOSS;
  const upstream: MeterState = {
    ...first,
    energyWh: current.reduce((sum, m) => sum + m.energyWh, 0) * factor,
    powerW: current.reduce((sum, m) => sum + m.powerW, 0) * factor,
    offeredW: current.reduce((sum, m) => sum + m.offeredW, 0),
  };
  const sample = sampleMeter201(upstream, now, measurands, context);
  if (sample === undefined) return undefined;
  const [head, ...rest] = sample.sampledValue.map((v) => ({ ...v, location: 'Upstream' as const }));
  return head === undefined ? undefined : { ...sample, sampledValue: [head, ...rest] };
}
