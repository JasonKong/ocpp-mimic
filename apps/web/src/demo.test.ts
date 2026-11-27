import { describe, expect, it } from 'vitest';
import type { ConnectorSnapshot, FrameRecord, StationSnapshot } from './api.js';
import {
  bayView,
  carFor,
  chargerLabel,
  clockText,
  createPortTracker,
  DEFAULT_SETUP,
  DEMO_CARS,
  DEMO_WEB_PAYMENT_SECRET,
  demoPersona,
  demoStations,
  frameLabel,
  MAX_CHARGERS,
  modeAvailable,
  normalizeSetup,
  siteTotals,
  stackedAreas,
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

describe('the demo site', () => {
  it('builds one generic station per charge point, single or dual, tagged as the demo', () => {
    expect(demoPersona('1.6', 'single')).toBe('generic-1.6');
    expect(demoPersona('2.1', 'dual')).toBe('generic-dual-2.1');
    const stations = demoStations({
      ...DEFAULT_SETUP,
      ocpp: '2.0.1',
      mode: 'card',
      chargers: ['dual', 'single', 'dual'],
    });
    expect(stations.map((s) => s.id)).toEqual(['DEMO-CP-1', 'DEMO-CP-2', 'DEMO-CP-3']);
    expect(stations.map((s) => s.persona)).toEqual([
      'generic-dual-2.0.1',
      'generic-2.0.1',
      'generic-dual-2.0.1',
    ]);
    expect(stations[0]).toEqual({
      id: 'DEMO-CP-1',
      persona: 'generic-dual-2.0.1',
      csmsUrl: DEFAULT_SETUP.csmsUrl,
      tags: ['demo'],
      energyMultiplier: DEFAULT_SETUP.speed,
      deviceModel: {
        SampledDataCtrlr: {
          TxUpdatedInterval: 10,
          TxUpdatedMeasurands: 'Energy.Active.Import.Register,Power.Active.Import,SoC',
        },
      },
    });
    expect(chargerLabel('DEMO-CP-2')).toBe('CP-2');
  });

  it('turns free vend on in the station: a 1.6 vendor key, or 2.x without authorization', () => {
    const [v16] = demoStations({ ...DEFAULT_SETUP, ocpp: '1.6', mode: 'free-vend' });
    // The stations report the power they draw, which the CSMS shares the site's capacity by.
    expect(v16?.config).toEqual({
      MeterValueSampleInterval: '10',
      MeterValuesSampledData: 'Energy.Active.Import.Register,Power.Active.Import,SoC',
      FreeVendEnabled: 'true',
      FreeVendIdTag: 'HOME',
    });
    const [v21] = demoStations({ ...DEFAULT_SETUP, ocpp: '2.1', mode: 'free-vend' });
    expect(v21?.deviceModel).toMatchObject({ AuthCtrlr: { Enabled: false } });
    // Valet is the CSMS's doing: the station is an ordinary one.
    const [valet] = demoStations({ ...DEFAULT_SETUP, ocpp: '1.6', mode: 'valet' });
    expect(valet?.config).not.toHaveProperty('FreeVendEnabled');
    expect(START_MODES.map((m) => m.id)).toEqual([
      'free-vend',
      'card',
      'app',
      'valet',
      'payment',
      'qr',
      'autocharge',
    ]);
    // A 2.1 station gets a known QR code secret, which the CSMS checks payments with.
    expect(v21?.deviceModel).toMatchObject({
      WebPaymentsCtrlr: { SharedSecret: DEMO_WEB_PAYMENT_SECRET },
    });
  });

  it('offers the payment terminal and the QR code on 2.1 only', () => {
    expect(modeAvailable('payment', '2.1')).toBe(true);
    expect(modeAvailable('qr', '1.6')).toBe(false);
    expect(modeAvailable('autocharge', '1.6')).toBe(true);
    // A stored 1.6 setup with a 2.1-only way of starting falls back to the default.
    expect(normalizeSetup({ ocpp: '1.6', mode: 'qr' }).mode).toBe(DEFAULT_SETUP.mode);
    expect(DEMO_CARS.every((car) => /^[0-9A-F]{12}$/.test(car.profile.evccid ?? ''))).toBe(true);
  });

  it('reads a stored setup, keeping what is valid and defaulting the rest', () => {
    expect(normalizeSetup(undefined)).toEqual(DEFAULT_SETUP);
    // The first Demo page stored a count of chargers and their ports.
    expect(normalizeSetup({ ocpp: '2.1', mode: 'app', chargers: 2, ports: 2, speed: 60 })).toEqual({
      ...DEFAULT_SETUP,
      ocpp: '2.1',
      mode: 'app',
      speed: 60,
    });
    expect(
      normalizeSetup({
        site: '  ',
        ocpp: '3.0',
        mode: 'magic',
        chargers: ['single', 'triple', 'dual', 'dual', 'dual', 'dual', 'dual', 'dual'],
        speed: 7,
        csmsUrl: 'ws://127.0.0.1:9300/ocpp',
      }),
    ).toEqual({
      ...DEFAULT_SETUP,
      chargers: ['single', 'dual', 'dual', 'dual', 'dual', 'dual'],
      csmsUrl: 'ws://127.0.0.1:9300/ocpp',
    });
    expect(MAX_CHARGERS).toBe(6);
    // No limit is kept as null; a missing capacity takes the default.
    expect(normalizeSetup({ capacityKW: null }).capacityKW).toBeNull();
    expect(normalizeSetup({ capacityKW: 11.5 }).capacityKW).toBe(11.5);
    expect(normalizeSetup({}).capacityKW).toBe(22);
  });

  it('adds up the site: power, energy since the build, charging and full cars', () => {
    const station = (ocpp: '1.6' | '2.0.1', connectors: ConnectorSnapshot[]) =>
      ({ id: 'X', ocpp, connectors }) as unknown as StationSnapshot;
    expect(
      siteTotals([
        station('1.6', [
          connector({
            plugged: true,
            status: 'Charging',
            transactionId: 1,
            powerW: 5000,
            energyWh: 1200,
            ev: ev(60),
          }),
          connector({
            connectorId: 2,
            plugged: true,
            status: 'SuspendedEV',
            transactionId: 2,
            energyWh: 3000,
            ev: ev(100),
          }),
        ]),
        station('2.0.1', [connector({ status: 'Available', energyWh: 800 })]),
      ]),
    ).toEqual({ powerW: 5000, energyWh: 5000, charging: 1, full: 1 });
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

  it('shows a session the station offers nothing to as waiting for power', () => {
    expect(
      bayView(
        connector({ plugged: true, status: 'SuspendedEVSE', transactionId: 4, ev: ev(60) }),
        '1.6',
      ).phase,
    ).toBe('waiting');
    expect(
      bayView(
        connector({
          plugged: true,
          status: 'Occupied',
          chargingState: 'SuspendedEVSE',
          transactionId: 't',
          ev: ev(60),
        }),
        '2.0.1',
      ).phase,
    ).toBe('waiting');
    // A full car the site gives nothing is still full.
    expect(
      bayView(
        connector({ plugged: true, status: 'SuspendedEVSE', transactionId: 4, ev: ev(100) }),
        '1.6',
      ).phase,
    ).toBe('full');
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

describe('the site power chart', () => {
  it('stacks the charge points from the oldest sample to the newest, under the top', () => {
    const samples = [
      { at: 0, byCharger: { A: 1000, B: 2000 } },
      { at: 1, byCharger: { A: 2000, B: 2000 } },
    ];
    expect(stackedAreas(samples, ['A', 'B'], 100, 40, 4000)).toEqual([
      { id: 'A', d: 'M0,30 L100,20 L100,40 L0,40 Z' },
      { id: 'B', d: 'M0,10 L100,0 L100,20 L0,30 Z' },
    ]);
    expect(stackedAreas(samples.slice(0, 1), ['A'], 100, 40, 4000)).toEqual([]);
  });
});
