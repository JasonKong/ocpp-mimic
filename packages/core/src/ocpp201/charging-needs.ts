/**
 * What an ISO 15118 EV tells the station about its charging needs, as the
 * station reports it in NotifyEVChargingNeeds (2.0.1). The values come from
 * the EV model: capacity, SoC, target and taper, maximum power and phases.
 * The ISO 15118 link itself is not simulated.
 */
import type { EvProfile } from '../ev.js';
import type { ChargingNeedsType } from './messages.js';

/** Connector types that deliver DC; any other takes AC parameters. */
export const DC_CONNECTOR_TYPES = ['cCCS1', 'cCCS2', 'cG105', 'cChaoJi'];

/** DC charging runs at about this voltage; AC at 230 V per phase (400 V between phases). */
const DC_VOLTAGE = 400;
const AC_VOLTAGE = 230;
/** The smallest current an AC EV charges with (IEC 61851). */
const AC_MIN_CURRENT = 6;

export interface ChargingNeedsInput {
  profile: EvProfile;
  /** SoC now, in percent. */
  soc: number;
  /** The EVSE's connector type (Device Model Connector.ConnectorType). */
  connectorType?: string;
  /** When the EV was plugged in (ms since the epoch), for the departure time. */
  pluggedAt: number;
  /**
   * The station's energy multiplier (default 1). `departureMinutes` counts simulated minutes, as
   * the EV model does, so the departure on the wire is that many minutes divided by it.
   */
  energyMultiplier?: number;
}

/** The wall-clock departure of an EV that leaves after `departureMinutes` simulated minutes. */
export function departureAt(
  pluggedAt: number,
  departureMinutes: number,
  energyMultiplier = 1,
): string {
  return new Date(pluggedAt + (departureMinutes * 60_000) / energyMultiplier).toISOString();
}

/** The chargingNeeds of NotifyEVChargingNeeds for an ISO 15118 EV. */
export function chargingNeeds(input: ChargingNeedsInput): Omit<ChargingNeedsType, 'customData'> {
  const { profile, soc } = input;
  const target = profile.targetSoc ?? 100;
  const capacityWh = Math.round(profile.capacityKWh * 1000);
  const energyAmount = Math.max(0, Math.round(((target - soc) / 100) * capacityWh));
  const departure =
    profile.departureMinutes === undefined
      ? {}
      : {
          departureTime: departureAt(
            input.pluggedAt,
            profile.departureMinutes,
            input.energyMultiplier,
          ),
        };
  if (DC_CONNECTOR_TYPES.includes(input.connectorType ?? '')) {
    return {
      requestedEnergyTransfer: 'DC',
      ...departure,
      dcChargingParameters: {
        evMaxCurrent: Math.ceil(profile.maxPowerW / DC_VOLTAGE),
        evMaxVoltage: DC_VOLTAGE,
        energyAmount,
        evMaxPower: Math.round(profile.maxPowerW),
        stateOfCharge: Math.max(0, Math.min(100, Math.floor(soc))),
        evEnergyCapacity: capacityWh,
        fullSoC: Math.round(target),
        bulkSoC: Math.round(profile.taperSoc ?? 80),
      },
    };
  }
  return {
    requestedEnergyTransfer: profile.phases === 3 ? 'AC_three_phase' : 'AC_single_phase',
    ...departure,
    acChargingParameters: {
      energyAmount,
      evMinCurrent: AC_MIN_CURRENT,
      evMaxCurrent: Math.ceil(profile.maxPowerW / (AC_VOLTAGE * profile.phases)),
      evMaxVoltage: profile.phases === 3 ? 400 : AC_VOLTAGE,
    },
  };
}
