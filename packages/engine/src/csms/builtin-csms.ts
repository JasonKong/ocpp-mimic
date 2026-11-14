/**
 * The built-in test CSMS, used by scenarios (`csms: builtin`) and the
 * integration tests. It accepts OCPP 1.6J connections on
 * `/ocpp/<chargeBoxId>`, answers every charge point request with a sensible
 * default (or a custom handler, or a reply set per station with setReply),
 * records all frames, and can send CALLs to the charge point.
 */
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
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

export interface BuiltinCsmsOptions {
  port?: number;
  host?: string;
  /** Handlers by action; they replace the defaults for those actions. */
  handlers?: Record<string, CsmsHandler>;
  /** Accepts or refuses (HTTP 401) a connection, given its Authorization header. */
  authorize?: (chargeBoxId: string, authorization: string | undefined) => boolean;
}

export interface BuiltinCsmsConnection {
  readonly chargeBoxId: string;
  readonly protocol: string;
  /** Headers of the WebSocket upgrade request. */
  readonly headers: IncomingMessage['headers'];
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
  stop(): Promise<void>;
}

const now = () => new Date().toISOString();

function defaultHandlers(): Record<string, CsmsHandler> {
  let nextTransactionId = 1;
  return {
    BootNotification: () => ({ status: 'Accepted', currentTime: now(), interval: 60 }),
    Heartbeat: () => ({ currentTime: now() }),
    StatusNotification: () => ({}),
    FirmwareStatusNotification: () => ({}),
    DiagnosticsStatusNotification: () => ({}),
    MeterValues: () => ({}),
    Authorize: () => ({ idTagInfo: { status: 'Accepted' } }),
    StartTransaction: () => ({
      idTagInfo: { status: 'Accepted' },
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

function createConnection(
  socket: WebSocket,
  chargeBoxId: string,
  headers: IncomingMessage['headers'],
  handlers: Record<string, CsmsHandler>,
  takeOverride: (chargeBoxId: string, action: string) => CsmsReply | undefined,
): BuiltinCsmsConnection {
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
    call(action, payload, timeoutMs = 2000) {
      const id = ids();
      send({ type: MessageTypeId.Call, id, action, payload });
      return waitUntil(
        () => received.find((f) => f.type !== MessageTypeId.Call && f.id === id),
        subscribe,
        timeoutMs,
        `the answer to ${action} (${id})`,
      );
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

  socket.on('message', async (data) => {
    const parsed = parseFrame(data.toString());
    if (!parsed.ok) return;
    const { frame } = parsed;
    received.push(frame);
    listeners.forEach((listener) => listener());
    if (frame.type !== MessageTypeId.Call) return;

    const override = takeOverride(chargeBoxId, frame.action);
    if (override !== undefined) {
      if ('ignore' in override) return;
      if ('error' in override) {
        send({
          type: MessageTypeId.CallError,
          id: frame.id,
          errorCode: override.error,
          errorDescription: override.description ?? '',
          errorDetails: {},
        });
      } else {
        send({ type: MessageTypeId.CallResult, id: frame.id, payload: override.payload });
      }
      return;
    }

    const handler = handlers[frame.action];
    if (handler === undefined) {
      send({
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
        send({
          type: MessageTypeId.CallError,
          id: frame.id,
          errorCode: reply.errorCode,
          errorDescription: reply.errorDescription,
          errorDetails: {},
        });
      } else {
        send({ type: MessageTypeId.CallResult, id: frame.id, payload: reply });
      }
    } catch (error) {
      send({
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
  const handlers = { ...defaultHandlers(), ...options.handlers };
  const connections = new Map<string, BuiltinCsmsConnection>();
  const listeners = new Set<() => void>();
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
  const server = createServer((_req, res) => {
    res.writeHead(404).end();
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = /^\/ocpp\/([^/?]+)$/.exec(new URL(req.url ?? '/', 'http://x').pathname);
    if (match?.[1] === undefined) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const chargeBoxId = decodeURIComponent(match[1]);
    if (
      options.authorize !== undefined &&
      !options.authorize(chargeBoxId, req.headers.authorization)
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (ws.protocol !== OCPP16_SUBPROTOCOL) {
        ws.close(1002, 'ocpp1.6 subprotocol required');
        return;
      }
      const connection = createConnection(ws, chargeBoxId, req.headers, handlers, takeOverride);
      connections.set(chargeBoxId, connection);
      ws.on('close', () => {
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
    url: `ws://${host}:${boundPort}/ocpp`,
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
    async stop() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
