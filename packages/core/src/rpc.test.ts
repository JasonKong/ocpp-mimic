import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import { sequentialIds } from './ids.js';
import {
  OCPP201_MESSAGE_SET,
  OCPP21_MESSAGE_SET,
  type Ocpp201RpcTypes,
  type Ocpp21RpcTypes,
} from './message-set.js';
import { createRpc, type CsmsHandlers, type RpcEvent, type RpcHandlers } from './rpc.js';

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

describe('an OCPP 2.0.1 message set', () => {
  function setup201(handlers: RpcHandlers<Ocpp201RpcTypes> = {}) {
    const clock = new ManualClock();
    const sent: unknown[] = [];
    const rpc = createRpc<Ocpp201RpcTypes>({
      clock,
      ids: sequentialIds('m'),
      send: (text) => sent.push(JSON.parse(text)),
      messages: OCPP201_MESSAGE_SET,
      handlers,
    });
    return { rpc, sent };
  }

  it('validates calls and answers with the 2.0.1 definitions', async () => {
    const { rpc, sent } = setup201();
    const boot = {
      reason: 'PowerUp' as const,
      chargingStation: { model: 'AC-7', vendorName: 'VendorX' },
    };
    const outcome = rpc.call('BootNotification', boot);
    expect(sent).toEqual([[2, 'm1', 'BootNotification', boot]]);
    rpc.receive(
      JSON.stringify([
        3,
        'm1',
        { currentTime: '2026-11-15T10:00:00Z', interval: 300, status: 'Accepted' },
      ]),
    );
    expect(await outcome).toMatchObject({ ok: true, payload: { status: 'Accepted' } });
    // The 1.6 shape is not a 2.0.1 BootNotification.
    const old = await rpc.call('BootNotification', BOOT as never);
    expect(old).toMatchObject({ ok: false, failure: { kind: 'InvalidRequest' } });
  });

  it('answers unknown, unsupported and invalid CALLs with the 2.0.1 error codes', async () => {
    const { rpc, sent } = setup201({
      GetVariables: () => ({ getVariableResult: [] as never }),
    });
    rpc.receive('[2,"c1","RemoteStartTransaction",{}]');
    rpc.receive('[2,"c2","SetDisplayMessage",{}]');
    rpc.receive('[2,"c3","GetVariables",{"getVariableData":[],"extra":1}]');
    rpc.receive('[2,"c4","GetVariables",{"getVariableData":[]}]');
    rpc.receive('[7,"c5","Heartbeat",{}]');
    rpc.receive('[2,"c6","GetVariables"]');
    await flush();
    expect(heads(sent, 3)).toEqual([
      [4, 'c1', 'NotImplemented'],
      [4, 'c2', 'NotSupported'],
      [4, 'c3', 'OccurrenceConstraintViolation'],
      [4, 'c4', 'OccurrenceConstraintViolation'],
      [4, 'c5', 'MessageTypeNotSupported'],
      [4, 'c6', 'FormatViolation'],
    ]);
  });

  it('leaves unknown message types unanswered in 1.6', async () => {
    const { rpc, sent } = setup();
    rpc.receive('[7,"c1","Heartbeat",{}]');
    await flush();
    expect(sent).toEqual([]);
  });
});

describe('an OCPP 2.1 message set (OCPP-J 2.1)', () => {
  function setup21(handlers: RpcHandlers<Ocpp21RpcTypes> = {}) {
    const clock = new ManualClock();
    const sent: unknown[] = [];
    const events: RpcEvent[] = [];
    const rpc = createRpc<Ocpp21RpcTypes>({
      clock,
      ids: sequentialIds('m'),
      send: (text) => sent.push(JSON.parse(text)),
      messages: OCPP21_MESSAGE_SET,
      handlers,
      onEvent: (event) => events.push(event),
    });
    return { rpc, sent, events };
  }

  it('answers an invalid CALLRESULT with a CALLRESULTERROR and fails the call', async () => {
    const { rpc, sent } = setup21();
    const outcome = rpc.call('Heartbeat', {});
    rpc.receive('[3,"m1",{"currentTime":"yesterday"}]');
    expect(await outcome).toMatchObject({ ok: false, failure: { kind: 'InvalidResponse' } });
    expect(heads(sent, 3)).toEqual([
      [2, 'm1', 'Heartbeat'],
      [5, 'm1', 'PropertyConstraintViolation'],
    ]);
  });

  it('only reports a CALLRESULTERROR the CSMS sends about our answer', async () => {
    const { rpc, sent, events } = setup21({ ClearCache: () => ({ status: 'Accepted' }) });
    rpc.receive('[2,"c1","ClearCache",{}]');
    await flush();
    rpc.receive('[5,"c1","FormatViolation","cannot read it",{}]');
    expect(heads(sent, 2)).toEqual([[3, 'c1']]);
    expect(events).toContainEqual({
      type: 'call-result-error',
      id: 'c1',
      errorCode: 'FormatViolation',
      errorDescription: 'cannot read it',
    });
  });

  it('sends a SEND at once, even while a CALL waits for its answer', async () => {
    const { rpc, sent } = setup21();
    void rpc.call('Heartbeat', {});
    const stream = {
      id: 1,
      pending: 0,
      basetime: '2026-11-16T10:00:00Z',
      data: [{ t: 0, v: '230.4' }],
    };
    expect(rpc.send('NotifyPeriodicEventStream', stream)).toBe(true);
    expect(sent).toEqual([
      [2, 'm1', 'Heartbeat', {}],
      [6, 'm2', 'NotifyPeriodicEventStream', stream],
    ]);
    // Only unconfirmed actions go as SEND, and only valid ones.
    expect(rpc.send('Heartbeat' as never, {} as never)).toBe(false);
    expect(rpc.send('NotifyPeriodicEventStream', { id: 1 } as never)).toBe(false);
    rpc.close();
    expect(rpc.send('NotifyPeriodicEventStream', stream)).toBe(false);
    expect(sent).toHaveLength(2);
  });

  it('never answers a received SEND, and reports one it drops', async () => {
    const { rpc, sent, events } = setup21();
    rpc.receive(
      '[6,"s1","NotifyPeriodicEventStream",{"id":1,"pending":0,"basetime":"2026-11-16T10:00:00Z","data":[{"t":0,"v":"1"}]}]',
    );
    rpc.receive('[6,"s2","Heartbeat",{}]');
    rpc.receive('[6,"s3"]');
    await flush();
    expect(sent).toEqual([]);
    expect(events.filter((e) => e.type === 'send-dropped')).toEqual([
      {
        type: 'send-dropped',
        action: 'NotifyPeriodicEventStream',
        message: 'no handler for NotifyPeriodicEventStream',
      },
      {
        type: 'send-dropped',
        action: 'Heartbeat',
        message: 'Heartbeat is not an unconfirmed action',
      },
    ]);
  });

  it('has no SEND or CALLRESULTERROR in 2.0.1', async () => {
    const clock = new ManualClock();
    const sent: unknown[] = [];
    const rpc = createRpc<Ocpp201RpcTypes>({
      clock,
      ids: sequentialIds('m'),
      send: (text) => sent.push(JSON.parse(text)),
      messages: OCPP201_MESSAGE_SET,
    });
    const outcome = rpc.call('Heartbeat', {});
    rpc.receive('[3,"m1",{"currentTime":"yesterday"}]');
    expect(await outcome).toMatchObject({ ok: false, failure: { kind: 'InvalidResponse' } });
    rpc.receive('[6,"s1","NotifyPeriodicEventStream",{}]');
    await flush();
    expect(heads(sent, 3)).toEqual([
      [2, 'm1', 'Heartbeat'],
      [4, 's1', 'MessageTypeNotSupported'],
    ]);
  });
});
