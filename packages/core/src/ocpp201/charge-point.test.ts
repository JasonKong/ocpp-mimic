import { describe, expect, it } from 'vitest';
import { ManualClock } from '../clock.js';
import { sequentialIds } from '../ids.js';
import { OCPP201_MESSAGE_SET } from '../message-set.js';
import { parseFrame, type CallFrame, type Frame, type JsonObject } from '../ocppj.js';
import { resolvePersonas } from '../persona.js';
import {
  createChargePoint201,
  type ChargePoint201Options,
  type PersistedChargePoint201,
} from './charge-point.js';

const T0 = Date.parse('2026-11-15T10:00:00Z');
const BOOT = { model: 'AC-7', vendorName: 'VendorX', firmwareVersion: '1.0.0' };

type Responder = (payload: JsonObject) => JsonObject | undefined;

function setup(
  options: {
    csms?: Record<string, Responder>;
    restore?: PersistedChargePoint201;
    deviceModel?: ChargePoint201Options['deviceModel'];
    features?: string[];
  } = {},
) {
  const clock = new ManualClock(T0);
  const frames: Frame[] = [];
  const iso = () => new Date(clock.now()).toISOString();
  const responders: Record<string, Responder> = {
    BootNotification: () => ({ status: 'Accepted', currentTime: iso(), interval: 60 }),
    Heartbeat: () => ({ currentTime: iso() }),
    StatusNotification: () => ({}),
    NotifyReport: () => ({}),
    Authorize: () => ({ idTokenInfo: { status: 'Accepted' } }),
    TransactionEvent: () => ({}),
    NotifyEvent: () => ({}),
    NotifyCustomerInformation: () => ({}),
    MeterValues: () => ({}),
    ...options.csms,
  };
  const restarts: number[] = [];
  const cp = createChargePoint201({
    clock,
    ids: sequentialIds('cp-'),
    boot: BOOT,
    connectors: 2,
    timing: { actionDelayMs: 0 },
    restart: (downtimeMs) => restarts.push(downtimeMs),
    send: (text) => {
      const parsed = parseFrame(text);
      if (parsed.ok) frames.push(parsed.frame);
    },
    ...(options.restore !== undefined && { restore: options.restore }),
    ...(options.deviceModel !== undefined && { deviceModel: options.deviceModel }),
    features: options.features ?? ['Core', 'LocalAuthListManagement'],
  });
  let answered = 0;
  let csmsIds = 0;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  async function settle(): Promise<void> {
    for (let round = 0; round < 100; round++) {
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
    throw new Error('the station never settled');
  }
  const calls = (action?: string) =>
    frames.filter(
      (f): f is CallFrame => f.type === 2 && (action === undefined || f.action === action),
    );
  /** `evseId/connectorId:status` of every StatusNotification sent after frame `from`. */
  const statuses = (from = 0) =>
    frames
      .slice(from)
      .filter((f): f is CallFrame => f.type === 2 && f.action === 'StatusNotification')
      .map(
        (f) =>
          `${String(f.payload.evseId)}/${String(f.payload.connectorId)}:${String(f.payload.connectorStatus)}`,
      );
  async function csmsCall(action: string, payload: JsonObject) {
    const id = `csms-${++csmsIds}`;
    cp.receive(JSON.stringify([2, id, action, payload]));
    await settle();
    // Commands are carried out after the persona's action delay (0 here).
    await advance(0);
    const answer = frames.find((f) => f.type !== 2 && f.id === id);
    return answer?.type === 3 ? answer.payload : answer;
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
  async function boot() {
    cp.connected();
    await settle();
  }
  /** The TransactionEvents sent, as `eventType triggerReason [stoppedReason]`. */
  const events = () =>
    calls('TransactionEvent').map((c) => {
      const p = c.payload as {
        eventType: string;
        triggerReason: string;
        transactionInfo: { stoppedReason?: string };
      };
      return [p.eventType, p.triggerReason, p.transactionInfo.stoppedReason]
        .filter(Boolean)
        .join(' ');
    });
  /** Presents a card while the fake CSMS answers the Authorize. */
  async function present(connectorId: number, token: string, type?: string) {
    const result = cp.presentIdTag(connectorId, token, type);
    await settle();
    return result;
  }
  /** Every CALL so far must be a valid 2.0.1 request. */
  const allValid = () =>
    calls().every((c) => OCPP201_MESSAGE_SET.validateRequest(c.action, c.payload).ok);
  return {
    restarts,
    clock,
    cp,
    frames,
    calls,
    statuses,
    csmsCall,
    advance,
    boot,
    settle,
    events,
    allValid,
    present,
  };
}

describe('a 2.0.1 station: boot and registration', () => {
  it('boots with a reason and the chargingStation block, then reports every connector', async () => {
    const { cp, calls, statuses, boot } = setup();
    expect(cp.ocpp).toBe('2.0.1');
    await boot();
    expect(calls('BootNotification')[0]?.payload).toEqual({
      reason: 'PowerUp',
      chargingStation: BOOT,
    });
    expect(statuses()).toEqual(['1/1:Available', '2/1:Available']);
    expect(cp.snapshot()).toMatchObject({ ocpp: '2.0.1', registration: 'Accepted' });
    // Every frame is a valid 2.0.1 request.
    for (const call of calls()) {
      expect(OCPP201_MESSAGE_SET.validateRequest(call.action, call.payload).ok).toBe(true);
    }
  });

  it('sends heartbeats on the interval the CSMS gave', async () => {
    const { calls, advance, boot } = setup();
    await boot();
    await advance(59_000);
    expect(calls('Heartbeat')).toHaveLength(0);
    await advance(1_000);
    expect(calls('Heartbeat')).toHaveLength(1);
    await advance(60_000);
    expect(calls('Heartbeat')).toHaveLength(2);
  });

  it('retries a Pending or Rejected boot after the interval and reports nothing meanwhile', async () => {
    let answers = ['Pending', 'Rejected', 'Accepted'];
    const { cp, calls, statuses, advance, boot } = setup({
      csms: {
        BootNotification: () => {
          const status = answers[0] ?? 'Accepted';
          answers = answers.slice(1);
          return { status, currentTime: new Date(T0).toISOString(), interval: 30 };
        },
      },
    });
    await boot();
    expect(cp.snapshot().registration).toBe('Pending');
    cp.plugIn(1);
    expect(statuses()).toEqual([]);
    await advance(30_000);
    expect(cp.snapshot().registration).toBe('Rejected');
    await advance(30_000);
    expect(cp.snapshot().registration).toBe('Accepted');
    expect(calls('BootNotification')).toHaveLength(3);
    expect(statuses()).toEqual(['1/1:Occupied', '2/1:Available']);
  });
});

describe('a 2.0.1 station: status and availability', () => {
  it('reports Occupied, Faulted and Available from the device facts', async () => {
    const { cp, frames, statuses, boot, settle } = setup();
    await boot();
    const from = frames.length;
    cp.plugIn(1);
    cp.raiseFault(2, { errorCode: 'GroundFailure' });
    cp.unplug(1);
    cp.clearFault(2);
    cp.raiseFault(0, { errorCode: 'OtherError' });
    // One CALL at a time: the reports go out as the CSMS answers them.
    await settle();
    expect(statuses(from)).toEqual([
      '1/1:Occupied',
      '2/1:Faulted',
      '1/1:Available',
      '2/1:Available',
      '1/1:Faulted',
      '2/1:Faulted',
    ]);
    expect(cp.snapshot().station.status).toBe('Faulted');
  });

  it('changes availability of the station, an EVSE or a connector', async () => {
    const { cp, frames, statuses, csmsCall, boot } = setup();
    await boot();
    let from = frames.length;
    expect(
      await csmsCall('ChangeAvailability', {
        operationalStatus: 'Inoperative',
        evse: { id: 2 },
      }),
    ).toEqual({ status: 'Accepted' });
    expect(statuses(from)).toEqual(['2/1:Unavailable']);
    from = frames.length;
    expect(
      await csmsCall('ChangeAvailability', {
        operationalStatus: 'Inoperative',
        evse: { id: 1, connectorId: 1 },
      }),
    ).toEqual({ status: 'Accepted' });
    expect(statuses(from)).toEqual(['1/1:Unavailable']);
    from = frames.length;
    expect(await csmsCall('ChangeAvailability', { operationalStatus: 'Operative' })).toEqual({
      status: 'Accepted',
    });
    expect(statuses(from)).toEqual(['1/1:Available', '2/1:Available']);
    expect(
      await csmsCall('ChangeAvailability', { operationalStatus: 'Operative', evse: { id: 3 } }),
    ).toEqual({ status: 'Rejected' });
    expect(
      await csmsCall('ChangeAvailability', {
        operationalStatus: 'Operative',
        evse: { id: 1, connectorId: 2 },
      }),
    ).toEqual({ status: 'Rejected' });
    expect(cp.snapshot().connectors.map((c) => c.evseId)).toEqual([1, 2]);
  });

  it('keeps availability set by the CSMS across a restart', async () => {
    const first = setup();
    await first.boot();
    await first.csmsCall('ChangeAvailability', {
      operationalStatus: 'Inoperative',
      evse: { id: 2 },
    });
    const saved = first.cp.persistentState();
    expect(saved).toMatchObject({
      ocpp: '2.0.1',
      availability: { station: 'Operative', connectors: { '1': 'Operative', '2': 'Inoperative' } },
    });
    const second = setup({ restore: saved });
    await second.boot();
    expect(second.statuses()).toEqual(['1/1:Available', '2/1:Unavailable']);
  });
});

describe('a 2.0.1 station: the RPC framework', () => {
  it('answers CALLs outside its scope with NotSupported, and 1.6 actions with NotImplemented', async () => {
    const { frames, boot, settle, cp } = setup();
    await boot();
    cp.receive(
      '[2,"x1","SetDisplayMessage",{"message":{"id":1,"priority":"NormalCycle","message":{"format":"UTF8","content":"hi"}}}]',
    );
    cp.receive('[2,"x2","RemoteStartTransaction",{"idTag":"A"}]');
    await settle();
    const errors = frames.filter((f) => f.type === 4).map((f) => (f.type === 4 ? f.errorCode : ''));
    expect(errors).toEqual(['NotSupported', 'NotImplemented']);
  });
});

describe('2.0.1 personas', () => {
  it('resolve with the 2.0.1 boot block and certification profiles', () => {
    const { personas, errors } = resolvePersonas([
      {
        source: 'p.yaml',
        data: {
          persona: 'p201',
          ocpp: '2.0.1',
          boot: { vendorName: 'V', model: 'M' },
          connectors: 2,
          features: ['Core', 'SmartCharging'],
          timing: { commandDelays: { RequestStartTransaction: '1s' } },
        },
      },
      {
        source: 'bad.yaml',
        data: {
          persona: 'bad',
          ocpp: '2.0.1',
          boot: { chargePointVendor: 'V', chargePointModel: 'M' },
          connectors: 1,
        },
      },
    ]);
    const persona = personas.get('p201');
    expect(persona?.ocpp).toBe('2.0.1');
    expect(persona?.options).toMatchObject({
      boot: { vendorName: 'V', model: 'M' },
      connectors: 2,
      features: ['Core', 'SmartCharging'],
      timing: { actionDelaysMs: { RequestStartTransaction: 1000 } },
    });
    expect(persona?.warnings).toEqual([
      'p.yaml: certification profile SmartCharging is supported in the persona but not implemented yet',
    ]);
    expect(errors.some((e) => e.startsWith('bad.yaml: $.boot.vendorName'))).toBe(true);
  });
});

describe('a 2.0.1 station: Device Model', () => {
  const heartbeat = {
    component: { name: 'OCPPCommCtrlr' },
    variable: { name: 'HeartbeatInterval' },
  };

  it('takes the boot interval as HeartbeatInterval and follows SetVariables', async () => {
    const { calls, csmsCall, advance, boot, cp } = setup();
    await boot();
    expect(await csmsCall('GetVariables', { getVariableData: [heartbeat] })).toMatchObject({
      getVariableResult: [{ attributeStatus: 'Accepted', attributeValue: '60' }],
    });
    expect(
      await csmsCall('SetVariables', { setVariableData: [{ ...heartbeat, attributeValue: '10' }] }),
    ).toMatchObject({
      setVariableResult: [{ attributeStatus: 'Accepted', attributeType: 'Actual' }],
    });
    const before = calls('Heartbeat').length;
    await advance(30_000);
    expect(calls('Heartbeat').length - before).toBe(3);
    expect(cp.snapshot().config['OCPPCommCtrlr/HeartbeatInterval']).toBe('10');
    // Write-only values stay out of snapshots.
    expect(cp.snapshot().config['SecurityCtrlr/BasicAuthPassword']).toBeUndefined();
  });

  it('sends a base report in NotifyReport pages of ItemsPerMessageGetReport entries', async () => {
    const { calls, csmsCall, advance, boot } = setup();
    await boot();
    expect(await csmsCall('GetBaseReport', { requestId: 7, reportBase: 'FullInventory' })).toEqual({
      status: 'Accepted',
    });
    await advance(0);
    const pages = calls('NotifyReport').map((c) => c.payload);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((p) => p.seqNo)).toEqual(pages.map((_, i) => i));
    expect(pages.map((p) => p.tbc === true)).toEqual(pages.map((_, i) => i < pages.length - 1));
    expect(pages.every((p) => p.requestId === 7)).toBe(true);
    const entries = pages.flatMap((p) => p.reportData as unknown[]);
    expect(entries.length).toBeGreaterThan(60);
    expect(pages.every((p) => (p.reportData as unknown[]).length <= 20)).toBe(true);
    for (const call of calls('NotifyReport')) {
      expect(OCPP201_MESSAGE_SET.validateRequest(call.action, call.payload).ok).toBe(true);
    }
  });

  it('answers a report while the boot is Pending, as a CSMS may ask for one first', async () => {
    const { calls, csmsCall, advance, boot, cp } = setup({
      csms: {
        BootNotification: () => ({
          status: 'Pending',
          currentTime: new Date(T0).toISOString(),
          interval: 300,
        }),
      },
    });
    await boot();
    expect(cp.snapshot().registration).toBe('Pending');
    await csmsCall('GetBaseReport', { requestId: 1, reportBase: 'SummaryInventory' });
    await advance(0);
    expect(calls('NotifyReport')).toHaveLength(1);
  });

  it('enforces ItemsPerMessage, answers EmptyResultSet, and keeps values across a restart', async () => {
    const first = setup({ deviceModel: { OCPPCommCtrlr: { WebSocketPingInterval: 45 } } });
    await first.boot();
    const tooMany = Array.from({ length: 21 }, () => heartbeat);
    await first.csmsCall('GetVariables', { getVariableData: tooMany });
    const error = first.frames.find((f) => f.type === 4);
    expect(error?.type === 4 && error.errorCode).toBe('OccurrenceConstraintViolation');
    expect(
      await first.csmsCall('GetReport', { requestId: 2, componentCriteria: ['Problem'] }),
    ).toEqual({
      status: 'EmptyResultSet',
    });
    await first.csmsCall('SetVariables', {
      setVariableData: [
        {
          component: { name: 'TxCtrlr' },
          variable: { name: 'TxStartPoint' },
          attributeValue: 'EVConnected,Authorized',
        },
      ],
    });
    const saved = first.cp.persistentState();
    const second = setup({ restore: saved });
    expect(second.cp.snapshot().config).toMatchObject({
      'TxCtrlr/TxStartPoint': 'EVConnected,Authorized',
      // Saved values win over the persona's on a restart, as 1.6 configuration does.
      'OCPPCommCtrlr/WebSocketPingInterval': '45',
    });
    expect(() => setup({ deviceModel: { OCPPCommCtrlr: { HeartbeatInterval: 'soon' } } })).toThrow(
      'deviceModel: OCPPCommCtrlr.HeartbeatInterval: not an integer',
    );
  });
});

describe('a 2.0.1 station: transactions', () => {
  const tx = (calls: ReturnType<typeof setup>['calls'], index: number) =>
    calls('TransactionEvent')[index]?.payload as {
      seqNo: number;
      transactionInfo: { transactionId: string; chargingState?: string };
      idToken?: unknown;
      evse?: unknown;
      offline?: boolean;
      meterValue?: { sampledValue: { context?: string; measurand?: string }[] }[];
    };

  it('starts at PowerPathClosed and ends when the same card stops it', async () => {
    const { cp, present, calls, boot, settle, events, allValid } = setup();
    await boot();
    expect(await present(1, 'TAG-1')).toBe('authorized');
    expect(calls('Authorize')[0]?.payload).toEqual({
      idToken: { idToken: 'TAG-1', type: 'ISO14443' },
    });
    cp.plugIn(1);
    await settle();
    expect(events()).toEqual(['Started CablePluggedIn']);
    const started = tx(calls, 0);
    expect(started).toMatchObject({
      seqNo: 0,
      idToken: { idToken: 'TAG-1', type: 'ISO14443' },
      evse: { id: 1, connectorId: 1 },
      transactionInfo: { chargingState: 'Charging' },
    });
    expect(started.meterValue?.[0]?.sampledValue[0]).toMatchObject({
      context: 'Transaction.Begin',
      measurand: 'Energy.Active.Import.Register',
    });
    expect(cp.snapshot().connectors[0]).toMatchObject({
      status: 'Occupied',
      chargingState: 'Charging',
      transactionId: started.transactionInfo.transactionId,
      idTag: 'TAG-1',
    });
    expect(await present(1, 'OTHER')).toBe('busy');
    expect(await present(1, 'TAG-1')).toBe('stopping');
    await settle();
    expect(events()).toEqual(['Started CablePluggedIn', 'Ended StopAuthorized Local']);
    expect(tx(calls, 1)).toMatchObject({
      seqNo: 1,
      transactionInfo: { transactionId: started.transactionInfo.transactionId },
    });
    expect(tx(calls, 1).meterValue?.at(-1)?.sampledValue[0]?.context).toBe('Transaction.End');
    expect(cp.snapshot().connectors[0]?.transactionId).toBeUndefined();
    expect(allValid()).toBe(true);
  });

  it('follows other start and stop points: EVConnected for both', async () => {
    const { cp, present, boot, settle, events, calls } = setup({
      deviceModel: { TxCtrlr: { TxStartPoint: 'EVConnected', TxStopPoint: 'EVConnected' } },
    });
    await boot();
    cp.plugIn(1);
    await settle();
    expect(tx(calls, 0).transactionInfo.chargingState).toBe('EVConnected');
    await present(1, 'TAG-1');
    await settle();
    await present(1, 'TAG-1');
    await settle();
    cp.unplug(1);
    await settle();
    // The card stop does not end it; the unplug does, with the card's reason (E07).
    expect(events()).toEqual([
      'Started CablePluggedIn',
      'Updated Authorized',
      'Updated StopAuthorized',
      'Ended EVCommunicationLost Local',
    ]);
    expect(tx(calls, 1).idToken).toEqual({ idToken: 'TAG-1', type: 'ISO14443' });
  });

  it('ends on unplugging with EVDisconnected, and refuses unknown cards', async () => {
    const { cp, present, boot, settle, events } = setup({
      csms: {
        Authorize: (payload) => ({
          idTokenInfo: {
            status:
              (payload.idToken as { idToken: string }).idToken === 'BAD' ? 'Invalid' : 'Accepted',
          },
        }),
      },
    });
    await boot();
    expect(await present(1, 'BAD')).toBe('rejected');
    cp.plugIn(1);
    await present(1, 'TAG-1', 'KeyCode');
    await settle();
    cp.unplug(1);
    await settle();
    expect(events()).toEqual(['Started Authorized', 'Ended EVCommunicationLost EVDisconnected']);
  });

  it('sends periodic samples and collects TxEnded samples for the Ended event', async () => {
    const { cp, present, boot, settle, advance, events, calls } = setup({
      deviceModel: { SampledDataCtrlr: { TxUpdatedInterval: 60, TxEndedInterval: 30 } },
    });
    await boot();
    await present(1, 'TAG-1');
    cp.plugIn(1);
    await settle();
    await advance(120_000);
    await present(1, 'TAG-1');
    await settle();
    expect(events()).toEqual([
      'Started CablePluggedIn',
      'Updated MeterValuePeriodic',
      'Updated MeterValuePeriodic',
      'Ended StopAuthorized Local',
    ]);
    expect(tx(calls, 1).meterValue?.[0]?.sampledValue.map((v) => v.measurand)).toEqual([
      'Energy.Active.Import.Register',
      'Power.Active.Import',
    ]);
    // Four TxEnded samples every 30 s, then the final reading.
    const ended = tx(calls, 3).meterValue ?? [];
    expect(ended.map((m) => m.sampledValue[0]?.context)).toEqual([
      'Sample.Periodic',
      'Sample.Periodic',
      'Sample.Periodic',
      'Sample.Periodic',
      'Transaction.End',
    ]);
  });

  it('queues events while offline, marked offline, and delivers them in order', async () => {
    const { cp, present, boot, settle, events, calls } = setup({
      deviceModel: { AuthCtrlr: { OfflineTxForUnknownIdEnabled: true } },
    });
    await boot();
    cp.disconnected();
    expect(await present(1, 'TAG-1')).toBe('authorized');
    cp.plugIn(1);
    await present(1, 'TAG-1');
    expect(cp.snapshot().queuedMessages).toBe(2);
    expect(events()).toEqual([]);
    await boot();
    await settle();
    expect(events()).toEqual(['Started CablePluggedIn', 'Ended StopAuthorized Local']);
    expect([tx(calls, 0).offline, tx(calls, 1).offline]).toEqual([true, true]);
    expect([tx(calls, 0).seqNo, tx(calls, 1).seqNo]).toEqual([0, 1]);
  });

  it('retries a failed event MessageAttempts times, MessageAttemptInterval apart', async () => {
    let failures = 2;
    const { cp, present, boot, settle, advance, calls } = setup({
      csms: {
        TransactionEvent: () => (failures-- > 0 ? { __callError: 'InternalError' } : {}),
      },
      deviceModel: {
        OCPPCommCtrlr: {
          'MessageAttempts:TransactionEvent': 3,
          'MessageAttemptInterval:TransactionEvent': 10,
        },
      },
    });
    await boot();
    await present(1, 'TAG-1');
    cp.plugIn(1);
    await settle();
    expect(calls('TransactionEvent')).toHaveLength(1);
    await advance(10_000);
    expect(calls('TransactionEvent')).toHaveLength(2);
    await advance(20_000);
    expect(calls('TransactionEvent')).toHaveLength(3);
    expect(cp.snapshot().queuedMessages).toBe(0);
  });

  it('stops when the CSMS invalidates the token, or caps the energy with MaxEnergyOnInvalidId', async () => {
    const invalid = { TransactionEvent: () => ({ idTokenInfo: { status: 'Blocked' } }) };
    const stop = setup({ csms: invalid });
    await stop.boot();
    await stop.present(1, 'TAG-1');
    stop.cp.plugIn(1);
    await stop.settle();
    expect(stop.events()).toEqual(['Started CablePluggedIn', 'Ended Deauthorized DeAuthorized']);

    const cap = setup({
      csms: invalid,
      deviceModel: { TxCtrlr: { StopTxOnInvalidId: false, MaxEnergyOnInvalidId: 0 } },
    });
    await cap.boot();
    await cap.present(1, 'TAG-1');
    cap.cp.plugIn(1);
    await cap.settle();
    expect(cap.events()).toEqual(['Started CablePluggedIn', 'Updated EnergyLimitReached']);
    expect(cap.cp.snapshot().connectors[0]).toMatchObject({
      powerW: 0,
      chargingState: 'SuspendedEVSE',
    });
  });

  it('forgets an authorization without a cable after EVConnectionTimeOut', async () => {
    const plain = setup({ deviceModel: { TxCtrlr: { EVConnectionTimeOut: 30 } } });
    await plain.boot();
    await plain.present(1, 'TAG-1');
    await plain.advance(30_000);
    expect(plain.cp.snapshot().connectors[0]?.idTag).toBeUndefined();
    plain.cp.plugIn(1);
    await plain.settle();
    expect(plain.events()).toEqual([]);

    const atAuthorized = setup({
      deviceModel: { TxCtrlr: { EVConnectionTimeOut: 30, TxStartPoint: 'Authorized' } },
    });
    await atAuthorized.boot();
    await atAuthorized.present(1, 'TAG-1');
    await atAuthorized.advance(30_000);
    expect(atAuthorized.events()).toEqual(['Started Authorized', 'Ended EVConnectTimeout Timeout']);
  });

  it('answers GetTransactionStatus', async () => {
    const { cp, present, boot, settle, csmsCall, calls } = setup();
    await boot();
    await present(1, 'TAG-1');
    cp.plugIn(1);
    await settle();
    const id = tx(calls, 0).transactionInfo.transactionId;
    expect(await csmsCall('GetTransactionStatus', { transactionId: id })).toEqual({
      messagesInQueue: false,
      ongoingIndicator: true,
    });
    expect(await csmsCall('GetTransactionStatus', { transactionId: 'unknown' })).toEqual({
      messagesInQueue: false,
      ongoingIndicator: false,
    });
    expect(await csmsCall('GetTransactionStatus', {})).toEqual({ messagesInQueue: false });
  });

  it('ends a transaction a power cut interrupted with PowerLoss after the restart', async () => {
    const first = setup();
    await first.boot();
    await first.present(1, 'TAG-1');
    first.cp.plugIn(1);
    await first.settle();
    const id = tx(first.calls, 0).transactionInfo.transactionId;
    const saved = first.cp.persistentState();
    expect(saved.transactions).toMatchObject([{ connectorId: 1, transactionId: id, seqNo: 1 }]);
    const second = setup({ restore: saved });
    await second.boot();
    expect(second.events()).toEqual(['Ended AbnormalCondition PowerLoss']);
    expect(tx(second.calls, 0)).toMatchObject({
      seqNo: 1,
      offline: true,
      transactionInfo: { transactionId: id },
    });
    expect(second.allValid()).toBe(true);
  });
});

describe('a 2.0.1 station: faults', () => {
  it('reports a fault and its end with NotifyEvent for the Problem variable', async () => {
    const { cp, calls, boot, settle, csmsCall, allValid } = setup();
    await boot();
    cp.raiseFault(2, { errorCode: 'GroundFailure', info: 'GND_FAULT', vendorErrorCode: 'E101' });
    cp.raiseFault(0, { errorCode: 'OtherError' });
    await settle();
    const events = () => calls('NotifyEvent').map((c) => (c.payload.eventData as unknown[])[0]);
    expect(events()).toMatchObject([
      {
        eventId: 1,
        trigger: 'Alerting',
        actualValue: 'true',
        techCode: 'E101',
        techInfo: 'GND_FAULT',
        eventNotificationType: 'HardWiredNotification',
        component: { name: 'Connector', evse: { id: 2, connectorId: 1 } },
        variable: { name: 'Problem' },
      },
      {
        eventId: 2,
        actualValue: 'true',
        techCode: 'OtherError',
        component: { name: 'ChargingStation' },
      },
    ]);
    expect(
      await csmsCall('GetVariables', {
        getVariableData: [
          {
            component: { name: 'Connector', evse: { id: 2, connectorId: 1 } },
            variable: { name: 'Problem' },
          },
          { component: { name: 'EVSE', evse: { id: 1 } }, variable: { name: 'Problem' } },
        ],
      }),
    ).toMatchObject({
      getVariableResult: [{ attributeValue: 'true' }, { attributeValue: 'false' }],
    });
    // A report of the components with a problem.
    expect(await csmsCall('GetReport', { requestId: 9, componentCriteria: ['Problem'] })).toEqual({
      status: 'Accepted',
    });
    cp.clearFault(2);
    cp.clearFault(1); // no fault there: nothing to clear
    await settle();
    expect(events().at(-1)).toMatchObject({
      eventId: 3,
      actualValue: 'false',
      cleared: true,
      component: { name: 'Connector', evse: { id: 2 } },
    });
    expect(events()).toHaveLength(3);
    expect(allValid()).toBe(true);
  });

  it('ends a running transaction with AbnormalCondition when its connector faults', async () => {
    const { cp, boot, settle, present, events } = setup();
    await boot();
    await present(1, 'TAG-1');
    cp.plugIn(1);
    await settle();
    cp.raiseFault(1, { errorCode: 'OverCurrentFailure' });
    await settle();
    expect(events()).toEqual(['Started CablePluggedIn', 'Ended AbnormalCondition Other']);
  });
});

describe('a 2.0.1 station: authorization', () => {
  const tag = (idToken: string) => ({ idToken, type: 'ISO14443' });

  it('authorizes from the Local Authorization List without the CSMS, also offline', async () => {
    const { cp, calls, csmsCall, present, boot } = setup();
    await boot();
    expect(await csmsCall('GetLocalListVersion', {})).toEqual({ versionNumber: 0 });
    expect(
      await csmsCall('SendLocalList', {
        versionNumber: 2,
        updateType: 'Full',
        localAuthorizationList: [{ idToken: tag('LISTED'), idTokenInfo: { status: 'Accepted' } }],
      }),
    ).toEqual({ status: 'Accepted' });
    expect(await csmsCall('GetLocalListVersion', {})).toEqual({ versionNumber: 2 });
    expect(await present(1, 'LISTED')).toBe('authorized');
    expect(calls('Authorize')).toHaveLength(0);
    cp.disconnected();
    expect(await present(2, 'LISTED')).toBe('authorized');
    expect(await present(2, 'UNKNOWN')).toBe('busy');
    expect(cp.snapshot().localList).toEqual({ version: 2, size: 1 });
    const restarted = setup({ restore: cp.persistentState() });
    await restarted.boot();
    expect(await restarted.csmsCall('GetLocalListVersion', {})).toEqual({ versionNumber: 2 });
  });

  it('pre-authorizes from the cache with LocalPreAuthorize, and clears it on ClearCache', async () => {
    const { calls, csmsCall, present, boot, cp, settle } = setup({
      deviceModel: { AuthCtrlr: { LocalPreAuthorize: true } },
    });
    await boot();
    expect(await present(1, 'TAG-1')).toBe('authorized');
    expect(calls('Authorize')).toHaveLength(1);
    expect(await present(1, 'TAG-1')).toBe('stopping');
    await settle();
    expect(await present(1, 'TAG-1')).toBe('authorized');
    expect(calls('Authorize')).toHaveLength(1);
    expect(await csmsCall('ClearCache', {})).toEqual({ status: 'Accepted' });
    cp.unplug(1);
    await present(1, 'TAG-1');
    await present(2, 'TAG-1');
    expect(calls('Authorize')).toHaveLength(2);
    const disabled = setup({ deviceModel: { AuthCacheCtrlr: { Enabled: false } } });
    await disabled.boot();
    expect(await disabled.csmsCall('ClearCache', {})).toEqual({ status: 'Rejected' });
  });

  it('lets a token of the same group stop the session, and a Master Pass stop every one', async () => {
    const groups: Record<string, string> = { A: 'G1', B: 'G1', C: 'G2', MASTER: 'MP' };
    const { cp, present, boot, settle, events } = setup({
      csms: {
        Authorize: (payload) => {
          const id = (payload.idToken as { idToken: string }).idToken;
          return {
            idTokenInfo: {
              status: 'Accepted',
              ...(groups[id] !== undefined && { groupIdToken: tag(groups[id]!) }),
            },
          };
        },
      },
      deviceModel: { AuthCtrlr: { MasterPassGroupId: 'MP' } },
    });
    await boot();
    expect(await present(1, 'MASTER')).toBe('rejected');
    await present(1, 'A');
    cp.plugIn(1);
    await settle();
    expect(await present(1, 'C')).toBe('busy');
    expect(await present(1, 'B')).toBe('stopping');
    await settle();
    await present(1, 'A');
    await present(2, 'C');
    cp.plugIn(2);
    await settle();
    expect(await present(2, 'MASTER')).toBe('stopping');
    await settle();
    expect(events()).toEqual([
      'Started CablePluggedIn',
      'Ended StopAuthorized Local',
      'Started Authorized',
      'Started CablePluggedIn',
      'Ended StopAuthorized MasterPass',
      'Ended StopAuthorized MasterPass',
    ]);
  });

  it('answers the local list NotSupported without the profile', async () => {
    const { csmsCall, boot, frames } = setup({ features: ['Core'] });
    await boot();
    await csmsCall('GetLocalListVersion', {});
    const error = frames.find((f) => f.type === 4);
    expect(error?.type === 4 && error.errorCode).toBe('NotSupported');
  });
});

describe('a 2.0.1 station: remote control and operations', () => {
  const tag = (idToken: string) => ({ idToken, type: 'ISO14443' });
  const txPayload = (calls: ReturnType<typeof setup>['calls'], index: number) =>
    calls('TransactionEvent')[index]?.payload as {
      triggerReason: string;
      idToken?: unknown;
      transactionInfo: { transactionId: string; remoteStartId?: number };
    };

  it('starts remotely (authorizing first) and stops remotely', async () => {
    const { cp, calls, csmsCall, boot, settle, events } = setup();
    await boot();
    expect(
      await csmsCall('RequestStartTransaction', {
        idToken: tag('REMOTE-1'),
        remoteStartId: 7,
        evseId: 1,
      }),
    ).toEqual({ status: 'Accepted' });
    await settle();
    expect(calls('Authorize')).toHaveLength(1);
    cp.plugIn(1);
    await settle();
    // With PowerPathClosed the cable completes the start; the remote start id comes along.
    expect(txPayload(calls, 0)).toMatchObject({
      triggerReason: 'CablePluggedIn',
      idToken: tag('REMOTE-1'),
      transactionInfo: { remoteStartId: 7 },
    });
    const id = txPayload(calls, 0).transactionInfo.transactionId;
    expect(await csmsCall('RequestStopTransaction', { transactionId: 'nope' })).toEqual({
      status: 'Rejected',
    });
    expect(await csmsCall('RequestStopTransaction', { transactionId: id })).toEqual({
      status: 'Accepted',
    });
    await settle();
    expect(events()).toEqual(['Started CablePluggedIn', 'Ended RemoteStop Remote']);
    // A busy EVSE, an unknown one, or the refuse switch: Rejected.
    await csmsCall('RequestStartTransaction', { idToken: tag('A'), remoteStartId: 8, evseId: 2 });
    expect(
      await csmsCall('RequestStartTransaction', { idToken: tag('B'), remoteStartId: 9, evseId: 2 }),
    ).toEqual({
      status: 'Rejected',
    });
    expect(
      await csmsCall('RequestStartTransaction', { idToken: tag('B'), remoteStartId: 9, evseId: 5 }),
    ).toEqual({
      status: 'Rejected',
    });
    cp.setBehaviour({ refuseRemoteStart: true });
    expect(
      await csmsCall('RequestStartTransaction', { idToken: tag('C'), remoteStartId: 10 }),
    ).toEqual({
      status: 'Rejected',
    });
  });

  it('starts with RemoteStart when the authorization starts it (F02.FR.21)', async () => {
    const { csmsCall, boot, settle, events } = setup({
      deviceModel: { TxCtrlr: { TxStartPoint: 'Authorized' } },
    });
    await boot();
    await csmsCall('RequestStartTransaction', {
      idToken: tag('REMOTE-3'),
      remoteStartId: 4,
      evseId: 1,
    });
    await settle();
    expect(events()).toEqual(['Started RemoteStart']);
  });

  it('gives a token to a transaction that started without one, and returns its id', async () => {
    const { cp, calls, csmsCall, boot, settle, events } = setup({
      deviceModel: {
        TxCtrlr: { TxStartPoint: 'EVConnected' },
        AuthCtrlr: { AuthorizeRemoteStart: false },
      },
    });
    await boot();
    cp.plugIn(1);
    await settle();
    const id = txPayload(calls, 0).transactionInfo.transactionId;
    expect(
      await csmsCall('RequestStartTransaction', {
        idToken: tag('REMOTE-2'),
        remoteStartId: 3,
        evseId: 1,
      }),
    ).toEqual({ status: 'Accepted', transactionId: id });
    await settle();
    expect(calls('Authorize')).toHaveLength(0);
    expect(events()).toEqual(['Started CablePluggedIn', 'Updated RemoteStart']);
    expect(txPayload(calls, 1).idToken).toEqual(tag('REMOTE-2'));
  });

  it('unlocks a connector unless an authorized transaction runs on it', async () => {
    const { cp, csmsCall, boot, settle, present } = setup();
    await boot();
    cp.setBehaviour({ cableLock: true });
    await present(1, 'TAG-1');
    cp.plugIn(1);
    await settle();
    expect(cp.snapshot().connectors[0]?.locked).toBe(true);
    expect(await csmsCall('UnlockConnector', { evseId: 1, connectorId: 1 })).toEqual({
      status: 'OngoingAuthorizedTransaction',
    });
    expect(await csmsCall('UnlockConnector', { evseId: 3, connectorId: 1 })).toEqual({
      status: 'UnknownConnector',
    });
    expect(await csmsCall('UnlockConnector', { evseId: 2, connectorId: 1 })).toEqual({
      status: 'Unlocked',
    });
  });

  it('sends what TriggerMessage asks for, after its answer', async () => {
    const { cp, calls, csmsCall, boot, settle, present, statuses, frames } = setup();
    await boot();
    await present(1, 'TAG-1');
    cp.plugIn(1);
    await settle();
    const from = frames.length;
    for (const requestedMessage of [
      'Heartbeat',
      'StatusNotification',
      'MeterValues',
      'TransactionEvent',
    ]) {
      expect(await csmsCall('TriggerMessage', { requestedMessage, evse: { id: 1 } })).toEqual({
        status: 'Accepted',
      });
    }
    await settle();
    expect(calls('Heartbeat')).toHaveLength(1);
    expect(statuses(from)).toEqual(['1/1:Occupied']);
    expect(calls('MeterValues')[0]?.payload).toMatchObject({
      evseId: 1,
      meterValue: [{ sampledValue: [{ context: 'Trigger' }] }],
    });
    expect(calls('TransactionEvent').at(-1)?.payload).toMatchObject({ triggerReason: 'Trigger' });
    // Already accepted: no BootNotification; unknown messages: NotImplemented.
    expect(await csmsCall('TriggerMessage', { requestedMessage: 'BootNotification' })).toEqual({
      status: 'NotImplemented',
    });
    expect(await csmsCall('TriggerMessage', { requestedMessage: 'SignV2GCertificate' })).toEqual({
      status: 'NotImplemented',
    });
    expect(
      await csmsCall('TriggerMessage', { requestedMessage: 'Heartbeat', evse: { id: 9 } }),
    ).toEqual({
      status: 'Rejected',
    });
  });

  it('resets Immediate at once and OnIdle after the transactions end', async () => {
    const { cp, csmsCall, boot, settle, present, events, restarts, calls, advance } = setup();
    await boot();
    await present(1, 'TAG-1');
    cp.plugIn(1);
    await settle();
    expect(await csmsCall('Reset', { type: 'OnIdle' })).toEqual({ status: 'Scheduled' });
    expect(restarts).toEqual([]);
    await present(1, 'TAG-1');
    await advance(0);
    expect(restarts).toHaveLength(1);
    // After the restart the boot says why.
    cp.disconnected();
    await boot();
    expect(calls('BootNotification').at(-1)?.payload).toMatchObject({ reason: 'RemoteReset' });
    await present(2, 'TAG-2');
    cp.plugIn(2);
    await settle();
    expect(await csmsCall('Reset', { type: 'Immediate', evseId: 2 })).toEqual({
      status: 'Accepted',
    });
    await settle();
    expect(events().slice(-1)).toEqual(['Ended ResetCommand ImmediateReset']);
    expect(restarts).toHaveLength(1);
    expect(await csmsCall('Reset', { type: 'Immediate', evseId: 9 })).toEqual({
      status: 'Rejected',
    });
  });

  it('reports and clears customer information, and answers DataTransfer', async () => {
    const { calls, csmsCall, boot, settle, present } = setup();
    await boot();
    await present(1, 'TAG-1');
    expect(
      await csmsCall('CustomerInformation', {
        requestId: 1,
        report: true,
        clear: true,
        idToken: tag('TAG-1'),
      }),
    ).toEqual({ status: 'Accepted' });
    await settle();
    expect(calls('NotifyCustomerInformation')[0]?.payload).toMatchObject({
      requestId: 1,
      seqNo: 0,
      data: 'authorization cache: ISO14443 TAG-1 Accepted',
    });
    await csmsCall('CustomerInformation', {
      requestId: 2,
      report: true,
      clear: false,
      idToken: tag('TAG-1'),
    });
    await settle();
    expect(calls('NotifyCustomerInformation')[1]?.payload).toMatchObject({
      data: 'No information available',
    });
    expect(
      await csmsCall('CustomerInformation', {
        requestId: 3,
        report: false,
        clear: false,
        idToken: tag('A'),
      }),
    ).toEqual({
      status: 'Rejected',
    });
    expect(
      await csmsCall('CustomerInformation', {
        requestId: 4,
        report: true,
        clear: false,
        idToken: tag('A'),
        customerIdentifier: 'x',
      }),
    ).toEqual({ status: 'Invalid' });
    expect(await csmsCall('DataTransfer', { vendorId: 'acme' })).toEqual({
      status: 'UnknownVendorId',
    });
  });
});
