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
