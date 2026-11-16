import { describe, expect, it } from 'vitest';
import {
  formatLog,
  lineFrame,
  lineText,
  logLine,
  logVersions,
  parseLog,
  versionOfSubprotocol,
  withVersions,
} from './log-format.js';

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

describe('log versions', () => {
  const call = (station: string, action: string, ocpp?: '1.6' | '2.0.1') =>
    logLine(
      '2026-11-15T10:00:00.000Z',
      station,
      'cp-to-csms',
      JSON.stringify([2, 'x', action, {}]),
      {
        ...(ocpp !== undefined && { ocpp }),
      },
    );

  it('keeps a line version, else tells it from actions only one version has', () => {
    const lines = [
      call('A', 'Heartbeat'),
      call('A', 'TransactionEvent'),
      call('B', 'StartTransaction'),
      call('C', 'Heartbeat'),
      call('D', 'Heartbeat', '2.0.1'),
    ];
    expect(Object.fromEntries(logVersions(lines))).toEqual({ A: '2.0.1', B: '1.6', D: '2.0.1' });
    expect(withVersions(lines).map((l) => l.ocpp)).toEqual([
      '2.0.1',
      '2.0.1',
      '1.6',
      undefined,
      '2.0.1',
    ]);
    expect([
      versionOfSubprotocol('ocpp2.0.1'),
      versionOfSubprotocol('ocpp1.6'),
      versionOfSubprotocol('ocpp2.1'),
      versionOfSubprotocol('x'),
    ]).toEqual(['2.0.1', '1.6', '2.1', undefined]);
  });

  it('reads and checks the version of a line', () => {
    const line = JSON.stringify({ ...call('A', 'Heartbeat', '2.0.1') });
    expect(parseLog(line).lines[0]?.ocpp).toBe('2.0.1');
    expect(parseLog(JSON.stringify({ ...call('A', 'Heartbeat'), ocpp: '3.0' })).problems).toEqual([
      'line 1: "ocpp" must be 1.6, 2.0.1 or 2.1',
    ]);
    expect(
      parseLog(JSON.stringify({ ...call('A', 'Heartbeat'), ocpp: '2.1' })).lines[0]?.ocpp,
    ).toBe('2.1');
  });
});
