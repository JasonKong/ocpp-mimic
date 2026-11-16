/**
 * The charge point side of OCPP-J request / response handling for one
 * connection. Pure: text comes in through `receive()` and goes out through
 * the `send` callback, and timeouts run on the injected `Clock`.
 *
 * - `call()` validates our own request, sends it, and resolves with the
 *   validated response, a CALLERROR, a timeout, or `Closed`. It never
 *   rejects. At most one CALL is unanswered at a time; later calls queue.
 * - Incoming CALLs go to the registered handler for their action. Unknown
 *   actions get NotImplemented, known actions without a handler NotSupported,
 *   invalid payloads the validation error code, failing handlers
 *   InternalError.
 *
 * Which actions exist, how payloads are validated and how error codes are
 * spelled come from the message set of the station's OCPP version (default
 * 1.6). The type parameter carries the same set's payload types.
 *
 * OCPP-J 2.1 (sets with `ocppj21`) adds two message types: an invalid
 * CALLRESULT is answered with a CALLRESULTERROR, and `send()` sends an
 * unconfirmed SEND message. A received SEND goes to its handler and is never
 * answered; a received CALLRESULTERROR is only reported.
 */
import type { Clock, TimerHandle } from './clock.js';
import type { IdGenerator } from './ids.js';
import {
  OCPP16_MESSAGE_SET,
  type MessageSet,
  type Ocpp16RpcTypes,
  type RpcErrorName,
  type RpcTypes,
} from './message-set.js';
import { MessageTypeId } from './ocpp16.js';
import type { CHARGE_POINT_ACTIONS, CSMS_ACTIONS, ResponseOf } from './ocpp16-messages.js';
import { parseFrame, serializeFrame, type Frame21, type JsonObject } from './ocppj.js';
import type { ValidationIssue } from './schema.js';

export type ChargePointAction = (typeof CHARGE_POINT_ACTIONS)[number];
export type CsmsAction = (typeof CSMS_ACTIONS)[number];

export type CallFailure =
  | { kind: 'CallError'; errorCode: string; errorDescription: string; errorDetails: JsonObject }
  | { kind: 'Timeout' }
  /** The CSMS answered with a payload that breaks the message definition. */
  | { kind: 'InvalidResponse'; issues: ValidationIssue[]; payload: JsonObject }
  /** Our own request broke the message definition, so it was not sent. */
  | { kind: 'InvalidRequest'; issues: ValidationIssue[] }
  | { kind: 'Closed' };

/**
 * Thrown by a handler to answer with a CALLERROR of this code (in its 1.6
 * spelling; the message set renames it) instead of a result.
 */
export class RpcCallError extends Error {
  constructor(
    readonly errorCode: RpcErrorName,
    message: string,
  ) {
    super(message);
  }
}

/** How a CALL ended: the validated answer, or why there is none. */
export type RpcOutcome<R> = { ok: true; payload: R } | { ok: false; failure: CallFailure };

/** How a 1.6 CALL ended. */
export type CallOutcome<A extends ChargePointAction> = RpcOutcome<ResponseOf<A>>;

/** Handlers for the CSMS's CALLs, by action. */
export type RpcHandlers<T extends RpcTypes> = {
  [A in T['in']]?: (request: T['requests'][A]) => T['responses'][A] | Promise<T['responses'][A]>;
};

/** Handlers for the CSMS's 1.6 CALLs. */
export type CsmsHandlers = RpcHandlers<Ocpp16RpcTypes>;

/** Everything worth logging; the engine feeds these to the event recorder. */
export type RpcEvent =
  | { type: 'sent'; text: string }
  | { type: 'received'; text: string }
  | { type: 'invalid-frame'; text: string; reason: string; message: string }
  | { type: 'unmatched-response'; id: string }
  | { type: 'timeout'; id: string; action: string }
  | { type: 'handler-error'; action: string; message: string }
  /** 2.1: the CSMS could not process our answer to its CALL `id`. */
  | { type: 'call-result-error'; id: string; errorCode: string; errorDescription: string }
  /** 2.1: a SEND that was dropped (unknown action, invalid payload or no handler). */
  | { type: 'send-dropped'; action: string; message: string };

export interface RpcOptions<T extends RpcTypes = Ocpp16RpcTypes> {
  clock: Clock;
  ids: IdGenerator;
  send: (text: string) => void;
  /** The OCPP version's message set; default 1.6. It must match `T`. */
  messages?: MessageSet;
  handlers?: RpcHandlers<T>;
  /**
   * Whether the station handles an action now, for example because it
   * advertises the action's feature profile. Unsupported actions are answered
   * with CALLERROR NotSupported. Default: every action with a handler.
   */
  supports?: (action: T['in']) => boolean;
  /** How long to wait for an answer to a CALL. Default 30 s. */
  callTimeoutMs?: number;
  onEvent?: (event: RpcEvent) => void;
}

export interface Rpc<T extends RpcTypes = Ocpp16RpcTypes> {
  call<A extends T['out']>(
    action: A,
    payload: T['requests'][A],
  ): Promise<RpcOutcome<T['responses'][A]>>;
  receive(text: string): void;
  /**
   * OCPP-J 2.1: sends an unconfirmed message (SEND) right away, even while a
   * CALL is unanswered. False when it was not sent: the version has no SEND,
   * the action is not an unconfirmed one, the payload is invalid, or the
   * connection is closed.
   */
  send<A extends T['out']>(action: A, payload: T['requests'][A]): boolean;
  /** Ends every pending and queued call with `Closed`; later calls end the same way. */
  close(): void;
}

interface QueuedCall {
  action: string;
  payload: JsonObject;
  finish: (outcome: RpcOutcome<unknown>) => void;
}

interface PendingCall extends QueuedCall {
  id: string;
  timer: TimerHandle;
}

function describeIssues(issues: ValidationIssue[]): string {
  const [first] = issues;
  return first === undefined ? 'invalid payload' : `${first.path}: ${first.message}`;
}

export function createRpc<T extends RpcTypes = Ocpp16RpcTypes>(options: RpcOptions<T>): Rpc<T> {
  const { clock, ids, callTimeoutMs = 30_000, messages = OCPP16_MESSAGE_SET } = options;
  const handlers = (options.handlers ?? {}) as Record<string, (request: unknown) => unknown>;
  const answered = new Set(messages.csmsActions);
  const emit = options.onEvent ?? (() => {});
  const queue: QueuedCall[] = [];
  let pending: PendingCall | undefined;
  let closed = false;

  function sendFrame(frame: Frame21): void {
    const text = serializeFrame(frame);
    emit({ type: 'sent', text });
    options.send(text);
  }

  function sendError(
    id: string,
    errorCode: RpcErrorName,
    description: string,
    details: JsonObject = {},
  ): void {
    sendFrame({
      type: MessageTypeId.CallError,
      id,
      errorCode: messages.errorCode(errorCode),
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

  function complete(outcome: RpcOutcome<unknown>): void {
    const done = pending;
    if (done === undefined) return;
    clock.clearTimer(done.timer);
    pending = undefined;
    done.finish(outcome);
    sendNext();
  }

  function handleResponse(
    frame: Extract<
      Frame21,
      { type: typeof MessageTypeId.CallResult | typeof MessageTypeId.CallError }
    >,
  ): void {
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
    const validated = messages.validateResponse(pending.action, frame.payload);
    if (!validated.ok && messages.ocppj21) {
      // 2.1 tells the CSMS that its answer could not be processed (Part 4, 4.2.3).
      sendFrame({
        type: 5,
        id: frame.id,
        errorCode: validated.errorCode,
        errorDescription: describeIssues(validated.issues),
        errorDetails: { issues: validated.issues } as unknown as JsonObject,
      });
    }
    complete(
      validated.ok
        ? { ok: true, payload: validated.value }
        : {
            ok: false,
            failure: { kind: 'InvalidResponse', issues: validated.issues, payload: frame.payload },
          },
    );
  }

  /** A SEND is never answered: it goes to its handler, or is dropped. */
  function handleSend(action: string, payload: JsonObject): void {
    const drop = (message: string) => emit({ type: 'send-dropped', action, message });
    if (!messages.unconfirmedActions.includes(action)) {
      drop(`${action} is not an unconfirmed action`);
      return;
    }
    const handler = handlers[action];
    if (handler === undefined) {
      drop(`no handler for ${action}`);
      return;
    }
    const request = messages.validateRequest(action, payload);
    if (!request.ok) {
      drop(describeIssues(request.issues));
      return;
    }
    try {
      void Promise.resolve(handler(request.value)).catch((error: unknown) =>
        emit({
          type: 'handler-error',
          action,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } catch (error) {
      emit({
        type: 'handler-error',
        action,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleCall(id: string, action: string, payload: JsonObject): Promise<void> {
    if (!messages.isAction(action)) {
      sendError(id, 'NotImplemented', `unknown action ${action}`);
      return;
    }
    const handler = answered.has(action) ? handlers[action] : undefined;
    if (handler === undefined || options.supports?.(action as T['in']) === false) {
      sendError(id, 'NotSupported', `${action} is not supported`);
      return;
    }
    const csmsAction = action;
    const request = messages.validateRequest(csmsAction, payload);
    if (!request.ok) {
      // The set's validators already use the version's spelling.
      sendFrame({
        type: MessageTypeId.CallError,
        id,
        errorCode: request.errorCode,
        errorDescription: describeIssues(request.issues),
        errorDetails: { issues: request.issues } as unknown as JsonObject,
      });
      return;
    }

    let response: unknown;
    try {
      response = await handler(request.value);
    } catch (error) {
      if (error instanceof RpcCallError) {
        if (!closed) sendError(id, error.errorCode, error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: 'handler-error', action: csmsAction, message });
      if (!closed) sendError(id, 'InternalError', message);
      return;
    }
    if (closed) return;
    const checked = messages.validateResponse(csmsAction, response);
    if (!checked.ok) {
      const message = `handler returned an invalid response: ${describeIssues(checked.issues)}`;
      emit({ type: 'handler-error', action: csmsAction, message });
      sendError(id, 'InternalError', message);
      return;
    }
    sendFrame({ type: MessageTypeId.CallResult, id, payload: checked.value as JsonObject });
  }

  return {
    call<A extends T['out']>(
      action: A,
      payload: T['requests'][A],
    ): Promise<RpcOutcome<T['responses'][A]>> {
      if (closed) return Promise.resolve({ ok: false, failure: { kind: 'Closed' } });
      const request = messages.validateRequest(action, payload);
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
          finish: resolve as (outcome: RpcOutcome<unknown>) => void,
        });
        sendNext();
      });
    },

    send<A extends T['out']>(action: A, payload: T['requests'][A]): boolean {
      if (closed || !messages.ocppj21 || !messages.unconfirmedActions.includes(action)) {
        return false;
      }
      if (!messages.validateRequest(action, payload).ok) return false;
      sendFrame({ type: 6, id: ids(), action, payload: payload as JsonObject });
      return true;
    },

    receive(text: string): void {
      if (closed) return;
      emit({ type: 'received', text });
      const parsed = parseFrame(text, { ocppj21: messages.ocppj21 });
      if (!parsed.ok) {
        const { error } = parsed;
        emit({ type: 'invalid-frame', text, reason: error.reason, message: error.message });
        if (error.replyWith !== undefined && error.id !== undefined) {
          sendError(error.id, error.replyWith, error.message);
        } else if (
          error.reason === 'unknown-message-type' &&
          messages.answersUnknownMessageType &&
          error.id !== undefined
        ) {
          sendError(error.id, 'MessageTypeNotSupported', error.message);
        }
        return;
      }
      const { frame } = parsed;
      if (frame.type === MessageTypeId.Call) {
        void handleCall(frame.id, frame.action, frame.payload);
      } else if (frame.type === 6) {
        handleSend(frame.action, frame.payload);
      } else if (frame.type === 5) {
        emit({
          type: 'call-result-error',
          id: frame.id,
          errorCode: frame.errorCode,
          errorDescription: frame.errorDescription,
        });
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
