/**
 * The standard components and variables a 2.0.1 or 2.1 station of ocpp-mimic
 * implements, with the data types of the Part 2 appendix (v1.4 for 2.0.1) and
 * spec-default values. Controllers for a certification profile appear only
 * when the persona supports the profile. A 2.1 station adds the 2.1 variables
 * (appendix v2.0) whose behaviour exists; the M7 tasks add theirs.
 */
import { SUPPORTED_MEASURANDS } from '../meter.js';
import { OCPP21_ID_TOKEN_TYPES } from '../ocpp21/constants.js';
import { PAYMENT_DETAILS, TOTP_VERSIONS, WEB_PAYMENT_PARAMETERS } from '../ocpp21/payment.js';
import { VEHICLE_MEASURANDS } from '../ocpp21/iso15118-20.js';
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
  /** The station's version; 2.1 adds its own variables. Default 2.0.1. */
  ocpp?: '2.0.1' | '2.1';
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
const ID_TOKEN_TYPES_21 = OCPP21_ID_TOKEN_TYPES.join(',');
/** Entries the Local Authorization List holds at most (LocalAuthListCtrlr.Entries maxLimit). */
export const LOCAL_LIST_SIZE = 100;
/** The network connection profile slots (B09.FR.06 asks for at least two). */
export const NETWORK_SLOTS = ['0', '1', '2'] as const;
/** Certificates installed at most (CertificateEntries maxLimit). */
export const CERTIFICATE_ENTRIES_MAX = 20;
/** Charging profiles installed at most (SmartChargingCtrlr.Entries maxLimit). */
export const CHARGING_PROFILES_MAX = 20;
const TX_POINTS = 'EVConnected,Authorized,PowerPathClosed,EnergyTransfer';
const TX_LIMITS = 'maxEnergy,maxTime,maxSoC,maxCost';
const PURPOSES_21 = 'PriorityCharging,LocalGeneration';
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
  // 2.1 adds an ISO 15118-20 EV's values (R-EV-4).
  const measurands =
    input.ocpp === '2.1' ? `${MEASURANDS},${VEHICLE_MEASURANDS.join(',')}` : MEASURANDS;
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
    // A new priority applies after a reboot (B10.FR.04).
    variable(comm, 'NetworkConfigurationPriority', 'SequenceList', rw('0'), {
      valuesList: NETWORK_SLOTS.join(','),
      rebootRequired: true,
    }),
    variable(comm, 'NetworkProfileConnectionAttempts', 'integer', rw('3'), { minLimit: 1 }),
    variable(comm, 'ActiveNetworkProfile', 'integer', ro(), dynamic),

    variable(tx, 'EVConnectionTimeOut', 'integer', rw('60'), { unit: 's', minLimit: 0 }),
    variable(tx, 'StopTxOnEVSideDisconnect', 'boolean', rw('true')),
    variable(tx, 'StopTxOnInvalidId', 'boolean', rw('true')),
    variable(tx, 'MaxEnergyOnInvalidId', 'integer', rw('0'), { unit: 'Wh', minLimit: 0 }),
    variable(tx, 'TxStartPoint', 'MemberList', rw('PowerPathClosed'), { valuesList: TX_POINTS }),
    variable(tx, 'TxStopPoint', 'MemberList', rw('PowerPathClosed'), { valuesList: TX_POINTS }),
    // 2.1: the transaction limits the station takes (E16.FR.12) and transactions resumed
    // after a reset or a power loss (B13, E17; 0 s means none).
    ...(input.ocpp === '2.1'
      ? [
          variable(tx, 'SupportedLimits', 'MemberList', ro(TX_LIMITS), { valuesList: TX_LIMITS }),
          variable(tx, 'ResumptionTimeout', 'integer', rw('0'), { unit: 's', minLimit: 0 }),
          variable(tx, 'AllowEnergyTransferResumption', 'boolean', rw('false')),
        ]
      : []),

    variable(auth, 'Enabled', 'boolean', rw('true')),
    variable(auth, 'AuthorizeRemoteStart', 'boolean', rw('true')),
    variable(auth, 'LocalAuthorizeOffline', 'boolean', rw('true')),
    variable(auth, 'LocalPreAuthorize', 'boolean', rw('false')),
    variable(auth, 'OfflineTxForUnknownIdEnabled', 'boolean', rw('false')),
    variable(auth, 'DisableRemoteAuthorization', 'boolean', rw('false')),
    variable(auth, 'MasterPassGroupId', 'string', rw(), { maxLimit: 36 }),
    // 2.1's idToken type is an open string; the station names the types it takes.
    ...(input.ocpp === '2.1'
      ? [
          variable(auth, 'SupportedIdTokenTypes', 'MemberList', ro(ID_TOKEN_TYPES_21, true), {
            valuesList: ID_TOKEN_TYPES_21,
          }),
        ]
      : []),

    variable(cache, 'Available', 'boolean', ro('true')),
    variable(cache, 'Enabled', 'boolean', rw('true')),
    variable(cache, 'LifeTime', 'integer', rw('86400'), { unit: 's', minLimit: 0 }),
    variable(cache, 'Policy', 'OptionList', rw('LRU'), { valuesList: 'LRU' }),
    variable(cache, 'DisablePostAuthorize', 'boolean', rw('false')),

    variable(sampled, 'Enabled', 'boolean', rw('true')),
    variable(sampled, 'TxStartedMeasurands', 'MemberList', rw('Energy.Active.Import.Register'), {
      valuesList: measurands,
    }),
    variable(
      sampled,
      'TxUpdatedMeasurands',
      'MemberList',
      rw('Energy.Active.Import.Register,Power.Active.Import'),
      {
        valuesList: measurands,
      },
    ),
    variable(sampled, 'TxUpdatedInterval', 'integer', rw('60'), { unit: 's', minLimit: 0 }),
    variable(sampled, 'TxEndedMeasurands', 'MemberList', rw('Energy.Active.Import.Register'), {
      valuesList: measurands,
    }),
    variable(sampled, 'TxEndedInterval', 'integer', rw('0'), { unit: 's', minLimit: 0 }),
    variable(sampled, 'RegisterValuesWithoutPhases', 'boolean', rw('true')),

    variable(aligned, 'Enabled', 'boolean', rw('true')),
    variable(aligned, 'Interval', 'integer', rw('0'), { unit: 's', minLimit: 0 }),
    variable(aligned, 'Measurands', 'MemberList', rw('Energy.Active.Import.Register'), {
      valuesList: measurands,
    }),
    variable(aligned, 'SendDuringIdle', 'boolean', rw('false')),
    variable(aligned, 'TxEndedInterval', 'integer', rw('0'), { unit: 's', minLimit: 0 }),
    variable(aligned, 'TxEndedMeasurands', 'MemberList', rw('Energy.Active.Import.Register'), {
      valuesList: measurands,
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
    variable(security, 'CertificateEntries', 'integer', ro(), {
      maxLimit: CERTIFICATE_ENTRIES_MAX,
      ...dynamic,
    }),
    variable(security, 'BasicAuthPassword', 'string', wo(), { maxLimit: 40 }),
    variable(security, 'AdditionalRootCertificateCheck', 'boolean', ro('false')),
    variable(security, 'MaxCertificateChainSize', 'integer', ro('10000'), { maxLimit: 10000 }),
    variable(security, 'CertSigningWaitMinimum', 'integer', rw('60'), { unit: 's', minLimit: 0 }),
    variable(security, 'CertSigningRepeatTimes', 'integer', rw('3'), { minLimit: 0 }),
  ];

  if (input.ocpp === '2.1') {
    // The station's time zone: tariff conditions are in local time (I07.FR.17).
    out.push(variable(clock, 'TimeZone', 'string', rw(''), { maxLimit: 64 }));
  }

  if (input.ocpp === '2.1' && input.features.includes('TariffAndCost')) {
    // Local cost calculation (I07 to I12); instances as in appendix v2.0.
    const tariffCost: ComponentType = { name: 'TariffCostCtrlr' };
    out.push(
      variable(tariffCost, 'Available', 'boolean', ro('true', true), { instance: 'Tariff' }),
      variable(tariffCost, 'Enabled', 'boolean', rw('true'), { instance: 'Tariff' }),
      variable(tariffCost, 'Available', 'boolean', ro('true', true), { instance: 'Cost' }),
      variable(tariffCost, 'Enabled', 'boolean', rw('true'), { instance: 'Cost' }),
      variable(tariffCost, 'Enabled', 'boolean', rw('true'), { instance: 'RunningCost' }),
      variable(tariffCost, 'Interval', 'integer', rw('60'), {
        instance: 'Cost',
        unit: 's',
        minLimit: 1,
      }),
      variable(tariffCost, 'Interval', 'integer', rw('0'), {
        instance: 'Tariff',
        unit: 's',
        minLimit: 0,
      }),
      variable(tariffCost, 'MaxElements', 'integer', ro('10'), { instance: 'Tariff', minLimit: 0 }),
      variable(tariffCost, 'ConditionsSupported', 'boolean', ro('true'), { instance: 'Tariff' }),
      variable(tariffCost, 'HandleFailedTariff', 'OptionList', rw('UseDefaultTariff'), {
        instance: 'Tariff',
        valuesList: 'Deauthorize,UseDefaultTariff,CentralCost',
      }),
      variable(tariffCost, 'Currency', 'string', rw('EUR'), { maxLimit: 3 }),
      variable(tariffCost, 'TariffFallbackMessage', 'string', rw(''), { maxLimit: 512 }),
      variable(tariffCost, 'TotalCostFallbackMessage', 'string', rw(''), { maxLimit: 512 }),
      variable(tariffCost, 'Problem', 'boolean', ro('false')),
    );
  }

  if (input.ocpp === '2.1' && input.features.includes('Payment')) {
    // An integrated payment terminal (C18 to C23); appendix v2.0 values, test defaults.
    const payment: ComponentType = { name: 'PaymentCtrlr' };
    out.push(
      variable(payment, 'Enabled', 'boolean', rw('true')),
      variable(payment, 'Problem', 'boolean', ro('false')),
      variable(payment, 'AuthorizeDirectPayment', 'boolean', rw('false')),
      variable(payment, 'AuthorizationAmount', 'decimal', rw('50'), { minLimit: 0 }),
      // 0: no incremental authorization (C23.FR.01).
      variable(payment, 'IncrementalAuthorizationAmount', 'decimal', rw('0'), { minLimit: 0 }),
      variable(payment, 'IncrementalAuthorizationThreshold', 'decimal', rw('5'), { minLimit: 0 }),
      variable(payment, 'PaymentDetails', 'MemberList', rw('PaymentBrand,PaymentRecognition'), {
        valuesList: PAYMENT_DETAILS.join(','),
      }),
      variable(payment, 'SettlementByCSMS', 'boolean', rw('false')),
      variable(payment, 'ReceiptServerUrl', 'string', rw('https://receipts.example.com'), {
        maxLimit: 512,
      }),
      variable(payment, 'ReceiptByCSMS', 'boolean', rw('false')),
      ...(
        [
          ['Id', 'M-0001'],
          ['TaxId', ''],
          ['Name', 'Test merchant'],
          ['Address', '1 Test Street'],
          ['City', 'Testville'],
        ] as const
      ).map(([instance, value]) =>
        variable(payment, 'Merchant', 'string', rw(value), { instance, maxLimit: 100 }),
      ),
      variable(payment, 'TerminalID', 'string', ro('TERM-0001')),
      variable(payment, 'PaymentServiceProvider', 'string', ro('Test PSP')),
      variable(payment, 'VendorName', 'string', ro('ocpp-mimic')),
      variable(payment, 'Model', 'string', ro('Simulated terminal')),
      variable(payment, 'SerialNumber', 'string', ro('PT-0001')),
      variable(payment, 'FirmwareVersion', 'string', ro('1.0.0')),
      variable(payment, 'IMSI', 'string', ro('')),
      variable(payment, 'ICCID', 'string', ro('')),
      variable(payment, 'Connected', 'boolean', ro('true')),
    );
  }

  if (input.ocpp === '2.1' && input.features.includes('WebPayments')) {
    // The dynamic QR code (C25). The appendix has no Enabled, but C25.FR.01 relies on it.
    // SharedSecret gets a random value at first boot (the station does it).
    const web: ComponentType = { name: 'WebPaymentsCtrlr' };
    out.push(
      variable(web, 'Enabled', 'boolean', rw('true')),
      variable(
        web,
        'URLTemplate',
        'string',
        rw('https://pay.example.com/{chargingstationid}/{evse}/{totp}/{version}'),
        { maxLimit: 512 },
      ),
      variable(web, 'URLParameters', 'MemberList', ro(WEB_PAYMENT_PARAMETERS.join(',')), {
        valuesList: WEB_PAYMENT_PARAMETERS.join(','),
      }),
      variable(web, 'TOTPVersion', 'OptionList', rw('v1'), { valuesList: TOTP_VERSIONS.join(',') }),
      variable(web, 'ValidityTime', 'integer', rw('30'), {
        unit: 's',
        minLimit: 6,
        maxLimit: 3600,
      }),
      variable(web, 'SharedSecret', 'string', wo(), { minLimit: 8, maxLimit: 64 }),
      variable(web, 'Length', 'integer', rw('8'), { minLimit: 6, maxLimit: 32 }),
      variable(web, 'QRCodeQuality', 'OptionList', rw('Medium'), {
        valuesList: 'Low,Medium,Quartile,High',
      }),
    );
  }

  if (input.ocpp === '2.1') {
    // F06: the vendor triggers TriggerMessage CustomTrigger takes; none unless the persona
    // names some, each answered with a DataTransfer named after it.
    out.push(variable({ name: 'CustomizationCtrlr' }, 'CustomTriggers', 'MemberList', ro('')));
    // A05.FR.08: going from Security Profile 3 to 2 is allowed when this is true.
    out.push(
      variable(security, 'AllowSecurityProfileDowngrade', 'boolean', rw('false')),
      variable(security, 'Identity', 'string', rw(), { maxLimit: 48 }),
    );
    // B09.FR.08, .10: each network slot as a NetworkConfiguration component, ReadOnly (the
    // CSMS sets slots with SetNetworkProfile). Its BasicAuthPassword is left out: a ReadOnly
    // copy would report the password.
    for (const slot of NETWORK_SLOTS) {
      const network: ComponentType = { name: 'NetworkConfiguration', instance: slot };
      out.push(
        variable(network, 'OcppCsmsUrl', 'string', ro(), dynamic),
        variable(network, 'OcppInterface', 'OptionList', ro(), {
          ...dynamic,
          valuesList: 'Wired0,Wired1,Wired2,Wired3,Wireless0,Wireless1,Wireless2,Wireless3,Any',
        }),
        variable(network, 'OcppTransport', 'OptionList', ro(), {
          ...dynamic,
          valuesList: 'SOAP,JSON',
        }),
        variable(network, 'OcppVersion', 'OptionList', ro(), {
          ...dynamic,
          valuesList: 'OCPP12,OCPP15,OCPP16,OCPP20,OCPP201,OCPP21',
        }),
        variable(network, 'MessageTimeout', 'integer', ro(), { ...dynamic, unit: 's' }),
        variable(network, 'SecurityProfile', 'integer', ro(), dynamic),
        variable(network, 'Identity', 'string', ro(), dynamic),
        variable(network, 'VpnEnabled', 'boolean', ro(), dynamic),
        variable(network, 'ApnEnabled', 'boolean', ro(), dynamic),
      );
    }
  }

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

  if (input.features.includes('Reservation')) {
    const reservation: ComponentType = { name: 'ReservationCtrlr' };
    out.push(
      variable(reservation, 'Available', 'boolean', ro('true')),
      variable(reservation, 'Enabled', 'boolean', rw('true')),
      variable(reservation, 'NonEvseSpecific', 'boolean', rw('true')),
    );
  }

  if (input.features.includes('SmartCharging')) {
    const smart: ComponentType = { name: 'SmartChargingCtrlr' };
    out.push(
      variable(smart, 'Available', 'boolean', ro('true')),
      variable(smart, 'Enabled', 'boolean', rw('true')),
      variable(smart, 'Entries', 'integer', ro(), {
        instance: 'ChargingProfiles',
        maxLimit: CHARGING_PROFILES_MAX,
        ...dynamic,
      }),
      variable(smart, 'LimitChangeSignificance', 'decimal', rw('10'), {
        unit: 'Percent',
        minLimit: 0,
      }),
      variable(smart, 'PeriodsPerSchedule', 'integer', ro('24')),
      variable(smart, 'ProfileStackLevel', 'integer', ro('10')),
      variable(smart, 'RateUnit', 'MemberList', ro('A,W'), { valuesList: 'A,W' }),
      variable(smart, 'Phases3to1', 'boolean', ro('false')),
      // 2.1: priority charging, local generation and Dynamic profiles are supported (K21,
      // K27, K28); the other optional schedule features are not (K01.FR.123 to .126).
      ...(input.ocpp === '2.1'
        ? [
            variable(smart, 'SupportedAdditionalPurposes', 'MemberList', ro(PURPOSES_21), {
              valuesList: PURPOSES_21,
            }),
            variable(smart, 'SupportsDynamicProfiles', 'boolean', ro('true')),
            variable(smart, 'SupportsUseLocalTime', 'boolean', ro('false')),
            variable(smart, 'SupportsRandomizedDelay', 'boolean', ro('false')),
            variable(smart, 'SupportsLimitAtSoC', 'boolean', ro('false')),
            variable(smart, 'SupportsEvseSleep', 'boolean', ro('false')),
            variable(smart, 'SupportsMaxOfflineDuration', 'boolean', ro('false')),
          ]
        : []),
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
      // Resetting one EVSE is supported (B11.FR.10).
      variable(evse, 'AllowReset', 'boolean', ro('true')),
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
