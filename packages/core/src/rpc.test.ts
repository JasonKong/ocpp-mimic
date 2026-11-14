import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import { sequentialIds } from './ids.js';
import { createRpc, type CsmsHandlers, type RpcEvent } from './rpc.js';

const BOOT = { chargePointVendor: 'VendorX', chargePointModel: 'AC-7' };
const BOOT_OK = { status: 'Accepted', currentTime: '2026-11-14T10:00:00Z', interval: 60 };

function setup(handlers: CsmsHandlers = {}, callTimeoutMs = 1000) {
  const clock = new ManualClock();
  const sent: unknown[] = [];
  const events: RpcEvent[] = [];
  const rpc = createRpc({
    clock,
    ids: sequentialIds('m'),
    send: (text) => sent.push(JSON.parse(text)),
    handlers,
    callTimeoutMs,
    onEvent: (event) => events.push(event),
  });
  return { clock, sent, events, rpc };
}

/** The first `n` elements of each frame sent, to compare CALLERRORs without their details. */
const heads = (frames: unknown[], n: number) =>
  frames.map((frame) => (frame as unknown[]).slice(0, n));

/** Lets pending promise callbacks (async handlers, call results) run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('outgoing calls', () => {
  it('sends a CALL and resolves with the validated response', async () => {
    const { rpc, sent } = setup();
    const outcome = rpc.call('BootNotification', BOOT);
    expect(sent).toEqual([[2, 'm1', 'BootNotification', BOOT]]);
    rpc.receive(JSON.stringify([3, 'm1', BOOT_OK]));
    expect(await outcome).toEqual({ ok: true, payload: BOOT_OK });
  });

  it('keeps at most one CALL unanswered and queues the rest', async () => {
    const { rpc, sent } = setup();
    const first = rpc.call('Heartbeat', {});
    const second = rpc.call('Heartbeat', {});
    expect(sent).toHaveLength(1);
    rpc.receive('[3,"m1",{"currentTime":"2026-11-14T10:00:00Z"}]');
    expect((await first).ok).toBe(true);
    expect(sent).toEqual([
      [2, 'm1', 'Heartbeat', {}],
      [2, 'm2', 'Heartbeat', {}],
    ]);
    rpc.receive('[3,"m2",{"currentTime":"2026-11-14T10:00:01Z"}]');
    expect((await second).ok).toBe(true);
  });

  it('times out on the clock and moves on to the next queued call', async () => {
    const { rpc, sent, clock, events } = setup({}, 1000);
    const first = rpc.call('Heartbeat', {});
    const second = rpc.call('Heartbeat', {});
    clock.advance(999);
    expect(sent).toHaveLength(1);
    clock.advance(1);
    expect(await first).toEqual({ ok: false, failure: { kind: 'Timeout' } });
    expect(events).toContainEqual({ type: 'timeout', id: 'm1', action: 'Heartbeat' });
    expect(sent).toHaveLength(2);
    rpc.receive('[3,"m2",{"currentTime":"2026-11-14T10:00:00Z"}]');
    expect((await second).ok).toBe(true);
  });

  it('resolves a CALLERROR with its details', async () => {
    const { rpc } = setup();
    const outcome = rpc.call('Heartbeat', {});
    rpc.receive('[4,"m1","InternalError","boom",{"why":"db"}]');
    expect(await outcome).toEqual({
      ok: false,
      failure: {
        kind: 'CallError',
        errorCode: 'InternalError',
        errorDescription: 'boom',
        errorDetails: { why: 'db' },
      },
    });
  });

  it('reports a response that breaks the 1.6 definition', async () => {
    const { rpc } = setup();
    const outcome = rpc.call('BootNotification', BOOT);
    rpc.receive('[3,"m1",{"status":"Maybe","currentTime":"2026-11-14T10:00:00Z","interval":60}]');
    expect(await outcome).toMatchObject({
      ok: false,
      failure: { kind: 'InvalidResponse', issues: [{ path: '$.status' }] },
    });
  });

  it('ignores responses that match no pending call, and duplicates', async () => {
    const { rpc, events } = setup();
    const outcome = rpc.call('Heartbeat', {});
    rpc.receive('[3,"other",{"currentTime":"2026-11-14T10:00:00Z"}]');
    rpc.receive('[3,"m1",{"currentTime":"2026-11-14T10:00:00Z"}]');
    rpc.receive('[3,"m1",{"currentTime":"2026-11-14T10:00:00Z"}]');
    expect((await outcome).ok).toBe(true);
    expect(events.filter((e) => e.type === 'unmatched-response')).toEqual([
      { type: 'unmatched-response', id: 'other' },
      { type: 'unmatched-response', id: 'm1' },
    ]);
  });

  it('refuses to send a request that breaks the 1.6 definition', async () => {
    const { rpc, sent } = setup();
    const outcome = await rpc.call('StatusNotification', {
      connectorId: 1,
      errorCode: 'NoError',
      // @ts-expect-error not a 1.6 status
      status: 'Offline',
    });
    expect(outcome).toMatchObject({ ok: false, failure: { kind: 'InvalidRequest' } });
    expect(sent).toEqual([]);
  });

  it('ends pending and queued calls with Closed, and every later call too', async () => {
    const { rpc } = setup();
    const first = rpc.call('Heartbeat', {});
    const second = rpc.call('Heartbeat', {});
    rpc.close();
    const closed = { ok: false, failure: { kind: 'Closed' } };
    expect(await first).toEqual(closed);
    expect(await second).toEqual(closed);
    expect(await rpc.call('Heartbeat', {})).toEqual(closed);
  });
});

describe('incoming calls', () => {
  it('answers with the handler result', async () => {
    const { rpc, sent } = setup({ Reset: () => ({ status: 'Accepted' }) });
    rpc.receive('[2,"c1","Reset",{"type":"Soft"}]');
    await flush();
    expect(sent).toEqual([[3, 'c1', { status: 'Accepted' }]]);
  });

  it('waits for asynchronous handlers', async () => {
    let release: () => void = () => {};
    const { rpc, sent } = setup({
      RemoteStopTransaction: () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 'Accepted' });
        }),
    });
    rpc.receive('[2,"c1","RemoteStopTransaction",{"transactionId":5}]');
    await flush();
    expect(sent).toEqual([]);
    release();
    await flush();
    expect(sent).toEqual([[3, 'c1', { status: 'Accepted' }]]);
  });

  it('answers unknown actions with NotImplemented and unhandled 1.6 actions with NotSupported', async () => {
    const { rpc, sent } = setup();
    rpc.receive('[2,"c1","MakeCoffee",{}]');
    rpc.receive('[2,"c2","UpdateFirmware",{}]');
    rpc.receive('[2,"c3","Reset",{"type":"Soft"}]');
    await flush();
    expect(heads(sent, 3)).toEqual([
      [4, 'c1', 'NotImplemented'],
      [4, 'c2', 'NotSupported'],
      [4, 'c3', 'NotSupported'],
    ]);
  });

  it('answers an invalid payload with the validation error code', async () => {
    const { rpc, sent } = setup({ Reset: () => ({ status: 'Accepted' }) });
    rpc.receive('[2,"c1","Reset",{"type":"Warm"}]');
    rpc.receive('[2,"c2","Reset",{}]');
    await flush();
    expect(heads(sent, 4)).toEqual([
      [4, 'c1', 'PropertyConstraintViolation', '$.type: "Warm" is not one of Hard, Soft'],
      [4, 'c2', 'OccurenceConstraintViolation', '$.type: missing required property'],
    ]);
  });

  it('answers InternalError when the handler fails or returns an invalid response', async () => {
    const { rpc, sent, events } = setup({
      Reset: () => {
        throw new Error('broken');
      },
      ClearCache: () => ({ status: 'Maybe' }) as never,
    });
    rpc.receive('[2,"c1","Reset",{"type":"Hard"}]');
    rpc.receive('[2,"c2","ClearCache",{}]');
    await flush();
    expect(heads(sent, 4)).toEqual([
      [4, 'c1', 'InternalError', 'broken'],
      [
        4,
        'c2',
        'InternalError',
        'handler returned an invalid response: $.status: "Maybe" is not one of Accepted, Rejected',
      ],
    ]);
    expect(events.filter((e) => e.type === 'handler-error')).toHaveLength(2);
  });

  it('answers a broken CALL with FormationViolation and only logs unreadable text', async () => {
    const { rpc, sent, events } = setup();
    rpc.receive('[2,"c1","Reset"]');
    rpc.receive('not json');
    await flush();
    expect(heads(sent, 3)).toEqual([[4, 'c1', 'FormationViolation']]);
    expect(events.filter((e) => e.type === 'invalid-frame')).toHaveLength(2);
  });

  it('logs every frame sent and received', async () => {
    const { rpc, events } = setup({ ClearCache: () => ({ status: 'Accepted' }) });
    rpc.receive('[2,"c1","ClearCache",{}]');
    await flush();
    expect(events).toEqual([
      { type: 'received', text: '[2,"c1","ClearCache",{}]' },
      { type: 'sent', text: '[3,"c1",{"status":"Accepted"}]' },
    ]);
  });
});
