import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createFleet, isAllowedCsms, type Fleet } from './fleet.js';
import { loadPersonas } from './personas.js';
import { openStateStore, type StateStore } from './state-store.js';
import { startBuiltinCsms, type BuiltinCsms } from './csms/builtin-csms.js';

let csms: BuiltinCsms | undefined;
const fleets: Fleet[] = [];
const stores: StateStore[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const fleet of fleets.splice(0)) await fleet.shutdown();
  for (const store of stores.splice(0)) store.close();
  await csms?.stop();
  csms = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const FAST = { initialDelayMs: 20, maxDelayMs: 100, factor: 2, jitter: 0 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}

async function fleetWith(store?: StateStore): Promise<Fleet> {
  const fleet = createFleet({
    personas: await loadPersonas(),
    backoff: FAST,
    ...(store !== undefined && { store }),
  });
  fleets.push(fleet);
  return fleet;
}

describe('isAllowedCsms', () => {
  it('matches allowed prefixes at a boundary only', () => {
    const allowed = ['ws://localhost', 'wss://csms.example.com/ocpp'];
    expect(isAllowedCsms('ws://localhost:9000/ocpp', allowed)).toBe(true);
    expect(isAllowedCsms('wss://csms.example.com/ocpp/v16', allowed)).toBe(true);
    expect(isAllowedCsms('ws://localhost.evil.com/ocpp', allowed)).toBe(false);
    expect(isAllowedCsms('wss://csms.example.com/ocppx', allowed)).toBe(false);
  });
});

describe('fleet', () => {
  it('runs a station from a persona against the CSMS', async () => {
    csms = await startBuiltinCsms();
    const fleet = await fleetWith();
    const station = fleet.add({ id: 'SIM-1', persona: 'generic-1.6', csmsUrl: csms.url });
    const connection = await csms.waitForConnection('SIM-1');
    const boot = await connection.waitForCall('BootNotification');
    expect(boot.payload).toMatchObject({
      chargePointVendor: 'ocpp-mimic',
      chargePointModel: 'Generic-AC',
    });
    await until(() => station.snapshot().registration === 'Accepted');
    expect(station.snapshot()).toMatchObject({
      id: 'SIM-1',
      persona: 'generic-1.6',
      running: true,
      transport: 'open',
    });
  });

  it('runs a 2.0.1 station from a 2.0.1 persona over the ocpp2.0.1 subprotocol', async () => {
    // A minimal 2.0.1 CSMS: it accepts only ocpp2.0.1 and answers every CALL.
    const server = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      handleProtocols: (protocols) => (protocols.has('ocpp2.0.1') ? 'ocpp2.0.1' : false),
    });
    const calls: { action: string; payload: unknown }[] = [];
    const logins: (string | undefined)[] = [];
    server.on('connection', (ws, request) => {
      logins.push(request.headers.authorization);
      ws.on('message', (data) => {
        const frame = JSON.parse(String(data)) as [number, string, string, unknown];
        if (frame[0] !== 2) return;
        calls.push({ action: frame[2], payload: frame[3] });
        const reply =
          frame[2] === 'BootNotification'
            ? { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 }
            : {};
        ws.send(JSON.stringify([3, frame[1], reply]));
      });
    });
    await once(server, 'listening');
    try {
      const fleet = await fleetWith();
      const csmsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(() =>
        fleet.add({ id: 'SIM-201-X', persona: 'generic-2.0.1', csmsUrl, config: { A: '1' } }),
      ).toThrow('config holds 1.6 configuration keys; a 2.0.1 station takes deviceModel');
      const station = fleet.add({ id: 'SIM-201', persona: 'generic-2.0.1', csmsUrl });
      await until(() => calls.some((c) => c.action === 'StatusNotification'));
      expect(calls[0]).toEqual({
        action: 'BootNotification',
        payload: {
          reason: 'PowerUp',
          chargingStation: {
            vendorName: 'ocpp-mimic',
            model: 'Generic-AC-2.0.1',
            firmwareVersion: '0.0.0',
          },
        },
      });
      expect(station.snapshot()).toMatchObject({
        ocpp: '2.0.1',
        registration: 'Accepted',
        connectors: [{ connectorId: 1, evseId: 1, status: 'Available' }],
      });
      // A password and Security Profile 1 are SecurityCtrlr variables; Basic Auth uses them.
      const secured = fleet.add({
        id: 'SIM-201-P',
        persona: 'generic-2.0.1',
        csmsUrl,
        password: 'secret-0123456789',
        security: { profile: 1 },
      });
      await until(() => secured.snapshot().registration === 'Accepted');
      expect(logins.at(-1)).toBe(
        `Basic ${Buffer.from('SIM-201-P:secret-0123456789').toString('base64')}`,
      );
      expect(secured.snapshot().config['SecurityCtrlr/SecurityProfile']).toBe('1');
      expect(secured.snapshot().config['SecurityCtrlr/BasicAuthPassword']).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('tells subscribers about frames and connection changes until they unsubscribe', async () => {
    csms = await startBuiltinCsms();
    const fleet = await fleetWith();
    const seen: string[] = [];
    const unsubscribe = fleet.subscribe((event) => {
      if (event.type === 'frame' && event.direction === 'cp-to-csms') seen.push('frame');
      if (event.type === 'transport' && event.event.type === 'state') seen.push(event.event.state);
    });
    const station = fleet.add({ id: 'SIM-1', persona: 'generic-1.6', csmsUrl: csms.url });
    await until(() => station.snapshot().registration === 'Accepted');
    expect(seen).toContain('open');
    expect(seen).toContain('frame');
    unsubscribe();
    const count = seen.length;
    fleet.reconnectStorm();
    await until(
      () =>
        station.snapshot().registration === 'Accepted' && station.snapshot().transport === 'open',
    );
    await sleep(50);
    expect(seen).toHaveLength(count);
  });

  it('adds many stations all or none, and starts them along the ramp-up', async () => {
    csms = await startBuiltinCsms();
    const dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-fleet-'));
    dirs.push(dir);
    const store = openStateStore(join(dir, 'state.db'));
    stores.push(store);
    const fleet = await fleetWith(store);
    const definition = (id: string, persona = 'generic-1.6') => ({
      id,
      persona,
      csmsUrl: csms!.url,
      tags: ['load'],
      group: 'g',
    });
    expect(() => fleet.addMany([definition('B-1'), definition('B-2', 'no-such-persona')])).toThrow(
      /unknown persona/,
    );
    expect(fleet.list()).toEqual([]);
    expect(store.listStations()).toEqual([]);
    expect(() => fleet.addMany([definition('B-1'), definition('B-1')])).toThrow(/twice/);

    const started = Date.now();
    const stations = fleet.addMany(
      ['B-1', 'B-2', 'B-3'].map((id) => definition(id)),
      { rampUp: { rate: 10, jitter: 0 } },
    );
    expect(stations.map((s) => s.snapshot().tags)).toEqual([['load'], ['load'], ['load']]);
    expect(store.listStations().map((d) => d.id)).toEqual(['B-1', 'B-2', 'B-3']);
    expect(stations.map((s) => s.running)).toEqual([true, false, false]);
    await until(() => stations.every((s) => s.snapshot().registration === 'Accepted'));
    // The third station's slot starts 200 ms in.
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);

    await fleet.stopMany(['B-1', 'B-2']);
    expect(stations.map((s) => s.running)).toEqual([false, false, true]);
    await fleet.removeMany(['B-1', 'B-2', 'B-3']);
    expect(fleet.list()).toEqual([]);
    expect(store.listStations()).toEqual([]);
  });

  it('keeps a station stopped when it is stopped before its ramp-up turn', async () => {
    csms = await startBuiltinCsms();
    const fleet = await fleetWith();
    const [first, second] = fleet.addMany(
      ['C-1', 'C-2'].map((id) => ({ id, persona: 'generic-1.6', csmsUrl: csms!.url })),
      { rampUp: { rate: 5, jitter: 0 } },
    );
    await fleet.stop('C-2');
    await sleep(300);
    expect(first?.running).toBe(true);
    expect(second?.running).toBe(false);
  });

  it('runs the usage model on a 2.0.1 station next to a 1.6 one', { timeout: 20_000 }, async () => {
    csms = await startBuiltinCsms();
    const fleet = await fleetWith();
    const usage = {
      sessionsPerHour: 3600,
      stay: { min: '1500ms', max: '2s' },
      steps: { min: '50ms', max: '100ms' },
      evs: { 'test-5kwh': 1 },
      idTags: { unknownShare: 0 },
      stopBy: { card: 1, unplug: 0 },
    };
    fleet.add({ id: 'MIX-16', persona: 'generic-1.6', csmsUrl: csms.url, usage, seed: 4 });
    const station = fleet.add({
      id: 'MIX-201',
      persona: 'generic-2.0.1',
      csmsUrl: csms.url,
      usage,
      seed: 4,
    });
    const connection = await csms.waitForConnection('MIX-201');
    expect(connection.ocpp).toBe('2.0.1');
    const started = await connection.waitForCall('TransactionEvent', 10_000);
    expect(started.payload).toMatchObject({
      eventType: 'Started',
      idToken: { idToken: expect.stringMatching(/^LOAD-\d{4}$/), type: 'ISO14443' },
    });
    // The card ends the session (stopBy card), and with it the transaction.
    for (;;) {
      const event = await connection.waitForCall('TransactionEvent', 10_000);
      if (event.payload.eventType !== 'Ended') continue;
      expect(event.payload).toMatchObject({
        triggerReason: 'StopAuthorized',
        transactionInfo: { stoppedReason: 'Local' },
      });
      break;
    }
    expect(station.snapshot().usage).toBe(true);
    const old = await csms.waitForConnection('MIX-16');
    expect(old.ocpp).toBe('1.6');
    await old.waitForCall('StartTransaction', 10_000);
  });

  it(
    'runs the usage model while a station runs, and switches it',
    { timeout: 20_000 },
    async () => {
      csms = await startBuiltinCsms();
      const fleet = await fleetWith();
      const usage = {
        sessionsPerHour: 3600,
        // Longer than generic-1.6's 500 ms start-transaction delay.
        stay: { min: '1500ms', max: '2s' },
        steps: { min: '50ms', max: '100ms' },
        evs: { 'test-5kwh': 1 },
        idTags: { unknownShare: 0 },
        stopBy: { card: 1, unplug: 0 },
      };
      const station = fleet.add({
        id: 'U-1',
        persona: 'generic-1.6',
        csmsUrl: csms.url,
        usage,
        seed: 4,
      });
      const connection = await csms.waitForConnection('U-1');
      const start = await connection.waitForCall('StartTransaction', 10_000);
      expect(start.payload.idTag).toMatch(/^LOAD-\d{4}$/);
      const stop = await connection.waitForCall('StopTransaction', 10_000);
      expect(stop.payload.reason).toBe('Local');
      expect(station.snapshot().usage).toBe(true);
      fleet.setUsage('U-1', false);
      expect(station.snapshot().usage).toBe(false);

      expect(() =>
        fleet.add({ id: 'U-2', persona: 'generic-1.6', csmsUrl: csms!.url, usage: true }),
      ).toThrow(/no usage model/);
      expect(() =>
        fleet.add({
          id: 'U-3',
          persona: 'generic-1.6',
          csmsUrl: csms!.url,
          usage: { sessionsPerHour: 1, evs: { nope: 1 } },
        }),
      ).toThrow(/no EV nope/);
      fleet.add({ id: 'U-4', persona: 'generic-1.6', csmsUrl: csms.url });
      expect(() => fleet.setUsage('U-4', true)).toThrow(/no usage model/);
      expect(fleet.get('U-4')?.snapshot().usage).toBeUndefined();
    },
  );

  it('halts a removed station, so a session it had stops metering', async () => {
    csms = await startBuiltinCsms();
    const fleet = await fleetWith();
    const station = fleet.add({
      id: 'HALT-1',
      persona: 'generic-1.6',
      csmsUrl: csms.url,
      config: { MeterValueSampleInterval: '1' },
    });
    await until(() => station.snapshot().registration === 'Accepted');
    station.chargePoint.plugIn(1);
    await station.chargePoint.presentIdTag(1, 'TAG');
    await until(() => station.snapshot().connectors[0]?.status === 'Charging');
    await fleet.remove('HALT-1');
    // Offline now: a running charge point would queue a MeterValues every second.
    const queued = station.chargePoint.snapshot().queuedMessages;
    await sleep(2500);
    expect(station.chargePoint.snapshot().queuedMessages).toBe(queued);
  });

  it('refuses CSMS addresses outside the allow-list, unknown personas and duplicate ids', async () => {
    const fleet = await fleetWith();
    expect(() =>
      fleet.add({ id: 'A', persona: 'generic-1.6', csmsUrl: 'wss://csms.example.com/ocpp' }),
    ).toThrow(/not allowed/);
    expect(() =>
      fleet.add({ id: 'A', persona: 'nope', csmsUrl: 'ws://localhost/ocpp' }, { start: false }),
    ).toThrow(/unknown persona/);
    fleet.add(
      { id: 'A', persona: 'generic-1.6', csmsUrl: 'ws://localhost/ocpp' },
      { start: false },
    );
    expect(() =>
      fleet.add(
        { id: 'A', persona: 'generic-1.6', csmsUrl: 'ws://localhost/ocpp' },
        { start: false },
      ),
    ).toThrow(/already exists/);
    expect(() =>
      fleet.add(
        {
          id: 'C',
          persona: 'generic-1.6',
          csmsUrl: 'wss://localhost/ocpp',
          security: { profile: 2, ca: '/nonexistent/ca.crt' },
        },
        { start: false },
      ),
    ).toThrow(/cannot read the CA certificate \/nonexistent\/ca\.crt/);
    expect(() =>
      fleet.add(
        {
          id: 'B',
          persona: 'generic-1.6',
          csmsUrl: 'ws://localhost/ocpp',
          config: { HeartbeatInterval: 'soon' },
        },
        { start: false },
      ),
    ).toThrow(/invalid value/);
  });

  it('resends StopTransaction when the network comes back', async () => {
    csms = await startBuiltinCsms();
    const fleet = await fleetWith();
    const station = fleet.add({ id: 'SIM-1', persona: 'generic-1.6', csmsUrl: csms.url });
    const first = await csms.waitForConnection('SIM-1');
    await until(() => station.snapshot().registration === 'Accepted');

    await station.chargePoint.presentIdTag(1, 'TAG');
    station.chargePoint.plugIn(1);
    await first.waitForCall('StartTransaction');
    // Charging starts at once; wait for the CSMS's answer before going offline.
    await until(() => station.snapshot().connectors[0]?.transactionId !== undefined);

    station.transport.goOffline('clean');
    station.chargePoint.unplug(1);
    await until(() => station.snapshot().queuedMessages === 1);

    station.transport.goOnline();
    const second = await csms.waitForConnection('SIM-1', 3000, first);
    const stop = await second.waitForCall('StopTransaction', 3000);
    expect(stop.payload).toMatchObject({ transactionId: 1, reason: 'EVDisconnected' });
  });

  it('keeps meter readings and ends running transactions with PowerLoss across an engine restart', async () => {
    csms = await startBuiltinCsms();
    const dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-fleet-'));
    dirs.push(dir);
    const path = join(dir, 'state.db');

    const store1 = openStateStore(path);
    const fleet1 = await fleetWith(store1);
    const station1 = fleet1.add({ id: 'SIM-1', persona: 'generic-1.6', csmsUrl: csms.url });
    const first = await csms.waitForConnection('SIM-1');
    await until(() => station1.snapshot().registration === 'Accepted');
    await station1.chargePoint.presentIdTag(1, 'TAG');
    station1.chargePoint.plugIn(1);
    await first.waitForCall('StartTransaction');
    await until(() => (station1.snapshot().connectors[0]?.energyWh ?? 0) > 0.5);
    await fleet1.shutdown();
    fleets.splice(fleets.indexOf(fleet1), 1);
    const energyBefore = store1.loadState('SIM-1')?.meters['1'] ?? 0;
    store1.close();

    const store2 = openStateStore(path);
    stores.push(store2);
    const fleet2 = await fleetWith(store2);
    const [station2] = await fleet2.restore();
    expect(station2?.id).toBe('SIM-1');
    expect(station2?.snapshot().connectors[0]?.energyWh).toBeCloseTo(energyBefore, 6);

    const second = await csms.waitForConnection('SIM-1', 3000, first);
    const stop = await second.waitForCall('StopTransaction', 3000);
    expect(stop.payload).toMatchObject({
      transactionId: 1,
      reason: 'PowerLoss',
      meterStop: Math.round(energyBefore),
    });
  });

  it('a power loss restarts the station from its saved state, keeping queued timestamps', async () => {
    csms = await startBuiltinCsms();
    const fleet = await fleetWith();
    const station = fleet.add({ id: 'SIM-PL', persona: 'generic-1.6', csmsUrl: csms.url });
    const first = await csms.waitForConnection('SIM-PL');
    await until(() => station.snapshot().registration === 'Accepted');
    await station.chargePoint.presentIdTag(1, 'TAG');
    station.chargePoint.plugIn(1);
    await first.waitForCall('StartTransaction');
    // Offline, a card stops the session: its StopTransaction waits in the queue.
    station.transport.goOffline('clean');
    await until(() => station.snapshot().transport === 'offline');
    await station.chargePoint.presentIdTag(1, 'TAG');
    await until(() => station.snapshot().queuedMessages > 0);
    const stoppedAt = Date.now();

    fleet.inject('SIM-PL', { injection: { type: 'powerLoss', offMs: 300, onMs: 0, times: 1 } });
    await until(() => fleet.get('SIM-PL')?.snapshot().running === false);
    const second = await csms.waitForConnection('SIM-PL', 5000, first);
    const stop = await second.waitForCall('StopTransaction', 5000);
    expect(stop.payload).toMatchObject({ reason: 'Local' });
    // Sent after the restart with the time it happened, not the time it was sent.
    expect(Date.parse(String(stop.payload.timestamp))).toBeLessThanOrEqual(stoppedAt + 50);
    const fresh = fleet.get('SIM-PL');
    expect(fresh).not.toBe(station);
    expect(fresh?.snapshot()).toMatchObject({ running: true });
    expect((await second.waitForCall('SecurityEventNotification', 3000)).payload).toMatchObject({
      type: 'StartupOfTheDevice',
    });
  });

  it('sets the meter register for meter faults', async () => {
    const fleet = await fleetWith();
    const station = fleet.add(
      { id: 'SIM-M', persona: 'generic-1.6', csmsUrl: 'ws://localhost:1/ocpp' },
      { start: false },
    );
    station.chargePoint.setMeterRegister(1, 5000);
    fleet.inject('SIM-M', { injection: { type: 'meterRollback', wh: 1200, connector: 1 } });
    expect(station.snapshot().connectors[0]?.energyWh).toBeCloseTo(3800, 3);
    fleet.inject('SIM-M', { injection: { type: 'meterReset', connector: 1 } });
    expect(station.snapshot().connectors[0]?.energyWh).toBe(0);
    expect(() =>
      fleet.inject('SIM-M', { injection: { type: 'meterRollback', wh: 1, connector: 9 } }),
    ).toThrow(/no connector 9/);
  });

  it('remove() stops the station and deletes it from the store', async () => {
    const store = openStateStore(':memory:');
    stores.push(store);
    const fleet = await fleetWith(store);
    fleet.add(
      { id: 'SIM-1', persona: 'generic-1.6', csmsUrl: 'ws://localhost:1/ocpp' },
      { start: false },
    );
    expect(store.listStations()).toHaveLength(1);
    await fleet.remove('SIM-1');
    expect(fleet.list()).toEqual([]);
    expect(store.listStations()).toEqual([]);
  });
});

describe('fleet shutdown', () => {
  it('writes nothing to the store after shutdown, even as connections close', async () => {
    csms = await startBuiltinCsms();
    const store = openStateStore(':memory:');
    const fleet = createFleet({ personas: await loadPersonas(), store, backoff: FAST });
    const station = fleet.add({ id: 'SIM-1', persona: 'generic-1.6', csmsUrl: csms.url });
    await until(() => station.snapshot().registration === 'Accepted');
    await fleet.shutdown();
    store.close();
    // A save scheduled by the disconnect would now throw "statement has been finalized".
    await sleep(150);
    expect(station.running).toBe(false);
  });
});
