/**
 * OCPP 1.6 message definitions for M1: the Core profile plus TriggerMessage.
 * Written from the OCPP 1.6 specification (field names, types, lengths and
 * enumerations); see docs/design.md, "OCPP 1.6J coverage". Each entry
 * validates at runtime and gives the TypeScript type of its payload.
 */
import { CHARGE_POINT_STATUSES } from './ocpp16.js';
import {
  array,
  boolean,
  dateTime,
  integer,
  number,
  object,
  oneOf,
  string,
  validate,
  type Infer,
  type Schema,
  type ValidationResult,
} from './schema.js';

// ---- Shared types --------------------------------------------------------

/** IdToken: a CiString20. */
export const IdToken = string({ maxLength: 20 });

export const AuthorizationStatus = oneOf([
  'Accepted',
  'Blocked',
  'Expired',
  'Invalid',
  'ConcurrentTx',
]);

export const IdTagInfo = object(
  { status: AuthorizationStatus },
  { expiryDate: dateTime(), parentIdTag: IdToken },
);

export const ChargePointErrorCode = oneOf([
  'ConnectorLockFailure',
  'EVCommunicationError',
  'GroundFailure',
  'HighTemperature',
  'InternalError',
  'LocalListConflict',
  'NoError',
  'OtherError',
  'OverCurrentFailure',
  'PowerMeterFailure',
  'PowerSwitchFailure',
  'ReaderFailure',
  'ResetFailure',
  'UnderVoltage',
  'OverVoltage',
  'WeakSignal',
]);

export const ReadingContext = oneOf([
  'Interruption.Begin',
  'Interruption.End',
  'Sample.Clock',
  'Sample.Periodic',
  'Transaction.Begin',
  'Transaction.End',
  'Trigger',
  'Other',
]);

export const Measurand = oneOf([
  'Energy.Active.Export.Register',
  'Energy.Active.Import.Register',
  'Energy.Reactive.Export.Register',
  'Energy.Reactive.Import.Register',
  'Energy.Active.Export.Interval',
  'Energy.Active.Import.Interval',
  'Energy.Reactive.Export.Interval',
  'Energy.Reactive.Import.Interval',
  'Power.Active.Export',
  'Power.Active.Import',
  'Power.Offered',
  'Power.Reactive.Export',
  'Power.Reactive.Import',
  'Power.Factor',
  'Current.Import',
  'Current.Export',
  'Current.Offered',
  'Voltage',
  'Frequency',
  'Temperature',
  'SoC',
  'RPM',
]);

export const SampledValue = object(
  { value: string() },
  {
    context: ReadingContext,
    format: oneOf(['Raw', 'SignedData']),
    measurand: Measurand,
    phase: oneOf(['L1', 'L2', 'L3', 'N', 'L1-N', 'L2-N', 'L3-N', 'L1-L2', 'L2-L3', 'L3-L1']),
    location: oneOf(['Cable', 'EV', 'Inlet', 'Outlet', 'Body']),
    // "Celcius" is the spelling in the 1.6 specification; "Celsius" is accepted too.
    unit: oneOf([
      'Wh',
      'kWh',
      'varh',
      'kvarh',
      'W',
      'kW',
      'VA',
      'kVA',
      'var',
      'kvar',
      'A',
      'V',
      'K',
      'Celcius',
      'Celsius',
      'Fahrenheit',
      'Percent',
    ]),
  },
);

export const MeterValue = object({
  timestamp: dateTime(),
  sampledValue: array(SampledValue, { minItems: 1 }),
});

export const ChargingSchedulePeriod = object(
  { startPeriod: integer(), limit: number() },
  { numberPhases: integer() },
);

export const ChargingSchedule = object(
  {
    chargingRateUnit: oneOf(['A', 'W']),
    chargingSchedulePeriod: array(ChargingSchedulePeriod, { minItems: 1 }),
  },
  { duration: integer(), startSchedule: dateTime(), minChargingRate: number() },
);

export const ChargingProfile = object(
  {
    chargingProfileId: integer(),
    stackLevel: integer({ minimum: 0 }),
    chargingProfilePurpose: oneOf(['ChargePointMaxProfile', 'TxDefaultProfile', 'TxProfile']),
    chargingProfileKind: oneOf(['Absolute', 'Recurring', 'Relative']),
    chargingSchedule: ChargingSchedule,
  },
  {
    transactionId: integer(),
    recurrencyKind: oneOf(['Daily', 'Weekly']),
    validFrom: dateTime(),
    validTo: dateTime(),
  },
);

export const StopReason = oneOf([
  'EmergencyStop',
  'EVDisconnected',
  'HardReset',
  'Local',
  'Other',
  'PowerLoss',
  'Reboot',
  'Remote',
  'SoftReset',
  'UnlockCommand',
  'DeAuthorized',
]);

const acceptedOrRejected = object({ status: oneOf(['Accepted', 'Rejected']) });

// ---- Messages ------------------------------------------------------------

/** Request and response definitions for every M1 action. */
export const OCPP16_MESSAGES = {
  // Initiated by the charge point
  Authorize: {
    request: object({ idTag: IdToken }),
    response: object({ idTagInfo: IdTagInfo }),
  },
  BootNotification: {
    request: object(
      {
        chargePointVendor: string({ maxLength: 20 }),
        chargePointModel: string({ maxLength: 20 }),
      },
      {
        chargePointSerialNumber: string({ maxLength: 25 }),
        chargeBoxSerialNumber: string({ maxLength: 25 }),
        firmwareVersion: string({ maxLength: 50 }),
        iccid: string({ maxLength: 20 }),
        imsi: string({ maxLength: 20 }),
        meterType: string({ maxLength: 25 }),
        meterSerialNumber: string({ maxLength: 25 }),
      },
    ),
    response: object({
      status: oneOf(['Accepted', 'Pending', 'Rejected']),
      currentTime: dateTime(),
      interval: integer(),
    }),
  },
  Heartbeat: {
    request: object({}),
    response: object({ currentTime: dateTime() }),
  },
  MeterValues: {
    request: object(
      { connectorId: integer({ minimum: 0 }), meterValue: array(MeterValue, { minItems: 1 }) },
      { transactionId: integer() },
    ),
    response: object({}),
  },
  StartTransaction: {
    request: object(
      {
        connectorId: integer({ minimum: 1 }),
        idTag: IdToken,
        meterStart: integer(),
        timestamp: dateTime(),
      },
      { reservationId: integer() },
    ),
    response: object({ idTagInfo: IdTagInfo, transactionId: integer() }),
  },
  StatusNotification: {
    request: object(
      {
        connectorId: integer({ minimum: 0 }),
        errorCode: ChargePointErrorCode,
        status: oneOf(CHARGE_POINT_STATUSES),
      },
      {
        info: string({ maxLength: 50 }),
        timestamp: dateTime(),
        vendorId: string({ maxLength: 255 }),
        vendorErrorCode: string({ maxLength: 50 }),
      },
    ),
    response: object({}),
  },
  StopTransaction: {
    request: object(
      { meterStop: integer(), timestamp: dateTime(), transactionId: integer() },
      { idTag: IdToken, reason: StopReason, transactionData: array(MeterValue) },
    ),
    response: object({}, { idTagInfo: IdTagInfo }),
  },

  // Initiated by either side
  DataTransfer: {
    request: object(
      { vendorId: string({ maxLength: 255 }) },
      { messageId: string({ maxLength: 50 }), data: string() },
    ),
    response: object(
      { status: oneOf(['Accepted', 'Rejected', 'UnknownMessageId', 'UnknownVendorId']) },
      { data: string() },
    ),
  },

  // Initiated by the CSMS
  ChangeAvailability: {
    request: object({
      connectorId: integer({ minimum: 0 }),
      type: oneOf(['Inoperative', 'Operative']),
    }),
    response: object({ status: oneOf(['Accepted', 'Rejected', 'Scheduled']) }),
  },
  ChangeConfiguration: {
    request: object({ key: string({ maxLength: 50 }), value: string({ maxLength: 500 }) }),
    response: object({
      status: oneOf(['Accepted', 'Rejected', 'RebootRequired', 'NotSupported']),
    }),
  },
  ClearCache: {
    request: object({}),
    response: acceptedOrRejected,
  },
  GetConfiguration: {
    request: object({}, { key: array(string({ maxLength: 50 })) }),
    response: object(
      {},
      {
        configurationKey: array(
          object(
            { key: string({ maxLength: 50 }), readonly: boolean() },
            { value: string({ maxLength: 500 }) },
          ),
        ),
        unknownKey: array(string({ maxLength: 50 })),
      },
    ),
  },
  RemoteStartTransaction: {
    request: object(
      { idTag: IdToken },
      { connectorId: integer(), chargingProfile: ChargingProfile },
    ),
    response: acceptedOrRejected,
  },
  RemoteStopTransaction: {
    request: object({ transactionId: integer() }),
    response: acceptedOrRejected,
  },
  Reset: {
    request: object({ type: oneOf(['Hard', 'Soft']) }),
    response: acceptedOrRejected,
  },
  TriggerMessage: {
    request: object(
      {
        requestedMessage: oneOf([
          'BootNotification',
          'DiagnosticsStatusNotification',
          'FirmwareStatusNotification',
          'Heartbeat',
          'MeterValues',
          'StatusNotification',
        ]),
      },
      { connectorId: integer() },
    ),
    response: object({ status: oneOf(['Accepted', 'Rejected', 'NotImplemented']) }),
  },
  UnlockConnector: {
    request: object({ connectorId: integer() }),
    response: object({ status: oneOf(['Unlocked', 'UnlockFailed', 'NotSupported']) }),
  },
} as const satisfies Record<string, { request: Schema<unknown>; response: Schema<unknown> }>;

export type Ocpp16Action = keyof typeof OCPP16_MESSAGES;
export type RequestOf<A extends Ocpp16Action> = Infer<(typeof OCPP16_MESSAGES)[A]['request']>;
export type ResponseOf<A extends Ocpp16Action> = Infer<(typeof OCPP16_MESSAGES)[A]['response']>;

/** Actions the charge point sends in M1. */
export const CHARGE_POINT_ACTIONS = [
  'Authorize',
  'BootNotification',
  'DataTransfer',
  'Heartbeat',
  'MeterValues',
  'StartTransaction',
  'StatusNotification',
  'StopTransaction',
] as const satisfies readonly Ocpp16Action[];

/** Actions the charge point accepts from the CSMS in M1. */
export const CSMS_ACTIONS = [
  'ChangeAvailability',
  'ChangeConfiguration',
  'ClearCache',
  'DataTransfer',
  'GetConfiguration',
  'RemoteStartTransaction',
  'RemoteStopTransaction',
  'Reset',
  'TriggerMessage',
  'UnlockConnector',
] as const satisfies readonly Ocpp16Action[];

export function isOcpp16Action(action: string): action is Ocpp16Action {
  return Object.hasOwn(OCPP16_MESSAGES, action);
}

export function validateRequest<A extends Ocpp16Action>(
  action: A,
  payload: unknown,
): ValidationResult<RequestOf<A>> {
  return validate(OCPP16_MESSAGES[action].request as Schema<RequestOf<A>>, payload);
}

export function validateResponse<A extends Ocpp16Action>(
  action: A,
  payload: unknown,
): ValidationResult<ResponseOf<A>> {
  return validate(OCPP16_MESSAGES[action].response as Schema<ResponseOf<A>>, payload);
}
