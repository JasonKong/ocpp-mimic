import { describe, expect, it } from 'vitest';
import {
  failureText,
  formatDuration,
  formatRoute,
  parseRoute,
  sessionDuration,
  stateTone,
  stepDelay,
  stepLabel,
} from './sessions.js';

describe('session formatting', () => {
  it('reads and writes session links', () => {
    expect(parseRoute('#/stations/CP%2F1')).toEqual({ stationId: 'CP/1', sessions: false });
    expect(parseRoute('#/stations/CP-1/sessions')).toEqual({ stationId: 'CP-1', sessions: true });
    expect(parseRoute('#/stations/CP-1/sessions/12')).toEqual({
      stationId: 'CP-1',
      sessions: true,
      n: 12,
    });
    expect(parseRoute('#/elsewhere')).toBeUndefined();
    expect(formatRoute({ stationId: 'CP/1', sessions: true, n: 3 })).toBe(
      '#/stations/CP%2F1/sessions/3',
    );
    expect(formatRoute({ stationId: 'CP-1', sessions: false, n: 3 })).toBe('#/stations/CP-1');
  });

  it('formats durations and steps', () => {
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(5 * 60_000)).toBe('5 min');
    expect(formatDuration(102 * 60_000)).toBe('1 h 42 min');
    expect(formatDuration(-1)).toBe('—');
    expect(
      sessionDuration({ startedAt: '2026-11-15T10:00:00Z' }, Date.parse('2026-11-15T10:30:00Z')),
    ).toBe(1_800_000);
    expect(sessionDuration({}, 0)).toBeUndefined();
    const step = {
      seq: 1,
      at: 'x',
      action: 'RemoteStartTransaction',
      direction: 'csms-to-cp' as const,
      messageType: 2 as const,
    };
    expect(stepLabel(step)).toBe('CSMS → CP RemoteStartTransaction');
    expect(stepLabel({ ...step, direction: 'cp-to-csms', messageType: 3 })).toBe(
      'CP → CSMS RemoteStartTransaction answer',
    );
    expect(stepDelay({ ...step, sincePreviousMs: 80 })).toBe('+80 ms');
    expect(stepDelay({ ...step, sincePreviousMs: 1234 })).toBe('+1.2 s');
    expect(stepDelay(step)).toBe('');
  });

  it('says why a session did not start, and colours states', () => {
    expect(failureText({ reason: 'Rejected' })).toBe('The station rejected the remote start');
    expect(failureText({ reason: 'NotAuthorized', detail: 'Blocked' })).toBe(
      'Not authorized (Blocked)',
    );
    expect(failureText(undefined)).toBeUndefined();
    expect(
      ['running', 'starting', 'finished', 'not-started'].map((s) => stateTone(s as 'running')),
    ).toEqual(['good', 'pending', 'muted', 'bad']);
  });
});
