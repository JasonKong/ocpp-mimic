/**
 * Sessions of every station: a session tracker per station (core) fed by the
 * recorded frames and the stations' session hints, true samples from the EV
 * model, and the records kept in the State Store (or in memory without one):
 * the latest N per station, with their frames.
 */
import {
  createSessionTracker,
  estimateGap,
  estimateSession,
  msUntilFull,
  priceSession,
  sessionTruth,
  stateDurations,
  type ChargePointSnapshot,
  type ReferenceTariff,
  type SessionPrice,
  type SessionEstimate,
  type SessionHint,
  type SessionRecord,
  type SessionTouch,
  type SessionTracker,
  type SessionTruth,
  type EstimateGap,
} from '@ocpp-mimic/core';
import type { FrameRecord } from './recorder.js';
import type { StateStore } from './state-store.js';

/** What a list of sessions shows of one. */
export interface SessionSummary {
  stationId: string;
  n: number;
  ocpp: SessionRecord['ocpp'];
  state: SessionRecord['state'];
  source: SessionRecord['source'];
  evseId?: number;
  idToken?: SessionRecord['idToken'];
  remoteStartId?: number;
  transactionId?: number | string;
  requestedAt: string;
  startedAt?: string;
  endedAt?: string;
  failure?: SessionRecord['failure'];
  /** Energy delivered so far, in Wh. */
  energyWh: number;
  /** The latest reported SoC. */
  socPercent?: number;
}

export interface SessionDetail {
  session: SessionRecord;
  summary: SessionSummary;
  estimate: SessionEstimate;
  truth?: SessionTruth;
  gap?: EstimateGap;
  /** Milliseconds in each charging state, up to the end or now. */
  durations: ReturnType<typeof stateDurations>;
  /** What the reference tariff makes of the session's reported values. */
  price: SessionPrice;
  /**
   * The station's energy multiplier now. Energy and SoC advance this many
   * times faster than real time, so the estimate's and the truth's times to
   * the target are simulated time: divide them by it for wall-clock time.
   */
  energyMultiplier: number;
}

/** The reference tariff until one is set: an example to edit, not a real price list. */
export const DEFAULT_TARIFF: ReferenceTariff = {
  tariffId: 'reference',
  currency: 'NZD',
  fixedFee: { prices: [{ priceFixed: 1 }] },
  energy: { prices: [{ priceKwh: 0.35 }], taxRates: [{ type: 'GST', tax: 15 }] },
  chargingTime: { prices: [{ priceMinute: 0.02 }] },
  idleTime: { prices: [{ priceMinute: 0.5 }] },
};

export interface SessionServiceOptions {
  store?: StateStore;
  /** Sessions kept per station. Default 20. */
  perStation?: number;
  /** A station's OCPP version and snapshot; undefined once it is gone. */
  station: (id: string) => { ocpp: '1.6' | '2.0.1'; snapshot(): ChargePointSnapshot } | undefined;
  now?: () => number;
  /** How often running sessions are saved at most. Default 30 s. */
  saveEveryMs?: number;
}

export interface SessionService {
  frame(record: FrameRecord): void;
  hint(stationId: string, hint: SessionHint): void;
  /** A station's sessions, newest first. */
  list(stationId: string): SessionSummary[];
  get(stationId: string, n: number): SessionDetail | undefined;
  /** A session's frames, oldest first. */
  frames(stationId: string, n: number): FrameRecord[];
  /** Called with every session that changed. */
  subscribe(listener: (summary: SessionSummary) => void): () => void;
  /** The station was deleted. */
  forget(stationId: string): void;
  /** The reference tariff sessions are priced with. */
  tariff(): ReferenceTariff;
  /** Sets the reference tariff; the caller checks it first (tariffProblems). */
  setTariff(tariff: ReferenceTariff): void;
  /** Saves every session that changed since it was last saved. */
  flush(): void;
  stop(): void;
}

/** Where records live: the State Store, or memory. */
interface Backend {
  load(stationId: string): SessionRecord[];
  get(stationId: string, n: number): SessionRecord | undefined;
  save(items: { record: SessionRecord; frames: FrameRecord[] }[]): void;
  frames(stationId: string, n: number): FrameRecord[];
  merge(stationId: string, from: number, into: number): void;
  /** Keeps the newest `keep` sessions and the protected (open) ones. */
  prune(stationId: string, keep: number, protect: readonly number[]): void;
  forget(stationId: string): void;
}

function storeBackend(store: StateStore): Backend {
  return {
    load: (stationId) => store.loadSessions(stationId),
    get: (stationId, n) => store.loadSession(stationId, n),
    save: (items) => store.saveSessions(items),
    frames: (stationId, n) => store.sessionFrames(stationId, n) as FrameRecord[],
    merge: (stationId, from, into) => store.mergeSession(stationId, from, into),
    prune: (stationId, keep, protect) => store.pruneSessions(stationId, keep, protect),
    // Deleting the station deletes its sessions.
    forget: () => {},
  };
}

function memoryBackend(): Backend {
  const stations = new Map<string, Map<number, { record: SessionRecord; frames: FrameRecord[] }>>();
  const of = (stationId: string) => {
    let sessions = stations.get(stationId);
    if (sessions === undefined) {
      sessions = new Map();
      stations.set(stationId, sessions);
    }
    return sessions;
  };
  return {
    load: (stationId) => [...of(stationId).values()].map((s) => s.record).sort((a, b) => b.n - a.n),
    get: (stationId, n) => stations.get(stationId)?.get(n)?.record,
    save: (items) => {
      for (const { record, frames } of items) {
        const sessions = of(record.stationId);
        const entry = sessions.get(record.n) ?? { record, frames: [] };
        entry.record = record;
        entry.frames.push(...frames);
        sessions.set(record.n, entry);
      }
    },
    frames: (stationId, n) => [...(stations.get(stationId)?.get(n)?.frames ?? [])],
    merge: (stationId, from, into) => {
      const sessions = of(stationId);
      const moved = sessions.get(from)?.frames ?? [];
      sessions.get(into)?.frames.push(...moved);
      sessions.delete(from);
    },
    prune: (stationId, keep, protect) => {
      const sessions = of(stationId);
      const ns = [...sessions.keys()].sort((a, b) => b - a);
      for (const n of ns.slice(keep)) if (!protect.includes(n)) sessions.delete(n);
    },
    forget: (stationId) => stations.delete(stationId),
  };
}

/** The energy delivered so far: from the meter start (or first reading) to the stop (or latest). */
function energyOf(record: SessionRecord): number {
  const readings = record.samples.filter((s) => s.energyWh !== undefined);
  const start = record.meterStartWh ?? readings[0]?.energyWh;
  const stop = record.meterStopWh ?? readings.at(-1)?.energyWh;
  return start === undefined || stop === undefined ? 0 : Math.max(0, stop - start);
}

export function summarize(record: SessionRecord): SessionSummary {
  const soc = [...record.samples].reverse().find((s) => s.socPercent !== undefined)?.socPercent;
  return {
    stationId: record.stationId,
    n: record.n,
    ocpp: record.ocpp,
    state: record.state,
    source: record.source,
    ...(record.evseId !== undefined && { evseId: record.evseId }),
    ...(record.idToken !== undefined && { idToken: record.idToken }),
    ...(record.remoteStartId !== undefined && { remoteStartId: record.remoteStartId }),
    ...(record.transactionId !== undefined && { transactionId: record.transactionId }),
    requestedAt: record.requestedAt,
    ...(record.startedAt !== undefined && { startedAt: record.startedAt }),
    ...(record.endedAt !== undefined && { endedAt: record.endedAt }),
    ...(record.failure !== undefined && { failure: record.failure }),
    energyWh: energyOf(record),
    ...(soc !== undefined && { socPercent: soc }),
  };
}

interface Pending {
  record: SessionRecord;
  frames: FrameRecord[];
}

export function createSessionService(options: SessionServiceOptions): SessionService {
  const backend = options.store === undefined ? memoryBackend() : storeBackend(options.store);
  const perStation = options.perStation ?? 20;
  const now = options.now ?? Date.now;
  const trackers = new Map<string, SessionTracker>();
  /** Sessions changed since they were last saved, by station and n. */
  const dirty = new Map<string, Map<number, Pending>>();
  /** Frames seen recently per station, by seq, for touches that name earlier frames. */
  const recent = new Map<string, Map<number, FrameRecord>>();
  /** Samples and states counted at the last true sample, per open session. */
  const sampled = new WeakMap<SessionRecord, number>();
  const listeners = new Set<(summary: SessionSummary) => void>();
  let tariff =
    (options.store?.loadSetting('tariff') as ReferenceTariff | undefined) ?? DEFAULT_TARIFF;
  const timer = setInterval(() => flushRunning(), options.saveEveryMs ?? 30_000);
  timer.unref();

  function trackerOf(stationId: string): SessionTracker | undefined {
    let tracker = trackers.get(stationId);
    if (tracker !== undefined) return tracker;
    const station = options.station(stationId);
    if (station === undefined) return undefined;
    const stored = backend.load(stationId);
    const open: SessionRecord[] = [];
    const closed: SessionRecord[] = [];
    for (const record of stored) {
      if (record.state === 'running') open.push(record);
      else if (record.state === 'starting') {
        // An authorization does not survive a restart: the start never happens.
        record.state = 'not-started';
        record.failure = { reason: 'StartFailed', detail: 'the engine restarted' };
        record.endedAt = new Date(now()).toISOString();
        closed.push(record);
      }
    }
    if (closed.length > 0) backend.save(closed.map((record) => ({ record, frames: [] })));
    tracker = createSessionTracker({
      stationId,
      ocpp: station.ocpp,
      nextN: (stored[0]?.n ?? 0) + 1,
      open,
      frameCounts: Object.fromEntries(
        open.map((r) => [r.n, backend.frames(stationId, r.n).length]),
      ),
    });
    trackers.set(stationId, tracker);
    return tracker;
  }

  /** A true sample for a running session whose reported samples or states moved on. */
  function sampleTruth(stationId: string, tracker: SessionTracker, record: SessionRecord) {
    if (record.state !== 'running' || record.evseId === undefined) return;
    const count = record.samples.length + record.states.length;
    if (sampled.get(record) === count) return;
    sampled.set(record, count);
    const connector = options
      .station(stationId)
      ?.snapshot()
      .connectors.find((c) => (c.evseId ?? c.connectorId) === record.evseId);
    if (connector?.ev === undefined) return;
    const ev = { profile: connector.ev.profile, soc: connector.ev.soc };
    const until = msUntilFull(ev, connector.offeredW);
    tracker.truth(record.evseId, {
      at: new Date(now()).toISOString(),
      socPercent: connector.ev.soc,
      energyWh: connector.energyWh,
      powerW: connector.powerW,
      ...(until !== undefined && { msUntilFull: until }),
    });
  }

  function apply(stationId: string, tracker: SessionTracker, touches: SessionTouch[]) {
    const frames = recent.get(stationId);
    const finished: Pending[] = [];
    for (const touch of touches) {
      const { session } = touch;
      if (touch.mergedInto !== undefined) {
        const into = dirty.get(stationId)?.get(touch.mergedInto);
        flushOne(stationId, touch.mergedInto, into);
        flushOne(stationId, session.n, dirty.get(stationId)?.get(session.n));
        backend.merge(stationId, session.n, touch.mergedInto);
        continue;
      }
      sampleTruth(stationId, tracker, session);
      let byN = dirty.get(stationId);
      if (byN === undefined) {
        byN = new Map();
        dirty.set(stationId, byN);
      }
      let pending = byN.get(session.n);
      const isNew = pending === undefined && backend.get(stationId, session.n) === undefined;
      if (pending === undefined) {
        pending = { record: session, frames: [] };
        byN.set(session.n, pending);
      }
      pending.record = session;
      for (const seq of touch.frames) {
        const frame = frames?.get(seq);
        if (frame !== undefined) pending.frames.push(frame);
      }
      if (isNew || session.state === 'finished' || session.state === 'not-started') {
        finished.push(pending);
      }
      const summary = summarize(session);
      for (const listener of listeners) listener(summary);
    }
    if (finished.length > 0) {
      for (const pending of finished) dirty.get(stationId)?.delete(pending.record.n);
      backend.save(finished.map((p) => ({ record: p.record, frames: p.frames })));
      for (const pending of finished) pending.frames = [];
      backend.prune(
        stationId,
        perStation,
        tracker.open().map((r) => r.n),
      );
    }
  }

  function flushOne(stationId: string, n: number, pending: Pending | undefined) {
    if (pending === undefined) return;
    dirty.get(stationId)?.delete(n);
    backend.save([{ record: pending.record, frames: pending.frames }]);
  }

  function flushRunning() {
    const items: { record: SessionRecord; frames: FrameRecord[] }[] = [];
    for (const byN of dirty.values()) {
      for (const pending of byN.values())
        items.push({ record: pending.record, frames: pending.frames });
      byN.clear();
    }
    if (items.length > 0) backend.save(items);
  }

  return {
    frame(record) {
      if (record.messageType === undefined) return;
      const tracker = trackerOf(record.stationId);
      if (tracker === undefined) return;
      let frames = recent.get(record.stationId);
      if (frames === undefined) {
        frames = new Map();
        recent.set(record.stationId, frames);
      }
      frames.set(record.seq, record);
      // Earlier frames are only needed by the touches of the next few frames.
      if (frames.size > 50) frames.delete(frames.keys().next().value ?? 0);
      const touches = tracker.frame({
        seq: record.seq,
        at: record.at,
        direction: record.direction,
        messageType: record.messageType,
        ...(record.uniqueId !== undefined && { uniqueId: record.uniqueId }),
        ...(record.action !== undefined && { action: record.action }),
        ...(record.payload !== undefined && { payload: record.payload }),
        ...(record.messageType === 4 && { errorCode: errorCodeOf(record.text) }),
      });
      apply(record.stationId, tracker, touches);
    },
    hint(stationId, hint) {
      const tracker = trackerOf(stationId);
      if (tracker === undefined) return;
      apply(stationId, tracker, tracker.hint(hint, new Date(now()).toISOString()));
    },
    list(stationId) {
      const open = new Map((trackers.get(stationId)?.open() ?? []).map((r) => [r.n, r]));
      const stored = backend.load(stationId).map((r) => open.get(r.n) ?? r);
      const seen = new Set(stored.map((r) => r.n));
      const all = [...stored, ...[...open.values()].filter((r) => !seen.has(r.n))];
      return all.sort((a, b) => b.n - a.n).map(summarize);
    },
    get(stationId, n) {
      const record =
        trackers
          .get(stationId)
          ?.open()
          .find((r) => r.n === n) ??
        dirty.get(stationId)?.get(n)?.record ??
        backend.get(stationId, n);
      if (record === undefined) return undefined;
      const estimate = estimateSession(record);
      const truth = sessionTruth(record);
      const gap = estimateGap(estimate, truth);
      return {
        session: record,
        summary: summarize(record),
        estimate,
        ...(truth !== undefined && { truth }),
        ...(gap !== undefined && { gap }),
        durations: stateDurations(record, new Date(now()).toISOString()),
        price: priceSession(record, tariff, new Date(now()).toISOString()),
        energyMultiplier: options.station(stationId)?.snapshot().energyMultiplier ?? 1,
      };
    },
    frames(stationId, n) {
      const pending = dirty.get(stationId)?.get(n)?.frames ?? [];
      return [...backend.frames(stationId, n), ...pending];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    forget(stationId) {
      trackers.delete(stationId);
      dirty.delete(stationId);
      recent.delete(stationId);
      backend.forget(stationId);
    },
    tariff: () => tariff,
    setTariff(value) {
      tariff = value;
      options.store?.saveSetting('tariff', value);
    },
    flush: flushRunning,
    stop() {
      clearInterval(timer);
      flushRunning();
    },
  };
}

/** The errorCode of a CALLERROR frame's text. */
function errorCodeOf(text: string): string {
  try {
    const frame: unknown = JSON.parse(text);
    return Array.isArray(frame) && typeof frame[2] === 'string' ? frame[2] : '';
  } catch {
    return '';
  }
}
