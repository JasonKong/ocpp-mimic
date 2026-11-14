import { describe, expect, it } from 'vitest';
import {
  createChargePoint,
  type ChargePointBehaviour,
  type ChargePointTiming,
  type PersistedChargePoint,
} from './charge-point.js';
import { ManualClock } from './clock.js';
import type { FileTransfer, FirmwareSettings } from './firmware.js';
import { sequentialIds } from './ids.js';
import { parseFrame, type CallFrame, type Frame, type JsonObject } from './ocppj.js';
import { resolvePersonas } from './persona.js';

const T0 = Date.parse('2026-11-14T10:00:00Z');
const BOOT = { chargePointVendor: 'VendorX', chargePointModel: 'AC-7' };

/** Answers a charge point request; undefined leaves it unanswered. */
type Responder = (payload: JsonObject) => JsonObject | undefined;

/** A responder result that makes the fake CSMS answer with a CALLERROR. */
const callError = (errorCode: string): JsonObject => ({ __callError: errorCode });

interface SetupOptions {
  restore?: PersistedChargePoint;
  startAt?: number;
  csms?: Record<string, Responder>;
  config?: Record<string, string>;
  timing?: Partial<ChargePointTiming>;
  behaviour?: Partial<ChargePointBehaviour>;
  energyMultiplier?: number;
  firmware?: Partial<FirmwareSettings>;
  transfer?: FileTransfer;
}

/**
 * A charge point wired to a fake CSMS that answers every request (with
 * defaults or `csms` overrides), on a manual clock starting at T0.
 */
function setup(options: SetupOptions = {}) {
  const clock = new ManualClock(options.startAt ?? T0);
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
    FirmwareStatusNotification: () => ({}),
    DiagnosticsStatusNotification: () => ({}),
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
    ...(options.restore !== undefined && { restore: options.restore }),
    ...(options.behaviour !== undefined && { behaviour: options.behaviour }),
    ...(options.energyMultiplier !== undefined && { energyMultiplier: options.energyMultiplier }),
    ...(options.firmware !== undefined && { firmware: options.firmware }),
    ...(options.transfer !== undefined && { transfer: options.transfer }),
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
        if (reply === undefined) continue;
        const error = reply.__callError;
        cp.receive(
          JSON.stringify(
            typeof error === 'string' ? [4, frame.id, error, '', {}] : [3, frame.id, reply],
          ),
        );
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
  /**
   * Moves time forward timer by timer, settling in between, so that work an
   * async flow schedules after an await still falls due within `ms`.
   */
  async function advance(ms: number) {
    const target = clock.now() + ms;
    for (;;) {
      const next = clock.nextTimerAt();
      if (next === undefined || next > target) break;
      clock.advance(next - clock.now());
      await settle();
    }
    clock.advance(target - clock.now());
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

  it('counts energy from the start of the transaction, not from the CSMS answer', async () => {
    const h = setup();
    await h.boot();
    // startSession: StartTransaction goes out 500 ms after plugging in, the answer at 1 s.
    await h.startSession();
    await h.advance(3_600_000);
    expect(h.cp.snapshot().connectors[0]?.energyWh).toBeCloseTo((7360 * 3600.5) / 3600, 6);
  });

  it('charges while offline and sends StartTransaction after reconnecting', async () => {
    const h = setup();
    await h.boot();
    const card = h.cp.presentIdTag(1, 'TAG');
    await h.settle();
    expect(await card).toBe('authorized');
    h.cp.disconnected();
    h.cp.plugIn(1);
    await h.advance(1000);
    expect(h.cp.snapshot().connectors[0]).toMatchObject({ status: 'Charging', powerW: 7360 });
    expect(h.cp.snapshot().connectors[0]?.transactionId).toBeUndefined();
    expect(h.cp.snapshot().queuedMessages).toBe(1);
    h.cp.connected();
    await h.settle();
    expect(h.cp.snapshot().connectors[0]?.transactionId).toBe(100);
    expect(h.cp.snapshot().queuedMessages).toBe(0);
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
    await h.advance(100);
    expect(h.statuses(mark)).toEqual(['2:Unavailable']);
  });

  it('ChangeAvailability: answers before reporting the new status', async () => {
    const h = setup();
    await h.boot();
    const mark = h.frames.length;
    expect(await h.csmsCall('ChangeAvailability', { connectorId: 1, type: 'Inoperative' })).toEqual(
      { status: 'Accepted' },
    );
    expect(h.statuses(mark)).toEqual([]);
    await h.advance(100);
    // The CALLRESULT (type 3) goes out first, then the StatusNotification CALL.
    expect(h.frames.slice(mark).map((f) => f.type)).toEqual([3, 2]);
    expect(h.statuses(mark)).toEqual(['1:Unavailable']);
  });

  it('ChangeAvailability: connectorId 0 changes only through connectorId 0', async () => {
    const h = setup();
    await h.boot();
    const mark = h.frames.length;
    await h.csmsCall('ChangeAvailability', { connectorId: 1, type: 'Inoperative' });
    await h.csmsCall('ChangeAvailability', { connectorId: 2, type: 'Inoperative' });
    await h.advance(100);
    expect(h.statuses(mark)).toEqual(['1:Unavailable', '2:Unavailable']);
    expect(h.cp.snapshot().station.status).toBe('Available');

    const before = h.frames.length;
    await h.csmsCall('ChangeAvailability', { connectorId: 0, type: 'Inoperative' });
    await h.advance(100);
    expect(h.statuses(before)).toEqual(['0:Unavailable']);
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

  it('TriggerMessage: sends the requested message, Rejected for an unknown connector', async () => {
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

describe('personas', () => {
  it('the same remote stop runs with different timing under two personas', async () => {
    const { personas } = resolvePersonas(
      [
        { delay: '100ms', id: 'quick' },
        { delay: '800ms', id: 'slow' },
      ].map(({ delay, id }) => ({
        source: `${id}.yaml`,
        data: {
          persona: id,
          boot: BOOT,
          connectors: 2,
          timing: { commandDelays: { RemoteStopTransaction: delay } },
        },
      })),
    );
    const stopTimes: string[] = [];
    for (const id of ['quick', 'slow']) {
      const h = setup({ timing: personas.get(id)?.options.timing ?? {} });
      await h.boot();
      const transactionId = await h.startSession();
      await h.csmsCall('RemoteStopTransaction', { transactionId });
      await h.advance(100);
      await h.advance(700);
      stopTimes.push(String(h.lastCall('StopTransaction')?.payload.timestamp));
    }
    // Both sessions start at the same clock time, so the stop times differ by 700 ms.
    expect(stopTimes.map((t) => Date.parse(t) - Date.parse(stopTimes[0] ?? ''))).toEqual([0, 700]);
  });
});

describe('transaction message retries', () => {
  it('retries a failed StopTransaction, waiting TransactionMessageRetryInterval × attempts', async () => {
    let stops = 0;
    const h = setup({
      config: { TransactionMessageAttempts: '3', TransactionMessageRetryInterval: '10' },
      csms: { StopTransaction: () => (++stops < 3 ? callError('InternalError') : {}) },
    });
    await h.boot();
    await h.startSession();
    h.cp.unplug(1);
    await h.settle();
    expect(h.calls('StopTransaction')).toHaveLength(1);
    await h.advance(9_999);
    expect(h.calls('StopTransaction')).toHaveLength(1);
    await h.advance(1);
    expect(h.calls('StopTransaction')).toHaveLength(2);
    await h.advance(20_000);
    expect(h.calls('StopTransaction')).toHaveLength(3);
    expect(h.cp.snapshot().queuedMessages).toBe(0);
  });

  it('drops a message after the last attempt and moves on', async () => {
    const h = setup({
      config: { TransactionMessageAttempts: '2', TransactionMessageRetryInterval: '5' },
      csms: { StopTransaction: () => callError('InternalError') },
    });
    await h.boot();
    await h.startSession();
    h.cp.unplug(1);
    await h.settle();
    await h.advance(60_000);
    expect(h.calls('StopTransaction')).toHaveLength(2);
    expect(h.cp.snapshot().queuedMessages).toBe(0);
  });
});

describe('EV model', () => {
  const SMALL = { capacityKWh: 10, initialSoc: 20, maxPowerW: 7400, phases: 1 as const };
  const HOUR = 3_600_000;
  /** Boots without heartbeats (they would time out during long advances), card in, cable in with the EV. */
  async function charging(config: Record<string, string> = {}) {
    const h = setup({
      config,
      csms: {
        BootNotification: () => ({
          status: 'Accepted',
          currentTime: new Date().toISOString(),
          interval: 0,
        }),
      },
    });
    await h.boot();
    const card = h.cp.presentIdTag(1, 'TAG');
    await h.settle();
    expect(await card).toBe('authorized');
    h.cp.plugIn(1, { name: 'small', profile: SMALL });
    await h.advance(500);
    const connector = () => h.cp.snapshot().connectors[0];
    expect(connector()).toMatchObject({ status: 'Charging', powerW: 7360, ev: { name: 'small' } });
    /** Advances in one-minute steps so the fake CSMS answers before calls time out. */
    const run = async (ms: number) => {
      for (let left = ms; left > 0; left -= 60_000) await h.advance(Math.min(60_000, left));
    };
    return { h, connector, run };
  }

  it('follows the charging curve and reports SoC in meter values', async () => {
    const { h, connector, run } = await charging({
      MeterValueSampleInterval: '600',
      MeterValuesSampledData: 'Energy.Active.Import.Register,Power.Active.Import,SoC',
    });
    // 20 % → 80 % takes 6 kWh at 7360 W; power flows once StartTransaction is answered.
    await run((6000 / 7360) * HOUR);
    expect(connector()?.ev?.soc).toBeCloseTo(80, 2);
    expect(connector()?.energyWh).toBeCloseTo(6000, 1);
    // Above the taper point the power falls.
    await run(600_000);
    expect(connector()?.powerW).toBeLessThan(7360);
    const samples = h.calls('MeterValues').map((call) => call.payload.meterValue);
    expect(samples.length).toBeGreaterThan(4);
    const last = JSON.stringify(samples.at(-1));
    expect(last).toContain('"measurand":"SoC"');
    expect(last).toContain('"unit":"Percent"');
  });

  it('moves to SuspendedEV with 0 W when the battery is full, and a full EV does not resume', async () => {
    const { h, connector, run } = await charging();
    const mark = h.frames.length;
    // Full after about 1 h 30 min 24 s (see ev.test.ts).
    await run(1.6 * HOUR);
    expect(connector()).toMatchObject({ status: 'SuspendedEV', powerW: 0, ev: { soc: 100 } });
    expect(connector()?.energyWh).toBeCloseTo(8000, 1);
    expect(h.statuses(mark)).toContain('1:SuspendedEV');
    h.cp.evResume(1);
    expect(connector()?.status).toBe('SuspendedEV');

    // Stopping reports the energy that went into the battery; unplugging takes the EV away.
    const stop = h.cp.presentIdTag(1, 'TAG');
    await h.settle();
    expect(await stop).toBe('stopping');
    expect(h.lastCall('StopTransaction')?.payload.meterStop).toBe(8000);
    h.cp.unplug(1);
    expect(connector()?.ev).toBeUndefined();
  });

  it('stops counting energy while the EV pauses', async () => {
    const { h, connector } = await charging();
    await h.advance(60_000);
    h.cp.evSuspend(1);
    const paused = connector()?.energyWh ?? NaN;
    const soc = connector()?.ev?.soc ?? NaN;
    await h.advance(600_000);
    expect(connector()).toMatchObject({ status: 'SuspendedEV', powerW: 0 });
    expect(connector()?.energyWh).toBe(paused);
    expect(connector()?.ev?.soc).toBe(soc);
    h.cp.evResume(1);
    expect(connector()).toMatchObject({ status: 'Charging', powerW: 7360 });
  });

  it('reports current per phase for a three-phase EV', async () => {
    const h = setup({ config: { MeterValuesSampledData: 'Current.Import' } });
    await h.boot();
    const card = h.cp.presentIdTag(1, 'TAG');
    await h.settle();
    expect(await card).toBe('authorized');
    h.cp.plugIn(1, { profile: { capacityKWh: 75, initialSoc: 30, maxPowerW: 11_000, phases: 3 } });
    await h.advance(500);
    await h.csmsCall('TriggerMessage', { requestedMessage: 'MeterValues', connectorId: 1 });
    await h.advance(200);
    const values = (
      h.lastCall('MeterValues')?.payload.meterValue as Array<{
        sampledValue: Array<{ phase?: string; value: string }>;
      }>
    )[0]?.sampledValue;
    // 7360 W over three phases at 230 V.
    expect(values?.map((v) => `${v.phase} ${v.value}`)).toEqual(['L1 10.7', 'L2 10.7', 'L3 10.7']);
  });

  it('refuses an unusable EV profile and leaves the connector alone', async () => {
    const h = setup();
    await h.boot();
    expect(() => h.cp.plugIn(1, { profile: { ...SMALL, capacityKWh: 0 } })).toThrow(RangeError);
    expect(h.cp.snapshot().connectors[0]).toMatchObject({ plugged: false });
    expect(h.cp.snapshot().connectors[0]?.ev).toBeUndefined();
  });
});

describe('smart charging', () => {
  const schedule = (
    periods: Array<[number, number]>,
    unit: 'W' | 'A' = 'W',
    extra: Record<string, unknown> = {},
  ) => ({
    chargingRateUnit: unit,
    chargingSchedulePeriod: periods.map(([startPeriod, limit]) => ({ startPeriod, limit })),
    ...extra,
  });
  const txProfile = (id: number, periods: Array<[number, number]>, unit: 'W' | 'A' = 'W') => ({
    chargingProfileId: id,
    stackLevel: 0,
    chargingProfilePurpose: 'TxProfile',
    chargingProfileKind: 'Relative',
    chargingSchedule: schedule(periods, unit),
  });
  const power = (h: ReturnType<typeof setup>, connector = 1) =>
    h.cp.snapshot().connectors.find((c) => c.connectorId === connector)?.powerW;

  it('caps a running session with a TxProfile until it is cleared', async () => {
    const h = setup();
    await h.boot();
    expect(
      await h.csmsCall('SetChargingProfile', {
        connectorId: 1,
        csChargingProfiles: txProfile(1, [[0, 3680]]),
      }),
    ).toEqual({
      status: 'Rejected',
    });
    await h.startSession(1);
    expect(power(h)).toBe(7360);
    expect(
      await h.csmsCall('SetChargingProfile', {
        connectorId: 1,
        csChargingProfiles: txProfile(1, [[0, 3680]]),
      }),
    ).toEqual({
      status: 'Accepted',
    });
    expect(power(h)).toBe(3680);
    expect(h.cp.snapshot().connectors[0]?.limitW).toBe(3680);
    expect(await h.csmsCall('ClearChargingProfile', { id: 1 })).toEqual({ status: 'Accepted' });
    expect(power(h)).toBe(7360);
    expect(await h.csmsCall('ClearChargingProfile', { id: 1 })).toEqual({ status: 'Unknown' });
  });

  it('follows the schedule periods over time, in amperes too', async () => {
    const h = setup();
    await h.boot();
    await h.startSession(1);
    await h.csmsCall('SetChargingProfile', {
      connectorId: 1,
      csChargingProfiles: txProfile(
        1,
        [
          [0, 10],
          [600, 6],
        ],
        'A',
      ),
    });
    // Relative to the transaction start: 10 A × 230 V × 3 phases.
    expect(power(h)).toBe(6900);
    await h.advance(600_000);
    expect(power(h)).toBe(4140);
  });

  it('applies a TxDefaultProfile to the next session and deletes TxProfiles when it ends', async () => {
    const h = setup();
    await h.boot();
    await h.csmsCall('SetChargingProfile', {
      connectorId: 0,
      csChargingProfiles: {
        chargingProfileId: 7,
        stackLevel: 0,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Relative',
        chargingSchedule: schedule([[0, 5000]]),
      },
    });
    await h.startSession(1);
    expect(power(h)).toBe(5000);
    await h.csmsCall('SetChargingProfile', {
      connectorId: 1,
      csChargingProfiles: txProfile(1, [[0, 2000]]),
    });
    expect(power(h)).toBe(2000);
    const stop = h.cp.presentIdTag(1, 'TAG');
    await h.settle();
    expect(await stop).toBe('stopping');
    expect(h.cp.snapshot().chargingProfiles.map((p) => p.purpose)).toEqual(['TxDefaultProfile']);
  });

  it('shares a ChargePointMaxProfile between the charging connectors', async () => {
    const h = setup();
    await h.boot();
    await h.csmsCall('SetChargingProfile', {
      connectorId: 0,
      csChargingProfiles: {
        chargingProfileId: 9,
        stackLevel: 0,
        chargingProfilePurpose: 'ChargePointMaxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: schedule([[0, 10_000]], 'W', {
          startSchedule: new Date(h.clock.now()).toISOString(),
        }),
      },
    });
    await h.startSession(1);
    expect(power(h, 1)).toBe(7360);
    await h.startSession(2, 'TAG-2');
    expect([power(h, 1), power(h, 2)]).toEqual([5000, 5000]);
  });

  it('reports the composite schedule and takes a TxProfile from RemoteStartTransaction', async () => {
    const h = setup();
    await h.boot();
    expect(await h.csmsCall('GetCompositeSchedule', { connectorId: 9, duration: 60 })).toEqual({
      status: 'Rejected',
    });
    expect(
      await h.csmsCall('RemoteStartTransaction', {
        idTag: 'R',
        connectorId: 1,
        chargingProfile: {
          ...txProfile(3, [[0, 3000]]),
          chargingProfilePurpose: 'TxDefaultProfile',
        },
      }),
    ).toEqual({ status: 'Rejected' });
    expect(
      await h.csmsCall('RemoteStartTransaction', {
        idTag: 'R',
        connectorId: 1,
        chargingProfile: txProfile(3, [[0, 3000]]),
      }),
    ).toEqual({ status: 'Accepted' });
    h.cp.plugIn(1);
    await h.advance(2000);
    expect(power(h)).toBe(3000);
    expect(
      await h.csmsCall('GetCompositeSchedule', {
        connectorId: 1,
        duration: 300,
        chargingRateUnit: 'W',
      }),
    ).toMatchObject({
      status: 'Accepted',
      connectorId: 1,
      chargingSchedule: {
        chargingRateUnit: 'W',
        duration: 300,
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 3000 }],
      },
    });
  });

  it('keeps TxDefaultProfiles across a restart but not TxProfiles, and is NotSupported without the profile', async () => {
    const before = setup();
    await before.boot();
    await before.csmsCall('SetChargingProfile', {
      connectorId: 0,
      csChargingProfiles: {
        chargingProfileId: 7,
        stackLevel: 0,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Relative',
        chargingSchedule: schedule([[0, 5000]]),
      },
    });
    await before.startSession(1);
    await before.csmsCall('SetChargingProfile', {
      connectorId: 1,
      csChargingProfiles: txProfile(1, [[0, 2000]]),
    });
    const after = setup({ restore: before.cp.persistentState() });
    expect(after.cp.snapshot().chargingProfiles.map((p) => p.chargingProfileId)).toEqual([7]);

    const plain = setup({ config: { SupportedFeatureProfiles: 'Core,RemoteTrigger' } });
    await plain.boot();
    expect(
      await plain.csmsCall('GetCompositeSchedule', { connectorId: 1, duration: 60 }),
    ).toMatchObject({ type: 4, errorCode: 'NotSupported' });
  });
});

describe('firmware management', () => {
  const at = (h: ReturnType<typeof setup>, ms: number) =>
    new Date(h.clock.now() + ms).toISOString();
  const firmwareStatuses = (h: ReturnType<typeof setup>, from = 0) =>
    h.frames
      .slice(from)
      .filter((f): f is CallFrame => f.type === 2 && f.action === 'FirmwareStatusNotification')
      .map((f) => f.payload.status);
  const diagnosticsStatuses = (h: ReturnType<typeof setup>, from = 0) =>
    h.frames
      .slice(from)
      .filter((f): f is CallFrame => f.type === 2 && f.action === 'DiagnosticsStatusNotification')
      .map((f) => f.payload.status);

  it('downloads at retrieveDate, installs, reboots and reports Installed with the new version', async () => {
    const h = setup();
    await h.boot();
    const mark = h.frames.length;
    expect(
      await h.csmsCall('UpdateFirmware', {
        location: 'ftp://fw.example.com/fw-2.6.0.bin',
        retrieveDate: at(h, 60_000),
      }),
    ).toEqual({});
    await h.advance(59_000);
    expect(firmwareStatuses(h, mark)).toEqual([]);
    await h.advance(1000);
    expect(firmwareStatuses(h, mark)).toEqual(['Downloading']);
    expect(h.cp.snapshot().firmwareStatus).toBe('Downloading');
    await h.advance(10_000);
    expect(firmwareStatuses(h, mark)).toEqual(['Downloading', 'Downloaded', 'Installing']);
    await h.advance(10_000);
    expect(h.restarts).toEqual([180_000]);
    expect(h.cp.snapshot().firmwareVersion).toBe('2.6.0');

    h.cp.disconnected();
    await h.boot();
    expect(h.lastCall('BootNotification')?.payload).toMatchObject({ firmwareVersion: '2.6.0' });
    expect(firmwareStatuses(h, mark)).toEqual([
      'Downloading',
      'Downloaded',
      'Installing',
      'Installed',
    ]);
    expect(h.cp.snapshot()).toMatchObject({ firmwareStatus: 'Idle', firmwareVersion: '2.6.0' });
    // The version survives a restart from the State Store.
    const after = setup({ restore: h.cp.persistentState() });
    await after.boot();
    expect(after.lastCall('BootNotification')?.payload).toMatchObject({ firmwareVersion: '2.6.0' });
  });

  it('waits for running transactions to end before installing', async () => {
    const h = setup({ firmware: { downloadMs: 1000, installMs: 1000 } });
    await h.boot();
    await h.startSession(1);
    const mark = h.frames.length;
    await h.csmsCall('UpdateFirmware', {
      location: 'ftp://fw.example.com/fw-3.0.0.bin',
      retrieveDate: at(h, 0),
    });
    await h.advance(60_000);
    expect(firmwareStatuses(h, mark)).toEqual(['Downloading', 'Downloaded']);
    h.cp.unplug(1);
    await h.advance(1000);
    expect(firmwareStatuses(h, mark)).toEqual(['Downloading', 'Downloaded', 'Installing']);
    await h.advance(1000);
    expect(h.restarts).toEqual([180_000]);
  });

  it('retries a failing download, then reports DownloadFailed; a failed install keeps the old version', async () => {
    const download = setup({ firmware: { downloadMs: 1000, download: 'fail' } });
    await download.boot();
    await download.csmsCall('UpdateFirmware', {
      location: 'ftp://fw.example.com/fw-2.6.0.bin',
      retrieveDate: at(download, 0),
      retries: 2,
      retryInterval: 5,
    });
    // Three attempts of 1 s, 5 s apart.
    await download.advance(12_000);
    expect(firmwareStatuses(download)).toEqual(['Downloading']);
    await download.advance(1000);
    expect(firmwareStatuses(download)).toEqual(['Downloading', 'DownloadFailed']);
    expect(download.cp.snapshot().firmwareStatus).toBe('Idle');

    const install = setup({ firmware: { downloadMs: 1000, installMs: 1000, install: 'fail' } });
    await install.boot();
    await install.csmsCall('UpdateFirmware', {
      location: 'ftp://fw.example.com/fw-2.6.0.bin',
      retrieveDate: at(install, 0),
    });
    await install.advance(5000);
    expect(firmwareStatuses(install)).toEqual([
      'Downloading',
      'Downloaded',
      'Installing',
      'InstallationFailed',
    ]);
    expect(install.restarts).toEqual([]);
    expect(install.cp.snapshot().firmwareVersion).toBeUndefined();
  });

  it('downloads and uploads over HTTP with the real file transfer when one is given', async () => {
    const downloads: string[] = [];
    const uploads: { location: string; fileName: string; content: string }[] = [];
    let downloadOk = false;
    const transfer: FileTransfer = {
      download: (location) => {
        downloads.push(location);
        const ok = downloadOk;
        downloadOk = true;
        return Promise.resolve(ok);
      },
      upload: (location, fileName, content) => {
        uploads.push({ location, fileName, content });
        return Promise.resolve(true);
      },
    };
    const h = setup({ transfer, firmware: { installMs: 1000 } });
    await h.boot();
    await h.csmsCall('UpdateFirmware', {
      location: 'https://fw.example.com/fw-2.7.0.bin',
      retrieveDate: at(h, 0),
      retries: 1,
      retryInterval: 2,
    });
    await h.advance(2000);
    expect(downloads).toEqual([
      'https://fw.example.com/fw-2.7.0.bin',
      'https://fw.example.com/fw-2.7.0.bin',
    ]);
    expect(firmwareStatuses(h)).toEqual(['Downloading', 'Downloaded', 'Installing']);

    const answer = await h.csmsCall('GetDiagnostics', { location: 'https://logs.example.com/up' });
    expect(answer).toEqual({ fileName: 'diagnostics-20261114T100002Z.log' });
    await h.settle();
    expect(uploads).toEqual([
      {
        location: 'https://logs.example.com/up',
        fileName: 'diagnostics-20261114T100002Z.log',
        content: expect.stringContaining('config HeartbeatInterval=') as unknown as string,
      },
    ]);
    expect(diagnosticsStatuses(h)).toEqual(['Uploading', 'Uploaded']);
  });

  it('simulates diagnostics uploads, reports both statuses on TriggerMessage, and is NotSupported without the profile', async () => {
    const h = setup({ firmware: { uploadMs: 2000, upload: 'fail' } });
    await h.boot();
    expect(await h.csmsCall('GetDiagnostics', { location: 'ftp://logs.example.com/' })).toEqual({
      fileName: 'diagnostics-20261114T100000Z.log',
    });
    expect(h.cp.snapshot().diagnosticsStatus).toBe('Uploading');
    await h.advance(2000);
    expect(diagnosticsStatuses(h)).toEqual(['Uploading', 'UploadFailed']);

    const mark = h.frames.length;
    for (const requestedMessage of [
      'FirmwareStatusNotification',
      'DiagnosticsStatusNotification',
    ]) {
      expect(await h.csmsCall('TriggerMessage', { requestedMessage })).toEqual({
        status: 'Accepted',
      });
    }
    await h.advance(100);
    expect(firmwareStatuses(h, mark)).toEqual(['Idle']);
    expect(diagnosticsStatuses(h, mark)).toEqual(['Idle']);

    const plain = setup({ config: { SupportedFeatureProfiles: 'Core,RemoteTrigger' } });
    await plain.boot();
    expect(
      await plain.csmsCall('GetDiagnostics', { location: 'ftp://logs.example.com/' }),
    ).toMatchObject({ type: 4, errorCode: 'NotSupported' });
  });
});

describe('reservations', () => {
  const inMinutes = (h: ReturnType<typeof setup>, minutes: number) =>
    new Date(h.clock.now() + minutes * 60_000).toISOString();
  const reserve = (h: ReturnType<typeof setup>, payload: Record<string, unknown>) =>
    h.csmsCall('ReserveNow', {
      expiryDate: inMinutes(h, 10),
      idTag: 'RES',
      reservationId: 1,
      ...payload,
    });
  const card = async (h: ReturnType<typeof setup>, connectorId: number, idTag: string) => {
    const result = h.cp.presentIdTag(connectorId, idTag);
    await h.settle();
    return result;
  };

  it('holds a connector for its idTag and hands the reservationId to StartTransaction', async () => {
    const h = setup();
    await h.boot();
    const mark = h.frames.length;
    expect(await reserve(h, { connectorId: 1 })).toEqual({ status: 'Accepted' });
    expect(h.statuses(mark)).toEqual(['1:Reserved']);
    expect(await card(h, 1, 'OTHER')).toBe('rejected');
    expect(await card(h, 1, 'RES')).toBe('authorized');
    h.cp.plugIn(1);
    await h.advance(1000);
    expect(h.lastCall('StartTransaction')?.payload).toMatchObject({
      idTag: 'RES',
      reservationId: 1,
    });
    expect(h.cp.snapshot().reservations).toEqual([]);
    expect(h.cp.snapshot().connectors[0]?.status).toBe('Charging');
  });

  it('ends at expiryDate or on CancelReservation, freeing the connector', async () => {
    const h = setup();
    await h.boot();
    await reserve(h, { connectorId: 1, expiryDate: inMinutes(h, 1) });
    const mark = h.frames.length;
    await h.advance(60_000);
    expect(h.statuses(mark)).toEqual(['1:Available']);
    expect(h.cp.snapshot().reservations).toEqual([]);
    await reserve(h, { connectorId: 2, reservationId: 2 });
    expect(await h.csmsCall('CancelReservation', { reservationId: 2 })).toEqual({
      status: 'Accepted',
    });
    expect(await h.csmsCall('CancelReservation', { reservationId: 2 })).toEqual({
      status: 'Rejected',
    });
    expect(h.cp.snapshot().connectors[1]?.status).toBe('Available');
  });

  it('answers Occupied, Faulted, Unavailable or Rejected when it cannot reserve', async () => {
    const h = setup();
    await h.boot();
    await h.startSession(1);
    expect(await reserve(h, { connectorId: 1 })).toEqual({ status: 'Occupied' });
    h.cp.raiseFault(2, { errorCode: 'GroundFailure' });
    expect(await reserve(h, { connectorId: 2 })).toEqual({ status: 'Faulted' });
    h.cp.clearFault(2);
    await h.csmsCall('ChangeAvailability', { connectorId: 2, type: 'Inoperative' });
    await h.advance(100);
    expect(await reserve(h, { connectorId: 2 })).toEqual({ status: 'Unavailable' });
    expect(await reserve(h, { connectorId: 9 })).toEqual({ status: 'Rejected' });
    const noZero = setup({ config: { ReserveConnectorZeroSupported: 'false' } });
    await noZero.boot();
    expect(await reserve(noZero, { connectorId: 0 })).toEqual({ status: 'Rejected' });
  });

  it('keeps one connector free for a reservation on connectorId 0', async () => {
    const h = setup();
    await h.boot();
    expect(await reserve(h, { connectorId: 0 })).toEqual({ status: 'Accepted' });
    expect(h.cp.snapshot().connectors.map((c) => c.status)).toEqual(['Available', 'Available']);
    expect(await card(h, 1, 'A')).toBe('authorized');
    h.cp.plugIn(1);
    await h.advance(1000);
    // Connector 2 is the last free one: only the reserved card may use it.
    expect(await card(h, 2, 'B')).toBe('rejected');
    expect(await card(h, 2, 'RES')).toBe('authorized');
    h.cp.plugIn(2);
    await h.advance(1000);
    expect(h.lastCall('StartTransaction')?.payload).toMatchObject({
      connectorId: 2,
      reservationId: 1,
    });
  });

  it('accepts a card whose parentIdTag matches, asking the CSMS for the parent', async () => {
    const h = setup({
      csms: { Authorize: () => ({ idTagInfo: { status: 'Accepted', parentIdTag: 'FLEET' } }) },
    });
    await h.boot();
    await reserve(h, { connectorId: 1, parentIdTag: 'FLEET' });
    expect(await card(h, 1, 'DRIVER-7')).toBe('authorized');
    expect(h.calls('Authorize').map((c) => c.payload.idTag)).toContain('DRIVER-7');
  });

  it('ends when the connector faults, and lets a remote start use it for its idTag only', async () => {
    const h = setup();
    await h.boot();
    await reserve(h, { connectorId: 1 });
    expect(await h.csmsCall('RemoteStartTransaction', { idTag: 'OTHER', connectorId: 1 })).toEqual({
      status: 'Rejected',
    });
    expect(await h.csmsCall('RemoteStartTransaction', { idTag: 'RES' })).toEqual({
      status: 'Accepted',
    });
    h.cp.plugIn(1);
    await h.advance(2000);
    expect(h.lastCall('StartTransaction')?.payload).toMatchObject({
      connectorId: 1,
      reservationId: 1,
    });

    await reserve(h, { connectorId: 2, reservationId: 5 });
    h.cp.raiseFault(2, { errorCode: 'GroundFailure' });
    expect(h.cp.snapshot().reservations).toEqual([]);
  });

  it('survives a restart, and is NotSupported without the Reservation profile', async () => {
    const before = setup();
    await before.boot();
    await reserve(before, { connectorId: 1 });
    const after = setup({ restore: before.cp.persistentState() });
    await after.boot();
    expect(after.statuses()).toContain('1:Reserved');
    expect(after.cp.snapshot().reservations).toMatchObject([
      { reservationId: 1, connectorId: 1, idTag: 'RES' },
    ]);

    const plain = setup({ config: { SupportedFeatureProfiles: 'Core,RemoteTrigger' } });
    await plain.boot();
    expect(await reserve(plain, { connectorId: 1 })).toMatchObject({
      type: 4,
      errorCode: 'NotSupported',
    });
  });
});

describe('energy multiplier', () => {
  const quiet = {
    BootNotification: () => ({
      status: 'Accepted',
      currentTime: new Date().toISOString(),
      interval: 0,
    }),
  };

  it('books energy faster than real time while timestamps stay real', async () => {
    const h = setup({
      energyMultiplier: 60,
      csms: quiet,
      config: {
        MeterValueSampleInterval: '60',
        MeterValuesSampledData: 'Energy.Active.Import.Register',
      },
    });
    await h.boot();
    await h.startSession(1);
    const startedAt = h.clock.now();
    await h.advance(60_000);
    // One real minute at 7360 W counts as one hour (plus the 0.5 s before the answer).
    expect(h.cp.snapshot().connectors[0]?.energyWh).toBeCloseTo((7360 * 60.5) / 60, 0);
    expect(h.cp.snapshot().energyMultiplier).toBe(60);
    const sample = h.lastCall('MeterValues')?.payload.meterValue as Array<{ timestamp: string }>;
    expect(Date.parse(sample[0]?.timestamp ?? '')).toBeLessThanOrEqual(h.clock.now());
    expect(Date.parse(sample[0]?.timestamp ?? '')).toBeGreaterThan(startedAt);
  });

  it('fills an EV in a fraction of the real time', async () => {
    const h = setup({ energyMultiplier: 60, csms: quiet });
    await h.boot();
    const card = h.cp.presentIdTag(1, 'TAG');
    await h.settle();
    expect(await card).toBe('authorized');
    h.cp.plugIn(1, { profile: { capacityKWh: 10, initialSoc: 20, maxPowerW: 7400, phases: 1 } });
    await h.advance(500);
    // About 1 h 30 min of energy: full after about 90 s of clock time.
    for (let i = 0; i < 9; i++) await h.advance(10_000);
    expect(h.cp.snapshot().connectors[0]?.status).toBe('Charging');
    for (let i = 0; i < 3; i++) await h.advance(10_000);
    expect(h.cp.snapshot().connectors[0]).toMatchObject({
      status: 'SuspendedEV',
      ev: { soc: 100 },
    });
  });

  it('applies a change from then on, survives a restart and rejects bad values', async () => {
    const h = setup({ csms: quiet });
    await h.boot();
    await h.startSession(1);
    const before = h.cp.snapshot().connectors[0]?.energyWh ?? NaN;
    await h.advance(30_000);
    h.cp.setEnergyMultiplier(10);
    await h.advance(30_000);
    const expected = (7360 * (30 + 300)) / 3600;
    expect((h.cp.snapshot().connectors[0]?.energyWh ?? NaN) - before).toBeCloseTo(expected, 3);
    expect(() => h.cp.setEnergyMultiplier(0)).toThrow(RangeError);
    expect(() => setup({ energyMultiplier: -1 })).toThrow(RangeError);

    const saved = h.cp.persistentState();
    expect(saved.energyMultiplier).toBe(10);
    expect(setup({ restore: saved, energyMultiplier: 2 }).cp.snapshot().energyMultiplier).toBe(10);
  });
});

describe('test switches', () => {
  it('refuses remote starts while the switch is on', async () => {
    const h = setup({ behaviour: { refuseRemoteStart: true } });
    await h.boot();
    expect(await h.csmsCall('RemoteStartTransaction', { idTag: 'REMOTE', connectorId: 1 })).toEqual(
      { status: 'Rejected' },
    );
    await h.advance(1000);
    expect(h.calls('StartTransaction')).toHaveLength(0);

    h.cp.setBehaviour({ refuseRemoteStart: false });
    expect(await h.csmsCall('RemoteStartTransaction', { idTag: 'REMOTE', connectorId: 1 })).toEqual(
      { status: 'Accepted' },
    );
  });

  it('locks the cable during a transaction and will not unplug it', async () => {
    const h = setup({ behaviour: { cableLock: true } });
    await h.boot();
    await h.startSession(1);
    expect(h.cp.snapshot().connectors[0]).toMatchObject({ locked: true, status: 'Charging' });
    expect(h.cp.snapshot().connectors[1]).toMatchObject({ locked: false });

    expect(h.cp.unplug(1)).toBe('locked');
    await h.settle();
    expect(h.calls('StopTransaction')).toHaveLength(0);
    expect(h.cp.snapshot().connectors[0]).toMatchObject({ plugged: true, status: 'Charging' });

    // Ending the transaction releases the lock.
    expect(await h.cp.presentIdTag(1, 'TAG')).toBe('stopping');
    await h.settle();
    expect(h.cp.snapshot().connectors[0]).toMatchObject({ locked: false, status: 'Finishing' });
    expect(h.cp.unplug(1)).toBe('unplugged');
  });

  it('releases the lock on UnlockConnector', async () => {
    const h = setup({ behaviour: { cableLock: true } });
    await h.boot();
    await h.startSession(1);
    expect(await h.csmsCall('UnlockConnector', { connectorId: 1 })).toEqual({ status: 'Unlocked' });
    expect(h.cp.snapshot().connectors[0]?.locked).toBe(false);
    await h.advance(100);
    expect(h.lastCall('StopTransaction')?.payload).toMatchObject({ reason: 'UnlockCommand' });
    expect(h.cp.unplug(1)).toBe('unplugged');
  });

  it('applies the cable lock switch to running transactions', async () => {
    const h = setup();
    await h.boot();
    await h.startSession(1);
    expect(h.cp.snapshot().connectors[0]?.locked).toBe(false);
    h.cp.setBehaviour({ cableLock: true });
    expect(h.cp.snapshot().connectors[0]?.locked).toBe(true);
    expect(h.cp.snapshot().behaviour).toEqual({ refuseRemoteStart: false, cableLock: true });
    h.cp.setBehaviour({ cableLock: false });
    expect(h.cp.snapshot().connectors[0]?.locked).toBe(false);
    expect(h.cp.unplug(1)).toBe('unplugged');
  });
});

describe('persistence across restarts', () => {
  it('keeps the local authorization list', async () => {
    const before = setup();
    await before.boot();
    expect(
      await before.csmsCall('SendLocalList', {
        listVersion: 4,
        updateType: 'Full',
        localAuthorizationList: [{ idTag: 'LIST', idTagInfo: { status: 'Accepted' } }],
      }),
    ).toEqual({ status: 'Accepted' });
    const saved = before.cp.persistentState();
    const after = setup({ restore: saved });
    await after.boot();
    expect(after.cp.snapshot().localList).toEqual({ version: 4, size: 1 });
    expect(await after.csmsCall('GetLocalListVersion', {})).toEqual({ listVersion: 4 });
  });

  it('keeps the test switches, and defaults them for states saved without any', async () => {
    const before = setup();
    before.cp.setBehaviour({ refuseRemoteStart: true });
    const saved = before.cp.persistentState();
    expect(saved.behaviour).toEqual({ refuseRemoteStart: true, cableLock: false });
    expect(setup({ restore: saved }).cp.snapshot().behaviour).toEqual({
      refuseRemoteStart: true,
      cableLock: false,
    });

    const { behaviour: _dropped, ...older } = saved;
    expect(
      setup({ restore: older, behaviour: { cableLock: true } }).cp.snapshot().behaviour,
    ).toEqual({ refuseRemoteStart: false, cableLock: true });
  });

  it('ends a running transaction with PowerLoss at the time of the last save', async () => {
    const before = setup();
    await before.boot();
    const transactionId = await before.startSession();
    await before.advance(1_800_000);
    const saved = before.cp.persistentState();
    expect(saved.transactions).toMatchObject([{ connectorId: 1, idTag: 'TAG', transactionId }]);

    const after = setup({ restore: saved, startAt: saved.savedAt + 600_000 });
    expect(after.cp.snapshot().connectors[0]?.energyWh).toBeCloseTo(saved.meters['1'] ?? NaN, 6);
    await after.boot();
    expect(after.lastCall('StopTransaction')?.payload).toEqual({
      transactionId,
      meterStop: Math.round(saved.meters['1'] ?? NaN),
      timestamp: new Date(saved.savedAt).toISOString(),
      reason: 'PowerLoss',
    });
    expect(after.cp.snapshot().connectors[0]).toMatchObject({
      status: 'Available',
      plugged: false,
    });
  });

  it('keeps configuration changes and messages queued while offline', async () => {
    const before = setup();
    await before.boot();
    await before.csmsCall('ChangeConfiguration', { key: 'MeterValueSampleInterval', value: '15' });
    await before.startSession();
    before.cp.disconnected();
    before.cp.unplug(1);
    await before.settle();
    const saved = before.cp.persistentState();
    expect(saved.outbox.map((entry) => entry.action)).toEqual(['StopTransaction']);

    const after = setup({ restore: saved });
    expect(after.cp.snapshot().config.MeterValueSampleInterval).toBe('15');
    await after.boot();
    expect(after.calls('StopTransaction').map((call) => call.payload.reason)).toEqual([
      'EVDisconnected',
    ]);
  });
});
