import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createEngine, type Engine } from './engine.js';
import type { ApiEvent } from './api.js';
import { importText } from './logs/import.js';
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

describe('engine API: bulk stations', () => {
  it('creates stations from a template, all or none', async () => {
    const { api, csmsUrl } = await start();
    const template = { persona: 'generic-1.6', csmsUrl, tags: ['load'], group: 'ac' };
    const created = await api('POST', '/api/stations/bulk', {
      ...template,
      count: 5,
      id: 'LOAD-{001}',
      rampUp: { rate: 50 },
    });
    expect(created).toEqual({
      status: 201,
      body: { created: 5, ids: ['LOAD-001', 'LOAD-002', 'LOAD-003', 'LOAD-004', 'LOAD-005'] },
    });
    // Connected comes before the boot is answered and the connectors reported.
    await until(async () => {
      const list = await api('GET', '/api/stations?view=summary&state=connected');
      const stations = (list.body?.stations ?? []) as {
        registration: string;
        connectors: { status: string }[];
      }[];
      return (
        stations.length === 5 &&
        stations.every(
          (s) =>
            s.registration === 'Accepted' && s.connectors.every((c) => c.status === 'Available'),
        )
      );
    });
    const summary = await api('GET', '/api/stations?view=summary&tag=load');
    expect(summary.body?.stations[0]).toEqual({
      id: 'LOAD-001',
      persona: 'generic-1.6',
      ocpp: '1.6',
      group: 'ac',
      tags: ['load'],
      state: 'connected',
      registration: 'Accepted',
      connectors: [{ connectorId: 1, status: 'Available' }],
    });

    expect(
      await api('POST', '/api/stations/bulk', { ...template, count: 2, id: 'LOAD-{005}' }),
    ).toEqual({ status: 409, body: { error: 'station LOAD-005 already exists' } });
    for (const bad of [
      { ...template, count: 2, id: 'NO-COUNTER' },
      { ...template, count: 0, id: 'X-{1}' },
      { ...template, count: 2, id: 'X-{1}', persona: 'nope' },
      { ...template, count: 2, id: 'X-{1}', tags: ['two words'] },
      { ...template, count: 2, id: 'X-{1}', rampUp: { rate: -1 } },
    ]) {
      expect((await api('POST', '/api/stations/bulk', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await api('GET', '/api/stations')).body?.stations).toHaveLength(5);
  });

  it('acts on stations selected by ids, tag or group, and refuses an empty selection', async () => {
    const { api, csmsUrl } = await start();
    for (const [group, id] of [
      ['a', 'A-{1}'],
      ['b', 'B-{1}'],
    ] as const) {
      await api('POST', '/api/stations/bulk', {
        persona: 'generic-1.6',
        csmsUrl,
        count: 2,
        id,
        group,
        tags: ['load', group],
        rampUp: false,
      });
    }
    const states = async (query: string) =>
      (
        (await api('GET', `/api/stations?view=summary&${query}`)).body?.stations as {
          id: string;
          state: string;
        }[]
      ).map((s) => `${s.id}:${s.state}`);
    await until(async () => (await states('state=connected')).length === 4);

    expect(await api('POST', '/api/stations/bulk/stop', {})).toMatchObject({ status: 400 });
    expect(await api('POST', '/api/stations/bulk/stop', { group: 'a' })).toEqual({
      status: 200,
      body: { stations: 2, ids: ['A-1', 'A-2'] },
    });
    expect(await states('group=a')).toEqual(['A-1:stopped', 'A-2:stopped']);
    expect(await states('state=stopped')).toEqual(['A-1:stopped', 'A-2:stopped']);

    await api('POST', '/api/stations/bulk/offline', { ids: ['B-1'] });
    expect(await states('tag=b')).toEqual(['B-1:offline', 'B-2:connected']);
    await api('POST', '/api/stations/bulk/online', { tag: 'b' });
    await api('POST', '/api/stations/bulk/start', { tag: 'load', rampUp: { rate: 100 } });
    await until(async () => (await states('state=connected')).length === 4);
    expect((await api('POST', '/api/stations/bulk/explode', { all: true })).status).toBe(404);

    expect(await api('DELETE', '/api/stations/bulk', { tag: 'a' })).toEqual({
      status: 200,
      body: { deleted: 2 },
    });
    expect(await states('tag=load')).toEqual(['B-1:connected', 'B-2:connected']);
    expect(await api('DELETE', '/api/stations/bulk', { all: true })).toMatchObject({
      body: { deleted: 2 },
    });
    expect((await api('GET', '/api/stations')).body?.stations).toEqual([]);
  });

  it('creates and removes 1,000 stations with one call each', { timeout: 30_000 }, async () => {
    const { api, csmsUrl } = await start();
    const created = await api('POST', '/api/stations/bulk', {
      persona: 'generic-1.6',
      csmsUrl,
      count: 1000,
      id: 'K-{0001}',
      start: false,
    });
    expect(created.body?.created).toBe(1000);
    expect(
      (await api('GET', '/api/stations?view=summary&state=stopped')).body?.stations,
    ).toHaveLength(1000);
    expect((await api('DELETE', '/api/stations/bulk', { all: true })).body).toEqual({
      deleted: 1000,
    });
  });
});

describe('engine API: usage model', () => {
  it('creates stations with a usage model and switches it', async () => {
    const { api, csmsUrl } = await start();
    const usage = { sessionsPerHour: 1, stay: { min: '10m', max: '20m' } };
    const created = await api('POST', '/api/stations', {
      id: 'USE-1',
      persona: 'generic-1.6',
      csmsUrl,
      usage,
      seed: 9,
    });
    expect(created.body).toMatchObject({ usage: true });
    expect(
      (await api('PATCH', '/api/stations/USE-1/usage', { enabled: false })).body,
    ).toMatchObject({
      usage: false,
    });
    expect((await api('PATCH', '/api/stations/USE-1/usage', { enabled: 'yes' })).status).toBe(400);
    await api('POST', '/api/stations', { id: 'PLAIN', persona: 'generic-1.6', csmsUrl });
    expect((await api('PATCH', '/api/stations/PLAIN/usage', { enabled: true })).status).toBe(409);
    for (const bad of [
      { usage: { sessionsPerHour: 'often' } },
      { usage, seed: -1 },
      { usage: true },
    ]) {
      const res = await api('POST', '/api/stations', {
        id: 'BAD',
        persona: 'generic-1.6',
        csmsUrl,
        ...bad,
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('engine API: log export', () => {
  it("exports a station's frames as a JSONL log that imports back unchanged", async () => {
    const { url, api, csmsUrl } = await start();
    await addStation(api, csmsUrl);
    const res = await fetch(`${url}/api/stations/SIM-1/messages?format=jsonl`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/x-ndjson/);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="SIM-1.jsonl"');
    const text = await res.text();
    const imported = importText(text, undefined);
    expect(imported.problems).toEqual([]);
    expect(JSON.parse(text.split('\n')[0] ?? '')).toEqual({
      format: 'ocpp-mimic-log',
      version: 1,
      masked: false,
      source: 'export',
    });
    const frames = (await api('GET', '/api/stations/SIM-1/messages?kind=frame')).body?.entries as {
      text: string;
      direction: string;
    }[];
    expect(imported.lines.map((l) => [l.direction, JSON.stringify(l.frame)])).toEqual(
      frames.map((f) => [f.direction, f.text]),
    );
    expect(imported.lines[0]?.frame?.[2]).toBe('BootNotification');
    expect((await api('GET', '/api/stations/SIM-1/messages?format=xml')).status).toBe(400);
  });
});

describe('engine metrics', () => {
  it('serves Prometheus text at /metrics and a summary at /api/metrics', async () => {
    const { url, api, csmsUrl } = await start();
    await api('POST', '/api/stations/bulk', {
      persona: 'generic-1.6',
      csmsUrl,
      count: 2,
      id: 'M-{1}',
      group: 'm',
      rampUp: false,
    });
    // Connected comes before the boots are answered and the connectors reported.
    await until(async () => {
      const body = (await api('GET', '/api/metrics')).body;
      return (
        body?.stations.connected === 2 &&
        body.connectors.Available === 2 &&
        body.csmsLatency.byAction.BootNotification?.count === 2
      );
    });
    const summary = (await api('GET', '/api/metrics')).body;
    expect(summary).toMatchObject({
      stations: { connected: 2 },
      connectors: { Available: 2 },
      connections: { opened: 2, failed: 0 },
      callErrors: { sent: 0, received: 0 },
      schemaViolations: 0,
    });
    expect(summary?.csmsLatency.byAction.BootNotification.count).toBe(2);

    const res = await fetch(`${url}/metrics`);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
    const text = await res.text();
    expect(text).toContain(
      'ocpp_mimic_stations{state="connected",persona="generic-1.6",group="m"} 2',
    );
    expect(text).toMatch(
      /ocpp_mimic_csms_response_seconds_count\{action="BootNotification",persona="generic-1.6",group="m"\} 2/,
    );
    expect(text).toMatch(/^ocpp_mimic_work_lateness_seconds_count [0-9]+$/m);
  });
});

describe('engine API', () => {
  it('reports health and lists personas', async () => {
    const { api } = await start();
    expect((await api('GET', '/api/health')).body).toMatchObject({
      status: 'ok',
      ocpp: ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'],
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

  it('pushes fleet summaries to everyone, and records and snapshots to subscribers', async () => {
    const { url, api, csmsUrl } = await start();
    await addStation(api, csmsUrl, 'SIM-0');
    const connect = async () => {
      const events: ApiEvent[] = [];
      const socket = new WebSocket(`${url.replace('http', 'ws')}/api/events`);
      sockets.push(socket);
      socket.on('message', (data) => events.push(JSON.parse(data.toString()) as ApiEvent));
      await new Promise((resolve) => socket.once('open', resolve));
      return { socket, events };
    };
    const watcher = await connect();
    const other = await connect();
    await until(() => watcher.events.length > 0);
    expect(watcher.events[0]).toMatchObject({
      type: 'fleet',
      full: true,
      removed: [],
      stations: [{ id: 'SIM-0', state: 'connected', registration: 'Accepted' }],
    });
    watcher.socket.send(JSON.stringify({ type: 'subscribe', stations: ['SIM-1'] }));
    await sleep(50);

    await addStation(api, csmsUrl, 'SIM-1');
    await until(() =>
      watcher.events.some(
        (e) =>
          e.type === 'record' && e.entry.kind === 'frame' && e.entry.action === 'BootNotification',
      ),
    );
    await until(() =>
      watcher.events.some((e) => e.type === 'station' && e.station.registration === 'Accepted'),
    );
    await until(() =>
      other.events.some(
        (e) =>
          e.type === 'fleet' &&
          e.stations.some((s) => s.id === 'SIM-1' && s.registration === 'Accepted'),
      ),
    );
    // The other client never subscribed: no records, no full snapshots.
    expect(other.events.filter((e) => e.type !== 'fleet')).toEqual([]);

    await api('DELETE', '/api/stations/SIM-0');
    await until(() => other.events.some((e) => e.type === 'fleet' && e.removed.includes('SIM-0')));
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

describe('engine API: OCPP 2.0.1 stations', () => {
  it('shows the version, presents typed IdTokens and serves the Device Model', async () => {
    const { api, csmsUrl } = await start();
    const personas = await api('GET', '/api/personas');
    expect(
      (personas.body?.personas as { id: string; ocpp: string; features?: string[] }[]).find(
        (p) => p.id === 'generic-2.0.1',
      ),
    ).toMatchObject({ ocpp: '2.0.1', features: expect.arrayContaining(['Core', 'SmartCharging']) });
    expect((await api('GET', '/api/health')).body?.ocpp).toEqual([
      'ocpp1.6',
      'ocpp2.0.1',
      'ocpp2.1',
    ]);

    expect(
      (await api('POST', '/api/stations', { id: 'SIM-201', persona: 'generic-2.0.1', csmsUrl }))
        .status,
    ).toBe(201);
    await until(
      async () => (await api('GET', '/api/stations/SIM-201')).body?.registration === 'Accepted',
    );
    const summary = await api('GET', '/api/stations?view=summary');
    expect(summary.body?.stations[0]).toMatchObject({ id: 'SIM-201', ocpp: '2.0.1' });

    const card = await api('POST', '/api/stations/SIM-201/connectors/1/id-tag', {
      idTag: 'TAG-1',
      type: 'KeyCode',
    });
    expect(card.body?.result).toBe('authorized');
    expect(
      (await api('POST', '/api/stations/SIM-201/connectors/1/id-tag', { idTag: 'X', type: 'Nope' }))
        .status,
    ).toBe(400);

    const model = await api('GET', '/api/stations/SIM-201/device-model');
    const variables = model.body?.variables as {
      component: string;
      variable: string;
      attributes: { type: string; mutability: string; value?: string }[];
    }[];
    expect(variables.find((v) => v.variable === 'HeartbeatInterval')).toMatchObject({
      component: 'OCPPCommCtrlr',
      dataType: 'integer',
      unit: 's',
      attributes: [{ type: 'Actual', mutability: 'ReadWrite', value: expect.any(String) }],
    });
    // A write-only value never leaves the station.
    expect(variables.find((v) => v.variable === 'BasicAuthPassword')?.attributes).toEqual([
      { type: 'Actual', mutability: 'WriteOnly' },
    ]);

    // Set as a local operator, with the SetVariables checks.
    expect(
      (
        await api('PATCH', '/api/stations/SIM-201/device-model', {
          component: 'OCPPCommCtrlr',
          variable: 'HeartbeatInterval',
          value: '120',
        })
      ).body,
    ).toEqual({ status: 'Accepted' });
    expect(
      (await api('GET', '/api/stations/SIM-201')).body?.config['OCPPCommCtrlr/HeartbeatInterval'],
    ).toBe('120');
    expect(
      (
        await api('PATCH', '/api/stations/SIM-201/device-model', {
          component: 'SecurityCtrlr',
          variable: 'SecurityProfile',
          value: '3',
        })
      ).body,
    ).toMatchObject({ status: 'Rejected' });

    await addStation(api, csmsUrl, 'SIM-16');
    expect((await api('GET', '/api/stations/SIM-16/device-model')).status).toBe(404);
  });
});
