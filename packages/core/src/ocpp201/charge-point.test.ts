import { describe, expect, it } from 'vitest';
import { ManualClock } from '../clock.js';
import { sequentialIds } from '../ids.js';
import { OCPP201_MESSAGE_SET } from '../message-set.js';
import { parseFrame, type CallFrame, type Frame, type JsonObject } from '../ocppj.js';
import { resolvePersonas } from '../persona.js';
import { createChargePoint201, type PersistedChargePoint201 } from './charge-point.js';

const T0 = Date.parse('2026-11-15T10:00:00Z');
const BOOT = { model: 'AC-7', vendorName: 'VendorX', firmwareVersion: '1.0.0' };

type Responder = (payload: JsonObject) => JsonObject | undefined;

function setup(
  options: { csms?: Record<string, Responder>; restore?: PersistedChargePoint201 } = {},
) {
  const clock = new ManualClock(T0);
  const frames: Frame[] = [];
  const iso = () => new Date(clock.now()).toISOString();
  const responders: Record<string, Responder> = {
    BootNotification: () => ({ status: 'Accepted', currentTime: iso(), interval: 60 }),
    Heartbeat: () => ({ currentTime: iso() }),
    StatusNotification: () => ({}),
    ...options.csms,
  };
  const cp = createChargePoint201({
    clock,
    ids: sequentialIds('cp-'),
    boot: BOOT,
    connectors: 2,
    timing: { actionDelayMs: 0 },
    send: (text) => {
      const parsed = parseFrame(text);
      if (parsed.ok) frames.push(parsed.frame);
    },
    ...(options.restore !== undefined && { restore: options.restore }),
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
        if (reply !== undefined) cp.receive(JSON.stringify([3, frame.id, reply]));
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
  return { clock, cp, frames, calls, statuses, csmsCall, advance, boot, settle };
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
  it('answers CALLs it does not handle yet with NotSupported, and 1.6 actions with NotImplemented', async () => {
    const { frames, boot, settle, cp } = setup();
    await boot();
    cp.receive(
      '[2,"x1","GetVariables",{"getVariableData":[{"component":{"name":"A"},"variable":{"name":"B"}}]}]',
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
