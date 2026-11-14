/**
 * OCPP 1.6 message definitions for M1: the Core profile plus TriggerMessage.
 * Written from the OCPP 1.6 specification (field names, types, lengths and
 * enumerations); see docs/design.md, "OCPP 1.6J coverage". Each entry
 * validates at runtime and gives the TypeScript type of its payload.
 */
import { CHARGE_POINT_STATUSES, MEASURANDS } from './ocpp16.js';
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

/** IdTokenSchema: a CiString20. */
export const IdTokenSchema = string({ maxLength: 20 });

export const AuthorizationStatusSchema = oneOf([
  'Accepted',
  'Blocked',
  'Expired',
  'Invalid',
  'ConcurrentTx',
]);

export const IdTagInfoSchema = object(
  { status: AuthorizationStatusSchema },
  { expiryDate: dateTime(), parentIdTag: IdTokenSchema },
);

export const ChargePointErrorCodeSchema = oneOf([
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

export const ReadingContextSchema = oneOf([
  'Interruption.Begin',
  'Interruption.End',
  'Sample.Clock',
  'Sample.Periodic',
  'Transaction.Begin',
  'Transaction.End',
  'Trigger',
  'Other',
]);

export const MeasurandSchema = oneOf(MEASURANDS);

export const SampledValueSchema = object(
  { value: string() },
  {
    context: ReadingContextSchema,
    format: oneOf(['Raw', 'SignedData']),
    measurand: MeasurandSchema,
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

export const MeterValueSchema = object({
  timestamp: dateTime(),
  sampledValue: array(SampledValueSchema, { minItems: 1 }),
});

export const ChargingSchedulePeriodSchema = object(
  { startPeriod: integer(), limit: number() },
  { numberPhases: integer() },
);

export const ChargingScheduleSchema = object(
  {
    chargingRateUnit: oneOf(['A', 'W']),
    chargingSchedulePeriod: array(ChargingSchedulePeriodSchema, { minItems: 1 }),
  },
  { duration: integer(), startSchedule: dateTime(), minChargingRate: number() },
);

export const ChargingProfileSchema = object(
  {
    chargingProfileId: integer(),
    stackLevel: integer({ minimum: 0 }),
    chargingProfilePurpose: oneOf(['ChargePointMaxProfile', 'TxDefaultProfile', 'TxProfile']),
    chargingProfileKind: oneOf(['Absolute', 'Recurring', 'Relative']),
    chargingSchedule: ChargingScheduleSchema,
  },
  {
    transactionId: integer(),
    recurrencyKind: oneOf(['Daily', 'Weekly']),
    validFrom: dateTime(),
    validTo: dateTime(),
  },
);

export const StopReasonSchema = oneOf([
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

/** TypeScript types of the shared definitions above. */
export type IdToken = Infer<typeof IdTokenSchema>;
export type AuthorizationStatus = Infer<typeof AuthorizationStatusSchema>;
export type IdTagInfo = Infer<typeof IdTagInfoSchema>;
export type ChargePointErrorCode = Infer<typeof ChargePointErrorCodeSchema>;
export type ReadingContext = Infer<typeof ReadingContextSchema>;
export type SampledValue = Infer<typeof SampledValueSchema>;
export type MeterValue = Infer<typeof MeterValueSchema>;
export type ChargingSchedulePeriod = Infer<typeof ChargingSchedulePeriodSchema>;
export type ChargingSchedule = Infer<typeof ChargingScheduleSchema>;
export type ChargingProfile = Infer<typeof ChargingProfileSchema>;
export type StopReason = Infer<typeof StopReasonSchema>;

const acceptedOrRejected = object({ status: oneOf(['Accepted', 'Rejected']) });

// ---- Messages ------------------------------------------------------------

/** Request and response definitions for every M1 action. */
export const OCPP16_MESSAGES = {
  // Initiated by the charge point
  Authorize: {
    request: object({ idTag: IdTokenSchema }),
    response: object({ idTagInfo: IdTagInfoSchema }),
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
      {
        connectorId: integer({ minimum: 0 }),
        meterValue: array(MeterValueSchema, { minItems: 1 }),
      },
      { transactionId: integer() },
    ),
    response: object({}),
  },
  StartTransaction: {
    request: object(
      {
        connectorId: integer({ minimum: 1 }),
        idTag: IdTokenSchema,
        meterStart: integer(),
        timestamp: dateTime(),
      },
      { reservationId: integer() },
    ),
    response: object({ idTagInfo: IdTagInfoSchema, transactionId: integer() }),
  },
  StatusNotification: {
    request: object(
      {
        connectorId: integer({ minimum: 0 }),
        errorCode: ChargePointErrorCodeSchema,
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
      { idTag: IdTokenSchema, reason: StopReasonSchema, transactionData: array(MeterValueSchema) },
    ),
    response: object({}, { idTagInfo: IdTagInfoSchema }),
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

  DiagnosticsStatusNotification: {
    request: object({ status: oneOf(['Idle', 'Uploaded', 'UploadFailed', 'Uploading']) }),
    response: object({}),
  },
  FirmwareStatusNotification: {
    request: object({
      status: oneOf([
        'Downloaded',
        'DownloadFailed',
        'Downloading',
        'Idle',
        'InstallationFailed',
        'Installing',
        'Installed',
      ]),
    }),
    response: object({}),
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
  GetDiagnostics: {
    request: object(
      { location: string() },
      { retries: integer(), retryInterval: integer(), startTime: dateTime(), stopTime: dateTime() },
    ),
    response: object({}, { fileName: string({ maxLength: 255 }) }),
  },
  UpdateFirmware: {
    request: object(
      { location: string(), retrieveDate: dateTime() },
      { retries: integer(), retryInterval: integer() },
    ),
    response: object({}),
  },
  ClearChargingProfile: {
    request: object(
      {},
      {
        id: integer(),
        connectorId: integer(),
        chargingProfilePurpose: oneOf(['ChargePointMaxProfile', 'TxDefaultProfile', 'TxProfile']),
        stackLevel: integer(),
      },
    ),
    response: object({ status: oneOf(['Accepted', 'Unknown']) }),
  },
  GetCompositeSchedule: {
    request: object(
      { connectorId: integer(), duration: integer() },
      { chargingRateUnit: oneOf(['A', 'W']) },
    ),
    response: object(
      { status: oneOf(['Accepted', 'Rejected']) },
      {
        connectorId: integer(),
        scheduleStart: dateTime(),
        chargingSchedule: ChargingScheduleSchema,
      },
    ),
  },
  SetChargingProfile: {
    request: object({ connectorId: integer(), csChargingProfiles: ChargingProfileSchema }),
    response: object({ status: oneOf(['Accepted', 'Rejected', 'NotSupported']) }),
  },
  CancelReservation: {
    request: object({ reservationId: integer() }),
    response: object({ status: oneOf(['Accepted', 'Rejected']) }),
  },
  ReserveNow: {
    request: object(
      {
        connectorId: integer(),
        expiryDate: dateTime(),
        idTag: IdTokenSchema,
        reservationId: integer(),
      },
      { parentIdTag: IdTokenSchema },
    ),
    response: object({
      status: oneOf(['Accepted', 'Faulted', 'Occupied', 'Rejected', 'Unavailable']),
    }),
  },
  GetLocalListVersion: {
    request: object({}),
    response: object({ listVersion: integer() }),
  },
  SendLocalList: {
    request: object(
      { listVersion: integer(), updateType: oneOf(['Differential', 'Full']) },
      {
        localAuthorizationList: array(
          object({ idTag: IdTokenSchema }, { idTagInfo: IdTagInfoSchema }),
        ),
      },
    ),
    response: object({ status: oneOf(['Accepted', 'Failed', 'NotSupported', 'VersionMismatch']) }),
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
      { idTag: IdTokenSchema },
      { connectorId: integer(), chargingProfile: ChargingProfileSchema },
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
  'DiagnosticsStatusNotification',
  'FirmwareStatusNotification',
  'Heartbeat',
  'MeterValues',
  'StartTransaction',
  'StatusNotification',
  'StopTransaction',
] as const satisfies readonly Ocpp16Action[];

/** Actions the charge point accepts from the CSMS in M1. */
export const CSMS_ACTIONS = [
  'CancelReservation',
  'ChangeAvailability',
  'ChangeConfiguration',
  'ClearCache',
  'ClearChargingProfile',
  'DataTransfer',
  'GetCompositeSchedule',
  'GetConfiguration',
  'GetDiagnostics',
  'GetLocalListVersion',
  'RemoteStartTransaction',
  'RemoteStopTransaction',
  'ReserveNow',
  'Reset',
  'SendLocalList',
  'SetChargingProfile',
  'TriggerMessage',
  'UnlockConnector',
  'UpdateFirmware',
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
