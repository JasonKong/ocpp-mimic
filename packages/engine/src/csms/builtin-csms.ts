/**
 * The built-in test CSMS, used by scenarios (`csms: builtin`) and the
 * integration tests. It accepts OCPP 1.6J connections on
 * `/ocpp/<chargeBoxId>`, answers every charge point request with a sensible
 * default (or a custom handler, or a reply set per station with setReply),
 * records all frames, and can send CALLs to the charge point.
 */
import { createServer, type IncomingMessage, type RequestListener } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import {
  MessageTypeId,
  OCPP16_SUBPROTOCOL,
  parseFrame,
  serializeFrame,
  sequentialIds,
  type CallFrame,
  type Frame,
  type JsonObject,
} from '@ocpp-mimic/core';
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
  /** Handlers by action; they replace the defaults for those actions. */
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
  /** idTags starting with this are Invalid in Authorize and StartTransaction answers. */
  unknownIdTagPrefix?: string;
}

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
  /** Headers of the WebSocket upgrade request. */
  readonly headers: IncomingMessage['headers'];
  /** The client certificate, when the connection uses TLS and the station sent one. */
  readonly clientCertificate?: ClientCertificate;
  /** WebSocket pings received from the charge point. */
  readonly pings: number;
  /** Every frame received from the charge point, in order. */
  readonly received: readonly Frame[];
  /** Resolves with the next CALL of `action` not yet returned by an earlier wait. */
  waitForCall(action: string, timeoutMs?: number): Promise<CallFrame>;
  /** Sends a CALL and resolves with the CALLRESULT or CALLERROR frame. */
  call(action: string, payload: JsonObject, timeoutMs?: number): Promise<Frame>;
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
  handlers: Record<string, CsmsHandler>;
  takeOverride: (chargeBoxId: string, action: string) => CsmsReply | undefined;
  onKeyChanged: (chargeBoxId: string, key: string) => void;
  keepFrames: boolean;
  /** Milliseconds to wait before answering a CALL. */
  delay: () => number;
  stats: BuiltinCsmsStats;
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
  const send = (frame: Frame) => socket.send(serializeFrame(frame));

  const connection: BuiltinCsmsConnection = {
    chargeBoxId,
    protocol: socket.protocol,
    headers,
    ...(clientCertificate !== undefined && { clientCertificate }),
    get pings() {
      return pings;
    },
    closed,
    received,
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
    async call(action, payload, timeoutMs = 2000) {
      const id = ids();
      send({ type: MessageTypeId.Call, id, action, payload });
      const answer = await waitUntil(
        () => received.find((f) => f.type !== MessageTypeId.Call && f.id === id),
        subscribe,
        timeoutMs,
        `the answer to ${action} (${id})`,
      );
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

  socket.on('message', async (data) => {
    const parsed = parseFrame(data.toString());
    if (!parsed.ok) return;
    const { frame } = parsed;
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
      answer({
        type: MessageTypeId.CallError,
        id: frame.id,
        errorCode: 'NotImplemented',
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
        answer({ type: MessageTypeId.CallResult, id: frame.id, payload: reply });
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
  const handlers: Record<string, CsmsHandler> = {
    ...defaultHandlers(options),
    SignCertificate: (payload, connection) => {
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
          .call('CertificateSigned', { certificateChain: certificate }, 5000)
          .catch(() => {});
      }, 50);
      return { status: 'Accepted' };
    },
    ...options.handlers,
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

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has(OCPP16_SUBPROTOCOL) ? OCPP16_SUBPROTOCOL : false,
  });
  const notFound: RequestListener = (_req, res) => {
    res.writeHead(404).end();
  };
  const tls = options.tls;
  const clientCertificates = tls?.clientCertificates ?? 'none';
  const server =
    tls === undefined
      ? createServer(notFound)
      : createHttpsServer(
          {
            cert: tls.cert,
            key: tls.key,
            ...(tls.ca !== undefined && { ca: tls.ca }),
            minVersion: 'TLSv1.2',
            requestCert: clientCertificates !== 'none',
            rejectUnauthorized: clientCertificates === 'required',
          },
          notFound,
        );
  const passwords: Record<string, string> = { ...options.passwords };
  const delay = options.responseDelay;
  const context: ConnectionContext = {
    handlers,
    takeOverride,
    onKeyChanged: (chargeBoxId, key) => {
      if (options.passwords !== undefined || options.password !== undefined) {
        passwords[chargeBoxId] = key;
      }
    },
    keepFrames: options.keepFrames ?? true,
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
      if (ws.protocol !== OCPP16_SUBPROTOCOL) {
        stats.refused += 1;
        ws.close(1002, 'ocpp1.6 subprotocol required');
        return;
      }
      const connection = createConnection(ws, chargeBoxId, req.headers, clientCertificate, context);
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
