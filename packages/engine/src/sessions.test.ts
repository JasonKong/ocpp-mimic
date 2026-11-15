import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ChargePointSnapshot, SessionHint } from '@ocpp-mimic/core';
import type { ApiEvent } from './api.js';
import { startBuiltinCsms, type BuiltinCsms } from './csms/builtin-csms.js';
import { createEngine, type Engine } from './engine.js';
import type { FrameRecord } from './recorder.js';
import { createSessionService } from './sessions.js';
import { openStateStore, type StateStore } from './state-store.js';

const T0 = Date.parse('2026-11-15T10:00:00Z');

/** A station whose snapshot shows an EV at 40 % on connector 1. */
const snapshot = (): ChargePointSnapshot =>
  ({
    ocpp: '1.6',
    connectors: [
      {
        connectorId: 1,
        status: 'Charging',
        errorCode: 'NoError',
        plugged: true,
        locked: true,
        energyWh: 1500,
        powerW: 7000,
        offeredW: 7400,
        ev: { soc: 40.5, profile: { capacityKWh: 60, initialSoc: 20, maxPowerW: 7400, phases: 1 } },
      },
    ],
  }) as unknown as ChargePointSnapshot;

/** Frames of a 1.6 remote start on connector 1, as the recorder would keep them. */
function frames(stationId: string, from = 0) {
  let seq = from;
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();
  const frame = (
    direction: FrameRecord['direction'],
    messageType: 2 | 3,
    uniqueId: string,
    action: string,
    payload: object,
  ): FrameRecord => ({
    kind: 'frame',
    seq: ++seq,
    stationId,
    at: at(seq),
    direction,
    messageType,
    uniqueId,
    action,
    payload,
    text: JSON.stringify(
      messageType === 2 ? [2, uniqueId, action, payload] : [3, uniqueId, payload],
    ),
  });
  return {
    remoteStart: (id: string, idTag = 'APP') => [
      frame('csms-to-cp', 2, `r${id}`, 'RemoteStartTransaction', { idTag, connectorId: 1 }),
      frame('cp-to-csms', 3, `r${id}`, 'RemoteStartTransaction', { status: 'Accepted' }),
    ],
    start: (id: string, idTag = 'APP') => [
      frame('cp-to-csms', 2, `s${id}`, 'StartTransaction', {
        connectorId: 1,
        idTag,
        meterStart: 1000,
        timestamp: at(seq + 1),
      }),
      frame('csms-to-cp', 3, `s${id}`, 'StartTransaction', {
        transactionId: Number(id),
        idTagInfo: { status: 'Accepted' },
      }),
    ],
    meter: (id: string, wh: number) => [
      frame('cp-to-csms', 2, `m${id}`, 'MeterValues', {
        connectorId: 1,
        transactionId: Number(id),
        meterValue: [
          {
            timestamp: at(seq + 1),
            sampledValue: [{ value: String(wh) }, { value: '41', measurand: 'SoC' }],
          },
        ],
      }),
    ],
    stop: (id: string) => [
      frame('cp-to-csms', 2, `x${id}`, 'StopTransaction', {
        transactionId: Number(id),
        meterStop: 2000,
        timestamp: at(seq + 1),
      }),
      frame('csms-to-cp', 3, `x${id}`, 'StopTransaction', {}),
    ],
  };
}

const remote: SessionHint = {
  kind: 'authorized',
  evseId: 1,
  idToken: { idToken: 'APP' },
  source: 'remote',
};

const stores: StateStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function memoryStore() {
  const store = openStateStore(':memory:');
  stores.push(store);
  store.saveStation({ id: 'CP-1', persona: 'generic-1.6', csmsUrl: 'ws://127.0.0.1:1/ocpp' });
  return store;
}

describe('session service', () => {
  it('tracks a session from frames and hints, with true samples, estimates and its frames', () => {
    const service = createSessionService({
      station: () => ({ ocpp: '1.6', snapshot }),
      now: () => T0,
    });
    const f = frames('CP-1');
    const seen: number[] = [];
    service.subscribe((summary) => seen.push(summary.n));
    for (const record of f.remoteStart('1')) service.frame(record);
    service.hint('CP-1', remote);
    for (const record of [...f.start('1'), ...f.meter('1', 1500)]) service.frame(record);
    const [summary] = service.list('CP-1');
    expect(summary).toMatchObject({
      n: 1,
      state: 'running',
      source: 'remote',
      evseId: 1,
      energyWh: 500,
      socPercent: 41,
    });
    const detail = service.get('CP-1', 1);
    expect(detail?.session.truth.at(-1)).toMatchObject({
      socPercent: 40.5,
      energyWh: 1500,
      powerW: 7000,
    });
    expect(detail?.truth?.msToTarget).toBeGreaterThan(0);
    expect(detail?.estimate).toMatchObject({ socPercent: 41, reason: 'SoC has not risen enough' });
    expect(service.frames('CP-1', 1).map((r) => r.action)).toEqual([
      'RemoteStartTransaction',
      'RemoteStartTransaction',
      'StartTransaction',
      'StartTransaction',
      'MeterValues',
    ]);
    expect(seen.length).toBeGreaterThan(0);
    service.stop();
  });

  it('keeps sessions in the store across a restart: running ones go on, starting ones did not start', () => {
    const store = memoryStore();
    const station = () => ({ ocpp: '1.6' as const, snapshot });
    const first = createSessionService({ store, station, now: () => T0 });
    const f = frames('CP-1');
    for (const record of [...f.remoteStart('1'), ...f.start('1')]) first.frame(record);
    first.hint('CP-1', remote);
    // A second remote start that is still waiting for its cable.
    for (const record of f.remoteStart('2', 'LATER')) first.frame(record);
    first.stop();

    const second = createSessionService({ store, station, now: () => T0 + 60_000 });
    const g = frames('CP-1', 100);
    // The first frame after the restart loads the station's sessions.
    for (const record of [...g.meter('1', 1800), ...g.stop('1')]) second.frame(record);
    expect(second.list('CP-1').map((s) => `${s.n}:${s.state}:${s.failure?.reason ?? ''}`)).toEqual([
      '2:not-started:StartFailed',
      '1:finished:',
    ]);
    // Frames from before and after the restart stay with the session.
    expect(second.frames('CP-1', 1).map((r) => r.action)).toEqual([
      'RemoteStartTransaction',
      'RemoteStartTransaction',
      'StartTransaction',
      'StartTransaction',
      'MeterValues',
      'StopTransaction',
      'StopTransaction',
    ]);
    second.stop();
  });

  it('keeps the newest sessions per station, and open ones', () => {
    const store = memoryStore();
    const service = createSessionService({
      store,
      perStation: 2,
      station: () => ({ ocpp: '1.6', snapshot }),
    });
    for (let i = 1; i <= 4; i++) {
      const f = frames('CP-1', i * 100);
      for (const record of [...f.start(String(i)), ...f.stop(String(i))]) service.frame(record);
    }
    expect(service.list('CP-1').map((s) => s.n)).toEqual([4, 3]);
    expect(store.sessionFrames('CP-1', 1)).toEqual([]);
    service.forget('CP-1');
    service.stop();
  });
});

describe('engine sessions', () => {
  let engine: Engine | undefined;
  let csms: BuiltinCsms | undefined;
  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
    await csms?.stop();
    csms = undefined;
  });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await sleep(20);
    }
  }

  it('records remote starts of 1.6 and 2.0.1 stations and serves them over the API and events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-sessions-'));
    dirs.push(dir);
    csms = await startBuiltinCsms();
    engine = createEngine({
      port: 0,
      storePath: join(dir, 'state.db'),
      backoff: { initialDelayMs: 20, maxDelayMs: 100, jitter: 0 },
    });
    const { url } = await engine.start();
    const api = async (path: string) => {
      const res = await fetch(`${url}${path}`);
      const text = await res.text();
      const json = res.headers.get('content-type')?.startsWith('application/json') === true;
      return {
        status: res.status,
        text,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON keeps the assertions short
        body: json ? (JSON.parse(text) as Record<string, any>) : undefined,
      };
    };
    const events: ApiEvent[] = [];
    const socket = new WebSocket(`${url.replace('http', 'ws')}/api/events`);
    socket.on('message', (data: Buffer) => events.push(JSON.parse(data.toString()) as ApiEvent));
    await new Promise((resolve) => socket.once('open', resolve));
    socket.send(JSON.stringify({ type: 'subscribe', stations: ['S16', 'S201'] }));

    for (const [id, persona] of [
      ['S16', 'generic-1.6'],
      ['S201', 'generic-2.0.1'],
    ] as const) {
      const created = await fetch(`${url}/api/stations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, persona, csmsUrl: csms.url }),
      });
      expect(created.status).toBe(201);
      await until(async () => (await api(`/api/stations/${id}`)).body?.registration === 'Accepted');
    }
    const c16 = await csms.waitForConnection('S16');
    await c16.call('RemoteStartTransaction', { idTag: 'APP-USER', connectorId: 1 });
    const c201 = await csms.waitForConnection('S201');
    await c201.call('RequestStartTransaction', {
      remoteStartId: 42,
      evseId: 1,
      idToken: { idToken: 'APP-USER-2', type: 'Central' },
    });
    const plug = (id: string) =>
      fetch(`${url}/api/stations/${id}/connectors/1/plug`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    await plug('S16');
    await plug('S201');
    await until(
      async () =>
        (await api('/api/stations/S16/sessions')).body?.sessions?.[0]?.state === 'running',
    );
    await until(
      async () =>
        (await api('/api/stations/S201/sessions')).body?.sessions?.[0]?.state === 'running',
    );

    const s16 = (await api('/api/stations/S16/sessions/1')).body;
    expect(s16?.session).toMatchObject({
      source: 'remote',
      idToken: { idToken: 'APP-USER' },
      evseId: 1,
    });
    expect(s16?.session.timeline.map((s: { action: string }) => s.action).slice(0, 2)).toEqual([
      'RemoteStartTransaction',
      'RemoteStartTransaction',
    ]);
    const s201 = (await api('/api/stations/S201/sessions/1')).body;
    expect(s201?.session).toMatchObject({
      source: 'remote',
      remoteStartId: 42,
      idToken: { type: 'Central' },
    });

    const jsonl = await api('/api/stations/S16/sessions/1/frames?format=jsonl');
    expect(jsonl.status).toBe(200);
    expect(jsonl.text.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(4);
    expect((await api('/api/stations/S16/sessions/9')).status).toBe(404);
    expect((await api('/api/stations/S16/sessions/zero')).status).toBe(400);
    await until(() => events.some((e) => e.type === 'session' && e.session.stationId === 'S201'));
    socket.terminate();
  });
});
