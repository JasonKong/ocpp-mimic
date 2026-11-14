import { parseInjection, type InjectionRequest } from '@ocpp-mimic/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFaultInjector, type WireDirection } from './fault-injector.js';

const call = (id: string, action: string, payload: object = {}) =>
  JSON.stringify([2, id, action, payload]);
const result = (id: string, payload: object = {}) => JSON.stringify([3, id, payload]);

function request(value: object): InjectionRequest {
  const parsed = parseInjection(value);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.request;
}

function setup(random = () => 0) {
  const toCsms: { text: string; injected?: string }[] = [];
  const toCp: string[] = [];
  const swallowed: { direction: WireDirection; text: string; injected: string }[] = [];
  const network: string[] = [];
  const changes = { count: 0 };
  const injector = createFaultInjector({
    onChange: () => changes.count++,
    toCsms: (text, injected) => toCsms.push({ text, ...(injected !== undefined && { injected }) }),
    toChargePoint: (text) => toCp.push(text),
    swallowed: (direction, text, injected) => swallowed.push({ direction, text, injected }),
    goOffline: () => network.push('down'),
    goOnline: () => network.push('up'),
    random,
  });
  return { injector, toCsms, toCp, swallowed, network, changes };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('fault injector', () => {
  it('passes frames through untouched without injections', () => {
    const h = setup();
    h.injector.outgoing(call('1', 'Heartbeat'));
    h.injector.incoming(result('1', { currentTime: 'x' }));
    expect(h.toCsms).toEqual([{ text: call('1', 'Heartbeat') }]);
    expect(h.toCp).toEqual([result('1', { currentTime: 'x' })]);
  });

  it('delays frames by the latency, keeping their order, and expires with `for`', () => {
    const h = setup();
    h.injector.add(request({ type: 'latency', ms: 1000, direction: 'sent', for: '5s' }));
    h.injector.outgoing(call('1', 'Heartbeat'));
    h.injector.outgoing(call('2', 'Heartbeat'));
    h.injector.incoming(result('9'));
    expect(h.toCsms).toEqual([]);
    expect(h.toCp).toEqual([result('9')]);
    vi.advanceTimersByTime(1000);
    expect(h.toCsms.map((f) => f.text)).toEqual([call('1', 'Heartbeat'), call('2', 'Heartbeat')]);
    expect(h.injector.list()).toEqual([
      expect.objectContaining({ until: '2026-11-14T10:00:05.000Z' }),
    ]);
    vi.advanceTimersByTime(4000);
    expect(h.injector.list()).toEqual([]);
    // Added and expired: the station's snapshot is pushed both times.
    expect(h.changes.count).toBe(2);
  });

  it('drops by count, action and probability, in either direction', () => {
    const h = setup();
    h.injector.add(request({ type: 'drop', direction: 'sent', action: 'Heartbeat', count: 1 }));
    h.injector.outgoing(call('1', 'StatusNotification'));
    h.injector.outgoing(call('2', 'Heartbeat'));
    h.injector.outgoing(call('3', 'Heartbeat'));
    expect(h.toCsms.map((f) => f.text)).toEqual([
      call('1', 'StatusNotification'),
      call('3', 'Heartbeat'),
    ]);
    expect(h.swallowed).toEqual([
      { direction: 'cp-to-csms', text: call('2', 'Heartbeat'), injected: 'drop' },
    ]);

    const unlucky = setup(() => 0.9);
    unlucky.injector.add(request({ type: 'drop', direction: 'received', probability: 0.5 }));
    unlucky.injector.incoming(call('a', 'Reset', { type: 'Soft' }));
    expect(unlucky.toCp).toHaveLength(1);
    const lucky = setup(() => 0.1);
    lucky.injector.add(request({ type: 'drop', direction: 'received', probability: 0.5 }));
    lucky.injector.incoming(call('a', 'Reset', { type: 'Soft' }));
    expect(lucky.toCp).toEqual([]);
  });

  it('breaks JSON, adds a property, and renames uniqueIds', () => {
    const h = setup();
    h.injector.add(request({ type: 'malformedJson' }));
    h.injector.outgoing(call('1', 'Heartbeat'));
    expect(h.toCsms[0]?.injected).toBe('malformedJson');
    expect(() => JSON.parse(h.toCsms[0]?.text ?? '') as unknown).toThrow();

    h.injector.add(request({ type: 'schemaViolation', action: 'Heartbeat' }));
    h.injector.outgoing(call('2', 'StatusNotification', { connectorId: 1 }));
    h.injector.outgoing(call('3', 'Heartbeat'));
    expect(h.toCsms.slice(1)).toEqual([
      { text: call('2', 'StatusNotification', { connectorId: 1 }) },
      { text: call('3', 'Heartbeat', { injected: true }), injected: 'schemaViolation' },
    ]);

    // unknownId changes only answers.
    h.injector.add(request({ type: 'unknownId' }));
    h.injector.outgoing(call('4', 'Heartbeat'));
    h.injector.outgoing(result('csms-1', { status: 'Accepted' }));
    expect(h.toCsms.at(-2)).toEqual({ text: call('4', 'Heartbeat') });
    expect(h.toCsms.at(-1)).toEqual({
      text: result('unknown-0', { status: 'Accepted' }),
      injected: 'unknownId',
    });
  });

  it('reuses the previous uniqueId for duplicateId and renames the answer back', () => {
    const h = setup();
    h.injector.outgoing(call('1', 'Heartbeat'));
    h.injector.add(request({ type: 'duplicateId' }));
    h.injector.outgoing(call('2', 'Heartbeat'));
    expect(h.toCsms.at(-1)).toEqual({ text: call('1', 'Heartbeat'), injected: 'duplicateId' });
    h.injector.incoming(result('1', { currentTime: 'x' }));
    expect(h.toCp).toEqual([result('2', { currentTime: 'x' })]);
  });

  it('swaps the next two frames for outOfOrder, or sends a lone one after a second', () => {
    const h = setup();
    h.injector.add(request({ type: 'outOfOrder' }));
    h.injector.outgoing(result('csms-1'));
    expect(h.toCsms).toEqual([]);
    h.injector.outgoing(call('1', 'StatusNotification'));
    expect(h.toCsms).toEqual([
      { text: call('1', 'StatusNotification'), injected: 'outOfOrder' },
      { text: result('csms-1'), injected: 'outOfOrder' },
    ]);
    h.injector.add(request({ type: 'outOfOrder' }));
    h.injector.outgoing(call('2', 'Heartbeat'));
    vi.advanceTimersByTime(1000);
    expect(h.toCsms.at(-1)).toEqual({ text: call('2', 'Heartbeat'), injected: 'outOfOrder' });
  });

  it('leaves CSMS calls unanswered or answers them with a CALLERROR', () => {
    const h = setup();
    h.injector.add(request({ type: 'noAnswer', action: 'ClearCache' }));
    h.injector.add(request({ type: 'callError', errorCode: 'NotSupported', count: 1 }));
    h.injector.incoming(call('c1', 'ClearCache'));
    h.injector.incoming(call('c2', 'Reset', { type: 'Soft' }));
    h.injector.incoming(call('c3', 'Reset', { type: 'Soft' }));
    expect(h.swallowed.map((s) => s.injected)).toEqual(['noAnswer', 'callError']);
    expect(h.toCsms).toEqual([
      {
        text: JSON.stringify([4, 'c2', 'NotSupported', 'Injected fault', {}]),
        injected: 'callError',
      },
    ]);
    expect(h.toCp).toEqual([call('c3', 'Reset', { type: 'Soft' })]);
  });

  it('shifts every timestamp for clockDrift, and breaks them for badTimestamp', () => {
    const h = setup();
    const status = call('1', 'StatusNotification', {
      connectorId: 1,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: '2026-11-14T10:00:00.000Z',
    });
    const meter = call('2', 'MeterValues', {
      connectorId: 1,
      meterValue: [{ timestamp: '2026-11-14T10:00:00.000Z', sampledValue: [{ value: '1' }] }],
    });
    h.injector.add(request({ type: 'clockDrift', ms: -90_000 }));
    h.injector.outgoing(status);
    h.injector.outgoing(meter);
    h.injector.outgoing(call('3', 'Heartbeat'));
    expect(h.toCsms.map((f) => [f.injected, JSON.stringify(JSON.parse(f.text)[3])])).toEqual([
      ['clockDrift', expect.stringContaining('"timestamp":"2026-11-14T09:58:30.000Z"')],
      ['clockDrift', expect.stringContaining('"timestamp":"2026-11-14T09:58:30.000Z"')],
      [undefined, '{}'],
    ]);
    h.injector.clear();
    h.injector.add(request({ type: 'badTimestamp' }));
    h.injector.outgoing(call('4', 'Heartbeat'));
    h.injector.outgoing(status);
    h.injector.outgoing(status);
    expect(h.toCsms.at(-2)).toMatchObject({ injected: 'badTimestamp' });
    expect(h.toCsms.at(-2)?.text).toContain('"timestamp":"not-a-timestamp"');
    expect(h.toCsms.at(-1)?.text).toBe(status);
  });

  it('flaps the connection the given number of times, and clear() brings it back up', () => {
    const h = setup();
    h.injector.add(request({ type: 'flap', down: '1s', up: '2s', times: 2 }));
    expect(h.network).toEqual(['down']);
    vi.advanceTimersByTime(1000);
    expect(h.network).toEqual(['down', 'up']);
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(1000);
    expect(h.network).toEqual(['down', 'up', 'down', 'up']);
    expect(h.injector.list()).toEqual([]);

    const cleared = setup();
    cleared.injector.add(request({ type: 'flap', down: '1m', up: '1s' }));
    cleared.injector.clear();
    expect(cleared.network).toEqual(['down', 'up']);
  });
});
