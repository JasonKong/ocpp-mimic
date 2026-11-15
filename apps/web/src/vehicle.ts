/**
 * The vehicle card's rows (R-EV-1): for each item of section 6 of
 * docs/session-ui.md, what the station reported, what a third party can
 * estimate from it, what the simulator knows, and whether the version can
 * carry it at all.
 */
import type { ConnectorSnapshot, OcppVersion, SessionDetail } from './api.js';
import { formatEnergy, formatPower } from './format.js';
import { formatDuration } from './sessions.js';
import {
  VEHICLE_FIELD_LABELS,
  VEHICLE_FIELDS,
  versionInfo,
  type Availability,
  type VehicleField,
} from './versions.js';

export type ValueSource = 'reported' | 'estimate' | 'truth';

export interface VehicleValue {
  text: string;
  source: ValueSource;
  /** The frame the value came from, for reported values. */
  seq?: number;
}

export interface VehicleRow {
  field: VehicleField;
  label: string;
  availability: Availability;
  /** What the CSMS sees or can work out: reported values first, then estimates. */
  values: VehicleValue[];
  /** What the simulator knows; shown with show-truth. */
  truth?: VehicleValue;
  /** Why nothing is shown, when nothing is. */
  missing?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const DRAWING: Record<string, string> = {
  charging: 'charging',
  suspendedEV: 'paused by the EV (full or waiting)',
  suspendedEVSE: 'paused by the station',
  idle: 'not drawing',
};

/** The rows of the vehicle card for a session; `ev` is the plugged-in EV's snapshot, when it is still there. */
export function vehicleRows(
  detail: SessionDetail,
  version: OcppVersion,
  ev: ConnectorSnapshot['ev'] | undefined,
): VehicleRow[] {
  const { session, summary, estimate, truth } = detail;
  const needs = session.chargingNeeds;
  const dc = isObject(needs?.dcChargingParameters) ? needs.dcChargingParameters : undefined;
  const ac = isObject(needs?.acChargingParameters) ? needs.acChargingParameters : undefined;
  const latestSample = [...session.samples].reverse().find((s) => s.socPercent !== undefined);
  const lastTruth = session.truth.at(-1);
  const profile = ev?.profile;
  // Times to the target are simulated under an energy multiplier; shown in wall-clock time.
  const multiplier =
    detail.energyMultiplier !== undefined && detail.energyMultiplier > 0
      ? detail.energyMultiplier
      : 1;
  const wall = (ms: number) =>
    formatDuration(ms / multiplier) + (multiplier === 1 ? '' : ` (energy ×${multiplier})`);
  const reported = (text: string, seq?: number): VehicleValue => ({
    text,
    source: 'reported',
    ...(seq !== undefined && { seq }),
  });
  const estimated = (text: string): VehicleValue => ({ text, source: 'estimate' });
  const truthOf = (text: string | undefined): VehicleValue | undefined =>
    text === undefined ? undefined : { text, source: 'truth' };

  const values: Record<VehicleField, { values: VehicleValue[]; truth?: VehicleValue | undefined }> =
    {
      energy: {
        values: [reported(formatEnergy(summary.energyWh))],
        truth: truthOf(
          lastTruth === undefined
            ? undefined
            : formatEnergy(
                Math.max(
                  0,
                  lastTruth.energyWh - (session.meterStartWh ?? session.truth[0]?.energyWh ?? 0),
                ),
              ),
        ),
      },
      soc: {
        values: [
          ...(latestSample?.socPercent !== undefined
            ? [reported(`${latestSample.socPercent} %`, latestSample.seq)]
            : []),
          ...(num(dc?.stateOfCharge) !== undefined && latestSample === undefined
            ? [reported(`${String(dc?.stateOfCharge)} % at the start (ChargingNeeds)`)]
            : []),
        ],
        truth: truthOf(
          lastTruth === undefined ? undefined : `${lastTruth.socPercent.toFixed(1)} %`,
        ),
      },
      capacity: {
        values: [
          ...(num(dc?.evEnergyCapacity) !== undefined
            ? [reported(formatEnergy(num(dc?.evEnergyCapacity) ?? 0))]
            : []),
          ...(estimate.capacityFrom === 'readings' && estimate.capacityWh !== undefined
            ? [estimated(`${formatEnergy(estimate.capacityWh)} from the readings`)]
            : []),
        ],
        truth: truthOf(profile === undefined ? undefined : `${profile.capacityKWh} kWh`),
      },
      energyNeeded: {
        values: [
          ...(num(dc?.energyAmount ?? ac?.energyAmount) !== undefined
            ? [
                reported(
                  `${formatEnergy(num(dc?.energyAmount ?? ac?.energyAmount) ?? 0)} at the start`,
                ),
              ]
            : []),
          ...(estimate.energyLeftWh !== undefined
            ? [estimated(`${formatEnergy(estimate.energyLeftWh)} left`)]
            : []),
        ],
        truth: truthOf(
          profile === undefined || lastTruth === undefined
            ? undefined
            : `${formatEnergy(Math.max(0, (((profile.targetSoc ?? 100) - lastTruth.socPercent) / 100) * profile.capacityKWh * 1000))} left`,
        ),
      },
      targetSoc: {
        values:
          num(dc?.fullSoC) !== undefined
            ? [
                reported(
                  `full ${String(dc?.fullSoC)} %${num(dc?.bulkSoC) === undefined ? '' : `, fast charging to ${String(dc?.bulkSoC)} %`}`,
                ),
              ]
            : [estimated(`${estimate.targetSoc} % assumed`)],
        truth: truthOf(
          profile === undefined
            ? undefined
            : `${profile.targetSoc ?? 100} %, taper from ${profile.taperSoc ?? 80} %`,
        ),
      },
      timeToTarget: {
        values: estimate.msToTarget !== undefined ? [estimated(wall(estimate.msToTarget))] : [],
        truth: truthOf(truth?.msToTarget === undefined ? undefined : wall(truth.msToTarget)),
      },
      departure: {
        values:
          typeof needs?.departureTime === 'string'
            ? [reported(new Date(needs.departureTime).toISOString().slice(11, 16))]
            : [],
        truth: truthOf(
          profile?.departureMinutes === undefined
            ? undefined
            : `${profile.departureMinutes} min after plugging in`,
        ),
      },
      evLimits: {
        values:
          dc !== undefined
            ? [
                reported(
                  `${num(dc.evMaxPower) === undefined ? '' : `${formatPower(num(dc.evMaxPower) ?? 0)}, `}${String(dc.evMaxCurrent)} A, ${String(dc.evMaxVoltage)} V`,
                ),
              ]
            : ac !== undefined
              ? [
                  reported(
                    `${String(ac.evMinCurrent)}–${String(ac.evMaxCurrent)} A, ${String(ac.evMaxVoltage)} V`,
                  ),
                ]
              : [],
        truth: truthOf(profile === undefined ? undefined : `${formatPower(profile.maxPowerW)}`),
      },
      drawing: {
        values:
          session.states.at(-1) === undefined
            ? []
            : [
                reported(
                  DRAWING[session.states.at(-1)?.state ?? 'idle'] ?? 'unknown',
                  session.states.at(-1)?.seq,
                ),
              ],
        truth: truthOf(
          lastTruth === undefined ? undefined : lastTruth.powerW > 0 ? 'drawing' : 'not drawing',
        ),
      },
      phases: {
        values: (() => {
          const phaseSample = [...session.samples].reverse().find((s) => s.currentA !== undefined);
          const used = Object.values(phaseSample?.currentA ?? {}).filter(
            (a) => (a ?? 0) > 0.5,
          ).length;
          return phaseSample === undefined
            ? []
            : [estimated(`${used} from the per-phase currents`)];
        })(),
        truth: truthOf(profile === undefined ? undefined : String(profile.phases)),
      },
      preconditioning: { values: [] },
      identity: {
        values:
          session.idToken?.type === 'MacAddress' || session.idToken?.type === 'eMAID'
            ? [reported(`${session.idToken.type} ${session.idToken.idToken}`)]
            : [],
      },
    };

  const info = versionInfo(version);
  return VEHICLE_FIELDS.map((field) => {
    const availability = info.vehicle[field];
    const row = values[field];
    const out: VehicleRow = {
      field,
      label: VEHICLE_FIELD_LABELS[field],
      availability,
      values: row.values,
      ...(row.truth !== undefined && { truth: row.truth }),
    };
    if (row.values.length === 0) {
      out.missing =
        availability.level === 'no' ? availability.note : 'not reported by this station or EV';
    }
    return out;
  });
}
