/**
 * What each OCPP version calls things and can carry, as data: the views ask
 * this table instead of checking versions themselves, so a new version (2.1)
 * is a new row. The vehicle fields follow section 6 of docs/session-ui.md.
 */
import type { OcppVersion } from './api.js';

/** Whether a version can carry a field: always, only in some setups, or never. */
export type Availability = { level: 'yes' | 'conditional' | 'no'; note: string };

export const VEHICLE_FIELDS = [
  'energy',
  'soc',
  'capacity',
  'energyNeeded',
  'targetSoc',
  'timeToTarget',
  'departure',
  'evLimits',
  'drawing',
  'phases',
  'preconditioning',
  'identity',
] as const;
export type VehicleField = (typeof VEHICLE_FIELDS)[number];

export const VEHICLE_FIELD_LABELS: Record<VehicleField, string> = {
  energy: 'Energy, power, current, voltage',
  soc: 'State of charge',
  capacity: 'Battery capacity',
  energyNeeded: 'Energy still needed',
  targetSoc: 'Target / full SoC',
  timeToTarget: 'Time left to charge',
  departure: 'Departure time',
  evLimits: 'EV maximum power, current, voltage',
  drawing: 'Whether the EV draws power',
  phases: 'Phases in use',
  preconditioning: 'Battery preconditioning',
  identity: 'Vehicle identity',
};

export interface VersionInfo {
  version: OcppVersion;
  label: string;
  /** CSS class of the version's badge colour. */
  tone: string;
  terms: {
    /** What a charging point is called. */
    evse: 'Connector' | 'EVSE';
    token: 'idTag' | 'idToken';
    transactionId: 'number' | 'string';
  };
  /** Tokens have a type (ISO14443, Central, ...). */
  tokenType: boolean;
  remoteStartId: boolean;
  totalCost: boolean;
  /** The station prices sessions itself from tariffs the CSMS sends. */
  tariffs: boolean;
  vehicle: Record<VehicleField, Availability>;
  /** Connector statuses or charging states that count as charging (the EV is plugged in a transaction). */
  charging: { statuses: readonly string[]; chargingStates: readonly string[] };
}

const yes = (note: string): Availability => ({ level: 'yes', note });
const some = (note: string): Availability => ({ level: 'conditional', note });
const no = (note = 'not in this version'): Availability => ({ level: 'no', note });

export const VERSIONS: Record<OcppVersion, VersionInfo> = {
  '1.6': {
    version: '1.6',
    label: 'OCPP 1.6',
    tone: 'v16',
    terms: { evse: 'Connector', token: 'idTag', transactionId: 'number' },
    tokenType: false,
    remoteStartId: false,
    totalCost: false,
    tariffs: false,
    vehicle: {
      energy: yes('MeterValues'),
      soc: some('SoC measurand, only when the station knows it: common for DC, rare for AC'),
      capacity: no(),
      energyNeeded: no(),
      targetSoc: no(),
      timeToTarget: no(),
      departure: no(),
      evLimits: no('not in this version; only the actual current'),
      drawing: yes('status SuspendedEV'),
      phases: some('no field; only the per-phase currents'),
      preconditioning: no(),
      identity: some('no standard field; Autocharge uses the EV MAC as idTag'),
    },
    charging: { statuses: ['Charging', 'SuspendedEV', 'SuspendedEVSE'], chargingStates: [] },
  },
  '2.0.1': {
    version: '2.0.1',
    label: 'OCPP 2.0.1',
    tone: 'v201',
    terms: { evse: 'EVSE', token: 'idToken', transactionId: 'string' },
    tokenType: true,
    remoteStartId: true,
    totalCost: true,
    tariffs: false,
    vehicle: {
      energy: yes('TransactionEvent / MeterValues'),
      soc: some('SoC measurand when the station knows it; DC ChargingNeeds stateOfCharge'),
      capacity: some('ISO 15118 DC only: evEnergyCapacity'),
      energyNeeded: some('ISO 15118: energyAmount'),
      targetSoc: some('ISO 15118 DC: fullSoC, bulkSoC'),
      timeToTarget: no(),
      departure: some('ISO 15118: departureTime'),
      evLimits: some('ISO 15118: evMaxCurrent, evMaxVoltage, evMaxPower'),
      drawing: yes('chargingState SuspendedEV'),
      phases: yes('TransactionEvent numberOfPhasesUsed'),
      preconditioning: no(),
      identity: some('idToken type MacAddress (Autocharge) or eMAID (Plug & Charge)'),
    },
    charging: { statuses: [], chargingStates: ['Charging', 'SuspendedEV', 'SuspendedEVSE'] },
  },
  '2.1': {
    version: '2.1',
    label: 'OCPP 2.1',
    tone: 'v21',
    terms: { evse: 'EVSE', token: 'idToken', transactionId: 'string' },
    tokenType: true,
    remoteStartId: true,
    totalCost: true,
    tariffs: true,
    vehicle: {
      energy: yes('TransactionEvent / MeterValues'),
      soc: some('as 2.0.1, plus Display.PresentSOC from ISO 15118-20 EVs'),
      capacity: some('ISO 15118: evEnergyCapacity; ISO 15118-20: Display.BatteryEnergyCapacity'),
      energyNeeded: some('ISO 15118: energyAmount; ISO 15118-20: EnergyRequest.*'),
      targetSoc: some('ISO 15118: fullSoC, bulkSoC; ISO 15118-20: Display.TargetSOC, targetSoC'),
      timeToTarget: some('ISO 15118-20: Display.RemainingTimeToTargetSOC'),
      departure: some('ISO 15118: departureTime'),
      evLimits: some('ISO 15118: the EV limits; ISO 15118-20: v2xChargingParameters'),
      drawing: yes('chargingState SuspendedEV; Display.ChargingComplete'),
      phases: yes('TransactionEvent numberOfPhasesUsed'),
      preconditioning: some('TransactionEvent preconditioningStatus'),
      identity: some('idToken type MacAddress, eMAID, VIN or EVCCID'),
    },
    charging: { statuses: [], chargingStates: ['Charging', 'SuspendedEV', 'SuspendedEVSE'] },
  },
};

export const versionInfo = (version: OcppVersion): VersionInfo => VERSIONS[version];

/** Whether a connector counts as charging: in a transaction with the EV plugged in. */
export function isCharging(
  version: OcppVersion,
  connector: { status: string; chargingState?: string },
): boolean {
  const { statuses, chargingStates } = versionInfo(version).charging;
  return (
    statuses.includes(connector.status) ||
    (connector.chargingState !== undefined && chargingStates.includes(connector.chargingState))
  );
}

/** How a view shows a field the version cannot carry. */
export function unavailable(version: OcppVersion, field: VehicleField): string | undefined {
  const availability = versionInfo(version).vehicle[field];
  return availability.level === 'no' ? `${availability.note}` : undefined;
}

/** What a charging point of this version is called: `Connector 2`, or `EVSE 2 · connector 1`. */
export function evseLabel(version: OcppVersion, evseId: number, connectorId = 1): string {
  return versionInfo(version).terms.evse === 'EVSE'
    ? `EVSE ${evseId} · connector ${connectorId}`
    : `Connector ${evseId}`;
}
