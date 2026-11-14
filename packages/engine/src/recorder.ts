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
  frame(stationId: string, direction: Direction, text: string): FrameRecord;
  log(stationId: string, message: string): LogRecord;
  /** Entries for a station, oldest first. */
  query(stationId: string, query?: RecordQuery): RecordEntry[];
  forget(stationId: string): void;
  subscribe(listener: (entry: RecordEntry) => void): () => void;
}

export interface RecorderOptions {
  /** Entries kept per station. Default 1000. */
  limit?: number;
  now?: () => number;
  /** Checks a CALL or CALLRESULT payload; non-empty problems are kept as `schemaErrors`. */
  check?: (action: string, kind: 'request' | 'response', payload: unknown) => string[] | undefined;
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
    action: string | undefined,
    kind: 'request' | 'response',
    payload: unknown,
  ) {
    if (action === undefined || options.check === undefined) return {};
    const problems = options.check(action, kind, payload);
    return problems !== undefined && problems.length > 0 ? { schemaErrors: problems } : {};
  }

  function push(entry: RecordEntry): void {
    const buffer = buffers.get(entry.stationId) ?? [];
    buffer.push(entry);
    if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
    buffers.set(entry.stationId, buffer);
    listeners.forEach((listener) => listener(entry));
  }

  return {
    frame(stationId, direction, text) {
      const base = {
        kind: 'frame' as const,
        seq: ++seq,
        stationId,
        at: new Date(now()).toISOString(),
        direction,
        text,
      };
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
            ...schemaErrors(frame.action, 'request', frame.payload),
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
              schemaErrors(action, 'response', frame.payload)),
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

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
