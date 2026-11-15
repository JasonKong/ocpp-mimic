/**
 * The session log's rows (R-LOG-1 to R-LOG-5): a session's frames, or the
 * station's records, each CALL with its answer and how long the answer took,
 * station log lines on the same timeline, and the filters.
 */
import type { FrameRecord, LogRecord, RecordEntry } from './api.js';

export interface LogRow {
  kind: 'call' | 'answer' | 'log';
  seq: number;
  at: string;
  record: FrameRecord | LogRecord;
  /** For a CALL: its answer and the milliseconds it took. */
  answer?: FrameRecord;
  answerMs?: number;
  /** The frame is a CALLERROR, broke the OCA schema, or was changed or dropped by a fault injection. */
  problem: boolean;
}

export interface LogFilter {
  actions: string[];
  direction: 'all' | 'cp-to-csms' | 'csms-to-cp';
  errorsOnly: boolean;
  logLines: boolean;
}

export const NO_FILTER: LogFilter = {
  actions: [],
  direction: 'all',
  errorsOnly: false,
  logLines: true,
};

const problemOf = (frame: FrameRecord) =>
  frame.messageType === 4 || frame.schemaErrors !== undefined || frame.injected !== undefined;

/**
 * Rows in time order: each CALL carries its answer (an answer whose CALL is
 * not in the list stays a row of its own), and log lines between `from` and
 * `to` join in.
 */
export function logRows(
  frames: readonly FrameRecord[],
  logLines: readonly LogRecord[] = [],
): LogRow[] {
  const answers = new Map<string, FrameRecord>();
  const calls = new Set<string>();
  for (const frame of frames) {
    if (frame.uniqueId === undefined) continue;
    if (frame.messageType === 2) calls.add(`${frame.direction}:${frame.uniqueId}`);
    else {
      const callDirection = frame.direction === 'cp-to-csms' ? 'csms-to-cp' : 'cp-to-csms';
      answers.set(`${callDirection}:${frame.uniqueId}`, frame);
    }
  }
  const rows: LogRow[] = [];
  for (const frame of frames) {
    if (frame.messageType === 2) {
      const answer =
        frame.uniqueId === undefined
          ? undefined
          : answers.get(`${frame.direction}:${frame.uniqueId}`);
      rows.push({
        kind: 'call',
        seq: frame.seq,
        at: frame.at,
        record: frame,
        ...(answer !== undefined && {
          answer,
          answerMs: Date.parse(answer.at) - Date.parse(frame.at),
        }),
        problem: problemOf(frame) || (answer !== undefined && problemOf(answer)),
      });
    } else {
      const callDirection = frame.direction === 'cp-to-csms' ? 'csms-to-cp' : 'cp-to-csms';
      if (frame.uniqueId !== undefined && calls.has(`${callDirection}:${frame.uniqueId}`)) continue;
      rows.push({
        kind: 'answer',
        seq: frame.seq,
        at: frame.at,
        record: frame,
        problem: problemOf(frame),
      });
    }
  }
  for (const line of logLines) {
    rows.push({ kind: 'log', seq: line.seq, at: line.at, record: line, problem: false });
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
}

/** The station's log lines that fall within a session, from its first frame to its end (or now). */
export function sessionLogLines(
  entries: readonly RecordEntry[],
  from: string | undefined,
  to: string | undefined,
): LogRecord[] {
  if (from === undefined) return [];
  return entries.filter(
    (e): e is LogRecord => e.kind === 'log' && e.at >= from && (to === undefined || e.at <= to),
  );
}

export function filterRows(rows: readonly LogRow[], filter: LogFilter): LogRow[] {
  return rows.filter((row) => {
    if (row.kind === 'log')
      return filter.logLines && !filter.errorsOnly && filter.actions.length === 0;
    const frame = row.record as FrameRecord;
    if (filter.errorsOnly && !row.problem) return false;
    if (filter.direction !== 'all' && frame.direction !== filter.direction) return false;
    return filter.actions.length === 0 || filter.actions.includes(frame.action ?? '');
  });
}

/** The actions in the rows, sorted, for the filter chips. */
export const actionsOf = (rows: readonly LogRow[]) =>
  [
    ...new Set(
      rows.flatMap((r) => (r.kind === 'log' ? [] : [(r.record as FrameRecord).action ?? '?'])),
    ),
  ].sort();

/** Whether a row carries meter values, so it has a moment on the energy chart. */
export function isMeterRow(row: LogRow): boolean {
  if (row.kind !== 'call') return false;
  const frame = row.record as FrameRecord;
  return frame.action === 'MeterValues' || frame.action === 'TransactionEvent';
}

/** The row nearest to a moment, among the meter rows (for a click on the chart). */
export function nearestMeterRow(rows: readonly LogRow[], t: number): LogRow | undefined {
  let best: LogRow | undefined;
  for (const row of rows) {
    if (!isMeterRow(row)) continue;
    if (best === undefined || Math.abs(Date.parse(row.at) - t) < Math.abs(Date.parse(best.at) - t))
      best = row;
  }
  return best;
}
