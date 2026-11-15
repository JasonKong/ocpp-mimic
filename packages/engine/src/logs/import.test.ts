import { describe, expect, it } from 'vitest';
import {
  importMapped,
  importText,
  maskLines,
  parseCsv,
  parseMapping,
  parseTime,
} from './import.js';

describe('parseCsv', () => {
  it('reads quoted fields with delimiters, doubled quotes and line breaks', () => {
    expect(parseCsv('a,b\n1,"x,""y"""\n2,"two\nlines"\n')).toEqual([
      ['a', 'b'],
      ['1', 'x,"y"'],
      ['2', 'two\nlines'],
    ]);
    expect(parseCsv('a;b\r\n1;2', ';')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('parseTime', () => {
  it('reads ISO times with a zone as they are, and local times in the given zone', () => {
    expect(parseTime('2026-11-15T09:00:00.123Z', 'iso', 'UTC')).toBe(
      Date.parse('2026-11-15T09:00:00.123Z'),
    );
    expect(parseTime('2026-11-15T09:00:00+13:00', 'iso', 'UTC')).toBe(
      Date.parse('2026-11-14T20:00:00Z'),
    );
    expect(parseTime('2026-11-15 09:00:00.5', 'iso', 'UTC')).toBe(
      Date.parse('2026-11-15T09:00:00.500Z'),
    );
    // New Zealand daylight time (UTC+13) in November, standard time (UTC+12) in June.
    expect(parseTime('2026-11-15 09:00:00', 'iso', 'Pacific/Auckland')).toBe(
      Date.parse('2026-11-14T20:00:00Z'),
    );
    expect(parseTime('2026-06-15 09:00:00', 'iso', 'Pacific/Auckland')).toBe(
      Date.parse('2026-06-14T21:00:00Z'),
    );
    expect(parseTime('1763197200', 'epoch-s', 'UTC')).toBe(1_763_197_200_000);
    expect(parseTime('1763197200123', 'epoch-ms', 'UTC')).toBe(1_763_197_200_123);
    expect(parseTime('soon', 'iso', 'UTC')).toBeUndefined();
  });
});

describe('parseMapping', () => {
  it('needs a format, field places, a known time zone and mapped directions', () => {
    const parsed = parseMapping({
      format: 'csv',
      fields: {
        at: { column: 'time', timeZone: 'Mars/Olympus' },
        station: {},
        direction: { column: 'dir', values: { IN: 'upwards' } },
        frame: { column: 'msg' },
      },
    });
    expect(parsed.ok ? [] : parsed.problems).toEqual([
      'fields.station needs a column',
      'fields.at.timeZone: unknown time zone Mars/Olympus',
      'fields.direction.values must map to cp-to-csms or csms-to-cp',
    ]);
    expect(parseMapping({ format: 'lines', pattern: '(' })).toMatchObject({ ok: false });
    expect(parseMapping({ format: 'xml' })).toMatchObject({ ok: false });
  });
});

const BOOT = '[2,"1","BootNotification",{"chargePointVendor":"V","chargePointModel":"M"}]';
const BOOT_ANSWER =
  '[3,"1",{"status":"Accepted","currentTime":"2026-11-15T09:00:00Z","interval":60}]';

describe('importMapped', () => {
  it('reads CSV with columns, direction values and a time zone, in time order', () => {
    const mapping = parseMapping({
      format: 'csv',
      fields: {
        at: { column: 'logged_at', timeZone: 'Pacific/Auckland' },
        station: { column: 'charge_box_id' },
        direction: { column: 'direction', values: { IN: 'cp-to-csms', OUT: 'csms-to-cp' } },
        frame: { column: 'message' },
      },
    });
    if (!mapping.ok) throw new Error(mapping.problems.join('; '));
    const csv = [
      'logged_at,charge_box_id,direction,message',
      `2026-11-15 09:00:00.020,CP1,OUT,"${BOOT_ANSWER.replaceAll('"', '""')}"`,
      `2026-11-15 09:00:00.000,CP1,IN,"${BOOT.replaceAll('"', '""')}"`,
      '2026-11-15 09:00:01.000,CP1,SIDEWAYS,"[]"',
    ].join('\n');
    const { lines, problems } = importMapped(csv, mapping.mapping);
    expect(problems).toEqual(['line 4: direction "SIDEWAYS" is not mapped']);
    expect(lines.map((l) => [l.at, l.direction, l.frame?.[0]])).toEqual([
      ['2026-11-14T20:00:00.000Z', 'cp-to-csms', 2],
      ['2026-11-14T20:00:00.020Z', 'csms-to-cp', 3],
    ]);
  });

  it('reads JSONL with field paths, and frames given as arrays', () => {
    const mapping = parseMapping({
      format: 'jsonl',
      fields: {
        at: { path: 'ts', time: 'epoch-ms' },
        station: { path: 'cp.id' },
        direction: { path: 'dir', values: { rx: 'cp-to-csms', tx: 'csms-to-cp' } },
        frame: { path: 'msg' },
      },
    });
    if (!mapping.ok) throw new Error(mapping.problems.join('; '));
    const text = [
      JSON.stringify({ ts: 1763197200000, cp: { id: 'CP9' }, dir: 'rx', msg: JSON.parse(BOOT) }),
      'oops',
    ].join('\n');
    const { lines, problems } = importMapped(text, mapping.mapping);
    expect(problems).toEqual(['line 2: not JSON']);
    expect(lines).toEqual([
      {
        at: '2025-11-15T09:00:00.000Z',
        station: 'CP9',
        direction: 'cp-to-csms',
        frame: JSON.parse(BOOT),
      },
    ]);
  });

  it('reads plain lines with named groups', () => {
    const mapping = parseMapping({
      format: 'lines',
      pattern:
        '^(?<at>\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d\\.\\d{3}) \\[(?<station>[^\\]]+)\\] (?<direction>RECV|SEND) (?<frame>\\[.*\\])$',
      fields: { direction: { values: { RECV: 'cp-to-csms', SEND: 'csms-to-cp' } } },
    });
    if (!mapping.ok) throw new Error(mapping.problems.join('; '));
    const { lines, problems } = importMapped(
      `2026-11-15 09:00:00.000 [CP1] RECV ${BOOT}\nsomething else\n2026-11-15 09:00:00.030 [CP1] SEND ${BOOT_ANSWER}\n`,
      mapping.mapping,
    );
    expect(problems).toEqual(['line 2: does not match the pattern']);
    expect(lines.map((l) => l.direction)).toEqual(['cp-to-csms', 'csms-to-cp']);
  });
});

describe('import: OCPP versions', () => {
  it('takes the version from a subprotocol column, else from the actions', () => {
    const mapping = parseMapping({
      format: 'jsonl',
      fields: {
        at: { path: 'time' },
        station: { path: 'cp' },
        direction: { path: 'dir' },
        frame: { path: 'msg' },
        subprotocol: { path: 'protocol' },
      },
    });
    if (!mapping.ok) throw new Error(mapping.problems.join('; '));
    const row = (cp: string, msg: unknown[], protocol?: string) =>
      JSON.stringify({ time: '2026-11-15T10:00:00Z', cp, dir: 'cp-to-csms', msg, protocol });
    const text = [
      row('A', [2, '1', 'Heartbeat', {}], 'ocpp2.0.1'),
      row('B', [2, '2', 'StartTransaction', {}]),
      row('B', [2, '3', 'Heartbeat', {}]),
    ].join('\n');
    const { lines } = importMapped(text, mapping.mapping);
    expect(lines.map((l) => [l.station, l.ocpp])).toEqual([
      ['A', '2.0.1'],
      ['B', '1.6'],
      ['B', '1.6'],
    ]);
  });

  it('fills in the version of an own-format log written before M5', () => {
    const text = [
      JSON.stringify({
        at: '2026-11-15T10:00:00Z',
        station: 'S',
        direction: 'cp-to-csms',
        frame: [2, '1', 'TransactionEvent', {}],
      }),
      JSON.stringify({
        at: '2026-11-15T10:00:01Z',
        station: 'S',
        direction: 'cp-to-csms',
        frame: [2, '2', 'Heartbeat', {}],
      }),
    ].join('\n');
    expect(importText(text, undefined).lines.map((l) => l.ocpp)).toEqual(['2.0.1', '2.0.1']);
  });
});

describe('maskLines and importText', () => {
  it('masks with HMAC: the same salt gives the same pseudonyms', () => {
    const text = [
      '{"format":"ocpp-mimic-log","version":1,"masked":false}',
      '{"at":"2026-11-15T09:00:00.000Z","station":"CP1","direction":"cp-to-csms","frame":[2,"1","Authorize",{"idTag":"CARD-1"}]}',
    ].join('\n');
    const imported = importText(text, undefined);
    expect(imported).toMatchObject({ masked: false, problems: [] });
    const a = maskLines(imported.lines, 'salt-a');
    const b = maskLines(imported.lines, 'salt-a');
    const c = maskLines(imported.lines, 'salt-b');
    expect(a).toEqual(b);
    expect(a[0]?.station).not.toBe(c[0]?.station);
    expect(a[0]?.station).toMatch(/^CP-[A-Z2-7]{10}$/);
  });
});
