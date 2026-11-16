/**
 * Charging sessions, built from what a station puts on the wire (its frames,
 * as the CSMS sees them) and from what it says about its own decisions
 * (session hints: who may charge and why, and starts that never became a
 * transaction). Frames give the start timeline, the meter samples, the
 * charging states and the CSMS's costs; hints give the start source, which a
 * 1.6 StartTransaction does not carry, and failures that leave no frame.
 *
 * A session begins with the first frame or hint of a start (a remote start,
 * an Authorize, a card accepted locally, or a 2.0.1 TransactionEvent
 * Started) and ends when the CSMS answers StopTransaction or TransactionEvent
 * Ended. A start that never becomes a transaction ends as not-started.
 */

import type { OcppVersion } from './message-set.js';
/**
 * How a session started: a card at the station, a remote start, no
 * authorization, or an ad hoc payment (2.1: an idToken of type DirectPayment,
 * from a payment terminal or a web payment the CSMS started).
 */
export type SessionSource = 'local' | 'remote' | 'noAuth' | 'payment';
export type SessionState = 'starting' | 'running' | 'finished' | 'not-started';
export type StartFailure = 'Rejected' | 'NotAuthorized' | 'ConnectionTimeout' | 'StartFailed';
export type SessionOcpp = OcppVersion;
export type SessionFrameDirection = 'cp-to-csms' | 'csms-to-cp';
export type ChargingStateLabel = 'charging' | 'suspendedEV' | 'suspendedEVSE' | 'idle';
export type Phase = 'L1' | 'L2' | 'L3';

/** An idTag (1.6, no type) or an idToken with its type (2.0.1). */
export interface SessionIdToken {
  idToken: string;
  type?: string;
}

/** What a station adapter says about a start. */
export type SessionHint =
  | {
      kind: 'authorized';
      evseId: number;
      idToken: SessionIdToken;
      source: SessionSource;
      remoteStartId?: number;
    }
  | {
      kind: 'start-failed';
      evseId: number;
      idToken: SessionIdToken;
      source: SessionSource;
      reason: Exclude<StartFailure, 'Rejected'>;
      detail?: string;
    };

/** A frame as the recorder keeps it: responses carry their request's action. */
export interface SessionFrame {
  seq: number;
  at: string;
  direction: SessionFrameDirection;
  /** 2 = CALL, 3 = CALLRESULT, 4 = CALLERROR. */
  messageType?: 2 | 3 | 4;
  uniqueId?: string;
  action?: string;
  payload?: unknown;
  /** CALLERROR only. */
  errorCode?: string;
}

export interface TimelineStep {
  seq: number;
  at: string;
  action: string;
  direction: SessionFrameDirection;
  messageType: 2 | 3 | 4;
  /** An answer's status, a TransactionEvent's `eventType triggerReason`, or an errorCode. */
  status?: string;
  /** Milliseconds since the previous step. */
  sincePreviousMs?: number;
}

export interface ReportedSample {
  at: string;
  seq: number;
  /** ReadingContext, e.g. Sample.Periodic or Transaction.Begin. */
  context?: string;
  energyWh?: number;
  powerW?: number;
  offeredW?: number;
  socPercent?: number;
  currentA?: Partial<Record<Phase, number>>;
  voltageV?: Partial<Record<Phase, number>>;
}

/** The simulator's ground truth at a moment, from the EV model. */
export interface TrueSample {
  at: string;
  socPercent: number;
  energyWh: number;
  powerW: number;
  /** Until the EV reaches its target under the current offered power; absent when it never will. */
  msUntilFull?: number;
}

export interface SessionCost {
  at: string;
  seq: number;
  totalCost: number;
  from: 'TransactionEventResponse' | 'CostUpdated';
}

export interface SessionRecord {
  stationId: string;
  /** Per station, counting up. */
  n: number;
  ocpp: SessionOcpp;
  /** The connectorId in 1.6; absent while unknown (a remote start for any EVSE). */
  evseId?: number;
  connectorId?: number;
  state: SessionState;
  source: SessionSource;
  idToken?: SessionIdToken;
  remoteStartId?: number;
  transactionId?: number | string;
  requestedAt: string;
  startedAt?: string;
  endedAt?: string;
  failure?: { reason: StartFailure; detail?: string };
  timeline: TimelineStep[];
  samples: ReportedSample[];
  truth: TrueSample[];
  /** Charging state changes, each with the frame that reported it. */
  states: { at: string; state: ChargingStateLabel; seq?: number }[];
  meterStartWh?: number;
  meterStopWh?: number;
  /** The frames meterStartWh and meterStopWh came from. */
  meterStartSeq?: number;
  meterStopSeq?: number;
  /** The NotifyEVChargingNeeds payload's chargingNeeds (2.0.1). */
  chargingNeeds?: Record<string, unknown>;
  costs: SessionCost[];
  /** 2.1: the ad hoc payment's settlement (NotifySettlement, C19 to C22). */
  settlement?: SessionSettlement;
  stopReason?: string;
  /** Periodic meter frames past the frame limit were not kept. */
  framesTruncated?: true;
}

/** A NotifySettlement for the session's DirectPayment token. */
export interface SessionSettlement {
  at: string;
  seq: number;
  pspRef: string;
  status: string;
  amount: number;
  statusInfo?: string;
  receiptId?: string;
  receiptUrl?: string;
  vatNumber?: string;
}

/** A session a frame or hint touched, with the frames that belong to it. */
export interface SessionTouch {
  session: SessionRecord;
  /** Seqs of frames to keep with the session. */
  frames: number[];
  /** The session was merged into the session with this n and is gone; its frames belong there. */
  mergedInto?: number;
}

export interface SessionTrackerOptions {
  stationId: string;
  ocpp: SessionOcpp;
  /** The n of the first new session. */
  nextN?: number;
  /** Samples kept per session; past it, every other one is dropped. Default 2,000. */
  maxSamples?: number;
  /** Frames kept per session before periodic meter frames are left out. Default 2,000. */
  maxFrames?: number;
  /** Sessions still open from before a restart. */
  open?: SessionRecord[];
  /** Frames already kept per open session, by n. */
  frameCounts?: Record<number, number>;
}

export interface SessionTracker {
  /** Feeds a frame; returns the sessions it touched. */
  frame(frame: SessionFrame): SessionTouch[];
  /** Feeds a hint from the station adapter. */
  hint(hint: SessionHint, at: string): SessionTouch[];
  /** Adds a true sample to the open session on `evseId`. */
  truth(evseId: number, sample: TrueSample): SessionTouch[];
  /** Sessions starting or running. */
  open(): SessionRecord[];
  /** The n the next session gets. */
  nextN(): number;
}

interface Internal {
  /** The source came from a hint, RemoteStart or a token, not from the default. */
  sourceKnown: boolean;
  /** The start timeline is complete. */
  timelineClosed: boolean;
  frames: number;
}

/** An Authorize not yet tied to a session: the card's EVSE is known once the station decides. */
interface LooseAuthorize {
  token: SessionIdToken;
  steps: { frame: SessionFrame; status?: string }[];
}

interface PendingCall {
  frame: SessionFrame;
  sessions: SessionRecord[];
  loose?: LooseAuthorize;
}

/** Calls waiting for an answer, and Authorizes waiting for a hint, kept at most. */
const MAX_PENDING = 1000;
const MAX_LOOSE = 10;
const MAX_RECENT = 10;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const sameToken = (a: SessionIdToken | undefined, b: SessionIdToken | undefined) =>
  a !== undefined &&
  b !== undefined &&
  a.idToken === b.idToken &&
  (a.type === undefined || b.type === undefined || a.type === b.type);

/** 1.6 statuses and 2.0.1 charging states as the four states a session tracks. */
export function chargingStateLabel(value: string): ChargingStateLabel | undefined {
  switch (value) {
    case 'Charging':
      return 'charging';
    case 'SuspendedEV':
      return 'suspendedEV';
    case 'SuspendedEVSE':
      return 'suspendedEVSE';
    case 'Finishing':
    case 'Preparing':
    case 'EVConnected':
    case 'Idle':
      return 'idle';
    default:
      return undefined;
  }
}

const ENERGY = 'Energy.Active.Import.Register';
const PHASES: Record<string, Phase> = {
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  'L1-N': 'L1',
  'L2-N': 'L2',
  'L3-N': 'L3',
};

/** The sampled values of a 1.6 or 2.0.1 MeterValue list as samples. */
export function meterSamples(meterValue: unknown, seq: number): ReportedSample[] {
  if (!Array.isArray(meterValue)) return [];
  const samples: ReportedSample[] = [];
  for (const entry of meterValue) {
    if (!isObject(entry) || !Array.isArray(entry.sampledValue)) continue;
    const sample: ReportedSample = { at: str(entry.timestamp) ?? '', seq };
    for (const value of entry.sampledValue) {
      if (!isObject(value)) continue;
      const location = str(value.location);
      if (location === 'Inlet' || location === 'Body') continue;
      const raw = typeof value.value === 'number' ? value.value : Number(str(value.value));
      if (!Number.isFinite(raw)) continue;
      // 1.6 has `unit`; 2.0.1 has `unitOfMeasure` with a power-of-ten multiplier.
      const measure = isObject(value.unitOfMeasure) ? value.unitOfMeasure : undefined;
      const unit = str(value.unit) ?? str(measure?.unit);
      const scaled = raw * 10 ** (num(measure?.multiplier) ?? 0);
      const kilo = unit === 'kWh' || unit === 'kW' ? 1000 : 1;
      const context = str(value.context);
      if (context !== undefined) sample.context = context;
      const phase = PHASES[str(value.phase) ?? ''];
      switch (str(value.measurand) ?? ENERGY) {
        case ENERGY:
          if (phase === undefined) sample.energyWh = scaled * kilo;
          break;
        case 'Power.Active.Import':
          if (phase === undefined) sample.powerW = scaled * kilo;
          break;
        case 'Power.Offered':
          if (phase === undefined) sample.offeredW = scaled * kilo;
          break;
        case 'SoC':
          sample.socPercent = scaled;
          break;
        case 'Current.Import':
          sample.currentA = { ...sample.currentA, [phase ?? 'L1']: scaled };
          break;
        case 'Voltage':
          sample.voltageV = { ...sample.voltageV, [phase ?? 'L1']: scaled };
          break;
      }
    }
    samples.push(sample);
  }
  return samples;
}

/** Time spent in each state from the transaction's start to its end (or `now`). */
export function stateDurations(
  record: SessionRecord,
  now: string,
): Record<ChargingStateLabel, number> {
  const totals: Record<ChargingStateLabel, number> = {
    charging: 0,
    suspendedEV: 0,
    suspendedEVSE: 0,
    idle: 0,
  };
  if (record.startedAt === undefined) return totals;
  const start = Date.parse(record.startedAt);
  const end = Date.parse(record.endedAt ?? now);
  let state: ChargingStateLabel = 'idle';
  let since = start;
  for (const change of record.states) {
    const at = Date.parse(change.at);
    if (at > since) {
      totals[state] += Math.min(at, end) - since;
      since = Math.min(at, end);
    }
    state = change.state;
  }
  if (end > since) totals[state] += end - since;
  return totals;
}

const PERIODIC = new Set(['MeterValuePeriodic', 'MeterValueClock']);

export function createSessionTracker(options: SessionTrackerOptions): SessionTracker {
  const { stationId, ocpp } = options;
  const maxSamples = options.maxSamples ?? 2000;
  const maxFrames = options.maxFrames ?? 2000;
  let n = options.nextN ?? 1;
  const open: SessionRecord[] = [];
  const internal = new WeakMap<SessionRecord, Internal>();
  const pending = new Map<string, PendingCall>();
  const loose: LooseAuthorize[] = [];
  /** Sessions that just ended as not-started, for hints that arrive after the frame that failed them. */
  const recent: SessionRecord[] = [];
  /** Sessions that finished lately: a settlement comes after the end (C21). */
  const ended: SessionRecord[] = [];

  for (const session of options.open ?? []) {
    open.push(session);
    internal.set(session, {
      sourceKnown: true,
      timelineClosed: session.state === 'running',
      frames: options.frameCounts?.[session.n] ?? 0,
    });
    n = Math.max(n, session.n + 1);
  }

  const info = (session: SessionRecord): Internal => {
    let entry = internal.get(session);
    if (entry === undefined) {
      entry = { sourceKnown: false, timelineClosed: false, frames: 0 };
      internal.set(session, entry);
    }
    return entry;
  };

  function create(at: string, source: SessionSource, sourceKnown: boolean): SessionRecord {
    const session: SessionRecord = {
      stationId,
      n: n++,
      ocpp,
      state: 'starting',
      source,
      requestedAt: at,
      timeline: [],
      samples: [],
      truth: [],
      states: [],
      costs: [],
    };
    internal.set(session, { sourceKnown, timelineClosed: false, frames: 0 });
    open.push(session);
    return session;
  }

  function close(session: SessionRecord, state: 'finished' | 'not-started'): void {
    session.state = state;
    const index = open.indexOf(session);
    if (index >= 0) open.splice(index, 1);
    if (state === 'finished') {
      ended.push(session);
      if (ended.length > MAX_RECENT) ended.shift();
    }
  }

  function fail(session: SessionRecord, reason: StartFailure, at: string, detail?: string) {
    session.failure = { reason, ...(detail !== undefined && detail !== '' && { detail }) };
    session.endedAt ??= at;
    close(session, 'not-started');
    recent.push(session);
    if (recent.length > MAX_RECENT) recent.shift();
  }

  function setSource(session: SessionRecord, source: SessionSource) {
    session.source = source;
    info(session).sourceKnown = true;
  }

  function setEvse(session: SessionRecord, evseId: number | undefined, connectorId?: number) {
    if (evseId === undefined || evseId <= 0) return;
    session.evseId = evseId;
    session.connectorId = connectorId ?? session.connectorId ?? evseId;
  }

  const stepOf = (frame: SessionFrame, status?: string): TimelineStep => ({
    seq: frame.seq,
    at: frame.at,
    action: frame.action ?? '',
    direction: frame.direction,
    messageType: frame.messageType ?? 2,
    ...(status !== undefined && { status }),
  });

  function addStep(session: SessionRecord, frame: SessionFrame, status?: string) {
    if (info(session).timelineClosed || frame.messageType === undefined) return;
    const step = stepOf(frame, status);
    const previous = session.timeline.at(-1);
    if (previous !== undefined)
      step.sincePreviousMs = Date.parse(step.at) - Date.parse(previous.at);
    session.timeline.push(step);
  }

  /** Puts earlier steps (a loose Authorize) into a timeline, in frame order. */
  function mergeSteps(session: SessionRecord, steps: TimelineStep[]) {
    const all = [...session.timeline, ...steps].sort((a, b) => a.seq - b.seq);
    session.timeline = all.map((step, i) => {
      const { sincePreviousMs: _drop, ...rest } = step;
      const previous = all[i - 1];
      return previous === undefined
        ? rest
        : { ...rest, sincePreviousMs: Date.parse(step.at) - Date.parse(previous.at) };
    });
    if (session.requestedAt > (all[0]?.at ?? session.requestedAt)) {
      session.requestedAt = all[0]?.at ?? session.requestedAt;
    }
  }

  function takeLoose(token: SessionIdToken): LooseAuthorize | undefined {
    for (let i = loose.length - 1; i >= 0; i--) {
      if (sameToken(loose[i]?.token, token)) return loose.splice(i, 1)[0];
    }
    return undefined;
  }

  /** Ties a loose Authorize to its session: its steps and frames. */
  function adopt(session: SessionRecord, entry: LooseAuthorize | undefined) {
    if (entry === undefined) return;
    if (!info(session).timelineClosed)
      mergeSteps(
        session,
        entry.steps.map((s) => stepOf(s.frame, s.status)),
      );
    for (const step of entry.steps) touch(session, step.frame);
  }

  function addSamples(session: SessionRecord, samples: ReportedSample[]) {
    for (const sample of samples) {
      session.samples.push(sample);
      if (sample.energyWh !== undefined) {
        if (sample.context === 'Transaction.Begin' && session.meterStartWh === undefined) {
          session.meterStartWh = sample.energyWh;
          session.meterStartSeq = sample.seq;
        }
        if (sample.context === 'Transaction.End') {
          session.meterStopWh = sample.energyWh;
          session.meterStopSeq = sample.seq;
        }
      }
    }
    if (session.samples.length > maxSamples) {
      session.samples = session.samples.filter((_, i) => i % 2 === 0);
    }
  }

  function addState(
    session: SessionRecord,
    frame: SessionFrame,
    at: string,
    value: string | undefined,
  ) {
    const state = value === undefined ? undefined : chargingStateLabel(value);
    if (state === undefined || session.states.at(-1)?.state === state) return;
    session.states.push({ at, state, seq: frame.seq });
  }

  const openOn = (evseId: number | undefined) =>
    evseId === undefined ? undefined : open.find((s) => s.evseId === evseId);
  const byTransaction = (transactionId: unknown) =>
    transactionId === undefined
      ? undefined
      : open.find((s) => s.transactionId !== undefined && s.transactionId === transactionId);
  /** A starting session for this token, on this EVSE or not yet on any. */
  const startingFor = (token: SessionIdToken, evseId?: number, source?: SessionSource) =>
    open.find(
      (s) =>
        s.state === 'starting' &&
        sameToken(s.idToken, token) &&
        (source === undefined || s.source === source || !info(s).sourceKnown) &&
        (s.evseId === undefined || evseId === undefined || s.evseId === evseId),
    );

  const touches = new Map<SessionRecord, SessionTouch>();
  function touch(session: SessionRecord, frame?: SessionFrame, keep = true) {
    let entry = touches.get(session);
    if (entry === undefined) {
      entry = { session, frames: [] };
      touches.set(session, entry);
    }
    if (frame === undefined) return;
    const meta = info(session);
    if (!keep && meta.frames >= maxFrames) {
      session.framesTruncated = true;
      return;
    }
    meta.frames++;
    entry.frames.push(frame.seq);
  }
  function flush(): SessionTouch[] {
    const out = [...touches.values()];
    touches.clear();
    return out;
  }

  /** Whether a frame is a periodic meter frame, which may be left out past the limit. */
  function periodic(frame: SessionFrame, request?: SessionFrame): boolean {
    const call = request ?? frame;
    if (call.action === 'MeterValues') return true;
    if (call.action !== 'TransactionEvent' || !isObject(call.payload)) return false;
    return (
      call.payload.eventType === 'Updated' && PERIODIC.has(str(call.payload.triggerReason) ?? '')
    );
  }

  function tokenOf(payload: Record<string, unknown>): SessionIdToken | undefined {
    if (typeof payload.idTag === 'string') return { idToken: payload.idTag };
    if (isObject(payload.idToken) && typeof payload.idToken.idToken === 'string') {
      const type = str(payload.idToken.type);
      return { idToken: payload.idToken.idToken, ...(type !== undefined && { type }) };
    }
    return undefined;
  }

  function sourceOfToken(token: SessionIdToken): SessionSource {
    if (token.type === 'DirectPayment') return 'payment';
    return token.type === 'NoAuthorization' ? 'noAuth' : 'local';
  }

  /** A remote start with a DirectPayment token is a web payment (C24, C25). */
  const remoteSource = (token: SessionIdToken | undefined): SessionSource =>
    token?.type === 'DirectPayment' ? 'payment' : 'remote';

  // ---- CALLs ----------------------------------------------------------------

  function onCall(frame: SessionFrame, payload: Record<string, unknown>): SessionRecord[] {
    switch (frame.action) {
      case 'RemoteStartTransaction':
      case 'RequestStartTransaction': {
        const token = tokenOf(payload);
        const evseId = num(
          frame.action === 'RemoteStartTransaction' ? payload.connectorId : payload.evseId,
        );
        const remoteStartId = num(payload.remoteStartId);
        // A running 2.0.1 transaction without a token yet takes this one.
        const waiting = open.find(
          (s) => s.state === 'running' && s.evseId === evseId && s.idToken === undefined,
        );
        const session = waiting ?? create(frame.at, remoteSource(token), true);
        setSource(session, remoteSource(token));
        setEvse(session, evseId);
        if (token !== undefined) session.idToken = token;
        if (remoteStartId !== undefined) session.remoteStartId = remoteStartId;
        addStep(session, frame);
        return [session];
      }
      case 'Authorize': {
        const token = tokenOf(payload);
        if (token === undefined) return [];
        // A card at a running session stops it; one for a remote start authorizes it.
        const running = open.find((s) => s.state === 'running' && sameToken(s.idToken, token));
        if (running !== undefined) return [running];
        const starting = startingFor(token);
        if (starting !== undefined) {
          addStep(starting, frame);
          return [starting];
        }
        return [];
      }
      case 'StartTransaction': {
        const token = tokenOf(payload);
        const connectorId = num(payload.connectorId);
        const session =
          open.find((s) => s.state === 'starting' && s.evseId === connectorId) ??
          (token === undefined ? undefined : startingFor(token, connectorId)) ??
          create(frame.at, 'local', false);
        setEvse(session, connectorId);
        if (token !== undefined) session.idToken ??= token;
        const meterStart = num(payload.meterStart);
        if (meterStart !== undefined) {
          session.meterStartWh = meterStart;
          session.meterStartSeq = frame.seq;
        }
        session.startedAt = str(payload.timestamp) ?? frame.at;
        addStep(session, frame);
        return [session];
      }
      case 'MeterValues': {
        const session =
          byTransaction(payload.transactionId) ??
          openOn(num(payload.connectorId) ?? num(payload.evseId));
        if (session === undefined) return [];
        addSamples(session, meterSamples(payload.meterValue, frame.seq));
        return [session];
      }
      case 'StatusNotification': {
        const session = openOn(num(payload.evseId) ?? num(payload.connectorId));
        if (session === undefined) return [];
        // 1.6 statuses carry the charging state; 2.0.1 has chargingState in TransactionEvent.
        if (ocpp === '1.6')
          addState(session, frame, str(payload.timestamp) ?? frame.at, str(payload.status));
        return [session];
      }
      case 'StopTransaction': {
        const session =
          byTransaction(payload.transactionId) ??
          open.find((s) => s.state === 'running' && s.transactionId === undefined);
        if (session === undefined) return [];
        const meterStop = num(payload.meterStop);
        if (meterStop !== undefined) {
          session.meterStopWh = meterStop;
          session.meterStopSeq = frame.seq;
        }
        session.endedAt = str(payload.timestamp) ?? frame.at;
        session.stopReason = str(payload.reason) ?? 'Local';
        addSamples(session, meterSamples(payload.transactionData, frame.seq));
        return [session];
      }
      case 'TransactionEvent':
        return onTransactionEvent(frame, payload);
      case 'CostUpdated': {
        const session = byTransaction(payload.transactionId);
        const totalCost = num(payload.totalCost);
        if (session === undefined || totalCost === undefined) return [];
        session.costs.push({ at: frame.at, seq: frame.seq, totalCost, from: 'CostUpdated' });
        return [session];
      }
      case 'NotifySettlement': {
        const pspRef = str(payload.pspRef);
        const transactionId = str(payload.transactionId);
        const amount = num(payload.settlementAmount);
        const status = str(payload.status);
        if (pspRef === undefined || amount === undefined || status === undefined) return [];
        const paidWith = (s: SessionRecord) =>
          s.idToken?.idToken === pspRef && s.idToken.type === 'DirectPayment';
        const session =
          byTransaction(transactionId) ??
          [...ended, ...recent]
            .reverse()
            .find((s) =>
              transactionId === undefined ? paidWith(s) : s.transactionId === transactionId,
            ) ??
          open.find(paidWith);
        if (session === undefined) return [];
        const optional = (name: string) => str(payload[name]);
        const statusInfo = optional('statusInfo');
        const receiptId = optional('receiptId');
        const receiptUrl = optional('receiptUrl');
        const vatNumber = optional('vatNumber');
        session.settlement = {
          at: str(payload.settlementTime) ?? frame.at,
          seq: frame.seq,
          pspRef,
          status,
          amount,
          ...(statusInfo !== undefined && { statusInfo }),
          ...(receiptId !== undefined && { receiptId }),
          ...(receiptUrl !== undefined && { receiptUrl }),
          ...(vatNumber !== undefined && { vatNumber }),
        };
        return [session];
      }
      case 'NotifyEVChargingNeeds': {
        const session = openOn(num(payload.evseId));
        if (session === undefined) return [];
        if (isObject(payload.chargingNeeds)) session.chargingNeeds = payload.chargingNeeds;
        addStep(session, frame);
        return [session];
      }
      default:
        return [];
    }
  }

  function onTransactionEvent(
    frame: SessionFrame,
    payload: Record<string, unknown>,
  ): SessionRecord[] {
    const tx = isObject(payload.transactionInfo) ? payload.transactionInfo : {};
    const transactionId = str(tx.transactionId);
    const evse = isObject(payload.evse) ? payload.evse : {};
    const evseId = num(evse.id);
    const token = tokenOf(payload);
    const remoteStartId = num(tx.remoteStartId);
    const trigger = str(payload.triggerReason);
    const eventType = str(payload.eventType);
    let session = byTransaction(transactionId);
    if (session === undefined) {
      session =
        (remoteStartId === undefined
          ? undefined
          : open.find((s) => s.state === 'starting' && s.remoteStartId === remoteStartId)) ??
        open.find((s) => s.state === 'starting' && evseId !== undefined && s.evseId === evseId) ??
        (token === undefined ? undefined : startingFor(token, evseId)) ??
        open.find(
          (s) =>
            s.state === 'starting' &&
            s.evseId === undefined &&
            (s.source === 'remote' || (s.source === 'payment' && s.remoteStartId !== undefined)),
        ) ??
        create(frame.at, token === undefined ? 'local' : sourceOfToken(token), token !== undefined);
      if (transactionId !== undefined) session.transactionId = transactionId;
      session.state = 'running';
      session.startedAt ??= str(payload.timestamp) ?? frame.at;
    }
    setEvse(session, evseId, num(evse.connectorId));
    if (token !== undefined && session.idToken === undefined) {
      session.idToken = token;
      if (!info(session).sourceKnown) setSource(session, sourceOfToken(token));
    }
    if (remoteStartId !== undefined || trigger === 'RemoteStart') {
      setSource(session, remoteSource(session.idToken));
      if (remoteStartId !== undefined) session.remoteStartId = remoteStartId;
    }
    addState(session, frame, str(payload.timestamp) ?? frame.at, str(tx.chargingState));
    addSamples(session, meterSamples(payload.meterValue, frame.seq));
    if (eventType === 'Ended') {
      session.endedAt = str(payload.timestamp) ?? frame.at;
      session.stopReason = str(tx.stoppedReason) ?? 'Local';
    }
    addStep(session, frame, [eventType, trigger].filter(Boolean).join(' '));
    return [session];
  }

  // ---- Answers --------------------------------------------------------------

  function statusOf(payload: unknown): string | undefined {
    if (!isObject(payload)) return undefined;
    if (typeof payload.status === 'string') return payload.status;
    for (const key of ['idTagInfo', 'idTokenInfo']) {
      const info = payload[key];
      if (isObject(info) && typeof info.status === 'string') return info.status;
    }
    return undefined;
  }

  function onAnswer(frame: SessionFrame, call: PendingCall): SessionRecord[] {
    const request = call.frame;
    const requestPayload = isObject(request.payload) ? request.payload : {};
    const payload = isObject(frame.payload) ? frame.payload : {};
    const error = frame.messageType === 4;
    const status = error ? frame.errorCode : statusOf(payload);
    const out: SessionRecord[] = [];
    for (const session of call.sessions) {
      out.push(session);
      // An answer joins the timeline when its request did.
      if (session.timeline.some((step) => step.seq === request.seq))
        addStep(session, frame, status);
      switch (request.action) {
        case 'RemoteStartTransaction':
        case 'RequestStartTransaction': {
          if (error || status === 'Rejected') {
            if (session.state === 'starting')
              fail(session, 'Rejected', frame.at, error ? status : undefined);
            break;
          }
          const transactionId = str(payload.transactionId);
          const running = byTransaction(transactionId);
          if (running !== undefined && running !== session) {
            // The token went to a transaction that was already running (2.0.1, F02).
            if (session.idToken !== undefined) running.idToken ??= session.idToken;
            setSource(running, remoteSource(running.idToken));
            if (session.remoteStartId !== undefined) running.remoteStartId = session.remoteStartId;
            mergeSteps(running, session.timeline);
            close(session, 'not-started');
            touches.set(session, { session, frames: [], mergedInto: running.n });
            out.push(running);
          }
          break;
        }
        case 'Authorize':
          if (
            session.state === 'starting' &&
            (error || (status !== undefined && status !== 'Accepted'))
          ) {
            fail(session, 'NotAuthorized', frame.at, status);
          }
          break;
        case 'StartTransaction': {
          const transactionId = num(payload.transactionId);
          if (transactionId !== undefined) session.transactionId = transactionId;
          if (!error) {
            if (session.state === 'starting') session.state = 'running';
            info(session).timelineClosed = true;
          }
          break;
        }
        case 'StopTransaction':
          if (!error) close(session, 'finished');
          break;
        case 'NotifySettlement': {
          // With ReceiptByCSMS, the CSMS gives the receipt (C21.FR.03).
          const receiptUrl = str(payload.receiptUrl);
          const receiptId = str(payload.receiptId);
          if (session.settlement === undefined || error) break;
          if (receiptUrl !== undefined) session.settlement.receiptUrl = receiptUrl;
          if (receiptId !== undefined) session.settlement.receiptId = receiptId;
          break;
        }
        case 'TransactionEvent': {
          const totalCost = num(payload.totalCost);
          if (totalCost !== undefined) {
            session.costs.push({
              at: frame.at,
              seq: frame.seq,
              totalCost,
              from: 'TransactionEventResponse',
            });
          }
          if (error) break;
          if (requestPayload.eventType === 'Ended') close(session, 'finished');
          else if (session.transactionId !== undefined && session.idToken !== undefined) {
            info(session).timelineClosed = true;
          }
          break;
        }
      }
    }
    return out;
  }

  // ---- Hints ----------------------------------------------------------------

  /** A loose Authorize answered: a refused card ends as a not-started local session. */
  function onLooseAnswer(frame: SessionFrame, entry: LooseAuthorize) {
    const status = frame.messageType === 4 ? frame.errorCode : statusOf(frame.payload);
    entry.steps.push({ frame, ...(status !== undefined && { status }) });
    if (frame.messageType === 3 && status === 'Accepted') return;
    loose.splice(loose.indexOf(entry), 1);
    const first = entry.steps[0]?.frame ?? frame;
    const session = create(first.at, sourceOfToken(entry.token), true);
    session.idToken = entry.token;
    adopt(session, entry);
    fail(session, 'NotAuthorized', frame.at, status);
  }

  function onHint(hint: SessionHint, at: string): SessionRecord {
    if (hint.kind === 'start-failed') {
      const failed = [...recent]
        .reverse()
        .find(
          (s) =>
            sameToken(s.idToken, hint.idToken) &&
            (s.evseId === undefined || s.evseId === hint.evseId),
        );
      if (failed !== undefined) {
        setEvse(failed, hint.evseId);
        return failed;
      }
    }
    const entry = takeLoose(hint.idToken);
    const session =
      startingFor(hint.idToken, hint.evseId, hint.source) ??
      open.find(
        (s) =>
          s.state === 'running' && s.evseId === hint.evseId && sameToken(s.idToken, hint.idToken),
      ) ??
      open.find(
        (s) =>
          s.state === 'running' &&
          s.evseId === hint.evseId &&
          s.idToken === undefined &&
          !info(s).sourceKnown,
      ) ??
      create(entry?.steps[0]?.frame.at ?? at, hint.source, true);
    adopt(session, entry);
    setSource(session, hint.source);
    setEvse(session, hint.evseId);
    session.idToken =
      session.idToken?.type === undefined && hint.idToken.type !== undefined
        ? hint.idToken
        : (session.idToken ?? hint.idToken);
    if (hint.kind === 'authorized') {
      if (hint.remoteStartId !== undefined) session.remoteStartId = hint.remoteStartId;
    } else if (session.state === 'starting') {
      fail(session, hint.reason, at, hint.detail);
    }
    return session;
  }

  return {
    frame(frame) {
      const payload = isObject(frame.payload) ? frame.payload : {};
      if (frame.messageType === 2) {
        const sessions = onCall(frame, payload);
        let entry: LooseAuthorize | undefined;
        if (frame.action === 'Authorize' && sessions.length === 0) {
          const token = tokenOf(payload);
          if (token !== undefined) {
            entry = { token, steps: [{ frame }] };
            loose.push(entry);
            if (loose.length > MAX_LOOSE) loose.shift();
          }
        }
        if (frame.uniqueId !== undefined && (sessions.length > 0 || entry !== undefined)) {
          pending.set(`${frame.direction}:${frame.uniqueId}`, {
            frame,
            sessions,
            ...(entry !== undefined && { loose: entry }),
          });
          if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value ?? '');
        }
        const keep = !periodic(frame);
        for (const session of sessions) touch(session, frame, keep);
      } else if (frame.messageType === 3 || frame.messageType === 4) {
        const requestDirection: SessionFrameDirection =
          frame.direction === 'cp-to-csms' ? 'csms-to-cp' : 'cp-to-csms';
        const key = `${requestDirection}:${frame.uniqueId ?? ''}`;
        const call = pending.get(key);
        if (call !== undefined) {
          pending.delete(key);
          if (call.loose !== undefined) onLooseAnswer(frame, call.loose);
          const keep = !periodic(frame, call.frame);
          for (const session of onAnswer(frame, call)) {
            if (touches.get(session)?.mergedInto === undefined) touch(session, frame, keep);
          }
        }
      }
      return flush();
    },
    hint(hint, at) {
      touch(onHint(hint, at));
      return flush();
    },
    truth(evseId, sample) {
      const session = openOn(evseId);
      if (session === undefined) return [];
      session.truth.push(sample);
      if (session.truth.length > maxSamples) {
        session.truth = session.truth.filter((_, i) => i % 2 === 0);
      }
      touch(session);
      return flush();
    },
    open: () => [...open],
    nextN: () => n,
  };
}
