import { describe, expect, it } from 'vitest';
import {
  createChargePoint,
  type ChargePointBehaviour,
  type ChargePointEvent,
} from './charge-point.js';
import { ManualClock } from './clock.js';
import { sequentialIds } from './ids.js';
import { createChargePoint201, type ChargePoint201 } from './ocpp201/charge-point.js';
import { parseFrame, type JsonObject } from './ocppj.js';
import {
  chargingStateLabel,
  createSessionTracker,
  meterSamples,
  stateDurations,
  type SessionFrame,
  type SessionRecord,
  type SessionTouch,
} from './session.js';

const T0 = Date.parse('2026-11-15T10:00:00Z');
type Responder = (payload: JsonObject) => JsonObject | undefined;

interface HarnessOptions {
  ocpp: '1.6' | '2.0.1' | '2.1';
  /** 2.x: the persona's features. Default Core. */
  features?: string[];
  csms?: Record<string, Responder>;
  config?: Record<string, string>;
  deviceModel?: Record<string, Record<string, string | number | boolean>>;
  behaviour?: Partial<ChargePointBehaviour>;
}

/**
 * A 1.6 or 2.0.1 charge point against a scripted CSMS, with every frame
 * (both directions, as the recorder would keep it) and every session hint
 * fed to a tracker as it happens.
 */
function harness(options: HarnessOptions) {
  const clock = new ManualClock(T0);
  const iso = () => new Date(clock.now()).toISOString();
  const tracker = createSessionTracker({ stationId: 'CP-1', ocpp: options.ocpp });
  const touches: SessionTouch[] = [];
  const sessions = new Map<number, SessionRecord>();
  let seq = 0;
  let nextTx = 100;
  const sent: { id: string; action: string; payload: JsonObject }[] = [];
  /** uniqueId → action, per direction of the CALL. */
  const cpCalls = new Map<string, string>();
  const csmsCalls = new Map<string, string>();
  const record = (list: SessionTouch[]) => {
    for (const t of list) {
      touches.push(t);
      sessions.set(t.session.n, t.session);
      if (t.mergedInto !== undefined) sessions.delete(t.session.n);
    }
  };
  const feed = (direction: SessionFrame['direction'], text: string) => {
    const parsed = parseFrame(text);
    if (!parsed.ok) return;
    const f = parsed.frame;
    const frame: SessionFrame = {
      seq: ++seq,
      at: iso(),
      direction,
      messageType: f.type,
      uniqueId: f.id,
    };
    if (f.type === 2) {
      frame.action = f.action;
      frame.payload = f.payload;
      (direction === 'cp-to-csms' ? cpCalls : csmsCalls).set(f.id, f.action);
    } else {
      const action = (direction === 'cp-to-csms' ? csmsCalls : cpCalls).get(f.id);
      if (action !== undefined) frame.action = action;
      if (f.type === 3) frame.payload = f.payload;
      else frame.errorCode = f.errorCode;
    }
    record(tracker.frame(frame));
  };
  const onEvent = (event: ChargePointEvent) => {
    if (event.type === 'session') record(tracker.hint(event.hint, iso()));
  };
  const responders: Record<string, Responder> = {
    BootNotification: () => ({ status: 'Accepted', currentTime: iso(), interval: 300 }),
    Heartbeat: () => ({ currentTime: iso() }),
    StatusNotification: () => ({}),
    MeterValues: () => ({}),
    NotifyReport: () => ({}),
    NotifyEvent: () => ({}),
    SecurityEventNotification: () => ({}),
    Authorize: () =>
      options.ocpp === '1.6'
        ? { idTagInfo: { status: 'Accepted' } }
        : { idTokenInfo: { status: 'Accepted' } },
    StartTransaction: () => ({ idTagInfo: { status: 'Accepted' }, transactionId: nextTx++ }),
    StopTransaction: () => ({}),
    TransactionEvent: () => ({}),
    ...options.csms,
  };
  const send = (text: string) => {
    feed('cp-to-csms', text);
    const parsed = parseFrame(text);
    if (parsed.ok && parsed.frame.type === 2) {
      sent.push({
        id: parsed.frame.id,
        action: parsed.frame.action,
        payload: parsed.frame.payload,
      });
    }
  };
  const cp =
    options.ocpp === '1.6'
      ? createChargePoint({
          clock,
          ids: sequentialIds('cp-'),
          boot: { chargePointVendor: 'VendorX', chargePointModel: 'AC-7' },
          connectors: 2,
          config: { values: { MeterValueSampleInterval: '60', ...options.config } },
          timing: {},
          send,
          onEvent,
          ...(options.behaviour !== undefined && { behaviour: options.behaviour }),
        })
      : createChargePoint201({
          clock,
          ids: sequentialIds('cp-'),
          boot: { model: 'AC-7', vendorName: 'VendorX', firmwareVersion: '1.0.0' },
          connectors: 2,
          timing: { actionDelayMs: 0 },
          send,
          onEvent,
          ocpp: options.ocpp === '2.1' ? '2.1' : '2.0.1',
          features: options.features ?? ['Core'],
          ...(options.deviceModel !== undefined && { deviceModel: options.deviceModel }),
        });
  const receive = (text: string) => {
    feed('csms-to-cp', text);
    cp.receive(text);
  };
  let answered = 0;
  let csmsIds = 0;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  async function settle(): Promise<void> {
    for (let round = 0; round < 200; round++) {
      await tick();
      if (answered === sent.length) {
        await tick();
        if (answered === sent.length) return;
      }
      while (answered < sent.length) {
        const call = sent[answered++];
        if (call === undefined) continue;
        const reply = responders[call.action]?.(call.payload);
        if (reply === undefined) continue;
        const error = reply.__callError;
        receive(
          JSON.stringify(
            typeof error === 'string' ? [4, call.id, error, '', {}] : [3, call.id, reply],
          ),
        );
      }
    }
    throw new Error('the charge point never settled');
  }
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
  async function csmsCall(action: string, payload: JsonObject) {
    receive(JSON.stringify([2, `csms-${++csmsIds}`, action, payload]));
    await settle();
  }
  async function boot() {
    cp.connected();
    await settle();
  }
  /** Presents a card, answering the CSMS calls it causes while waiting. */
  async function present(connectorId: number, idTag: string, type?: string) {
    const result = cp.presentIdTag(connectorId, idTag, type);
    await settle();
    return result;
  }
  const list = () => [...sessions.values()].sort((a, b) => a.n - b.n);
  const steps = (session: SessionRecord | undefined) =>
    session?.timeline.map(
      (s) =>
        `${s.action}${s.messageType === 2 ? '' : '.conf'}${s.status === undefined ? '' : ` ${s.status}`}`,
    );
  return { cp, clock, tracker, touches, list, steps, settle, advance, csmsCall, boot, present };
}

describe('1.6 sessions', () => {
  it('records a local card: Authorize, StartTransaction, samples, states and the stop', async () => {
    const h = harness({ ocpp: '1.6' });
    await h.boot();
    expect(await h.present(1, 'TAG')).toBe('authorized');
    h.cp.plugIn(1);
    await h.advance(130_000);
    expect(await h.present(1, 'TAG')).toBe('stopping');
    await h.settle();
    const [session] = h.list();
    expect(h.list()).toHaveLength(1);
    expect(session).toMatchObject({
      n: 1,
      ocpp: '1.6',
      evseId: 1,
      state: 'finished',
      source: 'local',
      idToken: { idToken: 'TAG' },
      transactionId: 100,
      meterStartWh: 0,
      stopReason: 'Local',
    });
    expect(h.steps(session)).toEqual([
      'Authorize',
      'Authorize.conf Accepted',
      'StartTransaction',
      'StartTransaction.conf Accepted',
    ]);
    expect(session?.timeline[1]?.sincePreviousMs).toBe(0);
    expect(session?.samples.length).toBeGreaterThanOrEqual(2);
    expect(session?.samples.every((s) => s.energyWh !== undefined)).toBe(true);
    expect(session?.states.map((s) => s.state)).toContain('charging');
    expect(session?.endedAt).toBeDefined();
    // Every frame of the session is kept with it, the stop included.
    const frames = h.touches.filter((t) => t.session.n === 1).flatMap((t) => t.frames);
    expect(frames.length).toBeGreaterThanOrEqual(10);
  });

  it('records a remote start, with the RemoteStartTransaction first in the timeline', async () => {
    const h = harness({ ocpp: '1.6' });
    await h.boot();
    await h.csmsCall('RemoteStartTransaction', { idTag: 'APP-USER', connectorId: 2 });
    h.cp.plugIn(2);
    await h.advance(2000);
    const [session] = h.list();
    expect(session).toMatchObject({
      evseId: 2,
      state: 'running',
      source: 'remote',
      idToken: { idToken: 'APP-USER' },
      transactionId: 100,
    });
    expect(h.steps(session)).toEqual([
      'RemoteStartTransaction',
      'RemoteStartTransaction.conf Accepted',
      'StartTransaction',
      'StartTransaction.conf Accepted',
    ]);
  });

  it('records an Authorize of a remote start in its own session', async () => {
    const h = harness({ ocpp: '1.6', config: { AuthorizeRemoteTxRequests: 'true' } });
    await h.boot();
    await h.csmsCall('RemoteStartTransaction', { idTag: 'APP-USER' });
    h.cp.plugIn(1);
    await h.advance(2000);
    expect(h.list()).toHaveLength(1);
    expect(h.list()[0]).toMatchObject({ source: 'remote', evseId: 1, state: 'running' });
    expect(h.steps(h.list()[0])).toEqual([
      'RemoteStartTransaction',
      'RemoteStartTransaction.conf Accepted',
      'Authorize',
      'Authorize.conf Accepted',
      'StartTransaction',
      'StartTransaction.conf Accepted',
    ]);
  });

  it('records remote starts that fail: rejected, not authorized, no cable', async () => {
    const refused = harness({ ocpp: '1.6', behaviour: { refuseRemoteStart: true } });
    await refused.boot();
    await refused.csmsCall('RemoteStartTransaction', { idTag: 'APP-USER', connectorId: 1 });
    expect(refused.list()).toEqual([
      expect.objectContaining({
        state: 'not-started',
        source: 'remote',
        evseId: 1,
        failure: { reason: 'Rejected' },
      }),
    ]);

    const invalid = harness({
      ocpp: '1.6',
      config: { AuthorizeRemoteTxRequests: 'true' },
      csms: { Authorize: () => ({ idTagInfo: { status: 'Invalid' } }) },
    });
    await invalid.boot();
    await invalid.csmsCall('RemoteStartTransaction', { idTag: 'APP-USER', connectorId: 1 });
    await invalid.advance(1000);
    expect(invalid.list()).toHaveLength(1);
    expect(invalid.list()[0]).toMatchObject({
      state: 'not-started',
      source: 'remote',
      failure: { reason: 'NotAuthorized', detail: 'Invalid' },
    });

    const noCable = harness({ ocpp: '1.6', config: { ConnectionTimeOut: '30' } });
    await noCable.boot();
    await noCable.csmsCall('RemoteStartTransaction', { idTag: 'APP-USER', connectorId: 1 });
    await noCable.advance(31_000);
    expect(noCable.list()).toEqual([
      expect.objectContaining({
        state: 'not-started',
        source: 'remote',
        failure: { reason: 'ConnectionTimeout' },
      }),
    ]);
  });

  it('records a card the CSMS refuses as one not-started local session', async () => {
    const h = harness({
      ocpp: '1.6',
      csms: { Authorize: () => ({ idTagInfo: { status: 'Blocked' } }) },
    });
    await h.boot();
    expect(await h.present(1, 'BAD')).toBe('rejected');
    await h.settle();
    expect(h.list()).toHaveLength(1);
    expect(h.list()[0]).toMatchObject({
      state: 'not-started',
      source: 'local',
      evseId: 1,
      idToken: { idToken: 'BAD' },
      failure: { reason: 'NotAuthorized', detail: 'Blocked' },
    });
    expect(h.steps(h.list()[0])).toEqual(['Authorize', 'Authorize.conf Blocked']);
  });

  it('numbers sessions per station and tracks two connectors apart', async () => {
    const h = harness({ ocpp: '1.6' });
    await h.boot();
    await h.present(1, 'A');
    h.cp.plugIn(1);
    await h.csmsCall('RemoteStartTransaction', { idTag: 'B', connectorId: 2 });
    h.cp.plugIn(2);
    await h.advance(2000);
    expect(h.list().map((s) => `${s.n}:${s.evseId}:${s.source}:${s.idToken?.idToken}`)).toEqual([
      '1:1:local:A',
      '2:2:remote:B',
    ]);
    expect(h.tracker.nextN()).toBe(3);
  });
});

describe('2.0.1 sessions', () => {
  it('records a local card with its token type, the transaction events and the stop', async () => {
    const h = harness({ ocpp: '2.0.1' });
    await h.boot();
    expect(await h.present(1, 'AA000001')).toBe('authorized');
    h.cp.plugIn(1);
    await h.advance(2000);
    expect(await h.present(1, 'AA000001')).toBe('stopping');
    await h.advance(2000);
    const [session] = h.list();
    expect(h.list()).toHaveLength(1);
    expect(session).toMatchObject({
      ocpp: '2.0.1',
      evseId: 1,
      connectorId: 1,
      state: 'finished',
      source: 'local',
      idToken: { idToken: 'AA000001', type: 'ISO14443' },
    });
    expect(typeof session?.transactionId).toBe('string');
    expect(session?.stopReason).toBeDefined();
    expect(h.steps(session)?.slice(0, 2)).toEqual(['Authorize', 'Authorize.conf Accepted']);
    expect(h.steps(session)?.some((s) => s.startsWith('TransactionEvent Started'))).toBe(true);
  });

  it('records a RequestStartTransaction with its remoteStartId', async () => {
    const h = harness({ ocpp: '2.0.1' });
    await h.boot();
    await h.csmsCall('RequestStartTransaction', {
      remoteStartId: 7,
      evseId: 2,
      idToken: { idToken: 'APP-USER-1', type: 'Central' },
    });
    h.cp.plugIn(2);
    await h.advance(2000);
    const [session] = h.list();
    expect(h.list()).toHaveLength(1);
    expect(session).toMatchObject({
      evseId: 2,
      state: 'running',
      source: 'remote',
      remoteStartId: 7,
      idToken: { idToken: 'APP-USER-1', type: 'Central' },
    });
    expect(h.steps(session)?.slice(0, 2)).toEqual([
      'RequestStartTransaction',
      'RequestStartTransaction.conf Accepted',
    ]);
  });

  it('gives a transaction that started at EVConnected the remote start that follows', async () => {
    const h = harness({ ocpp: '2.0.1', deviceModel: { TxCtrlr: { TxStartPoint: 'EVConnected' } } });
    await h.boot();
    h.cp.plugIn(1);
    await h.advance(1000);
    expect(h.list()).toEqual([expect.objectContaining({ state: 'running', source: 'local' })]);
    await h.csmsCall('RequestStartTransaction', {
      remoteStartId: 9,
      evseId: 1,
      idToken: { idToken: 'APP-USER-2', type: 'Central' },
    });
    await h.advance(1000);
    expect(h.list()).toHaveLength(1);
    expect(h.list()[0]).toMatchObject({
      source: 'remote',
      remoteStartId: 9,
      idToken: { idToken: 'APP-USER-2', type: 'Central' },
    });
    expect(h.steps(h.list()[0])?.[0]).toBe('TransactionEvent Started CablePluggedIn');
  });

  it('records a card presented after an EVConnected start in the running session', async () => {
    const h = harness({ ocpp: '2.0.1', deviceModel: { TxCtrlr: { TxStartPoint: 'EVConnected' } } });
    await h.boot();
    h.cp.plugIn(1);
    await h.advance(1000);
    await h.present(1, 'AA000002');
    await h.advance(1000);
    expect(h.list()).toHaveLength(1);
    expect(h.list()[0]).toMatchObject({
      source: 'local',
      idToken: { idToken: 'AA000002', type: 'ISO14443' },
    });
    expect(h.steps(h.list()[0])).toContain('Authorize.conf Accepted');
  });

  it('keeps the charging needs an ISO 15118 EV reported', async () => {
    const h = harness({
      ocpp: '2.0.1',
      csms: { NotifyEVChargingNeeds: () => ({ status: 'Accepted' }) },
      deviceModel: { 'Connector@1.1': { ConnectorType: 'cCCS2' } },
    });
    await h.boot();
    await h.present(1, 'AA000010');
    h.cp.plugIn(1, {
      profile: {
        capacityKWh: 60,
        initialSoc: 30,
        maxPowerW: 50_000,
        phases: 3,
        communication: 'iso15118',
      },
    });
    await h.advance(2000);
    expect(h.list()[0]?.chargingNeeds).toMatchObject({
      requestedEnergyTransfer: 'DC',
      dcChargingParameters: { evEnergyCapacity: 60_000, fullSoC: 100, bulkSoC: 80 },
    });
  });

  it('marks a NoAuthorization token as noAuth', async () => {
    const h = harness({ ocpp: '2.0.1' });
    await h.boot();
    await h.present(1, '', 'NoAuthorization');
    h.cp.plugIn(1);
    await h.advance(2000);
    expect(h.list()[0]).toMatchObject({ source: 'noAuth', state: 'running' });
  });

  it('records rejected remote starts and remote starts without a cable', async () => {
    const h = harness({ ocpp: '2.0.1', deviceModel: { TxCtrlr: { EVConnectionTimeOut: 30 } } });
    await h.boot();
    await h.csmsCall('RequestStartTransaction', {
      remoteStartId: 1,
      evseId: 5,
      idToken: { idToken: 'APP-USER-3', type: 'Central' },
    });
    await h.csmsCall('RequestStartTransaction', {
      remoteStartId: 2,
      evseId: 1,
      idToken: { idToken: 'APP-USER-4', type: 'Central' },
    });
    await h.advance(31_000);
    expect(h.list().map((s) => `${s.remoteStartId}:${s.state}:${s.failure?.reason}`)).toEqual([
      '1:not-started:Rejected',
      '2:not-started:ConnectionTimeout',
    ]);
  });

  it('collects the CSMS costs from TransactionEventResponse and CostUpdated', async () => {
    let cost = 0;
    const h = harness({
      ocpp: '2.0.1',
      csms: { TransactionEvent: () => ({ totalCost: (cost += 0.5) }) },
    });
    await h.boot();
    await h.present(1, 'AA000003');
    h.cp.plugIn(1);
    await h.advance(2000);
    const session = h.list()[0];
    await h.csmsCall('CostUpdated', {
      totalCost: 9.75,
      transactionId: String(session?.transactionId),
    });
    expect(session?.costs.map((c) => `${c.from}:${c.totalCost}`)).toEqual([
      ...session!.costs
        .filter((c) => c.from === 'TransactionEventResponse')
        .map((c) => `TransactionEventResponse:${c.totalCost}`),
      'CostUpdated:9.75',
    ]);
    expect(session?.costs.at(-1)?.totalCost).toBe(9.75);
    expect(session?.costs.some((c) => c.from === 'TransactionEventResponse')).toBe(true);
  });
});

describe('session helpers', () => {
  it('reads 1.6 and 2.0.1 sampled values with units, multipliers and phases', () => {
    expect(
      meterSamples(
        [
          {
            timestamp: '2026-11-15T10:00:00Z',
            sampledValue: [
              { value: '12.5', unit: 'kWh', context: 'Transaction.Begin' },
              { value: '7.2', measurand: 'Power.Active.Import', unit: 'kW' },
              { value: '63', measurand: 'SoC', unit: 'Percent', location: 'EV' },
              { value: '16', measurand: 'Current.Import', phase: 'L2', unit: 'A' },
              { value: '231', measurand: 'Voltage', phase: 'L2-N', unit: 'V' },
              { value: '99', measurand: 'Current.Import', location: 'Inlet' },
            ],
          },
        ],
        4,
      ),
    ).toEqual([
      {
        at: '2026-11-15T10:00:00Z',
        seq: 4,
        context: 'Transaction.Begin',
        energyWh: 12_500,
        powerW: 7200,
        socPercent: 63,
        currentA: { L2: 16 },
        voltageV: { L2: 231 },
      },
    ]);
    expect(
      meterSamples(
        [
          {
            timestamp: '2026-11-15T10:01:00Z',
            sampledValue: [
              { value: 12.6, unitOfMeasure: { unit: 'Wh', multiplier: 3 } },
              { value: 11000, measurand: 'Power.Offered' },
            ],
          },
        ],
        5,
      ),
    ).toEqual([{ at: '2026-11-15T10:01:00Z', seq: 5, energyWh: 12_600, offeredW: 11000 }]);
    expect(meterSamples('nonsense', 1)).toEqual([]);
  });

  it('maps statuses and charging states, and sums the time in each', () => {
    expect(
      ['Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing', 'EVConnected', 'Faulted'].map(
        chargingStateLabel,
      ),
    ).toEqual(['charging', 'suspendedEV', 'suspendedEVSE', 'idle', 'idle', undefined]);
    const record = {
      startedAt: '2026-11-15T10:00:00Z',
      endedAt: '2026-11-15T11:00:00Z',
      states: [
        { at: '2026-11-15T10:00:00Z', state: 'charging' },
        { at: '2026-11-15T10:40:00Z', state: 'suspendedEV' },
        { at: '2026-11-15T10:50:00Z', state: 'idle' },
      ],
    } as SessionRecord;
    expect(stateDurations(record, '2026-11-15T12:00:00Z')).toEqual({
      charging: 40 * 60_000,
      suspendedEV: 10 * 60_000,
      suspendedEVSE: 0,
      idle: 10 * 60_000,
    });
    const { endedAt: _ended, ...running } = record;
    expect(stateDurations(running as SessionRecord, '2026-11-15T10:45:00Z').suspendedEV).toBe(
      5 * 60_000,
    );
  });

  it('thins samples and leaves out periodic meter frames past the limits', async () => {
    const tracker = createSessionTracker({
      stationId: 'CP-1',
      ocpp: '1.6',
      maxSamples: 4,
      maxFrames: 3,
    });
    let seq = 0;
    const call = (
      action: string,
      payload: JsonObject,
      direction: SessionFrame['direction'] = 'cp-to-csms',
    ) =>
      tracker.frame({
        seq: ++seq,
        at: '2026-11-15T10:00:00Z',
        direction,
        messageType: 2,
        uniqueId: `id-${seq}`,
        action,
        payload,
      });
    call('RemoteStartTransaction', { idTag: 'R', connectorId: 1 }, 'csms-to-cp');
    call('StartTransaction', {
      connectorId: 1,
      idTag: 'R',
      meterStart: 0,
      timestamp: '2026-11-15T10:00:00Z',
    });
    let kept = 0;
    for (let i = 1; i <= 6; i++) {
      const touched = call('MeterValues', {
        connectorId: 1,
        meterValue: [
          { timestamp: '2026-11-15T10:00:00Z', sampledValue: [{ value: String(i * 100) }] },
        ],
      });
      kept += touched[0]?.frames.length ?? 0;
    }
    const [session] = tracker.open();
    expect(kept).toBe(1);
    expect(session?.framesTruncated).toBe(true);
    expect(session?.samples.length).toBeLessThanOrEqual(4);
    expect(session?.samples[0]?.energyWh).toBe(100);
    // Frames that are not periodic are still kept.
    expect(
      call('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError' })[0]
        ?.frames,
    ).toHaveLength(1);
  });

  it('picks up sessions still open from before a restart', () => {
    const before = createSessionTracker({ stationId: 'CP-1', ocpp: '2.0.1' });
    before.frame({
      seq: 1,
      at: '2026-11-15T10:00:00Z',
      direction: 'cp-to-csms',
      messageType: 2,
      uniqueId: 'a',
      action: 'TransactionEvent',
      payload: {
        eventType: 'Started',
        timestamp: '2026-11-15T10:00:00Z',
        triggerReason: 'Authorized',
        seqNo: 0,
        transactionInfo: { transactionId: 'tx-1' },
        evse: { id: 1, connectorId: 1 },
        idToken: { idToken: 'AA000009', type: 'ISO14443' },
      },
    });
    const open = JSON.parse(JSON.stringify(before.open())) as SessionRecord[];
    const after = createSessionTracker({ stationId: 'CP-1', ocpp: '2.0.1', open, nextN: 1 });
    expect(after.nextN()).toBe(2);
    const touched = after.frame({
      seq: 2,
      at: '2026-11-15T10:05:00Z',
      direction: 'cp-to-csms',
      messageType: 2,
      uniqueId: 'b',
      action: 'TransactionEvent',
      payload: {
        eventType: 'Ended',
        timestamp: '2026-11-15T10:05:00Z',
        triggerReason: 'StopAuthorized',
        seqNo: 1,
        transactionInfo: { transactionId: 'tx-1', stoppedReason: 'Local' },
      },
    });
    expect(touched[0]?.session).toMatchObject({ n: 1, stopReason: 'Local' });
    after.frame({
      seq: 3,
      at: '2026-11-15T10:05:01Z',
      direction: 'csms-to-cp',
      messageType: 3,
      uniqueId: 'b',
      payload: {},
    });
    expect(after.open()).toEqual([]);
    expect(after.truth(1, { at: 'x', socPercent: 1, energyWh: 1, powerW: 1 })).toEqual([]);
  });
});

describe('2.1 payment sessions', () => {
  const terminal = (h: { cp: unknown }) => h.cp as ChargePoint201;

  it('records a card at the payment terminal as a payment, with its settlement and receipt', async () => {
    const h = harness({
      ocpp: '2.1',
      features: ['Core', 'Payment'],
      deviceModel: { PaymentCtrlr: { ReceiptByCSMS: true } },
      csms: {
        TransactionEvent: (p) => (p.eventType === 'Ended' ? { totalCost: 3.5 } : {}),
        NotifySettlement: () => ({ receiptUrl: 'https://csms.example.com/receipts/1' }),
      },
    });
    await h.boot();
    const result = terminal(h).presentPaymentCard(1, { brand: 'Mastercard' });
    await h.settle();
    expect(await result).toBe('authorized');
    h.cp.plugIn(1);
    await h.advance(2000);
    h.cp.unplug(1);
    await h.settle();
    const [session] = h.list();
    expect(session).toMatchObject({
      source: 'payment',
      state: 'finished',
      idToken: { type: 'DirectPayment' },
      settlement: {
        status: 'Settled',
        amount: 3.5,
        receiptUrl: 'https://csms.example.com/receipts/1',
      },
    });
    expect(session?.settlement?.pspRef).toBe(session?.idToken?.idToken);
  });

  it('records a payment canceled before the start, with its Canceled settlement', async () => {
    const h = harness({
      ocpp: '2.1',
      features: ['Core', 'Payment'],
      deviceModel: { PaymentCtrlr: { AuthorizeDirectPayment: true } },
      csms: { NotifySettlement: () => ({}) },
    });
    await h.boot();
    const result = terminal(h).presentPaymentCard(1);
    await h.settle();
    expect(await result).toBe('authorized');
    expect(terminal(h).stopPayment(1)).toBe('canceled');
    await h.settle();
    expect(h.list()).toEqual([
      expect.objectContaining({
        source: 'payment',
        state: 'not-started',
        failure: { reason: 'StartFailed', detail: 'canceled at the payment terminal' },
        settlement: expect.objectContaining({ status: 'Canceled', amount: 0 }),
      }),
    ]);
  });

  it('records a remote start with a DirectPayment token as a payment (web payment)', async () => {
    const h = harness({ ocpp: '2.1', features: ['Core', 'WebPayments'] });
    await h.boot();
    await h.csmsCall('RequestStartTransaction', {
      remoteStartId: 7,
      evseId: 1,
      idToken: { idToken: '4444', type: 'DirectPayment' },
    });
    h.cp.plugIn(1);
    await h.advance(2000);
    expect(h.list()).toEqual([
      expect.objectContaining({ source: 'payment', remoteStartId: 7, state: 'running' }),
    ]);
  });
});

describe('2.1 vehicle readings', () => {
  it('reads the Display and EnergyRequest measurands, and Display.PresentSOC as the SoC', () => {
    const [sample] = meterSamples(
      [
        {
          timestamp: '2026-11-16T08:00:00Z',
          sampledValue: [
            { value: 1200, measurand: 'Energy.Active.Import.Register' },
            {
              value: 42,
              measurand: 'Display.PresentSOC',
              location: 'EV',
              unitOfMeasure: { unit: 'Percent' },
            },
            {
              value: 77,
              measurand: 'Display.BatteryEnergyCapacity',
              location: 'EV',
              unitOfMeasure: { unit: 'kWh' },
            },
            {
              value: 600,
              measurand: 'Display.RemainingTimeToTargetSOC',
              location: 'EV',
              unitOfMeasure: { unit: 's' },
            },
            {
              value: 21_000,
              measurand: 'EnergyRequest.Target',
              location: 'EV',
              unitOfMeasure: { unit: 'Wh' },
            },
          ],
        },
      ],
      7,
    );
    expect(sample).toEqual({
      at: '2026-11-16T08:00:00Z',
      seq: 7,
      energyWh: 1200,
      socPercent: 42,
      vehicle: {
        'Display.PresentSOC': 42,
        'Display.BatteryEnergyCapacity': 77_000,
        'Display.RemainingTimeToTargetSOC': 600,
        'EnergyRequest.Target': 21_000,
      },
    });
  });
});

describe('2.1 station cost and limits', () => {
  it("keeps the station's own cost and the transaction's limits as it reported them", async () => {
    const h = harness({
      ocpp: '2.1',
      features: ['Core', 'TariffAndCost', 'Payment'],
      csms: { NotifySettlement: () => ({}), SetDefaultTariff: () => ({ status: 'Accepted' }) },
    });
    await h.boot();
    await h.csmsCall('SetDefaultTariff', {
      evseId: 0,
      tariff: { tariffId: 'T', currency: 'NZD', fixedFee: { prices: [{ priceFixed: 2 }] } },
    });
    const result = (h.cp as ChargePoint201).presentPaymentCard(1);
    await h.settle();
    expect(await result).toBe('authorized');
    h.cp.plugIn(1);
    await h.advance(2000);
    expect(h.list()[0]).toMatchObject({
      limits: { maxCost: 50 },
      stationCost: { totalCost: 2, currency: 'NZD', typeOfCost: 'NormalCost', final: false },
    });
    h.cp.unplug(1);
    await h.settle();
    expect(h.list()[0]?.stationCost).toMatchObject({ totalCost: 2, final: true });
  });
});
