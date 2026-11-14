import type { LogLine } from '@ocpp-mimic/core';
import { describe, expect, it } from 'vitest';
import type { StationWire } from '../fleet.js';
import { runReplay, stationLines } from './replay.js';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const cp = (s: number, frame: unknown[]): LogLine => ({
  at: at(s),
  station: 'CP1',
  direction: 'cp-to-csms',
  frame,
});
const csms = (s: number, frame: unknown[]): LogLine => ({
  at: at(s),
  station: 'CP1',
  direction: 'csms-to-cp',
  frame,
});

/** A wire to a scripted CSMS: `answer` turns each CALL into the CSMS's reply. */
function fakeWire(answer: (frame: unknown[]) => unknown[] | undefined) {
  const sent: unknown[][] = [];
  const listeners = new Set<(text: string) => void>();
  const deliver = (frame: unknown[]) => listeners.forEach((l) => l(JSON.stringify(frame)));
  const wire: StationWire = {
    send(text) {
      const frame = JSON.parse(text) as unknown[];
      sent.push(frame);
      if (frame[0] === 2) {
        const reply = answer(frame);
        if (reply !== undefined) queueMicrotask(() => deliver(reply));
      }
    },
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: true,
    whenOpen: async () => {},
  };
  return { wire, sent, deliver };
}

const SESSION = [
  cp(0, [2, 'a', 'BootNotification', { chargePointVendor: 'V', chargePointModel: 'M' }]),
  csms(0.02, [3, 'a', { status: 'Accepted', currentTime: at(0), interval: 60 }]),
  cp(10, [
    2,
    'b',
    'StartTransaction',
    { connectorId: 1, idTag: 'T1', meterStart: 0, timestamp: at(10) },
  ]),
  csms(10.02, [3, 'b', { idTagInfo: { status: 'Accepted' }, transactionId: 7 }]),
  cp(20, [
    2,
    'c',
    'MeterValues',
    {
      connectorId: 1,
      transactionId: 7,
      meterValue: [{ timestamp: at(20), sampledValue: [{ value: '10' }] }],
    },
  ]),
  csms(20.02, [3, 'c', {}]),
  cp(30, [2, 'd', 'StopTransaction', { transactionId: 7, meterStop: 100, timestamp: at(30) }]),
  csms(30.02, [3, 'd', { idTagInfo: { status: 'Accepted' } }]),
];

describe('runReplay', () => {
  it("sends fresh ids, follows the CSMS's transaction id, moves timestamps, and keeps the gaps", async () => {
    const waits: number[] = [];
    const { wire, sent } = fakeWire((frame) => {
      const action = frame[2];
      if (action === 'BootNotification')
        return [3, frame[1], { status: 'Accepted', currentTime: 'x', interval: 300 }];
      if (action === 'StartTransaction')
        return [3, frame[1], { idTagInfo: { status: 'Accepted' }, transactionId: 42 }];
      if (action === 'StopTransaction') return [3, frame[1], { idTagInfo: { status: 'Accepted' } }];
      return [3, frame[1], {}];
    });
    const now = T0 + 86_400_000;
    const result = await runReplay({
      wire,
      lines: SESSION,
      speed: 2,
      maxGapMs: 4000,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(result).toEqual({
      sent: 4,
      answered: 4,
      csmsCalls: { matched: 0, unmatched: [], missing: [] },
      differences: [],
    });
    expect(sent.map((f) => f[1])).toEqual(['replay-1', 'replay-2', 'replay-3', 'replay-4']);
    expect((sent[2]?.[3] as { transactionId: number }).transactionId).toBe(42);
    expect((sent[3]?.[3] as { transactionId: number }).transactionId).toBe(42);
    expect((sent[1]?.[3] as { timestamp: string }).timestamp).toBe(
      new Date(now + 10_000).toISOString(),
    );
    // Gaps of 10 s at speed 2 are 5 s, capped at 4 s; then the settle wait.
    expect(waits).toEqual([4000, 4000, 4000, 1000]);
  });

  it('reports answers whose status differs from the log, and missing answers', async () => {
    const { wire } = fakeWire((frame) => {
      if (frame[2] === 'StartTransaction')
        return [3, frame[1], { idTagInfo: { status: 'Invalid' }, transactionId: 1 }];
      if (frame[2] === 'MeterValues') return undefined;
      if (frame[2] === 'StopTransaction') return [4, frame[1], 'InternalError', '', {}];
      return [3, frame[1], { status: 'Accepted', currentTime: 'x', interval: 60 }];
    });
    const result = await runReplay({
      wire,
      lines: SESSION,
      answerTimeoutMs: 20,
      sleep: async () => {},
    });
    expect(result.differences).toEqual([
      'StartTransaction (log line 4): idTagInfo.status is "Invalid", the log has "Accepted"',
      'MeterValues (log line 6): no answer within 20 ms',
      'StopTransaction (log line 8): the answer is a CALLERROR, the log has a CALLRESULT',
    ]);
  });

  it('answers CALLs from the CSMS with the recorded answers, and reports the rest in strict mode', async () => {
    const lines = [
      cp(0, [2, 'a', 'Heartbeat', {}]),
      csms(0.01, [3, 'a', { currentTime: at(0) }]),
      csms(1, [2, 'r1', 'Reset', { type: 'Soft' }]),
      cp(1.1, [3, 'r1', { status: 'Accepted' }]),
      csms(2, [2, 'g1', 'GetConfiguration', {}]),
      cp(2.1, [3, 'g1', { configurationKey: [] }]),
    ];
    let deliver: ((frame: unknown[]) => void) | undefined;
    const fake = fakeWire((frame) => {
      // While the Heartbeat is answered, the CSMS sends a Reset and an unknown CALL.
      queueMicrotask(() => {
        deliver?.([2, 'csms-1', 'Reset', { type: 'Hard' }]);
        deliver?.([2, 'csms-2', 'ClearCache', {}]);
      });
      return [3, frame[1], { currentTime: 'x' }];
    });
    deliver = fake.deliver;
    const result = await runReplay({
      wire: fake.wire,
      lines,
      compare: 'strict',
      sleep: async () => {},
    });
    expect(fake.sent.filter((f) => f[0] !== 2)).toEqual([
      [3, 'csms-1', { status: 'Accepted' }],
      [4, 'csms-2', 'NotImplemented', 'the log has no ClearCache to answer from', {}],
    ]);
    expect(result.csmsCalls).toEqual({
      matched: 1,
      unmatched: ['ClearCache'],
      missing: ['GetConfiguration (log line 5)'],
    });
    expect(result.differences).toEqual([
      'Reset from the CSMS (log line 3): type is "Hard", the log has "Soft"',
      'GetConfiguration (log line 5) from the CSMS never came',
      'ClearCache from the CSMS is not in the log',
    ]);
  });
});

describe('stationLines', () => {
  it('takes the only station, or the one asked for', () => {
    const other = { ...SESSION[0]!, station: 'CP2' };
    expect(stationLines(SESSION)).toMatchObject({ ok: true, station: 'CP1' });
    expect(stationLines([...SESSION, other])).toMatchObject({ ok: false });
    expect(stationLines([...SESSION, other], 'CP2')).toMatchObject({ ok: true, lines: [other] });
    expect(stationLines([], undefined)).toEqual({ ok: false, problem: 'the log has no frames' });
  });
});
