/**
 * What an ISO 15118-20 EV tells a 2.1 station, charging only: its charging
 * needs in -20's terms (K18, K19, K20), and the values the station reports
 * as the Display.* and EnergyRequest.* measurands (R-EV-4). The values come
 * from the EV model; the ISO 15118 link itself is not simulated.
 */
import { msUntilSoc, type EvProfile, type EvState } from '../ev.js';
import { DC_CONNECTOR_TYPES } from '../ocpp201/charging-needs.js';
import type { ChargingNeedsType, SampledValueType } from './messages.js';

/** DC charging runs at about this voltage; AC at 230 V per phase. */
const DC_VOLTAGE = 400;
const AC_VOLTAGE = 230;
/** The smallest current an AC EV charges with (IEC 61851), and a DC EV's smallest power. */
const AC_MIN_CURRENT = 6;
const DC_MIN_POWER_W = 1000;

export interface ChargingNeeds21Input {
  profile: EvProfile;
  /** SoC now, in percent. */
  soc: number;
  /** The EVSE's connector type (Device Model Connector.ConnectorType). */
  connectorType?: string;
  /** When the EV was plugged in (ms since the epoch), for the departure time. */
  pluggedAt: number;
}

const targetOf = (profile: EvProfile) => profile.targetSoc ?? 100;
/** Energy from `soc` to `goal` percent of the battery, in Wh; negative when above it. */
const energyTo = (profile: EvProfile, soc: number, goal: number) =>
  Math.round(((goal - soc) / 100) * profile.capacityKWh * 1000);

/**
 * The chargingNeeds of an ISO 15118-20 EV (K18.FR.06): v2xChargingParameters
 * instead of the AC or DC block, the control mode and who decides the
 * mobility needs (the EV), and only charging transfers.
 */
export function chargingNeeds21(
  input: ChargingNeeds21Input,
): Omit<ChargingNeedsType, 'customData'> {
  const { profile, soc } = input;
  const dc = DC_CONNECTOR_TYPES.includes(input.connectorType ?? '');
  const mode = dc ? 'DC' : profile.phases === 3 ? 'AC_three_phase' : 'AC_single_phase';
  const target = targetOf(profile);
  return {
    requestedEnergyTransfer: mode,
    availableEnergyTransfer: [mode],
    controlMode: profile.controlMode ?? 'ScheduledControl',
    mobilityNeedsMode: 'EVCC',
    ...(profile.departureMinutes !== undefined && {
      departureTime: new Date(input.pluggedAt + profile.departureMinutes * 60_000).toISOString(),
    }),
    v2xChargingParameters: {
      minChargePower: dc ? DC_MIN_POWER_W : AC_MIN_CURRENT * AC_VOLTAGE * profile.phases,
      maxChargePower: Math.round(profile.maxPowerW),
      ...(dc && {
        maxChargeCurrent: Math.ceil(profile.maxPowerW / DC_VOLTAGE),
        maxVoltage: DC_VOLTAGE,
      }),
      evTargetEnergyRequest: energyTo(profile, soc, target),
      // The EV stops at its target, so that is also its maximum.
      evMaxEnergyRequest: energyTo(profile, soc, target),
      ...(profile.minimumSoc !== undefined && {
        evMinEnergyRequest: energyTo(profile, soc, profile.minimumSoc),
      }),
      targetSoC: Math.round(target),
    },
  };
}

/** The 2.1 measurands an ISO 15118-20 EV's values are reported as. */
export const VEHICLE_MEASURANDS = [
  'Display.PresentSOC',
  'Display.MinimumSOC',
  'Display.TargetSOC',
  'Display.MaximumSOC',
  'Display.RemainingTimeToMinimumSOC',
  'Display.RemainingTimeToTargetSOC',
  'Display.RemainingTimeToMaximumSOC',
  'Display.ChargingComplete',
  'Display.BatteryEnergyCapacity',
  'EnergyRequest.Target',
  'EnergyRequest.Minimum',
  'EnergyRequest.Maximum',
  'EnergyRequest.Bulk',
] as const;
export type VehicleMeasurand = (typeof VEHICLE_MEASURANDS)[number];

/** The EV's values for those measurands now; absent when the EV has none. */
export type VehicleReadings = Partial<Record<VehicleMeasurand, number>>;

/**
 * What an ISO 15118-20 EV reports now, with the station offering
 * `offeredW`: SoCs, the time to each (seconds; none while nothing is offered),
 * whether it is done, its capacity, and the energy to each SoC (Wh).
 */
export function vehicleReadings(ev: EvState, offeredW: number): VehicleReadings {
  const { profile, soc } = ev;
  const target = targetOf(profile);
  const seconds = (goal: number) => {
    const ms = msUntilSoc(ev, offeredW, goal);
    return ms === undefined ? undefined : Math.ceil(ms / 1000);
  };
  const readings: VehicleReadings = {
    'Display.PresentSOC': Math.floor(soc),
    'Display.TargetSOC': Math.round(target),
    'Display.MaximumSOC': Math.round(target),
    'Display.ChargingComplete': soc >= target ? 1 : 0,
    'Display.BatteryEnergyCapacity': Math.round(profile.capacityKWh * 1000),
    'EnergyRequest.Target': energyTo(profile, soc, target),
    'EnergyRequest.Maximum': energyTo(profile, soc, target),
    'EnergyRequest.Bulk': Math.max(0, energyTo(profile, soc, profile.taperSoc ?? 80)),
  };
  const toTarget = seconds(target);
  if (toTarget !== undefined) {
    readings['Display.RemainingTimeToTargetSOC'] = toTarget;
    readings['Display.RemainingTimeToMaximumSOC'] = toTarget;
  }
  if (profile.minimumSoc !== undefined) {
    readings['Display.MinimumSOC'] = Math.round(profile.minimumSoc);
    readings['EnergyRequest.Minimum'] = energyTo(profile, soc, profile.minimumSoc);
    const toMinimum = seconds(profile.minimumSoc);
    if (toMinimum !== undefined) readings['Display.RemainingTimeToMinimumSOC'] = toMinimum;
  }
  return readings;
}

const UNIT: Record<VehicleMeasurand, string | undefined> = {
  'Display.PresentSOC': 'Percent',
  'Display.MinimumSOC': 'Percent',
  'Display.TargetSOC': 'Percent',
  'Display.MaximumSOC': 'Percent',
  'Display.RemainingTimeToMinimumSOC': 's',
  'Display.RemainingTimeToTargetSOC': 's',
  'Display.RemainingTimeToMaximumSOC': 's',
  'Display.ChargingComplete': undefined,
  'Display.BatteryEnergyCapacity': 'Wh',
  'EnergyRequest.Target': 'Wh',
  'EnergyRequest.Minimum': 'Wh',
  'EnergyRequest.Maximum': 'Wh',
  'EnergyRequest.Bulk': 'Wh',
};

const isVehicleMeasurand = (value: string): value is VehicleMeasurand =>
  (VEHICLE_MEASURANDS as readonly string[]).includes(value);

/** Sampled values for the vehicle measurands among `measurands`, in their order. */
export function vehicleSampledValues(
  readings: VehicleReadings,
  measurands: readonly string[],
  context: SampledValueType['context'],
): SampledValueType[] {
  return measurands.filter(isVehicleMeasurand).flatMap((measurand) => {
    const value = readings[measurand];
    if (value === undefined) return [];
    const unit = UNIT[measurand];
    return [
      {
        value,
        measurand,
        location: 'EV' as const,
        ...(context !== undefined && { context }),
        ...(unit !== undefined && { unitOfMeasure: { unit } }),
      },
    ];
  });
}
