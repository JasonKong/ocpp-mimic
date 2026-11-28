/**
 * Event Recorder: every OCPP frame a charge point sends or receives, plus its
 * log lines, kept per station in a bounded buffer. Responses are matched to
 * their request so every frame carries an action.
 */
import { MessageTypeId, parseFrame, type OcppVersion } from '@ocpp-mimic/core';

export type Direction = 'cp-to-csms' | 'csms-to-cp';

export interface FrameRecord {
  kind: 'frame';
  seq: number;
  stationId: string;
  at: string;
  direction: Direction;
  /**
   * 2 = CALL, 3 = CALLRESULT, 4 = CALLERROR, and in 2.1 5 = CALLRESULTERROR
   * and 6 = SEND; undefined for unreadable text.
   */
  messageType?: 2 | 3 | 4 | 5 | 6;
  uniqueId?: string;
  action?: string;
  payload?: unknown;
  /**
   * Problems the official OCA JSON Schema found in the payload. Absent when
   * it passed, or when no schema applies (CALLERROR, unknown action).
   */
  schemaErrors?: string[];
  /** The fault injection that changed, made or kept back this frame; its schema is not checked. */
  injected?: string;
  /** The frame never reached the other side (dropped, or a CALL left unanswered). */
  dropped?: true;
  /** The station's OCPP version, when the recorder knows it. */
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

export interface RecordQuery {
  limit?: number;
  /** Only frames of this action. */
  action?: string;
  kind?: RecordEntry['kind'];
}

export interface Recorder {
  frame(
    stationId: string,
    direction: Direction,
    text: string,
    marks?: { injected?: string; dropped?: true },
  ): FrameRecord;
  log(stationId: string, message: string): LogRecord;
  /** Entries for a station, oldest first. */
  query(stationId: string, query?: RecordQuery): RecordEntry[];
  forget(stationId: string): void;
  /** The station's connection went: CALLs still waiting for an answer never get one on it. */
  closed(stationId: string): void;
  subscribe(listener: (entry: RecordEntry) => void): () => void;
}

/** Entries kept in all by default, shared by the stations. */
export const DEFAULT_RECORD_BUDGET = 200_000;
/** The most entries one station keeps under a budget. */
export const MAX_RECORDS_PER_STATION = 1000;

export interface RecorderOptions {
  /**
   * Entries kept per station; 0 keeps none (listeners still get every entry). Absent, the
   * stations share `budget`.
   */
  limit?: number;
  /**
   * Entries kept in all when `limit` is absent (default 200,000), shared by the stations that
   * recorded something: up to 1000 each, fewer as the fleet grows.
   */
  budget?: number;
  now?: () => number;
  /**
   * Checks a CALL or CALLRESULT payload of a station (against the schemas of
   * its OCPP version); non-empty problems are kept as `schemaErrors`.
   */
  check?: (
    action: string,
    kind: 'request' | 'response',
    payload: unknown,
    stationId: string,
  ) => string[] | undefined;
  /** A station's OCPP version, kept on its frames (and their log lines). */
  versionOf?: (stationId: string) => OcppVersion | undefined;
}

export function createRecorder(options: RecorderOptions = {}): Recorder {
  const budget = options.budget ?? DEFAULT_RECORD_BUDGET;
  /** Entries a station keeps now: the fixed limit, else its share of the budget. */
  const capFor = (stations: number) =>
    options.limit ??
    Math.max(1, Math.min(MAX_RECORDS_PER_STATION, Math.floor(budget / Math.max(1, stations))));
  let cap = capFor(0);
  const now = options.now ?? Date.now;
  const buffers = new Map<string, RecordEntry[]>();
  /** `${stationId} ${uniqueId}` → action, for matching responses to requests. */
  const actions = new Map<string, string>();
  /** The same for answered CALLs, so a 2.1 CALLRESULTERROR (which reuses the id) is named too. */
  const answeredActions = new Map<string, string>();
  const listeners = new Set<(entry: RecordEntry) => void>();
  let seq = 0;

  function schemaErrors(
    stationId: string,
    action: string | undefined,
    kind: 'request' | 'response',
    payload: unknown,
    check = true,
  ) {
    if (!check || action === undefined || options.check === undefined) return {};
    const problems = options.check(action, kind, payload, stationId);
    return problems !== undefined && problems.length > 0 ? { schemaErrors: problems } : {};
  }

  function push(entry: RecordEntry): void {
    if (cap > 0) {
      let buffer = buffers.get(entry.stationId);
      if (buffer === undefined) {
        buffer = [];
        buffers.set(entry.stationId, buffer);
        // One more station shares the budget: the others keep less.
        const next = capFor(buffers.size);
        if (next < cap) {
          for (const other of buffers.values()) {
            if (other.length > next) other.splice(0, other.length - next);
          }
        }
        cap = next;
      }
      buffer.push(entry);
      if (buffer.length > cap) buffer.splice(0, buffer.length - cap);
    }
    listeners.forEach((listener) => listener(entry));
  }

  return {
    frame(stationId, direction, text, marks = {}) {
      const ocpp = options.versionOf?.(stationId);
      const base = {
        kind: 'frame' as const,
        seq: ++seq,
        stationId,
        at: new Date(now()).toISOString(),
        direction,
        ...marks,
        ...(ocpp !== undefined && { ocpp }),
        text,
      };
      // A frame that is wrong on purpose is not held against the schema.
      const check = marks.injected === undefined;
      const parsed = parseFrame(text, { ocppj21: ocpp === '2.1' });
      let entry: FrameRecord = base;
      if (parsed.ok) {
        const { frame } = parsed;
        const key = `${stationId} ${frame.id}`;
        if (frame.type === MessageTypeId.Call) {
          actions.set(key, frame.action);
          entry = {
            ...base,
            messageType: 2,
            uniqueId: frame.id,
            action: frame.action,
            payload: frame.payload,
            ...schemaErrors(stationId, frame.action, 'request', frame.payload, check),
          };
        } else if (frame.type === 6) {
          // 2.1 SEND: an unconfirmed message, checked against its request schema.
          entry = {
            ...base,
            messageType: 6,
            uniqueId: frame.id,
            action: frame.action,
            payload: frame.payload,
            ...schemaErrors(stationId, frame.action, 'request', frame.payload, check),
          };
        } else if (frame.type === 5) {
          // 2.1 CALLRESULTERROR: the other side could not process an answer.
          const action = answeredActions.get(key);
          answeredActions.delete(key);
          entry = {
            ...base,
            messageType: 5,
            uniqueId: frame.id,
            ...(action !== undefined && { action }),
            payload: {
              errorCode: frame.errorCode,
              errorDescription: frame.errorDescription,
              errorDetails: frame.errorDetails,
            },
          };
        } else {
          const action = actions.get(key);
          actions.delete(key);
          if (action !== undefined && ocpp === '2.1') {
            answeredActions.set(key, action);
            // Only the latest answers can draw a CALLRESULTERROR; keep the map small.
            if (answeredActions.size > 100) {
              answeredActions.delete(answeredActions.keys().next().value ?? '');
            }
          }
          entry = {
            ...base,
            messageType: frame.type,
            uniqueId: frame.id,
            ...(action !== undefined && { action }),
            payload:
              frame.type === MessageTypeId.CallResult
                ? frame.payload
                : {
                    errorCode: frame.errorCode,
                    errorDescription: frame.errorDescription,
                    errorDetails: frame.errorDetails,
                  },
            ...(frame.type === MessageTypeId.CallResult &&
              schemaErrors(stationId, action, 'response', frame.payload, check)),
          };
        }
      }
      push(entry);
      return entry;
    },

    log(stationId, message) {
      const entry: LogRecord = {
        kind: 'log',
        seq: ++seq,
        stationId,
        at: new Date(now()).toISOString(),
        message,
      };
      push(entry);
      return entry;
    },

    query(stationId, query = {}) {
      let entries = buffers.get(stationId) ?? [];
      if (query.kind !== undefined) entries = entries.filter((e) => e.kind === query.kind);
      if (query.action !== undefined)
        entries = entries.filter((e) => e.kind === 'frame' && e.action === query.action);
      return query.limit !== undefined ? entries.slice(-query.limit) : [...entries];
    },

    forget(stationId) {
      buffers.delete(stationId);
      // One station fewer: the others may keep more from now on.
      cap = capFor(buffers.size);
      for (const map of [actions, answeredActions]) {
        for (const key of map.keys()) if (key.startsWith(`${stationId} `)) map.delete(key);
      }
    },

    closed(stationId) {
      for (const map of [actions, answeredActions]) {
        for (const key of map.keys()) if (key.startsWith(`${stationId} `)) map.delete(key);
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
