import { describe, expect, it } from 'vitest';
import { createChargePoint, type ChargePointTiming } from './charge-point.js';
import { ManualClock } from './clock.js';
import { sequentialIds } from './ids.js';
import { parseFrame, type CallFrame, type Frame, type JsonObject } from './ocppj.js';

const T0 = Date.parse('2026-11-14T10:00:00Z');
const BOOT = { chargePointVendor: 'VendorX', chargePointModel: 'AC-7' };

/** Answers a charge point request; undefined leaves it unanswered. */
type Responder = (payload: JsonObject) => JsonObject | undefined;

interface SetupOptions {
  csms?: Record<string, Responder>;
  config?: Record<string, string>;
  timing?: Partial<ChargePointTiming>;
}

/**
 * A charge point wired to a fake CSMS that answers every request (with
 * defaults or `csms` overrides), on a manual clock starting at T0.
 */
function setup(options: SetupOptions = {}) {
  const clock = new ManualClock(T0);
  const frames: Frame[] = [];
  const restarts: number[] = [];
  let nextTransactionId = 100;
  const iso = () => new Date(clock.now()).toISOString();
  const responders: Record<string, Responder> = {
    BootNotification: () => ({ status: 'Accepted', currentTime: iso(), interval: 60 }),
    Heartbeat: () => ({ currentTime: iso() }),
    StatusNotification: () => ({}),
    MeterValues: () => ({}),
    Authorize: () => ({ idTagInfo: { status: 'Accepted' } }),
    StartTransaction: () => ({
      idTagInfo: { status: 'Accepted' },
      transactionId: nextTransactionId++,
    }),
    StopTransaction: () => ({}),
    DataTransfer: () => ({ status: 'Accepted' }),
    ...options.csms,
  };
  const cp = createChargePoint({
    clock,
    ids: sequentialIds('cp-'),
    boot: BOOT,
    connectors: 2,
    // Periodic sampling is off unless a test turns it on, to keep the message log short.
    config: { values: { MeterValueSampleInterval: '0', ...options.config } },
    timing: options.timing ?? {},
    send: (text) => {
      const parsed = parseFrame(text);
      if (parsed.ok) frames.push(parsed.frame);
    },
    restart: (downtimeMs) => restarts.push(downtimeMs),
  });

  let answered = 0;
  let csmsIds = 0;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** Answers every pending charge point request until nothing new happens. */
  async function settle(): Promise<void> {
    for (let round = 0; round < 200; round++) {
      await tick();
      if (answered === frames.length) {
        await tick();
        if (answered === frames.length) return;
      }
      while (answered < frames.length) {
        const frame = frames[answered++];
        if (frame?.type !== 2) continue;
        const reply = responders[frame.action]?.(frame.payload);
        if (reply !== undefined) cp.receive(JSON.stringify([3, frame.id, reply]));
      }
    }
    throw new Error('the charge point never settled');
  }

  const calls = (action?: string) =>
    frames.filter(
      (f): f is CallFrame => f.type === 2 && (action === undefined || f.action === action),
    );
  const lastCall = (action: string) => calls(action).at(-1);
  /** `connectorId:status` of every StatusNotification sent after frame `from`. */
  const statuses = (from = 0) =>
    frames
      .slice(from)
      .filter((f): f is CallFrame => f.type === 2 && f.action === 'StatusNotification')
      .map((f) => `${String(f.payload.connectorId)}:${String(f.payload.status)}`);
  /** Actions of every CALL sent after frame `from`. */
  const actions = (from = 0) =>
    frames
      .slice(from)
      .filter((f): f is CallFrame => f.type === 2)
      .map((f) => f.action);

  async function csmsCall(action: string, payload: JsonObject) {
    const id = `csms-${++csmsIds}`;
    cp.receive(JSON.stringify([2, id, action, payload]));
    await settle();
    const answer = frames.find((f) => f.type !== 2 && f.id === id);
    return answer?.type === 3 ? answer.payload : answer;
  }
  async function advance(ms: number) {
    clock.advance(ms);
    await settle();
  }
  async function boot() {
    cp.connected();
    await settle();
  }
  /** Card TAG at the connector, cable in, transaction started; returns the transactionId. */
  async function startSession(connectorId = 1, idTag = 'TAG') {
    const result = cp.presentIdTag(connectorId, idTag);
    await settle();
    expect(await result).toBe('authorized');
    cp.plugIn(connectorId);
    await advance(1000);
    return cp.snapshot().connectors.find((c) => c.connectorId === connectorId)?.transactionId;
  }

  return {
    cp,
    clock,
    frames,
    restarts,
    settle,
    calls,
    lastCall,
    statuses,
    actions,
    csmsCall,
    advance,
    boot,
    startSession,
  };
}

describe('registration', () => {
  it('boots, reports every connector and sends heartbeats at the interval the CSMS gives', async () => {
    const h = setup();
    await h.boot();
    expect(h.actions()).toEqual([
      'BootNotification',
      'StatusNotification',
      'StatusNotification',
      'StatusNotification',
    ]);
    expect(h.calls('BootNotification')[0]?.payload).toEqual(BOOT);
    expect(h.statuses()).toEqual(['0:Available', '1:Available', '2:Available']);
    expect(h.cp.snapshot()).toMatchObject({
      registration: 'Accepted',
      config: { HeartbeatInterval: '60' },
    });

    await h.advance(59_999);
    expect(h.calls('Heartbeat')).toHaveLength(0);
    await h.advance(1);
    expect(h.calls('Heartbeat')).toHaveLength(1);
  });

  it('retries a Pending boot after the interval and serves configuration requests meanwhile', async () => {
    let boots = 0;
    const h = setup({
      csms: {
        BootNotification: () => ({
          status: ++boots === 1 ? 'Pending' : 'Accepted',
          currentTime: '2026-11-14T10:00:00Z',
          interval: 30,
        }),
      },
    });
    await h.boot();
    expect(h.cp.snapshot().registration).toBe('Pending');
    expect(await h.csmsCall('GetConfiguration', { key: ['HeartbeatInterval'] })).toEqual({
      configurationKey: [{ key: 'HeartbeatInterval', readonly: false, value: '300' }],
    });
    expect(h.calls('StatusNotification')).toHaveLength(0);
    await h.advance(30_000);
    expect(h.calls('BootNotification')).toHaveLength(2);
    expect(h.statuses()).toEqual(['0:Available', '1:Available', '2:Available']);
  });

  it('only retries the boot while Rejected', async () => {
    const h = setup({
      csms: {
        BootNotification: () => ({
          status: 'Rejected',
          currentTime: '2026-11-14T10:00:00Z',
          interval: 10,
        }),
      },
    });
    await h.boot();
    await h.advance(10_000);
    expect(h.actions()).toEqual(['BootNotification', 'BootNotification']);
  });
});

describe('local sessions', () => {
  it('authorizes a card, starts when plugged in, samples, and stops with the same card', async () => {
    const h = setup({ config: { MeterValueSampleInterval: '60' } });
    await h.boot();
    const mark = h.frames.length;

    const result = h.cp.presentIdTag(1, 'TAG');
    await h.settle();
    expect(await result).toBe('authorized');
    expect(h.lastCall('Authorize')?.payload).toEqual({ idTag: 'TAG' });

    h.cp.plugIn(1);
    await h.advance(1000);
    expect(h.lastCall('StartTransaction')?.payload).toEqual({
      connectorId: 1,
      idTag: 'TAG',
      meterStart: 0,
      timestamp: '2026-11-14T10:00:00.500Z',
    });

    await h.advance(60_000);
    const sample = h.lastCall('MeterValues')?.payload;
    expect(sample).toMatchObject({ connectorId: 1, transactionId: 100 });

    expect(await h.cp.presentIdTag(1, 'TAG')).toBe('stopping');
    await h.settle();
    expect(h.lastCall('StopTransaction')?.payload).toMatchObject({
      transactionId: 100,
      reason: 'Local',
      idTag: 'TAG',
    });
    h.cp.unplug(1);
    await h.settle();

    expect(h.actions(mark).filter((a) => a !== 'StatusNotification' && a !== 'Heartbeat')).toEqual([
      'Authorize',
      'StartTransaction',
      'MeterValues',
      'StopTransaction',
    ]);
    expect(h.statuses(mark)).toEqual(['1:Preparing', '1:Charging', '1:Finishing', '1:Available']);
  });

  it('counts energy from the moment the CSMS accepts the transaction', async () => {
    const h = setup();
    await h.boot();
    await h.startSession();
    await h.advance(3_600_000);
    expect(h.cp.snapshot().connectors[0]?.energyWh).toBeCloseTo(7360, 6);
  });

  it('rejects a card the CSMS does not accept', async () => {
    const h = setup({ csms: { Authorize: () => ({ idTagInfo: { status: 'Invalid' } }) } });
    await h.boot();
    const mark = h.frames.length;
    const result = h.cp.presentIdTag(1, 'BAD');
    await h.settle();
    expect(await result).toBe('rejected');
    expect(h.statuses(mark)).toEqual([]);
  });

  it('stops with DeAuthorized when StartTransaction is not accepted', async () => {
    const h = setup({
      csms: { StartTransaction: () => ({ idTagInfo: { status: 'Blocked' }, transactionId: 5 }) },
    });
    await h.boot();
    await h.startSession();
    expect(h.lastCall('StopTransaction')?.payload).toMatchObject({
      transactionId: 5,
      reason: 'DeAuthorized',
    });
  });

  it('stops with EVDisconnected when the cable is pulled mid-transaction', async () => {
    const h = setup();
    await h.boot();
    await h.startSession();
    const mark = h.frames.length;
    h.cp.unplug(1);
    await h.settle();
    expect(h.actions(mark)).toEqual([
      'StatusNotification',
      'StopTransaction',
      'StatusNotification',
    ]);
    expect(h.statuses(mark)).toEqual(['1:Finishing', '1:Available']);
    expect(h.lastCall('StopTransaction')?.payload).toMatchObject({ reason: 'EVDisconnected' });
  });
});

describe('commands from the CSMS', () => {
  it('RemoteStartTransaction: accepts, prepares, and starts once the cable is in', async () => {
    const h = setup();
    await h.boot();
    const mark = h.frames.length;
    expect(await h.csmsCall('RemoteStartTransaction', { idTag: 'REMOTE', connectorId: 1 })).toEqual(
      { status: 'Accepted' },
    );
    await h.advance(100);
    h.cp.plugIn(1);
    await h.advance(500);
    expect(h.lastCall('StartTransaction')?.payload).toMatchObject({
      connectorId: 1,
      idTag: 'REMOTE',
    });
    expect(h.statuses(mark)).toEqual(['1:Preparing', '1:Charging']);
    expect(h.calls('Authorize')).toHaveLength(0);
  });

  it('RemoteStartTransaction: authorizes first when AuthorizeRemoteTxRequests is true', async () => {
    const h = setup({ config: { AuthorizeRemoteTxRequests: 'true' } });
    await h.boot();
    h.cp.plugIn(1);
    await h.csmsCall('RemoteStartTransaction', { idTag: 'REMOTE' });
    await h.advance(100);
    await h.advance(1000);
    expect(h.actions().filter((a) => a === 'Authorize' || a === 'StartTransaction')).toEqual([
      'Authorize',
      'StartTransaction',
    ]);
  });

  it('RemoteStartTransaction: rejects busy, faulted and unknown connectors', async () => {
    const h = setup();
    await h.boot();
    await h.startSession(1);
    h.cp.raiseFault(2, { errorCode: 'GroundFailure' });
    await h.settle();
    for (const connectorId of [1, 2, 9]) {
      expect(await h.csmsCall('RemoteStartTransaction', { idTag: 'X', connectorId })).toEqual({
        status: 'Rejected',
      });
    }
  });

  it('RemoteStartTransaction: gives up after ConnectionTimeOut without a cable', async () => {
    const h = setup({ config: { ConnectionTimeOut: '30' } });
    await h.boot();
    const mark = h.frames.length;
    await h.csmsCall('RemoteStartTransaction', { idTag: 'REMOTE', connectorId: 2 });
    await h.advance(100);
    await h.advance(30_000);
    expect(h.statuses(mark)).toEqual(['2:Preparing', '2:Available']);
  });

  it('RemoteStopTransaction: stops a matching transaction with reason Remote', async () => {
    const h = setup();
    await h.boot();
    const transactionId = await h.startSession();
    expect(await h.csmsCall('RemoteStopTransaction', { transactionId: 999 })).toEqual({
      status: 'Rejected',
    });
    expect(await h.csmsCall('RemoteStopTransaction', { transactionId })).toEqual({
      status: 'Accepted',
    });
    await h.advance(100);
    expect(h.lastCall('StopTransaction')?.payload).toMatchObject({
      transactionId,
      reason: 'Remote',
    });
  });

  it('Reset: stops transactions with the reset reason, then asks the transport to restart', async () => {
    const h = setup();
    await h.boot();
    await h.startSession();
    expect(await h.csmsCall('Reset', { type: 'Soft' })).toEqual({ status: 'Accepted' });
    await h.advance(100);
    expect(h.lastCall('StopTransaction')?.payload).toMatchObject({ reason: 'SoftReset' });
    expect(h.restarts).toEqual([30_000]);
  });

  it('UnlockConnector: unlocks, ending a running transaction with UnlockCommand', async () => {
    const h = setup();
    await h.boot();
    await h.startSession();
    expect(await h.csmsCall('UnlockConnector', { connectorId: 1 })).toEqual({ status: 'Unlocked' });
    await h.advance(100);
    expect(h.lastCall('StopTransaction')?.payload).toMatchObject({ reason: 'UnlockCommand' });
    expect(await h.csmsCall('UnlockConnector', { connectorId: 9 })).toEqual({
      status: 'NotSupported',
    });
  });

  it('ChangeAvailability: applies at once when idle, schedules during a transaction', async () => {
    const h = setup();
    await h.boot();
    await h.startSession(1);
    const mark = h.frames.length;
    expect(await h.csmsCall('ChangeAvailability', { connectorId: 2, type: 'Inoperative' })).toEqual(
      { status: 'Accepted' },
    );
    expect(await h.csmsCall('ChangeAvailability', { connectorId: 1, type: 'Inoperative' })).toEqual(
      { status: 'Scheduled' },
    );
    expect(await h.csmsCall('ChangeAvailability', { connectorId: 7, type: 'Inoperative' })).toEqual(
      { status: 'Rejected' },
    );
    expect(h.statuses(mark)).toEqual(['2:Unavailable']);
  });

  it('GetConfiguration and ChangeConfiguration, with changes taking effect', async () => {
    const h = setup({ config: { MeterValueSampleInterval: '60' } });
    await h.boot();
    await h.startSession();
    expect(
      await h.csmsCall('ChangeConfiguration', { key: 'MeterValueSampleInterval', value: '10' }),
    ).toEqual({ status: 'Accepted' });
    expect(
      await h.csmsCall('ChangeConfiguration', { key: 'NumberOfConnectors', value: '4' }),
    ).toEqual({ status: 'Rejected' });
    expect(await h.csmsCall('ChangeConfiguration', { key: 'Nope', value: '1' })).toEqual({
      status: 'NotSupported',
    });
    expect(
      await h.csmsCall('GetConfiguration', { key: ['MeterValueSampleInterval', 'Nope'] }),
    ).toEqual({
      configurationKey: [{ key: 'MeterValueSampleInterval', readonly: false, value: '10' }],
      unknownKey: ['Nope'],
    });
    await h.advance(10_000);
    expect(h.calls('MeterValues')).toHaveLength(1);
  });

  it('ClearCache and DataTransfer', async () => {
    const h = setup();
    await h.boot();
    expect(await h.csmsCall('ClearCache', {})).toEqual({ status: 'Accepted' });
    expect(await h.csmsCall('DataTransfer', { vendorId: 'acme' })).toEqual({
      status: 'UnknownVendorId',
    });
    const outcome = h.cp.dataTransfer({ vendorId: 'VendorX', messageId: 'hello' });
    await h.settle();
    expect(await outcome).toEqual({ ok: true, payload: { status: 'Accepted' } });
    expect(h.lastCall('DataTransfer')?.payload).toEqual({
      vendorId: 'VendorX',
      messageId: 'hello',
    });
  });

  it('TriggerMessage: sends the requested message, NotImplemented for firmware and diagnostics', async () => {
    const h = setup();
    await h.boot();
    await h.startSession(1);
    const mark = h.frames.length;
    for (const requestedMessage of ['Heartbeat', 'BootNotification']) {
      expect(await h.csmsCall('TriggerMessage', { requestedMessage })).toEqual({
        status: 'Accepted',
      });
    }
    expect(
      await h.csmsCall('TriggerMessage', {
        requestedMessage: 'StatusNotification',
        connectorId: 1,
      }),
    ).toEqual({ status: 'Accepted' });
    expect(
      await h.csmsCall('TriggerMessage', { requestedMessage: 'MeterValues', connectorId: 1 }),
    ).toEqual({ status: 'Accepted' });
    await h.advance(100);
    expect(h.actions(mark)).toEqual([
      'Heartbeat',
      'BootNotification',
      'StatusNotification',
      'MeterValues',
    ]);
    expect(h.statuses(mark)).toEqual(['1:Charging']);
    expect(h.lastCall('MeterValues')?.payload).toMatchObject({
      connectorId: 1,
      meterValue: [{ sampledValue: [{ context: 'Trigger' }] }],
    });
    expect(
      await h.csmsCall('TriggerMessage', { requestedMessage: 'FirmwareStatusNotification' }),
    ).toEqual({ status: 'NotImplemented' });
    expect(
      await h.csmsCall('TriggerMessage', { requestedMessage: 'Heartbeat', connectorId: 9 }),
    ).toEqual({ status: 'Rejected' });
  });
});

describe('device events', () => {
  it('a fault during a transaction ends it with reason Other; clearing restores the status', async () => {
    const h = setup();
    await h.boot();
    await h.startSession();
    const mark = h.frames.length;
    h.cp.raiseFault(1, { errorCode: 'GroundFailure', info: 'GND_FAULT' });
    await h.settle();
    expect(h.lastCall('StopTransaction')?.payload).toMatchObject({ reason: 'Other' });
    h.cp.clearFault(1);
    await h.settle();
    expect(h.statuses(mark)).toEqual(['1:Faulted', '1:Finishing']);
    expect(
      h.calls('StatusNotification').find((f) => f.payload.status === 'Faulted')?.payload,
    ).toMatchObject({
      errorCode: 'GroundFailure',
      info: 'GND_FAULT',
    });
  });

  it('EV suspension stops the energy flow and reports SuspendedEV', async () => {
    const h = setup();
    await h.boot();
    await h.startSession();
    h.cp.evSuspend(1);
    await h.settle();
    const paused = h.cp.snapshot().connectors[0];
    await h.advance(600_000);
    expect(h.cp.snapshot().connectors[0]?.energyWh).toBe(paused?.energyWh);
    h.cp.evResume(1);
    await h.settle();
    expect(h.statuses().slice(-2)).toEqual(['1:SuspendedEV', '1:Charging']);
    expect(h.cp.snapshot().connectors[0]?.powerW).toBe(7360);
  });
});

describe('offline behaviour', () => {
  it('queues transaction messages while offline and sends them after the next boot', async () => {
    const h = setup();
    await h.boot();
    await h.startSession();
    h.cp.disconnected();
    const offline = h.frames.length;
    await h.advance(5000);
    h.cp.unplug(1);
    await h.settle();
    expect(h.frames.length).toBe(offline);

    h.cp.connected();
    await h.settle();
    expect(h.actions(offline)).toEqual([
      'BootNotification',
      'StatusNotification',
      'StatusNotification',
      'StatusNotification',
      'StopTransaction',
    ]);
    expect(h.lastCall('StopTransaction')?.payload).toMatchObject({
      reason: 'EVDisconnected',
      timestamp: '2026-11-14T10:00:06.000Z',
    });
  });

  it('sends nothing but BootNotification before the CSMS accepts it', async () => {
    const h = setup({ csms: { BootNotification: () => undefined } });
    h.cp.connected();
    h.cp.plugIn(1);
    await h.settle();
    expect(h.actions()).toEqual(['BootNotification']);
  });
});
