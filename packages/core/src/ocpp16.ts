/** WebSocket subprotocol an OCPP 1.6J charge point offers when it connects. */
export const OCPP16_SUBPROTOCOL = 'ocpp1.6';

/** OCPP-J message type ids: the first element of every frame. */
export const MessageTypeId = {
  Call: 2,
  CallResult: 3,
  CallError: 4,
} as const;
export type MessageTypeId = (typeof MessageTypeId)[keyof typeof MessageTypeId];

/** Error codes a CALLERROR frame may carry (spelling as in the OCPP-J 1.6 spec). */
export const RPC_ERROR_CODES = [
  'NotImplemented',
  'NotSupported',
  'InternalError',
  'ProtocolError',
  'SecurityError',
  'FormationViolation',
  'PropertyConstraintViolation',
  'OccurenceConstraintViolation',
  'TypeConstraintViolation',
  'GenericError',
] as const;
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

/**
 * Every action OCPP 1.6 defines, across all feature profiles. An action in
 * this list that a charge point does not handle is answered with
 * NotSupported; anything else with NotImplemented.
 */
export const OCPP16_ACTION_NAMES = [
  'Authorize',
  'BootNotification',
  'CancelReservation',
  'ChangeAvailability',
  'ChangeConfiguration',
  'ClearCache',
  'ClearChargingProfile',
  'DataTransfer',
  'DiagnosticsStatusNotification',
  'FirmwareStatusNotification',
  'GetCompositeSchedule',
  'GetConfiguration',
  'GetDiagnostics',
  'GetLocalListVersion',
  'Heartbeat',
  'MeterValues',
  'RemoteStartTransaction',
  'RemoteStopTransaction',
  'ReserveNow',
  'Reset',
  'SendLocalList',
  'SetChargingProfile',
  'StartTransaction',
  'StatusNotification',
  'StopTransaction',
  'TriggerMessage',
  'UnlockConnector',
  'UpdateFirmware',
] as const;

export type Ocpp16ActionName = (typeof OCPP16_ACTION_NAMES)[number];

/** Actions a charge point sends to the CSMS. DataTransfer goes both ways. */
export const OCPP16_CHARGE_POINT_INITIATED = [
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
] as const satisfies readonly Ocpp16ActionName[];

/** Actions the CSMS sends to a charge point. */
export const OCPP16_CSMS_INITIATED = OCPP16_ACTION_NAMES.filter(
  (action) => action === 'DataTransfer' || !OCPP16_CHARGE_POINT_INITIATED.some((a) => a === action),
);

/** Connector statuses reported in StatusNotification (OCPP 1.6 ChargePointStatus). */
export const CHARGE_POINT_STATUSES = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEVSE',
  'SuspendedEV',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
] as const;
export type ChargePointStatus = (typeof CHARGE_POINT_STATUSES)[number];

/** Measurands a SampledValue can carry (OCPP 1.6). */
export const MEASURANDS = [
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
] as const;
export type Measurand = (typeof MEASURANDS)[number];
