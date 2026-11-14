import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createEngine, type Engine } from './engine.js';
import type { ApiEvent } from './api.js';
import { startBuiltinCsms, type BuiltinCsms } from './csms/builtin-csms.js';

let engine: Engine | undefined;
let csms: BuiltinCsms | undefined;
const dirs: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await engine?.stop();
  engine = undefined;
  await csms?.stop();
  csms = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}

async function start(options: Parameters<typeof createEngine>[0] = {}) {
  csms = await startBuiltinCsms();
  engine = createEngine({
    port: 0,
    backoff: { initialDelayMs: 20, maxDelayMs: 100, jitter: 0 },
    ...options,
  });
  const { url } = await engine.start();
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      ...(body !== undefined && {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    });
    const text = await res.text();
    return {
      status: res.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON keeps the assertions short
      body: text === '' ? undefined : (JSON.parse(text) as Record<string, any>),
    };
  };
  return { url, api, csmsUrl: csms.url };
}

async function addStation(
  api: Awaited<ReturnType<typeof start>>['api'],
  csmsUrl: string,
  id = 'SIM-1',
) {
  const created = await api('POST', '/api/stations', { id, persona: 'generic-1.6', csmsUrl });
  expect(created.status).toBe(201);
  await until(
    async () => (await api('GET', `/api/stations/${id}`)).body?.registration === 'Accepted',
  );
}

describe('engine API', () => {
  it('reports health and lists personas', async () => {
    const { api } = await start();
    expect((await api('GET', '/api/health')).body).toMatchObject({
      status: 'ok',
      ocpp: ['ocpp1.6'],
    });
    const personas = await api('GET', '/api/personas');
    expect(personas.body?.personas).toContainEqual(
      expect.objectContaining({ id: 'generic-1.6', connectors: 1, faults: expect.any(Array) }),
    );
  });

  it('creates, lists, fetches and deletes stations, with clear errors', async () => {
    const { api, csmsUrl } = await start();
    await addStation(api, csmsUrl);
    expect((await api('GET', '/api/stations')).body?.stations).toHaveLength(1);
    expect(
      (await api('POST', '/api/stations', { id: 'SIM-1', persona: 'generic-1.6', csmsUrl })).status,
    ).toBe(409);
    expect(
      (await api('POST', '/api/stations', { id: 'X', persona: 'nope', csmsUrl })).body,
    ).toEqual({
      error: 'unknown persona nope',
    });
    expect((await api('POST', '/api/stations', { persona: 'generic-1.6' })).status).toBe(400);
    for (const security of [{ profile: 4 }, { profile: 1, pin: '1234' }, 'profile 2']) {
      expect(
        (await api('POST', '/api/stations', { id: 'S', persona: 'generic-1.6', csmsUrl, security }))
          .status,
      ).toBe(400);
    }
    expect((await api('GET', '/api/stations/NOPE')).status).toBe(404);
    expect((await api('DELETE', '/api/stations/SIM-1')).status).toBe(204);
    expect((await api('GET', '/api/stations')).body?.stations).toEqual([]);
  });

  it('runs a full remote start / stop: cable in over the API, start and stop from the CSMS', async () => {
    const { api, csmsUrl } = await start();
    await addStation(api, csmsUrl);
    const connection = await csms!.waitForConnection('SIM-1');

    expect((await api('POST', '/api/stations/SIM-1/connectors/1/plug')).status).toBe(200);
    expect(
      (await connection.call('RemoteStartTransaction', { idTag: 'REMOTE', connectorId: 1 })).type,
    ).toBe(3);
    await connection.waitForCall('StartTransaction', 3000);
    await until(
      async () =>
        (await api('GET', '/api/stations/SIM-1')).body?.connectors[0].status === 'Charging',
    );

    const transactionId = (await api('GET', '/api/stations/SIM-1')).body?.connectors[0]
      .transactionId;
    await connection.call('RemoteStopTransaction', { transactionId });
    await connection.waitForCall('StopTransaction', 3000);
    // The CSMS's answer reaches the charge point a moment after the call reaches the CSMS.
    await until(
      async () =>
        (await api('GET', '/api/stations/SIM-1/messages?action=StopTransaction')).body?.entries
          .length === 2,
    );

    const messages = await api('GET', '/api/stations/SIM-1/messages?kind=frame');
    const actions = (
      messages.body?.entries as Array<{ action?: string; direction: string; messageType: number }>
    )
      .filter(
        (e) =>
          e.action !== 'StatusNotification' &&
          e.action !== 'Heartbeat' &&
          e.action !== 'SecurityEventNotification',
      )
      .map((e) => `${e.direction}:${e.messageType}:${e.action}`);
    expect(actions).toEqual([
      'cp-to-csms:2:BootNotification',
      'csms-to-cp:3:BootNotification',
      'csms-to-cp:2:RemoteStartTransaction',
      'cp-to-csms:3:RemoteStartTransaction',
      'cp-to-csms:2:StartTransaction',
      'csms-to-cp:3:StartTransaction',
      'csms-to-cp:2:RemoteStopTransaction',
      'cp-to-csms:3:RemoteStopTransaction',
      'cp-to-csms:2:StopTransaction',
      'csms-to-cp:3:StopTransaction',
    ]);
    // Every frame of the session passes OCA's official schemas too.
    expect(
      (messages.body?.entries as Array<{ schemaErrors?: string[] }>).filter((e) => e.schemaErrors),
    ).toEqual([]);
    // StartupOfTheDevice reached the CSMS as a security event; one raised over the API too.
    expect((await connection.waitForCall('SecurityEventNotification')).payload).toMatchObject({
      type: 'StartupOfTheDevice',
    });
    expect(
      (
        await api('POST', '/api/stations/SIM-1/security-events', {
          type: 'TamperDetectionActivated',
          techInfo: 'door open',
        })
      ).body?.securityEvents.at(-1),
    ).toMatchObject({ type: 'TamperDetectionActivated', techInfo: 'door open' });
    expect((await connection.waitForCall('SecurityEventNotification')).payload).toMatchObject({
      type: 'TamperDetectionActivated',
      techInfo: 'door open',
    });
    expect((await api('POST', '/api/stations/SIM-1/security-events', {})).status).toBe(400);
    const stops = await api('GET', '/api/stations/SIM-1/messages?action=StopTransaction&limit=1');
    expect(stops.body?.entries).toMatchObject([{ action: 'StopTransaction', messageType: 3 }]);
  });

  it('adds, lists and clears fault injections, and marks injected frames in the log', async () => {
    const { api, csmsUrl } = await start();
    await addStation(api, csmsUrl);
    const connection = await csms!.waitForConnection('SIM-1');
    const added = await api('POST', '/api/stations/SIM-1/injections', {
      type: 'callError',
      action: 'ClearCache',
      errorCode: 'NotSupported',
      for: '1m',
    });
    expect(added.body?.injections).toMatchObject([
      { injection: { type: 'callError', errorCode: 'NotSupported', action: 'ClearCache' } },
    ]);
    expect((await connection.call('ClearCache', {})).type).toBe(4);
    const log = await api('GET', '/api/stations/SIM-1/messages?action=ClearCache');
    expect(log.body?.entries).toMatchObject([
      { direction: 'csms-to-cp', injected: 'callError', dropped: true },
      { direction: 'cp-to-csms', messageType: 4, injected: 'callError' },
    ]);
    expect((await api('GET', '/api/stations/SIM-1/injections')).body?.injections).toHaveLength(1);
    expect((await api('DELETE', '/api/stations/SIM-1/injections')).body?.injections).toEqual([]);
    expect((await connection.call('ClearCache', {})).type).toBe(3);
    expect((await api('POST', '/api/stations/SIM-1/injections', { type: 'meltdown' })).status).toBe(
      400,
    );
  });

  it('presents cards, raises and clears faults, and takes a station offline and back', async () => {
    const { api, csmsUrl } = await start();
    await addStation(api, csmsUrl);
    const connection = await csms!.waitForConnection('SIM-1');

    const card = await api('POST', '/api/stations/SIM-1/connectors/1/id-tag', { idTag: 'TAG' });
    expect(card.body?.result).toBe('authorized');
    await api('POST', '/api/stations/SIM-1/connectors/1/plug');
    await connection.waitForCall('StartTransaction', 3000);

    await api('POST', '/api/stations/SIM-1/connectors/1/fault', {
      errorCode: 'GroundFailure',
      info: 'GND',
    });
    await until(() =>
      connection.received.some(
        (f) => f.type === 2 && f.action === 'StatusNotification' && f.payload.status === 'Faulted',
      ),
    );
    await connection.waitForCall('StopTransaction', 3000);
    expect((await api('DELETE', '/api/stations/SIM-1/connectors/1/fault')).status).toBe(200);
    expect((await api('POST', '/api/stations/SIM-1/connectors/9/plug')).status).toBe(404);
    expect(
      (await api('POST', '/api/stations/SIM-1/connectors/1/fault', { errorCode: 'NoError' }))
        .status,
    ).toBe(400);

    expect(
      (await api('POST', '/api/stations/SIM-1/offline', { mode: 'half-open' })).body?.transport,
    ).toBe('half-open');
    expect((await api('POST', '/api/stations/SIM-1/offline', { mode: 'sideways' })).status).toBe(
      400,
    );
    await api('POST', '/api/stations/SIM-1/online');
    await csms!.waitForConnection('SIM-1', 3000, connection);
  });

  it('sets the energy multiplier at creation and at run time', async () => {
    const { api, csmsUrl } = await start();
    const created = await api('POST', '/api/stations', {
      id: 'SIM-X',
      persona: 'generic-1.6',
      csmsUrl,
      energyMultiplier: 60,
    });
    expect(created.body?.energyMultiplier).toBe(60);
    const changed = await api('PATCH', '/api/stations/SIM-X/energy-multiplier', {
      energyMultiplier: 10,
    });
    expect(changed.body?.energyMultiplier).toBe(10);
    for (const bad of [0, -1, '5', null]) {
      expect(
        (await api('PATCH', '/api/stations/SIM-X/energy-multiplier', { energyMultiplier: bad }))
          .status,
      ).toBe(400);
    }
    expect(
      (
        await api('POST', '/api/stations', {
          id: 'SIM-Y',
          persona: 'generic-1.6',
          csmsUrl,
          energyMultiplier: 0,
        })
      ).status,
    ).toBe(400);
  });

  it('plugs in with an EV from the persona or an inline profile', async () => {
    const { api, csmsUrl } = await start();
    await addStation(api, csmsUrl);
    const personas = await api('GET', '/api/personas');
    expect(Object.keys(personas.body?.personas[0].evs)).toEqual([
      'compact-40kwh',
      'sedan-75kwh',
      'test-5kwh',
    ]);

    expect(
      (await api('POST', '/api/stations/SIM-1/connectors/1/plug', { ev: 'nope' })).status,
    ).toBe(400);
    expect(
      (await api('POST', '/api/stations/SIM-1/connectors/1/plug', { ev: { capacityKWh: 0 } }))
        .status,
    ).toBe(400);
    const named = await api('POST', '/api/stations/SIM-1/connectors/1/plug', {
      ev: 'compact-40kwh',
    });
    expect(named.body?.connectors[0].ev).toMatchObject({ name: 'compact-40kwh', soc: 20 });
    await api('POST', '/api/stations/SIM-1/connectors/1/unplug');

    // A 5 Wh battery is full within a few seconds of real time.
    const tiny = { capacityKWh: 0.005, initialSoc: 0, maxPowerW: 7400, phases: 1 };
    await api('POST', '/api/stations/SIM-1/connectors/1/id-tag', { idTag: 'TAG' });
    await api('POST', '/api/stations/SIM-1/connectors/1/plug', { ev: tiny });
    await until(
      async () =>
        (await api('GET', '/api/stations/SIM-1')).body?.connectors[0].status === 'SuspendedEV',
      8000,
    );
    expect((await api('GET', '/api/stations/SIM-1')).body?.connectors[0]).toMatchObject({
      powerW: 0,
      ev: { soc: 100 },
    });
  });

  it('flags frames that break the official OCA schema', async () => {
    const { api, csmsUrl } = await start();
    await addStation(api, csmsUrl);
    const connection = await csms!.waitForConnection('SIM-1');

    const answer = await connection.call('RemoteStartTransaction', { idTag: 'REMOTE', bogus: 1 });
    expect(answer.type).toBe(4);
    const calls = await api('GET', '/api/stations/SIM-1/messages?action=RemoteStartTransaction');
    expect(calls.body?.entries).toMatchObject([
      { messageType: 2, schemaErrors: ['$: must NOT have additional properties (bogus)'] },
      { messageType: 4 },
    ]);
    expect(calls.body?.entries[1].schemaErrors).toBeUndefined();
  });

  it('flips test switches and refuses to unplug a locked cable', async () => {
    const { api, csmsUrl } = await start();
    await addStation(api, csmsUrl);
    const connection = await csms!.waitForConnection('SIM-1');

    const patched = await api('PATCH', '/api/stations/SIM-1/behaviour', { cableLock: true });
    expect(patched.status).toBe(200);
    expect(patched.body?.behaviour).toEqual({ refuseRemoteStart: false, cableLock: true });
    expect((await api('PATCH', '/api/stations/SIM-1/behaviour', { lock: true })).status).toBe(400);
    expect((await api('PATCH', '/api/stations/SIM-1/behaviour', { cableLock: 'yes' })).status).toBe(
      400,
    );

    await api('POST', '/api/stations/SIM-1/connectors/1/id-tag', { idTag: 'TAG' });
    await api('POST', '/api/stations/SIM-1/connectors/1/plug');
    await connection.waitForCall('StartTransaction', 3000);
    await until(
      async () => (await api('GET', '/api/stations/SIM-1')).body?.connectors[0].locked === true,
    );
    const refused = await api('POST', '/api/stations/SIM-1/connectors/1/unplug');
    expect(refused.status).toBe(409);
    expect(refused.body?.error).toMatch(/locked/);

    await api('PATCH', '/api/stations/SIM-1/behaviour', { refuseRemoteStart: true });
    expect(
      await connection.call('RemoteStartTransaction', { idTag: 'REMOTE', connectorId: 1 }),
    ).toMatchObject({ type: 3, payload: { status: 'Rejected' } });
  });

  it('pushes frames and station updates over the /api/events WebSocket', async () => {
    const { url, api, csmsUrl } = await start();
    const events: ApiEvent[] = [];
    const socket = new WebSocket(`${url.replace('http', 'ws')}/api/events`);
    sockets.push(socket);
    socket.on('message', (data) => events.push(JSON.parse(data.toString()) as ApiEvent));
    await new Promise((resolve) => socket.once('open', resolve));

    await addStation(api, csmsUrl);
    await until(() =>
      events.some(
        (e) =>
          e.type === 'record' && e.entry.kind === 'frame' && e.entry.action === 'BootNotification',
      ),
    );
    await until(() =>
      events.some((e) => e.type === 'station' && e.station.registration === 'Accepted'),
    );
  });

  it('rejects bad requests', async () => {
    const { url, api } = await start();
    const bad = await fetch(`${url}/api/stations`, { method: 'POST', body: '{nope' });
    expect(bad.status).toBe(400);
    expect((await api('PUT', '/api/stations')).status).toBe(405);
    expect((await api('GET', '/api/unknown')).status).toBe(404);
  });

  it('serves the Web UI from webRoot, with index.html for client routes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-web-'));
    dirs.push(dir);
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>ocpp-mimic</title>');
    await writeFile(join(dir, 'app.js'), 'console.log(1)');
    const { url } = await start({ webRoot: dir });
    const index = await fetch(`${url}/`);
    expect(index.headers.get('content-type')).toMatch(/text\/html/);
    expect(await (await fetch(`${url}/app.js`)).text()).toBe('console.log(1)');
    expect(await (await fetch(`${url}/stations/SIM-1`)).text()).toMatch(/<title>ocpp-mimic/);
    expect((await fetch(`${url}/../../etc/passwd`)).status).not.toBe(500);
  });
});
