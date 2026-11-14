import { describe, expect, it } from 'vitest';
import { formatLog, lineFrame, lineText, logLine, parseLog } from './log-format.js';

describe('log format', () => {
  it('keeps messages as frames and anything else as text', () => {
    const at = '2026-11-15T09:00:00.000Z';
    expect(logLine(at, 'SIM-1', 'cp-to-csms', '[2,"1","Heartbeat",{}]')).toEqual({
      at,
      station: 'SIM-1',
      direction: 'cp-to-csms',
      frame: [2, '1', 'Heartbeat', {}],
    });
    expect(
      logLine(at, 'SIM-1', 'cp-to-csms', '[2,"1","Heartb', { injected: 'malformedJson' }),
    ).toEqual({
      at,
      station: 'SIM-1',
      direction: 'cp-to-csms',
      text: '[2,"1","Heartb',
      injected: 'malformedJson',
    });
    expect(logLine(at, 'SIM-1', 'csms-to-cp', '{"not":"a frame"}').text).toBe('{"not":"a frame"}');
  });

  it('writes a header and reads the log back', () => {
    const lines = [
      logLine('2026-11-15T09:00:00.000Z', 'SIM-1', 'cp-to-csms', '[2,"1","Heartbeat",{}]'),
      logLine('2026-11-15T09:00:00.020Z', 'SIM-1', 'csms-to-cp', '[3,"1",{"currentTime":"x"}]', {
        dropped: true,
        injected: 'drop',
      }),
    ];
    const text = formatLog(lines, { masked: false, source: 'test' });
    expect(text.split('\n')[0]).toBe(
      '{"format":"ocpp-mimic-log","version":1,"masked":false,"source":"test"}',
    );
    const parsed = parseLog(text);
    expect(parsed).toEqual({
      header: { format: 'ocpp-mimic-log', version: 1, masked: false, source: 'test' },
      lines,
      problems: [],
    });
    expect(lineText(lines[0]!)).toBe('[2,"1","Heartbeat",{}]');
    expect(lineFrame(lines[1]!)).toMatchObject({ type: 3, id: '1' });
  });

  it('reports lines that are not log lines', () => {
    const parsed = parseLog(
      [
        'not json',
        '{"at":"yesterday","station":"A","direction":"cp-to-csms","frame":[]}',
        '{"at":"2026-11-15T09:00:00Z","station":"A","direction":"up","frame":[]}',
        '{"at":"2026-11-15T09:00:00Z","station":"A","direction":"cp-to-csms"}',
        '{"format":"ocpp-mimic-log","version":2,"masked":false}',
      ].join('\n'),
    );
    expect(parsed.lines).toEqual([]);
    expect(parsed.problems).toEqual([
      'line 1: not JSON',
      'line 2: "at" must be an ISO 8601 time',
      'line 3: "direction" must be cp-to-csms or csms-to-cp',
      'line 4: needs "frame" (an OCPP-J array) or "text"',
      'line 5: log version 2 is not supported',
    ]);
  });
});
