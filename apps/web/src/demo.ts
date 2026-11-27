/**
 * The demo page's model: a car park of charge points built for one OCPP
 * version and one way of starting sessions, the cars in its bays, and how a
 * bay looks from a station snapshot. DemoView.vue draws it and drives the
 * engine's API; everything on the wire comes from the real stations.
 */
import type { ConnectorSnapshot, EvProfile, FrameRecord, OcppVersion } from './api.js';

export type StartMode = 'free-vend' | 'card' | 'app' | 'valet';

export interface StartModeInfo {
  id: StartMode;
  label: string;
  /** What happens, in one sentence. */
  summary: string;
}

export const START_MODES: readonly StartModeInfo[] = [
  {
    id: 'free-vend',
    label: 'Plug in and charge',
    summary:
      'Like a home charger: plugging in starts the session, with no card and no app (free vend).',
  },
  {
    id: 'card',
    label: 'RFID card',
    summary: 'The driver taps a card: the station asks the CSMS (Authorize), then starts.',
  },
  {
    id: 'app',
    label: 'App',
    summary: 'The driver starts and stops in an app: the CSMS sends the station a remote start.',
  },
  {
    id: 'valet',
    label: 'Valet',
    summary:
      'The CSMS starts a session whenever a car is plugged in, with no driver, as in a valet car park.',
  },
];

export const DEMO_VERSIONS: readonly OcppVersion[] = ['1.6', '2.0.1', '2.1'];

/** Energy multipliers on offer: how many times faster than real time the batteries fill. */
export const DEMO_SPEEDS: readonly number[] = [1, 60, 300, 1200];

export interface DemoSetup {
  ocpp: OcppVersion;
  mode: StartMode;
  /** Charge points in the car park, 1 to 3. */
  chargers: number;
  /** Ports on each, 1 or 2. */
  ports: 1 | 2;
  /** Energy multiplier. */
  speed: number;
  csmsUrl: string;
}

export const DEFAULT_SETUP: DemoSetup = {
  ocpp: '1.6',
  mode: 'free-vend',
  chargers: 2,
  ports: 2,
  speed: 300,
  csmsUrl: 'ws://127.0.0.1:9100/ocpp',
};

/** Demo stations carry this tag; building again deletes only them. */
export const DEMO_TAG = 'demo';

/** The token valet sessions start with, and the ones drivers carry. */
export const VALET_TOKEN = 'VALET';
export const cardFor = (bay: number) => `CARD-${String(bay + 1).padStart(4, '0')}`;
export const appUserFor = (bay: number) => `APP-USER-${String(bay + 1).padStart(2, '0')}`;

/** The generic personas that come with ocpp-mimic, with one port or two. */
export function demoPersona(ocpp: OcppVersion, ports: 1 | 2): string {
  return ports === 2 ? `generic-dual-${ocpp}` : `generic-${ocpp}`;
}

export const demoStationId = (index: number) => `DEMO-${index + 1}`;

/** What POST /api/stations takes for a demo station. */
export interface DemoStationDefinition {
  id: string;
  persona: string;
  csmsUrl: string;
  tags: string[];
  energyMultiplier: number;
  config?: Record<string, string>;
  deviceModel?: Record<string, Record<string, string | number | boolean>>;
}

/** Meter values every this many seconds, so the CSMS side moves along with the cars. */
const METER_INTERVAL_S = 10;

/** The stations for a setup; free vend is the station's own setting, valet is the CSMS's. */
export function demoStations(setup: DemoSetup): DemoStationDefinition[] {
  const freeVend = setup.mode === 'free-vend';
  return Array.from({ length: setup.chargers }, (_, i) => ({
    id: demoStationId(i),
    persona: demoPersona(setup.ocpp, setup.ports),
    csmsUrl: setup.csmsUrl,
    tags: [DEMO_TAG],
    energyMultiplier: setup.speed,
    ...(setup.ocpp === '1.6'
      ? {
          config: {
            MeterValueSampleInterval: String(METER_INTERVAL_S),
            ...(freeVend && { FreeVendEnabled: 'true', FreeVendIdTag: 'HOME' }),
          },
        }
      : {
          deviceModel: {
            SampledDataCtrlr: { TxUpdatedInterval: METER_INTERVAL_S },
            ...(freeVend && { AuthCtrlr: { Enabled: false } }),
          },
        }),
  }));
}

/** A made-up car for each bay; different sizes and charge levels so they fill at different times. */
export interface DemoCar {
  name: string;
  colour: string;
  profile: EvProfile;
}

export const DEMO_CARS: readonly DemoCar[] = [
  {
    name: 'Hatchback',
    colour: '#2563eb',
    profile: { capacityKWh: 40, initialSoc: 70, maxPowerW: 7400, phases: 1 },
  },
  {
    name: 'Sedan',
    colour: '#dc2626',
    profile: { capacityKWh: 60, initialSoc: 45, maxPowerW: 11000, phases: 3 },
  },
  {
    name: 'City car',
    colour: '#d97706',
    profile: { capacityKWh: 25, initialSoc: 55, maxPowerW: 7400, phases: 1 },
  },
  {
    name: 'SUV',
    colour: '#059669',
    profile: { capacityKWh: 75, initialSoc: 35, maxPowerW: 11000, phases: 3 },
  },
  {
    name: 'Van',
    colour: '#7c3aed',
    profile: { capacityKWh: 50, initialSoc: 25, maxPowerW: 7400, phases: 1 },
  },
  {
    name: 'Estate',
    colour: '#0891b2',
    profile: { capacityKWh: 64, initialSoc: 60, maxPowerW: 11000, phases: 3 },
  },
];

export const carFor = (bay: number): DemoCar => DEMO_CARS[bay % DEMO_CARS.length] as DemoCar;

/** Where a bay stands, for drawing it and for the buttons it offers. */
export type BayPhase =
  | 'empty'
  | 'plugged'
  | 'starting'
  | 'charging'
  | 'full'
  | 'suspended'
  | 'finished'
  | 'fault'
  | 'unavailable';

export interface BayView {
  phase: BayPhase;
  /** The OCPP status as the station reports it: 1.6 status, or 2.x status and charging state. */
  status: string;
  plugged: boolean;
  transaction: boolean;
  /** The car's true state of charge, while one is plugged in. */
  soc?: number;
  powerW: number;
  /** Energy the car took since it was plugged in, from its battery. */
  addedKWh?: number;
}

/** The bay of a connector; `hadTransaction` says a session ran since the car was plugged in. */
export function bayView(
  connector: ConnectorSnapshot,
  ocpp: OcppVersion,
  hadTransaction = false,
): BayView {
  const status =
    ocpp === '1.6' || connector.chargingState === undefined
      ? connector.status
      : `${connector.status} · ${connector.chargingState}`;
  const ev = connector.ev;
  const transaction = connector.transactionId !== undefined;
  const view: BayView = {
    phase: 'empty',
    status,
    plugged: connector.plugged,
    transaction,
    powerW: connector.powerW,
    ...(ev !== undefined && {
      soc: ev.soc,
      addedKWh: Math.max(0, ((ev.soc - ev.profile.initialSoc) / 100) * ev.profile.capacityKWh),
    }),
  };
  const state = ocpp === '1.6' ? connector.status : (connector.chargingState ?? connector.status);
  if (connector.status === 'Faulted' || connector.errorCode !== 'NoError') {
    return { ...view, phase: 'fault' };
  }
  if (connector.status === 'Unavailable') return { ...view, phase: 'unavailable' };
  if (transaction) {
    if (state === 'Charging') return { ...view, phase: 'charging' };
    if (state === 'SuspendedEV') {
      const target = ev?.profile.targetSoc ?? 100;
      const full = ev !== undefined && ev.soc >= target - 0.5;
      return { ...view, phase: full ? 'full' : 'suspended' };
    }
    if (state === 'SuspendedEVSE') return { ...view, phase: 'suspended' };
    return { ...view, phase: 'starting' };
  }
  if (!connector.plugged) return view;
  if (connector.status === 'Finishing' || hadTransaction) return { ...view, phase: 'finished' };
  return { ...view, phase: 'plugged' };
}

/** What a message capsule and the message list show for a frame. */
export interface FrameLabel {
  kind: 'call' | 'result' | 'error';
  text: string;
  /** The answer's status, when it has one (Accepted, Rejected, Invalid, ...). */
  status?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The status an answer carries, wherever its action keeps it. */
function answerStatus(payload: unknown): string | undefined {
  if (!isObject(payload)) return undefined;
  if (typeof payload.status === 'string') return payload.status;
  for (const key of ['idTagInfo', 'idTokenInfo']) {
    const info = payload[key];
    if (isObject(info) && typeof info.status === 'string') return info.status;
  }
  return undefined;
}

export function frameLabel(entry: FrameRecord): FrameLabel {
  const action = entry.action ?? '?';
  if (entry.messageType === 2 || entry.messageType === 6) return { kind: 'call', text: action };
  if (entry.messageType === 3) {
    const status = answerStatus(entry.payload);
    return { kind: 'result', text: action, ...(status !== undefined && { status }) };
  }
  return { kind: 'error', text: action, status: errorCode(entry.text) ?? 'CALLERROR' };
}

/** The error code of a CALLERROR (or 2.1 CALLRESULTERROR) frame's text. */
function errorCode(text: string): string | undefined {
  try {
    const frame = JSON.parse(text) as unknown;
    return Array.isArray(frame) && typeof frame[2] === 'string' ? frame[2] : undefined;
  } catch {
    return undefined;
  }
}

/** A transaction id wherever a message keeps it: 2.x transactionInfo, or the payload itself. */
function transactionIdOf(payload: Record<string, unknown>): string | undefined {
  const info = isObject(payload.transactionInfo) ? payload.transactionInfo : undefined;
  const id = info?.transactionId ?? payload.transactionId;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

/**
 * Which port (1.6 connector, 2.x EVSE) each message of a station is about,
 * fed the frames in order. A request names it (connectorId, evseId,
 * evse.id), or its transaction does; an answer belongs to its request's
 * port. 1.6 learns a transaction's id from StartTransaction's answer.
 */
export function createPortTracker(): (entry: FrameRecord) => number | undefined {
  const byCall = new Map<string, number>();
  const byTransaction = new Map<string, number>();
  return (entry) => {
    const payload = isObject(entry.payload) ? entry.payload : {};
    const callKey = `${entry.stationId} ${entry.uniqueId ?? ''}`;
    const transaction = transactionIdOf(payload);
    const txKey = transaction === undefined ? undefined : `${entry.stationId} ${transaction}`;
    if (entry.messageType !== 2 && entry.messageType !== 6) {
      const port = byCall.get(callKey);
      byCall.delete(callKey);
      if (port !== undefined && txKey !== undefined) byTransaction.set(txKey, port);
      return port;
    }
    const evse = isObject(payload.evse) ? payload.evse.id : undefined;
    const named = [payload.connectorId, payload.evseId, evse].find(
      (value): value is number => typeof value === 'number' && value > 0,
    );
    if (named !== undefined && txKey !== undefined) byTransaction.set(txKey, named);
    const port = named ?? (txKey === undefined ? undefined : byTransaction.get(txKey));
    if (port !== undefined && entry.uniqueId !== undefined) byCall.set(callKey, port);
    return port;
  };
}

/** mm:ss, or h:mm:ss from an hour on. */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}
