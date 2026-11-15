/**
 * The standard components and variables a 2.0.1 station of ocpp-mimic
 * implements, with the data types of the Part 2 appendix (v1.4) and
 * spec-default values. Controllers for a certification profile appear only
 * when the persona supports the profile; later M5 tasks add theirs.
 */
import { SUPPORTED_MEASURANDS } from '../meter.js';
import type { AttributeDefinition, VariableDataType, VariableDefinition } from './device-model.js';
import type { ComponentType } from './messages.js';

export interface StandardVariablesInput {
  /** EVSEs, each with one connector. */
  connectors: number;
  /** Certification profiles the persona supports. */
  features: readonly string[];
  /** Power each EVSE offers, in W. */
  offeredW: number;
  /** The connector type every connector reports. Default cType2. */
  connectorType?: string;
}

const rw = (value?: string): AttributeDefinition => ({
  mutability: 'ReadWrite',
  persistent: true,
  constant: false,
  ...(value !== undefined && { value }),
});
const ro = (value?: string, constant = false): AttributeDefinition => ({
  mutability: 'ReadOnly',
  persistent: true,
  constant,
  ...(value !== undefined && { value }),
});
const wo = (): AttributeDefinition => ({
  mutability: 'WriteOnly',
  persistent: true,
  constant: false,
});

type Extra = Omit<
  Partial<VariableDefinition>,
  'component' | 'variable' | 'dataType' | 'attributes'
>;

function variable(
  component: ComponentType,
  name: string,
  dataType: VariableDataType,
  actual: AttributeDefinition,
  extra: Extra & { instance?: string } = {},
): VariableDefinition {
  const { instance, ...rest } = extra;
  return {
    component,
    variable: { name, ...(instance !== undefined && { instance }) },
    dataType,
    attributes: { Actual: actual },
    ...rest,
  };
}

const MEASURANDS = SUPPORTED_MEASURANDS.join(',');
/** Entries the Local Authorization List holds at most (LocalAuthListCtrlr.Entries maxLimit). */
export const LOCAL_LIST_SIZE = 100;
const TX_POINTS = 'EVConnected,Authorized,PowerPathClosed,EnergyTransfer';
const AVAILABILITY = 'Available,Occupied,Reserved,Unavailable,Faulted';

export function standardVariables(input: StandardVariablesInput): VariableDefinition[] {
  const station: ComponentType = { name: 'ChargingStation' };
  const comm: ComponentType = { name: 'OCPPCommCtrlr' };
  const tx: ComponentType = { name: 'TxCtrlr' };
  const auth: ComponentType = { name: 'AuthCtrlr' };
  const cache: ComponentType = { name: 'AuthCacheCtrlr' };
  const sampled: ComponentType = { name: 'SampledDataCtrlr' };
  const aligned: ComponentType = { name: 'AlignedDataCtrlr' };
  const device: ComponentType = { name: 'DeviceDataCtrlr' };
  const clock: ComponentType = { name: 'ClockCtrlr' };
  const security: ComponentType = { name: 'SecurityCtrlr' };
  const dynamic = { dynamic: true };

  const out: VariableDefinition[] = [
    variable(station, 'AvailabilityState', 'OptionList', ro(), {
      valuesList: AVAILABILITY,
      ...dynamic,
    }),
    variable(station, 'Available', 'boolean', ro('true')),
    variable(station, 'Problem', 'boolean', ro(), dynamic),
    variable(station, 'SupplyPhases', 'integer', ro('3')),

    variable(comm, 'HeartbeatInterval', 'integer', rw('300'), { unit: 's', minLimit: 0 }),
    variable(comm, 'MessageTimeout', 'integer', ro('30'), { instance: 'Default', unit: 's' }),
    variable(comm, 'MessageAttempts', 'integer', rw('3'), {
      instance: 'TransactionEvent',
      minLimit: 0,
    }),
    variable(comm, 'MessageAttemptInterval', 'integer', rw('60'), {
      instance: 'TransactionEvent',
      unit: 's',
      minLimit: 0,
    }),
    variable(comm, 'OfflineThreshold', 'integer', rw('60'), { unit: 's', minLimit: 0 }),
    variable(comm, 'QueueAllMessages', 'boolean', rw('false')),
    variable(comm, 'ResetRetries', 'integer', rw('2'), { minLimit: 0 }),
    variable(comm, 'UnlockOnEVSideDisconnect', 'boolean', rw('true')),
    variable(comm, 'WebSocketPingInterval', 'integer', rw('30'), { unit: 's', minLimit: 0 }),
    variable(comm, 'FileTransferProtocols', 'MemberList', ro('HTTP,HTTPS'), {
      valuesList: 'FTP,FTPS,HTTP,HTTPS,SFTP',
    }),

    variable(tx, 'EVConnectionTimeOut', 'integer', rw('60'), { unit: 's', minLimit: 0 }),
    variable(tx, 'StopTxOnEVSideDisconnect', 'boolean', rw('true')),
    variable(tx, 'StopTxOnInvalidId', 'boolean', rw('true')),
    variable(tx, 'MaxEnergyOnInvalidId', 'integer', rw('0'), { unit: 'Wh', minLimit: 0 }),
    variable(tx, 'TxStartPoint', 'MemberList', rw('PowerPathClosed'), { valuesList: TX_POINTS }),
    variable(tx, 'TxStopPoint', 'MemberList', rw('PowerPathClosed'), { valuesList: TX_POINTS }),

    variable(auth, 'Enabled', 'boolean', rw('true')),
    variable(auth, 'AuthorizeRemoteStart', 'boolean', rw('true')),
    variable(auth, 'LocalAuthorizeOffline', 'boolean', rw('true')),
    variable(auth, 'LocalPreAuthorize', 'boolean', rw('false')),
    variable(auth, 'OfflineTxForUnknownIdEnabled', 'boolean', rw('false')),
    variable(auth, 'DisableRemoteAuthorization', 'boolean', rw('false')),
    variable(auth, 'MasterPassGroupId', 'string', rw(), { maxLimit: 36 }),

    variable(cache, 'Available', 'boolean', ro('true')),
    variable(cache, 'Enabled', 'boolean', rw('true')),
    variable(cache, 'LifeTime', 'integer', rw('86400'), { unit: 's', minLimit: 0 }),
    variable(cache, 'Policy', 'OptionList', rw('LRU'), { valuesList: 'LRU' }),
    variable(cache, 'DisablePostAuthorize', 'boolean', rw('false')),

    variable(sampled, 'Enabled', 'boolean', rw('true')),
    variable(sampled, 'TxStartedMeasurands', 'MemberList', rw('Energy.Active.Import.Register'), {
      valuesList: MEASURANDS,
    }),
    variable(
      sampled,
      'TxUpdatedMeasurands',
      'MemberList',
      rw('Energy.Active.Import.Register,Power.Active.Import'),
      {
        valuesList: MEASURANDS,
      },
    ),
    variable(sampled, 'TxUpdatedInterval', 'integer', rw('60'), { unit: 's', minLimit: 0 }),
    variable(sampled, 'TxEndedMeasurands', 'MemberList', rw('Energy.Active.Import.Register'), {
      valuesList: MEASURANDS,
    }),
    variable(sampled, 'TxEndedInterval', 'integer', rw('0'), { unit: 's', minLimit: 0 }),
    variable(sampled, 'RegisterValuesWithoutPhases', 'boolean', rw('true')),

    variable(aligned, 'Enabled', 'boolean', rw('true')),
    variable(aligned, 'Interval', 'integer', rw('0'), { unit: 's', minLimit: 0 }),
    variable(aligned, 'Measurands', 'MemberList', rw('Energy.Active.Import.Register'), {
      valuesList: MEASURANDS,
    }),
    variable(aligned, 'SendDuringIdle', 'boolean', rw('false')),
    variable(aligned, 'TxEndedInterval', 'integer', rw('0'), { unit: 's', minLimit: 0 }),
    variable(aligned, 'TxEndedMeasurands', 'MemberList', rw('Energy.Active.Import.Register'), {
      valuesList: MEASURANDS,
    }),

    ...(['GetReport', 'GetVariables', 'SetVariables'] as const).flatMap((instance) => [
      variable(device, 'ItemsPerMessage', 'integer', ro('20', true), { instance }),
      variable(device, 'BytesPerMessage', 'integer', ro('8192', true), { instance }),
    ]),

    variable(clock, 'DateTime', 'dateTime', ro(), dynamic),
    variable(clock, 'TimeSource', 'SequenceList', rw('Heartbeat'), {
      valuesList: 'Heartbeat,NTP,GPS,RealTimeClock,MobileNetwork,RadioTimeTransmitter',
    }),

    variable(security, 'SecurityProfile', 'integer', ro('0'), { minLimit: 0, maxLimit: 3 }),
    variable(security, 'OrganizationName', 'string', rw('ocpp-mimic'), { maxLimit: 64 }),
    variable(security, 'CertificateEntries', 'integer', ro('0')),
    variable(security, 'BasicAuthPassword', 'string', wo(), { maxLimit: 40 }),
  ];

  if (input.features.includes('LocalAuthListManagement')) {
    const list: ComponentType = { name: 'LocalAuthListCtrlr' };
    out.push(
      variable(list, 'Available', 'boolean', ro('true')),
      variable(list, 'Enabled', 'boolean', rw('true')),
      variable(list, 'Entries', 'integer', ro(), { maxLimit: LOCAL_LIST_SIZE, ...dynamic }),
      variable(list, 'ItemsPerMessage', 'integer', ro('50', true)),
      variable(list, 'BytesPerMessage', 'integer', ro('8192', true)),
    );
  }

  for (let id = 1; id <= input.connectors; id++) {
    const evse: ComponentType = { name: 'EVSE', evse: { id } };
    const connector: ComponentType = { name: 'Connector', evse: { id, connectorId: 1 } };
    out.push(
      variable(evse, 'AvailabilityState', 'OptionList', ro(), {
        valuesList: AVAILABILITY,
        ...dynamic,
      }),
      variable(evse, 'Available', 'boolean', ro('true')),
      variable(evse, 'Problem', 'boolean', ro(), dynamic),
      variable(evse, 'Power', 'decimal', ro(), {
        unit: 'W',
        maxLimit: input.offeredW,
        ...dynamic,
      }),
      variable(evse, 'SupplyPhases', 'integer', ro('3')),
      variable(connector, 'AvailabilityState', 'OptionList', ro(), {
        valuesList: AVAILABILITY,
        ...dynamic,
      }),
      variable(connector, 'Available', 'boolean', ro('true')),
      variable(connector, 'Problem', 'boolean', ro(), dynamic),
      variable(connector, 'ConnectorType', 'string', ro(input.connectorType ?? 'cType2', true)),
      variable(connector, 'SupplyPhases', 'integer', ro('3')),
    );
  }
  return out;
}
