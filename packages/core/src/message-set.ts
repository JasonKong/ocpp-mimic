/**
 * A message set: everything the RPC layer needs to know about one OCPP
 * version. The actions each side sends, how payloads are validated, and how
 * the version spells its error codes. One set per version; a station uses
 * the set of its persona's version.
 */
import { OCPP16_SUBPROTOCOL, RPC_ERROR_CODES, type RpcErrorCode } from './ocpp16.js';
import {
  CHARGE_POINT_ACTIONS,
  CSMS_ACTIONS,
  isOcpp16Action,
  OCPP16_MESSAGES,
  type Ocpp16Action,
  type RequestOf,
  type ResponseOf,
} from './ocpp16-messages.js';
import { OCPP201_RPC_ERROR_CODES, OCPP201_SUBPROTOCOL } from './ocpp201/constants.js';
import {
  isOcpp201Action,
  OCPP201_CHARGING_STATION_ACTIONS,
  OCPP201_CSMS_ACTIONS,
  validateOcpp201Request,
  validateOcpp201Response,
  type Ocpp201Action,
  type Ocpp201RequestOf,
  type Ocpp201ResponseOf,
} from './ocpp201/messages.js';
import { validate, type Schema, type ValidationResult } from './schema.js';

export type OcppVersion = '1.6' | '2.0.1';
export const OCPP_VERSIONS = ['1.6', '2.0.1'] as const satisfies readonly OcppVersion[];

/**
 * The error codes the RPC layer itself raises, in their 1.6 spelling; a set
 * renames them for its version.
 */
export type RpcErrorName = RpcErrorCode | 'MessageTypeNotSupported';

export interface MessageSet {
  readonly version: OcppVersion;
  readonly subprotocol: string;
  /** Whether `action` is an action of this version at all. */
  isAction(action: string): boolean;
  /** Actions a charging station sends. */
  readonly chargingStationActions: readonly string[];
  /** Actions the CSMS sends to a charging station. */
  readonly csmsActions: readonly string[];
  /** Every error code a CALLERROR may carry in this version. */
  readonly errorCodes: readonly string[];
  validateRequest(action: string, payload: unknown): ValidationResult<unknown>;
  validateResponse(action: string, payload: unknown): ValidationResult<unknown>;
  /** The version's spelling of an error code (2.0.1 writes FormatViolation, not FormationViolation). */
  errorCode(code: RpcErrorName): string;
  /**
   * Whether a message with an unknown message type id is answered with
   * MessageTypeNotSupported (2.0.1) or ignored (1.6).
   */
  readonly answersUnknownMessageType: boolean;
}

/** OCPP 1.6J, with the Security Whitepaper's messages. */
export const OCPP16_MESSAGE_SET: MessageSet = {
  version: '1.6',
  subprotocol: OCPP16_SUBPROTOCOL,
  isAction: isOcpp16Action,
  chargingStationActions: CHARGE_POINT_ACTIONS,
  csmsActions: CSMS_ACTIONS,
  errorCodes: RPC_ERROR_CODES,
  validateRequest: (action, payload) =>
    validate(OCPP16_MESSAGES[action as Ocpp16Action].request as Schema<unknown>, payload),
  validateResponse: (action, payload) =>
    validate(OCPP16_MESSAGES[action as Ocpp16Action].response as Schema<unknown>, payload),
  // 1.6 has no MessageTypeNotSupported; unknown message types are not answered.
  errorCode: (code) => code,
  answersUnknownMessageType: false,
};

const RENAMED_201: Partial<Record<RpcErrorName, string>> = {
  FormationViolation: 'FormatViolation',
  OccurenceConstraintViolation: 'OccurrenceConstraintViolation',
};

/** OCPP 2.0.1. */
export const OCPP201_MESSAGE_SET: MessageSet = {
  version: '2.0.1',
  subprotocol: OCPP201_SUBPROTOCOL,
  isAction: isOcpp201Action,
  chargingStationActions: OCPP201_CHARGING_STATION_ACTIONS,
  csmsActions: OCPP201_CSMS_ACTIONS,
  errorCodes: OCPP201_RPC_ERROR_CODES,
  validateRequest: (action, payload) => validateOcpp201Request(action as Ocpp201Action, payload),
  validateResponse: (action, payload) => validateOcpp201Response(action as Ocpp201Action, payload),
  errorCode: (code) => RENAMED_201[code] ?? code,
  answersUnknownMessageType: true,
};

export const MESSAGE_SETS: Readonly<Record<OcppVersion, MessageSet>> = {
  '1.6': OCPP16_MESSAGE_SET,
  '2.0.1': OCPP201_MESSAGE_SET,
};

/** The message set of a WebSocket subprotocol, if it is one ocpp-mimic speaks. */
export function messageSetForSubprotocol(subprotocol: string): MessageSet | undefined {
  return Object.values(MESSAGE_SETS).find((set) => set.subprotocol === subprotocol);
}

// ---- Compile-time view of a message set, for typed RPC calls --------------

/** The payload types of one version, seen from the charging station's side. */
export interface RpcTypes {
  /** Actions the station sends. */
  out: string;
  /** Actions the station answers. */
  in: string;
  requests: Record<string, unknown>;
  responses: Record<string, unknown>;
}

export interface Ocpp16RpcTypes extends RpcTypes {
  out: (typeof CHARGE_POINT_ACTIONS)[number];
  in: (typeof CSMS_ACTIONS)[number];
  requests: { [A in Ocpp16Action]: RequestOf<A> };
  responses: { [A in Ocpp16Action]: ResponseOf<A> };
}

export interface Ocpp201RpcTypes extends RpcTypes {
  out: (typeof OCPP201_CHARGING_STATION_ACTIONS)[number];
  in: (typeof OCPP201_CSMS_ACTIONS)[number];
  requests: { [A in Ocpp201Action]: Ocpp201RequestOf<A> };
  responses: { [A in Ocpp201Action]: Ocpp201ResponseOf<A> };
}
