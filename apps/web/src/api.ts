/**
 * Typed access to the engine API. The UI holds no simulation logic: every
 * action is one of these calls, and state comes back from the engine.
 */

export interface ConnectorSnapshot {
  connectorId: number;
  status: string;
  errorCode: string;
  plugged: boolean;
  locked: boolean;
  transactionId?: number;
  idTag?: string;
  energyWh: number;
  powerW: number;
}

/** Test switches; see ChargePointBehaviour in core. */
export interface Behaviour {
  refuseRemoteStart: boolean;
  cableLock: boolean;
}

export interface StationSnapshot {
  id: string;
  persona: string;
  csmsUrl: string;
  running: boolean;
  transport: string;
  registration: string;
  connected: boolean;
  station: { status: string; errorCode: string };
  connectors: ConnectorSnapshot[];
  config: Record<string, string>;
  queuedMessages: number;
  behaviour: Behaviour;
}

export interface FaultInfo {
  name?: string;
  errorCode: string;
  info?: string;
  vendorErrorCode?: string;
}

export interface PersonaInfo {
  id: string;
  description?: string;
  connectors: number;
  faults: FaultInfo[];
  warnings: string[];
}

export interface FrameRecord {
  kind: 'frame';
  seq: number;
  stationId: string;
  at: string;
  direction: 'cp-to-csms' | 'csms-to-cp';
  messageType?: 2 | 3 | 4;
  uniqueId?: string;
  action?: string;
  payload?: unknown;
  text: string;
}

export interface LogRecord {
  kind: 'log';
  seq: number;
  stationId: string;
  at: string;
  message: string;
}

export type RecordEntry = FrameRecord | LogRecord;

export interface NewStation {
  id: string;
  persona: string;
  csmsUrl: string;
  password?: string;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body !== undefined && {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  });
  const text = await res.text();
  const data = text === '' ? undefined : (JSON.parse(text) as unknown);
  if (!res.ok) {
    const message =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

const station = (id: string) => `/api/stations/${encodeURIComponent(id)}`;
const connector = (id: string, connectorId: number) => `${station(id)}/connectors/${connectorId}`;

export const api = {
  personas: () => request<{ personas: PersonaInfo[]; errors: string[] }>('GET', '/api/personas'),
  stations: () => request<{ stations: StationSnapshot[] }>('GET', '/api/stations'),
  createStation: (definition: NewStation) =>
    request<StationSnapshot>('POST', '/api/stations', definition),
  deleteStation: (id: string) => request<void>('DELETE', station(id)),
  start: (id: string) => request<StationSnapshot>('POST', `${station(id)}/start`),
  stop: (id: string) => request<StationSnapshot>('POST', `${station(id)}/stop`),
  offline: (id: string, mode: 'clean' | 'half-open') =>
    request<StationSnapshot>('POST', `${station(id)}/offline`, { mode }),
  online: (id: string) => request<StationSnapshot>('POST', `${station(id)}/online`),
  setBehaviour: (id: string, changes: Partial<Behaviour>) =>
    request<StationSnapshot>('PATCH', `${station(id)}/behaviour`, changes),
  plug: (id: string, c: number) => request<StationSnapshot>('POST', `${connector(id, c)}/plug`),
  unplug: (id: string, c: number) => request<StationSnapshot>('POST', `${connector(id, c)}/unplug`),
  idTag: (id: string, c: number, idTag: string) =>
    request<{ result: string; station: StationSnapshot }>('POST', `${connector(id, c)}/id-tag`, {
      idTag,
    }),
  evSuspend: (id: string, c: number) =>
    request<StationSnapshot>('POST', `${connector(id, c)}/ev-suspend`),
  evResume: (id: string, c: number) =>
    request<StationSnapshot>('POST', `${connector(id, c)}/ev-resume`),
  fault: (id: string, c: number, fault: FaultInfo) =>
    request<StationSnapshot>('POST', `${connector(id, c)}/fault`, fault),
  clearFault: (id: string, c: number) =>
    request<StationSnapshot>('DELETE', `${connector(id, c)}/fault`),
  messages: (id: string, limit = 500) =>
    request<{ entries: RecordEntry[] }>('GET', `${station(id)}/messages?limit=${limit}`),
};

export type ApiEvent =
  | { type: 'record'; entry: RecordEntry }
  | { type: 'station'; station: StationSnapshot }
  | { type: 'station-removed'; stationId: string };

/** Subscribes to /api/events, reconnecting after drops. Returns an unsubscribe function. */
export function subscribeEvents(
  onEvent: (event: ApiEvent) => void,
  onConnection: (connected: boolean) => void,
): () => void {
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const connect = () => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`;
    socket = new WebSocket(url);
    socket.onopen = () => onConnection(true);
    socket.onmessage = (message) => onEvent(JSON.parse(String(message.data)) as ApiEvent);
    socket.onclose = () => {
      onConnection(false);
      if (!closed) retry = setTimeout(connect, 2000);
    };
  };
  connect();
  return () => {
    closed = true;
    if (retry !== undefined) clearTimeout(retry);
    socket?.close();
  };
}
