/**
 * Typed access to the engine API. The UI holds no simulation logic: every
 * action is one of these calls, and state comes back from the engine.
 */

export type OcppVersion = '1.6' | '2.0.1';

/** The IdToken types a 2.0.1 station takes (IdTokenEnumType). */
export const ID_TOKEN_TYPES = [
  'ISO14443',
  'ISO15693',
  'eMAID',
  'Central',
  'KeyCode',
  'Local',
  'MacAddress',
  'NoAuthorization',
] as const;

export interface ConnectorSnapshot {
  connectorId: number;
  /** 2.0.1: the EVSE the connector belongs to (connector n is EVSE n's only connector). */
  evseId?: number;
  /** 1.6 ChargePointStatus, or 2.0.1 ConnectorStatusEnumType. */
  status: string;
  /** 2.0.1 ChargingStateEnumType. */
  chargingState?: string;
  errorCode: string;
  plugged: boolean;
  locked: boolean;
  /** A number in 1.6, a string in 2.0.1. */
  transactionId?: number | string;
  idTag?: string;
  energyWh: number;
  powerW: number;
  ev?: { name?: string; soc: number; profile: EvProfile };
  limitW?: number;
}
export interface EvProfile {
  capacityKWh: number;
  initialSoc: number;
  maxPowerW: number;
  phases: number;
  taperSoc?: number;
  targetSoc?: number;
  /** How the EV talks to the station; basic reports no SoC. */
  communication?: 'basic' | 'dc' | 'iso15118';
  /** Minutes after plugging in an ISO 15118 EV wants to leave. */
  departureMinutes?: number;
}

/** Test switches; see ChargePointBehaviour in core. */
export interface Behaviour {
  refuseRemoteStart: boolean;
  cableLock: boolean;
}

export interface StationSnapshot {
  id: string;
  ocpp: OcppVersion;
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
  energyMultiplier: number;
  localList: { version: number; size: number };
  reservations: { reservationId: number; connectorId: number; idTag: string; expiryDate: string }[];
  chargingProfiles: {
    chargingProfileId: number;
    connectorId: number;
    purpose: string;
    stackLevel: number;
  }[];
  /** Fault injections active on the station. */
  injections?: { id: string; injection: { type: string }; until?: string; remaining?: number }[];
  /** Whether the CSMS is ocpp-mimic's built-in one, which can start sessions remotely from here. */
  csms?: 'builtin' | 'external';
}

export interface FaultInfo {
  name?: string;
  errorCode: string;
  info?: string;
  vendorErrorCode?: string;
}

export interface PersonaInfo {
  id: string;
  ocpp: OcppVersion;
  /** 2.0.1 certification profiles. */
  features?: string[];
  description?: string;
  connectors: number;
  faults: FaultInfo[];
  evs: Record<string, EvProfile>;
  warnings: string[];
}

export interface FrameRecord {
  kind: 'frame';
  seq: number;
  stationId: string;
  at: string;
  direction: 'cp-to-csms' | 'csms-to-cp';
  /** 2 CALL, 3 CALLRESULT, 4 CALLERROR; in OCPP 2.1 also 5 CALLRESULTERROR and 6 SEND. */
  messageType?: 2 | 3 | 4 | 5 | 6;
  uniqueId?: string;
  action?: string;
  payload?: unknown;
  /** Problems found by the official OCA JSON Schema, when there are any. */
  schemaErrors?: string[];
  /** The fault injection that changed, made or kept back the frame. */
  injected?: string;
  /** The frame never reached the other side. */
  dropped?: true;
  /** The station's OCPP version. */
  ocpp?: OcppVersion;
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

/** One 2.0.1 Device Model variable (GET /api/stations/:id/device-model). */
export interface DeviceModelEntry {
  component: string;
  variable: string;
  dataType: string;
  unit?: string;
  valuesList?: string;
  minLimit?: number;
  maxLimit?: number;
  attributes: { type: string; mutability: string; value?: string }[];
}

export interface NewStation {
  id: string;
  persona: string;
  csmsUrl: string;
  password?: string;
  /** More than 1: `id` holds a counter such as SIM-{001} and the stations are created in bulk. */
  count?: number;
  group?: string;
}

/** What a fleet list shows of a station. */
export interface StationSummary {
  id: string;
  persona: string;
  ocpp: OcppVersion;
  group?: string;
  tags: string[];
  state: 'connected' | 'connecting' | 'offline' | 'stopped';
  registration: string;
  connectors: { connectorId: number; status: string; chargingState?: string }[];
}

export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** GET /api/metrics, the parts the Web UI shows. */
export interface MetricsSummary {
  stations: Record<string, number>;
  connectors: Record<string, number>;
  csmsLatency: { overall: LatencySummary; byAction: Record<string, LatencySummary> };
  answers: Record<string, number>;
  callErrors: { sent: number; received: number };
  schemaViolations: number;
  connections: { opened: number; failed: number };
  disconnects: Record<string, number>;
  transactions: Record<string, number>;
  sessionsTurnedAway: number;
  offlineQueue: number;
  eventLoopDelayMs: { p50: number; p99: number; max: number };
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

// ---- Sessions (docs/session-ui.md) -------------------------------------------

export type SessionSource = 'local' | 'remote' | 'noAuth';
export type SessionState = 'starting' | 'running' | 'finished' | 'not-started';

export interface SessionIdToken {
  idToken: string;
  type?: string;
}

/** What a list of sessions shows of one. */
export interface SessionSummary {
  stationId: string;
  n: number;
  ocpp: OcppVersion;
  state: SessionState;
  source: SessionSource;
  evseId?: number;
  idToken?: SessionIdToken;
  remoteStartId?: number;
  transactionId?: number | string;
  requestedAt: string;
  startedAt?: string;
  endedAt?: string;
  failure?: { reason: string; detail?: string };
  energyWh: number;
  socPercent?: number;
}

export interface TimelineStep {
  seq: number;
  at: string;
  action: string;
  direction: 'cp-to-csms' | 'csms-to-cp';
  messageType: 2 | 3 | 4;
  status?: string;
  sincePreviousMs?: number;
}

export interface ReportedSample {
  at: string;
  seq: number;
  context?: string;
  energyWh?: number;
  powerW?: number;
  offeredW?: number;
  socPercent?: number;
  currentA?: Partial<Record<'L1' | 'L2' | 'L3', number>>;
  voltageV?: Partial<Record<'L1' | 'L2' | 'L3', number>>;
}

export interface TrueSample {
  at: string;
  socPercent: number;
  energyWh: number;
  powerW: number;
  msUntilFull?: number;
}

export interface SessionRecord extends Omit<SessionSummary, 'energyWh' | 'socPercent'> {
  connectorId?: number;
  timeline: TimelineStep[];
  samples: ReportedSample[];
  truth: TrueSample[];
  states: {
    at: string;
    state: 'charging' | 'suspendedEV' | 'suspendedEVSE' | 'idle';
    seq?: number;
  }[];
  meterStartWh?: number;
  meterStopWh?: number;
  meterStartSeq?: number;
  meterStopSeq?: number;
  chargingNeeds?: Record<string, unknown>;
  costs: { at: string; seq: number; totalCost: number; from: string }[];
  stopReason?: string;
  framesTruncated?: true;
}

export interface SessionEstimate {
  socPercent?: number;
  at?: string;
  refinedSocPercent?: number;
  capacityWh?: number;
  capacityFrom?: 'chargingNeeds' | 'readings';
  targetSoc: number;
  targetFrom: 'chargingNeeds' | 'default';
  taperSoc: number;
  powerW?: number;
  energyLeftWh?: number;
  msToTarget?: number;
  etaAt?: string;
  departureTime?: string;
  reachesTargetBeforeDeparture?: boolean;
  reason?: string;
}

/** A reference tariff: an OCPP 2.1 TariffType without conditions (one price per part). */
export interface ReferenceTariff {
  tariffId: string;
  currency: string;
  fixedFee?: { prices: { priceFixed: number }[]; taxRates?: TaxRate[] };
  energy?: { prices: { priceKwh: number }[]; taxRates?: TaxRate[] };
  chargingTime?: { prices: { priceMinute: number }[]; taxRates?: TaxRate[] };
  idleTime?: { prices: { priceMinute: number }[]; taxRates?: TaxRate[] };
  minCost?: { exclTax?: number; inclTax?: number };
  maxCost?: { exclTax?: number; inclTax?: number };
}

export interface TaxRate {
  type: string;
  tax: number;
  stack?: number;
}

export interface PriceItem {
  part: 'fixedFee' | 'energy' | 'chargingTime' | 'idleTime';
  quantity: number;
  unit: 'session' | 'kWh' | 'min';
  unitPrice: number;
  exclTax: number;
  tax: number;
  inclTax: number;
  frames: number[];
}

export interface SessionPrice {
  tariffId: string;
  currency: string;
  items: PriceItem[];
  exclTax: number;
  tax: number;
  inclTax: number;
  adjusted?: 'minCost' | 'maxCost';
}

export interface SessionDetail {
  session: SessionRecord;
  summary: SessionSummary;
  estimate: SessionEstimate;
  truth?: { at: string; socPercent: number; msToTarget?: number; etaAt?: string };
  gap?: { gapMs: number; off: boolean };
  durations: Record<'charging' | 'suspendedEV' | 'suspendedEVSE' | 'idle', number>;
  price: SessionPrice;
  /** Energy and SoC advance this many times faster than real time; times to the target are simulated. */
  energyMultiplier?: number;
}

const station = (id: string) => `/api/stations/${encodeURIComponent(id)}`;
const connector = (id: string, connectorId: number) => `${station(id)}/connectors/${connectorId}`;

export const api = {
  personas: () => request<{ personas: PersonaInfo[]; errors: string[] }>('GET', '/api/personas'),
  stations: () => request<{ stations: StationSnapshot[] }>('GET', '/api/stations'),
  station: (id: string) => request<StationSnapshot>('GET', station(id)),
  createStation: (definition: NewStation) =>
    request<StationSnapshot>('POST', '/api/stations', definition),
  createStations: (template: NewStation & { count: number }) =>
    request<{ created: number; ids: string[] }>('POST', '/api/stations/bulk', template),
  metrics: () => request<MetricsSummary>('GET', '/api/metrics'),
  deleteStation: (id: string) => request<void>('DELETE', station(id)),
  start: (id: string) => request<StationSnapshot>('POST', `${station(id)}/start`),
  stop: (id: string) => request<StationSnapshot>('POST', `${station(id)}/stop`),
  offline: (id: string, mode: 'clean' | 'half-open') =>
    request<StationSnapshot>('POST', `${station(id)}/offline`, { mode }),
  online: (id: string) => request<StationSnapshot>('POST', `${station(id)}/online`),
  clearInjections: (id: string) => request<StationSnapshot>('DELETE', `${station(id)}/injections`),
  inject: (id: string, injection: Record<string, unknown>) =>
    request<StationSnapshot>('POST', `${station(id)}/injections`, injection),
  setEnergyMultiplier: (id: string, energyMultiplier: number) =>
    request<StationSnapshot>('PATCH', `${station(id)}/energy-multiplier`, { energyMultiplier }),
  setBehaviour: (id: string, changes: Partial<Behaviour>) =>
    request<StationSnapshot>('PATCH', `${station(id)}/behaviour`, changes),
  plug: (id: string, c: number, ev?: string) =>
    request<StationSnapshot>('POST', `${connector(id, c)}/plug`, ev !== undefined ? { ev } : {}),
  unplug: (id: string, c: number) => request<StationSnapshot>('POST', `${connector(id, c)}/unplug`),
  idTag: (id: string, c: number, idTag: string, type?: string) =>
    request<{ result: string; station: StationSnapshot }>('POST', `${connector(id, c)}/id-tag`, {
      idTag,
      ...(type !== undefined && { type }),
    }),
  deviceModel: (id: string) =>
    request<{ variables: DeviceModelEntry[] }>('GET', `${station(id)}/device-model`),
  /** Sets an Actual value locally; the answer is a SetVariables attributeStatus. */
  setVariable: (id: string, component: string, variable: string, value: string) =>
    request<{ status: string; reason?: string }>('PATCH', `${station(id)}/device-model`, {
      component,
      variable,
      value,
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
  sessions: (id: string) =>
    request<{ sessions: SessionSummary[] }>('GET', `${station(id)}/sessions`),
  session: (id: string, n: number) => request<SessionDetail>('GET', `${station(id)}/sessions/${n}`),
  sessionFrames: (id: string, n: number) =>
    request<{ frames: FrameRecord[] }>('GET', `${station(id)}/sessions/${n}/frames`),
  tariff: () => request<{ tariff: ReferenceTariff }>('GET', '/api/tariff'),
  setTariff: (tariff: ReferenceTariff) =>
    request<{ tariff: ReferenceTariff }>('PUT', '/api/tariff', { tariff }),
  /** Has the built-in CSMS start a session on the station (only when it is the station's CSMS). */
  remoteStart: (id: string, idToken: SessionIdToken, evseId?: number) =>
    request<{ action: string; status: string; remoteStartId?: number }>(
      'POST',
      `${station(id)}/remote-start`,
      { idToken, ...(evseId !== undefined && { evseId }) },
    ),
};

/** Where a session's frames export as the recorder's JSONL. */
export const sessionFramesUrl = (id: string, n: number) =>
  `${station(id)}/sessions/${n}/frames?format=jsonl`;

/**
 * What /api/events pushes: fleet summaries to everyone (all on connecting,
 * then changes at most once a second), records and full snapshots only for
 * the subscribed stations.
 */
export type ApiEvent =
  | { type: 'record'; entry: RecordEntry }
  | { type: 'session'; session: SessionSummary }
  | { type: 'station'; station: StationSnapshot }
  | { type: 'fleet'; stations: StationSummary[]; removed: string[]; full?: true };

export interface EventsConnection {
  /** The stations to get records and full snapshots for; replaces the earlier list. */
  subscribe(stationIds: string[]): void;
  close(): void;
}

/** Connects to /api/events, reconnecting after drops and subscribing again. */
export function connectEvents(
  onEvent: (event: ApiEvent) => void,
  onConnection: (connected: boolean) => void,
): EventsConnection {
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let subscribed: string[] = [];
  const send = () => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'subscribe', stations: subscribed }));
    }
  };
  const connect = () => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`;
    socket = new WebSocket(url);
    socket.onopen = () => {
      onConnection(true);
      send();
    };
    socket.onmessage = (message) => onEvent(JSON.parse(String(message.data)) as ApiEvent);
    socket.onclose = () => {
      onConnection(false);
      if (!closed) retry = setTimeout(connect, 2000);
    };
  };
  connect();
  return {
    subscribe(stationIds) {
      subscribed = stationIds;
      send();
    },
    close() {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      socket?.close();
    },
  };
}
