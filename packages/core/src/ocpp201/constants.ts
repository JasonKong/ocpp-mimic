/** The WebSocket subprotocol of OCPP 2.0.1 (Part 4). */
export const OCPP201_SUBPROTOCOL = 'ocpp2.0.1';

/** Error codes a CALLERROR may carry in OCPP-J 2.0.1 (Part 4, RPC framework). */
export const OCPP201_RPC_ERROR_CODES = [
  'FormatViolation',
  'GenericError',
  'InternalError',
  'MessageTypeNotSupported',
  'NotImplemented',
  'NotSupported',
  'OccurrenceConstraintViolation',
  'PropertyConstraintViolation',
  'ProtocolError',
  'RpcFrameworkError',
  'SecurityError',
  'TypeConstraintViolation',
] as const;
export type Ocpp201RpcErrorCode = (typeof OCPP201_RPC_ERROR_CODES)[number];
