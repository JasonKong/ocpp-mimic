/**
 * OCPP-J framing: the JSON arrays that carry every OCPP message over the
 * WebSocket. Payloads stay untyped here; the RPC layer validates them per
 * action.
 */
import { MessageTypeId, type RpcErrorCode } from './ocpp16.js';

/** OCPP-J limits uniqueIds to 36 characters. */
export const MAX_UNIQUE_ID_LENGTH = 36;

export type JsonObject = { [key: string]: unknown };

export interface CallFrame {
  type: typeof MessageTypeId.Call;
  id: string;
  action: string;
  payload: JsonObject;
}

export interface CallResultFrame {
  type: typeof MessageTypeId.CallResult;
  id: string;
  payload: JsonObject;
}

export interface CallErrorFrame {
  type: typeof MessageTypeId.CallError;
  id: string;
  /** Usually an {@link RpcErrorCode}; kept as a string because a peer may send others. */
  errorCode: string;
  errorDescription: string;
  errorDetails: JsonObject;
}

export type Frame = CallFrame | CallResultFrame | CallErrorFrame;

export type FrameErrorReason =
  'invalid-json' | 'not-an-array' | 'unknown-message-type' | 'invalid-structure';

export interface FrameError {
  reason: FrameErrorReason;
  message: string;
  /** The message's uniqueId, when it could be read. */
  id?: string;
  /**
   * Set only for a broken CALL with a usable uniqueId: the error code to
   * answer it with. Broken responses and unknown message types get no answer.
   */
  replyWith?: RpcErrorCode;
}

export type ParseFrameResult = { ok: true; frame: Frame } | { ok: false; error: FrameError };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUsableId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_UNIQUE_ID_LENGTH;
}

/** Parses one WebSocket text message into a frame. */
export function parseFrame(text: string): ParseFrameResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail({ reason: 'invalid-json', message: 'message is not valid JSON' });
  }
  if (!Array.isArray(data)) {
    return fail({ reason: 'not-an-array', message: 'message is not a JSON array' });
  }

  const [type, id] = data as unknown[];
  if (
    type !== MessageTypeId.Call &&
    type !== MessageTypeId.CallResult &&
    type !== MessageTypeId.CallError
  ) {
    return fail({
      reason: 'unknown-message-type',
      message: `unknown message type id ${JSON.stringify(type)}`,
      ...(isUsableId(id) && { id }),
    });
  }

  const readableId = typeof id === 'string' ? { id } : {};
  if (!isUsableId(id)) {
    return fail({
      reason: 'invalid-structure',
      message: `uniqueId must be a string of 1 to ${MAX_UNIQUE_ID_LENGTH} characters`,
      ...readableId,
    });
  }

  if (type === MessageTypeId.Call) {
    // A broken CALL with a usable uniqueId is answered with a CALLERROR.
    const broken = (message: string) =>
      fail({ reason: 'invalid-structure', message, id, replyWith: 'FormationViolation' });
    const [, , action, payload] = data as unknown[];
    if (data.length !== 4) return broken(`a CALL has 4 elements, got ${data.length}`);
    if (typeof action !== 'string' || action.length === 0) {
      return broken('action must be a non-empty string');
    }
    if (!isJsonObject(payload)) return broken('payload must be a JSON object');
    return { ok: true, frame: { type, id, action, payload } };
  }

  // Broken responses are reported but never answered.
  const broken = (message: string) => fail({ reason: 'invalid-structure', message, id });

  if (type === MessageTypeId.CallResult) {
    const [, , payload] = data as unknown[];
    if (data.length !== 3) return broken(`a CALLRESULT has 3 elements, got ${data.length}`);
    if (!isJsonObject(payload)) return broken('payload must be a JSON object');
    return { ok: true, frame: { type, id, payload } };
  }

  const [, , errorCode, errorDescription, errorDetails] = data as unknown[];
  if (data.length !== 5) return broken(`a CALLERROR has 5 elements, got ${data.length}`);
  if (typeof errorCode !== 'string') return broken('errorCode must be a string');
  if (typeof errorDescription !== 'string') return broken('errorDescription must be a string');
  if (!isJsonObject(errorDetails)) return broken('errorDetails must be a JSON object');
  return { ok: true, frame: { type, id, errorCode, errorDescription, errorDetails } };
}

/** Serializes a frame into the WebSocket text message that carries it. */
export function serializeFrame(frame: Frame): string {
  switch (frame.type) {
    case MessageTypeId.Call:
      return JSON.stringify([frame.type, frame.id, frame.action, frame.payload]);
    case MessageTypeId.CallResult:
      return JSON.stringify([frame.type, frame.id, frame.payload]);
    case MessageTypeId.CallError:
      return JSON.stringify([
        frame.type,
        frame.id,
        frame.errorCode,
        frame.errorDescription,
        frame.errorDetails,
      ]);
  }
}

function fail(error: FrameError): ParseFrameResult {
  return { ok: false, error };
}
