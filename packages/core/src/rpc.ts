/**
 * The charge point side of OCPP-J request / response handling for one
 * connection. Pure: text comes in through `receive()` and goes out through
 * the `send` callback, and timeouts run on the injected `Clock`.
 *
 * - `call()` validates our own request, sends it, and resolves with the
 *   validated response, a CALLERROR, a timeout, or `Closed`. It never
 *   rejects. At most one CALL is unanswered at a time; later calls queue.
 * - Incoming CALLs go to the registered handler for their action. Unknown
 *   actions get NotImplemented, 1.6 actions without a handler NotSupported,
 *   invalid payloads the validation error code, failing handlers
 *   InternalError.
 */
import type { Clock, TimerHandle } from './clock.js';
import type { IdGenerator } from './ids.js';
import { MessageTypeId, OCPP16_ACTION_NAMES, type RpcErrorCode } from './ocpp16.js';
import {
  CHARGE_POINT_ACTIONS,
  CSMS_ACTIONS,
  validateRequest,
  validateResponse,
  type RequestOf,
  type ResponseOf,
} from './ocpp16-messages.js';
import { parseFrame, serializeFrame, type Frame, type JsonObject } from './ocppj.js';
import type { ValidationIssue } from './schema.js';

export type ChargePointAction = (typeof CHARGE_POINT_ACTIONS)[number];
export type CsmsAction = (typeof CSMS_ACTIONS)[number];

export type CallFailure =
  | { kind: 'CallError'; errorCode: string; errorDescription: string; errorDetails: JsonObject }
  | { kind: 'Timeout' }
  /** The CSMS answered with a payload that breaks the 1.6 definition. */
  | { kind: 'InvalidResponse'; issues: ValidationIssue[]; payload: JsonObject }
  /** Our own request broke the 1.6 definition, so it was not sent. */
  | { kind: 'InvalidRequest'; issues: ValidationIssue[] }
  | { kind: 'Closed' };

export type CallOutcome<A extends ChargePointAction> =
  { ok: true; payload: ResponseOf<A> } | { ok: false; failure: CallFailure };

export type CsmsHandlers = {
  [A in CsmsAction]?: (request: RequestOf<A>) => ResponseOf<A> | Promise<ResponseOf<A>>;
};

/** Everything worth logging; the engine feeds these to the event recorder. */
export type RpcEvent =
  | { type: 'sent'; text: string }
  | { type: 'received'; text: string }
  | { type: 'invalid-frame'; text: string; reason: string; message: string }
  | { type: 'unmatched-response'; id: string }
  | { type: 'timeout'; id: string; action: ChargePointAction }
  | { type: 'handler-error'; action: CsmsAction; message: string };

export interface RpcOptions {
  clock: Clock;
  ids: IdGenerator;
  send: (text: string) => void;
  handlers?: CsmsHandlers;
  /**
   * Whether the station handles an action now, for example because it
   * advertises the action's feature profile. Unsupported actions are answered
   * with CALLERROR NotSupported. Default: every action with a handler.
   */
  supports?: (action: CsmsAction) => boolean;
  /** How long to wait for an answer to a CALL. Default 30 s. */
  callTimeoutMs?: number;
  onEvent?: (event: RpcEvent) => void;
}

export interface Rpc {
  call<A extends ChargePointAction>(action: A, payload: RequestOf<A>): Promise<CallOutcome<A>>;
  receive(text: string): void;
  /** Ends every pending and queued call with `Closed`; later calls end the same way. */
  close(): void;
}

interface QueuedCall {
  action: ChargePointAction;
  payload: JsonObject;
  finish: (outcome: CallOutcome<ChargePointAction>) => void;
}

interface PendingCall extends QueuedCall {
  id: string;
  timer: TimerHandle;
}

const ALL_ACTIONS = new Set<string>(OCPP16_ACTION_NAMES);
const CSMS_ACTION_SET = new Set<string>(CSMS_ACTIONS);

function describeIssues(issues: ValidationIssue[]): string {
  const [first] = issues;
  return first === undefined ? 'invalid payload' : `${first.path}: ${first.message}`;
}

export function createRpc(options: RpcOptions): Rpc {
  const { clock, ids, handlers = {}, callTimeoutMs = 30_000 } = options;
  const emit = options.onEvent ?? (() => {});
  const queue: QueuedCall[] = [];
  let pending: PendingCall | undefined;
  let closed = false;

  function sendFrame(frame: Frame): void {
    const text = serializeFrame(frame);
    emit({ type: 'sent', text });
    options.send(text);
  }

  function sendError(
    id: string,
    errorCode: RpcErrorCode,
    description: string,
    details: JsonObject = {},
  ): void {
    sendFrame({
      type: MessageTypeId.CallError,
      id,
      errorCode,
      errorDescription: description,
      errorDetails: details,
    });
  }

  function sendNext(): void {
    if (pending !== undefined || closed) return;
    const next = queue.shift();
    if (next === undefined) return;
    const id = ids();
    const timer = clock.setTimer(callTimeoutMs, () => {
      if (pending?.id !== id) return;
      emit({ type: 'timeout', id, action: next.action });
      complete({ ok: false, failure: { kind: 'Timeout' } });
    });
    pending = { ...next, id, timer };
    sendFrame({ type: MessageTypeId.Call, id, action: next.action, payload: next.payload });
  }

  function complete(outcome: CallOutcome<ChargePointAction>): void {
    const done = pending;
    if (done === undefined) return;
    clock.clearTimer(done.timer);
    pending = undefined;
    done.finish(outcome);
    sendNext();
  }

  function handleResponse(frame: Exclude<Frame, { type: typeof MessageTypeId.Call }>): void {
    if (pending === undefined || pending.id !== frame.id) {
      emit({ type: 'unmatched-response', id: frame.id });
      return;
    }
    if (frame.type === MessageTypeId.CallError) {
      complete({
        ok: false,
        failure: {
          kind: 'CallError',
          errorCode: frame.errorCode,
          errorDescription: frame.errorDescription,
          errorDetails: frame.errorDetails,
        },
      });
      return;
    }
    const validated = validateResponse(pending.action, frame.payload);
    complete(
      validated.ok
        ? { ok: true, payload: validated.value }
        : {
            ok: false,
            failure: { kind: 'InvalidResponse', issues: validated.issues, payload: frame.payload },
          },
    );
  }

  async function handleCall(id: string, action: string, payload: JsonObject): Promise<void> {
    if (!ALL_ACTIONS.has(action)) {
      sendError(id, 'NotImplemented', `unknown action ${action}`);
      return;
    }
    const handler = CSMS_ACTION_SET.has(action)
      ? (handlers[action as CsmsAction] as ((request: unknown) => unknown) | undefined)
      : undefined;
    if (handler === undefined || options.supports?.(action as CsmsAction) === false) {
      sendError(id, 'NotSupported', `${action} is not supported`);
      return;
    }
    const csmsAction = action as CsmsAction;
    const request = validateRequest(csmsAction, payload);
    if (!request.ok) {
      sendError(id, request.errorCode, describeIssues(request.issues), { issues: request.issues });
      return;
    }

    let response: unknown;
    try {
      response = await handler(request.value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: 'handler-error', action: csmsAction, message });
      if (!closed) sendError(id, 'InternalError', message);
      return;
    }
    if (closed) return;
    const checked = validateResponse(csmsAction, response);
    if (!checked.ok) {
      const message = `handler returned an invalid response: ${describeIssues(checked.issues)}`;
      emit({ type: 'handler-error', action: csmsAction, message });
      sendError(id, 'InternalError', message);
      return;
    }
    sendFrame({ type: MessageTypeId.CallResult, id, payload: checked.value as JsonObject });
  }

  return {
    call<A extends ChargePointAction>(action: A, payload: RequestOf<A>): Promise<CallOutcome<A>> {
      if (closed) return Promise.resolve({ ok: false, failure: { kind: 'Closed' } });
      const request = validateRequest(action, payload);
      if (!request.ok) {
        return Promise.resolve({
          ok: false,
          failure: { kind: 'InvalidRequest', issues: request.issues },
        });
      }
      return new Promise((resolve) => {
        queue.push({
          action,
          payload: payload as JsonObject,
          finish: resolve as (outcome: CallOutcome<ChargePointAction>) => void,
        });
        sendNext();
      });
    },

    receive(text: string): void {
      if (closed) return;
      emit({ type: 'received', text });
      const parsed = parseFrame(text);
      if (!parsed.ok) {
        const { error } = parsed;
        emit({ type: 'invalid-frame', text, reason: error.reason, message: error.message });
        if (error.replyWith !== undefined && error.id !== undefined) {
          sendError(error.id, error.replyWith, error.message);
        }
        return;
      }
      const { frame } = parsed;
      if (frame.type === MessageTypeId.Call) {
        void handleCall(frame.id, frame.action, frame.payload);
      } else {
        handleResponse(frame);
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      const ended = [...(pending ? [pending] : []), ...queue.splice(0)];
      if (pending !== undefined) clock.clearTimer(pending.timer);
      pending = undefined;
      for (const call of ended) call.finish({ ok: false, failure: { kind: 'Closed' } });
    },
  };
}
