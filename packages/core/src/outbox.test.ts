import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import type { JsonObject } from './ocppj.js';
import { createOutbox, type OutboxOptions } from './outbox.js';
import type { RpcOutcome } from './rpc.js';
import { createStationTimers } from './station-timers.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(overrides: Partial<OutboxOptions> = {}) {
  const clock = new ManualClock();
  const calls: { action: string; payload: JsonObject; answer: (o: RpcOutcome<unknown>) => void }[] =
    [];
  const logs: string[] = [];
  let online = true;
  let key = 0;
  const outbox = createOutbox({
    timers: createStationTimers(clock),
    online: () => online,
    call: (action, payload) => new Promise((answer) => calls.push({ action, payload, answer })),
    retryPolicy: () => ({ attempts: 3, intervalS: 10 }),
    nextKey: () => `msg-${++key}`,
    log: (message) => logs.push(message),
    changed: () => {},
    ...overrides,
  });
  return { clock, calls, logs, outbox, setOnline: (value: boolean) => (online = value) };
}

describe('outbox', () => {
  it('sends one message at a time, in order', async () => {
    const { calls, outbox } = setup();
    const first = outbox.enqueue('A', { n: 1 });
    void outbox.enqueue('B', { n: 2 });
    expect(calls.map((c) => c.action)).toEqual(['A']);
    calls[0]?.answer({ ok: true, payload: { done: 1 } });
    expect(await first).toEqual({ ok: true, payload: { done: 1 } });
    await flush();
    expect(calls.map((c) => c.action)).toEqual(['A', 'B']);
    expect(outbox.entries.map((e) => e.action)).toEqual(['B']);
  });

  it('keeps messages while offline and sends them when pumped online', async () => {
    const { calls, outbox, setOnline } = setup();
    setOnline(false);
    void outbox.enqueue('A', {});
    expect(calls).toHaveLength(0);
    setOnline(true);
    outbox.pump();
    expect(calls).toHaveLength(1);
  });

  it('retries with a growing wait, then drops the message', async () => {
    const { calls, clock, logs, outbox } = setup();
    const outcome = outbox.enqueue('A', {});
    calls[0]?.answer({ ok: false, failure: { kind: 'Timeout' } });
    await flush();
    clock.advance(9_999);
    expect(calls).toHaveLength(1);
    clock.advance(1);
    expect(calls).toHaveLength(2);
    calls[1]?.answer({ ok: false, failure: { kind: 'Timeout' } });
    await flush();
    clock.advance(20_000);
    expect(calls).toHaveLength(3);
    calls[2]?.answer({ ok: false, failure: { kind: 'Timeout' } });
    expect(await outcome).toEqual({ ok: false, failure: { kind: 'Timeout' } });
    expect(logs.at(-1)).toBe('A dropped after 3 failed attempts');
    expect(outbox.entries).toHaveLength(0);
  });

  it('fills in payloads, drops what cannot be sent, and gives up on final failures', async () => {
    const answered: string[] = [];
    const { calls, logs, outbox } = setup({
      prepare: (entry) =>
        entry.action === 'Orphan' ? { drop: 'no id' } : { payload: { ...entry.payload, id: 7 } },
      final: (entry, failure) =>
        entry.action === 'Event' && failure.kind === 'CallError' ? 'not supported' : undefined,
      answered: (entry) => answered.push(entry.action),
    });
    const orphan = outbox.enqueue('Orphan', {});
    expect(await orphan).toEqual({ ok: false, failure: { kind: 'Closed' } });
    void outbox.enqueue('Event', { a: 1 });
    expect(calls[0]?.payload).toEqual({ a: 1, id: 7 });
    calls[0]?.answer({
      ok: false,
      failure: {
        kind: 'CallError',
        errorCode: 'NotImplemented',
        errorDescription: '',
        errorDetails: {},
      },
    });
    await flush();
    expect(logs).toEqual(['Orphan dropped: no id', 'Event dropped: not supported']);
    void outbox.enqueue('Ok', {});
    calls[1]?.answer({ ok: true, payload: {} });
    await flush();
    expect(answered).toEqual(['Ok']);
  });

  it('pauses a retry wait and restores saved entries behind the queue', async () => {
    const { calls, clock, outbox } = setup();
    void outbox.enqueue('A', {});
    calls[0]?.answer({ ok: false, failure: { kind: 'Timeout' } });
    await flush();
    outbox.pause();
    outbox.restore([{ key: 'saved', action: 'B', payload: {}, attempts: 0 }]);
    expect(outbox.entries.map((e) => e.action)).toEqual(['A', 'B']);
    outbox.pump();
    expect(calls.map((c) => c.action)).toEqual(['A', 'A']);
    clock.advance(100_000);
    expect(calls).toHaveLength(2);
  });
});
