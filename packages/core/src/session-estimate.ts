/**
 * What a third party can work out about a charging session from the values
 * the station reported over OCPP, next to the simulator's ground truth.
 *
 * The estimate knows only the reported samples (and NotifyEVChargingNeeds,
 * when the EV speaks ISO 15118). It assumes the usual charging curve: the
 * power the EV takes until the taper point (bulkSoC, else 80 %), then a
 * linear fall to a tenth of it at the target (fullSoC, else 100 %). The truth
 * comes from the EV model, which `msUntilFull` solves exactly. Both give an
 * ETA, a moment, so they compare whenever each was computed.
 */
import { TAPER_FLOOR } from './ev.js';
import type { VehicleMeasurand } from './ocpp21/iso15118-20.js';
import type { ReportedSample, SessionRecord } from './session.js';

/** SoC must rise this many points before the capacity is worked out from readings. */
export const MIN_SOC_RISE = 5;
/** The window the current power is averaged over. */
export const POWER_WINDOW_MS = 5 * 60_000;
/** An estimate is off when its ETA misses the truth by more than this or by more than 10 %. */
export const GAP_MS = 5 * 60_000;
export const GAP_SHARE = 0.1;

export type EstimateReason =
  'no SoC reported' | 'SoC has not risen enough' | 'no power' | 'target reached';

export interface SessionEstimate {
  /** The latest reported SoC and when it was reported. */
  socPercent?: number;
  at?: string;
  /** The SoC now, worked out from the energy since the reported SoC last went up. */
  refinedSocPercent?: number;
  capacityWh?: number;
  /** ISO 15118 charging needs, an ISO 15118-20 EV's Display.BatteryEnergyCapacity, or the readings. */
  capacityFrom?: 'chargingNeeds' | 'display' | 'readings';
  targetSoc: number;
  targetFrom: 'chargingNeeds' | 'display' | 'default';
  taperSoc: number;
  /** The power the estimate charges with: the latest reported, else the average of the last 5 minutes. */
  powerW?: number;
  energyLeftWh?: number;
  msToTarget?: number;
  /** When the target will be reached. */
  etaAt?: string;
  /** The EV's own Display.RemainingTimeToTargetSOC (ISO 15118-20), or worked out here. */
  etaFrom?: 'display' | 'estimate';
  departureTime?: string;
  reachesTargetBeforeDeparture?: boolean;
  /** Why something could not be estimated. */
  reason?: EstimateReason;
}

export interface SessionTruth {
  at: string;
  socPercent: number;
  /** Until the EV's own target under the offered power at `at`; absent when it never gets there. */
  msToTarget?: number;
  etaAt?: string;
}

export interface EstimateGap {
  gapMs: number;
  /** The estimate misses by more than 5 minutes or 10 % of the time left. */
  off: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const iso = (ms: number) => new Date(ms).toISOString();

/** The DC charging parameters an ISO 15118 EV sent, when it did. */
function dcParameters(record: SessionRecord): Record<string, unknown> | undefined {
  const dc = record.chargingNeeds?.dcChargingParameters;
  return isObject(dc) ? dc : undefined;
}

/**
 * Battery capacity from readings: a line through (energy, SoC) at the
 * samples where the integer SoC just went up, so the rounding of every point
 * is about the same and cancels out in the slope.
 */
export function capacityFromReadings(samples: readonly ReportedSample[]): number | undefined {
  const points: { e: number; soc: number }[] = [];
  let previous: number | undefined;
  for (const sample of samples) {
    if (sample.socPercent === undefined || sample.energyWh === undefined) continue;
    if (previous !== undefined && sample.socPercent > previous) {
      points.push({ e: sample.energyWh, soc: sample.socPercent });
    }
    previous = sample.socPercent;
  }
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined || last.soc - first.soc < MIN_SOC_RISE) {
    return undefined;
  }
  const meanSoc = points.reduce((sum, p) => sum + p.soc, 0) / points.length;
  const meanE = points.reduce((sum, p) => sum + p.e, 0) / points.length;
  let num_ = 0;
  let den = 0;
  for (const p of points) {
    num_ += (p.soc - meanSoc) * (p.e - meanE);
    den += (p.soc - meanSoc) ** 2;
  }
  if (den === 0) return undefined;
  const whPerPercent = num_ / den;
  return whPerPercent > 0 ? whPerPercent * 100 : undefined;
}

/**
 * The power now: the latest sample's reported power (a falling taper makes
 * any average lag), else the average over the 5 minutes before the latest
 * energy reading, else the latest power reported at all.
 */
export function recentPowerW(samples: readonly ReportedSample[]): number | undefined {
  const latest = samples.at(-1);
  if (latest?.powerW !== undefined) return latest.powerW;
  const withEnergy = samples.filter((s) => s.energyWh !== undefined && s.at !== '');
  const last = withEnergy.at(-1);
  if (last !== undefined) {
    const lastAt = Date.parse(last.at);
    const first = withEnergy.find((s) => Date.parse(s.at) >= lastAt - POWER_WINDOW_MS);
    if (first !== undefined && first !== last) {
      const hours = (lastAt - Date.parse(first.at)) / 3_600_000;
      if (hours > 0) return ((last.energyWh ?? 0) - (first.energyWh ?? 0)) / hours;
    }
  }
  return [...samples].reverse().find((s) => s.powerW !== undefined)?.powerW;
}

/**
 * The SoC now with its fraction: a meter reports SoC rounded down, so just
 * after it goes up the fraction is about 0, and the energy delivered since
 * adds the rest. Stays below the next integer.
 */
export function refinedSoc(
  samples: readonly ReportedSample[],
  capacityWh: number,
): number | undefined {
  const withSoc = samples.filter((s) => s.socPercent !== undefined && s.energyWh !== undefined);
  const last = withSoc.at(-1);
  if (last?.socPercent === undefined || last.energyWh === undefined) return undefined;
  let step: ReportedSample | undefined;
  for (let i = withSoc.length - 1; i > 0; i--) {
    if ((withSoc[i]?.socPercent ?? 0) > (withSoc[i - 1]?.socPercent ?? 0)) {
      step = withSoc[i];
      break;
    }
  }
  if (step?.socPercent === undefined || step.energyWh === undefined) return last.socPercent;
  const since = ((last.energyWh - step.energyWh) / capacityWh) * 100;
  return Math.min(step.socPercent + since, last.socPercent + 0.99);
}

/**
 * Hours to charge from `soc` to `target` percent of `capacityWh`, drawing
 * `powerW` now, on the usual curve: full power until `taper`, then a linear
 * fall to a tenth of the power at the taper point by the target.
 */
export function hoursToTarget(
  capacityWh: number,
  soc: number,
  powerW: number,
  taper: number,
  target: number,
): number {
  if (soc >= target) return 0;
  const whPerPercent = capacityWh / 100;
  if (target <= taper) return ((target - soc) * whPerPercent) / powerW;
  let hours = 0;
  let from = soc;
  // The power at the taper point: the current power, or worked back from it when already past.
  let atTaper = powerW;
  if (soc < taper) {
    hours += ((taper - soc) * whPerPercent) / powerW;
    from = taper;
  } else {
    atTaper = powerW / (1 - ((1 - TAPER_FLOOR) * (soc - taper)) / (target - taper));
  }
  const slope = (atTaper * (1 - TAPER_FLOOR)) / (target - taper);
  const powerAt = (s: number) => atTaper - slope * (s - taper);
  // dSoC/dt = P(SoC) / whPerPercent with P falling linearly: P decays exponentially in time.
  hours += (whPerPercent / slope) * Math.log(powerAt(from) / powerAt(target));
  return hours;
}

/** The latest value an ISO 15118-20 EV reported for a measurand, with its sample. */
function reported(
  record: SessionRecord,
  measurand: VehicleMeasurand,
): { value: number; at: string } | undefined {
  const sample = [...record.samples].reverse().find((s) => s.vehicle?.[measurand] !== undefined);
  const value = sample?.vehicle?.[measurand];
  return sample === undefined || value === undefined ? undefined : { value, at: sample.at };
}

/** The third party's view: capacity, target and ETA from the reported values only. */
export function estimateSession(record: SessionRecord): SessionEstimate {
  const dc = dcParameters(record);
  const v2x = record.chargingNeeds?.v2xChargingParameters;
  const fullSoc = num(dc?.fullSoC);
  const bulkSoc = num(dc?.bulkSoC);
  const displayTarget = reported(record, 'Display.TargetSOC')?.value;
  const needsTarget = fullSoc ?? (isObject(v2x) ? num(v2x.targetSoC) : undefined);
  const targetSoc = displayTarget ?? needsTarget ?? 100;
  const taperSoc = bulkSoc !== undefined && bulkSoc < targetSoc ? bulkSoc : Math.min(80, targetSoc);
  const departure = record.chargingNeeds?.departureTime;
  const estimate: SessionEstimate = {
    targetSoc,
    targetFrom:
      displayTarget !== undefined
        ? 'display'
        : needsTarget === undefined
          ? 'default'
          : 'chargingNeeds',
    taperSoc,
    ...(typeof departure === 'string' && { departureTime: departure }),
  };
  const latest = [...record.samples].reverse().find((s) => s.socPercent !== undefined);
  if (latest?.socPercent === undefined) return { ...estimate, reason: 'no SoC reported' };
  estimate.socPercent = latest.socPercent;
  estimate.at = latest.at;

  const fromNeeds = num(dc?.evEnergyCapacity);
  const fromDisplay = reported(record, 'Display.BatteryEnergyCapacity')?.value;
  const capacityWh = fromNeeds ?? fromDisplay ?? capacityFromReadings(record.samples);
  if (capacityWh !== undefined) {
    estimate.capacityWh = capacityWh;
    estimate.capacityFrom =
      fromNeeds !== undefined
        ? 'chargingNeeds'
        : fromDisplay !== undefined
          ? 'display'
          : 'readings';
  }
  if (latest.socPercent >= targetSoc) {
    return {
      ...estimate,
      energyLeftWh: 0,
      msToTarget: 0,
      etaAt: latest.at,
      reason: 'target reached',
    };
  }
  if (capacityWh === undefined) return { ...estimate, reason: 'SoC has not risen enough' };
  const soc = refinedSoc(record.samples, capacityWh) ?? latest.socPercent;
  estimate.refinedSocPercent = soc;
  estimate.energyLeftWh = (Math.max(0, targetSoc - soc) / 100) * capacityWh;

  const powerW = recentPowerW(record.samples);
  if (powerW !== undefined && powerW > 0) estimate.powerW = powerW;
  // An ISO 15118-20 EV says how long it still needs, from when it said it.
  const remaining = reported(record, 'Display.RemainingTimeToTargetSOC');
  if (remaining !== undefined && Date.parse(remaining.at) >= Date.parse(latest.at)) {
    estimate.msToTarget = remaining.value * 1000;
    estimate.etaAt = iso(Date.parse(remaining.at) + estimate.msToTarget);
    estimate.etaFrom = 'display';
  } else {
    if (powerW === undefined || powerW <= 0) return { ...estimate, reason: 'no power' };
    const ms = Math.round(hoursToTarget(capacityWh, soc, powerW, taperSoc, targetSoc) * 3_600_000);
    estimate.msToTarget = ms;
    estimate.etaAt = iso(Date.parse(latest.at) + ms);
    estimate.etaFrom = 'estimate';
  }
  if (estimate.departureTime !== undefined) {
    estimate.reachesTargetBeforeDeparture =
      Date.parse(estimate.etaAt) <= Date.parse(estimate.departureTime);
  }
  return estimate;
}

/** The simulator's view: the latest true sample and its ETA. */
export function sessionTruth(record: SessionRecord): SessionTruth | undefined {
  const latest = record.truth.at(-1);
  if (latest === undefined) return undefined;
  return {
    at: latest.at,
    socPercent: latest.socPercent,
    ...(latest.msUntilFull !== undefined && {
      msToTarget: latest.msUntilFull,
      etaAt: iso(Date.parse(latest.at) + latest.msUntilFull),
    }),
  };
}

/**
 * How far the estimated ETA is from the true one, and whether that is off:
 * more than 5 minutes and more than 10 % of the time the truth still needs.
 */
export function estimateGap(
  estimate: SessionEstimate,
  truth: SessionTruth | undefined,
): EstimateGap | undefined {
  if (estimate.etaAt === undefined || truth?.etaAt === undefined) return undefined;
  const gapMs = Math.abs(Date.parse(estimate.etaAt) - Date.parse(truth.etaAt));
  const left = Math.max(0, Date.parse(truth.etaAt) - Date.parse(estimate.at ?? truth.at));
  return { gapMs, off: gapMs > Math.max(GAP_MS, GAP_SHARE * left) };
}
