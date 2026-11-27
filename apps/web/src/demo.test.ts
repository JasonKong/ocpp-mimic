import { describe, expect, it } from 'vitest';
import type { ConnectorSnapshot, FrameRecord } from './api.js';
import {
  bayView,
  carFor,
  clockText,
  createPortTracker,
  DEFAULT_SETUP,
  DEMO_CARS,
  demoPersona,
  demoStations,
  frameLabel,
  START_MODES,
} from './demo.js';

const connector = (patch: Partial<ConnectorSnapshot> = {}): ConnectorSnapshot => ({
  connectorId: 1,
  status: 'Available',
  errorCode: 'NoError',
  plugged: false,
  locked: false,
  energyWh: 0,
  powerW: 0,
  ...patch,
});
const ev = (soc: number, targetSoc?: number) => ({
  soc,
  profile: {
    capacityKWh: 40,
    initialSoc: 50,
    maxPowerW: 7400,
    phases: 1,
    ...(targetSoc !== undefined && { targetSoc }),
  },
});
const frame = (patch: Partial<FrameRecord>): FrameRecord => ({
  kind: 'frame',
  seq: 1,
  stationId: 'DEMO-1',
  at: '2026-11-27T10:00:00.000Z',
  direction: 'cp-to-csms',
  text: '',
  ...patch,
});

describe('the demo car park', () => {
  it('builds generic stations for the version and ports, tagged as the demo', () => {
    expect(demoPersona('1.6', 1)).toBe('generic-1.6');
    expect(demoPersona('2.1', 2)).toBe('generic-dual-2.1');
    const stations = demoStations({ ...DEFAULT_SETUP, ocpp: '2.0.1', mode: 'card', chargers: 3 });
    expect(stations.map((s) => s.id)).toEqual(['DEMO-1', 'DEMO-2', 'DEMO-3']);
    expect(stations[0]).toEqual({
      id: 'DEMO-1',
      persona: 'generic-dual-2.0.1',
      csmsUrl: DEFAULT_SETUP.csmsUrl,
      tags: ['demo'],
      energyMultiplier: DEFAULT_SETUP.speed,
      deviceModel: { SampledDataCtrlr: { TxUpdatedInterval: 10 } },
    });
  });

  it('turns free vend on in the station: a 1.6 vendor key, or 2.x without authorization', () => {
    const [v16] = demoStations({ ...DEFAULT_SETUP, ocpp: '1.6', mode: 'free-vend' });
    expect(v16?.config).toEqual({
      MeterValueSampleInterval: '10',
      FreeVendEnabled: 'true',
      FreeVendIdTag: 'HOME',
    });
    const [v21] = demoStations({ ...DEFAULT_SETUP, ocpp: '2.1', mode: 'free-vend' });
    expect(v21?.deviceModel).toEqual({
      SampledDataCtrlr: { TxUpdatedInterval: 10 },
      AuthCtrlr: { Enabled: false },
    });
    // Valet is the CSMS's doing: the station is an ordinary one.
    const [valet] = demoStations({ ...DEFAULT_SETUP, ocpp: '1.6', mode: 'valet' });
    expect(valet?.config).toEqual({ MeterValueSampleInterval: '10' });
    expect(START_MODES.map((m) => m.id)).toEqual(['free-vend', 'card', 'app', 'valet']);
  });

  it('gives each bay its own car, round the list', () => {
    expect(carFor(0)).toBe(DEMO_CARS[0]);
    expect(carFor(DEMO_CARS.length + 1)).toBe(DEMO_CARS[1]);
    expect(new Set(DEMO_CARS.map((c) => c.name)).size).toBe(DEMO_CARS.length);
  });
});

describe('a bay from a connector', () => {
  it('follows a 1.6 session from plug-in to full and to the end', () => {
    expect(bayView(connector(), '1.6')).toMatchObject({ phase: 'empty', status: 'Available' });
    expect(
      bayView(connector({ plugged: true, status: 'Preparing', ev: ev(50) }), '1.6'),
    ).toMatchObject({ phase: 'plugged', soc: 50, addedKWh: 0 });
    const charging = bayView(
      connector({ plugged: true, status: 'Charging', transactionId: 7, powerW: 7360, ev: ev(60) }),
      '1.6',
    );
    expect(charging).toMatchObject({ phase: 'charging', transaction: true, powerW: 7360 });
    expect(charging.addedKWh).toBeCloseTo(4);
    // SuspendedEV at the target is full; below it the EV only paused.
    expect(
      bayView(
        connector({ plugged: true, status: 'SuspendedEV', transactionId: 7, ev: ev(100) }),
        '1.6',
      ).phase,
    ).toBe('full');
    expect(
      bayView(
        connector({ plugged: true, status: 'SuspendedEV', transactionId: 7, ev: ev(80, 80) }),
        '1.6',
      ).phase,
    ).toBe('full');
    expect(
      bayView(
        connector({ plugged: true, status: 'SuspendedEV', transactionId: 7, ev: ev(70) }),
        '1.6',
      ).phase,
    ).toBe('suspended');
    expect(
      bayView(connector({ plugged: true, status: 'Finishing', ev: ev(100) }), '1.6').phase,
    ).toBe('finished');
  });

  it('reads 2.x from the charging state, and remembers a session that ran', () => {
    const occupied = { plugged: true, status: 'Occupied', ev: ev(55) };
    expect(
      bayView(connector({ ...occupied, chargingState: 'EVConnected' }), '2.0.1'),
    ).toMatchObject({
      phase: 'plugged',
      status: 'Occupied · EVConnected',
    });
    expect(
      bayView(connector({ ...occupied, chargingState: 'Charging', transactionId: 'tx-1' }), '2.1')
        .phase,
    ).toBe('charging');
    expect(
      bayView(
        connector({
          ...occupied,
          chargingState: 'SuspendedEV',
          transactionId: 'tx-1',
          ev: ev(100),
        }),
        '2.0.1',
      ).phase,
    ).toBe('full');
    // After the transaction, still plugged in: 2.x has no Finishing, so the page remembers.
    expect(
      bayView(connector({ ...occupied, chargingState: 'EVConnected' }), '2.0.1', true).phase,
    ).toBe('finished');
  });

  it('shows faults and unavailable connectors first', () => {
    expect(
      bayView(connector({ status: 'Faulted', errorCode: 'GroundFailure', transactionId: 3 }), '1.6')
        .phase,
    ).toBe('fault');
    expect(bayView(connector({ status: 'Unavailable' }), '2.0.1').phase).toBe('unavailable');
  });
});

describe('message labels', () => {
  it('names calls, answers with their status, and errors with their code', () => {
    expect(frameLabel(frame({ messageType: 2, action: 'StartTransaction' }))).toEqual({
      kind: 'call',
      text: 'StartTransaction',
    });
    expect(
      frameLabel(
        frame({
          messageType: 3,
          action: 'StartTransaction',
          payload: { idTagInfo: { status: 'Accepted' }, transactionId: 1 },
        }),
      ),
    ).toEqual({ kind: 'result', text: 'StartTransaction', status: 'Accepted' });
    expect(
      frameLabel(
        frame({
          messageType: 3,
          action: 'Authorize',
          payload: { idTokenInfo: { status: 'Invalid' } },
        }),
      ),
    ).toMatchObject({ status: 'Invalid' });
    expect(
      frameLabel(
        frame({
          messageType: 3,
          action: 'RemoteStartTransaction',
          payload: { status: 'Rejected' },
        }),
      ),
    ).toMatchObject({ status: 'Rejected' });
    expect(frameLabel(frame({ messageType: 3, action: 'Heartbeat', payload: {} }))).toEqual({
      kind: 'result',
      text: 'Heartbeat',
    });
    expect(
      frameLabel(
        frame({ messageType: 4, action: 'Reset', text: '[4,"x","NotSupported","no",{}]' }),
      ),
    ).toEqual({ kind: 'error', text: 'Reset', status: 'NotSupported' });
  });

  it('writes times as mm:ss, and h:mm:ss from an hour', () => {
    expect(clockText(0)).toBe('00:00');
    expect(clockText(65_400)).toBe('01:05');
    expect(clockText(3_725_000)).toBe('1:02:05');
    expect(clockText(-5)).toBe('00:00');
  });
});

describe('the port a message is about', () => {
  it('follows 1.6 connectors, answers and transaction ids', () => {
    const portOf = createPortTracker();
    const call = (uniqueId: string, action: string, payload: unknown) =>
      portOf(frame({ messageType: 2, uniqueId, action, payload }));
    const answer = (uniqueId: string, payload: unknown) =>
      portOf(frame({ messageType: 3, uniqueId, payload }));
    expect(
      call('a', 'StatusNotification', { connectorId: 0, status: 'Available' }),
    ).toBeUndefined();
    expect(call('b', 'StartTransaction', { connectorId: 2, idTag: 'X' })).toBe(2);
    expect(answer('b', { transactionId: 7, idTagInfo: { status: 'Accepted' } })).toBe(2);
    // StopTransaction and the CSMS's remote stop only carry the transaction id.
    expect(call('c', 'StopTransaction', { transactionId: 7, meterStop: 10 })).toBe(2);
    expect(answer('c', {})).toBe(2);
    expect(call('d', 'RemoteStopTransaction', { transactionId: 7 })).toBe(2);
    expect(answer('unknown', {})).toBeUndefined();
  });

  it('follows 2.x EVSEs, and transactions whose later events name none', () => {
    const portOf = createPortTracker();
    const event = (uniqueId: string, payload: Record<string, unknown>) =>
      portOf(frame({ messageType: 2, uniqueId, action: 'TransactionEvent', payload }));
    expect(
      event('a', {
        eventType: 'Started',
        evse: { id: 2, connectorId: 1 },
        transactionInfo: { transactionId: 'tx-1' },
      }),
    ).toBe(2);
    expect(event('b', { eventType: 'Updated', transactionInfo: { transactionId: 'tx-1' } })).toBe(
      2,
    );
    expect(
      portOf(
        frame({
          messageType: 2,
          uniqueId: 'c',
          action: 'RequestStartTransaction',
          payload: { evseId: 1 },
        }),
      ),
    ).toBe(1);
    // Ids are per station.
    expect(
      portOf(
        frame({
          stationId: 'DEMO-2',
          messageType: 2,
          uniqueId: 'b',
          action: 'TransactionEvent',
          payload: { transactionInfo: { transactionId: 'tx-1' } },
        }),
      ),
    ).toBeUndefined();
  });
});
