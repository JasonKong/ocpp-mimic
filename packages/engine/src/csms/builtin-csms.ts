/**
 * The built-in test CSMS, used by scenarios (`csms: builtin`) and the
 * integration tests. It accepts OCPP 1.6J, 2.0.1 and 2.1 connections on
 * `/ocpp/<chargeBoxId>` (the subprotocol the station offers), answers every
 * charge point request with a sensible default for its version (or a custom
 * handler, or a reply set per station with setReply), records all frames,
 * and can send CALLs to the charge point.
 */
import { createServer, type IncomingMessage, type RequestListener } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import { createTokenCheck, UNAUTHORIZED } from '../api-token.js';
import {
  MessageTypeId,
  messageSetForSubprotocol,
  OCPP16_SUBPROTOCOL,
  OCPP201_SUBPROTOCOL,
  OCPP21_SUBPROTOCOL,
  isOcpp2,
  parseFrame,
  type MessageSet,
  type OcppVersion,
  serializeFrame,
  sequentialIds,
  createSessionTracker,
  VERSION,
  priceSession,
  type ReferenceTariff,
  type SessionFrame,
  type CallFrame,
  type CallResultErrorFrame,
  type Frame,
  type SendFrame,
  type JsonObject,
  checkTotpV1,
  OCPP16_CSMS_INITIATED,
  OCPP201_CSMS_ACTIONS,
  OCPP21_CSMS_ACTIONS,
  parseWebPaymentUrl,
} from '@ocpp-mimic/core';
import { hmacSha256 } from '../hmac.js';
import { WebSocketServer, type WebSocket } from 'ws';
import { signCsr } from '../x509.js';

/** Returned by a handler to answer with a CALLERROR instead of a CALLRESULT. */
export class CallErrorReply {
  constructor(
    readonly errorCode: string,
    readonly errorDescription = '',
  ) {}
}

export type CsmsHandler = (
  payload: JsonObject,
  connection: BuiltinCsmsConnection,
) => JsonObject | CallErrorReply | Promise<JsonObject | CallErrorReply>;

/** A reply set for a station's calls of one action: a payload, a CALLERROR, or no answer. */
export type CsmsReply =
  { payload: JsonObject } | { error: string; description?: string } | { ignore: true };

interface ReplyOverride {
  reply: CsmsReply;
  /** Calls left to answer this way; undefined means all of them. */
  remaining?: number;
}

/** A control API answer: HTTP status and JSON body. */
type ControlAnswer = [number, Record<string, unknown>];
type ControlCommand = (
  connection: BuiltinCsmsConnection,
  body: Record<string, unknown>,
) => ControlAnswer | Promise<ControlAnswer>;

/** The payment URL template a 2.1 station starts with (its WebPaymentsCtrlr.URLTemplate). */
const DEFAULT_TEMPLATE = 'https://pay.example.com/{chargingstationid}/{evse}/{totp}/{version}';

/** What the CSMS keeps per 2.1 station: what it set, and what it answers with. */
interface Station21 {
  /** Dynamic profiles by id, with their current values (K28: PullDynamicScheduleUpdate). */
  dynamic: Map<number, JsonObject>;
  /** A limit for the next TransactionEventResponse (E16.FR.02, C25.FR.24). */
  limit?: { transactionId?: string; transactionLimit: JsonObject };
  /** A tariff for the driver in Authorize answers (I08). */
  driverTariff?: JsonObject;
  /** WebPaymentsCtrlr values the CSMS set, to check payment URLs with (C25). */
  sharedSecret?: string;
  validityS?: number;
  urlTemplate?: string;
}

/** Serving wss:// (Security Profiles 2 and 3). */
export interface BuiltinCsmsTls {
  /** Server certificate and key (PEM). */
  cert: string | Buffer;
  key: string | Buffer;
  /** CA certificates (PEM) that client certificates must be signed by. */
  ca?: string | Buffer;
  /**
   * `none` (default): no client certificates. `optional`: asked for and
   * reported on the connection. `required`: the TLS handshake fails without a
   * valid one (Security Profile 3).
   */
  clientCertificates?: 'none' | 'optional' | 'required';
}

export interface BuiltinCsmsOptions {
  port?: number;
  host?: string;
  /**
   * Handlers by action; they replace the defaults for those actions, for
   * stations of either version (`connection.ocpp` tells them apart).
   */
  handlers?: Record<string, CsmsHandler>;
  /** Accepts or refuses (HTTP 401) a connection, given its Authorization header. */
  authorize?: (chargeBoxId: string, authorization: string | undefined) => boolean;
  /**
   * Basic Auth passwords by chargeBoxId: a listed station must present its
   * password or is refused with HTTP 401; other stations need none.
   */
  passwords?: Record<string, string>;
  /** A Basic Auth password for every station not listed in `passwords`. */
  password?: string;
  /** Serve wss:// with TLS 1.2 or above instead of ws://. */
  tls?: BuiltinCsmsTls;
  /**
   * A CA (PEM certificate and key) that signs the CSRs of SignCertificate:
   * the CSMS accepts the request and sends the signed certificate with
   * CertificateSigned shortly after. Without it SignCertificate is Rejected.
   */
  certificateAuthority?: { certificate: string; key: string };
  /**
   * Keep every frame a station sends on its connection (`received`, used by
   * `waitForCall`). Default true; a long load run turns it off so memory
   * stays flat.
   */
  keepFrames?: boolean;
  /** Answers each station CALL after a random delay in this range (milliseconds). */
  responseDelay?: { minMs: number; maxMs: number };
  /** The heartbeat interval (seconds) BootNotification answers with. Default 60. */
  heartbeatInterval?: number;
  /**
   * idTags (1.6) and idTokens (2.0.1) starting with this are Invalid in the
   * answers to Authorize, StartTransaction and TransactionEvent.
   */
  unknownIdTagPrefix?: string;
  /**
   * Serve the control API on the same port (default true): `GET /api/health`
   * and `POST /api/stations/:id/remote-start`, so a test tool such as the
   * engine's Web UI can make the CSMS start a session remotely.
   */
  controlApi?: boolean;
  /** Require `Authorization: Bearer <token>` on the control API, except `/api/health`. */
  apiToken?: string;
  /**
   * Price 2.0.1 sessions with this tariff: TransactionEvent answers carry the
   * running (and finally the total) cost, and CostUpdated goes out every
   * `costUpdatedEveryMs` (default 60 s) for running transactions.
   */
  tariff?: ReferenceTariff;
  costUpdatedEveryMs?: number;
  /**
   * Send `tariff` to 2.1 stations as their default tariff (SetDefaultTariff
   * on EVSE 0) after each accepted boot, so they price sessions themselves.
   */
  installTariff?: boolean;
}

/** The token the CSMS starts sessions with when it starts them on plug-in. */
export interface AutoStartToken {
  idToken: string;
  /** 2.x IdTokenType type; default Central. */
  type?: string;
}

/**
 * The connector states a station call reports: StatusNotification (1.6 and
 * 2.x) and 2.1's NotifyEvent on Connector.AvailabilityState. `id` is the 1.6
 * connectorId or the 2.x evseId.
 */
export function reportedStatuses(
  ocpp: OcppVersion,
  action: string,
  payload: JsonObject,
): { id: number; status: string }[] {
  if (action === 'StatusNotification') {
    const id = Number(ocpp === '1.6' ? payload.connectorId : payload.evseId);
    const status = ocpp === '1.6' ? payload.status : payload.connectorStatus;
    return Number.isInteger(id) && id > 0 && typeof status === 'string' ? [{ id, status }] : [];
  }
  if (action !== 'NotifyEvent' || !Array.isArray(payload.eventData)) return [];
  return (payload.eventData as JsonObject[]).flatMap((event) => {
    const component = event.component as JsonObject | undefined;
    const variable = event.variable as JsonObject | undefined;
    const id = Number((component?.evse as JsonObject | undefined)?.id);
    if (
      component?.name !== 'Connector' ||
      variable?.name !== 'AvailabilityState' ||
      !Number.isInteger(id) ||
      id < 1 ||
      typeof event.actualValue !== 'string'
    ) {
      return [];
    }
    return [{ id, status: event.actualValue }];
  });
}

/** What `GET /api/health` of the built-in CSMS answers with. */
export const BUILTIN_CSMS_SERVICE = 'ocpp-mimic-csms';

/** Counters over the CSMS's life, for a summary. */
export interface BuiltinCsmsStats {
  /** Connections open now. */
  connected: number;
  /** Connections accepted, and closed, since the start. */
  opened: number;
  closed: number;
  /** Upgrade requests refused (wrong path, password or subprotocol). */
  refused: number;
  /** CALLs received from charge points, by action. */
  callsReceived: Record<string, number>;
  /** Answers sent to those CALLs: CALLRESULTs and CALLERRORs. */
  results: number;
  errors: number;
}

/** The client certificate a charge point presented over TLS. */
export interface ClientCertificate {
  /** Subject fields, e.g. { O: 'ocpp-mimic', CN: 'ocpp-mimic-test-cp' }. */
  subject: Record<string, string>;
  /** Whether it was signed by one of the CSMS's client CAs. */
  authorized: boolean;
}

export interface BuiltinCsmsConnection {
  readonly chargeBoxId: string;
  readonly protocol: string;
  /** The OCPP version the connection speaks. */
  readonly ocpp: OcppVersion;
  /** Headers of the WebSocket upgrade request. */
  readonly headers: IncomingMessage['headers'];
  /** The client certificate, when the connection uses TLS and the station sent one. */
  readonly clientCertificate?: ClientCertificate;
  /** WebSocket pings received from the charge point. */
  readonly pings: number;
  /** Every frame received from the charge point, in order. */
  readonly received: readonly Frame[];
  /**
   * OCPP-J 2.1 frames received from a 2.1 station: SENDs (never answered) and
   * CALLRESULTERRORs (the station could not process an answer of the CSMS).
   */
  readonly unconfirmed: readonly (SendFrame | CallResultErrorFrame)[];
  /** Resolves with the next CALL of `action` not yet returned by an earlier wait. */
  waitForCall(action: string, timeoutMs?: number): Promise<CallFrame>;
  /**
   * Sends a CALL and resolves with the CALLRESULT or CALLERROR frame. With
   * `resultError` (2.1), the CSMS answers the CALLRESULT with a CALLRESULTERROR
   * of that code, as if it could not process it (a fault to test stations with).
   */
  call(
    action: string,
    payload: JsonObject,
    timeoutMs?: number,
    options?: { resultError?: string },
  ): Promise<Frame>;
  /** Sends a WebSocket ping and resolves with whether a pong came back in time. */
  ping(timeoutMs?: number): Promise<boolean>;
  close(): void;
  /** Resolves when the connection closes. */
  readonly closed: Promise<void>;
}

export interface BuiltinCsms {
  /** Base URL; a charge point connects to `${url}/<chargeBoxId>`. */
  readonly url: string;
  /** Resolves with the charge point's current connection; with `previous`, waits for a newer one. */
  waitForConnection(
    chargeBoxId: string,
    timeoutMs?: number,
    previous?: BuiltinCsmsConnection,
  ): Promise<BuiltinCsmsConnection>;
  /**
   * Answers the station's next `times` calls of `action` (all of them when
   * undefined) with `reply` instead of the handler. Replaces an earlier reply
   * for the same station and action.
   */
  setReply(chargeBoxId: string, action: string, reply: CsmsReply, times?: number): void;
  clearReplies(): void;
  /**
   * Starts a session remotely, with this token, whenever an EV is plugged in
   * at the station (as a valet car park's CSMS does); undefined stops that.
   * The station need not be connected yet.
   */
  setAutoStart(chargeBoxId: string, idToken: AutoStartToken | undefined): void;
  stats(): BuiltinCsmsStats;
  stop(): Promise<void>;
}

const now = () => new Date().toISOString();

function defaultHandlers(options: BuiltinCsmsOptions): Record<string, CsmsHandler> {
  let nextTransactionId = 1;
  const interval = options.heartbeatInterval ?? 60;
  const prefix = options.unknownIdTagPrefix;
  const idTagInfo = (idTag: unknown) => ({
    status:
      prefix !== undefined && prefix !== '' && String(idTag).startsWith(prefix)
        ? 'Invalid'
        : 'Accepted',
  });
  return {
    BootNotification: () => ({ status: 'Accepted', currentTime: now(), interval }),
    Heartbeat: () => ({ currentTime: now() }),
    StatusNotification: () => ({}),
    FirmwareStatusNotification: () => ({}),
    DiagnosticsStatusNotification: () => ({}),
    SecurityEventNotification: () => ({}),
    LogStatusNotification: () => ({}),
    SignedFirmwareStatusNotification: () => ({}),
    MeterValues: () => ({}),
    Authorize: (payload) => ({ idTagInfo: idTagInfo(payload.idTag) }),
    StartTransaction: (payload) => ({
      idTagInfo: idTagInfo(payload.idTag),
      transactionId: nextTransactionId++,
    }),
    StopTransaction: () => ({ idTagInfo: { status: 'Accepted' } }),
    DataTransfer: () => ({ status: 'Accepted' }),
  };
}

/** Default answers to a 2.0.1 station's requests. */
function defaultHandlers201(options: BuiltinCsmsOptions): Record<string, CsmsHandler> {
  const interval = options.heartbeatInterval ?? 60;
  const prefix = options.unknownIdTagPrefix;
  const idTokenInfo = (idToken: unknown) => {
    const token = (idToken as { idToken?: unknown } | undefined)?.idToken;
    return {
      status:
        prefix !== undefined && prefix !== '' && String(token).startsWith(prefix)
          ? 'Invalid'
          : 'Accepted',
    };
  };
  const empty: CsmsHandler = () => ({});
  return {
    BootNotification: () => ({ status: 'Accepted', currentTime: now(), interval }),
    Heartbeat: () => ({ currentTime: now() }),
    Authorize: (payload) => ({ idTokenInfo: idTokenInfo(payload.idToken) }),
    // A token in the event is authorized like an Authorize (E01.FR.05 and on).
    TransactionEvent: (payload) =>
      payload.idToken === undefined ? {} : { idTokenInfo: idTokenInfo(payload.idToken) },
    DataTransfer: () => ({ status: 'Accepted' }),
    StatusNotification: empty,
    MeterValues: empty,
    NotifyReport: empty,
    NotifyEvent: empty,
    NotifyCustomerInformation: empty,
    NotifyEVChargingNeeds: () => ({ status: 'Accepted' }),
    SecurityEventNotification: empty,
    FirmwareStatusNotification: empty,
    LogStatusNotification: empty,
    ReportChargingProfiles: empty,
    ReservationStatusUpdate: empty,
  };
}

/** The CSMS commands of a version, for the control API's `call`. */
function csmsActions(ocpp: OcppVersion): ReadonlySet<string> {
  return new Set<string>(
    ocpp === '1.6'
      ? OCPP16_CSMS_INITIATED
      : ocpp === '2.1'
        ? OCPP21_CSMS_ACTIONS
        : OCPP201_CSMS_ACTIONS,
  );
}

/** The values of a schedule period that a ChargingScheduleUpdate carries (K28). */
function scheduleValues(period: JsonObject): JsonObject {
  const keys = [
    'limit',
    'limit_L2',
    'limit_L3',
    'dischargeLimit',
    'dischargeLimit_L2',
    'dischargeLimit_L3',
    'setpoint',
    'setpoint_L2',
    'setpoint_L3',
    'setpointReactive',
    'setpointReactive_L2',
    'setpointReactive_L3',
  ];
  return Object.fromEntries(
    keys.filter((key) => period[key] !== undefined).map((key) => [key, period[key]]),
  ) as JsonObject;
}

/** Waits for `predicate` to hold, re-checking whenever `subscribe` signals a change. */
function waitUntil<T>(
  check: () => T | undefined,
  subscribe: (listener: () => void) => () => void,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const found = check();
  if (found !== undefined) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}`));
    }, timeoutMs);
    const unsubscribe = subscribe(() => {
      const value = check();
      if (value === undefined) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    });
  });
}

/** What a connection needs from its CSMS. */
interface ConnectionContext {
  /** Handlers for the connection's version. */
  handlers: Record<string, CsmsHandler>;
  messages: MessageSet;
  takeOverride: (chargeBoxId: string, action: string) => CsmsReply | undefined;
  onKeyChanged: (chargeBoxId: string, key: string) => void;
  keepFrames: boolean;
  /** Milliseconds to wait before answering a CALL. */
  delay: () => number;
  stats: BuiltinCsmsStats;
  /** Prices 2.0.1 sessions (see BuiltinCsmsOptions.tariff). */
  pricing?: { tariff: ReferenceTariff; everyMs: number };
  /** Sees each CALL the CSMS sent with its answer, to keep what it set. */
  observe: (chargeBoxId: string, action: string, payload: JsonObject, answer: Frame) => void;
  /** Sees each station CALL a handler answered, once the answer is on its way. */
  answered?: (connection: BuiltinCsmsConnection, action: string, payload: JsonObject) => void;
}

function createConnection(
  socket: WebSocket,
  chargeBoxId: string,
  headers: IncomingMessage['headers'],
  clientCertificate: ClientCertificate | undefined,
  context: ConnectionContext,
): BuiltinCsmsConnection {
  const { handlers, takeOverride, stats } = context;
  const received: Frame[] = [];
  const unconfirmed: (SendFrame | CallResultErrorFrame)[] = [];
  let pings = 0;
  socket.on('ping', () => {
    pings += 1;
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const returned = new Set<Frame>();
  const listeners = new Set<() => void>();
  const ids = sequentialIds('csms-');
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  // With a tariff, the CSMS follows each session as a CSMS would, from the frames it sees.
  const pricing = isOcpp2(context.messages.version) ? context.pricing : undefined;
  const tracker =
    pricing === undefined
      ? undefined
      : createSessionTracker({ stationId: chargeBoxId, ocpp: context.messages.version });
  let seq = 0;
  const actionOf = new Map<string, string>();
  const follow = (direction: SessionFrame['direction'], frame: Frame) => {
    if (tracker === undefined) return;
    const record: SessionFrame = {
      seq: ++seq,
      at: new Date().toISOString(),
      direction,
      messageType: frame.type,
      uniqueId: frame.id,
    };
    if (frame.type === MessageTypeId.Call) {
      record.action = frame.action;
      record.payload = frame.payload;
      actionOf.set(frame.id, frame.action);
    } else {
      const action = actionOf.get(frame.id);
      actionOf.delete(frame.id);
      if (action !== undefined) record.action = action;
      if (frame.type === MessageTypeId.CallResult) record.payload = frame.payload;
      else record.errorCode = frame.errorCode;
    }
    tracker.frame(record);
  };
  /** The running cost of a transaction, tax included, as the tariff makes it. */
  const costOf = (transactionId: unknown): number | undefined => {
    const session = tracker?.open().find((s) => s.transactionId === transactionId);
    return session === undefined || pricing === undefined || session.startedAt === undefined
      ? undefined
      : priceSession(session, pricing.tariff, new Date().toISOString()).inclTax;
  };
  const send = (frame: Frame) => {
    follow('csms-to-cp', frame);
    socket.send(serializeFrame(frame));
  };

  const connection: BuiltinCsmsConnection = {
    chargeBoxId,
    protocol: socket.protocol,
    ocpp: context.messages.version,
    headers,
    ...(clientCertificate !== undefined && { clientCertificate }),
    get pings() {
      return pings;
    },
    closed,
    received,
    unconfirmed,
    waitForCall(action, timeoutMs = 2000) {
      return waitUntil(
        () => {
          const frame = received.find(
            (f): f is CallFrame =>
              f.type === MessageTypeId.Call && f.action === action && !returned.has(f),
          );
          if (frame !== undefined) returned.add(frame);
          return frame;
        },
        subscribe,
        timeoutMs,
        `${action} from ${chargeBoxId}`,
      );
    },
    async call(action, payload, timeoutMs = 2000, callOptions = {}) {
      const id = ids();
      send({ type: MessageTypeId.Call, id, action, payload });
      const answer = await waitUntil(
        () => received.find((f) => f.type !== MessageTypeId.Call && f.id === id),
        subscribe,
        timeoutMs,
        `the answer to ${action} (${id})`,
      );
      // 2.1: an answer that breaks its definition gets a CALLRESULTERROR (Part 4, 4.2.3).
      if (answer.type === MessageTypeId.CallResult && context.messages.ocppj21) {
        const checked = context.messages.validateResponse(action, answer.payload);
        if (checked.ok && callOptions.resultError !== undefined) {
          socket.send(
            serializeFrame({
              type: 5,
              id,
              errorCode: callOptions.resultError,
              errorDescription: 'the built-in CSMS refused this answer on purpose',
              errorDetails: {},
            }),
          );
        } else if (!checked.ok) {
          socket.send(
            serializeFrame({
              type: 5,
              id,
              errorCode: checked.errorCode,
              errorDescription: checked.issues[0]?.message ?? 'invalid payload',
              errorDetails: {},
            }),
          );
        }
      }
      context.observe(chargeBoxId, action, payload, answer);
      // Like a real CSMS, take an accepted AuthorizationKey as the new password (A01.FR.03).
      if (
        action === 'ChangeConfiguration' &&
        payload.key === 'AuthorizationKey' &&
        typeof payload.value === 'string' &&
        answer.type === MessageTypeId.CallResult &&
        answer.payload.status === 'Accepted'
      ) {
        context.onKeyChanged(chargeBoxId, payload.value);
      }
      return answer;
    },
    ping(timeoutMs = 500) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          socket.off('pong', onPong);
          resolve(false);
        }, timeoutMs);
        const onPong = () => {
          clearTimeout(timer);
          resolve(true);
        };
        socket.once('pong', onPong);
        socket.ping();
      });
    },
    close() {
      socket.close();
    },
  };

  /** Sends the answer to a station CALL, after the configured delay. */
  const answer = (frame: Frame) => {
    if (frame.type === MessageTypeId.CallError) stats.errors += 1;
    else stats.results += 1;
    const ms = context.delay();
    if (ms <= 0) send(frame);
    else
      setTimeout(() => {
        if (socket.readyState === socket.OPEN) send(frame);
      }, ms);
  };

  if (pricing !== undefined) {
    const timer = setInterval(() => {
      for (const session of tracker?.open() ?? []) {
        if (session.state !== 'running' || typeof session.transactionId !== 'string') continue;
        const totalCost = costOf(session.transactionId);
        if (totalCost === undefined) continue;
        void connection
          .call('CostUpdated', { totalCost, transactionId: session.transactionId }, 10_000)
          .catch(() => {});
      }
    }, pricing.everyMs);
    timer.unref();
    void closed.then(() => clearInterval(timer));
  }

  socket.on('message', async (data) => {
    const parsed = parseFrame(data.toString(), { ocppj21: context.messages.ocppj21 });
    if (!parsed.ok) return;
    const { frame } = parsed;
    if (frame.type === 5 || frame.type === 6) {
      // A SEND is never answered; a CALLRESULTERROR needs no answer either.
      unconfirmed.push(frame);
      listeners.forEach((listener) => listener());
      return;
    }
    follow('cp-to-csms', frame);
    if (context.keepFrames || frame.type !== MessageTypeId.Call) received.push(frame);
    listeners.forEach((listener) => listener());
    if (frame.type !== MessageTypeId.Call) {
      // Answers to the CSMS's own CALLs are only needed until call() takes them.
      if (!context.keepFrames) {
        setTimeout(() => {
          const index = received.indexOf(frame);
          if (index >= 0) received.splice(index, 1);
        }, 0);
      }
      return;
    }
    stats.callsReceived[frame.action] = (stats.callsReceived[frame.action] ?? 0) + 1;

    const override = takeOverride(chargeBoxId, frame.action);
    if (override !== undefined) {
      if ('ignore' in override) return;
      if ('error' in override) {
        answer({
          type: MessageTypeId.CallError,
          id: frame.id,
          errorCode: override.error,
          errorDescription: override.description ?? '',
          errorDetails: {},
        });
      } else {
        answer({ type: MessageTypeId.CallResult, id: frame.id, payload: override.payload });
      }
      return;
    }

    const handler = handlers[frame.action];
    if (handler === undefined) {
      // 2.x tells an action it knows but does not handle from one it does not know.
      const known = isOcpp2(context.messages.version) && context.messages.isAction(frame.action);
      answer({
        type: MessageTypeId.CallError,
        id: frame.id,
        errorCode: known ? 'NotSupported' : 'NotImplemented',
        errorDescription: `the built-in CSMS has no handler for ${frame.action}`,
        errorDetails: {},
      });
      return;
    }
    try {
      const reply = await handler(frame.payload, connection);
      if (reply instanceof CallErrorReply) {
        answer({
          type: MessageTypeId.CallError,
          id: frame.id,
          errorCode: reply.errorCode,
          errorDescription: reply.errorDescription,
          errorDetails: {},
        });
      } else {
        const totalCost =
          frame.action === 'TransactionEvent'
            ? costOf((frame.payload.transactionInfo as JsonObject | undefined)?.transactionId)
            : undefined;
        answer({
          type: MessageTypeId.CallResult,
          id: frame.id,
          payload: totalCost === undefined ? reply : { ...reply, totalCost },
        });
        context.answered?.(connection, frame.action, frame.payload);
      }
    } catch (error) {
      answer({
        type: MessageTypeId.CallError,
        id: frame.id,
        errorCode: 'InternalError',
        errorDescription: error instanceof Error ? error.message : String(error),
        errorDetails: {},
      });
    }
  });

  return connection;
}

export async function startBuiltinCsms(options: BuiltinCsmsOptions = {}): Promise<BuiltinCsms> {
  const { port = 0, host = '127.0.0.1' } = options;
  const authority = options.certificateAuthority;
  const signCertificate: CsmsHandler = (payload, connection) => {
    if (authority === undefined) return { status: 'Rejected' };
    let certificate: string;
    try {
      certificate = signCsr(String(payload.csr), authority);
    } catch {
      return { status: 'Rejected' };
    }
    // The signed certificate follows the answer, as from a CA server (A02 steps 6 to 9).
    setTimeout(() => {
      void connection
        .call(
          'CertificateSigned',
          {
            certificateChain: certificate,
            // 2.0.1 names the certificate it signs when the request did (A02.FR.06).
            ...(isOcpp2(connection.ocpp) &&
              payload.certificateType !== undefined && {
                certificateType: payload.certificateType,
              }),
            // 2.1 echoes the CSR's requestId (A02.FR.25).
            ...(connection.ocpp === '2.1' &&
              payload.requestId !== undefined && { requestId: payload.requestId }),
          },
          5000,
        )
        .catch(() => {});
    }, 50);
    return { status: 'Accepted' };
  };
  const state21 = new Map<string, Station21>();
  const stateOf = (chargeBoxId: string): Station21 => {
    let state = state21.get(chargeBoxId);
    if (state === undefined) {
      state = { dynamic: new Map() };
      state21.set(chargeBoxId, state);
    }
    return state;
  };
  /** Keeps what an accepted CALL set: Dynamic profiles' values, web payment settings. */
  const observe: ConnectionContext['observe'] = (chargeBoxId, action, payload, answer) => {
    if (answer.type !== MessageTypeId.CallResult) return;
    if (action === 'SetChargingProfile' && answer.payload.status === 'Accepted') {
      const profile = payload.chargingProfile as JsonObject | undefined;
      const schedules = profile?.chargingSchedule as JsonObject[] | undefined;
      const period = (schedules?.[0]?.chargingSchedulePeriod as JsonObject[] | undefined)?.[0];
      if (profile?.chargingProfileKind === 'Dynamic' && period !== undefined) {
        stateOf(chargeBoxId).dynamic.set(Number(profile.id), scheduleValues(period));
      }
    }
    if (action === 'UpdateDynamicSchedule' && answer.payload.status === 'Accepted') {
      const update = payload.scheduleUpdate as JsonObject | undefined;
      const values = stateOf(chargeBoxId).dynamic;
      const id = Number(payload.chargingProfileId);
      values.set(id, { ...values.get(id), ...update });
    }
    if (action === 'SetVariables') {
      const results = (answer.payload.setVariableResult as JsonObject[] | undefined) ?? [];
      const data = (payload.setVariableData as JsonObject[] | undefined) ?? [];
      data.forEach((entry, i) => {
        const component = (entry.component as JsonObject | undefined)?.name;
        const variable = (entry.variable as JsonObject | undefined)?.name;
        if (component !== 'WebPaymentsCtrlr' || results[i]?.attributeStatus !== 'Accepted') return;
        const value = String(entry.attributeValue);
        const state = stateOf(chargeBoxId);
        if (variable === 'SharedSecret') state.sharedSecret = value;
        if (variable === 'ValidityTime') state.validityS = Number(value);
        if (variable === 'URLTemplate') state.urlTemplate = value;
      });
    }
  };
  const base201 = defaultHandlers201(options);
  const handlersFor: Record<OcppVersion, Record<string, CsmsHandler>> = {
    '1.6': { ...defaultHandlers(options), SignCertificate: signCertificate, ...options.handlers },
    '2.0.1': {
      ...base201,
      SignCertificate: signCertificate,
      ...options.handlers,
    },
    // 2.1 stations get the 2.0.1 answers and the 2.1 ones.
    '2.1': {
      ...base201,
      // I07: with installTariff, the reference tariff becomes the station's default tariff
      // once the boot answer (and any response delay) is through.
      BootNotification: async (payload, connection) => {
        const answer = (await base201.BootNotification?.(payload, connection)) as JsonObject;
        const tariff = options.tariff;
        if (
          options.installTariff === true &&
          tariff !== undefined &&
          answer.status === 'Accepted'
        ) {
          setTimeout(
            () => {
              void connection
                .call(
                  'SetDefaultTariff',
                  { evseId: 0, tariff: tariff as unknown as JsonObject },
                  10_000,
                )
                .catch(() => {});
            },
            (options.responseDelay?.maxMs ?? 0) + 100,
          ).unref();
        }
        return answer;
      },
      // I08: a driver tariff set for the station goes with an accepted token.
      Authorize: async (payload, connection) => {
        const answer = (await base201.Authorize?.(payload, connection)) as JsonObject;
        const tariff = state21.get(connection.chargeBoxId)?.driverTariff;
        const accepted = (answer.idTokenInfo as JsonObject | undefined)?.status === 'Accepted';
        return tariff !== undefined && accepted ? { ...answer, tariff } : answer;
      },
      // E16.FR.02: a queued limit goes with the next answer for its transaction.
      TransactionEvent: async (payload, connection) => {
        const answer = (await base201.TransactionEvent?.(payload, connection)) as JsonObject;
        const state = state21.get(connection.chargeBoxId);
        const queued = state?.limit;
        const transactionId = (payload.transactionInfo as JsonObject | undefined)?.transactionId;
        if (
          state === undefined ||
          queued === undefined ||
          payload.eventType === 'Ended' ||
          (queued.transactionId !== undefined && queued.transactionId !== transactionId)
        ) {
          return answer;
        }
        delete state.limit;
        return { ...answer, transactionLimit: queued.transactionLimit };
      },
      // K21: acknowledged. K28: the profile's current values, as the CSMS last set them.
      NotifyPriorityCharging: () => ({}),
      PullDynamicScheduleUpdate: (payload, connection) => {
        const values = state21
          .get(connection.chargeBoxId)
          ?.dynamic.get(Number(payload.chargingProfileId));
        return values === undefined
          ? { status: 'Rejected', statusInfo: { reasonCode: 'NotFound' } }
          : { status: 'Accepted', scheduleUpdate: values };
      },
      // C21, C22: the settlement is noted; the station gives the receipt.
      NotifySettlement: () => ({}),
      // C18.FR.09, .10: a number of 2 letters and 2 to 18 digits or letters is valid,
      // and belongs to a test company; the EVSE comes back as it was asked.
      VatNumberValidation: (payload) => {
        const vatNumber = String(payload.vatNumber);
        const valid = /^[A-Z]{2}[0-9A-Z]{2,18}$/.test(vatNumber);
        return {
          vatNumber,
          status: valid ? 'Accepted' : 'Rejected',
          ...(typeof payload.evseId === 'number' && { evseId: payload.evseId }),
          ...(valid && {
            company: {
              name: 'Test Company Ltd',
              address1: '1 Test Street',
              city: 'Testville',
              country: vatNumber.slice(0, 2),
            },
          }),
        };
      },
      SignCertificate: signCertificate,
      ...options.handlers,
    },
  };
  const connections = new Map<string, BuiltinCsmsConnection>();
  const listeners = new Set<() => void>();
  const stats: BuiltinCsmsStats = {
    connected: 0,
    opened: 0,
    closed: 0,
    refused: 0,
    callsReceived: {},
    results: 0,
    errors: 0,
  };
  /** `${chargeBoxId} ${action}` → the reply that replaces the handler. */
  const overrides = new Map<string, ReplyOverride>();
  const takeOverride = (chargeBoxId: string, action: string): CsmsReply | undefined => {
    const key = `${chargeBoxId} ${action}`;
    const override = overrides.get(key);
    if (override === undefined) return undefined;
    if (override.remaining !== undefined) {
      override.remaining -= 1;
      if (override.remaining <= 0) overrides.delete(key);
    }
    return override.reply;
  };

  // The first subprotocol the station offers that the CSMS speaks.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      [...protocols].find((protocol) => messageSetForSubprotocol(protocol) !== undefined) ?? false,
  });
  let remoteStartIds = 0;
  /** Stations the CSMS starts sessions on as EVs are plugged in (setAutoStart). */
  const autoStarts = new Map<string, AutoStartToken>();
  /** `${chargeBoxId} ${id}` of connectors started that way, until they report another state. */
  const autoStarted = new Set<string>();
  /** The control API's commands, `POST /api/stations/:id/<command>`. */
  const commands: Record<string, ControlCommand> = {
    // Starts a session as a third-party app would (M6).
    'remote-start': async (connection, body) => {
      const token = body.idToken as Record<string, unknown> | undefined;
      const evseId = body.evseId;
      if (typeof token?.idToken !== 'string' || token.idToken === '') {
        return [400, { error: '"idToken" needs an idToken string' }];
      }
      if (evseId !== undefined && !(Number.isInteger(evseId) && Number(evseId) > 0)) {
        return [400, { error: '"evseId" must be a whole number from 1' }];
      }
      const remoteStartId = ++remoteStartIds;
      const [action, payload]: [string, JsonObject] =
        connection.ocpp === '1.6'
          ? [
              'RemoteStartTransaction',
              {
                idTag: token.idToken,
                ...(evseId !== undefined && { connectorId: Number(evseId) }),
              },
            ]
          : [
              'RequestStartTransaction',
              {
                remoteStartId,
                idToken: {
                  idToken: token.idToken,
                  type: typeof token.type === 'string' ? token.type : 'Central',
                },
                ...(evseId !== undefined && { evseId: Number(evseId) }),
              },
            ];
      return relay(connection, action, payload, {
        ...(connection.ocpp !== '1.6' && { remoteStartId }),
      });
    },
    // Stops a session as a third-party app would, by its transaction id.
    'remote-stop': (connection, body) => {
      const id = body.transactionId;
      if (connection.ocpp === '1.6') {
        if (!Number.isInteger(id)) {
          return [400, { error: '"transactionId" must be a whole number on OCPP 1.6' }];
        }
        return relay(connection, 'RemoteStopTransaction', { transactionId: Number(id) });
      }
      if (typeof id !== 'string' || id === '') {
        return [400, { error: `"transactionId" must be a string on OCPP ${connection.ocpp}` }];
      }
      return relay(connection, 'RequestStopTransaction', { transactionId: id });
    },
    // Any command of the station's version, as a CSMS operator would send it.
    call: (connection, body) => {
      const action = body.action;
      if (typeof action !== 'string' || !csmsActions(connection.ocpp).has(action)) {
        return [400, { error: `"action" must be a CSMS command of OCPP ${connection.ocpp}` }];
      }
      const payload = body.payload ?? {};
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return [400, { error: '"payload" must be an object' }];
      }
      return relay(connection, action, payload as JsonObject);
    },
    // 2.1: the reference tariff (or the one given) as a default tariff (I07).
    'default-tariff': (connection, body) => {
      if (connection.ocpp !== '2.1') return only21(connection);
      const tariff = body.tariff ?? options.tariff;
      if (typeof tariff !== 'object' || tariff === null || Array.isArray(tariff)) {
        return [409, { error: 'give a "tariff", or start the CSMS with one' }];
      }
      const evseId = body.evseId ?? 0;
      if (!(Number.isInteger(evseId) && Number(evseId) >= 0)) {
        return [400, { error: '"evseId" must be a whole number from 0' }];
      }
      return relay(connection, 'SetDefaultTariff', {
        evseId: Number(evseId),
        tariff: tariff as JsonObject,
      });
    },
    // 2.1: a limit for the next TransactionEventResponse (E16.FR.02), of one transaction or any.
    'transaction-limit': (connection, body) => {
      if (connection.ocpp !== '2.1') return only21(connection);
      const limit = body.transactionLimit;
      if (typeof limit !== 'object' || limit === null || Array.isArray(limit)) {
        return [400, { error: '"transactionLimit" must be an object' }];
      }
      const transactionId = typeof body.transactionId === 'string' ? body.transactionId : undefined;
      stateOf(connection.chargeBoxId).limit = {
        transactionLimit: limit as JsonObject,
        ...(transactionId !== undefined && { transactionId }),
      };
      return [200, { queued: true }];
    },
    // 2.1: a tariff for the driver in Authorize answers (I08); null removes it.
    'driver-tariff': (connection, body) => {
      if (connection.ocpp !== '2.1') return only21(connection);
      const state = stateOf(connection.chargeBoxId);
      if (body.tariff === null) {
        delete state.driverTariff;
        return [200, { driverTariff: null }];
      }
      if (typeof body.tariff !== 'object' || Array.isArray(body.tariff)) {
        return [400, { error: '"tariff" must be an object or null' }];
      }
      state.driverTariff = body.tariff as JsonObject;
      return [200, { driverTariff: state.driverTariff }];
    },
    // 2.1: the payment page behind the dynamic QR code (C25): checks the TOTP, tells the
    // station a web payment started, and has the URL's limits answered at the start.
    'web-payment': async (connection, body) => {
      if (connection.ocpp !== '2.1') return only21(connection);
      const state = stateOf(connection.chargeBoxId);
      const url = body.url;
      const secret = typeof body.sharedSecret === 'string' ? body.sharedSecret : state.sharedSecret;
      if (typeof url !== 'string') return [400, { error: '"url" must be the payment URL' }];
      if (secret === undefined) {
        return [409, { error: 'give "sharedSecret", or set WebPaymentsCtrlr.SharedSecret first' }];
      }
      const template =
        typeof body.template === 'string' ? body.template : (state.urlTemplate ?? DEFAULT_TEMPLATE);
      const parsed = parseWebPaymentUrl(template, url);
      const totp = parsed?.values.totp;
      const evseId = Number(parsed?.values.evse ?? 0);
      if (parsed === undefined || totp === undefined) {
        return [200, { valid: false, reason: 'the URL does not fit the template' }];
      }
      const valid = checkTotpV1(
        totp,
        { sharedSecret: secret, validityS: state.validityS ?? 30, length: totp.length },
        Date.now(),
        hmacSha256,
      );
      if (!valid) return [200, { valid: false, reason: 'the code is not valid now' }];
      if (Object.keys(parsed.limits).length > 0) {
        state.limit = { transactionLimit: parsed.limits as JsonObject };
      }
      const timeout = Number.isInteger(body.timeout) ? Number(body.timeout) : 60;
      return relay(
        connection,
        'NotifyWebPaymentStarted',
        { evseId, timeout },
        { valid: true, evseId, limits: parsed.limits },
      );
    },
  };
  /** Control API settings, `POST /api/stations/:id/<setting>`: for any station, connected or not. */
  const settings: Record<
    string,
    (chargeBoxId: string, body: Record<string, unknown>) => ControlAnswer
  > = {
    // `{ idToken: { idToken, type? } }` starts sessions on plug-in; `{ idToken: null }` stops that.
    'auto-start': (chargeBoxId, body) => {
      if (body.idToken === null) {
        autoStarts.delete(chargeBoxId);
        return [200, { autoStart: null }];
      }
      const token = body.idToken as Record<string, unknown> | undefined;
      if (
        typeof token?.idToken !== 'string' ||
        token.idToken === '' ||
        (token.type !== undefined && typeof token.type !== 'string')
      ) {
        return [400, { error: '"idToken" needs an idToken string, or is null to stop' }];
      }
      const idToken: AutoStartToken = {
        idToken: token.idToken,
        ...(typeof token.type === 'string' && { type: token.type }),
      };
      autoStarts.set(chargeBoxId, idToken);
      return [200, { autoStart: { idToken } }];
    },
  };
  /**
   * Auto start: an EV plugged in (1.6 Preparing, 2.x Occupied) gets one
   * remote start per plug-in, sent after the station has its answer.
   */
  const answered: ConnectionContext['answered'] = (connection, action, payload) => {
    const token = autoStarts.get(connection.chargeBoxId);
    const plugged = connection.ocpp === '1.6' ? 'Preparing' : 'Occupied';
    for (const { id, status } of reportedStatuses(connection.ocpp, action, payload)) {
      const key = `${connection.chargeBoxId} ${id}`;
      if (status !== plugged) {
        autoStarted.delete(key);
        continue;
      }
      if (token === undefined || autoStarted.has(key)) continue;
      autoStarted.add(key);
      setTimeout(
        () => void commands['remote-start']?.(connection, { idToken: { ...token }, evseId: id }),
        (options.responseDelay?.maxMs ?? 0) + 100,
      ).unref();
    }
  };
  const only21 = (connection: BuiltinCsmsConnection): ControlAnswer => [
    404,
    { error: `${connection.chargeBoxId} speaks OCPP ${connection.ocpp}, not 2.1` },
  ];
  /** Sends a CALL and answers with its result (200), CALLERROR (502) or timeout (504). */
  async function relay(
    connection: BuiltinCsmsConnection,
    action: string,
    payload: JsonObject,
    extra: Record<string, unknown> = {},
  ): Promise<ControlAnswer> {
    try {
      const answer = await connection.call(action, payload, 10_000);
      if (answer.type === MessageTypeId.CallResult) {
        return [200, { action, ...answer.payload, ...extra }];
      }
      if (answer.type === MessageTypeId.CallError) {
        return [502, { action, error: answer.errorCode, description: answer.errorDescription }];
      }
      return [502, { action, error: 'unexpected answer' }];
    } catch (caught) {
      return [504, { action, error: caught instanceof Error ? caught.message : String(caught) }];
    }
  }
  const controlAuthorized = createTokenCheck(options.apiToken);
  const control: RequestListener = (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (options.controlApi === false || !url.pathname.startsWith('/api/')) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      json(200, {
        service: BUILTIN_CSMS_SERVICE,
        version: VERSION,
        protocols: [OCPP16_SUBPROTOCOL, OCPP201_SUBPROTOCOL, OCPP21_SUBPROTOCOL],
      });
      return;
    }
    if (!controlAuthorized(req)) {
      res.writeHead(UNAUTHORIZED.status, UNAUTHORIZED.headers).end(UNAUTHORIZED.body);
      return;
    }
    const match = /^\/api\/stations\/([^/]+)\/([a-z-]+)$/.exec(url.pathname);
    const command = match === null ? undefined : commands[match[2] ?? ''];
    const setting = match === null ? undefined : settings[match[2] ?? ''];
    if (req.method !== 'POST' || match === null || (command ?? setting) === undefined) {
      json(404, { error: 'not found' });
      return;
    }
    const chargeBoxId = decodeURIComponent(match[1] ?? '');
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 64 * 1024) chunks.push(chunk);
    });
    req.on('end', () => {
      void (async () => {
        let body: Record<string, unknown>;
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (typeof value !== 'object' || value === null || Array.isArray(value))
            throw new Error();
          body = value as Record<string, unknown>;
        } catch {
          json(400, { error: 'the body must be a JSON object' });
          return;
        }
        if (setting !== undefined) {
          json(...setting(chargeBoxId, body));
          return;
        }
        const connection = connections.get(chargeBoxId);
        if (connection === undefined || command === undefined) {
          json(404, { error: `${chargeBoxId} is not connected` });
          return;
        }
        const [status, answer] = await command(connection, body);
        json(status, answer);
      })();
    });
  };
  const tls = options.tls;
  const clientCertificates = tls?.clientCertificates ?? 'none';
  const server =
    tls === undefined
      ? createServer(control)
      : createHttpsServer(
          {
            cert: tls.cert,
            key: tls.key,
            ...(tls.ca !== undefined && { ca: tls.ca }),
            minVersion: 'TLSv1.2',
            requestCert: clientCertificates !== 'none',
            rejectUnauthorized: clientCertificates === 'required',
          },
          control,
        );
  const passwords: Record<string, string> = { ...options.passwords };
  const delay = options.responseDelay;
  const context: Omit<ConnectionContext, 'handlers' | 'messages'> = {
    takeOverride,
    onKeyChanged: (chargeBoxId, key) => {
      if (options.passwords !== undefined || options.password !== undefined) {
        passwords[chargeBoxId] = key;
      }
    },
    keepFrames: options.keepFrames ?? true,
    observe,
    answered,
    ...(options.tariff !== undefined && {
      pricing: { tariff: options.tariff, everyMs: options.costUpdatedEveryMs ?? 60_000 },
    }),
    delay: () =>
      delay === undefined ? 0 : delay.minMs + Math.random() * (delay.maxMs - delay.minMs),
    stats,
  };
  const passwordOk = (chargeBoxId: string, authorization: string | undefined) => {
    const password = passwords[chargeBoxId] ?? options.password;
    if (password === undefined) return true;
    const expected = `Basic ${Buffer.from(`${chargeBoxId}:${password}`).toString('base64')}`;
    return authorization === expected;
  };
  const clientCertificateOf = (req: IncomingMessage): ClientCertificate | undefined => {
    if (tls === undefined || clientCertificates === 'none') return undefined;
    const socket = req.socket as TLSSocket;
    const peer = socket.getPeerCertificate();
    if (Object.keys(peer).length === 0) return undefined;
    const subject = Object.fromEntries(
      Object.entries(peer.subject).map(([key, value]) => [key, String(value)]),
    );
    return { subject, authorized: socket.authorized };
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = /^\/ocpp\/([^/?]+)$/.exec(new URL(req.url ?? '/', 'http://x').pathname);
    if (match?.[1] === undefined) {
      stats.refused += 1;
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const chargeBoxId = decodeURIComponent(match[1]);
    const clientCertificate = clientCertificateOf(req);
    // A trusted client certificate authenticates the station instead of a password (profile 3).
    const certified = clientCertificate?.authorized === true;
    if (
      (!certified && !passwordOk(chargeBoxId, req.headers.authorization)) ||
      (options.authorize !== undefined &&
        !options.authorize(chargeBoxId, req.headers.authorization))
    ) {
      stats.refused += 1;
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const messages = messageSetForSubprotocol(ws.protocol);
      if (messages === undefined) {
        stats.refused += 1;
        ws.close(
          1002,
          `${OCPP16_SUBPROTOCOL}, ${OCPP201_SUBPROTOCOL} or ${OCPP21_SUBPROTOCOL} subprotocol required`,
        );
        return;
      }
      const connection = createConnection(ws, chargeBoxId, req.headers, clientCertificate, {
        ...context,
        handlers: handlersFor[messages.version],
        messages,
      });
      connections.set(chargeBoxId, connection);
      stats.opened += 1;
      stats.connected += 1;
      ws.on('close', () => {
        stats.closed += 1;
        stats.connected -= 1;
        if (connections.get(chargeBoxId) === connection) connections.delete(chargeBoxId);
      });
      listeners.forEach((listener) => listener());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const { port: boundPort } = server.address() as AddressInfo;

  return {
    url: `${tls === undefined ? 'ws' : 'wss'}://${host}:${boundPort}/ocpp`,
    waitForConnection(chargeBoxId, timeoutMs = 2000, previous) {
      return waitUntil(
        () => {
          const current = connections.get(chargeBoxId);
          return current === previous ? undefined : current;
        },
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        timeoutMs,
        `a connection from ${chargeBoxId}`,
      );
    },
    setReply(chargeBoxId, action, reply, times) {
      overrides.set(`${chargeBoxId} ${action}`, {
        reply,
        ...(times !== undefined && { remaining: times }),
      });
    },
    clearReplies() {
      overrides.clear();
    },
    setAutoStart(chargeBoxId, idToken) {
      if (idToken === undefined) autoStarts.delete(chargeBoxId);
      else autoStarts.set(chargeBoxId, { ...idToken });
    },
    stats() {
      return { ...stats, callsReceived: { ...stats.callsReceived } };
    },
    async stop() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
