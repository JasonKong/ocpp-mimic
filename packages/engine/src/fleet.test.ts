import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
