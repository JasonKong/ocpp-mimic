/**
 * The WebSocket connection of one virtual charge point to its CSMS: OCPP
 * 1.6J subprotocol, optional Basic Auth, keepalive pings, reconnecting with
 * exponential backoff and jitter, and two kinds of simulated outage.
 */
import { OCPP16_SUBPROTOCOL } from '@ocpp-mimic/core';
import WebSocket from 'ws';

export interface BackoffPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
  /** Random spread around each delay, as a fraction (0.2 = ±20%). */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  initialDelayMs: 1000,
  maxDelayMs: 60_000,
  factor: 2,
  jitter: 0.2,
};

/** The delay before reconnect attempt `attempt` (0-based); `random` returns [0, 1). */
export function backoffDelay(attempt: number, policy: BackoffPolicy, random: () => number): number {
  const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * policy.factor ** attempt);
  return Math.max(0, Math.round(base * (1 + policy.jitter * (random() * 2 - 1))));
}

export type TransportState =
  'idle' | 'connecting' | 'open' | 'waiting' | 'offline' | 'half-open' | 'stopped';

export type TransportEvent =
  | { type: 'connecting'; url: string }
  | { type: 'open'; protocol: string }
  | { type: 'close'; code: number; reason: string }
  | { type: 'error'; message: string }
  | { type: 'reconnect-scheduled'; delayMs: number }
  | { type: 'state'; state: TransportState };

export interface TransportOptions {
  /** The CSMS's OCPP-J URL; the chargeBoxId is appended as the last path segment. */
  url: string;
  chargeBoxId: string;
  /** Basic Auth password (Security Profiles 1 and 2); the username is the chargeBoxId. */
  password?: string;
  /** Interval for WebSocket pings, in ms (from WebSocketPingInterval); 0 turns them off. */
  pingIntervalMs?: number;
  backoff?: Partial<BackoffPolicy>;
  /** For wss://: whether to verify the server certificate, and extra CA certificates. */
  tls?: { rejectUnauthorized?: boolean; ca?: string | Buffer };
  random?: () => number;
  /** A text frame from the CSMS. */
  onText: (text: string) => void;
  /** The connection is open with the ocpp1.6 subprotocol. */
  onOpen: () => void;
  /** The connection is gone (closed, failed, or taken down for an outage or restart). */
  onClose: () => void;
  onEvent?: (event: TransportEvent) => void;
}

export interface Transport {
  readonly state: TransportState;
  /** Connects, and keeps reconnecting until stop(). */
  start(): void;
  stop(): Promise<void>;
  /** Sends a text frame; dropped unless the connection is open. */
  send(text: string): void;
  /**
   * Simulates a network outage. `clean`: the socket closes and nothing
   * reconnects until goOnline(). `half-open`: the socket stays open but
   * nothing is sent or received and pings go unanswered, the way a lost
   * mobile connection looks to both sides.
   */
  goOffline(mode: 'clean' | 'half-open'): void;
  goOnline(): void;
  /** Drops the connection and reconnects after `downtimeMs` (a reset). */
  restartAfter(downtimeMs: number): void;
}

export function createTransport(options: TransportOptions): Transport {
  const policy: BackoffPolicy = { ...DEFAULT_BACKOFF, ...options.backoff };
  const random = options.random ?? Math.random;
  const emit = options.onEvent ?? (() => {});
  const target = `${options.url.replace(/\/+$/, '')}/${encodeURIComponent(options.chargeBoxId)}`;

  let state: TransportState = 'idle';
  let socket: WebSocket | undefined;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  /** Whether onOpen has been reported for the current socket, so onClose pairs with it. */
  let reportedOpen = false;

  function setState(next: TransportState): void {
    if (state === next) return;
    state = next;
    emit({ type: 'state', state });
  }

  function clearTimers(): void {
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    if (pingTimer !== undefined) clearInterval(pingTimer);
    reconnectTimer = pingTimer = undefined;
  }

  function reportClosed(): void {
    if (!reportedOpen) return;
    reportedOpen = false;
    options.onClose();
  }

  /** Drops the current socket without triggering the reconnect logic. */
  function dropSocket(code = 1000): void {
    const current = socket;
    socket = undefined;
    if (pingTimer !== undefined) clearInterval(pingTimer);
    pingTimer = undefined;
    if (current !== undefined) {
      current.removeAllListeners();
      current.on('error', () => {});
      if (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING) {
        if (code === 1000) current.close(code);
        else current.terminate();
      }
    }
    reportClosed();
  }

  function scheduleReconnect(delayMs: number): void {
    setState('waiting');
    emit({ type: 'reconnect-scheduled', delayMs });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delayMs);
  }

  function connectionLost(): void {
    dropSocket(1006);
    if (state === 'stopped' || state === 'offline') return;
    scheduleReconnect(backoffDelay(attempt++, policy, random));
  }

  function connect(): void {
    setState('connecting');
    emit({ type: 'connecting', url: target });
    const headers: Record<string, string> = {};
    if (options.password !== undefined) {
      const token = Buffer.from(`${options.chargeBoxId}:${options.password}`).toString('base64');
      headers.Authorization = `Basic ${token}`;
    }
    const ws = new WebSocket(target, [OCPP16_SUBPROTOCOL], {
      headers,
      autoPong: false,
      ...(options.tls?.rejectUnauthorized !== undefined && {
        rejectUnauthorized: options.tls.rejectUnauthorized,
      }),
      ...(options.tls?.ca !== undefined && { ca: options.tls.ca }),
    });
    socket = ws;

    ws.on('open', () => {
      if (ws.protocol !== OCPP16_SUBPROTOCOL) {
        emit({
          type: 'error',
          message: `server did not accept the ${OCPP16_SUBPROTOCOL} subprotocol`,
        });
        connectionLost();
        return;
      }
      attempt = 0;
      setState('open');
      emit({ type: 'open', protocol: ws.protocol });
      const pingMs = options.pingIntervalMs ?? 0;
      if (pingMs > 0) {
        pingTimer = setInterval(() => {
          if (state === 'open') ws.ping();
        }, pingMs);
      }
      reportedOpen = true;
      options.onOpen();
    });
    ws.on('ping', (data) => {
      if (state === 'open') ws.pong(data);
    });
    ws.on('message', (data, isBinary) => {
      if (state === 'open' && !isBinary) options.onText(data.toString());
    });
    ws.on('error', (error) => emit({ type: 'error', message: error.message }));
    ws.on('close', (code, reason) => {
      if (ws !== socket) return;
      emit({ type: 'close', code, reason: reason.toString() });
      connectionLost();
    });
  }

  return {
    get state() {
      return state;
    },

    start() {
      if (state !== 'idle' && state !== 'stopped') return;
      attempt = 0;
      connect();
    },

    async stop() {
      setState('stopped');
      clearTimers();
      const current = socket;
      dropSocket();
      if (current !== undefined && current.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          current.once('close', () => resolve());
          setTimeout(resolve, 1000).unref();
        });
      }
    },

    send(text) {
      if (state === 'open' && socket?.readyState === WebSocket.OPEN) socket.send(text);
    },

    goOffline(mode) {
      if (state === 'stopped') return;
      if (mode === 'clean') {
        clearTimers();
        setState('offline');
        dropSocket();
        return;
      }
      if (state === 'open') {
        setState('half-open');
        reportClosed();
      }
    },

    goOnline() {
      if (state === 'offline') {
        attempt = 0;
        connect();
      } else if (state === 'half-open') {
        // The network is back but the old connection may be dead on the CSMS side: start fresh.
        dropSocket();
        attempt = 0;
        connect();
      }
    },

    restartAfter(downtimeMs) {
      if (state === 'stopped') return;
      clearTimers();
      dropSocket();
      attempt = 0;
      scheduleReconnect(downtimeMs);
    },
  };
}
