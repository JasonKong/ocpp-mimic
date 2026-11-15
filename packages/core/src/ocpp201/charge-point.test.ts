import { describe, expect, it } from 'vitest';
import type { CertificateTools } from '../certificates.js';
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

/**
 * Fake X.509 as in the 1.6 tests: a certificate is `CERT <name> BY <issuer>
 * KEY <key>`, valid when its issuer is a trusted root; a signature is valid
 * when it is "good".
 */
const cert = (name: string, issuer = name, key = `${name}-key`) =>
  `CERT ${name} BY ${issuer} KEY ${key}`;
function fakeTools(): CertificateTools & { csrs: string[] } {
  const csrs: string[] = [];
  return {
    csrs,
    inspect(pem) {
      const match = /^CERT (\S+) BY (\S+) KEY (\S+)/.exec(pem);
      if (match === null) return undefined;
      return {
        hashData: {
          hashAlgorithm: 'SHA256',
          issuerNameHash: `name-${match[2]}`,
          issuerKeyHash: `key-${match[2]}`,
          serialNumber: (match[1] ?? '').toUpperCase(),
        },
        validFrom: 0,
        validTo: Number.MAX_SAFE_INTEGER,
      };
    },
    verifyChain(chain, roots) {
      const issuer = /^CERT \S+ BY (\S+)/.exec(chain)?.[1];
      return issuer !== undefined && roots.some((root) => root.startsWith(`CERT ${issuer} `));
    },
    createCsr(subject) {
      const csr = `CSR CN=${subject.commonName} O=${subject.organization ?? '-'}`;
      csrs.push(csr);
      return { csr, privateKey: `cp-key-${csrs.length}` };
    },
    matchesKey: (certificate, privateKey) => certificate.endsWith(`KEY ${privateKey}`),
    verifySignature: (_data, signature) => signature === 'good',
  };
}
const hashOf = (name: string, issuer = name) => ({
  hashAlgorithm: 'SHA256',
  issuerNameHash: `name-${issuer}`,
  issuerKeyHash: `key-${issuer}`,
  serialNumber: name.toUpperCase(),
});
const BOOT = { model: 'AC-7', vendorName: 'VendorX', firmwareVersion: '1.0.0' };

type Responder = (payload: JsonObject) => JsonObject | undefined;

function setup(
  options: {
    csms?: Record<string, Responder>;
    restore?: PersistedChargePoint201;
    deviceModel?: ChargePoint201Options['deviceModel'];
    features?: string[];
    extra?: Partial<ChargePoint201Options>;
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
    SecurityEventNotification: () => ({}),
    FirmwareStatusNotification: () => ({}),
    LogStatusNotification: () => ({}),
    SignCertificate: () => ({ status: 'Accepted' }),
    ReportChargingProfiles: () => ({}),
    ReservationStatusUpdate: () => ({}),
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
    ...options.extra,
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
          features: ['Core', 'Reservation'],
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
      features: ['Core', 'Reservation'],
      timing: { actionDelaysMs: { RequestStartTransaction: 1000 } },
    });
    // Every certification profile is implemented now: no warnings.
    expect(persona?.warnings ?? []).toEqual([]);
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

describe('a 2.0.1 station: security', () => {
  const variable = (component: string, name: string) => ({
    component: { name: component },
    variable: { name },
  });
  async function getValue(
    csmsCall: (action: string, payload: JsonObject) => Promise<unknown>,
    component: string,
    name: string,
  ) {
    const answer = (await csmsCall('GetVariables', {
      getVariableData: [variable(component, name)],
    })) as { getVariableResult: { attributeValue?: string }[] };
    return answer.getVariableResult[0]?.attributeValue;
  }
  const setValue = (
    csmsCall: (action: string, payload: JsonObject) => Promise<unknown>,
    component: string,
    name: string,
    value: string,
  ) =>
    csmsCall('SetVariables', {
      setVariableData: [{ ...variable(component, name), attributeValue: value }],
    }) as Promise<{ setVariableResult: { attributeStatus: string }[] }>;

  it('sends StartupOfTheDevice once booted and logs a password change without sending it', async () => {
    const { cp, calls, csmsCall, boot } = setup();
    await boot();
    expect(calls('SecurityEventNotification').map((c) => c.payload.type)).toEqual([
      'StartupOfTheDevice',
    ]);
    const result = await setValue(
      csmsCall,
      'SecurityCtrlr',
      'BasicAuthPassword',
      'secret-0123456789',
    );
    expect(result.setVariableResult[0]?.attributeStatus).toBe('Accepted');
    // Not critical: in the security log only, without the password (A01.FR.11, .12).
    expect(calls('SecurityEventNotification')).toHaveLength(1);
    const logged = cp.snapshot().securityEvents.at(-1);
    expect(logged).toMatchObject({ type: 'ReconfigurationOfSecurityParameters' });
    expect(JSON.stringify(logged)).not.toContain('secret');
    expect(cp.connectionSecurity()).toMatchObject({
      profile: 0,
      authorizationKey: 'secret-0123456789',
    });
  });

  it('installs, lists and deletes CA certificates (M03 to M05)', async () => {
    const tools = fakeTools();
    const { cp, csmsCall, boot } = setup({
      extra: {
        certificateTools: tools,
        certificates: { chargePoint: { certificate: cert('cs', 'csms'), privateKey: 'k' } },
      },
    });
    await boot();
    for (const [certificateType, name] of [
      ['CSMSRootCertificate', 'csms'],
      ['ManufacturerRootCertificate', 'maker'],
      ['V2GRootCertificate', 'v2g'],
    ] as const) {
      expect(
        await csmsCall('InstallCertificate', { certificateType, certificate: cert(name) }),
      ).toEqual({
        status: 'Accepted',
      });
    }
    expect(
      await csmsCall('InstallCertificate', {
        certificateType: 'MORootCertificate',
        certificate: 'junk',
      }),
    ).toEqual({
      status: 'Rejected',
    });
    expect(await getValue(csmsCall, 'SecurityCtrlr', 'CertificateEntries')).toBe('4');
    expect(
      await csmsCall('GetInstalledCertificateIds', {
        certificateType: ['CSMSRootCertificate', 'V2GRootCertificate'],
      }),
    ).toEqual({
      status: 'Accepted',
      certificateHashDataChain: [
        { certificateType: 'CSMSRootCertificate', certificateHashData: hashOf('csms') },
        { certificateType: 'V2GRootCertificate', certificateHashData: hashOf('v2g') },
      ],
    });
    expect(
      await csmsCall('GetInstalledCertificateIds', { certificateType: ['MORootCertificate'] }),
    ).toEqual({
      status: 'NotFound',
    });
    // The station's own certificate cannot be deleted (M04.FR.06).
    expect(
      await csmsCall('DeleteCertificate', { certificateHashData: hashOf('cs', 'csms') }),
    ).toEqual({
      status: 'Failed',
    });
    expect(await csmsCall('DeleteCertificate', { certificateHashData: hashOf('v2g') })).toEqual({
      status: 'Accepted',
    });
    expect(await csmsCall('DeleteCertificate', { certificateHashData: hashOf('v2g') })).toEqual({
      status: 'NotFound',
    });
    expect(cp.snapshot().certificates).toEqual({
      centralSystemRoots: 1,
      manufacturerRoots: 1,
      chargePoint: true,
    });
  });

  it('renews its certificate on a trigger, with back-off, and rejects a wrong one (A02)', async () => {
    const tools = fakeTools();
    const { cp, calls, csmsCall, boot, advance } = setup({
      features: ['Core', 'AdvancedSecurity'],
      deviceModel: { SecurityCtrlr: { CertSigningWaitMinimum: 10, CertSigningRepeatTimes: 2 } },
      extra: {
        certificateTools: tools,
        serialNumber: 'SN-1',
        certificates: { centralSystemRoots: [cert('csms')] },
      },
    });
    await boot();
    expect(
      await csmsCall('TriggerMessage', { requestedMessage: 'SignChargingStationCertificate' }),
    ).toEqual({
      status: 'Accepted',
    });
    expect(calls('SignCertificate')[0]?.payload).toEqual({
      csr: 'CSR CN=SN-1 O=ocpp-mimic',
      certificateType: 'ChargingStationCertificate',
    });
    // No CertificateSigned: the same CSR again after 10 s, then 20 s, then no more (A02.FR.17 to .19).
    await advance(10_000);
    await advance(20_000);
    await advance(60_000);
    expect(calls('SignCertificate')).toHaveLength(3);
    expect(tools.csrs).toHaveLength(1);
    // Signed by an unknown CA: rejected, reported, no retry (A02.FR.07, .20).
    expect(
      await csmsCall('CertificateSigned', { certificateChain: cert('cs', 'rogue', 'cp-key-1') }),
    ).toEqual({
      status: 'Rejected',
    });
    expect(calls('SecurityEventNotification').at(-1)?.payload).toMatchObject({
      type: 'InvalidChargingStationCertificate',
    });
    await csmsCall('TriggerMessage', { requestedMessage: 'SignChargingStationCertificate' });
    expect(
      await csmsCall('CertificateSigned', { certificateChain: cert('cs', 'csms', 'cp-key-2') }),
    ).toEqual({
      status: 'Accepted',
    });
    expect(cp.connectionSecurity().chargePointCertificate).toEqual({
      certificate: cert('cs', 'csms', 'cp-key-2'),
      privateKey: 'cp-key-2',
    });
  });

  it('leaves certificate signing to the AdvancedSecurity profile', async () => {
    const { csmsCall, boot } = setup({ extra: { certificateTools: fakeTools() } });
    await boot();
    expect(
      await csmsCall('TriggerMessage', { requestedMessage: 'SignChargingStationCertificate' }),
    ).toEqual({
      status: 'NotImplemented',
    });
    expect(await csmsCall('CertificateSigned', { certificateChain: cert('cs') })).toMatchObject({
      errorCode: 'NotSupported',
    });
  });

  it('upgrades its Security Profile through a network profile and a reboot (A05, B09, B10)', async () => {
    const tools = fakeTools();
    const { cp, calls, csmsCall, boot, restarts, advance } = setup({
      extra: { certificateTools: tools, certificates: { centralSystemRoots: [cert('csms')] } },
    });
    await boot();
    const profile = (slot: number, securityProfile: number, url: string) =>
      csmsCall('SetNetworkProfile', {
        configurationSlot: slot,
        connectionData: {
          ocppVersion: 'OCPP20',
          ocppTransport: 'JSON',
          ocppCsmsUrl: url,
          messageTimeout: 30,
          securityProfile,
          ocppInterface: 'Wired0',
        },
      });
    expect(await profile(5, 1, 'ws://csms.test/ocpp')).toEqual({ status: 'Rejected' });
    expect(await profile(1, 2, 'ws://csms.test/ocpp')).toEqual({ status: 'Rejected' });
    expect(await profile(1, 2, 'wss://csms.test/ocpp')).toEqual({ status: 'Accepted' });
    // Profile 2 needs a password first (A05.FR.02 and its prerequisites).
    expect(
      (await setValue(csmsCall, 'OCPPCommCtrlr', 'NetworkConfigurationPriority', '1,0'))
        .setVariableResult[0],
    ).toMatchObject({ attributeStatus: 'Rejected' });
    await setValue(csmsCall, 'SecurityCtrlr', 'BasicAuthPassword', 'secret-0123456789');
    expect(
      (await setValue(csmsCall, 'OCPPCommCtrlr', 'NetworkConfigurationPriority', '1,0'))
        .setVariableResult[0],
    ).toMatchObject({ attributeStatus: 'RebootRequired' });
    // Nothing changes before the reboot.
    expect(cp.connectionSecurity()).toMatchObject({ profile: 0 });
    expect(await csmsCall('Reset', { type: 'OnIdle' })).toEqual({ status: 'Accepted' });
    await advance(0);
    expect(restarts).toHaveLength(1);
    cp.disconnected();
    expect(cp.connectionSecurity()).toMatchObject({
      profile: 2,
      csmsUrl: 'wss://csms.test/ocpp',
      authorizationKey: 'secret-0123456789',
      centralSystemRoots: [cert('csms')],
    });
    await boot();
    expect(calls('BootNotification').at(-1)?.payload).toMatchObject({ reason: 'RemoteReset' });
    // Connected: profile 2 now, slot 0 (profile 0) gone (A05.FR.06).
    expect(await getValue(csmsCall, 'SecurityCtrlr', 'SecurityProfile')).toBe('2');
    expect(await getValue(csmsCall, 'OCPPCommCtrlr', 'NetworkConfigurationPriority')).toBe('1');
    expect(await getValue(csmsCall, 'OCPPCommCtrlr', 'ActiveNetworkProfile')).toBe('1');
    expect(cp.snapshot().securityEvents.map((e) => e.type)).toContain(
      'ReconfigurationOfSecurityParameters',
    );
    // No way back to a lower profile (B09.FR.04).
    expect(await profile(2, 1, 'ws://csms.test/ocpp')).toEqual({ status: 'Rejected' });
    expect(cp.persistentState().security?.slots).toEqual({
      '1': { securityProfile: 2, csmsUrl: 'wss://csms.test/ocpp' },
    });
  });

  it('falls back to the next network profile after the connection attempts (B10.FR.03, .07)', async () => {
    const reconnects: number[] = [];
    const { cp, csmsCall, boot, advance } = setup({
      deviceModel: {
        OCPPCommCtrlr: { NetworkProfileConnectionAttempts: 2 },
        SecurityCtrlr: { BasicAuthPassword: 'secret-0123456789' },
      },
      extra: { reconnect: () => reconnects.push(1) },
    });
    await boot();
    await csmsCall('SetNetworkProfile', {
      configurationSlot: 1,
      connectionData: {
        ocppVersion: 'OCPP20',
        ocppTransport: 'JSON',
        ocppCsmsUrl: 'ws://new-csms.test/ocpp',
        messageTimeout: 30,
        securityProfile: 1,
        ocppInterface: 'Wired0',
      },
    });
    await setValue(csmsCall, 'OCPPCommCtrlr', 'NetworkConfigurationPriority', '1,0');
    await csmsCall('Reset', { type: 'Immediate' });
    await advance(0);
    cp.disconnected();
    expect(cp.connectionSecurity()).toMatchObject({
      profile: 1,
      csmsUrl: 'ws://new-csms.test/ocpp',
    });
    cp.connectionFailed();
    expect(reconnects).toHaveLength(0);
    cp.connectionFailed();
    expect(reconnects).toHaveLength(1);
    expect(cp.connectionSecurity().profile).toBe(0);
    expect(cp.connectionSecurity().csmsUrl).toBeUndefined();
    await boot();
    // Back on slot 0: the Security Profile stays 0.
    expect(await getValue(csmsCall, 'SecurityCtrlr', 'SecurityProfile')).toBe('0');
    expect(await getValue(csmsCall, 'OCPPCommCtrlr', 'ActiveNetworkProfile')).toBe('0');
  });
});

describe('a 2.0.1 station: firmware and logs', () => {
  const firmware = { downloadMs: 1000, installMs: 1000, uploadMs: 1000 };
  const statusesOf = (calls: (action?: string) => CallFrame[], action: string) =>
    calls(action).map((c) => String(c.payload.status));

  it('updates its firmware, reboots and reports Installed from the new firmware (L01, L02)', async () => {
    const { cp, calls, csmsCall, boot, advance, restarts } = setup({ extra: { firmware } });
    await boot();
    expect(
      await csmsCall('UpdateFirmware', {
        requestId: 7,
        firmware: {
          location: 'https://files.test/fw-2.0.0.bin',
          retrieveDateTime: new Date(T0).toISOString(),
        },
      }),
    ).toEqual({ status: 'Accepted' });
    await advance(5000);
    expect(statusesOf(calls, 'FirmwareStatusNotification')).toEqual([
      'Downloading',
      'Downloaded',
      'Installing',
      'InstallRebooting',
    ]);
    expect(calls('FirmwareStatusNotification').every((c) => c.payload.requestId === 7)).toBe(true);
    expect(restarts).toHaveLength(1);
    cp.disconnected();
    await boot();
    expect(calls('BootNotification').at(-1)?.payload).toEqual({
      reason: 'FirmwareUpdate',
      chargingStation: { ...BOOT, firmwareVersion: '2.0.0' },
    });
    expect(calls('FirmwareStatusNotification').at(-1)?.payload).toEqual({
      status: 'Installed',
      requestId: 7,
    });
    expect(calls('SecurityEventNotification').map((c) => c.payload.type)).toEqual([
      'StartupOfTheDevice',
      'ResetOrReboot',
      'FirmwareUpdated',
    ]);
    // After Installed a trigger answers Idle (L01.FR.25).
    await csmsCall('TriggerMessage', { requestedMessage: 'FirmwareStatusNotification' });
    expect(calls('FirmwareStatusNotification').at(-1)?.payload).toEqual({ status: 'Idle' });
    expect(cp.snapshot().firmwareVersion).toBe('2.0.0');
  });

  it('checks the signing certificate and the signature of signed firmware', async () => {
    const tools = fakeTools();
    const { calls, csmsCall, boot, advance } = setup({
      extra: {
        firmware,
        certificateTools: tools,
        certificates: { manufacturerRoots: [cert('maker')] },
      },
    });
    await boot();
    const signed = (signingCertificate: string, signature: string, requestId: number) =>
      csmsCall('UpdateFirmware', {
        requestId,
        firmware: {
          location: 'https://files.test/fw-3.0.0.bin',
          retrieveDateTime: new Date(T0).toISOString(),
          signingCertificate,
          signature,
        },
      });
    expect(await signed(cert('signer', 'rogue'), 'good', 1)).toEqual({
      status: 'InvalidCertificate',
    });
    expect(calls('SecurityEventNotification').at(-1)?.payload).toMatchObject({
      type: 'InvalidFirmwareSigningCertificate',
    });
    // Without a FileTransfer the signature check is the persona's setting.
    const {
      calls: calls2,
      csmsCall: csmsCall2,
      boot: boot2,
      advance: advance2,
    } = setup({
      extra: {
        firmware: { ...firmware, signature: 'fail' },
        certificateTools: tools,
        certificates: { manufacturerRoots: [cert('maker')] },
      },
    });
    await boot2();
    expect(
      await csmsCall2('UpdateFirmware', {
        requestId: 2,
        firmware: {
          location: 'https://files.test/fw-3.0.0.bin',
          retrieveDateTime: new Date(T0).toISOString(),
          signingCertificate: cert('signer', 'maker'),
          signature: 'whatever',
        },
      }),
    ).toEqual({ status: 'Accepted' });
    await advance2(5000);
    expect(statusesOf(calls2, 'FirmwareStatusNotification')).toEqual([
      'Downloading',
      'Downloaded',
      'InvalidSignature',
    ]);
    expect(calls2('SecurityEventNotification').at(-1)?.payload).toMatchObject({
      type: 'InvalidFirmwareSignature',
    });
    // A new request cancels the one in progress (L01.FR.24).
    expect(await signed(cert('signer', 'maker'), 'good', 3)).toEqual({ status: 'Accepted' });
    expect(await signed(cert('signer', 'maker'), 'good', 4)).toEqual({
      status: 'AcceptedCanceled',
    });
    await advance(5000);
    expect(calls('FirmwareStatusNotification').at(-1)?.payload).toEqual({
      status: 'InstallRebooting',
      requestId: 4,
    });
  });

  it('waits for the transactions to end before installing (L01.FR.06)', async () => {
    const { cp, calls, csmsCall, boot, advance, present } = setup({ extra: { firmware } });
    await boot();
    await present(1, 'TAG-1');
    cp.plugIn(1);
    await advance(0);
    await csmsCall('UpdateFirmware', {
      requestId: 9,
      firmware: {
        location: 'https://files.test/fw-2.1.0.bin',
        retrieveDateTime: new Date(T0).toISOString(),
      },
    });
    await advance(10_000);
    expect(statusesOf(calls, 'FirmwareStatusNotification')).toEqual(['Downloading', 'Downloaded']);
    await present(1, 'TAG-1');
    await advance(5000);
    expect(statusesOf(calls, 'FirmwareStatusNotification').slice(2)).toEqual([
      'Installing',
      'InstallRebooting',
    ]);
  });

  it('uploads the security log with GetLog and reports its progress (N01)', async () => {
    const uploads: { url: string; fileName: string; content: string }[] = [];
    const transfer = {
      download: () => Promise.resolve(undefined),
      upload: (url: string, fileName: string, content: string) => {
        uploads.push({ url, fileName, content });
        return Promise.resolve(true);
      },
    };
    const { calls, csmsCall, boot, advance } = setup({ extra: { firmware, transfer } });
    await boot();
    const answer = (await csmsCall('GetLog', {
      logType: 'SecurityLog',
      requestId: 3,
      log: { remoteLocation: 'https://logs.test/upload/' },
    })) as { status: string; filename: string };
    expect(answer).toEqual({ status: 'Accepted', filename: 'security-20261115T100000Z.log' });
    await advance(1000);
    expect(calls('LogStatusNotification').map((c) => c.payload)).toEqual([
      { status: 'Uploading', requestId: 3 },
      { status: 'Uploaded', requestId: 3 },
    ]);
    expect(uploads[0]?.url).toBe('https://logs.test/upload/security-20261115T100000Z.log');
    expect(uploads[0]?.content).toContain('StartupOfTheDevice');
    await csmsCall('TriggerMessage', { requestedMessage: 'LogStatusNotification' });
    expect(calls('LogStatusNotification').at(-1)?.payload).toEqual({ status: 'Idle' });
  });

  it('cancels a log upload in progress for a new GetLog (N01.FR.12)', async () => {
    const { calls, csmsCall, boot, advance } = setup({ extra: { firmware } });
    await boot();
    const request = (requestId: number) =>
      csmsCall('GetLog', {
        logType: 'DiagnosticsLog',
        requestId,
        log: { remoteLocation: 'ftp://logs.test/' },
      });
    expect(await request(1)).toMatchObject({ status: 'Accepted' });
    expect(await request(2)).toMatchObject({ status: 'AcceptedCanceled' });
    await csmsCall('TriggerMessage', { requestedMessage: 'LogStatusNotification' });
    expect(calls('LogStatusNotification').at(-1)?.payload).toEqual({
      status: 'Uploading',
      requestId: 2,
    });
    await advance(2000);
    expect(calls('LogStatusNotification').at(-1)?.payload).toEqual({
      status: 'Uploaded',
      requestId: 2,
    });
  });

  it('keeps certificates, network profiles, the security log and the firmware version across a restart', async () => {
    const tools = fakeTools();
    const first = setup({ extra: { firmware, certificateTools: tools } });
    await first.boot();
    await first.csmsCall('InstallCertificate', {
      certificateType: 'CSMSRootCertificate',
      certificate: cert('csms'),
    });
    await first.csmsCall('UpdateFirmware', {
      requestId: 5,
      firmware: {
        location: 'https://files.test/fw-4.0.0.bin',
        retrieveDateTime: new Date(T0).toISOString(),
      },
    });
    await first.advance(5000);
    const saved = first.cp.persistentState();
    const second = setup({ restore: saved, extra: { firmware, certificateTools: tools } });
    await second.boot();
    expect(second.cp.snapshot()).toMatchObject({
      firmwareVersion: '4.0.0',
      certificates: { centralSystemRoots: 1 },
    });
    // The new firmware reports Installed after the power cycle too.
    expect(second.calls('FirmwareStatusNotification').at(-1)?.payload).toEqual({
      status: 'Installed',
      requestId: 5,
    });
    expect(second.cp.snapshot().securityEvents.map((e) => e.type)).toContain('ResetOrReboot');
  });
});

describe('a 2.0.1 station: Smart Charging', () => {
  const features = ['Core', 'SmartCharging'];
  const schedule = (limit: number, unit = 'W', extra: JsonObject = {}) => [
    {
      id: 1,
      startSchedule: new Date(T0).toISOString(),
      chargingRateUnit: unit,
      chargingSchedulePeriod: [{ startPeriod: 0, limit }],
      ...extra,
    },
  ];
  const txDefault = (id: number, limit: number, extra: JsonObject = {}) => ({
    id,
    stackLevel: 0,
    chargingProfilePurpose: 'TxDefaultProfile',
    chargingProfileKind: 'Absolute',
    chargingSchedule: schedule(limit),
    ...extra,
  });

  it('limits an EVSE with a TxDefaultProfile and reports a limit of 0 as SuspendedEVSE', async () => {
    const { cp, csmsCall, boot, present, advance, events } = setup({ features });
    await boot();
    await present(1, 'TAG-1');
    cp.plugIn(1);
    await advance(0);
    expect(cp.snapshot().connectors[0]).toMatchObject({ powerW: 7360, chargingState: 'Charging' });
    expect(
      await csmsCall('SetChargingProfile', { evseId: 1, chargingProfile: txDefault(1, 3680) }),
    ).toEqual({
      status: 'Accepted',
    });
    expect(cp.snapshot().connectors[0]).toMatchObject({ powerW: 3680, limitW: 3680 });
    expect(cp.snapshot().chargingProfiles).toEqual([
      { chargingProfileId: 1, connectorId: 1, purpose: 'TxDefaultProfile', stackLevel: 0 },
    ]);
    // A higher stack level of 0 W suspends the EVSE (K01.FR.17).
    await csmsCall('SetChargingProfile', {
      evseId: 0,
      chargingProfile: txDefault(2, 0, { stackLevel: 1 }),
    });
    expect(cp.snapshot().connectors[0]).toMatchObject({ powerW: 3680 });
    // An EVSE's own TxDefaultProfile takes the place of the evseId 0 ones (K01.FR.15).
    await csmsCall('SetChargingProfile', {
      evseId: 1,
      chargingProfile: txDefault(3, 0, { stackLevel: 2 }),
    });
    expect(cp.snapshot().connectors[0]).toMatchObject({
      powerW: 0,
      chargingState: 'SuspendedEVSE',
    });
    expect(events().at(-1)).toBe('Updated ChargingStateChanged');
    expect(await csmsCall('ClearChargingProfile', { chargingProfileId: 3 })).toEqual({
      status: 'Accepted',
    });
    expect(cp.snapshot().connectors[0]).toMatchObject({ powerW: 3680, chargingState: 'Charging' });
    expect(await csmsCall('ClearChargingProfile', { chargingProfileId: 3 })).toEqual({
      status: 'Unknown',
    });
  });

  it('follows a schedule over time and stops limiting at validTo', async () => {
    const { cp, csmsCall, boot, present, advance } = setup({ features });
    await boot();
    await present(1, 'TAG-1');
    cp.plugIn(1);
    await csmsCall('SetChargingProfile', {
      evseId: 1,
      chargingProfile: {
        ...txDefault(1, 0),
        validTo: new Date(T0 + 3_600_000).toISOString(),
        chargingSchedule: [
          {
            id: 1,
            startSchedule: new Date(T0).toISOString(),
            chargingRateUnit: 'A',
            chargingSchedulePeriod: [
              { startPeriod: 0, limit: 10, numberPhases: 1 },
              { startPeriod: 600, limit: 6, numberPhases: 1 },
            ],
          },
        ],
      },
    });
    expect(cp.snapshot().connectors[0]?.limitW).toBe(2300);
    await advance(600_000);
    expect(cp.snapshot().connectors[0]?.limitW).toBe(1380);
    await advance(3_000_000);
    expect(cp.snapshot().connectors[0]?.limitW).toBeUndefined();
    expect(cp.snapshot().connectors[0]?.powerW).toBe(7360);
  });

  it('applies a TxProfile to its transaction only, and drops it when the transaction ends', async () => {
    const { cp, csmsCall, boot, present, advance, calls } = setup({ features });
    await boot();
    const txProfile = (transactionId: string) => ({
      id: 7,
      stackLevel: 0,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Relative',
      transactionId,
      chargingSchedule: [
        { id: 1, chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: 2000 }] },
      ],
    });
    // No transaction on the EVSE (K01.FR.09).
    expect(
      await csmsCall('SetChargingProfile', { evseId: 1, chargingProfile: txProfile('x') }),
    ).toMatchObject({
      status: 'Rejected',
    });
    await present(1, 'TAG-1');
    cp.plugIn(1);
    await advance(0);
    const tx = String(
      (calls('TransactionEvent')[0]?.payload.transactionInfo as JsonObject).transactionId,
    );
    // An unknown transactionId (K01.FR.33), a TxProfile on EVSE 0 (K01.FR.16).
    expect(
      await csmsCall('SetChargingProfile', { evseId: 1, chargingProfile: txProfile('other') }),
    ).toMatchObject({
      status: 'Rejected',
    });
    expect(
      await csmsCall('SetChargingProfile', { evseId: 0, chargingProfile: txProfile(tx) }),
    ).toMatchObject({
      status: 'Rejected',
    });
    expect(
      await csmsCall('SetChargingProfile', { evseId: 1, chargingProfile: txProfile(tx) }),
    ).toEqual({
      status: 'Accepted',
    });
    expect(cp.snapshot().connectors[0]?.powerW).toBe(2000);
    await present(1, 'TAG-1');
    expect(cp.snapshot().chargingProfiles).toEqual([]);
  });

  it('refuses what 2.0.1 does not allow', async () => {
    const { csmsCall, boot } = setup({ features });
    await boot();
    const set = (evseId: number, chargingProfile: JsonObject) =>
      csmsCall('SetChargingProfile', { evseId, chargingProfile }) as Promise<{ status: string }>;
    expect(
      (await set(1, { ...txDefault(1, 1000), chargingProfilePurpose: 'ChargingStationMaxProfile' }))
        .status,
    ).toBe('Rejected');
    expect(
      (
        await set(0, {
          ...txDefault(1, 1000),
          chargingProfilePurpose: 'ChargingStationExternalConstraints',
        })
      ).status,
    ).toBe('Rejected');
    expect((await set(5, txDefault(1, 1000))).status).toBe('Rejected');
    expect((await set(1, txDefault(1, 1000, { stackLevel: 11 }))).status).toBe('Rejected');
    expect(await csmsCall('GetCompositeSchedule', { duration: 60, evseId: 5 })).toEqual({
      status: 'Rejected',
    });
  });

  it('reports profiles with ReportChargingProfiles, one message per EVSE (K09)', async () => {
    const { csmsCall, boot, calls } = setup({ features });
    await boot();
    expect(await csmsCall('GetChargingProfiles', { requestId: 1, chargingProfile: {} })).toEqual({
      status: 'NoProfiles',
    });
    await csmsCall('SetChargingProfile', {
      evseId: 0,
      chargingProfile: {
        ...txDefault(1, 20_000),
        chargingProfilePurpose: 'ChargingStationMaxProfile',
      },
    });
    await csmsCall('SetChargingProfile', { evseId: 1, chargingProfile: txDefault(2, 3000) });
    await csmsCall('SetChargingProfile', { evseId: 2, chargingProfile: txDefault(3, 3000) });
    expect(await csmsCall('GetChargingProfiles', { requestId: 5, chargingProfile: {} })).toEqual({
      status: 'Accepted',
    });
    expect(
      calls('ReportChargingProfiles').map((c) => [
        c.payload.evseId,
        (c.payload.chargingProfile as JsonObject[]).map((p) => p.id),
        c.payload.tbc,
        c.payload.requestId,
        c.payload.chargingLimitSource,
      ]),
    ).toEqual([
      [0, [1], true, 5, 'CSO'],
      [1, [2], true, 5, 'CSO'],
      [2, [3], undefined, 5, 'CSO'],
    ]);
    await csmsCall('GetChargingProfiles', {
      requestId: 6,
      evseId: 1,
      chargingProfile: { chargingProfilePurpose: 'TxDefaultProfile' },
    });
    expect(calls('ReportChargingProfiles').at(-1)?.payload).toMatchObject({
      requestId: 6,
      evseId: 1,
    });
  });

  it('answers GetCompositeSchedule for an EVSE and for the station (K08)', async () => {
    const { csmsCall, boot } = setup({ features });
    await boot();
    await csmsCall('SetChargingProfile', {
      evseId: 0,
      chargingProfile: {
        ...txDefault(1, 0),
        chargingProfilePurpose: 'ChargingStationMaxProfile',
        chargingSchedule: [
          {
            id: 1,
            startSchedule: new Date(T0).toISOString(),
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [
              { startPeriod: 0, limit: 10_000 },
              { startPeriod: 1800, limit: 5000 },
            ],
          },
        ],
      },
    });
    await csmsCall('SetChargingProfile', { evseId: 1, chargingProfile: txDefault(2, 3000) });
    expect(
      await csmsCall('GetCompositeSchedule', { duration: 3600, evseId: 1, chargingRateUnit: 'W' }),
    ).toEqual({
      status: 'Accepted',
      schedule: {
        evseId: 1,
        duration: 3600,
        scheduleStart: new Date(T0).toISOString(),
        chargingRateUnit: 'W',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 3000 }],
      },
    });
    expect(await csmsCall('GetCompositeSchedule', { duration: 3600, evseId: 0 })).toMatchObject({
      status: 'Accepted',
      schedule: {
        evseId: 0,
        chargingRateUnit: 'W',
        chargingSchedulePeriod: [
          { startPeriod: 0, limit: 10_000 },
          { startPeriod: 1800, limit: 5000 },
        ],
      },
    });
  });

  it('installs the TxProfile of a remote start for the transaction it starts (K05)', async () => {
    const { cp, csmsCall, boot, advance, calls } = setup({ features });
    await boot();
    const chargingProfile = {
      id: 9,
      stackLevel: 0,
      chargingProfilePurpose: 'TxProfile',
      chargingProfileKind: 'Relative',
      chargingSchedule: [
        { id: 1, chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: 1500 }] },
      ],
    };
    expect(
      await csmsCall('RequestStartTransaction', {
        idToken: { idToken: 'TAG-R', type: 'ISO14443' },
        remoteStartId: 1,
        evseId: 1,
        chargingProfile: { ...chargingProfile, chargingProfilePurpose: 'TxDefaultProfile' },
      }),
    ).toEqual({ status: 'Rejected', statusInfo: { reasonCode: 'InvalidProfile' } });
    expect(
      await csmsCall('RequestStartTransaction', {
        idToken: { idToken: 'TAG-R', type: 'ISO14443' },
        remoteStartId: 2,
        evseId: 1,
        chargingProfile,
      }),
    ).toEqual({ status: 'Accepted' });
    await advance(0);
    cp.plugIn(1);
    await advance(0);
    const tx = (calls('TransactionEvent')[0]?.payload.transactionInfo as JsonObject).transactionId;
    expect(cp.snapshot().connectors[0]?.powerW).toBe(1500);
    expect(cp.persistentState().chargingProfiles?.[0]?.profile).toMatchObject({
      id: 9,
      transactionId: tx,
    });
  });

  it('keeps its profiles across a restart, except TxProfiles (K01.FR.27)', async () => {
    const first = setup({ features });
    await first.boot();
    await first.csmsCall('SetChargingProfile', { evseId: 1, chargingProfile: txDefault(1, 3000) });
    const saved = first.cp.persistentState();
    const second = setup({ features, restore: saved });
    await second.boot();
    expect(second.cp.snapshot().chargingProfiles).toEqual([
      { chargingProfileId: 1, connectorId: 1, purpose: 'TxDefaultProfile', stackLevel: 0 },
    ]);
  });

  it('answers NotSupported without the SmartCharging profile (K01.FR.29)', async () => {
    const { csmsCall, boot } = setup();
    await boot();
    expect(
      await csmsCall('SetChargingProfile', { evseId: 1, chargingProfile: txDefault(1, 1000) }),
    ).toMatchObject({
      errorCode: 'NotSupported',
    });
    expect(await csmsCall('GetCompositeSchedule', { duration: 60, evseId: 1 })).toMatchObject({
      errorCode: 'NotSupported',
    });
  });
});

describe('a 2.0.1 station: Reservation', () => {
  const features = ['Core', 'Reservation'];
  const token = (idToken: string) => ({ idToken, type: 'ISO14443' });
  const inMinutes = (clock: ManualClock, minutes: number) =>
    new Date(clock.now() + minutes * 60_000).toISOString();

  it('reserves an EVSE for one token, which then uses the reservation (H01, H03)', async () => {
    const { cp, clock, csmsCall, boot, present, statuses, calls, advance, frames } = setup({
      features,
    });
    await boot();
    const from = frames.length;
    expect(
      await csmsCall('ReserveNow', {
        id: 1,
        expiryDateTime: inMinutes(clock, 30),
        idToken: token('TAG-R'),
        evseId: 1,
      }),
    ).toEqual({ status: 'Accepted' });
    expect(statuses(from)).toEqual(['1/1:Reserved']);
    expect(cp.snapshot().reservations).toMatchObject([
      { reservationId: 1, connectorId: 1, idTag: 'TAG-R' },
    ]);
    // Another token is refused there, but EVSE 2 is free.
    expect(await present(1, 'TAG-X')).toBe('rejected');
    expect(await present(2, 'TAG-X')).toBe('authorized');
    expect(await present(1, 'TAG-R')).toBe('authorized');
    expect(cp.snapshot().reservations).toEqual([]);
    expect(statuses(from).at(-1)).toBe('1/1:Available');
    cp.plugIn(1);
    await advance(0);
    const started = calls('TransactionEvent').find((c) => (c.payload.evse as JsonObject).id === 1);
    expect(started?.payload).toMatchObject({ eventType: 'Started', reservationId: 1 });
  });

  it('reports an expired reservation and frees the EVSE (H04)', async () => {
    const { clock, csmsCall, boot, statuses, calls, advance, frames } = setup({ features });
    await boot();
    const from = frames.length;
    await csmsCall('ReserveNow', {
      id: 2,
      expiryDateTime: inMinutes(clock, 1),
      idToken: token('TAG-R'),
      evseId: 2,
    });
    await advance(60_000);
    expect(calls('ReservationStatusUpdate').map((c) => c.payload)).toEqual([
      { reservationId: 2, reservationUpdateStatus: 'Expired' },
    ]);
    expect(statuses(from)).toEqual(['2/1:Reserved', '2/1:Available']);
  });

  it('removes a reservation when its EVSE becomes Faulted, and cancels on request (H01.FR.16, H02)', async () => {
    const { cp, clock, csmsCall, boot, calls, advance } = setup({ features });
    await boot();
    await csmsCall('ReserveNow', {
      id: 3,
      expiryDateTime: inMinutes(clock, 30),
      idToken: token('TAG-R'),
      evseId: 1,
    });
    cp.raiseFault(1, { errorCode: 'GroundFailure' });
    await advance(0);
    expect(calls('ReservationStatusUpdate').at(-1)?.payload).toEqual({
      reservationId: 3,
      reservationUpdateStatus: 'Removed',
    });
    // A Faulted EVSE cannot be reserved (H01.FR.12).
    expect(
      await csmsCall('ReserveNow', {
        id: 4,
        expiryDateTime: inMinutes(clock, 30),
        idToken: token('T'),
        evseId: 1,
      }),
    ).toEqual({ status: 'Faulted' });
    await csmsCall('ReserveNow', {
      id: 5,
      expiryDateTime: inMinutes(clock, 30),
      idToken: token('T'),
      evseId: 2,
    });
    expect(await csmsCall('CancelReservation', { reservationId: 5 })).toEqual({
      status: 'Accepted',
    });
    await advance(0);
    expect(cp.snapshot().reservations).toEqual([]);
    expect(cp.snapshot().connectors[1]?.status).toBe('Available');
    expect(await csmsCall('CancelReservation', { reservationId: 5 })).toEqual({
      status: 'Rejected',
    });
  });

  it('keeps an EVSE free for each reservation without evseId (H01.FR.04, .07, .20)', async () => {
    const { cp, clock, csmsCall, boot, present } = setup({ features });
    await boot();
    const reserve = (id: number, extra: JsonObject = {}) =>
      csmsCall('ReserveNow', {
        id,
        expiryDateTime: inMinutes(clock, 30),
        idToken: token(`TAG-${id}`),
        ...extra,
      });
    expect(await reserve(1)).toEqual({ status: 'Accepted' });
    // Two EVSEs, one reservation: both stay Available, one may go to anyone.
    expect(cp.snapshot().connectors.map((c) => c.status)).toEqual(['Available', 'Available']);
    expect(await reserve(2)).toEqual({ status: 'Accepted' });
    await csmsCall('TriggerMessage', { requestedMessage: 'StatusNotification' });
    expect(cp.snapshot().connectors.map((c) => c.status)).toEqual(['Reserved', 'Reserved']);
    expect(await reserve(3)).toEqual({ status: 'Occupied' });
    expect(await present(1, 'TAG-X')).toBe('rejected');
    expect(await present(1, 'TAG-1')).toBe('authorized');
    expect(cp.snapshot().reservations.map((r) => r.reservationId)).toEqual([2]);
    // A connector type the station does not have (H01.FR.06).
    expect(await reserve(4, { connectorType: 'cCCS2' })).toEqual({ status: 'Rejected' });
  });

  it('lets a token of the reservation group use it (H03.FR.04)', async () => {
    const { clock, csmsCall, boot, present } = setup({
      features,
      csms: {
        Authorize: (payload) => ({
          idTokenInfo: {
            status: 'Accepted',
            ...((payload.idToken as JsonObject).idToken === 'TAG-G' && {
              groupIdToken: token('GROUP'),
            }),
          },
        }),
      },
    });
    await boot();
    await csmsCall('ReserveNow', {
      id: 6,
      expiryDateTime: inMinutes(clock, 30),
      idToken: token('TAG-R'),
      groupIdToken: token('GROUP'),
      evseId: 1,
    });
    expect(await present(1, 'TAG-X')).toBe('rejected');
    expect(await present(1, 'TAG-G')).toBe('authorized');
  });

  it('refuses reservations it cannot take', async () => {
    const { clock, csmsCall, boot } = setup({
      features,
      deviceModel: { ReservationCtrlr: { NonEvseSpecific: false } },
    });
    await boot();
    // Without evseId only with NonEvseSpecific (H01.FR.19); not an unknown EVSE; not in the past.
    expect(
      await csmsCall('ReserveNow', {
        id: 1,
        expiryDateTime: inMinutes(clock, 30),
        idToken: token('T'),
      }),
    ).toEqual({
      status: 'Rejected',
    });
    expect(
      await csmsCall('ReserveNow', {
        id: 2,
        expiryDateTime: inMinutes(clock, 30),
        idToken: token('T'),
        evseId: 9,
      }),
    ).toEqual({ status: 'Rejected' });
    expect(
      await csmsCall('ReserveNow', {
        id: 3,
        expiryDateTime: inMinutes(clock, -1),
        idToken: token('T'),
        evseId: 1,
      }),
    ).toEqual({ status: 'Rejected' });
  });

  it('refuses a remote start for another token on a reserved EVSE', async () => {
    const { clock, csmsCall, boot } = setup({ features });
    await boot();
    await csmsCall('ReserveNow', {
      id: 7,
      expiryDateTime: inMinutes(clock, 30),
      idToken: token('TAG-R'),
      evseId: 1,
    });
    expect(
      await csmsCall('RequestStartTransaction', {
        idToken: token('TAG-X'),
        remoteStartId: 1,
        evseId: 1,
      }),
    ).toEqual({ status: 'Rejected' });
    expect(
      await csmsCall('RequestStartTransaction', {
        idToken: token('TAG-R'),
        remoteStartId: 2,
        evseId: 1,
      }),
    ).toEqual({ status: 'Accepted' });
  });

  it('keeps reservations across a restart', async () => {
    const first = setup({ features });
    await first.boot();
    await first.csmsCall('ReserveNow', {
      id: 8,
      expiryDateTime: inMinutes(first.clock, 30),
      idToken: token('TAG-R'),
      evseId: 2,
    });
    const second = setup({ features, restore: first.cp.persistentState() });
    await second.boot();
    expect(second.cp.snapshot().reservations).toMatchObject([{ reservationId: 8, connectorId: 2 }]);
    expect(second.statuses()).toEqual(['1/1:Available', '2/1:Reserved']);
  });

  it('answers NotSupported without the Reservation profile', async () => {
    const { clock, csmsCall, boot } = setup();
    await boot();
    expect(
      await csmsCall('ReserveNow', {
        id: 1,
        expiryDateTime: inMinutes(clock, 30),
        idToken: token('T'),
        evseId: 1,
      }),
    ).toMatchObject({ errorCode: 'NotSupported' });
  });
});
