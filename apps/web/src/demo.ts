/**
 * The demo page's model: a car park of charge points built for one OCPP
 * version and one way of starting sessions, the cars in its bays, and how a
 * bay looks from a station snapshot. DemoView.vue draws it and drives the
 * engine's API; everything on the wire comes from the real stations.
 */
import type {
  ConnectorSnapshot,
  EvProfile,
  FrameRecord,
  OcppVersion,
  StationSnapshot,
} from './api.js';

export type StartMode = 'free-vend' | 'card' | 'app' | 'valet' | 'payment' | 'qr' | 'autocharge';

export interface StartModeInfo {
  id: StartMode;
  label: string;
  /** What happens, in one sentence. */
  summary: string;
  /** Where it is used. */
  where: string;
  /** The OCPP versions that have it; every version when absent. */
  versions?: readonly OcppVersion[];
}

export const START_MODES: readonly StartModeInfo[] = [
  {
    id: 'free-vend',
    label: 'Free vend',
    summary:
      'Plug in and charge: the cable is enough, with no card and no app (not ISO 15118 Plug & Charge).',
    where: 'Home chargers, private bays, free workplace charging',
  },
  {
    id: 'card',
    label: 'RFID card',
    summary: 'The driver taps a card: the station asks the CSMS (Authorize), then starts.',
    where: 'Workplaces, fleets, public AC with roaming cards',
  },
  {
    id: 'app',
    label: 'App',
    summary: 'The driver starts and stops in an app: the CSMS sends the station a remote start.',
    where: 'Public AC and DC, residential car parks',
  },
  {
    id: 'valet',
    label: 'Valet',
    summary:
      'The CSMS starts a session whenever a car is plugged in, with no driver, as in a valet car park.',
    where: 'Hotels, valet and dealership car parks',
  },
  {
    id: 'payment',
    label: 'Bank card',
    summary:
      "The driver pays with a bank card at the charge point's payment terminal: no account, no app.",
    where: 'Public fast charging (required on new public chargers in the EU)',
    versions: ['2.1'],
  },
  {
    id: 'qr',
    label: 'QR code',
    summary:
      "The driver scans the charge point's QR code and pays on a web page; the CSMS then starts the session.",
    where: 'Public AC and DC for drivers without an account',
    versions: ['2.1'],
  },
  {
    id: 'autocharge',
    label: 'Autocharge',
    summary:
      'The car identifies itself by its MAC address (EVCCID) as it is plugged in: no card, no app.',
    where: 'DC fast charging networks, fleets',
  },
];

/** Whether a way of starting exists in an OCPP version. */
export const modeAvailable = (mode: StartMode, ocpp: OcppVersion) =>
  START_MODES.find((m) => m.id === mode)?.versions?.includes(ocpp) ?? true;

/** The shared secret of the demo stations' QR codes, so the CSMS can check them. */
export const DEMO_WEB_PAYMENT_SECRET = 'demo-web-payment-secret';

export const DEMO_VERSIONS: readonly OcppVersion[] = ['1.6', '2.0.1', '2.1'];

/** Energy multipliers on offer: how many times faster than real time the batteries fill. */
export const DEMO_SPEEDS: readonly number[] = [1, 60, 300, 1200];

/** A charge point of the site: one port or two. */
export type ChargerPorts = 'single' | 'dual';

/** How many charge points a demo site can have. */
export const MAX_CHARGERS = 6;

export interface DemoSetup {
  /** The site's name, shown on the manager panel. */
  site: string;
  ocpp: OcppVersion;
  mode: StartMode;
  /** The site's charge points, in order: CP-1, CP-2, ... */
  chargers: ChargerPorts[];
  /** Energy multiplier. */
  speed: number;
  csmsUrl: string;
  /** The site's grid capacity in kW, which the CSMS shares between sessions; null for none. */
  capacityKW: number | null;
}

export const DEFAULT_SETUP: DemoSetup = {
  site: 'Demo site',
  ocpp: '1.6',
  mode: 'free-vend',
  chargers: ['dual', 'single', 'dual'],
  speed: 300,
  csmsUrl: 'ws://127.0.0.1:9100/ocpp',
  capacityKW: 22,
};

/** The id of the demo's site in the built-in CSMS. */
export const DEMO_SITE_ID = 'demo';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A setup from storage, with defaults for whatever is missing or from an older page. */
export function normalizeSetup(value: unknown): DemoSetup {
  if (!isObject(value)) return { ...DEFAULT_SETUP, chargers: [...DEFAULT_SETUP.chargers] };
  const pick = <T>(ok: (v: unknown) => boolean, v: unknown, fallback: T): T =>
    ok(v) ? (v as T) : fallback;
  const chargers = Array.isArray(value.chargers)
    ? value.chargers.filter((c): c is ChargerPorts => c === 'single' || c === 'dual')
    : [];
  const ocpp = pick(
    (v) => DEMO_VERSIONS.includes(v as OcppVersion),
    value.ocpp,
    DEFAULT_SETUP.ocpp,
  );
  const mode = pick((v) => START_MODES.some((m) => m.id === v), value.mode, DEFAULT_SETUP.mode);
  return {
    site: pick((v) => typeof v === 'string' && v.trim() !== '', value.site, DEFAULT_SETUP.site),
    ocpp,
    mode: modeAvailable(mode, ocpp) ? mode : DEFAULT_SETUP.mode,
    chargers: chargers.length > 0 ? chargers.slice(0, MAX_CHARGERS) : [...DEFAULT_SETUP.chargers],
    speed: pick((v) => DEMO_SPEEDS.includes(v as number), value.speed, DEFAULT_SETUP.speed),
    csmsUrl: pick((v) => typeof v === 'string' && v !== '', value.csmsUrl, DEFAULT_SETUP.csmsUrl),
    capacityKW:
      value.capacityKW === null
        ? null
        : pick(
            (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
            value.capacityKW,
            DEFAULT_SETUP.capacityKW,
          ),
  };
}

/** Demo stations carry this tag; building again deletes only them. */
export const DEMO_TAG = 'demo';

/** The token valet sessions start with, and the ones drivers carry. */
export const VALET_TOKEN = 'VALET';
export const cardFor = (bay: number) => `CARD-${String(bay + 1).padStart(4, '0')}`;
export const appUserFor = (bay: number) => `APP-USER-${String(bay + 1).padStart(2, '0')}`;

/** The generic personas that come with ocpp-mimic, with one port or two. */
export function demoPersona(ocpp: OcppVersion, ports: ChargerPorts): string {
  return ports === 'dual' ? `generic-dual-${ocpp}` : `generic-${ocpp}`;
}

/** Station ids keep the demo's prefix, so they stay clear of other stations; labels drop it. */
export const demoStationId = (index: number) => `DEMO-CP-${index + 1}`;
export const chargerLabel = (stationId: string) => stationId.replace(/^DEMO-/, '');

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
/** The power each session draws goes with them, for the CSMS's load management. */
const MEASURANDS = 'Energy.Active.Import.Register,Power.Active.Import,SoC';

/** The stations for a setup; free vend is the station's own setting, valet is the CSMS's. */
export function demoStations(setup: DemoSetup): DemoStationDefinition[] {
  const freeVend = setup.mode === 'free-vend';
  return setup.chargers.map((ports, i) => ({
    id: demoStationId(i),
    persona: demoPersona(setup.ocpp, ports),
    csmsUrl: setup.csmsUrl,
    tags: [DEMO_TAG],
    energyMultiplier: setup.speed,
    ...(setup.ocpp === '1.6'
      ? {
          config: {
            MeterValueSampleInterval: String(METER_INTERVAL_S),
            MeterValuesSampledData: MEASURANDS,
            ...(freeVend && { FreeVendEnabled: 'true', FreeVendIdTag: 'HOME' }),
          },
        }
      : {
          deviceModel: {
            SampledDataCtrlr: {
              TxUpdatedInterval: METER_INTERVAL_S,
              TxUpdatedMeasurands: MEASURANDS,
            },
            ...(freeVend && { AuthCtrlr: { Enabled: false } }),
            ...(setup.ocpp === '2.1' && {
              WebPaymentsCtrlr: { SharedSecret: DEMO_WEB_PAYMENT_SECRET },
            }),
          },
        }),
  }));
}

/** What the site manager sees at a glance, from the stations' snapshots. */
export interface SiteTotals {
  /** Power drawn now, in W. */
  powerW: number;
  /** Energy delivered since the stations were built (their meters start at 0), in Wh. */
  energyWh: number;
  /** Connectors whose car is taking power. */
  charging: number;
  /** Connectors in a transaction whose car is full. */
  full: number;
}

export function siteTotals(stations: readonly StationSnapshot[]): SiteTotals {
  const totals: SiteTotals = { powerW: 0, energyWh: 0, charging: 0, full: 0 };
  for (const station of stations) {
    for (const connector of station.connectors) {
      totals.powerW += connector.powerW;
      totals.energyWh += connector.energyWh;
      const phase = bayView(connector, station.ocpp).phase;
      if (phase === 'charging') totals.charging += 1;
      if (phase === 'full') totals.full += 1;
    }
  }
  return totals;
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
    profile: {
      capacityKWh: 40,
      initialSoc: 70,
      maxPowerW: 7400,
      phases: 1,
      evccid: '0A1B2C3D4E01',
    },
  },
  {
    name: 'Sedan',
    colour: '#dc2626',
    profile: {
      capacityKWh: 60,
      initialSoc: 45,
      maxPowerW: 11000,
      phases: 3,
      evccid: '0A1B2C3D4E02',
    },
  },
  {
    name: 'City car',
    colour: '#d97706',
    profile: {
      capacityKWh: 25,
      initialSoc: 55,
      maxPowerW: 7400,
      phases: 1,
      evccid: '0A1B2C3D4E03',
    },
  },
  {
    name: 'SUV',
    colour: '#059669',
    profile: {
      capacityKWh: 75,
      initialSoc: 35,
      maxPowerW: 11000,
      phases: 3,
      evccid: '0A1B2C3D4E04',
    },
  },
  {
    name: 'Van',
    colour: '#7c3aed',
    profile: {
      capacityKWh: 50,
      initialSoc: 25,
      maxPowerW: 7400,
      phases: 1,
      evccid: '0A1B2C3D4E05',
    },
  },
  {
    name: 'Estate',
    colour: '#0891b2',
    profile: {
      capacityKWh: 64,
      initialSoc: 60,
      maxPowerW: 11000,
      phases: 3,
      evccid: '0A1B2C3D4E06',
    },
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
  | 'waiting'
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
    const target = ev?.profile.targetSoc ?? 100;
    const full = ev !== undefined && ev.soc >= target - 0.5;
    // A full car stays full when the site then gives it nothing (SuspendedEVSE).
    if (state === 'SuspendedEV' || (state === 'SuspendedEVSE' && full)) {
      return { ...view, phase: full ? 'full' : 'suspended' };
    }
    // The station offers nothing: a limit of 0, as when the site's power has run out.
    if (state === 'SuspendedEVSE') return { ...view, phase: 'waiting' };
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

/** The site's power at a moment, by charge point (station id), in W. */
export interface PowerSample {
  at: number;
  byCharger: Record<string, number>;
}

/**
 * SVG paths of the site's power over time, stacked by charge point in the
 * order given: one closed area per charge point, from the oldest sample on
 * the left to the newest on the right, scaled so `maxW` is the top.
 */
export function stackedAreas(
  samples: readonly PowerSample[],
  chargers: readonly string[],
  width: number,
  height: number,
  maxW: number,
): { id: string; d: string }[] {
  if (samples.length < 2 || maxW <= 0) return [];
  const x = (i: number) => Math.round((i / (samples.length - 1)) * width * 10) / 10;
  const y = (w: number) => Math.round((height - (Math.min(w, maxW) / maxW) * height) * 10) / 10;
  const below = samples.map(() => 0);
  return chargers.map((id) => {
    const lower = [...below];
    samples.forEach((sample, i) => {
      below[i] = (below[i] ?? 0) + (sample.byCharger[id] ?? 0);
    });
    const top = below.map((w, i) => `${x(i)},${y(w)}`);
    const bottom = lower.map((w, i) => `${x(i)},${y(w)}`).reverse();
    return { id, d: `M${top.join(' L')} L${bottom.join(' L')} Z` };
  });
}
