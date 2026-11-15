/**
 * Event Recorder: every OCPP frame a charge point sends or receives, plus its
 * log lines, kept per station in a bounded buffer. Responses are matched to
 * their request so every frame carries an action.
 */
import { MessageTypeId, parseFrame } from '@ocpp-mimic/core';

export type Direction = 'cp-to-csms' | 'csms-to-cp';

export interface FrameRecord {
  kind: 'frame';
  seq: number;
  stationId: string;
  at: string;
  direction: Direction;
  /** 2 = CALL, 3 = CALLRESULT, 4 = CALLERROR; undefined for unreadable text. */
  messageType?: 2 | 3 | 4;
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

export interface RecorderOptions {
  /** Entries kept per station. Default 1000; 0 keeps none (listeners still get every entry). */
  limit?: number;
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
}

export function createRecorder(options: RecorderOptions = {}): Recorder {
  const limit = options.limit ?? 1000;
  const now = options.now ?? Date.now;
  const buffers = new Map<string, RecordEntry[]>();
  /** `${stationId} ${uniqueId}` → action, for matching responses to requests. */
  const actions = new Map<string, string>();
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
    if (limit > 0) {
      const buffer = buffers.get(entry.stationId) ?? [];
      buffer.push(entry);
      if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
      buffers.set(entry.stationId, buffer);
    }
    listeners.forEach((listener) => listener(entry));
  }

  return {
    frame(stationId, direction, text, marks = {}) {
      const base = {
        kind: 'frame' as const,
        seq: ++seq,
        stationId,
        at: new Date(now()).toISOString(),
        direction,
        ...marks,
        text,
      };
      // A frame that is wrong on purpose is not held against the schema.
      const check = marks.injected === undefined;
      const parsed = parseFrame(text);
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
        } else {
          const action = actions.get(key);
          actions.delete(key);
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
      for (const key of actions.keys()) if (key.startsWith(`${stationId} `)) actions.delete(key);
    },

    closed(stationId) {
      for (const key of actions.keys()) if (key.startsWith(`${stationId} `)) actions.delete(key);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
