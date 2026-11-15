import { describe, expect, it } from 'vitest';
import type { FrameRecord, LogRecord } from './api.js';
import {
  actionsOf,
  filterRows,
  logRows,
  nearestMeterRow,
  NO_FILTER,
  sessionLogLines,
} from './session-log.js';

const T0 = Date.parse('2026-11-15T10:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const frame = (
  seq: number,
  ms: number,
  direction: FrameRecord['direction'],
  messageType: 2 | 3 | 4,
  uniqueId: string,
  action?: string,
  extra: Partial<FrameRecord> = {},
): FrameRecord => ({
  kind: 'frame',
  seq,
  stationId: 'CP-1',
  at: at(ms),
  direction,
  messageType,
  uniqueId,
  ...(action !== undefined && { action }),
  payload: {},
  text: '[]',
  ...extra,
});
const FRAMES = [
  frame(1, 0, 'csms-to-cp', 2, 'r', 'RemoteStartTransaction'),
  frame(2, 80, 'cp-to-csms', 3, 'r', 'RemoteStartTransaction', { payload: { status: 'Accepted' } }),
  frame(3, 1000, 'cp-to-csms', 2, 'm', 'MeterValues'),
  frame(4, 1050, 'csms-to-cp', 3, 'm', 'MeterValues'),
  frame(5, 2000, 'cp-to-csms', 2, 's', 'StatusNotification', { schemaErrors: ['bad'] }),
  frame(6, 3000, 'csms-to-cp', 4, 'x', 'Reset'),
];
const LOG: LogRecord = {
  kind: 'log',
  seq: 7,
  stationId: 'CP-1',
  at: at(1500),
  message: 'connector 1: the EV is full',
};

describe('session log rows', () => {
  it('pairs each CALL with its answer and time, and keeps lone answers and log lines in order', () => {
    const rows = logRows(FRAMES, [LOG]);
    expect(rows.map((r) => `${r.kind}:${r.seq}`)).toEqual([
      'call:1',
      'call:3',
      'log:7',
      'call:5',
      'answer:6',
    ]);
    expect(rows[0]).toMatchObject({ answerMs: 80, problem: false });
    expect(rows[0]?.answer?.seq).toBe(2);
    expect(rows[3]?.problem).toBe(true);
    expect(rows[4]?.problem).toBe(true);
    expect(actionsOf(rows)).toEqual([
      'MeterValues',
      'RemoteStartTransaction',
      'Reset',
      'StatusNotification',
    ]);
  });

  it('filters by action, direction and errors, with or without log lines', () => {
    const rows = logRows(FRAMES, [LOG]);
    const seqs = (filter: Partial<typeof NO_FILTER>) =>
      filterRows(rows, { ...NO_FILTER, ...filter }).map((r) => r.seq);
    expect(seqs({})).toEqual([1, 3, 7, 5, 6]);
    expect(seqs({ errorsOnly: true })).toEqual([5, 6]);
    expect(seqs({ direction: 'csms-to-cp' })).toEqual([1, 7, 6]);
    expect(seqs({ actions: ['MeterValues'] })).toEqual([3]);
    expect(seqs({ logLines: false })).toEqual([1, 3, 5, 6]);
  });

  it('finds the meter frame nearest to a moment, and the log lines within a session', () => {
    const rows = logRows(FRAMES);
    expect(nearestMeterRow(rows, T0 + 5000)?.seq).toBe(3);
    expect(nearestMeterRow(logRows([FRAMES[0]!]), T0)).toBeUndefined();
    expect(sessionLogLines([LOG, FRAMES[0]!], at(1000), at(2000))).toEqual([LOG]);
    expect(sessionLogLines([LOG], at(2000), undefined)).toEqual([]);
    expect(sessionLogLines([LOG], undefined, undefined)).toEqual([]);
  });
});
